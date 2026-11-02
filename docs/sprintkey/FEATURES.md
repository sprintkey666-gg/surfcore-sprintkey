# Sprintkey 自定义功能清单（FEATURES）

这份文件回答一个维护者最常问的问题：**我们自己加的东西有哪些、在哪、怎么开、怎么验证。**
上游功能不在本表；每条功能都标了「入口 / 代码 / 配置 / 接口 / 注意」，改之前先看这里。

> 记录时间：2026-11-01（2026-10-28 基线之后陆续新增；11-01 补了 13~21 条：本地模型2 / 自动发图 / 图文同条+原生表情 / MCP 自愈 / 悬浮窗 / 好友申请 / 陪伴模式 / 聊天全量存档；陪伴模式已更新到 0.12.15）
> 改动过程与提交见 [`CHANGELOG.md`](../CHANGELOG.md)，升级流程见 上游升级文档。

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
| 13 | 本地模型2 · 肥鱼 CosyVoice3（第三个语音包，音色自动探测） | SurfCore → 语音 → 语音包卡片 / 使用区三个单选 | `src/voice-packs.js`、`E:\voice\packages\voice-feiyu` | `socialV2.voice.tts.route`、`speaker`、`endpoints.feiyu` |
| 14 | 自动发图（QQ 表情 / 本地图库 / 现场生图 三来源 + 降级链 + 偷图收藏） | SurfCore → 发图 | `src/pic-auto.js`、`src/bridge.js`、`src/sticker-semantics.js` | `socialV2.pic`、`socialV2.sticker.collect` |
| 15 | 图文同条 + QQ 表情原生发送 | SurfCore → 发图 → 节奏 / 来源 · QQ 表情 | `src/bridge.js`（`sendMergedTextPicV2` / `sendTextBubbleV2` / `sendStickerV2`） | `socialV2.pic.combineText` |
| 16 | MCP 三行自愈（补丁被冲掉就补回） | 无界面（桥接启动自动） | `src/bridge.js` 的 `ensureMcpEntries()`、`scripts/setup-dsh.mjs` | 无 |
| 17 | 悬浮窗（桌宠浮窗 + 对话面板） | SurfCore → 悬浮窗 / 桌面自动出现 | `plugins/surfcore/assets/orb-app/`、`plugins/surfcore/lib/{orb,orb-api,pet-chat}.js` | `socialV2.orb` |
| 18 | 悬浮窗 0.12.0：气泡自适应 / 已读水位 / 双击看图 / 记忆互通 | SurfCore → 悬浮窗 → 聊天记忆等 | 同上（`orb.css` / `main.js` / `pet.js` / `orb.js` / `pet-chat.js`） | `socialV2.orb.chat.shareMemory` |
| 19 | 好友申请（AI 拍板通过 + 自动通过 + 待处理列表） | SurfCore → QQ → 好友申请 | `src/friend-guard.js`、`src/bridge.js`、`plugins/surfcore/lib/client.js` | `socialV2.friend` |
| 20 | 陪伴模式（桌宠右键开启，字幕陪看 / 上下文 / 历史 / 字号） | 右键桌宠 → 陪伴；参数在 SurfCore → 悬浮窗 → 陪伴模式 | `plugins/surfcore/lib/orb-companion.js`、`assets/orb-app/companion.*`、`main.js`、`orb.js` | `socialV2.orb.companion`（enabled/intervalSec/maxCommentsPerHour/fontPx/width/opacity/contextSubtitles） |
| 21 | 聊天全量存档（QQ 私聊/群聊 + 桌宠/字幕分 channel、按 MB 滚动、随全量卡备份发送，可选全发/增量） | SurfCore → Sprintkey扩展插件 → 记忆 | `src/chat-archive.js`、`src/memory-backup.js`、`src/bridge.js`、`plugins/surfcore/lib/desktop-archive.js`、`plugins/surfcore/lib/pet-chat.js`、`plugins/surfcore/lib/orb-companion.js`、`plugins/surfcore/lib/client.js` | `socialV2.memoryCardBackup.archive`（enabled/maxFileMB）、`.send.fullArchive` |
| 22 | 回复速度：原版 / 快回复两套参数 + 自动换会话（0.13.0~0.13.3） | SurfCore → QQ → 回复速度（总开关）/ 原版回复 / 快回复 | `src/bridge.js`（`replyParamsNow` / `rotateSessionV2` / `POST /api/socialV2/rotate`） | `socialV2.reply = { mode, legacy:{…}, fast:{…} }` |

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

