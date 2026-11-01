/**
 * SurfCore · 悬浮窗（Orb）⇄ 插件 的本地接口
 *
 * 悬浮球是独立 Electron 进程，带不了 DSH 的会话 Cookie，所以不能走设置页那套
 * `/dsh-surfcore/api/*`。这里单独注册 `/dsh-surfcore/orb-api`：
 *   · 只接受 127.0.0.1 / localhost / ::1；
 *   · 写操作必须 application/json + 同源或没有 Origin；
 *   · 必须带 `x-orb-token`，令牌落在 ~/.dsh/surfcore/orb/host-token（0600）。
 *
 * `~/.dsh/surfcore/orb/host.json` 给悬浮球发现 baseUrl + token；DSH 端口漂移时
 * 插件会重写它（每 2 分钟一次），球重连时会重新读。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { isLoopbackReq, json, readBody, sameOrigin, safeEqual } from './http-guard.js';
import { QQ_STATE_DIR } from './paths.js';

export const ORB_API_PREFIX = '/dsh-surfcore/orb-api';
const HOST_FILE_VERSION = 1;
const ORB_BODY_LIMIT = 256 * 1024;
const SCREEN_KEEP = 20;

/**
 * 「能不能看这张屏」的唯一判定。纯函数，方便单测。
 *
 * 三条规则（隐私铁律，别放宽）：
 *   1. 主人没开「让她看见」→ 连窗口标题都不给（screen-disabled）；
 *   2. 任何一个窗口标题命中黑名单 → **整张不拍**（blocked），不是打码、不是跳过那个窗口；
 *   3. 其它情况放行。
 */
export function screenGate(cfg, titles = []) {
  const screen = cfg?.screen && typeof cfg.screen === 'object' ? cfg.screen : {};
  if (screen.enabled !== true) return { blocked: true, reason: 'screen-disabled' };
  const deny = (Array.isArray(screen.denyTitles) ? screen.denyTitles : [])
    .map((x) => String(x ?? '').toLowerCase().trim())
    .filter(Boolean);
  const hit = [];
  for (const title of titles) {
    const low = String(title || '').toLowerCase();
    if (!low) continue;
    if (deny.some((needle) => low.includes(needle))) hit.push(String(title).slice(0, 80));
  }
  if (hit.length) return { blocked: true, reason: 'blocked', matched: hit };
  return { blocked: false };
}

/** 枚举窗口靠 PowerShell + User32：不引依赖，Windows 上稳。 */
const WINDOW_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -Namespace SurfCoreOrb -Name Win -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr hWnd, out int pid);
'@ | Out-Null
$fg = [SurfCoreOrb.Win]::GetForegroundWindow()
$fgPid = 0
[void][SurfCoreOrb.Win]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$items = @()
foreach ($p in (Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim() -ne '' })) {
  $items += [pscustomobject]@{ pid = $p.Id; name = $p.ProcessName; title = $p.MainWindowTitle }
}
$active = $items | Where-Object { $_.pid -eq $fgPid } | Select-Object -First 1
[pscustomobject]@{
  active = if ($active) { $active } else { [pscustomobject]@{ pid = $fgPid; name = ''; title = '' } }
  windows = @($items | Select-Object -First 25)
} | ConvertTo-Json -Depth 4 -Compress
`;

const SCREEN_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$target = $env:SURFCORE_ORB_SHOT
$maxW = if ($env:SURFCORE_ORB_MAXW) { [int]$env:SURFCORE_ORB_MAXW } else { 1280 }
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
$w = [Math]::Min($maxW, $vs.Width)
$h = [int]($vs.Height * ($w / $vs.Width))
$small = New-Object System.Drawing.Bitmap $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $w, $h)
if ($target -like '*.jpg' -or $target -like '*.jpeg') {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]72)
  $small.Save($target, $codec, $params)
} else {
  $small.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
}
$g2.Dispose(); $small.Dispose(); $g.Dispose(); $bmp.Dispose()
@{ ok = $true; width = $w; height = $h } | ConvertTo-Json -Compress
`;


function runPowerShell(script, { env = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ...env }, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error });
      },
    );
    child.on('error', () => {});
  });
}

/**
 * @param {object} opts
 * @param {object} opts.orb            lib/orb.js 的服务
 * @param {object} opts.chat           pet-chat（profile=orb）
 * @param {string} opts.stateDir       ~/.dsh/surfcore
 * @param {() => string} opts.currentDshUrl
 * @param {(msg:string)=>void} [opts.pluginLog]
 */
