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
  const btnAttach = document.getElementById('btnAttach');
  const composerEl = document.querySelector('.composer');
  const attachmentsEl = document.getElementById('composerAttachments');
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

  // ==== 待发附件（图片 / 文件）========================================
  // 路径能拿到就只传路径（服务端读原文）；浏览器粘贴的图片没有路径，转 dataURL。
  const MAX_PENDING_FILES = 6;
  const MAX_PENDING_IMAGE = 8 * 1024 * 1024;
  const MAX_PENDING_FILE = 20 * 1024 * 1024;
  const MAX_PENDING_DATA = 16 * 1024 * 1024;
  let pendingFiles = [];

  const filesBytes = () => pendingFiles.reduce((n, f) => n + Number(f.size || 0), 0);
  const dataBytes = () => pendingFiles.reduce((n, f) => n + (f.dataUrl ? String(f.dataUrl).length : 0), 0);
  const fileUrlOf = (p) => `file:///${String(p).replace(/\\/g, '/')}`;
  const fmtSize = (n) => {
    const b = Number(n) || 0;
    if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}M`;
    if (b >= 1024) return `${Math.round(b / 1024)}K`;
    return `${b}B`;
  };

  function renderAttachments() {
    if (!attachmentsEl) return;
    attachmentsEl.innerHTML = '';
    attachmentsEl.classList.toggle('hidden', pendingFiles.length === 0);
    pendingFiles.forEach((file, index) => {
      const chip = document.createElement('div');
      chip.className = 'file-chip';
      chip.title = file.name;
      if (file.kind === 'image' && (file.dataUrl || file.path)) {
        const img = document.createElement('img');
        img.className = 'thumb';
        img.alt = '';
        img.src = file.dataUrl || fileUrlOf(file.path);
        chip.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.textContent = '📄';
        icon.style.fontSize = '16px';
        icon.style.flex = '0 0 auto';
        chip.appendChild(icon);
      }
      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = `${file.name} · ${fmtSize(file.size)}`;
      chip.appendChild(name);
      const x = document.createElement('button');
      x.className = 'chip-x';
      x.type = 'button';
      x.title = '移除';
      x.textContent = '×';
      x.addEventListener('click', () => {
        pendingFiles.splice(index, 1);
        renderAttachments();
      });
      chip.appendChild(x);
      attachmentsEl.appendChild(chip);
    });
  }

  function addPending(item) {
    if (!item || !item.name) return false;
    if (pendingFiles.length >= MAX_PENDING_FILES) {
      setHint(`一次最多带 ${MAX_PENDING_FILES} 个附件`, true);
      return false;
    }
    const size = Number(item.size) || 0;
    if (item.kind === 'image' && size > MAX_PENDING_IMAGE) {
      setHint(`图片「${item.name}」超过 8M，换张小点的`, true);
      return false;
    }
    if (item.kind !== 'image' && size > MAX_PENDING_FILE) {
      setHint(`文件「${item.name}」超过 20M`, true);
      return false;
    }
    if (dataBytes() + (item.dataUrl ? String(item.dataUrl).length : 0) > MAX_PENDING_DATA) {
      setHint('附件总共太大了，分两次发吧', true);
      return false;
    }
    const dup = pendingFiles.some((f) => (f.path && item.path && f.path === item.path)
      || (!f.path && !item.path && f.name === item.name && f.size === item.size));
    if (dup) return false;
    pendingFiles.push(item);
    renderAttachments();
    return true;
  }

  function addPicked(list) {
    for (const raw of Array.isArray(list) ? list : []) {
      if (!raw?.path) continue;
      const name = String(raw.name || raw.path.split(/[\\/]/).pop() || '文件');
      const kind = /\.(png|jpe?g|webp|gif|bmp)$/i.test(name) || String(raw.mime || '').startsWith('image/') ? 'image' : 'file';
      addPending({ name, size: raw.size, path: raw.path, kind });
    }
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }

  async function addFromFile(file) {
    if (!file) return;
    const name = String(file.name || '粘贴的文件');
    const kind = String(file.type || '').startsWith('image/') ? 'image' : 'file';
    const size = Number(file.size) || 0;
    let path = '';
    try { path = String(window.orb?.pathForFile?.(file) || ''); } catch { path = ''; }
    if (path) {
      addPending({ name, size, path, kind });
      return;
    }
    if (kind === 'image') {
      try {
        const dataUrl = await readAsDataUrl(file);
        addPending({ name, size, dataUrl, kind });
      } catch (error) {
        setHint(String(error?.message ?? error), true);
      }
      return;
    }
    // 没有路径的小文本文件：直接读成 text 交给服务端拼提示词。
    if (size <= 200 * 1024 && (String(file.type || '').startsWith('text/') || /\.(txt|md|json|jsonl|csv|log|js|ts|py|html|css|xml|ya?ml)$/i.test(name))) {
      try {
        const text = await file.text();
        addPending({ name, size, text, kind: 'file' });
      } catch (error) {
        setHint(String(error?.message ?? error), true);
      }
      return;
    }
    setHint('这个文件拿不到本地路径，换「+」选一次试试', true);
  }

  function addFromDataTransfer(dt) {
    const files = Array.from(dt?.files || []);
    for (const file of files) addFromFile(file);
    // 有些应用拖拽只给 items，没有 files。
    if (!files.length && dt?.items) {
      for (const item of Array.from(dt.items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) addFromFile(file);
        }
      }
    }
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
        if (who.avatarUrl) img.src = who.avatarUrl;
        else img.classList.add('noava');
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
      // 气泡图文一体（设置 → 悬浮窗 → 发图）：开 = 同一条消息的图和字在一个气泡里；
      // 关 = 图、字各占一个气泡。纯图/纯字两种都只有一个气泡。
      const rich = state?.config?.chat?.richBubble !== false;
      const splitPic = !rich && !!m.image && !!m.text;
      const makeBubble = (withPic, withText, withMeta) => {
        const el = document.createElement('div');
        el.className = `bubble ${mine ? 'me' : 'her'}${m.kind === 'proactive' ? ' proactive' : ''}${withPic ? ' haspic' : ''}`;
        // 带图的消息：图片在上、文字在下（发表情包时常常没字）。
        if (withPic) {
          const pic = document.createElement('img');
          pic.className = 'pic';
          pic.alt = '';
          pic.src = 'file:///' + encodeURI(String(m.image).replace(/\\/g, '/'));
          // 图被删了 / 路径失效：塌成一条小提示，别留个破图占着气泡（球里没有 devtools）。
          pic.addEventListener('error', () => {
            pic.classList.add('missing');
            pic.alt = '图片加载不出来';
            pic.removeAttribute('src');
          });
          // 双击看图（像 QQ 一样）：滚轮缩放、左键拖动、右上角 ×。
          pic.addEventListener('dblclick', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (pic.classList.contains('missing')) return;
            openViewer(pic.src);
          });
          el.appendChild(pic);
        }
        if (withText && m.text) el.appendChild(document.createTextNode(esc(m.text)));
        if (withText && Array.isArray(m.files) && m.files.length) {
          const box = document.createElement('div');
          box.className = 'bubble-files';
          for (const file of m.files) {
            if (file?.kind === 'image' && file.imagePath) {
              const img = document.createElement('img');
              img.alt = file.name || '图片';
              img.title = `${file.name || '图片'} · ${fmtSize(file.size)}`;
              img.src = fileUrlOf(file.imagePath);
              img.addEventListener('error', () => { img.style.display = 'none'; });
              img.addEventListener('dblclick', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                openViewer(img.src);
              });
              box.appendChild(img);
            } else {
              const chip = document.createElement('span');
              chip.className = 'bubble-file';
              chip.title = file?.name || '文件';
              chip.textContent = `📄 ${file?.name || '文件'} · ${fmtSize(file?.size)}`;
              box.appendChild(chip);
            }
          }
          el.appendChild(box);
        }
        if (withMeta) {
          const meta = document.createElement('span');
          meta.className = 'meta';
          meta.textContent = hhmm(m.at);
          el.appendChild(meta);
        }
        return el;
      };
      if (splitPic) {
        col.appendChild(makeBubble(true, false, false));
        col.appendChild(makeBubble(false, true, true));
      } else {
        col.appendChild(makeBubble(!!m.image, true, true));
      }
      div.appendChild(col);
      bubbles.appendChild(div);
    }
    // 新消息一律把最新那条顶到最下面（像 QQ 一样）；但他正在翻历史时不要抢滚动，
    // 改成右下角亮一个小圆按钮，点了才回去。
    // 未读只在「面板开着、而且他翻在历史里」时才计数——收起来的时候没人看得见小圆，
    // 之前一收起就默默攒数字，再打开直接蹦出个 7，很怪。
    if (items.length > prevCount && !atBottom && expanded) {
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

  /**
   * 把 /screen/eye 的回包并回本地 state：服务端改完配置会回一份「新的」screen，
   * 只信它，别自己猜 mode（之前拿旧 state 硬改，按钮就卡在「手动」不动）。
   */
  function applyScreenResult(res) {
    const fromScreen = res?.screen && typeof res.screen === 'object' ? res.screen : null;
    const next = fromScreen || (res && (typeof res.mode === 'string' || typeof res.enabled === 'boolean')
      ? { mode: res.mode || (res.enabled === false ? 'off' : 'manual'), enabled: res.enabled !== false }
      : null);
    if (!next) return;
    state = { ...(state || {}), screen: { ...(state?.screen || {}), ...next } };
    try { renderScreenHint(state.screen); } catch {}
  }

  /** 单击「眼」：开着（手动/自动）就关掉；已经关着什么都不做（交给单击提示）。 */
  async function toggleEye() {
    if (eyeBusy) return;
    const btn = document.getElementById('btnEye');
    eyeBusy = true;
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    try {
      const res = await window.orb.http('/screen/eye', { method: 'POST', body: { enabled: false }, timeoutMs: 20000 });
      applyScreenResult(res);
      setHint('眼睛关上了');
      showHintBriefly('眼睛已关闭 · 双击「眼」让她看一次');
    } catch (error) {
      setHint('关眼睛失败：' + String(error?.message ?? error).slice(0, 60));
    } finally {
      eyeBusy = false;
      if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
    }
  }

  // 单击「眼」= 关闭眼睛；双击「眼」= 让她看一次（截图识别一次）。
  // 单击要等一下再执行，才能区分出双击（230ms 内没有第二下才算单击）。
  let eyeClickTimer = null;

  /**
   * 双击：不管当前开没开，都请求「现在看一次」。
   * 服务端把 enabled:true 理解成「打开 + 立刻拍一张」，所以一条请求就够；
   * 以前是先 POST 打开、再 toggleEye 把它关掉，等于开了就关，纯属自己绕自己。
   */
  async function lookOnce() {
    if (eyeBusy) return;
    const btn = document.getElementById('btnEye');
    eyeBusy = true;
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    setHint('正在看她看到的画面…');
    try {
      const res = await window.orb.http('/screen/eye', { method: 'POST', body: { enabled: true }, timeoutMs: 120000 });
      applyScreenResult(res);
      if (res?.visionOk === false) setHint('当前模型看不了图，开了也没用');
      else if (res?.ok) setHint('看过了');
      else setHint(String(res?.error || '这次没看成'));
    } catch (error) {
      setHint('看一眼失败：' + String(error?.message ?? error).slice(0, 60));
    } finally {
      eyeBusy = false;
      if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
    }
  }

  document.getElementById('btnEye')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (eyeClickTimer) return;
    eyeClickTimer = setTimeout(() => {
      eyeClickTimer = null;
      if (screenModeOf(state?.screen) !== 'off') { void toggleEye(); return; }
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
      // 现场生图要 30~120 秒，别用 30 秒的短超时把它掐掉。
      const res = await window.orb.http('/pic', { method: 'POST', body: { hint }, timeoutMs: 180000 });
      if (res?.ok) {
        setHint(res.source === 'sticker' ? '偷了张表情包发给你' : res.source === 'local' ? '从图库挑了一张' : '刚画好，发给你');
        return;
      }
      if (res?.needGenerate) {
        // 服务端已经尽力画过了：画不出来才把 prompt 交回聊天里的 agent（/pic/image 回填）。
        setHint(String(res.error || '这张画不出来，叫我在聊天里给你画一张也行'));
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

  // ==== 看图查看器（双击会话里的图打开）==================================
  const viewerEl = document.getElementById('viewer');
  const viewerImg = document.getElementById('viewerImg');
  const viewerClose = document.getElementById('viewerClose');
  const view = { open: false, scale: 1, tx: 0, ty: 0, drag: null };

  function applyView() {
    if (!viewerImg) return;
    viewerImg.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
  }

  /** 按窗口装得下的大小显示：小图不放大，大图缩进窗口并居中。 */
  function fitViewer() {
    if (!viewerEl || !viewerImg) return;
    const nw = Number(viewerImg.naturalWidth) || 0;
    const nh = Number(viewerImg.naturalHeight) || 0;
    const box = viewerEl.getBoundingClientRect();
    if (!nw || !nh || !box.width || !box.height) return;
    const fit = Math.min(1, (box.width * 0.92) / nw, (box.height * 0.92) / nh);
    view.scale = fit;
    view.tx = (box.width - nw * fit) / 2;
    view.ty = (box.height - nh * fit) / 2;
    applyView();
  }

  function openViewer(src) {
    if (!viewerEl || !viewerImg || !src) return;
    view.open = true;
    // 看图是整窗覆盖层：打开期间别让主进程把窗口设成穿透，否则点不到 × 和背景
    try { void window.orb?.uiHold?.(true); } catch {}
    view.scale = 1;
    view.tx = 0;
    view.ty = 0;
    view.drag = null;
    viewerImg.classList.remove('grabbing');
    viewerImg.onload = () => fitViewer();
    viewerImg.src = src;
    viewerEl.classList.remove('hidden');
    // 已经解码过的图（缓存命中）onload 不会再触发，直接量。
    if (viewerImg.complete && Number(viewerImg.naturalWidth) > 0) fitViewer();
  }

  function closeViewer() {
    if (!view.open || !viewerEl) return;
    view.open = false;
    try { void window.orb?.uiHold?.(false); } catch {}
    view.drag = null;
    viewerEl.classList.add('hidden');
    viewerImg?.classList.remove('grabbing');
  }

  viewerClose?.addEventListener('click', (ev) => { ev.preventDefault(); closeViewer(); });
  viewerEl?.addEventListener('mousedown', (ev) => {
    if (!view.open) return;
    // 点空白背景 = 关闭；点在图上 = 开始拖动
    if (ev.target === viewerEl) { closeViewer(); return; }
    if (ev.button !== 0 || ev.target !== viewerImg) return;
    view.drag = { sx: ev.clientX, sy: ev.clientY, tx: view.tx, ty: view.ty };
    viewerImg.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (ev) => {
    if (!view.open || !view.drag) return;
    view.tx = view.drag.tx + (ev.clientX - view.drag.sx);
    view.ty = view.drag.ty + (ev.clientY - view.drag.sy);
    applyView();
  });
  window.addEventListener('mouseup', () => {
    if (!view.drag) return;
    view.drag = null;
    viewerImg?.classList.remove('grabbing');
  });
  viewerEl?.addEventListener('wheel', (ev) => {
    if (!view.open) return;
    ev.preventDefault();
    const k = Math.exp(-Number(ev.deltaY || 0) * 0.0015);
    const next = Math.max(0.2, Math.min(8, view.scale * k));
    if (!Number.isFinite(next) || next === view.scale) return;
    // 以鼠标位置为锚点缩放：先求指针落在图上的点，缩放后再把它挪回同一屏幕位置
    const box = viewerEl.getBoundingClientRect();
    const px = ev.clientX - box.left;
    const py = ev.clientY - box.top;
    const ax = (px - view.tx) / view.scale;
    const ay = (py - view.ty) / view.scale;
    view.scale = next;
    view.tx = px - ax * next;
    view.ty = py - ay * next;
    applyView();
  }, { passive: false });
  window.addEventListener('resize', () => { if (view.open) fitViewer(); });

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
      try {
        window.orb?.log?.(`[state] seq=${String(seq)} messages=${list.length} expanded=${expanded ? 'y' : 'n'} pet=${petMode ? 'y' : 'n'} seen=${String(Number(next.read?.seenId || 0) || 0)}`);
      } catch {}
      try { maybeBubble(list); } catch {}
    }
    // 面板开着就算读过了：收起后不再为她看过的消息冒气泡。
    if (expanded) markSeen(list);
    // 眼睛/发图的开关状态跟消息无关，每份状态都要刷：设置页改了档位，
    // 球得在几秒内自己变过来，不能等下次来消息。
    try { renderScreenHint(next.screen); } catch {}
    const hasProactive = list.some((m) => m.kind === 'proactive' && Number(m.at) > Date.now() - 60_000);
    badge.classList.toggle('hidden', !(hasProactive && !expanded));
    if (next.chat && next.chat.enabled === false) {
      input.disabled = true;
      btnSend.disabled = true;
      setHint('她现在不在这边聊（设置 → 悬浮窗 → 互动）');
    } else {
      input.disabled = false;
      btnSend.disabled = false;
    }
    // 排队里还有没回的：球上转圈、别自动收起面板。
    const q = next.chat?.queue;
    const waiting = !!(q && (Number(q.pending) > 0 || q.busy === true));
    if (waiting) ball.classList.add('thinking');
    else if (!sending) ball.classList.remove('thinking');
  }

  /** 排队里还有没回完的？ */
  function queueBusy() {
    const q = state?.chat?.queue;
    return !!(q && (Number(q.pending) > 0 || q.busy === true));
  }

  /** 从插件拉一次完整状态：球收起时收不到推送，打开面板先对一次账。 */
  async function refreshState() {
    try {
      const res = await window.orb.http('/state', { timeoutMs: 8000 });
      if (res?.ok && res.data) onState(res.data);
    } catch {}
  }

  // ==== 已读水位：面板里看过 = 读过 = 收起后别再冒气泡 ====================
  // 气泡的发布门**不看**后端 seenId 水位：面板一打开水位就被推到最新，
  // 用它当门会让气泡永远不冒（上一轮真机就是这么坏的，日志里全是 already-seen）。
  // 这里只记「用户刚才在面板里亲手读到哪一刻」，新的、比这一刻晚的消息才冒。
  let lastBubbleId = '';
  // 起手的基线 = 启动这一刻：历史里那些旧消息不该在刚开机时挨个冒一遍，
  // 只有「比这个时刻更晚」的新消息才冒。
  let lastUserReadAt = Date.now();
  let bubbleDeferTimer = null;
  let seenPosted = 0;
  let seenTimer = null;
  function markSeen(list) {
    if (!expanded) return;
    lastUserReadAt = Date.now();
    const items = Array.isArray(list) ? list : [];
    const lastId = Number(items.length ? items[items.length - 1].id : 0) || 0;
    const known = Number(state?.read?.seenId || 0) || 0;
    const upto = Math.max(known, lastId);
    if (!upto || upto <= seenPosted) return;
    seenPosted = upto;
    clearTimeout(seenTimer);
    // 攒一下再发：面板开着时勾选一次就够，别每 3 秒打一次接口。
    seenTimer = setTimeout(async () => {
      try {
        const res = await window.orb.http('/seen', { method: 'POST', body: { id: upto }, timeoutMs: 8000 });
        const nextSeen = Number(res?.data?.seenId || upto) || upto;
        if (state) state = { ...state, read: { ...(state.read || {}), seenId: Math.max(known, nextSeen) } };
      } catch {}
    }, 1200);
  }

  async function show() {
    try { window.SurfPet?.pause?.(); } catch {}
    await closeCtxMenu();
    if (expanded) return;
    expanded = true;
    root.classList.add('expanded');
    badge.classList.add('hidden');
    ball.classList.remove('thinking');
    window.orb?.expand(true);
    // 收起期间消息和开关都在变：先把最新状态拉回来，再贴到底部（不然一打开是旧的）。
    void refreshState();
    markSeen(state?.messages);
    // 面板一打开就把「常规」的大小/连接和「互动」的开关刷成最新的
    try { paintGeneralPage(); } catch {}
    try { syncInteractPage(); } catch {}
    setJump(false, 0);
    requestAnimationFrame(() => { bubbles.scrollTop = bubbles.scrollHeight; });
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
    if (view.open) return; // 正在看图，别把面板收走
    if (pinned && !force) return;
    expanded = false;
    root.classList.remove('expanded');
    window.orb?.expand(false);
    flushDeferredBubble();
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
    if (view.open) return; // 看图时不改窗口大小
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
    if (!text && !pendingFiles.length) return;
    const files = pendingFiles.map((f) => ({
      name: f.name,
      ...(f.path ? { path: f.path } : {}),
      ...(f.dataUrl ? { dataUrl: f.dataUrl } : {}),
      ...(f.text ? { text: f.text } : {}),
    }));
    const hadFiles = files.length > 0;
    const snapshot = pendingFiles.slice();
    // 先把输入框和附件清掉再发：她回多久都不耽误主人接着打字（回复在后台排队逐条来）。
    input.value = '';
    pendingFiles = [];
    renderAttachments();
    btnSend.disabled = true;
    ball.classList.add('thinking');
    setHint('她在想…');
    try {
      const res = await window.orb.http('/chat', { method: 'POST', body: { text, queue: true, files }, timeoutMs: 30000 });
      if (!res.ok) {
        // 没发出去就把话说还给他，别让他白打一遍。
        if (!input.value) input.value = text;
        if (hadFiles && !pendingFiles.length) {
          pendingFiles = snapshot;
          renderAttachments();
        }
        setHint(res.error || '没发出去', true);
        ball.classList.remove('thinking');
      } else {
        const pos = Number(res.data?.position || 0);
        setHint(pos > 1 ? `已排队：前面还有 ${pos - 1} 条` : '');
        if (res.data?.state) onState(res.data.state);
      }
    } catch (error) {
      if (!input.value) input.value = text;
      setHint(String(error?.message ?? error), true);
      ball.classList.remove('thinking');
    } finally {
      btnSend.disabled = false;
    }
  }

  btnSend.addEventListener('click', send);
  btnAttach?.addEventListener('click', async () => {
    const res = await window.orb?.pickFiles?.();
    if (!res?.ok) { if (res?.error) setHint(res.error, true); return; }
    addPicked(res.files);
    if (renderAttachments) renderAttachments();
  });
  // 输入框里直接粘贴图片/文件；纯文字粘贴交给浏览器原生处理。
  input.addEventListener('paste', (ev) => {
    const dt = ev.clipboardData;
    const files = Array.from(dt?.files || []);
    if (!files.length) return;
    ev.preventDefault();
    for (const file of files) addFromFile(file);
  });
  // 拖拽到面板任意位置都能加附件。
  let dragDepth = 0;
  panel.addEventListener('dragenter', (ev) => {
    if (!ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    dragDepth += 1;
    composerEl?.classList.add('dragover');
  });
  panel.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  });
  panel.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) composerEl?.classList.remove('dragover');
  });
  panel.addEventListener('drop', (ev) => {
    if (!ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    dragDepth = 0;
    composerEl?.classList.remove('dragover');
    addFromDataTransfer(ev.dataTransfer);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });
  // 全局 Esc 收起（输入框里和面板任意处都管用）。
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      // 看图时 Esc 只关图，不收起面板（不然一次按两件事）
      if (view.open) { closeViewer(); return; }
      setPinned(false); hide(true);
    }
    touch();
  });

  // 面板上没动静太久就自己缩回球（钉住的不收）。
  setInterval(() => {
    if (!expanded || pinned || sending || queueBusy() || view.open) return;
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
  const ctxCompanionBtn = document.getElementById('ctxCompanion');
  const ctxCompanionPanel = document.getElementById('ctxCompanionPanel');
  const ctxCompToggle = document.getElementById('ctxCompToggle');
  const ctxCompContext = document.getElementById('ctxCompContext');
  const ctxCompOpacity = document.getElementById('ctxCompOpacity');
  const ctxCompOpacityValue = document.getElementById('ctxCompOpacityValue');
  // 试一下气泡 / 皮肤 › / 监测 ›
  const ctxBubbleTestBtn = document.getElementById('ctxBubbleTest');
  const ctxSkinToggle = document.getElementById('ctxSkinToggle');
  const ctxSkinEl = document.getElementById('ctxSkin');
  const ctxSkinList = document.getElementById('ctxSkinList');
  const ctxSkinPath = document.getElementById('ctxSkinPath');
  const ctxSkinImportBtn = document.getElementById('ctxSkinImport');
  const ctxSkinBrowseBtn = document.getElementById('ctxSkinBrowse');
  const ctxSkinDirBtn = document.getElementById('ctxSkinDir');
  const ctxMonitorToggle = document.getElementById('ctxMonitorToggle');
  const ctxMonitorEl = document.getElementById('ctxMonitor');
  const ctxMonWindow = document.getElementById('ctxMonWindow');
  const ctxMonFiles = document.getElementById('ctxMonFiles');
  const ctxMonMedia = document.getElementById('ctxMonMedia');
  const ctxMonGap = document.getElementById('ctxMonGap');
  const ctxMonPeekBtn = document.getElementById('ctxMonPeek');
  const petToastEl = document.getElementById('petToast');
  let ctxSkinShown = false;
  let ctxMonitorShown = false;
  let skinPacks = [];
  let skinActiveId = '';
  let skinBusy = false;
  let activityCfg = null;
  let companionState = null;
  let petMode = false;
  // 本地微调过的大小（右键滑条写的 prefs.petSize），开菜单时要用它回填滑条
  let petPrefs = null;
  // 滑条用 0-100%，再映射到 120~320px。拖动途中不改窗口：窗口一变、菜单就被重新夹位，
  // 滑条会从指针底下溜走，手感就成了「一滑就跳到很远」。所以只跟手更新数字，松手才真改。
  const PET_MIN_SIZE = 120;
  const PET_MAX_SIZE = 320;
  const sizeToPercent = (px) => Math.round(((Number(px) - PET_MIN_SIZE) / (PET_MAX_SIZE - PET_MIN_SIZE)) * 100);
  const percentToSize = (pct) => Math.round(PET_MIN_SIZE + ((PET_MAX_SIZE - PET_MIN_SIZE)
    * Math.max(0, Math.min(100, Number(pct) || 0))) / 100);

  /**
   * 命中判定：窗口 = 宠物(size) + 头顶气泡带 + 左右各 20 的透明边。
   * 用「窗口几何」判断最稳：干掉头顶那条气泡带、左右各 12px 的透明边，剩下就是她的身体区域。
   * （不按 video 的矩形算——video 现在按 pet-size 放大、还会横向超出窗口，整块都算不得。）
   * 气泡带的高度会随气泡内容变（pet.js 的 fitBubble 写主进程），这里跟它同步。
   */
  const petBodyHit = (ev) => {
    if (!petStage || petStage.classList.contains('hidden')) return false;
    const stage = petStage.getBoundingClientRect();
    if (stage.width <= 0 || stage.height <= 0) return false;
    // 动态带高：气泡长高多少，顶上就让出多少；兜底 110（PET_BUBBLE_SPACE）
    const bandRaw = Number(window.SurfPet?.bubbleBand?.()) || Math.min(110, Math.round(stage.height * 0.42));
    const bubbleBand = Math.min(Math.round(stage.height * 0.8), Math.max(0, Math.round(bandRaw)));
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
  // 打开菜单那一刻面板是不是展开的：关闭菜单只能回到这个状态，不能被中途的 click 改掉。
  let ctxWasExpanded = false;

  function placeCtxMenu(ev) {
    if (!ctxMenuEl) return;
    const rootRect = root.getBoundingClientRect();
    const petRect = (petStage || root).getBoundingClientRect();
    const mw = Math.max(184, Math.ceil(ctxMenuEl.scrollWidth) + 4);
    const mh = Math.max(120, Math.ceil(ctxMenuEl.scrollHeight) + 4);
    // 优先贴在宠物右边，放不下就翻到左边；最后按窗口真实宽高夹一次，保证整块可见。
    let left = petRect.right - rootRect.left + 6;
    if (left + mw > rootRect.width - 4) left = petRect.left - rootRect.left - mw - 6;
    left = Math.max(4, Math.min(left, rootRect.width - mw - 4));
    let top = (ev?.clientY ?? petRect.top - rootRect.top) - 8;
    top = Math.max(4, Math.min(top, rootRect.height - mh - 4));
    ctxMenuEl.style.left = `${Math.round(left)}px`;
    ctxMenuEl.style.top = `${Math.round(top)}px`;
  }

  function paintCompanionMenu(state) {
    if (state && typeof state === 'object') companionState = state;
    const active = companionState?.active === true;
    if (ctxCompToggle) {
      ctxCompToggle.textContent = active ? '关闭陪伴' : '开启陪伴';
      ctxCompToggle.classList.toggle('on', active);
    }
    if (ctxCompContext) ctxCompContext.checked = companionState?.contextSubtitles === true;
    const opacity = Math.min(90, Math.max(0, Number(companionState?.opacity ?? 55)));
    if (ctxCompOpacity) ctxCompOpacity.value = String(opacity);
    if (ctxCompOpacityValue) ctxCompOpacityValue.textContent = `${Math.round(opacity)}%`;
  }

  async function refreshCompanionMenu() {
    try {
      const r = await window.orb?.companion?.status?.();
      paintCompanionMenu(r?.companion || r?.status || r);
    } catch {}
  }

  // ==== 桌宠小工具：日志 / toast =========================================
  function plog(text) {
    try { window.orb?.log?.(`[orb] ${text}`); } catch {}
  }

  let toastTimer = 0;
  function toast(text, bad = false) {
    const msg = String(text ?? '').trim();
    if (!msg) return;
    plog(`toast ${msg}`);
    if (!petToastEl) {
      try { showHintBriefly?.(msg); } catch {}
      return;
    }
    petToastEl.textContent = msg;
    petToastEl.classList.toggle('bad', bad === true);
    petToastEl.classList.remove('hidden');
    // 先移除再加，保证连续两次 toast 也能重新播一遍淡入
    petToastEl.classList.remove('show');
    requestAnimationFrame(() => {
      if (!petToastEl.textContent) return;
      petToastEl.classList.add('show');
    });
    clearTimeout(toastTimer);
    const ttl = Math.max(1600, Math.min(6000, msg.length * 110));
    toastTimer = setTimeout(() => {
      petToastEl.classList.remove('show');
      setTimeout(() => {
        if (!petToastEl.classList.contains('show')) petToastEl.classList.add('hidden');
      }, 200);
    }, ttl);
  }

  async function copyText(text) {
    const value = String(text ?? '');
    if (!value) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const done = document.execCommand('copy');
      ta.remove();
      return done === true;
    } catch {
      return false;
    }
  }

  // ==== 皮肤 › ==========================================================
  function packIsFigure(pack) {
    if (!pack || typeof pack !== 'object') return false;
    const kind = pack.kind || pack.packKind;
    return kind === 'figure' || Boolean(pack.figureEntry || pack.entry && pack.entry !== 'webm');
  }

  function renderSkinList() {
    if (!ctxSkinList) return;
    ctxSkinList.textContent = '';
    if (!skinPacks.length) {
      const empty = document.createElement('div');
      empty.className = 'ctxempty';
      empty.textContent = '还没找到皮肤包';
      ctxSkinList.appendChild(empty);
      return;
    }
    for (const pack of skinPacks) {
      const id = String(pack?.id ?? '');
      if (!id) continue;
      const active = id === skinActiveId;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `ctxitem child${active ? ' on' : ''}`;
      btn.dataset.pack = id;
      const mark = document.createElement('span');
      mark.className = 'ctxmark';
      mark.textContent = active ? '✓' : '';
      const name = document.createElement('span');
      name.className = 'ctxname';
      name.textContent = String(pack?.name || id);
      const meta = document.createElement('span');
      meta.className = 'ctxmeta';
      const count = Number(pack?.webmCount) || 0;
      if (packIsFigure(pack)) meta.textContent = '网页';
      else if (count > 0) meta.textContent = `${count} 段`;
      btn.append(mark, name, meta);
      btn.addEventListener('click', () => { void activateSkin(id); });
      ctxSkinList.appendChild(btn);
    }
    paintPanelSkins();
  }

  // 面板「桌宠 → 皮肤」里同一份数据：整行可点，当前那套打勾。
  function paintPanelSkins() {
    const box = document.getElementById('psSkinList');
    if (!box) return;
    box.textContent = '';
    if (!skinPacks.length) {
      const empty = document.createElement('p');
      empty.className = 'phint';
      empty.textContent = '还没找到皮肤包';
      box.appendChild(empty);
      return;
    }
    for (const pack of skinPacks) {
      const id = String(pack?.id ?? '');
      if (!id) continue;
      const active = id === skinActiveId;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `pskin-row${active ? ' on' : ''}`;
      row.dataset.pack = id;
      const mk = document.createElement('span');
      mk.className = 'pmk';
      mk.textContent = active ? '✓' : '';
      const nm = document.createElement('span');
      nm.className = 'pnm';
      nm.textContent = String(pack?.name || id);
      const mt = document.createElement('span');
      mt.className = 'pmt';
      const count = Number(pack?.webmCount) || 0;
      if (packIsFigure(pack)) mt.textContent = '网页';
      else if (count > 0) mt.textContent = `${count} 段`;
      else if (pack?.builtin) mt.textContent = '内置';
      row.append(mk, nm, mt);
      row.addEventListener('click', () => { void activateSkin(id); });
      box.appendChild(row);
    }
  }

  async function skinAction(body) {
    const res = await window.orb.http('/pet-packs', { method: 'POST', body });
    const data = res?.data ?? res ?? {};
    if (res?.ok === false || data?.ok === false) {
      throw new Error(String(data?.error || res?.error || '皮肤包操作失败'));
    }
    return data;
  }

  async function loadSkins() {
    if (skinBusy) return;
    skinBusy = true;
    try {
      const data = await skinAction({ action: 'list' });
      skinPacks = Array.isArray(data?.packs) ? data.packs : [];
      skinActiveId = String(data?.activePackId ?? data?.activeId ?? '');
      renderSkinList();
      plog(`skins ${skinPacks.length} active=${skinActiveId}`);
    } catch (error) {
      plog(`skins list 失败：${String(error?.message || error)}`);
      if (ctxSkinList) {
        ctxSkinList.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'ctxempty';
        empty.textContent = `列表拿不到：${String(error?.message || error).slice(0, 40)}`;
        ctxSkinList.appendChild(empty);
      }
    } finally {
      skinBusy = false;
    }
  }

  async function activateSkin(id) {
    if (!id) return;
    if (id === skinActiveId) {
      toast('已经在用这个皮肤了');
      return;
    }
    try {
      await skinAction({ action: 'activate', id });
      skinActiveId = id;
      const pack = skinPacks.find((p) => String(p?.id) === id);
      renderSkinList();
      toast(`换成「${String(pack?.name || id)}」了`);
      // 不重载页面：pet.js 每 4s 热重载配置，这里再戳一下让它立刻去读
      try { window.SurfPet?.refresh?.(); } catch {}
      // 只有菜单真的开着才去重排菜单；从面板里换皮肤时别去动窗口
      if (ctxOpenState) {
        await fitCtxWindow();
        placeCtxMenu(null);
      }
    } catch (error) {
      toast(String(error?.message || error).slice(0, 90), true);
    }
  }

  async function importSkin(rawPath) {
    const path = String(rawPath ?? '').trim().replace(/^["']+|["']+$/g, '');
    if (!path) {
      toast('先填皮肤包路径（文件夹或 .tgz）');
      return;
    }
    toast('正在导入皮肤包…');
    try {
      const data = await skinAction({ action: 'import', path });
      toast(`导入好了：${String(data?.name || data?.id || '皮肤包')}`);
      if (ctxSkinPath) ctxSkinPath.value = '';
      const panelPath = document.getElementById('psSkinPath');
      if (panelPath) panelPath.value = '';
      await loadSkins();
      if (ctxOpenState) {
        await fitCtxWindow();
        placeCtxMenu(null);
      }
    } catch (error) {
      toast(String(error?.message || error).slice(0, 100), true);
    }
  }

  async function browseSkinTgz() {
    try {
      const res = await window.orb?.pickFiles?.();
      const file = res?.files?.[0];
      if (!file?.path) return;
      await importSkin(file.path);
    } catch (error) {
      toast(String(error?.message || error).slice(0, 90), true);
    }
  }

  /** 「导入皮肤文件夹…」：系统目录选择器优先，拿不到就退回路径输入框。 */
  async function browseSkinDir() {
    try {
      const res = await window.orb?.pickFiles?.({ directory: true });
      const dir = res?.files?.[0]?.path;
      if (dir) {
        await importSkin(dir);
        return;
      }
      if (res && res.ok === false) toast(String(res.error || '选不了目录').slice(0, 90), true);
    } catch (error) {
      toast(String(error?.message || error).slice(0, 90), true);
    }
  }

  async function copySkinDir() {
    const pack = skinPacks.find((p) => String(p?.id) === skinActiveId) || skinPacks[0];
    const dir = String(pack?.dir ?? '');
    if (!dir) {
      toast('拿不到皮肤包目录');
      return;
    }
    // 优先真的在资源管理器里打开；老版本 preload 没有 openPath 时退回复制路径。
    try {
      const opened = await window.orb?.openPath?.(dir);
      if (opened?.ok) return;
    } catch {}
    const done = await copyText(dir);
    if (done) toast('皮肤包目录已复制，粘到资源管理器就能打开');
    else toast(`皮肤包目录：${dir}`, true);
  }

  async function toggleSkinMenu() {
    ctxSkinShown = !ctxSkinShown;
    ctxSkinEl?.classList.toggle('hidden', !ctxSkinShown);
    ctxSkinToggle?.setAttribute('aria-expanded', ctxSkinShown ? 'true' : 'false');
    if (ctxSkinShown) await loadSkins();
    await fitCtxWindow();
    placeCtxMenu(null);
  }

  // ==== 监测 › ==========================================================
  // 配置形状跟 lib/orb-activity.js 的 normalizeActivityConfig 对齐：
  //   { enabled, pollMs, kinds:{ window, file, music }, bubbleEveryMs }
  // 主进程那边还没落地时全部走可选链，读不到就按默认值画（三个都开、10 分钟一句）。

  function actKinds(cfg) {
    const kinds = cfg && typeof cfg === 'object' && cfg.kinds && typeof cfg.kinds === 'object' ? cfg.kinds : null;
    if (kinds) {
      return {
        window: kinds.window !== false,
        file: kinds.file !== false,
        music: kinds.music !== false,
      };
    }
    return { window: true, file: true, music: true };
  }

  function actGapMin(cfg) {
    const ms = Number(cfg?.bubbleEveryMs);
    const min = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60000) : 10;
    if ([5, 10, 30].includes(min)) return min;
    return min <= 7 ? 5 : (min <= 20 ? 10 : 30);
  }

  /** 在旧配置上盖一层改动；三个开关全关时顺手把总开关也关掉。 */
  function patchActivity(cfg, patch = {}) {
    const base = cfg && typeof cfg === 'object' ? cfg : {};
    const kinds = {
      ...(base.kinds && typeof base.kinds === 'object' ? base.kinds : { window: true, file: true, music: true }),
      ...(patch.kinds || {}),
    };
    const next = { ...base, kinds };
    if (patch.minutes) next.bubbleEveryMs = Math.round(Number(patch.minutes) * 60000);
    next.enabled = kinds.window !== false || kinds.file !== false || kinds.music !== false;
    return next;
  }

  let lastSample = null;

  function subscribeActivity() {
    const on = window.orb?.onActivity;
    if (typeof on !== 'function') {
      plog('activity 推送还没接上（主进程缺 onActivity）');
      return false;
    }
    try {
      on((payload) => {
        if (!payload || typeof payload !== 'object') return;
        lastSample = payload;
        plog(`[monitor] push ${JSON.stringify(payload).slice(0, 160)}`);
      });
      return true;
    } catch (error) {
      plog(`activity 订阅失败：${String(error?.message || error)}`);
      return false;
    }
  }

  function paintMonitorMenu() {
    const kinds = actKinds(activityCfg);
    if (ctxMonWindow) ctxMonWindow.checked = kinds.window;
    if (ctxMonFiles) ctxMonFiles.checked = kinds.file;
    if (ctxMonMedia) ctxMonMedia.checked = kinds.music;
    if (ctxMonGap) {
      const want = String(actGapMin(activityCfg));
      if (want !== ctxMonGap.value) ctxMonGap.value = want;
    }
  }

  function activityApi() {
    const api = window.orb?.activityConfig;
    return typeof api === 'function' ? api : null;
  }

  function cfgOf(res) {
    const cfg = res?.config ?? res?.data?.config ?? res?.data ?? res;
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : null;
  }

  async function loadActivity() {
    const api = activityApi();
    if (!api) {
      paintMonitorMenu();
      plog('监测还没接上（主进程缺 activityConfig）');
      return false;
    }
    try {
      const cfg = cfgOf(await api({ action: 'get' }));
      if (cfg) activityCfg = cfg;
      paintMonitorMenu();
      syncInteractPage();
      plog(`监测配置 ${JSON.stringify(activityCfg || {}).slice(0, 160)}`);
      return true;
    } catch (error) {
      plog(`监测 get 失败：${String(error?.message || error)}`);
      return false;
    }
  }

  async function saveActivity(patchFn) {
    const api = activityApi();
    if (!api) {
      toast('监测还没接上，等主进程补上 activityConfig');
      return false;
    }
    let next;
    try {
      next = patchFn(activityCfg || {});
    } catch {
      return false;
    }
    try {
      const res = await api({ action: 'set', config: next });
      activityCfg = cfgOf(res) || next;
      paintMonitorMenu();
      syncInteractPage();
      plog(`监测改好了 ${JSON.stringify(activityCfg).slice(0, 160)}`);
      return true;
    } catch (error) {
      toast(String(error?.message || error).slice(0, 90), true);
      return false;
    }
  }

  /** 现在看一眼：GET 一次拿「上一次采样」，再等推送把更新的那份送过来。 */
  async function peekActivity() {
    const api = activityApi();
    const beforeAt = Number(lastSample?.at) || 0;
    let info = null;
    if (api) {
      try { info = await api({ action: 'get' }); } catch {}
    }
    const cfg = cfgOf(info);
    if (cfg) { activityCfg = cfg; paintMonitorMenu(); }
    const status = info?.status && typeof info.status === 'object' ? info.status : null;
    if (status && status.enabled === false) {
      toast('监测还关着，先把上面任意一个开关打开');
      return;
    }
    const fallback = info?.last || info?.sample || info?.current || info?.activity || null;
    // 主进程每 5 秒读一次 activity.json，等它把新的推下来（最多 2.5s）。
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (lastSample && (Number(lastSample.at) || 0) > beforeAt) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const fresh = lastSample && (Number(lastSample.at) || 0) > beforeAt ? lastSample : null;
    const sample = fresh || lastSample || (fallback && typeof fallback === 'object' ? fallback : null);
    if (!sample) {
      toast(api ? '她这会儿没抓到窗口' : '监测还没接上，等主进程补上 activityConfig');
      return;
    }
    const bits = [];
    if (sample.active) bits.push(String(sample.active.app || sample.active.title || sample.active.project || '在忙'));
    else bits.push('没看到窗口');
    if (sample.media && (sample.media.title || sample.media.app)) {
      const t = [sample.media.title, sample.media.artist].filter(Boolean).join(' - ');
      bits.push(`在听 ${t || sample.media.app}`);
    }
    toast(`她看到：${bits.filter(Boolean).join(' · ').slice(0, 80)}`);
  }

  async function toggleMonitorMenu() {
    ctxMonitorShown = !ctxMonitorShown;
    ctxMonitorEl?.classList.toggle('hidden', !ctxMonitorShown);
    ctxMonitorToggle?.setAttribute('aria-expanded', ctxMonitorShown ? 'true' : 'false');
    if (ctxMonitorShown) await loadActivity();
    else paintMonitorMenu();
    await fitCtxWindow();
    placeCtxMenu(null);
  }

  // ==== 试一下气泡 =====================================================
  const BUBBLE_TEST_LINES = [
    '在的，我就在这儿。',
    '刚才那句话还没说完呢…',
    '你忙你的，我自己待一会儿就好。',
    '抬头看我一眼吧。',
    '今天也辛苦啦。',
  ];

  async function bubbleTestSay() {
    const text = BUBBLE_TEST_LINES[Math.floor(Math.random() * BUBBLE_TEST_LINES.length)];
    try {
      const res = await window.orb.http('/say', { method: 'POST', body: { text, kind: 'proactive' } });
      const data = res?.data ?? res ?? {};
      if (res?.ok === false || data?.ok === false) {
        toast(String(data?.error || res?.error || '没发出去'), true);
        return;
      }
      plog(`试一下气泡 ok：${text}`);
    } catch (error) {
      toast(`没发出去：${String(error?.message || error).slice(0, 70)}`, true);
    }
  }

  async function fitCtxWindow() {
    try {
      // 等一帧让刚展开的滑条/换行先完成布局，否则量到的是旧高度。
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = ctxMenuEl?.getBoundingClientRect();
      if (!rect) return null;
      const need = {
        width: Math.ceil(Math.max(rect.width, ctxMenuEl.scrollWidth, 190)) + 16,
        height: Math.ceil(Math.max(rect.height, ctxMenuEl.scrollHeight, 120)) + 16,
      };
      const box = window.orb?.menurect ? await window.orb.menurect(need) : null;
      if (box) {
        root.style.setProperty('--pet-dx', `${Number(box.dx) || 0}px`);
        root.style.setProperty('--pet-dy', `${Number(box.dy) || 0}px`);
      }
      return box;
    } catch {
      return null;
    }
  }

  async function openCtxMenu(ev) {
    try { window.orb?.log?.('[menu] open'); } catch {}
    ctxWasExpanded = expanded === true;
    ctxOpenState = true;
    paintCompanionMenu(null);
    void refreshCompanionMenu();
    // 菜单是 HTML 覆盖层，可能画在宠物矩形之外：打开期间整窗保持可点
    try { void window.orb?.uiHold?.(true); } catch {}
    ctxSizeShown = false;
    ctxSizeEl?.classList.add('hidden');
    ctxSkinShown = false;
    ctxMonitorShown = false;
    ctxSkinEl?.classList.add('hidden');
    ctxMonitorEl?.classList.add('hidden');
    ctxSkinToggle?.setAttribute('aria-expanded', 'false');
    ctxMonitorToggle?.setAttribute('aria-expanded', 'false');
    // 子菜单先用上次读到的配置画一遍，展开时再向后端要最新值。
    renderSkinList();
    paintMonitorMenu();
    ctxMenuEl?.classList.remove('hidden');
    root.classList.add('ctxopen');
    // 先在窗口左上角量真实尺寸，等窗口长大/夹回屏幕后，再按新窗口摆菜单。
    ctxMenuEl.style.left = '0px';
    ctxMenuEl.style.top = '0px';
    await fitCtxWindow();
    if (!ctxOpenState) return;
    placeCtxMenu(ev);
    const size = Number(petPrefs?.petSize) || Number(window.__petCfg?.size) || 200;
    const pct = sizeToPercent(size);
    if (ctxSizeRange) ctxSizeRange.value = String(pct);
    if (ctxSizeValue) ctxSizeValue.textContent = `${pct}%`;
  }

  async function closeCtxMenu() {
    try { window.orb?.log?.('[menu] close'); } catch {}
    if (!ctxOpenState) return;
    ctxOpenState = false;
    try { void window.orb?.uiHold?.(false); } catch {}
    ctxSizeShown = false;
    ctxSkinShown = false;
    ctxMonitorShown = false;
    ctxMenuEl?.classList.add('hidden');
    ctxSizeEl?.classList.add('hidden');
    ctxSkinEl?.classList.add('hidden');
    ctxMonitorEl?.classList.add('hidden');
    root.classList.remove('ctxopen');
    // 只关菜单：原来展开就恢复展开，原来收起才回球。
    try {
      const box = window.orb?.menurect
        ? await window.orb.menurect({ width: 0, height: 0, restore: ctxWasExpanded ? 'expanded' : 'collapsed' })
        : null;
      root.style.setProperty('--pet-dx', '0px');
      root.style.setProperty('--pet-dy', '0px');
      return box;
    } catch {
      return null;
    }
  }

  ctxOpenBtn?.addEventListener('click', () => { void show(); });
  ctxActionBtn?.addEventListener('click', async () => { await closeCtxMenu(); window.SurfPet?.shuffle(); });
  // 「走一走」是唯一能主动搬窗口的入口（鼠标划过她的身体只 react，不动位置）
  document.getElementById('ctxWalk')?.addEventListener('click', async () => {
    await closeCtxMenu();
    try { window.SurfPet?.wander?.(); } catch {}
  });
  ctxHideBtn?.addEventListener('click', async () => { await closeCtxMenu(); window.orb?.hide?.(); });
  ctxSizeToggle?.addEventListener('click', async () => {
    try { window.orb?.log?.('[menu] size toggle ' + String(ctxSizeShown)); } catch {}
    ctxSizeShown = !ctxSizeShown;
    ctxSizeEl?.classList.toggle('hidden', !ctxSizeShown);
    // 滑条展开/收起后菜单高度变了：重新量尺寸、扩窗，再摆位置。
    await fitCtxWindow();
    placeCtxMenu(null);
  });
  ctxSizeRange?.addEventListener('input', () => {
    // 拖动时只更新数字；窗口尺寸等松手（change）再改，避免滑条被重新夹位甩飞
    const pct = Number(ctxSizeRange.value) || 0;
    if (ctxSizeValue) ctxSizeValue.textContent = `${Math.round(pct)}%`;
  });
  ctxSizeRange?.addEventListener('change', async () => {
    const pct = Number(ctxSizeRange.value) || 0;
    const size = percentToSize(pct);
    if (ctxSizeValue) ctxSizeValue.textContent = `${Math.round(pct)}%`;
    try { window.SurfPet?.setSize?.(size); } catch {}
    try { await window.orb?.petSize?.(size); } catch {}
    // 宠物变大/变小会改变底窗尺寸，菜单要重新按新窗口夹位。
    await fitCtxWindow();
    placeCtxMenu(null);
  });

  ctxBubbleTestBtn?.addEventListener('click', async () => {
    await closeCtxMenu();
    await bubbleTestSay();
  });

  ctxSkinToggle?.addEventListener('click', () => { void toggleSkinMenu(); });
  ctxMonitorToggle?.addEventListener('click', () => { void toggleMonitorMenu(); });
  ctxSkinImportBtn?.addEventListener('click', () => {
    // 输入框里有路径就按它导入；空的就弹系统目录选择器（这样「导入皮肤文件夹」不用手打路径）。
    const typed = String(ctxSkinPath?.value || '').trim();
    if (typed) void importSkin(typed);
    else void browseSkinDir();
  });
  ctxSkinPath?.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    void importSkin(ctxSkinPath.value);
  });
  ctxSkinBrowseBtn?.addEventListener('click', () => { void browseSkinTgz(); });
  ctxSkinDirBtn?.addEventListener('click', () => { void copySkinDir(); });

  ctxMonWindow?.addEventListener('change', () => {
    const on = ctxMonWindow.checked === true;
    void saveActivity((cfg) => patchActivity(cfg, { kinds: { window: on } }));
  });
  ctxMonFiles?.addEventListener('change', () => {
    const on = ctxMonFiles.checked === true;
    void saveActivity((cfg) => patchActivity(cfg, { kinds: { file: on } }));
  });
  ctxMonMedia?.addEventListener('change', () => {
    const on = ctxMonMedia.checked === true;
    void saveActivity((cfg) => patchActivity(cfg, { kinds: { music: on } }));
  });
  ctxMonGap?.addEventListener('change', () => {
    const minutes = Number(ctxMonGap.value) || 10;
    void saveActivity((cfg) => patchActivity(cfg, { minutes }));
  });
  ctxMonPeekBtn?.addEventListener('click', () => { void peekActivity(); });

  ctxCompToggle?.addEventListener('click', async () => {
    const active = companionState?.active === true;
    ctxCompToggle.disabled = true;
    try {
      const r = await window.orb?.companion?.toggle?.(active);
      paintCompanionMenu(r?.data?.companion || r?.data?.status || r?.companion || r?.status || r);
      if (r?.ok === false || r?.data?.ok === false) ctxCompToggle.textContent = String(r?.error || r?.data?.error || '开启失败').slice(0, 24);
    } catch (error) {
      ctxCompToggle.textContent = String(error?.message || error).slice(0, 24);
    } finally {
      ctxCompToggle.disabled = false;
      placeCtxMenu(null);
    }
  });

  ctxCompContext?.addEventListener('change', async () => {
    const checked = ctxCompContext.checked === true;
    try {
      const r = await window.orb?.companion?.config?.({ contextSubtitles: checked });
      paintCompanionMenu(r?.companion || r?.config || r);
    } catch {}
  });

  let opacityTimer = 0;
  ctxCompOpacity?.addEventListener('input', () => {
    const value = Math.min(90, Math.max(0, Number(ctxCompOpacity.value) || 0));
    if (ctxCompOpacityValue) ctxCompOpacityValue.textContent = `${value}%`;
    clearTimeout(opacityTimer);
    opacityTimer = setTimeout(() => {
      void window.orb?.companion?.config?.({ opacity: value });
    }, 120);
  });
  // 点菜单外面 / Esc / 开始拖动，都把菜单收起来
  window.addEventListener('mousedown', (ev) => {
    if (!ctxOpenState) return;
    if (ctxMenuEl && ctxMenuEl.contains(ev.target)) return;
    closeCtxMenu();
  }, true);
  // 点到桌面/别的窗口时 orb 会失焦，也把菜单收掉；只收菜单，不改变面板展开状态。
  window.addEventListener('blur', () => { if (ctxOpenState) closeCtxMenu(); });
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && ctxOpenState) closeCtxMenu(); });

  // ==== 面板：左侧七个域 + 右侧页面 =====================================
  const pageNav = document.getElementById('panelNav');
  const pageNavBtns = [...document.querySelectorAll('#panelNav .pnav')];
  const pagePanes = [...document.querySelectorAll('#panelMain .ppage')];

  function showPage(name) {
    const want = String(name || 'chat');
    for (const btn of pageNavBtns) {
      const on = btn.dataset.page === want;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const pane of pagePanes) pane.classList.toggle('on', pane.dataset.page === want);
    // 每个页面进来时刷一遍，别让用户对着空壳
    if (want === 'pet') void loadSkins();
    if (want === 'interact') { void loadActivity(); syncInteractPage(); }
    if (want === 'general') paintGeneralPage();
    if (want === 'chat') {
      requestAnimationFrame(() => { bubbles.scrollTop = bubbles.scrollHeight; });
      try { input.focus(); } catch {}
    }
    try { window.orb?.log?.(`[panel] page=${want}`); } catch {}
  }
  pageNav?.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('.pnav');
    if (!btn) return;
    showPage(btn.dataset.page);
  });
  document.getElementById('autoGoInteract')?.addEventListener('click', () => showPage('interact'));

  function paintGeneralPage() {
    const conn = document.getElementById('genConn');
    if (conn) {
      const cls = String(connDot?.className || '');
      conn.textContent = cls.includes('ok') ? '已连上' : cls.includes('bad') ? '连不上' : '检查中…';
    }
    const role = document.getElementById('genRole');
    if (role) role.textContent = String(roleName?.textContent || '她');
    const mode = document.getElementById('genMode');
    if (mode) mode.textContent = petMode ? (state?.config?.pet?.mode === 'pet' ? '桌宠' : '悬浮小球') : '未知';
    const size = Number(window.SurfPet?.size || state?.config?.pet?.size || 200) || 200;
    const pct = sizeToPercent(size);
    const range = document.getElementById('genSize');
    if (range && document.activeElement !== range) range.value = String(pct);
    const val = document.getElementById('genSizeValue');
    if (val) val.textContent = `${Math.round(size)}px`;
  }

  const genSize = document.getElementById('genSize');
  genSize?.addEventListener('input', () => {
    const val = document.getElementById('genSizeValue');
    if (val) val.textContent = `${Math.round(percentToSize(Number(genSize.value) || 0))}px`;
  });
  genSize?.addEventListener('change', async () => {
    // 和右键菜单里的滑条走同一条路：拖动时只改数字，松手才真的改窗口
    const size = percentToSize(Number(genSize.value) || 0);
    const val = document.getElementById('genSizeValue');
    if (val) val.textContent = `${Math.round(size)}px`;
    try { window.SurfPet?.setSize?.(size); } catch {}
    try { await window.orb?.petSize?.(size); } catch {}
  });

  const doShuffle = () => { try { window.SurfPet?.shuffle?.(); } catch {} };
  const doWalk = () => { try { window.SurfPet?.wander?.(); } catch {} };
  document.getElementById('genAction')?.addEventListener('click', doShuffle);
  document.getElementById('petAction')?.addEventListener('click', doShuffle);
  document.getElementById('genWalk')?.addEventListener('click', doWalk);
  document.getElementById('petWalk')?.addEventListener('click', doWalk);
  document.getElementById('genBubble')?.addEventListener('click', () => { void bubbleTestSay(); });
  document.getElementById('menuBubbleTest')?.addEventListener('click', () => { void bubbleTestSay(); });
  document.getElementById('menuCopyDir')?.addEventListener('click', () => { void copySkinDir(); });
  document.getElementById('genHide')?.addEventListener('click', () => { setPinned(false); hide(true); });
  document.getElementById('actPeek')?.addEventListener('click', () => { void peekActivity(); });

  // 桌宠页的皮肤列表：数据来自 loadSkins()，整行点击切换
  document.getElementById('psSkinImport')?.addEventListener('click', () => {
    const el = document.getElementById('psSkinPath');
    const typed = String(el?.value || '').trim();
    if (typed) void importSkin(typed);
    else void browseSkinDir();
  });
  document.getElementById('psSkinPath')?.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    void importSkin(ev.target.value);
  });
  document.getElementById('psSkinBrowse')?.addEventListener('click', () => { void browseSkinTgz(); });
  document.getElementById('psSkinDir')?.addEventListener('click', () => { void copySkinDir(); });

  // 互动页的监测开关：和右键菜单共用 activityCfg / saveActivity，不分叉
  function syncInteractPage() {
    const kinds = actKinds(activityCfg);
    const w = document.getElementById('actWindow');
    const f = document.getElementById('actFiles');
    const m = document.getElementById('actMedia');
    if (w) w.checked = kinds.window !== false;
    if (f) f.checked = kinds.file !== false;
    if (m) m.checked = kinds.music !== false;
    const gap = document.getElementById('actGap');
    if (gap) gap.value = String(actGapMin(activityCfg));
    const comp = document.getElementById('actCompanion');
    if (comp) comp.textContent = companionState?.active === true ? '关闭陪伴' : '开启陪伴';
    const ctxBox = document.getElementById('actCompanionCtx');
    if (ctxBox) ctxBox.checked = companionState?.contextSubtitles === true;
  }
  for (const [elId, key] of [['actWindow', 'window'], ['actFiles', 'file'], ['actMedia', 'music']]) {
    document.getElementById(elId)?.addEventListener('change', (ev) => {
      const on = ev.target.checked === true;
      void saveActivity((cfg) => patchActivity(cfg, { kinds: { [key]: on } }));
    });
  }
  document.getElementById('actGap')?.addEventListener('change', (ev) => {
    const minutes = Number(ev.target.value) || 10;
    void saveActivity((cfg) => patchActivity(cfg, { minutes }));
  });
  document.getElementById('actCompanion')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const active = companionState?.active === true;
    btn.disabled = true;
    try {
      const r = await window.orb?.companion?.toggle?.(active);
      paintCompanionMenu(r?.data?.companion || r?.data?.status || r?.companion || r?.status || r);
      syncInteractPage();
      toast(companionState?.active === true ? '陪伴开着了' : '陪伴关掉了');
    } catch (error) {
      toast(String(error?.message || error).slice(0, 60), true);
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('actCompanionCtx')?.addEventListener('change', async (ev) => {
    const checked = ev.target.checked === true;
    try {
      const r = await window.orb?.companion?.config?.({ contextSubtitles: checked });
      paintCompanionMenu(r?.companion || r?.config || r);
    } catch {}
  });

  // 点菜单外面 / Esc / 开始拖动，都把菜单收起来
// 面板收起时，她最新一句（含主动）在头顶冒气泡；点气泡开会话。
  // 发布门只有两个：①比上次冒过的 id 新；②不是用户刚在面板里亲手读过的那条。
  // 绝不拿后端 seenId 水位当门 —— 面板一展开水位就顶到最新，那样气泡永远是 0 次。
  function bubbleSkip(reason) {
    try { window.orb?.log?.(`[bubble] skip reason=${reason}`); } catch {}
  }
  function newestHer(list) {
    const items = Array.isArray(list) ? list : [];
    return [...items].reverse().find((m) => m && (m.text || m.image) && (m.who === 'her' || m.who === undefined)) || null;
  }
  function bubbleFor(list, why) {
    const last = newestHer(list);
    if (!last) { bubbleSkip('no-her-message'); return false; }
    if (!last.id) { bubbleSkip('no-id'); return false; }
    const id = String(last.id);
    if (id === lastBubbleId) { bubbleSkip(`same-id id=${id}`); return false; }
    // 用户刚在面板里亲手读完这条（时间戳不晚于最后一次已读）：收起后别再补弹一次。
    const at = Number(last.at) || 0;
    if (lastUserReadAt && at && at <= lastUserReadAt) {
      bubbleSkip(`read-just-now id=${id} at=${at} read=${lastUserReadAt}`);
      return false;
    }
    lastBubbleId = id;
    const ttl = Number(state?.config?.chat?.bubbleTtlSec || 8) * 1000;
    // 图文一体时头顶气泡也带图；关掉就只冒字（图在面板里看）。
    const withPic = !!last.image && state?.config?.chat?.richBubble !== false;
    // 场景 kind 直接透传（chat/notice/event/news/error 由插件侧标），其余仍按 her/proactive 走
    const sceneKind = ['chat', 'notice', 'event', 'news', 'error', 'me'].includes(String(last.kind));
    const kind = sceneKind ? String(last.kind) : (last.kind === 'proactive' ? 'proactive' : 'her');
    let shown = false;
    try {
      shown = window.SurfPet?.showBubble(String(last.text || ''), {
        kind,
        ttlMs: ttl,
        image: withPic ? last.image : '',
        onClick: () => show(),
      }) !== false;
    } catch (error) {
      try { window.orb?.log?.(`[bubble] show 抛错：${String(error?.message || error)}`); } catch {}
    }
    try {
      window.orb?.log?.(`[bubble] show id=${id} kind=${kind} pic=${withPic ? 'y' : 'n'} shown=${shown ? 'y' : 'n'} ttl=${ttl} why=${why}`);
    } catch {}
    return shown;
  }
  // 面板展开时收到新消息不要丢：600ms 后她要是已经收起来了就冒；还开着就等收起那一刻补。
  function queueDeferredBubble(list) {
    void list;
    if (bubbleDeferTimer) clearTimeout(bubbleDeferTimer);
    bubbleDeferTimer = setTimeout(() => {
      bubbleDeferTimer = null;
      if (!petMode || expanded) return;
      bubbleFor(state?.messages, 'deferred');
    }, 600);
  }
  function flushDeferredBubble() {
    if (bubbleDeferTimer) {
      clearTimeout(bubbleDeferTimer);
      bubbleDeferTimer = null;
    }
    if (!petMode) return;
    bubbleFor(state?.messages, 'collapse');
  }
  function maybeBubble(list) {
    if (!petMode) { bubbleSkip('not-pet-mode'); return; }
    if (expanded) { bubbleSkip('panel-expanded-defer'); queueDeferredBubble(list); return; }
    bubbleFor(list, 'state');
  }

  // 监测推送：主进程补齐 onActivity 后，这里会一直缓存最近一次采样，
  // 菜单里的「现在看一眼」直接读它，不用每回都问一遍。
  subscribeActivity();

  window.orb.onState(onState);
  window.orb.onHidden?.(() => {
    closeCtxMenu();
    closeViewer?.();
    expanded = false;
    root.classList.remove('expanded');
    window.orb?.log?.('[hide] 已隐藏到托盘');
  });
  window.orb.onShown?.(() => {
    closeCtxMenu();
    void refreshState();
    setHint('');
  });
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
