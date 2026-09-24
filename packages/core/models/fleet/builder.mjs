// 星座卫星精模的「记账」层：节点 / 部件 / 质量元 / 挂点 / 关节 / 太阳翼组登记，最后汇总成与 paramBus.buildParamModel 同形的结果。
//
// 为什么不直接走 paramBus.buildParamModel：它只认三种布局族（geo / leo-flat / cubesat）的 spec，而这里每一型星都是专门写的造型
// （螺旋天线阵、霍尔推力器、激光终端……）。结果形状与它逐字段相同（ir / attachPoints / articulations / solarPanelGroups /
// massProps / parts / frame / bboxBody / boundingRadiusM / specOriginBody / specHash / spec / warnings），所以 3D 页、工作台、
// 缩略图、链路预算本体布局图、导出这些消费者拿到后不用分辨它是模板还是精模。
//
// ★ 与 paramBus 的三处口径差异（有意的）：
//   ① 原点 = 【平台体几何中心】（本体系原点），不重新居中到包围盒中心：单翼的星链 v1.x 包围盒中心离星体好几米，
//      居中后 3D 页的星点会落在太阳翼上；卫星的轨道位置本就在星体（质心）附近。specOriginBody 恒为 [0,0,0]。
//   ② 节点可以嵌套（item.parent）：万向节上的天线要「先方位后俯仰」两级转动，俯仰节点挂在方位节点下；
//      同一关节不跨父子（paramBus 文件头「平铺」的理由对同一关节成立，对不同关节无碍）。
//   ③ 材质除 paramBus.MATERIALS 的语义键（渲染端换成带程序纹理的库材质）外，还有本目录的定制色（FLEET_MATERIALS，无 key，
//      按 IR 颜色直出）——导航星的白色螺旋罩、星链的深灰结构面这类库里没有的外观。
// ★ spec 字段是 {kind:'fleet', id, rev}，不是 paramBus 的 spec：谁拿它去 buildParamModel 都会被 validateSpec 拒掉
//   （布局族不认识），不会静默画成别的东西。重建一律走 fleet/index.mjs 的 buildFleetModel(id)。

import { createCtx, addItem, comp, boxComp, plateComp, rodComp, pointComp, addAp, worldPositions, meshArea, m3zero, m3add, pAxis, rotInertia, colMajor, z0 } from '../meshKit.mjs'
import { MATERIALS, resolveDensity, nonFiniteReport, fnv1a64Hex, canon } from '../paramBus.mjs'
import { DEFAULT_Q_MODEL2BODY, ROOT_MATRIX_BODY2MODEL } from '../bodyFrame.mjs'
import { attachNodeMatrix } from '../agi.mjs'
import { RofF, BODY, sub, scl, add, nrm } from './kit.mjs'

/**
 * 定制材质（线性色；无 key：渲染端按颜色 / 金属度 / 粗糙度直出 MeshStandardMaterial）。
 * 数值按真实材料的量级取（同 materials.js 的口径），都是示意值。
 */
export const FLEET_MATERIALS = Object.freeze({
  radome: Object.freeze({ color: [0.80, 0.80, 0.77], metalness: 0, roughness: 0.78 }),       // 白色天线罩 / 阵面罩（锗涂层 Kapton、石英布）
  radome_warm: Object.freeze({ color: [0.78, 0.74, 0.66], metalness: 0, roughness: 0.8 }),   // 旧化偏黄的天线罩
  struct_grey: Object.freeze({ color: [0.30, 0.31, 0.33], metalness: 0.75, roughness: 0.42 }),  // 阳极化铝结构面（深灰）
  struct_light: Object.freeze({ color: [0.62, 0.63, 0.64], metalness: 0.85, roughness: 0.38 }), // 本色铝蜂窝板
  black_paint: Object.freeze({ color: [0.025, 0.025, 0.028], metalness: 0, roughness: 0.55 }),  // 消光黑漆 / 黑色阳极化
  ceramic: Object.freeze({ color: [0.62, 0.60, 0.56], metalness: 0, roughness: 0.85 }),     // 霍尔推力器放电通道（氮化硼陶瓷）
  copper: Object.freeze({ color: [0.80, 0.46, 0.28], metalness: 1, roughness: 0.35 }),       // 裸铜螺旋 / 馈线
  mirror_film: Object.freeze({ color: [0.92, 0.93, 0.95], metalness: 1, roughness: 0.1 }),   // 介质镜面膜（星链 v1.5 降亮度）
  blue_grey: Object.freeze({ color: [0.16, 0.20, 0.27], metalness: 0.3, roughness: 0.5 }),   // 蓝灰漆面
  dark_glass: Object.freeze({ color: [0.01, 0.012, 0.015], metalness: 0, roughness: 0.04 }), // 光学窗口
  nav_red: Object.freeze({ color: [0.30, 0.05, 0.035], metalness: 0.35, roughness: 0.45 }),    // 暗红螺旋阵元（北斗五院星 / 东三B 的导航阵，官方渲染即此色）
  gold_metal: Object.freeze({ color: [0.85, 0.62, 0.28], metalness: 1, roughness: 0.3 }),      // 镀金金属件（螺旋、接地杯、细连杆）
  cell_si: Object.freeze({ color: [0.05, 0.11, 0.42], metalness: 0.25, roughness: 0.28 })       // 硅太阳电池（亮蓝，北斗二号 / 东三平台）
})

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** 3×3（行主序 9 元）× 向量 */
const rApplyR = (R, v) => [R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2], R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2], R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2]]
/** R 为「三列 = 三根轴」：复合 Rp · Rc（子系轴在父系下表示 → 在祖先系下表示） */
const rCompose = (Rp, Rc) => [rApplyR(Rp, Rc[0]), rApplyR(Rp, Rc[1]), rApplyR(Rp, Rc[2])]

