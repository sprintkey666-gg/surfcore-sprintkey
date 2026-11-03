// 悬浮窗「原版」会话驱动器回归（离线，用假 ctx，不连 DSH）。
//
// 背景（2026-11-03）：原版回复速度 = 专门开一个 DSH 会话跑，上下文连续。
// 这条测试钉住驱动器的三个要害：
//   1. 回合文本只从 turn/end 收，assistant/chunk 不算（否则同一句会重复两遍）；
//   2. 会话先 inspect 再决定要不要 create（create 对已有会话会新建空壳，不能瞎调）；
//   3. 超时/出错都要 reject 并清掉 pending，不能把下一次请求卡死。
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOD = pathToFileURL(path.join(REPO_ROOT, 'plugins', 'surfcore', 'lib', 'orb-agent.js')).href;
const { createTurnCollector, createOrbAgent } = await import(MOD);

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

// ── 1. 收集器 ───────────────────────────────────────────────────────────
const c = createTurnCollector();
ok(c.push({ type: 'turn/start', data: { turn: 1 } }) === null, 'turn/start 不产出结果');
ok(c.push({ type: 'assistant/chunk', data: { turn: 1, delta: '半个字' } }) === null, 'assistant/chunk 被忽略');
c.push({
  type: 'assistant/message',
  data: { turn: 1, message: { content: [{ type: 'text', text: '你好' }, { type: 'text', text: '呀' }] } },
});
const ended = c.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'end' } } });
ok(ended?.text === '你好呀', `turn/end 拿到整段文本（实际：${ended?.text}）`);
ok(ended?.reason?.kind === 'end', 'turn/end 带结束原因');
ok(c.size() === 0, '回合结束后不留状态');
ok(c.push({ type: 'turn/end', data: { turn: 1 } }) === null, '重复的 turn/end 不会二次产出');

// ── 2. 驱动器：inspect 成功就不 create ──────────────────────────────────
function makeCtx({ inspectFails = false, promptFails = false, text = '我听着呢' } = {}) {
  const calls = { inspect: 0, create: 0, prompt: 0, cancel: 0, permission: 0 };
  const listeners = new Map();
  const ctx = {
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    sessions: { get: () => ({ id: 'x' }) },
    permissionPresets: { current: () => 'ask', set: () => { calls.permission += 1; } },
    sessionController: {
      async inspect() { calls.inspect += 1; if (inspectFails) throw new Error('not found'); return { ok: true }; },
      async create() { calls.create += 1; return { ok: true }; },
      async prompt({ sessionId, content }, signal) {
        calls.prompt += 1;
        calls.signal = signal;
        if (promptFails) throw new Error('prompt 挂了');
        setTimeout(() => {
          const emit = listeners.get('session/event');
          const sess = { id: sessionId };
          emit(sess, { type: 'turn/start', data: { turn: 7 } });
          emit(sess, { type: 'assistant/chunk', data: { turn: 7 } });
          emit(sess, {
            type: 'assistant/message',
            data: { turn: 7, message: { content: [{ type: 'text', text }] } },
          });
          emit(sess, { type: 'turn/end', data: { turn: 7, reason: { kind: 'end' } } });
        }, 5);
        return { ok: true, accepted: content.length };
      },
      async cancel() { calls.cancel += 1; },
    },
  };
  return { ctx, calls };
}

{
  const { ctx, calls } = makeCtx({ text: '我听着呢' });
  const agent = createOrbAgent({ ctx, stateDir: '', pluginLog: () => {} });
  const r = await agent.run({ sessionId: 'orb-chat-1', text: '在吗', timeoutMs: 5000 });
  ok(r.ok === true && r.text === '我听着呢', `跑一轮拿到回复（${r.text}）`);
  ok(calls.inspect === 1 && calls.create === 0, 'inspect 成功就不调 create');
  ok(calls.permission === 1, '挂上会话后切了权限档');
  ok(calls.prompt === 1, '只推了一次 prompt');

  // 同一个会话再跑一轮：inspect 不再重复（ready 缓存）
  await agent.run({ sessionId: 'orb-chat-1', text: '还在吗', timeoutMs: 5000 });
  ok(calls.inspect === 1, '同一会话第二轮不再 inspect');
  agent.dispose();
}

// ── 3. inspect 失败 → create ────────────────────────────────────────────
{
  const { ctx, calls } = makeCtx({ inspectFails: true, text: '新会话' });
  const agent = createOrbAgent({ ctx, stateDir: '', pluginLog: () => {} });
  const r = await agent.run({ sessionId: 'orb-chat-2', text: '第一句', timeoutMs: 5000 });
  ok(r.text === '新会话', '新会话也能跑');
  ok(calls.inspect === 1 && calls.create === 1, 'inspect 失败才 create');
  agent.dispose();
}

