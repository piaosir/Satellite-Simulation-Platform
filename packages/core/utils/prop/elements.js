// 轨道根数 ↔ 位置速度（二体，纯 CommonJS），以及 GEO 运管常用的倾角矢量 / 偏心率矢量。
//
// coe2rv(mu, { a, e, i, raan, argp, nu }) → { r:[3], v:[3] }        （角度弧度，a km，mu km³/s²）
// rv2coe(mu, r, v) → { a, e, i, raan, argp, nu, M, p, h:[3] }      （Vallado 4th ed. 算法 9；奇异处按圆 / 赤道轨道约定取 0）
// inclinationVector(r, v) → [ix, iy]（弧度）：GEO 位保惯例 ix = i·cos Ω，iy = i·sin Ω（Soop《Handbook of
//   Geostationary Orbits》§3.3）。直接由角动量方向算，i → 0 时连续、无奇点。
// eccentricityVector(mu, r, v) → [ex, ey, ez]

'use strict'

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a) => Math.sqrt(dot(a, a))
const TWO_PI = 2 * Math.PI
const wrap2pi = (x) => { const r = x % TWO_PI; return r < 0 ? r + TWO_PI : r }

function coe2rv(mu, el) {
  const { a, e, i, raan, argp, nu } = el
  const p = a * (1 - e * e)
  const rr = p / (1 + e * Math.cos(nu))
  const xp = rr * Math.cos(nu), yp = rr * Math.sin(nu)
  const sq = Math.sqrt(mu / p)
  const vxp = -sq * Math.sin(nu), vyp = sq * (e + Math.cos(nu))
  const cO = Math.cos(raan), sO = Math.sin(raan), cw = Math.cos(argp), sw = Math.sin(argp), ci = Math.cos(i), si = Math.sin(i)
  const R11 = cO * cw - sO * sw * ci, R12 = -cO * sw - sO * cw * ci
  const R21 = sO * cw + cO * sw * ci, R22 = -sO * sw + cO * cw * ci
  const R31 = sw * si, R32 = cw * si
  return {
    r: [R11 * xp + R12 * yp, R21 * xp + R22 * yp, R31 * xp + R32 * yp],
    v: [R11 * vxp + R12 * vyp, R21 * vxp + R22 * vyp, R31 * vxp + R32 * vyp]
  }
}

function eccentricityVector(mu, r, v) {
  const rn = norm(r), v2 = dot(v, v), rv = dot(r, v)
  return [((v2 - mu / rn) * r[0] - rv * v[0]) / mu, ((v2 - mu / rn) * r[1] - rv * v[1]) / mu, ((v2 - mu / rn) * r[2] - rv * v[2]) / mu]
}

function rv2coe(mu, r, v) {
  const h = cross(r, v), hn = norm(h)
  const nvec = [-h[1], h[0], 0], nn = norm(nvec)
  const ev = eccentricityVector(mu, r, v), e = norm(ev)
  const rn = norm(r)
  const energy = dot(v, v) / 2 - mu / rn
  const a = -mu / (2 * energy)
  const p = hn * hn / mu
  const i = Math.acos(Math.max(-1, Math.min(1, h[2] / hn)))
  const raan = nn > 1e-12 * hn ? wrap2pi(Math.atan2(nvec[1], nvec[0])) : 0
  let argp = 0, nu
  if (e > 1e-12) {
    if (nn > 1e-12 * hn) {
      argp = Math.acos(Math.max(-1, Math.min(1, dot(nvec, ev) / (nn * e))))
      if (ev[2] < 0) argp = TWO_PI - argp
    } else {
      argp = wrap2pi(Math.atan2(ev[1], ev[0]) * (h[2] >= 0 ? 1 : -1))
    }
    nu = Math.acos(Math.max(-1, Math.min(1, dot(ev, r) / (e * rn))))
    if (dot(r, v) < 0) nu = TWO_PI - nu
  } else if (nn > 1e-12 * hn) {
    nu = Math.acos(Math.max(-1, Math.min(1, dot(nvec, r) / (nn * rn))))
    if (r[2] < 0) nu = TWO_PI - nu
  } else {
    nu = wrap2pi(Math.atan2(r[1], r[0]) * (h[2] >= 0 ? 1 : -1))
  }
  let M = nu
  if (e < 1) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2))
    M = wrap2pi(E - e * Math.sin(E))
  }
  return { a, e, i, raan, argp, nu, M, p, h }
}

// 倾角矢量（弧度）：轨道面法向 ĥ = (sin i sin Ω, −sin i cos Ω, cos i)，
//   ix = i·cos Ω = i·(−ĥ_y / sin i)，iy = i·sin Ω = i·(ĥ_x / sin i)；i/sin i 在 i → 0 时取 1，无奇点。
function inclinationVector(r, v) {
  const h = cross(r, v), hn = norm(h)
  const hx = h[0] / hn, hy = h[1] / hn, hz = h[2] / hn
  const si = Math.hypot(hx, hy)
  const i = Math.atan2(si, hz)
  const k = si > 1e-15 ? i / si : 1
  return [-hy * k, hx * k]
}

module.exports = { coe2rv, rv2coe, eccentricityVector, inclinationVector }
