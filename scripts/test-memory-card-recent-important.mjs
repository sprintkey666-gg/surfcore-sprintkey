// 「最近很要紧的」段回归测试（2026-11-03）
//
// 背景：主人 2026-11-02 上午和她约了暗号（问「在吗 鲸鲸」→ 答「赖着不走的鱼」），
// 记忆卡里也确实有这条（importance 74，tags owner/qq/initial）。但 2026-11-03 晚上
// 在悬浮窗里问，她答不上来 —— 因为 initial 段是「按 createdAt 升序取前 6 条」，
// 10-28 那批老记录把 11-02 的新约定挤掉了，注入块里根本没有「暗号」二字。
//
// 这个测试锁住三件事：
//   1. 最近的、够重要的记忆一定会被渲染进 QQ 注入块（不再被 initial 的 6 条挤掉）；
//   2. 老记录并没有被删掉（记忆不该因为修新问题就丢旧事）；
//   3. B站 注入块里绝对不带这类和主人的私事。

import assert from 'node:assert/strict';
import {
  createEmptyCard,
  renderMemoryCard,
  normalizeMemoryCardConfig,
  DEFAULT_MEMORY_CARD_CONFIG,
} from '../src/memory-card.js';

const NOW = Date.parse('2026-11-03T12:30:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function record(over = {}) {
  return {
    id: over.id || `mem_${Math.random().toString(16).slice(2, 10)}`,
    platform: 'qq',
    scope: 'qq',
    source: 'qq-owner',
    kind: 'private',
    title: '',
    text: '',
    botReply: '',
    tags: [],
    importance: 40,
    clarity: 'clear',
    pinned: false,
    firstMet: false,
    isInitial: false,
    sensitive: false,
    speaker: '',
    isSelf: false,
    media: [],
    screenSeen: false,
    lastSeenAt: new Date(NOW - DAY).toISOString(),
    createdAt: new Date(NOW - 3 * DAY).toISOString(),
    ...over,
  };
}

// 10-28 那批「最初的日子」老记录：都是 owner + initial，importance 偏低。
const olds = Array.from({ length: 9 }, (_, i) => record({
  id: `mem_old_${i}`,
  title: `和主人：${['第一次聊天', '他给我取名字', '一起看视频', '他说早安', '我学会了做饭', '一起听歌', '他夸我', '我犯错了', '讲了个笑话'][i]}`,
  text: `一些很早期的小事（第 ${i + 1} 件）。`,
  tags: ['owner', 'qq', 'initial'],
  importance: 55 + i,
  isInitial: true,
  createdAt: new Date(Date.parse('2026-10-28T02:00:00.000Z') + i * 3600_000).toISOString(),
  lastSeenAt: new Date(Date.parse('2026-10-28T02:00:00.000Z') + i * 3600_000).toISOString(),
}));

// 真正的暗号约定（复刻线上那条 mem_654c17336ab254 的形状）。
const secret = record({
  id: 'mem_654c17336ab254',
  title: '和主人：我们约定一个暗号，看看等会是不是你',
  text: '他说怕换了个壳子，问「在吗 鲸鲸」，我答「赖着不走的鱼」才算我自己。',
  botReply: '赖着不走的鱼。',
  tags: ['owner', 'qq', 'initial'],
  importance: 74,
  isInitial: true,
  initialTier: 'first10',
  createdAt: '2026-11-02T05:36:00.000Z',
  lastSeenAt: '2026-11-02T05:36:00.000Z',
});

const extra = [
  record({ id: 'mem_recent_1', title: '群里聊了猫', text: '乃愛发了猫的照片。', source: 'qq-group', importance: 30 }),
  record({ id: 'mem_pet_1', platform: 'pet', scope: 'pet', source: 'pet-owner', channel: 'orb', title: '桌宠 · 和主人：他问我要不要睡觉', text: '说要睡了。', tags: ['pet', 'owner'], importance: 80 }),
];

function makeCard() {
  const card = createEmptyCard(NOW);
  card.records = [...olds, secret, ...extra];
  return card;
}

const cfg = normalizeMemoryCardConfig({});

// ── 1. 暗号必须出现在 QQ 注入块里 ───────────────────────────────────────────
{
  const text = renderMemoryCard(makeCard(), { platform: 'qq', maxChars: cfg.injectMaxChars.qq, config: cfg, now: NOW });
  assert.ok(text.includes('赖着不走的鱼'), 'QQ 注入块里必须出现「赖着不走的鱼」');
  assert.ok(text.includes('最近很要紧的'), '应该有「最近很要紧的」段');
  assert.ok(text.length <= cfg.injectMaxChars.qq, `注入块不能超过 ${cfg.injectMaxChars.qq} 字，实际 ${text.length}`);
}

// ── 2. 老记录没被丢 ─────────────────────────────────────────────────────────
{
  const text = renderMemoryCard(makeCard(), { platform: 'qq', maxChars: cfg.injectMaxChars.qq, config: cfg, now: NOW });
  const oldHits = (text.match(/一些很早期的小事/g) || []).length;
  assert.ok(oldHits >= 1, `至少留一条老记录，实际 ${oldHits} 条`);
}

// ── 3. B站 注入块不带私事 ───────────────────────────────────────────────────
{
  const text = renderMemoryCard(makeCard(), { platform: 'bili', maxChars: cfg.injectMaxChars.bili, config: cfg, now: NOW });
  assert.ok(!text.includes('赖着不走的鱼'), 'B站 注入块里不能出现暗号');
  assert.ok(!text.includes('最近很要紧的'), 'B站 不应该有「最近很要紧的」段');
}

