// SurfCore 悬浮窗（Orb）宿主
//
// 这是一个**独立的 Electron 进程**，由插件（lib/orb.js）spawn 起来。它只做三件事：
//   1. 在桌面放一只桌宠（无边框、透明、始终置顶、不进任务栏；0.12.21 起没有悬浮小球了）；
//   2. 悬停展开成对话面板，把 `state.json` 里的消息画出来、把用户输入交给插件；
//   3. 跟插件（/dsh-surfcore/orb-api）通信，DSH 退出或端口漂移时自己收拾干净。
//
// 为什么不直接 fetch 插件的 HTTP：页面是 file:// 起的，跨源会被 CORS 拦；
// 而且令牌要留在主进程里，渲染进程只拿数据。所有 HTTP 都走主进程。
// 注意：这个文件是 **CommonJS**（package.json 没有 "type": "module"）。
// 曾用 import 写过，Electron 会把它当 ES module 重新解析，于是 __dirname 未定义，
// 窗口创建直接抛 ReferenceError、球根本不出现（2026-10-31 踩过）。别改回 import。
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, globalShortcut, nativeImage, dialog, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COLLAPSED = 72;
const MIN_BALL = 44;
// 桌宠大小：右键滑条改的是这一档，和插件里的 ball.petSize 各管一边（本地微调优先）
const PET_MIN = 120;
const PET_MAX = 320;
const MAX_BALL = 96;
const PET_BUBBLE_SPACE = 110; // 桌宠头顶留给气泡的高度
const PET_SIDE_SPACE = 40;    // 桌宠左右留白（甩动/反馈动画会往外一点）
const EXPANDED = { width: 380, height: 540 };
const STATE_POLL_MS = 3000;
const MAX_STATE_FAILURES = 6;
const ANIM_MS = 170;

const ORB_DIR = process.env.SURFCORE_ORB_DIR || path.join(os.homedir(), '.dsh', 'surfcore', 'orb');
const HOST_FILE = path.join(ORB_DIR, 'host.json');
const LOG_FILE = path.join(ORB_DIR, 'orb-app.log');
const PREFS_FILE = path.join(ORB_DIR, 'prefs.json');

let win = null;
let expanded = false;
let failures = 0;
let pollTimer = null;
let animTimer = null;
// 动画进行中不许记「球的尺寸」，否则会把中途的窗口尺寸当成球大小写进 prefs。
let animating = false;
// 动画期间被挡下的最后一次展开/收起请求（长按连点会让它们互相打架）
let pendingExpand = null;
let hostCache = { at: 0, data: null };
// 收起状态下球的位置/大小。展开再收起必须回到这里，不然球会「跑位」。
let ballRect = null;
let prefs = { ballSize: COLLAPSED, x: null, y: null, panelWidth: EXPANDED.width, panelHeight: EXPANDED.height, companion: null };
// 头顶给气泡留多高：随气泡内容放大（0 = 用默认值），收起时复位。
// 窗口向上长，她脚底不动，所以长高不会把她挪位置。
let bubbleBand = 0;
// 气泡申请的额外宽度（0 = 只给宠物本身那么宽）。见 bubbleWidthFor()。
let bubbleWidth = 0;
// 气泡长到头顶放不下时（她贴在屏幕最上面），整个窗口往下让一截，换气泡完整可见。
// 这两个量记住「让之前她贴在哪条底线上、让了多少」，气泡收起时原样还回去。
let bubbleOriginBottom = 0;
let bubbleShiftApplied = 0;

/** 当前窗口所在屏幕的点：没窗口时退回 prefs 里记的位置。 */
function prefsPoint() {
  const b = win && !win.isDestroyed() ? win.getBounds() : null;
  if (b) return { x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) };
  return { x: Number(prefs.x) || 0, y: Number(prefs.y) || 0 };
}
// 右键「隐藏到托盘」：窗口 hide，但进程继续跑；托盘/快捷键/二次启动都能叫回来。
let tray = null;
const WAKE_ACCELERATOR = 'CommandOrControl+Alt+Shift+H';
// 陪伴模式：桌宠藏起来，底部单独开一条字幕窗；关掉后桌宠回来。
let companionWin = null;
let companionActive = false;
let petHiddenByCompanion = false;
let hiddenByUser = false;
let companionDrag = null;
// 字幕窗状态去重：内容没变就不往渲染端发，避免每 3 秒全量重绘一次（闪的第二个来源）。
let companionSig = '';
let lastCompanionState = null;

function bandFor() {
  return Math.max(PET_BUBBLE_SPACE, Math.round(Number(bubbleBand) || 0));
}

/** 桌宠窗口最小宽度：宠物本体 + 左右透明边。 */
function petMinWidth() {
  const pet = readPet();
  const wanted = Number(prefs.petSize) || Number(pet && pet.size) || 200;
  const size = Math.min(Math.max(Math.round(wanted), PET_MIN), PET_MAX);
  return size + PET_SIDE_SPACE;
}

/**
 * 气泡允许把窗口加宽到多少。
 * 以前窗口宽永远等于「宠物宽 + 40」，气泡只能拿到 150px 左右，长句被折成每行两三个字
 * （主人 2026-11-03 截图：「她看到：…」整块压在鲸鱼身上）。现在气泡可以申请更宽的窗口，
 * 宠物本体居中、水平中心不动，所以视觉上她不会挪位置。
 */
const PET_BUBBLE_MAX_W = 560;

function bubbleWidthFor(area) {
  const want = Math.round(Number(bubbleWidth) || 0);
  if (!want) return petMinWidth();
  const cap = Math.min(PET_BUBBLE_MAX_W, Math.max(petMinWidth(), Math.round((area?.width || 1920) - 24)));
  return Math.min(Math.max(want, petMinWidth()), cap);
}

/**
 * 当前窗口所在屏幕的工作区。
 * `screen` 只能在 app ready 之后用，而 baseSize() 在建窗阶段就会被调；拿不到就返回 null，
 * 让 bubbleWidthFor() 用默认上限——不然启动瞬间会直接抛异常。
 */
function currentWorkArea() {
  try {
    return screen.getDisplayNearestPoint(prefsPoint()).workArea;
  } catch {
    return null;
  }
}

/**
 * 收起状态下的窗口尺寸：永远是「宠物 + 头顶气泡 + 一点余量」。
 * 2026-11-04 主人要求去掉悬浮小球，只留桌宠，所以这里不再有 ball 分支；
 * 素材没装时渲染端会显示静态形象（pet.js 的 showFallbackAvatar），窗口尺寸照旧。
 */
function baseSize() {
  const pet = readPet();
  const wanted = Number(prefs.petSize) || Number(pet?.size) || 200;
  const size = Math.min(Math.max(Math.round(wanted), PET_MIN), PET_MAX);
  // 气泡显示时窗口可以更宽：宠物 video 在窗口里居中，中心不动她就没动。
  const width = Math.max(size + PET_SIDE_SPACE, bubbleWidthFor(currentWorkArea()));
  return { width, height: size + bandFor(), pet: true };
}

