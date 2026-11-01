/**
 * SurfCore · 悬浮窗（Orb）的宿主管理
 *
 * 和「桌宠」的区别（别混）：
 *   · 桌宠是从网上下载的 zip 安装包，appDir 由用户填；悬浮窗的 app 是**插件自带的**
 *     （plugins/surfcore/assets/orb-app），安装 = 复制到 <stateDir>/orb/app，不联网；
 *   · 桌宠的窗口长什么样由那个安装包决定；悬浮球是我们自己写的 Electron 小应用。
 *
 * 但**运行时**是共用的：同一套 Electron 解析与下载逻辑（pet.js 导出的
 * detectElectronPath / installElectronRuntime / ELECTRON_VERSION），本机已经给桌宠
 * 下过一次的话，悬浮窗直接复用，不再下一遍。
 *
 * 为什么 Electron 而不是「DSH 里开个窗口」：悬浮球要无边框、透明、始终置顶、
 * 不进任务栏，这些只有独立的 BrowserWindow 能做（对齐 dsh-orb 的做法）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkAppDir, detectElectronPath, installElectronRuntime, ELECTRON_VERSION,
} from './pet.js';
import { readUnified, saveUnified } from './store.js';
import { createPetAssetsService } from './pet-assets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 随插件发布的悬浮窗应用源码目录。 */
export const ORB_APP_SOURCE = path.join(__dirname, '..', 'assets', 'orb-app');
/** 安装标记：确认某个目录确实是「我们的」悬浮窗，而不是用户别的东西。 */
export const ORB_MARKER = '.surfcore-orb.json';
const MESSAGE_LIMIT = 120;

export const DEFAULT_ORB = {
  // 默认关闭：悬浮窗会一直在屏幕上，得主人自己点开。
  enabled: false,
  ball: {
    // 形象：pet = dsh-pet 的小鲸鱼桌宠（默认），ball = 原来那颗球。素材没装会自动回落 ball。
    mode: 'pet',
    size: 64,
    petSize: 200,
    opacity: 0.92,
    dock: 'right',
    panelWidth: 320,
    theme: 'auto',
    avatar: '',
  },
  chat: {
    enabled: true,
    bubbleTtlSec: 8,
    maxBubbles: 3,
    maxPerTurn: 2,
    // 气泡图文一体：同一条消息的图和字画在一个气泡里（图在上、字在下）。
    // 关掉就拆成「图气泡 + 文字气泡」，跟以前一样。
    richBubble: true,
    // 气泡上要不要显示头像/名字。默认显示——主人要求「像 QQ 那样一人一排」。
    ident: {
      showAvatar: true,
      showName: true,
      herName: '',
      meName: '',
      herQQ: '',
      meQQ: '',
      herPath: '',
      mePath: '',
    },
  },
  pet: {
    // 单击默认只播「被摸一下」的反应，双击才开会话；想回到单击开会话就打开这个。
    singleClickOpens: false,
    // 空闲时随机动作的间隔上下限（毫秒），0 = 只播待机
    idleMinMs: 6000,
    idleMaxMs: 16000,
  },
  screen: {
    // 看屏幕三档：off 关 / manual 只有主人点「眼」那一下 / auto 她想看就看。
    // 兼容旧字段 enabled：enabled === false 时视为 off（normalizeOrbConfig 里处理）。
    mode: 'manual',
    // 「让她看见」总开关。隐私铁律：截图只留在本机，只用于她自己判断。
    enabled: false,
    // 打开之后，每次在悬浮窗里说话都顺手拍一张给她看（不然她只能靠窗口标题猜）。
    // 默认每条消息都拍一张太吵，也用不上；要看屏幕就点面板上的眼睛按钮。
    attachToChat: false,
    // 看完就删：截图是主人的桌面，不该在盘上留档。
    deleteAfterRead: true,
    maxPerHour: 6,
    denyTitles: [
      '密码', 'password', '银行', '网银', '支付', '身份证', '密钥', 'token',
      '1Password', 'Bitwarden', 'KeePass', '微信支付', '支付宝',
    ],
  },
  // 悬浮窗会话里发图（跟 QQ 那边的 socialV2.pic 完全是两套开关）。
  pic: {
    // 默认关：打开后她才能在悬浮窗里发表情包/图片。
    enabled: false,
    // 三来源优先级：QQ 收藏表情 → 本地图库 → 现场生图（交给 agent 去生成）。
    preferQqSticker: true,
    allowLocal: true,
    allowGenerate: true,
    // 聊天里也能配图：她的聊天回复可以带一张图（只吃 QQ 表情/本地图库，不现场生图）。
    attachToChat: false,
    maxPerHour: 12,
  },
};

