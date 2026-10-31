/**
 * 收件箱 id 精度回归（2026-10-22 P0）：
 *   · 19 位新版动态 id 超过 JS 安全整数，`JSON.parse` 会丢末几位；
 *   · 必须优先从 `uri` 取精确字符串，`subject_id` 只在安全范围内使用；
 *   · `resolveLatestReply` 必须把 business 17 当动态（type=17），不能当视频（type=1）。
 *
 * 运行：node scripts/test-msgfeed-oid.mjs
 */
import assert from 'node:assert/strict';
import { idFromUri, pullFeed, resolveLatestReply } from '../tools/lib/msgfeed.mjs';

const realFetch = globalThis.fetch;

// ① 19 位动态：subject_id 已经丢精度，uri 是精确的
{
  const body = '{"code":0,"data":{"last_view_at":0,"cursor":"","items":[{"id":1,"reply_time":1792658122,"user":{"nickname":"鱼","mid":"3546938804799926"},"item":{"business_id":17,"subject_id":1261813571425140745,"root_id":0,"source_id":321492967824,"uri":"https://t.bilibili.com/1261813571425140745#reply321492967824","title":"","source_content":"喜欢小鲸鱼捏","target_reply_content":""}}]}}';
  const payload = JSON.parse(body); // 模拟真实 JSON.parse：subject_id 已变成 ...700
  globalThis.fetch = async () => ({ json: async () => payload });
  const feed = await pullFeed('reply', { headers: {}, pages: 1 });
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].oid, '1261813571425140745', '必须从 uri 取 19 位精确 oid');
  assert.equal(feed.items[0].business, 17);
  assert.equal(feed.items[0].parent, '321492967824');
}

// ② 视频：subject_id 是 aid，在安全范围内，照常使用
{
  const payload = { code: 0, data: { last_view_at: 0, cursor: '', items: [{ id: 2, reply_time: 1, user: { nickname: 'a', mid: '1' }, item: { business_id: 1, subject_id: 117468513176610, root_id: 1, source_id: 2, uri: 'https://www.bilibili.com/video/BV1JaJo6jEqH/', title: 't' } }] } };
  globalThis.fetch = async () => ({ json: async () => payload });
  const feed = await pullFeed('reply', { headers: {}, pages: 1 });
  assert.equal(feed.items[0].oid, '117468513176610');
}

// ③ 不安全且没有 uri → 宁可空着，也不能把截断后的 id 当 oid
{
  const payload = { code: 0, data: { last_view_at: 0, cursor: '', items: [{ id: 3, reply_time: 1, user: { nickname: 'a', mid: '1' }, item: { business_id: 17, subject_id: 1261813571425140745, uri: '' } }] } };
  globalThis.fetch = async () => ({ json: async () => payload });
  const feed = await pullFeed('reply', { headers: {}, pages: 1 });
  assert.equal(feed.items[0].oid, '', '不安全 id 且没有 uri 时必须留空（fail-closed）');
}

// ④ business=17 的楼层回读必须用 type=17
{
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { json: async () => ({ code: 0, data: { replies: [] } }) };
  };
  const out = await resolveLatestReply({
    business: 17,
    oid: '1261813571425140745',
    root: '321492967824',
    mid: '123',
    parentRpid: '321492967824',
    headers: {},
  });
  assert.equal(out, null);
  assert.ok(calls[0].includes('type=17'), `business=17 必须用 type=17，实际：${calls[0]}`);
  assert.ok(calls[0].includes('oid=1261813571425140745'));
}

// ⑤ uri 解析的老格式（旧动态 / opus）
assert.equal(idFromUri('https://t.bilibili.com/412794232#reply1'), '412794232');
assert.equal(idFromUri('https://www.bilibili.com/opus/1261813571425140745'), '1261813571425140745');
assert.equal(idFromUri('https://www.bilibili.com/video/BV1xx411c7mD/'), '');

globalThis.fetch = realFetch;
console.log('msgfeed oid tests OK');
