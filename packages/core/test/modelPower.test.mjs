// 太阳翼功率（packages/core/models/power.mjs）：单板功率对手算、单轴对日、参数化模型取板、时间序列与日均、地影。
//
// 手算基准：S₀ = 1361 W/m²；W = S₀·(1 AU/R)²·A·η·cos⁺θ·e。
//   ① 10 m²、η 30 %、正入射、1 AU、全日照 → 4083 W；60° → 2041.5 W；背面 → 0；R = 0.9833 AU → ×1/0.9833²；半影 e = 0.5 → 减半。
//   ② GEO 天底姿态、±Y 翼绕 Y 单轴对日：cos = cos β（β = 太阳相对轨道面仰角）→ 分点 ≈ 满额、至点 ≈ cos 23.44° = 0.9175。
//   ③ 固定朝天顶（−Z）的板、β = 0：cos = cos μ（μ 自轨道正午）→ 日均 = 满额 / π。
//   ④ 立方星体装四面（±X、±Y）：太阳在 X–Y 面内方位 φ → Σ = A_face·(|cos φ| + |sin φ|)。

import assert from 'node:assert/strict'
import {
  SOLAR_CONSTANT_W_M2, DEFAULT_EFFICIENCY_PCT, panelPower, panelsFromMeta, trackedNormal, arrayPowerAt, arrayPowerSeries, sunGeometrySeries
} from '../models/power.mjs'
import { eclipseFactor, sunEcefApprox, sunDistanceAu, AU_KM, attitudeBasisEcef, losToBody } from '../models/attitude.mjs'
import { buildTemplateModel } from '../models/paramBus.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)
const D2R = Math.PI / 180
const R_GEO = 42164.17

t('常量：S₀ = 1361 W/m²、缺省效率 28 %', () => {
  assert.equal(SOLAR_CONSTANT_W_M2, 1361); assert.equal(DEFAULT_EFFICIENCY_PCT, 28)
})

t('panelPower 对手算：正入射 4083 W、60° 半值、背面 0、1/R²、半影减半、相对值', () => {
  const base = { normalBody: [0, 0, 1], areaM2: 10, efficiencyPct: 30 }
  const p0 = panelPower({ ...base, sunBody: [0, 0, 1] })
  near(p0.W, 4083, 1e-9, '正入射'); near(p0.rel, 1, 0, 'rel'); near(p0.cosInc, 1, 0, 'cos')
  const p60 = panelPower({ ...base, sunBody: [Math.sin(60 * D2R), 0, Math.cos(60 * D2R)] })
  near(p60.W, 2041.5, 1e-9, '60°'); near(p60.rel, 0.5, 1e-15, 'rel 60°')
  const pb = panelPower({ ...base, sunBody: [0, 0, -1] })
  assert.equal(pb.W, 0); assert.equal(pb.rel, 0); near(pb.cosInc, -1, 0, '背面 cos')
  near(panelPower({ ...base, sunBody: [0, 0, 5], auDist: 0.9833 }).W, 4083 / 0.9833 ** 2, 1e-9, '近日点（未归一太阳矢量也行）')
  const pe = panelPower({ ...base, sunBody: [0, 0, 1], eclipse: 0.5 })
  near(pe.W, 2041.5, 1e-9, '半影'); near(pe.rel, 0.5, 0, 'rel 半影')
  near(panelPower({ normalBody: [0, 0, 2], areaM2: 1, sunBody: [0, 0, 1] }).W, 1361 * 0.28, 1e-12, '缺省效率 28 %')
})

