// SnowLuma 网关状态查询 MCP server（stdio）。
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-snowluma-host 行）。
//
// 工具：
//   snowluma_status   —— 检查网关是否在线（只读：HTTP get_login_info）与账号信息
//
// ── 为什么这里**没有**启停 SnowLuma 的工具（2026-09-20 移除，不要加回来）────────────
//
// 曾经有 `start_snowluma` / `stop_snowluma`（`spawn launcher.bat` / `taskkill`），默认关闭、
// 需要 `snowluma.allowProcessControl: true` 才注册。它们被移除，理由不是"危险"，而是**许可**：
//
//   SnowLuma EULA §5.4（中文为准）：「除事先取得著作权人的书面授权外，您仅可为 LICENSE 允许的
//   非商业用途，以专有组件随本软件提供的形式运行该组件；不得复制、修改、单独再分发或再许可该组件。
//   **将其并入第三方安装包或 Docker 镜像、通过自动化脚本部署**，或者将其用于任何商业用途，
//   均须事先取得书面授权。」
//
// 原生组件是**专有组件**；由本程序**程序化启动/结束**它，落在"通过自动化脚本部署"的射程内。
// 即便是"用户已装好、我们帮忙拉起"，也不值得为这点便利去踩一条需要书面授权的条款。
//
// 设计不变量 L6（见规划集 QSH_PLAN.md §6.0）：**QSH 只探测、不部署**——
// 永不安装、复制、打包或自动部署 SnowLuma 及其原生组件，也不程序化启停其进程。
// 用户在 QQ 侧不可用时得到的应该是**可操作的提示**（"请自行启动 SnowLuma"），而不是被代劳。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getConfig() {
  return loadConfig();
}

function getHostConfig() {
  const c = getConfig();
  const httpUrl = (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const homeDir = c.snowluma?.homeDir ?? (c.snowluma?.launcherPath ? path.dirname(c.snowluma.launcherPath) : '');
  return { httpUrl, homeDir, token: c.snowluma?.accessToken ?? '' };
}

async function gatewayInfo() {
  const { httpUrl, token } = getHostConfig();
  try {
    const res = await fetch(`${httpUrl}/get_login_info`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请改为 OneBot HTTP API 地址）' : '';
      return { reachable: false, httpStatus: res.status, ...(hint ? { hint } : {}) };
    }
    const body = await res.json();
    if (body?.status === 'ok' && body?.retcode === 0) {
      return { reachable: true, online: true, user_id: body.data?.user_id, nickname: body.data?.nickname };
    }
    return { reachable: true, online: false, retcode: body?.retcode, wording: body?.wording };
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) };
  }
}

const server = new McpServer({ name: 'snowluma-host', version: '0.2.0-r4' });

server.tool(
  'snowluma_status',
  '检查 SnowLuma OneBot 网关是否在线（只读探活 get_login_info）。返回网关可达性、QQ 在线状态与账号信息。网关不可达时返回可操作的提示（本程序不会代你启动 SnowLuma）。',
  {},
  async () => {
    const hc = getHostConfig();
    const info = await gatewayInfo();
    // 只读工具：不再暴露本机路径/PID（那需要进程控制能力，而该能力已被移除）。
    const payload = { ...info };
    if (info.reachable === false) {
      payload.hint = 'SnowLuma 网关不可达。请自行启动 SnowLuma（本程序不代装、不代启，原因见项目文档的合规说明 L6）。'
        + (hc.homeDir ? '' : ' 若 config.json 的 snowluma.httpUrl 与实际端口不一致，也请一并检查。');
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
);

// ── 悬浮窗（Orb）三个工具 ────────────────────────────────────────────────────
//
// 走插件自己的本地通道 `/dsh-surfcore/orb-api`（回环 + x-orb-token），不从 DSH 的
// `/dsh-surfcore/api` 绕：那条路要 DSH 会话 Cookie，MCP 进程没有。
// 发现文件由插件写：~/.dsh/surfcore/orb/host.json = {baseUrl, token, api, ...}。
function orbHost() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const file = path.join(home, '.dsh', 'surfcore', 'orb', 'host.json');
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const json = JSON.parse(text);
    if (!json?.baseUrl || !json?.token) return null;
    return {
      baseUrl: String(json.baseUrl).replace(/\/+$/, ''),
      token: String(json.token),
      api: String(json.api || '/dsh-surfcore/orb-api'),
      file,
    };
  } catch {
    return null;
  }
}

async function orbCall(method, apiPath, body, timeoutMs = 20000) {
  const host = orbHost();
  if (!host) {
    return {
      ok: false,
      error: '悬浮窗还没装/没启动（找不到 ~/.dsh/surfcore/orb/host.json）。先在 设置 → SurfCore → 悬浮窗 里安装并启动。',
    };
  }
  try {
    const res = await fetch(`${host.baseUrl}${host.api}${apiPath}`, {
      method,
      headers: {
        'x-orb-token': host.token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) {
      return { ok: false, status: res.status, error: json?.error || text.slice(0, 300) };
    }
    return json ?? { ok: true, raw: text.slice(0, 400) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

server.tool(
  'orb_say',
  '往桌面悬浮球里发一句话（她会「主动」冒出来说，不需要用户先开口）。适合想到什么想跟主人说、或者想提醒他喝水休息时用。一条一两句，别长篇。',
  {
    text: { type: 'string', describe: '要说的话，一两句，口语' },
    kind: { type: 'string', describe: '可选：proactive（主动搭话，默认）或 reply' },
  },
  async ({ text, kind }) => {
    const say = String(text ?? '').trim();
    if (!say) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'text 不能为空' }) }] };
    const result = await orbCall('POST', '/say', { text: say.slice(0, 600), kind: kind === 'reply' ? 'reply' : 'proactive' });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'orb_look',
  '看一眼主人的电脑现在在干什么：拿当前活动窗口标题、可见窗口列表，并在主人允许时截一张屏（返回截图绝对路径，可以再 read_image 看）。主人没开「让她看见屏幕」会直接拒绝。',
  {
    reason: { type: 'string', describe: '可选：为什么想看（写给自己看，会记下来）' },
  },
  async ({ reason }) => {
    const result = await orbCall('POST', '/look', { reason: String(reason ?? '').slice(0, 120) || '想看看主人在干嘛' }, 30000);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'orb_state',
  '悬浮球当前状态（只读）：装没装、跑没跑、最近几条消息、角色名、能不能看屏幕。',
  {},
  async () => {
    const result = await orbCall('GET', '/state', null, 10000);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

await server.connect(new StdioServerTransport());
