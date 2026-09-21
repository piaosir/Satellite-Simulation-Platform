// 轨道向导求解器（仿 STK Orbit Wizard）：九种轨道类型 -> 经典六根数。
//
// 纯函数、零依赖（gstime 由调用方注入）：给一组「设计意图」（高度 / 地方时 / 回归圈数 / 星下点经度…），
// 解出 a / e / i / Ω / ω / M₀，再交给既有的 generateConstellation 铺开成星座。
// generateConstellation 一个字不改 —— 向导只是换了一种【输入】方式。
//
// 【摄动口径】全部用 J2 一阶长期项（附录 E），与 SATSOFT / STK 的向导同一套：
//   n = sqrt(mu/a³)，p = a(1−e²)
//   Omega_dot = −(3/2)·n·J2·(Re/p)²·cos i
//   argp_dot  =  (3/4)·n·J2·(Re/p)²·(5cos²i − 1)
//   M_dot     =  n·[1 + (3/4)·J2·(Re/p)²·sqrt(1−e²)·(3cos²i − 1)]
//   交点周期 T_Omega = 2π/(M_dot + argp_dot)
// 这是【设计用】的口径：解出来的根数随后一律交给 SGP4 传播，两者的 J2 处理略有出入，
// 故读数里的 Omega_dot 与「SGP4 传播一圈后由相邻升交点反推」的值会差百分之几（测试按 5% 判）。
//
// 【地方时一律平太阳时】LTAN / LTDN 用太阳【平黄经】L0（Meeus 25.2 的一次式），
// 与视太阳相差时差方程（≤16 min）。界面 title 里写明了这一条。

const RE = 6378.137              // km
const MU = 398600.4418           // km³/s²
const J2 = 1.08262668e-3
const OMEGA_E = 7.2921159e-5     // rad/s
const SIDEREAL_DAY = 86164.0905  // s
const SOLAR_DAY = 86400          // s
const TROPICAL_YEAR = 365.2421897 // d
// 太阳同步要求的节点进动率：一个回归年转 360°
const OMEGA_DOT_SS = 2 * Math.PI / (TROPICAL_YEAR * SOLAR_DAY)   // rad/s ≈ 1.99096871e-7
const CRIT_PRO = 63.4349         // 临界倾角（顺行）
const CRIT_RETRO = 116.5651      // 临界倾角（逆行）
const GEO_A = 42164.17           // km（地球同步半长轴，见 geosyncSma）

const DEG = Math.PI / 180
const RAD = 180 / Math.PI
const TWO_PI = Math.PI * 2
const norm360 = (x) => ((x % 360) + 360) % 360
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

/* ===================== 基本摄动量 ===================== */
export const meanMotion = (aKm) => Math.sqrt(MU / (aKm * aKm * aKm))            // rad/s
export const semiLatus = (aKm, e) => aKm * (1 - e * e)
export function raanRate(aKm, e, inclDeg) {                                      // rad/s
  const n = meanMotion(aKm), p = semiLatus(aKm, e), k = RE / p
  return -1.5 * n * J2 * k * k * Math.cos(inclDeg * DEG)
}
export function argpRate(aKm, e, inclDeg) {                                      // rad/s
  const n = meanMotion(aKm), p = semiLatus(aKm, e), k = RE / p, c = Math.cos(inclDeg * DEG)
  return 0.75 * n * J2 * k * k * (5 * c * c - 1)
}
export function maRate(aKm, e, inclDeg) {                                        // rad/s
  const n = meanMotion(aKm), p = semiLatus(aKm, e), k = RE / p, c = Math.cos(inclDeg * DEG)
  return n * (1 + 0.75 * J2 * k * k * Math.sqrt(1 - e * e) * (3 * c * c - 1))
}
// 交点周期（s）：相邻两次过升交点的间隔
export function nodalPeriodSec(aKm, e, inclDeg) {
  const d = maRate(aKm, e, inclDeg) + argpRate(aKm, e, inclDeg)
  return d > 0 ? TWO_PI / d : NaN
}
export const keplerPeriodSec = (aKm) => TWO_PI * Math.sqrt(aKm * aKm * aKm / MU)
// 地球同步：交点周期 = 一个恒星日（圆赤道轨道时退化为开普勒周期）
export function geosyncSma() {
  return Math.cbrt(MU * (SIDEREAL_DAY / TWO_PI) * (SIDEREAL_DAY / TWO_PI))
}

