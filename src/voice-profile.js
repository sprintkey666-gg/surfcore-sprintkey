// 声线档案（v6）：让 QQ 群聊和私聊是「同一个人」。
//
// 问题：buildWakePromptV2 的 base 只带【当前角色】名字，人设卡（语气/口癖/边界）
// 只有模型主动调 qq_get_prompt 才看得到 —— 私聊靠长期历史当 few-shot 还像人，
// 群聊一边刷规则一边没声线，就退化成客服腔。
//
// 这一层专门管"怎么说话"：人设锚（从角色卡抽的说话方式）+ 真实原话样本。
// 样本只从「本角色自己发出去的话」里挖，天然不含对方内容；渲染时还会再过一遍
// 隐私过滤，避免把路径/号码/链接带进群里。
//
// 状态落盘：<角色目录>/voice/voice-profile.json（随 activeMemoryPaths 惰性解析，切角色不串档）。

import fs from 'node:fs';
import path from 'node:path';
import { activeMemoryPaths, activePersonaFile } from './character-persona.js';
import { similarityOf } from './memory-store.js';

export const VOICE_VERSION = 1;
export const MAX_SAMPLES_KEPT = 200;

export const DEFAULT_VOICE_CONFIG = Object.freeze({
  enabled: true,
  maxSamples: 6,
  maxChars: 480,
  groupAnchor: true,
  autoMine: true,
  halfLifeDays: 30,
  // v7：对答样本（对方说X→你回Y）与末尾 gate。gate 默认只给群聊，私聊保持原样。
  pairs: true,
  tail: true,
  tailGroupOnly: true,
});

const MIN_TEXT = 2;
const MAX_TEXT = 60;

// 对答样本：一句"对方" + 一句"她"。超过这个长度就不是口语了。
const PAIR_MAX_ASK = 60;
const PAIR_MAX_REPLY = 40;
const MAX_PAIRS_KEPT = 60;

// 事务回执不是语气：这些句子采进来只会把她拉成"冷淡工具人"。
const BUSINESS_REPLY_RE = /^(?:写了|置顶了|改好了|弄好了|发完了|已发|好的|好嘞|收到|嗯+|行吧|稍等|我看看|ok|OK|已读)$/;

const HARD_RULES = [
  '别解释、别补背景、别总结；对方说一句就接一句。',
  '允许装傻、敷衍、已读乱回，不必有求必应。',
  '少用「保证/绝对/一绝/真管用」这类词。',
].join('\n');

// 一行样本里出现这些就别要：路径、链接、号码、邮箱、令牌、工具名。
const UNSAFE_PATTERNS = [
  /https?:\/\//i,
  /www\./i,
  /file:\/\//i,
  /[A-Za-z]:\\/,
  /(?:^|[\s(])\/[\w.-]+\/[\w.-]+/,
  /\d{6,}/,
  /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/,
  /\b(?:sk|ghp|Bearer|token|accessToken)\b/i,
  /\bqq_[a-z_]+/i,
  /mcp__[a-z_]+/i,
];

function clampText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function num(value, fallback, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

export function normalizeVoiceConfig(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: c.enabled !== false,
    maxSamples: num(c.maxSamples, DEFAULT_VOICE_CONFIG.maxSamples, 1, 10),
    maxChars: num(c.maxChars, DEFAULT_VOICE_CONFIG.maxChars, 120, 1200),
    groupAnchor: c.groupAnchor !== false,
    autoMine: c.autoMine !== false,
    halfLifeDays: num(c.halfLifeDays, DEFAULT_VOICE_CONFIG.halfLifeDays, 1, 365),
    pairs: c.pairs !== false,
    tail: c.tail !== false,
    tailGroupOnly: c.tailGroupOnly !== false,
  };
}

export function resolveVoiceProfilePaths() {
  const mem = activeMemoryPaths();
  const memoryDir = String(mem?.dir || '');
  const dir = memoryDir ? path.join(path.dirname(memoryDir), 'voice') : '';
  return {
    dir,
    file: dir ? path.join(dir, 'voice-profile.json') : '',
    persona: activePersonaFile(),
  };
}

function emptyProfile() {
  return { version: VOICE_VERSION, updatedAt: Date.now(), samples: [], pairs: [] };
}

function normalizePair(raw) {
  const ask = clampText(raw?.ask);
  const reply = clampText(raw?.reply);
  if (!ask || !reply) return null;
  return {
    id: String(raw.id || ''),
    ask,
    reply,
    weight: Math.min(3, Math.max(0.2, Number(raw.weight) || 1)),
    uses: Math.max(1, Number(raw.uses) || 1),
    createdAt: Number(raw.createdAt) || Date.now(),
    lastUsedAt: Number(raw.lastUsedAt) || Number(raw.createdAt) || Date.now(),
    sourceKey: String(raw.sourceKey || ''),
    disabled: raw.disabled === true,
  };
}

export function loadVoiceProfile(file) {
  const target = file || resolveVoiceProfilePaths().file;
  if (!target) return emptyProfile();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return emptyProfile();
  }
  const samples = (Array.isArray(raw?.samples) ? raw.samples : [])
    .map((s) => {
      const text = clampText(s?.text);
      if (!text || text.length < MIN_TEXT) return null;
      return {
        id: String(s.id || ''),
        text,
        tags: Array.isArray(s.tags) ? s.tags.slice(0, 6).map(String) : [],
        weight: Math.min(3, Math.max(0.2, Number(s.weight) || 1)),
        uses: Math.max(1, Number(s.uses) || 1),
        createdAt: Number(s.createdAt) || Date.now(),
        lastUsedAt: Number(s.lastUsedAt) || Number(s.createdAt) || Date.now(),
        sourceKey: String(s.sourceKey || ''),
        disabled: s.disabled === true,
      };
    })
    .filter(Boolean);
  const pairs = (Array.isArray(raw?.pairs) ? raw.pairs : []).map(normalizePair).filter(Boolean);
  return { version: VOICE_VERSION, updatedAt: Number(raw?.updatedAt) || Date.now(), samples, pairs };
}

