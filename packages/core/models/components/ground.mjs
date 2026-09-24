// 地球站领域装配组件（三期契约 DESIGN3 §1 P1b、E5；装配调研 assembly-ux §4「地球站」；A3 SPEC §2）。
//
// 纯 ESM、零 three 依赖、node 可测。几何全部是参数化的真实结构件：碟面是真抛物面（前 / 背两层壳 + 口沿）带背架（辐射肋 + 环梁 +
// 中心筒），卡塞格伦副面是按两焦点反推的双曲面，偏馈是母抛物面的偏置截片（口面投影为圆），方位俯仰座是真关节（AGI 口径：
// 方位 zRotate 套俯仰 xRotate，节点系按挂点系推，驱动值即 gimbal.solveAzEl 的主解，符号与 entityPose.STATION_MOUNT 一致）。
//
// ★ 局部坐标（非卫星领域统一，与 E5 的本体轴同向）：+X 前（船艏 / 机头 / 北）、+Y 右（右舷 / 东）、+Z 向下；原点 = 安装基准点。
//   与卫星件的「局部 −Z 贴父面」不同：这里立在父面上的件 mount 插座 n = +Z（朝下贴父面），吊挂件 n = −Z（朝上贴父面）。
//   这样根件单位位姿即正放（本体 FRD / NED），子件装在水平顶面上、滚转 0° 时与父件同向——整个模板直接按本体系搭。
//   顶面约定：n = −Z、u = +X（滚转零位 = 前 / 北）、v = n × u = −Y；侧面 u = +X；前后面 u = −Z（上）。
//
// ★ 关节（地面天线）：
//   反射面组件（es.refl.*）的原点 = 俯仰轴（或 X-Y 座的 Y 轴）中心、零位视轴 +X、方位轴（up）−Z；它的挂点 boresight 就在原点、
//   dir = +X、up = −Z——装到方位俯仰座 el 插座上即 entityPose.STATION_MOUNT（z = 北、y = 天顶、x = 西）。关节节点系由挂点系推：
//     azel：G = [−x, z, y]（x = y × z）——zRotate(a1) 绕方位轴右手转（北 → 西为正 = −罗盘方位），xRotate(a2) 抬起视轴；
//     xy  ：G = [−x, y, −z]——xRotate(a1) 使视轴偏向 +y、yRotate(a2) 使视轴偏向 +x（gimbal.dirFromXY 同式）。
//   于是 dirFromGimbal(type, a1, a2) 在挂点系里恰为关节摆到 (a1, a2) 后的实际视轴（单测对拍）。
//   同一节点只能属于一条关节（glTF 节点的 articulationName 只有一个），所以动件按「只转方位」「方位 + 俯仰」分两条：
//   座架转台 = 'azimuth'（stage azimuth），碟面 + 背架 + 副面 + 馈源 = 'gimbal'（stage azimuth、elevation）。
//   跨组件联动靠 stage 名：驱动时对每条关节按 stage 名写同一组值（gimbalValues）。两条关节的方位行程 / 初值由各自的
//   azTravelDeg 算（azStage），模板里座架与反射面填同一个数。
//   X-Y 座两轴不相交（Y 轴在 X 轴之上 offset）：反射面节点系放在 X 轴中心，stage = xRotate · zTranslate(−h) · yRotate · zTranslate(+h)，
//   两个平移级是定值（min = max = initial），静止位姿恰为单位阵——不认关节的查看器也画对。
//   副面 / 馈源必须随碟面一起转，所以卡塞格伦 / 主焦 / 偏馈反射面都自带副面、馈源与撑杆；es.subrefl / es.feed 是给固定天线
//   手搭用的独立件（不带关节）。
//
// ★ 缺省参数一律示意值（source:'illustrative'），不取任何具体型号；ISO 668 集装箱尺寸是标准值（source = 标准页）。
//   尺寸类缺省尽量写成「留空 = 按口径 / 基准量推算」（比例是示意值），模板只填有出处的量，其余靠推算——不同口径的天线都像样。
//
// ★ E2「局部 −Z 贴父面」在 +Z 向下领域的落法（四个非卫星领域文件统一）：立件 mount 插座 n = +Z、up = +X（standSocket），
//   吊挂件 n = −Z（hangSocket）；横向对齐件 n = ∓Y（latSocket / latMount，见 shapeKit）。根件单位位姿 = 本体 FRD / NED，
//   子件滚转 0° 时与父件同向；顶面 face 系 = Rx180 = 立件 mount 系，解算结果为单位阵。
//
// ★ 反射面「最前点距离」reachM（CPI 一类读图口径：俯仰轴高 + 仰角 90° 总高）：给了就按 cassReach0 / primeReach0（与 build 同一组
//   变量逐点求「顶点前伸为 0 时沿视轴的最前点」）反推顶点前伸，组件局部包围盒 max.x 恰为 reachM。
//
// 导出：
//   GROUND_COMPONENTS  地球站组件定义（es.pedestal.azel / es.pedestal.xy / es.refl.prime / es.refl.cass / es.refl.offset /
//                      es.subrefl / es.feed / es.radome / es.shelter / es.tower / es.vsat.mount / es.pedestal.wheeltrack / es.mast）
//   关节：STAGE（stage 名）、gimbalFrame(kind, dir, up)、azStage(travel)、gimbalValues(articulations, a1, a2)
//   反射面：dishDensity(D)、cassLayout(D, f, Ds, subH)、cassReach0(p)、primeReach0(p)
//   通用造型工具（参数 / 插座 / 面 / 网格 / 升力面 / 质量 / 登记 / 集装箱 / matOr / stage）一律从 ./shapeKit.mjs 取（A3 SPEC §3.1：
//   原样搬迁、搬迁前后 IR 逐字节相同；本文件不做兼容再导出）。

import {
  isNum, add, sub, scl, dot, cross, len, nrm, reject, madd, clampN, z0, MB, box, frustum, annulus, comp, boxComp, perpPair,
  rApply
} from '../meshKit.mjs'
import {
  ISO668, num, int, bool, enm, auto, D2R, sock, standSocket, planeFace, faceSocket, boxFacesUp, grid, cap, lathe, torus, prism,
  tubeAlong, xform, solidCompItems, solidComp, shellMass, stage, apLocal, put, putFramed, ISO_BOX, containerMeshes, matOr, beam
} from './shapeKit.mjs'

// ───────────────────────────── 材质 / 质量小常量 ─────────────────────────────

const CONCRETE = matOr('concrete', 'titanium')   // 基础 / 基座：计划键 concrete 补上前回退 titanium（A3 SPEC §1.5）
/** 反射面等效面密度（含背架，示意：小口径 SMC 压制面约 11 kg/m²，大口径铝面板 + 钢背架约 25 kg/m² 量级）。 */
export const dishDensity = (D) => 10 + 1.1 * D

// ───────────────────────────── 关节 ─────────────────────────────

/** stage 名（跨组件联动的约定；驱动时按名写值）。 */
export const STAGE = Object.freeze({ az: 'azimuth', el: 'elevation', x: 'xAxis', y: 'yAxis' })
/**
 * 挂点系（z = 零位视轴 dir、y = 方位轴 up、x = y × z）→ 关节节点系 G（列向量形式）：
 *   azel：G = [−x, z, y]（zRotate = 方位、xRotate = 俯仰）；xy：G = [−x, y, −z]（xRotate = X 轴、yRotate = Y 轴）。
 */
export function gimbalFrame(kind, dir, up) {
  const z = nrm(dir), y = nrm(reject(up, z)), x = cross(y, z)
  return (kind === 'xy' ? [scl(x, -1), y, scl(z, -1)] : [scl(x, -1), z, y]).map((v) => v.map(z0))
}
/**
 * 方位关节的限位与初值（a1 口径 = −罗盘方位）：行程 ≥ 360° 以北为中心（初值 0）；不足 360° 以南为中心（初值 180，
 * 北半球对 GEO 弧段的常规朝向）。@returns {[min, max, init]}
 */
export function azStage(travel) {
  return travel >= 360 ? [-travel / 2, travel / 2, 0] : [180 - travel / 2, 180 + travel / 2, 180]
}
/**
 * 驱动值：对每条含 azimuth / elevation（或 xAxis / yAxis）stage 的关节给同一组值——座架转台与碟面两条关节一起转。
 * 结果形如 {关节名: {azimuth, elevation} | {xAxis, yAxis}}，直接喂 viewport.setArticulation / poseArticulations。
 */
export function gimbalValues(articulations, a1, a2) {
  const out = {}
  for (const a of articulations || []) {
    const names = new Set((a.stages || []).map((s) => s.name))
    if (names.has(STAGE.az) || names.has(STAGE.el)) out[a.name] = { [STAGE.az]: a1, [STAGE.el]: a2 }
    else if (names.has(STAGE.x) || names.has(STAGE.y)) out[a.name] = { [STAGE.x]: a1, [STAGE.y]: a2 }
  }
  return out
}

// ───────────────────────────── 反射面光学（组件局部系） ─────────────────────────────
//
// 反射面组件局部系：原点 = 俯仰轴（xy：Y 轴）中心、零位视轴 +X、上 −Z、右 +Y。母抛物面：顶点 V、轴 a、焦距 f；
// 口径面坐标 (x1, x2) 沿 (e1, e2)，e1 × e2 = a。点 P = V + e1·x1 + e2·x2 + a·(x1² + x2²)/(4f)，凹面法向 N = nrm(a − (e1x1 + e2x2)/(2f))。

const paraP = (L, x1, x2) => add(add(add(L.V, scl(L.e1, x1)), scl(L.e2, x2)), scl(L.a, (x1 * x1 + x2 * x2) / (4 * L.f)))
const paraN = (L, x1, x2) => nrm(sub(L.a, scl(add(scl(L.e1, x1), scl(L.e2, x2)), 1 / (2 * L.f))))

/**
 * 反射面三层（凹面 / 背面 / 口沿；中心开孔时加内沿）：口径面上 (ρ, φ) 网格 → (x1, x2) = (xc + r cos φ, r sin φ)，
 * r 从 r0 到 R（按面积均匀分环）。th = 背面离凹面的壳厚。返回 {front, back, rim}（MB）与面积。
 */
function dishShell(L, xc, r0, R, th, nr, nphi) {
  const ring = (r, off) => {
    const row = []
    for (let j = 0; j < nphi; j++) {
      const ph = (2 * Math.PI * j) / nphi, x1 = xc + r * Math.cos(ph), x2 = r * Math.sin(ph)
      const p = paraP(L, x1, x2)
      row.push(off ? sub(p, scl(paraN(L, x1, x2), th)) : p)
    }
    return row
  }
  const rs = []
  for (let i = 0; i <= nr; i++) rs.push(Math.sqrt(r0 * r0 + (R * R - r0 * r0) * (i / nr)))
  const front = new MB(), back = new MB(), rim = new MB()
  grid(front, rs.map((r) => ring(r, false)), { wrap: true, out: L.a })
  grid(back, rs.map((r) => ring(r, true)), { wrap: true, out: scl(L.a, -1) })
  const cen = paraP(L, xc, 0)
  grid(rim, [ring(R, false), ring(R, true)], { wrap: true, out: (c) => reject(sub(c, cen), L.a) })
  if (r0 > 0) grid(rim, [ring(r0, false), ring(r0, true)], { wrap: true, out: (c) => scl(reject(sub(c, cen), L.a), -1) })
  return { front, back, rim }
}

/**
 * 轴对称碟面的背架：中心筒 + 辐射肋（肋板外缘贴背面、内缘为直线，深度自中心向口沿收小）+ 两道环梁。
 * 全部画在一个 MB 里（钢结构同一材质）。
 */
function dishBackframe(mb, L, R, rHub, th, nRibs, depth0, ribT) {
  const back = (r, ph) => { const x1 = r * Math.cos(ph), x2 = r * Math.sin(ph); return sub(paraP(L, x1, x2), scl(paraN(L, x1, x2), th)) }
  const r1 = 0.97 * R
  const dep = (r) => depth0 * (1 - 0.8 * (r - rHub) / (r1 - rHub))
  const m = 8
  for (let k = 0; k < nRibs; k++) {
    const ph = (2 * Math.PI * (k + 0.5)) / nRibs, rad = add(scl(L.e1, Math.cos(ph)), scl(L.e2, Math.sin(ph))), tan = cross(L.a, rad)
    for (const sgn of [1, -1]) {
      const G = []
      for (let i = 0; i <= m; i++) {
        const r = rHub + (r1 - rHub) * (i / m), b = back(r, ph)
        G.push([madd(b, tan, sgn * ribT / 2), madd(madd(b, L.a, -dep(r)), tan, sgn * ribT / 2)])
      }
      grid(mb, G, { out: scl(tan, sgn) })
    }
  }
  for (const fr of [0.45, 0.8]) {
    const r = fr * R, b = back(r, 0), axial = dot(sub(b, L.V), L.a) - dep(r) / 2
    torus(mb, madd(L.V, L.a, axial), L.a, r, Math.max(0.01, ribT * 0.9), 48, 8)
  }
}

