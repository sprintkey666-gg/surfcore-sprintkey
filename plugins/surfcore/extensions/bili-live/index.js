/**
 * 示例扩展：B站自主直播（预留）。
 *
 * 不实现推流、不读 cookie 明文。后续接入时建议：
 *   · 直播开关、房间号、推流地址放 api.config；
 *   · 弹幕事件通过 api.emit('bili.live.danmaku', {...}) 广播；
 *   · B站工具调用统一走 api.bili.run(['danmaku', ...])，不要在扩展里再抄一份接口。
 */
export async function activate(api) {
  api.log('bili-live 示例扩展已激活（未实现真实直播）');

  api.registerRoute('GET', '/status', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      extension: 'bili-live',
      status: 'planned',
      message: '接口已预留：直播推流/弹幕/场控还没实现',
      config: api.config.get(),
    }));
  });
}
