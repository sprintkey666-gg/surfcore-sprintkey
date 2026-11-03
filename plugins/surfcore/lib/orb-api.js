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
import { createOrbCompanionService } from './orb-companion.js';
import { execFile, spawn } from 'node:child_process';
import { isLoopbackReq, json, readBody, sameOrigin, safeEqual } from './http-guard.js';
import { QQ_STATE_DIR } from './paths.js';
import {
  attachmentContents, buildAttachmentPrompt, displayFiles, normalizeAttachments, sweepInbox,
} from './orb-files.js';

export const ORB_API_PREFIX = '/dsh-surfcore/orb-api';
const HOST_FILE_VERSION = 1;
const ORB_BODY_LIMIT = 256 * 1024;
const CHAT_BODY_LIMIT = 24 * 1024 * 1024;
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

/**
 * 枚举窗口靠 PowerShell + User32：不引依赖，Windows 上稳。
 *
 * 注意三件事：
 *  - 先 SetProcessDPIAware：否则 175% 缩放下 GetWindowRect 拿到的是逻辑像素，截出来的区域会错位/发虚。
 *  - 前台窗口可能是我们自己的悬浮窗/桌宠/字幕窗，沿 z-order 往下找第一个「不是自己的」可见窗口。
 *  - stdout 必须显式设成 UTF-8：多行 -Command 里带中文字面量时，默认 GBK 会让 Node 解码成乱码。
 */
const WINDOW_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SurfCoreOrbWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
}
'@
[void][SurfCoreOrbWin]::SetProcessDPIAware()
$ownTitles = @('SurfCore 悬浮窗', 'SurfCore 桌宠', '陪伴字幕')

function Read-WinTitle([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][SurfCoreOrbWin]::GetWindowText($h, $sb, 512)
  return $sb.ToString()
}

$fg = [SurfCoreOrbWin]::GetForegroundWindow()
$hwnd = [IntPtr]::Zero
$title = ''
$rect = New-Object SurfCoreOrbWin+RECT
$h = $fg
for ($i = 0; $i -lt 16 -and [int64]$h -ne 0; $i++) {
  $t = Read-WinTitle $h
  if ($t -and $t.Trim() -ne '' -and -not ($ownTitles -contains $t.Trim())) {
    if ([SurfCoreOrbWin]::IsWindowVisible($h) -and -not [SurfCoreOrbWin]::IsIconic($h)) {
      $r = New-Object SurfCoreOrbWin+RECT
      if ([SurfCoreOrbWin]::GetWindowRect($h, [ref]$r)) {
        $w = $r.Right - $r.Left
        $hh = $r.Bottom - $r.Top
        if ($w -ge 200 -and $hh -ge 150) { $hwnd = $h; $title = $t; $rect = $r; break }
      }
    }
  }
  $h = [SurfCoreOrbWin]::GetWindow($h, 2)
}

$activePid = 0
$targetHwnd = $fg
if ([int64]$hwnd -ne 0) { $targetHwnd = $hwnd }
[void][SurfCoreOrbWin]::GetWindowThreadProcessId($targetHwnd, [ref]$activePid)
$activeName = ''
try { $activeName = (Get-Process -Id $activePid -ErrorAction Stop).ProcessName } catch {}
$cursor = New-Object SurfCoreOrbWin+POINT
[void][SurfCoreOrbWin]::GetCursorPos([ref]$cursor)

$items = @()
foreach ($p in (Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim() -ne '' -and -not ($ownTitles -contains $_.MainWindowTitle.Trim()) })) {
  $items += [pscustomobject]@{ pid = $p.Id; name = $p.ProcessName; title = $p.MainWindowTitle }
}

