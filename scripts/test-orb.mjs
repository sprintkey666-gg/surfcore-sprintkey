//   · 配置归一化（钳制范围、默认值、黑名单拆分与去重）
//   · 看屏幕闸（隐私规则：没开不给、命中黑名单整张不拍）
//   · 随插件发布的 orb-app 静态契约（透明/置顶/无边框/令牌头/CSP）
// 真窗口、真截图要靠 Electron + PowerShell，放在真机验收里跑（见 docs/PITFALLS.md）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ORB, normalizeOrbConfig, ORB_APP_SOURCE } from '../plugins/surfcore/lib/orb.js';
import { screenGate, ORB_API_PREFIX } from '../plugins/surfcore/lib/orb-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? `：${detail}` : ''));
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ── 1. 默认值 ────────────────────────────────────────────────────────────────
const def = normalizeOrbConfig(undefined);
eq('默认关闭（得主人自己点开）', def.enabled, false);
eq('默认不看屏幕', def.screen.enabled, false);
ok('默认黑名单非空', def.screen.denyTitles.length >= 8);
ok('默认黑名单含「密码」', def.screen.denyTitles.includes('密码'));
ok('默认黑名单含「支付宝」', def.screen.denyTitles.includes('支付宝'));
eq('默认球大小 64', def.ball.size, 64);
eq('默认停靠右侧', def.ball.dock, 'right');
eq('默认允许主动说话', def.chat.enabled, true);

// ── 2. 钳制 ──────────────────────────────────────────────────────────────────
const big = normalizeOrbConfig({ ball: { size: 999, opacity: 5, panelWidth: 5000 }, chat: { bubbleTtlSec: 999, maxBubbles: 99 }, screen: { maxPerHour: 999 } });
eq('球大小上限 96', big.ball.size, 96);
eq('透明度上限 1', big.ball.opacity, 1);
eq('面板宽度上限 420', big.ball.panelWidth, 420);
eq('气泡停留上限 30', big.chat.bubbleTtlSec, 30);
eq('气泡数量上限 5', big.chat.maxBubbles, 5);
eq('每小时上限 60', big.screen.maxPerHour, 60);
const small = normalizeOrbConfig({ ball: { size: 1, opacity: -3 }, chat: { bubbleTtlSec: 0, maxBubbles: 0, maxPerTurn: 0 }, screen: { maxPerHour: -5 } });
eq('球大小下限 44', small.ball.size, 44);
eq('透明度下限 0.4', small.ball.opacity, 0.4);
eq('气泡停留下限 3', small.chat.bubbleTtlSec, 3);
eq('气泡数量下限 1', small.chat.maxBubbles, 1);
eq('每轮句数下限 1', small.chat.maxPerTurn, 1);
eq('每小时下限 0（= 不限）', small.screen.maxPerHour, 0);

// ── 3. 黑名单输入形态 ────────────────────────────────────────────────────────
const list1 = normalizeOrbConfig({ screen: { denyTitles: '密码, 银行 ， 密码\n令牌' } });
eq('黑名单按中英文逗号/分号/换行拆开并去重', list1.screen.denyTitles, ['密码', '银行', '令牌']);
const list2 = normalizeOrbConfig({ screen: { denyTitles: [] } });
ok('黑名单清空会回到默认（不允许「什么都不拦」）', list2.screen.denyTitles.length > 0);
const dock = normalizeOrbConfig({ ball: { dock: 'left' } });
eq('停靠只认 left/right', dock.ball.dock, 'left');
eq('乱写的停靠回落到 right', normalizeOrbConfig({ ball: { dock: '明天' } }).ball.dock, 'right');
const theme = normalizeOrbConfig({ ball: { theme: 'light' } });
eq('主题 light 保留', theme.ball.theme, 'light');

// ── 4. 看屏幕闸（隐私）──────────────────────────────────────────────────────
eq('没开 → screen-disabled', screenGate({ screen: { enabled: false, denyTitles: ['密码'] } }, ['记事本']), { blocked: true, reason: 'screen-disabled' });
eq('开了、干净 → 放行', screenGate({ screen: { enabled: true, denyTitles: ['密码'] } }, ['记事本', 'VS Code']), { blocked: false });
const gated = screenGate({ screen: { enabled: true, denyTitles: ['密码', '支付宝'] } }, ['记事本', 'XX 支付宝 收银台']);
ok('命中黑名单 → 整张不拍', gated.blocked === true && gated.reason === 'blocked');
ok('命中时能说清是哪个窗口', Array.isArray(gated.matched) && gated.matched.some((t) => t.includes('支付宝')));
eq('大小写不敏感', screenGate({ screen: { enabled: true, denyTitles: ['password'] } }, ['Chrome — PASSWORD manager']).reason, 'blocked');
eq('空标题不误伤', screenGate({ screen: { enabled: true, denyTitles: ['密码'] } }, ['', null, undefined]), { blocked: false });
eq('默认配置 + 普通窗口放行需先开', screenGate({ ...DEFAULT_ORB, screen: { ...DEFAULT_ORB.screen, enabled: true } }, ['任务管理器']), { blocked: false });

