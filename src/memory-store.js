// 第 1 层：轻记忆（会话级记忆库）
//
// 设计依据（2026-10-28 重设计）：
//   - MemoryBank (AAAI 2024)：艾宾浩斯遗忘曲线 + 间隔重复（被想起 → 强化 → 忘得更慢）
//   - Generative Agents (Park et al. 2023)：检索分数 = recency / relevance / importance 加权
//   - Mem0 (2026)：时序推理与记忆衰减（最近用过的排前面）
//
// 三条硬规则：
//   1) 记忆永远不硬删除 —— 只有「强度」随时间指数衰减，越久越淡，但不归零；
//   2) 被提起 / 被检索命中就强化（accessCount++，τ 变长），下次衰减更慢；
//   3) 注入不按条数截断，按 token 预算装满即停（改成「最多 8 条」那种硬上限就违背记忆曲线）。
//
// 本模块是纯函数，不碰 fs / 网络 / 全局状态，方便单测。
'use strict';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

const MEMORY_TYPE = ['topic', 'event', 'relation', 'thought', 'skill'];
const TEXT_KEY_LEN = 24;

function clampNum(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// 字数 → 粗估 token：中文 0.7 token/字（estimateTokens 的同一套换算，只用于内部预算）。
// 对外一律用「字」，这里只是把字数喂给还在按 token 记账的老接口。
export function tokensForChars(chars) {
  const n = Number(chars);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.ceil(n * 0.7));
}

// 单层（会话 / 共享 / 树）默认注入字数上限：主人反馈 4000 太低、600 token 看不懂，统一用「字」表达。
export const DEFAULT_LAYER_CHARS = 6000;
export const MAX_LAYER_CHARS = 16000;
export const MAX_TOTAL_CHARS = 10000;

// 共享记忆配置（兼容旧字段：maxTopics → budgetTokens，maxAgeHours → decayHours）
export function normalizeSharedConfig(raw) {
  const cm = raw && typeof raw === 'object' ? raw : {};
  const dirRaw = String(cm.direction || '').trim();
  const direction = ['both', 'private-to-group'].includes(dirRaw) ? dirRaw : 'both';
  const legacyBudget = Number(cm.maxTopics) > 0 ? Number(cm.maxTopics) * 30 : 600;
  const legacyDecay = Number(cm.maxAgeHours) > 0 ? Math.max(6, Math.round(Number(cm.maxAgeHours) / 3)) : 24;
  // 单层注入字数预算：新字段 budgetChars 优先；老字段 budgetTokens / maxTopics 按字数换算后兼容。
  // 三者都没配时用默认 6000 字（不再从 600 token 起算，避免老默认值一路带下来）。
  const hasExplicit = Number(cm.budgetChars) > 0 || Number(cm.budgetTokens) > 0 || Number(cm.maxTopics) > 0;
  const legacyChars = Math.round((Number(cm.budgetTokens) > 0 ? Number(cm.budgetTokens) : legacyBudget) * 1.4);
  const fallbackChars = hasExplicit ? Math.max(100, legacyChars) : DEFAULT_LAYER_CHARS;
  const budgetChars = Math.round(clampNum(cm.budgetChars, fallbackChars, 100, MAX_LAYER_CHARS));
  return {
    enabled: cm.enabled !== false,
    direction,
    // 对外展示与 UI 用的是 budgetChars；budgetTokens 只留给内部 pickByBudget 记账。
    budgetChars,
    budgetTokens: tokensForChars(budgetChars),
    decayHours: clampNum(cm.decayHours, legacyDecay, 1, 720),
    associate: cm.associate !== false,
    ringDays: clampNum(cm.ringDays, 14, 1, 365),
    includeOtherGroups: cm.includeOtherGroups === true,
    // 默认 false：主人环内双向共享（群聊聊过的，私聊也记得）。想保守就打开，只共享「和主人相关」的。
    onlyOwnerInvolved: cm.onlyOwnerInvolved === true,
    // ── 2026-10-28 v4 新增 ────────────────────────────────────────────────
    // 记忆引擎：curve = Sprintkey 记忆曲线（默认）；legacy = 插件原有规则（24h 过期 + 最多 20 条 + 无清晰度）。
    // 只影响「怎么读/怎么衰减」，不影响写入，所以随时可切、不丢数据。
    engine: cm.engine === 'legacy' ? 'legacy' : 'curve',
    // 会话记忆 + 共享记忆 + 世界树 三层共用的注入总字数（记忆卡整卡注入，不占这个额度）。
    // 2026-10-29：默认 4000 太低，主人要求上限抬到 10000。
    totalChars: Math.round(clampNum(cm.injectMaxChars, 4000, 800, MAX_TOTAL_CHARS)),
  };
}