- **2026-11-02 起：一文一档**：每篇日记按时间建一个文件（`<目录>/<角色ID>/2026-11-01_21-30.md`），可设「每 N 篇合并成一档」，设置页只列最近 5 篇；老的 `<目录>/<角色ID>.md` 会转成 `*.legacy-<ts>.bak`。
- **公开日记**：`socialV2.diary.public = { enabled, dir, everyDays, hour, maxChars, perFile, visibility(1/4/64), maxPerDay, allowNames }`，写完直接发 QQ 空间（`send_qzone_msg`）。人名可以留（群里的事、谁发起的可以用昵称），钱/账号/证件/手机号/QQ 号/链接/住址一律清洗。
- **私密日记**：仍只私聊发给主人，可放开隐私（可以写真实的人和事），只禁密码/验证码/银行卡/身份证/转账金额。

## 12. Sprintkey 子设置分页

- **做什么**：Sprintkey 从「一页 8 个折叠分组」改成「一页一个子设置」的二级页签。
- **页签**：模型与思考 / 记忆 / 声线 / 跨会话共享 / 世界树 / 工具投递 / 投递上限 / 投递接口。
- **代码**：`plugins/surfcore/lib/client.js` 的 `SubTabs`、`SPRINTKEY_PAGES`、`SprintkeyTab`；`Section` 新增 `hidden`；父组件 `sprintkeyPage` 保存当前页。
- **注意**：`.qbw-subtab.on` 必须用中性底色（`rgba(127,127,127,.16)`），不要用 `--dsw-alias-brand-primary`（深色主题下会解析成白底白字）。
- **验证**：`scripts/test-client-contract.mjs` 断言页签与控件；`ui-sprintkey.mjs` 8 页 + 草稿跨页 + 窄窗 + 焦点全过。

## 13. 本地模型2 · 肥鱼 CosyVoice3（第三个语音包）

- **做什么**：本地第二个语音包（CosyVoice3 zero-shot），音色数由包内 `references/*.wav` **自动探测**（现在是 `cute` 可爱 / `gentle` 温柔 两个）；支持逐字清唱与真 SVS 按谱唱歌。
- **入口**：SurfCore → 语音 → 语音包卡片「本地模型2 · 肥鱼 CosyVoice3」；顶部「使用」区三个单选（本地语音包 / 云端语音包 / 本地模型2），同一时间只跑一个，切换自动停另一个。
- **主要代码**：`src/voice-packs.js`（`DEFAULT_MANIFESTS` 的 `voice-feiyu`、`detectVoices()`、`statusOne()` 的 `autoVoices` 标记）、包体 `E:\voice\packages\voice-feiyu`（`adapter_server.py`、`run.bat`、`stop.bat`、`scripts/fetch-models.mjs`、`scripts/bootstrap-env.mjs`、`scripts/svs/*`）。
- **配置键**：`socialV2.voice.tts.route`（`local` / `feiyu` / `cloud`）、`socialV2.voice.tts.speaker`（`cute` / `gentle`）、`socialV2.voice.tts.endpoints.feiyu`（默认 `http://127.0.0.1:8766`）。
- **接口**：适配器 `GET /v1/health`、`GET /v1/voices`、`POST /v1/speak/file`（直接回 wav 字节 + `X-Duration-Ms`）；桥接 `/api/voice/packs`（卡片数据）、`/api/voice/packs/test`、`/api/voice/rules`（切 route/speaker）、`/api/voice/send`；MCP `qq_send_voice`、`qq_send_song`。
- **注意**：
  - 端口 **8766**，模型与 venv 用 junction 接到 `E:\feiyu-voice`（`models` / `.venv` / `vendor\CosyVoice`），重装包不用重下 12GB。
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

- **做什么**：DSH 有时会把 `C:\Users\sprintkey\.dsh\profiles\desktop\cordis.patch.yml` 重写掉，丢掉 `mcp-snowluma` / `mcp-snowluma-host` / `mcp-web-search-safe` 三条，于是所有 `mcp__snowluma__*` 工具变成 `unknown tool`。桥接启动时检查并补回。
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

