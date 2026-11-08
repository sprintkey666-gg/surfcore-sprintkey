# Sprintkey 自定义改动日志（CHANGELOG-SPRINTKEY）

这份文件只记 **我们自己** 改的东西；上游每个版本的官方变更见 `CHANGELOG.md`。

- 基线：上游 `v0.6.22`（2026-10-28 第二次合并进 fork）
- 分支：`sprintkey/main`
- 合并前快照标签：`sprintkey-custom-v0.6.17`
- 整包备份：`E:\_backups\surfcore-sprintkey-v0.6.22-*.zip`（每次升级前都打一份）
- 升级手册：**[docs/sprintkey/CUSTOM-FORK-UPGRADE.md](CUSTOM-FORK-UPGRADE.md)** —— 下次升级照它做
- 我们自己的文档区：`docs/sprintkey/`（本日志、升级手册、以后的说明都放这里，不碰上游 `docs/*.md`）

- **2026-11-08 01:00–01:45 · Sprintkey 设置页改成「卡片 → 点开专页」**
  - 9 个页签（model / prompt / memory / voice / cross / tree / tools / limits / api）里平铺的几十行参数，改成每页一排卡片（21 张），点开用 `SprintkeyArea` + `SettingsModal` 在 760px 弹层里改，改完回页面底部「保存」——与 QQ 侧「回复速度」那套完全一致。
  - 修掉 `GET /api/socialV2/persona-preview` 没进插件转发白名单导致的「未放行的社交接口」（`plugins/surfcore/lib/index.js` 的 `SOCIAL_V2_PROXY_GET`）。
  - 修测试坑：`test-pic-auto` / `test-pic-wiring` 写死安静时段 `01:00→07:00` 又用真实时钟，凌晨跑审计必红；改成固定下午时间戳 / 夹具里 `00:00→00:00`（等长即关闭）。
  - 验证：`test-audit` 173/174（唯一 `test-release-manifest` 是「提交后重生成」的老规矩）、插件链 40/42（红项为既有）。

- **2026-11-07 23:10–2026-11-08 00:40 · 唤醒提示词注入方式可切换（card / trim / pointer）**
  - 触发：主人问「怎么新版本比旧版本更消耗 token」。实测同一轮唤醒 7,553 字里人格占 6,978 字（上游 v0.8.9 改成 `personaWakeBlockV2` 直接印整卡），升级前 p50 ≈ 10,839 字、升级后 ≈ 18,083 字（+67%）。
  - 做法：新增 `src/persona-wake-inject.js`（纯组装 + 归一化）；`bridge.js` 每轮现读 `persona.wakeInject` / `persona.wakeTrimChars`，新增只读接口 `GET /api/socialV2/persona-preview`（三档字数 + 最近一次唤醒体量）；Sprintkey 设置页新增「提示词注入」页签（三档下拉 + 缩卡上限 + 实时字数 + 前 300 字预览 + B站简报开关 + 人格注入上限）。
  - 默认仍是 `card`（不悄悄改行为）；`pointer` 与 0.6.22 旧代码**逐字一致**（测试用 `git show pre-sync-0.6.22-sprintkey:src/bridge.js` 对照）；`trim` 是新增折中档，旧版没有。
  - 顺带修：弹窗里 `select.qbw-select` 白底白字（此前只有弹窗内的 `input` 补了底色）。
  - 测试：新增 `scripts/test-prompt-inject-mode.mjs`（已登记进 `scripts/test-audit.mjs`）；`scripts/test-persona-wake-injection.mjs` 加「默认档没被换掉」断言；`plugins/surfcore/scripts/test-client-contract.mjs` 页签清单加 `prompt`。
- **2026-11-06 22:30–23:25 · 私密日记可写真实姓名（`allowPrivateDetails`）**
  - 触发：主人 m07671 发现私密日记里只有「对方」「主人」代称，不像私密日记。
  - 根因不在 prompt：`lifeContext()` 在拼素材时就把发送者硬编码成代称，`buildDiaryPrompt()` 的私密分支其实允许点名。改成 `diarySpeakerLabel()` 按 audience/开关决定标签；`lifeContext()` 新增 `{audience,allowPrivateDetails}` 且**默认 false**，避免签名/空间动态/公开日记走这条时泄露私聊对象。
  - 私密日记默认 `allowPrivateDetails:true`：可写真实姓名、关系、时间地点、金额等，仍禁密码/验证码/完整银行卡/身份证；设置页加「允许写真实姓名和私密细节」开关，关掉退回代称。只影响新日记，不重写旧文。
  - 测试：`scripts/test-self-expression.mjs` 19 项全过；`node --check` diary/bridge/client 通过。

- **2026-11-04 12:30–13:10 · 长气泡不再被屏幕切掉、鼠标划过不再搬走她（orb-app 0.12.22）**
  - 气泡：`orb:bubble-space` 新增「头顶空间不够就整窗往下让一截」——`roomAbove/shift/fitBand`，放不下时把 band 收到屏幕能容下的高度，返回 `shift`/`clipped`；收起时只有「让过位」才还位（`bubbleOriginBottom`/`bubbleShiftApplied`），避免老的一高一缩抖动。`pet.js` 的 `BUBBLE_COLUMN_MAX` 360→400、`BUBBLE_COLUMN_GROWTH_CHARS` 60→30、`GROWTH_SPAN` 100→80，`fitBubble()` 记住 `state.bubbleShift`，`hideBubble()` 只在 `bubbleShift > 0` 时申请复位。真因：她默认贴在屏幕最上沿，`clampForMode()` 的 `minY = area.y - (height - bodyH)` 允许气泡带跑出屏幕，正文被屏幕边缘切掉。
  - 误拖：`mousedown` 严格判 `button/buttons/expanded`；`PET_DRAG_HOLD_MS` 180→320、`DRAG_MIN_PX` 6→10、新增 `PET_DRAG_IDLE_CANCEL_MS = 1200`（按住不动 1.2 秒判「只是按住看」）；`endPetDrag(reason)` 全路径记日志，方便下次从 `orb-app.log` 定位。
  - 测试：`scripts/test-orb.mjs` 67 + 329 项全过（新增「长气泡放不下整窗往下让」「收起要还位」「10px + 320ms」断言）；`test-orb-window-state` 28 项；`test-audit` 93/97（4 个红项仍是既有问题）。
- **2026-11-04 07:40–08:20 · 去掉悬浮小球，只留桌宠（orb-app 0.12.21）**
  - 触发：主人 m04348「去除悬浮窗的悬浮小球，只保留悬浮窗桌宠」。
  - 渲染端：`#ball` 整段删除（index.html），`orb.css` 删球样式与 `@keyframes pulse`，`orb.js` 删球的点击/悬停/滚轮/拖动/转圈/未读点，只留桌宠的 `petDrag`。
  - 主进程：`baseSize()` 恒按桌宠算、`applyBallSize()` 删除、`orb:resize` 变空壳、DOM 自检改问 `#petStage`。
  - 插件侧：`petInfo()` 恒 `mode:'pet'`（素材没装时显示静态形象而不是回落成球），外观页删「形象」与球相关五行滑条，文案统一成「桌宠」。
  - 测试：`test-orb` 329 项、`test-orb-window-state` 28 项、`test-orb-companion` / `test-pet-packs` / `test-orb-activity` / `test-orb-agent` 全绿。

- **2026-11-04 00:05–00:40 · 监测提示改走气泡 / 长按才拖 / 走位不撞墙 / 原版会话改走 DSH HTTP（orb-app 0.12.20）**
  - 触发：主人 m04008 复述——监测提示（「你在用 Word 看…」「在听 …」）那张卡压在她身上、右边和下边被窗口切掉；鼠标靠近还是会搬她；会话/字幕依旧没真的开 DSH 会话；「一走就出大 bug」。
  - 提示卡：`toast()` 在桌宠模式改走 `SurfPet.showBubble()`（复用 `fitBubble()` 的头顶定位与变宽），面板模式才用 `#petToast`。真因是那张卡是桌宠小窗口（181×248）里的固定 DIV，长句必然溢出并被裁。
  - 拖动：加 `PET_DRAG_HOLD_MS = 180`，`mousedown` 记 `armAt`，`mousemove` 未到时间不搬窗口；单击/双击/右键/划过都不动。
  - 走位：`walk()` 先量到屏幕边的余量，`dist = min(随机, 余量-8)`，不再走到屏幕外被夹回。
  - 会话（根因）：`sessionController.prompt` 只认活着的 Agent，DSH 重启后磁盘会话是冷的 → `session/agent-busy: prompt rejected` → 每轮退回直连，`history.agentTurns/agentTotal/agentGen` 永远为空。改成和 QQ 桥接同款 HTTP 链路：`NodeApiClient.sessions.create` → `events.mux` + `follow` → `sessions.prompt` → 收 `turn/end`；失败丢映射、下一轮重建，日志带 `data.reason`。
  - 测试：`scripts/test-orb-agent.mjs` 重写（建档/复用/失败重建/超时/并发 busy/forget + pet-chat 源码断言全绿）；`scripts/test-orb.mjs` 67+328 全过；`test-orb-window-state` 28 项；`test-orb-companion` / `test-pet-packs` 全过。

- **2026-11-03 23:15–23:45 · 气泡压在她身上 / 鼠标靠近就搬她（orb-app 0.12.19）**
  - 触发：主人 m03607–m03609 附截图——气泡是 150px 窄长白卡、每行两三个字，直接压在鲸鱼身上；同时鼠标从她身边划过窗口就跟着光标走。
  - 气泡（三层真因）：① 窗口宽度被锁在「宠物宽 + 40」，气泡只能拿到 ~150px；② `orb:bubble-space` 只认高度 `{px}`、`preload` 还把参数 `Number()` 了一遍，宽度根本申请不到；③ 正文 `max-height` 没扣内边距+描边（实测 39px），超长正文溢出 `.bubbleBody` 压到她身上。
  - 修：主进程 `orb:bubble-space` 改 `{ band, width }`——band 往上长（脚底不动）、width 左右加宽（水平中心不动），`PET_BUBBLE_MAX_W=560` 且不超工作区-24；`preload.bubbleSpace(opts)` 同时认对象与老数字。渲染端 `fitBubble()` 两趟测量（列宽 248→360 渐进、最小 240），`placeBubble()` 底边 `headFromBottom()+10`、正文 `max-height = room - chrome` 内部滚动、`--tail-x` 尾巴指头顶中心。`clampForMode()` 的 bodyH 改用 petSize 推，不再被撑宽的窗口带偏。`bodyRectInWindow()`（穿透判定）与渲染端 `petBodyHit()` 统一成 `bodyH = min(stageH-band, size*1.22)` / `bodyW = min(stageW-24, bodyH*1.6)`。
  - 鼠标靠近就搬（真因）：`orb.js` 的 `let drag` 被小球与 `petStage` mousedown 共用，小球那条 `window mousemove` 直接 `orb.move(drag.wx+dx, …)`，**不看 `ev.buttons`**；`orb:hit` 每帧关穿透 + 90ms 穿透轮询偶尔吞掉 `mouseup`，`drag` 清不掉 → 之后任何 mousemove 都在搬窗口。修：拆 `ballDrag`/`petDrag`，mousemove 先判 `ev.buttons & 1`，6px 阈值后才算拖动，`mouseup`/`blur`/`pointercancel`/`mouseleave`/`visibilitychange`/`Esc` 全收尾，拖动中不弹菜单不触发 click。
  - 顺手：右键屏幕提示 `她看到：…` 缩成 1~2 句（`在用 …` / `在听 …` ≤18 字）。
  - 测试：`test-orb` 67 + 328 项（新增 14 条）、`test-orb-window-state` 28 项；`test-audit` 93/97、插件链 37/39（红项仍是既有 4 + 2 项）。orb-app 0.12.19 已覆盖安装，**需重启 DSH 生效**。

- **2026-11-03 22:20–23:05 · 重影 / 鼠标划过就搬 / 气泡从不冒 / 会话没真的开 / 皮肤只有一套（orb-app 0.12.18）**
  - 触发：主人第二轮投诉「桌宠有重影」「鼠标经过桌宠就会把桌宠移动」「没有气泡」「会话和字幕回复没有真的开一个会话」「我在改文件都没有气泡」「气泡照 big-blue-fish-desktop-pet、皮肤去开源项目扒、菜单与会话界面照 dsh-pet-indesktop」。
  - 会话（真因两层）：`orb-agent.run()` 调 `sessionController.prompt({...})` **没传第二个参数 signal**，DSH 内部无条件 `signal.throwIfAborted()` → 每轮抛 `Cannot read properties of undefined (reading 'throwIfAborted')` → 被 catch 成「退回直连」，`plugin.log` 里只有一行、表面看就是直连回复；且 `bumpAgentTurns` 在 `sessionTurns<=0` 时早退，跑成功也不留痕迹。修：`AbortController` 传 signal，超时先 abort 再 cancel；`agentTurns/agentTotal/agentLastAt/agentLastSession` 永远写盘，达 `every` 才换代；人设只在会话代数首轮整段推，后续只补最新记忆卡（避免堆 N 份人设）。
  - 重影：底色层与动作层同时 `opacity:1`，动作是 alpha 视频 → 透出底下待机。修：动作首帧到达 → 底色 90ms 淡出 → 才亮动作；播完立刻把底色放回；交叉淡入只允许 base A/B；`safePlay()` 串行化并吞 `interrupted by a call to pause`。
  - 鼠标划过就搬：待机池混进了 manifest 的 `moves`。修：待机池剥 move + `moveNames` 名字兜底，`wander.enabled` 默认 false，move 只由「走一走」/45~150s 漫游触发。
  - 气泡不冒：`maybeBubble` 用已读水位 `seenId` 当门，面板一展开就把水位推到最新。修：改 `lastBubbleId` + `lastUserReadAt`，面板展开时延后 600ms 冒、收起补冒；气泡照 bbf `CompanionBubble.cs` 重画（#fffbf4、1.5px #506098、24 圆角、尖角与框体一条连续轮廓、五种场景 + 深色）。
  - 皮肤：`catalog` 同步把内置包落成 `packs/<id>/`（修 `没有这个皮肤包：sprintkey-fish`）；新增 `big-blue-fish`（`github-assets`，codeload 只取 `assets/fish/*.webm`+`animations.json`+LICENSE，MIT/PC2005-cloud）；6 套配色 `tints` 透传到渲染端 `--pet-tint`。
  - 监测→气泡：`onSample` + `createActivityFeed`，`kind:'event'` 伪消息按 `bubbleEveryMs` 节流去重，不进 history/存档/记忆卡；`POST /orb/activity/test`。
  - 菜单与会话界面按 dsh-pet-indesktop 视觉规范重画（七域侧栏 52→200px、22/600 标题、卡片 token、浅/深两套）。
  - 测试：`test-orb` 313 项、`test-pet-packs` 18 项、`test-orb-activity` 21 项、`test-orb-agent` 22 项；`test-audit` 93/97（红项仍是既有 self-identity / identity-guard / token-economy / version）。
  - orb-app 版本 0.12.18 并覆盖安装；**需重启 DSH 生效**。

- **2026-11-03 20:35–21:40 · 暗号答不出（记忆卡渲染）+ 皮肤包 / 互动监测 / 气泡 / 动作闪烁**
  - 触发：主人 m02575「记忆互通没实现，对暗号没答对」「桌宠没有皮肤素材、右键没有切皮肤」「要监测在用什么窗口/在改什么文件/在听什么歌」「气泡不出现且丑」「动作播完闪回初始状态」。
  - 暗号真因（不是互通没接上，是渲染把重要记忆挤掉）：`sectionize()` 把 `owner + isInitial` 归到「最初的日子」，排序是 `createdAt` 升序、QQ 限额 6 条，11-02 定的暗号被 10-28 的老记录挤出注入块；换成 `lastSeenAt` 兜也不行——没进提示词就不会被「想起」，`lastSeenAt` 永远垫底（死循环）。修法：新增「最近很要紧的」段（14 天内、重要度 ≥65、非桌宠来源，按 importance → **createdAt** 排序，默认 6 条，priority 90）；「最初的日子」也改成按重要度排；跨端最近对话窗口 12 行/24 小时 → 30 行/48 小时。真卡复核：QQ 版 1656 字含「示例暗号ABC」，B站 版仍 0 字。
  - 皮肤：`packs/<id>/{pack.json,webm|index.html}` + `packs.json{activePackId}`，`pack.json` v2 带 `kind:'webm'|'figure'`；`handleAction` 支持 list/catalog/detail/publish/install/verify/activate/remove/preview/import(+dir/tgz)，装完自动启用并 `writeHostFile(true)` 热重载；内置清单 dsh-pet（npm 0.4.1，MIT，按需下载）+ sprintkey-fish（随仓 SVG，MIT）；Coopanion（AGPL）只参考设计不搬素材。右键菜单新增「皮肤 ›」（列表/导入文件夹/导入 .tgz/打开皮肤文件夹）。
  - 互动监测：`scripts/activity.ps1`（**纯 ASCII**：PS 5.1 按 ANSI 读无 BOM UTF-8，中文会 ParserError）+ `lib/orb-activity.js`，20s 采样前台窗口/正在编辑的文件/音乐（WinRT 媒体会话）/光标，`GET|POST /orb/activity`，右键「监测 ›」三开关 + 频率 + 现在看一眼；默认 `enabled:false`。
  - 气泡与动作：气泡被自己身上的视频层盖住（`.petStage{isolation:isolate}` + `#bubble{z-index:6}`）；`ensureBand()` 去掉 `headroom>=64` 短路；`hideBubble` 不再缩窗；三层 video（两路 idle 常驻 + 动作层）、切层等 `requestVideoFrameCallback`、动作播完先淡出 200ms 再卸源；气泡改深色卡片 + 尾巴 + 4 行折叠；六道门加 `[bubble] skip reason=…` 日志。
  - orb-app 版本 0.12.17 并覆盖安装到 `~/.dsh/surfcore/orb/app`；需重启 DSH 生效。
  - 测试：新增 `test-memory-card-recent-important`（9 组）、`test-orb-activity`（17 项）、扩充 `test-pet-packs`（13 项）、`test-orb`（67+289 项）；`test-audit` 红项仍是既有 test-self-identity / test-identity-guard / test-version / test-token-economy。
  - 文档：`FEATURES.md` 第 27/28/29 条与文件清单；本日志。

- **2026-11-03 08:30–08:55 · 修 wait 静默吞消息：AI 刚回完、主人立刻接一句，那条会被算成「已经知道」**
  - 触发：主人报「当我在ai回复完后立马回一条，会有大概率ai收不到消息然后一直等待」。
  - 根因：`POST /api/socialV2/wait` 里 `purpose="messages"` 的基线取的是 `st.lastUnreadSeq`（到达水位），而不是 `readThroughSeqV2(st)`（模型已看水位）；候选项又只取 `recentMessages`、不含 `unread`。于是 wait 之前刚到的那条永远不浮现。
  - 修法：两种用途统一按模型已看水位算基线；新增 `waitSeen()` 统一「判到没到 / 取候选项 / 组装 newMessages」；开始等之前先看一次，已有未读立刻带走（静默从消息真实到达时间算）；沉睡前观察加 `backlogArrival` 门，不拿等待前就存在的未读充数。
  - 测试：新增 `scripts/test-wait-catchup.mjs`（4 组）并登记进 `scripts/test-audit.mjs`；`test-qq-model-view`、`test-audit-security-mcp` 仍全绿；`test-audit` = 87/92（红的是既有 test-self-identity / test-identity-guard / test-version，加上别人在途的 test-token-economy 与偶发的 test-character-store）。

- **2026-11-02 19:10–19:40 · 文档补录：回复速度原版/快回复两套参数 + 换会话 0.13.0~0.13.3、日记一文一档与公开日记**
  - 触发：主人要求「把我们最近加的功能，更新写入到 docs/sprintkey」。
  - FEATURES 新增第 22 条：`socialV2.reply.mode` 的 legacy/fast **两套参数互不读取**（批量窗 8000/800 ms、打字 2000~8000/150~500 ms、takeover、`sessionRotate{everyTurns 1~500,idleOnly,inheritTasks,deleteOld}`、`cleanup{keep,days}`）；`POST /api/socialV2/rotate` 手动换会话；0.13.2 当场建新会话且失败回滚、`deleteOld:false` 能回原会话、回复参数热重载；`everyTurns` 上限 200→500；等待工具文案改按 `preSleepWaitMs`。
  - FEATURES 第 11 条（日记）补两条：一文一档（每篇一个文件、每 N 篇一档、最近 5 篇）；公开日记发 QQ 空间（人名可留，钱/账号/证件/联系方式必须清洗）与私密日记只发主人的区别。
  - 只写文档，不改代码；编号接在另一会话的 20/21 之后（本提交里暂时呈现 19→22 的跳号，等它那边提交 20/21 即补齐）。

