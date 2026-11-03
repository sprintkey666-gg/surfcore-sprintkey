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
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKS_VERSION = 2;
export const BUILTIN_PACK_ID = 'dsh-pet';
export const FIGURE_ENTRY = 'index.html';

// 配色（tint）：都是 CSS filter，渲染端套在桌宠图层/iframe 上就行。
// 第一项固定是「原色」（id 为空），orb.pet.tint 为空串 = 不套滤镜。
export const DEFAULT_TINTS = [
  { id: '', name: '原色', filter: 'none' },
  { id: 'whale', name: '鲸蓝', filter: 'hue-rotate(-12deg) saturate(1.18) brightness(1.02)' },
  { id: 'sakura', name: '樱花', filter: 'hue-rotate(315deg) saturate(1.06) brightness(1.07)' },
  { id: 'mint', name: '薄荷', filter: 'hue-rotate(88deg) saturate(0.92) brightness(1.05)' },
  { id: 'dusk', name: '暮金', filter: 'hue-rotate(32deg) saturate(1.22) brightness(1.04) sepia(0.14)' },
  { id: 'night', name: '夜航', filter: 'hue-rotate(198deg) saturate(0.82) brightness(0.84) contrast(1.06)' },
];

const TINT_ID_RE = /^[a-z0-9_-]{0,24}$/;
// filter 只允许 CSS 滤镜常用的字符；分号/url()/expression 之类直接丢弃，防注入。
const TINT_FILTER_RE = /^[a-z0-9\s().,%+\-]{0,160}$/i;

/** 校验一包配色；坏的条目丢掉，全坏就回落默认六套。 */
export function normalizeTints(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const id = String(item?.id ?? '').trim().toLowerCase();
    if (!TINT_ID_RE.test(id) || seen.has(id)) continue;
    const name = String(item?.name ?? '').trim().slice(0, 16);
    const filter = String(item?.filter ?? '').trim();
    if (!TINT_FILTER_RE.test(filter)) continue;
    if (!name) continue;
    seen.add(id);
    out.push({ id, name, filter: filter || 'none' });
  }
  if (!out.length) return DEFAULT_TINTS.map((t) => ({ ...t }));
  // 永远给「原色」留一个位置：配置里 tint 为空时要能落回原色。
  if (!seen.has('')) out.unshift({ id: '', name: '原色', filter: 'none' });
  return out;
}

/** pack.json.source 既可能是老的一句话，也可能是 {kind:'github-assets',...}。两种都收。 */
function sourceInfoOf(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const kind = String(raw.kind || '').trim().toLowerCase();
    return {
      kind: ['npm', 'github-assets', 'url', 'bundled', 'local'].includes(kind) ? kind : 'local',
      label: String(raw.label || ''),
      repo: String(raw.repo || ''),
      ref: String(raw.ref || ''),
      tarball: String(raw.tarball || ''),
      assetDir: String(raw.assetDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
      licenseFile: String(raw.licenseFile || ''),
    };
  }
  const text = String(raw ?? '').trim();
  if (/^https?:\/\//i.test(text)) {
    return { kind: 'url', label: text, repo: '', ref: '', tarball: text, assetDir: '', licenseFile: '' };
  }
  return { kind: '', label: text, repo: '', ref: '', tarball: '', assetDir: '', licenseFile: '' };
}

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

function actionNameOf(item) {
  // 上游 big-blue-fish 的 Id 就是动作名（File 去掉 .webm 与 Id 完全一致，已核过 106 条）。
  const id = String(item?.Id ?? item?.id ?? '').trim();
  if (id) return id;
  return String(item?.File ?? item?.file ?? '').trim().replace(/\.webm$/i, '');
}

/**
 * 把 big-blue-fish 的 animations.json 转成我们的清单。
 *   Pool Idle → idle；Click → clicks；Drag → drag；
 *   Pool Event（没有 Festival）→ categories.event；Greeting/Daily 各一个分类；
 *   Pool Disabled 跳过；带 Festival 的只进 festivals 元数据（不进日常动作池）。
 * 迁移字段（MoveKind / Meal / SeasonOnly / NightOnly ...）不丢：原样存进 festivals.json 的 tags。
 */
