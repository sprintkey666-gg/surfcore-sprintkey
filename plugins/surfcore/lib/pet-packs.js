// 桌宠「皮肤包」管理：dsh-pet 之外的形象包放进 <stateDir>/orb/pet/packs/<id>。
//
// 为什么要这层：形象素材原本写死在 lib/pet-assets.js 的 dsh-pet 上，换形象只能重装整包。
// 现在一个包 = 一个目录，切换只改 packs.json 的 activePackId，petInfo() 把 active 包的 dir 交给
// 桌宠渲染端，所以换包不需要改渲染端代码。
//
// 两种包（pack.json 的 kind）：
//   webm    <id>/{pack.json, webm/*.webm, manifest.json, preview.png, LICENSE}
//           webm 文件名 = 动作名；pet.js 用 `${dir}/webm/<动作名>.webm` 拼路径。
//   figure  <id>/{pack.json, index.html, 其它静态资源}
//           网页形象：桌宠窗口用 iframe 载入 entry（index.html），形象自己画。
//           只允许纯前端，没有 Node API；宿主用 postMessage 发动作，形象回 figure:ready。
//
// pack.json v2：{id,name,version,kind:'webm'|'figure',author,license,source,entry?,webm?,preview?}
//   - 旧 v1（没有 kind）继续能读，按目录里有没有 index.html 自动判定；
//   - entry 只在 figure 包里用，缺省 index.html。
//
//   <stateDir>/orb/pet/packs.json                 {version:2, activePackId, packs:[已发布的包]}
//
// 内置包 id = 'dsh-pet'：就是老的 <stateDir>/orb/pet/{webm,manifest.json,config.jsonc}。
// 它在 pets 根目录而不是 packs 子目录里，所以只读、不能删、不能覆盖；别的包都不可用时自动回落它。
//
// 许可提醒：dsh-pet 是 MIT（素材可以直接复用/再分发）；Coopanion 是 AGPL-3.0-or-later ——
// **只参考它的设计（换皮/待机/注视），不要把它的代码或素材打进本包**，否则整插件会被传染成 AGPL。
//
// 依赖注入：readTar / stripJsonc / buildManifest / downloadTo / installFromNpm 都在 pet-assets.js 里，
// 由 createPetAssetsService() 传进来，避免两个模块互相 import 绕成环。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKS_VERSION = 2;
export const BUILTIN_PACK_ID = 'dsh-pet';
export const FIGURE_ENTRY = 'index.html';

const PACK_FILE = 'pack.json';
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const PREVIEW_NAMES = ['preview.png', 'preview.jpg', 'preview.jpeg', 'preview.webp'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__MACOSX']);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// 内置可选清单 + 随仓入库的 figure 示例包。
const DEFAULT_CATALOG_DIR = path.join(HERE, '..', 'assets', 'pet-packs');
const FIGURE_EXTS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.otf', '.ico', '.mp3', '.ogg', '.wav', '.webm']);

/** 包 id 只允许 [a-z0-9._-]，防止 `../` 穿越；不合法的用 fallback。 */
export function sanitizePackId(raw, fallback = 'pack') {
  const text = String(raw ?? '').trim().toLowerCase();
  const cleaned = text.replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 48);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

/** 从任意名字（文件夹名/包名）猜一个 id。 */
export function packIdFromName(name) {
  return sanitizePackId(String(name ?? '').replace(/\.(tgz|tar\.gz|zip)$/i, ''), 'pack');
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** 目录里 webm 的数量 + 字节数。 */
function countWebm(dir) {
  let count = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.webm')) continue;
      count += 1;
      try { bytes += fs.statSync(path.join(dir, name)).size; } catch {}
    }
  } catch {}
  return { count, bytes };
}

/**
 * 包是 webm 动画包还是网页形象包：pack.json 写了 kind 就信它（只认两个合法值），
 * 没写就看目录里有没有 index.html —— 这样旧 v1 包和用户随手拷进来的文件夹都能用。
 */
function detectKind(dir, meta) {
  const declared = String(meta?.kind || '').trim().toLowerCase();
  if (declared === 'figure' || declared === 'webm') return declared;
  return isFile(path.join(dir, FIGURE_ENTRY)) ? 'figure' : 'webm';
}

/** figure 包的入口绝对路径；取不到返回空串（webm 包永远为空）。 */
function entryOf(dir, kind, meta) {
  if (kind !== 'figure') return '';
  const rel = String(meta?.entry || FIGURE_ENTRY).replace(/^[/\\]+/, '');
  const full = path.join(dir, rel);
  if (isFile(full)) return full;
  const fallback = path.join(dir, FIGURE_ENTRY);
  return isFile(fallback) ? fallback : '';
}

function fileUrlOf(file) {
  try { return file ? pathToFileURL(file).href : ''; } catch { return ''; }
}

function dirBytes(dir) {
  let total = 0;
  const walk = (p) => {
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch {} }
    }
  };
  walk(dir);
  return total;
}

/** 递归复制（导入用）。不跟符号链接，跳过 node_modules/.git 这类垃圾。 */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(from, to);
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}

