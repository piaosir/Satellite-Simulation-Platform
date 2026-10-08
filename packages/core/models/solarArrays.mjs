// 太阳翼造型库（2026-10-08「太阳翼种类补全」）：电池板（砷化镓 / 硅、单面 / 双面）、连接架（V 形 / 梯形 / 单杆）、
// 柔性太阳翼（伸展杆 + 两张折叠帆，国际空间站 / 天宫）、卷展式太阳翼（ROSA：两根开口薄壁管伸展杆 + 帆 + 翼尖卷筒）、
// 圆形太阳翼（UltraFlex：扇形折叠的多边形帆 + 径向翼梁 + 中心毂）、铰接式太阳板（星链单翼 / 立方星展开板：铰链 + 折叠段）。
// 刚性板式翼（GEO 一字形 / 十字形）仍在 paramBus.buildWing（整星与装配件 sat.wing 共用）。
//
// 为什么（2026-10-08 用户：「太阳翼种类补全」「组件里的」）：装配组件库的太阳翼只有刚性板式一种，星座精模里的星链铰接单翼、
// 空间站柔性翼、卷展式、圆形翼都没法用组件拼。
//
// 口径（同 antennas.mjs / hardware.mjs）：纯网格、零 three 依赖；put(matKey) → MB 按材质分桶；不登记节点 / 质量元 / 挂点（调用方登记）。
// 翼系 F（kit frame）：x = 翼宽、y = 翼展（自翼根向外）、z = 电池面法向——与 paramBus.buildWing 的翼局部系同向。
// ★ 对称：几何关于翼系 yz 面（x → −x）逐点对称——圆柱 / 回转体分段一律取偶数（kit.frustum 的起始方向经镜像落到 π − θ）、
//   桁架斜杆画成交叉（X 形），装配件镜像时用「绕翼轴转角取反」的钩子即可得到真镜像。
//
// 导出：CELL_MATS、siLines、cellPanel、solarYoke、latticeAlong、flexBlanketWing、rosaWing、circularWing、hingedPanels

import { MB, perpPair } from './meshKit.mjs'
import { toW, dirW, obox, bevelBox, cyl, quadPts, tri, nrm, madd, sub, len } from './fleet/kit.mjs'
import { insetPoly } from './antennas.mjs'

export { MB }

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const DEG = Math.PI / 180
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

/** 电池片材质：三结砷化镓（深蓝近黑，材质库自带电池栅格纹理）/ 硅（亮蓝，另画白色汇流条） */
export const CELL_MATS = Object.freeze({ gaas: 'solar_cell', si: 'cell_si' })

/**
 * 硅电池的白色汇流条（电池区 ±cw × ±ch，系 F 里、板中心 (cx, cy)、面 z、法向 n）：竖线约每 0.2 m、横线约每 0.12 m，按电池区等分
 * （线位关于板中心对称；窄板按比例加密）。
 */
export function siLines(mb, F, cx, cy, cw, ch, z, n) {
  const nu = Math.max(1, Math.round((2 * cw) / clamp((2 * cw) / 6, 0.04, 0.2))), nv = Math.max(1, Math.round((2 * ch) / clamp((2 * ch) / 10, 0.03, 0.12)))
  const du = (2 * cw) / nu, dv = (2 * ch) / nv, lw = Math.min(0.006, 0.12 * Math.min(du, dv))
  const P = (x, y) => toW(F, [cx + x, cy + y, z])
  for (let i = 1; i < nu; i++) { const u = -cw + i * du; quadPts(mb, P(u - lw / 2, -ch), P(u + lw / 2, -ch), P(u + lw / 2, ch), P(u - lw / 2, ch), n) }
  for (let i = 1; i < nv; i++) { const v = -ch + i * dv; quadPts(mb, P(-cw, v - lw / 2), P(cw, v - lw / 2), P(cw, v + lw / 2), P(-cw, v + lw / 2), n) }
}

