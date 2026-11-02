// 好友申请判定（纯函数层）。
//
// 为什么单独一个文件：加好友这件事一旦判错就是「谁都能混进来」，所以要能在
// 单元测试里把每一条规则单独钉住，而不是埋在 bridge.js 的一坨 async 里靠手感。
// 这里的函数全部不碰 IO、不读 config、不发请求，只吃参数回结论。

export const FRIEND_DEFAULTS = {
  enabled: false,
  // autoApprove：默认关。关了以后「有人来加」只通知、只记下来，等 AI（或主人）
  // 用 qq_friend_decide 拍板；开了以后先过硬判，过了再叫醒 AI 决定，AI 不吭声
  // 就按硬判结论执行（免得申请一直挂着）。
  autoApprove: false,
  // requireWhitelisted：只有「白名单私聊对象」或「白名单群里的人」才可能被通过。
  // 默认开——主人要的就是这个，别让 AI 有绕过白名单的余地。
  requireWhitelisted: true,
  requireSharedGroup: true,
  maxPerDay: 5,
  maxPerHour: 3,
  rejectCooldownDays: 7,
  notifyOwner: true,
  autoRemark: true,
};

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', '开', '是'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', '关', '否'].includes(text)) return false;
  return fallback;
}

function intIn(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function defaultFriendConfig() {
  return { ...FRIEND_DEFAULTS };
}

// 配置归一：旧配置里没有 friend 段时给默认值；数值夹在合理区间，
// 免得有人把 maxPerDay 写成 -1 变成「无限加」。
export function normalizeFriendConfig(raw) {
  const base = defaultFriendConfig();
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: bool(src.enabled, base.enabled),
    autoApprove: bool(src.autoApprove, base.autoApprove),
    requireWhitelisted: bool(src.requireWhitelisted, base.requireWhitelisted),
    requireSharedGroup: bool(src.requireSharedGroup, base.requireSharedGroup),
    maxPerDay: intIn(src.maxPerDay, base.maxPerDay, 0, 100),
    maxPerHour: intIn(src.maxPerHour, base.maxPerHour, 0, 100),
    rejectCooldownDays: intIn(src.rejectCooldownDays, base.rejectCooldownDays, 0, 365),
    notifyOwner: bool(src.notifyOwner, base.notifyOwner),
    autoRemark: bool(src.autoRemark, base.autoRemark),
  };
}

// 「白名单里的个人」：config.allow.private 里就有他。
export function inPrivateAllowList(cfg, qq) {
  const id = String(qq ?? '').trim();
  if (!id) return false;
  const list = cfg?.allow?.private;
  if (!Array.isArray(list)) return false;
  return list.some((item) => String(item).trim() === id);
}

// 「白名单群里的好友」：他和我同在一个白名单群里。
// groups 由 bridge 那一层逐个群调 get_group_member_info 查出来（网关不给成员列表）。
export function sharedWhitelistGroups(cfg, groups) {
  const allowed = (Array.isArray(cfg?.allow?.groups) ? cfg.allow.groups : []).map((v) => String(v).trim());
  const list = Array.isArray(groups) ? groups.map((v) => String(v).trim()) : [];
  return list.filter((g) => allowed.includes(g));
}

export function inAllowList(cfg, qq) {
  if (!qq) return false;
  return inPrivateAllowList(cfg, qq);
}

// 结论：这个人到底在不在「可以加」的范围内。
export function scopeVerdict({ cfg, qq, groups } = {}) {
  if (!qq) return { ok: false, via: null, group: null, reason: '没有 QQ 号' };
  if (inPrivateAllowList(cfg, qq)) {
    return { ok: true, via: 'private', group: null, reason: '是白名单私聊对象' };
  }
  const shared = sharedWhitelistGroups(cfg, groups);
  if (shared.length) {
    return { ok: true, via: 'group', group: shared[0], reason: `在白名单群 ${shared[0]} 里` };
  }
  return { ok: false, via: null, group: null, reason: '不在白名单私聊对象里，也不在任何白名单群里' };
}

// 按本地日期算「今天」。不能用 toISOString：那是 UTC，半夜前后的额度会错位。
export function dailyKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return '1970-01-01';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 主判定。顺序有讲究：先看总开关（关了什么都不做），再看范围（范围外的人永远不过），
// 再看冷却（明确拒绝过的人别再反复弹），最后才是配额。
export function decideFriend({ cfg, request, sharedGroups, counters, deniedRecently } = {}) {
  const conf = normalizeFriendConfig(cfg?.socialV2?.friend);
  const req = request || {};
  const qq = String(req.user_id ?? req.qq ?? '').trim();

  if (!conf.enabled) return { allow: false, needsAi: false, reason: '好友申请功能没开' };
  if (!qq) return { allow: false, needsAi: false, reason: '申请里没有 QQ 号' };

  if (conf.requireWhitelisted) {
    const scope = scopeVerdict({ cfg, qq, groups: sharedGroups });
    if (!scope.ok) return { allow: false, needsAi: false, reason: scope.reason, scope };
    if (conf.requireSharedGroup && scope.via !== 'group' && scope.via !== 'private') {
      return { allow: false, needsAi: false, reason: '没有共同的白名单群', scope };
    }
  }

  if (deniedRecently) return { allow: false, needsAi: false, reason: '最近拒绝过这个人，冷却中' };

  const c = counters || {};
  const maxPerDay = conf.maxPerDay;
  const maxPerHour = conf.maxPerHour;
  if (maxPerHour > 0 && Number(c.hourCount ?? 0) >= maxPerHour) {
    return { allow: false, needsAi: false, reason: `这一小时已经通过 ${maxPerHour} 个了` };
  }
  if (maxPerDay > 0 && Number(c.dayCount ?? 0) >= maxPerDay) {
    return { allow: false, needsAi: false, reason: `今天已经通过 ${maxPerDay} 个了` };
  }

  return {
    allow: true,
    // autoApprove 关掉时：「允许」只代表干净，不代表自动通过，还得 AI/主人点头。
    needsAi: !conf.autoApprove,
    reason: conf.autoApprove ? '在白名单范围内，且没超配额' : '在白名单范围内，等 AI/主人决定',
  };
}

// 给唤醒提示用的【好友申请】段。没有待处理就不出现，免得每轮都占提示词。
export function buildFriendPromptLine(cfg, pending = []) {
  const conf = normalizeFriendConfig(cfg?.socialV2?.friend);
  const list = Array.isArray(pending) ? pending : [];
  if (!conf.enabled || !list.length) return '';
  const lines = ['【好友申请】有人来加好友，你需要拍板：'];
  for (const item of list.slice(0, 5)) {
    const qq = String(item.user_id ?? item.qq ?? '').trim();
    const name = String(item.nickname ?? '').trim() || qq;
    const via = item.scope?.via === 'group' ? `白名单群 ${item.scope.group}` : item.scope?.ok ? '白名单私聊' : '不在白名单范围';
    const comment = String(item.comment ?? '').trim();
    lines.push(`- ${name}（${qq}）· ${via}${comment ? ` · 留言：${comment}` : ''}`);
  }
  lines.push('- 决定：通过就调 qq_friend_decide {flag, approve:true}，拒绝就 approve:false；不在白名单范围的直接拒，不要通融。');
  lines.push(`- 规则：只有白名单私聊对象、或白名单群里的人可以通过；每小时最多 ${conf.maxPerHour} 个、每天 ${conf.maxPerDay} 个。`);
  return lines.join('\n');
}
