# Interaction activity sampler: foreground window + file/project parsed from the title,
# currently playing media (WinRT), and the cursor position.
#
# Called by lib/orb-activity.js as:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/activity.ps1
# It prints exactly one UTF-8 JSON line to stdout:
#   {"at":<epoch ms>,"active":{"app","title","kind","file","project"}|null,
#    "media":{"app","title","artist","status"}|null,"cursor":{"x","y"}}
#
# Rules:
#   - Every failure degrades a single field to null/empty; the script never aborts.
#   - When the title hits denyTitles the whole `active` becomes null (no file/project leak).
#   - No Write-Host: stdout must stay pure JSON.
#
# NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 decodes BOM-less
# .ps1 files as ANSI, so CJK literals here are built from code points instead.

[CmdletBinding()]
param(
  [string]$DenyTitlesJson = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Last-resort safety net: whatever blows up, the host still gets one valid JSON line.
trap {
  if ($env:SURFCORE_ACTIVITY_DEBUG) {
    [Console]::Error.WriteLine('stack=' + $_.ScriptStackTrace)
    [Console]::Error.WriteLine('error=' + $_.Exception.ToString())
  }
  $fallback = '{"at":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ',"active":null,"media":null,"cursor":{"x":0,"y":0}}'
  [Console]::Out.WriteLine($fallback)
  exit 0
}

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class SurfCoreActivity
{
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
}
'@

# CJK literals as code points (see NOTE above). Use -join: [string]::Concat(char,char,..)
# trips the PowerShell 5.1 dynamic overload resolver (ArgumentNullException).
$cnCompanion = -join @([char]0x966A, [char]0x4F34, [char]0x5B57, [char]0x5E55)   # companion subtitle
$cnNotepad = -join @([char]0x8BB0, [char]0x4E8B, [char]0x672C)                   # Windows Notepad

function Get-CursorPoint {
  $pt = New-Object SurfCoreActivity+POINT
  if ([SurfCoreActivity]::GetCursorPos([ref]$pt)) {
    return [ordered]@{ x = [int]$pt.X; y = [int]$pt.Y }
  }
  return [ordered]@{ x = 0; y = 0 }
}

function Get-ForegroundInfo {
  $hwnd = [SurfCoreActivity]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  $sb = New-Object System.Text.StringBuilder 1024
  [void][SurfCoreActivity]::GetWindowTextW($hwnd, $sb, $sb.Capacity)
  $title = $sb.ToString()
  $procId = [uint32]0
  [void][SurfCoreActivity]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  $procName = ''
  try {
    $proc = Get-Process -Id $procId -ErrorAction Stop
    $procName = [string]$proc.ProcessName
  } catch { }
  return [ordered]@{
    title = $title
    pid   = [int]$procId
    proc  = $procName
  }
}

# Split "file - project - App" style titles. Only for known editors; everything else
# keeps just the title (file/project stay empty).
function Split-EditorTitle {
  param([string]$Title, [string]$Proc)

  $file = ''
  $project = ''
  $t = ($Title -replace '^[\*\u25CF\u2022\u25AA]\s*', '').Trim()
  if (-not $t) { return @{ file = ''; project = '' } }

  $procKey = ($Proc -replace '\.exe$', '').ToLowerInvariant()
  $editors = @(
    'code', 'code - insiders', 'cursor', 'vscodium', 'windsurf',
    'sublime_text', 'notepad', 'notepad++', 'notepad3',
    'idea64', 'pycharm64', 'webstorm64', 'goland64', 'clion64',
    'rider64', 'phpstorm64', 'rubymine64', 'datagrip64', 'devenv', 'studio64'
  )
  if ($editors -notcontains $procKey) { return @{ file = ''; project = '' } }

  # Drop the trailing " - App Name" segment.
  $parts = [regex]::Split($t, '\s+[-\u2013]\s+')
  if ($parts.Count -ge 2) {
    $last = $parts[$parts.Count - 1]
    $appNames = @('Visual Studio Code', 'Visual Studio Code - Insiders', 'Cursor', 'VSCodium',
      'Sublime Text', $cnNotepad, 'Notepad', 'Notepad++', 'Notepad3',
      'IntelliJ IDEA', 'PyCharm', 'WebStorm', 'GoLand', 'CLion', 'Rider',
      'PhpStorm', 'RubyMine', 'DataGrip', 'Android Studio', 'Visual Studio')
    $isAppName = $false
    foreach ($name in $appNames) {
      if ($last -eq $name -or $last.StartsWith("$name ")) { $isAppName = $true; break }
    }
    if ($isAppName) {
      $t = (@($parts[0..($parts.Count - 2)]) -join ' - ').Trim()
    }
  }

  # VS Code / Cursor: "file - project"; JetBrains also uses "project - file". We just
  # expose both segments and let the host decide how to present them.
  $segs = @([regex]::Split($t, '\s+[\u2014\u2013]\s+') | Where-Object { $_ -ne '' })
  if ($segs.Count -ge 2) {
    $file = $segs[0].Trim()
    $project = $segs[1].Trim()
  } elseif ($segs.Count -eq 1) {
    $file = $segs[0].Trim()
  }
  return @{ file = $file; project = $project }
}

