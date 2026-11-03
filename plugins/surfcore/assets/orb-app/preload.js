// 渲染进程 ⇄ 主进程的唯一通道。只暴露下面这几个方法，不给 node。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('orb', {
  /** 调插件的 /dsh-surfcore/orb-api/*（令牌和 baseUrl 永远留在主进程）。 */
  http: (path, options = {}) => ipcRenderer.invoke('orb:http', { path, ...options }),
  /** 系统文件选择框：图片/文件都能选，返回绝对路径。 */
  pickFiles: () => ipcRenderer.invoke('orb:pick-files'),
  /** 拖进来/粘贴进来的 File 取真实路径；取不到返回空串。 */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
  /** 收起/展开窗口。 */
  expand: (on) => ipcRenderer.invoke('orb:expand', Boolean(on)),
  /** 隐藏到托盘（不退出进程）；显示/切换/查询状态。 */
  hide: () => ipcRenderer.invoke('orb:hide'),
  show: () => ipcRenderer.invoke('orb:show'),
  toggleHidden: () => ipcRenderer.invoke('orb:toggle-hidden'),
  isHidden: () => ipcRenderer.invoke('orb:is-hidden'),
  /** 调球的大小（中键滚轮缩放）。delta 相对、size 绝对值。 */
  resize: (payload) => ipcRenderer.invoke('orb:resize', payload || {}),
  /** 当前大小/位置/是否展开，重启后位置也能接上。 */
  prefs: () => ipcRenderer.invoke('orb:prefs'),
  /** 拖动到屏幕坐标。 */
  move: (x, y) => ipcRenderer.invoke('orb:move', { x, y }),
  /** 松手后贴边。 */
  dock: () => ipcRenderer.invoke('orb:dock'),
  /** 面板边缘拖拽缩放：start(edge) → move({dx,dy})* → end()。 */
  panelResizeStart: (edge) => ipcRenderer.invoke('orb:panel-resize-start', String(edge || '')),
  panelResizeMove: (delta) => ipcRenderer.invoke('orb:panel-resize-move', delta || {}),
  panelResizeEnd: () => ipcRenderer.invoke('orb:panel-resize-end'),
  /** 面板整体拖动：按住「移」之后 follow 为 true，松手时 commit 记位置。 */
  panelMove: (x, y, commit) => ipcRenderer.invoke('orb:panel-move', { x, y, commit: Boolean(commit) }),
  panelPos: () => ipcRenderer.invoke('orb:panel-pos'),
  /** 右键菜单要多大：返回 {dx,dy} 让渲染端把宠物补偿回原来的视觉位置。 */
  menurect: (width, height) => ipcRenderer.invoke('orb:menurect', { width, height }),
  /** 形象配置：是不是桌宠、素材在哪、动画清单长什么样。 */
  petconfig: () => ipcRenderer.invoke('orb:petconfig'),
  /** 自己走两步：{dx,dy,ms}，主进程负责夹到屏幕内并平滑移动，返回 {clamped}。 */
  petMove: (payload) => ipcRenderer.invoke('orb:pet-move', payload || {}),
  /** 鼠标位置：宠物窗口是全透明覆盖层，收不到可靠 mousemove，注视只能问主进程。 */
  cursor: () => ipcRenderer.invoke('orb:cursor'),
  /** 鼠标是否在宠物/气泡身上——true 才有点击权，false 让给桌面。 */
  hit: (on) => ipcRenderer.invoke('orb:hit', Boolean(on)),
  bubbleShown: (on) => ipcRenderer.invoke('orb:bubble-shown', Boolean(on)),
  uiHold: (on) => ipcRenderer.invoke('orb:ui-hold', Boolean(on)),
  /** 右键菜单（打开会话 / 换个动作 / 隐藏）。 */
  menu: () => ipcRenderer.invoke('orb:menu'),
  /** 右键弹出的大小面板：open(true/false)；滑条改大小走 petSize。 */
  sizePanel: (open) => ipcRenderer.invoke('orb:sizepanel', Boolean(open)),
  petSize: (size) => ipcRenderer.invoke('orb:petsize', { size }),
  /** 头顶给气泡留多高（按气泡内容长高；传 0 复位）。 */
  bubbleSpace: (px) => ipcRenderer.invoke('orb:bubble-space', { px: Number(px) || 0 }),
  onPetAction: (fn) => {
    const handler = () => { try { fn(); } catch {} };
    ipcRenderer.on('orb:petaction', handler);
    return () => ipcRenderer.removeListener('orb:petaction', handler);
  },  quit: () => ipcRenderer.invoke('orb:quit'),
  log: (text) => ipcRenderer.invoke('orb:log', String(text ?? '')),
  onState: (fn) => {
    const handler = (_event, data) => { try { fn(data); } catch {} };
    ipcRenderer.on('orb:state', handler);
    return () => ipcRenderer.removeListener('orb:state', handler);
  },
  onConn: (fn) => {
    const handler = (_event, data) => { try { fn(data); } catch {} };
    ipcRenderer.on('orb:conn', handler);
    return () => ipcRenderer.removeListener('orb:conn', handler);
  },
  onHidden: (fn) => {
    const handler = () => { try { fn(); } catch {} };
    ipcRenderer.on('orb:hidden', handler);
    return () => ipcRenderer.removeListener('orb:hidden', handler);
  },
  onShown: (fn) => {
    const handler = () => { try { fn(); } catch {} };
    ipcRenderer.on('orb:shown', handler);
    return () => ipcRenderer.removeListener('orb:shown', handler);
  },
  /** 陪伴字幕窗：状态订阅、回复、拖动/缩放。 */
  companion: {
    onState: (fn) => {
      const handler = (_event, data) => { try { fn(data); } catch {} };
      ipcRenderer.on('companion:state', handler);
      return () => ipcRenderer.removeListener('companion:state', handler);
    },
    reply: (text) => ipcRenderer.invoke('companion:reply', { text: String(text ?? '') }),
    status: () => ipcRenderer.invoke('companion:status'),
    toggle: (active, sessionId = '') => ipcRenderer.invoke('companion:toggle', { active: Boolean(active), sessionId }),
    config: (patch) => ipcRenderer.invoke('companion:config', patch || {}),
    dragStart: () => ipcRenderer.invoke('companion:drag-start'),
    dragEnd: () => ipcRenderer.invoke('companion:drag-end'),
    font: (fontPx) => ipcRenderer.invoke('companion:font', { fontPx }),
    width: (width) => ipcRenderer.invoke('companion:width', { width }),
    height: (height) => ipcRenderer.invoke('companion:height', { height }),
    save: () => ipcRenderer.invoke('companion:save'),
  },
});
