// Walker / 单轨道面 星座生成器（仿 STK Walker Tool）。
// 只做纯数学：一组参数 → 每颗星的经典平根数（角度单位 °，altKm=近地点高度，与 elementsToSatrec 约定一致）。
// 放置公式（与 STK Walker Tool 逐条一致，已用官方文档核对）：
//   S      = T / P                                  每面卫星数
//   RAAN_p = RAAN0 + p·(spread/P)                   p = 0…P−1
//   M(p,s) = M0 + s·(360/S) + F·p·(360/T)  (mod360) s = 0…S−1
//   Walker Delta: spread=360°；Walker Star: spread=180°；单面: P=1（spread 无关）。
// 椭圆：由近/远地点高度求偏心率 e=(ra−rp)/(ra+rp)，altKm 取近地点高度。
// F（相位因子）为整数，范围 0…P−1。

const RE = 6378.137          // 地球赤道半径 km
const MU = 398600.4418       // 地球引力常数 km^3/s^2

export const PATTERNS = [
  { key: 'delta', label: 'Walker Delta' },
  { key: 'star', label: 'Walker Star' },
  { key: 'plane', label: '单轨道面' }
]

const norm360 = (x) => ((x % 360) + 360) % 360
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// RAAN 展布（°）：Delta=360、Star=180、单面=0（同一升交点）、自定义=用户值
export function walkerSpread(pattern, custom) {
  if (pattern === 'star') return 180
  if (pattern === 'plane') return 0
  if (pattern === 'custom' && Number.isFinite(Number(custom))) return Number(custom)
  return 360
}

// 每面卫星数（单面即 T；否则 floor(T/P)，不整除时按此截断并告警）
function satsPerPlane(p) {
  const T = Math.max(1, Math.round(num(p.T, 1)))
  if (p.pattern === 'plane') return T
  const P = Math.max(1, Math.round(num(p.P, 1)))
  return Math.max(1, Math.floor(T / P))
}

// 校验：返回 { ok, errs[], warns[] }
export function validateWalker(p) {
  const errs = [], warns = []
  const T = Math.round(num(p.T)), P = p.pattern === 'plane' ? 1 : Math.round(num(p.P))
  if (!(T >= 1)) errs.push('总数 T 需 ≥ 1')
  if (!(P >= 1)) errs.push('面数 P 需 ≥ 1')
  if (T >= 1 && P >= 1 && P > T) errs.push('面数 P 不能超过总数 T')
  if (T >= 1 && P >= 1 && p.pattern !== 'plane' && T % P !== 0) warns.push(`T=${T} 不能被 P=${P} 整除，将生成 ${P * Math.floor(T / P)} 颗`)
  const F = Math.round(num(p.F))
  if (p.pattern !== 'plane' && P >= 1 && (F < 0 || F > P - 1)) warns.push(`相位因子 F 建议取 0…${P - 1}`)
  const i = num(p.incl)
  if (!(i >= 0 && i <= 180)) errs.push('倾角需在 0…180°')
  const hp = num(p.perigeeKm)
  if (!(hp > 0)) errs.push('近地点高度需 > 0')
  if (p.shape === 'ellip' && !(num(p.apogeeKm) >= hp)) errs.push('远地点高度需 ≥ 近地点高度')
  return { ok: errs.length === 0, errs, warns }
}

// 由参数算偏心率 + 近地点高度（altKm）
function orbitShape(p) {
  const hp = num(p.perigeeKm)
  const ha = p.shape === 'ellip' ? Math.max(hp, num(p.apogeeKm, hp)) : hp
  const rp = RE + hp, ra = RE + ha
  const ecc = ra + rp > 0 ? (ra - rp) / (ra + rp) : 0
  return { altKm: hp, ecc }
}

// 生成 → [{ name, plane, slot, elements:{ altKm, ecc, incl, raan, argp, ma } }]
export function generateConstellation(p) {
  const T = Math.max(1, Math.round(num(p.T, 1)))
  const P = p.pattern === 'plane' ? 1 : Math.max(1, Math.round(num(p.P, 1)))
  const F = p.pattern === 'plane' ? 0 : Math.round(num(p.F))
  const S = satsPerPlane(p)
  const spread = walkerSpread(p.pattern, p.spread)
  const incl = num(p.incl), argp = num(p.argp), raan0 = num(p.raan0), m0 = num(p.m0)
  const { altKm, ecc } = orbitShape(p)
  const prefix = (p.name || 'WALKER').trim() || 'WALKER'
  const pad = (n) => String(n).padStart(2, '0')
  const out = []
  for (let pl = 0; pl < P; pl++) {
    const raan = norm360(raan0 + pl * (spread / P))
    for (let s = 0; s < S; s++) {
      const ma = norm360(m0 + s * (360 / S) + F * pl * (360 / T))
      out.push({ name: `${prefix}-P${pad(pl + 1)}-S${pad(s + 1)}`, plane: pl, slot: s, elements: { altKm, ecc, incl, raan, argp, ma } })
    }
  }
  return out
}

