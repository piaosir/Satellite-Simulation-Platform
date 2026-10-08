// 卫星领域装配组件 · 天线与通信终端（2026-10-08 补全）：双轴指向天线、螺旋天线（阵）、全向天线、多波束馈源阵、激光通信终端、
// 对数周期天线、天线罩、缝隙波导阵、消旋天线（电子 / 机械）。
//
// 为什么：用户「卫星的各种天线只有一个反射面，相控阵、全向天线等各种天线我都在参数化模型上见到了……补全卫星组件，我要最佳效果，
// 让用户真正可用愿意用」。造型件在 ../antennas.mjs（参数驱动、尺寸按工作频率推算），这里只管参数 / 接口 / 质量 / 挂点 / 关节。
//
// ★ 局部坐标同 sat.mjs：原点 = 安装基准点、局部 −Z 贴父面（安装接口 n = −Z）、局部 +X = 滚转零位、几何朝 +Z 长。
// ★ 挂点一律叫 boresight（装配件出 IR 时加组件前缀，如 c7_boresight）：位置 = 相位中心 / 口面中心，方向 = 波束视轴（指向机构按
//   设定指向烘焙后的实际视轴）。卫星页「从挂点新增」一键绑定方向图；掩模按挂点前缀排除本组件自身（mountLogic.ownAntennaNodes）。
// ★ 双轴指向机构（双轴指向天线 / 镜筒式激光终端）的指向烘焙（与地球站 es.refl.* 的「几何在零位 + 关节初值」不同，原因：卫星装配页
//   编辑态不摆关节初值，用户改「指向方位 / 指向偏角」要当场看得见）：
//     方位-俯仰：转台与载荷的节点系 N = 方位 φ 已转好的轴系（x = 俯仰轴、z = 方位轴），载荷几何在 N 里再绕 x 转偏角 θ；
//       关节 stage 值 = 相对设定指向的增量（初值 0）：M = N·Rz(Δφ)·Rx(Δθ)·G = Rz(φ+Δφ)·Rx(θ+Δθ)·G₀（同轴转动可交换）。
//     X-Y：X 段节点系 = 绕 X 轴已转 a1 的轴系，载荷几何在里面绕 Y 轴（z = d 处）转 a2；stage [X 增量, +d 平移, Y 增量, −d 平移]，
//       M = N·Rx(Δ1)·T(d)·Ry(Δ2)·T(−d)·T(d)·Ry(a2)·T(−d)·G₀ = Rx(a1+Δ1)·T(d)·Ry(a2+Δ2)·T(−d)·G₀。
//     于是编辑态 / 缩略图 / 3D 页都是设定指向；导出给 STK 的关节照样是真实的两轴运动学（零位 = 设定指向）。
// ★ 镜像：螺旋 / 四臂螺旋是手性件，几何镜像会把右旋变成左旋。镜像钩子返回原参数——对称位置上装的是同一型号的天线，极化不随镜像翻转
//   （其余全向天线、馈源阵本身对称，钩子同样返回原参数）。指向机构按「偏转方向落在哪个对称面」声明对称面，其余情况烘焙镜像（指向一并镜像）。
// ★ 质量：反射面按 reflectorAreal（圆盘惯量）、指向机构按 apmMass、螺旋阵元 helixMass、低增益天线 lgaMass、激光终端 lctMass（按口径平方缩放）、
//   馈源阵按 hornAreal / towerAreal——都是 paramBus.DENSITY 的示意值，装配件「密度」节可改；组件「质量」手动输入时按输入值缩放。
// ★ 缺省参数全部是示意值（source:'illustrative'），不取具体型号尺寸。
//
// 导出：SAT_ANTENNA_COMPONENTS（sat.antenna.gimbal / sat.antenna.helix / sat.antenna.omni / sat.feed.cluster / sat.lct /
//       sat.antenna.lpda / sat.antenna.shroud / sat.antenna.slot / sat.antenna.despun）

import { isNum, z0, IDR, comp, plateComp, pointComp, rodComp, rApply, madd } from '../meshKit.mjs'
import { addHw } from '../paramBus.mjs'
import { num, int, bool, enm, sock, apLocal, stage } from './shapeKit.mjs'
import { cyl, bevelBox, frameZX } from '../fleet/kit.mjs'
import {
  lambdaOf, dishAntenna, azelBase, azelTurret, azelYokeShaft, xyBase, xyStage, xyCradle, helixUnit, groundPlate, qhaAntenna, whipAntenna,
  patchAntenna, hornCluster, lctHead, periscopeHead, outlinePoly, polyArea, lpdaAntenna, shroud, slotBars, edaArray
} from '../antennas.mjs'

const SAT = ['spacecraft']
const DEG = Math.PI / 180
/** 安装接口（局部 −Z 贴父面，原点） */
const ROOT = (size, roll = 15) => sock('root', [0, 0, 0], [0, 0, -1], [1, 0, 0], size, roll)
/** 馈源阵口面接口只收馈源链与基本体占位（同 sat.mjs FEED_CHAIN_ACCEPTS） */
const FEED_CHAIN_ACCEPTS = Object.freeze(['sat.feed.', 'prim.'])
/** 圆盘的等效方板边长（plateComp 的 w = h = √3 R 时惯量恰为圆盘：I⊥ = mR²/4、I∥ = mR²/2） */
const discPlate = (R) => Math.sqrt(3) * R

/** 一组硬件造型件按材质分桶登记，再整体放进节点系 (R, t)（几何已在节点系坐标里画） */
function addHwAt(ctx, name, part, role, mainMat, R, t, build) {
  const r = addHw(ctx, name, part, role, mainMat, build)
  for (const it of r.items) { it.R = R; it.t = t.slice() }
  return r
}
/** 节点系 (R, t) 里的点 → 组件局部系 */
const inN = (R, t, p) => { const w = rApply(R, p); return [w[0] + t[0], w[1] + t[1], w[2] + t[2]].map(z0) }
/** 方位 φ 已转好的方位-俯仰节点系（列向量）：x = 俯仰轴、y = −偏转方向、z = 方位轴（局部 +Z）；绕 x 正转 = 视轴向偏转方向倾 */
function azFrame(phiDeg) {
  const p = phiDeg * DEG, c = Math.cos(p), s = Math.sin(p)
  return [[-s, c, 0].map(z0), [-c, -s, 0].map(z0), [0, 0, 1]]
}
/** 指向（方位 φ、偏角 θ：视轴自局部 +Z 向 φ 方向倾 θ）→ 单位向量 */
const pointDir = (phiDeg, thDeg) => { const p = phiDeg * DEG, t = thDeg * DEG; return [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t)].map(z0) }
/** X-Y 座的两轴角（度）：视轴 b = Rx(a1)·Ry(a2)·ẑ → a2 = asin(bx)、a1 = atan2(−by, bz) */
const xyAngles = (b) => [Math.atan2(-b[1], b[2]) / DEG, Math.asin(Math.max(-1, Math.min(1, b[0]))) / DEG].map(z0)
/** 绕 x 转 a（度）的轴系（列向量） */
const rotX = (aDeg) => { const a = aDeg * DEG, c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, s].map(z0), [0, -s, c].map(z0)] }
/** 指向机构的对称面：偏转方向落在 xz 面（φ ≡ 0 mod 180）→ xz；落在 yz 面（φ ≡ 90）→ yz；不偏且 φ ≡ 0 mod 90 → 两面 */
function pointSym(phiDeg, thDeg) {
  const m = ((phiDeg % 180) + 180) % 180
  if (thDeg === 0 && (m === 0 || m === 90)) return ['yz', 'xz']
  if (m === 0) return ['xz']
  if (m === 90) return ['yz']
  return []
}
/** 指向参数（双轴指向天线与激光终端共用的那几项） */
const POINT_PARAMS = {
  azDeg: num(0, '°', '指向方位', { min: -180, max: 180, title: '视轴偏转方向在安装面内的方位角：自局部 +X 起、绕安装面法向逆时针' }),
  tiltDeg: num(0, '°', '指向偏角', { min: 0, max: 90, title: '视轴偏离安装面法向的角度（0 = 沿安装面法向）' })
}
const MECH_OPTIONS = ['mli_gold', 'mli_black', 'white_paint', 'aluminum', 'black_paint']
const MECH_LABELS = Object.freeze({ mli_gold: '金色 MLI', mli_black: '黑色 MLI', white_paint: '白漆', aluminum: '本色铝', black_paint: '黑色阳极化' })
const HAND = enm('rhcp', ['rhcp', 'lhcp'], '极化旋向', { optionLabels: { rhcp: '右旋圆极化', lhcp: '左旋圆极化' }, title: '螺旋绕向（右旋绕制辐射右旋圆极化）；镜像对称时保持不变' })

// ───────────────────────────── 双轴指向机构（双轴指向天线 / 镜筒式激光终端共用） ─────────────────────────────

