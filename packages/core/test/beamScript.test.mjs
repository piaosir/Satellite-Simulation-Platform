// 可编程波束地图自测（src/shared/beamScript/*）：运行 npm test。
// 钉住四件事：① 数据模型口径；② 标准库默认值 = 菜单导出（gxt / kml 逐字节对拍）；③ 几何 / 编码 / 写出器的数值；
// ④ 运行时（报错行号、import 拦截、输出规整）与全部内置模板在两种语言下都能跑通。
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const SB = join(ROOT, 'src/shared/beamScript')
const { buildBeamMap, beamMapStats } = await import('../../../src/shared/beamScript/model.js')
const { createStdlib, STDLIB_NAMES } = await import('../../../src/shared/beamScript/stdlib.js')
const { runScript, checkSource } = await import('../../../src/shared/beamScript/runtime.js')
const { encodeText, normEncoding, applyEol } = await import('../../../src/shared/beamScript/encode.js')
const { parseTemplates, localize, blankScript } = await import('../../../src/shared/beamScript/templates.js')
const { serializeGxt } = await import('../../../src/viz/gxt/serialize.js')
const { serializeKml } = await import('../../../src/viz/kml/serialize.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra != null && extra !== '' ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps
const ring = (lon0, lat0, r) => [[lon0 - r, lat0 - r], [lon0 + r, lat0 - r], [lon0 + r, lat0 + r], [lon0 - r, lat0 + r]]
const closed = (p) => [...p, p[0]]

/* ---------- 夹具：与 3D 页 collectBeamMapRaw 同形 ---------- */
const RAW = {
  library: [
    { satName: '中星10R', lon: 110.5, band: 'Ku', beam: '东部波束', type: 'EIRP', bore: [[115.2, 30.4, 52.3]],
      contours: [{ g: 48, color: '#ff3300', p: ring(115, 30, 3) }, { g: 44.5, color: '#00aa44', p: ring(115, 30, 5) }] },
    { satName: 'APSTAR 6D', lon: 134, band: 'C', beam: '全球', type: 'GT', bore: [],
      contours: [{ g: -2.5, color: '#3366ff', p: closed(ring(134, 0, 8)) }] }
  ],
  antenna: [
    { name: 'Beam 1', satName: 'GRD星', lon: 100, bore: [[101, 21]], ctype: 'rel', refDb: 0, pol: 'RSS', gainOffset: 0, pathLoss: 'none', antName: 'ant-a', peak: 42.1,
      contours: [{ g: -1, color: '#ff0000', name: '核心', p: closed(ring(101, 21, 1)) }, { g: -3, color: '#00ff00', p: closed(ring(101, 21, 2)) }] }
  ],
  polygons: [
    { name: '协调区A', value: '-50', satName: '中星10R', satLon: '110.5', color: '#3366FF', width: 3, fillOn: true, fillColor: '#3366ff', fillOp: 0.25, pts: ring(100, 20, 2) },
    { name: '', value: '', satName: '', satLon: '', color: '#22cc88', pts: closed(ring(90, 10, 1)) },
    { name: '太短', value: '1', pts: [[0, 0], [1, 1]] }
  ],
  points: [{ name: '点1', lon: 116.4, lat: 39.9, color: '#ff00ff' }, { name: '坏点', lon: NaN, lat: 1 }],
  stations: [{ name: '北京站', lon: 116.4, lat: 39.9 }, { name: '杭州站', lon: 115.5, lat: 30.5 }],
  trajectories: [{ name: '航行1', kind: 'sea', pts: [{ lon: 120, lat: 30, tMs: Date.UTC(2026, 0, 1) }, { lon: 121, lat: 31, alt: 10 }] }],
  meta: { version: '1.5.2', simTime: Date.UTC(2026, 9, 15, 4), lang: 'zh' }
}
const D = buildBeamMap(RAW)

/* ---------- ① 数据模型 ---------- */
ok('模型：波束数（覆盖库 2 + 天线 1）', D.beams.length === 3, D.beams.length)
ok('模型：覆盖库在前、天线在后', D.beams[0].source === 'library' && D.beams[2].source === 'antenna')
ok('模型：EIRP→dBW、GT→dB/K、相对档天线→dB', D.beams[0].unit === 'dBW' && D.beams[1].unit === 'dB/K' && D.beams[2].unit === 'dB', D.beams.map((b) => b.unit).join(','))
ok('模型：等值线 level/color/closed', D.beams[0].contours[1].level === 44.5 && D.beams[0].contours[1].color === '#00aa44' && D.beams[0].contours[0].closed === false && D.beams[1].contours[0].closed === true)
ok('模型：天线档名与设置', D.beams[2].contours[0].name === '核心' && D.beams[2].antenna.contourType === 'rel' && D.beams[2].antenna.peak === 42.1)
ok('模型：波束中心为 {lon,lat,value}（源文件 gain 保留）', D.beams[0].peaks[0].lon === 115.2 && D.beams[0].peaks[0].lat === 30.4 && D.beams[0].peaks[0].value === 52.3)
ok('模型：天线峰值按等值线类型折算（相对峰值 → 0）', D.beams[2].peaks[0].value === 0 && buildBeamMap({ antenna: [{ ...RAW.antenna[0], ctype: 'abs' }] }).beams[0].peaks[0].value === 42.1 && buildBeamMap({ antenna: [{ ...RAW.antenna[0], ctype: 'relInput', refDb: 40 }] }).beams[0].peaks[0].value === 2.1)
ok('模型：Polygon 少于 3 点剔除、闭合点去掉、颜色小写', D.polygons.length === 2 && D.polygons[1].points.length === 4 && D.polygons[0].color === '#3366ff' && D.polygons[1].fill.color === '#22cc88')
ok('模型：认不出的颜色落缺省色', buildBeamMap({ polygons: [{ color: 'bad', pts: ring(0, 0, 1) }] }).polygons[0].color === '#3b82f6')
ok('模型：天线档位色 rgb(r,g,b) / #abc 归一成 #rrggbb', (() => {
  const m = buildBeamMap({ antenna: [{ name: 'A', contours: [{ g: -1, color: 'rgb(255,128,0)', p: ring(0, 0, 1) }, { g: -2, color: '#0f8', p: ring(0, 0, 2) }] }] })
  return m.beams[0].contours[0].color === '#ff8000' && m.beams[0].contours[1].color === '#00ff88'
})())
ok('模型：Polygon 数值 level 与轨位数值化', D.polygons[0].level === -50 && D.polygons[0].orbitLon === 110.5 && D.polygons[1].level === null && D.polygons[1].orbitLon === null)
ok('模型：坐标非有限的标记剔除', D.points.length === 1 && D.points[0].color === '#ff00ff' && D.stations.length === 2)
ok('模型：航迹时刻 ISO、高度保留', D.trajectories[0].points[0].time === '2026-01-01T00:00:00.000Z' && D.trajectories[0].points[1].alt === 10)
ok('模型：meta 仿真时刻 / 基准', D.meta.simTime === '2026-10-15T04:00:00.000Z' && D.meta.datum === 'WGS-84' && D.meta.appVersion === '1.5.2')
ok('模型：meta 来源缺省 drawing、标题缺省随语言', D.meta.scope === 'drawing' && D.meta.title === '当前绘制' && buildBeamMap({ meta: { lang: 'en' } }).meta.title === 'Current drawing')
ok('模型：meta.title 可直接作文件名（禁用字符 / 控制字符折成 -，首尾点与空白去掉）', (() => {
  const t = (v) => buildBeamMap({ meta: { title: v } }).meta.title
  return t('中星6A/6B: "x"') === '中星6A-6B-x' && t(' ..a  b\tc\u0001d. ') === 'a b-c-d' && t(' / ') === '当前绘制' && t('APSTAR 6D_Ku_全球') === 'APSTAR 6D_Ku_全球'
})())
ok('模型：可结构化克隆（无 Proxy / 函数）', (() => { try { structuredClone(D); return true } catch { return false } })())
const st = beamMapStats(D)
ok('模型：统计读数', st.beams === 3 && st.contours === 5 && st.polygons === 2 && st.markers === 3, JSON.stringify(st))

/* ---------- ② 标准库默认值 = 菜单导出（逐字节对拍） ---------- */
// 参照：ConstellationMap3D.vue 的 collectGxt / collectPolyBeams / exportDrawn 原样口径
const closeRing = (pts) => { const f = pts[0], l = pts[pts.length - 1]; return (f[0] === l[0] && f[1] === l[1]) ? pts : [...pts, f] }
const covBeams = [
  ...RAW.library.map((b) => ({ name: b.beam, satName: b.satName, lon: b.lon, band: b.band || '', type: b.type || 'EIRP', bore: b.bore || [], contours: b.contours.map((c) => ({ g: c.g, p: c.p })), emiRcp: 'E' })),
  ...RAW.antenna.map((b) => ({ name: b.name, satName: b.satName, lon: b.lon, bore: b.bore, contours: b.contours.map((c) => ({ g: c.g, p: c.p })) }))
]
const polyList = RAW.polygons.filter((pg) => pg.show !== false && pg.pts && pg.pts.length >= 3)
const groups = new Map()
for (const pg of polyList) { const key = `${(pg.satName || '').trim()}|${(pg.satLon || '').toString().trim()}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(pg) }
const polyBeams = [...groups.values()].map((gs) => {
  const g0 = gs[0], lonN = Number(g0.satLon)
  return { name: 'Polygon', satName: (g0.satName || '').trim() || 'Polygon', lon: Number.isFinite(lonN) ? lonN : 0, bore: [], contours: gs.map((pg) => { const v = Number(pg.value); return { g: Number.isFinite(v) ? v : 0, p: closeRing(pg.pts) } }), emiRcp: 'E' }
})
const refGxt = [...covBeams, ...polyBeams].map((b, i) => serializeGxt({ ...b, beamId: b.name || (i + 1) })).join('\r\n')
const refKml = serializeKml(covBeams, { name: '当前绘制', polys: polyList })
const S = createStdlib('zh')
ok('对拍：gxt(data) 与菜单「导出 GXT」逐字节一致', S.gxt(D) === refGxt, `${S.gxt(D).length} vs ${refGxt.length}`)
ok('对拍：kml(data,{name}) 与菜单「导出 KML」逐字节一致', S.kml(D, { name: '当前绘制' }) === refKml, `${S.kml(D, { name: '当前绘制' }).length} vs ${refKml.length}`)
ok('序列化器：缺省参数逐字节不变（adm=G 定宽、3 位小数）', serializeGxt({ lon: 1, satName: 'S', contours: [{ g: 1, p: [[1, 2], [3, 4]] }] }).includes('adm=G  \r\n') && serializeGxt({ lon: 1, contours: [{ g: 1, p: [[1, 2], [3, 4]] }] }).includes('p1=1.000;2.000'))
const g2 = S.gxt(D.beams[0], { adm: 'CHN', digits: 4, reason: 'A', beamId: (b, i) => 'X' + i })
ok('gxt 选项：adm / digits / reason / beamId 收到模型对象', g2.includes('adm=CHN') && g2.includes('p1=112.0000;27.0000') && g2.includes('reason=A') && g2.includes('beam_id=X0'))
const k2 = S.kml(D, { colors: 'drawn', lineWidth: 3, fillOpacity: 0.5, contourName: (c, b) => `${b.type} ${c.level} ${b.unit}`, polygons: false })
ok('kml 选项：drawn 配色 / 线宽 / 不透明度 / contourName 收到模型对象', k2.includes('<color>ff0033ff</color><width>3</width>') && k2.includes('<color>800033ff</color>') && k2.includes('<name>EIRP 48 dBW</name>') && !k2.includes('协调区'))

/* ---------- ③ 几何 / 配色 / 格式化 ---------- */
const { geo, color, fmt, csv, xml } = S
ok('geo.distance：北京—上海 ≈ 1067 km（Vincenty）', near(geo.distance([116.4074, 39.9042], [121.4737, 31.2304]), 1067.3, 1.5), fmt(geo.distance([116.4074, 39.9042], [121.4737, 31.2304]), 2))
ok('geo.distance：同点为 0、跨日界线取短弧', geo.distance([10, 10], [10, 10]) === 0 && near(geo.distance([179.5, 0], [-179.5, 0]), 111.32, 0.2))
ok('geo.area：赤道 1°×1° ≈ 12364 km²', near(geo.area([[0, 0], [1, 0], [1, 1], [0, 1]]), 12364, 15), fmt(geo.area([[0, 0], [1, 0], [1, 1], [0, 1]]), 1))
ok('geo.area：闭合与否同值、方向无关', near(geo.area(closed(ring(10, 40, 2))), geo.area(ring(10, 40, 2)), 1e-6) && near(geo.area([...ring(10, 40, 2)].reverse()), geo.area(ring(10, 40, 2)), 1e-6))
ok('geo.contains：内 / 外', geo.contains(ring(115, 30, 3), [115, 30]) && !geo.contains(ring(115, 30, 3), [119, 30]))
const am = [[178, -2], [-178, -2], [-178, 2], [178, 2]]
ok('geo.contains：跨日界线的环', geo.contains(am, [179.5, 0]) && geo.contains(am, [-179.5, 0]) && !geo.contains(am, [170, 0]))
ok('geo.levelAt：取包住该点的最高档，外面为 null', geo.levelAt(D.beams[0], 115, 30) === 48 && geo.levelAt(D.beams[0], 118.5, 30) === 44.5 && geo.levelAt(D.beams[0], 130, 30) === null && geo.levelAt(D.beams[2], 101, 21) === -1)
const circle = []; for (let i = 0; i <= 360; i++) circle.push([100 + 5 * Math.cos(i * Math.PI / 180), 20 + 5 * Math.sin(i * Math.PI / 180)])
const simp = geo.simplify(circle, 5)
ok('geo.simplify：闭合环仍闭合、点数显著减少', geo.isClosed(simp) && simp.length < 60 && simp.length >= 4, `${circle.length}→${simp.length}`)
ok('geo.simplify：容差 0 原样', geo.simplify(circle, 0).length === circle.length)
const dens = geo.densify([[0, 0], [10, 0]], 100)
ok('geo.densify：步长不超过上限', dens.length === 13 && dens.every((p, i) => !i || geo.distance(dens[i - 1], p) <= 100.5), dens.length)
const sArea = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1] } return a / 2 }
ok('geo.orient：ccw / cw', sArea(geo.orient(ring(0, 0, 1), 'cw')) < 0 && sArea(geo.orient([...ring(0, 0, 1)].reverse(), 'ccw')) > 0 && JSON.stringify(geo.orient(ring(0, 0, 1), 'ccw')) === JSON.stringify(ring(0, 0, 1)))
ok('geo.close / open', geo.close(ring(0, 0, 1)).length === 5 && geo.open(closed(ring(0, 0, 1))).length === 4 && geo.close(closed(ring(0, 0, 1))).length === 5)
ok('geo.bbox：整份 data', JSON.stringify(geo.bbox(D)) === JSON.stringify([89, -8, 142, 39.9]), JSON.stringify(geo.bbox(D)))
ok('geo.centroid', JSON.stringify(geo.centroid(ring(115, 30, 3)).map((v) => +v.toFixed(9))) === JSON.stringify([115, 30]))
ok('geo.dms', geo.dms(116.391, 'lon') === '116°23′27.6″E' && geo.dms(-33.5, 'lat', 0) === '33°30′00″S' && geo.dms(0.99999999, 'lat') === '1°00′00.0″N', geo.dms(116.391, 'lon'))
const gcj = geo.toGCJ02([116.397428, 39.90923])
ok('geo.toGCJ02：北京偏移量级 ~0.006°、境外不变', near(gcj[0] - 116.397428, 0.0062, 0.002) && near(gcj[1] - 39.90923, 0.0014, 0.002) && JSON.stringify(geo.toGCJ02(2.35, 48.85)) === JSON.stringify([2.35, 48.85]))
const bd = geo.toBD09(116.397428, 39.90923), back = geo.fromBD09(bd)
ok('geo.toBD09 / fromBD09 回环 < 1e-6°', near(back[0], 116.397428, 1e-6) && near(back[1], 39.90923, 1e-6))
const pj = geo.fit([100, 20, 110, 30], 1000, 500, 0)
ok('geo.fit：等经纬度、居中', near(pj.scale, 50, 1e-9) && near(pj.x(100), 250, 1e-9) && near(pj.y(30), 0, 1e-9) && near(pj.y(20), 500, 1e-9))
// 跨 ±180°：环按连续经度取外包框（东 > 180），多环取一致参考；取景内 −179° 与 179° 相邻
const amRing = [[170, -10], [179.5, -12], [-178, -5], [-175, 5], [-179, 12], [172, 8], [170, -10]]
ok('geo.bbox：跨日界线的环', JSON.stringify(geo.bbox(amRing)) === JSON.stringify([170, -12, 185, 12]), JSON.stringify(geo.bbox(amRing)))
ok('geo.bbox：两环分处日界线两侧', JSON.stringify(geo.bbox([{ points: [[175, 0], [178, 2], [176, 4]] }, { points: [[-178, 0], [-172, 1], [-175, 3]] }])) === JSON.stringify([175, 0, 188, 4]))
ok('geo.bbox：环绕极区（经度跨满 360°）取全经度', JSON.stringify(geo.bbox([[0, 80], [90, 80], [180, 80], [-90, 80], [0, 80]])) === JSON.stringify([-180, 80, 180, 80]))
ok('geo.bbox：不跨日界线时与逐点极值一致', JSON.stringify(geo.bbox([[-170, 0], [-10, 5], [100, -5]])) === JSON.stringify([-170, -5, 100, 5]))
const pjAm = geo.fit(geo.bbox(amRing), 1500, 2400, 0)
ok('geo.fit：跨日界线取景、相邻顶点不横跳', near(pjAm.scale, 100, 1e-9) && near(pjAm.x(-178), pjAm.x(182), 1e-9) && near(pjAm.x(170), 0, 1e-9) && near(pjAm.x(-175), 1500, 1e-9) &&
  amRing.every((q, i) => !i || Math.abs(pjAm.x(q[0]) - pjAm.x(amRing[i - 1][0])) < 1000))
ok('color.kml / css / ramp / mix', color.kml('#ff8000', 0.2) === '330080ff' && color.css('#ff8000', 0.5) === 'rgba(255,128,0,0.5)' && color.ramp(0) === color.ramp(-1) && color.mix('#000000', '#ffffff', 0.5) === '#808080')
// 地图 gainHex（ConstellationMap3D.vue）原式
const gainHex = (t) => { const h = (1 - t) * 240 / 360, s = 0.9, l = 0.55, a = s * Math.min(l, 1 - l); const f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }; return '#' + ((Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255)).toString(16).padStart(6, '0') }
ok('color.ramp gain = 地图 gainHex（蓝→红）', [0, 0.25, 0.5, 0.8, 1].every((t) => color.ramp(t) === gainHex(t)), color.ramp(0) + ' ' + color.ramp(1))
ok('fmt：不出 -0、非数为空', fmt(-0.0001, 2) === '0.00' && fmt(NaN) === '' && fmt(1.23456, 2) === '1.23')
ok('csv：RFC 4180 引号与 CRLF', csv([{ a: 1, b: 'x,y' }, { a: 'q"t', b: ' s' }]) === 'a,b\r\n1,"x,y"\r\n"q""t"," s"\r\n')
ok('csv：数组行 + header', csv([[1, 2]], { header: ['x', 'y'], eol: 'lf' }) === 'x,y\n1,2\n')
ok('xml.esc / cdata', xml.esc(`<a href="x">&'`) === '&lt;a href=&quot;x&quot;&gt;&amp;&apos;' && xml.cdata('a]]>b') === '<![CDATA[a]]]]><![CDATA[>b]]>')

