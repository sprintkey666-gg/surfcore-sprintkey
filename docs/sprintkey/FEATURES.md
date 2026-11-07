
> **与上游 v0.8.9 的差异**：本分支已增量同步到上游 v0.8.9（2026-11-07），合并细节与「哪个撞车点怎么裁决」见 [UPSTREAM-SYNC.md](./UPSTREAM-SYNC.md)。上游没有的能力（桌宠/字幕/记忆互通/回复速度/好友申请/自动发图/日记/MCP 自愈）全部保留；被上游取代的旧实现已在核对表里列出。

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
| 23 | 悬浮窗 / 字幕 ↔ QQ / B站：同一个她（记忆互通 + 回复速度） | SurfCore → 悬浮窗 → 记忆互通 / 回复速度（会话·字幕） | `plugins/surfcore/lib/{interop,orb-agent,pet-chat,desktop-archive}.js`、`src/chat-archive.js`、`src/memory-card.js` | `socialV2.orb.interop`、`socialV2.orb.chat.reply`、`socialV2.orb.companion.reply` |
| 24 | 字幕窗不闪不跳 · 托盘隐藏不留残影 | 无（修 bug，托盘菜单「隐藏到后台」） | `plugins/surfcore/assets/orb-app/{main.js,companion.js,companion.css}` | `socialV2.orb.companion`（沿用） |
| 25 | 桌宠：形象包切换 / 待机动作 / 注视 / 气泡重做 | SurfCore → 悬浮窗 → 外观；右键桌宠 | `plugins/surfcore/lib/{pet-packs,pet-gaze,pet-assets}.js`、`assets/orb-app/{pet.js,pet.css,main.js,preload.js}` | `socialV2.orb.pet.gaze`、`socialV2.orb.pet.wander`、`<stateDir>/orb/pet/packs.json` |
| 26 | 看屏幕：只截主人当前用的窗口（三档） | 悬浮窗面板「眼」/ 会话里说「看一眼」/ 陪伴模式 | `plugins/surfcore/lib/orb-api.js`（`WINDOW_SCRIPT` / `SCREEN_SCRIPT` / `look`） | `socialV2.orb.screen.*`（沿用） |

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
- **配置**：`socialV2.diary = { enabled, dir, everyDays(默认1), hour(默认22), maxChars(默认1200), allowPrivateDetails(默认true), send:{enabled,withFile} }`；自动写默认关；`allowPrivateDetails` 默认开。
- **路径**：选目录后存 `<dir>/<角色ID>.md`；留空 = `<DSH_HOME>\surfcore\diary\<角色ID>.md`。
- **目录选择器**：设置页「浏览…」打开自绘 `DirPicker`（列 C/D/E 等盘符、进目录、手输路径 + 前往），不再依赖系统 `FolderBrowserDialog`；后端 `GET /dsh-surfcore/api/browse-list?path=`。
- **接口**：`GET/POST /api/socialV2/diary`，action=`status|write|send`；`force:true` 绕过开关。
- **发送**：只私聊 `admin.qq` / `ownerQQ`，可附 `.md` 文件；QQ 离线写 pending，上线补发；状态在 `<DSH_HOME>\surfcore\diary-state.json`。
- **验证**：`scripts/test-self-expression.mjs`；真实发送 19:37:00 正文 + 19:37:02 `char-mvrnvr2i.md`；`ui-dir-picker.mjs` 全流程；截图 `ui-self-expression-diary.png`、`ui-dir-picker-*.png`。

- **2026-11-02 起：一文一档**：每篇日记按时间建一个文件（`<目录>/<角色ID>/2026-11-01_21-30.md`），可设「每 N 篇合并成一档」，设置页只列最近 5 篇；老的 `<目录>/<角色ID>.md` 会转成 `*.legacy-<ts>.bak`。
- **公开日记**：`socialV2.diary.public = { enabled, dir, everyDays, hour, maxChars, perFile, visibility(1/4/64), maxPerDay, allowNames }`，写完直接发 QQ 空间（`send_qzone_msg`）。人名可以留（群里的事、谁发起的可以用昵称），钱/账号/证件/手机号/QQ 号/链接/住址一律清洗。
- **私密日记**：仍只私聊发给主人；`allowPrivateDetails`（默认开）打开时，素材里的人名用真实昵称、可写关系/细节/地点/金额，只禁密码/验证码/完整银行卡/身份证号；关掉则退回「主人/对方」代称并禁可识别信息。开关只管新日记，不重写旧文。

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

- **做什么**：DSH 有时会把 `~/.dsh/profiles/desktop/cordis.patch.yml` 重写掉，丢掉 `mcp-snowluma` / `mcp-snowluma-host` / `mcp-web-search-safe` 三条，于是所有 `mcp__snowluma__*` 工具变成 `unknown tool`。桥接启动时检查并补回。
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

## 23. 悬浮窗 / 字幕 ↔ QQ / B站：同一个她（记忆互通 + 回复速度）

**背景**：以前悬浮窗会话和陪伴字幕其实是「另一个她」——只读同一张 `memory-card-prompt-qq.md`，人设截前 4200 字、记忆截前 2600 字，也不写回记忆卡；回复只有直连单轮一条路，没有 QQ 那边的会话连续性。主人要求「就像插件 qq 聊天一样专门开一个会话来进行聊天（注入记忆和人设）」，并且字幕/会话的记忆也要进记忆卡、进 Sprintkey 的记忆备份。

**互通（`interop`）**：`orb.interop = { qq, bili, identity, recent, recentLines(4~40), recentHours(1~168), personaMaxChars(4000~30000), memoryMaxChars(2000~20000) }`

- `qq` / `bili`：分别注入 `memory-card-prompt-qq.md` / `-prompt-bili.md`（B站 卡里本来只有公开内容）。
- `identity`：注入「她叫谁、主人是谁、这台电脑是主人的、不是在群里说话」——以前这块完全没有，所以「你」指谁经常糊。
- `recent`：读聊天存档里**别处**最近 N 行（QQ 为主，桌面这条线自己的话不重复塞），成 `- [来源] 谁：内容` 行。
- 人设不再写死 4200 字，记忆不再写死 2600 字，按配置上限裁（末尾标「…（后面省略）」）。
- 拼接顺序固定：身份 → 最近在别处 → QQ 卡 → B站 卡，总长受 `memoryMaxChars` 约束。

**回复速度（两套，各自独立）**：`orb.chat.reply` 管悬浮窗会话，`orb.companion.reply` 管陪伴字幕。

- `legacy`（原版）：专门开一个 DSH 会话（`orb-chat-<角色>-<代数>` / `orb-companion-<角色>-<代数>`），用 `sessionController` 推一轮、收 `turn/end` 的最终文本 —— 上下文连续，和 QQ 那边同款回合；代价是越聊越慢。
- `fast`（快回复）：仍旧直连 `ctx.get('llm').stream()` 单轮，每句从记忆卡重建上下文。
- 原版失败/超时（默认 180 秒，30~600 可调）**自动退回快回复**，不让她彻底哑掉；`sessionTurns=0` 表示永不换会话，>0 每 N 轮递增代数换一个干净会话。

