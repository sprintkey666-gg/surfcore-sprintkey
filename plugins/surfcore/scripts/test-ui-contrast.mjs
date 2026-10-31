// 界面可见性回归：防止"浅色底 + 浅色字"和"未限定作用域的全局覆盖"再次出现。
//
// 背景：2026-10-27 用户反馈深色主题下更新弹窗像一层白膜（白底浅字）；
// 修的时候还差点引入全局覆盖（.qbw-hint 被改成 #9aa3ad，影响所有提示文字）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js');
const css = fs.readFileSync(file, 'utf8');

// 1) 弹窗必须自带高对比配色（不依赖主题 token）
const modal = /\.qbw-modal\{([^}]*)\}/.exec(css)?.[1] ?? '';
assert.ok(modal, '找不到 .qbw-modal 样式');
assert.match(modal, /background:\s*#[0-9a-f]{6}/i, '.qbw-modal 必须写死深色背景（不能只靠主题 token）');
assert.match(modal, /color:\s*#[0-9a-f]{6}/i, '.qbw-modal 必须写死浅色文字');

// 2) 任何 #fff / 近白色文字都不许配浅底：禁止全局把 hint/chip 改成固定浅色
const globalLightText = [/^\.qbw-hint\{color:#/m, /^\.qbw-chip\{background:rgba\(255,255,255/m];
for (const bad of globalLightText) {
  assert.ok(!bad.test(css), `发现未限定作用域的浅色覆盖：${bad}`);
}

// 3) 弹窗内的覆盖必须带 .qbw-modal 前缀
const lines = css.split('\n').filter((line) => line.includes('#9aa3ad') || line.includes('rgba(255,255,255,.12)'));
for (const line of lines) {
  assert.ok(line.trimStart().startsWith('.qbw-modal'), `弹窗配色覆盖没有限定作用域：${line.trim().slice(0, 60)}`);
}

// 4) 主要文字使用成对的 label token（而不是写死 #fff）
assert.match(css, /\.qbw-app\{[^}]*color:var\(--dsw-alias-label-primary\)/, '.qbw-app 的文字颜色应跟随主题 label-primary');

console.log('✅ 界面可见性检查通过');