/* ---------- 编码 ---------- */
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join(' ')
ok('encode：utf-8-bom', hex(encodeText('A', 'utf-8-bom').bytes) === 'ef bb bf 41')
ok('encode：gbk「中文」= D6D0 CEC4', hex(encodeText('中文A', 'gbk').bytes) === 'd6 d0 ce c4 41', hex(encodeText('中文A', 'gbk').bytes))
ok('encode：gbk 表外字符记 ? 并计数', (() => { const r = encodeText('a😀', 'gbk'); return hex(r.bytes) === '61 3f' && r.unmapped === 1 })())
ok('encode：latin1 超范围记 ?', (() => { const r = encodeText('é中', 'latin1'); return hex(r.bytes) === 'e9 3f' && r.unmapped === 1 })())
ok('encode：utf-16le 带 BOM', hex(encodeText('A中', 'utf-16le').bytes) === 'ff fe 41 00 2d 4e')
ok('encode：别名归一 / 认不出为 null', normEncoding('UTF8') === 'utf-8' && normEncoding('gb2312') === 'gbk' && normEncoding('utf-8-sig') === 'utf-8-bom' && normEncoding('ebcdic') === null && normEncoding('') === 'utf-8')
ok('encode：换行归一', applyEol('a\nb\r\nc\rd', 'crlf') === 'a\r\nb\r\nc\r\nd' && applyEol('a\r\nb\rc', 'lf') === 'a\nb\nc')

