// 自动发图的接线契约：走真实 bridge.js（VM 夹具网关），证明
// 「决策 → 真的把图发出去 → 记账」这条链路在代码层是通的 —— 而不是只有纯函数对。
//
// 为什么必须单独钉一遍：决策层单测全绿、设置页也能开关，但桥接那一段如果没接上
// （忘了调用、或者 wait 没 await、或者记账写在分支外面），现象是「设置页开了但永远不发」，
// 靠肉眼试聊天很难区分是「没触发」还是「触发了没接上」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bridgeHarness } from './audit-bridge-harness.mjs';

const dirs = fs.mkdtempSync(path.join(os.tmpdir(), 'pic-wiring-'));
const cute = path.join(dirs, 'cute');
fs.mkdirSync(cute, { recursive: true });
// 1x1 PNG：只要能被 looksLikeImageBuffer 认出来即可，网关那边不会真的解码。
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gAB'
  + '/uCltgAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(cute, 'laugh.png'), png);

const h = await bridgeHarness({
  config: {
    allow: { groups: ['456'], private: ['123'] },
    socialV2: {
      mode: 'reserved2',
      pic: {
        enabled: true,
        maxPerTurn: 1,
        minGapMs: 0,
        maxPerHour: 6,
        quietFrom: '01:00',
        quietTo: '07:00',
        // 表情库在夹具里不可靠（收藏接口是假的），这里只验本地图库那一路。
        sources: {
          sticker: { enabled: false, weight: 60, minScore: 0.7, annotatedOnly: true },
          local: { enabled: true, weight: 100, dirs: [dirs], emotionSubdir: true, warmth: 0, keywords: [] },
          generate: { enabled: false, weight: 15 }
        }
      },
      tools: { sendPic: true }
    }
  },
  globals: {
    // 本地图库那一路要看真实图片字节，夹具的 fs 就是宿主的 fs，不用桩。
  }
});

try {
  const key = 'private:123';
  // ① 正常一眼：应发图并记账
  const rec = await h.maybeAutoPicV2(key, { selfText: '哈哈你好可爱呀' });
  assert.ok(rec, '应该发了图（返回记账记录）');
  assert.equal(rec.source, 'local', '来源应该是本地图库');
  assert.match(String(rec.id), /laugh\.png$/, '发的应该是刚才放进去的那张');

  const sent = h.calls.http.filter((c) => String(c.url).endsWith('send_private_msg'));
  assert.ok(sent.length >= 1, '应该调用 send_private_msg');
  const seg = sent[sent.length - 1].body.message[0];
  assert.ok(seg, '消息段不能为空');
  assert.equal(seg.type, 'image', `图必须以 image 段发出去（实际 ${seg?.type}）`);
  assert.equal(sent[sent.length - 1].body.user_id, 123, '私聊目标要对');

  const log = h.picLogList();
  assert.equal(log.length, 1, '记账应该有一条');
  assert.equal(log[0].source, 'local');

  const rt = h.picRuntimeFor(key);
  assert.equal(rt.perTurnSent, 1, '本轮计数 +1');

  // ② 正当话题：不发、也不记账
  const before = log.length;
  const none = await h.maybeAutoPicV2(key, { selfText: '帮我把这段报错改一下' });
  assert.equal(none, null, '正事话题不该发图');
  assert.equal(h.picLogList().length, before, '不该记账');

  // ③ 每轮上限：同一轮再来一次也不发
  const again = await h.maybeAutoPicV2(key, { selfText: '哈哈哈好可爱' });
  assert.equal(again, null, '本轮已经发过，不该再发');

  // ④ 暂停后不发
  h.picRuntimeFor(key).pausedUntil = Date.now() + 60_000;
  const paused = await h.maybeAutoPicV2(key, { selfText: '哈哈哈好可爱' });
  assert.equal(paused, null, '暂停期间不该发图');

  console.log('test-pic-wiring: ok');
} finally {
  await h.close();
}

// 第二个夹具：只有生图这一路可用时，应该算好 prompt 排队，而不是干脆不发。
const h2 = await bridgeHarness({
  config: {
    allow: { groups: ['456'], private: ['123'] },
    socialV2: {
      mode: 'reserved2',
      pic: {
        enabled: true, maxPerTurn: 1, minGapMs: 0, maxPerHour: 6,
        quietFrom: '01:00', quietTo: '07:00',
        sources: {
          sticker: { enabled: false, weight: 60, minScore: 0.7, annotatedOnly: true },
          local: { enabled: false, weight: 25, dirs: [], emotionSubdir: true, warmth: 0.5, keywords: [] },
          generate: { enabled: true, weight: 15, warmth: 0.6, style: 'auto', maxPerDay: 2 }
        }
      },
      tools: { sendPic: true }
    }
  }
});
try {
  const key = 'private:123';
  const queued = await h2.maybeAutoPicV2(key, { selfText: '哈哈今天真开心呀' });
  assert.ok(queued, '应该返回排队记录');
  assert.equal(queued.source, 'generate-queued', '来源标记为排队生图');
  const st = h2.getSocialV2State(key);
  assert.ok(st.pendingPicGenerate && st.pendingPicGenerate.prompt, 'pending 里要有 prompt');
  assert.ok(String(st.pendingPicGenerate.prompt).length > 10, 'prompt 不能是空壳');
  assert.equal(h2.picLogList().filter((e) => e.source === 'generate-queued').length, 1, '排队也要记账，设置页才看得到');
  // 第二次同一轮不该重复排队（30 分钟防抖）。
  const again = await h2.maybeAutoPicV2(key, { selfText: '哈哈哈好可爱' });
  assert.equal(again, null, '防抖期间不该再排队');
  console.log('test-pic-wiring: generate fallback ok');
} finally {
  await h2.close();
}