/** 撑杆（管）集合：从碟面 r 处的背面点到目标点（每根一段管）。 */
function struts(mb, L, pts, target, r) { for (const p of pts) tubeAlong(mb, p, target, r, 10) }

// ───────────────────────────── 地球站：座架 ─────────────────────────────

const REFL_ACCEPTS = Object.freeze(['es.refl.', 'prim.'])
const STEEL_AREAL = 90        // 座架钢壳等效面密度（kg/m²，示意：约 11 mm 钢板）
const STEEL_SOLID = 1200      // 臂 / 支架等效体密度（kg/m³，示意：箱形焊接件按外包络折算）

/** 方位俯仰座（立柱式 king-post）尺寸推算。 */
function azelGeom(p) {
  const Dd = p.dishDM, H = auto(p.elAxisHM, 0.52 * Dd + 0.3), baseD = auto(p.baseDM, 0.16 * Dd + 0.6), yokeW = auto(p.yokeWM, 0.3 * Dd + 0.4)
  const armH = clampN(0.28 * H, 0.35, 0.45 * H), headH = 0.1 * H + 0.15, topD = 0.62 * baseD
  const headD = Math.max(1.12 * topD, 0.6 * yokeW), armX = 0.3 * headD, armT = Math.max(0.06, 0.09 * yokeW)
  const yokeTB = Math.max(0.08, 0.12 * headH)       // 叉座横梁高（转台顶面之上）
  return { H, baseD, yokeW, armH, headH, topD, headD, armX, armT, yokeTB, hPostTop: H - armH - headH, hHeadTop: H - armH }
}

const pedestalAzel = {
  type: 'es.pedestal.azel', domain: ['ground', 'ship', 'vehicle'], title: 'Az-El pedestal', titleZh: '方位俯仰座', role: 'boom',
  params: {
    dishDM: num(4.0, 'm', '配套口径', { gt: 0, title: '座架按它推算缺省尺寸（比例为示意值）' }),
    elAxisHM: num(null, 'm', '俯仰轴高', { nullable: true, gt: 0, title: '安装面到俯仰轴；留空 = 0.52 × 配套口径 + 0.3 m' }),
    baseDM: num(null, 'm', '立柱底径', { nullable: true, gt: 0, title: '留空 = 0.16 × 配套口径 + 0.6 m' }),
    yokeWM: num(null, 'm', '俯仰轴承间距', { nullable: true, gt: 0, title: '留空 = 0.3 × 配套口径 + 0.4 m' }),
    padHM: num(0.3, 'm', '基础高', { min: 0 }),
    azTravelDeg: num(540, '°', '方位行程', { gt: 0, max: 720, title: '≥ 360° 以北为中心；不足 360° 以南为中心' }),
    seg: int(48, '分段', { min: 12, max: 128 }),
    style: enm('kingpost', ['kingpost', 'tripod'], '座型', { title: 'kingpost = 锥形立柱；tripod = 三根圆管腿（着地半径 0.9 × 立柱底径、120° 均布）汇到方位轴承下的短套筒' })
  },
  validate: (p) => { const g = azelGeom(p); return g.hPostTop > p.padHM ? [] : ['俯仰轴高不足以放下转台与叉臂'] },
  sockets: (p) => { const g = azelGeom(p); return [standSocket(g.baseD, 15), sock('el', [0, 0, -g.H], [1, 0, 0], [0, 0, -1], g.yokeW, 90, REFL_ACCEPTS)] },
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = azelGeom(p), seg = p.seg
    const part = { id: 'pedestal', name: '方位俯仰座', role: 'boom' }
    const padPart = { id: 'pad', name: '基础', role: 'other' }
    if (p.style === 'tripod') {
      // 三脚座：三根圆管腿（120° 均布，一条腿朝南 −X，关于 xz 面对称）自各自的基础墩升到方位轴承下的短套筒；腿间一圈水平系杆
      const rf = 0.9 * g.baseD, rl = Math.max(0.035, 0.05 * g.baseD), hc = Math.min(0.3 * (g.hPostTop - p.padHM), 0.25 + 0.12 * g.baseD)
      const zc0 = -(g.hPostTop - hc), zt = -g.hPostTop + 0.75 * hc, angs = [Math.PI, Math.PI / 3, -Math.PI / 3]
      if (p.padHM > 0) {
        const m = new MB()
        for (const a of angs) box(m, [rf * Math.cos(a), rf * Math.sin(a), -p.padHM / 2], [2.2 * rl, 2.2 * rl, p.padHM / 2])
        put(ctx, 'pad', 'other', padPart, CONCRETE, m)
      }
      const lm = new MB(), feet = [], tops = []
      for (const a of angs) {
        const c = Math.cos(a), s = Math.sin(a)
        feet.push([rf * c, rf * s, -p.padHM]); tops.push([0.62 * (g.topD / 2) * c, 0.62 * (g.topD / 2) * s, zt])
      }
      for (let k = 0; k < 3; k++) tubeAlong(lm, feet[k], tops[k], rl, Math.max(12, seg >> 2))
      // 系杆：腿高 0.3 处三角一圈
      const at = (k, t) => add(feet[k], scl(sub(tops[k], feet[k]), t))
      for (let k = 0; k < 3; k++) tubeAlong(lm, at(k, 0.3), at((k + 1) % 3, 0.3), 0.45 * rl, 10)
      // 腿脚底板
      for (const f of feet) box(lm, add(f, [0, 0, -0.01]), [1.6 * rl, 1.6 * rl, 0.01])
      frustum(lm, [0, 0, zc0], g.topD / 2, [0, 0, -g.hPostTop], g.topD / 2, seg, true, false)
      const legs = put(ctx, 'post', 'boom', part, 'white_paint', lm)
      shellMass(ctx, 'post', legs, STEEL_AREAL)
    } else {
      // 基础（不计质量：土建）
      if (p.padHM > 0) { const m = new MB(); box(m, [0, 0, -p.padHM / 2], [0.75 * g.baseD, 0.75 * g.baseD, p.padHM / 2]); put(ctx, 'pad', 'other', padPart, CONCRETE, m) }
      // 立柱（固定）+ 方位轴承环
      const pm = new MB()
      frustum(pm, [0, 0, -p.padHM], g.baseD / 2, [0, 0, -g.hPostTop], g.topD / 2, seg, false, false)
      const post = put(ctx, 'post', 'boom', part, 'white_paint', pm)
      shellMass(ctx, 'post', post, STEEL_AREAL)
    }
    const bm = new MB(); frustum(bm, [0, 0, -g.hPostTop + 0.02], 0.54 * g.topD, [0, 0, -g.hPostTop - 0.06 * g.headH - 0.04], 0.54 * g.topD, seg, true, true)
    put(ctx, 'azbearing', 'boom', part, 'dark_metal', bm)
    // 方位动件：转台 + 叉臂 + 俯仰轴承座 + 方位驱动箱（节点系 = 方位关节系，原点在俯仰轴中心）
    const G = gimbalFrame('azel', [1, 0, 0], [0, 0, -1]), o = [0, 0, -g.H]
    const hm = new MB()
    frustum(hm, [0, 0, -g.hPostTop - 0.06 * g.headH - 0.04], g.headD / 2, [0, 0, -g.hHeadTop], g.headD / 2, seg, true, true)
    const head = putFramed(ctx, 'head', 'boom', part, 'white_paint', hm, G, o)
    // 叉座：转台顶面上一道横梁（U 形叉的底边，外缘齐叉臂外侧）+ 两根叉臂立在梁上（伸进梁 1 cm）；叉臂间距大于转台，没有这道梁叉臂就悬空
    const am = new MB(), zb = -g.hHeadTop - g.yokeTB
    box(am, [0, 0, -g.hHeadTop - g.yokeTB / 2], [g.armX, g.yokeW / 2 + g.armT / 2, g.yokeTB / 2])
    for (const sy of [1, -1]) {
      const y = sy * g.yokeW / 2
      prism(am, [[-g.armX, y - g.armT / 2, zb + 0.01], [g.armX, y - g.armT / 2, zb + 0.01], [g.armX, y + g.armT / 2, zb + 0.01], [-g.armX, y + g.armT / 2, zb + 0.01]],
        [[-0.55 * g.armX, y - g.armT / 2, -g.H - 0.5 * g.armX], [0.55 * g.armX, y - g.armT / 2, -g.H - 0.5 * g.armX], [0.55 * g.armX, y + g.armT / 2, -g.H - 0.5 * g.armX], [-0.55 * g.armX, y + g.armT / 2, -g.H - 0.5 * g.armX]])
    }
    const arms = putFramed(ctx, 'arms', 'boom', part, 'white_paint', am, G, o)
    const brm = new MB()
    for (const sy of [1, -1]) tubeAlong(brm, [0, sy * (g.yokeW / 2 - 0.7 * g.armT), -g.H], [0, sy * (g.yokeW / 2 + 0.7 * g.armT), -g.H], 0.42 * g.armX, 24)
    putFramed(ctx, 'bearings', 'boom', part, 'dark_metal', brm, G, o)
    const dm = new MB(); box(dm, [-g.headD / 2 - 0.12 * g.headD, 0, -(g.hPostTop + g.hHeadTop) / 2], [0.12 * g.headD, 0.18 * g.headD, 0.35 * g.headH])
    putFramed(ctx, 'drive', 'boom', part, 'dark_metal', dm, G, o)
    shellMass(ctx, 'head', head, STEEL_AREAL)
    solidComp(ctx, 'arms', arms, STEEL_SOLID)
    const [mn, mx, ini] = azStage(p.azTravelDeg)
    ctx.arts.push({ name: 'azimuth', nodes: ['head', 'arms', 'bearings', 'drive'], stages: [stage(STAGE.az, 'zRotate', mn, mx, ini)] })
    return ctx
  }
}

/** X-Y 座尺寸推算。 */
function xyGeom(p) {
  const Dd = p.dishDM, H = auto(p.xAxisHM, 0.55 * Dd + 0.5), h = auto(p.yOffsetM, 0.12 * Dd + 0.2), W = auto(p.baseWM, 0.5 * Dd + 0.6)
  const carL = 0.3 * Dd + 0.3, beam = Math.max(0.08, 0.06 * W)
  return { H, h, W, carL, beam }
}

