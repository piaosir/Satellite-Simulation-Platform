// 分节报告（再生式一份配置装了几个计算模块）的不变式。运行：npm test
//   ① schemeOf 收一组 key：regenMode 仍是首个（老消费者照旧）、regenModes 全列、副标题把各段并列；
//      单个 key 的结果与改版前逐字段一样。
//   ② methodology 按模块并集取旗标：上行 + 星间 → 「几何与轨道」两句都在；只有星间 → 站星那句不出；
//      有激光 → 多出「光学链路口径」一段。
//   ③ buildReportModel(sections) → model.sections 带 title / short / count；enrichReportModel 每节各出
//      自己的汇总（指标行按各自模式：上行有功放建议、星间有星间距离），model.summary 仍在（老消费者）。
//   ④ sectionsOf：分节 → 各节 links 按 sec 过滤；不分节 / 只一节 → single 匿名节、title 空
//      （只装一个模块的再生式配置出来的文件与改版前一个字不多）。
//   ⑤ 两个主进程出口拿两节模型能跑通：Excel 几何表按模块各一张、表名带短名，详情表副标题带模块名；
//      Word 正文里有模块小节与详情章的模块标题。
//   ⑥ 瀑布段的列头走段自带的 heads（工况对照「晴空 / 降雨」、端到端逐段汇总「C/(N+I) / 段余量」）：
//      Excel / Word 中英两版都不许印成「上行 / 下行」，英文版不许是中文（体检 #13）。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ★ 路径走 fileURLToPath：项目目录名是中文，import.meta.url 里是 percent-encoded 的
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..').split(path.sep).join('/')
const require = createRequire(ROOT + '/package.json')
const ExcelJS = require('exceljs')
const JSZip = require('jszip')
const report = require(ROOT + '/electron/services/report.js')
const { buildReportDocx } = require(ROOT + '/electron/services/reportDocx.js')
const { buildReportModel, labelBundle, schemeOf, methodology, regenModeName, regenModeShort } = await import('file:///' + ROOT + '/src/shared/lbReport.js')
const { buildCapModel, capReportBlock } = await import('file:///' + ROOT + '/src/shared/lbCapacity.js')

// —— ① schemeOf ——
{
  const one = schemeOf('REGEN', 'isl')
  assert.equal(one.regenMode, 'isl'); assert.deepEqual(one.regenModes, ['isl'])
  assert.equal(one.subLabel, '星间微波链路'); assert.equal(one.subLabelEn, 'Inter-Satellite Link (RF)')
  const two = schemeOf('REGEN', ['uplink', 'isl', 'downlink'])
  assert.equal(two.regenMode, 'uplink')
  assert.deepEqual(two.regenModes, ['uplink', 'isl', 'downlink'])
  assert.equal(two.subLabel, '上行（地球站 → 卫星） · 星间微波链路 · 下行（卫星 → 地球站）')
  assert.equal(two.subLabelEn, 'Uplink (Earth Station → Satellite) · Inter-Satellite Link (RF) · Downlink (Satellite → Earth Station)')
  // 去重、丢掉不认识的 key、空 → 缺省上行
  assert.deepEqual(schemeOf('REGEN', ['isl', 'isl', 'bogus']).regenModes, ['isl'])
  assert.deepEqual(schemeOf('REGEN', []).regenModes, ['uplink'])
  assert.deepEqual(schemeOf('GEO', ['isl']).regenModes, []); assert.equal(schemeOf('GEO', ['isl']).regenMode, '')
  assert.equal(regenModeName('laser', 'en'), 'Inter-Satellite Link (Optical)'); assert.equal(regenModeShort('laser', 'zh'), '星间激光')
}

