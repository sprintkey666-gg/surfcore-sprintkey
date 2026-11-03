# 2026-11-03 悬浮窗 / 陪伴字幕：记忆互通 + 字幕窗抖动 + 桌宠换皮 + 看屏幕

## 起因

主人提了三件事：

1. 悬浮窗「会话」和「陪伴模式字幕」跟 QQ 聊天**不是同一个她**，记忆没互通；要求悬浮窗里加「互通 QQ」「互通 B站」两个开关，全开则 会话-字幕-QQ-B站 四者的记忆全通；两种模式都要有「回复速度」。
2. 陪伴模式字幕**一直在闪、位置上下跳**；点「隐藏到后台」桌宠还赖在桌面上。
3. 桌宠没有换皮、待机动作差、眼睛不会看人；设置界面要能下载安装素材。参考 `dsh-pet`（MIT）与 `Coopanion`（AGPL，只参考设计）。

## 根因（逐条，都有代码/日志证据）

### 字幕闪

`assets/orb-app/main.js` 每 3 秒的轮询里**无条件**执行 `setAlwaysOnTop(false)` → `setAlwaysOnTop(true,'screen-saver',1)` → `moveTop()`，并且每次都 `webContents.send('companion:state')`。DWM 每次都要把 `transparent:true` + `backdrop-filter: blur(10px)` 的窗口拆下重合；渲染端每次重推又 `thread.textContent = ''` 全量重建 DOM。

### 字幕跳（永远不会收敛的环）

`setBounds({ width: 738 })` 回读恒为 `740`（无边框窗仍保留 `WS_THICKFRAME` 非客户区，叠加本机 175% 缩放）。`if (b.width !== layout.width)` 于是每 3 秒都判定「不一致」→ 真的改一次宽 → 文本重新折行 → `Math.ceil(scrollHeight + 2)` 高度变 → 底边锚定重算 `y` → 顶边上下漂。日志里 `收回异常窗口` 刷了 11690 次，`[orb] 启动` 只有 107 次。

### 托盘隐藏留残影

`hideWindow()` 只 `win.hide()`，从没碰 `companionWin`。陪伴模式时屏幕上是字幕窗、桌宠早已隐藏，所以「隐藏到后台」看起来没反应；更糟的是轮询里 `if (!isVisible()) showInactive()` 会在 3 秒后把隐藏的窗又拉回来。`showWindow` / `second-instance` 也只看主窗，不看 `companionActive`。

### 桌宠动作/气泡

`pet.js:pickIdleAction()` 只抽 idle+categories+moves，manifest 里 `turn`（东张西望）与 `weights.turn` 从来没生效；`moves` 只播原地动画、窗口从不移动；idle 只有 1 段、134px 下几乎看不出；气泡是 `fitBubble()` 自上而下撑，带图时被裁。

### 看屏幕

`look()` 用 PowerShell 截**整屏**，模型看到一大片桌面，还容易把别的窗口看混。

## 修法

| 区 | 改动 |
| --- | --- |
| 记忆互通 | 新增 `plugins/surfcore/lib/interop.js`（纯函数：钳制/截断/时间窗/拼接顺序）；`pet-chat.js` 的 `memoryBlock()` 改为「身份 → 最近在别处聊了什么 → QQ 卡 → B站 卡」，人设/记忆上限可配 |
| 会话连续性 | 新增 `plugins/surfcore/lib/orb-agent.js`：用 `ctx.sessionController` 开专用会话（`orb-chat-<角色>-<代数>` / `orb-companion-<角色>-<代数>`），收 `turn/end` 最终文本；失败/超时自动退回直连 `llm.stream` |
| 回复速度 | `orb.chat.reply` / `orb.companion.reply` 两套独立参数（`mode=legacy|fast`、`timeoutMs`、`sessionTurns`、`maxTokens`），设置页可达 |
| 记忆/存档数据类型 | 记忆卡 inbox 事件多带 `channel`（`orb`/`companion`/`pet`）→ 标题前缀「悬浮窗 · / 字幕 · / 桌宠 · 」+ tag + `record.channel`；`chat-archive.js` 增 `channelLabel` / `messageType` 两列（`qq-message` / `orb-chat` / `companion-subtitle`），并新增 `readRecentChatRecords()` 只读文件尾部 256KB |
| 字幕窗 | 只在未置顶时补 `setAlwaysOnTop`、`moveTop` 仅首次、状态推送指纹去重；宽度收敛容差 4px、高度 8px 网格对齐；两窗 `thickFrame:false`；`SetWindowPos` 去掉 `SWP_SHOWWINDOW`；隐藏同时收两窗并置 `hiddenByUser` |
| 桌宠 | 新增 `pet-packs.js`（形象包目录/导入/启用/试播）与 `pet-gaze.js`（注视）；`pet.js` 重写（气泡浮层化、turn 入池、真走位 IPC、watchdog、4s 热重载）；`pet.css` 气泡重做 |
| 看屏幕 | `orb-api.js` 先枚举前台窗口（z-order 下探 16 层、跳过自己的窗口），按矩形只截那一个；三档 `preview`/`chat`/`companion`；auto 模式截图失败但有窗口标题时用标题再问一次 |

## 踩过的坑

- `export` 只能写在文件顶层——`src/voice-packs.js` 下半截全在 `createVoicePacks()` 工厂函数体内（见 2026-11-01 案例）。
- 别用 PowerShell 的 `Get-Content` / `Set-Content` 读写这些 UTF-8 源码：本机按 GBK 解会把中文读成乱码、写回就损坏（`plugins/surfcore/package.json` 就被写坏过一次，用 `git checkout --` 恢复）。
- `edit` 偶发 `ReplaceFileW EIO (Win32 1175)`：文件没坏，重试即可。
- `src/memory-card.js` 的 `formatRecentLines()` 返回的是**字符串**，测试里别再 `.join()`。
- `orb-companion.js` 里配置访问器叫 `cfg()`，写成 `const cfg = conf()` 会同时「调用不存在的函数」和「遮蔽后面的调用」，报错只显示 `conf is not defined`。
- 记忆卡的 `platform` 只有 `qq` / `bili` / `all`，桌面这条线走的是 `platform:'pet'` + `channel` 细分；B站 卡的条数上限里 qq 类是 0，所以 `-prompt-bili.md` 天然为空是设计，不是 bug。

## 验证

- 新增测试：`scripts/test-orb-interop.mjs`（24）、`scripts/test-orb-agent.mjs`（17）、`scripts/test-memory-card-channel.mjs`（22）、`scripts/test-chat-archive-recent.mjs`（20）、`scripts/test-orb-window-state.mjs`（28）、`plugins/surfcore/scripts/test-pet-packs.mjs`（8 组）。
- `node scripts/test-audit.mjs` → 92/96（4 个失败在 HEAD 导出版上同样失败，属既有）；插件链 38 项只剩 `test-updates.mjs`、`test-host-smoke.mjs` 失败（同样属既有）。
- 真机：`~/.dsh/surfcore/orb/orb-app.log` 里 `收回异常窗口` 应停刷；托盘「隐藏到后台」两个窗都消失；桌宠右键可换包/试播；面板「眼」截的是当前窗口而不是整屏。
- 插件重载后 `~/.dsh/surfcore/orb/host.json` 的 `pet` 段应带 `gaze` / `wander` / `packId` / `avatar`。
