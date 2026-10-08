// 行星（地图设置 · 宇宙空间 · 行星）：水、金、火、木、土、天王六颗肉眼可见行星的地心位置、视星等与颜色 —— 渲染端 ESM。
// 与 lunar.js / terminator.js 同一理由自带一份：要随时间轴每拍重算、不能走 IPC，渲染端也不能镜像 packages/core 的 CJS。
//
// ── 位置：VSOP87B（Bretagnon & Francou 1988，A&A 202, 309；IMCCE）──
// 日心球坐标（L, B, R），J2000 动力学黄道与春分点；级数由 scripts/build-planet-series.mjs 从 IMCCE 原件截断后生成 planets.data.js
// （截断门限与它带来的误差在那边量过）。每个变量 = Σ_k τ^k Σ_i A_i cos(B_i + C_i τ)，τ = 自 J2000.0 起的儒略千年（TDB ≈ TT）。
// 地心天体测量位置 = 行星(t − 光行时) − 地球(t)，光行时迭代两次；不加周年光行差与引力偏折 —— 与星表星位同一口径
//（BSC 星位也没加周年光行差，20″ 的光行差对星和行星几乎一样，两者的相对位置这样才对）。
// 黄道 J2000 → 赤道 J2000：绕 x 转 ε0 = 84381.448″；VSOP87 动力学系与 FK5 / ICRF 之差 < 0.1″，略。之后与恒星同一条链进场景
//（spaceFx.icrfToSceneRows：岁差 + 章动 + GAST）。对 JPL Horizons（DE441）实测见 packages/core/test/planets.test.mjs。
//
// ── 视星等：Mallama & Hilton 2018（Astronomy & Computing 25, 10）—— 天文年历的现行公式，Horizons 的 APmag 同一套 ──
// 取与相位角 α、日距 r、地距 Δ 有关的主项，外加土星环倾角、天王星亚纬度两项（都由 IAU 极向现算）；
// 火星的自转 / 季节修正（查表项，±0.09 等）不做。
//
// ── 颜色：各行星的 B−V（反射太阳光后的色指数），渲染端与恒星走同一条 B−V → 颜色的映射 ──
import { timeArgs } from './lunar.js'

const D2R = Math.PI / 180
const EPS0 = 84381.448 / 3600 * D2R          // J2000 平黄赤交角
const LIGHT_DAY_PER_AU = 0.0057755183        // 光行一个天文单位要多少天
export const AU_KM = 149597870.7

/** 六颗行星（顺序即 planets.data.js 里级数的顺序之后、渲染顶点的顺序）。bv：色指数 */
export const PLANETS = Object.freeze([
  Object.freeze({ key: 'mer', name: '水星', bv: 0.93 }),
  Object.freeze({ key: 'ven', name: '金星', bv: 0.82 }),
  Object.freeze({ key: 'mar', name: '火星', bv: 1.43 }),
  Object.freeze({ key: 'jup', name: '木星', bv: 0.87 }),
  Object.freeze({ key: 'sat', name: '土星', bv: 1.09 }),
  Object.freeze({ key: 'ura', name: '天王星', bv: 0.56 })
])

/**
 * planets.data.js → { ear, mer, …: [L, B, R] }，每个变量是按 τ 的幂次排的 Float64Array 数组，每项三个数 (A, B, C)。
 * 数据格式见生成脚本：base64 的 float64 小端流 —— 每个天体 3 个变量 × 若干幂次，每段先一个项数、再 3 × 项数个数。
 */
export function decodePlanetSeries(mod) {
  const s = atob(mod.PLANET_SERIES)
  const bin = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bin[i] = s.charCodeAt(i)
  const f = new Float64Array(bin.buffer)
  const out = {}
  let p = 0
  for (const body of mod.PLANET_BODIES) {
    const vars = []
    for (let v = 0; v < 3; v++) {
      const nPow = f[p++], powers = []
      for (let k = 0; k < nPow; k++) {
        const n = f[p++]
        powers.push(f.subarray(p, p + n * 3))
        p += n * 3
      }
      vars.push(powers)
    }
    out[body] = vars
  }
  if (p !== f.length) throw new Error('planets.data.js 长度不对')
  return out
}

function series(powers, tau) {
  let sum = 0, tk = 1
  for (const a of powers) {
    let s = 0
    for (let i = 0; i < a.length; i += 3) s += a[i] * Math.cos(a[i + 1] + a[i + 2] * tau)
    sum += s * tk
    tk *= tau
  }
  return sum
}
/** 日心黄道直角坐标（AU，J2000 动力学黄道） */
export function helioEcliptic(vars, tau) {
  const L = series(vars[0], tau), B = series(vars[1], tau), R = series(vars[2], tau)
  const cb = Math.cos(B)
  return [R * cb * Math.cos(L), R * cb * Math.sin(L), R * Math.sin(B)]
}
const eclToEqu = (v) => {
  const c = Math.cos(EPS0), s = Math.sin(EPS0)
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]]
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const len = (a) => Math.hypot(a[0], a[1], a[2])