// —— ② methodology 旗标按并集 ——
{
  const geo = (modes, lang = 'zh') => methodology(schemeOf('REGEN', modes), lang).basis.find((b) => /几何与轨道|Geometry and orbits/.test(b.title)).text
  assert.ok(geo(['uplink']).includes('站星几何') && !geo(['uplink']).includes('星间几何'))
  assert.ok(!geo(['isl']).includes('站星几何') && geo(['isl']).includes('星间几何'))
  assert.ok(geo(['uplink', 'isl']).includes('站星几何') && geo(['uplink', 'isl']).includes('星间几何'))
  assert.ok(geo(['downlink', 'laser'], 'en').includes('Station–satellite') && geo(['downlink', 'laser'], 'en').includes('Inter-satellite'))
  const optical = (modes) => methodology(schemeOf('REGEN', modes), 'zh').basis.some((b) => b.title === '光学链路口径')
  assert.ok(optical(['uplink', 'laser']) && !optical(['uplink', 'isl']))
}

// —— 模型工厂：上行两条 + 星间一条 ——
const seg = { no: '1', title: '上行链路', role: 'cascade', cols: 1, rows: [{ label: '链路余量', up: '2.49', unit: 'dB', kind: 'margin', num: 2.49 }] }
const L = (no, sec, mode, data) => ({
  no, sec, rowId: 'r' + no, txName: mode === 'isl' ? 'SAT-A' : '北京', rxName: mode === 'isl' ? 'SAT-B' : 'GPS BIIR-5',
  ok: true, error: '', data, carrier: { stds: ['DVB-S2X'] },
  inputs: [{ title: '计算设置', rows: [{ label: '计算方式', value: mode === 'isl' ? '给定 EIRP/G-T + 严格几何' : '给定工作点', unit: '' }] }],
  segments: [seg], figures: [], sla: null, geom: null, islGeo: null, access: null, islManual: mode === 'isl'
})
const UP = { linkmargin: '2.49', paRecommendation: '12.5', allocBandwidthResult: '1200', spectralEfficiencyResult: '2.4', carrierTotalCN: '13.98', modulationResult: 'QPSK', fecResult: '3/4' }
const ISL = { linkmargin: '5.10', islRfDistResult: '4200.0', islRfFreqResult: '23', allocBandwidthResult: '800', spectralEfficiencyResult: '1.9', carrierTotalCN: '9.2', modulationResult: 'QPSK', fecResult: '1/2' }
function makeModel(lang = 'zh', sections = [{ key: 'uplink', regenMode: 'uplink' }, { key: 'isl', regenMode: 'isl' }]) {
  const links = [L(1, 0, 'uplink', UP), L(2, 0, 'uplink', UP), L(3, 1, 'isl', ISL)]
  const model = buildReportModel({
    lang, orbitType: 'REGEN', regenMode: 'uplink', sections,
    doc: { docNo: 'T-2', classification: '内部', org: '测试单位', date: '2026-09-07' },
    appVersion: 'test', satelliteName: 'GPS BIIR-5', frequencyBand: 'L',
    calc: { satelliteName: 'GPS BIIR-5', frequencyBand: 'L', mode: '给定工作点 / 给定 EIRP/G-T + 严格几何' },
    links: sections ? links : links.map((l) => ({ ...l, sec: undefined }))
  })
  model.t = labelBundle(lang)
  report.enrichReportModel(model)
  return model
}

// —— ③ 模型分节 + 每节汇总 ——
{
  const m = makeModel()
  assert.equal(m.sections.length, 2)
  assert.deepEqual(m.sections.map((s) => s.title), ['上行（地球站 → 卫星）', '星间微波链路'])
  assert.deepEqual(m.sections.map((s) => s.short), ['上行', '星间微波'])
  assert.deepEqual(m.sections.map((s) => s.count), [2, 1])
  assert.equal(m.scheme.subLabel, '上行（地球站 → 卫星） · 星间微波链路')
  const labels = (s) => s.summary.metrics.map((r) => r.label)
  assert.ok(labels(m.sections[0]).includes('功放建议 (W)') && !labels(m.sections[0]).includes('星间距离 (km)'))
  assert.ok(labels(m.sections[1]).includes('星间距离 (km)') && !labels(m.sections[1]).includes('功放建议 (W)'))
  assert.equal(m.sections[0].summary.metrics[0].values.length, 2)   // 上行那节两条链路
  assert.equal(m.sections[1].summary.metrics[0].values.length, 1)
  assert.ok(m.sections[0].summary.stats.length > 0 && m.summary.metrics.length > 0)
  // 英文：节名跟着语言走
  assert.deepEqual(makeModel('en').sections.map((s) => s.title), ['Uplink (Earth Station → Satellite)', 'Inter-Satellite Link (RF)'])
}

