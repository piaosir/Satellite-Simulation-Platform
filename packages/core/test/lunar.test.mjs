// 月球几何自测（src/viz/lunar.js + spaceFx.js 的月球取向约定）。运行：node packages/core/test/lunar.test.mjs
//
// 月球画在 3D 球上，读数（月下点 / 月相）写在侧栏 —— 位置、姿态、月相任何一样错了都是「看着像、其实不对」，
// 故测试不跟被测模块自己的中间量对照，而是钉在【外部权威数值】与【物理约束】上：
//   ① Meeus《Astronomical Algorithms》例 47.a：三个周期项和 Σl / Σb / Σr 逐位相等（系数表抄错一项就对不上），视赤经赤纬到 1″；
//   ② JPL Horizons（DE441，2026-10-05 取数）：地心视赤经赤纬、地月距离、天平动（月面上的地心对点）、照亮比例、相位角、月面日下点，
//      跨 2000 / 2026 / 2035 三段、覆盖满月 / 弦月 / 蛾眉月 / 新月前后；
//   ③ NASA 五千年日月食表（eclipse.gsfc.nasa.gov LEcat5 / SEcat5）：月食的 γ、本影 / 半影食分（地影按 Danjon 放大 1/85 —— 用 Chauvenet
//      的 2% 时半影食分系统性偏大 0.03，表上对不上），日食的 γ 与「从食甚点看日月中心几乎重合」（地心看相距 0.14°–0.92°，验视差几何）；
//   ④ 物理约束：天平动一年内在 ±8.2° / ±7° 以内且两向都确实摆到 ±7° / ±6.5° 以上；盈亏与已知月相日期一致；
//   ⑤ 贴图取向：SphereGeometry 每个顶点经 MOON_LOCAL 换到月面固连系后，经纬度恰好等于它的 uv 在等经纬贴图上的经纬度；
//      moonSceneState 把「月心看地心」的方向换到场景里后，恰好指向场景原点（地心）—— 近侧月面朝地球。
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz') + '/').href
const L = await import(SRC + 'lunar.js')
const { solarGeometry } = await import(SRC + 'terminator.js')
const FX = await import(SRC + 'globe3d/spaceFx.js')
const THREE = await import('three')

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }
const D2R = Math.PI / 180
const near = (a, b, e, msg) => assert.ok(Math.abs(a - b) <= e, `${msg || ''} ${a} vs ${b}（容差 ${e}）`)
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sunDirOf = (d) => { const s = solarGeometry(d).sub; return [Math.cos(s.lat * D2R) * Math.cos(s.lon * D2R), Math.cos(s.lat * D2R) * Math.sin(s.lon * D2R), Math.sin(s.lat * D2R)] }
const dlon = (a, b) => ((a - b + 540) % 360) - 180
// 表上的 TD（力学时）→ 本模块的 UTC 入参：TT − UTC 取模块自己的常数（与表的预报 ΔT 无关 —— 几何只认 TT）
const fromTD = (s) => new Date(Date.parse(s + 'Z') - L.TT_MINUS_UTC_S * 1000)

console.log('① Meeus 例 47.a（1992-04-12 0h TD）')
t('三个周期项和与 λ / β / Δ 逐位等于书上的值', () => {
  const m = L.moonEcliptic((2448724.5 - 2451545) / 36525)
  assert.equal(Math.round(m.sl), -1127527)
  assert.equal(Math.round(m.sb), -3229126)
  assert.equal(Math.round(m.sr), -16590875)
  near(m.lambda, 133.162655, 5e-7, 'λ')
  near(m.beta, -3.229126, 5e-7, 'β')
  near(m.distKm, 368409.7, 0.05, 'Δ')
})
t('视赤经 / 赤纬到 1″（章动用低精度式，与书上全精度差 0.1″ 级）', () => {
  const d = new Date((2448724.5 - 2440587.5) * 86400000 - L.TT_MINUS_UTC_S * 1000)
  const p = L.moonPosition(d)
  near(p.raDeg, 134.688470, 1 / 3600, 'α')
  near(p.decDeg, 13.768368, 1 / 3600, 'δ')
})