/**
 * 一块电池板（翼系 F 里画；板面 ⟂ F.z、电池面朝 +z）：基板（四个侧面 + 背面；双面电池时背面也贴片）+ 正面留边 + 电池片（离板边 m）。
 * o = { cx, cy（板中心）, w（沿 F.x）, h（沿 F.y）, t（板厚）, m（电池区离板边）, cell:'gaas'|'si', both?（双面电池）, sub?（基板材质，
 *       缺省 solar_substrate）, zc?（板中面 z，缺省 0）}
 * @returns {number} 单面电池片面积
 */
export function cellPanel(put, F, o) {
  const t = o.t, zc = o.zc || 0, m = Math.max(0, Math.min(o.m, 0.45 * Math.min(o.w, o.h)))
  const sb = put(o.sub || 'solar_substrate'), cm = put(CELL_MATS[o.cell] || 'solar_cell')
  obox(sb, F, [o.cx, o.cy, zc], [o.w / 2, o.h / 2, t / 2], o.both ? ['+x', '-x', '+y', '-y'] : ['+x', '-x', '+y', '-y', '-z'])
  const hw = o.w / 2, hh = o.h / 2, cw = hw - m, ch = hh - m
  for (const s of o.both ? [1, -1] : [1]) {
    const z = zc + s * t / 2, zl = z + s * 0.0005, n = dirW(F, [0, 0, s])
    const P = (x, y, zz) => toW(F, [o.cx + x, o.cy + y, zz])
    if (m > 0) {
      quadPts(sb, P(-hw, -hh, z), P(hw, -hh, z), P(hw, -ch, z), P(-hw, -ch, z), n)
      quadPts(sb, P(-hw, ch, z), P(hw, ch, z), P(hw, hh, z), P(-hw, hh, z), n)
      quadPts(sb, P(-hw, -ch, z), P(-cw, -ch, z), P(-cw, ch, z), P(-hw, ch, z), n)
      quadPts(sb, P(cw, -ch, z), P(hw, -ch, z), P(hw, ch, z), P(cw, ch, z), n)
    }
    quadPts(cm, P(-cw, -ch, zl), P(cw, -ch, zl), P(cw, ch, zl), P(-cw, ch, zl), n)
    if (o.cell === 'si') siLines(put('white_paint'), F, o.cx, o.cy, cw, ch, zl + s * 0.0007, n)
  }
  return 4 * cw * ch
}

/**
 * 连接架（轭，翼系 F 里画，y0 → y1 沿翼展）：'v' V 形双杆 + 横梁（GEO 平台常见）；'trap' 梯形框 + 交叉斜撑；'rod' 单杆。
 * o = { y0, y1, W0（张开宽度参考，一般取板宽）, r（杆半径）, style, mat? } @returns {number[][][]} 各杆端点（翼系外的世界坐标；调用方记杆质量）
 */
export function solarYoke(put, F, o) {
  const mb = put(o.mat || 'carbon'), r = o.r, W = o.W0, y0 = o.y0, y1 = o.y1 - r
  let segs
  if (o.style === 'rod') segs = [[[0, y0], [0, o.y1]]]
  else if (o.style === 'trap') {
    const a = 0.22 * W, b = 0.42 * W
    segs = [[[-a, y0], [-b, y1]], [[a, y0], [b, y1]], [[-b, y1], [b, y1]], [[-a, y0], [a, y0]], [[-a, y0], [b, y1]], [[a, y0], [-b, y1]]]
  } else segs = [[[0, y0], [0.4 * W, y1]], [[0, y0], [-0.4 * W, y1]], [[-0.4 * W, y1], [0.4 * W, y1]]]
  const out = segs.map(([a, b]) => [toW(F, [a[0], a[1], 0]), toW(F, [b[0], b[1], 0])])
  for (const [a, b] of out) cyl(mb, a, b, r, 10, true, true)
  if (o.style !== 'rod') cyl(mb, toW(F, [-1.6 * r, y0, 0]), toW(F, [1.6 * r, y0, 0]), 1.8 * r, 12, true, true)   // 轭根接头
  return out
}

/**
 * 三角桁架伸展杆（两端点 A → B，世界坐标）：三根纵杆 + 每节一圈横撑 + 每个侧面交叉斜撑（国际空间站 FAST 杆即此形）。画进 mb。
 * r = 三角外接圆半径、rod = 纵杆半径、bayK = 节距 / 外接圆直径。
 */
