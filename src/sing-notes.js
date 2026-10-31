/**
 * 唱歌的「谱子」解析：把主人/AI 给的简谱、音名或半音数组，变成逐字的音高表。
 *
 * 为什么单独一个纯函数模块：
 *   - 旋律输入的写法很杂（`1 2 3`、`C4 D4 E4`、`[0,2,4]`），错一个字符就会唱跑调，
 *     所以解析规则必须能被单测钉死（scripts/test-sing-notes.mjs）。
 *   - 桥接和适配器都要用同一套规则：桥接要校验、要回显，适配器要算 k=2^(半音/12)。
 *
 * 约定：
 *   - 半音数相对 C4（do = 0），`null` 表示休止（不唱、只留时间）。
 *   - 歌词里 `_` 表示「前一个字多唱一拍」（连音），不单独占字。
 *   - `notes` 比歌词少：最后一个音延长到够；比歌词多：报错并指位置（宁可报错也不瞎猜）。
 */

const MAJOR = [0, 2, 4, 5, 7, 9, 11]; // 简谱 1-7 → C 大调半音
const NAME_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export const PENTATONIC = [0, 2, 4, 7, 9];

export const DEFAULT_BEAT_SECONDS = 0.44;
export const MAX_BEATS = 64;

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 一个 token → {semitone, beats}。看不懂就抛错，别静默当休止。 */
export function parseNoteToken(token) {
  const raw = String(token ?? '').trim();
  if (!raw) return { semitone: null, beats: 0, rest: true };
  let body = raw;
  let beats = 1;
  // 尾部 `_` 每多一个就多一拍（`5_` = 唱两拍）
  while (body.endsWith('_')) {
    beats += 1;
    body = body.slice(0, -1);
  }
  if (!body) throw new Error(`音符合法性：${raw} 只有连音标记，没有音高`);
  if (beats > MAX_BEATS) throw new Error(`音符 ${raw} 连音太长（最多 ${MAX_BEATS} 拍）`);

  // 休止：0 / - / r
  if (body === '0' || body === '-' || body.toLowerCase() === 'r') {
    return { semitone: null, beats, rest: true };
  }

  // 音名：C4 / D#5 / Eb3 / c4
  const nameMatch = /^([A-Ga-g])([#b♯♭]?)(-?\d+)$/.exec(body);
  if (nameMatch) {
    const letter = nameMatch[1].toUpperCase();
    const accidental = nameMatch[2];
    const octave = Number(nameMatch[3]);
    if (!Number.isFinite(octave) || octave < -1 || octave > 9) throw new Error(`音符 ${raw} 的八度不合法`);
    let semitone = NAME_BASE[letter] + (octave - 4) * 12;
    if (accidental === '#' || accidental === '♯') semitone += 1;
    if (accidental === 'b' || accidental === '♭') semitone -= 1;
    return { semitone, beats, rest: false };
  }

  // 简谱：1-7 可带升降号和八度点
  const numeric = /^([#b♯♭]?)([0-7])(['’,，]*)$/.exec(body);
  if (numeric) {
    const accidental = numeric[1];
    const digit = Number(numeric[2]);
    const octaveMarks = numeric[3] || '';
    let semitone = digit === 0 ? null : MAJOR[digit - 1];
    if (semitone !== null) {
      if (accidental === '#' || accidental === '♯') semitone += 1;
      if (accidental === 'b' || accidental === '♭') semitone -= 1;
      for (const mark of octaveMarks) semitone += mark === ',' || mark === '，' ? -12 : 12;
    }
    return { semitone, beats, rest: semitone === null };
  }

  // 纯数字（整数或小数）当半音偏移，方便程序生成
  const plain = toNumberOrNull(body);
  if (plain !== null && /^-?\d+(\.\d+)?$/.test(body)) {
    const semitone = Math.round(plain);
    return { semitone, beats, rest: false };
  }

  throw new Error(`看不懂这个音符：${raw}（支持 1-7 简谱、C4 音名、整数半音、0 休止、后缀 _ 连音）`);
}

/**
 * 解析旋律串。空输入返回空数组，由调用方用五声音阶补齐。
 * @param {string|Array<string|number>} input
 */
export function parseNotes(input) {
  if (input === undefined || input === null) return { notes: [], source: 'empty' };
  let tokens = [];
  let source = 'string';
  if (Array.isArray(input)) {
    tokens = input.map((x) => String(x));
    source = 'array';
  } else {
    const text = String(input).trim();
    if (!text) return { notes: [], source: 'empty' };
    // 允许 `1,2,3` / `1 2 3` / `C4|D4` 混着写
    tokens = text.split(/[\s,|/]+/).filter(Boolean);
  }
  const notes = tokens.map((t) => parseNoteToken(t));
  return { notes, source };
}

/** 歌词切成「一个字 + 该字唱几拍」；`_` 延长**前一个字**（写在字后面才对）。 */
export function splitLyrics(lyrics) {
  const text = String(lyrics ?? '').replace(/[\r\n\t]+/g, ' ');
  const syllables = [];
  for (const ch of text) {
    if (ch === '_') {
      if (!syllables.length) throw new Error('歌词不能以连音符号 _ 开头');
      const last = syllables[syllables.length - 1];
      last.beats += 1;
      if (last.beats > MAX_BEATS) throw new Error(`「${last.text}」连音太长（最多 ${MAX_BEATS} 拍）`);
      continue;
    }
    if (/\s/.test(ch)) continue;
    syllables.push({ text: ch, beats: 1 });
  }
  if (!syllables.length) throw new Error('歌词是空的');
  return syllables;
}

/** 只给歌词没给旋律时的兜底：五声音阶循环，保证永远唱得出来。 */
export function notesFromScale(length, { scale = PENTATONIC, root = 0, span = 2 } = {}) {
  const out = [];
  const pool = Array.isArray(scale) && scale.length ? scale : PENTATONIC;
  for (let i = 0; i < length; i += 1) {
    // 上行到顶再下行，比一直往上爬更像哼歌
    const period = pool.length * 2 - 2 || 1;
    const step = i % period;
    const idx = step < pool.length ? step : period - step;
    const octave = Math.min(span - 1, Math.floor(i / period));
    out.push({ semitone: root + pool[idx] + octave * 12, beats: 1, rest: false });
  }
  return out;
}

/**
 * 把歌词和旋律对齐成逐字计划。
 * @returns {{plan: Array<{text:string, semitone:number|null, beats:number}>, warnings: string[], source: string}}
 */
export function buildSingPlan(lyrics, notesInput, { allowScaleFallback = true } = {}) {
  const syllables = splitLyrics(lyrics);
  const parsed = parseNotes(notesInput);
  let notes = parsed.notes;
  const warnings = [];
  let source = parsed.source;

  if (!notes.length) {
    if (!allowScaleFallback) throw new Error('没有给旋律，也没允许用五声音阶兜底');
    notes = notesFromScale(syllables.length);
    source = 'scale';
    warnings.push('没给旋律，按五声音阶哼');
  }

  if (notes.length > syllables.length) {
    throw new Error(`旋律有 ${notes.length} 个音，歌词只有 ${syllables.length} 个字（第 ${syllables.length + 1} 个音开始多出来了）`);
  }
  if (notes.length < syllables.length) {
    const missing = syllables.length - notes.length;
    const last = notes[notes.length - 1];
    notes = [...notes, ...Array.from({ length: missing }, () => ({ ...last, beats: 1 }))];
    warnings.push(`旋律比歌词短 ${missing} 个字，后面都用最后一个音（${last.semitone ?? '休止'}）唱`);
  }

  const plan = syllables.map((syl, i) => {
    const note = notes[i] || { semitone: null, beats: 1 };
    // 歌词自带的连音（`我_`）和音符上的连音（`5_`）取大的那个
    const beats = Math.max(1, Number(syl.beats) || 1, Number(note.beats) || 1);
    return { text: syl.text, semitone: note.rest === true ? null : note.semitone, beats };
  });

  for (const item of plan) {
    if (item.semitone !== null && (item.semitone < -36 || item.semitone > 36)) {
      throw new Error(`音高 ${item.semitone} 半音超出可唱范围（-36 ~ 36）`);
    }
  }
  return { plan, warnings, source };
}

/** 半音 → 频率倍数（适配器用它算 asetrate 的 k）。 */
export function semitoneRatio(semitones) {
  const n = Number(semitones);
  if (!Number.isFinite(n)) return 1;
  return Math.pow(2, n / 12);
}

/** 整段预计时长（秒），给桥接做上限校验用。 */
export function planSeconds(plan, beatSeconds = DEFAULT_BEAT_SECONDS) {
  const beat = Number(beatSeconds) > 0 ? Number(beatSeconds) : DEFAULT_BEAT_SECONDS;
  return plan.reduce((sum, item) => sum + Math.max(1, item.beats || 1) * beat, 0);
}
