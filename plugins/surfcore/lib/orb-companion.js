/**
 * SurfCore · 陪伴模式（观影字幕）
 *
 * 只做“看屏幕 → 说一句短感想 → 交给悬浮窗字幕条”这一件事：
 *   · 截图复用 orb-api 的 look()（800px JPEG），不另开采集通道；
 *   · 相同画面直接跳过，模型调用有每小时硬上限，避免烧 token；
 *   · 不写 QQ、不发群，字幕只留在本机内存。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const DEFAULT_COMPANION = {
  enabled: false,
  intervalSec: 60,
  maxCommentsPerHour: 12,
  fontPx: 22,
  width: 900,
  opacity: 55,
  contextSubtitles: false,
  // 字幕要看屏幕才能说话，画面每 tick 都在变，所以默认走快回复（直连单轮）；
  // 想让她像会话那样连着聊（有自己的 DSH 会话上下文）就切 legacy。
  reply: { mode: 'fast', timeoutMs: 120000, sessionTurns: 0, maxTokens: 500 },
  // 字幕里的对话要不要写进记忆卡 / 聊天存档（关掉 = 只是屏幕上飘一句话）。
  remember: true,
  archive: true,
};

const MESSAGE_LIMIT = 200;
const MAX_SUBTITLE = 60;
const MAX_REPLY = 120;
const RETRY_MS = 120_000;

function clampNum(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeCompanionConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled === true,
    intervalSec: clampNum(src.intervalSec, DEFAULT_COMPANION.intervalSec, 20, 180),
    maxCommentsPerHour: clampNum(src.maxCommentsPerHour, DEFAULT_COMPANION.maxCommentsPerHour, 1, 30),
    fontPx: clampNum(src.fontPx, DEFAULT_COMPANION.fontPx, 14, 40),
    width: clampNum(src.width, DEFAULT_COMPANION.width, 520, 1400),
    opacity: clampNum(src.opacity, DEFAULT_COMPANION.opacity, 0, 90),
    contextSubtitles: src.contextSubtitles === true,
    reply: (() => {
      const r = src.reply && typeof src.reply === 'object' ? src.reply : {};
      return {
        mode: r.mode === 'legacy' ? 'legacy' : 'fast',
        timeoutMs: clampNum(r.timeoutMs, DEFAULT_COMPANION.reply.timeoutMs, 30000, 600000),
        sessionTurns: clampNum(r.sessionTurns, DEFAULT_COMPANION.reply.sessionTurns, 0, 60),
        maxTokens: clampNum(r.maxTokens, DEFAULT_COMPANION.reply.maxTokens, 200, 4000),
      };
    })(),
    remember: src.remember !== false,
    archive: src.archive !== false,
  };
}

export function cleanSubtitle(text, max = MAX_SUBTITLE) {
  let s = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .trim();
  // 引号可能被空格包着（模型常写 "……"），先 trim 再剥一层引号。
  s = s.replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, '').trim();
  s = s.replace(/\s+/g, ' ');
  if (!s) return '';
  if (/^(skip|跳过|没什么可说|无)$/i.test(s)) return '';
  if (/^\/?no[- ]?comment$/i.test(s)) return '';
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

export function createOrbCompanionService({
  orb, chat, look, getConfig = () => ({}), log = () => {}, now = () => Date.now(), onMessage = null,
}) {
  let active = false;
  let sessionId = '';
  let startedAt = 0;
  let timer = null;
  let generation = 0;
  let ticking = false;
  let lastHash = '';
  let consecutiveFailures = 0;
  let lastError = '';
  let subtitle = null;
  let seq = 0;
  let messages = [];
  let commentAt = [];

  function cfg() {
    return normalizeCompanionConfig(getConfig()?.companion);
  }

  function status() {
    return {
      active,
      sessionId,
      startedAt,
      intervalSec: cfg().intervalSec,
      fontPx: cfg().fontPx,
      width: cfg().width,
      opacity: cfg().opacity,
      contextSubtitles: cfg().contextSubtitles,
      // 字幕对话是否进聊天存档 / 记忆卡（1.1.0 默认都开，设置页可关）。
      archive: cfg().archive,
      remember: cfg().remember,
      replyMode: cfg().reply.mode,
      subtitle,
      messages,
      lastError,
      degraded: Boolean(lastError),
      commentsThisHour: commentAt.filter((t) => now() - t < 3_600_000).length,
    };
  }

  function publish(text, who = 'her') {
    const clean = cleanSubtitle(text, who === 'me' ? MAX_REPLY : MAX_SUBTITLE);
    if (!clean) return null;
    subtitle = { id: ++seq, who, text: clean, at: now() };
    messages.push(subtitle);
    if (messages.length > MESSAGE_LIMIT) messages = messages.slice(-MESSAGE_LIMIT);
    archiveMessage(subtitle);
    return subtitle;
  }

  function archiveMessage(item) {
    if (typeof onMessage !== 'function' || !item) return;
    try {
      onMessage({
        channel: 'companion',
        role: item.who === 'me' ? 'user' : 'assistant',
        text: item.text,
        at: item.at,
        id: `companion:${sessionId || 'session'}:${item.id}`,
        name: item.who === 'me' ? '主人' : '角色',
      });
    } catch (error) {
      log('[companion] 写字幕存档失败：', String(error?.message ?? error).slice(0, 160));
    }
  }

  /** 只进历史，不顶当前字幕。用户插话用它，免得 AI 的上一句被用户的问题盖掉。 */
  function append(who, text) {
    const clean = cleanSubtitle(text, who === 'me' ? MAX_REPLY : MAX_SUBTITLE);
    if (!clean) return null;
    const item = { id: ++seq, who, text: clean, at: now() };
    messages.push(item);
    if (messages.length > MESSAGE_LIMIT) messages = messages.slice(-MESSAGE_LIMIT);
    archiveMessage(item);
    return item;
  }

  function threadText(limit = 6) {
    return messages
      .slice(-limit)
      .map((m) => `${m.who === 'me' ? '爹' : '你'}：${m.text}`)
      .join('\n');
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function arm(ms) {
    clearTimer();
    const gen = generation;
    timer = setTimeout(() => {
      timer = null;
      void tick(gen);
    }, Math.max(500, ms));
    timer.unref?.();
  }

  function limitReached() {
    const cap = cfg().maxCommentsPerHour;
    commentAt = commentAt.filter((t) => now() - t < 3_600_000);
    return commentAt.length >= cap;
  }

  function hashFile(file) {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 24);
    } catch {
      return '';
    }
  }

  function imageOf(file) {
    try {
      const buf = fs.readFileSync(file);
      if (!buf.length || buf.length > 900 * 1024) return null;
      return { mimeType: 'image/jpeg', data: buf.toString('base64') };
    } catch {
      return null;
    }
  }

  async function capture({ reason = 'companion' } = {}) {
    try {
      return await look({ small: true, manual: true, tier: 'companion', reason });
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async function tick(gen = generation) {
    if (!active || gen !== generation || ticking) return;
    ticking = true;
    try {
      if (limitReached()) {
        arm(cfg().intervalSec * 1000);
        return;
      }
      const shot = await capture({ reason: 'companion' });
      if (!active || gen !== generation) return;
      if (!shot?.ok) {
        lastError = String(shot?.error || '截图失败').slice(0, 160);
        consecutiveFailures += 1;
        // 截图失败只降级，不停止陪伴；避免一次锁屏/权限抖动就「陪看暂停」。
        arm(Math.min(5 * 60_000, RETRY_MS * 2 ** Math.min(4, consecutiveFailures - 1)));
        return;
      }
      const hash = hashFile(shot.screenshot);
      if (hash && hash === lastHash) {
        // 画面没变化：这次不花模型钱，等下一轮。
        if (getConfig()?.companion?.enabled !== false) {
          try { if (getConfig()?.screen?.deleteAfterRead !== false) fs.rmSync(shot.screenshot, { force: true }); } catch {}
        }
        arm(cfg().intervalSec * 1000);
        return;
      }
      lastHash = hash;
      const image = imageOf(shot.screenshot);
      const prompt = [
        '你正陪主人一起看电影/看屏幕，字幕条只显示一句很短的话。',
        '根据这一帧画面，说一句不超过40字的即时感想，像电影字幕，带一点你自己的口气。',
        '不要剧透、不要描述界面文字/文件名/聊天内容、不要念隐私信息，不要问问题。',
        '如果画面没有明显变化，或者没什么可说，只回复：SKIP',
        `当前前台窗口：${String(shot.active?.title || '未知').slice(0, 80)}`,
        threadText(4) ? `【刚才的字幕对话】\n${threadText(4)}` : '',
      ].filter(Boolean).join('\n');
      let reply = '';
      let failure = '';
      try {
        const rc = cfg().reply;
        const result = await chat.chat({
          text: prompt,
          modality: 'text',
          desktop: null,
          image,
          screenMode: 'auto',
          allowPic: false,
          channel: 'companion',
          replyMode: rc.mode,
          archive: cfg().archive,
          remember: cfg().remember,
        });
        if (result?.ok) reply = cleanSubtitle(result.reply?.text || '');
        else failure = String(result?.error || '模型没有回复');
      } catch (error) {
        failure = String(error?.message ?? error);
      }
      if (!active || gen !== generation) return;
      if (reply) {
        publish(reply, 'her');
        commentAt.push(now());
        consecutiveFailures = 0;
        lastError = '';
      } else if (failure) {
        consecutiveFailures += 1;
        lastError = failure.slice(0, 160);
      } else {
        consecutiveFailures = 0;
      }
      try {
        if (getConfig()?.screen?.deleteAfterRead !== false) fs.rmSync(shot.screenshot, { force: true });
      } catch {}
      arm(cfg().intervalSec * 1000);
    } finally {
      ticking = false;
    }
  }

  async function start({ sessionId: sid = '' } = {}) {
    const config = cfg();
    const orbConfig = getConfig() || {};
    if (orbConfig?.screen?.enabled !== true) {
      return { ok: false, error: '先打开「让她看见这台电脑」的屏幕权限，再开陪伴模式' };
    }
    clearTimer();
    active = true;
    sessionId = String(sid || '').slice(0, 120);
    startedAt = now();
    generation += 1;
    lastError = '';
    consecutiveFailures = 0;
    lastHash = '';
    subtitle = null;
    messages = [];
    commentAt = [];
    publish('陪伴模式已开启 · 等画面动起来', 'her');
    arm(12_000);
    log('[companion] 开始');
    return { ok: true, status: status() };
  }

  function stop(reason = 'manual') {
    if (!active && !timer) return { ok: true, status: status() };
    active = false;
    generation += 1;
    clearTimer();
    subtitle = null;
    log(`[companion] 停止（${reason}）`);
    return { ok: true, status: status() };
  }

  async function reply(text = '') {
    if (!active) return { ok: false, error: '陪伴模式还没开启' };
    const said = String(text || '').trim().slice(0, 400);
    if (!said) return { ok: false, error: '没听到你说什么' };
    append('me', said);
    const shot = await capture({ reason: 'companion-reply' });
    const image = shot?.ok ? imageOf(shot.screenshot) : null;
    const prompt = [
      '你们正在一起看电影/看屏幕，主人刚刚在字幕条里对你说了一句话。',
      '用不超过60字、像字幕一样自然地回他；不要长篇解释，不要提“截图/画面”。',
      '用你记忆卡里记得的事接着聊，不要重新自我介绍。',
      threadText(8) ? `【刚才的字幕对话】\n${threadText(8)}` : '',
      `主人说：${said}`,
    ].filter(Boolean).join('\n');
    let out = '';
    let error = '';
    try {
      const rc = cfg().reply;
      const result = await chat.chat({
        text: prompt,
        modality: 'text',
        desktop: null,
        image,
        screenMode: 'auto',
        allowPic: false,
        channel: 'companion',
        replyMode: rc.mode,
        archive: cfg().archive,
        remember: cfg().remember,
      });
      if (result?.ok) out = cleanSubtitle(result.reply?.text || '', MAX_REPLY);
      else error = String(result?.error || '模型没有回复');
    } catch (err) {
      error = String(err?.message ?? err);
    }
    try {
      if (shot?.ok && getConfig()?.screen?.deleteAfterRead !== false) fs.rmSync(shot.screenshot, { force: true });
    } catch {}
    if (!out) {
      const why = error || '她这次没说话';
      lastError = why.slice(0, 160);
      publish(`这条没接上：${why}`, 'her');
      return { ok: false, error: why, status: status() };
    }
    lastError = '';
    consecutiveFailures = 0;
    publish(out, 'her');
    return { ok: true, reply: out, status: status() };
  }

  function dispose() {
    stop('dispose');
  }

  return { start, stop, status, reply, tick, dispose };
}
