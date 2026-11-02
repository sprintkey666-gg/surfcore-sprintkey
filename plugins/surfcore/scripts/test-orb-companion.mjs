import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_COMPANION,
  cleanSubtitle,
  createOrbCompanionService,
  normalizeCompanionConfig,
} from '../lib/orb-companion.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`not ok - ${name}`); console.error(error?.stack || error); }
}

check('默认配置', () => {
  assert.deepEqual(normalizeCompanionConfig(undefined), DEFAULT_COMPANION);
  assert.equal(normalizeCompanionConfig({}).intervalSec, 60);
});

check('配置夹紧', () => {
  const cfg = normalizeCompanionConfig({ enabled: true, intervalSec: 5, maxCommentsPerHour: 99, fontPx: 4, width: 9999 });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.intervalSec, 20);
  assert.equal(cfg.maxCommentsPerHour, 30);
  assert.equal(cfg.fontPx, 14);
  assert.equal(cfg.width, 1400);
});

check('字幕清洗', () => {
  assert.equal(cleanSubtitle('  "  今天  的雨像一层滤镜  " '), '今天 的雨像一层滤镜');
  assert.equal(cleanSubtitle('SKIP'), '');
  assert.equal(cleanSubtitle('跳过'), '');
  assert.equal(cleanSubtitle('[[分析]]'), '');
  assert.equal(cleanSubtitle('一二三四五六七', 5), '一二三四…');
});

function tmpShot(dir, name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
}

async function setup(overrides = {}, lookOverride = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-test-'));
  let config = { screen: { enabled: true, deleteAfterRead: false }, companion: { enabled: true, intervalSec: 20, fontPx: 22, width: 900 } };
  let chats = 0;
  let looks = 0;
  let nextText = '这一帧有点安静';
  const service = createOrbCompanionService({
    orb: {},
    chat: { chat: async () => { chats += 1; return { ok: true, reply: { text: nextText } }; } },
    look: lookOverride || (async () => { looks += 1; return { ok: true, screenshot: tmpShot(dir, `shot-${looks}.jpg`, `frame-${looks}`), active: { title: '电影' } }; }),
    getConfig: () => config,
    log: () => {},
    ...overrides,
  });
  return { dir, service, setConfig: (c) => { config = c; }, chats: () => chats, looks: () => looks, setText: (t) => { nextText = t; } };
}

async function asyncCheck(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`not ok - ${name}`); console.error(error?.stack || error); }
}

await asyncCheck('未开屏幕权限不能开始', async () => {
  const t = await setup();
  t.setConfig({ screen: { enabled: false }, companion: { enabled: true } });
  const result = await t.service.start({ sessionId: 's1' });
  assert.equal(result.ok, false);
  assert.match(result.error, /屏幕权限/);
  assert.equal(t.service.status().active, false);
});

await asyncCheck('开始后首句与状态', async () => {
  const t = await setup();
  const result = await t.service.start({ sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.equal(t.service.status().active, true);
  assert.equal(t.service.status().subtitle.who, 'her');
  t.service.stop();
});

await asyncCheck('相同画面去重，不重复调模型', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-dedupe-'));
  const same = tmpShot(dir, 'same.jpg', 'same-frame');
  const t = await setup({}, async () => ({ ok: true, screenshot: same, active: { title: '电影' } }));
  await t.service.start({ sessionId: 's1' });
  await t.service.tick();
  const first = t.chats();
  await t.service.tick();
  assert.equal(first, 1);
  assert.equal(t.chats(), 1, '同一张图第二次 tick 不应再调模型');
  t.service.stop();
});

await asyncCheck('SKIP 不显示、不计数', async () => {
  const t = await setup();
  t.setText('SKIP');
  await t.service.start({ sessionId: 's1' });
  const before = t.service.status().commentsThisHour;
  await t.service.tick();
  assert.equal(t.service.status().commentsThisHour, before);
  assert.equal(t.service.status().subtitle.text.includes('SKIP'), false);
  t.service.stop();
});

await asyncCheck('每小时硬上限', async () => {
  const t = await setup();
  t.setConfig({ screen: { enabled: true, deleteAfterRead: false }, companion: { enabled: true, intervalSec: 20, maxCommentsPerHour: 1, fontPx: 22, width: 900 } });
  await t.service.start({ sessionId: 's1' });
  await t.service.tick();
  const chats = t.chats();
  await t.service.tick();
  assert.equal(t.chats(), chats, '达到上限后不应再调模型');
  t.service.stop();
});

await asyncCheck('reply 发布主人消息并回一句', async () => {
  const t = await setup();
  await t.service.start({ sessionId: 's1' });
  t.setText('这句特别好');
  const result = await t.service.reply('真的吗');
  assert.equal(result.ok, true);
  assert.equal(result.reply, '这句特别好');
  const messages = t.service.status().messages;
  assert.ok(messages.some((m) => m.who === 'me' && m.text === '真的吗'));
  assert.ok(messages.some((m) => m.who === 'her' && m.text === '这句特别好'));
  t.service.stop();
});

await asyncCheck('字幕消息交给存档回调，内部模型调用不重复存档', async () => {
  const seen = [];
  let archiveOption = null;
  const t = await setup({
    onMessage: (m) => seen.push(m),
    chat: { chat: async (opts) => { archiveOption = opts.archive; return { ok: true, reply: { text: '接上了' } }; } },
  });
  await t.service.start({ sessionId: 'arch' });
  const result = await t.service.reply('在吗');
  assert.equal(result.ok, true);
  assert.equal(archiveOption, false);
  assert.ok(seen.some((m) => m.channel === 'companion' && m.role === 'user' && m.text === '在吗'));
  assert.ok(seen.some((m) => m.channel === 'companion' && m.role === 'assistant' && m.text === '接上了'));
  t.service.stop();
});

await asyncCheck('连续截图失败只降级不自动停', async () => {
  let calls = 0;
  const t = await setup({ look: async () => { calls += 1; return { ok: false, error: 'screen denied' }; } });
  await t.service.start({ sessionId: 's1' });
  await t.service.tick();
  await t.service.tick();
  await t.service.tick();
  assert.equal(calls, 3);
  const status = t.service.status();
  assert.equal(status.active, true);
  assert.equal(status.degraded, true);
  assert.match(status.lastError, /screen denied/);
  t.service.stop();
});

if (failed) { console.error(`\n${failed} 个测试失败`); process.exit(1); }
console.log('\ncompanion tests OK');
