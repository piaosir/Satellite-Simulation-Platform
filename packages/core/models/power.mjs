// 太阳翼功率（任务书 §6.7；DESIGN2 §1）：单块板的瞬时功率、整星阵列的时间序列（含单轴对日 articulation）、日均。
// 纯 ESM、无 three；太阳矢量与姿态由调用方给（本体系），也可以交给 sunGeometrySeries 从轨道样本现算。
//
// ── 口径 ──
//   绝对功率  W = S₀·(1 AU / R)²·A·η·cos⁺θ·e
//     S₀ = 1361 W/m²：IAU 2015 Resolution B3 的名义太阳常数（total solar irradiance 名义值）；
//         SORCE/TIM 实测太阳活动低年 1360.8 ± 0.5 W/m²（Kopp & Lean 2011, GRL 38, L01706），两者差 0.015 %。
//     R  日地距离（AU），年变 ±1.7 % → 功率年变 ±3.4 %（近日点 1 月初最大）
//     A  电池面积（m²，部件的 areaM2），η 效率（%，AGI solarPanelGroups 的百分数口径，/100）
//     cos⁺θ = max(0, n̂·ŝ)：只有电池面受照（背面不发电）；e = eclipseFactor（D13 唯一实现：圆锥 + 半影，0..1）
//   相对功率  rel = Σ Aᵢηᵢ·cos⁺θᵢ·e / Σ Aᵢηᵢ——纯几何 + 地影（不含 1/R²、不含效率绝对值），满额 1 = 全部电池面正对太阳且全日照
//   单轴对日  带 articulation 的板：法向（pointingVector，缺省 = 电池法向）绕转轴转到离太阳最近（attitude.articulationSunAngle），
//            再夹到关节限位；此时 cos = 太阳在「垂直于转轴的平面」上的投影夹角，不是固定法向的余弦。
//   不计：温度系数、老化、遮挡（本体遮挡另见掩模）、串并联失配、电源调节效率——结果是「阵列输出端的理想功率」。
//
// 导出：SOLAR_CONSTANT_W_M2 / DEFAULT_EFFICIENCY_PCT / panelPower / panelsFromMeta / trackedNormal / arrayPowerAt /
//       arrayPowerSeries / sunGeometrySeries

import { articulationSunAngle, rotateAboutAxis, attitudeBasisEcef, losToBody, eclipseFactor, sunEcefApprox, sunDistanceAu, makeBasis, AU_KM } from './attitude.mjs'

export const SOLAR_CONSTANT_W_M2 = 1361
export const DEFAULT_EFFICIENCY_PCT = 28

const gx = (v) => (v.x !== undefined ? v.x : v[0]), gy = (v) => (v.y !== undefined ? v.y : v[1]), gz = (v) => (v.z !== undefined ? v.z : v[2])
const isVec = (v) => v != null && (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length === 3 && [0, 1, 2].every((k) => Number.isFinite(v[k])) && Math.hypot(v[0], v[1], v[2]) > 1e-12
const nrm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l] }
// |(x,y,z)|：常规量级走 sqrt，越出 (1e-290, 1e290) 才退回 Math.hypot（V8 的 Math.hypot 每次调用都分配暂存数组，逐拍逐板的热路径避开）
const norm3 = (x, y, z) => { const s = x * x + y * y + z * z; return s > 1e-290 && s < 1e290 ? Math.sqrt(s) : Math.hypot(x, y, z) }
// 圆周角差折到 (−180, 180]
const wrap180 = (x) => { const v = ((x % 360) + 540) % 360 - 180; return v === -180 ? 180 : v }

/**
 * 单块板瞬时功率。
 * @param {{sunBody:number[], normalBody:number[], areaM2:number, efficiencyPct?:number, eclipse?:number, auDist?:number}} o
 * @returns {{W:number, rel:number, cosInc:number}}  cosInc 是带符号的 n̂·ŝ（< 0 = 背面受照）
 */
