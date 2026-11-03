// 悬浮窗/桌宠/字幕 与 QQ、B站 的记忆互通——纯函数回归（离线，不写盘）。
//
// 背景（2026-11-03）：主人要求「悬浮窗会话、陪伴字幕和 QQ 聊天要是同一个她」，
// 记忆、人设、最近说过的话都要通。互通逻辑抽在 plugins/surfcore/lib/interop.js，
// 这里钉住四件事：
//   1. normalizeInterop 的钳制与默认值（老配置没这些字段时不能让 limits 变成 0）；
//   2. clampText 优先在换行处断，且不会超长；
//   3. formatRecentLines 只收窗口内的记录、按「来源 + 谁 + 内容」成行、单条截断；
//   4. buildInteropMemory 的拼接顺序（身份 → 最近 → QQ 卡 → B站卡）与总长上限。
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOD = pathToFileURL(path.join(REPO_ROOT, 'plugins', 'surfcore', 'lib', 'interop.js')).href;
const {
  INTEROP_DEFAULTS, normalizeInterop, clampText, formatRecentLines, buildInteropMemory,
} = await import(MOD);

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

// ── 1. normalizeInterop ──────────────────────────────────────────────────
const d = normalizeInterop(null);
ok(d.qq === true && d.bili === true, '默认互通 QQ / B站 都开');
ok(d.personaMaxChars === INTEROP_DEFAULTS.personaMaxChars, '默认人设上限跟常量一致');
ok(d.memoryMaxChars === INTEROP_DEFAULTS.memoryMaxChars, '默认记忆上限跟常量一致');
ok(normalizeInterop({ qq: false }).qq === false, '关掉互通 QQ 生效');
ok(normalizeInterop({ recentLines: 999 }).recentLines === 40, '最近对话行数上限钳到 40');
ok(normalizeInterop({ recentLines: 1 }).recentLines === 4, '最近对话行数下限钳到 4');
ok(normalizeInterop({ personaMaxChars: 1 }).personaMaxChars === 4000, '人设上限下限 4000');
ok(normalizeInterop({ memoryMaxChars: 999999 }).memoryMaxChars === 20000, '记忆上限上限 20000');
ok(normalizeInterop({ recentHours: 0 }).recentHours === 1, '时间窗下限 1 小时');

// ── 2. clampText ─────────────────────────────────────────────────────────
const long = ['第一行', '第二行', '第三行', '第四行'].join('\n');
const clipped = clampText(long, 12);
ok(clipped.length <= 12 + 8, 'clampText 结果不超长（留尾部标注余量）');
ok(clampedEndsWithTail(clipped), 'clampText 带省略标注');
ok(clampText('短', 100) === '短', '不超长时原样返回');
ok(clampText('', 10) === '', '空串原样');
function clampedEndsWithTail(s) { return /…/.test(s); }

// ── 3. formatRecentLines ─────────────────────────────────────────────────
const nowMs = Date.now();
const records = [
  { at: nowMs - 60_000, channel: 'qq', channelLabel: 'QQ', role: 'user', name: '主人', text: '今天好累' },
  { at: nowMs - 30_000, channel: 'desktop-orb', channelLabel: '悬浮窗', role: 'assistant', name: '小鲸鱼', text: '那我陪你歇会儿' },
  { at: nowMs - 2 * 3600_000, channel: 'companion', channelLabel: '陪伴字幕', role: 'assistant', name: '小鲸鱼', text: '这句超出时间窗，不该出现' },
  { at: nowMs - 10_000, channel: 'qq', channelLabel: 'QQ', role: 'assistant', name: '小鲸鱼', text: 'x'.repeat(400) },
];
const joined = formatRecentLines(records, { limit: 12, nowMs, hours: 1 });
ok(!joined.includes('超出时间窗'), '时间窗外的记录被丢掉');
ok(joined.includes('QQ') && joined.includes('悬浮窗'), '来源标签带出来了');
ok(joined.includes('主人：今天好累'), '角色名 + 内容成行');
ok(joined.split('\n').every((l) => l.length <= 200), '超长内容被截断');
ok(formatRecentLines([], { nowMs }) === '', '空记录返回空串');
ok(formatRecentLines(records, { limit: 1, nowMs, hours: 1 }).split('\n').length === 1, 'limit 生效');

// ── 4. buildInteropMemory ────────────────────────────────────────────────
const built = buildInteropMemory({
  qqPrompt: '【QQ 记忆】我爱喝奶茶',
  biliPrompt: '【B站 记忆】我在写代码',
  recentText: '- [QQ] 主人：今天好累',
  identityText: '她叫小鲸鱼',
  config: normalizeInterop(null),
});
ok(built.indexOf('小鲸鱼') < built.indexOf('今天好累'), '身份块排在最前');
ok(built.indexOf('今天好累') < built.indexOf('奶茶'), '最近对话在记忆卡之前');
ok(built.indexOf('奶茶') < built.indexOf('写代码'), 'QQ 卡在 B站 卡之前');
ok(built.length <= normalizeInterop(null).memoryMaxChars + 32, '总长不超过 memoryMaxChars');

const onlyQq = buildInteropMemory({
  qqPrompt: 'QQ段', biliPrompt: 'B站段', recentText: '', identityText: '',
  config: normalizeInterop({ bili: false }),
});
ok(!onlyQq.includes('B站段'), '关掉互通 B站就不注入 B站卡');

if (failures) {
  console.error(`\n❌ ${failures} 项失败`);
  process.exit(1);
}
console.log('\n✓ 互通记忆纯函数检查通过');