### 18.5 记忆互通（悬浮窗 ↔ QQ ↔ B站）

- **现状**：三端共用同一张**衰减记忆卡**（`src/memory-card.js`）+ 同一个 inbox（`platform: 'pet'`），所以「她在悬浮窗里记得的事」QQ 那侧本来就能看到。
- **悬浮窗自己的开关**：`socialV2.orb.chat.shareMemory`（默认开）。`pet-chat.settings()` 里 `remember` 必须**按 `isOrb` 分流**（悬浮窗读 `orb.chat.shareMemory`，桌宠读 `pet.chat.remember`）；`memoryBlock()` 用同一个开关控制「读」。第一版读错了对象，表现成「悬浮窗没写卡」，实际一直在写（PITFALLS #122）。
- **QQ 对话原文不互通**：0.12.0 曾加过 `chat.shareQqRecent`（读 `/api/socialV2/recent` 取最近 12 条塞进提示词），同一天按主人意见**撤掉**（`5b79608`「衰减记忆卡本来就共用」）。别再把它加回来——原文会重复、过时，还绕过了记忆卡的衰减。
- **B站 侧**：`memory-card.js` 加 `includePetInBili`（默认开）+ bili 配额 `pet: 3`，并且**代码层两道闸**：只放 `source === 'pet-self'` 且 `screenSeen === false` 的记录（缺标记按看屏处理，fail closed），再过 `BILI_PRIVATE_RE`（QQ/微信/手机号/验证码/住址/工资/病历…）整条筛掉。B站那侧经常是 0 条，那是设计如此，不是开关坏了（PITFALLS #123）。
- **设置页**：SurfCore → 悬浮窗 → 聊天记忆 →「记得这边聊的」（`chat.shareMemory`）。

### 18.6 桌宠窗口 0.12.2~0.12.7（拖到最上面 / 透明带不挡点击 / 贴左缘不飞出）

- **拖不到屏幕最上面（0.12.2~0.12.5）**：三处夹取各夹各的 —— `clampForMode()` 用**整窗高**夹上边界，而窗口上半截是头顶气泡带、宠物身体贴底，于是气泡带先顶到屏幕边她就卡住；`applyBounds()` 里位置又走 `clampToDisplay()`（整窗夹屏）。改法：按「宠物身体」夹，气泡带允许伸出工作区。
- **透明带挡住桌面点击（0.12.2~0.12.5）**：`setIgnoreMouseEvents(false)` 是**窗口级**的，矩形里透明的地方照样吃点击。改成按光标位置动态切穿透：不能靠渲染端 `mousemove`（Windows 上 `setIgnoreMouseEvents(true,{forward:true})` 并不转发移动事件），要由主进程轮询 `screen.getCursorScreenPoint()` 判断是否落在宠物身上；气泡显示时把头顶那一截留成可点，右键菜单/看图器这类 HTML 覆盖层打开时 `uiHold` 整窗可点（否则菜单点不到）。
- **贴左缘被吸出屏幕（0.12.6）**：停靠公式 `x = area.x - bounds.width + visible` 是给**小球**写的（只露 6px），桌宠把 `visible` 设成 0 之后左边变成 `-width`，一松手整只飞到屏外。按 `petMode` 分开算：球可以藏进边里，桌宠必须整个留在屏内（她的判定区就是窗口本身）。顺手记：右侧当时是对的，所以只测左边才会发现（PITFALLS #125）。
- **版本**：`assets/orb-app/package.json` 0.12.7 时的状态；`test-orb.mjs` 每步都有对应契约（穿透轮询、`petMode` 分支、按身体夹取）。

### 18.7 悬浮窗 0.12.9（头像与 QQ 号终于生效）

