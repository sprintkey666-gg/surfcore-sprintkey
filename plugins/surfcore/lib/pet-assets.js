// 桌宠素材：把 dsh-pet 的动画（VP9-alpha webm + 动画清单）按需下到本机。
//
// 为什么不把素材塞进插件：106 个 webm 一共 52MB，进 git 会把仓库撑爆，而且改了素材还要
// 跟着发版。素材是 MIT 的（见 dsh-pet 的 LICENSE），我们只取「动画 + 清单」，不装它的宿主
// 逻辑——聊天、人设、记忆、看屏幕仍然走 SurfCore 自己那套。
//
// 目录布局（都在 <stateDir>/orb/pet 下）：
//   webm/<动画名>.webm   读动画清单时直接用名字拼，中文名就是文件名
//   config.jsonc         上游原始清单（保留下来方便对照，渲染端不解析它）
//   manifest.json        我们挑出来的纯 JSON（渲染端只读这个）
//   LICENSE-pet.txt      MIT 许可原文（合规）
//   .surfcore-pet.json   版本/数量/字节数，状态和「要不要重装」都看它

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const PET_PKG = 'dsh-pet';
export const PET_VERSION = '0.3.8';
export const PET_MARKER = '.surfcore-pet.json';

// 先从国内镜像试，失败再回 npm 官方。两个都是同一份 tarball。
const MIRRORS = [
  (v) => `https://registry.npmmirror.com/${PET_PKG}/-/${PET_PKG}-${v}.tgz`,
  (v) => `https://registry.npmjs.org/${PET_PKG}/-/${PET_PKG}-${v}.tgz`,
];

const WANT_PREFIX = 'assets/webm/';
const KEEP_FILES = new Set(['assets/config.jsonc', 'LICENSE']);

