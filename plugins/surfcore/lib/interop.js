// 互通记忆（2026-11-03）
//
// 背景：悬浮窗「会话」和「陪伴模式字幕」以前和 QQ 聊天不是一个 ai——
//   会话/字幕只读 QQ 记忆卡（还截断到 2600 字），字幕还明确 archive:false, remember:false，
//   所以它说的话既进不了记忆卡、也进不了倍份；QQ 那边也看不到这边聊了什么。
//
// 这里只放**纯函数**：配置归一化、跨端最近对话的格式化、记忆文本拼装与截断。
// 真正的读写落盘在 pet-chat.js / orb-companion.js / memory-card.js 里。
//
// 三个开关的语义（主人 2026-11-03 定的）：
//   · interop.qq   = 读 QQ 记忆卡（关掉 = 这边看不到 QQ 那边的事）
//   · interop.bili = 读 B站 记忆卡（关掉 = 看不到 B站 那边的事）
//   · 两个都开 = 会话 / 字幕 / QQ / B站 四者记忆全通
// 写卡永远跟着 memoryCard.enabled + orb.chat.shareMemory 走，和这两个读开关无关
// （读是「看不看得到」，写是「记不记得住」，不该互相连坐）。

export const INTEROP_DEFAULTS = Object.freeze({
  qq: true,
  bili: true,
  identity: true,
  recent: true,
  // 2026-11-03：主人对暗号那次，约定的那轮对话在 6 小时前、约 100 条消息之前，
  // 12 行 / 24 小时的窗口根本够不着。默认放宽到 30 行 / 48 小时。
  recentLines: 30,
  recentHours: 48,
  personaMaxChars: 12000,
  memoryMaxChars: 8000,
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 配置归一化：缺省补齐 + 越界钳制。纯函数，单测直接打。 */
export function normalizeInterop(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    qq: src.qq !== false,
    bili: src.bili !== false,
    identity: src.identity !== false,
    recent: src.recent !== false,
    recentLines: clampInt(src.recentLines, 4, 40, INTEROP_DEFAULTS.recentLines),
    recentHours: clampInt(src.recentHours, 1, 168, INTEROP_DEFAULTS.recentHours),
    personaMaxChars: clampInt(src.personaMaxChars, 4000, 30000, INTEROP_DEFAULTS.personaMaxChars),
    memoryMaxChars: clampInt(src.memoryMaxChars, 2000, 20000, INTEROP_DEFAULTS.memoryMaxChars),
  };
}

/** 按上限截断，尽量在换行处断开，末尾留一个省略标记。 */
export function clampText(text, max, tail = '…（后面省略）') {
  const s = String(text ?? '');
  const limit = Math.max(0, Number(max) || 0);
  if (!limit || s.length <= limit) return s;
  const head = s.slice(0, Math.max(0, limit - tail.length));
  const cut = head.lastIndexOf('\n');
  return `${cut > limit * 0.5 ? head.slice(0, cut) : head}${tail}`;
}

/**
 * 把跨端最近的对话排成几行纯文本。
 * records: [{ at, channel, channelLabel, role, name, text }]（chat-archive 的读法）
 */
export function formatRecentLines(records, { limit = 12, nowMs = Date.now(), hours = 24 } = {}) {
  const max = Math.max(1, Math.min(40, Number(limit) || 12));
  const since = nowMs - Math.max(1, Number(hours) || 24) * 3600_000;
  const list = (Array.isArray(records) ? records : [])
    .filter((r) => r && typeof r.text === 'string' && r.text.trim())
    .filter((r) => !Number(r.at) || Number(r.at) >= since)
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
    .slice(-max);
  if (!list.length) return '';
  return list.map((r) => {
    const label = String(r.channelLabel || r.channel || '对话');
    const who = r.role === 'assistant' ? '我' : (String(r.name || '').trim() || '主人');
    const text = String(r.text).replace(/\s+/g, ' ').trim().slice(0, 160);
    return `- [${label}] ${who}：${text}`;
  }).join('\n');
}

/** 多段记忆拼成一块，超出预算时按顺序裁剪更靠后的段。 */
export function mergeBlocks(blocks, max) {
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const body = String(block?.text ?? '').trim();
    if (!body) continue;
    const title = String(block?.title ?? '').trim();
    parts.push(title ? `【${title}】\n${body}` : body);
  }
  const merged = parts.join('\n\n');
  return clampText(merged, max);
}

/** 记忆卡 + 最近对话 + 身份 一起进 system prompt 时用；返回空串表示这次什么都没有。 */
export function buildInteropMemory({ qqPrompt = '', biliPrompt = '', recentText = '', identityText = '', config = {}, max = 0 } = {}) {
  const cfg = normalizeInterop(config);
  const blocks = [];
  if (cfg.identity && String(identityText || '').trim()) {
    blocks.push({ title: '身份', text: identityText });
  }
  if (recentText) blocks.push({ title: '最近在别处聊了什么', text: recentText });
  // 记忆卡放最后：它最长、最结构化，被裁时优先保住身份和最近对话。
  if (cfg.qq && String(qqPrompt || '').trim()) blocks.push({ title: '记忆卡', text: qqPrompt });
  if (cfg.bili && String(biliPrompt || '').trim()) blocks.push({ title: '记忆卡（B站）', text: biliPrompt });
  return mergeBlocks(blocks, max || cfg.memoryMaxChars);
}