const pedestalXY = {
  type: 'es.pedestal.xy', domain: ['ground', 'ship', 'vehicle'], title: 'X-Y pedestal', titleZh: 'X-Y 座', role: 'boom',
  params: {
    dishDM: num(4.0, 'm', '配套口径', { gt: 0, title: '座架按它推算缺省尺寸（比例为示意值）' }),
    xAxisHM: num(null, 'm', 'X 轴高', { nullable: true, gt: 0, title: '安装面到下轴（X 轴，东西向）；留空 = 0.55 × 配套口径 + 0.5 m' }),
    yOffsetM: num(null, 'm', 'Y 轴高出 X 轴', { nullable: true, min: 0, title: '上轴（Y 轴，南北向）比下轴高多少；留空 = 0.12 × 配套口径 + 0.2 m。反射面的同名参数须填同一值' }),
    baseWM: num(null, 'm', 'X 轴承间距', { nullable: true, gt: 0, title: '留空 = 0.5 × 配套口径 + 0.6 m' }),
    limitDeg: num(92, '°', '单轴限位', { gt: 0, max: 180, title: '两轴各 ±；天顶无锁孔，锁孔在 X 轴两端的地平方向' }),
    padHM: num(0.3, 'm', '基础高', { min: 0 })
  },
  validate: (p) => { const g = xyGeom(p); return g.H > p.padHM + g.beam ? [] : ['X 轴高不足'] },
  sockets: (p) => { const g = xyGeom(p); return [standSocket(g.W, 15), sock('y', [0, 0, -(g.H + g.h)], [0, 0, -1], [1, 0, 0], g.carL, 90, REFL_ACCEPTS)] },
  symmetricPlanes: ['xz', 'yz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = xyGeom(p)
    const part = { id: 'pedestal', name: 'X-Y 座', role: 'boom' }
    if (p.padHM > 0) { const m = new MB(); box(m, [0, 0, -p.padHM / 2], [0.45 * g.W, 0.7 * g.W, p.padHM / 2]); put(ctx, 'pad', 'other', { id: 'pad', name: '基础', role: 'other' }, CONCRETE, m) }
    // 两座 A 形支架（y = ±W/2）托 X 轴（沿 Y，东西向）
    const fm = new MB(), bw = 0.32 * g.W, tw = 0.08 * g.W, ft = g.beam
    for (const sy of [1, -1]) {
      const y = sy * g.W / 2
      prism(fm, [[-bw, y - ft, -p.padHM], [bw, y - ft, -p.padHM], [bw, y + ft, -p.padHM], [-bw, y + ft, -p.padHM]],
        [[-tw, y - ft, -g.H], [tw, y - ft, -g.H], [tw, y + ft, -g.H], [-tw, y + ft, -g.H]])
    }
    const frame = put(ctx, 'frame', 'boom', part, 'white_paint', fm)
    solidComp(ctx, 'frame', frame, STEEL_SOLID)
    const sm = new MB(); tubeAlong(sm, [0, -g.W / 2 - 1.5 * ft, -g.H], [0, g.W / 2 + 1.5 * ft, -g.H], 0.9 * ft, 24)
    put(ctx, 'xshaft', 'boom', part, 'dark_metal', sm)
    // X 轴动件：托架（中横梁 + 两立柱 + Y 轴承座），节点系 = X 关节系（原点在 X 轴中心）
    const G = gimbalFrame('xy', [0, 0, -1], [1, 0, 0]), o = [0, 0, -g.H]
    const cm = new MB()
    box(cm, [0, 0, -g.H], [g.carL / 2 + ft, 1.2 * ft, 1.2 * ft])
    for (const sx of [1, -1]) {
      const x = sx * g.carL / 2
      prism(cm, [[x - ft, -1.6 * ft, -g.H], [x + ft, -1.6 * ft, -g.H], [x + ft, 1.6 * ft, -g.H], [x - ft, 1.6 * ft, -g.H]],
        [[x - ft, -ft, -g.H - g.h - ft], [x + ft, -ft, -g.H - g.h - ft], [x + ft, ft, -g.H - g.h - ft], [x - ft, ft, -g.H - g.h - ft]])
      tubeAlong(cm, [x - 1.4 * ft * sx, 0, -g.H - g.h], [x + 1.4 * ft * sx, 0, -g.H - g.h], 0.8 * ft, 20)
    }
    const car = putFramed(ctx, 'carriage', 'boom', part, 'white_paint', cm, G, o)
    solidComp(ctx, 'carriage', car, STEEL_SOLID)
    ctx.arts.push({ name: 'xaxis', nodes: ['carriage'], stages: [stage(STAGE.x, 'xRotate', -p.limitDeg, p.limitDeg, 0)] })
    return ctx
  }
}

// ───────────────────────────── 地球站：反射面 ─────────────────────────────

/** 反射面共用的座架参数（关节类型、初值、行程）。 */
const GIMBAL_PARAMS = {
  gimbal: enm('azel', ['azel', 'xy', 'none'], '座架', { title: 'azel = 方位俯仰（装方位俯仰座 el 插座 / 立柱）；xy = X-Y 座（装 y 插座）；none = 固定' }),
  el0Deg: num(30, '°', '初始仰角', { min: -90, max: 180, title: 'azel：俯仰关节初值；xy：Y 轴初值；none：固定仰角（烘进几何）' }),
  azTravelDeg: num(540, '°', '方位行程', { gt: 0, max: 720, title: '须与座架同名参数一致' }),
  elMinDeg: num(0, '°', '仰角下限', { min: -90, max: 90 }),
  elMaxDeg: num(90, '°', '仰角上限', { min: -90, max: 180 }),
  xyLimitDeg: num(92, '°', 'X-Y 单轴限位', { gt: 0, max: 180 }),
  xyOffsetM: num(null, 'm', 'Y 轴高出 X 轴', { nullable: true, min: 0, title: 'xy 座架用；须与 X-Y 座同名参数一致；留空 = 0.12 × 口径 + 0.2 m' })
}
const gimbalValidate = (p) => (p.elMinDeg <= p.elMaxDeg ? [] : ['仰角下限大于上限'])

/**
 * 反射面组件的收尾：按座架类型把动件换到关节节点系、登记关节；none 把固定仰角烘进几何。
 * parts = [{name, role, part, mat, mb, mass?:{kind:'shell'|'solid', v}}]（组件局部系，零位视轴 +X）；azOnly 同形（只随方位转）。
 * 挂点 boresight：原点、dir = 零位视轴、up = 方位轴（none 时随固定仰角转）。
 */
function finishGimbal(ctx, p, D, parts, azOnly = []) {
  const kind = p.gimbal, dir0 = [1, 0, 0], up0 = [0, 0, -1]
  const regMass = (it, s) => { if (!it || !s.mass) return; if (s.mass.kind === 'shell') shellMass(ctx, s.name, it, s.mass.v); else if (s.mass.kind === 'solid') solidComp(ctx, s.name, it, s.mass.v); else if (s.mass.kind === 'point') comp(ctx, s.name, 'point', s.mass.v, s.mass.com, [0, 0, 0, 0, 0, 0, 0, 0, 0]) }
  if (kind === 'none') {
    const t = p.el0Deg * D2R, R = [[Math.cos(t), 0, -Math.sin(t)], [0, 1, 0], [Math.sin(t), 0, Math.cos(t)]]   // 绕 +Y 转 el0：视轴 +X 抬向 −Z
    // 固定件（方位抱箍）不随仰角转，其余绕俯仰轴转 el0；点质量的质心随网格一起转（壳 / 实体质量元由转过的网格现算）
    for (const s of [...parts, ...azOnly]) {
      if (!s.fixed) xform(s.mb, 0, R, [0, 0, 0])
      const sm = !s.fixed && s.mass && s.mass.kind === 'point' ? { ...s, mass: { ...s.mass, com: rApply(R, s.mass.com) } } : s
      regMass(put(ctx, s.name, s.role, s.part, s.mat, s.mb), sm)
    }
    apLocal(ctx, 'boresight', [0, 0, 0], rApply(R, dir0), rApply(R, up0))
    return
  }
  if (kind === 'xy') {
    const h = auto(p.xyOffsetM, 0.12 * D + 0.2), G = gimbalFrame('xy', dir0, up0), o = [-h, 0, 0]
    for (const s of parts) regMass(putFramed(ctx, s.name, s.role, s.part, s.mat, s.mb, G, o), s)
    const L = p.xyLimitDeg, st = [stage(STAGE.x, 'xRotate', -L, L, 0)]
    if (h > 0) st.push(stage('yOffsetDown', 'zTranslate', -h, -h, -h))
    st.push(stage(STAGE.y, 'yRotate', -L, L, p.el0Deg))
    if (h > 0) st.push(stage('yOffsetUp', 'zTranslate', h, h, h))
    ctx.arts.push({ name: 'gimbal', nodes: parts.filter((s) => s.mb.tcount).map((s) => s.name), stages: st })
    for (const s of azOnly) regMass(put(ctx, s.name, s.role, s.part, s.mat, s.mb), s)
  } else {
    const G = gimbalFrame('azel', dir0, up0), o = [0, 0, 0]
    for (const s of parts) regMass(putFramed(ctx, s.name, s.role, s.part, s.mat, s.mb, G, o), s)
    const [mn, mx, ini] = azStage(p.azTravelDeg)
    ctx.arts.push({ name: 'gimbal', nodes: parts.filter((s) => s.mb.tcount).map((s) => s.name), stages: [stage(STAGE.az, 'zRotate', mn, mx, ini), stage(STAGE.el, 'xRotate', p.elMinDeg, p.elMaxDeg, p.el0Deg)] })
    const az = azOnly.filter((s) => s.mb.tcount)
    for (const s of az) regMass(putFramed(ctx, s.name, s.role, s.part, s.mat, s.mb, G, o), s)
    if (az.length) ctx.arts.push({ name: 'azimuth', nodes: az.map((s) => s.name), stages: [stage(STAGE.az, 'zRotate', mn, mx, ini)] })
  }
  apLocal(ctx, 'boresight', [0, 0, 0], dir0, up0)
}

/** 背架肋数：留空按口径推算（< 3 m 8 根、< 8 m 16 根、其余 24 根）。 */
const ribCount = (p) => (Number.isInteger(p.ribs) ? p.ribs : (p.diameterM < 3 ? 8 : p.diameterM < 8 ? 16 : 24))
/**
 * 轴对称反射面（主焦 / 卡塞格伦）关于 xy 面（俯仰面）是否对称：肋在 φ = 2π(k + ½)/n，xy 镜像把 φ 换成 π − φ，
 * 只有 n 为偶数时肋的集合不变；固定座架（gimbal none）把仰角烘进几何（绕 +Y 转），视轴离开 xy 面也就不对称了。
 * xz 面恒对称（肋、撑杆、配重、耳轴都关于 y 取反成对；绕 +Y 转不改变这一点）。
 */
const axiXY = (p) => p.gimbal !== 'none' && ribCount(p) % 2 === 0

/**
 * 轴对称反射面的公共几何（主焦 / 卡塞格伦）：零位视轴 +X，顶点在原点前 vo 处。
 * reach0 = 该类反射面「顶点前伸为 0 时的最前点」函数（cassReach0 / primeReach0）：给了 reachM 就 vo = reachM − reach0(p)。
 */
function axiLayout(p, reach0 = null) {
  const D = p.diameterM, R = D / 2, f = p.fD * D
  const vo = isNum(p.reachM) && reach0 ? p.reachM - reach0(p) : auto(p.vertexOffsetM, 0.1 * D + 0.15)
  const L = { V: [vo, 0, 0], a: [1, 0, 0], e1: [0, 0, -1], e2: [0, 1, 0], f }
  const hubR = auto(p.hubDM, 0.2 * D) / 2
  const th = 0.004 * D + 0.01
  const nRibs = ribCount(p)
  const depth0 = 0.06 * D + 0.05, ribT = Math.max(0.012, 0.004 * D)
  const nphi = D < 3 ? 48 : 64
  return { D, R, f, vo, L, hubR, th, nRibs, depth0, ribT, nphi }
}

/** 背架 + 中心筒 + 俯仰耳轴（主焦 / 卡塞格伦共用）。 */
function axiBackstructure(p, g) {
  const bf = new MB()
  dishBackframe(bf, g.L, g.R, g.hubR, g.th, g.nRibs, g.depth0, g.ribT)
  // 中心筒：从背架深处到背面顶点之后（不穿出碟面）
  const hub = new MB(), hubDepth = g.depth0 + 0.1 * g.D
  frustum(hub, [g.vo - hubDepth, 0, 0], g.hubR, [g.vo - g.th, 0, 0], g.hubR, g.nphi, true, true)
  // 耳轴：沿俯仰轴（azel / none：±Y；xy：上下）过原点，长度 = 座架缺省轴承间距（0.3 × 口径 + 0.4 m），两端斜撑到中心筒后沿
  const tr = new MB(), axis = p.gimbal === 'xy' ? [0, 0, 1] : [0, 1, 0], w = 0.3 * g.D + 0.45, rr = Math.max(0.03, 0.012 * g.D)
  tubeAlong(tr, scl(axis, -w / 2), scl(axis, w / 2), rr, 20)
  const perp = cross([1, 0, 0], axis)
  for (const s of [1, -1]) for (const q of [1, -1]) tubeAlong(tr, scl(axis, s * w / 2), add([g.vo - hubDepth, 0, 0], add(scl(axis, s * 0.8 * g.hubR), scl(perp, q * 0.6 * g.hubR))), 0.7 * rr, 10)
  return { bf, hub, tr }
}

const ESTR = (D) => Math.max(0.02, 0.006 * D + 0.01)   // 撑杆管半径（示意）

/** 两点间管（tubeAlong / meshKit.tube 同式：两端环顶点 p ± q·r，q 取 perpPair(d) 的 seg 等分）沿 +X 的最大坐标。 */
function tubeMaxX(p0, p1, r, seg) {
  const d = nrm(sub(p1, p0)), [e1, e2] = perpPair(d)
  let q = -Infinity
  for (let j = 0; j <= seg; j++) { const th = (2 * Math.PI * j) / seg; q = Math.max(q, e1[0] * Math.cos(th) + e2[0] * Math.sin(th)) }
  return Math.max(p0[0], p1[0]) + r * q
}
/** 口径面坐标 (x1, x2) 处母抛物面点，顶点在原点（axiLayout 的 e1 = −Z、e2 = +Y、轴 +X）。 */
const paraRel = (f, x1, x2) => [(x1 * x1 + x2 * x2) / (4 * f), x2, -x1]
/**
 * 卡塞格伦「顶点前伸为 0」时沿视轴的最前点（与 build 同一组变量逐件取最大）：主面口沿、副面支承毂顶面、四脚撑杆两端的管口、
 * 馈源锥口面。仰角 90° 时 = 总高 − 俯仰轴高 − 顶点前伸；reachM 由它反推顶点前伸。p 须已补缺省。
 */
