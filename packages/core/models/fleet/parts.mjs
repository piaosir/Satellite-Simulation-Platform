// 星座卫星精模的组合件：按材质合并的部件网格（group）、太阳翼（wing）、万向节抛物面（gimbalDish）、
// 以及把 kit 里多材质造型件（霍尔推力器 / 星敏 / 激光终端 / 角反射器）落到部件上的便捷函数。
//
// ★ 节点数：3D 页一次最多画 32 颗聚焦星的图标，每个节点一个 draw call。同一部件、同一材质的网格一律并进一个节点
//   （group.mb(mat) 取同一个 MB），一颗精模控制在 ≲ 60 个节点。只有要转动的（太阳翼、万向节）才单独成节点。
// ★ 太阳翼节点口径与 paramBus.buildWing 一致：翼内全部转动节点（轭 / 基板 / 电池片 / 铰链）是根的直接子节点、共用同一个
//   翼局部系（原点在转轴根部、局部 +y 沿翼展向外、局部 +z 为电池面法向），关节 yRotate 恰好是整翼绕翼轴刚体转动；
//   太阳翼组只含电池片节点。关节名带 wing（3D 页 modelLayer 的 SOLAR_ART 按名字 / 电池片认太阳翼，自动对日）。

import { MB, BODY, frame, toW, dirW, cross, nrm, add, sub, scl, madd, dot, len, obox, bevelBox, cyl, cone, ring, disc, sweep, truss, hinge,
  dishShell, dishRim, hallThruster, starTracker, laserTerminal, reflectorCorners, quadPts, frameZX, RofF, helix, tri } from './kit.mjs'
import { frustum } from '../meshKit.mjs'

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * 部件网格组：同一部件按材质各攒一个 MB，flush 时每种材质登记一个节点（名 `${id}` 或 `${id}_${材质}`）。
 * @returns {{mb:(mat:string)=>MB, flush:(o?:{F?, parent?})=>string[], part}}
 */
export function group(B, id, name, role) {
  const part = { id, name, role }
  const mbs = new Map()
  return {
    part,
    mb(mat) { if (!mbs.has(mat)) mbs.set(mat, new MB()); return mbs.get(mat) },
    flush(o = {}) {
      const out = []
      const list = [...mbs.entries()].filter(([, m]) => m.tcount > 0)
      for (const [mat, m] of list) {
        const nm = `${id}_${mat}`   // 恒带材质后缀：节点名与挂点名（常与部件同名，如 nav_antenna）共用一张名表，不能撞
        B.item(nm, { part, role, mat, mb: m, F: o.F || BODY, parent: o.parent || null })
        out.push(nm)
      }
      return out
    }
  }
}

/**
 * 太阳翼。
 * @param {object} o
 *   name       翼名（节点 / 关节 / 太阳翼组 / 挂点前缀，须含 wing，如 'wing_+Y'）；title 部件名
 *   root       转轴根部（本体系；一般在星体侧面上）
 *   span       翼展方向（本体系单位向量，由根部指向翼尖）
 *   normal     静止位姿下电池面法向（⟂ span）
 *   panels     [{x, y, w, h}]：板在翼局部系里的矩形（x 横向中心、y 沿翼展起点、w 横宽、h 沿翼展长）；
 *              或给 n / panelW / panelH / gap，按一列排（y 从 yokeLen 起）
 *   yokeLen    轭（连接架）长；yoke:'V' | 'rod' | 'none'
 *   sadaLen / sadaD   驱动机构外露段（不随翼转，并进平台体部件）
 *   t          板厚；margin 电池区离板边；frameW 板边框宽（0 = 不画）
 *   hingeR     板间铰链半径（0 = 不画）
 *   backMat    板背面材质（缺省 solar_substrate）；cellMat 电池片材质（缺省 solar_cell）
 *   areal      {substrate, cells} 面密度（kg/m²，缺省密度表）；massKg 整翼质量（给了就按面积比例摊到各板，覆盖面密度）
 *   efficiency 太阳翼组效率（%）
 *   articulate 是否设单轴转动关节（缺省 true）；limits [min, max]（度）
 *   bothFaces  双面都是电池片（部分 LEO 平板翼背面也贴片时用，缺省 false）
 * @returns {{F, tip, cellArea, nodes}}
 */
