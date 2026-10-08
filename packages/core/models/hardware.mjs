// 星上硬件造型库（2026-10-08）：馈源喇叭与馈电链、钟形喷管（10 N 姿控 / 400–500 N 远地点发动机）、霍尔推力器、星敏感器、
// 太阳 / 地球敏感器、测控全向天线（双锥 / 宽波束喇叭）、SADA 护套与翼根支座、星箭对接环 V 形法兰。
//
// 为什么（2026-10-08 用户：「设计中卫星组件的反射面、馈源、还有各个小组件，准确度也不足，整体模型这块我要最佳实现」）：
//   原先这些件是光秃截锥 / 方块（喇叭 = 薄壁圆锥、喷管 = 锥、星敏 = 方块 + 黑锥、霍尔 = 圆筒），尺寸也偏（10 N 喷口画成 Ø60 mm、
//   SADA 画成 Ø0.3 m 的大鼓、霍尔放电通道宽了一半）。本库按调研的真实硬件比例重做（调研记录：会话 scratchpad/research/comp，
//   出处逐条在各函数注释里；数值是「典型件 + 按比例缩放」，具体型号的尺寸不公开时为示意）。
//
// 口径：
//   · 纯网格、零 three 依赖；只依赖 meshKit（MB / lathe / frustum …）与 fleet/kit（局部系、定向盒、棱柱）。不登记节点 / 质量元 ——
//     调用方（paramBus 子生成器、装配组件、星座精模）照旧登记，造型细部不改质量模型。
//   · put(matKey) → MB：按材质分桶取网格（调用方决定一个材质落一个节点还是并进同一节点）。材质键是 paramBus.MATERIALS 的语义键。
//   · 位置 / 方向一律在调用方给的坐标系里（本体系或组件局部系），米制、double。
//   · 每个函数返回关键锚点（支架落脚点、背面中心……），供调用方接支撑结构。
//
// 导出：feedHorn / feedChain / bellNozzle / rcsPod / hallThruster / starTrackerHead / wedgeMount / sunSensor / earthSensor / ttcBicone / wcaHorn /
//       rimFrame / reflectorBacking / adtmBlock / sadaBoot / lvRing / BELL_TABLE

import { lathe, frustum, perpPair, MB } from './meshKit.mjs'
import { frameZX, toW, dirW, obox, bevelBox, prism, cyl, disc, ring, fan, quadPts, nrm, madd, add, scl, sub, cross, len } from './fleet/kit.mjs'

export { MB }

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const DEG = Math.PI / 180
/** 轴向局部系：原点 o、z = dir、x 取 up 去掉 z 分量（up ∥ dir 时退回 perpPair） */
const axisFrame = (o, dir, up) => frameZX(o, nrm(dir), up || null)
/** 在局部系 F 里画回转体：轮廓 (r, z) 以 F.o 为起点、沿 F.z 展开 */
const latheF = (mb, F, prof, seg, o) => lathe(mb, F.o, F.z, prof, seg, o)

// ───────────────────────────── 馈源喇叭 ─────────────────────────────

/**
 * 馈源喇叭（波纹锥喇叭为缺省；调研 research/comp/part_feeds.md §2–§6）：
 *   外形 = 输入法兰 + 外壳（台阶锥 'terraced' / 平滑锥 'smooth' / 外环肋近圆柱 'ribbed'——E3000 白漆喇叭）+ 口沿唇环 + 口面金属环；
 *   内腔 = 口部几圈波纹槽（近看可见的同心台阶）+ 内锥一直收到喉部 + 喉部暗盘。可选口面遮阳膜（白 / 锗膜深灰）。
 *   比例（a = 口径内半径）：外壳喉部 0.62 a → 口部 1.23 a、法兰 0.78 a、唇环 1.30 a、长 L ≈ 2.12 D（窄张角 12° 的波纹喇叭）。
 * o = { ap 口面中心, dir 波束方向（出口朝向）, up?, D 口径（内径）, L? 长（法兰面 → 口面，缺省 2.12 D）, style?:'terraced'|'smooth'|'ribbed'|'profiled',
 *       mat?:{body, rim, inner, cap}, cap?:'white'|'ge'|null, seg? }
 * 'profiled'：光壁样条 / 多模喇叭（铜金色「喇叭花」：细腰、外翻口沿）。
 * @returns {{throat:number[], back:number[], rOut:number}} throat = 法兰背面中心；rOut = 最大外半径
 */
export function feedHorn(put, o) {
  const D = o.D, a = D / 2, L = isNum(o.L) ? o.L : 2.12 * D
  const style = o.style || 'terraced'
  const seg = o.seg || 32
  const m = { body: 'white_paint', rim: 'gold_metal', inner: 'black_paint', ...(o.mat || {}) }
  const d = nrm(o.dir)
  const throat = madd(o.ap, d, -L)
  const F = axisFrame(throat, d, o.up)
  const P = (r, z) => [r * a, z * L]       // r 以 a 计、z 以 L 计
  let outer
  if (style === 'profiled') {
    // 光壁样条喇叭：方法兰座 → 细腰（0.55 口径、25 % 高处）→ 内凹喇叭口 → 厚圆唇（0.06 D）
    outer = [P(0, -0.04), P(0.62, -0.04), P(0.62, 0), P(0.42, 0.02), P(0.36, 0.25), P(0.42, 0.45), P(0.58, 0.65), P(0.80, 0.84), P(1.02, 0.96), P(1.13, 0.995), P(1.13, 1.0)]
  } else if (style === 'ribbed') {
    // 近圆柱外壳 + 9 道外环肋（E3000 对地板白漆喇叭）；肋高 0.05 a、肋距 0.1 L
    outer = [P(0, -0.035), P(0.95, -0.035), P(0.95, 0)]
    const r0 = 0.96, r1 = 1.12, n = 9
    for (let k = 0; k < n; k++) {
      const z0 = 0.06 + (0.88 * k) / n, z1 = z0 + 0.88 / n
      const r = r0 + ((r1 - r0) * k) / (n - 1)
      outer.push(P(r, z0), P(r + 0.05, z0 + 0.01), P(r + 0.05, z0 + 0.035), P(r, z0 + 0.045), P(r, z1))
    }
    outer.push(P(1.22, 0.975), P(1.22, 1.0))
  } else if (style === 'smooth') {
    outer = [P(0, -0.035), P(0.78, -0.035), P(0.78, 0), P(0.60, 0), P(0.589, 0.125), P(0.657, 0.25), P(0.752, 0.375), P(0.847, 0.5), P(0.942, 0.625), P(1.037, 0.75), P(1.132, 0.875), P(1.227, 0.972), P(1.297, 0.972), P(1.297, 1.0)]
  } else {
    // 台阶锥（机加波纹喇叭的减重外形；调研 Profile 1）
    outer = [P(0, -0.035), P(0.78, -0.035), P(0.78, 0), P(0.619, 0), P(0.619, 0.2), P(0.741, 0.2), P(0.771, 0.207), P(0.771, 0.4),
      P(0.893, 0.4), P(0.923, 0.407), P(0.923, 0.6), P(1.045, 0.6), P(1.075, 0.607), P(1.075, 0.8), P(1.197, 0.8), P(1.227, 0.807), P(1.227, 0.972), P(1.297, 0.972), P(1.297, 1.0)]
  }
  latheF(put(m.body), F, outer, seg)
  const rOut = Math.max(...outer.map((p) => p[0]))
  // 口面金属环：唇环外缘 → 内径
  const rimR = outer[outer.length - 1][0]
  latheF(put(m.rim), F, [[rimR, L], [a, L]], seg)
  // 内腔：口部 4 道波纹槽（槽深 λ/4 ≈ 0.167 a，槽距 0.035 L）→ 内锥收到喉部 0.24 a → 喉部暗盘
  const rin = (z) => a * (0.24 + 0.76 * z)       // 齿尖半径随 z（z 以 L 计）
  const inner = [[a, L]]
  if (style !== 'profiled') {
    const dep = 0.167 * a, p = 0.035
    for (let k = 0; k < 4; k++) {
      const z0 = 1 - k * p, zt = z0 - 0.3 * p, zs = z0 - p
      inner.push([rin(z0), zt * L], [rin(z0) + dep, zt * L], [rin(z0) + dep, zs * L], [rin(zs), zs * L])
    }
  }
  inner.push([0.24 * a, 0], [0, 0])
  latheF(put(m.inner), F, inner, seg)
  // 口面遮阳膜（白漆膜 / 锗镀黑聚酰亚胺深灰），离口沿内收 2 mm
  if (o.cap === 'white' || o.cap === 'ge') disc(put(o.cap === 'white' ? 'white_paint' : 'sunshield'), madd(o.ap, d, -0.002), d, a * 1.02, seg)
  return { throat, back: madd(throat, d, -0.035 * L), rOut: rOut }
}