- **2026-11-02 12:25–12:50 · 发送给主人新增「每次全发 / 只发新增」开关**
  - 触发：主人要求「增加一个开关每次发送把全部记忆文件都发，这样两种发送方式用户可以自定义」。
  - 配置：`socialV2.memoryCardBackup.send.fullArchive`（布尔，默认 `true`）。开 = 每次发全量卡 + 全部聊天存档；关 = 全量卡 + 只有新增/追加过的存档（最多 20 个/次）。
  - `src/memory-backup.js`：`DEFAULT_MEMORY_CARD_BACKUP.send.fullArchive=true`；normalize 接受 `fullArchive!==false`；`runSend()` 按开关分流；全发不按 `archiveSent` 过滤，但仍更新 `archiveSent`，切回增量不重发旧档；文本头写发送模式；返回 `fullArchive`。
  - `plugins/surfcore/lib/client.js`：备份卡新增「每次发送全部记忆文件」开关；状态行显示「发送模式：全部/仅新增」；立即执行 hint 随开关变化。
  - 测试：`scripts/test-memory-backup.mjs` 18 项（新增全发每次带全部、25 个不被 20 截断、全发/增量切换）。
  - 文档：`MEMORY-ARCHIVE.md` 第 6/7/9 节；`FEATURES.md` 第 21 条与文件清单；本日志。
- **2026-11-02 10:00–11:10 · 桌宠/字幕入库 + 隐藏启动 + 去掉 GPT Niang 空白 PowerShell 窗**
  - 触发：主人 m06562 问「AI 回复有没有入库、桌宠/字幕聊天有没有写进私聊存档、类型有没有记录；不要常驻命令窗口，SnowLuma 和插件起来后默认后台读取、快速回复」；随后 m06695 纠正「那个自启窗口不是 SnowLuma，是图片里的 PowerShell」。
  - 定位：启动文件夹的 `GPT Niang Usage.lnk` 以 `powershell.exe` 启动且 `WindowStyle=7`，和同名的隐藏计划任务重复；Windows 11 的 Windows Terminal 默认宿主会把这条快捷方式露成空白控制台。
  - 修复：新增 `E:\聊天日常\fix-gptniang-hidden-startup.ps1`；禁用启动快捷方式（备份到 `backup\gptniang-startup`），把计划任务动作改成 `wscript.exe "...\update-agent\agent-supervisor.vbs"`（VBS 用 `WshShell.Run(...,0,...)` 真隐藏）。实测任务启动后没有可见 PowerShell 窗口。
  - 存档：`src/chat-archive.js` 升 schema 2，新增 `channel`（`qq|desktop-orb|companion`）和 `appendRecord()`；新增 `plugins/surfcore/lib/desktop-archive.js`，把桌宠/悬浮球/字幕的原文写进同一个 private 目录，用 channel 区分。
  - 接线：`pet-chat.chat()` 写用户+AI 两条（`archive:false` 可让内部调用跳过）；`orb.addMessage()` 只补 proactive/system；`orb-companion.publish()/append()` 每条字幕回调 `onMessage`；`orb-api` 把 `archiveMessage` 传给 companion；`index.js` 装配 desktopArchive，并把 `archiveMessage` 传给 petChat/orbChat/orbApi。
  - 启动/回复：`launchSnowLuma()` 的 `.bat` 改为 `wscript` 隐藏启动；新增 `maybeAutoStartSnowLuma()`（5 分钟节流，只起进程不弹控制台）；`socialV2.autoReplyCheckMs` 默认/当前值从 30s 降到 10s。
  - 测试：`test-chat-archive.mjs` 10 项、`test-memory-backup.mjs` 15 项、`test-orb-companion.mjs` 11 项、`test-orb.mjs` 276 项、`test-memory-card.mjs` 28 项、`pet-chat` 全过；`node --check` 全过。
  - 文档：`MEMORY-ARCHIVE.md` 增加 channel/桌宠字幕写入说明；`FEATURES.md` 第 21 条与文件清单；本日志；`PITFALLS.md` 补桌宠/字幕重复写坑。
- **2026-11-03 00:05–00:25 日记调度修正**：`isDiaryDue` 从「上次写入 + N 天」改成「本地日期 + 写作时间点」，凌晨补写不再吞掉当晚 22:00；每天一篇时若昨天整篇没写则立刻补（`catchup`）；`lifeStatus()` 增加 `nextDueAt`。新增 4 组断言（共 15 条），`test-diary-files` 全绿；提交 `f239f69`。
- **2026-11-01 22:15–23:25 · 公开日记（发 QQ 空间）+ 私密日记（只发主人，可写真实的人和事）**
  - 触发：主人原话「添加一个功能公开日记，在开启公开日记后写的公开日记会写出来并发送到qq空间，不会带主人的个人隐私，但是可以有名字代表事件里的人物，群里的事情，由谁发起的，这些人名可以透露。密码 账户 转账等这些不行……添加一个私密日记，私密日记就是发送到主人，所以要把发送到主人的功能进行修改，由于这是发送给主人的，所以可以支持解除隐私保护，让日记真实丰富」。
  - `src/diary.js`：`DEFAULT_DIARY_CONFIG.public`（enabled/dir/everyDays/hour/maxChars 200~2000/perFile 1~50/visibility 1·4·64/maxPerDay 0~10/allowNames）；`diaryPublicBaseDir()`、`diaryPublicCharDir()`（空目录 → `<DSH_HOME>\surfcore\diary-public`）；`buildDiaryPrompt({audience:'owner'|'public', allowNames})` 两套隐私线（owner 可点名，只禁密码/验证码/银行卡/身份证/转账金额；public 可点名，禁钱、账号、证件、手机号、QQ 号、链接、住址，且不许照抄私聊原句）；`scrubPublicText()`（整句删钱/账号/证件/密码类，联系方式就地抠除，返回 `removed` 与 `blocked`）；`publicPublishQuota()`（按本地日期算每天额度）。
  - `src/bridge.js`：`diaryPublicSnapshot()`、`runDiaryPublic({force})`（生成 → `cleanDiaryText` → `scrubPublicText` → 先落盘 → 判 blocked/额度/QQ 在线 → `send_qzone_msg{content, ugc_right: visibility}` → 记 `publicPublishAt/publicLastTid/publicDayCount`，失败存 `publicPending` 第二天补发）、`sendPendingDiaryPublicNow()`；`lifeStatus()` 新增 `publicDiary` 段（含 recent 5 篇、publishedToday、blockedReason、removedKinds）；`lifeTick()` 接两条；路由 `POST /api/socialV2/diary` 新增 `write-public` / `send-public`；配置合并保留 `public` 子对象。
  - `plugins/surfcore/lib/client.js`：原段改名「私密日记 · 只发主人」，顶部说明两本日记分开存分开发；新增「公开日记 · 发到 QQ 空间」整段（启用/保存目录/每几篇一个文件/写作间隔/写作时间/字数上限/可见范围/每天最多发几条/允许写别人名字/状态/立即写/立即发/最近 5 篇）。
  - 测试：新增 `scripts/test-diary-public.mjs` 13 项全过（归一化、两套 prompt、清洗各分支、额度、目录复用），登记进 `test-audit.mjs`；`test-diary-files.mjs` 11 项、`test-self-expression.mjs` 保持绿；`node scripts/test-audit.mjs` 84/88（三红是老问题）。
  - 真机：`POST /api/socialV2/config {"diary":{"public":{...}}}` → `POST /api/socialV2/diary {action:"write-public",force:true}` → 落盘 `<用户目录>\.dsh\surfcore\diary-public\char-mvrnvr2i\2026-11-01_23-15.md`（369 字），`send_qzone_msg` 返回 `tid=bf412b5c7657e76aad340600`，`get_qzone_msg_list` 复核该条在列表首位、正文里出现「主人」「模型二」等人名，未命中任何隐私清洗。
  - 文档：`docs/PITFALLS.md` #131。
- **2026-11-01 22:10–22:55 · 聊天全量存档（私聊/群聊分文件 + 按 MB 滚动 + 随备份发送）**
  - 触发：主人原话「全量记忆卡在插件内是有上限的，到达上限会自动压缩，丢失细节。但我们这个记忆不会自动压缩，而是把聊天记忆全部记着，并且主人私聊和群聊记忆要分开储存……每一条聊天信息要包含时间，类型……当记忆文件超过多少 mb 后，新建新的记忆文件……发送到 qq 和备份目录等也要同步适配」。
  - 新增 `src/chat-archive.js`（ESM）：`DEFAULT_CHAT_ARCHIVE`（enabled=true / maxFileMB=16）、`normalizeChatArchiveConfig()`（1–512MB）、`chatArchiveRoot()`、`listChatArchiveFiles()`、`chatArchiveStatus()`、`classifyType()`、`createChatArchiveWriter()`（`appendIncoming` / `appendOutgoing` / `status`）。
  - 目录：`<备份根>\chat\<角色ID>\private|group\YYYY-MM-DD_0001.jsonl`；私聊/群聊物理分目录；JSONL schema 1 含 `time/kind/conversation/sender/messageId/type/types/text/reply/media`；原文不截断（单条上限 20000 字符），媒体只存元数据；同 `messageId` 内存去重 5000；只追加、不压缩/删除；按文件字节滚动，序号 4 位递增。
  - `src/memory-backup.js`：默认配置加 `archive`；record 加 `archiveSent`（路径→已发字节，最多 500）；新增 `archiveSnapshot()`；`runSend()` 不再强制全量卡存在，发文本头 + 全量卡三件 + 最多 20 个未发送/追加过的存档文件，单文件超 `maxSendMB` 跳过并记 `skipped`；`status()` 返回 `archive` 汇总。
  - `src/bridge.js`：import `defaultBackupDir` 与 `createChatArchiveWriter`；新增 5 秒 mtime 缓存 `liveMemoryBackupConfig()`；`handleIncoming()` 在 `isSessionAllowedInCurrentMode` 后、空文本 return 前写 `appendIncoming()`；`sendMessagesV2()` 成功 `sent` 与 `auditAndSend()` 成功后写 `appendOutgoing()`；配置合并保留 `archive`。
  - `plugins/surfcore/lib/client.js`：备份卡片改「全量记忆卡 + 聊天存档（本地 + QQ）」；新增「启用聊天全量存档」「聊天单文件上限（MB）」；状态行显示私聊/群聊文件数、总字节、单文件上限；发送 hint 改为全量卡 + 未发送存档。
  - 测试：新增 `scripts/test-chat-archive.mjs` 8 项全过；`test-memory-backup.mjs` 扩到 15 项全过（含发送带存档、已发不重发、追加重发、超限跳过）；`node --check` 四个改动文件通过。
  - 文档：新增 `docs/sprintkey/MEMORY-ARCHIVE.md`；更新 `FEATURES.md` 第 21 条与文件清单、`README.md` 索引、本日志。
  - 注意：存档默认开、直接写备份根；`memoryCardBackup.enabled` 仍只控制全量卡镜像；只归档白名单会话；不做历史回填；不改 `memory-card-full` schema。

- **2026-11-01 20:25–21:35 · 日记改成「一文一档」（每篇一个文件 / 每 N 篇一个文件 / 最近 5 篇）**
  - 触发：主人原话「不应该全部存在一个文件里，而是每次生成的日记按时间信息新建文档并写入……但有设置项如支持输入多少个的日记为1个文档，输入5则5个日记为一个文档，第六个日记则要新建文档了。当然如果设置了5个日记为一个文档，则文档的名字也应该是时间跨度命名。保存目录的路径是存放所有日记的地方。并且日记界面最近日记里，可以查看最近的5篇日记」。
  - 为什么会这样：老实现是「每个角色一个 md，所有篇目一直 append」，日子久了文件几万字、翻不动也找不到哪天。
  - `src/diary.js`：新增 `perFile`（1~50，默认 1）、`diaryCharDir()`（`<保存目录>/<角色ID>/`）、`diaryTimeLabel()`（`2026-11-01_21-30`，Windows 文件名不能带冒号）、`parseDiaryFileName()`/`listDiaryFiles()`/`listDiaryEntries()`、`pickDiaryTarget()`、`appendDiaryEntryGrouped()`（追加后把文件重命名成 `起~止.md`）、`migrateLegacyDiary()`（把老的单文件按 `## 标题` 拆开，原文件改成 `.legacy-<ts>.bak`，子目录已有新文件就跳过）。
  - `src/bridge.js`：`diaryStateSnapshot()` 改成返回 `charDir` 不预置 file；`runDiary()` 写之前先迁移、再用 `appendDiaryEntryGrouped`；`sendPendingDiaryNow()` 的兜底改用 `st.lastFile` / 目录最新一篇；`lifeStatus()` 多给 `recent`（最近 5 篇）与 `fileCount`，`preview` 改成最新一篇前 1200 字。
  - `plugins/surfcore/lib/client.js` 的 `DiaryTab`：新增「每几篇一个文件」（1 = 一篇一档；5 = 五篇一档，第 6 篇另起新档，档名带起止时间），「最近日记」改成 5 条列表（标题行带文件名、字数，正文可读）。
  - 测试：新增 `scripts/test-diary-files.mjs`（11 组：默认值、perFile=1/5、同分钟后缀、改小不回改老文件、文件名反解、装满换新、最近 5 篇跨文件倒序、旧文件拆分+备份+幂等），登记进 `scripts/test-audit.mjs`；`test-audit` 84/87（三红仍是 test-self-identity / test-identity-guard / test-version）。
  - 真机：`POST /api/socialV2/diary {action:'write',force:true}` → `2026-11-01_21-30.md`（1089B），老 `char-mvrnvr2i.md` 自动迁成 `.legacy-*.bak` 并在子目录生成 `2026-10-31_19-26.md`。
  - 文档：PITFALLS #129。
- **2026-11-01 16:20–19:20 · 陪伴模式重构 0.12.11–0.12.15（右键菜单 / 字幕几何 / 字号自适应 / 上下文与历史）**
  - 触发：主人驳回第一版陪伴模式——会话顶部按钮不要在 DSH 里、关闭状态不亮；字幕背景透明度可调；拖动/缩放不丝滑且会回弹；记忆要用衰减记忆卡互通；发送不能把 AI 的话换成用户的话；右键菜单加「上下文字幕」（最多 3 条）；按住 Ctrl+Alt 看历史字幕。随后又补三条：菜单仍被裁（要自适应）、左键长按才拖动/单击开收输入框、悬浮窗加字号设置且背景和输入框随字号缩放。
  - 0.12.11：删除 `client.js` 的 `CompanionToggle`、header slot 注入和相关 CSS；开关改到桌宠右键菜单。`orb-companion.js` 加 `opacity=55`、`contextSubtitles=false`、`MESSAGE_LIMIT=200`、`append()`/`threadText()`；`reply()` 不再把用户问题 publish 成当前字幕，prompt 带记忆卡 + 最近 8 条。`orb-api.js` 的 `/companion` 加 `action=config`。字幕高度改底边锚定、只向上让位；宽度到右边左移；拖宽结束才落盘；`ensureCompanionWindow` 优先 `prefs.width`。截图/模型失败只 `degraded` + 退避，不再连续 3 次自动 stop；回复失败发「这条没接上」。发送即清空输入框。
  - 0.12.12：菜单改独立 `menuOpen` 覆盖层，不再改 `displayMode`；`orb:menurect` 先量后扩窗、夹进工作区、返回 dx/dy；补回 `index.html` 里缺失的 `#ctxSize/#ctxSizeRange/#ctxSizeValue`；`fitCtxWindow()` 两阶段布局，菜单外点击只收菜单并按打开时状态恢复。
  - 0.12.13：菜单宽度改 `fit-content` + `max-width` + 纵向滚动，去掉横向滚动条；字幕工具栏加 `A−/A+`；长按约 260ms（或直接移动）才拖动，单击开/收输入框；字号、内边距、输入框、发送按钮改 `em` 自适应。
  - 0.12.14：输入框/发送按钮字号下限提到 12px，避免字号调小后不可读。
  - 0.12.15：打开菜单时记录 `ctxWasExpanded`；关闭菜单/窗口失焦按这个状态恢复，不再读关闭瞬间的 `expanded`，修复“菜单外点一下就打回桌宠”。
  - 文档：新增 `docs/sprintkey/COMPANION.md`，并更新 `FEATURES.md` 第 20 条与文件清单。
  - 验证：`test-orb-companion.mjs` 10 项全过；`scripts/test-orb.mjs` 276 项全过；orb-app 0.12.15 安装并启动。

- **2026-11-01 14:30–15:50 · 陪伴模式（一起看电影）+ 屏幕模式下拉修复**
  - 触发：主人原话「一起看电影时在屏幕底部像字幕一样发感想，字幕可缩放/拖动，点字幕出现输入框回复；桌宠自动隐藏；会话顶部加陪伴开关」，以及「『什么时候可以看屏幕』下拉切换不生效」。
  - 下拉根因：`plugins/surfcore/lib/client.js` 的 `screenMode` 取自运行态 `st.screen`，而 `set()` 只改草稿，受控 select 每次弹回旧值；改为 `draft.screen?.mode || (draft.screen?.enabled ? "manual" : "off")`，select/badge 都跟草稿。
  - 新增 `plugins/surfcore/lib/orb-companion.js`：按间隔（20–180s）截 800px JPEG、SHA-256 相同跳过、每小时最多 1–30 句、模型短评 ≤60 字、SKIP 不显示、连续 3 次失败自停；`reply()` 先截新图再对话。
  - 新增独立透明置顶字幕窗 `plugins/surfcore/assets/orb-app/companion.{html,css,js}`：底部居中、可拖动、Ctrl+滚轮缩放字号、右下角拖宽、点字幕展开输入、Enter 发送、Esc 收起、25 秒淡出。
  - 会话顶部开关：`client.js` 通过 `ctx.slots.inject("conversation.session.header.actions")` 注册「🎬 陪伴」，5 秒轮询 `/orb/companion`，点击 POST start/stop。
  - 桌宠隐藏：`main.js` 的 `syncCompanion()` 在 active 时 `win.hide()`，停止后恢复；字幕只存内存，不写 QQ/群。
  - 置顶坑：DSH 自身置顶会压住字幕，Electron `moveTop()` 不够；必须 Win32 `SetWindowPos(HWND_TOPMOST, SWP_SHOWWINDOW)`。已在 `forceCompanionTopmost()` 里用 PowerShell 调用，并在 `ready-to-show` 后 0.8 秒重试一次。
  - 测试：`plugins/surfcore/scripts/test-orb-companion.mjs` 9 项全过；`node --check` 全部改动文件；orb-app `0.12.9` 安装；API tick/reply、UI 开关、桌宠隐藏均实测。
  - 注意：独占全屏播放器可能盖住字幕，建议用无边框全屏；字幕窗被手动关闭后，下一次状态轮询会重新创建。
  - 回滚：还原 `orb-companion.js`、`client.js` 陪伴段、`orb-api.js`/`index.js` 路由、`main.js`/`preload.js`/`companion.*`，install 回 `0.12.8`。

- **2026-11-01 13:30–13:50 · 文档补录：FEATURES 18.5/18.6 + 19（对齐 0.12.1~0.12.7 与好友申请）**
  - 触发：主人「再次上传项目，我更新了新东西」。
  - 修正 FEATURES 18.5：原写「QQ 近况原文互通（`chat.shareQqRecent`）」，实际已在 `5b79608` 撤掉 → 改为「悬浮窗↔QQ↔B站 记忆三项互通（共用衰减记忆卡）+ 悬浮窗自己的 `orb.chat.shareMemory`」，并注明别再把它加回来。
  - 新增 18.6：0.12.2~0.12.7 的桌宠窗口修复（按身体夹取才拖得到屏幕最上面、按光标位置切穿透否则透明带挡点击、贴左缘停靠公式按 `petMode` 分开算）。
  - 新增 19：好友申请（`src/friend-guard.js` + `bot.onRequest` + `socialV2.friend` + 三个路由 + 两个 MCP 工具 + 设置页卡片），并把边界写清：网关卡没有主动加好友、离线申请补不回来。