/* ===================== 有界求根（Newton 失败退二分） ===================== */
// f 在 [lo,hi] 上变号；返回根或 NaN。迭代上限 60、收敛 1e-9（相对）。
export function solveRoot(f, lo, hi, opts) {
  const o = opts || {}
  const tol = o.tol || 1e-9
  let flo = f(lo), fhi = f(hi)
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) return NaN
  if (flo === 0) return lo
  if (fhi === 0) return hi
  if (flo * fhi > 0) return NaN
  let a = lo, b = hi, fa = flo, fb = fhi
  let x = o.guess != null && o.guess > lo && o.guess < hi ? o.guess : (lo + hi) / 2
  for (let it = 0; it < 60; it++) {
    const fx = f(x)
    if (!Number.isFinite(fx)) { x = (a + b) / 2; continue }
    if (Math.abs(fx) < tol * Math.max(1, Math.abs(fx))) { /* 继续用区间判据收敛 */ }
    if (fa * fx <= 0) { b = x; fb = fx } else { a = x; fa = fx }
    // 割线（有界 Newton 的等价物，免得逐项求导）；出界或不动就退二分
    let nx = fb !== fa ? x - fx * (b - a) / (fb - fa) : (a + b) / 2
    if (!(nx > a && nx < b)) nx = (a + b) / 2
    if (Math.abs(nx - x) <= tol * Math.max(1e-12, Math.abs(x))) return nx
    x = nx
    if (b - a <= tol * Math.max(1e-12, Math.abs(x))) return x
  }
  return x
}

/* ===================== 太阳同步 ===================== */
// 给 a 与 e，解出太阳同步倾角（°）；无解（|cos i| > 1）返回 NaN
export function sunSyncInclination(aKm, e) {
  const n = meanMotion(aKm), p = semiLatus(aKm, e), k = RE / p
  // Omega_dot_ss = −(3/2)·n·J2·(Re/p)²·cos i  =>  cos i = −Omega_dot_ss / ((3/2)·n·J2·(Re/p)²)
  const cosI = -OMEGA_DOT_SS / (1.5 * n * J2 * k * k)
  if (!(Math.abs(cosI) <= 1)) return NaN
  return Math.acos(cosI) * RAD
}
// 给倾角与 e，解出太阳同步半长轴（km）。附录 E：a = [−(3/2)·J2·Re²·sqrt(mu)·cos i / ((1−e²)²·Omega_dot_ss)]^{2/7}
export function sunSyncSma(inclDeg, e) {
  const c = Math.cos(inclDeg * DEG)
  const v = -1.5 * J2 * RE * RE * Math.sqrt(MU) * c / (Math.pow(1 - e * e, 2) * OMEGA_DOT_SS)
  if (!(v > 0)) return NaN
  return Math.pow(v, 2 / 7)
}
// 圆轨道太阳同步的高度上限：cos i = −1 时的 a
export function sunSyncMaxAltKm() { return sunSyncSma(180, 0) - RE }

