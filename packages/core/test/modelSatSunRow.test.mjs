// 链路预算「星侧太阳侵入」可选行（二期契约 D11）自测。运行：node packages/core/test/modelSatSunRow.test.mjs
//
// 口径：太阳落进卫星接收天线方向图 → 星上噪温升 ΔT → 等效 G/T 损失 L = 10·lg(1 + ΔT/T_sys)（值由用户填，
// 模型工作台「分析 › 星侧太阳侵入」给最坏值）。物理上是 T 升、G 与 SFD 不变，所以引擎只从 uplinkCT 与
// uplinkThermalCN 各减一次 L，绝不改 G_Ts（改 G_Ts 会让 SFDs = SFDref − G_Ts 跟着动、uplinkCT 正负抵消不变，
// UPPOWER / DOWNPOWER / PFD 全错口径）。出参 satSunGtLossResult 恒出（关闭 '0.00'）。
//   ① 未传 = 旧口径：GEO / NGSO / 再生上行 / 端到端——未传、显式「关」、「关」+任意值、「开」+0 / 空 / 负 / 乱码，
//      整份结果逐位同旧；GEO 缺省即 accuracy 基线 12.80 / 13.04
//   ② 开启：转发器参考口径 ΔC/T = ΔC/N₀ = −L 恰好（与功率无关）；「设置功放功率」下 ΔC/N（热噪声）= −L，
//      SFD / 卫星 G/T 逐位不变，PFD / EIRP / 功放瓦数在 FX=4 精度下不变（求解器 K 取自 toFixed 出参，FX=0 时量化 ±0.001）
//   ③ 出参随 FX 抬精度（2+FX 位）
//   ④ 瀑布三处（GEO / NGSO / 再生上行）：关闭不出行、开启出条件行（英文有译名）；级联「上行 C/N（热噪声）」
//      检查点 = 引擎 uplinkThermalCN，「上行干扰损失」= 热噪 − 实际（不双计）
//   ⑤ 端到端：复用 gtDeg 通道——上行跳热噪 C/N 恰减 L、台账多一行、下行跳 / 转发器工作点不动；节点覆盖生效
//   ⑥ 四窗 schema：uplink 组紧跟 G_Ts、缺省关；GSO / NGSO 进 SAT_COL_KEYS、再生进卫星列组、端到端 rx 组；
//      词表有名有单位且标签全局唯一；WF_DICT 有英文

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { createRequire } from 'node:module'
import { FIELD_GROUPS as GSO_GROUPS, buildParams as gsoBuildParams } from '../../../src/linkbudget/params.js'
import { FIELD_GROUPS as NGSO_GROUPS } from '../../../src/ngso/ngsoParams.js'
import { FIELD_GROUPS as REGEN_GROUPS } from '../../../src/regen/regenParams.js'
import { SAT_FIELDS as E2E_SAT_FIELDS, SAT_TXP_FIELDS, SAT_REGEN_FIELDS, buildChain, newEsNode, newSatNode, newHop, defaultCarrier } from '../../../src/e2e/e2eParams.js'
import { RESULT_LABELS, RESULT_LABEL_LIST } from '../../../src/shared/lbResultLabels.js'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..')
const geo = require('../utils/linkCalculator.js')
const ngso = require('../utils/linkCalculatorNGSO.js')
const regen = require('../utils/linkCalculatorRegen.js')
const modeSolver = require('../utils/modeSolver.js')
const { computeLinkChain } = require('../utils/linkChain.js')
const { buildWaterfallSegments, WF_DICT } = require('../utils/waterfallBuilder.js')

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)
const P = (v) => parseFloat(v)
// 两个 toFixed(2) 串之差，以 0.01 dB 为单位取整（L 取 0.01 的整数倍时，x 与 x − L 的舍入尾数相同 → 恰好整差）
const d100 = (a, b) => Math.round(P(b) * 100) - Math.round(P(a) * 100)
const L = 1.25                     // 二进制可精确表示：x − 1.25 无舍入，toFixed(2) 前后尾数一致
const ON = { satSunIntrusion: '开', satSunGtLoss: String(L) }
// 关闭的各种写法：都必须与「未传」逐位相同
const OFF_VARIANTS = [
  { satSunIntrusion: '关' },
  { satSunIntrusion: '关', satSunGtLoss: '5' },
  { satSunIntrusion: '', satSunGtLoss: '5' },
  { satSunIntrusion: '开', satSunGtLoss: '0' },
  { satSunIntrusion: '开', satSunGtLoss: '' },
  { satSunIntrusion: '开', satSunGtLoss: '-3' },
  { satSunIntrusion: '开', satSunGtLoss: 'abc' }
]
// 三引擎一起抬 FX，try/finally 精确复位（同 linkSweep._precise）
function precise(fn) {
  const setters = [geo, ngso, regen].map((m) => m.setOutputPrecisionBoost)
  const prev = setters.map((s) => s(4))
  try { return fn() } finally { setters.forEach((s, i) => s(prev[i])) }
}
const rowsOf = (segs) => segs.flatMap((s) => s.rows || [])