**数据类型**：

- 记忆卡：`inbox` 事件多带 `channel`（`orb` / `companion` / `pet`），摄取时落成标题前缀（`悬浮窗 · …` / `字幕 · …` / `桌宠 · …`）+ tag + `record.channel`。
- 聊天存档：`chat-archive.js` 新增 `channelLabel` / `messageType` 两列，取值 `qq-message` / `orb-chat` / `companion-subtitle`；新增 `readRecentChatRecords()`（只读文件尾部 256KB，切半的首行丢掉），给「最近在别处聊了什么」用。

**入口**：悬浮窗面板 → 设置 → 「记忆互通（和 QQ / B站）」「回复速度（会话 / 字幕）」两段。

**验证**：`scripts/test-orb-interop.mjs`（24 项）、`scripts/test-orb-agent.mjs`（17 项）、`scripts/test-memory-card-channel.mjs`（22 项）、`scripts/test-chat-archive-recent.mjs`（20 项），均已登记进 `scripts/test-audit.mjs`。

## 24. 字幕窗：不闪、不跳，托盘隐藏不留残影（0.12.15）

**背景**：陪伴模式字幕每 3 秒闪一下、位置上下跳；点「隐藏到后台」桌宠还赖在桌面上。日志里 `收回异常窗口` 一条能刷 11690 次。

**闪**：`main.js` 每 3 秒轮询里**无条件** `setAlwaysOnTop(false)` → `(true,'screen-saver',1)` → `moveTop()`，DWM 每次都要把 `transparent:true` 的窗口拆下重合；叠加渲染端每次重推都把字幕区 `textContent=''` 全量重建。现在：只在「还没置顶」时补一次 `setAlwaysOnTop`，`moveTop()` 只做一次，状态推送做指纹去重（`sendCompanionState`），渲染端节点复用 + 指纹比对，`.bar` 的 `backdrop-filter: blur()` 换成内描边。

**跳**：`setBounds(738)` 回读恒 `740`（无边框窗保留非客户区 + 175% 缩放），`if (b.width !== layout.width)` 永不收敛 → 每 3 秒真改一次宽 → 重新折行 → 高度变 → 底边锚定重算 y → 顶边上下漂。现在：宽度收敛容差 4px，高度按 8px 网格对齐（`snapCompanionHeight`）并把拖动基准一起更新，两窗都 `thickFrame:false`，主窗自愈阈值从 2 提到 6 且走 `applyBounds(…, 'self-heal')`。

**残影**：`hideWindow()` 只 `win.hide()`，从没碰字幕窗；而轮询里 `if (!isVisible()) showInactive()` 会在 3 秒后把隐藏的窗又拉回来。现在：隐藏同时收桌宠 + 字幕窗 + 清定时器并置 `hiddenByUser`，`showWindow` 按 `restoreSurface` 恢复（该恢复哪个），`second-instance` 也尊重 `hiddenByUser`；`SetWindowPos` 的 `0x0043` 去掉 `SWP_SHOWWINDOW`（`0x0013`），`setVisibleOnAllWorkspaces` 只在 macOS 调（Windows 上会让 DWM cloaked）。

**验证**：`scripts/test-orb-window-state.mjs`（28 项纯函数 + 源码断言，已进审计）；真机看 `~/.dsh/surfcore/orb/orb-app.log` 里 `收回异常窗口` 是否停刷。

## 25. 桌宠：形象包 / 待机动作 / 注视 / 气泡重做

**形象包**：`<stateDir>/orb/pet/packs/<id>/{pack.json,webm/*.webm,preview.png,LICENSE}` + `packs.json { version:1, activePackId }`。内置包 `id='dsh-pet'` 只读（老目录 `orb/pet/webm`），新包放在 `packs/` 里；导入支持「选文件夹」和「选 .tgz」（认 `webm/*.webm`，也认上游包的 `assets/webm/*` + `assets/config.jsonc`），先 staging 再原子替换。`POST /api/orb/pet-packs { action: list|status|verify|activate|remove|preview|import }`，`activate`/`import`/`remove` 之后立刻 `writeHostFile(true)`，桌面端 4 秒内热重载（`pet.js` 的 `startConfigWatch`）。

**动作**：`pickIdleAction()` 以前只抽 idle+categories+moves，manifest 里的 `turn`（东张西望）和 `weights.turn` 从来没生效；现在按权重抽 idle / turn / move / category / click，webm 播完再排下一个，带 watchdog 防「不触发 ended 卡死」和「迟到 ended 误触发」。

**走位**：`pet.js` 调 `window.orb.petMove({ dx, dy, ms })` → 主进程 `ipcMain.handle('orb:pet-move')` 按 `screen.getDisplayMatching(bounds).workArea` clamp（留边距）、`animateTo(…, { duration: ms })` 平滑移动，返回 `{ ok, clamped, x, y }`；关掉走位（`pet.wander.enabled=false`）就只播原地动作。

**注视**：`pet-gaze.js` 把光标坐标算成方向 / 镜像 / 距离，`pet.js` 每 40ms（20~200 可调）问一次 `window.orb.cursor()` 并写 `--gaze-shift`，眼睛和身体会真的朝光标偏；`pet.gaze.enabled=false` 关。

**气泡**：改成实心卡片（`#1b2130` + 1px 内描边 + 投影 + 90ms 淡入），按「头顶可用余量」`placeBubble()` 定位，`-webkit-line-clamp:3`、240 字截断、带图 2 行 + 40px 缩略图。

**许可**：内置素材来自 `dsh-pet`（MIT）；`Coopanion` 是 AGPL-3.0-or-later，**只参考设计，不搬代码/素材**。两条都写在新文件头里。

**入口**：悬浮窗面板 → 设置 → 外观（形象包下拉 / 导入 / 试播 / 注视 / 走位）。

**验证**：`plugins/surfcore/scripts/test-pet-packs.mjs`（8 组）；回退形象 `avatar.png` 在素材未装时仍可用。

## 26. 看屏幕：只截主人当前用的那个窗口

以前 `look()` 用 PowerShell 截**整屏**，模型看到一大片桌面，还容易把别的窗口看混。现在先枚举前台窗口（z-order 下探 16 层、跳过自己的三个窗口、带标题和矩形），再按矩形只截那一个窗口：失败才回退整屏并在 `note` 写原因。

- 三档：`preview`（设置页试拍，原尺寸 PNG）/ `chat`（会话里「看一眼」，960 宽 JPEG）/ `companion`（陪伴字幕，1280 宽 JPEG）。
- `runChatTurn` 在 auto 模式截图失败但拿到窗口标题时，会用标题再问一次（`screenMode:''`），并把 `[[看一眼]]` 暗号从回复里剥掉。
- 返回字段带 `preview/mime/width/height/tier/source/captureRect/fallback/note/title/windowRect/cursor`，老字段全保留，前端不用改。

**验证**：真机 PowerShell 截到 2111×1337@(245,77)，`read_image` 确认只有窗口内容、无桌面偏移；黑名单 / 屏幕权限关 / 超限 / manual 模式都不占额度。

