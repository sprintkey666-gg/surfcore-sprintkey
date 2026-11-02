import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chatArchiveRoot,
  chatArchiveStatus,
  createChatArchiveWriter,
  listChatArchiveFiles,
  normalizeChatArchiveConfig,
} from '../src/chat-archive.js';
import { createDesktopArchive } from '../plugins/surfcore/lib/desktop-archive.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-archive-test-'));
const base = path.join(tmp, 'backup');
const tests = [];
const clock = new Date('2026-11-01T10:00:00+08:00').getTime();

function test(name, fn) { tests.push({ name, fn }); }

function makeWriter(overrides = {}) {
  let config = {
    enabled: true,
    dir: base,
    archive: { enabled: true, maxFileMB: 16 },
    ...overrides.config,
  };
  return createChatArchiveWriter({
    getConfig: () => config,
    getCharacterId: () => 'char-test',
    getBaseDir: () => config.dir || base,
    now: () => clock,
    ...overrides,
  });
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function firstFile(kind) {
  const root = chatArchiveRoot({ baseDir: base, characterId: 'char-test' });
  const files = listChatArchiveFiles(root)[kind];
  assert.equal(files.length, 1);
  return files[0].path;
}

test('默认开启、单文件 16MB，坏值收敛', () => {
  const cfg = normalizeChatArchiveConfig(undefined);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.maxFileMB, 16);
  assert.equal(normalizeChatArchiveConfig({ enabled: 'yes', maxFileMB: 0 }).enabled, true);
  assert.equal(normalizeChatArchiveConfig({ maxFileMB: 9999 }).maxFileMB, 512);
});

test('私聊和群聊分开写，元数据完整', () => {
  const w = makeWriter();
  const privateEvent = {
    message_id: 'm1',
    user_id: '123456789',
    sender: { card: '主人', nickname: '主人' },
    message: [
      { type: 'text', data: { text: '今天吃什么' } },
      { type: 'reply', data: { id: 'q1' } },
    ],
  };
  assert.equal(w.appendIncoming({
    key: 'private:123456789', kind: 'private', id: '123456789',
    event: privateEvent, plainContent: '今天吃什么', textContent: '今天吃什么',
    isOwner: true, quoteTargetIsSelf: true,
  }).ok, true);

  const groupEvent = {
    message_id: 'g1',
    user_id: '2001',
    group_id: '7788',
    group_name: '测试群',
    sender: { card: '阿明' },
    message: [{ type: 'text', data: { text: '大家好' } }, { type: 'image', data: { file: 'a.jpg' } }],
  };
  assert.equal(w.appendIncoming({
    key: 'group:7788', kind: 'group', id: '7788',
    event: groupEvent, plainContent: '大家好', textContent: '大家好',
    media: [{ kind: 'image', file: 'a.jpg', name: 'a.jpg' }],
  }).ok, true);

  const priv = readLines(firstFile('private'));
  assert.equal(priv.length, 1);
  assert.equal(priv[0].kind, 'private');
  assert.equal(priv[0].schema, 2);
  assert.equal(priv[0].channel, 'qq');
  assert.equal(priv[0].time, '2026-11-01T10:00:00+08:00');
  assert.equal(priv[0].sender.isOwner, true);
  assert.equal(priv[0].conversation.id, '123456789');
  assert.equal(priv[0].reply.messageId, 'q1');
  assert.equal(priv[0].reply.toSelf, true);

  const group = readLines(firstFile('group'));
  assert.equal(group.length, 1);
  assert.equal(group[0].type, 'image');
  assert.equal(group[0].media[0].kind, 'image');
  assert.equal(group[0].conversation.name, '测试群');
  assert.equal(group[0].conversation.id, '7788');
});

test('单文件超过上限自动新建，序号递增', () => {
  const w = makeWriter({ maxFileBytes: 420 });
  for (let i = 0; i < 3; i++) {
    w.appendIncoming({
      key: 'private:1', kind: 'private', id: '1',
      event: { message_id: `r${i}`, user_id: '1', message: [{ type: 'text' }] },
      plainContent: `${i}`.padEnd(90, 'x'),
    });
  }
  const root = chatArchiveRoot({ baseDir: base, characterId: 'char-test' });
  const files = listChatArchiveFiles(root).private;
  assert.ok(files.length >= 2, `expected rotation, got ${files.length}`);
  assert.match(files[0].name, /_0001\.jsonl$/);
  assert.match(files[1].name, /_0002\.jsonl$/);
});

test('同一条消息重复投递只记一次', () => {
  const w = makeWriter({ maxFileBytes: 1024 * 1024 });
  const event = { message_id: 'dup', user_id: '1', message: [{ type: 'text' }] };
  const args = { key: 'private:1', kind: 'private', id: '1', event, plainContent: '重复' };
  w.appendIncoming(args);
  w.appendIncoming(args);
  const root = chatArchiveRoot({ baseDir: base, characterId: 'char-test' });
  const all = listChatArchiveFiles(root).private.flatMap((f) => readLines(f.path));
  assert.equal(all.filter((r) => r.messageId === 'dup').length, 1);
});

