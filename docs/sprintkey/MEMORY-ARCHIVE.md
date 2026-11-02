# 聊天全量存档（MEMORY-ARCHIVE）

> 分支：sprintkey ｜ 首次实现：2026-11-01 ｜ 对应版本：0.12.15 之后
> 目标：记忆卡有上限、会长大后压缩；聊天原文另存一份，**不压缩、不删除、私聊/群聊分开**，并跟着全量卡备份一起落盘/发 QQ。

## 1. 它和「全量记忆卡」的区别

| | 全量记忆卡 | 聊天全量存档 |
| --- | --- | --- |
| 内容 | `memory-card-full.jsonl`，衰减卡/摘要的镜像，单条压到 130/200/260 字 | 每条聊天原文 + 元数据 |
| 上限 | 受记忆卡容量管理，会整理/压缩 | 不压缩；单文件满 `maxFileMB` 自动换新文件 |
| 文件 | 备份根下 3 份（jsonl/md/stats） | 备份根下 `chat/<角色ID>/{private,group}/*.jsonl` |
| 开关 | `memoryCardBackup.enabled` | `memoryCardBackup.archive.enabled`（默认开） |

两者独立：关掉全量卡镜像，聊天存档仍可继续写；关掉聊天存档，全量卡镜像照旧。

## 2. 目录与文件命名

```
<备份根>\
  memory-card-full.jsonl
  memory-card-full.md
  memory-card-full-stats.json
  chat\
    <角色ID>\
      private\
        2026-11-01_0001.jsonl
        2026-11-01_0002.jsonl   # 0001 写满 maxFileMB 后新建
      group\
        2026-11-01_0001.jsonl
```

- 备份根 = `socialV2.memoryCardBackup.dir`；留空用 `defaultBackupDir()`（`~/.dsh/surfcore/memory-backups/<角色ID>`）。
- `角色ID` 经 `safeCharacterId()` 处理：非法字符替换、去首尾点/空白，避免 Windows 非法文件名。
- 日期取本地时区 `YYYY-MM-DD`；序号 4 位，从 `0001` 递增；同一天跨文件按大小滚动。
- 私聊和群聊**物理分目录**，不挤在一个文件。

## 3. 每条记录的字段（JSONL，一行一条）

```json
{
  "schema": 2,
  "id": "1793529000000-ab12cd",
  "at": 1793529000000,
  "time": "2026-11-01T22:30:00+08:00",
  "platform": "qq",
  "channel": "qq",
  "kind": "private",
  "conversation": { "key": "private:123456", "id": "123456", "name": "主人" },
  "sender": { "id": "123456", "name": "主人", "isOwner": true, "isSelf": false },
  "messageId": "987654321",
  "type": "text",
  "types": ["text"],
  "text": "原文，不截断",
  "reply": { "messageId": "111", "senderId": "222", "text": "被引用的话" },
  "media": [{ "kind": "image", "file": "xxxx.image", "url": "", "name": "" }]
}
```

- `channel`：`qq | desktop-orb | companion`，区分 QQ、桌宠/悬浮球、陪伴字幕；旧记录没有该字段时按 `qq` 理解。
- `type`：`text | image | sticker | face | voice | video | file | forward | card | mixed`；`types` 保留原始段类型全集。
- `media` 只存元数据（`kind/file/url/name`），不存二进制；语音转写文本若有会并入 `text`。
- `text` 单条上限 20000 字符（防御性截断），普通聊天不会触发。
- `sender.isOwner` = 主人；`sender.isSelf` = 机器人自己发出的消息。
- 同一 `messageId` 在内存里去重（最近 5000 条），防止适配器重复投递。

## 4. 写入点

### 入站

`src/bridge.js` 的 `handleIncoming()`：

1. 先过 `isSessionAllowedInCurrentMode(key)`（黑名单/模式不允许直接 return，不入库）。
2. 在空文本 return 之前调用 `chatArchive.appendIncoming({...})`，带上 `event.message`、`plainContent`、`textContent`、`isOwner`、`quoteTargetIsSelf`、`mediaList`。
3. 斜杠命令（`/` 开头）由 writer 跳过，不把命令当聊天记账。

### 出站

