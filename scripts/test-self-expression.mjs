// 自我表达 + 日记的纯逻辑单测：归一化、到期判断、解析/清洗、Markdown 追加。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SELF_EXPRESSION, normalizeSelfExpressionConfig, selfExpressionDue,
  buildExpressionPrompt, parseExpressionDecision, sanitizeExpressionText,
  selfExpressionStateFile, readSelfExpressionState, writeSelfExpressionState,
  characterExpressionState,
} from '../src/self-expression.js';
import {
  DEFAULT_DIARY_CONFIG, normalizeDiaryConfig, diaryBaseDir, diaryFileFor,
  isDiaryDue, buildDiaryPrompt, cleanDiaryText, formatDiaryEntry,
  appendDiaryEntry, readDiaryTail, diaryStateFile, readDiaryState,
  writeDiaryState, characterDiaryState,
} from '../src/diary.js';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log('self-expression');

ok('默认配置全关、温度 0.5', () => {
  const cfg = normalizeSelfExpressionConfig(undefined);
  assert.deepEqual(cfg, DEFAULT_SELF_EXPRESSION);
  assert.equal(cfg.signature.mode, 'off');
  assert.equal(cfg.qzone.visibility, 4);
});

ok('坏值收敛：mode/温度/小时/字数/可见性', () => {
  const cfg = normalizeSelfExpressionConfig({
    signature: { mode: 'hack', temperature: 9, hour: 99, maxChars: 2 },
    qzone: { mode: '3d', temperature: -1, hour: -3, maxChars: 9999, visibility: 16 },
  });
  assert.equal(cfg.signature.mode, 'off');
  assert.equal(cfg.signature.temperature, 1);
  assert.equal(cfg.signature.hour, 23);
  assert.equal(cfg.signature.maxChars, 10);
  assert.equal(cfg.qzone.mode, '3d');
  assert.equal(cfg.qzone.temperature, 0);
  assert.equal(cfg.qzone.hour, 0);
  assert.equal(cfg.qzone.maxChars, 500);
  assert.equal(cfg.qzone.visibility, 4);
});

ok('off 永不到期，force 直接到期', () => {
  const now = new Date(2026, 9, 31, 22, 0, 0).getTime();
  assert.equal(selfExpressionDue({ mode: 'off', hour: 20, now }).due, false);
  assert.equal(selfExpressionDue({ mode: 'auto', hour: 20, now, force: true }).due, true);
});

ok('auto：没到 hour 不跑，到了就跑，20 小时内不重复', () => {
  const before = new Date(2026, 9, 31, 19, 0, 0).getTime();
  assert.equal(selfExpressionDue({ mode: 'auto', hour: 20, now: before }).due, false);
  const at = new Date(2026, 9, 31, 20, 5, 0).getTime();
  assert.equal(selfExpressionDue({ mode: 'auto', hour: 20, now: at }).due, true);
  assert.equal(selfExpressionDue({ mode: 'auto', hour: 20, lastCheckAt: at, now: at + 3600_000 }).due, false);
  assert.equal(selfExpressionDue({ mode: 'auto', hour: 20, lastCheckAt: at, now: at + 25 * 3600_000 }).due, true);
});

ok('固定档：首次过 hour 才发；满 N 天且过 hour；逾期 24h 立刻补', () => {
  const day = 86_400_000;
  const t0 = new Date(2026, 9, 31, 10, 0, 0).getTime();
  assert.equal(selfExpressionDue({ mode: '1d', hour: 20, now: t0 }).due, false);
  const t1 = new Date(2026, 9, 31, 20, 1, 0).getTime();
  assert.equal(selfExpressionDue({ mode: '1d', hour: 20, now: t1 }).due, true);
  assert.equal(selfExpressionDue({ mode: '1d', hour: 20, lastAt: t1, now: t1 + 12 * 3600_000 }).due, false);
  assert.equal(selfExpressionDue({ mode: '1d', hour: 20, lastAt: t1, now: t1 + day + 3600_000 }).due, true);
  const late = new Date(2026, 9, 31, 3, 0, 0).getTime();
  assert.equal(selfExpressionDue({ mode: '3d', hour: 20, lastAt: t0, now: late }).due, false);
  assert.equal(selfExpressionDue({ mode: '3d', hour: 20, lastAt: t0, now: t0 + 3 * day + 25 * 3600_000 }).due, true);
});

ok('prompt 含温度与 JSON 要求，长度随 kind 变化', () => {
  const p = buildExpressionPrompt({
    kind: 'signature', characterName: '小鲸鱼', persona: '测试人设',
    context: '今天聊了天气', mode: 'auto', temperature: 0.7, maxChars: 40,
  });
  assert.match(p, /表达欲温度 0\.7/);
  assert.match(p, /20~40 个字/);
  assert.match(p, /"action":"post"/);
  const q = buildExpressionPrompt({ kind: 'qzone', characterName: '小鲸鱼', mode: '1d', maxChars: 300 });
  assert.match(q, /80~300 个字/);
  assert.match(q, /不要 skip/);
});

ok('解析 JSON / 纯文本 / skip', () => {
  assert.deepEqual(parseExpressionDecision('{"action":"skip","reason":"没想说的"}'), { action: 'skip', text: '', reason: '没想说的' });
  const post = parseExpressionDecision('```json\n{"action":"post","text":"今天风很好","reason":"开心"}\n```');
  assert.equal(post.action, 'post');
  assert.equal(post.text, '今天风很好');
  const plain = parseExpressionDecision('今天就是很普通的一天。');
  assert.equal(plain.action, 'post');
  assert.equal(plain.text, '今天就是很普通的一天。');
});

