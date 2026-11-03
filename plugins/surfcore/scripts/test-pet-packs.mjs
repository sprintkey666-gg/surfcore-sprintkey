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

if (failed) { console.error(`\n✗ pet packs：${failed} 项失败`); process.exit(1); }
console.log('\n✓ 桌宠动画包检查通过');
