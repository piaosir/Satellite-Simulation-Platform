// 高级计算「多载波组功带平衡」（VSAT 组网 / CNC 载波叠加）测试。运行：npm test
//
// 关键不变式：
//   ① 标度律——引擎里 carrierTotalCT = 载波门限 + margin、功率占用 = 10^((carrierTotalCT −
//      转发器可用C/T)/10)，而载波带宽只由速率/调制/滚降定，于是【余量抬 x dB ⇔ 功率带宽恰好
//      ×10^(x/10)，载波带宽不动】。整个 advBalance 是闭式解而非二分搜索，全靠这一条；
//      **引擎哪天改了 margin 的进入方式，这条先红**，那时 advBalance 的前提就得重估。
//   ② 解出的余量喂回引擎，Σ功率带宽 = 目标（= 组占用带宽 × 10^(组超发量/10)）——
//      闭式预测与引擎实测须逐位一致，四种口径（严格平衡 / 组超发 / 偏置 / 平衡点基准）都要成立；
//   ③ 偏置＝相对基准的固定错位，整组仍然平——多要的功率由 Δ 让其余载波一起让出来；
//   ④ CNC 带宽只算一份、功率相加；且必须恰好 2 条链路 + 同一份载波配置，否则拦下不给算；
//   ⑤ 不可解要明确报错，且仍把载波清单带回去——界面上的偏置输入就长在那张表里，表一空没地方改；
//   ⑥ 幂等——同一套设置连点几次「应用」，解出的余量必须钉在原地。曾经的 bug：基准取「当前余量」，
//      而上一轮我们自己写回的余量里已经含着那一轮的偏置，于是每应用一次就再叠一层；单载波看不出来
//      （唯一未知数由方程定死、偏置被 Δ 抵消），偏置 ≠ 0 且多份载波才现形——各载波一轮轮错开，
//      余量永远停不下来。修法＝写回时把原始基准钉在配置上（ADV_BASE），下一轮从它起算。
//
// 被测的 advBalance 是渲染端 ESM，故本测试自身也是 .mjs；引擎是 CommonJS，用 createRequire 取。
import { createRequire } from 'node:module'
import {
  solveAdv, validateAdv, validateCnc, planAdvWriteback, advBaseMargin,
  cncModSpec, normCncOpt, CNC_DEFAULTS,
  ADV_MARK, ADV_ORIGIN, ADV_BASE, ADV_OUT
} from '../../../src/shared/advBalance.js'

const require = createRequire(import.meta.url)
const { calculateLinkBudget } = require('../utils/linkCalculator.js')
const { computeLinkMode } = require('../utils/modeSolver.js')
const { setOutputPrecisionBoost } = require('../utils/linkCalculator.js')
// 出参小数位增量：CnC 求解要从 carrierTotalCN 反推门限 C/N，2 位小数的量化会在
// Σ功率带宽 上留下 ~1.4e-4 的相对残差（1.2 kHz / 8.7 MHz）。测这条时临时抬到 4 位。
const withFx = (n, fn) => { const prev = setOutputPrecisionBoost(n); try { return fn() } finally { setOutputPrecisionBoost(prev) } }

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (name, got, want, tol) => ok(name, Math.abs(got - want) <= tol, `得 ${got.toFixed(4)} / 期望 ${want.toFixed(4)}`)

console.log('=== 多载波组功带平衡（VSAT / CNC）===\n')

const SAT = { frequencyBand: 'Ku', satelliteName: 'TestSat', transponderBandwidth: 36, orbitPosition: 110.5 }
// VSAT 式场景：前向 TDM 大载波（高阶调制、大带宽、大站发） + 三条返向 TDMA 小载波（小站发）
const CARRIERS = {
  fwd: { infoRate: 20000, modulation: '16APSK', fec: '3/4', ebno: 8.5, bandwidthFactor: 1.2 },
  rtn: { infoRate: 512, modulation: 'QPSK', fec: '1/2', ebno: 3.5, bandwidthFactor: 1.35 },
  // 非对称 CnC 的返向：2048 kbps QPSK 3/4，完整落在前向 20 Mbps 16APSK 的频带内
  rtnS: { infoRate: 2048, modulation: 'QPSK', fec: '3/4', ebno: 4.5, bandwidthFactor: 1.2 },
  qx: { infoRate: 192, modulation: 'QPSK', fec: '3/4', ebno: 4.5, bandwidthFactor: 1.2 }
}
// CnC 是一对双工：hub 发出去的那条，自己也收得到（同一转发器绕一圈回来）。
// hubD / rmtD 互为对方的收发端——老的 hub + vsatB 是「北京→上海」+「哈尔滨→北京」，
// 收端对不上，物理上根本不是一对 CnC，正是新校验要拦下的那种。
const STATIONS = {
  hubD: { antennaDiameter: 9.0, latitude: 39.9042, longitude: 116.4074, rxAntennaDiameter: 1.8, rxLatitude: 23.1291, rxLongitude: 113.2644 },
  rmtD: { antennaDiameter: 1.8, latitude: 23.1291, longitude: 113.2644, rxAntennaDiameter: 9.0, rxLatitude: 39.9042, rxLongitude: 116.4074 },
  // CDM-Qx §9 Table 9-2 算例的两面天线（4.5 m ↔ 2.4 m）
  qxA: { antennaDiameter: 4.5, latitude: 39.9042, longitude: 116.4074, rxAntennaDiameter: 2.4, rxLatitude: 23.1291, rxLongitude: 113.2644 },
  qxB: { antennaDiameter: 2.4, latitude: 23.1291, longitude: 113.2644, rxAntennaDiameter: 4.5, rxLatitude: 39.9042, rxLongitude: 116.4074 },
  hub: { antennaDiameter: 9.0, latitude: 39.9, longitude: 116.4, rxAntennaDiameter: 9.0, rxLatitude: 31.2, rxLongitude: 121.5 },
  vsatA: { antennaDiameter: 1.2, latitude: 23.1, longitude: 113.3, rxAntennaDiameter: 9.0, rxLatitude: 39.9, rxLongitude: 116.4 },
  vsatB: { antennaDiameter: 1.8, latitude: 45.8, longitude: 126.5, rxAntennaDiameter: 9.0, rxLatitude: 39.9, rxLongitude: 116.4 },
  vsatC: { antennaDiameter: 1.2, latitude: 30.6, longitude: 104.1, rxAntennaDiameter: 9.0, rxLatitude: 39.9, rxLongitude: 116.4 }
}
function run(carrier, station, margin) {
  const r = calculateLinkBudget(SAT, { ...CARRIERS[carrier], ...STATIONS[station], margin: String(margin) })
  if (!r.success) throw new Error('引擎失败: ' + r.message)
  return { bw: parseFloat(r.data.allocBandwidthResult), pbw: parseFloat(r.data.PowerBWResult) }
}
// 窗口里的一行：走 computeLinkMode（与 LinkBudgetApp.compute 同一入口），marginDb 取它回填的
// resolvedMargin —— 通路必须与真窗口一致，否则「余量回读被截成 2 位」这类精度问题测不出来
function runRow(carrier, station, margin) {
  const r = computeLinkMode(SAT, { ...CARRIERS[carrier], ...STATIONS[station], margin: String(margin) }, { mode: 'margin' })
  if (!r.success) throw new Error('引擎失败: ' + r.message)
  return { bw: parseFloat(r.data.allocBandwidthResult), pbw: parseFloat(r.data.PowerBWResult), resolved: r.resolvedMargin }
}

// —— ⓪ 引擎契约：margin 方式下 resolvedMargin 必须是全精度的输入余量 ——
// 归一功率带宽 A = 功率带宽 / 10^(余量/10) 拿它做基准。若退回从 data.marginResult 回读（toFixed(2)），
// 4.567 会读成 4.57，A 偏 0.003 dB，配平结果整体跟着偏，反复应用还会在两个值之间来回跳。
{
  const r = runRow('fwd', 'hub', '4.567')
  ok('resolvedMargin 全精度（不是 marginResult 的 2 位回读）', Math.abs(r.resolved - 4.567) < 1e-12,
    `得 ${r.resolved}`)
  ok('marginResult 仍是 2 位显示值（口径未被改动）', parseFloat(calculateLinkBudget(SAT,
    { ...CARRIERS.fwd, ...STATIONS.hub, margin: '4.567' }).data.marginResult) === 4.57)
}