export function panelPower(o) {
  const s = o.sunBody, n = o.normalBody
  const sl = Math.hypot(gx(s), gy(s), gz(s)), nl = Math.hypot(gx(n), gy(n), gz(n))
  const cosInc = sl > 0 && nl > 0 ? (gx(s) * gx(n) + gy(s) * gy(n) + gz(s) * gz(n)) / (sl * nl) : 0
  const e = Number.isFinite(o.eclipse) ? Math.max(0, Math.min(1, o.eclipse)) : 1
  const rel = Math.max(0, cosInc) * e
  const au = Number.isFinite(o.auDist) && o.auDist > 0 ? o.auDist : 1
  const eta = (Number.isFinite(o.efficiencyPct) ? o.efficiencyPct : DEFAULT_EFFICIENCY_PCT) / 100
  const A = Number.isFinite(o.areaM2) && o.areaM2 > 0 ? o.areaM2 : 0
  return { W: SOLAR_CONSTANT_W_M2 / (au * au) * A * eta * rel, rel, cosInc }
}

const AXIS_SUFFIX = /_([+-])([XYZ])$/
const AXIS_VEC = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }

/**
 * 从 ModelMeta 取太阳翼板：parts 里 role = 'solarArray' 的部件（normalBody、areaM2），效率按所属 solarPanelGroup
 * （部件的 solarGroup 名 → 组；或部件节点与组节点有交集），articulation 按「关节节点 ∩ 部件节点」认。
 *   · 部件没有 normalBody、而节点名都带 _±X/_±Y/_±Z 后缀（参数化立方星的体装电池片）→ 按节点拆成各面一块，面积均分。
 *   · 关节转轴：attach point「<关节名>_axis」的 dirBody（参数化模型的 SADA 轴）；否则 opts.axisFor(articulation) → 本体轴；
 *     都没有 → 该板按固定法向算（warnings 里记一条）。pointingVector 缺省 = 电池法向（opts.pointingFor 可覆盖）。
 *   · 关节限位取第一个旋转 stage 的 min/max（度），缺省 ±180。
 * @param {object} meta
 * @param {{defaultEfficiencyPct?:number, axisFor?:(art)=>number[]|null, pointingFor?:(art, part)=>number[]|null}} [opts]
 * @returns {{panels:object[], warnings:string[]}}
 */
export function panelsFromMeta(meta, opts = {}) {
  const warnings = [], panels = []
  const m = meta && typeof meta === 'object' ? meta : {}
  const parts = Array.isArray(m.parts) ? m.parts.filter((p) => p && p.role === 'solarArray') : []
  const groups = Array.isArray(m.solarPanelGroups) ? m.solarPanelGroups : []
  const arts = Array.isArray(m.articulations) ? m.articulations : []
  const aps = Array.isArray(m.attachPoints) ? m.attachPoints : []
  const defEta = Number.isFinite(opts.defaultEfficiencyPct) ? opts.defaultEfficiencyPct : DEFAULT_EFFICIENCY_PCT
  const overlaps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.some((x) => b.includes(x))
  for (const p of parts) {
    const nodes = Array.isArray(p.nodes) ? p.nodes : []
    const g = groups.find((x) => x && (x.name === p.solarGroup || overlaps(x.nodes, nodes))) || null
    const eta = g && Number.isFinite(g.efficiency) ? g.efficiency : defEta
    const art = arts.find((a) => a && overlaps(a.nodes, nodes)) || null
    let articulation = null
    if (art) {
      const ap = aps.find((a) => a && a.name === `${art.name}_axis` && isVec(a.dirBody))
      const axis = ap ? nrm3(ap.dirBody) : (typeof opts.axisFor === 'function' ? opts.axisFor(art) : null)
      if (isVec(axis)) {
        const st = (art.stages || []).find((s) => s && /Rotate$/.test(s.type)) || {}
        const pv = typeof opts.pointingFor === 'function' ? opts.pointingFor(art, p) : null
        articulation = {
          name: art.name, axisBody: nrm3(axis), pointingBody: isVec(pv) ? nrm3(pv) : null,
          minDeg: Number.isFinite(st.minimumValue) ? st.minimumValue : -180,
          maxDeg: Number.isFinite(st.maximumValue) ? st.maximumValue : 180,
          initialDeg: Number.isFinite(st.initialValue) ? st.initialValue : 0, track: true
        }
      } else warnings.push(`${p.name || p.id}：关节「${art.name}」没有转轴，按固定法向算`)
    }
    const base = { group: g ? g.name : (p.solarGroup || p.name || p.id), efficiencyPct: eta, articulation }
    if (isVec(p.normalBody)) {
      panels.push({ name: p.name || p.id, ...base, normalBody: nrm3(p.normalBody), areaM2: p.areaM2 > 0 ? p.areaM2 : 0 })
    } else if (nodes.length && nodes.every((x) => AXIS_SUFFIX.test(x))) {
      for (const x of nodes) {
        const [, sg, ax] = x.match(AXIS_SUFFIX)
        panels.push({ name: x, ...base, normalBody: AXIS_VEC[ax].map((v) => (sg === '-' ? -v : v)), areaM2: (p.areaM2 > 0 ? p.areaM2 : 0) / nodes.length })
      }
    } else warnings.push(`${p.name || p.id}：没有法向，未计入`)
  }
  return { panels, warnings }
}