// legacy 引擎的会话记忆：24 小时内、最多 20 条、按时间倒序（=插件原有规则）。
export function pickLegacy(items, options = {}) {
  const now = Number(options.now) || Date.now();
  const horizon = Math.max(1, Number(options.hours) || 24) * HOUR_MS;
  const max = Math.max(1, Math.min(50, Number(options.max) || 20));
  return (Array.isArray(items) ? items : [])
    .filter((m) => m && String(m.value || '').trim())
    .filter((m) => now - Number(m.lastMentionAt || m.createdAt || now) <= horizon)
    .sort((a, b) => Number(b.lastMentionAt || b.createdAt || 0) - Number(a.lastMentionAt || a.createdAt || 0))
    .slice(0, max)
    .map((m) => ({ mem: m, value: m.value, strength: 1 }));
}

// 按角色过滤：新条目带 characterId；老条目没有标记，视为「任意角色都可用」。
export function filterByCharacter(items, characterId) {
  const id = String(characterId || '').trim();
  if (!id) return Array.isArray(items) ? items : [];
  return (Array.isArray(items) ? items : []).filter((m) => !m || !m.characterId || String(m.characterId) === id);
}

// 3-gram 相似度：给「卡里已经说过的、树里不要再说一遍」这种去重用。
function trigrams(text, cap = 120) {
  const s = String(text || '').replace(/[\s\u3000]+/g, '').toLowerCase();
  const out = new Set();
  for (let i = 0; i + 3 <= s.length && out.size < cap; i += 1) out.add(s.slice(i, i + 3));
  return out;
}

export function similarityOf(a, b) {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit += 1;
  return hit / Math.min(A.size, B.size);
}

/**
 * 去重：把 items 里与 reference 文本（或已入选文本）重合度 > threshold 的条目丢掉。
 * 用于「本会话 > 共享 > 树事件」的优先级：后面的层不再重复前面的层已经说过的事。
 */
export function dedupeAgainst(items, reference, options = {}) {
  const threshold = clampNum(options.threshold, 0.6, 0.3, 0.95);
  const refs = [];
  const pushRef = (v) => { const t = String(v || '').trim(); if (t) refs.push(t); };
  if (Array.isArray(reference)) reference.forEach(pushRef);
  else pushRef(reference);
  const kept = [];
  for (const item of Array.isArray(items) ? items : []) {
    const mem = item.mem || item;
    const value = String(item.value ?? mem.value ?? mem.text ?? '').trim();
    if (!value) continue;
    if (refs.some((r) => similarityOf(value, r) > threshold)) continue;
    kept.push(item);
    pushRef(value);
  }
  return kept;
}

/**
 * 拆句：把记忆卡/树渲染文本拆成可比对的整句（去掉列表符号，丢掉太短的标题）。
 * 用于「卡里已经说过的整句，三层里不再重复一遍」。
 */
