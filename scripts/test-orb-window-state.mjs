#!/usr/bin/env node
// 桌宠/陪伴字幕窗的窗口状态自测（不需要 Electron，也不碰真实窗口）。
// 用法：node scripts/test-orb-window-state.mjs
//
// 覆盖两类东西：
//   1) main.js 里 `// #region pure-window-state` 之间的纯函数——直接抽出来在 node:vm 里跑，
//      保证「隐藏后不该显示」「陪伴模式托盘只看字幕窗」「宽度容差」「高度网格/底边锚定」这些
//      判断逻辑有可回归的断言（它们以前散在 IPC/轮询里，就是闪烁和残留的来源）。
//   2) 三个文件里几条关键约定（不许 backdrop-filter、必须用 ResizeObserver、onState 不许重置
//      变暗计时器、tick 自愈阈值、second-instance 不许越权显示）。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const orbDir = path.join(root, 'plugins', 'surfcore', 'assets', 'orb-app');
const read = (name) => readFileSync(path.join(orbDir, name), 'utf8');

const mainSrc = read('main.js');
const companionSrc = read('companion.js');
const companionCss = read('companion.css');

let checks = 0;
const failures = [];
function check(name, fn) {
  checks += 1;
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`);
  }
}
function eq(actual, expected, label = '') {
  if (actual !== expected) {
    throw new Error(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function deepEq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label} 期望 ${b}，实际 ${a}`);
}
function ok(cond, label) {
  if (!cond) throw new Error(label || '断言失败');
}

// ---------- 1. 抽出 pure-window-state 纯函数 ----------
const startTag = '// #region pure-window-state';
const endTag = '// #endregion pure-window-state';
const start = mainSrc.indexOf(startTag);
const end = mainSrc.indexOf(endTag);
ok(start >= 0 && end > start, 'main.js 里找不到 pure-window-state 标记');
const region = mainSrc.slice(start, end + endTag.length);

const sandbox = vm.createContext({});
vm.runInContext(`${region}
globalThis.__pure = {
  companionShouldShow, trayToggleAction, restoreSurface, widthConverged,
  snapCompanionHeight, anchorCompanionBottom, companionMaxWidth,
};`, sandbox, { filename: 'main.js#pure-window-state' });
const P = sandbox.__pure;
for (const name of ['companionShouldShow', 'trayToggleAction', 'restoreSurface', 'widthConverged',
  'snapCompanionHeight', 'anchorCompanionBottom', 'companionMaxWidth']) {
  check(`纯函数 ${name} 可加载`, () => eq(typeof P[name], 'function'));
}

const screen = { x: 0, y: 0, width: 2560, height: 1400 }; // 主人那台 2560x1440 / 175%

// 隐藏后不许再显示（「点了隐藏，桌宠还留在桌面上」的主进程闸门）
check('hiddenByUser 时字幕窗不该显示', () => {
  eq(P.companionShouldShow(true, false), true);
  eq(P.companionShouldShow(true, true), false);
  eq(P.companionShouldShow(false, false), false);
});

// 陪伴模式下托盘只看字幕窗（桌宠一直是隐藏的）
check('陪伴模式托盘动作看字幕窗可见性', () => {
  eq(P.trayToggleAction({ companionActive: true, mainVisible: false, companionVisible: true }), 'hide');
  eq(P.trayToggleAction({ companionActive: true, mainVisible: false, companionVisible: false }), 'show');
  eq(P.trayToggleAction({ companionActive: false, mainVisible: true, companionVisible: false }), 'hide');
  eq(P.trayToggleAction({ companionActive: false, mainVisible: false, companionVisible: false }), 'show');
});

check('从托盘唤醒恢复哪个窗口', () => {
  eq(P.restoreSurface(true), 'companion');
  eq(P.restoreSurface(false), 'main');
});

// setBounds 写 738 回读 740 是常态：必须在容差内算收敛，否则每 3 秒纠一次宽
check('宽度收敛带 4px 容差', () => {
  eq(P.widthConverged(740, 738), true);
  eq(P.widthConverged(742, 738), true);
  eq(P.widthConverged(743, 738), false);
  eq(P.widthConverged(745, 738), false);
});

// 高度按 8px 网格 + 12px 死区：1~3px 的抖动不许改窗口
check('字幕高度 8px 网格 + 12px 死区', () => {
  eq(P.snapCompanionHeight(250, 244), null); // 248 与 244 差 4，忽略
  eq(P.snapCompanionHeight(244, 246), null); // 差 2
  eq(P.snapCompanionHeight(300, 244), 304); // 网格取整后才上报
  eq(P.snapCompanionHeight(40, 244), 56); // 低于下限夹到 56
  eq(P.snapCompanionHeight(Number.NaN, 244), null);
});

// 底边锚定：内容变高/变矮，脚底不动；越界才向上让位、绝不下移
check('高度变化以底边为锚点', () => {
  deepEq(
    P.anchorCompanionBottom({ x: 100, y: 700, width: 800, height: 200 }, 300, screen),
    { x: 100, y: 600, width: 800, height: 300 },
  );
});

check('高度夹到 56~560', () => {
  const big = P.anchorCompanionBottom({ x: 0, y: 600, width: 800, height: 200 }, 900, screen);
  eq(big.height, 560);
  eq(big.y + big.height, 800); // 底边仍是原来的 800
  eq(P.anchorCompanionBottom({ x: 0, y: 600, width: 800, height: 200 }, 1, screen).height, 56);
});

check('顶边越界时向上让位到 headroom', () => {
  const out = P.anchorCompanionBottom({ x: 0, y: 10, width: 800, height: 200 }, 300, { ...screen, y: 40 });
  eq(out.y, 44); // area.y + headroom
  ok(out.y + out.height <= 40 + 1400 - 8, '不能超出工作区底部');
});