- **2026-11-01 10:20–11:00 · 悬浮窗 0.12.0：气泡不再裁切 / 已读不重弹 / 双击看图 / QQ 近况互通**
  - 触发：主人四条验收——面板里长文字被切、收起后又弹、想双击看图放大、问 QQ 近况能不能互通。
  - 面板裁切根因：`.bubbles` 是列向 flex，`.row` 默认 `flex-shrink:1`，内容一高整行被压扁、文字/图片被裁且**不出滚动条**。改 `.bubbles{flex:1;overflow-y:auto;min-height:0}` + `.bubbles > .row{flex:0 0 auto}` + `.bubble{overflow-wrap:anywhere;max-height:none}`，图仍 `object-fit:contain` 等比。
  - 头顶气泡长高：`pet` 窗口原本固定 110px 气泡带。新增 `bubbleBand` + IPC `orb:bubble-space`（clamp 到 `PET_BUBBLE_SPACE` ~ `min(600, workArea.height - petSize - 80)`，只有非 expanded 生效，底边不动向上长），`pet.js` 的 `fitBubble()` 先放开文字限高量自然高度（40ms 防抖，图片 onload 再量一次），`hideBubble()` → `bubbleSpace(0)`，`petBodyHit()` 改用实际 band；`#bubbleText` 的 `max-height` 由 pet.js 按主进程夹回来的带高写内联样式，装不下就省略。
  - 已读不重弹：`lib/orb.js` 状态加 `seenId` + 导出 `markSeen(id)`（取 max、只有变化才落盘）、`clearMessages()` 归零；`orb-api.js` 的 `stateForOrb()` 回 `read.seenId` 并新增 `POST /seen`；`orb.js` 节流 1.2s 上报（`POST /seen`），`maybeBubble()` 要求 `last.id > seenId`。
  - 双击看图：`#viewer` 覆盖层 + `view` 状态；双击 `<img class="pic">` 打开，`requestAnimationFrame` 里算适配缩放并居中；滚轮以**指针为锚点**缩放（`k=Math.exp(-Number(ev.deltaY||0)*0.0015)`，clamp 0.2~8，`tx = px - anchorX*next`）、左键 mousedown/mousemove 拖动、× / 背景 / Esc 关闭；打开期间收起与边缘缩放直接 return。
  - QQ 近况（**已于同日撤销，见下方 11:05 条**）：结论是「长期记忆卡互通、QQ 对话原文不互通」。曾新增 `socialV2.orb.chat.shareQqRecent`（默认开）：`recentQqLines()` 读 `/api/socialV2/recent?key=private:<主人QQ>&limit=12`（45 秒缓存），`pet-chat.chat({qqRecent})` 把【你们刚在 QQ 上聊的】拼进提示词；设置页「悬浮窗 → 聊天记忆」两条开关。
  - 测试：`scripts/test-orb.mjs` 加 `flex:0 0 auto` / `orb:bubble-space` / `fitBubble(` / `markSeen` / `POST /seen` / `seenId` / `#viewer` / `openViewer(` / `shareQqRecent` / 【你们刚在 QQ 上聊的】等契约，252 项全过；`test-audit` 不新增红。
  - 版本与部署：`plugins/surfcore/assets/orb-app/package.json` 0.11.0 → 0.12.0；`node orb-ctl.mjs stop && node orb-ctl.mjs install && node orb-ctl.mjs start`；插件侧改动热重载（`cordis.patch.yml` 加 `- id: surfcore` + `disabled: true` 再还原）。
  - 文档：`docs/PITFALLS.md` #121；`docs/sprintkey/FEATURES.md` 17/18 两节。

- **2026-11-01 10:05–10:40 · 发图：关掉图文一体也不再驳回「配一句话」**
  - 改动：Lead；触发：主人原话「关闭图文一体后表情带文字会被拒绝，那用户直接要求的怎么办」。
  - 结论：开关只该决定「一个气泡还是两个」，不该决定「做不做」。删掉 `send-sticker` 的两个 400（caption 但 `combineText` 关 / `pic` 总开关关）。
  - 新增 `sendTextBubbleV2(key, text, {replyToMessageId, atUserId})`（纯文字气泡）；关着时 `send-sticker` / `send-pic` 先发文字气泡再发表情，响应带 `split:true` 与 `textMessageId`，引用/@ 只挂在文字上。
  - `buildPicPromptLine()` 的「关」分支文案改成「会先发文字、再发表情（两条气泡）；对方明确要『配一句话』就照做，别自己拆两次调用」。
  - 验证：`combineText=false` 真发 → `{"split":true,"textMessageId":-1176293518,"messageId":-1191840513}`，`get_msg` 回读一条只有 text、一条只有 `image{sub_type:1}`；`test-pic-auto` / `test-pic-wiring` 全绿。
  - 提交：`b38e846`；文档 PITFALLS #119 追加。

- **2026-11-01 10:40–10:50 · 文档补录：FEATURES 13~16**
  - 触发：主人「把我们最近加的功能，更新写入到下面路径的文档 <仓库路径>\docs\sprintkey」。
  - 新增四节：13 本地模型2 · 肥鱼 CosyVoice3（音色自动探测 / 三包互斥 / 坑：`expandable_segments`）、14 自动发图（三来源 + 降级链 + 偷图额度 + 生图只能排队）、15 图文同条 + QQ 表情原生发送（`sub_type:1` / `send_custom_face` / CDN 白名单 / 关开关也照做）、16 MCP 三行自愈（`ensureMcpEntries`）。
  - 版本说明：`FEATURES.md` 总表 12 → 16 行，附录补新增文件。

- **2026-11-01 09:20–09:50 · 发图：文字+图片合成一条 + QQ 表情按原生方式发送/收藏**
  - 改动：Lead；触发：主人原话「发图内增加一个功能和设置，第一qq是支持文字和图片在一条消息内的…添加这个功能和开关到发图内，并修复发qq表情包应该是从qq收藏的表情里面选，而不是下载qq表情包到本地，不然就会出现第二张图片那样，发出来的图片特别大。收藏qq表情，也应该是按照qq的流程来收藏」。
  - 巨大图的根因：`sendStickerV2` 把 `entry.url` 下载成 `base64://` 再拼 `{type:'image'}`，**没有 `sub_type`/`summary`**，QQ 当普通图片铺满气泡。
  - 现在：纯表情走 SnowLuma 的 `send_custom_face`（`emoji_id` 取 `entry.resId || entry.id`，不在收藏列表时回退段路径）；必须走图片段时带 `sub_type:1, summary:'[动画表情]'`；URL 只在 QQ 表情 CDN（`p.qpic.cn`/`gchat.qpic.cn`/`multimedia.qq.com`）时才交给网关，其它来源仍旧桥接自己抓字节。
  - 收藏：`collectStickerV2` 优先 `add_custom_face{file: <QQ CDN url>}`（原图直传、动图不丢），失败再回退 base64 字节。
  - 图文同条：`pic.combineText`（默认开）。`sendMessagesV2` 在**最后一条**消息上 `pickPicForCombineV2`（只挑不发）→ `sendMergedTextPicV2`（`[reply][at][text][image]` 一条消息）；这一轮合并发过就不再调 `maybeAutoPicV2`。`send-sticker` 带 caption 的老 400 改成跟着开关走。
  - 记账：抽出 `recordPicSentV2`，自动补图和图文同条共用一份 runtime/pic-log（否则 `perTurnSent`/`sentIds` 各算一套）。
  - 工具：`qq_send_sticker{text}`、`qq_send_pic{text}`；提示词里教模型「一句话配一张图用 qq_send_pic{text}」。
  - 测试：`test-pic-auto.mjs` 加 combineText 6 条；`test-pic-wiring.mjs` 加「合并只发 1 条且段是 [text,image]」「关掉开关回到两条」「纯表情走 send_custom_face」三个夹具，全绿。
  - 文档：PITFALLS #119。

- **2026-10-31 22:45–23:00 · 唱歌修两处：写死的清唱引擎 + 音素表不认多音字**
  - 改动：Lead；触发：主人原话「这根本没有唱完全是念的而且还卡顿，小星星那个才是真唱啊，为什么换个歌就不行了」。
  - 原因一：第一版《反乌托邦》是 `sing-fanyoutopia.mjs` 里写死 `engine: 'syllable'` 跑的 —— 那是逐字清唱（+ §#115 的重试），长句必然念白感、还卡顿；真唱要 `engine: 'svs'`。
  - 原因二：切 svs 后崩在 `KeyError: 'zh_shui2'` —— 「谁」的规范拼音 shui2 不在 `phone_set.json`（只有 `zh_shei2`）。`E:\feiyu-voice\svs\meta_build.py` 新增 `phone_set()` / `_candidates()`（`pinyin(heteronym=True)` 多读法逐个查表），命中即用，全不中报「音素表里没有「X」的任何读法」。
  - 安装缺口：语音包补 `scripts/svs/run_svs.py`、`scripts/svs/meta_build.py`；`fetch-svs.mjs` 加 `ensureScripts()`（缺/旧就拷，`[svs] 92% 推理脚本就绪`），已装包同步。
  - 验证：`谁→zh_shei2`；24 音 svs → 506924B / 10.560s / 24kHz；`send-voice` `messageId 888607926`；`fetch-svs` 幂等「推理脚本复用」，删文件后自动补回且 sha 一致。
  - 注意：`sing-fanyoutopia.mjs` 这类一次性脚本别再写死 engine，默认给 `auto`。
- **2026-10-31 19:45–20:30 · 日记目录选择器：列出 E 盘 + 支持手输路径**
  - 改动人：Lead；触发：主人原话「这个日记的自定义目录，为什么识别不到e盘，而且应该要支持用户自定义目录，点击浏览，支持输入路径」。
  - 原因：原「浏览…」走系统 `FolderBrowserDialog`，在这台机器上只显示 C/D 盘；E 盘本身正常（`Win32_LogicalDisk`、Node `fs` 都能读）。改成插件自绘选择器，不再依赖系统对话框。
  - 后端 `plugins/surfcore/lib/index.js`：新增 `listWindowsDrives()`（A–Z 探测）与 `handleBrowseList()`；`GET /dsh-surfcore/api/browse-list?path=` 返回 `{ok,path,parent,drives,dirs:[{name,path}]}`；空 path 只回盘符；`E:` 自动补 `\`；只列目录、最多 500 个、中文排序；路由在 `/browse` 之后（约 2984 行）。
  - 前端 `plugins/surfcore/lib/client.js`：新增 `DirPicker` 弹层（路径输入 + 前往 / 上一级 / 盘符 / 文件夹 / 取消 / 选择此目录）；`DiaryTab` 的「浏览…」改为打开它，选中后写 `socialV2.diary.dir`；目录输入框仍可手打；保存仍走底部「保存」。
  - 验证：空路径返回 `["C:\\","D:\\","E:\\"]`；`E:\` 能看到「聊天日常」等目录；新增 `plugins/surfcore/scripts/ui-dir-picker.mjs` 做 CDP 全流程，`ALL CHECKS PASS`（E 盘、进入目录、手输 `E:\聊天日常`、选择回填、无页面报错），截图 `plugins/surfcore/docs/ui-dir-picker-*.png`。
  - 注意：目录下文件名为 `<角色ID>.md`；原 `/browse`（系统对话框）保留给其他字段；`index.js` 改动需热重载（`pluginManager/setPluginEnabled`），`client.js` 刷新页面即可。
  - 回滚：撤销 `client.js` 的 `DirPicker` / `DiaryTab` 两段与 `index.js` 的 browse-list 两段。

- **2026-10-31 18:20–19:40 · QQ 签名 / QQ 空间动态 / 日记（三件套）**
  - 改动人：Lead；触发：主人 m01198：QQ 设置里加签名与空间动态，模式四档（自动 + 每 1/3/7 天），自动档要有「温度」、有重要或特殊事情时更想发；新增「日记」，自定义本地路径，默认每 1 天，可发 QQ 但只能发主人。
  - 新增 `src/self-expression.js`：配置归一化（mode off/auto/1d/3d/7d、temperature 0~1、hour 0~23、maxChars、qzone.visibility 1/4/64）、到期判断（固定档 `lastAt + N 天` 且过 hour；auto 20 小时一次；逾期 >24 小时随时补）、提示词与 JSON 决策解析、正文清洗、按角色状态文件。
  - 新增 `src/diary.js`：配置（enabled/dir/everyDays/hour/maxChars/send{enabled,withFile}）、文件 `<dir>/<角色ID>.md`、到期判断、日记提示词、正文清洗、Markdown 追加、尾部预览、状态文件。
  - `src/bridge.js`：import 两个模块；loadConfig 归一化 `socialV2.selfExpression` / `socialV2.diary`；`POST /api/socialV2/config` 深合并 + 归一化；新增 `onebotAction()`（直连 SnowLuma action，Bearer token、20s、校验 status/retcode）；新增生活记录 service：内部会话 `life-agent`（仿黑话学习会话，事件不往 QQ 发）、`runSelfExpression`（签名 `set_self_longnick`；动态 `send_qzone_msg`）、`runDiary` / `sendPendingDiaryNow`（只私聊 `adminIdentity()?.qq || cfg.ownerQQ`，正文转义 + 可选 .md 文件）、60s tick + 启动 20s 补跑；新增 `GET/POST /api/socialV2/self-expression`、`GET/POST /api/socialV2/diary`（action=status/signature/qzone/write/send，force 绕过开关）。
  - `plugins/surfcore/lib/index.js`：代理白名单加两条；`plugins/surfcore/lib/client.js`：QQ 页新增常开卡「QQ 签名 · 空间动态」（两套模式/温度/小时 + 动态可见范围 + 当前/上次/错误 + 立即改签名/立即发动态）；新增「日记」标签页（启用/目录+浏览/间隔/时间/字数/发送/附带 md/状态/立即写/立即发送/刷新/预览，顶部写明只发主人）；TABS 与 renderTab 同步。
  - 默认值：全部关闭（`mode=off`、`diary.enabled=false`），保存后约 1 分钟生效（桥接每 tick 读盘），不用重启桥接。
  - 验证：`scripts/test-self-expression.mjs` 16 项全过；`node --check` 全过；真实外发——签名改成「话多了嫌我烧钱…」并用 `get_stranger_info` 回读 `long_nick`；空间动态 223 字、tid `bf412b5c9ed2e56ac08a0d00`（测试时 visibility=64，`get_qzone_msg_list` 回读 `is_private:true`，之后恢复 4）；日记私聊 123456789，19:37:00 正文 + 19:37:02 `char-mvrnvr2i.md`；UI `ui-self-expression.mjs` 全过，截图 `ui-self-expression-qq.png` / `-diary.png`。
  - 注意：「温度」只能做 prompt 层的表达欲/冲动度（DSH session prompt 不暴露采样 temperature）；签名测试文本、空间动态私密测试帖尚未清理。

- **2026-10-31 17:05–18:10 · 全量记忆卡备份（本地镜像 + 定时 + 私聊主人）**
  - 改动人：Lead；触发：主人 m00629：记忆页加全量记忆卡备份（总开关、指定路径）、按天数定时同步、关机错过下次启动补一次、把备份发主人 QQ（默认 7 天、只主人）。
  - 新增 `src/memory-backup.js`：配置归一化、目录解析（默认 `<DSH_HOME>\surfcore\memory-backups\<角色ID>`）、到期判断、jsonl 增量续写（目标更大则整份重写）、md/stats 临时文件 + rename、状态文件 `<DSH_HOME>\surfcore\memory-card-backup.json`、service（备份失败 10 分钟重试；发送失败 30 分钟；QQ 离线不推进 lastSendAt；超 maxSendMB 拒发）。
  - `src/bridge.js`：import、loadConfig 归一化、POST config 深合并、service、`GET/POST /api/socialV2/memory-card-backup`（action=backup/send/both）、60s tick + 15s 补跑；`plugins/surfcore/lib/index.js` 白名单加该接口；`client.js` 记忆页第二张卡「全量记忆卡备份（本地 + QQ）」。
  - 配置：`socialV2.memoryCardBackup = {enabled:false,dir:"",syncEveryDays:1,send:{enabled:false,everyDays:7,maxSendMB:90}}`；默认全关。
  - 验证：`scripts/test-memory-backup.mjs` 13 项；真实手动备份 560341B，三文件 SHA-256 与源一致；GET 状态、桥接重启；UI `ui-sprintkey.mjs` 全过。
  - 注意：备份目录留空用默认；发送只认 `admin.qq` / `ownerQQ`，不发群；第一次打开「发送到主人 QQ」会因无历史先发一次。

- **2026-10-31 16:05–16:35 · Sprintkey 设置页改成「一页一个子设置」**
  - 改动人：Lead；触发：主人截图 + 原话「优化这个插件的sprintkey扩展插件界面设计…一个子设置为一个界面，这样看起来更舒服」。
  - `plugins/surfcore/lib/client.js`：新增 `.qbw-subtabs` / `.qbw-subtab` pill 样式、`SubTabs`、`SPRINTKEY_PAGES` 8 项；`Section` 支持 `hidden`；SprintkeyTab 接收 page/setPage；8 个 Section 改成 `collapsible:false` + hidden；记忆页重复的跨会话开关改成「去『跨会话共享』」按钮；父组件 `sprintkeyPage`；导出 `SPRINTKEY_PAGES`。
  - 页签：模型与思考 / 记忆 / 声线 / 跨会话共享 / 世界树 / 工具投递 / 投递上限 / 投递接口；切页滚回顶部。
  - 验证：`test-client-contract.mjs` 增断言；新增 `plugins/surfcore/scripts/ui-sprintkey.mjs`（8 页、草稿跨页、撤销、顶层切换、780px、焦点）全过；截图 `ui-sprintkey-*.png`。
  - 注意：`.qbw-subtab.on` 用中性 `rgba(127,127,127,.16)` 底，别用 brand 变量（深色主题下会解析成白底白字）。

- **2026-10-31 15:00–16:40 真 SVS 装上了：本地模型2 现在能「按谱真唱」**
  - 新增独立环境 `E:\feiyu-voice\svsvenv`（torch 2.2.0+cu121）+ `E:\feiyu-voice\svs\SoulX-Singer`（模型 2.69GB，sha256 校验）。
  - 新增 `E:\feiyu-voice\svs\meta_build.py`（歌词/简谱 → SoulX metadata，音素走 pypinyin）与 `run_svs.py`（自造对齐 prompt + 推理），支持 `--items-json` 直接吃桥接的逐字计划。
  - `adapter_server.py`：新增 `GET /v1/capabilities` 的 `singing.svs` 探测、`POST /v1/singing` 的 `engine: auto|svs|syllable`、SVS 子进程失败自动回落清唱（`X-Svs-Fallback`）。
  - `src/voice-tts.js`：`synthesizeSongToFile` 支持 engine、缓存 key 含 engine、命中缓存用 sidecar `<wav>.meta.json` 还原引擎信息。
  - `src/bridge.js`：`synthesizeSongText` 透传 engine（svs 超时抬到 15 分钟）、`/api/socialV2/sing` 与 `/api/voice/sing-test` 收 engine 并回 `svsFallback`、唤醒提示按「适配器真实能力」告诉模型现在是真唱还是清唱。
  - `src/mcp-snowluma-safe.js`：`qq_send_song` 新增 `engine` 参数，超时 15 分钟。
  - 设置页「语音 → 唱歌」新增「唱法」下拉（自动 / 真 SVS / 逐字清唱），试唱结果会标「真 SVS」或「逐字清唱」，回落时显示原因。
  - 实测：`/v1/singing engine=svs` 3.08 秒、`X-Engine: svs`；桥接 `/api/voice/sing-test engine=auto` 60 秒出 3.08 秒真唱；SVS 版《小星星》已发到主人私聊（`messageId 781379929`）。

- **2026-10-31 16:50–17:20 本地模型2 首次安装一次装全（含唱歌）**
  - `src/voice-packs.js`：`voice-feiyu` 的 `postInstall` 改成四步（fetch-models → fetch-svs → bootstrap-env → verify-pack），新增 `postInstallWeights: [55,18,22,5]` 与 `minFreeBytes: 22GB`；install 里按权重摊 90→99 的进度、唱歌那步超时放宽到 150 分钟、开始前用 `fsp.statfs` 判磁盘。
  - 语音包新增 `scripts/fetch-svs.mjs`（下 SoulX-Singer 仓库 + 2.69GB 权重，sha256 校验、`curl -C -` 续传、幂等跳过）与 `scripts/verify-pack.mjs`（六项自检：模型清单/说话权重/音色参考/说话 venv/唱歌代码/唱歌权重）。
  - `scripts/bootstrap-env.mjs`：新增 `ensureSvsEnv()`，按需创建 `svsvenv`（numpy<2 / librosa 0.11 / transformers 4.41.2 / accelerate / soundfile / scipy / pypinyin + torch 2.2.0+cu121，失败退 CPU），失败不影响说话。
  - `adapter_server.py`：SVS 路径改成相对包目录（`PACK_ROOT/svs`、`PACK_ROOT/svsvenv`），不再写死开发机路径。
  - `scripts/test-voice-packs-default.mjs`：新增「首次安装要一次装全」一节（四步齐全、顺序、权重与步骤一一对应、磁盘下限）。
  - 实测：`verify-pack.mjs` 六项全 ✓；`fetch-svs.mjs` 幂等复用（权重 sha256 校验通过）；重启适配器后 `/v1/capabilities` 仍报 `singing.svs=true`，`POST /v1/singing engine=auto` 出 `X-Engine: svs` / 3080ms / 147884B。

- **2026-10-31 17:23–17:45 桥接启动自检：DSH 补丁缺 MCP 三条就自动补回**
  - 新增 `src/mcp-patch.js`：`ensureMcpEntries()` 按**原文**解析判定缺哪条（不能先剥托管块，否则永远「全缺」）、块不在时只补缺的（避免 snowluma 插两份）、写前备份 `cordis.patch.yml.bak-mcp-selfheal-<ISO>`、写后 `yaml.load` 校验三条 id 齐才落盘；`resolveProfileDir()` 按「有 qq-bridge MCP 痕迹 + 有 dsh-mcp-client + package.json 含 surfcore」打分挑 profile。
  - `src/bridge.js`：`main()` 里 `const cfg = loadConfig()` 之后调用一次自检，changed 时日志写「补丁里缺了 MCP 条目（…），已补回…（备份 …）」+「需要重启 DSH 才会拉起新进程」；异常只记日志不拦启动。
  - 新增 `scripts/test-mcp-patch.mjs`（8 组）：全缺补 3 条并保留用户条目、幂等、部分缺只补 2 条且不重复、坏 YAML 不写、BOM/CRLF 能修、dryRun 不写、profile 打分、`stripMcpBlock` 不吞前后条目；已登记进 `scripts/test-audit.mjs`。
  - 端到端实测：备份真实补丁 → 剥掉托管块（3086→2189 字节）→ 重启桥接（pid 3100 → 2496）→ 日志 `[mcp] 补丁里缺了 MCP 条目（mcp-snowluma, mcp-snowluma-host, mcp-web-search-safe），已补回` → 补丁 3432 字节、`yaml.load` 10 条目、三条 id 齐、`toolCallTimeoutMs` 仍 725000。
  - 坑记在 `docs/PITFALLS.md` #111（含「杀错进程等于没重启」：`node.exe` 的 `CommandLine` 可能为空，要按 `*src/bridge.js*` 找）。

## 改动人代号

| 代号 | 含义 |
| --- | --- |
| 主人 | QQ 123456789（提需求、拍板、验收） |
| Lead | DSH 里的 lead 智能体（实际动手改代码、跑验证） |
| 上游 | Mieksido（GitHub 上游作者） |

## 关于时间与提交

2026-10-28 12:00–16:50 之间陆续做的改动，为了「先立基线、再合并上游」统一在 16:57–16:58 补提交（跑验证用的是当时的真实文件）。
下表每条都给出 **实际改动时间**（有备份目录时间戳 / 桥接日志可查）和对应的 **git 提交**。

---

---

## 2026-10-31 13:40–14:30 · 本地模型2 会唱歌（逐字合成 + 简谱变调）

- 改动人：Lead（计划经 `exit_plan_mode` 批准：A 清唱 + B 真 SVS + 首次安装装全）。
- 触发原因：主人原话「为什么我叫ai调用，回复只给了说话接口，无法唱歌，明明参考项目里两个模型都可以唱歌啊」。
- 查清的事实：参考项目「唱歌」是**第三个可选引擎 SVS（SoulX-Singer）→ RVC**，不是两个自带模型；本项目 `INSTALL_AGENT.md:321` 也写着「用户没给对齐参考时只交付 TTS/RVC，不把唱歌显示为可用」。
- 本轮交付（A 阶段，能唱、但没有真 SVS）：
  - `src/sing-notes.js`：简谱解析（1-7 / 0 休止 / `#` `b` / `'` `,` 八度 / 音名 / `_` 延长前字）+ 五声兜底 + 逐字计划。
  - `<仓库路径>\state\voice-packs\voice-feiyu\adapter_server.py`：`POST /v1/singing`、`GET /v1/capabilities`；逐字合成 → ffmpeg 变调不改时长 → 卡拍长 + 淡出 → 交叉淡化拼接；单字炸 hift 时按「加尾音呀/啊 → 纯啊」三档回退。
  - `src/voice-tts.js`：`synthesizeSongToFile()`（缓存 `song-<sha1>.wav`）。
  - `src/bridge.js`：`synthesizeSongText()`、`POST /api/socialV2/sing`（AI 真发）、`POST /api/voice/sing-test`（设置页试唱，只回 wav 不发 QQ）、唤醒提示 `singLine`。
  - `src/mcp-snowluma-safe.js`：`qq_send_song`（TOOL_CONFIG_FLAGS 复用 `sendVoice`）。
  - `plugins/surfcore/lib/client.js`：语音页「唱歌（本地模型2 专属）」——歌词 / 简谱 / 节奏 / 音色 / 试唱（浏览器直接放）。
