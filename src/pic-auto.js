// pic-auto.js —— 「按聊天气景自动发图」的决策层。
//
// 为什么单独成文件：桥接（bridge.js）已经 16000 行，自动发图的判断逻辑是纯函数，
// 抽出来才能写单测（scripts/test-pic-auto.mjs），也免得以后改阈值时被桥接的
// 一堆闭包绕晕。
//
// 三种来源（2026-10-31 主人要求）：
//   1. sticker  —— QQ 收藏表情，桥接自己发，真正「自动」；
//   2. local    —— 主人指定的本地图库目录，桥接自己挑一张发；
//   3. generate —— dsh-image-gen 生成新图，桥接没有程序入口，只能靠提示词
//                  让 agent 自己调 generate_image + qq_send_image（提示词级自动）。
//
// 「温度」说明：dsh-image-gen 的 generate_image 只接受 prompt/provider/model/
// size/quality/aspect_ratio/workflow，**没有采样温度**。所以这里的 warmth 是
// 「提示词级温度」：低 = 固定构图只改表情光照，高 = 允许脑洞构图和多元素拼贴。
// 它同时决定本地图库挑选时的发散度。

import fs from 'node:fs';
import path from 'node:path';

import { detectEmotions, rankStickers } from './sticker-semantics.js';

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']);

// 场景池：默认允许的情绪（键与 sticker-semantics 的 STICKER_EMOTIONS 对齐）。
// 负面/慎重的情绪默认关：主人生气或难过时先接话，别甩图。
const DEFAULT_SCENES = {
  happy: true,
  cute: true,
  funny: true,
  smug: true,
  shy: true,
  tsundere: true,
  speechless: true,
  surprise: true,
  agree: true,
  neutral: true,
  wronged: false,
  sad: false,
  angry: false,
  tired: false,
  hungry: false,
  comfort: false,
  tease: false,
  bye: false,
  scared: false
};

export function defaultPicConfig() {
  return {
    enabled: true,
    maxPerTurn: 1,
    minGapMs: 120000,
    maxPerHour: 6,
    quietFrom: '01:00',
    quietTo: '07:00',
    scopes: { private: true, group: true, groupDeny: [], groupAllow: [] },
    textFirst: true,
    dedupeHours: 24,
    scenes: { ...DEFAULT_SCENES },
    seriousGuard: true,
    sources: {
      // looseFallback：只有 QQ 表情这一路可用、又严格匹配不到时，允许从收藏里挑一张
      // 最常用的（她自己「喜欢」的那张）发出去。关掉就回到「匹配不到就不发」。
      sticker: { enabled: true, weight: 60, minScore: 0.7, annotatedOnly: true, looseFallback: true },
      local: { enabled: false, weight: 25, dirs: [], emotionSubdir: true, warmth: 0.5, keywords: [] },
      generate: {
        enabled: false,
        weight: 15,
        warmth: 0.6,
        style: 'auto',
        stylePresets: [],
        promptPrefix: '',
        maxPerDay: 10,
        fallback: 'sticker'
      }
    }
  };
}

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true' || value === 1;
}

