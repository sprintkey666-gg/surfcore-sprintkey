// 悬浮窗 / 字幕「原版」回复：真的在 DSH 里开一个会话，把一轮 prompt 发进去，收 turn/end 的最终文本。
//
// 为什么不用 ctx.sessionController.prompt（2026-11-03 的真机事故）：
//   DSH 的 sessionController.prompt 只接受「活着」的 Agent。DSH 一重启，磁盘上的会话就是冷的，
//   prompt 会抛 RemoteError('session/agent-busy', 'prompt rejected', { reason: '...' })，
//   于是每一轮都退回直连、history 里永远不出现 agentTurns —— 用户看到的「根本没开会话」。
//   桥接（QQ）那边走的是 DSH 的 HTTP API（sessions.create → events.mux → events.follow → sessions.prompt），
//   冷会话由服务端按需恢复，而且它本来就是「QQ 聊天」那条链路的同款回合。
//   所以这里也走同一条路：和 `src/self-test.js` 一样，create 一条真会话、订阅事件、prompt、等 turn/end。
import { NodeApiClient, unwrap, createTurnCollector } from '../../../src/dsh-client.js';

/**
 * @param {object} options
 * @param {{ current?: () => string }} [options.baseUrl] 当前 DSH 的 HTTP 地址（插件里传 currentDshUrl）
 * @param {(line: string, detail?: string) => void} [options.pluginLog]
 * @param {string} [options.cwd] 新会话的工作目录（默认 ~/.dsh/surfcore/orb-agent）
 */
export function createOrbAgent({ baseUrl = null, pluginLog = () => {}, cwd = '', clientFactory = null } = {}) {
  /** 逻辑会话（orb-chat-<角色>-<代数>）→ DSH 真实 sessionId */
  const sessions = new Map();
  /** 正在跑的轮次：逻辑 id → { controller, timer } */
  const running = new Map();
  let client = null;
  let clientBase = '';

  function log(...parts) {
    try { pluginLog(...parts); } catch { /* ignore */ }
  }

  function resolveBase() {
    const raw = typeof baseUrl === 'function' ? baseUrl() : baseUrl;
    return String(raw || '').replace(/\/+$/, '');
  }

  function api() {
    const base = resolveBase();
    if (!base) throw new Error('还不知道 DSH 地址（webServer 还没起来）');
    if (!client || clientBase !== base) {
      client = typeof clientFactory === 'function' ? clientFactory(base) : new NodeApiClient(base);
      clientBase = base;
    }
    return client;
  }

  function dsSession(logical, create = true) {
    const key = String(logical || 'orb');
    const known = sessions.get(key);
    if (known) return known;
    if (!create) return '';
    return '';
  }

  /**
   * 跑一轮。成功返回 `{ ok:true, text, dsSessionId }`；失败返回 `{ ok:false, reason }`，
   * 由调用方决定退回直连（这里不抛，保证她永远还能回话）。
   */
  async function run({ sessionId, content, timeoutMs = 180_000 } = {}) {
    const key = String(sessionId || 'orb');
    if (running.has(key)) return { ok: false, reason: { kind: 'busy' } };
    const controller = new AbortController();
    const state = { controller };
    running.set(key, state);
    const timer = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, Math.max(500, Number(timeoutMs) || 180_000));
    state.timer = timer;

    let ds = dsSession(key);
    let created = false;
    try {
      const client0 = api();
      if (!ds) {
        const created0 = unwrap(await client0.sessions.create({ cwd: cwd || undefined }), 'session.create');
        ds = String(created0?.sessionId || '');
        if (!ds) throw new Error('session.create 没返回 sessionId');
        sessions.set(key, ds);
        created = true;
        log(`[orb-agent] 新会话 ${key} → ${ds}`);
      }

      const collector = createTurnCollector();
      const stream = client0.events.mux({}, controller.signal, () => {});
      stream.follow(ds);

      let lastText = '';

      const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
      const done = (async () => {
        for await (const envelope of stream) {
          const frame = envelope?.payload;
          if (!frame) continue;
          if (frame.type === 'session/event' && String(frame.sessionId) === ds) {
            const evt = frame.event;
            // 兜底：DSH 有时在 turn/end 之后立刻把这条 follow 流关掉，或干脆只发 assistant/message。
            // 把最后一条完整 assistant 文本记下来，流提前结束时还能用它，不至于白等一轮。
            if (evt?.type === 'assistant/message') {
              const textBlocks = (evt.data?.message?.content || [])
                .filter((part) => part?.type === 'text')
                .map((part) => String(part.text || ''));
              if (textBlocks.length) lastText = textBlocks.join('');
            }
            const ended = collector.push(evt);
            if (ended) return ended;
          }
          if (frame.type === 'stream/error') throw new Error(`事件流错误: ${JSON.stringify(frame.error)}`);
        }
        if (lastText) return { text: lastText, reason: { kind: 'stream-closed' } };
        throw new Error('事件流结束');
      })();

      unwrap(await client0.sessions.prompt({ sessionId: ds, mode: 'queue', content: parts }), 'session.prompt');
      const ended = await done;
      try { await stream.return?.(); } catch { /* ignore */ }
      try { controller.abort(); } catch { /* ignore */ }
      const text = String(ended?.text || '').trim();
      if (!text) return { ok: false, reason: { kind: ended?.reason?.kind || 'empty' }, dsSessionId: ds };
      return { ok: true, text, dsSessionId: ds };
    } catch (error) {
      // 失败就把这个逻辑会话的映射扔掉，下一轮重新 create（冷会话 / 被归档 / DSH 重启都走这里）
      if (created || ds) sessions.delete(key);
      const reason = {
        kind: error?.code || 'error',
        message: String(error?.data?.reason || error?.message || error),
      };
      log(`[orb-agent] ${key} 失败：`, reason.message.slice(0, 200));
      return { ok: false, reason, dsSessionId: ds };
    } finally {
      clearTimeout(timer);
      running.delete(key);
    }
  }

  async function cancel(sessionId) {
    const key = String(sessionId || '');
    const state = running.get(key);
    if (state) {
      try { state.controller.abort(); } catch { /* ignore */ }
      running.delete(key);
    }
  }

  /** 忘掉逻辑会话的映射（调用方换代重试时用）。 */
  function forget(sessionId) {
    const key = String(sessionId || '');
    if (key) sessions.delete(key);
  }

  function dispose() {
    for (const state of running.values()) {
      try { clearTimeout(state.timer); } catch { /* ignore */ }
      try { state.controller.abort(); } catch { /* ignore */ }
    }
    running.clear();
    sessions.clear();
  }

  /** 只读状态（测试与设置页用）。 */
  function status() {
    return {
      sessions: [...sessions.entries()].map(([logical, ds]) => ({ logical, ds })),
      running: [...running.keys()],
    };
  }

  return { run, cancel, forget, dispose, status };
}
