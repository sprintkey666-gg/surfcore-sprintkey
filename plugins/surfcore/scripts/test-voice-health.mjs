// 语音配置体检的纯逻辑：角色名解析/校验 + 端口清单。
// 背景：用户把音色 id（loli12-gsv）当成角色名填进 tts.character，合成直接 503；
// 以及只起了 voxd(8765)、没起 GPT-SoVITS(9880)，发语音全失败却看不出原因。
import assert from 'node:assert/strict';
import { parseCharacters, readPackCharacters, validateCharacter, VOICE_PORTS } from '../lib/voice-health.js';

// 1) 只认 [voice.characters] 段里的键
{
  const toml = [
    '[voice]',
    'default = "loli12-gsv"',
    '[voice.characters]',
    'xiaoyu = "loli12-gsv"',
    'other = "age12-cloud"',
    '',
    '[limits]',
    'max_chars = 2000',
  ].join('\n');
  assert.deepEqual(parseCharacters(toml), ['xiaoyu', 'other']);
}

// 2) 段外的键不算
{
  const toml = ['[voice]', 'default = "x"', 'xiaoyu = "y"'].join('\n');
  assert.deepEqual(parseCharacters(toml), []);
}

// 3) 合法角色名
assert.equal(validateCharacter('xiaoyu', ['xiaoyu']).ok, true);
// 4) 空值放行（交给默认）
assert.equal(validateCharacter('', ['xiaoyu']).ok, true);
// 5) 没装包时放行（不阻塞保存）
assert.equal(validateCharacter('whoever', []).ok, true);

// 6) 音色 id 要被拦，并提示这是音色不是角色
{
  const v = validateCharacter('loli12-gsv', ['xiaoyu']);
  assert.equal(v.ok, false);
  assert.match(v.reason, /音色 id/);
  assert.deepEqual(v.characters, ['xiaoyu']);
}

// 7) 不存在的角色名要被拦
{
  const v = validateCharacter('nobody', ['xiaoyu']);
  assert.equal(v.ok, false);
  assert.match(v.reason, /可用角色/);
}

// 8) 读真实包目录（本机有就校验；没有则跳过）
{
  const r = readPackCharacters('D:/deepseekwork/voice/packages');
  if (r.characters.length) {
    assert.ok(r.characters.includes('xiaoyu'), `应能读到 xiaoyu，实际：${r.characters.join(',')}`);
  }
}

// 9) 端口清单固定为 8765 / 9880 / 8767
assert.deepEqual(VOICE_PORTS.map((p) => p.port), [8765, 9880, 8767]);

console.log('✅ 语音配置体检通过');
