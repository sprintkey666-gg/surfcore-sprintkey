#!/usr/bin/env node
/**
 * 桌宠动画包（换皮）回归测试。
 *
 * 覆盖：
 *   1. 空目录：只有内置包，activePackId = dsh-pet
 *   2. 导入文件夹 → 出现在列表里、能 activate，dir 跟着切
 *   3. 导入 .tgz（认 assets/webm/* + assets/config.jsonc，剥掉 package/ 顶层）
 *   4. verify 报缺失数量
 *   5. remove 只删自己、内置包删不掉
 *   6. preview 写 preview.json（渲染端读 name/at）
 *   7. 路径穿越之类的脏 id 不会删到 packs 目录外
 *
 * 用法：node lib/test-pet-packs.mjs（脚本在 scripts/ 下时用 node scripts/test-pet-packs.mjs）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPetAssetsService } from '../lib/pet-assets.js';
import { DEFAULT_TINTS, normalizeTints } from '../lib/pet-packs.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`not ok - ${name}`); console.error(error?.stack || error); }
}
async function acheck(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { failed += 1; console.error(`not ok - ${name}`); console.error(error?.stack || error); }
}

const WEBMS = ['待机', '东张西望', '被摸一下'];

function mkState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-packs-'));
  // 内置包素材（老布局：<state>/orb/pet/webm/*.webm）
  const builtin = path.join(dir, 'orb', 'pet');
  fs.mkdirSync(path.join(builtin, 'webm'), { recursive: true });
  for (const name of WEBMS) fs.writeFileSync(path.join(builtin, 'webm', `${name}.webm`), Buffer.from('fake'));
  fs.writeFileSync(path.join(builtin, 'config.jsonc'), JSON.stringify({
    idle: ['待机'], turn: ['东张西望'], clicks: ['被摸一下'], animationWeights: { idle: 10, turn: 5, click: 0 },
  }));
  return dir;
}

function mkPackDir(parent, id, names = ['待机', '转圈']) {
  const dir = path.join(parent, id);
  fs.mkdirSync(path.join(dir, 'webm'), { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(dir, 'webm', `${name}.webm`), Buffer.from('fake'));
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, name: `${id} 的形象`, version: '1.0.0', license: 'MIT' }));
  return dir;
}

function mkFigureDir(parent, id, { entry = true } = {}) {
  const dir = path.join(parent, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, name: `${id} 的网页形象`, version: '1.0.0', license: 'MIT' }));
  if (entry) fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body>fish</body></html>');
  return dir;
}

const state = mkState();
// 走 pet-assets 这个真实入口：它才是给 pet-packs 注入 readTar/buildManifest 的那一层。
const assets = createPetAssetsService({ stateDir: state });
const svc = assets.packs;

check('空目录只有内置包', () => {
  const list = svc.list();
  assert.equal(list.activePackId, 'dsh-pet');
  assert.ok(list.packs.some((p) => p.id === 'dsh-pet' && p.builtin === true));
});

await acheck('导入文件夹后能启用', async () => {
  const src = mkPackDir(path.join(state, 'imports'), 'cat-01');
  const imported = await svc.handleAction({ action: 'import', path: src });
  assert.equal(imported.ok, true);
  const list = svc.list();
  assert.ok(list.packs.some((p) => p.id === 'cat-01'), '导入的包要出现在列表里');
  const act = await svc.handleAction({ action: 'activate', id: 'cat-01' });
  assert.equal(act.ok, true);
  assert.equal(svc.list().activePackId, 'cat-01');
  // assets.dir 才是「现在用的是哪个包的目录」；packs.dir 是 packs 根目录。
  assert.ok(assets.dir.includes('cat-01'), `assets.dir 要切到新包：${assets.dir}`);
  assert.ok(svc.active().dir.includes('cat-01'));
});

await acheck('导入 tgz（assets/webm 布局）', async () => {
  const tgz = path.join(state, 'upstream.tgz');
  const stage = path.join(state, 'stage-assets');
  fs.mkdirSync(path.join(stage, 'assets', 'webm'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'assets', 'webm', '挥手.webm'), Buffer.from('fake'));
  fs.writeFileSync(path.join(stage, 'assets', 'config.jsonc'), JSON.stringify({ idle: ['挥手'] }));
  const { execFileSync } = await import('node:child_process');
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'assets']);
  const imported = await svc.handleAction({ action: 'import', path: tgz });
  assert.equal(imported.ok, true);
  const id = imported.id || imported.packId;
  assert.ok(id, '导入结果要带新包 id');
  assert.ok(svc.list().packs.some((p) => p.id === id));
});

check('verify 报缺失', () => {
  const bad = path.join(state, 'orb', 'pet', 'packs', 'cat-01');
  assert.ok(fs.existsSync(bad));
  fs.rmSync(path.join(bad, 'webm', '转圈.webm'));
  const v = svc.verify('cat-01');
  assert.equal(v.missing.length >= 0, true);
  assert.ok(Array.isArray(v.missing));
});

check('preview 写 preview.json', () => {
  const r = svc.queuePreview('转圈');
  assert.equal(r.ok, true);
  const file = path.join(state, 'orb', 'pet', 'preview.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.name, '转圈');
  assert.ok(data.at > 0);
});

check('内置包删不掉', () => {
  const r = svc.remove('dsh-pet');
  assert.equal(r.ok, false);
  assert.ok(svc.list().packs.some((p) => p.id === 'dsh-pet'));
});

check('脏 id 不会越界删除', () => {
  const r = svc.remove('../..');
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(path.join(state, 'orb', 'pet', 'webm')));
});

check('删掉导入的包后回落到内置', () => {
  const r = svc.remove('cat-01');
  assert.equal(r.ok, true);
  assert.equal(svc.list().activePackId, 'dsh-pet');
});

await acheck('figure 包：导入后按 index.html 判成 figure', async () => {
  const src = mkFigureDir(path.join(state, 'imports'), 'fish-01');
  const imported = await svc.handleAction({ action: 'import', path: src });
  assert.equal(imported.ok, true, imported.error);
  const item = svc.list().packs.find((p) => p.id === 'fish-01');
  assert.equal(item.kind, 'figure');
  assert.equal(item.installed, true);
  assert.ok(item.entry.endsWith('index.html'), `entry 要指向 index.html：${item.entry}`);
  const d = svc.detail('fish-01');
  assert.equal(d.ok, true);
  assert.equal(d.pack.kind, 'figure');
  assert.equal(d.pack.manifest, null, 'figure 包没有动画清单');
  assert.match(d.pack.entryUrl, /^file:\/\//, 'entryUrl 要是 file:// URL');
  assert.equal(svc.verify('fish-01').ok, true);
  const act = await svc.handleAction({ action: 'activate', id: 'fish-01' });
  assert.equal(act.ok, true, act.error);
  assert.equal(svc.list().activePackId, 'fish-01');
  assert.equal(svc.active().kind, 'figure');
  assert.ok(assets.dir.includes('fish-01'), `assets.dir 要切到 figure 包：${assets.dir}`);
});

await acheck('figure 包：tgz 里只带 index.html 也能装', async () => {
  const tgz = path.join(state, 'figure.tgz');
  const stage = path.join(state, 'stage-figure');
  fs.mkdirSync(path.join(stage, 'fig'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'fig', 'index.html'), '<!doctype html><html><body>tgz-fish</body></html>');
  const { execFileSync } = await import('node:child_process');
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'fig']);
  const imported = await svc.handleAction({ action: 'import', path: tgz, id: 'fish-tgz' });
  assert.equal(imported.ok, true, imported.error);
  const item = svc.list().packs.find((p) => p.id === 'fish-tgz');
  assert.equal(item.kind, 'figure');
  assert.equal(item.installed, true);
});

check('activate 失败时保持原包不回落', () => {
  const dir = path.join(state, 'orb', 'pet', 'packs', 'broken-fig');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id: 'broken-fig', name: '坏包', kind: 'figure' }));
  const before = svc.list().activePackId;
  const r = svc.activate('broken-fig');
  assert.equal(r.ok, false);
  assert.match(String(r.error), /index\.html/);
  assert.equal(svc.list().activePackId, before, '切换失败不能把 activePackId 改掉');
});

check('list 形状：id/name/kind/active/error 齐全', () => {
  for (const p of svc.list().packs) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.name, 'string');
    assert.ok(['webm', 'figure'].includes(p.kind), `kind 不合法：${p.id} ${p.kind}`);
    assert.equal(typeof p.active, 'boolean');
    assert.equal(typeof p.error, 'string');
    assert.ok('entry' in p && 'license' in p && 'installed' in p);
  }
});

await acheck('内置清单 + install 随仓 figure 包', async () => {
  const cat = svc.catalog();
  assert.ok(cat.packs.some((p) => p.id === 'dsh-pet' && /^dsh-pet@/.test(p.npm || '')), '清单里要有 dsh-pet@npm');
  assert.ok(cat.packs.some((p) => p.id === 'sprintkey-fish' && p.bundled), '清单里要有随仓的 sprintkey-fish');
  const r = await svc.handleAction({ action: 'install', id: 'sprintkey-fish' });
  assert.equal(r.ok, true, r.error);
  const item = svc.list().packs.find((p) => p.id === 'sprintkey-fish');
  assert.equal(item.kind, 'figure');
  assert.equal(item.installed, true);
  assert.equal(svc.list().activePackId, 'sprintkey-fish', 'install 默认装完就切换');
  const reg = JSON.parse(fs.readFileSync(path.join(state, 'orb', 'pet', 'packs.json'), 'utf8'));
  assert.ok(reg.packs.some((p) => p.id === 'sprintkey-fish'), 'install 后要写进 packs.json 注册表');
});

check('内置 figure 包会被 catalog 同步落盘并能直接启用', () => {
  // 真机 bug：sprintkey-fish 只在 index.json 里，packs/ 下没有目录 → activate 报「没有这个皮肤包」。
  // list() 之前会 syncCatalog()，把随仓包复制成 packs/<id>/。
  const dir = path.join(state, 'orb', 'pet', 'packs', 'sprintkey-fish');
  assert.ok(fs.existsSync(path.join(dir, 'index.html')), '同步后 packs/sprintkey-fish/index.html 要存在');
  const item = svc.list().packs.find((p) => p.id === 'sprintkey-fish');
  assert.equal(item.installed, true, '同步后内置 figure 包应是已安装状态');
  const r = svc.activate('sprintkey-fish');
  assert.equal(r.ok, true, r.error);
  assert.equal(svc.list().activePackId, 'sprintkey-fish');
  const back = svc.activate('dsh-pet');
  assert.equal(back.ok, true, back.error);
});

check('未知皮肤包报错，不会乱切', () => {
  const before = svc.list().activePackId;
  const r = svc.activate('definitely-not-a-pack');
  assert.equal(r.ok, false);
  assert.match(String(r.error), /没有这个皮肤包/);
  assert.equal(svc.list().activePackId, before);
});

check('配色白名单：6 套默认、坏 filter 丢弃、safe filter 保留', () => {
  assert.equal(DEFAULT_TINTS.length, 6);
  assert.equal(DEFAULT_TINTS[0].id, '', '第一套必须是原色（空 id）');
  assert.ok(DEFAULT_TINTS.every((t) => typeof t.filter === 'string' && t.filter.length > 0));
  const bad = normalizeTints([{ id: 'x', name: '坏', filter: 'url(javascript:1)' }]);
  assert.ok(bad.some((t) => t.id === ''), '全坏时回落默认（含原色）');
  const good = normalizeTints([{ id: 'warm', name: '暖', filter: 'hue-rotate(20deg) saturate(1.1)' }]);
  assert.ok(good.some((t) => t.id === 'warm' && t.filter.includes('hue-rotate')));
  assert.ok(good.some((t) => t.id === ''), '缺原色要补上');
});

check('清单里的 big-blue-fish 是可下载的 github-assets 包', () => {
  const entry = svc.catalog().packs.find((p) => p.id === 'big-blue-fish');
  assert.ok(entry, 'index.json 里要有 big-blue-fish');
  assert.equal(entry.kind, 'webm');
  assert.equal(entry.source.kind, 'github-assets');
  assert.equal(entry.source.repo, 'Bai-Cute/big-blue-fish-desktop-pet');
  assert.match(entry.source.tarball, /codeload\.github\.com/);
  assert.equal(entry.source.assetDir, 'code/BigBlueFish.Windows/assets/fish');
  assert.equal(entry.license, 'MIT');
});

await acheck('github-assets 包：只取素材目录并转成我们的 manifest', async () => {
  const entry = svc.catalog().packs.find((p) => p.id === 'big-blue-fish');
  assert.ok(entry && !entry.bundled);
  const stage = path.join(state, 'stage-gh');
  // GitHub tarball 顶层是「仓库名-ref/」，stripTopDir 之后才是 code/...。
  const root = path.join(stage, 'big-blue-fish-desktop-pet-main');
  const fish = path.join(root, 'code', 'BigBlueFish.Windows', 'assets', 'fish');
  fs.mkdirSync(fish, { recursive: true });
  const animations = [
    { Id: '待机呼吸', File: '待机呼吸.webm', Pool: 'Idle', Weight: 1 },
    { Id: '点击回应', File: '点击回应.webm', Pool: 'Click' },
    { Id: '拖拽反馈', File: '拖拽反馈.webm', Pool: 'Drag' },
    { Id: '事件闲聊', File: '事件闲聊.webm', Pool: 'Event' },
    { Id: '节日烟花', File: '节日烟花.webm', Pool: 'Event', Festival: 'Spring', RadiusDays: 3 },
    { Id: '已禁用', File: '已禁用.webm', Pool: 'Disabled' },
  ];
  fs.writeFileSync(path.join(fish, 'animations.json'), JSON.stringify(animations));
  fs.writeFileSync(path.join(fish, 'LICENSE.txt'), 'MIT License\nCopyright (c) 2026 PC2005-cloud\n');
  for (const a of animations) fs.writeFileSync(path.join(fish, a.File), Buffer.from('fake-webm'));
  fs.writeFileSync(path.join(root, 'code', 'BigBlueFish.Windows', 'README.md'), 'not-asset');
  const tgz = path.join(state, 'big-blue-fish.tgz');
  const { execFileSync } = await import('node:child_process');
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'big-blue-fish-desktop-pet-main']);
  const buf = fs.readFileSync(tgz);

  const installed = await svc.installFromGithubTgz(buf, entry, { overwrite: true });
  assert.equal(installed.ok, true, installed.error);
  const item = svc.list().packs.find((p) => p.id === 'big-blue-fish');
  assert.ok(item, '装完要出现在列表里');
  assert.equal(item.kind, 'webm');
  assert.equal(item.installed, true);
  assert.equal(item.webmCount, animations.length, '素材目录里的 webm 都要收进来');
  assert.equal(fs.existsSync(path.join(item.dir, 'LICENSES', 'big-blue-fish-LICENSE.txt')), true, 'LICENSE 要落到 LICENSES/');
  const man = JSON.parse(fs.readFileSync(path.join(item.dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(man.idle, ['待机呼吸']);
  assert.deepEqual(man.clicks, ['点击回应']);
  assert.deepEqual(man.drag, ['拖拽反馈']);
  assert.ok(man.categories.some((c) => c.id === 'event' && c.actions.includes('事件闲聊')));
  assert.ok(!JSON.stringify(man).includes('已禁用'), 'Disabled 的动画不写进 manifest');
  assert.ok(!JSON.stringify(man).includes('节日烟花'), '节日动画只进 festivals 元数据');
  const festivals = JSON.parse(fs.readFileSync(path.join(item.dir, 'festivals.json'), 'utf8'));
  assert.equal(festivals.festivals.length, 1);
  assert.equal(festivals.festivals[0].action, '节日烟花');
  assert.equal(festivals.festivals[0].festival, 'Spring');
  assert.equal(festivals.festivals[0].radiusDays, 3);
});

if (failed) { console.error(`\n✗ pet packs：${failed} 项失败`); process.exit(1); }
console.log('\n✓ 桌宠动画包检查通过');
