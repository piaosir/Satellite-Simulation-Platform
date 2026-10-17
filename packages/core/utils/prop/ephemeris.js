// 太阳、月球地心位置（J2000 = EME2000，km）——第三体引力 / 光压 / 固体潮共用（纯 CommonJS）。
//
// 【解析历表（缺省 analyticEphemeris）】
//   太阳 = −（地球日心位置）：ERFA eraEpv00 的日心部分（VSOP2000 简化解，拟合 JPL DE405；数据表 data/erfaEpv00Helio.js）。
//     ERFA 原注：1900–2100 年日心位置误差 RMS 3.7 km、最大 11.2 km，即地心方向 ≤ 0.015″。
//   月球：ERFA eraMoon98（Meeus《Astronomical Algorithms》2nd ed. 1998, p.337 的 ELP-2000/82 截断级数，基本角取
//     Simon et al. 1994, A&A 282, 663）。ERFA 原注：对 ELP/MPP02 在 1950–2100 年方向 RMS 2.9″ / 最大 18.3″，
//     距离 RMS 6.1 km / 最大 31.7 km。
//   对 DE440 实测（Orekit 读 DE440，2000–2100 年 980 个时刻，packages/core/test/propForces.test.mjs）：太阳方向 ≤ 0.013″、
//   位置 ≤ 10 km；月球方向 ≤ 9.8″、位置 ≤ 17.4 km（RMS 6.0 km）。对轨道的影响：GEO 7 天 0.6 m、一年 8 m，LEO 7 天 2 cm。
//   两者都给 GCRS（ICRS 轴向），再乘 IERS 2003 帧偏差矩阵 B = R1(−η0)·R2(ξ0)·R3(dα0)（ξ0 = −16.6170 mas，
//   η0 = −6.8192 mas，dα0 = −14.6 mas；SOFA/ERFA bp00 同式）转到 J2000 平赤道春分点（EME2000）。不转的话
//   太阳会偏 16 km（23 mas × 1 au），比 epv00 本身的误差还大。
//   时间自变量 TDB ≈ TT + 0.001657 s·sin g + 0.000014 s·sin 2g，g = 357.53° + 0.98560028°·(JD_TT − 2451545)
//   （Explanatory Supplement 1992 §2.222.2，误差 < 30 µs；忽略的话太阳 ≤ 51 m、月球 ≤ 2 m）。
//
// 【缓存】解析级数单次 ~20 µs（太阳 1323 项）。analyticEphemeris 按段做 Chebyshev 插值缓存：太阳 8 天 / 14 系数，
//   月球 2 天 / 14 系数（TDB 日，J2000 起对齐），节点处精确，段内插值误差 < 1 m（测试核对）。这也是 JPL DE 的
//   存法 —— 将来换 DE440 子集：用 chebyshevEphemeris({ sun, moon })，每个分量给 { t0Days, spanDays, coef }。
//
// 【接口】ephemeris provider = { sun(tMs) → [x,y,z] km, moon(tMs) → [x,y,z] km }（J2000，地心，tMs 为 UTC 毫秒）
//   analyticEphemeris({ cache: true })
//   tabulatedEphemeris({ sun: [{ tMs, r:[x,y,z] }...], moon: [...] }, { points: 8 })   等间隔 / 不等间隔样本的 Lagrange 插值
//   chebyshevEphemeris({ sun: segs, moon: segs })                                      DE 式分段 Chebyshev
//   另导出 sunGcrsAu(tdbDays)、moonGcrsAu(tdbDays)（ERFA 原式，GCRS，au）、frameBias、tdbDaysFromUtcMs。
//
// 【许可】eraMoon98 / eraEpv00 的算法与系数来自 ERFA（pyerfa 2.0.1.5 源码包 liberfa/erfa/src/moon98.c、epv00.c），
//   ERFA 许可为 BSD-3-Clause：
//     Copyright (C) 2013-2023, NumFOCUS Foundation. All rights reserved. Derived, with permission, from the SOFA library.
//     Redistribution and use in source and binary forms, with or without modification, are permitted provided that
//     the following conditions are met: 1 Redistributions of source code must retain the above copyright notice,
//     this list of conditions and the following disclaimer. 2 Redistributions in binary form must reproduce the above
//     copyright notice, this list of conditions and the following disclaimer in the documentation and/or other
//     materials provided with the distribution. 3 Neither the name of the Standards Of Fundamental Astronomy Board,
//     the International Astronomical Union nor the names of its contributors may be used to endorse or promote
//     products derived from this software without specific prior written permission.
//     THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED
//     WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
//     PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY
//     DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
//     PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
//     CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
//     OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//   本文件是 ERFA 的派生作品，不是 SOFA，也不代表 IAU / SOFA Board 的认可。

