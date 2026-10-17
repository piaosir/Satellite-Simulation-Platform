// GSO 倾斜运行 / 保持盒：地球站日内视向、指向损耗、仰角 / 斜距 / 时延 / 多普勒范围（纯 CommonJS，零依赖）。
//
// 【为什么】GSO 链路引擎按「卫星钉在标称轨位」算几何（linkCalculator 的球面公式）。倾斜运行星（中星 9 号 i = 0.97°、
// 中星 2A 1.76°）与保持盒（±0.05°）里的星每天画一个「8」字：固定指向的地球站对着日平均方向，视线最大偏离
// 1.1°（i = 1°，北京看 110.5°E），1.2 m Ku 天线日最大损失 6.5–7.5 dB，2.4 m 以上直接出主瓣（差距分析 A-01）。
//
// 【卫星轨迹】两种来源：
//   · 合成（缺省）：同步半长轴 a = (μ/ω⊕²)^(1/3)、给定倾角 i / 偏心率 e / 近地点幅角 ω 的二体轨道，一个恒星日一圈、
//     日平均经度 = 标称轨位 + 东西偏置 δλ（ω⊕ 为恒星转速，地固系里没有长期漂移）。ω 缺省 0：e 引起的东西摆与
//     i 引起的南北摆同相，日内最大偏离取到最大（保守）。保持盒 ±Δλ 按「当日平均经度落在盒边」两边各算一遍取差的那边
//     （东西位保周期内星在盒里慢慢走，某一天恰在盒边是常态）。
//   · 星历：调用方给地固系采样（km），原样用（真实 TLE / 精密星历的那一天）。
// 【参考指向】固定天线对准「盒心那一天」的日平均视向（单位矢量平均再归一）；给了 alignMin 则对准那一刻的视向。
// 【指向损耗】跟踪方式：
//   fixed 固定        偏离角 θ(t) = 视向与参考指向的夹角
//   step / program / monopulse  步进 / 程控 / 单脉冲：天线跟着星走，偏离角 = 跟踪残差（常数）
//   误差预算分项（tracking.budgetDeg，°）：与上面的主项逐时刻方和根 θ(t) = √(θ_main(t)² + Σθ_i²)（rssDeg）；不给 = 主项原样
//   损耗 L(θ)：站有方向图（patternTable：[[偏离角°, 相对增益 dB(≤0)], …]）用方向图线性插值；否则高斯主瓣
//   12·(θ/θ3dB)²（θ3dB = 70λ/D，与 linkCalculator 的波束宽度同式），离开主瓣后按 RR 附录 8 附件 III 的参考方向图
//   旁瓣段封顶：L = min(高斯, G_max − G_旁瓣(θ))（ap8SidelobeDbi）—— 13 m 固定天线遇 1° 倾斜星不至于报出几百 dB。
// 【输出】日最大损耗、损耗时间分位（50% / 1%：一天里 50% / 1% 的时间超过的损耗）、最低 / 最高仰角、斜距范围、
//   距离变化率最大值与多普勒范围（|ṙ|·f/c）、最大偏离角。1 min 步长、24 h（覆盖一个恒星日以上）。
//   GEO 链路一跳的时延范围由 linkGeoTrack 把两站同一时刻的斜距相加求得。
//
// 【调用方】GSO 窗口「指向误差」工具（components/LbPointingTool.vue → IPC link:pointingBudget → gsoPointingBudget）：
//   结果只在工具里给工程师看，不回写链路表、不进链路引擎。gsoLinkTrack 是曾经的引擎接口，引擎已不再调用，导出照留。
//
// 【验证】packages/core/test/geoTrack.test.mjs：A 路 exp5（北京看 110.5°E、i = 1°：偏离 1.11°、斜距日变 161 km、
//   12 GHz 多普勒 ±236 Hz、1.2 m Ku 7.5 dB）、H 路 zx9（中星 9 号快照星历：1.2 m Ku 6.46 dB）、保持盒 i = 0.05° 13 m Ku 2.7 dB。

'use strict'

