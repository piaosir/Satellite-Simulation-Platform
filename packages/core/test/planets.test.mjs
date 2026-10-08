// 行星星历自测（src/viz/planets.js + planets.data.js；spaceFx 的行星件）。运行：node packages/core/test/planets.test.mjs
//
// 行星画在 3D 球的星空里，位置或亮度错了都是「看着像、其实不对」—— 测试钉在【外部权威数值】上，不跟被测模块自己的中间量对照：
//   ① JPL Horizons（DE441，2026-10-07 取数，地心 500@399，QUANTITIES 1 / 9 / 19 / 20 / 24）：天体测量赤经赤纬（ICRF，已含光行时、
//      不含光行差）、视星等 APmag、地距 delta、相位角 S-T-O —— 六颗行星 × 七个时刻（1995 … 2060，含 2003 火星大冲、2012 金星凌日、
//      2020 木土合月），共 42 行；
//   ② 物理约束：截断级数解码长度对、光行时修正方向对（金星下合附近不修正差近 20″）；
//   ③ spaceFx 行星件：挂进第二趟（亮星之后、日面之前）、场景位置 = ICRF → 场景转动 × 地心位置、按真距离放（视差）、关掉 / 放掉 = 摘走。
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz') + '/').href
const P = await import(SRC + 'planets.js')
const MOD = await import(SRC + 'planets.data.js')
const FX = await import(SRC + 'globe3d/spaceFx.js')
const THREE = await import('three')

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }
const D2R = Math.PI / 180
const near = (a, b, e, msg) => assert.ok(Math.abs(a - b) <= e, `${msg || ''} ${a} vs ${b}（容差 ${e}）`)
const S = P.decodePlanetSeries(MOD)