## 27. 记忆卡：「最近很要紧的」——暗号事故的根因与修法

**事故**：2026-11-02 上午她在 QQ 私聊里和主人约了暗号（问「在吗 测试」→ 答「示例暗号ABC」）。11-03 晚上在悬浮窗里问，她一本正经地说「暗号对上了，鲸鲸在」——**在编**。

**这不是互通没接上**：那条记忆确实在卡里（`mem_654c17336ab254`，importance 74，tags `owner/qq/initial`），悬浮窗也确实在读同一张卡。真正的问题在**渲染**：

1. `sectionize()` 把 `owner + isInitial` 的记录放进「最初的日子」，排序是 `createdAt` **升序**（最早的在前），QQ 版限额 6 条 → 11-02 的新约定被 10-28 那批老记录挤掉，整条都没进注入块。
2. 想用 `lastSeenAt` 兜也不行：一条记忆只有进了提示词才可能被「想起」，被想起才会刷新 `lastSeenAt` —— 没被想起的重要记忆永远停在当年，同分全排到后面，**越漏越漏**。

**修法**（`src/memory-card.js`）：

- 新增 `recentImportant` 段（`## 最近很要紧的（别弄错）`，priority 90，排在 anchors 之后、initial 之前）。条件：非 pinned、非桌宠/悬浮窗来源、未模糊、`importance >= 65`、`createdAt` 在 `recentImportantDays`（默认 14 天）内。
- 该段排序用 `importance` 降序，**同分比 `createdAt`（事情发生的时间），不比 `lastSeenAt`** —— 断掉上面那个死循环。
- 默认 `recentImportantLimit: 6`（真机那张卡里，暗号按同分排到第 6 位；4 条仍会漏）。
- 「最初的日子」的排序也从 `createdAt` 升序改成按重要度。
- 配置项：`recentImportant` / `recentImportantDays` / `recentImportantMinImportance` / `recentImportantLimit`（钳制 1~90 天、30~100 分、1~12 条）；B站 版这一段恒为 0（私事不进 B站 卡）。

**跨端最近对话**：`interop.recentLines` 12→30、`recentHours` 24→48。暗号那轮在 6 小时前、约 100 条消息之前，12 行 / 24 小时根本够不着。

**验证**：拿本机真卡（610 条）直接渲染 —— `renderMemoryCard(card, {platform:'qq'})` 1656 字、含「示例暗号ABC」；`platform:'bili'` 0 字。`scripts/test-memory-card-recent-important.mjs`（9 组，含「同分但 lastSeenAt 更新的一批记录不能把暗号挤掉」这条真机陷阱）。

**重建注入块**：`saveMemoryCardOutputs(paths, card, cfg)` 会同时重写 `memory-card.md` / `-prompt-qq.md` / `-prompt-bili.md`；改完卡渲染逻辑后跑一次，重启前就能生效。

## 28. 互动监测：她在用什么窗口、改什么文件、听什么歌

- 采样脚本 `plugins/surfcore/scripts/activity.ps1`（**必须保持纯 ASCII**：PS 5.1 会把无 BOM 的 UTF-8 当 ANSI，中文注释直接 ParserError；中文常量用 `-join @([char]0x8BB0,…)` 拼）。输出一行 JSON：
  `{"at":…,"active":{"app","title","kind","file","project"}|null,"media":{"app","title","artist","album","status"}|null,"cursor":{x,y}}`
- 前台窗口用 P/Invoke 枚举 z-order（跳过自己的三个窗口）；标题按 VSCode / Cursor / JetBrains 的 `file — project — App`、记事本 `文件名 - 记事本`、Sublime 等规则解析出「在改哪个文件」；命中 `orb.screen.denyTitles` 的窗口直接返回 `active:null`。音乐走 WinRT `GlobalSystemMediaTransportControlsSessionManager`（PS 5.1 要用 `System.WindowsRuntimeSystemExtensions` 的泛型 `AsTask` 反射 + 自定义 `Await`，`.GetAwaiter()` 会报「__ComObject 不包含 GetAwaiter」）。
- 调度 `lib/orb-activity.js`：`pollMs` 默认 20s（钳 10~120s），内容没变不重写文件，5 秒限流防抖，关开关就 `stop()` 并删 `state/orb/activity.json`，失败只记日志保留旧数据。
- 入口：`GET|POST /api/orb/activity`；桌面端 `orb:activity-config`（get/set）、`orb:activity`（5 秒按 mtime 推送）；右键菜单「监测 ›」三个开关 + 5/10/30 分钟 + 「现在看一眼」；设置页「悬浮窗 → 外观」同一组开关。
- 配置：`orb.activity { enabled:false, pollMs:20000, kinds:{window,file,music}, bubbleEveryMs:600000 }`。
- 实测输出：`{"active":{"app":"WINWORD","title":"工业机器人典型应用_期末复习范围(1).pdf - Word","kind":"document"},"media":{"app":"QQMusic.exe","title":"Chase the Light","artist":"塞壬唱片-MSR/ADÀI宋黛霆/David Lin/Erik Castro","status":"playing"},"cursor":{"x":807,"y":500}}`
- **验证**：`plugins/surfcore/scripts/test-orb-activity.mjs`（17 项：配置钳位、清洗、去重、限流、kinds 三态、stop 删文件、真实 PS 采样、标题解析、denyTitles）。

## 29. 桌宠气泡与动作过渡（0.12.17）：真的能看见、真的不闪

**气泡「没出现」的真元凶之一**：三层视频层带 `z-index:1/3`，而 `.petStage` 不是层叠上下文、`#bubble` 是 `auto` —— 气泡被自己身上的视频盖住了。修法：`.petStage{isolation:isolate;z-index:0}`、`#bubble{z-index:6}`。另外 `ensureBand()` 里 `headroom()>=64` 的短路删掉（首次必申请一次气泡带），并且 `hideBubble()` 不再把窗口缩回去（断开「气泡长高→窗口长高→位置漂移」）。

**定位**：`maybeBubble` 六道门全加了日志（`[bubble] skip reason=not-pet-mode|panel-expanded|no-her-message|no-id|same-id|already-seen`），成功路径打 `[bubble] show id=…` 与 `[bubble] rect top=… win=…`。下次「气泡没出来」直接看 `~/.dsh/surfcore/orb/orb-app.log` 就知道卡在哪一道。

**样式**：深色卡片 `rgba(22,27,38,.94)` + 1px 内高光描边 + 10px 圆角 + 旋转 45° 的小尾巴 + `0 10px 28px rgba(0,0,0,.45)` 投影，13.5px/1.5、4 行折叠，120ms 淡入；带图时缩略图在文字上方。

**动作不再闪**：原来 `play()` 在 `next.play()` 之后**立刻**切 `classList`，新视频首帧还没解出来就换层，播完又立刻 `play(idle)` 硬切。现在三层：`pvA`/`pvIdleB` 两路 idle **常驻循环**交叉淡入，`pvAction` 动作层盖顶；任何切层都先等 `requestVideoFrameCallback`（900ms 超时回落 `readyState>=2`）再动 opacity，动作播完 `finishAction()` 先淡出 200ms、再 pause + 卸 `src`，露出下面一直在跑的 idle。`currentTime=0` 只对刚装载的源用，可见层绝不重置。