// ============ GEO ============
const GEO_SAT = { frequencyBand: 'Ku', satelliteName: 'D' }
const geoBase = geo.calculateLinkBudget(GEO_SAT, {}).data

t('GEO 未传 = 旧口径：accuracy 基线 12.80 / 13.04 不动，出参恒出 0.00', () => {
  assert.equal(geoBase.uplinkCN, '12.80'); assert.equal(geoBase.downlinkCN, '13.04')
  assert.equal(geoBase.satSunGtLossResult, '0.00')
})
t('GEO 关闭的七种写法与未传整份结果逐位相同', () => {
  for (const v of OFF_VARIANTS) assert.deepEqual(geo.calculateLinkBudget(GEO_SAT, v).data, geoBase, JSON.stringify(v))
})
t('GEO 开启（设置余量）：ΔC/T = ΔC/N₀ = −L 恰好，SFD / 卫星 G/T 逐位不变，出参 = L', () => {
  const on = geo.calculateLinkBudget(GEO_SAT, ON).data
  assert.equal(d100(geoBase.uplinkCTResult, on.uplinkCTResult), -125)
  assert.equal(d100(geoBase.uplinkCN0Result, on.uplinkCN0Result), -125)
  assert.equal(on.SFDsResult, geoBase.SFDsResult)
  assert.equal(on.satelliteGTResult, geoBase.satelliteGTResult)
  assert.equal(on.satSunGtLossResult, '1.25')
  // 设置余量＝反解功放：上行变差 → 功放加大（方向对即可，量由 ② 的定功率口径钉）
  assert.ok(P(on.paRecommendation) > P(geoBase.paRecommendation))
})
t('GEO 开启（设置功放功率，FX=4）：ΔC/N（热噪声）= −L，PFD / EIRP / 瓦数 / 下行不变', () => {
  precise(() => {
    const off = modeSolver.computeLinkMode(GEO_SAT, {}, { mode: 'power', powerW: 2 }).data
    const on = modeSolver.computeLinkMode(GEO_SAT, ON, { mode: 'power', powerW: 2 }).data
    const tol = 5e-6
    near(P(on.uplinkThermalCN) - P(off.uplinkThermalCN), -L, tol, 'ΔC/N 热噪声')
    near(P(on.uplinkCTResult) - P(off.uplinkCTResult), -L, tol, 'ΔC/T')
    near(P(on.uplinkCN0Result) - P(off.uplinkCN0Result), -L, tol, 'ΔC/N₀')
    for (const k of ['paRecommendation', 'selectedPowerWResult', 'stationEIRPResult', 'PFDcResult', 'arrivalPFDAtSatelliteResult', 'transponderOutputEIRP', 'downlinkThermalCN']) {
      near(P(on[k]), P(off[k]), tol, k)
    }
    assert.equal(on.SFDsResult, off.SFDsResult); assert.equal(on.satelliteGTResult, off.satelliteGTResult)
    assert.ok(P(on.uplinkCN) < P(off.uplinkCN) && P(off.uplinkCN) - P(on.uplinkCN) < L, '实际上行 C/(N+I) 降幅 < L（干扰并联稀释）')
  })
})
t('GEO 出参随 FX 抬精度（2+FX 位）', () => {
  precise(() => assert.equal(geo.calculateLinkBudget(GEO_SAT, ON).data.satSunGtLossResult, '1.250000'))
  assert.equal(geo.calculateLinkBudget(GEO_SAT, ON).data.satSunGtLossResult, '1.25')   // 复位后回到 2 位
})