'use strict'

const T = require('../timeSystems.js')
const ER = require('./earthRotation.js')
const EPV = require('./data/erfaEpv00Helio.js')

const AU_KM = 149597870.7                 // ERFA_DAU / 1000（IAU 2012 B2）
const DD2R = Math.PI / 180
const DAS2R = Math.PI / (180 * 3600)
const DJC = 36525
const DJY = 365.25
const DAY_MS = 86400000

/* ===================== 时间：UTC 毫秒 → J2000 起的 TDB 日 ===================== */
function tdbDaysFromUtcMs(tMs) {
  const tt = T.msInSystem(tMs, 'TT')
  const d = (tt - ER.J2000_MS) / DAY_MS
  const g = (357.53 + 0.98560028 * d) * DD2R
  return d + (0.001657 * Math.sin(g) + 0.000014 * Math.sin(2 * g)) / 86400
}

/* ===================== 帧偏差 GCRS → J2000（IERS 2003 / ERFA bp00） ===================== */
const XI0 = -0.0166170 * DAS2R, ETA0 = -0.0068192 * DAS2R, DRA0 = -0.0146 * DAS2R
const FRAME_BIAS = ER.matMul(ER.rotX(-ETA0), ER.matMul(ER.rotY(XI0), ER.rotZ(DRA0)))
const frameBias = (v) => ER.mulMV(FRAME_BIAS, v)

/* ===================== eraEpv00（日心部分）：地球日心位置，BCRS，au ===================== */
const EARR = [[EPV.e0x, EPV.e1x, EPV.e2x], [EPV.e0y, EPV.e1y, EPV.e2y], [EPV.e0z, EPV.e1z, EPV.e2z]]
function earthHelioBcrsAu(tdbDays) {
  const t = tdbDays / DJY, t2 = t * t
  const ph = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    let xyz = 0
    for (let k = 0; k < 3; k++) {
      const c = EARR[i][k], tk = k === 0 ? 1 : (k === 1 ? t : t2)
      let s = 0
      for (let j = 0; j < c.length; j += 3) s += c[j] * Math.cos(c[j + 1] + c[j + 2] * t)
      xyz += tk * s
    }
    ph[i] = xyz
  }
  const A = EPV.AM, x = ph[0], y = ph[1], z = ph[2]
  return [x + A.am12 * y + A.am13 * z, A.am21 * x + A.am22 * y + A.am23 * z, A.am32 * y + A.am33 * z]
}
const sunGcrsAu = (tdbDays) => { const e = earthHelioBcrsAu(tdbDays); return [-e[0], -e[1], -e[2]] }

