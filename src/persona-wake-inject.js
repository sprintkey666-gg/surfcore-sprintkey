// 唤醒提示词里「人格卡怎么注入」的三种方式（2026-11-07 主人要求可切换）。
//
// 背景：上游 v0.8.9 把唤醒侧的人格注入从「一句指针」改成「直接印整张人格卡正文」
// （原因见 src/bridge.js 的 personaWakeBlockV2 注释：实测 1830 次工具调用里只有
// 10 次去调 qq_get_prompt）。代价是每条唤醒多六七千字，一天几十上百条就是几十万
// token。这里把三种方式做成纯文本组装，便于单测，也便于以后再加档位：
//
//   card    —— 0.8.9 原样：印卡正文（最完整，最费）
//   trim    —— 0.8.9 卡正文按字数上限截断（折中档，旧版没有这一档）
//   pointer —— 0.6.22 原样：只给一句指针（最省，但她要自己去查）
//
// pointerLine() 的模板必须与 0.6.22 的 buildWakePromptV2Core 逐字一致 ——
// scripts/test-prompt-inject-mode.mjs 会用 `git show pre-sync-0.6.22-sprintkey`
// 取出旧代码做对照，别顺手改这里的措辞。

export const WAKE_INJECT_MODES = Object.freeze(['card', 'trim', 'pointer']);

export const DEFAULT_WAKE_INJECT = 'card';
export const DEFAULT_WAKE_TRIM_CHARS = 2500;
export const WAKE_TRIM_MIN_CHARS = 800;
export const WAKE_TRIM_MAX_CHARS = 6000;

/** 只认三种取值；缺省/拼错一律回到 card，避免升级后行为被静默改掉。 */
export function normalizeWakeInject(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  return WAKE_INJECT_MODES.includes(mode) ? mode : DEFAULT_WAKE_INJECT;
}

/** trim 档的字数上限：800~6000，默认 2500。 */
export function normalizeWakeTrimChars(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WAKE_TRIM_CHARS;
  return Math.min(WAKE_TRIM_MAX_CHARS, Math.max(WAKE_TRIM_MIN_CHARS, n));
}

/**
 * 0.6.22 原样的一行指针。
 * 旧代码：`【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n`
 * 角色名为空时旧版整行不出现（这里同样返回空串）。
 */
export function pointerLine(roleName) {
  const name = String(roleName ?? '').trim();
  return name ? `【当前角色】${name}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
}

/**
 * 0.8.9 原样的印卡块；card 为空（卡文件读不到 / 角色名为空）时回落到旧版指针，
 * 保证「至少知道自己叫谁」，不会把注入变成空。
 */
export function wrapCardBlock({ name, card }) {
  const body = String(card ?? '');
  const role = String(name ?? '').trim();
  if (!body) return pointerLine(role);
  const title = role || '（未命名角色）';
  return `【当前角色】${title}\n${body}\n（完整角色卡 / 场景语气 / 推荐值 / 可用工具：可调用 qq_get_prompt 查看）\n\n`;
}