function saveVoiceProfile(profile, file) {
  const paths = resolveVoiceProfilePaths();
  const target = file || paths.file;
  if (!target) return false;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    const body = JSON.stringify({
      version: VOICE_VERSION,
      updatedAt: Date.now(),
      samples: profile.samples,
      pairs: profile.pairs || [],
    }, null, 2);
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/** 把一条待入库的原话洗成可注入的样本；不合格返回 ''。 */
export function sanitizeSampleText(text) {
  let s = String(text || '');
  // 表情/工具标记不是"说话方式"，去掉。
  s = s.replace(/\[表情[:：][^\]]*\]/g, ' ');
  s = s.replace(/\[(?:图片|语音|视频|文件)\]/g, ' ');
  s = s.replace(/^[\s"“”'‘’]+|[\s"“”'‘’]+$/g, '');
  s = s.replace(/\*\*|__|~~/g, '');
  s = clampText(s);
  if (!s) return '';
  if (s.startsWith('/') || s.startsWith('!')) return '';
  if (/^(?:⚠️|❌|✅|⛔|·)/.test(s)) return '';
  if (/(失败|报错|请调用|桥接|SnowLuma|DSH 已就绪)/i.test(s)) return '';
  for (const re of UNSAFE_PATTERNS) if (re.test(s)) return '';
  const visible = s.replace(/[\p{P}\p{S}\s]/gu, '');
  if (visible.length < MIN_TEXT) return '';
  if (s.length > MAX_TEXT) return '';
  return s;
}

function guessTags(text) {
  const tags = [];
  const hit = (re, tag) => { if (re.test(text)) tags.push(tag); };
  hit(/[哼呵哦嗯行啊吧呢嘛啦呀哈]|哈哈|嘿嘿/, '口癖');
  hit(/无语|服了|救命|离谱|离谱|离谱/, '吐槽');
  hit(/滚|闭嘴|别闹|就这/, '怼');
  hit(/不想|懒得|摆了|摸鱼|躺/, '摆烂');
  hit(/可爱|喜欢|贴贴|抱抱/, '软');
  hit(/[?？]$/, '反问');
  return tags.slice(0, 4);
}

export function qualityFactor(text) {
  const t = String(text || '');
  if (!t) return 0.5;
  // 事务回执（"写了""置顶了"）不是语气，压低。
  if (BUSINESS_REPLY_RE.test(t)) return 0.3;
  let f = 1;
  const len = t.replace(/\s/g, '').length;
  if (len >= 4 && len <= 30) f *= 1.15;
  if (/(草|绝了|不是|啊？|\?|6|乐|典|难绷|离谱|服了|滚|行|真)/.test(t)) f *= 1.2;
  if (/^(?:[\p{P}\p{S}]+)$/u.test(t)) f *= 0.6;
  return f;
}

function gradeScore(sample, now, halfLifeDays) {
  const half = Math.max(1, Number(halfLifeDays) || 30) * 86400000;
  const base = Math.max(0, now - (Number(sample.lastUsedAt) || Number(sample.createdAt) || now));
  const decay = 0.5 ** (base / half);
  const uses = Math.max(1, Number(sample.uses) || 1) ** 0.3;
  const weight = Math.min(3, Math.max(0.2, Number(sample.weight) || 1));
  return uses * decay * weight * qualityFactor(sample.text);
}

function trimProfile(profile, now) {
  if (profile.samples.length <= MAX_SAMPLES_KEPT) return;
  const scored = profile.samples
    .map((s) => ({ s, score: gradeScore(s, now, DEFAULT_VOICE_CONFIG.halfLifeDays) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SAMPLES_KEPT)
    .map((x) => x.s);
  profile.samples = scored;
}

/** 挖一条样本（同义句只强化不重复写入）。 */
export function mineSample(text, meta = {}, file) {
  const clean = sanitizeSampleText(text);
  if (!clean) return { ok: false, reason: 'unsuitable' };
  const now = Number(meta.now) || Date.now();
  const profile = loadVoiceProfile(file);
  const hit = profile.samples.find((s) => similarityOf(clean, s.text) >= 0.8);
  if (hit) {
    hit.uses += 1;
    hit.lastUsedAt = now;
    hit.weight = Math.min(3, hit.weight + 0.1);
    saveVoiceProfile(profile, file);
    return { ok: true, deduped: true, id: hit.id };
  }
  const sample = {
    id: `v${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: clean,
    tags: Array.isArray(meta.tags) && meta.tags.length ? meta.tags.slice(0, 5).map(String) : guessTags(clean),
    weight: Math.min(3, Math.max(0.2, Number(meta.weight) || 1)),
    uses: 1,
    createdAt: now,
    lastUsedAt: now,
    sourceKey: String(meta.sourceKey || ''),
    disabled: false,
  };
  profile.samples.push(sample);
  trimProfile(profile, now);
  saveVoiceProfile(profile, file);
  return { ok: true, id: sample.id };
}

export function disableSample(id, disabled = true, file) {
  const profile = loadVoiceProfile(file);
  const hit = profile.samples.find((s) => s.id === String(id));
  if (!hit) return { ok: false, reason: 'not-found' };
  hit.disabled = disabled !== false;
  saveVoiceProfile(profile, file);
  return { ok: true, id: hit.id, disabled: hit.disabled };
}

/** 挖一组对答：ask=对方那句话，reply=她回的那句。 */
export function minePair(ask, reply, meta = {}, file) {
  const a = sanitizeSampleText(ask);
  const r = sanitizeSampleText(reply);
  if (!a || !r) return { ok: false, reason: 'unsuitable' };
  if (a.length > PAIR_MAX_ASK || r.length > PAIR_MAX_REPLY) return { ok: false, reason: 'too-long' };
  if (BUSINESS_REPLY_RE.test(r)) return { ok: false, reason: 'business' };
  const now = Number(meta.now) || Date.now();
  const profile = loadVoiceProfile(file);
  if (!Array.isArray(profile.pairs)) profile.pairs = [];
  const hit = profile.pairs.find((x) => x.reply === r || similarityOf(r, x.reply) >= 0.85);
  if (hit) {
    hit.uses += 1;
    hit.lastUsedAt = now;
    hit.weight = Math.min(3, hit.weight + 0.1);
    saveVoiceProfile(profile, file);
    return { ok: true, deduped: true, id: hit.id };
  }
  const pair = {
    id: `p${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ask: a,
    reply: r,
    weight: Math.min(3, Math.max(0.2, Number(meta.weight) || 1)),
    uses: 1,
    createdAt: now,
    lastUsedAt: now,
    sourceKey: String(meta.sourceKey || ''),
    disabled: false,
  };
  profile.pairs.push(pair);
  if (profile.pairs.length > MAX_PAIRS_KEPT) {
    profile.pairs = profile.pairs
      .map((x) => ({ x, score: gradeScore(x, now, DEFAULT_VOICE_CONFIG.halfLifeDays) }))
      .sort((m, n) => n.score - m.score)
      .slice(0, MAX_PAIRS_KEPT)
      .map((y) => y.x);
  }
  saveVoiceProfile(profile, file);
  return { ok: true, id: pair.id };
}

/** 从一段按时间排好的消息里配对：连续的非自己消息（取最后一条）→ 紧接着自己的那句。 */
export function minePairsFromMessages(messages, meta = {}, file) {
  const list = (Array.isArray(messages) ? messages : [])
    .map((m) => ({ isSelf: m?.isSelf === true, text: clampText(m?.text) }))
    .filter((m) => m.text);
  let added = 0;
  for (let i = 1; i < list.length; i += 1) {
    const cur = list[i];
    if (!cur.isSelf) continue;
    let askText = '';
    for (let j = i - 1; j >= 0; j -= 1) {
      if (list[j].isSelf) break;
      askText = list[j].text;
    }
    if (!askText) continue;
    const r = minePair(askText, cur.text, { ...meta }, file);
    if (r.ok && !r.deduped) added += 1;
  }
  return added;
}

export function listPairs(file) {
  const profile = loadVoiceProfile(file);
  const now = Date.now();
  return (profile.pairs || [])
    .map((x) => ({ ...x, score: Number(gradeScore(x, now, DEFAULT_VOICE_CONFIG.halfLifeDays).toFixed(3)) }))
    .sort((a, b) => b.score - a.score);
}

/** 选几组对答样本（默认 2 组）。 */
export function pickPairs(profile, config = {}, options = {}) {
  const c = normalizeVoiceConfig(config);
  if (!c.pairs) return [];
  const now = Number(options.now) || Date.now();
  const limit = Math.max(0, Math.min(4, Number(options.limit) || 2));
  return (profile?.pairs || [])
    .filter((x) => x && !x.disabled)
    .map((x) => ({ pair: x, score: gradeScore(x, now, c.halfLifeDays) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.pair);
}

export function renderPairSamples(pairs, config = {}) {
  const list = (Array.isArray(pairs) ? pairs : []).slice(0, 4);
  if (!list.length) return '';
  const c = normalizeVoiceConfig(config);
  const body = list.map((x) => `对方：${x.ask}\n你：${x.reply}`).join('\n');
  return `【你们平时这么说话】\n${body}`.slice(0, Math.max(200, c.maxChars));
}

export function listSamples(file) {
  const profile = loadVoiceProfile(file);
  const now = Date.now();
  return profile.samples
    .map((s) => ({ ...s, score: Number(gradeScore(s, now, DEFAULT_VOICE_CONFIG.halfLifeDays).toFixed(3)) }))
    .sort((a, b) => b.score - a.score);
}

export function pickSamples(profile, config = {}, options = {}) {
  const c = normalizeVoiceConfig(config);
  const now = Number(options.now) || Date.now();
  const exclude = Array.isArray(options.exclude) ? options.exclude : [];
  const candidates = (profile?.samples || [])
    .filter((s) => s && !s.disabled && !exclude.includes(s.id))
    .map((s) => ({ sample: s, score: gradeScore(s, now, c.halfLifeDays) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const limit = Math.max(1, Math.min(10, Number(options.limit) || c.maxSamples));
  const picked = [];
  let used = 0;
  for (const { sample } of candidates) {
    if (picked.length >= limit) break;
    const cost = sample.text.length + 4;
    if (used + cost > c.maxChars) continue;
    picked.push(sample);
    used += cost;
  }
  return picked;
}

/** 角色卡里的"说话方式"锚：只抽气质与规则，不整卡搬运。 */
export function personaAnchorText(maxChars = 600) {
  const file = activePersonaFile();
  if (!file) return '';
  let stat;
  try { stat = fs.statSync(file); } catch { return ''; }
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (personaAnchorCache.key === key) return personaAnchorCache.text;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  raw = raw.replace(/^=====.*=====\s*$/gm, '').trim();
  const sections = [];
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      cur = { title: line.replace(/^##\s*/, '').trim(), lines: [] };
      sections.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  // 顺序=重要性：先说怎么说话（口吻/方式），再给示例，最后才是身份自述。
  const priority = [/(说话方式|口吻|语气)/, /(回复示例)/, /(你是谁)/, /(黑名单|别这样|AI\s*味)/];
  let text = '';
  const used = new Set();
  const limit = Math.max(120, Number(maxChars) || 600);
  for (const re of priority) {
    for (const sec of sections) {
      if (used.has(sec)) continue;
      if (!re.test(sec.title)) continue;
      const isIdentity = /你是谁/.test(sec.title);
      const body = (isIdentity ? sec.lines.filter((l) => l.trim()).slice(0, 8) : sec.lines).join('\n').trim();
      if (!body) continue;
      used.add(sec);
      text += `${text ? '\n' : ''}· ${sec.title}\n${body}`;
      if (text.length >= limit) break;
    }
    if (text.length >= limit) break;
  }
  if (!text) text = raw.split(/\r?\n/).filter(Boolean).slice(0, 12).join('\n');
  text = text.slice(0, Math.max(120, Number(maxChars) || 600)).trim();
  personaAnchorCache = { key, text };
  return text;
}

let personaAnchorCache = { key: '', text: '' };

export function renderVoiceBlock(samples, config = {}) {
  const c = normalizeVoiceConfig(config);
  const list = Array.isArray(samples) ? samples : [];
  const anchor = personaAnchorText(600);
  const parts = ['【说话方式·这就是你】'];
  parts.push(HARD_RULES);
  if (anchor) parts.push(anchor);
  if (list.length) {
    parts.push('你自己说过的原话（照着这个语气说，别照抄内容）：');
    parts.push(list.map((s) => `- 「${s.text}」`).join('\n'));
  }
  const text = parts.join('\n').trim();
  return text.length > c.maxChars * 3 ? text.slice(0, c.maxChars * 3) : text;
}

/** 群聊专用：私聊里练出来的语言节奏，只给句式不给上下文。 */
export function renderAnchorBlock(samples, config = {}) {
  const c = normalizeVoiceConfig(config);
  const list = (Array.isArray(samples) ? samples : []).slice(0, 4);
  if (!list.length) return '';
  return `【私下说话的节奏】\n${list.map((s) => `- 「${s.text}」`).join('\n')}`.slice(0, c.maxChars);
}

/** v7：放在 prompt 最末尾的极短 gate —— 声线在末尾才有用，顶部只会被后面的流程指令压掉。 */
export function renderVoiceTail(pack, config = {}) {
  const c = normalizeVoiceConfig(config);
  if (!c.tail) return '';
  const lines = [
    '【就这样说话】',
    '不解释、不总结、不铺背景；一次一句，1~10 字，像打字。',
    '对方说啥就接啥，别当客服，别每条都关心人。',
  ];
  const pairsText = renderPairSamples(pack?.pairs || [], c);
  const text = [lines.join('\n'), pairsText].filter(Boolean).join('\n');
  return text.trim();
}

export function voiceStats(config = {}, file) {
  const c = normalizeVoiceConfig(config);
  const profile = loadVoiceProfile(file);
  const enabledCount = profile.samples.filter((s) => !s.disabled).length;
  return {
    enabled: c.enabled,
    tail: c.tail,
    tailGroupOnly: c.tailGroupOnly,
    pairs: c.pairs,
    pairCount: (profile.pairs || []).filter((x) => !x.disabled).length,
    total: profile.samples.length,
    enabledCount,
    chars: profile.samples.reduce((n, s) => n + s.text.length, 0),
    maxSamples: c.maxSamples,
    maxChars: c.maxChars,
    groupAnchor: c.groupAnchor,
    autoMine: c.autoMine,
  };
}

/** 唤醒时用：一次把「人设锚 + 样本」拼好，群聊额外返回私聊锚。 */
export function buildVoiceLines(key, config = {}, options = {}) {
  const c = normalizeVoiceConfig(config);
  const out = { line: '', anchorLine: '', tail: '', pairs: [], stats: voiceStats(c) };
  if (!c.enabled) return out;
  const profile = loadVoiceProfile(options.file);
  const privateKey = options.privateKey ? `private:${options.privateKey}` : '';
  const isPrivate = String(key || '') === privateKey;
  const picked = pickSamples(profile, c, { now: options.now, limit: isPrivate ? c.maxSamples : Math.max(2, c.maxSamples - 2) });
  const voiceText = renderVoiceBlock(picked, c);
  out.line = voiceText ? `${voiceText}\n\n` : '';
  if (String(key || '').startsWith('group:') && c.groupAnchor) {
    // 群聊专用：同几条原话再压成"私下节奏"，让群里的句子短、有停顿，不像在写作文。
    const anchor = renderAnchorBlock(picked.slice(0, 4), c);
    out.anchorLine = anchor ? `${anchor}\n\n` : '';
  }
  // v7：对答样本 + 末尾 gate（默认只给群聊，别动私聊）。
  const wantTail = c.tail && c.enabled && (!c.tailGroupOnly || String(key || '').startsWith('group:'));
  if (wantTail) {
    const pairs = pickPairs(profile, c, { now: options.now, limit: 2 });
    out.pairs = pairs;
    const tail = renderVoiceTail({ pairs }, c);
    out.tail = tail ? `${tail}\n\n` : '';
  }
  out.stats.injected = picked.length;
  return out;
}
