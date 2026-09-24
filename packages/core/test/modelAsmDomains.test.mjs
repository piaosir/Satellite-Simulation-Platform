// 非卫星领域装配组件（components/{ground,air,sea,veh,shapeKit}.mjs）+ 内置实体模板（models/entityTemplates.mjs）单测
// （三期契约 DESIGN3 §1 P1b、E5、E13；A3 规格 §9 全部条目）。
//
// ① 登记：四个领域的组件都在注册表里、领域正确，卫星库仍恰好 15 件。
// ② 逐件缺省可建（在其首个领域的单件文档里）：IR 合法 / 有限 / 无告警 / 质量 > 0 / 三角形 ≤ 5 万 / 法向单位长；插座 7 键、滚转档、单位向量；
//    平面面 u × v = n、柱面 axis ⟂ ref。
// ③ 参数边界：逐件逐参数单变（int 另取 min+1 与中值，扫到奇数），合法的必须生成且有限，非法的必须抛 SPEC_INVALID。
// ③′ 几何健全：不出两顶点重合的零面积三角形；水平插座贴在网格上、正上方无遮挡；accepts 推荐的组合滚转 0° 时与父件同向。
// ④ 对称面声明逐顶点核验（缺省 + ③ 的全部单变变体，按参数重算声明）；⑤ 镜像数学（机翼 / 短舱钩子、尾吊短舱自带镜像）。
// ⑤′ 专项几何回归：方位俯仰座叉臂落在叉座横梁 / 转台上、天线罩截球到底座环、固定仰角点质量随网格转、机身贴面贴蒙皮、
//    甲板贴面不出甲板、船体肩部切向连续（甲板边线 + 网格逐站水线 / 舭部侧影转角）、集装箱件不出舷、舷侧瓦楞是同色几何（深色贴花只剩层缝）、
//    风扇正面看不到辐条缝、车壳顶 = 出处车高。
// ⑥ 领域本体轴（E5）；⑦ 模板（id / 冻结 / 生成 / prov 按式子独立重算对拍 / 出处尺寸几何闭合 / 质量 / 确定性含跨进程 / 关节驱动）。
// ⑦′ 模板出处口径：飞机模板没有凭记忆的绝对长度（留空走自动式或「有出处尺寸 × 示意比例」）、G650 罩外形待输入；
//    船载罩尺寸 / 质量进 dims 与 prov；展开座方位行程与组件同为示意值。
// ⑧ 禁词扫描（内置目录不带相关型号）；⑨ 参数化整星金标准文件未变。
// 不联网。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as A from '../models/assembly.mjs'
import { getComponent, listComponents, componentTypes, fillParams, checkParams, socketAccepts } from '../models/components/index.mjs'
import { gimbalValues } from '../models/components/ground.mjs'
import { SHIP_RADOMES, hullShapeInfo } from '../models/components/sea.mjs'
import { FLAT_PANELS, DRIVEAWAYS } from '../models/components/veh.mjs'
import { AERO_RADOMES } from '../models/components/air.mjs'
import { matOr } from '../models/components/shapeKit.mjs'
import * as E from '../models/entityTemplates.mjs'
import { validateIR, MATERIAL_KEYS } from '../models/ir.mjs'
import { nonFiniteReport, buildParamModel, MATERIALS } from '../models/paramBus.mjs'
import { templateSpec, TEMPLATE_IDS, DEFAULT_TEMPLATE_ID } from '../models/paramTemplates.mjs'
import { Q_YUP_ZENITH } from '../models/bodyFrame.mjs'
import { isValidModelId, parseModelId } from '../models/schema.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（容差 ${tol}）`)
const nearRel = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}：${a} vs ${b}（相对容差 ${rel}）`)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const NAME_RE = /^[A-Za-z0-9_+-]+$/
const MODELS = fileURLToPath(new URL('../models/', import.meta.url))

// ───────────────────────── 小工具 ─────────────────────────

function mulM(a, b) {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[4 * c + r] += a[4 * k + r] * b[4 * c + k]
  return o
}
const ID16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
/** 节点在本体系的 4×4（根节点之下的链乘；根矩阵 = 本体 → 模型轴，不乘）。 */
function bodyMatrix(ir, i) {
  let m = ID16
  for (let k = i; k > 0 && ir.nodes[k].parent >= 0; k = ir.nodes[k].parent) m = mulM(ir.nodes[k].matrix, m)
  return m
}
const det3 = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
const apply = (M, x, y, z) => [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]]
const applyDir = (M, v) => [M[0] * v[0] + M[4] * v[1] + M[8] * v[2], M[1] * v[0] + M[5] * v[1] + M[9] * v[2], M[2] * v[0] + M[6] * v[1] + M[10] * v[2]]
/** 结果里网格节点的顶点 / 法向（文档坐标 = 本体系 + specOriginBody；filter(name) 选节点）。buildComponent 的结果 origin 为 0。 */
function meshes(res, filter = null) {
  const ir = res.ir, o = res.specOriginBody || [0, 0, 0], out = []
  ir.nodes.forEach((nd, i) => {
    if (nd.mesh === undefined || (filter && !filter(nd.name))) return
    const M = bodyMatrix(ir, i), m = ir.meshes[nd.mesh], P = [], N = []
    for (let v = 0; v < m.position.length; v += 3) {
      const p = apply(M, m.position[v], m.position[v + 1], m.position[v + 2])
      P.push([p[0] + o[0], p[1] + o[1], p[2] + o[2]])
      N.push(applyDir(M, [m.normal[v], m.normal[v + 1], m.normal[v + 2]]))
    }
    out.push({ name: nd.name, P, N, index: m.index, M })
  })
  return out
}
const allPts = (ms) => ms.flatMap((m) => m.P)
function bboxOf(P) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (const p of P) for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k] }
  return { mn, mx, size: mx.map((v, k) => v - mn[k]) }
}
/** 量化到 1e-4 m（四舍五入远离 0，正负对称）。 */
const q4 = (x) => { const r = Math.sign(x) * Math.round(Math.abs(x) * 1e4); return r === 0 ? 0 : r }
const vset = (P, S = [1, 1, 1]) => new Set(P.map((p) => p.map((x, k) => q4(x * S[k])).join(',')))
function sameSet(a, b, msg) {
  assert.equal(a.size, b.size, `${msg}：点数 ${a.size} vs ${b.size}`)
  let miss = 0, ex = null
  for (const k of a) if (!b.has(k)) { miss++; ex = ex || k }
  assert.equal(miss, 0, `${msg}：${miss} 点无对应（例 ${ex}）`)
}
const trisOf = (ir) => ir.meshes.reduce((s, m) => s + m.index.length / 3, 0)
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
/**
 * 射线 o + t·d（t > 1e-9）与网格（meshes() 的结果，文档坐标）的全部交点，按 t 升序：[{t, name, enter}]。
 * Möller–Trumbore 双面求交；enter = 绕序法向与 d 反向（从外进入闭合体）。
 */
function castRay(ms, o, d) {
  const hits = []
  for (const m of ms) {
    const P = m.P, I = m.index
    for (let k = 0; k < I.length; k += 3) {
      const a = P[I[k]], b = P[I[k + 1]], c = P[I[k + 2]], e1 = sub3(b, a), e2 = sub3(c, a), pv = cross3(d, e2), det = dot3(e1, pv)
      if (Math.abs(det) < 1e-14) continue
      const tv = sub3(o, a), u = dot3(tv, pv) / det
      if (u < 0 || u > 1) continue
      const qv = cross3(tv, e1), v = dot3(d, qv) / det
      if (v < 0 || u + v > 1) continue
      const t = dot3(e2, qv) / det
      if (t > 1e-9) hits.push({ t, name: m.name, enter: dot3(cross3(e1, e2), d) < 0 })
    }
  }
  return hits.sort((x, y) => x.t - y.t)
}
/** 沿射线「在闭合体内」的区间并集（按进出计数，重叠 / 相接的件合并成一段）：[[t0, t1], …]。 */
function insideIntervals(hits) {
  const out = []
  let depth = 0, t0 = 0
  for (const h of hits) {
    if (h.enter) { if (depth++ === 0) t0 = h.t } else if (depth > 0 && --depth === 0) {
      const last = out[out.length - 1]
      if (last && t0 - last[1] < 1e-7) last[1] = h.t
      else out.push([t0, h.t])
    }
  }
  return out
}
/** 闭合网格的有向体积（绕序朝外为正）。 */
function signedVolume(m) {
  let v = 0
  for (let i = 0; i < m.index.length; i += 3) {
    const a = m.P[m.index[i]], b = m.P[m.index[i + 1]], c = m.P[m.index[i + 2]]
    v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
  }
  return v / 6
}
/** 3×3 对称阵特征值（Jacobi）。 */
function eig3(I) {
  const a = I.map((r) => r.slice())
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q]
    if (off < 1e-30 * (a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2 + 1e-300)) break
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), tt = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1))
      const c = 1 / Math.sqrt(tt * tt + 1), s = tt * c
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk }
    }
  }
  return [a[0][0], a[1][1], a[2][2]].sort((x, y) => x - y)
}
const DOMAIN_OF = { es: 'ground', air: 'aircraft', sea: 'ship', veh: 'vehicle' }
const singleDoc = (type, domain) => ({ kind: 'assembly', schema: 1, domain, name: 't', comps: [{ id: 'c1', type, parent: null }] })

const GROUND = ['es.pedestal.azel', 'es.pedestal.xy', 'es.refl.prime', 'es.refl.cass', 'es.refl.offset', 'es.subrefl', 'es.feed', 'es.radome', 'es.shelter', 'es.tower', 'es.vsat.mount', 'es.pedestal.wheeltrack', 'es.mast']
const AIR = ['air.fuselage', 'air.wing', 'air.htail', 'air.vtail', 'air.nacelle', 'air.prop', 'air.radome', 'air.turret']
const SEA = ['sea.hull', 'sea.superstructure', 'sea.funnel', 'sea.mast', 'sea.containers', 'sea.vsat.radome']
const VEH = ['veh.body', 'veh.cotm.flat', 'veh.driveaway']
const DOMAIN_TYPES = [...GROUND, ...AIR, ...SEA, ...VEH]
const DEFS = DOMAIN_TYPES.map(getComponent)

// ───────────────────────── ① 登记 ─────────────────────────

t('登记：ground 13 / air 8 / sea 6 / veh 3 件全在注册表、登记顺序即组件库顺序、领域含本领域；卫星库仍 15 件', () => {
  const types = componentTypes()
  for (const ty of DOMAIN_TYPES) assert.ok(types.includes(ty), `缺 ${ty}`)
  const tail = types.slice(types.indexOf('es.pedestal.azel'))
  assert.deepStrictEqual(tail, DOMAIN_TYPES, '登记顺序 ground → air → sea → veh')
  for (const def of DEFS) {
    const home = DOMAIN_OF[def.type.split('.')[0]]
    assert.ok(def.domain.includes(home), `${def.type} 领域含 ${home}`)
    assert.ok(!def.domain.includes('spacecraft'), `${def.type} 不进卫星库`)
    for (const k of def.keys) {
      const s = def.params[k]
      assert.ok(s.label && s.source, `${def.type}.${k} 缺标签 / 出处`)
      assert.ok(s.source === 'illustrative' || /^https?:\/\/\S+$/.test(s.source), `${def.type}.${k} 出处须为 illustrative 或 URL：${s.source}`)
    }
  }
  assert.equal(listComponents('spacecraft').length, 15)
  for (const [d, list] of [['ground', GROUND], ['aircraft', AIR], ['ship', SEA], ['vehicle', VEH]]) {
    const got = listComponents(d).map((x) => x.type)
    for (const ty of list) if (getComponent(ty).domain.includes(d)) assert.ok(got.includes(ty), `${d} 库缺 ${ty}`)
  }
})

t('材质扩充：九个计划键在 ir.MATERIAL_KEYS 与 paramBus.MATERIALS 两处都有（线性色、非金属），matOr 取到计划键', () => {
  const planned = ['paint_red', 'paint_navy', 'paint_blue', 'paint_green', 'paint_orange', 'paint_yellow', 'paint_grey', 'rubber', 'concrete']
  for (const k of planned) {
    assert.ok(MATERIAL_KEYS.includes(k) && Object.hasOwn(MATERIALS, k), `缺材质键 ${k}`)
    const m = MATERIALS[k]
    assert.ok(m.color.every((c) => c >= 0 && c <= 1) && m.metalness === 0 && m.roughness > 0 && m.roughness <= 1, `${k} PBR 参数`)
    assert.equal(matOr(k, 'titanium'), k, `matOr(${k})`)
  }
  for (const k of MATERIAL_KEYS) assert.ok(Object.hasOwn(MATERIALS, k), `MATERIALS 缺 ${k}`)
  assert.equal(matOr('no_such_key', 'titanium'), 'titanium')
})

// ───────────────────────── ② 逐件缺省可建 ─────────────────────────

const SOCK_KEYS = ['accepts', 'id', 'n', 'pos', 'roll', 'size', 'up']
const unit = (v, tol, msg) => near(Math.hypot(...v), 1, tol, msg)
t('逐件缺省可建：IR 合法有限、无告警、质量 > 0、三角形 ≤ 5 万、法向单位长；插座 / 面形状', () => {
  for (const def of DEFS) {
    const ty = def.type
    const r = A.buildAssembly(singleDoc(ty, def.domain[0]))
    const v = validateIR(r.ir)
    assert.ok(v.ok, `${ty} validateIR：${v.errors.join('；')}`)
    assert.deepStrictEqual(nonFiniteReport(r), [], `${ty} 非有限数`)
    assert.deepStrictEqual(r.warnings, [], `${ty} 告警`)
    assert.ok(r.massProps.massKg > 0, `${ty} 质量`)
    const tris = trisOf(r.ir)
    assert.ok(tris > 0 && tris <= 50000, `${ty} 三角形 ${tris}`)
    for (const nd of r.ir.nodes) assert.ok(NAME_RE.test(nd.name), `${ty} 节点名 ${nd.name}`)
    for (const m of r.ir.meshes) for (let i = 0; i < m.normal.length; i += 3) {
      const l = Math.hypot(m.normal[i], m.normal[i + 1], m.normal[i + 2])
      if (Math.abs(l - 1) > 1e-5) assert.fail(`${ty} ${m.name} 法向 #${i / 3} 长 ${l}`)
    }
    const p = fillParams(def, {})
    assert.deepStrictEqual(checkParams(def, p), [], `${ty} 缺省参数合法`)
    const socks = def.sockets(p)
    assert.ok(socks.some((s) => s.id === def.mountSocket), `${ty} mountSocket 在插座里`)
    for (const s of socks) {
      assert.deepStrictEqual(Object.keys(s).sort(), SOCK_KEYS, `${ty}.${s.id} 字段`)
      assert.ok([15, 60, 90].includes(s.roll), `${ty}.${s.id} roll ${s.roll}`)
      unit(s.n, 1e-12, `${ty}.${s.id} n`); unit(s.up, 1e-12, `${ty}.${s.id} up`)
      near(s.n[0] * s.up[0] + s.n[1] * s.up[1] + s.n[2] * s.up[2], 0, 1e-9, `${ty}.${s.id} up ⟂ n`)
      assert.ok(s.size > 0 && isNum(s.size), `${ty}.${s.id} size`)
      assert.ok(s.accepts === null || (Array.isArray(s.accepts) && s.accepts.length && s.accepts.every((x) => typeof x === 'string' && x)), `${ty}.${s.id} accepts`)
      for (const x of [...s.pos, ...s.n, ...s.up]) assert.ok(isNum(x) && !Object.is(x, -0), `${ty}.${s.id} 分量有限且无 −0`)
    }
    for (const f of def.faces(p)) {
      if (f.kind === 'plane') {
        const c = [f.u[1] * f.v[2] - f.u[2] * f.v[1], f.u[2] * f.v[0] - f.u[0] * f.v[2], f.u[0] * f.v[1] - f.u[1] * f.v[0]]
        c.forEach((x, k) => near(x, f.n[k], 1e-12, `${ty} 面 ${f.id}：u × v = n`))
        assert.ok(f.halfU > 0 && f.halfV > 0, `${ty} 面 ${f.id} 半尺寸`)
      } else {
        assert.equal(f.kind, 'cyl', `${ty} 面 ${f.id} 类型`)
        unit(f.axis, 1e-12, `${ty} 柱面 ${f.id} axis`); unit(f.ref, 1e-12, `${ty} 柱面 ${f.id} ref`)
        near(f.axis[0] * f.ref[0] + f.axis[1] * f.ref[1] + f.axis[2] * f.ref[2], 0, 1e-12, `${ty} 柱面 ${f.id} axis ⟂ ref`)
      }
    }
  }
})

