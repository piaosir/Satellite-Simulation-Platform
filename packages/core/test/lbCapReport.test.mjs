// 独立《容量汇总》报告（shared/lbCapReport.js + electron/services/reportCap*.js）测试。运行：npm test
//
// 关键不变式：
//   ① kind:'cap' + hasCap 门控：一条列入的链路都没有 → hasCap 为假（主进程据此拒绝导出）；
//   ② 账目与弹窗同一份：矩阵就是 capReportBlock（总报告 §2 同一张表），明细小计＝逐行之和；
//   ③ 明细只列【列入且算出结果】的链路；未列入 / 计算失败只在汇总范围里报编号；
//   ④ 链路编号用导出流程给的全篇 #N（noOf），不是弹窗里的节内序号；
//   ⑤ 计算口径只列真出现的量：NGSO 无可用功率 / 剩余功率、再生式无功率两列、没单价无资费、一组无合计；
//   ⑥ 分节只看真出了账的节（激光 null、全不列入的节不算一节）；
//   ⑦ 英文模型全文无汉字（数据里的名字也用英文喂）；
//   ⑧ 两个渲染器真出得来文件；Excel 数值格是数（可求和）且显示位数与读数一致。
import { createRequire } from 'node:module'
import { CAP_PBW, buildCapModel, capReportBlock } from '../../../src/shared/lbCapacity.js'
import { buildCapReportModel, capDetailBlock, capDefinitions, capReportTitle } from '../../../src/shared/lbCapReport.js'

const require = createRequire(import.meta.url)
const { buildCapWorkbook } = require('../../../electron/services/reportCap.js')
const { buildCapDocx } = require('../../../electron/services/reportCapDocx.js')
const ExcelJS = require('exceljs')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const HAN = /[一-鿿]/

console.log('=== 链路预算 · 容量汇总报告 ===\n')

// 两只转发器（36 / 54 MHz）、五条链路：#3 不列入、#5 算失败、#2 代表 4 路
const item = (o) => Object.assign({ ok: true, error: '', tpBwMHz: 36, cap: null }, o)
const ITEMS = (en) => [
  item({ no: 1, rowId: 'a', name: en ? 'BJ → SH' : '北京 → 上海', carrier: 'QPSK', gkey: 's1', gname: en ? 'SAT-A' : '甲星', capKbps: 2000, bwKHz: 1350, pbwKHz: 1800 }),
  item({ no: 2, rowId: 'b', name: en ? 'BJ → GZ' : '北京 → 广州', carrier: '8PSK', gkey: 's1', gname: en ? 'SAT-A' : '甲星', capKbps: 3000, bwKHz: 1350, pbwKHz: 900, cap: { n: 4 } }),
  item({ no: 3, rowId: 'c', name: en ? 'BJ → XA' : '北京 → 西安', carrier: 'QPSK', gkey: 's1', gname: en ? 'SAT-A' : '甲星', capKbps: 2000, bwKHz: 1350, pbwKHz: 1800, cap: { off: true } }),
  item({ no: 4, rowId: 'd', name: en ? 'SH → CD' : '上海 → 成都', carrier: 'QPSK', gkey: 's2', gname: en ? 'SAT-B' : '乙星', tpBwMHz: 54, capKbps: 4000, bwKHz: 2700, pbwKHz: 5400 }),
  item({ no: 5, rowId: 'e', name: en ? 'SH → WH' : '上海 → 武汉', carrier: 'QPSK', gkey: 's2', gname: en ? 'SAT-B' : '乙星', tpBwMHz: 54, ok: false, error: 'x', capKbps: NaN, bwKHz: NaN, pbwKHz: NaN })
]
const PARAMS = { tp: { s1: { price: 10 }, s2: { price: 12, bwKHz: 27000 } } }
// 全篇编号故意与节内序号错开（模拟分节后的连续编号）：rowId → 10 + 节内序号
const NO = { a: 11, b: 12, c: 13, d: 14, e: 15 }
const noOf = (id) => NO[id]