// —— ④ sectionsOf / linkSectionTitle ——
{
  const m = makeModel()
  const secs = report.sectionsOf(m)
  assert.equal(secs.length, 2)
  assert.deepEqual(secs.map((s) => s.links.map((l) => l.no)), [[1, 2], [3]])
  assert.deepEqual(secs.map((s) => s.regenMode), ['uplink', 'isl'])
  assert.ok(secs.every((s) => s.single === false))
  assert.equal(report.linkSectionTitle(m, m.links[2]), '星间微波链路')
  // 不分节：一个匿名节，title 空，links 全在
  const single = makeModel('zh', null)
  const s1 = report.sectionsOf(single)
  assert.equal(s1.length, 1); assert.equal(s1[0].single, true); assert.equal(s1[0].title, ''); assert.equal(s1[0].links.length, 3)
  assert.equal(report.linkSectionTitle(single, single.links[0]), '')
  // 只有一节的分节模型也按匿名节走（只装一个模块 = 改版前的文件）
  const one = makeModel('zh', [{ key: 'uplink', regenMode: 'uplink' }])
  assert.equal(report.sectionsOf(one).length, 1); assert.equal(report.sectionsOf(one)[0].single, true)
}

// —— ⑤ 出口跑通：Excel（几何表按模块、副标题带模块名）与 Word（模块小节 + 详情章模块标题）——
{
  const m = makeModel()
  const buf = await report.buildReportWorkbook(m)
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf)
  const names = wb.worksheets.map((ws) => ws.name)
  assert.equal(names.length, 3, '总览加每模块一张Link_result工程矩阵：' + names.join(','))
  assert.equal(names[0], '总览', '先展示与Word主要结果同源的总览')
  assert.ok(names.slice(1).every((name) => name.startsWith('Link_result')), '保留各模块工程矩阵')
  // 星间那节是手动几何（没有 islGeo）→ 整张表不出（与改版前口径一致）
  assert.ok(!names.some((n) => n.startsWith('几何关系 · 星间')))
  const textOf = (v) => (v && typeof v === 'object' && Array.isArray(v.richText)) ? v.richText.map((t) => t.text).join('') : String(v == null ? '' : v)
  const master = wb.worksheets[1]
  const cells = []
  wb.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((c) => cells.push(textOf(c.value)))))
  assert.ok(cells.some((t) => t.includes('上行（地球站 → 卫星）')) && cells.some((t) => t.includes('星间微波链路')), '矩阵元信息保留所属模块')
  const detail = wb.worksheets[2]
  const dcells = []; detail.eachRow((row) => row.eachCell((c) => dcells.push(textOf(c.value))))
  assert.ok(dcells.some((t) => t.includes('星间微波链路')), '详情表副标题带所属模块')

  const dbuf = await buildReportDocx(m)
  const zip = await JSZip.loadAsync(dbuf)
  const xml = await zip.file('word/document.xml').async('string')
  assert.ok(xml.includes('上行（地球站 → 卫星）') && xml.includes('星间微波链路'), 'Word合同版保留各模块标题')
  assert.ok(xml.includes('#3 SAT-A → SAT-B'), 'Word详情包含第三条真实链路')
}

