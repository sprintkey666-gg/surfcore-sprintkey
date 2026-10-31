/**
 * 扩展接口（给后续功能用：杀戮尖塔启动器、B站自主直播、更多平台……）。
 *
 * 设计目标：新功能不需要改合体插件的主流程。
 *   · 扩展包放 extensions/<id>/，带 manifest.json + entry；
 *   · 默认 **disabled**，必须在设置窗口里显式打开（代码执行权不能默认给）；
 *   · 扩展拿到一个受控 API：配置、路径、平台适配器、身份对齐、记忆、桥接控制、
 *     B站工具链、事件总线、自己的 HTTP 路由；
 *   · 平台（贴吧）不是硬编码：扩展可以用 api.registerPlatform(adapter) 接入，
 *     主流程的身份对齐/记忆同步/设置窗口会自动看到它。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  BILI_AI_DIR, BILI_ALIGNMENT_FILE, BILI_CONFIG, BILI_CRED, BILI_MJS,
  EXTENSIONS_DIR, PLUGIN_ROOT, QQBOT_ROOT, QQ_ALIGNMENT_BRIEF, QQ_CONFIG,
  STATE_DIR, findNodeExe,
} from './paths.js';
import { EXT_STATE_FILE } from './paths.js';
import { backupFile, readJson, writeJsonAtomic } from './store.js';

const MANIFEST_FILE = 'manifest.json';

function normalizeManifest(raw, dirName) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? dirName).trim();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(id)) return null;
  return {
    id,
    name: String(raw.name ?? id).slice(0, 60),
    version: String(raw.version ?? '0.0.0').slice(0, 20),
    description: String(raw.description ?? '').slice(0, 300),
    entry: String(raw.entry ?? 'index.js'),
    enabled: raw.enabled === true,
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map(String).slice(0, 20) : [],
    platforms: Array.isArray(raw.platforms) ? raw.platforms.map(String).slice(0, 10) : [],
    requiresRestart: raw.requiresRestart === true,
    author: String(raw.author ?? '').slice(0, 60),
    dir: path.join(EXTENSIONS_DIR, dirName),
  };
}

export class ExtensionHost {
  constructor({ platforms, memory, align, bridge, log = () => {} } = {}) {
    this.platforms = platforms;
    this.memory = memory;
    this.align = align;
    this.bridge = bridge;
    this.log = log;
    this.active = new Map(); // id -> { manifest, disposers, routes, module }
    this.listeners = new Map();
    this.state = this.readState();
  }

  readState() {
    const raw = readJson(EXT_STATE_FILE, {}) ?? {};
    return {
      enabled: raw.enabled && typeof raw.enabled === 'object' ? raw.enabled : {},
      config: raw.config && typeof raw.config === 'object' ? raw.config : {},
    };
  }

  writeState() {
    backupFile(EXT_STATE_FILE, 'extensions');
    writeJsonAtomic(EXT_STATE_FILE, this.state);
  }

  discover() {
    let entries = [];
    try { entries = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true }); } catch { return []; }
    const manifests = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(EXTENSIONS_DIR, entry.name, MANIFEST_FILE), 'utf8'));
        const manifest = normalizeManifest(raw, entry.name);
        if (manifest) manifests.push(manifest);
      } catch {}
    }
    return manifests.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  isEnabled(id) {
    const manifest = this.discover().find((item) => item.id === id);
    if (!manifest) return false;
    return this.state.enabled[id] === true || (this.state.enabled[id] === undefined && manifest.enabled === true);
  }

  setEnabled(id, enabled) {
    const manifest = this.discover().find((item) => item.id === id);
    if (!manifest) throw new Error(`扩展不存在：${id}`);
    this.state.enabled[id] = Boolean(enabled);
    this.writeState();
    if (this.state.enabled[id]) return this.activate(id);
    return this.deactivate(id);
  }

  getConfig(id) {
    return this.state.config[id] ?? {};
  }

  setConfig(id, config) {
    this.state.config[id] = config && typeof config === 'object' ? config : {};
    this.writeState();
    return this.state.config[id];
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) ?? []) {
      try { handler(payload); } catch (error) { this.log(`[ext] 事件 ${event} 处理失败：${error?.message ?? error}`); }
    }
    for (const { manifest } of this.active.values()) {
      const module = this.active.get(manifest.id)?.module;
      const fn = module?.onEvent;
      if (typeof fn === 'function') {
        try { fn(event, payload); } catch (error) { this.log(`[ext:${manifest.id}] 事件 ${event} 失败：${error?.message ?? error}`); }
      }
    }
  }

  async activate(id) {
    if (this.active.has(id)) return { ok: true, already: true };
    const manifest = this.discover().find((item) => item.id === id);
    if (!manifest) throw new Error(`扩展不存在：${id}`);
    if (!this.isEnabled(id)) return { ok: false, error: '扩展没有启用' };
    const entry = path.join(manifest.dir, manifest.entry);
    if (!fs.existsSync(entry)) return { ok: false, error: `找不到入口：${entry}` };
    let mod;
    try {
      mod = await import(`${pathToFileURL(entry).href}?v=${crypto.randomUUID()}`);
    } catch (error) {
      return { ok: false, error: `加载失败：${error?.message ?? error}` };
    }
    const disposers = [];
    const routes = [];
    const api = this.createApi(manifest, disposers, routes);
    try {
      const activateFn = mod.activate ?? mod.default?.activate ?? mod.default;
      if (typeof activateFn !== 'function') throw new Error('入口没有导出 activate(api)');
      await activateFn(api);
    } catch (error) {
      for (const dispose of disposers.reverse()) { try { dispose?.(); } catch {} }
      return { ok: false, error: `激活失败：${error?.message ?? error}` };
    }
    this.active.set(id, { manifest, disposers, routes, module: mod, api });
    this.log(`[ext] 已启用 ${manifest.name}（${id}）`);
    this.emit('extension.activated', { id });
    return { ok: true, manifest, routes: routes.map((route) => `${route.method} ${route.path}`) };
  }

  async deactivate(id) {
    const record = this.active.get(id);
    if (!record) return { ok: true, already: true };
    for (const dispose of record.disposers.reverse()) { try { dispose?.(); } catch {} }
    this.active.delete(id);
    this.log(`[ext] 已停用 ${id}`);
    this.emit('extension.deactivated', { id });
    return { ok: true };
  }

  createApi(manifest, disposers, routes) {
    const dataDir = path.join(STATE_DIR, 'extensions', manifest.id);
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
    const api = {
      id: manifest.id,
      manifest,
      dataDir,
      log: (...args) => this.log(`[ext:${manifest.id}]`, ...args),
      paths: {
        pluginRoot: PLUGIN_ROOT,
        qqbotRoot: QQBOT_ROOT,
        dshState: STATE_DIR,
        qqConfig: QQ_CONFIG,
        biliConfig: BILI_CONFIG,
        biliCred: BILI_CRED,
        biliDir: BILI_AI_DIR,
        biliMcp: BILI_MJS,
        qqAlignmentBrief: QQ_ALIGNMENT_BRIEF,
        biliAlignmentBrief: BILI_ALIGNMENT_FILE,
      },
      config: {
        get: () => this.getConfig(manifest.id),
        set: (value) => this.setConfig(manifest.id, value),
      },
      platforms: this.platforms,
      registerPlatform: (adapter) => {
        const dispose = this.platforms.register(adapter, `extension:${manifest.id}`);
        disposers.push(dispose);
        return dispose;
      },
      registerRoute: (method, routePath, handler) => {
        const normalizedMethod = String(method ?? 'GET').toUpperCase();
        const normalizedPath = `/${String(routePath ?? '').replace(/^\/+/, '')}`;
        if (typeof handler !== 'function') throw new Error('route handler 必须是函数');
        const record = { method: normalizedMethod, path: normalizedPath, handler };
        routes.push(record);
        return () => {
          const index = routes.indexOf(record);
          if (index >= 0) routes.splice(index, 1);
        };
      },
      on: (event, handler) => {
        const dispose = this.on(event, handler);
        disposers.push(dispose);
        return dispose;
      },
      emit: (event, payload) => this.emit(event, payload),
      memory: this.memory,
      align: this.align,
      bridge: this.bridge,
      bili: {
        run: (args = [], options = {}) => this.execBili(args, options),
      },
      qq: {
        readConfig: () => readJson(QQ_CONFIG, {}),
      },
      crypto: { randomUUID: () => crypto.randomUUID() },
    };
    return api;
  }

  execBili(args = [], { timeoutMs = 120_000 } = {}) {
    return new Promise((resolve) => {
      execFile(findNodeExe(), [BILI_MJS, ...args.map(String)], {
        cwd: path.dirname(BILI_MJS),
        timeout: Math.max(1000, Math.min(600_000, Number(timeoutMs) || 120_000)),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          out: String(stdout ?? '').slice(-20_000),
          err: String(stderr ?? '').slice(-4000),
        });
      });
    });
  }

  /** 找到扩展注册的自定义路由（供主 HTTP 分发）。 */
  routeFor(id, method, routePath) {
    const record = this.active.get(id);
    if (!record) return null;
    const normalizedMethod = String(method ?? 'GET').toUpperCase();
    const normalizedPath = `/${String(routePath ?? '').replace(/^\/+/, '')}`;
    return record.routes.find((route) => route.method === normalizedMethod && route.path === normalizedPath) ?? null;
  }

  async activateEnabled() {
    const results = [];
    for (const manifest of this.discover()) {
      if (!this.isEnabled(manifest.id)) continue;
      results.push({ id: manifest.id, ...(await this.activate(manifest.id)) });
    }
    return results;
  }

  async deactivateAll() {
    for (const id of [...this.active.keys()]) await this.deactivate(id);
  }

  describe() {
    const manifests = this.discover();
    return manifests.map((manifest) => ({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      enabled: this.isEnabled(manifest.id),
      active: this.active.has(manifest.id),
      capabilities: manifest.capabilities,
      platforms: manifest.platforms,
      author: manifest.author,
      config: this.getConfig(manifest.id),
      routes: this.active.get(manifest.id)?.routes.map((route) => `${route.method} ${route.path}`) ?? [],
    }));
  }
}
