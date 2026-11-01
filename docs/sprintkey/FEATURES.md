# Sprintkey 自定义功能清单（FEATURES）

这份文件回答一个维护者最常问的问题：**我们自己加的东西有哪些、在哪、怎么开、怎么验证。**
上游功能不在本表；每条功能都标了「入口 / 代码 / 配置 / 接口 / 注意」，改之前先看这里。

> 记录时间：2026-11-01（2026-10-28 基线之后陆续新增；11-01 补了 13~18 条：本地模型2 / 自动发图 / 图文同条+原生表情 / MCP 自愈 / 悬浮窗 / 悬浮窗 0.12.0）
> 改动过程见 [`../CHANGELOG.md`](../CHANGELOG.md)；升级流程见上游文档。

## 总表

| # | 功能 | 入口（设置页） | 主要代码 | 配置键 |
| --- | --- | --- | --- | --- |
| 1 | 扩展工具投递（发图 / 文件 / 视频） | SurfCore → Sprintkey扩展插件 | `src/bridge.js`、`src/mcp-snowluma-safe.js` | `socialV2.tools.sendMedia`、`socialV2.media` |
| 2 | 思考强度（会话级 + 应用范围） | SurfCore → Sprintkey扩展插件 | `src/bridge.js` | `dsh.reasoningEffort`、`dsh.reasoningEffortMode` |
| 3 | 模型选择（读清单 + 会话内可换） | SurfCore → Sprintkey扩展插件 | `src/bridge.js`、`src/mcp-snowluma-safe.js` | `dsh.provider`、`dsh.model` |
| 4 | 跨会话共享记忆段 | SurfCore → Sprintkey扩展插件 | `src/bridge.js` | `socialV2.crossMemory` |
| 5 | 语音包 Python 环境自动补装 | SurfCore → 语音 → 语音包卡片 | `src/voice-packs.js`、`plugins/surfcore/lib/client.js` | `voicePacks.*`（无开关，按需自动） |
| 6 | QQ 预设对齐原生工具集 | Agent 预设（qq-chat-v2） | `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` | 预设文件本身 |
| 7 | 工具守卫三档（open / balanced / strict） | Agent 预设（qq-tool-restrict） | `plugins/surfcore/qq-tool-restrict.mjs` | 预设里 `config.mode` |
| 8 | 管理员卡片本地草稿（不再丢 B站 mid） | SurfCore → QQ | `plugins/surfcore/lib/client.js` | 无（纯前端） |
| 9 | 全量记忆卡备份（本地 + QQ） | SurfCore → Sprintkey扩展插件 → 记忆 | `src/memory-backup.js`、`src/bridge.js` | `socialV2.memoryCardBackup` |
| 10 | QQ 签名 · 空间动态 | SurfCore → QQ | `src/self-expression.js`、`src/bridge.js` | `socialV2.selfExpression` |
| 11 | 日记（本地 + 只发主人） | SurfCore → 日记 | `src/diary.js`、`src/bridge.js` | `socialV2.diary` |
| 12 | Sprintkey 子设置分页 | SurfCore → Sprintkey扩展插件 | `plugins/surfcore/lib/client.js` | 无（纯前端） |
| 13 | 本地模型2 · 肥鱼 CosyVoice3（第三个语音包，音色自动探测） | SurfCore → 语音 → 语音包卡片 / 使用区三个单选 | `src/voice-packs.js`、`<语音包源目录>` | `socialV2.voice.tts.route`、`speaker`、`endpoints.feiyu` |
| 14 | 自动发图（QQ 表情 / 本地图库 / 现场生图 三来源 + 降级链 + 偷图收藏） | SurfCore → 发图 | `src/pic-auto.js`、`src/bridge.js`、`src/sticker-semantics.js` | `socialV2.pic`、`socialV2.sticker.collect` |
| 15 | 图文同条 + QQ 表情原生发送 | SurfCore → 发图 → 节奏 / 来源 · QQ 表情 | `src/bridge.js`（`sendMergedTextPicV2` / `sendTextBubbleV2` / `sendStickerV2`） | `socialV2.pic.combineText` |
| 16 | MCP 三行自愈（补丁被冲掉就补回） | 无界面（桥接启动自动） | `src/bridge.js` 的 `ensureMcpEntries()`、`scripts/setup-dsh.mjs` | 无 |
| 17 | 悬浮窗（桌宠浮窗 + 对话面板） | SurfCore → 悬浮窗 / 桌面自动出现 | `plugins/surfcore/assets/orb-app/`、`plugins/surfcore/lib/{orb,orb-api,pet-chat}.js` | `socialV2.orb` |
| 18 | 悬浮窗 0.12.0：气泡自适应 / 已读水位 / 双击看图 / QQ 近况 | SurfCore → 悬浮窗 → 聊天记忆等 | 同上（`orb.css` / `main.js` / `pet.js` / `orb.js` / `pet-chat.js`） | `socialV2.orb.chat.shareQqRecent` |

