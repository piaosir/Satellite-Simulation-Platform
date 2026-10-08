// 按部件类型赋密度的质量特性估算（导入件「估算」档主路径，2026-10 专业度审查 P0-1 / P0-2）。
//
// 纯 ESM、零 three 依赖、node 可测。为什么不再用整体均质：
//   · 网格不闭合时旧口径拿「面积加权表面形心」当质心——那只对均匀面密度薄壳成立；卫星质量集中在星体（约 290 kg/m³），
//     太阳翼 / 网状反射面面积大而面密度只有 0.6–2.4 kg/m²，形心被拉向附件（实测平板 LEO 偏 3.7 m、SSL-1300 偏 5.1 m）；
//   · 网格闭合时整体均质积分把太阳翼也当实心（默认卫星 Ixx 比组件模型大 2.4 倍）。
// 做法（与参数化生成器同一张密度表 paramBus.DENSITY，AIAA S-120A「按质量分布求质心」）：
//   每个部件（部件识别的结果：整实例 nodes + 实例内三角形区间 triRanges；没归属的三角形并成「其余」）
//     · 星体类（bus）：按包围盒实心盒，体密度 busVolume（导入件的星体多半不闭合、内部结构看不见，盒体是工程上的标准近似）；
//     · 闭合的其它部件：实体，体积 × 体密度；
//     · 不闭合的：薄壳，面积 × 面密度（双面薄板的网格两面都画了 → 按一半面积计；喇叭 / 杆件 / 推力器一类单面壳按全面积）。
//   名义质量按角色取密度；给了总质量就整体等比缩放到总质量（分布不变）；各部件自身惯量 + 平行轴合成（combineComponents）。
// 结果 confidence 一律 'low'（估算），method = 'parts'，partsMass 逐件给出（组件档的质量表、报告用）。
//
// 导出：
//   ROLE_DENSITY                         角色 → {kind:'solid'|'shell'|'box', key: DENSITY 键, sides: 1|2}
//   partGeometry(instances, parts)       → [{id, role, position, index}]：按部件归属切好的本体系三角形（含「其余」）
//   partUnitProps(geom, tol?)            → {closed, volume, area, com, Iunit, bbox}：单位密度（体 / 面）下的几何矩
//   estimateByParts({instances, parts, massKg?, density?, tol?}) → 见下

import { weldByPosition, isClosed, polyhedronMassProps, orientShells, combineComponents } from './massProps.mjs'
import { shellProps } from './meshKit.mjs'
import { DENSITY } from './paramBus.mjs'

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 角色 → 估算口径。sides：薄壳网格两面都画（板件）→ 按一半面积计面密度 */
export const ROLE_DENSITY = Object.freeze({
  bus: { kind: 'box', key: 'busVolume' },
  solarArray: { kind: 'shell', key: 'panelAreal', plus: 'cellAreal', sides: 2 },
  reflector: { kind: 'shell', key: 'reflectorAreal', sides: 2 },
  radiator: { kind: 'shell', key: 'radiatorAreal', sides: 2 },
  feed: { kind: 'shell', key: 'hornAreal', sides: 1 },
  boom: { kind: 'shell', key: 'towerAreal', sides: 1 },
  thruster: { kind: 'shell', key: 'hornAreal', sides: 1 },
  sensor: { kind: 'shell', key: 'towerAreal', sides: 1 },
  other: { kind: 'shell', key: 'towerAreal', sides: 1 }
})

/** 列主序 4×4 作用到点 */
function xf(M, x, y, z, out, o) {
  if (!M) { out[o] = x; out[o + 1] = y; out[o + 2] = z; return }
  out[o] = M[0] * x + M[4] * y + M[8] * z + M[12]
  out[o + 1] = M[1] * x + M[5] * y + M[9] * z + M[13]
  out[o + 2] = M[2] * x + M[6] * y + M[10] * z + M[14]
}
const det3 = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])

/**
 * 按部件归属切三角形（本体系）。instances：[{node, position, index?, matrix?}]（matrix 已含模型 → 本体与米制缩放）；
 * parts：[{id, role, nodes?:[节点名], triRanges?:[{node, ranges:[[起始, 个数]…]}]}]。没归属的三角形并成 {id:'~rest', role:'other'}。
 * @returns {{id:string, role:string, position:Float64Array, index:Uint32Array}[]}
 */