test('关闭后不写文件', () => {
  const w = makeWriter({ config: { archive: { enabled: false, maxFileMB: 16 } } });
  const r = w.appendIncoming({
    key: 'private:off', kind: 'private', id: 'off',
    event: { message_id: 'off1', user_id: '1', message: [{ type: 'text' }] },
    plainContent: '不该写',
  });
  assert.equal(r, null);
});

test('斜杠命令不存档，纯媒体仍存档', () => {
  const w = makeWriter();
  assert.equal(w.appendIncoming({
    key: 'private:2', kind: 'private', id: '2',
    event: { message_id: 'cmd', user_id: '2' }, plainContent: '/status',
  }), null);
  const r = w.appendIncoming({
    key: 'private:2', kind: 'private', id: '2',
    event: { message_id: 'img', user_id: '2', message: [{ type: 'image' }] },
    plainContent: '', media: [{ kind: 'image', file: 'b.png' }],
  });
  assert.equal(r.ok, true);
});

test('出站消息写到同一会话，sender 标 isSelf', () => {
  const w = makeWriter();
  w.appendOutgoing({ key: 'private:3', kind: 'private', text: '收到' });
  const root = chatArchiveRoot({ baseDir: base, characterId: 'char-test' });
  const all = listChatArchiveFiles(root).private.flatMap((f) => readLines(f.path));
  const out = all.find((r) => r.text === '收到');
  assert.ok(out);
  assert.equal(out.sender.isSelf, true);
  assert.equal(out.kind, 'private');
  assert.equal(out.conversation.id, '3');
});

test('schema2 appendRecord 支持桌宠/字幕 channel', () => {
  const base2 = path.join(tmp, 'backup-desktop');
  const w = makeWriter({ config: { dir: base2 }, getBaseDir: () => base2 });
  const conv = { key: 'desktop:char-test', id: 'char-test', name: '桌面私聊' };
  assert.equal(w.appendRecord({
    channel: 'desktop-orb', role: 'user', kind: 'private', conversation: conv,
    text: '桌宠你好', at: clock, sender: { name: '主人', isOwner: true },
  }).ok, true);
  assert.equal(w.appendRecord({
    channel: 'companion', role: 'assistant', kind: 'private', conversation: conv,
    text: '字幕里说一句', at: clock, sender: { name: '角色', isSelf: true },
  }).ok, true);
  const root = chatArchiveRoot({ baseDir: base2, characterId: 'char-test' });
  const rows = listChatArchiveFiles(root).private.flatMap((f) => readLines(f.path));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].schema, 2);
  assert.equal(rows[0].channel, 'desktop-orb');
  assert.equal(rows[0].conversation.id, 'char-test');
  assert.equal(rows[0].sender.isOwner, true);
  assert.equal(rows[1].channel, 'companion');
  assert.equal(rows[1].sender.isSelf, true);
});

test('desktop-archive 适配层写入 channel 并带类型', () => {
  const base3 = path.join(tmp, 'backup-desktop-adapter');
  const archive = createDesktopArchive({
    dshHome: tmp,
    readConfig: () => ({ dir: base3, archive: { enabled: true, maxFileMB: 16 } }),
    getCharacterId: () => 'char-desk',
    now: () => clock,
  });
  assert.equal(archive.record({ channel: 'desktop-orb', role: 'user', text: '桌宠说话', at: clock, name: '主人' }).ok, true);
  assert.equal(archive.record({ channel: 'companion', role: 'assistant', text: '字幕回复', at: clock, name: '角色', type: 'text' }).ok, true);
  const root = chatArchiveRoot({ baseDir: base3, characterId: 'char-desk' });
  const rows = listChatArchiveFiles(root).private.flatMap((f) => readLines(f.path));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].channel, 'desktop-orb');
  assert.equal(rows[0].sender.isOwner, true);
  assert.equal(rows[1].channel, 'companion');
  assert.equal(rows[1].sender.isSelf, true);
  assert.equal(rows[1].conversation.id, 'char-desk');
});

test('status 汇总文件数和字节', () => {
  const root = chatArchiveRoot({ baseDir: base, characterId: 'char-test' });
  const st = chatArchiveStatus(root, { maxFileMB: 16 });
  assert.ok(st.private.files >= 1);
  assert.ok(st.group.files >= 1);
  assert.ok(st.totalBytes > 0);
  assert.equal(st.enabled, true);
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
console.log(failures ? `${failures} test(s) failed` : 'chat archive tests OK');
if (failures) process.exitCode = 1;
