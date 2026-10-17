// 可编程波束地图 · 导入自测（src/shared/beamScript/{miniXml,importStdlib,importModel,importRuntime,importTemplates}）：运行 npm test。
// 钉住：① 极简 XML DOM（KML 解析器在 Worker 里靠它）；② 标准库各读取器；③ 返回值归一化口径；④ 运行时报错行号；
// ⑤ 全部内置导入模板两种语言下都能跑，且与导出模板一来一回同构（GeoJSON / CSV / Shapefile / MapInfo 导出后原样读回）；
// ⑥ 基带网管 CONSTELLATION_OPT（[纬度, 经度] 换序、kHz / MHz 混写、载波挂到波束）；⑦ 匹配声明与自动认格式。
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const SB = join(ROOT, 'src/shared/beamScript')
const { parseXml, MiniDOMParser } = await import('../../../src/shared/beamScript/miniXml.js')
const { createImportStdlib, sniffDecode, makeInputFile } = await import('../../../src/shared/beamScript/importStdlib.js')
const { normalizeImport, toLibraryItems, normType } = await import('../../../src/shared/beamScript/importModel.js')
const { runImport, scriptMatchInfo, scriptAccepts, autoImport, acceptingOrder, recognized } = await import('../../../src/shared/beamScript/importRuntime.js')
const { parseImportTemplates, NATIVE_TEMPLATE_IDS, blankImportScript } = await import('../../../src/shared/beamScript/importTemplates.js')
const { buildBeamMap } = await import('../../../src/shared/beamScript/model.js')
const { runScript } = await import('../../../src/shared/beamScript/runtime.js')
const { parseTemplates } = await import('../../../src/shared/beamScript/templates.js')
const { createStdlib } = await import('../../../src/shared/beamScript/stdlib.js')
const { serializeGxt } = await import('../../../src/viz/gxt/serialize.js')
const { serializeGxtJson } = await import('../../../src/viz/gxt/json.js')
const { serializeKml } = await import('../../../src/viz/kml/serialize.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra != null && extra !== '' ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const enc = (s) => new TextEncoder().encode(s)
const F = (name, content) => ({ name, bytes: typeof content === 'string' ? enc(content) : content })
const ring = (lon0, lat0, r) => [[lon0 - r, lat0 - r], [lon0 + r, lat0 - r], [lon0 + r, lat0 + r], [lon0 - r, lat0 + r]]
const closed = (p) => [...p, p[0]]
const S = createImportStdlib('zh')

/* ---------- ① 极简 XML DOM ---------- */
{
  const d = parseXml('﻿<?xml version="1.0"?><!-- c --><kml xmlns="x" xmlns:gx="y"><Document><name>A &amp; B &#x4E2D;</name><gx:Tour id="t1"/><Folder><name><![CDATA[<raw>]]></name></Folder></Document></kml>')
  ok('XML：根、子元素、实体与 CDATA', d.documentElement.tagName === 'kml' && d.getElementsByTagName('name')[0].textContent === 'A & B 中' && d.getElementsByTagName('name')[1].textContent === '<raw>')
  ok('XML：前缀元素 localName / getElementsByTagNameNS(*)、属性', d.getElementsByTagNameNS('*', 'Tour')[0].getAttribute('id') === 't1' && d.getElementsByTagName('gx:Tour').length === 1 && d.documentElement.getAttribute('xmlns:gx') === 'y')
  ok('XML：children / firstElementChild / parentNode', d.documentElement.children.length === 1 && d.documentElement.firstElementChild.tagName === 'Document' && d.getElementsByTagName('Folder')[0].parentNode.tagName === 'Document')
  ok('XML：标签不配对报错带行号', (() => { try { parseXml('<a>\n<b></a>'); return false } catch (e) { return /line 2/.test(e.message) } })())
  ok('XML：DOMParser 替身语法错返回 parsererror 文档', new MiniDOMParser().parseFromString('<a><b></a>').getElementsByTagName('parsererror').length === 1)
}

/* ---------- ② 标准库 ---------- */
ok('解码：UTF-8 / BOM / UTF-16LE', sniffDecode(enc('中文')).text === '中文' && sniffDecode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])).encoding === 'utf-8-bom' && sniffDecode(new Uint8Array([0xff, 0xfe, 0x41, 0x00])).text === 'A')
ok('解码：GBK 回退', (() => { const r = sniffDecode(new Uint8Array([0xd6, 0xd0, 0xd0, 0xc7])); return r.encoding === 'gbk' && r.text === '中星' })())
ok('输入文件：base / ext / text 懒解码', (() => { const f = makeInputFile('dir/中星_Ku.GXT', enc('x=1')); return f.base === '中星_Ku' && f.ext === 'gxt' && f.text === 'x=1' && f.size === 3 })())
ok('CSV：引号 / 内嵌逗号换行 / 分号自动识别 / 表头', (() => {
  const r = S.csv('a;b\r\n"x;1";"he said ""hi"""\n\n3;4\n', { header: true })
  const r2 = S.csv('a,b\n"1\n2",3')
  return r.length === 2 && r[0].a === 'x;1' && r[0].b === 'he said "hi"' && r[1].b === '4' && r2[1][0] === '1\n2'
})())
ok('JSON：报错说明', (() => { try { S.json('{\n "a": }'); return false } catch (e) { return /^JSON 解析失败/.test(e.message) } })())
ok('num：宽松解析', S.num(' 12.5 ') === 12.5 && S.num('1,234.5') === 1234.5 && S.num('48dBW') === 48 && S.num('-0.5') === -0.5 && S.num('abc') === null && S.num('') === null && S.num(null) === null)
ok('unzip：取出文件（带子目录、跳过目录项）', (() => { const z = zipSync({ 'a/b.txt': enc('hi'), 'c.json': enc('{}') }); const l = S.unzip(z); return l.length === 2 && l.find((f) => f.name === 'a/b.txt').text === 'hi' })())
const KML_BEAMS = [{ name: '东部', satName: '中星10R', lon: 110.5, band: 'Ku', type: 'EIRP', bore: [[115, 30]], contours: [{ g: 48, p: closed(ring(115, 30, 3)) }, { g: 44, p: closed(ring(115, 30, 5)) }] }]
const kmlText = serializeKml(KML_BEAMS, { name: '测试' })
ok('kml()：Node 无 DOMParser 时用替身、读回卫星 / 波束 / 档位', (() => { const r = S.kml(kmlText); return typeof globalThis.DOMParser === 'undefined' && r.beams.length === 1 && r.beams[0].satName === '中星10R' && r.beams[0].contours.length === 2 && r.beams[0].lon === 110.5 })())
ok('kml()：KMZ 取包内 doc.kml', S.kml(makeInputFile('x.kmz', zipSync({ 'doc.kml': enc(kmlText), 'files/a.png': new Uint8Array([1]) }))).beams.length === 1)
ok('geojson()：Multi* 拆开、洞保留为内环', (() => {
  const r = S.geojson({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { a: 1 }, geometry: { type: 'MultiPolygon', coordinates: [[closed(ring(0, 0, 2)), closed(ring(0, 0, 1))], [closed(ring(10, 0, 1))]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] } }] })
  return r.length === 4 && r[0].rings.length === 2 && r[0].props.a === 1 && r[3].type === 'Point'
})())
ok('gxt() / gxtJson()：内置解析器原样开放', S.gxt(serializeGxt({ lon: 110.5, satName: 'S', bore: [[1, 2, 50]], contours: [{ g: 48, p: closed(ring(1, 2, 1)) }] })).bore[0][2] === 50 &&
  S.gxtJson(serializeGxtJson({ lon: 1, contours: [{ g: 3, p: [[0, 0], [1, 1]] }] })).contours[0].g === 3)

