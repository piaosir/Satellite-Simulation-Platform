// 影像重投影的【网格规划器】：把一张等经纬源图铺到某个投影平面上要用的三角网。
//
// 为什么单独一个模块：同一份网格现在要喂两条路 ——
//   · CPU 路（导出 / 无 WebGL2 / 环境场栅格）：逐三角 clip + drawImage（flatCoverage 的 warpTri）；
//   · GPU 路（屏上的投影档影像）：顶点缓冲 + 一次 drawArrays。
// 两条路的几何必须【逐字相同】，验收才有据 —— 故只有这一份，不许各写一遍。
// 纯几何、不碰 DOM，可在 Node 里直接测（见 packages/core/test/rasterMesh.test.mjs）。
//
// 出参口径：
//   xy —— 逐三角三个顶点的【平面坐标】（与 PJ.fwd 同一坐标系，double）
//   uv —— 同一批顶点的【源图归一坐标】：u = (lon + shift − lonMin) / lonSpan，v = (latMax − lat) / latSpan
//         乘上源图宽高即得像素坐标。★ 必须是 double：CPU 路要拿它算仿射，float32 会挪动亚像素。
//         u 可以越出 [0,1]（跨源图接缝的那些格，见下面的 shifts）—— GPU 侧靠 REPEAT 兜，
//         CPU 侧靠「同一格画两遍、各画得出落在源图内的那一半」兜。
import { lonBreaks, planCells, planBlockInv, cellDrawableInv, cellCornersInv } from './projection.js'

// 粗块边长：经纬向（正向档）与平面向（反向网格档）共用这一个数。块内再按曲率细分。
export const COARSE = 15
// 允许的弓高（烘图像素）：把一段弧用直线代替时的最大偏差。亚像素，肉眼分辨不出。
export const RP_TOL = 0.6

// 一块（经纬矩形）与烘图矩形相不相交 —— 一律【正算】判：逆算在图幅之外给的是外推值或 null，
// 拿它反推可见窗口会缩成一条（圆锥尤其）。八个采样点（四角 + 四边中点）够定包围盒，
// 块边是曲线故再留一点余量。
const _bhq = [0, 0]
function boxHit(PJ, lo0, lo1, la0, la1, bx0, by0, bx1, by1, margin) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const [lo, la] of [[lo0, la0], [lo1, la0], [lo0, la1], [lo1, la1],
    [(lo0 + lo1) / 2, la0], [(lo0 + lo1) / 2, la1], [lo0, (la0 + la1) / 2], [lo1, (la0 + la1) / 2]]) {
    PJ.fwd(lo, la, _bhq)
    if (!Number.isFinite(_bhq[0]) || !Number.isFinite(_bhq[1])) return true   // 算不准就别剔
    if (_bhq[0] < x0) x0 = _bhq[0]; if (_bhq[0] > x1) x1 = _bhq[0]
    if (_bhq[1] < y0) y0 = _bhq[1]; if (_bhq[1] > y1) y1 = _bhq[1]
  }
  return !(x1 + margin < bx0 || x0 - margin > bx1 || y1 + margin < by0 || y0 - margin > by1)
}

// 可增长的三角形收集器：每个三角形写 6 个平面坐标 + 6 个 uv
function sink(cap) {
  let xy = new Float64Array(cap * 6), uv = new Float64Array(cap * 6), n = 0
  const grow = () => {
    const nx = new Float64Array(xy.length * 2), nu = new Float64Array(uv.length * 2)
    nx.set(xy); nu.set(uv); xy = nx; uv = nu
  }
  return {
    get n() { return n },
    push(ax, ay, au, av, bx, by, bu, bv, cx, cy, cu, cv) {
      if ((n + 1) * 6 > xy.length) grow()
      const i = n * 6
      xy[i] = ax; xy[i + 1] = ay; xy[i + 2] = bx; xy[i + 3] = by; xy[i + 4] = cx; xy[i + 5] = cy
      uv[i] = au; uv[i + 1] = av; uv[i + 2] = bu; uv[i + 3] = bv; uv[i + 4] = cu; uv[i + 5] = cv
      n++
    },
    out() { return { xy: xy.subarray(0, n * 6), uv: uv.subarray(0, n * 6), n } }
  }
}

