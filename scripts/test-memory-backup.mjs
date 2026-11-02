import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MEMORY_CARD_BACKUP,
  createMemoryCardBackupService,
  defaultBackupDir,
  dueSince,
  memoryBackupStateFile,
  nextDueAt,
  normalizeMemoryCardBackupConfig,
  readMemoryBackupState,
} from '../src/memory-backup.js';

const DAY = 86_400_000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-backup-test-'));
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sourceFixture(id = 'char-test') {
  const dir = path.join(tmp, 'characters', id, 'memory');
  const jsonl = path.join(dir, 'memory-card-full.jsonl');
  const markdown = path.join(dir, 'memory-card-full.md');
  const stats = path.join(dir, 'memory-card-full-stats.json');
  write(jsonl, '{"id":1}\n');
  write(markdown, '# 全量卡\n');
  write(stats, '{"records":1}');
  return { characterId: id, characterName: '测试角色', dir, jsonl, markdown, stats };
}

test('默认配置关闭、目录为空、全发开、1 天 / 7 天 / 90MB', () => {
  const cfg = normalizeMemoryCardBackupConfig(undefined);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.dir, '');
  assert.equal(cfg.syncEveryDays, 1);
  assert.equal(cfg.send.enabled, false);
  assert.equal(cfg.send.fullArchive, true);
  assert.equal(cfg.send.everyDays, 7);
  assert.equal(cfg.send.maxSendMB, 90);
  assert.deepEqual(DEFAULT_MEMORY_CARD_BACKUP.send, { enabled: false, fullArchive: true, everyDays: 7, maxSendMB: 90 });
});

test('坏值收敛：天数 1~365、上限 1~100、enabled 只认 true', () => {
  const cfg = normalizeMemoryCardBackupConfig({
    enabled: 'yes', dir: '  D:\\备份  ', syncEveryDays: 0,
    send: { enabled: 1, everyDays: 999, maxSendMB: -3 },
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.dir, 'D:\\备份');
  assert.equal(cfg.syncEveryDays, 1);
  assert.equal(cfg.send.enabled, false);
  assert.equal(cfg.send.everyDays, 365);
  assert.equal(cfg.send.maxSendMB, 1);
});

test('默认目录带角色 id，非法字符被替换', () => {
  const dir = defaultBackupDir('C:\\Users\\x\\.dsh', 'char/坏');
  assert.ok(dir.endsWith(path.join('surfcore', 'memory-backups', 'char__')));
  assert.equal(memoryBackupStateFile('C:\\Users\\x\\.dsh'), path.join('C:\\Users\\x\\.dsh', 'surfcore', 'memory-card-backup.json'));
});

test('dueSince / nextDueAt', () => {
  const now = 1_000 * DAY;
  assert.equal(dueSince(0, 1, now), true);
  assert.equal(dueSince(now - 2 * DAY, 1, now), true);
  assert.equal(dueSince(now - DAY / 2, 1, now), false);
  assert.equal(dueSince(now - 2 * DAY, 7, now), false);
  assert.equal(nextDueAt(now - 2 * DAY, 7), now + 5 * DAY);
  assert.equal(nextDueAt(0, 7), null);
});

test('镜像备份：首次复制、追加增量、源被截断时整份重写', async () => {
  const src = sourceFixture();
  const stateFile = path.join(tmp, 'state.json');
  const svc = createMemoryCardBackupService({
    dshHome: tmp,
    stateFile,
    getConfig: () => ({ enabled: true, dir: path.join(tmp, 'backup'), syncEveryDays: 1 }),
    getSource: () => src,
    getOwnerQQ: () => '123456789',
  });
  const dir = path.join(tmp, 'backup');
  const dest = path.join(dir, 'memory-card-full.jsonl');
  const first = await svc.runBackup();
  assert.equal(first.ok, true, first.error);
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"id":1}\n');
  assert.equal(fs.readFileSync(path.join(dir, 'memory-card-full.md'), 'utf8'), '# 全量卡\n');
  assert.ok(readMemoryBackupState(stateFile).characters['char-test'].lastBackupAt > 0);

  fs.appendFileSync(src.jsonl, '{"id":2}\n');
  const second = await svc.runBackup();
  assert.equal(second.ok, true, second.error);
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"id":1}\n{"id":2}\n');

  fs.writeFileSync(src.jsonl, '{"id":9}\n');
  const third = await svc.runBackup();
  assert.equal(third.ok, true, third.error);
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"id":9}\n');
});