export function partGeometry(instances, parts) {
  const inst = (Array.isArray(instances) ? instances : []).filter((m) => m && m.position && m.position.length >= 9)
  const ps = (Array.isArray(parts) ? parts : []).filter(isObj)
  // 每个实例的三角形归属：-1 = 其余
  const owner = inst.map((m) => new Int32Array(((m.index ? m.index.length : m.position.length / 3) / 3) | 0).fill(-1))
  const byNode = new Map()
  inst.forEach((m, k) => { const a = byNode.get(m.node) || []; a.push(k); byNode.set(m.node, a) })
  ps.forEach((p, pi) => {
    for (const nm of Array.isArray(p.nodes) ? p.nodes : []) for (const k of byNode.get(nm) || []) owner[k].fill(pi)
    for (const tr of Array.isArray(p.triRanges) ? p.triRanges : []) {
      for (const k of byNode.get(tr && tr.node) || []) {
        for (const r of Array.isArray(tr.ranges) ? tr.ranges : []) {
          const s = Math.max(0, r[0] | 0), e = Math.min(owner[k].length, s + (r[1] | 0))
          for (let t = s; t < e; t++) owner[k][t] = pi
        }
      }
    }
  })
  const out = []
  const slots = ps.length + 1   // 最后一格 = 其余
  const counts = new Array(slots).fill(0)
  inst.forEach((m, k) => { for (const o of owner[k]) counts[o < 0 ? ps.length : o]++ })
  for (let pi = 0; pi < slots; pi++) {
    const T = counts[pi]
    if (!T) continue
    const pos = new Float64Array(T * 9), idx = new Uint32Array(T * 3)
    let w = 0
    inst.forEach((m, k) => {
      const P = m.position, I = m.index, M = m.matrix || null
      const flip = M ? det3(M) < 0 : false
      const own = owner[k]
      for (let t = 0; t < own.length; t++) {
        if ((own[t] < 0 ? ps.length : own[t]) !== pi) continue
        const v = I ? [I[t * 3], I[t * 3 + 1], I[t * 3 + 2]] : [t * 3, t * 3 + 1, t * 3 + 2]
        if (flip) { const x = v[1]; v[1] = v[2]; v[2] = x }
        for (let j = 0; j < 3; j++) { xf(M, P[v[j] * 3], P[v[j] * 3 + 1], P[v[j] * 3 + 2], pos, (w * 3 + j) * 3); idx[w * 3 + j] = w * 3 + j }
        w++
      }
    })
    const p = pi < ps.length ? ps[pi] : null
    out.push({ id: p ? String(p.id || p.name || 'p' + pi) : '~rest', role: p && ROLE_DENSITY[p.role] ? p.role : 'other', position: pos, index: idx })
  }
  return out
}

/** 单位密度下的几何矩：闭合 → 体积 / 体心 / 单位体密度惯量；不闭合 → 面积 / 面心 / 单位面密度惯量；外加包围盒 */
export function partUnitProps(g, tol) {
  const w = weldByPosition(g.position, g.index, tol)
  const P = w.position, I = w.index
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { if (P[i + k] < b[k]) b[k] = P[i + k]; if (P[i + k] > b[k + 3]) b[k + 3] = P[i + k] }
  const topo = isClosed(I, w.vertexCount)
  let solid = null
  if (topo.closed) {
    const sh = orientShells(P, I, w.vertexCount)
    const mp = polyhedronMassProps(P, sh.index, 1)
    if (mp.volume > 0) solid = { volume: mp.volume, com: mp.centroid, I: mp.inertia }
  }
  const s = shellProps(P, I, 1)
  const Ish = [[s.I[0], s.I[1], s.I[2]], [s.I[3], s.I[4], s.I[5]], [s.I[6], s.I[7], s.I[8]]]
  return { closed: !!solid, solid, area: s.area, shell: { com: s.com, I: Ish }, bbox: b }
}