/* ---------- ③ 归一化 ---------- */
{
  const n = normalizeImport([
    { satName: 'A', lon: 370, beam: 'B1', type: 'G/T', bore: [[10, 20, 5]], contours: [{ g: '48', p: [[10, 20], [11, 21], [12, 95], [380, 22]] }, { level: 1, points: [[0, 0]] }], props: { k: [1, 2] } },
    { satellite: 'A', name: 'B1', type: 'gt', contours: [[[1, 1], [2, 2], [3, 1]]] },
    { name: 'empty', contours: [] },
    'junk'
  ])
  const b = n.beams[0]
  ok('归一化：别名字段 / 经度折回 / 越界点剔除', b.satellite === 'A' && b.orbitLon === 10 && b.name === 'B1' && b.contours[0].g === 48 && b.contours[0].p.length === 3 && b.contours[0].p[2][0] === 20)
  ok('归一化：类型 G/T 归 GT、中心带电平、props 保留', b.type === 'GT' && b.bore[0][2] === 5 && b.props.k[1] === 2)
  ok('归一化：点数组形式的等值线（无电平 → null）', n.beams[1].contours[0].g === null && n.beams[1].contours[0].p.length === 3)
  ok('归一化：重名波束加序号、空波束 / 非对象跳过并告警', n.beams.length === 2 && n.beams[1].name === 'B1 (2)' && n.warnings.length >= 4, n.warnings.join(' | '))
  ok('归一化：{ satellites } 外包按卫星继承名称 / 轨位 / 类型', (() => { const r = normalizeImport({ satellites: [{ name: 'S', orbitLon: 134, type: 'GT', beams: [{ name: 'x', contours: [{ level: 1, points: [[1, 1], [2, 2]] }] }] }] }); return r.beams[0].satellite === 'S' && r.beams[0].orbitLon === 134 && r.beams[0].type === 'GT' })())
  ok('归一化：返回值形状不对报错', (() => { try { normalizeImport('x'); return false } catch (e) { return /波束数组/.test(e.message) } })())
  ok('归一化：类型口径', normType('EIRP') === 'EIRP' && normType('R') === 'GT' && normType('G/T dB/K') === 'GT' && normType('') === 'EIRP' && normType('downlink') === 'EIRP')
  const items = toLibraryItems(n.beams, { sourceName: 'x.json' })
  ok('覆盖库条目：字段与 importBatch 口径一致', items[0].satName === 'A' && items[0].beamName === 'B1' && items[0].json.contours[0].g === 48 && items[0].sourceFormat === 'script' && items[0].rawText === null && items[0].props.k.length === 2)
}

