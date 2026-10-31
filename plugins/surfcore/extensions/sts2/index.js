/**
 * 示例扩展：杀戮尖塔启动器（预留）。
 *
 * 这是一个**空壳**：只演示扩展接口，不会真的启动游戏、不会读写游戏文件。
 * 后续把另一个工作区的启动插件接进来时，可以：
 *   · 用 api.bili.run([...]) 调 B站工具链；
 *   · 用 api.registerRoute('POST', '/launch', handler) 暴露自己的控制面；
 *   · 用 api.config.get()/set() 存自己的配置；
 *   · 用 api.on('memory.synced', ...) / api.emit(...) 和其他功能协作。
 */
export async function activate(api) {
  api.log('sts2 示例扩展已激活（未实现真实启动）');

  api.registerRoute('GET', '/status', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      extension: 'sts2',
      status: 'planned',
      message: '接口已预留：把杀戮尖塔启动器接进来后，这里会返回真实状态',
      config: api.config.get(),
    }));
  });

  api.registerRoute('POST', '/launch', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: false,
      error: '示例扩展不会启动游戏；请在 sts2 扩展里实现 launch',
      hint: '可参考 docs/EXTENSIONS.md',
    }));
  });
}

export function onEvent(event, payload) {
  // 例子：记忆同步完成后可以刷新自己的状态
  // console.log('[sts2]', event, payload);
}