// —— 引擎契约：附加 C/I（carrierExtCI）——
// 本载波带内的额外干扰（CnC 残余自干扰等）并入载波的 C/(N+I) 要求：
//   C/(N+I) = T 需要 C/N = T − 10lg(1 − 10^((T−C/I)/10))，退化量即后一项，T = 门限C/N + 余量。
// 三条不变式：留空逐位 no-op、退化量闭式一致（且顺着标度律推到功率占用）、C/I ≤ T 拦下。
{
  const LP = { ...CARRIERS.fwd, ...STATIONS.hub, margin: '3' }
  const r0 = calculateLinkBudget(SAT, LP)
  if (!r0.success) throw new Error('引擎失败: ' + r0.message)

  // (1) 留空 = no-op：'' / null / 干脆不传，三份出参与基线【逐键】相同（新键也在内）
  const same = (a, b) => {
    const ka = Object.keys(a), kb = Object.keys(b)
    if (ka.length !== kb.length) return '键数 ' + ka.length + ' vs ' + kb.length
    const eq = (x, y) => (x && typeof x === 'object') || (y && typeof y === 'object')
      ? JSON.stringify(x) === JSON.stringify(y) : x === y   // 出参里有对象值（elevationValidation 等）
    const d = ka.filter((k) => !eq(a[k], b[k]))
    return d.length ? d.slice(0, 3).join(',') : ''
  }
  for (const [name, v] of [['空串', ''], ['null', null], ['undefined', undefined]]) {
    const r = calculateLinkBudget(SAT, { ...LP, carrierExtCI: v })
    const d = r.success ? same(r0.data, r.data) : '引擎失败'
    ok('留空(' + name + ') 与不传逐键相同', d === '', d || '全 ' + Object.keys(r0.data).length + ' 键')
  }
  ok('不计入时 carrierExtDegResult = 0.00 且回显为空串',
    r0.data.carrierExtDegResult === '0.00' && r0.data.carrierExtCIResult === '')

  // (2) 退化量闭式：目标 C/N T = 门限C/N + 余量，取 C/I = T + 7.88 dB
  const T = parseFloat(r0.data.thresholdCN) + 3
  near('目标 C/N ≡ 引擎的 carrierTotalCN（不含本项时）', parseFloat(r0.data.carrierTotalCN), T, 5e-3)
  const CI = T + 7.88
  const wantDeg = -10 * Math.log10(1 - Math.pow(10, (T - CI) / 10))
  const rE = calculateLinkBudget(SAT, { ...LP, carrierExtCI: String(CI.toFixed(4)) })
  if (!rE.success) throw new Error('引擎失败: ' + rE.message)
  near('退化量与闭式一致', parseFloat(rE.data.carrierExtDegResult), wantDeg, 5e-3)
  // §3.2 的定点（任务书探针）：T = 15.92、C/I = 23.8 → 0.77 dB
  near('§3.2 定点 T=15.92 / C/I=23.8 → 0.77 dB',
    -10 * Math.log10(1 - Math.pow(10, (15.92 - 23.8) / 10)), 0.77, 5e-3)
  // 抬的是 C/N 要求，不是余量：linkmargin 与系统余量出参一字不动
  ok('linkmargin 不随附加 C/I 改（余量语义不变）', rE.data.linkmargin === r0.data.linkmargin,
    r0.data.linkmargin + ' → ' + rE.data.linkmargin)
  near('carrierTotalCN 抬高恰好等于退化量',
    parseFloat(rE.data.carrierTotalCN) - parseFloat(r0.data.carrierTotalCN), wantDeg, 5e-3)
  // 顺着 ① 的标度律往下推：C/T 要求抬 x dB ⇒ 功率占用 ×10^(x/10)（份额/功放/级联自然跟随）
  // 比值取 dB（标度律的原式）：功率占用出参是 2 位量化值，直接比绝对值会被量化噪声顶穿
  near('功率占用之比(dB) = 退化量（标度律照旧成立）',
    10 * Math.log10(parseFloat(rE.data.powerUsageRatio) / parseFloat(r0.data.powerUsageRatio)), wantDeg, 5e-3)
  ok('载波带宽不随附加 C/I 变', rE.data.allocBandwidthResult === r0.data.allocBandwidthResult)

  // (3) C/I ≤ T 无解：残余干扰比目标还大，抬多少功率都到不了 —— 报错原文带上两个数
  // T 是拿 2 位显示的 thresholdCN 拼的，比引擎内部全精度目标略高，故「等于」用 T−0.01 逼近
  for (const [name, ci] of [['略低于', T - 0.01], ['明显低于', T - 2]]) {
    const rBad = calculateLinkBudget(SAT, { ...LP, carrierExtCI: String(ci.toFixed(4)) })
    ok('附加 C/I ' + name + '目标 C/N → 报错而非出数',
      !rBad.success && String(rBad.message).includes('附加 C') && String(rBad.message).includes('目标 C'),
      rBad.success ? '竟然算出来了' : rBad.message)
  }
  // 边界确实钉在目标 C/N 上：刚过一点点，退化量就急剧放大（趋于 +∞）
  const rNear = calculateLinkBudget(SAT, { ...LP, carrierExtCI: String((T + 0.01).toFixed(4)) })
  ok('刚高过目标 C/N 一点点 → 退化量急剧放大',
    rNear.success && parseFloat(rNear.data.carrierExtDegResult) > 20,
    rNear.success ? rNear.data.carrierExtDegResult + ' dB' : '报错了')
  // 非数（用户手滑打了个字）按留空处理，不炸
  const rJunk = calculateLinkBudget(SAT, { ...LP, carrierExtCI: 'abc' })
  ok('非数输入按留空处理（不抛错、不计入）',
    rJunk.success && rJunk.data.carrierExtDegResult === '0.00')
}

// —— ① 标度律：功率带宽随余量按 10^(Δ/10) 缩放，载波带宽不动 ——
for (const [c, s] of [['fwd', 'hub'], ['rtn', 'vsatA'], ['rtn', 'vsatB']]) {
  const a = run(c, s, 3)
  let scaleOk = true, bwOk = true
  for (const d of [-4.7, -1, 2.35, 6]) {
    const b = run(c, s, 3 + d)
    if (Math.abs(b.pbw - a.pbw * Math.pow(10, d / 10)) > Math.max(1e-6, a.pbw * 2e-5)) scaleOk = false
    if (b.bw !== a.bw) bwOk = false
  }
  ok(`标度律 ${c}/${s}：功率带宽 ×10^(Δ/10)`, scaleOk)
  ok(`标度律 ${c}/${s}：载波带宽与余量无关`, bwOk)
}

// —— ② / ③ VSAT 组配平：4 条链路 2 份载波 ——
const SET = [
  { no: 1, rowId: 'r1', name: 'Hub→VSAT', carrierId: 'cFwd', carrierName: '前向TDM', c: 'fwd', s: 'hub', m0: 3 },
  { no: 2, rowId: 'r2', name: 'A→Hub', carrierId: 'cRtn', carrierName: '返向TDMA', c: 'rtn', s: 'vsatA', m0: 2 },
  { no: 3, rowId: 'r3', name: 'B→Hub', carrierId: 'cRtn', carrierName: '返向TDMA', c: 'rtn', s: 'vsatB', m0: 2 },
  { no: 4, rowId: 'r4', name: 'C→Hub', carrierId: 'cRtn', carrierName: '返向TDMA', c: 'rtn', s: 'vsatC', m0: 2 }
]
const measure = (set, marginOf) => set.map((x) => {
  const r = run(x.c, x.s, marginOf(x))
  return { ...x, bwKHz: r.bw, pbwKHz: r.pbw, marginDb: marginOf(x) }
})
const base = measure(SET, (x) => x.m0)

for (const [tag, opt] of [
  ['严格平衡', { base: 'current', overDb: 0, state: {} }],
  ['组超发 +1.5 dB', { base: 'current', overDb: 1.5, state: {} }],
  ['前向偏置 +2 dB', { base: 'current', overDb: 0, state: { cFwd: { bias: 2 } } }],
  ['前向 +2 / 返向 −1 双偏置', { base: 'current', overDb: 0, state: { cFwd: { bias: 2 }, cRtn: { bias: -1 } } }],
  ['各自平衡点为基准', { base: 'balance', overDb: 0, state: {} }],
  ['平衡点基准 + 前向偏置 +2 dB', { base: 'balance', overDb: 0, state: { cFwd: { bias: 2 } } }]
]) {
  const res = solveAdv({ mode: 'vsat', picked: base, tpBwMHz: 36, ...opt })
  if (!res.ok) { ok(`VSAT ${tag}`, false, res.message); continue }
  const after = measure(SET, (x) => res.carriers.find((c) => c.id === x.carrierId).toDb)
  const sumP = after.reduce((s, a) => s + a.pbwKHz, 0)
  const sumB = after.reduce((s, a) => s + a.bwKHz, 0)
  const tol = Math.max(0.01, sumB * 2e-5)
  near(`VSAT ${tag}：Σ功率带宽 = 目标`, sumP, sumB * Math.pow(10, opt.overDb / 10), tol)
  near(`VSAT ${tag}：闭式预测 = 引擎实测`, sumP, res.afterPbwKHz, tol)
  // 偏置＝两份载波终余量之差恰好等于偏置之差（相对错位钉死，与 Δ 无关）
  const bias = (id) => ((opt.state[id] || {}).bias || 0)
  const toDb = (id) => res.carriers.find((c) => c.id === id).toDb
  const baseDb = (id) => res.carriers.find((c) => c.id === id).baseDb
  near(`VSAT ${tag}：相对错位 = 基准差 + 偏置差`,
    toDb('cFwd') - toDb('cRtn'), (baseDb('cFwd') - baseDb('cRtn')) + (bias('cFwd') - bias('cRtn')), 1e-9)
}
// 幂等：配平后再解一次，Δ 应为 0（两种基准都是不动点）
for (const b of ['current', 'balance']) {
  const r1 = solveAdv({ mode: 'vsat', picked: base, state: {}, base: b, overDb: 0 })
  const settled = measure(SET, (x) => r1.carriers.find((c) => c.id === x.carrierId).toDb)
  const r2 = solveAdv({ mode: 'vsat', picked: settled, state: {}, base: b, overDb: 0 })
  near(`VSAT 幂等（基准=${b}）：再解 Δ≈0`, r2.deltaDb, 0, 1e-4)
}