const DEG = Math.PI / 180
const TWO_PI = 2 * Math.PI
const MU = 398600.4418                 // km³/s²
const OMEGA_E = 7.2921158553e-5        // rad/s（恒星转速，与 frames.js 同值）
const A_GEO = Math.cbrt(MU / (OMEGA_E * OMEGA_E))   // 42164.17 km
const SIDEREAL_DAY_S = 2 * Math.PI / OMEGA_E           // 86164.09 s：合成同步轨道的一圈
const C_KM_S = 299792.458
const WGS_A = 6378.137, WGS_F = 1 / 298.257223563, WGS_E2 = WGS_F * (2 - WGS_F)

const num = (v, d) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? d : n }

// 跟踪方式：中文显示值与英文键两套写法都认（站库下拉存中文，与 UPC「否 / 是 / 自定义」同惯例）
const TRACK_MODES = { fixed: 'fixed', '固定': 'fixed', step: 'step', '步进': 'step', '步进跟踪': 'step', program: 'program', '程控': 'program', '程控跟踪': 'program', monopulse: 'monopulse', '单脉冲': 'monopulse', '单脉冲跟踪': 'monopulse' }
const trackMode = (m) => TRACK_MODES[String(m == null ? '' : m).trim()] || 'fixed'

function stationEcef(latDeg, lonDeg, altKm) {
  const la = latDeg * DEG, lo = lonDeg * DEG, sl = Math.sin(la), cl = Math.cos(la)
  const N = WGS_A / Math.sqrt(1 - WGS_E2 * sl * sl)
  return {
    p: [(N + altKm) * cl * Math.cos(lo), (N + altKm) * cl * Math.sin(lo), (N * (1 - WGS_E2) + altKm) * sl],
    e: [-Math.sin(lo), Math.cos(lo), 0],
    n: [-sl * Math.cos(lo), -sl * Math.sin(lo), cl],
    u: [cl * Math.cos(lo), cl * Math.sin(lo), sl]
  }
}

// 合成同步轨道：t（s，自 0 起）→ 地固系位置（km）。dLonDeg = 日平均经度相对标称轨位的偏置（保持盒盒边）
function syncOrbit(sat, dLonDeg) {
  const i = num(sat.inclDeg, 0) * DEG, e = Math.max(0, Math.min(0.5, num(sat.ecc, 0)))
  const w = num(sat.argpDeg, 0) * DEG, O = num(sat.raanDeg, 0) * DEG
  const M0 = (num(sat.lonDeg, 0) + dLonDeg) * DEG - O - w          // Ω + ω + M₀ = 日平均经度（θ₀ = 0）
  const cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(i), si = Math.sin(i)
  return (t) => {
    const M = M0 + OMEGA_E * t
    let E = M
    for (let k = 0; k < 20; k++) { const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); E -= d; if (Math.abs(d) < 1e-15) break }
    const nu = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e)
    const r = A_GEO * (1 - e * Math.cos(E)), u = w + nu
    const cu = Math.cos(u), su = Math.sin(u)
    const x = r * (cO * cu - sO * su * ci), y = r * (sO * cu + cO * su * ci), z = r * su * si
    const th = OMEGA_E * t, c = Math.cos(th), s = Math.sin(th)
    return [x * c + y * s, -x * s + y * c, z]                       // 惯性 → 地固（绕 z 转 θ = ω⊕t）
  }
}

// 星历采样（地固 km）：线性插值取任意 t（s，自首点起）
function ephemOrbit(ep) {
  const t = ep.tMs.map((x) => (x - ep.tMs[0]) / 1000), P = ep.ecef
  return (s) => {
    let k = 0
    if (s <= t[0]) k = 0
    else if (s >= t[t.length - 1]) k = t.length - 2
    else { let lo = 0, hi = t.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= s) lo = m; else hi = m } k = lo }
    const f = (s - t[k]) / (t[k + 1] - t[k])
    return [0, 1, 2].map((j) => P[k][j] + f * (P[k + 1][j] - P[k][j]))
  }
}

