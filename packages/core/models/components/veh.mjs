// 车辆领域装配组件（三期契约 DESIGN3 §1 P1b、E5、E13；A3 SPEC §6）。
//
// 纯 ESM、零 three 依赖、node 可测、确定性（无随机数 / 时钟）。三件：
//   veh.body       车体（suv / pickup / van 三种车型）：侧视轮廓逐站放样的真实车身——发动机盖、风挡倾角、A/B/C/D 柱、
//                  侧倾（玻璃带向内收）、轮拱开口、门缝、门把手、前脸格栅 / 大灯、尾灯、保险杠、后视镜、底盘、轮罩内衬、
//                  五辐轮毂 + 鼓出胎侧的轮胎、车顶行李架；皮卡另有敞口货箱（内衬 + 尾门）。包围盒（不含后视镜）恰为
//                  车长 × 车宽 × 车高，轮胎着地点 z = 0。
//   veh.cotm.flat  平板动中通终端（缺省 Kymeta Hawk u8 外形 89.5 × 89.5 × 14 cm）：超椭圆底盒 + 圆角低拱罩 + 四只安装脚。
//   veh.driveaway  车顶自动展开天线底座（缺省 C-COM iNetVu 1202 收拢外形 203 × 124 × 35 cm）：底架、方位转台、俯仰铰座、
//                  收拢托架；俯仰铰点落在方位轴上（跨组件关节只能共轴），偏馈反射面装 el 插座即随同名 stage 联动。
//
// ★ 局部坐标（A3 SPEC §1.1，与 ground.mjs 同一口径）：本体 FRD——+X 车头、+Y 右、+Z 向下；立件 mount 插座 n = +Z。
//   veh.body 原点 = 地面 ∩ 前后轴中点 ∩ 中线（挂点 datum 就在这里，P4 实体图层按它贴地）；车身向 −Z 长高。
//
// ★ 缺省尺寸一律示意（source:'illustrative'，悬停写口径），不取任何具体车型；平板终端 / 展开座的厂商外形是有出处的预设
//   （FLAT_PANELS / DRIVEAWAYS，source = 厂商资料 URL）。车型模板里的有出处车长 / 宽 / 高由模板填（entityTemplates/veh.mjs）。
//   用户 2026-09-24 定：内置目录不带相关型号。
//
// ★ 通用造型工具（superRing / loft / extrude / roundRect / decal / wheel / datumAp / matOr …）一律从 ./shapeKit.mjs 取；
//   关节小工具（STAGE / gimbalFrame / azStage）从 ./ground.mjs 取（与 air / sea 同一口径）。
//
// 导出：
//   VEH_COMPONENTS   车辆组件定义（veh.body / veh.cotm.flat / veh.driveaway）
//   FLAT_PANELS      平板终端外形预设 {型号: {L, W, H, source}}
//   DRIVEAWAYS       展开座收拢外形预设 {型号: {L, W, H, azTravel, source}}
//   VEH_STYLES       车型比例表（示意；模板派生与单测按它重算）
//   vehGeom(p)       veh.body 的尺寸推算（补缺省后的参数 → 关键站位 / 高度函数；sockets / faces / build 同一份）

import { add, sub, scl, len, nrm, clampN, z0, MB, quad, box, frustum, boxComp } from '../meshKit.mjs'
import {
  num, bool, enm, auto, D2R, sock, standSocket, planeFace, grid, cap, prism, tubeAlong, orientTo, solidCompItems, apLocal, put, putFramed,
  stage, matOr, datumAp, superRing, loft, extrude, roundRect, decal, wheel, smooth01, beam, appendMB
} from './shapeKit.mjs'
import { STAGE, gimbalFrame, azStage } from './ground.mjs'

// ───────────────────────────── 小工具 ─────────────────────────────

/** 点阵 G[i][j]（不回绕）+ 预先算好的法向 N[i][j] → 三角网（米制 uv）；out 定绕序。材质分块时用：块与块之间法向连续。 */
function gridN(mb, G, N, out) {
  const t0 = mb.tcount, v0 = mb.vcount, ni = G.length, nj = G[0].length
  const im = Math.floor(ni / 2), jm = Math.floor(nj / 2), U = [0], V = [0]
  for (let j = 1; j < nj; j++) U.push(U[j - 1] + len(sub(G[im][j], G[im][j - 1])))
  for (let i = 1; i < ni; i++) V.push(V[i - 1] + len(sub(G[i][jm], G[i - 1][jm])))
  for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) mb.v(G[i][j], N[i][j], U[j], V[i])
  for (let i = 0; i < ni - 1; i++) for (let j = 0; j < nj - 1; j++) { const a = v0 + i * nj + j, b = a + nj, c = b + 1, e = a + 1; mb.t(a, b, c); mb.t(a, c, e) }
  orientTo(mb, t0, mb.tcount, out)
}
/** 光滑法向表：G 先整块走一遍 grid（面积加权光滑），读回每点法向。 */
function smoothTable(G, out) {
  const t = new MB()
  grid(t, G, { out })
  const nj = G[0].length
  return G.map((row, i) => row.map((_, j) => { const q = 3 * (i * nj + j); return [t.n[q], t.n[q + 1], t.n[q + 2]] }))
}

// ───────────────────────────── veh.body：车体 ─────────────────────────────

/**
 * 车型比例表（全部示意：按常见车型量级取整数比例；模板只给车长 / 宽 / 高等有出处量，其余靠它推算）。
 *   wb 轴距 / 车长；wd 轮径 / 车高；kf 前悬 / 前后悬之和；massKg 整备质量；hood 发动机盖长 / 车长；hoodF / cowl 盖前沿 / 风挡根高 / 车顶高；
 *   beltR 车尾腰线高 / 车顶高；rake 风挡偏离竖直的角度；tumble 玻璃带向内收（车顶处半宽比）；sill 门槛高出离地间隙 / 车顶高；
 *   botF / botR 前 / 后保险杠下沿高出离地间隙 / 车顶高；crown 车顶拱高（m）；win 侧窗上沿占玻璃带比例；rr 车顶边圆角（m）；
 *   doorF / doorR 前 / 后门长 / 车长；dPil D 柱宽 / 车长；roofEnd 车顶后沿离车尾 / 车长；bed 货箱长 / 车长；bedFloor 货箱底板高 / 车顶高；
 *   wsTop 风挡上沿高 / 车顶高（高顶厢式车）；slide 侧滑门长 / 车长。
 */