export function splitSentences(text, minLen = 6) {
  return String(text || '')
    .split(/[\n。！？!?；;]/)
    // 去掉列表符号，再去掉行首的【分组名】/「引用」标记（它们不是内容）
    .map((s) => s.replace(/^[\s\-•·*]+/, '').replace(/^【[^】]{0,20}】\s*/, '').trim())
    .filter((s) => s.length >= minLen);
}

/**
 * 行级去重：把 text 里与 refs（字符串或字符串数组）重合度 > threshold 的整行丢掉。
 * 标题、空行、短行（含「【记忆·事件】」这类分组名）保留。
 * 返回 { text, dropped }，dropped 用来打日志。
 */
export function dropEchoLines(text, refs, options = {}) {
  const raw = String(text || '');
  const threshold = clampNum(options.threshold, 0.6, 0.3, 0.95);
  const minLen = Math.max(2, Number(options.minLen) || 6);
  const list = (Array.isArray(refs) ? refs : [refs])
    .map((v) => String(v || '').replace(/^[\s\-•·*]+/, '').trim())
    .filter((v) => v.length >= minLen);
  if (!raw || !list.length) return { text: raw, dropped: 0 };
  let dropped = 0;
  const kept = raw.split('\n').filter((line) => {
    const t = line.replace(/^[\s\-•·*]+/, '').trim();
    if (t.length < minLen) return true;
    if (list.some((ref) => similarityOf(t, ref) > threshold)) {
      dropped += 1;
      return false;
    }
    return true;
  }).join('\n');
  return { text: kept, dropped };
}

// 粗略 token 估算：中文按 0.7 token/字，其余按 4 字符/token（只用于预算，不追求精确）
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const rest = Math.max(0, s.length - cjk);
  return Math.max(1, Math.ceil(cjk * 0.7 + rest / 4));
}

const EN_STOP = new Set(['the', 'and', 'for', 'you', 'are', 'was', 'with', 'this', 'that', 'have', 'has', 'not', 'but', 'its', 'his', 'her', 'him', 'she', 'they']);

// 关键词：中文 bigram + 英文/数字词，用于轻量相关性（不做 embedding）
export function computeKeywords(text, limit = 40) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9][a-z0-9_-]{2,}/g) || []) {
    if (!EN_STOP.has(w)) out.add(w);
    if (out.size >= limit) break;
  }
  const cjkRuns = s.match(/[\u3400-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      out.add(run.slice(i, i + 2));
      if (out.size >= limit) break;
    }
    if (out.size >= limit) break;
  }
  return [...out];
}

export function relevanceOf(memoryKeywords, textKeywords) {
  if (!Array.isArray(memoryKeywords) || !memoryKeywords.length) return 0;
  if (!Array.isArray(textKeywords) || !textKeywords.length) return 0;
  const set = new Set(textKeywords);
  let hit = 0;
  for (const k of memoryKeywords) if (set.has(k)) hit += 1;
  return Math.min(1, hit / Math.max(1, Math.min(memoryKeywords.length, 8)));
}

// 强度 S ∈ (0,1]：指数衰减；τ 随 accessCount / importance 变大（间隔重复：越常想起忘得越慢）
export function strengthOf(memory, now = Date.now(), config = {}) {
  const at = Number(now) || Date.now();
  const last = Number(memory?.lastMentionAt || memory?.lastAccessAt || memory?.createdAt || 0) || at;
  const access = Math.max(0, Number(memory?.accessCount ?? memory?.reinforceCount) || 0);
  const importance = clampNum(memory?.importance, 3, 1, 5);
  const base = Math.max(HOUR_MS, Number(config?.decayHours ?? 24) * HOUR_MS);
  const tau = base * (1 + 0.6 * Math.log2(1 + access)) * (0.7 + 0.15 * importance);
  const age = Math.max(0, at - last);
  return Math.exp(-age / tau);
}

export function levelOf(strength) {
  if (strength >= 0.6) return '清晰';
  if (strength >= 0.25) return '有点模糊';
  return '模糊';
}