/* ---------- ④ 运行时 ---------- */
{
  const r1 = await runImport('const a = 1\nreturn [{ name: "x", contours: [{ level: 1, points: [[0,0],[1,1]] }] }]', [])
  ok('运行：返回波束即导入、统计读数', r1.ok && r1.beams.length === 1 && r1.stats.contours === 1)
  const r2 = await runImport('const a = 1\nconst b = a.foo.bar\nreturn []', [])
  ok('运行：运行期错误定位到用户行', !r2.ok && r2.error.line === 2, JSON.stringify(r2.error))
  const r3 = await runImport('return (', [])
  ok('运行：语法错带行列', !r3.ok && r3.error.name === 'SyntaxError' && r3.error.line === 1)
  const r4 = await runImport('return import("x")', [])
  ok('运行：import() 拦截', !r4.ok && r4.error.name === 'SecurityError')
  const r5 = await runImport('console.log(files.length, files[0].ext, files[0].text)\nreturn []', [F('a.TXT', 'hello')])
  ok('运行：files 与 console', r5.ok && r5.logs.some((l) => l.text === '1 txt hello' && l.line === 1))
  const r6 = await runImport('return "x"', [])
  ok('运行：返回值形状不对 → 报错', !r6.ok && /波束数组/.test(r6.error.message))
  const r7 = await runImport('return typeof self + typeof globalThis + typeof window', [])
  ok('运行：全局对象被遮蔽（返回 undefined 三连 → 形状报错）', !r7.ok)
}

