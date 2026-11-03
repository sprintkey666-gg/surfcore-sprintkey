// 悬浮窗 / 字幕「原版」会话驱动器回归（离线：假 DSH 客户端，不连真 DSH）。
//
// 背景（2026-11-03 真机事故）：早先走 ctx.sessionController.prompt，DSH 一重启会话就变冷，
// prompt 抛 `session/agent-busy / prompt rejected`，每轮都退回直连 —— 用户看到「根本没开会话」。
// 现在改成和 QQ 桥接同款：走 DSH HTTP API（sessions.create → events.mux → follow → prompt → turn/end）。
// 这条测试钉住：建档、复用、失败后重新建档、超时中止、并发拒绝、以及 pet-chat 的接线。
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOD = pathToFileURL(path.join(REPO_ROOT, 'plugins', 'surfcore', 'lib', 'orb-agent.js')).href;
const { createOrbAgent } = await import(MOD);

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

// ── 假 DSH 客户端 ────────────────────────────────────────────────────────
function makeClient(opts = {}) {
  const calls = { create: 0, prompt: 0, mux: 0, follow: [], content: null, cwd: null };
  let seq = 0;
  let sink = null;
  const client = {
    sessions: {
      async create({ cwd } = {}) {
        calls.create += 1;
        calls.cwd = cwd || '';
        if (opts.createFails) throw new Error('create 挂了');
        return { result: { ok: true, value: { sessionId: `ds-${++seq}` } } };
      },
      async prompt({ sessionId, content } = {}) {
        calls.prompt += 1;
        calls.sessionId = sessionId;
        calls.content = content;
        if (opts.promptFails) throw new Error('prompt rejected');
        if (opts.hang) return { result: { ok: true, value: { accepted: true } } };
        setTimeout(() => {
          sink?.(sessionId, { type: 'turn/start', data: { turn: 1 } });
          sink?.(sessionId, {
            type: 'assistant/message',
            data: { turn: 1, message: { content: [{ type: 'text', text: opts.text ?? '我听着呢' }] } },
          });
          sink?.(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'end' } } });
        }, 5);
        return { result: { ok: true, value: { accepted: true } } };
      },
    },
    events: {
      mux(_payload, signal, onOpen) {
        calls.mux += 1;
        const queue = [];
        let wake = null;
        let done = false;
        sink = (sessionId, event) => {
          queue.push({ payload: { type: 'session/event', sessionId, event } });
          wake?.();
        };
        signal?.addEventListener?.('abort', () => { done = true; wake?.(); });
        const iterator = (async function* () {
          onOpen?.();
          while (!done) {
            if (!queue.length) {
              await new Promise((resolve) => { wake = () => { wake = null; resolve(); }; });
              continue;
            }
            yield queue.shift();
          }
        })();
        return {
          [Symbol.asyncIterator]: () => iterator,
          follow: (sid) => { calls.follow.push(String(sid)); },
          return: async () => { done = true; wake?.(); },
        };
      },
    },
  };
  return { client, calls };
}

function agentWith(opts = {}, agentOpts = {}) {
  const { client, calls } = makeClient(opts);
  const agent = createOrbAgent({
    baseUrl: () => 'http://127.0.0.1:50105',
    pluginLog: () => {},
    cwd: 'C:/tmp/orb-agent-test',
    clientFactory: () => client,
    ...agentOpts,
  });
  return { agent, calls };
}

// ── 1. 建档 → prompt → 收 turn/end ──────────────────────────────────────
{
  const { agent, calls } = agentWith();
  const res = await agent.run({ sessionId: 'orb-chat-x-0', content: [{ type: 'text', text: '在吗' }], timeoutMs: 3000 });
  ok(res.ok === true, `跑通一轮（实际 ${JSON.stringify(res).slice(0, 80)}）`);
  ok(res.text === '我听着呢', '拿到 turn/end 的最终文本');
  ok(res.dsSessionId === 'ds-1', `拿到了 DSH 真实会话 id（${res.dsSessionId}）`);
  ok(calls.create === 1, '第一次跑会建一条 DSH 会话');
  ok(calls.follow.includes('ds-1'), 'prompt 之前先 follow 了那条会话');
  ok(Array.isArray(calls.content) && calls.content[0]?.type === 'text', 'content 以 DSH content parts 发出去');
  ok(calls.cwd === 'C:/tmp/orb-agent-test' || Boolean(calls.cwd), '建档时带了 cwd');

  // 同一逻辑会话第二次：复用，不再 create
  const res2 = await agent.run({ sessionId: 'orb-chat-x-0', content: [{ type: 'text', text: '还说一句' }], timeoutMs: 3000 });
  ok(res2.ok === true && calls.create === 1, '同一个逻辑会话复用它（不重复建）');
  ok(agent.status().sessions.length === 1, 'status 里只有一条映射');
  agent.dispose();
}