function gsoModel(lang, pbw = CAP_PBW.SUM, opts = {}) {
  const m = buildCapModel(ITEMS(lang === 'en'), PARAMS, Object.assign({ pbw }, opts))
  return buildCapReportModel({
    lang, adaptUnits: false, appVersion: '1.5.3', orbitType: pbw === CAP_PBW.LIST ? 'NGSO' : 'GEO',
    calc: { satelliteName: lang === 'en' ? 'SAT-A' : '中星 6D', frequencyBand: 'Ku' },
    doc: {}, sections: [{ key: '', title: '', model: m, noOf }]
  })
}

// —— ① 形状与门控 ——
{
  const r = gsoModel('zh')
  ok('① kind = cap、v = 1、hasCap', r.kind === 'cap' && r.v === 1 && r.hasCap === true)
  ok('① 报告名「…卫星 … 频段容量汇总」', r.doc.title === '中星 6D 卫星 Ku 频段容量汇总' && capReportTitle('', '', 'en') === 'Satellite Capacity Summary', r.doc.title)
  const none = buildCapReportModel({ lang: 'zh', sections: [{ key: '', model: buildCapModel(ITEMS(false).map((x) => Object.assign(x, { cap: { off: true } })), null, {}), noOf }] })
  ok('① 全不列入 → hasCap 为假、没有节', none.hasCap === false && none.sections.length === 0)
  ok('① 没有模型（星间激光）→ hasCap 为假', buildCapReportModel({ sections: [{ key: 'laser', model: null }] }).hasCap === false)
  ok('① 模型可 JSON 往返（过 IPC）', JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r))
}

// —— ② 矩阵＝capReportBlock；明细小计＝逐行之和 ——
{
  const r = gsoModel('zh')
  const m = buildCapModel(ITEMS(false), PARAMS, { pbw: CAP_PBW.SUM })
  const blk = capReportBlock(m, { lang: 'zh', adaptive: false, noOf })
  ok('② 矩阵与总报告 §2 同一张表', JSON.stringify(r.sections[0].matrix) === JSON.stringify(blk))
  ok('② 矩阵末列为合计（两组）', r.sections[0].matrix.head[3] === '合计')
  const det = r.sections[0].detail
  ok('② 两组明细', det.length === 2 && det[0].name === '甲星' && det[1].name === '乙星')
  ok('② 组带转发器带宽', det[0].tpBwMHz === 36 && det[1].tpBwMHz === 54)
  const g1 = det[0]
  ok('② GSO 九列（含功率两列）', g1.head.length === 9 && /功率带宽/.test(g1.head[6]) && /功率占用/.test(g1.head[8]))
  const sub = g1.rows[g1.keyRows.indexOf(true)]
  ok('② 小计是关键行、在逐行之后', sub[1] === '小计' && g1.keyRows.filter(Boolean).length === 1)
  // 甲星：#1 2000 + #2 3000×4 = 14000 kbps；带宽 1350 + 1350×4 = 6750 kHz；功率 1800 + 900×4 = 5400
  ok('② 小计容量 / 载波带宽 / 功率带宽＝逐行之和', sub[3] === '5' && sub[4] === '14000.000' && sub[5] === '6750.000' && sub[6] === '5400.000', sub.join(' | '))
  ok('② 载波数倍数进逐行', g1.rows[1][3] === '4' && g1.rows[1][4] === '12000.000')
  const avail = g1.rows.find((x) => x[1] === '可用'), rem = g1.rows.find((x) => x[1] === '剩余')
  ok('② 可用（缺省＝转发器带宽）与剩余', avail[5] === '36000.000' && avail[6] === '36000.000' && rem[5] === '29250.000' && rem[6] === '30600.000')
  const g2 = det[1]
  ok('② 用户给的可用带宽生效', g2.rows.find((x) => x[1] === '可用')[5] === '27000.000')
}