// ───────────────────────── ③ 参数边界 ─────────────────────────

/** buildComponent 结果全部数值有限。 */
function compFinite(r) {
  for (const m of r.ir.meshes) for (const k of ['position', 'normal', 'uv']) for (let i = 0; i < m[k].length; i++) if (!Number.isFinite(m[k][i])) return `${m.name}.${k}`
  for (const nd of r.ir.nodes) if (nd.matrix && !nd.matrix.every(isNum)) return `节点 ${nd.name}`
  for (const a of r.attachPoints) if (![...a.posBody, ...a.dirBody, ...a.upBody].every(isNum)) return `挂点 ${a.name}`
  if (![...r.bbox.min, ...r.bbox.max].every(isNum)) return 'bbox'
  if (!isNum(r.massKg)) return 'massKg'
  return null
}
function boundaryValues(s) {
  const vals = new Set([s.def])
  if (s.kind === 'bool') { vals.add(true); vals.add(false) } else if (s.kind === 'enum') for (const o of s.options) vals.add(o)
  else if (s.kind === 'int') {
    if (s.options) for (const o of s.options) vals.add(o)
    else {
      if (isNum(s.min)) vals.add(s.min)
      if (isNum(s.max)) vals.add(s.max)
      if (isNum(s.min) && isNum(s.max)) { vals.add(s.min + 1); vals.add(Math.floor((s.min + s.max) / 2)) }   // 奇数肋数 / 奇数管数这类
    }
  } else {
    if (isNum(s.min)) vals.add(s.min); else if (isNum(s.gt)) vals.add(s.gt * (1 + 1e-3) + 1e-6)
    if (isNum(s.max)) vals.add(s.max); else if (isNum(s.def)) vals.add(s.def * 3)
    if (s.nullable) vals.add(null)
  }
  return [...vals]
}
const boundaryStats = { ok: 0, rejected: 0 }
/** ③ 里生成成功的合法变体（④ 对称面核验复用；只存参数，④ 重新生成）：[{def, p}]。 */
const VARIANTS = []
t('参数边界：逐件逐参数单变，合法 → 生成成功且有限；非法 → 抛 SPEC_INVALID', () => {
  for (const def of DEFS) {
    const base = fillParams(def, {})
    const seen = new Set()
    for (const k of def.keys) {
      for (const v of boundaryValues(def.params[k])) {
        const p = { ...base, [k]: v }, tag = `${def.type}.${k} = ${JSON.stringify(v)}`
        const errs = checkParams(def, fillParams(def, p))
        if (!errs.length) {
          let r
          try { r = A.buildComponent(def.type, p) } catch (e) { assert.fail(`${tag}：参数合法却生成失败：${e.message}`) }
          const bad = compFinite(r)
          assert.equal(bad, null, `${tag}：${bad} 含非有限数`)
          boundaryStats.ok++
          const key = JSON.stringify(fillParams(def, p))
          if (!seen.has(key)) { seen.add(key); VARIANTS.push({ def, p: fillParams(def, p) }) }
        } else {
          assert.throws(() => A.buildComponent(def.type, p), (e) => e.code === 'SPEC_INVALID', `${tag}：非法参数须抛 SPEC_INVALID`)
          boundaryStats.rejected++
        }
      }
    }
  }
  assert.ok(boundaryStats.ok > 300, `合法变体 ${boundaryStats.ok}`)
})

// ───────────────────────── ③′ 几何健全 ─────────────────────────

t('网格健全：缺省参数下各件没有两顶点坐标完全相同的零面积三角形（极点行收口不出面）', () => {
  for (const def of DEFS) {
    const r = A.buildComponent(def.type, {})
    for (const m of r.ir.meshes) {
      const P = m.position, I = m.index, same = (i, k) => P[3 * i] === P[3 * k] && P[3 * i + 1] === P[3 * k + 1] && P[3 * i + 2] === P[3 * k + 2]
      let bad = 0
      for (let k = 0; k < I.length; k += 3) if (same(I[k], I[k + 1]) || same(I[k + 1], I[k + 2]) || same(I[k], I[k + 2])) bad++
      assert.equal(bad, 0, `${def.type} ${m.name}：${bad} 个零面积三角形`)
    }
  }
})

