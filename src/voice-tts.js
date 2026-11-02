// 本地 TTS 客户端：把一段文字变成「能交给 sendVoiceV2 的本地音频文件」。
//
// 只做一件事，且失败要**可读**——桥接那层会把它翻译成 502 交给模型，
// 模型据此决定「改回打字」而不是编一句「我发了语音」。
//
// 与 voxd 的契约见 ../voice/README.md：POST /v1/speak/file → wav 字节，
// X-Duration-Ms 是时长（毫秒），X-Cached 表示是否命中服务端缓存。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';

/** 按内容寻址：同一句话重复发不会在磁盘上堆文件（voxd 端也有缓存）。 */
export function ttsKey({ baseUrl, text, character, voice, style, cacheVersion }) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify([baseUrl, cacheVersion ?? null, text, character ?? null, voice ?? null, style ?? null]))
    .digest('hex');
}

/** 从 wav 头算时长（本地命中缓存时没有响应头可用）。坏文件返回 0，不抛。 */
export function wavDurationMs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return 0;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 20 <= buf.length) byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') {
      if (!byteRate || !size) return 0;
      return Math.round((size / byteRate) * 1000);
    }
    off += 8 + size + (size % 2);
  }
  return 0;
}

/**
 * @returns {Promise<{path:string,durationMs:number,cached:boolean}>}
 * @throws  Error（message 已可直接展示给模型/操作者）
 */
