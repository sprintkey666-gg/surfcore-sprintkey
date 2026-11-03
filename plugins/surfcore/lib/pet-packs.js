// 桌宠「动画包 / 皮肤」管理：dsh-pet 之外的形象包放进 <stateDir>/orb/pet/packs/<id>。
//
// 为什么要这层：形象素材原本写死在 lib/pet-assets.js 的 dsh-pet@0.3.8 上，换形象只能重装整包。
// 现在一个包 = 一个目录，切换只改 packs.json 的 activePackId，petInfo() 把 active 包的 dir 交给
// 桌宠渲染端（pet.js 用 `${dir}/webm/<动作名>.webm` 拼路径），所以换包不需要改渲染端代码。
//
// 目录格式：
//   <stateDir>/orb/pet/packs/<id>/pack.json       元信息 + 可选内联动画清单
//   <stateDir>/orb/pet/packs/<id>/webm/*.webm     640x360 VP9-alpha 动图，**文件名 = 动作名**
//   <stateDir>/orb/pet/packs/<id>/manifest.json   渲染端清单（缺省时由 config.jsonc 或 pack.json 现生成）
//   <stateDir>/orb/pet/packs/<id>/preview.png     可选预览图
//   <stateDir>/orb/pet/packs/<id>/LICENSE         可选许可原文（分发别人的素材必须留）
//   <stateDir>/orb/pet/packs.json                 {version:1, activePackId}
//
// 内置包 id = 'dsh-pet'：就是老的 <stateDir>/orb/pet/{webm,manifest.json,config.jsonc}。
// 它在 pets 根目录而不是 packs 子目录里，所以只读、不能删、不能覆盖；别的包都不可用时自动回落它。
//
// 许可提醒：dsh-pet 是 MIT（素材可以直接复用/再分发）；Coopanion 是 AGPL-3.0-or-later ——
// **只参考它的设计（换皮/待机/注视），不要把它的代码或素材打进本包**，否则整插件会被传染成 AGPL。
//
// 依赖注入：readTar / stripJsonc / buildManifest / downloadTo 都在 pet-assets.js 里，
// 由 createPetAssetsService() 传进来，避免两个模块互相 import 绕成环。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const PACKS_VERSION = 1;
export const BUILTIN_PACK_ID = 'dsh-pet';

