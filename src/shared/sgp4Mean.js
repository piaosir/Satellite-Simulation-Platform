// 合成轨道 → SGP4 平根数 —— 渲染端 ESM 壳（packages/core/utils/sgp4Mean.js 的镜像；口径、算式与设计说明全在那份头注）。
//
// ★ 为什么要两份：Vite 不转换 packages/ 下的源码 CJS，渲染端 import 不进去；Electron 31 的主进程又 require 不了 ESM。
//   两份只有模块壳不同，「共享段」逐字节相同，由 packages/core/test/sgp4Mean.test.mjs 钉死 —— 改算式只改共享段、两份一起改。
// 用处：星座 3D 页合成星（useCustomConstellations）、轨道向导（orbitDesign / customConstGen）、天线树轨道根数星（treeOrbitEpoch）、
//   搜索池（satSearchPool）、自定义星座星历导出；主进程 ngsoGeometry.buildSatrec 的 elements 分支用 core 那份 —— 同一组根数两边建出同一颗星。

/* <<<< 共享段（packages/core/utils/sgp4Mean.js 与 src/shared/sgp4Mean.js 两份逐字节相同） */
const TWO_PI = 2 * Math.PI
const DEG = Math.PI / 180
// satellite.js（WGS-72）同值常量：initl 的 Kozai -> Brouwer 换算就用这几个
const S_RE = 6378.135
const S_MU = 398600.8
const S_J2 = 1082616e-9
const S_XKE = 60 / Math.sqrt(S_RE * S_RE * S_RE / S_MU)
const XPDOTP = 1440 / TWO_PI
// 平台读数口径的地球半径：信息卡近 / 远地点高度 = (satrec.a·(1 ∓ e) − 1)·6378.137（shared/satrecMetrics.js、treeGeo 定点同此）
const RE = 6378.137
const ECC_MAX = 0.999
// 太阳同步节点进动率：一个回归年转一圈（rad/min）
const OMEGA_SS = TWO_PI / (365.2421897 * 1440)

const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const clampEcc = (e) => Math.max(0, Math.min(ECC_MAX, finite(e)))

// initl 正算（逐字照 satellite.js initl）：Kozai n_K（rad/min）-> Brouwer n_B（rad/min）
function brouwerFromKozai(nK, e, iRad) {
  const omeosq = 1 - e * e, rteosq = Math.sqrt(omeosq), c = Math.cos(iRad)
  const ak = (S_XKE / nK) ** (2 / 3)
  const d1 = 0.75 * S_J2 * (3 * c * c - 1) / (rteosq * omeosq)
  let del = d1 / (ak * ak)
  const adel = ak * (1 - del * del - del * (1 / 3 + 134 * del * del / 81))
  del = d1 / (adel * adel)
  return nK / (1 + del)
}
// 反算 n_B -> n_K：δ 只依赖 n_K 本身（量级 1e-3），定点迭代 n_K ← n_B·(1 + δ(n_K)) 几步收到机器精度
function kozaiFromBrouwer(nB, e, iRad) {
  const omeosq = 1 - e * e, rteosq = Math.sqrt(omeosq), c = Math.cos(iRad)
  const d1 = 0.75 * S_J2 * (3 * c * c - 1) / (rteosq * omeosq)
  let nK = nB
  for (let k = 0; k < 50; k++) {
    const ak = (S_XKE / nK) ** (2 / 3)
    let del = d1 / (ak * ak)
    const adel = ak * (1 - del * del - del * (1 / 3 + 134 * del * del / 81))
    del = d1 / (adel * adel)
    const next = nB * (1 + del)
    if (Math.abs(next - nK) <= 1e-15 * nK) return next
    nK = next
  }
  return nK
}
// 设计半长轴 a（km，信息卡口径）-> 喂 omm2satrec 的 Kozai 平均运动（rev/day）：sgp4init 后 satrec.a·6378.137 = a
function meanMotionForSma(aKm, e, inclDeg) {
  const aEr = finite(aKm) / RE
  if (!(aEr > 0)) return NaN
  const ecc = clampEcc(e)
  const nB = S_XKE * Math.pow(aEr, -1.5)
  return kozaiFromBrouwer(nB, ecc, finite(inclDeg) * DEG) * XPDOTP
}
// 经典六根数 { altKm（近地点高度）, ecc, incl }（walker / 向导 / 天线树 / 搜索池 / 链路预算 spec 同一形状）-> rev/day
function elementsMeanMotion(el) {
  const e = el || {}
  const ecc = clampEcc(e.ecc)
  return meanMotionForSma((RE + finite(e.altKm)) / (1 - ecc), ecc, finite(e.incl))
}
// 经典六根数 -> omm2satrec 入参（无阻力）。epoch：ISO 串（调用方定）
function ommFromElements(el, epoch, noradId) {
  const e = el || {}
  return {
    noradId: noradId == null || noradId === '' ? 'SIM' : String(noradId), epoch,
    meanMotion: elementsMeanMotion(e), ecc: clampEcc(e.ecc),
    incl: finite(e.incl), raan: finite(e.raan), argp: finite(e.argp), ma: finite(e.ma),
    bstar: 0, mdot: 0, mddot: 0
  }
}

