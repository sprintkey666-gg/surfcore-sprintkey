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
  let lastHeight = 0;
  let measureRaf = 0;

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

  function applyConfig() {
    const alpha = Math.min(0.9, Math.max(0, Number(state.opacity ?? 55) / 100));
    document.body.style.setProperty('--alpha', String(alpha));
    const font = Math.min(40, Math.max(14, Number(state.fontPx) || 22));
    document.body.style.setProperty('--font', `${font}px`);
    if (fontVal) fontVal.textContent = String(font);
  }

  function adjustFont(delta) {
    state.fontPx = Math.min(40, Math.max(14, Number(state.fontPx || 22) + delta));
    applyConfig();
    companion?.font?.(state.fontPx).catch(() => {});
    dimTimerReset();
    scheduleMeasure();
  }

  function renderThread() {
    const list = messages();
    bar.classList.toggle('single', !state.contextSubtitles);
    bar.classList.toggle('empty', list.length === 0);
    bar.classList.toggle('history', historyOpen);
    bar.classList.toggle('open', inputOpen || historyOpen);
    thread.textContent = '';

    if (historyOpen) {
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
      history.scrollTop = history.scrollHeight;
      scheduleMeasure();
      return;
    }

    const picked = state.contextSubtitles
      ? list.slice(-3)
      : (latestHer() ? [latestHer()] : []);
    for (const m of picked) {
      const line = document.createElement('div');
      line.className = `line ${m.who === 'me' ? 'me' : 'her'}`;
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = m.who === 'me' ? '爹' : '她';
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = m.text;
      line.append(who, text);
      thread.append(line);
    }
    placeholder.textContent = state.lastError
      ? `有点卡：${state.lastError}`
      : (list.length ? '在陪你看着…' : '在陪你看着，先不说话。');
    const badge = state.contextSubtitles ? '上下文 · 最多 3 条' : '';
    modeEl.textContent = badge;
    dot.classList.toggle('err', Boolean(state.lastError));
    title.textContent = state.active === false ? '陪看暂停' : (state.lastError ? '有点卡' : '陪你看会儿');
    scheduleMeasure();
  }

  function measureNow() {
    measureRaf = 0;
    if (!companion?.height) return;
    const height = Math.ceil(bar.scrollHeight + 2);
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    companion.height(height).catch(() => {});
  }

  function scheduleMeasure() {
    if (measureRaf) cancelAnimationFrame(measureRaf);
    measureRaf = requestAnimationFrame(measureNow);
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
      bar.style.display = 'none';
      return;
    }
    bar.style.display = '';
    applyConfig();
    renderThread();
    dimTimerReset();
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

  companion?.onState?.(onState);
  companion?.status?.().then((res) => {
    const s = res?.companion || res?.status || res;
    if (s && typeof s === 'object') onState(s);
  }).catch(() => {});
  applyConfig();
  renderThread();
})();