/** 去掉 tar 包统一的顶层目录（`package/...`、`dsh-pet-0.3.8/...`）。 */
function stripTopDir(entries) {
  if (!entries.length) return entries;
  const firsts = new Set(entries.map((e) => e.name.split('/')[0]));
  if (firsts.size !== 1) return entries;
  if (!entries.every((e) => e.name.includes('/'))) return entries;
  const head = `${[...firsts][0]}/`;
  return entries.map((e) => ({ ...e, name: e.name.slice(head.length) }));
}

const ANIM_KEYS = ['idle', 'turn', 'drag', 'clicks', 'moves', 'categories', 'weights'];

function hasAnimKeys(obj) {
  return Boolean(obj) && ANIM_KEYS.some((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** 把任意来源（包内联/手写）的清单填成渲染端能吃的成品，和 pet-assets.buildManifest() 同形。 */
export function normalizeManifest(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const weights = src.weights || {};
  return {
    version: 1,
    idle: asList(src.idle),
    turn: asList(src.turn),
    drag: asList(src.drag),
    clicks: asList(src.clicks),
    moves: Array.isArray(src.moves)
      ? src.moves
        .map((a) => (typeof a === 'string' ? { name: a } : { name: a?.name, params: a?.params || {} }))
        .filter((a) => a.name)
      : [],
    categories: Array.isArray(src.categories)
      ? src.categories
        .map((c) => ({
          id: String(c?.id ?? ''),
          weight: num(c?.weight, 0),
          noMirror: c?.noMirror === true,
          actions: asList(c?.actions),
        }))
        .filter((c) => c.actions.length)
      : [],
    weights: {
      idle: num(weights.idle, 10),
      turn: num(weights.turn, 5),
      move: num(weights.move, 5),
      click: num(weights.click, 0),
      drag: num(weights.drag, 0),
    },
  };
}

/** 清单里出现的所有动作名（去重），用来核对 webm 有没有缺。 */
export function manifestActions(manifest) {
  const out = new Set();
  const add = (name) => { if (typeof name === 'string' && name) out.add(name); };
  if (!manifest || typeof manifest !== 'object') return [];
  for (const key of ['idle', 'turn', 'drag', 'clicks']) asList(manifest[key]).forEach(add);
  for (const m of Array.isArray(manifest.moves) ? manifest.moves : []) add(m?.name);
  for (const c of Array.isArray(manifest.categories) ? manifest.categories : []) asList(c?.actions).forEach(add);
  return [...out];
}

export function createPetPacksService({ stateDir, builtinDir, pluginLog = () => {}, helpers = {}, catalogDir = DEFAULT_CATALOG_DIR } = {}) {
  const root = path.join(stateDir, 'orb', 'pet');
  const packsDir = path.join(root, 'packs');
  const stateFile = path.join(root, 'packs.json');
  const builtin = builtinDir || root;
  const { readTar, buildManifest } = helpers;
  const catalogRoot = String(catalogDir || DEFAULT_CATALOG_DIR);

  function packDirOf(id) {
    return path.join(packsDir, sanitizePackId(id));
  }

  function readState() {
    const data = readJson(stateFile);
    return {
      version: PACKS_VERSION,
      activePackId: String(data?.activePackId || BUILTIN_PACK_ID),
      // 「已发布」的包：publish 写进来，方便 list/detail 记住用户装过什么（盘上删了也能显出来）。
      packs: Array.isArray(data?.packs) ? data.packs.filter((p) => p && typeof p.id === 'string' && p.id) : [],
    };
  }

  function writeState(activePackId, registry = readState().packs) {
    fs.mkdirSync(root, { recursive: true });
    const next = {
      version: PACKS_VERSION,
      activePackId: sanitizePackId(activePackId, BUILTIN_PACK_ID),
      packs: Array.isArray(registry) ? registry.filter((p) => p && p.id) : [],
    };

    // 内置包 id 里带 `-`，sanitize 后还是 'dsh-pet'，这里再兜一次，别被清洗掉。
    next.activePackId = String(activePackId) === BUILTIN_PACK_ID ? BUILTIN_PACK_ID : next.activePackId;
    // 小写别名：id 一律小写存，避免 Windows 大小写不敏感带来的「找不到包」。
    next.activePackId = String(next.activePackId).toLowerCase() === BUILTIN_PACK_ID
      ? BUILTIN_PACK_ID
      : next.activePackId.toLowerCase();
    fs.writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  }

  /** 内置可选清单：assets/pet-packs/index.json（dsh-pet 走 npm，figure 包随仓入库）。 */
  function readCatalog() {
    const file = path.join(catalogRoot, 'index.json');
    const data = readJson(file);
    const packs = Array.isArray(data?.packs) ? data.packs : [];
    return {
      file,
      dir: catalogRoot,
      version: Number(data?.version) || 0,
      packs: packs.filter((p) => p && typeof p.id === 'string' && p.id).map((p) => ({
        id: sanitizePackId(p.id),
        name: String(p.name || p.id),
        kind: p.kind === 'figure' ? 'figure' : 'webm',
        version: String(p.version || ''),
        license: String(p.license || ''),
        author: String(p.author || ''),
        description: String(p.description || ''),
        npm: String(p.npm || ''),
        bundled: String(p.bundled || ''),
        url: String(p.url || ''),
      })),
    };
  }

  function builtinSummary() {
    const webm = leftCount(path.join(builtin, 'webm'));
    const marker = readJson(path.join(builtin, '.surfcore-pet.json'));
    const kind = detectKind(builtin, marker);
    const entry = entryOf(builtin, kind, marker);
    return {
      id: BUILTIN_PACK_ID,
      name: '内置 · dsh-pet（小鲸鱼）',
      kind,
      version: String(marker?.version || ''),
      author: 'dsh-pet',
      license: 'MIT',
      builtin: true,
      installed: kind === 'figure' ? Boolean(entry) : Boolean(marker) && webm.count > 0,
      webmCount: webm.count,
      bytes: Number(marker?.bytes) || webm.bytes,
      dir: builtin,
      entry,
      preview: isFile(path.join(builtin, 'preview.png')) ? path.join(builtin, 'preview.png') : '',
      updatedAt: String(marker?.installedAt || ''),
      error: '',
    };
  }

  function leftCount(dir) { return countWebm(dir); }

  /** 读一个包目录的元信息（缺 pack.json 也能用，靠目录名兜底）。 */
  function readPackMeta(id, dir) {
    const meta = readJson(path.join(dir, PACK_FILE)) || {};
    const kind = detectKind(dir, meta);
    const entry = entryOf(dir, kind, meta);
    const webmDirName = String(meta.webm || 'webm');
    const webmDir = path.join(dir, webmDirName);
    const webm = countWebm(webmDir);
    const preview = PREVIEW_NAMES.map((n) => path.join(dir, n)).find((p) => isFile(p)) || '';
    const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license.txt'].map((n) => path.join(dir, n)).find((p) => isFile(p)) || '';
    const installed = kind === 'figure' ? Boolean(entry) : webm.count > 0;
    let error = '';
    if (!installed) error = kind === 'figure' ? `figure 包缺 ${FIGURE_ENTRY}` : '这个包里没有 webm 动画';
    else if (kind === 'webm' && !manifestOfDir(dir, { meta })) error = '缺少动画清单（manifest.json / config.jsonc）';
    return {
      id: sanitizePackId(meta.id || id),
      name: String(meta.name || id),
      kind,
      version: String(meta.version || ''),
      author: String(meta.author || ''),
      license: String(meta.license || ''),
      source: String(meta.source || ''),
      createdAt: String(meta.createdAt || ''),
      builtin: false,
      installed,
      webmCount: webm.count,
      bytes: dirBytes(dir),
      dir,
      entry,
      webmDir,
      preview,
      licenseFile,
      error,
      meta,
    };
  }

  /** 包目录里的清单：manifest.json → config.jsonc → pack.json 内联 → webm 文件名兜底。 */
  function manifestOfDir(dir, meta) {
    const mf = readJson(path.join(dir, 'manifest.json'));
    if (mf && (manifestActions(mf).length || Array.isArray(mf.idle))) return normalizeManifest(mf);
    const cfgFile = path.join(dir, 'config.jsonc');
    if (isFile(cfgFile) && typeof buildManifest === 'function') {
      try { return normalizeManifest(buildManifest(fs.readFileSync(cfgFile, 'utf8'))); } catch (error) {
        pluginLog('[pet-packs] config.jsonc 解析失败：', String(error?.message ?? error));
      }
    }
    const packMeta = meta?.meta || readJson(path.join(dir, PACK_FILE)) || {};
    if (packMeta.manifest && typeof packMeta.manifest === 'object') return normalizeManifest(packMeta.manifest);
    if (hasAnimKeys(packMeta)) return normalizeManifest(packMeta);
    // 最后兜底：把 webm 文件名按顺序塞进 idle，至少不至于黑窗。
    const names = (() => {
      try { return fs.readdirSync(path.join(dir, 'webm')).filter((n) => n.toLowerCase().endsWith('.webm')).map((n) => path.basename(n, path.extname(n))); } catch { return []; }
    })();
    if (!names.length) return null;
    return normalizeManifest({ idle: names });
  }

  function listPacks() {
    const state = readState();
    const catalog = readCatalog();
    const catalogById = new Map(catalog.packs.map((c) => [c.id, c]));
    const packs = [builtinSummary()];
    let entries = [];
    try { entries = fs.readdirSync(packsDir, { withFileTypes: true }); } catch {}
    for (const ent of entries) {
      if (!ent.isDirectory() || SKIP_DIRS.has(ent.name)) continue;
      const dir = path.join(packsDir, ent.name);
      const meta = readPackMeta(ent.name, dir);
      if (meta.id === BUILTIN_PACK_ID) continue; // 撞名就以内置的为准
      packs.push({
        id: meta.id,
        name: meta.name,
        kind: meta.kind,
        version: meta.version,
        author: meta.author,
        license: meta.license,
        source: meta.source,
        createdAt: meta.createdAt,
        builtin: false,
        installed: meta.installed,
        webmCount: meta.webmCount,
        bytes: meta.bytes,
        dir: meta.dir,
        entry: meta.entry,
        preview: meta.preview,
        updatedAt: '',
        error: meta.error,
      });
    }
    // 清单里有、盘上还没有的包也列出来（UI 直接给「下载」按钮），但不算已装。
    const onDisk = new Set(packs.map((p) => p.id));
    for (const c of catalog.packs) {
      if (onDisk.has(c.id)) continue;
      packs.push({
        id: c.id,
        name: c.name,
        kind: c.kind,
        version: c.version,
        author: c.author,
        license: c.license,
        source: '内置清单',
        createdAt: '',
        builtin: c.id === BUILTIN_PACK_ID,
        installed: false,
        webmCount: 0,
        bytes: 0,
        dir: '',
        entry: '',
        preview: '',
        updatedAt: '',
        error: '',
        catalog: true,
        description: c.description,
        npm: c.npm,
        bundled: c.bundled,
      });
    }
    const ids = new Set(packs.map((p) => p.id));
    const activePackId = ids.has(state.activePackId) ? state.activePackId : BUILTIN_PACK_ID;
    for (const pack of packs) {
      pack.active = pack.id === activePackId;
      // 清单信息挂到同 id 的盘上包：设置页能显示「最新版 0.4.1 / 可下载」。
      const cat = catalogById.get(pack.id);
      if (cat && !pack.catalog) {
        pack.catalog = true;
        pack.description = cat.description;
        pack.npm = cat.npm;
        pack.bundled = cat.bundled;
        pack.latestVersion = cat.version;
      }
    }
    return { activePackId, packs, catalogVersion: catalog.version };
  }

  /** 当前生效的包（找不到就回落内置）。webm 给 dir，figure 还多给一个 entry。 */
  function active() {
    const state = readState();
    const id = sanitizePackId(state.activePackId, BUILTIN_PACK_ID);
    if (id === BUILTIN_PACK_ID) {
      const meta = builtinSummary();
      return {
        id: BUILTIN_PACK_ID,
        kind: meta.kind,
        dir: builtin,
        webmDir: path.join(builtin, 'webm'),
        entry: meta.entry,
        entryUrl: fileUrlOf(meta.entry),
        manifest: readPackMeta(BUILTIN_PACK_ID, builtin).installed
          ? manifestOfDir(builtin)
          : null,
        builtin: true,
        name: meta.name,
      };
    }
    const dir = packDirOf(id);
    if (!isDir(dir)) {
      const meta = builtinSummary();
      return {
        id: BUILTIN_PACK_ID,
        kind: meta.kind,
        dir: builtin,
        webmDir: path.join(builtin, 'webm'),
        entry: meta.entry,
        entryUrl: fileUrlOf(meta.entry),
        manifest: manifestOfDir(builtin),
        builtin: true,
        name: '内置 · dsh-pet（小鲸鱼）',
        missing: id,
      };
    }
    const meta = readPackMeta(id, dir);
    return {
      id: meta.id,
      kind: meta.kind,
      dir: meta.dir,
      webmDir: meta.webmDir,
      entry: meta.entry,
      entryUrl: fileUrlOf(meta.entry),
      manifest: meta.kind === 'figure' ? null : manifestOfDir(dir, meta),
      builtin: false,
      name: meta.name,
    };
  }

  /** 核对一个包：webm 看清单里的动作是不是都有文件；figure 看入口在不在。 */
  function verify(id) {
    const wantId = sanitizePackId(id || active().id, BUILTIN_PACK_ID);
    const dir = wantId === BUILTIN_PACK_ID ? builtin : packDirOf(wantId);
    if (!isDir(dir)) return { ok: false, id: wantId, error: `没有这个皮肤包：${wantId}` };
    const meta = wantId === BUILTIN_PACK_ID ? builtinSummary() : readPackMeta(wantId, dir);
    const kind = meta.kind || 'webm';
    if (kind === 'figure') {
      const entry = meta.entry || '';
      return {
        ok: Boolean(entry),
        id: wantId,
        name: meta.name,
        kind,
        dir,
        entry,
        entryUrl: fileUrlOf(entry),
        webmCount: 0,
        actionCount: 0,
        missing: [],
        missingCount: 0,
        hasManifest: false,
        bytes: meta.bytes,
        license: meta.license || (wantId === BUILTIN_PACK_ID ? 'MIT' : ''),
        error: entry ? '' : `figure 包缺 ${FIGURE_ENTRY}`,
      };
    }
    const manifest = manifestOfDir(dir, meta);
    const webmDir = wantId === BUILTIN_PACK_ID ? path.join(builtin, 'webm') : meta.webmDir;
    let files = [];
    try { files = new Set(fs.readdirSync(webmDir).filter((n) => n.toLowerCase().endsWith('.webm')).map((n) => path.basename(n, path.extname(n)))); } catch {}
    const actions = manifestActions(manifest);
    const missing = actions.filter((a) => !files.has(a));
    const extra = [...files].filter((f) => !actions.includes(f));
    return {
      ok: Boolean(manifest) && missing.length === 0 && files.size > 0,
      id: wantId,
      name: meta.name,
      kind,
      dir,
      entry: '',
      webmCount: files.size,
      actionCount: actions.length,
      missing: missing.slice(0, 30),
      missingCount: missing.length,
      extraCount: extra.length,
      hasManifest: Boolean(manifest),
      bytes: meta.bytes,
      license: meta.license || (wantId === BUILTIN_PACK_ID ? 'MIT' : ''),
    };
  }

  /** 把一个包目录写成正式包（先写 staging，再整体替换，避免中途失败留下半个包）。 */
  function commitFromStaging(staging, { id, overwrite = false } = {}) {
    const packId = sanitizePackId(id);
    if (packId === BUILTIN_PACK_ID) return { ok: false, error: '内置包不能覆盖（要换素材请先「移除」再「下载」）' };
    const dest = packDirOf(packId);
    if (isDir(dest) && !overwrite) return { ok: false, error: `皮肤包 ${packId} 已经存在（勾选覆盖才能替换）` };
    const meta = readJson(path.join(staging, PACK_FILE)) || {};
    const kind = detectKind(staging, meta);

    let packFile = null;
    if (kind === 'figure') {
      const entry = entryOf(staging, kind, meta);
      if (!entry) return { ok: false, error: `网页形象包缺入口 ${FIGURE_ENTRY}` };
      const entryRel = path.relative(staging, entry).replace(/\\/g, '/') || FIGURE_ENTRY;
      packFile = {
        id: packId,
        name: String(meta.name || packId),
        version: String(meta.version || ''),
        kind: 'figure',
        author: String(meta.author || ''),
        license: String(meta.license || ''),
        source: String(meta.source || '本地导入'),
        createdAt: new Date().toISOString(),
        entry: entryRel,
      };
    } else {
      const webm = countWebm(path.join(staging, String(meta.webm || 'webm')));
      if (!webm.count) return { ok: false, error: '这个包里没有 webm 动画（至少要 webm/*.webm）' };

      const manifest = manifestOfDir(staging, { meta });
      if (!manifest) return { ok: false, error: '打包里没有可用的动画清单（需要 manifest.json / config.jsonc / pack.json.idle）' };
      fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      packFile = {
        id: packId,
        name: String(meta.name || packId),
        version: String(meta.version || ''),
        kind: 'webm',
        author: String(meta.author || ''),
        license: String(meta.license || ''),
        source: String(meta.source || '本地导入'),
        createdAt: new Date().toISOString(),
        webm: String(meta.webm || 'webm'),
      };
    }
    fs.writeFileSync(path.join(staging, PACK_FILE), `${JSON.stringify(packFile, null, 2)}\n`, 'utf8');

    fs.mkdirSync(packsDir, { recursive: true });
    if (isDir(dest)) {
      const aside = `${dest}.old-${Date.now()}`;
      try { fs.renameSync(dest, aside); } catch { fs.rmSync(dest, { recursive: true, force: true }); }
      try { fs.renameSync(staging, dest); } catch (error) {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(staging, dest);
        pluginLog('[pet-packs] 覆盖包时先删后备：', String(error?.message ?? error));
      }
      try { fs.rmSync(aside, { recursive: true, force: true }); } catch {}
    } else {
      fs.renameSync(staging, dest);
    }
    const summary = readPackMeta(packId, dest);
    pluginLog('[pet-packs] 皮肤包已就绪：', packId, summary.kind === 'figure' ? 'figure' : `${summary.webmCount} 个动画`);
    return {
      ok: true,
      id: packId,
      pack: {
        id: summary.id,
        name: summary.name,
        kind: summary.kind,
        version: summary.version,
        webmCount: summary.webmCount,
        bytes: summary.bytes,
        dir: summary.dir,
        entry: summary.entry,
      },
      ...listPacks(),
    };
  }

  /** 从本机文件夹导入：复制 → 生成 manifest/pack.json → 原子替换。 */
  function installFromDir(srcDir, { id, name, overwrite = false } = {}) {
    const src = String(srcDir || '').trim();
    if (!src || !isDir(src)) return { ok: false, error: '要导入的文件夹不存在' };
    const abs = path.resolve(src);
    if (abs === path.resolve(packsDir) || abs.startsWith(`${path.resolve(packsDir)}${path.sep}`)) {
      return { ok: false, error: '不能把 packs 目录自己导进 packs' };
    }
    if (abs === path.resolve(builtin) || abs.startsWith(`${path.resolve(builtin)}${path.sep}`)) {
      return { ok: false, error: '不能把内置素材目录导成外部包（它已经是内置包了）' };
    }
    const base = readJson(path.join(abs, PACK_FILE)) || {};
    const packId = sanitizePackId(id || base.id || path.basename(abs));
    const staging = `${packDirOf(packId)}.in-${Date.now()}`;
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      copyTree(abs, staging);
      // 只带了 webm 没带清单时，补一份最小的 pack.json 让 commit 有名字可用。
      if (!isFile(path.join(staging, PACK_FILE))) {
        fs.writeFileSync(path.join(staging, PACK_FILE), `${JSON.stringify({
          id: packId,
          name: String(name || base.name || path.basename(abs)),
          source: abs,
        }, null, 2)}\n`, 'utf8');
      } else if (name) {
        const cur = readJson(path.join(staging, PACK_FILE)) || {};
        fs.writeFileSync(path.join(staging, PACK_FILE), `${JSON.stringify({ ...cur, name }, null, 2)}\n`, 'utf8');
      }
      return commitFromStaging(staging, { id: packId, overwrite });
    } catch (error) {
      const message = String(error?.message ?? error);
      pluginLog('[pet-packs] 从文件夹导入失败：', message);
      return { ok: false, error: `导入失败：${message}` };
    } finally {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    }
  }

  /** 从 .tgz/.tar.gz 导入：认我们的包布局，也认上游 dsh-pet 的 `package/assets/webm/*.webm`。 */
  function installFromTgz(source, { id, name, overwrite = false } = {}) {
    let buf = null;
    if (Buffer.isBuffer(source)) buf = source;
    else {
      const file = String(source || '').trim();
      if (!file || !isFile(file)) return { ok: false, error: '找不到要导入的压缩包' };
      try {
        const st = fs.statSync(file);
        if (st.size > MAX_IMPORT_BYTES) return { ok: false, error: '压缩包太大（上限 512MB）' };
        buf = fs.readFileSync(file);
      } catch (error) {
        return { ok: false, error: `读压缩包失败：${String(error?.message ?? error)}` };
      }
    }
    if (typeof readTar !== 'function') return { ok: false, error: '当前版本缺少 tar 解析器' };
    let entries = [];
    try {
      entries = stripTopDir(readTar(zlib.gunzipSync(buf), (n) => !n.endsWith('/')));
    } catch (error) {
      return { ok: false, error: `压缩包解不开：${String(error?.message ?? error)}` };
    }
    if (!entries.length) return { ok: false, error: '压缩包里是空的' };

    const packId = sanitizePackId(id || packIdFromName(name || path.basename(String(source || 'pack'))));
    const staging = `${packDirOf(packId)}.in-${Date.now()}`;
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      // 网页形象包：包里带 index.html，整棵目录原样落地，交给 commitFromStaging 判 kind。
      const isFigure = entries.some((file) => /(^|\/)index\.html?$/i.test(String(file.name || '').replace(/\\/g, '/')));
      if (isFigure) {
        for (const file of entries) {
          const rel = String(file.name || '').replace(/^\.\//, '').replace(/\\/g, '/');
          if (!rel || rel.startsWith('/') || rel.split('/').some((seg) => seg === '..')) continue;
          const out = path.join(staging, rel);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, file.data);
        }
        if (!isFile(path.join(staging, PACK_FILE))) {
          fs.writeFileSync(path.join(staging, PACK_FILE), `${JSON.stringify({
            id: packId,
            name: String(name || path.basename(String(source || 'pack')).replace(/\.(tgz|tar\.gz)$/i, '')),
            kind: 'figure',
            source: Buffer.isBuffer(source) ? '上传的 tgz' : String(source),
          }, null, 2)}\n`, 'utf8');
        }
        return commitFromStaging(staging, { id: packId, overwrite });
      }
      fs.mkdirSync(path.join(staging, 'webm'), { recursive: true });
      let webmCount = 0;
      let licenseText = '';
      for (const file of entries) {
        const rel = file.name.replace(/^\.\//, '');
        const lower = rel.toLowerCase();
        // 上游 dsh-pet：assets/webm/<名>.webm + assets/config.jsonc
        if (lower.startsWith('assets/webm/') || lower.startsWith('webm/')) {
          const base = path.basename(rel);
          if (!base.toLowerCase().endsWith('.webm')) continue;
          fs.writeFileSync(path.join(staging, 'webm', base), file.data);
          webmCount += 1;
          continue;
        }
        if (lower === 'assets/config.jsonc') {
          fs.writeFileSync(path.join(staging, 'config.jsonc'), file.data);
          continue;
        }
        if (lower === 'config.jsonc') { fs.writeFileSync(path.join(staging, 'config.jsonc'), file.data); continue; }
        if (lower === 'manifest.json') { fs.writeFileSync(path.join(staging, 'manifest.json'), file.data); continue; }
        if (lower === PACK_FILE) { fs.writeFileSync(path.join(staging, PACK_FILE), file.data); continue; }
        if (PREVIEW_NAMES.includes(lower)) { fs.writeFileSync(path.join(staging, path.basename(lower)), file.data); continue; }
        if (lower.startsWith('license')) { licenseText = file.data.toString('utf8'); fs.writeFileSync(path.join(staging, 'LICENSE'), file.data); continue; }
      }
      if (!webmCount) return { ok: false, error: '压缩包里没有 webm 动画（认 webm/ 和 assets/webm/）' };
      if (!isFile(path.join(staging, PACK_FILE))) {
        fs.writeFileSync(path.join(staging, PACK_FILE), `${JSON.stringify({
          id: packId,
          name: String(name || path.basename(String(source || 'pack')).replace(/\.(tgz|tar\.gz)$/i, '')),
          license: licenseText ? '见包内 LICENSE' : '',
          source: Buffer.isBuffer(source) ? '上传的 tgz' : String(source),
        }, null, 2)}\n`, 'utf8');
      }
      return commitFromStaging(staging, { id: packId, overwrite });
    } catch (error) {
      const message = String(error?.message ?? error);
      pluginLog('[pet-packs] 从 tgz 导入失败：', message);
      return { ok: false, error: `导入失败：${message}` };
    } finally {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    }
  }

  /** 切换生效包（webm 和 figure 都行；figure 只要入口在就能切）。 */
  function activate(id) {
    const packId = sanitizePackId(id, BUILTIN_PACK_ID);
    if (packId === BUILTIN_PACK_ID) {
      writeState(BUILTIN_PACK_ID);
      return { ok: true, active: active(), ...listPacks() };
    }
    const dir = packDirOf(packId);
    if (!isDir(dir)) return { ok: false, error: `没有这个皮肤包：${packId}` };
    const meta = readPackMeta(packId, dir);
    if (!meta.installed) return { ok: false, error: meta.error || `皮肤包 ${packId} 不完整` };
    writeState(packId);
    pluginLog('[pet-packs] 切换皮肤包：', packId, meta.kind);
    return { ok: true, active: active(), ...listPacks() };
  }

  /** 删掉一个外部包；内置包只允许「移除素材」（那是 pet-assets.remove() 的事）。 */
  function remove(id) {
    const packId = sanitizePackId(id);
    if (packId === BUILTIN_PACK_ID) return { ok: false, error: '内置包不能删（用「移除素材」清空即可）' };
    const dir = packDirOf(packId);
    if (!isDir(dir)) return { ok: false, error: `没有这个动画包：${packId}` };
    try {
      if (active().id === packId) writeState(BUILTIN_PACK_ID);
      fs.rmSync(dir, { recursive: true, force: true });
      pluginLog('[pet-packs] 已删除动画包：', packId);
      return { ok: true, ...listPacks() };
    } catch (error) {
      return { ok: false, error: `删除失败：${String(error?.message ?? error)}` };
    }
  }

  /** 设置页「动作测试」：不直连渲染端，只落一个命令文件，由主进程转发（Lead 加 IPC）。 */
  function queuePreview(name) {
    const action = String(name || '').trim();
    if (!action) return { ok: false, error: '要给一个动作名' };
    const file = path.join(root, 'preview.json');
    try {
      // name 是渲染端读的字段（pet.js 用 cfg.pet.preview.name），action 是设置页/日志用的同一个值。
      fs.writeFileSync(file, `${JSON.stringify({ name: action, action, at: Date.now() }, null, 2)}\n`, 'utf8');
      return { ok: true, queued: true, action, file };
    } catch (error) {
      return { ok: false, error: `写测试命令失败：${String(error?.message ?? error)}` };
    }
  }

  /**
   * 「发布」一个包：把 id/kind/version 写进 packs.json 的 packs 注册表。
   * 盘上是唯一事实来源，packs.json 只是记住「用户装过 / 点过发布」，方便设置页和 detail 用。
   */
  function publish(id) {
    const packId = sanitizePackId(id, BUILTIN_PACK_ID);
    const dir = packId === BUILTIN_PACK_ID ? builtin : packDirOf(packId);
    if (!isDir(dir)) return { ok: false, error: `没有这个皮肤包：${packId}` };
    const meta = packId === BUILTIN_PACK_ID ? builtinSummary() : readPackMeta(packId, dir);
    const state = readState();
    const registry = state.packs.filter((p) => p.id !== packId);
    registry.push({
      id: meta.id,
      name: meta.name,
      kind: meta.kind || 'webm',
      version: meta.version,
      license: meta.license,
      source: meta.source,
      installedAt: new Date().toISOString(),
    });
    writeState(state.activePackId, registry);
    return { ok: true, id: meta.id, published: true, ...listPacks() };
  }

  /** 单个包的完整信息 + 自检结果（设置页展开详情用）。 */
  function detail(id) {
    const packId = sanitizePackId(id || readState().activePackId, BUILTIN_PACK_ID);
    const dir = packId === BUILTIN_PACK_ID ? builtin : packDirOf(packId);
    if (!isDir(dir)) return { ok: false, error: `没有这个皮肤包：${packId}` };
    const meta = packId === BUILTIN_PACK_ID ? builtinSummary() : readPackMeta(packId, dir);
    const catalogEntry = readCatalog().packs.find((c) => c.id === meta.id) || null;
    return {
      ok: true,
      pack: {
        id: meta.id,
        name: meta.name,
        kind: meta.kind || 'webm',
        version: meta.version,
        author: meta.author,
        license: meta.license,
        source: meta.source,
        builtin: Boolean(meta.builtin),
        installed: meta.installed,
        dir: meta.dir,
        entry: meta.entry,
        entryUrl: fileUrlOf(meta.entry),
        preview: meta.preview,
        bytes: meta.bytes,
        webmCount: meta.webmCount,
        active: readState().activePackId === meta.id,
        error: meta.error || '',
        description: catalogEntry?.description || '',
        manifest: meta.kind === 'figure' ? null : manifestOfDir(dir, meta),
      },
      verify: verify(packId),
      catalog: catalogEntry,
    };
  }

  /** 从内置清单装：npm 包（dsh-pet@x.y.z）或随仓入库的 figure 包（bundled 目录）。 */
  async function installFromCatalog(id, { overwrite = false, onProgress } = {}) {
    const wantId = sanitizePackId(id);
    const entry = readCatalog().packs.find((c) => c.id === wantId);
    if (!entry) return { ok: false, error: `内置清单里没有这个皮肤包：${id}` };
    let result = null;
    if (entry.bundled) {
      const src = path.join(catalogRoot, entry.bundled);
      if (!isDir(src)) return { ok: false, error: `随包内置的皮肤目录不存在：${src}` };
      result = installFromDir(src, { id: entry.id, name: entry.name, overwrite });
    } else if (entry.npm) {
      if (typeof helpers.installFromNpm !== 'function') return { ok: false, error: '当前版本不支持从 npm 安装皮肤包' };
      result = await helpers.installFromNpm(entry.npm, { onProgress, overwrite });
    } else if (entry.url) {
      if (typeof helpers.downloadTo !== 'function') return { ok: false, error: '当前版本缺少下载器' };
      try {
        const buf = await helpers.downloadTo(entry.url, onProgress);
        result = installFromTgz(buf, { id: entry.id, name: entry.name, overwrite });
      } catch (error) {
        result = { ok: false, error: `下载失败：${String(error?.message ?? error)}` };
      }
    } else {
      return { ok: false, error: `清单里的 ${entry.id} 没有可安装来源（npm / bundled / url）` };
    }
    if (result?.ok) {
      // 装完立刻登记，packs.json 里就有记录了（dsh-pet 装的是内置目录）。
      const published = publish(entry.id);
      if (published.ok) result = { ...result, ...published };
    }
    return result;
  }

  /** 一个入口吃下设置页所有包操作（index.js 只需转一次）。 */
  async function handleAction(body = {}) {
    const action = String(body?.action || 'list').trim().toLowerCase();
    try {
      if (!action || action === 'list' || action === 'status') {
        const data = listPacks();
        return { ok: true, ...data, verify: verify(data.activePackId) };
      }
      if (action === 'catalog') return { ok: true, ...readCatalog() };
      if (action === 'detail' || action === 'info') return detail(body.id);
      if (action === 'verify') return verify(body.id);
      if (action === 'activate') return activate(body.id);
      if (action === 'publish') return publish(body.id);
      if (action === 'remove') return remove(body.id);
      if (action === 'preview') return queuePreview(body.name || body.anim);
      if (action === 'install') {
        const id = String(body.id || '').trim();
        if (!id) return { ok: false, error: '要装哪个皮肤包？给 id（见 list 的 catalog 条目）' };
        const installed = await installFromCatalog(id, { overwrite: body.overwrite === true, onProgress: body.onProgress });
        if (!installed?.ok) return installed;
        // 默认装完就切过去（设置页点「下载」就是想看到新皮肤）；body.activate=false 可只装不切。
        if (body.activate === false) return installed;
        const switched = activate(installed.id && installed.id !== 'dsh-pet' ? installed.id : id);
        return switched.ok ? { ...installed, ...switched } : installed;
      }
      if (action === 'import' || action === 'import-dir' || action === 'import-tgz') {
        const src = String(body.path || '').trim();
        const opts = { id: body.id, name: body.name, overwrite: body.overwrite === true };
        let result = null;
        if (!src && body.dataBase64) result = installFromTgz(Buffer.from(String(body.dataBase64), 'base64'), opts);
        else if (!src) return { ok: false, error: '要导入得给本机路径（文件夹或 .tgz）' };
        else if (/\.(tgz|tar\.gz)$/i.test(src)) result = installFromTgz(src, opts);
        else if (isDir(src)) result = installFromDir(src, opts);
        else return { ok: false, error: '路径既不是文件夹也不是 .tgz/.tar.gz' };
        // 导入 = 已发布：顺手写进 packs.json，重装/迁移后设置页还认得出来。
        if (result?.ok && result.id) {
          const published = publish(result.id);
          if (published.ok) result = { ...result, ...published };
        }
        return result;
      }
      return { ok: false, error: `未知动作：${action}` };
    } catch (error) {
      const message = String(error?.message ?? error);
      pluginLog('[pet-packs] 操作失败：', message);
      return { ok: false, error: message };
    }
  }

  return {
    dir: packsDir,
    stateFile,
    builtinDir: builtin,
    catalogDir: catalogRoot,
    list: listPacks,
    active,
    verify,
    detail,
    publish,
    catalog: readCatalog,
    installFromDir,
    installFromTgz,
    installFromCatalog,
    activate,
    remove,
    queuePreview,
    manifestOfDir,
    handleAction,
  };
}
