'use strict';
// 第 2 层：世界树（长期知识，全部落在本机磁盘）
// 设计参考：
//   - Memory-Like-A-Tree：树自动生长，新知识发芽、常用知识茁壮、不用的自然凋零、落叶化作养分
//   - agent-memory-skill：人格/经验/事实三层，纯 Markdown、可 git
// 存储布局：
//   <dir>/tree.json                  索引（节点、分支、权重、落叶标记）
//   <dir>/nodes/<分支>/<id>.md       正文（人可读、可手改）
//   <dir>/nutrients/<yyyy-mm-dd>.md  "落叶"正文，可挖回，不删除
// 事件分支（记忆/事件）单独一套：带 sourceKey/createdAt，独立配额 maxEventNodes，
// 注入时只按 eventDays 时间窗口取，不和知识/技能/人设一起参与全局淘汰。
// 本模块只做文件 IO + 纯计算，不依赖桥接其余代码。

import fs from 'node:fs';
import path from 'node:path';

const ROOT_BRANCHES = ['人设', '技能', '知识', '事件', '教训'];
// 事件分支头：'记忆/事件' 存带时间戳的事件流（例如 QQ 里今天发生的事），与知识分支隔离。
const EVENT_BRANCH = '记忆/事件';
const EVENT_ROOT = '记忆';
const DAY_MS = 24 * 3600 * 1000;

function clampNum(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeTreeConfig(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  // 注入预算对外只暴露「字」（主人要求不要 token）；内部仍换算成 token 记账：中文约 0.7 token/字。
  const chars = Math.round(clampNum(t.budgetChars, 1200, 0, 4000));
  return {
    enabled: t.enabled !== false,
    budgetChars: chars,
    budgetTokens: Math.max(0, Math.ceil(chars * 0.7)),
    tauDays: clampNum(t.tauDays, 30, 1, 3650),
    fallWeight: clampNum(t.fallWeight, 0.05, 0.001, 0.5),
    fallDays: clampNum(t.fallDays, 90, 7, 3650),
    maxNodes: Math.round(clampNum(t.maxNodes, 800, 50, 5000)),
    // 事件分支自己的上限：事件再多也只淘汰事件，不占普通节点的配额。
    maxEventNodes: Math.round(clampNum(t.maxEventNodes, 2000, 100, 10000))
  };
}

function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return Math.max(1, Math.ceil(cjk * 0.7 + Math.max(0, s.length - cjk) / 4));
}

function computeKeywords(text, limit = 40) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9][a-z0-9_-]{2,}/g) || []) {
    out.add(w);
    if (out.size >= limit) break;
  }
  for (const run of s.match(/[\u3400-\u9fff]+/g) || []) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      out.add(run.slice(i, i + 2));
      if (out.size >= limit) break;
    }
    if (out.size >= limit) break;
  }
  return [...out];
}

function emptyTree() {
  return { version: 1, branches: ROOT_BRANCHES.slice(), nodes: {}, lastDecayAt: 0 };
}

