// 对星覆盖分析几何核自测（src/viz/grd/shellProj.js）。运行：npm test
// 被测文件是渲染端 ESM，故本测试自身也是 .mjs。
//
// 这个核决定「波束打在哪层壳的哪一支上、哪一段被地球挡住」，画错了整张图都是错的。四条不变式：
//   ① 近侧支永不被地球遮挡（它在地球【前面】）；远侧支可见 ⟺ 这条射线压根没打中地球；
//   ② 卫星在壳【内】（上方壳层）时每条射线恰一个交点——包括反天底方向，这正是「背后的星」那一侧；
//   ③ 裕度必须在相切处严格穿零（bandGeometry 靠线性插值找这个零点切边界，差一点边缘就是锯齿）；
//   ④ 参数域 ↔ 方向 往返可逆（几何切在参数域、顶点再投出去，往返一旦不闭合等值线就整体偏）。
import { antennaBasis, antennaBasisAzEl, antennaBasisEcef, antennaBasisAbout, dirAzElAbout, gridDir, gridXY, fieldDb, bandGeometry } from '../../../src/viz/grd/coverage.js'
import { geodeticToEcef, geocentricToEcef } from '../../../src/viz/wgs84.js'
import {
  shellGeom, shellMargin, earthMargin, visMargin, shellT, projectDir, shellGrid,
  shellMapper, dirToParam, losBlocked, shellCandidates, tessellateSegs, tessellateFills,
  boresightShellPoint
} from '../../../src/viz/grd/shellProj.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps
const A = 6378.137, H_GEO = 35786.033
const D2R = Math.PI / 180, R2D = 180 / Math.PI

// GEO @0°E、天底指向的天线基底（x=西, y=北, z=天底）
const basis = antennaBasis(0, 0, 0, 0, 0, H_GEO)
const rS = Math.hypot(basis.S[0], basis.S[1], basis.S[2])
// 天线系 (az,el) → ECEF 单位矢量（igrid=6 约定，与 shellGrid 内部同一条路）
function dirAt(azDeg, elDeg) {
  const d = gridDir(6, azDeg, elDeg), { x, y, z } = basis
  const e = [x[0] * d[0] + y[0] * d[1] + z[0] * d[2], x[1] * d[0] + y[1] * d[1] + z[1] * d[2], x[2] * d[0] + y[2] * d[1] + z[2] * d[2]]
  const n = Math.hypot(e[0], e[1], e[2])
  return [e[0] / n, e[1] / n, e[2] / n]
}

// ---- 基底自检（后面所有算例都以它为前提）----
{
  ok('GEO 星地心距 = 42164.17 km', near(rS, 42164.17, 1e-3), `rS=${rS.toFixed(3)}`)
  const nad = dirAt(0, 0)
  ok('天底方向 = −x̂', near(nad[0], -1, 1e-12) && near(nad[1], 0, 1e-12) && near(nad[2], 0, 1e-12))
}