export function createOrbApiService({
  orb, chat, stateDir, currentDshUrl, pluginLog = () => {}, version = '',
  identDefaults = () => ({}), setScreenEnabled = null,
  consoleCall = null, picLocalDirs = () => [], adminQQ = () => '',
}) {
  const root = path.join(stateDir, 'orb');
  const hostFile = path.join(root, 'host.json');
  const tokenFile = path.join(root, 'host-token');
  const shotDir = path.join(root, 'screens');
  let lastHostWrite = 0;
  let screenHits = [];
  // 上一次带图调用的结果：true=模型真的看到图了，false=通道不认图，null=还没试过
  let visionOk = null;
  // 手动点「眼」的冷却：防止连点拍一堆，但不占「每小时最多几张」的额度（主人 2026-10-31 定）
  const EYE_COOLDOWN_MS = 3000;
  let lastEyeAt = 0;
  // 悬浮窗发图的频率桶（和 QQ 那边 socialV2.pic 的限额互不相干）
  let picHits = [];
  // 截图记账：跨重启也要能算「今天看了几次」，所以落盘
  const shotsFile = path.join(root, 'shots.json');
  const picDir = path.join(root, 'media');
  // 最近发出去的图（内存即可）：气泡里只有图没有字，聊天时要能跟模型说清「你刚发了什么」。
  // 每条 { at, note }，note 是给模型看的一句说明（表情包描述 / 本地图名 / 生图场景）。
  let picNotes = [];
  function notePic(note) {
    picNotes = [...picNotes, { at: Date.now(), note: String(note || '一张图').slice(0, 120) }].slice(-10);
  }
  function freshPics(limit = 3) {
    const cut = Date.now() - 15 * 60 * 1000;
    return picNotes.filter((x) => x.at >= cut).slice(-limit).map((x) => x.note);
  }

  function dayKey(now = Date.now()) {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function readShots() {
    try {
      const raw = JSON.parse(fs.readFileSync(shotsFile, 'utf8'));
      const today = dayKey();
      if (raw?.date !== today) return { date: today, count: 0, lastAt: 0, lastReason: '' };
      return {
        date: today,
        count: Number(raw.count || 0) || 0,
        lastAt: Number(raw.lastAt || 0) || 0,
        lastReason: String(raw.lastReason || ''),
      };
    } catch {
      return { date: dayKey(), count: 0, lastAt: 0, lastReason: '' };
    }
  }

  function bumpShot(reason) {
    const cur = readShots();
    const next = { date: cur.date, count: cur.count + 1, lastAt: Date.now(), lastReason: String(reason || '').slice(0, 24) };
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(shotsFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } catch (error) {
      pluginLog('[orb-api] 记截图账失败：', String(error?.message ?? error));
    }
    return next;
  }

  /** 发图用：把图片落到 <orb>/media 下（会话里只允许引用这个目录）。 */
  function savePic(buf, ext = '.png') {
    fs.mkdirSync(picDir, { recursive: true });
    const sha = crypto.createHash('sha1').update(buf).digest('hex');
    const dest = path.join(picDir, `${sha}${ext}`);
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
    return dest;
  }

  // ── 现场生图 ───────────────────────────────────────────────────────────
  // 插件本身不带生图通道（没有 API key / undici），借 state/agents/codex-gen.mjs：
  // 那是走 ChatGPT 订阅的脚本，必须带代理（DSH 后端不吃系统代理，7897 是兜底）。
  // ⚠️ 生图脚本在「仓根/state/agents」下，不在插件状态目录（~/.dsh/surfcore）——
  // stateDir 是插件自己的状态，拿它拼出来必然是「本机没有生图脚本」。
  const GEN_SCRIPT = path.join(QQ_STATE_DIR, 'agents', 'codex-gen.mjs');
  const GEN_TIMEOUT_MS = 180 * 1000;
  let genBusy = false;

  function proxyEnv() {
    const env = { ...process.env, NODE_USE_ENV_PROXY: '1' };
    const url = [process.env.HTTPS_PROXY, process.env.HTTP_PROXY, process.env.ALL_PROXY, 'http://127.0.0.1:7897']
      .map((x) => String(x || '').trim()).filter(Boolean)[0];
    if (url) { env.HTTPS_PROXY = url; env.HTTP_PROXY = url; }
    return env;
  }

  /** 现场画一张（30~120 秒）：成功返回 {ok:true,path}，失败带一句能给她看的 error。 */
  function generateNow(prompt) {
    return new Promise((resolve) => {
      const out = path.join(picDir, `gen-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`);
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        genBusy = false;
        resolve(payload);
      };
      if (!fs.existsSync(GEN_SCRIPT)) {
        finish({ ok: false, error: '本机没有生图脚本（state/agents/codex-gen.mjs），只能用现成的图' });
        return;
      }
      let child;
      try {
        fs.mkdirSync(picDir, { recursive: true });
        child = spawn(process.execPath, [GEN_SCRIPT, out, prompt, '1024x1024'], {
          env: proxyEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        finish({ ok: false, error: `起不了生图脚本：${String(error?.message ?? error)}` });
        return;
      }
      let stderr = '';
      let stdout = '';
      child.stdout?.on('data', (d) => { stdout = (stdout + String(d)).slice(-2000); });
      child.stderr?.on('data', (d) => { stderr = (stderr + String(d)).slice(-2000); });
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish({ ok: false, error: '画了 3 分钟还没出来，先放弃这一张' });
      }, GEN_TIMEOUT_MS);
      child.on('error', (error) => {
        clearTimeout(timer);
        finish({ ok: false, error: `生图脚本起不来：${String(error?.message ?? error)}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        let size = 0;
        try { size = fs.statSync(out).size; } catch {}
        if (code === 0 && size > 1024) {
          try {
            const dest = savePic(fs.readFileSync(out), '.png');
            try { fs.unlinkSync(out); } catch {}
            finish({ ok: true, path: dest });
            return;
          } catch (error) {
            finish({ ok: false, error: `图读不进来：${String(error?.message ?? error)}` });
            return;
          }
        }
        try { fs.unlinkSync(out); } catch {}
        const tail = (stderr.trim() || stdout.trim()).split('\n').filter(Boolean).slice(-1)[0] || '未知原因';
        finish({ ok: false, error: `没画出来（exit ${code}）：${String(tail).slice(0, 120)}` });
      });
    });
  }

  /** 看完就删：截图里是主人的桌面，除非他明确要留档，否则不该在盘上堆着。 */
  function dropShot(file) {
    try {
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
    } catch (error) {
      pluginLog('[orb-api] 删截图失败：', String(error?.message ?? error));
    }
  }

  /**
   * 挑一张现成的图：①QQ 收藏表情 ②本地图库。
   * 只挑不记——发不发、写成哪条消息，由调用方（`/pic`、聊天配图）决定。
   */
  async function pickPic({ hint = '', source = '', cfg = null } = {}) {
    // ① QQ 收藏表情：找得到就发，最贴「斗图」的场景
    if (source !== 'local' && cfg?.pic?.preferQqSticker !== false && typeof consoleCall === 'function') {
      try {
        const qq = String(adminQQ() || '').replace(/[^0-9]/g, '');
        if (qq) {
          const key = `private:${qq}`;
          const listed = await consoleCall(`/api/socialV2/sticker-list?key=${encodeURIComponent(key)}&count=60`);
          const raw = listed?.json || {};
          const entries = Array.isArray(raw.entries) ? raw.entries
            : Array.isArray(raw.stickers) ? raw.stickers
              : Array.isArray(raw.items) ? raw.items : [];
          if (entries.length) {
            const near = hint
              ? entries.filter((e) => {
                const hay = `${e.caption || ''} ${e.desc || ''} ${e.localNote || ''} ${(e.keywords || []).join(' ')}`;
                return hint.split(/[\s，,。]/).filter(Boolean).some((w) => hay.includes(w));
              })
              : [];
            const pool = near.length ? near : entries;
            const pick = pool[Math.floor(Math.random() * pool.length)];
            const id = String(pick.id ?? pick.emojiId ?? pick.md5 ?? '').trim();
            if (id) {
              const got = await consoleCall(`/api/socialV2/sticker-image?key=${encodeURIComponent(key)}&stickerId=${encodeURIComponent(id)}`);
              const data = got?.json?.image?.data;
              const mime = String(got?.json?.image?.mimeType || 'image/png');
              if (data) {
                const ext = mime.includes('jpeg') ? '.jpg' : mime.includes('gif') ? '.gif' : mime.includes('webp') ? '.webp' : '.png';
                const dest = savePic(Buffer.from(data, 'base64'), ext);
                return {
                  ok: true,
                  dest,
                  source: 'sticker',
                  sticker: { desc: pick.caption || pick.desc || '', id },
                  note: `QQ 表情包：${pick.caption || pick.desc || hint || '表情'}`,
                };
              }
            }
          }
        }
      } catch (error) {
        pluginLog('[orb-api] 挑 QQ 表情失败：', String(error?.message ?? error));
      }
    }

    // ② 本地图库：主人自己按情绪分目录放的图，命中率最高
    if (source !== 'sticker' && cfg?.pic?.allowLocal !== false) {
      try {
        const dirs = (picLocalDirs() || []).filter((d) => {
          try { return fs.statSync(d).isDirectory(); } catch { return false; }
        });
        const files = [];
        for (const dir of dirs) {
          let names = [];
          try { names = fs.readdirSync(dir); } catch { continue; }
          for (const name of names) {
            if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) continue;
            files.push(path.join(dir, name));
          }
        }
        if (files.length) {
          const pick = files[Math.floor(Math.random() * files.length)];
          const buf = fs.readFileSync(pick);
          const ext = path.extname(pick).toLowerCase() || '.png';
          const dest = savePic(buf, ext);
          return {
            ok: true,
            dest,
            source: 'local',
            file: pick,
            note: `本地图库：${path.basename(pick)}${hint ? `（挑图时说：${hint}）` : ''}`,
          };
        }
      } catch (error) {
        pluginLog('[orb-api] 本地图库挑图失败：', String(error?.message ?? error));
      }
    }

    return { ok: false, error: '这次没找到合适的图' };
  }

  /** 拍一张给她看：图读进内存，磁盘那张按设置立刻删。 */
  async function shotForChat(reason, cfg) {
    const shot = await look({ reason, small: true });
    if (!shot.ok || !shot.screenshot) return null;
    let image = null;
    try {
      const buf = fs.readFileSync(shot.screenshot);
      if (buf.length > 0 && buf.length <= 900 * 1024) {
        image = { mimeType: 'image/jpeg', data: buf.toString('base64') };
      }
    } catch {}
    if (cfg?.screen?.deleteAfterRead !== false) dropShot(shot.screenshot);
    return image;
  }

  /** 她这一小时还能不能配图（和 /pic 共用同一个额度）。 */
  function picQuotaLeft(cfg) {
    const perHour = Math.max(1, Number(cfg?.pic?.maxPerHour) || 12);
    const hourAgo = Date.now() - 3600 * 1000;
    picHits = picHits.filter((x) => x > hourAgo);
    return perHour - picHits.length;
  }

  /**
   * 跑一轮聊天（不含「我」那条消息、不含响应）：
   * 自动档两段式看屏幕 → 问 chat.chat() → 剥掉 [[配图:]] 标记 → 按开关挑一张图。
   */
  async function runChatTurn({ text, cfg }) {
    const desktop = await desktopContext();
    const mode = cfg.screen.mode || (cfg.screen.enabled === true ? 'manual' : 'off');
    // 她刚发过的图，气泡里没有文字，得单独告诉模型，否则她以为自己没发过。
    const pics = freshPics(3);
    // 聊天里能不能带图：开关在，才让她在回复里写 [[配图: …]]
    const allowPic = cfg.pic?.enabled === true && cfg.pic?.attachToChat === true;

    let image = null;
    let result;
    if (mode === 'auto' && cfg.screen.enabled === true) {
      // 自动档两段式：先让她自己决定要不要看（只在回复里出一句 [[看一眼]]），
      // 真要看才拍一张、拍完再问一遍，用第二次的回复当正式回答。
      // 额度由 look() 把关（每小时 maxPerHour），且一轮最多一次。
      const first = await chat.chat({ text, modality: 'text', desktop, pics, screenMode: 'auto', allowPic });
      const firstText = String(first.reply?.text || '');
      if (first.ok && /\[\[看一眼\]\]/.test(firstText)) {
        image = await shotForChat('auto', cfg);
        if (image) {
          result = await chat.chat({ text, modality: 'text', desktop, image, pics, screenMode: 'auto', allowPic });
          if (!result.ok) result = { ...first, reply: { ...(first.reply || {}), text: firstText.replace(/\[\[看一眼\]\]/g, '').trim() } };
        } else {
          result = { ...first, reply: { ...(first.reply || {}), text: firstText.replace(/\[\[看一眼\]\]/g, '').trim() } };
        }
      } else {
        result = first;
      }
    } else {
      // 手动档 / 老配置（attachToChat）：每条消息都顺手拍一张给她看。
      if (cfg.screen.enabled === true && cfg.screen.attachToChat !== false) image = await shotForChat('chat', cfg);
      result = await chat.chat({ text, modality: 'text', desktop, image, pics, allowPic });
    }
    if (!result.ok) return { ok: false, result };

    // ⚠️ 用 rawReply：chat.chat() 返回的 reply.text 已经是剥掉标记的历史文本，
    // 拿它匹配永远匹配不到，配图就永远发不出来。
    let replyText = String(result.rawReply || result.reply?.text || '').trim();
    // 配图标记：不管用不用得上，都必须从给她看的话里剥掉，否则会原样显示给主人。
    const marker = replyText.match(/\[\[配图[:：]\s*([^\]\n]{1,60})\]\]/);
    if (marker) replyText = replyText.replace(/\[\[配图[:：]\s*[^\]\n]{1,60}\]\]/g, '').replace(/\n{3,}/g, '\n\n').trim();

    let picDest = '';
    if (marker && allowPic && picQuotaLeft(cfg) > 0) {
      // 只用快来源（表情/本地图库）：生图要一分钟，不能拿来堵聊天。
      const picked = await pickPic({ hint: String(marker[1] || '').trim(), cfg });
      if (picked.ok) {
        picHits.push(Date.now());
        notePic(picked.note);
        picDest = picked.dest;
      }
    }
    return { ok: true, result, replyText, image: picDest };
  }

  const chatQueue = [];
  let chatBusy = false;
  const CHAT_QUEUE_MAX = 20;

  /** 一条一条回，回完一条再回下一条；单条失败只提示一句，不堵后面。 */
  async function pumpChatQueue() {
    if (chatBusy) return;
    chatBusy = true;
    try {
      while (chatQueue.length) {
        const job = chatQueue.shift();
        try {
          const turn = await runChatTurn({ text: job.text, cfg: job.cfg });
          if (!turn.ok) {
            const why = String(turn.result?.error || '未知原因').slice(0, 120);
            orb.addMessage({ who: 'her', kind: 'system', text: `（这条没回上来：${why}）` });
            continue;
          }
          if (turn.replyText || turn.image) {
            orb.addMessage({ who: 'her', text: turn.replyText, kind: 'reply', image: turn.image });
          }
        } catch (error) {
          orb.addMessage({ who: 'her', kind: 'system', text: `（这条没回上来：${String(error?.message ?? error).slice(0, 120)}）` });
        }
      }
    } finally {
      chatBusy = false;
    }
  }

  /** 启动时清掉一小时前的聊天截图（上一轮崩溃时 finally 没跑到）。 */
  function sweepChatShots() {
    try {
      const now = Date.now();
      for (const name of fs.readdirSync(shotDir)) {
        if (!name.endsWith('.chat.jpg')) continue;
        const full = path.join(shotDir, name);
        try {
          if (now - fs.statSync(full).mtimeMs > 60 * 60 * 1000) dropShot(full);
        } catch {}
      }
    } catch {}
  }
  sweepChatShots();

  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });

  function token() {
    try {
      const existing = fs.readFileSync(tokenFile, 'utf8').trim();
      if (existing.length >= 32) return existing;
    } catch {}
    const fresh = crypto.randomBytes(24).toString('hex');
    try {
      fs.writeFileSync(tokenFile, `${fresh}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(tokenFile, 0o600);
    } catch (error) {
      pluginLog('[orb-api] 写 host-token 失败：', String(error?.message ?? error));
    }
    return fresh;
  }

  function hostPayload() {
    let pet = null;
    try { pet = orb.petInfo(); } catch (error) {
      pluginLog('[orb-api] 取形象配置失败：', String(error?.message ?? error));
    }
    return {
      version: HOST_FILE_VERSION,
      baseUrl: String(currentDshUrl() || '').replace(/\/+$/, ''),
      token: token(),
      api: ORB_API_PREFIX,
      // 形象（球 / 桌宠）+ 素材目录 + 动画清单，桌面端只读这里，不自己找文件。
      pet: pet
        ? {
          mode: pet.mode,
          size: pet.size,
          dir: pet.dir,
          singleClickOpens: pet.singleClickOpens,
          idleMinMs: pet.idleMinMs,
          idleMaxMs: pet.idleMaxMs,
          manifest: pet.manifest,
        }
        : null,
      pluginVersion: String(version || ''),
      updatedAt: new Date().toISOString(),
    };
  }

  function writeHostFile(force = false) {
    const now = Date.now();
    if (!force && now - lastHostWrite < 5000) return;
    lastHostWrite = now;
    try {
      fs.mkdirSync(root, { recursive: true });
      const tmp = `${hostFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(hostPayload(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, hostFile);
      try { fs.chmodSync(hostFile, 0o600); } catch {}
    } catch (error) {
      pluginLog('[orb-api] 写 host.json 失败：', String(error?.message ?? error));
    }
  }

  function authOk(req, url) {
    const header = String(req.headers['x-orb-token'] ?? '');
    const query = String(url?.searchParams?.get('token') ?? '');
    const expected = token();
    if (!expected) return false;
    if (header && safeEqual(header, expected)) return true;
    if (query && safeEqual(query, expected)) return true;
    return false;
  }

  // ── 看屏幕 ────────────────────────────────────────────────────────────
  function screenBlocked(titles = []) {
    return screenGate(orb.readConfig(), titles);
  }

  function screenRateOk() {
    const cfg = orb.readConfig();
    const cap = Number(cfg.screen.maxPerHour) || 0;
    if (cap <= 0) return true; // 0 = 不限
    const now = Date.now();
    screenHits = screenHits.filter((t) => now - t < 3600_000);
    return screenHits.length < cap;
  }

  async function desktopContext() {
    // 只给标题级上下文（不给图），用于悬浮窗对话与唤醒提示的轻量「她在看你」。
    const cfg = orb.readConfig();
    if (cfg.screen.enabled !== true) return null;
    const res = await runPowerShell(WINDOW_SCRIPT, { timeoutMs: 15000 });
    if (!res.ok || !res.stdout.trim()) return null;
    let data = null;
    try { data = JSON.parse(res.stdout.trim()); } catch { return null; }
    const titles = [data?.active?.title, ...(Array.isArray(data?.windows) ? data.windows.map((w) => w.title) : [])].filter(Boolean);
    const gate = screenBlocked(titles);
    if (gate.blocked) return { blocked: true, reason: gate.reason };
    return {
      blocked: false,
      active: { title: String(data?.active?.title || '').slice(0, 120), name: String(data?.active?.name || '').slice(0, 60) },
      windows: (Array.isArray(data?.windows) ? data.windows : []).slice(0, 12).map((w) => ({ title: String(w?.title || '').slice(0, 120), name: String(w?.name || '').slice(0, 60) })),
    };
  }

  async function look({ reason = '', small = false, manual = false } = {}) {
    const cfg = orb.readConfig();
    if (cfg.screen.enabled !== true) {
      return { ok: false, reason: 'screen-disabled', error: '主人还没允许「让她看见屏幕」（设置 → SurfCore → 悬浮窗 → 让它看见）' };
    }
    // manual=true 是主人自己点「眼」：只看 3 秒冷却，不占每小时额度。
    if (!manual && !screenRateOk()) {
      return { ok: false, reason: 'rate-limited', error: `看屏幕太频繁了（每小时最多 ${cfg.screen.maxPerHour} 次）` };
    }
    const winRes = await runPowerShell(WINDOW_SCRIPT, { timeoutMs: 15000 });
    let win = null;
    try { win = winRes.ok && winRes.stdout.trim() ? JSON.parse(winRes.stdout.trim()) : null; } catch {}
    const titles = [win?.active?.title, ...(Array.isArray(win?.windows) ? win.windows.map((w) => w.title) : [])].filter(Boolean);
    const gate = screenBlocked(titles);
    if (gate.reason === 'blocked') {
      return { ok: false, reason: 'blocked', matched: gate.matched, error: `当前窗口命中隐私黑名单，没拍：${gate.matched.join('、')}` };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // 给模型看的那张要小（宽 800 的 JPEG，几十 KB）；给工具/设置页看的存 PNG 原尺寸。
    const shotPath = path.join(shotDir, small ? `${stamp}.chat.jpg` : `${stamp}.png`);
    const shot = await runPowerShell(SCREEN_SCRIPT, {
      env: { SURFCORE_ORB_SHOT: shotPath, ...(small ? { SURFCORE_ORB_MAXW: '800' } : {}) },
      timeoutMs: 25000,
    });
    if (!shot.ok || !fs.existsSync(shotPath)) {
      return { ok: false, reason: 'capture-failed', error: `截屏失败：${String(shot.stderr || shot.error?.message || '').slice(0, 200)}` };
    }
    screenHits.push(Date.now());
    bumpShot(reason);
    // 只留最近 N 张，避免截图堆满磁盘。
    try {
      const files = fs.readdirSync(shotDir).filter((f) => f.endsWith('.png') || f.endsWith('.jpg')).sort();
      for (const old of files.slice(0, Math.max(0, files.length - SCREEN_KEEP))) {
        try { fs.rmSync(path.join(shotDir, old), { force: true }); } catch {}
      }
    } catch {}
    let size = 0;
    try { size = fs.statSync(shotPath).size; } catch {}
    return {
      ok: true,
      screenshot: shotPath,
      bytes: size,
      active: { title: String(win?.active?.title || '').slice(0, 120), name: String(win?.active?.name || '').slice(0, 60) },
      windows: (Array.isArray(win?.windows) ? win.windows : []).slice(0, 15).map((w) => ({ title: String(w?.title || '').slice(0, 120), name: String(w?.name || '').slice(0, 60) })),
      reason: String(reason || '').slice(0, 120),
      at: Date.now(),
    };
  }

  /**
   * 气泡上的「谁说的话」：名字和头像。
   * 优先级：设置里填的 > self-identity.json / admin.qq 推出来的默认 > 空（渲染端退化成纯文字）。
   */
  let modelVision = null; // null=还没问过；true/false=问过模型元信息的结果

  function screenSnapshot(cfg) {
    const shots = readShots();
    return {
      enabled: cfg.screen.enabled === true,
      // off | manual | auto：off 关掉；manual 只有点「眼」才看；auto 她自己可以申请看
      mode: cfg.screen.mode || (cfg.screen.enabled === true ? 'manual' : 'off'),
      attachToChat: cfg.screen.attachToChat !== false,
      deleteAfterRead: cfg.screen.deleteAfterRead !== false,
      visionOk,
      modelVision,
      maxPerHour: cfg.screen.maxPerHour,
      shotsToday: shots.count,
      shotsDate: shots.date,
      lastShotAt: shots.lastAt || (screenHits.length ? screenHits[screenHits.length - 1] : 0),
      lastReason: shots.lastReason,
      // 悬浮窗自己的发图开关（和 QQ 那边 socialV2.pic 无关）
      picEnabled: cfg.pic?.enabled === true,
    };
  }

  function resolveIdent(cfg) {
    const ident = (cfg.chat && cfg.chat.ident) || {};
    let defs = {};
    try { defs = identDefaults() || {}; } catch {}
    const herName = String(ident.herName || defs.herName || '').trim();
    const meName = String(ident.meName || defs.meName || '').trim();
    const herQQ = String(ident.herQQ || defs.herQQ || '').replace(/[^0-9]/g, '');
    const meQQ = String(ident.meQQ || defs.meQQ || '').replace(/[^0-9]/g, '');
    // 头像 URL 带一个版本号：设置一改，渲染端的 <img> 缓存自然失效。
    const rev = `${herName}|${herQQ}|${ident.herPath || ''}|${meName}|${meQQ}|${ident.mePath || ''}`.length;
    return {
      showAvatar: ident.showAvatar !== false,
      showName: ident.showName !== false,
      her: {
        name: herName || '她',
        qq: herQQ,
        avatarUrl: ident.showAvatar === false ? '' : `/avatar?who=her&v=${rev}`,
      },
      me: {
        name: meName || '主人',
        qq: meQQ,
        avatarUrl: ident.showAvatar === false ? '' : `/avatar?who=me&v=${rev}`,
      },
    };
  }

  function guessType(file) {
    const lower = String(file).toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    return 'image/png';
  }

  /** 默认兜底形象：用装好的 orb-app 里那张（和球上同一个头像）。 */
  function fallbackAvatar() {
    const file = path.join(root, 'app', 'avatar.png');
    return fs.existsSync(file) ? file : null;
  }

  async function downloadAvatar(url, dest) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return false;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 512) return false;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return true;
    } catch (error) {
      pluginLog('[orb-api] 拉 QQ 头像失败：', String(error?.message ?? error));
      return false;
    }
  }

  /**
   * 头像落地成文件：自定义路径 → 本地缓存（7 天）→ QQ 头像（qlogo）→ 兜底形象。
   * 返回 { file, type }；都不行就 file:null，渲染端画个字母。
   */
  async function avatarResolve(who, cfg) {
    const ident = (cfg.chat && cfg.chat.ident) || {};
    const custom = String((who === 'me' ? ident.mePath : ident.herPath) || '').trim();
    if (custom && fs.existsSync(custom)) return { file: custom, type: guessType(custom) };

    const cacheFile = path.join(root, 'avatars', `${who}.png`);
    const ttl = 7 * 24 * 3600 * 1000;
    try {
      const st = fs.statSync(cacheFile);
      if (Date.now() - st.mtimeMs < ttl) return { file: cacheFile, type: 'image/png' };
    } catch {}

    const qq = String((who === 'me' ? ident.meQQ : ident.herQQ) || '').replace(/[^0-9]/g, '');
    if (qq) {
      const url = `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`;
      if (await downloadAvatar(url, cacheFile)) return { file: cacheFile, type: 'image/png' };
    }
    const fallback = fallbackAvatar();
    return { file: fallback, type: 'image/png' };
  }

  function stateForOrb() {
    const cfg = orb.readConfig();
    const msgs = orb.listMessages(60);
    const status = orb.status();
    let focus = false;
    try {
      const focusFile = path.join(stateDir, 'pet', 'focus.json');
      if (fs.existsSync(focusFile)) focus = JSON.parse(fs.readFileSync(focusFile, 'utf8'))?.enabled === true;
    } catch {}
    return {
      ok: true,
      running: status.running,
      pid: status.pid,
      seq: msgs.seq,
      messages: msgs.messages,
      config: cfg,
      // 气泡那一排要显示的头像/名字（默认取机器人自己 + 主人 QQ）
      ui: resolveIdent(cfg),
      screen: screenSnapshot(cfg),
      role: chat?.status?.().role ?? null,
      chat: {
        enabled: cfg.chat.enabled,
        llm: chat?.status?.().llm ?? null,
        // 排队状态：球上的「在想」和输入框的空闲收起都看这个。
        queue: { pending: chatQueue.length, busy: chatBusy },
      },
      purpose: { focus },
      // 已读水位：面板里看到第几条，收起后就不用再弹气泡了（跨重启记住）。
      read: { seenId: orb.readSeenId() },
      theme: (() => {
        const t = cfg.ball.theme;
        return t === 'light' || t === 'dark' ? t : 'dark';
      })(),
      serverTime: Date.now(),
    };
  }

  async function handle(req, res, url) {
    if (!isLoopbackReq(req)) { json(res, 403, { ok: false, error: '只接受本机回环访问' }); return; }
    if (req.method !== 'GET' && !sameOrigin(req)) { json(res, 403, { ok: false, error: '跨站请求被拒绝' }); return; }
    if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
      json(res, 415, { ok: false, error: '写操作必须是 application/json' });
      return;
    }
    if (!authOk(req, url)) {
      json(res, 401, { ok: false, error: '悬浮窗令牌无效或还没生成（重启 DSH 后会自动重写 host.json）' });
      return;
    }
    writeHostFile();

    const suffix = url.pathname.slice(ORB_API_PREFIX.length) || '/';

    if (req.method === 'GET' && suffix === '/avatar') {
      const who = url.searchParams.get('who') === 'me' ? 'me' : 'her';
      const found = await avatarResolve(who, orb.readConfig());
      if (!found.file || !fs.existsSync(found.file)) {
        json(res, 404, { ok: false, error: '没有可用的头像' });
        return;
      }
      res.writeHead(200, {
        'content-type': found.type,
        'cache-control': 'private, max-age=600',
      });
      fs.createReadStream(found.file).pipe(res);
      return;
    }
    if (req.method === 'POST' && suffix === '/eye') {
      let body = {};
      try { body = JSON.parse((await readBody(req, ORB_BODY_LIMIT)) || '{}'); } catch {}
      const on = body.enabled !== false;
      if (typeof setScreenEnabled !== 'function') {
        json(res, 501, { ok: false, error: '当前版本不支持从这里改屏幕权限' });
        return;
      }
      const cfgNext = setScreenEnabled(on);
      writeHostFile(true);
      json(res, 200, { ok: true, enabled: on, screen: cfgNext });
      return;
    }    if (req.method === 'GET' && suffix === '/health') {
      json(res, 200, { ok: true, name: 'surfcore-orb', version: String(version || ''), serverTime: Date.now() });
      return;
    }
    if (req.method === 'GET' && suffix === '/state') {
      json(res, 200, stateForOrb());
      return;
    }
    if (req.method === 'GET' && suffix === '/history') {
      json(res, 200, { ok: true, ...orb.listMessages(Number(url.searchParams.get('limit')) || 40) });
      return;
    }
    if (req.method === 'GET' && suffix === '/events') {
      const since = Number(url.searchParams.get('since'));
      const state = orb.listMessages(120);
      const from = Number.isFinite(since) ? since : state.seq - 1;
      const fresh = state.messages.filter((m) => Number(m.id) > from);
      json(res, 200, { ok: true, seq: state.seq, messages: fresh });
      return;
    }
    if (req.method === 'POST' && suffix === '/say') {
      let body = {};
      try { body = JSON.parse((await readBody(req, ORB_BODY_LIMIT)) || '{}'); } catch {
        json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        return;
      }
      const message = orb.addMessage({ who: 'her', text: body.text, kind: body.kind === 'proactive' ? 'proactive' : 'reply' });
      if (!message) { json(res, 400, { ok: false, error: '没有内容可发' }); return; }
      json(res, 200, { ok: true, message, seq: message.id });
      return;
    }
    if (req.method === 'POST' && suffix === '/history/clear') {
      orb.clearMessages();
      json(res, 200, { ok: true });
      return;
    }
    // 已读水位：面板看过就记一下，收起时不再为同一条冒气泡。
    if (req.method === 'POST' && suffix === '/seen') {
      let body = {};
      try { body = JSON.parse((await readBody(req, ORB_BODY_LIMIT)) || '{}'); } catch {}
      const seenId = orb.markSeen(Number(body.id) || 0);
      json(res, 200, { ok: true, seenId });
      return;
    }
    if (req.method === 'POST' && suffix === '/pic') {
      let body = {};
      try { body = JSON.parse((await readBody(req, ORB_BODY_LIMIT)) || '{}'); } catch {}
      const cfg = orb.readConfig();
      if (cfg.pic?.enabled !== true) {
        json(res, 409, { ok: false, error: '悬浮窗发图没开（设置 → SurfCore → 悬浮窗 → 发图）' });
        return;
      }
      const perHour = Math.max(1, Number(cfg.pic.maxPerHour) || 12);
      const hourAgo = Date.now() - 3600 * 1000;
      picHits = picHits.filter((x) => x > hourAgo);
      if (picHits.length >= perHour) {
        json(res, 429, { ok: false, error: `这一小时发图到上限了（每小时 ${perHour} 张）` });
        return;
      }
      const hint = String(body.hint ?? '').trim().slice(0, 200);
      const source = String(body.source ?? '').trim();

      // ① QQ 收藏表情 → ② 本地图库：先试试现成的
      const picked = await pickPic({ hint, source, cfg });
      if (picked.ok) {
        picHits.push(Date.now());
        const msg = orb.addMessage({ who: 'her', kind: 'pic', text: '', image: picked.dest });
        notePic(picked.note);
        json(res, 200, {
          ok: true,
          source: picked.source,
          sticker: picked.sticker,
          file: picked.file,
          message: msg,
          screen: screenSnapshot(cfg),
        });
        return;
      }

      // ③ 现场生图：自己调订阅通道画一张（30~120 秒）。真画不出来，才把 prompt
      // 交回给聊天里的 agent 回填（/pic/image），别让她在球里干等一句「没找到图」。
      if (cfg.pic.allowGenerate !== false) {
        const base = hint || '主人这会儿想看你发张图';
        const prompt = [
          'Q 版小鲸鱼形象（蓝紫长发、女仆装、鲸鱼围裙），二次元赛璐璐上色，竖构图。',
          `场景：${base}`,
          '表情自然、有梗，适合当聊天表情包。',
        ].join('\n');
        if (genBusy) {
          json(res, 202, { ok: false, needGenerate: true, prompt, hint: base, error: '上一张还在画，等它出来再点一下', screen: screenSnapshot(cfg) });
          return;
        }
        genBusy = true;
        const gen = await generateNow(prompt);
        if (gen.ok) {
          picHits.push(Date.now());
          const msg = orb.addMessage({ who: 'her', kind: 'pic', text: '', image: gen.path });
          notePic(`自己现画的图（场景：${base}）`);
          json(res, 200, { ok: true, source: 'generate', prompt, message: msg, screen: screenSnapshot(orb.readConfig()) });
          return;
        }
        json(res, 200, {
          ok: false,
          needGenerate: true,
          prompt,
          hint: base,
          error: gen.error || '没有现成的图，这条得现场画',
          screen: screenSnapshot(orb.readConfig()),
        });
        return;
      }
      json(res, 404, { ok: false, error: '这次没找到合适的图' });
      return;
    }

    if (req.method === 'POST' && suffix === '/pic/image') {
      let body = {};
      try { body = JSON.parse((await readBody(req, ORB_BODY_LIMIT)) || '{}'); } catch {}
      const cfg = orb.readConfig();
      if (cfg.pic?.enabled !== true) {
        json(res, 409, { ok: false, error: '悬浮窗发图没开' });
        return;
      }
      const src = String(body.path ?? '').trim();
      if (!src || !fs.existsSync(src)) { json(res, 400, { ok: false, error: '图片路径不存在' }); return; }
      if (!/\.(png|jpe?g|gif|webp)$/i.test(src)) { json(res, 400, { ok: false, error: '只支持 png/jpg/gif/webp' }); return; }
      try {
        const st = fs.statSync(src);
        if (!st.isFile() || st.size > 20 * 1024 * 1024) { json(res, 400, { ok: false, error: '图太大或不是文件' }); return; }
        const dest = savePic(fs.readFileSync(src), path.extname(src).toLowerCase());
        const caption = String(body.text ?? '').trim().slice(0, 200);
        const msg = orb.addMessage({ who: 'her', kind: 'pic', text: caption, image: dest });
        notePic(`补发的图${caption ? `（配字：${caption}）` : ''}`);
        json(res, 200, { ok: true, source: 'generate', message: msg, screen: screenSnapshot(cfg) });
      } catch (error) {
        json(res, 500, { ok: false, error: `回填图片失败：${String(error?.message ?? error)}` });
      }
      return;
    }

    if (req.method === 'POST' && suffix === '/chat') {
      let body = {};
      try { body = JSON.parse((await readBody(req, ORB_BODY_LIMIT)) || '{}'); } catch {
        json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        return;
      }
      const cfg = orb.readConfig();
      if (cfg.chat.enabled !== true) {
        json(res, 409, { ok: false, error: '她现在不在这边聊（设置 → 悬浮窗 → 互动）' });
        return;
      }
      const text = String(body.text ?? '').trim();
      if (!text) { json(res, 400, { ok: false, error: '说点什么吧' }); return; }

      // 排队模式：先把「我」这条写进去、立刻回 200，让她在后台一条条回。
      // 客户端把非 2xx 当失败，所以这里必须 200，不能 202。
      if (body.queue === true) {
        if (chatQueue.length >= CHAT_QUEUE_MAX) {
          json(res, 429, { ok: false, error: `排队太多条了（最多 ${CHAT_QUEUE_MAX} 条），等前面几条回完再说` });
          return;
        }
        orb.addMessage({ who: 'me', text, kind: 'chat' });
        chatQueue.push({ text, cfg });
        const position = chatQueue.length + (chatBusy ? 1 : 0);
        void pumpChatQueue();
        json(res, 200, { ok: true, queued: true, position, state: stateForOrb() });
        return;
      }

      orb.addMessage({ who: 'me', text, kind: 'chat' });
      const turn = await runChatTurn({ text, cfg });
      if (!turn.ok) {
        json(res, 400, { ...turn.result, state: stateForOrb() });
        return;
      }
      if (turn.replyText || turn.image) {
        orb.addMessage({ who: 'her', text: turn.replyText, kind: 'reply', image: turn.image });
      }
      json(res, 200, { ...turn.result, state: stateForOrb() });
      return;
    }
    if (req.method === 'POST' && suffix === '/screen/eye') {
      let body = {};
      try { body = JSON.parse((await readBody(req, ORB_BODY_LIMIT)) || '{}'); } catch {}
      const cfg = orb.readConfig();
      // 先问模型能不能看图：DSH 只认 inputModalities 含 "image" 的模型。
      // 不支持的模型，图会被换成「(image omitted…)」，她只能诚实说看不到——不如直接说清楚。
      try {
        const support = await chat.visionSupport?.();
        if (support) modelVision = support.ok === true;
        if (support && support.ok === false) {
          visionOk = false;
          return json(res, 200, {
            ok: false,
            enabled: cfg.screen?.enabled === true,
            visionOk: false,
            reason: "model-no-vision",
            error: `当前模型（${support.model || "未知"}）不能看图，先用支持图片输入的模型再开眼睛`,
            support,
            screen: screenSnapshot(cfg),
          });
        }
      } catch {}

      if (body.enabled === false) {
        if (setScreenEnabled) setScreenEnabled(false);
        // 关掉之后必须重读配置：setScreenEnabled 刚刚把 mode 写成了 off，
        // 拿改之前的 cfg 回包，球的按钮会一直显示「手动」，点一下还是关——来回打转。
        const closed = orb.readConfig();
        const closedScreen = screenSnapshot(closed);
        json(res, 200, { ok: true, enabled: false, mode: closedScreen.mode, visionOk, screen: closedScreen });
        return;
      }
      if (setScreenEnabled) setScreenEnabled(true);
      // 打开也一样：回包要反映「现在」的 mode，而不是 handler 开头那一份。
      const opened = orb.readConfig();
      const openedScreen = screenSnapshot(opened);
      // 手动档：只拦 3 秒连点，不占「每小时最多几张」的额度。
      const nowMs = Date.now();
      if (nowMs - lastEyeAt < EYE_COOLDOWN_MS) {
        const wait = Math.ceil((EYE_COOLDOWN_MS - (nowMs - lastEyeAt)) / 100) / 10;
        json(res, 429, {
          ok: false,
          enabled: true,
          mode: openedScreen.mode,
          visionOk,
          reason: 'cooldown',
          error: `刚看过，歇 ${wait} 秒再点`,
          screen: openedScreen,
        });
        return;
      }
      lastEyeAt = nowMs;
      const shot = await look({ reason: 'eye', small: true, manual: true });
      if (!shot.ok) {
        json(res, 200, {
          ok: false,
          enabled: true,
          mode: openedScreen.mode,
          visionOk,
          reason: shot.reason,
          error: shot.error || '拍不到屏幕',
          screen: openedScreen,
        });
        return;
      }
      let image = null;
      try {
        const buf = fs.readFileSync(shot.screenshot);
        if (buf.length > 0 && buf.length <= 900 * 1024) {
          image = { mimeType: 'image/jpeg', data: buf.toString('base64') };
        }
      } catch (error) {
        pluginLog('[orb-api] 读截图失败：', String(error?.message ?? error));
      }
      if (cfg.screen.deleteAfterRead !== false) dropShot(shot.screenshot);

      const probe = [
        '（主人刚给了你看屏幕的权限，这是刚刚截的一张屏。）',
        '如果你真的能看到这张图：先一句话说清画面里最显眼的窗口/内容，再用你自己的口气跟主人说一句。',
        '如果你看不到任何图片（只有一段“(image omitted...)”文字），就只回「看不到图」，别的什么都别说。',
      ].join('');
      let reply = '';
      let failure = null;
      if (image) {
        try {
          const result = await chat.chat({ text: probe, modality: 'text', desktop: await desktopContext(), image });
          if (result.ok) reply = String(result.reply?.text || '').trim();
          else failure = result.error || '模型调用失败';
        } catch (error) {
          failure = String(error?.message ?? error);
        }
      } else {
        failure = '这张截图没能读进内存';
      }
      if (/看不到图|看不到图片|没有图片|无法查看图片/.test(reply)) {
        visionOk = false;
      } else if (reply) {
        visionOk = true;
      }
      const text = visionOk === false
        ? '我这边看不了图（当前模型不支持图片输入），开了眼睛也没用。'
        : (reply || (failure ? `看一眼失败了：${String(failure).slice(0, 60)}` : '看过了，不过我没说上来。'));
      if (text) orb.addMessage({ who: 'her', text, kind: 'reply' });
      json(res, 200, {
        ok: Boolean(reply) && visionOk !== false,
        enabled: true,
        mode: openedScreen.mode,
        visionOk,
        reply: text,
        shotAt: shot.at,
        active: shot.active ?? null,
        screen: screenSnapshot(orb.readConfig()),
        state: stateForOrb(),
      });
      return;
    }
    if (req.method === 'POST' && suffix === '/look') {
      let body = {};
      try { body = JSON.parse((await readBody(req, ORB_BODY_LIMIT)) || '{}'); } catch {}
      const result = await look({ reason: body.reason });
      json(res, result.ok ? 200 : 403, result);
      return;
    }

    json(res, 404, { ok: false, error: `未知悬浮窗接口：${suffix}` });
  }

  return {
    prefix: ORB_API_PREFIX,
    handle,
    writeHostFile,
    hostFile,
    tokenFile,
    shotDir,
    token,
    look,
    stateForOrb,
    desktopContext,
  };
}