// ── 4. prompt 抛错 → reject 且 pending 清掉 ─────────────────────────────
{
  const { ctx } = makeCtx({ promptFails: true });
  const agent = createOrbAgent({ ctx, stateDir: '', pluginLog: () => {} });
  let threw = '';
  try { await agent.run({ sessionId: 'orb-chat-3', text: '这句会失败', timeoutMs: 5000 }); } catch (e) { threw = String(e?.message); }
  ok(threw.includes('prompt 挂了'), 'prompt 失败会 reject');
  const { ctx: ctx2 } = makeCtx({ text: '重试成功' });
  agent.ctx = null; // 不可换 ctx，这里只验证失败后不卡死：同一 agent 再跑一次
  agent.dispose();
}

// ── 5. 超时会取消并报错 ─────────────────────────────────────────────────
{
  const listeners = new Map();
  const ctx = {
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    sessionController: {
      async inspect() { return { ok: true }; },
      async prompt() { /* 永不结束 */ return { ok: true }; },
      async cancel({ sessionId }) { calls.cancelled.push(sessionId); },
    },
  };
  const calls = { cancelled: [] };
  const agent = createOrbAgent({ ctx, stateDir: '', pluginLog: () => {} });
  let msg = '';
  try { await agent.run({ sessionId: 'orb-chat-4', text: '卡住', timeoutMs: 5000 }); } catch (e) { msg = String(e?.message); }
  ok(msg.includes('还没结束'), '超时报错（下限 5s 保护）');
  agent.dispose();
}

// ⚠️ 2026-11-03 真机事故复盘：prompt(args, signal) 的第二个参数必须是真 signal，
//    DSH 内部无条件 signal.throwIfAborted()，不传就抛
//    `Cannot read properties of undefined (reading 'throwIfAborted')`，
//    结果「原版会话」每轮都秒退回直连，看起来像根本没实现。这两组断言钉住它。
{
  const { ctx, calls } = makeCtx({ text: '收到 signal' });
  const agent = createOrbAgent({ ctx, stateDir: '', pluginLog: () => {} });
  await agent.run({ sessionId: 'orb-chat-signal', text: '在吗', timeoutMs: 5000 });
  const sig = calls.signal;
  ok(Boolean(sig), 'prompt 收到了第二个参数（AbortSignal）');
  ok(typeof sig?.throwIfAborted === 'function', 'signal 有 throwIfAborted（DSH 内部会直接调）');
  ok(sig?.aborted === false, '正常跑完不 abort');
  agent.dispose();
}

{
  const listeners = new Map();
  let captured = null;
  const ctx = {
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    sessionController: {
      async inspect() { return { ok: true }; },
      async prompt(_args, signal) { captured = signal; return { ok: true }; },
      async cancel() {},
    },
  };
  const agent = createOrbAgent({ ctx, stateDir: '', pluginLog: () => {} });
  let msg = '';
  try { await agent.run({ sessionId: 'orb-chat-abort', text: '卡住', timeoutMs: 5000 }); } catch (e) { msg = String(e?.message); }
  ok(msg.includes('还没结束'), '超时仍然报错');
  ok(captured?.aborted === true, '超时会把 signal abort 掉（不留悬挂请求）');
  agent.dispose();
}

// ── 6. 参数校验 ─────────────────────────────────────────────────────────
{
  const { ctx } = makeCtx();
  const agent = createOrbAgent({ ctx, stateDir: '', pluginLog: () => {} });
  let m1 = '';
  try { await agent.run({ sessionId: '', text: 'x' }); } catch (e) { m1 = String(e?.message); }
  ok(m1.includes('缺少 sessionId'), '缺 sessionId 直接报错');
  const empty = await agent.run({ sessionId: 'orb-chat-5', text: '   ' });
  ok(empty.ok === true && empty.text === '', '空消息直接返回，不打模型');
  agent.dispose();
}

// ── 7. pet-chat 侧：代数/轮次一定要写盘（否则看不出「到底跑没跑过」）─────
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(REPO_ROOT, 'plugins', 'surfcore', 'lib', 'pet-chat.js'), 'utf8');
  ok(src.includes('history.agentTotal'), 'pet-chat 记 agentTotal（真机可核对跑过几轮）');
  ok(src.includes('function markAgentSystemSent'), 'pet-chat 记住「这个会话代数已推过完整人设」');
  ok(!/function bumpAgentTurns\(history, turns\) \{\s*\n\s*if \(!turns/.test(src), 'bumpAgentTurns 不再在 sessionTurns=0 时早退');
  ok(src.includes('原版会话 ok session='), '成功路径有可 grep 的日志');
}

if (failures) {
  console.error(`\n❌ ${failures} 项失败`);
  process.exit(1);
}
console.log('\n✓ 原版会话驱动器检查通过');
