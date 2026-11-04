// 桌宠形象（素材来自 dsh-pet@0.3.8，MIT，Copyright (c) 2026 PC2005-cloud）
//
// 这里只做四件事：
//   1. 把 webm 动作播出来。三层模型：idleA / idleB 常驻循环垫底（交叉淡入），
//      动作单独一层盖在最上面——任何切层都等「新的一路首帧解出来」再改 opacity，
//      所以换动作不闪黑、播完回待机也不闪回初始帧；
//   2. 在头顶画一个「窗口内浮层」气泡——不再按内容反复改窗口高度；
//   3. 让她知道主人在屏幕哪个方向（注视），并且偶尔真的走两步（走位）；
//   4. 网页形象（figure）包：video 全藏起来，换成一个 iframe，用 postMessage 收发动作。
//
// 逻辑全都走主进程（window.orb），页面自己不发 HTTP、不碰令牌。
(() => {
  'use strict';

  const stage = document.getElementById('pet');
  const stageInner = stage ? stage.querySelector('.petStage') : null;
  // 垫底的两路待机（常驻循环，只在首帧就绪后交叉淡入）
  const idleVids = [document.getElementById('pvA'), document.getElementById('pvIdleB')];
  // 动作层：盖在待机层上面，播完淡出、露回一直在跑的待机
  const actionVid = document.getElementById('pvAction');
  // 网页形象：figure 包用 iframe 撑满宠物区
  const figureFrame = document.getElementById('petFigure');
  const bubble = document.getElementById('bubble');
  const vids = [...idleVids, actionVid].filter(Boolean);

  const state = {
    ready: false,
    paused: false,
    initing: null,
    cfg: null,          // { mode,size,dir,manifest,singleClickOpens,idleMinMs,idleMaxMs,gaze,wander,packId,packKind,packEntry }
    manifest: null,     // 归一化后的动作清单
    files: new Map(),   // 动作名 -> file:// URL
    sizePx: 200,
    idleActive: 0,      // 当前在台上的待机层下标
    idleName: '',       // 当前待机动作名
    idleToken: 0,       // 待机层代次：迟到的淡入作废
    actionName: '',
    actionToken: 0,
    chain: 0,           // 播放代次：旧视频迟到的 ended 事件用它过滤
    playing: null,      // { name, kind } 动作层在播什么
    timer: null,        // 下一个随机动作
    wanderTimer: null,  // 漫游（搬窗口）专用计时器；只有它和菜单能搬窗口
    dimmed: false,      // 底色层此刻是否让位给动作层
    bubbleTimer: null,
    watchdog: null,
    bubbleClick: null,
    busy: false,
    bubbleBody: null,    // .bubbleBody：正文的限高/滚动层（运行时包出来的）
    bubbleBand: 0,       // 主进程当前给的气泡带高度（0 = 还没申请过）
    bubbleWidth: 0,      // 主进程当前给的窗口宽度
    bubbleShift: 0,      // 为了放下长气泡，主进程把窗口往下让了多少（>0 才需要复位）
    bubbleFitToken: 0,   // 两趟测量的代次：迟到的测量结果作废
    moveBias: 0,        // 撞到屏幕边以后反过来走
    lastTurnAt: 0,
    gaze: null,
    gazeTimer: null,
    pollTimer: null,
    failCount: 0,
    hoverPoint: null,
    lastPreviewAt: 0,
    packKind: 'webm',   // 'webm' | 'figure'
    figureEntry: '',
    figureReady: false,
    figureActions: [],
    figureResolve: null,
    figureGazeAt: 0,
    logOnce: Object.create(null),
  };

  // 素材帧 640×360，角色（含呆毛）的头顶大概在帧高的 15% 处。
  // 用这个比例把气泡尾巴钉在她脑袋上，而不是钉在窗口顶边。
  const PET_HEAD_RATIO = 0.152;
  // pet.css 里 video 的显示高度 = --pet-size * 1.22，两处必须一致。
  const PET_VIDEO_RATIO = 1.22;
  // main.js 里 PET_BUBBLE_SPACE：窗口比宠物高出的那一条最小高度。
  const PET_BUBBLE_BAND = 110;
  // 气泡底边离宠物头顶的距离（参考实现 bubble_rect_for_anchor 的 gap = 12）
  const BUBBLE_GAP = 10;
  // 气泡带上沿再留一点，别贴着窗口顶边
  const BUBBLE_TOP_PAD = 8;
  // 窗口左右给气泡留的透明边（气泡不会贴死窗口边缘）
  const BUBBLE_EDGE_PAD = 12;
  // 再窄就变成竖条了：用户实测被窗口 174px 卡成每行两三个字
  const BUBBLE_MIN_W = 240;
  // 参考实现的列宽：短句 248px，超过 30 字就开始放宽（以前是 60 字，中文长句
  // 在 248px 里要折 6~7 行，竖着顶到屏幕外就被切了），最宽 400px。
  const BUBBLE_COLUMN = 248;
  const BUBBLE_COLUMN_MAX = 400;
  const BUBBLE_COLUMN_GROWTH_CHARS = 30;
  const BUBBLE_COLUMN_GROWTH_SPAN = 80;
  // 主进程那边的带高上限（跟 main.js 的 600 对齐）
  const BUBBLE_BAND_MAX = 600;
  // 尾巴尖离气泡圆角边缘的最小距离
  const BUBBLE_TAIL_PAD = 16;
  // 节点里最多塞这么多字，再长就折叠，点气泡开面板看全文。
  const BUBBLE_MAX_CHARS = 240;
  const BUBBLE_DEFAULT_TTL = 9000;
  // 素材（dsh-pet 小鲸鱼）默认朝左；往右走要整体镜像。
  const ART_FACES_LEFT = true;
  const GAZE_TURN_GAP_MS = 5200;
  const GAZE_MIN_MS = 20;
  const GAZE_MAX_MS = 50;
  // 待机层交叉淡入 / 动作层淡出，跟 pet.css 里的 transition 对齐
  const IDLE_FADE_MS = 200;
  const ACTION_FADE_MS = 200;
  // 动作层亮起前，先让底色层淡出这么久（pet.css 的 .dim 跟它对齐）。
  // 两层同时不透明就是「重影」——动作是带 alpha 的视频，透明区会透出底下的鲸鱼。
  const DIM_FADE_MS = 90;
  // 等首帧的上限：本地 file:// 一般 30-80ms 就有帧，超过这个数就直接放行，别把动作卡死
  const FIRST_FRAME_MS = 900;
  // 网页形象多久没喊 ready 就当它坏了，退回 webm
  const FIGURE_READY_MS = 6000;
  // 气泡场景 → CSS class 后缀（bubble--chat / --notice / --event / --news / --error）
  const BUBBLE_KIND_ALIAS = {
    chat: 'chat',
    her: 'chat',
    proactive: 'chat',
    me: 'me',
    notice: 'notice',
    event: 'event',
    news: 'news',
    error: 'error',
  };

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

  /** 本地路径 → file:// URL；已经是 URL 的原样用。 */
  function asPageUrl(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    if (/^file:/i.test(s)) return s;
    if (isLocalPath(s)) return toFileUrl(s);
    if (/^https?:/i.test(s)) return s;
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
    // gaze / wander 由主进程透传（main.js → orb.js petInfo → orb:petconfig）。
    // wander 默认 **关**：以前默认开，鼠标划过正好抽到 manifest 里的 move 动作，
    // 就会真的把窗口搬走（主人实证投诉「鼠标划过就移动」）。要漫游必须显式打开。
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
        enabled: wander.enabled === true,
        minMs: Math.max(0, num(wander.minMs, 0)),
        maxMs: Math.max(0, num(wander.maxMs, 0)),
      },
      idleMinMs: Math.max(1200, num(pet.idleMinMs, 6000)),
      idleMaxMs: Math.max(0, num(pet.idleMaxMs, 16000)),
    };
  }

  /** 走位只在这一个开关打开时才允许自动发生（默认 false，见 petOpts 注释）。 */
  function wanderEnabled() {
    const w = petOpts().wander;
    if (w.enabled !== true) return false;
    const moveWeight = num(state.manifest?.weights?.move, 5);
    return moveWeight > 0;
  }

  // ── 气泡摆放 ───────────────────────────────────────────────────────────────
  //
  // 用户实测的坏样子：窗口只有 174px 宽，气泡被卡成一条竖着的白条，每行两三个字，
  // 而且压在鲸鱼身上。所以气泡的几何必须分两步走：
  //
  //   ① 量（fitBubble）：按目标宽度先排一遍，量出正文高度 → 请主进程把窗口
  //      往上长（band）和左右加宽（width）。主进程保证「脚底不动、水平中心不动」，
  //      所以她不会因为气泡变大而挪位置。
  //   ② 摆（placeBubble）：气泡底边 = 头顶 + BUBBLE_GAP，最高不超过头顶以上的
  //      空间（band - 12），装不下就在气泡内部滚动，绝不允许往下压到她身上。
  //
  // 参考 dsh-pet-indesktop 的 bubble_rect_for_anchor：气泡与身体留 12px 空隙、
  // 水平居中在身体上、优先放头顶上方；列宽 248px 起、长文案最多放宽到 360px。

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
    return Math.max(0, Math.round(H - headFromBottom() - BUBBLE_GAP));
  }

  /** 正文的目标列宽：短句 248，超过 60 字开始放宽，到 360 封顶（参考实现同口径）。 */
  function bubbleTargetWidth(chars, hasPic) {
    const n = Math.max(0, Number(chars) || 0);
    const grow = clamp((n - BUBBLE_COLUMN_GROWTH_CHARS) / BUBBLE_COLUMN_GROWTH_SPAN, 0, 1);
    const column = Math.round(BUBBLE_COLUMN + (BUBBLE_COLUMN_MAX - BUBBLE_COLUMN) * grow);
    // 带图的卡至少也和短句一样宽，不然图被挤成一小块
    const want = Math.max(BUBBLE_MIN_W, hasPic ? Math.max(column, BUBBLE_MIN_W) : column);
    return Math.min(want, BUBBLE_COLUMN_MAX);
  }

  /**
   * 正文的限高/滚动层。`#bubble` 必须留着 `overflow: visible` 才能画出框外那条
   * 尾巴尖角（overflow-y:auto 会把 ::after 一起裁掉），所以这里在运行时把内容
   * 包进一层 `.bubbleBody`，限高和滚动都落在它身上（index.html 不用改）。
   */
  function ensureBubbleBody() {
    if (!bubble) return null;
    if (state.bubbleBody && bubble.contains(state.bubbleBody)) return state.bubbleBody;
    let body = document.getElementById('bubbleBody');
    if (!body) {
      body = document.createElement('div');
      body.id = 'bubbleBody';
      body.className = 'bubbleBody';
      while (bubble.firstChild) body.appendChild(bubble.firstChild);
      bubble.appendChild(body);
    }
    state.bubbleBody = body;
    return body;
  }

  /** 请主进程给窗口让出气泡带与宽度（老参数 `bubbleSpace(110)` 也兼容）。 */
  function requestBubbleSpace(opts) {
    try {
      const fn = window.orb?.bubbleSpace;
      if (typeof fn !== 'function') return Promise.resolve(null);
      return Promise.resolve(fn(opts)).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  /** 等窗口真的按新尺寸重排两帧（applyBounds 之后的 innerWidth/innerHeight 才会变）。 */
  function settleFrames() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 0); return; }
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }

  /**
   * 两趟测量：按目标宽度量高度 → 申请 band/width → 等窗口变完 → 若宽度被
   * 工作区夹小了就按夹后的宽度再量一次（正文更高，带高跟着涨）→ 摆位。
   * 代次 token 保证连点「试一下气泡」时只有最后一次算数。
   */
  async function fitBubble() {
    if (!bubble || bubble.classList.contains('hidden')) return false;
    const body = ensureBubbleBody();
    if (!body) return false;
    const token = (state.bubbleFitToken += 1);
    const textEl = document.getElementById('bubbleText');
    const pic = document.getElementById('bubblePic');
    const chars = (textEl?.textContent || '').length;
    const hasPic = !!(pic && !pic.classList.contains('hidden'));
    const screenW = Math.max(320, Math.round(Number(window.screen?.availWidth) || 1920));
    let colW = Math.min(bubbleTargetWidth(chars, hasPic), screenW - 2 * BUBBLE_EDGE_PAD);
    for (let pass = 0; pass < 2; pass += 1) {
      // 量之前必须放开限高，量到的才是全文高度
      bubble.style.width = `${Math.round(colW)}px`;
      bubble.style.setProperty('--bubble-max', 'none');
      if (state.bubbleBody) state.bubbleBody.style.maxHeight = 'none';
      const contentH = Math.max(24, Math.ceil(bubble.scrollHeight));
      if (token !== state.bubbleFitToken) return false;
      const needBand = Math.max(PET_BUBBLE_BAND, Math.min(BUBBLE_BAND_MAX, contentH + BUBBLE_GAP + BUBBLE_TOP_PAD));
      const needWidth = Math.max(BUBBLE_MIN_W + 2 * BUBBLE_EDGE_PAD, Math.round(colW) + 2 * BUBBLE_EDGE_PAD);
      const res = await requestBubbleSpace({ band: needBand, width: needWidth });
      if (token !== state.bubbleFitToken) return false;
      const gotBand = Math.round(Number(res?.band) || 0);
      const gotWidth = Math.round(Number(res?.width) || 0);
      state.bubbleBand = gotBand || needBand;
      state.bubbleWidth = gotWidth || needWidth;
      // 主进程为了放下长气泡，可能把整个窗口往下让了一截（她临时下移）。
      // 记下来，气泡收起时再让主进程把位置还回去。
      const gotShift = Math.round(Number(res?.shift) || 0);
      if (gotShift > 0) state.bubbleShift = gotShift;
      const clamped = gotWidth > 0 && gotWidth + 4 < needWidth;
      const clipped = res?.clipped === true;
      log(`[bubble] fit pass=${pass + 1} chars=${chars} colW=${Math.round(colW)} contentH=${contentH} -> band=${state.bubbleBand} width=${state.bubbleWidth}${gotShift ? ` shift=${gotShift}` : ''}${clipped ? '（屏幕放不下，正文改为滚动）' : ''}${clamped ? '（width 被工作区夹小）' : ''}${res ? '' : '（bubbleSpace 不可用）'}`);
      if (!res) log('[bubble] space api 没生效：preload/main 没有回 band/width');
      await settleFrames();
      if (token !== state.bubbleFitToken) return false;
      // 窗口宽度可能没长到我们要的那么多：按真实可用宽度重排一次，第二趟把带高补够
      const realW = Math.max(120, Math.round((window.innerWidth || 0) - 2 * BUBBLE_EDGE_PAD));
      if (pass === 0 && realW < Math.round(colW) - 2) {
        colW = Math.min(colW, realW);
        continue;
      }
      break;
    }
    placeBubble();
    return true;
  }

  function placeBubble() {
    if (!bubble) return;
    const H = window.innerHeight || 0;
    const W = window.innerWidth || 0;
    // 气泡底边固定在头顶上方 BUBBLE_GAP 处；她往下压不到——气泡只往上长，不往下压
    const bottom = Math.max(6, Math.round(headFromBottom() + BUBBLE_GAP));
    // 最高不超带高 - 12：超出来的部分在正文里滚动，不会盖到她脑袋上
    const bandLimit = Math.max(48, (state.bubbleBand || PET_BUBBLE_BAND) - 12);
    const room = Math.max(48, Math.min(bandLimit, H - bottom - 4));
    bubble.style.top = 'auto';
    bubble.style.bottom = `${bottom}px`;
    bubble.style.setProperty('--bubble-max', `${Math.round(room)}px`);
    // 正文那一层的限高要把内边距和描边扣掉，否则正文会溢出框外压到她身上
    const body = state.bubbleBody;
    if (body) {
      let chrome = 37;
      try {
        const cs = getComputedStyle(bubble);
        const px = (v) => parseFloat(v) || 0;
        chrome = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
      } catch {}
      body.style.maxHeight = `${Math.max(40, Math.round(room - chrome))}px`;
    }
    // 尾巴尖指向宠物头顶中心：视频在窗口里水平居中，注视只会让她来回偏几像素
    try {
      const rect = bubble.getBoundingClientRect();
      const bw = Math.round(rect.width);
      let gaze = 0;
      if (stageInner) {
        const shift = parseFloat(getComputedStyle(stageInner).getPropertyValue('--gaze-shift'));
        if (Number.isFinite(shift)) gaze = shift;
      }
      const petCx = (W || window.innerWidth || 0) / 2 + gaze;
      const tailX = clamp(petCx - rect.left, BUBBLE_TAIL_PAD, Math.max(BUBBLE_TAIL_PAD, bw - BUBBLE_TAIL_PAD));
      bubble.style.setProperty('--tail-x', `${Math.round(tailX)}px`);
      bubble.style.setProperty('--bubble-tail-x', `${Math.round(tailX)}px`);
    } catch {}
  }

  /** 等这一层真的出了一帧再切 opacity（这就是「不闪」的关键）。 */
  function whenFirstFrame(video, timeoutMs = FIRST_FRAME_MS) {
    if (!video) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      let rvfcId = null;
      let timer = null;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { if (rvfcId != null && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(rvfcId); } catch {}
        resolve(ok);
      };
      timer = setTimeout(() => finish(video.readyState >= 2), Math.max(120, timeoutMs));
      if (typeof video.requestVideoFrameCallback === 'function') {
        try { rvfcId = video.requestVideoFrameCallback(() => finish(true)); } catch { rvfcId = null; }
      } else if (video.readyState >= 2) {
        finish(true);
      }
    });
  }

  // ── 播放：三层模型 ─────────────────────────────────────────────────────────

  /**
   * 每一层同一时刻只允许一个在途 play()。
   * 上一个 play() 还没 settle 就紧跟着 pause()/再 play()，Chromium 会抛
   * 「The play() request was interrupted by a call to pause()」——这类 rejection
   * 是「切得快」的正常产物，吞掉并记一行 layer-play-race，不要让它冒成未捕获异常。
   */
  const pendingPlay = new Map();
  async function safePlay(video, layer) {
    if (!video) return false;
    const prev = pendingPlay.get(video);
    if (prev) { try { await prev; } catch {} }
    let started;
    try {
      started = video.play();
    } catch (error) {
      log(`layer-play-race ${layer || ''} ${String(error?.name || '')} ${String(error?.message || error)}`.trim());
      return false;
    }
    const guarded = Promise.resolve(started).then(
      () => true,
      (error) => {
        const name = String(error?.name || '');
        const msg = String(error?.message || error);
        if (name === 'AbortError' || /interrupted by a call to (pause|load)/i.test(msg)) {
          log(`layer-play-race ${layer || ''} ${name} ${msg}`.trim());
          return false;
        }
        state.failCount += 1;
        log(`播放失败 ${layer || ''}: ${msg}`);
        return false;
      },
    );
    pendingPlay.set(video, guarded);
    try {
      return await guarded;
    } finally {
      if (pendingPlay.get(video) === guarded) pendingPlay.delete(video);
    }
  }

  /**
   * 底色层让位。动作层是带 alpha 的 webm，透明区会透出底下一直在循环的待机层：
   * 两层各摆一个姿势，看起来就是「重影」。所以动作亮起前先把底色压到 0，
   * 动作淡出时再把它亮回来（不是两个都亮着交叉淡入）。
   */
  function dimBase(on) {
    const want = on === true;
    if (state.dimmed === want) return;
    state.dimmed = want;
    for (const v of idleVids) {
      if (!v) continue;
      v.classList.toggle('dim', want);
    }
    log(`[layer] base dim=${want ? 'on' : 'off'}`);
  }

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
   *
   * move（走位）**永远不进这个池子**：待机是每 6~16 秒抽一次的，抽到 move 就会真的
   * 搬窗口；鼠标划过触发 react() → 也走这个池子，于是「手一挥她就跑」。走位只由
   * 漫游计时器（wander.enabled，默认关）或右键菜单「走一走」显式触发。
   */
  function pickIdleAction() {
    const m = state.manifest;
    if (!m) return null;
    const w = m.weights;
    const pool = [];
    // 有些包的 manifest 会把 walk 素材也塞进 categories：按名字再挡一次，
    // 不然「随机抽动作」抽到它，她的窗口还是会自己跑。
    const moveNames = new Set((m.moves || []).map((mv) => mv?.name).filter(Boolean));
    const add = (name, weight, extra) => {
      const n = Number(weight);
      if (!name || !Number.isFinite(n) || n <= 0) return;
      if (moveNames.has(name)) return;
      pool.push({ name, weight: n, ...extra });
    };
    for (const name of m.idle) add(name, w.idle, { kind: 'idle', mirror: true });
    for (const name of m.turn) add(name, w.turn, { kind: 'turn', mirror: true });
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

  /**
   * 待机垫底：两路常驻循环交叉淡入。
   * 顺序是「装载 → play() → 等首帧 → 再淡入新的 → 淡出旧的」，
   * 中间任何一步都不动可见层，所以看起来一直是同一个她在呼吸。
   */
  async function playIdle(name, options = {}) {
    if (state.packKind === 'figure') return false;
    const url = state.files.get(name);
    if (!url) { logOnce(`no-idle:${name}`, `待机素材缺失：${name}`); scheduleIdle(); return false; }
    const cur = idleVids[state.idleActive];
    // 同一条还在台上循环：不重播（重播才会闪回初始帧）
    if (state.idleName === name && cur && cur.classList.contains('on')) {
      if (state.paused) { try { void cur.play(); } catch {} }
      return true;
    }
    const prevIdx = state.idleActive;
    const nextIdx = 1 - prevIdx;
    const next = idleVids[nextIdx];
    const prev = idleVids[prevIdx];
    if (!next) return false;
    const token = ++state.idleToken;
    try {
      next.loop = true;
      next.muted = true;
      next.classList.toggle('flip', options.mirror === true);
      if (next.getAttribute('data-src') !== url) {
        next.src = url;
        next.setAttribute('data-src', url);
        try { next.currentTime = 0; } catch {}
      } else if (!next.classList.contains('on')) {
        // 只有「不在台上的那一层」才允许重置时间轴，可见中的层一律不动
        try { next.currentTime = 0; } catch {}
      }
      void safePlay(next, `idle:${name}`);
    } catch (error) {
      log(`待机播放异常 ${name}: ${error?.message || error}`);
      scheduleIdle();
      return false;
    }
    await whenFirstFrame(next);
    if (token !== state.idleToken) return false;
    next.classList.add('on');
    state.idleActive = nextIdx;
    state.idleName = name;
    log(`[layer] idle ${name} (${next.id})`);
    // 旧的跟新的同时淡出（两边都在 transition 里，才是真正的交叉淡入）；
    // 别等新层完全不透明了再摘旧的，那样中间会「两只并排」闪一下。
    // 等淡出走完再暂停，期间它还留着最后一帧兜底。
    if (prev && prev !== next) {
      prev.classList.remove('on');
      setTimeout(() => {
        if (prev.classList.contains('on')) return; // 这期间它又被换回来了，别暂停可见层
        try { prev.pause(); } catch {}
      }, IDLE_FADE_MS + 60);
    }
    hideFallbackAvatar();
    return true;
  }

  /**
   * 动作层：盖在最上面播一遍。同样等首帧再淡入；
   * 播完先淡出（露出底下一直在跑的待机），淡完再把 src 卸掉。
   */
  async function playActionLayer(name, options = {}) {
    if (state.packKind === 'figure') return figureAction(name);
    const url = state.files.get(name);
    if (!url) { logOnce(`no-file:${name}`, `动作素材缺失：${name}`); scheduleIdle(); return false; }
    if (!actionVid) return false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    const token = ++state.actionToken;
    state.busy = true;
    state.chain += 1;
    state.actionName = name;
    state.playing = { name, kind: options.kind || 'idle' };
    const loop = options.loop === true;
    try {
      actionVid.loop = loop;
      actionVid.muted = true;
      actionVid.classList.toggle('flip', options.mirror === true);
      if (actionVid.getAttribute('data-src') !== url) {
        actionVid.src = url;
        actionVid.setAttribute('data-src', url);
        try { actionVid.currentTime = 0; } catch {}
      }
      void safePlay(actionVid, `action:${name}`);
    } catch (error) {
      log(`动作播放异常 ${name}: ${error?.message || error}`);
      state.busy = false;
      scheduleIdle();
      return false;
    }
    // 兜底：webm 偶尔会有「播完了但不发 ended」的情况（切后台、解码卡一下），
    // 不补这一下她就永远停在一个动作上、也不再随机换动作了。
    armWatchdog(actionVid, name, loop, token);
    await whenFirstFrame(actionVid);
    if (token !== state.actionToken) return true;
    // 顺序很关键：先让底色层淡出（90ms），再让动作层淡入。
    // 反过来的话两个不透明的她在同一帧里各摆一个姿势 = 重影（主人实证投诉过）。
    dimBase(true);
    await new Promise((resolve) => setTimeout(resolve, DIM_FADE_MS));
    if (token !== state.actionToken) return true;
    actionVid.classList.add('on');
    log(`[layer] action ${name} kind=${state.playing?.kind || ''}`);
    hideFallbackAvatar();
    return true;
  }

  /** 动作层收尾：淡出 → 露回待机 → 卸载 src。 */
  function finishAction(reason) {
    if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null; }
    const wasBusy = state.busy;
    state.busy = false;
    state.playing = null;
    state.actionToken += 1; // 让还没落地的淡入作废
    const vid = actionVid;
    if (vid) {
      vid.classList.remove('on'); // CSS transition 200ms 淡出，底下待机一直在
      // 动作层开始淡出的同一刻把底色亮回来：底色 90ms 就位、动作 200ms 才淡完，
      // 会有很轻的一下叠加，但宠物本体始终在，不会「消失 200ms」再跳出来。
      dimBase(false);
      setTimeout(() => {
        if (state.busy) return; // 这期间又开了新动作，别把新源卸了
        if (vid.classList.contains('on')) return;
        try { vid.pause(); } catch {}
        vid.removeAttribute('data-src');
        try { vid.removeAttribute('src'); vid.load(); } catch {}
      }, ACTION_FADE_MS + 60);
    }
    if (reason !== 'silent') log(`[layer] action done (${reason})`);
    if (!wasBusy) { /* 没在播也会进来：照样排下一次 */ }
    if (!state.ready) return;
    scheduleIdle();
  }

  function armWatchdog(video, name, loop, token) {
    if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null; }
    if (loop) return; // 循环待机本来就不该结束
    const arm = () => {
      if (token !== state.actionToken) return;
      if (state.playing && state.playing.name !== name) return;
      const seconds = Number.isFinite(Number(video.duration)) && Number(video.duration) > 0 ? Number(video.duration) : 6;
      state.watchdog = setTimeout(() => {
        state.watchdog = null;
        if (!state.ready || state.paused) return;
        if (token !== state.actionToken) return;
        if (!state.playing || state.playing.name !== name) return;
        log(`动作 ${name} 没有正常结束，按播完处理`);
        finishAction('watchdog');
      }, Math.max(1500, Math.round(seconds * 1000) + 1500));
    };
    if (video.readyState >= 1) arm();
    else video.addEventListener('loadedmetadata', arm, { once: true });
  }

  function onActionEnded(event) {
    if (event.currentTarget !== actionVid) return;
    if (state.paused) return;
    finishAction('ended');
  }

  function nextIdle() {
    const action = pickIdleAction();
    if (!action) { scheduleIdle(); return false; }
    return playAction(action);
  }

  function playAction(action) {
    if (action.kind === 'move') return walk(action);
    // 待机类动作（idle）走垫底层循环；其它（turn / 分类动作）走动作层播一遍
    if (action.kind === 'idle') {
      void playIdle(action.name, { mirror: action.mirror === true });
      scheduleIdle();
      return true;
    }
    return playActionLayer(action.name, { mirror: action.mirror === true, kind: action.kind });
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
    const dist0 = Math.round(minDist + Math.random() * (maxDist - minDist));
    const dir0 = state.moveBias || (Math.random() < 0.5 ? -1 : 1);
    // 走之前先量一下离屏幕边还有多远：以前一路走到墙外，窗口被夹住后她整个人贴在边上
    // （用户说的「一走就出大 bug」），现在最多走到离边 8px 就停。
    let room = Infinity;
    try {
      const availW = Number(window.screen?.availWidth) || 0;
      const availH = Number(window.screen?.availHeight) || 0;
      if (availW > 0) {
        room = dir0 > 0
          ? availW - (Number(window.screenX) || 0) - (Number(window.innerWidth) || 0)
          : Number(window.screenX) || 0;
      }
      if (availH > 0 && Number(window.screenY) < 0) room = 0;
    } catch { /* ignore */ }
    const roomEdge = Number.isFinite(room) ? Math.max(0, room - 8) : dist0;
    const dist = Math.max(8, Math.min(dist0, roomEdge));
    const dir = dir0;
    const ms = Math.max(400, Math.round((leadSec + tailSec) * 1000));
    const playing = playActionLayer(action.name, { mirror: dir > 0 ? !ART_FACES_LEFT : ART_FACES_LEFT, kind: 'move' });
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

  /**
   * 走一次：只从 manifest.moves 里挑一段「走两步」并搬窗口。
   * 调用者只有两个——漫游计时器（wander.enabled，默认关）和右键菜单「走一走」。
   * 待机抽取、鼠标划过（react）都不许碰它，否则手一挥她就跑。
   */
  function wanderOnce(reason) {
    if (state.packKind === 'figure') { log('[pet] wander 跳过：网页形象没有走位素材'); return false; }
    const moves = state.manifest?.moves || [];
    if (!moves.length) return false;
    const mv = pick(moves);
    if (!mv) return false;
    log(`[pet] wander (${reason || 'manual'}) ${mv.name}`);
    return walk({ name: mv.name, params: mv.params || {} });
  }

  function wanderDelayMs() {
    const w = petOpts().wander;
    const min = clamp(num(w.minMs, 45000), 8000, 900000);
    const max = Math.max(min, clamp(num(w.maxMs, 150000), min, 1800000));
    return Math.round(min + Math.random() * (max - min));
  }

  /** 漫游计时器：wander 关着就什么都不排（默认就是关）。 */
  function scheduleWander() {
    if (state.wanderTimer) { clearTimeout(state.wanderTimer); state.wanderTimer = null; }
    if (!state.ready) return;
    if (!wanderEnabled()) return;
    state.wanderTimer = setTimeout(() => {
      state.wanderTimer = null;
      if (!state.ready || state.paused || state.busy) { scheduleWander(); return; }
      wanderOnce('timer');
      scheduleWander();
    }, wanderDelayMs());
  }

  // ── 网页形象（figure）通道 ─────────────────────────────────────────────────

  function figureUrl(entry) {
    return asPageUrl(entry);
  }

  function postFigure(payload) {
    if (state.packKind !== 'figure' || !figureFrame) return false;
    const win = figureFrame.contentWindow;
    if (!win) return false;
    try { win.postMessage(payload, '*'); return true; } catch { return false; }
  }

  /** figure 包的动作名：优先用形象自己登记的那批，其次用清单里的。 */
  function figureActionPool() {
    if (state.figureActions.length) return state.figureActions;
    return manifestActions(state.manifest);
  }

  function figureAction(name) {
    const key = String(name || '').trim();
    if (!key) return false;
    if (!state.figureReady) {
      logOnce('figure-not-ready', '网页形象还没 ready，动作先不发');
      return false;
    }
    const ok = postFigure({ type: 'pet:action', name: key });
    if (ok) log(`[figure] action ${key}`);
    return ok;
  }

  /**
   * 打开 iframe 并等它喊 figure:ready。
   * 6 秒还没 ready 就当这个包坏了：返回 false，调用方退回 webm / 静态头像。
   */
  function startFigure(entry) {
    if (!figureFrame) return Promise.resolve(false);
    const url = figureUrl(entry);
    if (!url) return Promise.resolve(false);
    return new Promise((resolve) => {
      state.figureReady = false;
      state.figureActions = [];
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        if (state.figureResolve === done) state.figureResolve = null;
        clearTimeout(timer);
        resolve(ok);
      };
      state.figureResolve = done;
      const timer = setTimeout(() => {
        log(`网页形象 ${FIGURE_READY_MS}ms 内没有 ready，退回 webm`);
        done(false);
      }, FIGURE_READY_MS);
      stage?.classList.remove('fallback');
      stage?.classList.add('figure');
      stage?.classList.remove('hidden');
      figureFrame.classList.remove('hidden');
      try { figureFrame.src = url; } catch (error) {
        log(`网页形象打不开：${error?.message || error}`);
        done(false);
      }
    });
  }

  function closeFigure() {
    if (!figureFrame) return;
    figureFrame.classList.add('hidden');
    try { figureFrame.removeAttribute('src'); } catch {}
    stage?.classList.remove('figure');
    state.figureReady = false;
    state.figureResolve = null;
    state.figureActions = [];
  }

  window.addEventListener('message', (event) => {
    if (!figureFrame || event.source !== figureFrame.contentWindow) return;
    const data = event.data && typeof event.data === 'object' ? event.data : null;
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'figure:ready') {
      state.figureReady = true;
      state.figureActions = strList(data.actions);
      log(`[figure] ready actions=${state.figureActions.length}`);
      if (typeof state.figureResolve === 'function') state.figureResolve(true);
    } else if (data.type === 'figure:error') {
      log(`[figure] 形象报错：${String(data.error || data.message || '').slice(0, 120)}`);
    }
  });

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
    if (stageInner) {
      stageInner.style.setProperty('--gaze-shift', g && g.dir !== 'center' ? `${g.shiftPx || 0}px` : '0px');
    }
    // 网页形象：方向和偏移一起发过去，让它自己决定怎么转
    if (state.packKind === 'figure' && state.figureReady) {
      const now = Date.now();
      if (now - state.figureGazeAt >= 120) {
        state.figureGazeAt = now;
        postFigure({
          type: 'pet:gaze',
          dx: g ? Math.round(num(g.dx, 0)) : 0,
          dy: g ? Math.round(num(g.dy, 0)) : 0,
          dir: g ? g.dir : 'center',
        });
      }
    }
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
        if (state.busy) return;
        // 网页形象没有 webm 清单，动作名要问形象自己登记的那一包
        const turnName = state.packKind === 'figure' ? figurePick('turn') : pick(turnList());
        if (!turnName) return;
        if (now - state.lastTurnAt < GAZE_TURN_GAP_MS) return;
        state.lastTurnAt = now;
        if (state.packKind === 'figure') {
          void figureAction(turnName);
          return;
        }
        void playActionLayer(turnName, { mirror: g.mirror, kind: 'turn' });
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
    if (!actionVid || actionVid.__surfPetBound) return;
    actionVid.__surfPetBound = true;
    // 垫底两路是 loop=true，永远不会 ended；只有动作层需要这条
    actionVid.addEventListener('ended', onActionEnded);
  }

  function bindVideoErrors() {
    for (const v of vids) {
      if (!v || v.__surfPetErr) continue;
      v.__surfPetErr = true;
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
    // 没有 manifest 就存 null（figure 包就是这样）：存成「空归一化对象」会让
    // startConfigWatch 的 null 对照永远不相等，4 秒重载一次 iframe。
    state.manifest = pet?.manifest ? normalizeManifest(pet.manifest) : null;
    // 主进程透传的着色：CSS filter 字符串（如 'hue-rotate(20deg) saturate(1.1)'），
    // 只作用在形象本体上，不影响气泡和菜单。
    const tint = typeof pet?.tint === 'string' ? pet.tint.trim() : '';
    if (stageInner) stageInner.style.setProperty('--pet-tint', tint || 'none');
    // 身高只认配置里的「她现在多大」，不再从窗口高度反推：
    // 窗口会为了头顶气泡长高/加宽，一反推她就跟着变大（主人报「气泡变大桌宠也跟着变大」）。
    const petSize = num(pet?.size, 200);
    setSize(petSize);
  }

  /** 从配置里读「这个包是不是网页形象」，拿不到就一律当 webm。 */
  function readPackKind(pet) {
    const kind = String(pet?.packKind || pet?.kind || '').trim().toLowerCase();
    // 主进程字段名还没完全定死，这里把几种叫法都认了（packEntry 优先，其次 entryUrl/entry）。
    const entry = String(pet?.packEntry || pet?.packEntryUrl || pet?.figureEntry || pet?.entryUrl || pet?.entry || '').trim();
    if (kind !== 'figure' || !entry) return { kind: 'webm', entry: '' };
    // 主进程可能给绝对路径，也可能只给包内相对入口（index.html）：相对的就按包目录拼。
    let full = entry;
    if (!isLocalPath(entry) && !/^https?:/i.test(entry)) {
      const dir = String(pet?.dir || '').replace(/[\\/]+$/, '');
      if (dir) full = `${dir}/${entry.replace(/^[\\/]+/, '')}`;
    }
    return { kind: 'figure', entry: full };
  }

  async function init() {
    // orb.js 在页面加载完后也会调一次 init()，这里别把已经在播的宠物重开一遍。
    if (state.ready) {
      const again = await readPetConfig();
      const sameDir = String(again?.pet?.dir || '') === String(state.cfg?.dir || '');
      const nextPack = readPackKind(again?.pet);
      const samePack = nextPack.kind === state.packKind && nextPack.entry === state.figureEntry;
      if (again?.pet && sameDir && samePack) {
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
    // 换包/换尺寸后重新量气泡（下一次 showBubble 会重新申请 band/width）
    state.bubbleBand = 0;
    state.bubbleWidth = 0;
    if (bubble) { bubble.style.width = ''; bubble.style.setProperty('--bubble-max', 'none'); }

    // ① 网页形象优先：team 约定 packKind==='figure' 且给了 packEntry 才走 iframe
    const pack = readPackKind(pet);
    state.packKind = pack.kind;
    state.figureEntry = pack.entry;
    if (pack.kind === 'figure') {
      log(`网页形象：${pack.entry}`);
      const ok = await startFigure(pack.entry);
      if (ok) {
        stage?.classList.remove('hidden');
        hideFallbackAvatar();
        bindVideoErrors();
        state.ready = true;
        scheduleIdle();
        scheduleWander();
        startGaze();
        placeBubble();
        log(`桌宠就绪（figure）：${state.figureActions.length} 个动作，尺寸 ${petSizePx()}，包 ${pet.packId || pet.dir || ''}`);
        return true;
      }
      closeFigure();
      state.packKind = 'webm';
      state.figureEntry = '';
    }

    // ② webm 通道
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
    bindVideoErrors();
    state.ready = true;
    // 先播一段循环 idle 垫底，动作层播完都会回到它（它一直在跑，所以不会闪）
    const first = pick(idleList()) || pick([...state.files.keys()]);
    if (first) void playIdle(first, { mirror: true });
    scheduleIdle();
    scheduleWander();
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
    const prevSig = JSON.stringify(state.manifest ? normalizeManifest(state.manifest) : null);
    const nextSig = JSON.stringify(cfg?.pet?.manifest ? normalizeManifest(cfg.pet.manifest) : null);
    const nextPack = readPackKind(cfg?.pet);
    const packChanged = nextPack.kind !== state.packKind || nextPack.entry !== state.figureEntry;
    if (prevDir === nextDir && prevSig === nextSig && !packChanged) {
      applyConfig(cfg); // 大小 / 注视 / 走位这类开关仍然可以即时生效
      startGaze();
      return false;
    }
    stop();
    closeFigure();
    for (const v of vids) {
      v.classList.remove('on');
      v.removeAttribute('data-src');
      try { v.removeAttribute('src'); v.load(); } catch {}
    }
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
        const prevSig = JSON.stringify(state.manifest ? normalizeManifest(state.manifest) : null);
        // figure 包没有 manifest：两边都按「没有」处理，否则每 4 秒都会判成「包变了」重载一次
        const nextSig = JSON.stringify(cfg.pet.manifest ? normalizeManifest(cfg.pet.manifest) : null);
        const nextPack = readPackKind(cfg.pet);
        const packChanged = nextPack.kind !== state.packKind || nextPack.entry !== state.figureEntry;
        if (prevDir !== nextDir || prevSig !== nextSig || packChanged) {
          log('检测到动画包变化，正在重载');
          stop();
          closeFigure();
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
  /** 网页形象里挑一个语义对的上的动作名（形象自己登记的动作集不一定和 webm 清单同名）。 */
  function figurePick(...names) {
    const pool = figureActionPool();
    for (const want of names) {
      const hit = pool.find((x) => String(x).toLowerCase() === want);
      if (hit) return hit;
    }
    return '';
  }

  function react() {
    if (!state.ready) return false;
    if (state.packKind === 'figure') return figureAction(figurePick('clicks', 'click', 'pet', 'turn'));
    const name = pick(state.manifest?.clicks || []);
    if (!name) return false;
    return playActionLayer(name, { kind: 'click' });
  }

  /** 拖起来的时候播拖拽动作。 */
  function drag() {
    if (!state.ready) return false;
    if (state.packKind === 'figure') return figureAction(figurePick('drag', 'turn'));
    const name = pick(state.manifest?.drag || []);
    if (!name) return false;
    return playActionLayer(name, { loop: true, kind: 'drag' });
  }

  /** 随机换个动作（右键菜单「换个动作」）。 */
  function shuffle() {
    if (!state.ready) return false;
    if (state.packKind === 'figure') {
      // 别拿 gaze / idle 当「换了个动作」交差，那看起来像没反应
      const pool = figureActionPool().filter((x) => !/^(gaze|idle)$/i.test(String(x)));
      return figureAction(pick(pool) || figurePick('turn', 'blink', 'clicks'));
    }
    return nextIdle();
  }

  /** 指定动作（设置页「动作测试」用）。 */
  function action(name, options = {}) {
    if (!state.ready) return false;
    const key = String(name || '').trim();
    if (!key) return false;
    if (state.packKind === 'figure') return figureAction(key);
    if (!state.files.has(key)) return false;
    // 走位动作要顺带搬窗口；「走两步」被关掉时手动点播也照样走一次。
    const mv = (state.manifest?.moves || []).find((item) => item && item.name === key);
    if (mv) return walk({ name: key, params: mv.params || {} });
    return playActionLayer(key, { mirror: options.mirror !== false, loop: false, kind: 'preview' });
  }

  /** 预览某个动画包里的一段（包还没启用也能看）。 */
  function preview(name, options = {}) {
    const key = String(name || '').trim();
    if (!key) return false;
    if (state.packKind === 'figure') return figureAction(key);
    const dir = String(options.dir || state.cfg?.dir || '').replace(/[\\/]+$/, '');
    if (!dir) return false;
    if (!state.files.has(key)) state.files.set(key, toFileUrl(`${dir}/webm/${key}.webm`));
    state.ready = true;
    stage?.classList.remove('hidden');
    return playActionLayer(key, { mirror: options.mirror !== false, loop: false, kind: 'preview' });
  }

  // ── 气泡 ───────────────────────────────────────────────────────────────────

  /**
   * 头顶气泡：显示她刚说的话（面板收起时才需要）。可带一张小图（图文一体）。
   * 几何走 fitBubble() 的两趟测量：先量正文高度，请主进程把窗口往上长（band）
   * 和左右加宽（width），再按新窗口重排，保证气泡永远在她头顶上方、不压住她。
   */
  function showBubble(text, options = {}) {
    if (!bubble) { log('[bubble] skip reason=no-bubble-el'); return false; }
    const kind = options.kind || 'her';
    const body = String(text ?? '').trim();
    const picSrc = asImageUrl(options.image);
    if (!body && !picSrc) { log('[bubble] skip reason=empty'); return false; }
    log(`[bubble] show kind=${kind} chars=${body.length} pic=${picSrc ? 'yes' : 'no'} innerH=${window.innerHeight || 0} innerW=${window.innerWidth || 0}`);
    ensureBubbleBody();

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
          log('[bubble] pic load failed');
          placeBubble();
        };
        pic.onload = () => placeBubble();
        pic.src = picSrc;
      } else {
        pic.classList.add('hidden');
        pic.removeAttribute('src');
      }
    }
    // 场景 class：chat（她说话）/ notice（提醒）/ event（菜单、动作这类事件）
    // / news（分享、新闻）/ error（出错）。老的 her/proactive/me 继续兼容。
    bubble.className = [
      'bubble',
      `bubble--${BUBBLE_KIND_ALIAS[kind] || 'chat'}`,
      kind === 'me' ? 'me' : '',
      kind === 'proactive' ? 'proactive' : '',
      picSrc ? 'haspic' : '',
      picSrc && !body ? 'nopic' : '',
    ].filter(Boolean).join(' ');
    bubble.classList.remove('hidden');
    // 气泡显示时窗口顶上那一截要能点（点气泡＝开面板），主进程按这个标记决定穿透
    try { void window.orb?.bubbleShown?.(true); } catch {}
    // 先按当前窗口摆一次（别等 IPC 回来才画），再走两趟测量把窗口让够
    placeBubble();
    void fitBubble().catch((error) => {
      log(`[bubble] fit 失败：${String(error?.message || error)}`);
    });
    // 落点日志：气泡「没出现 / 被裁」时看这一行（还是根本没进 showBubble，那句是 skip reason）
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        placeBubble();
        try {
          const r = bubble.getBoundingClientRect();
          log(`[bubble] rect top=${Math.round(r.top)} left=${Math.round(r.left)} w=${Math.round(r.width)} h=${Math.round(r.height)} win=${window.innerWidth}x${window.innerHeight} cls=${bubble.className}`);
        } catch {}
      });
    }
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
    if (!bubble) return;
    const wasShown = !bubble.classList.contains('hidden');
    bubble.classList.add('hidden');
    if (wasShown) {
      log('[bubble] hide');
      try { void window.orb?.bubbleShown?.(false); } catch {}
    }
    if (state.bubbleTimer) { clearTimeout(state.bubbleTimer); state.bubbleTimer = null; }
    state.bubbleClick = null;
    const textEl = document.getElementById('bubbleText');
    if (textEl) { textEl.textContent = ''; textEl.title = ''; }
    // 窗口高度不跟着气泡反复变（一高一缩就是以前抖动的根因）。
    // 唯一例外：为了放下超长气泡，主进程把她整个人往下让过一截——那种情况必须还回去，
    // 否则她会一直待在被挤下来的位置。shift=0 的普通气泡不收窗口。
    if (state.bubbleShift > 0) {
      state.bubbleShift = 0;
      state.bubbleBand = 0;
      state.bubbleWidth = 0;
      void requestBubbleSpace({ band: 0, width: 0 });
    }
  }

  // ── 生命周期 ───────────────────────────────────────────────────────────────

  function stop() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.wanderTimer) { clearTimeout(state.wanderTimer); state.wanderTimer = null; }
    if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null; }
    state.actionToken += 1;
    state.idleToken += 1;
    stopGaze();
    for (const v of vids) { try { v.pause(); } catch {} }
    state.playing = null;
    state.busy = false;
    state.actionName = '';
    state.dimmed = false;
  }

  /** 展开面板时暂停播放（省 CPU，也避免和面板动画抢帧）；收起再恢复，不重载 src。 */
  function pause() {
    state.paused = true;
    if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null; }
    if (state.wanderTimer) { clearTimeout(state.wanderTimer); state.wanderTimer = null; }
    state.actionToken += 1;
    stopGaze();
    for (const v of vids) { try { v.pause(); } catch {} }
    postFigure({ type: 'pet:pause' });
  }

  function resume() {
    state.paused = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    for (const v of vids) {
      if (v && v.classList.contains('on')) {
        try { void v.play(); } catch {}
      }
    }
    // 动作层可能已经被淡出卸载了：重新起一段待机就够
    if (state.packKind === 'webm' && state.ready && !state.idleName) {
      const first = pick(idleList());
      if (first) void playIdle(first, { mirror: true });
    }
    postFigure({ type: 'pet:resume' });
    scheduleIdle();
    scheduleWander();
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
    scheduleWander();
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
    wander: () => wanderOnce('menu'),
    preview,
    refresh,
    setOptions,
    showBubble,
    hideBubble,
    stop,
    placeBubble,
    setSize,
    // 气泡带高度（主进程按它算窗口顶上预留的那一条）——现在是动态的：
    // 气泡多高就申请多高的带；orb.js 用它算「哪一块算宠物本体」。
    bubbleBand: () => Math.max(PET_BUBBLE_BAND, Math.round(state.bubbleBand || PET_BUBBLE_BAND)),
    // 当前窗口宽度（气泡撑宽以后 orb.js 的命中区也跟着变）
    bubbleWidth: () => Math.round(state.bubbleWidth || window.innerWidth || 0),
    // 手动重排气泡（窗口尺寸变了 / 真机验证时调）
    fitBubble,
    // 这个包是 webm 还是网页形象（orb.js 用来决定菜单里显示什么）
    packKind: () => state.packKind,
    get ready() { return state.ready; },
    get element() { return stage; },
    get size() { return state.sizePx; },
    get gaze() { return state.gaze; },
    get playing() { return state.playing ? state.playing.name : ''; },
    get idle() { return state.idleName; },
  };

  // 窗口尺寸变了（右键改大小、展开/收起）气泡也得跟着回到头顶
  window.addEventListener('resize', () => placeBubble());
  window.addEventListener('blur', () => applyGaze(null));

  // 自动启动：orb.js 里会在合适的时机再调一次 init()，这里先兜一下。
  startConfigWatch();
  void init().catch((error) => log(`初始化失败：${error?.message || error}`));
})();
