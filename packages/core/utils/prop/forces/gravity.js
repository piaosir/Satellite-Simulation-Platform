// 地球球谐重力场：EGM2008 完全归一化系数，归一化 Cunningham V/W 递推（纯 CommonJS）。
//
// 【系数】../data/egm2008_70.js（scripts/build-egm2008.mjs 从 NGA 原件截断生成，来源与 SHA-256 见该脚本头注）。
//   GM = 3.986004415e5 km³/s²，a_e = 6378.1363 km（EGM2008 自带的尺度参数，整套力学一律用这一对）。
//   缺省阶次：GEO / MEO（a ≥ 20000 km）8×8，LEO 21×21；最高 70×70（数据文件只到 70）。
// 【潮汐体系】原件 C̄20 是 tide-free。缺省 tideSystem = 'zero-tide'：C̄20 加上永久潮汐项
//   ΔC̄20 = A0·H0·k20 = (4.4228e-8)(−0.31460)(0.30190) = −4.2007e-9（IERS Conventions 2010 式 (6.13)，
//   k20 与 tides.js 同值），不叠固体潮时这才是「地球实际形状」的口径。叠 tides.js 时两种体系都可以，
//   tides.js 按此处的体系决定是否扣永久项（IERS 2010 §6.2.2）。
//
// 【加速度公式】Montenbruck & Gill《Satellite Orbits》(2000) §3.2.4–3.2.5 的 Cunningham 递推（式 3.29–3.33），
//   换成完全归一化量 V̄nm = Nnm·Vnm、W̄nm = Nnm·Wnm（Nnm = sqrt((2−δm0)(2n+1)(n−m)!/(n+m)!)）后，递推系数为
//   （推导：把 M&G 的非归一化式两边乘 Nnm，比值 Nnm/N(n−1)m 等化简；与 Eckman et al., NASA/TP-2016-218604 同形）：
//     V̄00 = R/r，x0 = R·x/r²，y0 = R·y/r²，z0 = R·z/r²，ρ = R²/r²
//     扇谐：V̄mm = cm(x0·V̄(m−1)(m−1) − y0·W̄(m−1)(m−1))，W̄mm = cm(x0·W̄(m−1)(m−1) + y0·V̄(m−1)(m−1))，
//           c1 = √3，cm = √((2m+1)/(2m))（m ≥ 2）
//     列推：V̄nm = anm·z0·V̄(n−1)m − bnm·ρ·V̄(n−2)m，anm = √((4n²−1)/(n²−m²))，
//           bnm = √((2n+1)(n+m−1)(n−m−1)/((2n−3)(n−m)(n+m)))（n = m+1 时 b = 0）
//   加速度（地固系）：a = GM/R² · Σn Σm {…}，其中
//     m = 0：ẍ −= C̄n0·fx·V̄(n+1)1，ÿ −= C̄n0·fx·W̄(n+1)1，z̈ −= C̄n0·fz·V̄(n+1)0，
//            fx = √((2n+1)(n+1)(n+2)/(2(2n+3)))，fz = √((2n+1)(n+1)²/(2n+3))
//     m ≥ 1：ẍ += ½fA(−C̄V̄(n+1)(m+1) − S̄W̄(n+1)(m+1)) + fB(C̄V̄(n+1)(m−1) + S̄W̄(n+1)(m−1))
//            ÿ += ½fA(−C̄W̄(n+1)(m+1) + S̄V̄(n+1)(m+1)) + fB(−C̄W̄(n+1)(m−1) + S̄V̄(n+1)(m−1))
//            z̈ += fz(−C̄V̄(n+1)m − S̄W̄(n+1)m)
//            fA = √((2n+1)(n+m+1)(n+m+2)/(2n+3))，fB = ½√(g(2n+1)(n−m+1)(n−m+2)/(2n+3))（g = 2 若 m = 1，否则 1），
//            fz = √((2n+1)(n+m+1)(n−m+1)/(2n+3))
//   n = 0 项（C̄00 = 1）就是中心引力 −GM·r/r³，递推天然包含；n = 1 项为 0（地心原点）。
//   全程无奇点（不含 1/cos φ），极区可用；归一化量不溢出，70 阶在双精度下无精度问题（测试用独立的勒让德求和
//   数值求梯度核对）。
//
// 接口：
//   loadEgm2008() → { C, S, nmax, gm(km³/s²), ae(km), tideSystem:'tide-free' }（三角下标 k = n(n+1)/2 + m）
//   createGravityField({ degree, order, tideSystem, includeCentral, coeffs }) → {
//     degree, order, gm, ae,
//     accelerationFixed(rFixed) → [ax, ay, az]（地固系，km/s²）
//     potential(rFixed) → U（km²/s²，测试用）
//   }
//   createGravity({ degree, order, ..., earthRotation }) → { acceleration(tMs, rJ2000) → [ax, ay, az]（J2000，km/s²） }
//   defaultDegree(r0) → 8 或 21