t('trackedNormal：绕 +Y 单轴对日，法向转到太阳在 X–Z 面内的投影；限位夹住；太阳 ∥ 轴保持初值', () => {
  const p = { normalBody: [0, 0, -1], areaM2: 1, efficiencyPct: 30, articulation: { name: 'w', axisBody: [0, 1, 0], minDeg: -180, maxDeg: 180, initialDeg: 0 } }
  const out = [0, 0, 0]
  const s = [Math.cos(30 * D2R) * Math.cos(40 * D2R), Math.sin(30 * D2R), Math.cos(30 * D2R) * Math.sin(40 * D2R)]
  trackedNormal(p, s, out)
  near(out[0] * s[0] + out[1] * s[1] + out[2] * s[2], Math.cos(30 * D2R), 1e-14, 'cos = cos β')
  near(out[1], 0, 1e-15, '法向保持 ⟂ 转轴')
  const pl = { ...p, articulation: { ...p.articulation, minDeg: -10, maxDeg: 10 } }
  const ang = trackedNormal(pl, [1, 0, 0], out)                      // 太阳在 +X：最优需转 −90° → 夹到 −10°
  near(ang, -10, 1e-12, '夹到下限')
  assert.equal(trackedNormal(p, [0, 1, 0], out), 0, '太阳 ∥ 轴 → 初值')
  assert.equal(trackedNormal({ normalBody: [1, 0, 0] }, [0, 1, 0], out), 0, '无关节')
  assert.deepEqual(out, [1, 0, 0])
})

t('trackedNormal：最优角落在不对称限位外（±360 也进不去）→ 夹到【圆周角差】更近的端点；功率对拍端点处的余弦', () => {
  // 审查实测：转轴 +Y、电池法向 −Z、限位 [−175, −90]，太阳让最优角 = 150°：
  //   圆周角差 |150 − (−175)| ≡ 35°、|150 − (−90)| ≡ 120° → 夹到 −175（cos 0.819）；按线性差会选 −90（cos −0.5，功率 0）
  const p = { normalBody: [0, 0, -1], areaM2: 1, efficiencyPct: 30, articulation: { name: 'w', axisBody: [0, 1, 0], minDeg: -175, maxDeg: -90, initialDeg: -120 } }
  const nAt = (deg) => [-Math.sin(deg * D2R), 0, -Math.cos(deg * D2R)]      // 法向 −Z 绕 +Y 转 deg
  const s = nAt(150)
  const out = [0, 0, 0]
  const ang = trackedNormal(p, s, out)
  near(ang, -175, 0, '夹到 −175')
  const c = out[0] * s[0] + out[1] * s[1] + out[2] * s[2]
  near(c, Math.cos(35 * D2R), 1e-12, 'cos = cos 35°')
  const r = arrayPowerAt([p], s)
  near(r.rel, Math.cos(35 * D2R), 1e-12, 'rel ≈ 0.819（改前 0）')
  // 镜像：最优角 −60° → 圆周差 115° / 30° → 夹到 −90
  const ang2 = trackedNormal(p, nAt(-60), out)
  near(ang2, -90, 0, '夹到 −90')
  // 逐度扫一圈最优角：夹出来的端点永远是两端里功率大的那个
  for (let opt = -180; opt < 180; opt += 1) {
    const so = nAt(opt), a = trackedNormal(p, so, out)
    const cosOf = (deg) => { const n = nAt(deg); return n[0] * so[0] + n[2] * so[2] }
    if (opt >= -175 && opt <= -90) { near(a, opt, 1e-9, `限位内 ${opt}`); continue }
    assert.ok(cosOf(a) >= Math.max(cosOf(-175), cosOf(-90)) - 1e-12, `opt ${opt}：选了 ${a}`)
  }
  console.log(`  不对称限位 [−175, −90]、最优 150°：夹到 ${ang}°，rel ${r.rel.toFixed(3)}`)
})

t('panelsFromMeta（参数化默认卫星）：两翼各一块、效率取组、转轴取 wing_±Y_axis 挂点、限位 ±180', () => {
  const r = buildTemplateModel('default-sat')
  const { panels, warnings } = panelsFromMeta(r)
  assert.equal(warnings.length, 0, warnings.join('；'))
  assert.equal(panels.length, 2)
  for (const p of panels) {
    assert.ok(p.articulation && p.articulation.axisBody, `${p.name} 带关节`)
    near(Math.abs(p.articulation.axisBody[1]), 1, 1e-12, '转轴 ±Y')
    assert.equal(p.efficiencyPct, 28)
    assert.ok(p.areaM2 > 20)
  }
  // 分点正午附近：太阳 ⟂ Y → 对日后全额
  const at = arrayPowerAt(panels, [0.3, 0, -0.95], 1, 1)
  near(at.rel, 1, 1e-12, '对日满额')
  near(at.W, at.nominalW, 1e-9, 'W = 满额')
  near(at.nominalW, 1361 * 0.28 * panels.reduce((a, p) => a + p.areaM2, 0), 1e-9, '满额 = S₀ΣAη')
  // 至点：β = 23.44° → cos β
  const b = 23.44 * D2R
  near(arrayPowerAt(panels, [0, Math.sin(b), -Math.cos(b)], 1, 1).rel, Math.cos(b), 1e-12, '至点 cos β')
})

