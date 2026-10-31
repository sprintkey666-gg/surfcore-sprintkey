/**
 * DSH profile 的 cordis.patch.yml 里那三条 MCP 的「自愈」逻辑。
 *
 * 为什么需要它：这三条一旦丢了（DSH 自己重写补丁、用户点了「恢复备份」、装新版本覆盖），
 * 桥接能照常收发消息，但 agent 那边所有 mcp__snowluma__* 工具都会变成 unknown tool ——
 * 远端看起来像"插件坏了"，实际是 MCP 进程根本没被 spawn。2026-10-31 真出过一次。
 * 所以桥接每次启动都点一遍：缺了就补回去，补之前先备份，改完必须能被 YAML 解析。
 *
 * 归属约定：桥接只认 MANAGED_MCP_IDS 这三个 id，区块用 BEGIN/END 包住整体替换，
 * 用户自己加的其他条目一个字都不碰。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';

export const MANAGED_MCP_IDS = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe'];

export const MCP_BLOCK_BEGIN = '# === qq-bridge MCP BEGIN ===';
export const MCP_BLOCK_END = '# === qq-bridge MCP END ===';

const DEFAULT_DSH_HOME = path.join(os.homedir(), '.dsh');

function yamlSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 托管区块的文本。node 默认用当前进程的 node：MCP 服务器本来就是被这个 runtime 拉起的，
 * 换成别的 node 反而可能出现版本/路径不一致。
 */
export function mcpBlockText({ repoRoot, node = process.execPath, ids = null } = {}) {
  const root = repoRoot ? String(repoRoot) : path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')));
  const all = [
    ['mcp-snowluma', 'snowluma', path.join(root, 'src', 'mcp-snowluma-safe.js'), 725000],
    ['mcp-snowluma-host', 'snowluma-host', path.join(root, 'src', 'mcp-host-server.js'), 0],
    ['mcp-web-search-safe', 'web-search-safe', path.join(root, 'src', 'mcp-web-search-safe.js'), 0],
  ];
  const wanted = Array.isArray(ids) && ids.length ? all.filter(([id]) => ids.includes(id)) : all;
  let out = `${MCP_BLOCK_BEGIN}\n`;
  out += '# 由桥接启动自检（src/mcp-patch.js）维护：整块会被替换，别手工改里面的条目。\n';
  for (const [id, serverName, script, timeout] of wanted) {
    out += '- insert:\n';
    out += `    - id: ${id}\n`;
    out += "      name: '@deepseek-ai/dsh-mcp-client'\n";
    out += '      config:\n';
    out += `        serverName: ${serverName}\n`;
    out += '        transport: stdio\n';
    out += `        command: ${yamlSingleQuote(node)}\n`;
    out += '        args:\n';
    out += `          - ${yamlSingleQuote(script)}\n`;
    // qq_wait_for_messages 最长等 10 分钟，DSH 默认 60 秒会提前掐断。
    if (timeout) out += `        toolCallTimeoutMs: ${timeout}\n`;
  }
  out += `${MCP_BLOCK_END}\n`;
  return out;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

/** 去掉托管区块（含它前面的空行），返回剩下的文本。 */
export function stripMcpBlock(text) {
  const src = String(text ?? '');
  const begin = src.indexOf(MCP_BLOCK_BEGIN);
  if (begin < 0) return src;
  const endIdx = src.indexOf(MCP_BLOCK_END, begin);
  const end = endIdx < 0 ? src.length : endIdx + MCP_BLOCK_END.length;
  const before = src.slice(0, begin).replace(/\s+$/, '');
  const after = src.slice(end).replace(/^\s*\n/, '\n');
  return `${before}\n${after}`.replace(/\n{3,}/g, '\n\n');
}

/** 收集文档里已经出现的托管 id（顶层 id 和 insert 里的 id 都算）。 */
export function collectIds(doc) {
  const ids = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node.id === 'string') ids.add(node.id);
    for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value);
  };
  visit(doc);
  return ids;
}

/**
 * 找当前要修哪个 profile。优先级：显式传入 > 环境变量 > 扫描 profiles 目录打分。
 * 打分依据是「这个 profile 里有我们维护过的痕迹」，全都没有时退到最近改过的那个。
 */