---

## 1. 扩展工具投递（qq_send_image / qq_send_file / qq_send_video）

- **做什么**：让 QQ 会话能真的把图片 / 文件 / 视频发出去（不是只回文字标记）。模型只要给出本地绝对路径或 http(s) 链接就行。
- **MCP 工具**：`qq_send_image`、`qq_send_file`、`qq_send_video`（`src/mcp-snowluma-safe.js`，开关标志 `sendMedia`）。语音仍走 `qq_send_voice`。
- **后端**：`POST /api/socialV2/send-media`，body `{ key, token?, path | url, kind?, name?, dryRun? }`；`dryRun:true` 只解析不发送。
- **限制**：图片 ≤ 20MB、其它 ≤ 100MB；本地文件必须存在；只允许发到自己那个会话（reserved2 会话令牌 + 静默/限流/鱼群保护照旧）。
- **设置页**：Sprintkey扩展插件 → 扩展工具投递（开关 + 上限 + 接口说明）。
- **验证**：`qq_send_image` 发一张本地图，拿到非空 `messageId` 即通；失败先看桥接日志里 `send-media` 那段。

## 2. 思考强度（会话级）

- **做什么**：决定 QQ 会话用 low / high / max 哪一档推理。
- **两种应用范围**（`dsh.reasoningEffortMode`）：
  - `all`：所有会话强制用插件里的档位；
  - `session`（默认）：默认跟随插件，但单个会话可以用 `qq_set_reasoning_effort` 单独改。
- **接口**：`GET/POST /api/dsh/effort`（全局，写 config）；`GET/POST /api/socialV2/effort`（单会话，写 `state.sessionEffort[key]`）。
- **注意**：DSH 模型清单里的 `off` 档不能直接透传，会被 `normalizeReasoningEffort` 拒掉；前端只展示 low/high/max。

## 3. 模型选择（会话级）

- **做什么**：模型清单从 DSH 自动读，不再手填 id；`session` 模式下每个群/私聊可以各自换模型。
- **接口**：
  - `GET /api/dsh/model` → 当前选择 + 完整清单 `catalog[{provider,name,models[{id,name,efforts,defaultEffort}]}]`；
  - `POST /api/socialV2/effort` 的 body 也接受 `provider` / `model`，传 `inherit` 撤销覆盖；
  - MCP：`qq_get_model_catalog` 查清单、`qq_set_reasoning_effort({model,effort})` 改本会话。
- **状态**：`state.sessionModel[key]`、`state.sessionEffort[key]`。
- **坑**：MCP 读 `/api/dsh/model` 必须带 `x-agent-token`；设置卡前端走插件前缀 `/dsh-surfcore/api/dsh/model`（插件里做了转发，见 `plugins/surfcore/lib/index.js` 的 `handleDshModel`）。

## 4. 跨会话共享记忆段

- **做什么**：主人在私聊里聊的内容（`activeTopic` 记忆），在群聊唤醒时也注入一段，让群里也接得上上下文。私聊自己不注入（避免复述）。
- **配置**：`socialV2.crossMemory = { enabled, maxTopics(默认 3), ttlHours(默认 72) }`。
- **接口**：`GET /api/socialV2/cross-memory/preview?key=group:<群号>` 预览会注入什么。
- **注意**：要真的生效得满足两条 —— 私聊里确实有 `activeTopic` 记忆；群在 `allow.groups` 白名单里。

## 5. 语音包 Python 环境自动补装

- **做什么**：模型下好了但 `.venv` / `.venv-gsv` 缺失时，不再逼用户「卸载→重装」，而是单独补 Python 环境。
- **入口**：SurfCore → 语音 → 语音包卡片上的「安装 Python 环境」按钮（自动模式：启动时缺环境自动补）。
- **接口**：`POST /api/voice/packs/env-repair`，body `{"id":"voice-local"}`，需要控制台令牌；`GET /api/voice/packs` 里每个包多 `env` 与 `envRepair` 字段。
- **详情**：见 `docs/PITFALLS.md` 第 #92 条。

## 6. QQ 预设对齐原生工具集

- **做什么**：QQ 会话不再被剥掉本地工具（pwsh / fs / fs-search / jobs / subagent 等），只有 `qq-tool-restrict` 白名单与 persona 规则兜底。
- **文件**：`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`（改完必须跑 `node scripts/build-agent-preset-patches.mjs` 重新生成 `plugins/surfcore/presets/qq-chat-v2.patch.yml`）。
- **注意**：surfcore 的 YAML 加载器不认 `!!js` 标签，预设里别写平台条件行；这些文件是 CRLF，改的时候按行号 splice。

## 7. 工具守卫三档

- **做什么**：`qq-tool-restrict.mjs` 的 `config.mode`：
  - `open`：放行全部（我们默认，QQ 会话等同原生 DSH）；
  - `balanced`：只掐本地执行面（pwsh / fs 等）；
  - `strict`：只留 QQ MCP + 无害模型侧工具。