export function wing(B, o) {
  const y = nrm(o.span), z = nrm(sub(o.normal, scl(y, dot(o.normal, y))))
  const x = cross(y, z)
  const F = frame(o.root, x, y, z)
  const name = o.name
  const t = isNum(o.t) ? o.t : 0.025, m = isNum(o.margin) ? o.margin : 0.02
  const sadaLen = isNum(o.sadaLen) ? o.sadaLen : 0, sadaD = isNum(o.sadaD) ? o.sadaD : 0.1
  const yokeLen = isNum(o.yokeLen) ? o.yokeLen : 0
  let panels = o.panels
  if (!panels) {
    panels = []
    const n = o.n || 1, w = o.panelW, h = o.panelH, gap = isNum(o.gap) ? o.gap : 0.03
    for (let k = 0; k < n; k++) panels.push({ x: 0, y: sadaLen + yokeLen + k * (h + gap), w, h })
  }
  const part = { id: name, name: o.title || name, role: 'solarArray' }
  const dens = B.ctx.dens
  const toB = (p) => toW(F, p)
  // SADA：固定在星体上（本体系几何，并进平台体或给定部件）
  if (sadaLen > 0) {
    const sm = new MB()
    cyl(sm, toB([0, -0.01, 0]), toB([0, sadaLen, 0]), sadaD / 2, 24, true, true)
    ring(sm, toB([0, sadaLen * 0.35, 0]), y, sadaD / 2, sadaD * 0.68, 24)
    ring(sm, toB([0, sadaLen * 0.35, 0]), scl(y, -1), sadaD / 2, sadaD * 0.68, 24)
    B.item(`${name}_sada`, { part: o.sadaPart || { id: 'bus', name: '平台体', role: 'bus' }, role: 'bus', mat: o.sadaMat || 'aluminum', mb: sm })
  }
  const artNodes = []
  // 轭：V 形双杆 + 横梁（长轭）或单杆（短轭）；翼局部系几何，随翼转
  if (yokeLen > 0.01 && o.yoke !== 'none') {
    const ym = new MB(), r = (o.yokeD || 0.05) / 2
    const W0 = Math.max(...panels.map((p) => Math.abs(p.x) + p.w / 2)) * 2
    const y0 = sadaLen, y1 = sadaLen + yokeLen - r
    if (o.yoke === 'rod' || yokeLen < 0.3) truss(ym, [[0, y0, 0], [0, y1 + r, 0]], r, 10)
    else if (o.yoke === 'trap') {
      // 梯形连接架：根部两点（翼宽 ±0.22）→ 翼根两点（±0.42），两端各一道横梁
      const a = 0.22 * W0, b = 0.42 * W0
      truss(ym, [[-a, y0, 0], [-b, y1, 0], [b, y1, 0], [a, y0, 0], [-a, y0, 0]], r, 10)
      truss(ym, [[-a, y0, 0], [b, y1, 0]], r * 0.8, 10)
      B.rod(name + '_yoke_1', toB([-a, y0, 0]), toB([-b, y1, 0])); B.rod(name + '_yoke_2', toB([a, y0, 0]), toB([b, y1, 0]))
      B.rod(name + '_yoke_3', toB([-b, y1, 0]), toB([b, y1, 0])); B.rod(name + '_yoke_4', toB([-a, y0, 0]), toB([a, y0, 0]))
    } else {
      truss(ym, [[0, y0, 0], [0.42 * W0, y1, 0]], r, 10); truss(ym, [[0, y0, 0], [-0.42 * W0, y1, 0]], r, 10)
      truss(ym, [[-0.42 * W0, y1, 0], [0.42 * W0, y1, 0]], r, 10)
      // 轭根部的 U 形接头
      cyl(ym, [-0.06, y0, 0], [0.06, y0, 0], r * 1.8, 12, true, true)
      B.rod(`${name}_yoke_1`, toB([0, y0, 0]), toB([0.42 * W0, y1, 0])); B.rod(`${name}_yoke_2`, toB([0, y0, 0]), toB([-0.42 * W0, y1, 0]))
      B.rod(`${name}_yoke_3`, toB([-0.42 * W0, y1, 0]), toB([0.42 * W0, y1, 0]))
    }
    B.item(`${name}_yoke`, { part: { id: `${name}_yoke`, name: `${o.title || name}轭`, role: 'boom' }, role: 'boom', mat: o.yokeMat || 'carbon', mb: ym, F })
    artNodes.push(`${name}_yoke`)
  }
  const sub_ = new MB(), cells = new MB(), frm = new MB(), hin = new MB()
  let cellArea = 0, panelArea = 0
  for (const p of panels) {
    const cx = p.x, cy = p.y + p.h / 2
    obox(sub_, BODY, [cx, cy, 0], [p.w / 2, p.h / 2, t / 2], o.bothFaces ? ['+x', '-x', '+y', '-y'] : ['+x', '-x', '+y', '-y', '-z'])
    const cw = Math.max(0.001, p.w / 2 - m), ch = Math.max(0.001, p.h / 2 - m)
    // 电池面：正面（+z）一张；bothFaces 时背面也一张
    quadPts(cells, [cx - cw, cy - ch, t / 2 + 0.0005], [cx + cw, cy - ch, t / 2 + 0.0005], [cx + cw, cy + ch, t / 2 + 0.0005], [cx - cw, cy + ch, t / 2 + 0.0005], [0, 0, 1])
    if (o.bothFaces) quadPts(cells, [cx - cw, cy - ch, -t / 2 - 0.0005], [cx + cw, cy - ch, -t / 2 - 0.0005], [cx + cw, cy + ch, -t / 2 - 0.0005], [cx - cw, cy + ch, -t / 2 - 0.0005], [0, 0, -1])
    // 板正面的留边（基板本色；电池片离板边 m）
    const e = t / 2
    quadPts(sub_, [cx - p.w / 2, cy - p.h / 2, e], [cx + p.w / 2, cy - p.h / 2, e], [cx + p.w / 2, cy - ch, e], [cx - p.w / 2, cy - ch, e], [0, 0, 1])
    quadPts(sub_, [cx - p.w / 2, cy + ch, e], [cx + p.w / 2, cy + ch, e], [cx + p.w / 2, cy + p.h / 2, e], [cx - p.w / 2, cy + p.h / 2, e], [0, 0, 1])
    quadPts(sub_, [cx - p.w / 2, cy - ch, e], [cx - cw, cy - ch, e], [cx - cw, cy + ch, e], [cx - p.w / 2, cy + ch, e], [0, 0, 1])
    quadPts(sub_, [cx + cw, cy - ch, e], [cx + p.w / 2, cy - ch, e], [cx + p.w / 2, cy + ch, e], [cx + cw, cy + ch, e], [0, 0, 1])
    if (o.frameW > 0) {
      const fw = o.frameW, fz = t / 2 + 0.002
      obox(frm, BODY, [cx - p.w / 2 + fw / 2, cy, 0], [fw / 2, p.h / 2, fz], ['+x', '-x', '+z', '-z'])
      obox(frm, BODY, [cx + p.w / 2 - fw / 2, cy, 0], [fw / 2, p.h / 2, fz], ['+x', '-x', '+z', '-z'])
      obox(frm, BODY, [cx, cy - p.h / 2 + fw / 2, 0], [p.w / 2, fw / 2, fz], ['+y', '-y', '+z', '-z'])
      obox(frm, BODY, [cx, cy + p.h / 2 - fw / 2, 0], [p.w / 2, fw / 2, fz], ['+y', '-y', '+z', '-z'])
    }
    cellArea += 4 * cw * ch * (o.bothFaces ? 1 : 1)
    panelArea += p.w * p.h
  }
  // 板间铰链：同一列相邻两板之间，两端各一个
  if (o.hingeR > 0) {
    const sorted = panels.slice().sort((a, b) => a.x - b.x || a.y - b.y)
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i], b = sorted[i + 1]
      if (Math.abs(a.x - b.x) > 1e-6) continue
      const yj = (a.y + a.h + b.y) / 2
      for (const s of [1, -1]) hinge(hin, [a.x + s * (a.w / 2 - 0.12 * a.w), yj, 0], [1, 0, 0], o.hingeR, 0.08 * a.w, 10)
    }
  }
  B.item(`${name}_substrate`, { part, role: 'solarArray', mat: o.backMat || 'solar_substrate', mb: sub_, F })
  B.item(`${name}_cells`, { part, role: 'solarArray', mat: o.cellMat || 'solar_cell', mb: cells, F })
  artNodes.push(`${name}_substrate`, `${name}_cells`)
  // 电池片栅线（无程序纹理的定制电池色——如硅电池亮蓝——用细白线画出电池串的格子；库材质 solar_cell 自带栅格纹理，不用它）
  if (o.cellLines) {
    const cl = new MB(), du = o.cellLines.du, dv = o.cellLines.dv, lw = o.cellLines.w || 0.006, zc = t / 2 + 0.0012
    for (const p of panels) {
      const cw = Math.max(0.001, p.w / 2 - m), ch = Math.max(0.001, p.h / 2 - m), cx = p.x, cy = p.y + p.h / 2
      for (let u = -cw + du; u < cw - 1e-6; u += du) quadPts(cl, [cx + u - lw / 2, cy - ch, zc], [cx + u + lw / 2, cy - ch, zc], [cx + u + lw / 2, cy + ch, zc], [cx + u - lw / 2, cy + ch, zc], [0, 0, 1])
      for (let v = -ch + dv; v < ch - 1e-6; v += dv) quadPts(cl, [cx - cw, cy + v - lw / 2, zc], [cx + cw, cy + v - lw / 2, zc], [cx + cw, cy + v + lw / 2, zc], [cx - cw, cy + v + lw / 2, zc], [0, 0, 1])
    }
    B.item(`${name}_cell_lines`, { part, role: 'solarArray', mat: o.cellLines.mat || 'white_paint', mb: cl, F })
    artNodes.push(`${name}_cell_lines`)
  }
  if (frm.tcount) { B.item(`${name}_frame`, { part, role: 'solarArray', mat: o.frameMat || 'carbon', mb: frm, F }); artNodes.push(`${name}_frame`) }
  if (hin.tcount) { B.item(`${name}_hinges`, { part, role: 'solarArray', mat: 'titanium', mb: hin, F }); artNodes.push(`${name}_hinges`) }
  // 质量：给了整翼质量就按面积摊；否则按面密度
  const areal = (dens.panelAreal + dens.cellAreal)
  const kM = isNum(o.massKg) && o.massKg > 0 ? o.massKg / panelArea : areal
  const R = RofF(F)
  panels.forEach((p, i) => B.plate(`${name}_panel_${i + 1}`, kM * p.w * p.h, toB([p.x, p.y + p.h / 2, 0]), R, p.w, p.h))
  const pp = B.ctx.parts.get(name)
  if (pp) { pp.areaM2 = cellArea; pp.normalBody = z.slice() }
  if (o.articulate !== false) {
    const lim = o.limits || [-180, 180]
    B.art(name, artNodes, [{ name: 'rotate', type: 'yRotate', minimumValue: lim[0], maximumValue: lim[1], initialValue: 0 }])
  }
  B.spg(name, [`${name}_cells`], isNum(o.efficiency) ? o.efficiency : 28)
  B.ap(`${name}_axis`, o.root, y)
  const yMax = Math.max(...panels.map((p) => p.y + p.h))
  return { F, tip: toB([0, yMax, 0]), cellArea, nodes: artNodes }
}