/** 水平插座（n = ±Z）贴面检查的额外变体：插座随参数出没 / 移位的件。 */
const SOCKET_VARIANTS = [
  ['sea.mast', { yard: false }], ['sea.mast', { platform: false }], ['sea.superstructure', { bridgeWings: false }],
  ...[1, 3, 4, 5, 6].map((k) => ['sea.funnel', { pipes: k }]), ['sea.funnel', { band: false, pipes: 3 }],
  ['veh.body', { style: 'pickup' }], ['veh.body', { style: 'van' }], ['veh.body', { roofRack: false }],
  ['sea.hull', { stern: 'cruiser' }], ['sea.hull', { forecastleHM: 0 }], ['es.tower', { legs: 3 }]
]
t('插座贴面：非安装、非轴心的水平插座（n = ±Z）落在网格上（插座脚印 ±size/2 内逆 n 回溯的最小间隙 ≤ 1% 包围盒对角线 + 2 cm）、沿 n 正上方无遮挡', () => {
  // 例外（按设计）：X-Y 座 Y 轴插座在轴心（悬空）；天线罩地板在罩内（上方就是罩面）
  const SKIP = new Set(['es.pedestal.xy#y', 'es.radome#floor'])
  let cnt = 0
  for (const [def, raw] of [...DEFS.map((d) => [d, {}]), ...SOCKET_VARIANTS.map(([ty, rw]) => [getComponent(ty), rw])]) {
    const p = fillParams(def, raw), ms = meshes(A.buildComponent(def.type, p)), bb = bboxOf(allPts(ms)), tol = 0.01 * Math.hypot(...bb.size) + 0.02
    for (const s of def.sockets(p)) {
      if (s.id === def.mountSocket || SKIP.has(`${def.type}#${s.id}`) || Math.abs(Math.abs(s.n[2]) - 1) > 1e-9) continue
      const tag = `${def.type}${JSON.stringify(raw)}#${s.id}`, sn = s.n[2], h = tol + 1e-3
      // 脚印采样：5 × 5 格点 + 过中心沿 x / y 的两条 41 点线（车顶架横杆这类窄支承也扫得到）
      const samp = []
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) samp.push([0.25 * i, 0.25 * j])
      for (let i = -20; i <= 20; i++) samp.push([i / 40, 0], [0, i / 40])
      let gap = Infinity
      for (const [fu, fv] of samp) {
        const hit = castRay(ms, [s.pos[0] + fu * s.size + 1.3e-4, s.pos[1] + fv * s.size + 0.7e-4, s.pos[2] + sn * h], [0, 0, -sn])[0]
        if (hit) gap = Math.min(gap, Math.abs(hit.t - h))
      }
      assert.ok(gap <= tol, `${tag}：插座离网格 ${gap.toFixed(3)} m（容差 ${tol.toFixed(3)}）`)
      const up = castRay(ms, [s.pos[0] + 1.3e-4, s.pos[1] + 0.7e-4, s.pos[2] + sn * 1e-3], [0, 0, sn])
      assert.equal(up.length, 0, `${tag}：插座正上方被 ${up[0] && up[0].name} 挡住（${up[0] && up[0].t.toFixed(3)} m）`)
      cnt++
    }
  }
  assert.ok(cnt >= 30, `核验了 ${cnt} 个插座`)
  assert.deepStrictEqual(getComponent('sea.mast').sockets(fillParams(getComponent('sea.mast'), { yard: false })).map((x) => x.id), ['root', 'platform'], '没有横桁就没有横桁插座')
})

t('accepts 推荐组合：父插座推荐的每一类子件，滚转 0° 装上去与父件同向（旋转为单位阵）；只有有意的横装 / 倒装 / 焦点件除外', () => {
  // X-Y 座 Y 轴插座朝天（碟面装上去视轴指天顶）；焦点插座接馈源 / 副面（口面朝碟）；机腹腹鳍倒装；尾吊短舱横装
  const WL = new Set(['es.pedestal.xy#y', 'air.fuselage#ventral', 'air.fuselage#aftEng'])
  let cnt = 0
  for (const pdef of DEFS) {
    for (const s of pdef.sockets(fillParams(pdef, {}))) {
      if (s.id === pdef.mountSocket || s.accepts == null || s.id === 'focus' || WL.has(`${pdef.type}#${s.id}`)) continue
      for (const cdef of DEFS) {
        if (!socketAccepts(s, cdef.type)) continue
        const dom = pdef.domain.find((d) => cdef.domain.includes(d))
        if (!dom) continue
        const doc = { kind: 'assembly', schema: 1, domain: dom, name: 't', comps: [{ id: 'p', type: pdef.type, parent: null }, { id: 'c', type: cdef.type, parent: 'p', attach: { mode: 'socket', socket: s.id } }] }
        const M = A.solvePose(doc).get('c').m, R = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]]
        R.forEach((v, k) => near(v, k % 4 === 0 ? 1 : 0, 1e-9, `${pdef.type}#${s.id} ← ${cdef.type} 旋转[${k}]`))
        cnt++
      }
    }
  }
  assert.ok(cnt >= 40, `核验了 ${cnt} 组`)
})

// ───────────────────────── ④ 对称面声明核验 ─────────────────────────

const PLANE_S = { yz: [-1, 1, 1], xz: [1, -1, 1], xy: [1, 1, -1] }
const planesOf = (def, p) => (typeof def.symmetricPlanes === 'function' ? def.symmetricPlanes(p) : (def.symmetricPlanes || []))
t('对称面声明：缺省参数与 ③ 的全部合法单变变体，按参数重算 symmetricPlanes，局部顶点集合关于每个声明面取反后不变', () => {
  let checked = 0
  const diff = (def, p) => JSON.stringify(Object.fromEntries(def.keys.filter((k) => p[k] !== fillParams(def, {})[k]).map((k) => [k, p[k]])))
  for (const { def, p } of VARIANTS) {
    const planes = planesOf(def, p)
    if (!planes.length) continue
    const P = allPts(meshes(A.buildComponent(def.type, p))), s0 = vset(P)
    for (const pl of planes) { sameSet(vset(P, PLANE_S[pl]), s0, `${def.type} ${diff(def, p)} 关于 ${pl}`); checked++ }
  }
  assert.ok(checked >= 400, `核验了 ${checked} 个面`)
  // 专项：肋数奇数 / 固定仰角 / 三腿撑的反射面与塔、副面，声明里不得再有它们不满足的面
  const P = (ty, raw) => planesOf(getComponent(ty), fillParams(getComponent(ty), raw))
  assert.deepStrictEqual(P('es.refl.prime', { ribs: 5 }), ['xz']); assert.deepStrictEqual(P('es.refl.prime', { gimbal: 'none' }), ['xz'])
  assert.deepStrictEqual(P('es.refl.cass', { ribs: 7 }), ['xz']); assert.deepStrictEqual(P('es.refl.cass', { gimbal: 'none' }), ['xz'])
  assert.deepStrictEqual(P('es.refl.cass', {}), ['xz', 'xy'])
})

// ───────────────────────── 模板生成（后面各条共用） ─────────────────────────

const BUILT = new Map()
const built = (id) => { if (!BUILT.has(id)) BUILT.set(id, A.buildAssembly(E.getEntityTemplate(id).doc)); return BUILT.get(id) }

// ───────────────────────── ⑤ 镜像数学 ─────────────────────────

t('镜像·机翼钩子（B737-800）：wing~1 顶点 = wing 的 y 取反；两翼尖最高点等高且朝上；两侧机翼有向体积 > 0', () => {
  const r = built('ent:b737-800')
  const R = meshes(r, (nm) => nm.startsWith('wing_')), L = meshes(r, (nm) => nm.startsWith('wing-1_'))
  assert.ok(R.length && R.length === L.length, '两侧机翼网格')
  sameSet(vset(allPts(R), [1, -1, 1]), vset(allPts(L)), 'wing~1 = wing 关于 xz 镜像')
  const zR = bboxOf(allPts(R)).mn[2], zL = bboxOf(allPts(L)).mn[2]
  near(zR, zL, 1e-6, '两翼尖最高点 z')
  assert.ok(zR < 0, '小翼朝上（z < 0）')
  for (const m of [...R, ...L].filter((x) => /_wing$/.test(x.name))) assert.ok(signedVolume(m) > 0, `${m.name} 有向体积 > 0（绕序朝外）`)
})

t('镜像·翼下短舱随机翼复制（风扇有手性，走短舱钩子 hook 档）：eng~1 位置 = eng 的 y 取反；两侧最低点等高（扁底仍朝下）；逐位镜像', () => {
  const r = built('ent:b737-800'), ir = r.ir, o = r.specOriginBody
  const pos = (nm) => { const M = bodyMatrix(ir, ir.nodes.findIndex((x) => x.name === nm)); return [M[12] + o[0], M[13] + o[1], M[14] + o[2]] }
  const a = pos('eng'), b = pos('eng-1')
  near(b[0], a[0], 1e-9, 'x'); near(b[1], -a[1], 1e-9, 'y 取反'); near(b[2], a[2], 1e-9, 'z')
  const R = allPts(meshes(r, (nm) => nm.startsWith('eng_'))), L = allPts(meshes(r, (nm) => nm.startsWith('eng-1_')))
  near(bboxOf(R).mx[2], bboxOf(L).mx[2], 1e-6, '两侧短舱最低点')
  sameSet(vset(R, [1, -1, 1]), vset(L), 'eng~1 = eng 关于 xz 镜像')
  const plan = A.solvePose(E.getEntityTemplate('ent:b737-800').doc)
  assert.equal(plan.get('eng~1').mode, 'hook', '短舱派生件走钩子（翻转风扇旋向）')
  assert.equal(plan.get('wing~1').mode, 'hook', '机翼派生件走钩子')
})

t('镜像·尾吊短舱（G650ER，mirrorXZ 在短舱上）：钩子档、全部节点真旋转（det = +1）；两侧挂架根部比短舱轴更靠近机身', () => {
  const r = built('ent:g650er'), ir = r.ir
  // 短舱不声明对称面（风扇叶片有手性），给镜像钩子：派生件 = 旋向翻转后的几何、节点 M' = S·M·S_l（真旋转），合起来即世界镜像
  const plan = A.solvePose(E.getEntityTemplate('ent:g650er').doc)
  assert.equal(plan.get('eng~1').mode, 'hook', `尾吊短舱派生件档位 ${plan.get('eng~1').mode}`)
  ir.nodes.forEach((nd, i) => { if (i > 0) near(det3(bodyMatrix(ir, i)), 1, 1e-9, `${nd.name} det`) })
  for (const pre of ['eng', 'eng-1']) {
    const M = bodyMatrix(ir, ir.nodes.findIndex((x) => x.name === pre)), rootY = Math.abs(M[13] + r.specOriginBody[1])
    const P = allPts(meshes(r, (nm) => nm === `${pre}_cowl`)), c = P.reduce((s, p) => s + p[1], 0) / P.length
    assert.ok(rootY < Math.abs(c), `${pre}：挂架根部 |y| ${rootY.toFixed(3)} < 短舱轴 |y| ${Math.abs(c).toFixed(3)}`)
  }
  const bl = allPts(meshes(r, (nm) => nm.startsWith('eng_'))), br = allPts(meshes(r, (nm) => nm.startsWith('eng-1_')))
  sameSet(vset(bl, [1, -1, 1]), vset(br), '派生件 = 主件关于 xz 镜像（风扇旋向相反）')
})

