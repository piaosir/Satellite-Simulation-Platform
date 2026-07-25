// 环境场渲染端自测：上色（值→RGBA）与等值线（栅格→经纬折线）。运行：npm test
// 被测文件是渲染端 ESM（src/viz/env/*.js），故本测试自身也是 .mjs。
//
// 关键不变式：
//   ① 无效值（NaN）与掩膜外一律透明——不能把「没有数据」画成某个颜色；
//   ② 分级填色同一档内必须严格同色（档边界就是等值线，档内出现渐变就读不出档）；
//   ③ 值域用分位拉伸而不是极值——长尾场（降雨率）用极值会把主区压成一个颜色；
//   ④ 栅格取值（状态栏读数）与栅格自身的双线性一致，且行 0 = 北不能翻；
//   ⑤ 等值线的经纬映射必须是格心口径（差半格 = 图上差半个格子）；
//   ⑥ 等值线只在给定值域内定级，且级差按给定 step 走。

import { colorize, autoDomain, legendStops, bandEdges, valueAt, fmtValue, lutCss, colorLut } from '../../../src/viz/env/envRaster.js'
import { buildContours, levelsFor, labelPoints } from '../../../src/viz/env/envContour.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const px = (rgba, i) => [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]]

console.log('=== 环境场渲染端测试 ===\n')

// 4×3 的线性场：值 = 列号（0..3），第 5 个点挖成 NaN
const NX = 4, NY = 3
const Z = new Float32Array(NX * NY)
for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) Z[j * NX + i] = i
Z[5] = NaN
const LAND = new Uint8Array(NX * NY).fill(1); LAND[0] = 0

// ① 透明规则
{
  const rgba = colorize(Z, LAND, { lo: 0, hi: 3, scheme: 'turbo', bands: 0, opacity: 1 })
  ok('NaN 画透明', px(rgba, 5)[3] === 0)
  ok('有效值不透明', px(rgba, 1)[3] === 255)
  const m = colorize(Z, LAND, { lo: 0, hi: 3, scheme: 'turbo', bands: 0, landOnly: true, opacity: 1 })
  ok('掩膜外画透明', px(m, 0)[3] === 0 && px(m, 1)[3] === 255)
  const a = colorize(Z, LAND, { lo: 0, hi: 3, scheme: 'turbo', opacity: 0.5 })
  ok('整层不透明度写进 alpha 通道', px(a, 1)[3] === 128, String(px(a, 1)[3]))
}

// ② 色标两端与单调性
{
  const rgba = colorize(Z, null, { lo: 0, hi: 3, scheme: 'turbo', bands: 0, opacity: 1 })
  const lut = colorLut('turbo', false)
  ok('低端取色标首色', px(rgba, 0)[0] === lut[0] && px(rgba, 0)[2] === lut[2])
  ok('高端取色标末色', px(rgba, 3)[0] === lut[255 * 3] && px(rgba, 3)[2] === lut[255 * 3 + 2])
  const inv = colorize(Z, null, { lo: 0, hi: 3, scheme: 'turbo', invert: true, opacity: 1 })
  ok('反相 = 首末对调', px(inv, 0)[0] === px(rgba, 3)[0] && px(inv, 3)[0] === px(rgba, 0)[0])
  // 域外值夹紧（不 wrap 成另一端的颜色）
  const out = colorize(new Float32Array([-99, 99]), null, { lo: 0, hi: 3, scheme: 'turbo', opacity: 1 })
  ok('域外值夹紧到两端', px(out, 0)[0] === px(rgba, 0)[0] && px(out, 1)[0] === px(rgba, 3)[0])
}

// ③ 分级填色：档内严格同色、档间必然换色
{
  const v = new Float32Array([0, 0.4, 0.6, 1.0, 1.4, 1.6])   // 域 [0,2]、2 档 → 前 3 个一档、后 3 个一档
  const rgba = colorize(v, null, { lo: 0, hi: 2, scheme: 'turbo', bands: 2, opacity: 1 })
  const same = (a, b) => px(rgba, a).join() === px(rgba, b).join()
  ok('第 1 档内同色', same(0, 1) && same(1, 2))
  ok('第 2 档内同色', same(3, 4) && same(4, 5))
  ok('两档不同色', !same(2, 3))
  const e = bandEdges(0, 2, 2)
  ok('分档边界 = [0,1,2]', e.join() === '0,1,2')
  ok('图例分级给每档一色', legendStops('turbo', false, 2).length === 2)
  ok('图例连续给渐变采样', legendStops('turbo', false, 0).length === 32)
}