/**
 * 铰链式太阳翼（转轴 = 翼根铰链线，不是翼展方向）：星链 v1.x 的单翼沿本体长边铰接，在「展书」（与本体共面铺在前方）与
 * 「鲨鱼鳍」（竖立在本体上方）之间绕铰链转。关节 yRotate 的局部 y = 铰链轴，所以翼局部系：原点 = 铰链线中点、y = axis、
 * x = span（静止位姿下翼从铰链伸出的方向）、z = x × y（电池面法向；cellsOn:-1 时电池贴在 −z 面）。
 * o = { name, title, hinge, axis, span, L（沿 span 长）, W（沿铰链宽）, rows（沿长度折叠段数）, cols（沿宽度列数）, t, cellsOn,
 *       gap（折叠段缝）, massKg, efficiency, limits:[min,max]（相对静止位姿，度）, backMat, hingeMat }
 */
export function hingedArray(B, o) {
  const y = nrm(o.axis), x = nrm(sub(o.span, scl(y, dot(o.span, y)))), z = cross(x, y)
  const F = frame(o.hinge, x, y, z)
  const name = o.name, t = isNum(o.t) ? o.t : 0.02, gap = isNum(o.gap) ? o.gap : 0.012
  const rows = o.rows || 1, cols = o.cols || 1, L = o.L, W = o.W
  const side = o.cellsOn === -1 ? -1 : 1
  const part = { id: name, name: o.title || name, role: 'solarArray' }
  const sub_ = new MB(), cells = new MB(), hin = new MB()
  const x0 = isNum(o.offset) ? o.offset : 0.04
  const segL = (L - (rows - 1) * gap) / rows, segW = (W - (cols - 1) * gap) / cols
  let cellArea = 0
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const cx = x0 + i * (segL + gap) + segL / 2, cy = -W / 2 + j * (segW + gap) + segW / 2
    obox(sub_, BODY, [cx, cy, 0], [segL / 2, segW / 2, t / 2], side > 0 ? ['+x', '-x', '+y', '-y', '-z'] : ['+x', '-x', '+y', '-y', '+z'])
    const m = Math.min(0.012, segL * 0.04), zc = side * (t / 2 + 0.0005)
    const hx = segL / 2 - m, hy = segW / 2 - m
    quadPts(cells, [cx - hx, cy - hy, zc], [cx + hx, cy - hy, zc], [cx + hx, cy + hy, zc], [cx - hx, cy + hy, zc], [0, 0, side])
    // 电池区外的留边（基板本色）
    const zs = side * t / 2
    quadPts(sub_, [cx - segL / 2, cy - segW / 2, zs], [cx + segL / 2, cy - segW / 2, zs], [cx + segL / 2, cy - hy, zs], [cx - segL / 2, cy - hy, zs], [0, 0, side])
    quadPts(sub_, [cx - segL / 2, cy + hy, zs], [cx + segL / 2, cy + hy, zs], [cx + segL / 2, cy + segW / 2, zs], [cx - segL / 2, cy + segW / 2, zs], [0, 0, side])
    quadPts(sub_, [cx - segL / 2, cy - hy, zs], [cx - hx, cy - hy, zs], [cx - hx, cy + hy, zs], [cx - segL / 2, cy + hy, zs], [0, 0, side])
    quadPts(sub_, [cx + hx, cy - hy, zs], [cx + segL / 2, cy - hy, zs], [cx + segL / 2, cy + hy, zs], [cx + hx, cy + hy, zs], [0, 0, side])
    cellArea += 4 * hx * hy
  }
  // 铰链：沿铰链线一根转轴 + 两端铰座
  cyl(hin, [0, -W / 2, 0], [0, W / 2, 0], Math.max(0.012, t * 0.9), 12, true, true)
  for (const s of [-1, 1]) obox(hin, BODY, [0.015, s * (W / 2 - 0.05), 0], [0.03, 0.04, t])
  B.item(`${name}_substrate`, { part, role: 'solarArray', mat: o.backMat || 'solar_substrate', mb: sub_, F })
  B.item(`${name}_cells`, { part, role: 'solarArray', mat: o.cellMat || 'solar_cell', mb: cells, F })
  B.item(`${name}_hinge`, { part, role: 'solarArray', mat: o.hingeMat || 'dark_metal', mb: hin, F })
  const R = RofF(F)
  B.plate(`${name}_panel`, isNum(o.massKg) ? o.massKg : (B.ctx.dens.panelAreal + B.ctx.dens.cellAreal) * L * W, toW(F, [x0 + L / 2, 0, 0]), R, L, W)
  const pp = B.ctx.parts.get(name)
  if (pp) { pp.areaM2 = cellArea; pp.normalBody = scl(z, side) }
  const lim = o.limits || [-180, 180]
  B.art(name, [`${name}_substrate`, `${name}_cells`, `${name}_hinge`], [{ name: 'rotate', type: 'yRotate', minimumValue: lim[0], maximumValue: lim[1], initialValue: 0 }])
  B.spg(name, [`${name}_cells`], isNum(o.efficiency) ? o.efficiency : 28)
  B.ap(`${name}_axis`, o.hinge, y)
  return { F, cellArea }
}