// ==================== ① 下方壳层：近/远两支 ====================
{
  const alt = 550, R = A + alt
  const g = shellGeom(basis, R, 0)
  ok('550km 壳在卫星下方 → inside=false', g.inside === false)

  // 天底方向：近侧支 = 星到壳顶，远侧支 = 星到壳的另一面（穿过地心那侧）
  const d0 = dirAt(0, 0)
  ok('天底近侧支 t = rS − R', near(shellT(g, d0, 'near'), rS - R, 1e-6), `t=${shellT(g, d0, 'near').toFixed(3)}`)
  ok('天底远侧支 t = rS + R', near(shellT(g, d0, 'far'), rS + R, 1e-6), `t=${shellT(g, d0, 'far').toFixed(3)}`)

  // 近侧支落点在星下点、远侧支落在对趾
  const pn = projectDir(g, d0, 'near'), pf = projectDir(g, d0, 'far')
  ok('近侧支落在星下点 (0°E, 0°N)', near(pn.lon, 0, 1e-9) && near(pn.lat, 0, 1e-9), `${pn.lon.toFixed(4)},${pn.lat.toFixed(4)}`)
  ok('远侧支落在对趾 (180°E, 0°N)', near(Math.abs(pf.lon), 180, 1e-9) && near(pf.lat, 0, 1e-9), `${pf.lon.toFixed(4)},${pf.lat.toFixed(4)}`)

  // ★ 不变式①：天底的远侧支穿过地球 → 被挡；近侧支不受地球影响
  ok('天底远侧支被地球挡住', visMargin(g, d0, 'far') < 0, `vis=${visMargin(g, d0, 'far').toExponential(2)}`)
  ok('天底近侧支不被遮挡（只受壳层约束）', near(visMargin(g, d0, 'near'), shellMargin(g, d0), 1e-12))

  // 壳层相切半角 α=asin(R/rS)≈9.456°、地球（椭球）≈8.70°：取 9.0° —— 穿过壳层但擦过地球
  const alphaShell = Math.asin(R / rS) / D2R
  ok('550km 壳的相切半角 ≈ 9.456°', near(alphaShell, 9.456, 2e-3), `${alphaShell.toFixed(3)}°`)
  const d9 = dirAt(0, 9.0)
  ok('9.0° 方向：在壳层锥内', shellMargin(g, d9) > 0, `m=${shellMargin(g, d9).toFixed(5)}`)
  ok('9.0° 方向：没打中地球', earthMargin(g, d9) < 0, `mE=${earthMargin(g, d9).toFixed(5)}`)
  ok('9.0° 方向：远侧支可见（掠过地球上方后落在壳的另一面）', visMargin(g, d9, 'far') > 0)

  // 8.0° 方向：既穿壳层也打中地球 → 远侧支不可见、近侧支可见
  const d8 = dirAt(0, 8.0)
  ok('8.0° 方向：打中地球 → 远侧支不可见', earthMargin(g, d8) > 0 && visMargin(g, d8, 'far') < 0)
  ok('8.0° 方向：近侧支可见', visMargin(g, d8, 'near') > 0)

  // 10.0° 方向：越过壳层相切角 → 两支都没有交点
  const d10 = dirAt(0, 10.0)
  ok('10.0° 方向：错过壳层', shellMargin(g, d10) < 0 && !(shellT(g, d10, 'near') > 0))

  // ★ 不变式③：裕度在相切角处严格穿零，且左右符号相反
  const eps = 1e-4
  const mIn = shellMargin(g, dirAt(0, alphaShell - eps)), mOut = shellMargin(g, dirAt(0, alphaShell + eps))
  ok('壳层裕度在相切处穿零', mIn > 0 && mOut < 0 && Math.abs(mIn) < 1e-4 && Math.abs(mOut) < 1e-4,
    `in=${mIn.toExponential(2)} out=${mOut.toExponential(2)}`)
  // 裕度已归一到角度量纲：偏离相切 0.1° 时裕度 ≈ 0.1°的弧度值
  const dm = shellMargin(g, dirAt(0, alphaShell - 0.1))
  ok('裕度量纲 ≈ 弧度角（偏 0.1° → ≈1.75e-3）', Math.abs(dm - 0.1 * D2R) < 0.1 * D2R * 0.05, `m=${dm.toExponential(3)}`)
}

