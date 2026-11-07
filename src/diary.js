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
  // 私密日记只落本地、只发给主人：默认允许真实姓名和私密细节；关掉则用代称。
  allowPrivateDetails: true,
  // 一个文件放几篇：1 = 一篇一个文件（文件名就是那篇的时间）；
  // 5 = 五篇一个文件（文件名是起止时间跨度），第 6 篇另起新文件。
  perFile: 1,
  send: { enabled: false, withFile: true },
  // 公开日记：写出来的东西会发到 QQ 空间，所以默认关、默认只给好友看。
  public: {
    enabled: false,
    dir: '',
    everyDays: 1,
    hour: 22,
    maxChars: 600,
    perFile: 1,
    visibility: 4,
    maxPerDay: 1,
    allowNames: true,
  },
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
  const pub = isPlainObject(src.public) ? src.public : {};
  const def = DEFAULT_DIARY_CONFIG;
  const vis = Number(pub.visibility);
  return {
    enabled: src.enabled === true,
    dir: String(src.dir ?? '').trim().slice(0, 500),
    everyDays: num(src.everyDays, def.everyDays, 1, 30),
    hour: num(src.hour, def.hour, 0, 23),
    maxChars: num(src.maxChars, def.maxChars, 200, 5000),
    allowPrivateDetails: src.allowPrivateDetails !== false,
    perFile: num(src.perFile, def.perFile, 1, 50),
    send: {
      enabled: send.enabled === true,
      withFile: send.withFile !== false,
    },
    public: {
      enabled: pub.enabled === true,
      dir: String(pub.dir ?? '').trim().slice(0, 500),
      everyDays: num(pub.everyDays, def.public.everyDays, 1, 30),
      hour: num(pub.hour, def.public.hour, 0, 23),
      maxChars: num(pub.maxChars, def.public.maxChars, 200, 2000),
      perFile: num(pub.perFile, def.public.perFile, 1, 50),
      // 空间可见范围只认这几种：1 所有人 / 4 好友 / 64 仅自己
      visibility: [1, 4, 64].includes(vis) ? vis : def.public.visibility,
      maxPerDay: num(pub.maxPerDay, def.public.maxPerDay, 0, 10),
      allowNames: pub.allowNames !== false,
    },
  };
}

export function diaryBaseDir(dshHome, customDir = '') {
  const custom = String(customDir ?? '').trim();
  if (custom) return path.resolve(custom);
  return path.join(String(dshHome || ''), 'surfcore', 'diary');
}

export function sanitizeCharacterId(characterId = 'default') {
  return String(characterId || 'default').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'default';
}

/**
 * 旧版路径：每个角色一个 md，所有篇目追加在里面。
 * 现在只用于「首次迁移」和兼容预览，新日记不再写这里。
 */
export function diaryFileFor({ dshHome, dir = '', characterId = 'default' }) {
  const safeId = sanitizeCharacterId(characterId);
  return path.join(diaryBaseDir(dshHome, dir), `${safeId}.md`);
}

/**
 * 新路径：保存目录只是「存放所有日记的文件夹」，里面按角色分一个子目录，
 * 子目录里才是按时间命名的 md（多角色共用一个目录时不会撞名）。
 */
export function diaryCharDir({ dshHome, dir = '', characterId = 'default' }) {
  return path.join(diaryBaseDir(dshHome, dir), sanitizeCharacterId(characterId));
}

/** 公开日记的默认根目录：跟私密日记分开，免得两本混在一起。 */
export function diaryPublicBaseDir(dshHome, customDir = '') {
  const custom = String(customDir ?? '').trim();
  if (custom) return path.resolve(custom);
  return path.join(String(dshHome || ''), 'surfcore', 'diary-public');
}