- 验证：adapter `/v1/singing` 7 字 3400ms；桥接 `/api/socialV2/sing` `messageId -688664730`；设置页试唱「3.0 秒 · 7 字 · tts-syllable」；MCP `qq_send_song` `messageId -1741734812` 真发到私聊；`test-audit` 78/82（新增 `test-sing-notes` / `test-voice-sing-wiring`）。
- 配置变更：`socialV2.voice.enabled=true`、`voice.tts.enabled=true`、`route='feiyu'`、`speaker='cute'`、`tools.sendVoice=true`（改 config.json 后重启桥接；没有对应 HTTP 开关路由）。
- 未做：B 阶段真 SVS（2.69GB 权重 + 人工校正对齐 prompt + FeiyuVoice-RVC 权重）；首次安装「一次装全」+ 加权进度（主人 m02072 要求）。

---

## 2026-10-31 12:00–12:45 · 发图降级链 + 「偷图」收藏开关

- 改动人：Lead（计划 v2 经 `exit_plan_mode` 批准）。
- 触发原因：主人两条原话——「如果qq表情包里没有能匹配的图，他就不发，我们应该这样做，如果没有则走本地图库，看有没有，没有就走生图，当然上面的情况是在本地图库和生图开着的情况，如果只开了qq表情包其本地和现场生图没开，又检索不到对应表情，则折中让ai自己挑一张喜欢的发」；「其次发图增加一个表情包收藏开关，让ai自己选择表情包是否值得收藏，喜不喜欢，喜欢就收藏到qq表情包」。
- 改动：
  1. `src/pic-auto.js`：`sources.sticker.looseFallback`（默认 true）+ `normalizePicConfig` 同步；新增 `picFallbackChain(cfg,{available,first})`（按 sticker→local→generate 过滤开关与可用性，决策挑中的那路插到最前）；新增 `pickStickerLoose(entries,{exclude})`（按 `useCount` 取常用前 3 随机，避开最近发过的）；`buildPicPromptLine` 增【该补图了】pending 段。
  2. `src/sticker-lib.js`：`DEFAULT_COLLECT_TASTE` + `buildCollectPromptLine(collectCfg)`（【偷图】块：工具名/参数、口味、每日额度）。
  3. `src/bridge.js`：`picDayKey`（本地日期，不能用 UTC）、`queuePicGenerateV2`（30 分钟防抖、按 `maxPerDay` 计日额度、写 `st.pendingPicGenerate`、`scheduleWakeV2(key,'pic')`、记 pic-log）；`maybeAutoPicV2` 改走降级链（`available.generate` 不再硬编码 false），全落空写 `rt.lastSkip`；`WAKE_PRIORITY.pic=15`、`TIMER_WAKE_REASONS` 加 `pic`；唤醒提示注入 `collectLine` 与 pending；`collect-sticker` 加每日上限（429）；`pic-status` 增 `pendingGenerate/generateDayCount/lastSkip/lastError/collect`；`pic-config` 同时收 `collect{enabled,maxPerDay,taste}` 白名单；`send-pic` 改成同一套链（dryRun 也返回 `order/looseAllowed`）；`send-media` 发 image 成功后清 pending。
  4. `plugins/surfcore/lib/client.js`：发图 tab 增「挑不到就随手发一张」、「收藏 · 偷图」段（开关/每日上限/口味/今日已收）、总览增 pending 与 lastSkip/lastError 提示、试发结果标出降级与随手挑、最近记录标注来源与降级路径。
  5. 测试：`scripts/test-pic-auto.mjs` 增 12–15 组（降级链/随手挑/pending/偷图提示）；`scripts/test-pic-wiring.mjs` 增第二个夹具（只剩生图时排队 + 防抖）。
- 验证：`node --check` 全过；`send-pic dryRun` 返回 `order:["sticker"] looseAllowed:true`；真发降级 `fallback:"sticker->local"`（`messageId 1011504866`）；随手挑 `loose:true`（`messageId -1605775248`）；只留生图返回 `{queued:true,prompt:"黑发双马尾少女…"} ` 且 `pic-status.pendingGenerate` 有值、`generateDayCount=1`；`collect` 配置往返正确；CDP 截图确认「收藏 · 偷图」段与随手发开关；`test-audit` 76/79（三个既有红不变）。
- 未验 / 遗留：收藏的**每日上限 429** 只做了代码路径与单元级推理，没真去偷第 N 张撞上限（要真实消息 id）；自动发图的端到端仍靠群里自然触发。
- 回滚：`git revert <commit>`；设置页关「开启自动发图」/「允许自己收藏表情」即可分别停用两半功能。

## 2026-10-31 09:25–10:20 · 自动发图（QQ 表情 / 本地图库 / 现场生图 + 「发图」设置页）


- 改动人：Lead（计划 v2 经主人 m00742「那就按你这样来」批准）。
- 触发原因：主人原话——「我需要在我们的插件里实现一个发图功能，能根据当时聊天的情景，自动调用生图插件dsh-image-gen，或者发qq表情包，或者本地指定图库……并在插件设置界面创建发图设置界面。相关发图设置项设计参考 dsh-daily-schedule」。
- 改动：
  1. 新增 `src/pic-auto.js`（纯决策层，无 IO）：`decidePicSource` 按「安静时段 → 暂停 → 正事话题 → 情绪池 → 节奏（每轮/每小时/最小间隔）→ 三来源权重」的顺序判断，返回 `{source,weight,reason}` 或 null（= 这次不发）；另有 `pickStickerFor`、`listLocalImages`/`pickLocalImage`、`buildImagePrompt`（温度三档 + 风格词）、`buildPicPromptLine`（唤醒提示【发图】块）。
  2. `src/bridge.js`：默认配置 `socialV2.pic`；`maybeAutoPicV2` 挂在 `sendMessagesV2` 末尾（**不 await**，发图慢不能拖文字），90 秒窗口算「本轮」；`sendLocalImageV2` 走 base64 段真发本地图；失败原因写进 runtime 的 `lastError`（否则「开了没效果」永远查不出）；新增 4 条路由 `GET /pic-status`、`POST /pic-config`、`POST /pic-pause`、`POST /send-pic`（source=auto/sticker/local/generate，generate 只回 prompt 让 agent 自己调 `generate_image`）。
  3. `src/mcp-snowluma-safe.js`：新增工具 `qq_send_pic`（`TOOL_CONFIG_FLAGS.sendPic`）。
  4. `plugins/surfcore/lib/client.js`：新增「发图」tab（总览/节奏/三来源/什么时候发 19 个情绪/安全五段，除「安全」外默认展开）。
  5. `plugins/surfcore/lib/index.js`：社交代理白名单加 pic 四条；**修了两个既有 bug**（见 PITFALLS #104）：白名单形态不匹配、转发漏 `/api`。
  6. 测试：新增 `scripts/test-pic-auto.mjs`（决策层 11 组）、`scripts/test-pic-wiring.mjs`（真实 bridge.js + 夹具网关：决策→真发 image 段→记账→三道闸）；`scripts/audit-bridge-harness.mjs` 把 `sticker-semantics` 与 pic 运行时函数加进沙箱。
- 验证：`node --check` bridge/mcp/client/index 全过；桥接真发过两路（表情 `messageId 472829849`、本地图 `-1027155549`，都落 pic-log）；`pic-status`/`pic-config`/`send-pic` 三个接口实测；设置页「发图」tab 用 CDP 截图看过（素材数 4 张表情、最近发的图两条、三来源与情绪池都渲染正常）；`test-audit` 76/79（三个既有红不变），比改前多 2 个脚本 2 个通过。
- 未验 / 遗留：**没走通「真实群聊里自动补图」的端到端**（手动 wake 那次模型判断没新消息直接收尾）；生图那一路仍然是「桥接算 prompt、agent 生图」，桥接进程没有生图入口（`dsh-image-gen` 不暴露 HTTP 也不 export 生成函数）。
- 回滚：`git revert <commit>`；设置页关掉「开启自动发图」即可立刻停手（配置 `socialV2.pic.enabled=false`）。

## 2026-10-30 23:35–00:05 · 本地模型2（肥鱼 CosyVoice3，cute/gentle 双音色）

- 改动人：Lead（替主人动手）；触发：主人贴 `https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice`，说「这个项目里有两种模型，我们都需要」，要做成第二个本地语音包、能自动认音色。
- 改动：
  1. `src/voice-packs.js`：`DEFAULT_MANIFESTS` 新增 `voice-feiyu`（8766、`run.bat`/`stop.bat`、`postInstall` 拉模型+建环境、`verifyDirs:['models']`、`voiceDir` 指向 `references`）；新增 `detectVoices()` 按 `references/*.wav` 自动生成 `voices`（`cute` →「肥鱼（可爱）」）；`install()` 的 route 映射加 `feiyu` 并在首次写入 `speaker='cute'`；`test()` 合成时带 `voice`。
  2. `src/bridge.js`：tts route 白名单加 `feiyu`、`endpoints.feiyu` 默认 `http://127.0.0.1:8766`、新增 `speaker`；`synthesizeVoiceText` 在 route=feiyu 时把 `speaker` 当 voice 传下去，并把超时抬到 ≥180 秒（模型首次加载 60~90 秒）；`/api/voice/rules` GET/POST 增 `speaker`。
  3. `plugins/surfcore/lib/client.js`：语音包卡片显示「音色（自动检测 N 种）」标签；运行中且多音色时给「默认音色」下拉（选中即写 rules 并切 route）；「使用」区单选从写死两个改成按 `packs` 动态生成（本地模型1 / 本地模型2 / 云端）；新增「语音合成服务」块（走哪个服务 + 肥鱼音色）。
  4. `scripts/test-voice-packs-default.mjs`：补 voice-feiyu 的期望路径与 8766 端口；「至少一个音色」放宽成「有静态音色或有 voiceDir」。
  5. 语音包本体（`E:\voice\packages\voice-feiyu`，不在本仓库）：`adapter_server.py`（常驻 AutoModel，`GET /v1/voices`、`POST /v1/speak/file`，端口先起/模型后台加载/OOM 退 CPU/内置 torchaudio shim）、`scripts/fetch-models.mjs`（curl 单流 + sha256 幂等）、`scripts/bootstrap-env.mjs`（建 venv、装 torch cu128、下 CosyVoice 源码）、`run.bat`/`stop.bat`、`config.example.toml`。
  6. 本机接法：三个 junction 把 `E:\feiyu-voice` 的模型/venv/源码接进 `state/voice-packs/voice-feiyu`，不重下 12GB。
- 验证：`node --check` voice-packs/bridge/client 全过；8766 起停 5 秒通、加载 44~48 秒（cuda，峰值 4.45GB）；`/v1/voices` 2 个音色；cute 5.16s / gentle 5.48s / 切回 cute 1.44s；桥接 `/api/voice/packs/test` 6.32s、`/api/voice/send` dryRun 3.0s；相关 5 个测试全绿，`test-audit` 74/77（与基线相同的三个既有红）。
- 未验：QQ 真机投递（SnowLuma 3000 整晚未起）；设置页三个新块没在浏览器里看过。
- 回滚：`git revert <commit>`；服务用设置页「停止」或杀 8766。

## 2026-10-30 13:40 · 声线统一 v7（对答样本 + 末尾 gate + 主动路径）

- 改动人：Lead（替主人动手）；触发：主人说「为什么感觉还是不一样」——v6 声音写了但没用。
- 改动：
  1. `src/voice-profile.js`：新增对答样本（minePair / minePairsFromMessages / listPairs / pickPairs / renderPairSamples）、`qualityFactor`（事务回执 ×0.3）、`renderVoiceTail`（末尾三行 gate）、`buildVoiceLines` 增 tail/pairs；DEFAULT_VOICE_CONFIG 增 `pairs/tail/tailGroupOnly`。
  2. `src/bridge.js`：`buildWakePromptV2` 改名 `buildWakePromptV2Core`，外层 wrapper 把 tail 拼在整段最后；新增 `withVoiceTail` 并接进 probe / exit / proactive 三条主动路径；autoMine 后加对答样本挖掘（每 key 5 分钟节流）；新增 `GET /api/socialV2/voice/preview` 与 `GET /api/socialV2/prompt-preview`（落盘 `state/prompt-dump/<key>.txt`，令牌脱敏）；voice GET 返回 `pairs`。
  3. `plugins/surfcore/lib/index.js`：代理白名单加两条 preview。
  4. `plugins/surfcore/lib/client.js`：声线区新增三个开关（对答样本 / 末尾 gate / 仅群聊）、「看声线」「导出整段 prompt」两个按钮。
  5. `src/mcp-snowluma-safe.js`：`qq_voice_query` 增对答条数与前两组。
  6. 测试：`scripts/test-voice-profile.mjs` 36 项、新 `scripts/test-prompt-voice.mjs` 17 项；`scripts/audit-bridge-harness.mjs` 补 voice-profile 进沙箱（否则 e2e 66/77）。
- 验证：`node --check` 四个文件 0；审计 74/77（既有 3 失败：self-identity / identity-guard / version）。
- 回滚：`git revert <commit>`；voice-profile 里 `pairs/tail` 可直接关（设置卡开关）。

## 2026-10-30 12:20–12:50｜v6 声线档案：群聊和私聊像同一个人

- **实际改动时间**：2026-10-30 12:20–12:50（Asia/Shanghai）
- **改动人**：Lead（需求由主人提出）
- **触发原因**：主人原话——「明明在私聊里和我对话很像人，语感也很符合，也能记住我的要求，但是一旦在群聊回答就很AI味道就像换了一个人……看看有没有什么解决办法参考b站和开源项目」。
- **根因**：`buildWakePromptV2` 的 base 只带一行【当前角色】名字，人设卡的「说话方式」整节不进每轮 prompt（要靠模型自己调 qq_get_prompt）；私聊因为历史长、上下文里全是真人味，所以还像人；群聊每轮规则多、声线缺位，就退化成客服腔。
- **改动**：新增 `src/voice-profile.js`（声线档案：从角色卡抽「说话方式」锚 + 从本角色自己发过的原话挖样本 + 打分衰减 + 字数预算渲染【说话方式·这就是你】/【私下说话的节奏】）；`src/bridge.js` 接默认配置 `socialV2.voiceProfile`、`voiceConfig()`、`voiceLinesFor()`、`buildWakePromptV2` 注入 voiceLine（紧跟角色名）与 voiceAnchorLine（群聊额外），并在 `recordSentMessagesV2` 里 autoMine 挖样本；新增 HTTP `GET/POST /api/socialV2/voice`（状态/启用/手动补一句/删样本）；插件代理白名单放行；设置卡 Sprintkey 分区新增「声线（群聊/私聊同一个人）」；新增 MCP 工具 `qq_voice_query` / `qq_voice_note`。
- **文件**：新增 `src/voice-profile.js`、`scripts/test-voice-profile.mjs`；改 `src/bridge.js`、`plugins/surfcore/lib/client.js`、`plugins/surfcore/lib/index.js`、`src/mcp-snowluma-safe.js`
- **验证**：`node --check` 四个文件均 0；`node scripts/test-voice-profile.mjs` 25 项全过；从历史挖到 110 条 isSelf 样本（chars 1202）；桥接重启后 `GET /api/socialV2/voice` 返回 `enabled:true, total:110`；模拟注入：群聊带硬规则 + 角色卡说话方式 + 4 条私下节奏，私聊 788 字。
- **回滚**：`git revert <commit>`；或把 `config.json` 的 `socialV2.voiceProfile.enabled` 置 false（只关注入，不动档案）。

## 2026-10-29 14:00 B站分享方式扩到 7 种：三通道任意组合，同一次分享只占一次额度