export function cassReach0(p) {
  const D = p.diameterM, R = D / 2, f = p.fD * D, Ds = auto(p.subDM, 0.1 * D), cl = cassLayout(D, f, Ds, p.subHM)
  const sth = 0.02 * Ds + 0.01, zb = cl.zOf(cl.rS) + sth, tgt = [zb + 0.1 * Ds, 0, 0]
  let m = Math.max(R * R / (4 * f), zb + 0.12 * Ds, Math.max(cl.zF2, 0.02 * D))
  for (let k = 0; k < 4; k++) { const ph = Math.PI / 4 + (Math.PI / 2) * k; m = Math.max(m, tubeMaxX(paraRel(f, 0.72 * R * Math.cos(ph), 0.72 * R * Math.sin(ph)), tgt, ESTR(D), 10)) }
  return m
}
/** 主焦反射面「顶点前伸为 0」时沿视轴的最前点：主面口沿、馈源舱前端、撑杆两端的管口（无馈源时只有口沿）。p 须已补缺省。 */
export function primeReach0(p) {
  const D = p.diameterM, R = D / 2, f = p.fD * D
  let m = R * R / (4 * f)
  if (p.feed) {
    const fa = auto(p.feedDM, 0.035 * D + 0.05), hl = 1.2 * fa, tgt = [f + hl + 0.5 * fa, 0, 0], n = p.struts
    m = Math.max(m, f + hl + fa)
    for (let k = 0; k < n; k++) { const ph = (2 * Math.PI * k) / n + (n === 4 ? Math.PI / 4 : 0); m = Math.max(m, tubeMaxX(paraRel(f, 0.96 * R * Math.cos(ph), 0.96 * R * Math.sin(ph)), tgt, ESTR(D), 10)) }
  }
  return m
}
/** reachM 与顶点前伸的约束（两者只能给一个；反推的顶点前伸不得为负）。 */
function reachValidate(p, reach0) {
  if (!isNum(p.reachM)) return []
  if (isNum(p.vertexOffsetM)) return ['顶点前伸与最前点距离只能给一个']
  return p.reachM - reach0(p) >= 0 ? [] : ['最前点距离过小']
}
const REACH_PARAM = () => num(null, 'm', '最前点距离', { nullable: true, gt: 0, title: '俯仰轴到最前点（沿视轴）；仰角 90° 时 = 总高 − 俯仰轴高；给了就反推顶点前伸' })

const reflPrime = {
  type: 'es.refl.prime', domain: ['ground', 'ship', 'vehicle'], title: 'Prime-focus reflector', titleZh: '主焦反射面', role: 'reflector',
  params: {
    diameterM: num(3.7, 'm', '口径', { gt: 0 }),
    fD: num(0.38, '', '焦径比', { gt: 0.2, max: 2 }),
    struts: int(4, '撑杆数', { options: [3, 4] }),
    feed: bool(true, '自带馈源'),
    feedDM: num(null, 'm', '馈源口径', { nullable: true, gt: 0, title: '留空 = 0.035 × 口径 + 0.05 m' }),
    hubDM: num(null, 'm', '中心筒直径', { nullable: true, gt: 0, title: '留空 = 0.2 × 口径' }),
    vertexOffsetM: num(null, 'm', '顶点前伸', { nullable: true, min: 0, title: '俯仰轴到抛物面顶点（沿视轴）；留空 = 0.1 × 口径 + 0.15 m' }),
    ribs: int(null, '背架肋数', { nullable: true, min: 4, max: 64 }),
    ...GIMBAL_PARAMS,
    reachM: REACH_PARAM()
  },
  validate: (p) => [...gimbalValidate(p), ...(auto(p.hubDM, 0.2 * p.diameterM) < 0.8 * p.diameterM ? [] : ['中心筒直径过大']), ...reachValidate(p, primeReach0)],
  mountSocket: 'root',
  sockets: (p) => { const g = axiLayout(p, primeReach0); return [sock('root', [0, 0, 0], [-1, 0, 0], [0, 0, -1], Math.max(0.2, 0.26 * g.D), 90), sock('focus', [g.vo + g.f, 0, 0], [1, 0, 0], [0, 0, -1], auto(p.feedDM, 0.035 * g.D + 0.05), 15, Object.freeze(['es.feed', 'es.subrefl', 'prim.']))] },
  // 三根撑杆（φ = 0、±120°）只关于 xz 面对称；不带馈源时没有撑杆
  symmetricPlanes: (p) => ((!p.feed || p.struts === 4) && axiXY(p) ? ['xz', 'xy'] : ['xz']),
  build(p, kit) {
    const ctx = kit.createCtx(), g = axiLayout(p, primeReach0)
    const refl = { id: 'reflector', name: '主反射面', role: 'reflector' }, feedPart = { id: 'feed', name: '馈源', role: 'feed' }
    const sh = dishShell(g.L, 0, 0, g.R, g.th, 16, g.nphi)
    const { bf, hub, tr } = axiBackstructure(p, g)
    const F = [g.vo + g.f, 0, 0], fa = auto(p.feedDM, 0.035 * g.D + 0.05)
    // 馈源（喇叭口面在焦点、朝顶点）+ 馈源舱 + 撑杆（口沿 0.96R 处背面 → 馈源舱后）
    const fm = new MB(), st = new MB()
    if (p.feed) {
      const hl = 1.2 * fa
      frustum(fm, [F[0] + hl, 0, 0], 0.35 * fa, F, fa / 2, 24, true, false)
      annulus(fm, F, [-1, 0, 0], 0.46 * fa, fa / 2, 24, [-1, 0, 0])
      box(fm, [F[0] + hl + 0.5 * fa, 0, 0], [0.5 * fa, 0.6 * fa, 0.6 * fa])
      const tgt = [F[0] + hl + 0.5 * fa, 0, 0], n = p.struts, pts = []
      for (let k = 0; k < n; k++) {
        const ph = (2 * Math.PI * k) / n + (n === 4 ? Math.PI / 4 : 0), x1 = 0.96 * g.R * Math.cos(ph), x2 = 0.96 * g.R * Math.sin(ph)
        pts.push(paraP(g.L, x1, x2))
      }
      struts(st, g.L, pts, tgt, ESTR(g.D))
    }
    const areal = dishDensity(g.D)
    const parts = [
      { name: 'surface', role: 'reflector', part: refl, mat: 'reflector', mb: sh.front, mass: { kind: 'shell', v: areal } },
      { name: 'back', role: 'reflector', part: refl, mat: 'white_paint', mb: sh.back },
      { name: 'rim', role: 'reflector', part: refl, mat: 'white_paint', mb: sh.rim },
      { name: 'backframe', role: 'boom', part: refl, mat: 'white_paint', mb: bf },
      { name: 'hub', role: 'reflector', part: refl, mat: 'white_paint', mb: hub },
      { name: 'trunnion', role: 'boom', part: refl, mat: 'dark_metal', mb: tr },
      { name: 'feed', role: 'feed', part: feedPart, mat: 'aluminum', mb: fm, mass: { kind: 'point', v: 0.02 * areal * Math.PI * g.R * g.R, com: F } },
      { name: 'struts', role: 'boom', part: feedPart, mat: 'white_paint', mb: st }
    ]
    finishGimbal(ctx, p, g.D, parts)
    if (p.gimbal !== 'none') ctx.parts.get('reflector').normalBody = [1, 0, 0]
    return ctx
  }
}

/**
 * 卡塞格伦副面：母抛物面焦点 F1 = f，馈源相位中心 F2 = zF2（都在轴上，距主顶点）。副面口沿落在「F1 → 主口沿」连线上、
 * 半径 Ds/2；双曲面 |P − F2| − |P − F1| = 2a。给了副面高度（副面顶点距主顶点）就按它二分反求 zF2。
 * @returns {{a, b, c, zc, zF2, zV, zEdge, rS, zOf(r)}}（z 沿视轴、自主顶点起算）
 */
export function cassLayout(D, f, Ds, subH) {
  const R = D / 2, rS = Ds / 2
  const th0 = Math.atan2(R, f - R * R / (4 * f))            // F1 看主口沿与 −轴的夹角
  const rho1 = rS / Math.sin(th0), zEdge = f - rho1 * Math.cos(th0)
  const solve = (zF2) => {
    const c = (f - zF2) / 2, zc = (f + zF2) / 2
    const a = (Math.hypot(rS, zEdge - zF2) - Math.hypot(rS, zEdge - f)) / 2
    return { a, c, zc, zV: zc + a }
  }
  let zF2
  if (isNum(subH)) {
    // zV 随 zF2 单调：二分 zF2 ∈ (−f, zEdge)
    let lo = -f, hi = zEdge - 1e-6 * f
    for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (solve(mid).zV > subH) hi = mid; else lo = mid }
    zF2 = (lo + hi) / 2
  } else zF2 = 0.1 * f
  const s = solve(zF2), b = Math.sqrt(Math.max(1e-12, s.c * s.c - s.a * s.a))
  return { ...s, b, zF2, zEdge, rS, th0, zOf: (r) => s.zc + s.a * Math.sqrt(1 + (r * r) / (b * b)) }
}

