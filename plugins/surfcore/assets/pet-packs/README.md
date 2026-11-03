# 桌宠皮肤包目录

这里放 **可以随 SurfCore 一起分发** 的皮肤清单和素材。设置页「悬浮窗 → 外观」里的皮肤列表读的就是
同目录下的 `index.json`。

## 两种包

| kind | 是什么 | 目录里要有什么 |
| --- | --- | --- |
| `webm` | 一段段 VP9-alpha 动画，按 idle / clicks / drag / categories 随机播 | `webm/*.webm` + `manifest.json`（或 `config.jsonc`） |
| `figure` | 一个纯前端网页（`index.html`），宿主用 iframe 装着，可以自己画、自己动 | `index.html` + `pack.json`（`kind: "figure"`） |

`figure` 包只能用浏览器里能跑的东西（HTML/CSS/JS/SVG/Canvas），**不能有 Node API**
（`require` / `process` / `node:` 一律没有）。和宿主通信走 postMessage：

- 宿主 → 形象：`{type:'pet:action', name:'clicks'|'turn'|'drag'|'blink'}`、`{type:'pet:gaze', dx, dy}`
- 形象 → 宿主：`{type:'figure:ready', actions:[...]}`、`{type:'figure:action', name:'clicks'}`
- 入口文件发完 `figure:ready` 前，宿主会先当作没准备好；超时会回退到 webm 包。

## 内置清单里的三个包

| id | 来源 | 许可 | 分发方式 |
| --- | --- | --- | --- |
| `dsh-pet` | npm `dsh-pet@0.4.1` | MIT | 按需下载，不随仓库分发 |
| `sprintkey-fish` | SurfCore 自绘 | MIT | 随仓库入库（`bundled`） |
| `big-blue-fish` | [Bai-Cute/big-blue-fish-desktop-pet](https://github.com/Bai-Cute/big-blue-fish-desktop-pet) 的 `code/BigBlueFish.Windows/assets/fish/` | MIT，Copyright (c) 2026 PC2005-cloud | 按需从 GitHub 下载，只挑素材目录；许可落在 `LICENSES/big-blue-fish-LICENSE.txt` |

## 不收录的素材（许可红线）

下面这些**不放进仓库、也不打进任何安装包**，想要的话请用户自己准备文件夹，用设置页「导入文件夹」自行导入自用：

- **Coopanion** 及其鲸鱼素材：AGPL-3.0-or-later，和本项目分发方式不兼容。
- **dsh-pet-indesktop 的「深深 / 漉月」角色素材**：CC BY-NC-SA 类许可，仅限个人非商业使用。

这两类只适合自己本地玩；请不要提交 PR 把它们塞进来。

## pack.json 里可用的字段

```jsonc
{
  "id": "my-fish",            // 小写、只留字母数字 - _
  "name": "我的鱼",
  "version": "1.0.0",
  "kind": "webm",             // 有 index.html 时可以不写，会自动判成 figure
  "author": "",
  "license": "MIT",
  "webm": "webm",             // webm 子目录名，默认 webm
  "entry": "index.html",      // figure 入口，默认 index.html
  "tints": [                  // 可选：这个包自带的配色，不写就用内置六套
    { "id": "", "name": "原色", "filter": "none" }
  ]
}
```

`tints[].filter` 会原样作为 CSS `filter` 套在桌宠图层上，只允许
`hue-rotate()` / `saturate()` / `brightness()` / `contrast()` / `sepia()` 这类滤镜函数。