// 小缓存（键 → 值，超量按插入序淘汰最早的）：链路引擎在求解器 / 批量 / 扫描里同一组入参会反复调用
function memo(max) {
  const m = new Map()
  return {
    get: (k) => m.get(k),
    set: (k, v) => { if (m.size >= max) m.delete(m.keys().next().value); m.set(k, v); return v }
  }
}
// 合成轨道的地固位置序列只由卫星参数定（与站无关）：扫站址时整张平面共用一份
const POS_CACHE = memo(16)
function satPositions(sat, dLonDeg, nStep, stepS) {
  const key = [num(sat.lonDeg, 0), num(sat.inclDeg, 0), num(sat.ecc, 0), num(sat.argpDeg, 0), num(sat.raanDeg, 0), dLonDeg, nStep, stepS].join('|')
  const hit = POS_CACHE.get(key)
  if (hit) return hit
  const f = syncOrbit(sat, dLonDeg), P = new Array(nStep)
  for (let k = 0; k < nStep; k++) P[k] = f(k * stepS)
  return POS_CACHE.set(key, P)
}

// 一个站对一条采样轨迹（地固位置数组，步长 dt 秒）的视向：{ u[]（单位视向）, el[], az[], rng[], rr[]（km/s） }
// 距离变化率取相邻采样的中心差分（1 min 步长对一天周期的正弦，截断相对误差 ~3e-6），两端单边差分
function lookSeries(st, P, dt) {
  const n = P.length
  const u = new Array(n), el = new Array(n), az = new Array(n), rng = new Array(n), rr = new Array(n)
  for (let k = 0; k < n; k++) {
    const p = P[k]
    const v0 = p[0] - st.p[0], v1 = p[1] - st.p[1], v2 = p[2] - st.p[2], r = Math.hypot(v0, v1, v2)
    const w = [v0 / r, v1 / r, v2 / r]
    u[k] = w; rng[k] = r
    el[k] = Math.asin(Math.max(-1, Math.min(1, w[0] * st.u[0] + w[1] * st.u[1] + w[2] * st.u[2]))) / DEG
    const a = Math.atan2(w[0] * st.e[0] + w[1] * st.e[1] + w[2] * st.e[2], w[0] * st.n[0] + w[1] * st.n[1] + w[2] * st.n[2]) / DEG
    az[k] = a < 0 ? a + 360 : a
  }
  for (let k = 0; k < n; k++) {
    if (n < 2) { rr[k] = 0; continue }
    const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1)
    rr[k] = (rng[b] - rng[a]) / ((b - a) * dt)
  }
  return { u, el, az, rng, rr }
}
const angleDeg = (a, b) => {
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  // 小角度用叉积模取 asin 保精度（acos 在 1 附近只剩 1e-8 rad 分辨率）
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0]
  return Math.atan2(Math.hypot(x, y, z), c) / DEG
}

// 误差预算合成（°）：主项与各分项方和根 θ = √(θ_main² + Σθ_i²)。分项按绝对值计，非数 / 空项不计；
// 分项全为 0（或不给）时原样返回主项（不经平方再开方，逐位不变）
function rssDeg(mainDeg, itemsDeg) {
  let s2 = 0
  for (const v of Array.isArray(itemsDeg) ? itemsDeg : []) { const x = Number(v); if (v !== '' && v != null && Number.isFinite(x)) s2 += x * x }
  return s2 > 0 ? Math.sqrt(mainDeg * mainDeg + s2) : mainDeg
}

// 旁瓣包络：RR 附录 8 附件 III（不知道实测方向图时的地球站参考方向图），只取主瓣以外那几段（dBi）。
// D/λ ≥ 100：G1 = 2 + 15·lg(D/λ)（φ < φr = 15.85·(D/λ)^−0.6）、32 − 25·lg φ（φ < 48°）、−10；
// D/λ < 100：G1 = −1 + 15·lg(D/λ)（φ < 100λ/D）、52 − 10·lg(D/λ) − 25·lg φ（φ < 48°）、10 − 10·lg(D/λ)。
// 主瓣段 G_max − 2.5e-3·(Dφ/λ)² 与 12·(φ/θ3dB)² 同式（θ3dB ≈ 69.3λ/D），由调用方的高斯项承担。
function ap8SidelobeDbi(th, dl) {
  if (dl >= 100) {
    if (th < 15.85 * Math.pow(dl, -0.6)) return 2 + 15 * Math.log10(dl)
    return th < 48 ? 32 - 25 * Math.log10(th) : -10
  }
  if (th < 100 / dl) return -1 + 15 * Math.log10(dl)
  return th < 48 ? 52 - 10 * Math.log10(dl) - 25 * Math.log10(th) : 10 - 10 * Math.log10(dl)
}