export const VEH_STYLES = Object.freeze({
  suv: Object.freeze({ wb: 0.575, wd: 0.41, clr: 0.11, kf: 0.45, massKg: 2600, hood: 0.255, hoodF: 0.57, cowl: 0.62, beltR: 0.655, rake: 57, tumble: 0.14, sill: 0.085, botF: 0.14, botR: 0.15, crown: 0.025, win: 0.84, rr: 0.07, doorF: 0.235, doorR: 0.205, dPil: 0.09, roofEnd: 0.028 }),
  pickup: Object.freeze({ wb: 0.58, wd: 0.42, clr: 0.11, kf: 0.42, massKg: 2200, hood: 0.245, hoodF: 0.57, cowl: 0.6, beltR: 0.625, rake: 58, tumble: 0.14, sill: 0.085, botF: 0.14, botR: 0.16, crown: 0.022, win: 0.84, rr: 0.07, doorF: 0.2, doorR: 0.16, bed: 0.285, bedFloor: 0.5 }),
  van: Object.freeze({ wb: 0.6, wd: 0.29, clr: 0.075, kf: 0.38, massKg: 3500, hood: 0.125, hoodF: 0.39, cowl: 0.46, beltR: 0.47, rake: 50, tumble: 0.05, sill: 0.06, botF: 0.06, botR: 0.08, crown: 0.02, win: 0.84, rr: 0.1, doorF: 0.155, wsTop: 0.75, slide: 0.2 })
})
/**
 * 车顶 / 货箱插座推荐的件：只列立在水平面上、滚转 0° 与车体同向的立件（动中通平板、展开座、座架 / 立柱 / 非穿透底座 /
 * 方舱、船载罩）。车体本身、反射面（贴俯仰轴插座）、副面 / 馈源（贴焦点插座）装上来会被转竖或视轴朝天，不列。
 */
const VEH_ACCEPTS = Object.freeze(['veh.cotm', 'veh.driveaway', 'es.pedestal.', 'es.mast', 'es.vsat.mount', 'es.shelter', 'sea.vsat', 'prim.'])
const RACK_RAIL_H = 0.035

/**
 * veh.body 尺寸推算（p 须已补缺省）。高度一律「离地向上为正」（局部 z = −h）。返回关键站位与四条沿车长的函数：
 *   hTop(x) 截面顶（车顶 / 风挡 / 发动机盖中线）、hBelt(x) 腰线（玻璃带下沿）、hBot(x) 车身下沿（门槛 / 轮拱 / 保险杠下沿）、hwx(x) 半宽。
 */
export function vehGeom(p) {
  const S = VEH_STYLES[p.style], style = p.style, L = p.lengthM, W = p.widthM, H = p.heightM
  const rackH = p.roofRack ? p.rackHM : 0, Hr = H - rackH
  const WB = auto(p.wheelbaseM, S.wb * L), T = auto(p.trackM, 0.84 * W)
  const Dw = auto(p.wheelDM, S.wd * H), clr = auto(p.clearanceM, S.clr * H)
  const rw = Dw / 2, tireW = clampN(0.33 * Dw, 0.12, 0.45), rA = rw + 0.035 + 0.05 * Dw
  const fo = S.kf * (L - WB), xF = WB / 2 + fo, xR = xF - L, hw = W / 2
  const eb = Math.min(0.06, 0.012 * L), xb1 = xF - eb, xb0 = xR + eb          // 车身端面（保险杠再伸出 eb）
  const hCowl = S.cowl * Hr, hHoodF = S.hoodF * Hr, hBeltR = S.beltR * Hr
  const xCowl = xF - S.hood * L, wsTopH = style === 'van' ? S.wsTop * Hr : Hr
  const xWsTop = xCowl - (wsTopH - hCowl) * Math.tan(S.rake * D2R)
  const g = { style, S, L, W, H, Hr, rackH, WB, T, Dw, clr, rw, tireW, rA, fo, xF, xR, hw, eb, xb1, xb0, hCowl, hHoodF, hBeltR, xCowl, wsTopH, xWsTop }
  // 车型专有站位
  if (style === 'suv') {
    g.xRoofEnd = xb0 + S.roofEnd * L; g.xB = xCowl - S.doorF * L; g.xC = g.xB - S.doorR * L; g.xD = xb0 + S.dPil * L
    g.gaps = [xCowl - 0.02, g.xB, g.xC]; g.handles = [g.xB + 0.2, g.xC + 0.2]
    g.pillars = [[g.xB - 0.055, g.xB + 0.055], [g.xC - 0.045, g.xC + 0.045]]
    g.sideGlass = [g.xD, xCowl]; g.topGlass = [[xb0, g.xRoofEnd], [g.xWsTop, xCowl]]
    g.rack = [g.xRoofEnd + 0.12, xWsTop - 0.15]
  } else if (style === 'pickup') {
    g.xCab = xb0 + S.bed * L; g.xRoofEnd = g.xCab + 0.1; g.xB = xCowl - S.doorF * L; g.xC = g.xCab + 0.13
    g.gaps = [xCowl - 0.02, g.xB, g.xC]; g.handles = [g.xB + 0.2, g.xC + 0.2]
    g.pillars = [[g.xB - 0.055, g.xB + 0.055]]
    g.sideGlass = [g.xC + 0.04, xCowl]; g.topGlass = [[g.xCab, g.xRoofEnd], [g.xWsTop, xCowl]]
    g.rack = [g.xRoofEnd + 0.08, xWsTop - 0.12]
    g.hFloor = S.bedFloor * Hr
    // 货箱截面：腰线 = 箱顶、顶面再高 0.04（箱沿圆角）、不内收；驾驶室后壁那一站也用它（后壁封口恰好盖住货箱前端）
    g.bedOpt = (x) => ({ hBelt: g.beltLine(x), hTop: g.beltLine(x) + 0.04, hBot: Math.min(g.hBot(x, g.beltLine(x)), g.hFloor - 0.05), tumble: 0, crown: 0, rr: 0.035 })
  } else {
    g.xRamp = xWsTop - 0.55; g.xB = xCowl - S.doorF * L; g.xS0 = g.xB - 0.1; g.xS1 = g.xS0 - S.slide * L
    g.gaps = [xCowl - 0.02, g.xB, g.xS0, g.xS1]; g.handles = [g.xB + 0.2, g.xS1 + 0.2]
    g.pillars = []
    g.sideGlass = [g.xB + 0.06, xCowl]; g.topGlass = [[g.xWsTop, xCowl]]
    g.rack = [xb0 + 0.3, g.xRamp - 0.1]
    g.xRoofEnd = xb0
  }
  g.x0 = style === 'pickup' ? g.xCab : xb0                                   // 主车身放样后端（皮卡 = 驾驶室后壁）
  // —— 高度函数
  g.hTop = (x) => {
    if (x >= xCowl) {
      const t = (x - xCowl) / (xb1 - xCowl), nz = 0.16
      let h = hCowl + (hHoodF - hCowl) * t ** 1.3
      if (x > xb1 - nz) h -= 0.05 * ((x - (xb1 - nz)) / nz) ** 2
      return h
    }
    if (x >= xWsTop) { const t = (xCowl - x) / (xCowl - xWsTop); return hCowl + (wsTopH - hCowl) * (1 - (1 - t) ** 1.25) }
    if (style === 'van') {
      if (x >= g.xRamp) return wsTopH + (Hr - wsTopH) * smooth01((xWsTop - x) / (xWsTop - g.xRamp))
      return x < xb0 + 0.08 ? Hr - 0.03 * ((xb0 + 0.08 - x) / 0.08) ** 2 : Hr
    }
    const bR = style === 'pickup' ? g.beltLine(g.xCab) + 0.04 : hBeltR
    if (x >= g.xRoofEnd) return Hr - 0.02 * ((xWsTop - x) / (xWsTop - g.xRoofEnd)) ** 2
    const t = (g.xRoofEnd - x) / (g.xRoofEnd - g.x0)
    return (Hr - 0.02) - (Hr - 0.02 - bR) * clampN(t, 0, 1) ** 1.15
  }
  g.beltLine = (x) => hCowl + (hBeltR - hCowl) * clampN((xCowl - x) / (xCowl - xb0), 0, 1)
  g.hBelt = (x) => Math.min(g.beltLine(x), g.hTop(x) - 0.05)
  const hSill = clr + S.sill * Hr, hBotF = clr + S.botF * Hr, hBotR = clr + S.botR * Hr, xFA = WB / 2 + rA, xRA = -WB / 2 - rA
  Object.assign(g, { hSill, hBotF, hBotR })
  g.hArch = (x) => { let h = -Infinity; for (const xa of [WB / 2, -WB / 2]) { const dx = x - xa; if (Math.abs(dx) <= rA) h = Math.max(h, rw + Math.sqrt(rA * rA - dx * dx)) } return h }
  g.hBot0 = (x) => (x > xFA ? hSill + (hBotF - hSill) * smooth01((x - xFA) / (xb1 - xFA)) : x < xRA ? hSill + (hBotR - hSill) * smooth01((xRA - x) / (xRA - xb0)) : hSill)
  g.hBot = (x, belt = g.hBelt(x)) => Math.min(Math.max(g.hBot0(x), g.hArch(x)), belt - 0.06)
  const cF = Math.min(0.4, 0.1 * L), cR = Math.min(0.25, 0.06 * L)
  g.hwx = (x) => hw * (x > xb1 - cF ? 1 - 0.09 * ((x - (xb1 - cF)) / cF) ** 2 : x < xb0 + cR ? 1 - 0.05 * ((xb0 + cR - x) / cR) ** 2 : 1)
  // 车顶（行李架 / 插座 / 面）
  const r0 = g.rack[0], r1 = g.rack[1], xrc = (r0 + r1) / 2
  g.roofHalf = sectionRight(g, xrc).roofHalf
  g.rackC = xrc; g.rackL = Math.max(0.2, r1 - r0); g.yRail = Math.max(0.1, g.roofHalf - 0.06)
  return g
}