- **注意**：契约测试 `scripts/test-preset-local-tools.mjs` 会断言「preset 里的 mode 与守卫实现一致」，改档位要一起改测试。

## 8. 管理员卡片本地草稿

- **做什么**：SurfCore → QQ 的管理员卡片（QQ 号 / B站 mid / 称呼）改成先存组件本地草稿，再落盘；不会再因为重渲染把刚填的 mid 抹掉。
- **代码**：`plugins/surfcore/lib/client.js` 的 `AdminCard`。

## 9. 全量记忆卡备份（本地 + QQ）

- **做什么**：把当前角色的全量记忆卡（`memory-card-full.jsonl` + `.md` + stats）镜像到指定目录；按天数定时同步；可再私聊发给主人。
- **入口**：SurfCore → Sprintkey扩展插件 → 记忆 → 「全量记忆卡备份（本地 + QQ）」。
- **配置**：`socialV2.memoryCardBackup = { enabled, dir, syncEveryDays(默认1), send:{ enabled, everyDays(默认7), maxSendMB(默认90) } }`；默认全关；`dir` 留空 = `<DSH_HOME>\surfcore\memory-backups\<角色ID>`。
- **接口**：`GET /api/socialV2/memory-card-backup` 看状态；`POST {action:"backup"|"send"|"both"}` 手动执行（绕过开关）。
- **调度**：桥接 60 秒 tick；到期就备份；关机错过靠状态文件在下次启动补一次；备份失败 10 分钟重试、发送失败 30 分钟重试；QQ 离线不推进 `lastSendAt`，上线后补发。
- **注意**：备份是「镜像 + 增量」（jsonl 续写，目标更大则整份重写），不是按日期快照；发送只读源文件，只私聊 `admin.qq` / `ownerQQ`，不发群；单文件超 `maxSendMB` 直接拒发并记错误。
- **验证**：`scripts/test-memory-backup.mjs`（13 项）；真实手动备份 560341B，三文件 SHA-256 与源一致；状态文件 `<DSH_HOME>\surfcore\memory-card-backup.json`。

## 10. QQ 签名 · 空间动态

- **做什么**：让 AI 按模式改 QQ 个性签名、发 QQ 空间动态。
- **模式**：每项 `off` / `auto` / `1d` / `3d` / `7d`；`auto` 每天 `hour` 后用「温度」让 AI 决定发不发；固定档到期必发。
- **配置**：`socialV2.selfExpression = { signature:{mode,temperature,hour,maxChars}, qzone:{mode,temperature,hour,visibility,maxChars} }`；`visibility` 1 所有人 / 4 好友 / 64 仅自己。
- **接口**：`GET/POST /api/socialV2/self-expression`，action=`status|signature|qzone`，`force:true` 绕过模式。
- **实现**：内部会话 `life-agent`（仿黑话学习，事件不往 QQ 发）生成文本；签名走 `onebotAction('set_self_longnick')`，动态走 `send_qzone_msg`；状态在 `<DSH_HOME>\surfcore\self-expression-state.json`。
- **注意**：「温度」是 prompt 层的表达欲，不是采样参数；动态默认好友可见，测试时可临时改 64（仅自己）验证链路。
- **验证**：`scripts/test-self-expression.mjs`；真实签名用 `get_stranger_info` 回读 `long_nick`；动态用 `get_qzone_msg_list` 回读 `is_private`；截图 `ui-self-expression-qq.png`。

## 11. 日记（本地 + 只发主人）

- **做什么**：按间隔自动写一篇 Markdown 日记；可自定义目录；可只私聊发给主人。
- **配置**：`socialV2.diary = { enabled, dir, everyDays(默认1), hour(默认22), maxChars(默认1200), send:{enabled,withFile} }`；默认全关。
- **路径**：选目录后存 `<dir>/<角色ID>.md`；留空 = `<DSH_HOME>\surfcore\diary\<角色ID>.md`。
- **目录选择器**：设置页「浏览…」打开自绘 `DirPicker`（列 C/D/E 等盘符、进目录、手输路径 + 前往），不再依赖系统 `FolderBrowserDialog`；后端 `GET /dsh-surfcore/api/browse-list?path=`。
- **接口**：`GET/POST /api/socialV2/diary`，action=`status|write|send`；`force:true` 绕过开关。
- **发送**：只私聊 `admin.qq` / `ownerQQ`，可附 `.md` 文件；QQ 离线写 pending，上线补发；状态在 `<DSH_HOME>\surfcore\diary-state.json`。
- **验证**：`scripts/test-self-expression.mjs`；真实发送 19:37:00 正文 + 19:37:02 `char-mvrnvr2i.md`；`ui-dir-picker.mjs` 全流程；截图 `ui-self-expression-diary.png`、`ui-dir-picker-*.png`。