function clampNum(value, fallback, min, max, { integer = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.min(max, Math.max(min, n));
  return integer ? Math.round(v) : v;
}

function strList(value, fallback) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\n,，;；]+/);
  const out = [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))];
  return out.length ? out : fallback;
}

/** 配置归一化：越界钳制 + 缺省补齐。纯函数，单测直接打。 */
export function normalizeOrbConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const ball = src.ball && typeof src.ball === 'object' ? src.ball : {};
  const chat = src.chat && typeof src.chat === 'object' ? src.chat : {};
  const screen = src.screen && typeof src.screen === 'object' ? src.screen : {};
  const pic = src.pic && typeof src.pic === 'object' ? src.pic : {};
  return {
    enabled: src.enabled === true,
    ball: {
      mode: ball.mode === 'ball' ? 'ball' : 'pet',
      size: clampNum(ball.size, DEFAULT_ORB.ball.size, 44, 96, { integer: true }),
      petSize: clampNum(ball.petSize, DEFAULT_ORB.ball.petSize, 120, 320, { integer: true }),
      opacity: clampNum(ball.opacity, DEFAULT_ORB.ball.opacity, 0.4, 1),
      dock: ball.dock === 'left' ? 'left' : 'right',
      panelWidth: clampNum(ball.panelWidth, DEFAULT_ORB.ball.panelWidth, 260, 420, { integer: true }),
      theme: ['auto', 'light', 'dark'].includes(ball.theme) ? ball.theme : 'auto',
      avatar: String(ball.avatar ?? '').slice(0, 260),
    },
    pet: (() => {
      const min = clampNum(src.pet?.idleMinMs, DEFAULT_ORB.pet.idleMinMs, 0, 120000, { integer: true });
      // max 永远不小于 min：填反了会让随机间隔算出负数，桌宠就一直在抽风。
      const max = Math.max(min, clampNum(src.pet?.idleMaxMs, DEFAULT_ORB.pet.idleMaxMs, 0, 300000, { integer: true }));
      return {
        singleClickOpens: (src.pet && typeof src.pet === 'object' ? src.pet.singleClickOpens : false) === true,
        idleMinMs: min,
        idleMaxMs: max,
      };
    })(),
    chat: {
      enabled: chat.enabled !== false,
      bubbleTtlSec: clampNum(chat.bubbleTtlSec, DEFAULT_ORB.chat.bubbleTtlSec, 3, 30, { integer: true }),
      maxBubbles: clampNum(chat.maxBubbles, DEFAULT_ORB.chat.maxBubbles, 1, 5, { integer: true }),
      maxPerTurn: clampNum(chat.maxPerTurn, DEFAULT_ORB.chat.maxPerTurn, 1, 5, { integer: true }),
      richBubble: chat.richBubble !== false,
      ident: {
        showAvatar: chat.ident?.showAvatar !== false,
        showName: chat.ident?.showName !== false,
        herName: String(chat.ident?.herName ?? '').slice(0, 24),
        meName: String(chat.ident?.meName ?? '').slice(0, 24),
        herQQ: String(chat.ident?.herQQ ?? '').replace(/[^0-9]/g, '').slice(0, 12),
        meQQ: String(chat.ident?.meQQ ?? '').replace(/[^0-9]/g, '').slice(0, 12),
        herPath: String(chat.ident?.herPath ?? '').slice(0, 260),
        mePath: String(chat.ident?.mePath ?? '').slice(0, 260),
      },
    },
    screen: {
      // 兼容：老配置只有 enabled。enabled=false → off；enabled=true 且没写 mode → manual。
      mode: (() => {
        if (screen.mode === 'off' || screen.mode === 'manual' || screen.mode === 'auto') return screen.mode;
        if (screen.enabled === false) return 'off';
        if (screen.enabled === true) return 'manual';
        return DEFAULT_ORB.screen.mode;
      })(),
      // enabled 仍然代表「总开关」，由 mode 推出来：off 就是关，其余都是开。
      enabled: (() => {
        if (screen.mode === 'off') return false;
        if (screen.mode === 'manual' || screen.mode === 'auto') return true;
        return screen.enabled === true;
      })(),
      attachToChat: screen.attachToChat === true,
      deleteAfterRead: screen.deleteAfterRead !== false,
      maxPerHour: clampNum(screen.maxPerHour, DEFAULT_ORB.screen.maxPerHour, 0, 60, { integer: true }),
      denyTitles: strList(screen.denyTitles, DEFAULT_ORB.screen.denyTitles),
    },
    pic: {
      enabled: pic.enabled === true,
      preferQqSticker: pic.preferQqSticker !== false,
      allowLocal: pic.allowLocal !== false,
      allowGenerate: pic.allowGenerate !== false,
      attachToChat: pic.attachToChat === true,
      maxPerHour: clampNum(pic.maxPerHour, DEFAULT_ORB.pic.maxPerHour, 0, 200, { integer: true }),
    },
  };
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function createOrbService({ stateDir, pluginLog = () => {}, getSubprocess = () => null, appSource = ORB_APP_SOURCE, petAssets = null } = {}) {
  const root = path.join(stateDir, 'orb');
  const appDir = path.join(root, 'app');
  const pidFile = path.join(root, 'run.pid');
  const logFile = path.join(root, 'start.log');
  const stateFile = path.join(root, 'state.json');
  const markerFile = path.join(appDir, ORB_MARKER);
  const pets = petAssets || createPetAssetsService({ stateDir, pluginLog });

  fs.mkdirSync(root, { recursive: true });

  /** 形象是球还是桌宠——素材没装就回落球，别让用户对着空白窗口。 */
  function petInfo() {
    const cfg = readConfig();
    const assets = pets.status();
    const wantPet = cfg.ball.mode === 'pet';
    return {
      mode: wantPet && assets.installed ? 'pet' : 'ball',
      wantMode: cfg.ball.mode,
      size: cfg.ball.petSize,
      singleClickOpens: cfg.pet.singleClickOpens,
      idleMinMs: cfg.pet.idleMinMs,
      idleMaxMs: cfg.pet.idleMaxMs,
      dir: pets.dir,
      manifest: wantPet && assets.installed ? pets.manifest() : null,
      assets,
      fallbackReason: wantPet && !assets.installed ? '桌宠素材没装（设置 → 悬浮窗 → 桌宠素材 → 下载）' : '',
    };
  }

  // ── 配置（真身是 unified config 的 orb 段）─────────────────────────────
  function readConfig() {
    let raw = null;
    try { raw = readUnified().config?.orb ?? null; } catch (error) {
      pluginLog('[orb] 读配置失败：', String(error?.message ?? error));
    }
    return normalizeOrbConfig(raw);
  }

  function writeConfig(next) {
    const normalized = normalizeOrbConfig(next);
    const current = readUnified();
    const config = { ...(current.config || {}), orb: normalized };
    saveUnified(config);
    return normalized;
  }

  // ── 消息（悬浮球上显示的那一列）────────────────────────────────────────
  function readState() {
    try {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        return {
          seq: Number(data.seq) || 0,
          messages: Array.isArray(data.messages) ? data.messages : [],
          seenId: Number(data.seenId) || 0,
        };
      }
    } catch {}
    return { seq: 0, messages: [], seenId: 0 };
  }

  function writeState(state) {
    try {
      const tmp = `${stateFile}.${process.pid}.tmp`;
      const body = {
        seq: Number(state?.seq) || 0,
        messages: Array.isArray(state?.messages) ? state.messages : [],
        seenId: Number(state?.seenId) || 0,
      };
      fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, stateFile);
    } catch (error) {
      pluginLog('[orb] 写 state.json 失败：', String(error?.message ?? error));
    }
  }

  /** 已读水位：面板里看到第几条，就记到第几条（跨重启不丢）。 */
  function readSeenId() {
    return readState().seenId;
  }

  function markSeen(id) {
    const state = readState();
    const want = Number(id) || 0;
    if (!want) return state.seenId;
    // 水位只进不退；也不能超过当前最大消息号（客户端可能是旧状态）。
    const next = Math.min(Math.max(state.seenId, want), Math.max(state.seq, state.seenId));
    if (next !== state.seenId) writeState({ ...state, seenId: next });
    return next;
  }

  /** 会话气泡里允许带的图片目录：<orb>/media 与「本地图库」里配的目录。 */
  function picFileAllowed(file) {
    const target = String(file || '').trim();
    if (!target || !fs.existsSync(target)) return false;
    // 只认 <orb>/media：外部图（QQ 表情 / 本地图库 / 生图）由 orb-api 先拷进来再入会话，
    // 这样会话记录里永远不会出现主人自己目录下的任意路径。
    const base = path.resolve(path.join(root, 'media'));
    const abs = path.resolve(target);
    return abs.startsWith(base + path.sep);
  }

  function addMessage({ who = 'her', text = '', kind = 'chat', at = Date.now(), image = '' } = {}) {
    const clean = String(text ?? '').trim();
    const pic = picFileAllowed(image) ? path.resolve(String(image)) : '';
    // 只有图没有字是合法的（发表情包的时候）。
    if (!clean && !pic) return null;
    const state = readState();
    const seq = state.seq + 1;
    const message = {
      id: seq,
      who: who === 'me' ? 'me' : 'her',
      text: clean.slice(0, 4000),
      kind: ['proactive', 'reply', 'chat', 'system', 'pic'].includes(kind) ? kind : 'chat',
      at: Number(at) || Date.now(),
      ...(pic ? { image: pic } : {}),
    };
    const messages = [...state.messages, message].slice(-MESSAGE_LIMIT);
    writeState({ seq, messages, seenId: state.seenId });
    return message;
  }

  function listMessages(limit = 40) {
    const state = readState();
    const n = clampNum(limit, 40, 1, MESSAGE_LIMIT, { integer: true });
    return { seq: state.seq, messages: state.messages.slice(-n) };
  }

  function clearMessages() {
    // 「新对话」= 消息清空、已读水位也归零，否则下一条新消息会被当成「已经读过」而不冒气泡。
    writeState({ seq: readState().seq, messages: [], seenId: 0 });
    return { ok: true };
  }

  // ── 安装 / 启动 / 停止 ────────────────────────────────────────────────
  function appVersion() {
    try { return String(JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version || ''); } catch { return ''; }
  }

  function sourceVersion() {
    try { return String(JSON.parse(fs.readFileSync(path.join(appSource, 'package.json'), 'utf8')).version || ''); } catch { return ''; }
  }

  function installed() {
    try { return fs.existsSync(markerFile) && fs.existsSync(path.join(appDir, 'main.js')); } catch { return false; }
  }

  function runningPid() {
    try {
      const pid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
      if (pid && pidAlive(pid)) return pid;
    } catch {}
    return 0;
  }

  function running() {
    return runningPid() > 0;
  }

  function status() {
    const cfg = readConfig();
    const electron = detectElectronPath({ stateDir, appDir }) || '';
    return {
      installed: installed(),
      running: running(),
      pid: runningPid(),
      dir: root,
      appDir,
      logFile,
      version: appVersion(),
      sourceVersion: sourceVersion(),
      electronPath: electron,
      electronVersion: ELECTRON_VERSION,
      config: cfg,
      messageCount: readState().messages.length,
    };
  }

  function copyTree(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) copyTree(src, dst);
      else fs.copyFileSync(src, dst);
    }
  }

  /** 安装 = 把插件自带的 app 复制到 <stateDir>/orb/app（幂等）。 */
  async function install({ force = false } = {}) {
    if (!fs.existsSync(appSource)) return { ok: false, error: `插件里找不到悬浮窗应用源码：${appSource}` };
    if (running()) await stop();
    try {
      if (installed() && !force && appVersion() === sourceVersion()) {
        return { ok: true, already: true, ...status() };
      }
      checkAppDir(appDir, { protectedPaths: [stateDir, os.homedir()], allowNonEmpty: true });
      // 覆盖安装而不是「先删再拷」：Windows 上 Electron 刚退出时目录里还留着句柄，
      // rm -r 会 EPERM（`Permission denied: ... \orb\app`），把整个安装卡死。
      // 直接逐文件覆盖即可，data/ 里的 profile 也能保住。
      copyTree(appSource, appDir);
    } catch (error) {
      if (!fs.existsSync(appDir)) throw new Error(`安装失败：${String(error?.message ?? error)}`);
      // 覆盖失败（Electron 刚退出、文件还被占着）才退回「改名让路」，
      // 而且改名本身也可能 EBUSY——退几步再试，别一次就把安装判死。
      let aside = `${appDir}.old-${Date.now()}`;
      for (let i = 0; i < 6; i += 1) {
        try { fs.renameSync(appDir, aside); break; } catch (renameError) {
          if (i === 5) throw new Error(`安装失败：目录被占用（${String(renameError?.message ?? renameError)}）`);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      copyTree(appSource, appDir);
      try { fs.rmSync(aside, { recursive: true, force: true }); } catch {}
    }
    try {
      const marker = { installedAt: new Date().toISOString(), version: sourceVersion(), source: appSource };
      fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
      pluginLog('[orb] 已安装到', appDir, 'version', sourceVersion());
      // 顺带确认 Electron 运行时（没有就让调用方去装，不在这里偷偷下 100MB）
      const electron = detectElectronPath({ stateDir, appDir });
      return { ok: true, installedNow: true, electronPath: electron || '', needElectron: !electron, ...status() };
    } catch (error) {
      return { ok: false, error: `安装失败：${String(error?.message ?? error)}` };
    }
  }

  /** 需要时下载 Electron 运行时（复用桌宠那套镜像与版本）。 */
  async function ensureElectron({ onProgress = () => {} } = {}) {
    const found = detectElectronPath({ stateDir, appDir });
    if (found) return { ok: true, electronPath: found };
    const result = await installElectronRuntime({ stateDir, log: pluginLog, onProgress });
    return result;
  }

  async function start() {
    if (!installed()) return { ok: false, error: '还没安装悬浮窗（设置 → 悬浮窗 → 安装）' };
    if (running()) return { ok: true, already: true, ...status() };
    const cfg = readConfig();
    let electron = detectElectronPath({ stateDir, appDir });
    if (!electron) return { ok: false, needElectron: true, error: '还没装 Electron 运行时（点「安装运行时」）' };

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.SURFCORE_ORB_DIR = root;
    env.SURFCORE_ORB_THEME = cfg.ball.theme;
    try { fs.rmSync(pidFile, { force: true }); } catch {}
    try { fs.mkdirSync(path.join(appDir, 'data', 'profile'), { recursive: true }); } catch {}

    const profileDir = path.join(appDir, 'data', 'profile');
    let logFd = null;
    try { logFd = fs.openSync(logFile, 'a'); } catch {}
    // --user-data-dir 必须在命令行给：Chromium 在 main 跑之前就初始化 profile。
    const args = ['.', '--no-sandbox', `--user-data-dir=${profileDir}`];
    let pid = 0;
    try {
      const child = spawn(electron, args, {
        cwd: appDir,
        env,
        detached: true,
        stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
        windowsHide: false,
      });
      child.unref();
      if (child.pid) {
        pid = child.pid;
        try { fs.writeFileSync(pidFile, String(pid)); } catch {}
      }
      await new Promise((r) => setTimeout(r, 1400));
      if (pid && !pidAlive(pid)) {
        pid = 0;
        // 有一个竞态：进程刚起就被系统回收时也会走到这里，等 6 秒再判一次。
        for (let i = 0; i < 12; i += 1) {
          const guess = Number(String(fs.readFileSync(pidFile, 'utf8') || '0').trim());
          if (guess && pidAlive(guess)) { pid = guess; break; }
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    } catch (error) {
      if (logFd !== null) { try { fs.closeSync(logFd); } catch {} }
      return { ok: false, error: `启动失败：${String(error?.message ?? error)}` };
    }
    if (logFd !== null) { try { fs.closeSync(logFd); } catch {} }
    if (!pid || !pidAlive(pid)) {
      return { ok: false, error: `悬浮窗进程起不来，看日志：${logFile}` };
    }
    pluginLog('[orb] started pid', pid);
    return { ok: true, pid, ...status() };
  }

  async function stop() {
    const pid = runningPid();
    if (!pid) {
      try { fs.rmSync(pidFile, { force: true }); } catch {}
      return { ok: true, already: true, ...status() };
    }
    try { process.kill(pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 20; i += 1) {
      if (!pidAlive(pid)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (pidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    try { fs.rmSync(pidFile, { force: true }); } catch {}
    pluginLog('[orb] stopped', pid);
    return { ok: true, stopped: pid, ...status() };
  }

  return {
    dir: root,
    appDir,
    logFile,
    hostFile: path.join(root, 'host.json'),
    stateFile,
    status,
    install,
    ensureElectron,
    start,
    stop,
    installed,
    running,
    readConfig,
    writeConfig,
    addMessage,
    listMessages,
    clearMessages,
    readSeenId,
    markSeen,
    readState,
    petInfo,
    petAssets: pets,
  };
}
