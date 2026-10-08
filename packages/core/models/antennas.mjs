// 星上天线与有效载荷造型库（2026-10-08）：平面相控阵 / 平面阵面板、轴向模螺旋阵元与螺旋阵、四臂螺旋、单极子 / 偶极子 / 绕杆式
// 十字振子、贴片与扼流圈天线、轴对称抛物面（正馈 / 卡塞格伦）与双轴指向机构、多波束馈源阵、角锥喇叭、激光通信终端、
// 激光角反射器阵、光学相机、推进剂贮箱、磁强计、三角桁架伸展臂、对数周期天线（GPS 核爆探测 W 传感器「圣诞树」）、多面体天线罩、
// 缝隙波导棒条阵、仪器箱、对接与分离机构、电推力器指向臂、遮阳板、电子消旋阵。
//
// 为什么（2026-10-08 用户：「模型工作台中组件尤其是卫星的组件不够完整，卫星的各种天线只有一个反射面，相控阵、全向天线等各种天线
// 我都在参数化模型上见到了……补全卫星组件，我要最佳效果，让用户真正可用愿意用」）：星座精模（fleet/）里早有万向抛物面、螺旋阵、
// 网状构架、激光终端、角反射器等造型，但都是按某颗星写死的；装配组件库只有反射面 / 喇叭 / 一块素板相控阵 / 测控天线。本库把这些
// 天线与载荷做成「参数驱动、尺寸由工作频率推算」的通用造型件，装配组件（components/satAntenna.mjs、satUnit.mjs、sat.mjs）调它。
//
// 口径（与 hardware.mjs 同）：
//   · 纯网格、零 three 依赖；只依赖 meshKit 与 fleet/kit。不登记节点 / 质量元 / 挂点——调用方登记（造型细部不改质量模型）。
//   · put(matKey) → MB：按材质分桶（材质键是 paramBus.MATERIALS 的语义键）。转动件（指向机构的方位 / 俯仰段）由调用方给不同的 put。
//   · 几何在调用方给的局部系里建（组件局部系：原点 = 安装基准点，+Z 朝外），米制、double。
//   · 尺寸缺省按工作频率推算（λ = c / f）：贴片阵元间距 0.6 λ、轴向模螺旋周长 = λ（直径 λ/π）、螺距 0.23 λ、单极子 λ/4……
//     这些是天线工程的设计常值（Kraus《Antennas》螺旋天线一章；Balanis《Antenna Theory》贴片 / 偶极子），具体型号尺寸不公开时为示意。
//   · 阵元很多时（Ka 频段 1 m 阵面上万个）只画到 MAX_EL 个：按比例放大「画出来的间距」——远看是同一种纹理，近看也不会糊成灰面；
//     真实阵面多有天线罩，罩面形式（radome / sunshield）不画阵元。
//
// 导出：C_MPNS（光速，m/ns）、lambdaOf、outlinePoly、polyArea、insetPoly、
//       arrayPanel、hornCluster、hexRingCount、pyramidHorn、helixCoil、helixUnit、groundPlate、qhaAntenna、whipAntenna、patchAntenna、
//       dishAntenna、azelBase / azelTurret / azelYokeShaft、xyBase / xyStage / xyCradle、lctHead、periscopeHead、retroArray、telescope、
//       propTank、magnetometerHead、latticeMast、lpdaAntenna、shroud、slotBars、instrumentBox、dockMechanism、
//       epArmDims / epArmRoot / epArmSegment / epThrusterHead（电推力器指向臂）、visorPanels（遮阳板）、edaArray（电子消旋阵）

import { lathe, perpPair, box, MB } from './meshKit.mjs'
import { frame, frameZX, toW, dirW, obox, bevelBox, prism, cyl, cone, disc, ring, fan, quadPts, tri, sweep, torus, nrm, madd, add, scl, sub, cross, dot, len } from './fleet/kit.mjs'
import { lvRing, hallThruster } from './hardware.mjs'

export { MB }

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const DEG = Math.PI / 180
/** 光速（米 / 纳秒）：λ（m）= C_MPNS / f（GHz） */
export const C_MPNS = 0.299792458
export const lambdaOf = (fGHz) => C_MPNS / fGHz
/** 组件局部系（单位阵）：大多数造型直接在它里面建 */
const LOCAL = Object.freeze(frame([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]))
/** 轴向局部系：原点 o、z = dir、x 取 up 去掉 z 分量 */
const axisFrame = (o, dir, up) => frameZX(o, nrm(dir), up || null)
/** 在局部系 F 里画回转体：轮廓 (r, z) 以 F.o 为起点、沿 F.z 展开 */
const latheF = (mb, F, prof, seg, o) => lathe(mb, F.o, F.z, prof, seg, o)
/** 局部系里的细杆（两端点在 F 里给） */
const rodF = (mb, F, a, b, r, seg = 8, caps = true) => cyl(mb, toW(F, a), toW(F, b), r, seg, caps, caps)

// ───────────────────────────── 平面多边形（阵面外廓） ─────────────────────────────

/**
 * 阵面外廓（xy 平面、中心在原点、内接于 2hw × 2hh 的矩形，逆时针）：
 *   rect 矩形；chamfer 切角矩形（切角 0.22·短半边，星链式阵面块）；hex 六边形（左右两个尖角，竖边沿 x 方向的上下两条平边）；
 *   oct 八边形（hw = hh 时为正八边形）；circle 圆 / 椭圆（seg 段）。
 */
export function outlinePoly(shape, hw, hh, seg = 48) {
  switch (shape) {
    case 'chamfer': {
      const c = 0.22 * Math.min(hw, hh)
      return [[hw - c, -hh], [hw, -hh + c], [hw, hh - c], [hw - c, hh], [-hw + c, hh], [-hw, hh - c], [-hw, -hh + c], [-hw + c, -hh]]
    }
    case 'hex': return [[hw, 0], [hw / 2, hh], [-hw / 2, hh], [-hw, 0], [-hw / 2, -hh], [hw / 2, -hh]]
    case 'oct': {
      const t = Math.tan(Math.PI / 8)
      return [[hw, -hh * t], [hw, hh * t], [hw * t, hh], [-hw * t, hh], [-hw, hh * t], [-hw, -hh * t], [-hw * t, -hh], [hw * t, -hh]]
    }
    case 'circle': {
      const out = []
      for (let k = 0; k < seg; k++) { const a = (2 * Math.PI * k) / seg; out.push([hw * Math.cos(a), hh * Math.sin(a)]) }
      return out
    }
    default: return [[hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]]
  }
}
/** 多边形有向面积（逆时针为正） */
export function polyArea(poly) {
  let s = 0
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1] }
  return s / 2
}
/** 凸多边形（逆时针）各边向内平移 d 后的多边形（相邻两条平移边求交） */
export function insetPoly(poly, d) {
  const n = poly.length, lines = []
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey) || 1
    const nx = -ey / L, ny = ex / L          // 逆时针多边形的内法向
    lines.push({ px: a[0] + nx * d, py: a[1] + ny * d, dx: ex / L, dy: ey / L })
  }
  const out = []
  for (let i = 0; i < n; i++) {
    const A = lines[(i - 1 + n) % n], B = lines[i]
    const den = A.dx * B.dy - A.dy * B.dx
    if (Math.abs(den) < 1e-12) { out.push([B.px, B.py]); continue }
    const t = ((B.px - A.px) * B.dy - (B.py - A.py) * B.dx) / den
    out.push([A.px + A.dx * t, A.py + A.dy * t])
  }
  return out
}
/** 点 (x, y) 到凸多边形（逆时针）各边的最小有向距离（> 0 在内部） */
function insideDist(poly, x, y) {
  let m = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey) || 1
    const d = (ex * (y - a[1]) - ey * (x - a[0])) / L
    if (d < m) m = d
  }
  return m
}
/** 凸多边形与直线 x = c（axis 0）或 y = c（axis 1）的交段 [lo, hi]（无交返回 null） */
function chord(poly, axis, c) {
  let lo = Infinity, hi = -Infinity
  const o = 1 - axis
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const da = a[axis] - c, db = b[axis] - c
    if (da === 0) { lo = Math.min(lo, a[o]); hi = Math.max(hi, a[o]) }
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const t = da / (da - db), v = a[o] + (b[o] - a[o]) * t; lo = Math.min(lo, v); hi = Math.max(hi, v) }
  }
  return hi > lo ? [lo, hi] : null
}
/** 局部系 F 里 xy 平面上的多边形片（高 z、法向 ±z） */
function polyFace(mb, F, poly, z, up = 1) { fan(mb, poly.map(([x, y]) => toW(F, [x, y, z])), scl(F.z, up)) }
/** 外圈 outer 与内圈 inner（顶点一一对应）之间的平环带（高 z、法向 +z） */
function polyBand(mb, F, outer, inner, z) {
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length
    quadPts(mb, toW(F, [outer[i][0], outer[i][1], z]), toW(F, [outer[j][0], outer[j][1], z]), toW(F, [inner[j][0], inner[j][1], z]), toW(F, [inner[i][0], inner[i][1], z]), F.z)
  }
}
/** 多边形 poly 的竖墙（z0 → z1）；inward = 法向朝多边形内（凹槽内壁） */
function polyWall(mb, F, poly, z0, z1, inward = false) {
  let cx = 0, cy = 0
  for (const q of poly) { cx += q[0]; cy += q[1] }
  cx /= poly.length; cy /= poly.length
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    let nx = b[1] - a[1], ny = -(b[0] - a[0])
    if (nx * ((a[0] + b[0]) / 2 - cx) + ny * ((a[1] + b[1]) / 2 - cy) < 0) { nx = -nx; ny = -ny }
    const L = Math.hypot(nx, ny) || 1, s = inward ? -1 : 1
    quadPts(mb, toW(F, [a[0], a[1], z0]), toW(F, [b[0], b[1], z0]), toW(F, [b[0], b[1], z1]), toW(F, [a[0], a[1], z1]), dirW(F, [s * nx / L, s * ny / L, 0]))
  }
}

// ───────────────────────────── 平面相控阵 / 平面阵面板 ─────────────────────────────

/** 一块面板最多画多少个阵元（超出按比例放大画出的间距，见文件头） */
export const MAX_EL = 2400

/**
 * 平面相控阵 / 平面阵天线面板（阵面朝局部 +z，安装面在 z = 0 以下）。
 *   面板 = 外廓棱柱（侧面与底面：frameMat）+ 阵面（z1 = z0 + t）+ 阵面四周压边（宽 bw、高 lip，frameMat）+ 阵元。
 *   face：'patch' 方形贴片（边长 0.58 间距，λ/2 微带贴片在 0.6 λ 栅格里的占空比）/ 'disc' 圆形贴片 / 'horn' 喇叭单元（深色喇叭口 +
 *         喇叭隔墙格栅，间距按 1.1 λ）/ 'dipole' 交叉偶极子（离地 0.25 λ 的十字振子 + 支柱）/ 'radome' 天线罩 / 'sunshield' 锗膜遮阳罩
 *         （罩面形式不画阵元）。
 *   tilesX × tilesY 分块（块间缝 gap）：大阵面多由子阵 / 展开板拼成；分块只对矩形 / 切角矩形外廓有意义（各块外廓同形）。
 *   lattice：'rect' 矩形栅格 / 'tri' 三角（交错）栅格（行距 √3/2 间距，隔行错半格；喇叭单元恒为矩形格）。
 *   旧版兼容：shape 'rect' + face 'radome' + faceMat = frameMat = 'white_paint' 时，逐块画「无底面的白盒」——与旧相控阵面 / 整星
 *   平板 LEO 的相控阵块逐位相同（specToAssembly 的装配件与整星同形）。
 * o = { w, h, t, z0, shape, face, lattice, pitch, tilesX, tilesY, gap, faceMat, elemMat, frameMat, maxEl? }
 * @returns {{top:number, tiles:{cx:number, cy:number, poly:number[][], area:number}[], area:number, drawn:number, pitchDrawn:number}}
 */