// ==================== ② 上方壳层（背后的星那一侧）====================
{
  const alt = 40000, R = A + alt           // R=46378 > rS=42164 → 卫星在壳内
  const g = shellGeom(basis, R, 0)
  ok('40000km 壳在卫星上方 → inside=true', g.inside === true)

  // 反天底（背离地球）：恰一个交点，且不被地球挡
  const dBack = [1, 0, 0]                   // +x̂ = 背离地心
  const tb = shellT(g, dBack, 'far')
  ok('反天底方向恰一个交点 t = R − rS', near(tb, R - rS, 1e-6), `t=${tb.toFixed(3)}`)
  ok('反天底方向不被地球遮挡', visMargin(g, dBack, 'far') > 0)
  const pb = projectDir(g, dBack, 'far')
  ok('反天底落点在 0°E 赤道（星的正上方）', near(pb.lon, 0, 1e-9) && near(pb.lat, 0, 1e-9))

  // 天底方向：也有交点（穿过地球后落在对面），但被地球挡
  const d0 = dirAt(0, 0)
  ok('上方壳层天底方向有交点', shellT(g, d0, 'far') > 0)
  ok('上方壳层天底方向被地球挡住', visMargin(g, d0, 'far') < 0)

  // 侧向 90°（沿轨道切向）：不打地球 → 可见
  const dSide = [0, 1, 0]
  ok('侧向 90° 可见', visMargin(g, dSide, 'far') > 0)

  // 上方壳层的 shellMargin 恒为大正数 → min() 里只剩地球遮挡起作用
  ok('上方壳层 shellMargin 恒正（不参与裁剪）', shellMargin(g, d0) > 100 && shellMargin(g, dBack) > 100)
}

// ==================== 大气排除高度 ====================
{
  const g0 = shellGeom(basis, A + 550, 0)
  const g100 = shellGeom(basis, A + 550, 100)
  // 恰好擦过地球表面的方向（8.75°，介于椭球地平 8.70° 与 100km 抬高后的地平之间）
  const d = dirAt(0, 8.75)
  ok('排除高度 0：8.75° 擦过地球（不挡）', earthMargin(g0, d) < 0, `m=${earthMargin(g0, d).toExponential(2)}`)
  ok('排除高度 100km：同一方向被挡', earthMargin(g100, d) > 0, `m=${earthMargin(g100, d).toExponential(2)}`)
}

// ==================== ③ 视线遮挡（目标星取值用）====================
{
  const S = basis.S                                    // GEO @0°E
  const opp = [-(A + H_GEO), 0, 0]                     // GEO @180°E
  ok('对侧 GEO 星：视线被地球挡住', losBlocked(S, opp, 0) === true)
  const near10 = [(A + H_GEO) * Math.cos(10 * D2R), (A + H_GEO) * Math.sin(10 * D2R), 0]   // GEO @10°E
  ok('同步带上 10° 外的星：视线通畅', losBlocked(S, near10, 0) === false)
  // 目标星在地球【前面】（星下点上方 550km）：射线延长后会打到地球，但段内不挡
  const front = [A + 550, 0, 0]
  ok('地球前方的目标：段内不挡（不能按无限射线判）', losBlocked(S, front, 0) === false)
  // 擦边：地球背面稍偏一点的低轨星 → 挡
  const behind = [-(A + 550), 0, 0]
  ok('地球背面的低轨目标：被挡', losBlocked(S, behind, 0) === true)
}

// ==================== ④ 参数域 ↔ 方向 往返 ====================
{
  const g = shellGeom(basis, A + 550, 0)
  const map = shellMapper(6, basis, g, 'near')
  for (const [az, el] of [[0, 0], [2, -3], [-4.5, 1.25], [1, 8]]) {
    const p = map(az, el)
    ok(`参数域(${az},${el}) → 壳层点存在`, !!p)
    if (!p) continue
    // 落点 ECEF → 反解参数域，应回到原 (az,el)
    const R = A + 550
    const la = p.lat * D2R, lo = p.lon * D2R
    const P = [R * Math.cos(la) * Math.cos(lo), R * Math.cos(la) * Math.sin(lo), R * Math.sin(la)]
    const back = dirToParam(6, basis, P)
    ok(`参数域往返闭合 (${az},${el})`, back && near(back[0], az, 1e-6) && near(back[1], el, 1e-6),
      back ? `${back[0].toFixed(6)},${back[1].toFixed(6)}` : 'null')
  }
}

// ==================== 线段细分 ====================
{
  const g = shellGeom(basis, A + 550, 0)
  const map = shellMapper(6, basis, g, 'near')
  // 一条横跨 6° 的参数域线段：投到壳层后会被切成若干短段（每段 ≤2° 弧）
  const outs = tessellateSegs([[[-3, 0], [3, 0]]], map)
  ok('长线段被细分', outs.length > 1, `${outs.length} 段`)
  // 首尾必须与原端点一致（细分只加点不动端点）
  const a = map(-3, 0), b = map(3, 0)
  ok('细分保端点', near(outs[0][0][0], a.lon, 1e-9) && near(outs[outs.length - 1][1][0], b.lon, 1e-9))
}