// 指向损耗 L(θ)（dB，≥ 0）。ant：{ theta3dBDeg, g0Dbi, dOverLambda, patternTable? }
//   有方向图（patternTable：[[偏离角°, 相对增益 dB], …]，相对增益 ≤ 0、按角度升序）→ 线性插值；
//   否则高斯主瓣 12·(θ/θ3dB)²，出了主瓣按附录 8 旁瓣包络封顶：L = min(高斯, G_max − G_旁瓣(θ))。
function pointingLossDb(thetaDeg, ant) {
  const th = Math.abs(thetaDeg)
  if (!(th > 0)) return 0
  const tab = ant.patternTable
  if (Array.isArray(tab) && tab.length >= 2) {
    if (th >= tab[tab.length - 1][0]) return Math.max(0, -tab[tab.length - 1][1])
    for (let k = 1; k < tab.length; k++) {
      if (th <= tab[k][0]) {
        const f = (th - tab[k - 1][0]) / (tab[k][0] - tab[k - 1][0])
        return Math.max(0, -(tab[k - 1][1] + f * (tab[k][1] - tab[k - 1][1])))
      }
    }
  }
  const gauss = 12 * (th / ant.theta3dBDeg) * (th / ant.theta3dBDeg)
  if (!Number.isFinite(ant.g0Dbi) || !(ant.dOverLambda > 0)) return gauss
  return Math.max(0, Math.min(gauss, ant.g0Dbi - ap8SidelobeDbi(th, ant.dOverLambda)))
}

// 由站天线参数得 θ3dB / G_max / D/λ。antenna：{ diameterM, efficiency(0–1 或 %)?, theta3dBDeg?, g0Dbi?, patternTable? }
function antennaModel(antenna, freqGHz) {
  const a = antenna || {}
  const lam = 0.299792458 / num(freqGHz, 12)
  const D = num(a.diameterM, 1)
  let eta = num(a.efficiency, 0.65); if (eta > 1) eta /= 100
  const th3 = num(a.theta3dBDeg, 70 * lam / D)
  const g0 = Number.isFinite(Number(a.g0Dbi)) && a.g0Dbi !== '' && a.g0Dbi !== null ? Number(a.g0Dbi) : 10 * Math.log10(eta * Math.pow(Math.PI * D / lam, 2))
  return { theta3dBDeg: th3, g0Dbi: g0, dOverLambda: D / lam, patternTable: a.patternTable || null }
}

// 分位：一天里 p% 的时间超过的损耗（升序样本的 1−p 分位，线性插值）
function exceeded(sorted, pct) {
  const q = 1 - pct / 100, n = sorted.length
  if (!n) return NaN
  const x = q * (n - 1), k = Math.floor(x), f = x - k
  return k + 1 < n ? sorted[k] + f * (sorted[k + 1] - sorted[k]) : sorted[n - 1]
}

/** 卫星是否在动（合成轨道 i / e / 保持盒任一非零，或给了星历） */
function satMoving(sat) {
  const s = sat || {}
  if (s.ephem && Array.isArray(s.ephem.tMs) && s.ephem.tMs.length >= 2) return true
  return num(s.inclDeg, 0) > 0 || num(s.ecc, 0) > 0 || num(s.boxDeg, 0) > 0
}

/**
 * 一条 GEO 链路两端站的日内轨迹统计。
 * opts = {
 *   sat: { lonDeg, inclDeg, ecc, argpDeg?, raanDeg?, boxDeg, ephem?: { tMs:[], ecef:[[x,y,z]…] } },
 *   tx / rx: { latDeg, lonDeg, altKm, freqGHz, antenna:{…}, tracking:{ mode, residualDeg, budgetDeg?:[°…] } }（只给一端也行）,
 *   stepMin = 1, hours = 24, alignMin = null
 * }
 * 返回 { moving, tx, rx, delayMinMs, delayMaxMs }；每端 { lossMaxDb, lossP50Db, lossP1Db, maxOffDeg（含误差分项）, theta3dBDeg,
 *   minElevDeg, maxElevDeg, minRangeKm, maxRangeKm, maxRangeRateKmS, maxDopplerHz, mode, residualDeg, refAzDeg, refElDeg }。
 */