/** 方位-俯仰机构尺寸（按载荷特征尺寸 S 推算；H 可覆盖） */
function azelDims(S, postH) {
  return {
    H: isNum(postH) ? postH : Math.max(0.12, 0.42 * S + 0.04), rb: Math.max(0.05, 0.16 * S), ra: Math.max(0.035, 0.11 * S), hz: Math.max(0.035, 0.11 * S),
    wy: 0.17 * S + 0.025, armT: Math.max(0.012, 0.035 * S), rbr: Math.max(0.018, 0.055 * S), rs: Math.max(0.008, 0.022 * S), motorL: Math.max(0.02, 0.07 * S)
  }
}
/** X-Y 机构尺寸（h1 可覆盖） */
function xyDims(S, postH) {
  return {
    h1: isNum(postH) ? postH : Math.max(0.08, 0.22 * S + 0.03), rx: Math.max(0.03, 0.08 * S), wx: Math.max(0.05, 0.16 * S), d: Math.max(0.05, 0.13 * S + 0.02),
    ry: Math.max(0.026, 0.07 * S), wyy: Math.max(0.045, 0.14 * S), tp: Math.max(0.008, 0.025 * S)
  }
}

/**
 * 双轴指向机构 + 载荷（kind 'azel' | 'xy' | 'fixed'）。载荷 o.drawPayload(put, Fp, zBack) 在载荷系 Fp（Fp.z = 设定视轴）里画、
 * 背面在 Fp 的 z = zBack，返回 {ap}（Fp 所在节点系里的点）。o = { kind, S（载荷特征尺寸）, pre（节点名前缀）, part, role, mainMat, base0? }
 * base0：机构底座抬高（激光终端的电子箱在下面）。返回 {ap（组件局部系）, bore, toLocal, mechAt, R, t}。
 */
function buildPointing(ctx, p, o) {
  const m = { mech: p.mech || 'mli_gold', metal: 'aluminum' }
  const part = o.part, role = o.role, z0b = o.base0 || 0
  const bore = pointDir(p.azDeg, p.tiltDeg)
  const art = p.articulate !== false && o.kind !== 'fixed'
  const T0 = (q) => [q[0], q[1], q[2] + z0b]
  if (o.kind === 'xy') {
    const g = xyDims(o.S, p.postHM)
    const [a1, a2] = xyAngles(bore)
    const zBack = 1.3 * g.ry + 0.02
    addHwAt(ctx, `${o.pre}base`, part, role, m.mech, IDR, T0([0, 0, 0]), (put) => xyBase(put, g, m))
    const R = rotX(a1), t = T0([0, 0, g.h1])
    const xs = addHwAt(ctx, `${o.pre}xstage`, part, role, m.mech, R, t, (put) => xyStage(put, g, m))
    let pay = null
    const pl = addHwAt(ctx, `${o.pre}payload`, part, role, o.mainMat, R, t, (put) => { const Fp = xyCradle(put, g, m, a2, zBack); pay = o.drawPayload(put, Fp, zBack) })
    if (art) {
      const L1 = [-90 - a1, 90 - a1], L2 = [-90 - a2, 90 - a2]
      ctx.arts.push({ name: `${o.pre}xaxis`, nodes: xs.items.map((it) => it.name), stages: [stage('xAxis', 'xRotate', L1[0], L1[1], 0)] })
      ctx.arts.push({ name: `${o.pre}gimbal`, nodes: pl.items.map((it) => it.name), stages: [stage('xAxis', 'xRotate', L1[0], L1[1], 0), stage('yOffsetUp', 'zTranslate', g.d, g.d, g.d), stage('yAxis', 'yRotate', L2[0], L2[1], 0), stage('yOffsetDown', 'zTranslate', -g.d, -g.d, -g.d)] })
    }
    return { ap: inN(R, t, pay.ap), bore, toLocal: (q) => inN(R, t, q), mechAt: T0([0, 0, 0.7 * g.h1]), R, t }
  }
  if (o.kind === 'fixed') {
    // 固定支座：法兰 + 立柱，载荷按设定指向烘进几何（无关节）
    const H = isNum(p.postHM) ? p.postHM : Math.max(0.06, 0.25 * o.S), rp = Math.max(0.018, 0.05 * o.S)
    const R = azFrame(p.azDeg), t = T0([0, 0, H])
    addHwAt(ctx, `${o.pre}base`, part, role, m.mech, IDR, T0([0, 0, 0]), (put) => {
      azelBase(put, { rb: 1.8 * rp, ra: rp, hz: 0.04 }, m)
      cyl(put(m.mech), [0, 0, 0.02], [0, 0, H], rp, 24, false, true)
    })
    let pay = null
    addHwAt(ctx, `${o.pre}payload`, part, role, o.mainMat, R, t, (put) => {
      const th = p.tiltDeg * DEG
      const Fp = { o: [0, 0, 0], x: [1, 0, 0], y: [0, Math.cos(th), Math.sin(th)], z: [0, -Math.sin(th), Math.cos(th)] }
      cyl(put(m.metal), [0, 0, 0], Fp.z.map((v) => v * 0.02), 1.15 * rp, 24, true, true)
      cyl(put(m.mech), Fp.z.map((v) => v * 0.02), Fp.z.map((v) => v * (0.02 + rp)), 0.7 * rp, 20, false, true)
      pay = o.drawPayload(put, Fp, 0.02 + rp)
    })
    return { ap: inN(R, t, pay.ap), bore, toLocal: (q) => inN(R, t, q), mechAt: T0([0, 0, 0.5 * H]), R, t }
  }
  const g = azelDims(o.S, p.postHM)
  const R = azFrame(p.azDeg)
  const zBack = Math.max(1.5 * g.rbr, 0.12 * o.S)
  addHwAt(ctx, `${o.pre}base`, part, role, m.mech, IDR, T0([0, 0, 0]), (put) => azelBase(put, g, m))
  const tu = addHwAt(ctx, `${o.pre}turret`, part, role, m.mech, R, T0([0, 0, 0]), (put) => azelTurret(put, g, m))
  const t = T0([0, 0, g.H])
  let pay = null
  const pl = addHwAt(ctx, `${o.pre}payload`, part, role, o.mainMat, R, t, (put) => { const Fp = azelYokeShaft(put, g, m, p.tiltDeg, zBack); pay = o.drawPayload(put, Fp, zBack) })
  if (art) {
    ctx.arts.push({ name: `${o.pre}azimuth`, nodes: tu.items.map((it) => it.name), stages: [stage('azimuth', 'zRotate', -180, 180, 0)] })
    ctx.arts.push({ name: `${o.pre}gimbal`, nodes: pl.items.map((it) => it.name), stages: [stage('azimuth', 'zRotate', -180, 180, 0), stage('elevation', 'xRotate', -90 - p.tiltDeg, 90 - p.tiltDeg, 0)] })
  }
  return { ap: inN(R, t, pay.ap), bore, toLocal: (q) => inN(R, t, q), mechAt: T0([0, 0, 0.55 * g.H]), R, t }
}

// ───────────────────────────── 双轴指向天线 ─────────────────────────────

const FRONT_MAT = Object.freeze({ white: 'reflector', black: 'black_paint', sunshield: 'sunshield', silver: 'mli_silver' })
const REAR_MAT = Object.freeze({ cfrp: 'carbon', mli_gold: 'mli_gold', white: 'white_paint' })