ok('解析容错：尾部句号 / 连续 JSON / 外层字符串 / 坏 JSON 不外发', () => {
  const tail = parseExpressionDecision('{"action":"post","text":"今天风很好","reason":"开心"}。');
  assert.equal(tail.action, 'post');
  assert.equal(tail.text, '今天风很好');

  const twice = parseExpressionDecision('{"action":"post","text":"第一句","reason":"a"}{"action":"post","text":"第二句","reason":"b"}');
  assert.equal(twice.action, 'post');
  assert.equal(twice.text, '第一句');

  const inner = '{"action":"post","text":"外层字符串里的正文","reason":"r"}';
  const wrapped = parseExpressionDecision(JSON.stringify(inner));
  assert.equal(wrapped.action, 'post');
  assert.equal(wrapped.text, '外层字符串里的正文');

  const broken = parseExpressionDecision('{"action":"post","text":"换行没转义\n就坏了"}');
  assert.equal(broken.action, 'skip');
  assert.equal(broken.reason, 'unparsed-json');
});

ok('清洗链接、QQ 号、路径与媒体占位，并截断', () => {
  const text = sanitizeExpressionText('看这里 https://x.test/a 加我 123456789 路径 C:\\secret\\a.txt [图片] 结束', 'signature', 20);
  assert.equal(text.includes('https'), false);
  assert.equal(text.includes('123456789'), false);
  assert.equal(text.includes('secret'), false);
  assert.equal(text.includes('[图片]'), false);
  assert.ok(text.length <= 20);
});

ok('状态文件按角色读写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfexpr-'));
  const file = selfExpressionStateFile(dir);
  assert.equal(file, path.join(dir, 'surfcore', 'self-expression-state.json'));
  const root = readSelfExpressionState(file);
  const st = characterExpressionState(root, 'char-1');
  st.signature.lastValue = '签名';
  writeSelfExpressionState(file, root);
  const again = readSelfExpressionState(file);
  assert.equal(characterExpressionState(again, 'char-1').signature.lastValue, '签名');
  assert.ok(fs.existsSync(file));
});

console.log('diary');

ok('日记默认：关、每 1 天、22 点、发主人、带文件', () => {
  const cfg = normalizeDiaryConfig(undefined);
  assert.deepEqual(cfg, DEFAULT_DIARY_CONFIG);
  assert.equal(cfg.everyDays, 1);
  assert.equal(cfg.send.enabled, false);
  assert.equal(cfg.send.withFile, true);
});

ok('日记坏值收敛', () => {
  const cfg = normalizeDiaryConfig({ enabled: true, dir: 123, everyDays: 0, hour: 99, maxChars: 10, send: { enabled: 1, withFile: 0 } });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.dir, '123');
  assert.equal(cfg.everyDays, 1);
  assert.equal(cfg.hour, 23);
  assert.equal(cfg.maxChars, 200);
  assert.equal(cfg.send.enabled, false);
  assert.equal(cfg.send.withFile, true);
});

ok('目录与文件名：默认 / 自定义 / 角色名清洗', () => {
  const base = diaryBaseDir('C:/dsh', '');
  assert.equal(base, path.join('C:/dsh', 'surfcore', 'diary'));
  assert.equal(diaryBaseDir('C:/dsh', 'D:/我的日记'), path.join('D:/我的日记'));
  const file = diaryFileFor({ dshHome: 'C:/dsh', dir: 'D:/日记', characterId: 'char/1' });
  assert.equal(path.basename(file), 'char_1.md');
});

ok('日记到期：首次过 hour；满 N 天；逾期补', () => {
  const day = 86_400_000;
  const t0 = new Date(2026, 9, 31, 10, 0, 0).getTime();
  assert.equal(isDiaryDue({ hour: 22, now: t0 }).due, false);
  const t1 = new Date(2026, 9, 31, 22, 1, 0).getTime();
  assert.equal(isDiaryDue({ hour: 22, now: t1 }).due, true);
  assert.equal(isDiaryDue({ hour: 22, lastWriteAt: t1, now: t1 + 12 * 3600_000 }).due, false);
  assert.equal(isDiaryDue({ hour: 22, lastWriteAt: t1, now: t1 + day + 3600_000 }).due, true);
  assert.equal(isDiaryDue({ hour: 22, lastWriteAt: t0, now: t0 + 2 * day + 30 * 3600_000 }).due, true);
});

ok('prompt 与正文清洗', () => {
  const p = buildDiaryPrompt({ characterName: '小鲸鱼', persona: '人设', context: '今天聊了天气', maxChars: 1200 });
  assert.match(p, /今天的日记/);
  assert.match(p, /200~800 字/);
  const text = cleanDiaryText('日记：今天很好。\n\n第二段。', 1200);
  assert.equal(text.startsWith('今天很好'), true);
  assert.ok(text.length <= 1200);
});

ok('Markdown 追加与尾部预览', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-'));
  const file = path.join(dir, 'char.md');
  appendDiaryEntry(file, formatDiaryEntry(new Date(2026, 9, 31, 22, 30).getTime(), '第一篇'));
  appendDiaryEntry(file, formatDiaryEntry(new Date(2026, 10, 1, 22, 30).getTime(), '第二篇'));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /## 2026-10-31 周六 22:30/);
  assert.match(text, /第一篇/);
  assert.match(text, /第二篇/);
  const tail = readDiaryTail(file, 500);
  assert.match(tail, /第二篇/);
});

ok('日记状态按角色读写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-state-'));
  const file = diaryStateFile(dir);
  const root = readDiaryState(file);
  const st = characterDiaryState(root, 'char-1');
  st.lastWriteAt = 123;
  writeDiaryState(file, root);
  assert.equal(characterDiaryState(readDiaryState(file), 'char-1').lastWriteAt, 123);
});

console.log(`\n${passed} tests OK`);
