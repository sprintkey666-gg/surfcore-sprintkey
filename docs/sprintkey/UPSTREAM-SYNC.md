# 上游同步：v0.6.22-sprintkey → v0.8.9-sprintkey

> 本分支（`sprintkey/main`）是 Mieksido/surfcore 的改版。上游在 2026-10~11 发了 34 个 release（v0.7.0 … v0.8.9），
> 本文记录这次「增量兼容同步」怎么做的、每个撞车点怎么裁决、哪些上游功能被我们保留/取代。

## 0. 一句话结论

- 先把本分支**行尾统一为 LF**（提交 `9d2f7ab`），否则上游自 v0.7.12 起的 LF 会让每个重叠文件变成整文件冲突。
- 再一次 `git merge origin/main`（`0ce8580` = `v0.8.9`）解决 **26 个冲突路径**（提交 `584f519`），然后修合并后暴露的 16 个失败用例（`168af84`）。
- 结果：`node scripts/test-audit.mjs` **173/173 全绿**（同步前基线是 93/97、4 个既有红项）；插件链 40/42，红项仍是既有的 `test-updates` / `test-host-smoke`。

## 1. 为什么一次性 merge，而不是逐个 release 合

34 个 release 里 v0.8.7（219 文件）、v0.8.9（160 文件）都是大改，且反复改同一批文件（`src/bridge.js` 上游 +2995/−254、`plugins/surfcore/lib/client.js` +3758/−356）。
逐个 release 合会在同一区域反复撞车、且中间态永远不可运行；一次性合把冲突集中到 26 个路径，每个路径只需做一次「上游为基 + 回植本分支」的裁决。

## 2. 冲突处理总则

| 类别 | 文件 | 处理 |
| --- | --- | --- |
| A 文档/锁文件 | `README.md`、`docs/HANDOFF.md`、`docs/PITFALLS.md`、`docs/VOICE-PACKS.md`、`package-lock.json`、`.gitignore`、`docs/guides/*` | 文档取上游正文 + 把本分支历史快照整块搬到文末；锁文件取上游；`docs/guides/` 保持删除（本分支早已归档到 `docs/sprintkey/`） |
| B 上游大改、我们小改 | `plugins/surfcore/lib/{index,pet-chat}.js`、`src/admin-identity.js`、`plugins/surfcore/{qq-tool-restrict.mjs,presets/*,scripts/*}`、`scripts/*` | 取上游为基础，逐 hunk 回植本分支的那几处 |
| C 双方都大改 | `src/bridge.js`（31 块）、`plugins/surfcore/lib/client.js`（12 块）、`src/{memory-card,voice-packs}.js` | 上游为基 + 按功能块回植，每块跑测试 |

## 3. 语义决策表（撞车点怎么裁）

1. **回复速度 ↔ 会话滚动**：`socialV2.reply.mode`（legacy/fast）与上游 `socialV2.context.rollover.*` **并存**。
   - 轮数（`reply.sessionRotate.everyTurns`）仍是我们决定「何时换会话」的入口；上游 `src/session-rollover.js` 做唯一执行器；
   - token 阈值（上游，看**当前上下文**而不是累计账单）作为额外触发；两套配置键都保留，`shouldRollSession()` 同时看轮数与 token。
2. **等待 / 沉睡前观察**：以上游 `preSleepWait` + `wake-batch` / `wake-filter` 为基座，回植我们的两条修复：
   - 「等待开始时就已经躺在 unread 里的积压」不算观察期间新消息（`backlogArrival`）；
   - 「基线取模型已看水位」而不是固定 unread 水位。
3. **记忆**：以上游 `sectionize()` / `normalizeMemorySharing()` 为基座，把我们的 `recentImportant` 段（「最近很要紧的」，按 importance→createdAt 排序）与 `channel` 数据类型重挂上去；
   `interop`（互通 QQ/B站）原样保留，仍由插件侧 `lib/interop.js` 组装。
4. **语音包**：以上游 `src/voice-packs.js` 为基座，只回植我们的 manifest 常量与来源（`voice-local` 指向 `sprintkey666-gg/surfvoicelocal-sprintkey`、`voice-feiyu` 的 `voiceDir` 自动探测音色）；
   测试 `test-voice-packs-default` 放宽为「声明音色 **或** `voiceDir`」。