- **症状**：设置 → 悬浮窗 → 身份里填了 QQ 号和「头像文件」的绝对路径，聊天面板里却永远是那个字母点。
- **根因 1（file:// 源）**：面板是 `loadFile(index.html)` 打开的，文档源是 `file://`，所以渲染端写 `/avatar?who=her` 会被解析成 `file:///avatar?who=her`，请求根本到不了插件 → 404 → 只能画字母点。改法：`plugins/surfcore/lib/orb-api.js` 直接给 `file:///C:/…` 的 URL（`fileUrl()` 用 `encodeURI` 处理空格/中文，`\` 换 `/`），`assets/orb-app/orb.js` 里 `img.src = who.avatarUrl`。CSP 的 `img-src file:` 本来就有。
- **根因 2（引号）**：资源管理器「复制文件地址」给的是 `"C:\…\a.jpg"` 带引号，`fs.existsSync` 永远 false。`normalizeOrbConfig` / `orb-api` 各加一个 `stripQuotes()` / `stripPath()`，剥掉首尾空白与中英文引号。
- **头像缓存按身份分文件名**：QQ 头像落 `~/.dsh/surfcore/orb/avatars/<who>-<sha1(file\0qq)>.png`，换号/换图文件名就变，不会被 7 天 TTL 钉在旧图上；下载走后台 `ensureAvatar`，不阻塞 `/state`。
- **验证**：`scripts/test-orb.mjs` 276 项全过（file:// URL 生成、剥引号、keyed 缓存 + 后台补、空 URL 不塞 `src`）。
- **坑已记**：PITFALLS #127（file:// 页面里相对路径不是同源路径，别写 `/avatar`；引号要剥）。

## 19. 好友申请（AI 拍板通过 + 自动通过 + 待处理列表）

- **做什么**：别人来加好友时，先判她在不在「白名单群 / 私聊白名单」的可信范围里，再按配置**自动通过**或**唤醒 AI 拍板**；没处理的申请留成待处理列表，带每日配额与冷却防刷。
- **边界（很重要）**：网关卡**没有主动加好友**的动作（`add_friend` / `send_friend_request` / `set_add_friend` / `get_friend_requests` 全部 `retcode 1404`），也没有「查待处理申请」的查询动作。所以这条功能是「别人来加我们时决定通过/拒绝」，而且**离线期间的申请补不回来** —— 待处理只靠事件现收现存在 `state/friend-requests.json`（上限 50）（PITFALLS #126）。
- **配置**：`socialV2.friend = { enabled, autoApprove, requireGroupMember, maxPerDay, cooldownHours, remarkPrefix }`（`defaultFriendConfig()` / `normalizeFriendConfig()` 在 `src/friend-guard.js`）。
- **判定层**（纯函数，**收整份 config**，内部自己读 `cfg.socialV2.friend`）：`inAllowList()` / `scopeVerdict({cfg,qq,groups})` / `decideFriend({cfg,request,sharedGroups,counters,deniedRecently})` / `buildFriendPromptLine(cfg, pending)`。判「是不是白名单群里的人」不能用 `get_group_member_list`（对当前号 `AUTHORITY_FAIL`），只能遍历白名单群逐个 `get_group_member_info({group_id,user_id,no_cache:true})`（10 分钟缓存，异常当不在，通过前 force 复核）。
- **接口**：`GET /api/socialV2/friend-requests`、`POST /api/socialV2/friend-config`、`POST /api/socialV2/friend-decide`；MCP `qq_friend_requests`（`tools.friendRequests`）、`qq_friend_decide`（`tools.friendDecide`）。
- **实现**：`bot.onRequest` 收申请 → 落盘；`autoApprove` 直接过，否则 `WAKE_PRIORITY.friendRequest = 55` 唤醒 AI，唤醒提示加【好友申请】段；`applyFriendDecision` 走 `set_friend_add_request` 再记账/冷却，可选 `set_friend_remark`，结果通知主人。SDK 没有 `onRequest` 时必须**打日志**说不可用（别静默）。
- **设置页**：SurfCore → QQ →「好友申请」卡（两个开关 + 每日配额 + 冷却 + 待处理列表）。
- **验证**：`scripts/test-friend-guard.mjs`（18 项判定）、`scripts/test-friend-wiring.mjs`（9 项接线，假网关要能回 `get_group_member_info` 的 `retcode 100 member not found` 与 `get_stranger_info`，否则全被判「不在范围」）。
---

## 20. 陪伴模式（桌宠右键开启，字幕陪看 / 上下文 / 历史 / 字号）