const gimbalDish = {
  type: 'sat.antenna.gimbal', domain: SAT, title: 'Steerable dish antenna', titleZh: '双轴指向天线', role: 'reflector', category: 'antenna',
  aliases: ['万向', '可动点波束', '点波束', '馈电链路', '关口站', '星间链路', 'ISL', 'gimbal', 'APM', '指向机构', '抛物面', '碟形'],
  presets: [
    { id: 'xy', titleZh: 'X-Y 指向天线', title: 'X-Y steerable antenna', aliases: ['X-Y 座'], params: { gimbal: 'xy' } },
    { id: 'cass', titleZh: '卡塞格伦指向天线', title: 'Cassegrain steerable antenna', aliases: ['卡塞格伦', '降亮度', '黑色碟面'], params: { feed: 'cass', front: 'black' } },
    { id: 'fixed', titleZh: '固定支座抛物面天线', title: 'Fixed-mount dish antenna', aliases: ['固定支座'], params: { gimbal: 'fixed' } }
  ],
  params: {
    diameterM: num(0.45, 'm', '口径', { gt: 0, title: '轴对称抛物面口径（可动点波束 / 馈电链路 / 星间链路天线 0.3–1.5 m）' }),
    fD: num(0.35, '', '焦径比', { gt: 0.1, max: 2, title: '焦距 / 口径；小口径可动天线多为 0.3–0.45' }),
    feed: enm('prime', ['prime', 'cass', 'none'], '馈电形式', { optionLabels: { prime: '正馈', cass: '卡塞格伦', none: '无' }, title: '正馈：焦点处喇叭 + 撑杆；卡塞格伦：凸面副反射面 + 顶点馈源喇叭' }),
    gimbal: enm('azel', ['azel', 'xy', 'fixed'], '指向机构', { optionLabels: { azel: '方位-俯仰', xy: 'X-Y', fixed: '固定支座' }, title: '方位-俯仰：转台 + 叉臂；X-Y：两只水平作动器正交叠装；固定支座：立柱，按设定指向固定' }),
    ...POINT_PARAMS,
    postHM: num(null, 'm', '转轴高', { nullable: true, gt: 0, title: '方位-俯仰：俯仰轴离安装面高度；X-Y：X 轴高；固定支座：立柱高。留空按口径推算' }),
    front: enm('white', ['white', 'black', 'sunshield', 'silver'], '反射面外观', { optionLabels: { white: '白漆', black: '消光黑漆', sunshield: '锗膜遮阳罩', silver: '银色遮阳罩' }, title: '星链二代等降亮度设计的碟面涂消光黑漆' }),
    rear: enm('cfrp', ['cfrp', 'mli_gold', 'white'], '背面外观', { optionLabels: { cfrp: '碳纤维', mli_gold: '金色 MLI', white: '白漆' } }),
    mech: enm('mli_gold', MECH_OPTIONS, '机构外表面', { optionLabels: MECH_LABELS }),
    struts: int(4, '撑杆数', { options: [3, 4], title: '正馈喇叭的撑杆根数（三根时镜像对称件按烘焙处理）' }),
    feedApertureM: num(null, 'm', '馈源口径', { nullable: true, gt: 0, title: '正馈喇叭口径；留空 = 0.1 × 口径' }),
    articulate: bool(true, '转动关节', { title: 'AGI 关节（STK 可驱动）：零位 = 设定指向，stage 值为相对设定指向的转角' }),
    seg: int(40, '分段', { min: 16, max: 96 })
  },
  sockets: (p) => [ROOT(Math.max(0.1, 0.32 * p.diameterM))],
  symmetricPlanes: (p) => (p.feed === 'prime' && p.struts === 3 ? [] : pointSym(p.azDeg, p.tiltDeg)),
  build(p, kit) {
    const ctx = kit.createCtx()
    const D = p.diameterM, f = p.fD * D
    const part = { id: 'antenna', name: '双轴指向天线', role: 'reflector' }
    const front = FRONT_MAT[p.front] || 'reflector', rear = REAR_MAT[p.rear] || 'carbon'
    let dish = null, Fp0 = null
    const r = buildPointing(ctx, p, {
      kind: p.gimbal, S: D, pre: '', part, role: 'reflector', mainMat: front,
      drawPayload: (put, Fp, zBack) => {
        Fp0 = Fp
        dish = dishAntenna(put, { F: Fp, zv: zBack + Math.max(0.004, 0.012 * D) + Math.max(0.01, 0.06 * D), D, f, front, rear, feed: p.feed, struts: p.struts, feedAp: p.feedApertureM, feedMat: 'gold_metal', seg: p.seg, nr: 10 })
        return { ap: p.feed === 'prime' ? dish.focus : dish.rimCenter }
      }
    })
    // 质量：反射面圆盘（reflectorAreal，按口径面积）+ 指向机构（apmMass，随口径近似线性缩放）
    const Rd = D / 2, mDish = ctx.dens.reflectorAreal * Math.PI * Rd * Rd
    const zc = dish.zv + 0.5 * Rd * Rd / (4 * f)
    const cLocal = r.toLocal([Fp0.o[0] + Fp0.z[0] * zc, Fp0.o[1] + Fp0.z[1] * zc, Fp0.o[2] + Fp0.z[2] * zc])
    const RpLocal = [rApply(r.R, Fp0.x), rApply(r.R, Fp0.y), rApply(r.R, Fp0.z)]
    plateComp(ctx, 'antenna_dish', mDish, cLocal, RpLocal, discPlate(Rd), discPlate(Rd))
    pointComp(ctx, 'antenna_mech', ctx.dens.apmMass * Math.max(0.5, D / 0.45), r.mechAt)
    const pp = ctx.parts.get('antenna')
    pp.areaM2 = Math.PI * Rd * Rd; pp.normalBody = r.bore.slice()
    apLocal(ctx, 'boresight', r.ap, r.bore)
    return ctx
  }
}

// ───────────────────────────── 螺旋天线（阵） ─────────────────────────────

const COIL_LABELS = Object.freeze({ gold_metal: '镀金', copper: '裸铜', black_paint: '黑色', white_paint: '白色', aluminum: '本色铝' })
const GROUND_LABELS = Object.freeze({ mli_black: '黑色 MLI', mli_gold: '金色 MLI', white_paint: '白漆', aluminum: '本色铝', black_paint: '黑色阳极化' })

/** 螺旋阵的推算几何（单位 m）：阵元尺寸、各环阵元位置、底板 */
function helixLayout(p) {
  const lam = lambdaOf(p.freqGHz)
  const Dh = isNum(p.diameterM) ? p.diameterM : lam / Math.PI
  const S = isNum(p.pitchM) ? p.pitchM : 0.23 * lam
  const w = isNum(p.wireDM) ? p.wireDM / 2 : 0.065 * Dh
  const cupD = 1.5 * Dh, cupH = 0.3 * Dh
  const minR = (n) => (n > 1 ? (1.15 * cupD) / (2 * Math.sin(Math.PI / n)) : 0)
  const els = []          // {x, y, N}
  const N1 = p.turns, N2 = isNum(p.turnsOuter) ? p.turnsOuter : p.turns
  let ext = 0.5 * cupD
  if (p.layout === 'single') els.push({ x: 0, y: 0, N: N1 })
  else if (p.layout === 'grid') {
    const n = p.gridN, s = isNum(p.spacingM) ? p.spacingM : Math.max(0.75 * lam, 1.15 * cupD)
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) els.push({ x: (i - (n - 1) / 2) * s, y: (j - (n - 1) / 2) * s, N: N1 })
    ext = (n - 1) / 2 * s * Math.SQRT2 + 0.5 * cupD
  } else {
    const n1 = p.nInner
    const r1 = isNum(p.innerRM) ? p.innerRM : Math.max(p.layout === 'ring' ? 0.75 * lam : 0.9 * lam, minR(n1))
    const ph1 = p.layout === 'dual' ? Math.PI / n1 : 0
    for (let k = 0; k < n1; k++) { const a = ph1 + (2 * Math.PI * k) / n1; els.push({ x: r1 * Math.cos(a), y: r1 * Math.sin(a), N: N1 }) }
    ext = r1 + 0.5 * cupD
    if (p.layout === 'dual') {
      const n2 = p.nOuter, r2 = isNum(p.outerRM) ? p.outerRM : Math.max(r1 + 1.4 * lam, minR(n2))
      for (let k = 0; k < n2; k++) { const a = (2 * Math.PI * k) / n2; els.push({ x: r2 * Math.cos(a), y: r2 * Math.sin(a), N: N2 }) }
      ext = r2 + 0.5 * cupD
    }
  }
  const rg = isNum(p.groundRM) ? p.groundRM : ext + 0.35 * lam
  const tg = isNum(p.groundTM) ? p.groundTM : Math.max(0.006, 0.1 * lam)
  return { lam, Dh, S, w, cupD, cupH, els, rg, tg }
}