/* ===================== 回归轨道 ===================== */
// k 圈回归 m 天：k·T_Omega(a) = m·2π/(omega_e − Omega_dot(a))
export function repeatSma(inclDeg, k, m, e) {
  const ecc = num(e, 0)
  const f = (a) => k * nodalPeriodSec(a, ecc, inclDeg) - m * TWO_PI / (OMEGA_E - raanRate(a, ecc, inclDeg))
  // 初值：无摄动的 a（附录 E）
  const a0 = Math.cbrt(MU * Math.pow(m * SIDEREAL_DAY / k, 2) / (4 * Math.PI * Math.PI))
  const lo = Math.max(RE + 80, a0 * 0.8), hi = a0 * 1.25
  const a = solveRoot(f, lo, hi, { guess: a0 })
  return Number.isFinite(a) ? a : NaN
}
// 回归 + 太阳同步：T_Omega = m·86400/k 精确；a 与 i 联立（定点迭代至 |Δa| < 1 m）
export function repeatSunSyncSolve(k, m, e) {
  const ecc = num(e, 0)
  const tOmega = m * SOLAR_DAY / k
  let a = Math.cbrt(MU * (tOmega / TWO_PI) * (tOmega / TWO_PI))    // 无摄动初值
  let incl = sunSyncInclination(a, ecc)
  if (!Number.isFinite(incl)) return { ok: false, reason: '该回归比下无太阳同步解' }
  for (let it = 0; it < 60; it++) {
    // 给定 i，由 T_Omega 反解 a（含 J2）
    const f = (x) => nodalPeriodSec(x, ecc, incl) - tOmega
    const na = solveRoot(f, Math.max(RE + 80, a * 0.7), a * 1.4, { guess: a })
    if (!Number.isFinite(na)) return { ok: false, reason: '交点周期反解半长轴失败' }
    const ni = sunSyncInclination(na, ecc)
    if (!Number.isFinite(ni)) return { ok: false, reason: '该高度下无太阳同步解（高度超上限）' }
    const da = Math.abs(na - a)
    a = na; incl = ni
    if (da < 1e-3) break      // 1 m
  }
  return { ok: true, aKm: a, inclDeg: incl, tOmegaSec: tOmega }
}

/* ===================== 平太阳与地方时 ===================== */
// 太阳平黄经 L0（°）：Meeus 25.2 的一次式，T 为 J2000 起的儒略世纪数
export function meanSunLongitudeDeg(ms) {
  const jd = 2440587.5 + ms / 86400000
  const T = (jd - 2451545) / 36525
  return norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T)
}
// 升交点地方时（h）-> RAAN（°）
export function ltanToRaan(ltanHours, ms) {
  return norm360(meanSunLongitudeDeg(ms) + (num(ltanHours) - 12) * 15)
}
// 降交点地方时（h）-> RAAN（°）：比升交点多转半圈
export function ltdnToRaan(ltdnHours, ms) {
  return norm360(ltanToRaan(ltdnHours, ms) + 180)
}
// RAAN（°）-> 升交点地方时（h）
export function raanToLtan(raanDeg, ms) {
  const h = (norm360(raanDeg) - meanSunLongitudeDeg(ms)) / 15 + 12
  return ((h % 24) + 24) % 24
}
export const ltanToLtdn = (h) => ((num(h) + 12) % 24 + 24) % 24
// 'hh:mm' <-> 小时
export function parseHm(s) {
  const m = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/.exec(String(s == null ? '' : s))
  if (!m) { const v = Number(s); return Number.isFinite(v) && v >= 0 && v < 24 ? v : NaN }
  const h = +m[1], mi = +m[2]
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return NaN
  return h + mi / 60
}
export function formatHm(h) {
  if (!Number.isFinite(h)) return '—'
  let v = ((h % 24) + 24) % 24
  let hh = Math.floor(v), mm = Math.round((v - hh) * 60)
  if (mm === 60) { mm = 0; hh = (hh + 1) % 24 }
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0')
}

/* ===================== 经度 -> RAAN ===================== */
// 升交点（或圆赤道轨道的星下点）经度 lambda 在 t0 时对应的 RAAN：Omega = lambda + GMST(t0)
export const lonToRaan = (lonDeg, gmstRad) => norm360(num(lonDeg) + gmstRad * RAD)
export const raanToLon = (raanDeg, gmstRad) => {
  const v = norm360(num(raanDeg) - gmstRad * RAD)
  return v > 180 ? v - 360 : v
}