/**
 * 剪式展开架（pantograph，星链 V2 Mini 的翼根桁架）：从 root 沿 dir 伸出长 L，宽 w（剪叉平面 = dir 与 up 张成），n 节。
 * 画进 mb（本体系）。
 */
export function pantograph(mb, root, dir, up, L, w, n = 4, r = 0.018) {
  const d = nrm(dir), u = nrm(sub(up, scl(d, dot(up, d))))
  const pts = (k, s) => madd(madd(root, d, (L * k) / n), u, (s * w) / 2)
  for (let k = 0; k < n; k++) {
    truss(mb, [pts(k, -1), pts(k + 1, 1)], r, 8)
    truss(mb, [pts(k, 1), pts(k + 1, -1)], r, 8)
  }
  truss(mb, [pts(0, -1), pts(0, 1)], r * 1.3, 8)
  truss(mb, [pts(n, -1), pts(n, 1)], r * 1.3, 8)
  for (let k = 1; k < n; k++) cyl(mb, madd(pts(k, 0), cross(d, u), -r * 1.5), madd(pts(k, 0), cross(d, u), r * 1.5), r * 1.6, 8, true, true)
}

/**
 * 双轴万向节抛物面天线（方位 → 俯仰两级，嵌套节点）。
 * o = { name, title, base（安装面上的点）, n（安装面外法向）, look（静止视轴，缺省 n）, D, fd（焦径比）, postH（立柱高）,
 *       mat（反射面，缺省 reflector）, feed:'horn'|'none', articulate }
 * 节点：`${name}_az`（立柱 + 方位转台 + 叉架，方位关节 zRotate）→ 子节点 `${name}_el`（反射面 + 背筋 + 馈源 + 支杆，俯仰关节 xRotate）。
 * 挂点 `${name}`：馈源相位中心，视轴 = look。
 */
