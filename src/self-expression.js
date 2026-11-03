// 自我表达：QQ 个性签名 / QQ 空间动态。
//
// 这里是纯逻辑：配置归一化、到期判断、prompt 构造、回复解析、内容清洗、状态读写。
// 真正调模型、改签名、发说说、写日志都由 bridge.js 负责（它才拿得到 API 与 QQ 连接）。
//
// 为什么「温度」不是采样参数：DSH 的 sessions.prompt 只接受
// { sessionId, mode:'queue'|'steer', content }，没有 temperature 入口；
// 所以 temperature 在这里只是一个「表达欲」旋钮，会写进 prompt，
// 影响 AI 决不决定发、发得多随性，不影响模型采样温度。

import fs from 'node:fs';
import path from 'node:path';

export const DAY_MS = 86_400_000;
export const SELF_EXPRESSION_MODES = ['off', 'auto', '1d', '3d', '7d'];
const MODE_DAYS = { '1d': 1, '3d': 3, '7d': 7 };

export const DEFAULT_SELF_EXPRESSION = Object.freeze({
  signature: { mode: 'off', temperature: 0.5, hour: 20, maxChars: 40 },
  qzone: { mode: 'off', temperature: 0.5, hour: 20, visibility: 4, maxChars: 300 },
});

const QZONE_VISIBILITIES = new Set([1, 4, 64]);

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function numFloat(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeItem(input, kind) {
  const src = isPlainObject(input) ? input : {};
  const fallback = DEFAULT_SELF_EXPRESSION[kind];
  const mode = SELF_EXPRESSION_MODES.includes(src.mode) ? src.mode : fallback.mode;
  const maxChars = kind === 'signature'
    ? num(src.maxChars, fallback.maxChars, 10, 60)
    : num(src.maxChars, fallback.maxChars, 20, 500);
  const item = {
    mode,
    temperature: Math.round(numFloat(src.temperature, fallback.temperature, 0, 1) * 10) / 10,
    hour: num(src.hour, fallback.hour, 0, 23),
    maxChars,
  };
  if (kind === 'qzone') {
    item.visibility = QZONE_VISIBILITIES.has(Number(src.visibility)) ? Number(src.visibility) : fallback.visibility;
  }
  return item;
}

export function normalizeSelfExpressionConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    signature: normalizeItem(src.signature, 'signature'),
    qzone: normalizeItem(src.qzone, 'qzone'),
  };
}

export function selfModeDays(mode) {
  return MODE_DAYS[String(mode ?? '')] ?? 0;
}

export function selfModeLabel(mode) {
  return ({ off: '关闭', auto: '自动', '1d': '每 1 天', '3d': '每 3 天', '7d': '每 7 天' })[mode] ?? '关闭';
}

function hourReached(nowMs, hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return true;
  return new Date(nowMs).getHours() >= h;
}

/**
 * 判断某一项（signature/qzone）现在是否该执行。
 * - off：不清
 * - auto：每天 hour 后检查一次；上次检查距今不足 20 小时就跳过
 * - 1d/3d/7d：距上次执行满 N 天，且到了当天 hour；如果已经逾期超过 24 小时，则任何时间都补一次
 * - force：手动按钮，直接执行
 * @returns {{due:boolean, reason?:string}}
 */
export function selfExpressionDue({ mode, lastAt, lastCheckAt, hour, now = Date.now(), force = false }) {
  if (force) return { due: true, reason: 'force' };
  if (!SELF_EXPRESSION_MODES.includes(mode) || mode === 'off') return { due: false, reason: 'off' };
  const nowMs = Number(now);
  if (mode === 'auto') {
    const lastCheck = Number(lastCheckAt) || 0;
    if (lastCheck && nowMs - lastCheck < 20 * 3600_000) return { due: false, reason: 'checked' };
    if (!hourReached(nowMs, hour) && (!lastCheck || nowMs - lastCheck < DAY_MS)) {
      return { due: false, reason: 'hour' };
    }
    return { due: true, reason: 'auto' };
  }
  const days = selfModeDays(mode);
  const last = Number(lastAt) || 0;
  if (!last) {
    return hourReached(nowMs, hour) ? { due: true, reason: 'first' } : { due: false, reason: 'hour' };
  }
  const dueAt = last + days * DAY_MS;
  if (nowMs < dueAt) return { due: false, reason: 'interval' };
  if (!hourReached(nowMs, hour) && nowMs - dueAt < DAY_MS) return { due: false, reason: 'hour' };
  return { due: true, reason: 'interval' };
}

function trimText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max).trim();
}

/**
 * 生成自我表达 prompt。要求模型只回一个 JSON；fixed 模式要求必须写内容，
 * auto 模式允许 skip。
 */