/* ===================== 九种类型 ===================== */
export const ORBIT_TYPES = [
  { key: 'circular', zh: '圆轨道', en: 'Circular' },
  { key: 'critical', zh: '临界倾角', en: 'Critically Inclined' },
  { key: 'criticalSunSync', zh: '临界倾角·太阳同步', en: 'Critically Inclined, Sun Sync' },
  { key: 'geosync', zh: '地球同步', en: 'Geosynchronous' },
  { key: 'molniya', zh: 'Molniya', en: 'Molniya' },
  { key: 'repeat', zh: '回归轨道', en: 'Repeating Ground Trace' },
  { key: 'repeatSunSync', zh: '回归·太阳同步', en: 'Repeating Sun Sync' },
  { key: 'sunSync', zh: '太阳同步', en: 'Sun Synchronous' },
  { key: 'custom', zh: '自定义根数', en: 'Orbit Designer' }
]
export const ORBIT_TYPE_KEYS = ORBIT_TYPES.map((t) => t.key)

// 每种类型的缺省输入（界面初值）
export function defaultInputs(type) {
  switch (type) {
    case 'circular': return { inclDeg: 53, altKm: 550, raanDeg: 0 }
    case 'critical': return { direction: 'pro', apogeeKm: 39870, perigeeKm: 500, anLonDeg: 0, argpDeg: 270 }
    case 'criticalSunSync': return { perigeeKm: 500, anLonDeg: 0, argpDeg: 270 }
    case 'geosync': return { subLonDeg: 110.5, inclDeg: 0 }
    case 'molniya': return { apogeeLonDeg: 100, perigeeKm: 500, argpDeg: 270 }
    case 'repeat': return { inclDeg: 98.2, k: 233, m: 16, approxAltKm: null, anLonDeg: 0 }
    case 'repeatSunSync': return { k: 233, m: 16, anLonDeg: 0, localTime: '10:00', localMode: 'ltdn' }
    case 'sunSync': return { driver: 'alt', altKm: 800, inclDeg: 98.6, localTime: '10:30', localMode: 'ltan' }
    default: return {}
  }
}

// 由 a / e 得近远地点高度
const heights = (aKm, e) => ({ perigeeKm: aKm * (1 - e) - RE, apogeeKm: aKm * (1 + e) - RE })
// 由近远地点高度得 a / e
function fromHeights(hp, ha) {
  const rp = RE + hp, ra = RE + Math.max(hp, ha)
  return { aKm: (rp + ra) / 2, e: ra + rp > 0 ? (ra - rp) / (ra + rp) : 0 }
}

/**
 * 求解一种轨道类型。
 * @param {string} type      ORBIT_TYPE_KEYS 之一
 * @param {object} inputs    该类型的输入（见 defaultInputs）
 * @param {number} t0Ms      场景历元（UTC 毫秒）
 * @param {object} ctx       { gmst: t0 时刻的 GMST（rad） }
 * @returns { ok, errs, warns, seed:{aKm,e,inclDeg,raanDeg,argpDeg,m0Deg}, derived:{…} }
 */
