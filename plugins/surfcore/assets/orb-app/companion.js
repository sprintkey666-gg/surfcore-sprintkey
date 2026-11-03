(() => {
  'use strict';

  const bar = document.getElementById('bar');
  const dot = document.getElementById('dot');
  const title = document.getElementById('title');
  const modeEl = document.getElementById('mode');
  const thread = document.getElementById('thread');
  const placeholder = document.getElementById('placeholder');
  const history = document.getElementById('history');
  const inputRow = document.getElementById('inputRow');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const closeBtn = document.getElementById('close');
  const resize = document.getElementById('resize');
  const fontDown = document.getElementById('fontDown');
  const fontUp = document.getElementById('fontUp');
  const fontVal = document.getElementById('fontVal');
  const fontCtl = document.getElementById('fontCtl');

  const companion = window.orb?.companion;
  let state = {
    active: false, messages: [], subtitle: null,
    fontPx: 22, width: 900, opacity: 55, contextSubtitles: false,
    lastError: '',
  };
  let historyOpen = false;
  let inputOpen = false;
  let sending = false;
  let drag = null;
  let dimTimer = 0;
  let measureTimer = 0;
  let lastSentHeight = 0;
  // 渲染缓存：状态每 3 秒到一次，全量重建 DOM 会让透明窗反复重绘（字幕背景闪的第二个来源）。
  let threadRows = [];
  let threadMode = '';
  let historySig = '';

  const nowClock = (at) => {
    const d = at ? new Date(at) : new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  function messages() {
    return Array.isArray(state.messages) ? state.messages : [];
  }

  function latestHer() {
    const list = messages();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.who !== 'me') return list[i];
    }
    return list[list.length - 1] || null;
  }

  let appliedAlpha = null;
  let appliedFont = 0;

  function applyConfig() {
    const alpha = Math.min(0.9, Math.max(0, Number(state.opacity ?? 55) / 100));
    const font = Math.min(40, Math.max(14, Number(state.fontPx) || 22));
    // 只在值真的变了才写 CSS 变量：每次状态同步都重设一遍会让透明窗重新算一遍样式。
    if (alpha !== appliedAlpha) {
      appliedAlpha = alpha;
      document.body.style.setProperty('--alpha', String(alpha));
    }
    if (font !== appliedFont) {
      appliedFont = font;
      document.body.style.setProperty('--font', `${font}px`);
    }
    setText(fontVal, String(font));
  }

  function adjustFont(delta) {
    state.fontPx = Math.min(40, Math.max(14, Number(state.fontPx || 22) + delta));
    applyConfig();
    companion?.font?.(state.fontPx).catch(() => {});
    dimTimerReset();
    scheduleMeasure();
  }

  function setText(node, value) {
    const text = String(value ?? '');
    if (node && node.textContent !== text) node.textContent = text;
  }

  // 历史行只在「按住 Ctrl+Alt」时出现：内容没变就别重建（重建会重排滚动位置，也会让整窗重绘）。
  function renderHistory(list) {
    const sig = list.map((m) => `${m.at || ''}\u0001${m.who || ''}\u0001${m.text || ''}`).join('\u0002');
    if (sig !== historySig) {
      historySig = sig;
      const wrap = document.createDocumentFragment();
      for (const m of list) {
        const row = document.createElement('div');
        row.className = `hrow ${m.who === 'me' ? 'me' : 'her'}`;
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = m.who === 'me' ? '爹' : '她';
        const text = document.createElement('span');
        text.className = 'text';
        text.textContent = m.text;
        const at = document.createElement('span');
        at.className = 'at';
        at.textContent = nowClock(m.at);
        row.append(who, text, at);
        wrap.append(row);
      }
      history.replaceChildren(wrap);
      scheduleMeasure();
    }
    history.scrollTop = history.scrollHeight;
  }

  function renderThread() {
    const list = messages();
    bar.classList.toggle('single', !state.contextSubtitles);
    bar.classList.toggle('empty', list.length === 0);
    bar.classList.toggle('history', historyOpen);
    bar.classList.toggle('open', inputOpen || historyOpen);

    if (historyOpen) {
      renderHistory(list);
      return;
    }
    historySig = '';
    // 单条 / 上下文：行节点按位置复用，只改文字和 class。
    // 以前每次 onState 都 thread.textContent='' 再重建，透明窗整块重绘 → 「字幕背景一直在闪」。
    const mode = state.contextSubtitles ? 'ctx' : 'single';
    const picked = state.contextSubtitles
      ? list.slice(-3)
      : (latestHer() ? [latestHer()] : []);
    if (threadMode !== mode) {
      thread.textContent = '';
      threadRows = [];
      threadMode = mode;
    }
    while (threadRows.length > picked.length) {
      const row = threadRows.pop();
      row.line.remove();
    }
    for (let i = 0; i < picked.length; i += 1) {
      const m = picked[i];
      if (!threadRows[i]) {
        const line = document.createElement('div');
        const who = document.createElement('span');
        who.className = 'who';
        const text = document.createElement('span');
        text.className = 'text';
        line.append(who, text);
        threadRows.push({ line, who, text });
        thread.append(line);
      }
      const row = threadRows[i];
      const cls = `line ${m.who === 'me' ? 'me' : 'her'}`;
      if (row.line.className !== cls) row.line.className = cls;
      setText(row.who, m.who === 'me' ? '爹' : '她');
      setText(row.text, m.text);
    }
    setText(placeholder, state.lastError
      ? `有点卡：${state.lastError}`
      : (list.length ? '在陪你看着…' : '在陪你看着，先不说话。'));
    setText(modeEl, state.contextSubtitles ? '上下文 · 最多 3 条' : '');
    dot.classList.toggle('err', Boolean(state.lastError));
    setText(title, state.active === false ? '陪看暂停' : (state.lastError ? '有点卡' : '陪你看会儿'));
    scheduleMeasure();
  }

  // 高度测量：改成观察 .bar 的真实尺寸（ResizeObserver），不再用 scrollHeight + rAF。
  // 旧实现里 scrollHeight 会在中文折行/字体切换时先给一个中途值，rAF 又恰好和主进程 setBounds 交错，
  // 高度刚改完又按旧内容算回去一次——这就是「字幕条上下跳」。这里只报「尺寸真的变了」，
  // 8px 网格 / 12px 死区交给主进程的 snapCompanionHeight 判定。
  function measureNow() {
    measureTimer = 0;
    if (!companion?.height) return;
    const height = Math.ceil(bar.getBoundingClientRect().height);
    // 陪伴暂停（bar display:none）时量到 0，别把窗口缩没。
    if (!height || height < 40) return;
    if (height === lastSentHeight) return;
    lastSentHeight = height;
    companion.height(height).catch(() => {});
  }

  function scheduleMeasure() {
    if (measureTimer) return;
    measureTimer = setTimeout(measureNow, 40);
  }

  function setHistory(open) {
    if (historyOpen === open) return;
    historyOpen = open;
    if (open) dimTimerReset();
    renderThread();
  }

  function dimTimerReset() {
    clearTimeout(dimTimer);
    bar.classList.remove('dim');
    dimTimer = setTimeout(() => {
      if (!historyOpen && !inputOpen && !bar.matches(':hover')) bar.classList.add('dim');
    }, 25000);
  }

  function openInput() {
    if (inputOpen) return;
    inputOpen = true;
    bar.classList.add('open');
    dimTimerReset();
    renderThread();
    setTimeout(() => { input.focus(); }, 30);
  }

  function closeInput() {
    if (!inputOpen) return;
    inputOpen = false;
    bar.classList.remove('open');
    input.blur();
    renderThread();
  }

  async function send() {
    const text = String(input.value || '').trim();
    if (!text || sending) return;
    // 点了发送就先清空；失败也不把问题残留在框里。
    input.value = '';
    sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = '…';
    try {
      const r = await companion.reply(text);
      if (r?.ok === false) {
        placeholder.textContent = String(r.error || '发送失败').slice(0, 80);
      } else {
        closeInput();
      }
    } catch (error) {
      placeholder.textContent = String(error?.message || error).slice(0, 80);
    } finally {
      sending = false;
      sendBtn.disabled = false;
      sendBtn.textContent = '发';
      dimTimerReset();
    }
  }

  function onState(next) {
    if (!next || typeof next !== 'object') return;
    state = { ...state, ...next, messages: Array.isArray(next.messages) ? next.messages.slice(-200) : [] };
    if (state.active === false) {
      if (bar.style.display !== 'none') bar.style.display = 'none';
      return;
    }
    if (bar.style.display === 'none') bar.style.display = '';
    applyConfig();
    renderThread();
    // 注意：这里不再调 dimTimerReset()。以前主进程每 3 秒同步一次状态，
    // 每同步一次就把 25s 变暗计时器清零，字幕条于是一直不变暗、还每 3 秒闪一下。
    // 变暗只由鼠标移出 / 交互重置（dimTimerReset 的调用点都在用户动作里）。
  }

  // 拖动：左键长按（或按住直接移动）才是拖动；单击只开/收输入框。
  let pressTimer = null;
  const beginDrag = () => {
    if (!drag || drag.active) return;
    drag.active = true;
    bar.classList.add('dragging');
    companion?.dragStart?.().catch(() => {});
  };

  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('button, input, .resize, .history, .fontctl')) return;
    drag = { x: event.screenX, y: event.screenY, moved: false, active: false };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      if (drag && !drag.moved) beginDrag();
    }, 260);
  });

  window.addEventListener('pointermove', (event) => {
    if (!drag) return;
    if (Math.hypot(event.screenX - drag.x, event.screenY - drag.y) > 5) {
      drag.moved = true;
      beginDrag();
    }
  });

  window.addEventListener('pointerup', (event) => {
    if (!drag) return;
    clearTimeout(pressTimer);
    const wasDrag = drag.active;
    drag = null;
    bar.classList.remove('dragging');
    companion?.dragEnd?.().catch(() => {});
    if (!wasDrag && !event.target.closest('button, input, .resize, .history, .fontctl')) {
      if (inputOpen) closeInput();
      else openInput();
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
    if (event.key === 'Escape') { event.preventDefault(); closeInput(); }
  });
  sendBtn.addEventListener('click', () => void send());
  closeBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    closeInput();
    try { await companion?.toggle?.(true); } catch {}
  });

  // 宽度手柄：实时改宽，主进程负责夹到屏幕和工作区。
  let resizing = null;
  resize.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    resizing = { x: event.screenX, width: bar.getBoundingClientRect().width };
    resize.setPointerCapture?.(event.pointerId);
  });
  window.addEventListener('pointermove', (event) => {
    if (!resizing) return;
    const width = resizing.width + (event.screenX - resizing.x);
    companion?.width?.(Math.round(width)).catch(() => {});
  });
  window.addEventListener('pointerup', () => {
    if (!resizing) return;
    resizing = null;
    companion?.save?.().catch(() => {});
  });

  fontDown?.addEventListener('pointerdown', (event) => event.stopPropagation());
  fontUp?.addEventListener('pointerdown', (event) => event.stopPropagation());
  fontCtl?.addEventListener('pointerdown', (event) => event.stopPropagation());
  fontDown?.addEventListener('click', () => adjustFont(-2));
  fontUp?.addEventListener('click', () => adjustFont(2));

  // Ctrl+滚轮调字号：本地先变，高度由主进程按顶边锚点伸缩。
  bar.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const delta = event.deltaY > 0 ? -1 : 1;
    adjustFont(delta * 2);
  }, { passive: false });

  // 按住 Ctrl+Alt 展开历史（像会话一样上下滚），松开收回。
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.altKey) setHistory(true);
  });
  window.addEventListener('keyup', (event) => {
    if (!event.ctrlKey || !event.altKey) setHistory(false);
  });
  window.addEventListener('blur', () => setHistory(false));
  bar.addEventListener('mouseenter', () => { bar.classList.remove('dim'); });
  bar.addEventListener('mouseleave', () => dimTimerReset());

  // 尺寸变化 → 报给主进程。ResizeObserver 只在实际布局尺寸变了才回调，
  // 比原来「scrollHeight + rAF」稳：不会在字体/折行过程中报中间值。
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => scheduleMeasure()).observe(bar);
  } else {
    window.addEventListener('resize', () => scheduleMeasure());
  }

  companion?.onState?.(onState);
  companion?.status?.().then((res) => {
    const s = res?.companion || res?.status || res;
    if (s && typeof s === 'object') onState(s);
  }).catch(() => {});
  applyConfig();
  renderThread();
  // 启动即开始 25s 空闲变暗计时（onState 现在不会再把它重置掉）。
  dimTimerReset();
})();