// —— ⑥ 列头走段自带的 heads（Excel / Word，中英两版）——
{
  const core = require(ROOT + '/packages/core/utils/waterfallBuilder.js')
  const R = {
    linkmargin: '3.00', thresholdCN: '4.50', RXnoiseBW: '65.00',
    uplinkCN: '12.00', downlinkCN: '10.00', carrierTotalCN: '7.50',
    uplinkRainAttenuation: '3.50', downlinkRainAttenuationResult: '7.60', gOverTdegradationResult: '2.90',
    uplinkPowerRatioResult: '10', downlinkPowerRatioResult: '20',
    transponderOutputEIRP: '50.00', downlinkFSLResult: '206.00', gOverTeResult: '12.90',
    downlinkInterferenceLossResult: '0.00'
  }
  const textOf = (v) => (v && typeof v === 'object' && Array.isArray(v.richText)) ? v.richText.map((t) => t.text).join('') : String(v == null ? '' : v)
  for (const lang of ['zh', 'en']) {
    const segs = core.buildWaterfallSegments({ results: R, lang, orbitType: 'GEO' })
    // 端到端「逐段汇总」那种自带列头的双列段，一并塞进同一条链路
    segs.push({ id: 'segments', no: segs.length + 1, title: lang === 'en' ? 'Per-Segment Summary' : '逐段汇总', cols: 2, heads: lang === 'en' ? ['C/(N+I)', 'Segment Margin'] : ['C/(N+I)', '段余量'],
      rows: [{ label: '1', up: '9.10', down: '2.30', unit: 'dB', kind: 'ref', num: 9.1, numDown: 2.3 }] })
    const model = buildReportModel({
      lang, orbitType: 'GEO', appVersion: 'test', satelliteName: 'S', frequencyBand: 'Ku',
      doc: { docNo: 'T-6', classification: '', org: '', date: '2026-10-16' },
      links: [{ no: 1, rowId: 'r1', txName: 'TX', rxName: 'RX', ok: true, error: '', data: R, segments: segs, inputs: [], figures: [], sla: null, carrier: { stds: ['DVB-S2'] } }]
    })
    model.t = labelBundle(lang)
    report.enrichReportModel(model)
    const heads = (lang === 'en' ? [['Clear Sky', 'Rain'], ['C/(N+I)', 'Segment Margin']] : [['晴空', '降雨'], ['C/(N+I)', '段余量']])
    const [P, U, UP, DN] = lang === 'en' ? ['Parameter', 'Unit', 'Uplink', 'Downlink'] : ['参数', '单位', '上行', '下行']
    // Excel 详情表：段题注下面那一行就是列头
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await report.buildReportWorkbook(model))
    const ws = wb.worksheets.find((x) => x.name.startsWith('Link_result'))
    const rows = []; ws.eachRow((row, rn) => { const a = []; row.eachCell({ includeEmpty: true }, (c, cn) => { a[cn - 1] = textOf(c.value) }); rows[rn] = a })
    for (const [id, h] of [['weather', heads[0]], ['segments', heads[1]]]) {
      const seg = segs.find((s) => s.id === id)
      const capAt = rows.findIndex((a) => a && a[0] === '§' + seg.no + '  ' + seg.title)
      assert.ok(capAt > 0, `${lang} Excel：找得到「${seg.title}」的段题注`)
      const blockRows = rows.slice(capAt + 1).filter(Boolean)
      for (const condition of h) assert.ok(blockRows.some((row) => row[0]?.endsWith(' · ' + condition)), `${lang} Excel保留真实工况「${condition}」`)
    }
    // 级联主段（三列、不带 heads）照旧「上行 / 下行 / 合计」
    assert.ok(rows.some((a) => a && a[0]?.endsWith(' · ' + UP)) && rows.some((a) => a && a[0]?.endsWith(' · ' + DN)), `${lang} Excel：无 heads 的段照旧区分上行 / 下行`)
    // Word：列头文字进了正文，英文版这两张表里没有中文列头
    const xml = await (await JSZip.loadAsync(await buildReportDocx(model))).file('word/document.xml').async('string')
    for (const h of heads.flat()) assert.ok(xml.includes('>' + h + '<'), `${lang} Word 列头「${h}」`)
    if (lang === 'en') for (const zh of ['晴空', '降雨', '段余量']) assert.ok(!xml.includes('>' + zh + '<'), `en Word 不许有中文列头「${zh}」`)
  }
}

