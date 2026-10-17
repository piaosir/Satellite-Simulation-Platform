// 实验 1：轨道向导 / Walker 生成器的「开普勒平均运动直接当 SGP4 Kozai 平均运动」在 SGP4 下的实际漂移
// 只读仓库纯函数；输出数值到 stdout
const path = require('path')
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = require(path.join(ROOT, 'packages/core/vendor/satellite.js'))

const RE = 6378.137, MU = 398600.4418, J2 = 1.08262668e-3
const TWO_PI = 2 * Math.PI, DEG = Math.PI / 180
const SIDEREAL_DAY = 86164.0905, TROPICAL_YEAR = 365.2421897
const OMEGA_DOT_SS = TWO_PI / (TROPICAL_YEAR * 86400)

// 与 useCustomConstellations.elementsToSatrec 同式
function elementsToSatrec(el, epochIso) {
  const ecc = Math.max(0, Math.min(0.999, Number(el.ecc) || 0))
  const a = (RE + (Number(el.altKm) || 0)) / (1 - ecc)
  const n = Math.sqrt(MU / (a * a * a))
  const meanMotion = 86400 * n / TWO_PI
  return sat.omm2satrec({ noradId: 'SIM', epoch: epochIso, meanMotion, ecc, incl: el.incl, raan: el.raan, argp: el.argp || 0, ma: el.ma || 0, bstar: 0, mdot: 0, mddot: 0 })
}
function oscRaan(r, v) {
  const h = { x: r.y * v.z - r.z * v.y, y: r.z * v.x - r.x * v.z, z: r.x * v.y - r.y * v.x }
  return Math.atan2(h.x, -h.y)
}
const wrapPi = (a) => { let r = (a + Math.PI) % TWO_PI; if (r < 0) r += TWO_PI; return r - Math.PI }

const EPOCH = '2026-10-17T00:00:00.000Z'
const t0 = Date.parse(EPOCH)

// ---------- A. GEO：a = 42164.17（orbitDesign.geosyncSma / wgs84.RS_GEO）----------
{
  const aGeo = Math.cbrt(MU * (SIDEREAL_DAY / TWO_PI) ** 2)
  const rec = elementsToSatrec({ altKm: aGeo - RE, ecc: 0, incl: 0, raan: 0 }, EPOCH)
  // 星下点经度随时间
  const lonAt = (ms) => { const d = new Date(ms); const pv = sat.propagate(rec, d); const gd = sat.eciToGeodetic(pv.position, sat.gstime(d)); return gd.longitude / DEG }
  const lon0 = lonAt(t0)
  let acc = 0, prev = lon0
  const samples = []
  for (let d = 1; d <= 30; d++) {
    const L = lonAt(t0 + d * 86400e3)
    let dl = L - prev; while (dl > 180) dl -= 360; while (dl < -180) dl += 360
    acc += dl; prev = L
    if (d === 1 || d === 7 || d === 30) samples.push([d, acc])
  }
  console.log('A. GEO 向导 a=' + aGeo.toFixed(3) + ' km（开普勒 n=' + (86400 * Math.sqrt(MU / aGeo ** 3) / TWO_PI).toFixed(8) + ' rev/d 当 Kozai n 喂 SGP4）')
  samples.forEach(([d, v]) => console.log('   第 ' + d + ' 天经度漂移 ' + v.toFixed(4) + '°'))
  // 求 SGP4 下零漂移所需的 Kozai 平均运动
  function driftFor(nRevDay) {
    const r = sat.omm2satrec({ noradId: 'SIM', epoch: EPOCH, meanMotion: nRevDay, ecc: 0, incl: 0, raan: 0, argp: 0, ma: 0, bstar: 0, mdot: 0, mddot: 0 })
    const f = (ms) => { const d = new Date(ms); const pv = sat.propagate(r, d); return sat.eciToGeodetic(pv.position, sat.gstime(d)).longitude / DEG }
    let a = f(t0), b = f(t0 + 10 * 86400e3), dl = b - a; while (dl > 180) dl -= 360; while (dl < -180) dl += 360
    return dl / 10
  }
  let lo = 1.0025, hi = 1.0030
  for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (driftFor(m) > 0) hi = m; else lo = m }
  const nZero = (lo + hi) / 2
  const aZero = Math.cbrt(MU / (nZero * TWO_PI / 86400) ** 2)
  console.log('   SGP4 零漂移 Kozai n = ' + nZero.toFixed(8) + ' rev/d（对应开普勒 a = ' + aZero.toFixed(3) + ' km，与 42164.17 差 ' + (aZero - aGeo).toFixed(3) + ' km）')
}