// ── 4. 关掉开关就完全不进这一段 ─────────────────────────────────────────────
{
  const off = normalizeMemoryCardConfig({ recentImportant: false });
  const card = createEmptyCard(NOW);
  card.records = [
    ...olds.map((item) => ({ ...item })),
    { ...secret },
  ];
  const text = renderMemoryCard(card, { platform: 'qq', maxChars: off.injectMaxChars.qq, config: off, now: NOW });
  assert.ok(!text.includes('最近很要紧的'), '关掉 recentImportant 后不该出现这一段');
}

// ── 5. 配置归一化：越界钳制 ─────────────────────────────────────────────────
{
  assert.equal(DEFAULT_MEMORY_CARD_CONFIG.recentImportant, true);
  assert.equal(normalizeMemoryCardConfig({}).recentImportantDays, 14);
  assert.equal(normalizeMemoryCardConfig({ recentImportantDays: 999 }).recentImportantDays, 90);
  assert.equal(normalizeMemoryCardConfig({ recentImportantDays: 0 }).recentImportantDays, 1);
  assert.equal(normalizeMemoryCardConfig({ recentImportantLimit: 0 }).recentImportantLimit, 1);
  assert.equal(normalizeMemoryCardConfig({ recentImportantLimit: 100 }).recentImportantLimit, 12);
  assert.equal(normalizeMemoryCardConfig({ recentImportantMinImportance: 10 }).recentImportantMinImportance, 30);
  assert.equal(normalizeMemoryCardConfig({ recentImportant: 'yes' }).recentImportant, true);
}

// ── 6. initial 段现在按重要度排（最新且最重要的不会排到最后） ────────────────
{
  const card = createEmptyCard(NOW);
  card.records = [
    record({ id: 'mem_i_low', title: '和主人：很早的一件小事', text: '很早的低重要度小事。', tags: ['owner', 'qq', 'initial'], importance: 40, isInitial: true, createdAt: '2026-10-20T00:00:00.000Z' }),
    record({ id: 'mem_i_high', title: '和主人：很重要的一件事', text: '后来的一件高重要度大事。', tags: ['owner', 'qq', 'initial'], importance: 90, isInitial: true, createdAt: '2026-10-22T00:00:00.000Z' }),
  ];
  const full = renderMemoryCard(card, { full: true, config: cfg, now: NOW });
  const highAt = full.indexOf('高重要度大事');
  const lowAt = full.indexOf('低重要度小事');
  assert.ok(highAt > 0 && lowAt > 0, '两条都应在完整卡里');
  assert.ok(highAt < lowAt, '重要度高的应该排在前面');
}

// ── 7. 超出时间窗的重要记忆不进这一段（避免无限往回捞） ──────────────────────
{
  const stale = record({
    id: 'mem_stale_important',
    title: '和主人：很久以前定下的老规矩',
    text: '老规矩内容。',
    tags: ['owner', 'qq'],
    importance: 95,
    createdAt: new Date(NOW - 40 * DAY).toISOString(),
  });
  const card = createEmptyCard(NOW);
  card.records = [stale];
  const text = renderMemoryCard(card, { platform: 'qq', maxChars: cfg.injectMaxChars.qq, config: cfg, now: NOW });
  assert.ok(!text.includes('最近很要紧的'), '40 天前的不该硬捞进「最近很要紧的」');
  assert.ok(text.includes('老规矩内容'), '老记录仍应该能从别的段里出现');
}

// ── 8. 同分时按「事情发生的时间」排，不按 lastSeenAt（真机上的真陷阱） ────────
//
// 线上卡里 74 分的一大批记录，因为被反复「想起」lastSeenAt 都被刷到了今天；
// 暗号那条一次都没被想起过，lastSeenAt 停在 11-02。按 lastSeenAt 排序时它永远垫底，
// 而它只有进了提示词才可能被想起 —— 死循环。所以这一段必须按 createdAt 排。
{
  const recalled = Array.from({ length: 6 }, (_, i) => record({
    id: `mem_recalled_${i}`,
    text: `今天又被想起的第 ${i + 1} 件旧事。`,
    tags: ['owner', 'qq'],
    importance: 74,
    createdAt: new Date(NOW - (20 - i) * DAY).toISOString(),
    lastSeenAt: new Date(NOW - 60_000).toISOString(), // 刚刚被想起
  }));
  const higher = Array.from({ length: 2 }, (_, i) => record({
    id: `mem_higher_${i}`,
    text: `更高的第 ${i + 1} 件。`,
    tags: ['owner', 'qq'],
    importance: 79,
    createdAt: new Date(NOW - (30 - i) * DAY).toISOString(),
    lastSeenAt: new Date(NOW - 60_000).toISOString(),
  }));
  const card = createEmptyCard(NOW);
  card.records = [...higher, ...recalled, { ...secret }];
  const text = renderMemoryCard(card, { platform: 'qq', maxChars: cfg.injectMaxChars.qq, config: cfg, now: NOW });
  assert.ok(text.includes('赖着不走的鱼'), '同分的一批记录里，按 createdAt 也必须把暗号带出来');
}

// ── 9. 默认条数够用（4 条装不下真机那张卡） ─────────────────────────────────
{
  assert.equal(normalizeMemoryCardConfig({}).recentImportantLimit, 6);
}

console.log('test-memory-card-recent-important: 全部通过');