test('备份目录等于源目录时拒绝', async () => {
  const src = sourceFixture();
  const svc = createMemoryCardBackupService({
    dshHome: tmp,
    stateFile: path.join(tmp, 'state2.json'),
    getConfig: () => ({ enabled: true, dir: src.dir }),
    getSource: () => src,
  });
  const r = await svc.runBackup();
  assert.equal(r.ok, false);
  assert.match(r.error, /不能是记忆卡目录本身/);
});

if (process.platform === 'win32') test('备份目录大小写不同也算同一个目录', async () => {
  const src = sourceFixture('char-case');
  const svc = createMemoryCardBackupService({
    dshHome: tmp,
    stateFile: path.join(tmp, 'state2b.json'),
    getConfig: () => ({ enabled: true, dir: src.dir.toUpperCase() }),
    getSource: () => src,
  });
  const r = await svc.runBackup();
  assert.equal(r.ok, false);
  assert.match(r.error, /不能是记忆卡目录本身/);
});

test('QQ 未连接：不发、不推进 lastSendAt，只记等待', async () => {
  const src = sourceFixture('char-offline');
  const stateFile = path.join(tmp, 'state3.json');
  let sent = 0;
  const svc = createMemoryCardBackupService({
    dshHome: tmp,
    stateFile,
    getConfig: () => ({ enabled: true, dir: path.join(tmp, 'backup3'), send: { enabled: true, everyDays: 7, maxSendMB: 90 } }),
    getSource: () => src,
    getOwnerQQ: () => '123456789',
    isQQReady: () => false,
    sendSegments: async () => { sent += 1; },
  });
  await svc.tick();
  const rec = readMemoryBackupState(stateFile).characters['char-offline'];
  assert.equal(sent, 0);
  assert.equal(rec.lastSendAt, 0);
  assert.match(rec.lastSendError, /QQ 未连接/);
});