console.log('② JPL Horizons（DE441）')
// [UTC, 视赤经°, 视赤纬°, 照亮%, 对地点经°, 对地点纬°, 月面日下点经°, 纬°, 距离 km, 相位角°]
const HZ = [
  ['2026-01-03T05:17', 101.334353077, 27.459785771, 99.79455, 2.900784, -5.751297, 5.601405, -1.308934, 361833.75545, 5.1928],
  ['2026-03-31T05:17', 169.017158646, 3.772531338, 96.34459, 4.795687, 1.198729, 26.841517, 0.869291, 387224.24426, 22.0393],
  ['2026-05-28T05:17', 208.527820011, -16.221347904, 91.04341, 4.332857, 5.578480, 39.007332, 1.577238, 401140.95766, 34.8236],
  ['2026-08-23T05:17', 274.631490180, -27.740745680, 77.96162, 0.041281, 5.674310, 55.850235, 0.018417, 404234.47950, 55.9942],
  ['2026-12-17T05:17', 354.365339257, 0.589343403, 49.95123, 352.367496, -3.556337, 82.506568, -1.336332, 390108.99221, 90.0559],
  ['2026-10-06T00:00', 137.429323352, 17.703782643, 23.74197, 3.615825, -1.618839, 241.879564, -1.100368, 373669.18027, 121.6761],
  ['2026-10-09T00:00', 174.923266222, -0.294198585, 3.14589, 4.879390, 3.040737, 205.240987, -1.167833, 381667.50295, 159.5619],
  ['2026-10-12T00:00', 210.679639507, -17.432275658, 2.08428, 4.488999, 6.112257, 168.584839, -1.226666, 392804.93393, 163.4036],
  ['2026-10-15T00:00', 249.344086972, -27.090406696, 18.04187, 2.087534, 6.482798, 131.947345, -1.272016, 402435.91674, 129.7331],
  ['2026-10-21T00:00', 325.921312526, -14.088356624, 71.89920, 354.819145, 0.526249, 58.821307, -1.340282, 394570.60390, 64.0223],
  ['2026-10-27T00:00', 40.704473761, 20.942643506, 98.88542, 356.974885, -6.403144, 345.901590, -1.409565, 366465.91343, 12.1255],
  ['2026-11-02T00:00', 134.322171589, 18.637907549, 48.47391, 4.754255, -1.716807, 272.959854, -1.466957, 373062.29048, 91.7489],
  ['2000-01-01T12:00', 222.452200851, -10.900653780, 23.00638, 5.025824, -6.720739, 242.181075, 0.619964, 402416.66467, 122.6718],
  ['2035-06-15T18:30', 208.176075652, -7.439216558, 78.21222, 5.689462, -5.072493, 61.334393, -1.510011, 398145.46065, 55.6470]
]
const hz = HZ.map((r) => {
  const d = new Date(r[0] + 'Z'), p = L.moonPosition(d), M = L.moonBodyToEcef(d, p), s = sunDirOf(d), R = L.sunDistanceKm(d)
  const lib = L.ecefDirToSeleno(M, p.ecef.map((x) => -x))
  const ss = L.ecefDirToSeleno(M, s.map((x, i) => x * R - p.ecef[i]))
  return { r, p, ph: L.moonPhase(p.ecef, s, R), lib, ss }
})
t('地心视位置 ≤ 10″（实测最大 5.3″；月面直径 1900″）', () => {
  for (const { r, p } of hz) {
    const sep = Math.hypot(dlon(p.raDeg, r[1]) * Math.cos(r[2] * D2R), p.decDeg - r[2]) * 3600
    assert.ok(sep <= 10, `${r[0]} 偏 ${sep.toFixed(1)}″`)
  }
})
t('地月距离 ≤ 60 km（实测最大 40 km，Meeus 截断级数的量级）', () => {
  for (const { r, p } of hz) near(p.distKm, r[8], 60, r[0])
})
t('天平动：月面上的地心对点经纬 ≤ 0.02°（IAU 自转模型 vs DE441 的 ME 系；实测最大 0.007°）', () => {
  for (const { r, lib } of hz) { near(dlon(lib.lon, r[4]), 0, 0.02, r[0] + ' 经'); near(lib.lat, r[5], 0.02, r[0] + ' 纬') }
})
t('月面日下点 ≤ 0.02°、相位角 ≤ 0.02°、照亮比例 ≤ 0.05 个百分点', () => {
  for (const { r, ph, ss } of hz) {
    near(dlon(ss.lon, r[6]), 0, 0.02, r[0] + ' 日下经'); near(ss.lat, r[7], 0.02, r[0] + ' 日下纬')
    near(ph.phaseDeg, r[9], 0.02, r[0] + ' 相位角')
    near(ph.illum * 100, r[3], 0.05, r[0] + ' 照亮')
  }
})
t('盈亏：新月（10-10）后的蛾眉月为盈、满月（10-26）后与新月前为亏', () => {
  const wax = (s) => hz.find((h) => h.r[0] === s).ph.waxing
  assert.equal(wax('2026-10-12T00:00'), true)
  assert.equal(wax('2026-10-15T00:00'), true)
  assert.equal(wax('2026-10-21T00:00'), true)
  assert.equal(wax('2026-10-27T00:00'), false)
  assert.equal(wax('2026-11-02T00:00'), false)
  assert.equal(wax('2026-10-06T00:00'), false)
})
t('月下点 = 视赤纬 + (视赤经 − 视恒星时)，与地固矢量同一方向', () => {
  for (const { p } of hz) {
    const e = p.ecef, r = Math.hypot(...e)
    near(Math.asin(e[2] / r) / D2R, p.sub.lat, 1e-9)
    near(dlon(Math.atan2(e[1], e[0]) / D2R, p.sub.lon), 0, 1e-9)
    near(p.sub.lat, p.decDeg, 1e-9)
  }
})

