/** 四类动态的选题信号回归（2026-10-22：动漫「动画/逐帧」误伤、红警 2v3 误伤）。 */
import assert from 'node:assert/strict';
import { hasKindSignal } from '../tools/lib/kind-signals.mjs';

assert.equal(hasKindSignal('anime', '《凡人修仙传动画》196 逐帧解析，文戏细节'), true);
assert.equal(hasKindSignal('anime', '【MAD】可塑性记忆 ED 混剪'), true);
assert.equal(hasKindSignal('anime', '今天吃了顿火锅'), false);

assert.equal(hasKindSignal('game', '原神 AI 二创：雨之城实机演示'), true);
assert.equal(hasKindSignal('game', '普通游戏实况'), false);

assert.equal(hasKindSignal('gaming', '红警 08 和老三 2v3 翻盘'), true);
assert.equal(hasKindSignal('gaming', '一个安静的 vlog'), false);

assert.equal(hasKindSignal('best', '什么都行'), true, 'best 不检查类别信号');

console.log('kind signal tests OK');
