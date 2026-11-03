#!/usr/bin/env node
/**
 * 互动监测回归测试（lib/orb-activity.js + scripts/activity.ps1）。
 *
 * 覆盖：
 *   1. 配置归一化：pollMs 钳 10s~120s、kinds 默认开、bubbleEveryMs 钳位
 *   2. 采样 JSON 清洗：形状固定、album 之类多余字段丢掉、坏数据返回 null
 *   3. 内容去重：payload 相同不重写 activity.json（at 不算内容）
 *   4. 限流：5 秒内重复 sample() 被拒
 *   5. 采样失败只返回 ok:false，不抛异常、不破坏上一个文件
 *   6. kinds 过滤：window/file/music 分别关掉的效果
 *   7. stop() 后 activity.json 被删掉（关了就是不留）
 *   8. 真实 powershell 采样：输出合法 JSON
 *   9. 真实脚本标题解析 + denyTitles（用测试钩子 SURFCORE_ACTIVITY_TITLE/PROC/DENY）
 *
 * 用法：node plugins/surfcore/scripts/test-orb-activity.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOrbActivity,
  normalizeActivityConfig,
  sanitizeSample,
  applyKindFilter,
  sameActivity,
  clampPollMs,
  MIN_SAMPLE_GAP_MS,
} from '../lib/orb-activity.js';
import { buildActivityEvent, activityKindOf, createActivityFeed } from '../lib/orb-api.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'activity.ps1');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`not ok - ${name}`); console.error(error?.stack || error); }
}
async function acheck(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`not ok - ${name}`); console.error(error?.stack || error); }
}

const SAMPLE = {
  at: 1_700_000_000_000,
  active: { app: 'Code', title: 'a.js — surfcore - Visual Studio Code', kind: 'editor', file: 'a.js', project: 'surfcore', extra: 'drop' },
  media: { app: 'QQMusic.exe', title: 'Fallen Angel', artist: 'Wolfgang Laux', status: 'playing', album: 'drop' },
  cursor: { x: 100, y: 200 },
};

// ── 1. 配置归一化 ────────────────────────────────────────────────────────
check('配置归一化：pollMs 钳位 + kinds 默认', () => {
  assert.equal(normalizeActivityConfig({}).enabled, false);
  assert.equal(normalizeActivityConfig({}).pollMs, 20000);
  assert.deepEqual(normalizeActivityConfig({}).kinds, { window: true, file: true, music: true });
  assert.equal(clampPollMs(1000), 10000);
  assert.equal(clampPollMs(999999), 120000);
  assert.equal(clampPollMs('abc'), 20000);
  const cfg = normalizeActivityConfig({ enabled: true, pollMs: 15000, kinds: { window: false, file: false, music: true }, bubbleEveryMs: 5 });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.pollMs, 15000);
  assert.deepEqual(cfg.kinds, { window: false, file: false, music: true });
  assert.equal(cfg.bubbleEveryMs, 60000, '气泡频率最低 1 分钟');
});

// ── 2. 采样清洗 ──────────────────────────────────────────────────────────
check('采样清洗：形状固定、多余字段丢掉、坏数据返回 null', () => {
  const clean = sanitizeSample(SAMPLE);
  assert.equal(clean.at, SAMPLE.at);
  assert.equal(clean.active.file, 'a.js');
  assert.equal(clean.active.extra, undefined);
  assert.equal(clean.media.album, undefined);
  assert.deepEqual(clean.cursor, { x: 100, y: 200 });
  assert.equal(sanitizeSample(null), null);
  assert.equal(sanitizeSample('nope'), null);
  assert.equal(sanitizeSample([1, 2]), null);
  const partial = sanitizeSample({ at: 0, active: null, media: null, cursor: { x: 'a', y: 1 } });
  assert.equal(partial.cursor, null);
  assert.ok(partial.at > 0, '缺 at 时补当前时间');
});

check('去重只比内容，不比 at', () => {
  const a = sanitizeSample(SAMPLE);
  const b = sanitizeSample({ ...SAMPLE, at: SAMPLE.at + 123456 });
  assert.equal(sameActivity(a, b), true);
  const c = sanitizeSample({ ...SAMPLE, cursor: { x: 101, y: 200 } });
  assert.equal(sameActivity(a, c), false);
});

// ── 3~7. 服务层：去重 / 限流 / 失败 / kinds / stop ───────────────────────
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-activity-'));
let clock = 1_700_000_000_000;
let mode = 'ok';
let response = SAMPLE;
const runner = async () => {
  if (mode === 'fail') return { error: new Error('powershell 挂了'), stdout: '', stderr: 'boom' };
  if (mode === 'garbage') return { stdout: 'not json at all\n', stderr: '' };
  return { stdout: `${JSON.stringify({ ...response, at: clock })}\n`, stderr: '' };
};
const svc = createOrbActivity({
  stateDir: state,
  pluginLog: () => {},
  getDenyTitles: () => ['密码'],
  runner,
  now: () => clock,
});

await acheck('sample 写出活动文件（形状/去多余字段）', async () => {
  svc.configure({ enabled: true, pollMs: 20000 });
  const result = await svc.sample();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.deduped, false);
  const onDisk = JSON.parse(fs.readFileSync(svc.file, 'utf8'));
  assert.equal(onDisk.active.file, 'a.js');
  assert.equal(onDisk.active.extra, undefined);
  assert.equal(onDisk.media.album, undefined);
  assert.equal(onDisk.at, clock);
});

await acheck('去重：内容相同不重写文件', async () => {
  const before = fs.statSync(svc.file).mtimeMs;
  clock += MIN_SAMPLE_GAP_MS + 1;
  const result = await svc.sample();
  assert.equal(result.ok, true);
  assert.equal(result.deduped, true, 'payload 没变就该标记 deduped');
  assert.equal(fs.statSync(svc.file).mtimeMs, before, '去重时不该重写 activity.json');
});

await acheck('限流：5 秒内重复采样被拒', async () => {
  const result = await svc.sample();
  assert.equal(result.ok, false);
  assert.equal(result.throttled, true);
  assert.ok(result.retryAfterMs > 0 && result.retryAfterMs <= MIN_SAMPLE_GAP_MS);
});

await acheck('采样失败只返回 ok:false，不破坏已有文件', async () => {
  const before = fs.readFileSync(svc.file, 'utf8');
  clock += MIN_SAMPLE_GAP_MS + 1;
  mode = 'fail';
  const result = await svc.sample();
  mode = 'ok';
  assert.equal(result.ok, false);
  assert.match(result.error, /powershell/);
  assert.equal(fs.readFileSync(svc.file, 'utf8'), before);
});

await acheck('输出不是 JSON 时也不抛异常', async () => {
  clock += MIN_SAMPLE_GAP_MS + 1;
  mode = 'garbage';
  const result = await svc.sample();
  mode = 'ok';
  assert.equal(result.ok, false);
  assert.match(result.error, /JSON/);
});

await acheck('kinds 过滤：关窗口 → active=null，关音乐 → media=null', async () => {
  clock += MIN_SAMPLE_GAP_MS + 1;
  svc.configure({ enabled: true, kinds: { window: false, file: true, music: false } });
  const result = await svc.sample();
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(fs.readFileSync(svc.file, 'utf8'));
  assert.equal(onDisk.active, null);
  assert.equal(onDisk.media, null);
  assert.deepEqual(onDisk.cursor, { x: 100, y: 200 });
});

await acheck('kinds 过滤：只关文件 → 保留窗口标题但清空 file/project', async () => {
  clock += MIN_SAMPLE_GAP_MS + 1;
  svc.configure({ enabled: true, kinds: { window: true, file: false, music: true } });
  const result = await svc.sample();
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(fs.readFileSync(svc.file, 'utf8'));
  assert.equal(onDisk.active.title, SAMPLE.active.title);
  assert.equal(onDisk.active.file, '');
  assert.equal(onDisk.active.project, '');
  assert.ok(onDisk.media);
});

check('applyKindFilter 纯函数单独可用', () => {
  const data = sanitizeSample(SAMPLE);
  const out = applyKindFilter(data, { window: false, file: false, music: false });
  assert.equal(out.active, null);
  assert.equal(out.media, null);
  assert.notEqual(out, data);
});

check('stop() 关掉开关并删掉 activity.json', () => {
  assert.ok(fs.existsSync(svc.file));
  svc.stop();
  assert.equal(fs.existsSync(svc.file), false, '关掉后不能留着采样文件');
  assert.equal(svc.status().enabled, false);
  assert.equal(svc.last(), null);
});

await acheck('configure 关掉时也会删文件', async () => {
  clock += MIN_SAMPLE_GAP_MS + 1;
  svc.configure({ enabled: true });
  await svc.sample();
  assert.ok(fs.existsSync(svc.file));
  svc.configure({ enabled: false });
  assert.equal(fs.existsSync(svc.file), false);
});

// ── 8. 真实 powershell 采样 ─────────────────────────────────────────────
await acheck('真实 powershell 采样输出合法 JSON', async () => {
  const realState = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-activity-real-'));
  const real = createOrbActivity({ stateDir: realState, scriptPath: SCRIPT, pluginLog: () => {} });
  real.configure({ enabled: true });
  const result = await real.sample();
  assert.equal(result.ok, true, result.error);
  const data = result.data;
  assert.ok(Number.isFinite(data.at) && data.at > 0);
  assert.ok(data.cursor && Number.isFinite(data.cursor.x) && Number.isFinite(data.cursor.y));
  if (data.active) {
    assert.ok(typeof data.active.app === 'string');
    assert.ok(typeof data.active.title === 'string');
    assert.ok(typeof data.active.kind === 'string');
  }
  assert.ok(fs.existsSync(real.file));
  real.stop();
  assert.equal(fs.existsSync(real.file), false);
  console.log(`   采样：${JSON.stringify({ active: data.active, media: data.media, cursor: data.cursor })}`);
});

// ── 9. 真实脚本的标题解析 + denyTitles ──────────────────────────────────
function runScript(extraEnv) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
      { env: { ...process.env, ...extraEnv }, timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}
function parseOut(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

await acheck('标题解析：VSCode 的「文件 — 项目 - 应用」', async () => {
  const out = await runScript({
    SURFCORE_ACTIVITY_TITLE: 'main.js — surfcore - Visual Studio Code',
    SURFCORE_ACTIVITY_PROC: 'Code',
    SURFCORE_ACTIVITY_DENY: '',
  });
  assert.ifError(out.error);
  const data = parseOut(out.stdout);
  assert.equal(data.active.kind, 'editor');
  assert.equal(data.active.file, 'main.js');
  assert.equal(data.active.project, 'surfcore');
});

await acheck('标题解析：记事本「文件名 - 记事本」', async () => {
  const out = await runScript({
    SURFCORE_ACTIVITY_TITLE: '周报.txt - 记事本',
    SURFCORE_ACTIVITY_PROC: 'notepad',
    SURFCORE_ACTIVITY_DENY: '',
  });
  assert.ifError(out.error);
  const data = parseOut(out.stdout);
  assert.equal(data.active.app, 'notepad');
  assert.equal(data.active.file, '周报.txt');
});

await acheck('denyTitles：命中隐私标题时 active=null', async () => {
  const out = await runScript({
    SURFCORE_ACTIVITY_TITLE: '银行 - Google Chrome',
    SURFCORE_ACTIVITY_PROC: 'chrome',
    SURFCORE_ACTIVITY_DENY: JSON.stringify(['银行', '密码']),
  });
  assert.ifError(out.error);
  const data = parseOut(out.stdout);
  assert.equal(data.active, null);
  assert.ok(data.cursor, '窗口被拦了也要有光标');
});

// ── 10. onSample：变化才回调，forced 强制回调，退订生效 ────────────────
await acheck('onSample：变化才回调，forced 强制、退订生效', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-activity-listen-'));
  let t = 1_700_000_000_000;
  let resp = SAMPLE;
  const seen = [];
  const s2 = createOrbActivity({
    stateDir: dir,
    pluginLog: () => {},
    getDenyTitles: () => [],
    runner: async () => ({ stdout: `${JSON.stringify({ ...resp, at: t })}\n`, stderr: '' }),
    now: () => t,
  });
  const off = s2.onSample((sample, meta) => seen.push({ sample, meta }));
  s2.configure({ enabled: true });

  let r = await s2.sample();
  assert.equal(r.ok, true, r.error);
  assert.equal(seen.length, 1, '第一次采样就是一次变化');
  assert.equal(seen[0].meta.changed, true);
  assert.equal(seen[0].meta.kind, 'file', '第一次采到正在改的文件就算文件变化');

  t += MIN_SAMPLE_GAP_MS + 1;
  r = await s2.sample();
  assert.equal(r.deduped, true);
  assert.equal(seen.length, 1, '内容没变不该回调');

  r = await s2.sample('test', { force: true });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 2, 'forced 即使没变化也要回调');
  assert.equal(seen[1].meta.forced, true);
  assert.equal(seen[1].meta.changed, false);

  t += MIN_SAMPLE_GAP_MS + 1;
  resp = { ...SAMPLE, active: { ...SAMPLE.active, title: 'b.js — surfcore - Visual Studio Code' } };
  r = await s2.sample();
  assert.equal(seen.length, 3);
  assert.equal(seen[2].meta.kind, 'window', '只变标题算窗口变化');

  off();
  t += MIN_SAMPLE_GAP_MS + 1;
  resp = { ...SAMPLE, active: { ...SAMPLE.active, title: 'c.js — surfcore - Visual Studio Code' } };
  await s2.sample();
  assert.equal(seen.length, 3, '退订后不再回调');
  s2.stop();
});

// ── 11. 事件文案 + feed 节流/去重 ──────────────────────────────────────
check('事件文案：文件 / 窗口 / 音乐', () => {
  const fileEvent = buildActivityEvent(sanitizeSample(SAMPLE), 'file');
  assert.equal(fileEvent.kind, 'file');
  assert.match(fileEvent.text, /你在改「a\.js」（surfcore） — VS Code/);
  assert.equal(fileEvent.eventKey, 'file:Code:a.js:surfcore');

  const winSample = sanitizeSample({
    at: 1, active: { app: 'Code', title: 'vite.config.js', kind: 'editor', file: '', project: '' }, media: null, cursor: null,
  });
  assert.equal(buildActivityEvent(winSample, 'window').text, '你在用 VS Code 看「vite.config.js」');

  const musicEvent = buildActivityEvent(
    { active: null, media: { app: 'QQMusic.exe', title: 'Fallen Angel', artist: 'Wolfgang Laux', status: 'playing' }, cursor: null },
    'music',
  );
  assert.equal(musicEvent.text, '在听《Fallen Angel》 — Wolfgang Laux');
  assert.equal(activityKindOf(sanitizeSample(SAMPLE)), 'file');
  assert.equal(activityKindOf({ active: null, media: { title: 't' } }), 'music');
});

check('feed：按 bubbleEveryMs 节流 + 同 key 去重 + forced 绕过', () => {
  let nowMs = 1_700_000_000_000;
  const added = [];
  const feed = createActivityFeed({
    addMessage: (m) => added.push(m),
    getConfig: () => ({ activity: { bubbleEveryMs: 600000 } }),
    now: () => nowMs,
  });
  const sample = sanitizeSample(SAMPLE);
  const r1 = feed.handle(sample, { kind: 'file' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(added.length, 1);
  assert.equal(added[0].kind, 'event');
  assert.equal(added[0].who, 'her');

  const r2 = feed.handle(sample, { kind: 'file' });
  assert.equal(r2.ok, false);
  assert.equal(r2.skipped, 'rate', '间隔没到不能说第二句');

  nowMs += 600001;
  const r3 = feed.handle(sample, { kind: 'file' });
  assert.equal(r3.ok, true, '过了节流窗口可以再说一次');

  const r4 = feed.handle(sample, { kind: 'file', forced: true });
  assert.equal(r4.ok, true, 'forced 无视节流');
  assert.equal(added.length, 3);
  const st = feed.state();
  assert.equal(st.eventCount, 3);
  assert.equal(st.bubbleEveryMs, 600000);
  assert.ok(st.lastEventAt > 0 && st.lastEvent);
});

// ── 12. 事件伪消息不进 history / 聊天存档 ──────────────────────────────
await acheck('互动事件是 kind=event 的伪消息，不进聊天存档', async () => {
  const { createOrbService } = await import('../lib/orb.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-activity-feed-'));
  const archived = [];
  const orb = createOrbService({
    stateDir: dir,
    pluginLog: () => {},
    getSubprocess: () => null,
    archiveMessage: (m) => archived.push(m),
  });
  const feed = createActivityFeed({
    addMessage: (m) => orb.addMessage(m),
    getConfig: () => ({ activity: { bubbleEveryMs: 600000 } }),
    now: () => 1_700_000_000_000,
  });
  const before = orb.listMessages(20).messages.length;
  const r = feed.handle(sanitizeSample(SAMPLE), { kind: 'file', forced: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const msgs = orb.listMessages(20).messages;
  assert.equal(msgs.length, before + 1);
  assert.equal(msgs[msgs.length - 1].kind, 'event');
  assert.match(msgs[msgs.length - 1].text, /你在改「a\.js」/);
  assert.equal(archived.length, 0, 'event 不进聊天存档 / 记忆卡');
});

if (failed) { console.error(`\n✗ orb activity：${failed} 项失败`); process.exit(1); }
console.log('\n✓ 互动监测检查通过');