/**
 * 馈电链（喇叭喉部之后，沿 −dir 方向）：圆波导颈 + 极化器（圆柱 Ø ≈ 2 λ）+ 正交模变换器 / 双工器方盒（C/Ku 双线极化）
 * 或双工器圆柱（Ka 圆极化）+ 2–4 根矩形波导端口短管（带方法兰）。调研 part_feeds.md §4（ESA RYMSA C 频段 OMT 包络、
 * ESA ITI Ka 馈电链），λ 由口径反推（D ≈ 2.8 λ）。
 * o = { throat（喇叭法兰背面中心）, dir（喇叭出口方向）, up?, D（喇叭口径）, kind?:'linear'|'cp', mat?:{body, flange}, seg? }
 * @returns {{back:number[]}} 链尾中心
 */
export function feedChain(put, o) {
  const lam = o.D / 2.8, seg = o.seg || 20
  const m = { body: 'aluminum', flange: 'aluminum', ...(o.mat || {}) }
  const d = nrm(o.dir), back = scl(d, -1)
  const F = axisFrame(o.throat, back, o.up)
  const body = put(m.body)
  // 圆波导颈 + 法兰
  const rw = 0.42 * lam
  cyl(body, toW(F, [0, 0, 0]), toW(F, [0, 0, 0.6 * lam]), rw, seg, false, false)
  cyl(put(m.flange), toW(F, [0, 0, 0.6 * lam]), toW(F, [0, 0, 0.72 * lam]), rw * 1.9, seg, true, true)
  // 极化器
  const pz0 = 0.72 * lam, pz1 = pz0 + 2.4 * lam
  cyl(body, toW(F, [0, 0, pz0]), toW(F, [0, 0, pz1]), lam, seg, false, false)
  let zEnd
  if (o.kind === 'cp') {
    // 圆极化：双工器圆柱 + 两根后出的矩形端口
    const z1 = pz1 + 2.8 * lam
    cyl(body, toW(F, [0, 0, pz1]), toW(F, [0, 0, z1]), 1.0 * lam, seg, false, true)
    for (const s of [1, -1]) obox(body, F, [s * 0.45 * lam, 0, z1 + 0.6 * lam], [0.28 * lam, 0.16 * lam, 0.6 * lam])
    zEnd = z1 + 1.2 * lam
  } else {
    // 线极化：正交模变换器 / 双工器方盒（宽 5.3 λ 量级收成 2.6 λ 见方的块）+ 四根端口短管（上下左右各一，带方法兰）
    const bz0 = pz1, bz1 = pz1 + 2.2 * lam, h = [1.3 * lam, 1.05 * lam, (bz1 - bz0) / 2]
    bevelBox(body, F, [0, 0, (bz0 + bz1) / 2], h, 0.08 * lam)
    const stub = (cx, cy, ax, along) => {
      const L1 = 0.9 * lam
      const c = [cx + ax[0] * L1 / 2, cy + ax[1] * L1 / 2, along]
      obox(body, F, c, [Math.abs(ax[0]) ? L1 / 2 : 0.32 * lam, Math.abs(ax[1]) ? L1 / 2 : 0.32 * lam, 0.18 * lam])
      const fc = [cx + ax[0] * (L1 + 0.04 * lam), cy + ax[1] * (L1 + 0.04 * lam), along]
      obox(put(m.flange), F, fc, [Math.abs(ax[0]) ? 0.05 * lam : 0.5 * lam, Math.abs(ax[1]) ? 0.05 * lam : 0.5 * lam, 0.34 * lam])
    }
    // 两对端口错开高度（±x 一对在上、±y 一对在下）：两对各自关于馈源轴对称，整条链对两个过轴平面都镜像对称
    // （偏置反射面组件关于母轴 + 偏置方向面对称，自带馈源也得对称，镜像件才能复用几何）
    const zm = (bz0 + bz1) / 2
    stub(h[0], 0, [1, 0], zm + 0.4 * lam); stub(-h[0], 0, [-1, 0], zm + 0.4 * lam)
    stub(0, h[1], [0, 1], zm - 0.4 * lam); stub(0, -h[1], [0, -1], zm - 0.4 * lam)
    zEnd = bz1
  }
  return { back: toW(F, [0, 0, zEnd]) }
}

// ───────────────────────────── 喷管 ─────────────────────────────

/**
 * 通用钟形喷管型线（调研 part_propulsion.md「Universal bell table」：Rao 抛物线 ε = 150 与 S400-15 图纸实测型线的平均，
 * 最大偏差 ≈ 0.03）：x = 自喉部的扩张段长度比例、r = 该处半径 / 出口半径。第一项（喉部）由面积比给出（1/√ε）。
 */
export const BELL_TABLE = Object.freeze([[0.05, 0.150], [0.10, 0.235], [0.15, 0.305], [0.20, 0.370], [0.30, 0.490], [0.40, 0.595],
  [0.50, 0.690], [0.60, 0.770], [0.70, 0.840], [0.80, 0.900], [0.90, 0.955], [1.00, 1.000]])

/**
 * 钟形喷管推力器（化学推进）。kind：
 *   'rcs'：10 N 双组元姿控（ArianeGroup S10 系）——出口内径 35 mm（De = 0.0349·√(F/10)）、面积比 150、扩张段 0.047 m、
 *          细燃烧室（外径 3.2 Dt）、厚壁喉部无明显收腰、出口薄唇；阀块（50 × 40 × 78 mm）+ 安装法兰（63 × 50 mm）。
 *   'lae'：400–500 N 远地点发动机（S400-15 / R-4D 量级）——出口 0.25–0.30 m、面积比 250、扩张段 1.4–1.75 De、
 *          燃烧室外径 3.9 Dt、喉部外收腰 1.5 Dt、喷管在 0.2 L 处换色（铂铑合金银白 → 延伸段深色）、出口唇环、阀头块。
 * o = { exit（出口面中心）, dir（喷流方向）, up?, De?（出口内径）, thrustN?, kind, mat?:{chamber, nozzle, inner, valve}, valve?:false, seg?,
 *       coarse?（成组的小喷管：型线隔点取、内壁只画一段锥——几厘米的喷口里看不出差别，三角形省一大半） }
 * @returns {{mount:number[], back:number[]}} mount = 安装法兰面中心（推力器挂到结构上的点）
 */