/** 截面环右半（自底中心 j = 0 到顶中心 j = 25，(y, h)）+ 带界；opt 覆盖 hTop / hBelt / 侧倾 / 拱高 / 圆角（皮卡货箱用）。 */
function sectionRight(g, x, opt = {}) {
  const S = g.S
  const hTop = opt.hTop ?? g.hTop(x), hBelt = opt.hBelt ?? g.hBelt(x), hBot = opt.hBot ?? g.hBot(x, hBelt)
  const hwx = g.hwx(x), tumble = opt.tumble ?? (S.tumble + (0.03 - S.tumble) * smooth01((x - (g.xCowl - 0.1)) / 0.35)), crown = opt.crown ?? S.crown
  const hRE = hTop - crown, rr = Math.min(opt.rr ?? S.rr, 0.45 * Math.max(0, hRE - hBelt))
  const yB = 0.985 * hwx, yST = (1 - tumble) * yB, hST = hRE - rr
  const rb = Math.min(0.06, 0.25 * (hBelt - hBot))
  const span = Math.max(1e-9, hST - hBelt)
  const fWin = g.style === 'van' ? Math.min(S.win, 0.72 / span) : S.win, hWin = hBelt + fWin * (hST - hBelt)
  // 腰线以下侧面：鼓出量按绝对高度（名义门槛 → 腰线）取，轮拱站只把下沿抬高、不改上方截面（侧面是一张完整曲面被轮拱切开）
  const hRef = Math.min(g.hBot0(x), hBelt - 0.06), yLow = (h) => hwx * (0.985 + 0.015 * Math.sin(Math.PI * clampN((hBelt - h) / (hBelt - hRef), 0, 1)))
  const yC = yLow(hBot + rb)
  const P = [[0, hBot], [yC - rb, hBot]]
  for (let k = 1; k <= 4; k++) { const a = (k / 4) * 90 * D2R; P.push([yC - rb + rb * Math.sin(a), hBot + rb - rb * Math.cos(a)]) }
  for (let k = 1; k <= 6; k++) { const h = hBot + rb + (hBelt - hBot - rb) * (k / 6); P.push([yLow(h), h]) }
  const sideY = (h) => yB + (yST - yB) * (h - hBelt) / span
  for (let k = 1; k <= 4; k++) { const h = hBelt + (hWin - hBelt) * (k / 4); P.push([sideY(h), h]) }
  for (let k = 1; k <= 2; k++) { const h = hWin + (hST - hWin) * (k / 2); P.push([sideY(h), h]) }
  for (let k = 1; k <= 4; k++) { const a = (k / 4) * 90 * D2R; P.push([yST - rr + rr * Math.cos(a), hST + rr * Math.sin(a)]) }
  const yr = yST - rr
  for (let k = 1; k <= 4; k++) { const y = yr * (1 - k / 4); P.push([y, hTop - crown * (yr > 0 ? (y / yr) ** 2 : 0)]) }
  return { P, roofHalf: yr, hTop, hBelt, hBot, hwx }
}
/** 全环（50 点，局部 3D）：右半 j = 0…25，左半镜像 j = 26…49（右 j ↔ 左 50 − j）。 */
const RING_N = 50
function ring3(x, P) {
  const R = P.map(([y, h]) => [x, y, -h])
  for (let j = 24; j >= 1; j--) R.push([x, -P[j][0], -P[j][1]])
  return R.map((v) => v.map(z0))
}
/** 带（右半下标区间；左半按 50 − j 镜像）。平滑组：下车身（bottom + sideLow + side）与上车身（glass + upper + rail + roof）。 */
const BANDS = Object.freeze({ bottom: [0, 5], sideLow: [5, 7], side: [7, 11], glass: [11, 15], upper: [15, 17], rail: [17, 21], roof: [21, 25] })
/** 环上两段连续下标（含两端，回绕）。 */
const span = (a, b) => { const o = []; for (let j = a; ; j = (j + 1) % RING_N) { o.push(j); if (j === b % RING_N) break } return o }
const inAny = (x, list) => list.some(([a, b]) => x > a && x < b)

/**
 * 按站位放样一段车身并按「带 × 站区间」分材质出块：mats(band, xMid) → 网格名（缺省 'body'）或 null（不出这块）。
 * 法向按两个平滑组整块算好再分块，块与块之间光顺；腰线处是硬边。返回全部截面（封口用）。
 */