console.log('③ NASA 日月食表（2025–2028）')
// 月食：[食甚 TD, γ, 半影食分, 本影食分]
const LE = [['2025-03-14T06:59:56', 0.3484, 2.2595, 1.1784], ['2025-09-07T18:12:58', -0.2752, 2.3440, 1.3619],
  ['2026-03-03T11:34:52', -0.3765, 2.1838, 1.1507], ['2026-08-28T04:14:04', 0.4964, 1.9645, 0.9299],
  ['2028-12-31T16:53:15', 0.3258, 2.2742, 1.2463], ['2027-02-20T23:14:06', -1.0480, 0.9266, -0.0569], ['2028-01-12T04:14:13', 0.9817, 1.0468, 0.0662]]
function lunarEcl(d) {
  const p = L.moonPosition(d), s = sunDirOf(d), Ds = L.sunDistanceKm(d), ax = s.map((x) => -x)
  const Lm = dot(p.ecef, ax), perp = p.ecef.map((x, i) => x - Lm * ax[i])
  const north = [0, 0, 1].map((x, i) => x - ax[2] * ax[i])
  const del = Math.hypot(...perp)
  const Rs = L.EARTH_SHADOW_KM, ru = Rs - Lm * (L.SUN_R_KM - Rs) / Ds, rp = Rs + Lm * (L.SUN_R_KM + Rs) / Ds
  return {
    gamma: Math.sign(dot(perp, north)) * del / L.EARTH_EQ_KM,
    um: (ru + L.MOON_R_KM - del) / (2 * L.MOON_R_KM), pen: (rp + L.MOON_R_KM - del) / (2 * L.MOON_R_KM),
    lit: L.earthShadowFraction(p.ecef, s, Ds), inUmbra: del < ru
  }
}
t('月食 γ ≤ 0.005（实测最大 0.0024）', () => { for (const [td, g] of LE) near(lunarEcl(fromTD(td)).gamma, g, 0.005, td) })
t('本影 / 半影食分 ≤ 0.01（Danjon 地影；实测最大 0.005）', () => {
  for (const [td, , pen, um] of LE) { const e = lunarEcl(fromTD(td)); near(e.um, um, 0.01, td + ' 本影'); near(e.pen, pen, 0.01, td + ' 半影') }
})
t('地影系数：月心在本影里 = 0（日面全被挡），半影食里在 0 与 1 之间，食前 4 小时 = 1', () => {
  for (const [td, , , um] of LE) {
    const e = lunarEcl(fromTD(td))
    if (e.inUmbra) assert.equal(e.lit, 0, td)
    else assert.ok(e.lit > 0 && e.lit < 1, td + ' ' + e.lit)
    if (um > 0.5) assert.ok(e.inUmbra, td + ' 本影食分过半时月心必在本影里')
    const before = lunarEcl(new Date(fromTD(td).getTime() - 4 * 3600e3))
    assert.equal(before.lit, 1, td + ' 食前 4 h')
  }
})
// 日食：[食甚 TD, γ, 食甚点纬°, 经°（表上取整到 1°）]
const SE = [['2026-08-12T17:47:06', 0.8977, 65, -25], ['2027-08-02T10:07:50', 0.1421, 26, 33],
  ['2026-02-17T12:13:06', -0.9743, -65, 87], ['2028-07-22T02:56:40', -0.6056, -16, 127]]