export function manifestFromAnimations(raw) {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.animations) ? raw.animations : []);
  const idle = [];
  const clicks = [];
  const drag = [];
  const moves = [];
  const events = [];
  const greeting = [];
  const daily = [];
  const festivals = [];
  const tags = [];
  const seen = new Set();
  for (const item of list) {
    const name = actionNameOf(item);
    if (!name) continue;
    const pool = String(item?.Pool ?? item?.pool ?? '').trim();
    if (pool.toLowerCase() === 'disabled') continue;
    const festival = String(item?.Festival ?? '').trim();
    if (festival) {
      festivals.push({
        action: name,
        festival,
        radiusDays: Number(item?.RadiusDays) || 0,
        mode: String(item?.FestivalMode || ''),
        weight: Number(item?.FestivalWeight) || 0,
      });
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    if (pool === 'Idle') idle.push(name);
    else if (pool === 'Click') clicks.push(name);
    else if (pool === 'Drag') drag.push(name);
    else if (pool === 'Greeting') greeting.push(name);
    else if (pool === 'Daily') daily.push(name);
    else if (pool === 'Event') {
      events.push(name);
      const moveKind = String(item?.MoveKind || '');
      if (moveKind) moves.push({ name, params: { kind: moveKind } });
    }
    const extra = {};
    for (const key of ['WorkKind', 'WorkWeight', 'MoveKind', 'HourParity', 'Meal', 'MealBoost', 'SeasonOnly', 'NightOnly', 'MorningWeight', 'SummerWeight', 'WinterWeight']) {
      if (item?.[key] != null && item[key] !== 0 && item[key] !== false) extra[key] = item[key];
    }
    if (Object.keys(extra).length) tags.push({ action: name, ...extra });
  }
  const categories = [];
  if (events.length) categories.push({ id: 'event', weight: 100, actions: events });
  if (greeting.length) categories.push({ id: 'greeting', weight: 100, actions: greeting });
  if (daily.length) categories.push({ id: 'daily', weight: 60, actions: daily });
  const moveNames = new Set(moves.map((m) => m.name));
  return {
    manifest: normalizeManifest({
      idle: idle.length ? idle : events.slice(0, 3),
      turn: idle.length ? idle : events.slice(0, 3),
      drag,
      clicks,
      moves,
      // 已经进了 moves 的动作别再随机抽一次，避免「溜达」和「原地演」打架。
      categories: categories.map((c) => ({ ...c, actions: c.actions.filter((n) => !moveNames.has(n)) })),
      weights: { idle: 10, turn: 5, move: 5, click: 0, drag: 0 },
    }),
    festivals,
    tags,
  };
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
        // 新来源：GitHub release/仓库素材（整包 tgz，只挑一个素材目录）。
        source: sourceInfoOf(p.source),
        tints: Array.isArray(p.tints) ? normalizeTints(p.tints) : null,
      })),
    };
  }

  // 用户手动删掉的「随仓内置包」：记下来，catalog 同步时别再硬塞回去。
  // 否则 remove() 之后下一次 list 又会把它装回来，删除按钮等于没作用。
  const hiddenFile = path.join(root, 'catalog-hidden.json');
  function readHidden() {
    const data = readJson(hiddenFile);
    return Array.isArray(data?.ids) ? data.ids.map((id) => sanitizePackId(id)).filter(Boolean) : [];
  }
  function writeHidden(ids) {
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(hiddenFile, `${JSON.stringify({ ids: [...new Set(ids)] }, null, 2)}\n`, 'utf8');
    } catch (error) {
      pluginLog('[pet-packs] 写 catalog-hidden.json 失败：', String(error?.message ?? error));
    }
  }
  function markHidden(id) {
    const list = readHidden();
    if (!list.includes(id)) writeHidden([...list, id]);
  }
  function clearHidden(id) {
    const list = readHidden();
    if (list.includes(id)) writeHidden(list.filter((x) => x !== id));
  }

  /**
   * 把内置清单里「随仓入库」的包落成 packs/<id>/。
   *
   * 为什么需要：内置 figure 包（sprintkey-fish）只待在 assets/pet-packs/ 下，packs.json 里没有它，
   * activate('sprintkey-fish') 就会报「没有这个皮肤包」——真机上就是这么翻车的。
   * 这里在 list/activate 之前做一次幂等同步：目录不存在或不完整才装，装过就不动。
   */
  let syncing = false;
  function syncCatalog() {
    if (syncing) return false;
    syncing = true;
    let changed = false;
    try {
      const catalog = readCatalog();
      const hidden = new Set(readHidden());
      for (const entry of catalog.packs) {
        if (entry.id === BUILTIN_PACK_ID || !entry.bundled || hidden.has(entry.id)) continue;
        const src = path.join(catalogRoot, entry.bundled);
        if (!isDir(src)) continue;
        const dest = packDirOf(entry.id);
        if (isDir(dest) && readPackMeta(entry.id, dest).installed) continue;
        const staging = `${dest}.sync-${Date.now()}`;
        try {
          fs.rmSync(staging, { recursive: true, force: true });
          copyTree(src, staging);
          // 清单里的名字/许可/authors 是权威的：包里的 pack.json 可能缺字段。
          const cur = readJson(path.join(staging, PACK_FILE)) || {};
          const merged = {
            ...cur,
            id: entry.id,
            name: cur.name || entry.name,
            version: cur.version || entry.version,
            kind: entry.kind,
            author: cur.author || entry.author,
            license: cur.license || entry.license,
            source: cur.source || '内置清单',
            tints: normalizeTints(cur.tints || entry.tints),
          };
          fs.writeFileSync(path.join(staging, PACK_FILE), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
          const result = commitFromStaging(staging, { id: entry.id, overwrite: true });
          if (result.ok) {
            changed = true;
            // 同步进来的内置包也登记一下，packs.json 里能查到「装过什么」。
            try { publish(entry.id); } catch (error) {
              pluginLog('[pet-packs] 登记同步皮肤包失败：', entry.id, String(error?.message ?? error));
            }
            pluginLog('[pet-packs] 已同步内置皮肤包：', entry.id, entry.kind);
          }
        } catch (error) {
          pluginLog('[pet-packs] 同步内置皮肤包失败：', entry.id, String(error?.message ?? error));
        } finally {
          try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
        }
      }
    } finally {
      syncing = false;
    }
    return changed;
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
      tints: normalizeTints(marker?.tints),
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
    const sourceInfo = sourceInfoOf(meta.source);
    return {
      id: sanitizePackId(meta.id || id),
      name: String(meta.name || id),
      kind,
      version: String(meta.version || ''),
      author: String(meta.author || ''),
      license: String(meta.license || ''),
      source: sourceInfo.label || sourceInfo.kind || '',
      sourceInfo,
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
      tints: normalizeTints(meta.tints),
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
    // 内置随仓包先落盘，再列：否则 UI 只能看到「清单里有」，右键切不过去。
    try { syncCatalog(); } catch (error) {
      pluginLog('[pet-packs] 内置皮肤包同步失败：', String(error?.message ?? error));
    }
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
        sourceInfo: meta.sourceInfo,
        createdAt: meta.createdAt,
        builtin: false,
        installed: meta.installed,
        webmCount: meta.webmCount,
        bytes: meta.bytes,
        dir: meta.dir,
        entry: meta.entry,
        preview: meta.preview,
        tints: meta.tints,
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
        sourceInfo: c.source,
        createdAt: '',
        builtin: c.id === BUILTIN_PACK_ID,
        installed: false,
        webmCount: 0,
        bytes: 0,
        dir: '',
        entry: '',
        preview: '',
        tints: c.tints || normalizeTints(null),
        updatedAt: '',
        error: '',
        catalog: true,
        description: c.description,
        npm: c.npm,
        bundled: c.bundled,
        npmSpec: c.npm,
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
    try { syncCatalog(); } catch {}
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
        tints: meta.tints,
        sourceInfo: sourceInfoOf('builtin'),
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
        tints: meta.tints,
        sourceInfo: sourceInfoOf('builtin'),
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
      tints: meta.tints,
      sourceInfo: meta.sourceInfo,
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
        // source 可能是 {kind:'github-assets',...} 对象，别拍平成 "[object Object]"。
        source: meta.source ?? '本地导入',
        createdAt: new Date().toISOString(),
        entry: entryRel,
        tints: normalizeTints(meta.tints),
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
        source: meta.source ?? '本地导入',
        createdAt: new Date().toISOString(),
        webm: String(meta.webm || 'webm'),
        tints: normalizeTints(meta.tints),
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

  /**
   * 从 GitHub 仓库的 tarball 里挑一个素材目录装成 webm 包。
   * 现在只服务 big-blue-fish：`code/BigBlueFish.Windows/assets/fish/` 下有 106 个 webm + animations.json。
   * 整包 64MB，但只挑素材目录，落地后大约 20MB。
   */
  function installFromGithubTgz(buf, entry, { overwrite = false, onProgress } = {}) {
    if (typeof readTar !== 'function') return { ok: false, error: '当前版本缺少 tar 解析器' };
    const info = entry?.source && typeof entry.source === 'object' ? sourceInfoOf(entry.source) : sourceInfoOf('');
    const assetDir = info.assetDir || 'code/BigBlueFish.Windows/assets/fish';
    let entries = [];
    try {
      onProgress?.({ phase: 'extract', percent: 0 });
      entries = stripTopDir(readTar(zlib.gunzipSync(buf), (n) => !n.endsWith('/')));
    } catch (error) {
      return { ok: false, error: `压缩包解不开：${String(error?.message ?? error)}` };
    }
    const packId = sanitizePackId(entry.id);
    const staging = `${packDirOf(packId)}.gh-${Date.now()}`;
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(path.join(staging, 'webm'), { recursive: true });
      let animationsText = '';
      let licenseText = '';
      let webmCount = 0;
      for (const file of entries) {
        const rel = String(file.name || '').replace(/^\.\//, '').replace(/\\/g, '/');
        if (!rel.startsWith(`${assetDir}/`)) continue;
        const base = path.posix.basename(rel);
        const lower = base.toLowerCase();
        if (lower.endsWith('.webm')) {
          fs.writeFileSync(path.join(staging, 'webm', base), file.data);
          webmCount += 1;
          continue;
        }
        if (lower === 'animations.json') {
          animationsText = file.data.toString('utf8');
          fs.writeFileSync(path.join(staging, 'animations.json'), file.data);
          continue;
        }
        if (lower === 'license.txt' || lower === 'license') {
          licenseText = file.data.toString('utf8');
          fs.mkdirSync(path.join(staging, 'LICENSES'), { recursive: true });
          fs.writeFileSync(path.join(staging, 'LICENSES', 'big-blue-fish-LICENSE.txt'), file.data);
          fs.writeFileSync(path.join(staging, 'LICENSE'), file.data);
          continue;
        }
      }
      if (!webmCount) return { ok: false, error: `素材目录里没有 webm：${assetDir}` };
      let manifest = null;
      let festivals = [];
      let tags = [];
      if (animationsText.trim()) {
        try {
          const parsed = manifestFromAnimations(JSON.parse(animationsText));
          manifest = parsed.manifest;
          festivals = parsed.festivals;
          tags = parsed.tags;
        } catch (error) {
          return { ok: false, error: `animations.json 解析失败：${String(error?.message ?? error)}` };
        }
        if (manifest) fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(staging, 'festivals.json'), `${JSON.stringify({ festivals, tags }, null, 2)}\n`, 'utf8');
      }
      if (!manifest) {
        // 没动画清单就按文件名兜底（至少能待机），跟本地导入一个待遇。
        manifest = normalizeManifest({ idle: fs.readdirSync(path.join(staging, 'webm')).map((n) => path.basename(n, '.webm')) });
        fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      }
      fs.writeFileSync(path.join(staging, PACK_FILE), `${JSON.stringify({
        id: packId,
        name: String(entry.name || packId),
        version: String(entry.version || '1.0.0'),
        kind: 'webm',
        webm: 'webm',
        author: String(entry.author || ''),
        license: String(entry.license || 'MIT'),
        description: String(entry.description || ''),
        source: { ...info },
        tints: normalizeTints(entry.tints),
      }, null, 2)}\n`, 'utf8');
      onProgress?.({ phase: 'commit', percent: 90 });
      const result = commitFromStaging(staging, { id: packId, overwrite });
      if (result.ok && licenseText) pluginLog('[pet-packs] 已落地许可：', 'LICENSES/big-blue-fish-LICENSE.txt');
      return result;
    } catch (error) {
      pluginLog('[pet-packs] 从 GitHub 素材安装失败：', String(error?.message ?? error));
      return { ok: false, error: `安装失败：${String(error?.message ?? error)}` };
    } finally {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    }
  }

  /** 切换生效包（webm 和 figure 都行；figure 只要入口在就能切）。 */
  function activate(id) {
    try { syncCatalog(); } catch {}
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
      // 删的是「清单里随仓入库」的包：记下来，别让 syncCatalog 下次又装回来。
      const inCatalog = readCatalog().packs.some((c) => c.id === packId && c.bundled);
      if (inCatalog) markHidden(packId);
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
        sourceInfo: meta.sourceInfo,
        tints: meta.tints,
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

  /** 从内置清单装：npm 包、随仓目录、GitHub 素材目录、普通 URL 压缩包。 */
  async function installFromCatalog(id, { overwrite = false, onProgress } = {}) {
    const wantId = sanitizePackId(id);
    const entry = readCatalog().packs.find((c) => c.id === wantId);
    if (!entry) return { ok: false, error: `内置清单里没有这个皮肤包：${id}` };

    // 幂等：随仓包在 list/activate 时已经被 syncCatalog 落过盘了，再点「下载」不该报「已存在」。
    if (entry.bundled && !overwrite) {
      const dest = entry.id === BUILTIN_PACK_ID ? builtin : packDirOf(entry.id);
      if (isDir(dest)) {
        const summary = entry.id === BUILTIN_PACK_ID ? builtinSummary() : readPackMeta(entry.id, dest);
        if (summary.installed) {
          clearHidden(entry.id);
          const published = publish(entry.id);
          const base = { ok: true, already: true, id: entry.id };
          return published.ok ? { ...base, ...published } : { ...base, ...listPacks() };
        }
      }
    }

    let result = null;
    if (entry.bundled) {
      const src = path.join(catalogRoot, entry.bundled);
      if (!isDir(src)) return { ok: false, error: `随包内置的皮肤目录不存在：${src}` };
      result = installFromDir(src, { id: entry.id, name: entry.name, overwrite });
    } else if (entry.npm) {
      if (typeof helpers.installFromNpm !== 'function') return { ok: false, error: '当前版本不支持从 npm 安装皮肤包' };
      result = await helpers.installFromNpm(entry.npm, { onProgress, overwrite });
    } else if (entry.source?.kind === 'github-assets') {
      if (typeof helpers.downloadTo !== 'function') return { ok: false, error: '当前版本缺少下载器' };
      try {
        const url = entry.source.tarball || entry.url;
        if (!url) return { ok: false, error: `${entry.id} 的清单缺少 tarball 地址` };
        const buf = await helpers.downloadTo(url, onProgress);
        if (buf.length > MAX_IMPORT_BYTES) return { ok: false, error: '下载的包太大（上限 512MB）' };
        result = installFromGithubTgz(buf, entry, { overwrite, onProgress });
      } catch (error) {
        result = { ok: false, error: `下载失败：${String(error?.message ?? error)}` };
      }
    } else if (entry.url) {
      if (typeof helpers.downloadTo !== 'function') return { ok: false, error: '当前版本缺少下载器' };
      try {
        const buf = await helpers.downloadTo(entry.url, onProgress);
        result = installFromTgz(buf, { id: entry.id, name: entry.name, overwrite });
      } catch (error) {
        result = { ok: false, error: `下载失败：${String(error?.message ?? error)}` };
      }
    } else {
      return { ok: false, error: `清单里的 ${entry.id} 没有可安装来源（npm / bundled / url / github-assets）` };
    }
    if (result?.ok) {
      // 装完立刻登记，packs.json 里就有记录了（dsh-pet 装的是内置目录）。
      clearHidden(entry.id);
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
      if (action === 'opendir') {
        // 设置页「打开皮肤目录」：用户想自己往里丢文件夹/看装到哪了。
        try {
          fs.mkdirSync(packsDir, { recursive: true });
          const child = spawn('explorer.exe', [packsDir], { detached: true, stdio: 'ignore' });
          child.unref();
          return { ok: true, dir: packsDir };
        } catch (error) {
          return { ok: false, dir: packsDir, error: `打开目录失败：${String(error?.message ?? error)}` };
        }
      }
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
    syncCatalog,
    installFromDir,
    installFromTgz,
    installFromGithubTgz,
    installFromCatalog,
    activate,
    remove,
    queuePreview,
    manifestOfDir,
    handleAction,
  };
}