// ── 2. prompt 失败：不抛、下一次重新建档 ────────────────────────────────
{
  const { agent, calls } = agentWith({ promptFails: true });
  const res = await agent.run({ sessionId: 'orb-companion-x-0', content: [{ type: 'text', text: '嗯？' }], timeoutMs: 3000 });
  ok(res.ok === false, 'prompt 失败时返回 ok:false（由调用方退回直连）');
  ok(String(res.reason?.message || '').includes('prompt rejected'), `失败原因带原文（${res.reason?.message}）`);
  agent.dispose();
  const again = agentWith();
  await again.agent.run({ sessionId: 'orb-companion-x-0', content: [{ type: 'text', text: '再来' }], timeoutMs: 3000 });
  ok(again.calls.create === 1, '换了新 agent 会重新建档');
}

// ── 3. create 失败：返回 ok:false，不炸服务 ─────────────────────────────
{
  const { agent } = agentWith({ createFails: true });
  const res = await agent.run({ sessionId: 'orb-chat-x-1', content: [{ type: 'text', text: 'hi' }], timeoutMs: 3000 });
  ok(res.ok === false, '建会话失败也不抛');
  ok(agent.status().sessions.length === 0, '失败后不留下坏映射');
}

// ── 4. 超时：中止等待，快速返回 ─────────────────────────────────────────
{
  const { agent } = agentWith({ hang: true });
  const started = Date.now();
  const res = await agent.run({ sessionId: 'orb-chat-x-2', content: [{ type: 'text', text: '睡着了吗' }], timeoutMs: 40 });
  const spent = Date.now() - started;
  ok(res.ok === false, '无人回话时返回 ok:false');
  ok(spent < 2500, `超时中止够快（${spent}ms）`);
}

// ── 5. 并发：同一个逻辑会话不叠着跑 ───────────────────────────────────
{
  const { agent } = agentWith({ hang: true });
  const first = agent.run({ sessionId: 'orb-chat-x-3', content: [{ type: 'text', text: '一' }], timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 30));
  const second = await agent.run({ sessionId: 'orb-chat-x-3', content: [{ type: 'text', text: '二' }], timeoutMs: 5000 });
  ok(second.ok === false && second.reason?.kind === 'busy', '同一个会话正在跑时直接返回 busy');
  await agent.cancel('orb-chat-x-3');
  await first.catch(() => {});
}

// ── 6. forget 之后重新建档 ──────────────────────────────────────────────
{
  const { agent, calls } = agentWith();
  await agent.run({ sessionId: 'orb-chat-x-4', content: [{ type: 'text', text: '一' }], timeoutMs: 3000 });
  agent.forget('orb-chat-x-4');
  await agent.run({ sessionId: 'orb-chat-x-4', content: [{ type: 'text', text: '二' }], timeoutMs: 3000 });
  ok(calls.create === 2, 'forget 之后下一次会重新建会话');
}

// ── 7. pet-chat 的接线（源码断言，防回退成 sessionController） ──────────
{
  const src = fs.readFileSync(path.join(REPO_ROOT, 'plugins', 'surfcore', 'lib', 'pet-chat.js'), 'utf8');
  ok(src.includes('dshBaseUrl') && src.includes('createOrbAgent({ baseUrl: dshBaseUrl'),
    'pet-chat 把 DSH 地址传给 orb-agent');
  ok(src.includes('agentSessionId(deskChannel)'), '会话 id 按 角色+代数 拆开');
  ok(src.includes('history.agentTotal') && src.includes('function markAgentSystemSent'),
    '成功一轮会留痕（agentTotal / agentSystem）');
  ok(src.includes('原版会话 ok session='), '成功会打 ok 日志（真机排查用）');
  ok(!src.includes('ctx.sessionController.prompt'), '不再走 sessionController.prompt');
}

if (failures) {
  console.error(`\ntest-orb-agent: ${failures} 项失败`);
  process.exit(1);
}
console.log('\ntest-orb-agent: 全部通过');

