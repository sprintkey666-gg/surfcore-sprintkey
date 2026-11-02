// 桌宠 / 悬浮球 / 陪伴字幕的聊天存档适配层。
//
// 它们不走 QQ 的 sendMessagesV2，也不该把桌宠消息伪造成 QQ 消息；这里复用
// chat-archive 的目录/滚动/去重逻辑，用 channel 区分来源，kind 固定 private。
import { createChatArchiveWriter, classifyType } from '../../../src/chat-archive.js';
import { defaultBackupDir } from '../../../src/memory-backup.js';

export const DESKTOP_CHANNELS = Object.freeze(['desktop-orb', 'companion']);

function cleanChannel(value) {
  const s = String(value || '').trim().toLowerCase();
  return DESKTOP_CHANNELS.includes(s) ? s : 'desktop-orb';
}

/**
 * @param {object} opts
 * @param {string} opts.dshHome          DSH_HOME（默认备份根用）
 * @param {() => object} opts.readConfig 返回 socialV2.memoryCardBackup 配置
 * @param {() => string} opts.getCharacterId 当前角色 ID
 */
export function createDesktopArchive({ dshHome = '', readConfig, getCharacterId, now = Date.now } = {}) {
  function config() {
    try {
      const raw = typeof readConfig === 'function' ? readConfig() : null;
      return raw && typeof raw === 'object' ? raw : {};
    } catch { return {}; }
  }

  function charId() {
    try { return String(typeof getCharacterId === 'function' ? getCharacterId() || '' : ''); } catch { return ''; }
  }

  const writer = createChatArchiveWriter({
    getBaseDir: () => {
      const cfg = config();
      const dir = String(cfg.dir || '').trim();
      return dir || defaultBackupDir(dshHome, charId());
    },
    getCharacterId: charId,
    getConfig: () => ({ archive: config().archive }),
    now,
  });

  /**
   * @param {object} msg
   * @param {'desktop-orb'|'companion'} [msg.channel]
   * @param {'user'|'assistant'|'system'} [msg.role]
   * @param {string} [msg.text]
   * @param {number} [msg.at]
   * @param {string} [msg.type]
   * @param {Array} [msg.media]
   * @param {string} [msg.id]
   * @param {string} [msg.name]      角色名（assistant）或主人名（user）
   * @param {boolean} [msg.proactive]
   */
  function record(msg = {}) {
    const channel = cleanChannel(msg.channel);
    const role = msg.role === 'assistant' || msg.role === 'system' ? msg.role : 'user';
    const text = String(msg.text == null ? '' : msg.text).trim();
    const media = Array.isArray(msg.media) ? msg.media : [];
    if (!text && !media.length) return null;
    if (text.startsWith('/')) return null;
    const at = Number.isFinite(Number(msg.at)) ? Number(msg.at) : now();
    const cid = charId() || 'default';
    const isSelf = role !== 'user';
    const senderName = String(msg.name || (role === 'user' ? '主人' : '角色')).slice(0, 80);
    const recordId = String(msg.id || `${channel}:${role}:${at}:${text.slice(0, 60)}`);
    const type = String(msg.type || classifyType([], media));
    const conversation = {
      key: `${channel}:${cid}`,
      id: cid,
      name: role === 'user' ? '桌面私聊' : '桌面会话',
    };
    return writer.appendRecord({
      id: recordId,
      at,
      channel,
      kind: 'private',
      platform: 'desktop',
      conversation,
      sender: { id: '', name: senderName, isOwner: role === 'user', isSelf },
      messageId: recordId,
      type,
      types: type && type !== 'text' ? [type] : ['text'],
      text,
      media,
      reply: null,
    });
  }

  return { record, status: writer.status, writer };
}