## 12. Sprintkey 子设置分页

- **做什么**：Sprintkey 从「一页 8 个折叠分组」改成「一页一个子设置」的二级页签。
- **页签**：模型与思考 / 记忆 / 声线 / 跨会话共享 / 世界树 / 工具投递 / 投递上限 / 投递接口。
- **代码**：`plugins/surfcore/lib/client.js` 的 `SubTabs`、`SPRINTKEY_PAGES`、`SprintkeyTab`；`Section` 新增 `hidden`；父组件 `sprintkeyPage` 保存当前页。
- **注意**：`.qbw-subtab.on` 必须用中性底色（`rgba(127,127,127,.16)`），不要用 `--dsw-alias-brand-primary`（深色主题下会解析成白底白字）。
- **验证**：`scripts/test-client-contract.mjs` 断言页签与控件；`ui-sprintkey.mjs` 8 页 + 草稿跨页 + 窄窗 + 焦点全过。

## 13. 本地模型2 · 肥鱼 CosyVoice3（第三个语音包）

- **做什么**：本地第二个语音包（CosyVoice3 zero-shot），音色数由包内 `references/*.wav` **自动探测**（现在是 `cute` 可爱 / `gentle` 温柔 两个）；支持逐字清唱与真 SVS 按谱唱歌。
- **入口**：SurfCore → 语音 → 语音包卡片「本地模型2 · 肥鱼 CosyVoice3」；顶部「使用」区三个单选（本地语音包 / 云端语音包 / 本地模型2），同一时间只跑一个，切换自动停另一个。
- **主要代码**：`src/voice-packs.js`（`DEFAULT_MANIFESTS` 的 `voice-feiyu`、`detectVoices()`、`statusOne()` 的 `autoVoices` 标记）、包体 `<语音包源目录>`（`adapter_server.py`、`run.bat`、`stop.bat`、`scripts/fetch-models.mjs`、`scripts/bootstrap-env.mjs`、`scripts/svs/*`）。
- **配置键**：`socialV2.voice.tts.route`（`local` / `feiyu` / `cloud`）、`socialV2.voice.tts.speaker`（`cute` / `gentle`）、`socialV2.voice.tts.endpoints.feiyu`（默认 `http://127.0.0.1:8766`）。
- **接口**：适配器 `GET /v1/health`、`GET /v1/voices`、`POST /v1/speak/file`（直接回 wav 字节 + `X-Duration-Ms`）；桥接 `/api/voice/packs`（卡片数据）、`/api/voice/packs/test`、`/api/voice/rules`（切 route/speaker）、`/api/voice/send`；MCP `qq_send_voice`、`qq_send_song`。
- **注意**：
  - 端口 **8766**，模型与 venv 用 junction 接到 `<本地模型2目录>`（`models` / `.venv` / `vendor\CosyVoice`），重装包不用重下 12GB。
  - Windows 上**绝对不能**留 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`：模型能加载，但第一次推理必抛 `CUDA error: unknown error`（见 PITFALLS #103）。
  - 切音色只重载 llm 权重，约 3.5~5.5 秒；冷启动加载 45~90 秒，这期间发语音会失败。
- **验证**：`GET /api/voice/packs` 里 `voice-feiyu` 为 `installed=true running=true voices=[cute,gentle]`；`/api/voice/packs/test` 出 wav；两个音色各合一句，24kHz 单声道。

## 14. 自动发图（QQ 表情 / 本地图库 / 现场生图）

- **做什么**：AI 说完一句话后，按当时的语境决定要不要补一张图；三来源按开关与权重挑，挑不到会走降级链，宁可少发也不冷场硬凑。
- **入口**：SurfCore → 发图（总览 / 节奏 / 来源 · QQ 表情 / 来源 · 本地图库 / 来源 · 现场生图 / 什么时候发 / 收藏 · 偷图 / 安全）。
- **主要代码**：`src/pic-auto.js`（纯决策层：`decidePicSource`、`picFallbackChain`、`pickStickerFor`、`pickStickerLoose`、`pickLocalImage`、`buildImagePrompt`、`buildPicPromptLine`）、`src/bridge.js` 的 `maybeAutoPicV2` / `pickPicForCombineV2` / `sendLocalImageV2` / `queuePicGenerateV2` / `recordPicSentV2`、`src/sticker-semantics.js`（情绪识别与贴合度）。
- **配置键**（`socialV2.pic`）：`enabled`、`maxPerTurn`、`minGapMs`、`maxPerHour`、`quietFrom/quietTo`、`scopes`（私聊/群/群黑白名单）、`textFirst`、`dedupeHours`、`scenes`（19 个情绪开关）、`seriousGuard`、`sources.{sticker{enabled,weight,minScore,annotatedOnly,looseFallback}, local{enabled,weight,dirs,emotionSubdir,warmth,keywords}, generate{enabled,weight,warmth,style,stylePresets,promptPrefix,maxPerDay}}`、`combineText`；偷图额度在 `socialV2.sticker.collect.{enabled,maxPerDay,taste}`。
- **降级链**：`picFallbackChain` 按 `sticker → local → generate` 只保留开着的与可用的；如果只剩表情这一路、严格匹配又挑不到，`looseFallback` 开着就 `pickStickerLoose` 随手挑一张最常用的。生图一路桥接**没有程序入口**（dsh-image-gen 不暴露 HTTP），只能写 `st.pendingPicGenerate` 并在唤醒提示里让 agent 自己调 `generate_image`，再用 `qq_send_image` 发。
- **接口**：`GET /api/socialV2/pic-status`（素材数 / 今日已发 / 最近记录 / lastSkip / lastError / pendingGenerate / 偷图额度）、`POST /api/socialV2/pic-config`、`POST /api/socialV2/pic-pause`、`POST /api/socialV2/send-pic`（`source=auto|sticker|local|generate`、`hint`、`text`、`dryRun`）；MCP `qq_send_pic`。
- **注意**（都是踩过的）：
  - `dryRun` 要在降级链**之前**处理，否则永远回空；
  - 每轮上限用 `rt.perTurnSent` + 90 秒窗口，`dedupeHours` 用 `sentIds` 去重；
  - 每日额度/偷图额度用**本地日期** `picDayKey(now)`，不能用 `toISOString` 的 UTC（会在早上 8 点前算错天）；
  - 生图排队要 30 分钟防抖 + 15 分钟 pending TTL，`send-media` 发图成功要 `delete st.pendingPicGenerate`；
  - 正事话题（报错/代码/钱/隐私/健康/作业/「帮我写查」/认真）一律不发；
  - `maybeAutoPicV2` 的 catch 必须把原因写进 `rt.lastError/lastErrorAt`（VM 里 console 是静音的，不写就完全看不到失败）。
- **验证**：`scripts/test-pic-auto.mjs`（15 组决策断言）、`scripts/test-pic-wiring.mjs`（真 bridge.js + 夹具网关，验合并/纯表情/生图排队三道闸）；真机 `send-pic` 拿到非空 `messageId` 且 `state/pic-log.json` 有一条。

## 15. 图文同条 + QQ 表情原生发送

- **做什么**：把「一句话 + 一张图」放进**同一个气泡**（像真人斗图）；表情走 QQ 原生通道，不再被当成普通图片铺满整屏；收藏表情时优先 CDN 原图直传（保住动图）。
- **配置键**：`socialV2.pic.combineText`（默认 `true`）。只决定「一个气泡还是两个」，**不决定做不做**。
- **主要代码**：`src/bridge.js` 的 `pickPicForCombineV2`（只挑不发）、`sendMergedTextPicV2`（`[reply][at][text][image]`）、`sendTextBubbleV2`（关闭开关时先发文字气泡）、`stickerImageSegment`（`sub_type:1` + `summary:'[动画表情]'`）、`sendStickerV2`（纯表情走 `onebotAction('send_custom_face')`）、`collectStickerV2`（CDN 直传优先）。
- **接口/MCP**：`qq_send_sticker{text}`、`qq_send_pic{hint,text}`；`POST /api/socialV2/send-sticker` 带 caption 时按开关合并或拆条，返回 `split` / `textMessageId`。
- **注意**：
  - 巨大图的根因是段里缺 `sub_type`；能走 `send_custom_face` 就别走字节下载；
  - `emoji_id` 取 `entry.resId || entry.id`（同步来的条目**没有** `emojiId` 字段）；
  - 只有表情和本地图库能同条，生图那一路由 agent 自己发（`generate_image` → `qq_send_image`）；
  - 一轮里合并发过就不再调 `maybeAutoPicV2`，避免两条；
  - 关闭开关时仍然照做：文字气泡 + 表情两条，引用/@ 挂在文字上。
- **验证**：`scripts/test-pic-wiring.mjs` 的「合并只发 1 条 `[text,image]`」「纯表情只调 `send_custom_face`」两个夹具；真机回读三个 messageId（合并 / 纯表情 / 拆条）。

## 16. MCP 三行自愈（补丁被冲掉就补回来）

- **做什么**：DSH 有时会把 `<DSH_HOME>\profiles\desktop\cordis.patch.yml` 重写掉，丢掉 `mcp-snowluma` / `mcp-snowluma-host` / `mcp-web-search-safe` 三条，于是所有 `mcp__snowluma__*` 工具变成 `unknown tool`。桥接启动时检查并补回。
- **主要代码**：`src/bridge.js` 的 `ensureMcpEntries()`（启动时执行）、`scripts/setup-dsh.mjs`（`MANAGED_MCP_IDS` / `mcpEntries()`，同一套条目定义）。
- **注意**：补丁块靠 `# === qq-bridge MCP BEGIN/END ===` 标记识别；写入前留 `.bak-*` 备份；改完要重启 DSH 才会加载 MCP 进程。
- **验证**：`mcp__snowluma-host__snowluma_status` 返回 `{"reachable":true,"online":true,...}`。