'use strict'

const DATA = require('../data/egm2008_70.js')
const ER = require('../earthRotation.js')

// 永久潮汐：IERS 2010 式 (6.13)，A0 = 1/(R_E·√(4π))·… = 4.4228e-8 m⁻¹，H0 = −0.31460 m，k20 = 0.30190（表 6.3）
const A0 = 4.4228e-8
const H0 = -0.31460
const K20 = 0.30190
const DC20_PERM = A0 * H0 * K20

/* ===================== base64 → Float64Array（不依赖 Buffer / atob，Worker 里也能用） ===================== */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function decodeF64(b64) {
  const s = String(b64).replace(/[^A-Za-z0-9+/]/g, '')
  const lut = new Int16Array(128).fill(-1)
  for (let i = 0; i < 64; i++) lut[B64.charCodeAt(i)] = i
  const nBytes = Math.floor(s.length * 3 / 4)
  const bytes = new Uint8Array(nBytes)
  let o = 0
  for (let i = 0; i < s.length; i += 4) {
    const a = lut[s.charCodeAt(i)], b = lut[s.charCodeAt(i + 1)]
    const c = i + 2 < s.length ? lut[s.charCodeAt(i + 2)] : 0
    const d = i + 3 < s.length ? lut[s.charCodeAt(i + 3)] : 0
    const v = (a << 18) | (b << 12) | (c << 6) | d
    if (o < nBytes) bytes[o++] = (v >> 16) & 255
    if (o < nBytes) bytes[o++] = (v >> 8) & 255
    if (o < nBytes) bytes[o++] = v & 255
  }
  // 数据按小端写；在大端机上逐 8 字节翻转
  const le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
  if (!le) for (let i = 0; i < nBytes; i += 8) bytes.subarray(i, i + 8).reverse()
  return new Float64Array(bytes.buffer, 0, nBytes / 8)
}

let _egm = null
function loadEgm2008() {
  if (_egm) return _egm
  const C = decodeF64(DATA.C), S = decodeF64(DATA.S)
  if (C.length !== DATA.count || S.length !== DATA.count) throw new Error('EGM2008 数据文件长度不对')
  _egm = { C, S, nmax: DATA.nmax, gm: DATA.gm / 1e9, ae: DATA.ae / 1000, tideSystem: DATA.tideSystem }
  return _egm
}

const tri = (n, m) => n * (n + 1) / 2 + m

function defaultDegree(r0) {
  const r = Array.isArray(r0) || ArrayBuffer.isView(r0) ? Math.hypot(r0[0], r0[1], r0[2]) : Number(r0)
  return r >= 20000 ? 8 : 21
}