export function gimbalDish(B, o) {
  const n = nrm(o.n), look = nrm(o.look || o.n)
  const D = o.D, fd = isNum(o.fd) ? o.fd : 0.35, f = fd * D, postH = isNum(o.postH) ? o.postH : 0.3 * D
  const part = { id: o.name, name: o.title || o.name, role: 'reflector' }
  // 方位系：原点在安装点，z = n
  const Faz = frameZX(o.base, n, look)
  const azMb = new MB(), azMetal = new MB()
  cyl(azMetal, [0, 0, 0], [0, 0, postH * 0.55], D * 0.06, 16, false, true)
  cyl(azMb, [0, 0, 0], [0, 0, 0.012], D * 0.1, 20, false, true)
  // 叉架：两根立臂到俯仰轴
  const elH = postH
  for (const s of [1, -1]) truss(azMetal, [[0, 0, postH * 0.5], [s * D * 0.16, 0, postH * 0.62], [s * D * 0.16, 0, elH]], D * 0.018, 8)
  B.item(`${o.name}_az`, { part, role: 'reflector', mat: 'aluminum', mb: azMetal, F: Faz })
  B.item(`${o.name}_azbase`, { part, role: 'reflector', mat: 'titanium', mb: azMb, F: Faz })
  // 俯仰系（相对方位系）：原点在俯仰轴心 (0,0,elH)，x = 俯仰轴，z = 视轴（静止时 = look 在方位系里的表示）
  const lookL = [dot(look, Faz.x), dot(look, Faz.y), dot(look, Faz.z)]
  const Fel = frameZX([0, 0, elH], lookL, [1, 0, 0])
  const el = new MB(), back = new MB(), feed = new MB()
  // 反射面：顶点在俯仰轴心前 0.05 D，轴 = +z（局部）
  const V = [0, 0, D * 0.05]
  dishShell(el, V, [0, 0, 1], { D, f, t: Math.max(0.004, D * 0.012), na: 40, nr: 8 })
  dishRim(el, V, [0, 0, 1], { D, f, t: Math.max(0.004, D * 0.012), w: D * 0.012, na: 40 })
  // 背筋：十字梁 + 俯仰轴承座
  for (const [ax, ay] of [[1, 0], [0, 1]]) truss(back, [[-ax * D * 0.36, -ay * D * 0.36, V[2] - 0.004 + (D * 0.36) ** 2 / (4 * f)], [0, 0, V[2] - D * 0.02], [ax * D * 0.36, ay * D * 0.36, V[2] - 0.004 + (D * 0.36) ** 2 / (4 * f)]], D * 0.012, 6)
  cyl(back, [-D * 0.17, 0, 0], [D * 0.17, 0, 0], D * 0.03, 12, true, true)
  // 馈源：焦点处小锥形喇叭（口朝反射面）+ 三根支杆
  const Fp = [0, 0, V[2] + f]
  if (o.feed !== 'none') {
    const hr = D * 0.07
    frustum(feed, madd(Fp, [0, 0, 1], D * 0.12), hr * 0.35, Fp, hr, 16, true, false, false)
    disc(feed, Fp, [0, 0, -1], hr, 16)
    const zr = V[2] + (D * 0.46) ** 2 / (4 * f)
    for (let k = 0; k < 3; k++) {
      const th = (90 + 120 * k) * Math.PI / 180
      truss(back, [[D * 0.46 * Math.cos(th), D * 0.46 * Math.sin(th), zr], madd(Fp, [Math.cos(th), Math.sin(th), 0], hr * 0.4)], D * 0.006, 6)
    }
  }
  const elName = `${o.name}_el`
  B.item(elName, { part, role: 'reflector', mat: o.mat || 'reflector', mb: el, F: Fel, parent: `${o.name}_az` })
  B.item(`${o.name}_struts`, { part, role: 'reflector', mat: 'carbon', mb: back, F: Fel, parent: `${o.name}_az` })
  if (feed.tcount) B.item(`${o.name}_feed`, { part: { id: `${o.name}_feed`, name: `${o.title || o.name}馈源`, role: 'feed' }, role: 'feed', mat: 'aluminum', mb: feed, F: Fel, parent: `${o.name}_az` })
  if (o.articulate !== false) {
    B.art(`${o.name}_az`, [`${o.name}_az`, `${o.name}_azbase`], [{ name: 'azimuth', type: 'zRotate', minimumValue: -180, maximumValue: 180, initialValue: 0 }])
    B.art(`${o.name}_el`, [elName, `${o.name}_struts`, ...(feed.tcount ? [`${o.name}_feed`] : [])], [{ name: 'elevation', type: 'xRotate', minimumValue: -90, maximumValue: 90, initialValue: 0 }])
  }
  // 质量：反射面按面密度、立柱 / 叉架按点质量
  const areal = B.ctx.dens.reflectorAreal
  const cW = toW(Faz, [0, 0, elH])
  B.point(`${o.name}_dish`, areal * Math.PI * D * D / 4, madd(cW, look, D * 0.1))
  B.point(`${o.name}_gimbal`, 0.25 * areal * Math.PI * D * D / 4 + 0.5, toW(Faz, [0, 0, postH * 0.4]))
  const pp = B.ctx.parts.get(o.name)
  if (pp) { pp.areaM2 = Math.PI * D * D / 4; pp.normalBody = look.slice() }
  B.ap(o.name, madd(cW, look, D * 0.05 + f), look, o.up)
  return { az: `${o.name}_az`, el: elName }
}

