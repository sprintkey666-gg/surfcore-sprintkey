// 全量记忆卡备份 / 定时同步 / 私聊主人。
//
// 设计要点（2026-10-31 主人需求）：
// - 备份是「镜像 + 增量」：jsonl 从备份文件已有字节处续写；目标比源还大（卡被重建/截断）时整份重写。
//   不做按日期快照，因为全量卡上限 10GB，快照会迅速把磁盘吃光。
// - 发送直接读源文件，不依赖备份目录是否开启，保证发出去的是当前卡。
// - QQ 不在线不算一次失败：不推进 lastSendAt，只在状态里记「等 QQ 上线」；
//   桥接每 60 秒 tick，QQ 一就绪就补发。真正发送失败则 30 分钟后重试。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 86_400_000;
const BACKUP_RETRY_MS = 10 * 60_000;
const SEND_RETRY_MS = 30 * 60_000;

export const MEMORY_BACKUP_VERSION = 1;

export const DEFAULT_MEMORY_CARD_BACKUP = Object.freeze({
  enabled: false,
  dir: '',
  syncEveryDays: 1,
  send: Object.freeze({
    enabled: false,
    everyDays: 7,
    maxSendMB: 90,
  }),
});

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeMemoryCardBackupConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const sendRaw = src.send && typeof src.send === 'object' && !Array.isArray(src.send) ? src.send : {};
  return {
    enabled: src.enabled === true,
    dir: String(src.dir ?? '').trim(),
    syncEveryDays: clampInt(src.syncEveryDays, DEFAULT_MEMORY_CARD_BACKUP.syncEveryDays, 1, 365),
    send: {
      enabled: sendRaw.enabled === true,
      everyDays: clampInt(sendRaw.everyDays, DEFAULT_MEMORY_CARD_BACKUP.send.everyDays, 1, 365),
      maxSendMB: clampInt(sendRaw.maxSendMB, DEFAULT_MEMORY_CARD_BACKUP.send.maxSendMB, 1, 100),
    },
  };
}

function safeCharacterId(id) {
  const text = String(id ?? '').trim();
  if (!text) return 'legacy';
  return text.replace(/[^\w.-]/g, '_').slice(0, 80) || 'legacy';
}

export function defaultBackupDir(dshHome, characterId) {
  return path.join(String(dshHome), 'surfcore', 'memory-backups', safeCharacterId(characterId));
}

export function memoryBackupStateFile(dshHome) {
  return path.join(String(dshHome), 'surfcore', 'memory-card-backup.json');
}

export function dueSince(lastAt, everyDays, now = Date.now()) {
  const last = Number(lastAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  const days = clampInt(everyDays, 1, 1, 365);
  return now - last >= days * DAY_MS;
}

export function nextDueAt(lastAt, everyDays) {
  const last = Number(lastAt);
  if (!Number.isFinite(last) || last <= 0) return null;
  return last + clampInt(everyDays, 1, 1, 365) * DAY_MS;
}

export function readMemoryBackupState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const characters = raw?.characters;
    return {
      version: MEMORY_BACKUP_VERSION,
      characters: characters && typeof characters === 'object' && !Array.isArray(characters) ? characters : {},
    };
  } catch {
    return { version: MEMORY_BACKUP_VERSION, characters: {} };
  }
}

export function writeMemoryBackupState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function emptyRecord() {
  return {
    lastBackupAt: 0,
    lastBackupBytes: 0,
    lastBackupOk: false,
    lastBackupError: '',
    lastBackupAttemptAt: 0,
    lastSendAt: 0,
    lastSendBytes: 0,
    lastSendOk: false,
    lastSendError: '',
    lastSendAttemptAt: 0,
  };
}

function normalizeRecord(rec) {
  const base = emptyRecord();
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return base;
  for (const key of Object.keys(base)) {
    if (typeof base[key] === 'boolean') base[key] = rec[key] === true;
    else if (typeof base[key] === 'number') {
      const n = Number(rec[key]);
      base[key] = Number.isFinite(n) && n >= 0 ? n : 0;
    } else base[key] = String(rec[key] ?? '');
  }
  return base;
}

