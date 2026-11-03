// 「原版」回复速度：走真正的 DSH 会话（和 QQ 那边同款 agent 回合），而不是一次直连调用。
//
// 为什么需要它：主人 2026-11-03 要求悬浮窗会话/陪伴字幕「就像插件 qq 聊天一样专门开一个会话
// 来进行聊天（注入记忆和人设）（接收问题和回复）」。直连 `ctx.get('llm').stream()` 每次都是
// 单轮无工具，多步上下文的体验和 QQ 差一截；这里改成用 sessionController 驱动一个专属会话：
//   · 会话 id 固定 → 上下文连续（越聊越熟练，也越聊越慢 = 「原版」的代价）
//   · 每轮都把「人设 + 记忆卡 + 跨端最近对话 + 这一句」拼成一条 prompt 推进去
//   · 回合结束用 turn/end 事件收最终文本（assistant/chunk 不收，避免重复）
//
// 「快回复」不走这里，仍旧直连 llm（见 pet-chat.js 的 fast 分支）。

import path from 'node:path';
import { applySessionPermission } from './scheduler.js';

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * 收集一次 turn 的 assistant 文本。和 src/dsh-client.js 里那份同构，
 * 但不从那边 import：插件不该依赖桥接进程的 HTTP/WS 客户端。
 */
export function createTurnCollector() {
  const turns = new Map();
  return {
    push(event) {
      if (!event || typeof event !== 'object') return null;
      if (event.type === 'turn/start') {
        turns.set(event.data?.turn, { text: '' });
        return null;
      }
      if (event.type === 'assistant/chunk') return null;
      if (event.type === 'assistant/message') {
        const t = turns.get(event.data?.turn);
        if (!t) return null;
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        const t = turns.get(event.data?.turn);
        turns.delete(event.data?.turn);
        if (!t) return null;
        return { turn: event.data?.turn, reason: event.data?.reason, text: t.text };
      }
      return null;
    },
    size() { return turns.size; },
  };
}

/**
 * 一个会话驱动器的工厂。同一个实例可以被悬浮窗会话和陪伴字幕共用：
 * 两边传不同的 sessionId 就是两个独立上下文（历史不串）。
 */
export function createOrbAgent({ ctx, stateDir, pluginLog = () => {}, cwd = '', profile = 'orb' }) {
  const root = String(cwd || path.join(String(stateDir || '.'), 'orb-agent'));
  const pending = new Map(); // sessionId -> { collector, resolve, reject, timer }
  const ready = new Set();
  let off = null;

  function controller() {
    try { return ctx?.sessionController; } catch { return undefined; }
  }

  function fail(message) {
    const error = new Error(message);
    error.code = 'ORB_AGENT';
    return error;
  }

  function onEvent(session, event) {
    const sessionId = String(session?.id || session?.sessionId || '');
    if (!sessionId) return;
    const waiter = pending.get(sessionId);
    if (!waiter) return;
    const ended = waiter.collector.push(event);
    if (ended) waiter.settle(ended);
  }

  /** 订阅 session/event。由插件在启动时调一次；幂等。 */
  function attach() {
    if (off || typeof ctx?.on !== 'function') return;
    try { off = ctx.on('session/event', onEvent); } catch { off = null; }
  }

  async function ensureSession(sessionId) {
    const sc = controller();
    if (!sc) throw fail('DSH 会话服务还没就绪（sessionController 不可用）');
    if (ready.has(sessionId)) return;
    try {
      if (typeof sc.inspect === 'function') {
        await sc.inspect(sessionId);
        ready.add(sessionId);
        applySessionPermission(ctx, sessionId, 'danger-full-access', pluginLog);
        return;
      }
    } catch { /* 不存在 → 往下 create */ }
    // create 对已存在的非空会话会新建一个空壳，所以上面必须先 inspect。
    await sc.create({ sessionId, cwd: root });
    ready.add(sessionId);
    applySessionPermission(ctx, sessionId, 'danger-full-access', pluginLog);
  }

  /**
   * 跑一轮：把 text 推进会话，等这一轮结束拿最终文本。
   * @returns {Promise<{ok:boolean, text:string, reason:object|null, sessionId:string}>}
   */
  async function run({ sessionId, text = '', content = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const sid = String(sessionId || '').trim();
    const body = String(text || '').trim();
    const parts = Array.isArray(content) && content.length ? content : [{ type: 'text', text: body }];
    if (!sid) throw fail('缺少 sessionId');
    if (!body && !(Array.isArray(content) && content.length)) return { ok: true, text: '', reason: null, sessionId: sid };
    attach();
    const sc = controller();
    if (!sc?.prompt) throw fail('DSH 会话服务还没就绪（sessionController.prompt 不可用）');
    if (pending.has(sid)) throw fail('这个会话上一轮还没结束');
    await ensureSession(sid);

    const result = await new Promise((resolve, reject) => {
      const collector = createTurnCollector();
      // ⚠️ 2026-11-03 真机事故：DSH 的 sessionController.prompt(args, signal) 内部会无条件调
      //    signal.throwIfAborted()，不传 signal 就直接抛
      //    `Cannot read properties of undefined (reading 'throwIfAborted')`
      //    → 每轮都在 30ms 内退回直连，看起来「原版会话实现了但从没跑过」。
      //    所以这里必须显式造一个 AbortController，超时/取消时 abort 掉。
      const abort = new AbortController();
      const timer = setTimeout(() => {
        pending.delete(sid);
        try { abort.abort(); } catch { /* ignore */ }
        try { sc.cancel?.({ sessionId: sid }); } catch { /* 取消失败也不拦着报错 */ }
        reject(fail(`这一轮超过 ${Math.round(timeoutMs / 1000)} 秒还没结束`));
      }, Math.max(5000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
      const settle = (ended) => {
        clearTimeout(timer);
        pending.delete(sid);
        resolve({ ok: true, text: String(ended.text || '').trim(), reason: ended.reason ?? null, sessionId: sid });
      };
      pending.set(sid, { collector, resolve, reject, timer, settle, abort });
      Promise.resolve()
        .then(() => sc.prompt({ sessionId: sid, mode: 'queue', content: parts }, abort.signal))
        .catch((error) => {
          clearTimeout(timer);
          pending.delete(sid);
          reject(error);
        });
    });
    return result;
  }

  async function cancel(sessionId) {
    const sid = String(sessionId || '');
    const waiter = pending.get(sid);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(sid);
      try { waiter.abort?.abort(); } catch { /* ignore */ }
    }
    try { await controller()?.cancel?.({ sessionId: sid }); } catch { /* ignore */ }
  }

  function dispose() {
    for (const waiter of pending.values()) {
      try { clearTimeout(waiter.timer); } catch {}
      try { waiter.abort?.abort(); } catch {}
    }
    pending.clear();
    try { off?.(); } catch {}
    off = null;
  }

  return { attach, run, cancel, dispose, profile, root };
}