// 轨道周期（min），供向导实时预览
export function orbitPeriodMin(p) {
  const hp = num(p.perigeeKm)
  const ha = p.shape === 'ellip' ? Math.max(hp, num(p.apogeeKm, hp)) : hp
  const a = RE + (hp + ha) / 2
  return (2 * Math.PI * Math.sqrt((a * a * a) / MU)) / 60
}

// Walker 码串，如 "53°: 24/6/1" / 单面 "0° · 单面 12"
export function walkerCode(p) {
  const i = num(p.incl)
  if (p.pattern === 'plane') return `${i}° · 单面 ${Math.round(num(p.T, 1))}`
  return `${i}°: ${Math.round(num(p.T, 1))}/${Math.round(num(p.P, 1))}/${Math.round(num(p.F))}`
}

// 一键预设：真实星座近似参数（可点后再改）。GPS/北斗 的 F 取直观值，非严格官方相位。
export const CONST_PRESETS = [
  { key: 'gps', label: 'GPS', p: { name: 'GPS', pattern: 'delta', T: 24, P: 6, F: 2, incl: 55, shape: 'circ', perigeeKm: 20180, apogeeKm: 20180, argp: 0, raan0: 0, m0: 0 } },
  { key: 'galileo', label: 'Galileo', p: { name: 'GALILEO', pattern: 'delta', T: 24, P: 3, F: 1, incl: 56, shape: 'circ', perigeeKm: 23222, apogeeKm: 23222, argp: 0, raan0: 0, m0: 0 } },
  { key: 'glonass', label: 'GLONASS', p: { name: 'GLONASS', pattern: 'delta', T: 24, P: 3, F: 1, incl: 64.8, shape: 'circ', perigeeKm: 19130, apogeeKm: 19130, argp: 0, raan0: 0, m0: 0 } },
  { key: 'beidou', label: '北斗MEO', p: { name: 'BDS-MEO', pattern: 'delta', T: 24, P: 3, F: 1, incl: 55, shape: 'circ', perigeeKm: 21528, apogeeKm: 21528, argp: 0, raan0: 0, m0: 0 } },
  { key: 'iridium', label: 'Iridium', p: { name: 'IRIDIUM', pattern: 'star', T: 66, P: 6, F: 2, incl: 86.4, shape: 'circ', perigeeKm: 780, apogeeKm: 780, argp: 0, raan0: 0, m0: 0 } },
  { key: 'oneweb', label: 'OneWeb', p: { name: 'ONEWEB', pattern: 'star', T: 648, P: 18, F: 1, incl: 87.9, shape: 'circ', perigeeKm: 1200, apogeeKm: 1200, argp: 0, raan0: 0, m0: 0 } },
  { key: 'starlink', label: 'Starlink-S1', p: { name: 'STARLINK', pattern: 'delta', T: 1584, P: 72, F: 1, incl: 53, shape: 'circ', perigeeKm: 550, apogeeKm: 550, argp: 0, raan0: 0, m0: 0 } },
  { key: 'o3b', label: 'O3b·赤道MEO', p: { name: 'O3B', pattern: 'plane', T: 12, P: 1, F: 0, incl: 0, shape: 'circ', perigeeKm: 8062, apogeeKm: 8062, argp: 0, raan0: 0, m0: 0 } },
  { key: 'molniya', label: 'Molniya·HEO', p: { name: 'MOLNIYA', pattern: 'delta', T: 3, P: 3, F: 1, incl: 63.4, shape: 'ellip', perigeeKm: 600, apogeeKm: 39700, argp: 270, raan0: 0, m0: 0 } },
  { key: 'qzss', label: 'QZSS·HEO', p: { name: 'QZSS', pattern: 'delta', T: 3, P: 3, F: 1, incl: 43, shape: 'ellip', perigeeKm: 32000, apogeeKm: 40000, argp: 270, raan0: 0, m0: 0 } }
]