t('panelsFromMeta（参数化立方星）：体装电池片按 _±X/_±Y 拆四面；太阳方位 φ → |cos φ| + |sin φ|', () => {
  const r = buildTemplateModel('cubesat-3u')
  const { panels } = panelsFromMeta(r)
  assert.equal(panels.length, 4)
  const Af = panels[0].areaM2
  for (const p of panels) near(p.areaM2, Af, 1e-15, '均分')
  for (const phi of [0, 17, 45, 120, 250]) {
    const s = [Math.cos(phi * D2R), Math.sin(phi * D2R), 0]
    const w = arrayPowerAt(panels, s, 1, 1).W
    near(w, 1361 * 0.28 * Af * (Math.abs(Math.cos(phi * D2R)) + Math.abs(Math.sin(phi * D2R))), 1e-9, `φ=${phi}`)
  }
})

t('panelsFromMeta：没有法向 / 没有转轴的记 warnings；axisFor 回调；缺省效率', () => {
  const meta = {
    parts: [{ id: 'a', name: '翼 A', role: 'solarArray', nodes: ['n1'], areaM2: 5, normalBody: [0, 0, -1] }, { id: 'b', name: '翼 B', role: 'solarArray', nodes: ['n2'], areaM2: 5 }],
    solarPanelGroups: [], articulations: [{ name: 'SA', nodes: ['n1'], stages: [{ name: 'r', type: 'zRotate', minimumValue: -90, maximumValue: 90, initialValue: 0 }] }]
  }
  const r1 = panelsFromMeta(meta)
  assert.equal(r1.panels.length, 1); assert.equal(r1.warnings.length, 2)
  assert.equal(r1.panels[0].articulation, null); assert.equal(r1.panels[0].efficiencyPct, 28)
  const r2 = panelsFromMeta(meta, { axisFor: () => [0, 1, 0], defaultEfficiencyPct: 30 })
  assert.deepEqual(r2.panels[0].articulation.axisBody, [0, 1, 0]); assert.equal(r2.panels[0].articulation.minDeg, -90); assert.equal(r2.panels[0].efficiencyPct, 30)
})

t('arrayPowerSeries：固定天顶板、β = 0 的一天 → 日均 = 满额/π（梯形积分，报误差）；最小 0；关节角序列', () => {
  const N = 1441, tMs = new Float64Array(N), sb = new Float64Array(3 * N)
  const t0 = Date.UTC(2026, 2, 21)
  for (let i = 0; i < N; i++) {
    tMs[i] = t0 + i * 60000
    const mu = (i / 1440) * 2 * Math.PI                                     // 一天一圈（GEO）
    sb.set([-Math.sin(mu), 0, -Math.cos(mu)], 3 * i)                         // β = 0 的 nadir 本体太阳矢量
  }
  const panels = [{ name: '天顶板', group: 'Z', normalBody: [0, 0, -1], areaM2: 2, efficiencyPct: 30, articulation: null },
    { name: '翼', group: 'W', normalBody: [0, 0, -1], areaM2: 10, efficiencyPct: 30, articulation: { name: 'SADA', axisBody: [0, 1, 0], minDeg: -180, maxDeg: 180, initialDeg: 0 } }]
  const r = arrayPowerSeries({ panels, tMs, sunBody: sb })
  const gz = r.groups.find((g) => g.name === 'Z'), gw = r.groups.find((g) => g.name === 'W')
  const fullZ = 1361 * 2 * 0.3, fullW = 1361 * 10 * 0.3
  near(gz.meanW, fullZ / Math.PI, fullZ * 2e-5, '天顶板日均 = 满额/π')
  near(gz.minW, 0, 0, '最小 0'); near(gz.maxW, fullZ, 1e-9, '正午满额')
  near(gw.meanW, fullW, 1e-9, '对日翼恒满额'); near(gw.rel[700], 1, 1e-12, '翼 rel')
  near(r.meanW, gz.meanW + gw.meanW, 1e-9, '总 = Σ组')
  near(r.nominalW, fullZ + fullW, 1e-9)
  assert.equal(r.daily.length, 1); near(r.daily[0].coverage, 1, 1e-12, '整日覆盖'); near(r.daily[0].meanW, r.meanW, 1e-9, '日均')
  assert.ok(r.angles.SADA && Math.abs(r.angles.SADA[360]) > 80, '关节角在转')
  console.log(`  固定天顶板日均 ${gz.meanW.toFixed(3)} W / 理论 ${(fullZ / Math.PI).toFixed(3)} W（差 ${((gz.meanW / (fullZ / Math.PI) - 1) * 100).toFixed(4)}%）`)
})