export function latticeAlong(mb, A, B, r, rod, bayK = 0.9) {
  const d = nrm(sub(B, A)), L = len(sub(B, A)), [e1, e2] = perpPair(d)
  const nb = Math.max(1, Math.round(L / (bayK * 2 * r)))
  const node = (i, k) => { const t = (2 * Math.PI * k) / 3 + Math.PI / 2; return madd(madd(madd(A, d, (L * i) / nb), e1, r * Math.cos(t)), e2, r * Math.sin(t)) }
  for (let k = 0; k < 3; k++) cyl(mb, node(0, k), node(nb, k), rod, 6, true, true)
  for (let i = 0; i <= nb; i++) for (let k = 0; k < 3; k++) cyl(mb, node(i, k), node(i, (k + 1) % 3), 0.7 * rod, 6, false, false)
  for (let i = 0; i < nb; i++) for (let k = 0; k < 3; k++) {
    cyl(mb, node(i, k), node(i + 1, (k + 1) % 3), 0.45 * rod, 4, false, false)
    cyl(mb, node(i, (k + 1) % 3), node(i + 1, k), 0.45 * rod, 4, false, false)
  }
}

/**
 * 柔性太阳翼（国际空间站 / 天宫式，翼系 F 里画）：根部收纳箱（y0 起，横跨两帆）→ 中间三角桁架伸展杆（两帆之间、帆面之后）→
 * 两张折叠帆（各 n 块折叠板，板缝即折痕；外缘一根张紧索）→ 翼尖顶箱（帆盖）。
 * o = { y0, L（帆长）, wB（单帆宽）, gap（两帆间距）, n（每帆折叠板数）, mastD（伸展杆外接圆直径）, cell }
 * @returns {{yT:number, cellArea:number, blanketArea:number, W:number, bh:number, bd:number, boxes:number[][]}}（boxes：两只箱的中心，翼系坐标）
 */
export function flexBlanketWing(put, F, o) {
  const W = 2 * o.wB + o.gap, mr = o.mastD / 2
  const bh = Math.max(0.12, 0.6 * mr + 0.08), bd = Math.max(0.12, 1.1 * o.mastD)
  const yb1 = o.y0 + bh, yT = yb1 + o.L
  const box = (yA, h, d) => { const c = [0, yA + h / 2, 0.01 - d / 2]; bevelBox(put('aluminum'), F, c, [W / 2 + 0.03, h / 2, d / 2], Math.min(0.01, 0.1 * d)); return c }
  const boxes = [box(o.y0, bh, bd), box(yT, 0.6 * bh, 0.7 * bd)]
  latticeAlong(put('titanium'), toW(F, [0, yb1, -mr - 0.01]), toW(F, [0, yT, -mr - 0.01]), mr, Math.max(0.006, 0.05 * mr))
  const g = 0.004, h = (o.L - (o.n - 1) * g) / o.n
  let cellArea = 0
  for (const s of [-1, 1]) {
    const cx = s * (o.gap / 2 + o.wB / 2)
    for (let i = 0; i < o.n; i++) cellArea += cellPanel(put, F, { cx, cy: yb1 + i * (h + g) + h / 2, w: o.wB, h, t: 0.004, m: Math.min(0.03, 0.03 * o.wB), cell: o.cell })
    const xe = s * (o.gap / 2 + o.wB + 0.012)
    cyl(put('aluminum'), toW(F, [xe, yb1, 0]), toW(F, [xe, yT, 0]), 0.004, 6, false, false)
  }
  return { yT: yT + 0.6 * bh, cellArea, blanketArea: 2 * o.wB * o.L, W, bh, bd, boxes }
}

/**
 * 卷展式太阳翼（ROSA，翼系 F 里画）：根部横梁 → 帆两侧各一根开口薄壁管伸展杆（展开后成圆管）→ 帆（沿翼展分段的电池模块）→
 * 翼尖卷筒（收拢时帆与杆卷在它上面，展开后留在翼尖、横跨两杆）。
 * o = { y0, L（根部横梁到卷筒轴）, W（帆宽）, boomD, rollD, cell }
 * @returns {{yT:number, cellArea:number, blanketArea:number, xb:number}}（xb = 伸展杆中心离翼轴）
 */