export function resolveProfileDir({ dshHome = process.env.DSH_HOME || DEFAULT_DSH_HOME, profile = process.env.DSH_PROFILE || '' } = {}) {
  if (profile) return path.join(dshHome, 'profiles', profile);
  const root = path.join(dshHome, 'profiles');
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    const dir = path.join(root, name);
    let score = 0;
    const patch = readText(path.join(dir, 'cordis.patch.yml')) || '';
    if (patch.includes('qq-bridge MCP')) score += 3;
    if (patch.includes('dsh-mcp-client')) score += 1;
    const pkg = readText(path.join(dir, 'package.json')) || '';
    if (pkg.includes('surfcore')) score += 2;
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, 'cordis.patch.yml')).mtimeMs; } catch {}
    if (!best || score > best.score || (score === best.score && mtime > best.mtime)) best = { dir, score, mtime };
  }
  return best?.dir ?? null;
}

/**
 * 自检并补回三条 MCP。
 * 返回 `{ changed, file, added, backup, reason }`；任何异常都往上抛，由调用方决定要不要声张。
 */
export function ensureMcpEntries({ dshHome, profile, repoRoot, node, dryRun = false } = {}) {
  const dir = resolveProfileDir({ dshHome, profile });
  if (!dir) return { changed: false, file: null, added: [], backup: null, reason: '没找到 DSH profile 目录' };
  const file = path.join(dir, 'cordis.patch.yml');
  const original = readText(file);
  if (original == null) {
    // 文件都不在：不动手创建（DSH 自己会生成），只在日志里说一声。
    return { changed: false, file, added: [], backup: null, reason: 'profile 里没有 cordis.patch.yml' };
  }
  const body = stripMcpBlock(original);
  // 先看原文里到底缺哪几条（不能先剥块再看，那样永远"全缺"）。
  let presentIds = new Set();
  let parsedOriginal = true;
  try {
    const doc = yaml.load(original) ?? [];
    if (!Array.isArray(doc)) parsedOriginal = false;
    else presentIds = collectIds(doc);
  } catch {
    parsedOriginal = false;
  }
  if (!parsedOriginal) {
    // 原文解析不了（可能上次写坏/用户手改坏）：退回按"剥掉托管块后还能不能解析"判断，
    // 能解析就说明坏的是托管块本身，这种情况允许整体替换。
    try {
      const rest = yaml.load(body) ?? [];
      if (!Array.isArray(rest)) {
        return { changed: false, file, added: [], backup: null, reason: '现有补丁不是 YAML 数组，没敢改' };
      }
      presentIds = collectIds(rest);
    } catch (error) {
      return { changed: false, file, added: [], backup: null, reason: `现有补丁不是合法 YAML，没敢改：${error.message}` };
    }
  }
  const missing = MANAGED_MCP_IDS.filter((id) => !presentIds.has(id));
  if (!missing.length) return { changed: false, file, added: [], backup: null, reason: '三条 MCP 都在' };
  // 托管区块在：整块按三条重建（这是我们自己的地盘）。
  // 托管区块不在、但用户手上已经有其中几条：只补缺的那几条，别把已有的插成两份。
  const hasBlock = original.includes(MCP_BLOCK_BEGIN);
  const entries = hasBlock ? MANAGED_MCP_IDS : missing;
  const next = `${body.replace(/\s+$/, '')}\n\n${mcpBlockText({ repoRoot, node, ids: entries })}`;
  try {
    const parsed = yaml.load(next);
    if (!Array.isArray(parsed) || MANAGED_MCP_IDS.some((id) => !collectIds(parsed).has(id))) {
      return { changed: false, file, added: [], backup: null, reason: '补回后校验不通过（缺 id），已放弃写入' };
    }
  } catch (error) {
    return { changed: false, file, added: [], backup: null, reason: `补回后 YAML 解析失败，已放弃写入：${error.message}` };
  }
  if (dryRun) return { changed: false, file, added: missing, backup: null, reason: 'dryRun' };
  let backup = null;
  try {
    backup = `${file}.bak-mcp-selfheal-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
  } catch {
    backup = null;
  }
  fs.writeFileSync(file, next, 'utf8');
  return { changed: true, file, added: missing, backup, reason: `补回 ${missing.length} 条` };
}