const helixAntenna = {
  type: 'sat.antenna.helix', domain: SAT, title: 'Helix antenna / array', titleZh: '螺旋天线', role: 'feed', category: 'antenna',
  aliases: ['螺旋', '轴向模', '导航天线', 'GNSS', 'L 频段', 'helix', '螺旋阵'],
  presets: [
    { id: 'single-uhf', titleZh: 'UHF 螺旋天线', title: 'UHF helix antenna', aliases: ['单个', '单螺旋', 'UHF', '立方星'], params: { layout: 'single', freqGHz: 0.4, turns: 10 } },
    { id: 'single-l', titleZh: 'L 频段螺旋天线', title: 'L-band helix antenna', aliases: ['单个', '单螺旋', 'L 频段'], params: { layout: 'single', freqGHz: 1.6, turns: 8 } },
    { id: 'single-s', titleZh: 'S 频段螺旋天线', title: 'S-band helix antenna', aliases: ['单个', '单螺旋', 'S 频段'], params: { layout: 'single', freqGHz: 2.2, turns: 8 } },
    { id: 'ring', titleZh: '单环螺旋阵', title: 'Helix ring array', aliases: ['环阵'], params: { layout: 'ring', nInner: 6 } },
    { id: 'grid', titleZh: '螺旋方阵', title: 'Helix grid array', aliases: ['方阵', '端帽'], params: { layout: 'grid', gridN: 3, cap: true, coilMat: 'black_paint', groundMat: 'mli_gold' } }
  ],
  params: {
    layout: enm('dual', ['single', 'ring', 'dual', 'grid'], '阵列布局', { optionLabels: { single: '单个阵元', ring: '单环阵', dual: '双环阵', grid: '方阵' }, title: '双环阵：内环 + 外环（导航星 L 频段赋形阵）；方阵：n × n' }),
    freqGHz: num(1.575, 'GHz', '工作频率', { gt: 0, title: '阵元尺寸按它推算：周长 = λ（直径 λ/π）、螺距 0.23 λ（升角约 12.5°）。L1 1.575 / L2 1.227 / S 2.2 / UHF 0.4 GHz' }),
    turns: num(7, '', '圈数', { gt: 0, max: 40, title: '轴向模增益随圈数增长（Kraus：G ≈ 10.8 + 10·lg(C²·N·S/λ³) dBi）；导航阵元 6–8 圈' }),
    nInner: int(4, '内环阵元数', { min: 1, max: 24, title: '单环阵为该环阵元数' }),
    nOuter: int(8, '外环阵元数', { min: 1, max: 32 }),
    gridN: int(3, '方阵阶数', { min: 1, max: 8, title: '方阵每边阵元数' }),
    turnsOuter: num(null, '', '外环圈数', { nullable: true, gt: 0, max: 40, title: '外环阵元圈数；留空同内环（赋形阵外环常矮于内环）' }),
    innerRM: num(null, 'm', '内环半径', { nullable: true, gt: 0, title: '留空：单环 0.75 λ、双环 0.9 λ（不小于接地杯不相碰的半径）' }),
    outerRM: num(null, 'm', '外环半径', { nullable: true, gt: 0, title: '留空 = 内环半径 + 1.4 λ' }),
    spacingM: num(null, 'm', '方阵间距', { nullable: true, gt: 0, title: '留空 = 0.75 λ' }),
    diameterM: num(null, 'm', '螺旋直径', { nullable: true, gt: 0, title: '留空 = λ/π（周长一个波长，轴向模中心）' }),
    pitchM: num(null, 'm', '螺距', { nullable: true, gt: 0, title: '留空 = 0.23 λ' }),
    wireDM: num(null, 'm', '线径', { nullable: true, gt: 0, title: '留空 = 0.13 × 螺旋直径' }),
    hand: HAND,
    cup: bool(true, '接地杯', { title: '阵元根部的浅圆筒接地杯（改善轴比、隔离相邻阵元）' }),
    cap: bool(false, '端帽', { title: '阵元顶端的锥形介质端帽' }),
    ground: enm('oct', ['circle', 'oct', 'square'], '底板外形', { optionLabels: { circle: '圆形', oct: '八边形', square: '方形' } }),
    groundRM: num(null, 'm', '底板半径', { nullable: true, gt: 0, title: '外接圆半径（方形为半边长）；留空 = 阵列外缘 + 0.35 λ' }),
    groundTM: num(null, 'm', '底板厚', { nullable: true, gt: 0, title: '留空 = 0.1 λ（不小于 6 mm）' }),
    coilMat: enm('gold_metal', ['gold_metal', 'copper', 'black_paint', 'white_paint', 'aluminum'], '螺旋线外表面', { optionLabels: COIL_LABELS }),
    groundMat: enm('mli_black', ['mli_black', 'mli_gold', 'white_paint', 'aluminum', 'black_paint'], '底板外表面', { optionLabels: GROUND_LABELS }),
    seg: int(16, '每圈分段', { min: 8, max: 48 })
  },
  validate: (p) => (p.layout === 'dual' && isNum(p.innerRM) && isNum(p.outerRM) && p.outerRM <= p.innerRM ? ['外环半径须大于内环半径'] : []),
  sockets: (p) => { const g = helixLayout(p); return [ROOT(Math.max(0.05, Math.min(2 * g.rg, 0.6)))] },
  // 阵元位置关于 xz 面对称（环阵相位取 0 或半格、方阵居中）；螺旋手性按镜像钩子保持（同一型号天线装在对称位置）
  mirrorPlanes: ['xz'],
  mirror: (p) => ({ ...p }),
  build(p, kit) {
    const ctx = kit.createCtx()
    const g = helixLayout(p)
    const part = { id: 'antenna', name: '螺旋天线', role: 'feed' }
    const hand = p.hand === 'lhcp' ? -1 : 1
    addHw(ctx, 'antenna', part, 'feed', p.groundMat, (put) => {
      if (p.layout !== 'single') groundPlate(put, { shape: p.ground, r: g.rg, t: g.tg, mat: p.groundMat, rimMat: 'aluminum' })
      else groundPlate(put, { shape: p.ground, r: Math.max(g.rg, 0.6 * g.cupD), t: Math.min(g.tg, 0.01), mat: p.groundMat })
      const z0 = p.layout === 'single' ? Math.min(g.tg, 0.01) : g.tg
      for (const e of g.els) {
        helixUnit(put, { base: [e.x, e.y, z0], axis: [0, 0, 1], ref: [1, 0, 0], R: g.Dh / 2, S: g.S, N: e.N, w: g.w, hand, cup: p.cup, cupD: g.cupD, cupH: g.cupH, cap: p.cap, mat: { coil: p.coilMat, cup: 'aluminum', support: p.coilMat === 'white_paint' ? 'aluminum' : 'white_paint', cap: 'black_paint' }, seg: p.seg })
      }
    })
    // 质量：阵元 helixMass × 个数（各在阵元中段）+ 底板 towerAreal（板）
    const zb = p.layout === 'single' ? Math.min(g.tg, 0.01) : g.tg
    g.els.forEach((e, i) => pointComp(ctx, `antenna_el${i + 1}`, ctx.dens.helixMass, [e.x, e.y, zb + 0.5 * g.S * e.N]))
    const gp = p.ground === 'square' ? outlinePoly('rect', g.rg, g.rg) : outlinePoly(p.ground === 'oct' ? 'oct' : 'circle', g.rg, g.rg, 48)
    const ga = polyArea(gp)
    plateComp(ctx, 'antenna_ground', ctx.dens.towerAreal * ga, [0, 0, zb / 2], IDR, Math.sqrt(ga), Math.sqrt(ga))
    const pp = ctx.parts.get('antenna')
    pp.normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', [0, 0, zb + 0.5 * g.S * p.turns], [0, 0, 1])
    return ctx
  }
}

// ───────────────────────────── 全向天线 ─────────────────────────────

const OMNI_FIN = Object.freeze({ aluminum: '本色铝', gold_metal: '镀金', copper: '裸铜', white_paint: '白漆', black_paint: '黑色' })
/** 全向天线推算尺寸 */
function omniDims(p) {
  const lam = lambdaOf(p.freqGHz)
  const L = isNum(p.lengthM) ? p.lengthM : lam / 4
  const rd = p.style === 'rod' ? (isNum(p.elementDM) ? p.elementDM / 2 : Math.max(0.0015, lam / 300)) : 0.0006
  const tw = p.style === 'tape' ? (isNum(p.elementDM) ? p.elementDM : 0.006) : 0
  const mast = isNum(p.mastLenM) ? p.mastLenM : (p.kind === 'dipole' ? lam / 4 : p.kind === 'conemast' ? 0.6 : 0)
  // 锥罩测控杆：罩高 1.18 λ、底半径 0.44 λ（不超过杆长的 0.6 / 罩高的 0.38），杆半径 0.26 λ（12–35 mm）
  const hc = Math.min(1.18 * lam, 0.6 * Math.max(mast, 0.05)), rc = Math.min(0.44 * lam, 0.38 * hc), rm = Math.max(0.006, Math.min(0.035, 0.26 * lam, 0.6 * rc))
  return { lam, L, rd, tw, mast, hc, rc, rm }
}