export function arrayPanel(put, o) {
  const nx = Math.max(1, o.tilesX | 0), ny = Math.max(1, o.tilesY | 0)
  const tw = (o.w - o.gap * (nx - 1)) / nx, th = (o.h - o.gap * (ny - 1)) / ny
  const z0 = o.z0, z1 = o.z0 + o.t
  const face = o.face || 'patch'
  const legacy = o.shape === 'rect' && face === 'radome' && o.faceMat === 'white_paint' && o.frameMat === 'white_paint'
  const shape = nx * ny > 1 && o.shape !== 'chamfer' ? 'rect' : o.shape
  const tiles = []
  let area = 0
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      const cx = -o.w / 2 + tw / 2 + ix * (tw + o.gap), cy = -o.h / 2 + th / 2 + iy * (th + o.gap)
      const poly = outlinePoly(shape, tw / 2, th / 2)
      const a = polyArea(poly)
      tiles.push({ cx, cy, poly, area: a })
      area += a
      if (legacy) box(put('white_paint'), [cx, cy, z0 + o.t / 2], [tw / 2, th / 2, o.t / 2], ['+x', '-x', '+y', '-y', '+z'])
    }
  }
  if (legacy) return { top: z1, tiles, area, drawn: 0, pitchDrawn: 0 }

  // 压边：宽 bw（阵面短边的 2.5 %，夹在 4–30 mm）、高 lip
  const bw = Math.max(0.004, Math.min(0.03, 0.025 * Math.min(tw, th))), lip = Math.max(0.0015, 0.25 * bw)
  const frameMat = o.frameMat || 'mli_gold'
  const faceMat = o.faceMat || (face === 'radome' ? 'radome' : face === 'sunshield' ? 'sunshield' : face === 'horn' ? 'black_paint' : 'white_paint')
  const elemMat = o.elemMat || (face === 'horn' ? 'aluminum' : 'gold_metal')
  // 阵元数（全阵面）与画出的间距
  const pitch = o.pitch
  const tri3 = o.lattice === 'tri' && face !== 'horn'
  const cellA = pitch * pitch * (tri3 ? Math.sqrt(3) / 2 : 1)
  const nEl = (face === 'radome' || face === 'sunshield') ? 0 : area / cellA
  const k = nEl > (o.maxEl || MAX_EL) ? Math.sqrt(nEl / (o.maxEl || MAX_EL)) : 1
  const pd = pitch * k
  let drawn = 0
  for (const T of tiles) {
    const F = frame([T.cx, T.cy, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1])
    const outer = T.poly, inner = insetPoly(outer, bw)
    // 面板体：侧面 + 底面（z0 → z1 + lip）、压边顶面、压边内壁、阵面
    prism(put(frameMat), F, outer, z0, z1 + lip, { cap0: true, cap1: false })
    polyBand(put(frameMat), F, outer, inner, z1 + lip)
    polyWall(put(frameMat), F, inner, z1, z1 + lip, true)
    polyFace(put(faceMat), F, inner, z1)
    if (face === 'sunshield') {
      // 遮阳罩：罩面四周一圈金色压边带（口缘胶带）
      const tape = insetPoly(inner, Math.min(0.012, 0.6 * bw))
      polyBand(put('gold_metal'), F, inner, tape, z1 + 0.0004)
      continue
    }
    if (face === 'radome') continue
    if (face === 'horn') {
      // 喇叭单元：深色阵面 = 喇叭口，按矩形栅格画隔墙（墙厚 0.08 间距、高 0.45 间距），墙沿外廓弦截断
      const wt = 0.08 * pd, wh = 0.45 * pd
      const xs = gridLines(inner, 0, pd), ys = gridLines(inner, 1, pd)
      for (const x of xs) { const c = chord(inner, 0, x); if (c) obox(put(elemMat), F, [x, (c[0] + c[1]) / 2, z1 + wh / 2], [wt / 2, (c[1] - c[0]) / 2, wh / 2], ['+x', '-x', '+y', '-y', '+z']) }
      for (const y of ys) { const c = chord(inner, 1, y); if (c) obox(put(elemMat), F, [(c[0] + c[1]) / 2, y, z1 + wh / 2], [(c[1] - c[0]) / 2, wt / 2, wh / 2], ['+x', '-x', '+y', '-y', '+z']) }
      drawn += xs.length * ys.length
      continue
    }
    // 阵元中心：栅格点落在内廓里（离边至少半个阵元）
    const pts = latticePts(inner, pd, tri3, 0.45 * pd)
    const em = put(elemMat)
    for (const [x, y] of pts) {
      if (face === 'disc') disc(em, toW(F, [x, y, z1 + 0.0006]), F.z, 0.3 * pd, 12)
      else if (face === 'dipole') {
        const hz = 0.42 * pd, L = 0.38 * pd, a = 0.025 * pd
        obox(em, F, [x, y, z1 + hz / 2], [0.035 * pd, 0.035 * pd, hz / 2], ['+x', '-x', '+y', '-y'])
        obox(em, F, [x, y, z1 + hz], [L, a, 0.012 * pd])
        obox(em, F, [x, y, z1 + hz + 0.024 * pd], [a, L, 0.012 * pd])
      } else {
        const s = 0.29 * pd
        quadPts(em, toW(F, [x - s, y - s, z1 + 0.0006]), toW(F, [x + s, y - s, z1 + 0.0006]), toW(F, [x + s, y + s, z1 + 0.0006]), toW(F, [x - s, y + s, z1 + 0.0006]), F.z)
      }
    }
    drawn += pts.length
  }
  return { top: z1, tiles, area, drawn, pitchDrawn: pd }
}
/** 栅格线位置（格心在原点对称排布时，格与格之间的分隔线 + 两端外框线），截在多边形的轴向范围内 */
function gridLines(poly, axis, p) {
  let lo = Infinity, hi = -Infinity
  for (const q of poly) { lo = Math.min(lo, q[axis]); hi = Math.max(hi, q[axis]) }
  const n = Math.max(1, Math.floor((hi - lo) / p))
  const out = []
  for (let i = 0; i <= n; i++) out.push(-n * p / 2 + i * p)
  return out
}
/** 落在凸多边形 poly 内（离边 ≥ margin）的栅格点；tri = 三角（交错）栅格 */
function latticePts(poly, p, tri3, margin) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const q of poly) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]) }
  const py = tri3 ? p * Math.sqrt(3) / 2 : p
  const nyH = Math.ceil(Math.max(-y0, y1) / py), nxH = Math.ceil(Math.max(-x0, x1) / p) + 1
  const out = []
  for (let j = -nyH; j <= nyH; j++) {
    const y = j * py, off = tri3 && (j & 1) ? p / 2 : 0
    for (let i = -nxH; i <= nxH; i++) {
      const x = i * p + off
      if (insideDist(poly, x, y) >= margin) out.push([x, y])
    }
  }
  return out
}

// ───────────────────────────── 多波束馈源阵 / 角锥喇叭 ─────────────────────────────

/** 六边形密排 rings 环的格点数：3r(r + 1) + 1（1 / 7 / 19 / 37 / 61 / 91…） */
export const hexRingCount = (r) => 3 * r * (r + 1) + 1
/** 六边形密排格点（间距 p、rings 环，由内向外；第一个邻点在 +x） */
export function hexPoints(rings, p) {
  const out = [[0, 0]]
  const dirs = [[1, 0], [0.5, Math.sqrt(3) / 2], [-0.5, Math.sqrt(3) / 2], [-1, 0], [-0.5, -Math.sqrt(3) / 2], [0.5, -Math.sqrt(3) / 2]]
  for (let r = 1; r <= rings; r++) {
    // 从 +x 方向的角点出发，沿六条边各走 r 步
    let x = r * p, y = 0
    for (let s = 0; s < 6; s++) {
      const d = dirs[(s + 2) % 6]
      for (let k = 0; k < r; k++) { out.push([x, y]); x += d[0] * p; y += d[1] * p }
    }
  }
  return out
}

/**
 * 喇叭外形轮廓（简化版波纹 / 光壁喇叭，馈源阵里成十上百只，只留看得出的特征）：a = 口面内半径、L = 喉部到口面。
 * 'smooth' 光壁样条（外壳 0.70 a → 1.10 a + 口沿唇环 1.15 a）；'terraced' 三级台阶锥；'conical' 直锥 + 唇环。
 */
function hornProfile(style, a, L) {
  if (style === 'terraced') return [[0.7 * a, 0], [0.7 * a, 0.3 * L], [0.86 * a, 0.3 * L], [0.86 * a, 0.62 * L], [1.0 * a, 0.62 * L], [1.0 * a, 0.94 * L], [1.15 * a, 0.94 * L], [1.15 * a, L]]
  if (style === 'conical') return [[0.5 * a, 0], [1.06 * a, 0.95 * L], [1.15 * a, 0.95 * L], [1.15 * a, L]]
  return [[0.7 * a, 0], [0.7 * a, 0.06 * L], [0.8 * a, 0.45 * L], [1.1 * a, 0.95 * L], [1.15 * a, 0.95 * L], [1.15 * a, L]]
}
/** 一只简化喇叭：外壳（body）+ 口沿环（rim）+ 内壁到喉部暗盘（inner）；可选口面遮阳膜 */
function hornLite(put, F, a, L, style, mat, cap, seg) {
  latheF(put(mat.body), F, hornProfile(style, a, L), seg)
  latheF(put(mat.rim), F, [[1.15 * a, L], [a, L]], seg)
  latheF(put(mat.inner), F, [[a, L], [0.34 * a, 0.08 * L], [0, 0.08 * L]], seg)
  if (cap === 'ge' || cap === 'white') disc(put(cap === 'ge' ? 'sunshield' : 'white_paint'), toW(F, [0, 0, L - 0.0015]), F.z, 1.02 * a, seg)
}

/**
 * 多波束馈源阵（单馈源单波束 SFB 的六边形密排喇叭簇，HTS 多点波束 / 区域波束反射面的焦面阵）：
 *   后端舱（馈电链 / 波束形成网络，金色 MLI 六棱柱，高 backH；0 = 无）+ 安装板（六边形 / 圆形，厚 plateT）+ 喇叭（rings 环）。
 *   局部系：z = 0 为安装面（后端舱底），口面在 z = top、朝 +z（装到反射面焦点时口面朝反射面）。
 * o = { rings, D（单喇叭口径）, pitch（中心距）, L（喇叭长）, style, finish, cap, plate:'hex'|'circle', plateT, backH, seg }
 * @returns {{top:number, plateTop:number, points:number[][], plateR:number}}
 */
export function hornCluster(put, o) {
  const a = o.D / 2, p = o.pitch, seg = o.seg || (o.rings >= 4 ? 12 : 16)
  const pts = hexPoints(o.rings, p)
  const plateR = o.rings * p + 0.62 * p + 0.15 * a
  const backH = Math.max(0, o.backH || 0), z1 = backH + o.plateT
  const hexOf = (r) => outlinePoly('hex', r, r * Math.sqrt(3) / 2)
  const polyP = o.plate === 'circle' ? outlinePoly('circle', plateR, plateR, 48) : hexOf(plateR)
  if (backH > 0) {
    const polyB = o.plate === 'circle' ? outlinePoly('circle', 0.9 * plateR, 0.9 * plateR, 48) : hexOf(0.9 * plateR)
    prism(put('mli_gold'), LOCAL, polyB, 0, backH, { cap0: true, cap1: false })
  }
  prism(put('aluminum'), LOCAL, polyP, backH, z1, { cap0: true, cap1: true })
  const mat = { body: o.finish || 'gold_metal', rim: 'gold_metal', inner: 'black_paint' }
  if (mat.body === 'gold_metal') mat.rim = 'aluminum'
  for (const [x, y] of pts) hornLite(put, frame([x, y, z1], [1, 0, 0], [0, 1, 0], [0, 0, 1]), a, o.L, o.style || 'smooth', mat, o.cap, seg)
  return { top: z1 + o.L, plateTop: z1, points: pts, plateR }
}

/**
 * 角锥喇叭（矩形口面的标准增益 / 地球覆盖喇叭）：喉部矩形波导 a × b（a ≈ 0.16 A、b = a/2）+ 方法兰；四块梯形外壁 + 深色内壁 + 口沿框。
 *   口面宽 A 沿局部 x（H 面）、高 B 沿局部 y（E 面）；喉部法兰底在 z = 0、口面在 z = L、朝 +z。
 * o = { A, B, L, mat:{body, inner, flange}, wall? }
 * @returns {{aperture:number[]}}
 */
export function pyramidHorn(put, o) {
  const A = o.A, B = o.B, L = o.L, w = isNum(o.wall) ? o.wall : Math.max(0.0015, 0.012 * A)
  const m = { body: 'aluminum', inner: 'black_paint', flange: 'aluminum', ...(o.mat || {}) }
  const a = Math.max(0.01, 0.16 * A), b = a / 2
  const zf = 0.035 * L, zt = 0.16 * L              // 法兰厚 / 波导段止点
  // 法兰（方板）+ 矩形波导段
  obox(put(m.flange), LOCAL, [0, 0, zf / 2], [a, 0.75 * a, zf / 2])
  obox(put(m.body), LOCAL, [0, 0, zf + (zt - zf) / 2], [a / 2 + w, b / 2 + w, (zt - zf) / 2], ['+x', '-x', '+y', '-y'])
  // 外壁：喉部 (a + 2w) × (b + 2w) → 口面 (A + 2w) × (B + 2w)；内壁：a × b → A × B（法向朝内）；口沿框
  const R0 = [(a / 2) + w, (b / 2) + w], R1 = [(A / 2) + w, (B / 2) + w], I0 = [a / 2, b / 2], I1 = [A / 2, B / 2]
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]]
  const P = (h, z, sx, sy) => [sx * h[0], sy * h[1], z]
  for (let k = 0; k < 4; k++) {
    const [s1, s2] = corners[k], [t1, t2] = corners[(k + 1) % 4]
    const out = [P(R0, zt, s1, s2), P(R0, zt, t1, t2), P(R1, L, t1, t2), P(R1, L, s1, s2)]
    const inn = [P(I0, zt, s1, s2), P(I0, zt, t1, t2), P(I1, L, t1, t2), P(I1, L, s1, s2)]
    const mid = scl(add(add(out[0], out[1]), add(out[2], out[3])), 0.25)
    const nOut = nrm(cross(sub(out[1], out[0]), sub(out[3], out[0])))
    const no = dot(nOut, [mid[0], mid[1], 0]) >= 0 ? nOut : scl(nOut, -1)
    quadPts(put(m.body), out[0], out[1], out[2], out[3], no)
    quadPts(put(m.inner), inn[0], inn[1], inn[2], inn[3], scl(no, -1))
    // 口沿框（外壁口缘 → 内壁口缘）
    quadPts(put(m.body), out[3], out[2], inn[2], inn[3], [0, 0, 1])
  }
  // 喉部暗盘（内壁底）
  quadPts(put(m.inner), [-I0[0], -I0[1], zt], [I0[0], -I0[1], zt], [I0[0], I0[1], zt], [-I0[0], I0[1], zt], [0, 0, 1])
  return { aperture: [0, 0, L] }
}

// ───────────────────────────── 螺旋天线 ─────────────────────────────

/**
 * 轴向模螺旋线（扫掠圆截面）：底点 base、轴 axis、起绕方向 ref；半径 R、螺距 S、圈数 N、线径 w。
 * hand = +1 右旋（沿轴向前看逆时针前进，辐射 RHCP——导航星 L 频段阵元都是右旋）/ −1 左旋。先从轴心沿径向走一段馈电线再起绕。
 * @returns {number[]} 末端点
 */
