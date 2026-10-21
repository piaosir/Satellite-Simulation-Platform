// 时区图层的数据署名（零依赖：关于窗口也引它，不能为一行字把规则表 / 拓扑拖进主窗）。
//
// 时区边界来自 timezone-boundary-builder（由 OpenStreetMap 数据构建，ODbL 1.0）；本平台按自己的底图与主权层
// 重绘后的 src/viz/geo/tz/tz-*.json 属其派生数据库，随包分发同样以 ODbL 1.0 提供（许可 URI 与改制方法见
// resources/licenses/license.timezone-boundary-builder.txt）。ODbL §4.3 要求对看到成图的人给出署名：
// 图层开关的悬停 + 关于窗口一行（2026-10-20 用户定；地图上不出字）。tzdb 是公有领域，无署名义务，列出只为标明规则版本。
// ★ 整串是 uiDict 的 EXACT 键（英文档靠它）；两个版本号与随包数据一致、词典里有这条，都由 tzLayer.test.mjs 守门 ——
//   重跑 npm run tz:build 换了版本，这里与词典键一起改。
export const TZ_CREDIT = '时区边界 © OpenStreetMap 贡献者（ODbL 1.0）· timezone-boundary-builder 2026e · tzdb 2026e'
