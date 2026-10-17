// 独立数值积分（RK4，300 s）：GEO + J2 + 日月点质量（Montenbruck & Gill §3.3.2 低精度日月历），
// 验证「近零倾角 GEO 的倾角矢量年漂移 ≈ 0.75–0.95°/年、与初始 RAAN 无关」——对照 SDP4 在 Ω0=0° 时只给 0.06°/年
// 另加光压（炮弹模型，A/m=0.02，C_R=1.5，柱形地影）看偏心率矢量年变化
const DEG = Math.PI / 180, AS = DEG / 3600
const MU = 398600.4418, RE = 6378.137, J2 = 1.08262668e-3
const MU_S = 1.32712440018e11, MU_M = 4902.800066
const EPS = 23.43929111 * DEG
const JD0 = 2461330.5   // 2026-10-17 00:00 UTC（≈TT，日月低精度足够）
function sunPos(jd) {
  const T = (jd - 2451545) / 36525
  const M = (357.5256 + 35999.049 * T) * DEG
  const lam = (282.94 * DEG) + M + (6892 * Math.sin(M) + 72 * Math.sin(2 * M)) * AS
  const r = (149.619 - 2.499 * Math.cos(M) - 0.021 * Math.cos(2 * M)) * 1e6
  const x = r * Math.cos(lam), y = r * Math.sin(lam)
  return [x, y * Math.cos(EPS), y * Math.sin(EPS)]
}
function moonPos(jd) {
  const T = (jd - 2451545) / 36525
  const L0 = (218.31617 + 481267.88088 * T - 1.3972 * T) * DEG
  const l = (134.96292 + 477198.86753 * T) * DEG, lp = (357.52543 + 35999.04944 * T) * DEG
  const F = (93.27283 + 483202.01873 * T) * DEG, D = (297.85027 + 445267.11135 * T) * DEG
  const lam = L0 + (22640 * Math.sin(l) + 769 * Math.sin(2 * l) - 4586 * Math.sin(l - 2 * D) + 2370 * Math.sin(2 * D) - 668 * Math.sin(lp) - 412 * Math.sin(2 * F) - 212 * Math.sin(2 * l - 2 * D) - 206 * Math.sin(l + lp - 2 * D) + 192 * Math.sin(l + 2 * D) - 165 * Math.sin(lp - 2 * D) + 148 * Math.sin(l - lp) - 125 * Math.sin(D) - 110 * Math.sin(l + lp) - 55 * Math.sin(2 * F - 2 * D)) * AS
  const b = (18520 * Math.sin(F + lam - L0 + (412 * Math.sin(2 * F) + 541 * Math.sin(lp)) * AS) - 526 * Math.sin(F - 2 * D) + 44 * Math.sin(l + F - 2 * D) - 31 * Math.sin(-l + F - 2 * D) - 25 * Math.sin(-2 * l + F) - 23 * Math.sin(lp + F - 2 * D) + 21 * Math.sin(-l + F) + 11 * Math.sin(-lp + F - 2 * D)) * AS
  const r = 385000 - 20905 * Math.cos(l) - 3699 * Math.cos(2 * D - l) - 2956 * Math.cos(2 * D) - 570 * Math.cos(2 * l) + 246 * Math.cos(2 * l - 2 * D) - 205 * Math.cos(lp - 2 * D) - 171 * Math.cos(l + 2 * D) - 152 * Math.cos(l + lp - 2 * D)
  const x = r * Math.cos(b) * Math.cos(lam), y = r * Math.cos(b) * Math.sin(lam), z = r * Math.sin(b)
  return [x, y * Math.cos(EPS) - z * Math.sin(EPS), y * Math.sin(EPS) + z * Math.cos(EPS)]
}
function third(r, s, mu) {
  const d = [s[0] - r[0], s[1] - r[1], s[2] - r[2]], dn = Math.hypot(...d), sn = Math.hypot(...s)
  return d.map((di, k) => mu * (di / dn ** 3 - s[k] / sn ** 3))
}
function acc(t, y, srp) {
  const r = [y[0], y[1], y[2]], rn = Math.hypot(...r)
  const a = r.map((x) => -MU * x / rn ** 3)
  const z2 = (r[2] / rn) ** 2, k = 1.5 * J2 * MU * RE * RE / rn ** 5
  a[0] += k * r[0] * (5 * z2 - 1); a[1] += k * r[1] * (5 * z2 - 1); a[2] += k * r[2] * (5 * z2 - 3)
  const jd = JD0 + t / 86400
  const S = sunPos(jd), M = moonPos(jd)
  const as = third(r, S, MU_S), am = third(r, M, MU_M)
  for (let i = 0; i < 3; i++) a[i] += as[i] + am[i]
  if (srp) {
    // 炮弹光压：P=4.56e-6 N/m² @1AU，A/m m²/kg，C_R；柱形地影
    const d = [r[0] - S[0], r[1] - S[1], r[2] - S[2]], dn = Math.hypot(...d)
    const sh = Math.hypot(...S), su = S.map((x) => x / sh)
    const proj = r[0] * su[0] + r[1] * su[1] + r[2] * su[2]
    const perp = Math.hypot(r[0] - proj * su[0], r[1] - proj * su[1], r[2] - proj * su[2])
    const lit = !(proj < 0 && perp < RE)
    if (lit) { const f = 4.56e-6 * srp.CR * srp.am * (1.496e8 / dn) ** 2 / 1000; for (let i = 0; i < 3; i++) a[i] += f * d[i] / dn }   // km/s²
  }
  return a
}
function rk4(t, y, h, srp) {
  const f = (tt, yy) => { const a = acc(tt, yy, srp); return [yy[3], yy[4], yy[5], a[0], a[1], a[2]] }
  const k1 = f(t, y), y2 = y.map((v, i) => v + h / 2 * k1[i])
  const k2 = f(t + h / 2, y2), y3 = y.map((v, i) => v + h / 2 * k2[i])
  const k3 = f(t + h / 2, y3), y4 = y.map((v, i) => v + h * k3[i])
  const k4 = f(t + h, y4)
  return y.map((v, i) => v + h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]))
}
function elemVec(y) {
  const r = y.slice(0, 3), v = y.slice(3)
  const h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]], hn = Math.hypot(...h)
  const hu = h.map((x) => x / hn), sinI = Math.hypot(hu[0], hu[1]), i = Math.atan2(sinI, hu[2]), fac = sinI > 1e-15 ? i / sinI : 1
  const rn = Math.hypot(...r), vv = v[0] ** 2 + v[1] ** 2 + v[2] ** 2, rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2]
  const e = r.map((x, k) => ((vv - MU / rn) * x - rv * v[k]) / MU)
  return { ix: -hu[1] * fac / DEG, iy: hu[0] * fac / DEG, ex: e[0], ey: e[1] }
}
function run(i0, O0, srp, days) {
  const r0 = 42164.2, v0 = Math.sqrt(MU / r0)
  const ci = Math.cos(i0 * DEG), si = Math.sin(i0 * DEG), cO = Math.cos(O0 * DEG), sO = Math.sin(O0 * DEG)
  // 升交点处起：r 沿交线，v 在轨道面内垂直
  let y = [r0 * cO, r0 * sO, 0, -v0 * sO * ci, v0 * cO * ci, v0 * si]
  const h = 300, N = Math.round(days * 86400 / h)
  const avg = (yy, t) => { // 一个恒星日平均
    let ix = 0, iy = 0, ex = 0, ey = 0, n = 0, z = yy.slice(), tt = t
    for (let k = 0; k < 288; k++) { const el = elemVec(z); ix += el.ix; iy += el.iy; ex += el.ex; ey += el.ey; n++; z = rk4(tt, z, 299.18, srp); tt += 299.18 }
    return { ix: ix / n, iy: iy / n, ex: ex / n, ey: ey / n }
  }
  const a0 = avg(y, 0)
  let t = 0
  for (let k = 0; k < N; k++) { y = rk4(t, y, h, srp); t += h }
  const a1 = avg(y, t)
  return { di: Math.hypot(a1.ix - a0.ix, a1.iy - a0.iy), dir: Math.atan2(a1.iy - a0.iy, a1.ix - a0.ix) / DEG, de: Math.hypot(a1.ex - a0.ex, a1.ey - a0.ey), e1: Math.hypot(a1.ex, a1.ey), e0: Math.hypot(a0.ex, a0.ey) }
}
const t0 = Date.now()
for (const i0 of [1, 4]) for (const O of [0, 90, 180, 270]) {
  const r = run(i0, O, null, 365.25)
  console.log('数值积分 i0=' + i0 + '° Ω0=' + O + '°：一年倾角矢量变化 ' + r.di.toFixed(3) + '° @' + r.dir.toFixed(0) + '°')
}
console.log('耗时 ' + (Date.now() - t0) + ' ms')