**figure（网页形象）包**：`pack.json.kind='figure'` 时隐藏视频层、iframe（`sandbox="allow-scripts"`）加载 `entry`；宿主→形象 `{type:'pet:action',name}` / `{type:'pet:gaze',dx,dy}`，形象→宿主 `{type:'figure:ready',actions:[…]}`；6 秒没 ready 自动退回 webm。随仓内置 `sprintkey-fish`（纯前端 SVG Q 版蓝鲸，MIT）。

**右键菜单**：新增「试一下气泡」（走 `POST /say` 正常链路）、「皮肤 ›」（包列表 / 导入文件夹 / 导入 .tgz / 打开皮肤文件夹 —— 走 `shell.openPath`）、「监测 ›」。旧项全部保留。

**验证**：`scripts/test-orb.mjs`（67 + 289 项）、`test-orb-window-state.mjs`（28 项）、`test-pet-packs.mjs`（13 项）；真机看日志里 `[state]` 与 `[bubble]` 行。

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
| `scripts/test-self-expression.mjs` | 签名/动态/日记 19 项单测 |
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
| `plugins/surfcore/assets/orb-app/pet.js` / `pet.css` | 桌面宠物与头顶气泡（`placeBubble()` 按头顶余量定位 + 3 行折叠） |
| `plugins/surfcore/lib/pet-packs.js` | 桌宠形象包：目录 / `packs.json` / 导入文件夹与 .tgz / 启用 / 校验 / 试播（内置包只读） |
| `plugins/surfcore/lib/pet-gaze.js` | 光标 → 注视方向 / 镜像 / 距离（20~50ms 节流），供 `pet.js` 写 `--gaze-shift` |
| `plugins/surfcore/scripts/test-pet-packs.mjs` | 形象包 8 组单测（空目录/导入文件夹/导入 tgz/校验/试播/内置包删不掉/脏 id/回落） |
| `scripts/test-orb-window-state.mjs` | 字幕窗闪烁/跳位/托盘残影 28 项（纯函数 + 源码断言） |
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
| `plugins/surfcore/lib/interop.js` | 互通记忆纯函数：`normalizeInterop` / `clampText` / `formatRecentLines` / `buildInteropMemory` |
| `plugins/surfcore/lib/orb-agent.js` | 「原版」回复的会话驱动器：`createTurnCollector` / `createOrbAgent`（inspect→create、turn/end 收文本、超时取消） |
| `scripts/test-orb-interop.mjs` | 互通记忆 24 项单测（钳制/截断/时间窗/拼接顺序） |
| `scripts/test-orb-agent.mjs` | 会话驱动器 22 项单测（只认 turn/end、ready 缓存、失败/超时清理、**AbortSignal 必传**、agentTurns 写盘） |
| `scripts/test-memory-card-channel.mjs` | 记忆卡数据类型 22 项单测（悬浮窗/字幕/桌宠的标题前缀与 tag） |
| `scripts/test-chat-archive-recent.mjs` | 存档数据类型 + 尾部回读 20 项单测 |
| `src/memory-card.js` | 衰减记忆卡（含 `includePetInBili`、B站 侧 fail-closed、「最近很要紧的」段） |
| `scripts/test-memory-card-recent-important.mjs` | 记忆卡「最近很要紧的」9 组单测（暗号事故回归） |
| `plugins/surfcore/lib/orb-activity.js` | 互动监测调度：采样 / 去重 / 限流 / 开关 / 落盘 |
| `plugins/surfcore/scripts/activity.ps1` | 前台窗口 + 标题解析 + WinRT 音乐 + 光标采样（**纯 ASCII**，一行 JSON） |
| `plugins/surfcore/scripts/test-orb-activity.mjs` | 互动监测 17 项单测（配置/清洗/去重/限流/kinds/真实采样/标题解析/黑名单） |
| `plugins/surfcore/assets/pet-packs/index.json` | 内置皮肤清单（dsh-pet@0.4.1 按需下载 / sprintkey-fish 随仓） |
| `plugins/surfcore/assets/pet-packs/sprintkey-fish/` | 随仓自绘 figure 形象包（`pack.json` + 纯前端 SVG `index.html`，MIT） |

修改的既有文件：`src/bridge.js`、`plugins/surfcore/lib/index.js`、`plugins/surfcore/lib/client.js`。

## 30. 悬浮窗 / 字幕回复真的开一个 DSH 会话（0.12.18）

**做什么**：`chat.reply.mode = legacy`（默认「原版」）时，桌宠会话与陪伴字幕不再走单轮直连，而是**真的开一个 DSH 会话**（`orb-chat-<角色>-<代数>` / `orb-companion-<角色>-<代数>`），把完整 system（身份 + 人设 + 记忆卡 + 跨端最近对话）和这轮输入推给 `sessionController.prompt`，收 `turn/end` 的最终文本当回复——和 QQ 桥接同款回合。失败或超时（默认 180 秒）自动退回直连，不会哑掉。

**为什么之前一次都没跑起来（两层，缺一不可）**：

1. `plugins/surfcore/lib/orb-agent.js` 调 `sessionController.prompt({...})` 时**没传第二个参数 `signal`**，而 DSH 内部无条件执行 `signal.throwIfAborted()` → 每轮抛 `Cannot read properties of undefined (reading 'throwIfAborted')` → 被 catch 成「退回直连」，只在 `plugin.log` 留一行。表面看就是普通直连回复。
2. `bumpAgentTurns(history, turns)` 在 `turns <= 0` 时直接 return，而 `sessionTurns` 默认 0（=不换会话）→ 就算跑成功也不写任何痕迹，事后无从判断。

**怎么改的**：`run()` 用 `AbortController`，`sc.prompt(args, abort.signal)`，超时先 `abort.abort()` 再 `sc.cancel({sessionId})`，`cancel()/dispose()` 也 abort；`bumpAgentTurns(history, every, sessionId)` **永远**写 `agentTurns/agentTotal/agentLastAt/agentLastSession`，达到 `every` 才换代 `agentGen`；人设只在**这个会话代数第一次开口**时整段推（`history.agentSystem[sessionId]` 记账），后续轮次只推「人设没变」+ 最新记忆卡，避免上下文堆 N 份人设。

**验证**：重启 DSH 后说一句话 → `~/.dsh/surfcore/plugin.log` 出现 `[pet-chat] 原版会话 ok session=orb-chat-…`；`orb/chat/history-<角色>.json` 出现 `agentTotal`/`agentGen`/`agentSystem`；问只有记忆卡里才有的东西（约定的暗号）能答对。单测 `node scripts/test-orb-agent.mjs`（含「prompt 收到 AbortSignal」「超时会把 signal abort 掉」「pet-chat 记 agentTotal」）。



## 31. 桌宠渲染：不再重影、鼠标划过不搬、气泡真的会冒（0.12.18）