export function helixCoil(mb, base, axis, ref, o) {
  const a = nrm(axis)
  const r0 = ref || perpPair(a)[0]
  let e1 = sub(r0, scl(a, dot(r0, a)))
  if (len(e1) < 1e-9) e1 = perpPair(a)[0]
  e1 = nrm(e1)
  const e2 = scl(cross(a, e1), o.hand === -1 ? -1 : 1)
  const seg = o.seg || 16, n = Math.max(8, Math.ceil(o.N * seg))
  const pts = []
  for (let i = 0; i <= n; i++) {
    const s = i / n, th = 2 * Math.PI * o.N * s
    pts.push(add(madd(base, a, o.S * o.N * s), add(scl(e1, o.R * Math.cos(th)), scl(e2, o.R * Math.sin(th)))))
  }
  sweep(mb, [base, pts[0]], o.w, o.tubeSeg || 6)
  sweep(mb, pts, o.w, o.tubeSeg || 6)
  return pts[pts.length - 1]
}

/**
 * 螺旋阵元（导航星 L 频段阵元 / UHF 螺旋）：接地杯（cup：浅圆筒 + 底盘，杯径 cupD、杯高 cupH）+ 中心介质支撑杆 + 螺旋线 +
 * 可选锥形端帽（cap：GPS IIF 那种黑色锥顶）。局部：底在 base、沿 axis。
 * o = { base, axis, ref?, R, S, N, w, hand, cup:boolean, cupD, cupH, support:boolean, cap:boolean, mat:{coil, cup, support, cap}, seg }
 * @returns {{top:number[], height:number}}
 */
export function helixUnit(put, o) {
  const a = nrm(o.axis), H = o.S * o.N
  const m = { coil: 'gold_metal', cup: 'aluminum', support: 'white_paint', cap: 'black_paint', ...(o.mat || {}) }
  const F = axisFrame(o.base, a, o.ref)
  if (o.cup) {
    const rc = o.cupD / 2, hc = o.cupH, wt = Math.max(0.0012, 0.03 * rc)
    latheF(put(m.cup), F, [[0, 0], [rc, 0], [rc, hc], [rc - wt, hc], [rc - wt, 0.004], [0, 0.004]], 24)
  }
  if (o.support !== false) cyl(put(m.support), toW(F, [0, 0, 0]), toW(F, [0, 0, H + 0.006]), Math.max(0.0025, 0.16 * o.R), 10, false, true)
  helixCoil(put(m.coil), toW(F, [0, 0, 0.006]), a, F.x, { R: o.R, S: o.S, N: o.N, w: o.w, hand: o.hand, seg: o.seg || 16, tubeSeg: 5 })
  let top = H + 0.006
  if (o.cap) {
    const rcap = 1.15 * o.R
    cone(put(m.cap), toW(F, [0, 0, top]), rcap, toW(F, [0, 0, top + 1.5 * rcap]), 0.002, 16, true, false)
    top += 1.5 * rcap
  }
  return { top: toW(F, [0, 0, top]), height: top }
}

/**
 * 接地板 / 阵列底板（xy 平面、底面 z = 0、厚 t）：shape 'circle' | 'oct' | 'square'（半宽 / 半径 r）；rimMat 给了就在侧面中段压一圈金属边。
 * @returns {{top:number}}
 */
export function groundPlate(put, o) {
  const poly = o.shape === 'square' ? outlinePoly('rect', o.r, o.r) : o.shape === 'oct' ? outlinePoly('oct', o.r, o.r) : outlinePoly('circle', o.r, o.r, 48)
  prism(put(o.mat || 'mli_black'), LOCAL, poly, 0, o.t, { cap0: true, cap1: true })
  if (o.rimMat) prism(put(o.rimMat), LOCAL, poly.map(([x, y]) => [x * 1.004, y * 1.004]), o.t * 0.25, o.t * 0.75, { cap0: false, cap1: false })
  return { top: o.t }
}

// ───────────────────────────── 全向 / 低增益天线 ─────────────────────────────

/**
 * 四臂螺旋天线（QHA；S / UHF 频段测控、数传常用）：底座法兰 + 天线罩（radome：白色圆柱罩 + 半球顶）或裸臂（四条各绕半圈的螺旋臂缠在
 * 介质筒上 + 顶端短路环）。o = { base, dir, up?, d（罩外径 / 臂所在圆柱直径）, H（罩高 / 臂长）, radome, hand, mat:{arm, base, tube}, seg }
 * @returns {{top:number[], center:number[]}}
 */
export function qhaAntenna(put, o) {
  const F = axisFrame(o.base, o.dir, o.up), r = o.d / 2, H = o.H, seg = o.seg || 28
  const m = { arm: 'copper', base: 'aluminum', tube: 'white_paint', ...(o.mat || {}) }
  const hb = 0.12 * H
  // 底座：法兰盘 + 接插件短柱
  latheF(put(m.base), F, [[0, 0], [1.45 * r, 0], [1.45 * r, 0.025 * H], [1.05 * r, 0.04 * H], [1.05 * r, hb], [0, hb]], seg)
  cyl(put(m.base), toW(F, [1.0 * r, 0, 0.02 * H]), toW(F, [1.7 * r, 0, 0.02 * H]), 0.18 * r, 12, true, true)
  if (o.radome) {
    const dome = [0.25, 0.5, 0.75, 1].map((t) => [r * Math.cos(t * Math.PI / 2), hb + 0.78 * H + 0.22 * H * Math.sin(t * Math.PI / 2)])
    latheF(put('radome'), F, [[0, hb], [r, hb], [r, hb + 0.78 * H], ...dome], seg)
  } else {
    // 介质筒 + 四条螺旋臂（各绕半圈）+ 顶端短路环
    const rc = 0.9 * r, z0 = hb, z1 = hb + 0.9 * H
    cyl(put(m.tube), toW(F, [0, 0, z0]), toW(F, [0, 0, z1]), 0.82 * r, seg, false, true)
    const hand = o.hand === -1 ? -1 : 1
    for (let k = 0; k < 4; k++) {
      const pts = []
      for (let i = 0; i <= 24; i++) {
        const s = i / 24, th = (Math.PI / 2) * k + hand * Math.PI * s
        pts.push(toW(F, [rc * Math.cos(th), rc * Math.sin(th), z0 + (z1 - z0) * s]))
      }
      sweep(put(m.arm), pts, Math.max(0.0008, 0.035 * r), 5)
    }
    torus(put(m.arm), toW(F, [0, 0, z1]), F.z, rc, Math.max(0.0008, 0.035 * r), seg, 5)
  }
  return { top: toW(F, [0, 0, hb + H]), center: toW(F, [0, 0, hb + 0.5 * H]) }
}

/** 卷尺弹簧带（宽 tw、弧高 0.09 tw 的三折面弯弧带，两面都画）：p0 → p1，带面法向取 nHint 去掉轴向分量 */
function tapeStrip(mb, p0, p1, tw, nHint) {
  const d = nrm(sub(p1, p0))
  let n = sub(nHint, scl(d, dot(nHint, d)))
  if (len(n) < 1e-9) n = perpPair(d)[0]
  n = nrm(n)
  const b = cross(d, n)
  const prof = [[-0.5, 0], [-0.17, 0.09], [0.17, 0.09], [0.5, 0]]   // 截面：横向 b、拱高 n（以 tw 计）
  for (let i = 0; i < 3; i++) {
    const A = prof[i], B = prof[i + 1]
    const qa = add(scl(b, A[0] * tw), scl(n, A[1] * tw)), qb = add(scl(b, B[0] * tw), scl(n, B[1] * tw))
    const fn = nrm(cross(sub(qb, qa), d))
    const up = dot(fn, n) >= 0 ? fn : scl(fn, -1)
    quadPts(mb, add(p0, qa), add(p0, qb), add(p1, qb), add(p1, qa), up)
    quadPts(mb, add(p0, qa), add(p0, qb), add(p1, qb), add(p1, qa), scl(up, -1))
  }
}
/** 振子（rod 圆杆 / tape 卷尺带）p0 → p1 */
function element(mb, p0, p1, style, rd, tw, nHint) {
  if (style === 'tape') tapeStrip(mb, p0, p1, tw, nHint)
  else cyl(mb, p0, p1, rd, 8, false, true)
}

/**
 * 单极子 / 半波偶极子 / 绕杆式十字振子（低增益全向天线）：
 *   'monopole'：根部座（接插件座 + 绝缘子）→ 振子（长 L，沿 dir）；mast > 0 时先立一段桅杆。
 *   'dipole'：桅杆（mast）顶端巴伦盒 → 两臂（各 L，沿局部 ±x），臂向下垂 cant（0 = 水平）。
 *   'turnstile'：八角底座 + 四只铰座 → 四根振子（各 L）按 90° 均布（对角线方向），振子与安装面夹角 cant（0 = 平铺在安装面上方）。
 *   'conemast'：锥罩测控杆（mast 杆长、mastR 杆半径、coneR / coneH 锥罩底半径 / 高；mat.cone 罩材质）。
 * style 'rod'（圆杆，半径 rd）/ 'tape'（卷尺弹簧带，宽 tw：立方星展开天线）。o = { base, dir, up, kind, L, mast, cant, style, rd, tw, mat:{elem, base, mast}, seg }
 * @returns {{tip:number[], center:number[]}}
 */
export function whipAntenna(put, o) {
  const F = axisFrame(o.base, o.dir, o.up), L = o.L, seg = o.seg || 20
  const m = { elem: 'aluminum', base: 'aluminum', mast: 'white_paint', ...(o.mat || {}) }
  if (o.kind === 'conemast') {
    // 锥罩测控杆（导航星 S 频段测控天线：细长桅杆 + 顶端白色锥形天线罩，罩内为螺旋 / 振子辐射单元）：根部法兰 → 桅杆 → 锥罩（底半径 coneR、高 coneH）
    const Lm = Math.max(0.05, o.mast), rm = o.mastR, rc = o.coneR, hc = o.coneH
    cyl(put(m.base), toW(F, [0, 0, 0]), toW(F, [0, 0, 0.008]), 2.2 * rm, 20, false, true)
    cyl(put(m.mast), toW(F, [0, 0, 0.008]), toW(F, [0, 0, Lm - 0.8 * hc]), rm, 16, false, true)
    latheF(put(m.cone || 'radome'), F, [[0, Lm - 0.86 * hc], [rc, Lm - 0.86 * hc], [rc, Lm - 0.8 * hc], [0.22 * rc, Lm + 0.2 * hc], [0, Lm + 0.2 * hc]], 24)
    return { tip: toW(F, [0, 0, Lm + 0.2 * hc]), center: toW(F, [0, 0, Lm - 0.3 * hc]) }
  }
  const em = put(m.elem), rd = o.rd, tw = o.tw
  const mast = Math.max(0, o.mast || 0)
  const rb = Math.max(0.006, 3.2 * rd, o.style === 'tape' ? 0.6 * tw : 0)
  if (o.kind === 'turnstile') {
    // 底座：八角盘 + 四只铰座（振子根部收在铰座里）
    const hb = Math.max(0.006, 0.5 * rb)
    const rr = Math.max(2.2 * rb, 0.06 * L)
    prism(put(m.base), F, outlinePoly('oct', rr, rr), 0, hb)
    const c = Math.cos(o.cant * DEG), s = Math.sin(o.cant * DEG)
    let tip = null
    for (let k = 0; k < 4; k++) {
      const t = (Math.PI / 2) * k + Math.PI / 4
      const u = [Math.cos(t), Math.sin(t), 0]
      const root = toW(F, [0.8 * rr * u[0], 0.8 * rr * u[1], hb + 0.4 * rb])
      obox(put(m.base), frameZX(root, F.z, dirW(F, u)), [0, 0, -0.2 * rb], [0.6 * rb, 0.45 * rb, 0.4 * rb])
      const d = dirW(F, [c * u[0], c * u[1], s])
      const p1 = madd(root, d, L)
      element(em, root, p1, o.style, rd, tw, F.z)
      if (!tip) tip = p1
    }
    return { tip, center: toW(F, [0, 0, hb]) }
  }
  // 桅杆
  let z = 0
  if (mast > 0.002) {
    const rm = Math.max(rb, 0.008)
    cyl(put(m.base), toW(F, [0, 0, 0]), toW(F, [0, 0, 0.006]), 2.2 * rm, 20, false, true)
    cyl(put(m.mast), toW(F, [0, 0, 0.006]), toW(F, [0, 0, mast]), rm, 16, false, false)
    z = mast
  }
  if (o.kind === 'dipole') {
    // 巴伦盒 + 两臂（沿局部 ±x，向下垂 cant）
    const hbx = Math.max(0.008, 1.6 * rb)
    obox(put(m.base), F, [0, 0, z + hbx / 2], [hbx * 0.7, hbx * 0.55, hbx / 2])
    const c = Math.cos(o.cant * DEG), s = Math.sin(o.cant * DEG)
    let tip = null
    for (const sx of [1, -1]) {
      const root = toW(F, [sx * hbx * 0.7, 0, z + hbx * 0.6])
      const p1 = madd(root, dirW(F, [sx * c, 0, -s]), L)
      element(em, root, p1, o.style, rd, tw, F.y)
      if (!tip) tip = p1
    }
    return { tip, center: toW(F, [0, 0, z + hbx * 0.6]) }
  }
  // 单极子：接插件座 + 绝缘子 + 振子
  latheF(put(m.base), F, [[0, z], [1.6 * rb, z], [1.6 * rb, z + 0.6 * rb], [0.9 * rb, z + 0.9 * rb], [0.9 * rb, z + 2.2 * rb], [0, z + 2.2 * rb]], seg)
  cyl(put('white_paint'), toW(F, [0, 0, z + 2.2 * rb]), toW(F, [0, 0, z + 3.2 * rb]), 0.75 * rb, 14, false, false)
  const p0 = toW(F, [0, 0, z + 3.2 * rb]), p1 = toW(F, [0, 0, z + 3.2 * rb + L])
  element(em, p0, p1, o.style, rd, tw, F.x)
  if (o.style !== 'tape') cyl(em, p1, madd(p1, F.z, 1.2 * rd), 1.3 * rd, 8, false, true)
  return { tip: p1, center: toW(F, [0, 0, z + 3.2 * rb + L / 2]) }
}