// 视星等（Mallama & Hilton 2018）。a = 相位角（°），rd = 5 log10(r Δ)
const MAG = {
  mer: (a, rd) => rd - 0.613 + 6.3280e-02 * a - 1.6336e-03 * a * a + 3.3644e-05 * a ** 3 - 3.4265e-07 * a ** 4 + 1.6893e-09 * a ** 5 - 3.0334e-12 * a ** 6,
  ven: (a, rd) => (a <= 163.7
    ? rd - 4.384 - 1.044e-03 * a + 3.687e-04 * a * a - 2.814e-06 * a ** 3 + 8.938e-09 * a ** 4
    : rd + 236.05828 - 2.81914 * a + 8.39034e-03 * a * a),
  mar: (a, rd) => (a <= 50 ? rd - 1.601 + 0.02267 * a - 0.0001302 * a * a : rd - 0.367 - 0.02573 * a + 0.0003445 * a * a),
  jup: (a, rd) => {
    if (a <= 12) return rd - 9.395 - 3.7e-04 * a + 6.16e-04 * a * a
    const x = a / 180
    return rd - 9.428 - 2.5 * Math.log10(1 - 1.507 * x - 0.363 * x * x - 0.062 * x ** 3 + 2.809 * x ** 4 - 1.876 * x ** 5)
  },
  // 土星：本体 + 环；beta = 环面对地球的倾角（rad）
  sat: (a, rd, beta) => {
    const sb = Math.abs(Math.sin(beta))
    return rd - 8.914 - 1.825 * sb + 0.026 * a - 0.378 * sb * Math.exp(-2.25 * a)
  },
  // 天王星：phi = 亚地点与日下点行星纬度绝对值的平均（°）—— 近年极区对着我们，这一项亮 0.06 等
  ura: (a, rd, beta, phi) => rd - 7.110 - 8.4e-04 * phi + 6.587e-03 * a + 1.045e-04 * a * a
}
// 土星、天王星北极（ICRF，IAU 2015；岁差项一个世纪才 0.04°，略）
const pole = (aDeg, dDeg) => { const a = aDeg * D2R, d = dDeg * D2R; return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)] }
const SAT_POLE = pole(40.589, 83.537), URA_POLE = pole(257.311, -15.175)
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * 某一时刻六颗行星的地心天体测量位置与视星等。
 * @param {Date|number} date UTC 时刻
 * @param {object} S decodePlanetSeries 的结果
 * @returns {{key:string, icrf:number[], delta:number, r:number, phase:number, mag:number, raDeg:number, decDeg:number}[]}
 *   icrf：地心 → 行星（AU，ICRF / J2000 赤道）；delta：地距（AU）；r：日距（AU）；phase：相位角（°，日—行星—地）
 */
export function planetEphemeris(date, S) {
  const tau = (timeArgs(date instanceof Date ? date : new Date(date)).jde - 2451545.0) / 365250
  const earth = helioEcliptic(S.ear, tau)
  return PLANETS.map((P) => {
    // 光行时：先按 t 算出地距，再在 t − 光行时处重算行星。一次就够 —— 再迭代一次，地距只变 deldot × 光行时（≤ 1e4 km），
    // 光行时随之变 0.03 s，行星挪不到 1 km
    let hp = helioEcliptic(S[P.key], tau), geo = sub(hp, earth)
    hp = helioEcliptic(S[P.key], tau - len(geo) * LIGHT_DAY_PER_AU / 365250)
    geo = sub(hp, earth)
    const delta = len(geo), r = len(hp)
    // 相位角：行星处看太阳（−hp）与看地球（−geo）的夹角
    const cosA = (hp[0] * geo[0] + hp[1] * geo[1] + hp[2] * geo[2]) / (r * delta)
    const phase = Math.acos(Math.max(-1, Math.min(1, cosA))) / D2R
    const icrf = eclToEqu(geo)
    let beta = 0, phi = 0
    if (P.key === 'sat') beta = Math.asin(-dot(SAT_POLE, icrf) / delta)
    if (P.key === 'ura') phi = (Math.abs(Math.asin(-dot(URA_POLE, icrf) / delta)) + Math.abs(Math.asin(-dot(URA_POLE, eclToEqu(hp)) / r))) / 2 / D2R
    const mag = MAG[P.key](phase, 5 * Math.log10(r * delta), beta, phi)
    const raDeg = ((Math.atan2(icrf[1], icrf[0]) / D2R) + 360) % 360, decDeg = Math.asin(icrf[2] / delta) / D2R
    return { key: P.key, icrf, delta, r, phase, mag, raDeg, decDeg }
  })
}
