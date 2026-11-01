// 自动发图的决策层（纯逻辑，不发 QQ、不调模型、不连 DSH）。
//
// 背景（2026-10-31，主人要求「按聊天情景自动发图」）：三路来源里两路（QQ 表情、本地图库）
// 由桥接自己发，第三路（现场生图）只能由 agent 调 generate_image —— 判断「该不该发、
// 发哪一路」全在 src/pic-auto.js 里。这段逻辑的判断一旦错，表现为两种很难查的问题：
//   · 太激进：正在聊报错/生病/转账，还甩一张表情包；
//   · 太保守：永远不发，设置页看起来"开了但没效果"。
// 所以这里把每个闸门单独钉住，不靠端到端试出来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = path.join(REPO_ROOT, 'src', 'pic-auto.js');
const mod = await import(pathToFileURL(SOURCE).href);
const {
  defaultPicConfig, normalizePicConfig, inQuietHours, looksSerious, sceneAllows,
  pickWeighted, decidePicSource, pickStickerFor, listLocalImages, pickLocalImage,
  buildImagePrompt, buildPicPromptLine, IMAGE_EXTS,
  picFallbackChain, pickStickerLoose,
} = mod;

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✓ ${label}`);
  else { failures += 1; console.error(`✗ ${label}`); }
};

console.log('## 1. 默认值：只开 QQ 表情，本地图库与生图默认关');
{
  const c = defaultPicConfig();
  ok(c.enabled === true, 'enabled 默认 true');
  ok(c.sources.sticker.enabled === true, '表情默认开');
  ok(c.sources.local.enabled === false, '本地图库默认关（没配目录时不该乱发）');
  ok(c.sources.generate.enabled === false, '生图默认关（要配 provider，且慢）');
  ok(c.sources.sticker.weight === 60 && c.sources.local.weight === 25 && c.sources.generate.weight === 15, '三路权重 60/25/15');
  ok(c.maxPerTurn === 1, '每轮最多 1 张');
  ok(c.minGapMs === 120000, '最小间隔 2 分钟');
  ok(c.scopes.private === true && c.scopes.group === true, '私聊群聊都开');
  const scenes = Object.keys(c.scenes);
  ok(scenes.length === 19, `情绪场景 19 个（实际 ${scenes.length}）`);
  ok(c.scenes.happy === true && c.scenes.cute === true, '开心/卖萌 默认触发');
  ok(c.scenes.angry === false && c.scenes.sad === false && c.scenes.wronged === false, '生气/难过/委屈 默认不触发');
  ok(c.seriousGuard === true, '正事话题闸默认开');
}

console.log('## 2. normalizePicConfig：脏配置不许把行为放大');
{
  ok(JSON.stringify(normalizePicConfig(null)) === JSON.stringify(normalizePicConfig({})), 'null 与 {} 等价');
  const a = normalizePicConfig({ enabled: false });
  ok(a.enabled === false && a.sources.sticker.enabled === true, '部分覆盖保留其余默认');
  const b = normalizePicConfig({ maxPerTurn: 99, maxPerHour: -3, minGapMs: -1 });
  ok(b.maxPerTurn <= 5, `maxPerTurn 收敛（${b.maxPerTurn}）`);
  ok(b.maxPerHour >= 0, `maxPerHour 不为负（${b.maxPerHour}）`);
  ok(b.minGapMs >= 0, `minGapMs 不为负（${b.minGapMs}）`);
  const w = normalizePicConfig({ sources: { sticker: { weight: 900 }, local: { warmth: 7 }, generate: { weight: -5, maxPerDay: 9999 } } });
  ok(w.sources.sticker.weight <= 100, `权重上限 100（${w.sources.sticker.weight}）`);
  ok(w.sources.local.warmth <= 1, `温度上限 1（${w.sources.local.warmth}）`);
  ok(w.sources.generate.weight >= 0, '权重不为负');
  ok(w.sources.generate.maxPerDay <= 200, `每日生图上限收敛（${w.sources.generate.maxPerDay}）`);
  const q = normalizePicConfig({ quietFrom: '9:5', quietTo: '25:00' });
  ok(/^\d{2}:\d{2}$/.test(q.quietFrom), `quietFrom 规整成 HH:MM（${q.quietFrom}）`);
  ok(q.quietTo === '07:00', `非法 quietTo 回落默认（${q.quietTo}）`);
  const dirs = normalizePicConfig({ sources: { local: { dirs: ['  ', 'E:\\a', 'E:\\a'] } } });
  ok(dirs.sources.local.dirs.length === 1 && dirs.sources.local.dirs[0] === 'E:\\a', '目录去空去重');
}

console.log('## 3. 安静时段（含跨零点）');
{
  const at = (h, m = 0) => new Date(2026, 9, 31, h, m, 0).getTime();
  ok(inQuietHours(at(2), '01:00', '07:00') === true, '02:00 落在 01:00→07:00');
  ok(inQuietHours(at(12), '01:00', '07:00') === false, '12:00 不在其中');
  ok(inQuietHours(at(23, 30), '22:00', '06:00') === true, '跨零点 23:30 命中');
  ok(inQuietHours(at(3), '22:00', '06:00') === true, '跨零点 03:00 命中');
  ok(inQuietHours(at(12), '22:00', '06:00') === false, '跨零点 12:00 不命中');
  ok(inQuietHours(at(5), '00:00', '00:00') === false, 'from==to 视为关闭');
  ok(inQuietHours(at(7), '01:00', '07:00') === false, '右端点不含');
}

console.log('## 4. 正事话题闸：这些时候不许甩图');
{
  const serious = [
    '这个报错怎么解决', '帮我看看这段代码', '转我 200 块钱', '我的身份证号是',
    '头疼得厉害要不要吃药', '帮我把作业写了', '帮我查一下航班', '很急，马上回我',
    '在吗，认真问你个事',
  ];
  const casual = ['哈哈哈你好可爱', '今天好累啊', '晚上吃啥', '早安', '嘿嘿'];
  ok(serious.every((t) => looksSerious(t) === true), '严肃句全部识别');
  ok(casual.every((t) => looksSerious(t) === false), '闲聊句不会误判');
  const c = defaultPicConfig();
  ok(decidePicSource(c, { text: '这个报错怎么解决', emotions: ['happy'], now: Date.now() }) === null, 'seriousGuard 生效 → 不发');
  const off = { ...c, seriousGuard: false, sources: { ...c.sources } };
  ok(decidePicSource(off, { text: '这个报错怎么解决', emotions: ['happy'], now: Date.now(), rand: 0.99 }) !== null, '关掉闸门后才会发');
}

console.log('## 5. 情绪闸');
{
  const c = defaultPicConfig();
  ok(sceneAllows(c, ['angry']) === false, '生气默认不发');
  ok(sceneAllows(c, ['happy']) === true, '开心默认发');
  ok(sceneAllows(c, []) === true, '看不出情绪时按「平淡」走（neutral 默认开）');
  ok(sceneAllows({ ...c, scenes: { ...c.scenes, neutral: false } }, []) === false, '关掉 neutral 后，看不出情绪就不发');
  ok(sceneAllows({ ...c, scenes: { ...c.scenes, neutral: false } }, ['neutral']) === false, 'neutral 关掉后不发');
  ok(sceneAllows(c, ['happy', 'angry']) === true, '多情绪里有一个允许就放行');
}

console.log('## 6. 权重挑选可复现');
{
  const src = {
    sticker: { enabled: true, weight: 60 },
    local: { enabled: true, weight: 25 },
    generate: { enabled: true, weight: 15 },
  };
  ok(pickWeighted(src, 0).source === 'sticker', 'rand=0 落在第一段');
  ok(pickWeighted(src, 0.7).source === 'local', 'rand=0.7 落在第二段');
  ok(pickWeighted(src, 0.99).source === 'generate', 'rand=0.99 落在第三段');
  ok(pickWeighted({ x: { enabled: true, weight: 0 } }, 0) === null, '全 0 权重 → null');
  ok(pickWeighted({ x: { enabled: false, weight: 50 } }, 0) === null, '只有关闭的来源 → null');
  const c = defaultPicConfig();
  const picked = new Set();
  for (let i = 0; i < 200; i += 1) picked.add(decidePicSource(c, {
    text: '哈哈好可爱', emotions: ['cute'], now: Date.now(), rand: i / 200,
  })?.source);
  ok(picked.has('sticker'), '200 次里表情被挑中');
  ok(!picked.has('local'), '本地图库默认关，一次都不该出现');
}

console.log('## 7. 节奏闸（时长/上限/本轮）');
{
  const c = defaultPicConfig();
  const base = { text: '哈哈好可爱', emotions: ['cute'], kind: 'private', chatId: '123456789' };
  const now = new Date(2026, 9, 31, 15, 0, 0).getTime();
  ok(decidePicSource({ ...c, enabled: false }, { ...base, now }) === null, '总开关关闭 → 不发');
  ok(decidePicSource(c, { ...base, now: new Date(2026, 9, 31, 3, 0, 0).getTime() }) === null, '安静时段 → 不发');
  ok(decidePicSource(c, { ...base, now, lastAt: now - 10000 }) === null, '间隔不足 → 不发');
  ok(decidePicSource(c, { ...base, now, lastAt: now - 300000, perTurnSent: 1 }) === null, '本轮已发满 → 不发');
  ok(decidePicSource(c, { ...base, now, lastAt: now - 300000, hourCount: 6 }) === null, '每小时上限 → 不发');
  ok(decidePicSource(c, { ...base, now, lastAt: now - 300000 }) !== null, '都满足 → 会发');
  ok(decidePicSource({ ...c, scopes: { ...c.scopes, private: false } }, { ...base, now, lastAt: 0 }) === null, '私聊关了 → 私聊不发');
  ok(decidePicSource({ ...c, scopes: { ...c.scopes, groupDeny: ['1106703160'] } }, { ...base, kind: 'group', chatId: '1106703160', now }) === null, '黑名单群不发');
  ok(decidePicSource({ ...c, scopes: { ...c.scopes, groupAllow: ['1106703160'] } }, { ...base, kind: 'group', chatId: '999', now }) === null, '白名单外不发');
  const onlyGen = { ...c, sources: { sticker: { ...c.sources.sticker, enabled: false }, local: c.sources.local, generate: c.sources.generate } };
  ok(decidePicSource(onlyGen, { ...base, now, lastAt: 0, available: { sticker: false, local: false, generate: false } }) === null, '三路都不可用 → null');
}

console.log('## 8. 表情挑选：只发有情绪标注的');
{
  const entries = [
    { no: 1, id: 'a', emotion: 'cute', emotionLabel: '卖萌', content: '小猫比心', desc: '', score: 0.9 },
    { no: 2, id: 'b', emotion: 'neutral', emotionLabel: '平淡', content: '不明所以', desc: '', score: 0.95 },
    { no: 3, id: 'c', emotion: 'happy', emotionLabel: '开心', content: '笑', desc: '', score: 0.4 },
  ];
  const picked = pickStickerFor(entries, '哈哈好可爱', { annotatedOnly: true, minScore: 0.5 });
  ok(picked && picked.id === 'a', `跳过 neutral、卡 minScore（拿到 ${picked?.id}）`);
  const loose = pickStickerFor(entries, '哈哈好可爱', { annotatedOnly: false, minScore: 0.5 });
  ok(loose !== null, '关掉标注过滤后仍有候选');
  ok(pickStickerFor(entries, '哈哈好可爱', { annotatedOnly: true, minScore: 0.99 }) === null, '门槛过高 → null');
}

console.log('## 9. 本地图库：扫盘与挑选');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pic-auto-'));
  try {
    const dirs = { happy: path.join(root, 'happy'), sad: path.join(root, 'sad') };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(dirs.happy, '笑一个.jpg'), 'x');
    fs.writeFileSync(path.join(dirs.happy, '小猫.png'), 'x');
    fs.writeFileSync(path.join(dirs.sad, '哭.webp'), 'x');
    fs.writeFileSync(path.join(dirs.happy, '说明.txt'), 'x');
    const all = listLocalImages([root]);
    ok(all.length === 3, `只收图片扩展名（实际 ${all.length}）`);
    ok(all.every((p) => IMAGE_EXTS.has(path.extname(p).toLowerCase())), '扩展名都在白名单');
    const happy = listLocalImages([dirs.happy]);
    ok(happy.length === 2, `按目录分别扫（实际 ${happy.length}）`);
    const strict = pickLocalImage([root], { warmth: 0, emotions: ['happy'], emotionSubdir: true });
    ok(strict && strict.includes('happy'), `低温度按情绪目录挑（拿到 ${strict && path.basename(strict)}）`);
    const any = pickLocalImage([root], { warmth: 1, emotions: ['angry'], emotionSubdir: true });
    ok(typeof any === 'string' || any === null, '高温度不会抛错');
    const excluded = pickLocalImage([root], { warmth: 1, exclude: all, rand: () => 0 });
    ok(excluded === null, '全被 exclude 掉 → null');
    ok(listLocalImages([path.join(root, '不存在')]).length === 0, '目录不存在不抛错');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('## 10. 生图提示词：温度真的影响文案');
{
  const low = buildImagePrompt({ warmth: 0, style: 'selfie', promptPrefix: '黑发双马尾少女' });
  const high = buildImagePrompt({ warmth: 1, style: 'selfie', promptPrefix: '黑发双马尾少女' });
  ok(low !== high, '不同温度出不同提示词');
  ok(low.includes('黑发双马尾少女'), '固定前缀被带上');
  ok(/低|克制|稳/.test(low) && /高|脑洞|自由/.test(high), '温度档位有对应文案');
  ok(low.includes('自拍'), '风格 selfie 有对应取景词');
  const preset = buildImagePrompt({ warmth: 0.5, stylePresets: ['水彩风', '赛博'], rand: () => 0 });
  ok(preset.includes('水彩风'), '风格预设被采用');
  const same = buildImagePrompt({ warmth: 0.5, style: 'daily', rand: () => 0.42 });
  ok(same.includes('【') , '带分段结构（【风格】等）');
}

console.log('## 11. 唤醒提示里的【发图】块');
{
  const off = { ...defaultPicConfig(), enabled: false };
  ok(buildPicPromptLine(off) === '', '总开关关闭 → 不注入提示');
  const on = defaultPicConfig();
  const line = buildPicPromptLine(on);
  ok(line && line.includes('发图'), '开启后有【发图】块');
  ok(!/生成新图|generate_image/.test(line), '生图关闭时不提 generate_image');
  const withGen = buildPicPromptLine({ ...on, sources: { ...on.sources, generate: { ...on.sources.generate, enabled: true } } });
  ok(/生成新图|generate_image/.test(withGen), '生图开启后才提 generate_image');
  const serious = buildPicPromptLine({ ...on, seriousGuard: false });
  ok(serious.length > 0, '关掉正事闸后仍可注入');
}

console.log('## 11b. 图文同条开关（combineText）');
{
  const cfg = defaultPicConfig();
  ok(cfg.combineText === true, '默认开：真人斗图就是一句话配一张图');
  ok(normalizePicConfig({ combineText: false }).combineText === false, '显式关掉要保留');
  ok(normalizePicConfig({ combineText: 'yes' }).combineText === false, '只认布尔 true：手改配置写成字串不会被误开');
  ok(normalizePicConfig({}).combineText === true, '缺省仍是开');
  const on = buildPicPromptLine(cfg);
  ok(on.includes('qq_send_pic') && on.includes('text'), '开着时提示里教用 qq_send_pic 的 text 参数');
  ok(on.includes('同一条消息'), '开着时说明会合成一条消息');
  const offLine = buildPicPromptLine({ ...cfg, combineText: false });
  ok(offLine.includes('两条气泡'), '关着时提示还是分两条气泡');
  ok(!offLine.includes('text:"'), '关着时不提 text 合并');
}

console.log('## 12. 降级链：按开关和可用性排顺序');
{
  const cfg = defaultPicConfig();
  const none = picFallbackChain(cfg, { available: { sticker: false, local: false, generate: false } });
  ok(Array.isArray(none) && none.length === 0, '没有任何可用来源 → 空链');
  const onlySticker = picFallbackChain(cfg, { available: { sticker: true, local: true, generate: true } });
  ok(onlySticker[0] === 'sticker', '链首是表情');
  ok(onlySticker.includes('local') === false, '本地图库默认关 → 不进链');
  const all = picFallbackChain({ ...cfg, sources: { ...cfg.sources, local: { ...cfg.sources.local, enabled: true }, generate: { ...cfg.sources.generate, enabled: true } } },
    { available: { sticker: true, local: true, generate: true } });
  ok(all.join('>') === 'sticker>local>generate', `全开时顺序 sticker>local>generate（实际 ${all.join('>')}）`);
  const firstLocal = picFallbackChain({ ...cfg, sources: { ...cfg.sources, local: { ...cfg.sources.local, enabled: true } } },
    { available: { sticker: true, local: true, generate: false }, first: 'local' });
  ok(firstLocal[0] === 'local', '决策挑了本地就优先本地');
  ok(picFallbackChain({ ...cfg, enabled: false }, { available: { sticker: true } }).length === 0, '总开关关闭 → 空链');
}

console.log('## 13. 折中：只有表情这一路时随手挑一张');
{
  const entries = [
    { id: 'a', useCount: 1, emotion: 'happy' },
    { id: 'b', useCount: 9, emotion: 'neutral' },
    { id: 'c', useCount: 4, emotion: 'sad' },
  ];
  const loose = pickStickerLoose(entries, {});
  ok(loose && loose.id === 'b', '挑最常用的那张');
  const noRepeat = pickStickerLoose(entries, { exclude: ['b'] });
  ok(noRepeat && noRepeat.id !== 'b', '避开最近发过的');
  const onlyExcluded = pickStickerLoose([{ id: 'x', useCount: 2 }], { exclude: ['x'] });
  ok(onlyExcluded && onlyExcluded.id === 'x', '全都排除过时退回全库（这里允许重复，因为没有别的）');
  ok(pickStickerLoose([], {}) === null, '空库返回 null');
  const cfg = defaultPicConfig();
  ok(cfg.sources.sticker.looseFallback === true, 'looseFallback 默认开');
}

console.log('## 14. pending 生图：提示词里要带上要补的图');
{
  const cfg = { ...defaultPicConfig(), sources: { ...defaultPicConfig().sources, generate: { ...defaultPicConfig().sources.generate, enabled: true } } };
  const line = buildPicPromptLine(cfg, { pending: { prompt: '窗边的午后自拍，逆光', hint: '晒太阳' } });
  ok(/该补图了/.test(line), '有【该补图了】段');
  ok(line.includes('窗边的午后自拍'), 'prompt 原样带进提示词');
  ok(/qq_send_image/.test(line) && /generate_image/.test(line), '说明先用 generate_image 再用 qq_send_image');
  ok(!/该补图了/.test(buildPicPromptLine(cfg, { pending: null })), '没有 pending 时不出现该补图段');
}

console.log('## 15. 偷图提示：开关 + 口味 + 每日额度');
{
  const stickerLib = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'sticker-lib.js')).href);
  const { buildCollectPromptLine, DEFAULT_COLLECT_TASTE } = stickerLib;
  ok(buildCollectPromptLine({ enabled: false }) === '', '关掉 → 不注入');
  const line = buildCollectPromptLine({ enabled: true, maxPerDay: 3 });
  ok(/偷图/.test(line) && /qq_collect_sticker/.test(line), '开启后有【偷图】块和工具名');
  ok(line.includes('3'), '带上每日额度');
  ok(line.includes('emotion') && line.includes('content'), '要求标注情绪和内容');
  const taste = buildCollectPromptLine({ enabled: true, taste: '沙雕图、猫' });
  ok(taste.includes('沙雕图、猫'), '自定义口味生效');
  const dflt = buildCollectPromptLine({ enabled: true });
  ok(dflt.includes(DEFAULT_COLLECT_TASTE.slice(0, 6)), '留空用默认口味');
}

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