// —— ③ ④ 明细只列列入且算出的；编号用全篇 #N ——
{
  const r = gsoModel('zh')
  const nums = r.sections[0].detail.flatMap((g) => g.rows.map((x) => x[0]).filter(Boolean))
  ok('③④ 明细只有 #11 #12 #14（#13 未列入、#15 失败）', JSON.stringify(nums) === '["#11","#12","#14"]', nums.join(' '))
  const sc = Object.fromEntries(r.scope)
  ok('③ 汇总范围报未列入 / 失败编号', sc['未列入链路'] === '#13' && sc['计算失败链路'] === '#15', JSON.stringify(sc))
  ok('③ 汇总范围：转发器 2、列入 3、载波 6', sc['转发器'] === '2' && sc['列入链路'] === '3' && sc['载波数'] === '6')
  ok('④ 矩阵首行「链路」也用全篇编号', r.sections[0].matrix.rows[0][1] === '#11, #12×4' && r.sections[0].matrix.rows[0][2] === '#14')
  const noNo = buildCapReportModel({ lang: 'zh', sections: [{ key: '', model: buildCapModel(ITEMS(false), null, {}) }] })
  ok('④ 没给 noOf 退到节内序号', noNo.sections[0].detail[0].rows[0][0] === '#1')
}

// —— ⑤ 计算口径只列真出现的量 ——
{
  const terms = (defs) => defs.map((d) => d.term)
  const gso = terms(gsoModel('zh').definitions)
  ok('⑤ GSO：功率带宽 / 可用功率 / 剩余功率 / 年费 / 合计都在', ['功率带宽', '可用功率', '剩余功率', '年费', '单位容量成本', '合计'].every((k) => gso.includes(k)), gso.join('、'))
  ok('⑤ GSO 结算带宽＝max', gsoModel('zh').definitions.find((d) => d.term === '结算带宽').formula.includes('max'))
  const ngso = gsoModel('zh', CAP_PBW.LIST)
  const nt = terms(ngso.definitions)
  ok('⑤ NGSO：有功率带宽、无可用功率 / 剩余功率', nt.includes('功率带宽') && !nt.includes('可用功率') && !nt.includes('剩余功率'))
  ok('⑤ NGSO 功率占用按转发器带宽折算', ngso.definitions.find((d) => d.term === '功率占用').formula.includes('B_转发器'))
  ok('⑤ NGSO 明细小计不求功率', ngso.sections[0].detail[0].rows.find((x) => x[1] === '小计')[6] === '')
  const regen = terms(capDefinitions(CAP_PBW.NONE, { availDefault: false }, 'zh'))
  ok('⑤ 再生式：无功率两列、无资费、无合计', !regen.some((k) => /功率/.test(k)) && !regen.includes('年费') && !regen.includes('合计'))
  const rg = buildCapReportModel({ lang: 'zh', orbitType: 'REGEN', sections: [{ key: 'uplink', model: buildCapModel(ITEMS(false), null, { pbw: CAP_PBW.NONE, availDefault: false }), noOf }] })
  ok('⑤ 再生式明细七列、无可用 / 剩余行', rg.sections[0].detail[0].head.length === 7 && !rg.sections[0].detail[0].rows.some((x) => x[1] === '可用'))
  ok('⑤ 再生式章名不叫转发器', rg.t.capMatrix === '资源汇总' && rg.t.capDetail === '逐组明细' && rg.scope.some((x) => x[0] === '资源组'))
  const one = buildCapReportModel({ lang: 'zh', sections: [{ key: '', model: buildCapModel(ITEMS(false).filter((x) => x.gkey === 's1'), null, {}), noOf }] })
  ok('⑤ 一组且没单价：无合计、无年费', !terms(one.definitions).includes('合计') && !terms(one.definitions).includes('年费'))
}