/* ===================== eraMoon98：月球地心位置，GCRS，au ===================== */
// 级数（Meeus 表 47.A / 47.B，ERFA 同表）：[D, M, M', F, ΣL 正弦系数（度）, ΣR 余弦系数（米）]
const TLR = [
  [0, 0, 1, 0, 6.288774, -20905355.0], [2, 0, -1, 0, 1.274027, -3699111.0], [2, 0, 0, 0, 0.658314, -2955968.0],
  [0, 0, 2, 0, 0.213618, -569925.0], [0, 1, 0, 0, -0.185116, 48888.0], [0, 0, 0, 2, -0.114332, -3149.0],
  [2, 0, -2, 0, 0.058793, 246158.0], [2, -1, -1, 0, 0.057066, -152138.0], [2, 0, 1, 0, 0.053322, -170733.0],
  [2, -1, 0, 0, 0.045758, -204586.0], [0, 1, -1, 0, -0.040923, -129620.0], [1, 0, 0, 0, -0.034720, 108743.0],
  [0, 1, 1, 0, -0.030383, 104755.0], [2, 0, 0, -2, 0.015327, 10321.0], [0, 0, 1, 2, -0.012528, 0.0],
  [0, 0, 1, -2, 0.010980, 79661.0], [4, 0, -1, 0, 0.010675, -34782.0], [0, 0, 3, 0, 0.010034, -23210.0],
  [4, 0, -2, 0, 0.008548, -21636.0], [2, 1, -1, 0, -0.007888, 24208.0], [2, 1, 0, 0, -0.006766, 30824.0],
  [1, 0, -1, 0, -0.005163, -8379.0], [1, 1, 0, 0, 0.004987, -16675.0], [2, -1, 1, 0, 0.004036, -12831.0],
  [2, 0, 2, 0, 0.003994, -10445.0], [4, 0, 0, 0, 0.003861, -11650.0], [2, 0, -3, 0, 0.003665, 14403.0],
  [0, 1, -2, 0, -0.002689, -7003.0], [2, 0, -1, 2, -0.002602, 0.0], [2, -1, -2, 0, 0.002390, 10056.0],
  [1, 0, 1, 0, -0.002348, 6322.0], [2, -2, 0, 0, 0.002236, -9884.0], [0, 1, 2, 0, -0.002120, 5751.0],
  [0, 2, 0, 0, -0.002069, 0.0], [2, -2, -1, 0, 0.002048, -4950.0], [2, 0, 1, -2, -0.001773, 4130.0],
  [2, 0, 0, 2, -0.001595, 0.0], [4, -1, -1, 0, 0.001215, -3958.0], [0, 0, 2, 2, -0.001110, 0.0],
  [3, 0, -1, 0, -0.000892, 3258.0], [2, 1, 1, 0, -0.000810, 2616.0], [4, -1, -2, 0, 0.000759, -1897.0],
  [0, 2, -1, 0, -0.000713, -2117.0], [2, 2, -1, 0, -0.000700, 2354.0], [2, 1, -2, 0, 0.000691, 0.0],
  [2, -1, 0, -2, 0.000596, 0.0], [4, 0, 1, 0, 0.000549, -1423.0], [0, 0, 4, 0, 0.000537, -1117.0],
  [4, -1, 0, 0, 0.000520, -1571.0], [1, 0, -2, 0, -0.000487, -1739.0], [2, 1, 0, -2, -0.000399, 0.0],
  [0, 0, 2, -2, -0.000381, -4421.0], [1, 1, 1, 0, 0.000351, 0.0], [3, 0, -2, 0, -0.000340, 0.0],
  [4, 0, -3, 0, 0.000330, 0.0], [2, -1, 2, 0, 0.000327, 0.0], [0, 2, 1, 0, -0.000323, 1165.0],
  [1, 1, -1, 0, 0.000299, 0.0], [2, 0, 3, 0, 0.000294, 0.0], [2, 0, -1, -2, 0.000000, 8752.0]
]
// [D, M, M', F, ΣB 正弦系数（度）]
const TB = [
  [0, 0, 0, 1, 5.128122], [0, 0, 1, 1, 0.280602], [0, 0, 1, -1, 0.277693], [2, 0, 0, -1, 0.173237],
  [2, 0, -1, 1, 0.055413], [2, 0, -1, -1, 0.046271], [2, 0, 0, 1, 0.032573], [0, 0, 2, 1, 0.017198],
  [2, 0, 1, -1, 0.009266], [0, 0, 2, -1, 0.008822], [2, -1, 0, -1, 0.008216], [2, 0, -2, -1, 0.004324],
  [2, 0, 1, 1, 0.004200], [2, 1, 0, -1, -0.003359], [2, -1, -1, 1, 0.002463], [2, -1, 0, 1, 0.002211],
  [2, -1, -1, -1, 0.002065], [0, 1, -1, -1, -0.001870], [4, 0, -1, -1, 0.001828], [0, 1, 0, 1, -0.001794],
  [0, 0, 0, 3, -0.001749], [0, 1, -1, 1, -0.001565], [1, 0, 0, 1, -0.001491], [0, 1, 1, 1, -0.001475],
  [0, 1, 1, -1, -0.001410], [0, 1, 0, -1, -0.001344], [1, 0, 0, -1, -0.001335], [0, 0, 3, 1, 0.001107],
  [4, 0, 0, -1, 0.001021], [4, 0, -1, 1, 0.000833], [0, 0, 1, -3, 0.000777], [4, 0, -2, 1, 0.000671],
  [2, 0, 0, -3, 0.000607], [2, 0, 2, -1, 0.000596], [2, -1, 1, -1, 0.000491], [2, 0, -2, 1, -0.000451],
  [0, 0, 3, -1, 0.000439], [2, 0, 2, 1, 0.000422], [2, 0, -3, -1, 0.000421], [2, 1, -1, 1, -0.000366],
  [2, 1, 0, 1, -0.000351], [4, 0, 0, 1, 0.000331], [2, -1, 1, 1, 0.000315], [2, -2, 0, -1, 0.000302],
  [0, 0, 1, 3, -0.000283], [2, 1, 1, -1, -0.000229], [1, 1, 0, -1, 0.000223], [1, 1, 0, 1, 0.000223],
  [0, 1, -2, -1, -0.000220], [2, 1, -1, -1, -0.000220], [1, 0, 1, 1, -0.000185], [2, -1, -2, -1, 0.000181],
  [0, 1, 2, 1, -0.000177], [4, 0, -2, -1, 0.000176], [4, -1, -1, -1, 0.000166], [1, 0, 1, -1, -0.000164],
  [4, 0, 1, -1, 0.000132], [1, 0, -1, -1, -0.000119], [4, -1, 0, -1, 0.000115], [2, -2, 0, 1, 0.000107]
]
const poly4 = (c0, c1, c2, c3, c4, t) => c0 + (c1 + (c2 + (c3 + c4 * t) * t) * t) * t
const fmod360 = (x) => x % 360

