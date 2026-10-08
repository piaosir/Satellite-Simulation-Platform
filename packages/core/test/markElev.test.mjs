// 地球站 / 点标记「聚焦卫星仰角」标注（src/viz/markers/markElev.js）自检：
//  ① 最高仰角那颗：与 satellite.js ecfToLookAngles 逐颗暴力求最大对拍（随机站址 × LEO / MEO / GEO 混合星集）
//  ② 读数 = stationTrackAzEl（侧栏「跟踪」读数同一个函数）：与 satellite.js 方位 / 仰角对拍到 1e-9°；bestLook 与直接调它逐位相同
//  ③ 坏位置（NaN / 零距离）跳过，不把整站读数染成 NaN；空集 / 非法站址 → −1
//  ④ 天顶奇异：方位取 0，不沿用上一个标记留在复用容器里的方位
//  ⑤ 读数格式：toFixed(1) 同一舍入；-0.0 → 0.0；方位 360.0 → 0.0
//  ⑥ 读数串按界面语言出字：英文整串无汉字（原来拼出来的「方位 … 仰角 …」被运行时译成半中半英）
//  ⑦ 站标签的跟踪设置：只认挂了模型的站；勾方位角 → 方位 / 仰角成对读跟踪星；跟踪星解不出 → 空串（不拿别的星顶替）
//  ⑧ 真星历端到端：SGP4 推一组真星 → 快照 → bestLook 与逐颗 ecfToLookAngles 的最大值一致
import sat from '../../../src/viz/constellation/satellite.js'
import * as W from '../../../src/viz/wgs84.js'
import { stationTrackAzEl, makeStationLook } from '../models/entityPose.mjs'
import { bestElevIdx, bestLook, lookAt, fmtDeg1, fmtAz1, elevText, azElText, labelTrackOf, markLabelText } from '../../../src/viz/markers/markElev.js'

let fails = 0
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  (' + extra + ')' : ''}`); if (!cond) fails++ }
const DEG = Math.PI / 180
const HAN = /[一-鿿]/

// 可复现的伪随机
let seed = 20261008
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
// satellite.js 口径的方位 / 仰角（度）
function refLook(lat, lon, hKm, P) {
  const la = sat.ecfToLookAngles({ longitude: lon * DEG, latitude: lat * DEG, height: hKm }, { x: P[0], y: P[1], z: P[2] })
  return { el: la.elevation / DEG, az: la.azimuth / DEG }
}
const azDiff = (a, b) => { const d = Math.abs((((a - b) % 360) + 540) % 360 - 180); return d }
// 随机一颗星的 ECEF：地心距按 LEO / MEO / GEO 三档
function randSat() {
  const r = W.A + [550, 1200, 8000, 20200, 35786][Math.floor(rnd() * 5)]
  const lat = (rnd() * 2 - 1) * 70, lon = rnd() * 360 - 180
  return W.geocentricToEcef(lon, lat, r - W.A)
}

// —— ① 最高仰角那颗 vs 暴力求最大 ——
{
  let bad = 0, worst = 0
  for (let trial = 0; trial < 400; trial++) {
    const n = 1 + Math.floor(rnd() * 40)
    const xyz = new Float64Array(3 * n)
    for (let i = 0; i < n; i++) { const P = randSat(); xyz[3 * i] = P[0]; xyz[3 * i + 1] = P[1]; xyz[3 * i + 2] = P[2] }
    const lat = (rnd() * 2 - 1) * 85, lon = rnd() * 360 - 180, hKm = rnd() < 0.3 ? rnd() * 5 : 0
    let refBest = -Infinity
    for (let i = 0; i < n; i++) refBest = Math.max(refBest, refLook(lat, lon, hKm, [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]).el)
    const i = bestElevIdx(lat, lon, hKm, xyz, n)
    const got = i >= 0 ? refLook(lat, lon, hKm, [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]).el : NaN
    const d = Math.abs(got - refBest)
    worst = Math.max(worst, d)
    if (!(d < 1e-9)) bad++
  }
  ok(bad === 0, '① 挑出的那颗就是仰角最高的（400 组随机站址 × 1–40 颗混合轨道）', `最大差 ${worst.toExponential(2)}°`)
}