/* ---------- ⑤ 内置导入模板 ---------- */
const rawImp = {}
for (const f of readdirSync(join(SB, 'importTemplates'))) if (f.endsWith('.bmjs')) rawImp[f] = readFileSync(join(SB, 'importTemplates', f), 'utf8')
const TZ = parseImportTemplates(rawImp, 'zh'), TEN = parseImportTemplates(rawImp, 'en')
const T = (id) => TZ.find((t) => t.id === id)
ok('模板：8 个、id / 名称 / 扩展名 / 匹配声明齐全', TZ.length === 8 && TZ.every((t) => t.id && t.name && t.ext && t.match.match.length), TZ.map((t) => t.id).join(','))
ok('模板：匹配声明留在代码里（复制成用户脚本照样生效）', TZ.every((t) => /^\/\/! match:/m.test(t.code)) && T('constellation-opt').match.sniff instanceof RegExp)
// 「//!」头部行是匹配声明（数据，如 sniff 里的「经度」），不算注释
const hanComment = (t) => t.code.split('\n').some((ln) => /^\s*\/\/(?!!)/.test(ln) && /[一-龥]/.test(ln))
ok('模板：英文版注释无汉字、中文版无 ⟪⟫', TEN.every((t) => !hanComment(t) && !/[一-龥]/.test(t.name)) && TZ.every((t) => !/[⟪⟫]/.test(t.code + t.name)),
  TEN.filter(hanComment).map((t) => t.id).join(','))
ok('模板：内置解析器已认得的三种标出', ['gxt', 'kml', 'gxt-json'].every((id) => NATIVE_TEMPLATE_IDS.has(id) && T(id)))
ok('新建导入脚本起手式可跑', (await runImport(blankImportScript('zh'), [F('a.json', '{}')])).ok && (await runImport(blankImportScript('en'), [])).ok)

{
  const gxtText = serializeGxt({ lon: 110.5, satName: 'X', bore: [[115.2, 30.4, 52.3]], contours: [{ g: 48, p: closed(ring(115, 30, 3)) }, { g: 44, p: closed(ring(115, 30, 5)) }] })
  const r = await runImport(T('gxt').code, [F('中星10R_Ku_东部波束_EIRP.gxt', gxtText), F('loose.gxt', gxtText)])
  ok('模板 GXT：文件名四段拆分 / 拆不出取 sat_name、中心电平', r.ok && r.beams[0].satellite === '中星10R' && r.beams[0].band === 'Ku' && r.beams[0].name === '东部波束' && r.beams[0].type === 'EIRP' && r.beams[0].bore[0][2] === 52.3 && r.beams[1].satellite === 'X' && r.beams[1].name === 'loose', r.error && r.error.message)
  const rk = await runImport(T('kml').code, [F('t.kml', kmlText)])
  ok('模板 KML：卫星 / 波束 / 轨位 / 档位', rk.ok && rk.beams.length === 1 && rk.beams[0].satellite === '中星10R' && rk.beams[0].orbitLon === 110.5 && rk.beams[0].contours.length === 2, rk.error && rk.error.message)
  const rj = await runImport(T('gxt-json').code, [F('APSTAR 7_C_全球_GT.json', serializeGxtJson({ lon: 76.5, satName: 'ap7', contours: [{ g: 2, p: closed(ring(80, 10, 4)) }], emiRcp: 'R' }))])
  ok('模板 GXT 结构 JSON：四段名 / 类型', rj.ok && rj.beams[0].satellite === 'APSTAR 7' && rj.beams[0].type === 'GT' && rj.beams[0].orbitLon === 76.5, rj.error && rj.error.message)
}