- **实际改动时间**：2026-10-29 13:40–14:05
- **改动人**：Lead（受主人 QQ 123456789 指派，m05123 提出，计划批准后执行）
- **触发原因**：主人要求分享方式从 3 种扩到 7 种 —— 三个都开（私信+动态+评论区@）、私信+动态、动态+评论、私信+评论，并明确「如果你选择了私信+动态和评论区，这三条都关注里，属于一次分享，不要分三次记账」。
- **备份**：`<用户目录>\.dsh\_backups\` 下 `store.js` / `quota.mjs` / `quota-gate.mjs` / `dm.mjs` / `comment.mjs` / `share-dynamic.mjs` / `bili-share-scheduler.js` / `client.js` 各一份 `.20261029-1344.bak`
- **文件与改动**：
  - `plugins/surfcore/lib/store.js`：`share.via` 白名单从 3 值扩到 7 值（`SHARE_VIA_COMBOS`），默认仍是 `dynamic`
  - `plugins/surfcore/lib/client.js`：分享方式下拉 3 项 → 7 项（文案含「三个都开」）
  - `plugins/surfcore/tools/commands/quota.mjs`：`check/record` 支持 `--batch <批号>` —— 同批号只占一次额度、只记一条账
  - `plugins/surfcore/tools/lib/quota-gate.mjs`、`commands/dm.mjs`、`commands/comment.mjs`、`commands/share-dynamic.mjs`：全链路透传 `--batch`；dm.mjs 补上 `share.enabled === false` 的拒绝（作为分享手段时）
  - `src/bili-share-scheduler.js`：`buildSharePrompt` 按 `share.via` 生成对应步骤（私信/动态/评论各一条），多通道时附同一个 `--batch` 批号；`createBiliShareScheduler` 增 `getShareVia`
  - `src/bridge.js`：实例化调度器时传 `getShareVia: () => biliConfig().share?.via`
  - `plugins/surfcore/scripts/test-quota-batch.mjs`（新增）：同批号去重 + 不同批号各占一次 + 超限拒绝
  - `plugins/surfcore/scripts/test-store.mjs` / `test-client-contract.mjs`：7 种组合的回归断言
- **验证**：`test-store.mjs` OK · `test-client-contract.mjs` OK · `test-quota-batch.mjs` 6 项通过 · `test-bili-share-dedup.mjs` 通过 · `node scripts/test-audit.mjs` = 74/77（既有 3 个失败：self-identity / identity-guard / version）；`node --check` 全部 12 个改动文件 0
- **注意**：界面选项要刷新 Web GUI 才看得到；桥接侧 `getShareVia` 需要重启 QQ 桥接才生效
- **回滚**：`git revert <commit>`；或从上面的 `.20261029-1344.bak` 还原 8 个文件

## 2026-10-29 09:40 记忆注入 v5：卡里已有整句不再重复 + 预算改「字」+ 三层总额度上限 10000

- **实际改动时间**：2026-10-29 09:20–09:45
- **改动人**：Lead（受主人 QQ 123456789 指派，m04400 / m04401 提出，计划批准后执行）
- **触发原因**：主人两条诉求 —— ①「三层总额度最高 4000 有点低了，改为最高 10000」；②「把 token 改为字符数表示更明显」。外加主人此前提出的「记忆卡里有的，三层别再重复一遍」。
- **备份**：`<用户目录>\.dsh\_backups\` 下 `memory-store.js` / `world-tree.js` / `bridge.js` / `client.js` 各一份 `.bak`（时间戳 202610290919）
- **文件与改动**：
  - `src/memory-store.js`：新增 `tokensForChars()`、`splitSentences()`、`dropEchoLines()` 与常量 `DEFAULT_LAYER_CHARS=6000` / `MAX_LAYER_CHARS=16000` / `MAX_TOTAL_CHARS=10000`；
    `normalizeSharedConfig` 增 `budgetChars`（对外）并保留 `budgetTokens`（内部换算），`totalChars` 上限 20000 → 10000，且默认值不再从老 token 字段推
  - `src/world-tree.js`：`normalizeTreeConfig` 增 `budgetChars`（默认 1200，上限 4000），`budgetTokens` 由其换算
  - `src/bridge.js`：唤醒组装里把卡拆成整句，三层（会话/共享/树）逐行去重（阈值 0.6，日志记剔掉几行）；三层总额度兜底 10000；
    删掉 purpose 组装里的 `memoryCardText.slice(0, 2400)`；`crossMemory` / `worldTree` 默认配置改成 `budgetChars`；
    `GET /api/socialV2/memory/status` 增 `layerChars` / `treeChars` / `totalCharsMax`
  - `plugins/surfcore/lib/client.js`：「三层总额度（字）」上限 10000；「记忆注入预算」与「知识注入预算」由 token 改成「字」，读写 `budgetChars`（老配置按 1.4 / 3 倍换算读出来）
  - `scripts/test-memory-dedupe.mjs`（新增）：6 项 —— 卡句拆参照、阈值 0.6 同句剔除/无关保留/标题保留、同层去重、预算字数与上限、世界树字数、桥接接线断言
  - `scripts/test-memory-store.mjs` / `scripts/test-world-tree.mjs`：默认值与夹紧断言跟着改成「字」
- **验证**：`node --check` 三个源文件 = 0；test-memory-dedupe 6/6、test-memory-store 16/16、test-world-tree 14/14、test-memory-card-wiring OK；
  `node scripts/test-audit.mjs` = 74/77（既有 3 失败：test-version、test-self-identity、test-identity-guard，与本次无关）
- **文档**：`docs/PITFALLS.md` 第 #97 条（重复注入 / 两条链路不一致 / 单位混用 / 默认值推断 / 行级去重保留结构行）
- **回滚**：`git revert <commit>`；配置项回滚把 `budgetChars` 删掉即可回落到 token 兼容路径

---

## 2026-10-29 12:45

- **实际改动时间**：2026-10-29 12:41–12:47
- **改动人**：Lead（主人 m04857：「每在设置界面我把管理员 B站 UID 填进去后点保存，就会自己消失像是没有接收到一样，这是个严重bug」，UID = 3493106490017970）
- **触发原因**：B站 UID 已到 16 位（3493106490017970），校验正则写死 4–15 位，超长直接归一化成空串 → 界面保存后被吐回空。
- **改动内容**：
  - `src/admin-identity.js:29`：`ADMIN_MID_RE = /^\d{4,20}$/`（原 `/^\d{4,15}$/`）。
  - `src/self-identity.js:49`：B站 mid 校验 `/^\d{3,20}$/`（原 3–15）。
- **验证**：`normalizeAdminMid({ biliMid: "3493106490017970" })` 返回该值（改前是空串）；`node --check` 两个文件都是 0。
- **注意**：插件跑在 DSH 进程里、模块已加载 ⇒ 界面上的保存要等插件重载 / DSH 重启才用新正则；本次已直接把 mid 写进 `~/.dsh/surfcore/config.json` 与 `bili.config.json` 让工具先能用。
- **回滚**：还原上面两个文件（备份在 `<用户目录>\.dsh\_backups\`）。

## 2026-10-29 12:20

- **实际改动时间**：2026-10-29 12:12–12:23
- **改动人**：Lead（主人 m04675 要求「试试定时分享能不能分享给 123456789」）
- **触发原因**：B站「定时分享视频到群」的目标写的是 QQ 号 123456789，但代码一律拼 `group:`，会往不存在的群发；主人要的是私聊发给自己。
- **备份**：`<用户目录>\.dsh\_backups\{bridge.js,bili-card.js,bili-share-scheduler.js}.20261029-1212.bak`
- **改动内容**：
  - `src/bili-card.js`：`createBiliCardSender` 改收 `sendSegments(kind,id,segments)`（旧 `sendGroupSegments` 保留兼容）；key 支持 `private:<QQ>`，发卡片按 kind 分发。
  - `src/bili-share-scheduler.js`：目标条目支持 `private:<QQ>` / `group:<群号>`，纯数字仍按群处理；排定日志改为打印真实目标。
  - `src/bridge.js`：新增 `biliShareTargetList`——纯数字若在 `allow.private` 且不在 `allow.groups` 里自动当私聊；`sendBiliCard` 接线改成 `sendSegments`。
- **验证**：
  - `node --check` 三个文件全 0。
  - 探针 `E:\聊天日常\probe-bili-private-share.mjs` 真发卡片到 `private:123456789`，OneBot 返回 `message_id=1169845255`。
  - 桥接重启后日志：`[B站分享] 已排定：每天 07:00 / …（下次 2026-10-29 13:00:00）→ private:123456789`。
  - `scripts/test-bili-card.mjs` 走真机发了一张卡（`message_id=1183280288`）、`test-bili-card-ark` / `test-bili-share-dedup` 通过。
- **已知边界**：B站 cookie 已失效（nav 返回 -101）、管理员 B站 UID 为空，所以 `/api/bili/status` 的 `memory.shareable = 0`，13:00 那次会因「没有新鲜素材」跳过；重新登录 B站后才有素材。
- **回滚**：`git revert <commit>`，或还原上面三个 .bak。


## 2026-10-29 00:10 记忆系统 v4：整卡注入 + 卡/树双写 + 三层预算 + 引擎开关

- **实际改动时间**：2026-10-28 23:40–2026-10-29 00:05
- **改动人**：Lead（受主人 QQ 123456789 指派，m03915 / m03920 / m03953 计划批准）；并行：tree-dev（世界树事件分支）、ui-dev（设置页「记忆系统」组 + MCP 工具）
- **触发原因**：主人要求「不要记忆卡三档，整卡都带着，插件自带压缩」「一句消息记忆卡和世界树都要写，否则会错乱」「看看还有没有冲突或遗漏」
- **备份**：<用户目录>\.dsh\_backups\ 下 bridge.js / memory-card.js / world-tree.js / memory-store.js / client.js / mcp-snowluma-safe.js 各 .bak（20261028-2350 与 235350 两批）
- **文件与改动**：
  - `src/memory-card.js`：`injectMaxChars.qq` 2200 → 4000；新增 `autoCompactIfNeeded(paths, config, { threshold=6000, now })`（超阈值压到 85%）
  - `src/memory-store.js`：`normalizeSharedConfig` 增 `engine`(curve|legacy) 与 `totalChars`(injectMaxChars, 800..20000)；新增 `pickLegacy` / `filterByCharacter` / `similarityOf` / `dedupeAgainst`；`createMemory` 带 `characterId`；`renderBlock` 支持 legacy（只输出原始条目）
  - `src/world-tree.js`（tree-dev）：`EVENT_BRANCH='记忆/事件'`、`maxEventNodes` 独立配额、事件 sourceKey 去重、事件不自然落叶、`renderBlock` 的 `eventDays` 分组【记忆·事件】
  - `src/bridge.js`：唤醒组装改成「记忆卡整卡 + 会话记忆 + 共享 + 世界树」三层总额度（session > shared > tree，超了按 树→共享→会话 砍）；`memoryConfig()` 合并 `crossMemory` 与 `memory` 两段；`memoryCardPaths()` / `worldTreeStore()` 惰性按角色解析；`appendEventToAll` 双写；`memory-append` 端点改走它；`recordMemoryInboxEvent` 同判定写树 + 卡超 6000 字自动压缩；新增 `GET /api/socialV2/memory/status`；`formatMemoryV2` 支持 legacy 引擎
  - `plugins/surfcore/lib/index.js`：`SOCIAL_V2_PROXY_GET` 加 `/api/socialV2/memory/status`
  - `plugins/surfcore/lib/client.js`（ui-dev）：Sprintkey 分区新增「记忆系统」组（引擎单选 / 共享开关 / 三层总额度 / 只读状态行 + 刷新）
  - `src/mcp-snowluma-safe.js`（ui-dev）：新增只读 `qq_memory_card_query`，并改写 6 条记忆工具的分工说明
  - 测试：`scripts/test-memory-store.mjs` 11 → 16 项；`scripts/test-world-tree.mjs` 8 → 14 项（tree-dev）；`scripts/test-memory-card-wiring.mjs` 断言放宽
- **验证**：node --check 全 0；test-memory-store 16/16；test-world-tree 14/14；test-memory-card-wiring OK；test-audit 74/77（既有 3 失败：self-identity / identity-guard / version）；真接口 status/preview/append 全 200，群→私聊共享层 108 字、树事件 1 片
- **回滚**：`git revert <commit>`；配置回滚把 `socialV2.memory.engine` 设回 `legacy` 即恢复旧的 24h/20 条规则

## 2026-10-28 23:30 记忆系统重构：记忆曲线 + 世界树 + 双向共享记忆

- **实际改动时间**：2026-10-28 21:40–23:18（开发/调试/验证），23:30 提交
- **改动人**：Lead（受主人 QQ 123456789 指派，m03391 / m03437）
- **触发原因**：主人提「跨会话共享记忆只记几天太牵强，应该像人脑记忆曲线，越远越淡但不消失，提起了又能想起；最多 8 条像硬限制」，随后追加「世界树」「群聊→私聊也要记得（双向）」两条要求
- **备份**：<用户目录>\.dsh\_backups\（改动前各文件 .bak）；整包快照见 `E:\_backups\`
- **git 提交**：本条提交（见 commit message `feat(memory): 记忆曲线 + 世界树 + 双向共享记忆`）
- **文件与增删行**：
  - 新增 `src/memory-store.js`（约 356 行）：记忆强度衰减（`exp(-age/tauDays)`）、`touchByText` 被提起强化、`scoreMemories` 相关度/新鲜度/重要度加权、`pickByBudget` 按 token 预算挑选（替代条数上限）、`renderBlock` 带清晰度标签（清晰/有点模糊/模糊）与【突然想起】、`migrateFromState` 增量迁移旧状态
  - 新增 `src/world-tree.js`（约 330 行）：世界树 store（`seed` / `grow` / `pick` / `decay` / `render`），节点按主题+关键词分叉，落叶不删除只归档
  - 改 `src/bridge.js`：`memoryConfig()` / `sharedMemoryPromptBlock()`（主人环双向）/ `worldTreeConfig()` / `worldTreePromptBlock()`、`formatMemoryV2` 换新渲染、`appendMemoryV2` 同步写 memories、消息到达做 `touchByText`、唤醒注入加世界树、新增 `GET /api/socialV2/memory/preview`、`GET/POST /api/socialV2/memory-tree(/grow)`
  - 改 `src/mcp-snowluma-safe.js`：新增 `qq_memory_tree_view` / `qq_memory_tree_grow` 工具
  - 改 `plugins/surfcore/lib/client.js`：Sprintkey 分区新增「跨会话共享记忆」「世界树」两组设置
  - 新增测试 `scripts/test-memory-store.mjs`（11 项）、`scripts/test-world-tree.mjs`（8 项）
- **改动内容**：第 1 层轻记忆从「24h 过期 + 最多 20 条」改成强度衰减 + token 预算；第 2 层世界树人设常驻、知识分叉；共享范围改成主人环（管理员私聊 + 最近 14 天活跃群）双向注入
- **验证**：`test-memory-store` 11/11、`test-world-tree` 8/8、`test-audit` 74/77（3 个既有失败：self-identity / identity-guard / version）；真接口验证私聊→群聊 109 字、群聊→私聊 115 字、世界树发芽 + 注入 45 字
- **回滚**：`git revert <commit>`；或 `git reset --hard sprintkey-custom-v0.6.22`

## 2026-10-28 21:20 · 云端语音保存修复：toast 未传 + 音色 ID 写不进

- 实际改动时间：2026-10-28 21:10–21:20（Asia/Shanghai）
- 改动人：Lead
- 触发原因：主人填火山 AppID/Access Key/音色 ID 点「保存」，报 `toast is not a function`，并怀疑一个字都没存进去
- 备份：`<用户目录>\.dsh\_backups\client.js.20261028-2115.bak`、`voice-packs.js.20261028-2115.bak`（改前取自 git HEAD）
- 提交：见 `git log --grep="云端语音保存"`
- 文件与增删行：
  - `plugins/surfcore/lib/client.js`（1 行）：`h(VoiceTab, { toast })` → `h(VoiceTab, { toast: notify })`
  - `src/voice-packs.js`（+约 20 行）：`cloudConfig()` 的 speaker 同时写 `config.toml:cloud_speaker`，`voices/` 为空时按 `age12-cloud` 建 `voice.json`；`readCloudConfig()` 优先读 `cloud_speaker`
- 根因：
  1. 标签分发少写 `toast: notify`，`CloudForm` 里的 `toast(...)` 是 undefined → TypeError（接口其实已保存成功，UI 却报失败）。
  2. `cloudConfig()` 只写 `voices/<age12*>/voice.json`，云端包的 `voices/` 目录是空的 → 音色 ID 静默丢弃 → 回读 `configured:false`。
- 验证：POST 保存 → GET `{appId:6571702364, speaker:S_XTa0Zuyj2, configured:true}`；`POST /api/voice/packs/test {id:"voice-cloud"}` → 200 / 24793ms / 163104 字节（火山真实合成）。
- 回滚：`git revert <提交>`；现场 `voices/age12-cloud/voice.json` 可直接删。
- 备注：PITFALLS #94。toast 属客户端 bundle，要重启 DSH 才会在界面上消失；服务端修复重启桥接即生效。

## 2026-10-28 20:35 · 语音合成 503 修复：参考音频绝对化 + 自动补 gsv 依赖

- 实际改动时间：2026-10-28 20:00–20:35（Asia/Shanghai）
- 改动人：Lead（DSH 的 lead 智能体）
- 触发原因：主人点语音「试听」和 QQ 发语音都报 503；voxd 日志只有一个 `POST /tts 400`，看不出原因
- 备份：`<用户目录>\.dsh\_backups\voice-packs.js.20261028-2035.bak`（改前版本，取自 `git show HEAD:src/voice-packs.js`）；现场 `gsv.py` 未单独备份，改动只有 6 行且完整内容见下条「改动内容」
- 提交：`git log --grep="语音合成 503"` 可定位（本条提交，fix(voice): 语音合成 503——参考音频绝对化 + 自动补 gsv 依赖）
- 文件与增删行：
  - `src/voice-packs.js`（+约 150 行）：新增 `GSV_EXTRA_PYPI`、`GSV_IMPORT_PROBE`、`runQuiet()`、`ensureGsvDeps()`、`patchPackCode()`
  - `state/voice-packs/voice-local/voxd/engine/gsv.py`（+6 行，现场文件，不入库）：`ref_audio_path` 绝对化
- 根因（两条，互相独立）：
  1. gsv.py 把 `ref_audio_path` 相对路径原样发给 gsv 进程，cwd 不同 → `voicepack/age12/01.wav not exists` → 400 → 上层糊成 503。
  2. gsv 的 requirements 不全，合成时缺 `opencc` 等包 → `No module named 'opencc'` → 同样 400/503。
- 改动内容：`install()` 解包后先 `patchPackCode`，postInstall 后 `ensureGsvDeps`；`repairEnv()` 补完环境也补依赖；`start()` 启动前 120 秒快速探测依赖，缺则自动 `repairEnv` 再起（返回 `envRepairing: true` 与中文提示）。补依赖失败不算安装失败，只记日志。
- 验证：`POST /api/voice/packs/test` 改前 400/503 → 改后 200，`bytes: 127680`；直接打 gsv：改前 400 `not exists` → 改后 200，输出 149804 字节 wav；`node --check src/voice-packs.js` 0；`node scripts/test-audit.mjs` 74/77（仍是既有 3 条：test-version 的 README 0.6.20 漂移、test-self-identity、test-identity-guard）。
- 回滚：`git revert <本次提交>`；现场 gsv.py 用备份覆盖；语音包代码在 state 目录，不用重启 DSH，刷新设置页即可。
- 备注：PITFALLS 第 #93 条记录同一件事。

## 2026-10-28 19:57 管理员 B站 UID 再修：全角数字被吞 + 保存带 adminRef

- 改动人：Lead（AI）· 触发原因：主人第二次反馈「明明输入了管理员 B站 UID，点保存后还是显示没输入」（plugin.log 19:52:44 / 19:52:50 两次保存，前端送来的 admin.biliMid 都是空串）
- 备份：`<用户目录>\.dsh\_backups\client.js.20261028-195742.bak`
- 文件：`plugins/surfcore/lib/client.js`（+13 / -4）
- 改动：
  1. 数字输入清洗函数 `digits()` 从 `String(x).replace(/[^\d]/g,"")` 改成先 `normalize("NFKC")` 再留 `[0-9]`——中文输入法打出来的全角数字（３７６３４００３）以前会被整段删掉，输入框看着永远是空的，保存自然也是空值。
  2. 主组件新增 `adminRef`：`setAdmin` 写入 ref，`save()` 时把 ref 里的 admin 合并进 payload，即使 `unified` 被别的 reload 回写也不丢；保存成功后清空 ref，以服务端回执为准。
  3. `nextSaved` 用合并后的对象比较，避免保存成功后仍显示「有未保存改动」。
- 验证：`node --check` 通过；后端投影逻辑（src/admin-identity.js 的 projectAdminSave）此前已用真实会话 E2E 验证过能落盘，本次只修前端取值链路。
- 回滚：`git revert <commit>`，或把备份拷回 `plugins/surfcore/lib/client.js`。
## 2026-10-28 19:20 · 语音包：Python 环境自动补装 + 设置页一键修复

- 改动人：主人（报问题、验收）→ Lead（定位 + 修代码 + 跑验证）
- 提交：`8282d8c` feat(voice): 语音环境自动补装 + 设置页一键修复（不再逼用户卸载重装）
- 相关文档：功能清单新增 [`FEATURES.md`](FEATURES.md)（第 5 条），接口契约与坑见 `docs/PITFALLS.md` #92
- 触发原因：主人在语音设置里看到「Python 环境还没装好，先点卸载再点安装」，但本地模型（config.toml / models / 音色）早已下载完成；照提示重装会把几百 MB 模型再下一次。

### 根因（两个叠加）

1. `bootstrap.mjs --check` 在 **装依赖之前** 就去检查 `.venv`，所以依赖没装完必然非 0 退出；旧的 `install()` 把这个失败当成「整包安装失败」，于是 config.toml 与 model 已经落盘、`.venv` 却不存在。
2. `statusOne()` 只按目录里有没有模型文件判断 installed，界面于是显示「已安装」，一启动就报环境缺失 —— 用户只能卸载→重装，循环重下模型。

### 功能说明（给后续维护者）

- **界面**：语音包卡片在「已安装」状态下多一块橙色提示：
  `⚠️ Python 环境还没装好（缺 .venv、缺 .venv-gsv（本地音色用））：点下面按钮会自动建环境并装依赖，模型不用重下。启动时也会自动补装。`
  下面跟一个「安装 Python 环境」按钮；点击后原地显示进度条（复用 `ProgressBar`，带阶段名 + 已用分钟 + 日志最后一行），轮询到 `phase === '完成'` 或 `'失败'` 为止。
- **自动补装**：`start()` 在 win32 上先 `envState(dir)`，不 ready 就先 `repairEnv(id)` 再启动；`opts.skipEnvCheck` 用来防止 repair 内部再触发 start 造成递归。
- **接口契约**：
  - `GET /api/voice/packs` 的每个包多两个字段：
    `env: { ready, voxd, gsv, gsvNeeded, bootstrap }`（ready = 该装的 .venv 都在）
    `envRepair: { phase, progress, startedAt, logTail, error } | null`（在跑或刚跑完时才有）
  - `POST /api/voice/packs/env-repair`，body `{ "id": "voice-local" }`，header `x-console-token`（仅本机控制台，agent token 不行），返回 `{ ok: true, started: true }`；同时在跑时返回 `{ ok:false, message }`。
- **不动的东西**：config.toml、models/、音色参考音频、已下载的运行时都不碰；只创建/补齐 `.venv` 与 `.venv-gsv` 并装 pip 依赖。
- **依赖源**：pip 走清华镜像 `https://pypi.tuna.tsinghua.edu.cn/simple`，缓存目录 `.pip-cache`（下次补装更快）。