/** host.json 里插件写的形象配置（球/桌宠 + 素材目录 + 动画清单）。 */
let petCache = { at: 0, data: null };
function readPet() {
  const now = Date.now();
  if (now - petCache.at < 3000) return petCache.data;
  let pet = null;
  // host.json 是插件那边定时重写的，启动瞬间有可能正好读到写了一半的文件。
  // 读到坏的先等一会儿再读一次，还不行就退回上一次成功的结果，别因为一次抢读就把形象踢回小球。
  for (let i = 0; i < 3; i += 1) {
    const host = readHost();
    if (host?.pet && typeof host.pet === 'object') { pet = host.pet; break; }
    if (i < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
  if (!pet) pet = petCache.data;
  // host.json 里没有 pet（插件刚重写/还没轮到定时写），就直接读素材目录里的 manifest：
  // 桌面端不该因为一份缓存文件没刷新就退回小球。
  if (!pet) {
    try {
      const dir = path.join(ORB_DIR, 'pet');
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      if (manifest && Array.isArray(manifest.idle) && manifest.idle.length) {
        pet = { mode: 'pet', size: prefs.petSize || 200, dir, manifest, singleClickOpens: false, idleMinMs: 6000, idleMaxMs: 16000 };
      }
    } catch {}
  }
  petCache = { at: now, data: pet };
  return pet;
}

function log(...args) {
  const line = `${new Date().toISOString()} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  try { fs.mkdirSync(ORB_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, `${line}\n`); } catch {}
  console.log(line);
}

function readHost() {
  const now = Date.now();
  if (hostCache.data && now - hostCache.at < 5000) return hostCache.data;
  try {
    const raw = fs.readFileSync(HOST_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data?.baseUrl || !data?.token) throw new Error('host.json 缺 baseUrl/token');
    hostCache = { at: now, data };
    return data;
  } catch (error) {
    hostCache = { at: now, data: null };
    log('[orb] 读 host.json 失败：', String(error?.message ?? error));
    return null;
  }
}

/** 所有对插件的请求都从这里走（主进程 fetch，令牌不出主进程）。 */
async function call(apiPath, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
  const host = readHost();
  if (!host) return { ok: false, error: '还没连上 SurfCore（host.json 未生成，DSH 启动后会自动写）' };
  const url = `${String(host.baseUrl).replace(/\/+$/, '')}${host.api || '/dsh-surfcore/orb-api'}${apiPath}`;
  const headers = { 'x-orb-token': String(host.token), accept: 'application/json' };
  if (body !== null) headers['content-type'] = 'application/json';
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
    if (!res.ok) {
      // 401 常见于「DSH 重启换了令牌」：强制下一次重读 host.json。
      if (res.status === 401) hostCache = { at: 0, data: null };
      return { ok: false, status: res.status, error: data?.error || `HTTP ${res.status}`, data };
    }
    return { ok: true, status: res.status, data };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function clampToDisplay(x, y, width, height) {
  const area = screen.getDisplayNearestPoint({ x, y }).workArea;
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return {
    x: Math.min(Math.max(x, area.x), Math.max(area.x, maxX)),
    y: Math.min(Math.max(y, area.y), Math.max(area.y, maxY)),
  };
}

/**
 * 按「此刻的形态」夹位置。
 * 桌宠窗口左右各有 PET_SIDE_SPACE/2 的透明边——用整窗宽去夹，宠物身体就永远离屏幕边 20px，
 * 主人会以为「明明还能再往里拖」。收起态的桌宠允许整窗出屏这 20px，宠物身体才真的贴得到边。
 * 四个方向都再放宽 PET_KEEP：想把她甩到屏幕边缘/半出屏都行，但至少留这么多像素在屏里，
 * 不然拖出去就再也抓不回来了（主人 2026-10-31 提的）。
 */
const PET_KEEP = 60;

function clampForMode(x, y, width, height) {
  // 菜单必须整块留在屏内，不能像桌宠那样允许边缘出屏。
  if (menuOpen) return clampToDisplay(x, y, width, height);
  const petSide = baseSize().pet && displayMode !== 'expanded' ? Math.round(PET_SIDE_SPACE / 2) : 0;
  if (!petSide) return clampToDisplay(x, y, width, height);
  const area = screen.getDisplayNearestPoint({ x, y }).workArea;
  const keepX = Math.max(petSide, Math.min(PET_KEEP, Math.round(width * 0.5)));
  const keepY = Math.min(PET_KEEP, Math.round(height * 0.5));
  // 窗口上半截是「头顶气泡带」，宠物身体贴底。用整窗高去夹上边，等于气泡带先顶到屏幕边，
  // 她就卡在半空拖不上去了（主人 2026-11-01 说的「明明上面还有那么大空间」）。
  // 所以上边界只夹宠物实体，允许气泡带跑到屏幕外。
  // 窗口宽度会被「气泡加宽」撑大，所以宠物高度只能从尺寸推，不能拿窗口宽反算。
  const petNow = readPet();
  const bodySize = Math.min(Math.max(Math.round(Number(prefs.petSize) || Number(petNow && petNow.size) || 200), PET_MIN), PET_MAX);
  const bodyH = Math.min(height, bodySize);
  const minX = area.x - keepX;
  const maxX = area.x + area.width - width + keepX;
  // 上边不额外留 keepY：头顶正好贴屏幕顶就停，再往上她会缺一块（主人要的是「能到最上面」，不是「能被屏幕吃掉」）
  const minY = area.y - (height - bodyH);
  const maxY = area.y + area.height - height + keepY;
  return {
    x: Math.min(Math.max(x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(y, minY), Math.max(minY, maxY)),
  };
}

// #region pure-window-state
// 这一段只放「不依赖 Electron 的纯函数」：scripts/test-orb-window-state.mjs 会把两条标记
// 之间的代码抽出来直接跑断言。改逻辑时只用参数、别碰全局，否则测试和主进程会各说各话。
//
// 为什么单独抽出来：窗口状态机（隐藏/显示/陪伴）、宽度容差、高度网格、底边锚定这几件事
// 以前散在 IPC 回调和轮询里，每处各写一份判断、互相打架——「隐藏了又被拉回来」
// 「每 3 秒纠一次宽」「高度一变顶边就跳」都是这么来的。

/** 字幕窗该不该显示：只有陪伴生效、且用户没主动隐藏时才允许 showInactive。 */
function companionShouldShow(companionActive, hiddenByUser) {
  return Boolean(companionActive) && !hiddenByUser;
}

/** 托盘单击该做什么：当前有窗口露在屏幕上就隐，否则显示。 */
function trayToggleAction({ companionActive, mainVisible, companionVisible }) {
  const shown = companionActive ? Boolean(companionVisible) : Boolean(mainVisible);
  return shown ? 'hide' : 'show';
}

/** 「从托盘唤醒」要恢复哪个窗口：陪伴模式只回字幕窗，桌宠保持隐藏。 */
function restoreSurface(companionActive) {
  return companionActive ? 'companion' : 'main';
}

/**
 * 宽度是否已收敛。
 * setBounds 写 738、getBounds 回读 740 是常态（非客户区 + 175% 缩放取整），
 * 用严格相等判断就永远收敛不了 → 每 3 秒真改一次宽度 → 重折行 → 高度变 → 顶边跳。
 */
function widthConverged(actual, wanted, tolerance = 4) {
  return Math.abs(Number(actual) - Number(wanted)) <= tolerance;
}

/**
 * 字幕高度上报判定：按 8px 网格取整，和当前高度差不到 12px 就不上报。
 * 返回 null = 不动窗口；返回数字 = 上报这个高度。
 */
function snapCompanionHeight(measured, current, { grid = 8, minDelta = 12, min = 56 } = {}) {
  const raw = Number(measured);
  if (!Number.isFinite(raw)) return null;
  const snapped = Math.max(min, Math.round(raw / grid) * grid);
  const base = Number(current);
  if (Number.isFinite(base) && base > 0 && Math.abs(snapped - base) < minDelta) return null;
  return snapped;
}

/**
 * 底边锚定：高度变化时脚底不动，只在越界时向上让位（绝不下移）。
 * 旧实现把 y 往下夹到 area.bottom-40，内容变矮时窗口一路往下沉，是漂移的根因。
 */
function anchorCompanionBottom(bounds, wantedHeight, area, { min = 56, max = 560, margin = 8, headroom = 4 } = {}) {
  const bottom = bounds.y + bounds.height;
  let height = Math.round(Math.min(Math.max(Number(wantedHeight) || bounds.height, min), Math.min(max, area.height - 16)));
  let y = bottom - height;
  if (y < area.y + headroom) {
    y = area.y + headroom;
    height = Math.min(height, Math.max(min, area.y + area.height - margin - y));
  }
  if (y + height > area.y + area.height - margin) y = area.y + area.height - margin - height;
  return { x: bounds.x, y, width: bounds.width, height };
}

/** 字幕窗宽度上限：建窗、轮询纠宽、拖宽手柄三处必须同一个值，否则每 3 秒互相打一次架。 */
function companionMaxWidth(areaWidth) {
  const width = Math.round(Number(areaWidth) || 0);
  return Math.min(1400, Math.max(520, width - 24));
}
// #endregion pure-window-state

function readPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
    const size = Number(raw?.ballSize);
    const pw = Number(raw?.panelWidth);
    const ph = Number(raw?.panelHeight);
    const petSize = Number(raw?.petSize);
    prefs = {
      // 0 和 null 都算「没设过」：JSON 里 null 转 Number 是 0，直接夹会变成最小尺寸（踩过）
      petSize: Number.isFinite(petSize) && petSize > 0 ? Math.min(Math.max(Math.round(petSize), PET_MIN), PET_MAX) : null,
      ballSize: Number.isFinite(size) ? Math.min(Math.max(Math.round(size), MIN_BALL), MAX_BALL) : COLLAPSED,
      x: Number.isFinite(Number(raw?.x)) ? Number(raw.x) : null,
      y: Number.isFinite(Number(raw?.y)) ? Number(raw.y) : null,
      panelWidth: Number.isFinite(pw) ? Math.round(pw) : EXPANDED.width,
      panelHeight: Number.isFinite(ph) ? Math.round(ph) : EXPANDED.height,
      // 主人拖过面板之后的位置：下次展开还回原处，收起时桌宠也落在那边。
      // 0 当作「没设过」：否则面板会跑到左上角（历史上 commit 过一次 0,0）
    panelX: Number.isFinite(Number(raw?.panelX)) && Number(raw.panelX) > 0 ? Math.round(Number(raw.panelX)) : null,
      panelY: Number.isFinite(Number(raw?.panelY)) && Number(raw.panelY) > 0 ? Math.round(Number(raw.panelY)) : null,
      companion: (() => {
        const c = raw?.companion && typeof raw.companion === 'object' ? raw.companion : null;
        if (!c) return null;
        const w = Math.round(Number(c.width));
        const f = Math.round(Number(c.fontPx));
        return {
          x: Number.isFinite(Number(c.x)) ? Math.round(Number(c.x)) : null,
          y: Number.isFinite(Number(c.y)) ? Math.round(Number(c.y)) : null,
          width: Number.isFinite(w) && w >= 520 ? Math.min(w, 1400) : 900,
          fontPx: Number.isFinite(f) && f >= 14 ? Math.min(f, 40) : 22,
        };
      })(),
    };
  } catch {
    prefs = { ballSize: COLLAPSED, petSize: null, x: null, y: null, panelWidth: EXPANDED.width, panelHeight: EXPANDED.height, panelX: null, panelY: null, companion: null };
  }
  return prefs;
}

function writePrefs(patch = {}) {
  prefs = { ...prefs, ...patch };
  try {
    fs.mkdirSync(ORB_DIR, { recursive: true });
    fs.writeFileSync(PREFS_FILE, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
  } catch (error) {
    log('[orb] 写 prefs 失败：', String(error?.message ?? error));
  }
}

/** 记住「收起时的球」在哪、多大——展开再收起要原样回去。 */
function rememberBall() {
  if (!win || win.isDestroyed() || expanded || animating) return;
  const b = win.getBounds();
  // 尺寸走 baseSize()：桌宠模式是「宠物+气泡」，球模式是球；
  // 绝不能把动画中途的窗口尺寸当成基准尺寸写进 prefs（曾经写成 272 那种鬼数字）。
  const base = baseSize();
  const width = Math.min(Math.max(Math.round(base.width), MIN_BALL), PANEL_MAX_W);
  const height = Math.min(Math.max(Math.round(base.height), MIN_BALL), PANEL_MAX_H);
  ballRect = { x: b.x, y: b.y, width, height };
  // 球的尺寸只可能是 MIN_BALL~MAX_BALL；桌宠模式一律不写，免得把 240 那种窗口宽度写进 ballSize
  // （readPet 偶尔拿不到 pet 时会走到这里，曾经把 247 写进去，之后收起就变成一坨大窗口）。
  // ballSize 只由 orb:resize 明确改，这里一律不写：桌宠窗口宽度、展开中途的尺寸都曾经被误记成球的大小。
  writePrefs({ x: b.x, y: b.y });
}

/**
 * 任何写进窗口的 bounds 都先过这里：
 * 尺寸夹到 [MIN_BALL, PANEL_MAX_*]，位置保证整窗留在工作区内。
 * 长按/拖拽/缩放这些路径都走它，避免窗口被撑大或推出屏幕（主人踩过：变大后进侧边栏就不见了）。
 */
function safeBounds(target) {
  const width = Math.min(Math.max(Math.round(Number(target?.width) || MIN_BALL), MIN_BALL), PANEL_MAX_W);
  const height = Math.min(Math.max(Math.round(Number(target?.height) || MIN_BALL), MIN_BALL), PANEL_MAX_H);
  const rawX = Number(target?.x);
  const rawY = Number(target?.y);
  const pos = clampForMode(
    Number.isFinite(rawX) ? Math.round(rawX) : prefs.x ?? 0,
    Number.isFinite(rawY) ? Math.round(rawY) : prefs.y ?? 0,
    width,
    height,
  );
  return { ...pos, width, height };
}

/**
 * 当前窗口「应该」是多大：模式不变量。
 * 主人踩过两次：左键长按 / 面板误缩放之后窗口一直变大，最后钻进屏幕外找不回来。
 * 根因是各条写窗口的路径各算各的尺寸，谁也没按「此刻该是什么形态」校一次。
 * 现在只认三种形态，任何写窗口的地方都过 applyBounds() 校回来：
 *   collapsed 收起态 —— 必须正好是宠物/小球的尺寸
 *   expanded  展开态 —— 必须是面板尺寸（prefs 里记的，夹在 PANEL_MIN~MAX）
 *   menu      菜单态 —— 窗口保持收起尺寸，菜单画在窗口内部，不撑大窗口
 */
let displayMode = 'collapsed';
// 菜单是独立覆盖层：临时改窗口尺寸，但不改变 displayMode，
// 这样点菜单外只收菜单，不会把已展开的面板打回桌宠。
let menuOpen = false;
let menuNeed = null;
let menuRestore = 'collapsed';

function expectedBounds() {
  const cur = win && !win.isDestroyed() ? win.getBounds() : null;
  const base = baseSize();
  if (menuOpen && menuNeed) {
    const anchor = cur || { x: 0, y: 0, width: menuNeed.width, height: menuNeed.height };
    return { x: anchor.x, y: anchor.y, width: menuNeed.width, height: menuNeed.height };
  }
  if (displayMode === 'expanded') {
    const width = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, Math.round(prefs.panelWidth || EXPANDED.width)));
    const height = Math.min(PANEL_MAX_H, Math.max(PANEL_MIN_H, Math.round(prefs.panelHeight || EXPANDED.height)));
    const anchor = ballRect || cur || { x: 0, y: 0, width, height };
    return { x: anchor.x + anchor.width - width, y: anchor.y, width, height };
  }
  const width = base.width;
  const height = base.height;
  // 收起态保住右下角不动：视觉上像从面板缩回宠物，不会「跳走」。
  const x = cur ? cur.x + cur.width - width : (prefs.x ?? 0);
  const y = cur ? cur.y + cur.height - height : (prefs.y ?? 0);
  return { x, y, width, height };
}

/** 所有写窗口的唯一出口：先夹物理上限，再按模式锁死不该变的维度。 */
let lastMoveReason = '';
let lastMoveAt = 0;

function applyBounds(target, reason = '') {
  if (!win || win.isDestroyed()) return null;
  const want = safeBounds(target || {});
  const lock = expectedBounds();
  // 不变式：位置可以由调用方指定，尺寸只认「此刻该有的形态」。
  // 主人踩过：点「移」拖面板时窗口一路变大——因为渲染端把当前宽高又传回来、叠加。
  const next = {
    x: Number.isFinite(Number(want.x)) ? want.x : lock.x,
    y: Number.isFinite(Number(want.y)) ? want.y : lock.y,
    width: reason === 'panel-move' ? lock.width : want.width,
    height: reason === 'panel-move' ? lock.height : want.height,
  };
  if (menuOpen) {
    // 菜单覆盖层：尺寸只能等于菜单需要的大小。
    next.width = lock.width;
    next.height = lock.height;
  } else if (displayMode !== 'expanded') {
    // 收起态：尺寸只有一个合法值（宠物或小球），任何路径都改不动它。
    next.width = lock.width;
    next.height = lock.height;
  } else {
    // 展开态：允许沿边缘缩放，但夹在面板上下限之间（applyBounds 的 want 已经夹过物理上限）。
    next.width = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, next.width));
    next.height = Math.min(PANEL_MAX_H, Math.max(PANEL_MIN_H, next.height));
  }
  // 位置统一走 clampForMode：收起态要允许「气泡带」出屏，宠物才拖得到最上面；
  // 之前这里直接调 clampToDisplay（整窗夹屏），桌上宠物永远卡在离屏顶 110px 的地方（2026-11-01）。
  const pos = clampForMode(next.x, next.y, next.width, next.height);
  const final = { ...pos, width: next.width, height: next.height };
  const before = win.getBounds();
  if (
    before.x === final.x && before.y === final.y &&
    before.width === final.width && before.height === final.height
  ) return final;
  if (process.env.ORB_TRACE === '1') {
    log(`[orb] bounds ${reason || '-'} ${JSON.stringify(before)} -> ${JSON.stringify(final)}`);
  } else if (reason !== 'animate' && reason !== 'pet-walk') {
    // 常开但节流：谁把窗口挪了、从哪到哪。主人报「鼠标靠近她就自己跑」，靠这条从日志里定位。
    const stamp = Date.now();
    if (reason !== lastMoveReason || stamp - lastMoveAt > 1000) {
      lastMoveReason = reason;
      lastMoveAt = stamp;
      log(`[win] ${reason || '-'} ${JSON.stringify(before)} -> ${JSON.stringify(final)}`);
    }
  }
  win.setBounds(final);
  return final;
}

const easeOut = (t) => 1 - (1 - t) ** 3;

/** 逐帧改窗口 bounds。Electron 在 Windows 上没有动画参数，自己插值才「丝滑」。 */
function animateTo(target, { duration = ANIM_MS, reason = '' } = {}) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  const from = win.getBounds();
  const to = applyBounds(target, reason || 'animate');
  if (!to) return Promise.resolve();
  if (
    from.x === to.x && from.y === to.y &&
    from.width === to.width && from.height === to.height
  ) return Promise.resolve();
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  animating = true;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const step = () => {
      if (!win || win.isDestroyed()) { clearInterval(animTimer); animTimer = null; animating = false; resolve(); return; }
      const t = Math.min(1, (Date.now() - startedAt) / duration);
      const k = easeOut(t);
      win.setBounds({
        x: Math.round(from.x + (to.x - from.x) * k),
        y: Math.round(from.y + (to.y - from.y) * k),
        width: Math.round(from.width + (to.width - from.width) * k),
        height: Math.round(from.height + (to.height - from.height) * k),
      });
      if (t >= 1) { clearInterval(animTimer); animTimer = null; animating = false; resolve(); }
    };
    animTimer = setInterval(step, 8);
    step();
  });
}

/**
 * 展开目标：面板要「贴着宠物长、又要整块留在屏幕里」。
 *  - 主人拖过面板（prefs.panelX/Y）就回原位，这是他自己放的地方；
 *  - 没拖过就按哪边空间大往哪边长；
 *  - 竖直方向以宠物中心对齐面板中心，再夹进工作区（以前固定 y=宠物顶，靠近屏幕底就会压住宠物）。
 */
function expandTarget() {
  const base = ballRect || { ...win.getBounds() };
  const area = screen.getDisplayNearestPoint({ x: base.x, y: base.y }).workArea;
  const width = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, Math.round(prefs.panelWidth || EXPANDED.width)));
  const height = Math.min(PANEL_MAX_H, Math.max(PANEL_MIN_H, Math.round(prefs.panelHeight || EXPANDED.height)));
  if (Number.isFinite(prefs.panelX) && Number.isFinite(prefs.panelY)) {
    return { ...clampToDisplay(prefs.panelX, prefs.panelY, width, height), width, height };
  }
  const roomLeft = base.x - area.x;
  const roomRight = area.x + area.width - (base.x + base.width);
  // 空间够就贴着宠物长，两边都不够就挑大的那边、让面板覆盖在宠物上方
  const growLeft = roomRight >= width || (roomLeft >= width ? false : roomLeft >= roomRight);
  const x = growLeft ? base.x + base.width - width : base.x;
  const centerY = base.y + Math.round((base.height - height) / 2);
  const pos = clampToDisplay(x, centerY, width, height);
  return { ...pos, width, height };
}

/** 「原地变小球」：把面板右下角收回去，视觉上像缩回球里（面板被拖过就落在面板那里）。 */
function collapseTarget() {
  if (ballRect) return { ...ballRect };
  const cur = win.getBounds();
  const base = baseSize();
  return { ...clampToDisplay(cur.x + cur.width - base.width, cur.y, base.width, base.height), width: base.width, height: base.height };
}


async function setExpanded(on) {
  if (!win || win.isDestroyed()) return false;
  const want = Boolean(on);
  if (want === expanded) return expanded;
  // 动画没结束就再来一次展开/收起，会让「收回去的位置」和「长出来的尺寸」错位，
  // 主人长按时正好把这对操作打成连环，窗口一次比一次大。这里串行化：只记最后一次请求。
  if (animating) {
    pendingExpand = want;
    return expanded;
  }
  pendingExpand = null;
  // 开/收面板一律把头顶气泡带复位：面板态用不上它，收起时也不会留下一个「长高版」的窗口。
  bubbleBand = 0;
  bubbleWidth = 0;
  if (!want) {
    // 收起 = 回到「主人把桌宠放在哪」那个位置（ballRect），**不跟着面板走**。
    // 之前这里把 ballRect 改到面板右下角，结果一开一收桌宠就自己挪窝了（主人明确要求位置只由他决定）。
    expanded = false;
    displayMode = 'collapsed';
    await animateTo(collapseTarget(), { reason: 'collapse' });
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch {}
    await flushPendingExpand();
    return expanded;
  }
  rememberBall();
  expanded = true;
  displayMode = 'expanded';
  await animateTo(expandTarget(), { reason: 'expand' });
  try { win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); } catch {}
  await flushPendingExpand();
  return expanded;
}

/** 动画结束后补做最后一次被挡住的展开/收起，避免请求丢失。 */
async function flushPendingExpand() {
  const want = pendingExpand;
  pendingExpand = null;
  if (want === null || want === undefined) return;
  if (Boolean(want) === expanded) return;
  await setExpanded(want);
}

// ---- 隐藏到托盘：隐藏不是关闭，进程/轮询都留着，随时能叫回来 ----------------
function trayImage() {
  try {
    const image = nativeImage.createFromPath(path.join(__dirname, 'avatar.png'));
    if (image.isEmpty()) return nativeImage.createEmpty();
    return image.resize({ width: 16, height: 16 });
  } catch {
    return nativeImage.createEmpty();
  }
}

let trayMenuSig = '';

function updateTrayMenu() {
  if (!tray) return;
  const mainVisible = Boolean(win && !win.isDestroyed() && win.isVisible());
  const companionVisible = Boolean(companionWin && !companionWin.isDestroyed() && companionWin.isVisible());
  const visible = companionActive ? companionVisible : mainVisible;
  // 每 3 秒重建一次菜单会连带刷新托盘图标/tooltip；只在状态真的变了才重建。
  const sig = `${visible}|${companionActive}|${hiddenByUser}`;
  if (sig === trayMenuSig) return;
  trayMenuSig = sig;
  const showLabel = companionActive ? '显示陪伴字幕' : '显示桌宠';
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: visible ? '隐藏到托盘' : showLabel,
      click: () => { void toggleWindow(); },
    },
    {
      label: companionActive ? '关闭陪伴（恢复桌宠）' : '开启陪伴（字幕模式）',
      click: () => { void toggleCompanionFromTray(!companionActive); },
    },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() },
  ]));
  tray.setToolTip(visible ? '小鲸鱼桌宠 · 单击隐藏' : '小鲸鱼桌宠 · 单击唤醒');
}

async function hideWindow() {
  if (!win || win.isDestroyed()) return false;
  // 隐藏前先停掉所有还会改窗口状态的定时器：8ms 一帧的展开动画、16ms 一帧的字幕拖动。
  // 否则 hide() 之后它们还会把窗口 setBounds 回来（「点了隐藏，桌宠还留在桌面上」的一半原因）。
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  animating = false;
  pendingExpand = null;
  if (companionDrag) { clearInterval(companionDrag.timer); companionDrag = null; }
  // 不播收起动画（170ms 里窗口还露着），直接标成收起态再藏；位置仍由 ballRect 记住。
  expanded = false;
  displayMode = 'collapsed';
  bubbleBand = 0;
  bubbleWidth = 0;
  hiddenByUser = true;
  // 字幕窗也要一起藏：以前只 win.hide()，陪伴模式下字幕条还留在桌面上。
  if (companionWin && !companionWin.isDestroyed()) {
    try { companionWin.hide(); } catch {}
  }
  try { win.hide(); } catch (error) {
    hiddenByUser = false;
    log('[orb] 隐藏窗口失败', String(error?.message ?? error));
    return false;
  }
  stopClickWatch();
  updateTrayMenu();
  try { win.webContents.send('orb:hidden'); } catch {}
  log('[orb] 已隐藏到托盘');
  return true;
}

function showWindow() {
  if (!win || win.isDestroyed()) return false;
  hiddenByUser = false;
  // 陪伴模式：只回字幕窗，桌宠继续藏着（两个窗口同屏会挡视线）。
  if (restoreSurface(companionActive) === 'companion') {
    petHiddenByCompanion = true;
    ensureCompanionWindow(lastCompanionState || { active: true });
    if (companionWin && !companionWin.isDestroyed()) {
      try { companionWin.showInactive(); } catch {}
      try {
        if (!companionWin.isAlwaysOnTop()) companionWin.setAlwaysOnTop(true, 'screen-saver', 1);
        companionWin.moveTop();
      } catch {}
      try { sendCompanionState(lastCompanionState || { active: true }); } catch {}
    }
    updateTrayMenu();
    log('[orb] 已从托盘唤醒（陪伴字幕）');
    return true;
  }
  // 隐藏时窗口停在面板尺寸上：先按 ballRect 恢复成收起态再显示，避免「一唤醒就是一整块面板」。
  // 已经可见（比如面板开着时又被叫醒）就不动尺寸，别把展开态缩回去。
  if (!win.isVisible()) {
    try {
      const base = baseSize();
      const anchor = ballRect || win.getBounds();
      // 走 applyBounds：跟其它所有写窗口的地方一样过一遍 clampForMode（屏幕换了也夹得回来）。
      const next = applyBounds({ x: anchor.x, y: anchor.y, width: base.width, height: base.height }, 'restore');
      if (next) win.setBounds(next);
    } catch {}
  }
  try { win.showInactive(); } catch { try { win.show(); } catch {} }
  try {
    if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
    win.setIgnoreMouseEvents(false);
  } catch {}
  startClickWatch();
  updateTrayMenu();
  try { win.webContents.send('orb:shown'); } catch {}
  log('[orb] 已从托盘唤醒');
  return true;
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return false;
  // 陪伴模式下 win 一直是隐藏的：不能只问 win.isVisible()，否则托盘永远只会「显示」。
  const action = trayToggleAction({
    companionActive,
    mainVisible: win.isVisible(),
    companionVisible: Boolean(companionWin && !companionWin.isDestroyed() && companionWin.isVisible()),
  });
  return action === 'hide' ? hideWindow() : showWindow();
}

function createTray() {
  if (tray) return tray;
  try {
    tray = new Tray(trayImage());
    tray.on('click', () => { void toggleWindow(); });
    updateTrayMenu();
    log('[orb] 托盘已创建');
  } catch (error) {
    tray = null;
    log('[orb] 托盘创建失败', String(error?.message ?? error));
  }
  return tray;
}


function createWindow() {
  readPrefs();
  const area = screen.getPrimaryDisplay().workArea;
  const base = baseSize();
  const size = base.width;
  const height = base.height;
  const startX = prefs.x ?? area.x + area.width - size - 12;
  const startY = prefs.y ?? area.y + Math.round(area.height * 0.42);
  // 上次可能是在屏外（换分辨率/拔了副屏）存的坐标：开局先夹回可视区域，
  // 否则球一启动就贴在屏幕外面，用户以为程序没跑起来。
  const startPos = clampToDisplay(Math.round(startX), Math.round(startY), size, height);
  win = new BrowserWindow({
    width: size,
    height: height,
    x: startPos.x,
    y: startPos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    // 无边框窗不要再带 WS_THICKFRAME：它会让 setBounds 的回读比写入多 2px（175% 缩放下尤其明显），
    // 于是「纠偏 → 回读仍不符 → 再纠偏」永远收敛不了，每 3 秒真改一次尺寸，还连带重折行。
    thickFrame: false,
    movable: true,
    skipTaskbar: true,
    focusable: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // 注意：Windows 上不要调 setVisibleOnAllWorkspaces —— 它会把窗口标成「跨虚拟桌面可见」，
  // 结果 DWM 直接把窗口 cloaked 掉：Electron 自己说 visible=true，屏幕上却什么都没有。
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  // 渲染进程出问题时球会「看得见窗口、看不见内容」：把渲染侧的报错也写进日志，
  // 否则只有黑屏/透明一片，从日志里查不出来。
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('[orb] 页面加载失败', code, desc, url));
  win.webContents.on('render-process-gone', (_e, details) => log('[orb] 渲染进程挂了', JSON.stringify(details)));
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) log('[orb][renderer]', String(message).slice(0, 300), `@${String(source || '').split('/').pop()}:${line}`);
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    // 不要抢焦点：主人可能正在打字。
    try { win.showInactive(); } catch { win.show(); }
    // Windows 上 screen-saver 级别对某些全屏/顶置窗口压不住，每次显示后再提一次最前。
    try { win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); } catch {}
    try {
      const b = win.getBounds();
      log('[orb] ready-to-show', `bounds=${b.x},${b.y},${b.width}x${b.height}`, `visible=${win.isVisible()}`);
      ballRect = { x: b.x, y: b.y, width: b.width, height: b.height };
      writePrefs({ x: b.x, y: b.y });
    } catch {}
    // 自检：DOM 有没有真的画出来。桌宠「窗口可见但屏幕上一片空」时，
    // 十有八九是脚本/样式被 CSP 拦了（file:// 下 'self' 不认），这里直接问页面。
    win.webContents.executeJavaScript(`(() => {
      const stage = document.querySelector('.petStage');
      const css = [...document.styleSheets].map(s => s.href || 'inline');
      return {
        title: document.title,
        ready: document.readyState,
        pet: stage ? { w: stage.offsetWidth, h: stage.offsetHeight } : null,
        sheets: css,
        hasOrb: typeof window.orb,
        hasPet: typeof window.SurfPet,
        bodyChildren: document.body ? document.body.children.length : 0,
      };
    })()`).then((info) => log('[orb] dom', JSON.stringify(info))).catch((e) => log('[orb] dom check failed', String(e?.message ?? e)));
  });
  win.on('closed', () => { win = null; });
  win.on('show', () => updateTrayMenu());
  win.on('hide', () => updateTrayMenu());
  log('[orb] 窗口已创建');
}

/** 陪伴字幕窗：宽度/字号跟着插件状态走，位置存在本机 prefs。 */
function companionLayout(state = {}) {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = prefs.companion || {};
  // 用户拖过宽度就以本机 prefs 为准，避免服务端旧 state 每次轮询把宽度打回去。
  // 上限和 companion:width 用同一个（companionMaxWidth），否则拖宽之后每 3 秒被打回去一次。
  const width = Math.min(Math.max(Number(saved.width) || Number(state.width) || 900, 520), companionMaxWidth(area.width));
  const font = Math.min(Math.max(Number(saved.fontPx) || Number(state.fontPx) || 22, 14), 40);
  const height = Math.round(Math.min(180, Math.max(72, font * 2.3 + 44)));
  const wantX = Number.isFinite(saved.x) ? saved.x : area.x + Math.round((area.width - width) / 2);
  const wantY = Number.isFinite(saved.y) ? saved.y : area.y + area.height - height - 18;
  const pos = clampToDisplay(wantX, wantY, width, height);
  return { ...pos, width, height, fontPx: font };
}

function forceCompanionTopmost(win) {
  try {
    if (!win || win.isDestroyed()) return;
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
    const ps = [
      "Add-Type -Namespace Native -Name Win -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);';",
      // 0x0013 = SWP_NOSIZE(1) | SWP_NOMOVE(2) | SWP_NOACTIVATE(0x10)。
      // 以前带 0x0040(SWP_SHOWWINDOW)，等于每 800ms 又把窗口「显示」一次：位置/可见性回读一变，
      // 透明窗就重合成一帧，看起来就是字幕背景在闪。
      `[Native.Win]::SetWindowPos([IntPtr]${hwnd},[IntPtr](-1),0,0,0,0,0x0013) | Out-Null`,
    ].join(' ');
    require('node:child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
  } catch {}
}

/** 给字幕窗发状态：内容没变就不发（每 3 秒全量重绘是「字幕背景一直闪」的第二来源）。 */
function companionStateSignature(state) {
  try { return JSON.stringify(state); } catch { return `${Date.now()}`; }
}

function sendCompanionState(state) {
  if (!companionWin || companionWin.isDestroyed()) return;
  const sig = companionStateSignature(state);
  if (sig === companionSig) return;
  companionSig = sig;
  try { companionWin.webContents.send('companion:state', state); } catch {}
}

function ensureCompanionWindow(state = {}) {
  // 用户点了「隐藏到托盘」：状态照收，但不许建窗、不许 showInactive——
  // 以前这里每 3 秒把已经藏起来的字幕窗拉回来一次，主人看到的就是「藏了又自己冒出来」。
  if (!companionShouldShow(companionActive, hiddenByUser)) return companionWin;
  const layout = companionLayout(state);
  if (companionWin && !companionWin.isDestroyed()) {
    try {
      const b = companionWin.getBounds();
      // 高度由字幕窗自己按模式量出来（单条/上下文/历史/输入），主进程不跟它抢。
      // 宽度只在「真的没收敛」时才改：setBounds 回读经常比写入多 0~4px，严格比较会每 3 秒改一次。
      if (!widthConverged(b.width, layout.width)) {
        companionWin.setBounds({ x: b.x, y: b.y, width: layout.width, height: b.height });
      }
      if (!companionWin.isVisible()) {
        companionWin.showInactive();
        // 字幕窗的显示/隐藏不经过主窗口，托盘菜单得自己跟上（sig 缓存，重复调用很便宜）。
        updateTrayMenu();
      }
      // setAlwaysOnTop 每次都会走一遍 DWM 窗口样式刷新：先问一句再设，别再 false→true 折腾一遍。
      if (!companionWin.isAlwaysOnTop()) companionWin.setAlwaysOnTop(true, 'screen-saver', 1);
      sendCompanionState(state);
    } catch {}
    return companionWin;
  }
  const { x: companionX, y: companionY, width: companionW, height: companionH } = layout;
  companionWin = new BrowserWindow({
    x: companionX, y: companionY, width: companionW, height: companionH,
    frame: false,
    transparent: true,
    resizable: false,
    // 同上：读回值和写入值差 2px 会让「纠宽 → 回读不符 → 再纠宽」无限循环。
    thickFrame: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  companionWin.setAlwaysOnTop(true, 'screen-saver', 1);
  // Windows 上不要调 setVisibleOnAllWorkspaces：DWM 会直接把窗口 cloaked
  //（Electron 里 isVisible() 为 true，屏幕上一片空）。只有 macOS 需要它。
  if (process.platform === 'darwin') {
    try { companionWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  }
  companionWin.loadFile(path.join(__dirname, 'companion.html'));
  companionWin.once('ready-to-show', () => {
    if (!companionWin || companionWin.isDestroyed()) return;
    // 建窗和显示之间用户可能已经点了隐藏：这里再确认一次，别把隐藏的字幕窗又 show 出来。
    if (!companionShouldShow(companionActive, hiddenByUser)) return;
    companionWin.showInactive();
    try {
      if (!companionWin.isAlwaysOnTop()) companionWin.setAlwaysOnTop(true, 'screen-saver', 1);
      companionWin.moveTop();
    } catch {}
    forceCompanionTopmost(companionWin);
    setTimeout(() => forceCompanionTopmost(companionWin), 800);
    // 首次要发：先清掉去重指纹，否则 sendCompanionState 会把它当成「内容没变」吞掉。
    companionSig = '';
    sendCompanionState(state);
  });
  companionWin.on('closed', () => { companionWin = null; companionSig = ''; });
  companionWin.on('show', () => updateTrayMenu());
  companionWin.on('hide', () => updateTrayMenu());
  log('[companion] 字幕窗已创建');
  return companionWin;
}

function closeCompanionWindow() {
  if (companionDrag) { clearInterval(companionDrag.timer); companionDrag = null; }
  companionSig = '';
  if (!companionWin || companionWin.isDestroyed()) { companionWin = null; return; }
  try { companionWin.destroy(); } catch {}
  companionWin = null;
}

function syncCompanion(state) {
  // 记住最近一次状态：用户从托盘唤醒陪伴模式时，靠它把字幕窗按「此刻该显示什么」建回来。
  lastCompanionState = state || null;
  const active = state?.active === true;
  if (active) {
    if (!companionActive) {
      companionActive = true;
      // 陪伴生效时把桌宠藏起来；用户本来就隐藏着的话什么都不做（否则会「假装显示了一次」）。
      if (win && !win.isDestroyed() && win.isVisible()) {
        win.hide();
        petHiddenByCompanion = true;
        stopClickWatch();
      }
      updateTrayMenu();
    }
    ensureCompanionWindow(state);
    return;
  }
  if (companionActive) {
    companionActive = false;
    closeCompanionWindow();
    if (petHiddenByCompanion) {
      petHiddenByCompanion = false;
      if (!hiddenByUser) showWindow();
    }
    updateTrayMenu();
  }
}

async function toggleCompanionFromTray(active) {
  const result = await call('/companion', {
    method: 'POST',
    body: active ? { action: 'start', sessionId: '' } : { action: 'stop' },
    timeoutMs: 20000,
  });
  if (result?.ok === false) {
    dialog.showErrorBox('陪伴模式', String(result.error || '开启失败'));
    return;
  }
  // syncCompanion 里已经会按需建窗/关窗并把状态发下去，这里不用再补一次 send。
  const state = result?.data?.status || result?.data?.companion || null;
  if (state) {
    // 从托盘显式开启陪伴 = 他此刻想看字幕。hiddenByUser 还立着的话会把刚建的字幕窗挡住，
    // 表现为「点了开启陪伴什么都没出现」。显式动作优先，先解除隐藏标记。
    if (active && state.active === true) hiddenByUser = false;
    syncCompanion(state);
  } else updateTrayMenu();
}

function startPolling() {
  const tick = async () => {
    const res = await call('/state', { timeoutMs: 8000 });
    if (!win || win.isDestroyed()) return;
    if (!res.ok) {
      failures += 1;
      win.webContents.send('orb:conn', { ok: false, error: res.error || '连不上', failures });
      if (failures >= MAX_STATE_FAILURES) {
        log('[orb] 连续连不上插件，自己退出（DSH 可能已关）');
        app.quit();
      }
      return;
    }
    failures = 0;
    // 自愈：万一窗口被撑大 / 推到屏幕外（长按、缩放、停靠都可能），每 3 秒拉回来一次。
    // 阈值必须大于 DPI 取整噪声（175% 缩放下 setBounds→getBounds 会差 2~4px）：
    // 以前阈值是 2，于是每次都判「异常」，每 3 秒拉起一次 120ms 动画——日志里 1 万多条
    // 「收回异常窗口」、屏幕上看到的「球自己在抖」，都是这条循环。
    // 窗口已经 hide() 时 getBounds 还是旧尺寸，不排除的话每 3 秒都对一个看不见的窗口
    // setBounds + 打一条「收回异常窗口」，日志继续刷屏（而且唤醒时尺寸会被悄悄改掉）。
    if (win.isVisible() && !hiddenByUser && !expanded && !animating && !dragResize && !sizePanel) {
      const cur = win.getBounds();
      const base = baseSize();
      const fix = safeBounds({ x: cur.x, y: cur.y, width: base.width, height: base.height });
      // 位置漂移（被推到屏幕外）必须拉回来；尺寸差 8px 以内是正常抖动（175% 缩放 + 气泡带 +
      // setBounds→getBounds 取整），以前连这点差都算「异常」，每 3 秒重设一次窗口就是她抖/闪的根源。
      const posDrift = Math.abs(fix.x - cur.x) + Math.abs(fix.y - cur.y);
      const sizeDrift = Math.abs(fix.width - cur.width) + Math.abs(fix.height - cur.height);
      const drift = posDrift + (sizeDrift > 16 ? sizeDrift : 0);
      if (drift > 6) {
        log('[orb] 收回异常窗口', cur, '->', fix);
        // 直接落位，不再 animateTo：每 3 秒一次 120ms 插值动画本身就是可见的抖动。
        applyBounds(fix, 'self-heal');
      }
    }
    win.webContents.send('orb:conn', { ok: true });
    win.webContents.send('orb:state', res.data || null);
    try { syncCompanion(res.data?.companion || null); } catch (error) { log('[companion] 同步失败', String(error?.message ?? error)); }
    // 有些窗口（全屏播放器、别的 Electron 应用）会把自己提到最前，球要定期抢回来。
    // 但只有真的丢了置顶才重设 + moveTop：每 3 秒无条件 moveTop 会让 DWM 反复重排 z 序（也闪）。
    if (win.isVisible() && !win.isAlwaysOnTop()) {
      try { win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); } catch {}
    }
  };
  tick();
  pollTimer = setInterval(tick, STATE_POLL_MS);
}

// ── 互动监测（主进程只做搬运）────────────────────────────────────────────
// 采样在插件里（powershell 每 pollMs 跑一次，写 activity.json）；
// 这边每 5 秒看一眼文件的 mtime，变了就把内容推给渲染端。
const ACTIVITY_FILE = path.join(ORB_DIR, 'activity.json');
const ACTIVITY_POLL_MS = 5000;
let activityTimer = null;
let activitySentMtime = null;

function pushActivity() {
  if (!win || win.isDestroyed()) return;
  let mtimeMs = null;
  let data = null;
  try {
    const stat = fs.statSync(ACTIVITY_FILE);
    mtimeMs = stat.mtimeMs;
    // 只在 mtime 变了才解析：每 5 秒读一次 JSON 没必要。
    if (mtimeMs !== activitySentMtime) data = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8'));
  } catch {
    // 文件不存在 = 互动监测关着（或还没采到）；只在从有到无时推一次 null，把旧内容清掉。
    mtimeMs = null;
  }
  if (mtimeMs === activitySentMtime) return;
  activitySentMtime = mtimeMs;
  try { win.webContents.send('orb:activity', data || null); } catch {}
}

function startActivityWatch() {
  pushActivity();
  activityTimer = setInterval(pushActivity, ACTIVITY_POLL_MS);
}

/** 渲染端读写互动监测配置：get 读当前配置+状态，set 写回插件并立刻生效。 */
ipcMain.handle('orb:activity-config', async (_event, payload = {}) => {
  const action = String(payload?.action || 'get').trim().toLowerCase();
  if (action === 'set') {
    const config = payload?.config && typeof payload.config === 'object' ? payload.config : {};
    const res = await call('/activity', { method: 'POST', body: { config }, timeoutMs: 20000 });
    // 开关一改，主进程手里的「上次推送 mtime」作废，下一次轮询立刻把新状态送下去。
    activitySentMtime = undefined;
    pushActivity();
    return res.ok ? { ok: true, ...(res.data || {}) } : res;
  }
  const res = await call('/activity', { timeoutMs: 8000 });
  return res.ok ? { ok: true, ...(res.data || {}) } : res;
});

/** 设置页的皮肤包操作：转发给插件（列表/安装/启用/删除/导入）。 */
ipcMain.handle('orb:pet-packs', async (_event, payload = {}) => {
  const body = payload && typeof payload === 'object' ? payload : {};
  const res = await call('/pet-packs', { method: 'POST', body, timeoutMs: 180000 });
  return res.ok ? { ok: true, ...(res.data || {}) } : res;
});

/** 渲染端拿形象配置：自己是不是桌宠、素材在哪、清单长什么样。 */
ipcMain.handle('orb:petconfig', () => {
  const pet = readPet();
  // 有效身高：右键滑条的 prefs.petSize 优先，其次是插件配置里的 pet.size。
  // 渲染端以前拿「窗口高度 - 气泡带」反推，气泡一长窗口变高她就跟着变大——这里直接给死。
  const effSize = Math.min(Math.max(Math.round(Number(prefs.petSize) || Number(pet?.size) || 200), PET_MIN), PET_MAX);
  return {
    pet: pet
      ? {
        mode: pet.mode,
        size: effSize,
        dir: pet.dir,
        manifest: pet.manifest,
        singleClickOpens: Boolean(pet.singleClickOpens),
        idleMinMs: Number(pet.idleMinMs) || 0,
        idleMaxMs: Number(pet.idleMaxMs) || 0,
        // 注视 / 溜达 / 换皮：都不是必需的，缺了就当关闭。
        gaze: pet.gaze && typeof pet.gaze === 'object' ? pet.gaze : null,
        wander: pet.wander && typeof pet.wander === 'object' ? pet.wander : null,
        avatar: String(pet.avatar ?? ''),
        packId: String(pet.packId ?? ''),
        // figure 包（自绘页面）走 iframe；webm 包照旧读 manifest 播动画。
        packKind: pet.packKind === 'figure' ? 'figure' : 'webm',
        packEntry: String(pet.packEntry ?? ''),
        packEntryUrl: String(pet.packEntryUrl ?? ''),
        // 配色：tint 是选中的 id，tints 是可选列表（渲染端自己拼 CSS filter）。
        tint: String(pet.tint ?? ''),
        tints: Array.isArray(pet.tints) ? pet.tints : [],
        // 设置页点「试播」时插件往 preview.json 写一条，渲染端 4 秒一轮问一次。
        preview: readPetPreview(),
      }
      : null,
    base: baseSize(),
  };
});

/** 试播请求：<ORB_DIR>/pet/preview.json = { name, at, mirror }，渲染端靠 at 变化判断是新请求。 */
let previewCache = { at: 0, mtimeMs: 0, data: null };
function readPetPreview() {
  const file = path.join(ORB_DIR, 'pet', 'preview.json');
  try {
    const stat = fs.statSync(file);
    if (stat.mtimeMs === previewCache.mtimeMs) return previewCache.data;
    previewCache = { at: Date.now(), mtimeMs: stat.mtimeMs, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
    return previewCache.data;
  } catch {
    previewCache = { at: 0, mtimeMs: 0, data: null };
    return null;
  }
}

/**
 * 桌宠自己走两步。窗口移动只能主进程做（渲染端拿不到真实的屏幕坐标系），
 * 所以这边负责夹到屏幕内 + 平滑动画，返回 clamped 让她知道「撞墙了，掉头吧」。
 */
ipcMain.handle('orb:pet-move', async (_event, payload = {}) => {
  if (!win || win.isDestroyed()) return { ok: false, clamped: false };
  const dx = Math.round(Number(payload.dx) || 0);
  const dy = Math.round(Number(payload.dy) || 0);
  if (!dx && !dy) return { ok: true, clamped: false };
  const ms = Math.max(0, Math.min(20000, Math.round(Number(payload.ms) || 0)));
  const bounds = win.getBounds();
  const want = { x: bounds.x + dx, y: bounds.y + dy, width: bounds.width, height: bounds.height };
  // applyBounds 已经按 clampForMode 夹过了：拿它跟请求值比，就知道有没有被墙挡住。
  const next = applyBounds(want, ms > 0 ? 'pet-walk' : 'pet-move');
  if (!next) return { ok: false, clamped: false };
  const clamped = next.x !== want.x || next.y !== want.y;
  if (ms > 0) await animateTo(next, { duration: ms, reason: 'pet-walk' });
  else win.setBounds(next);
  rememberBall();
  return { ok: true, clamped, ...next };
});

/** 鼠标在哪：宠物窗口是全透明覆盖层，渲染端的 mousemove 不可靠，注视只能问主进程。 */
ipcMain.handle('orb:cursor', () => {
  try { return screen.getCursorScreenPoint(); } catch { return null; }
});

// 鼠标穿透：桌宠窗口是个「宠物 + 头顶气泡带」的矩形，透明的地方照样吃点击，
// 主人的最小化按钮被她挡着点不到（2026-11-01）。
// 渲染端收不到穿透后的 mousemove（Windows 上 forward:true 不可靠），所以改由主进程轮询光标：
// 只有光标真的落在宠物实体（或显示中的气泡带）上时才把点击权收回来，其余时刻一律穿透。
let clickThrough = false;
let clickThroughTimer = null;
let bubbleShown = false;
let uiHold = false;
// 「她正被拖着」：渲染端按下时钉住，松手才解。
// 拖的时候窗口跟着指针走，指针很容易落在身体矩形之外；穿透轮询一旦把窗口切成穿透，
// mouseup 就送不到渲染进程 → petDrag 残留 → 之后鼠标在哪儿她都被当成拖动（主人报的老 bug）。
let dragPinned = false;
let dragPinnedAt = 0;
const DRAG_PIN_TTL_MS = 15000;

function setClickThrough(flag) {
  if (!win || win.isDestroyed()) return;
  if (clickThrough === flag) return;
  clickThrough = flag;
  try { win.setIgnoreMouseEvents(flag, { forward: true }); }
  catch (error) { log('[orb] 鼠标穿透切换失败', String(error?.message ?? error)); }
}

/**
 * 宠物实体在窗口坐标里的矩形。
 * 必须和渲染端 `petBodyHit()` 同一套算法，否则「能看见她的地方点不到」：
 * 渲染端按 `bodyH = min(stageH - bubbleBand, size*1.22)`、`bodyW = min(stageW-24, bodyH*1.6)` 居中算，
 * 这里照抄一份（窗口被气泡撑宽后左右透明边不算她）。
 */
function bodyRectInWindow(bounds) {
  const pet = readPet();
  const wanted = Number(prefs.petSize) || Number(pet && pet.size) || 200;
  const size = Math.min(Math.max(Math.round(wanted), PET_MIN), PET_MAX);
  const stageH = Math.max(0, bounds.height - bandFor());
  const h = Math.max(48, Math.min(stageH, Math.round(size * 1.22)));
  const w = Math.max(48, Math.min(Math.max(48, bounds.width - 24), Math.round(h * 1.6)));
  return { x: Math.round((bounds.width - w) / 2), y: bounds.height - h, width: w, height: h };
}

function startClickWatch() {
  if (clickThroughTimer) return;
  clickThroughTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) { setClickThrough(false); return; }
    if (!baseSize().pet || displayMode === 'expanded') { setClickThrough(false); return; }
    if (uiHold) { setClickThrough(false); return; }
    // 拖着的时候整窗必须保持可点：宁可桌面上多挡住一块，也不能把 mouseup 吞掉
    if (dragPinned && Date.now() - dragPinnedAt < DRAG_PIN_TTL_MS) { setClickThrough(false); return; }
    if (dragPinned) dragPinned = false; // 钉子超时自愈，防止渲染端异常退出后永远不穿透
    let bounds;
    let point;
    try { bounds = win.getBounds(); point = screen.getCursorScreenPoint(); } catch { return; }
    const lx = point.x - bounds.x;
    const ly = point.y - bounds.y;
    const body = bodyRectInWindow(bounds);
    const inBody = lx >= body.x && lx <= body.x + body.width && ly >= body.y && ly <= body.y + body.height;
    // 气泡只在真的显示时才把头顶那一条也算成可点（点气泡＝开面板/收气泡），否则整条让给下面。
    const inBubbleBand = bubbleShown && ly >= 0 && ly < body.y;
    setClickThrough(!(inBody || inBubbleBand));
  }, 90);
}

function stopClickWatch() {
  if (clickThroughTimer) {
    clearInterval(clickThroughTimer);
    clickThroughTimer = null;
  }
  setClickThrough(false);
}

ipcMain.handle('orb:hit', (_event, _hit) => {
  if (!win || win.isDestroyed()) return false;
  try { win.setIgnoreMouseEvents(false); } catch (error) { log('[orb] 设置鼠标穿透失败', String(error?.message ?? error)); }
  return true;
});

// 拖动期间钉住穿透状态（渲染端 mousedown 钉住、mouseup/失焦/丢捕获解锁）
ipcMain.handle('orb:drag', (_event, flag) => {
  if (!win || win.isDestroyed()) return false;
  dragPinned = flag === true;
  dragPinnedAt = Date.now();
  if (dragPinned) {
    try { win.setIgnoreMouseEvents(false); } catch (error) { log('[orb] 拖动钉住穿透失败', String(error?.message ?? error)); }
  }
  return dragPinned;
});

// 头顶气泡显示/隐藏：只在显示时把那一截留成可点
ipcMain.handle('orb:bubble-shown', (_event, flag) => {
  bubbleShown = flag === true;
  return true;
});

// 渲染端的 HTML 覆盖层（右键菜单 / 看图 / 提示条）打开时，整窗都要能点
ipcMain.handle('orb:ui-hold', (_event, flag) => {
  uiHold = flag === true;
  return true;
});

// 右键菜单现在由渲染端画成 HTML（原生菜单放不下滑条，而且一弹就是系统样式）。
// 这个 handler 只留兜底：渲染端要什么就发事件，主进程不再自己 popup。
ipcMain.handle('orb:menu', () => {
  if (!win || win.isDestroyed()) return false;
  try { win.webContents.send('orb:menurequest'); } catch {}
  return true;
});

ipcMain.handle('orb:http', async (_event, payload = {}) => {  const apiPath = String(payload.path || '/state');
  // 只允许相对路径，避免渲染进程把令牌带去别的主机。
  if (!apiPath.startsWith('/')) return { ok: false, error: '非法路径' };
  return call(apiPath, {
    method: payload.method === 'POST' ? 'POST' : 'GET',
    body: payload.body ?? null,
    timeoutMs: Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : 60000,
  });
});

ipcMain.handle('orb:pick-files', async (_event, payload = {}) => {
  try {
    // 桌宠右键「导入皮肤文件夹…」要选目录：允许渲染端要 openDirectory。
    const wantDir = payload?.directory === true;
    const result = await dialog.showOpenDialog(win, {
      title: wantDir ? '选择桌宠皮肤文件夹（里面有 pack.json 或 webm/）' : '选择要发给她的图片或文件',
      properties: wantDir ? ['openDirectory'] : ['openFile', 'multiSelections'],
      filters: wantDir ? undefined : [{ name: '所有文件', extensions: ['*'] }],
    });
    if (result.canceled || !Array.isArray(result.filePaths)) return { ok: true, files: [] };
    if (wantDir) {
      const dir = result.filePaths[0] || '';
      return { ok: true, files: dir ? [{ path: dir, name: path.basename(dir), size: 0, directory: true }] : [] };
    }
    const files = [];
    for (const file of result.filePaths.slice(0, 6)) {
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        files.push({ path: file, name: path.basename(file), size: stat.size });
      } catch {}
    }
    return { ok: true, files };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
});

/** 在资源管理器里打开一个目录（桌宠右键「打开皮肤文件夹」）。 */
ipcMain.handle('orb:open-path', async (_event, target = '') => {
  try {
    const dir = String(target ?? '').trim();
    if (!dir) return { ok: false, error: '没有路径' };
    if (!fs.existsSync(dir)) return { ok: false, error: '目录不存在' };
    const error = await shell.openPath(dir);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
});

ipcMain.handle('orb:expand', async (_event, on) => {
  const result = await setExpanded(on);
  return { ok: true, expanded: result };
});

/** 老的「滚轮缩放球」通道：球已经没了（0.12.21），留着这个 handler 只为兼容旧渲染端，不再改尺寸。 */
ipcMain.handle('orb:resize', () => ({ ok: true, size: baseSize().width, removed: true }));

ipcMain.handle('orb:prefs', () => ({ ...prefs, expanded, ball: ballRect, bubbleBand: bandFor(), bubbleWidth: baseSize().width }));

/**
 * 头顶气泡占的地方：传 { band, width }（老调用 bubbleSpace(110) 也认）。
 * band 让窗口往上长（脚底不动），width 让窗口左右变宽（**宠物水平中心不动**，
 * 所以视觉上她不会跟着窗口挪）。传 { band: 0, width: 0 } 复位成最小尺寸。
 */
ipcMain.handle('orb:bubble-space', (_event, payload = {}) => {
  const empty = { ok: false, band: bandFor(), width: baseSize().width };
  if (!win || win.isDestroyed()) return empty;
  const pet = readPet();
  // figure（网页形象）包没有 manifest，但它同样有头顶气泡 —— 别因为没 manifest 就拒绝申请。
  const figurePack = String(pet?.packKind || '') === 'figure';
  if (!pet || pet.mode !== 'pet' || (!pet.manifest && !figurePack)) return empty;
  if (displayMode === 'expanded') return empty;
  const cur = win.getBounds();
  const area = screen.getDisplayNearestPoint(cur).workArea;
  const size = Math.min(Math.max(Math.round(Number(prefs.petSize) || Number(pet.size) || 200), PET_MIN), PET_MAX);
  const maxBand = Math.max(PET_BUBBLE_SPACE, Math.min(600, Math.round(area.height - size - 80)));
  const want = payload && typeof payload === 'object' ? payload : { band: Number(payload) || 0 };
  const wantBand = Math.round(Number(want.band ?? want.px) || 0);
  const nextBand = wantBand <= 0 ? PET_BUBBLE_SPACE : Math.min(maxBand, Math.max(PET_BUBBLE_SPACE, wantBand));
  const wantedWidth = Math.round(Number(want.width) || 0);
  const nextWidth = wantedWidth <= 0
    ? size + PET_SIDE_SPACE
    : Math.min(Math.max(wantedWidth, size + PET_SIDE_SPACE), Math.min(PET_BUBBLE_MAX_W, Math.max(size + PET_SIDE_SPACE, area.width - 24)));

  bubbleBand = nextBand === PET_BUBBLE_SPACE ? 0 : nextBand;
  bubbleWidth = nextWidth <= size + PET_SIDE_SPACE ? 0 : nextWidth;
  let next = baseSize();
  const cx = cur.x + cur.width / 2;
  const bottom = cur.y + cur.height;

  // 气泡收起（band/width 传 0）：把「下让」的那一截还回去。
  // 只有窗口还停在当初让下去的位置才认——中间被拖过就别动她。
  if (wantBand <= 0) {
    const near = bubbleShiftApplied > 0 && Math.abs(bottom - (bubbleOriginBottom + bubbleShiftApplied)) <= 12;
    const targetBottom = near ? bubbleOriginBottom : bottom;
    bubbleOriginBottom = 0;
    bubbleShiftApplied = 0;
    const x0 = Math.round(cx - next.width / 2);
    const y0 = Math.round(targetBottom - next.height);
    const final0 = applyBounds({ x: x0, y: y0, width: next.width, height: next.height }, 'bubble-space');
    return { ok: true, band: bandFor(), width: next.width, bounds: final0, restored: near };
  }

  // 关键：气泡不是「想长多高就长多高」。
  // 她贴在屏幕顶上时，以前带高照长，窗口上半截直接跑到屏幕外——于是正文被屏幕边缘切掉
  // （主人 2026-11-04：「消息内文字多就会截断文字显示不全」）。
  // 现在的规则：头顶到工作区上沿就是能用的全部空间；还不够就把整个窗口往下让一截
  // （她临时下移），让完再量一次，实在放不下才让正文滚动——永远不把字切在屏幕外。
  const bodyH = Math.min(next.height, Math.max(48, Math.round(size * 1.22)));
  const roomAbove = Math.max(0, Math.round(bottom - bodyH - area.y - 4));
  const wantBandNow = Math.max(0, next.height - bodyH);
  const shiftMax = Math.max(0, Math.round(area.y + area.height - bottom - 8));
  const shift = wantBandNow > roomAbove ? Math.min(wantBandNow - roomAbove, shiftMax) : 0;
  const fitBand = Math.min(wantBandNow, roomAbove + shift);
  if (fitBand + 1 < wantBandNow) {
    bubbleBand = fitBand <= PET_BUBBLE_SPACE ? 0 : fitBand;
    next = baseSize();
  }
  const bottom2 = bottom + shift;
  if (shift > 0) {
    if (!bubbleOriginBottom) bubbleOriginBottom = bottom;
    bubbleShiftApplied = shift;
  } else if (bubbleShiftApplied > 0 && Math.abs(bottom - (bubbleOriginBottom + bubbleShiftApplied)) <= 12) {
    bubbleOriginBottom = 0;
    bubbleShiftApplied = 0;
  }
  const x = Math.round(cx - next.width / 2);
  const y = Math.round(bottom2 - next.height);
  if (x === cur.x && y === cur.y && next.width === cur.width && next.height === cur.height) {
    return { ok: true, band: bandFor(), width: next.width, unchanged: true };
  }
  const final = applyBounds({ x, y, width: next.width, height: next.height }, 'bubble-space');
  return {
    ok: true,
    band: bandFor(),
    width: next.width,
    bounds: final,
    shift,
    clipped: fitBand + 1 < wantBandNow,
  };
});

// ---- 面板边缘拖拽缩放 ----------------------------------------------------
// 无边框窗口在 Windows 上没有系统缩放边框，这里自己做一套：渲染进程在面板
// 四边/四角放 8px 的感应区，按下后把鼠标位移传过来，主进程按边算新的 bounds。
const PANEL_MIN_W = 300;
const PANEL_MIN_H = 380;
const PANEL_MAX_W = 960;
const PANEL_MAX_H = 1000;
let dragResize = null;

ipcMain.handle('orb:panel-resize-start', (_event, edge) => {
  if (!win || win.isDestroyed() || !expanded || displayMode !== 'expanded') return { ok: false };
  dragResize = { edge: String(edge || ''), bounds: { ...win.getBounds() } };
  return { ok: true, bounds: dragResize.bounds };
});

ipcMain.handle('orb:panel-resize-move', (_event, delta = {}) => {
  if (!win || win.isDestroyed() || !dragResize) return { ok: false };
  const b = dragResize.bounds;
  const edge = dragResize.edge;
  const dx = Math.round(Number(delta.dx) || 0);
  const dy = Math.round(Number(delta.dy) || 0);
  let x = b.x;
  let y = b.y;
  let width = b.width;
  let height = b.height;
  if (edge.includes('w')) {
    width = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, b.width - dx));
    x = b.x + (b.width - width);
  }
  if (edge.includes('e')) {
    width = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, b.width + dx));
  }
  if (edge.includes('n')) {
    height = Math.min(PANEL_MAX_H, Math.max(PANEL_MIN_H, b.height - dy));
    y = b.y + (b.height - height);
  }
  if (edge.includes('s')) {
    height = Math.min(PANEL_MAX_H, Math.max(PANEL_MIN_H, b.height + dy));
  }
  const area = screen.getDisplayNearestPoint({ x, y }).workArea;
  width = Math.min(width, area.width);
  height = Math.min(height, area.height);
  const pos = applyBounds({ x, y, width, height }, 'resize');
  return { ok: true, width, height, x: pos?.x ?? x, y: pos?.y ?? y };
});

ipcMain.handle('orb:panel-resize-end', () => {
  if (win && !win.isDestroyed()) {
    const cur = win.getBounds();
    writePrefs({ panelWidth: cur.width, panelHeight: cur.height });
  }
  dragResize = null;
  return { ok: true };
});

/** 渲染端松手时用真实 bounds 提交，别信 window.screenX（DPI 换算会漂）。 */
ipcMain.handle('orb:panel-pos', () => {
  if (!win || win.isDestroyed()) return { ok: false };
  const b = win.getBounds();
  return { ok: true, x: b.x, y: b.y, width: b.width, height: b.height };
});

/** 面板被人按住拖动：只在展开态生效，松手时才写预置位置。 */
ipcMain.handle('orb:panel-move', (_event, pos = {}) => {
  if (!win || win.isDestroyed() || displayMode !== 'expanded') return { ok: false };
  // 拖动只改位置，尺寸由 applyBounds 锁死在面板尺寸上；拖动同时不做边缘缩放。
  if (dragResize) return { ok: false };
  const b = win.getBounds();
  const x = Number(pos.x);
  const y = Number(pos.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
  const next = applyBounds({ x, y, width: b.width, height: b.height }, 'panel-move');
  if (pos.commit) writePrefs({ panelX: next.x, panelY: next.y });
  return { ok: true, ...(next || {}) };
});

/**
 * 右键菜单要多大，窗口就临时长多大：
 * 菜单画在窗口里，宠物 120 时窗口只有 160x230，168x176 的菜单会被裁掉。
 * 这里只往右下角长，宠物视觉位置由渲染端用 --pet-dx/--pet-dy 补回来。
 */
ipcMain.handle('orb:menurect', (_event, size = {}) => {
  if (!win || win.isDestroyed()) return { ok: false };
  const needW = Math.max(0, Math.round(Number(size.width) || 0));
  const needH = Math.max(0, Math.round(Number(size.height) || 0));
  const base = baseSize();
  if (!needW && !needH) {
    menuOpen = false;
    menuNeed = null;
    const restore = size.restore === 'expanded' || (!size.restore && expanded);
    if (restore) {
      displayMode = 'expanded';
      expanded = true;
      const back = applyBounds(expandTarget(), 'menu-close-expanded');
      return { ok: true, dx: 0, dy: 0, restore: 'expanded', ...(back || {}) };
    }
    displayMode = 'collapsed';
    expanded = false;
    const back = applyBounds({ ...(ballRect || win.getBounds()), width: base.width, height: base.height }, 'menu-close');
    return { ok: true, dx: 0, dy: 0, restore: 'collapsed', ...(back || {}) };
  }
  const cur = win.getBounds();
  const area = screen.getDisplayMatching(cur).workArea;
  const width = Math.min(Math.max(base.width, needW + 8), Math.max(base.width, area.width - 8));
  const height = Math.min(Math.max(base.height, needH + 8), Math.max(base.height, area.height - 8));
  menuNeed = { width, height };
  menuOpen = true;
  menuRestore = expanded ? 'expanded' : 'collapsed';
  // 先按新尺寸把窗口夹进工作区；窗口可能因此左移/上移，dx/dy 用来把宠物和菜单的视觉位置补回来。
  const x = Math.max(area.x, Math.min(cur.x, area.x + area.width - width - 8));
  const y = Math.max(area.y, Math.min(cur.y, area.y + area.height - height - 8));
  const next = applyBounds({ x, y, width, height }, 'menu-open');
  const nx = next?.x ?? x;
  const ny = next?.y ?? y;
  const growX = (next?.width ?? width) - cur.width;
  const growY = (next?.height ?? height) - cur.height;
  return {
    ok: true,
    dx: Math.round((cur.x - nx) - growX / 2),
    dy: Math.round((cur.y - ny) - growY),
    restore: menuRestore,
    ...(next || {}),
  };
});
ipcMain.handle('orb:move', (_event, pos = {}) => {
  if (!win || win.isDestroyed()) return { ok: false };
  // 硬闸：只有「渲染端明确说正在拖她」时才允许按指针搬窗口。
  // 之前鼠标一靠近她就被带走，就是拖动状态残留后在随便一个 mousemove 里调了这里。
  if (!dragPinned || Date.now() - dragPinnedAt > DRAG_PIN_TTL_MS) return { ok: false, reason: 'not-dragging' };
  const bounds = win.getBounds();
  const x = Number(pos.x);
  const y = Number(pos.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
  const next = applyBounds({ x, y, width: bounds.width, height: bounds.height }, 'move');
  if (!expanded) rememberBall();
  return { ok: true, ...(next || {}) };
});

ipcMain.handle('orb:dock', () => {
  if (!win || win.isDestroyed()) return { ok: false };
  const bounds = win.getBounds();
  const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
  const distances = [
    { side: 'left', d: bounds.x - area.x },
    { side: 'right', d: area.x + area.width - (bounds.x + bounds.width) },
  ].sort((a, b) => a.d - b.d);
  // 只有真的贴着边才吸过去；丢在屏幕中间就停在中间（以前这里默认按右缘算，
  // 所以主人拖到哪松手，球都会被拽回右边的「老位置」）。
  if (distances[0].d >= 24) {
    if (!expanded) rememberBall();
    return { ok: true, docked: false };
  }
  const near = distances[0];
  // 球模式停靠 = 只留 6px 露在屏幕边（鼠标靠近再展开）；
  // 桌宠模式必须整个留在屏幕里（贴左边就贴齐左缘），否则缩进去就再也点不到了。
  // 老公式 `area.x - width + visible` 在 visible=0 时等于 -width，左边一贴就被吸出屏幕外
  // ——主人 2026-11-01 报的「在左边贴近边界就直接吸过去」。
  const petMode = baseSize().pet;
  const x = petMode
    ? (near.side === 'left' ? area.x : area.x + area.width - bounds.width)
    : (near.side === 'left' ? area.x - bounds.width + 6 : area.x + area.width - bounds.width + 6);
  // y 不要在这里按工作区上沿夹：桌宠允许头顶气泡带出屏，交给 applyBounds → clampForMode 统一夹
  // （以前这里 Math.max(bounds.y, area.y) 把拖到上面的她一把拽回 y=0，主人 2026-11-01 报的「拖不上去」）。
  applyBounds({ x, y: bounds.y, width: bounds.width, height: bounds.height }, 'dock');
  if (!expanded) rememberBall();
  return { ok: true, side: near.side };
});

// ---- 右键：桌宠大小 ------------------------------------------------------
// 主人的要求：左键只负责拖动，改大小走右键弹出的小面板 + 滑条。
const SIZE_PANEL_W = 360;
const SIZE_PANEL_H = 250;
let sizePanel = null;

ipcMain.handle('orb:petsize', (_event, payload = {}) => {
  const size = Math.min(Math.max(Math.round(Number(payload.size) || PET_MIN), PET_MIN), PET_MAX);
  writePrefs({ petSize: size });
  if (win && !win.isDestroyed() && !expanded) {
    const base = baseSize();
    const cur = win.getBounds();
    const target = sizePanel
      ? { x: sizePanel.bounds.x + (sizePanel.bounds.width - SIZE_PANEL_W), y: sizePanel.bounds.y }
      : { x: cur.x + (cur.width - base.width), y: cur.y };
    if (sizePanel) {
      // 面板开着的时候窗口保持面板尺寸，只更新「关掉之后回到多大」
      return { ok: true, size, base };
    }
    animateTo({ ...target, width: base.width, height: base.height }, { duration: 90 });
  }
  return { ok: true, size, base: baseSize() };
});

// 旧版「撑成 360×250 面板」的接口已经废弃：菜单改成窗口内绘制，任何调用都不许改窗口尺寸。
ipcMain.handle('orb:sizepanel', () => {
  log('[orb] 忽略已废弃的 orb:sizepanel（菜单已改成窗口内 HTML）');
  return { ok: true, open: false, deprecated: true, size: baseSize().pet ? prefs.petSize : null };
});

ipcMain.handle('orb:hide', () => hideWindow());
ipcMain.handle('orb:show', () => showWindow());
ipcMain.handle('orb:toggle-hidden', () => toggleWindow());
ipcMain.handle('orb:is-hidden', () => Boolean(!win || win.isDestroyed() || !win.isVisible()));

// ── 陪伴字幕窗 ─────────────────────────────────────────────────────────────
ipcMain.handle('companion:reply', async (_event, payload = {}) => {
  const result = await call('/companion', { method: 'POST', body: { action: 'reply', text: String(payload.text || '') } });
  const state = result?.data?.status || null;
  if (state) {
    lastCompanionState = { ...state, active: true };
    sendCompanionState(lastCompanionState);
  }
  return result;
});

ipcMain.handle('companion:status', async () => {
  const result = await call('/companion', { timeoutMs: 8000 });
  return result?.data || result;
});

ipcMain.handle('companion:toggle', async (_event, payload = {}) => {
  const active = payload.active === true;
  const result = await call('/companion', {
    method: 'POST',
    body: active ? { action: 'stop' } : { action: 'start', sessionId: String(payload.sessionId || '') },
    timeoutMs: 20000,
  });
  const state = result?.data?.companion || result?.data?.status || null;
  if (state) {
    lastCompanionState = state;
    sendCompanionState(state);
  }
  return result;
});

ipcMain.handle('companion:config', async (_event, patch = {}) => {
  const result = await call('/companion', { method: 'POST', body: { action: 'config', patch }, timeoutMs: 10000 });
  const data = result?.data || result;
  const state = data?.companion || data?.status || null;
  if (state) {
    lastCompanionState = state;
    sendCompanionState(state);
  }
  return data;
});

// 拖动交给主进程按鼠标真实坐标算，渲染端只负责按下/松开；这样没有 DPI 漂移，
// 也不会出现「拖一下又弹回原位」。
ipcMain.handle('companion:drag-start', () => {
  if (!companionWin || companionWin.isDestroyed()) return null;
  if (companionDrag) clearInterval(companionDrag.timer);
  const bounds = companionWin.getBounds();
  companionDrag = {
    cursor: screen.getCursorScreenPoint(),
    bounds,
    timer: setInterval(() => {
      if (!companionWin || companionWin.isDestroyed()) return;
      const p = screen.getCursorScreenPoint();
      const area = screen.getDisplayNearestPoint(p).workArea;
      const x = Math.min(Math.max(companionDrag.bounds.x + (p.x - companionDrag.cursor.x), area.x - companionDrag.bounds.width + 80), area.x + area.width - 80);
      const y = Math.min(Math.max(companionDrag.bounds.y + (p.y - companionDrag.cursor.y), area.y), area.y + area.height - 40);
      companionWin.setBounds({ x, y, width: companionDrag.bounds.width, height: companionDrag.bounds.height });
    }, 16),
  };
  return bounds;
});

ipcMain.handle('companion:drag-end', () => {
  if (companionDrag) {
    clearInterval(companionDrag.timer);
    companionDrag = null;
  }
  if (!companionWin || companionWin.isDestroyed()) return null;
  const b = companionWin.getBounds();
  writePrefs({ companion: { ...(prefs.companion || {}), x: b.x, y: b.y, width: b.width, fontPx: (prefs.companion || {}).fontPx || 22 } });
  return b;
});

// 字号只存 pref，由渲染端量完内容再调 height；避免每滚一格都改窗口高度。
ipcMain.handle('companion:font', (_event, payload = {}) => {
  const fontPx = Math.min(Math.max(Math.round(Number(payload.fontPx) || 22), 14), 40);
  writePrefs({ companion: { ...(prefs.companion || {}), fontPx } });
  return { ok: true, fontPx };
});

function saveCompanionRect() {
  if (!companionWin || companionWin.isDestroyed()) return;
  const b = companionWin.getBounds();
  writePrefs({ companion: { ...(prefs.companion || {}), x: b.x, y: b.y, width: b.width, fontPx: (prefs.companion || {}).fontPx || 22 } });
}

// 高度以底边为锚点，但只在越界时向上让位，绝不下移。
// 旧实现把 y 往下夹到 area.bottom-40，内容变矮时会一路往下沉，这是漂移的根因。
ipcMain.handle('companion:height', (_event, payload = {}) => {
  if (!companionWin || companionWin.isDestroyed()) return null;
  const b = companionWin.getBounds();
  const area = screen.getDisplayNearestPoint({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) }).workArea;
  // 8px 网格 + 12px 死区：渲染端按 ResizeObserver 量出来的高度经常只差 1~3px，
  // 每次都真改窗口会让可见区上下抖；高度不变时直接回原 bounds，什么都不做。
  const height = snapCompanionHeight(Number(payload.height) || b.height, b.height);
  if (height === null) return b;
  const next = anchorCompanionBottom(b, height, area);
  if (next.y === b.y && next.height === b.height) return b;
  companionWin.setBounds(next);
  // 拖动中高度变了：把拖动基准一起挪过去。否则 16ms 后的拖动循环还会按旧 y/height 重算，
  // 窗口被拉回去 → 松开前「字幕条一跳一跳」。
  if (companionDrag) {
    companionDrag.bounds = { ...companionDrag.bounds, y: next.y, height: next.height };
    companionDrag.cursor = screen.getCursorScreenPoint();
  }
  return companionWin.getBounds();
});

// 宽度只向右长；到屏幕右边就整体左移，保持右边缘可见。
ipcMain.handle('companion:width', (_event, payload = {}) => {
  if (!companionWin || companionWin.isDestroyed()) return null;
  const b = companionWin.getBounds();
  const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const width = Math.min(Math.max(Math.round(Number(payload.width) || b.width), 520), companionMaxWidth(area.width));
  let x = b.x;
  if (x + width > area.x + area.width - 8) x = Math.max(area.x + 8, area.x + area.width - 8 - width);
  companionWin.setBounds({ x, y: b.y, width, height: b.height });
  // 拖动过程中先更新内存，避免下一次 state 同步把宽度打回旧值；落盘在 pointerup。
  prefs = { ...prefs, companion: { ...(prefs.companion || {}), x, y: b.y, width } };
  return companionWin.getBounds();
});

// 拖拽/拖宽结束时统一落盘，并同步服务端宽度，避免下次轮询被旧 state 打回去。
ipcMain.handle('companion:save', async () => {
  if (!companionWin || companionWin.isDestroyed()) return null;
  const b = companionWin.getBounds();
  saveCompanionRect();
  try {
    await call('/companion', { method: 'POST', body: { action: 'config', patch: { width: b.width } }, timeoutMs: 8000 });
  } catch {}
  return b;
});

ipcMain.handle('orb:quit', () => {
  log('[orb] 用户从菜单退出');
  app.quit();
});

ipcMain.handle('orb:log', (_event, text) => {
  log('[renderer]', String(text ?? '').slice(0, 400));
  return { ok: true };
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (activityTimer) clearInterval(activityTimer);
  stopClickWatch();
  try { globalShortcut.unregisterAll(); } catch {}
  try { tray?.destroy(); } catch {}
  tray = null;
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log('[orb] 已有实例在跑，退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户主动隐藏时，不要因为他又双击了一次图标就把桌宠拉出来；显示只由托盘/快捷键触发。
    if (!hiddenByUser) showWindow();
  });
  app.whenReady().then(() => {
    log('[orb] 启动', app.getVersion(), `pid=${process.pid}`, `dir=${ORB_DIR}`);
    createWindow();
    createTray();
    try {
      const ok = globalShortcut.register(WAKE_ACCELERATOR, () => { void toggleWindow(); });
      log(ok ? `[orb] 唤醒快捷键已注册 ${WAKE_ACCELERATOR}` : `[orb] 唤醒快捷键注册失败 ${WAKE_ACCELERATOR}`);
    } catch (error) {
      log('[orb] 唤醒快捷键注册异常', String(error?.message ?? error));
    }
    // 桌宠模式下窗口大部分是透明的，默认把鼠标事件让给下面：只有渲染端报告
    // 「鼠标在宠物身上」时才收回点击权（否则会挡住桌面上其它窗口的点击）。
    // 桌宠模式的窗口是「宠物 + 头顶气泡带」的矩形，保持可点击：
    // Windows 上 setIgnoreMouseEvents(true,{forward:true}) 并不总把 move 事件转给渲染进程，
    // 一旦收不到 move 就没法判断鼠标是否在宠物身上，单击/双击会整块失灵（踩过）。
    // 先保证「点得到」，透明带的穿透留到以后用更精细的区域方案再说。
    if (win) {
      try { win.setIgnoreMouseEvents(false); } catch (error) { log('[orb] 鼠标穿透设置失败', String(error?.message ?? error)); }
      startClickWatch();
    }
    startPolling();
    startActivityWatch();
  });
}