export function solveDesign(type, inputs, t0Ms, ctx) {
  const errs = [], warns = []
  const inp = inputs || {}
  const gmst = ctx && Number.isFinite(ctx.gmst) ? ctx.gmst : 0
  const bad = (msg, field) => { errs.push(field ? { field, msg } : { field: '', msg }); return null }

  let aKm = NaN, e = 0, inclDeg = 0, raanDeg = 0, argpDeg = 0, m0Deg = 0
  let repeat = null, ltanHours = null

  switch (type) {
    case 'circular': {
      inclDeg = num(inp.inclDeg)
      const h = num(inp.altKm, NaN)
      if (!(h > 0)) bad('高度需 > 0 km', 'altKm')
      if (!(inclDeg >= 0 && inclDeg <= 180)) bad('倾角需在 0…180°', 'inclDeg')
      aKm = RE + h; e = 0; argpDeg = 0; m0Deg = 0
      raanDeg = norm360(num(inp.raanDeg))
      break
    }
    case 'critical': {
      inclDeg = inp.direction === 'retro' ? CRIT_RETRO : CRIT_PRO
      const hp = num(inp.perigeeKm, NaN), ha = num(inp.apogeeKm, NaN)
      if (!(hp > 0)) bad('近地点高度需 > 0 km', 'perigeeKm')
      if (!(ha >= hp)) bad('远地点高度需 ≥ 近地点高度', 'apogeeKm')
      const s = fromHeights(hp, ha)
      aKm = s.aKm; e = s.e
      argpDeg = norm360(num(inp.argpDeg, 270))
      raanDeg = lonToRaan(num(inp.anLonDeg), gmst)
      m0Deg = 0
      break
    }
    case 'criticalSunSync': {
      // 顺行的临界倾角（63.43°）cos i > 0，节点【西退】，与太阳同步要的东进方向相反 —— 无解。
      // 故这一类只能取逆行的 116.5651°（界面 title 里写明了）。
      inclDeg = CRIT_RETRO
      const hp = num(inp.perigeeKm, NaN)
      if (!(hp > 0)) bad('近地点高度需 > 0 km', 'perigeeKm')
      else {
        // 固定 hp 与 i，解 e 使 Omega_dot = Omega_dot_ss。rp 固定 => a = rp/(1−e)
        const rp = RE + hp
        const f = (ecc) => raanRate(rp / (1 - ecc), ecc, inclDeg) - OMEGA_DOT_SS
        const ecc = solveRoot(f, 1e-6, 0.95, { guess: 0.3 })
        if (!Number.isFinite(ecc)) bad('该近地点高度下解不出太阳同步的偏心率', 'perigeeKm')
        else { e = ecc; aKm = rp / (1 - ecc) }
      }
      argpDeg = norm360(num(inp.argpDeg, 270))
      raanDeg = lonToRaan(num(inp.anLonDeg), gmst)
      m0Deg = 0
      break
    }
    case 'geosync': {
      aKm = geosyncSma(); e = 0; argpDeg = 0; m0Deg = 0
      inclDeg = num(inp.inclDeg, 0)
      if (!(inclDeg >= 0 && inclDeg <= 180)) bad('倾角需在 0…180°', 'inclDeg')
      // 圆轨道：星下点经度 lambda = (RAAN + argp + M0) − GMST，argp = M0 = 0 => RAAN = lambda + GMST
      raanDeg = lonToRaan(num(inp.subLonDeg), gmst)
      break
    }
    case 'molniya': {
      inclDeg = CRIT_PRO
      const hp = num(inp.perigeeKm, NaN)
      if (!(hp > 0)) bad('近地点高度需 > 0 km', 'perigeeKm')
      // T = 半个恒星日 -> a（附录 E 的口径是【开普勒】关系，不含 J2：
      // a = (mu·(T/2π)²)^{1/3} = 26561.76 km，与它给的 e=0.741、远地点 39870 km 三者自洽。
      // 若改用交点周期（含 J2）会得到 26560.67 km，与那三个数就对不上了。）
      const half = SIDEREAL_DAY / 2
      const rp = RE + hp
      aKm = Math.cbrt(MU * (half / TWO_PI) * (half / TWO_PI))
      e = Math.max(0, 1 - rp / aKm)
      if (!(e < 1)) bad('近地点高度过高，构不成 Molniya 椭圆', 'perigeeKm')
      argpDeg = norm360(num(inp.argpDeg, 270))
      m0Deg = 180            // t0 落在远地点
      // 远地点经度 lambda_a：u = argp + 180°，Omega = lambda_a + GMST(t0) − atan2(sin u·cos i, cos u)
      const u = (argpDeg + 180) * DEG
      const dl = Math.atan2(Math.sin(u) * Math.cos(inclDeg * DEG), Math.cos(u)) * RAD
      raanDeg = norm360(num(inp.apogeeLonDeg) + gmst * RAD - dl)
      break
    }
    case 'repeat': {
      inclDeg = num(inp.inclDeg)
      const k = Math.round(num(inp.k)), m = Math.round(num(inp.m))
      if (!(k >= 1)) bad('回归圈数 k 需 ≥ 1', 'k')
      if (!(m >= 1)) bad('回归天数 m 需 ≥ 1', 'm')
      if (!(inclDeg >= 0 && inclDeg <= 180)) bad('倾角需在 0…180°', 'inclDeg')
      if (k >= 1 && m >= 1 && gcd(k, m) !== 1) warns.push('k=' + k + ' 与 m=' + m + ' 不互质，实际回归比是 ' + (k / gcd(k, m)) + '/' + (m / gcd(k, m)))
      if (!errs.length) {
        aKm = repeatSma(inclDeg, k, m, 0)
        if (!Number.isFinite(aKm)) bad('该倾角与回归比下解不出半长轴', 'k')
        else if (aKm - RE < 80) bad('解出的高度低于 80 km（回归比不合理）', 'k')
      }
      e = 0; argpDeg = 0; m0Deg = 0
      raanDeg = lonToRaan(num(inp.anLonDeg), gmst)
      repeat = { k, m }
      break
    }
    case 'repeatSunSync': {
      const k = Math.round(num(inp.k)), m = Math.round(num(inp.m))
      if (!(k >= 1)) bad('回归圈数 k 需 ≥ 1', 'k')
      if (!(m >= 1)) bad('回归天数 m 需 ≥ 1', 'm')
      if (k >= 1 && m >= 1 && gcd(k, m) !== 1) warns.push('k=' + k + ' 与 m=' + m + ' 不互质，实际回归比是 ' + (k / gcd(k, m)) + '/' + (m / gcd(k, m)))
      if (!errs.length) {
        const r = repeatSunSyncSolve(k, m, 0)
        if (!r.ok) bad(r.reason, 'k')
        else { aKm = r.aKm; inclDeg = r.inclDeg }
      }
      e = 0; argpDeg = 0; m0Deg = 0
      const lt = parseHm(inp.localTime)
      if (!Number.isFinite(lt)) bad('地方时格式应为 hh:mm', 'localTime')
      else {
        raanDeg = inp.localMode === 'ltdn' ? ltdnToRaan(lt, t0Ms) : ltanToRaan(lt, t0Ms)
      }
      repeat = { k, m }
      break
    }
    case 'sunSync': {
      e = 0; argpDeg = 0; m0Deg = 0
      if (inp.driver === 'incl') {
        inclDeg = num(inp.inclDeg, NaN)
        if (!(inclDeg > 90 && inclDeg <= 180)) bad('太阳同步倾角需 > 90°（节点要东进）', 'inclDeg')
        else {
          aKm = sunSyncSma(inclDeg, 0)
          if (!Number.isFinite(aKm)) bad('该倾角下解不出太阳同步半长轴', 'inclDeg')
          else if (aKm - RE < 80) bad('解出的高度低于 80 km', 'inclDeg')
        }
      } else {
        const h = num(inp.altKm, NaN)
        if (!(h > 0)) bad('高度需 > 0 km', 'altKm')
        else {
          aKm = RE + h
          inclDeg = sunSyncInclination(aKm, 0)
          if (!Number.isFinite(inclDeg)) bad('太阳同步倾角无解：高度超上限（约 ' + Math.round(sunSyncMaxAltKm()) + ' km）', 'altKm')
        }
      }
      const lt = parseHm(inp.localTime)
      if (!Number.isFinite(lt)) bad('地方时格式应为 hh:mm', 'localTime')
      else raanDeg = inp.localMode === 'ltdn' ? ltdnToRaan(lt, t0Ms) : ltanToRaan(lt, t0Ms)
      break
    }
    case 'custom': {
      const hp = num(inp.perigeeKm, NaN)
      const ha = inp.shape === 'ellip' ? num(inp.apogeeKm, hp) : hp
      if (!(hp > 0)) bad('近地点高度需 > 0 km', 'perigeeKm')
      if (inp.shape === 'ellip' && !(ha >= hp)) bad('远地点高度需 ≥ 近地点高度', 'apogeeKm')
      const s = fromHeights(hp, ha)
      aKm = s.aKm; e = s.e
      inclDeg = num(inp.inclDeg)
      argpDeg = norm360(num(inp.argpDeg))
      raanDeg = norm360(num(inp.raanDeg))
      m0Deg = norm360(num(inp.m0Deg))
      break
    }
    default:
      bad('未知轨道类型：' + type)
  }

  if (errs.length || !Number.isFinite(aKm) || !(aKm > RE + 79)) {
    if (!errs.length) bad('解不出有效轨道')
    return { ok: false, errs, warns, seed: null, derived: null }
  }
  if (!(e >= 0 && e < 1)) { bad('偏心率解出 ' + e + '，不在 [0,1)'); return { ok: false, errs, warns, seed: null, derived: null } }

  const seed = { aKm, e, inclDeg, raanDeg: norm360(raanDeg), argpDeg: norm360(argpDeg), m0Deg: norm360(m0Deg) }
  const h = heights(aKm, e)
  if (h.perigeeKm < 80) warns.push('近地点高度仅 ' + h.perigeeKm.toFixed(0) + ' km，已在大气层内')
  ltanHours = raanToLtan(seed.raanDeg, t0Ms)
  const derived = {
    periodMin: keplerPeriodSec(aKm) / 60,
    nodalPeriodMin: nodalPeriodSec(aKm, e, inclDeg) / 60,
    raanRateDegDay: raanRate(aKm, e, inclDeg) * RAD * 86400,
    argpRateDegDay: argpRate(aKm, e, inclDeg) * RAD * 86400,
    ltanHours,
    ltdnHours: ltanToLtdn(ltanHours),
    repeat,
    // 圆轨道的 t0 星下点经度（argp/M0 一并计入）
    subLonDeg: raanToLon(seed.raanDeg + seed.argpDeg + seed.m0Deg, gmst),
    apogeeKm: h.apogeeKm,
    perigeeKm: h.perigeeKm,
    aKm, e
  }
  return { ok: true, errs, warns, seed, derived }
}

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t } return a || 1 }