function strList(value, cap = 32) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const s = String(item ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

// 「HH:MM」
function normClock(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return fallback;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** 把 config.json 里的 socialV2.pic 归一化成完整配置（缺项补默认值）。 */
export function normalizePicConfig(raw) {
  const def = defaultPicConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return def;
  const src = raw.sources && typeof raw.sources === 'object' ? raw.sources : {};
  const scenes = raw.scenes && typeof raw.scenes === 'object' ? raw.scenes : {};
  const scopes = raw.scopes && typeof raw.scopes === 'object' ? raw.scopes : {};
  const sticker = src.sticker && typeof src.sticker === 'object' ? src.sticker : {};
  const local = src.local && typeof src.local === 'object' ? src.local : {};
  const generate = src.generate && typeof src.generate === 'object' ? src.generate : {};
  const out = {
    enabled: bool(raw.enabled, def.enabled),
    maxPerTurn: Math.round(num(raw.maxPerTurn, def.maxPerTurn, 0, 5)),
    minGapMs: Math.round(num(raw.minGapMs, def.minGapMs, 0, 6 * 3600 * 1000)),
    maxPerHour: Math.round(num(raw.maxPerHour, def.maxPerHour, 0, 60)),
    quietFrom: normClock(raw.quietFrom, def.quietFrom),
    quietTo: normClock(raw.quietTo, def.quietTo),
    scopes: {
      private: bool(scopes.private, def.scopes.private),
      group: bool(scopes.group, def.scopes.group),
      groupDeny: strList(scopes.groupDeny),
      groupAllow: strList(scopes.groupAllow)
    },
    textFirst: bool(raw.textFirst, def.textFirst),
    dedupeHours: Math.round(num(raw.dedupeHours, def.dedupeHours, 0, 720)),
    scenes: {},
    seriousGuard: bool(raw.seriousGuard, def.seriousGuard),
    sources: {
      sticker: {
        enabled: bool(sticker.enabled, def.sources.sticker.enabled),
        weight: Math.round(num(sticker.weight, def.sources.sticker.weight, 0, 100)),
        minScore: num(sticker.minScore, def.sources.sticker.minScore, 0, 1),
        annotatedOnly: bool(sticker.annotatedOnly, def.sources.sticker.annotatedOnly),
        looseFallback: bool(sticker.looseFallback, def.sources.sticker.looseFallback)
      },
      local: {
        enabled: bool(local.enabled, def.sources.local.enabled),
        weight: Math.round(num(local.weight, def.sources.local.weight, 0, 100)),
        dirs: strList(local.dirs, 8),
        emotionSubdir: bool(local.emotionSubdir, def.sources.local.emotionSubdir),
        warmth: num(local.warmth, def.sources.local.warmth, 0, 1),
        keywords: strList(local.keywords, 40)
      },
      generate: {
        enabled: bool(generate.enabled, def.sources.generate.enabled),
        weight: Math.round(num(generate.weight, def.sources.generate.weight, 0, 100)),
        warmth: num(generate.warmth, def.sources.generate.warmth, 0, 1),
        style: ['auto', 'selfie', 'daily', 'meme', 'custom'].includes(generate.style) ? generate.style : 'auto',
        stylePresets: strList(generate.stylePresets, 20),
        promptPrefix: String(generate.promptPrefix ?? '').slice(0, 400),
        maxPerDay: Math.round(num(generate.maxPerDay, def.sources.generate.maxPerDay, 0, 200)),
        fallback: ['sticker', 'local', 'none'].includes(generate.fallback) ? generate.fallback : 'sticker'
      }
    }
  };
  for (const key of Object.keys(DEFAULT_SCENES)) {
    out.scenes[key] = bool(scenes[key], DEFAULT_SCENES[key]);
  }
  return out;
}

/** 静态时段判断（支持跨零点，例如 23:30 - 07:00）。from === to 视为不启用。 */
export function inQuietHours(now, from, to) {
  if (!from || !to || from === to) return false;
  const d = new Date(Number(now) || Date.now());
  const cur = d.getHours() * 60 + d.getMinutes();
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const start = fh * 60 + fm;
  const end = th * 60 + tm;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end; // 跨零点
}

// 「正事/严肃话题」：技术、报错、钱、隐私、健康、作业这类话题上甩表情包很失礼。
const SERIOUS_PATTERNS = [
  /报错|error|exception|stack ?trace|traceback|编译|构建失败|跑不起来|装不上|崩溃/i,
  /代码|函数|接口|数据库|脚本|仓库|git |commit|pull request|\bpr\b|部署|上线|服务器|日志/i,
  /转账|付款|付钱|红包|余额|退款|发票|工资|欠款|借我|还我|转我|打钱|块钱|多少钱/,
  /密码|密钥|token|隐私|身份证|银行卡|手机号|地址|定位/,
  /去医院|生病|发烧|疼|药|手术|体检|抑郁|焦虑|自杀/,
  /作业|论文|考试|复习|答辩|面试|简历|辞职|离职|加班费/,
  /帮我(查|写|改|弄|修|看看|分析|总结|翻译|算)/,
  /认真|严肃|重要|急|马上|赶紧|立刻/
];

export function looksSerious(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  return SERIOUS_PATTERNS.some((re) => re.test(s));
}

/** 当前语境识别出的情绪里，有没有被场景池允许的。 */
export function sceneAllows(cfg, emotions) {
  // 看不出情绪时按「平淡」走，由 scenes.neutral 决定放不放行 ——
  // 这样关掉 neutral 就等于「只认明确情绪」，不用另加开关。
  const list = Array.isArray(emotions) && emotions.length ? emotions : ['neutral'];
  return list.some((e) => cfg.scenes?.[e] === true);
}

function scopeAllows(cfg, kind, chatId) {
  const scopes = cfg.scopes ?? {};
  if (kind === 'private') return scopes.private !== false;
  if (scopes.group === false) return false;
  const id = String(chatId ?? '');
  const allow = Array.isArray(scopes.groupAllow) ? scopes.groupAllow.map(String) : [];
  const deny = Array.isArray(scopes.groupDeny) ? scopes.groupDeny.map(String) : [];
  if (allow.length && !allow.includes(id)) return false;
  if (deny.includes(id)) return false;
  return true;
}

/**
 * 按权重随机挑一路。rand 可注入（单测用固定序列）。
 * @returns {{source:string, weight:number}|null}
 */
export function pickWeighted(sources, rand = Math.random) {
  const pool = Object.entries(sources || {})
    .filter(([, v]) => v && v.enabled !== false && Number(v.weight) > 0)
    .map(([k, v]) => [k, Number(v.weight)]);
  const total = pool.reduce((sum, [, w]) => sum + w, 0);
  if (!pool.length || total <= 0) return null;
  // rand 既可以是函数（单测注入序列），也可以直接是 [0,1) 的数（桥接里常用固定值）。
  const rnd = typeof rand === 'function' ? Number(rand()) : Number(rand);
  let r = (Number.isFinite(rnd) ? rnd : 0) * total;
  for (const [k, w] of pool) {
    r -= w;
    if (r <= 0) return { source: k, weight: w };
  }
  const [k, w] = pool[pool.length - 1];
  return { source: k, weight: w };
}

/**
 * 核心决策：这次要不要发、发哪一路。
 *
 * @param cfg normalizePicConfig 后的配置
 * @param ctx {
 *   text?:string            本轮语境（对方来信 + 自己刚要发的话）
 *   emotions?:string[]      detectEmotions 的结果
 *   kind?:'private'|'group'
 *   chatId?:string
 *   now?:number
 *   lastAt?:number          上次自动发图时间
 *   hourCount?:number       最近一小时自动发图数
 *   perTurnSent?:number     本轮已经自动发了几张
 *   available?:{sticker?:boolean, local?:boolean, generate?:boolean}
 *   rand?:()=>number
 * }
 * @returns {{source:string, weight:number, reason:string}|null}
 */
export function decidePicSource(cfg, ctx = {}) {
  if (!cfg || cfg.enabled === false) return null;
  const now = Number(ctx.now) || Date.now();
  const perTurnSent = Number(ctx.perTurnSent) || 0;
  if (perTurnSent >= Math.max(1, Number(cfg.maxPerTurn) || 1)) return null;
  if (inQuietHours(now, cfg.quietFrom, cfg.quietTo)) return null;
  if (Number(ctx.lastAt) > 0 && now - Number(ctx.lastAt) < Math.max(0, Number(cfg.minGapMs) || 0)) return null;
  if (Number(ctx.hourCount) > 0 && Number(cfg.maxPerHour) > 0 && Number(ctx.hourCount) >= Number(cfg.maxPerHour)) return null;
  if (!scopeAllows(cfg, ctx.kind ?? 'private', ctx.chatId)) return null;
  const text = String(ctx.text ?? '');
  if (cfg.seriousGuard !== false && looksSerious(text)) return null;
  const emotions = Array.isArray(ctx.emotions) && ctx.emotions.length
    ? ctx.emotions
    : detectEmotions(text).map((e) => e.key);
  if (!sceneAllows(cfg, emotions)) return null;

  const avail = ctx.available ?? {};
  const sources = {};
  for (const [key, value] of Object.entries(cfg.sources ?? {})) {
    sources[key] = { ...value, enabled: value.enabled !== false && avail[key] !== false };
  }
  const picked = pickWeighted(sources, ctx.rand ?? Math.random);
  if (!picked) return null;
  const bits = [];
  if (emotions.length) bits.push(`情绪 ${emotions.slice(0, 3).join('/')}`);
  bits.push(`来源权重 ${picked.weight}`);
  return { source: picked.source, weight: picked.weight, reason: bits.join('，') };
}

/**
 * 降级链：按「表情 → 本地图库 → 现场生图」的顺序返回可尝试的来源。
 *
 * 为什么不把降级写进 decidePicSource：决策层只回答「这轮该不该发、首选哪一路」，
 * 换路要等真正挑素材失败才知道，那是桥接拿得到的信息。decision 保持纯粹，测试好写。
 *
 * @param cfg normalizePicConfig 后的配置
 * @param ctx {available?:{sticker?:boolean,local?:boolean,generate?:boolean}, first?:string}
 * @returns {string[]} 例如 ['sticker','local','generate']
 */
export function picFallbackChain(cfg, ctx = {}) {
  if (!cfg || cfg.enabled === false) return [];
  const avail = ctx.available ?? {};
  const src = cfg.sources ?? {};
  const order = ['sticker', 'local', 'generate'].filter((key) => {
    const one = src[key];
    if (!one || one.enabled === false) return false;
    return avail[key] !== false;
  });
  const first = String(ctx.first ?? '').trim();
  if (first && order.includes(first)) return [first, ...order.filter((k) => k !== first)];
  return order;
}

/**
 * 折中挑一张：严格匹配不上时，从收藏里挑她自己最常用的。
 *
 * useCount 是「她以前真的发过几次」——比随机更像「她喜欢的那张」。
 * exclude 命中的（最近发过的）先避开；全被避开时仍然给一张，否则这一路等于没有。
 */
export function pickStickerLoose(entries, opts = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  if (!list.length) return null;
  const rand = typeof opts.rand === 'function' ? opts.rand : null;
  const exclude = new Set((Array.isArray(opts.exclude) ? opts.exclude : []).map(String));
  const pickNo = (arr) => {
    const sorted = [...arr].sort((a, b) => (Number(b.useCount) || 0) - (Number(a.useCount) || 0));
    // 没给随机源（生产里就是这么调的）就取最常用的那张：可预期、也不会每次都换图。
    if (!rand) return sorted[0] ?? null;
    return pickRandom(sorted.slice(0, 3), rand);
  };
  const fresh = list.filter((e) => !exclude.has(String(e.id ?? e.no ?? '')));
  return pickNo(fresh.length ? fresh : list);
}

/**
 * 从表情库挑一张。返回 rankStickers 的第一条（含 no/id/score）。
 * annotatedOnly：只发有 emotion 标注的，避免拿一张「平淡」的去接「被夸」。
 */
export function pickStickerFor(entries, text, opts = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length) return null;
  const pool = opts.annotatedOnly === false
    ? list
    : list.filter((e) => e && e.emotion && e.emotion !== 'neutral');
  if (!pool.length) return null;
  const ranked = rankStickers(pool, text, {
    topK: 3,
    minScore: Number(opts.minScore) || 0,
    exclude: Array.isArray(opts.exclude) ? opts.exclude : [],
    now: opts.now
  });
  const top = ranked[0];
  if (!top) return null;
  return top;
}

function walkImages(dir, out, depth = 0) {
  if (depth > 3) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkImages(full, out, depth + 1);
      continue;
    }
    if (!ent.isFile()) continue;
    if (!IMAGE_EXTS.has(path.extname(ent.name).toLowerCase())) continue;
    out.push(full);
    if (out.length >= 2000) return out;
  }
  return out;
}

