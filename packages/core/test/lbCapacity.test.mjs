// 链路预算「容量汇总」模块（shared/lbCapacity.js）测试。运行：npm test
//
// 关键不变式：
//   ① 一组＝一只转发器：功率带宽只在组内求和，占用率对着本组的可用资源折算；表末合计不加功率带宽；
//   ② 载波数 n：逐行的容量 / 载波带宽 / 功率带宽都 × n（小计即逐行之和，表要能对账）；
//   ③ 不列入的行、算失败的行不进任何一个和；
//   ④ 可用带宽缺省＝转发器带宽、可用功率缺省＝可用带宽；用户改了就按改的；再生式没有缺省；
//   ⑤ 结算带宽 = max(Σ载波带宽, Σ功率带宽)（NGSO / 再生式只看带宽），年费 = 单价 × 结算带宽；
//      合计年费只在每一组（列入了载波的）都给了单价时才报；
//   ⑥ 真引擎：两颗星（36 / 54 MHz）同构网，逐组功率占用 = 该组各行引擎 powerUsageRatio 之和——
//      分母是各自的转发器；跨星直接相加的旧口径给不出这个数。
//   ⑦ row.cap / capParams 落盘形状：缺省不落、现造纯对象（过 IPC 结构化克隆）。
import { createRequire } from 'node:module'
import {
  CAP_PBW, normRowCap, applyRowCap, capIncluded, capCount, setCapIncluded, setCapCount,
  normCapParams, setCapTpParam, remapCapParams, capKeySat, capKeyMode, capKeyIsl,
  buildCapModel, capUnits, capFx, capReportBlock, capMembersText
} from '../../../src/shared/lbCapacity.js'

