# 陪伴模式（Companion）当前设计

> 适用版本：悬浮窗 **0.12.15**（2026-11-01）
> 相关文件：`plugins/surfcore/lib/orb-companion.js`、`plugins/surfcore/assets/orb-app/companion.{html,css,js}`、`main.js`、`orb.js`、`index.html`、`pet.css`、`preload.js`
> 功能总表见 [`FEATURES.md`](FEATURES.md#20-陪伴模式桌宠右键开启字幕陪看--上下文--历史--字号)，改动记录见 [`CHANGELOG.md`](../CHANGELOG.md)。

## 1. 它是什么

陪伴模式让桌宠在主人看视频/工作时，定时截一张本机屏幕，让模型生成一句短评，以底部字幕条的形式陪看。

边界：

- 只截屏，不录屏、不传视频/音频。
- 不写 QQ、不写群、不写 B 站，字幕和消息只在内存。
- 截图会落盘到 `~/.dsh/surfcore/orb/screens/`，由现有的截图清理策略管理。
- 需要先在设置里打开「让她看见这台电脑」的屏幕权限。

## 2. 入口与交互

| 操作 | 结果 |
| --- | --- |
| 右键桌宠 → 菜单里的陪伴区 → 开启/关闭 | 开启后隐藏桌宠、显示字幕条；再点关闭恢复桌宠 |
| 右键桌宠 → 菜单里的陪伴区 → 上下文字幕 | 字幕从“只显示最新一句”切换为“最近一问一答，最多 3 条” |
| 右键桌宠 → 大小 | 展开 0–100% 宠物大小滑条；菜单会按内容自适应扩窗 |
| 字幕左键单击 | 打开输入框；再点一次收起 |
| 字幕左键长按约 260ms 或按住移动 | 拖动字幕窗；不会误触输入框 |
| 字幕右下角拖动 | 改宽度；到屏幕右边会自动左移，不沉出屏幕 |
| 字幕 `A− / A+` | 调整字号并写入本机配置；背景高度、输入框、发送按钮随字号缩放 |
| `Ctrl+滚轮` | 快速调字号 |
| 按住 `Ctrl+Alt` | 展开历史字幕（全部消息带时间、可滚动），松开收回 |
| 字幕右上角 `×` | 关闭陪伴，恢复桌宠 |
| 托盘菜单 | 陪伴活动时提供「关闭陪伴（恢复桌宠）」 |
| Esc | 菜单打开时只收菜单；输入框打开时收输入框 |

设置页入口：**SurfCore → 悬浮窗 → 陪伴模式（一起看电影）**。可调间隔、每小时句数、字号、宽度、背景不透明度、上下文字幕。会话顶部**不再有**「🎬 陪伴」按钮。

## 3. 配置

配置键：`socialV2.orb.companion`（读写见 `plugins/surfcore/lib/orb.js` 的 `normalizeOrbConfig` / `DEFAULT_COMPANION`）。

| 字段 | 默认 | 范围/说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否允许开始 |
| `intervalSec` | `60` | 20–180 秒 |
| `maxCommentsPerHour` | `12` | 1–30 条/小时 |
| `fontPx` | `22` | 14–40 |
| `width` | `900` | 520–1400；本机拖宽后以 `prefs.companion.width` 优先 |
| `opacity` | `55` | 0–90；字幕背景不透明度 |
| `contextSubtitles` | `false` | 是否在字幕里保留一问一答（最多 3 条） |

本机窗口位置/宽度/字号另存 `~/.dsh/surfcore/orb/prefs.json` 的 `companion` 字段。

## 4. 服务端流程

`createOrbCompanionService`：

- `start({sessionId})`：检查屏幕权限，清空本轮消息，发布第一条「陪伴模式已开启 · 等画面动起来」，按 `intervalSec` 起定时器。
- `tick()`：
  1. 截图（800px JPEG，SHA 去重）。
  2. 同一画面不重复调模型；每小时超过上限直接跳过。
  3. 拼 prompt：角色卡、记忆卡、最近 4 条对话、短评规则（40 字内、不剧透、不念隐私、无变化 SKIP）。
  4. 调 `pet-chat` 的模型通道，成功后 `publish(text, 'her')`。
- `reply(text)`：
  1. `append('me', text)` 只入历史，**不替换当前字幕**。
  2. prompt 带记忆卡、最近 8 条对话；要求接住上下文。
  3. 成功后 `publish(reply, 'her')`；失败发一条「这条没接上：原因」，服务保持 active。
- `stop()`：清定时器、清当前字幕（历史消息保留到下一次 start 清空）。
- `status()`：返回 `active / sessionId / startedAt / intervalSec / fontPx / width / opacity / contextSubtitles / subtitle / messages / lastError / degraded / commentsThisHour`。

消息上限 `MESSAGE_LIMIT = 200`；短评上限 60 字，回复上限 120 字。

## 5. 失败与降级

旧实现“连续 3 次截图失败自动 stop”，表现为「陪看暂停」且不再回复。0.12.11 起改为：

- 截图失败：`lastError` + `degraded=true`，按 2 分钟起步、最多 5 分钟的指数退避；**不 stop**。
- 模型失败：`reply` 返回 `ok:false`，字幕发一条错误提示；服务保持 active，额度/网络恢复后自动继续。
- 字幕标题：
  - `active=false` → 「陪看暂停」
  - `active=true && lastError` → 「有点卡」
  - 正常 → 「陪你看会儿」
- 状态点：`lastError` 时橙色，正常绿色。

## 6. 窗口与菜单几何（0.12.11–0.12.15）

### 菜单

- `orb.js` 的 `fitCtxWindow()` 先用菜单真实 `scrollWidth/scrollHeight` 量尺寸，再调 `window.orb.menurect(need)`。
- `main.js` 用独立 `menuOpen` 覆盖层：菜单打开时临时改窗口尺寸，但**不改变 `displayMode`**；关闭时按 `menuRestore` / `ctxWasExpanded` 恢复原来的展开面板或桌宠。
- 菜单 CSS 用 `width: fit-content` + `max-width: min(320px, 100vw-8px)` + 纵向滚动；不再写死 190/250px。
- `#ctxSize` 滑条 DOM 在 `index.html`；展开后重新 `fit` 再摆位。
- 菜单外点击/窗口失焦只收菜单，不把已展开面板打回桌宠。

### 字幕窗

- `companion:height`：以底边为锚点，内容变高时向上让位；只有顶到工作区上沿才压缩高度，**绝不向下移动**。
- `companion:width`：宽度到屏幕右边时整体左移，保持右边缘可见。
- 拖宽结束才 `companion:save()` 落盘，并通过 `/companion action=config` 同步宽度。
- `ensureCompanionWindow` 优先 `prefs.companion.width`，避免服务端旧 state 每次轮询把用户宽度打回去。

## 7. 接口

悬浮窗直连（回环 + `x-orb-token`）：

```text
GET  /dsh-surfcore/orb-api/companion
POST /dsh-surfcore/orb-api/companion
body: { action: "start"|"stop"|"reply"|"config", sessionId?, text?, patch? }
```

控制台/桥接代理（需控制台令牌）：

```text
GET  /dsh-surfcore/api/orb/companion
POST /dsh-surfcore/api/orb/companion
```

`config` 示例：

```json
{ "action": "config", "patch": { "opacity": 40, "contextSubtitles": true } }
```

## 8. 关键文件

| 文件 | 作用 |
| --- | --- |
| `plugins/surfcore/lib/orb-companion.js` | 截图、去重、限额、消息、prompt、失败降级 |
| `plugins/surfcore/lib/orb-api.js` | `/companion` 路由、`action=config` |
| `plugins/surfcore/lib/index.js` | 控制台代理、启动/停止悬浮窗 |
| `plugins/surfcore/assets/orb-app/main.js` | 字幕窗、置顶、拖拽、高度/宽度锚点、菜单 overlay |
| `plugins/surfcore/assets/orb-app/orb.js` | 右键菜单、自适应尺寸、大小滑条、陪伴开关 |
| `plugins/surfcore/assets/orb-app/index.html` | 菜单 DOM（含 `#ctxSize`） |
| `plugins/surfcore/assets/orb-app/pet.css` | 菜单自适应/滚动样式 |
| `plugins/surfcore/assets/orb-app/companion.html/css/js` | 字幕条 UI、字号、模式、长按拖动、发送 |
| `plugins/surfcore/assets/orb-app/preload.js` | `window.orb.companion` API |

## 9. 验证

```powershell
cd <仓库路径>\plugins\surfcore
node scripts/test-orb-companion.mjs   # 10 项
cd <仓库路径>
node scripts/test-orb.mjs             # 276 项
```

手工清单：

1. 右键桌宠 → 开启陪伴：桌宠隐藏，字幕出现。
2. 点字幕开输入框，发送后输入框立即清空；失败时显示原因，不自动停。
3. 右键 → 大小：滑条完整展开，不横向裁字、不出现横向滚动条。
4. 菜单外点击：菜单消失，已展开面板仍在（不打回桌宠）。
5. 拖字幕右下角：宽度变化，窗口不沉出屏幕；松手后重新打开仍保持。
6. `Ctrl+Alt`：历史展开/收回；上下文开关只显示最近 3 条。
7. `A−/A+`：字号、背景高度、输入框同步缩放。

## 10. 踩坑记录

- DSH 置顶会压字幕：Electron `moveTop()` 不够，必须 Win32 `SetWindowPos(HWND_TOPMOST, SWP_SHOWWINDOW)`；`forceCompanionTopmost()` 在 ready 后 0.8 秒补一次。
- 菜单关闭不能读“当前 expanded”：点击事件可能先改了状态；必须用打开菜单时记录的 `ctxWasExpanded` / `menuRestore`。
- 字幕高度不能把 `y` 往下夹到 `area.bottom-40`：内容变矮会一路下沉；只允许向上让位。
- 菜单不能固定宽高：中文标签、checkbox、滑条会撑破；先量后扩窗。
- 长按拖动与单击必须分开，否则点一下字幕就被拖走。
- 独占全屏播放器可能盖住字幕，建议无边框全屏；字幕被手动关闭后，下一次状态轮询会重建。
- 陪伴开启时桌宠 `win.hide()`；停止后恢复，不要和「隐藏到托盘」混在一起。