// ── 5. orb-app 静态契约 ─────────────────────────────────────────────────────
const appDir = ORB_APP_SOURCE;
for (const f of ['package.json', 'main.js', 'preload.js', 'index.html', 'orb.css', 'orb.js']) {
  ok(`随包发布 ${f}`, fs.existsSync(path.join(appDir, f)));
}
const mainJs = fs.readFileSync(path.join(appDir, 'main.js'), 'utf8');
ok('窗口无边框', /frame:\s*false/.test(mainJs));
ok('窗口透明', /transparent:\s*true/.test(mainJs));
ok('始终置顶', /alwaysOnTop:\s*true/.test(mainJs));
ok('不进任务栏', /skipTaskbar:\s*true/.test(mainJs));
ok('不抢焦点', /showInactive\(\)/.test(mainJs));
ok('带令牌头', mainJs.includes('x-orb-token'));
ok('读 host.json 拿 baseUrl', mainJs.includes('host.json'));
ok('读 SURFCORE_ORB_DIR', mainJs.includes('SURFCORE_ORB_DIR'));
ok('连续失败就退出（跟 DSH 同生共死）', /MAX_STATE_FAILURES/.test(mainJs) && /app\.quit\(\)/.test(mainJs));
const preload = fs.readFileSync(path.join(appDir, 'preload.js'), 'utf8');
ok('preload 只暴露白名单 API', preload.includes('contextBridge') && preload.includes('exposeInMainWorld'));
ok('preload 不给 node', !/require\(\s*['"]node:/.test(preload) && !preload.includes('process.binding'));
const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
ok('有 CSP', /Content-Security-Policy/.test(html));
ok('CSP 禁远程脚本', /script-src 'self'/.test(html));

// ── 6. 接口前缀 ─────────────────────────────────────────────────────────────
eq('orb-api 前缀独立于 DSH 的 api 前缀', ORB_API_PREFIX, '/dsh-surfcore/orb-api');
ok('前缀里没有 /api（那条路要 DSH 会话 Cookie）', !ORB_API_PREFIX.includes('/surfcore/api'));
const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-host-server.js'), 'utf8');
ok('MCP 有 orb_say', mcp.includes("'orb_say'"));
ok('MCP 有 orb_look', mcp.includes("'orb_look'"));
ok('MCP 有 orb_state', mcp.includes("'orb_state'"));
ok('MCP 走 orb-api 而不是 DSH api', mcp.includes('orb-api'));





// —— 0.8.0：图片 part / 眼睛开关 / 面板拖动 / 桌宠命中 ——
{
  const has = (src, ...needles) => needles.every((n) => src.includes(n));
  const mainM = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/assets/orb-app/main.js'), 'utf8');
  const uiM = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/assets/orb-app/orb.js'), 'utf8');
  const htmlM = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/assets/orb-app/index.html'), 'utf8');
  const apiM = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/lib/orb-api.js'), 'utf8');
  const chatM = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/lib/pet-chat.js'), 'utf8');
  const clientM = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/lib/client.js'), 'utf8');
  // DSH 的消息模型读 mimeType + data；写成 mediaType + image 会拼出 data:undefined。
  ok('图片 part 走附件引用（attachment）', has(chatM, 'attachments.saveImage', 'type: "image", attachment: ref') && !has(chatM, 'mediaType: img.mediaType'));
  ok('眼睛开关在面板头', has(htmlM, 'id="btnEye"'));
  ok('眼睛走 /screen/eye 且能关', has(uiM, "'/screen/eye'", 'enabled: false') && has(apiM, "'/screen/eye'"));
  ok('看完就删截图', has(apiM, 'deleteAfterRead', 'dropShot') && has(apiM, 'sweepChatShots'));
  ok('attachToChat 默认关', normalizeOrbConfig({}).screen.attachToChat === false);
  ok('deleteAfterRead 默认开', normalizeOrbConfig({}).screen.deleteAfterRead === true);
  ok('面板拖动不收宽高（锁定 expectedBounds）', /reason === 'panel-move' \? lock\.width/.test(mainM));
  ok('松手用真实 bounds 提交', has(uiM, 'panelPos()') && has(mainM, "'orb:panel-pos'"));
  ok('桌宠拖动要过命中判定', has(uiM, 'if (!petBodyHit(ev)) return;'));
  ok('设置页有「识别完就删截图」「能不能看懂图」', has(clientM, '识别完就删截图', '当前模型能不能看懂图'));
}

if (fails.length) {
  console.error(`✗ test-orb：${pass} 通过，${fails.length} 失败`);
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ test-orb：${pass} 项全过`);

// ── 6. 桌宠形象（dsh-pet 素材 + 面板气泡）────────────────────────────────
// 这一批不依赖 Electron：只验配置钳制、素材服务的目录约定、静态契约。
const petCfg = normalizeOrbConfig({ ball: { mode: 'ball', petSize: 999 }, pet: { singleClickOpens: true, idleMinMs: 100, idleMaxMs: 10 } });
eq('形象可选悬浮球', petCfg.ball.mode, 'ball');
eq('桌宠大小上限 320', petCfg.ball.petSize, 320);
eq('桌宠大小下限 120', normalizeOrbConfig({ ball: { petSize: 1 } }).ball.petSize, 120);
ok('默认形象是桌宠', def.ball.mode === 'pet', def.ball.mode);
eq('单击开会话默认关', def.pet.singleClickOpens, false);
ok('空闲间隔有上限保护', normalizeOrbConfig({ pet: { idleMinMs: 999999 } }).pet.idleMinMs <= 120000);
ok('空闲间隔 min 不大于 max', petCfg.pet.idleMaxMs >= petCfg.pet.idleMinMs);

const petAssetsSrc = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/lib/pet-assets.js'), 'utf8');
ok('素材服务导出 createPetAssetsService', /export function createPetAssetsService/.test(petAssetsSrc));
ok('素材版本钉死（pet-assets.js 里一个 semver 字面量）', /export const PET_VERSION = '\d+\.\d+\.\d+'/.test(petAssetsSrc));
ok('tar 解包偏移按 512 对齐（别把 size 加两遍）', /dataStart \+ Math\.ceil\(size \/ 512\) \* 512/.test(petAssetsSrc));
ok('素材写进 orb/pet（不进 git）', /path\.join\(stateDir, 'orb', 'pet'\)/.test(petAssetsSrc));
ok('素材带 MIT 许可说明', /LICENSE-pet\.txt/.test(petAssetsSrc));
ok('manifest 只留 JSON（不把 jsonc 直接给前端）', /manifest\.json/.test(petAssetsSrc));

const petJs = fs.readFileSync(path.join(ORB_APP_SOURCE, 'pet.js'), 'utf8');
const petCss = fs.readFileSync(path.join(ORB_APP_SOURCE, 'pet.css'), 'utf8');
const orbJs = fs.readFileSync(path.join(ORB_APP_SOURCE, 'orb.js'), 'utf8');
ok('三层 video + 网页形象层（换动作不闪黑）', /id="pvA"/.test(html) && /id="pvIdleB"/.test(html) && /id="pvAction"/.test(html) && /idleVids|actionVid/.test(petJs));
ok('网页形象用 iframe（sandbox 收权）', /id="petFigure"/.test(html) && /sandbox="allow-scripts"/.test(html) && /frame-src/.test(html));
ok('切层等首帧再淡入（不许 play 完立刻换 class）', /requestVideoFrameCallback/.test(petJs) && /function whenFirstFrame\(/.test(petJs));
ok('动作层播完先淡出再卸源', /function finishAction\(/.test(petJs) && /ACTION_FADE_MS/.test(petJs));
ok('头顶气泡元素', /id="bubble"/.test(html) && /#bubble/.test(petCss));
ok('透明区：窗口保持可点（穿透在 Windows 上会让命中判定永远回不来）', /setIgnoreMouseEvents\(false\)/.test(mainJs) && !/setIgnoreMouseEvents\(!hit/.test(mainJs));
// 0.6.0：右键菜单改成窗口内 HTML（原生菜单放不下滑条，一弹还撑窗口），写窗口统一走模式不变量
ok('右键菜单在窗口内绘制（#ctxmenu）', /id="ctxmenu"/.test(html) && /\.ctxmenu/.test(petCss));
ok('菜单四个条目齐全（打开会话/换个动作/大小/隐藏）', /id="ctxOpen"/.test(html) && /id="ctxAction"/.test(html) && /id="ctxSizeToggle"/.test(html) && /id="ctxHide"/.test(html));
ok('菜单里的「大小」是滑条（点开才显示）', /id="ctxSize"/.test(html) && /id="ctxSizeRange"/.test(html) && /type="range"/.test(html));
ok('右键不再撑成旧的大小面板', !/sizePanel/.test(html) && !/openSizePanel/.test(orbJs));
ok('渲染端右键 ⇒ openCtxMenu', /contextmenu'[\s\S]{0,220}openCtxMenu\(ev\)/.test(orbJs));
ok('主进程不再 popup 原生菜单', !/Menu\.buildFromTemplate\(template\)\.popup/.test(mainJs));
ok('窗口模式不变量（displayMode/expectedBounds/applyBounds）', /let displayMode = 'collapsed'/.test(mainJs) && /function expectedBounds\(\)/.test(mainJs) && /function applyBounds\(target, reason/.test(mainJs));
ok('所有写窗口都过 applyBounds', !/win\.setBounds\(\{ x: pos\.x/.test(mainJs) && /applyBounds\(\{ x, y, width, height \}, 'resize'\)/.test(mainJs));
ok('动画期间挡下的展开/收起会被补做一次', /pendingExpand/.test(mainJs) && /flushPendingExpand/.test(mainJs));
ok('缩放起点要求展开态 + expanded 模式', /displayMode !== 'expanded'\) return \{ ok: false \}/.test(mainJs));
ok('右键菜单有「打开会话」', /id="ctxOpen"[^>]*>打开会话</.test(html));
ok('渲染端只走 window.orb（不自己发 HTTP）', !/fetch\(/.test(petJs));
ok('素材 URL 转义中文/空格', /encodeURI/.test(petJs));
// 0.14：皮肤包 / 活动监测 / 试一下气泡
ok('右键有「皮肤 ›」子菜单', /id="ctxSkinToggle"/.test(html) && /id="ctxSkin"/.test(html) && /id="ctxSkinList"/.test(html));
ok('皮肤子菜单能导入 + 打开目录', /id="ctxSkinImport"/.test(html) && /id="ctxSkinBrowse"/.test(html) && /id="ctxSkinDir"/.test(html));
ok('皮肤包走 /pet-packs 的 list/activate/import', orbHas(orbJs, "'/pet-packs'", "action: 'list'", "action: 'activate'", "action: 'import'"));
ok('右键有「监测 ›」子菜单（三个开关 + 间隔 + 现在看一眼）', /id="ctxMonitorToggle"/.test(html) && /id="ctxMonWindow"/.test(html) && /id="ctxMonFiles"/.test(html) && /id="ctxMonMedia"/.test(html) && /id="ctxMonGap"/.test(html) && /id="ctxMonPeek"/.test(html));
ok('监测配置走 activityConfig（get/set）', orbHas(orbJs, 'activityConfig', "action: 'get'", "action: 'set'"));
ok('右键有「试一下气泡」→ POST /say', /id="ctxBubbleTest"/.test(html) && orbHas(orbJs, "'/say'", 'kind: \'proactive\''));
ok('气泡每道门都留了日志', orbHas(orbJs, '[bubble] skip reason=', 'not-pet-mode', 'panel-expanded', 'already-seen'));
ok('网页形象握手（figure:ready / pet:action）', orbHas(petJs, "'figure:ready'", "'pet:action'"));
ok('figure 包没有动画清单时按 null 对照（不会每 4 秒重载一次）',
  /state\.manifest = pet\?\.manifest \? normalizeManifest\(pet\.manifest\) : null/.test(petJs)
  && (petJs.match(/cfg\??\.pet\??\.manifest \? normalizeManifest\(/g) || []).length >= 2);


// 2026-10-31 第二轮契约：自由停靠 / 面板可拖 / 菜单自适应 / 平滑过渡 / 气泡身份 / 对话看图
// 全部用 includes 判断（正则容易在转义上翻船，这里要的是「关键字必须在」）。
const orbApiSrc = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/lib/orb-api.js'), 'utf8');
const petChatJs = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/lib/pet-chat.js'), 'utf8');
const clientJs = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/lib/client.js'), 'utf8');
const indexJs = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/lib/index.js'), 'utf8');
const orbCss = fs.readFileSync(path.join(ORB_APP_SOURCE, 'orb.css'), 'utf8');

function orbHas(hay, ...needles) {
  return needles.every((n) => String(hay).includes(n));
}

ok('收起态允许桌宠贴到屏幕边', orbHas(mainJs, 'function clampForMode(', 'PET_SIDE_SPACE / 2'));
ok('不贴边就不吸右', orbHas(mainJs, 'docked: false'));
ok('面板位置记在 prefs', orbHas(mainJs, 'panelX', 'panelY'));
ok('面板可拖的 IPC', orbHas(mainJs, "orb:panel-move"));
ok('菜单临时撑大窗口', orbHas(mainJs, 'orb:menurect', 'menuNeed', 'menuOpen'));
ok('面板头有「移」按钮', orbHas(html, 'id="btnMove"'));
ok('渲染端做菜单位移补偿', orbHas(orbJs, 'menurect', '--pet-dx'));
ok('渲染端按 screen 状态显示提示条', orbHas(orbJs, 'renderScreenHint', 'screenHint'));
ok('提示条一键开眼睛', orbHas(orbJs, '/screen/eye', 'toggleEye'));
ok('双击不再隐藏宠物', !orbCss.includes('#root.expanded #pet { display: none; }') && orbHas(orbCss, 'opacity: 0', 'scale(.94)'));
ok('桌宠视频有 pause/resume', orbHas(petJs, 'function pause()', 'function resume()', 'pause,', 'resume,'));
ok('气泡带头像和名字', orbHas(orbJs, "'ava'", "'who'") && orbHas(orbCss, '.row .ava', '.row .who'));
ok('气泡身份可在设置里关', orbHas(orbJs, 'showAvatar', 'showName'));
ok('配置有 chat.ident 八字段', Boolean(def.chat && def.chat.ident) && ['showAvatar', 'showName', 'herName', 'meName', 'herQQ', 'meQQ', 'herPath', 'mePath'].every((k) => k in def.chat.ident));
ok('配置有 screen.attachToChat（默认关）', def.screen.attachToChat === false);
ok('头像路由与缓存', orbHas(orbApiSrc, "'/avatar'", 'avatarResolve', 'q1.qlogo.cn'));
ok('开眼睛接口只改 screen.enabled', orbHas(orbApiSrc, "'/eye'") && orbHas(indexJs, 'setOrbScreenEnabled'));
ok('对话带图：明说看不见屏幕', orbHas(petChatJs, '【你现在看不到屏幕】'));
ok('对话带图：image part + 失败退纯文本', orbHas(petChatJs, 'type: "image"', '退回纯文本'));
ok('设置页有「聊天外观」段与清头像缓存', orbHas(clientJs, '聊天外观', 'avatar-refresh'));

// 2026-10-31 第二轮契约：自由停靠 / 面板可拖 / 菜单自适应 / 平滑过渡 / 气泡身份 / 对话看图
// 全部用 includes 判断（正则容易在转义上翻船，这里要的是「关键字必须在」）。
{
  const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/assets/orb-app/main.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/assets/orb-app/index.html'), 'utf8');
  const orbSrc = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/assets/orb-app/orb.js'), 'utf8');
  const petSrc = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/assets/orb-app/pet.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/assets/orb-app/orb.css'), 'utf8');
  const httpSrc = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/lib/orb-api.js'), 'utf8');
  const chatSrc = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/lib/pet-chat.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/lib/client.js'), 'utf8');
  const idxSrc = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/lib/index.js'), 'utf8');
  const h = (hay, ...needles) => needles.every((n) => String(hay).includes(n));

  ok('收起态允许桌宠贴到屏幕边', h(mainSrc, 'function clampForMode(', 'PET_SIDE_SPACE / 2'));
  ok('不贴边就不吸右', h(mainSrc, 'docked: false'));
  ok('面板位置记在 prefs', h(mainSrc, 'panelX', 'panelY'));
  ok('面板可拖的 IPC', h(mainSrc, 'orb:panel-move'));
  ok('菜单临时撑大窗口', h(mainSrc, 'orb:menurect', 'menuNeed'));
  ok('面板头有「移」按钮', h(htmlSrc, 'id="btnMove"'));
  ok('渲染端做菜单位移补偿', h(orbSrc, 'menurect', '--pet-dx'));
  ok('渲染端按 screen 状态显示提示条', h(orbSrc, 'renderScreenHint', 'screenHint'));
  ok('提示条一键开眼睛', h(orbSrc, '/screen/eye', 'toggleEye'));
  ok('双击不再隐藏宠物', !cssSrc.includes('#root.expanded #pet { display: none; }') && h(cssSrc, 'opacity: 0', 'scale(.94)'));
  ok('桌宠视频有 pause/resume', h(petSrc, 'function pause()', 'function resume()'));
  ok('气泡带头像和名字', h(orbSrc, "'ava'", "'who'") && h(cssSrc, '.row .ava', '.row .who'));
  ok('气泡身份可在设置里关', h(orbSrc, 'showAvatar', 'showName'));
  ok('配置有 chat.ident 八字段', Boolean(def.chat && def.chat.ident) && ['showAvatar', 'showName', 'herName', 'meName', 'herQQ', 'meQQ', 'herPath', 'mePath'].every((k) => k in def.chat.ident));
  ok('配置有 screen.attachToChat（默认关）', def.screen.attachToChat === false);
  ok('头像路由与缓存', h(httpSrc, "'/avatar'", 'avatarResolve', 'q1.qlogo.cn'));
  ok('开眼睛接口只改 screen.enabled', h(httpSrc, "'/eye'") && h(idxSrc, 'setOrbScreenEnabled'));
  ok('对话带图：明说看不见屏幕', h(chatSrc, '【你现在看不到屏幕】'));
  ok('对话带图：image part + 失败退纯文本', h(chatSrc, 'type: "image"', '退回纯文本'));
  ok('设置页有「聊天外观」段与清头像缓存', h(uiSrc, '聊天外观', 'avatar-refresh'));

  // ── 0.9.0：输入不被打断 / 看图三档 / 面板发图 / 位置只由主人定 ──────────────
  ok('打字时不收窗口（isComposing 守卫）', h(orbSrc, 'const isComposing = () =>', 'if (isComposing()) return;'));
  ok('输入事件刷新活动时间', h(orbSrc, "for (const ev of ['input', 'focus', 'keydown'])", 'clearTimeout(collapseTimer)'));
  eq('看屏幕默认手动档', def.screen.mode, 'manual');
  eq('老配置 enabled:false → off', normalizeOrbConfig({ screen: { enabled: false } }).screen.mode, 'off');
  eq('老配置 enabled:true → manual', normalizeOrbConfig({ screen: { enabled: true } }).screen.mode, 'manual');
  eq('显式 mode 优先', normalizeOrbConfig({ screen: { mode: 'auto', enabled: false } }).screen.mode, 'auto');
  eq('发图默认关', def.pic.enabled, false);
  eq('发图默认优先 QQ 表情', def.pic.preferQqSticker, true);
  eq('发图默认每小时 12 张', def.pic.maxPerHour, 12);
  ok('截图记账落盘 shots.json', h(httpSrc, 'shots.json', 'function bumpShot('));
  ok('手动点眼有 3 秒冷却', h(httpSrc, 'EYE_COOLDOWN_MS = 3000', "reason: 'cooldown'"));
  ok('手动档不吃每小时额度', h(httpSrc, 'manual: true'));
  ok('自动档两段式（[[看一眼]] 暗号）', h(httpSrc, '[[看一眼]]', "shotForChat('auto', cfg)") && h(chatSrc, '[[看一眼]]'));
  ok('自动档每轮最多一次', h(httpSrc, "screenMode: 'auto'"));
  ok('面板发图路由 /pic 与 /pic/image', h(httpSrc, "suffix === '/pic'", "suffix === '/pic/image'"));
  ok('发图先走 QQ 收藏表情', h(httpSrc, '/api/socialV2/sticker-list', '/api/socialV2/sticker-image'));
  ok('发图会读本地图库目录', h(httpSrc, 'picLocalDirs()'));
  ok('发图落盘到 orb/media', h(httpSrc, 'function savePic(', "'media'"));
  ok('面板头有「图」按钮', h(htmlSrc, 'id="btnPic"'));
  ok('发图按钮跟着开关显隐', h(orbSrc, 'picEnabled'));
  ok('气泡能显示图片', h(orbSrc, "className = 'pic'") && h(cssSrc, '.bubble .pic'));
  ok('提示条 3 秒后渐隐', h(orbSrc, 'showHintBriefly', "'fade'") && h(cssSrc, '.screenhint.fade'));
  ok('收起不再改桌宠位置', !mainSrc.includes("// 面板被主人拖过：收起后桌宠就落在面板那一块") && h(mainSrc, '不跟着面板走'));
  ok('设置页能选看屏幕的档位', h(uiSrc, 'screen.mode', '自动：她想看会自己申请'));
  ok('设置页有悬浮窗发图开关', h(uiSrc, '悬浮窗发图', 'pic.enabled'));
  // 0.9.1 / 0.9.2：眼睛点按语义、图片自适应、会话滚动与未读小圆
  ok('单击「眼」= 关闭眼睛', h(orbSrc, "screenModeOf(state?.screen) !== 'off') { void toggleEye(); return; }"));
  ok('双击「眼」= 看一次', h(orbSrc, "addEventListener('dblclick'") && h(orbSrc, 'async function lookOnce('));
  ok('单击要等 230ms 区分双击', h(orbSrc, 'eyeClickTimer = setTimeout('));
  ok('关眼睛后立刻不亮', h(orbSrc, 'applyScreenResult(res)', "btn.classList.toggle('on', mode !== 'off')"));
  ok('关掉后提示「眼睛已关闭」', h(orbSrc, '眼睛已关闭'));
  ok('图片自适应气泡宽度', h(cssSrc, 'max-width: 100%'));
  ok('面板有未读小圆按钮', h(htmlSrc, 'id="btnJump"') && h(cssSrc, '.jump {'));
  ok('小圆里有未读条数', h(orbSrc, 'unreadCount'));
  ok('没有未读时显示向下箭头', h(orbSrc, "unreadCount > 0 ? (unreadCount > 99 ? '99+' : String(unreadCount)) : '↓'"));
  ok('翻历史时不抢滚动', h(orbSrc, 'if (items.length > prevCount && !atBottom && expanded)'));

  // ── 0.10.0：眼睛状态说真话 / 面板打开先同步 / 发图接通生图 / 表情图走代理 ─────
  const fetchSrc = fs.readFileSync(path.join(ROOT, 'src/safe-fetch.js'), 'utf8');
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');

  ok('关眼睛回包带真实 mode', h(httpSrc, 'const closed = orb.readConfig();', 'mode: closedScreen.mode'));
  ok('开眼睛也按新配置回包', h(httpSrc, 'const opened = orb.readConfig();', 'screen: openedScreen'));
  ok('眼睛开关都按 screenModeOf 判', h(orbSrc, 'function screenModeOf(', "screenModeOf(state?.screen) !== 'off'"));
  ok('双击只发一条 look 请求', h(orbSrc, 'body: { enabled: true }, timeoutMs: 120000') && !h(orbSrc, 'await toggleEye();'));
  ok('眼睛回包合并进本地 state', h(orbSrc, 'function applyScreenResult(', 'renderScreenHint(state.screen)'));
  ok('打开面板先 /state 同步一次', h(orbSrc, 'async function refreshState(', 'void refreshState();'));
  ok('打开面板贴到最新一条', h(orbSrc, 'setJump(false, 0);', 'requestAnimationFrame(() => { bubbles.scrollTop = bubbles.scrollHeight; })'));
  ok('每份状态都刷眼睛提示条', h(orbSrc, 'renderScreenHint(next.screen)'));
  ok('图片加载失败有占位', h(orbSrc, "pic.addEventListener('error'", "classList.add('missing')") && h(cssSrc, '.pic.missing'));
  ok('图片高度跟着窗口收着点', h(cssSrc, 'min(240px, 42vh)'));
  ok('有图气泡按内容收紧不拉伸', !h(cssSrc, '.bubble.haspic .pic') && h(cssSrc, '.bubble .pic'));
  ok('生图直接调 codex 脚本', h(httpSrc, 'codex-gen.mjs', 'function generateNow(', 'spawn(process.execPath'));
  ok('生图失败仍可让 agent 补图', h(httpSrc, 'needGenerate: true', "suffix === '/pic/image'"));
  ok('画图忙时不并发', h(httpSrc, 'let genBusy = false', '上一张还在画'));
  ok('聊天知道刚发过什么图', h(httpSrc, 'freshPics(3)') && h(chatSrc, '【你刚在悬浮球里发过的图】'));
  ok('safe-fetch 支持域名白名单 + 代理', h(fetchSrc, 'allowHosts', 'hostMatchesAllowList', "method: 'CONNECT'"));
  ok('QQ 图床走代理隧道', h(bridgeSrc, 'QQ_MEDIA_HOSTS', 'MEDIA_FETCH_OPTS', 'proxy: MEDIA_PROXY'));
  ok('拖拽留 60px 可抓边', h(mainSrc, 'const PET_KEEP = 60', 'const keepX', 'const keepY'));

  // ── 0.10.1：桌宠气泡贴着头顶 / 角色按 pet-size 放大，不再悬在窗口中间 ─────
  ok('气泡按角色头顶摆而不是窗口顶边', h(petJs, 'PET_HEAD_RATIO', 'function placeBubble(', 'bubble.style.bottom'));
  ok('气泡弹出/换动作/窗口变化都重摆', h(petJs, 'placeBubble();') && h(petJs, "window.addEventListener('resize', () => placeBubble())"));
  ok('气泡不再钉死在 top:8px', !h(petCss, 'top: 8px') && h(petCss, 'top: auto;'));

  // ── 0.12.2：能拖到最上面 / 透明处不再挡点击 ──────────────────────────
  ok('左边吸附不会把她吸出屏幕', h(mainSrc, "near.side === 'left' ? area.x : area.x + area.width - bounds.width"));
  ok('往上拖不再被气泡带卡住', h(mainSrc, 'const bodyH = Math.min(height', 'const minY = area.y - (height - bodyH)'));
  ok('主进程轮询光标决定穿透', h(mainSrc, 'function startClickWatch(', 'screen.getCursorScreenPoint()', 'orb:bubble-shown', 'orb:ui-hold'));
  ok('只有宠物实体和气泡带可点', h(mainSrc, 'function bodyRectInWindow(', 'setClickThrough(!(inBody || inBubbleBand))'));
  ok('气泡显示时才留出可点带', h(petJs, 'window.orb?.bubbleShown?.(true)', 'window.orb?.bubbleShown?.(false)'));
  ok('菜单/看图打开时整窗可点', h(orbJs, 'window.orb?.uiHold?.(true)', 'window.orb?.uiHold?.(false)') && h(preload, 'uiHold:', 'bubbleShown:'));
  ok('桌宠按 pet-size 反推整帧放大', h(petCss, 'calc(var(--pet-size, 200px) * 1.22)') && h(petJs, "setProperty('--pet-size'"));

  // ── 0.10.3：大小滑条改 0-100%，拖动途中不窗口跳 ────────────────────────
  const inputAt = orbSrc.indexOf("ctxSizeRange?.addEventListener('input'");
  const changeAt = orbSrc.indexOf("ctxSizeRange?.addEventListener('change'");
  ok('大小滑条是 0-100%', h(htmlSrc, 'id="ctxSizeRange"', 'min="0"', 'max="100"') && h(orbSrc, 'sizeToPercent(', 'percentToSize('));
  ok('松手才真改窗口（拖动中只更新数字）', changeAt > inputAt && inputAt >= 0 && !/petSize/.test(orbSrc.slice(inputAt, changeAt)));
  ok('滑条改完同步角色尺寸', h(orbSrc, 'window.SurfPet?.setSize?.(size)') && h(petJs, 'function setSize(', 'setSize,'));

  // ── 0.12.15：气泡改浮层 + 4 行折叠（窗口不再跟着气泡改高）────────────────
  const bubbleRule = (petCss.match(/#bubble \{[^}]*\}/) || [''])[0];
  ok('气泡框不再裁剪小尾巴', !/overflow:\s*hidden/.test(bubbleRule) && h(petCss, '#bubbleText', '-webkit-line-clamp: 4', 'overflow: hidden'));
  ok('气泡文字走里层 span', h(htmlSrc, '<span id="bubbleText"></span>') && h(petJs, "document.getElementById('bubbleText')"));
  // 三层视频各自带 z-index（1/3），气泡必须比它们高，否则会被待机层整个盖住。
  const bubbleZ = Number((bubbleRule.match(/z-index:\s*(\d+)/) || [, '0'])[1]) || 0;
  const stageRule = (petCss.match(/\.petStage \{[^}]*\}/) || [''])[0];
  ok('气泡盖在视频层之上（不会被她自己挡住）',
    bubbleZ > 3 && /isolation:\s*isolate/.test(stageRule) && bubbleZ > (Number((petCss.match(/\.pvAction \{[^}]*z-index:\s*(\d+)/) || [, '0'])[1]) || 0));

  // ── 0.11.0：气泡图文一体 / 聊天配图 / 发送即清空与排队 ─────────────────
  ok('图文一体默认开', def.chat.richBubble === true);
  ok('聊天配图默认关', def.pic.attachToChat === false);
  const orbNorm = normalizeOrbConfig({});
  ok('归一化带上两个新开关', orbNorm.chat.richBubble === true && orbNorm.pic.attachToChat === false);
  const orbNormOff = normalizeOrbConfig({ chat: { richBubble: false }, pic: { attachToChat: true } });
  ok('两个开关能被关/开回来', orbNormOff.chat.richBubble === false && orbNormOff.pic.attachToChat === true);
  ok('挑图逻辑抽成 pickPic', h(httpSrc, 'async function pickPic(', 'source: \'sticker\'', 'source: \'local\''));
  ok('/pic 复用 pickPic', h(httpSrc, 'const picked = await pickPic({ hint, source, cfg })'));
  ok('聊天回合抽成 runChatTurn', h(httpSrc, 'async function runChatTurn({ text, cfg'));
  ok('聊天队列串行执行', h(httpSrc, 'const chatQueue = []', 'let chatBusy = false', 'async function pumpChatQueue()'));
  ok('队列有上限', h(httpSrc, 'const CHAT_QUEUE_MAX = 20', '429'));
  ok('排队请求立刻回 200', h(httpSrc, 'body.queue === true', 'queued: true', 'position, state: stateForOrb()'));
  ok('状态里带排队情况', h(httpSrc, 'queue: { pending: chatQueue.length, busy: chatBusy }'));
  ok('单条失败不堵后面', h(httpSrc, 'kind: \'system\'', '（这条没回上来：'));
  ok('配图暗号会被剥掉', h(httpSrc, '[[配图', 'replyText.replace('));
  ok('配图走快来源不现场画', h(httpSrc, 'picQuotaLeft(cfg)', 'const picked = await pickPic({ hint: String(marker[1]'));
  ok('回复能带图成一条消息', h(httpSrc, "kind: 'reply', image: turn.image"));
  ok('聊天提示词支持配图暗号', h(chatSrc, 'allowPic', '[[配图: 画面描述]]'));
  ok('历史里不留配图暗号', h(chatSrc, 'historyText', 'reply.replace(/\\[\\[配图'));
  ok('面板支持图文一体分流', h(orbSrc, 'const rich = state?.config?.chat?.richBubble !== false', 'const splitPic', 'makeBubble(true, false, false)'));
  ok('发送后立刻清空输入框', h(orbSrc, 'input.value = \'\';', 'body: { text, queue: true'));
  ok('清空在请求之前', orbSrc.indexOf('input.value = \'\';') < orbSrc.indexOf('body: { text, queue: true'));
  ok('发送失败把话还回去', h(orbSrc, 'if (!input.value) input.value = text;'));
  ok('排队时提示前面几条', h(orbSrc, '已排队：前面还有'));
  ok('排队没回完不自动收起', h(orbSrc, 'function queueBusy()', 'sending || queueBusy()'));
  ok('头顶气泡也能带图', h(htmlSrc, 'id="bubblePic"') && h(petJs, 'function showBubble(text, options = {})', "document.getElementById('bubblePic')"));
  ok('头顶气泡图限高不撑破气泡带', h(petCss, '#bubble .bubblePic', 'max-height: min(40px', 'object-fit: contain'));
  ok('图加载完重算头顶位置', h(petJs, 'pic.onload = () => placeBubble();'));
  ok('设置页有「聊天里也能配图」', h(uiSrc, '聊天里也能配图', 'pic.attachToChat'));
  ok('设置页有「气泡图文一体」', h(uiSrc, '气泡图文一体', 'chat.richBubble'));

  // 0.11.1 修：标记必须从 rawReply 取（reply.text 已经是剥过的历史文本），
  // 挑表情的 QQ 号要从 deriveIdentDefaults 拿（原来的 () => adminQQ 是空引用）。
  ok('配图标记从 rawReply 取', h(orbApiSrc, 'result.rawReply || result.reply', 'allowPic && picQuotaLeft(cfg) > 0'));
  ok('chat() 回传未剥的 rawReply', h(petChatJs, 'rawReply: reply'));
  ok('挑 QQ 表情拿得到主人 QQ', h(indexJs, 'adminQQ: () => deriveIdentDefaults().meQQ'));

  // ── 0.12.0：气泡自适应 / 已读水位 / 双击看图 / QQ 近况 ─────────────────
  const orbLibSrc = rd('plugins/surfcore/lib/orb.js');
  // A. 面板气泡不再被压扁（flex 容器缺 min-height:0 会让行被压缩、顶部文字被裁）
  ok('消息列表允许滚动不被压扁', h(cssSrc, 'min-height: 0') && h(cssSrc, '.bubbles > .row', 'flex: 0 0 auto'));
  // B. 头顶气泡在窗口内浮层化：高度靠 --bubble-max，窗口尺寸不再跟着气泡变（0.12.15 起）
  ok('头顶气泡按可用余量折算高度', h(petSrc, 'function placeBubble()', "setProperty('--bubble-max'") && h(petCss, 'max-height: var(--bubble-max, 96px)'));
  ok('气泡收起时窗口不回落', !/bubbleSpace\?\.\(0\)/.test(petSrc) && h(petSrc, '不需要 bubbleSpace(0) 复位'));
  ok('主进程能吃气泡带高度', h(mainSrc, "ipcMain.handle('orb:bubble-space'", 'function bandFor()', 'bubbleBand'));
  ok('窗口按带高向上长', h(mainSrc, 'size + bandFor()'));
  ok('preload 暴露 bubbleSpace', h(preload, 'bubbleSpace: (px)'));
  ok('命中判定跟着动态带高', h(orbSrc, 'window.SurfPet?.bubbleBand?.()'));
  // C. 已读水位：看过的不再弹气泡
  ok('状态文件记住已读水位', h(orbLibSrc, 'readSeenId', 'markSeen(', 'seenId'));
  ok('已读水位只进不退', h(orbLibSrc, 'Math.max(', 'seenId'));
  ok('后端有 /seen 路由', h(httpSrc, "suffix === '/seen'", 'orb.markSeen('));
  ok('状态里带 seenId', h(httpSrc, 'read: { seenId: orb.readSeenId() }'));
  ok('面板看过就上报已读', h(orbSrc, 'function markSeen(', "http('/seen'"));
  ok('已读的不再弹头顶气泡', h(orbSrc, 'Number(last.id) <= seenId'));
  // D. 双击图片看大图
  ok('双击图片打开查看器', h(orbSrc, "addEventListener('dblclick'", 'openViewer('));
  ok('查看器滚轮缩放', h(orbSrc, "addEventListener('wheel'", 'Math.exp(-Number(ev.deltaY || 0) * 0.0015)'));
  ok('查看器可拖动', h(orbSrc, 'function closeViewer(', 'grabbing'));
  ok('查看器 DOM 在页面里', h(htmlSrc, 'id="viewer"', 'id="viewerImg"', 'id="viewerClose"'));
  ok('查看器样式', h(cssSrc, '.viewer {', '.viewer-close'));
  ok('看图时 Esc 先关查看器', h(orbSrc, 'if (view.open) { closeViewer(); return; }'));
  // E. QQ 近况：撤掉原文通道，只用共用那张衰减记忆卡
  ok('不再有 QQ 原文通道', !h(httpSrc, 'recentQqLines') && !h(chatSrc, '你们刚在 QQ 上聊的') && !h(uiSrc, 'chat.shareQqRecent'));
  ok('悬浮窗仍用同一张记忆卡', h(chatSrc, "promptCard('qq')", 'buildInteropMemory(') && h(chatSrc, 'memoryCardPromptBlock(platform)'));

  // ── 0.12.1：记忆三项互通（悬浮窗自己的开关 + B站 读桌宠记忆）───────────
  ok('互通记忆默认开', def.chat.shareMemory === true);
  ok('归一化带互通记忆', orbLibSrc.includes('shareMemory: chat.shareMemory !== false'));
  const orbNormMem = normalizeOrbConfig({ chat: { shareMemory: false } });
  ok('互通记忆能关', orbNormMem.chat.shareMemory === false);
  ok('悬浮窗记忆开关走自己的配置', h(chatSrc, 'isOrb ? orbChat.shareMemory !== false : chat.remember !== false'));
  ok('关掉互通就不再读卡', h(chatSrc, 'isOrb && unified?.orb?.chat?.shareMemory === false'));
  ok('设置页有「互通记忆」', h(uiSrc, '互通记忆', 'chat.shareMemory'));
  const memoryCardSrc = rd('src/memory-card.js');
  ok('记忆卡有 B站 带桌宠的开关', h(memoryCardSrc, 'includePetInBili', 'includePetInBili: bool(raw.includePetInBili'));
  ok('B站 记忆放行桌宠 scope', h(memoryCardSrc, "cfg.includePetInBili && record.scope === 'pet'"));
  // 2026-11-01 隐私硬规则：B站 只放她自己那侧，主人私聊与隐私词在 visibleFor 就筛掉。
  ok('B站 桌宠只放她自己那侧', h(memoryCardSrc, "record.source === 'pet-self'", 'record.screenSeen === false', 'biliPrivacyHit(record)'));
  ok('隐私词命中整条不进 B站', h(memoryCardSrc, 'function biliPrivacyHit(', '/\\d{5,}/', 'BILI_PRIVATE_RE'));
  ok('看屏幕那侧的记忆标了 screenSeen', h(memoryCardSrc, 'screenSeen: input.screenSeen === true', 'item.screenVision !== false'));
  ok('聊天的看屏标记按 desktop/image 判定', h(chatSrc, 'screenAware: Boolean(desktop) || Boolean(image)', 'screenVision'));
  ok('主动搭话永远算看屏那侧', h(chatSrc, 'screenAware: true'));
  ok('B站 注入块是硬规矩不是提醒', h(memoryCardSrc, '硬规矩，不是建议', '一条都没有进这里'));
  ok('设置页说清楚私聊进不来', h(uiSrc, '你和她的私聊记录', '一条都不会进 B站'));
  ok('设置页有「B站 提示词带桌宠」', h(uiSrc, 'B站 提示词带桌宠', 'setConfig("includePetInBili"'));

  // 2026-11-01 0.12.9：头像要真的能显示出来。
  // 悬浮窗页面是 loadFile(index.html)（file:// 源）打开的，`/avatar?who=her` 这类相对路径
  // 会被解析成 file:///avatar?… → 永远 404，头像只剩一个字母点；填什么都一样。
  ok('头像给的是本地 file:// URL', h(httpSrc, 'function fileUrl(', 'file:///', "avatarUrlSync('her', id)", "avatarUrlSync('me', id)"));
  ok('头像文件路径剥掉引号（复制文件地址自带引号）', h(httpSrc, 'function stripPath(', 'herPath: stripPath(raw.herPath)') && h(rd('plugins/surfcore/lib/orb.js'), 'function stripQuotes(', 'herPath: stripQuotes('));
  ok('QQ 头像缓存按身份分文件名 + 后台补', h(httpSrc, 'function avatarCacheFor(', 'function ensureAvatar(', 'avatarPatching', 'sweepAvatarCache('));
  ok('拿不到头像就不塞 src（别让 img 去请求页面本身）', h(orbSrc, 'if (who.avatarUrl) img.src = who.avatarUrl;', "else img.classList.add('noava');"));
}

if (fails.length) {
  console.error(`✗ test-orb：${pass} 通过，${fails.length} 失败`);
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ test-orb：${pass} 项全过`);
