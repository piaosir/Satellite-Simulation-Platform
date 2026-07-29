// 晨昏线几何自测（src/viz/terminator.js）。运行：npm test
// 被测文件是渲染端 ESM（要在时间轴上每秒重算，进不了主进程），故本测试自身也是 .mjs。
//
// 这条线会被当作「此刻这颗星在不在阳照区」的判读依据，画歪了就是误导。测试刻意不跟被测模块
// 自身的中间量对照（那样只能证明它自洽），而是钉在【与实现无关的物理约束】上：
//   ① 晨昏线的定义不变式：线上每一点的太阳仰角必须恰为 0（用独立写的球面公式反算，不复用被测中间量）；
//   ② 黄赤交角：一年中日下点纬度的极值必须等于当年黄赤交角 23.436°，且落在夏至/冬至那几天；
//   ③ 均时差上界：日下点经度必须等于 15°×(12−UTC小时)，误差不超过均时差极值 ±4.13°；
//   ④ 极昼/极夜：夏至日 80°N 必须全天有日、80°S 必须全天无日，且夜区封口极点取南极。
// 另验分点退化（φs→0，tanφs→0）不产 NaN —— 那两个瞬间一出 NaN，整条线和夜区多边形当场消失。
import { solarGeometry, terminatorRing, terminatorFlat } from '../../../src/viz/terminator.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

const RAD = Math.PI / 180
const DEG = 180 / Math.PI
const U = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, s))

// 独立实现的太阳仰角（球面余弦定理）——刻意不调用被测模块的任何中间量
function sunElevDeg(latDeg, lonDeg, sub) {
  const phi = latDeg * RAD, phis = sub.lat * RAD
  const dLam = (lonDeg - sub.lon) * RAD
  const sinH = Math.sin(phi) * Math.sin(phis) + Math.cos(phi) * Math.cos(phis) * Math.cos(dLam)
  return Math.asin(Math.max(-1, Math.min(1, sinH))) * DEG
}

// ---- ① 定义不变式：晨昏线上每一点仰角恰为 0 ----
{
  let worst = 0, worstAt = null
  for (const d of [U(2026, 1, 5, 3, 17), U(2026, 3, 20, 14, 46), U(2026, 6, 21, 8, 25),
                   U(2026, 9, 23, 0, 6), U(2026, 12, 21, 20, 50), U(2027, 7, 4, 19, 41)]) {
    const { sub } = solarGeometry(d)
    for (const p of terminatorRing(d, 720)) {
      const h = Math.abs(sunElevDeg(p.lat, p.lon, sub))
      if (h > worst) { worst = h; worstAt = d.toISOString() }
    }
  }
  ok('晨昏环：每点太阳仰角 = 0', worst < 1e-9, `最大偏离 ${worst.toExponential(2)}° @ ${worstAt}`)
}

// ---- ①' 2D 单值形式与 3D 环必须是同一条线 ----
{
  const d = U(2026, 8, 14, 6, 30)
  const { sub, line } = terminatorFlat(d, { steps: 720 })
  let worst = 0
  for (const [lon, lat] of line) worst = Math.max(worst, Math.abs(sunElevDeg(lat, lon, sub)))
  ok('2D 晨昏线：每点太阳仰角 = 0', worst < 1e-9, `最大偏离 ${worst.toExponential(2)}°`)
}

// ---- ② 黄赤交角：全年日下点纬度极值 = 23.436°，且落在至日 ----
{
  let maxDec = -99, maxAt = null, minDec = 99, minAt = null
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3600e3) {
    const { sub } = solarGeometry(new Date(t))
    if (sub.lat > maxDec) { maxDec = sub.lat; maxAt = new Date(t) }
    if (sub.lat < minDec) { minDec = sub.lat; minAt = new Date(t) }
  }
  const OBLIQ = 23.4362   // 2026 年黄赤交角（IAU 1980/2006 长期项）
  ok('夏至日下点纬度 = +黄赤交角', Math.abs(maxDec - OBLIQ) < 0.02, `${maxDec.toFixed(4)}° vs ${OBLIQ}°`)
  ok('冬至日下点纬度 = −黄赤交角', Math.abs(minDec + OBLIQ) < 0.02, `${minDec.toFixed(4)}°`)
  ok('夏至落在 6/20–6/22', maxAt.getUTCMonth() === 5 && maxAt.getUTCDate() >= 20 && maxAt.getUTCDate() <= 22, maxAt.toISOString())
  ok('冬至落在 12/20–12/22', minAt.getUTCMonth() === 11 && minAt.getUTCDate() >= 20 && minAt.getUTCDate() <= 22, minAt.toISOString())
}

