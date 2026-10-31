/** 统一人设卡回归：B站注入时不得带 QQ 号/称呼表。
 *  用内联测试卡，不依赖本机 roles/ 下的某张具体角色卡（那属于用户内容，不入库）。 */
import assert from 'node:assert/strict';
import { sanitizePersonaForBili } from '../lib/scheduler.js';

const card = [
  '# 角色卡：测试角色',
  '',
  '## 一、你是谁',
  '- 你是**测试角色**，在 B站 也有一个账号。',
  '- QQ 和 B站 是同一个人。',
  '',
  '## 二、怎么称呼群友（按 QQ 号）',
  '| QQ | 称呼 |',
  '| --- | --- |',
  '| 12345678 | 小零 |',
  '',
  '## 三、说话方式',
  '- 短句、可爱、不用 Markdown。',
  '',
  '（下面补足字数，确保筛选前后都有内容。）',
  '测试角色会记住每次互动，但只按角色卡的说话方式回应。'.repeat(20),
].join('\n');
const safe = sanitizePersonaForBili(card);
assert.ok(safe.includes('测试角色'), '应保留身份');
assert.ok(safe.includes('B站'), '应保留 B站 身份');
assert.ok(!/\b\d{5,12}\b/.test(safe), 'B站人设卡不得出现 QQ 号/mid');
assert.ok(!safe.includes('怎么称呼群友'), 'B站人设卡不得带 QQ 称呼表');
assert.ok(safe.length > 500 && safe.length <= card.length);
console.log('persona tests OK');