**重影**：`.pvBase{z-index:1}` 和 `.pvAction{z-index:3}` 同时 `opacity:1`，action 是 VP9-alpha 视频，透明区直接透出底下的待机鲸鱼 → 看着像两只叠在一起。修法：action 首帧到达后先 `dimBase(true)`（底色层 90ms 淡出），再过 90ms 才给 action 加 `.on`；`finishAction()` 摘 `.on` 后立刻 `dimBase(false)` 把待机放回来；交叉淡入只允许 base A/B 之间发生。`safePlay()` 给每层串行化 `play()`，`AbortError` 与 `interrupted by a call to pause` 一律吞掉并打 `[pet] layer-play-race`。

**鼠标划过就搬窗口**：`pickIdleAction()` 把 manifest 的 `moves` 混进了待机抽取，鼠标一划过正好抽到 move 动作就真去调 `petMove()`。修法：待机池剥掉 move（另加 `moveNames` 名字级兜底），`wander.enabled` 默认 false（只有 `=== true` 才算开），move 只由右键「走一走」或 45~150 秒随机漫游触发。

**气泡一次都不冒**：`maybeBubble` 拿「已读水位」`seenId` 当发布门，可面板一展开 `markSeen` 就把水位推到最新 → 之后所有新消息都被判成「已读」。修法：删掉 seenId 判据，改成 `lastBubbleId`（上次冒泡的 id）+ `lastUserReadAt`（刚读的时刻）；面板展开时**延后 600ms** 冒、收起时补冒，不丢消息。日志：`[bubble] show id=… kind=… why=…` / `[bubble] skip reason=…`。

**气泡样式**：照 `Bai-Cute/big-blue-fish-desktop-pet` 的 `CompanionBubble.cs` 重画——奶油白 `#fffbf4` + 1.5px 蓝灰 `#506098` 描边 + 24px 圆角，尖角用旋转 45° 的方块只留两条边描边，和圆角框体拼成**一条连续轮廓**；`min(420px, 100%-24)`、13.5px/1.55、五种场景 class（chat/notice/event/news/error）+ 深色一套。

**菜单与面板**：照 `MerZlin/dsh-pet-indesktop` 的视觉规范——侧栏 52px（≥620px 展开 200px）七个域、页面标题 22/600、小节 13/600、卡片 12 圆角、18px 节奏、浅色/深色两套 token；会话气泡她奶油白+描边、主人蓝灰实底、时间戳 11px、发送按钮 `#506098`。

**验证**：`node scripts/test-orb.mjs`（67 + 313 项，含 dim 时序、待机池不含 move、气泡四道门、kind class、菜单 token、侧栏宽度）；真机看 `~/.dsh/surfcore/orb/orb-app.log`。

## 32. 皮肤与配色、监测事件气泡（0.12.18）

**皮肤目录同步**：`list`/`activate` 之前先把 `assets/pet-packs/index.json` 里的内置包幂等落成 `packs/<id>/`（webm 包只写 `pack.json` 并把目录指回内置只读素材，figure 包复制 `index.html`），修掉日志里那句 `没有这个皮肤包：sprintkey-fish`。

**新可分发皮肤 `big-blue-fish`**：`source.kind='github-assets'`，安装时从 `https://codeload.github.com/Bai-Cute/big-blue-fish-desktop-pet/tar.gz/refs/heads/main` 只解出 `code/BigBlueFish.Windows/assets/fish/*.webm` + `animations.json` + `LICENSE.txt`；`Pool:'Disabled'` 跳过、节日项转 `festivals.json`、许可落 `LICENSES/big-blue-fish-LICENSE.txt`（**assets 是 MIT，Copyright (c) 2026 PC2005-cloud**）。

**六套配色**：`pack.json` 的 `tints[{id,name,filter}]`（原色/鲸蓝/樱花/薄荷/暮金/夜航）→ 配置 `orb.pet.tint` → `petInfo()`/`hostPayload()`/`orb:petconfig` → 渲染端 `--pet-tint` 的 CSS filter。

**监测 → 气泡**：`createOrbActivity` 增加 `onSample`；`orb-api` 的 `createActivityFeed` 把变化转成 `kind:'event'` 的伪消息（`你在改「a.js」（surfcore） — VS Code`、`在听《…》 — …`），按 `activity.bubbleEveryMs`（默认 10 分钟）节流 + `eventKey` 去重，**不进 history、不进聊天存档、不写记忆卡**；`POST /orb/activity/test` 可以立刻采一次用来验证。

**许可边界**：dsh-pet（MIT）、big-blue-fish 的 assets（MIT）可以用；**Coopanion（AGPL-3.0-or-later）与 dsh-pet-indesktop 的角色形象（CC BY-NC-SA 类）不入库、不打包**，只允许用户自己导入自用。

**验证**：`node plugins/surfcore/scripts/test-pet-packs.mjs`（18 项）、`test-orb-activity.mjs`（21 项）、`test-orb-files.mjs`；真机 `POST /orb/activity/test` 后看 `[bubble] show kind=event`。

## 33. 气泡浮在头顶上方、按内容变宽；只有左键按住才拖得动（0.12.19）

**触发**：主人 m03607–m03609 附截图——气泡是一张 150px 的窄长白卡，每行两三个字，还直接压在鲸鱼身上；同时鼠标只要从她身边划过，窗口就跟着光标跑。

**气泡为什么压在身上（三层）**：
1. 窗口宽度被锁死在「宠物宽 + 40」（`baseSize()`），气泡只能拿到 ~150px，长句折成竖条，视觉上就像一坨压在头上；
2. `ensureBand()` 只申请**高度**，不申请宽度；`orb:bubble-space` 也只认 `{px}`；
3. 正文高度预算没扣内边距与描边（实测 39px），超长正文会溢出 `.bubbleBody` 的框，压到她身上。

**修法**：
- 主进程 `orb:bubble-space` 改成 `{ band, width }`：band 让窗口往上长（**脚底** `y+height` 不动），width 让窗口左右变宽（**水平中心** `x+width/2` 不动），所以窗口变大时她不会挪位；`PET_BUBBLE_MAX_W=560`，且不超过工作区 - 24。`preload.bubbleSpace(opts)` 同步支持对象与老的 `px` 数字。
- `clampForMode()` 的 `bodyH` 不再用「窗口宽 - PET_SIDE_SPACE」反算（窗口会被气泡撑宽），改用 `prefs.petSize || pet.size`，否则加宽后她能拖到比屏幕还高。
- 渲染端 `fitBubble()` 两趟：先按目标列宽测 `scrollHeight`，再 `bubbleSpace({band: contentH+18, width: colW+24})`，然后用返回尺寸 `placeBubble()` 重排；列宽照 dsh-pet-indesktop 的换行宽度：短句 248px，超过 60 字渐进放宽到 360px 封顶，最小 240px。
- `placeBubble()` 底边 = `headFromBottom() + 10`，最高 `band - 12`；正文 `max-height = room - chrome`（chrome 用 `getComputedStyle` 量，兜底 37），超出在 `.bubbleBody` 内部滚动；`--tail-x` 按 `--gaze-shift` 算，尾巴尖始终指向头顶中心。
- 命中矩形统一：`main.js` 的 `bodyRectInWindow()` 与渲染端 `petBodyHit()` 同一套算法（`bodyH = min(stageH - band, size*1.22)`、`bodyW = min(stageW-24, bodyH*1.6)` 居中），气泡撑宽后的左右透明边不再算她。