// —— ⑥ 分节 ——
{
  const mk = (filter, off) => buildCapModel(ITEMS(false).filter(filter).map((x) => (off ? Object.assign({}, x, { cap: { off: true } }) : x)), null, { pbw: CAP_PBW.NONE, availDefault: false })
  const two = buildCapReportModel({ lang: 'zh', orbitType: 'REGEN', sections: [
    { key: 'uplink', title: '上行', model: mk((x) => x.gkey === 's1'), noOf },
    { key: 'downlink', title: '下行', model: mk((x) => x.gkey === 's2'), noOf },
    { key: 'laser', title: '激光', model: null }
  ] })
  ok('⑥ 两节出账 → multi、激光不算一节', two.multi === true && two.sections.length === 2 && two.sections[1].title === '下行')
  const lone = buildCapReportModel({ lang: 'zh', orbitType: 'REGEN', sections: [
    { key: 'uplink', title: '上行', model: mk((x) => x.gkey === 's1'), noOf },
    { key: 'downlink', title: '下行', model: mk((x) => x.gkey === 's2', true), noOf }
  ] })
  // 上行节的 #13 本就不列入，下行节 #14 #15 整节不列入 → 连号并成区间
  ok('⑥ 另一节全不列入 → 按不分节排，但未列入编号照报', lone.multi === false && lone.sections.length === 1 && Object.fromEntries(lone.scope)['未列入链路'] === '#13–#15',
    Object.fromEntries(lone.scope)['未列入链路'])
}

// —— ⑦ 英文模型无汉字 ——
{
  const r = gsoModel('en')
  // scheme 是体制描述子（label 恒中文，渲染器只用模型里翻好的 schemeText），同 SLA 报告测试的口径跳过
  const txt = JSON.stringify(Object.assign({}, r, { scheme: null }))
  const hit = txt.match(new RegExp(HAN.source + '.{0,12}'))
  ok('⑦ 英文模型全文无汉字（体制描述子除外）', !hit, hit ? hit[0] : '')
  ok('⑦ 英文报告名', r.doc.title === 'SAT-A Satellite Ku-Band Capacity Summary', r.doc.title)
}

// —— ⑧ 渲染器 ——
{
  for (const lang of ['zh', 'en']) {
    const r = gsoModel(lang)
    let xbuf = null, dbuf = null, err = ''
    try { xbuf = await buildCapWorkbook(JSON.parse(JSON.stringify(r))) } catch (e) { err = e.message }
    ok(`⑧ ${lang} Excel 出得来`, xbuf && xbuf.byteLength > 2000, err)
    try { dbuf = await buildCapDocx(JSON.parse(JSON.stringify(r))) } catch (e) { err = e.message }
    ok(`⑧ ${lang} Word 出得来`, dbuf && dbuf.length > 2000, err)
    if (!xbuf) continue
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(xbuf)
    ok(`⑧ ${lang} 三张表`, wb.worksheets.length === 3, wb.worksheets.map((w) => w.name).join(' / '))
    // 明细表里找「36000」那一格：要是数、且 numFmt 三位小数
    let cell = null
    wb.worksheets[1].eachRow((row) => row.eachCell((c) => { if (!cell && c.value === 36000) cell = c }))
    ok(`⑧ ${lang} Excel 数值格是数且按读数位数显示`, cell && cell.numFmt === '0.000', cell ? cell.numFmt : '没找到 36000')
  }
  // 分节（再生式）也出得来
  const mk = (g) => buildCapModel(ITEMS(false).filter((x) => x.gkey === g), null, { pbw: CAP_PBW.NONE, availDefault: false })
  const rg = buildCapReportModel({ lang: 'zh', orbitType: 'REGEN', regenMode: ['uplink', 'downlink'], sections: [
    { key: 'uplink', title: '上行', model: mk('s1'), noOf }, { key: 'downlink', title: '下行', model: mk('s2'), noOf }] })
  let e2 = ''
  try { await buildCapWorkbook(JSON.parse(JSON.stringify(rg))); await buildCapDocx(JSON.parse(JSON.stringify(rg))) } catch (e) { e2 = e.message }
  ok('⑧ 分节模型两种文件都出得来', !e2, e2)
}

// 明细块自身：空模型 / 没有列入
ok('明细：空模型给空表', capDetailBlock(null).length === 0)

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