function recordFor(doc, characterId) {
  const key = safeCharacterId(characterId);
  if (!doc.characters[key] || typeof doc.characters[key] !== 'object') doc.characters[key] = emptyRecord();
  doc.characters[key] = normalizeRecord(doc.characters[key]);
  return doc.characters[key];
}

function fileInfo(file) {
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return { path: file, bytes: stat.size, mtime: stat.mtimeMs };
  } catch {
    return null;
  }
}

async function copyIncremental(srcFile, destFile) {
  const srcStat = await fsp.stat(srcFile);
  let destSize = 0;
  try {
    destSize = (await fsp.stat(destFile)).size;
  } catch {
    destSize = 0;
  }
  // 目标比源大 → 源被重建/截断了，不能续写，整份重来。
  if (destSize > srcStat.size) destSize = 0;
  if (destSize === srcStat.size) return srcStat.size;
  if (destSize === 0) {
    await fsp.copyFile(srcFile, destFile);
    return srcStat.size;
  }
  await new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(srcFile, { start: destSize });
    const writeStream = fs.createWriteStream(destFile, { flags: 'a' });
    readStream.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
    readStream.pipe(writeStream);
  });
  return srcStat.size;
}

async function copyAtomic(srcFile, destFile) {
  const tmp = `${destFile}.tmp-${process.pid}-${Date.now()}`;
  await fsp.copyFile(srcFile, tmp);
  try {
    await fsp.rename(tmp, destFile);
  } catch (error) {
    // Windows 上目标偶尔被占用（杀毒/预览）时 rename 会 EPERM；删掉目标再改名。
    try {
      await fsp.rm(destFile, { force: true });
      await fsp.rename(tmp, destFile);
    } catch {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }
}

function toFileUrl(absPath) {
  return `file:///${String(absPath).replace(/\\/g, '/')}`;
}

function samePath(a, b) {
  const pa = path.resolve(String(a || ''));
  const pb = path.resolve(String(b || ''));
  return process.platform === 'win32' ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

function dateStamp(nowMs) {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function mb(bytes) {
  return `${(Number(bytes || 0) / 1048576).toFixed(1)} MB`;
}

export function createMemoryCardBackupService(options = {}) {
  const {
    dshHome,
    getConfig = () => ({}),
    getSource = () => null,
    getOwnerQQ = () => '',
    isQQReady = () => false,
    sendSegments = async () => { throw new Error('发送通道未接入'); },
    log = () => {},
    now = () => Date.now(),
    stateFile = memoryBackupStateFile(dshHome),
  } = options;

  let running = false;

  const readDoc = () => readMemoryBackupState(stateFile);
  const saveDoc = (doc) => writeMemoryBackupState(stateFile, doc);

  function resolveDir(config, src) {
    const custom = String(config.dir || '').trim();
    if (custom) return path.resolve(custom);
    return defaultBackupDir(dshHome, src?.characterId);
  }

  function sourceSnapshot() {
    const src = getSource() || {};
    return {
      characterId: String(src.characterId || 'legacy'),
      characterName: String(src.characterName || src.characterId || '当前角色'),
      dir: String(src.dir || ''),
      jsonl: fileInfo(src.jsonl),
      markdown: fileInfo(src.markdown),
      stats: fileInfo(src.stats),
    };
  }

  async function runBackup({ manual = false } = {}) {
    const config = normalizeMemoryCardBackupConfig(getConfig());
    if (!manual && !config.enabled) return { ok: false, error: '备份总开关未开启' };
    const src = sourceSnapshot();
    if (!src.dir || !src.jsonl) return { ok: false, error: '找不到全量记忆卡（memory-card-full.jsonl 尚未生成）' };
    const dir = resolveDir(config, src);
    if (samePath(dir, src.dir)) {
      return { ok: false, error: '备份目录不能是记忆卡目录本身，请换一个目录' };
    }
    const at = now();
    const doc = readDoc();
    const rec = recordFor(doc, src.characterId);
    try {
      fs.mkdirSync(dir, { recursive: true });
      let bytes = 0;
      bytes += await copyIncremental(src.jsonl.path, path.join(dir, 'memory-card-full.jsonl'));
      if (src.markdown) {
        await copyAtomic(src.markdown.path, path.join(dir, 'memory-card-full.md'));
        bytes += src.markdown.bytes;
      }
      if (src.stats) {
        await copyAtomic(src.stats.path, path.join(dir, 'memory-card-full-stats.json'));
        bytes += src.stats.bytes;
      }
      rec.lastBackupAt = at;
      rec.lastBackupAttemptAt = at;
      rec.lastBackupBytes = bytes;
      rec.lastBackupOk = true;
      rec.lastBackupError = '';
      saveDoc(doc);
      log(`[记忆备份] 已同步 ${src.characterId} → ${dir}（${mb(bytes)}）`);
      return { ok: true, action: 'backup', dir, bytes, at, characterId: src.characterId };
    } catch (error) {
      const message = String(error?.message ?? error);
      rec.lastBackupAttemptAt = at;
      rec.lastBackupOk = false;
      rec.lastBackupError = message;
      saveDoc(doc);
      log(`[记忆备份] 备份失败：${message}`);
      return { ok: false, action: 'backup', error: message, dir, at };
    }
  }

  async function runSend({ manual = false } = {}) {
    const config = normalizeMemoryCardBackupConfig(getConfig());
    if (!manual && !config.send.enabled) return { ok: false, error: '发送开关未开启' };
    const src = sourceSnapshot();
    if (!src.jsonl) return { ok: false, error: '找不到全量记忆卡（memory-card-full.jsonl 尚未生成）' };
    const owner = String(getOwnerQQ() ?? '').replace(/\D/g, '');
    if (!owner) return { ok: false, error: '未设置主人 QQ（config.json 的 admin.qq / ownerQQ）' };
    if (!isQQReady()) return { ok: false, error: 'QQ 未连接（SnowLuma 未启动或未登录），先不发送' };
    const maxBytes = config.send.maxSendMB * 1024 * 1024;
    if (src.jsonl.bytes > maxBytes) {
      const at = now();
      const doc = readDoc();
      const rec = recordFor(doc, src.characterId);
      const message = `全量卡 ${mb(src.jsonl.bytes)} 超过单次上限 ${config.send.maxSendMB} MB，未发送（可调高上限，或先手动存档）`;
      rec.lastSendAttemptAt = at;
      rec.lastSendOk = false;
      rec.lastSendError = message;
      saveDoc(doc);
      log(`[记忆备份] ${message}`);
      return { ok: false, action: 'send', error: message, at };
    }
    const at = now();
    const doc = readDoc();
    const rec = recordFor(doc, src.characterId);
    const stamp = dateStamp(at);
    const skipped = [];
    const segments = [{
      type: 'text',
      data: { text: `全量记忆卡备份（${src.characterName}） ${new Date(at).toLocaleString('zh-CN')}` },
    }];
    segments.push({
      type: 'file',
      data: { file: toFileUrl(src.jsonl.path), name: `memory-card-full-${stamp}.jsonl` },
    });
    if (src.markdown) {
      if (src.markdown.bytes <= maxBytes) {
        segments.push({ type: 'file', data: { file: toFileUrl(src.markdown.path), name: `memory-card-full-${stamp}.md` } });
      } else skipped.push(`md（${mb(src.markdown.bytes)}）超过上限，已跳过`);
    }
    if (src.stats) {
      if (src.stats.bytes <= maxBytes) {
        segments.push({ type: 'file', data: { file: toFileUrl(src.stats.path), name: `memory-card-full-${stamp}-stats.json` } });
      } else skipped.push(`stats（${mb(src.stats.bytes)}）超过上限，已跳过`);
    }
    try {
      await sendSegments(segments);
      const bytes = src.jsonl.bytes + (src.markdown?.bytes ?? 0) + (src.stats?.bytes ?? 0);
      rec.lastSendAt = at;
      rec.lastSendAttemptAt = at;
      rec.lastSendBytes = bytes;
      rec.lastSendOk = true;
      rec.lastSendError = '';
      saveDoc(doc);
      log(`[记忆备份] 已私聊主人 ${owner}：${segments.length - 1} 个文件${skipped.length ? `（${skipped.join('；')}）` : ''}`);
      return { ok: true, action: 'send', owner, files: segments.length - 1, bytes, skipped, at, characterId: src.characterId };
    } catch (error) {
      const message = String(error?.message ?? error);
      rec.lastSendAttemptAt = at;
      rec.lastSendOk = false;
      rec.lastSendError = message;
      saveDoc(doc);
      log(`[记忆备份] 发送失败：${message}`);
      return { ok: false, action: 'send', error: message, owner, at };
    }
  }

  async function markSendWaiting() {
    const src = sourceSnapshot();
    const doc = readDoc();
    const rec = recordFor(doc, src.characterId);
    const message = 'QQ 未连接，等到上线后自动补发';
    if (rec.lastSendError !== message) {
      rec.lastSendError = message;
      saveDoc(doc);
    }
  }

  async function tick() {
    if (running) return { ok: true, skipped: true };
    running = true;
    try {
      const config = normalizeMemoryCardBackupConfig(getConfig());
      const src = sourceSnapshot();
      const doc = readDoc();
      const rec = recordFor(doc, src.characterId);
      const at = now();
      if (config.enabled) {
        const due = dueSince(rec.lastBackupAt, config.syncEveryDays, at);
        const retryReady = !rec.lastBackupAttemptAt || rec.lastBackupOk || at - rec.lastBackupAttemptAt >= BACKUP_RETRY_MS;
        if (due && retryReady) await runBackup({ manual: false });
      }
      if (config.send.enabled) {
        const fresh = recordFor(readDoc(), src.characterId);
        const due = dueSince(fresh.lastSendAt, config.send.everyDays, now());
        const retryReady = !fresh.lastSendAttemptAt || fresh.lastSendOk || now() - fresh.lastSendAttemptAt >= SEND_RETRY_MS;
        if (due && retryReady) {
          if (!isQQReady()) await markSendWaiting();
          else await runSend({ manual: false });
        }
      }
      return { ok: true };
    } catch (error) {
      log(`[记忆备份] tick 失败：${String(error?.message ?? error)}`);
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      running = false;
    }
  }

  async function runAction(action) {
    const name = String(action || '').trim().toLowerCase();
    if (name === 'backup') return runBackup({ manual: true });
    if (name === 'send') return runSend({ manual: true });
    if (name === 'both') {
      const backup = await runBackup({ manual: true });
      const send = await runSend({ manual: true });
      const error = [backup.error, send.error].filter(Boolean).join('；');
      return { ok: backup.ok && send.ok, action: 'both', backup, send, error };
    }
    if (name === 'status' || !name) return { ok: true, action: 'status' };
    return { ok: false, error: `未知操作：${name}` };
  }

  function status() {
    const config = normalizeMemoryCardBackupConfig(getConfig());
    const src = sourceSnapshot();
    const dir = resolveDir(config, src);
    const doc = readDoc();
    const rec = recordFor(doc, src.characterId);
    const at = now();
    const mirror = {
      jsonl: fileInfo(path.join(dir, 'memory-card-full.jsonl')),
      markdown: fileInfo(path.join(dir, 'memory-card-full.md')),
      stats: fileInfo(path.join(dir, 'memory-card-full-stats.json')),
    };
    return {
      ok: true,
      config,
      characterId: src.characterId,
      characterName: src.characterName,
      memoryDir: src.dir,
      dir,
      qqReady: isQQReady() === true,
      ownerQQ: String(getOwnerQQ() ?? '').replace(/\D/g, ''),
      files: { jsonl: src.jsonl, markdown: src.markdown, stats: src.stats },
      mirror,
      state: { ...rec },
      nextBackupAt: config.enabled ? nextDueAt(rec.lastBackupAt, config.syncEveryDays) : null,
      nextSendAt: config.send.enabled ? nextDueAt(rec.lastSendAt, config.send.everyDays) : null,
      backupDue: config.enabled && dueSince(rec.lastBackupAt, config.syncEveryDays, at),
      sendDue: config.send.enabled && dueSince(rec.lastSendAt, config.send.everyDays, at),
    };
  }

  return { status, tick, runAction, runBackup, runSend };
}