**鼠标划过就搬窗口（真因）**：`orb.js` 里 `let drag` 被小球与 `petStage` 的 mousedown **共用**，而小球那条 `window mousemove` 直接 `window.orb.move(drag.wx + dx, …)`，**完全不看 `ev.buttons`**；再叠加 `orb:hit` 每帧强制关穿透 + 90ms 穿透轮询偶尔吞掉 `mouseup`，`drag` 就一直清不掉 → 之后任何 mousemove 都在搬窗口。

**修法**：拆成 `ballDrag` / `petDrag` 两个独立状态；`mousemove` 先判 `if (!(ev.buttons & 1)) { endPetDrag(); endBallDrag(); return; }`；按下后 6px（`DRAG_MIN_PX`）内不算拖动，越过阈值才 `petdragging` + 播拖拽动画 + 跟手；`mouseup` / `blur` / `pointercancel` / `document mouseleave` / `visibilitychange(hidden)` / `Esc` 全部收尾；拖动中不弹右键菜单、不触发 click/react。

**顺手**：右键里那条屏幕提示 `她看到：…` 缩成 1~2 句（`在用 …` / `在听 …` 各 ≤18 字），不再把整串拼进气泡。

**验证**：`node --check` 三个渲染端文件 + `main.js`/`preload.js`；`node scripts/test-orb.mjs`（67 + 328 项，新增 14 条：列宽 240/248→360、`fitBubble` 两趟与 `bubbleFitToken`、底边 `headFromBottom() + BUBBLE_GAP`、`--tail-x`、`petBodyHit` 按身体矩形、`ballDrag`/`petDrag` 双状态 + 无旧 `let drag`、`ev.buttons & 1`、`DRAG_MIN_PX = 6`、四种收尾监听、toast 截断）；`scripts/test-orb-window-state.mjs` 28 项。真机看 `[bubble] fit pass=… -> band=… width=…` 两行，确认没有被工作区夹小。

## 34. 监测提示改用气泡、长按才拖、走位不撞墙、原版会话改走 DSH HTTP（0.12.20）

**做什么**

1. **监测/屏幕提示不再是压在桌上的那条 `#petToast`**：`toast()` 在桌宠模式下直接走 `window.SurfPet.showBubble(...)`，复用气泡那套 `fitBubble()`（头顶上方、按内容变宽、脚底不动），面板模式才落回 `petToastEl`。以前那张卡是桌宠窗口里的固定 DIV，窗口只有 181×248，长句既压在她身上又被窗口边界裁掉（主人：「消息被背景截断没有完全显示」）。
2. **只有按住左键 ≥180ms 再拖才搬窗口**：`mousedown` 时记 `armAt = Date.now() + PET_DRAG_HOLD_MS(180)`；`mousemove` 里 `if (Date.now() < petDrag.armAt) return;` 才进入拖动判定。单击 / 双击 / 右键 / 从她身边划过都不动窗口。
3. **走位不再撞墙**：`walk()` 走之前按 `screen.availWidth - screenX - innerWidth`（向左则 `screenX`）量出剩余空间，`dist = min(随机距离, 余量-8)`，至少 8px。以前一路走到屏幕外、被主进程夹回来，看起来像「一走就出大 bug」。
4. **原版会话改走 DSH 的 HTTP API**：`orb-agent.js` 不再用 `ctx.sessionController.prompt`（它只认活着的 Agent，DSH 一重启会话变冷就抛 `session/agent-busy: prompt rejected`，于是每轮静默退回直连——history 里永远没有 `agentTurns`，用户看到的就是「根本没开会话」）。现在和 QQ 桥接同款：`NodeApiClient` → `sessions.create({cwd})` → `events.mux` + `follow(sessionId)` → `sessions.prompt` → 收 `turn/end` 文本；失败时丢掉映射、下一轮重建。

**入口 / 配置**：无需新配置。`orb.chat.reply.mode = 'legacy'`（默认）就走这条 DSH 会话；`fast` 仍走直连。会话 cwd 在 `~/.dsh/surfcore/orb/agent`（`pet` 宿主是 `.../pet/agent`）。

**注意（踩过的坑）**

- `unwrap()` 要的是 DSH 的 `{result:{ok,value}}` 信封，假客户端测试里也要按信封返回。
- `sessions.create` 之后的 `events.mux` 必须**先 follow 再 prompt**；DSH 偶尔在 `turn/end` 后立刻关掉 follow 流，所以驱动器还留了「最后一条 assistant 文本」兜底。
- 超时下限 500ms（测试用得到），默认 180s；超时会 `AbortController.abort()`，不会把下一次请求卡死。

**验证**：`node scripts/test-orb-agent.mjs`（建档/复用/失败重建/超时/并发 busy/forget + 4 条 pet-chat 源码断言）；真机看 `plugin.log` 里 `[pet-chat] 原版会话 ok session=… total=…`，失败时日志带 `data={"reason":"…"}`。

## 35. 去掉悬浮小球，只留桌宠（0.12.21）

**做什么**：主人要「悬浮窗只保留桌宠」，所以把原来那颗圆形悬浮球整个删了。现在桌面上的唯一形象是桌宠（webm 动画包或网页 figure 包都行），打开面板、看气泡、拖位置、右键菜单全由她承担。

**怎么删的**（三层都要动，少一层就会留下空白或死代码）

- 渲染端 `assets/orb-app/index.html`：删整段 `#ball`（含 `#ballAvatar`、`#badge`）。
- `assets/orb-app/orb.css`：删 `#ball` 及其 `::after` 尖角、`:hover/.hot`、`:active`、`.dragging`、`.thinking`、`@keyframes pulse`、`.avatar`、`.badge`，还有 `#ball.hidden` / `#root.expanded #ball` 两条规则。
- `assets/orb-app/orb.js`：删 `ball`/`avatarEl`/`badge` 三个元素引用、`applyAvatar()`、点球展开、悬停高亮、中键滚轮缩放、整段球拖动（`ballDrag`/`endBallDrag`/右键退出）与 `thinking` 转圈；`lastDragMoved`、`DRAG_MIN_PX` 留下给桌宠拖动用。
- `assets/orb-app/main.js`：`baseSize()` 不再有「球」分支，永远按桌宠尺寸算（`petSize` 记忆 + 气泡撑宽的 `bubbleWidth`）；删掉 `applyBallSize()` 与 ready-to-show 里把窗口宽度写进 `ballSize` 的那行；`orb:resize` 保留成空壳（老渲染端调用不报错）；DOM 自检改成问 `#petStage`。
- 插件侧 `lib/orb.js`：`DEFAULT_ORB.ball` 去掉 `mode`，`petInfo()` 恒 `mode:'pet'`、`wantMode:'pet'`，figure 包给 `manifest:null`；素材没装时 `fallbackReason` 改成「先显示静态形象」（`pet.js` 的 `showFallbackAvatar()` 兜底），不再回落成球。
- `lib/client.js`：外观页删「形象」下拉与「球大小 / 透明度 / 停靠 / 主题 / 头像」五行，桌宠设置恒显示；`lib/index.js` 自检项「悬浮球进程」改「桌宠进程」。
- 文案：系统提示里的「待在屏幕边上的悬浮球里」改成「桌宠（一只会动的小人）」；面板说明改成「桌面上的那只桌宠：点她打开面板」。

