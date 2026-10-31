/**
 * 语音配置体检：角色名校验 + 服务端口探测（纯读，不发请求）。
 *
 * 背景（2026-10-27）：用户配了 `tts.character = "loli12-gsv"`（这是**音色 id**，不是角色名），
 * 合成直接 503「没有配 [voice.characters] 映射」；另外本地音色依赖 GPT-SoVITS 的 9880，
 * 很多人只起了 voxd（8765）就以为装好了，结果发语音全失败、还以为插件坏了。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 解析 config.toml 里 [voice.characters] 的键（只认最简单的 `key = "value"` 行）。 */
export function parseCharacters(tomlText = '') {
  const lines = String(tomlText).split(/\r?\n/);
  const out = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inSection = /^\[voice\.characters\]$/.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*=/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** 从已安装的语音包里收集可用角色名。读不到就当空（不阻塞保存）。 */
export function readPackCharacters(packsDir) {
  const found = new Set();
  const sources = [];
  for (const id of ['voice-local', 'voice-cloud']) {
    const file = path.join(packsDir, id, 'config.toml');
    try {
      const chars = parseCharacters(fs.readFileSync(file, 'utf8'));
      for (const c of chars) found.add(c);
      sources.push({ id, file, characters: chars });
    } catch {}
  }
  return { characters: [...found], sources };
}

/**
 * 校验角色名。
 * @returns {{ok: boolean, reason?: string, characters: string[]}}
 */
export function validateCharacter(character, characters) {
  const name = String(character ?? '').trim();
  const list = Array.isArray(characters) ? characters : [];
  if (!name) return { ok: true, characters: list };
  if (!list.length) return { ok: true, characters: list }; // 没装包时别拦，交给运行时
  if (list.includes(name)) return { ok: true, characters: list };
  // 常见误填：把音色 id 当角色名（loli12-gsv / age12-cloud / huayan 都是 voice id）
  const looksLikeVoiceId = /-(gsv|cloud)$|^huayan$/i.test(name);
  return {
    ok: false,
    reason: looksLikeVoiceId
      ? `「${name}」是音色 id，不是角色名；这里要填 [voice.characters] 里的名字（如 ${list[0]}）`
      : `角色「${name}」不存在；可用角色：${list.join('、')}`,
    characters: list,
  };
}

/** 语音链路要用到的三个端口（只报数字，不探测；探测由调用方做）。 */
export const VOICE_PORTS = [
  { key: 'voxd', port: 8765, label: '语音入口（voxd）' },
  { key: 'gsv', port: 9880, label: '本地推理（GPT-SoVITS）' },
  { key: 'cloud', port: 8767, label: '云端语音包' },
];