/**
 * 贴片天线（GNSS 接收 / S 频段测控）：方形接地板（边长 ground，缺省 0.6 λ）+ 介质基板（白）+ 方形辐射贴片（0.36 λ，铜）+ 两只正交馈电点；
 * 可选天线罩（白色低矮圆顶）与扼流圈（chokes 道同心扼流槽：槽深 λ/4、槽距 λ/4，精密定轨 GNSS 天线）。
 * o = { base, dir, up?, lam, ground?, radome, chokes, mat:{patch, sub, ground}, seg }
 * @returns {{top:number[], center:number[]}}
 */
export function patchAntenna(put, o) {
  const F = axisFrame(o.base, o.dir, o.up), lam = o.lam, seg = o.seg || 32
  const m = { patch: 'copper', sub: 'white_paint', ground: 'aluminum', ...(o.mat || {}) }
  const nC = Math.max(0, o.chokes | 0)
  let zTop
  if (nC > 0) {
    // 扼流圈：底盘 + nC 道同心薄壁环（高 λ/4），最内圈里放贴片
    const r0 = 0.22 * lam, step = 0.25 * lam, hc = 0.25 * lam, tb = 0.01 * lam + 0.002
    const R = r0 + nC * step
    cyl(put(m.ground), toW(F, [0, 0, 0]), toW(F, [0, 0, tb]), R + 0.004, seg * 2, true, true)
    for (let k = 1; k <= nC; k++) {
      const rk = r0 + k * step, wt = Math.max(0.0015, 0.012 * lam)
      latheF(put(m.ground), F, [[rk + wt, tb], [rk + wt, tb + hc], [rk - wt, tb + hc], [rk - wt, tb]], seg * 2)
    }
    obox(put(m.sub), F, [0, 0, tb + 0.012 * lam], [0.2 * lam, 0.2 * lam, 0.012 * lam])
    obox(put(m.patch), F, [0, 0, tb + 0.024 * lam + 0.0005], [0.12 * lam, 0.12 * lam, 0.0005], ['+z'])
    zTop = tb + hc
    if (o.radome) {
      // 天线罩只罩中心贴片（最内一道扼流槽以内）：低矮圆顶，母线自下而上（lathe 外法向口径）
      const rr = r0 + 0.1 * step, hr = 0.12 * lam
      latheF(put('radome'), F, [[rr, tb], ...[1, 0.92, 0.75, 0.5, 0.25].map((t) => [rr * t, tb + hr * Math.cos(t * Math.PI / 2) ** 0.5]), [0, tb + hr]], seg * 2)
    }
  } else {
    const g = isNum(o.ground) ? o.ground : 0.6 * lam, tg = Math.max(0.003, 0.02 * lam), ts = Math.max(0.0016, 0.03 * lam)
    obox(put(m.ground), F, [0, 0, tg / 2], [g / 2, g / 2, tg / 2])
    obox(put(m.sub), F, [0, 0, tg + ts / 2], [0.46 * g, 0.46 * g, ts / 2], ['+x', '-x', '+y', '-y', '+z'])
    const s = 0.18 * lam
    obox(put(m.patch), F, [0, 0, tg + ts + 0.0004], [s, s, 0.0004], ['+x', '-x', '+y', '-y', '+z'])
    // 馈电点（两只，圆极化正交馈电）
    for (const [x, y] of [[0.3 * s, 0], [0, 0.3 * s]]) cyl(put('gold_metal'), toW(F, [x, y, tg + ts + 0.0008]), toW(F, [x, y, tg + ts + 0.0018]), Math.max(0.0008, 0.02 * s), 8, false, true)
    zTop = tg + ts
    if (o.radome) {
      const rr = 0.42 * g, hr = 0.07 * lam
      latheF(put('radome'), F, [...[1, 0.9, 0.75, 0.5, 0.25].map((t) => [rr * t, zTop + hr * Math.cos(t * Math.PI / 2) ** 0.6]), [0, zTop + hr]], seg)
      zTop += hr
    }
  }
  return { top: toW(F, [0, 0, zTop]), center: toW(F, [0, 0, 0.5 * zTop]) }
}

// ───────────────────────────── 轴对称抛物面（双轴指向天线的反射面） ─────────────────────────────

/**
 * 轴对称抛物面天线（局部系 F：z = 视轴，顶点在 F 的 z = zv）：正面（凹面，front）+ 背壳（rear，沿法向退 t）+ 口沿唇环 + 背面径向肋
 * （ribs 条，肋高 0.035 D 向口缘收到 0）+ 中心毂；feed：
 *   'prime' 正馈：焦点处小锥形喇叭口朝反射面 + struts 根撑杆自口缘伸到喇叭；
 *   'cass' 卡塞格伦：凸面副反射面在焦点内侧（0.8 f）+ 四根撑杆，主面顶点伸出馈源喇叭朝副面；
 *   'none'：只有反射面。
 * o = { F, zv, D, f, t?, front, rear, feed, struts:3|4, ribs:0|4|6, feedAp?, feedMat?, seg?, nr? }
 * @returns {{focus:number[], vertex:number[], hubBack:number[], rimCenter:number[], zRim:number, zv:number}}（点在 F 的父系里；zRim / zv 是 F 系 z 值）
 */
export function dishAntenna(put, o) {
  const F = o.F, D = o.D, R = D / 2, f = o.f, zv = o.zv || 0, seg = o.seg || 40, nr = o.nr || 10
  const t = isNum(o.t) ? o.t : Math.max(0.004, 0.012 * D)
  const zOf = (r) => zv + r * r / (4 * f)
  const fm = o.feedMat || 'gold_metal'
  // 正面：自中心向外（inward = 法向朝焦点一侧）；背壳：正面沿法向退 t（自中心向外 = 外法向朝背后）
  const front = []
  for (let i = 0; i <= nr; i++) { const r = R * Math.pow(i / nr, 0.85); front.push([r, zOf(r)]) }
  latheF(put(o.front), F, front, seg, { inward: true, creaseDeg: 80 })
  const nOf = (r) => { const q = Math.hypot(r / (2 * f), 1); return [-(r / (2 * f)) / q, 1 / q] }   // 正面法向（r, z 分量）
  const back = front.map(([r, z]) => { const n = nOf(r); return [r - t * n[0], z - t * n[1]] })
  latheF(put(o.rear), F, back, seg, { creaseDeg: 80 })
  // 口沿唇环（自下而上：背壳外缘 → 唇环底 → 唇环外 → 正面外缘）
  const zr = zOf(R), w = Math.max(0.003, 0.012 * D), bR = back[back.length - 1]
  latheF(put(o.rear), F, [bR, [R + w, zr - t], [R + w, zr], [R, zr]], seg)
  // 背面径向肋（两面都画的薄肋板）
  const nRib = o.ribs === 0 ? 0 : (o.ribs || 4)
  for (let k = 0; k < nRib; k++) {
    const ph = (2 * Math.PI * k) / nRib + Math.PI / nRib, c = Math.cos(ph), s = Math.sin(ph)
    const P = (r, z) => toW(F, [r * c, r * s, z])
    const side = dirW(F, [-s, c, 0])
    for (let i = 1; i < back.length - 1; i++) {
      const [r0, z0] = back[i], [r1, z1] = back[i + 1]
      if (r1 > 0.9 * R) break
      const h0 = 0.035 * D * (1 - r0 / (0.9 * R)), h1 = 0.035 * D * Math.max(0, 1 - r1 / (0.9 * R))
      const n0 = nOf(r0), n1 = nOf(r1)
      const a = P(r0, z0), b = P(r1, z1), b2 = P(r1 - h1 * n1[0], z1 - h1 * n1[1]), a2 = P(r0 - h0 * n0[0], z0 - h0 * n0[1])
      quadPts(put(o.rear), a, b, b2, a2, side)
      quadPts(put(o.rear), a, b, b2, a2, scl(side, -1))
    }
  }
  // 中心毂
  const hubR = Math.max(0.012, 0.09 * D), hubH = Math.max(0.01, 0.06 * D)
  latheF(put('aluminum'), F, [[0, zv - t - hubH], [hubR, zv - t - hubH], [hubR, zv - 0.5 * t], [0.8 * hubR, zv]], 24)
  const focus = toW(F, [0, 0, zv + f])
  if (o.feed === 'prime') {
    // 正馈喇叭：口面在焦点、朝 −z（反射面）；撑杆从口缘（0.97 R）伸到喇叭腰部
    const af = (isNum(o.feedAp) ? o.feedAp : 0.1 * D) / 2, hl = Math.max(0.03, 0.11 * D)
    const zf = zv + f
    // 外壳（母线自下而上）+ 朝下的口沿环
    latheF(put(fm), F, [[af * 1.12, zf], [af * 1.08, zf + 0.02 * hl], [0.36 * af, zf + 0.8 * hl], [0.36 * af, zf + hl]], 20)
    latheF(put(fm), F, [[af, zf], [af * 1.12, zf]], 20)
    latheF(put('black_paint'), F, [[af, zf], [0.3 * af, zf + 0.75 * hl], [0, zf + 0.75 * hl]], 20, { inward: true })
    cyl(put(fm), toW(F, [0, 0, zf + hl]), toW(F, [0, 0, zf + 1.25 * hl]), 0.42 * af, 16, false, true)
    const ns = o.struts === 3 ? 3 : 4, rr = Math.max(0.0025, 0.006 * D)
    for (let k = 0; k < ns; k++) {
      const ph = ns === 3 ? Math.PI / 2 + (2 * Math.PI * k) / 3 : Math.PI / 4 + (Math.PI / 2) * k
      const c = Math.cos(ph), s = Math.sin(ph)
      const p0 = toW(F, [0.97 * R * c, 0.97 * R * s, zOf(0.97 * R) - 0.3 * t]), p1 = toW(F, [0.7 * af * c, 0.7 * af * s, zf + 0.45 * hl])
      cyl(put('carbon'), p0, p1, rr, 8, true, true)
    }
  } else if (o.feed === 'cass') {
    // 卡塞格伦：凸面副反射面（口径 0.13 D、矢高 0.012 D）在 0.8 f 处朝主面；四根撑杆；主面顶点伸出喇叭
    const Rs = 0.065 * D, hs = 0.012 * D, ts = Math.max(0.003, 0.008 * D), zs = zv + 0.8 * f
    latheF(put('reflector'), F, [[0, zs - hs], [0.5 * Rs, zs - 0.75 * hs], [Rs, zs], [Rs, zs + ts], [0, zs + ts]], 32, { creaseDeg: 50 })
    const rr = Math.max(0.0025, 0.006 * D)
    for (let k = 0; k < 4; k++) {
      const ph = Math.PI / 4 + (Math.PI / 2) * k, c = Math.cos(ph), s = Math.sin(ph)
      cyl(put('carbon'), toW(F, [0.97 * R * c, 0.97 * R * s, zOf(0.97 * R) - 0.3 * t]), toW(F, [0.95 * Rs * c, 0.95 * Rs * s, zs + 0.5 * ts]), rr, 8, true, true)
    }
    const ra = 0.045 * D, rt = 0.022 * D, zt = zv + 0.32 * f
    latheF(put(fm), F, [[rt, zv], [rt, zv + 0.08 * f], [ra, zt - 0.01 * D], [ra * 1.12, zt]], 20)
    latheF(put(fm), F, [[ra * 1.12, zt], [ra, zt]], 20)
    latheF(put('black_paint'), F, [[ra, zt], [0.6 * rt, zv + 0.12 * f], [0, zv + 0.12 * f]], 20)
  }
  return { focus, vertex: toW(F, [0, 0, zv]), hubBack: toW(F, [0, 0, zv - t - hubH]), rimCenter: toW(F, [0, 0, zr]), zRim: zr, zv }
}

// ───────────────────────────── 双轴指向机构 ─────────────────────────────
//
// 方位-俯仰（az-el）与 X-Y 两种，分「固定 / 第一轴 / 两轴」三段，各段在自己的节点系里画（调用方把节点系做成关节节点）：
//   az-el：固定座（组件局部系）→ 转台（方位节点系：原点在方位轴根部，z = 方位轴，x = 俯仰轴）→ 俯仰段（同轴系、原点上移到俯仰轴心，
//          视轴绕 x 转 tilt 烘进几何）；X-Y：底座 → X 段（原点在 X 轴心，x = X 轴，绕 x 转 a1 烘进节点系）→ 托架（同 X 段节点系，
//          绕 Y 轴（x 段系 z = d 处、沿 y）转 a2 烘进几何）。烘焙口径见 components/satAntenna.mjs 文件头。
// 尺寸 g（米，调用方按反射面 / 望远镜口径推算）：
//   az-el：{ H 俯仰轴高, rb 法兰半径, ra 方位作动器半径, hz 方位作动器高, wy 俯仰轴承离方位轴, armT 立臂厚, rbr 轴承座半径, rs 轴径, motorL }
//   X-Y：{ h1 X 轴高, d Y 轴在 X 轴之上, rx X 作动器半径, wx X 作动器半长, ry Y 作动器半径, wyy Y 作动器半长, tp 侧板厚 }
// 材质 m：{ mech 机构外表面, metal 轴承 / 法兰 }