t('镜像·钩子参数：机翼 side、短舱 fanHand 翻转，再翻回原值；翻转旋向的短舱 = 原短舱关于 xz 面逐位镜像；短舱不声明对称面', () => {
  for (const [ty, key] of [['air.wing', 'side'], ['air.nacelle', 'fanHand']]) {
    const w = getComponent(ty), p = fillParams(w, {})
    const m1 = w.mirror(p, 'xz'), m2 = w.mirror(m1, 'xz')
    assert.notEqual(m1[key], p[key], `${ty}.${key} 翻转`)
    assert.equal(m2[key], p[key])
    assert.deepStrictEqual({ ...m2 }, { ...p }, `${ty} 两次镜像回到原参数`)
    assert.deepStrictEqual(w.mirrorPlanes, ['xz'])
  }
  const nac = getComponent('air.nacelle')
  assert.equal(nac.symmetricPlanes, undefined, '短舱风扇有手性，不声明对称面')
  for (const raw of [{}, { flatBottom: true, exhaust: 'mixed', fanBlades: 13 }]) {
    const p = fillParams(nac, raw)
    const P0 = allPts(meshes(A.buildComponent('air.nacelle', p))), P1 = allPts(meshes(A.buildComponent('air.nacelle', nac.mirror(p, 'xz'))))
    sameSet(vset(P0, [1, -1, 1]), vset(P1), `短舱 ${JSON.stringify(raw)} 翻转旋向 = xz 镜像`)
    assert.throws(() => sameSet(vset(P0, [1, -1, 1]), vset(P0), '风扇确有手性（自身不关于 xz 对称）'))
  }
})

// ───────────────────────── ⑤′ 专项几何回归 ─────────────────────────

t('方位俯仰座：两根叉臂立在叉座横梁上、横梁跨过方位轴坐在转台顶面（竖直射线逐段连续，没有悬空的板）', () => {
  const def = getComponent('es.pedestal.azel')
  for (const raw of [{}, { dishDM: 13.1 }, { dishDM: 7.3, style: 'tripod' }, { dishDM: 2 }]) {
    const p = fillParams(def, raw), ms = meshes(A.buildComponent(def.type, p)), el = def.sockets(p).find((x) => x.id === 'el')
    const yokeW = el.size, H = -el.pos[2], tag = JSON.stringify(raw)
    const arms = ms.filter((m) => m.name === 'arms'), head = ms.filter((m) => m.name === 'head')
    const headTop = bboxOf(allPts(head)).mn[2]
    const cover = (sub, x, y) => insideIntervals(castRay(sub, [x, y, -H - 10], [0, 0, 1])).map(([a, b]) => [a - H - 10, b - H - 10])
    for (const y of [yokeW / 2, -yokeW / 2]) {
      const iv = cover(arms, 0.0123, y + 0.0071)
      assert.equal(iv.length, 1, `${tag} y = ${y.toFixed(2)}：叉臂与横梁连成一段（${JSON.stringify(iv)}）`)
      near(iv[0][1], headTop, 1e-6, `${tag} 叉臂经横梁落到转台顶面高度`)
    }
    const iv0 = cover(arms, 0.0123, 0.0071)
    assert.equal(iv0.length, 1, `${tag} 横梁跨过方位轴`)
    near(iv0[0][1], headTop, 1e-6, `${tag} 横梁底 = 转台顶面`)
    near(cover(head, 0.0123, 0.0071)[0][0], headTop, 1e-6, `${tag} 转台在横梁正下方`)
    assert.ok(yokeW / 2 > bboxOf(allPts(head)).mx[1], `${tag} 叉臂间距大于转台（横梁是必需的）`)
  }
})

t('天线罩：截球罩面自罩顶画到底座环顶面（罩面最低点 z = −环高、最高点 z = −总高），接缝肋画到底；罩面质量按截球面积', () => {
  const def = getComponent('es.radome')
  for (const raw of [{}, { diameterM: 6, heightM: 5.4 }, { ringHM: 0 }, { diameterM: 4, heightM: 2.2 }]) {
    const p = fillParams(def, raw), D = p.diameterM, R = D / 2, H = p.heightM ?? 0.85 * D, rh = p.ringHM ?? 0.04 * D, tag = JSON.stringify(raw)
    const r = A.buildComponent(def.type, p), dome = bboxOf(allPts(meshes(r, (nm) => nm === 'dome'))), seams = bboxOf(allPts(meshes(r, (nm) => nm === 'seams')))
    near(dome.mx[2], -rh, 1e-5, `${tag} 罩面接到底座环顶`); near(dome.mn[2], -H, 1e-5, `${tag} 罩顶`)
    assert.ok(seams.mx[2] > -rh - 0.1 * H, `${tag} 接缝肋也画到底（${seams.mx[2]}）`)
    const cap = 2 * Math.PI * R * (H - rh)   // 截球面积 = 2πR × 截高
    const dm = A.buildAssembly({ ...singleDoc(def.type, 'ground'), comps: [{ id: 'c1', type: def.type, parent: null, params: raw }] }).massProps.components.find((q) => q.name === 'c1_dome')
    nearRel(dm.massKg, 12 * cap, 0.02, `${tag} 罩面质量 = 面密度 × 截球面积`)
  }
})

t('固定仰角（gimbal none）：点质量与网格一起绕俯仰轴转（el0 = 60° 的质心 = el0 = 0° 的质心转 60°）', () => {
  for (const [ty, nm] of [['es.refl.prime', 'feed'], ['es.refl.offset', 'feed'], ['es.refl.cass', 'feedcone']]) {
    // 组件局部系下的质心 = comBody（相对文档原点）+ specOriginBody
    const com = (el0) => { const r = A.buildAssembly({ ...singleDoc(ty, 'ground'), comps: [{ id: 'c1', type: ty, parent: null, params: { gimbal: 'none', el0Deg: el0 } }] }), c = r.massProps.components.find((q) => q.name === `c1_${nm}`).comBody; return c.map((v, k) => v + r.specOriginBody[k]) }
    const c0 = com(0), c1 = com(60), a = 60 * Math.PI / 180, want = [Math.cos(a) * c0[0] + Math.sin(a) * c0[2], c0[1], -Math.sin(a) * c0[0] + Math.cos(a) * c0[2]]
    want.forEach((v, k) => near(c1[k], v, 1e-9, `${ty} ${nm} 质心[${k}]`))
    assert.ok(Math.hypot(...sub3(c1, c0)) > 0.05, `${ty} ${nm} 确实转了`)
  }
})

t('机身贴面：顶 / 底 / 两侧四段密切圆弧面上的点离椭圆蒙皮 ≤ 1.2 cm（正圆机身四段都是整圆的一部分）', () => {
  const def = getComponent('air.fuselage')
  for (const raw of [{}, { widthM: 2.5, heightM: 3.2 }, { widthM: 3.95, heightM: 3.95 }, { noseStyle: 'bizjet', widthM: 2.79, heightM: 2.79 }, { widthM: 0.95, heightM: 1.05 }]) {
    const p = fillParams(def, raw), a0 = p.widthM / 2, b0 = (p.heightM ?? 1.05 * p.widthM) / 2, faces = def.faces(p), tag = JSON.stringify(raw)
    assert.deepStrictEqual(faces.map((f) => f.id), ['skin', 'belly', 'sideR', 'sideL'])
    for (const f of faces) {
      const w = cross3(f.axis, f.ref)
      for (const fu of [-0.9, 0, 0.9]) for (let j = -8; j <= 8; j++) {
        const u1 = (j / 8) * f.halfV, ph = -u1 / f.radius, rd = [0, 1, 2].map((k) => Math.cos(ph) * f.ref[k] + Math.sin(ph) * w[k])
        const P = [0, 1, 2].map((k) => f.origin[k] + f.axis[k] * fu * f.halfU + rd[k] * f.radius)
        const rr = Math.hypot(P[1], P[2]), rE = 1 / Math.hypot(P[1] / rr / a0, P[2] / rr / b0)
        assert.ok(Math.abs(rr - rE) <= 0.012, `${tag} ${f.id} u1 = ${u1.toFixed(3)}：离蒙皮 ${(rr - rE).toFixed(4)} m`)
      }
    }
    if (Math.abs(a0 - b0) < 1e-12) for (const f of faces) near(f.halfV, f.radius * Math.PI / 2, 1e-9, `${tag} 正圆机身 ${f.id} 盖满 ±90°`)
  }
})

/** 船体参数样例：缺省、三个模板、圆艉、瘦船 / 肥船、无艏楼。 */
const HULL_CASES = () => [['缺省', {}], ...E.listEntityTemplates('ship').map((r) => [r.id, r.doc.comps.find((c) => c.id === 'hull').params]), ['圆艉', { stern: 'cruiser' }], ['cb 0.5', { cb: 0.5 }], ['cb 0.85', { cb: 0.85 }], ['无艏楼', { forecastleHM: 0 }]]
t('船体甲板贴面：每块面的四角与边中点正上方往下第一交点都是甲板、高度 = 面高（±2 cm）——不出舷、不进艏楼；主甲板面原点在船中', () => {
  const def = getComponent('sea.hull')
  for (const [nm, raw] of HULL_CASES()) {
    const p = fillParams(def, raw), ms = meshes(A.buildComponent(def.type, p)), faces = def.faces(p)
    const deck = faces.find((f) => f.id === 'deck')
    assert.ok(deck && deck.origin[0] === 0 && deck.origin[1] === 0, `${nm} deck 面原点在船中`)
    for (const f of faces) for (const i of [-1, 0, 1]) for (const j of [-1, 0, 1]) {
      const P = [0, 1, 2].map((k) => f.origin[k] + f.u[k] * i * f.halfU + f.v[k] * j * f.halfV + [1.3e-3, 0.7e-3, 0][k])
      const hit = castRay(ms, [P[0], P[1], P[2] - 30], [0, 0, 1])[0]
      assert.ok(hit && hit.name === 'deck', `${nm} ${f.id} (${i}, ${j})：正下方第一交点是 ${hit && hit.name}`)
      near(hit.t - 30, 0, 0.02, `${nm} ${f.id} (${i}, ${j}) 面高 = 甲板高`)
    }
  }
})