## 17. 悬浮窗（桌宠浮窗 + 对话面板）

- **做什么**：桌面上一个 Q 版形象，头顶会冒气泡说一两句话；点开变成对话面板，可以直接跟她聊（和 QQ 共用同一张记忆卡），面板里能贴合氛围发图（`/pic` 或聊天配图标记），窗口能拖动、能展开成全屏面板。
- **入口**：DSH 桌面端跑起来后自动出现（`node orb-ctl.mjs start|stop|install`）；设置页在 SurfCore → 悬浮窗（形象 / 气泡 / 聊天记忆 / 发图 / 试一试）。
- **主要代码**：
  - Electron 侧 `plugins/surfcore/assets/orb-app/`：`main.js`（窗口、IPC、`orb:*` handler）、`orb.js`（面板渲染、消息、看图器）、`pet.js` / `pet.css`（桌面宠物 + 头顶气泡）、`orb.css`、`index.html`；
  - 插件侧 `plugins/surfcore/lib/`：`orb.js`（配置与持久状态：消息、已读水位）、`orb-api.js`（HTTP 路由 + 一轮对话的编排）、`pet-chat.js`（提示词拼装 + 调 DSH）。
- **配置键**：`socialV2.orb`（`chat.shareQqRecent`、`chat.richBubble`、`chat.pic`、`pet.*`、`window.*`），旧配置由 `normalizeOrbConfig()` 补齐默认值。
- **接口**（`orb-api.js`，同源校验 + JSON）：`GET /api/orb/state`（消息 + 已读水位 + 预置项）、`POST /api/orb/chat`（一轮对话）、`POST /api/orb/send`（面板里手动发）、`POST /api/orb/seen`（已读水位）、`POST /api/orb/clear`（新对话）、`POST /api/orb/prefs`（窗口/气泡偏好）。
- **注意**：
  - 面板和头顶气泡是两套布局，改一个别指望另一个跟着变（0.12.0 的裁切就是只在面板上出的）；
  - `createOrbApiService` 作用域里没有 `adminQQ`，要写 `() => deriveIdentDefaults().meQQ`（PITFALLS #120 段）；
  - 配图标记必须在 `rawReply` 上匹配（`reply.text` 已被剥掉标记）；
  - 头顶气泡有高度上限，长文本会被省略并提示「点开看全文」。
