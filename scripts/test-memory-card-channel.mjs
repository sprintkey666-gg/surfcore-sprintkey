// 记忆卡「数据类型」回归：桌宠 / 悬浮窗 / 陪伴字幕 写进同一张卡，但要能分辨来源。
//
// 背景（2026-11-03）：主人要求字幕和会话的记忆也进记忆卡，而且要能看出这条是
// 在悬浮窗聊的、在字幕里说的、还是在桌宠上说的——所以 inbox 事件多带一个 channel，
// 摄取时落成标题前缀 + tag + record.channel 三处标记。
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOD = pathToFileURL(path.join(REPO_ROOT, 'src', 'memory-card.js')).href;
const {
  createEmptyCard, ingestInboxLines, normalizeMemoryCardConfig,
  normalizeDeskChannel, deskChannelLabel, DESK_CHANNELS,
} = await import(MOD);

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

// ── 工具 ────────────────────────────────────────────────────────────────
function ingest(events) {
  const card = createEmptyCard(Date.now());
  const cfg = normalizeMemoryCardConfig({ enabled: true });
  ingestInboxLines(card, events.map((e) => JSON.stringify(e)), cfg, Date.now());
  return card.records || [];
}

const event = (channel, text, extra = {}) => ({
  at: Date.now(),
  platform: 'pet',
  kind: 'private',
  sender: { id: 'owner', name: '主人' },
  isOwner: true,
  isSelf: false,
  private: true,
  direct: true,
  conversationKey: 'desktop',
  channel,
  text,
  ...extra,
});

// ── 1. channel 归一化 ───────────────────────────────────────────────────
ok(normalizeDeskChannel('desktop-orb') === 'orb', 'desktop-orb 归一成 orb');
ok(normalizeDeskChannel('companion') === 'companion', 'companion 原样');
ok(normalizeDeskChannel('subtitle') === 'companion', 'subtitle 也算字幕');
ok(normalizeDeskChannel('') === '', '空串不瞎猜');
ok(DESK_CHANNELS.includes('orb') && DESK_CHANNELS.includes('companion'), '类型清单含悬浮窗与字幕');
ok(deskChannelLabel('orb') === '悬浮窗' && deskChannelLabel('companion') === '字幕', '中文标签正确');

// ── 2. 三条链路各写一条，标题/标签/channel 各不相同 ──────────────────────
const orbRecords = ingest([event('desktop-orb', '悬浮窗里问：在吗')]);
ok(orbRecords.length === 1, '悬浮窗对话进了记忆卡');
ok(orbRecords[0].channel === 'orb', '记录带 channel=orb');
ok(/^悬浮窗 · /.test(orbRecords[0].title), `标题带来源前缀（实际：${orbRecords[0].title}）`);
ok(orbRecords[0].tags.includes('orb'), 'tag 带 orb');
ok(orbRecords[0].tags.includes('pet'), 'tag 保留 pet（表示桌面私聊）');

const subRecords = ingest([event('companion', '字幕里嘀咕：他好像在写代码')]);
ok(subRecords.length === 1, '字幕对话进了记忆卡');
ok(subRecords[0].channel === 'companion', '记录带 channel=companion');
ok(/^字幕 · /.test(subRecords[0].title), `字幕标题前缀正确（实际：${subRecords[0].title}）`);
ok(subRecords[0].tags.includes('companion'), 'tag 带 companion');

const petRecords = ingest([event('', '桌宠上说的话')]);
ok(petRecords.length === 1, '没带 channel 时仍进卡（向后兼容）');
ok(petRecords[0].channel === 'pet', '缺省回落到 pet');
ok(/^桌宠 · /.test(petRecords[0].title), '缺省标题仍是桌宠');

// ── 3. 她的主动搭话（isSelf）也走同一套前缀 ──────────────────────────────
const selfRecords = ingest([{
  at: Date.now(),
  platform: 'pet',
  kind: 'private',
  sender: { id: 'bot', name: '小鲸鱼' },
  isOwner: false,
  isSelf: true,
  private: true,
  direct: true,
  conversationKey: 'desktop',
  channel: 'companion',
  text: '主动说了句：早点睡',
  screenVision: false,
}]);
ok(selfRecords.length === 1, '主动搭话也能进卡');
ok(selfRecords[0].source === 'pet-self', '主动搭话 source=pet-self');
ok(/^字幕 · /.test(selfRecords[0].title), '主动搭话同样带字幕前缀');
ok(selfRecords[0].screenSeen === false, 'screenVision=false 落成 screenSeen=false');

if (failures) {
  console.error(`\n❌ ${failures} 项失败`);
  process.exit(1);
}
console.log('\n✓ 记忆卡数据类型检查通过');