const omniAntenna = {
  type: 'sat.antenna.omni', domain: SAT, title: 'Omni / low-gain antenna', titleZh: '全向天线', role: 'feed', category: 'antenna',
  aliases: ['低增益', '单极子', '偶极子', '十字振子', '绕杆式', '四臂螺旋', 'QHA', '贴片', '扼流圈', 'GNSS', '测控', 'UHF', 'VHF', '鞭状', 'whip', 'monopole', 'dipole', 'turnstile', 'patch'],
  presets: [
    { id: 'monopole', titleZh: '单极子天线', title: 'Monopole antenna', aliases: ['鞭状', 'whip'], params: { kind: 'monopole' } },
    { id: 'dipole', titleZh: '半波偶极子天线', title: 'Half-wave dipole antenna', aliases: ['偶极子'], params: { kind: 'dipole' } },
    { id: 'tape', titleZh: '卷尺弹簧带天线', title: 'Tape-spring antenna', aliases: ['立方星', '展开天线', 'CubeSat'], params: { style: 'tape' } },
    { id: 'qha', titleZh: '四臂螺旋天线', title: 'Quadrifilar helix antenna', aliases: ['QHA', '四臂'], params: { kind: 'qha', freqGHz: 2.2 } },
    { id: 'qha-bare', titleZh: '四臂螺旋天线（无罩）', title: 'Quadrifilar helix antenna (bare)', aliases: ['QHA', '四臂'], params: { kind: 'qha', freqGHz: 2.2, radome: false } },
    { id: 'patch', titleZh: '贴片天线', title: 'Patch antenna', aliases: ['微带'], params: { kind: 'patch', freqGHz: 2.2 } },
    { id: 'gnss-choke', titleZh: '扼流圈 GNSS 天线', title: 'GNSS choke-ring antenna', aliases: ['扼流圈', 'GNSS', 'GPS', '精密定轨'], params: { kind: 'patch', freqGHz: 1.575, chokes: 4 } },
    { id: 'conemast', titleZh: '锥罩测控杆', title: 'Conical-radome TT&C mast', aliases: ['测控杆', 'S 频段', '导航星'], params: { kind: 'conemast', freqGHz: 2.2, mastLenM: 1.14, finish: 'black_paint' } }
  ],
  params: {
    kind: enm('turnstile', ['monopole', 'dipole', 'turnstile', 'qha', 'patch', 'conemast'], '形式', { optionLabels: { monopole: '单极子', dipole: '半波偶极子', turnstile: '绕杆式十字振子', qha: '四臂螺旋', patch: '贴片', conemast: '锥罩测控杆' }, title: '绕杆式：四根 λ/4 振子正交馈电（圆极化全向，小卫星 UHF / VHF 常用）；四臂螺旋：S / UHF 测控；贴片：GNSS / S 频段，可加扼流圈；锥罩测控杆：细长桅杆顶端白色锥形天线罩（导航星 S 频段测控）' }),
    freqGHz: num(0.437, 'GHz', '工作频率', { gt: 0, title: '尺寸按它推算：振子 λ/4、四臂螺旋罩 Ø0.3 λ × 0.65 λ、贴片 0.36 λ。UHF 0.437 / VHF 0.145 / S 2.2 / L1 1.575 GHz' }),
    lengthM: num(null, 'm', '振子长', { nullable: true, gt: 0, title: '单根振子 / 偶极子单臂长；留空 = λ/4' }),
    style: enm('rod', ['rod', 'tape'], '振子形式', { optionLabels: { rod: '圆杆', tape: '卷尺弹簧带' }, title: '卷尺弹簧带：收拢时卷绕、入轨后弹开（立方星展开天线）' }),
    elementDM: num(null, 'm', '振子直径', { nullable: true, gt: 0, title: '圆杆直径或卷尺带宽；留空：圆杆 λ/150（不小于 3 mm）、卷尺带 6 mm' }),
    mastLenM: num(null, 'm', '桅杆长', { nullable: true, min: 0, title: '振子下方的介质桅杆；留空：偶极子 λ/4，其余 0（直接装在面上）' }),
    cantDeg: num(0, '°', '振子倾角', { min: -60, max: 90, title: '绕杆式：振子与安装面的夹角（0 = 与安装面平行，正值向外翘）；偶极子：两臂下垂角' }),
    radome: bool(true, '天线罩', { title: '四臂螺旋 / 贴片 / 锥罩测控杆的白色天线罩（锥罩关 = 白漆锥头）' }),
    chokes: int(0, '扼流圈道数', { min: 0, max: 6, title: '贴片外圈的同心扼流槽（精密定轨 GNSS 天线 3–5 道，抑制多径）' }),
    hand: HAND,
    finish: enm('aluminum', ['aluminum', 'gold_metal', 'copper', 'white_paint', 'black_paint'], '振子外表面', { optionLabels: OMNI_FIN })
  },
  sockets: (p) => { const d = omniDims(p); return [ROOT(p.kind === 'patch' ? Math.max(0.03, (p.chokes > 0 ? 0.44 + 0.5 * p.chokes : 0.6) * d.lam) : p.kind === 'qha' ? 0.45 * d.lam : p.kind === 'conemast' ? 4.4 * d.rm : 0.04)] },
  mirrorPlanes: ['xz', 'yz'],
  mirror: (p) => ({ ...p }),
  build(p, kit) {
    const ctx = kit.createCtx()
    const d = omniDims(p)
    const part = { id: 'antenna', name: '全向天线', role: 'feed' }
    let res = null
    addHw(ctx, 'antenna', part, 'feed', p.finish, (put) => {
      if (p.kind === 'qha') res = qhaAntenna(put, { base: [0, 0, 0], dir: [0, 0, 1], up: [1, 0, 0], d: 0.3 * d.lam, H: 0.65 * d.lam, radome: p.radome, hand: p.hand === 'lhcp' ? -1 : 1, mat: { arm: p.finish === 'aluminum' ? 'copper' : p.finish, base: 'aluminum', tube: 'white_paint' } })
      else if (p.kind === 'patch') res = patchAntenna(put, { base: [0, 0, 0], dir: [0, 0, 1], up: [1, 0, 0], lam: d.lam, radome: p.radome, chokes: p.chokes, mat: { patch: p.finish === 'aluminum' ? 'copper' : p.finish, sub: 'white_paint', ground: 'aluminum' } })
      else if (p.kind === 'conemast') res = whipAntenna(put, { base: [0, 0, 0], dir: [0, 0, 1], up: [1, 0, 0], kind: 'conemast', mast: d.mast, mastR: d.rm, coneR: d.rc, coneH: d.hc, mat: { mast: p.finish, base: 'aluminum', cone: p.radome ? 'radome' : 'white_paint' } })
      else res = whipAntenna(put, { base: [0, 0, 0], dir: [0, 0, 1], up: [1, 0, 0], kind: p.kind, L: d.L, mast: d.mast, cant: p.cantDeg, style: p.style, rd: d.rd, tw: d.tw, mat: { elem: p.finish, base: 'aluminum', mast: 'white_paint' } })
    })
    const m = ctx.dens.lgaMass * (p.kind === 'patch' && p.chokes > 0 ? 1 + 1.5 * p.chokes : 1)
    pointComp(ctx, 'antenna', m, res.center)
    if (d.mast > 0.002 && p.kind !== 'qha' && p.kind !== 'patch') pointComp(ctx, 'antenna_mast', ctx.dens.boomLinear * d.mast * (p.kind === 'conemast' ? 1 : 0.3), [0, 0, d.mast / 2])
    ctx.parts.get('antenna').normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', res.center, [0, 0, 1])
    return ctx
  }
}

// ───────────────────────────── 多波束馈源阵 ─────────────────────────────

const CLUSTER_FIN = Object.freeze({ gold_metal: '镀金', aluminum: '本色铝', white_paint: '白漆', mli_gold: '金色 MLI' })
function clusterDims(p) {
  const L = isNum(p.lengthM) ? p.lengthM : 2.0 * p.hornDM
  const pitch = isNum(p.pitchM) ? p.pitchM : 1.2 * p.hornDM
  const backH = isNum(p.backHM) ? p.backHM : L
  const plateT = Math.max(0.006, 0.12 * p.hornDM)
  const plateR = p.rings * pitch + 0.62 * pitch + 0.15 * p.hornDM / 2
  return { L, pitch, backH, plateT, plateR, top: backH + plateT + L }
}

const feedCluster = {
  type: 'sat.feed.cluster', domain: SAT, title: 'Multibeam feed array', titleZh: '多波束馈源阵', role: 'feed', category: 'antenna',
  aliases: ['馈源阵', '馈源簇', '喇叭阵', '多波束', 'HTS', '点波束', 'SFB', '焦面阵', 'feed array', 'feed cluster'],
  presets: [
    { id: 'ge61', titleZh: '61 元馈源阵', title: '61-horn feed array', aliases: ['61', '锗膜'], params: { rings: 4, style: 'terraced', cap: 'ge' } }
  ],
  params: {
    rings: int(2, '环数', { min: 0, max: 6, title: '六边形密排环数：喇叭数 = 3r(r+1)+1（0 / 1 / 2 / 3 / 4 / 5 / 6 环 = 1 / 7 / 19 / 37 / 61 / 91 / 127 只）' }),
    hornDM: num(0.05, 'm', '喇叭口径', { gt: 0, title: '单只喇叭口面内径（单馈源单波束：Ka 频段约 1.5–3 λ = 25–50 mm）' }),
    lengthM: num(null, 'm', '喇叭长', { nullable: true, gt: 0, title: '留空 = 2 × 喇叭口径' }),
    pitchM: num(null, 'm', '喇叭间距', { nullable: true, gt: 0, title: '相邻喇叭中心距；留空 = 1.2 × 口径（口沿外径 1.15 × 口径，密排）' }),
    style: enm('smooth', ['smooth', 'terraced', 'conical'], '喇叭外形', { optionLabels: { smooth: '光壁样条', terraced: '台阶锥', conical: '直锥' } }),
    finish: enm('gold_metal', ['gold_metal', 'aluminum', 'white_paint', 'mli_gold'], '喇叭外表面', { optionLabels: CLUSTER_FIN }),
    cap: enm('none', ['none', 'ge', 'white'], '口面遮阳膜', { optionLabels: { none: '无', ge: '锗膜', white: '白膜' } }),
    plate: enm('hex', ['hex', 'circle'], '安装板', { optionLabels: { hex: '六边形', circle: '圆形' } }),
    backHM: num(null, 'm', '后端舱高', { nullable: true, min: 0, title: '馈电链 / 波束形成网络舱（金色 MLI）高度；留空 = 喇叭长，0 = 无' }),
    seg: int(16, '分段', { min: 8, max: 48 })
  },
  // root = 安装面（后端舱底）；aperture = 口面中心（接反射面焦点插座时用它当安装端：口面朝口径中心），只收馈源链与基本体占位
  sockets: (p) => { const d = clusterDims(p); return [ROOT(2 * d.plateR, 60), sock('aperture', [0, 0, d.top], [0, 0, 1], [1, 0, 0], 2 * d.plateR, 60, FEED_CHAIN_ACCEPTS)] },
  symmetricPlanes: ['yz', 'xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const d = clusterDims(p)
    const part = { id: 'feed', name: '多波束馈源阵', role: 'feed' }
    let res = null
    addHw(ctx, 'feed', part, 'feed', p.finish, (put) => {
      res = hornCluster(put, { rings: p.rings, D: p.hornDM, pitch: d.pitch, L: d.L, style: p.style, finish: p.finish, cap: p.cap, plate: p.plate, plateT: d.plateT, backH: d.backH, seg: p.seg })
    })
    // 质量：每只喇叭按外包锥面 × hornAreal（点质量在喇叭中段）、安装板 / 后端舱按 towerAreal（板 / 盒壳）
    const a = p.hornDM / 2, r1 = 0.7 * a, r2 = 1.15 * a
    const mh = ctx.dens.hornAreal * Math.PI * (r1 + r2) * Math.hypot(r2 - r1, d.L)
    res.points.forEach(([x, y], i) => pointComp(ctx, `feed_h${i + 1}`, mh, [x, y, res.plateTop + 0.55 * d.L]))
    const poly = p.plate === 'circle' ? outlinePoly('circle', res.plateR, res.plateR, 48) : outlinePoly('hex', res.plateR, res.plateR * Math.sqrt(3) / 2)
    const A = polyArea(poly)
    plateComp(ctx, 'feed_plate', 2 * ctx.dens.towerAreal * A, [0, 0, d.backH + d.plateT / 2], IDR, Math.sqrt(A), Math.sqrt(A))
    if (d.backH > 0) pointComp(ctx, 'feed_back', ctx.dens.towerAreal * (0.81 * A + 3.3 * res.plateR * d.backH), [0, 0, d.backH / 2])
    const pp = ctx.parts.get('feed')
    pp.normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', [0, 0, d.top], [0, 0, 1])
    return ctx
  }
}