// SGP4 长期率（rad/min）：近地取 sgp4init 的三项；深空（method 'd'）另加日月长期项
function sgp4Rates(rec) {
  const d = rec && rec.method === 'd'
  return {
    m: rec.mdot + (d ? finite(rec.dmdt) : 0),
    w: rec.argpdot + (d ? finite(rec.domdt) : 0),
    o: rec.nodedot + (d ? finite(rec.dnodt) : 0)
  }
}
// GMST82 的解析变化率（rad/min），t 为 UTC 毫秒（UT1 按 UTC，与 satellite.js gstime 同口径）：
// gstime 的秒式 θ = 67310.54841 + (876600·3600 + 8640184.812866)·T + 0.093104·T² − 6.2e-6·T³，1 s = 1/240 °
function gmstRate(t) {
  const T = (t / 86400000 + 2440587.5 - 2451545) / 36525
  const dSecPerCentury = 876600 * 3600 + 8640184.812866 + 2 * 0.093104 * T - 3 * 6.2e-6 * T * T
  return dSecPerCentury * DEG / 240 / (36525 * 1440)
}
// 割线 Newton（f 为无量纲相对残差）：步长超 maxStep 截断，落到 SGP4 建不出的点就折半退回；
// 迭代到残差进浮点分辨率（或不再变）为止，取残差最小的那一点，残差 ≤ FTOL 才算解出，否则 NaN
const FTOL = 1e-12
function secant(f, x0, x1, maxStep) {
  let f0 = f(x0), f1 = f(x1)
  if (!Number.isFinite(f0) || !Number.isFinite(f1)) return NaN
  let best = Math.abs(f1) <= Math.abs(f0) ? x1 : x0, fb = Math.min(Math.abs(f0), Math.abs(f1))
  for (let k = 0; k < 60 && fb > 1e-15 && f1 !== f0; k++) {
    let dx = -f1 * (x1 - x0) / (f1 - f0)
    if (Math.abs(dx) > maxStep) dx = dx > 0 ? maxStep : -maxStep
    let x2 = x1 + dx, f2 = f(x2)
    for (let h = 0; h < 40 && !Number.isFinite(f2); h++) { dx /= 2; x2 = x1 + dx; f2 = f(x2) }
    if (!Number.isFinite(f2) || x2 === x1) break
    x0 = x1; f0 = f1; x1 = x2; f1 = f2
    if (Math.abs(f1) < fb) { fb = Math.abs(f1); best = x1 }
  }
  return fb <= FTOL ? best : NaN
}

/**
 * 设计目标的 SGP4 反解。seed：{ aKm, e, inclDeg, raanDeg, argpDeg, m0Deg }（orbitDesign 的 J2 一阶解作初值）；
 * target：
 *   { kind: 'sma' }                     通用口径即可（不迭代）
 *   { kind: 'repeat', k, m }            i 不动，解 a：k·(ω⊕ − Ω̇) = m·(Ṁ + ω̇)
 *   { kind: 'sunSyncIncl' }             a 不动，解 i：Ω̇ = Ω̇_ss
 *   { kind: 'sunSyncSma' }              i 不动，解 a：Ω̇ = Ω̇_ss
 *   { kind: 'repeatSunSync', k, m }     a、i 联立（内层按 a 解太阳同步 i，外层解回归）
 *   { kind: 'sunSyncEcc', rpKm }        近地点地心距与 i 不动，解 e（a = rp/(1 − e)）：Ω̇ = Ω̇_ss
 *   { kind: 'geosync' }                 解 a：Ṁ + ω̇ + Ω̇ = ω⊕（任意倾角的地球同步：星下点轨迹每个节点日闭合）
 *   { kind: 'molniya', rpKm }           近地点地心距不动，解 a（e = 1 − rp/a）：2·(ω⊕ − Ω̇) = Ṁ + ω̇
 * t0Ms：satrec 历元（场景历元，UTC 毫秒）；lib：satellite.js（要 omm2satrec）。
 * 返回 { ok, seed, rates }：seed 只改 aKm / e / inclDeg；rates 为最终 satrec 的长期率（rad/min）。解不出 ok = false、seed 原样。
 */