export function bellNozzle(put, o) {
  const kind = o.kind === 'lae' ? 'lae' : 'rcs'
  const seg = o.seg || (kind === 'lae' ? 40 : 20)
  // 推力缺省：只给出口径时按出口径反推（燃烧室 / 阀头随出口径同比缩放），都不给取典型件
  const De0 = kind === 'lae' ? 0.26 : 0.0349
  const F0 = isNum(o.thrustN) ? o.thrustN : (kind === 'lae' ? 425 : 10) * (isNum(o.De) ? (o.De / De0) ** 2 : 1)
  const s = Math.sqrt(F0 / (kind === 'lae' ? 425 : 10))
  const eps = kind === 'lae' ? 250 : 150
  const De = isNum(o.De) ? o.De : De0 * s
  const Re = De / 2, Rt = Re / Math.sqrt(eps)
  const Ldiv = (kind === 'lae' ? 0.85 : 0.78) * (Re - Rt) / Math.tan(15 * DEG)
  const m = kind === 'lae'
    ? { chamber: 'aluminum', nozzle: 'dark_metal', inner: 'black_paint', valve: 'aluminum', ...(o.mat || {}) }
    : { chamber: 'titanium', nozzle: 'titanium', inner: 'black_paint', valve: 'aluminum', ...(o.mat || {}) }
  const d = nrm(o.dir)
  // 局部系：原点在喉部、+z 沿喷流
  const throatP = madd(o.exit, d, -Ldiv)
  const F = axisFrame(throatP, d, o.up)
  const wall = kind === 'lae' ? Math.max(0.0015, 0.004 * Re) : Math.max(0.0004, 0.25 * Rt)
  const tab = o.coarse ? BELL_TABLE.filter((_, i) => i % 2 === 1) : BELL_TABLE
  const bell = [[Rt, 0], ...tab.map(([x, r]) => [Math.max(Rt, r * Re), x * Ldiv])]
  // 外壁：燃烧室（上游、z < 0）→ 喉部外收腰 → 钟形外壁（内型线外推壁厚）→ 出口唇环
  const zc = kind === 'lae' ? -11 * Rt : -10.8 * Rt
  const rc = (kind === 'lae' ? 3.9 : 3.2) * Rt
  const chamber = kind === 'lae'
    ? [[0, zc], [rc, zc], [rc, -4 * Rt], [2.2 * Rt, -1.5 * Rt], [1.5 * Rt, 0]]
    : [[0, zc], [rc, zc], [rc, -2.5 * Rt], [3.0 * Rt, 0]]
  const rNeck = chamber[chamber.length - 1][0]
  const lipDr = (kind === 'lae' ? 0.05 : 0.04) * Re, lipH = kind === 'lae' ? 0.004 * Re : 0.0015 * s
  // 外壁 = 内型线外推壁厚（喉部附近不低于燃烧室收口外径：厚壁喉部），截到出口唇环下沿
  const outerBell = bell.slice(1).map(([r, z]) => [Math.max(r + wall, z < 0.1 * Ldiv ? rNeck : 0), Math.min(z, Ldiv - lipH)])
  // 换色接缝：LAE 0.2 L 处（铂铑燃烧室 / 喉部段 → 延伸段）；RCS 一色
  const jointZ = kind === 'lae' ? 0.2 * Ldiv : -1
  const up1 = [...chamber, ...outerBell.filter(([, z]) => z <= jointZ)]
  const jr = Re * 0.37 + wall   // 接缝处外半径（表值 x = 0.2）
  if (kind === 'lae') {
    up1.push([jr, jointZ])
    latheF(put(m.chamber), F, up1, seg)
    const down = [[jr, jointZ], ...outerBell.filter(([, z]) => z > jointZ), [Re + lipDr, Ldiv - lipH], [Re + lipDr, Ldiv], [Re, Ldiv]]
    latheF(put(m.nozzle), F, down, seg)
  } else {
    latheF(put(m.nozzle), F, [...chamber, ...outerBell, [Re + lipDr, Ldiv - lipH], [Re + lipDr, Ldiv], [Re, Ldiv]], seg)
  }
  // 内壁（自出口沿型线回到喉部）+ 喉部暗盘
  latheF(put(m.inner), F, o.coarse ? [[Re, Ldiv], [Rt, 0], [0, 0]] : [...bell.slice().reverse(), [0, 0]], seg)
  // 阀块 / 阀头 + 安装法兰（燃烧室上游）
  const zTop = zc
  let mount
  if (kind === 'lae') {
    const hd = 0.06 * s
    obox(put(m.valve), F, [0, 0, zTop - hd / 2], [hd / 2, hd / 2, hd / 2])
    for (const sx of [1, -1]) cyl(put(m.valve), toW(F, [sx * hd / 2, 0, zTop - hd / 2]), toW(F, [sx * (hd / 2 + 0.06 * s), 0, zTop - hd / 2]), 0.022 * s, 16, false, true)
    // 安装法兰环（推力架接口）
    latheF(put(m.chamber), F, [[0.05 * s, zTop - hd - 0.008], [0.075 * s, zTop - hd - 0.008], [0.075 * s, zTop - hd], [0.05 * s, zTop - hd]], seg)
    mount = toW(F, [0, 0, zTop - hd - 0.008])
  } else {
    // 注入器 / 隔热段（铜金色细颈）→ 法兰板 → 阀块 + 两根进液管
    const zi = zTop - 0.012 * s
    cyl(put('gold_metal'), toW(F, [0, 0, zTop]), toW(F, [0, 0, zi]), 0.0075 * s, 14, false, false)
    obox(put(m.valve), F, [0, 0, zi - 0.002], [0.0315 * s, 0.025 * s, 0.002])
    if (o.valve !== false) {
      obox(put(m.valve), F, [0, 0, zi - 0.004 - 0.039 * s], [0.025 * s, 0.020 * s, 0.039 * s])
      for (const sx of [1, -1]) cyl(put(m.valve), toW(F, [sx * 0.012 * s, 0, zi - 0.004 - 0.078 * s]), toW(F, [sx * 0.012 * s, 0, zi - 0.004 - 0.098 * s]), 0.002, 8, false, true)
    }
    mount = toW(F, [0, 0, zi - 0.004])
  }
  return { mount, back: mount, exit: o.exit.slice(), length: Ldiv - zTop }
}

/** 钟形喷管安装法兰面到出口面的距离（与 bellNozzle 同一套式子；LAE 含阀头，RCS 不含法兰下的阀块）。 */
export function nozzleFlangeToExit(kind, De) {
  const lae = kind === 'lae', De0 = lae ? 0.26 : 0.0349
  const s = Math.sqrt((De / De0) ** 2), Re = De / 2, Rt = Re / Math.sqrt(lae ? 250 : 150)
  const Ldiv = (lae ? 0.85 : 0.78) * (Re - Rt) / Math.tan(15 * DEG)
  return lae ? Ldiv + 11 * Rt + 0.06 * s + 0.008 : Ldiv + 10.8 * Rt + 0.012 * s + 0.004
}

/**
 * 单只 10 N 姿控推力器（装配件 sat.thruster 'rcs' 与整星显式推力器共用）：出口面在安装点沿喷流 L 处；法兰下的阀块在星体里、不画。
 * L 比法兰到出口的自然长度长时，法兰与安装面之间补一段方形支座；短时法兰落在安装面以下（喷管半埋）。
 * o = { base, dir, up?, De, L, seg? } @returns {{exit:number[]}}
 */
export function rcsThruster(put, o) {
  const d = nrm(o.dir), nat = nozzleFlangeToExit('rcs', o.De), so = o.L - nat
  bellNozzle(put, { exit: madd(o.base, d, o.L), dir: d, up: o.up, kind: 'rcs', De: o.De, valve: false, seg: o.seg })
  if (so > 0.001) {
    const s = o.De / 0.0349, F = axisFrame(o.base, d, o.up)
    obox(put('aluminum'), F, [0, 0, so / 2], [0.028 * s, 0.022 * s, so / 2], ['+x', '-x', '+y', '-y', '-z'])
  }
  return { exit: madd(o.base, d, o.L) }
}

/**
 * 姿控推力器模块（调研 part_propulsion.md §5：A/B 主备一对装在一块支架上，支架裹 MLI，≈ 0.10 × 0.10 × 0.06 m，只露喷管 50–80 mm）：
 * MLI 包覆的支架块（沿 dir 高 podH）+ 两只 10 N 钟形喷管并排（间距 0.06 m）从块的外端面伸出。
 * o = { base（安装点）, dir（喷流方向 = 支架朝外方向）, up?（两只喷管排开的方向）, De?, pair?:true, mli?:'mli_gold'|'mli_black', scale? }
 * @returns {{exit:number[]}} 两喷管出口中点
 */