**做什么**：开启后，每隔一段时间截一张屏（800px JPEG），让模型用一句短评像字幕一样陪看；不传视频/音频、不写 QQ/群，字幕和消息只存在内存。字幕支持单条、上下文（最多 3 条）、历史三种显示模式，点字幕开/收输入框，输入一句话她先截新图再回答。

**入口（当前）**：
- **右键桌宠 → 陪伴**：开启/关闭陪伴、上下文字幕开关；`大小` 滑条也在同一菜单里。
- SurfCore → 悬浮窗 → 「陪伴模式（一起看电影）」：间隔 20–180 秒、每小时最多 1–30 句、字号 14–40、字幕宽度、背景不透明度、上下文字幕。
- 托盘菜单 → 陪伴活动时提供「关闭陪伴（恢复桌宠）」。
- 字幕右上角 `×` 关闭陪伴；`A− / A+` 调字号；按住 `Ctrl+Alt` 展开历史字幕。

**代码**：
- `plugins/surfcore/lib/orb-companion.js`：截图、SHA 去重、每小时上限、短评清洗、上下文消息（上限 200）、失败降级/退避；
- `plugins/surfcore/lib/{orb,orb-api}.js`、`lib/index.js`：配置归一化、`/orb/companion` GET/POST、`/orb/overview` 状态；
- `plugins/surfcore/lib/client.js`：设置卡（不再注入会话 header）；
- `plugins/surfcore/assets/orb-app/main.js`：字幕窗创建/置顶/拖动/缩放、菜单 overlay、桌宠隐藏与恢复；
- `plugins/surfcore/assets/orb-app/orb.js` / `pet.css` / `index.html`：右键菜单、自适应尺寸、大小滑条、陪伴开关；
- `plugins/surfcore/assets/orb-app/companion.{html,css,js}`：字幕条三种模式、字号控件、长按拖动、输入框。

**接口**：
- 悬浮窗直连：`GET/POST /dsh-surfcore/orb-api/companion`；
- 控制台/桥接代理：`GET/POST /dsh-surfcore/api/orb/companion`；
- POST `{action:"start"|"stop"|"reply"|"config", sessionId?, text?, patch?}`；需先打开「让她看见这台电脑」的屏幕权限。

**0.12.10–0.12.15 的关键改动**：
- 删除会话顶部「🎬 陪伴」按钮和 header slot 注入；关闭状态不再有常亮按钮，开关只在桌宠右键菜单/托盘。
- 菜单从“窗口内小面板”改为**独立覆盖层**：先量真实内容再扩窗，夹进工作区；`大小` 滑条补回 DOM，展开后重新 `fit`；菜单外点击/失焦只收菜单，并按“打开菜单时”的面板状态恢复，不会打回桌宠。
- 字幕消息模型：`append()` 只入历史、不顶当前字幕；`reply()` 不再把用户问题替换成当前字幕；prompt 带记忆卡 + 最近 8 条；`messages` 上限 200。
- 字幕窗几何：高度以底边为锚点，只在越界时向上让位、绝不下移；宽度到屏幕右边自动左移；拖宽结束才落盘；`ensureCompanionWindow` 优先本机 `prefs.width`。
- 失败策略：截图/模型失败只标记 `degraded` 并退避，**不再连续 3 次自动 stop**；回复失败发「这条没接上：原因」；发送即清空输入框。
- 字幕交互：左键单击开/收输入框，按住约 260ms（或直接移动）才拖动；`A−/A+` 字号写入 prefs，内边距/输入框/按钮全部 `em` 自适应。
- 历史：`Ctrl+Alt` 展开全部消息（带时间、可滚动），松开收回；上下文模式只显示最近 3 条。

**注意（踩过的坑）**：
- DSH 窗口自身置顶会压住字幕条；Electron 的 `moveTop()` 不够，必须 Win32 `SetWindowPos(HWND_TOPMOST, SWP_SHOWWINDOW)`。实现里用 `forceCompanionTopmost()` 调 PowerShell 完成，并在 `ready-to-show` 后 0.8 秒补一次。
- 菜单窗口不能改 `displayMode` 来“假装菜单态”，否则关闭时会按当前状态把展开面板打回桌宠；用独立 `menuOpen` + `menuRestore`。
- 字幕高度旧实现把 `y` 往下夹到 `area.bottom-40`，内容变矮时会一路下沉；现在只允许向上让位。
- 菜单尺寸不能写死 `190/250px`，否则中文标签、checkbox、滑条会被裁；用 `fit-content` + `max-width` + 纵向滚动，扩窗后再摆位。
- 独占全屏播放器可能盖住字幕，建议用无边框全屏；字幕条被手动关闭后，下一次状态轮询会重建。
- 陪伴开启时桌宠会被 `win.hide()`；停止后自动恢复，不要把它和「隐藏到托盘」混在一起。

