// 互动监测：定时采一次「主人在干什么」——前台窗口、标题里解析出的文件/项目、
// 正在播放的媒体、光标位置，落在 <stateDir>/orb/activity.json 给悬浮窗主进程读。
//
// 设计底线：
//   - 采样脚本（scripts/activity.ps1）出错只记日志，绝不把异常抛给调用者；
//   - 标题命中 orb.screen.denyTitles 时脚本给 active=null，这里不会再补回来；
//   - 开关一关就 stop() + 删 activity.json：关了就是真的不留痕迹，而不是「不读但还在写」；
//   - 相同内容不重复写文件（渲染端按 mtime 去重，写一次就会推一次，别拿它当心跳）。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ACTIVITY_FILE = 'activity.json';
export const POLL_MIN_MS = 10000;
export const POLL_MAX_MS = 120000;
export const POLL_DEFAULT_MS = 20000;
export const BUBBLE_EVERY_DEFAULT_MS = 600000;
export const MIN_SAMPLE_GAP_MS = 5000;

const HERE = path.dirname(fileURLToPath(import.meta.url));

function clampNumber(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function asString(value) {
  return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

/** pollMs 钳在 10s~120s：太快费 CPU，太慢就谈不上「互动」。 */
export function clampPollMs(value, fallback = POLL_DEFAULT_MS) {
  return clampNumber(value, fallback, POLL_MIN_MS, POLL_MAX_MS);
}

/** 互动监测配置白名单（orb.js 的 DEFAULT_ORB.activity 也长这样）。 */
export function normalizeActivityConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const kinds = src.kinds && typeof src.kinds === 'object' ? src.kinds : {};
  return {
    enabled: src.enabled === true,
    pollMs: clampPollMs(src.pollMs, POLL_DEFAULT_MS),
    kinds: {
      window: kinds.window !== false,
      file: kinds.file !== false,
      music: kinds.music !== false,
    },
    bubbleEveryMs: clampNumber(src.bubbleEveryMs, BUBBLE_EVERY_DEFAULT_MS, 60000, 6 * 60 * 60 * 1000),
  };
}

/** 把脚本 stdout 收拾成固定形状；多出来的字段（album 之类）丢掉，契约只留这几个。 */
export function sanitizeSample(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const at = Number(raw.at);
  const data = {
    at: Number.isFinite(at) && at > 0 ? Math.round(at) : Date.now(),
    active: null,
    media: null,
    cursor: null,
  };
  if (raw.active && typeof raw.active === 'object') {
    data.active = {
      app: asString(raw.active.app),
      title: asString(raw.active.title),
      kind: asString(raw.active.kind) || 'app',
      file: asString(raw.active.file),
      project: asString(raw.active.project),
    };
  }
  if (raw.media && typeof raw.media === 'object') {
    data.media = {
      app: asString(raw.media.app),
      title: asString(raw.media.title),
      artist: asString(raw.media.artist),
      status: asString(raw.media.status),
    };
  }
  if (raw.cursor && typeof raw.cursor === 'object') {
    const x = Number(raw.cursor.x);
    const y = Number(raw.cursor.y);
    if (Number.isFinite(x) && Number.isFinite(y)) data.cursor = { x: Math.round(x), y: Math.round(y) };
  }
  return data;
}

/** 按开关裁掉不该留的字段：窗口关了整段 active 都不要，文件关了只留标题。 */
export function applyKindFilter(data, kinds) {
  if (!data) return data;
  const out = { ...data, active: data.active ? { ...data.active } : null, media: data.media ? { ...data.media } : null };
  if (!kinds.window) {
    out.active = null;
  } else if (out.active && !kinds.file) {
    out.active.file = '';
    out.active.project = '';
  }
  if (!kinds.music) out.media = null;
  return out;
}

/** 只比内容，不比 at：at 每次都变，拿它去重等于没去重。 */
export function sameActivity(a, b) {
  if (!a || !b) return false;
  return JSON.stringify({ active: a.active, media: a.media, cursor: a.cursor })
    === JSON.stringify({ active: b.active, media: b.media, cursor: b.cursor });
}

/**
 * 这一次采样相对上一次「真的变了什么」。
 * 光标每几秒都在动，但它不该让桌宠冒气泡，所以这里只看窗口/文件/音乐。
 */
export function activityChanges(prev, next) {
  const p = prev || {};
  const n = next || {};
  const pa = p.active || null;
  const na = n.active || null;
  const pm = p.media || null;
  const nm = n.media || null;
  const windowChanged = !pa !== !na || (pa && na && (pa.app !== na.app || pa.title !== na.title));
  // 第一次采到「正在改某个文件」也算变化（否则新开的编辑器要等第二次标题变才说话）。
  const fileChanged = Boolean(na && na.file)
    && (!pa || pa.file !== na.file || pa.project !== na.project || pa.kind !== na.kind);
  const musicChanged = !pm !== !nm || (pm && nm && (pm.title !== nm.title || pm.artist !== nm.artist || pm.status !== nm.status || pm.app !== nm.app));
  return { window: windowChanged, file: fileChanged, music: musicChanged };
}

function firstChangedKind(changes) {
  if (changes.file) return 'file';
  if (changes.window) return 'window';
  if (changes.music) return 'music';
  return '';
}

function parseSampleOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 继续找上一条 */ }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.stateDir 插件状态目录
 * @param {(cfg:object)=>({ok:boolean,error?:string,data?:object})} [opts.handle] 走 HTTP 时的动作入口
 */