### 验证（真实跑过，不是只改代码）

- `node --check src/voice-packs.js src/bridge.js plugins/surfcore/lib/client.js` 全通过。
- 重启桥接后 `GET /api/voice/packs` 返回 `env={ready:false,voxd:false,gsv:false,gsvNeeded:true,bootstrap:true}`（复现主人的现象）。
- `POST env-repair` → `{ok:true,started:true}`；约 10 分钟内依次推进：建 .venv → voxd 依赖 → 建 .venv-gsv → GPT-SoVITS 依赖（torch 203MB 等）。
- 结束后 `env={ready:true,voxd:true,gsv:true}`，直接验证解释器：
  `.venv\Scripts\python.exe -c "import fastapi, piper, numpy"` → fastapi 0.162.0；
  `.venv-gsv\Scripts\python.exe -c "import torch, transformers, librosa"` → torch 2.5.1+cpu。

### 回滚

`git revert 8282d8c`；补装只新建 `.venv` / `.venv-gsv` 两个目录，删掉即复原，不影响模型与配置。

## 2026-10-28 19:05 · 跨会话共享记忆段（私聊话题注入群聊）+ 设置页开关

- 改动人：Lead（代主人执行）｜触发：主人「把私聊里关于主人的近期话题摘要，在群聊唤醒时也注入一份（可开关）…开关设置在 Sprintkey 扩展插件内」
- 文件：`src/bridge.js`（默认值 + 注入函数 + 群唤醒接线 + 预览端点）、`plugins/surfcore/lib/client.js`（Sprintkey 分区的开关/条数/时效 + 预览按钮）
- 备份：`<用户目录>\.dsh\_backups\bridge.js.20261028-185812.bak`、`client.js.20261028-185812.bak`
- 改动 1（`bridge.js` 默认值）：`socialV2.crossMemory = { enabled: true, maxTopics: 3, maxAgeHours: 72 }`，配置归一化时补齐（老配置也能读到）。
- 改动 2（`bridge.js` 注入函数 `crossMemoryPromptBlock(key)`）：只对 `group:` 前缀生效；从 `private:<管理员QQ>` 取 72 小时内最近 3 条 `activeTopic`，生成【共享记忆·和主人的私聊】段落，带「N 分钟前」和「不要整段复述、别说成群友说的」用法提示；开关关闭或无话题时返回空串，不占 prompt 位置。
- 改动 3（`bridge.js` 群唤醒）：段落插在人格/记忆之后、当前消息之前。
- 改动 4（`bridge.js` 新端点）：`GET /api/socialV2/cross-memory?key=...` 返回 `{ok, key, config, ownerQQ, text}`，给设置页「预览」和排障用。
- 改动 5（`client.js` Sprintkey 分区）：新增「跨会话共享记忆」小节 —— 开关、注入条数（1–10）、时效（小时）、「预览」按钮（用 `group:0` 演示当前会注入什么）；点预览前提示先去私聊让角色记一条话题，否则是空的。
- 验证：两个文件 `node --check` 均为 0；重启桥接后种一条话题 → `GET cross-memory?key=group:123` 返回完整段落（含「1 分钟前」）→ 删除后 `text` 长度 0；`key=private:123456789` 返回空串（私聊不注入自己）；测试话题已清空，`activeTopics` 回到 0。
- 生效：桥接已带新代码重启；`client.js` 改动刷新设置页可见。
- 回滚：`git revert <commit>`；或把 `socialV2.crossMemory.enabled` 改 false（只关这个特性）。
## 2026-10-28 18:58 · 管理员卡片（QQ ⇄ B站）填了 mid 保存后消失

- 改动人：Lead（代主人执行）｜触发：主人「明明填写了管理员 b站uid，点击保存后，立马又消失了，像是没写入，然后就提示『只填了一边』」
- 排查：后端已排除 —— 纯函数测试 + 带 DSH 会话 cookie 的真接口 E2E（`GET/POST /dsh-surfcore/api/config`）都能把 `unified.admin.biliMid` 写进 `~/.dsh/surfcore/config.json` 并回显；磁盘上最后一次成功写入是 17:23:43，说明主人那几次点保存根本没落盘 ⇒ 值在前端就丢了。
- 改动 1（`plugins/surfcore/lib/client.js` 的 `AdminCard`）：输入框原来直接吃父级 `admin` 草稿，父级一旦被别的写入覆盖回空值，正在编辑的字就被抹掉。现在卡片自带 `draft` 本地草稿：编辑期间不同步父级，`onFocus/onBlur` 记录编辑态，父级 `admin` 变化时只在非编辑态校准。
- 改动 2（`plugins/surfcore/lib/index.js` 的 `handleConfig`）：保存时打一行 `[管理员保存]` 日志（前端送来的 admin、owner.mid、落盘后的 admin），下次复现可一眼看出是前端丢值还是落盘丢值。
- 验证：两个文件 `node --check` 均为 0；`restore-admin-mid.mjs` 把排查时误写的占位 mid（37634003）清回空值，`GET` 回读 `admin.biliMid = ""`、`owner.mid = ""`，与主人原始状态一致。
- 生效：`client.js` 刷新页面即可；`index.js` 的日志要重载插件（设置 → SurfCore 关开）或重启 DSH。
- 回滚：`git revert <commit>`

## 2026-10-28 18:38 · 修设置卡「模型读取失败：未知接口」

- 改动人：Lead（代主人执行）｜触发：主人在 Sprintkey 扩展插件分区看到「读取失败：未知接口：/dsh-surfcore/api/dsh/model（可手动填 id）」
- 根因：设置卡前端走 `API = "/dsh-surfcore/api"`（插件自己的服务端路由），而模型清单接口我只加在了**桥接**的 `:3100 /api/dsh/model`。插件 prefix 路由表里没有 `dsh/model` 这一条，于是回「未知接口」。
- 改动：`plugins/surfcore/lib/index.js` 新增 `handleDshModel(req,res)`（GET 专用，带 `x-console-token` 转发到 `consoleBase()/api/dsh/model`，桥接不可达/非 JSON 都给可读错误），并在 `${API_PREFIX}` 路由表登记 `${API_PREFIX}/dsh/model`。
- 验证：`node --check plugins/surfcore/lib/index.js` 退出码 0；桥接侧 `GET :3100/api/dsh/model` 200（6 个模型）；插件路由需插件重载/DSH 重启后浏览器才能拿到（`/dsh-surfcore/api/*` 在 DSH 会话 cookie 下才放行）。
- 回滚：`git revert <commit>`

---
## 2026-10-28 18:23 · 我们自己的文档归档到 docs/sprintkey

- 改动人：Lead（代主人执行）｜触发：主人「把我们自己创建的文档，如我们自己的更新日志和升级说明文档都放入 <仓库路径>\docs\sprintkey，这个作为我们自己的文件夹」
- 文件：`docs/CHANGELOG-SPRINTKEY.md` → `docs/sprintkey/CHANGELOG-SPRINTKEY.md`；`docs/guides/CUSTOM-FORK-UPGRADE.md` → `docs/sprintkey/CUSTOM-FORK-UPGRADE.md`（用 `git mv` 保留历史）；新增 `docs/sprintkey/README.md` 索引；`docs/guides/` 空目录随提交移除
- 联动：`docs/PITFALLS.md` 第 #88 条的产出路径、手册内 4 处自引用、本日志里 4 处手册链接，全部改到新路径
- 约定：以后我们自己的文档一律放 `docs/sprintkey/`；上游文档（`docs/PITFALLS.md`、`CHANGELOG.md`、`README.md`、`docs/cases/*`）保持原样，合并上游时不会互相覆盖
- 验证：`git status` 只有重命名与索引新增；全仓库 grep 无残留的 `docs/guides/CUSTOM-FORK-UPGRADE.md`
- 回滚：`git revert <commit>`，文档会回到 `docs/` 与 `docs/guides/`

---

## 2026-10-28 18:05 · 升级到上游 v0.6.22（第二次跨版本合并）

- 改动人：Lead（代主人执行）｜触发：主人发现上游又更新了（v0.6.21 / v0.6.22），要求按之前方案升级，并把方案写成文档
- 提交：`a8d78e6` merge: 上游 v0.6.22（语音包本地安装可用、依赖安装可观测/可取消），保留 Sprintkey 自定义；`133e8ec` docs: 新增自定义分支升级手册 + 合并记录
- 锚点：升级前 `sprintkey-custom-v0.6.20`（指 e747c67）、升级后 `sprintkey-custom-v0.6.22`
- 文件：上游 13 个；我们保留的自定义 19 个文件（见 `docs/sprintkey/CUSTOM-FORK-UPGRADE.md` 第三节）；新增手册 1 个
- 上游改动范围：13 个文件（CHANGELOG / README / PITFALLS / client.js / bridge.js / voice-packs.js / package.json / docs/cases 两篇 / FORCE_UPDATE_PROMPT.md / 提示词 txt）
- 上游要点：
  - v0.6.21：语音包依赖安装可观测 + 可取消（新增 `POST /api/voice/packs/cancel`、pip 默认清华源、UI 显示"已 X 分钟 + 最近在装什么"）
  - v0.6.22：本地语音"装完不能用"修复（models.json 加 `dest` 字段、`jieba_fast` 替身、装 imageio-ffmpeg、requirements 补 torchmetrics）
- 冲突：仅 `docs/PITFALLS.md`（两边都往末尾追加）→ 保留我们的 #82–#87，上游两条附后
- 自动合并：`src/bridge.js` 的 cancel 路由嵌在我们 send-media 区块旁边仍成功；`client.js` 语音取消 UI 与 SprintkeyTab 互不相邻
- 做法（本次起固化为文档 `docs/sprintkey/CUSTOM-FORK-UPGRADE.md`）：备份 zip + 锚点 tag `sprintkey-custom-v0.6.20` + patch 快照 → fetch → 预读 diff → `merge --no-ff` → 解冲突 → 重出预设 patch → 语法检查 → audit → 重启桥接 → 四条真实验证
- 验证：`node --check` 三文件全 0；`test-audit` 74/77（红的一直是 test-version / test-self-identity / test-identity-guard）；`GET /api/dsh/model` 200（catalog 6 模型）；`GET /api/socialV2/effort` 200；`qq-chat-v2` 预设仍在；真发图 `message_id=93488551`
- 备份：`E:\_backups\surfcore-sprintkey-v0.6.20-20261028-175959.zip`、补丁快照 `E:\_backups\sprintkey-vs-v0.6.20.patch`
- 产出：`docs/sprintkey/CUSTOM-FORK-UPGRADE.md`（含主人原话存档、9 步流程、冲突决策表、19 个自定义文件表、验证清单、回滚、升级记录表）；`docs/PITFALLS.md` 第 #88 条记录本次合并
- 回滚：`git reset --hard sprintkey-custom-v0.6.20`

## 2026-10-28 17:45 · 模型选择自动读清单、会话内可单独换模型

- 改动人：Lead（代主人执行）｜触发：主人「模型选择应该自动读取 dsh 内设置的模型，而不是要手动填写；思考强度也自动读取，按选择的模型自动读取对应的思考模式；也支持用户在不同对话的会话内选择不同模型，而不是强制跟随插件默认」
- 提交：`e747c67` feat(model): 模型清单自动读取 + 会话级模型覆盖 + 设置卡下拉
- 文件：`src/bridge.js`（+70/-18）、`src/mcp-snowluma-safe.js`（+55/-2）、`plugins/surfcore/lib/client.js`（+60/-14）、`docs/PITFALLS.md`（+1 条 #87）
- 改动：
  - `GET /api/dsh/model` 回 `catalog`（provider → models[]，含每个模型的 efforts 与 defaultEffort）。
  - 新增 `state.sessionModel[key]`；`effectiveModelFor(key)` / `rememberSessionModel()` / `modelInfoFor(key)`。
  - `ensureChatModel` 用会话覆盖的模型；日志标注「模型来自会话自定义 / 跟随插件设置」。
  - `POST|GET /api/socialV2/effort` 同时管模型与档位，支持 `inherit` 撤销。
  - MCP：新增 `qq_get_model_catalog`；`qq_set_reasoning_effort` 加 `model`/`provider`。
  - 设置卡：模型下拉（自动清单）、档位下拉跟模型联动、说明会话内也能改。
- 验证：`GET /api/dsh/model` 200（catalog 6 个模型）；换 `deepseek-v4-pro` → `applied: true, sessionModel 生效`；`inherit` → 回到跟随插件；`node --check` 三个文件全 0。
- 回滚：`git revert <commit>`；state 里残留的 sessionModel 可用 `inherit` 清掉。

## 2026-10-28 17:13 · 思考强度支持「撤回覆盖」，回到跟随插件

- 改动人：Lead（代主人执行）｜触发：主人要求"会话级可改"之后，验证时发现会话一旦改过就退不回默认
- 提交：`c16546f` feat(effort): 支持 inherit 撤销会话思考强度覆盖；docs: 记录 v0.6.20 合并与验证
- 文件：`src/bridge.js`（+14/-2）、`src/mcp-snowluma-safe.js`（±4）、`docs/PITFALLS.md`（+21）
- 改动：
  - `POST /api/socialV2/effort` 接受 `effort: null | inherit | follow | auto | default`，表示撤销本会话覆盖，`state.sessionEffort[key]` 写 null，立即把会话模型切回插件档位。
  - MCP 工具 `qq_set_reasoning_effort` 的 `effort` 枚举加 `inherit`，描述同步（要等 DSH 重启才出现在工具参数里）。
- 验证：`clear override` → `sessionEffort: null, effectiveEffort: low, applied: true`；桥接日志 `会话 private:123456789 思考强度已改为 low`。
- 回滚：`git revert c16546f`。

## 2026-10-28 16:58 · 合并上游 v0.6.20，自定义全保留

- 改动人：Lead（代主人执行）｜触发：主人「上游到 0.6.20 了，能不能既保留自定义又跟新版」
- 提交：`e311753` merge: 上游 v0.6.20（语音包安装/更新助手/进度条），保留全部自定义
- 做法：
  1. 先确认 `<仓库路径>` 本身就是上游 clone（origin 经 gh-proxy 镜像），把本地改动按主题拆成 7 个 commit、打 tag、整包备份 zip。
  2. `git fetch --tags` 后 `git merge v0.6.20`。
  3. 冲突只有 `docs/PITFALLS.md`（两边都往末尾追加），保留双方条目；`src/bridge.js`、`plugins/surfcore/lib/client.js` 全部自动合并成功。
- 从上游拿到的能力：语音包安装/卸载/一键更新、更新助手（"检查更新"面板真正可用）、语音包安装进度条、语音链路若干修复。
- 合并后补提交：`71d7ddd` 重新生成 preset patch + lockfile；`0ece815` PITFALLS #82–#85。
- 验证：见下方「合并后验证」。

## 2026-10-28 16:40 前后 · 设置卡新增「Sprintkey扩展插件」主分区

- 改动人：Lead（代主人执行）｜触发：主人要求「新加一个主分区，名字为 Sprintkey扩展插件，点进去就能看到具体设置，风格参考插件本身」（此前第一版做成了 QQ 页里的一个开关，被打回）
- 提交：`1392612` feat(ui): 设置卡新增「Sprintkey扩展插件」主分区
- 文件：`plugins/surfcore/lib/client.js`（+53/-1）
- 改动：
  - `TABS` 加 `["sprintkey", "Sprintkey扩展插件"]`，渲染分发器加 `SprintkeyTab`。
  - 分区里放：模型 id、思考强度（low/high/max）、思考强度应用范围（各会话自定义 / 全部会话统一）、扩展工具投递开关、图片与文件大小上限、投递接口说明。
  - 删掉了混进来的「扩展包」段（与「扩展」页重复、配置串台），文里写明"扩展包的启用/重载在「扩展」页"。
- 验证：`node --check plugins/surfcore/lib/client.js` 通过；页面刷新后分区可点开（主人截图确认）。

## 2026-10-28 15:38–15:50 · QQ 预设对齐原生 DSH：给足本地工具

- 改动人：Lead（代主人执行）｜触发：主人「插件开的会话连翻文件夹都做不到，要跟原生 DSH 一样，别限制思考方式」
- 备份：`<用户目录>\.dsh\_backups\qq-chat-v2.agent.cordis.yml.20261028-153812.bak`
- 提交：`5c50e9a` feat(preset): QQ 预设对齐原生 DSH 工具集（pwsh/fs/search/subagent）
- 文件：`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`（193 → 270 行）、`scripts/test-preset-local-tools.mjs`、`scripts/test-preset-prompt.mjs`、`scripts/test-qq-preset-contract.mjs`、`src/preset-prompt.js`
- 根因：预设里 persona 规则 1 写死"你没有本地工具：不能执行命令、不能读写文件…"，工具行也只有 web / ask-user / todo / 守卫 / 压缩。
- 改动：
  - persona 规则 1 重写为"你有完整的本地能力，和原生 DSH 一样…先做事，再把结果说清楚"；规则 2（群友无管理权限）保留。
  - 工具行补齐原生组合：`tool-pwsh`、`tool-fs`、`tool-fs-search`、`tool-jobs`、`tool-schedule`、`skill-filesystem`、`tool-skill`、`command-goal`、`tool-goal`、`present`、`tool-working-directory`、`tool-ask-user`、`tool-todo`、delegation 组（subagent-control / list-agents / subagent / subagent_fork / workflow-ptc / tool-workflow）、`tool-web`（search 仍关、fetch 开、searchTimeoutMs 60000）、`qq-tool-restrict`（mode: open）、compaction。
  - 三条测试随之更新（"仅 qq-chat-v2 允许 fetch:true"、18 个工具行期望、"你有完整的本地能力"文案）。
- 验证：`test-preset-local-tools` 7/0、`test-qq-preset-contract` 8/0、`test-preset-prompt` 12/0、`test-agent-preset-patches` 通过；`build-agent-preset-patches.mjs` 重新生成 `plugins/surfcore/presets/qq-chat-v2.patch.yml`。
- 坑：surfcore 的 YAML 加载器不认 `!!js` 自定义标签，所以不能写平台条件行（bash 那行被迫去掉）；这些文件是 CRLF，按 `\n` 拼锚点会 miss，要用行号 splice 改。

## 2026-10-28 15:00–15:30 · 扩展工具投递（发图 / 发文件 / 视频）+ 会话级思考强度

- 改动人：Lead（代主人执行）｜触发：主人「参考 dsh-onebot-qq 的实现，让 surfcore 能发 qq_send_image / qq_send_file / qq_send_voice，并且可以完全调用 dsh，不受限制」
- 备份：`<用户目录>\.dsh\_backups\config.json.surfcore.20261028-145500.bak`
- 提交：`e50f77b` feat(bridge): 扩展工具投递（发图/文件/视频）+ 会话级思考强度
- 文件：`src/bridge.js`（+246/-10）、`src/mcp-snowluma-safe.js`（+84）、`public/console.html`（+1）
- 改动：
  - 新端点 `POST /api/socialV2/send-media`：`{key, token, path|url, kind?, name?, dryRun?}`；图片 ≤20MB、其它 ≤100MB；本地绝对路径或 http(s) 链接；`file://` 失败自动降级 `base64://`；沿用 reserved2 模式、agent token、工具开关、静默保护、限流、鱼群保护；成功记进活动日志与已发记录。
  - 工具开关新增 `sendMedia`（默认开），`toolFlags` / `toolMap` / 控制台勾选框同步。
  - MCP 注册 `qq_send_image` / `qq_send_file` / `qq_send_video`（`qq_send_voice` 仍在旧通道），统一读 `TOOL_CONFIG_FLAGS`。
  - 思考强度两档：`cfg.dsh.reasoningEffortMode = 'all' | 'session'`（默认 session）、`state.sessionEffort` 持久化、`GET/POST /api/socialV2/effort`、MCP 工具 `qq_set_reasoning_effort`；`ensureChatModel` 一律用 `effectiveEffortFor(key)`，不再硬编码 max。
- 验证：真发图片 `message_id=671651455`、真发文件 `message_id=355845624`；dryRun 覆盖本地图片 / 本地文件 / http(s) 三种来源；effort 的 GET / 设 high / 撤销全部 200。
- 坑：① SnowLuma 网关是独立进程，挂了以后桥接只报 `fetch failed`——要单独 `Start-Process E:\SnowLuma\node.exe .\index.mjs`；② 控制台令牌只认 `config.json` 的 `consoleToken`（32 位），`state/console-token` 是过期残留，用了会一路 401。