**验证**：`plugins/surfcore/scripts/test-orb-companion.mjs` 10 项（含“连续截图失败只降级不自动停”）；`scripts/test-orb.mjs` 276 项。手工：右键桌宠开启 → 桌宠隐藏、字幕出现；点字幕开输入框、发送后输入框清空；右键菜单展开「大小」滑条不被裁；点菜单外面板保持展开；拖右下角改宽不沉底；`Ctrl+Alt` 看历史；`A−/A+` 字号和背景同步缩放。截图 `E:\聊天日常\companion-desktop5.png`、`companion-topmost.png`。

## 21. 聊天全量存档（QQ + 桌宠/字幕分 channel + 按 MB 滚动）

- **做什么**：把「全量记忆卡备份」扩展成真正的聊天原文存档。记忆卡有上限、会自动压缩；这个存档**不压缩、不删除**，每条私聊/群聊都追加到本地 JSONL，私聊和群聊物理分开，单文件写到设定 MB 就新建下一个。桌宠/悬浮球和陪伴字幕也写进 private，用 `channel` 区分来源。备份目录、手动备份、私聊发送到主人 QQ 都跟着适配。
- **入口**：SurfCore → Sprintkey扩展插件 → 记忆 → 「全量记忆卡 + 聊天存档（本地 + QQ）」；新增「每次发送全部记忆文件」「启用聊天全量存档」「聊天单文件上限（MB）」三行，状态行显示私聊（含桌宠/字幕）/群聊文件数、总字节、当前文件、发送模式。
- **目录**：`<备份根>\chat\<角色ID>\private\YYYY-MM-DD_0001.jsonl` 与 `...\group\...`。备份根 = `socialV2.memoryCardBackup.dir`，留空用 `defaultBackupDir()`（`~/.dsh/surfcore/memory-backups/<角色ID>`）。全量卡镜像仍是备份根下的 `memory-card-full.*`，位置不变。
- **JSONL 字段**：`{schema:2,id,at,time,platform,channel:"qq"|"desktop-orb"|"companion",kind:"private"|"group",conversation:{key,id,name},sender:{id,name,isOwner,isSelf},messageId,type,types,text,reply,media}`。`type` 取 `text|image|sticker|face|voice|video|file|forward|card|mixed`，`media` 只存 `{kind,file,url,name}` 元数据，不落二进制；原文不截断（单条上限 20000 字符）。旧 schema1 记录没有 `channel`，按 `qq` 理解。
- **写入点**：入站 `bridge.js` 的 `handleIncoming()` 在 `isSessionAllowedInCurrentMode` 之后、空文本 return 之前；出站 `sendMessagesV2()` 的 `sent` 和 `auditAndSend()` 成功之后。桌宠/悬浮球由 `pet-chat.chat()` 写用户+AI，主动气泡由 `orb.addMessage()` 补，字幕由 `orb-companion.publish()/append()` 回调写；陪伴内部 `chat.chat({archive:false})` 不重复写。斜杠命令、黑名单/模式不允许的会话不写；系统提示/命令回执不写。
- **滚动/去重**：按当天文件 `_0001` 递增；写前检查当前文件 + 本条字节是否超过 `maxFileMB`（1–512，默认 16），超了就新建；单条超大也单独成文件；同一条 `messageId` 内存去重 5000 条；只追加，不重写、不压缩、不删旧文件。
- **发送**：`runSend()` 不再强制全量卡存在；按 `send.fullArchive` 选模式：
  - 开（默认）：文本头 + 全量卡三件 + **全部**聊天存档，不按 `archiveSent` 过滤、不套 20 个上限。
  - 关：文本头 + 全量卡三件 + 最多 20 个「字节数 > `archiveSent[路径]`」的存档文件。
  - 两种模式都单文件超 `maxSendMB` 跳过并记 `skipped`；成功后把本次实际附加的路径/字节写进 `memory-card-backup.json` 的 `archiveSent`（全发也写，切回增量不重发旧档）。