// ④ 值域：分位拉伸 vs 极值
{
  const stats = { min: 0, max: 140, mean: 30, p2: 1, p50: 25, p98: 95 }
  ok('分位拉伸取 p2~p98', autoDomain(stats, 'p2p98').join() === '1,95')
  ok('极值模式取 min~max', autoDomain(stats, 'minmax').join() === '0,140')
  ok('退化统计回落到极值', autoDomain({ min: 5, max: 9, p2: 7, p50: 7, p98: 7 }, 'p2p98').join() === '5,9')
  ok('无统计返回 null', autoDomain(null, 'p2p98') === null)
}

// ⑤ 栅格取值：格心口径 + 行 0 = 北
{
  // 2×2 格、全球 bbox：格心在 (±90, ±45) 的位置上
  const f = {
    nx: 2, ny: 2, values: new Float32Array([10, 20, 30, 40]),
    bbox: { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 }
  }
  ok('北半球西格 = 10（行 0 = 北）', valueAt(f, 45, -90) === 10)
  ok('北半球东格 = 20', valueAt(f, 45, 90) === 20)
  ok('南半球西格 = 30', valueAt(f, -45, -90) === 30)
  ok('两格心之间取中值', Math.abs(valueAt(f, 45, 0) - 15) < 1e-6, String(valueAt(f, 45, 0)))
  ok('经度环绕（+270° ≡ −90°）', valueAt(f, 45, 270) === 10)
  const g = { ...f, values: new Float32Array([10, NaN, 30, 40]) }
  ok('邻域含 NaN 返回 NaN', Number.isNaN(valueAt(g, 45, 0)))
}

// ⑥ 格式化
{
  ok('按小数位', fmtValue(12.345, 1) === '12.3')
  ok('无效值给破折号', fmtValue(NaN, 2) === '—')
  ok('大数带千分位', /8,848/.test(fmtValue(8848.2, 0)) || fmtValue(8848.2, 0) === '8848')
  ok('压暗色比原色暗', lutCss('turbo', false, 0.5, 0.55) !== lutCss('turbo', false, 0.5, 1))
}

// ⑦ 定级
{
  ok('按 step 定级', levelsFor(0, 10, 2).join() === '0,2,4,6,8,10')
  ok('step 不整除也落在整数倍上', levelsFor(1.3, 6.9, 2).join() === '2,4,6')
  ok('自动定级条数适中', levelsFor(0, 100, 0, 8).length >= 4)
  ok('退化区间给空', levelsFor(5, 5, 1).length === 0)
}

// ⑧ 等值线：线性场 → 一条经线；映射按格心
{
  // 40×20 全球栅格，值 = 经度（-180..180 线性）→ level=0 的等值线应是 lon≈0 的一条竖线
  const nx = 40, ny = 20
  const bbox = { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 }
  const dLon = 360 / nx, dLat = 180 / ny
  const z = new Float32Array(nx * ny)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = bbox.lonMin + (i + 0.5) * dLon
  const field = { values: z, nx, ny, bbox, stats: { min: -171, max: 171 } }
  const cs = buildContours(field, { lo: -180, hi: 180, step: 90 })
  ok('按 step=90 出 3 档（−90/0/90）', cs.length === 3, cs.map((c) => c.level).join(','))
  const zero = cs.find((c) => c.level === 0)
  let maxOff = 0, minLat = 90, maxLat = -90
  for (const ln of zero.lines) for (const p of ln) {
    maxOff = Math.max(maxOff, Math.abs(p[0]))
    minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1])
  }
  ok('0° 等值线落在 lon=0 上（格心映射正确）', maxOff < 1e-9, `最大偏移 ${maxOff.toExponential(1)}°`)
  ok('等值线纵贯全图', maxLat > 80 && minLat < -80, `${minLat.toFixed(1)}~${maxLat.toFixed(1)}°N`)
  // 纬向线性场 → 等值线是纬线，检查 lat 映射（行 0 = 北）没翻
  const z2 = new Float32Array(nx * ny)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z2[j * nx + i] = bbox.latMax - (j + 0.5) * dLat
  const cs2 = buildContours({ values: z2, nx, ny, bbox, stats: { min: -85, max: 85 } }, { lo: -90, hi: 90, step: 45 })
  const l45 = cs2.find((c) => c.level === 45)
  let latOff = 0
  for (const ln of l45.lines) for (const p of ln) latOff = Math.max(latOff, Math.abs(p[1] - 45))
  ok('45°N 等值线落在 lat=45 上（行 0 = 北未翻）', latOff < 1e-9, `最大偏移 ${latOff.toExponential(1)}°`)
  // 无数据区（这里模拟顶部 3 行缺数）：线在缺数区边缘停住，绝不跨着无解区插一条不存在的线
  const z3 = Float32Array.from(z)
  for (let j = 0; j < 3; j++) for (let i = 0; i < nx; i++) z3[j * nx + i] = NaN
  const cs3 = buildContours({ values: z3, nx, ny, bbox, stats: { min: -171, max: 171 } }, { lo: -180, hi: 180, step: 90 })
  let topLat = -90
  for (const c of cs3) for (const l of c.lines) for (const p of l) topLat = Math.max(topLat, p[1])
  const noDataEdge = bbox.latMax - 3 * dLat   // 缺数区下沿（第 3 行格心之上一律无解）
  ok('缺数区外照常出线', cs3.length === 3, cs3.map((c) => c.level).join(','))
  ok('线不进缺数区', topLat <= noDataEdge + 1e-9, `最高 ${topLat.toFixed(1)}°N ≤ ${noDataEdge.toFixed(1)}°N`)
  ok('线不越经度边界', cs3.every((c) => c.lines.every((l) => l.every((p) => p[0] >= -180 && p[0] <= 180))))
  // 标注点
  const an = labelPoints(zero.lines, { max: 3 })
  ok('沿线给出标注点与角度', an.length >= 1 && Number.isFinite(an[0].a), `${an.length} 个 / ${an[0].a.toFixed(0)}°`)
  ok('竖线标注角度接近 ±90°', Math.abs(Math.abs(an[0].a) - 90) < 1e-6, `${an[0].a}°`)
}