// ==================== 壳层候选（「从星座取」挑选器吃的那份）====================
// 归并走密度找峰而不是单链接龙 —— 全量在轨目录里 LEO 高度近乎连续，接龙会把上万颗串成一个桶。
const S = (name, groupLabel, altKm, incDeg, ecc = 0) => ({ name, noradId: name, groupLabel, altKm, incDeg, ecc })
{
  const sats = [
    S('SL-1', 'Starlink', 548, 53.0), S('SL-2', 'Starlink', 550, 53.2), S('SL-3', 'Starlink', 552, 70.0),
    S('OW-1', 'OneWeb', 1200, 87.9), S('OW-2', 'OneWeb', 1201, 87.9),
    S('GEO-1', 'GEO', 35786, 0.05), S('MOL', '其他', 20000, 63.4, 0.72)
  ]
  const c = shellCandidates(sats, 60)
  ok('归并成 4 层', c.length === 4, JSON.stringify(c.map((x) => `${x.altKm}×${x.n}`)))
  ok('按高度升序', c.every((x, i) => i === 0 || c[i - 1].altKm < x.altKm))
  ok('层高度取层内中位数', c[0].altKm === 550 && c[0].n === 3)
  ok('550 层带出星座与星数', c[0].groups.length === 1 && c[0].groups[0].name === 'Starlink' && c[0].groups[0].n === 3, JSON.stringify(c[0].groups))
  ok('550 层带出倾角范围', c[0].incLo === 53 && c[0].incHi === 70, `${c[0].incLo}–${c[0].incHi}`)
  ok('550 层带出高度散布', c[0].loKm === 548 && c[0].hiKm === 552)
  ok('层内挂着卫星清单', c[0].sats.length === 3 && c[0].sats[0].name === 'SL-1')
  ok('大偏心率被标出来', c.find((x) => x.altKm === 20000).eccMax === 0.72)
  ok('星座按星数降序', shellCandidates([S('a', 'B组', 500, 0), S('b', 'A组', 500, 0), S('c', 'A组', 501, 0)], 60)[0].groups[0].name === 'A组')
  ok('每颗星恰好归一层', c.reduce((a, x) => a + x.n, 0) === sats.length)
  ok('空输入不崩', shellCandidates([]).length === 0 && shellCandidates(null).length === 0)
  ok('无效高度被剔除', shellCandidates([S('x', 'g', NaN, 0), S('y', 'g', -10, 0), S('z', 'g', 600, 0)], 60).length === 1)
}
// 密集背景 + 星座尖峰：接龙聚类会把这 2000 颗全串成一层，密度找峰必须把 550 的尖峰单独挑出来
{
  const sats = []
  for (let i = 0; i < 1200; i++) sats.push(S('bg' + i, '其他', 300 + i * 0.5, 50))       // 300~900 km 连续铺满
  for (let i = 0; i < 800; i++) sats.push(S('sl' + i, 'Starlink', 549 + (i % 5) * 0.4, 53))
  const c = shellCandidates(sats, 60)
  const peak = c.find((x) => Math.abs(x.altKm - 550) < 6)
  ok('尖峰独立成层', !!peak && peak.groups[0].name === 'Starlink' && peak.groups[0].n === 800, peak ? `${peak.altKm} km · ${peak.n} 星` : '没找到')
  ok('背景不塌成一层', c.length >= 8 && c.length <= 20, `${c.length} 层`)
  ok('层数受 跨度/tol 约束', c.every((x) => x.hiKm - x.loKm <= 2 * 60 + 1), JSON.stringify(c.map((x) => +(x.hiKm - x.loKm).toFixed(0))))
  ok('总数守恒', c.reduce((a, x) => a + x.n, 0) === sats.length)
  ok('容差调小 → 层更细', shellCandidates(sats, 20).length > c.length)
}