function emitLoft(g, xs, secOpt, mats, sinks, hMid) {
  const rings = xs.map((x) => ring3(x, sectionRight(g, x, secOpt ? secOpt(x) : {}).P))
  const out = (c) => [0, c[1], c[2] + hMid(c[0])]
  const low = span(RING_N - BANDS.side[1], BANDS.side[1]), upp = span(BANDS.glass[0], RING_N - BANDS.glass[0])
  const groups = [low, upp].map((cols) => { const G = rings.map((R) => cols.map((j) => R[j])); return { cols, G, N: smoothTable(G, out) } })
  const colIn = (grp, j) => grp.cols.indexOf(j)
  for (const [band, [a, b]] of Object.entries(BANDS)) {
    const parts = band === 'roof' ? [[a, RING_N - a]] : [[a, b], [RING_N - b, RING_N - a]]
    for (const [ja, jb] of parts) {
      const grp = groups[band === 'bottom' || band === 'sideLow' || band === 'side' ? 0 : 1]
      const ca = colIn(grp, ja % RING_N), cb = colIn(grp, jb % RING_N)
      let i0 = 0
      while (i0 < xs.length - 1) {
        const m = mats(band, (xs[i0] + xs[i0 + 1]) / 2)
        let i1 = i0 + 1
        while (i1 < xs.length - 1 && mats(band, (xs[i1] + xs[i1 + 1]) / 2) === m) i1++
        if (m) {
          const G = grp.G.slice(i0, i1 + 1).map((r) => r.slice(ca, cb + 1)), N = grp.N.slice(i0, i1 + 1).map((r) => r.slice(ca, cb + 1))
          gridN(sinks[m], G, N, out)
        }
        i0 = i1
      }
    }
  }
  return rings
}
/** 站位：关键点 + 轮拱圆弧 + 均匀加密（最大间距 0.25 m），升序去重。 */
function stations(a, b, keys, g) {
  const xs = [a, b, ...keys]
  const n = Math.max(2, Math.ceil((b - a) / 0.25))
  for (let i = 1; i < n; i++) xs.push(a + ((b - a) * i) / n)
  for (const xa of [g.WB / 2, -g.WB / 2]) {
    xs.push(xa + g.rA * 1.002, xa - g.rA * 1.002)
    for (let k = 0; k <= 12; k++) xs.push(xa + g.rA * Math.cos((Math.PI * k) / 12))
  }
  const s = xs.filter((x) => x >= a && x <= b).sort((u, v) => u - v), o = []
  for (const x of s) if (!o.length || x - o[o.length - 1] > 1e-6) o.push(x)
  return o
}
/** 截面右半在高度 h 处（腰线以下侧面）的 y（门把手 / 门缝贴花用）。 */
function sideYAt(g, x, h) {
  const P = sectionRight(g, x).P
  for (let j = 5; j < 11; j++) { const [y0, h0] = P[j], [y1, h1] = P[j + 1]; if (h >= h0 && h <= h1) return y0 + (y1 - y0) * (h - h0) / Math.max(1e-12, h1 - h0) }
  return P[11][0]
}