/** 实心盒（中心 c、边长 d）单位体密度的惯量 */
function boxUnit(d) {
  const V = d[0] * d[1] * d[2]
  return { volume: V, I: [[V * (d[1] * d[1] + d[2] * d[2]) / 12, 0, 0], [0, V * (d[0] * d[0] + d[2] * d[2]) / 12, 0], [0, 0, V * (d[0] * d[0] + d[1] * d[1]) / 12]] }
}
const scaleM = (I, k) => I.map((r) => r.map((v) => v * k))

/**
 * @param {{instances:object[], parts:object[], massKg?:number, density?:object, tol?:number}} o
 *   density：DENSITY 键的覆盖值（缺省 paramBus.DENSITY）
 * @returns {null | {source:'estimate', method:'parts', confidence:'low', closed:boolean, massKg:number, comBody:number[], inertiaBody:number[][],
 *   areaM2:number, volumeM3:null, partsMass:{id:string, role:string, massKg:number, comBody:number[], inertiaCom:number[][], solid:boolean}[], scale:number}}
 *   没有可用三角形 → null。massKg 缺省 / 非正：按名义密度给出质量（scale = 1）。
 */
export function estimateByParts({ instances, parts, massKg, density, tol } = {}) {
  const geoms = partGeometry(instances, parts)
  if (!geoms.length) return null
  const dens = (k) => (isObj(density) && isNum(density[k]) ? density[k] : DENSITY[k].value)
  const items = []
  let allClosed = true, area = 0
  for (const g of geoms) {
    const u = partUnitProps(g, tol)
    area += u.area
    if (!u.closed) allClosed = false
    const rule = ROLE_DENSITY[g.role] || ROLE_DENSITY.other
    let m = 0, com = null, I = null, solid = false
    if (rule.kind === 'box') {
      // 星体：包围盒实心盒（闭合也取盒：导入件星体的闭合壳常是外蒙皮 + 内部空腔，体积不代表质量分布）
      const d = [u.bbox[3] - u.bbox[0], u.bbox[4] - u.bbox[1], u.bbox[5] - u.bbox[2]]
      const bx = boxUnit(d)
      const rho = dens(rule.key)
      m = rho * bx.volume; com = [(u.bbox[0] + u.bbox[3]) / 2, (u.bbox[1] + u.bbox[4]) / 2, (u.bbox[2] + u.bbox[5]) / 2]; I = scaleM(bx.I, rho); solid = true
    } else if (u.closed && u.solid && rule.sides !== 2) {
      // 闭合的非板件（推力器、敏感器、实心杆…）：体积 × 星体等效体密度
      const rho = dens('busVolume')
      m = rho * u.solid.volume; com = u.solid.com; I = scaleM(u.solid.I, rho); solid = true
    } else {
      // 薄壳：面积 × 面密度；双面板件按一半面积（惯量同比例）
      const k = (dens(rule.key) + (rule.plus ? dens(rule.plus) : 0)) / (rule.sides === 2 ? 2 : 1)
      m = k * u.area; com = u.shell.com; I = scaleM(u.shell.I, k)
    }
    if (m > 0 && com && com.every(isNum)) items.push({ id: g.id, role: g.role, massKg: m, comBody: com, inertiaCom: I, solid })
  }
  if (!items.length) return null
  const nominal = items.reduce((s, x) => s + x.massKg, 0)
  const scale = isNum(massKg) && massKg > 0 ? massKg / nominal : 1
  if (scale !== 1) for (const x of items) { x.massKg *= scale; x.inertiaCom = scaleM(x.inertiaCom, scale) }
  const r = combineComponents(items)
  if (!r) return null
  return {
    source: 'estimate', method: 'parts', confidence: 'low', closed: allClosed,
    massKg: r.massKg, comBody: r.comBody, inertiaBody: r.inertiaBody, areaM2: area, volumeM3: null,
    partsMass: items, scale
  }
}

/**
 * 部件的单位质量惯量（组件档：用户逐件给质量时补上各件自身惯量，不再当质点）。
 * @returns {{id:string, role:string, comBody:number[], inertiaPerKg:number[][]}[]}
 */
export function partInertiaPerKg({ instances, parts, density, tol } = {}) {
  const r = estimateByParts({ instances, parts, density, tol })
  if (!r) return []
  return r.partsMass.map((x) => ({ id: x.id, role: x.role, comBody: x.comBody.slice(), inertiaPerKg: scaleM(x.inertiaCom, 1 / x.massKg) }))
}