// —— ② 读数 = stationTrackAzEl，与 satellite.js 对拍 ——
{
  let worstEl = 0, worstAz = 0, same = true
  const out = makeStationLook(), ref = makeStationLook()
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + Math.floor(rnd() * 12)
    const xyz = new Float64Array(3 * n)
    for (let i = 0; i < n; i++) { const P = randSat(); xyz[3 * i] = P[0]; xyz[3 * i + 1] = P[1]; xyz[3 * i + 2] = P[2] }
    const lla = { lat: (rnd() * 2 - 1) * 85, lon: rnd() * 360 - 180, altM: rnd() < 0.3 ? rnd() * 4000 : 0 }
    const i = bestLook(lla, xyz, n, out)
    const P = [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]
    const r = refLook(lla.lat, lla.lon, lla.altM / 1000, P)
    worstEl = Math.max(worstEl, Math.abs(out.elDeg - r.el))
    if (Math.abs(r.el) < 89.9) worstAz = Math.max(worstAz, azDiff(out.azDeg, r.az))
    ref.a1Deg = NaN
    stationTrackAzEl(lla, P, ref)
    if (ref.elDeg !== out.elDeg || ref.azDeg !== out.azDeg) same = false
  }
  ok(worstEl < 1e-9 && worstAz < 1e-9, '② 读数与 satellite.js ecfToLookAngles 对拍', `仰角 ${worstEl.toExponential(2)}° 方位 ${worstAz.toExponential(2)}°`)
  ok(same, '② bestLook 的读数与侧栏「跟踪」读数（stationTrackAzEl）逐位相同')
}

// —— ③ 坏位置跳过；空集 / 非法站址 ——
{
  const good = W.geodeticToEcef(110, 0, 35786), low = W.geodeticToEcef(150, 0, 35786)
  const xyz = new Float64Array([NaN, NaN, NaN, ...low, ...good, Infinity, 0, 0])
  const i = bestElevIdx(30, 110, 0, xyz, 4)
  ok(i === 2, '③ 排在第一个的 NaN 星不染整站读数，取有效星里最高的', `下标 ${i}`)
  const st = W.geodeticToEcef(110, 30, 0)
  ok(bestElevIdx(30, 110, 0, new Float64Array([...st, ...low]), 2) === 1, '③ 与站址重合的位置（零距离）跳过')
  ok(bestElevIdx(30, 110, 0, new Float64Array([NaN, 0, 0]), 1) === -1, '③ 全是坏位置 → −1')
  ok(bestElevIdx(30, 110, 0, xyz, 0) === -1 && bestElevIdx(NaN, 110, 0, xyz, 4) === -1, '③ 空集 / 非法站址 → −1')
  const out = makeStationLook()
  out.elDeg = 12.5
  ok(bestLook({ lat: 30, lon: 110, altM: 0 }, xyz, 0, out) === -1 && out.elDeg === 12.5, '③ bestLook 没有可读的星时不动容器')
}

// —— ④ 天顶奇异：方位取 0 ——
{
  const out = makeStationLook()
  lookAt({ lat: 30, lon: 110, altM: 0 }, W.geodeticToEcef(150, 0, 35786), out)
  const azPrev = out.azDeg
  const up = W.geodeticUp(20, 40), base = W.geodeticToEcef(20, 40, 0)
  const zen = [base[0] + 1000 * up[0], base[1] + 1000 * up[1], base[2] + 1000 * up[2]]
  lookAt({ lat: 40, lon: 20, altM: 0 }, zen, out)
  ok(Math.abs(out.elDeg - 90) < 1e-9 && out.azDeg === 0 && azPrev > 1, '④ 正过顶：仰角 90°、方位 0（上一个站的方位不带过来）', `上一个 ${azPrev.toFixed(1)}°`)
}

// —— ⑤ 读数格式 ——
{
  ok(fmtDeg1(-0.04) === '0.0' && fmtDeg1(-0) === '0.0' && fmtDeg1(0.04) === '0.0', '⑤ 贴地平的负零归 0.0')
  ok(fmtDeg1(-0.06) === '-0.1' && fmtDeg1(36.74) === '36.7' && fmtDeg1(36.76) === '36.8' && fmtDeg1(-12.34) === '-12.3', '⑤ 其余与 toFixed(1) 同一舍入')
  ok(fmtAz1(359.96) === '0.0' && fmtAz1(360) === '0.0' && fmtAz1(-0.01) === '0.0' && fmtAz1(-0) === '0.0', '⑤ 方位舍入到 360.0 的折回 0.0')
  ok(fmtAz1(138.64) === '138.6' && fmtAz1(-90) === '270.0' && fmtAz1(450) === '90.0', '⑤ 方位折到 [0, 360)')
}

// —— ⑥ 读数串按界面语言出字 ——
{
  ok(elevText(36.74) === '仰角 36.7°' && azElText(138.64, 36.74) === '方位 138.6° 仰角 36.7°', '⑥ 中文：仰角 x° / 方位 x° 仰角 y°')
  const saved = globalThis.localStorage
  globalThis.localStorage = { getItem: (k) => (k === 'ui-lang' ? 'en' : null) }
  try {
    const a = elevText(36.74), b = azElText(138.64, 36.74)
    ok(a === 'Elevation 36.7°' && b === 'Azimuth 138.6° Elevation 36.7°' && !HAN.test(a + b), '⑥ 英文：整串无汉字', `${a} | ${b}`)
  } finally {
    if (saved === undefined) delete globalThis.localStorage
    else globalThis.localStorage = saved
  }
}