/**
 * 造一颗星的记账器。
 * @param {{id:string, rev:number}} def  型号定义（fleet/<族>.mjs 导出）
 */
export function createBuilder(def) {
  const ctx = createCtx({ dens: resolveDensity(), def })
  const byName = new Map()
  const B = {
    ctx,
    /**
     * 登记一个几何节点。F = 节点局部系（相对父节点；无父节点即本体系）；part = {id, name, role}（同 id 的节点并成一个部件）。
     * mat = paramBus.MATERIALS 的键或 FLEET_MATERIALS 的键。空网格也登记（关节 / 挂点可以引用）。
     */
    item(name, { part = null, role = part ? part.role : 'other', mat = 'aluminum', mb = null, F = BODY, parent = null } = {}) {
      if (!Object.hasOwn(MATERIALS, mat) && !Object.hasOwn(FLEET_MATERIALS, mat)) throw new Error(`fleet：未知材质「${mat}」（${name}）`)
      if (parent && !byName.has(parent)) throw new Error(`fleet：父节点「${parent}」未登记（${name}）`)
      const it = addItem(ctx, { name, role, part, mat, mb, R: RofF(F), t: F.o.slice() })
      it.parent = parent || null
      byName.set(name, it)
      return it
    },
    /** 已登记节点的世界（本体系）位姿 {R, t}（按父链复合）。 */
    worldOf(name) {
      const it = byName.get(name)
      if (!it) return null
      if (!it.parent) return { R: it.R, t: it.t }
      const p = B.worldOf(it.parent)
      return { R: rCompose(p.R, it.R), t: add(p.t, rApplyR(p.R, it.t)) }
    },
    box: (name, m, c, h) => boxComp(ctx, name, m, c, h),
    plate: (name, m, c, R, w, h) => plateComp(ctx, name, m, c, R, w, h),
    rod: (name, p0, p1) => rodComp(ctx, name, p0, p1),
    point: (name, m, c) => pointComp(ctx, name, m, c),
    /** 实心圆柱质量元（轴 a 单位向量，长 L、半径 r，质心 c）。 */
    cylMass(name, m, c, a, r, L) {
      const ax = nrm(a), iA = m * r * r / 2, iT = m * (3 * r * r + L * L) / 12
      // 局部系：第三轴沿 a
      const e1 = Math.abs(ax[0]) < 0.9 ? nrm(sub([1, 0, 0], scl(ax, ax[0]))) : nrm(sub([0, 1, 0], scl(ax, ax[1])))
      const e2 = [ax[1] * e1[2] - ax[2] * e1[1], ax[2] * e1[0] - ax[0] * e1[2], ax[0] * e1[1] - ax[1] * e1[0]]
      comp(ctx, name, 'cylinder', m, c, rotInertia([e1, e2, ax], iT, iT, iA))
    },
    /** 挂点（本体系）：视轴 dir、上向 up（可省：按 D1 缺省规则补）。 */
    ap: (name, pos, dir, up) => addAp(ctx, name, pos, dir, up),
    /** 关节（AGI_articulations）：stages = [{name, type, minimumValue, maximumValue, initialValue}]。 */
    art(name, nodes, stages, pointingVector) {
      const a = { name, nodes: nodes.slice(), stages: stages.map((s) => ({ ...s })) }
      if (pointingVector) a.pointingVector = pointingVector.slice()
      ctx.arts.push(a)
    },
    /** 太阳翼组（AGI_stk_metadata.solarPanelGroups）：电池片节点 + 效率（%）。 */
    spg: (name, nodes, efficiency) => ctx.spg.push({ name, nodes: nodes.slice(), efficiency }),
    warn: (s) => ctx.warnings.push(s),
    has: (name) => byName.has(name)
  }
  return B
}