const PACK_FILE = 'pack.json';
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const PREVIEW_NAMES = ['preview.png', 'preview.jpg', 'preview.jpeg', 'preview.webp'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__MACOSX']);

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

export function createPetPacksService({ stateDir, builtinDir, pluginLog = () => {}, helpers = {} } = {}) {
  const root = path.join(stateDir, 'orb', 'pet');
  const packsDir = path.join(root, 'packs');
  const stateFile = path.join(root, 'packs.json');
  const builtin = builtinDir || root;
  const { readTar, buildManifest } = helpers;

  function packDirOf(id) {
    return path.join(packsDir, sanitizePackId(id));
  }

  function readState() {
    const data = readJson(stateFile);
    return {
      version: PACKS_VERSION,
      activePackId: String(data?.activePackId || BUILTIN_PACK_ID),
    };
  }

  function writeState(activePackId) {
    fs.mkdirSync(root, { recursive: true });
    const next = { version: PACKS_VERSION, activePackId: sanitizePackId(activePackId, BUILTIN_PACK_ID) };

    // 内置包 id 里带 `-`，sanitize 后还是 'dsh-pet'，这里再兜一次，别被清洗掉。
    next.activePackId = String(activePackId) === BUILTIN_PACK_ID ? BUILTIN_PACK_ID : next.activePackId;
    // 小写别名：id 一律小写存，避免 Windows 大小写不敏感带来的「找不到包」。
    next.activePackId = String(next.activePackId).toLowerCase() === BUILTIN_PACK_ID
      ? BUILTIN_PACK_ID
      : next.activePackId.toLowerCase();
    fs.writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  }

  function builtinSummary() {
    const webm = leftCount(path.join(builtin, 'webm'));
    const marker = readJson(path.join(builtin, '.surfcore-pet.json'));
    return {
      id: BUILTIN_PACK_ID,
      name: '内置 · dsh-pet（小鲸鱼）',
      version: String(marker?.version || ''),
      author: 'dsh-pet',
      license: 'MIT',
      builtin: true,
      installed: Boolean(marker) && webm.count > 0,
      webmCount: webm.count,
      bytes: Number(marker?.bytes) || webm.bytes,
      dir: builtin,
      preview: isFile(path.join(builtin, 'preview.png')) ? path.join(builtin, 'preview.png') : '',
      updatedAt: String(marker?.installedAt || ''),
    };
  }

  function leftCount(dir) { return countWebm(dir); }

  /** 读一个包目录的元信息（缺 pack.json 也能用，靠目录名兜底）。 */
  function readPackMeta(id, dir) {
    const meta = readJson(path.join(dir, PACK_FILE)) || {};
    const webmDirName = String(meta.webm || 'webm');
    const webmDir = path.join(dir, webmDirName);
    const webm = countWebm(webmDir);
    const preview = PREVIEW_NAMES.map((n) => path.join(dir, n)).find((p) => isFile(p)) || '';
    const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license.txt'].map((n) => path.join(dir, n)).find((p) => isFile(p)) || '';
    return {
      id: sanitizePackId(meta.id || id),
      name: String(meta.name || id),
      version: String(meta.version || ''),
      author: String(meta.author || ''),
      license: String(meta.license || ''),
      source: String(meta.source || ''),
      createdAt: String(meta.createdAt || ''),
      builtin: false,
      installed: webm.count > 0,
      webmCount: webm.count,
      bytes: dirBytes(dir),
      dir,
      webmDir,
      preview,
      licenseFile,
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
        preview: meta.preview,
        updatedAt: '',
      });
    }
    const ids = new Set(packs.map((p) => p.id));
    const activePackId = ids.has(state.activePackId) ? state.activePackId : BUILTIN_PACK_ID;
    return { activePackId, packs };
  }

  /** 当前生效的包（找不到就回落内置）。返回的 dir 直接给渲染端拼 `${dir}/webm`。 */
  function active() {
    const state = readState();
    const id = sanitizePackId(state.activePackId, BUILTIN_PACK_ID);
    if (id === BUILTIN_PACK_ID) {
      const meta = builtinSummary();
      return {
        id: BUILTIN_PACK_ID,
        dir: builtin,
        webmDir: path.join(builtin, 'webm'),
        manifest: readPackMeta(BUILTIN_PACK_ID, builtin).installed
          ? manifestOfDir(builtin)
          : null,
        builtin: true,
        name: meta.name,
      };
    }
    const dir = packDirOf(id);
    if (!isDir(dir)) {
      return { id: BUILTIN_PACK_ID, dir: builtin, webmDir: path.join(builtin, 'webm'), manifest: manifestOfDir(builtin), builtin: true, name: '内置 · dsh-pet（小鲸鱼）', missing: id };
    }
    const meta = readPackMeta(id, dir);
    return { id: meta.id, dir: meta.dir, webmDir: meta.webmDir, manifest: manifestOfDir(dir, meta), builtin: false, name: meta.name };
  }

  /** 核对一个包：清单里的动作是不是都有 webm 文件。 */
  function verify(id) {
    const wantId = sanitizePackId(id || active().id, BUILTIN_PACK_ID);
    const dir = wantId === BUILTIN_PACK_ID ? builtin : packDirOf(wantId);
    if (!isDir(dir)) return { ok: false, id: wantId, error: `没有这个动画包：${wantId}` };
    const meta = wantId === BUILTIN_PACK_ID ? builtinSummary() : readPackMeta(wantId, dir);
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
      dir,
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
    if (isDir(dest) && !overwrite) return { ok: false, error: `动画包 ${packId} 已经存在（勾选覆盖才能替换）` };
    const meta = readJson(path.join(staging, PACK_FILE)) || {};
    const webm = countWebm(path.join(staging, String(meta.webm || 'webm')));
    if (!webm.count) return { ok: false, error: '这个包里没有 webm 动画（至少要 webm/*.webm）' };

    const manifest = manifestOfDir(staging, { meta });
    if (!manifest) return { ok: false, error: '打包里没有可用的动画清单（需要 manifest.json / config.jsonc / pack.json.idle）' };
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const packFile = {
      id: packId,
      name: String(meta.name || packId),
      version: String(meta.version || ''),
      author: String(meta.author || ''),
      license: String(meta.license || ''),
      source: String(meta.source || '本地导入'),
      createdAt: new Date().toISOString(),
      webm: String(meta.webm || 'webm'),
    };
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
    pluginLog('[pet-packs] 动画包已就绪：', packId, `${summary.webmCount} 个动画`);
    return {
      ok: true,
      id: packId,
      pack: {
        id: summary.id,
        name: summary.name,
        version: summary.version,
        webmCount: summary.webmCount,
        bytes: summary.bytes,
        dir: summary.dir,
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

  /** 切换生效包。 */
  function activate(id) {
    const packId = sanitizePackId(id, BUILTIN_PACK_ID);
    if (packId === BUILTIN_PACK_ID) {
      writeState(BUILTIN_PACK_ID);
      return { ok: true, active: active(), ...listPacks() };
    }
    const dir = packDirOf(packId);
    if (!isDir(dir)) return { ok: false, error: `没有这个动画包：${packId}` };
    const meta = readPackMeta(packId, dir);
    if (!meta.webmCount) return { ok: false, error: `动画包 ${packId} 里没有 webm` };
    writeState(packId);
    pluginLog('[pet-packs] 切换动画包：', packId);
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

  /** 一个入口吃下设置页所有包操作（index.js 只需转一次）。 */
  async function handleAction(body = {}) {
    const action = String(body?.action || 'list').trim().toLowerCase();
    try {
      if (!action || action === 'list' || action === 'status') {
        const data = listPacks();
        return { ok: true, ...data, verify: verify(data.activePackId) };
      }
      if (action === 'verify') return verify(body.id);
      if (action === 'activate') return activate(body.id);
      if (action === 'remove') return remove(body.id);
      if (action === 'preview') return queuePreview(body.name || body.anim);
      if (action === 'import' || action === 'import-dir' || action === 'import-tgz') {
        const src = String(body.path || '').trim();
        const opts = { id: body.id, name: body.name, overwrite: body.overwrite === true };
        if (!src && body.dataBase64) return installFromTgz(Buffer.from(String(body.dataBase64), 'base64'), opts);
        if (!src) return { ok: false, error: '要导入得给本机路径（文件夹或 .tgz）' };
        if (/\.(tgz|tar\.gz)$/i.test(src)) return installFromTgz(src, opts);
        if (isDir(src)) return installFromDir(src, opts);
        return { ok: false, error: '路径既不是文件夹也不是 .tgz/.tar.gz' };
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
    list: listPacks,
    active,
    verify,
    installFromDir,
    installFromTgz,
    activate,
    remove,
    queuePreview,
    manifestOfDir,
    handleAction,
  };
}
