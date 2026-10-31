/**
 * 桥接状态映射回归：`dshReady` 必须原样透出。
 *
 * 背景（真发生过）：`status()` 从 `/api/status` 里挑了 root/dshBaseUrl/mode/… 却漏了
 * `dshReady`，而启动完成弹窗的判据是 `bridge.dshReady === true`，于是判据恒为
 * undefined —— 弹窗永远等满 180 秒，再误报「DSH 已打开，但桥接还在鉴权/等待连接」。
 * 这种「字段漏传」不会报错、不会崩，只会在用户面前显示错误结论，必须有断言钉住。
 */
import assert from 'node:assert/strict';
import { callBridge, mapStatusPayload } from '../lib/bridge.js';

// 1) 桥接已就绪：dshReady 必须透出，且字段形状与设置页/弹窗约定一致。
const ready = mapStatusPayload(
  {
    dshReady: true,
    dshBaseUrl: 'http://127.0.0.1:42212',
    mode: 'reserved2',
    root: 'D:\\deepseekwork\\surfcore',
    snowluma: { connected: true, accountOnline: true, good: true },
    activity: '第一行\n第二行',
  },
  { port: 3100, pid: 123 },
);
assert.equal(ready.dshReady, true, 'dshReady 必须原样透出（漏传就是 180 秒误报）');
assert.equal(ready.ok, true);
assert.equal(ready.running, true);
assert.equal(ready.port, 3100);
assert.equal(ready.pid, 123);
assert.equal(ready.dshBaseUrl, 'http://127.0.0.1:42212');
assert.equal(ready.mode, 'reserved2');
assert.equal(ready.snowluma.connected, true);
assert.equal(ready.activityTail, '第一行\n第二行');

// 2) 启动弹窗的判据（lib/index.js allReady 的同一份逻辑）必须能通过。
const allReady = (bridge, schedulerRunning) => Boolean(
  bridge?.running
  && bridge?.ok !== false
  && bridge?.dshReady === true
  && schedulerRunning
  && bridge?.snowluma?.connected === true
  && bridge?.snowluma?.accountOnline === true,
);
assert.equal(allReady(ready, true), true, '已就绪的桥接必须能通过启动检查');
assert.equal(allReady(ready, false), false, 'B站生物钟没起来不算就绪');
assert.equal(allReady(mapStatusPayload({ dshReady: false }), true), false);

// 3) 只有布尔 true 才算就绪：字符串/数字不能蒙混过关。
assert.equal(mapStatusPayload({ dshReady: 'true' }).dshReady, false);
assert.equal(mapStatusPayload({ dshReady: 1 }).dshReady, false);

// 4) 空响应/缺字段时的兜底形状（不能抛，也不能把 undefined 漏出去）。
const empty = mapStatusPayload();
assert.equal(empty.dshReady, false);
assert.equal(empty.dshBaseUrl, null);
assert.equal(empty.mode, null);
assert.equal(empty.snowluma, null);
assert.equal(empty.root, null);
assert.equal(empty.activityTail, '');

// 4b) 对话收尾汇总必须原样透出：设置页卡片读 bridge.closure。
// 漏传不会报错，只会让卡片永远显示「还没有收过尾」——和 dshReady 同一类字段漏传事故。
const withClosure = mapStatusPayload({
  dshReady: true,
  closure: { enabled: true, active: { key: 'private:123', summary: '聊到扯平' }, recentlyClosed: [] },
});
assert.equal(withClosure.closure?.enabled, true);
assert.equal(withClosure.closure?.active?.key, 'private:123');
assert.equal(mapStatusPayload({}).closure, null);

// 5) 写操作必须带 application/json：桥接没收到这个头会直接 415，
//    而调用方只看到「请求必须是 application/json」——「立即分享一次」曾因此静默失败。
{
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  };
  const post = await callBridge('/api/bili/share-now', { method: 'POST' });
  assert.equal(post.ok, true);
  assert.match(String(seen.init.headers['content-type']), /application\/json/, 'POST 必须带 JSON content-type');
  assert.equal(seen.init.body, '{}', '无参数的 POST 也要发空对象，桥接才不会 415');
  await callBridge('/api/status');
  assert.equal(seen.init.body, undefined, 'GET 不应该带 body');
  assert.equal(seen.init.headers['content-type'], undefined, 'GET 不需要 content-type');
  globalThis.fetch = realFetch;
}

console.log('bridge-status tests OK');
