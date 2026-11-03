// 聊天全量存档：把每一条聊天原文按私聊/群聊分文件追加到备份目录。
// 和全量记忆卡不同，这里不压缩、不摘要、不删除，单文件超过上限就换新文件。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CHAT_ARCHIVE = Object.freeze({ enabled: true, maxFileMB: 16 });
const MAX_FILE_MB = 512;
const MAX_SEEN = 5000;
const CHANNELS = new Set(['qq', 'desktop-orb', 'companion']);

/**
 * 「数据类型」：每条存档除了 channel，还带一个给人看的中文来源标签和一个语义类型。
 *   悬浮窗会话 = orb-chat，陪伴字幕 = companion-subtitle，QQ = qq-message。
 * 这两列是 2026-11-03 加的（主人要求字幕/会话的对话也要有明确的数据类型），
 * 老记录没有它们，读的时候按 channel 现推。
 */
export const CHANNEL_LABELS = Object.freeze({
  qq: 'QQ',
  'desktop-orb': '悬浮窗',
  companion: '陪伴字幕',
});
export const MESSAGE_TYPES = Object.freeze({
  qq: 'qq-message',
  'desktop-orb': 'orb-chat',
  companion: 'companion-subtitle',
});

export function normalizeChannel(value) {
  const s = String(value || '').trim().toLowerCase();
  return CHANNELS.has(s) ? s : 'qq';
}

export function channelLabel(channel) {
  return CHANNEL_LABELS[normalizeChannel(channel)] || CHANNEL_LABELS.qq;
}

export function messageTypeOf(channel) {
  return MESSAGE_TYPES[normalizeChannel(channel)] || MESSAGE_TYPES.qq;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizeChatArchiveConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    maxFileMB: clampInt(src.maxFileMB, 1, MAX_FILE_MB, DEFAULT_CHAT_ARCHIVE.maxFileMB),
  };
}

export function safeCharacterId(id) {
  const s = String(id == null ? '' : id).trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  return s || 'unknown';
}

export function chatArchiveRoot({ baseDir, characterId } = {}) {
  return path.join(String(baseDir || ''), 'chat', safeCharacterId(characterId));
}

function pad4(n) {
  return String(n).padStart(4, '0');
}