// 一来一回：导出模板写出 → 导入模板读回
const RAW = {
  library: [
    { satName: '中星10R', lon: 110.5, band: 'Ku', beam: '东部波束', type: 'EIRP', bore: [[115.2, 30.4, 52.3]],
      contours: [{ g: 48, color: '#ff3300', p: ring(115, 30, 3) }, { g: 44.5, color: '#00aa44', p: ring(115, 30, 5) }] },
    { satName: 'APSTAR 6D', lon: 134, band: 'C', beam: '全球', type: 'GT', bore: [],
      contours: [{ g: -2.5, color: '#3366ff', p: closed(ring(134, 0, 8)) }] }
  ],
  polygons: [{ name: '协调区A', value: '-50', satName: '中星10R', satLon: '110.5', color: '#3366FF', pts: ring(100, 20, 2) }],
  meta: { lang: 'zh', title: 'rt' }
}
const D = buildBeamMap(RAW)
const expT = parseTemplates((() => { const m = {}; for (const f of readdirSync(join(SB, 'templates'))) if (f.endsWith('.bmjs')) m[f] = readFileSync(join(SB, 'templates', f), 'utf8'); return m })(), 'zh')
const asInput = (files) => files.map((f) => ({ name: f.name, bytes: f.bytes || enc(f.text) }))
const sameBeams = (beams) => {
  const want = D.beams.map((b) => [b.satellite, b.name, b.band, b.type, b.contours.map((c) => c.level).sort().join('/')].join('|')).sort()
  const got = beams.map((b) => [b.satellite, b.name, b.band, b.type, b.contours.map((c) => c.g).sort().join('/')].join('|')).sort()
  return JSON.stringify(want) === JSON.stringify(got) ? '' : JSON.stringify(got)
}
for (const [exp, imp, label] of [['geojson', 'geojson', 'GeoJSON'], ['csv-vertices', 'csv-vertices', 'CSV'], ['shapefile', 'shapefile', 'Shapefile'], ['mapinfo', 'mapinfo', 'MapInfo']]) {
  const e = await runScript(expT.find((t) => t.id === exp).code, structuredClone(D), { lang: 'zh' })
  let input = asInput(e.files || [])
  if (exp === 'shapefile') input = [{ name: input[0].name, bytes: input[0].bytes }]
  const r = await runImport(T(imp).code, input)
  const diff = r.ok ? sameBeams(r.beams) : (r.error && r.error.message)
  ok(`一来一回 ${label}：导出后原样读回（卫星 / 波束 / 频段 / 类型 / 档位）`, e.ok && r.ok && !diff, diff)
  if (r.ok && label !== 'CSV') ok(`一来一回 ${label}：波束中心读回`, r.beams.find((b) => b.name === '东部波束').bore.length === 1)
}
{
  // Shapefile 也可以一起选中 .shp / .dbf / .cpg
  const e = await runScript(expT.find((t) => t.id === 'shapefile').code, structuredClone(D), { lang: 'zh' })
  const S2 = createStdlib('zh')
  const loose = []
  const { unzipSync } = await import('fflate')
  const ent = unzipSync(e.files[0].bytes)
  for (const k of Object.keys(ent)) loose.push({ name: k, bytes: ent[k] })
  const r = await runImport(T('shapefile').code, loose)
  ok('Shapefile：散文件（.shp + .dbf + .cpg）同样读回', r.ok && !sameBeams(r.beams), r.error && r.error.message)
  void S2
}