const vehBody = {
  type: 'veh.body', domain: ['vehicle'], title: 'Vehicle body', titleZh: '车体', role: 'bus',
  params: {
    style: enm('suv', ['suv', 'pickup', 'van'], '车型', { title: 'suv = 越野车；pickup = 双排座皮卡（敞口货箱）；van = 高顶厢式车' }),
    lengthM: num(4.9, 'm', '车长', { gt: 2, max: 14 }),
    widthM: num(1.95, 'm', '车宽', { gt: 1, max: 3, title: '不含后视镜' }),
    heightM: num(1.9, 'm', '车高', { gt: 1, max: 4.5, title: '地面到车顶架顶（无车顶架时到车顶）' }),
    wheelbaseM: num(null, 'm', '轴距', { nullable: true, gt: 0, max: 12, title: '留空 = 车长 × 0.575 / 0.58 / 0.6（suv / pickup / van）' }),
    trackM: num(null, 'm', '轮距', { nullable: true, gt: 0, max: 3, title: '留空 = 0.84 × 车宽' }),
    wheelDM: num(null, 'm', '轮径', { nullable: true, gt: 0.2, max: 2, title: '轮胎外径；留空 = 车高 × 0.41 / 0.42 / 0.29' }),
    clearanceM: num(null, 'm', '离地间隙', { nullable: true, gt: 0, max: 1, title: '留空 = 车高 × 0.11 / 0.11 / 0.075（suv / pickup / van）' }),
    roofRack: bool(true, '车顶架'),
    rackHM: num(0.1, 'm', '车顶架高', { min: 0.02, max: 0.4, title: '车顶到架顶' }),
    mirrors: bool(true, '后视镜'),
    paint: enm('white_paint', ['white_paint', 'titanium', 'dark_metal', 'aluminum'], '车漆', { title: 'white_paint = 白漆；titanium = 灰；dark_metal = 深色金属漆；aluminum = 银色金属漆' }),
    massKg: num(null, 'kg', '整备质量', { nullable: true, gt: 0, title: '留空 = 2600 / 2200 / 3500 kg（示意）；给了装配件目标质量时由它吃余量' })
  },
  validate: (p) => {
    const g = vehGeom(p), e = []
    if (!(g.Hr >= 0.9)) e.push('车高不足')
    if (!(g.WB <= 0.92 * g.L)) e.push('轴距过长')
    if (!(g.WB >= 2 * g.rA + 0.2)) e.push('轴距过短')
    if (!(g.Dw <= 0.6 * g.Hr)) e.push('轮径过大')
    if (!(g.T - g.tireW >= 0.3)) e.push('轮距过小')
    if (!(g.T + g.tireW <= 1.02 * g.W)) e.push('轮距超出车宽')
    if (!(g.clr <= 0.3 * g.Hr && g.hSill + 0.1 < g.hCowl)) e.push('离地间隙过大')
    if (!(g.xCowl - g.xWsTop < 0.7 * g.L && g.xWsTop > g.xRoofEnd + 0.3 && g.rack[1] - g.rack[0] >= 0.3)) e.push('车长不足以放下车顶')
    else if (!(Number.isFinite(g.roofHalf) && g.roofHalf >= 0.25)) e.push('车宽不足')
    return e
  },
  sockets: (p) => {
    const g = vehGeom(p), out = [standSocket(g.W, 90)]
    const zr = p.roofRack ? -g.H : -g.hTop(g.rackC)
    out.push(sock('roof', [g.rackC, 0, zr], [0, 0, -1], [1, 0, 0], Math.max(0.2, Math.min(g.rackL, 2 * g.yRail)), 15, VEH_ACCEPTS))
    if (g.style === 'pickup') out.push(sock('bed', [(g.xb0 + g.xCab) / 2, 0, -g.hFloor], [0, 0, -1], [1, 0, 0], Math.max(0.2, Math.min(g.xCab - g.xb0, g.W) - 0.2), 15, VEH_ACCEPTS))
    // 牵引钩（n = −X 朝后）：本库没有挂车件，只接几何原型（车体 / 平板 / 展开座都是立件，接上会被转竖）
    out.push(sock('hitch', [g.xR, 0, -(g.hBotR + 0.05)], [-1, 0, 0], [0, 0, -1], 0.15, 90, Object.freeze(['prim.'])))
    return out
  },
  faces: (p) => {
    const g = vehGeom(p), zr = p.roofRack ? -g.H : -g.hTop(g.rackC)
    const f = [planeFace('top', [g.rackC, 0, zr], g.rackL / 2, p.roofRack ? g.yRail : 0.8 * g.roofHalf, 'roof')]
    if (g.style === 'pickup') { const xc = (g.xb0 + g.xCab) / 2; f.push(planeFace('top', [xc, 0, -g.hFloor], Math.max(0.05, (g.xCab - g.xb0) / 2 - 0.1), Math.max(0.05, sectionRight(g, xc, g.bedOpt(xc)).roofHalf - 0.05), 'bed')) }
    return f
  },
  symmetricPlanes: ['xz'],
  massSink: 'body',
  build(p, kit) {
    const ctx = kit.createCtx(), g = vehGeom(p), S = g.S
    const part = { id: 'body', name: '车体', role: 'bus' }, whl = { id: 'wheels', name: '车轮', role: 'other' }
    const paint = p.paint, TRIM = 'carbon', GLASS = 'dark_metal', RED = matOr('paint_red', 'dark_metal'), RUBBER = matOr('rubber', 'carbon')
    const body = new MB(), glass = new MB(), clad = new MB(), trim = new MB(), lights = new MB(), tail = new MB(), liners = new MB()
    const hMid = (x) => 0.5 * (g.hBot(x) + g.hTop(x))
    // —— 主车身（皮卡 = 驾驶室段）
    const keys = [g.xCowl, g.xWsTop, g.xRoofEnd, g.xb1 - 0.16, g.xb1 - 0.08, ...g.pillars.flat(), ...g.gaps.flatMap((x) => [x - 0.006, x + 0.006]), g.sideGlass[0], ...g.topGlass.flat()]
    for (let k = 1; k < 6; k++) keys.push(g.xCowl - (g.xCowl - g.xWsTop) * k / 6)
    if (g.style === 'van') { for (let k = 1; k < 5; k++) keys.push(g.xWsTop - (g.xWsTop - g.xRamp) * k / 5); keys.push(g.xb0 + 0.04, g.xb0 + 0.08) }
    else for (let k = 1; k < 5; k++) keys.push(g.xRoofEnd - (g.xRoofEnd - g.x0) * k / 5)
    const xs = stations(g.x0, g.xb1, keys, g)
    const gapIn = (x) => g.gaps.some((xg) => Math.abs(x - xg) < 0.006)
    const mats = (band, x) => {
      if (band === 'side' || band === 'sideLow') return gapIn(x) ? 'glass' : band === 'sideLow' && g.style === 'van' ? 'clad' : 'body'
      if (band === 'glass') return x > g.sideGlass[0] && x < g.sideGlass[1] && !inAny(x, g.pillars) ? 'glass' : 'body'
      if (band === 'roof') return inAny(x, g.topGlass) ? 'glass' : 'body'
      return 'body'
    }
    const rings = emitLoft(g, xs, g.style === 'pickup' ? (x) => (x <= g.xCab + 1e-9 ? g.bedOpt(x) : {}) : null, mats, { body, glass, clad }, hMid)
    cap(body, rings[rings.length - 1], [1, 0, 0])
    cap(body, rings[0], [-1, 0, 0])
    const bodyIt = put(ctx, 'body', 'bus', part, paint, body)
    const glassIt = put(ctx, 'glass', 'other', part, GLASS, glass)
    const cladIt = put(ctx, 'cladding', 'other', part, TRIM, clad)
    solidCompItems(ctx, 'body', [bodyIt, glassIt, cladIt].filter(Boolean), 1, auto(p.massKg, S.massKg))
    // —— 皮卡货箱：外壳放样（与驾驶室下车身同一侧面轮廓，顶面敞口）+ 内衬 + 尾门（外壳后端封口）
    if (g.style === 'pickup') {
      const bed = new MB(), liner = new MB(), bOpt = g.bedOpt
      const bx = stations(g.xb0, g.xCab, [], g)
      const bRings = emitLoft(g, bx, bOpt, (band) => (band === 'roof' ? null : 'body'), { body: bed }, (x) => 0.5 * (g.hBot(x) + g.beltLine(x)))
      cap(bed, bRings[0], [-1, 0, 0])                                  // 尾门外侧；前端由驾驶室后壁封口（同一截面）
      put(ctx, 'bed', 'other', part, paint, bed)
      const wt = 0.05, xa = g.xb0 + wt, xc = g.xCab, zf = -g.hFloor
      const yi = (x) => sectionRight(g, x, bOpt(x)).roofHalf - 0.002, yiM = Math.min(yi(xa), yi(xc)), top = (x) => -(g.beltLine(x) + 0.039)
      quad(liner, [(xa + xc) / 2, 0, zf], [(xc - xa) / 2, 0, 0], [0, -yiM, 0])                 // 底板（法向朝上 −Z）
      for (const sy of [1, -1]) grid(liner, [[[xa, sy * yi(xa), zf], [xa, sy * yi(xa), top(xa)]], [[xc, sy * yi(xc), zf], [xc, sy * yi(xc), top(xc)]]], { out: [0, -sy, 0] })   // 侧内壁（朝内 ∓Y，顶随箱沿）
      grid(liner, [[[xa, -yi(xa), zf], [xa, -yi(xa), top(xa)]], [[xa, yi(xa), zf], [xa, yi(xa), top(xa)]]], { out: [1, 0, 0] })              // 尾门内侧（朝前）
      // 后轮包：货箱内两侧的轮罩凸台（后轴处、贴侧内壁）
      const xw = -g.WB / 2, hwh = Math.max(0.12, g.rw + g.rA + 0.05 - g.hFloor), ww = Math.min(0.3, 0.25 * yiM)
      for (const sy of [1, -1]) box(liner, [xw, sy * (yiM - ww / 2), zf - hwh / 2], [Math.min(g.rA + 0.05, 0.35 * (xc - xa)), ww / 2, hwh / 2], ['+x', '-x', sy > 0 ? '-y' : '+y', '-z'])
      put(ctx, 'bedliner', 'other', part, TRIM, liner)
      decal(tail, [g.xb0, 0, -(g.beltLine(g.xb0) - 0.1)], [-1, 0, 0], [0, 1, 0], 0.12, 0.025)   // 尾门把手
    }
    // —— 前脸 / 车尾贴花：格栅、大灯、尾灯；门把手
    const fx = g.xb1, ht = g.hTop(fx)
    const van = g.style === 'van', bumpTopF = g.hBotF + 0.1 * g.Hr, grilleTop = ht - (van ? 0.16 : 0.07), grilleBot = bumpTopF + 0.02
    if (grilleTop > grilleBot + 0.05) {
      const gc = -(grilleTop + grilleBot) / 2, gh = (grilleTop - grilleBot) / 2
      decal(trim, [fx, 0, gc], [1, 0, 0], [0, 1, 0], 0.2 * g.W, gh)                                              // 格栅
      for (const f of [-1 / 3, 1 / 3]) decal(lights, [fx, 0, gc + f * gh], [1, 0, 0], [0, 1, 0], 0.2 * g.W, 0.012, 0.007)   // 两道镀铬横条
    }
    const hl = van ? [0.095 * g.W, 0.09, ht - 0.24] : [0.09 * g.W, 0.055, ht - 0.13]
    for (const sy of [1, -1]) {                                                                                     // 大灯：深色灯罩 + 亮灯芯
      decal(trim, [fx, sy * 0.32 * g.W, -hl[2]], [1, 0, 0], [0, 1, 0], hl[0], hl[1])
      decal(lights, [fx, sy * 0.32 * g.W, -hl[2]], [1, 0, 0], [0, 1, 0], 0.6 * hl[0], 0.55 * hl[1], 0.007)
    }
    const hr = g.style === 'van' ? g.hBotR + 0.45 : g.hTop(g.xb0) - 0.15
    for (const sy of [1, -1]) decal(tail, [g.xb0, sy * 0.39 * g.W, -hr], [-1, 0, 0], [0, 1, 0], 0.045, g.style === 'van' ? 0.2 : 0.09)
    if (g.style === 'van') decal(trim, [g.xb0, 0, -(g.hBotR + g.Hr) / 2], [-1, 0, 0], [0, 1, 0], 0.006, (g.Hr - g.hBotR) / 2 - 0.08)   // 后门对开缝
    for (const xh of g.handles) {
      const h = g.hBelt(xh) - 0.08, y = sideYAt(g, xh, h)
      for (const sy of [1, -1]) decal(trim, [xh, sy * y, -h], [0, sy, 0], [1, 0, 0], 0.09, 0.016, 0.006)
    }
    // —— 保险杠（黑色塑料；前后端面恰在车长两端）
    const bumper = (x0, x1, hb, ht2) => {
      const hx = (x1 - x0) / 2, hy = 0.93 * g.hwx((x0 + x1) / 2), ol = roundRect(hx, hy, Math.min(0.12, 0.9 * hx), 4).map(([x, y]) => [x + (x0 + x1) / 2, y])
      extrude(trim, ol, -hb, -ht2)
    }
    bumper(g.xF - 0.16, g.xF, g.hBotF - 0.02, bumpTopF)
    bumper(g.xR, g.xR + 0.16, g.hBotR - 0.02, g.hBotR + 0.12 * g.Hr)
    // —— 底盘（轮间深色）+ 轮罩内衬 + 翼子板轮眉（越野车 / 皮卡）
    const yc = Math.max(0.15, g.T / 2 - g.tireW / 2 - 0.05), archTop = g.style === 'pickup' ? Math.min(g.rw + g.rA + 0.03, g.hFloor - 0.03) : g.rw + g.rA + 0.03
    const xa = g.WB / 2, sect = (x, hb, htp) => [[x, -yc, -hb], [x, yc, -hb], [x, yc, -htp], [x, -yc, -htp]]
    prism(trim, sect(-xa, g.clr, archTop), sect(xa, g.clr, archTop))
    const xe1 = Math.max(xa + 0.05, g.xb1 - 0.25), xe0 = Math.min(-xa - 0.05, g.xb0 + 0.25)
    prism(trim, sect(xa, g.clr, archTop), sect(xe1, Math.min(g.hBotF - 0.05, archTop - 0.05), archTop))
    prism(trim, sect(xe0, Math.min(g.hBotR - 0.05, archTop - 0.05), archTop), sect(-xa, g.clr, archTop))
    const flares = g.style !== 'van', rf = 0.03
    for (const xw of [xa, -xa]) {
      for (const sy of [1, -1]) {
        // 内衬：轮拱上半圆柱面（φ 0…π），朝轮心
        const G = [], yo = 0.97 * g.hw
        for (let k = 0; k <= 12; k++) { const ph = (Math.PI * k) / 12, r = g.rA - 0.01; G.push([[xw + r * Math.cos(ph), sy * yc, -(g.rw + r * Math.sin(ph))], [xw + r * Math.cos(ph), sy * yo, -(g.rw + r * Math.sin(ph))]]) }
        grid(liners, G, { out: (c) => [xw - c[0], 0, -g.rw - c[2]] })
        if (flares) {
          const F = [], R0 = g.rA + 0.012, yf = sy * (g.hw - rf)
          for (let k = 0; k <= 14; k++) {
            const ph = (-8 + (196 * k) / 14) * D2R, q = [Math.cos(ph), 0, -Math.sin(ph)], row = []
            for (let m = 0; m < 8; m++) { const ps = (2 * Math.PI * m) / 8; row.push(add([xw, yf, -g.rw], add(scl(q, R0 + rf * Math.cos(ps)), [0, sy * rf * Math.sin(ps), 0]))) }
            F.push(row)
          }
          grid(trim, F, { wrap: true, out: (c) => { const w = sub(c, [xw, yf, -g.rw]), pr = nrm([w[0], 0, w[2]]); return sub(w, scl(pr, R0)) } })
        }
      }
    }
    put(ctx, 'trim', 'other', part, TRIM, trim)
    put(ctx, 'liners', 'other', part, TRIM, liners)
    put(ctx, 'lights', 'other', part, 'aluminum', lights)
    put(ctx, 'taillights', 'other', part, RED, tail)
    // —— 车轮
    const tires = new MB(), rims = new MB()
    for (const xw of [xa, -xa]) for (const sy of [1, -1]) {
      const w = wheel([xw, sy * g.T / 2, -g.rw], [0, sy, 0], g.rw, g.tireW, 0.62 * g.rw, 32)
      appendMB(tires, w.tire); appendMB(rims, w.rim)
    }
    put(ctx, 'tires', 'other', whl, RUBBER, tires)
    put(ctx, 'rims', 'other', whl, 'aluminum', rims)
    // —— 后视镜（节点名 mirrors：量车宽时排除）
    if (p.mirrors) {
      const mm = new MB(), xm = g.xCowl - 0.12, hb = g.hBelt(xm), van = g.style === 'van'
      const hs = van ? [0.07, 0.13, 0.19] : [0.055, 0.1, 0.075], hc = hb + (van ? 0.3 : 0.13)
      for (const sy of [1, -1]) {
        const ys = sy * 0.95 * g.hwx(xm), ym = sy * (g.hw + hs[1] + 0.06)
        beam(mm, [xm, ys, -(hb + 0.04)], [xm - 0.02, ym - sy * hs[1] * 0.8, -hc], 0.05, 0.03)
        box(mm, [xm - 0.02, ym, -hc], hs)
      }
      put(ctx, 'mirrors', 'other', part, 'dark_metal', mm)
    }
    // —— 车顶架：两根纵梁 + 横杆 + 支脚（架顶恰在车高）
    if (p.roofRack) {
      const rk = new MB(), H = g.H, rh = Math.min(RACK_RAIL_H, 0.5 * g.rackH), hl = g.rackL / 2
      for (const sy of [1, -1]) {
        box(rk, [g.rackC, sy * g.yRail, -(H - rh / 2)], [hl, 0.02, rh / 2])
        for (const t of [-0.92, 0, 0.92]) {
          const x = g.rackC + t * hl, hr0 = roofHAt(g, x, g.yRail) - 0.01, h1 = H - rh
          if (h1 > hr0 + 1e-3) box(rk, [x, sy * g.yRail, -(hr0 + h1) / 2], [0.03, 0.022, (h1 - hr0) / 2])
        }
      }
      const nb = Math.max(2, Math.round(g.rackL / 0.45))
      for (let k = 0; k < nb; k++) { const x = g.rackC - hl + 0.04 + ((2 * hl - 0.08) * k) / (nb - 1); box(rk, [x, 0, -(H - 0.0125)], [0.018, g.yRail, 0.0125]) }
      put(ctx, 'rack', 'other', part, 'aluminum', rk)
    }
    datumAp(ctx)
    return ctx
  }
}
/** 车顶在 (x, y) 处的离地高（截面车顶拱面）。 */
function roofHAt(g, x, y) { const s = sectionRight(g, x), yr = s.roofHalf; return s.hTop - g.S.crown * (yr > 0 ? Math.min(1, (y / yr) ** 2) : 0) }