function moonGcrsAu(tdbDays) {
  const t = tdbDays / DJC
  // 基本角（度 → 弧度），系数与 ERFA moon98.c 逐数一致
  const elp = DD2R * fmod360(poly4(218.31665436, 481267.88123421, -0.0015786, 1.0 / 538841.0, -1.0 / 65194000.0, t))
  const d = DD2R * fmod360(poly4(297.8501921, 445267.1114034, -0.0018819, 1.0 / 545868.0, 1.0 / 113065000.0, t))
  const em = DD2R * fmod360(poly4(357.5291092, 35999.0502909, -0.0001536, 1.0 / 24490000.0, 0.0, t))
  const emp = DD2R * fmod360(poly4(134.9633964, 477198.8675055, 0.0087414, 1.0 / 69699.0, -1.0 / 14712000.0, t))
  const f = DD2R * fmod360(poly4(93.2720950, 483202.0175233, -0.0036539, 1.0 / 3526000.0, 1.0 / 863310000.0, t))
  const a1 = DD2R * (119.75 + 131.849 * t)
  const a2 = DD2R * (53.09 + 479264.290 * t)
  const a3 = DD2R * (313.45 + 481266.484 * t)
  const e = 1.0 + (-0.002516 + -0.0000074 * t) * t
  const esq = e * e
  // Meeus 附加项
  let vel = 0.003958 * Math.sin(a1) + 0.001962 * Math.sin(elp - f) + 0.000318 * Math.sin(a2)
  let vr = 0
  let vb = -0.002235 * Math.sin(elp) + 0.000382 * Math.sin(a3) + 0.000175 * Math.sin(a1 - f) +
    0.000175 * Math.sin(a1 + f) + 0.000127 * Math.sin(elp - emp) - 0.000115 * Math.sin(elp + emp)
  for (let n = TLR.length - 1; n >= 0; n--) {
    const r = TLR[n]
    const ai = Math.abs(r[1])
    const en = ai === 1 ? e : (ai === 2 ? esq : 1.0)
    const arg = r[0] * d + r[1] * em + r[2] * emp + r[3] * f
    vel += r[4] * Math.sin(arg) * en
    vr += r[5] * Math.cos(arg) * en
  }
  for (let n = TB.length - 1; n >= 0; n--) {
    const r = TB[n]
    const ai = Math.abs(r[1])
    const en = ai === 1 ? e : (ai === 2 ? esq : 1.0)
    const arg = r[0] * d + r[1] * em + r[2] * emp + r[3] * f
    vb += r[4] * Math.sin(arg) * en
  }
  const el = elp + DD2R * vel
  const rr = (vr + 385000560.0) / (AU_KM * 1000)
  const b = vb * DD2R
  // 黄道球坐标 → 直角（eraS2pv），再乘 IAU 2006 Fukushima–Williams 偏差 + 岁差（eraPfw06）：
  // rm = Rz(−γ̄)·Rx(−φ̄)·Rz(ψ̄)（ERFA 的 eraRz / eraRx 为坐标系旋转，与本平台 rot 同号）
  const cb = Math.cos(b)
  const p = [rr * cb * Math.cos(el), rr * cb * Math.sin(el), rr * Math.sin(b)]
  const gamb = poly5(-0.052928, 10.556378, 0.4932044, -0.00031238, -0.000002788, 0.0000000260, t) * DAS2R
  const phib = poly5(84381.412819, -46.811016, 0.0511268, 0.00053289, -0.000000440, -0.0000000176, t) * DAS2R
  const psib = poly5(-0.041775, 5038.481484, 1.5584175, -0.00018522, -0.000026452, -0.0000000148, t) * DAS2R
  const rm = ER.matMul(ER.rotZ(-gamb), ER.matMul(ER.rotX(-phib), ER.rotZ(psib)))
  return ER.mulMV(rm, p)
}
function poly5(c0, c1, c2, c3, c4, c5, t) { return c0 + (c1 + (c2 + (c3 + (c4 + c5 * t) * t) * t) * t) * t }