/* ---------- ⑥ 基带网管 CONSTELLATION_OPT ---------- */
const CO = {
  CONSTELLATION: {
    constellation_name: 'Pulse Network',
    SATELLITES: [
      { CARRIER: [{ carrier_type: 'dvbs2', search_priority: 2, polarization: 'V', center_freq: 11644830, symbol_rate: 2000, beam_id: 1 }], preference: 2, longitude: 142, skew_polarization: 0,
        BEAM: [{ CONTOUR: [{ points: [[17.45, 61.98], [20.85, 72], [28.28, 83.32], [-1.45, 61.49]], type: 1 }], beam_id: 1 }], satellite_id: 'AP9', latitude_wander: 0.1 },
      { CARRIER: [{ carrier_type: 'dvbs2', search_priority: 1, polarization: 'V', center_freq: 12702, symbol_rate: 5120, beam_id: 3 }, { carrier_type: 'dvbs2', search_priority: 1, polarization: 'H', center_freq: 12389000, symbol_rate: 8500, beam_id: 2 }],
        preference: 12, longitude: 76.5, skew_polarization: 0,
        BEAM: [{ CONTOUR: [{ points: [[10, 70], [12, 80], [5, 85]], type: 1 }], beam_id: 2 }, { CONTOUR: [{ points: [[20, 70], [22, 80], [15, 85]], type: 1 }], beam_id: 3 }], satellite_id: 'AP7', latitude_wander: 0.1 },
      { preference: 8, longitude: 125, skew_polarization: 0, satellite_id: 'CS6A', latitude_wander: 0.1 }
    ]
  },
  NMS: { element_id: '193', type: 'CONSTELLATION_OPT', element_parent_id: '1' }
}
{
  const r = await runImport(T('constellation-opt').code, [F('CONSTELLATION_OPT.json', JSON.stringify(CO, null, 2))])
  const b = r.ok ? r.beams : []
  ok('基带：3 个波束（无波束的星跳过并告警）', r.ok && b.length === 3 && r.logs.some((l) => l.level === 'warn' && /CS6A/.test(l.text)), r.error && r.error.message)
  ok('基带：点列 [纬度, 经度] 换成 [经度, 纬度]、无电平档', b[0] && b[0].contours[0].p[0][0] === 61.98 && b[0].contours[0].p[0][1] === 17.45 && b[0].contours[0].g === null)
  ok('基带：卫星 / 轨位 / 波束名 / 类型', b[0] && b[0].satellite === 'AP9' && b[0].orbitLon === 142 && b[0].name === '波束 1' && b[0].type === 'EIRP')
  ok('基带：频点 kHz / MHz 混写都折成 MHz、频段 Ku', b[1] && b[1].band === 'Ku' && b[2].band === 'Ku' && /12389 MHz/.test(b[1].props['载波'][0]) && /12702 MHz/.test(b[2].props['载波'][0]), b[1] && JSON.stringify(b[1].props))
  ok('基带：载波按 beam_id 挂到对应波束', b[1].props['载波'].length === 1 && /^DVB-S2 H/.test(b[1].props['载波'][0]) && /^DVB-S2 V/.test(b[2].props['载波'][0]) && b[0].props['卫星优先级'] === 2 && b[0].props['纬度漂移'] === '0.1°')
  const ren = await runImport(TEN.find((t) => t.id === 'constellation-opt').code, [F('c.json', JSON.stringify(CO))], { lang: 'en' })
  ok('基带（英文）：波束名 / 附加信息键随语言', ren.ok && ren.beams[0].name === 'Beam 1' && Array.isArray(ren.beams[0].props.Carriers))
}

/* ---------- ⑦ 匹配声明与自动认格式 ---------- */
{
  const info = T('constellation-opt').match
  const head = JSON.stringify(CO).slice(0, 65536)
  ok('认格式：CONSTELLATION_OPT 只被基带模板认走', scriptAccepts(info, { name: 'x.json', head }) && !scriptAccepts(T('geojson').match, { name: 'x.json', head }) && !scriptAccepts(T('gxt-json').match, { name: 'x.json', head }))
  ok('认格式：GeoJSON / CSV / Shapefile / MapInfo 各认各的', scriptAccepts(T('geojson').match, { name: 'a.geojson', head: '{"type":"FeatureCollection"' }) &&
    scriptAccepts(T('csv-vertices').match, { name: 'v.CSV', head: '卫星,波束,经度,纬度' }) && !scriptAccepts(T('csv-vertices').match, { name: 'v.csv', head: 'a,b,c' }) &&
    scriptAccepts(T('shapefile').match, { name: 'a.zip', head: '' }) && scriptAccepts(T('mapinfo').match, { name: 'A.MIF', head: 'Version 300' }))
  const mi = scriptMatchInfo('//! match: *.dat, data_??.txt\n//! sniff: ^HDR\ncode')
  ok('匹配声明：多个通配、? 通配、sniff 正则', mi.match.length === 2 && scriptAccepts(mi, { name: 'data_01.txt', head: 'HDR x' }) && !scriptAccepts(mi, { name: 'data_001.txt', head: 'HDR' }) && !scriptAccepts(mi, { name: 'a.dat', head: 'x' }))
  ok('匹配声明：没写 match 的脚本不参与自动认格式', !scriptAccepts(scriptMatchInfo('return []'), { name: 'a.json', head: '{}' }))
}