// ==================== 全链路：参数域切几何 → 逐壳投影 → 细分保真度 ====================
// 掠地平指向（9.5°，介于地球 8.70° 与 550km 壳 9.456° 之间）是投影拉伸最狠的配置：
// 近相切处参数域一小格能被拉成几百公里。这一段验三件事：
//   ① 三支（近/远/上方壳）在同一指向下同时出图 —— 这正是「对地方向 + 背后」都要算的那个场景；
//   ② tessellateFills 输出的全是三角形（counts 恒为 3，渲染端才敢跳过自己那套经纬度域细分）；
//   ③ 输出边的球面弧长受 MAX_ARC(2°) 约束 —— 超标的只应出现在近相切、且由 DEPTH_CAP 兜底，数量要少。
{
  const gridSet = { XS: -12, YS: -12, XE: 12, YE: 12, NX: 121, NY: 121 }
  const N = gridSet.NX * gridSet.NY
  const P1 = new Float32Array(N), P2 = new Float32Array(N)
  const bw = 6, kk = 4 * Math.LN2 / (bw * bw)
  const dx = 24 / (gridSet.NX - 1), dy = 24 / (gridSet.NY - 1)
  for (let r = 0; r < gridSet.NY; r++) {
    for (let c = 0; c < gridSet.NX; c++) {
      const x = -12 + dx * c, y = -12 + dy * r
      P1[r * gridSet.NX + c] = Math.exp(-kk * (x * x + y * y)) * 1e5
    }
  }
  const bG = antennaBasisAzEl(0, 0, H_GEO, 0, 9.5, 0)
  const { gx, gy } = gridXY(gridSet)
  const field = fieldDb({ P1, P2, NX: gridSet.NX, NY: gridSet.NY }, null, { pol: 'P1' })
  const levels = [field.max - 5, field.max - 4, field.max - 3, field.max - 2, field.max - 1]

  const seen = []
  let maxArc = 0, overCnt = 0, edgeCnt = 0, allTri = true
  for (const [alt, brs] of [[550, ['near', 'far']], [40000, ['far']]]) {
    const gg = shellGeom(bG, A + alt, 0)
    for (const br of brs) {
      const sg = shellGrid(gridSet, 6, bG, gg, br, null, null)
      const geo = bandGeometry({ lon: gx, lat: gy, vis: sg.vis, db: field.db, NX: gridSet.NX, NY: gridSet.NY }, levels, true, null, null, 1)
      const map = shellMapper(6, bG, gg, br)
      const fills = tessellateFills(levels.map((_, i) => ({ color: [0, 0, 0], verts: geo.fills[i].verts, counts: geo.fills[i].counts })).filter((b) => b.counts.length), map)
      const lines = levels.map((_, i) => tessellateSegs(geo.lines[i], map)).filter((s) => s.length)
      if (!fills.length && !lines.length) continue
      seen.push(`${alt}km-${br}`)
      for (const fb of fills) {
        for (let j = 0; j < fb.counts.length; j++) if (fb.counts[j] !== 3) allTri = false
        for (let i = 0; i + 5 < fb.verts.length; i += 6) {
          const tri = [[fb.verts[i], fb.verts[i + 1]], [fb.verts[i + 2], fb.verts[i + 3]], [fb.verts[i + 4], fb.verts[i + 5]]]
          for (let e = 0; e < 3; e++) {
            const a = tri[e], b = tri[(e + 1) % 3]
            const la = a[1] * D2R, lb = b[1] * D2R, dlo = (a[0] - b[0]) * D2R
            const ca = Math.cos(la), cb = Math.cos(lb)
            const arc = Math.hypot(ca * Math.cos(dlo) - cb, ca * Math.sin(dlo), Math.sin(la) - Math.sin(lb))
            edgeCnt++; if (arc > maxArc) maxArc = arc
            if (arc > 0.0351) overCnt++
          }
        }
      }
    }
  }
  ok('掠地平指向：近侧/远侧/上方壳三支同时出图', seen.length === 3, seen.join(' | '))
  ok('填充输出全是三角形（counts 恒 3）', allTri)
  ok('输出边弧长受 2° 约束（超标 <2%，仅近相切处由深度上限兜底）',
    edgeCnt > 0 && overCnt / edgeCnt < 0.02, `${edgeCnt} 条边，超标 ${overCnt} 条，最大 ${(maxArc * R2D).toFixed(2)}°`)
}