t('arrayPowerSeries：地影 / 半影时长、日切（跨两个 UTC 日，覆盖率）、步长不均匀的梯形均值', () => {
  const tMs = [0, 3600e3, 7200e3, 86400e3 + 3600e3, 86400e3 + 5400e3]
  const sb = [[0, 0, -1], [0, 0, -1], [0, 0, -1], [0, 0, -1], [0, 0, -1]]
  const ecl = [1, 0.5, 0, 1, 1]
  const r = arrayPowerSeries({ panels: [{ name: 'p', normalBody: [0, 0, -1], areaM2: 1, efficiencyPct: 100 }], tMs, sunBody: sb, eclipse: ecl })
  near(r.W[1], 1361 * 0.5, 1e-9, '半影')
  near(r.penumbraSec, 3600, 1e-9, '半影时长（中点权重）'); near(r.eclipseSec, (86400 + 3600 - 3600) / 2, 1e-9, '本影时长')
  assert.equal(r.daily.length, 2)
  near(r.daily[0].coverage, 1, 1e-12); near(r.daily[1].coverage, 5400 / 86400, 1e-12)
  // 梯形：[0,1h] 均 0.75·S、[1h,2h] 0.25·S、[2h,25h] 0.5·S、[25h,25.5h] 1·S → 总 = S·(0.75+0.25+11.5+0.5)h / 25.5h
  near(r.meanW, 1361 * (0.75 + 0.25 + 11.5 + 0.5) / 25.5, 1e-9, '梯形均值')
})

