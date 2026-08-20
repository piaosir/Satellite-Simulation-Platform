// 覆盖分析「峰值点」落点判据自测（对地 useGrdCoverage.peakPoint / 对星 shellMapper strict）。运行：npm test
// 被测文件是渲染端 ESM，故本测试自身也是 .mjs。
//
// 治的病：白点（原名「波束中心」）的位置取自 projectGrid 的 lon/lat[argmax]，而那张投影是
// limbOutside=true 投的——射线打不到椭球时返回的不是交点，而是【射线到地心的垂足】（pRaw，停在
// 地平外、高度可达几万 km）。把它当地表点反算经纬度得到的是没有物理意义的量，而唯一的把关
// Number.isFinite 永远为真、从来不触发。四条不变式：
//   ① 地平裕度 vis 在地平处严格穿零（<0 即越地平，这就是该用的判据）；
//   ② 越地平后 limbOutside 的落点确实是假读数：经度 ≈ 90°−离轴角，【往回走】，超 90° 翻到另一半球；
//   ③ 未越地平时新老口径逐位一致（改动不动正常情形）；
//   ④ 对星壳层：strict 版未命中返回 null，非 strict 版给的相切兜底点不是射线真正到达的位置。
import { antennaBasis, gridDir, projectGrid, projectLimb } from '../../../src/viz/grd/coverage.js'
import { elevationDeg, A } from '../../../src/viz/wgs84.js'
import { shellGeom, shellMapper } from '../../../src/viz/grd/shellProj.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps
const H_GEO = 35786.033
const D2R = Math.PI / 180
const RS = A + H_GEO

// GEO @0°E、天底指向的天线基底（igrid=6：X=az, Y=el；el=0 时离轴角 = |az|，向东为正）
const basis = antennaBasis(0, 0, 0, 0, 0, H_GEO)
const dirAz = (azDeg) => gridDir(6, azDeg, 0)
const limbDeg = Math.asin(A / RS) / D2R    // 赤道地平半角 ≈ 8.7005°

// ---- ① 地平裕度在地平处穿零 ----
{
  const inner = projectLimb(dirAz(limbDeg - 0.05), basis)
  const outer = projectLimb(dirAz(limbDeg + 0.05), basis)
  const at = projectLimb(dirAz(limbDeg), basis)
  ok('① 地平内 vis>0', inner.vis > 0, 'vis=' + inner.vis.toExponential(2))
  ok('① 地平外 vis<0', outer.vis < 0, 'vis=' + outer.vis.toExponential(2))
  ok('① 相切处 |vis| 量级最小', Math.abs(at.vis) < Math.abs(inner.vis) && Math.abs(at.vis) < Math.abs(outer.vis))
  // 恰在地平的那个点，仰角必须是 0（这才是「地球可见地平」的定义）
  const el = elevationDeg(at.lon, at.lat, basis.S)
  ok('① 地平点仰角 ≈ 0°', Math.abs(el) < 1e-3, 'el=' + el.toExponential(2) + '°')
}

// ---- ② 越地平后 limbOutside 的落点是假读数（这就是原先画出来的那个白点）----
{
  // 网格铺 az∈[0,180]、取 el=0 那一行（NY 必须 ≥2：gridDirs 的 dy=(YE−YS)/(NY−1)），
  // 用 projectGrid(limbOutside=true) 走与画面完全相同的那条路
  const N = 181
  const set = { XS: 0, YS: 0, XE: 180, YE: 1, NX: N, NY: 2 }
  const proj = projectGrid(set, 6, basis, null, null, true)
  const lonAt = (az) => proj.lon[az]
  ok('② 地平内落点为真交点', proj.vis[5] > 0 && Math.abs(lonAt(5) - 30.181) < 0.01, 'az=5° → ' + lonAt(5).toFixed(3) + '°E')
  // 越地平后：经度 ≈ 90−az，且【随离轴角增大而回退】
  const chk = [10, 20, 45, 88].every((az) => proj.vis[az] < 0 && Math.abs(lonAt(az) - (90 - az)) < 0.02)
  ok('② 越地平落点 ≈ 90°−离轴角（假读数）', chk, [10, 20, 45, 88].map((az) => `${az}°→${lonAt(az).toFixed(1)}`).join(' '))
  ok('② 越地平后落点往回走（拖得越远反而越靠近星下点）', lonAt(10) > lonAt(20) && lonAt(20) > lonAt(45) && lonAt(45) > lonAt(88))
  ok('② 离轴超 90° 翻到另一半球', lonAt(120) < 0, 'az=120° → ' + lonAt(120).toFixed(1) + '°E')
  // 而这些点的经纬度全是有限数 —— 原先那道 Number.isFinite 关卡从来不触发
  const allFinite = [10, 20, 45, 88, 120, 179].every((az) => Number.isFinite(lonAt(az)) && Number.isFinite(proj.lat[az]))
  ok('② 假读数全是有限数（原判据失效的根因）', allFinite)
  // 新判据把它们全部拦下
  const gated = [10, 20, 45, 88, 120, 179].every((az) => projectLimb(dirAz(az), basis).vis < 0)
  ok('② 新判据（vis≥0）逐个拦下', gated)

  // ---- ③ 未越地平时新老口径逐位一致 ----
  let same = true, worst = 0
  for (let az = 0; az <= 8; az++) {
    const r = projectLimb(dirAz(az), basis)
    if (!(r.vis >= 0 && proj.vis[az] >= 0)) { same = false; break }
    worst = Math.max(worst, Math.abs(r.lon - lonAt(az)), Math.abs(r.lat - proj.lat[az]))
  }
  // projectGrid 走 Float32 + 4 次定点迭代的内联反算，projectLimb 走共享版 20 次 → 差在 float32 量级
  ok('③ 地平内新老落点一致', same && worst < 1e-3, '最大差 ' + worst.toExponential(2) + '°')
}

// ---- ④ 对星壳层：strict 未命中返回 null ----
{
  const R = A + 550                                  // LEO 壳层；GEO 在壳【外】
  const g = shellGeom(basis, R, 0)
  ok('④ 源星在壳外', g.inside === false)
  const shellHalf = Math.asin(R / RS) / D2R          // 壳层角半径 ≈ 9.46°
  const loose = shellMapper(6, basis, g, 'near')
  const strict = shellMapper(6, basis, g, 'near', true)
  const inAz = shellHalf - 1, outAz = shellHalf + 5
  ok('④ 打中时两版一致', (() => {
    const a = loose(inAz, 0), b = strict(inAz, 0)
    return a && b && near(a.lon, b.lon, 1e-9) && near(a.lat, b.lat, 1e-9)
  })(), 'az=' + inAz.toFixed(2) + '°')
  ok('④ 未打中：strict → null', strict(outAz, 0) === null, 'az=' + outAz.toFixed(2) + '°')
  ok('④ 未打中：非 strict 仍给相切兜底点（不是射线真正到达的位置）', (() => {
    const p = loose(outAz, 0)
    return !!p && Number.isFinite(p.lon)
  })())
  ok('④ 反天底方向两版皆 null', strict(150, 0) === null && loose(150, 0) === null)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