/** 列出本地图库里的所有图片（绝对路径）。 */
export function listLocalImages(dirs, walk = walkImages) {
  const out = [];
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    const abs = String(dir ?? '').trim();
    if (!abs) continue;
    walk(abs, out);
    if (out.length >= 2000) break;
  }
  return out;
}

function pickRandom(list, rand) {
  if (!list.length) return null;
  const i = Math.min(list.length - 1, Math.floor(Number(rand()) * list.length));
  return list[i];
}

/**
 * 从本地图库挑一张。
 * warmth（本地图随机度）：<0.35 严格按情绪子目录 + 关键词；0.35~0.7 优先情绪目录，
 * 找不到再全库随机；>0.7 全库随机（仍避开关键词命中的负向图）。
 */
export function pickLocalImage(dirs, opts = {}) {
  const rand = opts.rand ?? Math.random;
  const all = listLocalImages(dirs, opts.walk);
  if (!all.length) return null;
  const warmth = Number.isFinite(Number(opts.warmth)) ? Number(opts.warmth) : 0.5;
  const exclude = new Set(Array.isArray(opts.exclude) ? opts.exclude.map(String) : []);
  const pool0 = all.filter((p) => !exclude.has(p));
  // 全被排除时宁可不发：为了凑一张图把刚刚发过的图再发一遍，比不发更糟。
  if (!pool0.length) return null;
  const pool = pool0;
  const emotions = Array.isArray(opts.emotions) ? opts.emotions.map(String) : [];
  const keywords = Array.isArray(opts.keywords) ? opts.keywords.map((k) => String(k).toLowerCase()).filter(Boolean) : [];
  const emotionSubdir = opts.emotionSubdir !== false;

  const byEmotion = emotionSubdir && emotions.length
    ? pool.filter((p) => {
      const lower = p.toLowerCase();
      return emotions.some((e) => lower.includes(`${path.sep}${e}${path.sep}`) || lower.includes(`/${e}/`));
    })
    : [];
  const byKeyword = keywords.length
    ? pool.filter((p) => {
      const base = path.basename(p).toLowerCase();
      return keywords.some((k) => base.includes(k));
    })
    : [];

  const strict = [...new Set([...byEmotion, ...byKeyword])];
  if (warmth < 0.35) return pickRandom(strict.length ? strict : byEmotion, rand);
  if (warmth > 0.7) return pickRandom(pool, rand);
  const soft = strict.length ? strict : byEmotion;
  return pickRandom(soft.length && rand() < 0.7 ? soft : pool, rand);
}