const reflCass = {
  type: 'es.refl.cass', domain: ['ground', 'ship'], title: 'Cassegrain reflector', titleZh: '卡塞格伦反射面', role: 'reflector',
  params: {
    diameterM: num(7.3, 'm', '口径', { gt: 0 }),
    fD: num(0.35, '', '焦径比', { gt: 0.2, max: 1.5 }),
    subDM: num(null, 'm', '副面直径', { nullable: true, gt: 0, title: '留空 = 0.1 × 口径' }),
    subHM: num(null, 'm', '副面高度', { nullable: true, gt: 0, title: '副面顶点距主面顶点（沿视轴）；留空 = 馈源相位中心取 0.1 × 焦距反推' }),
    feedDM: num(null, 'm', '馈源口径', { nullable: true, gt: 0, title: '留空 = 0.03 × 口径 + 0.05 m' }),
    hubDM: num(null, 'm', '中心舱直径', { nullable: true, gt: 0, title: '留空 = 0.2 × 口径' }),
    vertexOffsetM: num(null, 'm', '顶点前伸', { nullable: true, min: 0, title: '俯仰轴到主面顶点（沿视轴）；留空 = 0.1 × 口径 + 0.15 m' }),
    ribs: int(null, '背架肋数', { nullable: true, min: 4, max: 64 }),
    ...GIMBAL_PARAMS,
    reachM: REACH_PARAM(),
    counterweight: bool(false, '配重', { title: '碟背下方箱形配重（随俯仰转）：质量 = 0.15 × 主反射面质量（示意）' })
  },
  validate: (p) => {
    const e = gimbalValidate(p), D = p.diameterM, f = p.fD * D, Ds = auto(p.subDM, 0.1 * D)
    if (!(Ds < 0.5 * D)) e.push('副面直径过大')
    else {
      const c = cassLayout(D, f, Ds, p.subHM)
      if (!(c.a > 0 && c.zF2 < c.zV && c.zV < f)) e.push('副面高度与副面直径不成双曲面')
      else e.push(...reachValidate(p, cassReach0))
    }
    return e
  },
  mountSocket: 'root',
  sockets: (p) => [sock('root', [0, 0, 0], [-1, 0, 0], [0, 0, -1], Math.max(0.2, 0.26 * p.diameterM), 90)],
  // 配重在视轴下方（+Z 侧），只关于 xz 面对称
  symmetricPlanes: (p) => (!p.counterweight && axiXY(p) ? ['xz', 'xy'] : ['xz']),
  build(p, kit) {
    const ctx = kit.createCtx(), g = axiLayout(p, cassReach0)
    const refl = { id: 'reflector', name: '主反射面', role: 'reflector' }, subPart = { id: 'subreflector', name: '副反射面', role: 'reflector' }, feedPart = { id: 'feed', name: '馈源', role: 'feed' }
    const Ds = auto(p.subDM, 0.1 * g.D), cl = cassLayout(g.D, g.f, Ds, p.subHM), fa = auto(p.feedDM, 0.03 * g.D + 0.05)
    const coneR0 = Math.min(0.8 * g.hubR, Math.max(1.2 * fa, 0.35 * g.hubR))
    const sh = dishShell(g.L, 0, coneR0, g.R, g.th, 16, g.nphi)
    const { bf, hub, tr } = axiBackstructure(p, g)
    // 副面（凸面朝主面）：z_s(r)，背面平板 + 支承毂
    const sub_ = new MB(), rs = [], nr = 8, sphi = 48
    for (let i = 0; i <= nr; i++) rs.push(cl.rS * Math.sqrt(i / nr))
    const sring = (r, dz) => { const row = []; for (let j = 0; j < sphi; j++) { const ph = (2 * Math.PI * j) / sphi; row.push([g.vo + cl.zOf(r) + dz, r * Math.sin(ph), -r * Math.cos(ph)]) } return row }
    grid(sub_, rs.map((r) => sring(r, 0)), { wrap: true, out: [-1, 0, 0] })
    const sback = new MB(), sth = 0.02 * Ds + 0.01, zb = g.vo + cl.zOf(cl.rS) + sth
    grid(sback, [sring(cl.rS, 0), sring(cl.rS, sth)], { wrap: true, out: (c) => [0, c[1], c[2]] })
    cap(sback, sring(cl.rS, sth), [1, 0, 0])
    frustum(sback, [zb, 0, 0], 0.18 * Ds, [zb + 0.12 * Ds, 0, 0], 0.12 * Ds, 24, false, true)
    // 馈源锥（中心开孔处伸出，口面在 F2）+ 口面
    const fc = new MB(), zF = g.vo + Math.max(cl.zF2, 0.02 * g.D)
    frustum(fc, [g.vo - 0.02 * g.D, 0, 0], coneR0, [zF, 0, 0], 0.62 * fa, 32, false, false)
    annulus(fc, [zF, 0, 0], [1, 0, 0], 0.5 * fa, 0.62 * fa, 32, [1, 0, 0])
    const fap = new MB(); frustum(fap, [zF - 0.6 * fa, 0, 0], 0.2 * fa, [zF, 0, 0], 0.5 * fa, 32, true, false, true)
    // 四脚撑杆：主面 0.72R 处 → 副面支承毂
    const qd = new MB(), pts = []
    for (let k = 0; k < 4; k++) { const ph = Math.PI / 4 + (Math.PI / 2) * k; pts.push(paraP(g.L, 0.72 * g.R * Math.cos(ph), 0.72 * g.R * Math.sin(ph))) }
    struts(qd, g.L, pts, [zb + 0.1 * Ds, 0, 0], ESTR(g.D))
    const areal = dishDensity(g.D)
    const parts = [
      { name: 'surface', role: 'reflector', part: refl, mat: 'reflector', mb: sh.front, mass: { kind: 'shell', v: areal } },
      { name: 'back', role: 'reflector', part: refl, mat: 'white_paint', mb: sh.back },
      { name: 'rim', role: 'reflector', part: refl, mat: 'white_paint', mb: sh.rim },
      { name: 'backframe', role: 'boom', part: refl, mat: 'white_paint', mb: bf },
      { name: 'hub', role: 'reflector', part: refl, mat: 'white_paint', mb: hub },
      { name: 'trunnion', role: 'boom', part: refl, mat: 'dark_metal', mb: tr },
      { name: 'subreflector', role: 'reflector', part: subPart, mat: 'reflector', mb: sub_, mass: { kind: 'shell', v: 2 * areal } },
      { name: 'subback', role: 'reflector', part: subPart, mat: 'white_paint', mb: sback },
      { name: 'quadripod', role: 'boom', part: subPart, mat: 'white_paint', mb: qd },
      { name: 'feedcone', role: 'feed', part: feedPart, mat: 'white_paint', mb: fc, mass: { kind: 'point', v: 0.03 * areal * Math.PI * g.R * g.R, com: [zF - 0.3 * g.D, 0, 0] } },
      { name: 'feedaperture', role: 'feed', part: feedPart, mat: 'dark_metal', mb: fap }
    ]
    if (p.counterweight) {
      // 配重：中心舱背后、视轴下方（仰角 0° 时在俯仰轴下方）的两块箱体，分列 ±Y、中间留出方位轴上的波束波导通道；
      // 每块两根撑臂接中心舱后沿。质量 = 0.15 × 主面壳质量（旋转抛物面面积闭式）
      const hubDepth = g.depth0 + 0.1 * g.D, xh = g.vo - hubDepth
      const hc = [0.05 * g.D, 0.035 * g.D, 0.045 * g.D], cx = xh - 0.06 * g.D, cz = 0.13 * g.D, cy = 0.09 * g.D
      const cwm = new MB(), arm = new MB(), ra = Math.max(0.03, 0.008 * g.D)
      for (const sy of [1, -1]) {
        box(cwm, [cx, sy * cy, cz], hc)
        tubeAlong(arm, [xh + 0.02 * g.D, sy * 0.6 * g.hubR, 0.4 * g.hubR], [cx + 0.5 * hc[0], sy * cy, cz - hc[2]], ra, 12)
        tubeAlong(arm, [xh + 0.02 * g.D, sy * 0.6 * g.hubR, -0.2 * g.hubR], [cx - 0.5 * hc[0], sy * cy, cz - hc[2]], ra, 12)
      }
      const Ap = (r) => (8 * Math.PI * g.f * g.f / 3) * ((1 + r * r / (4 * g.f * g.f)) ** 1.5 - 1)
      const mcw = 0.15 * areal * (Ap(g.R) - Ap(coneR0))
      parts.push({ name: 'counterweight', role: 'other', part: refl, mat: 'white_paint', mb: cwm, mass: { kind: 'solid', v: mcw / (16 * hc[0] * hc[1] * hc[2]) } })
      parts.push({ name: 'cwarms', role: 'boom', part: refl, mat: 'white_paint', mb: arm })
    }
    finishGimbal(ctx, p, g.D, parts)
    if (p.gimbal !== 'none') { ctx.parts.get('reflector').normalBody = [1, 0, 0]; ctx.parts.get('subreflector').normalBody = [-1, 0, 0] }
    return ctx
  }
}

/**
 * 偏馈几何（口面投影为圆、直径 D；母抛物面轴 = 射频轴 = 零位视轴 +X；偏置方向朝上 −Z）。
 * 偏置角 χ：口沿平面法向与射频轴的夹角（口面竖直时波束仰起 χ）——tan χ = dc / 2f。
 * f/D 留空按 0.25 / tan χ + 0.03（口径下缘恰好让开母轴，示意）。安装点在口面中心背后 bo。
 */
function offsetLayout(p) {
  const D = p.diameterM, R = D / 2, chi = p.offsetDeg * D2R
  const fD = auto(p.fD, 0.25 / Math.tan(chi) + 0.03), f = fD * D, dc = 2 * f * Math.tan(chi)
  const a = [1, 0, 0], u = [0, 0, -1], e2 = cross(a, u)
  const PcRel = add(scl(u, dc), scl(a, dc * dc / (4 * f)))
  const ncv = nrm(sub(a, scl(u, dc / (2 * f))))
  const bo = auto(p.backOffsetM, 0.1 * D + 0.08)
  // 使安装点（俯仰转轴）落在原点；pivotDropM > 0 时转轴再沿口面「向下缘」方向（−tUp，tUp = 偏置方向在口面内的投影）移开
  const pd = isNum(p.pivotDropM) ? p.pivotDropM : 0
  const V = pd > 0 ? scl(sub(sub(PcRel, scl(ncv, bo)), scl(nrm(reject(u, ncv)), pd)), -1) : scl(sub(PcRel, scl(ncv, bo)), -1)
  const L = { V, a, e1: u, e2, f }
  return { D, R, f, dc, chi, L, Pc: add(V, PcRel), nc: ncv, bo, F: add(V, scl(a, f)), th: 0.004 * D + 0.004 }
}

/** 插座上向：pref 去掉沿 n 的分量后归一；与 n 近平行时改用 alt（插座 up 须 ⟂ n）。 */
const perpUp = (n, pref, alt) => { const r = reject(pref, n); return len(r) > 1e-6 ? nrm(r) : nrm(reject(alt, n)) }

const reflOffset = {
  type: 'es.refl.offset', domain: ['ground', 'ship', 'vehicle'], title: 'Offset-fed reflector (VSAT)', titleZh: '偏馈反射面', role: 'reflector',
  params: {
    diameterM: num(1.2, 'm', '口径', { gt: 0, title: '口面在射频轴法平面上的投影直径（有效口径）' }),
    offsetDeg: num(20, '°', '偏置角', { gt: 0, max: 60, title: '口面竖直时波束仰起的角度（口沿平面法向与射频轴的夹角）' }),
    fD: num(null, '', '焦径比', { nullable: true, gt: 0.2, max: 2, title: '母抛物面焦距 / 有效口径；留空 = 0.25 / tan(偏置角) + 0.03' }),
    feedArm: enm('auto', ['auto', 'boom', 'tripod'], '馈源支撑', { title: 'auto：口径 ≥ 1.8 m 用三杆' }),
    feedDM: num(null, 'm', '馈源口径', { nullable: true, gt: 0, title: '留空 = 0.06 × 口径 + 0.03 m' }),
    backOffsetM: num(null, 'm', '安装点后移', { nullable: true, min: 0, title: '俯仰转轴在口面中心背后多远；留空 = 0.1 × 口径 + 0.08 m' }),
    mastDM: num(0.076, 'm', '立柱直径', { gt: 0, title: '方位抱箍按它开孔' }),
    ...GIMBAL_PARAMS,
    seams: int(0, '瓣缝', { options: [0, 2, 4], title: '分瓣反射面凹面上的拼缝细肋：2 = 左右两瓣（一条竖缝），4 = 四瓣（十字缝）' }),
    collar: bool(true, '方位抱箍', { title: '套在立柱顶、只随方位转；车顶展开座等无立柱的安装关掉' }),
    pivotDropM: num(0, 'm', '转轴下移', { min: 0, title: '俯仰转轴沿口面朝下缘方向离开口面中心的距离（再叠加安装点后移）；车顶展开天线的转轴在口径下缘，约 0.5 × 口径' })
  },
  validate: (p) => [...gimbalValidate(p), ...(p.pivotDropM <= 0.6 * p.diameterM ? [] : ['转轴下移过大'])],
  mountSocket: 'root',
  sockets: (p) => { const g = offsetLayout(p); return [sock('root', [0, 0, 0], [-1, 0, 0], [0, 0, -1], Math.max(0.1, 2 * p.mastDM), 90), sock('focus', g.F, nrm(sub(g.F, g.Pc)), perpUp(nrm(sub(g.F, g.Pc)), [1, 0, 0], [0, 0, -1]), auto(p.feedDM, 0.06 * g.D + 0.03), 15, Object.freeze(['es.feed', 'prim.']))] },
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = offsetLayout(p)
    const refl = { id: 'reflector', name: '偏馈反射面', role: 'reflector' }, feedPart = { id: 'feed', name: '馈源', role: 'feed' }, mount = { id: 'mount', name: '方位俯仰支架', role: 'boom' }
    const sh = dishShell(g.L, g.dc, 0, g.R, g.th, 12, 56)
    // 背面加强框：口面中心背后一块托板 + 四根斜撑到俯仰转轴
    const bk = new MB(), pc = sub(g.Pc, scl(g.nc, g.th)), s = 0.16 * g.D
    const ex = nrm(cross(g.nc, [0, 1, 0])), ey = [0, 1, 0]
    box(bk, [0, 0, 0], [0.3 * s, 0.25 * s, 0.25 * s])
    const plate = sub(pc, scl(g.nc, 0.02))
    for (const sx of [1, -1]) for (const sy of [1, -1]) tubeAlong(bk, add(plate, add(scl(ex, sx * s), scl(ey, sy * s))), [0, sy * 0.2 * s, 0], 0.012 + 0.006 * g.D, 10)
    const tr = new MB(); tubeAlong(tr, [0, -0.35 * s, 0], [0, 0.35 * s, 0], 0.02 + 0.01 * g.D, 16)
    // 馈源臂：口径下缘（离母轴最近处）→ 馈源；三杆时再加两侧
    const fa = auto(p.feedDM, 0.06 * g.D + 0.03), arm = new MB(), F = g.F, dirF = nrm(sub(g.Pc, F))
    const rimAt = (ph) => sub(paraP(g.L, g.dc + g.R * Math.cos(ph), g.R * Math.sin(ph)), scl(paraN(g.L, g.dc + g.R * Math.cos(ph), g.R * Math.sin(ph)), 2 * g.th))
    const tripod = p.feedArm === 'tripod' || (p.feedArm === 'auto' && g.D >= 1.8)
    const fb = sub(F, scl(dirF, 1.5 * fa))
    for (const ph of tripod ? [Math.PI, Math.PI * 0.62, -Math.PI * 0.62] : [Math.PI]) tubeAlong(arm, rimAt(ph), fb, 0.012 + 0.008 * g.D, 10)
    // 馈源：喇叭（口面在焦点、朝口面中心）+ 高频头 / 功放盒
    const fm = new MB()
    frustum(fm, sub(F, scl(dirF, 1.1 * fa)), 0.3 * fa, F, fa / 2, 20, true, false)
    annulus(fm, F, dirF, 0.44 * fa, fa / 2, 20, dirF)
    const bx = sub(F, scl(dirF, 1.6 * fa))
    box(fm, bx, [0.45 * fa, 0.45 * fa, 0.45 * fa])
    // 方位抱箍（只随方位转）：套在立柱顶，向下 0.2 m
    const col = new MB(), rc = p.mastDM / 2 + 0.012
    if (p.collar) {
      frustum(col, [0, 0, 0.02], rc, [0, 0, 0.02 + 0.2 + 0.1 * g.D], rc, 24, true, true)
      box(col, [0, 0, 0], [0.8 * rc, 0.35 * s + 0.02, 0.6 * rc])
    }
    const areal = dishDensity(g.D)
    const parts = [
      { name: 'surface', role: 'reflector', part: refl, mat: 'reflector', mb: sh.front, mass: { kind: 'shell', v: areal } },
      { name: 'back', role: 'reflector', part: refl, mat: 'white_paint', mb: sh.back },
      { name: 'rim', role: 'reflector', part: refl, mat: 'white_paint', mb: sh.rim },
      { name: 'backframe', role: 'boom', part: mount, mat: 'aluminum', mb: bk, mass: { kind: 'point', v: 0.25 * areal * Math.PI * g.R * g.R, com: [0, 0, 0] } },
      { name: 'trunnion', role: 'boom', part: mount, mat: 'dark_metal', mb: tr },
      { name: 'feedarm', role: 'boom', part: feedPart, mat: 'aluminum', mb: arm },
      { name: 'feed', role: 'feed', part: feedPart, mat: 'white_paint', mb: fm, mass: { kind: 'point', v: 1.5 + 0.8 * g.D, com: F } }
    ]
    if (p.seams) {
      // 瓣缝：沿口径面径向（φ = 2πk/n，φ = 0 为偏置方向 = 上）从口面中心到口沿的一串短管，半埋在凹面上
      const sm = new MB(), rr = 0.003 + 0.0015 * g.D, nseg = 14
      for (let k = 0; k < p.seams; k++) {
        const ph = (2 * Math.PI * k) / p.seams, pts = []
        for (let i = 0; i <= nseg; i++) {
          const r = 0.985 * g.R * (i / nseg), x1 = g.dc + r * Math.cos(ph), x2 = r * Math.sin(ph)
          pts.push(add(paraP(g.L, x1, x2), scl(paraN(g.L, x1, x2), 0.4 * rr)))
        }
        for (let i = 0; i < nseg; i++) tubeAlong(sm, pts[i], pts[i + 1], rr, 6)
      }
      parts.push({ name: 'seams', role: 'reflector', part: refl, mat: 'white_paint', mb: sm })
    }
    finishGimbal(ctx, p, g.D, parts, p.collar ? [{ name: 'collar', role: 'boom', part: mount, mat: 'dark_metal', mb: col, fixed: true }] : [])
    if (p.gimbal !== 'none') ctx.parts.get('reflector').normalBody = [1, 0, 0]
    return ctx
  }
}