t('sunGeometrySeries（GEO 105.5°E，Meeus 太阳）：分点前后地影 ≈ 70 min、至点无地影；两翼对日的日均 = 满额 × 受照比例 / R²', () => {
  const r = buildTemplateModel('default-sat')
  const { panels } = panelsFromMeta(r)
  const lon = 105.5 * D2R, rE = [R_GEO * Math.cos(lon), R_GEO * Math.sin(lon), 0]
  const rows = []
  for (const [label, day] of [['春分', Date.UTC(2026, 2, 20)], ['夏至', Date.UTC(2026, 5, 21)]]) {
    const N = 1441, tMs = new Float64Array(N), rr = new Float64Array(3 * N)
    for (let i = 0; i < N; i++) { tMs[i] = day + i * 60000; rr.set(rE, 3 * i) }
    const g = sunGeometrySeries({ tMs, rEcef: rr, law: 'nadir' })
    // 地影因子与 eclipseFactor 逐点同值（D13 唯一实现）
    for (const i of [0, 300, 900, 1440]) {
      const s = sunEcefApprox(tMs[i])
      near(g.eclipse[i], eclipseFactor(rE, s, { sunDistKm: sunDistanceAu(tMs[i]) * AU_KM }), 0, 'eclipse 同源')
    }
    const pw = arrayPowerSeries({ panels, tMs, sunBody: g.sunBody, eclipse: g.eclipse, auDist: g.auDist })
    const shadowMin = (pw.eclipseSec + pw.penumbraSec) / 60
    let lit = 0
    for (let i = 1; i < N; i++) lit += (g.eclipse[i] + g.eclipse[i - 1]) / 2 * 60
    const litFrac = lit / 86400
    // 对日两翼：cos = |投影| = cos β_body；β_body 为太阳与本体 Y 的余角
    let expect = 0
    for (let i = 1; i < N; i++) {
      const f = (k) => { const sy = g.sunBody[3 * k + 1]; return Math.sqrt(Math.max(0, 1 - sy * sy)) * g.eclipse[k] / g.auDist[k] ** 2 }
      expect += (f(i) + f(i - 1)) / 2 * 60
    }
    expect = expect / 86400 * pw.nominalW
    near(pw.meanW, expect, pw.nominalW * 1e-9, `${label} 日均 = 手算积分`)
    if (label === '春分') { assert.ok(shadowMin > 60 && shadowMin < 80, `春分地影 ${shadowMin} min`) }
    else { assert.equal(shadowMin, 0, '夏至无地影'); near(pw.minRel, Math.cos(23.43 * D2R), 0.002, '夏至 rel = cos β') }
    rows.push(`${label}：地影 + 半影 ${shadowMin.toFixed(0)} min、受照 ${(litFrac * 100).toFixed(2)}%、日均 ${pw.meanW.toFixed(0)} W / 满额 ${pw.nominalW.toFixed(0)} W、最小 ${pw.minW.toFixed(0)} W`)
  }
  console.log('  ' + rows.join('；'))
})

t('sunGeometrySeries（LEO 700 km、β 大）：天底 + 对日翼 → cos β；yawSteer + 对日翼 → 满额（翼轴 ⟂ 太阳）', () => {
  const a = 6371 + 700, v = Math.sqrt(398600.4418 / a)
  const N = 200, tMs = new Float64Array(N), rr = new Float64Array(3 * N), vv = new Float64Array(3 * N), ss = new Float64Array(3 * N)
  const beta = 60 * D2R, sun = [Math.cos(beta), 0, Math.sin(beta)]      // 轨道面 = XY（赤道），太阳抬高 60°
  for (let i = 0; i < N; i++) {
    const u = i * 1.8 * D2R
    tMs[i] = i * 30000
    rr.set([a * Math.cos(u), a * Math.sin(u), 0], 3 * i); vv.set([-v * Math.sin(u), v * Math.cos(u), 0], 3 * i); ss.set(sun, 3 * i)
  }
  const panels = [{ name: '+Y', group: 'W', normalBody: [0, 0, -1], areaM2: 5, efficiencyPct: 30, articulation: { name: 'S', axisBody: [0, 1, 0], minDeg: -180, maxDeg: 180, initialDeg: 0 } }]
  const gN = sunGeometrySeries({ tMs, rEcef: rr, vInertialEcef: vv, sunEcef: ss, law: 'nadir', gmstRad: new Float64Array(N) })
  const gY = sunGeometrySeries({ tMs, rEcef: rr, vInertialEcef: vv, sunEcef: ss, law: 'yawSteer', gmstRad: new Float64Array(N) })
  const pN = arrayPowerSeries({ panels, tMs, sunBody: gN.sunBody, eclipse: 1 })
  const pY = arrayPowerSeries({ panels, tMs, sunBody: gY.sunBody, eclipse: 1 })
  near(pN.meanRel, Math.cos(beta), 1e-12, '天底：cos β')
  near(pY.minRel, 1, 1e-12, 'yawSteer：满额')
  // 与逐点 attitude + losToBody 同值
  const b = attitudeBasisEcef('yawSteer', {}, { rEcef: rr.subarray(30, 33), vInertialEcef: vv.subarray(30, 33), sunEcef: sun })
  const sb = losToBody(sun, b)
  for (let k = 0; k < 3; k++) near(gY.sunBody[30 + k], sb[k], 1e-15, 'sunBody 同源')
})

console.log(`modelPower: ${n} 项通过`)