function createGravityField(opts) {
  const o = opts || {}
  const src = o.coeffs || loadEgm2008()
  const N = o.degree == null ? 21 : Math.floor(o.degree)
  const M = o.order == null ? N : Math.floor(o.order)
  if (!(N >= 0 && N <= src.nmax)) throw new Error('重力场阶数须在 0…' + src.nmax + '：' + o.degree)
  if (!(M >= 0 && M <= N)) throw new Error('重力场次数须在 0…阶数：' + o.order)
  const gm = o.gm > 0 ? o.gm : src.gm
  const ae = o.ae > 0 ? o.ae : src.ae
  const tideSystem = o.tideSystem || 'zero-tide'
  if (tideSystem !== 'zero-tide' && tideSystem !== 'tide-free') throw new Error('tideSystem 只认 zero-tide / tide-free')
  const includeCentral = o.includeCentral !== false

  // 截断后的系数副本（C̄20 按潮汐体系折算）
  const nT = tri(N, N) + 1
  const C = new Float64Array(nT), S = new Float64Array(nT)
  for (let n = 0; n <= N; n++) {
    for (let m = 0; m <= Math.min(n, M); m++) { C[tri(n, m)] = src.C[tri(n, m)]; S[tri(n, m)] = src.S[tri(n, m)] }
  }
  if (N >= 2 && src.tideSystem === 'tide-free' && tideSystem === 'zero-tide') C[3] += DC20_PERM
  if (N >= 2 && src.tideSystem === 'zero-tide' && tideSystem === 'tide-free') C[3] -= DC20_PERM
  if (!includeCentral) C[0] = 0

  // 递推系数（V̄ 需要到 n = N+1、m = M+1）
  const N1 = N + 1, M1 = Math.min(M + 1, N1)
  const nV = tri(N1, N1) + 1
  const RA = new Float64Array(nV), RB = new Float64Array(nV), CM = new Float64Array(N1 + 1)
  for (let n = 1; n <= N1; n++) {
    for (let m = 0; m < n; m++) {
      RA[tri(n, m)] = Math.sqrt((4 * n * n - 1) / ((n - m) * (n + m)))
      RB[tri(n, m)] = n - m >= 2 ? Math.sqrt((2 * n + 1) * (n + m - 1) * (n - m - 1) / ((2 * n - 3) * (n - m) * (n + m))) : 0
    }
  }
  CM[1] = Math.sqrt(3)
  for (let m = 2; m <= N1; m++) CM[m] = Math.sqrt((2 * m + 1) / (2 * m))
  // 加速度系数
  const FX0 = new Float64Array(N + 1), FZ = new Float64Array(nT), FA = new Float64Array(nT), FB = new Float64Array(nT)
  for (let n = 0; n <= N; n++) {
    const q = (2 * n + 1) / (2 * n + 3)
    FX0[n] = Math.sqrt(q * (n + 1) * (n + 2) / 2)
    for (let m = 0; m <= Math.min(n, M); m++) {
      FZ[tri(n, m)] = Math.sqrt(q * (n + m + 1) * (n - m + 1))
      if (m >= 1) {
        FA[tri(n, m)] = 0.5 * Math.sqrt(q * (n + m + 1) * (n + m + 2))
        FB[tri(n, m)] = 0.5 * Math.sqrt((m === 1 ? 2 : 1) * q * (n - m + 1) * (n - m + 2))
      }
    }
  }

  const V = new Float64Array(nV), W = new Float64Array(nV)
  // 填 V̄ / W̄（n ≤ nTop，m ≤ mTop）
  function fill(r, nTop, mTop) {
    const x = r[0], y = r[1], z = r[2]
    const r2 = x * x + y * y + z * z
    const rr = Math.sqrt(r2)
    const x0 = ae * x / r2, y0 = ae * y / r2, z0 = ae * z / r2, rho = ae * ae / r2
    V[0] = ae / rr; W[0] = 0
    for (let m = 0; m <= mTop; m++) {
      const kmm = tri(m, m)
      if (m > 0) {
        const kp = tri(m - 1, m - 1), c = CM[m]
        V[kmm] = c * (x0 * V[kp] - y0 * W[kp])
        W[kmm] = c * (x0 * W[kp] + y0 * V[kp])
      }
      if (m + 1 <= nTop) {
        const k1 = tri(m + 1, m), a = RA[k1]
        V[k1] = a * z0 * V[kmm]; W[k1] = a * z0 * W[kmm]
      }
      for (let n = m + 2; n <= nTop; n++) {
        const k = tri(n, m), k1 = tri(n - 1, m), k2 = tri(n - 2, m)
        const a = RA[k] * z0, b = RB[k] * rho
        V[k] = a * V[k1] - b * V[k2]
        W[k] = a * W[k1] - b * W[k2]
      }
    }
    return rr
  }

  function accelerationFixed(r) {
    fill(r, N1, M1)
    let ax = 0, ay = 0, az = 0
    for (let n = 0; n <= N; n++) {
      const n1 = n + 1
      // m = 0
      const k0 = tri(n, 0)
      const c0 = C[k0]
      if (c0 !== 0) {
        ax -= c0 * FX0[n] * V[tri(n1, 1)]
        ay -= c0 * FX0[n] * W[tri(n1, 1)]
        az -= c0 * FZ[k0] * V[tri(n1, 0)]
      }
      const mm = Math.min(n, M)
      for (let m = 1; m <= mm; m++) {
        const k = tri(n, m)
        const c = C[k], s = S[k]
        if (c === 0 && s === 0) continue
        const kp = tri(n1, m + 1), km = tri(n1, m - 1), kz = tri(n1, m)
        const fa = FA[k], fb = FB[k], fz = FZ[k]
        ax += fa * (-c * V[kp] - s * W[kp]) + fb * (c * V[km] + s * W[km])
        ay += fa * (-c * W[kp] + s * V[kp]) + fb * (-c * W[km] + s * V[km])
        az += fz * (-c * V[kz] - s * W[kz])
      }
    }
    const k = gm / (ae * ae)
    return [k * ax, k * ay, k * az]
  }

  function potential(r) {
    fill(r, N, M)
    let u = 0
    for (let n = 0; n <= N; n++) {
      for (let m = 0; m <= Math.min(n, M); m++) { const k = tri(n, m); u += C[k] * V[k] + S[k] * W[k] }
    }
    return gm / ae * u
  }

  return { degree: N, order: M, gm, ae, tideSystem, C, S, accelerationFixed, potential }
}

// J2000 入口：r_J2000 → 地固 → 场 → 回 J2000
function createGravity(opts) {
  const o = opts || {}
  const field = o.field || createGravityField(o)
  const er = o.earthRotation || ER.createEarthRotation()
  return {
    field, earthRotation: er,
    gm: field.gm, ae: field.ae,
    acceleration(tMs, r) {
      const Mx = er.m(tMs)
      const aF = field.accelerationFixed(ER.mulMV(Mx, r))
      return ER.mulTV(Mx, aF)
    }
  }
}

module.exports = { loadEgm2008, createGravityField, createGravity, defaultDegree, decodeF64, DC20_PERM, K20 }
