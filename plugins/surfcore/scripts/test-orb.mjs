// 转发壳：orb-app 的静态契约断言都在仓库根的 scripts/test-orb.mjs（几百条，跟
// 插件一起发布的 assets/orb-app/* 一起核对）。任务书里给的是这个路径，所以留一个
// 转发，跑 `node plugins/surfcore/scripts/test-orb.mjs` 跟跑根目录那份完全等价。
import '../../../scripts/test-orb.mjs';