/* ---------- Shapefile ---------- */
const shp = S.shapefile('t', S.features(D, { peaks: false, markers: false }))
const byExt = Object.fromEntries(shp.map((f) => [f.name.split('.').pop(), f]))
const sv = new DataView(byExt.shp.content.buffer)
ok('shapefile：五件套', ['shp', 'shx', 'dbf', 'prj', 'cpg'].every((e) => byExt[e]) && byExt.cpg.content === 'UTF-8' && byExt.prj.content.includes('WGS_1984'))
ok('shapefile：文件码 9994、长度（16 位字）、类型 5（面）', sv.getInt32(0, false) === 9994 && sv.getInt32(24, false) * 2 === byExt.shp.content.byteLength && sv.getInt32(32, true) === 5)
const nRec = 5 + 2   // 5 条等值线 + 2 个 Polygon
ok('shapefile：shx 记录数', (byExt.shx.content.byteLength - 100) / 8 === nRec)
const dv = new DataView(byExt.dbf.content.buffer)
ok('shapefile：dbf 记录数 / 头长 / 结尾 0x1A', dv.getUint32(4, true) === nRec && byExt.dbf.content[byExt.dbf.content.length - 1] === 0x1A && byExt.dbf.content[dv.getUint16(8, true) - 1] === 0x0D)
const fieldNames = []; for (let o = 32; byExt.dbf.content[o] !== 0x0D; o += 32) fieldNames.push(String.fromCharCode(...byExt.dbf.content.subarray(o, o + 11)).replace(/\0+$/, ''))
ok('shapefile：字段名 ≤10 个 ASCII 且唯一', fieldNames.every((n) => /^[A-Z0-9_]{1,10}$/.test(n)) && new Set(fieldNames).size === fieldNames.length && fieldNames.includes('LEVEL') && fieldNames.includes('FILLOPACIT'), fieldNames.join(','))
// 第一条记录：外环顺时针（Shapefile 约定）
const np0 = sv.getInt32(100 + 8 + 40, true)
const pts0 = []; for (let k = 0; k < np0; k++) pts0.push([sv.getFloat64(100 + 8 + 48 + 16 * k, true), sv.getFloat64(100 + 8 + 56 + 16 * k, true)])
let sa = 0; for (let k = 0; k < pts0.length - 1; k++) sa += pts0[k][0] * pts0[k + 1][1] - pts0[k + 1][0] * pts0[k][1]
ok('shapefile：首记录闭合、外环顺时针', np0 === 5 && pts0[0][0] === pts0[4][0] && sa < 0, `np=${np0} sa=${sa}`)
ok('shapefile：混合几何报错', (() => { try { S.shapefile('x', S.features(D)); return false } catch (e) { return /多种几何类型/.test(e.message) && !/请先/.test(e.message) } })())
ok('shapefile：GBK 写 .cpg=936', S.shapefile('g', S.features(D, { contours: false, polygons: false }), { encoding: 'gbk' }).find((f) => f.name === 'g.cpg').content === '936')