t('船体型线：水线丰满度 q ≥ 1.2（平行中体两端切向连续）；前后肩部甲板边线每 0.1% 船长的转角 ≤ 3°', () => {
  const def = getComponent('sea.hull')
  for (const [nm, raw] of HULL_CASES()) {
    const p = fillParams(def, raw), h = hullShapeInfo(p), L = p.loaM, xf = (h.pm * L) / 2
    assert.ok(h.fullness >= 1.2 - 1e-12, `${nm} q = ${h.fullness}`)
    const turn = (a, b) => {
      let mx = 0
      const ns = Math.max(2, Math.round((b - a) / (0.001 * L))), P = []
      for (let i = 0; i <= ns; i++) { const x = a + ((b - a) * i) / ns; P.push([x, h.deckHalfWidth(x)]) }
      for (let i = 1; i < ns; i++) mx = Math.max(mx, Math.abs(Math.atan2(P[i + 1][1] - P[i][1], P[i + 1][0] - P[i][0]) - Math.atan2(P[i][1] - P[i - 1][1], P[i][0] - P[i - 1][0])))
      return (mx * 180) / Math.PI
    }
    const fwdEnd = Math.min(xf + 0.08 * L, (h.fcH > 0 ? h.xFc0 : h.xStemWL) - 0.01 * L)
    if (fwdEnd > xf - 0.03 * L) assert.ok(turn(xf - 0.03 * L, fwdEnd) <= 3, `${nm} 前肩转角 ${turn(xf - 0.03 * L, fwdEnd).toFixed(2)}°`)
    assert.ok(turn(-xf - 0.08 * L, -xf + 0.03 * L) <= 3, `${nm} 后肩转角`)
  }
})

t('船体水线 / 舭部侧影：平行中体两端 ±3% 船长内，网格逐站的水线半宽与 30° / 45° / 60° 方向侧影转角 ≤ 3°（肩部磨圆，不再有 4–8° 的单站折角）', () => {
  const def = getComponent('sea.hull'), D2 = Math.PI / 180
  let cnt = 0
  for (const [nm, raw] of HULL_CASES()) {
    const p = fillParams(def, raw), h = hullShapeInfo(p), L = p.loaM, xf = (h.pm * L) / 2
    const [m] = meshes(A.buildComponent(def.type, p), (name) => name === 'bottom')
    // 站 = 水下网格里带水线点（z = 0）的截面行（球鼻放样的截面不在水线上）；取右舷半边
    const st = new Map()
    for (const [x, y, z] of m.P) if (y >= 0) { if (!st.has(x)) st.set(x, []); st.get(x).push([y, z]) }
    const xs = [...st.keys()].filter((x) => st.get(x).some(([, z]) => Math.abs(z) < 1e-6)).sort((a, b) => a - b)
    const series = [['水线', (pts) => Math.max(...pts.filter(([, z]) => Math.abs(z) < 1e-6).map(([y]) => y))],
      ...[30, 45, 60].map((a) => [`${a}° 侧影`, (pts) => Math.max(...pts.map(([y, z]) => y * Math.cos(a * D2) + z * Math.sin(a * D2)))])]
    for (const [k, f] of series) {
      const v = xs.map((x) => f(st.get(x)))
      for (let i = 1; i < xs.length - 1; i++) {
        if (Math.min(Math.abs(xs[i] - xf), Math.abs(xs[i] + xf)) > 0.03 * L) continue
        const tr = Math.abs(Math.atan2(v[i + 1] - v[i], xs[i + 1] - xs[i]) - Math.atan2(v[i] - v[i - 1], xs[i] - xs[i - 1])) / D2
        assert.ok(tr <= 3, `${nm} ${k}：x = ${(xs[i] / L).toFixed(3)} L 处转 ${tr.toFixed(2)}°`)
        cnt++
      }
    }
  }
  assert.ok(cnt >= 200, `核验了 ${cnt} 个站位转角`)
})

t('船模板：集装箱件（箱块 / 舱口盖 / 绑扎桥 / 贴花）全部顶点在主甲板边线以内 ≥ 5 cm（舱口盖不出舷）', () => {
  let cnt = 0
  for (const rec of E.listEntityTemplates('ship')) {
    const h = hullShapeInfo(fillParams(getComponent('sea.hull'), rec.doc.comps.find((c) => c.id === 'hull').params))
    let worst = Infinity, at = ''
    for (const m of meshes(built(rec.id), (name) => /^cnt\d+_/.test(name))) {
      for (const [x, y] of m.P) { const gap = h.deckHalfWidth(x) - Math.abs(y); if (gap < worst) { worst = gap; at = m.name } }
      cnt++
    }
    assert.ok(worst >= 0.05, `${rec.id} ${at} 离甲板边线 ${worst.toFixed(3)} m`)
  }
  assert.ok(cnt >= 20, `核验了 ${cnt} 个节点`)
})

t('集装箱：露出的舷侧是同色几何瓦楞（外列侧面有内凹 0.036 m 的波谷、谷宽 0.068 / 节距 0.278 m）；深色贴花只剩层缝横线（瓦楞 / 锁杆 / 角柱不再是深色竖线）', () => {
  const p = fillParams(getComponent('sea.containers'), {}), ms = meshes(A.buildComponent('sea.containers', p))
  const Wb = p.rows * 2.438 + (p.rows - 1) * p.rowGapM
  const tr = ms.filter((m) => /^boxes_/.test(m.name)).flatMap((m) => m.P).filter(([, y]) => Math.abs(Math.abs(y) - (Wb / 2 - 0.036)) < 1e-4)
  assert.ok(tr.length >= 1000, `波谷点 ${tr.length}`)
  const xs = [...new Set(tr.map(([x]) => Math.round(x * 1e4)))].sort((a, b) => a - b)
  let steps = 0
  for (let i = 1; i < xs.length; i++) {
    const d = (xs[i] - xs[i - 1]) / 1e4
    if (d > 1) continue   // 相邻贝之间
    assert.ok(Math.abs(d - 0.068) < 2e-4 || Math.abs(d - 0.21) < 2e-4, `波谷列间距 ${d.toFixed(4)} m`)
    steps++
  }
  assert.ok(steps >= 300, `波谷列间距 ${steps} 个`)
  const mk = ms.find((m) => m.name === 'marks')
  for (let k = 0; k < mk.index.length; k += 3) {
    const zs = [0, 1, 2].map((j) => mk.P[mk.index[k + j]][2])
    assert.ok(Math.max(...zs) - Math.min(...zs) <= 0.06 + 1e-6, `深色贴花里有竖向条（高 ${(Math.max(...zs) - Math.min(...zs)).toFixed(3)} m）`)
  }
})

t('短舱风扇：正面看叶片连成一片（0.45 / 0.7 / 0.92 风扇半径处沿 −X 的射线 ≥ 97% 先打到叶片，不是风扇盘）；整流锥尖在唇口之后', () => {
  const def = getComponent('air.nacelle')
  for (const raw of [{}, { fanBlades: 24 }, { fanBlades: 12, fanHand: 'left' }, { diameterM: 2.4, lengthM: 3.0 }, { fanFrac: 0.6 }]) {
    const p = fillParams(def, raw), r = A.buildComponent(def.type, p), ms = meshes(r), tag = JSON.stringify(raw)
    const rF = (p.fanFrac * p.diameterM) / 2, zA = (p.pylonHM ?? 0.35 * p.diameterM) + p.diameterM / 2, x0 = r.bbox.max[0] + 1
    let hitB = 0, tot = 0
    for (const f of [0.45, 0.7, 0.92]) for (let k = 0; k < 120; k++) {
      const a = (2 * Math.PI * (k + 0.37)) / 120, first = castRay(ms, [x0, f * rF * Math.cos(a), zA + f * rF * Math.sin(a)], [-1, 0, 0])[0]
      tot++
      if (first && first.name === 'blades') hitB++
    }
    assert.ok(hitB / tot >= 0.97, `${tag} 正面叶片覆盖 ${(hitB / tot * 100).toFixed(1)}%`)
    const lipX = bboxOf(allPts(meshes(r, (nm) => nm === 'lip'))).mx[0], spinX = bboxOf(allPts(meshes(r, (nm) => nm === 'spinner'))).mx[0]
    assert.ok(spinX < lipX, `${tag} 整流锥尖 ${spinX.toFixed(3)} 在唇口 ${lipX.toFixed(3)} 之后`)
    assert.ok(trisOf(r.ir) <= 50000, `${tag} 三角形 ${trisOf(r.ir)}`)
  }
})

// ───────────────────────── ⑥ 领域本体轴（E5） ─────────────────────────

const IDS = E.ENTITY_TEMPLATE_IDS
/** 模板全部顶点（本体系，未加 specOrigin）→ 模型轴。 */
function modelPts(r) {
  const R = r.ir.nodes[0].matrix, o = r.specOriginBody
  return allPts(meshes(r)).map((p) => { const b = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]; return { b, m: applyDir(R, b) } })
}
const argBy = (arr, f, sgn) => arr.reduce((best, x) => (best === null || sgn * f(x) > sgn * f(best) ? x : best), null)
t('领域本体轴（E5）：frame = Q_YUP_ZENITH、根节点 / 矩阵按 DOMAIN_FRAMES；本体 +X → 模型 +Z、−Z（天顶）→ 模型 +Y、+Y → 模型 −X', () => {
  for (const id of IDS) {
    const rec = E.getEntityTemplate(id), r = built(id), fr = A.DOMAIN_FRAMES[rec.domain]
    assert.deepStrictEqual(r.frame.q_model2body, [...Q_YUP_ZENITH], `${id} q_model2body`)
    assert.equal(r.ir.nodes[0].name, fr.root, `${id} 根节点名`)
    assert.deepStrictEqual(r.ir.nodes[0].matrix, [...fr.matrix], `${id} 根矩阵`)
    const R = r.ir.nodes[0].matrix
    assert.deepStrictEqual(applyDir(R, [1, 0, 0]).map((v) => v + 0), [0, 0, 1], `${id} +X → 模型 +Z`)
    assert.deepStrictEqual(applyDir(R, [0, 0, -1]).map((v) => v + 0), [0, 1, 0], `${id} 天顶 → 模型 +Y`)
    assert.deepStrictEqual(applyDir(R, [0, 1, 0]).map((v) => v + 0), [-1, 0, 0], `${id} +Y → 模型 −X`)
    const pts = modelPts(r), mb = bboxOf(pts.map((x) => x.m))
    const front = argBy(pts, (x) => x.b[0], 1), top = argBy(pts, (x) => x.b[2], -1), right = argBy(pts, (x) => x.b[1], 1), bottom = argBy(pts, (x) => x.b[2], 1)
    near(front.m[2], mb.mx[2], 1e-6, `${id} 最前点（机头 / 船艏 / 车头 / 北）在模型 z 最大`)
    near(top.m[1], mb.mx[1], 1e-6, `${id} 最高点在模型 y 最大`)
    near(right.m[0], mb.mn[0], 1e-6, `${id} 最右点在模型 x 最小`)
    near(bottom.m[1], mb.mn[1], 1e-6, `${id} 最低点在模型 y 最小`)
  }
})