// ───────────────────────────── 激光通信终端 ─────────────────────────────

const LCT_BODY = Object.freeze({ white_paint: '白漆', black_paint: '黑色阳极化', mli_black: '黑色 MLI', mli_gold: '金色 MLI', aluminum: '本色铝' })

const laserTerminal = {
  type: 'sat.lct', domain: SAT, title: 'Laser communication terminal', titleZh: '激光通信终端', role: 'feed', category: 'payload',
  aliases: ['激光', '光通信', '星间激光', 'LCT', 'OISL', 'ISL', '激光链路', '光学终端'],
  presets: [
    { id: 'periscope', titleZh: '潜望式激光终端', title: 'Periscope laser terminal', aliases: ['潜望'], params: { type: 'periscope' } }
  ],
  params: {
    type: enm('gimbal', ['gimbal', 'periscope'], '型式', { optionLabels: { gimbal: '镜筒式（双轴叉架）', periscope: '潜望式' }, title: '镜筒式：望远镜整体在方位-俯仰叉架上转；潜望式：转台转方位、头内反射镜扫俯仰，外面只见转台转动' }),
    apertureM: num(0.08, 'm', '通光口径', { gt: 0, title: '望远镜通光口径：低轨星间 60–100 mm、高轨中继 135 mm' }),
    ...POINT_PARAMS,
    body: enm('white_paint', ['white_paint', 'black_paint', 'mli_black', 'mli_gold', 'aluminum'], '光学头外表面', { optionLabels: LCT_BODY }),
    mech: enm('mli_black', MECH_OPTIONS, '机构外表面', { optionLabels: MECH_LABELS }),
    electronics: bool(true, '电子单元', { title: '底座下的终端电子箱（光学头抬到箱顶）' }),
    postHM: num(null, 'm', '转轴高', { nullable: true, gt: 0, title: '俯仰轴离底座高度；留空按口径推算' }),
    articulate: bool(true, '转动关节', { title: 'AGI 关节：零位 = 设定指向' })
  },
  sockets: (p) => [ROOT(Math.max(0.08, (p.electronics ? 3.2 : 2) * p.apertureM))],
  symmetricPlanes: (p) => pointSym(p.azDeg, p.tiltDeg),
  build(p, kit) {
    const ctx = kit.createCtx()
    const D = p.apertureM
    const part = { id: 'lct', name: '激光通信终端', role: 'feed' }
    const m = { body: p.body, mech: p.mech, metal: 'aluminum' }
    const eh = p.electronics ? Math.max(0.03, 1.1 * D) : 0
    if (eh > 0) addHw(ctx, 'lct_box', part, 'feed', p.mech, (put) => {
      // 电子箱：3.2 D × 2.6 D × eh（倒角盒）+ ±X 两端各一只接插件座（关于 xz / yz 两面对称）
      boxBevel(put(p.mech), [0, 0, eh / 2], [1.6 * D, 1.3 * D, eh / 2], 0.08 * D)
      for (const s of [1, -1]) boxBevel(put('aluminum'), [s * (1.6 * D + 0.008), 0, 0.45 * eh], [0.008, 0.3 * D, 0.18 * eh], 0.002)
    })
    let win = null, bore = null, mechAt = null
    if (p.type === 'periscope') {
      const g = { rb: 1.5 * D, ra: 1.15 * D, hz: 0.5 * D }
      const R = azFrame(p.azDeg), t = [0, 0, eh]
      addHwAt(ctx, 'lct_base', part, 'feed', p.mech, IDR, [0, 0, eh], (put) => azelBase(put, g, m))
      let r = null
      const hd = addHwAt(ctx, 'lct_head', part, 'feed', p.body, R, t, (put) => { r = periscopeHead(put, { z0: 0.5 * g.hz, D, tiltDeg: p.tiltDeg, m }) })
      if (p.articulate !== false) ctx.arts.push({ name: 'lct_azimuth', nodes: hd.items.map((it) => it.name), stages: [stage('azimuth', 'zRotate', -180, 180, 0)] })
      win = inN(R, t, r.window); bore = pointDir(p.azDeg, p.tiltDeg); mechAt = [0, 0, eh + 0.6 * D]
    } else {
      const r = buildPointing(ctx, { ...p, mech: p.mech }, {
        kind: 'azel', S: 3.2 * D, pre: 'lct_', part, role: 'feed', mainMat: p.body, base0: eh,
        drawPayload: (put, Fp, zBack) => ({ ap: lctHead(put, Fp, D, m, zBack).window })
      })
      win = r.ap; bore = r.bore; mechAt = r.mechAt
    }
    // 质量：lctMass × (口径 / 80 mm)²（点质量在机构中部）
    pointComp(ctx, 'lct', ctx.dens.lctMass * (D / 0.08) ** 2, mechAt)
    ctx.parts.get('lct').normalBody = bore.slice()
    apLocal(ctx, 'boresight', win, bore)
    return ctx
  }
}
/** 局部系里的倒角盒（组件局部系） */
function boxBevel(mb, c, h, b) { bevelBox(mb, LOCAL_F, c, h, b) }
const LOCAL_F = Object.freeze({ o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] })


// ───────────────────────────── 对数周期天线 ─────────────────────────────

const LPDA_FIN = Object.freeze({ black_paint: '黑色', aluminum: '本色铝', gold_metal: '镀金', white_paint: '白漆' })
const lpdaRods = (p) => { const lam = lambdaOf(p.fLowGHz); return { mr: isNum(p.mastDM) ? p.mastDM / 2 : Math.max(0.006, 0.006 * lam), er: isNum(p.elementDM) ? p.elementDM / 2 : Math.max(0.003, 0.0035 * lam) } }

const lpda = {
  type: 'sat.antenna.lpda', domain: SAT, title: 'Log-periodic dipole antenna', titleZh: '对数周期天线', role: 'feed', category: 'antenna',
  aliases: ['对数周期', 'LPDA', '圣诞树', '宽带', 'VHF', 'UHF', 'W 传感器', '核爆探测', 'log-periodic'],
  params: {
    fLowGHz: num(0.15, 'GHz', '最低频率', { gt: 0, title: '最长振子全长 = λ(最低频率)/2' }),
    fHighGHz: num(0.4, 'GHz', '最高频率', { gt: 0, title: '层数 N = ⌈ln(最高 / 最低频率) / ln(1/τ)⌉ + 2' }),
    tau: num(0.85, '', '比例因子 τ', { min: 0.7, max: 0.97, title: '相邻两层振子长度与层距之比（Carrel 设计参数，0.8–0.95；越大增益越高、层数越多）' }),
    sigma: num(0.07, '', '间距因子 σ', { min: 0.03, max: 0.25, title: '层距 / (2 × 振子全长)（0.05–0.18）' }),
    crossed: bool(true, '十字交叉', { title: '每层两根正交振子（±45°，双极化 / 圆极化）；关 = 单线极化' }),
    standoffM: num(0.05, 'm', '根部杆长', { min: 0, title: '杆根到第一层（最长）振子的距离' }),
    mastDM: num(null, 'm', '集合线直径', { nullable: true, gt: 0, title: '竖杆（集合线）外径；留空 = 0.012 λ（最低频率），不小于 12 mm' }),
    elementDM: num(null, 'm', '振子直径', { nullable: true, gt: 0, title: '留空 = 0.007 λ（最低频率），不小于 6 mm' }),
    finish: enm('black_paint', ['black_paint', 'aluminum', 'gold_metal', 'white_paint'], '外表面', { optionLabels: LPDA_FIN })
  },
  validate: (p) => (p.fHighGHz > p.fLowGHz ? [] : ['最高频率须大于最低频率']),
  sockets: (p) => [ROOT(Math.max(0.03, 2.4 * lpdaRods(p).mr * 2), 15)],
  // 十字振子 ±45°、单线振子沿 x：两种都关于 xz 与 yz 面对称
  symmetricPlanes: ['yz', 'xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'antenna', name: '对数周期天线', role: 'feed' }
    const { mr, er } = lpdaRods(p)
    let r = null
    addHw(ctx, 'antenna', part, 'feed', p.finish, (put) => { r = lpdaAntenna(put, { fL: p.fLowGHz, fH: p.fHighGHz, tau: p.tau, sigma: p.sigma, crossed: p.crossed, standoff: p.standoffM, mastR: mr, elemR: er, mat: { elem: p.finish, mast: p.finish } }) })
    // 质量：竖杆按杆件线密度、振子按其 1/4（细杆）——GPS IIR 低频 W 传感器（6 层十字振子、最长 3.28 m）按此式约 9 kg
    const m = ctx.dens.boomLinear * (r.height + 0.25 * r.totalElem)
    pointComp(ctx, 'antenna', m, [0, 0, 0.4 * r.height])
    ctx.parts.get('antenna').normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', [0, 0, 0.5 * r.height], [0, 0, 1])
    return ctx
  }
}