/**
 * 汇总：节点 → IR、质量特性（按 def.massKg 把余量摊给平台体质量元 'bus'）、部件、挂点、包围盒。
 * @param {ReturnType<typeof createBuilder>} B
 * @param {{id, rev, title, titleZh, massKg?:{value:number}, massNote?:string}} def
 */
export function finishModel(B, def) {
  const { ctx } = B
  // —— 世界位姿（父链复合）与包围盒
  const W = new Map()
  const worldOf = (it) => {
    if (W.has(it.name)) return W.get(it.name)
    let w
    if (!it.parent) w = { R: it.R, t: it.t }
    else {
      const p = worldOf(ctx.items.find((x) => x.name === it.parent))
      w = { R: rCompose(p.R, it.R), t: add(p.t, rApplyR(p.R, it.t)) }
    }
    W.set(it.name, w)
    return w
  }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  const worldCache = new Map()
  for (const it of ctx.items) {
    if (!it.mb || !it.mb.tcount) continue
    const w = worldOf(it)
    const P = worldPositions(it.mb, w.R, w.t)
    worldCache.set(it, P)
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { const q = P[i + k]; if (q < mn[k]) mn[k] = q; if (q > mx[k]) mx[k] = q }
  }
  if (!Number.isFinite(mn[0])) throw new Error(`fleet：${def.id} 没有生成任何几何`)

  // —— 整星质量对齐：平台体质量元吃余量（均质盒，惯量按比例缩放）
  const target = def.massKg && isNum(def.massKg.value) ? def.massKg.value : null
  if (target && target > 0) {
    const busC = ctx.comps.find((q) => q.name === 'bus')
    const other = ctx.comps.reduce((a, q) => a + (q === busC ? 0 : q.massKg), 0)
    const mb = target - other
    if (busC && mb > 0.05 * target) { const k = mb / busC.massKg; busC.massKg = mb; busC.I = busC.I.map((x) => x * k) }
    else ctx.warnings.push(`整星质量 ${target} kg 小于附件合计 ${other.toFixed(1)} kg 的 1.05 倍，平台体按密度表估算`)
  }
  // 质心对齐：几何按官方质心原点建（导航星的 CSNO / IGS 元数据、伽利略 GSC 元数据都给「相对质心」的偏置）时，
  // 平台体质量元整体平移，让整星质心落在 def.comTarget（平台体吃掉附件造成的偏心；平移量超过平台体半尺寸就不动并告警）
  if (Array.isArray(def.comTarget)) {
    const busC = ctx.comps.find((q) => q.name === 'bus')
    if (busC) {
      let m0 = 0; const s0 = [0, 0, 0]
      for (const q of ctx.comps) { m0 += q.massKg; for (let k = 0; k < 3; k++) s0[k] += q.massKg * q.com[k] }
      const shift = [0, 1, 2].map((k) => (def.comTarget[k] * m0 - s0[k]) / busC.massKg)
      if (Math.hypot(...shift) < 0.6) busC.com = add(busC.com, shift)
      else ctx.warnings.push(`质心对齐需要平台体平移 ${Math.hypot(...shift).toFixed(2)} m，超限未做`)
    }
  }
  let M = 0; const S = [0, 0, 0]
  for (const q of ctx.comps) { M += q.massKg; S[0] += q.massKg * q.com[0]; S[1] += q.massKg * q.com[1]; S[2] += q.massKg * q.com[2] }
  const com = scl(S, 1 / M)
  let I = m3zero()
  for (const q of ctx.comps) I = m3add(I, m3add(q.I, pAxis(q.massKg, sub(q.com, com))))
  const Is = [[I[0], (I[1] + I[3]) / 2, (I[2] + I[6]) / 2], [(I[1] + I[3]) / 2, I[4], (I[5] + I[7]) / 2], [(I[2] + I[6]) / 2, (I[5] + I[7]) / 2, I[8]]].map((r) => r.map(z0))
  const massProps = {
    massKg: M, comBody: com.map(z0), inertiaBody: Is, source: 'components', confidence: 'low',
    components: ctx.comps.map((q) => ({ name: q.name, kind: q.kind, massKg: q.massKg, comBody: q.com.map(z0) }))
  }

  // —— IR
  const ir = { units: 'm', unitHint: 'm', sourceFormat: 'param', materials: [], meshes: [], nodes: [] }
  const matIdx = new Map()
  const matOf = (key) => {
    if (!matIdx.has(key)) {
      let m
      if (Object.hasOwn(MATERIALS, key)) {
        const d = MATERIALS[key]
        m = { name: key, key, color: d.color.slice(), metalness: d.metalness, roughness: d.roughness }
        if (d.doubleSided) m.doubleSided = true
        if (isNum(d.opacity)) m.opacity = d.opacity
      } else {
        const d = FLEET_MATERIALS[key]
        m = { name: `fleet_${key}`, color: d.color.slice(), metalness: d.metalness, roughness: d.roughness }
        if (d.doubleSided) m.doubleSided = true
        if (isNum(d.opacity)) m.opacity = d.opacity
      }
      ir.materials.push(m); matIdx.set(key, ir.materials.length - 1)
    }
    return matIdx.get(key)
  }
  if (ctx.names.has('satellite')) throw new Error('fleet：节点名 satellite 被占用')
  ir.nodes.push({ name: 'satellite', parent: -1, matrix: ROOT_MATRIX_BODY2MODEL.slice(), role: 'other', extras: { paramRoot: true, fleet: def.id } })
  const nodeIdx = new Map()
  for (const it of ctx.items) {
    const node = { name: it.name, parent: it.parent ? nodeIdx.get(it.parent) : 0, matrix: colMajor(it.R, it.t) }
    if (node.parent === undefined) throw new Error(`fleet：${it.name} 的父节点须先登记`)
    if (it.role) node.role = it.role
    if (it.part) node.extras = { part: it.part.id }
    if (it.mb && it.mb.tcount) {
      ir.meshes.push({ name: it.name, position: Float32Array.from(it.mb.p), normal: Float32Array.from(it.mb.n), uv: Float32Array.from(it.mb.uv), index: Uint32Array.from(it.mb.idx), material: matOf(it.mat) })
      node.mesh = ir.meshes.length - 1
    }
    ir.nodes.push(node)
    nodeIdx.set(it.name, ir.nodes.length - 1)
  }
  const attachPoints = ctx.aps.map((a) => {
    ir.nodes.push({ name: a.name, parent: 0, matrix: attachNodeMatrix(a.posBody, a.dirBody, a.upBody), extras: { attachPoint: true } })
    return { name: a.name, node: a.name, posBody: a.posBody.map(z0), dirBody: a.dirBody.map(z0), upBody: a.upBody.map(z0) }
  })

  // —— 部件（面积没给的按网格量）
  const parts = []
  for (const p of ctx.parts.values()) {
    if (!(p.areaM2 > 0)) {
      let A = 0
      for (const it of ctx.items) if (p.nodes.includes(it.name) && worldCache.has(it)) A += meshArea(worldCache.get(it), it.mb.idx)
      p.areaM2 = A
    }
    const o = { id: p.id, name: p.name, role: p.role, nodes: p.nodes.slice(), areaM2: p.areaM2 }
    if (p.normalBody) o.normalBody = p.normalBody.map(z0)
    parts.push(o)
  }

  const bmin = mn.map(z0), bmax = mx.map(z0)
  let rMax = 0
  for (let i = 0; i < 8; i++) rMax = Math.max(rMax, Math.hypot(i & 1 ? bmax[0] : bmin[0], i & 2 ? bmax[1] : bmin[1], i & 4 ? bmax[2] : bmin[2]))
  const spec = { kind: 'fleet', id: def.id, rev: def.rev }
  const res = {
    ir, attachPoints,
    articulations: ctx.arts.map((a) => ({ ...a, nodes: a.nodes.slice(), stages: a.stages.map((q) => ({ ...q })) })),
    solarPanelGroups: ctx.spg.map((g) => ({ name: g.name, nodes: g.nodes.slice(), efficiency: g.efficiency })),
    massProps, parts,
    frame: { q_model2body: DEFAULT_Q_MODEL2BODY.slice(), t_model2body: [0, 0, 0], verified: true },
    bboxBody: { min: bmin, max: bmax },
    boundingRadiusM: rMax,
    specOriginBody: [0, 0, 0],
    specHash: fnv1a64Hex(canon(spec)),
    spec,
    warnings: ctx.warnings.slice()
  }
  const bad = nonFiniteReport(res)
  if (bad.length) throw new Error(`fleet：${def.id} 生成结果含非有限数：${bad.slice(0, 6).join('、')}`)
  return res
}