- `sendMessagesV2()` 成功后的 `sent` 数组，按气泡逐条 `appendOutgoing({ key, kind, text, at })`。
- `auditAndSend()` 发送成功后也 append（只认 `lastSendSucceeded`）。
- 不在 `sendToQQ()` 统一采，避免系统提示、命令回执、内部告警混进聊天存档。

### 桌宠 / 悬浮球 / 陪伴字幕

- `plugins/surfcore/lib/desktop-archive.js` 复用 `chat-archive` 的写入器，`channel` 分别是 `desktop-orb` / `companion`，`kind` 固定 `private`；不会伪造 QQ 号，`conversation.id` 用角色 ID。
- `pet-chat.chat()` 成功一轮后写「主人一句 + 她一句」；`orb.addMessage()` 只补主动/系统气泡（普通回复由 pet-chat 写，避免重复）；`orb-companion.publish()/append()` 每条字幕都回调存档。
- 陪伴模式内部调 `pet-chat.chat()` 时传 `archive:false`，避免把内部提示词当用户聊天写进去；字幕自己再写原始的一问一答。
- 桌宠/字幕的记录同样进 `private/*.jsonl`，用 `channel` 区分；发送/滚动/去重与 QQ 完全共用。

## 5. 滚动、去重、失败策略

- **滚动**：写前 `stat` 当前文件 + 本条字节 > `maxFileMB` → 关闭当前流、序号 +1 新建；单条本身超过上限也单独成文件，不拆记录。
- **只追加**：`appendFile`，从不重写；不压缩、不删旧文件；文件损坏时返回错误、不影响聊天主流程。
- **去重**：`messageId` 最近 5000 条 Set；重启后清空（跨重启重复投递概率低，接受）。
- **失败**：`appendIncoming/appendOutgoing` 返回 `{ok:false,error}`，不抛异常；桥接不会因为存档失败而断消息。
- **关闭**：`archive.enabled=false` 时直接 `{ok:true,skipped:'disabled'}`，不写文件。

## 6. 备份与 QQ 发送

`src/memory-backup.js`：

- `runBackup()` 仍只镜像全量卡三件，行为不变。
- `runSend()`：
  1. 收集全量卡三件（存在才发）。
  2. `archiveSnapshot()` 扫 `chat/<角色ID>/{private,group}`；按 `send.fullArchive` 选模式：
     - **开（默认，全发）**：带全部存档，不按 `archiveSent` 过滤、不套 20 个上限。
     - **关（增量）**：只取「文件字节数 > `archiveSent[路径]`」的文件，最多 20 个/次。
  3. 文本头写发送模式、全量卡大小、存档文件数/字节。
  4. 逐个 `pushFile`；单文件 > `send.maxSendMB` 跳过并记 `skipped`，不再整单拒绝。
  5. 成功后把本次实际附加的 `path → bytes` 写进 `archiveSent`（最多 500 条，超出淘汰最旧），落 `memory-card-backup.json`。
     - 全发时也写，所以从全发切回增量不会把旧文件再重发；从增量切到全发则立即全发。
- `runSend()` 不再强制要求 `memory-card-full.jsonl` 存在——只有存档也能发。
- 增量模式下文件追加后字节数变大，下次会**整份重发**该文件；没变的不重发。全发模式每次都带全部。
- 发送只认 `config.json` 的 `admin.qq / ownerQQ`，私聊主人，不发群。

## 7. 设置页

`plugins/surfcore/lib/client.js` → SurfCore → Sprintkey扩展插件 → 记忆：

- 标题：「全量记忆卡 + 聊天存档（本地 + QQ）」。
- 保留：启用备份、备份目录、同步间隔、发送到主人 QQ、发送间隔、单次发送上限。
- 新增：
  - 「每次发送全部记忆文件」（`send.fullArchive`，默认开）：开 = 全发；关 = 只发新增/追加。
  - 「启用聊天全量存档」（`archive.enabled`，默认开）。
  - 「聊天单文件上限（MB）」（`archive.maxFileMB`，1–512，默认 16）。