// ============ NGSO ============
const NGSO_SAT = { frequencyBand: 'Ku' }
const NGSO_IN = {
  centerFrequency: '14.25', rxCenterFrequency: '12.5', uplinkPolarization: 'V',
  longitude: '113.26', latitude: '23.13', rxLongitude: '113.26', rxLatitude: '23.13',
  distanceMode: 'altitude', orbitAltitude: '8000', rxOrbitAltitude: '8000',
  uplinkAvailability: '99.9', rxDownlinkAvailability: '99.9', rainRate: '38', rxRainRate: '38', margin: '3'
}
const ngsoBase = ngso.calculateLinkBudget(NGSO_SAT, NGSO_IN).data

t('NGSO 未传 = 旧口径；关闭的七种写法逐位相同', () => {
  assert.equal(ngsoBase.satSunGtLossResult, '0.00')
  for (const v of OFF_VARIANTS) assert.deepEqual(ngso.calculateLinkBudget(NGSO_SAT, { ...NGSO_IN, ...v }).data, ngsoBase, JSON.stringify(v))
})
t('NGSO 开启：ΔC/T = ΔC/N₀ = −L 恰好；定功率（FX=4）下 ΔC/N 热噪声 = −L、PFD / 瓦数不变', () => {
  const on = ngso.calculateLinkBudget(NGSO_SAT, { ...NGSO_IN, ...ON }).data
  assert.equal(d100(ngsoBase.uplinkCTResult, on.uplinkCTResult), -125)
  assert.equal(d100(ngsoBase.uplinkCN0Result, on.uplinkCN0Result), -125)
  assert.equal(on.SFDsResult, ngsoBase.SFDsResult); assert.equal(on.satelliteGTResult, ngsoBase.satelliteGTResult)
  assert.equal(on.satSunGtLossResult, '1.25')
  precise(() => {
    const a = modeSolver.computeLinkModeNGSO(NGSO_SAT, NGSO_IN, { mode: 'power', powerW: 0.5 }).data
    const b = modeSolver.computeLinkModeNGSO(NGSO_SAT, { ...NGSO_IN, ...ON }, { mode: 'power', powerW: 0.5 }).data
    near(P(b.uplinkThermalCN) - P(a.uplinkThermalCN), -L, 5e-6, 'ΔC/N 热噪声')
    for (const k of ['paRecommendation', 'stationEIRPResult', 'PFDcResult', 'arrivalPFDAtSatelliteResult', 'downlinkThermalCN']) near(P(b[k]), P(a[k]), 5e-6, k)
    assert.equal(b.satSunGtLossResult, '1.250000')
  })
})

// ============ 再生式上行（借 NGSO 引擎：uplinkThermalCN 自动继承） ============
const INTF = {
  aciUplinkFactor: '30', adjUplinkFactor: '25', xpolUplinkFactor: '26', hpaIntermodFactor: '24',
  aciDownlinkFactor: '30', adjDownlinkFactor: '25', xpolDownlinkFactor: '26', xpdrIntermodFactor: '21'
}
const XPDR = { sfdRef: '-84', sfdGtRef: '0', transponderBandwidth: '36', BOi: '6', BOo: '3' }
const CARRIER = { infoRate: '2048', modulation: 'QPSK', fec: '3/4', ebno: '5.50', ber: '7', m: '1.00', bandwidthFactor: '1.20', rsCode: '188/204', noiseRatioMode: 'ebno' }
const RG_SAT = { ...XPDR, ...INTF, satelliteName: '再生星', frequencyBand: 'Ku' }
const RG_LINK = {
  ...CARRIER, margin: '3',
  centerFrequency: '14.25', uplinkPolarization: 'V', rxCenterFrequency: '12.5', downlinkPolarization: 'H',
  distanceMode: 'slantRange', slantRange: '39500', minElevation: '25',
  rxDistanceMode: 'slantRange', rxSlantRange: '39500', rxMinElevation: '25',
  earthStationLocation: '北京', longitude: '116.4074', latitude: '39.9042', altitude: '50', rainRate: '0', uplinkAvailability: '99.90',
  antennaDiameter: '9.0', antennaEfficiency: '65', feederLoss: '3.5', paBackoff: '0', uplinkPowerControl: '否', upcValue: '0',
  uplinkOtherLoss: '0.3', G_Ts: '10',
  rxEarthStationLocation: '北京', rxLongitude: '116.4074', rxLatitude: '39.9042', rxAltitude: '50', rxRainRate: '0', rxDownlinkAvailability: '99.90',
  rxAntennaDiameter: '3.7', rxAntennaEfficiency: '65', rxEIRP: '46', rxAntennaNoiseTemp: '35', rxReceiverNoiseTemp: '75', rxFeederLoss: '0.2', downlinkOtherLoss: '0.3'
}
const rgRun = (extra, opt) => regen.computeRegenUplinkMode(RG_SAT, { ...RG_LINK, ...extra }, opt || { mode: 'power', powerW: 0.2 })   // 0.2 W：热噪 ≈ 干扰量级，两者都起作用
const rgBase = rgRun({})