// [行星, UT, 赤经 °, 赤纬 °, 视星等（金星凌日时 Horizons 不给）, 地距 AU, 相位角 °]
const HZ = [
  ['mer', '1995-03-15T00:00:00Z', 332.978698353, -13.172336520, -0.078, 1.139929583, 60.1765],
  ['mer', '2003-08-27T09:00:00Z', 174.971395126, -2.087360933, 0.927, 0.725668680, 117.5814],
  ['mer', '2012-06-06T01:30:00Z', 86.682038084, 25.180539152, -1.249, 1.249052956, 38.5450],
  ['mer', '2020-12-21T06:00:00Z', 270.189190261, -24.975703374, -1.281, 1.445458802, 3.5299],
  ['mer', '2026-10-07T00:00:00Z', 214.664357441, -16.408198525, -0.032, 1.091066429, 66.3584],
  ['mer', '2040-01-01T00:00:00Z', 277.917076805, -24.794249341, -1.157, 1.442198119, 6.1294],
  ['mer', '2060-06-30T00:00:00Z', 84.515548835, 18.705166707, 2.659, 0.622355559, 145.6737],
  ['ven', '1995-03-15T00:00:00Z', 316.745753753, -16.409441398, -4.046, 1.116812946, 61.0234],
  ['ven', '2003-08-27T09:00:00Z', 158.323031554, 10.606509666, -3.913, 1.726660348, 3.8663],
  ['ven', '2012-06-06T01:30:00Z', 74.310263120, 22.807129112, null, 0.288703361, 179.7845],
  ['ven', '2020-12-21T06:00:00Z', 245.024463825, -20.359035083, -3.920, 1.519285285, 31.9758],
  ['ven', '2026-10-07T00:00:00Z', 212.901180523, -21.179395927, -4.650, 0.317215716, 143.6284],
  ['ven', '2040-01-01T00:00:00Z', 241.535830833, -18.960926294, -4.021, 1.212722411, 54.1745],
  ['ven', '2060-06-30T00:00:00Z', 56.911950585, 16.006887300, -4.699, 0.458332011, 116.0677],
  ['mar', '1995-03-15T00:00:00Z', 137.445840676, 20.304894161, -0.647, 0.778737210, 22.7175],
  ['mar', '2003-08-27T09:00:00Z', 339.679908746, -15.728989748, -2.945, 0.372718746, 5.0128],
  ['mar', '2012-06-06T01:30:00Z', 168.103379932, 6.163468985, 0.476, 1.227864347, 39.1322],
  ['mar', '2020-12-21T06:00:00Z', 20.788035059, 9.422815039, -0.517, 0.803663914, 37.2039],
  ['mar', '2026-10-07T00:00:00Z', 127.404298127, 20.155335791, 1.087, 1.623528490, 36.4803],
  ['mar', '2040-01-01T00:00:00Z', 103.338166245, 26.640475040, -1.583, 0.612143215, 2.7256],
  ['mar', '2060-06-30T00:00:00Z', 77.131505373, 23.216489612, 1.410, 2.421788525, 13.3218],
  ['jup', '1995-03-15T00:00:00Z', 253.784416047, -21.792220368, -2.140, 5.114687997, 10.5565],
  ['jup', '2003-08-27T09:00:00Z', 152.342505881, 12.260730840, -1.719, 6.381563311, 0.7086],
  ['jup', '2012-06-06T01:30:00Z', 56.471335211, 19.071980983, -2.014, 5.965810997, 3.4107],
  ['jup', '2020-12-21T06:00:00Z', 302.382906615, -20.597999419, -1.978, 5.922007929, 5.6291],
  ['jup', '2026-10-07T00:00:00Z', 142.871043871, 15.309818526, -1.892, 5.848386471, 8.6608],
  ['jup', '2040-01-01T00:00:00Z', 181.335919779, 0.818528636, -2.083, 5.192185609, 10.3173],
  ['jup', '2060-06-30T00:00:00Z', 77.761042191, 22.482291837, -1.968, 6.013405072, 3.8304],
  ['sat', '1995-03-15T00:00:00Z', 347.970904214, -7.085846917, 1.057, 10.644805396, 0.8198],
  ['sat', '2003-08-27T09:00:00Z', 100.975989758, 22.305303473, 0.116, 9.595309866, 5.1594],
  ['sat', '2012-06-06T01:30:00Z', 202.163523743, -6.429438698, 0.517, 9.088485954, 4.7535],
  ['sat', '2020-12-21T06:00:00Z', 302.419785510, -20.486292415, 0.682, 10.822853838, 2.8771],
  ['sat', '2026-10-07T00:00:00Z', 10.922234985, 1.746700551, 0.340, 8.435151889, 0.3965],
  ['sat', '2040-01-01T00:00:00Z', 191.131232861, -2.213649826, 0.828, 9.518617296, 5.9135],
  ['sat', '2060-06-30T00:00:00Z', 68.867085715, 20.363218634, 0.152, 9.963181544, 3.0073],
  ['ura', '1995-03-15T00:00:00Z', 301.746534426, -20.763030589, 5.854, 20.262740922, 2.3536],
  ['ura', '2003-08-27T09:00:00Z', 333.013816635, -11.976782263, 5.780, 19.021343778, 0.1490],
  ['ura', '2012-06-06T01:30:00Z', 7.453583851, 2.449130271, 5.938, 20.430683986, 2.6819],
  ['ura', '2020-12-21T06:00:00Z', 34.499690110, 13.312659301, 5.740, 19.164213169, 2.2684],
  ['ura', '2026-10-07T00:00:00Z', 63.122288610, 20.983356437, 5.642, 18.804232952, 2.3163],
  ['ura', '2040-01-01T00:00:00Z', 124.079751776, 20.357933676, 5.434, 17.676632634, 1.1465],
  ['ura', '2060-06-30T00:00:00Z', 211.304499603, -12.180321503, 5.472, 18.065894097, 2.8429],
]
const sepArcsec = (raA, decA, v) => {
  const u = [Math.cos(decA * D2R) * Math.cos(raA * D2R), Math.cos(decA * D2R) * Math.sin(raA * D2R), Math.sin(decA * D2R)]
  const L = Math.hypot(v[0], v[1], v[2])
  return Math.hypot(u[0] - v[0] / L, u[1] - v[1] / L, u[2] - v[2] / L) * 206264.806
}

console.log('① JPL Horizons（DE441）')
t('天体测量位置：水金火木土 ≤ 0.6″、天王星 ≤ 1.6″（VSOP87 本身对 DE441 的差 + 截断 ≤ 0.5″）；地距相对误差 < 3e-6（天王星 6e-6）', () => {
  const worst = {}
  for (const [k, iso, ra, dec, , delta] of HZ) {
    const e = P.planetEphemeris(new Date(iso), S).find((x) => x.key === k)
    const s = sepArcsec(ra, dec, e.icrf)
    worst[k] = Math.max(worst[k] || 0, s)
    assert.ok(s <= (k === 'ura' ? 1.6 : 0.6), `${k} ${iso} 差 ${s.toFixed(2)}″`)
    near(e.delta / delta, 1, k === 'ura' ? 6e-6 : 3e-6, k + ' ' + iso + ' 地距')
  }
  console.log('    最大差（角秒）：' + JSON.stringify(Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, +v.toFixed(2)]))))
})
t('视星等（Mallama & Hilton 2018）：水金木 ≤ 0.005 等、土星 ≤ 0.06（环的两项简化）、火星 ≤ 0.1（不做自转 / 季节查表项）、天王星 ≤ 0.03；相位角 ≤ 0.01°', () => {
  const tol = { mer: 0.005, ven: 0.005, jup: 0.005, sat: 0.06, mar: 0.1, ura: 0.03 }
  for (const [k, iso, , , mag, , phase] of HZ) {
    const e = P.planetEphemeris(new Date(iso), S).find((x) => x.key === k)
    near(e.phase, phase, 0.01, k + ' ' + iso + ' 相位角')
    if (mag == null) continue
    near(e.mag, mag, tol[k], k + ' ' + iso + ' 视星等')
  }
})
t('金星凌日（2012-06-06，相位角 179.8°）：走 α > 163.7° 那一支，仍是有限值且比平时暗得多', () => {
  const e = P.planetEphemeris(new Date('2012-06-06T01:30:00Z'), S).find((x) => x.key === 'ven')
  assert.ok(Number.isFinite(e.mag) && e.mag > -3.5 && e.mag < -2, String(e.mag))
})