// 温度 → 提示词修饰段。给 agent 拼在 generate_image 的 prompt 前面。
const STYLE_WORDS = {
  selfie: ['手机自拍视角', '软光', '浅景深'],
  daily: ['日常抓拍', '自然光', '生活感'],
  meme: ['表情包风格', '夸张表情', '纯色或简单背景'],
  auto: ['插图风格', '干净构图', '柔和打光']
};

export function buildImagePrompt(opts = {}) {
  const warmth = Math.min(1, Math.max(0, Number(opts.warmth) || 0));
  const style = String(opts.style ?? 'auto');
  const presets = Array.isArray(opts.stylePresets) ? opts.stylePresets.filter(Boolean) : [];
  const prefix = String(opts.promptPrefix ?? '').trim();
  const sceneHint = String(opts.sceneHint ?? '').trim();
  const rand = opts.rand ?? Math.random;
  const base = STYLE_WORDS[style] ?? STYLE_WORDS.auto;

  // 低温：风格词全给（越稳越像同一个人）；中温：随机挑一个风格词；高温：额外加脑洞元素。
  const words = [];
  if (warmth <= 0.3) {
    words.push(...base);
    if (presets.length) words.push(presets[0]);
  } else if (warmth <= 0.7) {
    words.push(pickRandom(base, rand) ?? base[0]);
    if (presets.length) words.push(pickRandom(presets, rand));
  } else {
    words.push(base[0], ...(presets.length ? [pickRandom(presets, rand)] : []));
    words.push('夸张道具', '不寻常视角');
  }

  const tempLine = warmth <= 0.3
    ? '温度：低（构图和服装保持不变，只改表情、光线和背景细节）'
    : warmth <= 0.7
      ? '温度：中（可以换背景和小道具，人物长相与服装保持一致）'
      : '温度：高（允许脑洞场景、夸张动作和多元素拼贴，但必须还是同一个人）';

  const parts = [prefix, '【风格】' + words.filter(Boolean).join('、'), tempLine];
  if (sceneHint) parts.push('【此刻】' + sceneHint);
  return parts.filter(Boolean).join('\n');
}