export function rcsPod(put, o) {
  const k = isNum(o.scale) ? o.scale : 1
  const d = nrm(o.dir)
  const F = axisFrame(o.base, d, o.up)
  const podH = 0.06 * k, pair = o.pair !== false
  // 支架包住两只喷管的法兰板（半宽 0.03 + 0.0315 = 0.0615）
  bevelBox(put(o.mli || 'mli_gold'), F, [0, 0, podH / 2], [(pair ? 0.066 : 0.04) * k, 0.045 * k, podH / 2], 0.006 * k)
  const De = isNum(o.De) ? o.De : 0.035 * k
  const vis = 0.055 * k
  for (const sx of pair ? [1, -1] : [0]) bellNozzle(put, { exit: toW(F, [sx * 0.03 * k, 0, podH + vis]), dir: d, up: F.x, kind: 'rcs', De, valve: false, seg: 10, coarse: true })
  return { exit: toW(F, [0, 0, podH + vis]) }
}

// ───────────────────────────── 霍尔推力器 ─────────────────────────────

/**
 * 霍尔推力器（SPT-100 / PPS-1350 / PPS-5000 类；调研 part_propulsion.md §3）：倒角方形本体（边长 S = 1.5 Dch、深 1.2 Dch）、
 * 出口面四角磁线圈、外陶瓷环（0.333–0.385 S，白）→ 凹进的放电通道（0.35–0.5 Dch，深 0.25 Dch，深色）→ 内陶瓷环 → 中心磁极盘；
 * 两只空心阴极（细管，向推力轴倾 20°）挂在一边。
 * o = { exit（出口面中心）, dir（喷流方向）, up?, Dch?（放电通道直径，缺省 0.1 m）, standoff?（本体背面到安装面的距离：> 0 时补一段方形支座）,
 *       mat?:{body, ceramic, channel, pole}, seg? }
 * @returns {{mount:number[]}} 安装面中心（无支座时 = 本体背面中心）
 */
export function hallThruster(put, o) {
  const Dch = isNum(o.Dch) ? o.Dch : 0.1, S = 1.5 * Dch, Lb = 1.2 * Dch, seg = o.seg || 32
  const m = { body: 'aluminum', ceramic: 'ceramic', channel: 'black_paint', pole: 'titanium', ...(o.mat || {}) }
  const d = nrm(o.dir)
  const F = axisFrame(o.exit, d, o.up)          // 原点在出口面、+z 沿喷流
  const c = 0.13 * S, h = S / 2
  const oct = [[h - c, h], [-(h - c), h], [-h, h - c], [-h, -(h - c)], [-(h - c), -h], [h - c, -h], [h, -(h - c)], [h, h - c]]
  // 前面板（倒角方板，中间开圆孔：画成八边形板的外圈 + 侧面；内孔由陶瓷环盖住）
  prism(put(m.body), F, oct, -0.06 * S, 0, { cap0: false, cap1: false })
  const ro = 0.385 * S
  // 前面板正面：八边形外轮廓到外陶瓷环之间的环带（法向 +z）。凸多边形包住原点：沿方向 u 的边界距离 = min（边距 / 边法向·u）
  const face = put(m.body)
  const edges = oct.map((A, i) => {
    const B = oct[(i + 1) % oct.length], ex = B[0] - A[0], ey = B[1] - A[1], L = Math.hypot(ex, ey)
    const nx = ey / L, ny = -ex / L
    return { nx, ny, h: nx * A[0] + ny * A[1] }
  }).map((e) => (e.h < 0 ? { nx: -e.nx, ny: -e.ny, h: -e.h } : e))
  const rim = (t) => { const ct = Math.cos(t), st = Math.sin(t); let best = Infinity; for (const e of edges) { const c = e.nx * ct + e.ny * st; if (c > 1e-9) best = Math.min(best, e.h / c) } return best }
  for (let k = 0; k < seg; k++) {
    const t0 = (2 * Math.PI * k) / seg, t1 = (2 * Math.PI * (k + 1)) / seg
    const A0 = toW(F, [ro * Math.cos(t0), ro * Math.sin(t0), 0]), A1 = toW(F, [ro * Math.cos(t1), ro * Math.sin(t1), 0])
    const r0 = rim(t0), r1 = rim(t1)
    const B0 = toW(F, [r0 * Math.cos(t0), r0 * Math.sin(t0), 0]), B1 = toW(F, [r1 * Math.cos(t1), r1 * Math.sin(t1), 0])
    const i0 = face.v(A0, F.z), i1 = face.v(A1, F.z), i2 = face.v(B1, F.z), i3 = face.v(B0, F.z)
    face.t(i0, i3, i2); face.t(i0, i2, i1)
  }
  // 本体（前面板之后）：同一八边形挤出 + 背板
  prism(put(m.body), F, oct.map(([x, y]) => [x * 0.92, y * 0.92]), -Lb, -0.06 * S, { cap0: true, cap1: false })
  // 四角磁线圈（前面板后）
  for (const sx of [1, -1]) for (const sy of [1, -1]) cyl(put('gold_metal'), toW(F, [sx * 0.36 * S, sy * 0.36 * S, -0.06 * S]), toW(F, [sx * 0.36 * S, sy * 0.36 * S, -0.06 * S - 0.6 * Lb]), 0.11 * S, 16, false, true)
  // 出口面：外陶瓷环（略凸出）→ 放电通道（凹进 0.25 Dch）→ 内陶瓷环 → 中心磁极
  const rco = ro, rci = Dch / 2, rii = 0.27 * Dch, rio = 0.35 * Dch, dep = 0.25 * Dch, pr0 = 0.02 * Dch
  latheF(put(m.ceramic), F, [[rco, 0], [rco, pr0], [rci, pr0], [rci, -dep * 0.2]], seg)
  latheF(put(m.channel), F, [[rci, -dep * 0.2], [rci, -dep], [rio, -dep], [rio, -dep * 0.2]], seg)
  latheF(put(m.ceramic), F, [[rio, -dep * 0.2], [rio, pr0], [rii, pr0], [rii, 0]], seg)
  latheF(put(m.pole), F, [[rii, 0], [0, 0]], seg)
  // 两只空心阴极（本体一侧，向推力轴倾 20°）
  for (const sx of [1, -1]) {
    const base = toW(F, [sx * 0.08 * S, 0.62 * S, -0.35 * S])
    const tipDir = nrm(add(F.z, scl(F.y, -Math.tan(20 * DEG))))
    cyl(put(m.pole), base, madd(base, tipDir, 0.45 * S), 0.06 * S, 14, true, true)
    obox(put(m.body), F, [sx * 0.08 * S, 0.55 * S, -0.4 * S], [0.05 * S, 0.06 * S, 0.06 * S])
  }
  const so = isNum(o.standoff) && o.standoff > 0.002 ? o.standoff : 0
  if (so) obox(put(m.body), F, [0, 0, -Lb - so / 2], [0.3 * S, 0.3 * S, so / 2], ['+x', '-x', '+y', '-y', '-z'])
  return { mount: toW(F, [0, 0, -Lb - so]) }
}

// ───────────────────────────── 敏感器 ─────────────────────────────

/**
 * 星敏感器光学头（调研 part_sensors_omni.md §2）：
 *   'hydra'（缺省，Sodern Hydra 光学头）：底板 0.135 见方 → 底座块 0.097 见方 × 0.047 → 镜筒 Ø0.09 → 外扩 → 银色圆柱遮光罩 Ø0.147、
 *           总高 0.283 m；遮光罩外银内黑，两道接缝环；
 *   'cone'（ASTRO-APS 类）：0.154 见方 × 0.082 电子盒 + 外扩锥形遮光罩（Ø0.085 → 0.150、高 ≈ 0.15）。
 * 尺寸按 o.scale 整体缩放（缺省 1 = 实物）；另可分轴再乘：kb 底座横向、kr 遮光罩半径、kz 遮光罩轴向长（装配组件沿用旧参数
 * 「本体边长 / 遮光罩口径 / 遮光罩长」时用）。o = { base（安装面中心）, dir（视轴）, up?, type?, scale?, kb?, kr?, kz?, mat?, seg? }
 * @returns {{aperture:number[], height:number}}
 */