t('领域本体轴·各领域锚点：船 / 车 / 飞机 datum 在文档原点；车轮着地 z = 0；地面站静止视轴（方位俯仰 +X、X-Y 天顶）', () => {
  const ap = (r, nm) => { const a = r.attachPoints.find((x) => x.name === nm); assert.ok(a, `缺挂点 ${nm}`); return a }
  for (const id of IDS) {
    const rec = E.getEntityTemplate(id), r = built(id), o = r.specOriginBody, R = r.ir.nodes[0].matrix
    if (rec.domain === 'ground') {
      const b = ap(r, 'refl_boresight')
      const want = rec.doc.comps.some((c) => c.params && c.params.gimbal === 'xy') ? [0, 0, -1] : [1, 0, 0]
      b.dirBody.forEach((v, k) => near(v, want[k], 1e-9, `${id} 静止视轴`))
      applyDir(R, b.dirBody).forEach((v, k) => near(v, want[0] === 1 ? [0, 0, 1][k] : [0, 1, 0][k], 1e-9, `${id} 视轴（模型轴）`))
      const root = rec.doc.comps.find((c) => c.parent === null).id
      near(bboxOf(allPts(meshes(r, (nm) => nm.startsWith(`${root}_`)))).mx[2], 0, 1e-6, `${id} 座架 / 立柱底面在地面（z = 0）`)
      continue
    }
    const root = rec.doc.comps.find((c) => c.parent === null).id
    const d = ap(r, `${root}_datum`)
    d.posBody.forEach((v, k) => near(v + o[k], 0, 1e-9, `${id} ${root}_datum 在文档原点`))
    if (rec.domain === 'vehicle') near(bboxOf(allPts(meshes(r, (nm) => nm === 'body_tires'))).mx[2], 0, 1e-6, `${id} 轮胎着地 z = 0`)
    if (rec.domain === 'ship') near(bboxOf(allPts(meshes(r))).mx[2], rec.doc.comps[0].params.draftM, 1e-6, `${id} 龙骨 z = 吃水`)
  }
})

// ───────────────────────── ⑦ 模板 ─────────────────────────