/** 方位-俯仰：固定座（法兰 + 方位作动器下半） */
export function azelBase(put, g, m) {
  latheF(put(m.metal), LOCAL, [[0, 0], [g.rb, 0], [g.rb, 0.008], [g.ra * 1.08, 0.012], [g.ra * 1.08, 0.016], [0, 0.016]], 32)
  cyl(put(m.mech), [0, 0, 0.016], [0, 0, 0.55 * g.hz], g.ra, 32, false, false)
  // 法兰螺栓
  for (let k = 0; k < 8; k++) {
    const t = (2 * Math.PI * k) / 8 + Math.PI / 8, r = 0.5 * (g.rb + g.ra * 1.08)
    cyl(put(m.metal), [r * Math.cos(t), r * Math.sin(t), 0.008], [r * Math.cos(t), r * Math.sin(t), 0.013], 0.08 * (g.rb - g.ra), 8, false, true)
  }
}
/** 方位-俯仰：转台（方位作动器上半 + 转台板 + 两只立臂 + 轴承座 + 俯仰电机），方位节点系 */
export function azelTurret(put, g, m) {
  cyl(put(m.metal), [0, 0, 0.55 * g.hz], [0, 0, 0.6 * g.hz], g.ra * 1.03, 32, false, false)
  cyl(put(m.mech), [0, 0, 0.6 * g.hz], [0, 0, g.hz], g.ra, 32, false, true)
  const pt = Math.max(0.006, 0.12 * g.ra), z0 = g.hz
  bevelBox(put(m.mech), LOCAL, [0, 0, z0 + pt / 2], [g.wy + g.armT / 2, 0.85 * g.ra, pt / 2], 0.3 * pt)
  for (const s of [1, -1]) {
    const x = s * g.wy, top = g.H + 0.4 * g.rbr
    bevelBox(put(m.mech), LOCAL, [x, 0, (z0 + pt + top) / 2], [g.armT / 2, 0.8 * g.rbr, (top - z0 - pt) / 2], 0.25 * g.armT)
    // 轴承座（沿 x）+ 俯仰电机（外侧）
    cyl(put(m.metal), [x - s * g.armT * 0.6, 0, g.H], [x + s * g.armT * 0.6, 0, g.H], g.rbr, 24, true, true)
    cyl(put(m.mech), [x + s * g.armT * 0.6, 0, g.H], [x + s * (g.armT * 0.6 + g.motorL), 0, g.H], 0.78 * g.rbr, 24, false, true)
    cyl(put(m.metal), [x + s * (g.armT * 0.6 + g.motorL), 0, g.H], [x + s * (g.armT * 0.6 + g.motorL + 0.006), 0, g.H], 0.5 * g.rbr, 16, false, true)
  }
}
/**
 * 方位-俯仰：俯仰段（俯仰轴 + 支架 + 载荷），俯仰节点系（原点在俯仰轴心）。轴沿 x 横贯两立臂之间；
 * 支架在倾转后的载荷系 Fp（绕 x 转 tilt：视轴向 −y 倾）里从轴心伸到载荷背面 zBack。返回 Fp。
 */
export function azelYokeShaft(put, g, m, tiltDeg, zBack) {
  cyl(put(m.metal), [-(g.wy - 0.6 * g.armT), 0, 0], [g.wy - 0.6 * g.armT, 0, 0], g.rs, 16, true, true)
  const t = tiltDeg * DEG
  const Fp = frame([0, 0, 0], [1, 0, 0], [0, Math.cos(t), Math.sin(t)], [0, -Math.sin(t), Math.cos(t)])
  // 支架：轴上的方块轴套 + 一根方立柱 + 顶部安装板
  bevelBox(put(m.mech), Fp, [0, 0, 0], [0.9 * g.rbr, 1.1 * g.rs + 0.004, 1.1 * g.rs + 0.004], 0.2 * g.rs)
  const top = Math.max(zBack, 1.2 * g.rs)
  bevelBox(put(m.mech), Fp, [0, 0, top / 2], [0.55 * g.rbr, 0.55 * g.rbr, top / 2], 0.15 * g.rbr)
  cyl(put(m.metal), toW(Fp, [0, 0, top - 0.006]), toW(Fp, [0, 0, top]), 1.4 * g.rbr, 24, true, true)
  return Fp
}

/** X-Y：底座（台座 + X 作动器定子，沿 x） */
export function xyBase(put, g, m) {
  const ped = g.h1 - 0.9 * g.rx
  bevelBox(put(m.mech), LOCAL, [0, 0, ped / 2], [0.75 * g.wx, 0.9 * g.rx, ped / 2], 0.1 * g.rx)
  latheF(put(m.metal), LOCAL, [[0, 0], [1.25 * g.wx, 0], [1.25 * g.wx, 0.008], [0, 0.008]], 32)
  cyl(put(m.mech), [-g.wx, 0, g.h1], [g.wx, 0, g.h1], g.rx, 28, true, true)
}
/** X-Y：X 段（绕 X 轴转的 U 形托架 + Y 作动器，沿 y），X 节点系（原点在 X 轴心） */
export function xyStage(put, g, m) {
  for (const s of [1, -1]) {
    const x = s * (g.wx + 0.6 * g.tp + 0.004)
    cyl(put(m.metal), [s * g.wx, 0, 0], [x + s * 0.5 * g.tp, 0, 0], 0.55 * g.rx, 20, true, true)
    bevelBox(put(m.mech), LOCAL, [x, 0, g.d / 2], [g.tp / 2, 0.75 * g.rx, g.d / 2 + 0.6 * g.ry], 0.3 * g.tp)
  }
  bevelBox(put(m.mech), LOCAL, [0, 0, g.d - 1.15 * g.ry], [g.wx + 0.6 * g.tp + 0.004, 0.75 * g.rx, 0.25 * g.ry], 0.1 * g.ry)
  cyl(put(m.mech), [0, -g.wyy, g.d], [0, g.wyy, g.d], g.ry, 28, true, true)
}
/** X-Y：托架（Y 轴两端的叉耳 + 安装柱），X 节点系里画，载荷系 Fp = 绕 Y 轴（z = d、沿 y）转 a2；返回 Fp */
export function xyCradle(put, g, m, a2Deg, zBack) {
  const t = a2Deg * DEG
  const Fp = frame([0, 0, g.d], [Math.cos(t), 0, -Math.sin(t)], [0, 1, 0], [Math.sin(t), 0, Math.cos(t)])
  for (const s of [1, -1]) {
    cyl(put(m.metal), toW(Fp, [0, s * g.wyy, 0]), toW(Fp, [0, s * (g.wyy + 0.012), 0]), 0.6 * g.ry, 20, true, true)
    bevelBox(put(m.mech), Fp, [0, s * (g.wyy + 0.012 + 0.5 * g.tp), (zBack + 0.4 * g.ry) / 2 - 0.4 * g.ry], [0.7 * g.ry, g.tp / 2, (zBack + 0.4 * g.ry) / 2], 0.25 * g.tp)
  }
  bevelBox(put(m.mech), Fp, [0, 0, zBack - 0.004], [0.8 * g.ry, g.wyy + 0.012 + g.tp, 0.006], 0.004)
  return Fp
}

// ───────────────────────────── 激光通信终端 ─────────────────────────────

/**
 * 激光终端光学头（镜筒式：望远镜在方位-俯仰叉架上，EDRS / LCT 类）：俯仰节点系里、载荷系 Fp（视轴 = Fp.z）里画——
 *   镜筒（半径 0.78 D、前段遮光罩略外扩、口部深色窗口）+ 尾部电子 / 配重块 + 两侧耳轴。D = 通光口径。
 * @returns {{window:number[]}}（Fp 系转到节点系的窗口中心）
 */
export function lctHead(put, Fp, D, m, zBack) {
  const rt = 0.78 * D, L = 3.0 * D, z0 = zBack, z1 = z0 + L
  latheF(put(m.body), Fp, [[0, z0], [0.9 * rt, z0], [rt, z0 + 0.05 * L], [rt, z0 + 0.68 * L], [1.08 * rt, z1 - 0.02 * L], [1.08 * rt, z1]], 32)
  latheF(put(m.body), Fp, [[1.08 * rt, z1], [0.98 * rt, z1]], 32)
  // 遮光罩内壁（母线自上而下：法向朝轴）
  latheF(put('black_paint'), Fp, [[0.98 * rt, z1], [0.62 * D, z0 + 0.62 * L], [0, z0 + 0.62 * L]], 32)
  disc(put('glass'), toW(Fp, [0, 0, z0 + 0.62 * L + 0.002]), Fp.z, 0.6 * D, 32)
  // 镜筒外的加强环
  for (const f of [0.22, 0.45]) latheF(put(m.metal), Fp, [[rt, z0 + f * L], [rt * 1.06, z0 + f * L + 0.01 * L], [rt * 1.06, z0 + f * L + 0.04 * L], [rt, z0 + f * L + 0.05 * L]], 32)
  return { window: toW(Fp, [0, 0, z1]) }
}

/**
 * 潜望式激光终端头（转台 + 斜置镜头罩：方位靠转台、俯仰靠头内反射镜，外面只看得见方位转动）：方位节点系里画——
 *   转台筒（半径 rh、高 hh）+ 顶盖 + 斜出的镜头罩（沿 b = 视轴，长 1.6 D）+ 深色窗口。
 * o = { z0（转台底高）, D, tiltDeg（视轴离方位轴的角，向 −y 倾）, m } @returns {{window:number[], dir:number[]}}
 */
export function periscopeHead(put, o) {
  const D = o.D, rh = 1.25 * D, hh = 1.1 * D, z0 = o.z0, m = o.m
  latheF(put(m.body), LOCAL, [[0, z0], [rh, z0], [rh, z0 + hh], [0.92 * rh, z0 + hh + 0.12 * D], [0, z0 + hh + 0.12 * D]], 40)
  const t = o.tiltDeg * DEG
  const b = [0, -Math.sin(t), Math.cos(t)]
  const c0 = [0, 0, z0 + 0.75 * hh], L = 1.6 * D, rw = 0.72 * D
  const Fh = frameZX(c0, b, [1, 0, 0])
  latheF(put(m.body), Fh, [[0, 0], [rw, 0], [rw, L - 0.08 * D], [1.08 * rw, L]], 32)
  latheF(put(m.body), Fh, [[1.08 * rw, L], [0.95 * rw, L]], 32)
  // 罩口内壁（自口沿向里、向下：母线自上而下，法向朝轴 = 内壁可见面）
  latheF(put('black_paint'), Fh, [[0.95 * rw, L], [0.95 * rw, L - 0.25 * D], [0, L - 0.25 * D]], 32)
  disc(put('glass'), toW(Fh, [0, 0, L - 0.25 * D + 0.002]), Fh.z, 0.9 * rw, 32)
  return { window: toW(Fh, [0, 0, L]), dir: b }
}

// ───────────────────────────── 激光角反射器 ─────────────────────────────

/**
 * 激光角反射器阵（LRA：熔石英角锥棱镜阵，SLR 测距用）：托板（hex / rect / circle，厚 plateT）+ 棱镜（圆口深色玻璃，外圈铝压环）。
 *   layout：'hex' 六边形密排 rings 环 / 'grid' nx × ny 交错（隔行错半格）/ 'ring' 环形 ringN 只（中径 ringR，留空按间距排满一圈）。
 *   o = { layout, rings, nx, ny, ringN, ringR, d（棱镜口径）, pitch, plateT, h（棱镜露出高）, plate, mat }
 * @returns {{top:number, n:number, plateArea:number}}
 */
export function retroArray(put, o) {
  const d = o.d, p = o.pitch, h = o.h, tP = o.plateT
  if (o.layout === 'ring') {
    // 环形（格洛纳斯那种环绕导航天线的一圈棱镜）：环形托板 + n 只棱镜均布在中径上
    const n = Math.max(3, o.ringN | 0), rm = isNum(o.ringR) ? o.ringR : Math.max((n * p) / (2 * Math.PI), 1.5 * p)
    const ri = Math.max(0.3 * rm, rm - 0.7 * p), ro = rm + 0.7 * p
    latheF(put(o.mat || 'aluminum'), LOCAL, [[ri, 0], [ro, 0], [ro, tP], [ri, tP], [ri, 0]], 64)
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n, x = rm * Math.cos(a), y = rm * Math.sin(a)
      cyl(put(o.mat || 'aluminum'), [x, y, tP], [x, y, tP + h], 0.58 * d, 16, false, true)
      disc(put('glass'), [x, y, tP + h + 0.0004], [0, 0, 1], 0.5 * d, 16)
    }
    return { top: tP + h, n, plateArea: Math.PI * (ro * ro - ri * ri), ringR: rm, outerR: ro }
  }
  let pts
  if (o.layout === 'grid') {
    pts = []
    for (let j = 0; j < o.ny; j++) for (let i = 0; i < o.nx; i++) pts.push([(i - (o.nx - 1) / 2) * p + ((j & 1) ? p / 4 : -p / 4), (j - (o.ny - 1) / 2) * p * Math.sqrt(3) / 2])
  } else pts = hexPoints(o.rings, p)
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  const mg = 0.55 * p + 0.1 * d
  const hw = Math.max(Math.abs(x0), Math.abs(x1)) + mg, hh = Math.max(Math.abs(y0), Math.abs(y1)) + mg
  const poly = o.layout === 'grid' ? outlinePoly('chamfer', hw, hh) : outlinePoly('hex', hw, hw * Math.sqrt(3) / 2)
  prism(put(o.mat || 'aluminum'), LOCAL, poly, 0, tP)
  for (const [x, y] of pts) {
    cyl(put(o.mat || 'aluminum'), [x, y, tP], [x, y, tP + h], 0.58 * d, 16, false, true)
    disc(put('glass'), [x, y, tP + h + 0.0004], [0, 0, 1], 0.5 * d, 16)
  }
  return { top: tP + h, n: pts.length, plateArea: polyArea(poly) }
}

// ───────────────────────────── 光学相机 ─────────────────────────────

/**
 * 光学相机（对地遥感 / 星载望远镜）：
 *   'tube' 筒式（同轴卡塞格伦）：焦面箱（底部，高 0.35 D）→ 镜筒（半径 0.58 D + 8 mm，外表面 finish）→ 前遮光罩（端面斜切 cutDeg，
 *          高边在 +x）；筒内黑色内壁、主镜（深色玻璃环，带中心孔）、次镜（铝）+ 三根支撑翼片。
 *   'box' 箱式（小卫星相机）：电子箱（1.5 D 见方）+ 镜头筒 + 外扩遮光罩 + 镜头玻璃。
 * o = { type, D（通光口径）, L（总长）, cutDeg, finish, secondary, seg } @returns {{aperture:number[], top:number}}
 */