const RESULT_CACHE = memo(64)
function linkGeoTrack(opts) {
  const o = opts || {}
  const sat = o.sat || {}
  const useEph = !!(sat.ephem && Array.isArray(sat.ephem.tMs) && sat.ephem.tMs.length >= 2)
  // 同一组入参反复调（功带平衡一行跑三十几次引擎）直接取上次的结果；星历入参不进缓存（数组大、少见）
  let ckey = null
  if (!useEph) {
    try { ckey = JSON.stringify([o.sat, o.tx, o.rx, o.stepMin, o.hours, o.alignMin]) } catch (e) { ckey = null }
    const hit = ckey && RESULT_CACHE.get(ckey)
    if (hit) return hit
  }
  const moving = satMoving(sat)
  const stepS = Math.max(1, num(o.stepMin, 1)) * 60
  const nStep = Math.floor(num(o.hours, 24) * 3600 / stepS) + 1
  const box = Math.max(0, num(sat.boxDeg, 0))
  const nUse = moving ? nStep : 1
  // 盒心那一天（定参考指向）+ 盒边两天（取差的那边）；不动的星只有一个采样（常量）
  let centre, edges
  if (useEph) {
    const f = ephemOrbit(sat.ephem), span = (sat.ephem.tMs[sat.ephem.tMs.length - 1] - sat.ephem.tMs[0]) / 1000
    const n = Math.min(nStep, Math.floor(span / stepS) + 1)
    centre = new Array(n); for (let k = 0; k < n; k++) centre[k] = f(k * stepS)
    edges = [centre]
  } else {
    centre = satPositions(sat, 0, nUse, stepS)
    edges = box > 0 ? [satPositions(sat, box, nUse, stepS), satPositions(sat, -box, nUse, stepS)] : [centre]
  }
  const out = { moving }
  const sides = ['tx', 'rx'].filter((k) => o[k])
  const series = {}
  for (const k of sides) {
    const S = o[k]
    const st = stationEcef(num(S.latDeg, 0), num(S.lonDeg, 0), num(S.altKm, 0))
    const ant = antennaModel(S.antenna, S.freqGHz)
    const mode = trackMode(S.tracking && S.tracking.mode)
    const res = Math.max(0, num(S.tracking && S.tracking.residualDeg, 0))
    const budget = (S.tracking && S.tracking.budgetDeg) || null
    const ref = lookSeries(st, centre, stepS)
    let refU
    const al = o.alignMin == null || o.alignMin === '' ? NaN : Number(o.alignMin)
    if (Number.isFinite(al) && moving && ref.u.length > 1) refU = ref.u[Math.max(0, Math.min(ref.u.length - 1, Math.round(al * 60 / stepS)))]
    else {
      // 日平均指向：合成轨道严格一个恒星日一圈，只平均整一圈（24 h 比恒星日多 3.93 min，多出来那截会把平均方向拽偏 ~0.3%）；
      // 星历按给的那一天全平均
      const nRef = useEph ? ref.u.length : Math.max(1, Math.min(ref.u.length, Math.round(SIDEREAL_DAY_S / stepS)))
      const m = [0, 0, 0]
      for (let j = 0; j < nRef; j++) { const w = ref.u[j]; m[0] += w[0]; m[1] += w[1]; m[2] += w[2] }
      const mn = Math.hypot(m[0], m[1], m[2]); refU = [m[0] / mn, m[1] / mn, m[2] / mn]
    }
    let worst = null
    const env = { minEl: Infinity, maxEl: -Infinity, minR: Infinity, maxR: -Infinity, maxRr: 0 }
    series[k] = []
    for (const pos of edges) {
      const L = pos === centre ? ref : lookSeries(st, pos, stepS)
      series[k].push(L)
      const loss = [], off = []
      for (let j = 0; j < L.u.length; j++) {
        const th = rssDeg(mode === 'fixed' ? angleDeg(L.u[j], refU) : res, budget)
        off.push(th); loss.push(pointingLossDb(th, ant))
        env.minEl = Math.min(env.minEl, L.el[j]); env.maxEl = Math.max(env.maxEl, L.el[j])
        env.minR = Math.min(env.minR, L.rng[j]); env.maxR = Math.max(env.maxR, L.rng[j])
        if (moving) env.maxRr = Math.max(env.maxRr, Math.abs(L.rr[j]))
      }
      let lossMax = 0
      for (const x of loss) if (x > lossMax) lossMax = x
      if (!worst || lossMax > worst.lossMax) worst = { lossMax, loss, off }
    }
    const sorted = worst.loss.slice().sort((a, b) => a - b)
    const ru = refU
    out[k] = {
      mode, residualDeg: res, theta3dBDeg: ant.theta3dBDeg,
      lossMaxDb: worst.lossMax, lossP50Db: exceeded(sorted, 50), lossP1Db: exceeded(sorted, 1),
      maxOffDeg: Math.max(...worst.off),
      minElevDeg: env.minEl, maxElevDeg: env.maxEl, minRangeKm: env.minR, maxRangeKm: env.maxR,
      maxRangeRateKmS: env.maxRr, maxDopplerHz: env.maxRr / C_KM_S * num(S.freqGHz, 12) * 1e9,
      refElDeg: Math.asin(Math.max(-1, Math.min(1, ru[0] * st.u[0] + ru[1] * st.u[1] + ru[2] * st.u[2]))) / DEG,
      refAzDeg: ((Math.atan2(ru[0] * st.e[0] + ru[1] * st.e[1] + ru[2] * st.e[2], ru[0] * st.n[0] + ru[1] * st.n[1] + ru[2] * st.n[2]) / DEG) + 360) % 360
    }
  }
  // 一跳时延：两站同一时刻的斜距之和；保持盒两边那两天各算一遍取包络
  if (series.tx && series.rx) {
    let lo = Infinity, hi = -Infinity
    for (let ei = 0; ei < series.tx.length; ei++) {
      const a = series.tx[ei].rng, b = series.rx[ei].rng, n = Math.min(a.length, b.length)
      for (let j = 0; j < n; j++) { const d = a[j] + b[j]; if (d < lo) lo = d; if (d > hi) hi = d }
    }
    out.delayMinMs = lo / C_KM_S * 1000
    out.delayMaxMs = hi / C_KM_S * 1000
  }
  return ckey ? RESULT_CACHE.set(ckey, out) : out
}