// ───────────────────────────── 天线罩 ─────────────────────────────

const SHROUD_FIN = Object.freeze({ mli_black: '黑色 MLI', mli_silver: '银色 MLI', mli_gold: '金色 MLI', radome: '白色介质罩', kapton_black: '黑色聚酰亚胺' })
const antennaShroud = {
  type: 'sat.antenna.shroud', domain: SAT, title: 'Antenna shroud / radome', titleZh: '天线罩', role: 'other', category: 'antenna',
  aliases: ['天线罩', '隔热罩', '多面体', '透波', '导航天线罩', 'radome', 'shroud'],
  presets: [
    { id: 'dome', titleZh: '圆顶天线罩', title: 'Dome radome', aliases: ['圆顶', '介质罩'], params: { style: 'dome', finish: 'radome', baseDM: 0.6, heightM: 0.5 } }
  ],
  params: {
    style: enm('faceted', ['faceted', 'dome'], '形式', { optionLabels: { faceted: '多面体隔热罩', dome: '圆顶天线罩' }, title: '多面体隔热罩：八边形底 → 十六边形平顶的折面透波 MLI 帐（导航星 L 频段阵外罩）；圆顶天线罩：圆柱段 + 椭球顶白色介质罩' }),
    baseDM: num(1.5, 'm', '底宽', { gt: 0, title: '底面对边距（圆顶罩为直径）' }),
    topDM: num(0.95, 'm', '顶宽', { gt: 0, title: '顶面直径（多面体罩）' }),
    heightM: num(0.63, 'm', '高', { gt: 0 }),
    finish: enm('mli_black', ['mli_black', 'mli_silver', 'mli_gold', 'radome', 'kapton_black'], '外表面', { optionLabels: SHROUD_FIN })
  },
  validate: (p) => (p.style !== 'faceted' || p.topDM <= p.baseDM * 1.08 ? [] : ['顶宽不宜大于底宽']),
  sockets: (p) => [ROOT(p.baseDM, 15), sock('top', [0, 0, p.heightM], [0, 0, 1], [1, 0, 0], p.style === 'dome' ? 0.3 * p.baseDM : p.topDM, 15)],
  faces: (p) => (p.style === 'dome' ? [] : [{ id: 'top', kind: 'plane', origin: [0, 0, p.heightM], n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], halfU: 0.45 * p.topDM, halfV: 0.45 * p.topDM }]),
  symmetricPlanes: ['yz', 'xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'shroud', name: '天线罩', role: 'other' }
    let r = null
    addHw(ctx, 'shroud', part, 'other', p.finish, (put) => { r = shroud(put, { style: p.style, rb: p.baseDM / 2, rt: p.topDM / 2, H: p.heightM, mat: p.finish }) })
    // 质量：透波 MLI / 介质罩按多层隔热面密度的 3 倍（含支撑骨架）
    pointComp(ctx, 'shroud', 3 * ctx.dens.mliAreal * r.area, [0, 0, 0.5 * p.heightM])
    ctx.parts.get('shroud').areaM2 = r.area
    return ctx
  }
}

// ───────────────────────────── 缝隙波导阵 ─────────────────────────────

const slotArray = {
  type: 'sat.antenna.slot', domain: SAT, title: 'Slotted waveguide array', titleZh: '缝隙波导阵', role: 'feed', category: 'antenna',
  aliases: ['缝隙', '波导', '棒条', '一网', 'Ku 用户天线', '扇形波束', 'slot', 'waveguide'],
  params: {
    bars: int(8, '棒条数', { min: 1, max: 32 }),
    freqGHz: num(12, 'GHz', '工作频率', { gt: 0, title: '棒条尺寸按它推算：棒宽约 0.9 λ、高约 2.8 λ、辐射口间距约 0.55 λ' }),
    lengthM: num(0.45, 'm', '棒长', { gt: 0, title: '棒条沿局部 X 的长度（决定该向波束宽度：窄的南北向波束要长棒）' }),
    pitchM: num(null, 'm', '棒间距', { nullable: true, gt: 0, title: '相邻棒条中心距；留空 = 1.2 × 棒宽' }),
    fanDeg: num(3, '°', '扇形外倾', { min: 0, max: 20, title: '相邻棒条绕长轴的外倾角差（扇形排开，每根棒对应一个固定波束）；0 = 平行' }),
    finish: enm('aluminum', ['aluminum', 'gold_metal', 'white_paint', 'black_paint'], '外表面', { optionLabels: { aluminum: '本色铝', gold_metal: '镀金', white_paint: '白漆', black_paint: '黑色阳极化' } })
  },
  sockets: (p) => { const d = slotDims(p); return [ROOT(Math.min(p.lengthM, (p.bars - 1) * d.pitch + d.w), 90)] },
  symmetricPlanes: ['yz', 'xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const d = slotDims(p)
    const part = { id: 'antenna', name: '缝隙波导阵', role: 'feed' }
    let r = null
    addHw(ctx, 'antenna', part, 'feed', p.finish, (put) => { r = slotBars(put, { n: p.bars, L: p.lengthM, w: d.w, h: d.h, pitch: d.pitch, fanDeg: p.fanDeg, slots: d.slots, mat: { bar: p.finish, base: 'mli_gold' } }) })
    // 质量：铝波导壁（1 mm）按喇叭面密度 × 棒条展开面积 + 安装板
    const mBars = ctx.dens.hornAreal * p.bars * p.lengthM * 2 * (d.w + d.h)
    plateComp(ctx, 'antenna', mBars + ctx.dens.mliAreal * r.plate[0] * r.plate[1], [0, 0, 0.5 * r.top], IDR, r.plate[0], r.plate[1])
    ctx.parts.get('antenna').normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', [0, 0, r.top], [0, 0, 1])
    return ctx
  }
}
function slotDims(p) {
  const lam = lambdaOf(p.freqGHz), w = 0.9 * lam, h = 2.8 * lam
  return { w, h, pitch: isNum(p.pitchM) ? p.pitchM : 1.2 * w, slots: Math.max(2, Math.round(p.lengthM / (0.55 * lam))) }
}

// ───────────────────────────── 消旋天线 ─────────────────────────────
//
// 自旋稳定星（自旋轴 = 安装面法向 = 局部 Z）上「不随星转」的对地天线：
//   电子消旋阵（eda）：圆柱面上一圈辐射单元列，星体每转一圈馈电逐列切到对地那一侧——外形是静止的栅格圆柱，无关节；
//     视轴 = 设定的波束方位 / 仰角，挂点在圆柱面上视轴所指处（Meteosat 第二代 L 频段、风云二号 S 频段）。
//   机械消旋（mech）：底座 BAPTA（轴承与功率传输组件，随星转）→ 消旋桅杆（以星体转速反向转动）→ 俯仰轴 → 正馈抛物面
//     （休斯 HS-376、国际通信卫星 6 号这类双自旋星）。节点：bapta 静止；mast 节点系 N = 方位 φ 已转好（x = 水平视轴方向、
//     y = 俯仰轴、z = 自旋轴），关节 despin [zRotate]；dish 同一节点系、几何按仰角 e 烘焙，关节 [zRotate 消旋, +zP, yRotate 俯仰, −zP]
//     （俯仰轴在桅杆顶 z = zP；yRotate 正值使仰角减小）。

const DESPUN_FIN = Object.freeze({ aluminum: '本色铝', mli_silver: '银色 MLI', gold_metal: '镀金', white_paint: '白漆' })
/** 消旋天线推算尺寸（米） */
function despunDims(p) {
  const D = p.diameterM
  if (p.kind === 'eda') return { discD: isNum(p.discDM) ? p.discDM : 1.15 * D, mastH: isNum(p.mastHM) ? p.mastHM : 0.32 * D, mastD: 0.215 * D, rodH: 0.15 * D }
  const dB = Math.max(0.25, 0.22 * D), hB = 0.6 * dB, mastH = isNum(p.mastHM) ? p.mastHM : 0.55 * D + 0.1
  return { dB, hB, mastH, zP: hB + mastH, rm: Math.max(0.03, 0.18 * dB) }
}
/** 视轴（垂直于自旋轴的平面内方位 φ、仰角 e）→ 单位向量 */
const horizDir = (phiDeg, eDeg) => { const p = phiDeg * DEG, e = eDeg * DEG; return [Math.cos(e) * Math.cos(p), Math.cos(e) * Math.sin(p), Math.sin(e)].map(z0) }
/** 视轴落在哪个局部面内：方位 ≡ 0（mod 180°）→ xz、≡ 90° → yz（几何关于该面对称，挂点视轴也在面内） */
function horizSym(phiDeg) { const m = ((phiDeg % 180) + 180) % 180; return m === 0 ? ['xz'] : m === 90 ? ['yz'] : [] }