/** 霍尔推力器落到部件组上（body 金属 / channel 陶瓷 / pole 钛）。 */
export function addHall(g, o) {
  const h = hallThruster(o)
  mergeInto(g.mb(o.bodyMat || 'aluminum'), h.body)
  mergeInto(g.mb('ceramic'), h.channel)
  mergeInto(g.mb('titanium'), h.pole)
}
/** 星敏落到部件组上。 */
export function addStarTracker(g, o) {
  const s = starTracker(o)
  mergeInto(g.mb(o.bodyMat || 'aluminum'), s.body)
  mergeInto(g.mb('black_paint'), s.baffle)
  mergeInto(g.mb('dark_glass'), s.lens)
}
/** 激光终端落到部件组上。 */
export function addLaser(g, o) {
  const s = laserTerminal(o)
  mergeInto(g.mb(o.baseMat || 'aluminum'), s.base)
  mergeInto(g.mb(o.bodyMat || 'white_paint'), s.fork)
  mergeInto(g.mb(o.bodyMat || 'white_paint'), s.tube)
  mergeInto(g.mb('dark_glass'), s.glass)
}
/** 角反射器阵落到部件组上。 */
export function addLRA(g, o) {
  const s = reflectorCorners(o)
  mergeInto(g.mb(o.plateMat || 'aluminum'), s.plate)
  mergeInto(g.mb('dark_glass'), s.cubes)
}

/**
 * 盒体热控蒙皮：结构盒（中心 c、半边长 h，局部系 F）六个面各贴一层蒙皮（离结构面 off、四边内缩 inset），每面各自的材质。
 * faces = {'+x': 'mli_gold', '-z': 'radiator', …}（没列的面不贴）；材质为 null 的面跳过。
 * 蒙皮画成离面的薄片（不是结构盒本身的面色）：MLI 包覆在真星上就是一层离结构板几厘米的毯子，边缘能看出厚度。
 */
export function skinBox(g, F, c, h, faces, o = {}) {
  const off = isNum(o.off) ? o.off : 0.012, inset = isNum(o.inset) ? o.inset : 0.01
  const C = toW(F, c)
  const ax = [F.x, F.y, F.z]
  const spec = { '+x': [0, 1], '-x': [0, -1], '+y': [1, 1], '-y': [1, -1], '+z': [2, 1], '-z': [2, -1] }
  for (const [f, mat] of Object.entries(faces)) {
    if (!mat || !spec[f]) continue
    const [k, s] = spec[f]
    const n = scl(ax[k], s)
    const i = (k + 1) % 3, j = (k + 2) % 3
    const ctr = madd(C, n, h[k] + off)
    const u = scl(ax[i], Math.max(0.001, h[i] - inset)), v = scl(ax[j], Math.max(0.001, h[j] - inset))
    const mb = g.mb(mat)
    quadPts(mb, sub(sub(ctr, u), v), sub(add(ctr, u), v), add(add(ctr, u), v), add(sub(ctr, u), v), n)
    // 蒙皮边缘的厚度带（毯子边折回结构面）
    if (off > 0.002) {
      for (const [e, w] of [[u, v], [scl(u, -1), v], [v, u], [scl(v, -1), u]]) {
        const en = nrm(e)
        const a = add(ctr, e), b0 = sub(a, w), b1 = add(a, w)
        quadPts(mb, b0, b1, madd(b1, n, -off), madd(b0, n, -off), en)
      }
    }
  }
}

/**
 * 轴向模螺旋单元（导航星的 L 波段阵元）：底座 base、指向 axis、螺旋半径 R、螺距 pitch、圈数 turns、线径 wire；
 * cupR > 0 时画一个接地杯（浅圆筒），support 为真时画中心介质支撑杆，capR > 0 时顶端加圆锥天线罩帽。
 * 线圈进 coilMb，杯 / 支撑 / 帽进 baseMb。
 */
export function helixElement(coilMb, baseMb, base, axis, o) {
  const a = nrm(axis)
  const turns = o.turns, H = o.pitch * turns
  const cupH = isNum(o.cupH) ? o.cupH : 0.02
  if (o.cupR > 0) {
    cyl(baseMb, base, madd(base, a, 0.004), o.cupR, 20, true, true)
    frustum(baseMb, base, o.cupR, madd(base, a, cupH), o.cupR, 20, false, false, false)
    frustum(baseMb, base, o.cupR - 0.002, madd(base, a, cupH), o.cupR - 0.002, 20, false, false, true)
  }
  if (o.support !== false) cyl(baseMb, base, madd(base, a, H + 0.01), Math.max(0.004, o.R * 0.18), 10, false, true)
  const ref = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  helix(coilMb, madd(base, a, 0.006), a, ref, { R: o.R, pitch: o.pitch, turns, wire: o.wire, seg: o.seg || 12, tubeSeg: 4 })
  if (o.capR > 0) cone(baseMb, madd(base, a, H + 0.01), o.capR, madd(base, a, H + 0.01 + o.capR * 1.6), 0.002, 14, true, false)
}