5. **orb 全家**（桌宠 / 字幕 / 悬浮窗面板 / 记忆互通 / 回复速度 / 好友申请 / 自动发图 / 互动监测）全量保留：上游没有 `plugins/surfcore/assets/`，`lib/{orb,pet-*,interop,orb-agent}.js` 都是本分支独占。
6. **MCP 自愈 ↔ 上游 compat**：我们的 `src/mcp-patch.js`（桥接启动时自检三条 MCP 条目）与上游 `lib/{compat,compat-rules}.js` 互补；上游体检报「缺 MCP」时，我们的自愈仍是实际修复者。
7. **QQ 预设**：以本分支 prompt 为基（保留「你有完整本地能力、可执行命令」安全规则），补上游 `qq_get_context_snapshot` 的用法；`node scripts/build-agent-preset-patches.mjs` 重新生成 patch。
8. **模型/强度**：保留本分支「会话自定义 > 跟随 DSH 默认 > 配置写死」，与上游 `followDefaultModel` / `session.selectModel` 合流；新增 `vision.imageInput`（模型目录里没声明 image 的第三方模型默认走文字兜底）。
9. **唤醒提示词里的人格卡**：上游 v0.8.9 把「一句指针」改成「整卡正文」（`personaWakeBlockV2`），每条唤醒实测多 4~5k tokens；
   本分支加 `persona.wakeInject` 三档 —— `card`（默认，= 上游原样）/ `trim`（同卡按 `persona.wakeTrimChars` 截断）/ `pointer`（= 0.6.22 原样一句指针），
   组装逻辑抽到 `src/persona-wake-inject.js`，桥接每轮现读配置（改完即生效）。**默认值仍是上游行为**，只在主人主动切换时才省钱。

## 4. 34 个 release 的核对（上游功能是否真的落地）

按上游 `CHANGELOG.md` 逐项抽查（`node scripts/test-audit.mjs` 173 项覆盖大部分）：

| 上游能力 | 落点 | 验证 |
| --- | --- | --- |
| 向量记忆（本地 runtime + bge-small/qwen3/bge-m3）+ 四家云端 embedding | `src/vector-memory.js`、`lib/embedding-packs.js`、`plugins/surfcore/lib/vector-memory.js` | `test-vector-memory`、`test-embedding-packs`（审计内） |
| 会话滚动（默认关 + 20/50/80 万预设） | `src/session-rollover.js` + `bridge.js` shouldRollSession | `test-session-rollover`（196 项） |
| wake-batch / wake-filter | `src/wake-batch.js`、`src/wake-filter.js` | `test-wake-batch`、`test-wake-filter` |
| 人格分层 / 身份 | `src/persona-layers.js`、`src/persona-identity.js` | `test-persona-layers`、`test-persona-wake-injection` |
| 上下文快照 / 计费 / 健康检查 | `src/{context-snapshot,context-telemetry,billing-report,dsh-health}.js` | `test-context-snapshot`、`test-billing`、`test-dsh-health` |
| SnowLuma 安装/explorer、一键启动隐藏黑框、更新 ABA 防护 | `lib/snowluma-install.js`、`scripts/apply-update.mjs` | `test-snowluma-install`、`test-update-*` |
| 安全文本（孤立代理项）/ qq-at / 命令刷屏 / 白名单 | `src/safe-text.js`、`src/qq-at.js`、`src/command-spam.js`、`src/allowlist.js` | `test-safe-text`、`test-allowlist` |

## 5. 本分支被取代 / 保持的实现

- 被上游取代：`docs/guides/` 整套（归档到 `docs/sprintkey/`）、旧的等待实现（换成上游 wait 循环 + 我们的两条修复）、旧的模型选择日志格式。
- 保持独占：`plugins/surfcore/assets/orb-app/**`（桌宠渲染端）、`lib/{orb,pet-assets,pet-packs,pet-gaze,orb-activity,orb-agent,interop,desktop-archive}.js`、`src/{memory-backup,chat-archive,self-expression,diary,voice-tts,sing-notes,mcp-patch}.js`、`docs/sprintkey/**`。

## 6. 回滚

```bash
git reset --hard pre-sync-0.6.22-sprintkey   # 回到同步前的 sprintkey/main（490b627）
```

运行态备份在 `%TEMP%\surfcore-state-backup-20261107\`（`config.json` + `characters` + `orb`）。