test('超限文件跳过，其余文件照发', async () => {
  const src = sourceFixture('char-big');
  fs.writeFileSync(src.jsonl, Buffer.alloc(1024 * 1024 + 1, 1));
  const stateFile = path.join(tmp, 'state4.json');
  let sent = 0;
  const svc = createMemoryCardBackupService({
    dshHome: tmp,
    stateFile,
    getConfig: () => ({ enabled: false, dir: '', send: { enabled: true, everyDays: 7, maxSendMB: 1 } }),
    getSource: () => src,
    getOwnerQQ: () => '123456789',
    isQQReady: () => true,
    sendSegments: async () => { sent += 1; },
  });
  const r = await svc.runSend({ manual: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(sent, 1);
  assert.match(r.skipped.join('；'), /超过单次上限/);
  assert.ok(readMemoryBackupState(stateFile).characters['char-big'].lastSendAt > 0);
});

test('发送成功：只发主人、文件段带 name/file，状态落盘', async () => {
  const src = sourceFixture('char-send');
  const stateFile = path.join(tmp, 'state5.json');
  const calls = [];
  const svc = createMemoryCardBackupService({
    dshHome: tmp,
    stateFile,
    getConfig: () => ({ enabled: false, dir: '', send: { enabled: true, everyDays: 7, maxSendMB: 90 } }),
    getSource: () => src,
    getOwnerQQ: () => '123456789',
    isQQReady: () => true,
    sendSegments: async (segments) => { calls.push(segments); },
  });
  const r = await svc.runSend({ manual: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.owner, '123456789');
  assert.equal(calls.length, 1);
  const segments = calls[0];
  assert.equal(segments[0].type, 'text');
  const fileSegs = segments.filter((s) => s.type === 'file');
  assert.equal(fileSegs.length, 3);
  assert.match(fileSegs[0].data.file, /^file:\/\/\/.*memory-card-full\.jsonl$/);
  assert.match(fileSegs[0].data.name, /^memory-card-full-\d{8}\.jsonl$/);
  const rec = readMemoryBackupState(stateFile).characters['char-send'];
  assert.ok(rec.lastSendAt > 0);
  assert.equal(rec.lastSendOk, true);
});

test('发送失败：30 分钟内不重试，过了重试窗口才再发', async () => {
  const src = sourceFixture('char-retry');
  const stateFile = path.join(tmp, 'state6.json');
  let clock = 1_000 * DAY;
  let sent = 0;
  let shouldFail = true;
  const svc = createMemoryCardBackupService({
    dshHome: tmp,
    stateFile,
    now: () => clock,
    getConfig: () => ({ enabled: false, dir: '', send: { enabled: true, everyDays: 7, maxSendMB: 90 } }),
    getSource: () => src,
    getOwnerQQ: () => '123456789',
    isQQReady: () => true,
    sendSegments: async () => { sent += 1; if (shouldFail) throw new Error('QQ 接口 500'); },
  });
  await svc.runSend();
  assert.equal(sent, 1);
  assert.equal(readMemoryBackupState(stateFile).characters['char-retry'].lastSendOk, false);

  clock += 10 * 60_000;
  await svc.tick();
  assert.equal(sent, 1, '失败后 10 分钟不应重试');

  clock += 21 * 60_000;
  shouldFail = false;
  await svc.tick();
  assert.equal(sent, 2, '31 分钟后应重试成功');
  assert.equal(readMemoryBackupState(stateFile).characters['char-retry'].lastSendOk, true);
});

test('开关关闭时 tick 不备份；到期的补一次', async () => {
  const src = sourceFixture('char-tick');
  const stateFile = path.join(tmp, 'state7.json');
  let clock = 2_000 * DAY;
  let enabled = false;
  const svc = createMemoryCardBackupService({
    dshHome: tmp,
    stateFile,
    now: () => clock,
    getConfig: () => ({ enabled, dir: path.join(tmp, 'backup7'), syncEveryDays: 1 }),
    getSource: () => src,
  });
  await svc.tick();
  assert.equal(fs.existsSync(path.join(tmp, 'backup7', 'memory-card-full.jsonl')), false);

  enabled = true;
  clock += DAY + 1;
  await svc.tick();
  assert.equal(fs.readFileSync(path.join(tmp, 'backup7', 'memory-card-full.jsonl'), 'utf8'), '{"id":1}\n');

  const before = fs.statSync(path.join(tmp, 'backup7', 'memory-card-full.jsonl')).mtimeMs;
  clock += 60_000;
  await svc.tick();
  assert.equal(fs.statSync(path.join(tmp, 'backup7', 'memory-card-full.jsonl')).mtimeMs, before);
});

test('manual 备份绕过总开关', async () => {
  const src = sourceFixture('char-manual');
  const svc = createMemoryCardBackupService({
    dshHome: tmp,
    stateFile: path.join(tmp, 'state8.json'),
    getConfig: () => ({ enabled: false, dir: path.join(tmp, 'backup8') }),
    getSource: () => src,
  });
  const r = await svc.runBackup({ manual: true });
  assert.equal(r.ok, true, r.error);
  assert.ok(fs.existsSync(path.join(tmp, 'backup8', 'memory-card-full.jsonl')));
});

test('默认聊天存档开启、单文件 16MB', () => {
  const cfg = normalizeMemoryCardBackupConfig(undefined);
  assert.equal(cfg.archive.enabled, true);
  assert.equal(cfg.archive.maxFileMB, 16);
});

test('发送带聊天存档；发过的不重发，追加后重发整份', async () => {
  const src = sourceFixture('char-arch');
  const dir = path.join(tmp, 'backup-arch');
  const root = path.join(dir, 'chat', 'char-arch', 'private');
  const archiveFile = path.join(root, '2026-11-01_0001.jsonl');
  write(archiveFile, '{"text":"old"}\n');
  const stateFile = path.join(tmp, 'state-arch.json');
  const calls = [];
  const svc = createMemoryCardBackupService({
    dshHome: tmp,
    stateFile,
    getConfig: () => ({
      enabled: false, dir, send: { enabled: true, fullArchive: false, everyDays: 7, maxSendMB: 90 },
      archive: { enabled: true, maxFileMB: 16 },
    }),
    getSource: () => src,
    getOwnerQQ: () => '123456789',
    isQQReady: () => true,
    sendSegments: async (segments) => { calls.push(segments); },
  });

  const first = await svc.runSend({ manual: true });
  assert.equal(first.ok, true, first.error);
  assert.ok(calls[0].some((s) => s.type === 'file' && String(s.data.name).startsWith('chat-private-')));
  const rec = readMemoryBackupState(stateFile).characters['char-arch'];
  assert.equal(rec.archiveSent[archiveFile], fs.statSync(archiveFile).size);

  calls.length = 0;
  await svc.runSend({ manual: true });
  assert.ok(!calls[0].some((s) => s.type === 'file' && String(s.data.name).startsWith('chat-private-')));

  fs.appendFileSync(archiveFile, '{"text":"new"}\n');
  calls.length = 0;
  await svc.runSend({ manual: true });
  assert.ok(calls[0].some((s) => s.type === 'file' && String(s.data.name).startsWith('chat-private-')));
});

test('全发模式：每次发送都带全部存档，不看 archiveSent', async () => {
  const src = sourceFixture('char-full');
  const dir = path.join(tmp, 'backup-full');
  const root = path.join(dir, 'chat', 'char-full', 'private');
  const archiveFile = path.join(root, '2026-11-01_0001.jsonl');
  write(archiveFile, '{"text":"full"}\n');
  const stateFile = path.join(tmp, 'state-full.json');
  const calls = [];
  const svc = createMemoryCardBackupService({
    dshHome: tmp,
    stateFile,
    getConfig: () => ({
      enabled: false, dir, send: { enabled: true, fullArchive: true, everyDays: 7, maxSendMB: 90 },
      archive: { enabled: true, maxFileMB: 16 },
    }),
    getSource: () => src,
    getOwnerQQ: () => '123456789',
    isQQReady: () => true,
    sendSegments: async (segments) => { calls.push(segments); },
  });

  const first = await svc.runSend({ manual: true });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.fullArchive, true);
  assert.match(calls[0][0].data.text, /发送模式：全部记忆文件/);
  assert.ok(calls[0].some((s) => s.type === 'file' && String(s.data.name).startsWith('chat-private-')));

  calls.length = 0;
  const second = await svc.runSend({ manual: true });
  assert.equal(second.ok, true, second.error);
  assert.ok(calls[0].some((s) => s.type === 'file' && String(s.data.name).startsWith('chat-private-')), '全发第二次仍应带存档');
});

test('全发模式：25 个存档不被 20 个上限截断', async () => {
  const src = sourceFixture('char-25');
  const dir = path.join(tmp, 'backup-25');
  const root = path.join(dir, 'chat', 'char-25', 'private');
  for (let i = 0; i < 25; i += 1) {
    write(path.join(root, `2026-11-01_${String(i).padStart(4, '0')}.jsonl`), `{"n":${i}}\n`);
  }
  const calls = [];
  const svc = createMemoryCardBackupService({
    dshHome: tmp,
    stateFile: path.join(tmp, 'state-25.json'),
    getConfig: () => ({
      enabled: false, dir, send: { enabled: true, fullArchive: true, everyDays: 7, maxSendMB: 90 },
      archive: { enabled: true, maxFileMB: 16 },
    }),
    getSource: () => src,
    getOwnerQQ: () => '123456789',
    isQQReady: () => true,
    sendSegments: async (segments) => { calls.push(segments); },
  });
  const r = await svc.runSend({ manual: true });
  assert.equal(r.ok, true, r.error);
  const chatFiles = calls[0].filter((s) => s.type === 'file' && String(s.data.name).startsWith('chat-private-'));
  assert.equal(chatFiles.length, 25);
});

test('模式切换：全发后切增量不重发旧档，追加后只发新档', async () => {
  const src = sourceFixture('char-switch');
  const dir = path.join(tmp, 'backup-switch');
  const root = path.join(dir, 'chat', 'char-switch', 'private');
  const fileA = path.join(root, '2026-11-01_0001.jsonl');
  write(fileA, '{"text":"a"}\n');
  let fullArchive = true;
  const calls = [];
  const svc = createMemoryCardBackupService({
    dshHome: tmp,
    stateFile: path.join(tmp, 'state-switch.json'),
    getConfig: () => ({
      enabled: false, dir, send: { enabled: true, fullArchive, everyDays: 7, maxSendMB: 90 },
      archive: { enabled: true, maxFileMB: 16 },
    }),
    getSource: () => src,
    getOwnerQQ: () => '123456789',
    isQQReady: () => true,
    sendSegments: async (segments) => { calls.push(segments); },
  });

  await svc.runSend({ manual: true });
  assert.ok(calls[0].some((s) => s.type === 'file' && String(s.data.name).startsWith('chat-private-')));

  fullArchive = false;
  calls.length = 0;
  await svc.runSend({ manual: true });
  assert.ok(!calls[0].some((s) => s.type === 'file' && String(s.data.name).startsWith('chat-private-')), '切增量后旧档不应重发');

  fs.appendFileSync(fileA, '{"text":"a2"}\n');
  calls.length = 0;
  await svc.runSend({ manual: true });
  assert.ok(calls[0].some((s) => s.type === 'file' && String(s.data.name).startsWith('chat-private-')), '追加后增量应重发');

  fullArchive = true;
  calls.length = 0;
  await svc.runSend({ manual: true });
  assert.ok(calls[0].some((s) => s.type === 'file' && String(s.data.name).startsWith('chat-private-')), '切全发应再次全发');
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}
console.log(failures ? `${failures} test(s) failed` : 'memory backup tests OK');
if (failures) process.exitCode = 1;