## 2026-10-28 14:11 · QQ 工具守卫改成 open / balanced / strict 三档

- 改动人：Lead（代主人执行）｜触发：主人「表情包插件被拦了，把限制解除，让你成为完整 agent」
- 备份：`<用户目录>\.dsh\_backups\qq-tool-restrict.mjs.*.bak`（时间戳 20261028-141112）
- 提交：`172d03a` feat(guard): QQ 守卫改成 open/balanced/strict 三档，可由 preset 配置开
- 文件：`plugins/surfcore/qq-tool-restrict.mjs`（+65）、`dsh/agent-presets/qq-chat/agent.cordis.yml`（±9）
- 改动：`GUARD_MODES = ['open','balanced','strict']`，`config.mode` 决定；`open` 全放行（只挡空名字），`balanced` 只挡本地执行面，`strict` 保持旧白名单；环境变量 `SURFCORE_QQ_TOOL_GUARD_MODE` 可覆盖；预设与 patch 同步。
- 兼容性设计：判默认档看"有没有传 config 对象"——运行期 DSH 必传（默认 open），测试只传一个参数（默认 strict），这样审计里的旧断言不用改。
- 验证：`test-preset-local-tools` 7/0、`test-agent-preset-patches` 通过、`test-audit-setup-guards` 通过、`test-qq-preset-contract` 8/0；另跑脚本确认 open 放行 send_meme/pwsh、无 config 仍 strict。

## 2026-10-28 15:05 前后 · B 站发布失败不再"假成功"

- 改动人：Lead（代主人执行）｜触发：例行审计发现发布没拿到 dyn_id 时仍然记成功
- 提交：`c00f498` fix(bili): 发布没拿到 dyn_id 时非零退出、不记账
- 文件：`plugins/surfcore/tools/commands/daily.mjs`（+6）、`plugins/surfcore/tools/commands/dynamic.mjs`（+2）

## 2026-10-28 15:0x · QQ 不回复：token 守卫把唤醒掐了

- 改动人：Lead（代主人执行）｜触发：主人「我刚刚发消息怎么它没有回复我」
- 现象：`state/bridge.log` 反复 `[token-guard] 跳过唤醒 private:123456789：Token 防爆破：这个会话今天已经醒了 10/10 次`
- 处理：把 `config.json → socialV2.tokenGuard` 调整成 `maxWakesPerDay=120`、`privateMaxWakesPerDay=60`、`minWakeGapMs=20000`，重启桥接后立即恢复（当天随后多次唤醒正常）。
- 备注：这是配置调整，未改代码，所以没有单独 commit；PITFALLS 里对应的设计背景是 #50（Token 防爆破），本次只是把额度调到合理值。

## 环境改动（不进 git，但换机器要重做）

| 时间 | 改动 | 原因 |
| --- | --- | --- |
| 2026-10-28 17:10 | 用户级 `Path` 追加 `C:\Program Files\Git\cmd` | 插件测试和「检查更新」都调 `git`，原先 ENOENT，插件更新面板一直显示不可查 |
| 2026-10-28 17:05 | 跑插件测试时临时把 `TEMP`/`TMP` 设成长路径 | `os.tmpdir()` 给 8.3 短路径，和 `git rev-parse --show-toplevel` 的长路径比不相等，更新测试假红 |
| 2026-10-28 15:0x 起 | SnowLuma 网关单独拉起（`E:\SnowLuma\node.exe .\index.mjs`） | 它是独立进程，桥接不会替你拉；挂了就只是 `fetch failed` |
| 2026-10-28 15:0x | `config.json`：`socialV2.tools.sendMedia=true`、`socialV2.media.maxImageMB=20 / maxFileMB=100` | 投递通道开关与上限 |

## 合并后验证（2026-10-28 17:05–17:15）

| 项 | 结果 |
| --- | --- |
| 桥接启动 | pid 34580，日志 `DSH 已就绪（模式: reserved2）`，收藏表情同步 100 个 |
| 发图 | `message_id=671651455`（真实到达 QQ） |
| 发文件 | `message_id=355845624`（真实到达 QQ） |
| 投递 dryRun | 本地图片 / 本地文件 / http(s) 链接 三种来源全部 `ok:true` |
| 思考强度 | GET 返回 mode/pluginEffort/sessionEffort/effectiveEffort；设 high 生效；`inherit` 撤销生效 |
| 审计 | `node scripts/test-audit.mjs` 74/77，与合并前一致；红的 3 个为既有问题（test-version 的 README 版本漂移、test-self-identity、test-identity-guard） |
| 插件测试 | `npm test` 除 `test-updates-voice.mjs`（要连 GitHub API，本机 Node 不走系统代理）外全过 |

## 提交对应表

| 提交 | 时间 | 简介 |
| --- | --- | --- |
| `172d03a` | 16:57 | 守卫三档 |
| `5c50e9a` | 16:58 | 预设对齐原生工具集 |
| `e50f77b` | 16:58 | 扩展工具投递 + 会话级思考强度 |
| `1392612` | 16:58 | Sprintkey扩展插件主分区 |
| `c00f498` | 16:58 | B 站发布失败修正 |
| `0ece815` | 16:58 | PITFALLS #82–#85 |
| `71d7ddd` | 16:58 | 重新生成 preset patch 与 lockfile |
| `e311753` | 16:58 | 合并上游 v0.6.20 |
| `c16546f` | 17:13 | inherit 撤销思考强度覆盖 |

## 回滚

- 单个功能：`git revert <hash>`
- 回到「合并前的自定义 0.6.17」：`git checkout sprintkey-custom-v0.6.17`（想连文件一起回到当时，用 `E:\_backups\surfcore-sprintkey-v0.6.17.zip`）
- 上游再出新版时的合并套路：见 `docs/PITFALLS.md` #86，以及本文件「提交对应表」——先把新的自定义改动按主题提交，再 merge 上游 tag，冲突集中处理 `PITFALLS.md`。

### 2026-10-31 16:00 - 17:05 悬浮窗换成 dsh-pet 桌宠形象

- 新增 `lib/pet-assets.js`：按需下载 dsh-pet@0.3.8 的 106 个 VP9-alpha webm + 动画清单（52MB，MIT，落 `<stateDir>/orb/pet`，不进 git），支持离线包安装。
- `lib/orb.js`：`ball.mode = pet|ball`（默认 pet）、`ball.petSize` 120~320、`orb.pet{singleClickOpens,idleMinMs,idleMaxMs}`；`petInfo()` 素材没装自动回落小球并给原因。
- `assets/orb-app/`：`#pet` 双 video 交叉淡入 + 头顶气泡 + `pet.js`（idle/click/drag/move 动作链、镜像、命中）、`pet.css`；`main.js` 按宠物包围盒建窗、右键菜单、面板沿用原会话。
- 交互：单击逗一下（`pet.singleClickOpens` 可改成直接开会话）、双击开会话、拖拽有拖拽动画与贴边、3 分钟空闲缩回。
- 设置页「悬浮窗 → 外观」：形象下拉、桌宠大小、素材下载/校验/移除、单击就开会话开关。
- 真机：宠物上屏 247x314 @ 屏幕右缘、`/orb/say` 气泡出现在头顶、双击展开会话并能看到历史。
### 2026-10-31 17:40–18:10 悬浮窗：右键菜单回原样 + 加「大小」滑条；长按变大根治
- 右键菜单从「撑成 360×250 的独立面板」改回**窗口内 HTML 菜单**：打开会话 / 换个动作 / 大小 / 隐藏，点「大小」在菜单里展开滑条（120~320），窗口尺寸全程不变。
- `main.js` 新增 `displayMode` / `expectedBounds()` / `applyBounds()`：所有写窗口路径统一收口，收起态锁死宠物尺寸、展开态锁死面板尺寸；动画期间挡下的展开/收起用 `pendingExpand` 补做一次，长按连点不再把窗口撑大。
- `orb:sizepanel` 废弃为 no-op；`ORB_TRACE=1` 可打印每次窗口变更的 reason。
- 版本 0.6.0 → 0.6.1；`scripts/test-orb.mjs` 57 → 86 项（新增菜单/滑条/模式不变量契约）；审计 80/83（既有三个红）。
## 2026-10-31 18:50-19:35 悬浮窗 0.7.x

- 拖动：松手不再弹回右缘，只在贴边 24px 内吸附；收起态允许出屏 20px，宠物能真的贴到屏幕边。
- 面板：头部加「移」开关，按住面板空白处可拖动，松手记住位置；收起时桌宠落到面板所在处。
- 右键菜单：恢复「打开会话/换个动作/大小/隐藏」，菜单不再撑大窗口（临时扩窗 + 宠物位移补偿），「大小」滑条就地生效。
- 双击：宠物淡出微缩 + 面板淡入，不再闪；展开时暂停宠物视频，收起恢复。
- 气泡：带头像和名字（默认机器人昵称 + 双方 QQ 头像），设置 → 悬浮窗 → 聊天外观可开关/自定义。
- 看图：面板顶部「她看不见你的屏幕」一键开权限（POST /eye 后立刻拍一张）；对话会带截图，但当前模型通道不支持图片，自动退纯文本并如实说明。
- 测试 test-orb 86 → 126 项全过；版本 0.7.2。
### 2026-10-31 20:00-21:20 悬浮窗 0.8.x
- 图片：改用 DSH 附件引用（`attachments.saveImage` → `{type:"image", attachment:ref}`），她终于能真看懂屏幕截图；模型不支持时明确回「看不了图」。
- 眼睛：面板头常驻「眼」开关（灰/蓝/脉冲三态），点一下=开权限→拍一张→她说看到什么→**删掉截图**；新增 `screen.deleteAfterRead`（默认开）与启动清扫 1 小时前的 `*.chat.jpg`。
- 面板拖动：`panel-move` 锁宽高 + 增量式拖动 + 松手取真实 bounds，不再越拖越大。
- 桌宠拖动：加 `petBodyHit()` 几何判定（去掉头顶气泡带与左右透明边），远处拖不动；窗口保持可点，穿透方案改回不穿透。
- 版本 0.8.0 → 0.8.3；`scripts/test-orb.mjs` 136 项全过；`test-audit` 79/83（既有三红）。
### 2026-10-31 22:40-23:10 悬浮窗 0.9.0 → 0.9.2（眼睛点按 / 面板发图 / 会话滚动）
- 眼睛三档 `orb.screen.mode = off|manual|auto`；手动点眼不占每小时额度（3 秒冷却），自动档两段式（`[[看一眼]]` → 拍图 → 带图再问），`shots.json` 记今天看了几次。
- 单击「眼」＝关闭、双击「眼」＝看一次；关掉后按钮立刻灭、提示条改「眼睛已关闭」并 3 秒渐隐。
- 面板新增「图」按钮与 `orb.pic` 五个开关（与 QQ 发图互不影响）；`POST /pic` 走 QQ 表情 → 本地图库 → 要 agent 现画，`POST /pic/image` 回填。
- 图片气泡自适应宽度；会话新消息贴底，翻历史时右下角小圆显示未读条数或 ↓。
- 面板收起不再挪桌宠位置。版本 0.8.3 → 0.9.2；`test-orb` 171 项全过；`test-audit` 80/83（既有三红）。

### 2026-10-31 23:15-24:10 悬浮窗 0.10.0（眼睛说真话 / 打开先同步 / 发图接通 / 表情图走代理）
- 眼睛：`POST /screen/eye` 关眼睛后重新 `readConfig()` 再回包（带上真实 `mode`），以前回的是改动前的旧配置，前端只能靠猜；开关两侧都按 `screenModeOf` 判断，关掉后单击「眼」不会再被当成「开一下」。
- 双击「眼」= 一条 `{enabled:true, timeoutMs:120000}` 请求，不再「先开再 toggle」；回包统一走 `applyScreenResult()` 合并进本地 state，按钮/提示条/气泡一次对齐。
- 面板 `show()` 先 `GET /state` 同步一次（不再显示上次的旧画面），未读小圆清零并直接贴到最新一条；`renderScreenHint` 与未读徽标改成每份状态都刷，不再被 seq 去重挡掉。
- 翻开历史（`expanded`）时不抢滚动、只加未读数；图片加载失败显示 `.pic.missing` 占位；图片高度 `min(240px, 42vh)`，有图气泡铺满内容宽。
- 发图：`POST /pic` 第三路不再只回 `needGenerate`，直接 spawn `state/agents/codex-gen.mjs`（走本机 Clash 代理、180 秒超时、忙时 202），失败仍回落给 agent 用 `/pic/image` 补发；每张图记一句 `notePic`，聊天时最近 15 分钟的 3 张作为 `【你刚在悬浮球里发过的图】` 注入，她知道图已经发出去了。
- `src/safe-fetch.js`：新增 `allowHosts` + `proxy` 选项（CONNECT 隧道，https 用 tls.connect）+ `hostMatchesAllowList`/`normalizePolicy`/`targetsFor`；白名单内域名跳过本机 DNS 校验（Clash fake-ip 把 qq 图床解析成 198.18.x.x，直连必被 SSRF 拦截）。
- `src/bridge.js`：`QQ_MEDIA_HOSTS` / `MEDIA_FETCH_OPTS`（`HTTPS_PROXY` 或 `http://127.0.0.1:7897`），5 处 `safeFetchBuffer` 全带上——QQ 表情图、头像、消息图片终于能取到。
- 拖拽：`clampForMode` 收起态保留 `PET_KEEP = 60` 的可抓边（宽高各 60，仍受桌宠尺寸一半限制），贴边不再只剩一点露出。
- 版本 0.9.2 → 0.10.0；`test-orb` 171 → 189 项全过；`test-audit` 80/83（既有三红）。
### 2026-11-01 00:40-00:55 悬浮窗 0.10.1~0.10.4（气泡贴着脑袋 / 大小滑条 0-100%）
- 桌宠气泡不再钉在窗口顶边：`pet.js` 的 `placeBubble()` 用 `video.getBoundingClientRect()` + `PET_HEAD_RATIO`（素材帧 640×360，头顶在 15.2% 处）算出她脑袋的实际位置，再把气泡的 `bottom` 设到头顶上方 8px；弹出、换动作、窗口 resize、改大小都会重算。
- 桌宠按 `pet-size` 放大：原来的 `height:100%` + `object-fit:contain` 会把 16:9 的整帧塞进竖窗，角色只剩 135px、还悬在窗口中间。改成 `height: calc(var(--pet-size) * 1.22)`（295/360 反推整帧），角色身高正好等于设置里的尺寸、脚站窗口底边，左右多出来的透明边由窗口裁掉。
- 气泡宽度：`left/right: 8px + width: fit-content + margin: 0 auto`，长句不再被挤成一两个字一行；`max-height: 96px`，预览截断 64 字（全文在面板里）。
- 右键「大小」滑条改为 **0-100%**（映射 120~320px），并且**松手（change）才改窗口**——拖动过程中改窗口会让菜单被重新夹位、滑条从指针底下溜走，那才是「一滑就跳很远」的根因。
- 版本 0.10.4；`test-orb` 189 → 196 项全过。
### 2026-11-01 00:56 悬浮窗 0.10.5（把气泡的小尾巴还回来）
- 0.10.4 把限高 `max-height:96px; overflow:hidden` 写在 `#bubble` 上，而小尾巴是 `#bubble::after` 画在框外（`bottom:-6px`）的，被一起裁掉——气泡就成了纯圆角矩形、没有尖尖。
- 修法：`#bubble` 改回 `overflow: visible`，限高挪到里层 `<span id="bubbleText">`（`max-height:96px; overflow:hidden`）；`pet.js` 的 `showBubble()` 先找 `#bubbleText`、找不到才回落到 `#bubble.textContent`。
- `test-orb` 196 → 198 项（新增：气泡框不许裁剪、文字走里层 span）。版本 0.10.5。### 2026-11-01 09:40-10:10 悬浮窗 0.11.0（气泡图文一体 / 聊天配图 / 发送即清空排队 / 图片等比缩放）
- **气泡图文一体**：新配置 `chat.richBubble`（默认开）。开：一条消息的图和字画在同一个气泡里（图在上、字在下）；关：拆成图气泡 + 文字气泡。面板 `renderMessages()` 用 `makeBubble()` 分流，头顶气泡 `maybeBubble()` 也跟着传 `image`。
- **聊天里也能配图**：新配置 `pic.attachToChat`（默认关）。开了之后她在回复里写一行 `[[配图: 画面描述]]`，服务端把它从文本里剥掉（历史里也不留），再用 `pickPic()` 挑一张现成的图（QQ 收藏表情 → 本地图库，**不现场生图**，那要等一分钟），图和字合成一条消息。
- **挑图逻辑复用**：`/pic` 里那两段（QQ 表情 / 本地图库）抽成 `pickPic({hint,source,cfg})`，`/pic` 和聊天配图共用；`/pic` 的返回结构不变。
- **发送即清空 + 排队**：面板 `send()` 先把输入框清掉再 `POST /chat {text, queue:true}`（15 秒超时）；服务端 `chatQueue`（上限 20）+ `pumpChatQueue()` 一条条回，失败只落一条 `kind:'system'` 提示不堵后面；`/chat` 排队分支立刻回 **200** `{queued, position}`（客户端把非 2xx 当失败，不能用 202）。`stateForOrb().chat.queue` 带 `{pending,busy}`，球上转圈、面板不自动收起。
- **图片等比缩放**：删掉 `.bubble.haspic .pic{width:100%}`（会把小图放大、把气泡撑到 84%），改 `.bubble .pic{width:auto;height:auto;max-width:100%;max-height:min(240px,42vh);object-fit:contain}`；头顶气泡新增 `#bubble .bubblePic`（`max-height:72px`、`width:auto`），带图时 `#bubbleText` 收到 48px，图 `onload` 后重算 `placeBubble()`。
- 设置页「悬浮窗发图」新增「聊天里也能配图」「气泡图文一体」两行开关。
- `test-orb` 198 → 226 项。版本 0.11.0。

### 2026-11-01 10:35 悬浮窗 0.11.0 补修（配图标记取 rawReply / 挑表情拿得到主人 QQ）

- `pet-chat.chat()` 额外返回 `rawReply`（未剥标记的原话）；`orb-api.runChatTurn()` 改用它匹配 `[[配图: …]]`——之前拿 `reply.text`（已剥）匹配，永远匹配不到，配图开关全开也不出图。
- `plugins/surfcore/lib/index.js` 把 `adminQQ: () => adminQQ`（空引用，调用即 ReferenceError，被 catch 吞掉）改成 `() => deriveIdentDefaults().meQQ`，QQ 收藏表情挑图链路恢复。
- 说话规则补强：明确「不写标记就只收到一行字」并给示例。
- `test-orb` 226 → 229 项（rawReply / 挑表情 QQ 号 / 设置页两条回归契约）。

### 2026-11-01 11:05 撤掉 QQ 近况原文互通（回归衰减记忆卡）

- 0.12.0 里加的「把最近 12 条 QQ 私聊原文拼进悬浮窗提示词」（`chat.shareQqRecent` / `recentQqLines` / 【你们刚在 QQ 上聊的】/ 设置页「聊天记忆」开关）整段移除。
- 原因：悬浮窗聊天本来就走 `memoryCardPromptBlock('qq')`，和 QQ 共用同一张衰减记忆卡；另拉原文既重复，又会把过期的话带进新对话。
- 设置页在原位置留一句只读说明：「记忆：QQ 和悬浮窗共用同一张衰减记忆卡，不用单独开」。
- `scripts/test-orb.mjs` 252 → 250：删 4 条原文通道契约，补 2 条回归（不再有原文通道 / 仍用同一张记忆卡）。

### 2026-11-01 11:40 悬浮窗 0.12.1（记忆三项互通 / 悬浮窗有自己的互通开关）

- **写路径本来就在跑**：悬浮窗聊天成功后会 `rememberEvents()` → `appendMemoryInboxEvent({platform:'pet'})`，维护器并进同一张衰减卡（活卡 600 条里 pet 已经占 49）。这一轮不是新造通道，而是把开关和读路径补齐。
- `plugins/surfcore/lib/orb.js`：新增 `chat.shareMemory`（默认开，`normalizeOrbConfig` 里 `!== false`）。
- `plugins/surfcore/lib/pet-chat.js`：`settings().chat.remember` 改成 `isOrb ? orbChat.shareMemory !== false : chat.remember !== false`——悬浮窗不再被桌宠的开关连坐；`memoryBlock()` 在悬浮窗关掉时直接返回空，读也一起停（写、读同一条线，不会只关一半）。
- `src/memory-card.js`：新增 `memoryCard.includePetInBili`（默认开）；`visibleFor()` 的 bili 分支放行 `scope==='pet'`；B站 上限表 `pet: includePetInBili ? 3 : 0`；B站 注入块 footer 增补「桌宠和私聊里的事是私事，别在 B 站公开复述」；完整卡表头说明同步。
- 设置页两处开关：「悬浮窗发图」段加「互通记忆」（`chat.shareMemory`），「记忆卡规则」段加「B站 提示词带桌宠 / 悬浮窗记忆」（`includePetInBili`）。
- 测试：`test-orb` 250 → 259（配置默认/归一化/settings 分流/读卡门/两个开关文案/记忆卡开关与 scope 放行）；`test-memory-card` 25 → 26（桌宠默认进 B站 且可关；B站 最多 3 条、敏感条目仍被挡）。
- 真机验证：开 → 聊一句 inbox +2 行 pet；关 → +0 行且她照常回话；`memory-card-prompt-bili.md` 维护后出现「## 桌宠（私下相处）」并带私事提醒。