/**
 * 曾经的 GSO 链路引擎（linkCalculator）接口：入参键名与引擎同一套，几何 / 天线量取引擎已经算好的那份（同一个 θ3dB、增益、频率）。
 * 资源库那五个字段撤出后引擎不再调用它（指向损耗改由「指向误差」工具看，见 gsoPointingBudget），导出照留。
 *   satParams.geoIncl（°）/ geoEcc / geoBoxEW（±°）—— 卫星库「倾角 / 偏心率 / 东西保持 ±」；
 *   inputs.trackMode / trackResidual（发信站）、rxTrackMode / rxTrackResidual（收信站）—— 地球站库「跟踪方式 / 跟踪残差」。
 * g：{ orbitPosition, tx:{ lat, lon, altKm, freqGHz, diameterM, efficiency, g0Dbi, theta3dBDeg }, rx:{ … } }
 * 卫星不动、两站又都没有跟踪残差 → null（引擎据此一个字不动：损耗 0、出参留空）。
 */
function gsoLinkTrack(satParams, inputs, g) {
  const sp = satParams || {}, ip = inputs || {}
  const sat = { lonDeg: num(g.orbitPosition, 0), inclDeg: Math.max(0, num(sp.geoIncl, 0)), ecc: Math.max(0, num(sp.geoEcc, 0)), boxDeg: Math.max(0, num(sp.geoBoxEW, 0)) }
  const side = (s, mode, resid) => ({
    latDeg: s.lat, lonDeg: s.lon, altKm: s.altKm, freqGHz: s.freqGHz,
    antenna: { diameterM: s.diameterM, efficiency: s.efficiency, g0Dbi: s.g0Dbi, theta3dBDeg: s.theta3dBDeg },
    tracking: { mode: trackMode(mode), residualDeg: Math.max(0, num(resid, 0)) }
  })
  const tx = side(g.tx, ip.trackMode, ip.trackResidual), rx = side(g.rx, ip.rxTrackMode, ip.rxTrackResidual)
  const tracks = (S) => S.tracking.mode !== 'fixed' && S.tracking.residualDeg > 0
  if (!satMoving(sat) && !tracks(tx) && !tracks(rx)) return null
  return linkGeoTrack({ sat, tx, rx })
}

