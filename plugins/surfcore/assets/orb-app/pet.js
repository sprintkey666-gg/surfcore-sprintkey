// 桌宠形象（素材来自 dsh-pet@0.3.8，MIT，Copyright (c) 2026 PC2005-cloud）
//
// 这里只做三件事：
//   1. 把 webm 动作播出来（双 <video> 交叉淡入，单个 video 换 src 会闪黑）；
//   2. 在头顶画一个「窗口内浮层」气泡——不再按内容反复改窗口高度；
//   3. 让她知道主人在屏幕哪个方向（注视），并且偶尔真的走两步（走位）。
//
// 逻辑全都走主进程（window.orb），页面自己不发 HTTP、不碰令牌。
//
// 三条经验直接来自参考项目（dsh-pet 是 MIT，可以照抄实现；Coopanion 是 AGPL，
// 只在设计上参考了「注视方向 + 待机动作」的思路，没有复制它的代码）：
//   1. 两个 <video> 双缓冲交叉淡入；
//   2. 「只有宠物身体能点」——窗口比宠物大（头顶留气泡），其余部分必须把鼠标让回桌面；
//   3. 动作之间要有呼吸感：idle 里插 turn（东张西望）和 move（走两步），别一直站着不动。
(() => {
  'use strict';

  const stage = document.getElementById('pet');
  const stageInner = stage ? stage.querySelector('.petStage') : null;
  const vids = [document.getElementById('pvA'), document.getElementById('pvB')];
  const bubble = document.getElementById('bubble');

  const state = {
    ready: false,
    paused: false,
    cfg: null,          // { mode,size,dir,manifest,singleClickOpens,idleMinMs,idleMaxMs,gaze,wander,packId }
    manifest: null,     // 归一化后的动作清单
    files: new Map(),   // 动作名 -> file:// URL
    active: 0,          // 当前在播的 video 下标
    chain: 0,           // 播放代次：旧视频迟到的 ended 事件用它过滤
    playing: null,      // { name, kind }
    timer: null,        // 下一个随机动作
    bubbleTimer: null,
    busy: false,
    bandRequested: false,
    moveBias: 0,        // 撞到屏幕边以后反过来走
    lastTurnAt: 0,
    gaze: null,
    gazeTimer: null,
    pollTimer: null,
    failCount: 0,
    logOnce: Object.create(null),
  };

  // 素材帧 640×360，角色（含呆毛）的头顶大概在帧高的 15% 处。
  // 用这个比例把气泡尾巴钉在她脑袋上，而不是钉在窗口顶边。
  const PET_HEAD_RATIO = 0.152;
  // pet.css 里 video 的显示高度 = --pet-size * 1.22，两处必须一致。
  const PET_VIDEO_RATIO = 1.22;
  // main.js 里 PET_BUBBLE_SPACE：窗口比宠物高出的那一条固定高度。
  const PET_BUBBLE_BAND = 110;
  // 节点里最多塞这么多字，再长就 line-clamp 折叠，点气泡开面板看全文。
  const BUBBLE_MAX_CHARS = 240;
  const BUBBLE_DEFAULT_TTL = 9000;
  // 素材（dsh-pet 小鲸鱼）默认朝左；往右走要整体镜像。
  const ART_FACES_LEFT = true;
  const GAZE_TURN_GAP_MS = 5200;
  const GAZE_MIN_MS = 20;
  const GAZE_MAX_MS = 50;

  // ── 小工具 ─────────────────────────────────────────────────────────────────

  function log(msg) {
    try { window.orb?.log?.(`[pet] ${msg}`); } catch {}
  }

  function logOnce(key, msg) {
    if (state.logOnce[key]) return;
    state.logOnce[key] = true;
    log(msg);
  }

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function pick(list) {
    if (!Array.isArray(list) || !list.length) return null;
    return list[Math.floor(Math.random() * list.length)];
  }

  /** Windows 路径 → file:///C:/...；中文和空格必须转义，否则 video 直接 404。 */
  function toFileUrl(absPath) {
    const norm = String(absPath).replace(/\\/g, '/');
    const withSlash = norm.startsWith('/') ? norm : `/${norm}`;
    return encodeURI(`file://${withSlash}`);
  }

  function isLocalPath(value) {
    const s = String(value || '');
    return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('file:');
  }

  function asImageUrl(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    if (/^(data:|file:|https?:)/i.test(s)) return s;
    if (isLocalPath(s)) return toFileUrl(s);
    return '';
  }

  // ── 清单归一化（包可能来自用户，字段缺一点也不能把整只宠物搞死） ───────────

  function strList(value) {
    if (!Array.isArray(value)) return [];
    return value.map((x) => String(x ?? '').trim()).filter(Boolean);
  }

  function normalizeManifest(raw) {
    const m = raw && typeof raw === 'object' ? raw : {};
    const moves = Array.isArray(m.moves) ? m.moves : [];
    return {
      version: num(m.version, 1),
      idle: strList(m.idle),
      turn: strList(m.turn),
      drag: strList(m.drag),
      clicks: strList(m.clicks),
      moves: moves
        .map((mv) => (typeof mv === 'string' ? { name: mv, params: {} } : mv && typeof mv === 'object' ? mv : null))
        .filter((mv) => mv && String(mv.name || '').trim())
        .map((mv) => ({ name: String(mv.name).trim(), params: mv.params && typeof mv.params === 'object' ? mv.params : {} })),
      categories: (Array.isArray(m.categories) ? m.categories : [])
        .map((c) => ({
          id: String(c?.id || ''),
          weight: num(c?.weight, 1),
          noMirror: c?.noMirror === true,
          actions: strList(c?.actions),
        }))
        .filter((c) => c.actions.length),
      weights: {
        idle: num(m?.weights?.idle, 10),
        turn: num(m?.weights?.turn, 5),
        move: num(m?.weights?.move, 5),
        click: num(m?.weights?.click, 0),
        drag: num(m?.weights?.drag, 0),
      },
    };
  }

  /** 清单里出现过的所有动作名（用来判断「这个包到底有没有素材」）。 */
  function manifestActions(manifest) {
    if (!manifest) return [];
    const names = new Set();
    for (const list of [manifest.idle, manifest.turn, manifest.drag, manifest.clicks]) {
      for (const name of list || []) names.add(name);
    }
    for (const mv of manifest.moves || []) names.add(mv.name);
    for (const cat of manifest.categories || []) for (const a of cat.actions || []) names.add(a);
    return [...names];
  }

  // ── 配置 ───────────────────────────────────────────────────────────────────

  function petOpts() {
    // gaze / wander 由主进程透传（main.js → orb.js petInfo → orb:petconfig）；
    // 老版本主进程没有这两项时按默认开，行为退化但不报错。
    const pet = state.cfg || {};
    const gaze = pet.gaze && typeof pet.gaze === 'object' ? pet.gaze : {};
    const wander = pet.wander && typeof pet.wander === 'object' ? pet.wander : {};
    return {
      gaze: {
        enabled: gaze.enabled !== false,
        intervalMs: clamp(num(gaze.intervalMs, 40), GAZE_MIN_MS, GAZE_MAX_MS),
        deadZonePx: clamp(num(gaze.deadZonePx, 12), 2, 60),
        maxShiftPx: clamp(num(gaze.maxShiftPx, 4), 0, 12),
      },
      wander: {
        enabled: wander.enabled !== false,
        minMs: Math.max(0, num(wander.minMs, 0)),
        maxMs: Math.max(0, num(wander.maxMs, 0)),
      },
      idleMinMs: Math.max(1200, num(pet.idleMinMs, 6000)),
      idleMaxMs: Math.max(0, num(pet.idleMaxMs, 16000)),
    };
  }

  function wanderEnabled() {
    const w = petOpts().wander;
    const moveWeight = num(state.manifest?.weights?.move, 5);
    return w.enabled && moveWeight > 0;
  }

  // ── 气泡摆放 ───────────────────────────────────────────────────────────────
  //
  // 老做法：量出气泡全文高度 → 让主进程把窗口往上长 → 收起时再缩回去。
  // 结果是窗口一高一缩、气泡还糊着一层 backdrop-filter，丑且抖。
  //
  // 新做法：气泡是窗口里的一层浮层，位置只由「宠物头顶在哪」决定；
  // 窗口高度只在第一次需要气泡时让一次（固定 110px 的 band），之后再也不改。

  function petSizePx() {
    return Math.max(60, num(state.sizePx, 200));
  }

  /** 宠物头顶相对窗口底边的高度。 */
  function headFromBottom() {
    return petSizePx() * PET_VIDEO_RATIO * (1 - PET_HEAD_RATIO);
  }

  /** 从头到窗口顶的真实余量，气泡最多能长这么高。 */
  function headroom() {
    const H = window.innerHeight || 0;
    return Math.max(0, Math.round(H - headFromBottom() - 6));
  }

  /** 第一次要显示气泡时，请主进程把窗口让出固定的那一条（只让一次）。 */
  function ensureBand() {
    if (state.bandRequested) return;
    state.bandRequested = true;
    if (headroom() >= 64) return;
    try { void Promise.resolve(window.orb?.bubbleSpace?.(PET_BUBBLE_BAND)).catch(() => {}); } catch {}
  }

  function placeBubble() {
    if (!bubble) return;
    const H = window.innerHeight || 0;
    const room = headroom();
    // 头顶上方 6px 处是气泡底边；窗口太矮时把气泡整体往下压，保证顶边不出窗口。
    const bottom = Math.max(6, Math.min(Math.round(headFromBottom() + 6), Math.max(6, H - 56 - 6)));
    const maxH = Math.max(40, Math.min(room, H - bottom - 6));
    bubble.style.top = 'auto';
    bubble.style.bottom = `${bottom}px`;
    bubble.style.setProperty('--bubble-max', `${maxH}px`);
  }

  // ── 播放 ───────────────────────────────────────────────────────────────────

  /** 角色身高 = 窗口高度 - 头顶气泡带；pet.css 按这个值把整帧放大（--pet-size）。 */
  function setSize(px) {
    const size = Math.max(60, Number(px) || 200);
    state.sizePx = Math.round(size);
    document.documentElement.style.setProperty('--pet-size', `${state.sizePx}px`);
    placeBubble();
  }

  function idleList() { return state.manifest?.idle || []; }
  function turnList() { return state.manifest?.turn || []; }

  /**
   * 待机动作池。权重来自 manifest.weights / category.weight。
   * turn（东张西望）以前完全没被用过——它是最自然的一段「她注意到你了」，接进来。
   */
  function pickIdleAction() {
    const m = state.manifest;
    if (!m) return null;
    const w = m.weights;
    const pool = [];
    const add = (name, weight, extra) => {
      const n = Number(weight);
      if (name && Number.isFinite(n) && n > 0) pool.push({ name, weight: n, ...extra });
    };
    for (const name of m.idle) add(name, w.idle, { kind: 'idle', mirror: true });
    for (const name of m.turn) add(name, w.turn, { kind: 'turn', mirror: true });
    if (wanderEnabled()) {
      for (const mv of m.moves) add(mv.name, w.move, { kind: 'move', mirror: false, params: mv.params });
    }
    for (const cat of m.categories) {
      for (const name of cat.actions) add(name, cat.weight, { kind: 'action', mirror: cat.noMirror !== true });
    }
    const total = pool.reduce((sum, item) => sum + item.weight, 0);
    if (!total) return null;
    let r = Math.random() * total;
    for (const item of pool) {
      r -= item.weight;
      if (r <= 0) return item;
    }
    return pool[pool.length - 1] || null;
  }

  function scheduleIdle() {
    if (!state.ready) return;
    if (state.timer) clearTimeout(state.timer);
    const opts = petOpts();
    const min = opts.idleMinMs;
    const max = Math.max(min, opts.idleMaxMs);
    const wait = min + Math.random() * (max - min);
    state.timer = setTimeout(() => {
      state.timer = null;
      if (!state.ready || state.paused) { scheduleIdle(); return; }
      if (state.busy) { scheduleIdle(); return; }
      nextIdle();
    }, wait);
  }

  /** 播一个动作；播完由 onEnded 回 idle 并重新排随机动作。 */
  function play(name, options = {}) {
    const url = state.files.get(name);
    if (!url) { scheduleIdle(); return false; }
    const nextIdx = 1 - state.active;
    const next = vids[nextIdx];
    const cur = vids[state.active];
    if (!next) return false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    state.busy = true;
    state.chain += 1;
    state.playing = { name, kind: options.kind || 'idle' };
    try {
      next.loop = options.loop === true;
      if (next.getAttribute('data-src') !== url) {
        next.src = url;
        next.setAttribute('data-src', url);
      }
      next.currentTime = 0;
      const started = next.play();
      if (started && typeof started.catch === 'function') {
        started.catch((error) => {
          state.failCount += 1;
          log(`播放失败 ${name}: ${error?.message || error}`);
          if (state.failCount > 4) logOnce('play-fail', '连续播放失败，可能是素材路径失效');
        });
      }
    } catch (error) {
      log(`播放异常 ${name}: ${error?.message || error}`);
      state.busy = false;
      scheduleIdle();
      return false;
    }
    // 兜底：webm 偶尔会有「播完了但不发 ended」的情况（切后台、解码卡一下），
    // 不补这一下她就永远停在一个动作上、也不再随机换动作了。
    armWatchdog(next, name, options.loop === true);
    // 镜像：素材默认朝左，需要时整体翻转（文字类动作不能翻，否则反字）
    if (stageInner) stageInner.classList.toggle('mirror', options.mirror === true);
    next.classList.add('on');
    if (cur) cur.classList.remove('on');
    state.active = nextIdx;
    hideFallbackAvatar();
    return true;
  }

  function onEnded(event) {
    const idx = vids.indexOf(event.currentTarget);
    if (idx !== state.active) return; // 旧视频迟到的 ended，不算
    if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null; }
    state.busy = false;
    if (!state.ready) return;
    const idle = pick(idleList());
    if (idle) play(idle, { kind: 'idle' });
    scheduleIdle();
  }

  function armWatchdog(video, name, loop) {
    if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null; }
    if (loop) return; // 循环 idle 本来就不该结束
    const arm = () => {
      if (state.playing && state.playing.name !== name) return;
      const seconds = Number.isFinite(Number(video.duration)) && Number(video.duration) > 0 ? Number(video.duration) : 6;
      state.watchdog = setTimeout(() => {
        state.watchdog = null;
        if (!state.ready || state.paused) return;
        if (!state.playing || state.playing.name !== name) return;
        log(`动作 ${name} 没有正常结束，按播完处理`);
        onEnded({ currentTarget: video });
      }, Math.max(1500, Math.round(seconds * 1000) + 1500));
    };
    if (video.readyState >= 1) arm();
    else video.addEventListener('loadedmetadata', arm, { once: true });
  }

  function nextIdle() {
    const action = pickIdleAction();
    if (!action) { scheduleIdle(); return false; }
    return playAction(action);
  }

  function playAction(action) {
    if (action.kind === 'move') return walk(action);
    return play(action.name, { mirror: action.mirror === true, kind: action.kind });
  }

  /**
   * 走位：动画播的是「走两步」，真正的位置由主进程平滑搬窗口。
   * 位移只在动画时长内完成（leadSec + tailSec），撞边后主进程回 clamped，
   * 下一次就换个方向走——看起来像她在屏幕边缘掉头。
   */
  function walk(action) {
    const p = action.params || {};
    const minDist = clamp(num(p.minDist, 40), 8, 2000);
    const maxDist = Math.max(minDist, clamp(num(p.maxDist, Math.max(120, minDist * 2)), minDist, 3000));
    const leadSec = clamp(num(p.leadSec, 0), 0, 30);
    const tailSec = clamp(num(p.tailSec, 4.8), 0, 60);
    const dist = Math.round(minDist + Math.random() * (maxDist - minDist));
    const dir = state.moveBias || (Math.random() < 0.5 ? -1 : 1);
    const ms = Math.max(400, Math.round((leadSec + tailSec) * 1000));
    const playing = play(action.name, { mirror: dir > 0 ? !ART_FACES_LEFT : ART_FACES_LEFT, kind: 'move' });
    if (!playing) return false;
    const move = window.orb?.petMove;
    if (typeof move !== 'function') {
      logOnce('no-pet-move', '主进程还没有 orb:pet-move，走位降级为原地动画');
      return true;
    }
    try {
      Promise.resolve(move.call(window.orb, { dx: dir * dist, dy: 0, ms }))
        .then((res) => { state.moveBias = res && res.clamped ? -dir : 0; })
        .catch((error) => log(`走位失败：${error?.message || error}`));
    } catch (error) {
      log(`走位异常：${error?.message || error}`);
    }
    return true;
  }

  // ── 注视 ───────────────────────────────────────────────────────────────────
  //
  // 公式和 lib/pet-gaze.js 是同一份（渲染层没有打包器、CSP 又是 default-src 'self'，
  // 没法 import lib/），改一边记得同步另一边。

  function mirrorFor(dir) {
    if (dir === 'left') return !ART_FACES_LEFT;
    if (dir === 'right') return ART_FACES_LEFT;
    return false;
  }

  /** 光标屏幕坐标 → 宠物中心，给出她该朝哪边看。 */
  function computeGaze(cursor, center, options) {
    if (!cursor || !center) return null;
    const dx = num(cursor.x, NaN) - num(center.x, NaN);
    const dy = num(cursor.y, NaN) - num(center.y, NaN);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    const dead = num(options?.deadZonePx, 12);
    const maxShift = num(options?.maxShiftPx, 4);
    const dist = Math.hypot(dx, dy);
    if (dist < dead) {
      return { dir: 'center', mirror: false, dist, angle: 0, shiftPx: 0, near: false, dx: 0, dy: 0 };
    }
    // 左右权重压低一点：人在宠物正前方时不应该来回甩头。
    const horizontal = Math.abs(dx) >= Math.abs(dy) * 0.85;
    const dir = horizontal ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
    const angle = Math.atan2(dy, dx);
    const shift = maxShift > 0 ? Math.round((dx / (dist || 1)) * maxShift) : 0;
    return {
      dir,
      mirror: mirrorFor(dir),
      dist,
      angle,
      shiftPx: clamp(shift, -maxShift, maxShift),
      near: dist < num(options?.nearPx, 160),
      dx,
      dy,
    };
  }

  function applyGaze(g) {
    state.gaze = g;
    if (!stageInner) return;
    if (!g || g.dir === 'center') {
      stageInner.style.setProperty('--gaze-shift', '0px');
      return;
    }
    stageInner.style.setProperty('--gaze-shift', `${g.shiftPx || 0}px`);
  }

  /** 她所在的屏幕中心（窗口坐标 → 屏幕坐标）。 */
  function petCenterOnScreen() {
    const size = petSizePx();
    const sx = num(window.screenX, 0);
    const sy = num(window.screenY, 0);
    return {
      x: sx + (window.outerWidth || window.innerWidth || size) / 2,
      y: sy + (window.outerHeight || window.innerHeight || size) - size * 0.45,
    };
  }

  async function probeCursor() {
    const probe = window.orb?.cursor;
    if (typeof probe === 'function') {
      try {
        const point = await probe.call(window.orb);
        if (point && Number.isFinite(Number(point.x))) return { x: Number(point.x), y: Number(point.y) };
      } catch {}
    }
    return state.hoverPoint || null;
  }

  function stopGaze() {
    if (state.gazeTimer) { clearInterval(state.gazeTimer); state.gazeTimer = null; }
    applyGaze(null);
  }

  function startGaze() {
    stopGaze();
    if (state.paused) return;
    const opts = petOpts().gaze;
    if (!opts.enabled) return;
    // 启动时不要立刻扭头：第一次采样只记方向，隔够一个冷却才算「注意到」。
    if (!state.lastTurnAt) state.lastTurnAt = Date.now();
    let inflight = false;
    state.gazeTimer = setInterval(async () => {
      if (inflight || state.paused) return;
      inflight = true;
      try {
        const cursor = await probeCursor();
        if (!cursor) { return; }
        const g = computeGaze(cursor, petCenterOnScreen(), opts);
        if (!g) return;
        const changed = !state.gaze || state.gaze.dir !== g.dir;
        applyGaze(g);
        if (!changed) return;
        // 她「注意到」光标换方向的瞬间，偶尔真的扭头（东张西望），但别太频繁。
        const now = Date.now();
        if (g.dir === 'center' || g.near) return;
        if (state.busy || !turnList().length) return;
        if (now - state.lastTurnAt < GAZE_TURN_GAP_MS) return;
        state.lastTurnAt = now;
        play(pick(turnList()), { mirror: g.mirror, kind: 'turn' });
      } finally {
        inflight = false;
      }
    }, opts.intervalMs);
    logOnce('gaze-on', `注视已开启（${opts.intervalMs}ms 采样）`);
  }

  // 没有 IPC 时的兜底：鼠标停在宠物身上也能感知方向。
  window.addEventListener('mousemove', (event) => {
    state.hoverPoint = { x: event.screenX, y: event.screenY };
  }, { passive: true });

  // ── 回退形象 ───────────────────────────────────────────────────────────────
  //
  // 素材没装、包坏了、或者清单里一个动作都对不上时不至于整只宠物消失：
  // 退成一张静态头像（主进程 / orb 配置里的 avatar）。

  let fallbackImg = null;

  function hideFallbackAvatar() {
    if (!fallbackImg) return;
    fallbackImg.remove();
    fallbackImg = null;
    stage?.classList.remove('fallback');
  }

  function showFallbackAvatar(src) {
    if (!stageInner || !src) return false;
    if (!fallbackImg) {
      fallbackImg = document.createElement('img');
      fallbackImg.className = 'petFallback';
      fallbackImg.alt = '';
      fallbackImg.decoding = 'async';
      stageInner.appendChild(fallbackImg);
    }
    fallbackImg.src = src;
    stage?.classList.add('fallback');
    stage?.classList.remove('hidden');
    return true;
  }

  async function resolveAvatarUrl() {
    const fromCfg = asImageUrl(state.cfg?.avatar || state.cfg?.image);
    if (fromCfg) return fromCfg;
    try {
      const prefs = await window.orb?.prefs?.();
      const fromPrefs = asImageUrl(prefs?.avatar || prefs?.ball?.avatar || prefs?.pet?.avatar);
      if (fromPrefs) return fromPrefs;
    } catch {}
    return '';
  }

  // ── 启动 ───────────────────────────────────────────────────────────────────

  function registerFiles(dir) {
    state.files.clear();
    const base = String(dir || '').replace(/[\\/]+$/, '');
    if (!base) return 0;
    for (const name of manifestActions(state.manifest)) {
      state.files.set(name, toFileUrl(`${base}/webm/${name}.webm`));
    }
    return state.files.size;
  }

  function bindVideoEvents() {
    for (const v of vids) {
      if (!v || v.__surfPetBound) continue;
      v.__surfPetBound = true;
      v.addEventListener('ended', onEnded);
      v.addEventListener('error', () => log(`video 加载失败 ${v.getAttribute('data-src') || v.src}`));
    }
  }

  async function readPetConfig() {
    let cfg = null;
    try { cfg = await window.orb?.petconfig?.(); } catch (error) {
      log(`拿不到形象配置：${error?.message || error}`);
    }
    return cfg || null;
  }

  function applyConfig(cfg) {
    const pet = cfg?.pet || null;
    state.cfg = pet;
    state.manifest = normalizeManifest(pet?.manifest);
    const baseH = num(cfg?.base?.height, 0);
    // 角色身高 = 窗口高度 - 头顶气泡带；窗口比宠物高出的那一条就是气泡带。
    const petSize = baseH > PET_BUBBLE_BAND ? baseH - PET_BUBBLE_BAND : num(pet?.size, 200);
    setSize(petSize);
  }

  async function init() {
    // orb.js 在页面加载完后也会调一次 init()，这里别把已经在播的宠物重开一遍。
    if (state.ready) {
      const again = await readPetConfig();
      if (again?.pet && String(again.pet.dir || '') === String(state.cfg?.dir || '')) {
        applyConfig(again);
        startConfigWatch();
        return true;
      }
    }
    if (state.initing) return state.initing;
    state.initing = (async () => {
      const done = await boot();
      state.initing = null;
      return done;
    })();
    return state.initing;
  }

  async function boot() {
    const cfg = await readPetConfig();
    const pet = cfg?.pet || null;
    if (!pet || pet.mode !== 'pet') {
      stage?.classList.add('hidden');
      // 球模式下窗口不需要穿透（整块就是球）
      try { window.orb?.hit?.(true); } catch {}
      return false;
    }
    applyConfig(cfg);
    state.bandRequested = false;
    const count = registerFiles(pet.dir);
    const usable = count > 0 && state.manifest && manifestActions(state.manifest).some((n) => state.files.has(n));
    if (!usable) {
      const avatar = await resolveAvatarUrl();
      if (avatar && showFallbackAvatar(avatar)) {
        state.ready = true;
        logOnce('fallback', '素材不可用，已回退静态形象');
        placeBubble();
        return true;
      }
      log('素材不可用，也没有可回退的头像');
      stage?.classList.add('hidden');
      try { window.orb?.hit?.(true); } catch {}
      return false;
    }
    stage?.classList.remove('hidden');
    hideFallbackAvatar();
    bindVideoEvents();
    state.ready = true;
    // 先播一段循环 idle 垫底，随机动作播完都会回到它
    const first = pick(idleList()) || pick([...state.files.keys()]);
    if (first) {
      if (idleList().length) play(first, { loop: true, kind: 'idle' });
      else play(first, { loop: true, kind: 'idle' });
    }
    scheduleIdle();
    startGaze();
    placeBubble();
    log(`桌宠就绪：${state.files.size} 个动作，尺寸 ${petSizePx()}，包 ${pet.packId || pet.dir || ''}`);
    return true;
  }

  /** 换包 / 改设置后热重载：只重读配置，不重启窗口。 */
  async function refresh() {
    const cfg = await readPetConfig();
    const prevDir = String(state.cfg?.dir || '');
    const nextDir = String(cfg?.pet?.dir || '');
    const prevSig = JSON.stringify(state.manifest || null);
    const nextSig = JSON.stringify(normalizeManifest(cfg?.pet?.manifest));
    if (prevDir === nextDir && prevSig === nextSig) {
      applyConfig(cfg); // 大小 / 注视 / 走位这类开关仍然可以即时生效
      startGaze();
      return false;
    }
    stop();
    for (const v of vids) { if (v) { v.removeAttribute('data-src'); try { v.removeAttribute('src'); } catch {} } }
    state.ready = false;
    const ok = await init();
    return ok;
  }

  /**
   * 每 4s 对一次配置：换包（host.json 的 dir/manifest 变了）就重载；
   * 设置页点了「试播」时主进程会在 pet.preview 里带一条请求（name + at），这里立刻演一遍。
   * 4s 是「按钮按下去到桌宠有反应」的上限——再慢就明显卡了，再快只是白跑 IPC。
   */
  function startConfigWatch() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      void (async () => {
        const cfg = await readPetConfig();
        if (!cfg?.pet) return;
        const prevDir = String(state.cfg?.dir || '');
        const nextDir = String(cfg.pet.dir || '');
        const prevSig = JSON.stringify(state.manifest || null);
        const nextSig = JSON.stringify(normalizeManifest(cfg.pet.manifest));
        if (prevDir !== nextDir || prevSig !== nextSig) {
          log('检测到动画包变化，正在重载');
          stop();
          state.ready = false;
          await init();
        } else {
          // 大小 / 注视 / 走位这类开关不用重载，改了就生效
          applyConfig(cfg);
          if (petOpts().gaze.enabled) {
            if (!state.gazeTimer && !state.paused) startGaze();
          } else if (state.gazeTimer) {
            stopGaze();
          }
        }
        const req = cfg.pet.preview;
        if (req && req.name && Number(req.at) > num(state.lastPreviewAt, 0)) {
          state.lastPreviewAt = Number(req.at);
          if (state.ready) preview(req.name, { dir: cfg.pet.dir, mirror: req.mirror !== false });
        }
      })().catch(() => {});
    }, 4000);
  }

  // ── 交互 ───────────────────────────────────────────────────────────────────

  /** 点击反应（主人在宠物身上点一下）。 */
  function react() {
    if (!state.ready) return false;
    const name = pick(state.manifest?.clicks || []);
    if (!name) return false;
    return play(name, { kind: 'click' });
  }

  /** 拖起来的时候播拖拽动作。 */
  function drag() {
    if (!state.ready) return false;
    const name = pick(state.manifest?.drag || []);
    if (!name) return false;
    return play(name, { loop: true, kind: 'drag' });
  }

  /** 随机换个动作（右键菜单「换个动作」）。 */
  function shuffle() {
    if (!state.ready) return false;
    return nextIdle();
  }

  /** 指定动作（设置页「动作测试」用）。 */
  function action(name, options = {}) {
    if (!state.ready) return false;
    const key = String(name || '').trim();
    if (!key || !state.files.has(key)) return false;
    // 走位动作要顺带搬窗口；「走两步」被关掉时手动点播也照样走一次。
    const mv = (state.manifest?.moves || []).find((item) => item && item.name === key);
    if (mv) return walk({ name: key, params: mv.params || {} });
    return play(key, { mirror: options.mirror !== false, loop: false, kind: 'preview' });
  }

  /** 预览某个动画包里的一段（包还没启用也能看）。 */
  function preview(name, options = {}) {
    const key = String(name || '').trim();
    if (!key) return false;
    const dir = String(options.dir || state.cfg?.dir || '').replace(/[\\/]+$/, '');
    if (!dir) return false;
    if (!state.files.has(key)) state.files.set(key, toFileUrl(`${dir}/webm/${key}.webm`));
    state.ready = true;
    stage?.classList.remove('hidden');
    return play(key, { mirror: options.mirror !== false, loop: false, kind: 'preview' });
  }

  // ── 气泡 ───────────────────────────────────────────────────────────────────

  /**
   * 头顶气泡：显示她刚说的话（面板收起时才需要）。可带一张小图（图文一体）。
   * 注意：这里不再改窗口高度，气泡只是窗口里的一层浮层。
   */
  function showBubble(text, options = {}) {
    if (!bubble) return false;
    const kind = options.kind || 'her';
    const body = String(text ?? '').trim();
    const picSrc = asImageUrl(options.image);
    if (!body && !picSrc) return false;
    ensureBand();
    state.bandRequested = true;

    const textEl = document.getElementById('bubbleText');
    const pic = document.getElementById('bubblePic');
    const clipped = body.length > BUBBLE_MAX_CHARS ? `${body.slice(0, BUBBLE_MAX_CHARS - 1)}…` : body;
    if (textEl) {
      textEl.textContent = clipped;
      textEl.title = clipped === body ? '' : body; // 截断时悬停能看全
      textEl.classList.toggle('hidden', !body);
    } else {
      bubble.textContent = clipped;
    }
    if (pic) {
      if (picSrc) {
        pic.classList.remove('hidden', 'missing');
        pic.alt = '';
        pic.onerror = () => {
          // 图被删了 / 路径失效：整块图收起来，气泡只剩文字（不留破图）。
          pic.classList.add('hidden', 'missing');
          pic.removeAttribute('src');
          placeBubble();
        };
        pic.onload = () => placeBubble();
        pic.src = picSrc;
      } else {
        pic.classList.add('hidden');
        pic.removeAttribute('src');
      }
    }
    bubble.className = [
      'bubble',
      kind === 'me' ? 'me' : '',
      kind === 'proactive' ? 'proactive' : '',
      picSrc ? 'haspic' : '',
      picSrc && !body ? 'nopic' : '',
    ].filter(Boolean).join(' ');
    bubble.classList.remove('hidden');
    // 气泡显示时窗口顶上那一截要能点（点气泡＝开面板），主进程按这个标记决定穿透
    try { void window.orb?.bubbleShown?.(true); } catch {}
    placeBubble();
    bubble.onclick = () => {
      const handler = state.bubbleClick;
      hideBubble();
      if (typeof handler === 'function') handler();
    };
    state.bubbleClick = typeof options.onClick === 'function' ? options.onClick : null;
    if (state.bubbleTimer) clearTimeout(state.bubbleTimer);
    const ttl = num(options.ttlMs, BUBBLE_DEFAULT_TTL);
    if (ttl > 0) {
      state.bubbleTimer = setTimeout(() => hideBubble(), Math.max(1500, ttl));
    }
    return true;
  }

  function hideBubble() {
    const wasShown = Boolean(bubble && !bubble.classList.contains('hidden'));
    bubble?.classList.add('hidden');
    if (wasShown) { try { void window.orb?.bubbleShown?.(false); } catch {} }
    if (state.bubbleTimer) { clearTimeout(state.bubbleTimer); state.bubbleTimer = null; }
    state.bubbleClick = null;
    const textEl = document.getElementById('bubbleText');
    if (textEl) { textEl.textContent = ''; textEl.title = ''; }
    // 窗口高度不再跟着气泡变，所以这里不需要 bubbleSpace(0) 复位——
    // 一高一缩的根因就是那两次调用，去掉以后窗口是稳的。
  }

  // ── 生命周期 ───────────────────────────────────────────────────────────────

  function stop() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null; }
    stopGaze();
    for (const v of vids) { try { v.pause(); } catch {} }
    state.playing = null;
    state.busy = false;
  }

  /** 展开面板时暂停播放（省 CPU，也避免和面板动画抢帧）；收起再恢复，不重载 src。 */
  function pause() {
    state.paused = true;
    if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null; }
    stopGaze();
    for (const v of vids) { try { v.pause(); } catch {} }
  }

  function resume() {
    state.paused = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    for (const v of vids) {
      if (v && v.classList.contains('on')) {
        try { v.play()?.catch(() => {}); } catch {}
      }
    }
    scheduleIdle();
    startGaze();
    placeBubble();
  }

  /** 运行时改注视/走位开关（设置页保存后由主进程转发）。 */
  function setOptions(options = {}) {
    if (!state.cfg) return false;
    if (options.gaze && typeof options.gaze === 'object') state.cfg.gaze = { ...state.cfg.gaze, ...options.gaze };
    if (options.wander && typeof options.wander === 'object') state.cfg.wander = { ...state.cfg.wander, ...options.wander };
    if (options.size) setSize(options.size);
    startGaze();
    return true;
  }

  window.SurfPet = {
    pause,
    resume,
    init,
    react,
    drag,
    shuffle,
    action,
    preview,
    refresh,
    setOptions,
    showBubble,
    hideBubble,
    stop,
    placeBubble,
    setSize,
    // 气泡带高度（主进程按它算窗口预留的那一条）——固定值，不再随内容变
    bubbleBand: () => PET_BUBBLE_BAND,
    get ready() { return state.ready; },
    get element() { return stage; },
    get gaze() { return state.gaze; },
  };

  // 窗口尺寸变了（右键改大小、展开/收起）气泡也得跟着回到头顶
  window.addEventListener('resize', () => placeBubble());
  window.addEventListener('blur', () => applyGaze(null));

  // 自动启动：orb.js 里会在合适的时机再调一次 init()，这里先兜一下。
  startConfigWatch();
  void init().catch((error) => log(`初始化失败：${error?.message || error}`));
})();
