// 桌宠「安装目录」安全闸的单测（RISK R34）。
//
// 背景：设置页允许用户手填安装目录，而 install / unzip / remove 会对它做
// `fs.rmSync(recursive, force)`。2026-10-26 之前只做 path.resolve，于是把目录填成
// 别的工程目录 → 点安装/卸载就整目录清空。修法见 `lib/pet.js` 的 `checkAppDir()`。
//
// 这里用临时目录造夹具，不碰真实安装目录、不启动任何进程。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAppDir, looksLikePetInstall, PET_MARKER } from '../lib/pet.js';

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-dir-guard-'));
const stateDir = path.join(sandbox, 'state');
const petRoot = path.join(stateDir, 'pet');
const home = path.join(sandbox, 'home');
const repoLike = path.join(sandbox, 'repo');
for (const dir of [stateDir, petRoot, home, repoLike]) fs.mkdirSync(dir, { recursive: true });
// 一个"像仓库"的目录：有 package.json，但没有本程序的标记
fs.writeFileSync(path.join(repoLike, 'package.json'), JSON.stringify({ name: 'surfcore', version: '0.1.0' }));
// 默认安装目录（空）
const defaultApp = path.join(petRoot, 'app');
fs.mkdirSync(defaultApp, { recursive: true });

const guard = (target, extra = {}) => checkAppDir(target, {
  protectedPaths: [petRoot, stateDir, path.dirname(stateDir), home],
  ...extra,
});

console.log('## 1. 危险目标一律拒绝');
{
  ok(!guard(path.parse(sandbox).root).ok, '磁盘根目录（D:\\ / C:\\）→ 拒绝');
  ok(!guard(home).ok, '用户主目录本身 → 拒绝');
  ok(!guard(path.dirname(home)).ok, '用户主目录的上级 → 拒绝');
  ok(!guard(stateDir).ok, '插件状态目录 ~/.dsh/surfcore → 拒绝');
  ok(!guard(petRoot).ok, '桌宠根目录 ~/.dsh/surfcore/pet → 拒绝');
  ok(!guard(path.dirname(stateDir)).ok, 'DSH 家目录 ~/.dsh → 拒绝');
  ok(!guard('').ok, '空路径 → 拒绝');
}

console.log('## 2. 非空的外来目录（关键场景）');
{
  const r = guard(repoLike);
  ok(!r.ok, '有 package.json 但不是本程序装的目录（例如仓库根）→ 拒绝');
  ok(r.reason.includes('标记'), `拒绝理由说明白（${r.reason.slice(0, 30)}…）`);
  ok(!guard(repoLike, { allowNonEmpty: true }).ok === false, '（对照）调用方声明"这是我们装的"时才放行非空');
}

console.log('## 3. 正常场景必须放行');
{
  ok(guard(defaultApp).ok, '空目录 → 放行（首次安装）');
  const fresh = path.join(sandbox, 'brand-new');
  ok(guard(fresh).ok, '不存在的路径 → 放行（会被创建）');
  // 装过之后：有标记文件 → 允许覆盖/卸载
  fs.writeFileSync(path.join(defaultApp, PET_MARKER), '{}');
  fs.writeFileSync(path.join(defaultApp, 'package.json'), '{}');
  ok(guard(defaultApp, { allowNonEmpty: true }).ok, '带安装标记的目录 → 放行（重装/卸载）');
  ok(!guard(defaultApp, { allowNonEmpty: false }).ok, '同一个目录若调用方没声明所有权 → 仍然拒绝（双保险）');
}

console.log('## 4. 老安装的认领（本改动之前装的目录没有标记文件）');
{
  // 长得像桌宠包：skins/ + package.json(name 含 pet) + dist/
  const legacy = path.join(sandbox, 'legacy-pet');
  fs.mkdirSync(path.join(legacy, 'skins', 'fish'), { recursive: true });
  fs.mkdirSync(path.join(legacy, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'package.json'), JSON.stringify({ name: 'feiyu-pet', version: '0.2.0' }));
  ok(looksLikePetInstall(legacy), 'skins + feiyu-pet + dist → 认作桌宠安装（可认领）');
  ok(guard(legacy, { allowNonEmpty: looksLikePetInstall(legacy) }).ok, '认领后允许覆盖/卸载');
  // 只有 package.json 的工程目录：绝不能被认领
  ok(!looksLikePetInstall(repoLike), '只有 package.json 的工程目录 → 不认领');
  // 有 skins 但名字不像桌宠：不认领
  const weird = path.join(sandbox, 'weird');
  fs.mkdirSync(path.join(weird, 'skins'), { recursive: true });
  fs.mkdirSync(path.join(weird, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(weird, 'package.json'), JSON.stringify({ name: 'some-editor' }));
  ok(!looksLikePetInstall(weird), 'skins 存在但包名不像桌宠 → 不认领');
}

console.log('## 5. 边界');
{
  const filePath = path.join(sandbox, 'a-file.txt');
  fs.writeFileSync(filePath, 'x');
  ok(!guard(filePath).ok, '目标是一个文件 → 拒绝');
  const sibling = path.join(sandbox, 'sibling-pet');
  fs.mkdirSync(sibling, { recursive: true });
  ok(guard(sibling).ok, '同级空目录 → 放行（不误伤相邻目录）');
  const nested = path.join(defaultApp, '..', 'app2');
  ok(guard(nested).ok, '带 .. 但解析后仍是空的新目录 → 放行');
  ok(guard(path.join(petRoot, '..', 'pet')).ok === false, '绕路径回到受保护目录（..）→ 拒绝');
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(failures === 0 ? '\n✅ 桌宠安装目录安全闸通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