export function telescope(put, o) {
  const D = o.D, L = o.L, seg = o.seg || 40, fin = o.finish || 'mli_black'
  if (o.type === 'box') {
    // 箱式：电子箱（1.6 D 见方）→ 镜头法兰 → 本色铝镜头筒（两道调焦环）→ 镜片 → 黑色遮光罩（微外扩）
    const W = 1.6 * D, Hb = Math.max(0.3 * L, 0.55 * D), rl = 0.62 * D, zg = Hb + 0.55 * (L - Hb), zh = zg - 0.02 * D
    bevelBox(put(fin), LOCAL, [0, 0, Hb / 2], [W / 2, W / 2, Hb / 2], 0.06 * W)
    latheF(put('aluminum'), LOCAL, [[0, Hb], [0.8 * D, Hb], [0.8 * D, Hb + 0.05 * D], [rl, Hb + 0.08 * D], [rl, zg]], seg)
    for (const f of [0.35, 0.7]) { const z = Hb + f * (zg - Hb); latheF(put('dark_metal'), LOCAL, [[rl, z], [1.06 * rl, z + 0.01 * D], [1.06 * rl, z + 0.06 * D], [rl, z + 0.07 * D]], seg) }
    latheF(put('black_paint'), LOCAL, [[rl, zg], [rl * 1.02, zg + 0.01 * D], [0.76 * D, L]], seg)
    latheF(put('black_paint'), LOCAL, [[0.76 * D, L], [0.72 * D, L]], seg)
    latheF(put('black_paint'), LOCAL, [[0.72 * D, L], [0.95 * rl, zh], [0, zh]], seg)
    disc(put('glass'), [0, 0, zh + 0.002], [0, 0, 1], 0.5 * D, seg)
    return { aperture: [0, 0, zh], top: L }
  }
  const rb = 0.58 * D + 0.008, hB = 0.35 * D
  const tanC = Math.tan(Math.max(0, Math.min(60, o.cutDeg || 0)) * DEG)
  // 焦面箱 + 安装法兰
  bevelBox(put('aluminum'), LOCAL, [0, 0, hB / 2], [0.82 * rb, 0.82 * rb, hB / 2], 0.05 * rb)
  latheF(put('titanium'), LOCAL, [[0, hB], [1.08 * rb, hB], [1.08 * rb, hB + 0.015 * L], [0, hB + 0.015 * L]], seg)
  // 镜筒 + 遮光罩（顶缘按斜切面）：外壁、内壁（黑）、顶缘带
  const zTop = (c) => L - tanC * rb + tanC * rb * c          // c = cos φ（高边 +x）
  const outer = put(fin), inner = put('black_paint'), rim = put(fin)
  const z0 = hB + 0.015 * L, ri = rb - Math.max(0.004, 0.02 * rb)
  for (let j = 0; j < seg; j++) {
    const a0 = (2 * Math.PI * j) / seg, a1 = (2 * Math.PI * (j + 1)) / seg
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1)
    const n0 = [c0, s0, 0], n1 = [c1, s1, 0]
    const A = [rb * c0, rb * s0, z0], B = [rb * c1, rb * s1, z0], C = [rb * c1, rb * s1, zTop(c1)], Dd = [rb * c0, rb * s0, zTop(c0)]
    const ia = outer.v(A, n0), ib = outer.v(B, n1), ic = outer.v(C, n1), id = outer.v(Dd, n0)
    outer.t(ia, ib, ic); outer.t(ia, ic, id)
    const zi = z0 + 0.12 * L
    const Ai = [ri * c0, ri * s0, zi], Bi = [ri * c1, ri * s1, zi], Ci = [ri * c1, ri * s1, zTop(c1)], Di = [ri * c0, ri * s0, zTop(c0)]
    const ja = inner.v(Ai, scl(n0, -1)), jb = inner.v(Bi, scl(n1, -1)), jc = inner.v(Ci, scl(n1, -1)), jd = inner.v(Di, scl(n0, -1))
    inner.t(ja, jc, jb); inner.t(ja, jd, jc)
    const nr = nrm([-tanC, 0, 1])
    quadPts(rim, Dd, C, Ci, Di, nr)
  }
  // 主镜（深色玻璃环，带中心孔）+ 筒底暗盘
  const zp = z0 + 0.12 * L
  ring(put('glass'), [0, 0, zp + 0.002], [0, 0, 1], 0.12 * D, 0.5 * D, seg)
  disc(put('black_paint'), [0, 0, zp + 0.001], [0, 0, 1], ri, seg)
  if (o.secondary !== false) {
    // 次镜（铝，朝下）+ 次镜座 + 三根翼片
    const zs = zp + 0.62 * (L - tanC * rb - zp), rsec = 0.17 * D
    latheF(put('aluminum'), LOCAL, [[0, zs - 0.004], [rsec, zs - 0.002], [rsec, zs + 0.03 * D], [0.6 * rsec, zs + 0.08 * D], [0, zs + 0.08 * D]], 24)
    for (let k = 0; k < 3; k++) {
      const ph = (2 * Math.PI * k) / 3, c = Math.cos(ph), s = Math.sin(ph)     // 0° / 120° / 240°：关于 xz 面对称（斜切高边也在 +x）
      const Fv = frameZX([0.5 * (rsec + ri) * c, 0.5 * (rsec + ri) * s, zs + 0.04 * D], [c, s, 0], [0, 0, 1])
      obox(put('black_paint'), Fv, [0, 0, 0], [0.04 * D, 0.0015, 0.5 * (ri - rsec)])
    }
  }
  return { aperture: [0, 0, L - tanC * rb], top: L }
}

// ───────────────────────────── 推进剂贮箱 ─────────────────────────────

/**
 * 推进剂贮箱：'sphere' 球形 / 'capsule' 圆柱段 + 两端半球（直径 Dt、总长 Lt）。底部裙座（球：半径 0.62 R 的短圆筒；柱：同径裙座）、
 * 环焊缝（深色细环）、顶部加注 / 排放口凸台。局部：裙座底在 z = 0、轴沿 +z。
 * o = { shape, D, L, finish, skirtH, seg } @returns {{center:number[], top:number, zc:number[]}}（zc = 半球心高度表）
 */
export function propTank(put, o) {
  const R = o.D / 2, seg = o.seg || 48, fin = o.finish || 'titanium'
  const hs = Math.max(0.02, isNum(o.skirtH) ? o.skirtH : 0.12 * R)
  const arc = (zc, a0, a1, n) => { const pts = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push([R * Math.cos(a), zc + R * Math.sin(a)]) } return pts }
  let prof, zc1, zc2
  if (o.shape === 'capsule') {
    const Lc = Math.max(0, o.L - o.D)
    zc1 = hs + R; zc2 = zc1 + Lc
    prof = [[0, zc1 - R], ...arc(zc1, -Math.PI / 2, 0, 12).slice(1), ...arc(zc2, 0, Math.PI / 2, 12)]
  } else {
    zc1 = zc2 = hs + R
    prof = [[0, zc1 - R], ...arc(zc1, -Math.PI / 2, Math.PI / 2, 24).slice(1)]
  }
  prof[prof.length - 1] = [0, prof[prof.length - 1][1]]
  latheF(put(fin), LOCAL, prof, seg, { creaseDeg: 40 })
  // 裙座
  const rs = o.shape === 'capsule' ? 0.96 * R : 0.62 * R
  const zj = zc1 - Math.sqrt(Math.max(0, R * R - rs * rs))
  latheF(put('aluminum'), LOCAL, [[rs + 0.006, 0], [rs + 0.006, 0.01], [rs, 0.016], [rs, zj + 0.01]], seg)
  latheF(put('aluminum'), LOCAL, [[rs - 0.004, zj + 0.01], [rs - 0.004, 0], [rs + 0.006, 0]], seg)
  // 环焊缝
  for (const z of o.shape === 'capsule' ? [zc1, zc2] : [zc1]) torus(put('dark_metal'), [0, 0, z], [0, 0, 1], R + 0.0015, Math.max(0.002, 0.008 * R), seg, 6)
  // 顶部凸台 + 短管
  const top = zc2 + R
  cyl(put('aluminum'), [0, 0, top - 0.004], [0, 0, top + 0.02 * R + 0.01], Math.max(0.01, 0.1 * R), 20, false, true)
  cyl(put('titanium'), [0, 0, top + 0.02 * R + 0.01], [0, 0, top + 0.02 * R + 0.03], Math.max(0.004, 0.035 * R), 12, false, true)
  return { center: [0, 0, (zc1 + zc2) / 2], top: top + 0.02 * R + 0.03, zc: [zc1, zc2] }
}

// ───────────────────────────── 磁强计 ─────────────────────────────

/**
 * 三轴磁通门磁强计探头：'cyl' 圆柱探头（Ø 0.04 × 0.09 m）/ 'cube' 方形探头（0.05 m 见方）；带安装法兰与电缆接头。
 * o = { type, scale, finish } @returns {{top:number}}
 */
export function magnetometerHead(put, o) {
  const k = isNum(o.scale) ? o.scale : 1, fin = o.finish || 'white_paint'
  latheF(put('titanium'), LOCAL, [[0, 0], [0.032 * k, 0], [0.032 * k, 0.005 * k], [0, 0.005 * k]], 24)
  let top
  if (o.type === 'cube') {
    bevelBox(put(fin), LOCAL, [0, 0, 0.005 * k + 0.025 * k], [0.025 * k, 0.025 * k, 0.025 * k], 0.003 * k)
    top = 0.055 * k
  } else {
    latheF(put(fin), LOCAL, [[0, 0.005 * k], [0.02 * k, 0.005 * k], [0.02 * k, 0.085 * k], [0.016 * k, 0.093 * k], [0, 0.095 * k]], 24)
    top = 0.095 * k
  }
  cyl(put('aluminum'), [0.018 * k, 0, 0.02 * k], [0.034 * k, 0, 0.02 * k], 0.006 * k, 12, false, true)
  return { top }
}

// ───────────────────────────── 桁架伸展臂 ─────────────────────────────

/**
 * 三角 / 四边形桁架伸展臂（盘绕式 / 铰接式伸展臂，磁强计杆、大型网状反射面展开臂常用）：沿 +z 自 0 到 L；n 根纵杆（外接圆半径 r）、
 * 每节一圈横撑、每个侧面一根斜撑（逐节交替），节距 bay（缺省 ≈ 1.4 r）；可选根部收拢筒（canister）。
 * o = { L, r, n:3|4, rod, bay?, canister, mat } @returns {{tip:number[]}}
 */
export function latticeMast(put, o) {
  const n = o.n === 4 ? 4 : 3, r = o.r, L = o.L, rr = o.rod
  const mb = put(o.mat || 'carbon')
  let z0 = 0
  if (o.canister) {
    const hc = Math.min(0.12 * L, 3 * r)
    latheF(put('aluminum'), LOCAL, [[0, 0], [1.3 * r, 0], [1.3 * r, hc], [0, hc]], 32)
    z0 = hc
  }
  const Lb = L - z0
  const nb = Math.max(1, Math.round(Lb / (isNum(o.bay) ? o.bay : 1.4 * r)))
  const node = (i, k) => { const t = (2 * Math.PI * k) / n + Math.PI / 2; return [r * Math.cos(t), r * Math.sin(t), z0 + (Lb * i) / nb] }
  for (let k = 0; k < n; k++) cyl(mb, node(0, k), node(nb, k), rr, 6, true, true)
  for (let i = 0; i <= nb; i++) for (let k = 0; k < n; k++) cyl(mb, node(i, k), node(i, (k + 1) % n), 0.8 * rr, 5, false, false)
  for (let i = 0; i < nb; i++) for (let k = 0; k < n; k++) {
    const a = (i + k) & 1 ? node(i, k) : node(i, (k + 1) % n), b = (i + k) & 1 ? node(i + 1, (k + 1) % n) : node(i + 1, k)
    cyl(mb, a, b, 0.6 * rr, 5, false, false)
  }
  cyl(put('aluminum'), [0, 0, L - 0.004], [0, 0, L], 1.15 * r, 24, true, true)
  return { tip: [0, 0, L] }
}

// ───────────────────────────── 对数周期天线 / 天线罩 / 缝隙波导棒条 / 仪器箱 ─────────────────────────────

/**
 * 对数周期偶极子天线（LPDA；GPS IIR 核爆探测 W 传感器的「圣诞树」即此类）：竖杆（集合线，沿 +z）上 N 层振子，自下而上按 τ 逐层缩短，
 * 波束指向短振子一端（+z）。crossed = 每层两根正交振子（±45°，双极化）；否则单根沿局部 x。每层一只轴套。
 * 设计式（Carrel 1961；Balanis《Antenna Theory》§11.4）：最长振子全长 = λmax/2（λmax = c / fL）、相邻层长度比 τ、层距 dₙ = 2σ·Lₙ；
 * 层数 N = ⌈ln(fH / fL) / ln(1/τ)⌉ + 2（两端各留一层带宽余量）。
 * o = { fL, fH（GHz）, tau, sigma, crossed, standoff（杆根到第一层）, mastR, elemR, mat:{elem, mast}, seg }
 * @returns {{tip:number[], n:number, Lmax:number, height:number, totalElem:number}}
 */
export function lpdaAntenna(put, o) {
  const tau = o.tau, sigma = o.sigma
  const n = Math.max(2, Math.ceil(Math.log(o.fH / o.fL) / Math.log(1 / tau)) + 2)
  const Lmax = lambdaOf(o.fL) / 2
  const m = { elem: 'black_paint', mast: 'black_paint', ...(o.mat || {}) }
  const er = o.elemR, mr = o.mastR
  let z = o.standoff, L = Lmax, total = 0
  const st = []
  for (let k = 0; k < n; k++) { st.push([z, L]); total += (o.crossed ? 2 : 1) * L; z += 2 * sigma * L; L *= tau }
  const zTop = st[st.length - 1][0] + 0.06 * Lmax * tau ** (n - 1) + 2 * mr
  cyl(put(m.mast), [0, 0, 0], [0, 0, zTop], mr, 12, true, true)
  cyl(put(m.mast), [0, 0, 0], [0, 0, 0.012], 2.4 * mr, 16, false, true)
  const c = Math.SQRT1_2
  for (const [zs, Ls] of st) {
    // 两根正交振子同高（在集合线轴套处交叉）：关于 xz / yz 两面都对称
    for (const [dx, dy] of o.crossed ? [[c, c], [c, -c]] : [[1, 0]]) cyl(put(m.elem), [-dx * Ls / 2, -dy * Ls / 2, zs], [dx * Ls / 2, dy * Ls / 2, zs], er, 8, true, true)
    cyl(put(m.mast), [0, 0, zs - 3 * er], [0, 0, zs + 3 * er], 2.2 * mr, 12, true, true)
  }
  return { tip: [0, 0, zTop], n, Lmax, height: zTop, totalElem: total }
}