/**
 * 板在当前太阳下的实际法向（本体系，写进 out），返回关节转角（度；无关节 / 不跟踪返回初值或 0）。
 * 跟踪时先求最优角（articulationSunAngle），再夹到 [minDeg, maxDeg]；pointingBody 缺省 = 电池法向。
 * 太阳恰在转轴上（转到哪都一样）时保持初值。
 */
export function trackedNormal(panel, sunBody, out = [0, 0, 0]) {
  const a = panel.articulation
  if (!a || !a.axisBody) { out[0] = panel.normalBody[0]; out[1] = panel.normalBody[1]; out[2] = panel.normalBody[2]; return 0 }
  let ang = Number.isFinite(a.initialDeg) ? a.initialDeg : 0
  if (a.track !== false) {
    const pv = a.pointingBody || panel.normalBody
    const s0 = gx(sunBody), s1 = gy(sunBody), s2 = gz(sunBody)
    const k = s0 * a.axisBody[0] + s1 * a.axisBody[1] + s2 * a.axisBody[2]
    const perp = norm3(s0 - k * a.axisBody[0], s1 - k * a.axisBody[1], s2 - k * a.axisBody[2])
    if (perp > 1e-12) ang = articulationSunAngle(pv, a.axisBody, sunBody)
    const lo = Number.isFinite(a.minDeg) ? a.minDeg : -180, hi = Number.isFinite(a.maxDeg) ? a.maxDeg : 180
    if (ang < lo || ang > hi) {
      // 夹到限位：±360 里找落在限位内的等价角；没有就取【圆周角差】更近的那一端——单轴对日时入射余弦 ∝ cos(实际角 − 最优角)，
      // 圆周上离最优角近的端点功率大（按线性差 |ang − lo| 选，限位不对称时会夹到离太阳更远的一端）
      if (ang - 360 >= lo && ang - 360 <= hi) ang -= 360
      else if (ang + 360 >= lo && ang + 360 <= hi) ang += 360
      else ang = Math.abs(wrap180(ang - lo)) <= Math.abs(wrap180(ang - hi)) ? lo : hi
    }
  }
  rotateAboutAxis(panel.normalBody, a.axisBody, ang, out)
  return ang
}

const _n = [0, 0, 0]
/**
 * 整星阵列瞬时功率（零分配：给 out 就复用）。
 * @returns {{W:number, rel:number, nominalW:number}}  nominalW = Σ S₀·Aᵢ·ηᵢ（1 AU 正入射满额）
 */
