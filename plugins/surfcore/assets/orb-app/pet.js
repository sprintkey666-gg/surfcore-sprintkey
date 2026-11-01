// 桌宠形象（素材来自 dsh-pet@0.3.8，MIT，Copyright (c) 2026 PC2005-cloud）
//
// 这里只做一件事：把 webm 动作播出来，并在头顶显示她的最新消息。
// 逻辑全都走主进程（window.orb），页面自己不发 HTTP、不碰令牌。
//
// 两条经验直接来自参考项目：
//   1. 两个 <video> 双缓冲交叉淡入——单个 video 换 src 会闪黑，动作切换会很脏；
//   2. 「只有宠物身体能点」——窗口比宠物大（头顶留气泡），其余部分必须把鼠标让回桌面，
//      否则一开会话就把桌面右缘那条竖带全挡住了。
(() => {
  const stage = document.getElementById('pet');
  const stageInner = stage ? stage.querySelector('.petStage') : null;
  const vids = [document.getElementById('pvA'), document.getElementById('pvB')];
  const bubble = document.getElementById('bubble');

  const state = {
    ready: false,
    cfg: null,
    manifest: null,
    files: new Map(),   // 动作名 -> file:// URL
    active: 0,          // 当前在播的 video 下标
    chain: null,        // 当前动作链（idle 之外的动作播完回 idle）
    timer: null,
    bubbleTimer: null,
    busy: false,
  };

  // 素材帧 640×360，角色（含呆毛）的头顶大概在帧高的 15% 处。
  // 用这个比例把气泡尾巴钉在她脑袋上，而不是钉在窗口顶边。
  const PET_HEAD_RATIO = 0.152;
  const PET_BUBBLE_BAND = 110; // main.js 里 PET_BUBBLE_SPACE：窗口比宠物高出的那一条

  /** 把气泡摆到她头顶：算 video 里「实际画面」的顶边，再按角色在画面里的位置往下让。 */
  function placeBubble() {
    if (!bubble) return;
    const video = vids.find((v) => v && v.classList.contains('on')) || vids[0];
    if (!video) return;
    const rect = video.getBoundingClientRect();
    if (!rect.height || !rect.width) return;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const contentTop = rect.top + (rect.height - vh * scale) / 2;
    const headTop = contentTop + vh * scale * PET_HEAD_RATIO;
    const bottom = Math.max(12, Math.round(window.innerHeight - headTop + 8));
    bubble.style.top = 'auto';
    bubble.style.bottom = `${bottom}px`;
  }

  function log(msg) {
    try { window.orb?.log?.(`[pet] ${msg}`); } catch {}
  }

  function toFileUrl(absPath) {
    // Windows 路径 → file:///C:/...；中文和空格必须转义，否则 video 直接 404。
    const norm = String(absPath).replace(/\\/g, '/');
    const withSlash = norm.startsWith('/') ? norm : `/${norm}`;
    return encodeURI(`file://${withSlash}`);
  }

  function pick(list) {
    if (!Array.isArray(list) || !list.length) return null;
    return list[Math.floor(Math.random() * list.length)];
  }

  function pickIdleAction() {
    const m = state.manifest;
    const pool = [];
    if (m.idle.length) pool.push({ name: pick(m.idle), weight: m.weights.idle || 10, mirror: true });
    // 分类动作（小动作/玩耍/吃什么/时节/文字）当作随机小动作插播
    for (const cat of m.categories || []) {
      if (!cat.actions.length) continue;
      pool.push({ name: pick(cat.actions), weight: Math.max(1, cat.weight || 1), mirror: cat.noMirror !== true });
    }
    for (const move of m.moves || []) {
      pool.push({ name: move.name, weight: m.weights.move || 5, mirror: true });
    }
    const total = pool.reduce((s, x) => s + x.weight, 0);
    if (!total) return null;
    let r = Math.random() * total;
    for (const item of pool) {
      r -= item.weight;
      if (r <= 0) return item;
    }
    return pool[pool.length - 1];
  }

  /** 角色身高 = 窗口高度 - 头顶气泡带；pet.css 按这个值把整帧放大（--pet-size）。 */
  function setSize(px) {
    const size = Math.max(60, Number(px) || 200);
    state.sizePx = Math.round(size);
    document.documentElement.style.setProperty('--pet-size', `${Math.round(size)}px`);
    placeBubble();
  }

  // 头顶气泡带现在多高（主进程按气泡内容放大窗口，这里同步一份给命中判定用）
  let bandPx = PET_BUBBLE_BAND;
  let fitTimer = null;

  /**
   * 气泡按内容长高：先放开文字限高量出「全文要多高」，再让主进程把窗口往上长那么多。
   * 工作区装不下时主进程会把带高夹回来，这里再把文字限高收回可视高度（CSS 省略号）。
   */
  async function fitBubble() {
    if (!bubble || bubble.classList.contains('hidden')) return;
    const textEl = document.getElementById('bubbleText');
    const pic = document.getElementById('bubblePic');
    const hasPic = !!pic && !pic.classList.contains('hidden') && !!pic.getAttribute('src');
    if (textEl) textEl.style.maxHeight = 'none'; // 先按全文量
    const full = Math.ceil(bubble.getBoundingClientRect().height || 0);
    if (!full) return;
    const want = full + 16; // 小尾巴 8px + 顶部余量
    let band = want;
    try {
      const res = await window.orb?.bubbleSpace?.(want);
      if (res && Number.isFinite(Number(res.band))) band = Number(res.band);
    } catch {}
    bandPx = Math.max(PET_BUBBLE_BAND, Math.round(band));
    if (textEl) {
      const picH = hasPic ? Math.ceil(pic.getBoundingClientRect().height || 0) : 0;
      const room = Math.floor(bandPx - 16 - picH);
      textEl.style.maxHeight = want <= bandPx ? 'none' : `${Math.max(20, room)}px`;
    }
    placeBubble();
  }

  /** 防抖版：图片 onload / 窗口 resize 时不必每帧都量。 */
  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => { void fitBubble(); }, 40);
  }

  function scheduleIdle() {
    if (!state.ready) return;
    if (state.timer) clearTimeout(state.timer);
    const min = Math.max(0, Number(state.cfg?.idleMinMs) || 6000);
    const max = Math.max(min, Number(state.cfg?.idleMaxMs) || 16000);
    const wait = min + Math.random() * (max - min);
    state.timer = setTimeout(() => {
      if (state.busy) { scheduleIdle(); return; }
      const action = pickIdleAction();
      if (action) play(action.name, { mirror: action.mirror });
      else scheduleIdle();
    }, wait);
  }

  /** 播一个动作；播完自动回 idle 并重新排随机动作。 */
  function play(name, { mirror = true, loop = false } = {}) {
    const url = state.files.get(name);
    if (!url) { scheduleIdle(); return false; }
    const nextIdx = 1 - state.active;
    const next = vids[nextIdx];
    const cur = vids[state.active];
    if (!next) return false;
    state.busy = true;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    try {
      next.loop = loop;
      next.src = url;
      next.currentTime = 0;
      const p = next.play();
      if (p && typeof p.catch === 'function') p.catch((error) => log(`播放失败 ${name}: ${error?.message || error}`));
    } catch (error) {
      log(`播放异常 ${name}: ${error?.message || error}`);
      state.busy = false;
      scheduleIdle();
      return false;
    }
    // 镜像：素材默认朝某个方向，需要时整体翻转（文字类动作不能翻，否则反字）
    if (stageInner) stageInner.classList.toggle('mirror', mirror === true);
    next.classList.add('on');
    if (cur) cur.classList.remove('on');
    state.active = nextIdx;
    // 不同动作里她的高矮会变一点，气泡跟着挪，别越飘越远
    placeBubble();
    return true;
  }

  function onEnded() {
    state.busy = false;
    // 播完继续待机：下一次随机动作由 scheduleIdle 决定
    if (state.ready) {
      const idle = pick(state.manifest?.idle || []);
      if (idle) play(idle, { loop: false });
      scheduleIdle();
    }
  }

  async function init() {
    let cfg = null;
    try { cfg = await window.orb?.petconfig?.(); } catch (error) { log(`拿不到形象配置：${error?.message || error}`); }
    const pet = cfg?.pet || null;
    if (!pet || pet.mode !== 'pet' || !pet.manifest) {
      stage?.classList.add('hidden');
      // 球模式下窗口不需要穿透（整块就是球）
      try { window.orb?.hit?.(true); } catch {}
      return false;
    }
    state.cfg = pet;
    state.manifest = pet.manifest;
    // 角色身高 = 窗口高度 - 头顶气泡带；CSS 按这个值放大整帧（pet.css → --pet-size）
    const baseH = Number(cfg?.base?.height) || 0;
    const petSize = baseH > PET_BUBBLE_BAND ? baseH - PET_BUBBLE_BAND : Number(pet.size) || 200;
    setSize(petSize);
    const webmDir = `${String(pet.dir || '').replace(/[\\/]+$/, '')}/webm`;
    for (const name of [...(pet.manifest.idle || []), ...(pet.manifest.clicks || []), ...(pet.manifest.drag || [])]) {
      state.files.set(name, toFileUrl(`${webmDir}/${name}.webm`));
    }
    for (const m of pet.manifest.moves || []) state.files.set(m.name, toFileUrl(`${webmDir}/${m.name}.webm`));
    for (const cat of pet.manifest.categories || []) {
      for (const name of cat.actions || []) state.files.set(name, toFileUrl(`${webmDir}/${name}.webm`));
    }
    stage?.classList.remove('hidden');
    state.ready = true;
    for (const v of vids) {
      v.addEventListener('ended', onEnded);
      v.addEventListener('error', () => log(`video 加载失败 ${v.src}`));
    }
    const first = pick(pet.manifest.idle || []) || pick([...state.files.keys()]);
    if (first) play(first, { loop: true });
    scheduleIdle();
    log(`桌宠就绪：${state.files.size} 个动作，尺寸 ${pet.size}`);
    return true;
  }

  /** 点击反应（主人在宠物身上点一下）。 */
  function react() {
    if (!state.ready) return false;
    const name = pick(state.manifest?.clicks || []);
    if (!name) return false;
    return play(name);
  }

  /** 拖起来的时候播拖拽动作。 */
  function drag() {
    if (!state.ready) return false;
    const name = pick(state.manifest?.drag || []);
    if (!name) return false;
    return play(name, { loop: true });
  }

  /** 随机换个动作（右键菜单「换个动作」）。 */
  function shuffle() {
    if (!state.ready) return false;
    const action = pickIdleAction();
    if (!action) return false;
    return play(action.name, { mirror: action.mirror });
  }

  /** 头顶气泡：显示她刚说的话（面板收起时才需要）。可带一张小图（图文一体）。 */
  function showBubble(text, { kind = 'her', ttlMs = 8000, onClick = null, image = '' } = {}) {
    if (!bubble) return;
    const body = String(text || '').trim();
    const pic = document.getElementById('bubblePic');
    const picSrc = image ? `file:///${encodeURI(String(image).replace(/\\/g, '/'))}` : '';
    if (!body && !picSrc) return;
    const clipped = body.length > 64 ? `${body.slice(0, 63)}…` : body;
    const textEl = document.getElementById('bubbleText');
    if (textEl) textEl.textContent = clipped;
    else bubble.textContent = clipped;
    if (pic) {
      if (picSrc) {
        pic.classList.remove('hidden', 'missing');
        pic.alt = '';
        pic.onerror = () => {
          // 图被删了 / 路径失效：整块图收起来，气泡只剩文字（不留破图）。
          pic.classList.add('hidden');
          pic.removeAttribute('src');
          placeBubble();
        };
        pic.onload = () => { placeBubble(); scheduleFit(); };
        pic.src = picSrc;
        bubble.classList.add('haspic');
        bubble.classList.toggle('nopic', !body);
      } else {
        pic.classList.add('hidden');
        pic.removeAttribute('src');
        bubble.classList.remove('haspic', 'nopic');
      }
    }
    if (textEl) textEl.classList.toggle('hidden', !body);
    bubble.className = `bubble${kind === 'me' ? ' me' : ''}${kind === 'proactive' ? ' proactive' : ''}${picSrc ? ' haspic' : ''}${picSrc && !body ? ' nopic' : ''}`;
    bubble.classList.remove('hidden');
    placeBubble();
    // 内容定下来再按实际高度长窗口（图片要等 onload，这里先按文字量一次）
    scheduleFit();
    bubble.onclick = () => { hideBubble(); onClick?.(); };
    if (state.bubbleTimer) clearTimeout(state.bubbleTimer);
    state.bubbleTimer = setTimeout(() => hideBubble(), Math.max(2000, Number(ttlMs) || 8000));
  }

  function hideBubble() {
    const wasShown = bubble && !bubble.classList.contains('hidden');
    bubble?.classList.add('hidden');
    if (state.bubbleTimer) { clearTimeout(state.bubbleTimer); state.bubbleTimer = null; }
    // 气泡收了，窗口回落到默认高度（别留一个长高版的空窗口挡桌面）
    bandPx = PET_BUBBLE_BAND;
    const textEl = document.getElementById('bubbleText');
    if (textEl) textEl.style.maxHeight = '';
    if (wasShown) { try { void window.orb?.bubbleSpace?.(0); } catch {} }
  }

  function stop() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    for (const v of vids) { try { v.pause(); } catch {} }
    state.busy = false;
  }

  /** 展开面板时暂停播放（省 CPU，也避免和面板动画抢帧）；收起再恢复，不重载 src。 */
  function pause() {
    for (const v of vids) { try { v.pause(); } catch {} }
  }
  function resume() {
    clearTimeout(idleTimer);
    scheduleIdle();
    for (const v of vids) { if (v.classList.contains('on')) { try { v.play().catch(() => {}); } catch {} } }
  }

  window.SurfPet = {
    pause,
    resume,
    init,
    react,
    drag,
    shuffle,
    showBubble,
    hideBubble,
    stop,
    placeBubble,
    setSize,
    bubbleBand: () => bandPx,
    get ready() { return state.ready; },
    get element() { return stage; },
  };

  // 窗口尺寸变了（右键改大小、展开/收起）气泡也得跟着回到头顶
  window.addEventListener('resize', () => placeBubble());
})();