/* ===================== Chebyshev 分段 ===================== */
// 在 [a, b] 上取 n 个 Chebyshev 节点拟合（节点处精确），返回系数（每分量一组）
function chebFit(fn, a, b, n) {
  const mid = 0.5 * (a + b), half = 0.5 * (b - a)
  const vals = []
  for (let j = 0; j < n; j++) vals.push(fn(mid + half * Math.cos(Math.PI * (j + 0.5) / n)))
  const dim = vals[0].length
  const coef = []
  for (let c = 0; c < dim; c++) {
    const cc = new Float64Array(n)
    for (let k = 0; k < n; k++) {
      let s = 0
      for (let j = 0; j < n; j++) s += vals[j][c] * Math.cos(Math.PI * k * (j + 0.5) / n)
      cc[k] = 2 * s / n
    }
    cc[0] *= 0.5
    coef.push(cc)
  }
  return coef
}
// Clenshaw：x ∈ [−1, 1]
function chebEval(c, x) {
  let b1 = 0, b2 = 0
  const x2 = 2 * x
  for (let k = c.length - 1; k >= 1; k--) { const t = x2 * b1 - b2 + c[k]; b2 = b1; b1 = t }
  return x * b1 - b2 + c[0]
}

// 解析历表 + 分段 Chebyshev 缓存。fn(tdbDays) → [x,y,z] km（J2000）
function cachedSeries(fn, spanDays, ncoef) {
  const segs = new Map()
  return (tdb) => {
    const k = Math.floor(tdb / spanDays)
    let s = segs.get(k)
    if (!s) {
      if (segs.size > 2048) segs.clear()
      s = chebFit(fn, k * spanDays, (k + 1) * spanDays, ncoef)
      segs.set(k, s)
    }
    const x = 2 * (tdb - k * spanDays) / spanDays - 1
    return [chebEval(s[0], x), chebEval(s[1], x), chebEval(s[2], x)]
  }
}