check('底边越界时整体上移，不把高度切碎', () => {
  const out = P.anchorCompanionBottom({ x: 0, y: 1300, width: 800, height: 200 }, 300, screen);
  eq(out.y + out.height, 1392); // 工作区底部 - margin
  eq(out.height, 300);
});

// 建窗 / 纠宽 / 拖宽手柄必须同一个上限
check('字幕窗宽度上限统一', () => {
  eq(P.companionMaxWidth(2560), 1400);
  eq(P.companionMaxWidth(800), 776);
  eq(P.companionMaxWidth(500), 520);
  eq(P.companionMaxWidth(Number.NaN), 520);
});

// ---------- 2. main.js 关键约定（静态） ----------
check('SetWindowPos 不再带 SWP_SHOWWINDOW', () => {
  ok(mainSrc.includes('0x0013'), '缺少 0x0013 置顶标志');
  ok(!mainSrc.includes('0x0043'), '仍在用 0x0043（含 SWP_SHOWWINDOW，会反复触发显示）');
});

check('无边框窗口关掉 thickFrame', () => {
  const hits = mainSrc.split('thickFrame: false').length - 1;
  ok(hits >= 2, `thickFrame: false 出现 ${hits} 次，主窗和字幕窗都应有`);
});

check('tick 自愈阈值 >6 且直接落位', () => {
  ok(mainSrc.includes('if (drift > 6)'), '自愈阈值没改');
  ok(!mainSrc.includes('if (drift > 2)'), '仍在用 drift > 2');
  ok(/applyBounds\(fix, 'self-heal'\)/.test(mainSrc), '自愈应直接 applyBounds，不再 animateTo');
});

check('字幕后端状态去重发送', () => {
  ok(/function sendCompanionState\(/.test(mainSrc), '缺少 sendCompanionState');
  ok(/companionStateSignature/.test(mainSrc), '缺少状态指纹');
  ok(mainSrc.includes('sendCompanionState(state)'), 'ensure 里没有走去重发送');
});

check('隐藏到托盘时同时隐藏字幕窗', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('async function hideWindow()'), mainSrc.indexOf('function showWindow()'));
  ok(fn.includes('companionWin.hide()'), 'hideWindow 没藏字幕窗：陪伴模式下会残留');
  ok(fn.includes('hiddenByUser = true'), 'hideWindow 没标记 hiddenByUser');
  ok(!fn.includes('setExpanded(false)'), 'hideWindow 不该再播收起动画（动画中途窗口还露着）');
});

check('second-instance 不越权显示', () => {
  ok(/if \(!hiddenByUser\) showWindow\(\)/.test(mainSrc), 'second-instance 仍会无条件 showWindow');
});

check('only-darwin 才 setVisibleOnAllWorkspaces', () => {
  const needle = 'setVisibleOnAllWorkspaces(true';
  let idx = mainSrc.indexOf(needle);
  ok(idx > 0, '找不到 setVisibleOnAllWorkspaces(true)');
  let count = 0;
  while (idx > 0) {
    count += 1;
    const before = mainSrc.slice(Math.max(0, idx - 260), idx);
    ok(before.includes("process.platform === 'darwin'"), '有调用没包在 darwin 分支里：Windows 上会把窗口 cloaked');
    idx = mainSrc.indexOf(needle, idx + needle.length);
  }
  ok(count >= 2, `只找到 ${count} 处调用，主窗和字幕窗都该有`);
});

// ---------- 3. companion.js / companion.css 关键约定 ----------
check('字幕窗用 ResizeObserver 量高度', () => {
  ok(companionSrc.includes('ResizeObserver'), '缺少 ResizeObserver');
  ok(!companionSrc.includes('scrollHeight + 2'), '仍在用 scrollHeight + 2');
  ok(!companionSrc.includes('requestAnimationFrame(measureNow)'), '仍在用 rAF 防抖测高');
});

check('onState 不再重置变暗计时器', () => {
  const from = companionSrc.indexOf('function onState(next)');
  const raw = companionSrc.slice(from, companionSrc.indexOf('// 拖动：', from));
  ok(from > 0 && raw.length > 0, '找不到 onState');
  // 去掉注释再判断：代码注释里会提到 dimTimerReset 这个名字，不能算调用。
  const body = raw.replace(/\/\/[^\n]*/g, '');
  ok(!body.includes('dimTimerReset'), 'onState 里仍在 dimTimerReset：字幕永远不会变暗，且每 3 秒闪一次');
});

check('渲染走节点复用，不整块重建', () => {
  ok(companionSrc.includes('function renderHistory('), '缺少历史行缓存');
  ok(companionSrc.includes('threadRows'), '缺少行节点缓存');
  const reset = companionSrc.indexOf("thread.textContent = ''");
  const guard = companionSrc.indexOf('if (threadMode !== mode)');
  ok(reset > 0 && guard > 0 && reset > guard, "thread.textContent = '' 只应出现在模式切换里");
});

check('字幕条不再用 backdrop-filter', () => {
  // 去掉 CSS 注释再查：注释里会写「不要加 backdrop-filter」，那不是真的在用。
  const css = companionCss.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/backdrop-filter/.test(css), 'css 里仍有 backdrop-filter（透明窗 + 背景模糊会闪）');
  ok(!/filter:\s*blur\(/.test(css), 'css 里仍有 filter: blur()');
  ok(css.includes('box-shadow: inset'), '缺少内描边替代质感');
});

// ---------- 汇总 ----------
if (failures.length) {
  console.error(`✗ ${failures.length}/${checks} 项检查失败`);
  for (const f of failures) console.error('  -', f);
  process.exit(1);
}
console.log(`✓ ${checks} 项窗口状态检查通过`);