export async function synthesizeToFile({
  text,
  character = '',
  voice = '',
  style = null,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 60000,
  cacheVersion = null,
  outDir,
  fetchImpl = fetch
} = {}) {
  const say = String(text ?? '').trim();
  if (!say) throw new Error('要合成的内容是空的');
  if (!outDir) throw new Error('缺少 outDir（TTS 缓存目录）');
  fs.mkdirSync(outDir, { recursive: true });

  const url = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const key = ttsKey({ baseUrl: url, text: say, character, voice, style, cacheVersion });
  const file = path.join(outDir, `${key}.wav`);
  if (fs.existsSync(file)) {
    const st = fs.statSync(file);
    if (st.size > 44) return { path: file, durationMs: wavDurationMs(fs.readFileSync(file)), cached: true };
  }

  const body = { text: say, format: 'wav', sr: 24000, cache: true };
  if (character) body.character = String(character);
  if (voice) body.voice = String(voice);
  if (style && typeof style === 'object') body.style = style;

  let res;
  try {
    res = await fetchImpl(`${url}/v1/speak/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const hint =
      error?.name === 'TimeoutError'
        ? `合成超时（>${Math.round(timeoutMs / 1000)}s）`
        : 'TTS 服务没起来（voxd 是否在运行？）';
    throw new Error(`${hint}：${error?.message ?? error}`);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.detail ?? j?.error ?? '';
    } catch {}
    throw new Error(`TTS 服务返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length <= 44) throw new Error('TTS 返回了空音频');

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  pruneCache(outDir);

  const dur = Number(res.headers.get('x-duration-ms')) || 0;
  return { path: file, durationMs: dur, cached: res.headers.get('x-cached') === '1' };
}

/**
 * 唱歌：把 buildSingPlan 出来的逐字计划交给本地模型2 的 /v1/singing。
 *
 * 和朗读分开一个函数而不是加参数，是因为缓存 key、超时、错误文案都不一样：
 * 一首歌要跑几十次推理，超时给 180s 起，缓存按「整首」算（改一个字就整首重唱）。
 * @returns {Promise<{path:string,durationMs:number,cached:boolean,engine:string,rvc:string}>}
 */
export async function synthesizeSongToFile({
  items,
  voice = '',
  tempo = 1,
  rvc = null,
  engine = 'auto',
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 180000,
  maxSeconds = 120,
  cacheVersion = null,
  outDir,
  fetchImpl = fetch
} = {}) {
  if (!Array.isArray(items) || !items.length) throw new Error('要唱的内容是空的');
  if (!outDir) throw new Error('缺少 outDir（唱歌缓存目录）');
  fs.mkdirSync(outDir, { recursive: true });

  const url = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const effEngine = ['auto', 'svs', 'syllable'].includes(String(engine)) ? String(engine) : 'auto';
  const signature = items.map((i) => `${i.text}:${i.semitone}:${i.beats}`).join('|');
  const key = ttsKey({
    baseUrl: url,
    text: signature,
    voice,
    style: { tempo, rvc: Boolean(rvc?.enabled), engine: effEngine },
    cacheVersion
  });
  const file = path.join(outDir, `song-${key}.wav`);
  if (fs.existsSync(file)) {
    const st = fs.statSync(file);
    if (st.size > 44) {
      const meta = readSongMeta(file);
      return {
        path: file,
        durationMs: wavDurationMs(fs.readFileSync(file)),
        cached: true,
        engine: meta.engine || 'tts-syllable',
        rvc: meta.rvc || 'cached',
        svsFallback: meta.svsFallback || ''
      };
    }
  }

  const body = {
    items,
    voice: String(voice || ''),
    tempo: Number(tempo) || 1,
    maxSeconds: Number(maxSeconds) || 120,
    engine: effEngine
  };
  if (rvc && typeof rvc === 'object') body.rvc = { enabled: rvc.enabled === true, endpoint: rvc.endpoint || '' };

  let res;
  try {
    res = await fetchImpl(`${url}/v1/singing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const hint =
      error?.name === 'TimeoutError'
        ? `唱歌超时（>${Math.round(timeoutMs / 1000)}s）`
        : '唱歌服务没起来（本地模型2 是否在运行？）';
    throw new Error(`${hint}：${error?.message ?? error}`);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.detail ?? j?.error ?? '';
    } catch {}
    throw new Error(`唱歌服务返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length <= 44) throw new Error('唱歌服务返回了空音频');

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  pruneCache(outDir, { maxFiles: 120, maxBytes: 200 * 1024 * 1024 });

  // 引擎信息要跟着缓存走：命中缓存时响应头已经没了，只能靠这个 sidecar 还原「这是真 SVS 还是清唱」。
  // skipped：极个别字连重试+换模板都唱不出来时，适配器会留静音一拍并报数，别假装唱全了。
  // 适配器的中文原因走 percent-encode（HTTP 头只能 latin-1），这里解回人类可读文本。
  const pct = (v) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  const info = {
    engine: res.headers.get('x-engine') || 'tts-syllable',
    rvc: res.headers.get('x-rvc') || 'off',
    svsFallback: pct(res.headers.get('x-svs-fallback') || ''),
    skipped: Number(res.headers.get('x-skipped-chars')) || 0,
    skippedChars: pct(res.headers.get('x-skipped') || '')
  };
  writeSongMeta(file, info);

  return {
    path: file,
    durationMs: Number(res.headers.get('x-duration-ms')) || wavDurationMs(fs.readFileSync(file)),
    cached: res.headers.get('x-cached') === '1',
    ...info
  };
}

function songMetaPath(file) {
  return `${file}.meta.json`;
}

function writeSongMeta(file, info) {
  try {
    fs.writeFileSync(songMetaPath(file), JSON.stringify(info));
  } catch {
    // 写不进 sidecar 只影响「缓存命中时显示哪个引擎」，不能因此让这次唱歌失败。
  }
}

function readSongMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(songMetaPath(file), 'utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * 合成缓存是有上限的：按字节数寻址意味着**每句新话都多一个文件**，长期跑会长到几万个。
 * 这里按 mtime 从旧到新删，直到回到水位以下（默认 400 个 / 150MB）。
 * 失败一律吞掉——缓存清理绝不能影响"这条语音能不能发出去"。
 */
export function pruneCache(dir, { maxFiles = 400, maxBytes = 150 * 1024 * 1024 } = {}) {
  let entries;
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.wav'))
      .map((e) => {
        const p = path.join(dir, e.name);
        try {
          const st = fs.statSync(p);
          return { p, size: st.size, at: st.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return { removed: 0, files: 0, bytes: 0 };
  }
  let total = entries.reduce((n, e) => n + e.size, 0);
  let count = entries.length;
  if (count <= maxFiles && total <= maxBytes) return { removed: 0, files: count, bytes: total };

  entries.sort((a, b) => a.at - b.at);
  let removed = 0;
  for (const e of entries) {
    if (count <= maxFiles && total <= maxBytes) break;
    try {
      fs.unlinkSync(e.p);
      count -= 1;
      total -= e.size;
      removed += 1;
    } catch {}
  }
  return { removed, files: count, bytes: total };
}