// ───────────────────────────── veh.cotm.flat：平板动中通终端 ─────────────────────────────

const KYMETA_U8_URL = 'https://www.idirect.net/wp-content/uploads/2023/01/ProductSheet-Kymeta-Hawk-u8.pdf'
/** 平板终端外形预设（厂商资料逐字：L × W × H cm → m）。 */
export const FLAT_PANELS = Object.freeze({
  'kymeta-u8': Object.freeze({ L: 0.895, W: 0.895, H: 0.14, source: KYMETA_U8_URL })
})
const panelDims = (p) => (p.model === 'custom' ? { L: p.lengthM, W: p.widthM, H: p.heightM } : FLAT_PANELS[p.model])

const cotmFlat = {
  type: 'veh.cotm.flat', domain: ['vehicle', 'ship', 'ground', 'aircraft'], title: 'Flat-panel COTM terminal', titleZh: '平板动中通', role: 'feed',
  params: {
    model: enm('kymeta-u8', ['kymeta-u8', 'custom'], '型号', { source: KYMETA_U8_URL, title: 'kymeta-u8 = Kymeta Hawk u8（89.5 × 89.5 × 14 cm）；custom = 按下面三项' }),
    lengthM: num(0.895, 'm', '长', { gt: 0.05, max: 3, source: KYMETA_U8_URL, title: '型号 custom 时生效' }),
    widthM: num(0.895, 'm', '宽', { gt: 0.05, max: 3, source: KYMETA_U8_URL, title: '型号 custom 时生效' }),
    heightM: num(0.14, 'm', '高', { gt: 0.02, max: 1, source: KYMETA_U8_URL, title: '型号 custom 时生效；含安装脚' }),
    feet: bool(true, '安装脚'),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '留空 = 28 kg/m² × 长 × 宽（示意）' })
  },
  sockets: (p) => { const d = panelDims(p); return [standSocket(Math.min(d.L, d.W), 90)] },
  symmetricPlanes: ['xz', 'yz'],
  build(p, kit) {
    const ctx = kit.createCtx(), d = panelDims(p), part = { id: 'antenna', name: '平板天线', role: 'feed' }
    const hf = p.feet ? Math.min(0.02, 0.12 * d.H) : 0, hb = 0.55 * (d.H - hf), hd = d.H - hf - hb
    // 平面超椭圆轮廓（e = 6，x 前 / y 右；64 点，四个轴向极值点恰在 ±L/2、±W/2）
    const outline = superRing(64, d.W / 2, d.L / 2, d.L / 2, 6).map(([y, z]) => [z0(-z), y])
    const base = new MB(); extrude(base, outline, -hf, -(hf + hb))
    put(ctx, 'base', 'feed', part, 'aluminum', base)
    // 罩：竖边 → 圆角 → 微拱顶（极点在顶心，z = −H）
    const e = Math.min(0.05, 0.45 * hd), crown = Math.min(0.012, 0.2 * hd), es = e / (0.5 * Math.min(d.L, d.W)), s0 = 0.985
    const z = (h) => -(hf + hb + h), ring = (s, h) => ({ pts: outline.map(([x, y]) => [x * s, y * s, z(h)]) })
    const secs = [ring(s0, 0), ring(s0, Math.max(0, hd - crown - e) * 0.999)]
    for (let k = 1; k <= 4; k++) { const a = (k / 4) * 90 * D2R; secs.push(ring(s0 - es * (1 - Math.cos(a)), hd - crown - e + e * Math.sin(a))) }
    const sE = s0 - es
    for (const f of [0.66, 0.33]) secs.push(ring(sE * f, hd - crown * f * f))
    secs.push({ pts: outline.map(() => [0, 0, z(hd)]) })
    const dome = new MB(), lf = loft(dome, secs), nj = outline.length
    for (let j = 0; j < nj; j++) { const q = 3 * (lf.v0 + (secs.length - 1) * nj + j); dome.n[q] = 0; dome.n[q + 1] = 0; dome.n[q + 2] = -1 }   // 顶心极点法向朝上
    put(ctx, 'radome', 'feed', part, 'carbon', dome)
    if (p.feet) {
      const fm = new MB()
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) box(fm, [sx * 0.36 * d.L, sy * 0.36 * d.W, -hf / 2], [0.035, 0.035, hf / 2])
      put(ctx, 'feet', 'other', part, 'dark_metal', fm)
    }
    boxComp(ctx, 'terminal', auto(p.massKg, 28 * d.L * d.W), [0, 0, -d.H / 2], [0.45 * d.L, 0.45 * d.W, d.H / 2])
    ctx.parts.get('antenna').normalBody = [0, 0, -1]
    apLocal(ctx, 'boresight', [0, 0, -d.H], [0, 0, -1], [1, 0, 0])
    return ctx
  }
}