// ⑨ 3D 贴图球定向：把球真建出来，逐顶点比对「贴图坐标 (u,v) 处的位置」与「该经纬度的位置」。
//   贴图偏 90°／上下颠倒在代码里看不出来（图照样显示，只是错位），只有这样逐点比对才拦得住。
{
  const { SphereGeometry } = await import('three')
  const { envSphereParams, uvToLonLat, ENV_R } = await import('../../../src/viz/env/envSphere.js')

  // 与 globe3d/scene.js 的 llaToVec 同式（改那边这里要跟着改，本测试即为此而设）
  const llaToVec = (lat, lon) => {
    const phi = (90 - lat) * Math.PI / 180, theta = (lon + 180) * Math.PI / 180
    return [-Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)]
  }
  const checkBBox = (bbox, name) => {
    const P = envSphereParams(bbox, { w: 8, h: 4 })
    const geo = new SphereGeometry(P.radius, P.widthSeg, P.heightSeg, P.phiStart, P.phiLength, P.thetaStart, P.thetaLength)
    const pos = geo.attributes.position, uv = geo.attributes.uv
    let worst = 0
    for (let i = 0; i < pos.count; i++) {
      const ll = uvToLonLat(bbox, uv.getX(i), 1 - uv.getY(i))   // THREE 的 uv.y 自下而上 → 1−y = 自北向南的 v
      const w = llaToVec(ll.lat, ll.lon)
      worst = Math.max(worst,
        Math.abs(pos.getX(i) - w[0] * ENV_R), Math.abs(pos.getY(i) - w[1] * ENV_R), Math.abs(pos.getZ(i) - w[2] * ENV_R))
    }
    // 容差 1e-6：顶点位置在 THREE 里按 Float32 存（ε≈1.2e-7），比这更紧就是在测浮点而不是测定向；
    // 真错位（偏 90°／上下颠倒）的偏差是 0.1~2 的量级，与此差着六个数量级，拦得住
    ok(`贴图球定向：${name}（逐顶点 uv↔经纬一致）`, worst < 1e-6, `最大偏差 ${worst.toExponential(1)}`)
    return { P, geo }
  }
  const { P } = checkBBox({ lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }, '全球')
  ok('全球 phiStart = 0（无 90° 偏移）', Math.abs(P.phiStart) < 1e-12, String(P.phiStart))
  ok('全球 thetaStart = 0（v=0 在北极）', Math.abs(P.thetaStart) < 1e-12)
  checkBBox({ lonMin: 70, lonMax: 140, latMin: 10, latMax: 55 }, '局部（中国片区）')
  ok('半径夹在陆地(1.0)与岸线(1.0004)之间', ENV_R > 1 && ENV_R < 1.0004, String(ENV_R))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