/** 把发图策略写成一段唤醒提示词（注入到 sendWakePromptV2 的 picLine）。 */
export function buildPicPromptLine(cfg, opts = {}) {
  if (!cfg || cfg.enabled === false) return '';
  const src = cfg.sources ?? {};
  const on = [];
  if (src.sticker?.enabled !== false) on.push('QQ 收藏表情（qq_send_sticker / qq_send_pic）');
  if (src.local?.enabled === true) on.push('本地图库（qq_send_pic source="local"）');
  if (src.generate?.enabled === true) on.push('现场生图（generate_image → qq_send_image）');
  if (!on.length) return '';
  const lines = [
    '【发图】桥接会在你发完一句话后，按当时的语境自己补一张图（也可能不补）。你可以主动配合：',
    `- 可用来源：${on.join('、')}。想指定就用 qq_send_pic{hint:"关键词", source:"auto"}，一键挑一张发出去。`,
  ];
  if (src.generate?.enabled === true) {
    lines.push(
      `- 想发一张新图（自拍、刚做的事、此刻的样子）：先调 generate_image，prompt 里带上「${buildImagePrompt({
        warmth: src.generate.warmth,
        style: src.generate.style,
        stylePresets: src.generate.stylePresets,
        promptPrefix: src.generate.promptPrefix
      }).replace(/\n/g, '；')}」，拿到图片路径后用 qq_send_image 发出去。`
    );
  }
  lines.push('- 一次最多发一张；对方在说正事、报错、钱、隐私、健康这类话题时不要发图。文字和图片分成两条气泡。');
  // pending：桥接上一轮想补图但三条路都没有素材，已经替你把 prompt 算好了。
  // 这段必须显眼：它是一次「欠着的图」，拖着不发就等于那条降级链白装了。
  const pending = opts.pending && typeof opts.pending === 'object' ? opts.pending : null;
  if (pending && String(pending.prompt ?? '').trim()) {
    lines.push(
      '【该补图了】上一轮想补图，收藏表情和本地图库都没有合适的。',
      `- prompt：${String(pending.prompt).replace(/\s*\n\s*/g, '；')}`,
      '- 做完：generate_image 生成后，用 qq_send_image 把绝对路径发出去，再继续正常回复。'
    );
  }
  if (opts.note) lines.push(`- ${opts.note}`);
  return lines.join('\n');
}