// 第三个夹具：图文同条（文字和图片进同一条消息）
const h3 = await bridgeHarness({
  config: {
    allow: { groups: ['456'], private: ['123'] },
    socialV2: {
      mode: 'reserved2',
      pic: {
        enabled: true,
        combineText: true,
        maxPerTurn: 1,
        minGapMs: 0,
        maxPerHour: 6,
        quietFrom: '01:00',
        quietTo: '07:00',
        sources: {
          sticker: { enabled: false, weight: 60, minScore: 0.7, annotatedOnly: true },
          local: { enabled: true, weight: 100, dirs: [dirs], emotionSubdir: true, warmth: 0, keywords: [] },
          generate: { enabled: false, weight: 15 }
        }
      },
      tools: { sendPic: true }
    }
  }
});
try {
  const key = 'private:123';
  const countSends = () => h3.calls.http.filter((c) => String(c.url).endsWith('send_private_msg')).length;
  const before = countSends();
  await h3.sendMessagesV2(key, ['哈哈你好可爱呀'], []);
  assert.equal(countSends(), before + 1, '图文同条应该只发一条消息（不是文字一条 + 图一条）');
  const msg = h3.calls.http.filter((c) => String(c.url).endsWith('send_private_msg')).at(-1).body.message;
  assert.equal(msg.length, 2, `一条消息里应该正好有文字和图片两段（实际 ${JSON.stringify(msg.map((s) => s.type))}）`);
  assert.equal(msg[0].type, 'text', '第一段是文字');
  assert.match(String(msg[0].data?.text ?? ''), /可爱/, '文字内容要原样带上');
  assert.equal(msg[1].type, 'image', '第二段是图片');
  assert.ok(String(msg[1].data?.file ?? '').startsWith('base64://'), '本地图以 base64 段发出');
  const combined = h3.picLogList().at(-1);
  assert.equal(combined?.combined, true, '记账要标成图文同条');
  assert.equal(h3.picRuntimeFor(key).perTurnSent, 1, '本轮计数 +1');

  // 关掉开关以后必须回到「先文字、再单独一条图」
  const off = await bridgeHarness({
    config: {
      allow: { groups: ['456'], private: ['123'] },
      socialV2: {
        mode: 'reserved2',
        pic: {
          enabled: true, combineText: false, maxPerTurn: 1, minGapMs: 0,
          quietFrom: '01:00', quietTo: '07:00',
          sources: {
            sticker: { enabled: false },
            local: { enabled: true, weight: 100, dirs: [dirs], emotionSubdir: true, warmth: 0, keywords: [] },
            generate: { enabled: false }
          }
        },
        tools: { sendPic: true }
      }
    }
  });
  try {
    const n0 = off.calls.http.filter((c) => String(c.url).endsWith('send_private_msg')).length;
    await off.sendMessagesV2('private:123', ['哈哈你好可爱呀'], []);
    await new Promise((r) => setTimeout(r, 300));
    const n1 = off.calls.http.filter((c) => String(c.url).endsWith('send_private_msg')).length;
    const first = off.calls.http.filter((c) => String(c.url).endsWith('send_private_msg'))[n0];
    assert.equal(first.body.message.length, 1, '关掉合并后文字消息里只有文字');
    assert.equal(first.body.message[0].type, 'text');
    assert.ok(n1 >= n0 + 1, '文字仍然发出去');
  } finally {
    await off.close();
  }
  console.log('test-pic-wiring: combine text ok');
} finally {
  await h3.close();
}

// 第四个夹具：纯表情必须走 QQ 原生 send_custom_face，不能再下载成普通大图
const h4 = await bridgeHarness({
  config: {
    allow: { groups: ['456'], private: ['123'] },
    socialV2: {
      mode: 'reserved2',
      pic: { enabled: true, combineText: true, maxPerTurn: 1, minGapMs: 0, quietFrom: '01:00', quietTo: '07:00' },
      tools: { sendPic: true }
    }
  }
});
try {
  await h4.sendStickerV2('private:123', 'fixture-sticker', {});
  const native = h4.calls.http.filter((c) => String(c.url).endsWith('send_custom_face'));
  assert.equal(native.length, 1, '纯表情应该调 send_custom_face');
  assert.equal(native[0].body.emoji_id, 'fixture-sticker', '带上 emoji_id');
  assert.equal(native[0].body.user_id, 123, '私聊带 user_id');
  assert.equal(h4.calls.http.filter((c) => String(c.url).endsWith('send_private_msg')).length, 0,
    '原生表情发送不该再走 send_private_msg 的图片段');
  console.log('test-pic-wiring: native sticker ok');
} finally {
  await h4.close();
  fs.rmSync(dirs, { recursive: true, force: true });
}


