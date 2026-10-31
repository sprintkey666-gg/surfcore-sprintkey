// 桌宠"更新"必须保住用户数据：旧实现走 install()，而 unzip() 会先 rmSync 整个安装目录 ——
// data/（Chromium profile + 本地数据）和用户自己加的 skins 会被一起删掉。
// 这个用例用真实的 zip 走一遍 updateFromZip()，断言版本换了、数据还在、备份目录被清掉。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPetService } from '../lib/pet.js';

if (process.platform !== 'win32') {
  console.log('（非 Windows，跳过：pet 的解压依赖 PowerShell Expand-Archive）');
  process.exit(0);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-pet-update-'));
const stateDir = path.join(base, 'state');
const appDir = path.join(base, 'app');
const packDir = path.join(base, 'pack');
const zipPath = path.join(base, 'pet-pack.zip');

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

try {
  fs.mkdirSync(path.join(stateDir, 'pet'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'pet', 'config.json'), JSON.stringify({ appDir, source: '', electronPath: '' }));

  // 旧安装：带标记 + 用户数据 + 用户皮肤 + 残留 pid
  fs.mkdirSync(path.join(appDir, 'data', 'profile'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'skins'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'feiyu-pet', version: '0.1.0' }));
  fs.writeFileSync(path.join(appDir, '.surfcore-pet.json'), JSON.stringify({ source: 'test' }));
  fs.writeFileSync(path.join(appDir, 'data', 'profile', 'keep.txt'), 'user-data');
  fs.writeFileSync(path.join(appDir, 'skins', 'my-skin.png'), 'user-skin');
  fs.writeFileSync(path.join(appDir, 'run.pid'), '12345');
  fs.writeFileSync(path.join(appDir, 'dist', 'old.js'), 'old');

  // 新包：新版本 + 新 dist，不含 data/
  fs.mkdirSync(path.join(packDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'package.json'), JSON.stringify({ name: 'feiyu-pet', version: '0.2.0' }));
  fs.writeFileSync(path.join(packDir, 'dist', 'new.js'), 'new');
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${path.join(packDir, '*').replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
  ], { stdio: 'ignore' });

  const pet = createPetService({ stateDir, pluginLog: () => {}, getSubprocess: () => null });
  const result = await pet.updateFromZip(zipPath);

  ok(result.ok === true, `更新成功（${result.error ?? 'ok'}）`);
  ok(result.version === '0.2.0', `版本变成 0.2.0（实际 ${result.version}）`);
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  ok(pkg.version === '0.2.0', '安装目录里的 package.json 已更新');
  ok(fs.existsSync(path.join(appDir, 'data', 'profile', 'keep.txt')), 'data/ 用户数据被保留');
  ok(fs.readFileSync(path.join(appDir, 'data', 'profile', 'keep.txt'), 'utf8') === 'user-data', 'data/ 内容没变');
  ok(fs.existsSync(path.join(appDir, 'skins', 'my-skin.png')), '用户自己加的皮肤被保留');
  ok(fs.existsSync(path.join(appDir, 'dist', 'new.js')), '新包文件就位');
  ok(!fs.existsSync(path.join(appDir, 'run.pid')), '残留 run.pid 被清掉');
  ok(!fs.existsSync(`${appDir}.old-`) || !fs.readdirSync(base).some((name) => name.startsWith('app.old-')), '临时备份目录已清理');
  ok(fs.existsSync(path.join(appDir, '.surfcore-pet.json')), '安装标记仍在（后续卸载/覆盖仍受闸门保护）');
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
}

console.log(failures === 0 ? '\n✅ 桌宠更新保留数据回归通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