export function rosaWing(put, F, o) {
  const br = o.boomD / 2, rr = o.rollD / 2, xb = o.W / 2 + br + 0.01, zb = -Math.max(br, 0.02)
  const yR = o.y0 + o.L
  obox(put('titanium'), F, [0, o.y0 + 0.04, zb], [xb + br + 0.01, 0.04, Math.max(br, 0.02) + 0.01])
  for (const s of [-1, 1]) cyl(put('aluminum'), toW(F, [s * xb, o.y0 + 0.08, zb]), toW(F, [s * xb, yR, zb]), br, 12, false, false)
  const y1 = o.y0 + 0.1, y2 = yR - rr - 0.02
  const n = Math.max(1, Math.round((y2 - y1) / 0.5)), g = 0.004, h = (y2 - y1 - (n - 1) * g) / n
  let cellArea = 0
  for (let i = 0; i < n; i++) cellArea += cellPanel(put, F, { cx: 0, cy: y1 + i * (h + g) + h / 2, w: o.W, h, t: 0.003, m: Math.min(0.03, 0.025 * o.W), cell: o.cell })
  cyl(put('dark_metal'), toW(F, [-xb - br, yR, zb]), toW(F, [xb + br, yR, zb]), rr, 24, true, true)
  for (const s of [-1, 1]) cyl(put('titanium'), toW(F, [s * (xb + br), yR, zb]), toW(F, [s * (xb + br + 0.03), yR, zb]), 0.6 * rr, 16, false, true)
  return { yT: yR + rr, cellArea, blanketArea: o.W * (y2 - y1), xb }
}

/**
 * 圆形太阳翼（UltraFlex，翼系 F 里画）：中心毂（yc）→ n 片三角帆（多边形帆，扇形折叠展开，扫过 sweep 度、缺口朝翼根）→
 * 每条径向边一根翼梁（正面白色压条 + 背面细杆）。帆面在 z = 0、电池朝 +z；毂伸到帆背后 zb（连接架从背后接到毂上）。
 * o = { yc, R（毂心到多边形顶点）, n, sweep, hubR, cell, zb }
 * @returns {{cellArea:number, area:number}}
 */
export function circularWing(put, F, o) {
  const n = o.n, sw = Math.min(360, o.sweep), t = 0.004
  const a0 = 90 - sw / 2, da = sw / n
  const V = (k) => { const a = (a0 + k * da) * DEG; return [o.R * Math.cos(a), o.yc + o.R * Math.sin(a)] }
  const H = [0, o.yc]
  const sb = put('solar_substrate'), cm = put(CELL_MATS[o.cell] || 'solar_cell'), wp = put('white_paint')
  const nz = dirW(F, [0, 0, 1]), nzb = dirW(F, [0, 0, -1])
  const P = (q, z) => toW(F, [q[0], q[1], z])
  let cellArea = 0, area = 0
  const m = Math.min(0.03, 0.012 * o.R)
  for (let k = 0; k < n; k++) {
    const A = V(k), B = V(k + 1)
    tri(sb, P(H, t / 2), P(A, t / 2), P(B, t / 2), nz)
    tri(sb, P(H, -t / 2), P(A, -t / 2), P(B, -t / 2), nzb)
    quadPts(sb, P(A, -t / 2), P(B, -t / 2), P(B, t / 2), P(A, t / 2), dirW(F, [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2 - o.yc, 0]))
    area += Math.abs((A[0] - H[0]) * (B[1] - H[1]) - (B[0] - H[0]) * (A[1] - H[1])) / 2
    const ins = insetPoly([H, A, B], m)
    if (ins && ins.length === 3) {
      tri(cm, P(ins[0], t / 2 + 0.0005), P(ins[1], t / 2 + 0.0005), P(ins[2], t / 2 + 0.0005), nz)
      cellArea += Math.abs((ins[1][0] - ins[0][0]) * (ins[2][1] - ins[0][1]) - (ins[2][0] - ins[0][0]) * (ins[1][1] - ins[0][1])) / 2
    }
  }
  // 翼梁：每条径向边（含扇形两端）正面一条白色压条、背面一根细杆
  const sw2 = Math.max(0.008, 0.007 * o.R), rr = Math.max(0.006, 0.006 * o.R)
  for (let k = 0; k <= n; k++) {
    if (sw >= 360 && k === n) break
    const A = V(k), d = nrm([A[0] - H[0], A[1] - H[1], 0]), q = [-d[1] * sw2 / 2, d[0] * sw2 / 2]
    const a = [H[0] + d[0] * o.hubR, H[1] + d[1] * o.hubR]
    quadPts(wp, P([a[0] - q[0], a[1] - q[1]], t / 2 + 0.0012), P([A[0] - q[0], A[1] - q[1]], t / 2 + 0.0012), P([A[0] + q[0], A[1] + q[1]], t / 2 + 0.0012), P([a[0] + q[0], a[1] + q[1]], t / 2 + 0.0012), nz)
    cyl(put('aluminum'), P(a, -t / 2 - rr), P(A, -t / 2 - rr), rr, 6, false, true)
  }
  cyl(put('aluminum'), P(H, -o.zb), P(H, t / 2 + 0.02), o.hubR, 24, true, true)
  return { cellArea, area }
}