/** 去掉 JSONC 的注释（行注释、块注释），字符串里的不算。 */
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  const s = String(text ?? '');
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === '"') {
      // 整段字符串原样搬过去，注意转义
      let j = i + 1;
      out += ch;
      while (j < s.length) {
        if (s[j] === '\\') { out += s[j] + (s[j + 1] ?? ''); j += 2; continue; }
        out += s[j];
        if (s[j] === '"') { j += 1; break; }
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // 去掉可能残留的行尾逗号（`,\n}` / `,]`），JSON.parse 不认
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** 解析 tar（ustar；顺带认 GNU longname/pax path），返回 [{name, data}]。 */
export function readTar(buf, filter = () => true) {
  const out = [];
  const cstr = (b, start, len) => {
    const slice = b.slice(start, start + len);
    const zero = slice.indexOf(0);
    return slice.slice(0, zero === -1 ? slice.length : zero).toString('utf8');
  };
  let off = 0;
  let pending = ''; // 上一条 pax/GNU longname 给的路径
  while (off + 512 <= buf.length) {
    const header = buf.slice(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(cstr(header, 124, 12).trim(), 8) || 0;
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const name = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    // 下一条头在数据之后按 512 对齐；注意别把 size 加两遍。
    const next = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === 'x') {
      // pax：每条记录 "<总长> <键>=<值>\n"
      const text = buf.slice(dataStart, dataEnd).toString('utf8');
      for (const rec of text.split('\n')) {
        const sp = rec.indexOf(' ');
        if (sp <= 0) continue;
        const eq = rec.indexOf('=');
        if (eq > sp && rec.slice(sp + 1, eq) === 'path') pending = rec.slice(eq + 1);
      }
      off = next;
      continue;
    }
    if (typeflag === 'L') {
      pending = buf.slice(dataStart, dataEnd).toString('utf8').replace(/\0+$/, '');
      off = next;
      continue;
    }
    const full = pending || (prefix ? `${prefix}/${name}` : name);
    pending = '';
    if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      if (filter(full)) out.push({ name: full, data: buf.slice(dataStart, dataEnd) });
    }
    off = next;
  }
  return out;
}

/** 从上游 config.jsonc 里挑出渲染端要用的东西，产出纯 JSON。 */
export function buildManifest(configText) {
  const raw = JSON.parse(stripJsonc(configText));
  const anim = raw.animations || {};
  const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const weights = raw.animationWeights || {};
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    version: 1,
    idle: asList(anim.idle),
    turn: asList(anim.turn),
    drag: asList(anim.drag),
    clicks: asList(anim.clicks),
    moves: Array.isArray(anim.moves?.actions)
      ? anim.moves.actions.map((a) => (typeof a === 'string' ? { name: a } : { name: a?.name, params: a?.params || {} })).filter((a) => a.name)
      : [],
    categories: Array.isArray(anim.categories)
      ? anim.categories.map((c) => ({
        id: String(c?.id ?? ''),
        weight: num(c?.weight, 0),
        noMirror: c?.noMirror === true,
        actions: asList(c?.actions),
      })).filter((c) => c.actions.length)
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

async function downloadTo(url, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let got = 0;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      got += value.length;
      onProgress?.({ downloaded: got, total, percent: total ? Math.round((got / total) * 100) : 0 });
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    chunks.push(buf);
    got = buf.length;
    onProgress?.({ downloaded: got, total: got, percent: 100 });
  }
  return Buffer.concat(chunks);
}

export function createPetAssetsService({ stateDir, pluginLog = () => {} }) {
  const dir = path.join(stateDir, 'orb', 'pet');
  const webmDir = path.join(dir, 'webm');
  const manifestFile = path.join(dir, 'manifest.json');
  const markerFile = path.join(dir, PET_MARKER);
  let job = null; // {phase, percent, error, startedAt}

  function readMarker() {
    try {
      const data = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      return data && typeof data === 'object' ? data : null;
    } catch { return null; }
  }

  function countWebm() {
    try {
      return fs.readdirSync(webmDir).filter((n) => n.toLowerCase().endsWith('.webm')).length;
    } catch { return 0; }
  }

  function status() {
    const marker = readMarker();
    const webmCount = countWebm();
    const installed = Boolean(marker) && webmCount > 0;
    return {
      installed,
      version: marker?.version || '',
      webmCount,
      bytes: Number(marker?.bytes) || 0,
      dir,
      updatedAt: marker?.installedAt || '',
      job: job ? { ...job } : null,
      upgradable: Boolean(marker?.version) && marker.version !== PET_VERSION,
    };
  }

  function manifest() {
    try {
      const data = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      return data && typeof data === 'object' ? data : null;
    } catch { return null; }
  }

  async function install({ onProgress } = {}) {
    if (job && job.phase !== 'done' && job.phase !== 'error') {
      return { ok: false, error: '正在下载，稍等', status: status() };
    }
    job = { phase: 'download', percent: 0, error: '', startedAt: new Date().toISOString() };
    const report = (p) => {
      job = { ...job, ...p };
      onProgress?.(p);
    };
    try {
      // 空间不够就别下，免得下到一半留下半套文件。
      try {
        const st = fs.statfsSync(dir);
        const free = Number(st.bavail) * Number(st.bsize);
        if (Number.isFinite(free) && free > 0 && free < 200 * 1024 * 1024) {
          throw new Error(`磁盘只剩 ${Math.round(free / 1024 / 1024)}MB，至少需要 200MB`);
        }
      } catch (error) {
        if (String(error?.message || '').includes('磁盘只剩')) throw error;
      }
      fs.mkdirSync(dir, { recursive: true });
      let tgz = null;
      let lastError = null;
      // 本机已经有离线包就直接用：npm 在国内经常连不上，而插件进程又不走系统代理，
      // 主人在终端里 curl 下来的 tar 包放这儿就能装（省得卡在 download 进度上）。
      const localTgz = path.join(dir, `dsh-pet-${FETCH_VERSION}.tgz`);
      try {
        const st = fs.statSync(localTgz);
        if (st.size > 1024 * 1024) {
          pluginLog('[orb] 用本地离线包安装桌宠素材：', localTgz);
          tgz = fs.readFileSync(localTgz);
          report({ phase: 'download', percent: 100, downloaded: st.size, total: st.size });
        }
      } catch {}
      for (const url of (tgz ? [] : MIRRORS)) {
        try {
          pluginLog('[orb] 下载桌宠素材：', url(FETCH_VERSION));
          tgz = await downloadTo(url(FETCH_VERSION), (p) => report({ phase: 'download', percent: p.percent, downloaded: p.downloaded, total: p.total }));
          if (tgz?.length) break;
        } catch (error) {
          lastError = error;
          pluginLog('[orb] 镜像失败：', String(error?.message ?? error));
        }
      }
      if (!tgz?.length) throw lastError || new Error('两个镜像都没下下来');

      report({ phase: 'extract', percent: 0 });
      const files = readTar(zlib.gunzipSync(tgz), (name) => {
        const rel = name.replace(/^package\//, '');
        return rel.startsWith(WANT_PREFIX) || KEEP_FILES.has(rel);
      });
      if (!files.length) throw new Error('压缩包里没找到动画素材（上游改了目录结构？）');

      fs.mkdirSync(webmDir, { recursive: true });
      let bytes = 0;
      let webmCount = 0;
      let configText = '';
      let licenseText = '';
      for (const file of files) {
        const rel = file.name.replace(/^package\//, '');
        bytes += file.data.length;
        if (rel.startsWith(WANT_PREFIX)) {
          const base = path.basename(rel);
          if (!base.toLowerCase().endsWith('.webm')) continue;
          fs.writeFileSync(path.join(webmDir, base), file.data);
          webmCount += 1;
        } else if (rel === 'assets/config.jsonc') {
          configText = file.data.toString('utf8');
        } else if (rel === 'LICENSE') {
          licenseText = file.data.toString('utf8');
        }
      }
      if (!configText) throw new Error('压缩包里没有 assets/config.jsonc');
      let built;
      try {
        built = buildManifest(configText);
      } catch (error) {
        throw new Error(`动画清单解析失败：${String(error?.message ?? error)}`);
      }
      fs.writeFileSync(path.join(dir, 'config.jsonc'), configText, 'utf8');
      fs.writeFileSync(manifestFile, `${JSON.stringify(built, null, 2)}\n`, 'utf8');
      if (licenseText) {
        fs.writeFileSync(
          path.join(dir, 'LICENSE-pet.txt'),
          `${licenseText.trim()}\n\n---\n素材来自 npm 包 ${PET_PKG}@${FETCH_VERSION}（github.com/PC2005-cloud/dsh-pet），MIT License。\nSurfCore 只取动画素材与动画清单，聊天气泡/会话/人设为本插件自有实现。\n`,
          'utf8',
        );
      }
      const marker = {
        version: FETCH_VERSION,
        webmCount,
        bytes,
        installedAt: new Date().toISOString(),
        source: `${PET_PKG}@${FETCH_VERSION}`,
      };
      fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
      job = { ...job, phase: 'done', percent: 100, error: '' };
      pluginLog('[orb] 桌宠素材就绪：', `${webmCount} 个动画 / ${Math.round(bytes / 1024 / 1024)}MB`);
      return { ok: true, ...status() };
    } catch (error) {
      const message = String(error?.message ?? error);
      job = { ...job, phase: 'error', error: message };
      pluginLog('[orb] 装桌宠素材失败：', message);
      return { ok: false, error: message, status: status() };
    }
  }

  function remove() {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      job = null;
      return { ok: true, ...status() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), status: status() };
    }
  }

  return { dir, webmDir, manifestFile, markerFile, status, manifest, install, remove, version: PET_VERSION };
}

// 下载时用当前版本（抽成常量，install 里两处引用保持一致）
const FETCH_VERSION = PET_VERSION;