export function arrayPowerAt(panels, sunBody, eclipse = 1, auDist = 1, out) {
  const o = out || { W: 0, rel: 0, nominalW: 0 }
  const sl = norm3(gx(sunBody), gy(sunBody), gz(sunBody))
  const e = Number.isFinite(eclipse) ? Math.max(0, Math.min(1, eclipse)) : 1
  const au = Number.isFinite(auDist) && auDist > 0 ? auDist : 1
  let num = 0, den = 0
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i]
    const w = (p.areaM2 > 0 ? p.areaM2 : 0) * (Number.isFinite(p.efficiencyPct) ? p.efficiencyPct : DEFAULT_EFFICIENCY_PCT) / 100
    den += w
    if (!(sl > 0) || !(e > 0) || !(w > 0)) continue
    trackedNormal(p, sunBody, _n)
    const c = (_n[0] * gx(sunBody) + _n[1] * gy(sunBody) + _n[2] * gz(sunBody)) / (sl * norm3(_n[0], _n[1], _n[2]))
    if (c > 0) num += w * c
  }
  o.nominalW = SOLAR_CONSTANT_W_M2 * den
  o.rel = den > 0 ? num * e / den : 0
  o.W = SOLAR_CONSTANT_W_M2 / (au * au) * num * e
  return o
}

const at3 = (arr, i, out) => {
  if (ArrayBuffer.isView(arr)) { out[0] = arr[3 * i]; out[1] = arr[3 * i + 1]; out[2] = arr[3 * i + 2] }
  else { const v = arr[i]; out[0] = gx(v); out[1] = gy(v); out[2] = gz(v) }
  return out
}
const atN = (v, i, def) => (v == null ? def : (typeof v === 'number' ? v : (Number.isFinite(v[i]) ? v[i] : def)))

/**
 * 功率时间序列。
 * @param {{panels:object[], tMs:number[]|Float64Array, sunBody:Float64Array|number[][], eclipse?:number|ArrayLike<number>, auDist?:number|ArrayLike<number>}} o
 * @returns {{
 *   W:Float64Array, rel:Float64Array, groups:{name, W:Float64Array, rel:Float64Array, meanW, minW, maxW}[],
 *   angles:Object<string, Float64Array>, nominalW, meanW, minW, maxW, meanRel, minRel,
 *   eclipseSec, penumbraSec, sunlitFrac, spanSec, daily:{dayStartMs, meanW, minW, maxW, coverage}[]
 * }}
 *   meanW / meanRel 按梯形积分对时间加权（步长不均匀也对）；daily 按 UTC 日切，coverage = 该日被样本覆盖的比例。
 */