/**
 * 铰接式太阳板（铰链系 F 里画：F.o = 铰链轴中点、F.y = 铰链轴、F.x = 板面展开方向、F.z = 电池面法向（收拢时朝外））：
 * 沿 F.x 分 rows 段（折叠段，段间小铰链）、沿 F.y 分 cols 列，每段一块电池板；根部一根贯通铰链轴 + 每列两枚铰链节。
 * o = { L（铰链轴到板外缘）, W（沿铰链宽）, rows, cols, gap, t, cell, both?, back?（基板 / 背面材质）}
 * @returns {{cellArea:number, area:number, rp:number, knuckles:number[]}}（rp 铰链轴半径；knuckles 铰链节沿 F.y 的位置）
 */
export function hingedPanels(put, F, o) {
  const rows = Math.max(1, o.rows | 0), cols = Math.max(1, o.cols | 0), g = o.gap, t = o.t
  const rp = Math.max(0.003, Math.min(0.015, 0.9 * t + 0.002)), x0 = 1.8 * rp
  const segL = (o.L - x0 - (rows - 1) * g) / rows, segW = (o.W - (cols - 1) * g) / cols
  let cellArea = 0
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    cellArea += cellPanel(put, F, { cx: x0 + i * (segL + g) + segL / 2, cy: -o.W / 2 + j * (segW + g) + segW / 2, w: segL, h: segW, t, m: Math.min(0.012, 0.05 * Math.min(segL, segW)), cell: o.cell, both: o.both, sub: o.back })
  }
  const hm = put('titanium'), knuckles = []
  for (let j = 0; j < cols; j++) {
    const yc = -o.W / 2 + j * (segW + g) + segW / 2
    for (const f of [-0.32, 0.32]) {
      const y = yc + f * segW, hk = Math.min(0.06, 0.12 * segW + 0.006)
      obox(hm, F, [x0 / 2 + 0.1 * rp, y, 0], [x0 / 2 + 0.1 * rp, hk / 2, Math.max(t / 2, rp)])
      knuckles.push(y)
      // 段间铰链（折叠段之间）
      for (let i = 1; i < rows; i++) {
        const xg = x0 + i * (segL + g) - g / 2
        cyl(hm, toW(F, [xg, y - hk / 2, 0]), toW(F, [xg, y + hk / 2, 0]), Math.max(0.6 * t, 0.002), 8, true, true)
      }
    }
  }
  cyl(put('aluminum'), toW(F, [0, -o.W / 2, 0]), toW(F, [0, o.W / 2, 0]), rp, 12, true, true)
  return { cellArea, area: rows * cols * segL * segW, rp, knuckles }
}