- **验证**：`scripts/test-orb.mjs`（源码契约 + 行为，0.12.0 之后 229 项 + 新增契约）；真机：发一条 300 字长消息看头顶气泡、面板双击图、关掉再开看是否重弹。

## 18. 悬浮窗 0.12.0：气泡不裁切 / 已读不重弹 / 双击看图 / QQ 近况互通

四条都是「用起来才发现的」问题，改法记在这里方便下次别踩回去。

### 18.1 面板气泡自适应（裁切根因）

- **现象**：面板里长文字被切掉、图片被压扁，而且**没有滚动条**。
- **根因**：`.bubbles` 是列向 flex 容器，`.row` 默认 `flex-shrink: 1` —— 内容一高，整行被压扁（文字/图片一起被裁），又因为没溢出所以不出滚动条。
- **改法**（`plugins/surfcore/assets/orb-app/orb.css`）：
  - `.bubbles { flex: 1; overflow-y: auto; min-height: 0; }`（`min-height: 0` 是 flex 子项能滚动的必要条件）；
  - `.bubbles > .row { flex: 0 0 auto; }`（主因，别删）；
  - `.bubble { overflow-wrap: anywhere; max-height: none; }`、`.bubble.haspic .pic { margin-bottom: 4px; }`；
  - 图仍旧 `width:auto; height:auto; max-width:100%; max-height:min(240px,42vh); object-fit:contain`（等比、不拉伸）。

### 18.2 头顶气泡随内容长高（pet 窗口可伸缩）

