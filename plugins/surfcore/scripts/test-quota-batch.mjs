// 2026-10-29：分享方式扩到 7 种组合后，「同一次分享的多条通道只占一次额度」的回归测试。
// 做法：把 DSH_HOME 指到临时目录，直接调用 quota.mjs 的 check/record，验证 --batch 批号去重。
//   · 同一批号：第一次占额度，后续 check 直接放行、record 不重复记账
//   · 不同批号：各自占额度，到达 shareDaily（默认 3）后第 4 次 check 必须拒（退出码 2）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QUOTA = path.join(HERE, '..', 'tools', 'commands', 'quota.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-batch-'));
const env = { ...process.env, DSH_HOME: tmp, USERPROFILE: tmp, HOME: tmp };

function run(args) {
  try {
    const out = execFileSync(process.execPath, [QUOTA, ...args], { encoding: 'utf8', env });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

let n = 0;
const ok = (msg) => { n += 1; console.log(`  ✓ ${msg}`); };

// 1) 第一批：check → record → 同批再 check 应放行且提示「同批次已占额度」
assert.equal(run(['check', '--share', '--type', 'dm', '--target', 'BV:aaa', '--batch', 'B1']).code, 0);
ok('第一批 check 放行');
assert.equal(run(['record', '--share', '--type', 'dm', '--target', 'BV:aaa', '--batch', 'B1', '--note', 'test']).code, 0);
ok('第一批 record 成功');
const same = run(['check', '--share', '--type', 'dynamic', '--target', 'BV:aaa', '--batch', 'B1']);
assert.equal(same.code, 0);
assert.ok(same.out.includes('同批次已占额度'), `同批 check 没提示去重：${same.out}`);
ok('同批第二条通道不重复占额度');

// 2) 同批号再 record 不应新增账本条目
const before = JSON.parse(fs.readFileSync(path.join(tmp, 'surfcore', 'bili', 'quota.json'), 'utf8')).log.length;
assert.equal(run(['record', '--share', '--type', 'comment', '--target', 'BV:aaa', '--batch', 'B1']).code, 0);
const after = JSON.parse(fs.readFileSync(path.join(tmp, 'surfcore', 'bili', 'quota.json'), 'utf8')).log.length;
assert.equal(after, before, '同批号重复记账了');
ok('同批号第二次 record 不记账');

// 3) 不同批号各自占额度；到上限后必须拒
assert.equal(run(['record', '--share', '--type', 'dm', '--target', 'BV:bbb', '--batch', 'B2']).code, 0);
assert.equal(run(['record', '--share', '--type', 'dm', '--target', 'BV:ccc', '--batch', 'B3']).code, 0);
ok('不同批号各占一次额度（共 3 条）');
const over = run(['check', '--share', '--type', 'dm', '--target', 'BV:ddd', '--batch', 'B4']);
assert.equal(over.code, 2, `额度用完仍放行：${over.out}`);
assert.ok(over.out.includes('分享额度已用完'), over.out);
ok('第 4 批被拒（额度 3/天上限生效）');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`test-quota-batch: ${n} 项通过`);