// —— ⑦ 站标签的跟踪设置与读数串 ——
{
  const T = (o) => ({ kind: 'sat', satKey: 'norad:41725', ...o })
  ok(labelTrackOf({ track: T({ el: true, az: true }) }) === null, '⑦ 没挂模型的站不认跟踪设置（「跟踪」行不在界面上）')
  ok(labelTrackOf({ model: { id: 'x' }, track: { kind: 'sat', el: true } }) === null, '⑦ 没指定卫星 → 不认')
  ok(labelTrackOf({ model: { id: 'x' }, track: T({}) }) === null, '⑦ 仰角 / 方位角都没勾 → 不认（读聚焦集最高仰角）')
  ok(labelTrackOf({ model: { id: 'x' }, track: T({ el: true }) }) !== null && labelTrackOf({ model: { id: 'x' }, track: T({ az: true }) }) !== null, '⑦ 勾了仰角或方位角 → 认')
  ok(labelTrackOf(null) === null && labelTrackOf({ id: 'p1' }) === null, '⑦ 点标记 / 空 → null')

  const trkLook = { elDeg: 20.14, azDeg: 100.04 }, best = { elDeg: 35.44, azDeg: 200 }
  ok(markLabelText({ el: true }, trkLook, best) === '仰角 20.1°', '⑦ 只勾仰角 → 仰角读跟踪星')
  ok(markLabelText({ az: true }, trkLook, best) === '方位 100.0° 仰角 20.1°', '⑦ 只勾方位角 → 方位 / 仰角成对读跟踪星（不再混进聚焦集最高那颗的仰角）')
  ok(markLabelText({ el: true, az: true }, trkLook, best) === '方位 100.0° 仰角 20.1°', '⑦ 都勾 → 方位 / 仰角读跟踪星')
  ok(markLabelText({ el: true }, null, best) === '' && markLabelText({ az: true }, { elDeg: NaN, azDeg: 1 }, best) === '', '⑦ 跟踪星解不出 → 空串（不拿聚焦集里别的星顶替）')
  ok(markLabelText(null, null, best) === '仰角 35.4°', '⑦ 不读跟踪星 → 聚焦集最高仰角')
  ok(markLabelText(null, null, null) === '' && markLabelText(null, null, { elDeg: NaN }) === '', '⑦ 没有聚焦 / 解不出 → 空串')
}

// —— ⑧ 真星历端到端 ——
{
  // 几颗在轨星的 TLE（历元附近推演，量的是口径一致而非星历新旧）
  const tles = [
    ['1 25544U 98067A   26280.50000000  .00010000  00000+0  18000-3 0  9990', '2 25544  51.6400 120.0000 0005000  90.0000 270.0000 15.50000000400000'],
    ['1 41725U 16056A   26280.50000000 -.00000300  00000+0  00000+0 0  9990', '2 41725   0.0500  80.0000 0002000 200.0000 100.0000  1.00270000 36000'],
    ['1 44714U 19074B   26280.50000000  .00020000  00000+0  15000-3 0  9990', '2 44714  53.0500 300.0000 0001500  70.0000 290.0000 15.06000000380000'],
    ['1 28474U 04045A   26280.50000000 -.00000040  00000+0  00000+0 0  9990', '2 28474  54.5000 200.0000 0100000 250.0000 110.0000  2.00560000160000']
  ]
  const recs = tles.map(([a, b]) => sat.twoline2satrec(a, b))
  let worst = 0, cnt = 0
  const out = makeStationLook()
  for (let k = 0; k < 48; k++) {
    const t = new Date(Date.UTC(2026, 9, 7, 12, 0, 0) + k * 1800e3), g = sat.gstime(t)
    const xyz = []
    for (const r of recs) {
      const pv = sat.propagate(r, t)
      if (!pv || !pv.position) continue
      const e = sat.eciToEcf(pv.position, g)
      xyz.push(e.x, e.y, e.z)
    }
    const n = xyz.length / 3
    for (const [lat, lon] of [[39.9, 116.4], [-33.9, 151.2], [64.1, -21.9], [0, -78.5]]) {
      let ref = -Infinity
      for (let i = 0; i < n; i++) ref = Math.max(ref, refLook(lat, lon, 0, [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]).el)
      if (bestLook({ lat, lon, altM: 0 }, Float64Array.from(xyz), n, out) < 0) { worst = Infinity; continue }
      worst = Math.max(worst, Math.abs(out.elDeg - ref)); cnt++
    }
  }
  ok(cnt === 48 * 4 && worst < 1e-9, '⑧ SGP4 真星历：最高仰角与逐颗 ecfToLookAngles 一致', `${cnt} 组，最大差 ${worst.toExponential(2)}°`)
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