export function createOrbActivity({
  stateDir,
  pluginLog = () => {},
  getPluginRoot = () => path.join(HERE, '..'),
  getDenyTitles = () => [],
  scriptPath = '',
  runner = null,
  now = () => Date.now(),
} = {}) {
  const root = path.join(stateDir, 'orb');
  const file = path.join(root, ACTIVITY_FILE);
  const script = scriptPath || path.join(getPluginRoot(), 'scripts', 'activity.ps1');

  let config = normalizeActivityConfig({ enabled: false });
  let timer = null;
  let running = false;
  let lastData = readFile();
  let lastError = '';
  let lastSampleAt = 0;
  let lastWriteAt = 0;
  const listeners = new Set();

  /** 订阅「采到一条新样本」。回调抛异常只记日志，绝不影响采样本身。 */
  function onSample(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  function emitSample(data, meta) {
    for (const fn of listeners) {
      try { fn(data, meta); } catch (error) {
        pluginLog('[orb-activity] onSample 回调失败：', String(error?.message ?? error));
      }
    }
  }

  function readFile() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return sanitizeSample(parsed);
    } catch { return null; }
  }

  function writeFile(data) {
    try {
      fs.mkdirSync(root, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, 'utf8');
      fs.renameSync(tmp, file);
      lastWriteAt = now();
    } catch (error) {
      pluginLog('[orb-activity] 写采样文件失败：', String(error?.message ?? error));
    }
  }

  function removeFile() {
    try { fs.rmSync(file, { force: true }); } catch (error) {
      pluginLog('[orb-activity] 删采样文件失败：', String(error?.message ?? error));
    }
  }

  function defaultRunner({ env }) {
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
        { env, timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      );
    });
  }

  async function sample(reason = 'manual', opts = {}) {
    if (running) return { ok: false, busy: true, error: '上一次采样还在跑', data: lastData };
    const forced = opts.force === true;
    const at = now();
    // 手动/定时都限流：5 秒内重复触发直接回上次结果，别把 powershell 拖成常驻。
    // 例外：设置页的「测试一下」要立刻看到效果，forced 可以绕过。
    if (!forced && lastSampleAt && at - lastSampleAt < MIN_SAMPLE_GAP_MS) {
      return { ok: false, throttled: true, error: `采样太频繁（${reason}），${MIN_SAMPLE_GAP_MS}ms 内只采一次`, retryAfterMs: MIN_SAMPLE_GAP_MS - (at - lastSampleAt), data: lastData };
    }
    running = true;
    lastSampleAt = at;
    try {
      let deny = [];
      try { deny = Array.isArray(getDenyTitles()) ? getDenyTitles().map(asString).filter(Boolean) : []; } catch { deny = []; }
      const env = { ...process.env };
      if (deny.length) env.SURFCORE_ACTIVITY_DENY = JSON.stringify(deny);
      else delete env.SURFCORE_ACTIVITY_DENY;

      const result = await (runner || defaultRunner)({ env, script, timeoutMs: 20000 });
      if (result?.error) {
        // 超时/被杀/脚本报错都只记日志：这一次没采到，下一次照常。
        const stderr = String(result.stderr || '').trim().split(/\r?\n/).slice(0, 3).join(' | ');
        lastError = String(result.error?.message || result.error);
        pluginLog('[orb-activity] 采样失败：', lastError, stderr ? `stderr=${stderr}` : '');
        return { ok: false, error: lastError, data: lastData };
      }
      const parsed = parseSampleOutput(result.stdout);
      const clean = sanitizeSample(parsed);
      if (!clean) {
        lastError = '采样脚本没有输出合法 JSON';
        pluginLog('[orb-activity] 采样脚本输出无法解析：', String(result.stdout || '').slice(0, 200));
        return { ok: false, error: lastError, data: lastData };
      }
      const filtered = applyKindFilter(clean, config.kinds);
      const changes = activityChanges(lastData, filtered);
      const changed = changes.window || changes.file || changes.music;
      const deduped = !changed && sameActivity(filtered, lastData);
      if (!deduped) {
        lastData = filtered;
        writeFile(filtered);
      }
      lastError = '';
      const kind = firstChangedKind(changes);
      // 内容没变就不打扰桌宠；forced（设置页测试）例外，即使没变也推一条。
      if (changed || forced) emitSample(filtered, { kind, changed, forced, changes, reason });
      return { ok: true, deduped, changed, changes, kind, data: deduped ? lastData : filtered };
    } catch (error) {
      lastError = String(error?.message ?? error);
      pluginLog('[orb-activity] 采样异常：', lastError);
      return { ok: false, error: lastError, data: lastData };
    } finally {
      running = false;
    }
  }

  function clearTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function schedule() {
    clearTimer();
    if (!config.enabled) return;
    timer = setInterval(() => { void sample('timer'); }, config.pollMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    config = { ...config, enabled: true };
    schedule();
    void sample('start');
    return status();
  }

  function stop() {
    config = { ...config, enabled: false };
    clearTimer();
    lastData = null;
    removeFile();
    return status();
  }

  function configure(next) {
    config = normalizeActivityConfig({ ...config, ...(next || {}), kinds: { ...config.kinds, ...(next?.kinds || {}) } });
    if (config.enabled) schedule();
    else {
      clearTimer();
      lastData = null;
      removeFile();
    }
    return status();
  }

  function last() {
    if (!lastData) lastData = readFile();
    return lastData;
  }

  function status() {
    const data = last();
    return {
      enabled: config.enabled,
      pollMs: config.pollMs,
      kinds: { ...config.kinds },
      bubbleEveryMs: config.bubbleEveryMs,
      script,
      running,
      error: lastError,
      lastAt: data?.at || 0,
      lastSampleAt,
      lastWriteAt,
      last: data,
    };
  }

  return { file, script, start, stop, status, configure, last, sample, onSample };
}