// ───────────────────────────── veh.driveaway：车顶自动展开天线底座 ─────────────────────────────

const INETVU_URL = 'https://www.c-comsat.com/wp-content/uploads/2022/02/iNetVuDatasheets_RevFeb2022-1.pdf'
/**
 * 展开座收拢外形预设（厂商资料：收拢 203 × 124 × 35 cm，source 只管 L / W / H）。azTravel = 方位行程缺省：研究表没有独立的
 * 方位字段（只在仰角条目的附注里记了「方位 ±200°」），按示意值处理，与模板的 dw.azTravelDeg 同一口径。
 */
export const DRIVEAWAYS = Object.freeze({
  'inetvu-1202': Object.freeze({ L: 2.03, W: 1.24, H: 0.35, azTravel: 400, source: INETVU_URL })
})
const REFL_ACCEPTS = Object.freeze(['es.refl.', 'prim.'])
/** 展开座尺寸推算：底板占地 = 收拢外形 L × W；方位转台在底板后部（x = −0.25 L），俯仰铰点在方位轴上。 */
function dwGeom(p) {
  const d = p.model === 'custom' ? { L: p.lengthM, W: p.widthM, H: p.heightM } : DRIVEAWAYS[p.model]
  const ph = p.plateHM, hh = auto(p.hingeHM, 0.5 * d.H), xa = -0.25 * d.L, rT = Math.min(0.2, 0.18 * d.W)
  return { ...d, ph, hh, xa, rT, zTT: -(ph + 0.035), zTop: -(ph + 0.05) }
}