- 状态行：私聊文件数（含桌宠/字幕）/ 群聊文件数 / 总字节 / 单文件上限 / 发送模式；下方仍显示上次备份、上次发送、QQ 在线状态、备份目录。
- 保存后 5 秒内生效（`liveMemoryBackupConfig()` 按 mtime 缓存），不需要重启桥接；发送/备份动作会重新读配置。

## 8. API

不新增路由，复用：

- `GET /api/socialV2/memory-card-backup` → `{ ok, dir, qqReady, state, archive }`
- `POST /api/socialV2/memory-card-backup` body `{ action: "backup" | "send" | "refresh" }`

`archive` 形状：

```json
{
  "enabled": true,
  "dir": "E:\\记忆\\chat\\char-xxx",
  "maxFileMB": 16,
  "private": { "files": 12, "bytes": 3456789, "current": "2026-11-01_0002.jsonl" },
  "group":   { "files": 30, "bytes": 9876543, "current": "2026-11-01_0001.jsonl" },
  "totalBytes": 13333332,
  "lastError": ""
}
```

## 9. 测试与验收

自动：

```powershell
cd <仓库路径>
node scripts/test-chat-archive.mjs        # 10 项（含 schema2/桌宠字幕 channel）
node scripts/test-memory-backup.mjs       # 15 项
node --check src/chat-archive.js src/memory-backup.js src/bridge.js plugins/surfcore/lib/client.js plugins/surfcore/lib/desktop-archive.js plugins/surfcore/lib/pet-chat.js plugins/surfcore/lib/orb.js plugins/surfcore/lib/orb-companion.js
```

手工：

1. 给机器人发一条私聊、在群里发一条普通消息（不要 `/` 命令）。
2. 看 `备份根\chat\<角色ID>\private|group\2026-11-01_0001.jsonl` 是否各多一行；字段含 `time/kind/conversation/sender/type/text`。
3. 把单文件上限调到 1 MB，再发一大段文字，确认新建 `_0002.jsonl`，旧文件不被改。
4. 设置页打开「每次发送全部记忆文件」，点「立即发送」，主人 QQ 收到文本头 + 全量卡 + 全部存档；再点一次仍收到全部。关掉开关再点，未变化的存档不重发。
5. 关掉「启用聊天全量存档」，再发消息，确认不再新增文件；全量卡镜像仍可单独工作。
6. 桌宠/悬浮球发一句、陪伴字幕回一句，确认 private 文件里出现 `channel:"desktop-orb"` / `channel:"companion"`，且 `type` 为 `text` 或 `mixed`。

## 10. 踩坑记录

- 不能拿 `memory-card-full.jsonl` 当聊天原文：它经过 `recordLine()` 压缩（130/200/260 字），细节已经丢了；`archiveDecayedToFull()` 写的是衰减摘要。
- 不能拿 `memory-inbox.jsonl` 当全量：它只收主人消息/直接对她说/有情绪群消息，短私聊和普通群聊会被过滤。
- 出站不要在 `sendToQQ()` 统一采：系统提示、命令回执、审批消息会混进去；只采 `sendMessagesV2` 的 `sent` 和 `auditAndSend` 成功后的真实气泡。
- 发送不能“有一个文件超限就整单失败”：旧实现会让整次发送失败；现在单文件跳过 + `skipped`，其余照发。
- `archiveSent` 只记“已发送的字节数”，文件追加后整份重发；不要按 mtime 判断，否则改系统时间/复制文件会漏发。
- `archiveSent` 只用于增量模式；全发模式不要拿它过滤，但全发后仍要更新它，否则切回增量会重发旧档。
- 备份目录和源目录相同要拒绝（沿用 `sameDir()`），否则会自己复制自己。
- PowerShell 5 的 `Set-Content` 默认写 UTF-16/ANSI，中文会坏；改文件用 Node `fs.writeFileSync(..., 'utf8')` 或本工具。
- 陪伴模式内部调 `pet-chat.chat()` 会带一大段提示词；必须传 `archive:false`，否则用户看到的字幕原文会被内部 prompt 覆盖/重复。
- 桌宠普通回复由 `pet-chat` 写、主动气泡由 `orb.addMessage` 写；两边都写会一条消息出现两次，用 `id` 去重并只让 addMessage 采 proactive/system。