t('模板目录：id 唯一合规、共 23 个、不与参数化模板 / 旧 id / 其它前缀撞；深冻结；取不到返回 null；文档副本互不共享', () => {
  assert.equal(IDS.length, 23)
  assert.equal(new Set(IDS).size, IDS.length, 'id 唯一')
  const counts = Object.fromEntries(E.ENTITY_DOMAINS.map((d) => [d, E.listEntityTemplates(d).length]))
  assert.deepStrictEqual(counts, { ground: 11, aircraft: 6, ship: 3, vehicle: 3 })
  assert.equal(E.listEntityTemplates().length, 23)
  assert.deepStrictEqual(E.ENTITY_TEMPLATES.map((r) => r.domain), [...Array(11).fill('ground'), ...Array(6).fill('aircraft'), ...Array(3).fill('ship'), ...Array(3).fill('vehicle')], '界面顺序：地球站 → 飞机 → 船 → 车')
  for (const id of IDS) {
    assert.ok(E.ENTITY_ID_RE.test(id), id)
    assert.ok(isValidModelId(id) && parseModelId(id).prefix === 'ent', `${id} 与 schema 的 ent 前缀同式`)
    const slug = id.slice(4)
    assert.ok(!TEMPLATE_IDS.includes(slug) && !['dfh4', 'dfh4e', 'dfh5'].includes(slug), `${id} 撞参数化模板`)
    assert.ok(!/^(param|asm|nasa|user|stk|community):/.test(id), id)
    assert.ok(E.isEntityTemplateId(id))
  }
  assert.equal(E.getEntityTemplate('ent:nope'), null)
  assert.equal(E.getEntityTemplate(undefined), null)
  assert.equal(E.entityTemplateDoc('ent:nope'), null)
  assert.ok(!E.isEntityTemplateId('param:default-sat'))
  const frozen = (o, path) => { if (o && typeof o === 'object') { assert.ok(Object.isFrozen(o), `${path} 未冻结`); for (const k of Object.keys(o)) frozen(o[k], `${path}.${k}`) } }
  frozen(E.ENTITY_TEMPLATES, 'ENTITY_TEMPLATES')
  assert.ok(Object.isFrozen(E.ENTITY_TEMPLATE_IDS))
  const id = 'ent:es-7p3', rec = E.getEntityTemplate(id)
  const d1 = E.entityTemplateDoc(id), d2 = E.entityTemplateDoc(id)
  assert.notStrictEqual(d1.doc, d2.doc); assert.notStrictEqual(d1.doc.comps, d2.doc.comps); assert.notStrictEqual(d1.dims, rec.dims)
  d1.doc.comps[0].params.dishDM = 99; d1.dims.apertureM.value = 1; d1.prov['ped.dishDM'].dim = 'x'
  assert.equal(rec.doc.comps[0].params.dishDM, 7.3, '改副本不动记录')
  assert.equal(rec.dims.apertureM.value, 7.3)
  assert.equal(E.entityTemplateDoc(id).doc.comps[0].params.dishDM, 7.3, '再取仍是原值')
  assert.deepStrictEqual(d2.doc, A.normalizeAssembly(rec.doc), '文档 = normalizeAssembly(记录.doc)')
  // illustrative = 模板显式填写、不在 prov 里的参数路径
  for (const x of IDS) {
    const r0 = E.getEntityTemplate(x), dd = E.entityTemplateDoc(x)
    for (const p of dd.illustrative) assert.ok(!Object.hasOwn(r0.prov, p), `${x} ${p} 既在 prov 又算示意`)
    for (const c of r0.doc.comps) for (const k of Object.keys(c.params || {})) { const p = `${c.id}.${k}`; assert.ok(Object.hasOwn(r0.prov, p) || dd.illustrative.includes(p), `${x} ${p} 漏归类`) }
  }
  const cat = E.entityTemplateCatalog()
  assert.equal(cat.length, 23)
  for (const c of cat) {
    const r0 = E.getEntityTemplate(c.id)
    assert.equal(c.templateId, c.id); assert.equal(c.kind, r0.modelKind); assert.equal(c.group, r0.modelKind); assert.equal(c.fidelity, 'parametric')
    assert.equal(c.source.kind, 'builtin'); assert.ok(/^https?:\/\//.test(c.source.url)); assert.ok(c.source.credit.includes(r0.representative))
    assert.deepStrictEqual(c.tags, ['entity', r0.domain]); assert.deepStrictEqual(c.aliases, [r0.title, r0.titleZh])
  }
})

const REF_KEYS = Object.keys(buildParamModel(templateSpec(DEFAULT_TEMPLATE_ID).spec)).sort()
t('模板生成：校验通过、返回键集合 = buildParamModel、IR 合法有限、无告警、三角形 ≤ 15 万、类别 / 领域一致', () => {
  for (const id of IDS) {
    const rec = E.getEntityTemplate(id)
    const v = A.validateAssembly(rec.doc)
    assert.ok(v.ok, `${id} 校验：${[...v.errors, ...v.missing].join('；')}`)
    const r = built(id)
    assert.deepStrictEqual(Object.keys(r).sort(), REF_KEYS, `${id} 键集合`)
    const iv = validateIR(r.ir)
    assert.ok(iv.ok, `${id} validateIR：${iv.errors.join('；')}`)
    assert.deepStrictEqual(nonFiniteReport(r), [], `${id} 非有限数`)
    assert.deepStrictEqual(r.warnings, [], `${id} 告警`)
    const tris = trisOf(r.ir)
    assert.ok(tris <= 150000, `${id} 三角形 ${tris}`)
    assert.equal(rec.fidelity, 'parametric')
    assert.ok(['ground', 'aircraft', 'ship', 'vehicle'].includes(rec.modelKind))
    assert.equal(rec.modelKind, rec.domain)
    assert.equal(rec.domain, rec.doc.domain)
    assert.ok(rec.urls.length && rec.urls.every((u) => /^https?:\/\//.test(u)) && rec.hover.includes(rec.urls[0]), `${id} 出处进悬停`)
  }
})

// —— prov 独立重算（A3 规格 §7.3 / 各数据文件文件头的式子）
const vOf = (d, pick) => (d.value !== null && typeof d.value === 'object' ? d.value[pick] : d.value)
const compOf = (rec, id) => rec.doc.comps.find((c) => c.id === id)
const sockZ = (type, params, sid) => getComponent(type).sockets(fillParams(getComponent(type), params)).find((s) => s.id === sid).pos[2]
function recompute(rec, path, p) {
  const dims = rec.dims
  if (typeof p.dim === 'string') return vOf(dims[p.dim], p.pick) * (p.k === undefined ? 1 : p.k)
  const d0 = dims[p.dims[0]], w = p.with
  const fus = () => fillParams(getComponent('air.fuselage'), compOf(rec, 'fus').params)
  switch (p.fn) {
    case 'mul': return Object.values(w).reduce((s, x) => s * x, d0.value)
    case 'sub': return Math.round((d0.value - dims[p.dims[1]].value) * 1e9) / 1e9
    case 'linear': return w.a + w.b * vOf(d0, w.pick)
    case 'pieces': return /two-piece/.test(d0.value) ? 2 : /four-piece/.test(d0.value) ? 4 : 0
    case 'mountStyle': return /tripod/.test(d0.value) ? 'tripod' : 'kingpost'
    case 'vtailHeight': { const f = fus(); return vOf(d0, w.pick) - w.gearClearM - f.heightM / 2 + sockZ('air.fuselage', f, 'vtail') }
    case 'vtailSpan': { const f = fus(); return 2 * (d0.value - w.gearClearM - f.heightM / 2 + sockZ('air.fuselage', f, 'htail')) / Math.tan(compOf(rec, 'ht').params.dihedralDeg * Math.PI / 180) }
    case 'lengthMinusProp': return d0.value + A.buildComponent('air.prop', compOf(rec, 'prop').params).bbox.min[0]
    case 'rowsFromBeam': return Math.floor((d0.value - w.marginM) / (w.boxWM + w.rowGapM))
    case 'bridgeTiers': return Math.ceil((w.hatchHM + d0.value * w.boxHM + w.clearM) / w.tierHM)
    case 'funnelHeight': return w.hatchHM + d0.value * w.boxHM + w.extraM
    default: throw new Error(`${rec.id} ${path}：未知式子 ${p.fn}`)
  }
}
t('prov 对拍：每条按 dim / pick / k 或派生式子独立重算 = 文档里的组件参数（±1e-9）；出处全是 URL；逐字抽查', () => {
  let cnt = 0
  for (const id of IDS) {
    const rec = E.getEntityTemplate(id)
    for (const [k, d] of Object.entries(rec.dims)) {
      assert.ok(/^https?:\/\/\S+$/.test(d.source), `${id} dims.${k} 出处`)
      assert.ok(['primary', 'secondary', 'tertiary'].includes(d.confidence), `${id} dims.${k} 置信度`)
    }
    for (const [path, p] of Object.entries(rec.prov)) {
      const m = /^([a-z][a-z0-9]*)([.#])(\w+)$/.exec(path)
      assert.ok(m, `${id} prov 路径 ${path}`)
      const c = compOf(rec, m[1])
      const got = m[2] === '#' ? c.massKg : c.params[m[3]]
      const want = recompute(rec, path, p)
      if (typeof want === 'number') near(got, want, 1e-9, `${id} ${path}`)
      else assert.equal(got, want, `${id} ${path}`)
      cnt++
    }
  }
  assert.ok(cnt >= 100, `对拍 ${cnt} 条`)
  const D = (id, k) => E.getEntityTemplate(id).dims[k].value
  assert.equal(D('ent:a320neo', 'wingspanM'), 35.8)
  assert.equal(D('ent:b777-300er', 'lengthM'), 73.86)
  assert.equal(D('ent:es-13p1', 'elAxisHeightM'), 7.087); assert.equal(D('ent:es-13p1', 'overallHeightAt90ElM'), 15.064)
  assert.deepStrictEqual({ ...SHIP_RADOMES.v130nx }, { ...SHIP_RADOMES.v130nx, H: 1.681, D: 1.724, massKg: 150 })
  assert.deepStrictEqual({ ...FLAT_PANELS['kymeta-u8'] }, { ...FLAT_PANELS['kymeta-u8'], L: 0.895, W: 0.895, H: 0.14 })
  assert.deepStrictEqual(D('ent:suv-cotm', 'LWHcm'), { L: 89.5, W: 89.5, H: 14 })
  assert.deepStrictEqual([D('ent:suv-cotm', 'lengthMm'), D('ent:suv-cotm', 'widthMm'), D('ent:suv-cotm', 'heightMm')], [4980, 1980, 1950])
  assert.equal(D('ent:dsn-34m', 'subreflectorDiameterM'), 3.42)
  assert.equal(D('ent:vsat-2p4', 'massKg'), 110.65)
  assert.deepStrictEqual({ ...DRIVEAWAYS['inetvu-1202'] }, { ...DRIVEAWAYS['inetvu-1202'], L: 2.03, W: 1.24, H: 0.35 })
  assert.deepStrictEqual({ ...AERO_RADOMES.gat5530 }, { ...AERO_RADOMES.gat5530, L: 2.35, W: 1.07, H: 0.32 })
  assert.equal(D('ent:ulcs-24k', 'loaM'), 399.95); assert.equal(D('ent:container-14k', 'deckRows'), 20)
})

t('几何闭合出处尺寸：飞机全长 / 翼展 / 全机高；地面站俯仰轴高 + 最前点距离 = 90° 总高；船长宽吃水；车长宽高；罩与终端外形', () => {
  for (const id of IDS) {
    const rec = E.getEntityTemplate(id), r = built(id), P = allPts(meshes(r)), bb = bboxOf(P)
    if (rec.domain === 'aircraft') {
      nearRel(bb.size[0], vOf(rec.dims.lengthM), 0.005, `${id} 全机长`)
      nearRel(bb.size[1], vOf(rec.dims.wingspanM), 0.005, `${id} 翼展`)
      const hp = [rec.prov['vt.heightM'], rec.prov['ht.spanM']].find((x) => x && (x.fn === 'vtailHeight' || x.fn === 'vtailSpan')), f = fillParams(getComponent('air.fuselage'), compOf(rec, 'fus').params)
      const zg = f.heightM / 2 + hp.with.gearClearM
      nearRel(zg - bb.mn[2], vOf(rec.dims.heightM, hp.with.pick), 0.01, `${id} 全机高`)
      assert.ok(bb.mx[2] < zg, `${id} 全部顶点在地面以上（最低 ${bb.mx[2].toFixed(3)} < ${zg.toFixed(3)}）`)
    } else if (rec.domain === 'ground') {
      const ped = compOf(rec, 'ped'), refl = compOf(rec, 'refl')
      if (rec.prov['ped.elAxisHM']) {
        near(sockZ(ped.type, ped.params, 'el'), -ped.params.elAxisHM, 1e-9, `${id} el 插座 z = −俯仰轴高`)
        const reach = A.buildComponent(refl.type, refl.params).bbox.max[0]
        near(reach, refl.params.reachM, 1e-9, `${id} 反射面最前点 = reachM`)
        near(ped.params.elAxisHM + reach, rec.dims.overallHeightAt90ElM.value, 1e-9, `${id} 俯仰轴高 + 最前点 = 90° 总高`)
      }
    } else if (rec.domain === 'ship') {
      const hp = compOf(rec, 'hull').params
      nearRel(bb.size[0], rec.dims.loaM.value, 0.005, `${id} 总长`)
      nearRel(bb.size[1], rec.dims.beamM.value, 0.005, `${id} 型宽（翼桥 / 箱块不超宽）`)
      near(bb.mx[2], hp.draftM, 1e-6, `${id} 最大 z = 吃水（舵桨不低于龙骨）`)
      near(sockZ('sea.hull', hp, 'deck'), -(hp.depthM - hp.draftM), 1e-9, `${id} deck 插座 z = −(型深 − 吃水)`)
    } else {
      const bp = compOf(rec, 'body').params, bodyBB = bboxOf(allPts(meshes(r, (nm) => nm.startsWith('body_') && nm !== 'body_mirrors')))
      nearRel(bodyBB.size[0], bp.lengthM, 0.01, `${id} 车长`); nearRel(bodyBB.size[1], bp.widthM, 0.01, `${id} 车宽`)
      nearRel(-bodyBB.mn[2], bp.heightM, 0.01, `${id} 车高`)
      nearRel(bp.lengthM, vOf(rec.dims.lengthMm, rec.prov['body.lengthM'].pick) * 0.001, 1e-12, `${id} 车长出处`)
      // 车高口径：heightM = 地面到车顶架顶；出处车高 = 出厂车顶外高 → 车壳（不含车顶架）最高点恰在出处车高
      const hp = rec.prov['body.heightM'], shellTop = -bboxOf(allPts(meshes(r, (nm) => nm === 'body_body'))).mn[2]
      near(shellTop, vOf(rec.dims.heightMm, hp.with.pick) * 0.001, 1e-6, `${id} 车壳顶 = 出处车高`)
      assert.equal(hp.with.a, fillParams(getComponent('veh.body'), bp).rackHM, `${id} 车高派生里的车顶架高 = 文档参数`)
    }
  }
  const sz = (type, params) => { const b = A.buildComponent(type, params).bbox; return b.max.map((v, k) => v - b.min[k]) }
  for (const [model, pre] of Object.entries(SHIP_RADOMES)) {
    const s = sz('sea.vsat.radome', { model })
    near(s[2], pre.H, 1e-6, `${model} 罩高`); near(s[0], pre.D, 1e-6, `${model} 罩径 x`); near(s[1], pre.D, 1e-6, `${model} 罩径 y`)
  }
  const u8 = sz('veh.cotm.flat', { model: 'kymeta-u8' }), fp = FLAT_PANELS['kymeta-u8']
  near(u8[0], fp.L, 1e-6, 'u8 长'); near(u8[1], fp.W, 1e-6, 'u8 宽'); near(u8[2], fp.H, 1e-6, 'u8 高')
  const g = sz('air.radome', { model: 'gat5530' }), gp = AERO_RADOMES.gat5530
  near(g[0], gp.L, 1e-6, 'GAT-5530 长'); near(g[1], gp.W, 1e-6, 'GAT-5530 宽'); near(g[2], gp.H, 1e-6, 'GAT-5530 高')
})

t('质量：有出处的组件级质量精确（2.4 m 天线 110.65、7.3 m 反射面 998、船载罩 150 / 113）；其余正、有限，质心在包围盒内，主惯量满足三角不等式', () => {
  const sum = (r, pre) => r.massProps.components.filter((q) => q.name.startsWith(pre)).reduce((s, q) => s + q.massKg, 0)
  near(sum(built('ent:vsat-2p4'), 'refl_'), 110.65, 1e-9, '2.4 m 天线（不含立柱）')
  near(sum(built('ent:es-7p3'), 'refl_'), 998, 1e-9, '7.3 m 反射面')
  for (const id of E.listEntityTemplates('ship').map((x) => x.id)) {
    const model = compOf(E.getEntityTemplate(id), 'vsat').params.model
    near(sum(built(id), 'vsat_'), SHIP_RADOMES[model].massKg, 1e-9, `${id} 船载罩 ${model}`)
  }
  for (const id of IDS) {
    const r = built(id), mp = r.massProps
    assert.ok(isNum(mp.massKg) && mp.massKg > 0, `${id} 质量`)
    for (let k = 0; k < 3; k++) assert.ok(mp.comBody[k] >= r.bboxBody.min[k] - 1e-9 && mp.comBody[k] <= r.bboxBody.max[k] + 1e-9, `${id} 质心在包围盒内`)
    const [a, b, c] = eig3(mp.inertiaBody)
    assert.ok(a > 0, `${id} 主惯量全正（${a}）`)
    assert.ok(a + b >= c * (1 - 1e-9), `${id} 主惯量三角不等式`)
  }
})

// 确定性：摘要 = 全部模板 IR 网格四组数组的 FNV-1a（与子进程同式）
const DIGEST_SRC = `
const fnv = (h, a) => { const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) } return h }
globalThis.__digest = (A, E) => { const out = {}; for (const id of E.ENTITY_TEMPLATE_IDS) { const r = A.buildAssembly(E.getEntityTemplate(id).doc); let h = 0x811c9dc5; for (const m of r.ir.meshes) for (const k of ['position', 'normal', 'uv', 'index']) h = fnv(h, m[k]); out[id] = (h >>> 0).toString(16) + ':' + r.specHash } return out }
`
t('确定性：同进程两次生成逐字节相同、nodes / 挂点 / 质量深等、specHash 相同；子进程摘要与本进程相同', () => {
  for (const id of IDS) {
    const r1 = built(id), r2 = A.buildAssembly(E.getEntityTemplate(id).doc)
    assert.equal(r1.ir.meshes.length, r2.ir.meshes.length, id)
    r1.ir.meshes.forEach((m, i) => { for (const k of ['position', 'normal', 'uv', 'index']) assert.ok(Buffer.from(m[k].buffer, m[k].byteOffset, m[k].byteLength).equals(Buffer.from(r2.ir.meshes[i][k].buffer, r2.ir.meshes[i][k].byteOffset, r2.ir.meshes[i][k].byteLength)), `${id} ${m.name}.${k}`) })
    assert.deepStrictEqual(r1.ir.nodes, r2.ir.nodes, `${id} nodes`)
    assert.deepStrictEqual(r1.attachPoints, r2.attachPoints, `${id} 挂点`)
    assert.deepStrictEqual(r1.massProps, r2.massProps, `${id} 质量`)
    assert.equal(r1.specHash, r2.specHash, `${id} specHash`)
  }
  new Function(DIGEST_SRC)()   // eslint-disable-line no-new-func
  const mine = globalThis.__digest(A, E)
  const url = (p) => pathToFileURL(MODELS + p).href
  const code = `${DIGEST_SRC}\nconst A = await import(${JSON.stringify(url('assembly.mjs'))}); const E = await import(${JSON.stringify(url('entityTemplates.mjs'))});\nprocess.stdout.write(JSON.stringify(globalThis.__digest(A, E)))`
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', maxBuffer: 1 << 24 })
  assert.deepStrictEqual(JSON.parse(out), mine, '子进程摘要')
})

t('关节驱动：地球站座架 + 反射面、船载罩、车顶展开座 + 反射面，gimbalValues 一次给出两条关节', () => {
  const want = {
    'ent:vsat-1p2': ['refl_gimbal', 'refl_azimuth'], 'ent:es-3p7': ['ped_azimuth', 'refl_gimbal'], 'ent:es-7p3': ['ped_azimuth', 'refl_gimbal'],
    'ent:es-13p1': ['ped_azimuth', 'refl_gimbal'], 'ent:dsn-34m': ['ped_azimuth', 'refl_gimbal'], 'ent:es-xy-2p4': ['ped_xaxis', 'refl_gimbal'],
    'ent:ulcs-24k': ['vsat_gimbal', 'vsat_azimuth'], 'ent:container-9k': ['vsat_gimbal', 'vsat_azimuth'], 'ent:van-driveaway': ['dw_azimuth', 'refl_gimbal'],
    'ent:a320neo': ['rdm_gimbal', 'rdm_azimuth']
  }
  for (const [id, names] of Object.entries(want)) {
    const gv = gimbalValues(built(id).articulations, 30, 20)
    for (const nm of names) assert.ok(gv[nm], `${id} 缺关节 ${nm}（有 ${Object.keys(gv).join(' ')}）`)
    for (const nm of names) { const v = gv[nm]; assert.ok((v.azimuth === 30 && v.elevation === 20) || (v.xAxis === 30 && v.yAxis === 20), `${id} ${nm} 取值`) }
  }
  for (const id of IDS) for (const a of built(id).articulations) for (const s of a.stages) assert.ok(s.minimumValue <= s.initialValue && s.initialValue <= s.maximumValue, `${id} ${a.name}.${s.name} 初值在限位内`)
})

// ───────────────────────── ⑦′ 模板出处口径 ─────────────────────────

t('飞机模板：示意值（显式填写、不在 prov 里的参数）里没有单位为 m 的长度——长度要么留空走组件自动式、要么是「有出处尺寸 × 示意比例」的派生；G650 卫通罩外形待输入', () => {
  // 例外：G650 卫通罩外形没有出处，按示意外形填、界面描红、needsInput 记 radomeLWHcm
  const EXEMPT = { 'ent:g650er': ['rdm.lengthM', 'rdm.widthM', 'rdm.heightM'] }
  for (const rec of E.listEntityTemplates('aircraft')) {
    for (const path of E.entityTemplateDoc(rec.id).illustrative) {
      if (path.includes('#')) continue
      const [cid, key] = path.split('.'), spec = getComponent(compOf(rec, cid).type).params[key]
      if (spec && spec.unit === 'm') assert.ok((EXEMPT[rec.id] || []).includes(path), `${rec.id} ${path} 是没有出处的绝对长度（${compOf(rec, cid).params[key]} m）`)
    }
    for (const [path, p] of Object.entries(rec.prov)) if (p.fn === 'mul') assert.ok(Object.keys(p.with).every((k) => typeof p.with[k] === 'number' && p.with[k] > 0), `${rec.id} ${path} 比例`)
  }
  const g = E.getEntityTemplate('ent:g650er'), gd = E.entityTemplateDoc('ent:g650er')
  assert.ok(g.needsInput.includes('radomeLWHcm'), 'G650 needsInput 含 radomeLWHcm')
  for (const k of ['lengthM', 'widthM', 'heightM']) {
    assert.ok(!Object.hasOwn(g.prov, `rdm.${k}`), `G650 rdm.${k} 不得冒充有出处`)
    assert.ok(gd.illustrative.includes(`rdm.${k}`), `G650 rdm.${k} 是示意值（描红）`)
  }
  for (const k of ['sweptDM', 'sweptHM']) assert.equal(g.prov[`rdm.${k}`].dim, 'antennaSweptVolumeCm')
})

t('船 / 车模板：船载卫通罩的罩高 × 罩径、反射面、整机质量进 dims 与 prov（Intellian 出处进悬停，与组件预设同值）；展开座方位行程与组件同为示意值', () => {
  for (const rec of E.listEntityTemplates('ship')) {
    const v = compOf(rec, 'vsat'), pre = SHIP_RADOMES[v.params.model], d = rec.dims
    near(d.radomeHxDcm.value.H * 0.01, pre.H, 1e-12, `${rec.id} 罩高`); near(d.radomeHxDcm.value.D * 0.01, pre.D, 1e-12, `${rec.id} 罩径`)
    near(d.reflectorDiameterCm.value * 0.01, pre.reflD, 1e-12, `${rec.id} 反射面`); assert.equal(d.radomeMassKg.value, pre.massKg)
    for (const k of ['radomeHxDcm', 'reflectorDiameterCm', 'radomeMassKg']) assert.equal(d[k].source, pre.source)
    for (const k of ['heightM', 'diameterM', 'reflectorDM', 'massKg']) assert.ok(Object.hasOwn(rec.prov, `vsat.${k}`), `${rec.id} vsat.${k} 记 prov`)
    assert.ok(rec.urls.includes(pre.source) && rec.hover.includes(pre.source), `${rec.id} 悬停带 Intellian 出处`)
  }
  assert.equal(getComponent('veh.driveaway').params.azTravelDeg.source, 'illustrative', '方位行程研究表无独立字段 → 示意')
  assert.ok(E.entityTemplateDoc('ent:van-driveaway').illustrative.includes('dw.azTravelDeg'))
  assert.ok(Object.values(DRIVEAWAYS).every((x) => /^https?:\/\//.test(x.source)))
})

// ───────────────────────── ⑧ 禁词 ─────────────────────────

const BANNED = /中国|国内|国产|东方红|DFH|C919|C909|ARJ21|COMAC|商飞|中星|天链|天通|亚太|\bAPSTAR\b|北斗|\bBeiDou\b|长征|中远|中海|招商|雪龙|向阳红|海巡|魔都|爱达|沪东|江南造船|扬子|广船|外高桥|电科|CETC|国家授时|39 ?所|54 ?所|MSC CHINA|KMTC DAMMAM/i
const stripUrls = (s) => s.replace(/https?:\/\/[^\s'"`)]+/g, '')
t('禁词：模板全部字符串、四个领域组件的名称 / 标签 / 悬停 / 选项、领域源码（去 URL）都不含相关型号', () => {
  const strs = []
  const walk = (o) => { if (typeof o === 'string') { if (!/^https?:\/\//.test(o)) strs.push(o) } else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { strs.push(k); walk(v) } }
  walk(E.ENTITY_TEMPLATES)
  walk(E.entityTemplateCatalog().map((c) => ({ ...c, source: { ...c.source, url: '' } })))
  for (const s of strs) { const m = stripUrls(s).match(BANNED); assert.ok(!m, `模板字符串命中禁词「${m && m[0]}」：${s.slice(0, 80)}`) }
  for (const def of DEFS) {
    const fields = [def.title, def.titleZh]
    for (const k of def.keys) { const s = def.params[k]; fields.push(s.label, s.title || '', ...(s.kind === 'enum' ? s.options.map(String) : [])) }
    for (const f of fields) { const m = stripUrls(f).match(BANNED); assert.ok(!m, `${def.type} 命中禁词「${m && m[0]}」：${f}`) }
  }
  const files = ['components/ground.mjs', 'components/air.mjs', 'components/sea.mjs', 'components/veh.mjs', 'components/shapeKit.mjs', 'entityTemplates.mjs',
    ...readdirSync(MODELS + 'entityTemplates').filter((f) => f.endsWith('.mjs')).map((f) => `entityTemplates/${f}`)]
  assert.ok(files.length >= 11, '扫描文件数')
  for (const f of files) {
    const src = stripUrls(readFileSync(MODELS + f, 'utf8')), m = src.match(BANNED)
    assert.ok(!m, `${f} 命中禁词「${m && m[0]}」：…${m ? src.slice(Math.max(0, m.index - 30), m.index + 30) : ''}…`)
  }
  for (const r of E.ENTITY_TEMPLATES) assert.ok(!/arj21|c919|xuelong|xiangyanghong|haixun|adora|yj45/i.test(r.id + r.representative + r.title), `${r.id} 含剔除条目`)
})

// ───────────────────────── ⑨ 金标准 ─────────────────────────

t('金标准不变：fixtures/models/parambus.golden.json 的 sha256', () => {
  const buf = readFileSync(new URL('./fixtures/models/parambus.golden.json', import.meta.url))
  assert.equal(createHash('sha256').update(buf).digest('hex'), '374a9e20d5412d50f5c478c3c778db2dff65cc2ba90d7de96afc3a4254b55fa6')
})

console.log(`  参数边界：合法 ${boundaryStats.ok} 例生成、非法 ${boundaryStats.rejected} 例拒收`)
console.log(`modelAsmDomains: ${n} 项通过`)
