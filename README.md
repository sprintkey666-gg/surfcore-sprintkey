# SurfCore · Sprintkey Edition

> **非官方修改版。** 本仓库来自 [Mieksido/surfcore](https://github.com/Mieksido/surfcore)（MIT），
> 在原项目基础上加入了下面这些功能；不是从零自制的项目。上游的作者与贡献者才是这个项目的主体。

一个跑在 Windows 上的 DSH（DeepSeek Harness）插件：让 agent 在 QQ 里当一个群友、在 B 站当一个用户，
带一套会衰减的记忆、一个可以主动找你的“目的”，以及一个桌面分身。

---

## 相对上游新增了什么

- **Sprintkey 设置分页**：设置 → SurfCore →「Sprintkey扩展插件」里，一个子设置一页（不再把 8 组折叠塞在一页）。
- **全量记忆卡备份**（设置 → SurfCore → 记忆 →「全量记忆卡备份（本地 + QQ）」）：
  - 本地镜像 + 增量同步，可自定义目录；
  - 按天定时，关机错过后下次启动补一次；
  - 可把全量卡私聊发给主人（只发 `config.json` 里的 `admin.qq` / `ownerQQ`，不发群）。
- **QQ 签名 / QQ 空间动态**（设置 → SurfCore → QQ →「QQ 签名 · 空间动态」）：
  - 四项模式：关闭 / 自动（AI 按「温度」决定）/ 每 1 天 / 每 3 天 / 每 7 天；
  - 动态可选可见范围（所有人 / 好友 / 仅自己）。
- **日记**（设置 → SurfCore →「日记」）：
  - 本地 Markdown，目录可自定义（带自绘目录选择器，能浏览所有盘符、可手输路径）；
  - 默认每 1 天写一篇，关机错过后下次启动补写；
  - 可选私聊发给主人，只发 `admin.qq` / `ownerQQ`，没有第二个收件人，也不会发群。

新功能默认全部关闭，保存后约 1 分钟生效（桥接每个 tick 重读 `config.json`），不需要重启桥接。
改动代码后仍需重启桥接进程。

## 最近更新（2026-11-01）

- **悬浮窗 0.12.0**：气泡自适应不再被裁切、已读不重弹、双击看图、QQ 近况互通。
- **发图**：图文同一条消息；支持文字气泡 + 原生 QQ 表情两条；QQ 表情按原生方式发送/收藏。
- **语音包 voice-local 1.1.1**：新用户首装即本 fork 的改版（含默认音色与 RVC），保留 `.venv-rvc` 不重下。
- **文档**：[更新日志](docs/CHANGELOG.md) · [功能清单（入口/代码/配置/验证）](docs/sprintkey/FEATURES.md)。

---

## 安装

环境：Windows 10/11、Node.js ≥ 22.13、可正常打开的 DSH、SnowLuma2（只收 QQ 才需要，第三方，自行下载并扫码）。

```powershell
git clone https://github.com/sprintkey666-gg/surfcore-sprintkey.git
cd surfcore-sprintkey
npm install
node scripts/setup-dsh.mjs
```

重启 DSH → 设置 → SurfCore → 诊断 → 一键安装。详细排错见上游 README 与 `docs/guides/INSTALL.md`
（本仓库不附带上游 `docs/`，请到上游仓库查看）。

> 必须从仓库根目录安装：插件里有大量 `../../../src/xxx.js` 的相对引用，只装 `plugins/surfcore` 会找不到模块。

---

## 数据与隐私

本仓库**不包含任何真实用户数据**：

- `config.json`（含 QQ 号、token、主人 QQ）、`state/`、`audio/`、`_backups/` 全部在 `.gitignore` 里；
- 角色卡只保留脱敏示例（`roles/傲娇助手.md`、`roles/小咪.md`），不含作者使用的人格卡；
- 截图、内部文档、测试用的个人路径与个人 QQ 已从公开树中移除或替换。

运行时的账号、记忆、日记、备份都只写在你自己的机器上。

### 关于“本地模型 1”

语音包 `voice-local` 的**代码**在本仓库的语音包仓库
[`sprintkey666-gg/surfvoicelocal-sprintkey`](https://github.com/sprintkey666-gg/surfvoicelocal-sprintkey)；
模型与 vendor（约 3GB）在该仓库的 Release `voice-local-v1.1.0`，首次安装时由插件下载。
源码取该仓库的 `main`（1.1.1 起音色定义 `voices/` 已入仓，装完即有默认音色）。

这个本地包是**改版**，不是上游原版：默认小鲸鱼音色 `da-fei-yu-gsv`，带 RVC 语音/唱歌转换
（Applio + `.venv-rvc`）。上游是
[`Mieksido/surfvoicelocal`](https://github.com/Mieksido/surfvoicelocal)（loli12 音色），本仓库的
修改部分与它同源。

模型权重（小鲸鱼 GPT-SoVITS / RVC）为 **CC BY-NC 4.0**（YinZilu / 尹紫鹭幻想社），
非商业、需署名；代码 MIT。详见语音包仓库的 `THIRD_PARTY_NOTICES.md`。

---

## 许可

MIT，见 [LICENSE](LICENSE)。原始版权归 `Derpyu520 and qq-bridge / QSH contributors`；
本仓库的修改部分同样以 MIT 发布。SnowLuma 是第三方专有运行时，不随本仓库分发。
