/* 悬浮窗前端：只负责画和交互，数据都来自主进程推来的 /orb-api/state。 */
(() => {
  const root = document.getElementById('root');
  const ball = document.getElementById('ball');
  const avatarEl = document.getElementById('ballAvatar');
  const badge = document.getElementById('badge');
  const bubbles = document.getElementById('bubbles');
  const empty = document.getElementById('empty');
  const input = document.getElementById('input');
  const btnSend = document.getElementById('btnSend');
  const btnNew = document.getElementById('btnNew');
  const btnHide = document.getElementById('btnHide');
  const btnPin = document.getElementById('btnPin');
  const connDot = document.getElementById('connDot');
  const roleName = document.getElementById('roleName');
  const hint = document.getElementById('hint');
  const panel = document.getElementById('panel');

  let state = null;
  let pinned = false;
  let expanded = false;
  let sending = false;
  let collapseTimer = null;
  let lastSeq = 0;
  let lastActivity = Date.now();
  const IDLE_COLLAPSE_MS = 180000; // 三分钟没动静就缩回球（主人的要求）
  const touch = () => { lastActivity = Date.now(); };

  const esc = (s) => String(s ?? '');
  const hhmm = (at) => {
    const d = new Date(Number(at) || Date.now());
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  function setHint(text, bad = false) {
    hint.textContent = text || '';
    hint.className = bad ? 'hint bad' : 'hint';
  }

  function applyAvatar(cfg) {
    const custom = String(cfg?.ball?.avatar || '').trim();
    if (!custom) return;
    // 允许用户填绝对路径；转成 file:// 让 img 能加载（CSP 已放行 file:）。
    const url = /^[a-zA-Z]:[\\/]/.test(custom) ? `file:///${custom.replace(/\\/g, '/')}` : custom;
    avatarEl.style.setProperty('--orb-avatar', `url("${url}")`);
  }

  /** 是不是已经贴在底部（60px 容差，滚轮抖一下不算）。 */
  const nearBottom = () => bubbles.scrollTop + bubbles.clientHeight >= bubbles.scrollHeight - 60;

  /**
   * 右下角小圆按钮（像 QQ）：
   * - 有未读：圆形里是条数，点一下跳到最新消息；
   * - 没有未读、但主人翻在历史里：圆形里是一个向下的箭头，点一下回到底部。
   */
  let unreadCount = 0;
  function setJump(show, count = 0) {
    const btn = document.getElementById('btnJump');
    unreadCount = Math.max(0, Number(count) || 0);
    if (!btn) return;
    btn.textContent = unreadCount > 0 ? (unreadCount > 99 ? '99+' : String(unreadCount)) : '↓';
    btn.title = unreadCount > 0 ? `有 ${unreadCount} 条新消息，点一下跳到最新` : '回到最新消息';
    btn.classList.toggle('hidden', !show);
  }

  function renderMessages(list) {
    const items = Array.isArray(list) ? list : [];
    const prevCount = bubbles.querySelectorAll('.row').length;
    const atBottom = nearBottom();
    bubbles.querySelectorAll('.bubble').forEach((n) => n.remove());
    empty.style.display = items.length ? 'none' : 'block';
    for (const m of items) {
      const div = document.createElement('div');
      const mine = m.who === 'me';
      div.className = `row ${mine ? 'me' : 'her'}`;
      const ui = state?.ui || {};
      const who = mine ? (ui.me || {}) : (ui.her || {});
      // 头像：设置里关掉就不渲染；加载失败就退化成首字母圆点（.noava）
      if (ui.showAvatar !== false) {
        const img = document.createElement('img');
        img.className = 'ava';
        img.alt = '';
        img.src = who.avatarUrl || '';
        img.addEventListener('error', () => { img.classList.add('noava'); img.removeAttribute('src'); });
        div.appendChild(img);
      } else {
        const pad = document.createElement('span');
        pad.className = 'ava-gap';
        div.appendChild(pad);
      }
      const col = document.createElement('div');
      col.className = 'col';
      if (ui.showName !== false) {
        const name = document.createElement('span');
        name.className = 'who';
        name.textContent = String(who.name || (mine ? '主人' : '她'));
        if (m.kind === 'proactive' && !mine) {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = '主动来找你';
          name.appendChild(tag);
        }
        col.appendChild(name);
      }
      const bubble = document.createElement('div');
      bubble.className = `bubble ${mine ? 'me' : 'her'}${m.kind === 'proactive' ? ' proactive' : ''}${m.image ? ' haspic' : ''}`;
      // 带图的消息：图片在上、文字在下（发表情包时常常没字）。
      if (m.image) {
        const pic = document.createElement('img');
        pic.className = 'pic';
        pic.alt = '';
        pic.src = 'file:///' + encodeURI(String(m.image).replace(/\\/g, '/'));
        bubble.appendChild(pic);
      }
      if (m.text) bubble.appendChild(document.createTextNode(esc(m.text)));
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = hhmm(m.at);
      bubble.appendChild(meta);
      col.appendChild(bubble);
      div.appendChild(col);
      bubbles.appendChild(div);
    }
    // 新消息一律把最新那条顶到最下面（像 QQ 一样）；但他正在翻历史时不要抢滚动，
    // 改成右下角亮一个小圆按钮，点了才回去。
    if (items.length > prevCount && !atBottom) {
      // 主人翻在历史里：不抢滚动，改成计数
      setJump(true, unreadCount + (items.length - prevCount));
    } else {
      setJump(false, 0);
      bubbles.scrollTop = bubbles.scrollHeight;
    }
  }

  let eyeBusy = false;
  let hintTimer = null;

  /** 提示条：每次打开会话露 3 秒就走，不留常驻条（主人明确要求）。 */
  function showHintBriefly(text) {
    const el = document.getElementById('screenHint');
    if (!el) return;
    const span = document.getElementById('screenHintText');
    if (span) span.textContent = text;
    el.classList.remove('hidden', 'fade');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      el.classList.add('fade');
      setTimeout(() => { if (el.classList.contains('fade')) el.classList.add('hidden'); }, 700);
    }, 3000);
  }

  function screenModeOf(screenState) {
    const mode = screenState?.mode;
    if (mode === 'off' || mode === 'manual' || mode === 'auto') return mode;
    return screenState?.enabled === true ? 'manual' : 'off';
  }

  function renderScreenHint(screenState) {
    const btn = document.getElementById('btnEye');
    const mode = screenModeOf(screenState);
    if (btn) {
      btn.classList.toggle('on', mode !== 'off');
      btn.title = mode === 'off'
        ? '眼睛关着：双击让她看一次（看完就删）'
        : mode === 'auto'
          ? '自动模式：她想看会自己申请，每轮最多一次；单击关闭'
          : '她正看着你的屏幕：单击关掉，双击再看一次（看完就删）';
      if (screenState?.visionOk === false) btn.title = '当前模型不支持看图，开了也没用';
    }
    // 发图按钮跟着「悬浮窗发图」开关走
    const picBtn = document.getElementById('btnPic');
    if (picBtn) picBtn.classList.toggle('hidden', screenState?.picEnabled !== true);
  }

  async function toggleEye() {
    if (eyeBusy) return;
    const btn = document.getElementById('btnEye');
    const wantOn = !(state?.screen?.enabled === true);
    eyeBusy = true;
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    try {
      if (!wantOn) {
        await window.orb.http('/screen/eye', { method: 'POST', body: { enabled: false } });
        setHint('眼睛关上了');
        showHintBriefly('眼睛已关闭 · 双击「眼」让她看一次');
        try {
          if (btn) btn.classList.remove('on');
          renderScreenHint({ ...(state?.screen || {}), mode: 'off', enabled: false });
        } catch {}
        return;
      }
      setHint('正在看她看到的画面…');
      const res = await window.orb.http('/screen/eye', { method: 'POST', body: { enabled: true }, timeoutMs: 120000 });
      if (res?.visionOk === false) setHint('当前模型看不了图，开了也没用');
      else if (res?.ok) setHint('看过了');
      else setHint(String(res?.error || '这次没看成'));
    } catch (error) {
      setHint('开眼睛失败：' + String(error?.message ?? error).slice(0, 60));
    } finally {
      eyeBusy = false;
      if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
    }
  }

  // 单击「眼」= 关闭眼睛；双击「眼」= 让她看一次（截图识别一次）。
  // 单击要等一下再执行，才能区分出双击（230ms 内没有第二下才算单击）。
  let eyeClickTimer = null;

  /** 双击：先确保眼睛打开，再拍一张给她看。 */
  async function lookOnce() {
    if (eyeBusy) return;
    if (state?.screen?.enabled !== true) {
      eyeBusy = true;
      const btn = document.getElementById('btnEye');
      if (btn) { btn.disabled = true; btn.classList.add('busy'); }
      try { await window.orb.http('/screen/eye', { method: 'POST', body: { enabled: true } }); } catch {}
      finally {
        eyeBusy = false;
        if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
      }
    }
    await toggleEye();
  }

  document.getElementById('btnEye')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (eyeClickTimer) return;
    eyeClickTimer = setTimeout(() => {
      eyeClickTimer = null;
      if (state?.screen?.enabled === true) { void toggleEye(); return; }
      showHintBriefly('眼睛已关闭 · 双击「眼」让她看一次');
    }, 230);
  });

  document.getElementById('btnEye')?.addEventListener('dblclick', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    clearTimeout(eyeClickTimer);
    eyeClickTimer = null;
    void lookOnce();
  });

  // 手动滚动时同步一下小圆按钮：贴底就收起来，翻上去了就露箭头
  bubbles.addEventListener('scroll', () => {
    if (nearBottom()) { setJump(false, 0); return; }
    if (unreadCount === 0) setJump(true, 0);
  });

  document.getElementById('btnJump')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    bubbles.scrollTop = bubbles.scrollHeight;
    setJump(false, 0);
  });

  let picBusy = false;
  /**
   * 发一张图/表情包：hint 取输入框里已经打的字（她挑图时也看这个语境）。
   * 后端按「QQ 收藏表情 → 本地图库 → 现场生图」的顺序找，找不到会要 agent 去生成。
   */
  async function sendPic() {
    if (picBusy) return;
    const btn = document.getElementById('btnPic');
    picBusy = true;
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    try {
      const hint = String(document.getElementById('input')?.value || '').trim();
      const res = await window.orb.http('/pic', { method: 'POST', body: { hint }, timeoutMs: 30000 });
      if (res?.ok) {
        setHint(res.source === 'sticker' ? '偷了张表情包发给你' : res.source === 'local' ? '从图库挑了一张' : '图发出来了');
        return;
      }
      if (res?.needGenerate) {
        // 插件自己没有生图能力：把 prompt 记下来，等聊天这边叫 agent 画完再 /pic/image 回填。
        setHint('这条要现场画：在聊天里叫她画，画完会自动出现在这里');
        return;
      }
      setHint(String(res?.error || '这次没找到合适的图'));
    } catch (error) {
      setHint('发图失败：' + String(error?.message ?? error).slice(0, 60));
    } finally {
      picBusy = false;
      if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
    }
  }

  document.getElementById('btnPic')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void sendPic();
  });

  function onState(next) {
    if (!next) return;
    state = next;
    if (next.role?.name) roleName.textContent = next.role.name;
    applyAvatar(next.config);
    const seq = Number(next.seq || 0);
    const list = Array.isArray(next.messages) ? next.messages : [];
    // 只有真正有新消息（或换了会话）才重画，避免 3 秒一次把滚动位置顶掉。
    if (seq !== lastSeq || bubbles.querySelectorAll('.bubble').length !== list.length) {
      lastSeq = seq;
      renderMessages(list);
      try { renderScreenHint(next.screen); } catch {}
      const hasProactive = list.some((m) => m.kind === 'proactive' && Number(m.at) > Date.now() - 60_000);
      badge.classList.toggle('hidden', !(hasProactive && !expanded));
      try { maybeBubble(list); } catch {}
    }
    if (next.chat && next.chat.enabled === false) {
      input.disabled = true;
      btnSend.disabled = true;
      setHint('她现在不在这边聊（设置 → 悬浮窗 → 互动）');
    } else {
      input.disabled = false;
      btnSend.disabled = sending;
    }
  }

  function show() {
    try { window.SurfPet?.pause?.(); } catch {}
    closeCtxMenu();
    if (expanded) return;
    expanded = true;
    root.classList.add('expanded');
    badge.classList.add('hidden');
    ball.classList.remove('thinking');
    window.orb?.expand(true);
    // 每次打开会话先露 3 秒提示条（看屏幕现在的档位），然后自己渐隐，不留常驻条。
    try {
      const mode = screenModeOf(state?.screen);
      showHintBriefly(mode === 'off'
        ? '眼睛已关闭（双击「眼」让她看一次）'
        : mode === 'auto'
          ? '自动模式：她想看会自己说，截图看完就删'
          : '她正看着你的屏幕 · 看完就删（单击「眼」可关掉）');
    } catch {}
    setTimeout(() => input.focus(), 60);
  }

  function hide(force = false) {
    try { window.SurfPet?.resume?.(); } catch {}
    if (!expanded) return;
    if (pinned && !force) return;
    expanded = false;
    root.classList.remove('expanded');
    window.orb?.expand(false);
  }

  /**
   * 主人正在打字就别收窗口。
   * 之前只按「鼠标离开面板」计时，鼠标一移出去就收，输入框里的字跟着没了。
   * 现在只要焦点在输入框里、或者框里有字，一律不收。
   */
  const isComposing = () => {
    const el = document.getElementById('input');
    if (!el) return false;
    if (document.activeElement === el) return true;
    return String(el.value || '').trim().length > 0;
  };

  const scheduleCollapse = () => {
    if (pinned) return;
    if (isComposing()) return;
    clearTimeout(collapseTimer);
    // 鼠标离开后再等一小会儿，避免贴着边缘时被误收。
    collapseTimer = setTimeout(() => { if (!pinned && !isComposing()) hide(); }, 650);
  };

  // ---- 面板边缘拖拽缩放 ---------------------------------------------------
  // 无边框窗口没有系统缩放边框，自己在面板四边/四角做 9px 感应区，
  // 鼠标上去就换成 Windows 那种缩放指针，按住拖动由主进程改窗口大小。
  const EDGE_PX = 9;
  let resizeDrag = null;

  function edgeAt(ev) {
    const r = root.getBoundingClientRect();
    if (!expanded) return '';
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    const nearL = x <= EDGE_PX;
    const nearR = x >= r.width - EDGE_PX;
    const nearT = y <= EDGE_PX;
    const nearB = y >= r.height - EDGE_PX;
    const vertical = nearT ? 'n' : nearB ? 's' : '';
    const horizontal = nearL ? 'w' : nearR ? 'e' : '';
    return `${vertical}${horizontal}`;
  }

  function cursorFor(edge) {
    if (!edge) return '';
    if (edge === 'n' || edge === 's') return 'ns-resize';
    if (edge === 'w' || edge === 'e') return 'ew-resize';
    if (edge === 'nw' || edge === 'se') return 'nwse-resize';
    return 'nesw-resize';
  }

  window.addEventListener('mousemove', (ev) => {
    if (moveMode) { document.body.style.cursor = ''; return; }
    if (resizeDrag) {
      window.orb?.panelResizeMove({ dx: ev.screenX - resizeDrag.x, dy: ev.screenY - resizeDrag.y });
      return;
    }
    const edge = edgeAt(ev);
    document.body.style.cursor = cursorFor(edge);
  });

  window.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || !expanded) return;
    // 「移」开着的时候，按下就只可能是想挪窗口，不许同时开始缩放。
    if (moveMode) return;
    const edge = edgeAt(ev);
    if (!edge) return;
    ev.preventDefault();
    resizeDrag = { edge, x: ev.screenX, y: ev.screenY };
    window.orb?.panelResizeStart(edge);
    clearTimeout(collapseTimer);
  });

  window.addEventListener('mouseup', () => {
    if (!resizeDrag) return;
    resizeDrag = null;
    document.body.style.cursor = '';
    window.orb?.panelResizeEnd();
  });
  
  const setPinned = (on) => {
    pinned = Boolean(on);
    btnPin.classList.toggle('on', pinned);
    btnPin.title = pinned ? '已固定：鼠标离开也不收起（点一下取消）' : '固定在这里（鼠标离开也不收起）';
    if (pinned) clearTimeout(collapseTimer);
    else if (expanded) scheduleCollapse();
  };

  // 悬停只做视觉反馈，**不展开**（主人的要求：点一下才展开）。
  ball.addEventListener('mouseenter', () => { clearTimeout(collapseTimer); ball.classList.add('hot'); });
  ball.addEventListener('mouseleave', () => { ball.classList.remove('hot'); });
  document.querySelector('.panel')?.addEventListener('mouseleave', () => { if (!isComposing()) scheduleCollapse(); });
  document.querySelector('.panel')?.addEventListener('mouseenter', () => clearTimeout(collapseTimer));

  // 点击球 = 展开；拖过位置的那一下不算点击。收起用面板上的「收起」或 Esc。
  ball.addEventListener('click', () => {
    if (lastDragMoved) { lastDragMoved = false; return; }
    if (!expanded) show();
  });
  btnPin.addEventListener('click', () => setPinned(!pinned));

  // ── 面板拖动：「移」打开后，按住面板空白处就能拖（拖的是窗口，宠物跟着走） ──
  let moveMode = false;
  let moveDrag = null;
  const btnMove = document.getElementById('btnMove');
  function setMoveMode(on) {
    moveMode = on;
    btnMove?.classList.toggle('on', on);
    if (btnMove) btnMove.title = on ? '正在移动：按住面板空白处拖动（再点一下关闭）' : '移动会话窗口（点一下开启，然后按住面板拖动）';
    root.classList.toggle('movable', on);
  }
  btnMove?.addEventListener('click', () => setMoveMode(!moveMode));
  panel.addEventListener('mousedown', (ev) => {
    if (!moveMode || !expanded) return;
    if (ev.button !== 0) return;
    if (ev.target.closest('button, input, textarea, .bubble, #bubbles')) return;
    ev.preventDefault();
    // 增量式：每一步都相对「上一帧的鼠标位置」和「窗口此刻的位置」，漂移不会累积。
    moveDrag = { lastX: ev.screenX, lastY: ev.screenY, wx: window.screenX, wy: window.screenY, dx: 0, dy: 0 };
    root.classList.add('moving');
  });
  window.addEventListener('mousemove', (ev) => {
    if (!moveDrag) return;
    moveDrag.dx += ev.screenX - moveDrag.lastX;
    moveDrag.dy += ev.screenY - moveDrag.lastY;
    moveDrag.lastX = ev.screenX;
    moveDrag.lastY = ev.screenY;
    window.orb?.panelMove?.(moveDrag.wx + moveDrag.dx, moveDrag.wy + moveDrag.dy, false);
  });
  window.addEventListener('mouseup', () => {
    if (!moveDrag) return;
    moveDrag = null;
    root.classList.remove('moving');
    // 松手时问主进程要真实 bounds，别用 window.screenX（高 DPI 下会漂）。
    void (async () => {
      try {
        const pos = await window.orb.panelPos();
        if (pos?.ok) await window.orb.panelMove(pos.x, pos.y, true);
      } catch {}
    })();
  });
  btnHide.addEventListener('click', () => { setPinned(false); hide(true); });

  // 中键滚轮 / 按住中键滚 = 缩放大球（44~96）。
  const resizeBy = (delta) => {
    if (expanded) return;
    window.orb?.resize({ delta });
  };
  let middleHeld = false;
  ball.addEventListener('mousedown', (ev) => {
    if (ev.button !== 1) return;
    middleHeld = true;
    ev.preventDefault();
  });
  const onWheel = (ev) => {
    if (expanded) return;
    // 只认中键（有的驱动把中键滚轮报成 button=1，有的只置 buttons 位）。
    if (!middleHeld && ev.button !== 1 && ev.buttons !== 4) return;
    ev.preventDefault();
    resizeBy(ev.deltaY < 0 ? 4 : -4);
  };
  ball.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('mouseup', () => { middleHeld = false; });

  // 拖动：按住球拖，松手贴边。
  let drag = null;
  let lastDragMoved = false;
  ball.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    drag = { sx: ev.screenX, sy: ev.screenY, moved: false, wx: window.screenX, wy: window.screenY };
    ball.classList.add('dragging');
  });
  window.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    const dx = ev.screenX - drag.sx;
    const dy = ev.screenY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    window.orb?.move(drag.wx + dx, drag.wy + dy);
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    lastDragMoved = moved;
    ball.classList.remove('dragging');
    if (moved) window.orb?.dock();
  });

  // 右键：退出（面板里的两个按钮已经够用，不做菜单了）
  ball.addEventListener('contextmenu', (ev) => { ev.preventDefault(); window.orb?.quit(); });

  async function send() {
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true;
    btnSend.disabled = true;
    ball.classList.add('thinking');
    setHint('她在想…');
    try {
      const res = await window.orb.http('/chat', { method: 'POST', body: { text }, timeoutMs: 120000 });
      if (!res.ok) setHint(res.error || '没发出去', true);
      else {
        input.value = '';
        setHint('');
        if (res.data?.state) onState(res.data.state);
      }
    } catch (error) {
      setHint(String(error?.message ?? error), true);
    } finally {
      sending = false;
      btnSend.disabled = false;
      ball.classList.remove('thinking');
    }
  }

  btnSend.addEventListener('click', send);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });
  // 全局 Esc 收起（输入框里和面板任意处都管用）。
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { setPinned(false); hide(true); }
    touch();
  });

  // 面板上没动静太久就自己缩回球（钉住的不收）。
  setInterval(() => {
    if (!expanded || pinned || sending) return;
    if (isComposing()) return;
    if (Date.now() - lastActivity > IDLE_COLLAPSE_MS) hide();
  }, 15000);
  document.addEventListener('mousemove', touch, { passive: true });
  document.addEventListener('mousedown', touch, { passive: true });
  // 打字 = 有活动：既刷新 idle 计时，也顺手取消已经排上的收起。
  for (const ev of ['input', 'focus', 'keydown']) {
    input.addEventListener(ev, () => {
      touch();
      clearTimeout(collapseTimer);
    });
  }
  btnNew.addEventListener('click', async () => {
    const res = await window.orb.http('/history/clear', { method: 'POST', body: {} });
    if (res.ok) { lastSeq = 0; bubbles.querySelectorAll('.bubble').forEach((n) => n.remove()); empty.style.display = 'block'; setHint('新对话'); }
  });

  // ==== 桌宠形象（素材来自 dsh-pet）====================================
  // 桌宠模式下窗口比宠物大（头顶留气泡），所以除了宠物身体和气泡，
  // 整块窗口都必须把鼠标让回桌面，否则一开会话就挡住桌面右缘一条竖带。
  const petStage = document.getElementById('pet');
  const bubbleEl = document.getElementById('bubble');
  // 右键菜单（窗口内绘制，尺寸不动）
  const ctxMenuEl = document.getElementById('ctxmenu');
  const ctxSizeEl = document.getElementById('ctxSize');
  const ctxSizeRange = document.getElementById('ctxSizeRange');
  const ctxSizeValue = document.getElementById('ctxSizeValue');
  const ctxOpenBtn = document.getElementById('ctxOpen');
  const ctxActionBtn = document.getElementById('ctxAction');
  const ctxHideBtn = document.getElementById('ctxHide');
  const ctxSizeToggle = document.getElementById('ctxSizeToggle');
  let petMode = false;
  // 本地微调过的大小（右键滑条写的 prefs.petSize），开菜单时要用它回填滑条
  let petPrefs = null;

  /**
   * 命中判定：只有「她身体那一块」才算抓到。
   * 不能直接用 video 的矩形——video 是 height:100% 铺满整个 stage（含头顶 110px 的气泡带和左右留白），
   * 那样窗口里任何一点按下都会被当成抓住她。这里按宠物实际尺寸算一个居中的底部方块。
   */
  /**
   * 命中判定：窗口 = 宠物(size) + 头顶气泡带(110) + 左右各 20 的透明边。
   * 用「窗口几何」判断最稳：干掉头顶那条气泡带、左右各 12px 的透明边，剩下就是她的身体区域。
   * （不按 video 的矩形算——video 是 height:100% 铺满整个 stage，等于窗口里任何一点都算抓到她。）
   */
  const petBodyHit = (ev) => {
    if (!petStage || petStage.classList.contains('hidden')) return false;
    const stage = petStage.getBoundingClientRect();
    if (stage.width <= 0 || stage.height <= 0) return false;
    // PET_BUBBLE_SPACE=110（头顶留给气泡），PET_SIDE_SPACE=40（左右各 20）
    const bubbleBand = Math.min(110, Math.round(stage.height * 0.42));
    const sidePad = Math.min(12, Math.round(stage.width * 0.08));
    const inside = ev.clientX >= stage.left + sidePad && ev.clientX <= stage.right - sidePad
      && ev.clientY >= stage.top + bubbleBand - 6 && ev.clientY <= stage.bottom;
    if (inside) return true;
    // 气泡露出来时，点气泡也能开会话
    if (bubbleEl && !bubbleEl.classList.contains('hidden')) {
      const r = bubbleEl.getBoundingClientRect();
      if (r.width > 0 && ev.clientX >= r.left - 4 && ev.clientX <= r.right + 4 && ev.clientY >= r.top - 4 && ev.clientY <= r.bottom + 4) return true;
    }
    return false;
  };
  window.addEventListener('mousemove', (ev) => {
    if (!petMode || expanded) return;
    window.orb?.hit?.(petBodyHit(ev));
  });

  async function initPet() {
    if (!window.SurfPet) return false;
    let ok = false;
    try { ok = await window.SurfPet.init(); } catch (error) { setHint(String(error?.message ?? error), true); }
    petMode = Boolean(ok);
    // 桌宠出来就把后备小球藏起来（面板展开时两者都隐藏，由 CSS 管）
    ball.classList.toggle('hidden', petMode);
    root.classList.toggle('petmode', petMode);
    if (!petMode) return false;

    petStage.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0 || expanded) return;
      // 窗口比宠物大（左右透明边 + 头顶气泡带），只有真的按在她身上才算拖她。
      if (!petBodyHit(ev)) return;
      drag = { sx: ev.screenX, sy: ev.screenY, moved: false, wx: window.screenX, wy: window.screenY };
      window.SurfPet?.drag();
    });
    petStage.addEventListener('click', () => {
      if (lastDragMoved) { lastDragMoved = false; return; }
      if (expanded) return;
      const cfg = window.__petCfg;
      if (cfg?.singleClickOpens) { show(); return; }
      window.SurfPet?.react();
    });
    petStage.addEventListener('dblclick', (ev) => {
      if (!expanded && petBodyHit(ev)) show();
    });
    // 右键 = 菜单（打开会话 / 换个动作 / 大小 / 隐藏），菜单画在窗口内部，不改窗口尺寸
    petStage.addEventListener('contextmenu', (ev) => {
      if (!petBodyHit(ev)) return;
      ev.preventDefault();
      openCtxMenu(ev);
    });
    bubbleEl?.addEventListener('click', () => show());
    window.orb.onPetAction?.(() => window.SurfPet?.shuffle());
    try { window.__petCfg = (await window.orb.petconfig())?.pet || null; } catch {}
    try { petPrefs = (await window.orb.prefs?.()) || null; } catch {}
    return true;
  }

    // ---- 右键菜单（窗口内 HTML）-------------------------------------------------
  // 主人要的：右键还是原来那几个设置项，只是多一项「大小」；点大小就在旁边出滑条。
  // 窗口尺寸一动不动，所以必须画在窗口内部，不能用原生菜单（原生菜单放不了控件）。
  let ctxOpenState = false;
  let ctxSizeShown = false;

  function placeCtxMenu(ev) {
    if (!ctxMenuEl) return;
    const rootRect = root.getBoundingClientRect();
    const petRect = (petStage || root).getBoundingClientRect();
    const mw = 168;
    const mh = ctxSizeShown ? 214 : 176;
    // 优先贴在宠物右边，放不下就翻到左边；竖直方向跟鼠标对齐，夹在窗口内。
    let left = petRect.right - rootRect.left + 6;
    if (left + mw > rootRect.width) left = petRect.left - rootRect.left - mw - 6;
    if (left < 4) left = 4;
    let top = (ev?.clientY ?? petRect.top - rootRect.top) - 8;
    top = Math.max(4, Math.min(top, rootRect.height - mh - 4));
    ctxMenuEl.style.left = `${Math.round(left)}px`;
    ctxMenuEl.style.top = `${Math.round(top)}px`;
  }

  function openCtxMenu(ev) {
    try { window.orb?.log?.('[menu] open'); } catch {}
    ctxOpenState = true;
    ctxSizeShown = false;
    ctxSizeEl?.classList.add('hidden');
    ctxMenuEl?.classList.remove('hidden');
    root.classList.add('ctxopen');
    placeCtxMenu(ev);
    // 菜单可能比窗口大：让主进程临时把窗口长大，并把宠物按 dx/dy 挪回去，视觉上宠物不动
    try {
      const rect = ctxMenuEl?.getBoundingClientRect();
      const need = rect ? { width: Math.ceil(rect.width) + 16, height: Math.ceil(rect.height) + 16 } : { width: 0, height: 0 };
      const box = window.orb?.menurect ? window.orb.menurect(need) : null;
      const apply = (b) => {
        if (!b) return;
        root.style.setProperty('--pet-dx', `${Number(b.dx) || 0}px`);
        root.style.setProperty('--pet-dy', `${Number(b.dy) || 0}px`);
      };
      if (box && typeof box.then === 'function') box.then(apply).catch(() => {});
      else apply(box);
    } catch {}
    const size = Number(petPrefs?.petSize) || Number(window.__petCfg?.size) || 200;
    if (ctxSizeRange) ctxSizeRange.value = String(size);
    if (ctxSizeValue) ctxSizeValue.textContent = String(size);
  }

  function closeCtxMenu() {
    try { window.orb?.log?.('[menu] close'); } catch {}
    if (!ctxOpenState) return;
    ctxOpenState = false;
    ctxSizeShown = false;
    ctxMenuEl?.classList.add('hidden');
    ctxSizeEl?.classList.add('hidden');
    root.classList.remove('ctxopen');
    // 还原窗口尺寸与宠物偏移
    try {
      const box = window.orb?.menurect ? window.orb.menurect({ width: 0, height: 0 }) : null;
      const apply = (b) => {
        root.style.setProperty('--pet-dx', `${Number(b?.dx) || 0}px`);
        root.style.setProperty('--pet-dy', `${Number(b?.dy) || 0}px`);
      };
      if (box && typeof box.then === 'function') box.then(apply).catch(() => {});
      else apply(box);
      if (ctxSizeShown) window.orb?.petSize?.(Number(ctxSizeRange?.value) || 200);
    } catch {}
  }

  ctxOpenBtn?.addEventListener('click', () => { closeCtxMenu(); show(); });
  ctxActionBtn?.addEventListener('click', () => { closeCtxMenu(); window.SurfPet?.shuffle(); });
  ctxHideBtn?.addEventListener('click', () => { closeCtxMenu(); hide(true); });
  ctxSizeToggle?.addEventListener('click', () => {
    try { window.orb?.log?.('[menu] size toggle ' + String(ctxSizeShown)); } catch {}
    ctxSizeShown = !ctxSizeShown;
    ctxSizeEl?.classList.toggle('hidden', !ctxSizeShown);
    // 菜单变高了，重新夹一次位置，别被窗口下沿切掉
    placeCtxMenu(null);
  });
  ctxSizeRange?.addEventListener('input', () => {
    const v = Number(ctxSizeRange.value);
    if (ctxSizeValue) ctxSizeValue.textContent = String(v);
    window.orb?.petSize?.(v);
  });
  // 点菜单外面 / Esc / 开始拖动，都把菜单收起来
  window.addEventListener('mousedown', (ev) => {
    if (!ctxOpenState) return;
    if (ctxMenuEl && ctxMenuEl.contains(ev.target)) return;
    closeCtxMenu();
  }, true);
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && ctxOpenState) closeCtxMenu(); });
// 面板收起时，她最新一句（含主动）在头顶冒气泡；点气泡开会话。
  let lastBubbleMsgId = '';
  function maybeBubble(list) {
    if (!petMode || expanded) return;
    const last = [...list].reverse().find((m) => m && m.text && (m.who === 'her' || m.who === undefined));
    if (!last || !last.id || last.id === lastBubbleMsgId) return;
    try { window.orb?.log?.('[pet] bubble ' + String(last.id)); } catch {}
    lastBubbleMsgId = last.id;
    const ttl = Number(state?.config?.chat?.bubbleTtlSec || 8) * 1000;
    window.SurfPet?.showBubble(last.text, { kind: last.kind === 'proactive' ? 'proactive' : 'her', ttlMs: ttl, onClick: () => show() });
  }

  window.orb.onState(onState);
  window.orb.onConn(({ ok, error }) => {
    connDot.className = `dot ${ok ? 'ok' : 'bad'}`;
    connDot.title = ok ? '已连上 SurfCore' : `连不上：${error || ''}`;
    if (!ok) setHint(error || '连不上 SurfCore', true);
    else setHint('');
  });

  // 首屏：主动拉一次，避免等到第一个 3 秒 tick 才显示。
  window.orb.http('/state').then((res) => { if (res.ok) onState(res.data); });
  initPet();
})();