- **接口**：不新增路由；`GET/POST /api/socialV2/memory-card-backup` 返回的 `archive` 汇总 `{enabled,dir,maxFileMB,private:{files,bytes,current},group:{...},totalBytes,lastError}`。
- **注意**：
  - 存档默认开，直接写备份根，不走“先副本再镜像”的全量卡逻辑；`memoryCardBackup.enabled` 仍只控制全量卡镜像，两者独立。
  - 只归档白名单会话；黑名单在更早的 `isSessionAllowed` 就 return，不会入库。
  - 不做历史回填：只从本次上线后的新消息开始存。
  - `archiveSent` 最多 500 条，满了淘汰最旧；删档/换目录后按新文件重新发。
  - 配置走 `liveMemoryBackupConfig()` 5 秒 mtime 缓存，设置页保存后不重启桥接即可生效。
- **验证**：`node scripts/test-chat-archive.mjs` 10 项（含 schema2、桌宠/字幕 channel、适配层）；`node scripts/test-memory-backup.mjs` 18 项（含全发每次带全部、25 个不被截断、增量/全发切换、超限跳过）；`node plugins/surfcore/scripts/test-orb-companion.mjs` 11 项（含字幕回调）；`node --check` 上面所有改动文件。手工：发一条私聊和一条群聊 → 看 `备份根\chat\<角色ID>\private|group` 当天 JSONL 是否各多一行、字段是否全；桌宠/字幕各说一句 → 看 private 里是否出现 `channel:"desktop-orb"` / `"companion"`；把 `maxFileMB` 调到 1 再发大段文字 → 看是否新建 `_0002`；设置页点「立即发送」→ 看主人 QQ 是否收到文本头 + 全量卡 + 新存档文件。

## 22. 回复速度：原版 / 快回复两套参数 + 自动换会话（0.13.0~0.13.3）

**做什么**：两套回复节奏参数**并存、互不读取**，`socialV2.reply.mode` 决定这一轮用哪一套：

- `legacy`（原版）：8 秒批量窗、2~8 秒打字、不自动换会话 —— 就是 0.12.x 的老行为，默认值。
- `fast`（快回复）：0.8 秒批量窗、0.15~0.5 秒打字、开着「定期换会话 + 清理旧会话」。思路是仿 QQ-agent：每聊若干轮就换一个干净会话，别让上下文越滚越长。

**入口**：SurfCore → QQ → 「回复速度（总开关）」选`用哪套`；下面「原版回复」「快回复」两组各自独立可改。手动换会话：`POST /api/socialV2/rotate`（body `{ key }`，老路径 `/api/socialV2/session/rotate` 保留）。

**配置**：`socialV2.reply = { mode: 'legacy'|'fast', legacy: {...}, fast: {...} }`，每组字段一致：
`batchWindowMs` / `typingMinMs` / `typingMaxMs` / `takeover`（忙时接管）/ `sessionRotate{ enabled, everyTurns(1~500), idleOnly, inheritTasks, deleteOld }` / `cleanup{ enabled, keep, days }`。

**注意（踩过的坑）**：

- `everyTurns` 的上限原来是 200，设置页填 300 会被**静默夹成 200**（现在 1~500）。
- 换会话的「轮」按会话**真实回合数**对齐，不是按消息条数；差一轮就会提前/推迟换，看 `turns` 别数 `messages`。
- 0.13.2 起换会话是**当场建新会话**：创建失败要回滚到原会话，否则映射指向一个不存在的会话，整个会话静默收不到消息。
- `deleteOld`（换完删掉旧会话）与 `inheritTasks`（把旧会话的自动化任务搬过去）是**两个独立开关**，别绑一起：`deleteOld:false` 时用户还能「回到原会话」。
- 回复参数在**启动时读一次**，改完配置要重启桥接或调 `POST /api/socialV2/reload` 热重载，否则看到的是旧值。
- 等待类工具（`qq_mark_read` / `qq_set_wake_config`）的文案不再写死 `300000`，一律按唤醒提示里的 `preSleepWaitMs`（默认 300000，可配 `socialV2.wake.preSleepWaitMs`）。