t('再生上行 未传 = 旧口径；关闭的七种写法逐位相同（定功率 / 设置余量两种求解）', () => {
  assert.equal(rgBase.success, true, rgBase.message)
  assert.equal(rgBase.data.satSunGtLossResult, '0.00')
  const mBase = rgRun({}, { mode: 'margin' })
  for (const v of OFF_VARIANTS) {
    assert.deepEqual(rgRun(v), rgBase, JSON.stringify(v))
    assert.deepEqual(rgRun(v, { mode: 'margin' }), mBase, 'margin ' + JSON.stringify(v))
  }
})
t('再生上行 开启（定功率，FX=4）：ΔC/N 热噪声 = −L，功放 / EIRP 不变、卫星 G/T / SFD 逐位不变，上行 C/(N+I) 与余量同步变差', () => {
  const on = rgRun(ON)
  assert.equal(on.success, true, on.message)
  assert.equal(on.data.satSunGtLossResult, '1.25')
  assert.ok(P(on.data.uplinkCN) < P(rgBase.data.uplinkCN) && P(on.data.linkmargin) < P(rgBase.data.linkmargin))
  // 定功率求解的 K 取自 toFixed 出参（FX=0 时功放 ±0.01 W 量级的量化，与本行无关），故抬 FX 再比
  precise(() => {
    const a = rgRun({}).data, b = rgRun(ON).data
    near(P(b.uplinkThermalCN) - P(a.uplinkThermalCN), -L, 5e-6, 'ΔC/N 热噪声')
    for (const k of ['paRecommendation', 'stationEIRPResult', 'arrivalPFDAtSatelliteResult']) near(P(b[k]), P(a[k]), 5e-6, k)
    for (const k of ['satelliteGTResult', 'SFDsResult']) assert.equal(b[k], a[k], k)
  })
})

// ============ 瀑布：三处条件行 ============
function cascadeCheck(results, orbitType) {
  const segs = buildWaterfallSegments({ results, lang: 'zh', orbitType })
  const rows = rowsOf(segs)
  const sun = rows.filter((r) => r.id === 'satSunGtLossResult')
  const thermal = rows.find((r) => r.key === 'up·上行 C/N（热噪声）')
  const intf = rows.find((r) => r.key === 'up·上行干扰损失 ACI/ASI/XPI/IM')
  return { segs, sun, thermal, intf }
}
t('瀑布 GEO / NGSO / 再生：关闭不出行、开启出一行（loss、值 = L），热噪检查点 = 引擎 uplinkThermalCN，干扰损失不双计', () => {
  const cases = [
    ['GEO', geoBase, geo.calculateLinkBudget(GEO_SAT, ON).data],
    ['NGSO', ngsoBase, ngso.calculateLinkBudget(NGSO_SAT, { ...NGSO_IN, ...ON }).data],
    ['REGEN', rgBase.data, rgRun(ON).data]
  ]
  for (const [orbit, off, on] of cases) {
    const a = cascadeCheck(off, orbit)
    assert.equal(a.sun.length, 0, orbit + ' 关闭不出行')
    const b = cascadeCheck(on, orbit)
    assert.equal(b.sun.length, 1, orbit + ' 开启出一行')
    assert.equal(b.sun[0].kind, 'loss'); assert.equal(b.sun[0].num, L)
    for (const [res, c] of [[off, a], [on, b]]) {
      assert.ok(c.thermal && c.intf, orbit + ' 级联行在')
      near(c.thermal.num, P(res.uplinkThermalCN), 0.011, orbit + ' 热噪检查点 = 引擎')
      near(c.intf.num, P(res.uplinkThermalCN) - P(res.uplinkCN), 0.011, orbit + ' 干扰损失 = 热噪 − 实际（不双计 L）')
    }
  }
})
t('瀑布英文：条件行有译名（WF_DICT）', () => {
  assert.equal(WF_DICT['星侧太阳侵入 G/T 劣化'], 'Satellite-Side Sun Intrusion G/T Degradation')
  const segs = buildWaterfallSegments({ results: geo.calculateLinkBudget(GEO_SAT, ON).data, lang: 'en', orbitType: 'GEO' })
  const row = rowsOf(segs).find((r) => r.id === 'satSunGtLossResult')
  assert.equal(row.label, 'Satellite-Side Sun Intrusion G/T Degradation')
})