function sanitizeBranch(branch) {
  const parts = String(branch || '')
    .split(/[\/\\>]+/)
    .map((p) => p.trim().replace(/[<>:"|?*\x00-\x1f]/g, ''))
    .filter(Boolean)
    .slice(0, 3);
  if (!parts.length) return '知识/其它';
  // '记忆' 是事件分支的根，不归到知识下面；单写 '记忆' 时补成 '记忆/事件'。
  if (!ROOT_BRANCHES.includes(parts[0]) && parts[0] !== EVENT_ROOT) parts.unshift('知识');
  if (parts.length === 1 && parts[0] === EVENT_ROOT) parts.push('事件');
  return parts.join('/');
}

// 事件分支判断：'记忆/事件' 及其子分支（'记忆/事件/xxx'）都算事件。
function isEventBranch(branch) {
  const b = String(branch || '');
  return b === EVENT_BRANCH || b.startsWith(`${EVENT_BRANCH}/`);
}

function isEventNode(node) {
  return isEventBranch(node?.branch);
}

function branchOf(node) {
  const b = String(node?.branch || '知识/其它');
  return b.includes('/') ? b.slice(0, b.lastIndexOf('/')) : b;
}

function newId(now = Date.now()) {
  return `n${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// 权重衰减：τ 与重要度成正比；pinned（人设）不衰减
function decayWeight(node, config, now) {
  if (!node || node.pinned) return Number(node?.weight ?? 1);
  const last = Number(node.lastAccessAt || node.createdAt || 0) || now;
  const access = Math.max(0, Number(node.accessCount) || 0);
  const tau = Math.max(DAY_MS, Number(config.tauDays ?? 30) * DAY_MS) * (1 + 0.5 * Math.log2(1 + access));
  const age = Math.max(0, now - last);
  // 指数衰减：30 天掉到约 0.37，90 天约 0.05（正好是默认的落叶阈值）
  return Number(node.weight ?? 1) * Math.exp(-age / tau);
}

function scoreNode(node, config, now, textKeywords = []) {
  const weight = node.pinned ? 1 : decayWeight(node, config, now);
  const kws = new Set(node.keywords || computeKeywords(node.text));
  let hit = 0;
  for (const k of textKeywords) if (kws.has(k)) hit += 1;
  const relevance = textKeywords.length ? Math.min(1, hit / 4) : 0;
  const importance = clampNum(node.importance, 3, 1, 5);
  return 0.5 * weight + 0.32 * relevance + 0.18 * (importance / 5);
}

function renderNodes(nodes, config, now, textKeywords, budgetTokens) {
  const groups = new Map();
  let used = 0;
  const budget = Math.max(0, Number(budgetTokens) || 0);
  for (const node of nodes) {
    if (used >= budget) break;
    const line = `- ${String(node.text || '').slice(0, 140)}`;
    const cost = estimateTokens(line) + 6;
    if (used + cost > budget) continue;
    const key = branchOf(node);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
    used += cost;
  }
  const parts = [];
  for (const [branch, lines] of groups) parts.push(`【世界树·${branch}】\n${lines.join('\n')}`);
  return { text: parts.join('\n'), usedTokens: used };
}

function createWorldTreeStore(options = {}) {
  const dir = String(options.dir || '');
  if (!dir) throw new Error('world-tree: dir required');
  const treePath = path.join(dir, 'tree.json');
  const nodesDir = path.join(dir, 'nodes');
  const nutrientsDir = path.join(dir, 'nutrients');
  let tree = null;

  function load() {
    if (tree) return tree;
    try {
      const raw = fs.readFileSync(treePath, 'utf8');
      const parsed = JSON.parse(raw);
      tree = parsed && typeof parsed === 'object' && parsed.nodes ? parsed : emptyTree();
    } catch {
      tree = emptyTree();
    }
    return tree;
  }

  function save() {
    const t = load();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(treePath, `${JSON.stringify(t, null, 2)}\n`, 'utf8');
    return t;
  }

  function writeNodeFile(node, content) {
    const branch = sanitizeBranch(node.branch);
    const folder = path.join(nodesDir, ...branch.split('/'));
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${node.id}.md`);
    const body = `# ${String(node.text || '').slice(0, 80)}\n\n分支：${branch}\n权重：${Number(node.weight ?? 1).toFixed(3)}\n创建：${new Date(Number(node.createdAt) || Date.now()).toISOString()}\n\n${String(content || node.text || '')}\n`;
    fs.writeFileSync(file, body, 'utf8');
    return path.relative(dir, file).replace(/\\/g, '/');
  }

  // 配额：普通节点（知识/技能/人设/教训…）共用 maxNodes；事件分支单独吃 maxEventNodes。
  // 两边互不淘汰对方：事件再多也不会把普通节点挤掉，反之亦然。超限都按「最弱最旧」落叶（不删除）。
  function enforceQuota(t, config, now) {
    const maxNodes = Math.round(clampNum(config.maxNodes, 800, 50, 5000));
    const maxEventNodes = Math.round(clampNum(config.maxEventNodes, 2000, 100, 10000));
    const active = Object.values(t.nodes).filter((n) => n && !n.pinned && !n.fallen);
    const events = active.filter((n) => isEventNode(n));
    const plain = active.filter((n) => !isEventNode(n));
    const fallOverflow = (list, max, reason) => {
      if (list.length <= max) return 0;
      list.sort((a, b) => {
        const diff = scoreNode(a, config, now) - scoreNode(b, config, now);
        if (Math.abs(diff) > 1e-9) return diff;
        // 分数一样时先淘汰更旧的
        return Number(a.createdAt || 0) - Number(b.createdAt || 0);
      });
      const victims = list.slice(0, list.length - max);
      for (const victim of victims) fallNode(t, victim, now, reason);
      return victims.length;
    };
    return {
      fallenPlain: fallOverflow(plain, maxNodes, '超上限'),
      fallenEvents: fallOverflow(events, maxEventNodes, '事件超配额')
    };
  }

  // 发芽 / 茁壮：同一分支下文本相同视为同一节点，只强化。
  // 事件分支额外支持 sourceKey（同一条事件重复落盘时按它去重）与 createdAt（事件发生时间）。
  function grow(input = {}, config = {}, now = Date.now()) {
    const t = load();
    const text = String(input.text || '').trim().slice(0, 200);
    if (!text) return null;
    const branch = sanitizeBranch(input.branch || '知识/其它');
    const event = isEventBranch(branch);
    const sourceKey = input.sourceKey == null ? '' : String(input.sourceKey).trim().slice(0, 120);
    const createdRaw = Number(input.createdAt);
    const createdAt = Number.isFinite(createdRaw) && createdRaw > 0 ? createdRaw : now;
    const key = text.slice(0, 24);
    let node = Object.values(t.nodes).find((n) => {
      if (!n || n.branch !== branch) return false;
      if (event && sourceKey) return String(n.sourceKey || '') === sourceKey;
      return String(n.text || '').slice(0, 24) === key;
    });
    if (node) {
      node.lastAccessAt = now;
      node.accessCount = Math.max(0, Number(node.accessCount) || 0) + 1;
      node.weight = Math.min(1, Number(node.weight ?? 0.6) + 0.1);
      if (sourceKey && !node.sourceKey) node.sourceKey = sourceKey;
      if (input.content) node.file = writeNodeFile(node, input.content);
      save();
      return node;
    }
    node = {
      id: newId(createdAt),
      branch,
      text,
      content: String(input.content || '').slice(0, 2000),
      weight: clampNum(input.weight, 0.6, 0, 1),
      pinned: input.pinned === true || branch.startsWith('人设'),
      importance: Math.round(clampNum(input.importance, 3, 1, 5)),
      keywords: Array.isArray(input.keywords) && input.keywords.length ? input.keywords.slice(0, 40) : computeKeywords(`${branch} ${text}`),
      sourceKey: sourceKey || null,
      createdAt,
      lastAccessAt: createdAt,
      accessCount: 0,
      fallen: false
    };
    t.nodes[node.id] = node;
    node.file = writeNodeFile(node, node.content);
    if (!t.branches.includes(branch)) t.branches.push(branch);
    enforceQuota(t, config, now);
    save();
    return node;
  }

  function reinforceNode(id, now = Date.now()) {
    const t = load();
    const node = t.nodes[id];
    if (!node) return null;
    node.lastAccessAt = now;
    node.accessCount = Math.max(0, Number(node.accessCount) || 0) + 1;
    node.weight = Math.min(1, Number(node.weight ?? 0.5) + 0.1);
    save();
    return node;
  }

  function appendNutrient(t, text, now) {
    fs.mkdirSync(nutrientsDir, { recursive: true });
    const day = new Date(now).toISOString().slice(0, 10);
    const file = path.join(nutrientsDir, `${day}.md`);
    fs.appendFileSync(file, `${text}\n`, 'utf8');
    return path.relative(dir, file).replace(/\\/g, '/');
  }

  function fallNode(t, node, now, reason = '') {
    if (!node || node.fallen) return;
    node.fallen = true;
    node.fallenAt = now;
    node.fallReason = String(reason || '').slice(0, 40);
    const nutrient = appendNutrient(t, `- [${node.branch}] ${node.text}（原权重 ${Number(node.weight ?? 0).toFixed(3)}，${reason || '自然落叶'}）`, now);
    node.nutrient = nutrient;
  }

  // 每次唤醒前跑一次：权重衰减 + 落叶（1 小时内最多算一次，避免每次唤醒都写盘）。
  // 事件分支不走自然落叶：它按 createdAt 时间窗口注入，只由 maxEventNodes 配额淘汰。
  function decayAll(config = {}, now = Date.now()) {
    const t = load();
    if (t.lastDecayAt && now - Number(t.lastDecayAt) < 3600 * 1000) return { decayed: 0, fallen: 0, skipped: true };
    for (const node of Object.values(t.nodes)) {
      if (!node || node.fallen || isEventNode(node)) continue;
      if (node.pinned) { node.weight = 1; continue; }
      node.weight = Math.max(0, decayWeight(node, config, now));
    }
    const fallen = Object.values(t.nodes)
      .filter((n) => n && !n.fallen && !n.pinned && !isEventNode(n))
      .filter((n) => Number(n.weight ?? 0) < Number(config.fallWeight ?? 0.05))
      .filter((n) => now - Number(n.lastAccessAt || n.createdAt || now) > Number(config.fallDays ?? 90) * DAY_MS);
    for (const node of fallen) fallNode(t, node, now, '久未使用');
    t.lastDecayAt = now;
    save();
    return { decayed: Object.values(t.nodes).length, fallen: fallen.length };
  }

  // 检索：人设常驻 + 分支/关键词命中的节点。
  // 事件分支不参与这里：它由 renderBlock 按 eventDays 时间窗口单独成组，避免旧事件被当成知识带上。
  function search(text, config = {}, now = Date.now()) {
    const t = load();
    const textKeywords = computeKeywords(text, 30);
    const pinned = Object.values(t.nodes).filter((n) => n && n.pinned);
    const others = Object.values(t.nodes)
      .filter((n) => n && !n.pinned && !n.fallen && !isEventNode(n))
      .map((n) => ({ node: n, score: scoreNode(n, config, now, textKeywords) }))
      .filter((x) => x.score > 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, 24)
      .map((x) => x.node);
    return { pinned, others, textKeywords };
  }

  // 近期事件：只取没落叶的事件分支节点，createdAt 落在最近 eventDays 天内。
  // 按时间从旧到新排，取最近的 maxItems 条，注进来读起来像一条时间线。
  function collectEvents(now, eventDays, maxItems = 12) {
    const days = Number(eventDays);
    if (!(days > 0)) return [];
    const cutoff = Number(now) - days * DAY_MS;
    const t = load();
    return Object.values(t.nodes)
      .filter((n) => n && !n.fallen && isEventNode(n))
      .filter((n) => Number(n.createdAt || n.lastAccessAt || 0) >= cutoff)
      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
      .slice(-Math.max(1, Math.round(maxItems)));
  }

  // 事件时间戳：用本机时区的「年-月-日 时:分」，模型读起来和「今天/昨天」对得上。
  function formatEventTime(at) {
    const d = new Date(Number(at) || 0);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // 事件组渲染：单独成组【记忆·事件】，行首带时间戳。
  function renderEventNodes(nodes, budgetTokens) {
    const budget = Math.max(0, Number(budgetTokens) || 0);
    const lines = [];
    let used = 0;
    for (const node of nodes) {
      if (used >= budget) break;
      const stamp = formatEventTime(node.createdAt || node.lastAccessAt);
      const line = `- ${stamp ? `${stamp} ` : ''}${String(node.text || '').slice(0, 140)}`;
      const cost = estimateTokens(line) + 6;
      if (used + cost > budget) continue;
      lines.push(line);
      used += cost;
    }
    if (!lines.length) return { text: '', usedTokens: 0 };
    return { text: `【记忆·事件】\n${lines.join('\n')}`, usedTokens: used };
  }

  // 注入块：人设 + 相关知识 + 近期事件（options.eventDays，默认 7 天）。
  function renderBlock(text, config = {}, now = Date.now(), options = {}) {
    const conf = normalizeTreeConfig(config);
    if (!conf.enabled) return '';
    const eventDays = clampNum(options?.eventDays, 7, 0, 3650);
    const { pinned, others } = search(text, conf, now);
    const parts = [];
    const persona = renderNodes(pinned, conf, now, [], Math.max(60, Math.round(conf.budgetTokens * 0.35)));
    if (persona.text) parts.push(persona.text);
    const restBudget = Math.max(0, conf.budgetTokens - persona.usedTokens);
    // 给近期事件留一小份预算（没有事件就不留）：既不让事件挤掉知识，也不让知识把事件饿死。
    const recent = collectEvents(now, eventDays);
    const eventBudget = recent.length ? Math.min(Math.max(40, Math.round(conf.budgetTokens * 0.2)), restBudget) : 0;
    const rest = renderNodes(others, conf, now, [], Math.max(0, restBudget - eventBudget));
    if (rest.text) parts.push(rest.text);
    if (recent.length) {
      const events = renderEventNodes(recent, eventBudget);
      if (events.text) parts.push(events.text);
    }
    if (!parts.length) return '';
    // 这句只提醒「长期沉淀」；如果只剩事件，就别把刚发生的事说成旧事。
    const note = persona.text || rest.text ? '\n（世界树是长期沉淀，淡的是旧事，别当成刚发生的）' : '';
    return `${parts.join('\n')}${note}`;
  }

  function stats() {
    const t = load();
    const nodes = Object.values(t.nodes).filter((n) => n && !n.fallen);
    const byBranch = {};
    for (const n of nodes) {
      // 事件节点单独记在 '记忆/事件' 名下，不和 '记忆' 混在一起。
      const b = isEventNode(n) ? EVENT_BRANCH : branchOf(n);
      byBranch[b] = byBranch[b] || { count: 0, weight: 0 };
      byBranch[b].count += 1;
      byBranch[b].weight += Number(n.weight || 0);
    }
    for (const b of Object.keys(byBranch)) byBranch[b].avgWeight = Number((byBranch[b].weight / Math.max(1, byBranch[b].count)).toFixed(3));
    const recent = nodes
      .slice()
      .sort((a, b) => Number(b.lastAccessAt || 0) - Number(a.lastAccessAt || 0))
      .slice(0, 10)
      .map((n) => ({ id: n.id, branch: n.branch, text: n.text, weight: Number(Number(n.weight || 0).toFixed(3)), lastAccessAt: n.lastAccessAt }));
    return {
      dir,
      total: nodes.length,
      fallen: Object.values(t.nodes).filter((n) => n && n.fallen).length,
      pinned: nodes.filter((n) => n.pinned).length,
      eventCount: nodes.filter((n) => isEventNode(n)).length,
      branches: byBranch,
      recent
    };
  }

  function lookup(text, limit = 10) {
    const t = load();
    const kw = computeKeywords(text, 30);
    const scored = Object.values(t.nodes)
      .filter(Boolean)
      .map((n) => ({ node: n, score: scoreNode(n, normalizeTreeConfig({}), Date.now(), kw) }))
      .filter((x) => x.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map((x) => ({ ...x.node, score: Number(x.score.toFixed(3)) }));
  }

  // 养分：把这次看到/聊到的内容记一笔，回头长新枝、或者挖旧落叶时用得上。
  function nutrient(text, now = Date.now()) {
    const line = String(text || '').trim().slice(0, 400);
    if (!line) return '';
    const t = load();
    return appendNutrient(t, `- ${line.replace(/\s+/g, ' ')}`, now);
  }

  return { dir, load, save, grow, reinforceNode, decayAll, search, renderBlock, stats, lookup, nutrient };
}

export {
  ROOT_BRANCHES,
  EVENT_BRANCH,
  normalizeTreeConfig,
  computeKeywords,
  estimateTokens,
  sanitizeBranch,
  branchOf,
  isEventBranch,
  decayWeight,
  scoreNode,
  createWorldTreeStore
};