export function formatAge(ms) {
  const diff = Math.max(0, Number(ms) || 0);
  if (diff < HOUR_MS) return `${Math.max(1, Math.round(diff / 60000))} 分钟前`;
  if (diff < DAY_MS) return `${Math.round(diff / HOUR_MS)} 小时前`;
  const days = Math.round(diff / DAY_MS);
  if (days < 60) return `${days} 天前`;
  return `${Math.round(days / 30)} 个月前`;
}

function makeId(now = Date.now()) {
  return `m${Number(now).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createMemory(input = {}, now = Date.now()) {
  const value = String(input.value ?? input.text ?? '').trim().slice(0, 200);
  if (!value) return null;
  const type = MEMORY_TYPE.includes(input.type) ? input.type : (MEMORY_TYPE.includes(input.kind) ? input.kind : 'topic');
  return {
    id: String(input.id || makeId(now)),
    type,
    key: String(input.key || '').slice(0, 60),
    value,
    importance: Math.round(clampNum(input.importance, 3, 1, 5)),
    confidence: clampNum(input.confidence, 0.6, 0, 1),
    createdAt: Number(input.createdAt) || now,
    lastMentionAt: Number(input.lastMentionAt) || Number(input.createdAt) || now,
    accessCount: Math.max(0, Number(input.accessCount) || 0),
    reinforceCount: Math.max(0, Number(input.reinforceCount) || 0),
    sourceKey: String(input.sourceKey || '').slice(0, 80),
    characterId: String(input.characterId || '').slice(0, 80),
    userId: String(input.userId || '').slice(0, 40),
    display: String(input.display || '').slice(0, 60),
    isOwner: input.isOwner === true,
    isOwnerInvolved: input.isOwnerInvolved === true,
    participants: Array.isArray(input.participants) ? input.participants.map((p) => String(p)).slice(0, 10) : [],
    tags: Array.isArray(input.tags) ? input.tags.map((p) => String(p)).slice(0, 10) : [],
    keywords: Array.isArray(input.keywords) && input.keywords.length ? input.keywords.slice(0, 40) : computeKeywords(value)
  };
}

// 「想起了」：刷新最近提起时间 + 计数（衰减因此变慢）
export function reinforceMemory(memory, now = Date.now(), amount = 1) {
  if (!memory) return memory;
  const at = Number(now) || Date.now();
  memory.lastMentionAt = at;
  memory.lastAccessAt = at;
  memory.accessCount = Math.max(0, Number(memory.accessCount) || 0) + Math.max(0, Number(amount) || 1);
  memory.reinforceCount = Math.max(0, Number(memory.reinforceCount) || 0) + 1;
  return memory;
}

// 兼容别名
export const touchMemory = reinforceMemory;

// 写入记忆数组（memories 是数组本身，不是包装对象）。重复内容不新增，只强化。
// 超过上限时把最弱的一条挪进 archive —— 依然不删除，只是不再注入。
export function addMemory(memories, input, options = {}) {
  if (!Array.isArray(memories)) return null;
  const now = Number(options.now) || Date.now();
  const mem = createMemory(input, now);
  if (!mem) return null;
  const dedupeKey = String(input.dedupeKey ?? mem.key ?? '').trim();
  const existing = memories.find((m) => {
    if (!m) return false;
    // 不同角色各记各的：老条目没有 characterId 时仍可被认领（只补标记，不重复写）。
    if (mem.characterId && m.characterId && String(m.characterId) !== String(mem.characterId)) return false;
    if (dedupeKey && String(m.key || '') === dedupeKey) return true;
    return String(m.value || '').slice(0, TEXT_KEY_LEN) === mem.value.slice(0, TEXT_KEY_LEN);
  });
  if (existing) {
    if (!existing.characterId && mem.characterId) existing.characterId = mem.characterId;
    reinforceMemory(existing, now);
    if (mem.participants.length) {
      const set = new Set([...(existing.participants || []), ...mem.participants]);
      existing.participants = [...set].slice(0, 10);
    }
    if (mem.isOwnerInvolved && !existing.isOwnerInvolved) existing.isOwnerInvolved = true;
    if (Number(mem.importance) > Number(existing.importance || 0)) existing.importance = mem.importance;
    return existing;
  }
  memories.push(mem);
  const maxMemories = Math.max(50, Number(options.maxMemories) || 400);
  if (memories.length > maxMemories) {
    const scored = memories
      .map((m) => ({ m, s: strengthOf(m, now, options) }))
      .sort((a, b) => a.s - b.s);
    const dropCount = memories.length - maxMemories;
    for (let i = 0; i < dropCount; i += 1) {
      const victim = scored[i];
      if (!victim) break;
      const idx = memories.indexOf(victim.m);
      if (idx >= 0) memories.splice(idx, 1);
      if (options.archive && Array.isArray(options.archive)) options.archive.push(victim.m);
    }
  }
  return mem;
}

// 检索打分：0.45*强度 + 0.35*相关性 + 0.2*重要性；老记忆被话头勾中要标 surprise。
export function scoreMemories(memories, ctx = {}) {
  const now = Number(ctx.now) || Date.now();
  const config = ctx.config || {};
  const textKeywords = Array.isArray(ctx.textKeywords) ? ctx.textKeywords : computeKeywords(ctx.text || '');
  const out = [];
  for (const mem of Array.isArray(memories) ? memories : []) {
    const value = String(mem?.value ?? mem?.text ?? '').trim();
    if (!value) continue;
    const strength = strengthOf(mem, now, config);
    const relevance = relevanceOf(Array.isArray(mem.keywords) ? mem.keywords : computeKeywords(value), textKeywords);
    const importance = clampNum(mem.importance, 3, 1, 5);
    const score = 0.45 * strength + 0.35 * relevance + 0.2 * (importance / 5);
    const last = Number(mem.lastMentionAt || mem.createdAt || now);
    out.push({
      mem,
      type: mem.type || 'topic',
      key: mem.key || '',
      value,
      strength,
      relevance,
      importance,
      score,
      ageDays: Math.max(0, (now - last) / DAY_MS),
      lastMentionAt: last,
      userId: String(mem.userId || ''),
      isOwnerInvolved: mem.isOwnerInvolved === true,
      sourceKey: String(mem.sourceKey || ''),
      surprise: relevance >= 0.34 && strength < 0.25
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// token 预算挑选：装不下就跳过继续找下一条（不按条数硬截断）。
export function pickByBudget(scored, budgetTokens) {
  const picked = [];
  let used = 0;
  const budget = Math.max(20, Number(budgetTokens) || 600);
  for (const item of Array.isArray(scored) ? scored : []) {
    const cost = estimateTokens(item.value ?? item.text ?? '') + 8;
    if (used + cost > budget) continue;
    picked.push(item);
    used += cost;
  }
  return { picked, usedTokens: used };
}

// 渲染注入块：清晰度 + 多久以前；被话头勾起的放「突然想起」。
export function renderBlock(items, options = {}) {
  const now = Number(options.now) || Date.now();
  const legacy = options.engine === 'legacy';
  const lines = [];
  const associate = [];
  for (const item of Array.isArray(items) ? items : []) {
    const mem = item.mem || item;
    const value = String(item.value ?? mem.value ?? mem.text ?? '').trim();
    if (!value) continue;
    // legacy 引擎 = 插件原有规则：不带清晰度、不带时长（主人要的是「跟以前一样」）。
    if (legacy) {
      lines.push(`- ${value.slice(0, 140)}`);
      continue;
    }
    const strength = Number.isFinite(item.strength) ? item.strength : strengthOf(mem, now, options.config || {});
    const last = Number(item.lastMentionAt || mem.lastMentionAt || mem.createdAt || 0);
    const ago = last ? formatAge(now - last) : '最近';
    const line = `- ${value.slice(0, 140)}（${levelOf(strength)}，${ago}）`;
    if (options.associate && item.surprise) associate.push(line);
    else lines.push(line);
  }
  if (!lines.length && !associate.length) return '';
  const parts = [];
  if (lines.length) parts.push(`${options.title || '【记忆】'}\n${lines.join('\n')}`);
  if (associate.length) parts.push(`【突然想起】很久没提、但跟现在这句对得上：\n${associate.join('\n')}`);
  if (options.note) parts.push(options.note);
  return parts.join('\n');
}

// 旧状态迁移：activeTopics / pendingThoughts / memberImpressions → memories（幂等）。
export function migrateFromState(st, options = {}) {
  if (!st || typeof st !== 'object') return 0;
  const now = Number(options.now) || Date.now();
  const sourceKey = String(options.sourceKey || st.__key || '');
  // 已经有 memories 数组时也要增量合并：旧代码还在往 activeTopics / pendingThoughts 里写，
  // 只认「数组不存在才迁移」会让新写入的话题永远进不了记忆池（双向共享就空了）。
  const had = Array.isArray(st.memories) ? st.memories : null;
  const memories = had || [];
  const seen = new Set();
  for (const m of memories) {
    const v = String(m?.value || '').trim();
    if (v) seen.add(v);
  }
  let added = 0;
  const push = (mem) => {
    if (!mem) return;
    const v = String(mem.value || '').trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    memories.push(mem);
    added += 1;
  };
  for (const t of Array.isArray(st.activeTopics) ? st.activeTopics : []) {
    const mem = createMemory({
      type: 'topic',
      value: t?.text,
      importance: 3,
      createdAt: Number(t?.createdAt) || Number(t?.lastMentionAt) || now,
      lastMentionAt: Number(t?.lastMentionAt) || now,
      sourceKey,
      participants: t?.participants
    }, now);
    if (mem) mem.pendingQuestion = t?.pendingQuestion ? String(t.pendingQuestion).slice(0, 200) : '';
    push(mem);
  }
  for (const t of Array.isArray(st.pendingThoughts) ? st.pendingThoughts : []) {
    push(createMemory({
      type: 'thought',
      value: t?.text,
      importance: 2,
      createdAt: Number(t?.createdAt) || now,
      lastMentionAt: Number(t?.createdAt) || now,
      sourceKey
    }, now));
  }
  for (const [name, im] of Object.entries(st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {})) {
    const traits = Array.isArray(im?.traits) ? im.traits.join('、') : '';
    if (!traits) continue;
    push(createMemory({
      type: 'relation',
      key: `imp:${name}`,
      value: `${name}：${traits}`,
      importance: 3,
      createdAt: Number(im?.lastSeenAt) || now,
      lastMentionAt: Number(im?.lastSeenAt) || now,
      sourceKey,
      participants: [name]
    }, now));
  }
  st.memories = memories;
  return added;
}

// 消息到达时：命中关键词的记忆记为「被提起」（强度回升）。
export function touchByText(memories, text, options = {}) {
  const list = Array.isArray(memories) ? memories : [];
  if (!list.length) return 0;
  const now = Number(options.now) || Date.now();
  const words = String(text || '').slice(0, 400);
  if (!words) return 0;
  const kw = computeKeywords(words, 24);
  if (!kw.length) return 0;
  const hits = scoreMemories(list, { textKeywords: kw, now, config: { decayHours: Number(options.decayHours) || 24 } })
    .filter((x) => x.relevance > 0)
    .slice(0, Math.max(1, Number(options.limit) || 3));
  for (const h of hits) reinforceMemory(h.mem, now, Number(options.boost) >= 1 ? Number(options.boost) : 1);
  return hits.length;
}

export { HOUR_MS, DAY_MS, MEMORY_TYPE };