// ---------- B. 太阳同步：J2 一阶式解 i，开普勒 n 喂 SGP4 ----------
for (const h of [500, 800]) {
  const a = RE + h
  const n = Math.sqrt(MU / a ** 3), p = a, k = RE / p
  const cosI = -OMEGA_DOT_SS / (1.5 * n * J2 * k * k)
  const incl = Math.acos(cosI) / DEG
  const rec = elementsToSatrec({ altKm: h, ecc: 0, incl, raan: 0 }, EPOCH)
  // 一年内按 1 天采样，取每天附近一圈的平均 RAAN（16 点平均）
  const T = TWO_PI / rec.no * 60 * 1000  // ms
  const meanRaanAt = (ms) => {
    let sx = 0, sy = 0
    for (let j = 0; j < 32; j++) { const d = new Date(ms + j * T / 32); const pv = sat.propagate(rec, d); const O = oscRaan(pv.position, pv.velocity); sx += Math.cos(O); sy += Math.sin(O) }
    return Math.atan2(sy, sx)
  }
  const O0 = meanRaanAt(t0)
  const O365 = meanRaanAt(t0 + 365.2421897 * 86400e3)
  // 一年后应恰好转 360°（相对惯性）：残差 = 实际 − 2π
  // 用 30 天斜率估计速率更稳
  const O30 = meanRaanAt(t0 + 30 * 86400e3)
  const rate30 = wrapPi(O30 - O0) / 30 / DEG   // °/day
  const req = OMEGA_DOT_SS * 86400 / DEG
  const err = rate30 - req
  console.log('B. SSO ' + h + ' km, i=' + incl.toFixed(4) + '°：SGP4 实际 Ω̇ = ' + rate30.toFixed(5) + ' °/d，要求 ' + req.toFixed(5) + ' °/d，差 ' + err.toFixed(5) + ' °/d（' + (err / req * 100).toFixed(2) + '%）→ 一年 LTAN 漂 ' + (err * 365.25 * 4).toFixed(1) + ' min')
  // 一年后直接比较（取模）
  const d1y = wrapPi(O365 - O0) / DEG
  console.log('   一年后 RAAN 残差（应为 0）：' + d1y.toFixed(3) + '° = LTAN ' + (d1y * 4).toFixed(1) + ' min')
}

// ---------- C. 回归轨道 233/16（Landsat-8 型）：J2 设计解 a，开普勒 n 喂 SGP4 ----------
{
  const OMEGA_E = 7.2921159e-5, SOLAR_DAY = 86400
  const k = 233, m = 16
  const maRate = (a, i) => { const n = Math.sqrt(MU / a ** 3), kk = RE / a, c = Math.cos(i * DEG); return n * (1 + 0.75 * J2 * kk * kk * (3 * c * c - 1)) }
  const argpRate = (a, i) => { const n = Math.sqrt(MU / a ** 3), kk = RE / a, c = Math.cos(i * DEG); return 0.75 * n * J2 * kk * kk * (5 * c * c - 1) }
  const raanRate = (a, i) => { const n = Math.sqrt(MU / a ** 3), kk = RE / a; return -1.5 * n * J2 * kk * kk * Math.cos(i * DEG) }
  const sso = (a) => { const n = Math.sqrt(MU / a ** 3), kk = RE / a; return Math.acos(-OMEGA_DOT_SS / (1.5 * n * J2 * kk * kk)) / DEG }
  // repeatSunSync: T_Omega = m*SOLAR_DAY/k
  const tOmega = m * SOLAR_DAY / k
  let a = Math.cbrt(MU * (tOmega / TWO_PI) ** 2), incl = sso(a)
  for (let it = 0; it < 80; it++) {
    // 解 nodal period = tOmega
    let lo = a * 0.9, hi = a * 1.1
    for (let j = 0; j < 80; j++) { const mid = (lo + hi) / 2; const Tn = TWO_PI / (maRate(mid, incl) + argpRate(mid, incl)); if (Tn > tOmega) hi = mid; else lo = mid }
    const na = (lo + hi) / 2; incl = sso(na); if (Math.abs(na - a) < 1e-6) { a = na; break } a = na
  }
  const rec = elementsToSatrec({ altKm: a - RE, ecc: 0, incl, raan: 0 }, EPOCH)
  // 找升交点（z 由负转正）: 第一次与 16 天后对应那一次的星下点经度
  const posAt = (ms) => sat.propagate(rec, new Date(ms)).position
  function nextAN(ms) {
    let prevZ = posAt(ms).z, t = ms
    for (;;) { const t2 = t + 20e3; const z = posAt(t2).z; if (prevZ < 0 && z >= 0) { let lo = t, hi = t2; for (let j = 0; j < 50; j++) { const mid = (lo + hi) / 2; if (posAt(mid).z < 0) lo = mid; else hi = mid } return (lo + hi) / 2 } prevZ = z; t = t2 }
  }
  const lonOf = (ms) => { const d = new Date(ms); return sat.eciToGeodetic(sat.propagate(rec, d).position, sat.gstime(d)).longitude / DEG }
  const an0 = nextAN(t0)
  // 推进 k 圈：每次从上次升交点 + 半圈起找
  let an = an0
  const Tnod = tOmega * 1000
  for (let r = 0; r < k; r++) an = nextAN(an + Tnod * 0.5)
  let dl = lonOf(an) - lonOf(an0); while (dl > 180) dl -= 360; while (dl < -180) dl += 360
  console.log('C. 回归·太阳同步 233/16：设计 a=' + a.toFixed(3) + ' km（h=' + (a - RE).toFixed(1) + ' km）i=' + incl.toFixed(4) + '°')
  console.log('   SGP4 推 233 圈后升交点经度偏 ' + dl.toFixed(4) + '°（赤道上 ' + (dl * DEG * RE).toFixed(1) + ' km），用时 ' + ((an - an0) / 86400e3).toFixed(4) + ' d（应 16 d）')
}