t('日食 γ ≤ 0.005（月影轴到地心的距离；实测最大 0.0023）', () => {
  for (const [td, g] of SE) {
    const d = fromTD(td), p = L.moonPosition(d), Ds = L.sunDistanceKm(d), sun = sunDirOf(d).map((x) => x * Ds)
    const a0 = p.ecef.map((x, i) => x - sun[i]), na = Math.hypot(...a0), ax = a0.map((x) => x / na)
    const Lm = dot(p.ecef, ax), foot = p.ecef.map((x, i) => x - Lm * ax[i])   // 地心到影轴的垂足（相对地心）
    const north = [0, 0, 1].map((x, i) => x - ax[2] * ax[i])
    near(Math.sign(dot(foot, north)) * Math.hypot(...foot) / L.EARTH_EQ_KM, g, 0.005, td)
  }
})
t('食甚点上看日月中心角距 ≤ 0.03°，而地心看相距 0.14°–0.92°（视差几何对）', () => {
  for (const [td, , la, lo] of SE) {
    const d = fromTD(td), p = L.moonPosition(d), Ds = L.sunDistanceKm(d), sun = sunDirOf(d).map((x) => x * Ds)
    const site = [Math.cos(la * D2R) * Math.cos(lo * D2R), Math.cos(la * D2R) * Math.sin(lo * D2R), Math.sin(la * D2R)].map((x) => x * 6371)
    const tm = p.ecef.map((x, i) => x - site[i]), ts = sun.map((x, i) => x - site[i])
    const topo = Math.acos(dot(tm, ts) / Math.hypot(...tm) / Math.hypot(...ts)) / D2R
    const geo = Math.acos(dot(p.ecef, sun) / Math.hypot(...p.ecef) / Ds) / D2R
    assert.ok(topo <= 0.03, `${td} 食甚点看 ${topo.toFixed(4)}°`)
    assert.ok(geo >= 0.1, `${td} 地心看 ${geo.toFixed(3)}° —— 反向证伪：地心看若也重合，这条测不出视差`)
  }
})