- **现象**：头顶气泡固定 110px（`PET_BUBBLE_SPACE`），长文字顶被切、带图时图被压扁。
- **改法**：
  - `main.js`：新增 `let bubbleBand = PET_BUBBLE_SPACE;`，`baseSize()` 的宠物高度改成 `size + bubbleBand`（球模式不变）；新增 IPC `ipcMain.handle('orb:bubble-space', (_e, px) => …)`：`band = clamp(round(px), PET_BUBBLE_SPACE, min(520, workArea.height - petSize - 60))`，只在 `displayMode !== 'expanded'` 时生效，按「底边不动、向上长」重设 bounds（`y = cur.y + cur.height - newH`，再过 `applyBounds()`）；`orb:prefs` 返回值加 `bubbleBand`；`orb:expand` / 收起时把 band 复位成 `PET_BUBBLE_SPACE`。
  - `pet.js`：新增 `function fitBubble()` —— 临时量出气泡自然高度（文本 `scrollHeight` + 图高 + 内边距），`need = ceil(h + 10)`，与当前 band 差 > 2 才 `window.orb.bubbleSpace(need)`（防自我抖动）；`showBubble()` / `placeBubble()` / `img.onload` / `resize` 后各调一次（resize 里做防抖）；`hideBubble()` → `window.orb.bubbleSpace(0)` 复位；导出的 band 供命中判定用，`orb.js` 的 `petBodyHit()` 不再硬编码 `PET_BUBBLE_SPACE`（否则窗口长高后点击穿透区错位）。
  - `pet.css`：`#bubbleText { max-height: var(--bubble-text-max, 300px); overflow: hidden; }`、`#bubble.haspic #bubbleText { max-height: var(--bubble-text-max-pic, 220px); margin-top: 5px; }`，这两个变量由 `pet.js` 按实际 band 写入；小图仍 `max-height: 72px`；超上限时文本加省略号 + 「…（点开看全文）」。

### 18.3 已读水位：面板看过的不再冒气泡

- **现象**：面板里看完的消息，收起窗口后又冒一次气泡；重启还会再冒。
- **改法**：
  - `plugins/surfcore/lib/orb.js`：`readState()` / `writeState()` 增加 `seenId`（缺省 0）；新导出 `markSeen(id)`（`Math.max(旧值, min(id, seq))`，**只有变化才落盘**）；`clearMessages()` 同时把 `seenId` 归 0。
  - `plugins/surfcore/lib/orb-api.js`：`stateForOrb()` 增 `read: { seenId: orb.readSeenId() }`；新路由 `POST /seen`，body `{id}` → `orb.markSeen(id)` → `{ok:true, seenId}`。
  - `plugins/surfcore/assets/orb-app/orb.js`：新 `markSeen(upTo)`，节流 1.5s，`POST /seen {id}`；在 `show()` 的 `refreshState()` 之后、以及 expanded 状态下每次 `renderMessages()` 之后调用（取 list 最后一条的 id）。
  - `maybeBubble()` 增加条件 `Number(last.id) > Number(state?.read?.seenId || 0)`（配合已有 `lastBubbleMsgId` 去重）：收起时冒气泡 = 未读提示，打开面板即视为已读。

### 18.4 双击看图（QQ 风格查看器）

- **改法**：
  - `index.html`（`#root` 之后、`</body>` 之前）：`<div id="viewer" class="viewer hidden"><img id="viewerImg" alt="" /><button id="viewerClose" class="viewer-close" title="关闭（Esc）">×</button><div class="viewer-tip">滚轮缩放 · 按住左键拖动 · Esc 关闭</div></div>`。
  - `orb.css`：`.viewer{position:fixed;inset:0;z-index:80;background:rgba(6,9,14,.88);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;overflow:hidden}`、`.viewer.hidden{display:none}`、`.viewer img{max-width:100%;max-height:100%;transform-origin:0 0;will-change:transform;cursor:grab;user-select:none;-webkit-user-drag:none}`、`.viewer img.grabbing{cursor:grabbing}`、`.viewer-close` 圆形按钮、`.viewer-tip` 底部提示。
  - `orb.js`：`const view = { open:false, scale:1, tx:0, ty:0, drag:null }`；`renderMessages()` 里给 `img.pic` 挂 `dblclick → openViewer(src)`（`preventDefault` + `stopPropagation`）；`openViewer(src)` 先显示、再在 `requestAnimationFrame` 里按容器与自然尺寸算一次适配缩放（`fit = min(1, cw/nw, ch/nh)`）并居中；`wheel`（`passive:false`，仅 `view.open`）`k = Math.exp(-deltaY * 0.0015)`、`next = clamp(scale*k, 0.2, 8)`，**以指针为锚点**：先求指针在图坐标系里的点 `(px - tx)/scale`，再回写 `tx = px - anchorX*next`、`ty = py - anchorY*next`；`pointerdown/move/up`（pointer capture）左键拖动改 `tx/ty`；×、背景点击（`ev.target === viewer`）、Esc 关闭；打开期间 `hide()`、空闲收起、面板边缘缩放的 `mousedown` 全部直接 `return`。
  - 头顶气泡的图不做双击（保持点击开会话）。

### 18.5 QQ 近况互通

