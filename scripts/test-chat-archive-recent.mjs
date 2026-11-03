// 聊天存档「数据类型」+ 回读最近对话 回归（离线，只写临时目录）。
//
// 背景（2026-11-03）：悬浮窗会话和陪伴字幕的对话要写进存档，并带上可分辨的
// 数据类型（qq-message / orb-chat / companion-subtitle）；同时插件要能读回
// 「最近在别处聊了什么」塞进 system prompt，所以有了 readRecentChatRecords()。
// 这里钉住：标签/类型的映射、写入两列、只读尾部、被切半的首行不吞掉。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOD = pathToFileURL(path.join(REPO_ROOT, 'src', 'chat-archive.js')).href;
const {
  createChatArchiveWriter, readRecentChatRecords, channelLabel, messageTypeOf,
  chatArchiveRoot, CHANNEL_LABELS, MESSAGE_TYPES,
} = await import(MOD);

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

// ── 1. 映射表 ───────────────────────────────────────────────────────────
ok(channelLabel('qq') === 'QQ', 'qq → QQ');
ok(channelLabel('desktop-orb') === '悬浮窗', 'desktop-orb → 悬浮窗');
ok(channelLabel('companion') === '陪伴字幕', 'companion → 陪伴字幕');
ok(channelLabel('') === 'QQ', '没写 channel 时回落到 QQ');
ok(messageTypeOf('companion') === 'companion-subtitle', '字幕的数据类型');
ok(messageTypeOf('desktop-orb') === 'orb-chat', '悬浮窗的数据类型');
ok(messageTypeOf('qq') === 'qq-message', 'QQ 的数据类型');
ok(Object.keys(CHANNEL_LABELS).length === Object.keys(MESSAGE_TYPES).length, '两张表覆盖的 channel 一致');

// ── 2. 写入后能读回，且带标签/类型 ───────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-archive-'));
const root = chatArchiveRoot({ baseDir: dir, characterId: 'char-test' });
const writer = createChatArchiveWriter({
  getBaseDir: () => dir,
  getCharacterId: () => 'char-test',
  getConfig: () => ({ enabled: true, maxFileMB: 16 }),
});
const now = Date.now();
const push = (channel, role, text, at) => writer.appendRecord({
  id: `${channel}-${role}-${at}`,
  at,
  channel,
  kind: 'private',
  conversation: { key: `private:${channel}`, id: channel, name: '测试' },
  sender: { id: 'owner', name: role === 'user' ? '主人' : '小鲸鱼', isOwner: role === 'user', isSelf: role !== 'user' },
  role,
  messageId: `${channel}-${at}`,
  type: 'text',
  types: ['text'],
  text,
});

ok(Boolean(push('qq', 'user', 'QQ 里说的话', now - 3000)), 'QQ 记录写入成功');
ok(Boolean(push('desktop-orb', 'assistant', '悬浮窗里的回复', now - 2000)), '悬浮窗记录写入成功');
ok(Boolean(push('companion', 'assistant', '字幕里的一句', now - 1000)), '字幕记录写入成功');

const files = [];
(function walk(d) {
  for (const name of fs.existsSync(d) ? fs.readdirSync(d) : []) {
    const full = path.join(d, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
})(root);
ok(files.length >= 1, `存档落盘（${files.length} 个文件）`);
const raw = files.map((f) => fs.readFileSync(f, 'utf8')).join('');
ok(raw.includes('"channelLabel":"悬浮窗"'), '记录里带 channelLabel=悬浮窗');
ok(raw.includes('"messageType":"companion-subtitle"'), '记录里带 messageType=companion-subtitle');

// ── 3. 回读：按时间升序、带标签、可限定时间窗 ────────────────────────────
const recent = readRecentChatRecords(root, { sinceMs: now - 10_000, limit: 10 });
ok(recent.length === 3, `读回 3 条（实际 ${recent.length}）`);
ok(recent[0].text === 'QQ 里说的话', '按时间升序，最早的在前面');
ok(recent[2].text === '字幕里的一句', '最晚的在最后');
ok(recent[1].channelLabel === '悬浮窗', '回读对象带来源标签');
ok(recent[2].messageType === 'companion-subtitle', '回读对象带数据类型');

const onlyNew = readRecentChatRecords(root, { sinceMs: now - 1500, limit: 10 });
ok(onlyNew.length === 1 && onlyNew[0].channel === 'companion', 'sinceMs 能缩小时间窗');

const limited = readRecentChatRecords(root, { sinceMs: 0, limit: 2 });
ok(limited.length === 2 && limited[1].text === '字幕里的一句', 'limit 取最后 N 条');

// ── 4. 只读尾部：大文件也不整读，且切半的首行被丢掉 ──────────────────────
const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-archive-big-'));
const bigRoot = chatArchiveRoot({ baseDir: bigDir, characterId: 'char-big' });
fs.mkdirSync(path.join(bigRoot, 'private'), { recursive: true });
const bigFile = path.join(bigRoot, 'private', '2099-01-01_0001.jsonl');
const filler = JSON.stringify({ at: 1, channel: 'qq', role: 'user', text: 'x'.repeat(400) });
fs.writeFileSync(bigFile, Array.from({ length: 1200 }, () => filler).join('\n') + '\n', 'utf8');
fs.appendFileSync(bigFile, `${JSON.stringify({ at: Date.now(), channel: 'companion', role: 'assistant', name: '小鲸鱼', text: '尾巴上的一句话' })}\n`, 'utf8');
const tail = readRecentChatRecords(bigRoot, { sinceMs: 0, limit: 5, tailBytes: 8 * 1024 });
ok(tail.some((r) => r.text === '尾巴上的一句话'), '只读尾部也能读到最新一条');
ok(tail.every((r) => typeof r.text === 'string' && r.text.length > 0), '切半的行不会变成脏数据');

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(bigDir, { recursive: true, force: true });

if (failures) {
  console.error(`\n❌ ${failures} 项失败`);
  process.exit(1);
}
console.log('\n✓ 聊天存档数据类型与回读检查通过');