export function diaryPublicCharDir({ dshHome, dir = '', characterId = 'default' }) {
  return path.join(diaryPublicBaseDir(dshHome, dir), sanitizeCharacterId(characterId));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 文件名里的时间标签：2026-11-01_22-30（不能用冒号，Windows 路径非法）。 */
export function diaryTimeLabel(ms) {
  const d = new Date(Number(ms) || 0);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}`;
}

const DIARY_NAME_RE = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2})(?:~(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}))?(-\d+)?\.md$/;

function labelToMs(label) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})$/.exec(String(label || ''));
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
}

export function isDiaryFileName(name) {
  return DIARY_NAME_RE.test(String(name || ''));
}

export function parseDiaryFileName(name) {
  const m = DIARY_NAME_RE.exec(String(name || ''));
  if (!m) return null;
  const startAt = labelToMs(m[1]);
  const endAt = m[2] ? labelToMs(m[2]) : startAt;
  return { startAt, endAt, suffix: m[3] || '', startLabel: m[1], endLabel: m[2] || m[1] };
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 把一段 md 按 `## 2026-10-31 周六 22:30` 标题切成多篇。
 * 迁移旧文件、统计「这个文件里有几篇」、界面取最近 N 篇都靠它。
 */
export function parseDiaryEntries(text) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    cur.text = cur.body.join('\n').trim();
    delete cur.body;
    out.push(cur);
  };
  for (const line of String(text ?? '').split('\n')) {
    const m = /^##\s+(\d{4})-(\d{2})-(\d{2})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const hm = /(\d{2}):(\d{2})/.exec(m[4] || '');
      const hh = hm ? Number(hm[1]) : 0;
      const mm = hm ? Number(hm[2]) : 0;
      cur = {
        at: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm, 0, 0).getTime(),
        label: `${m[1]}-${m[2]}-${m[3]} ${pad2(hh)}:${pad2(mm)}`,
        heading: line.trim(),
        body: [],
      };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  flush();
  return out;
}

/** 目录里所有「按时间命名」的日记文件，按结束时间倒序。 */
export function listDiaryFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    const parsed = parseDiaryFileName(name);
    if (!parsed) continue;
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const entries = parseDiaryEntries(readTextFile(file));
    files.push({
      file,
      name,
      startAt: parsed.startAt || stat.mtimeMs,
      endAt: parsed.endAt || stat.mtimeMs,
      startLabel: parsed.startLabel,
      endLabel: parsed.endLabel,
      count: entries.length,
      mtimeMs: stat.mtimeMs,
    });
  }
  files.sort((a, b) => (b.endAt - a.endAt) || (b.mtimeMs - a.mtimeMs));
  return files;
}

/**
 * 这一篇该写进哪个文件。
 * perFile=1 永远新建；perFile>1 时，最新的那个文件还没装满就继续追加。
 */
export function pickDiaryTarget({ dir, now = Date.now(), perFile = 1 }) {
  const per = Math.max(1, Math.min(50, Number(perFile) || 1));
  if (per > 1) {
    const latest = listDiaryFiles(dir)[0];
    if (latest && latest.count > 0 && latest.count < per) {
      return { file: latest.file, mode: 'append', startAt: latest.startAt, existing: latest, perFile: per };
    }
  }
  const label = diaryTimeLabel(now);
  let file = path.join(dir, `${label}.md`);
  for (let i = 2; fs.existsSync(file); i += 1) {
    file = path.join(dir, `${label}-${i}.md`);
  }
  return { file, mode: 'new', startAt: now, perFile: per };
}

/**
 * 写一篇日记（自动决定新建/追加），
 * 追加后把文件名重命名成「起~止」，这样文件名始终反映里面装的时间跨度。
 */
export function appendDiaryEntryGrouped({ dir, now = Date.now(), entry, perFile = 1 }) {
  const target = pickDiaryTarget({ dir, now, perFile });
  fs.mkdirSync(dir, { recursive: true });
  const written = appendDiaryEntry(target.file, entry);
  let file = target.file;
  let renamedFrom = null;
  if (target.mode === 'append') {
    const startLabel = diaryTimeLabel(target.existing?.startAt || now);
    const endLabel = diaryTimeLabel(now);
    const wantName = startLabel === endLabel ? `${startLabel}.md` : `${startLabel}~${endLabel}.md`;
    if (path.basename(file) !== wantName) {
      let next = path.join(dir, wantName);
      for (let i = 2; fs.existsSync(next); i += 1) {
        next = path.join(dir, `${wantName.slice(0, -3)}-${i}.md`);
      }
      try {
        fs.renameSync(file, next);
        renamedFrom = file;
        file = next;
      } catch {
        // 改名失败不算写作失败：内容已经写进去了，沿用旧文件名。
      }
    }
  }
  const entriesInFile = parseDiaryEntries(readTextFile(file)).length;
  return { file, renamedFrom, bytes: written.bytes, entriesInFile };
}