// ==================== 空层归因（用户实际踩到的那个场景）====================
// GEO 源星 + 天底 3° 波束，壳层建在 40000 km（高于源星）→ 一片空白。空白必须能说清是哪种空：
//   maxShellM<0 → 波束未及；maxVis<0 → 全被地球遮挡；两者都 ≥0 却没几何 → 低于最低档。
// ★ 归因必须在【热区盒】内取极值，不能拿整张网格：±12° 的网格四角早就跑出地球 8.7° 的圆盘外，
//   全网格的 maxVis 恒为正 → 会把「全被地球遮挡」误报成「低于最低档」。
{
  const bN = antennaBasisAzEl(0, 0, H_GEO, 0, 0, 0)              // 天底指向
  const gridSet = { XS: -12, YS: -12, XE: 12, YE: 12, NX: 121, NY: 121 }
  // 3° 波束的 −5dB 半径 ≈1.93° → 热区盒取 ±2.2°（对应列/行下标）
  const idx = (deg) => Math.round((deg + 12) / 24 * (gridSet.NX - 1))
  const box = { r0: idx(-2.2), r1: idx(2.2), c0: idx(-2.2), c1: idx(2.2) }

  const gHigh = shellGeom(bN, A + 40000, 0)
  ok('40000km 壳高于 GEO 源星 → 单支', gHigh.inside === true)
  const sgHigh = shellGrid(gridSet, 6, bN, gHigh, 'far', box, null)
  ok('40000km 壳：几何上够得着（maxShellM>0）', sgHigh.maxShellM > 0)
  ok('40000km 壳：热区内全被地球遮挡 → 归因「全被地球遮挡」', sgHigh.maxVis < 0, `maxVis=${sgHigh.maxVis.toFixed(3)}`)
  // 全网格取极值会误判：四角跑出地球圆盘 → maxVis 转正。这行就是那条弯路的护栏
  const sgHighFull = shellGrid(gridSet, 6, bN, gHigh, 'far', null, null)
  ok('★ 全网格取极值会把遮挡误报成「低于最低档」（故必须按热区盒）', sgHighFull.maxVis > 0, `全网格 maxVis=${sgHighFull.maxVis.toFixed(3)}`)

  const gMid = shellGeom(bN, A + 20000, 0)
  ok('20000km 壳低于 GEO 源星 → 两支', gMid.inside === false)
  const sgMid = shellGrid(gridSet, 6, bN, gMid, 'near', box, null)
  ok('20000km 壳近侧：热区内可见（正常出图）', sgMid.maxVis > 0 && sgMid.maxShellM > 0)
  const sgMidFar = shellGrid(gridSet, 6, bN, gMid, 'far', box, null)
  ok('20000km 壳远侧：被地球挡住（天底波束穿地球）', sgMidFar.maxVis < 0)

  // 波束未及：把壳层压到 200 km，视轴偏到 30°（远超该壳 8.9° 的相切角）
  const bOff = antennaBasisAzEl(0, 0, H_GEO, 0, 30, 0)
  const sgMiss = shellGrid(gridSet, 6, bOff, shellGeom(bOff, A + 200, 0), 'near', box, null)
  ok('偏轴 30° 打 200km 壳：波束未及（maxShellM<0）', sgMiss.maxShellM < 0, `maxShellM=${sgMiss.maxShellM.toFixed(3)}`)
}