const driveaway = {
  type: 'veh.driveaway', domain: ['vehicle'], title: 'Drive-away antenna mount', titleZh: '车顶展开座', role: 'boom',
  params: {
    model: enm('inetvu-1202', ['inetvu-1202', 'custom'], '型号', { source: INETVU_URL, title: 'inetvu-1202 = C-COM iNetVu 1202（收拢 203 × 124 × 35 cm）；custom = 按下面三项' }),
    lengthM: num(2.03, 'm', '长', { gt: 0.5, max: 5, source: INETVU_URL, title: '收拢外形长 = 底板占地长；型号 custom 时生效' }),
    widthM: num(1.24, 'm', '宽', { gt: 0.4, max: 3, source: INETVU_URL, title: '收拢外形宽 = 底板占地宽；型号 custom 时生效' }),
    heightM: num(0.35, 'm', '收拢高', { gt: 0.1, max: 1.5, source: INETVU_URL, title: '收拢总高；型号 custom 时生效' }),
    plateHM: num(0.08, 'm', '底架高', { gt: 0.02, max: 0.5 }),
    hingeHM: num(null, 'm', '俯仰铰点高', { nullable: true, gt: 0, title: '安装面到俯仰轴；留空 = 0.5 × 收拢高' }),
    azTravelDeg: num(400, '°', '方位行程', { gt: 0, max: 720, title: '须与反射面同名参数一致；缺省 ±200°（厂家数据表附注量级，研究表无独立字段，按示意值）' }),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '留空 = 22 kg/m² × 底板占地（示意，不含反射面）' })
  },
  validate: (p) => {
    const g = dwGeom(p), e = []
    if (!(g.ph < g.H)) e.push('底架高超过收拢高')
    if (!(g.hh > -g.zTop + 0.03)) e.push('俯仰铰点过低')
    if (!(g.L >= 4 * g.rT + 0.3)) e.push('底板过短')
    return e
  },
  sockets: (p) => { const g = dwGeom(p); return [standSocket(Math.min(g.L, g.W), 90), sock('el', [g.xa, 0, -g.hh], [1, 0, 0], [0, 0, -1], 0.3, 90, REFL_ACCEPTS)] },
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = dwGeom(p), part = { id: 'mount', name: '展开座', role: 'boom' }
    // 固定：两根纵梁（占地恰为 L × W）+ 三根横梁 + 转台下的底板 + 方位轴承座 + 前部收拢托架
    const fr = new MB(), cw = 0.06
    for (const sy of [1, -1]) box(fr, [0, sy * (g.W / 2 - cw / 2), -g.ph / 2], [g.L / 2, cw / 2, g.ph / 2])
    for (const x of [-g.L / 2 + 0.04, 0.1 * g.L, g.L / 2 - 0.04]) box(fr, [x, 0, -0.5 * g.ph], [0.03, g.W / 2 - cw, 0.35 * g.ph])
    extrude(fr, roundRect(g.rT + 0.12, g.W / 2 - cw, 0.05, 4).map(([x, y]) => [x + g.xa, y]), -0.6 * g.ph, -g.ph)
    put(ctx, 'frame', 'boom', part, 'aluminum', fr)
    const hs = new MB(); frustum(hs, [g.xa, 0, -g.ph], g.rT, [g.xa, 0, g.zTT], g.rT, 40, false, true)
    put(ctx, 'azhousing', 'boom', part, 'dark_metal', hs)
    const cr = new MB(), xc = g.L / 2 - 0.3, hcr = Math.max(g.ph + 0.05, 0.6 * g.H)
    for (const sy of [1, -1]) {
      tubeAlong(cr, [xc, sy * 0.3 * g.W, -g.ph], [xc, sy * 0.3 * g.W, -hcr], 0.025, 12)
      box(cr, [xc, sy * 0.3 * g.W, -(hcr + 0.015)], [0.05, 0.06, 0.015])
    }
    tubeAlong(cr, [xc, -0.3 * g.W, -(hcr - 0.03)], [xc, 0.3 * g.W, -(hcr - 0.03)], 0.02, 12)
    put(ctx, 'cradle', 'boom', part, 'white_paint', cr)
    // 方位动件（节点系 = 方位关节系，原点在俯仰铰点）：转台 + 两块俯仰铰座板 + 铰轴套 + 方位电机箱 + 俯仰作动筒
    const G = gimbalFrame('azel', [1, 0, 0], [0, 0, -1]), o = [g.xa, 0, -g.hh]
    const tt = new MB(); frustum(tt, [g.xa, 0, g.zTT], 1.06 * g.rT, [g.xa, 0, g.zTop], 1.06 * g.rT, 40, true, true)
    const br = new MB(), yb = 0.1, bt = 0.015
    for (const sy of [1, -1]) {
      const y0 = sy * yb - bt / 2, y1 = sy * yb + bt / 2
      prism(br, [[g.xa - 0.14, y0, g.zTop], [g.xa + 0.14, y0, g.zTop], [g.xa + 0.14, y1, g.zTop], [g.xa - 0.14, y1, g.zTop]],
        [[g.xa - 0.05, y0, -(g.hh + 0.045)], [g.xa + 0.05, y0, -(g.hh + 0.045)], [g.xa + 0.05, y1, -(g.hh + 0.045)], [g.xa - 0.05, y1, -(g.hh + 0.045)]])
      tubeAlong(br, [g.xa, sy * (yb - 0.02), -g.hh], [g.xa, sy * (yb + 0.03), -g.hh], 0.032, 20)
    }
    const dr = new MB()
    box(dr, [g.xa - 0.8 * g.rT, 0, g.zTop - 0.045], [0.07, 0.08, 0.045])
    tubeAlong(dr, [g.xa + 0.1, 0, g.zTop - 0.02], [g.xa + 0.1 + 0.3 * Math.cos(20 * D2R), 0, g.zTop - 0.02 - 0.3 * Math.sin(20 * D2R)], 0.028, 16)
    const nodes = []
    for (const [name, mat, mb] of [['turntable', 'aluminum', tt], ['brackets', 'white_paint', br], ['drives', 'dark_metal', dr]]) if (putFramed(ctx, name, 'boom', part, mat, mb, G, o)) nodes.push(name)
    const [mn, mx, ini] = azStage(p.azTravelDeg)
    ctx.arts.push({ name: 'azimuth', nodes, stages: [stage(STAGE.az, 'zRotate', mn, mx, ini)] })
    const m = auto(p.massKg, 22 * g.L * g.W)
    boxComp(ctx, 'base', 0.55 * m, [0, 0, -g.ph / 2], [g.L / 2, g.W / 2, g.ph / 2])
    boxComp(ctx, 'turntable', 0.45 * m, [g.xa, 0, -(g.ph + g.hh) / 2], [g.rT, g.rT, (g.hh - g.ph) / 2 + 0.02])
    return ctx
  }
}

export const VEH_COMPONENTS = Object.freeze([vehBody, cotmFlat, driveaway])