**验证**：`scripts/test-reply-mode.mjs`、`scripts/test-reply-wait.mjs`；真机 `POST /api/socialV2/rotate` 后 `GET /api/sessions` 能看到新 sessionId，旧会话保留可切回。

## 附：新增文件清单

| 文件 | 作用 |
| --- | --- |
| `src/memory-backup.js` | 全量记忆卡镜像/到期/QQ 发送 service（含聊天存档发送与 `archiveSent`） |
| `src/chat-archive.js` | 聊天原文存档 writer：schema2、channel、私聊/群聊分文件、JSONL 元数据、按 MB 滚动、去重 |
| `plugins/surfcore/lib/desktop-archive.js` | 桌宠/悬浮球/字幕的存档适配层（复用 chat-archive，channel=desktop-orb/companion） |
| `src/self-expression.js` | 签名/空间动态配置、到期判断、提示词与决策解析 |
| `src/diary.js` | 日记配置、按角色文件、追加与状态 |
| `scripts/test-memory-backup.mjs` | 记忆卡备份 + 聊天存档发送 18 项单测（含全发/增量切换） |
| `scripts/test-chat-archive.mjs` | 聊天原文存档 10 项单测（schema2/channel/桌宠字幕/分文件/滚动/去重/关闭/出站/status） |
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
| `E:\voice\packages\voice-feiyu\adapter_server.py` | 本地模型2 适配器（`/v1/voices`、`/v1/speak/file`、`/v1/sing`） |
| `E:\聊天日常\pic-tab-click.mjs` | 发图设置页 CDP 验收（点 tab + 断言 + 截图） |
| `plugins/surfcore/assets/orb-app/main.js` | 悬浮窗 Electron 主进程：窗口尺寸、`orb:*` IPC、`orb:bubble-space` 气泡带 |
| `plugins/surfcore/assets/orb-app/orb.js` | 面板渲染、已读水位上报、双击看图器（缩放/拖动） |
| `plugins/surfcore/assets/orb-app/pet.js` / `pet.css` | 桌面宠物与头顶气泡（`fitBubble()` 自适应高度） |
| `plugins/surfcore/lib/orb.js` | 悬浮窗配置与状态（消息、`seenId`、`markSeen`） |
| `plugins/surfcore/lib/orb-api.js` | 悬浮窗 HTTP 路由 + 一轮对话编排 + QQ 近况注入 |
| `plugins/surfcore/lib/pet-chat.js` | 悬浮窗提示词（记忆卡 / 配图） |
| `plugins/surfcore/lib/orb-companion.js` | 陪伴模式：定时截图、SHA 去重、短评清洗、每小时上限、上下文消息、失败降级/退避 |
| `plugins/surfcore/assets/orb-app/companion.html/css/js` | 字幕条：单条/上下文/历史、A−/A+ 字号、长按拖动、开收输入框、发送回复 |
| `plugins/surfcore/scripts/test-orb-companion.mjs` | 陪伴模式 10 项单测（含失败只降级） |
| `docs/sprintkey/COMPANION.md` | 陪伴模式当前设计、接口、几何、踩坑与验收清单 |
| `docs/sprintkey/MEMORY-ARCHIVE.md` | 聊天全量存档目录/字段/滚动/发送/设置与验收 |
| `src/friend-guard.js` | 好友申请判定层（白名单范围 / 配额 / 冷却 / 提示词） |
| `scripts/test-friend-guard.mjs` / `scripts/test-friend-wiring.mjs` | 好友申请 18 项判定 + 9 项接线测试 |
| `src/memory-card.js` | 衰减记忆卡（含 `includePetInBili`、B站 侧 fail-closed） |

修改的既有文件：`src/bridge.js`、`plugins/surfcore/lib/index.js`、`plugins/surfcore/lib/client.js`。

## 新增功能时按这个格式补一条

1. 在总表加一行（功能 / 入口 / 代码 / 配置键）；
2. 下面加一节，写清「做什么 / 入口 / 接口或配置 / 注意（踩过的坑）/ 验证方法」；
3. 在 [`CHANGELOG.md`](../CHANGELOG.md) 顶部加对应条目，必要时在文档里记一条踩坑。