// ───────────────────────────── 地球站：副面 / 馈源（固定天线手搭用） ─────────────────────────────

const subrefl = {
  type: 'es.subrefl', domain: ['ground', 'ship', 'vehicle'], title: 'Subreflector', titleZh: '副反射面', role: 'reflector',
  params: {
    diameterM: num(0.7, 'm', '直径', { gt: 0 }),
    sagM: num(null, 'm', '凸起高', { nullable: true, min: 0, title: '凸面顶点到口沿平面；留空 = 0.12 × 直径' }),
    legs: int(0, '支腿数', { options: [0, 3, 4], title: '0 = 由父件托着；3 / 4 = 自带撑腿（长 = 支腿长）' }),
    legLenM: num(1.0, 'm', '支腿长', { gt: 0 })
  },
  // 凸面顶点朝 −X（朝主面）；mount = 顶点，n = −X
  sockets: (p) => [sock('root', [0, 0, 0], [-1, 0, 0], [0, 0, -1], p.diameterM, 15)],
  // 支腿相位 φ = 2πk/n（四腿再转 45°）：三腿时一条朝上（φ = 0 → −Z）、另两条在 ±120°，关于 xz 面对称；四腿两面都对称
  symmetricPlanes: (p) => (p.legs === 3 ? ['xz'] : ['xz', 'xy']),
  build(p, kit) {
    const ctx = kit.createCtx(), R = p.diameterM / 2, sag = auto(p.sagM, 0.12 * p.diameterM), part = { id: 'subreflector', name: '副反射面', role: 'reflector' }
    const front = new MB(), nr = 8, seg = 48, th = 0.02 * p.diameterM + 0.01
    // 旋转抛物面近似的凸面：x = sag·(r/R)²
    const ring = (r, dx) => { const row = []; for (let j = 0; j < seg; j++) { const ph = (2 * Math.PI * j) / seg; row.push([sag * (r / R) ** 2 + dx, r * Math.sin(ph), -r * Math.cos(ph)]) } return row }
    const rs = []; for (let i = 0; i <= nr; i++) rs.push(R * Math.sqrt(i / nr))
    grid(front, rs.map((r) => ring(r, 0)), { wrap: true, out: [-1, 0, 0] })
    const it = put(ctx, 'surface', 'reflector', part, 'reflector', front)
    const back = new MB()
    grid(back, [ring(R, 0), ring(R, th)], { wrap: true, out: (c) => [0, c[1], c[2]] })
    cap(back, ring(R, th), [1, 0, 0])
    if (p.legs) for (let k = 0; k < p.legs; k++) { const ph = (2 * Math.PI * k) / p.legs + (p.legs === 4 ? Math.PI / 4 : 0); tubeAlong(back, [sag + th / 2, 0.9 * R * Math.sin(ph), -0.9 * R * Math.cos(ph)], [-p.legLenM, 1.6 * R * Math.sin(ph), -1.6 * R * Math.cos(ph)], 0.012 + 0.01 * p.diameterM, 10) }
    put(ctx, 'back', 'reflector', part, 'white_paint', back)
    shellMass(ctx, 'surface', it, 2 * dishDensity(p.diameterM))
    ctx.parts.get('subreflector').normalBody = [-1, 0, 0]
    return ctx
  }
}

const feedLenOf = (p) => auto(p.lengthM, p.kind === 'lnb' ? 1.4 * p.apertureDM : 2.5 * p.apertureDM)
const feed = {
  type: 'es.feed', domain: ['ground', 'ship', 'vehicle'], title: 'Feed', titleZh: '馈源', role: 'feed',
  params: {
    kind: enm('corrugated', ['corrugated', 'horn', 'lnb'], '形式', { title: 'corrugated = 波纹喇叭；horn = 光壁锥喇叭；lnb = 小口径喇叭 + 高频头' }),
    apertureDM: num(0.3, 'm', '口径', { gt: 0 }),
    lengthM: num(null, 'm', '长度', { nullable: true, gt: 0, title: '留空：lnb = 1.4 × 口径，其余 2.5 × 口径' })
  },
  // root = 后法兰（口面朝 +X）；aperture = 口面中心（接反射面焦点插座时用它作 mount：口面朝反射面）
  sockets: (p) => [sock('root', [0, 0, 0], [-1, 0, 0], [0, 0, -1], p.apertureDM, 15), sock('aperture', [feedLenOf(p), 0, 0], [1, 0, 0], [0, 0, -1], p.apertureDM, 15)],
  symmetricPlanes: ['xz', 'xy'],
  build(p, kit) {
    const ctx = kit.createCtx(), L = feedLenOf(p), ra = p.apertureDM / 2, part = { id: 'feed', name: '馈源', role: 'feed' }
    const m = new MB()
    if (p.kind === 'corrugated') {
      // 波纹喇叭：外壁台阶（每节一个齿）+ 口面环
      const n = 10, prof = []
      for (let k = 0; k <= n; k++) { const s = (k / n) * L, r = 0.3 * ra + 0.7 * ra * (k / n) ** 0.8; prof.push([s, r * 1.08], [s + 0.5 * L / n, r * 1.08], [s + 0.5 * L / n, r]) }
      prof.push([L, ra])
      lathe(m, [[0, 0], ...prof.map(([s, r]) => [Math.min(s, L), r]), [L, 0.86 * ra]], 32)
    } else {
      lathe(m, [[0, 0], [0, 0.3 * ra], [L, ra], [L, 0.9 * ra], [0.3 * L, 0.2 * ra]], 32)
    }
    if (p.kind === 'lnb') box(m, [-0.35 * L, 0, 0], [0.35 * L, 0.55 * ra, 0.55 * ra])
    const it = put(ctx, 'feed', 'feed', part, p.kind === 'lnb' ? 'white_paint' : 'aluminum', m)
    shellMass(ctx, 'feed', it, 6)
    ctx.parts.get('feed').normalBody = [1, 0, 0]
    apLocal(ctx, 'boresight', [L, 0, 0], [1, 0, 0], [0, 0, -1])
    return ctx
  }
}

// ───────────────────────────── 地球站：天线罩 / 方舱 / 铁塔 / 非穿透底座 ─────────────────────────────

const RADOME_AREAL = 12   // 玻璃钢夹层天线罩等效面密度（kg/m²，示意）

const radome = {
  type: 'es.radome', domain: ['ground', 'ship'], title: 'Radome', titleZh: '天线罩', role: 'other',
  params: {
    diameterM: num(10, 'm', '球径', { gt: 0 }),
    heightM: num(null, 'm', '总高', { nullable: true, gt: 0, title: '截球高（含底座环）；留空 = 0.85 × 球径' }),
    ringHM: num(null, 'm', '底座环高', { nullable: true, min: 0, title: '留空 = 0.04 × 球径' }),
    translucent: bool(false, '半透明'),
    panels: bool(true, '板块接缝')
  },
  validate: (p) => { const H = auto(p.heightM, 0.85 * p.diameterM), rh = auto(p.ringHM, 0.04 * p.diameterM); return H - rh > 0.05 * p.diameterM && H - rh <= p.diameterM ? [] : ['总高与球径不成截球'] },
  sockets: (p) => { const H = auto(p.heightM, 0.85 * p.diameterM), rh = auto(p.ringHM, 0.04 * p.diameterM), R = p.diameterM / 2, zc = -(H - R), rb = Math.sqrt(Math.max(0, R * R - (zc + rh) ** 2)); return [standSocket(2 * rb, 15), sock('floor', [0, 0, -rh], [0, 0, -1], [1, 0, 0], 1.6 * rb, 15)] },
  symmetricPlanes: ['xz', 'yz'],
  build(p, kit) {
    const ctx = kit.createCtx(), R = p.diameterM / 2, H = auto(p.heightM, 0.85 * p.diameterM), rh = auto(p.ringHM, 0.04 * p.diameterM)
    const zc = -(H - R), part = { id: 'radome', name: '天线罩', role: 'other' }
    // 球面自顶点（φ = 0）到与底座环顶面的交线：z(φ) = zc − R·cos φ = −rh ⇒ cos φ₁ = (zc + rh) / R（截球过赤道时 φ₁ > 90°）
    const cb = clampN((zc + rh) / R, -1, 1), phi1 = Math.acos(cb), n = 24, prof = []
    for (let i = 0; i <= n; i++) { const ph = (phi1 * i) / n; prof.push([zc - R * Math.cos(ph), R * Math.sin(ph)]) }
    const rb = R * Math.sin(phi1)
    const dm = new MB(); lathe(dm, prof.map(([z, r]) => [-z, r]), 96, [0, 0, 0], [0, 0, -1])
    const dome = put(ctx, 'dome', 'other', part, p.translucent ? 'glass' : 'white_paint', dm)
    shellMass(ctx, 'dome', dome, RADOME_AREAL)
    const rm = new MB(); frustum(rm, [0, 0, 0], rb * 1.03, [0, 0, -rh], rb * 1.03, 96, false, true)
    if (rh > 0) put(ctx, 'ring', 'other', part, 'titanium', rm)
    if (p.panels) {
      // 板块接缝：经线 + 纬线细肋（略浮出罩面）
      const sm = new MB(), lat = 5, lon = 20, rr = 0.004 * p.diameterM + 0.005
      for (let k = 1; k <= lat; k++) { const ph = (phi1 * k) / (lat + 1), z = zc - R * Math.cos(ph); torus(sm, [0, 0, z], [0, 0, 1], R * Math.sin(ph) + rr * 0.3, rr, 64, 6) }
      for (let k = 0; k < lon; k++) {
        const az = (2 * Math.PI * k) / lon, q = [Math.cos(az), Math.sin(az), 0], pts = []
        for (let i = 1; i <= 12; i++) { const ph = (phi1 * i) / 12; pts.push(add([0, 0, zc - (R + rr * 0.3) * Math.cos(ph)], scl(q, (R + rr * 0.3) * Math.sin(ph)))) }
        for (let i = 0; i < pts.length - 1; i++) tubeAlong(sm, pts[i], pts[i + 1], rr, 6)   // 偶数段：管截面顶点集合关于 xz / yz 对称
      }
      put(ctx, 'seams', 'other', part, 'white_paint', sm)
    }
    return ctx
  }
}