/** 八边形（对边距的一半 inR）取顶点 + 边中点共 16 点（与十六边形顶面一一放样，折面罩用） */
function octa16(inR) {
  const R = inR / Math.cos(Math.PI / 8), v = []
  for (let k = 0; k < 8; k++) { const t = (22.5 + 45 * k) * DEG; v.push([R * Math.cos(t), R * Math.sin(t)]) }
  const out = []
  for (let k = 0; k < 8; k++) { const a = v[k], b = v[(k + 1) % 8]; out.push(a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) }
  return out
}
/**
 * 天线罩 / 多面体隔热罩（罩住导航阵 / 星间天线阵）：
 *   'faceted'：八边形底（对边距 2·rb）放样到十六边形平顶（外接圆半径 rt），高 H，折面硬边（GPS IIR 黑色 / GPS III 银色 MLI 帐）；
 *   'dome'：圆柱段（0.6 H）+ 椭球顶（白色介质天线罩）。局部：底在 z = 0、朝 +z。o = { style, rb, rt, H, mat, seg }
 * @returns {{top:number, area:number}}
 */
export function shroud(put, o) {
  const mb = put(o.mat || 'mli_black')
  if (o.style === 'dome') {
    const n = 8, h1 = 0.6 * o.H, prof = [[o.rb, 0], [o.rb, h1]]
    for (let i = 1; i <= n; i++) { const t = (i / n) * Math.PI / 2; prof.push([o.rb * Math.cos(t), h1 + (o.H - h1) * Math.sin(t)]) }
    prof[prof.length - 1] = [0, o.H]
    latheF(mb, LOCAL, prof, o.seg || 48)
    return { top: o.H, area: 2 * Math.PI * o.rb * h1 + Math.PI * o.rb * o.rb * 1.6 }
  }
  const A = octa16(o.rb), B = []
  for (let k = 0; k < 16; k++) { const t = (11.25 + 22.5 * k) * DEG; B.push([o.rt * Math.cos(t), o.rt * Math.sin(t)]) }
  // 侧面：每个四边形拆成两个平面三角形（折面硬边）；顶面十六边形
  for (let k = 0; k < 16; k++) {
    const a0 = [A[k][0], A[k][1], 0], a1 = [A[(k + 1) % 16][0], A[(k + 1) % 16][1], 0], b0 = [B[k][0], B[k][1], o.H], b1 = [B[(k + 1) % 16][0], B[(k + 1) % 16][1], o.H]
    for (const [p, q, r] of [[a0, a1, b1], [a0, b1, b0]]) {
      let nn = nrm(cross(sub(q, p), sub(r, p)))
      const mid = scl(add(add(p, q), r), 1 / 3)
      if (dot(nn, [mid[0], mid[1], 0]) < 0) nn = scl(nn, -1)
      tri(mb, p, q, r, nn)
    }
  }
  fan(mb, B.map(([x, y]) => [x, y, o.H]), [0, 0, 1])
  const sl = Math.hypot(o.H, o.rb - o.rt)
  return { top: o.H, area: Math.PI * o.rt * o.rt + 0.5 * (2 * Math.PI * o.rb * 1.03 + 2 * Math.PI * o.rt) * sl }
}

/**
 * 缝隙波导阵（棒条天线；一网 Ku 用户天线 = 8 根带方形辐射口的铝棒条，扇形外倾）：安装板（金色 MLI）+ n 根矩形波导棒条
 * （长 L 沿局部 x、宽 w、高 h），沿局部 y 以中心距 pitch 排开，第 k 根绕自身长轴外倾 fan·(k − (n−1)/2)；每根口面一排 slots 个深色辐射缝。
 * o = { n, L, w, h, pitch, fanDeg, slots, mat:{bar, base} } @returns {{top:number, plate:number[]}}
 */
export function slotBars(put, o) {
  const m = { bar: 'aluminum', base: 'mli_gold', ...(o.mat || {}) }
  const span = (o.n - 1) * o.pitch + o.w, tb = Math.max(0.006, 0.25 * o.h)
  bevelBox(put(m.base), LOCAL, [0, 0, tb / 2], [o.L / 2 + 0.02, span / 2 + 0.02, tb / 2], Math.min(0.006, 0.3 * tb))
  let top = tb
  for (let k = 0; k < o.n; k++) {
    const y0 = (k - (o.n - 1) / 2) * o.pitch, a = (k - (o.n - 1) / 2) * o.fanDeg * DEG
    // 棒条系：原点在根部中心、x 沿棒长、z = 外倾后的口面法向
    const F = frame([0, y0, tb], [1, 0, 0], [0, Math.cos(a), Math.sin(a)], [0, -Math.sin(a), Math.cos(a)])
    obox(put(m.bar), F, [0, 0, o.h / 2], [o.L / 2, o.w / 2, o.h / 2], ['+x', '-x', '+y', '-y', '+z'])
    const sp = o.L / o.slots
    for (let j = 0; j < o.slots; j++) {
      const x = -o.L / 2 + (j + 0.5) * sp, sw = 0.36 * sp, sh = 0.32 * o.w
      quadPts(put('black_paint'), toW(F, [x - sw, -sh, o.h + 0.0004]), toW(F, [x + sw, -sh, o.h + 0.0004]), toW(F, [x + sw, sh, o.h + 0.0004]), toW(F, [x - sw, sh, o.h + 0.0004]), F.z)
    }
    top = Math.max(top, toW(F, [0, 0, o.h])[2])
  }
  return { top, plate: [o.L + 0.04, span + 0.04] }
}

/**
 * 仪器箱（对地成像仪 / 探测仪 / 闪电成像仪等光学载荷外形）：倒角盒体（外表面 finish）+ 观测窗（深色玻璃，开在 +z 顶面或 +x 侧面）+
 * 窗口四周遮光檐（白，外张 15°，长 shade）+ 辐射制冷器（OSR 板，开在 ±y 面）。局部：底面在 z = 0、盒高 Z。
 * o = { X, Y, Z, win:'top'|'side', ww, wh（观测窗宽 / 高）, shade, cooler:'none'|'+y'|'-y', finish } @returns {{aperture:number[], dir:number[]}}
 */
export function instrumentBox(put, o) {
  const h = [o.X / 2, o.Y / 2, o.Z / 2], c = [0, 0, o.Z / 2]
  bevelBox(put(o.finish || 'mli_silver'), LOCAL, c, h, Math.min(0.02, 0.08 * Math.min(h[0], h[1], h[2])))
  // 观测窗：面系 F（原点在面外 4 mm）
  const side = o.win === 'side'
  const F = side ? frame([h[0] + 0.004, 0, o.Z / 2], [0, 0, 1], [0, -1, 0], [1, 0, 0]) : frame([0, 0, o.Z + 0.004], [1, 0, 0], [0, 1, 0], [0, 0, 1])
  const ww = o.ww / 2, wh = o.wh / 2
  quadPts(put('glass'), toW(F, [-ww, -wh, 0]), toW(F, [ww, -wh, 0]), toW(F, [ww, wh, 0]), toW(F, [-ww, wh, 0]), F.z)
  if (o.shade > 0) {
    const sp = Math.tan(15 * DEG) * o.shade, C4 = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = C4[i], [x1, y1] = C4[(i + 1) % 4]
      const p0 = toW(F, [x0 * ww, y0 * wh, 0]), p1 = toW(F, [x1 * ww, y1 * wh, 0])
      const q1 = toW(F, [x1 * (ww + sp), y1 * (wh + sp), o.shade]), q0 = toW(F, [x0 * (ww + sp), y0 * (wh + sp), o.shade])
      const n = nrm(sub(scl(add(add(p0, p1), add(q0, q1)), 0.25), toW(F, [0, 0, o.shade / 2])))
      quadPts(put('white_paint'), p0, p1, q1, q0, n)
      quadPts(put('white_paint'), p0, q0, q1, p1, scl(n, -1))
    }
  }
  if (o.cooler === '+y' || o.cooler === '-y') {
    const s = o.cooler === '+y' ? 1 : -1, y = s * (h[1] + 0.006), cx = 0.42 * o.X, cz = 0.42 * o.Z
    quadPts(put('radiator'), [-cx, y, o.Z / 2 - cz], [cx, y, o.Z / 2 - cz], [cx, y, o.Z / 2 + cz], [-cx, y, o.Z / 2 + cz], [0, s, 0])
    // 辐冷器遮光檐（朝天一侧挡地气辐射的斜板）
    const z1 = o.Z / 2 + cz
    quadPts(put('mli_gold'), [-cx, y, z1], [cx, y, z1], [cx, y + s * 0.4 * cz, z1 + 0.25 * cz], [-cx, y + s * 0.4 * cz, z1 + 0.25 * cz], nrm([0, s * 0.53, -0.85]))
    quadPts(put('mli_gold'), [-cx, y, z1], [-cx, y + s * 0.4 * cz, z1 + 0.25 * cz], [cx, y + s * 0.4 * cz, z1 + 0.25 * cz], [cx, y, z1], nrm([0, -s * 0.53, 0.85]))
  }
  return { aperture: toW(F, [0, 0, 0]), dir: F.z.slice() }
}

// ───────────────────────────── 对接与分离机构 ─────────────────────────────

/**
 * 对接与分离机构（局部：安装面在 z = 0、朝 +z 伸出）：
 *   'lvring' 星箭对接环：圆柱段 + 外缘 V 形法兰（包带夹紧面，hardware.lvRing）+ 一道深色包带；D = 937 / 1194 / 1666 mm 档，高 L；
 *   'probe' 探杆式对接机构（在轨服务飞行器对接目标星发动机喷管的那种）：三根斜撑 → 中心毂 → 探杆（长 L）+ 锥形探头 + 三只抓捕爪；
 *   'grapple' 抓捕靶标 / 操作接口（DogTag 一类）：黑色方座（边长 D、厚 L）+ 三枚白色识别标志 + 中心抓捕销。
 * o = { type, D, L } @returns {{tip:number[], massKg:number}}（massKg 为铝合金 / 钛结构的示意质量）
 */
export function dockMechanism(put, o) {
  const D = o.D, L = o.L
  if (o.type === 'probe') {
    const rb = D / 2, hz = 0.42 * L, rh = 0.12 * D, rp = Math.max(0.02, 0.065 * D)
    latheF(put('titanium'), LOCAL, [[0.82 * rb, 0], [rb, 0], [rb, 0.012], [0.82 * rb, 0.012], [0.82 * rb, 0]], 48)
    for (let k = 0; k < 3; k++) {
      const t = (2 * Math.PI * k) / 3 + Math.PI / 2, c = Math.cos(t), s = Math.sin(t)
      cyl(put('titanium'), [0.9 * rb * c, 0.9 * rb * s, 0.012], [rh * c, rh * s, hz], Math.max(0.012, 0.03 * D), 10, true, true)
    }
    latheF(put('aluminum'), LOCAL, [[0, hz - 0.04 * L], [rh, hz - 0.04 * L], [rh, hz + 0.08 * L], [0.6 * rh, hz + 0.1 * L], [0, hz + 0.1 * L]], 32)
    cyl(put('aluminum'), [0, 0, hz + 0.1 * L], [0, 0, 0.82 * L], rp, 20, false, false)
    latheF(put('titanium'), LOCAL, [[0, 0.82 * L], [1.5 * rp, 0.82 * L], [1.5 * rp, 0.84 * L], [0.35 * rp, L], [0, L]], 24)
    // 抓捕爪（探头后的三片铰接爪，收拢态贴在杆上）
    for (let k = 0; k < 3; k++) {
      const t = (2 * Math.PI * k) / 3 + Math.PI / 2, c = Math.cos(t), s = Math.sin(t)
      cyl(put('dark_metal'), [1.1 * rp * c, 1.1 * rp * s, 0.66 * L], [1.9 * rp * c, 1.9 * rp * s, 0.8 * L], 0.3 * rp, 8, true, true)
    }
    return { tip: [0, 0, L], massKg: 2 * (L + 3 * Math.hypot(0.9 * rb - rh, hz)) + 4 }
  }
  if (o.type === 'grapple') {
    bevelBox(put('black_paint'), LOCAL, [0, 0, L / 2], [D / 2, D / 2, L / 2], Math.min(0.004, 0.08 * L))
    for (const [x, y] of [[-0.25, 0.25], [0.25, -0.25], [0.25, 0.25]]) {
      const s = 0.09 * D
      quadPts(put('white_paint'), [x * D - s, y * D - s, L + 0.0005], [x * D + s, y * D - s, L + 0.0005], [x * D + s, y * D + s, L + 0.0005], [x * D - s, y * D + s, L + 0.0005], [0, 0, 1])
    }
    latheF(put('aluminum'), LOCAL, [[0, L], [0.07 * D, L], [0.07 * D, L + 0.3 * D], [0.12 * D, L + 0.34 * D], [0.12 * D, L + 0.4 * D], [0, L + 0.4 * D]], 20)
    return { tip: [0, 0, L + 0.4 * D], massKg: 2700 * D * D * L * 0.15 + 0.1 }
  }
  // 星箭对接环
  lvRing(put, { c: [0, 0, 0], dir: [0, 0, 1], up: [1, 0, 0], D, H: L, seg: 72 })
  const R = D / 2, w = Math.max(0.004, 0.006 * R / 0.6)
  torus(put('dark_metal'), [0, 0, L - 1.6 * w], [0, 0, 1], R + 2.6 * w, 0.9 * w, 72, 6)
  return { tip: [0, 0, L], massKg: 2700 * Math.PI * D * L * 2 * w }
}
// ───────────────────────────── 电推力器指向臂 ─────────────────────────────
//
// 全电推 GEO 平台把霍尔推力器装在可展开的指向臂末端（欧洲星 E3000e / Neo：背地面南北各一根两节臂，末端双推力器吊舱；空间客车 Neo
// 同式；在轨延寿飞行器 MEV 单节臂）；波音 702SP、SSL 1300 则是两轴指向机构直接装在背地面上。造型分四段，由调用方放进不同节点系
// （根部支座静止、各节臂杆与末端指向机构随关节转）：
//   epArmRoot 根部支座 / 立柱（组件局部系）、epArmSegment 一节臂杆（臂系：z = 臂向、y = 铰链轴）、
//   epThrusterHead 末端两轴指向机构 + 推力器吊舱（指向系：z = 喷流方向、x / y = 两根转轴）。