// —— ④ CNC：一对双工，带宽只算一份、功率相加；再叠上残余自干扰 ——
// ★ 口径：Σ功率带宽 = 单份载波带宽，是把解出的余量【和附加 C/I】一起喂回引擎之后成立的。
//   只喂余量会短 deg₀ 那一截——固有处理损耗是调制解调器实打实的损耗，抵消深度再深也不消失。
// 站身份两份：hub 在北京（es配置 esHub），远端在广州（esRmt）。两条链路互为收发端。
const SITE = {
  hub: { id: 'esHub', name: '北京', lon: 116.4074, lat: 39.9042 },
  rmt: { id: 'esRmt', name: '广州', lon: 113.2644, lat: 23.1291 }
}
// 一条 CnC 链路行：跑真引擎，把求解层要的那些量原样从出参里取出来
function cncRow(no, rowId, carrier, station, margin, tx, rx, extra, extCI) {
  const lp = { ...CARRIERS[carrier], ...STATIONS[station], margin: String(margin) }
  if (isFinite(extCI)) lp.carrierExtCI = Number(extCI).toFixed(3)   // 写回口径：3 位小数
  const r = calculateLinkBudget(SAT, lp)
  if (!r.success) throw new Error('引擎失败: ' + r.message)
  const d = r.data
  return {
    no, rowId, name: tx.name + '→' + rx.name, error: '',
    carrierId: 'c' + carrier, carrierName: carrier,
    bwKHz: parseFloat(d.allocBandwidthResult), pbwKHz: parseFloat(d.PowerBWResult), marginDb: margin,
    txStationId: tx.id, rxStationId: rx.id, txStationName: tx.name, rxStationName: rx.name,
    longitude: tx.lon, latitude: tx.lat, rxLongitude: rx.lon, rxLatitude: rx.lat,
    symbolRateKsps: parseFloat(d.symbolRateResult), modulation: CARRIERS[carrier].modulation, isNtn: false,
    fUpGHz: 14.0, fDnGHz: 12.5, polUp: 'V', polDn: 'H',
    rainUpDb: parseFloat(d.uplinkRainAttenuation), upcDb: parseFloat(d.UPCmarginResult),
    targetCN: parseFloat(d.carrierTotalCN), extDegDb: parseFloat(d.carrierExtDegResult),
    ...extra
  }
}
// 对称对：两条链路同一份载波（老口径），hub 9 m ↔ 远端 1.8 m
const cncBase = withFx(4, () => [
  cncRow(1, 'r1', 'fwd', 'hubD', 3, SITE.hub, SITE.rmt, { carrierId: 'cCnc', carrierName: 'CNC载波' }),
  cncRow(2, 'r2', 'fwd', 'rmtD', 3, SITE.rmt, SITE.hub, { carrierId: 'cCnc', carrierName: 'CNC载波' })
])
// 「退化归零」的对照档：抵消深度 200 dB【且】固有处理损耗置 0 —— 只有两条都置了，
// 才回到本功能改造前的纯功率账口径（deg₀ 与抵消深度无关，D 拉多高都在）
const DEEP = { cncOpt: { cancelDb: 200, deg0: 0 } }
const cnc = solveAdv({ mode: 'cnc', picked: cncBase, state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
if (!cnc.ok) ok('CNC 配平', false, cnc.message)
else {
  const m = cnc.carriers[0].toDb
  const ciOf = (id) => (cnc.links.find((l) => l.rowId === id) || {}).extCI
  const after = withFx(4, () => [
    cncRow(1, 'r1', 'fwd', 'hubD', m, SITE.hub, SITE.rmt, null, ciOf('r1')),
    cncRow(2, 'r2', 'fwd', 'rmtD', m, SITE.rmt, SITE.hub, null, ciOf('r2'))
  ])
  const sumP = after.reduce((s, a) => s + a.pbwKHz, 0)
  near('CNC：Σ功率带宽 = 单份载波带宽', sumP, after[0].bwKHz, Math.max(0.01, after[0].bwKHz * 2e-5))
  ok('CNC：组占用带宽只算一份', Math.abs(cnc.occBwKHz - cncBase[0].bwKHz) < 1e-9 && Math.abs(cnc.sumBwKHz - 2 * cncBase[0].bwKHz) < 1e-6)
}
// CNC 下 VSAT 那边留的偏置必须被忽略：唯一未知数由方程本身定死，偏置一进来 Σ功率带宽就不等于目标了
{
  const r = solveAdv({ mode: 'cnc', picked: cncBase, state: { cCnc: { bias: 5 } }, base: 'current', overDb: 0, tpBwMHz: 36 })
  ok('CNC：两条链路同一份载波时偏置自然失效（唯一未知数由方程定死，被 Δ 原样抵消）',
    cnc.ok && r.ok && Math.abs(r.carriers[0].toDb - cnc.carriers[0].toDb) < 1e-9)
}



// —— ⑨ 功放标度律：余量抬 x dB ⇒ 功放功率(dBW) 平移 x，选择支不翻转 ——
// 「解后功放要开到多少瓦」在对话框里是闭式预测出来的（不再跑一遍引擎），全靠这一条：
// 引擎里 UPPOWER 含 −转发器工作区回退、DOWNPOWER 含 +载波总C/T，两者随余量 1:1 平移；
// 选哪一支看 uplinkPowerRatio > downlinkPowerRatio，而这两个比同乘一个因子，故不随余量翻转。
// **引擎哪天改了功放那条链，这条先红**，那时对话框的功放读数就得改回「再跑一遍引擎」。
// ★ 前三例的站址没设降雨，此时「上行降雨情景」与「下行降雨情景」退化成同一个晴空场景，
//   两个功率比恒等、选择支压不出来。故第四例显式给雨（发端雨大 ⇒ 真正走上行支）。
for (const [c, st, rain] of [['fwd', 'hub'], ['rtn', 'vsatA'], ['rtn', 'vsatB'],
  ['fwd', 'hub', { rainRate: '60', rxRainRate: '5', uplinkAvailability: '99.9', rxDownlinkAvailability: '99.9' }],
  ['fwd', 'hub', { rainRate: '5', rxRainRate: '80', uplinkAvailability: '99.9', rxDownlinkAvailability: '99.9' }]]) {
  const tag = st + (rain ? '·雨' + rain.rainRate + '/' + rain.rxRainRate : '')
  const at = (m) => {
    const r = calculateLinkBudget(SAT, { ...CARRIERS[c], ...STATIONS[st], ...(rain || {}), margin: String(m) })
    if (!r.success) throw new Error('引擎失败: ' + r.message)
    return { pa: parseFloat(r.data.paRecommendationdBResult), paW: parseFloat(r.data.paRecommendation),
      up: parseFloat(r.data.uplinkPowerRatioResult), dn: parseFloat(r.data.downlinkPowerRatioResult) }
  }
  const a = at(3)
  // 防空转：键名写错时两个比都是 NaN，而 NaN > NaN 恒假 —— 下面那条「选择支不翻转」
  // 会两边同为 false 而恒过。故先钉一条「确实取到了数」。
  ok(`⑨ 功放标度律 ${c}/${tag}：上下行功率比取到了数`, isFinite(a.up) && isFinite(a.dn), `${a.up} / ${a.dn}`)
  let shiftOk = true, branchOk = true, wattOk = true
  for (const d of [-4.7, -1, 2.35, 6]) {
    const b = at(3 + d)
    if (Math.abs((b.pa - a.pa) - d) > 5e-3) shiftOk = false
    if ((b.up > b.dn) !== (a.up > a.dn)) branchOk = false
    // 瓦特侧同一条律：P_after = P_before × 10^(Δ/10)（对话框的闭式预测就是这一式）
    // 出参 toFixed(3)：两个值各带半个 ULP，0.6 W 上就是 8e-4 的相对量，故按【绝对】量化精度判
    if (Math.abs(b.paW - a.paW * Math.pow(10, d / 10)) > 0.0015) wattOk = false
  }
  ok(`⑨ 功放标度律 ${c}/${tag}：功放 dBW 随余量 1:1 平移`, shiftOk)
  ok(`⑨ 功放标度律 ${c}/${tag}：选择支不随余量翻转`, branchOk, `上/下行功率比 ${a.up.toFixed(2)} / ${a.dn.toFixed(2)}`)
  ok(`⑨ 功放标度律 ${c}/${tag}：瓦特侧 ×10^(Δ/10)（对话框闭式预测的依据）`, wattOk)
}

// —— ⑮ 路数：一行代表 N 路完全相同的载波 ——
// 组网里 20 个远端跑同一份返向配置是常态，改造前要建 20 行；带路数之后一行搞定，
// 但两种建法必须给出【逐位相同】的解 —— 否则用户会发现「怎么改个建法余量就变了」。
{
  const one = measure(SET, (x) => x.m0)
  // 把返向那三条各当 7 路（共 21 路返向 + 1 路前向）
  const K = 7
  const withCount = one.map((p) => (p.carrierId === 'cRtn' ? { ...p, count: K } : p))
  // 等价建法：把每条返向行原样复制 K 份
  const expanded = []
  let no = 0
  for (const p of one) {
    const k = p.carrierId === 'cRtn' ? K : 1
    for (let i = 0; i < k; i++) { no++; expanded.push({ ...p, no, rowId: p.rowId + '_' + i }) }
  }
  const rc = solveAdv({ mode: 'vsat', picked: withCount, state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
  const re = solveAdv({ mode: 'vsat', picked: expanded, state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
  ok('⑮ 两种建法都可解', rc.ok && re.ok, (rc.message || '') + (re.message || ''))
  if (rc.ok && re.ok) {
    const mc = Object.fromEntries(rc.carriers.map((c) => [c.id, c.toDb]))
    const me = Object.fromEntries(re.carriers.map((c) => [c.id, c.toDb]))
    // 「逐位相同」做不到、也不该要：c.A 一边是 x×N、一边是 x 加 N 次，浮点末位本就不同
    // （实测 2.7e-15 dB）。写回只留 3 位小数，1e-12 已比它小六个数量级。
    const worst = Math.max(...Object.keys(mc).map((k) => Math.abs(mc[k] - me[k])))
    ok('⑮ 路数 N 与 N 行等价配置：解出的余量一致到 1e-12 dB（写回只留 3 位）',
      worst < 1e-12, '最坏差 ' + worst.toExponential(2) + ' dB · ' + Object.entries(mc).map(([k, v]) => k + ' ' + v.toFixed(6)).join(' · '))
    near('⑮ Σ载波带宽也一致', rc.sumBwKHz, re.sumBwKHz, 1e-9)
    near('⑮ Σ功率带宽也一致', rc.afterPbwKHz, re.afterPbwKHz, 1e-6)
    near('⑮ 仍然是平的（Σ功率带宽 = 目标）', rc.afterPbwKHz, rc.targetKHz, 1e-9)
    ok('⑮ 载波清单带出路数（返向 3 条 × 7 = 21 路）',
      rc.carriers.find((c) => c.id === 'cRtn').nWays === 21 && rc.carriers.find((c) => c.id === 'cFwd').nWays === 1)
    // 路数缺省 / 脏值一律归 1，不把整组账算没
    for (const bad of [undefined, null, '', 0, -3, 'abc', 1.4]) {
      const r = solveAdv({ mode: 'vsat', picked: one.map((p) => ({ ...p, count: bad })), state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
      const b = solveAdv({ mode: 'vsat', picked: one, state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
      if (!r.ok || Math.abs(r.carriers[0].toDb - b.carriers[0].toDb) > 1e-9) {
        ok('⑮ 路数脏值(' + String(bad) + ')归 1', false); break
      }
    }
    ok('⑮ 路数为空 / 0 / 负数 / 非数 / 小数一律归 1', true)
  }
}

// —— ⑯ 指定带宽目标：对着租下来的那一段配，而不是对着 Σ载波带宽 ——
// 保护带与载波间隔留白由此进账：租 9 MHz 而载波只占 8.2 MHz 时，功率该按 9 MHz 配。
{
  const one = measure(SET, (x) => x.m0)
  const r = solveAdv({ mode: 'vsat', picked: one, state: {}, base: 'current', overDb: 0, tpBwMHz: 36, target: 'fixed', targetBwMHz: 9 })
  ok('⑯ 指定带宽可解', r.ok, r.message)
  if (r.ok) {
    near('⑯ Σ功率带宽 = 9 MHz', r.afterPbwKHz, 9000, 1e-6)
    near('⑯ 目标 = 9 MHz', r.targetKHz, 9000, 1e-9)
    ok('⑯ 组占用带宽读数仍是 Σ载波带宽（目标换了，占用没换）',
      Math.abs(r.occBwKHz - one.reduce((s, p) => s + p.bwKHz, 0)) < 1e-9)
  }
  const r2 = solveAdv({ mode: 'vsat', picked: one, state: {}, base: 'current', overDb: 1.5, tpBwMHz: 36, target: 'fixed', targetBwMHz: 9 })
  near('⑯ 指定带宽 + 组超发 1.5 dB：Σ功率带宽 = 9 MHz × 10^(1.5/10)',
    r2.ok ? r2.afterPbwKHz : NaN, 9000 * Math.pow(10, 0.15), 1e-6)
  ok('⑯ 指定带宽为 0 / 空 → 拦下而不是算成 0',
    !solveAdv({ mode: 'vsat', picked: one, state: {}, base: 'current', overDb: 0, target: 'fixed', targetBwMHz: 0 }).ok
    && !solveAdv({ mode: 'vsat', picked: one, state: {}, base: 'current', overDb: 0, target: 'fixed', targetBwMHz: '' }).ok)
  // 喂回引擎核对：解出的余量拿去真算一遍，Σ功率带宽 仍是 9 MHz
  const back = measure(SET, (x) => r.carriers.find((c) => c.id === x.carrierId).toDb)
  near('⑯ 闭式预测 = 引擎实测', back.reduce((s, p) => s + p.pbwKHz, 0), 9000, Math.max(0.01, 9000 * 2e-5))
}

// —— ⑰ 三条组网告警：功放超预设 / 多载波回退 / 全表占用 ——
{
  const one = measure(SET, (x) => x.m0)
  // 功放：给发端站型一个偏小的预设，解后必然超
  const withPa = one.map((p) => ({ ...p, paW: 20, paPresetW: 25 }))
  const r = solveAdv({ mode: 'vsat', picked: withPa, state: {}, base: 'current', overDb: 6, tpBwMHz: 36 })
  ok('⑰ 功放解后超发端站型预设 → 告警', r.ok && r.warnings.some((w) => w.includes('功放需')),
    r.ok ? (r.warnings.find((w) => w.includes('功放需')) || '（无）') : r.message)
  ok('⑰ 功放闭式：解后 = 此刻 × 10^(Δ余量/10)', r.ok && r.links.every((l) =>
    Math.abs(l.paAfterW - l.paBeforeW * Math.pow(10, (l.marginAfter - l.marginBefore) / 10)) < 1e-9))
  const rOk = solveAdv({ mode: 'vsat', picked: one.map((p) => ({ ...p, paW: 20, paPresetW: 400 })), state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
  ok('⑰ 功放够用则不告警', rOk.ok && !rOk.warnings.some((w) => w.includes('功放需')))
  // 转发器回退：多载波组而卫星条目上填的是单载波回退
  const sc = one.map((p) => ({ ...p, booDb: 0.5, boiDb: 1 }))
  ok('⑰ 多载波组 + 单载波回退 → 告警',
    solveAdv({ mode: 'vsat', picked: sc, state: {}, base: 'current', overDb: 0, tpBwMHz: 36 }).warnings.some((w) => w.includes('多载波组')))
  ok('⑰ 多载波回退够深则不告警',
    !solveAdv({ mode: 'vsat', picked: one.map((p) => ({ ...p, booDb: 3, boiDb: 6 })), state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
      .warnings.some((w) => w.includes('多载波组')))
  ok('⑰ 卫星条目没给回退则不判', !solveAdv({ mode: 'vsat', picked: one, state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
    .warnings.some((w) => w.includes('多载波组')))
  // 全表占用：表里还有两条没参与配平的行
  const others = [
    { ...one[0], rowId: 'x1', no: 90 },
    { ...one[1], rowId: 'x2', no: 91, count: 3 }
  ]
  const rAll = solveAdv({ mode: 'vsat', picked: one, state: {}, base: 'current', overDb: 0, tpBwMHz: 36, allRows: [...one, ...others] })
  ok('⑰ 全表占用比本组高（表里还有别的载波在同一只转发器上）',
    rAll.ok && rAll.pwUseAllPct > rAll.pwUsePct && rAll.bwUseAllPct > rAll.bwUsePct,
    rAll.ok ? `本组 带宽 ${rAll.bwUsePct.toFixed(2)}% / 功率 ${rAll.pwUsePct.toFixed(2)}% · 全表 带宽 ${rAll.bwUseAllPct.toFixed(2)}% / 功率 ${rAll.pwUseAllPct.toFixed(2)}%` : rAll.message)
  ok('⑰ 全表占用把未勾选行的路数也算进去', rAll.ok && rAll.allRowsN === 6)
  ok('⑰ 宿主没给 allRows 时不出这个读数（不编数）',
    !('bwUseAllPct' in solveAdv({ mode: 'vsat', picked: one, state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })))
}

// —— ⑩ CnC 双工配对：各站必须收到自己的上行回波 ——
// 这是改造前最大的窟窿：Hub→A 与 Hub→B 两条同载波链路也能过校验，可那不是一对双工，
// 两个远端谁也收不到自己发的东西，抵消无从谈起。
{
  const SITE_A = { id: 'esA', name: '上海', lon: 121.4737, lat: 31.2304 }
  const SITE_B = { id: 'esB', name: '成都', lon: 104.0665, lat: 30.5728 }
  const hubToA = withFx(4, () => cncRow(1, 'r1', 'fwd', 'hubD', 3, SITE.hub, SITE_A))
  const hubToB = withFx(4, () => cncRow(2, 'r2', 'fwd', 'hubD', 3, SITE.hub, SITE_B))
  ok('⑩ Hub→A + Hub→B 被拦下（不是一对双工）', !!validateCnc([hubToA, hubToB]))
  ok('⑩ A→B + B→A 通过', validateCnc(cncBase) === '', validateCnc(cncBase) || '通过')
  // 经纬度缺失时退回站址名（老存档 / 手填站没有坐标）
  const strip = (p) => { const q = { ...p }; delete q.longitude; delete q.latitude; delete q.rxLongitude; delete q.rxLatitude; return q }
  ok('⑩ 经纬度缺失 → 退回站址名配对', validateCnc(cncBase.map(strip)) === '')
  ok('⑩ 站址名也没有 → 判不了身份就不放行',
    !!validateCnc(cncBase.map((p) => { const q = strip(p); delete q.txStationName; delete q.rxStationName; delete q.txStationId; delete q.rxStationId; return q })))
  // 同一站的经纬度差 1e-5°（约 1 m）仍算同一站
  const jitter = cncBase.map((p, i) => (i === 1 ? { ...p, rxLongitude: p.rxLongitude + 1e-5 } : p))
  ok('⑩ 经纬度容差 1e-4°：抖 1e-5° 仍是同一站', validateCnc(jitter) === '')
  ok('⑩ 差 0.01°（约 1 km）判成两站', !!validateCnc(cncBase.map((p, i) => (i === 1 ? { ...p, rxLatitude: p.rxLatitude + 0.01 } : p))))
  // 3GPP NTN 行不支持
  ok('⑩ 3GPP NTN 载波拦下', !!validateCnc([{ ...cncBase[0], isNtn: true }, cncBase[1]]))
}

// —— ⑪ CnC 非对称：前向大载波 + 返向小载波（同频叠加，窄的完整落在宽的里面）——
// 改造前要求「两条链路引用同一份载波配置」＝同速率同调制，真实 CnC 多数不是这样。
const ASYM = withFx(4, () => [
  cncRow(1, 'r1', 'fwd', 'hubD', 3, SITE.hub, SITE.rmt, { carrierId: 'cFwd', carrierName: '前向20M' }),
  cncRow(2, 'r2', 'rtnS', 'rmtD', 3, SITE.rmt, SITE.hub, { carrierId: 'cRtnS', carrierName: '返向2M' })
])
{
  ok('⑪ 非对称（20 Mbps 16APSK ⊃ 2048 kbps QPSK）频率包含通过', validateCnc(ASYM) === '',
    validateCnc(ASYM) || `${ASYM[0].bwKHz.toFixed(0)} kHz ⊃ ${ASYM[1].bwKHz.toFixed(0)} kHz`)
  const room = (Math.max(ASYM[0].bwKHz, ASYM[1].bwKHz) - Math.min(ASYM[0].bwKHz, ASYM[1].bwKHz)) / 2
  const off = ASYM.map((p, i) => (i === 1 ? { ...p, fUpGHz: p.fUpGHz + 0.005 } : p))   // 偏 5 MHz
  ok('⑪ 上行中心频率偏 5 MHz → 拦下', !!validateCnc(off), `允许 ${(room / 1000).toFixed(2)} MHz`)
  ok('⑪ 极化不同 → 拦下', !!validateCnc(ASYM.map((p, i) => (i === 1 ? { ...p, polUp: 'H' } : p))))
  const rA = solveAdv({ mode: 'cnc', picked: ASYM, state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
  ok('⑪ 非对称可解', rA.ok, rA.message)
  if (rA.ok) {
    const ratio = Math.max(ASYM[0].symbolRateKsps / ASYM[1].symbolRateKsps, ASYM[1].symbolRateKsps / ASYM[0].symbolRateKsps)
    ok('⑪ 符号率比超 3:1 → 告警（能算，但越界）',
      ratio > 3 && rA.warnings.some((w) => w.includes('符号率比')), `实际 ${ratio.toFixed(2)}:1`)
    ok('⑪ 组占用带宽取宽的那一份', Math.abs(rA.occBwKHz - Math.max(ASYM[0].bwKHz, ASYM[1].bwKHz)) < 1e-9)
    near('⑪ 闭式 Σ功率带宽 = 目标', rA.afterPbwKHz, rA.targetKHz, 1e-6)
    // 两份载波两个未知数 ⇒ 偏置重新有意义（对称情形下它被 Δ 抵消）
    const rB = solveAdv({ mode: 'cnc', picked: ASYM, state: { cRtnS: { bias: 2 } }, base: 'current', overDb: 0, tpBwMHz: 36 })
    ok('⑪ 非对称下偏置生效（两份载波 = 两个未知数）',
      rB.ok && Math.abs(rB.carriers.find((c) => c.id === 'cRtnS').toDb - rA.carriers.find((c) => c.id === 'cRtnS').toDb) > 0.5)
    near('⑪ 带偏置后仍然是平的', rB.afterPbwKHz, rB.targetKHz, 1e-6)
  }
}

// —— ⑫ 残余自干扰的定点：收敛 / 幂等 / 退化为老口径 ——
{
  const r = solveAdv({ mode: 'cnc', picked: cncBase, state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
  ok('⑫ 迭代收敛', r.ok && r.cnc.converged, r.ok ? `${r.cnc.iters} 轮` : r.message)
  ok('⑫ 两收端 ρ 反号（同一个比值，站在两头看）',
    Math.abs(r.cnc.sides[0].rhoClear + r.cnc.sides[1].rhoClear) < 1e-9,
    `${r.cnc.sides[0].rhoClear.toFixed(3)} / ${r.cnc.sides[1].rhoClear.toFixed(3)} dB`)
  ok('⑫ 残余 C/I = 抵消深度 − ρ_max',
    Math.abs(r.cnc.sides[0].ciRes - (r.cnc.cancelDb - r.cnc.sides[0].rhoMax)) < 1e-9)
  ok('⑫ 退化量与「附加 C/I 折 C/N」闭式一致', r.cnc.sides.every((sd) =>
    Math.abs(sd.deg - (-10 * Math.log10(1 - Math.pow(10, (sd.targetCN - sd.ci) / 10)))) < 1e-9))
  ok('⑫ hub 侧（自身回波更强）退化明显大于远端侧',
    r.cnc.sides[0].deg > r.cnc.sides[1].deg,
    `${r.cnc.sides[0].deg.toFixed(3)} vs ${r.cnc.sides[1].deg.toFixed(3)} dB`)
  // 幂等：把解出的余量与附加 C/I 都喂回引擎重建行，再解一次 —— Δ 必须停在原地
  const m = r.carriers[0].toDb
  const ciOf2 = (id) => (r.links.find((l) => l.rowId === id) || {}).extCI
  const again = withFx(4, () => [
    cncRow(1, 'r1', 'fwd', 'hubD', m, SITE.hub, SITE.rmt, { carrierId: 'cCnc', carrierName: 'CNC载波', baseDb: 3 }, ciOf2('r1')),
    cncRow(2, 'r2', 'fwd', 'rmtD', m, SITE.rmt, SITE.hub, { carrierId: 'cCnc', carrierName: 'CNC载波', baseDb: 3 }, ciOf2('r2'))
  ])
  const r2 = solveAdv({ mode: 'cnc', picked: again, state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
  near('⑫ 幂等：再解 Δ ≈ 0（归一值把上一轮的退化量剥干净了）', r2.ok ? r2.carriers[0].toDb - m : NaN, 0, 5e-3)
  // D = ∞ 且 deg₀ = 0 ⇒ 退化量归零，回到改造前的纯功率账
  const r3 = solveAdv({ mode: 'cnc', picked: cncBase, state: {}, base: 'current', overDb: 0, tpBwMHz: 36, ...DEEP })
  ok('⑫ D=∞ 且 deg₀=0 → 退化量归零（＝改造前的纯功率账）',
    r3.ok && r3.cnc.sides.every((sd) => sd.deg < 1e-6) && r3.links.every((l) => l.extDeg < 1e-6))
  near('⑫ 该口径下 Σ功率带宽 = 单份载波带宽', r3.ok ? r3.afterPbwKHz : NaN, cncBase[0].bwKHz, 1e-6)
  // 抵消深度越浅，退化越大（单调）
  const degAt = (D) => {
    const x = solveAdv({ mode: 'cnc', picked: cncBase, state: {}, base: 'current', overDb: 0, tpBwMHz: 36, cncOpt: { cancelDb: D } })
    return x.ok ? x.cnc.sides[0].deg : NaN
  }
  const d25 = degAt(25), d28 = degAt(28), d30 = degAt(30)
  ok('⑫ 抵消深度 25 / 28 / 30 dB → 退化单调下降', d25 > d28 && d28 > d30,
    `${d25.toFixed(2)} / ${d28.toFixed(2)} / ${d30.toFixed(2)} dB`)
}

// —— ⑬ 雨衰耦合：ρ 随上行雨衰漂，CnC 的可用性由 C/N 余量与 PSD 窗口两道门共同决定 ——
{
  const withRain = (r1, r2) => cncBase.map((p, i) => ({ ...p, rainUpDb: i === 0 ? r1 : r2, upcDb: 0 }))
  const dry = solveAdv({ mode: 'cnc', picked: withRain(0, 0), state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
  const wet = solveAdv({ mode: 'cnc', picked: withRain(1.5, 2.83), state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
  ok('⑬ 无雨时 ρ 区间坍缩到晴空值',
    dry.ok && Math.abs(dry.cnc.sides[0].rhoMin - dry.cnc.sides[0].rhoMax) < 1e-9)
  ok('⑬ ρ_max = ρ_clear + 对端上行残余雨衰', wet.ok
    && Math.abs(wet.cnc.sides[0].rhoMax - (wet.cnc.sides[0].rhoClear + 2.83)) < 1e-9,
    wet.ok ? `${wet.cnc.sides[0].rhoClear.toFixed(2)} + 2.83 = ${wet.cnc.sides[0].rhoMax.toFixed(2)} dB` : wet.message)
  ok('⑬ ρ_min = ρ_clear − 本端上行残余雨衰', wet.ok
    && Math.abs(wet.cnc.sides[0].rhoMin - (wet.cnc.sides[0].rhoClear - 1.5)) < 1e-9)
  // UPC 全补偿 ⇒ 残余雨衰为 0 ⇒ 区间坍缩
  const upc = solveAdv({ mode: 'cnc', picked: cncBase.map((p, i) => ({ ...p, rainUpDb: i === 0 ? 1.5 : 2.83, upcDb: i === 0 ? 1.5 : 2.83 })),
    state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
  ok('⑬ UPC 全补偿 → 残余雨衰 0，区间坍缩', upc.ok
    && Math.abs(upc.cnc.sides[0].rhoMin - upc.cnc.sides[0].rhoMax) < 1e-9)
  // CnC-APC 开 ⇒ ρ 视为被保持，区间同样坍缩到晴空（但雨还在下）
  const apc = solveAdv({ mode: 'cnc', picked: withRain(1.5, 2.83), state: {}, base: 'current', overDb: 0, tpBwMHz: 36, cncOpt: { apc: true } })
  ok('⑬ CnC-APC 开 → 区间坍缩到晴空', apc.ok
    && Math.abs(apc.cnc.sides[0].rhoMin - apc.cnc.sides[0].rhoClear) < 1e-9
    && Math.abs(apc.cnc.sides[0].rhoMax - apc.cnc.sides[0].rhoClear) < 1e-9)
  ok('⑬ 雨衰把退化推大（设计点取 ρ_max 而不是晴空值）',
    wet.ok && apc.ok && wet.cnc.sides[0].deg > apc.cnc.sides[0].deg,
    wet.ok && apc.ok ? `${wet.cnc.sides[0].deg.toFixed(3)} vs ${apc.cnc.sides[0].deg.toFixed(3)} dB` : '')
  // PSD 窗口：16APSK 走 −7～+7 一档；窗口裕量 = min(ρ_min − 下沿, 上沿 − ρ_max)
  const sp = cncModSpec('16APSK')
  ok('⑬ 16APSK 查到 −7～+7 窗与 deg₀ 0.6 dB', sp.win[0] === -7 && sp.win[1] === 7 && sp.deg0 === 0.6)
  ok('⑬ QPSK 查到 −7～+11 窗与 deg₀ 0.3 dB',
    cncModSpec('QPSK').win[1] === 11 && cncModSpec('QPSK').deg0 === 0.3)
  ok('⑬ 64APSK 无厂家窗（返 null）+ deg₀ 取最保守一档', cncModSpec('64APSK').win === null && !cncModSpec('64APSK').known)
  ok('⑬ 窗口裕量 = min(ρ_min − 下沿, 上沿 − ρ_max)', wet.ok && wet.cnc.sides.every((sd) =>
    Math.abs(sd.windowMargin - Math.min(sd.rhoMin - sd.window[0], sd.window[1] - sd.rhoMax)) < 1e-9))
  ok('⑬ 允许对端衰落 = 上沿 − ρ_clear', wet.ok
    && Math.abs(wet.cnc.sides[0].allowFadeDes - (wet.cnc.sides[0].window[1] - wet.cnc.sides[0].rhoClear)) < 1e-9,
    wet.ok ? `允许 ${wet.cnc.sides[0].allowFadeDes.toFixed(2)} dB / 设计 ${wet.cnc.sides[0].designFadeDes.toFixed(2)} dB` : '')
  // 窗口裕量为负 → 告警（C/N 余量还够，CnC 已经先掉线）
  const over = solveAdv({ mode: 'cnc', picked: withRain(0, 9), state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
  ok('⑬ 窗口裕量为负 → 告警', over.ok && over.warnings.some((w) => w.includes('窗口裕量')),
    over.ok ? over.cnc.sides.map((sd) => sd.windowMargin.toFixed(2)).join(' / ') : over.message)
  // 手填窗口覆盖查表
  const manual = solveAdv({ mode: 'cnc', picked: cncBase, state: {}, base: 'current', overDb: 0, tpBwMHz: 36, cncOpt: { window: [-3, 3] } })
  ok('⑬ 手填窗口覆盖查表值', manual.ok && manual.cnc.sides[0].window[1] === 3 && manual.cnc.windowManual)
}

// —— ⑭ CDM-Qx §9 Table 9-2 算例夹具：4.5 m ↔ 2.4 m、192 kbps ——
// 只对【本平台引擎】的比值断言（两家引擎的绝对功率口径不同，不可比）。两处诚实边界：
//
// ① CnC 比：厂家算例是 ±5.3 dB，本平台这套参数下约 ±1.3 dB。方向一致（发往小站那条占更多
//    转发器功率：算例 0.37 % / 0.11 %，本平台 0.188 % / 0.140 %），量级对不上是因为算例的
//    卫星 SFD / G·T / 两端功放这些决定功率劈分的参数手册没给全，拿本平台的缺省星去凑没有意义。
//    故这里只断言【方向】与【两侧反号】，比值本身按本平台实测记录在读数里。
// ② 总退化：厂家两份资料互相对不上 —— CDM-625A 数据表说 QPSK 在 PSD 比 0 dB 时固有处理损耗
//    就有 0.3 dB，而 CDM-Qx §9 算例给的总退化是 −0.1 / 0.0 dB。总退化不可能小于固有损耗，
//    两者不能同时成立。本平台按数据表建模（固有 0.3 + 抵消残余），故总退化必 ≥ 0.3 dB；
//    可核的是【抵消残余那一项】：置 deg₀ = 0 后它在 D = 28 dB 下应远小于 0.2 dB，这一条能测。
{
  const QX = withFx(4, () => [
    cncRow(1, 'r1', 'qx', 'qxA', 3, SITE.hub, SITE.rmt, { carrierId: 'cQx', carrierName: 'Qx载波' }),
    cncRow(2, 'r2', 'qx', 'qxB', 3, SITE.rmt, SITE.hub, { carrierId: 'cQx', carrierName: 'Qx载波' })
  ])
  const r = solveAdv({ mode: 'cnc', picked: QX, state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
  ok('⑭ 算例可解', r.ok, r.message)
  if (r.ok) {
    const rho = r.cnc.sides[0].rhoClear
    ok('⑭ CnC 比：发往小站那条占更多功率（与算例同向），两侧反号',
      rho > 0 && Math.abs(rho + r.cnc.sides[1].rhoClear) < 1e-9,
      `本平台 ${rho.toFixed(2)} dB / 厂家算例 ±5.3 dB —— 量级差见上方注释①`)
    // 抵消残余那一项（置 deg₀ = 0 单独看）：D = 28 dB 下应远小于 0.2 dB —— 这是 D 的缺省值
    // 由算例反推出来的依据，也是本模型唯一能与算例对上的一处
    const resOnly = solveAdv({ mode: 'cnc', picked: QX, state: {}, base: 'current', overDb: 0, tpBwMHz: 36, cncOpt: { deg0: 0 } })
    ok('⑭ 抵消残余项 @ D=28 dB ≤ 0.2 dB（deg₀ 单独扣掉看）',
      resOnly.ok && resOnly.cnc.sides.every((sd) => sd.deg <= 0.2),
      resOnly.ok ? resOnly.cnc.sides.map((sd) => sd.deg.toFixed(4)).join(' / ') + ' dB' : resOnly.message)
    ok('⑭ 总退化 ≥ 固有处理损耗（0.3 dB，QPSK）—— 抵消再深也去不掉这一截',
      r.cnc.sides.every((sd) => sd.deg >= 0.3),
      r.cnc.sides.map((sd) => sd.deg.toFixed(3)).join(' / ') + ' dB')
    near('⑭ 节省带宽 = 1 − 组占用/Σ载波带宽', r.cnc.bwSaving, 1 - r.occBwKHz / r.sumBwKHz, 1e-12)
    near('⑭ 对称一对省掉一半带宽', r.cnc.bwSaving, 0.5, 1e-9)
    ok('⑭ 符号率比 1:1，不触上限', Math.abs(r.cnc.rsRatio - 1) < 1e-9 && !r.warnings.some((w) => w.includes('符号率比')))
  }
}

// —— ⑤ 拦截与不可解 ——
ok('CNC 拦下 3 条链路', !!validateAdv('cnc', [...cncBase, { ...cncBase[0], no: 3, rowId: 'r3' }]))
ok('CNC 不再要求同一份载波配置（非对称是常态）',
  !validateAdv('cnc', [cncBase[0], { ...cncBase[1], carrierId: 'other', carrierName: '另一载波' }]))
ok('拦下空选择', !!validateAdv('vsat', []))
ok('拦下无结果的行', !!validateAdv('vsat', [{ no: 1, bwKHz: NaN, pbwKHz: NaN, marginDb: NaN, error: '卫星不可见' }]))
const noP = base.map((p) => ({ ...p, pbwKHz: 0 }))   // 带宽还在、功率带宽为 0：过得了校验，解不出来
const zeroBal = solveAdv({ mode: 'vsat', picked: noP, state: {}, base: 'balance', overDb: 0 })
ok('平衡点基准算不出 → 不可解', !zeroBal.ok)
ok('不可解仍带回载波清单（界面上的偏置输入才有地方改）', zeroBal.carriers.length === 2)
ok('功率带宽全为 0 → 不可解', !solveAdv({ mode: 'vsat', picked: noP, state: {}, base: 'current', overDb: 0 }).ok)

// —— 兜底：脏输入不炸 ——
ok('缺参不炸', (() => { try { return solveAdv({}).ok === false } catch (e) { return false } })())
ok('负余量出警告', (() => {
  const r = solveAdv({ mode: 'vsat', picked: base, state: { cFwd: { bias: 12 } }, base: 'current', overDb: 0 })
  return r.ok && r.warnings.some((w) => w.includes('负余量'))
})())

// —— ⑥ 写回落点 planAdvWriteback ——
// 不变式：VSAT 永不动用户原来的载波配置（组网平衡是「这组链路在这套工况下」的结论，不是载波自身的
// 属性，一份配置装不下多个结果）；反复配平复用同一份副本；CNC 则就地改（两条链路本就同一份载波）。
//
// 迷你宿主：把载波库 + 链路表当成真实状态，照 ops 执行一遍——两个窗口的 applyAdvPlan 就是这么干的
function makeLib() {
  return {
    configs: [
      { id: 'bb1', name: '前向TDM', form: { calcMode: 'balance', margin: '3' } },
      { id: 'bb2', name: '返向TDMA', form: { calcMode: 'balance', margin: '2' } }
    ],
    rows: [
      { rowId: 'r1', carrierId: 'bb1' }, { rowId: 'r2', carrierId: 'bb2' },
      { rowId: 'r3', carrierId: 'bb2' }, { rowId: 'r4', carrierId: 'bb2' }
    ],
    seq: 3
  }
}
function runApply(lib, mode, carriers, rowIds) {
  const { ops } = planAdvWriteback({ mode, carriers, rowIds, rows: lib.rows, configs: lib.configs })
  const forks = []
  for (const op of ops) {
    if (op.kind === 'fork') {
      const from = lib.configs.find((c) => c.id === op.fromId)
      const copy = { id: 'bb' + (lib.seq++), name: op.name, form: { ...JSON.parse(JSON.stringify(from.form)), ...op.formPatch } }
      lib.configs.push(copy)
      for (const r of lib.rows) if (op.rowIds.includes(r.rowId)) r.carrierId = copy.id
      forks.push(copy)
    } else {
      Object.assign(lib.configs.find((c) => c.id === op.carrierId).form, op.formPatch)
    }
  }
  return { ops, forks }
}
const PLAN = [{ id: 'bb1', toDb: 4.5 }, { id: 'bb2', toDb: 1.25 }]
const ALL = ['r1', 'r2', 'r3', 'r4']

{ // VSAT 全勾选（无外部引用）也照样新建：原配置一字不动
  const lib = makeLib()
  const snap = JSON.stringify(lib.configs.slice(0, 2))
  const { forks } = runApply(lib, 'vsat', PLAN, ALL)
  ok('VSAT：全勾选也新建载波配置（不就地改）', forks.length === 2 && lib.configs.length === 4)
  ok('VSAT：原载波配置一字未动', JSON.stringify(lib.configs.slice(0, 2)) === snap)
  ok('VSAT：副本名 = 原名 + 后缀', forks[0].name === '前向TDM · VSAT平衡' && forks[1].name === '返向TDMA · VSAT平衡')
  ok('VSAT：链路行改指副本', lib.rows.every((r) => r.carrierId === forks[0].id || r.carrierId === forks[1].id))
  ok('VSAT：余量写进副本、方式置为设置余量',
    forks[0].form.margin === '4.500' && forks[0].form.calcMode === 'margin' && forks[1].form.margin === '1.250')
  ok('VSAT：副本带标记与出处', forks[0].form[ADV_MARK] === 'vsat' && forks[0].form[ADV_ORIGIN] === 'bb1')

  // 再配一轮（试错主路径）：应复用同一份副本、库里不再增条目
  const before = lib.configs.length
  const r2 = runApply(lib, 'vsat', [{ id: forks[0].id, toDb: 5.75 }, { id: forks[1].id, toDb: 0.5 }], ALL)
  ok('VSAT：再次配平复用同一份副本（不生冗余）', r2.forks.length === 0 && lib.configs.length === before)
  ok('VSAT：复用时余量被更新', lib.configs.find((c) => c.id === forks[0].id).form.margin === '5.750')
  ok('VSAT：复用时出处标记保持', lib.configs.find((c) => c.id === forks[0].id).form[ADV_ORIGIN] === 'bb1')
}
{ // 副本又被本表中未勾选的链路引用 → 再派生一份，名字按【根配置】重起、自动加序号
  const lib = makeLib()
  runApply(lib, 'vsat', PLAN, ALL)
  const rtn = lib.rows.find((r) => r.rowId === 'r2').carrierId
  const { forks } = runApply(lib, 'vsat', [{ id: rtn, toDb: 2.5 }], ['r2'])   // 只勾 r2，r3/r4 还引用着
  ok('VSAT：副本被未勾选链路引用 → 再派生', forks.length === 1)
  ok('VSAT：副本再派生不叠后缀、自动加序号', forks[0].name === '返向TDMA · VSAT平衡 2')
  ok('VSAT：副本再派生仍记根出处', forks[0].form[ADV_ORIGIN] === 'bb2')
  ok('VSAT：只有勾选行改指新副本',
    lib.rows.find((r) => r.rowId === 'r2').carrierId === forks[0].id
    && lib.rows.filter((r) => r.rowId === 'r3' || r.rowId === 'r4').every((r) => r.carrierId === rtn))
}
{ // 没解出值的载波不写回；CNC 就地改
  const lib = makeLib()
  const { ops } = runApply(lib, 'vsat', [{ id: 'bb1', toDb: NaN }, { id: 'bb2', toDb: 1 }], ALL)
  ok('无解的载波不产生写回', ops.length === 1 && ops[0].fromId === 'bb2')
  ok('无解的载波配置保持原样', lib.configs.find((c) => c.id === 'bb1').form.calcMode === 'balance')

  const cncLib = makeLib()
  cncLib.rows = [{ rowId: 'r1', carrierId: 'bb1' }, { rowId: 'r2', carrierId: 'bb1' }]
  const c1 = runApply(cncLib, 'cnc', [{ id: 'bb1', toDb: 2.5 }], ['r1', 'r2'])
  ok('CNC：无外部引用 → 就地改余量，不新建', c1.forks.length === 0 && cncLib.configs.length === 2)
  ok('CNC：就地改只动余量与计算方式（不留副本标记 / 不留基准锚）',
    cncLib.configs[0].form.margin === '2.500' && cncLib.configs[0].form.calcMode === 'margin'
    && cncLib.configs[0].form[ADV_MARK] === undefined && cncLib.configs[0].form[ADV_BASE] === undefined)

  const cnc2 = makeLib()
  cnc2.rows = [{ rowId: 'r1', carrierId: 'bb1' }, { rowId: 'r2', carrierId: 'bb1' }, { rowId: 'r3', carrierId: 'bb1' }]
  const c2 = runApply(cnc2, 'cnc', [{ id: 'bb1', toDb: 2.5 }], ['r1', 'r2'])
  ok('CNC：被未勾选链路引用 → 派生副本', c2.forks.length === 1 && c2.forks[0].name === '前向TDM · CNC平衡')
  ok('CNC：派生后未勾选的那条仍指原载波', cnc2.rows.find((r) => r.rowId === 'r3').carrierId === 'bb1')
}
ok('写回：缺参不炸', (() => { try { return planAdvWriteback({}).ops.length === 0 } catch (e) { return false } })())

// —— ⑦ 基准锚 advBaseMargin：什么时候还作数 ——
ok('基准锚：没记录 → 用此刻的余量', advBaseMargin({ calcMode: 'margin', margin: '5.000' }, 5) === 5)
ok('基准锚：记录还对得上 → 用原始基准',
  advBaseMargin({ calcMode: 'margin', margin: '4.500', [ADV_BASE]: 3, [ADV_OUT]: '4.500' }, 4.5) === 3)
ok('基准锚：余量被手改 → 原始基准作废',
  advBaseMargin({ calcMode: 'margin', margin: '5.000', [ADV_BASE]: 3, [ADV_OUT]: '4.500' }, 5) === 5)
ok('基准锚：换了计算方式 → 原始基准作废',
  advBaseMargin({ calcMode: 'balance', margin: '4.500', [ADV_BASE]: 3, [ADV_OUT]: '4.500' }, 2.2) === 2.2)
ok('基准锚：缺参不炸', advBaseMargin(null, 1.5) === 1.5)

// —— ⑧ 反复应用不漂（本文件头 ⑥ 那条不变式的整链验证）——
// 迷你宿主：载波库 + 链路表 + 真引擎，一轮＝算全表 → 解 → 照 ops 写回，与两个窗口的 applyAdvPlan 同款。
// 偏置按【根载波】给（副本换了 id 也跟得住，对应界面里的 carrierRemap）。
function makeAdvHost() {
  const configs = [
    { id: 'bb1', name: '前向TDM', form: { calcMode: 'margin', margin: '3' } },
    { id: 'bb2', name: '返向TDMA', form: { calcMode: 'margin', margin: '2' } }
  ]
  const rows = [
    { rowId: 'r1', carrierId: 'bb1', c: 'fwd', s: 'hub' },
    { rowId: 'r2', carrierId: 'bb2', c: 'rtn', s: 'vsatA' },
    { rowId: 'r3', carrierId: 'bb2', c: 'rtn', s: 'vsatB' },
    { rowId: 'r4', carrierId: 'bb2', c: 'rtn', s: 'vsatC' }
  ]
  let seq = 3
  const cfgOf = (id) => configs.find((x) => x.id === id)
  const rootOf = (id) => cfgOf(id).form[ADV_ORIGIN] || id
  const mOf = (r) => parseFloat(cfgOf(r.carrierId).form.margin)   // 配置即「设置余量」，行此刻跑的就是它
  function round(bias) {
    const picked = rows.map((r, i) => {
      const form = cfgOf(r.carrierId).form
      // 与窗口逐字同款：算一行 → marginDb 取引擎回填的 resolvedMargin（不是配置里那个字符串），
      // 基准 baseDb 由 advBaseMargin 从配置上认。回读精度一旦退化，这一段会当场变成不动点跑掉
      const e = runRow(r.c, r.s, form.margin)
      const m = e.resolved
      return {
        no: i + 1, rowId: r.rowId, carrierId: r.carrierId, carrierName: cfgOf(r.carrierId).name,
        bwKHz: e.bw, pbwKHz: e.pbw, marginDb: m, baseDb: advBaseMargin(form, m)
      }
    })
    const state = {}
    for (const r of rows) state[r.carrierId] = { bias: bias[rootOf(r.carrierId)] || 0 }
    const res = solveAdv({ mode: 'vsat', picked, state, base: 'current', overDb: 0 })
    if (!res.ok) throw new Error(res.message)
    // 照对话框 apply() 的原样投影转交（只有这四个字段）：写回若指望别的字段，这里就露馅
    const carriers = res.carriers.map((c) => ({ id: c.id, name: c.name, toDb: c.toDb, fromDb: c.fromDb }))
    const { ops } = planAdvWriteback({ mode: 'vsat', carriers, rowIds: rows.map((r) => r.rowId), rows, configs })
    for (const op of ops) {
      if (op.kind === 'fork') {
        const from = cfgOf(op.fromId)
        const copy = { id: 'bb' + (seq++), name: op.name, form: { ...JSON.parse(JSON.stringify(from.form)), ...op.formPatch } }
        configs.push(copy)
        for (const r of rows) if (op.rowIds.includes(r.rowId)) r.carrierId = copy.id
      } else Object.assign(cfgOf(op.carrierId).form, op.formPatch)
    }
    return res
  }
  // 落地后各行真正跑的余量，键＝根载波 id（跨副本可比）
  const settled = () => { const o = {}; for (const r of rows) o[rootOf(r.carrierId)] = mOf(r); return o }
  // 引擎实测的整组总账（配平后应当 Σ功率带宽 = Σ载波带宽）
  const totals = () => rows.reduce((a, r) => { const e = run(r.c, r.s, mOf(r)); return { p: a.p + e.pbw, b: a.b + e.bw } }, { p: 0, b: 0 })
  return { round, settled, totals, configs, rows }
}
{
  const BIAS = { bb1: 2 }        // 前向按设计超发 +2 dB，返向不动 —— 复现用户报的那一档
  const h = makeAdvHost()
  const r1 = h.round(BIAS); const s1 = h.settled()
  const r2 = h.round(BIAS); const s2 = h.settled()
  const r3 = h.round(BIAS); const s3 = h.settled()
  const same = (a, b) => Object.keys(a).every((k) => Math.abs(a[k] - b[k]) < 1e-9)
  ok('反复应用不漂：第 2 次应用余量原地不动', same(s1, s2), `${JSON.stringify(s1)} → ${JSON.stringify(s2)}`)
  ok('反复应用不漂：第 3 次仍原地', same(s2, s3))
  near('反复应用不漂：平移量 Δ 也不再动', r3.deltaDb, r1.deltaDb, 1e-6)
  ok('反复应用不漂：偏置确实生效（两份载波按 2 dB 错开）',
    Math.abs((s1.bb1 - s1.bb2) - (r1.carriers[0].baseDb - r1.carriers[1].baseDb) - 2) < 1e-9)
  const t = h.totals()
  near('反复应用不漂：每一轮仍然是平的（引擎实测 Σ功率带宽 = Σ载波带宽）', t.p, t.b, Math.max(0.01, t.b * 2e-5))
  ok('反复应用不漂：库里只多出两份副本（不逐轮生冗余）', h.configs.length === 4)

  // 改偏置就该一步到位：先 +2 再改成 +3，与一上来就 +3 解出来的必须是同一个数
  const hA = makeAdvHost(); hA.round({ bb1: 2 }); hA.round({ bb1: 3 })
  const hB = makeAdvHost(); hB.round({ bb1: 3 })
  ok('改偏置一步到位：+2 后改 +3 ≡ 直接 +3', same(hA.settled(), hB.settled()),
    `${JSON.stringify(hA.settled())} vs ${JSON.stringify(hB.settled())}`)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