export function starTrackerHead(put, o) {
  const k = isNum(o.scale) ? o.scale : 1, seg = o.seg || 32
  const kb = k * (isNum(o.kb) ? o.kb : 1), kr = k * (isNum(o.kr) ? o.kr : 1), kz = k * (isNum(o.kz) ? o.kz : 1)
  const m = { body: 'aluminum', baffle: 'aluminum', inner: 'black_paint', lens: 'glass', ...(o.mat || {}) }
  const F = axisFrame(o.base, o.dir, o.up)
  const S = (v) => v * k, B = (v) => v * kb, R = (v) => v * kr
  // 遮光罩起点 zb 以下（底座）按 k，以上按 kz 伸缩
  const zb = o.type === 'cone' ? 0.090 : 0.055
  const Z = (z) => (z <= zb ? z * k : zb * k + (z - zb) * kz)
  const P = (pts) => pts.map(([r, z]) => [R(r), Z(z)])
  const bev = (v) => v * Math.min(k, kb)
  if (o.type === 'cone') {
    obox(put(m.body), F, [0, 0, S(0.004)], [B(0.085), B(0.085), S(0.004)])
    bevelBox(put(m.body), F, [0, 0, S(0.008 + 0.041)], [B(0.077), B(0.077), S(0.041)], bev(0.006))
    const top = 0.090 + 0.147
    latheF(put(m.baffle), F, P([[0.043, 0.090], [0.075, top], [0.078, top]]), seg)
    latheF(put(m.inner), F, P([[0.073, top], [0.041, 0.094], [0, 0.094]]), seg)
    for (const f of [0.3, 0.55, 0.8]) {
      const r = 0.043 + (0.075 - 0.043) * f, z = 0.090 + 0.147 * f
      latheF(put(m.baffle), F, P([[r + 0.001, z - 0.003], [r + 0.004, z], [r + 0.001, z + 0.003]]), seg)
    }
    return { aperture: toW(F, [0, 0, Z(top)]), height: Z(top) }
  }
  // hydra
  obox(put(m.body), F, [0, 0, S(0.004)], [B(0.0675), B(0.0675), S(0.004)])
  bevelBox(put(m.body), F, [0, 0, S(0.0315)], [B(0.0485), B(0.0485), S(0.0235)], bev(0.004))
  obox(put(m.body), F, [B(0.0485 + 0.015), 0, S(0.03)], [B(0.015), B(0.0175), S(0.015)])     // 接插件座
  latheF(put(m.baffle), F, P([[0.045, 0.055], [0.045, 0.136], [0.056, 0.136], [0.056, 0.147], [0.0735, 0.196], [0.0735, 0.283]]), seg)
  latheF(put(m.inner), F, P([[0.0735, 0.283], [0.0705, 0.283], [0.0705, 0.200], [0.030, 0.160], [0, 0.158]]), seg)
  for (const z of [0.240, 0.262]) latheF(put(m.baffle), F, P([[0.0735, z - 0.001], [0.0745, z], [0.0735, z + 0.001]]), seg)
  disc(put(m.lens), toW(F, [0, 0, Z(0.1585)]), F.z, R(0.028), seg)
  return { aperture: toW(F, [0, 0, Z(0.283)]), height: Z(0.283) }
}

/**
 * 楔形安装座（星敏感器斜装支架；调研 components.md §5(e)「Bracket」）：底面贴在安装面（法向 n）、边长 size 的方块，顶面法向 = top（视轴），
 * 顶面中心高 hc（缺省 0.02 + size/2·tan 斜角）。八个角点按顶面平面求出，六个面平面着色。
 * o = { base（安装面上的中心）, n（安装面外法向）, top（顶面法向）, size, hc?, up?（底面方块的一条边方向）, mat? }
 * @returns {{top:number[]}} 顶面中心（敏感器安装点）
 */
export function wedgeMount(put, o) {
  const n = nrm(o.n), b = nrm(o.top), s = o.size / 2
  const cosT = Math.max(0.2, dot3(n, b)), tanT = Math.sqrt(Math.max(0, 1 - cosT * cosT)) / cosT
  const hc = isNum(o.hc) ? o.hc : 0.12 * o.size + s * tanT
  const F = frameZX(o.base, n, o.up || null)
  const T0 = madd(o.base, n, hc)
  const bot = [[s, s], [-s, s], [-s, -s], [s, -s]].map(([x, y]) => toW(F, [x, y, 0]))
  const top = bot.map((B) => madd(B, n, dot3(sub(T0, B), b) / cosT))
  const mb = put(o.mat || 'aluminum')
  fan(mb, bot, scl(n, -1))
  fan(mb, top, b)
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    const mid = scl(add(add(bot[i], bot[j]), add(top[i], top[j])), 0.25)
    const out = nrm(sub(mid, madd(o.base, n, hc / 2)))
    const nn = nrm(cross(sub(bot[j], bot[i]), sub(top[i], bot[i])))
    quadPts(mb, bot[i], bot[j], top[j], top[i], dot3(nn, out) >= 0 ? nn : scl(nn, -1))
  }
  return { top: T0 }
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * 太阳敏感器（调研 part_sensors_omni.md §4）：
 *   'fss'（精太敏，缺省）：0.104 × 0.094 底板 → 0.096 × 0.086 × 0.032 金色圆角盒 → 0.07 见方镶框 → 0.05 见方黑凹窗 → 0.035 见方玻璃，总高 ≈ 0.052；
 *   'css'（粗太敏）：0.11 见方 × 0.022 金色托盘 + 黑井 + 四面 22° 倾斜的电池金字塔。
 * 尺寸按 o.scale 整体缩放；另可分轴再乘 kx / ky / kz（装配组件按「宽 / 长 / 厚」给尺寸时用）。
 * o = { base, dir（视轴 / 盒顶法向）, up?, type?, scale?, kx?, ky?, kz?, mat? } @returns {{top:number[]}}
 */