const shelterDims = (p) => (p.size === 'custom' ? { L: p.lengthM, W: p.widthM, H: p.heightM } : ISO_BOX[p.size])

const shelter = {
  type: 'es.shelter', domain: ['ground', 'ship', 'vehicle'], title: 'Equipment shelter', titleZh: '机房方舱', role: 'other',
  params: {
    size: enm('20ft', ['10ft', '20ft', '40ft', 'custom'], '规格', { source: ISO668, title: 'ISO 668 系列 1：10 ft 2.991 m、20 ft 6.058 m、40 ft 12.192 m；宽 2.438 m、高 2.591 m' }),
    form: enm('shelter', ['shelter', 'container'], '外观', { title: 'shelter = 平壁方舱 + 侧门 + 空调；container = 瓦楞箱 + 货门' }),
    lengthM: num(6.058, 'm', '长', { gt: 0, title: '规格 custom 时生效' }),
    widthM: num(2.438, 'm', '宽', { gt: 0, title: '规格 custom 时生效' }),
    heightM: num(2.591, 'm', '高', { gt: 0, title: '规格 custom 时生效' }),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '留空：箱体 + 设备按 450 kg/m² 占地（示意）' })
  },
  sockets: (p) => { const d = shelterDims(p), f = boxFacesUp(d.L, d.W, d.H); return [standSocket(Math.min(d.L, d.W), 90), faceSocket(f[0], Math.min(d.L, d.W), 15)] },
  faces: (p) => { const d = shelterDims(p); return boxFacesUp(d.L, d.W, d.H) },
  // 方舱的侧门只在 +Y 面（不对称）；集装箱货门、锁杆、瓦楞关于 xz 面对称
  symmetricPlanes: (p) => (p.form === 'container' ? ['xz'] : []),
  build(p, kit) {
    const ctx = kit.createCtx(), d = shelterDims(p), part = { id: 'shelter', name: p.form === 'container' ? '集装箱' : '机房方舱', role: 'other' }
    const ms = containerMeshes(d.L, d.W, d.H, p.form)
    const w = put(ctx, 'walls', 'other', part, p.form === 'container' ? 'titanium' : 'white_paint', ms.walls)
    put(ctx, 'frame', 'other', part, p.form === 'container' ? 'dark_metal' : 'white_paint', ms.frame)
    put(ctx, 'detail', 'other', part, p.form === 'container' ? 'titanium' : 'aluminum', ms.detail)
    boxComp(ctx, 'shelter', auto(p.massKg, 450 * d.L * d.W), [0, 0, -d.H / 2], [d.L / 2, d.W / 2, d.H / 2])
    return ctx
  }
}

const TOWER_LEG = 30, TOWER_BRACE = 9   // 角钢线密度（kg/m，示意）

/** 塔腿：四腿在 ±45°、±135°；三腿一条朝南（−X，与方位俯仰三脚座同一口径）、另两条在 ±60°——两种都关于 xz 面对称。 */
function towerGeom(p) {
  const n = p.legs, R0 = p.baseWM / Math.SQRT2, R1 = p.topWM / Math.SQRT2
  const leg = (k, h) => { const r = R0 + (R1 - R0) * (h / p.heightM), a = (2 * Math.PI * k) / n + (n === 4 ? Math.PI / 4 : Math.PI); return [r * Math.cos(a), r * Math.sin(a), -h] }
  return { n, leg }
}
const tower = {
  type: 'es.tower', domain: ['ground', 'ship'], title: 'Lattice tower', titleZh: '铁塔', role: 'boom',
  params: {
    heightM: num(12, 'm', '高', { gt: 0 }),
    baseWM: num(3.0, 'm', '底宽', { gt: 0 }),
    topWM: num(1.2, 'm', '顶宽', { gt: 0 }),
    sections: int(5, '节数', { min: 1, max: 40 }),
    legs: int(4, '腿数', { options: [3, 4] }),
    legDM: num(null, 'm', '主材直径', { nullable: true, gt: 0, title: '留空 = 0.035 × 底宽 + 0.04 m' })
  },
  sockets: (p) => [standSocket(p.baseWM, 15), sock('top', [0, 0, -p.heightM - 0.05], [0, 0, -1], [1, 0, 0], p.topWM, 15)],
  faces: (p) => [planeFace('top', [0, 0, -p.heightM - 0.05], 0.5 * p.topWM, 0.5 * p.topWM)],
  symmetricPlanes: (p) => (p.legs === 4 ? ['xz', 'yz'] : ['xz']),
  build(p, kit) {
    const ctx = kit.createCtx(), g = towerGeom(p), part = { id: 'tower', name: '铁塔', role: 'boom' }
    const rl = auto(p.legDM, 0.035 * p.baseWM + 0.04) / 2, rb = 0.45 * rl
    const lm = new MB(), bm = new MB()
    let legLen = 0, braceLen = 0
    for (let k = 0; k < g.n; k++) { const a = g.leg(k, 0), b = g.leg(k, p.heightM); tubeAlong(lm, a, b, rl, 10); legLen += len(sub(b, a)) }
    for (let s = 0; s < p.sections; s++) {
      const h0 = (p.heightM * s) / p.sections, h1 = (p.heightM * (s + 1)) / p.sections
      for (let k = 0; k < g.n; k++) {
        const k1 = (k + 1) % g.n, segs = [[g.leg(k, h1), g.leg(k1, h1)], [g.leg(k, h0), g.leg(k1, h1)], [g.leg(k1, h0), g.leg(k, h1)]]
        if (s === 0) segs.push([g.leg(k, h0), g.leg(k1, h0)])
        for (const [a, b] of segs) { tubeAlong(bm, a, b, rb, 6); braceLen += len(sub(b, a)) }
      }
    }
    put(ctx, 'legs', 'boom', part, 'aluminum', lm)
    put(ctx, 'braces', 'boom', part, 'aluminum', bm)
    // 质量：主材 + 斜材按线密度，分布按塔身包络盒（质心略低于半高：塔身下粗上细）
    boxComp(ctx, 'tower', TOWER_LEG * legLen + TOWER_BRACE * braceLen, [0, 0, -0.42 * p.heightM], [0.3 * (p.baseWM + p.topWM) / 2, 0.3 * (p.baseWM + p.topWM) / 2, p.heightM / 2])
    // 顶平台 + 护栏
    const pm = new MB(), tw = p.topWM * 0.62
    box(pm, [0, 0, -p.heightM - 0.025], [tw, tw, 0.025])
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) tubeAlong(pm, [sx * tw, sy * tw, -p.heightM - 0.05], [sx * tw, sy * tw, -p.heightM - 1.1], 0.025, 6)
    for (let k = 0; k < 4; k++) { const c0 = [[1, 1], [1, -1], [-1, -1], [-1, 1]][k], c1 = [[1, 1], [1, -1], [-1, -1], [-1, 1]][(k + 1) % 4]; tubeAlong(pm, [c0[0] * tw, c0[1] * tw, -p.heightM - 1.1], [c1[0] * tw, c1[1] * tw, -p.heightM - 1.1], 0.025, 6) }
    put(ctx, 'platform', 'boom', part, 'dark_metal', pm)
    return ctx
  }
}

const vsatMount = {
  type: 'es.vsat.mount', domain: ['ground', 'ship', 'vehicle'], title: 'Non-penetrating mount', titleZh: '非穿透式底座', role: 'boom',
  params: {
    frameM: num(1.8, 'm', '框架边长', { gt: 0 }),
    mastHM: num(1.2, 'm', '立柱高', { gt: 0, title: '框架顶面到立柱顶（方位抱箍 / 俯仰转轴）' }),
    mastDM: num(0.076, 'm', '立柱直径', { gt: 0 }),
    ballast: bool(true, '配重块'),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '留空：框架 + 立柱按钢材估算，配重块每块 36 kg（示意）' })
  },
  sockets: (p) => [standSocket(p.frameM, 90), sock('mast', [0, 0, -(0.1 + p.mastHM)], [1, 0, 0], [0, 0, -1], Math.max(0.1, 2 * p.mastDM), 90, REFL_ACCEPTS)],
  symmetricPlanes: ['xz', 'yz'],
  build(p, kit) {
    const ctx = kit.createCtx(), a = p.frameM / 2, part = { id: 'mount', name: '非穿透式底座', role: 'boom' }, ch = 0.1, cw = 0.05
    const fm = new MB()
    for (const s of [1, -1]) { box(fm, [0, s * (a - cw / 2), -ch / 2], [a, cw / 2, ch / 2]); box(fm, [s * (a - cw / 2), 0, -ch / 2], [cw / 2, a - cw, ch / 2]) }
    box(fm, [0, 0, -ch / 2], [a - cw, cw / 2, ch / 2]); box(fm, [0, 0, -ch / 2], [cw / 2, a - cw, ch / 2])
    // 斜撑：框架四角 → 立柱 0.55 高处
    const zb = -(0.1 + 0.55 * p.mastHM)
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) tubeAlong(fm, [sx * (a - cw), sy * (a - cw), -ch], [0, 0, zb], 0.018, 8)
    const frame = put(ctx, 'frame', 'boom', part, 'aluminum', fm)
    const mm = new MB(); tubeAlong(mm, [0, 0, -ch], [0, 0, -(0.1 + p.mastHM)], p.mastDM / 2, 20)
    const mast = put(ctx, 'mast', 'boom', part, 'aluminum', mm)
    let mass = 0
    if (p.ballast) {
      const bm = new MB()
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) box(bm, [sx * 0.62 * a, sy * 0.62 * a, -ch - 0.05], [0.2, 0.2, 0.05])
      put(ctx, 'ballast', 'other', { id: 'ballast', name: '配重块', role: 'other' }, 'titanium', bm)
      mass += 4 * 36
    }
    void frame; void mast
    mass += 18 * (4 * p.frameM + 2.5 * p.mastHM)
    boxComp(ctx, 'mount', auto(p.massKg, mass), [0, 0, -0.15], [a, a, 0.15])
    return ctx
  }
}

// ───────────────────────────── 地球站：轮轨座（大口径波束波导天线） / 落地立柱 ─────────────────────────────

/** 波束波导镜直径出处（DSN 810-005 模块 104：34 m BWG 天线的波导镜约 2.4 m）。 */
const DSN_BWG_URL = 'https://deepspace.jpl.nasa.gov/dsndocs/810-005/104/104L.pdf'

/** 轮轨座尺寸推算（全部示意比例，以配套口径为基准）。 */
function wheeltrackGeom(p) {
  const D = p.dishDM, H = auto(p.elAxisHM, 0.62 * D), Rr = auto(p.railDM, 0.55 * D) / 2, hp = auto(p.pedHM, 0.12 * D)
  const yb = 0.15 * D + 0.2                        // 俯仰轴承 y（= 反射面耳轴端，与 es.refl.* 的耳轴长同式）
  const tH = 0.035 * D, tL = 0.1 * D, tW = 0.04 * D   // 轮车高 / 沿轨长 / 径向宽
  const beam = 0.026 * D                           // 桁架主梁截面边长
  const zBase = -(hp + tH)                         // 轮车顶（底座梁底）
  // 竖向波导罩顶（镜室）离俯仰轴 0.2 D：让开倾斜结构（中心舱 / 配重）在全仰角范围扫过的空间
  return { D, H, Rr, hp, yb, tH, tL, tW, beam, zBase, rw: 0.55 * p.bwgDM, zWg: -(H - 0.2 * D) }
}