// ==================== 对星指向：低轨打 GSO ====================
// 用户的实际用例，也是「对地」那两套指向（地表目标点 / 相对天底的 az-el 偏置）都表达不了的方向：
// 源星在 550 km 低轨，天线直指同步带上的一颗星 → boresight 朝【反天底】，波束落在 GEO 壳层上。
{
  const Slla = { lon: 100, lat: 20, alt: 550 }
  const S = geodeticToEcef(Slla.lon, Slla.lat, Slla.alt)
  const T = geodeticToEcef(110.5, 0, H_GEO)                    // 中星 GSO 位
  const b = antennaBasisEcef(S, T, 0)

  const rS = Math.hypot(S[0], S[1], S[2])
  // 径向分量 >0 = 视轴背离地心。本例源星在 (100°E, 20°N)、目标在赤道 110.5°E，视线偏离当地垂线约 26.6°，
  // 故 ≈cos26.6°=0.894 而不是 1；关键只在【符号】——天底指向恒为 −1，这正是 geo/azel 两套表达不了的半空间。
  const radial = (b.z[0] * S[0] + b.z[1] * S[1] + b.z[2] * S[2]) / rS
  ok('对星指向：视轴朝反天底（径向分量 > 0）', radial > 0, `radial=${radial.toFixed(4)}，偏当地垂线 ${(Math.acos(radial) * R2D).toFixed(1)}°`)
  ok('基底正交归一', Math.abs(Math.hypot(b.z[0], b.z[1], b.z[2]) - 1) < 1e-12
    && Math.abs(b.x[0] * b.z[0] + b.x[1] * b.z[1] + b.x[2] * b.z[2]) < 1e-12
    && Math.abs(b.y[0] * b.z[0] + b.y[1] * b.z[1] + b.y[2] * b.z[2]) < 1e-12)

  // boresight 打到 GEO 壳层上，落点应当就是目标星所在的方向
  const gGeo = shellGeom(b, A + H_GEO, 0)
  ok('GEO 壳层高于低轨源星 → 单支', gGeo.inside === true)
  ok('视轴方向未被地球遮挡', visMargin(gGeo, b.z, 'far') > 0)
  const hit = projectDir(gGeo, b.z, 'far')
  ok('视轴与 GEO 壳的交点 = 目标星位置', hit && Math.abs(hit.lon - 110.5) < 1e-6 && Math.abs(hit.lat) < 1e-6,
    hit ? `${hit.lon.toFixed(4)}, ${hit.lat.toFixed(4)}` : 'null')
  const rangeKm = Math.hypot(T[0] - S[0], T[1] - S[1], T[2] - S[2])
  ok('斜距 = 星间距离', hit && Math.abs(hit.t - rangeKm) < 1e-6, `t=${hit ? hit.t.toFixed(1) : '—'} vs ${rangeKm.toFixed(1)} km`)

  // 同一指向下，低轨壳层（在源星【下方】）应当什么都没有——波束朝天打
  const gLow = shellGeom(b, A + 200, 0)
  ok('对星指向时低轨壳层无覆盖（波束朝天）', shellMargin(gLow, b.z) < 0)

  // 整片波束（±3°）都落在 GEO 壳上：抽查锥边的四个方向
  let allHit = true
  for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
    const r = 3 * D2R
    const d = [
      b.z[0] * Math.cos(r) + (b.x[0] * dx + b.y[0] * dy) / 3 * Math.sin(r),
      b.z[1] * Math.cos(r) + (b.x[1] * dx + b.y[1] * dy) / 3 * Math.sin(r),
      b.z[2] * Math.cos(r) + (b.x[2] * dx + b.y[2] * dy) / 3 * Math.sin(r)
    ]
    const n = Math.hypot(d[0], d[1], d[2])
    if (!(visMargin(gGeo, [d[0] / n, d[1] / n, d[2] / n], 'far') > 0)) allHit = false
  }
  ok('±3° 锥边四向均落在 GEO 壳且不被遮挡', allHit)
}