export function sunSensor(put, o) {
  const k = isNum(o.scale) ? o.scale : 1
  const kx = k * (isNum(o.kx) ? o.kx : 1), ky = k * (isNum(o.ky) ? o.ky : 1), kz = k * (isNum(o.kz) ? o.kz : 1)
  const X = (v) => v * kx, Y = (v) => v * ky, Z = (v) => v * kz, bev = (v) => v * Math.min(kx, ky, kz)
  const m = { body: 'gold_metal', bezel: 'aluminum', well: 'black_paint', glass: 'glass', cell: 'solar_cell', ...(o.mat || {}) }
  const F = axisFrame(o.base, o.dir, o.up)
  if (o.type === 'css') {
    bevelBox(put(m.body), F, [0, 0, Z(0.011)], [X(0.055), Y(0.055), Z(0.011)], bev(0.003))
    obox(put(m.well), F, [0, 0, Z(0.0225)], [X(0.031), Y(0.031), Z(0.0005)], ['+z'])
    obox(put(m.bezel), F, [0, 0, Z(0.0255)], [X(0.02), Y(0.02), Z(0.0025)], ['+x', '-x', '+y', '-y'])
    // 四面电池金字塔（底 0.04、顶面 0.02、面倾 22°）
    const bx = X(0.02), by = Y(0.02), tx = X(0.01), ty = Y(0.01), z0 = Z(0.028), z1 = z0 + Z(0.01 * Math.tan(22 * DEG))
    const P = (x, y, z) => toW(F, [x, y, z])
    const quads = [[[bx, -by], [bx, by], [tx, ty], [tx, -ty]], [[bx, by], [-bx, by], [-tx, ty], [tx, ty]], [[-bx, by], [-bx, -by], [-tx, -ty], [-tx, ty]], [[-bx, -by], [bx, -by], [tx, -ty], [-tx, -ty]]]
    for (const q of quads) {
      const A = P(q[0][0], q[0][1], z0), B = P(q[1][0], q[1][1], z0), C = P(q[2][0], q[2][1], z1), D = P(q[3][0], q[3][1], z1)
      const n = nrm(cross(sub(B, A), sub(D, A)))
      const mb = put(m.cell), i0 = mb.v(A, n), i1 = mb.v(B, n), i2 = mb.v(C, n), i3 = mb.v(D, n)
      mb.t(i0, i1, i2); mb.t(i0, i2, i3)
    }
    obox(put(m.cell), F, [0, 0, z1], [tx, ty, Z(0.0003)], ['+z'])
    return { top: toW(F, [0, 0, z1]) }
  }
  obox(put(m.bezel), F, [0, 0, Z(0.003)], [X(0.052), Y(0.047), Z(0.003)])
  bevelBox(put(m.body), F, [0, 0, Z(0.006 + 0.016)], [X(0.048), Y(0.043), Z(0.016)], bev(0.006))
  obox(put(m.bezel), F, [0, 0, Z(0.038 + 0.005)], [X(0.035), Y(0.035), Z(0.005)], ['+x', '-x', '+y', '-y'])
  obox(put(m.bezel), F, [0, 0, Z(0.048)], [X(0.035), Y(0.035), Z(0.0001)], ['+z'])
  obox(put(m.well), F, [0, 0, Z(0.0482)], [X(0.025), Y(0.025), Z(0.0001)], ['+z'])
  obox(put(m.glass), F, [0, 0, Z(0.0495)], [X(0.0175), Y(0.0175), Z(0.0015)])
  obox(put(m.bezel), F, [X(0.048 + 0.009), 0, Z(0.02)], [X(0.009), Y(0.015), Z(0.007)])   // 接插件
  return { top: toW(F, [0, 0, Z(0.052)]) }
}

/**
 * 地球敏感器（调研 part_sensors_omni.md §3）：'ires'（Leonardo IRES-C 类：0.170 × 0.164 × 0.156 金色盒、顶面偏一侧的圆角矩形窗）
 * 或 'std15'（Sodern STD 15：黑色倒角方座 0.206 见方 × 0.100 + 铝罩、两侧窗、OSR 顶板）。
 * o = { base, dir（视场方向 = 盒顶法向）, up?, type?, scale?, mat? } @returns {{top:number[]}}
 */
export function earthSensor(put, o) {
  const k = isNum(o.scale) ? o.scale : 1, S = (v) => v * k
  const F = axisFrame(o.base, o.dir, o.up)
  if (o.type === 'std15') {
    const c = S(0.03), h = S(0.103)
    const oct = [[h - c, h], [-(h - c), h], [-h, h - c], [-h, -(h - c)], [-(h - c), -h], [h - c, -h], [h, -(h - c)], [h, h - c]]
    prism(put('black_paint'), F, oct, 0, S(0.100))
    obox(put('aluminum'), F, [0, 0, S(0.100 + 0.034)], [S(0.096), S(0.075), S(0.034)], ['+x', '-x', '+y', '-y'])
    obox(put('radiator'), F, [0, 0, S(0.168 + 0.002)], [S(0.103), S(0.075), S(0.002)])
    for (const sy of [1, -1]) obox(put('black_paint'), F, [0, sy * S(0.0755), S(0.134)], [S(0.075), S(0.0005), S(0.0225)])
    return { top: toW(F, [0, 0, S(0.172)]) }
  }
  bevelBox(put('gold_metal'), F, [0, 0, S(0.078)], [S(0.085), S(0.082), S(0.078)], S(0.006))
  obox(put('black_paint'), F, [S(0.025), 0, S(0.156 + 0.0002)], [S(0.0375), S(0.0225), S(0.0002)], ['+z'])
  obox(put('glass'), F, [S(0.025), 0, S(0.156 + 0.0006)], [S(0.034), S(0.019), S(0.0004)], ['+z'])
  cyl(put('aluminum'), toW(F, [S(0.085), 0, S(0.07)]), toW(F, [S(0.089), 0, S(0.07)]), S(0.032), 20, false, true)
  obox(put('aluminum'), F, [-S(0.04), -S(0.082 + 0.01), S(0.03)], [S(0.04), S(0.01), S(0.015)])
  return { top: toW(F, [0, 0, S(0.156)]) }
}

// ───────────────────────────── 测控天线 ─────────────────────────────

/**
 * 测控双锥全向天线（调研 part_sensors_omni.md §1，北美平台的「沙漏」形）：两只漏斗顶对顶、腰部馈电柱、外套琥珀色圆极化套筒（可选）、
 * 立在对地板细桅杆上。Ku：锥口半径 0.033、锥面与水平面 30°；C 频段 ×2.5–3。
 * 尺寸另随 scale（小平台按比例缩；频段系数之外再乘）。
 * o = { base（桅杆根部）, dir（桅杆方向）, up?, band?:'Ku'|'C', mastLen?, mastR?, polarizer?:true, scale? } @returns {{top:number[]}}
 */
export function ttcBicone(put, o) {
  const ks = isNum(o.scale) ? o.scale : 1
  const k = (o.band === 'C' ? 2.8 : 1) * ks, seg = o.seg || 28
  const R = 0.033 * k, rf = 0.004 * k, hC = (R - rf) * Math.tan(30 * DEG), g = 0.006 * k
  const mastLen = isNum(o.mastLen) ? o.mastLen : 0.45 * ks, mastR = isNum(o.mastR) ? o.mastR : 0.018 * ks
  const F = axisFrame(o.base, o.dir, o.up)
  if (mastLen > 0.002) {
    cyl(put('aluminum'), toW(F, [0, 0, 0]), toW(F, [0, 0, 0.006 * ks]), 2 * mastR, 20, false, true)
    cyl(put('white_paint'), toW(F, [0, 0, 0.006 * ks]), toW(F, [0, 0, mastLen]), mastR, 16, false, false)
  }
  const z0 = mastLen
  // 下漏斗（底盘 → 腰）、馈电柱、上漏斗（腰 → 顶盘）
  latheF(put('aluminum'), F, [[0, z0], [R, z0], [rf, z0 + hC]], seg)
  latheF(put('aluminum'), F, [[0.009 * k, z0 + hC], [0.009 * k, z0 + hC + g]], seg)
  latheF(put('aluminum'), F, [[rf, z0 + hC + g], [R, z0 + 2 * hC + g], [0, z0 + 2 * hC + g]], seg)
  if (o.polarizer !== false) {
    const rp = 0.045 * k, zp0 = z0 - 0.005 * k, zp1 = z0 + 2 * hC + g + 0.005 * k
    latheF(put('gold_metal'), F, [[rp, zp0], [rp, zp1]], seg)
    latheF(put('gold_metal'), F, [[rp - 0.0008, zp1], [rp - 0.0008, zp0]], seg)
  }
  return { top: toW(F, [0, 0, z0 + 2 * hC + g]) }
}

/**
 * 宽波束测控喇叭（WCA，欧洲平台对地 / 背地各一；调研 part_sensors_omni.md §1）：Ku 缺省「管」形喇叭——背座 Ø0.06、
 * 波纹圆盘 Ø0.125、两道扼流槽、内径 0.044 的管壁伸出 0.06；内腔黑。C 频段 ×2.5。
 * 尺寸另随 scale（小平台按比例缩）。o = { base（安装面中心）, dir（视轴）, up?, band?, scale? } @returns {{top:number[]}}
 */