export function arrayPowerSeries(o) {
  const panels = Array.isArray(o.panels) ? o.panels : []
  const t = o.tMs, N = t.length
  const W = new Float64Array(N), rel = new Float64Array(N)
  const gNames = [...new Set(panels.map((p) => p.group || p.name))]
  const gIdx = panels.map((p) => gNames.indexOf(p.group || p.name))
  const gW = gNames.map(() => new Float64Array(N)), gDen = gNames.map(() => 0)
  panels.forEach((p, k) => { gDen[gIdx[k]] += (p.areaM2 > 0 ? p.areaM2 : 0) * (Number.isFinite(p.efficiencyPct) ? p.efficiencyPct : DEFAULT_EFFICIENCY_PCT) / 100 })
  const artNames = [...new Set(panels.filter((p) => p.articulation && p.articulation.axisBody).map((p) => p.articulation.name))]
  const angles = Object.fromEntries(artNames.map((nm) => [nm, new Float64Array(N)]))
  const s = [0, 0, 0], nn = [0, 0, 0]
  const pw = panels.map((p) => (p.areaM2 > 0 ? p.areaM2 : 0) * (Number.isFinite(p.efficiencyPct) ? p.efficiencyPct : DEFAULT_EFFICIENCY_PCT) / 100)
  const pArt = panels.map((p) => (p.articulation && angles[p.articulation.name]) || null)
  let den = 0
  for (let k = 0; k < pw.length; k++) den += pw[k]
  const nominal = SOLAR_CONSTANT_W_M2 * den
  let eclipseSec = 0, penumbraSec = 0
  for (let i = 0; i < N; i++) {
    at3(o.sunBody, i, s)
    const e = Math.max(0, Math.min(1, atN(o.eclipse, i, 1))), au = atN(o.auDist, i, 1)
    const sl = norm3(s[0], s[1], s[2]), k0 = SOLAR_CONSTANT_W_M2 / (au * au) * e
    let num = 0
    for (let k = 0; k < panels.length; k++) {                   // 与 arrayPowerAt 同式；逐板再记组功率与关节角
      const ang = trackedNormal(panels[k], s, nn)
      if (pArt[k]) pArt[k][i] = ang
      if (!(sl > 0) || !(pw[k] > 0)) continue
      const c = (nn[0] * s[0] + nn[1] * s[1] + nn[2] * s[2]) / (sl * norm3(nn[0], nn[1], nn[2]))
      if (c > 0) { num += pw[k] * c; gW[gIdx[k]][i] += k0 * pw[k] * c }
    }
    W[i] = k0 * num
    rel[i] = den > 0 && sl > 0 ? num * e / den : 0
    const w = N === 1 ? 0 : ((i + 1 < N ? t[i + 1] : t[i]) - (i > 0 ? t[i - 1] : t[i])) / 2000
    if (e <= 0) eclipseSec += w
    else if (e < 1) penumbraSec += w
  }
  const span = N > 1 ? (t[N - 1] - t[0]) / 1000 : 0
  const trapMean = (y) => {
    if (N === 1) return y[0]
    let acc = 0
    for (let i = 1; i < N; i++) acc += (y[i] + y[i - 1]) / 2 * (t[i] - t[i - 1])
    return span > 0 ? acc / (span * 1000) : y[0]
  }
  const minOf = (y) => { let v = Infinity; for (let i = 0; i < N; i++) if (y[i] < v) v = y[i]; return N ? v : null }
  const maxOf = (y) => { let v = -Infinity; for (let i = 0; i < N; i++) if (y[i] > v) v = y[i]; return N ? v : null }
  const groups = gNames.map((name, k) => {
    const rg = new Float64Array(N)
    const nomW = SOLAR_CONSTANT_W_M2 * gDen[k]
    for (let i = 0; i < N; i++) rg[i] = nomW > 0 ? gW[k][i] * (atN(o.auDist, i, 1) ** 2) / nomW : 0
    return { name, W: gW[k], rel: rg, meanW: N ? trapMean(gW[k]) : null, minW: minOf(gW[k]), maxW: maxOf(gW[k]) }
  })
  // 按 UTC 日切的日均（梯形积分落在当日的部分 / 当日被覆盖的时长）
  const daily = []
  if (N > 1) {
    const DAY = 86400000
    const acc = new Map()
    for (let i = 1; i < N; i++) {
      let a = t[i - 1], b = t[i]
      if (!(b > a)) continue
      const wa = W[i - 1], wb = W[i]
      while (a < b) {
        const d0 = Math.floor(a / DAY) * DAY, cut = Math.min(b, d0 + DAY)
        const fa = (a - t[i - 1]) / (t[i] - t[i - 1]), fb = (cut - t[i - 1]) / (t[i] - t[i - 1])
        const ya = wa + (wb - wa) * fa, yb = wa + (wb - wa) * fb
        const r = acc.get(d0) || { e: 0, dur: 0, min: Infinity, max: -Infinity }
        r.e += (ya + yb) / 2 * (cut - a); r.dur += cut - a
        r.min = Math.min(r.min, ya, yb); r.max = Math.max(r.max, ya, yb)
        acc.set(d0, r)
        a = cut
      }
    }
    for (const [d0, r] of [...acc.entries()].sort((x, y) => x[0] - y[0])) daily.push({ dayStartMs: d0, meanW: r.dur > 0 ? r.e / r.dur : null, minW: r.min, maxW: r.max, coverage: r.dur / DAY })
  }
  return {
    W, rel, groups, angles, nominalW: nominal,
    meanW: N ? trapMean(W) : null, minW: minOf(W), maxW: maxOf(W),
    meanRel: N ? trapMean(rel) : null, minRel: minOf(rel),
    eclipseSec, penumbraSec, sunlitFrac: span > 0 ? 1 - (eclipseSec + penumbraSec) / span : (N ? (atN(o.eclipse, 0, 1) >= 1 ? 1 : 0) : null),
    spanSec: span, daily
  }
}