const sunJ2000Km = (tdb) => { const p = frameBias(sunGcrsAu(tdb)); return [p[0] * AU_KM, p[1] * AU_KM, p[2] * AU_KM] }
const moonJ2000Km = (tdb) => { const p = frameBias(moonGcrsAu(tdb)); return [p[0] * AU_KM, p[1] * AU_KM, p[2] * AU_KM] }

function analyticEphemeris(opts) {
  const o = opts || {}
  if (o.cache === false) {
    return {
      kind: 'analytic',
      sun: (tMs) => sunJ2000Km(tdbDaysFromUtcMs(tMs)),
      moon: (tMs) => moonJ2000Km(tdbDaysFromUtcMs(tMs))
    }
  }
  const sun = cachedSeries(sunJ2000Km, 8, 14)
  const moon = cachedSeries(moonJ2000Km, 2, 14)
  return { kind: 'analytic', sun: (tMs) => sun(tdbDaysFromUtcMs(tMs)), moon: (tMs) => moon(tdbDaysFromUtcMs(tMs)) }
}

/* ===================== 表格星历（夹具 / 外部星历） ===================== */
// samples: [{ tMs, r:[x,y,z] }]，按时间升序；points 点 Lagrange（缺省 8），窗口居中，两端退化为单侧。
function lagrangeTable(samples, points) {
  const n = samples.length
  if (n < 2) throw new Error('表格星历至少 2 个样本')
  const tt = Float64Array.from(samples, (s) => s.tMs)
  const P = samples.map((s) => s.r)
  const np = Math.min(points || 8, n)
  return (tMs) => {
    if (tMs < tt[0] - 1 || tMs > tt[n - 1] + 1) throw new Error('表格星历越界：' + new Date(tMs).toISOString())
    let lo = 0, hi = n - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tt[mid] <= tMs) lo = mid; else hi = mid }
    let s = lo - Math.floor(np / 2) + 1
    s = Math.max(0, Math.min(n - np, s))
    const out = [0, 0, 0]
    for (let i = s; i < s + np; i++) {
      let w = 1
      for (let j = s; j < s + np; j++) if (j !== i) w *= (tMs - tt[j]) / (tt[i] - tt[j])
      out[0] += w * P[i][0]; out[1] += w * P[i][1]; out[2] += w * P[i][2]
    }
    return out
  }
}
function tabulatedEphemeris(tables, opts) {
  const o = opts || {}
  return { kind: 'tabulated', sun: lagrangeTable(tables.sun, o.points), moon: lagrangeTable(tables.moon, o.points) }
}

/* ===================== DE 式分段 Chebyshev（为 DE440 子集预留） ===================== */
// segs: [{ t0Days, spanDays, coef: [cx[], cy[], cz[]] }]，t0Days 为 J2000 起的 TDB 日，结果单位 km、J2000 地心。
function chebyshevSeries(segs) {
  const list = segs.slice().sort((a, b) => a.t0Days - b.t0Days)
  return (tdb) => {
    let lo = 0, hi = list.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (list[mid].t0Days <= tdb) lo = mid; else hi = mid - 1 }
    const s = list[lo]
    if (tdb < s.t0Days - 1e-9 || tdb > s.t0Days + s.spanDays + 1e-9) throw new Error('Chebyshev 星历越界：TDB 日 ' + tdb)
    const x = 2 * (tdb - s.t0Days) / s.spanDays - 1
    return [chebEval(s.coef[0], x), chebEval(s.coef[1], x), chebEval(s.coef[2], x)]
  }
}
function chebyshevEphemeris(spec) {
  const sun = chebyshevSeries(spec.sun), moon = chebyshevSeries(spec.moon)
  return { kind: 'chebyshev', sun: (tMs) => sun(tdbDaysFromUtcMs(tMs)), moon: (tMs) => moon(tdbDaysFromUtcMs(tMs)) }
}

module.exports = {
  analyticEphemeris, tabulatedEphemeris, chebyshevEphemeris,
  sunGcrsAu, moonGcrsAu, earthHelioBcrsAu, sunJ2000Km, moonJ2000Km,
  tdbDaysFromUtcMs, frameBias, FRAME_BIAS, chebFit, chebEval, AU_KM
}