/* ---------- ⑧ 自动认格式：认领 ≠ 认出（文件管理「导入…」，importRuntime.autoImport） ---------- */
{
  // 与 importDispatch.importCandidates 同口径：用户脚本在前（只收写了 match 的），内置模板去掉原生解析的三种
  const builtin = TZ.filter((t) => !NATIVE_TEMPLATE_IDS.has(t.id)).map((t) => ({ key: 'b:' + t.id, kind: 'builtin', id: t.id, name: t.name, code: t.code, info: t.match }))
  const user = (id, code) => ({ key: 'u:' + id, kind: 'user', id, name: id, code, info: scriptMatchInfo(code) })
  const exec = (code, files) => runImport(code, files, { lang: 'zh' })
  // 旧版「新建脚本」的起手式：第一行就是生效的 //! match: *.json，解析逻辑一行没写
  const OLD_BLANK = '//! match: *.json\n// files\n\nconst beams = []\nfor (const f of files) {\n  const doc = json(f)\n}\nreturn beams\n'
  const cands = [user('旧空脚本', OLD_BLANK), ...builtin]
  const GJ = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { satellite: 'S', beam: 'B', level: 40 }, geometry: { type: 'Polygon', coordinates: [closed(ring(75, 10, 3))] } }] })
  const co = F('CONSTELLATION_OPT.json', JSON.stringify(CO, null, 2))
  ok('认领顺序：空脚本排在最前（它确实认领了这两个文件）', acceptingOrder(cands, { name: co.name, head: sniffDecode(co.bytes).text })[0] === 0 && acceptingOrder(cands, { name: 'coverage.json', head: GJ })[0] === 0)
  const r = await autoImport([co, F('coverage.json', GJ)], cands, exec, { lang: 'zh' })
  const byFile = (n) => r.runs.find((x) => x.files.some((f) => f.name === n))
  ok('CONSTELLATION_OPT.json：空脚本跑出 0 个波束不算定案，落到基带模板', byFile(co.name) && byFile(co.name).cand.key === 'b:constellation-opt' && byFile(co.name).result.beams.length === 3, byFile(co.name) && byFile(co.name).cand.key)
  ok('.json 后缀的 GeoJSON：同样落到 GeoJSON 模板', byFile('coverage.json') && byFile('coverage.json').cand.key === 'b:geojson' && recognized(byFile('coverage.json').result))
  ok('认出的文件不进 unmatched、试过的空脚本记在 tried', !r.unmatched.length && r.tried[co.name].join() === 'u:旧空脚本' && r.tried['coverage.json'].join() === 'u:旧空脚本')

  // 脚本报错同样换下一个；用户脚本真认出了就以用户脚本为准（用户脚本优先不变）
  const THROWS = '//! match: *.json\nthrow new Error("not mine")'
  const OWN = '//! match: *.json\nreturn [{ satellite: "U", name: "u1", contours: [{ level: 1, points: [[0, 0], [1, 1], [1, 0]] }] }]'
  const r2 = await autoImport([F('coverage.json', GJ)], [user('报错脚本', THROWS), ...builtin], exec)
  ok('用户脚本报错 → 换下一个候选（GeoJSON 模板认出）', r2.runs.length === 1 && r2.runs[0].cand.key === 'b:geojson' && r2.fails['coverage.json'][0].reason === 'not mine')
  const r3 = await autoImport([F('coverage.json', GJ)], [user('我的', OWN), ...builtin], exec)
  ok('用户脚本认出 → 用户脚本定案，不再往后试', r3.runs.length === 1 && r3.runs[0].cand.key === 'u:我的' && !r3.tried['coverage.json'])

  // 谁都没认出：进 unmatched，带上试过的候选与原因（文件管理据此打开「可编程导入」）
  const r4 = await autoImport([F('vendor.json', '{"satellite":"S","beams":[]}')], cands, exec)
  ok('谁都没认出 → unmatched，tried / fails 带原因', r4.unmatched.join() === 'vendor.json' && r4.tried['vendor.json'].join() === 'u:旧空脚本' && /没有返回任何波束/.test(r4.fails['vendor.json'][0].reason))

  // 同组里混进一个坏文件：整组报错 → 拆开逐个再试，好文件照样认出
  const bad = F('broken.geojson', '{"type":"FeatureCollection","features":[{"type":"Feature"')
  const r5 = await autoImport([F('good.geojson', GJ), bad], builtin, exec)
  ok('一组里有坏文件：拆开逐个再试，好文件认出、坏文件进 unmatched', r5.runs.length === 1 && r5.runs[0].files.map((f) => f.name).join() === 'good.geojson' && r5.unmatched.join() === 'broken.geojson')

  // 配套文件跟着主文件走（.shp + .dbf + .cpg 一轮跑完）
  const e = await runScript(expT.find((t) => t.id === 'shapefile').code, structuredClone(D), { lang: 'zh' })
  const { unzipSync } = await import('fflate')
  const ent = unzipSync(e.files[0].bytes)
  const loose = Object.keys(ent).map((k) => F(k, ent[k]))
  const r6 = await autoImport(loose, builtin, exec)
  ok('配套文件（.dbf / .cpg …）随同名 .shp 进同一轮', r6.runs.length === 1 && r6.runs[0].cand.key === 'b:shapefile' && r6.runs[0].files.length === loose.length && !r6.unmatched.length, loose.map((f) => f.name).join())

  // 运行器自己抛错（Worker 起不来之类）也当没认出，不中断整批
  const r7 = await autoImport([F('coverage.json', GJ)], builtin, async () => { throw new Error('worker down') })
  ok('运行器抛错 → 当没认出', r7.unmatched.join() === 'coverage.json' && r7.fails['coverage.json'][0].reason === 'worker down')

  // 新建脚本的起手式：匹配声明只留注释行，不参与自动认格式；去掉行首「// 」即生效
  const blank = blankImportScript('zh'), blankEn = blankImportScript('en')
  ok('新建脚本起手式：不带生效的匹配声明', !scriptMatchInfo(blank).match.length && !scriptMatchInfo(blankEn).match.length && !/[一-龥]/.test(blankEn))
  ok('新建脚本起手式：去掉注释即按 *.json 认领', scriptAccepts(scriptMatchInfo(blank.replace('// //! match:', '//! match:')), { name: 'a.json', head: '{}' }))

  // KML 模板：无数值档（覆盖边界）照收，纯数字波束名不当电平（Worker 里没有 DOMParser，走极简 DOM 替身）
  const kmlNone = serializeKml([{ name: '12', satName: 'S', lon: 100, type: 'EIRP', bore: [], contours: [{ g: null, p: closed(ring(100, 20, 2)) }] }], {})
  const rk = await runImport(T('kml').code, [F('n.kml', kmlNone)])
  ok('模板 KML：无数值档照收（level = null）、纯数字波束名不读成 dB', rk.ok && rk.beams.length === 1 && rk.beams[0].name === '12' && rk.beams[0].contours.length === 1 && rk.beams[0].contours[0].g === null, rk.error && rk.error.message)
}

console.log(`\nbeamImport: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