// 偏离角 → 损耗速查表的档位（θ/θ3dB）：主瓣内一路到 θ3dB，再往外两档看旁瓣封顶
const QUICK_RATIOS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.5, 2]

/**
 * GSO 窗口「指向误差」工具：一个地球站对一颗 GSO 星一天（1 min 步、24 h）的指向偏离与指向损耗。
 * opts = {
 *   sat: { lonDeg, inclDeg, ecc, boxDeg },
 *   station: { latDeg, lonDeg, altKm, freqGHz, diameterM, efficiencyPct },
 *   mode: 'fixed' | 'step'（中文「固定 / 步进跟踪」亦认）, residualDeg（步进跟踪的跟踪残差）,
 *   budgetDeg: [θ_i…]（误差预算分项，°；哪几项计入由调用方定）, stepMin = 1, hours = 24
 * }
 * 主项 θ_main(t)：固定 = 卫星运动带来的视线偏离（对日平均指向）、步进跟踪 = 跟踪残差；θ(t) = √(θ_main(t)² + Σθ_i²)，
 * 损耗按 pointingLossDb（高斯主瓣 12·(θ/θ3dB)²，出主瓣按 RR 附录 8 旁瓣封顶）。
 * 返回 null（口径 / 频率 / 效率 / 纬度不成立）或 { theta3dBDeg, g0Dbi, maxOffDeg, lossMaxDb, lossP50Db, lossP1Db,
 *   minElevDeg, maxElevDeg, minRangeKm, maxRangeKm, maxDopplerHz, quick:[{ ratio, thetaDeg, lossDb }] }。
 */
function gsoPointingBudget(opts) {
  const o = opts || {}, S = o.station || {}, sat = o.sat || {}
  const lat = num(S.latDeg, NaN), D = num(S.diameterM, NaN), f = num(S.freqGHz, NaN), pct = num(S.efficiencyPct, NaN)
  if (!(Math.abs(lat) <= 90) || !(D > 0) || !(f > 0) || !(pct > 0 && pct <= 100)) return null
  const antenna = { diameterM: D, efficiency: pct / 100 }
  const mode = trackMode(o.mode)
  const r = linkGeoTrack({
    sat: { lonDeg: num(sat.lonDeg, 0), inclDeg: Math.max(0, num(sat.inclDeg, 0)), ecc: Math.max(0, num(sat.ecc, 0)), boxDeg: Math.max(0, num(sat.boxDeg, 0)) },
    tx: {
      latDeg: lat, lonDeg: num(S.lonDeg, 0), altKm: num(S.altKm, 0), freqGHz: f, antenna,
      tracking: { mode, residualDeg: mode === 'fixed' ? 0 : Math.max(0, num(o.residualDeg, 0)), budgetDeg: Array.isArray(o.budgetDeg) ? o.budgetDeg : [] }
    },
    stepMin: o.stepMin, hours: o.hours
  })
  const t = r.tx, ant = antennaModel(antenna, f)
  return {
    theta3dBDeg: ant.theta3dBDeg, g0Dbi: ant.g0Dbi, maxOffDeg: t.maxOffDeg,
    lossMaxDb: t.lossMaxDb, lossP50Db: t.lossP50Db, lossP1Db: t.lossP1Db,
    minElevDeg: t.minElevDeg, maxElevDeg: t.maxElevDeg, minRangeKm: t.minRangeKm, maxRangeKm: t.maxRangeKm, maxDopplerHz: t.maxDopplerHz,
    quick: QUICK_RATIOS.map((k) => ({ ratio: k, thetaDeg: k * ant.theta3dBDeg, lossDb: pointingLossDb(k * ant.theta3dBDeg, ant) }))
  }
}

module.exports = { A_GEO, OMEGA_E, TRACK_MODES, trackMode, satMoving, pointingLossDb, antennaModel, rssDeg, linkGeoTrack, gsoLinkTrack, gsoPointingBudget }