export function wcaHorn(put, o) {
  const k = (o.band === 'C' ? 2.5 : 1) * (isNum(o.scale) ? o.scale : 1), seg = o.seg || 32
  const F = axisFrame(o.base, o.dir, o.up)
  const K = (pts) => pts.map(([r, z]) => [r * k, z * k])
  latheF(put('aluminum'), F, K([[0, 0], [0.030, 0], [0.030, 0.020], [0.0625, 0.020], [0.0625, 0.032], [0.052, 0.032], [0.052, 0.024], [0.044, 0.024], [0.044, 0.036], [0.036, 0.036], [0.036, 0.028], [0.028, 0.028], [0.028, 0.060], [0.022, 0.060]]), seg)
  latheF(put('black_paint'), F, K([[0.022, 0.060], [0.022, 0.030], [0, 0.030]]), seg)
  obox(put('aluminum'), F, [0, 0, -0.015 * k], [0.025 * k, 0.02 * k, 0.015 * k])
  return { top: toW(F, [0, 0, 0.06 * k]) }
}

// ───────────────────────────── 反射面背架 / 支撑框 / 展开机构 ─────────────────────────────

/**
 * 口缘面坐标系（偏置抛物面的口缘是平面椭圆；调研 components.md §1(b)「Derived geometry」）：
 *   n = 口缘面法向（朝焦点一侧 = 正面）= normalize(a − g·u)，g = dc / 2f；u′ = normalize(u + g·a)（口缘面内、沿偏置方向）；e2 横向。
 *   原点 C = 口径中心正上方的口缘面点（= 口径中心面点 Pc 沿 a 上移 R² / 4f）。口缘椭圆半轴：沿 u′ 为 R / cosθ、沿 e2 为 Ry。
 *   depth(ρ) = 口径面距中心 ρ 处的壳面在口缘面之下的深度（沿 n）= (R² − ρ²)/(4f)·cosθ（只与 ρ 有关：偏置抛物面对口径中心旋转对称）。
 */
export function rimFrame(L, Ry) {
  const R = L.D / 2, g = L.dc / (2 * L.f), c = 1 / Math.hypot(1, g)
  const n = nrm(sub(L.a, scl(L.u, g))), up = nrm(add(L.u, scl(L.a, g)))
  const C = madd(L.Pc, L.a, R * R / (4 * L.f))
  return { C, n, u: up, e2: L.e2, cos: c, R, Ry: isNum(Ry) ? Ry : R, depth: (rho) => ((R * R - rho * rho) / (4 * L.f)) * c }
}

/**
 * 实面反射面背架 + 支撑框（调研 components.md §1(a)(e)；ArianeGroup SPRINT 产品照、Airbus US 11,858,663 图 2）：
 *   backing 'ring8'：八边形环框——口径面里半边长 0.36 D、切角 25 %，箱形梁宽 0.055 D、高 0.04 D，梁底贴壳背（梁是直的，与弯壳的小缝是真实的），
 *            包金色 MLI；
 *   support 'rect'（Airbus 欧洲之星 / OneSat）：与口缘面平行的方梁矩形框，横梁（∥ e2）在 u′ = ±0.70 R、伸到 e2 = ±0.89 R，纵梁（∥ u′）在
 *            e2 = ±0.61 R，压在环框的两条横边上；四个压紧释放点垫块在横梁端头（离中心 1.13 R，口缘以外，收拢时朝侧壁）；
 *            展开臂接点在内侧横梁（u′ = −0.70 R，靠母轴一侧）e2 = −0.40 R 的背面。
 * L = meshKit.paraLayout（带 P / N / u / e2 / a / f / D / dc / Pc），o = { sh 壳厚, Ry?, backing?:'ring8'|'none', support?:'rect'|'none', mat? }
 * @returns {{link:number[], rim:object}} link = 展开臂接点（有支撑框取内侧横梁背面，否则取环框内侧边背面中点）
 */
export function reflectorBacking(put, L, o) {
  return backingBuild(put, L, o)
}
/** 只要展开臂连接点（不出网格）：与 reflectorBacking 同一套式子（装配件由母抛物面位姿反推展开臂时用）。 */
export function backingLink(L, o) {
  const scratch = new MB()
  return backingBuild(() => scratch, L, o).link
}
function backingBuild(put, L, o) {
  const rf = rimFrame(L, o.Ry), R = rf.R, D = L.D, sh = o.sh || 0
  const m = { frame: 'mli_gold', pad: 'aluminum', ...(o.mat || {}) }
  const ky = rf.Ry / R
  const ar = 0.36 * D, ch = 0.25 * 2 * ar, wb = 0.055 * D, hb = 0.04 * D
  // 口径面坐标（以口径中心为原点）→ 壳背点（沿 −法向退壳厚）
  const back = (x, y) => { const p = L.P(L.dc + x, y * ky), n = L.N(L.dc + x, y * ky); return { p: madd(p, n, -sh), n } }
  let link = null
  if (o.backing !== 'none') {
    const oct = [[ar, ar - ch], [ar - ch, ar], [-(ar - ch), ar], [-ar, ar - ch], [-ar, -(ar - ch)], [-(ar - ch), -ar], [ar - ch, -ar], [ar, -(ar - ch)]]
    const mb = put(m.frame)
    for (let i = 0; i < oct.length; i++) {
      const A = oct[i], B = oct[(i + 1) % oct.length]
      const pa = back(A[0], A[1]).p, pb = back(B[0], B[1]).p
      const mid = back((A[0] + B[0]) / 2, (A[1] + B[1]) / 2)
      const ax = sub(pb, pa), Lb = len(ax)
      // 梁局部系：x 沿梁、z 沿 −法向（朝背面起高）；两端各伸出 0.21 w（135° 角的斜接外缘对上）
      const F = frameZX(mid.p, scl(mid.n, -1), ax)
      bevelBox(mb, F, [0, 0, hb / 2], [Lb / 2 + 0.21 * wb, wb / 2, hb / 2], 0.12 * wb)
    }
    // 无支撑框时展开臂接到环框内侧边（u′ 负侧）背面中点
    const inn = back(-ar, 0)
    link = madd(inn.p, inn.n, -hb)
  }
  if (o.support === 'rect') {
    const b = 0.04 * D
    // 支撑框平面：压在环框两条横边（口径面 x = ±ar）的梁顶上
    const topDepth = rf.depth(ar) + sh + (o.backing !== 'none' ? hb : 0.02 * D)
    const w = -(topDepth + b / 2)
    const P = (s, t, dw = 0) => add(add(add(rf.C, scl(rf.u, s)), scl(rf.e2, t)), scl(rf.n, w + dw))
    const sU = 0.70 * R / rf.cos, tU = 0.61 * rf.Ry, tE = 0.89 * rf.Ry
    const mb = put(m.frame)
    const beam = (p0, p1) => { const F = frameZX(lerp3(p0, p1, 0.5), rf.n, sub(p1, p0)); bevelBox(mb, F, [0, 0, 0], [len(sub(p1, p0)) / 2 + b / 2, b / 2, b / 2], 0.12 * b) }
    for (const s of [sU, -sU]) beam(P(s, -tE), P(s, tE))
    for (const t of [tU, -tU]) beam(P(-sU, t), P(sU, t))
    // 压紧释放点垫块（朝正面 = 收拢时朝侧壁）
    const pad = 0.033 * D, padH = 0.02 * D
    for (const s of [sU, -sU]) for (const t of [tE, -tE]) {
      obox(put(m.pad), frameZX(P(s, t, b / 2 + padH / 2), rf.n, rf.u), [0, 0, 0], [pad / 2, pad / 2, padH / 2])
    }
    link = P(-sU, -0.40 * rf.Ry, -b / 2)
  }
  if (!link) { const inn = back(-0.9 * R, 0); link = inn.p }
  return { link, rim: rf }
}
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/**
 * 反射面展开机构（ADTM：两轴驱动 + 铰座；调研 components.md §1(e) 第 6 步，0.25 × 0.20 × 0.15 m 量级）：贴壁底座盒 + 两只正交的作动器鼓。
 * o = { base（壁面上的安装点）, n（壁外法向）, up?（鼓 1 的轴向，缺省取展开臂方向在壁面内的投影）, k?（尺寸比例）, mat? }
 * @returns {{out:number[]}} 输出端（展开臂根部）
 */