console.log('④ 物理约束')
t('天平动：2026 全年逐 6 h，经向 / 纬向都在 ±8.2° / ±7.0° 内，且两向都摆过 ±7.0° / ±6.5°（理论极值约 7.9° / 6.9°）', () => {
  let lo = [Infinity, -Infinity], la = [Infinity, -Infinity]
  for (let h = 0; h <= 365 * 24; h += 6) {
    const d = new Date(Date.UTC(2026, 0, 1) + h * 3600e3), p = L.moonPosition(d)
    const lib = L.ecefDirToSeleno(L.moonBodyToEcef(d, p), p.ecef.map((x) => -x))
    lo = [Math.min(lo[0], lib.lon), Math.max(lo[1], lib.lon)]; la = [Math.min(la[0], lib.lat), Math.max(la[1], lib.lat)]
  }
  assert.ok(lo[0] > -8.2 && lo[1] < 8.2 && la[0] > -7.0 && la[1] < 7.0, `经 ${lo} 纬 ${la}`)
  assert.ok(lo[0] < -7 && lo[1] > 7 && la[0] < -6.5 && la[1] > 6.5, `经 ${lo} 纬 ${la}`)
})
t('月面姿态阵正交、行列式 +1（纯旋转，不镜像）', () => {
  const M = L.moonBodyToEcef(new Date('2026-10-06T00:00:00Z'))
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const v = M[i * 3] * M[j * 3] + M[i * 3 + 1] * M[j * 3 + 1] + M[i * 3 + 2] * M[j * 3 + 2]
    near(v, i === j ? 1 : 0, 1e-12)
  }
  const det = M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6])
  near(det, 1, 1e-12)
})
t('地影系数：地心前方（朝日一侧）恒 1；影轴上过本影顶点（约 217 个地球半径）后不再全黑', () => {
  const s = [1, 0, 0]
  assert.equal(L.earthShadowFraction([60 * 6371, 0, 0], s), 1)
  assert.equal(L.earthShadowFraction([-60 * 6371, 0, 0], s), 0)
  assert.ok(L.earthShadowFraction([-260 * 6371, 0, 0], s) > 0)
})

console.log('⑤ 贴图取向与场景换轴')
t('SphereGeometry 顶点经 MOON_LOCAL 换到月面系后的经纬 = 其 uv 在等经纬贴图上的经纬（图中线 0°、东经在右、北在上）', () => {
  const g = new THREE.SphereGeometry(1, 64, 32), pos = g.attributes.position, uv = g.attributes.uv, m = FX.MOON_LOCAL
  let k = 0
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const b = [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z]
    const lat = Math.asin(Math.max(-1, Math.min(1, b[2]))) / D2R
    near(lat, uv.getY(i) * 180 - 90, 1e-4, '纬 #' + i)
    if (Math.abs(lat) > 89.9) continue                                   // 极点经度无定义
    const lon = Math.atan2(b[1], b[0]) / D2R, want = uv.getX(i) * 360 - 180
    near(dlon(lon, want), 0, 1e-4, '经 #' + i)
    k++
  }
  assert.ok(k > 1500)
  g.dispose()
})
t('moonSceneState：月心看地心的方向（月面系里就是天平动那一点）换到场景后恰好指向场景原点', () => {
  for (const s of ['2026-10-06T00:00:00Z', '2026-10-15T12:00:00Z', '2035-06-15T18:30:00Z']) {
    const d = new Date(s), p = L.moonPosition(d), M = L.moonBodyToEcef(d, p)
    const st = FX.moonSceneState(p, M, L.sunDistanceKm(d))
    const lib = L.ecefDirToSeleno(M, p.ecef.map((x) => -x))
    const b = [Math.cos(lib.lat * D2R) * Math.cos(lib.lon * D2R), Math.cos(lib.lat * D2R) * Math.sin(lib.lon * D2R), Math.sin(lib.lat * D2R)]
    const r = st.rot, v = [r[0] * b[0] + r[1] * b[1] + r[2] * b[2], r[3] * b[0] + r[4] * b[1] + r[5] * b[2], r[6] * b[0] + r[7] * b[1] + r[8] * b[2]]
    const c = st.center, cn = Math.hypot(...c)
    near(dot(v, c.map((x) => -x / cn)), 1, 1e-12, s)
    near(cn * 6371, p.distKm, 1e-6, s + ' 月心距离')
    // 换轴本身：场景 (X, Z, −Y) —— 与 focusLanes.llaToVec 同一套（月下点经纬喂 llaToVec 得到的方向 = 月心方向）
    const la = p.sub.lat * D2R, lo = p.sub.lon * D2R
    const ll = [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)]
    near(dot(ll, c) / cn, 1, 1e-12, s + ' 换轴')
  }
})

console.log(`\n全部 ${n} 项通过`)
