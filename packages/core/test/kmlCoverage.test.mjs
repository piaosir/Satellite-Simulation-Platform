// KML 覆盖等值线导入自测（src/viz/kml/parse.js 的 parseKmlBeams）：运行 npm test。
// 导入是导出的逆：本软件导出的 KML 必须能原样导回覆盖库（卫星/波束/轨位/频段/类型/增益档/点列），
// 同时兼容 Google Earth 一类第三方文件（没有 ExtendedData、层级少一层、增益只写在名称里）。
// 解析器跑在渲染进程，用的是浏览器 DOMParser —— Node 里没有，用 @xmldom/xmldom 顶上（同一套 DOM API）。
let XmlDom = null
try { XmlDom = await import('@xmldom/xmldom') } catch { /* 没装就跳过，不红 */ }
if (!XmlDom) { console.log('SKIP  KML 覆盖导入自测：本机缺 @xmldom/xmldom（npm i -D @xmldom/xmldom 后可跑）'); process.exit(0) }
globalThis.DOMParser = XmlDom.DOMParser
const { parseKmlBeams, parseKmlPolys } = await import('../../../src/viz/kml/parse.js')
const { serializeKml } = await import('../../../src/viz/kml/serialize.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps

// 一条闭合区域的开放环（内部 contours.p 的口径：不含末尾重复点）
const ring = (lon0, lat0, r) => [[lon0 - r, lat0 - r], [lon0 + r, lat0 - r], [lon0 + r, lat0 + r], [lon0 - r, lat0 + r]]

/* ---------- ① 往返：导出的 KML 必须能原样导回 ---------- */
const beamsIn = [
  { name: '东部波束', satName: '中星10R', lon: 110.5, type: 'EIRP', band: 'Ku', bore: [[115.2, 30.4]],
    contours: [{ g: 48, p: ring(115, 30, 3) }, { g: 44.5, p: ring(115, 30, 5) }] },
  { name: '西部波束', satName: '中星10R', lon: 110.5, type: 'EIRP', band: 'Ku', bore: [[95.0, 35.0]],
    contours: [{ g: 46, p: ring(95, 35, 4) }] },
  { name: '全球波束', satName: 'APSTAR 6D', lon: 134, type: 'GT', band: 'C', bore: [],
    contours: [{ g: -2.5, p: ring(134, 0, 8) }] }
]
const kml = serializeKml(beamsIn, { name: '当前绘制' })
const rt = parseKmlBeams(kml)

ok('往返：波束数不多不少', rt.beams.length === 3, `${rt.beams.length}`)
const b0 = rt.beams.find((b) => b.beamName === '东部波束')
ok('往返：卫星名按文件夹层级还原', b0 && b0.satName === '中星10R', b0 && b0.satName)
ok('往返：轨位从 ExtendedData 还原', b0 && near(b0.lon, 110.5), b0 && String(b0.lon))
ok('往返：频段/类型还原', b0 && b0.band === 'Ku' && b0.type === 'EIRP', b0 && `${b0.band}/${b0.type}`)
ok('往返：波束中心还原', b0 && b0.bore.length === 1 && near(b0.bore[0][0], 115.2) && near(b0.bore[0][1], 30.4, 1e-6),
  b0 && JSON.stringify(b0.bore))
ok('往返：等值线条数与增益档（含小数）', b0 && b0.contours.length === 2 && b0.contours.some((c) => near(c.g, 44.5)),
  b0 && b0.contours.map((c) => c.g).join(','))
const c48 = b0 && b0.contours.find((c) => c.g === 48)
ok('往返：环去掉了导出时补的闭合点', c48 && c48.p.length === 4, c48 && String(c48.p.length))
ok('往返：坐标是 lon,lat 且逐点相等', c48 && c48.p.every((p, i) => near(p[0], ring(115, 30, 3)[i][0]) && near(p[1], ring(115, 30, 3)[i][1])),
  c48 && JSON.stringify(c48.p[0]))
const bGt = rt.beams.find((b) => b.beamName === '全球波束')
ok('往返：第二颗卫星独立成组', bGt && bGt.satName === 'APSTAR 6D' && near(bGt.lon, 134), bGt && `${bGt.satName} ${bGt.lon}`)
ok('往返：G/T 类型与负增益档', bGt && bGt.type === 'GT' && near(bGt.contours[0].g, -2.5), bGt && `${bGt.type} ${bGt.contours[0].g}`)

/* ---------- ② 协调区多边形：不当覆盖档位收，计数报出 ---------- */
const polys = [
  { name: '协调区A', value: '-140', satName: '中星10R', satLon: '110.5', color: '#ff5a5a', pts: ring(100, 20, 2) },
  { name: '协调区B', value: '-150', color: '#33aaff', pts: ring(105, 25, 2) }
]
const kmlMix = serializeKml(beamsIn, { name: '当前绘制', polys })
const mix = parseKmlBeams(kmlMix)
ok('协调区：覆盖波束数不受影响', mix.beams.length === 3, `${mix.beams.length}`)
ok('协调区：多边形被跳过并计数', mix.polys === 2, `${mix.polys}`)
ok('协调区：没有混进任何波束的等值线', !mix.beams.some((b) => b.beamName.includes('协调区')), '')
// 同一份文件走 Polygon 导入口径时，协调区多边形照样能取回（两个入口互不干扰）
const pg = parseKmlPolys(kmlMix)
ok('协调区：Polygon 入口仍能取到（4 条覆盖等值线 + 2 个协调区 = 6 个多边形）', pg.length === 6, `${pg.length}`)

/* ---------- ③ 第三方 KML：没有 ExtendedData、层级少一层、增益只写在名称里 ---------- */
const foreign = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>SomeSat Coverage</name>
<Folder><name>Spot 1</name>
<Placemark><name>EIRP 50 dBW</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
100,20,0 102,20,0 102,22,0 100,22,0 100,20,0
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>47</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
99,19,0 103,19,0 103,23,0 99,23,0
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>轮廓</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
98,18,0 104,18,0 104,24,0
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Folder></Document></kml>`
const fr = parseKmlBeams(foreign)
ok('第三方：单层文件夹 → 卫星名取文档名', fr.beams.length === 1 && fr.beams[0].satName === 'SomeSat Coverage', fr.beams[0] && fr.beams[0].satName)
ok('第三方：波束名取文件夹名', fr.beams[0].beamName === 'Spot 1', fr.beams[0].beamName)
ok('第三方：「EIRP 50 dBW」取到 50', fr.beams[0].contours.some((c) => c.g === 50), fr.beams[0].contours.map((c) => c.g).join(','))
ok('第三方：纯数字名称「47」也认', fr.beams[0].contours.some((c) => c.g === 47), '')
ok('第三方：没有数值的多边形不进等值线、单独计数', fr.beams[0].contours.length === 2 && fr.noGain === 1, `contours=${fr.beams[0].contours.length} noGain=${fr.noGain}`)
ok('第三方：无 ExtendedData 时轨位留空（不编造）', fr.beams[0].lon === null, String(fr.beams[0].lon))

/* ---------- ④ 单位是 dB/K 的按 G/T 收；MultiGeometry 一个 Placemark 多个环 ---------- */
const gtKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>GT</name>
<Folder><name>SatX</name><Folder><name>BeamX</name>
<Placemark><name>1.5 dB/K</name><MultiGeometry>
<Polygon><outerBoundaryIs><LinearRing><coordinates>10,10,0 12,10,0 12,12,0 10,12,0 10,10,0</coordinates></LinearRing></outerBoundaryIs></Polygon>
<Polygon><outerBoundaryIs><LinearRing><coordinates>20,10,0 22,10,0 22,12,0 20,12,0 20,10,0</coordinates></LinearRing></outerBoundaryIs></Polygon>
</MultiGeometry></Placemark>
</Folder></Folder></Document></kml>`
const gt = parseKmlBeams(gtKml)
ok('dB/K 名称 → 类型判为 GT', gt.beams[0].type === 'GT', gt.beams[0].type)
ok('MultiGeometry：两个环同档各成一条等值线', gt.beams[0].contours.length === 2 && gt.beams[0].contours.every((c) => near(c.g, 1.5)),
  `${gt.beams[0].contours.length}`)

/* ---------- ⑤ 报错口径：整份文件都取不到增益档时不静默吞掉 ---------- */
const noneKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>N</name><Folder><name>F</name>
<Placemark><name>区域</name><Polygon><outerBoundaryIs><LinearRing><coordinates>1,1,0 2,1,0 2,2,0 1,1,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Folder></Document></kml>`
let threw = ''
try { parseKmlBeams(noneKml) } catch (e) { threw = e.message || String(e) }
ok('全无增益档 → 抛错并说明原因', /增益档/.test(threw), threw)
let threw2 = ''
try { parseKmlBeams(serializeKml([], { name: '空', polys })) } catch (e) { threw2 = e.message || String(e) }
ok('只有协调区多边形 → 提示改用 Polygon 面板', /协调区/.test(threw2), threw2)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
