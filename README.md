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

语音包 `voice-local` 的模型不在本仓库，也不随本仓库分发。首次安装时，插件会从上游
[`Mieksido/surfvoicelocal`](https://github.com/Mieksido/surfvoicelocal) 的 Release `v0.1.0`
下载原始模型资产（vendor / models / voicepack）。也就是说：**新用户拿到的是上游原始语音包，
不是本仓库作者机器上改过的音色或配置副本。**

---

## 许可

MIT，见 [LICENSE](LICENSE)。原始版权归 `Derpyu520 and qq-bridge / QSH contributors`；
本仓库的修改部分同样以 MIT 发布。SnowLuma 是第三方专有运行时，不随本仓库分发。