// ============ 端到端：复用 gtDeg 通道 ============
const TX_ES = {
  kind: 'es', name: '北京关口站', longitude: '116.4074', latitude: '39.9042', altitude: '50', rainRate: '0', availability: '99.90',
  antennaDiameter: '9.0', antennaEfficiency: '65', feederLoss: '3.5', paBackoff: '0', uplinkPowerControl: '否', upcValue: '0', powerW: '120',
  rxAntennaEfficiency: '65', rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: '35', rxReceiverNoiseTemp: '75', rxFeederLoss: '0.2'
}
const RX_ES = { ...TX_ES, name: '三亚站', longitude: '109.5', latitude: '18.25', altitude: '10', antennaDiameter: '4.5', powerW: '20', rxAntennaEfficiency: '68' }
const TXP = { kind: 'txp', name: '透明星', gt: '2', eirpSat: '46', ...XPDR, ...INTF }
const RGN = { kind: 'regen', name: '再生星', gt: '10', eirp: '25', procDelayMs: '0', ...INTF }
const UP_HOP = { frequency: '14.25', polarization: 'V', slantRange: '39500', elevation: '25', miscLoss: '0.3' }
const DN_HOP = { frequency: '12.50', polarization: 'H', slantRange: '38800', elevation: '32', miscLoss: '0.3' }
const chainOf = (sat) => ({ nodes: [TX_ES, sat, RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER })
const thermalOf = (d, seg) => (d.ledger.find((x) => x.seg === seg && x.label === '本跳 C/N（热噪声）') || {}).value

for (const [tag, sat] of [['透明星', TXP], ['再生星', RGN]]) {
  const base = computeLinkChain(chainOf(sat))
  t(`端到端（${tag}）未传 = 旧口径：关闭的七种写法整份结果（含台账）逐位相同`, () => {
    assert.equal(base.success, true, base.message)
    assert.equal(base.data.hops[0].gtDegResult, '0.00')
    for (const v of OFF_VARIANTS) assert.deepEqual(computeLinkChain(chainOf({ ...sat, ...v })), base, JSON.stringify(v))
  })
  t(`端到端（${tag}）开启：上行跳热噪 C/N 恰减 L、台账多一行、卫星 G/T 读数与下行跳不动`, () => {
    const on = computeLinkChain(chainOf({ ...sat, ...ON }))
    assert.equal(on.success, true, on.message)
    const upSeg = on.data.ledger.find((x) => x.label === '星侧太阳侵入 G/T 劣化')
    assert.ok(upSeg && upSeg.kind === 'loss' && upSeg.value === L, '台账行')
    near(thermalOf(on.data, upSeg.seg) - thermalOf(base.data, upSeg.seg), -L, 1e-9, '上行跳热噪 ΔC/N')
    const h0 = on.data.hops[0], b0 = base.data.hops[0]
    assert.equal(h0.gtResult, b0.gtResult, '卫星 G/T 读数不变')
    assert.equal(h0.gtDegResult, '1.25')
    assert.equal(d100(b0.thermalCNResult, h0.thermalCNResult), -125)
    assert.equal(h0.arrivalPFDResult, b0.arrivalPFDResult, '到达通量密度不变（转发器工作点不动）')
    assert.equal(on.data.hops[1].thermalCNResult, base.data.hops[1].thermalCNResult, '下行跳不动')
    assert.equal(on.data.ledger.length, base.data.ledger.length + 1)
  })
}

t('端到端描述子：SAT_FIELDS 两项进 rx 组（透明 / 再生检查器都出），库值 → 节点、节点覆盖优先、全角归一', () => {
  const keys = (fs) => fs.map((f) => f.key)
  for (const fs_ of [SAT_TXP_FIELDS, SAT_REGEN_FIELDS]) {
    const k = keys(fs_), i = k.indexOf('gt')
    assert.deepEqual(k.slice(i, i + 3), ['gt', 'satSunIntrusion', 'satSunGtLoss'])
  }
  const f = E2E_SAT_FIELDS.find((x) => x.key === 'satSunIntrusion')
  assert.deepEqual(f.options, ['关', '开']); assert.equal(f.def, '关')
  const ES = { id: 'es1', name: '站', form: { antennaDiameter: '9', antennaEfficiency: '65', opPowerW: '120', feederLoss: '3.5', paBackoff: '0', uplinkPowerControl: '否', upcValue: '0', rxAntennaEfficiency: '65', rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: '35', rxReceiverNoiseTemp: '75', rxFeederLoss: '0.2' } }
  const SAT = { id: 'sat1', name: '星', form: { satelliteName: '星', frequencyBand: 'Ku', gt: '2', eirpSat: '46', eirp: '28', sfdRef: '-84', sfdGtRef: '0', BOi: '6', BOo: '3', transponderBandwidth: '36', satSunIntrusion: '开', satSunGtLoss: '1.25' } }
  const mkRow = (ov) => {
    const a = newEsNode('发'), s = newSatNode('regen', '再生星'), b = newEsNode('收')
    if (ov) s.ov = ov
    const h1 = newHop('rf'), h2 = newHop('rf')
    h1.slantRange = '39500'; h1.elevation = '25'; h2.slantRange = '38800'; h2.elevation = '32'
    a.carrier = { ...defaultCarrier(), infoRate: '2048', modulation: 'QPSK', fec: '3/4' }
    return { _id: 'c1', name: '', nodes: [a, s, b], hops: [h1, h2] }
  }
  const RES = { es: () => ES, sat: () => SAT }
  const c1 = buildChain(mkRow(null), RES)
  assert.equal(c1.nodes[1].satSunIntrusion, '开'); assert.equal(c1.nodes[1].satSunGtLoss, '1.25')
  const c2 = buildChain(mkRow({ satSunGtLoss: '２．５' }), RES)
  assert.equal(c2.nodes[1].satSunGtLoss, '2.5', '节点覆盖 + 全角归一')
  const r = computeLinkChain(c2)
  assert.equal(r.success, true, r.message)
  assert.equal(r.data.hops[0].gtDegResult, '2.50')
})

// ============ 四窗 schema / 列组 / 词表 ============
const fieldsOf = (groups, key) => (groups.find((g) => g.key === key) || {}).fields || []
t('GSO / NGSO / 再生：uplink 组紧跟 G_Ts、缺省关、ΔG/T 数值 dB、target link、口径进 tip', () => {
  for (const [tag, groups] of [['GSO', GSO_GROUPS], ['NGSO', NGSO_GROUPS], ['再生', REGEN_GROUPS]]) {
    const fs_ = fieldsOf(groups, 'uplink'), k = fs_.map((f) => f.key), i = k.indexOf('G_Ts')
    assert.ok(i >= 0, tag)
    assert.deepEqual(k.slice(i, i + 3), ['G_Ts', 'satSunIntrusion', 'satSunGtLoss'], tag)
    const sw = fs_[i + 1], ls = fs_[i + 2]
    assert.equal(sw.type, 'select'); assert.deepEqual(sw.options, ['关', '开']); assert.equal(sw.def, '关'); assert.equal(sw.target, 'link')
    assert.equal(ls.type, 'num'); assert.equal(ls.unit, 'dB'); assert.equal(ls.def, '0'); assert.equal(ls.target, 'link')
    assert.ok(sw.tip && ls.tip && /10·lg\(1 \+ ΔT\/T_sys\)/.test(ls.tip), tag + ' 口径在 tip')
    // 别的组里不许再有同名字段（一处定义）
    const all = groups.flatMap((g) => g.fields.map((f) => f.key))
    assert.equal(all.filter((x) => x === 'satSunIntrusion').length, 1, tag)
  }
})
t('GSO buildParams：两项进 linkParams，全角数字归一', () => {
  const tx = { satSunIntrusion: '开', satSunGtLoss: '１．２５', G_Ts: '2' }
  const { linkParams, satParams } = gsoBuildParams({}, {}, tx, {}, null, null)
  assert.equal(linkParams.satSunIntrusion, '开'); assert.equal(linkParams.satSunGtLoss, '1.25')
  assert.equal(satParams.satSunGtLoss, undefined)
})
t('列组：GSO / NGSO 进 SAT_COL_KEYS 紧跟 G_Ts，再生进「卫星」列组', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
  for (const p of ['src/linkbudget/LinkBudgetApp.vue', 'src/ngso/NgsoLinkBudgetApp.vue']) {
    const m = /const SAT_COL_KEYS = \[([^\]]*)\]/.exec(read(p))
    assert.ok(m, p)
    const keys = m[1].split(',').map((s) => s.trim().replace(/'/g, ''))
    const i = keys.indexOf('G_Ts')
    assert.deepEqual(keys.slice(i, i + 3), ['G_Ts', 'satSunIntrusion', 'satSunGtLoss'], p)
  }
  const rg = read('src/regen/RegenLinkBudgetApp.vue')
  assert.ok(/satSunIntrusion: 'sat', satSunGtLoss: 'sat'/.test(rg), '再生 _STN_GROUP')
})
// 开关 tip 只许承诺恒成立的：卫星 G/T 与 SFD 不变；到达通量密度是否不变取决于计算方式——
// 「设置余量」由功放抬升补足余量（PFD / 功放 / 下行随之升高），其余方式（定功率 / 功带平衡 / 超发 /
// 再生「设置工作点」）功放与 PFD 不变（功带平衡点只看转发器工作点，与上行 C/T 无关；残差 = 二分容差）。
t('计算方式口径与开关 tip 一致（FX=4）：设置余量抬功放与 PFD，功带平衡 / 超发不动，再生设置余量 ΔPFD = +L', () => {
  precise(() => {
    const cases = [
      ['GEO', (ex, o) => modeSolver.computeLinkMode(GEO_SAT, ex, o).data, {}],
      ['NGSO', (ex, o) => modeSolver.computeLinkModeNGSO(NGSO_SAT, { ...NGSO_IN, ...ex }, o).data, {}]
    ]
    for (const [tag, run] of cases) {
      const m0 = run({}, { mode: 'margin', margin: 3 }), m1 = run(ON, { mode: 'margin', margin: 3 })
      assert.ok(P(m1.arrivalPFDAtSatelliteResult) - P(m0.arrivalPFDAtSatelliteResult) > 0.2, tag + ' 设置余量：PFD 抬升')
      assert.ok(P(m1.paRecommendation) > P(m0.paRecommendation), tag + ' 设置余量：功放抬升')
      assert.equal(m1.SFDsResult, m0.SFDsResult, tag); assert.equal(m1.satelliteGTResult, m0.satelliteGTResult, tag)
      for (const o of [{ mode: 'balance' }, { mode: 'overbalance', overDb: 1 }]) {
        const a = run({}, o), b = run(ON, o)
        near(P(b.arrivalPFDAtSatelliteResult), P(a.arrivalPFDAtSatelliteResult), 0.01, `${tag} ${o.mode} PFD`)
        near(P(b.paRecommendation) / P(a.paRecommendation), 1, 0.003, `${tag} ${o.mode} 功放`)
        near(P(b.uplinkThermalCN) - P(a.uplinkThermalCN), -L, 0.01, `${tag} ${o.mode} ΔC/N 热噪声`)
      }
    }
    const a = rgRun({}, { mode: 'margin' }).data, b = rgRun(ON, { mode: 'margin' }).data
    near(P(b.arrivalPFDAtSatelliteResult) - P(a.arrivalPFDAtSatelliteResult), L, 0.01, '再生设置余量 ΔPFD')
    near(P(b.linkmargin), P(a.linkmargin), 0.01, '再生设置余量 余量守住')
    for (const k of ['satelliteGTResult', 'SFDsResult']) assert.equal(b[k], a[k], k)
  })
  // tip 文案：不再无条件承诺「到达通量密度不变」，且引用的计算方式名与窗口里的一致
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
  for (const [tag, groups, app, rest] of [
    ['GSO', GSO_GROUPS, 'src/linkbudget/LinkBudgetApp.vue', '其余计算方式'],
    ['NGSO', NGSO_GROUPS, 'src/ngso/NgsoLinkBudgetApp.vue', '其余计算方式'],
    ['再生', REGEN_GROUPS, 'src/regen/RegenLinkBudgetApp.vue', '「设置工作点」']
  ]) {
    const tip = fieldsOf(groups, 'uplink').find((f) => f.key === 'satSunIntrusion').tip
    assert.ok(!/到达通量密度不变）/.test(tip), tag + ' 不再无条件承诺 PFD 不变')
    assert.ok(tip.includes('「设置余量」') && tip.includes('功放抬升') && tip.includes(rest), tag + ' 按计算方式分述')
    const src = read(app)
    for (const lab of (tag === '再生' ? ['设置余量', '设置工作点'] : ['设置余量'])) assert.ok(src.includes(`label: '${lab}'`), `${tag} 计算方式名「${lab}」存在`)
  }
})
t('端到端节点覆盖：空值 = 跟随库条目、显式「关」可压过库里的「开」；检查器下拉有空值项可回到跟随', () => {
  const SAT = { id: 's', name: '星', form: { satelliteName: '星', frequencyBand: 'Ku', gt: '2', satSunIntrusion: '开', satSunGtLoss: '1.25' } }
  const mk = (ov) => { const s = newSatNode('txp', '星'); s.ov = ov; return { _id: 'c', nodes: [newEsNode('发'), s, newEsNode('收')], hops: [newHop('rf'), newHop('rf')] } }
  const RES = { es: () => ({ form: {} }), sat: () => SAT }
  assert.equal(buildChain(mk({ satSunIntrusion: '' }), RES).nodes[1].satSunIntrusion, '开', "'' 跟随库")
  assert.equal(buildChain(mk({}), RES).nodes[1].satSunIntrusion, '开', '未设跟随库')
  assert.equal(buildChain(mk({ satSunIntrusion: '关' }), RES).nodes[1].satSunIntrusion, '关', '显式关压过库')
  // E2eFields 覆盖模式的下拉：须有空值项（显示库值）并以 '' 写回——否则选过一次就回不到「跟随库」
  const sfc = fs.readFileSync(path.join(ROOT, 'src/e2e/E2eFields.vue'), 'utf8')
  const ovSel = /<select v-else-if="f\.type === 'select'"[^>]*>([\s\S]*?)<\/select>/.exec(sfc)
  assert.ok(ovSel, '覆盖模式单独一支 select')
  assert.ok(/<option value=""[^>]*>\{\{ ph\(f\) \|\| f\.def \}\}<\/option>/.test(ovSel[1]), '空值项显示库值（库空则缺省）')
  assert.ok(/@change="form\[f\.key\] = \$event\.target\.value"/.test(ovSel[0]), '选空值项写回 \'\'')
})
t('出参词表：satSunGtLossResult 有名有单位，标签全局唯一，不与雨致 G/T 劣化撞名', () => {
  const it = RESULT_LABELS.satSunGtLossResult
  assert.ok(it && it.unit === 'dB' && it.label)
  assert.equal(RESULT_LABEL_LIST.filter((x) => x.label === it.label).length, 1)
  assert.notEqual(it.label, RESULT_LABELS.gOverTdegradationResult.label)
  for (const d of [geoBase, ngsoBase, rgBase.data]) assert.ok('satSunGtLossResult' in d, '三体制恒出')
})

console.log(`modelSatSunRow: ${n} 项通过`)