export function adtmBlock(put, o) {
  const k = isNum(o.k) ? o.k : 1
  const m = { body: 'mli_gold', drum: 'aluminum', ...(o.mat || {}) }
  const F = frameZX(o.base, o.n, o.up || null)
  const hx = 0.125 * k, hy = 0.10 * k, hz = 0.075 * k
  bevelBox(put(m.body), F, [0, 0, hz], [hx, hy, hz], 0.012 * k)
  // 鼓 1：轴沿 F.x、坐在盒顶；鼓 2：轴沿 F.z、从鼓 1 一侧伸出（两轴正交）
  const r = 0.06 * k, Ld = 0.10 * k
  cyl(put(m.drum), toW(F, [-Ld / 2, 0, 2 * hz + r * 0.8]), toW(F, [Ld / 2, 0, 2 * hz + r * 0.8]), r, 20, true, true)
  cyl(put(m.drum), toW(F, [0, 0, 2 * hz + r * 0.8]), toW(F, [0, 0, 2 * hz + r * 0.8 + 0.9 * Ld]), 0.75 * r, 20, false, true)
  return { out: toW(F, [0, 0, 2 * hz + r * 0.8 + 0.9 * Ld]), half: [hx, hy, hz] }
}

/**
 * 凹面副反射面（格里高利双反射面的椭球副面；口径小、曲率浅，按正馈抛物面帽近似：深 0.06 D_s，调研 components.md §1-V2）：
 * 正面（朝 n，凹面）+ 背面（沿 −法向退 sh）+ 边缘带。o = { center（顶点）, n（凹面朝向）, D, depth?, sh?, mat?:{front, back}, na?, nr? }
 * @returns {{area:number, front:MB}} 正面面积（质量按它算）与正面网格
 */
export function concaveCap(put, o) {
  const n = nrm(o.n), R = o.D / 2, dep = isNum(o.depth) ? o.depth : 0.06 * o.D, sh = isNum(o.sh) ? o.sh : 0.015
  const f = (R * R) / (4 * dep), na = o.na || 32, nr = o.nr || 5
  const [e1, e2] = perpPair(n)
  const m = { front: 'reflector', back: 'carbon', ...(o.mat || {}) }
  const at = (k, j) => {
    const rho = (R * k) / nr, ph = (2 * Math.PI * j) / na, x = rho * Math.cos(ph), y = rho * Math.sin(ph)
    const p = add(add(add(o.center, scl(e1, x)), scl(e2, y)), scl(n, (x * x + y * y) / (4 * f)))
    const nn = nrm(sub(n, add(scl(e1, x / (2 * f)), scl(e2, y / (2 * f)))))
    return [p, nn]
  }
  const fr = put(m.front), bk = put(m.back)
  const emit = (mb, sign, off) => {
    const base = mb.vcount
    const [p0, n0] = at(0, 0)
    mb.v(madd(p0, n0, off), scl(n0, sign))
    for (let k = 1; k <= nr; k++) for (let j = 0; j < na; j++) { const [p, q] = at(k, j); mb.v(madd(p, q, off), scl(q, sign)) }
    const id = (k, j) => base + 1 + (k - 1) * na + (j % na)
    for (let j = 0; j < na; j++) { if (sign > 0) mb.t(base, id(1, j), id(1, j + 1)); else mb.t(base, id(1, j + 1), id(1, j)) }
    for (let k = 1; k < nr; k++) for (let j = 0; j < na; j++) {
      const a = id(k, j), b = id(k + 1, j), c = id(k + 1, j + 1), d = id(k, j + 1)
      if (sign > 0) { mb.t(a, b, c); mb.t(a, c, d) } else { mb.t(a, c, b); mb.t(a, d, c) }
    }
  }
  const fStart = fr.idx.length
  emit(fr, 1, 0)
  emit(bk, -1, -sh)
  for (let j = 0; j < na; j++) {
    const [p0, q0] = at(nr, j), [p1, q1] = at(nr, j + 1)
    const rad = nrm(sub(scl(add(p0, p1), 0.5), o.center))
    quadPts(bk, p0, p1, madd(p1, q1, -sh), madd(p0, q0, -sh), rad)
  }
  let area = 0
  for (let t = fStart; t < fr.idx.length; t += 3) {
    const P = (i) => [fr.p[3 * i], fr.p[3 * i + 1], fr.p[3 * i + 2]]
    area += len(cross(sub(P(fr.idx[t + 1]), P(fr.idx[t])), sub(P(fr.idx[t + 2]), P(fr.idx[t])))) / 2
  }
  return { area, front: fr }
}

// ───────────────────────────── 太阳翼驱动 / 星箭接口 ─────────────────────────────

/**
 * SADA 外露部分（调研 part_power_thermal_bus.md A1：SADM 装在南北板里，外面只露输出端 33–40 mm + 翼根支座，裹一只 MLI 护套）：
 * 贴壁法兰 Ø0.19 × 0.01 → 输出短桩 Ø0.10 × 0.04 → MLI 护套截锥（Ø0.26 → Ø0.12，高 0.10）→ 翼根支座盒（0.12 × 0.08 × 0.15），总长 0.25。
 * 尺寸随 scale（小平台 / 立方星按比例缩），另可分轴再乘 kz（沿翼轴）/ kr（径向）——整星按细节档「SADA 外露长 / 直径」配。
 * o = { root（壁面中心）, dir（翼展方向 = 壁外法向）, up?（翼宽方向）, scale?, kz?, kr?, mliMat? }
 * @returns {{tip:number[]}} 支座外端中心（轭根接点）
 */
export function sadaBoot(put, o) {
  const k = isNum(o.scale) ? o.scale : 1, seg = o.seg || 28
  const kz = k * (isNum(o.kz) ? o.kz : 1), kr = k * (isNum(o.kr) ? o.kr : 1)
  const F = axisFrame(o.root, o.dir, o.up)
  latheF(put('aluminum'), F, [[0, 0], [0.095 * kr, 0], [0.095 * kr, 0.01 * kz], [0.05 * kr, 0.01 * kz], [0.05 * kr, 0.05 * kz], [0, 0.05 * kz]], seg)
  latheF(put(o.mliMat || 'mli_gold'), F, [[0.13 * kr, 0.002 * kz], [0.06 * kr, 0.10 * kz], [0, 0.10 * kz]], seg)
  obox(put('titanium'), F, [0, 0, (0.10 + 0.075) * kz], [0.06 * kr, 0.04 * kr, 0.075 * kz])
  return { tip: toW(F, [0, 0, 0.25 * kz]) }
}

/**
 * 星箭对接环（卫星侧，调研 part_power_thermal_bus.md C2）：圆柱段 + 下缘 V 形法兰（包带夹紧面）。D = 937 / 1194 / 1666 mm 档。
 * o = { c（背地面中心）, dir（朝外，−Z）, up?, D, H?, seg? } @returns {{bottom:number[]}}
 */
export function lvRing(put, o) {
  const R = o.D / 2, H = isNum(o.H) ? o.H : 0.1, seg = o.seg || 64, w = Math.max(0.004, 0.006 * R / 0.6)
  const F = axisFrame(o.c, o.dir, o.up)
  // 外壁（含 V 形法兰：下缘外凸 2.2 w、两道 45° 斜面）→ 底面 → 内壁
  latheF(put('aluminum'), F, [[R, 0], [R, H - 4 * w], [R + 2.2 * w, H - 2.2 * w], [R + 2.2 * w, H - 1.2 * w], [R, H], [R - 2 * w, H], [R - 2 * w, 0.02 * H]], seg)
  return { bottom: toW(F, [0, 0, H]) }
}