/**
 * 六边形构架式可展开网状反射面（北斗三号 GEO / IGSO 的 RDSS 天线那种：外圈六边形桁架 + 内部三角网格肋 + 金色网面）。
 * o = { name, title, hub（桁架中心，本体系）, n（口面法向 = 反射方向）, up（六边形一个顶点所在方向）, R（外接圆半径）,
 *       depth（桁架厚）, rings（内部分层数）, curvature（网面中心下凹深度 / R）, armFrom?（连接臂根部，本体系）, mat? }
 * 节点：`${name}_truss`（碳纤维桁架 + 连接臂）与 `${name}_mesh`（半透明金网，双面）。挂点 `${name}`：网面中心、视轴 n。
 */
export function hexMeshReflector(B, o) {
  const n = nrm(o.n)
  const F = frameZX(o.hub, n, o.up || [1, 0, 0])
  const R = o.R, dp = isNum(o.depth) ? o.depth : 0.06 * R, rings = o.rings || 4
  const sag = (isNum(o.curvature) ? o.curvature : 0.12) * R
  const part = { id: o.name, name: o.title || o.name, role: 'reflector' }
  const tr = new MB(), mesh = new MB()
  // 网面：六边形按三角格细分，抛物下凹（中心最深），法向朝 +z（反射方向）
  const hexP = (k) => { const t = (Math.PI / 3) * k; return [R * Math.cos(t), R * Math.sin(t)] }
  const zOf = (x, y) => -sag * (1 - (x * x + y * y) / (R * R))
  const tri2 = []
  for (let k = 0; k < 6; k++) {
    const A = hexP(k), Bq = hexP(k + 1)
    // 扇区（中心 O、A、B）按 rings 细分成三角网
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j <= i; j++) {
        const P = (ii, jj) => { const s = ii / rings, t = ii ? jj / ii : 0; return [s * (A[0] + (Bq[0] - A[0]) * t), s * (A[1] + (Bq[1] - A[1]) * t)] }
        tri2.push([P(i, j), P(i + 1, j), P(i + 1, j + 1)])
        if (j < i) tri2.push([P(i, j), P(i + 1, j + 1), P(i, j + 1)])
      }
    }
  }
  const W = (x, y, dz = 0) => toW(F, [x, y, zOf(x, y) + dz])
  for (const t of tri2) {
    const [a, b, c] = t.map(([x, y]) => W(x, y))
    const nn = nrm(cross(sub(b, a), sub(c, a)))
    const up = dot(nn, n) >= 0 ? nn : scl(nn, -1)
    tri(mesh, a, b, c, up)
  }
  // 桁架（构架式可展开天线的外观就是它）：前层 = 网面三角剖分的全部棱（与网面同一套三角格，六向三角网，不是同心环 + 辐条的蛛网）；
  // 后层 = 隔一格取一个节点的粗三角网；前后层之间在粗网节点上立竖杆、外圈加斜撑——两层三角网 + 腹杆的空间桁架
  const r0 = Math.max(0.008, R * 0.006)
  const seen = new Set()
  const key2 = (x, y) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`
  const edge = (a, b, dz, rr) => {
    const k = [key2(a[0], a[1]), key2(b[0], b[1])].sort().join('|') + `@${dz}`
    if (seen.has(k)) return
    seen.add(k)
    cyl(tr, W(a[0], a[1], dz), W(b[0], b[1], dz), rr, 4, false, false)   // 细杆：4 棱、不封口（这么细看不出封口，省三角形）
  }
  for (const t of tri2) { edge(t[0], t[1], 0, r0); edge(t[1], t[2], 0, r0); edge(t[2], t[0], 0, r0) }
  // 后层粗网：扇区按 rings/2 细分（至少 1）
  const rb = Math.max(1, Math.floor(rings / 2))
  const nodes = new Map()
  for (let k = 0; k < 6; k++) {
    const A = hexP(k), Bq = hexP(k + 1)
    const Pq = (ii, jj) => { const s = ii / rb, t = ii ? jj / ii : 0; return [s * (A[0] + (Bq[0] - A[0]) * t), s * (A[1] + (Bq[1] - A[1]) * t)] }
    for (let i = 0; i < rb; i++) for (let j = 0; j <= i; j++) {
      const a = Pq(i, j), b = Pq(i + 1, j), c = Pq(i + 1, j + 1)
      edge(a, b, -dp, r0 * 0.8); edge(b, c, -dp, r0 * 0.8); edge(c, a, -dp, r0 * 0.8)
      for (const p of [a, b, c]) nodes.set(key2(p[0], p[1]), p)
      if (j < i) { const d = Pq(i, j + 1); edge(a, c, -dp, r0 * 0.8); edge(c, d, -dp, r0 * 0.8) }
    }
  }
  // 腹杆：粗网节点上的竖杆（网面在该点的下凹量处起）；外圈每边一道斜撑
  for (const p of nodes.values()) cyl(tr, W(p[0], p[1], 0), W(p[0], p[1], -dp), r0 * 0.8, 4, false, false)
  for (let k = 0; k < 6; k++) { const p = hexP(k), q = hexP(k + 1); truss(tr, [W(p[0], p[1], 0), W(q[0], q[1], -dp)], r0 * 0.8, 6) }
  // 外圈加粗（展开桁架的主框）
  for (let k = 0; k < 6; k++) { const p = hexP(k), q = hexP(k + 1); truss(tr, [W(p[0], p[1], 0), W(q[0], q[1], 0)], r0 * 1.5, 8); truss(tr, [W(p[0], p[1], -dp), W(q[0], q[1], -dp)], r0 * 1.5, 8) }
  // 连接臂：根部 → 背层最近的两个顶点
  if (o.armFrom) {
    let best = 0, bd = Infinity
    for (let k = 0; k < 6; k++) { const p = hexP(k), d = len(sub(W(p[0], p[1], -dp), o.armFrom)); if (d < bd) { bd = d; best = k } }
    const p0 = hexP(best), p1 = hexP(best + 1), pm = hexP(best + 5)
    truss(tr, [o.armFrom, W(p0[0], p0[1], -dp)], r0 * 2.2, 8)
    truss(tr, [o.armFrom, W(p1[0], p1[1], -dp)], r0 * 1.6, 8)
    truss(tr, [o.armFrom, W(pm[0], pm[1], -dp)], r0 * 1.6, 8)
    cyl(tr, o.armFrom, madd(o.armFrom, nrm(sub(W(0, 0, -dp), o.armFrom)), 0.05), r0 * 4, 12, true, true)
  }
  B.item(`${o.name}_truss`, { part, role: 'reflector', mat: o.trussMat || 'carbon', mb: tr })
  B.item(`${o.name}_mesh`, { part, role: 'reflector', mat: o.mat || 'reflector_mesh', mb: mesh })
  const area = 1.5 * Math.sqrt(3) * R * R
  B.point(`${o.name}`, B.ctx.dens.meshReflectorAreal * area * 1.6, toW(F, [0, 0, -dp / 2]))
  const pp = B.ctx.parts.get(o.name)
  if (pp) { pp.areaM2 = area; pp.normalBody = n.slice() }
  B.ap(o.name, toW(F, [0, 0, -sag]), n, o.apUp)
  return F
}

/**
 * 固定式正馈抛物面（带支杆馈源）：顶点 V、视轴 a、口径 D、焦径比 fd；mat 反射面材质（缺省 reflector 白漆）。
 * 进部件组 g（反射面 / 背筋 / 馈源三种材质）。返回焦点。
 */
export function fixedDish(g, V, a, { D, fd = 0.4, t, feed = true, reflMat = 'reflector', strutMat = 'carbon', feedMat = 'aluminum', legs = 3, na = 40, nr = 8 }) {
  const aa = nrm(a), f = fd * D, th = isNum(t) ? t : Math.max(0.004, D * 0.01)
  dishShell(g.mb(reflMat), V, aa, { D, f, t: th, na, nr })
  dishRim(g.mb(reflMat), V, aa, { D, f, t: th, w: D * 0.012, na })
  const Fp = madd(V, aa, f)
  if (feed) {
    const hr = D * 0.06
    frustum(g.mb(feedMat), madd(Fp, aa, D * 0.1), hr * 0.35, Fp, hr, 16, true, false, false)
    disc(g.mb(feedMat), Fp, scl(aa, -1), hr, 16)
    const [e1, e2] = perpPairOf(aa)
    const rr = D * 0.47, zr = rr * rr / (4 * f)
    for (let k = 0; k < legs; k++) {
      const t0 = (2 * Math.PI * k) / legs + Math.PI / 2
      const q = add(scl(e1, Math.cos(t0)), scl(e2, Math.sin(t0)))
      truss(g.mb(strutMat), [madd(madd(V, aa, zr), q, rr), madd(Fp, q, hr * 0.5)], D * 0.006, 6)
    }
  }
  return Fp
}
const perpPairOf = (d) => { const a = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; const e1 = nrm(sub(a, scl(d, dot(a, d)))); return [e1, cross(d, e1)] }

/** 锥形喷管（姿轨控推力器 / 远地点发动机）：喉部在 p、喷流方向 dir、出口半径 re、长 L；外壁 + 内壁 + 喉部小圆柱。 */
export function nozzle(mb, p, dir, re, L, seg = 20) {
  const d = nrm(dir)
  cyl(mb, madd(p, d, -0.35 * L), p, re * 0.42, seg, true, false)
  frustum(mb, p, re * 0.32, madd(p, d, L), re, seg, false, false, false)
  frustum(mb, p, re * 0.28, madd(p, d, L), re * 0.94, seg, false, false, true)
  ring(mb, madd(p, d, L), d, re * 0.94, re, seg)
}

/** 把 src 的顶点 / 三角形并进 dst（坐标原样）。 */
export function mergeInto(dst, src) {
  const base = dst.vcount
  for (let i = 0; i < src.p.length; i++) dst.p.push(src.p[i])
  for (let i = 0; i < src.n.length; i++) dst.n.push(src.n[i])
  for (let i = 0; i < src.uv.length; i++) dst.uv.push(src.uv[i])
  for (let i = 0; i < src.idx.length; i++) dst.idx.push(src.idx[i] + base)
  return dst
}

export { bevelBox, obox, cyl, cone, ring, disc, sweep, truss, frame, toW, dirW }