function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function localIso(ts) {
  const d = new Date(ts);
  const off = -d.getTimezoneOffset();
  if (!off) return d.toISOString();
  const sign = off > 0 ? '+' : '-';
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const base = new Date(d.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${base}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

export function listChatArchiveFiles(root) {
  const out = { private: [], group: [] };
  for (const kind of ['private', 'group']) {
    const dir = path.join(root, kind);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    const files = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        files.push({ kind, name, path: file, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch { /* 单个坏文件不影响其他文件 */ }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    out[kind] = files;
  }
  return out;
}

function summarizeKind(files) {
  let bytes = 0;
  for (const f of files) bytes += f.bytes;
  return {
    files: files.length,
    bytes,
    current: files.length ? files[files.length - 1].path : '',
  };
}

export function chatArchiveStatus(root, config = {}) {
  const cfg = normalizeChatArchiveConfig(config);
  const files = listChatArchiveFiles(root || '');
  const priv = summarizeKind(files.private);
  const group = summarizeKind(files.group);
  return {
    enabled: cfg.enabled,
    dir: root || '',
    maxFileMB: cfg.maxFileMB,
    private: priv,
    group,
    totalBytes: priv.bytes + group.bytes,
    lastError: '',
  };
}

function hashText(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function pickMessageId(event) {
  const v = event && (event.message_id != null ? event.message_id
    : event.msg_id != null ? event.msg_id
      : event.message_seq != null ? event.message_seq : '');
  return v == null ? '' : String(v);
}

function cleanMedia(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 8).map((m) => {
    const src = m && typeof m === 'object' ? m : {};
    return {
      kind: String(src.kind || src.type || '').slice(0, 24),
      file: String(src.file || src.fileName || src.path || '').slice(0, 300),
      url: String(src.url || '').slice(0, 500),
      name: String(src.name || '').slice(0, 120),
    };
  }).filter((m) => m.kind || m.file || m.url);
}

export function classifyType(types, media) {
  const kinds = media.map((m) => m.kind.toLowerCase());
  const has = (k) => kinds.includes(k);
  if (media.length > 1) return 'mixed';
  if (has('image')) return 'image';
  if (has('sticker') || has('mface')) return 'sticker';
  if (has('face')) return 'face';
  if (has('voice') || has('record')) return 'voice';
  if (has('video')) return 'video';
  if (has('file')) return 'file';
  if (has('forward')) return 'forward';
  if (has('card') || has('json')) return 'card';
  if (types.includes('image')) return 'image';
  if (types.includes('mface') || types.includes('face')) return 'sticker';
  if (types.includes('record')) return 'voice';
  if (types.includes('video')) return 'video';
  if (types.includes('file')) return 'file';
  if (types.includes('forward')) return 'forward';
  if (types.includes('json') || types.includes('xml')) return 'card';
  if (types.some((t) => t && t !== 'text' && t !== 'reply')) return 'mixed';
  return 'text';
}

export function createChatArchiveWriter({
  getBaseDir,
  getCharacterId,
  getConfig,
  now = Date.now,
  maxFileBytes,
} = {}) {
  let lastError = '';
  let lastErrorAt = 0;
  const seen = new Map();

  function readConfig() {
    let raw = {};
    try { raw = typeof getConfig === 'function' ? (getConfig() || {}) : {}; } catch { raw = {}; }
    return normalizeChatArchiveConfig(raw && raw.archive ? raw.archive : {});
  }

  function remember(key) {
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.set(key, 1);
    if (seen.size > MAX_SEEN) {
      const first = seen.keys().next().value;
      seen.delete(first);
    }
    return true;
  }

  function effectiveMaxBytes(cfg) {
    if (Number.isFinite(maxFileBytes) && maxFileBytes > 0) return Math.floor(maxFileBytes);
    return Math.max(1, cfg.maxFileMB) * 1024 * 1024;
  }

  function resolveFile(dir, maxBytes, bytes, ts) {
    const day = localDay(ts);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort(); } catch { names = []; }
    const latest = names.length ? names[names.length - 1] : '';
    let seq = 0;
    let current = '';
    if (latest) {
      const m = latest.match(/^(\d{4}-\d{2}-\d{2})_(\d+)\.jsonl$/);
      if (m && m[1] === day) {
        seq = Number(m[2]) || 0;
        current = path.join(dir, latest);
      }
    }
    if (!current) {
      seq = 0;
      while (fs.existsSync(path.join(dir, `${day}_${pad4(seq + 1)}.jsonl`))) seq++;
      return path.join(dir, `${day}_${pad4(seq + 1)}.jsonl`);
    }
    let size = 0;
    try { size = fs.statSync(current).size; } catch { size = 0; }
    if (size > 0 && size + bytes > maxBytes) {
      seq += 1;
      while (fs.existsSync(path.join(dir, `${day}_${pad4(seq)}.jsonl`))) seq++;
      return path.join(dir, `${day}_${pad4(seq)}.jsonl`);
    }
    return current;
  }

  function writeRecord(kind, key, id, record) {
    const cfg = readConfig();
    if (!cfg.enabled) return null;
    let baseDir = '';
    try { baseDir = String(typeof getBaseDir === 'function' ? getBaseDir() || '' : ''); } catch { baseDir = ''; }
    if (!baseDir.trim()) return null;
    let characterId = '';
    try { characterId = String(typeof getCharacterId === 'function' ? getCharacterId() || '' : ''); } catch { characterId = ''; }
    const root = chatArchiveRoot({ baseDir, characterId });
    const dir = path.join(root, kind);
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = resolveFile(dir, effectiveMaxBytes(cfg), bytes, record.at || now());
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
      lastError = '';
      return { ok: true, file, bytes, kind, key, id };
    } catch (err) {
      lastError = String(err && err.message ? err.message : err).slice(0, 300);
      lastErrorAt = now();
      return { ok: false, error: lastError };
    }
  }

  // schema 2 的通用写入口：QQ 入站/出站和桌宠/字幕都走这里。
  // channel 区分消息来源，kind 仍只表示私聊/群聊；桌宠/字幕固定写 private。
  function appendRecord(input = {}) {
    const src = input && typeof input === 'object' ? input : {};
    const convKind = src.kind === 'group' ? 'group' : 'private';
    const conversation = src.conversation && typeof src.conversation === 'object' ? src.conversation : {};
    const convKey = String(src.key || conversation.key || '').trim();
    if (!convKey) return null;
    const body = String(src.text == null ? '' : src.text).trim();
    const media = cleanMedia(src.media);
    if (!body && !media.length) return null;
    if (body.startsWith('/')) return null;

    const ts = Number.isFinite(Number(src.at)) ? Number(src.at) : now();
    const channel = normalizeChannel(src.channel);
    const sender = src.sender && typeof src.sender === 'object' ? src.sender : {};
    const recordId = String(src.id || `${channel}:${convKey}:${ts}:${hashText(body)}`);
    if (!remember(`rec:${channel}:${convKind}:${recordId}`)) return null;

    let convId = String(conversation.id || '');
    if (!convId && convKey.startsWith(`${convKind}:`)) convId = convKey.slice(convKind.length + 1);
    const types = Array.isArray(src.types) ? src.types.map((t) => String(t || '')).filter(Boolean) : [];
    const record = {
      schema: 2,
      id: recordId,
      at: ts,
      time: localIso(ts),
      platform: String(src.platform || (channel === 'qq' ? 'qq' : 'desktop')),
      channel,
      channelLabel: channelLabel(channel),
      messageType: messageTypeOf(channel),
      kind: convKind,
      conversation: { key: convKey, id: convId, name: String(conversation.name || '') },
      sender: {
        id: String(sender.id || ''),
        name: String(sender.name || ''),
        isOwner: !!sender.isOwner,
        isSelf: !!sender.isSelf,
      },
      messageId: String(src.messageId || ''),
      type: String(src.type || classifyType(types, media)),
      types,
      text: body.slice(0, 20000),
      reply: src.reply && typeof src.reply === 'object' ? src.reply : null,
      media,
    };
    return writeRecord(convKind, convKey, record.messageId || recordId, record);
  }

  function appendIncoming({ key, kind, id, event, plainContent, textContent, isOwner, quoteTargetIsSelf, media, at } = {}) {
    const convKey = String(key || (event && event.key) || '').trim();
    if (!convKey) return null;
    const convKind = kind === 'group' ? 'group' : 'private';
    const ev = event && typeof event === 'object' ? event : {};
    const messageId = pickMessageId(ev);
    const ts = Number.isFinite(at) ? Number(at) : now();
    const dedupe = `in:${convKind}:${convKey}:${messageId || ts}`;
    if (!remember(dedupe)) return null;

    const mediaClean = cleanMedia(media);
    const text = String(plainContent != null ? plainContent : (textContent != null ? textContent : '')).trim();
    if (!text && !mediaClean.length) return null;
    if (text.startsWith('/')) return null;

    const segments = Array.isArray(ev.message) ? ev.message : [];
    const types = segments.map((s) => String((s && s.type) || '')).filter(Boolean);
    const replySeg = segments.find((s) => s && s.type === 'reply');
    const sender = ev.sender && typeof ev.sender === 'object' ? ev.sender : {};
    const senderId = String(ev.user_id != null ? ev.user_id : (sender.user_id != null ? sender.user_id : ''));
    const senderName = String(sender.card || sender.nickname || senderId || '');
    const convName = convKind === 'group'
      ? String(ev.group_name || ev.groupName || '')
      : String(sender.card || sender.nickname || (isOwner ? '主人' : ''));
    // 私聊的会话 id 是对方 QQ，不是 "private:xxx" 这个内部 key；群聊才是 group_id。
    const convId = convKind === 'group'
      ? String(ev.group_id != null ? ev.group_id : '')
      : String(ev.user_id != null ? ev.user_id : '');
    const record = {
      schema: 2,
      id: String(id || `${convKey}:${messageId || ts}`),
      at: ts,
      time: localIso(ts),
      platform: 'qq',
      channel: 'qq',
      kind: convKind,
      conversation: { key: convKey, id: convId, name: convName },
      sender: { id: senderId, name: senderName, isOwner: !!isOwner, isSelf: false },
      messageId,
      type: classifyType(types, mediaClean),
      types,
      text: text.slice(0, 20000),
      reply: replySeg ? {
        messageId: String(replySeg.data && replySeg.data.id != null ? replySeg.data.id : ''),
        toSelf: !!quoteTargetIsSelf,
      } : null,
      media: mediaClean,
    };
    if (typeof id !== 'string' || !id) record.id = `${convKey}:${messageId || ts}`;
    return writeRecord(convKind, convKey, messageId || record.id, record);
  }

  function appendOutgoing({ key, kind, id, text, name, at } = {}) {
    const convKey = String(key || '').trim();
    if (!convKey) return null;
    const body = String(text == null ? '' : text).trim();
    if (!body || body.startsWith('/')) return null;
    // 出站调用点有时只给 key（sendMessagesV2 / auditAndSend），这里自己从 key 推。
    const convKind = kind === 'group' || (!kind && convKey.startsWith('group:')) ? 'group' : 'private';
    let ts = Number.isFinite(at) ? Number(at) : now();
    if (ts > 0 && ts < 1e12) ts *= 1000;
    const recordId = String(id || `out:${convKey}:${ts}:${hashText(body)}`);
    if (!remember(`out:${convKind}:${recordId}`)) return null;
    const senderName = String(name || '');
    const convId = convKey.startsWith(`${convKind}:`) ? convKey.slice(convKind.length + 1) : '';
    const record = {
      schema: 2,
      id: recordId,
      at: ts,
      time: localIso(ts),
      platform: 'qq',
      channel: 'qq',
      channelLabel: channelLabel('qq'),
      messageType: messageTypeOf('qq'),
      kind: convKind,
      conversation: { key: convKey, id: convId, name: String(name || '') },
      sender: { id: '', name: senderName, isOwner: false, isSelf: true },
      messageId: '',
      type: 'text',
      types: ['text'],
      text: body.slice(0, 20000),
      reply: null,
      media: [],
    };
    return writeRecord(convKind, convKey, recordId, record);
  }

  function status() {
    const cfg = readConfig();
    let root = '';
    try {
      const baseDir = String(typeof getBaseDir === 'function' ? getBaseDir() || '' : '');
      if (baseDir.trim()) {
        const characterId = String(typeof getCharacterId === 'function' ? getCharacterId() || '' : '');
        root = chatArchiveRoot({ baseDir, characterId });
      }
    } catch { root = ''; }
    const st = root ? chatArchiveStatus(root, cfg) : chatArchiveStatus('', cfg);
    return { ...st, enabled: cfg.enabled, lastError, lastErrorAt };
  }

  return { appendRecord, appendIncoming, appendOutgoing, status };
}

/**
 * 从存档里读「最近的对话」——给悬浮窗会话/陪伴字幕当跨端上下文用。
 * 只读文件尾部（单个 jsonl 最多几十 MB，整读会拖慢每一轮聊天），
 * 返回按时间升序的记录数组；坏行直接跳过。
 */
export function readRecentChatRecords(root, { sinceMs = 0, limit = 40, tailBytes = 256 * 1024 } = {}) {
  const max = Math.max(1, Math.min(200, Number(limit) || 40));
  const since = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : 0;
  const files = listChatArchiveFiles(root || '');
  const all = [...files.private, ...files.group].sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  for (let i = all.length - 1; i >= 0 && out.length < max; i -= 1) {
    const file = all[i];
    let text = '';
    let cut = false;
    try {
      const start = Math.max(0, file.bytes - Math.max(4096, Number(tailBytes) || 0));
      cut = start > 0;
      const fd = fs.openSync(file.path, 'r');
      try {
        const buf = Buffer.alloc(Math.min(file.bytes - start, 1 << 20));
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { continue; }
    // 从文件中间开始读时，第一行大概率被切了一半，直接丢掉。
    const lines = text.split('\n');
    if (cut && lines.length) lines.shift();
    for (let j = lines.length - 1; j >= 0 && out.length < max; j -= 1) {
      const line = lines[j].trim();
      if (!line) continue;
      let record = null;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== 'object') continue;
      const at = Number(record.at) || 0;
      if (since && at && at < since) return out.reverse();
      out.push({
        at,
        time: String(record.time || ''),
        channel: normalizeChannel(record.channel),
        channelLabel: record.channelLabel || channelLabel(record.channel),
        messageType: record.messageType || messageTypeOf(record.channel),
        role: record.sender && record.sender.isSelf ? 'assistant' : 'user',
        name: String(record.sender && record.sender.name ? record.sender.name : ''),
        text: String(record.text || '').trim(),
      });
    }
  }
  return out.reverse();
}