/**
 * 规划一张源图铺到 PJ 这张平面上的三角网。
 * @param PJ    makeProjection 出来的投影（要 fwd / W / H / lon0 / invGrid / inPlane）
 * @param o     { bx0, bx1, by0, by1, res, S }
 *              bx0..by1 —— 要铺的那块平面矩形（已钳进 [0,W]×[0,H]）
 *              res      —— 每个平面单位多少目标像素。只管两件事：细分密度（弓高 RP_TOL/res）
 *                          与「太小就不画」的面积阈值。GPU 路按屏上分辨率给即可。
 *              S        —— 源图的经纬窗口 { lonMin, lonMax, latMin, latMax }
 * @returns { xy, uv, n }
 */
export function planRasterMesh(PJ, o) {
  const { bx0, bx1, by0, by1, res, S } = o
  const T = sink(4096)
  if (!(bx1 > bx0 && by1 > by0) || !(res > 0)) return T.out()
  const lonSpan = S.lonMax - S.lonMin, latSpan = S.latMax - S.latMin
  const su = (lon, shift) => (lon + shift - S.lonMin) / lonSpan
  const sv = (lat) => (S.latMax - lat) / latSpan
  // 允许的弓高（烘图像素）换算到平面单位。o.tol 可放宽（屏上 GPU 路用 1.2：影像的位置误差 1 px 肉眼分不出，
  // 三角形少一半、规划快一倍）；不给就是 RP_TOL —— CPU 导出路一律不给，输出逐字节不变。
  const tolPlane = (o.tol > 0 ? o.tol : RP_TOL) / res
  // 相邻格在【参数空间】多叠一点点（约 1.5 个目标像素）：canvas 的 clip 带抗锯齿，两个格各自
  // 裁到公共边、两边各覆盖半个像素，合起来不满一格 —— 整幅图一层细网格线。
  const ovDeg = 1.5 / res
  const latTop = Math.min(90, S.latMax), latBot = Math.max(-90, S.latMin)

  // ── 反向网格那一档（方位等距）：网格建在【平面】上，四角逆算成经纬 ──────────────
  // 为什么这一档要翻过来，见 projection.js 的 invGrid：它的对跖点是奇点，正算方向在那里
  // 一格被拉长上百倍（切到上限还差十万像素），反算方向反倒最温和。
  if (PJ.invGrid) {
    const CP = COARSE                                  // 粗块边长（平面单位）
    const ovP = 1.5 / res
    const un = (v, r) => { let t = v; while (t - r > 180) t -= 360; while (t - r < -180) t += 360; return t }
    for (let px = Math.floor(bx0 / CP) * CP; px < bx1; px += CP) {
      for (let py = Math.floor(by0 / CP) * CP; py < by1; py += CP) {
        const pX1 = px + CP, pY1 = py + CP
        if (pX1 < bx0 || px > bx1 || pY1 < by0 || py > by1) continue
        // 整块在图幅外就跳过：取块上离图心最近的那个点判，它在圆外则整块都在
        const nx = Math.max(px, Math.min(PJ.W / 2, pX1)), ny = Math.max(py, Math.min(PJ.H / 2, pY1))
        if (!PJ.inPlane(nx, ny)) continue
        // 这一块切几行几列：自适应 + 三条特例，全部口径在 projection.js 的 planBlockInv 里
        const n = planBlockInv(PJ, px, pX1, py, pY1, tolPlane, res)
        const d = CP / n
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const ax = px + i * d, ay = py + j * d
            const bxx = Math.min(pX1, ax + d + ovP), byy = Math.min(pY1, ay + d + ovP)
            if (!cellDrawableInv(PJ, ax, bxx, ay, byy)) continue      // 格心在图幅外 ＝ 这一格没内容
            if (bxx < bx0 || ax > bx1 || byy < by0 || ay > by1) continue
            // 四角先钳进图幅再逆算：跨圆周的那一格被压成贴着圆边的一片，而不是整格丢掉
            const cn = cellCornersInv(PJ, ax, bxx, ay, byy)
            if (!cn) continue
            // 经度就近解缠到第一角：跨 ±180° 的格不会被拉成横跨源图的一条带
            const l0 = cn[0].lon, l1 = un(cn[1].lon, l0), l2 = un(cn[2].lon, l0), l3 = un(cn[3].lon, l0)
            // ★ 防呆：跨极的那一格四角经度能差满 180°（极点处经度本就不定），取源矩形会横跨半幅源图。
            //   宁可空着 —— 它就在极点上，且含极点的块必被细分到很密，缺口不到一个平面单位。
            const lo = Math.min(l0, l1, l2, l3), hi = Math.max(l0, l1, l2, l3)
            if (hi - lo > 90) continue
            // 这一格落在源窗口的哪个 360° 周期（同正向：整格一个偏移，格才不会被撕开）
            let shift = 0
            const midLon = (lo + hi) / 2
            while (midLon + shift < S.lonMin - 1e-9) shift += 360
            while (midLon + shift > S.lonMax + 1e-9) shift -= 360
            // ★ 跨源图接缝（±180）的那一格【画两遍】—— 反向网格建在平面上，没法像正向那样拿
            //   lonBreaks 预先把接缝插成断点，于是必然有一列格骑在接缝上。骑着的格源矩形有一半
            //   落在源图之外，那一半画不出来，症状是沿接缝一条锯齿状的白带。两遍的源坐标差整一个
            //   周期，各自只画得出落在源图内的那一半，合起来正好补齐。
            const shifts = [shift]
            if (lo + shift < S.lonMin - 1e-9) shifts.push(shift + 360)
            else if (hi + shift > S.lonMax + 1e-9) shifts.push(shift - 360)
            const q0x = cn[0].x, q0y = cn[0].y, q1x = cn[1].x, q1y = cn[1].y
            const q2x = cn[2].x, q2y = cn[2].y, q3x = cn[3].x, q3y = cn[3].y
            // ★ 钳过之后两个角可能压到同一点（正卡在圆周上的那一格）→ 三角形退化、仿射行列式为 0。
            //   逐个校面积，退化的那一半不画。
            // ★ 面积按【目标像素】算，且必须先把顶点折成目标像素再作差 —— 不能拿平面面积乘 res²：
            //   那是另一条浮点路径，阈值 0.1 上下的格会翻，CPU 路的输出就不再逐字节复现了。
            const b0x = (q0x - bx0) * res, b0y = (q0y - by0) * res
            const b1x = (q1x - bx0) * res, b1y = (q1y - by0) * res
            const b2x = (q2x - bx0) * res, b2y = (q2y - by0) * res
            const b3x = (q3x - bx0) * res, b3y = (q3y - by0) * res
            const ar1 = Math.abs((b1x - b0x) * (b2y - b0y) - (b2x - b0x) * (b1y - b0y))
            const ar2 = Math.abs((b2x - b3x) * (b1y - b3y) - (b1x - b3x) * (b2y - b3y))
            for (const sh of shifts) {
              const u0 = su(l0, sh), u1 = su(l1, sh), u2 = su(l2, sh), u3 = su(l3, sh)
              const v0 = sv(cn[0].lat), v1 = sv(cn[1].lat), v2 = sv(cn[2].lat), v3 = sv(cn[3].lat)
              // 目标面积不到十分之一个目标像素的也别画：画不出东西，还要付一次 clip + drawImage
              if (ar1 > 0.1) T.push(q0x, q0y, u0, v0, q1x, q1y, u1, v1, q2x, q2y, u2, v2)
              if (ar2 > 0.1) T.push(q3x, q3y, u3, v3, q2x, q2y, u2, v2, q1x, q1y, u1, v1)
            }
          }
        }
      }
    }
    return T.out()
  }

  // ── 正向档（圆柱 / 伪圆柱 / 圆锥）：网格建在【经纬那一侧】、用正算 fwd 求平面位置 ────
  // 反算的坑：可见框的边角多半落在图幅之外（伪圆柱高纬处图比框窄），那里 invert 给的是外推值，
  // 拿它当源经度就把整幅源图揉进一条带里。正算这一侧永远有定义，节点必落在图幅内。
  const L0 = PJ.lon0
  const brk = lonBreaks(L0, COARSE)                    // 经度断点：对齐切口 + 插入源图接缝
  const seamLon = L0 + ((((180 - L0) % 360) + 360) % 360)
  // 粗块剔除的余量要盖住【整块边线的弯度】（8 个采样点的包围盒兜不住它）：实测最鼓的是
  // Mercator 75°–90° 那一块，弓高 7.6 个平面单位，故按一块的跨度给。
  const blkMargin = COARSE
  const p0 = [0, 0], p1 = [0, 0], p2 = [0, 0], p3 = [0, 0]
  for (let bi = 0; bi + 1 < brk.length; bi++) {
    const bLo0 = brk[bi], bLo1 = brk[bi + 1]
    if (!(bLo1 > bLo0)) continue
    // 源窗口未必是 ±180 那一周（环境场栅格是另一个 bbox），故【按块】算一个 360° 的整倍偏移
    // 把这一块折进源窗口 —— 整块同一个偏移，格才不会被撕开。
    let shift = 0
    const midLon = (bLo0 + bLo1) / 2
    while (midLon + shift < S.lonMin - 1e-9) shift += 360
    while (midLon + shift > S.lonMax + 1e-9) shift -= 360
    // 允许往下一块叠一点（seam 与两个端点除外 —— 那三处不能跨）
    const canOv = bi + 2 < brk.length && Math.abs(bLo1 - seamLon) > 1e-6
    for (let bLat = latTop; bLat > latBot + 1e-9; bLat -= COARSE) {
      const bLa0 = bLat, bLa1 = Math.max(latBot, bLat - COARSE)
      if (!boxHit(PJ, bLo0, bLo1, bLa0, bLa1, bx0, by0, bx1, by1, blkMargin)) continue
      // 这一块切几行几列：按投影在这一块的曲率算（见 projection.js 的 planCells）。
      // 逐块量而不是全图一个值 —— 曲率随纬度差着几倍，全图按最坏处切就是几十倍的白工。
      const { nLon, nLat } = planCells(PJ, bLo0, bLo1, bLa0, bLa1, tolPlane)
      const lonStep = (bLo1 - bLo0) / nLon, latStep = (bLa0 - bLa1) / nLat
      const latOv = Math.min(latStep * 0.3, ovDeg), lonOv = Math.min(lonStep * 0.3, ovDeg)
      for (let lat = bLa0; lat > bLa1 + 1e-9; lat -= latStep) {
        const la0 = lat, la1 = Math.max(latBot, lat - latStep - latOv)
        for (let lon = bLo0; lon < bLo1 - 1e-9; lon += lonStep) {
          const lo0 = lon
          const lo1 = Math.min(canOv ? bLo1 + lonOv : bLo1, lon + lonStep + lonOv)
          PJ.fwd(lo0, la0, p0); PJ.fwd(lo1, la0, p1); PJ.fwd(lo0, la1, p2); PJ.fwd(lo1, la1, p3)
          if (!Number.isFinite(p0[0]) || !Number.isFinite(p1[0]) || !Number.isFinite(p2[0]) || !Number.isFinite(p3[0])) continue
          // ★ 防呆：一格的平面跨度不该接近整幅宽。真出现就是又踩到「跨切口」那一类，宁可不画
          //   也不能把源图横拉满全图（那正是影像左右错位的样子）。
          const gx0 = Math.min(p0[0], p1[0], p2[0], p3[0]), gx1 = Math.max(p0[0], p1[0], p2[0], p3[0])
          const gy0 = Math.min(p0[1], p1[1], p2[1], p3[1]), gy1 = Math.max(p0[1], p1[1], p2[1], p3[1])
          if (gx1 - gx0 > PJ.W * 0.5) continue
          if (gx1 < bx0 || gx0 > bx1 || gy1 < by0 || gy0 > by1) continue
          const u0 = su(lo0, shift), u1 = su(lo1, shift), v0 = sv(la0), v1 = sv(la1)
          T.push(p0[0], p0[1], u0, v0, p1[0], p1[1], u1, v0, p2[0], p2[1], u0, v1)
          T.push(p3[0], p3[1], u1, v1, p2[0], p2[1], u0, v1, p1[0], p1[1], u1, v0)
        }
      }
    }
  }
  return T.out()
}