/* ---------- ZIP ---------- */
const z = S.zip('a.kmz', [S.file('doc.kml', '<kml/>'), S.file('sub/中文.txt', '中', { encoding: 'gbk' })])
const uz = unzipSync(z.content)
ok('zip：条目顺序、内容、条目自带编码', Object.keys(uz)[0] === 'doc.kml' && new TextDecoder().decode(uz['doc.kml']) === '<kml/>' && hex(uz['sub/中文.txt']) === 'd6 d0')
ok('zip：重名报错', (() => { try { S.zip('x.zip', [S.file('a', '1'), S.file('a', '2')]); return false } catch { return true } })())

/* ---------- ④ 运行时 ---------- */
const r1 = await runScript('const a = 1\nconsole.log("x", { k: [1, 2] })\nreturn file("o.txt", "hi")', D, { scriptName: 's' })
ok('runtime：正常运行、console 行号', r1.ok && r1.files[0].name === 'o.txt' && r1.logs[0].line === 2 && r1.logs[0].text === 'x {k: [1, 2]}', JSON.stringify(r1.logs))
const r2 = await runScript('const a = 1\n\nconst b = data.beams[0].nope.x', D)
ok('runtime：运行期异常映射回用户行号', !r2.ok && r2.error.line === 3 && r2.error.name === 'TypeError', JSON.stringify(r2.error))
const r3 = await runScript('let x = 1\nreturn x +', D)
ok('runtime：语法错带行列', !r3.ok && r3.error.name === 'SyntaxError' && r3.error.line === 2, JSON.stringify(r3.error))
ok('runtime：import() / import.meta 被静态检查拦下', checkSource('const m = await import("x")').name === 'SecurityError' && checkSource('const u = import.meta.url') !== null && checkSource('// import("x")\nconst s = "import(x)"') === null)
const r4 = await runScript('return typeof self + typeof fetch + typeof globalThis + typeof process', D)
ok('runtime：遮蔽名拿不到真身', r4.ok && r4.files[0].text === 'undefinedundefinedundefinedundefined', r4.files[0] && r4.files[0].text)
const r5 = await runScript('const self = 1, close = 2\nreturn String(self + close)', D)
ok('runtime：用户可自行声明与遮蔽名同名的变量', r5.ok && r5.files[0].text === '3', JSON.stringify(r5.error))
const r6 = await runScript('return "hello"', D, { scriptName: '我的:脚本' })
ok('runtime：返回字符串 → 脚本名.txt（非法字符替换）', r6.ok && r6.files[0].name === '我的_脚本.txt')
const r7 = await runScript('return { a: 1 }', D, { scriptName: 'j' })
ok('runtime：返回对象 → JSON', r7.ok && r7.files[0].name === 'j.json' && JSON.parse(r7.files[0].text).a === 1)
const r8 = await runScript('return [file("a.txt", "1"), file("A.TXT", "2")]', D)
ok('runtime：重名（不分大小写）报错', !r8.ok && /重复/.test(r8.error.message))
const r9 = await runScript('return [file("../x.txt", "1")]', D)
ok('runtime：路径穿越被拒', !r9.ok && /无效/.test(r9.error.message))
const r10 = await runScript('return [file("a.txt", "1"), "b"]', D)
ok('runtime：数组里混入非 file 报错', !r10.ok && /file\(\)/.test(r10.error.message))
const r11 = await runScript('return file("g.txt", "a😀", { encoding: "gbk" })', D)
ok('runtime：GBK 表外字符给出告警、回传字节', r11.ok && r11.files[0].unmapped === 1 && r11.files[0].bytes.length === 2 && r11.logs.some((l) => l.level === 'warn'))
const r12 = await runScript('data.beams.length = 0\nreturn String(data.beams.length)', structuredClone(D))
ok('runtime：脚本可改 data（各轮独立副本由 Worker 保证）', r12.ok && r12.files[0].text === '0')
const r13 = await runScript('return [[file("a.txt","1")], [file("b.txt","2")]]', D)
ok('runtime：嵌套数组展平', r13.ok && r13.files.length === 2)
const r14 = await runScript('return', D)
ok('runtime：无返回值 → 无输出、不算错', r14.ok && r14.files.length === 0)
const r15 = await runScript('return file("a.txt", "x\\ny", { eol: "crlf" })', D)
ok('runtime：eol 落进回传文本与字节数', r15.ok && r15.files[0].text === 'x\r\ny' && r15.files[0].size === 4)
const r16 = await runScript('const t = []\nfor (let i = 0; i < 2100; i++) console.log(i)\nreturn', D)
ok('runtime：日志封顶', r16.ok && r16.logs.length === 2001 && r16.logs[2000].level === 'warn')
const r17 = await runScript('throw "plain"', D)
ok('runtime：抛非 Error 值', !r17.ok && r17.error.message === 'plain')
const r18 = await runScript('return file("x.txt", "1", { encoding: "ebcdic" })', D, { lang: 'en' })
ok('runtime：报错文本随语言（英文）', !r18.ok && /unsupported encoding/.test(r18.error.message) && r18.error.line === 1)