console.log('② 级数与光行时')
t('级数解码：七个天体 × L / B / R 齐全、每段项数整；地球日距一年内在 0.983 … 1.017 AU', () => {
  assert.deepEqual(MOD.PLANET_BODIES, ['ear', 'mer', 'ven', 'mar', 'jup', 'sat', 'ura'])
  for (const b of MOD.PLANET_BODIES) { assert.equal(S[b].length, 3); for (const v of S[b]) for (const a of v) assert.equal(a.length % 3, 0) }
  let lo = 9, hi = 0
  for (let d = 0; d < 366; d += 3) { const e = P.helioEcliptic(S.ear, (9400 + d) / 365250); const r = Math.hypot(...e); lo = Math.min(lo, r); hi = Math.max(hi, r) }
  assert.ok(lo > 0.9832 && lo < 0.9834 && hi > 1.0166 && hi < 1.0168, lo + ' / ' + hi)
})
t('光行时修正方向对：金星下合附近不修正要差近 20″，修正后对上 Horizons', () => {
  const [, iso, ra, dec] = HZ.find((r) => r[0] === 'ven' && r[1].startsWith('2026'))
  const tau = (Date.parse(iso) / 86400000 + 2440587.5 + 69.184 / 86400 - 2451545) / 365250
  const e = P.helioEcliptic(S.ear, tau), v = P.helioEcliptic(S.ven, tau)
  const g = [v[0] - e[0], v[1] - e[1], v[2] - e[2]]
  const c = Math.cos(84381.448 / 3600 * D2R), s = Math.sin(84381.448 / 3600 * D2R)
  const raw = [g[0], c * g[1] - s * g[2], s * g[1] + c * g[2]]
  assert.ok(sepArcsec(ra, dec, raw) > 15, '不修正光行时的差 ' + sepArcsec(ra, dec, raw))
  const ok = P.planetEphemeris(new Date(iso), S).find((x) => x.key === 'ven')
  assert.ok(sepArcsec(ra, dec, ok.icrf) < 0.6)
})

console.log('③ spaceFx 行星件')
const fx = FX.createSpaceFx({ getContext() { throw new Error('no gl') }, getPixelRatio: () => 1 }, new THREE.Scene())
fx.setPlanets({ gain: 1 })
await new Promise((r) => setTimeout(r, 200))   // 级数模块是动态 import
const d0 = new Date('2026-10-07T00:00:00Z')
fx.setTime([1, 0, 0], 1.234, null, d0)
t('场景位置 = ICRF → 场景转动 × 地心位置（地球半径为单位）；六颗都在、视星等与星历一致', () => {
  const st = fx.stats().planets
  assert.equal(st.ready, true)
  assert.equal(st.planets.length, 6)
  const rows = FX.icrfToSceneRows(d0, 1.234), eph = P.planetEphemeris(d0, S)
  st.planets.forEach((p, k) => {
    const v = eph[k].icrf, re = P.AU_KM / 6371
    for (let r = 0; r < 3; r++) near(p.scene[r], (rows[r * 3] * v[0] + rows[r * 3 + 1] * v[1] + rows[r * 3 + 2] * v[2]) * re, Math.abs(p.scene[r]) * 1e-6 + 1e-3, p.key)
    near(p.mag, eph[k].mag, 0.006, p.key)
  })
})
t('星历缓存：20 s 内不重算（地距不变），转动照换（地球在转：GMST 变了位置就变）', () => {
  const a = fx.stats().planets.planets[3]
  fx.setTime([1, 0, 0], 1.534, null, new Date(d0.getTime() + 10000))
  const b = fx.stats().planets.planets[3]
  assert.equal(a.delta, b.delta)
  assert.ok(Math.hypot(a.scene[0] - b.scene[0], a.scene[1] - b.scene[1], a.scene[2] - b.scene[2]) > 1000)
})
t('关掉 / 整个放掉 = 摘走；开着时遮挡球跟着在（行星照样要被地球挡住）', () => {
  assert.equal(fx.stats().occluder, true)
  fx.setPlanets(null)
  assert.equal(fx.stats().planets, null); assert.equal(fx.stats().occluder, false)
  fx.setPlanets({ gain: 1 }); fx.dispose()
  assert.equal(fx.stats().planets, null)
})

console.log(`\n全部 ${n} 项通过`)