/**
 * 指向臂各段尺寸（米）：按臂杆直径 dA、放电通道直径 Dch、推力器台数 n 推算。
 *   S = 霍尔推力器本体边长（hardware.hallThruster：1.5 Dch）、Lb = 本体深（1.2 Dch）；
 *   rj / wj = 铰链驱动半径 / 长，h0 = 根部铰链轴高；ra = 指向机构作动器半径；sp = 推力器中心距；
 *   pod = 吊舱半宽 hx（沿第一转轴）/ 半高 hy / 厚 t；zp = 转动中心到吊舱背面；hp = 无臂型立柱上的转动中心高。
 */
export function epArmDims(dA, Dch, n) {
  const S = 1.5 * Dch
  const rj = Math.max(0.03, 0.75 * dA)
  const ra = Math.max(0.025, 0.24 * S)
  const sp = 1.7 * S
  return {
    S, Lb: 1.2 * Dch, rj, wj: 2.2 * rj, h0: Math.max(0.05, 1.5 * rj), ra, sp,
    pod: { hx: ((n - 1) / 2) * sp + 0.62 * S, hy: 0.66 * S, t: 0.42 * S }, zp: 2.6 * ra, hp: Math.max(0.12, 1.6 * S)
  }
}

/**
 * 根部支座（组件局部系，安装面 z = 0）：倒角方座 + 两片钛耳板夹着沿局部 Y 的根部铰链驱动（轴心 z = h0）。
 * 无臂型（pedestal）改画方座 + 钛立柱，托到转动中心下方（转动中心 z = hp，指向机构由 epThrusterHead 画）。
 * o = { g（epArmDims）, mat（方座外表面）, pedestal?, seg? }
 */
export function epArmRoot(put, o) {
  const g = o.g, seg = o.seg || 24
  if (o.pedestal) {
    const rb = 1.6 * g.ra
    bevelBox(put(o.mat), LOCAL, [0, 0, 0.02], [1.5 * rb, 1.5 * rb, 0.02], 0.006)
    cyl(put('titanium'), [0, 0, 0.04], [0, 0, g.hp - 0.9 * g.ra], 0.75 * g.ra, seg, false, true)
    return
  }
  const bz = 0.5 * g.h0, bx = 1.5 * g.rj + 0.015, by = g.wj / 2 + 0.3 * g.rj + 0.01
  bevelBox(put(o.mat), LOCAL, [0, 0, bz / 2], [bx, by, bz / 2], Math.min(0.006, 0.2 * bz))
  const te = 0.18 * g.rj + 0.004, top = g.h0 + 0.7 * g.rj
  for (const s of [1, -1]) obox(put('titanium'), LOCAL, [0, s * (g.wj / 2 + te / 2 + 0.002), (bz + top) / 2], [1.05 * g.rj, te / 2, (top - bz) / 2])
  cyl(put('dark_metal'), [0, -g.wj / 2, g.h0], [0, g.wj / 2, g.h0], g.rj, seg, true, true)
}

/**
 * 一节臂杆（臂系 F：F.o = 起点铰链轴心、F.z = 臂向、F.y = 铰链轴）：起点钛接头（夹在铰链驱动上）→ 两端钛箍 + 臂管（外表面 mat；
 * MLI 包覆时画两道深色绑带）→ 末端 'elbow'：下一个铰链驱动（沿 F.y、轴心 z = L）+ 接头；'wrist'：臂管收成锥形腕部，止于末端
 * 指向机构第一轴作动器外（转动中心在 z = L）。o = { L, r（臂管半径）, g（epArmDims）, mat, end:'elbow'|'wrist', seg? }
 */
export function epArmSegment(put, F, o) {
  const g = o.g, r = o.r, L = o.L, seg = o.seg || 20
  const P = (z) => toW(F, [0, 0, z])
  const lug = (zc, s) => obox(put('titanium'), F, [0, 0, zc + s * 0.7 * g.rj], [0.72 * g.rj, 0.3 * g.wj, 0.7 * g.rj])
  lug(0, 1)
  const elbow = o.end === 'elbow'
  const z0 = 1.4 * g.rj, z1 = elbow ? L - 1.4 * g.rj : L - 1.9 * g.ra
  const c = Math.min(0.5 * g.rj, 0.2 * Math.max(0, z1 - z0))
  if (z1 - z0 > 2 * c + 1e-3) {
    cyl(put('titanium'), P(z0), P(z0 + c), 1.12 * r, seg, true, false)
    cyl(put(o.mat), P(z0 + c), P(z1 - c), r, seg, false, false)
    cyl(put('titanium'), P(z1 - c), P(z1), 1.12 * r, seg, false, !elbow)
    if (/^mli/.test(o.mat)) for (const f of [1 / 3, 2 / 3]) { const z = z0 + (z1 - z0) * f; cyl(put('dark_metal'), P(z - 0.008), P(z + 0.008), 1.04 * r, seg, false, false) }
  }
  if (elbow) {
    lug(L, -1)
    cyl(put('dark_metal'), toW(F, [0, -g.wj / 2, L]), toW(F, [0, g.wj / 2, L]), g.rj, seg, true, true)
  } else {
    // 腕部：臂管端 → 第一轴作动器（转动中心前 0.9 ra 收口）
    cone(put('titanium'), P(z1), 1.12 * r, P(L - 0.9 * g.ra), 0.7 * g.ra, seg, false, true)
  }
}

/**
 * 末端两轴指向机构 + 推力器吊舱（指向系 A：A.o = 转动中心、A.z = 喷流方向、A.x = 第一转轴、A.y = 第二转轴）：
 * 第一轴作动器（沿 A.x 的深色圆柱，过转动中心）→ 钛轭 → 第二轴作动器（沿 A.y，z = 1.3 ra）→ 钛立柱 → 吊舱（外表面 podMat 的倒角盒，
 * 背面 z = zp）→ n 台霍尔推力器（出口朝 A.z、沿 A.x 并排；推力器 up 取 A.x：阴极挂在 A.y 一侧，整组关于「A.y–A.z 面」对称）。
 * o = { g（epArmDims）, n, Dch, podMat, seg? } @returns {{exits:number[][]}}（各推力器出口中心）
 */
export function epThrusterHead(put, A, o) {
  const g = o.g, seg = o.seg || 24, p = g.pod, z2 = 1.3 * g.ra
  cyl(put('dark_metal'), toW(A, [-1.2 * g.ra, 0, 0]), toW(A, [1.2 * g.ra, 0, 0]), g.ra, seg, true, true)
  obox(put('titanium'), A, [0, 0, z2 / 2], [0.5 * g.ra, 0.5 * g.ra, z2 / 2])
  cyl(put('dark_metal'), toW(A, [0, -0.95 * g.ra, z2]), toW(A, [0, 0.95 * g.ra, z2]), 0.78 * g.ra, seg, true, true)
  cyl(put('titanium'), toW(A, [0, 0, z2]), toW(A, [0, 0, g.zp]), 0.45 * g.ra, seg, false, false)
  bevelBox(put(o.podMat), A, [0, 0, g.zp + p.t / 2], [p.hx, p.hy, p.t / 2], Math.min(0.012, 0.15 * p.t))
  const exits = []
  for (let k = 0; k < o.n; k++) {
    const exit = toW(A, [(k - (o.n - 1) / 2) * g.sp, 0, g.zp + p.t + g.Lb])
    hallThruster(put, { exit, dir: A.z, up: A.x, Dch: o.Dch, seg })
    exits.push(exit)
  }
  return { exits }
}

// ───────────────────────────── 遮阳板 ─────────────────────────────

/**
 * 遮阳板（铰链系 F：F.o = 铰链轴中点、F.y = 铰链轴、F.x = 板面展开方向、F.z = 板面法向）：沿 F.y 分 n 块（块间缝 gap）、
 * 每块厚 t 的平板（外表面 mat；星链 VisorSat 为黑色泡沫板）；frame = 四周钛细管边框（膜式遮光板张在框上）；每块两枚铰链节 +
 * 一根贯通铰链轴。o = { W（总宽）, Ld（铰链轴到外缘）, n, gap, t, mat, frame?, seg? }
 * @returns {{area:number, rp:number, knuckles:number[]}}（板面积、铰链轴半径、铰链节沿 F.y 的位置——调用方在安装面上画对应的铰链座）
 */
export function visorPanels(put, F, o) {
  const n = Math.max(1, o.n | 0), w = (o.W - (n - 1) * o.gap) / n, seg = o.seg || 12
  const rp = Math.max(0.005, Math.min(0.02, 0.5 * o.t + 0.004))
  const x0 = 1.8 * rp
  let area = 0
  const knuckles = []
  for (let i = 0; i < n; i++) {
    const yc = -o.W / 2 + w / 2 + i * (w + o.gap)
    obox(put(o.mat), F, [(x0 + o.Ld) / 2, yc, 0], [(o.Ld - x0) / 2, w / 2, o.t / 2])
    area += (o.Ld - x0) * w
    if (o.frame) {
      const fr = Math.max(0.004, 0.5 * o.t + 0.002)
      const C = [[x0, yc - w / 2], [o.Ld, yc - w / 2], [o.Ld, yc + w / 2], [x0, yc + w / 2]]
      for (let k = 0; k < 4; k++) cyl(put('titanium'), toW(F, [C[k][0], C[k][1], 0]), toW(F, [C[(k + 1) % 4][0], C[(k + 1) % 4][1], 0]), fr, 8, true, true)
    }
    for (const f of [-0.35, 0.35]) {
      const yk = yc + f * w, hk = Math.min(0.05 * w + 0.01, 0.06)
      obox(put('titanium'), F, [x0 / 2 + 0.1 * rp, yk, 0], [x0 / 2 + 0.1 * rp, hk / 2, Math.max(o.t / 2, 0.9 * rp)])
      knuckles.push(yk)
    }
  }
  cyl(put('aluminum'), toW(F, [0, -o.W / 2, 0]), toW(F, [0, o.W / 2, 0]), rp, seg, true, true)
  return { area, rp, knuckles }
}

// ───────────────────────────── 电子消旋阵 ─────────────────────────────

/**
 * 电子消旋天线阵（自旋稳定星顶端；局部：安装面 z = 0、自旋轴 = +z）：安装环 → 深色圆柱芯（Ø D、高 H）+ 外层银色栅格（nc 根竖条 =
 * 辐射单元列、nr + 1 道横环）→ 白色顶盘（Ø discD，0 = 无）→ 黑色测控桅杆（Ø mastD、高 mastH，0 = 无）+ 顶端细杆（rodH）。
 * 星体每转一圈，馈电逐列切换到对地那一侧，波束不随星转（Meteosat 第二代 L 频段、风云二号 S 频段）。
 * o = { D, H, nc, nr, discD, mastH, mastD, rodH, mat, seg? } @returns {{zMid:number, R:number, top:number}}
 */
export function edaArray(put, o) {
  const R = o.D / 2, seg = o.seg || Math.max(48, 2 * o.nc)
  const hb = Math.max(0.02, 0.06 * o.H), zt = hb + o.H
  cyl(put('aluminum'), [0, 0, 0], [0, 0, hb], 0.94 * R, seg, false, true)
  cyl(put('black_paint'), [0, 0, hb], [0, 0, zt], 0.965 * R, seg, false, false)
  const pitch = (2 * Math.PI * R) / o.nc, wb = Math.min(0.3 * pitch, 0.05), tb = Math.min(0.025 * R + 0.004, 0.4 * pitch)
  for (let k = 0; k < o.nc; k++) {
    const a = (2 * Math.PI * k) / o.nc, ca = Math.cos(a), sa = Math.sin(a)
    const Fk = frame([R * ca, R * sa, hb + o.H / 2], [ca, sa, 0], [-sa, ca, 0], [0, 0, 1])
    obox(put(o.mat), Fk, [-tb / 2, 0, 0], [tb / 2, wb / 2, o.H / 2])
  }
  const hr = Math.min(0.008, 0.02 * o.H)
  for (let i = 0; i <= o.nr; i++) {
    const z = hb + (o.H * i) / o.nr, z0 = Math.max(hb, z - hr), z1 = Math.min(zt, z + hr)
    cyl(put(o.mat), [0, 0, z0], [0, 0, z1], R + 0.002, seg, false, false)
  }
  let top = zt
  if (o.discD > 0) {
    const rd = o.discD / 2, td = Math.max(0.008, 0.02 * o.H)
    disc(put('white_paint'), [0, 0, zt], [0, 0, -1], rd, seg)
    cyl(put('white_paint'), [0, 0, zt], [0, 0, zt + td], rd, seg, false, true)
    top = zt + td
  }
  if (o.mastH > 0) {
    cyl(put('black_paint'), [0, 0, top], [0, 0, top + o.mastH], o.mastD / 2, 20, false, true)
    top += o.mastH
    if (o.rodH > 0) { cyl(put('aluminum'), [0, 0, top], [0, 0, top + o.rodH], Math.max(0.008, 0.07 * o.mastD), 8, false, true); top += o.rodH }
  }
  return { zMid: hb + o.H / 2, R, top }
}
