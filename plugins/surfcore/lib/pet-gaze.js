// 桌宠「注视」的纯计算层：光标屏幕坐标 + 宠物窗口中心 → 相对位移 → 朝哪看。
//
// 为什么单独一个模块：这套数学要能脱离 DOM 测（给 scripts/test-* 用），也要能在主进程里算。
// 注意 assets/orb-app/pet.js **不能 import 这里**——桌宠窗口是纯 Electron 页面，没有打包器，
// CSP 也是 `default-src 'self'`，而 lib/ 不在 app 目录里。所以 pet.js 内联了同一份公式
// （见 pet.js 的 gazeOf()），两边必须保持一致：改这里就顺手改那边。
//
// 约定：
//   · 素材默认朝左（dsh-pet 的立绘是朝左的），所以「看右边」= scaleX(-1) 镜像。
//   · 不对眼珠做图层（素材是整段动画，没有独立瞳孔通道），可用的表现是：
//       1) 选中枢动画 turn（东张西望）+ 镜像；2) 视频整体朝光标方向微移 1~4px。
//   · 20~50ms 采样：太快没意义（人眼也看不出来），太慢会「一跳一跳」。默认 40ms。

export const DEFAULT_GAZE = {
  enabled: true,
  intervalMs: 40,
  deadZonePx: 12,
  nearPx: 160,
  maxShiftPx: 4,
  minTurnMs: 5200,
};

/** 节流区间 20~50ms，非法值回默认 40。 */
export function clampGazeInterval(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return DEFAULT_GAZE.intervalMs;
  return Math.min(50, Math.max(20, Math.round(n)));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 光标相对宠物中心的朝向。
 * @param {{cursor?:{x:number,y:number}, center?:{x:number,y:number}, deadZonePx?:number,
 *          size?:number, maxShiftPx?:number, prevDir?:string, now?:number}} input
 * @returns {null | {dir:'left'|'right'|'up'|'down'|'center', mirror:boolean, dist:number,
 *          angle:number, shiftPx:number, near:boolean, dx:number, dy:number, at:number}}
 */
export function computeGaze(input = {}) {
  const cursor = input.cursor;
  const center = input.center;
  if (!cursor || !center) return null;
  const cx = Number(cursor.x);
  const cy = Number(cursor.y);
  const px = Number(center.x);
  const py = Number(center.y);
  if (![cx, cy, px, py].every((n) => Number.isFinite(n))) return null;

  const deadZone = Number.isFinite(Number(input.deadZonePx)) ? Math.max(0, Number(input.deadZonePx)) : DEFAULT_GAZE.deadZonePx;
  const size = Number.isFinite(Number(input.size)) ? Math.max(1, Number(input.size)) : 200;
  const maxShift = Number.isFinite(Number(input.maxShiftPx)) ? Math.max(0, Number(input.maxShiftPx)) : DEFAULT_GAZE.maxShiftPx;

  const dx = cx - px;
  const dy = cy - py;
  const dist = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

  // 死区：光标就在宠物身上时别乱翻面。带一点滞后，避免在边界上抖。
  const lag = input.prevDir && input.prevDir !== 'center' ? 1.6 : 1;
  let dir = 'center';
  if (Math.abs(dx) > deadZone * lag || Math.abs(dy) > deadZone * lag) {
    // 横竖比：斜方看的时候以「更偏哪边」为准，人眼对左右更敏感，所以左右用 0.85 加权。
    if (Math.abs(dx) * 0.85 >= Math.abs(dy)) dir = dx > 0 ? 'right' : 'left';
    else dir = dy > 0 ? 'down' : 'up';
  }

  return {
    dir,
    // 素材朝左：看右边才需要镜像。
    mirror: dir === 'right',
    dist,
    angle,
    // 朝光标方向整体微移（像素），给「眼神跟过去」一点身体语言。
    shiftPx: clamp(Math.round((dx / Math.max(80, size * 0.55)) * maxShift), -maxShift, maxShift),
    near: dist < (Number.isFinite(Number(input.nearPx)) ? Number(input.nearPx) : DEFAULT_GAZE.nearPx) * (size / 200),
    dx,
    dy,
    at: Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now(),
  };
}

/** 朝向 → 需不需要镜像（单独抽出来，方便测）。 */
export function mirrorFor(dir) {
  return dir === 'right';
}

/**
 * 轮询光标并给出方向变化。
 * probe() 由宿主提供：主进程用 screen.getCursorScreenPoint() + win.getBounds()，
 * 渲染端用「光标在宠物上时的 mousemove」（只有 hover 的时候拿得到，属于降级方案）。
 *
 * @param {{probe:()=>{cursor?:{x:number,y:number},center?:{x:number,y:number}}|null,
 *          intervalMs?:number, deadZonePx?:number, size?:number, onGaze?:(g:any)=>void,
 *          onChange?:(g:any)=>void, timers?:{setInterval?:Function, clearInterval?:Function}}} opts
 */
export function createGazeTracker(opts = {}) {
  const probe = opts.probe;
  if (typeof probe !== 'function') throw new TypeError('createGazeTracker 需要 probe()');
  const intervalMs = clampGazeInterval(opts.intervalMs);
  const timers = opts.timers || {};
  const setTick = typeof timers.setInterval === 'function' ? timers.setInterval : setInterval;
  const clearTick = typeof timers.clearInterval === 'function' ? timers.clearInterval : clearInterval;

  let timer = null;
  let lastDir = '';
  let lastShift = 0;
  let lastAt = 0;

  function tick() {
    let sample = null;
    try { sample = probe(); } catch { sample = null; }
    const gaze = computeGaze({
      cursor: sample?.cursor,
      center: sample?.center,
      deadZonePx: opts.deadZonePx ?? DEFAULT_GAZE.deadZonePx,
      size: opts.size,
      maxShiftPx: opts.maxShiftPx,
      prevDir: lastDir,
    });
    if (!gaze) return;
    const changed = gaze.dir !== lastDir || gaze.shiftPx !== lastShift;
    lastDir = gaze.dir;
    lastShift = gaze.shiftPx;
    lastAt = gaze.at;
    try { opts.onGaze?.(gaze); } catch {}
    if (changed) {
      try { opts.onChange?.(gaze); } catch {}
    }
  }

  return {
    intervalMs,
    start() {
      if (timer) return false;
      tick();
      timer = setTick(tick, intervalMs);
      return true;
    },
    stop() {
      if (!timer) return false;
      clearTick(timer);
      timer = null;
      return true;
    },
    running() { return Boolean(timer); },
    state() { return { dir: lastDir, shiftPx: lastShift, at: lastAt, intervalMs }; },
    tick,
  };
}

/** 距上次「转头」够不够久（渲染端用它压住 turn 动画的频率，免得一直转头像抽筋）。 */
export function canTurn(now, lastTurnAt, minTurnMs = DEFAULT_GAZE.minTurnMs) {
  const t = Number(now);
  const prev = Number(lastTurnAt);
  if (!Number.isFinite(t)) return false;
  if (!Number.isFinite(prev) || prev <= 0) return true;
  return t - prev >= (Number.isFinite(Number(minTurnMs)) ? Number(minTurnMs) : DEFAULT_GAZE.minTurnMs);
}