export function buildExpressionPrompt({
  kind,
  characterName,
  persona,
  context,
  current,
  mode = 'auto',
  temperature = 0.5,
  maxChars = 40,
  now = Date.now(),
}) {
  const name = String(characterName || '我').trim();
  const when = new Date(now).toLocaleString('zh-CN', { hour12: false });
  const auto = mode === 'auto';
  const kindLabel = kind === 'signature' ? 'QQ 个性签名' : 'QQ 空间说说';
  const lengthHint = kind === 'signature'
    ? `${Math.max(4, Math.min(20, maxChars))}~${maxChars} 个字，只写一行`
    : `80~${maxChars} 个字，一段话`;
  const temp = Math.round(Number(temperature) * 10) / 10;
  const currentLine = kind === 'signature'
    ? `当前签名：${current ? `「${current}」` : '（空）'}`
    : `上次说说：${current ? `「${current}」` : '（还没发过）'}`;
  const actionLine = auto
    ? '如果你觉得现在没什么想说的、或者今天没有值得发的事，就 skip；不要为了发而发。'
    : '这是固定档位，到了该发的时间，请写一条，不要 skip。';
  return [
    `你是「${name}」，现在 ${when}。`,
    persona ? `你的人物设定（节选）：${trimText(persona, 900)}` : '',
    '最近聊天（只是素材，禁止引用原句、昵称、QQ 号、链接或任何路径）：',
    trimText(context, 2600) || '（最近没有特别的聊天）',
    currentLine,
    `请写一条${kindLabel}，${lengthHint}。`,
    `表达欲温度 ${temp.toFixed(1)}（0=克制，1=很想表达）：温度越高，你越愿意为小事写；温度低时只在确实重要/特别的事发生时才写。`,
    actionLine,
    '内容要求：第一人称、自然、不油腻；不点名任何人；不透露私聊内容；不写网址、QQ 号、文件路径。',
    '只输出 JSON，不要 markdown、不要解释。格式：',
    '{"action":"post","text":"要发布的内容","reason":"一句话原因"}',
    '或：{"action":"skip","reason":"一句话"}',
  ].filter(Boolean).join('\n');
}

function stripCodeFence(text) {
  let value = String(text ?? '').trim();
  const fence = value.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  if (fence) value = fence[1].trim();
  return value;
}

function firstBalancedObject(value) {
  const start = value.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return value.slice(start, i + 1);
    }
  }
  return null;
}

function extractJsonObject(text) {
  const value = stripCodeFence(text);
  const candidates = [value];
  // 模型偶尔把整个 JSON 再包成一层 JSON 字符串（\"action\" 这种），先解开外层。
  try {
    const unwrapped = JSON.parse(value);
    if (typeof unwrapped === 'string' && unwrapped.trim() !== value) candidates.push(unwrapped);
  } catch {}
  for (const candidate of candidates) {
    const slice = firstBalancedObject(candidate);
    if (!slice) continue;
    for (const attempt of [slice, slice.replace(/\\"/g, '"')]) {
      try {
        const parsed = JSON.parse(attempt);
        if (isPlainObject(parsed)) return parsed;
      } catch {}
    }
  }
  return null;
}

function looksLikeJsonEnvelope(text) {
  const value = String(text ?? '').trim();
  return /^[\[{]/.test(value) || /"action"\s*:/.test(value);
}

/**
 * 解析模型回复。优先当作 JSON；如果模型无视格式直接写了正文，也按 post 处理，
 * 免得一次格式抖动就把整次表达吞掉。
 */
export function parseExpressionDecision(text) {
  const raw = String(text ?? '').trim();
  const obj = extractJsonObject(raw);
  if (obj) {
    const action = String(obj.action ?? '').trim().toLowerCase() === 'skip' ? 'skip' : 'post';
    const content = String(obj.text ?? obj.content ?? '').trim();
    if (action === 'skip') return { action: 'skip', text: '', reason: String(obj.reason ?? '') };
    if (!content) return { action: 'skip', text: '', reason: String(obj.reason ?? 'empty') };
    return { action: 'post', text: content, reason: String(obj.reason ?? '') };
  }
  if (!raw) return { action: 'skip', text: '', reason: 'empty' };
  if (looksLikeJsonEnvelope(raw)) return { action: 'skip', text: '', reason: 'unparsed-json' };
  return { action: 'post', text: raw, reason: 'plain-text' };
}

/**
 * 清洗发布内容：去链接、QQ 号、@、路径、代码块、媒体占位；压成单段。
 * 这是最后一道防线，prompt 里已经要求过一遍。
 */
export function sanitizeExpressionText(text, kind = 'signature', maxChars = 40) {
  let value = stripCodeFence(text)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/file:\/\/\/?\S+/gi, '')
    .replace(/[A-Za-z]:\\[^\s，。；、]+/g, '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '')
    .replace(/@\S+/g, '')
    .replace(/\[(图片|表情|语音|视频|文件|转发消息)\]/g, '')
    .replace(/\b\d{5,12}\b/g, '')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\s*\n+\s*/g, kind === 'qzone' ? ' ' : ' ')
    .trim();
  value = value.replace(/^["'“”‘’「」《》]+|["'“”‘’「」《》]+$/g, '').trim();
  const limit = Math.max(1, Number(maxChars) || 40);
  if (value.length > limit) value = value.slice(0, limit).trim();
  return value;
}

export function selfExpressionStateFile(dshHome) {
  return path.join(String(dshHome || ''), 'surfcore', 'self-expression-state.json');
}

export function readSelfExpressionState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSelfExpressionState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state ?? {}, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function characterExpressionState(state, characterId) {
  const root = isPlainObject(state) ? state : {};
  const id = String(characterId || 'default');
  if (!isPlainObject(root.characters)) root.characters = {};
  if (!isPlainObject(root.characters[id])) root.characters[id] = {};
  const st = root.characters[id];
  if (!isPlainObject(st.signature)) st.signature = {};
  if (!isPlainObject(st.qzone)) st.qzone = {};
  return st;
}