function Get-ActivityKind {
  param([string]$Proc)
  $key = ($Proc -replace '\.exe$', '').ToLowerInvariant()
  if ($key -match '^(chrome|msedge|firefox|brave|opera|vivaldi|arc|360se|360chrome|qqbrowser|sogouexplorer|iexplore)$') { return 'browser' }
  if ($key -match '^(windowsterminal|wt|powershell|pwsh|cmd|conhost|alacritty|wezterm|mintty|tabby)$') { return 'terminal' }
  if ($key -match '^(spotify|cloudmusic|qqmusic|kugou|foobar2000|aimp|musicbee|itunes|applemusic|deezer|tidal)$') { return 'music' }
  if ($key -match '^(code|cursor|vscodium|windsurf|sublime_text|notepad|notepad\+\+|notepad3|idea64|pycharm64|webstorm64|goland64|clion64|rider64|phpstorm64|rubymine64|datagrip64|devenv|studio64)$') { return 'editor' }
  if ($key -match '^(explorer|findmy|winword|excel|powerpnt|wps|et|wpp|acrobat|acrord32|sumatrapdf|foxitreader)$') { return 'document' }
  if ($key -match '^(qq|wechat|weixin|telegram|discord|slack|feishu|lark|dingtalk)$') { return 'chat' }
  return 'app'
}

# WinRT media info. Any unsupported step / missing session returns $null.
function Get-MediaInfo {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop | Out-Null
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
      })[0]
    if (-not $asTaskGeneric) { return $null }

    function Await-Op($operation, [Type]$resultType) {
      $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
      if (-not $task.Wait(2500)) { return $null }
      return $task.Result
    }

    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $manager = Await-Op ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    if (-not $manager) { return $null }
    $session = $manager.GetCurrentSession()
    if (-not $session) { return $null }

    $props = Await-Op ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $playback = $null
    try { $playback = $session.GetPlaybackInfo() } catch { }
    $status = ''
    if ($playback) {
      try { $status = ([string]$playback.PlaybackStatus).ToLowerInvariant() } catch { }
    }
    $title = ''
    $artist = ''
    $album = ''
    if ($props) {
      try { $title = [string]$props.Title } catch { }
      try { $artist = [string]$props.Artist } catch { }
      try { $album = [string]$props.AlbumTitle } catch { }
    }
    if (-not $title) { return $null }
    $app = ''
    try { $app = [string]$session.SourceAppUserModelId } catch { }
    return [ordered]@{
      app    = $app
      title  = $title
      artist = $artist
      album  = $album
      status = $status
    }
  } catch {
    return $null
  }
}

# --- main -------------------------------------------------------------------
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$active = $null
$media = $null
$cursor = [ordered]@{ x = 0; y = 0 }

try { $cursor = Get-CursorPoint } catch { }

$fg = $null
try { $fg = Get-ForegroundInfo } catch { }
if ($env:SURFCORE_ACTIVITY_DEBUG) {
  [Console]::Error.WriteLine('foreground=' + ($fg | ConvertTo-Json -Compress -Depth 3))
}

# Test hooks: let the node regression test (scripts/test-orb-activity.mjs) feed a synthetic
# window title / process so title parsing and the deny list can be checked headlessly.
if ($env:SURFCORE_ACTIVITY_TITLE) {
  if (-not $fg) { $fg = [ordered]@{ title = ''; pid = 0; proc = '' } }
  $fg.title = [string]$env:SURFCORE_ACTIVITY_TITLE
}
if ($env:SURFCORE_ACTIVITY_PROC) {
  if (-not $fg) { $fg = [ordered]@{ title = ''; pid = 0; proc = '' } }
  $fg.proc = [string]$env:SURFCORE_ACTIVITY_PROC
}

# Title deny list (privacy): comes from orb.screen.denyTitles via argument or env var.
$denyTitles = @()
if (-not $DenyTitlesJson -and $env:SURFCORE_ACTIVITY_DENY) { $DenyTitlesJson = $env:SURFCORE_ACTIVITY_DENY }
if ($DenyTitlesJson) {
  try {
    $parsed = $DenyTitlesJson | ConvertFrom-Json
    if ($parsed) { $denyTitles = @($parsed | ForEach-Object { [string]$_ } | Where-Object { $_ }) }
  } catch { }
}

$blocked = $false
if ($fg) {
  $titleText = [string]$fg.title
  foreach ($word in $denyTitles) {
    if ($word -and $titleText -and $titleText.IndexOf($word, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $blocked = $true
      break
    }
  }
}

if ($fg -and -not $blocked) {
  # Our own overlay windows (SurfCore pet / ball / companion subtitle) are not "what the
  # user is doing" and must not feed back into the companion loop.
  $isOwn = ([string]$fg.title).StartsWith('SurfCore') -or [string]$fg.title -eq $cnCompanion
  if (-not $isOwn) {
    $split = Split-EditorTitle -Title ([string]$fg.title) -Proc ([string]$fg.proc)
    $active = [ordered]@{
      app     = [string]$fg.proc
      title   = [string]$fg.title
      kind    = (Get-ActivityKind -Proc ([string]$fg.proc))
      file    = [string]$split.file
      project = [string]$split.project
    }
  }
}

try { $media = Get-MediaInfo } catch { $media = $null }

$out = [ordered]@{
  at     = $now
  active = $active
  media  = $media
  cursor = $cursor
}

$json = ConvertTo-Json -InputObject $out -Compress -Depth 6
[Console]::Out.WriteLine($json)