const pedestalWheeltrack = {
  type: 'es.pedestal.wheeltrack', domain: ['ground'], title: 'Wheel-and-track pedestal', titleZh: '轮轨座', role: 'boom',
  params: {
    dishDM: num(34, 'm', '配套口径', { gt: 5, max: 100, title: '座架按它推算缺省尺寸（比例为示意值）' }),
    elAxisHM: num(null, 'm', '俯仰轴高', { nullable: true, gt: 0, title: '地面到俯仰轴；留空 = 0.62 × 配套口径' }),
    railDM: num(null, 'm', '方位轨道直径', { nullable: true, gt: 0, title: '留空 = 0.55 × 配套口径' }),
    pedHM: num(null, 'm', '基座高', { nullable: true, min: 0, title: '混凝土基座（下有波导镜室）露出地面的高度；留空 = 0.12 × 配套口径' }),
    bwgDM: num(2.4, 'm', '波导管径', { gt: 0, source: DSN_BWG_URL, title: '波束波导镜约 2.4 m；竖向波导罩外径按 1.1 × 管径' }),
    azTravelDeg: num(540, '°', '方位行程', { gt: 0, max: 720, title: '≥ 360° 以北为中心；不足 360° 以南为中心' })
  },
  validate: (p) => {
    const g = wheeltrackGeom(p), e = []
    if (!(g.H > g.hp + g.tH + 0.2 * g.D)) e.push('俯仰轴高不足')
    if (!(g.Rr > 0.8 * g.yb)) e.push('方位轨道直径过小')
    if (!(g.rw < 0.35 * g.yb)) e.push('波导管径过大')
    return e
  },
  sockets: (p) => { const g = wheeltrackGeom(p); return [standSocket(2 * g.Rr, 15), sock('el', [0, 0, -g.H], [1, 0, 0], [0, 0, -1], 2 * g.yb, 90, REFL_ACCEPTS)] },
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = wheeltrackGeom(p), D = g.D
    const part = { id: 'pedestal', name: '轮轨座', role: 'boom' }, bwg = { id: 'bwg', name: '波束波导', role: 'feed' }
    // 固定：混凝土基座（圆柱，下接波导镜室）+ 方位轨道（矩形截面圆环）
    const pm = new MB(); frustum(pm, [0, 0, 0], g.Rr + 0.03 * D, [0, 0, -g.hp], g.Rr + 0.03 * D, 96, false, true)
    if (g.hp > 0) put(ctx, 'pad', 'other', { id: 'pad', name: '基础', role: 'other' }, CONCRETE, pm)
    const rm = new MB(), rw_ = 0.007 * D, rh = 0.004 * D
    lathe(rm, [[0, g.Rr - rw_], [rh, g.Rr - rw_], [rh, g.Rr + rw_], [0, g.Rr + rw_], [0, g.Rr - rw_]], 128, [0, 0, -g.hp], [0, 0, -1])
    put(ctx, 'rail', 'boom', part, 'dark_metal', rm)
    // 方位动件（节点系 = 方位关节系，原点在俯仰轴中心）
    const G = gimbalFrame('azel', [1, 0, 0], [0, 0, -1]), o = [0, 0, -g.H]
    const truck = new MB(), wheels = new MB(), frame = new MB(), brg = new MB(), wg = new MB()
    const T = []                               // 四组轮车（±45°、±135°），轮车沿轨道切向
    for (const a of [Math.PI / 4, 3 * Math.PI / 4, -3 * Math.PI / 4, -Math.PI / 4]) {
      const c = [g.Rr * Math.cos(a), g.Rr * Math.sin(a), 0], t = [-Math.sin(a), Math.cos(a), 0], rd = [Math.cos(a), Math.sin(a), 0]
      T.push(c)
      const q = (sT, sR, z) => add(add(add(c, scl(t, sT * g.tL / 2)), scl(rd, sR * g.tW / 2)), [0, 0, z])
      const zt = -(g.hp + 0.35 * g.tH)
      prism(truck, [q(-1, -1, zt), q(1, -1, zt), q(1, 1, zt), q(-1, 1, zt)], [q(-1, -1, g.zBase), q(1, -1, g.zBase), q(1, 1, g.zBase), q(-1, 1, g.zBase)])
      const rwh = 0.3 * g.tH
      for (const sT of [-0.3, 0.3]) {
        const wc = add(add(c, scl(t, sT * g.tL)), [0, 0, -(g.hp + rh + rwh)])
        tubeAlong(wheels, madd(wc, rd, -0.45 * g.tW), madd(wc, rd, 0.45 * g.tW), rwh, 20)
      }
    }
    // 两侧 A 形桁架：同侧两组轮车 → 俯仰轴承；底座梁（轮车间，纵向两根 + 横向两根）；A 形框中段系杆 + 斜撑
    const zTop = -(g.H - 0.03 * D)
    for (const sy of [1, -1]) {
      const a = T.find((c) => c[0] > 0 && Math.sign(c[1]) === sy), b = T.find((c) => c[0] < 0 && Math.sign(c[1]) === sy)
      const top = [0, sy * g.yb, zTop], fa = [a[0], a[1], g.zBase], fb = [b[0], b[1], g.zBase]
      beam(frame, fa, top, g.beam); beam(frame, fb, top, g.beam)
      const at = (p0, t) => add(p0, scl(sub(top, p0), t))
      tubeAlong(frame, at(fa, 0.45), at(fb, 0.45), 0.3 * g.beam, 12)
      tubeAlong(frame, at(fa, 0.08), at(fb, 0.45), 0.25 * g.beam, 10)
      tubeAlong(frame, at(fb, 0.08), at(fa, 0.45), 0.25 * g.beam, 10)
      beam(frame, [fa[0] - 0.5 * g.beam, fa[1], g.zBase - 0.5 * g.beam], [fb[0] + 0.5 * g.beam, fb[1], g.zBase - 0.5 * g.beam], g.beam)
    }
    for (const sx of [1, -1]) {
      const y0 = T.find((c) => Math.sign(c[0]) === sx && c[1] > 0)[1]
      prism(frame, [[sx * g.Rr * Math.SQRT1_2 - g.beam / 2, -y0, g.zBase], [sx * g.Rr * Math.SQRT1_2 + g.beam / 2, -y0, g.zBase], [sx * g.Rr * Math.SQRT1_2 + g.beam / 2, y0, g.zBase], [sx * g.Rr * Math.SQRT1_2 - g.beam / 2, y0, g.zBase]],
        [[sx * g.Rr * Math.SQRT1_2 - g.beam / 2, -y0, g.zBase - g.beam], [sx * g.Rr * Math.SQRT1_2 + g.beam / 2, -y0, g.zBase - g.beam], [sx * g.Rr * Math.SQRT1_2 + g.beam / 2, y0, g.zBase - g.beam], [sx * g.Rr * Math.SQRT1_2 - g.beam / 2, y0, g.zBase - g.beam]])
    }
    // 俯仰轴承座
    for (const sy of [1, -1]) {
      box(brg, [0, sy * g.yb, -(g.H - 0.015 * D)], [0.035 * D, 0.6 * g.beam, 0.03 * D])
      tubeAlong(brg, [0, sy * (g.yb - 0.7 * g.beam), -g.H], [0, sy * (g.yb + 0.7 * g.beam), -g.H], 0.022 * D, 24)
    }
    // 波束波导：基座顶 → 俯仰轴下方的竖向波导罩 + 沿俯仰轴方向的水平弯头罩（镜室）
    const rWg = g.rw
    frustum(wg, [0, 0, -g.hp], rWg, [0, 0, g.zWg], rWg, 48, false, false)
    tubeAlong(wg, [0, -1.3 * rWg, g.zWg - 0.5 * rWg], [0, 1.3 * rWg, g.zWg - 0.5 * rWg], 0.9 * rWg, 48)
    const nodes = []
    const reg = (name, role, pt, mat, mb) => { const it = putFramed(ctx, name, role, pt, mat, mb, G, o); if (it) nodes.push(name); return it }
    const tr = reg('trucks', 'boom', part, 'white_paint', truck)
    reg('wheels', 'boom', part, 'dark_metal', wheels)
    const fr = reg('frame', 'boom', part, 'white_paint', frame)
    reg('bearings', 'boom', part, 'dark_metal', brg)
    reg('waveguide', 'feed', bwg, 'white_paint', wg)
    solidCompItems(ctx, 'alidade', [tr, fr].filter(Boolean), STEEL_SOLID)
    const [mn, mx, ini] = azStage(p.azTravelDeg)
    ctx.arts.push({ name: 'azimuth', nodes, stages: [stage(STAGE.az, 'zRotate', mn, mx, ini)] })
    return ctx
  }
}

/** 钢管立柱质量（示意：7850 kg/m³、壁厚 0.06 × 管径）。 */
const mastSteelKg = (Dm, L) => 7850 * Math.PI * ((Dm / 2) ** 2 - (Dm / 2 - 0.06 * Dm) ** 2) * L

const mast = {
  type: 'es.mast', domain: ['ground', 'ship', 'vehicle'], title: 'Pipe mast', titleZh: '立柱', role: 'boom',
  params: {
    mastDM: num(0.114, 'm', '立柱直径', { gt: 0.02, max: 1 }),
    heightM: num(1.5, 'm', '立柱高', { gt: 0.2, max: 8, title: '安装面到立柱顶（方位抱箍 / 俯仰转轴）；厂家不规定，随用户立柱' }),
    footing: bool(true, '混凝土基础', { title: '墩顶露出安装面 0.05 m（0.6 × 0.6 m，示意）；关掉 = 法兰底板 + 四块筋板（甲板 / 车顶螺接）' }),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '留空 = 钢管按 7850 kg/m³、壁厚 0.06 × 管径（示意）' })
  },
  sockets: (p) => [standSocket(Math.max(0.2, 3 * p.mastDM), 90), sock('mast', [0, 0, -p.heightM], [1, 0, 0], [0, 0, -1], Math.max(0.1, 2 * p.mastDM), 90, REFL_ACCEPTS)],
  symmetricPlanes: ['xz', 'yz'],
  build(p, kit) {
    const ctx = kit.createCtx(), Dm = p.mastDM, r = Dm / 2, part = { id: 'mast', name: '立柱', role: 'boom' }
    let z0_ = 0
    if (p.footing) {
      const a = Math.max(0.3, 1.3 * Dm), fm = new MB()
      box(fm, [0, 0, -0.025], [a, a, 0.025])
      put(ctx, 'footing', 'other', { id: 'footing', name: '基础', role: 'other' }, CONCRETE, fm)
      z0_ = -0.05
    } else {
      // 法兰底板 + 四块三角筋板 + 四颗地脚螺栓
      const a = Math.max(0.1, 1.6 * Dm), t = Math.max(0.012, 0.12 * Dm), bm = new MB()
      box(bm, [0, 0, -t / 2], [a, a, t / 2])
      const gh = Math.max(0.08, 1.5 * Dm), gt = Math.max(0.008, 0.08 * Dm)
      for (const [ux, uy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        // 筋板：径向—竖直面内的四边形（管根 → 底板外缘 → 外缘小立边 → 管壁 gh 高处），沿切向加厚 gt
        const w = [-uy * gt / 2, ux * gt / 2, 0], at = (d, z) => [ux * d, uy * d, z]
        const q4 = [at(0.98 * r, -t), at(0.95 * a, -t), at(0.95 * a, -t - 0.12 * gh), at(0.98 * r, -t - gh)]
        prism(bm, q4.map((v) => sub(v, w)), q4.map((v) => add(v, w)))
      }
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) tubeAlong(bm, [0.78 * a * sx, 0.78 * a * sy, -t], [0.78 * a * sx, 0.78 * a * sy, -t - Math.max(0.02, 0.2 * Dm)], Math.max(0.006, 0.07 * Dm), 8)
      put(ctx, 'baseplate', 'boom', part, 'dark_metal', bm)
      z0_ = -t
    }
    const mm = new MB(); frustum(mm, [0, 0, z0_], r, [0, 0, -p.heightM], r, 24, false, true)
    put(ctx, 'pipe', 'boom', part, 'aluminum', mm)
    const L = p.heightM + z0_, ro = r, ri = r - 0.06 * Dm, m = auto(p.massKg, mastSteelKg(Dm, p.heightM))
    const Ia = m * (ro * ro + ri * ri) / 2, It = m * (3 * (ro * ro + ri * ri) + L * L) / 12
    comp(ctx, 'mast', 'solid', m, [0, 0, (z0_ - p.heightM) / 2], [It, 0, 0, 0, It, 0, 0, 0, Ia])
    return ctx
  }
}

export const GROUND_COMPONENTS = Object.freeze([pedestalAzel, pedestalXY, reflPrime, reflCass, reflOffset, subrefl, feed, radome, shelter, tower, vsatMount, pedestalWheeltrack, mast])