// Capacity is indexed by section: optical links intentionally contribute null.
// Put laser before RF ISL so skipping its absent table cannot shift RF ownership.
for (const lang of ['zh', 'en']) {
  const modes = ['uplink', 'downlink', 'laser', 'isl']
  const capacity = modes.map((mode, index) => capReportBlock(mode === 'laser' ? null : buildCapModel([{
    no: index + 1, rowId: 'r' + (index + 1), name: mode, ok: true,
    gkey: mode, gname: 'CAP-' + mode, capKbps: 1000 * (index + 1), bwKHz: 500 * (index + 1)
  }], null, { pbw: 'none', availDefault: false }), { lang, noOf: () => index + 1 }))
  const mixedModel = (selectedModes, blocks) => {
    const model = buildReportModel({
      lang, orbitType: 'REGEN', sections: selectedModes.map((key) => ({ key, regenMode: key })), capacity: blocks,
      links: selectedModes.map((mode, index) => ({
        ...L(index + 1, index, mode, mode === 'laser' ? { laserDistResult: '4200', laserPrxResult: '-35', linkmargin: '7' } : UP),
        segments: [{ ...seg, rows: [{ label: 'Result ' + mode, up: String(index + 1), unit: 'dB', num: index + 1 }] }]
      }))
    })
    report.enrichReportModel(model)
    return model
  }
  const model = mixedModel(modes, capacity)
  assert.equal(model.capacity.length, 4, 'Absent capacity preserves section indices')
  assert.equal(model.capacity[2], null, 'Optical links have no RF capacity block')
  assert.equal(model.sections[2].summary.cap, null)
  assert.equal(model.sections[3].summary.cap.head[1], 'CAP-isl', 'Capacity remains attached to RF ISL after optical section')
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await report.buildReportWorkbook(model))
  assert.equal(wb.worksheets.length, 5, 'Overview and all four module matrices export successfully')
  const valuesOf = (sheet) => {
    const values = []
    sheet.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value == null ? '' : cell.value))))
    return values
  }
  modes.forEach((mode, index) => {
    const ws = wb.worksheets[index + 1], values = valuesOf(ws)
    assert.ok(String(ws.getCell('C5').value).startsWith('#' + (index + 1) + ' '), 'Global link number survives for ' + mode)
    assert.ok(values.includes('Result ' + mode), 'The ' + mode + ' budget remains in its matrix')
    let reading
    ws.eachRow((row) => { if (row.getCell(1).value === 'Result ' + mode) reading = row.getCell(3).value })
    assert.equal(reading, index + 1, 'The ' + mode + ' budget reading retains its numeric value')
  })
  const firstValues = valuesOf(wb.worksheets[1])
  for (const mode of modes.filter((mode) => mode !== 'laser')) assert.ok(firstValues.includes('CAP-' + mode), 'Valid capacity table survives for ' + mode)
  assert.ok(!valuesOf(wb.worksheets[3]).some((value) => /^CAP-/.test(value)), 'Optical matrix gains no fabricated RF capacity table')

  // No included capacity links and an optical-only report are both valid exports.
  for (const selectedModes of [modes, ['laser']]) {
    const empty = mixedModel(selectedModes, selectedModes.map(() => null))
    assert.ok(empty.sections.every((section) => section.summary.cap === null))
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await report.buildReportWorkbook(empty))
    assert.equal(book.worksheets.length, selectedModes.length + 1)
    assert.ok(book.worksheets.every((sheet) => !valuesOf(sheet).some((value) => /^CAP-/.test(value))))
  }
}

console.log('lbReportSections: all passed')