// ==================== 空间点指向 / 对星跟踪偏置（两种「对星指向」的几何核）====================
// ① boresightShellPoint：切到「空间点」模式与 3D 拖拽落点都靠它反推指向点，往返必须闭合，
//    否则一切模式指向就跳一下；未命中壳层时也不许返回 null（指向点不能凭空消失）。
// ② antennaBasisAbout / dirAzElAbout：偏置 0 时严格退化回参考基底（切模式不跳变），且互为逆。
{
  const b0 = antennaBasis(0, 30, 20, 0, 0, H_GEO)          // GEO@0°E 指向 30°E,20°N
  const R = A + 1200
  const p = boresightShellPoint(b0.S, b0.z, R)
  ok('空间点：视轴打在 1200km 壳上有落点', !!p && Math.abs(p.altKm - 1200) < 1e-9)
  // 往返：由落点重建方向，应与原视轴重合
  const P = geocentricToEcef(p.lon, p.lat, p.altKm)
  const w = [P[0] - b0.S[0], P[1] - b0.S[1], P[2] - b0.S[2]]
  const wn = Math.hypot(w[0], w[1], w[2])
  const dotz = (w[0] * b0.z[0] + w[1] * b0.z[1] + w[2] * b0.z[2]) / wn
  ok('空间点：落点 → 方向往返闭合', near(dotz, 1, 1e-9), `cos=${dotz.toFixed(12)}`)
  // 近侧支：落点必在源星与地心之间那一侧（|S−P| < |S| 方向上的远支距离）
  ok('空间点：取近侧支（落点在朝地球那一侧）', wn < Math.hypot(b0.S[0], b0.S[1], b0.S[2]))
  // 壳层高于源星（GEO 源星 + 40000km 壳）：仍必须给出落点
  const pUp = boresightShellPoint(b0.S, b0.z, A + 40000)
  ok('空间点：高于源星的壳也有落点（单支）', !!pUp)
  // 完全打不到的壳（低轨源星朝天打 200km 壳）：退到相切垂足，不返回 null
  const bUp = antennaBasisEcef(geodeticToEcef(0, 0, 550), geodeticToEcef(110.5, 0, H_GEO), 0)
  const pMiss = boresightShellPoint(bUp.S, bUp.z, A + 200)
  ok('空间点：打不到的壳退到相切垂足而非 null', !!pMiss && Math.abs(pMiss.altKm - 200) < 1e-9)

  // 偏置基底
  const nb = antennaBasisEcef(geodeticToEcef(0, 0, 550), geodeticToEcef(110.5, 0, H_GEO), 0)
  const same = antennaBasisAbout(nb, 0, 0, 0)
  ok('偏置 0 严格退化回参考基底', near(same.z[0], nb.z[0], 1e-12) && near(same.z[1], nb.z[1], 1e-12) && near(same.z[2], nb.z[2], 1e-12))
  for (const [az, el] of [[1.5, -2.25], [-7, 0], [0, 12], [30, 20]]) {
    const bb = antennaBasisAbout(nb, az, el, 0)
    const ae = dirAzElAbout(nb, bb.z)
    ok(`偏置 ${az}/${el}° 反解闭合`, near(ae.az, az, 1e-9) && near(ae.el, el, 1e-9), `${ae.az.toFixed(9)}, ${ae.el.toFixed(9)}`)
  }
  // 拖拽路径：壳层落点 → 偏置 → 基底，视轴应重新指回那个落点
  const q = boresightShellPoint(nb.S, antennaBasisAbout(nb, 2, 3, 0).z, A + H_GEO)
  const Q = geocentricToEcef(q.lon, q.lat, q.altKm)
  const dq = [Q[0] - nb.S[0], Q[1] - nb.S[1], Q[2] - nb.S[2]]
  const dqn = Math.hypot(dq[0], dq[1], dq[2])
  const ae2 = dirAzElAbout(nb, [dq[0] / dqn, dq[1] / dqn, dq[2] / dqn])
  ok('拖拽往返：落点 → 偏置 → 视轴回到落点', near(ae2.az, 2, 1e-6) && near(ae2.el, 3, 1e-6), `${ae2.az.toFixed(6)}, ${ae2.el.toFixed(6)}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
