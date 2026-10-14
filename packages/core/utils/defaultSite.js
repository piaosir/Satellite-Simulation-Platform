// 链路预算的「默认站址」：站址经纬度留空时 GEO / NGSO 两引擎按这一组经纬度算几何与传播
// （见 linkCalculator.js / linkCalculatorNGSO.js 的上行站 / 接收站参数段；再生式经 NGSO 引擎同口径）。
// 渲染端经 IPC link:defaultSiteGeo 按这同一组经纬度查 ITU 降雨率（P.837）/ 海拔（P.1511）
// （index.js 的 defaultSiteGeo），给留空站址那几行补 R0.01% 与海拔、并作表内灰字占位——
// 查询点与引擎留空时的取值点必须是同一组数，所以只在这里定义一次。
// 数值与三窗字段缺省（params.js / ngsoParams.js / regenParams.js 的经纬度 def）一致，单测钉住。
const DEFAULT_SITE = Object.freeze({ lat: 39.9042, lon: 116.4074 });

module.exports = { DEFAULT_SITE };
