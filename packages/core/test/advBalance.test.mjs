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
  solveAdv, validateAdv, planAdvWriteback, advBaseMargin,
  ADV_MARK, ADV_ORIGIN, ADV_BASE, ADV_OUT
} from '../../../src/shared/advBalance.js'

const require = createRequire(import.meta.url)
const { calculateLinkBudget } = require('../utils/linkCalculator.js')
const { computeLinkMode } = require('../utils/modeSolver.js')

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
// CNC 下 VSAT 那边留的偏置必须被忽略：唯一未知数由方程本身定死，偏置一进来 Σ功率带宽就不等于目标了
{
  const r = solveAdv({ mode: 'cnc', picked: cncBase, state: { cCnc: { bias: 5 } }, base: 'current', overDb: 0, tpBwMHz: 36 })
  ok('CNC：忽略偏置', cnc.ok && r.ok && Math.abs(r.carriers[0].toDb - cnc.carriers[0].toDb) < 1e-9)
}

// —— ⑤ 拦截与不可解 ——
ok('CNC 拦下 3 条链路', !!validateAdv('cnc', [...cncBase, { ...cncBase[0], no: 3, rowId: 'r3' }]))
ok('CNC 拦下载波不一致', !!validateAdv('cnc', [cncBase[0], { ...cncBase[1], carrierId: 'other', carrierName: '另一载波' }]))
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