const require = createRequire(import.meta.url)
const { calculateLinkBudget } = require('../utils/linkCalculator.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (name, got, want, tol) => ok(name, got != null && Math.abs(got - want) <= tol, `得 ${got} / 期望 ${want}`)

console.log('=== 链路预算 · 容量汇总 ===\n')

// —— ⑦ 逐链路设置 row.cap ——
{
  ok('⑦ 缺省（列入、1 路）不落盘', normRowCap({}) === null && normRowCap({ off: false, n: 1 }) === null && normRowCap(null) === null)
  ok('⑦ 不列入记 off', JSON.stringify(normRowCap({ off: true })) === '{"off":true}')
  ok('⑦ 载波数取整、≥ 2 才记', normRowCap({ n: '2.6' }).n === 3 && normRowCap({ n: 1.4 }) === null && normRowCap({ n: -5 }) === null)
  ok('⑦ 载波数封顶', normRowCap({ n: 1e9 }).n === 1000000)
  const row = { cap: { off: true, n: 4 } }
  const src = row.cap
  applyRowCap(row, row.cap)
  ok('⑦ applyRowCap 现造新对象（不与原对象共用）', row.cap !== src && row.cap.off === true && row.cap.n === 4)
  applyRowCap(row, { off: false, n: 1 })
  ok('⑦ 回到缺省即删键', !('cap' in row))
  ok('⑦ capIncluded / capCount', capIncluded(null) && !capIncluded({ off: true }) && capCount(null) === 1 && capCount({ n: 7 }) === 7)
  ok('⑦ setCapIncluded 保留载波数', JSON.stringify(setCapIncluded({ n: 5 }, false)) === '{"off":true,"n":5}' && JSON.stringify(setCapIncluded({ off: true, n: 5 }, true)) === '{"n":5}')
  ok('⑦ setCapCount 保留不列入', JSON.stringify(setCapCount({ off: true }, 3)) === '{"off":true,"n":3}' && setCapCount({ n: 3 }, 1) === null)
}

// —— ⑦ 场景级参数 capParams ——
{
  const p = normCapParams({ tp: { a: { bwKHz: '9000', pwKHz: -1, price: 0 }, b: { bwKHz: 0 }, c: null } })
  ok('⑦ 非法项丢弃、单价 0 保留', JSON.stringify(p) === '{"tp":{"a":{"bwKHz":9000,"price":0}}}', JSON.stringify(p))
  ok('⑦ 空 / 旧场景 → { tp: {} }', JSON.stringify(normCapParams(undefined)) === '{"tp":{}}')
  const q = { tp: {} }
  setCapTpParam(q, 'sat1', 'bwKHz', 9000)
  setCapTpParam(q, 'sat1', 'price', 7)
  ok('⑦ setCapTpParam 写入', q.tp.sat1.bwKHz === 9000 && q.tp.sat1.price === 7)
  setCapTpParam(q, 'sat1', 'bwKHz', null)
  ok('⑦ 清一项留其余', !('bwKHz' in q.tp.sat1) && q.tp.sat1.price === 7)
  setCapTpParam(q, 'sat1', 'price', null)
  ok('⑦ 全清即删整组', !('sat1' in q.tp))
  ok('⑦ 组键', capKeySat('sat3') === 'sat3' && capKeyMode('uplink', 'sat3') === 'uplink:sat3' && capKeyIsl('s1', 's2') === 'isl:s1>s2')
  const r = remapCapParams({ tp: { sat1: { price: 1 }, 'uplink:sat1': { bwKHz: 5 }, 'isl:sat1>sat2': { bwKHz: 6 }, 'downlink:sat9': { bwKHz: 7 } } }, { sat1: 'X', sat2: 'Y' })
  ok('⑦ 分享包重映射：三种组键都换 id，对端没有的星丢掉', JSON.stringify(r) === '{"tp":{"X":{"price":1},"uplink:X":{"bwKHz":5},"isl:X>Y":{"bwKHz":6}}}', JSON.stringify(r))
  const r2 = remapCapParams({ tp: { 'isl:>': { price: 2 } } }, {})
  ok('⑦ 分享包重映射：手动几何的星间组（两端无身份）原样保留', JSON.stringify(r2) === '{"tp":{"isl:>":{"price":2}}}', JSON.stringify(r2))
}

// —— 合成数据：两只转发器（A 36 MHz、B 54 MHz）——
const item = (no, gkey, tp, capKbps, bwKHz, pbwKHz, cap, extra) => ({
  no, rowId: 'r' + no, name: '站' + no, carrier: '载波', gkey, gname: gkey === 'A' ? '甲星' : '乙星', tpBwMHz: tp,
  ok: true, error: '', capKbps, bwKHz, pbwKHz, cap: cap || null, ...(extra || {})
})
const ITEMS = [
  item(1, 'A', 36, 8448, 6758, 7900),
  item(2, 'A', 36, 512, 410, 356, { n: 30 }),
  item(3, 'A', 36, 512, 410, 356, { off: true }),                       // 不列入
  item(4, 'A', 36, 512, 410, 356, null, { ok: false, error: '卫星不可见' }), // 失败
  item(5, 'B', 54, 20000, 14000, 20000)
]

// —— ①②③④⑤ GSO：组内求和 ——
{
  const m = buildCapModel(ITEMS, { tp: {} }, { pbw: CAP_PBW.SUM })
  const [A, B] = m.groups
  ok('① 按组键分两组、按首次出现排序', m.groups.length === 2 && A.key === 'A' && B.key === 'B' && A.name === '甲星')
  ok('③ 计数：列入 3 · 不列入 1 · 失败 1', m.counts.all === 5 && m.counts.on === 3 && m.counts.off === 1 && m.counts.failed === 1, JSON.stringify(m.counts))
  ok('② 逐行 × 载波数', A.rows[1].capKbps === 512 * 30 && A.rows[1].bwKHz === 410 * 30 && A.rows[1].pbwKHz === 356 * 30)
  ok('③ 失败行无数、不列入行照列数（只是不进和）', A.rows[3].bwKHz === null && A.rows[2].bwKHz === 410)
  ok('② 小计＝列入且算出的逐行之和', A.n === 31 && A.capKbps === 8448 + 15360 && A.bwKHz === 6758 + 12300 && A.pbwKHz === 7900 + 10680)
  ok('④ 可用带宽缺省＝转发器带宽、可用功率缺省＝可用带宽', A.availBwKHz === 36000 && A.availPwKHz === 36000 && !A.availBwUser && B.availBwKHz === 54000)
  near('④ 剩余带宽', A.remBwKHz, 36000 - 19058, 1e-9)
  near('④ 剩余功率', A.remPwKHz, 36000 - 18580, 1e-9)
  near('① 带宽占用对着本组', A.bwPct, 19058 / 36000 * 100, 1e-9)
  near('① 功率占用对着本组', A.pwPct, 18580 / 36000 * 100, 1e-9)
  near('① 逐行功率占用对着本组', A.rows[0].pwPct, 7900 / 36000 * 100, 1e-9)
  near('⑤ 结算带宽＝max(Σ载波带宽, Σ功率带宽)：A 受带宽限', A.billKHz, 19058, 1e-9)
  near('⑤ 结算带宽：B 受功率限', B.billKHz, 20000, 1e-9)
  near('频谱效率＝Σ容量 / Σ载波带宽', A.effBpsHz, (8448 + 15360) / 19058, 1e-12)
  ok('⑤ 未给单价不出年费', A.price === null && A.feeWan === null && A.unitCostWan === null)
  ok('① 合计不带功率带宽', m.total && !('pbwKHz' in m.total))
  ok('① 合计：容量 / 载波带宽 / 结算带宽跨组相加', m.total.n === 32 && m.total.capKbps === A.capKbps + B.capKbps && m.total.bwKHz === A.bwKHz + B.bwKHz && m.total.billKHz === A.billKHz + B.billKHz)
  ok('⑤ 合计年费：没有任何单价 → 不报', m.total.feeWan === null)
}
// —— ④⑤ 用户改可用资源与单价 ——
{
  const params = { tp: {} }
  setCapTpParam(params, 'A', 'bwKHz', 20000)
  setCapTpParam(params, 'A', 'price', 7)
  const m = buildCapModel(ITEMS, params, { pbw: CAP_PBW.SUM })
  const [A, B] = m.groups
  ok('④ 可用带宽按改的、可用功率随之（与所租带宽成正比）', A.availBwKHz === 20000 && A.availBwUser && A.availPwKHz === 20000 && !A.availPwUser && A.availPwDef === 20000)
  near('④ 剩余随之', A.remBwKHz, 20000 - 19058, 1e-9)
  near('⑤ 年费＝单价 × 结算带宽（MHz）', A.feeWan, 7 * 19.058, 1e-12)
  near('⑤ 单位容量成本＝年费 / 容量（Mbps）', A.unitCostWan, (7 * 19.058) / ((8448 + 15360) / 1000), 1e-12)
  ok('⑤ 一组列入了载波却没单价 → 合计年费不报', m.total.feeWan === null)
  setCapTpParam(params, 'B', 'price', 5)
  setCapTpParam(params, 'A', 'pwKHz', 15000)
  const m2 = buildCapModel(ITEMS, params, { pbw: CAP_PBW.SUM })
  near('⑤ 每组都有单价 → 合计年费＝各组之和', m2.total.feeWan, m2.groups[0].feeWan + m2.groups[1].feeWan, 1e-12)
  near('⑤ 合计单位容量成本', m2.total.unitCostWan, m2.total.feeWan / (m2.total.capKbps / 1000), 1e-12)
  ok('④ 可用功率单独改', m2.groups[0].availPwKHz === 15000 && m2.groups[0].availPwUser)
  near('④ 剩余功率可为负（超发）', m2.groups[0].remPwKHz, 15000 - 18580, 1e-9)
  void B
}
// —— NGSO：只列不求和 ——
{
  const m = buildCapModel(ITEMS, { tp: {} }, { pbw: CAP_PBW.LIST })
  const A = m.groups[0]
  ok('NGSO 组内不求功率带宽、无可用功率 / 剩余功率 / 功率占用', A.pbwKHz === null && A.availPwKHz === null && A.remPwKHz === null && A.pwPct === null)
  ok('NGSO 逐行照列功率带宽（× 载波数）', A.rows[0].pbwKHz === 7900 && A.rows[1].pbwKHz === 10680)
  near('NGSO 逐行功率占用按整只转发器折算', A.rows[0].pwPct, 7900 / 36000 * 100, 1e-9)
  near('NGSO 结算带宽＝Σ载波带宽', A.billKHz, 19058, 1e-9)
  ok('NGSO 可用带宽照常缺省转发器带宽', A.availBwKHz === 36000)
}
// —— 再生式：不出功率、可用带宽无缺省 ——
{
  const m = buildCapModel(ITEMS, { tp: {} }, { pbw: CAP_PBW.NONE, availDefault: false })
  const A = m.groups[0]
  ok('再生式逐行无功率带宽', A.rows.every((r) => r.pbwKHz === null && r.pwPct === null))
  ok('再生式可用带宽没有缺省 → 无剩余、无占用', A.availBwKHz === null && A.remBwKHz === null && A.bwPct === null && A.availBwDef === null)
  const p = { tp: {} }
  setCapTpParam(p, 'A', 'bwKHz', 25000)
  const m2 = buildCapModel(ITEMS, p, { pbw: CAP_PBW.NONE, availDefault: false })
  near('再生式填了可用带宽才出剩余', m2.groups[0].remBwKHz, 25000 - 19058, 1e-9)
  near('再生式结算带宽＝Σ载波带宽', m2.groups[0].billKHz, 19058, 1e-9)
}
// —— 一组：不出合计 ——
{
  const m = buildCapModel(ITEMS.filter((x) => x.gkey === 'A'), { tp: {} }, { pbw: CAP_PBW.SUM })
  ok('只有一组时 total 为 null（合计就是那一组）', m.groups.length === 1 && m.total === null)
  const none = buildCapModel([], { tp: {} }, {})
  ok('没有链路：空模型', none.groups.length === 0 && none.total === null && none.counts.on === 0)
}

// —— ⑥ 真引擎：两颗星同构网 ——
{
  const base = { frequencyBand: 'Ku', satelliteName: 'T', orbitPosition: 110.5 }
  const satA = { ...base, transponderBandwidth: 36 }
  const satB = { ...base, transponderBandwidth: 54 }
  const fwd = { infoRate: 20000, modulation: '16APSK', fec: '3/4', ebno: 8.5, bandwidthFactor: 1.2, antennaDiameter: 9.0, latitude: 39.9, longitude: 116.4, rxAntennaDiameter: 1.2, rxLatitude: 23.1, rxLongitude: 113.3, margin: '3' }
  const rtn = { infoRate: 512, modulation: 'QPSK', fec: '1/2', ebno: 3.5, bandwidthFactor: 1.35, antennaDiameter: 1.2, latitude: 23.1, longitude: 113.3, rxAntennaDiameter: 9.0, rxLatitude: 39.9, rxLongitude: 116.4, margin: '3' }
  const runs = [[satA, fwd, 'A'], [satA, rtn, 'A'], [satB, fwd, 'B'], [satB, rtn, 'B']].map(([s, l, g], i) => {
    const r = calculateLinkBudget(s, l)
    if (!r.success) throw new Error('引擎失败：' + r.message)
    const d = r.data
    return { d, it: item(i + 1, g, parseFloat(d.transponderBandwidthResult), parseFloat(d.allocBandwidthResult) * parseFloat(d.spectralEfficiencyResult), parseFloat(d.allocBandwidthResult), parseFloat(d.PowerBWResult)) }
  })
  const m = buildCapModel(runs.map((x) => x.it), { tp: {} }, { pbw: CAP_PBW.SUM })
  const sumUse = (g) => runs.filter((x) => x.it.gkey === g).reduce((s, x) => s + parseFloat(x.d.powerUsageRatio), 0)
  // 引擎 powerUsageRatio 是 3 位小数回显、PowerBWResult 也是 3 位：两边各自舍入，容差按 3 位末位的舍入界给
  near('⑥ A 组功率占用＝A 星各行 powerUsageRatio 之和', m.groups[0].pwPct, sumUse('A'), 0.002)
  near('⑥ B 组功率占用＝B 星各行 powerUsageRatio 之和', m.groups[1].pwPct, sumUse('B'), 0.002)
  ok('⑥ 两颗星的份额分母不同：同一张网在 54 MHz 星上功率占用更低', m.groups[1].pwPct < m.groups[0].pwPct, `${m.groups[0].pwPct.toFixed(3)} % vs ${m.groups[1].pwPct.toFixed(3)} %`)
  const bwUse = (g) => runs.filter((x) => x.it.gkey === g).reduce((s, x) => s + parseFloat(x.d.bandwidthUsageRatio), 0)
  near('⑥ A 组带宽占用＝各行 bandwidthUsageRatio 之和', m.groups[0].bwPct, bwUse('A'), 0.002)
}

// —— 显示：单位档与数格式 ——
{
  const m = buildCapModel(ITEMS, { tp: {} }, { pbw: CAP_PBW.SUM })
  const lock = capUnits(m, false)
  ok('「单位」锁定：恒为引擎基准 kHz / kbps', lock.bw.unit === 'kHz' && lock.bw.f === 1 && lock.cap.unit === 'kbps')
  const ad = capUnits(m, true)
  ok('自适应：整表带宽共一档、容量共一档', ad.bw.unit === 'MHz' && ad.bw.f === 1e-3 && ad.cap.unit === 'Mbps', JSON.stringify(ad))
  ok('capFx：−0 不印负号、缺值印「—」', capFx(-0.0004, 3) === '0.000' && capFx(null, 2) === '—' && capFx(NaN, 2) === '—' && capFx(-1.5, 1) === '-1.5')
  ok('capMembersText：连号并区间、载波数带倍数', capMembersText([{ no: 3, n: 1 }, { no: 1, n: 1 }, { no: 2, n: 1 }, { no: 5, n: 20 }, { no: 7, n: 1 }, { no: 8, n: 1 }]) === '#1–#3, #5×20, #7, #8')
}

// —— 报告块 ——
{
  const params = { tp: {} }
  setCapTpParam(params, 'A', 'price', 7)
  setCapTpParam(params, 'B', 'price', 5)
  const m = buildCapModel(ITEMS, params, { pbw: CAP_PBW.SUM })
  const zh = capReportBlock(m, { lang: 'zh', adaptive: true })
  ok('报告：表头＝参数 + 各转发器 + 合计', JSON.stringify(zh.head) === '["参数","甲星","乙星","合计"]', JSON.stringify(zh.head))
  const row = (b, prefix) => b.rows.find((r) => r[0].startsWith(prefix))
  ok('报告：载波数一行', JSON.stringify(row(zh, '载波数')) === '["载波数","31","1","32"]', JSON.stringify(row(zh, '载波数')))
  ok('报告：单位进行名', row(zh, '载波带宽')[0] === '载波带宽（MHz）' && row(zh, '容量')[0] === '容量（Mbps）')
  ok('报告：功率带宽一行合计格为「—」', row(zh, '功率带宽')[3] === '—' && row(zh, '功率带宽')[1] === '18.580')
  ok('报告：剩余 / 占用只按组给', row(zh, '剩余功率')[1] === '17.420' && row(zh, '功率占用')[3] === '—')
  ok('报告：资费三行（有单价才出）', !!row(zh, '单价') && !!row(zh, '年费') && !!row(zh, '单位容量成本') && row(zh, '年费')[3] !== '—')
  ok('报告：成员只交列入且算出的行', JSON.stringify(zh.members) === JSON.stringify([[{ rowId: 'r1', n: 1 }, { rowId: 'r2', n: 30 }], [{ rowId: 'r5', n: 1 }]]))
  ok('报告：不给 noOf 不出「链路」行', !row(zh, '链路'))
  const withNo = capReportBlock(m, { lang: 'zh', adaptive: true, noOf: (id) => Number(id.slice(1)) + 10 })
  ok('报告：「链路」行按导出编号写成员，合计格空', JSON.stringify(withNo.rows[0]) === '["链路","#11, #12×30","#15",""]', JSON.stringify(withNo.rows[0]))
  ok('报告：题注计数', zh.note === '容量汇总（3 条链路 · 1 条未列入 · 1 条失败已排除）', zh.note)
  const en = capReportBlock(m, { lang: 'en', adaptive: false })
  ok('报告 EN：整列无汉字（转发器名是数据，除外）', en.rows.every((r) => !/[一-鿿]/.test(r[0])) && !/[一-鿿]/.test(en.note) && en.head[0] === 'Parameter' && en.head[3] === 'Total')
  ok('报告 EN：锁定档用 kHz', row(en, 'Allocated BW')[0] === 'Allocated BW (kHz)')
  const ng = capReportBlock(buildCapModel(ITEMS, { tp: {} }, { pbw: CAP_PBW.LIST }), { lang: 'zh' })
  ok('报告 NGSO：不出功率带宽 / 可用功率 / 剩余功率 / 功率占用', !row(ng, '功率带宽') && !row(ng, '可用功率') && !row(ng, '剩余功率') && !row(ng, '功率占用') && !!row(ng, '剩余带宽'))
  ok('报告：没给单价不出资费三行', !row(ng, '单价') && !row(ng, '年费'))
  const rg = capReportBlock(buildCapModel(ITEMS, { tp: {} }, { pbw: CAP_PBW.NONE, availDefault: false }), { lang: 'zh' })
  ok('报告 再生式：没填可用带宽就不出可用 / 剩余 / 占用', !row(rg, '可用带宽') && !row(rg, '剩余带宽') && !row(rg, '带宽占用') && !!row(rg, '结算带宽'))
  const one = capReportBlock(buildCapModel(ITEMS.filter((x) => x.gkey === 'A'), { tp: {} }, { pbw: CAP_PBW.SUM }), { lang: 'zh' })
  ok('报告：一组不出合计列', JSON.stringify(one.head) === '["参数","甲星"]' && one.rows.every((r) => r.length === 2))
  ok('报告：一条都没列入 → 不出这一节', capReportBlock(buildCapModel(ITEMS.map((x) => ({ ...x, cap: { off: true } })), { tp: {} }, {}), { lang: 'zh' }) === null)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