### 2026-11-01 11:55 悬浮窗 0.12.1 补丁：B站 侧的桌宠记忆改成 fail-closed（代码层，不靠提示词）

- B站 注入只认 scope=pet && source=pet-self && screenSeen === false：和主人的私聊（pet-owner）、看屏幕时说的话（screenSeen）、缺标记的老记录一律不进（fail closed）。
- 再加一道隐私正则（联系方式 / 住址 / 单位学校 / 钱 / 健康 / 感情，以及 5 位以上数字串），命中的记录整条筛掉，连选都不选。
- 打标记：聊天轮按 desktop || image 判定 screenVision，主动搭话一律算看屏那侧；makeRecord 落 screenSeen。
- 结果：当前卡里 15 条 pet-self 全是复述屏幕（含 GitHub 密码页、验证码），B站 侧桌宠记忆 = 0 条，注入块回落到空（等价于 0.12.1 之前）。
- 测试：test-orb 263 → 266，test-memory-card 26 全过（新增：只带她自己那侧 / 隐私词整条筛掉 / 看屏幕不进 B站）。
- 补记：热重载不会刷新 pet-chat（ESM 缓存），因此 ingest 侧默认 fail-closed（`item.screenVision !== false`）；实测新记录 `screenSeen=true`、`memory-card-prompt-bili.md` 保持 0 字。
### 2026-11-01 12:05 悬浮窗 0.12.2~0.12.5（拖得到最上面 / 透明带不再挡点击）

- 拖不上去：`clampForMode()` 的上边界改成只夹宠物实体（`minY = area.y - (height - bodyH)`），允许头顶气泡带出屏；同时把 `applyBounds()` 里残留的 `clampToDisplay()`（整窗夹屏）换成 `clampForMode()`，`orb:dock` 松手时也别再把 y 拽回 `area.y`。她原来被 110px 的气泡带卡在半空，现在头顶能贴到屏幕最上沿。
- 挡点击：主进程每 90ms 轮询 `screen.getCursorScreenPoint()`，只有光标真的落在宠物实体（或正在显示的气泡带 / 打开的 HTML 覆盖层）上时才 `setIgnoreMouseEvents(false)`，其余时刻整窗穿透。渲染端新增 `orb:bubble-shown`（气泡显示/隐藏）、`orb:ui-hold`（右键菜单、看图打开/关闭）两个 IPC 报告。
- 实测：窗口在 y=10 时，头顶透明带 `WindowFromPoint` 命中下层窗口（穿透），她身上命中悬浮窗（可点）；向上拖到 `y=-110`，头顶正好贴屏幕顶。
- 版本 0.12.2 → 0.12.5（0.12.3/0.12.4 是同一处夹取逻辑的两轮返工），`test-orb` 266 → **271 全过**（新增 5 条契约：上边界只夹身体 / 主进程轮询穿透 / 只有实体+气泡带可点 / 气泡显示才留可点带 / 覆盖层整窗可点）。
### 2026-11-01 12:20 悬浮窗 0.12.6（左边吸附不再把她吸出屏幕）

- `orb:dock` 的左侧公式是 `area.x - width + visible`，桌宠模式 `visible = 0` 时等于 `-width`：在左边一松手，整只被吸到屏幕外（右侧那条碰巧是对的）。现在桌宠贴哪边就贴齐哪边（左 `area.x`、右 `area.x + area.width - width`），整只始终留在屏幕里；球模式保持原样。
- 版本 0.12.6，`test-orb` 271 → **272 全过**（新增「左边吸附不会把她吸出屏幕」契约；同步把「往上拖」那条的针改成 `const minY = area.y - (height - bodyH)`）。

- **2026-11-01 12:10–12:45 · 好友申请：AI 拍板 + 自动通过（两个开关）+ 待处理列表**
  - 新增 `src/friend-guard.js`（纯判定）：`FRIEND_DEFAULTS`、`normalizeFriendConfig`、`scopeVerdict`（整份 config 里读 `socialV2.friend`）、`dailyKey`、`decideFriend`（总开关 → 白名单范围 → 拒绝冷却 → 每小时 → 每天）、`buildFriendPromptLine`。
  - `src/bridge.js`：`bot.onRequest` 收 `request_type==='friend'` → `state/friend-requests.json`（上限 50）；`friendScopeOf` 遍历白名单群调 `get_group_member_info(no_cache)`，缓存 10 分钟、异常当不在；`applyFriendDecision`（通过前 force 复核 → `set_friend_add_request` → 记账/冷却 → 可选 `set_friend_remark` → 通知主人）；`autoApprove` 直接过，否则 `scheduleWakeV2(owner,'friendRequest')` 让 AI 拍板；唤醒提示新增【好友申请】段；`WAKE_PRIORITY.friendRequest=55`。
  - 路由：`GET /api/socialV2/friend-requests`、`POST /api/socialV2/friend-config`、`POST /api/socialV2/friend-decide`；MCP 新工具 `qq_friend_requests` / `qq_friend_decide`（旗标 `tools.friendRequests` / `tools.friendDecide`）。
  - 设置页 QQ 页新增「好友申请」卡片：允许 AI 拍板加好友 / 自动通过 / 只允许白名单范围内的人 / 通过后自动改备注 / 每小时 / 每天 / 拒绝冷却（天）+ 待处理列表与计数；文案写明「网关卡不支持主动加好友，这里只处理别人来加我们的申请」。
  - 测试：`scripts/test-friend-guard.mjs`（18 项）、`scripts/test-friend-wiring.mjs`（9 项，真 bridge.js + 夹具网关），`scripts/test-audit.mjs` 登记；审计 83/86（三红仍是 test-self-identity / test-identity-guard / test-version）。顺手修了 `test-stickers.mjs` 里一条过期断言。
  - 细节与坑见 PITFALLS #126。
### 2026-11-01 15:40 悬浮窗 0.12.9（头像真能显示 / QQ 号与头像路径生效）

- 修「设置里填了 QQ 号和头像绝对路径却不生效」：头像从来没显示过——面板是 `loadFile`（file://）打开的，`/avatar?who=her` 被解析成 `file:///avatar…`，永远 404，只能画字母点。现在 `avatarUrl` 直接给 `file:///C:/…`（`encodeURI` 处理空格/中文），CSP 的 `img-src file:` 本来就在。
- 复制文件地址自带的一对引号（`"C:\…jpg"`）现在在 `normalizeOrbConfig` 里剥掉（`stripQuotes`），否则 `existsSync` 恒 false。
- QQ 头像缓存改成按身份分文件名 `avatars/<who>-<sha1(file\0qq)>.png`：换号、换图就自动换文件，不会再被 7 天 TTL 钉在旧图上；下载走后台 `ensureAvatar`，不阻塞 `/state`。
- 版本 0.12.9；`test-orb` 272 → **276 全过**（file:// URL / 剥引号 / keyed 缓存 + 后台补 / 空 URL 不塞 src）。

### 2026-11-02 13:20 回复速度：原版 / 快回复两套参数（0.13.0）

- 新增总开关 `socialV2.reply.mode`：`legacy`（原版，默认）或 `fast`（快回复，仿 QQ-agent）。两组参数各自独立、互不读取——改一组不会悄悄影响另一组。
- `reply.legacy`：合并窗 8000ms、自然回复延迟 2000~8000ms、忙时接管关、换会话关、清理关。**这组的值与 0.12.x 的硬编码常量逐项相等**，所以「快回复关掉 + 原版换会话关掉」= 行为完全回到从前（`scripts/test-reply-mode.mjs` 盯着这条）。
- `reply.fast`：合并窗 800ms、起手停顿 150~500ms、忙时接管开、每 8 轮换一次会话、顺带清理旧会话（保留最近 50 个 / 7 天）。
- 换会话 `rotateSessionV2(key)`：只丢掉 LLM 上下文（`state.sessions[key]`），保留未读水位、`bootstrapSent`、seenId、agentToken，并把旧 sessionId 记进 `state.retiredSessions`；下次唤醒自动重建会话并照常补历史。
- 清理只删 `retiredSessions` 里自己换下来的会话（绝不按列表瞎删生活会话/俚语会话）。
- 忙时接管：回合进行中来的消息，回合结束后**立刻**投递积压原因，而不是再叠一次合并窗。
- 每回合结束打一行 `回合结束 key=… mode=… 第 N 轮 用时=XXs 轮换=yes/no`；新增 `GET /api/socialV2/latency` 看当前组参数、各会话轮次/会话 id/积压、以及本次进程内的回合耗时取样。
- 设置页「SurfCore → 扩展」新增三组：回复速度（总开关）/ 原版回复 / 快回复。保存后需重启 QQ 桥接。
- `scripts/test-reply-mode.mjs`（28 项）盯住「legacy 默认 = 旧常量」「两套键不共用字段」「接管/换会话/清理的接线」。
### 2026-11-02 16:05 换会话 0.13.2：到点当场建出新会话（失败回滚）+ 关掉能回原会话 + 回复参数热重载

- `rotateSessionV2` 改成 async：先记住 `originalSessionId`，删除映射后**当场** `await ensureSession(key)` 建新会话；建不出来就把 `state.sessions[key] = old` 放回去并记日志「已回滚到旧会话」。上一版只 delete 映射，日志照样打「换会话」，实际 DSH 里一条新会话都没有（15:18 那次现场）。
- 新增 `backfillOriginalV2` / `restoreSessionV2` / `reconcileReplyModeV2`：换会话开关一关（启动 / 保存配置 / config.json 被外部改动三处触发），把还在换出来的会话里的对话搬回原会话；latency 每会话加 `originalSessionId` / `rotated` / `unbound`。
- 新增 `startReplyConfigWatch()`：每 3 秒比对 config.json 的 `mtimeMs:size`，变了只热加载 `socialV2.reply` 子树并 `syncReplyDelayV2` —— 设置页改完不用重启桥接。
- 新端点 `POST /api/socialV2/session`（action 取 rotate / restore，restore 不带 key = 全部），插件转发放行 `/api/socialV2/session` 与 `/api/socialV2/latency`；设置页「回复速度」页新增「会话」卡片：立即换一次会话 / 回到原会话 + 每个会话的轮次与状态。
- `scripts/test-reply-mode.mjs` 43 → **62 项全过**（rotate 当场建会话、失败回滚、原会话记录与反推、restore 不碰未读水位、reconcile 只在关掉时动作、启动顺序、watcher 只换 reply、端点两种 action、设置页按钮与文案）。

### 2026-11-02 16:45 换会话 0.13.3：定时任务跟着走 + 旧会话处置变成开关

- 换会话时先读出旧会话（含该会话退役链上的前几条）挂着的 DSH 自动化任务，把清单挂到会话状态 `tasksToInherit` 上；下一轮唤醒的提示词里追加【换会话：把旧会话的定时任务接过来】块，让她用 `schedule_create` 逐个重建（title / prompt / 时间规则照抄，不合并、不改文案）。
- 回合收尾核对：新会话里出现同名 title 才算迁完，确认后 `schedule.delete` 删掉旧任务；全部迁完才处置旧会话。
- 旧会话处置受新开关「换会话后删除旧会话」控制：默认关 = 只归档（还能「回到原会话」）；开 = 直接删。清理旧会话（cleanup）也走同一个开关，不再无条件 `api.sessions.delete`。
- 原版 / 快回复两组各有一套 `sessionRotate.inheritTasks`、`sessionRotate.deleteOld`，互不共用；`latency` 每会话多一个 `tasksToInherit` 数，方便看还有几条没迁。
- 为什么必须让她重建：DSH 的 schedule 明确不支持跨会话改绑或转交，`schedule.create` 也没有对外 RPC，只有会话里的 agent 能通过工具创建。
- `test-reply-mode` 62 → 73 项全过。

### 2026-11-03 00:30 等待/潜水 0.13.4：沉睡前观察不再被「连续等待 2 次」卡死

- 修一个真实死锁：一个回合最多连续等 2 次（10 分钟内，purpose="reply" 的短静默也算），而「想潜水必须先安静等满观察窗口」要求的那次等待正是第 3 次 → 被限流拒掉；改去设置唤醒/标记已读，又被「还没观察够」拒掉，模型只能在两条互相矛盾的提示之间打转（qq_wait_for_messages → 设置唤醒失败 → 标记已读失败 → 再等待…）。
- 沉睡前观察（purpose="messages" 且 timeoutMs >= preSleepWaitMs 且门还没放行）现在不受连续等待上限拒绝，只豁免这一次，仍然计入配额，不给人拿来无限等。
- 被限流拒绝时回包不再骗人：门没过就 shouldSleep:false，并给出 nextStep（等满后再观察一次）、alternative（qq_close_conversation 自然收尾不需要观察）、retryAfterMs；门过了才是原来那句「去设置下一次唤醒」。
- 「还差多久」原先在 mark_read / set_wake_config / wait 三处各算一遍，抽成 preSleepWaitRemainingV2(st)；被门拦住时统一用 preSleepGateErrorV2(st, verb) 回包（带 retryAfterMs + 替代路径）。
- 观察等满（preSleepSatisfiedNow）与收尾成功（mark_read / set_wake_config）后都会清掉该会话的连续等待配额（resetWaitStreakV2(key)），下一轮不再被旧计数卡住。
- 兼容性：没有新增必填配置项、MCP 工具签名未变、错误回包只追加字段、限流常量与租约语义保持不变；preSleepWaitMs 仍是可选数（默认 300000，最小 10000）。
- scripts/test-wait-gate.mjs 新增 22 项契约；test-reply-mode 73 项仍全过。

### 2026-11-03 01:45 换会话 0.13.5：定时任务继承的两个真 bug（把刚建好的任务当旧的删了）

- **采集来源含当前会话**：`collectInheritTasksV2` 原来把 `current` 也当来源，结果「唤醒前兜底收集」每次都把新会话里刚建好的任务收进待迁清单，收尾核对再按同名把它们删掉 —— 表现就是「任务建了又没了」。现在只收**换下来的会话**（`extraSources` 只在换会话那一刻传旧会话），当前会话里的任务永远不算待迁。
- **待迁清单没持久化**：`tasksToInherit` 只存在内存里，桥接一重启清单就空 → 那句话「要迁到新会话」再也不会出现。现在 load/save 都带上它。
- 收尾核对再加一道保险：`item.sessionId === current` 的一律不删。

### 2026-11-05 09:30 回复速度 0.13.6：三个开关按真实语义重做（关了就完全不动会话）

- **真 bug**：`inheritTasks`（默认开）在「没有任务要迁」时直接调 `disposeSessionV2` 归档旧会话；`verifyInheritTasksV2` 迁完任务也会处置来源会话。归档 = 会话从列表里消失，看起来就是「清理旧会话 / 删除旧会话都没开，却被清理了」。现在两个开关关着时，换会话只建新会话，旧会话原样保留（日志「旧会话保留（换会话清理未开）」）。
- **语义对齐**：
  - `sessionRotate.cleanupOld`「换会话清理」（默认关；旧键 `inheritTasks` 只当别名读）：开 = 换会话时先把旧会话的定时任务迁到新会话，迁完（或本来没有任务，立刻）按 `deleteOld` 处置旧会话。
  - `sessionRotate.deleteOld`「处置时直接删除」（默认关）：只在「要处置」时生效——关 = 归档（还能「回到原会话」），开 = 真删掉。
  - `cleanup.enabled / keep`「按数量清理旧会话」：按会话 key 分组、每个 key 保留最近 N 个换下来的，第 N+1 个起才处置；`cleanup.days` 改成附加条件（默认 0 = 不限），不再单独按天删。
- 两条硬规则：**带活动定时任务的会话不处置**（先 `schedule.list` 查，有任务就跳过并记日志）；**当前会话和 `originalSessionId` 永远不清理**。
- `test-reply-mode` 82 项全过（新增 8 条契约），`config.json` 两组的 `cleanupOld` 都显式写成 false。

### 2026-11-05 12:30 回复速度 0.13.7：合并成「换会话清理」一个开关（开=删 / 关=归档） + 清理严格按会话分开

- 上一版（0.13.6）拆成「换会话清理 / 处置时直接删除」两个开关，语义重叠、界面上看不出区别：关着时旧会话还会被 `stopRetiredSessionWork` 顺手归档（用户看到的就是「开关没开也会话被清理了」）。
- 现在只剩一个 **换会话清理**：
  - **开** = 换会话后先把旧会话的定时任务迁到新会话（`schedule_create` 重建 → 桥接核对 → 删旧的），迁完（或本来没任务就立刻）**删除**旧会话：DSH 没有删除会话的接口（`session.delete` / `sessions.delete` / `workspace.deleteSession` 实测全 404），所以「删除」= 先 `workspace.archiveSession({stopActivity:true})` 从列表移走，再把 `~/.dsh/sessions/<proj>/<sessionId>/` 整个目录挪进 `~/.dsh/surfcore/trash/sessions/`——DSH 再也找不到它；
  - **关** = 同样先迁任务，迁完/即刻**归档**旧会话（还能「回到原会话」），不是删除。
  - 迁移与开关解耦：**迁任务永远做**，开关只决定「迁完之后删还是归档」。
- `stopRetiredSessionWork` 新增只停工作不停档的兄弟函数 `stopSessionWorkOnly`：换会话只停 DSH 侧工作，处置完全交给 `disposeSessionV2(sessionId, why, mode)`。
- `restoreSessionV2` 切回原会话前先 `workspace.unarchiveSession`，否则「回到原会话」只是改指针，DSH 侧还是归档态。
- 清理严格按会话 key 分开：`retiredSessions` 里没有 `key` 的老条目一律跳过（以前会落进空 key 组，别人的换会话可能连带清掉），每个 key 各自保留最近 N 个；按数量清理是真删（用户要的是「清除」），但仍受「带活动定时任务的会话不处置」保护。
- 设置页：删掉「处置时直接删除」，两个分组各剩「换会话清理」「按数量清理旧会话」「保留最近几个」「额外要求超过几天」。
- 兼容：旧配置里的 `deleteOld` / `inheritTasks` 都只当别名读（任一为真 → 换会话清理=开）；不新增必填键，回包与端点形状不变。
- 回收站只是「从 DSH 视线里拿走」，文件还在 `~/.dsh/surfcore/trash/sessions/`，要彻底清空得手动删目录——桥接不替用户做不可逆的 rm。

## 2026-11-07 18:40–21:10 同步上游 v0.8.9（34 个 release）

- 先统一行尾为 LF（`9d2f7ab`）再一次性 merge 上游 `0ce8580`（`584f519`，26 个冲突路径全部人工合并）。
- 修合并后暴露的 16 个失败用例（`168af84`）：wait 分支引用不存在的 `waitSeen/known/incomingAt` 导致 wait 500、`ensureSession` 里混进孤儿模型块、`buildWakePromptV2` 源码形状、`session-rollover` 的 `batchMs`/`sessionBaseTokens`、`composePersonaLayers` 的 `identity:`、`wellFormed()` 孤立代理项、主题 token 名、语音包缺环境文案、自表达 JSON 解析器、预设与安装清单重生成。
- 结果：`scripts/test-audit.mjs` 173/173 全绿（同步前 93/97）；插件链 40/42（红项仍是既有 `test-updates` / `test-host-smoke`）。
- 决策表与 34 个 release 的核对见 `docs/sprintkey/UPSTREAM-SYNC.md`。
## 2026-11-08 12:10 回复速度：新增「会话绑定」三级页（群号 / 私聊 QQ 号 ↔ session id）

- 「回复速度」页里，原版组和快回复组下面各多一个入口「会话绑定 · 原版 / 快回复（群号 / 私聊 QQ 号 ↔ session id）」，点开是独立页面（`ChatSessionEditor`），不写 `config.json`。
- 页面列出白名单里的每个群/私聊：当前绑定的 session id、第几轮、原会话 / 已换会话 / 无会话；可以改成别的 session（留空 = 解绑），顶部可展开「最近会话」直接挑。
- 后端新增 `GET /api/socialV2/chats`（合并 `socialV2.conversations` / `state.sessions` / `cfg.allow`，附 `sessions.list` 最近 20 条）；`POST /api/socialV2/session` 新增 `action:"bind"`：校验 id 格式、DSH 里是否存在、是否已被别的号占用、是否正在跑回合（409）；生效时同步 `sessionPolicies` / `reverse` / `originalSessionId` / `turnsSeeded=false` / `sessionBaseTokens`，**不动旧会话**（不归档、不删除、不迁任务）。
- 两个接口都进 `adminOnlyV2Paths`（带 agent token 一律 403）；插件转发白名单加 `/api/socialV2/chats`。
- 测试：`scripts/test-reply-mode.mjs` 87 → 97（新增 10 条契约）；`plugins/surfcore/scripts/test-client-contract.mjs` +7。