**注意（踩过的坑）**

- `ball.*` 剩下的 `size/opacity/dock/theme/avatar` 只是兼容旧配置，界面不再暴露；`orb-api.js` 里 `cfg.ball.theme` 仍在用（窗口主题）。
- 桌宠窗口的「收起态」变量还叫 `ballRect`/`ballSize`（历史名），语义已经是「收起后的矩形」，改名字会牵动一堆自愈/贴边逻辑，先留着。
- 只删一层会退化成「窗口在、屏幕空白」：`pet.js` 在没有 manifest 时会 `showFallbackAvatar()`，所以渲染端仍然有东西可画。

**验证**：`node scripts/test-orb.mjs`（329 项，含「只剩桌宠拖动状态」「悬浮球已删除」）、`node scripts/test-orb-window-state.mjs`（28 项）；装完看 `~/.dsh/surfcore/orb/app/index.html` 里没有 `id="ball"`、`orb.js` 里没有 `ballDrag`。

## 36. 长气泡不被屏幕切掉、鼠标划过不再搬走她（0.12.22）

**做什么**：修主人反复报的两件事——「消息气泡文字多了就被截断显示不全」与「鼠标靠近桌宠就把她移走了，明明没拖」。

**① 气泡被截断的真因**：她默认贴在屏幕最上沿（`ready-to-show y=34`），而 `main.js` 的 `clampForMode()` 里 `const minY = area.y - (height - bodyH)` 为了「气泡能到最上面」**故意允许气泡带跑出屏幕**。气泡越长 → 窗口越往上长 → 上半截直接出屏，正文被屏幕边缘切掉，`.bubbleBody` 的滚动层根本没机会生效。

**修法（整窗往下让一截，收起再还回去）**

- `assets/orb-app/main.js` 的 `orb:bubble-space`：新增 `bubbleOriginBottom` / `bubbleShiftApplied`。申请气泡带时算 `roomAbove`（她头顶到屏幕顶还有多少）、`wantBandNow`、`shiftMax`（往下还能挪多少），`shift = wantBandNow > roomAbove ? min(wantBandNow - roomAbove, shiftMax) : 0`，`fitBand = min(wantBandNow, roomAbove + shift)`；放不下时把 band 收到 `fitBand`，`bottom2 = bottom + shift` 再定位。返回值多 `shift` / `clipped`。
- 收起时 `band <= 0`：只有「之前为了放下长气泡让过位置」才还位（`near` 判定容差 12px），否则不动，避免老的「一高一缩」抖动。
- `assets/orb-app/pet.js`：`BUBBLE_COLUMN_MAX` 360→**400**、`BUBBLE_COLUMN_GROWTH_CHARS` 60→**30**、`BUBBLE_COLUMN_GROWTH_SPAN` 100→**80**（中文长句在 248px 会折 6~7 行，得早点放宽容器）；`fitBubble()` 记住 `res.shift`，`hideBubble()` 只在 `state.bubbleShift > 0` 时才申请复位。

**② 误拖的真因与修法**

- 日志实证：用户没拖的时候 `orb-app.log` 里也出现 `[pet] [layer] action 被鼠标拖拽悬空反馈 kind=drag`。全套代码里只有 `orb.js` 在 `petDrag.moved = true` 那一刻调 `SurfPet.drag()`，所以是 `petDrag` 被意外立起来了（点一下 / 按住看 / 手抖越过 6px 阈值都算）。
- `assets/orb-app/orb.js`：`mousedown` 严格判 `ev.button !== 0 || ev.buttons !== 1 || expanded` → return；`PET_DRAG_HOLD_MS` 180→**320**；`DRAG_MIN_PX` 6→**10**；新增 `PET_DRAG_IDLE_CANCEL_MS = 1200`（按住不动 1.2 秒即判「只是按住看」，撤销这次按下）；`endPetDrag(reason)` 每次都记日志（`mouseup` / `blur` / `pointercancel` / `mouseleave` / `hidden` / `Escape` / `held-still` / `button-up`），方便下次从日志判断到底哪条路径触发的。

**注意（踩过的坑）**

- `orb.js` 里没有 `log()` 函数（只有 `window.orb.log`），直接写 `log(...)` 会 `ReferenceError` 把渲染进程打断；三处都改成 `try { window.orb?.log?.(...) } catch {}`。
- `hideBubble()` 不能无条件 `bubbleSpace(0)`：窗口跟着气泡缩/长正是老「上下抖」的根因，只还「为了长气泡让出去的那一截」。
- 改动只在「她贴边」时才会触发让位；在屏幕中间弹出的气泡仍然原地向上长（原行为不变）。

**验证**：`node scripts/test-orb.mjs`（67 + 329 项，含「长气泡放不下整窗往下让」「收起要还位」「移动超过 10px 才算拖，且要按住 320ms」）、`node scripts/test-orb-window-state.mjs`（28 项）；真机看 `orb-app.log` 的 `[bubble] fit … shift=`、`[bubble] show`，以及拖不住时是否只出现 `[drag] arm` 而没有 `[drag] start`。

## 37. 鼠标靠近就把她带走：拖动状态残留的真因与四道保险（0.12.23 / 0.12.24）

**症状**：鼠标只要靠近（甚至没按）桌宠，她就被搬走；调了好几次阈值都没治好。

**真因（这次是坐实的，不是调参数）**：主进程有个 90ms 的「鼠标穿透」轮询（`startClickWatch`），它只看指针在不在身体矩形里，**不知道有人正在拖**。拖动时窗口跟着指针跑、指针很容易落到身体矩形外 → 轮询把窗口切成穿透 → **mouseup 被系统吃掉，送不到渲染进程** → `petDrag` 永远不清 → 之后任意一次 mousemove 都满足「按住 + 移动」的判定，她就跟着光标一路跑。

**四道保险（缺一条都能复现）**

1. **主进程钉住** `orb:drag(true/false)`（`main.js` 的 `dragPinned`）：拖的时候穿透轮询整轮跳过并保持 `setIgnoreMouseEvents(false)`；`DRAG_PIN_TTL_MS = 15000` 自愈，渲染端崩了也不会永远钉死。
2. **指针捕获** `petStage.setPointerCapture(ev.pointerId)`：窗口被她自己搬走、指针已经不在窗口上时，move / up 仍然送到渲染进程；`lostpointercapture` / `pointercancel` 都收尾。
3. **主进程硬闸**：`orb:move` 只在 `dragPinned` 且未超时时才搬窗口，否则返回 `{ok:false, reason:'not-dragging'}`。残留状态从此搬不动她。
4. **兜底**：拖动态 1.5 秒收不到任何移动事件（`stall`）直接作废；`mouseup` / `blur` / `pointercancel` / `mouseleave` / `hidden` / `Escape` 全路径都调 `endPetDrag(reason)` 并记日志。