// ---- ②' 分点：日下点纬度过零发生在 3 月下旬与 9 月下旬 ----
{
  const crossings = []
  let prev = solarGeometry(new Date(Date.UTC(2026, 0, 1))).sub.lat
  for (let t = Date.UTC(2026, 0, 1) + 3600e3; t < Date.UTC(2027, 0, 1); t += 3600e3) {
    const cur = solarGeometry(new Date(t)).sub.lat
    if ((prev < 0) !== (cur < 0)) crossings.push(new Date(t))
    prev = cur
  }
  const mmdd = crossings.map((d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`)
  const springOk = crossings.some((d) => d.getUTCMonth() === 2 && d.getUTCDate() >= 19 && d.getUTCDate() <= 21)
  const autumnOk = crossings.some((d) => d.getUTCMonth() === 8 && d.getUTCDate() >= 22 && d.getUTCDate() <= 24)
  ok('全年恰两次过赤道', crossings.length === 2, mmdd.join(', '))
  ok('春分在 3/19–3/21', springOk, mmdd.join(', '))
  ok('秋分在 9/22–9/24', autumnOk, mmdd.join(', '))
}

// ---- ③ 均时差上界：日下点经度 = 15°×(12−UTC)，偏差不超过 ±4.13° ----
{
  const EOT_MAX_DEG = 4.13   // 均时差极值 ±16.5 min × 15°/h
  let worst = 0, worstAt = null
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 7 * 3600e3 + 1234e3) {
    const d = new Date(t)
    const { sub } = solarGeometry(d)
    const utcH = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600
    const expect = 15 * (12 - utcH)
    let dev = ((sub.lon - expect + 540) % 360) - 180   // 归到 (-180,180]
    dev = Math.abs(dev)
    if (dev > worst) { worst = dev; worstAt = d.toISOString() }
  }
  ok('日下点经度落在均时差带内', worst <= EOT_MAX_DEG, `最大偏差 ${worst.toFixed(3)}° ≤ ${EOT_MAX_DEG}° @ ${worstAt}`)
  ok('偏差确实用满均时差（非恒零）', worst > 3.0, `${worst.toFixed(3)}°`)
}

// ---- ④ 极昼/极夜与夜区封口极点 ----
{
  const d = U(2026, 6, 21, 8, 25)   // 北半球夏至前后
  const { sub, darkPole } = terminatorFlat(d, { steps: 360 })
  let minNorth = 99, maxSouth = -99
  for (let lon = -180; lon < 180; lon += 5) {
    minNorth = Math.min(minNorth, sunElevDeg(80, lon, sub))
    maxSouth = Math.max(maxSouth, sunElevDeg(-80, lon, sub))
  }
  ok('夏至 80°N 全天有日（极昼）', minNorth > 0, `最低仰角 ${minNorth.toFixed(2)}°`)
  ok('夏至 80°S 全天无日（极夜）', maxSouth < 0, `最高仰角 ${maxSouth.toFixed(2)}°`)
  ok('夏至夜区沿南极封口', darkPole === -90, `darkPole=${darkPole}`)

  const dw = U(2026, 12, 21, 20, 50)
  ok('冬至夜区沿北极封口', terminatorFlat(dw, { steps: 90 }).darkPole === 90)
}

// ---- ⑤ 日下点自身仰角 = 90°，反日下点 = −90° ----
{
  const d = U(2026, 4, 9, 17, 3)
  const { sub, anti } = solarGeometry(d)
  ok('日下点仰角 = 90°', Math.abs(sunElevDeg(sub.lat, sub.lon, sub) - 90) < 1e-9)
  ok('反日下点仰角 = −90°', Math.abs(sunElevDeg(anti.lat, anti.lon, sub) + 90) < 1e-9)
  ok('反日下点 = 日下点对趾', Math.abs(anti.lat + sub.lat) < 1e-12 && Math.abs(Math.abs(anti.lon - sub.lon) - 180) < 1e-9)
}

// ---- ⑥ 分点退化：φs→0 时不产 NaN（一出 NaN 整条线与夜区当场消失）----
{
  // 扫过春分前后 ±2 小时，逐分钟检查（φs 在此期间穿越 0）
  let bad = 0, n = 0
  for (let t = Date.UTC(2026, 2, 20, 12, 0); t <= Date.UTC(2026, 2, 20, 17, 0); t += 60e3) {
    const d = new Date(t)
    const { line, night } = terminatorFlat(d, { steps: 180 })
    const ring = terminatorRing(d, 180)
    n++
    for (const [lo, la] of line) if (!Number.isFinite(lo) || !Number.isFinite(la)) bad++
    for (const [lo, la] of night) if (!Number.isFinite(lo) || !Number.isFinite(la)) bad++
    for (const p of ring) if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) bad++
  }
  ok('分点邻域无 NaN', bad === 0, `扫 ${n} 个时刻，坏点 ${bad}`)
}

// ---- ⑦ 经度归一：所有输出落在 (-180,180]，纬度落在 [-90,90] ----
{
  let bad = 0
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 37 * 3600e3) {
    const d = new Date(t)
    const { sub, anti } = solarGeometry(d)
    for (const p of [sub, anti]) {
      if (!(p.lon > -180.000001 && p.lon <= 180.000001)) bad++
      if (!(p.lat >= -90 && p.lat <= 90)) bad++
    }
    for (const p of terminatorRing(d, 90)) {
      if (!(p.lon > -180.000001 && p.lon <= 180.000001)) bad++
      if (!(p.lat >= -90 && p.lat <= 90)) bad++
    }
  }
  ok('经纬度归一化范围', bad === 0, `越界 ${bad}`)
}

// ---- ⑧ 夜区多边形闭合性：首尾经度覆盖整幅 + 封口两点在暗极 ----
{
  const { night, darkPole } = terminatorFlat(U(2026, 10, 2, 4, 0), { steps: 360 })
  const first = night[0], last = night[night.length - 1]
  ok('夜区多边形起于 −180°', Math.abs(first[0] + 180) < 1e-9, `${first[0]}`)
  ok('夜区多边形封口回到 −180° 暗极', Math.abs(last[0] + 180) < 1e-9 && last[1] === darkPole, `[${last[0]}, ${last[1]}]`)
}

// ---- ⑨ 接缝对齐：lon0 必须能跟着地图的接缝走（flatCoverage 的 LON0=−30）----
// 采样起点若不等于地图接缝，夜区多边形会正好横跨接缝、填充时被撕成两半。
{
  const d = U(2026, 5, 18, 9, 12)
  const LON0 = -30
  const { line, night, sub } = terminatorFlat(d, { steps: 360, lon0: LON0 })
  ok('lon0 生效：采样起于接缝', Math.abs(line[0][0] - LON0) < 1e-9, `${line[0][0]}`)
  ok('lon0 生效：扫满一圈到 lon0+360', Math.abs(line[line.length - 1][0] - (LON0 + 360)) < 1e-9, `${line[line.length - 1][0]}`)
  // 世界横坐标 x=lon−LON0 必须单调递增且恰好落在 [0,360] —— 单调即无缝
  let mono = true
  for (let i = 1; i < line.length; i++) if (line[i][0] - line[i - 1][0] <= 0) mono = false
  ok('世界横坐标单调（不跨接缝）', mono && Math.abs(line[0][0] - LON0) < 1e-9)
  ok('夜区封口两点都在接缝经度上', Math.abs(night[night.length - 2][0] - (LON0 + 360)) < 1e-9 && Math.abs(night[night.length - 1][0] - LON0) < 1e-9)
  // 换了 lon0 不能改变这条线本身：仰角仍恒为 0
  let worst = 0
  for (const [lon, lat] of line) worst = Math.max(worst, Math.abs(sunElevDeg(lat, lon, sub)))
  ok('换 lon0 后仍是同一条晨昏线', worst < 1e-9, `最大偏离 ${worst.toExponential(2)}°`)
}

console.log(`\n晨昏线几何：${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
