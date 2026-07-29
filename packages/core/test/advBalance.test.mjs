// 高级计算「多载波组功带平衡」（VSAT 组网 / CNC 载波叠加）测试。运行：npm test
//
// 关键不变式：
//   ① 标度律——引擎里 carrierTotalCT = 载波门限 + margin、功率占用 = 10^((carrierTotalCT −
//      转发器可用C/T)/10)，而载波带宽只由速率/调制/滚降定，于是【余量抬 x dB ⇔ 功率带宽恰好
//      ×10^(x/10)，载波带宽不动】。整个 advBalance 是闭式解而非二分搜索，全靠这一条；
//      **引擎哪天改了 margin 的进入方式，这条先红**，那时 advBalance 的前提就得重估。
//   ② 解出的余量喂回引擎，Σ功率带宽 = 目标（= 组占用带宽 × 10^(组超发量/10)）——
//      闭式预测与引擎实测须逐位一致，五种口径（严格平衡 / 组超发 / 锁定 / 偏置 / 平衡点基准）都要成立；
//   ③ 锁定＝维持现状余量，基准选「各自平衡点」时也不许跟着挪；
//   ④ CNC 带宽只算一份、功率相加；且必须恰好 2 条链路 + 同一份载波配置，否则拦下不给算；
//   ⑤ 不可解（全锁定 / 锁定载波已吃满目标）要明确报错，且仍把载波清单带回去——
//      界面上的锁定开关就长在那张表里，表一空用户没地方解锁。
//
// 被测的 advBalance 是渲染端 ESM，故本测试自身也是 .mjs；引擎是 CommonJS，用 createRequire 取。
import { createRequire } from 'node:module'
import { solveAdv, validateAdv } from '../../../src/shared/advBalance.js'

const require = createRequire(import.meta.url)
const { calculateLinkBudget } = require('../utils/linkCalculator.js')

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
  rtn: { infoRate: 512, modulation: 'QPSK', fec: '1/2', ebno: 3.5, bandwidthFactor: 1.35 }
}
const STATIONS = {
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
  ['返向锁定（小站功放已定，前向吸收）', { base: 'current', overDb: 0, state: { cRtn: { locked: true, bias: 0 } } }],
  ['前向偏置 +2 dB', { base: 'current', overDb: 0, state: { cFwd: { locked: false, bias: 2 } } }],
  ['各自平衡点为基准', { base: 'balance', overDb: 0, state: {} }],
  ['平衡点基准 + 返向锁定', { base: 'balance', overDb: 0, state: { cRtn: { locked: true, bias: 0 } } }]
]) {
  const res = solveAdv({ mode: 'vsat', picked: base, tpBwMHz: 36, ...opt })
  if (!res.ok) { ok(`VSAT ${tag}`, false, res.message); continue }
  const after = measure(SET, (x) => res.carriers.find((c) => c.id === x.carrierId).toDb)
  const sumP = after.reduce((s, a) => s + a.pbwKHz, 0)
  const sumB = after.reduce((s, a) => s + a.bwKHz, 0)
  const tol = Math.max(0.01, sumB * 2e-5)
  near(`VSAT ${tag}：Σ功率带宽 = 目标`, sumP, sumB * Math.pow(10, opt.overDb / 10), tol)
  near(`VSAT ${tag}：闭式预测 = 引擎实测`, sumP, res.afterPbwKHz, tol)
  for (const c of res.carriers.filter((x) => x.locked)) {
    near(`VSAT ${tag}：锁定载波维持现状余量`, c.toDb, base.find((b) => b.carrierId === c.id).marginDb, 1e-9)
  }
}
// 幂等：配平后再解一次，Δ 应为 0（两种基准都是不动点）
for (const b of ['current', 'balance']) {
  const r1 = solveAdv({ mode: 'vsat', picked: base, state: {}, base: b, overDb: 0 })
  const settled = measure(SET, (x) => r1.carriers.find((c) => c.id === x.carrierId).toDb)
  const r2 = solveAdv({ mode: 'vsat', picked: settled, state: {}, base: b, overDb: 0 })
  near(`VSAT 幂等（基准=${b}）：再解 Δ≈0`, r2.deltaDb, 0, 1e-4)
}

// —— ④ CNC：两条链路同一份载波，带宽只算一份、功率相加 ——
const CNC = [
  { no: 1, rowId: 'r1', name: 'Hub→远端', carrierId: 'cCnc', carrierName: 'CNC载波', c: 'fwd', s: 'hub', m0: 3 },
  { no: 2, rowId: 'r2', name: '远端→Hub', carrierId: 'cCnc', carrierName: 'CNC载波', c: 'fwd', s: 'vsatB', m0: 3 }
]
const cncBase = measure(CNC, (x) => x.m0)
const cnc = solveAdv({ mode: 'cnc', picked: cncBase, state: {}, base: 'current', overDb: 0, tpBwMHz: 36 })
if (!cnc.ok) ok('CNC 配平', false, cnc.message)
else {
  const after = measure(CNC, () => cnc.carriers[0].toDb)
  const sumP = after.reduce((s, a) => s + a.pbwKHz, 0)
  near('CNC：Σ功率带宽 = 单份载波带宽', sumP, after[0].bwKHz, Math.max(0.01, after[0].bwKHz * 2e-5))
  ok('CNC：组占用带宽只算一份', Math.abs(cnc.occBwKHz - cncBase[0].bwKHz) < 1e-9 && Math.abs(cnc.sumBwKHz - 2 * cncBase[0].bwKHz) < 1e-6)
}
// CNC 下 VSAT 那边留的锁定标记必须被忽略（唯一未知数不能被锁死）
ok('CNC：忽略锁定/偏置', solveAdv({ mode: 'cnc', picked: cncBase, state: { cCnc: { locked: true, bias: 5 } }, base: 'current', overDb: 0 }).ok)

// —— ⑤ 拦截与不可解 ——
ok('CNC 拦下 3 条链路', !!validateAdv('cnc', [...cncBase, { ...cncBase[0], no: 3, rowId: 'r3' }]))
ok('CNC 拦下载波不一致', !!validateAdv('cnc', [cncBase[0], { ...cncBase[1], carrierId: 'other', carrierName: '另一载波' }]))
ok('拦下空选择', !!validateAdv('vsat', []))
ok('拦下无结果的行', !!validateAdv('vsat', [{ no: 1, bwKHz: NaN, pbwKHz: NaN, marginDb: NaN, error: '卫星不可见' }]))
const lockAll = solveAdv({ mode: 'vsat', picked: base, state: { cFwd: { locked: true }, cRtn: { locked: true } }, base: 'current', overDb: 0 })
ok('全锁定 → 不可解', !lockAll.ok)
ok('全锁定 → 仍带回载波清单（界面上才有地方解锁）', lockAll.carriers.length === 2)
const hog = solveAdv({ mode: 'vsat', picked: measure(SET, (x) => (x.carrierId === 'cFwd' ? 25 : x.m0)), state: { cFwd: { locked: true } }, base: 'current', overDb: 0 })
ok('锁定载波已吃满目标 → 不可解', !hog.ok)
ok('锁定载波已吃满目标 → 仍带回载波清单', hog.carriers.length === 2)

// —— 兜底：脏输入不炸 ——
ok('缺参不炸', (() => { try { return solveAdv({}).ok === false } catch (e) { return false } })())
ok('负余量出警告', (() => {
  const r = solveAdv({ mode: 'vsat', picked: base, state: { cFwd: { locked: false, bias: 12 } }, base: 'current', overDb: 0 })
  return r.ok && r.warnings.some((w) => w.includes('负余量'))
})())

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