/**
 * seed -> generateConstellation 的 params（形状与既有向导完全一致，故 walker.js 一个字不改）。
 * layout: { pattern, T, P, F }；pattern 为 'single' 时 T=P=1。
 */
export function seedToParams(seed, layout, name) {
  const l = layout || {}
  const single = l.pattern === 'single'
  const h = heights(seed.aKm, seed.e)
  return {
    name: name || '',
    pattern: single ? 'single' : (l.pattern || 'delta'),
    T: single ? 1 : Math.max(1, Math.round(num(l.T, 1))),
    P: single ? 1 : Math.max(1, Math.round(num(l.P, 1))),
    F: single ? 0 : Math.round(num(l.F, 0)),
    incl: seed.inclDeg,
    shape: seed.e > 1e-9 ? 'ellip' : 'circ',
    perigeeKm: h.perigeeKm,
    apogeeKm: h.apogeeKm,
    argp: seed.argpDeg,
    raan0: seed.raanDeg,
    m0: seed.m0Deg
  }
}

export const CONST = { RE, MU, J2, OMEGA_E, SIDEREAL_DAY, SOLAR_DAY, TROPICAL_YEAR, OMEGA_DOT_SS, CRIT_PRO, CRIT_RETRO, GEO_A }

export default {
  ORBIT_TYPES, ORBIT_TYPE_KEYS, CONST,
  solveDesign, seedToParams, defaultInputs,
  meanSunLongitudeDeg, ltanToRaan, ltdnToRaan, raanToLtan, ltanToLtdn, parseHm, formatHm,
  sunSyncInclination, sunSyncSma, sunSyncMaxAltKm, repeatSma, repeatSunSyncSolve,
  raanRate, argpRate, maRate, nodalPeriodSec, keplerPeriodSec, geosyncSma,
  lonToRaan, raanToLon, solveRoot
}