- **现状（先写清楚边界）**：长期**记忆卡**是互通的（`pet-chat.js` 的 `memoryCardPromptBlock('qq')`，QQ / B站 / 悬浮窗写同一张卡、同一个 inbox），但 **QQ 的对话原文不互通** —— 悬浮窗历史是 `<stateDir>/orb/history-<roleId>.json`，和 QQ 会话各自独立。
- **新增开关**（默认开）：
  - `plugins/surfcore/lib/orb.js`：`DEFAULT_ORB.chat.shareQqRecent = true`；`normalizeOrbConfig` 加 `shareQqRecent: chat.shareQqRecent !== false`。
  - `plugins/surfcore/lib/orb-api.js`：新 `async function recentQqLines(cfg)` —— 关掉则返回 `[]`；`adminQQ()` 为空返回 `[]`；`consoleCall('/api/socialV2/recent?key=private:' + adminQQ() + '&limit=12')`（`consoleCall` 已带 `x-console-token`），45 秒内存缓存；映射成 `[{who: m.isSelf ? 'her' : 'me', text: (m.plain || m.text || '').slice(0,200)}]` 并去空行。`runChatTurn()` 里取 `const qqRecent = await recentQqLines(cfg)` 传给 `chat.chat({ …, qqRecent })`。
  - `plugins/surfcore/lib/pet-chat.js`：`chat({ …, qqRecent = [] })`；提示词追加块【你们刚在 QQ 上聊的】+ 最多 12 行（`主人：…` / `你：…`）+ 一句「这些是你们在 QQ 上的近况；这边聊到时可以直接接着说，不要假装没发生过，也不要把这段念出来。」
  - `plugins/surfcore/lib/client.js`：「悬浮窗发图」段之后、「试一试」之前加「聊天记忆」Section 两条：`chat.shareQqRecent`「记得 QQ 上刚聊的」（badge 开/关，hint 说明只带最近 12 条、45 秒缓存、关掉就只剩长期记忆卡）与已有的 `chat.richBubble`。
- **边界**：只读最近 12 条、只读 `private:<主人QQ>`（不含群聊）；拿不到 `adminQQ` 时不注入。

---

## 附：新增文件清单

| 文件 | 作用 |
| --- | --- |
| `src/memory-backup.js` | 全量记忆卡镜像/到期/QQ 发送 service |
| `src/self-expression.js` | 签名/空间动态配置、到期判断、提示词与决策解析 |
| `src/diary.js` | 日记配置、按角色文件、追加与状态 |
| `scripts/test-memory-backup.mjs` | 记忆卡备份 13 项单测 |
| `scripts/test-self-expression.mjs` | 签名/动态/日记 16 项单测 |
| `plugins/surfcore/scripts/ui-sprintkey.mjs` | Sprintkey 8 页 CDP 验收 |
| `plugins/surfcore/scripts/ui-self-expression.mjs` | QQ 签名卡 + 日记页 CDP 验收 |
| `plugins/surfcore/scripts/ui-dir-picker.mjs` | 日记目录选择器 CDP 验收 |
| `plugins/surfcore/docs/ui-sprintkey-*.png` | Sprintkey 8 页截图 |
| `plugins/surfcore/docs/ui-self-expression-*.png` | QQ 签名卡 / 日记页截图 |
| `plugins/surfcore/docs/ui-dir-picker-*.png` | 目录选择器截图 |
| `src/pic-auto.js` | 自动发图决策层（来源权重、降级链、本地图库扫描、生图提示词、唤醒提示块） |
| `scripts/test-pic-auto.mjs` | 发图决策 15 组单测 |
| `scripts/test-pic-wiring.mjs` | 发图接线测试（真 bridge.js + 夹具网关：合并/纯表情/生图排队/三道闸） |
| `<语音包源目录>\adapter_server.py` | 本地模型2 适配器（`/v1/voices`、`/v1/speak/file`、`/v1/sing`） |
| `<工作区>\pic-tab-click.mjs` | 发图设置页 CDP 验收（点 tab + 断言 + 截图） |
| `plugins/surfcore/assets/orb-app/main.js` | 悬浮窗 Electron 主进程：窗口尺寸、`orb:*` IPC、`orb:bubble-space` 气泡带 |
| `plugins/surfcore/assets/orb-app/orb.js` | 面板渲染、已读水位上报、双击看图器（缩放/拖动） |
| `plugins/surfcore/assets/orb-app/pet.js` / `pet.css` | 桌面宠物与头顶气泡（`fitBubble()` 自适应高度） |
| `plugins/surfcore/lib/orb.js` | 悬浮窗配置与状态（消息、`seenId`、`markSeen`） |
| `plugins/surfcore/lib/orb-api.js` | 悬浮窗 HTTP 路由 + 一轮对话编排 + QQ 近况注入 |
| `plugins/surfcore/lib/pet-chat.js` | 悬浮窗提示词（记忆卡 / 配图 / QQ 近况块） |

修改的既有文件：`src/bridge.js`、`plugins/surfcore/lib/index.js`、`plugins/surfcore/lib/client.js`。

## 新增功能时按这个格式补一条

1. 在总表加一行（功能 / 入口 / 代码 / 配置键）；
2. 下面加一节，写清「做什么 / 入口 / 接口或配置 / 注意（踩过的坑）/ 验证方法」；
3. 在 `CHANGELOG-SPRINTKEY.md` 顶部加对应条目，并在 `docs/PITFALLS.md` 记坑（如果有）。
