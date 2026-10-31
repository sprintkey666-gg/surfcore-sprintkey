// 日记：本地 Markdown + 可选私聊主人。
//
// 纯逻辑：配置归一化、到期判断、prompt、正文清洗、Markdown 追加、尾部预览、状态读写。
// 真正的模型调用、QQ 发送、定时器都在 bridge.js。

import fs from 'node:fs';
import path from 'node:path';

export const DAY_MS = 86_400_000;

export const DEFAULT_DIARY_CONFIG = Object.freeze({
  enabled: false,
  dir: '',
  everyDays: 1,
  hour: 22,
  maxChars: 1200,
  send: { enabled: false, withFile: true },
});

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeDiaryConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const send = isPlainObject(src.send) ? src.send : {};
  return {
    enabled: src.enabled === true,
    dir: String(src.dir ?? '').trim().slice(0, 500),
    everyDays: num(src.everyDays, DEFAULT_DIARY_CONFIG.everyDays, 1, 30),
    hour: num(src.hour, DEFAULT_DIARY_CONFIG.hour, 0, 23),
    maxChars: num(src.maxChars, DEFAULT_DIARY_CONFIG.maxChars, 200, 5000),
    send: {
      enabled: send.enabled === true,
      withFile: send.withFile !== false,
    },
  };
}

export function diaryBaseDir(dshHome, customDir = '') {
  const custom = String(customDir ?? '').trim();
  if (custom) return path.resolve(custom);
  return path.join(String(dshHome || ''), 'surfcore', 'diary');
}

export function diaryFileFor({ dshHome, dir = '', characterId = 'default' }) {
  const safeId = String(characterId || 'default').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'default';
  return path.join(diaryBaseDir(dshHome, dir), `${safeId}.md`);
}

function hourReached(nowMs, hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return true;
  return new Date(nowMs).getHours() >= h;
}

/**
 * 是否该写今天的日记。
 * - 第一次：到了 hour 才写；如果已经逾期超过 24 小时（关过机），任何时间补一次。
 * - 之后：距上次写满 N 天，并且到了 hour；逾期超过 24 小时则立即补。
 */
export function isDiaryDue({ lastWriteAt, everyDays = 1, hour = 22, now = Date.now() }) {
  const nowMs = Number(now);
  const days = Math.max(1, Number(everyDays) || 1);
  const last = Number(lastWriteAt) || 0;
  if (!last) {
    return hourReached(nowMs, hour)
      ? { due: true, reason: 'first' }
      : { due: false, reason: 'hour' };
  }
  const dueAt = last + days * DAY_MS;
  if (nowMs < dueAt) return { due: false, reason: 'interval' };
  if (!hourReached(nowMs, hour) && nowMs - dueAt < DAY_MS) return { due: false, reason: 'hour' };
  return { due: true, reason: 'interval' };
}

export function buildDiaryPrompt({
  characterName,
  persona,
  context,
  maxChars = 1200,
  now = Date.now(),
}) {
  const name = String(characterName || '我').trim();
  const when = new Date(now).toLocaleString('zh-CN', { hour12: false });
  return [
    `你是「${name}」，现在是 ${when}。`,
    persona ? `你的人物设定（节选）：${String(persona).replace(/\s+/g, ' ').trim().slice(0, 900)}` : '',
    '今天你看到的、聊到的事（只作素材，禁止原句照抄，禁止写昵称、QQ 号、链接、路径）：',
    String(context ?? '').replace(/\s+/g, ' ').trim().slice(0, 2600) || '（今天比较安静，没发生什么特别的事）',
    `请写一篇今天的日记，第一人称，200~${Math.max(200, Math.min(800, maxChars))} 字。`,
    '要求：像真的写给自己的日记，不是汇报；可以写心情、想法、小细节；不点名任何人；不写网址、QQ 号、文件路径；不要标题、不要列表、不要 markdown。',
    '直接输出日记正文。',
  ].filter(Boolean).join('\n');
}

function stripCodeFence(text) {
  let value = String(text ?? '').trim();
  const fence = value.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  if (fence) value = fence[1].trim();
  return value;
}

export function cleanDiaryText(text, maxChars = 1200) {
  let value = stripCodeFence(text)
    .replace(/^日记[：:]\s*/i, '')
    .replace(/^#+\s*/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  const limit = Math.max(200, Number(maxChars) || 1200);
  if (value.length > limit) {
    const cut = value.slice(0, limit);
    const lastStop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'));
    value = (lastStop > limit * 0.6 ? cut.slice(0, lastStop + 1) : cut).trim();
  }
  return value;
}

export function formatDiaryEntry(now, text) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const weekday = WEEKDAYS[d.getDay()] ?? '';
  return `## ${date} ${weekday} ${pad(d.getHours())}:${pad(d.getMinutes())}\n\n${String(text ?? '').trim()}\n`;
}

export function appendDiaryEntry(file, entry) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let prefix = '';
  try {
    const stat = fs.statSync(file);
    if (stat.size > 0) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(2);
        fs.readSync(fd, buf, 0, 2, Math.max(0, stat.size - 2));
        prefix = buf.toString('utf8').endsWith('\n\n') ? '' : (buf.toString('utf8').endsWith('\n') ? '\n' : '\n\n');
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    prefix = '';
  }
  const body = `${prefix}${String(entry ?? '').trimEnd()}\n\n`;
  fs.appendFileSync(file, body, 'utf8');
  return { file, bytes: Buffer.byteLength(body) };
}

export function readDiaryTail(file, maxChars = 2000) {
  try {
    const stat = fs.statSync(file);
    if (!stat.size) return '';
    const limit = Math.max(200, Number(maxChars) || 2000);
    const readBytes = Math.min(stat.size, Math.max(limit * 3, 8192));
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
      return buf.toString('utf8').slice(-limit);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export function diaryStateFile(dshHome) {
  return path.join(String(dshHome || ''), 'surfcore', 'diary-state.json');
}

export function readDiaryState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeDiaryState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state ?? {}, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function characterDiaryState(state, characterId) {
  const root = isPlainObject(state) ? state : {};
  const id = String(characterId || 'default');
  if (!isPlainObject(root.characters)) root.characters = {};
  if (!isPlainObject(root.characters[id])) root.characters[id] = {};
  return root.characters[id];
}