const despunAntenna = {
  type: 'sat.antenna.despun', domain: SAT, title: 'Despun antenna', titleZh: '消旋天线', role: 'feed', category: 'antenna',
  aliases: ['消旋', '电子消旋', '机械消旋', '自旋稳定', '双自旋', '太阳鼓', 'EDA', 'BAPTA', 'despun', 'spinner', 'Meteosat', '风云二号'],
  presets: [
    { id: 'mech', titleZh: '机械消旋天线', title: 'Mechanically despun antenna', aliases: ['BAPTA', 'HS-376', '双自旋'], params: { kind: 'mech', diameterM: 1.8 } }
  ],
  params: {
    kind: enm('eda', ['eda', 'mech'], '消旋方式', { optionLabels: { eda: '电子消旋阵', mech: '机械消旋' }, title: '电子消旋：圆柱面上一圈辐射单元列，星体自旋时逐列切换馈电、波束始终对地（Meteosat 第二代、风云二号）；机械消旋：轴承与功率传输组件（BAPTA）带天线反向转动、抵消星体自旋（休斯 HS-376、国际通信卫星 6 号）' }),
    diameterM: num(1.3, 'm', '口径', { gt: 0, title: '电子消旋阵为圆柱直径（Meteosat 第二代约 1.3 m）；机械消旋为反射面口径' }),
    heightM: num(0.5, 'm', '阵高', { gt: 0, title: '电子消旋阵圆柱高' }),
    columns: int(32, '单元列数', { min: 6, max: 96, title: '圆周上的辐射单元列数（列间距约半个波长）' }),
    rows: int(4, '每列单元数', { min: 1, max: 16 }),
    discDM: num(null, 'm', '顶盘直径', { nullable: true, min: 0, title: '电子消旋阵顶端白色顶盘；留空 = 1.15 × 阵直径，0 = 无' }),
    mastHM: num(null, 'm', '桅杆高', { nullable: true, min: 0, title: '电子消旋：顶端测控桅杆高（留空 = 0.32 × 阵直径，0 = 无）；机械消旋：消旋桅杆高（留空 = 0.55 × 口径 + 0.1 m，反射面下缘高出安装面）' }),
    azDeg: num(0, '°', '波束方位', { min: -180, max: 180, title: '视轴在垂直于自旋轴（局部 Z）的平面内的方位：自局部 +X 起逆时针' }),
    elevDeg: num(0, '°', '波束仰角', { min: -45, max: 45, title: '视轴偏离该平面的角度，朝局部 +Z 为正' }),
    fD: num(0.4, '', '焦径比', { gt: 0.1, max: 2, title: '机械消旋反射面焦距 / 口径' }),
    finish: enm('aluminum', ['aluminum', 'mli_silver', 'gold_metal', 'white_paint'], '栅格外表面', { optionLabels: DESPUN_FIN }),
    front: enm('white', ['white', 'black', 'sunshield', 'silver'], '反射面外观', { optionLabels: { white: '白漆', black: '消光黑漆', sunshield: '锗膜遮阳罩', silver: '银色遮阳罩' } }),
    articulate: bool(true, '转动关节', { title: '机械消旋的 AGI 关节：消旋（绕局部 Z）+ 俯仰；零位 = 设定指向' }),
    seg: int(48, '分段', { min: 16, max: 128 })
  },
  sockets: (p) => [ROOT(p.kind === 'eda' ? 0.9 * p.diameterM : despunDims(p).dB, 15)],
  symmetricPlanes: (p) => { const s = horizSym(p.azDeg); return p.kind === 'eda' && p.columns % 2 ? s.filter((x) => x === 'xz') : s },
  build(p, kit) {
    const ctx = kit.createCtx()
    const d = despunDims(p), D = p.diameterM, bore = horizDir(p.azDeg, p.elevDeg)
    const part = { id: 'antenna', name: '消旋天线', role: 'feed' }
    if (p.kind === 'eda') {
      let r = null
      addHw(ctx, 'antenna', part, 'feed', p.finish, (put) => {
        r = edaArray(put, { D, H: p.heightM, nc: p.columns, nr: p.rows, discD: d.discD, mastH: d.mastH, mastD: d.mastD, rodH: d.mastH > 0 ? d.rodH : 0, mat: p.finish, seg: p.seg })
      })
      // 质量：阵面 arrayAreal × 圆柱侧面积（薄壁圆筒）+ 顶盘 towerAreal + 桅杆 boomLinear
      const R = D / 2, m = ctx.dens.arrayAreal * 2 * Math.PI * R * p.heightM, zt = r.zMid + p.heightM / 2
      const Ix = m * (R * R / 2 + p.heightM * p.heightM / 12)
      comp(ctx, 'antenna_array', 'shell', m, [0, 0, r.zMid], [Ix, 0, 0, 0, Ix, 0, 0, 0, m * R * R])
      if (d.discD > 0) plateComp(ctx, 'antenna_disc', ctx.dens.towerAreal * Math.PI * d.discD * d.discD / 4, [0, 0, zt], IDR, discPlate(d.discD / 2), discPlate(d.discD / 2))
      if (d.mastH > 0) rodComp(ctx, 'antenna_mast', [0, 0, zt], [0, 0, zt + d.mastH])
      ctx.parts.get('antenna').normalBody = bore.slice()
      apLocal(ctx, 'boresight', [R * Math.cos(p.azDeg * DEG), R * Math.sin(p.azDeg * DEG), r.zMid].map(z0), bore)
      return ctx
    }
    const c = Math.cos(p.azDeg * DEG), s = Math.sin(p.azDeg * DEG)
    const RN = [[c, s, 0].map(z0), [-s, c, 0].map(z0), [0, 0, 1]], T0 = [0, 0, 0]
    const front = FRONT_MAT[p.front] || 'reflector'
    addHw(ctx, 'bapta', part, 'feed', 'mli_gold', (put) => {
      cyl(put('aluminum'), [0, 0, 0], [0, 0, 0.012], 0.62 * d.dB, p.seg, false, true)
      cyl(put('mli_gold'), [0, 0, 0.012], [0, 0, d.hB], d.dB / 2, p.seg, false, true)
    })
    const mast = addHwAt(ctx, 'mast', part, 'feed', 'aluminum', RN, T0, (put) => {
      cyl(put('aluminum'), [0, 0, d.hB], [0, 0, d.zP], d.rm, 24, false, false)
      cyl(put('dark_metal'), [0, -0.55 * d.dB, d.zP], [0, 0.55 * d.dB, d.zP], 0.8 * d.rm, 20, true, true)
    })
    const e = p.elevDeg * DEG, bN = [Math.cos(e), 0, Math.sin(e)].map(z0), P = [0, 0, d.zP]
    const t = Math.max(0.004, 0.012 * D), hubH = Math.max(0.01, 0.06 * D), zv = d.rm + t + hubH, f = p.fD * D
    const Fd = frameZX(P, bN, [0, 0, 1])
    let dish = null
    const dn = addHwAt(ctx, 'dish', part, 'feed', front, RN, T0, (put) => {
      cyl(put('titanium'), P, madd(P, bN, zv - t - hubH), 0.55 * d.rm, 16, false, true)
      dish = dishAntenna(put, { F: Fd, zv, D, f, front, rear: 'carbon', feed: 'prime', struts: 4, feedMat: 'gold_metal', seg: p.seg, nr: 10 })
    })
    if (p.articulate !== false) {
      const despin = stage('despin', 'zRotate', -180, 180, 0)
      ctx.arts.push({ name: 'despin', nodes: mast.items.map((it) => it.name), stages: [despin] })
      ctx.arts.push({ name: 'elevation', nodes: dn.items.map((it) => it.name), stages: [despin, stage('toAxis', 'zTranslate', d.zP, d.zP, d.zP), stage('elevation', 'yRotate', p.elevDeg - 45, p.elevDeg + 45, 0), stage('fromAxis', 'zTranslate', -d.zP, -d.zP, -d.zP)] })
    }
    // 质量：BAPTA baptaMass + 消旋桅杆 boomLinear + 反射面 reflectorAreal（圆盘惯量，质心在口面中段）
    pointComp(ctx, 'antenna_bapta', ctx.dens.baptaMass, [0, 0, d.hB / 2])
    rodComp(ctx, 'antenna_mast', [0, 0, d.hB], [0, 0, d.zP])
    const Rd = D / 2, cN = madd(P, bN, zv + 0.5 * Rd * Rd / (4 * f))
    plateComp(ctx, 'antenna_dish', ctx.dens.reflectorAreal * Math.PI * Rd * Rd, rApply(RN, cN).map(z0), [rApply(RN, Fd.x), rApply(RN, Fd.y), rApply(RN, Fd.z)], discPlate(Rd), discPlate(Rd))
    const pp = ctx.parts.get('antenna')
    pp.areaM2 = Math.PI * Rd * Rd; pp.normalBody = bore.slice()
    apLocal(ctx, 'boresight', rApply(RN, dish.focus).map(z0), bore)
    return ctx
  }
}

export const SAT_ANTENNA_COMPONENTS = Object.freeze([gimbalDish, helixAntenna, omniAntenna, feedCluster, laserTerminal, lpda, antennaShroud, slotArray, despunAntenna])