function refineDesign(target, seed, t0Ms, lib) {
  const s0 = Object.assign({}, seed)
  const fail = { ok: false, seed: s0, rates: null }
  if (!lib || typeof lib.omm2satrec !== 'function' || !Number.isFinite(t0Ms) || !(s0.aKm > 0)) return fail
  const epoch = new Date(t0Ms).toISOString()
  const recOf = (aKm, e, iDeg) => {
    if (!(aKm > RE * 0.9) || !(e >= 0 && e < 1) || !(iDeg >= 0 && iDeg <= 180)) return null
    let r
    try {
      r = lib.omm2satrec({ noradId: 'SIM', epoch, meanMotion: meanMotionForSma(aKm, e, iDeg), ecc: e, incl: iDeg, raan: finite(s0.raanDeg), argp: finite(s0.argpDeg), ma: finite(s0.m0Deg), bstar: 0, mdot: 0, mddot: 0 })
    } catch (err) { return null }
    return r && !r.error ? r : null
  }
  const ratesAt = (aKm, e, iDeg) => { const r = recOf(aKm, e, iDeg); return r ? sgp4Rates(r) : null }
  const wE = gmstRate(t0Ms)
  const k = target && target.kind
  let aKm = s0.aKm, e = clampEcc(s0.e), iDeg = finite(s0.inclDeg)
  const stepA = 0.02 * aKm
  // 太阳同步倾角（a、e 给定）
  const ssoIncl = (a, ecc, i0) => secant((i) => { const R = ratesAt(a, ecc, i); return R ? R.o / OMEGA_SS - 1 : NaN }, i0, i0 + 1e-3, 1)
  if (k === 'repeat' || k === 'repeatSunSync') {
    const kk = Math.round(finite(target.k)), mm = Math.round(finite(target.m))
    if (!(kk >= 1 && mm >= 1)) return fail
    const resid = (a) => {
      const i = k === 'repeatSunSync' ? ssoIncl(a, e, iDeg) : iDeg
      const R = Number.isFinite(i) ? ratesAt(a, e, i) : null
      return R ? (kk * (wE - R.o) - mm * (R.m + R.w)) / (mm * wE) : NaN
    }
    aKm = secant(resid, aKm, aKm * (1 + 1e-6), stepA)
    if (k === 'repeatSunSync' && Number.isFinite(aKm)) iDeg = ssoIncl(aKm, e, iDeg)
  } else if (k === 'sunSyncIncl') {
    iDeg = ssoIncl(aKm, e, iDeg)
  } else if (k === 'sunSyncSma') {
    aKm = secant((a) => { const R = ratesAt(a, e, iDeg); return R ? R.o / OMEGA_SS - 1 : NaN }, aKm, aKm * (1 + 1e-6), stepA)
  } else if (k === 'sunSyncEcc') {
    const rp = finite(target.rpKm)
    if (!(rp > 0)) return fail
    e = secant((x) => { const R = ratesAt(rp / (1 - x), x, iDeg); return R ? R.o / OMEGA_SS - 1 : NaN }, e, e + 1e-6, 0.01)
    aKm = Number.isFinite(e) ? rp / (1 - e) : NaN
  } else if (k === 'geosync') {
    aKm = secant((a) => { const R = ratesAt(a, e, iDeg); return R ? (R.m + R.w + R.o) / wE - 1 : NaN }, aKm, aKm * (1 + 1e-6), stepA)
  } else if (k === 'molniya') {
    const rp = finite(target.rpKm)
    if (!(rp > 0)) return fail
    const eOf = (a) => 1 - rp / a
    aKm = secant((a) => { const R = ratesAt(a, eOf(a), iDeg); return R ? (2 * (wE - R.o) - (R.m + R.w)) / wE : NaN }, aKm, aKm * (1 + 1e-6), stepA)
    e = Number.isFinite(aKm) ? eOf(aKm) : NaN
  } else if (k !== 'sma') return fail
  if (!Number.isFinite(aKm) || !Number.isFinite(e) || !Number.isFinite(iDeg)) return fail
  const rec = recOf(aKm, e, iDeg)
  if (!rec) return fail
  return { ok: true, seed: Object.assign(s0, { aKm, e, inclDeg: iDeg }), rates: sgp4Rates(rec) }
}
/* 共享段 >>>> */

export {
  RE, ECC_MAX, OMEGA_SS, XPDOTP,
  brouwerFromKozai, kozaiFromBrouwer, meanMotionForSma, elementsMeanMotion, ommFromElements,
  sgp4Rates, gmstRate, refineDesign
}
export default {
  RE, ECC_MAX, OMEGA_SS, XPDOTP,
  brouwerFromKozai, kozaiFromBrouwer, meanMotionForSma, elementsMeanMotion, ommFromElements,
  sgp4Rates, gmstRate, refineDesign
}