[pscustomobject]@{
  active = [pscustomobject]@{
    pid = [int]$activePid
    name = $activeName
    title = $title
    hwnd = [int64]$hwnd
    rect = [pscustomobject]@{ x = $rect.Left; y = $rect.Top; w = ($rect.Right - $rect.Left); h = ($rect.Bottom - $rect.Top) }
  }
  cursor = [pscustomobject]@{ x = $cursor.X; y = $cursor.Y }
  windows = @($items | Select-Object -First 25)
} | ConvertTo-Json -Depth 5 -Compress
`;

/**
 * 截图：一张只拍一次，区域由调用方给（活动窗口矩形），拿不到/不合法才回退整屏。
 *
 * - SURFCORE_ORB_SHOT    目标文件（后缀决定 PNG / JPEG）
 * - SURFCORE_ORB_MAXW    0=不缩放（设置页预览用原尺寸 PNG）；960/1280=缩放后的 JPEG
 * - SURFCORE_ORB_QUALITY JPEG 质量，默认 85
 * - SURFCORE_ORB_RECT    "x,y,w,h"（物理像素）；缺省或非法时回退整屏，并在 note 里说明
 *
 * 输出 source=window|screen + note，调用方不用猜是窗口还是整屏。
 */
const SCREEN_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SurfCoreOrbDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# 必须先声明 DPI 感知：否则 175% 缩放下 VirtualScreen 是逻辑尺寸（2560x1440 -> 1463x823），
# 拿物理像素的窗口矩形去 Intersect 会被裁掉一大块，截出来的位置也是错的。
[void][SurfCoreOrbDpi]::SetProcessDPIAware()
$target = $env:SURFCORE_ORB_SHOT
$maxW = if ($env:SURFCORE_ORB_MAXW) { [int]$env:SURFCORE_ORB_MAXW } else { 0 }
$quality = if ($env:SURFCORE_ORB_QUALITY) { [int]$env:SURFCORE_ORB_QUALITY } else { 85 }
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$src = New-Object System.Drawing.Rectangle $vs.Left, $vs.Top, $vs.Width, $vs.Height
$crop = $src
$source = 'screen'
$note = ''
$rect = $null
if ($env:SURFCORE_ORB_RECT) {
  if ($env:SURFCORE_ORB_RECT -match '^(-?\\d+),(-?\\d+),(\\d+),(\\d+)$') {
    $rect = New-Object System.Drawing.Rectangle ([int]$Matches[1]), ([int]$Matches[2]), ([int]$Matches[3]), ([int]$Matches[4])
  } else {
    $note = '窗口坐标无效，回退成整屏'
  }
}
if ($rect) {
  if ($rect.Width -ge 200 -and $rect.Height -ge 150) {
    $crop = [System.Drawing.Rectangle]::Intersect($src, $rect)
    if ($crop.Width -ge 200 -and $crop.Height -ge 150) { $source = 'window' } else { $crop = $src; $note = '窗口区域不在屏幕内，回退成整屏' }
  } else {
    $note = '窗口太小，回退成整屏'
  }
}
$bmp = New-Object System.Drawing.Bitmap $crop.Width, $crop.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($crop.Left, $crop.Top, 0, 0, $bmp.Size)
$w = $crop.Width
$h = $crop.Height
$scaled = $false
if ($maxW -gt 0 -and $crop.Width -gt $maxW) {
  $w = $maxW
  $h = [int][Math]::Round($crop.Height * ($maxW / $crop.Width))
  $outImg = New-Object System.Drawing.Bitmap $w, $h
  $g2 = [System.Drawing.Graphics]::FromImage($outImg)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $w, $h)
  $scaled = $true
} else {
  $outImg = $bmp
}
if ($target -like '*.jpg' -or $target -like '*.jpeg') {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
  $outImg.Save($target, $codec, $params)
} else {
  $outImg.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
}
if ($scaled) { $outImg.Dispose(); $g2.Dispose() }
$g.Dispose(); $bmp.Dispose()
[pscustomobject]@{
  ok = $true
  width = $w
  height = $h
  original = [pscustomobject]@{ width = $crop.Width; height = $crop.Height }
  source = $source
  rect = [pscustomobject]@{ x = $crop.Left; y = $crop.Top; w = $crop.Width; h = $crop.Height }
  note = $note
} | ConvertTo-Json -Depth 4 -Compress
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
  companion: injectedCompanion = null, archiveMessage = null,
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

  /** 拍一张给她看：图读进内存，磁盘那张按设置立刻删。失败时把原因和窗口标题一起带回来。 */
  async function shotForChat(reason, cfg, tier = '') {
    const shot = await look({ reason, small: true, tier });
    if (!shot.ok || !shot.screenshot) {
      return {
        image: null,
        error: shot.error || '拍不到屏幕',
        reason: shot.reason || '',
        title: String(shot.title || ''),
        active: shot.active || null,
        fallback: shot.fallback === true,
      };
    }
    let image = null;
    let error = '';
    try {
      const buf = fs.readFileSync(shot.screenshot);
      if (buf.length > 0 && buf.length <= 900 * 1024) {
        image = { mimeType: shot.mime === 'image/png' ? 'image/png' : 'image/jpeg', data: buf.toString('base64') };
      } else {
        error = '截出来的图太大（超过 900KB），没附上';
      }
    } catch (e) {
      error = String(e?.message ?? e);
    }
    if (cfg?.screen?.deleteAfterRead !== false) dropShot(shot.screenshot);
    return {
      image,
      error: image ? '' : error || '截图没能读进内存',
      reason: '',
      title: String(shot.title || ''),
      active: shot.active || null,
      fallback: shot.fallback === true,
    };
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
  async function runChatTurn({ text, cfg, files = [] }) {
    const desktop = await desktopContext();
    const mode = cfg.screen.mode || (cfg.screen.enabled === true ? 'manual' : 'off');
    // 她刚发过的图，气泡里没有文字，得单独告诉模型，否则她以为自己没发过。
    const pics = freshPics(3);
    // 聊天里能不能带图：开关在，才让她在回复里写 [[配图: …]]
    const allowPic = cfg.pic?.enabled === true && cfg.pic?.attachToChat === true;

    // 主人随消息附的文件：图片走视觉输入，文本拼进提示词，二进制只报元信息。
    const contents = attachmentContents(files);
    let canSeeImages = true;
    if (contents.images.length) {
      try {
        const support = await chat.visionSupport?.();
        if (support) {
          visionOk = support.ok === true;
          if (support.ok === false) canSeeImages = false;
        }
      } catch {}
    }
    const attachmentBlock = buildAttachmentPrompt(files, { visionOk: canSeeImages });
    const say = [String(text ?? '').trim(), attachmentBlock].filter(Boolean).join('\n').trim() || '（主人发来了附件）';
    const userImages = canSeeImages ? contents.images : [];

    let image = null;
    let result;
    // [[看一眼]] 是「申请」标记，最终回复里绝不能出现（模型有时会把它留在第二段里）。
    const dropPeek = (s) => String(s || '').replace(/\[\[看一眼\]\]/g, '').trim();
    if (mode === 'auto' && cfg.screen.enabled === true) {
      // 自动档两段式：先让她自己决定要不要看（只在回复里出一句 [[看一眼]]），
      // 真要看才拍一张、拍完再问一遍，用第二次的回复当正式回答。
      // 额度由 look() 把关（每小时 maxPerHour），且一轮最多一次。
      const first = await chat.chat({ text: say, modality: 'text', desktop, images: userImages, pics, screenMode: 'auto', allowPic });
      const firstText = String(first.reply?.text || '');
      if (first.ok && /\[\[看一眼\]\]/.test(firstText)) {
        const shotRes = await shotForChat('auto', cfg);
        image = shotRes.image;
        if (image) {
          result = await chat.chat({ text: say, modality: 'text', desktop, image, images: userImages, pics, screenMode: 'auto', allowPic });
          if (!result.ok) result = { ...first, reply: { ...(first.reply || {}), text: dropPeek(firstText) } };
        } else if (shotRes.title) {
          // 截不到画面时别装瞎也别装看见：拿窗口标题当唯一线索，再问一次。
          pluginLog('[orb-api] 自动看屏幕失败，回退窗口标题：', String(shotRes.error || ''));
          // 失败原因只进日志：PowerShell 的 stderr 又长又乱，塞给模型只会干扰它说话。
          const note = [
            '（你本来想看一眼屏幕，但这次没截到画面。）',
            `只知道主人此刻正在用的窗口标题是「${shotRes.title}」。`,
            '只根据窗口标题和聊天上下文回，别装作看到了画面，也别念窗口标题里的文件路径、账号之类的隐私。',
          ].join('');
          const retry = await chat.chat({ text: note, modality: 'text', desktop, images: userImages, pics, screenMode: '', allowPic });
          result = retry.ok ? retry : { ...first, reply: { ...(first.reply || {}), text: dropPeek(firstText) } };
          if (result.ok && result.reply) result = { ...result, reply: { ...result.reply, text: dropPeek(result.reply.text) } };
          if (result.rawReply) result = { ...result, rawReply: dropPeek(result.rawReply) };
        } else {
          result = { ...first, reply: { ...(first.reply || {}), text: dropPeek(firstText) } };
        }
      } else {
        result = first;
      }
    } else {
      // 手动档 / 老配置（attachToChat）：每条消息都顺手拍一张给她看。
      if (cfg.screen.enabled === true && cfg.screen.attachToChat !== false) {
        const shotRes = await shotForChat('chat', cfg);
        image = shotRes.image;
        if (!image) pluginLog('[orb-api] 手动档截图失败：', String(shotRes.error || ''));
      }
      result = await chat.chat({ text: say, modality: 'text', desktop, image, images: userImages, pics, allowPic });
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
          const turn = await runChatTurn({ text: job.text, cfg: job.cfg, files: job.files || [] });
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
  try { sweepInbox(path.join(picDir, 'inbox')); } catch {}

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
          // 注视 / 溜达 / 换皮：桌面端只认这几个字段，改配置后靠 writeHostFile 重写。
          gaze: pet.gaze || null,
          wander: pet.wander || null,
          avatar: pet.avatar || '',
          packId: pet.packId || '',
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

  /** 把窗口矩形收敛成 {x,y,w,h} 的整数；拿不到/太小就给 null（调用方回退整屏）。 */
  function normRect(rect) {
    const n = (v) => Number(v);
    if (!rect) return null;
    const x = n(rect.x), y = n(rect.y), w = n(rect.w ?? rect.width), h = n(rect.h ?? rect.height);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    if (w < 200 || h < 150) return null;
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  /**
   * 看屏幕（唯一入口）。
   *
   * 档位（tier）：
   *  - preview：设置页试拍，原尺寸 PNG，另存临时文件把路径回给前端；
   *  - chat：聊天里附给模型，宽 960 JPEG；
   *  - companion：陪伴字幕，宽 1280 JPEG（reason 以 companion 开头或显式 tier 指定）。
   * 只截主人此刻正在用的那个窗口；截不到窗口才回退整屏，并在 note/fallback 里说清楚。
   */
  async function look({ reason = '', small = false, manual = false, tier = '' } = {}) {
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
    const wantTier = small
      ? (/^companion/i.test(String(tier || '')) || /^companion/i.test(String(reason || '')) ? 'companion' : 'chat')
      : 'preview';
    const maxW = wantTier === 'chat' ? 960 : wantTier === 'companion' ? 1280 : 0;
    const ext = wantTier === 'preview' ? 'png' : 'jpg';
    const shotPath = path.join(shotDir, `${stamp}.${wantTier}.${ext}`);
    const windowRect = normRect(win?.active?.rect);
    const shot = await runPowerShell(SCREEN_SCRIPT, {
      env: {
        SURFCORE_ORB_SHOT: shotPath,
        SURFCORE_ORB_MAXW: String(maxW),
        SURFCORE_ORB_QUALITY: wantTier === 'preview' ? '92' : '85',
        ...(windowRect ? { SURFCORE_ORB_RECT: `${windowRect.x},${windowRect.y},${windowRect.w},${windowRect.h}` } : {}),
      },
      timeoutMs: 25000,
    });
    if (!shot.ok || !fs.existsSync(shotPath)) {
      return {
        ok: false,
        reason: 'capture-failed',
        error: `截屏失败：${String(shot.stderr || shot.error?.message || '').slice(0, 200)}`,
        title: String(win?.active?.title || '').slice(0, 120),
        windowRect,
        fallback: true,
        active: { title: String(win?.active?.title || '').slice(0, 120), name: String(win?.active?.name || '').slice(0, 60) },
        windows: (Array.isArray(win?.windows) ? win.windows : []).slice(0, 15).map((w) => ({ title: String(w?.title || '').slice(0, 120), name: String(w?.name || '').slice(0, 60) })),
      };
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
    let cap = null;
    try { cap = JSON.parse(String(shot.stdout || '').trim()); } catch {}
    const cursor = win?.cursor && Number.isFinite(Number(win.cursor.x)) && Number.isFinite(Number(win.cursor.y))
      ? { x: Math.round(Number(win.cursor.x)), y: Math.round(Number(win.cursor.y)) }
      : null;
    const source = cap?.source === 'window' ? 'window' : 'screen';
    const note = String(cap?.note || '')
      || (source !== 'window' ? (windowRect ? '窗口截取失败，回退成整屏' : '没拿到活动窗口，回退成整屏') : '');
    return {
      ok: true,
      screenshot: shotPath,
      // 设置页预览拿原尺寸 PNG；聊天/陪伴的那张不另存路径，图读进内存就删。
      preview: wantTier === 'preview' ? shotPath : '',
      mime: wantTier === 'preview' ? 'image/png' : 'image/jpeg',
      width: Number(cap?.width) || 0,
      height: Number(cap?.height) || 0,
      tier: wantTier,
      source,
      captureRect: cap?.rect ? { x: Number(cap.rect.x), y: Number(cap.rect.y), w: Number(cap.rect.w), h: Number(cap.rect.h) } : null,
      fallback: source !== 'window',
      note,
      title: String(win?.active?.title || '').slice(0, 120),
      windowRect,
      cursor,
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

  const avatarDir = path.join(root, 'avatars');
  const AVATAR_TTL_MS = 7 * 24 * 3600 * 1000;

  /** 去掉首尾引号/空白：从资源管理器「复制文件地址」贴进来的是 "C:\\…\\a.jpg"。 */
  function stripPath(value) {
    return String(value ?? '').trim().replace(/^["']+/, '').replace(/["']+$/, '').trim();
  }

  /** 设置里填的身份 + 默认身份（昵称 / QQ 号 / 自定义头像文件）归一成一份。 */
  function identOf(cfg) {
    const raw = (cfg.chat && cfg.chat.ident) || {};
    let defs = {};
    try { defs = identDefaults() || {}; } catch {}
    return {
      showAvatar: raw.showAvatar !== false,
      showName: raw.showName !== false,
      herName: String(raw.herName || defs.herName || '').trim(),
      meName: String(raw.meName || defs.meName || '').trim(),
      herQQ: String(raw.herQQ || defs.herQQ || '').replace(/[^0-9]/g, ''),
      meQQ: String(raw.meQQ || defs.meQQ || '').replace(/[^0-9]/g, ''),
      herPath: stripPath(raw.herPath),
      mePath: stripPath(raw.mePath),
    };
  }

  /**
   * 本地文件 → file:/// URL。
   * 悬浮窗页面是 `loadFile(index.html)`（file:// 源）打开的，所以 `/avatar?who=her` 这种
   * 站内相对路径会被解析成 `file:///avatar?...`，永远 404——头像就只剩一个字母点。
   */
  function fileUrl(file) {
    return `file:///${encodeURI(String(file).replace(/\\/g, '/'))}`;
  }

  /** 一个头像是谁：自定义文件优先，其次 QQ 号；两者一变，缓存的文件名就跟着变。 */
  function avatarIdent(who, id) {
    return who === 'me' ? { file: id.mePath, qq: id.meQQ } : { file: id.herPath, qq: id.herQQ };
  }

  function avatarCacheFor(who, mine) {
    const hash = crypto.createHash('sha1').update(`${mine.file}\u0000${mine.qq}`).digest('hex').slice(0, 10);
    return path.join(avatarDir, `${who}-${hash}.png`);
  }

  function avatarAge(file) {
    try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return Infinity; }
  }

  /** 同步拿一个能直接塞给 <img> 的 URL：自定义文件 > 本地缓存 > 兜底形象；都没有给空串。 */
  function avatarUrlSync(who, id) {
    const mine = avatarIdent(who, id);
    if (mine.file && fs.existsSync(mine.file)) return fileUrl(mine.file);
    const cached = avatarCacheFor(who, mine);
    if (fs.existsSync(cached)) return fileUrl(cached);
    if (!mine.qq && !mine.file) {
      const fallback = fallbackAvatar();
      if (fallback) return fileUrl(fallback);
    }
    return '';
  }

  const avatarPatching = new Set();

  /** 后台把 QQ 头像拉下来（不卡 /state）；拉不下来就下一轮再试。 */
  function ensureAvatar(who, id) {
    const mine = avatarIdent(who, id);
    if (mine.file && fs.existsSync(mine.file)) return;
    if (!mine.qq) return;
    const cached = avatarCacheFor(who, mine);
    if (avatarAge(cached) < AVATAR_TTL_MS) return;
    const lock = `${who}:${path.basename(cached)}`;
    if (avatarPatching.has(lock)) return;
    avatarPatching.add(lock);
    void (async () => {
      try {
        const ok = await downloadAvatar(`https://q1.qlogo.cn/g?b=qq&nk=${mine.qq}&s=640`, cached);
        if (ok) sweepAvatarCache(who, cached);
      } finally {
        avatarPatching.delete(lock);
      }
    })();
  }

  /** 同一个人的旧缓存（换过 QQ 号 / 清过缓存）顺手删掉，别越攒越多。 */
  function sweepAvatarCache(who, keep) {
    try {
      for (const name of fs.readdirSync(avatarDir)) {
        if (!name.startsWith(`${who}-`) || name === path.basename(keep)) continue;
        if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(name)) continue;
        fs.rmSync(path.join(avatarDir, name), { force: true });
      }
    } catch {}
  }

  function resolveIdent(cfg) {
    const id = identOf(cfg);
    return {
      showAvatar: id.showAvatar,
      showName: id.showName,
      her: {
        name: id.herName || '她',
        qq: id.herQQ,
        avatarUrl: id.showAvatar ? avatarUrlSync('her', id) : '',
      },
      me: {
        name: id.meName || '主人',
        qq: id.meQQ,
        avatarUrl: id.showAvatar ? avatarUrlSync('me', id) : '',
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
   * 头像落地成文件：自定义路径 → 本地缓存（按身份分文件名，7 天）→ QQ 头像（qlogo）→ 兜底形象。
   * 返回 { file, type }；都不行就 file:null，渲染端画个字母。
   */
  async function avatarResolve(who, cfg) {
    const id = identOf(cfg);
    const mine = avatarIdent(who, id);
    if (mine.file && fs.existsSync(mine.file)) return { file: mine.file, type: guessType(mine.file) };

    const cacheFile = avatarCacheFor(who, mine);
    if (fs.existsSync(cacheFile) && avatarAge(cacheFile) < AVATAR_TTL_MS) return { file: cacheFile, type: 'image/png' };

    if (mine.qq) {
      const url = `https://q1.qlogo.cn/g?b=qq&nk=${mine.qq}&s=640`;
      if (await downloadAvatar(url, cacheFile)) {
        sweepAvatarCache(who, cacheFile);
        return { file: cacheFile, type: 'image/png' };
      }
    }
    const fallback = fallbackAvatar();
    return { file: fallback, type: 'image/png' };
  }

  const companion = injectedCompanion || createOrbCompanionService({
    orb,
    chat,
    look,
    getConfig: () => orb.readConfig(),
    log: (...args) => pluginLog('[companion]', ...args),
    onMessage: typeof archiveMessage === 'function' ? archiveMessage : null,
  });

  function stateForOrb() {
    const cfg = orb.readConfig();
    // 头像在后台补：这里只做「已经把文件放好了没」的同步判断，拉 QQ 头像不卡 /state。
    try {
      const id = identOf(cfg);
      ensureAvatar('her', id);
      ensureAvatar('me', id);
    } catch {}
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
        visionOk: visionOk !== false,
        // 排队状态：球上的「在想」和输入框的空闲收起都看这个。
        queue: { pending: chatQueue.length, busy: chatBusy },
      },
      purpose: { focus },
      companion: companion.status(),
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
      try { body = JSON.parse((await readBody(req, CHAT_BODY_LIMIT)) || '{}'); } catch {
        json(res, 400, { ok: false, error: '请求体不是合法 JSON（附件太大也会这样）' });
        return;
      }
      const cfg = orb.readConfig();
      if (cfg.chat.enabled !== true) {
        json(res, 409, { ok: false, error: '她现在不在这边聊（设置 → 悬浮窗 → 互动）' });
        return;
      }
      const text = String(body.text ?? '').trim();
      const rawFiles = Array.isArray(body.files) ? body.files : [];
      if (!text && !rawFiles.length) { json(res, 400, { ok: false, error: '说点什么吧' }); return; }

      // 附件先统一落盘/校验：任何一条不合格都整条拒绝，避免悄悄少附件。
      const normalized = normalizeAttachments(rawFiles, {
        mediaDir: picDir,
        inboxDir: path.join(picDir, 'inbox'),
      });
      if (!normalized.ok) { json(res, 400, { ok: false, error: normalized.error }); return; }
      const files = normalized.files;
      const display = displayFiles(files, { mediaDir: picDir });
      const say = text || '（只发了附件，没配文字）';

      // 排队模式：先把「我」这条写进去、立刻回 200，让她在后台一条条回。
      // 客户端把非 2xx 当失败，所以这里必须 200，不能 202。
      if (body.queue === true) {
        if (chatQueue.length >= CHAT_QUEUE_MAX) {
          json(res, 429, { ok: false, error: `排队太多条了（最多 ${CHAT_QUEUE_MAX} 条），等前面几条回完再说` });
          return;
        }
        orb.addMessage({ who: 'me', text: say, kind: 'chat', files: display });
        chatQueue.push({ text, cfg, files });
        const position = chatQueue.length + (chatBusy ? 1 : 0);
        void pumpChatQueue();
        json(res, 200, { ok: true, queued: true, position, state: stateForOrb() });
        return;
      }

      orb.addMessage({ who: 'me', text: say, kind: 'chat', files: display });
      const turn = await runChatTurn({ text, cfg, files });
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
      const shot = await look({ reason: 'eye', small: true, manual: true, tier: 'chat' });
      if (!shot.ok) {
        json(res, 200, {
          ok: false,
          enabled: true,
          mode: openedScreen.mode,
          visionOk,
          reason: shot.reason,
          error: shot.error || '拍不到屏幕',
          title: shot.title || '',
          windowRect: shot.windowRect ?? null,
          source: shot.source || '',
          fallback: shot.fallback === true,
          screen: openedScreen,
        });
        return;
      }
      let image = null;
      try {
        const buf = fs.readFileSync(shot.screenshot);
        if (buf.length > 0 && buf.length <= 900 * 1024) {
          image = { mimeType: shot.mime || 'image/jpeg', data: buf.toString('base64') };
        }
      } catch (error) {
        pluginLog('[orb-api] 读截图失败：', String(error?.message ?? error));
      }
      if (cfg.screen.deleteAfterRead !== false) dropShot(shot.screenshot);

      const probe = [
        shot.title
          ? `（这是主人此刻正在用的窗口：标题「${shot.title}」。）`
          : '（这是主人此刻的屏幕。）',
        shot.source === 'window'
          ? '只看这个窗口：一句话说你真正注意到的内容（窗口里在做什么、画面大概是什么），再用你自己的口气跟主人说一句。'
          : '这次没抓到活动窗口、只截到了整张屏幕，就说你注意到的内容。',
        '不要念文件名、聊天内容、账号、地址或任何数字；拿不准的就别提。',
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
        title: shot.title || '',
        windowRect: shot.windowRect ?? null,
        cursor: shot.cursor ?? null,
        tier: shot.tier || '',
        source: shot.source || '',
        captureRect: shot.captureRect ?? null,
        fallback: shot.fallback === true,
        bytes: shot.bytes || 0,
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
    if (suffix === '/companion') {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, companion: companion.status() });
        return;
      }
      if (req.method === 'POST') {
        let body = {};
        try { body = JSON.parse((await readBody(req, ORB_BODY_LIMIT)) || '{}'); } catch {}
        const action = String(body.action || 'status').trim().toLowerCase();
        if (action === 'start') {
          const result = await companion.start({ sessionId: body.sessionId });
          json(res, result.ok ? 200 : 400, result);
          return;
        }
        if (action === 'stop') {
          json(res, 200, companion.stop('api'));
          return;
        }
        if (action === 'reply') {
          const result = await companion.reply(body.text);
          json(res, result.ok ? 200 : 400, result);
          return;
        }
        if (action === 'config') {
          const patch = body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch) ? body.patch : {};
          const cur = orb.readConfig();
          const next = orb.writeConfig({ ...cur, companion: { ...(cur.companion || {}), ...patch } });
          json(res, 200, { ok: true, companion: companion.status(), config: next.companion });
          return;
        }
        json(res, 200, { ok: true, companion: companion.status() });
        return;
      }
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
    companion,
  };
}