/**
 * 从轨道样本现算「本体系太阳矢量 + 地影因子 + 日地距离」，直接喂 arrayPowerSeries。
 * @param {{tMs:ArrayLike<number>, rEcef:Float64Array|number[][], vInertialEcef?:Float64Array|number[][],
 *          sunEcef?:Float64Array|number[][]|((tMs:number, out:number[])=>number[]), gmstRad?:ArrayLike<number>,
 *          law?:string, params?:object, targetEcef?:Float64Array|number[][]}} o
 *   sunEcef 缺省用 attitude.sunEcefApprox（Meeus 低精度，与 3D 页晨昏线同源）；日地距离用 sunDistanceAu。
 * @returns {{sunBody:Float64Array, eclipse:Float64Array, auDist:Float64Array, yawDeg:Float64Array, fallback:Uint8Array}}
 */
export function sunGeometrySeries(o) {
  const t = o.tMs, N = t.length
  const sunBody = new Float64Array(3 * N), eclipse = new Float64Array(N), auDist = new Float64Array(N), yawDeg = new Float64Array(N), fallback = new Uint8Array(N)
  const r = [0, 0, 0], v = [0, 0, 0], s = [0, 0, 0], tg = [0, 0, 0], sb = [0, 0, 0]
  const basis = makeBasis(), eo = { sunDistKm: 0 }               // eclipseFactor 的 opts 逐拍复用
  const ctx = { rEcef: r, vInertialEcef: null, sunEcef: s, targetEcef: null, gmstRad: NaN, tMs: 0, prevYawDeg: undefined }
  let prevYaw
  for (let i = 0; i < N; i++) {
    at3(o.rEcef, i, r)
    ctx.vInertialEcef = o.vInertialEcef ? at3(o.vInertialEcef, i, v) : null
    if (typeof o.sunEcef === 'function') o.sunEcef(t[i], s)
    else if (o.sunEcef) at3(o.sunEcef, i, s)
    else sunEcefApprox(t[i], s, o.gmstRad ? o.gmstRad[i] : undefined)
    ctx.targetEcef = o.targetEcef ? at3(o.targetEcef, i, tg) : null
    ctx.gmstRad = o.gmstRad ? o.gmstRad[i] : NaN
    ctx.tMs = t[i]; ctx.prevYawDeg = prevYaw
    const au = sunDistanceAu(t[i])
    auDist[i] = au
    const b = attitudeBasisEcef(o.law || 'nadir', o.params, ctx, basis)
    if (!b) { sunBody[3 * i] = NaN; sunBody[3 * i + 1] = NaN; sunBody[3 * i + 2] = NaN; eclipse[i] = NaN; yawDeg[i] = NaN; fallback[i] = 1; continue }
    losToBody(s, b, sb)
    sunBody[3 * i] = sb[0]; sunBody[3 * i + 1] = sb[1]; sunBody[3 * i + 2] = sb[2]
    eo.sunDistKm = au * AU_KM
    eclipse[i] = eclipseFactor(r, s, eo)
    yawDeg[i] = b.yawDeg; fallback[i] = b.fallback ? 1 : 0
    if (Number.isFinite(b.yawDeg)) prevYaw = b.yawDeg
  }
  return { sunBody, eclipse, auDist, yawDeg, fallback }
}