/* ---------- 模板 ---------- */
const TPL_DIR = join(SB, 'templates')
const rawMap = Object.fromEntries(readdirSync(TPL_DIR).filter((f) => f.endsWith('.bmjs')).map((f) => [f, readFileSync(join(TPL_DIR, f), 'utf8')]))
const hasCanvas = typeof OffscreenCanvas === 'function'
for (const lang of ['zh', 'en']) {
  const tpls = parseTemplates(rawMap, lang)
  ok(`模板（${lang}）：${tpls.length} 个、id 唯一、元数据齐`, tpls.length >= 14 && new Set(tpls.map((t) => t.id)).size === tpls.length && tpls.every((t) => t.id && t.name && t.ext && !/⟪|⟫|\/\/(zh|en)\b|\/\/!/.test(t.code + t.name)))
  for (const t of tpls) {
    if (!hasCanvas && /\bpng\(/.test(t.code)) { ok(`模板（${lang}）${t.id}：需要 OffscreenCanvas，Node 下跳过（仅查语法）`, checkSource(t.code) === null); continue }
    const r = await runScript(t.code, structuredClone(D), { lang, scriptName: t.name })
    ok(`模板（${lang}）${t.id}：跑通且有输出`, r.ok && r.files.length > 0 && r.files.every((f) => f.size > 0), r.ok ? r.files.map((f) => `${f.name}:${f.size}`).join(' ') : JSON.stringify(r.error))
  }
}
const tz = parseTemplates(rawMap, 'zh')
const byId = Object.fromEntries(tz.map((t) => [t.id, t]))
const tg = await runScript(byId.gxt.code, structuredClone(D), {})
ok('模板 gxt：内容 = 菜单导出', tg.ok && tg.files[0].text === refGxt)
const tk = await runScript(byId.kml.code, structuredClone(D), {})
ok('模板 kml：内容 = 菜单导出', tk.ok && tk.files[0].text === refKml)
const tkz = await runScript(byId['kmz-drawn'].code, structuredClone(D), {})
ok('模板 kmz：ZIP 内首条为 doc.kml、等值线名带单位', tkz.ok && (() => { const u = unzipSync(tkz.files[0].bytes); const k = new TextDecoder().decode(u['doc.kml']); return Object.keys(u)[0] === 'doc.kml' && k.includes('<name>EIRP 48 dBW</name>') })())
const tgj = await runScript(byId['gxt-json'].code, structuredClone(D), {})
const gjNames = tgj.ok ? tgj.files.map((f) => f.name) : []
ok('模板 gxt-json：按卫星分目录、四段式文件名、Polygon 按组', tgj.ok && gjNames.includes('中星10R/中星10R_Ku_东部波束_EIRP.json') && gjNames.includes('APSTAR 6D/APSTAR 6D_C_全球_GT.json') &&
  gjNames.includes('GRD星/GRD星_GRD_Beam 1_EIRP.json') && gjNames.includes('中星10R/Polygon.json') && gjNames.includes('Polygon/Polygon.json'), gjNames.join(' | '))
const { parseGxtJson } = await import('../../../src/viz/gxt/json.js')
const gjOf = (n) => parseGxtJson(tgj.files.find((f) => f.name === n).text)
ok('模板 gxt-json：内容可被解析、GT 记 R、波束中心电平带上（天线峰值也带）', (() => {
  const a = gjOf('中星10R/中星10R_Ku_东部波束_EIRP.json'), b = gjOf('APSTAR 6D/APSTAR 6D_C_全球_GT.json'), c = gjOf('GRD星/GRD星_GRD_Beam 1_EIRP.json')
  return a.lon === 110.5 && a.satName === '中星10R' && a.emiRcp === 'E' && a.bore[0][2] === 52.3 && a.contours.length === 2 && b.emiRcp === 'R' && c.bore[0][2] === 0 && c.contours.length === 2
})())
ok('模板 gxt-json：单行、坐标 3 位小数', tgj.ok && tgj.files.every((f) => !f.text.includes('\n')) && /\[112,27\]/.test(tgj.files.find((f) => f.name.endsWith('东部波束_EIRP.json')).text))
ok('gxtJson()：非波束参数报错', (() => { try { S.gxtJson(D); return false } catch (e) { return /单个波束/.test(e.message) } })())
const tshp = await runScript(byId.shapefile.code, structuredClone(D), {})
ok('模板 shapefile：ZIP 含两套五件套', tshp.ok && Object.keys(unzipSync(tshp.files[0].bytes)).length === 10)
const tcsv = await runScript(byId['csv-sites'].code, structuredClone(D), {})
ok('模板 csv-sites：BOM + 杭州站落在 48 档', tcsv.ok && tcsv.files[0].bytes[0] === 0xEF && tcsv.files[0].text.split('\r\n')[2].includes(',48,'), tcsv.files[0] && tcsv.files[0].text.split('\r\n')[2])
const tmif = await runScript(byId.mapinfo.code, structuredClone(D), {})
ok('模板 mapinfo：mif/mid 两件、GBK、行数对应', tmif.ok && tmif.files.length === 2 && tmif.files[0].encoding === 'gbk' && tmif.files[1].text.trim().split('\r\n').length === (tmif.files[0].text.match(/^(Region|Point) /gm) || []).length)
const tper = await runScript(byId['gxt-per-beam'].code, structuredClone(D), {})
ok('模板 gxt-per-beam：一波束一文件 + Polygon', tper.ok && tper.files.length === 4 && tper.files[0].name === '中星10R_Ku_东部波束_EIRP.gxt' && tper.files[2].name === 'GRD星_Beam 1_GRD.gxt', tper.files && tper.files.map((f) => f.name).join(' | '))
const tEn = parseTemplates(rawMap, 'en').find((x) => x.id === 'gxt')
const rEn = await runScript(tEn.code, buildBeamMap({ ...RAW, meta: { ...RAW.meta, lang: 'en' } }), { lang: 'en' })
ok('模板：英文版去掉中文注释行、文件名随 meta.title（英文缺省 Current drawing）', !/[一-龥]/.test(tEn.code) && rEn.ok && rEn.files[0].name === 'Current drawing.gxt' && tg.files[0].name === '当前绘制.gxt', rEn.ok ? rEn.files[0].name : '')
ok('localize：//zh //en 行与 ⟪|⟫ 片段', localize('a\n//zh 甲\n//en B\n  //zh 丙\nx(⟪中|en⟫)', 'zh') === 'a\n// 甲\n  // 丙\nx(中)' && localize('//zh 甲\n//en B\n⟪中|en⟫', 'en') === '// B\nen')
for (const lang of ['zh', 'en']) {
  const r = await runScript(blankScript(lang), structuredClone(D), { lang })
  ok(`新建脚本（${lang}）起手式可跑`, r.ok && r.files.length === 1 && r.files[0].text.split('\n').length === 3)
}

/* ---------- 覆盖库来源（文件管理「GXT/KML 管理」，coverageLib.js） ---------- */
const { libraryBeamMapRaw, gainRampHex } = await import('../../../src/shared/beamScript/coverageLib.js')
// 色标须与 3D 页新建批次的缺省「渐变」同式：直接从 ConstellationMap3D.vue 抠出 gainHex 原文来比
const src3d = readFileSync(join(ROOT, 'src/pages/ConstellationMap3D.vue'), 'utf8')
const gh = /function gainHex\(t\) \{[\s\S]*?\n\}/.exec(src3d)
const gainHex3D = gh ? new Function('clamp01', gh[0] + '\nreturn gainHex')((v) => Math.max(0, Math.min(1, v))) : null
ok('覆盖库：色标与 3D 页 gainHex 同式', !!gainHex3D && Array.from({ length: 21 }, (_, i) => i / 20).every((t) => gainRampHex(t) === '#' + gainHex3D(t).toString(16).padStart(6, '0')))
const LIB = [
  { satName: '中星6A', lon: 125, band: 'C', beam: '全国', type: 'EIRP', bore: [[110, 35, 41.2]], contours: [{ g: 40, p: closed(ring(110, 35, 2)) }, { g: 36, p: closed(ring(110, 35, 6)) }] },
  { satName: '中星6A', lon: 125, band: 'C', beam: '亚洲', type: 'EIRP', bore: [], contours: [{ g: 34, p: closed(ring(110, 30, 12)) }] },
  { satName: '中星6A', lon: 125, band: 'C', beam: '全国', type: 'GT', bore: [], contours: [{ g: 2, p: closed(ring(110, 35, 3)) }] }
]
const LM = { title: '中星6A', version: '1.5.2', simTime: Date.UTC(2026, 9, 15, 4), lang: 'zh' }
const L = buildBeamMap(libraryBeamMapRaw(LIB, LM))
ok('覆盖库：scope / title、只有覆盖库波束且按给定顺序', L.meta.scope === 'library' && L.meta.title === '中星6A' && L.beams.length === 3 && L.beams.every((b) => b.source === 'library') && L.beams.map((b) => b.name).join() === '全国,亚洲,全国' && !L.polygons.length && !L.stations.length)
ok('覆盖库：同星同类型共用一条色标（低蓝高红），另一类型单独成标', L.beams[0].contours[0].color === gainRampHex(1) && L.beams[1].contours[0].color === gainRampHex(0) && L.beams[0].contours[1].color === gainRampHex(2 / 6) && L.beams[2].contours[0].color === gainRampHex(1) && gainRampHex(0) !== gainRampHex(1))
ok('覆盖库：波束中心电平、单位', L.beams[0].peaks[0].value === 41.2 && L.beams[0].unit === 'dBW' && L.beams[2].unit === 'dB/K')
// 对拍文件管理单波束「导出 GXT」（归一化数据重建那条：内置波束 / 无原文的用户波束）与「导出 KML」
const one = LIB[0]
const L1 = buildBeamMap(libraryBeamMapRaw([one], { ...LM, title: '中星6A_全国' }))
ok('覆盖库：gxt(data) 与文件管理「导出 GXT」逐字节一致', S.gxt(L1) === serializeGxt({ lon: one.lon, satName: one.satName, bore: one.bore, contours: one.contours, beamId: one.beam, emiRcp: 'E' }))
const fmKml = serializeKml([{ name: one.beam, satName: one.satName, lon: one.lon, type: one.type, band: one.band, bore: one.bore, contours: one.contours }], { name: '中星6A 全国' })
ok('覆盖库：kml(data,{name}) 与文件管理「导出 KML」逐字节一致', S.kml(L1, { name: '中星6A 全国' }) === fmKml)
ok('覆盖库：kml(data) 文档名缺省取 meta.title', S.kml(L1).includes('<name>中星6A_全国</name>'))
for (const lang of ['zh', 'en']) {
  for (const t of parseTemplates(rawMap, lang)) {
    if (!hasCanvas && /\bpng\(/.test(t.code)) continue
    const r = await runScript(t.code, structuredClone(L), { lang, scriptName: t.name })
    ok(`覆盖库数据跑模板（${lang}）${t.id}`, r.ok && (r.files.length > 0 || r.logs.some((l) => l.level === 'warn')), r.ok ? r.files.map((f) => `${f.name}:${f.size}`).join(' ') : JSON.stringify(r.error))
  }
}
const lg = await runScript(byId.gxt.code, structuredClone(L), {}), lk = await runScript(byId.kml.code, structuredClone(L), {})
ok('覆盖库：模板文件名 / KML 文档名随 meta.title', lg.ok && lg.files[0].name === '中星6A.gxt' && lk.ok && lk.files[0].name === '中星6A.kml' && lk.files[0].text.includes('<name>中星6A</name>'))

/* ---------- 类型声明 ---------- */
const dtsRaw = readFileSync(join(SB, 'beammap.dts.txt'), 'utf8')
for (const lang of ['zh', 'en']) {
  const d = localize(dtsRaw, lang)
  const missing = STDLIB_NAMES.filter((n) => !new RegExp(`declare (const|function) ${n}\\b`).test(d))
  ok(`类型声明（${lang}）：标准库全部声明、data / console 在、无残留标记`, !missing.length && /declare const data: BeamMap/.test(d) && /declare const console/.test(d) && !/⟪|⟫/.test(d), missing.join(','))
}
ok('类型声明英文版不含中文（示例文件名除外）', !/[一-龥]/.test(localize(dtsRaw, 'en').replace(/'当前绘制'/g, '')))

console.log(`\n可编程波束地图：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