/** 最近 N 篇日记（跨文件，按时间倒序）。 */
export function listDiaryEntries({ dir, limit = 5 }) {
  const max = Math.max(1, Math.min(50, Number(limit) || 5));
  const out = [];
  for (const info of listDiaryFiles(dir)) {
    const entries = parseDiaryEntries(readTextFile(info.file));
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i];
      out.push({
        file: info.file,
        name: info.name,
        at: e.at,
        label: e.label,
        text: e.text,
        chars: (e.text || '').length,
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * 把旧版「一个角色一个 md」拆成新结构（按 perFile 分组）。
 * 子目录里已经有新文件就跳过；原文件改名成 .legacy-<时间戳>.bak 留底，不删内容。
 */
export function migrateLegacyDiary({ dshHome, dir = '', characterId = 'default', perFile = 1 }) {
  const legacy = diaryFileFor({ dshHome, dir, characterId });
  if (!fs.existsSync(legacy)) return { migrated: false, reason: 'no-legacy', files: [] };
  const charDir = diaryCharDir({ dshHome, dir, characterId });
  let existing = [];
  try {
    existing = fs.readdirSync(charDir).filter((n) => isDiaryFileName(n));
  } catch {
    existing = [];
  }
  if (existing.length) return { migrated: false, reason: 'already-new', files: [] };
  const entries = parseDiaryEntries(readTextFile(legacy));
  if (!entries.length) return { migrated: false, reason: 'empty-legacy', files: [] };
  fs.mkdirSync(charDir, { recursive: true });
  const per = Math.max(1, Math.min(50, Number(perFile) || 1));
  const files = [];
  for (let i = 0; i < entries.length; i += per) {
    const group = entries.slice(i, i + per);
    const startAt = group[0].at || Date.now();
    const endAt = group[group.length - 1].at || startAt;
    const startLabel = diaryTimeLabel(startAt);
    const endLabel = diaryTimeLabel(endAt);
    const name = startLabel === endLabel ? `${startLabel}.md` : `${startLabel}~${endLabel}.md`;
    const file = path.join(charDir, name);
    const text = group.map((e) => `${e.heading}\n\n${e.text}\n\n`).join('');
    try {
      fs.writeFileSync(file, text, 'utf8');
      files.push(file);
    } catch {
      // 个别文件写失败就跳过，剩下的继续；旧文件仍然保留。
    }
  }
  let backup = '';
  if (files.length) {
    backup = `${legacy}.legacy-${Date.now()}.bak`;
    try {
      fs.renameSync(legacy, backup);
    } catch {
      backup = '';
    }
  }
  return { migrated: files.length > 0, files, backup, reason: files.length ? 'ok' : 'write-failed' };
}

export function diaryStateFile(dshHome) {
  return path.join(String(dshHome || ''), 'surfcore', 'diary-state.json');
}

function hourReached(nowMs, hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return true;
  return new Date(nowMs).getHours() >= h;
}

/** 本地零点（不能用 UTC，跨时区会把「今天」算错）。 */
function localDayStart(nowMs) {
  const d = new Date(Number(nowMs));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 今天这个「写作时间」的时间点：本地零点 + hour 点。 */
function slotStartOf(nowMs, hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return localDayStart(nowMs);
  return localDayStart(nowMs) + Math.min(23, Math.max(0, Math.round(h))) * 3_600_000;
}

/**
 * 下一次「该写日记」的时间点。
 *
 * 语义（2026-11-03 重写）：调度只认「本地日期 + 写作时间点」，不认「上次写入的绝对时间 + N 天」。
 * 原来的写法有个致命副作用：凌晨 00:02 补写一篇之后，当天 22:00 会被算成「还没到间隔」而跳过，
 * 主人看到的就是「日记开着、今天却没发」。
 *
 * - 每天一篇（everyDays=1）：今天这个时间点之后还没写过 → 今天；已经写过 → 明天。
 * - 每 N 天一篇：上次那天的零点 + N 天 + 写作时间。
 * - 从没写过：今天这个时间点。
 */
export function diaryNextDueAt({ lastWriteAt, everyDays = 1, hour = 22, now = Date.now() }) {
  const nowMs = Number(now);
  const days = Math.max(1, Number(everyDays) || 1);
  const last = Number(lastWriteAt) || 0;
  const hourMs = (() => {
    const h = Number(hour);
    if (!Number.isFinite(h)) return 0;
    return Math.min(23, Math.max(0, Math.round(h))) * 3_600_000;
  })();
  const todaySlot = localDayStart(nowMs) + hourMs;
  if (!last) return todaySlot;
  if (days === 1) return last < todaySlot ? todaySlot : todaySlot + DAY_MS;
  return localDayStart(last) + days * DAY_MS + hourMs;
}

/**
 * 是否该写今天的日记。
 *
 * 判定就是「现在 >= 下一次该写的时间」：
 * - 到了今天这个时间点、且今天这个点之后还没写过 → 该写（凌晨补写/手动补写都不会吞掉当晚那一篇）；
 * - 每 N 天一篇时，只有到了第 N 天的写作时间点才写；
 * - 关机错过（候选时间点早已过去）→ 任何时间补写一次。
 */
export function isDiaryDue({ lastWriteAt, everyDays = 1, hour = 22, now = Date.now() }) {
  const nowMs = Number(now);
  const days = Math.max(1, Number(everyDays) || 1);
  const last = Number(lastWriteAt) || 0;
  const hourMs = (() => {
    const h = Number(hour);
    if (!Number.isFinite(h)) return 0;
    return Math.min(23, Math.max(0, Math.round(h))) * 3_600_000;
  })();
  const todaySlot = localDayStart(nowMs) + hourMs;
  // 每天一篇时，「昨天那一篇整个没写」说明桥接/电脑整天没开——今天就不要再等到 22 点，立刻补。
  // 注意要先 `last` 判定：从没写过（last=0）走下面的 first 分支，不能算成「逾期」。
  if (last && days === 1 && last < todaySlot - DAY_MS) return { due: true, reason: 'catchup' };
  const candidate = diaryNextDueAt({ lastWriteAt: last, everyDays, hour, now: nowMs });
  if (nowMs < candidate) {
    const firstToday = !last && candidate > nowMs;
    return { due: false, reason: firstToday ? 'hour' : 'interval' };
  }
  if (!last) return { due: true, reason: 'first' };
  if (nowMs - candidate >= DAY_MS) return { due: true, reason: 'catchup' };
  return { due: true, reason: 'slot' };
}

/**
 * 日记素材里的人名标签。
 * 私密日记允许真实姓名时直接用发送者昵称；公开日记/关闭开关时用代称，
 * 避免把私聊对象带进空间动态或公开日记。
 */
export function diarySpeakerLabel(
  { isSelf = false, isOwner = false, isGroup = false, sender = '' } = {},
  { audience = 'owner', allowPrivateDetails = false } = {},
) {
  if (isSelf) return '我';
  const name = String(sender ?? '').trim().slice(0, 40);
  if (String(audience) === 'public') {
    if (isOwner) return '主人';
    return isGroup ? (name || '群友') : '对方';
  }
  if (allowPrivateDetails !== false) return name || (isOwner ? '主人' : '对方');
  return isOwner ? '主人' : '对方';
}

export function buildDiaryPrompt({
  characterName,
  persona,
  context,
  maxChars = 1200,
  now = Date.now(),
  audience = 'owner',
  allowNames = true,
  allowPrivateDetails = true,
}) {
  const name = String(characterName || '我').trim();
  const when = new Date(now).toLocaleString('zh-CN', { hour12: false });
  const isPublic = String(audience) === 'public';
  const limit = Math.max(200, Math.min(800, maxChars));
  // 两本日记的「隐私线」不一样：
  // - 私密日记只发给主人，写得越真越好，所以允许点名、允许写谁说了什么；
  // - 公开日记会发到空间，人名可以留（不然整篇像公文），但钱/账号/证件/联系方式一律不写。
  const privateDetails = allowPrivateDetails !== false;
  const rules = isPublic
    ? [
        allowNames ? '可以写谁说了什么、谁发起的（群里的人名可以出现）' : '不要写任何人的名字，用「有人」「一个朋友」指代',
        '不写密码、验证码、账号、银行卡、身份证',
        '不写手机号、QQ 号、群号、邮箱、网址、文件路径、住址',
        '不写转账、付款、红包、余额、工资、欠款金额',
        '不要照抄聊天原句，用自己的话讲',
        '不要提到这是从聊天记录里看来的',
      ]
    : privateDetails
      ? [
          '这是只给你和主人看的私密日记：可以写谁说了什么、真实姓名、昵称、关系、对话细节、具体时间地点、金额、工作/学校等私密信息，想点名就点名',
          '不要编造没发生的事；不确定的细节就略过',
          '不写密码、验证码、银行卡、身份证、转账金额',
          '不要提到这是从聊天记录里看来的',
          '整篇只写一遍；结尾不要重复开头或中间已经写过的段落',
        ]
      : [
          '不要写任何人的名字，用「主人」「对方」「一个朋友」指代',
          '不要写住址、单位、学校、金额、账号、联系方式等可识别信息',
          '不要写密码、验证码、银行卡、身份证',
          '不要提到这是从聊天记录里看来的',
        ];
  return [
    `你是「${name}」，现在是 ${when}。`,
    persona ? `你的人物设定（节选）：${String(persona).replace(/\s+/g, ' ').trim().slice(0, 900)}` : '',
    isPublic ? '这篇是给外人看的公开日记，会发到你的空间。素材如下：' : '今天你看到的、聊到的事（只作素材，用自己的话写，别照抄原句）：',
    String(context ?? '').replace(/\s+/g, ' ').trim().slice(0, 2600) || '（今天比较安静，没发生什么特别的事）',
    `请写一篇今天的${isPublic ? '公开' : ''}日记，第一人称，200~${limit} 字。`,
    '要求：像真的写给自己的日记，不是汇报；可以写心情、想法、小细节；不要标题、不要列表、不要 markdown。',
    `硬规矩（写的时候就要遵守，不要等别人删）：${rules.map((r) => `\n- ${r}`).join('')}`,
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

// 公开日记的兜底清洗：模型再听话也可能漏，发到空间之前必须过一遍。
// 策略是「按句子整句删」，而不是打码——半句话留着反而更怪。
const PUBLIC_SENTENCE_SPLIT = /(?<=[。！？!?\n])/;

const PUBLIC_BLOCK_PATTERNS = [
  { kind: 'password', re: /密码|验证码|校验码|动态码|短信码/ },
  { kind: 'account', re: /账号|帐号|登录名|用户名/ },
  { kind: 'idcard', re: /身份证|证件号|护照号/ },
  { kind: 'transfer', re: /转账|汇款|付款|收款|红包|余额|打款|工资|欠款|还款/ },
  { kind: 'bankcard', re: /银行卡|卡号|信用卡/ },
];

const PUBLIC_MONEY_RE = /\d+(?:\.\d+)?\s*(?:元|块|万|千)/;

/**
 * 清洗要发到空间的正文。
 * 返回 { text, removed, blocked }：removed 记录删了哪几类（便于界面上一句解释），
 * blocked 表示命中「钱/账号/证件/密码」——这种先落盘但不发布，等主人自己看一眼。
 */
export function scrubPublicText(text) {
  const source = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!source) return { text: '', removed: [], blocked: false };
  const removed = [];
  const kept = [];
  for (const raw of source.split(PUBLIC_SENTENCE_SPLIT)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const hit = PUBLIC_BLOCK_PATTERNS.find((p) => p.re.test(sentence));
    const money = PUBLIC_MONEY_RE.test(sentence);
    if (hit) {
      removed.push({ kind: hit.kind, sample: sentence.slice(0, 40) });
      continue;
    }
    if (money) {
      removed.push({ kind: 'money', sample: sentence.slice(0, 40) });
      continue;
    }
    // 联系方式类只把片段抠掉，句子还留着（整句删会把日记删得没内容）
    let cleaned = sentence
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '')
      .replace(/1[3-9]\d{9}/g, '')
      .replace(/\b\d{10,}\b/g, '');
    if (cleaned !== sentence) removed.push({ kind: 'contact', sample: sentence.slice(0, 40) });
    cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
    if (cleaned) kept.push(cleaned);
  }
  const blockedKinds = new Set(['password', 'account', 'idcard', 'transfer', 'bankcard']);
  const blocked = removed.some((r) => blockedKinds.has(r.kind));
  return { text: kept.join('').trim(), removed, blocked };
}

/** 本地日期键 YYYY-MM-DD（额度按「主人这边的今天」算，不能用 UTC）。 */
export function localDayKey(now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 公开日记的每日额度：0 = 不限。用本地日期分界，不能拿 toISOString 的 UTC 日期。 */
export function publicPublishQuota({ maxPerDay = 1, published = 0, now = Date.now() }) {
  const limit = Number(maxPerDay);
  const used = Math.max(0, Number(published) || 0);
  const key = localDayKey(now);
  if (!Number.isFinite(limit) || limit <= 0) return { ok: true, usedToday: used, day: key, reason: '' };
  if (used >= limit) return { ok: false, usedToday: used, day: key, reason: `今天已经发过 ${used} 条了（上限 ${limit} 条）` };
  return { ok: true, usedToday: used, day: key, reason: '' };
}

export function formatDiaryEntry(now, text) {  const d = new Date(now);
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