**诊断**：现在每次真正写窗口都会记一行 `[win] <reason> {旧bounds} -> {新bounds}`（同一原因 1 秒内节流）。下次再出现「她自己跑了」，看日志里最后几条 `[win]` 就知道是 `self-heal` / `bubble-space` / `pet-move` / `move` 哪一个动的手。

**验证**：`node scripts/test-orb.mjs`（67 + 334 项）、`node scripts/test-orb-window-state.mjs`（28 项）；真机：鼠标划过 / 单击 / 双击 / 右键都不位移，按住左键 320ms 再拖才跟手。

## 38. 唤醒提示词注入方式可切换：card / trim / pointer（2026-11-07）

**为什么要有**：上游 v0.8.9 把唤醒侧的人格注入从「一句指针」改成「直接印整张人格卡正文」（`personaWakeBlockV2` → `roleHintForMode(..., { personaOnly: true })`）。主人 2026-11-07 实测同一轮唤醒 **7,553 字**，其中 `【人格核心】6,978 字` —— 一天几十上百条，就是十几万 token 的差。

**三档（`persona.wakeInject`）**

| 档位 | 含义 | 每条大致字数 |
| --- | --- | --- |
| `card`（默认） | 0.8.9 原样：印整卡正文，上限吃 `role.maxInjectChars`（默认 6000） | 7,553（实测） |
| `trim` | 0.8.9 的卡按 `persona.wakeTrimChars`（800~6000，默认 2500）截断 —— **折中档，旧版没有** | ~3,100 |
| `pointer` | 0.6.22 原样：`【当前角色】<名字>（完整角色卡请调用 qq_get_prompt 查看）` —— 与旧代码逐字一致 | ~575 |

**入口**：设置 → Sprintkey 扩展 → 「提示词注入」页签（`client.js` 的 `SPRINTKEY_PAGES` 里 id `prompt`）。页面上还并排放着「B站记忆简报」（每次约 4.3k 字，`biliBridge.memory.enabled`）和「人格注入上限」（`role.maxInjectChars`，只在 `card` 档生效），并实时显示三档字数与「换成指针每条省多少」。

**代码**：`src/persona-wake-inject.js`（纯组装，可单测；`pointerLine` / `wrapCardBlock` / 两个归一化函数）；`src/bridge.js` 的 `personaWakeSetting()`（每轮现读 `~/.dsh/surfcore/config.json` 的 `persona.*`）、`personaWakeBlockFor()`、`personaWakeBlockV2()`；只读预览接口 `GET /api/socialV2/persona-preview`（返回三档 chars/preview + 最近一次唤醒的 `{chars, roleChars, inject}`）；`store.js` 的 `DEFAULT_UNIFIED.persona.wakeInject/wakeTrimChars` 与 `saveUnified()` 归一化。

**注意（踩过的坑）**

- 配置写在 **unified**（`~/.dsh/surfcore/config.json` 的 `persona`），不在 QQ 配置里；设置页必须用 `setUnified(p("persona.wakeInject"))`，写成 `set(...)` 会读不到。
- `trim` 档走的是 `roleHintForMode(..., { maxChars })`，`composePersonaLayers` 的预算实测生效（6000→6002、2500→2502）。
- 改完**下一条唤醒**就生效（桥接每轮现读），但页面本身要重启一次 DSH 才会出现新页签。
- `scripts/test-persona-wake-injection.mjs` 用源码正则钉住旧形状，改 `buildWakePromptV2` 前先看它。
- 顺带修掉的旧 bug（m06338）：弹窗里 `select.qbw-select` 只有透明底、没补弹窗内底色，白底白字看不见 —— 现在 `.qbw-modal select.qbw-select` 与 `input` 同款补丁。

**验证**：`node scripts/test-prompt-inject-mode.mjs`（含用 `git show pre-sync-0.6.22-sprintkey:src/bridge.js` 取旧源码做逐字对照）、`node scripts/test-persona-wake-injection.mjs`、`node plugins/surfcore/scripts/test-client-contract.mjs`；真机：设置页切换三档后，`GET /api/socialV2/persona-preview` 的 `lastWake.chars` 应随之变化。

## 39. Sprintkey 设置页改成「卡片 → 点开专页」（2026-11-08）

**为什么要有**：Sprintkey 扩展原来 9 个页签把几十行参数平铺在页面里，一屏塞不下、也看不出重点。主人要求「参考 QQ 侧回复速度那种设计：每个大设置项点进去弹出专门界面改参数」。

**做法**：每个页签里只放一排卡片（`.qbw-cards` 网格），每张卡片 = 一个功能域（标题 + 一行摘要 + 说明），点开走 `SprintkeyArea` → `AreaModalCard` → `SettingsModal`（760px 宽、84vh 高、点遮罩关闭、底部「关闭」），里面才是真正的 `Row`/`Field` 控件。改完关掉弹层，回到页面底部点「保存」写入 `config.json`，与 QQ 侧完全一致（弹层里不做保存，避免半套状态）。

**改动面**：`plugins/surfcore/lib/client.js` 的 `SprintkeyTab` —— 9 个 `Section` 内各包一个 `h("div", { className: "qbw-cards" }, …)`，共 21 张卡片（模型/思考强度/思考范围、唤醒注入四张、记忆系统四张、声线四张、跨会话两张、世界树两张、工具投递两张、投递上限一张、投递接口一张）。复用既有 `SprintkeyArea`（原本已在文件里、但没人用）。

**顺带**：`GET /api/socialV2/persona-preview` 之前没进插件转发白名单，设置页显示「未放行的社交接口」—— 已在 `plugins/surfcore/lib/index.js` 的 `SOCIAL_V2_PROXY_GET` 里补上。

**验证**：`node plugins/surfcore/scripts/test-client-contract.mjs`（页签 id 数组 / `h(SubTabs, { tabs: SPRINTKEY_PAGES` / 每页 `hidden: activePage !== "<id>"` / `socialV2.crossMemory.enabled` 只出现一次）、`test-ui-contrast.mjs`；真机重启 DSH 后进「Sprintkey 扩展」逐页点卡片。

**顺手修的测试坑（重要）**：`scripts/test-pic-auto.mjs` 与 `scripts/test-pic-wiring.mjs` 里写死了默认安静时段 `01:00→07:00` 又用 `Date.now()` 当「现在」，**凌晨跑审计必然红**（凌晨 01:xx 实测红了 3 项，差点当成回归）。现在 `test-pic-auto` 用固定的下午三点时间戳、`test-pic-wiring` 的夹具把安静时段设成 `00:00→00:00`（`from==to` 即关闭）。以后写涉及时间窗的单测别用真实时钟。

## 新增功能时按这个格式补一条

1. 在总表加一行（功能 / 入口 / 代码 / 配置键）；
2. 下面加一节，写清「做什么 / 入口 / 接口或配置 / 注意（踩过的坑）/ 验证方法」；
3. 在 [`CHANGELOG.md`](../CHANGELOG.md) 顶部加对应条目，必要时在文档里记一条踩坑。
