// 参数化整星生成（packages/core/models/paramBus.mjs + paramTemplates.mjs）的回归网。
//
// 查的是任务书 §5.6 的四件事 + 互操作硬要求 + 09-23 审查补的口子：
//   ① 确定性：同 spec 两次 specHash 相同、IR 逐字段相等；哈希先归一（缺省值写不写出来同哈希），返回的 specHash = specHash(返回的 spec)。
//   ② 反射面焦点：自动摆位的焦点按槽位规则在测试里独立算出来，对挂点 1e-9 m；网格顶点满足抛物面定义，
//      由网格反求的焦距与给定焦距之差 < 1e-6 m（顶点是 Float32，量化误差实测 ~5e-7）。
//   ③ components 质心对手算：盒 + 单翼（轭 + 两块板）的质心按文件头约定逐项手算，1e-9。
//   ④ 太阳翼组只含电池面节点；节点名唯一非空；各模板过 ir.validateIR 与 schema.validateMeta。
//   ⑤ 默认卫星模板生成 < 1 s（报 ms）。
//   ⑥ 全部模板 × 附加件（侧挂 / 塔馈 / 网状 / 平面馈源阵反射面、显式附加件、立方星展开板）都产出有限数且 IR 合法；
//      细节档与布局族错配、bus.shape 非 box、偏置方向与视轴近平行都被 validateSpec 拒绝；生成结果含非有限数时抛 SPEC_INVALID。
//   ⑦ 缺口口径：needsInput（spec 路径）= fill:'none' 那份 spec 的 validateSpec().missing；fill 模式 illustrative ⊇ needsInput。
//   ⑧ 2026-09-24：目录不带中国平台模板、文字无中国平台字样；旧 id（dfh4 / dfh4e / dfh5、param:<旧 id>）静默别名到 default-sat；
//      default-sat 与原 dfh4e 模板两档 spec 逐字段相同、生成几何逐位相同。
// 不联网；不读 NASA 语料。

import assert from 'node:assert/strict'
import {
  buildParamModel, buildTemplateModel, specHash, validateSpec, normalizeSpec, paramModelIdForSpec,
  DENSITY, DEFAULT_Q_MODEL2BODY, ROOT_MATRIX, LAYOUT_PRESETS, PRESET_KEYS
} from '../models/paramBus.mjs'
import {
  TEMPLATES, TEMPLATE_IDS, DETAIL_PRESETS, templateSpec, templateCatalog,
  resolveTemplateId, isTemplateId, resolveParamModelId, DEFAULT_TEMPLATE_ID, DEFAULT_MODEL_ID
} from '../models/paramTemplates.mjs'
import { validateIR, irStats } from '../models/ir.mjs'
import { validateMeta, defaultMeta, DEFAULT_Q_MODEL2BODY as SCHEMA_Q } from '../models/schema.mjs'
import * as BF from '../models/bodyFrame.mjs'
import * as AGI from '../models/agi.mjs'

// 冷启动计时放在最前：进程里第一次生成（含 JIT 与模块内缓存的首次填充）才是「冷」
const COLD_T0 = performance.now()
buildTemplateModel('default-sat')
const coldMs = performance.now() - COLD_T0

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}，容差 ${tol}）`)
const nearV = (a, b, tol, msg) => { for (let k = 0; k < 3; k++) near(a[k], b[k], tol, `${msg}[${k}]`) }
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const nrm = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l] }
// 列主序 4×4 作用于点
const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]
const nodeByName = (ir, name) => ir.nodes.find((x) => x.name === name)
const matByNode = (ir, node) => ir.materials[ir.meshes[node.mesh].material]
const clone = (o) => JSON.parse(JSON.stringify(o))
/** 递归查结果里所有数（含 TypedArray）都有限；返回第一处坏值的路径或 null。 */
function firstNonFinite(v, path = '') {
  if (typeof v === 'number') return Number.isFinite(v) ? null : path
  if (ArrayBuffer.isView(v)) { for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return `${path}[${i}]`; return null }
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = firstNonFinite(v[i], `${path}[${i}]`); if (r) return r } return null }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) { const r = firstNonFinite(v[k], `${path}.${k}`); if (r) return r } }
  return null
}

// ───────── ① 确定性 / 哈希 ─────────

t('specHash：格式 16 位十六进制；键顺序、−0 不影响；改一个数就变', () => {
  const s = templateSpec('default-sat').spec
  const h = specHash(s)
  assert.match(h, /^[0-9a-f]{16}$/)
  assert.equal(specHash(JSON.parse(JSON.stringify(s))), h)
  // 反转每一层的键顺序
  const rev = (o) => (Array.isArray(o) ? o.map(rev) : (o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).reverse().map((k) => [k, rev(o[k])])) : o))
  assert.equal(specHash(rev(s)), h)
  const s2 = JSON.parse(JSON.stringify(s)); s2.wings[0].tiltDeg = -0
  assert.equal(specHash(s2), h, '−0 与 0 同哈希')
  s2.wings[0].panelHM += 0.001
  assert.notEqual(specHash(s2), h)
  assert.equal(paramModelIdForSpec(s), `param:${h.slice(0, 12)}`)
})

t('specHash 先归一：缺省值写不写出来同哈希；返回的 specHash = specHash(返回的 spec)；normalizeSpec 幂等', () => {
  for (const id of TEMPLATE_IDS) {
    const r = buildTemplateModel(id)
    assert.equal(r.specHash, specHash(r.spec), `${id} 返回的 specHash 对得上返回的 spec`)
    assert.equal(specHash(templateSpec(id).spec), r.specHash, `${id} 表单 spec 与归一 spec 同哈希`)
    const once = normalizeSpec(templateSpec(id).spec)
    assert.deepStrictEqual(normalizeSpec(once), once, `${id} normalizeSpec 幂等`)
    assert.deepStrictEqual(normalizeSpec(templateSpec(id, { fill: 'none' }).spec), normalizeSpec(normalizeSpec(templateSpec(id, { fill: 'none' }).spec)), `${id} none 档幂等`)
  }
  const bare = { layout: 'geo', bus: { xM: 2, yM: 2, zM: 2 }, wings: [], reflectors: [{ diameterM: 1.5 }, { mount: 'deck', diameterM: 0.8 }] }
  const full = normalizeSpec(bare)
  assert.equal(full.reflectors[0].slot, '+X'); assert.equal(full.reflectors[1].slot, 'deck+Y'); assert.equal(full.reflectors[1].mount, 'deck')
  assert.equal(specHash(bare), specHash(full), '最简 spec 与写全缺省值的 spec 同哈希')
  assert.equal(paramModelIdForSpec(bare), paramModelIdForSpec(full))
  assert.deepStrictEqual(normalizeSpec(full), full)
})

t('槽位缺省取第一个空闲槽位：删掉中间一副再加一副不撞', () => {
  const s = normalizeSpec({ layout: 'geo', bus: { xM: 2, yM: 2, zM: 2 }, wings: [], reflectors: [{ slot: '+X', diameterM: 1 }, { slot: '+X2', diameterM: 1 }, { diameterM: 1 }, { diameterM: 1, posBody: [0, 0, 3] }, { diameterM: 1 }] })
  assert.deepStrictEqual(s.reflectors.map((r) => r.slot), ['+X', '+X2', '-X', '-X2', '-X2'])
  // posBody 条目不占槽位：第 5 副（自动）与第 4 副（posBody）同槽不算重复
  assert.ok(validateSpec(s).ok, JSON.stringify(validateSpec(s)))
})

t('同 spec 两次生成：specHash 与 IR 逐字段相等（含 TypedArray）', () => {
  const s = templateSpec('default-sat').spec
  const a = buildParamModel(s)
  const b = buildParamModel(JSON.parse(JSON.stringify(s)))
  assert.equal(a.specHash, b.specHash)
  assert.deepStrictEqual(a.ir, b.ir)
  for (const k of ['attachPoints', 'articulations', 'solarPanelGroups', 'massProps', 'parts', 'frame', 'bboxBody', 'specOriginBody']) assert.deepStrictEqual(a[k], b[k], k)
})

t('默认卫星模板生成 < 1 s', () => {
  const t0 = performance.now(); buildTemplateModel('default-sat'); const hot = performance.now() - t0
  console.log(`  默认卫星生成：冷 ${coldMs.toFixed(1)} ms，热 ${hot.toFixed(1)} ms`)
  assert.ok(coldMs < 1000 && hot < 1000)
})

// ───────── ② 反射面焦点 ─────────

// 手给焦点与倾斜视轴 + 自动摆位的侧挂 / 塔馈：挂点 / 拟合参数 / 网格三方对账
const tiltSpec = {
  layout: 'geo', detailPreset: 'geo',
  bus: { shape: 'box', xM: 2.4, yM: 2.2, zM: 3.0, mli: 'mli_gold' },
  wings: [],
  reflectors: [
    { slot: '+X', diameterM: 2.3, focalM: 1.9, offsetHM: 1.6, posBody: [1.05, 0.3, 1.8], boresightBody: [0.12, -0.05, 1] },
    { slot: '-X', diameterM: 2.0, focalM: 1.7, offsetHM: null, posBody: null, boresightBody: [0, 0, 1] },
    { slot: 'deck+Y', diameterM: 1.1, focalM: 0.9, offsetHM: null, posBody: null }
  ]
}
// 东侧成对（+X 内槽 / +X2 外槽）
const pairSpec = {
  layout: 'geo', detailPreset: 'geo',
  bus: { shape: 'box', xM: 2.2, yM: 2.0, zM: 3.2, mli: 'mli_gold' },
  wings: [],
  reflectors: [{ slot: '+X', diameterM: 2.0 }, { slot: '+X2', diameterM: 1.6, focalM: 1.5 }]
}
const csSpec = () => ({ ...templateSpec('cubesat-3u').spec, reflectors: [{ slot: '-X', diameterM: 0.3 }] })

/**
 * 按槽位规则独立算自动焦点（spec 原点）——不调生成器的任何函数，只用 spec 与细节档里的数。
 *   侧挂：F = (s·(hx − feedInset), yF, hz + standoff)，yF = 成对时内槽 +hy/2、外槽 −hy/2，否则 0
 *   塔馈：F = (0, s·(towerW/2 + 0.1k), hz + 塔高)，塔高 = max_i[f − near²/(4f) + 0.15k]，near = 偏置 − D/2 = 0.1k
 *   hz：GEO / LEO 取平台体半高；立方星取结构体顶面 (Z − 2·railFoot)/2（不是导轨端脚）
 */
function expectedFocus(spec, i) {
  const D = DETAIL_PRESETS[spec.detailPreset], k = D.reflDetailScale
  const r = spec.reflectors[i]
  const hx = spec.bus.xM / 2, hy = spec.bus.yM / 2
  const hz = spec.layout === 'cubesat' ? (spec.bus.zM - 2 * D.railFootM) / 2 : spec.bus.zM / 2
  const s = r.slot.startsWith('-') || r.slot === 'deck-Y' ? -1 : 1
  if (!r.slot.startsWith('deck')) {
    const outer = r.slot.endsWith('2')
    const mate = outer ? r.slot.slice(0, 2) : r.slot + '2'
    const paired = spec.reflectors.some((q) => q !== r && q.slot === mate && !q.posBody)
    const yF = paired ? (outer ? -hy / 2 : hy / 2) : 0
    return [s * (hx - D.feedInsetM), yF, hz + D.feedStandoffM]
  }
  let th = 0
  for (const q of spec.reflectors.filter((x) => x.slot.startsWith('deck') && !x.posBody)) {
    const f = q.focalM ?? D.fdSolid * q.diameterM, nearE = 0.1 * k
    th = Math.max(th, f - nearE * nearE / (4 * f) + 0.15 * k)
  }
  return [0, s * (D.towerWM / 2 + 0.1 * k), hz + th]
}

t('反射面焦点：手给焦点原样；自动摆位的焦点对槽位规则独立推算（1e-9）；dir = 视轴', () => {
  const r = buildParamModel(tiltSpec)
  const c = r.specOriginBody
  const a0 = nrm(tiltSpec.reflectors[0].boresightBody)
  const ap = r.attachPoints.find((x) => x.name === 'reflector_1_focus')
  nearV(add(ap.posBody, c), [1.05, 0.3, 1.8], 1e-9, '手给焦点（换回 spec 原点）')
  nearV(ap.dirBody, a0, 1e-12, '视轴')
  near(dot(ap.upBody, ap.dirBody), 0, 1e-12, 'up ⊥ dir')
  near(len(ap.upBody), 1, 1e-12, '|up|')
  for (const [label, spec] of [['tilt', tiltSpec], ['pair', pairSpec], ['cubesat', csSpec()]]) {
    const rr = buildParamModel(spec)
    spec.reflectors.forEach((q, i) => {
      if (q.posBody) return
      const apx = rr.attachPoints.find((x) => x.name === `reflector_${i + 1}_focus`)
      nearV(add(apx.posBody, rr.specOriginBody), expectedFocus(spec, i), 1e-9, `${label} 反射面 ${i + 1} 自动焦点`)
      nearV(apx.dirBody, nrm(q.boresightBody || [0, 0, 1]), 1e-12, `${label} 反射面 ${i + 1} 视轴`)
    })
    // 拟合参数与挂点同源一致（焦距原样、顶点 = 焦点 − f·轴）
    for (const p of rr.parts.filter((q) => q.role === 'reflector')) {
      const apx = rr.attachPoints.find((x) => x.name === `${p.id}_focus`)
      nearV(p.fitted.focusBody, apx.posBody, 1e-12, `${label} ${p.id} focusBody`)
      nearV(add(p.fitted.vertexBody, p.fitted.axisBody.map((x) => x * p.fitted.focalM)), apx.posBody, 1e-9, `${label} ${p.id} V+f·a`)
    }
  }
})

t('网格顶点满足抛物面定义；由网格反求焦距 ≈ 给定焦距（< 1e-6 m）；正面法向朝焦点一侧；实面背壳退 shellM', () => {
  for (const [label, spec] of [['tilt', tiltSpec], ['pair', pairSpec], ['cubesat', csSpec()]]) {
    const r = buildParamModel(spec)
    const D = DETAIL_PRESETS[normalizeSpec(spec).detailPreset]
    for (let i = 0; i < spec.reflectors.length; i++) {
      const node = nodeByName(r.ir, `reflector_${i + 1}`)
      assert.equal(matByNode(r.ir, node).key, 'reflector')
      const mesh = r.ir.meshes[node.mesh]
      const ap = r.attachPoints.find((x) => x.name === `reflector_${i + 1}_focus`)
      const F = ap.posBody, a = ap.dirBody
      const f0 = spec.reflectors[i].focalM ?? D.fdSolid * spec.reflectors[i].diameterM
      let worst = 0, sumF = 0, cnt = 0, minFacing = Infinity
      for (let k = 0; k < mesh.position.length; k += 3) {
        // 反射面节点本身无旋转，只有平移（本体系）；根节点才转到模型轴
        const P = xf(node.matrix, [mesh.position[k], mesh.position[k + 1], mesh.position[k + 2]])
        const d = sub(P, F)
        const fEst = (len(d) - dot(d, a)) / 2          // |P−F| = (P−F)·a + 2f
        worst = Math.max(worst, Math.abs(fEst - f0)); sumF += fEst; cnt++
        const nv = [mesh.normal[k], mesh.normal[k + 1], mesh.normal[k + 2]]
        minFacing = Math.min(minFacing, dot(nv, nrm(sub(F, P))))
      }
      assert.ok(cnt >= 1 + 48 * 12, `${label} 反射面 ${i + 1} 细分 ≥ 48×12（${cnt} 顶点）`)
      near(sumF / cnt, f0, 1e-6, `${label} 反射面 ${i + 1} 平均反求焦距`)
      assert.ok(worst < 1e-6, `${label} 反射面 ${i + 1} 最大焦距偏差 ${worst}`)
      assert.ok(minFacing > 0, `${label} 反射面 ${i + 1} 正面法向都朝焦点一侧（最小余弦 ${minFacing}）`)
      const back = r.ir.meshes[nodeByName(r.ir, `reflector_${i + 1}_back`).mesh]
      const p0 = [mesh.position[0], mesh.position[1], mesh.position[2]], q0 = [back.position[0], back.position[1], back.position[2]]
      near(len(sub(p0, q0)), D.shellM, 1e-6, `${label} 反射面 ${i + 1} 背壳退 shellM`)
    }
  }
})

t('网状反射面：只有金属网（reflector_mesh、双面、半透明）+ 周边桁架，没有实心背壳 / 边环', () => {
  for (const id of ['ssl1300', 'eurostar3000']) {
    const r = buildTemplateModel(id)
    const names = new Set(r.ir.nodes.map((x) => x.name))
    const front = nodeByName(r.ir, 'reflector_1'), mat = matByNode(r.ir, front)
    assert.equal(mat.key, 'reflector_mesh'); assert.equal(mat.doubleSided, true); assert.ok(mat.opacity < 1)
    assert.ok(!names.has('reflector_1_back') && !names.has('reflector_1_rim'), `${id} 不该有背壳 / 边环`)
    const truss = nodeByName(r.ir, 'reflector_1_truss')
    assert.ok(truss && matByNode(r.ir, truss).key === 'carbon', `${id} 周边桁架`)
    const part = r.parts.find((p) => p.id === 'reflector_1')
    assert.ok(part.nodes.includes('reflector_1_truss'), '桁架归反射面部件')
    // 桁架质量已摊进网状面密度：反射面组件只有一条
    assert.equal(r.massProps.components.filter((q) => q.name.startsWith('reflector_1') && !q.name.includes('_arm')).length, 1)
  }
})

// ───────── ③ 质心手算 ─────────

t('components 质心对手算：盒 + 单翼（轭三杆 + 两块板的基板与电池面）', () => {
  const D = DETAIL_PRESETS.geo, rho = (k) => DENSITY[k].value
  const W = 2, H = 3, gap = 0.1, yoke = 1.0, bus = [2, 2, 2]
  const spec = {
    layout: 'geo', detailPreset: 'geo',
    bus: { shape: 'box', xM: bus[0], yM: bus[1], zM: bus[2], mli: null },
    wings: [{ side: '+Y', panels: 2, panelHM: H, panelWM: W, yokeLenM: yoke, gapM: gap, tiltDeg: 0 }],
    reflectors: [],
    detail: { mli: false, radiators: false, thrusters: false, adapter: false, deckHorns: 0 }
  }
  const r = buildParamModel(spec)
  // 手算（spec 原点 = 平台体中心）。翼局部系：x_l=−X、y_l=+Y、z_l=−Z，原点 = 铰点 (0, 1, 0)
  const toBody = (l) => [-l[0], 1 + l[1], -l[2]]
  const items = []
  items.push([rho('busVolume') * bus[0] * bus[1] * bus[2], [0, 0, 0]])
  const y0 = D.sadaLenM + yoke, rr = D.yokeRodDM / 2
  const rods = [[[0, D.sadaLenM, 0], [0.4 * W, y0 - rr, 0]], [[0, D.sadaLenM, 0], [-0.4 * W, y0 - rr, 0]], [[-0.4 * W, y0 - rr, 0], [0.4 * W, y0 - rr, 0]]]
  for (const [a, b] of rods) items.push([rho('boomLinear') * len(sub(b, a)), toBody([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0])])
  const cw = W / 2 - D.cellMarginM, ch = H / 2 - D.cellMarginM
  for (let k = 0; k < 2; k++) {
    const cy = y0 + k * (H + gap) + H / 2
    items.push([rho('panelAreal') * W * H, toBody([0, cy, 0])])
    items.push([rho('cellAreal') * 4 * cw * ch, toBody([0, cy, D.panelTM / 2 + 0.0005])])
  }
  const M = items.reduce((s, [m]) => s + m, 0)
  const C = [0, 1, 2].map((k) => items.reduce((s, [m, p]) => s + m * p[k], 0) / M)
  near(r.massProps.massKg, M, 1e-9, '总质量')
  nearV(add(r.massProps.comBody, r.specOriginBody), C, 1e-9, '质心（spec 原点）')
  assert.equal(r.massProps.components.length, items.length, '组件个数')
  assert.equal(r.massProps.source, 'components')
  // 惯量：对称、主对角正
  const I = r.massProps.inertiaBody
  for (let i = 0; i < 3; i++) { assert.ok(I[i][i] > 0); for (let j = 0; j < 3; j++) near(I[i][j], I[j][i], 1e-9, `I 对称 ${i}${j}`) }
  // 惯量独立核一项：绕 Y 轴的 Iyy（盒 + 杆 + 板，全用平行轴），与生成器的累加对拍
  // 盒 Iyy = m(a²+c²)/12；板在 x-y 面：Iyy = m·w²/12；杆 Iyy = m·L²/12·(1−dy²)
  let Iyy = 0
  const mb = items[0][0]; Iyy += mb * (bus[0] ** 2 + bus[2] ** 2) / 12 + mb * (C[0] ** 2 + C[2] ** 2)
  rods.forEach(([a, b], i) => {
    const m = items[1 + i][0], L = len(sub(b, a)), d = nrm(sub(toBody(b), toBody(a))), p = items[1 + i][1]
    Iyy += m * L * L / 12 * (1 - d[1] * d[1]) + m * ((p[0] - C[0]) ** 2 + (p[2] - C[2]) ** 2)
  })
  for (let k = 0; k < 2; k++) {
    const [ms, ps] = items[4 + 2 * k], [mc, pc] = items[5 + 2 * k]
    Iyy += ms * W * W / 12 + ms * ((ps[0] - C[0]) ** 2 + (ps[2] - C[2]) ** 2)
    Iyy += mc * (2 * cw) ** 2 / 12 + mc * ((pc[0] - C[0]) ** 2 + (pc[2] - C[2]) ** 2)
  }
  near(I[1][1], Iyy, 1e-7 * Iyy, 'Iyy')
})

t('massTargetKg：总质量钉在目标上，平台体吃余量', () => {
  const r = buildTemplateModel('default-sat')
  near(r.massProps.massKg, 5550, 1e-6, '默认卫星 = 估算质量 5550 kg')
  const cs = buildTemplateModel('cubesat-3u')
  near(cs.massProps.massKg, 6, 1e-9, '3U = CDS 6 kg')
})

// ───────── ④ 结构 / 互操作 ─────────

t('全部模板：生成、IR 合法、节点名唯一非空、挂点 / 关节 / 太阳翼组引用的节点都在、ModelMeta 过校验', () => {
  const cat = new Map(templateCatalog().map((c) => [c.templateId, c]))
  for (const id of TEMPLATE_IDS) {
    const r = buildTemplateModel(id)
    const v = validateIR(r.ir)
    assert.ok(v.ok, `${id} validateIR：${v.errors.slice(0, 3).join('；')}`)
    const names = r.ir.nodes.map((x) => x.name)
    assert.ok(names.every((x) => typeof x === 'string' && x.length > 0 && !/\s/.test(x)), `${id} 节点名非空无空白`)
    assert.equal(new Set(names).size, names.length, `${id} 节点名唯一`)
    const has = new Set(names)
    for (const a of r.attachPoints) {
      assert.ok(has.has(a.node), `${id} 挂点节点 ${a.node}`)
      near(len(a.dirBody), 1, 1e-12, `${id} ${a.name} |dir|`); near(dot(a.dirBody, a.upBody), 0, 1e-12, `${id} ${a.name} up⊥dir`)
    }
    for (const a of r.articulations) {
      assert.ok(a.nodes.length && a.nodes.every((x) => has.has(x)), `${id} 关节 ${a.name} 节点齐`)
      assert.equal(a.stages[0].type, 'yRotate'); assert.equal(a.stages[0].minimumValue, -180); assert.equal(a.stages[0].maximumValue, 180)
    }
    // 太阳翼组只含电池面节点（材质 solar_cell），且每个电池面节点都在某组里
    const cellNodes = r.ir.nodes.filter((x) => x.mesh !== undefined && matByNode(r.ir, x).key === 'solar_cell').map((x) => x.name)
    const inGroups = r.solarPanelGroups.flatMap((g) => g.nodes)
    for (const g of r.solarPanelGroups) {
      assert.ok(g.nodes.length > 0, `${id} ${g.name} 非空`)
      for (const x of g.nodes) assert.ok(cellNodes.includes(x), `${id} 组 ${g.name} 含非电池面节点 ${x}`)
      assert.equal(g.efficiency, 28)
    }
    assert.deepStrictEqual([...cellNodes].sort(), [...inGroups].sort(), `${id} 电池面节点与太阳翼组一一对应`)
    // 挂点：对地 +Z、对天 −Z
    nearV(r.attachPoints.find((a) => a.name === 'nadir_center').dirBody, [0, 0, 1], 0, `${id} 对地`)
    nearV(r.attachPoints.find((a) => a.name === 'zenith_center').dirBody, [0, 0, -1], 0, `${id} 对天`)
    for (const w of r.attachPoints.filter((a) => a.name.startsWith('wing_'))) assert.ok(Math.abs(Math.abs(w.dirBody[1]) - 1) < 1e-12, `${id} 翼轴 ±Y`)
    // 几何中心：包围盒中心在原点
    for (let k = 0; k < 3; k++) near(r.bboxBody.min[k] + r.bboxBody.max[k], 0, 1e-9, `${id} 包围盒居中[${k}]`)
    // ModelMeta（契约 §3.2）组装后过 schema 校验
    const st = irStats(r.ir), c = cat.get(id)
    const meta = defaultMeta({
      id: c.id, title: c.title, titleZh: c.titleZh, kind: c.kind, group: c.group, fidelity: c.fidelity, source: c.source,
      units: { scaleToMeters: 1, unitGuess: 'm', sizeVerified: false }, frame: r.frame,
      geometry: { bboxM: st.bboxM, boundingRadiusM: r.boundingRadiusM, tris: st.tris, areaM2: st.areaM2, volumeM3: null, closed: false, centroidM: [0, 0, 0] },
      parts: r.parts, massProps: r.massProps, attachPoints: r.attachPoints, articulations: r.articulations,
      solarPanelGroups: r.solarPanelGroups, noObscurationNodes: [], spec: r.spec, tags: c.tags, aliases: c.aliases
    })
    const vm = validateMeta(meta, { nodeNames: names })
    assert.ok(vm.ok, `${id} validateMeta：${vm.errors.slice(0, 3).join('；')}`)
  }
})

t('太阳翼：关节节点不含电池面以外的受光面组；基板与电池面分节点；局部 y 为翼轴', () => {
  const r = buildTemplateModel('default-sat')
  const art = r.articulations.find((a) => a.name === 'wing_+Y')
  const spg = r.solarPanelGroups.find((g) => g.name === 'wing_+Y')
  assert.ok(art.nodes.includes('wing_+Y_yoke') && art.nodes.includes('wing_+Y_1_substrate') && art.nodes.includes('wing_+Y_1_cells'))
  assert.ok(!art.nodes.includes('wing_+Y_sada'), 'SADA 固定在平台上，不随关节转')
  assert.ok(spg.nodes.every((x) => x.endsWith('_cells')))
  // 关节节点共用一个局部系：矩阵的第 2 列（局部 y）= 翼展方向 +Y_body
  for (const nm of art.nodes) {
    const m = nodeByName(r.ir, nm).matrix
    nearV([m[4], m[5], m[6]], [0, 1, 0], 1e-12, `${nm} 局部 y`)
  }
  const mw = nodeByName(r.ir, 'wing_-Y_1_cells').matrix
  nearV([mw[4], mw[5], mw[6]], [0, -1, 0], 1e-12, '−Y 翼局部 y')
  // 电池面朝天顶（tilt 0）：局部 z = −Z_body
  nearV([mw[8], mw[9], mw[10]], [0, 0, -1], 1e-12, '电池面法向')
})

t('坐标：根节点 = 出厂映射的逆（bodyFrame 唯一真值源）；frame.q_model2body = 出厂值', () => {
  const r = buildTemplateModel('generic')
  const root = r.ir.nodes[0]
  assert.equal(root.parent, -1); assert.equal(root.name, 'satellite')
  assert.deepStrictEqual(root.matrix, [...ROOT_MATRIX])
  assert.deepStrictEqual([...ROOT_MATRIX], [...BF.ROOT_MATRIX_BODY2MODEL], '根矩阵取自 bodyFrame，不是抄的数')
  // 本体点经根矩阵到模型轴 = 出厂映射的逆（期望值由 bodyFrame 算，不写死）
  nearV(xf(root.matrix, [1, 2, 3]), BF.bodyToModel([1, 2, 3], BF.DEFAULT_Q_MODEL2BODY), 1e-15, 'body→gltf')
  nearV(BF.modelToBody(xf(root.matrix, [1, 2, 3]), r.frame.q_model2body), [1, 2, 3], 1e-15, '按 frame 摆回本体系 = 生成时的坐标')
  assert.ok(r.ir.nodes.slice(1).every((x) => x.parent === 0), '其余节点平铺在根下')
  assert.deepStrictEqual(r.frame.q_model2body, [...SCHEMA_Q])
  assert.deepStrictEqual([...DEFAULT_Q_MODEL2BODY], [...SCHEMA_Q])
  assert.deepStrictEqual([...DEFAULT_Q_MODEL2BODY], [...BF.DEFAULT_Q_MODEL2BODY])
  assert.deepStrictEqual(r.frame.t_model2body, [0, 0, 0])
  // STK 口径：对地面（本体 +Z）在模型轴下是 glTF 的哪一面，由出厂 R 决定——对地挂点的视轴映回模型轴 = 出厂 Rᵀ·(+Z)
  nearV(xf(root.matrix, [0, 0, 1]), BF.bodyToModel([0, 0, 1], BF.DEFAULT_Q_MODEL2BODY), 1e-15, '天底面在模型轴下的朝向')
})

t('挂点节点：attachNodeMatrix 口径（局部 +Y = 视轴、+X = 上向）；整棵 IR 当 glTF 读回的位姿 = 生成的 attachPoints；上向缺省按 D1', () => {
  for (const id of ['default-sat', 'flat-leo', 'cubesat-3u', 'ssl1300']) {
    const r = buildTemplateModel(id)
    // IR 节点 → 最小 glTF JSON（只要节点树与矩阵），用 agi.mjs 的读回函数按出厂 frame 求挂点位姿
    const json = { nodes: r.ir.nodes.map((nd) => ({ name: nd.name, matrix: nd.matrix ? [...nd.matrix] : undefined, children: [] })) }
    r.ir.nodes.forEach((nd, i) => { if (nd.parent >= 0) json.nodes[nd.parent].children.push(i) })
    const poses = AGI.attachPointPoses(json, r.attachPoints.map((a) => ({ name: a.name, node: a.node })), r.frame)
    for (const p of poses) {
      const a = r.attachPoints.find((x) => x.name === p.name)
      nearV(p.posBody, a.posBody, 1e-12, `${id} ${a.name} 位置读回`)
      nearV(p.dirBody, a.dirBody, 1e-12, `${id} ${a.name} 视轴读回`)
      nearV(p.upBody, a.upBody, 1e-12, `${id} ${a.name} 上向读回`)
      const m = nodeByName(r.ir, a.node).matrix
      nearV([m[4], m[5], m[6]], a.dirBody, 1e-12, `${id} ${a.name} 节点局部 +Y = 视轴`)
      nearV([m[0], m[1], m[2]], a.upBody, 1e-12, `${id} ${a.name} 节点局部 +X = 上向`)
    }
    // 对地 / 对天 / 翼轴挂点没给上向：按 D1 缺省（与 schema.normalizeMeta 兜底同一口径）
    for (const nm of ['nadir_center', 'zenith_center']) {
      const a = r.attachPoints.find((x) => x.name === nm)
      if (a) nearV(a.upBody, BF.defaultUpBody(a.dirBody), 0, `${id} ${nm} 上向 = D1 缺省`)
    }
    for (const a of r.attachPoints.filter((x) => x.name.startsWith('wing_'))) nearV(a.upBody, BF.defaultUpBody(a.dirBody), 0, `${id} ${a.name} 上向 = D1 缺省`)
  }
  // GEO 对地挂点：上向 = 本体 −Y（顺行即北）——D1 零跳变的前提
  nearV(buildTemplateModel('default-sat').attachPoints.find((x) => x.name === 'nadir_center').upBody, [0, -1, 0], 0, 'GEO 对地挂点上向 −Y')
})

// ───────── ⑥ 全布局 × 附加件 / 拒绝非法组合 / 出口兜底 ─────────

t('细节档：每个布局族可配的每一档都带齐该族生成器要读的键（有限数）', () => {
  for (const [layout, presets] of Object.entries(LAYOUT_PRESETS)) {
    for (const p of presets) {
      for (const k of PRESET_KEYS[layout]) assert.ok(Number.isFinite(DETAIL_PRESETS[p][k]), `${layout} / ${p} 缺 ${k}`)
    }
  }
  // 模板用的档都在自己布局族的可配表里
  for (const id of TEMPLATE_IDS) assert.ok(LAYOUT_PRESETS[TEMPLATES[id].layout].includes(TEMPLATES[id].detail), `${id} 档与布局配套`)
})

t('全部模板 × 附加件：侧挂 / 塔馈 / 网状 / 馈源阵反射面、显式附加件、立方星展开板——IR 合法且所有数有限', () => {
  let cases = 0
  for (const id of TEMPLATE_IDS) {
    const base = templateSpec(id).spec
    const b = base.bus, s0 = Math.min(b.xM, b.yM)
    const hz = b.zM / 2
    const variants = {
      base: base,
      addSide: { ...clone(base), reflectors: [...base.reflectors, { mount: 'side', diameterM: 0.9 * s0 }] },
      sideDeck: { ...clone(base), reflectors: [{ slot: '+X', diameterM: 0.9 * s0 }, { slot: 'deck+Y', diameterM: 0.5 * s0 }] },
      meshArray: { ...clone(base), reflectors: [{ slot: '-X', diameterM: 2.5 * s0, mesh: true, feedType: 'array' }, { slot: 'deck-Y', diameterM: 0.6 * s0, mesh: true }] },
      tilted: { ...clone(base), reflectors: [{ slot: '+X', diameterM: 0.8 * s0, boresightBody: [0.3, 0.2, 1] }, { slot: '-X', diameterM: 0.8 * s0, boresightBody: [0, 0, 1], offsetDirBody: [0, 1, 0.2] }] },
      extras: {
        ...clone(base),
        feeds: [{ kind: 'horn', posBody: [0, 0, hz + 0.1 * s0], dirBody: [0, 0, 1], apertureM: 0.1 * s0 }, { kind: 'patchArray', posBody: [0, 0, -hz - 0.01], dirBody: [0, 0, -1], apertureM: 0.3 * s0 }],
        booms: [{ fromBody: [0, 0, -hz], toBody: [0, 0, -hz - s0], dM: 0.02 * s0 }],
        thrusters: [{ posBody: [-b.xM / 2, 0, 0], dirBody: [-1, 0, 0], exitDM: 0.05 * s0, lengthM: 0.1 * s0 }],
        radiators: [{ face: '+X', wM: 0.5 * s0, hM: 0.5 * s0 }, { face: '-Z', wM: 0.4 * s0, hM: 0.4 * s0 }]
      }
    }
    if (TEMPLATES[id].layout === 'cubesat') variants.deploy = { ...clone(base), cubesat: { bodyCells: true, deployPanels: 2 }, reflectors: [{ mount: 'deck', diameterM: 4 * s0 }] }
    for (const [vn, spec] of Object.entries(variants)) {
      const tag = `${id}/${vn}`
      const v = validateSpec(spec)
      assert.ok(v.ok, `${tag} validateSpec：${JSON.stringify(v)}`)
      const r = buildParamModel(spec)
      const vi = validateIR(r.ir)
      assert.ok(vi.ok, `${tag} validateIR：${vi.errors.slice(0, 3).join('；')}`)
      const bad = firstNonFinite({ ir: r.ir, aps: r.attachPoints, mp: r.massProps, parts: r.parts, bbox: r.bboxBody, rad: r.boundingRadiusM, org: r.specOriginBody })
      assert.equal(bad, null, `${tag} 非有限数：${bad}`)
      assert.ok(r.massProps.massKg > 0)
      const reflParts = r.parts.filter((p) => p.role === 'reflector')
      assert.equal(reflParts.length, normalizeSpec(spec).reflectors.length, `${tag} 反射面一副不少（立方星 / LEO 不许静默丢弃）`)
      for (const p of reflParts) {
        assert.ok(p.areaM2 > 0, `${tag} ${p.id} 面积 > 0`)
        assert.ok(r.attachPoints.some((a) => a.name === `${p.id}_focus`), `${tag} ${p.id} 焦点挂点`)
      }
      cases++
    }
  }
  console.log(`  附加件组合：${cases} 例`)
})

t('validateSpec 拒绝：细节档错配 / 未知档 / 未知布局 / bus.shape 非 box / 偏置方向与视轴近平行；文案只写状态', () => {
  const errs = (s) => validateSpec(s).errors
  const leo = templateSpec('flat-leo').spec, cs = templateSpec('cubesat-3u').spec, gsat = templateSpec('default-sat').spec
  // 审查复现的四种错配
  assert.deepStrictEqual(errs({ ...leo, detailPreset: 'geo', phasedArray: { tiles: 4 } }), ['detailPreset：geo 与布局 leo-flat 不配套'])
  assert.deepStrictEqual(errs({ ...cs, detailPreset: 'geo' }), ['detailPreset：geo 与布局 cubesat 不配套'])
  assert.deepStrictEqual(errs({ ...gsat, detailPreset: 'cubesat' }), ['detailPreset：cubesat 与布局 geo 不配套'])
  assert.deepStrictEqual(errs({ ...gsat, detailPreset: 'leo' }), ['detailPreset：leo 与布局 geo 不配套'])
  assert.ok(errs({ ...gsat, detailPreset: 'toString' }).includes('detailPreset：未知 toString'), '原型链上的键不算档')
  assert.ok(errs({ ...gsat, layout: 'hex' }).includes('layout：未知 hex'))
  assert.ok(validateSpec({ ...gsat, detailPreset: 'small' }).ok, 'geo 可配 small')
  for (const shape of ['cylinder', 'hex']) assert.deepStrictEqual(errs({ ...gsat, bus: { ...gsat.bus, shape } }), [`bus.shape：不支持 ${shape}`])
  // 审查复现：视轴恰好沿槽位缺省偏置方向
  assert.deepStrictEqual(errs({ ...gsat, reflectors: [{ slot: '+X', diameterM: 2, boresightBody: [1, 0, 0] }] }), ['reflectors[0].boresightBody：与槽位 +X 的偏置方向近平行'])
  assert.deepStrictEqual(errs({ ...gsat, reflectors: [{ slot: 'deck+Y', diameterM: 2, boresightBody: [0, 1, 0] }] }), ['reflectors[0].boresightBody：与槽位 deck+Y 的偏置方向近平行'])
  assert.deepStrictEqual(errs({ ...gsat, reflectors: [{ slot: '-X', diameterM: 2, boresightBody: [-1, 0, 0.03] }] }), ['reflectors[0].boresightBody：与槽位 -X 的偏置方向近平行'], '近平行（< 2.9°）同样拒绝')
  assert.deepStrictEqual(errs({ ...gsat, reflectors: [{ slot: '+X', diameterM: 2, offsetDirBody: [0, 0, 2] }] }), ['reflectors[0].offsetDirBody：与视轴近平行'])
  assert.ok(validateSpec({ ...gsat, reflectors: [{ slot: '+X', diameterM: 2, boresightBody: [1, 0, 0], offsetDirBody: [0, 0, -1] }] }).ok, '显式给了不平行的偏置方向就放行')
  // 审查点名的两条文案
  const five = errs({ ...gsat, reflectors: [1, 2, 3, 4, 5].map(() => ({ mount: 'side', diameterM: 1.5 })) })
  assert.deepStrictEqual(five, ['reflectors[4].slot：槽位 +X 重复'])
  assert.deepStrictEqual(errs({ ...cs, wings: [{ side: '+Y', panels: 1, panelHM: 0.3, panelWM: 0.1 }] }), ['wings：立方星不支持'])
  // 文案不带括注 / 教学从句
  for (const e of [...five, ...errs({ ...gsat, bus: { ...gsat.bus, shape: 'hex' } })]) assert.ok(!/[（(]/.test(e), `文案带括注：${e}`)
  assert.throws(() => buildParamModel({ ...gsat, reflectors: [{ slot: '+X', diameterM: 2, boresightBody: [1, 0, 0] }] }), (e) => e.code === 'SPEC_INVALID')
})

t('出口兜底：生成结果含非有限数时抛 SPEC_INVALID（校验放行的极端尺寸）', () => {
  const g = templateSpec('generic').spec
  const huge = { ...g, bus: { ...g.bus, xM: 1e308 } }
  assert.ok(validateSpec(huge).ok, '前提：校验本身放行')
  assert.throws(() => buildParamModel(huge), (e) => e.code === 'SPEC_INVALID' && /非有限数/.test(e.message) && e.errors.length === 1)
})

// ───────── ⑦ 模板数据纪律 / 缺口口径 ─────────

t('模板字段：非空值必须带出处（结构属性除外）；fieldGaps 指向的都是空值；代表星写进 source', () => {
  for (const id of TEMPLATE_IDS) {
    const tpl = TEMPLATES[id]
    for (const [k, f] of Object.entries(tpl.fields)) {
      assert.ok('value' in f && 'unit' in f && 'source' in f && 'url' in f, `${id}.${k} 须为 {value, unit, source, url}`)
      if (f.value !== null && !f.source) assert.ok(/结构/.test(f.note || ''), `${id}.${k} 有值无出处`)
      if (f.value === null) assert.ok(f.note, `${id}.${k} 空值须写原因`)
      if (f.url) assert.match(f.url, /^https?:\/\/\S+$/, `${id}.${k} url 须为纯链接`)
      if (f.rep) assert.equal(f.source, `代表星 ${f.rep}：${f.url}`, `${id}.${k} 代表星写进 source`)
    }
    for (const p of tpl.fieldGaps) {
      const [a, b] = p.split('.')
      const f = tpl.fields[a]
      assert.ok(f, `${id} fieldGaps 路径 ${p}`)
      const v = b ? (f.value ? f.value[b] : null) : f.value
      assert.ok(v === null || v === undefined, `${id} fieldGaps ${p} 应为空（得到 ${JSON.stringify(v)}）`)
    }
    assert.equal(tpl.fieldGaps.length > 0, tpl.needsInput.length > 0, `${id} 有数据缺口 ⇔ 有 needsInput`)
  }
  // 布局类参数取自代表星的，source 里点名
  assert.match(TEMPLATES.ssl1300.fields.reflectors.source, /^代表星 TerreStar-1：https:/)
  assert.match(TEMPLATES.eurostar3000.fields.reflectors.source, /^代表星 Inmarsat-4：https:/)
  assert.match(TEMPLATES.spacebus4000.fields.spanM.source, /^代表星 Eutelsat W3B：/)
  const e3 = templateSpec('eurostar3000')
  assert.equal(e3.specSources.reflectors.rep, 'Inmarsat-4'); assert.match(e3.specSources.reflectors.url, /^https:/)
  // 平台通用指标不带代表星前缀（SB4000 的板数取自平台综述，不是某颗星）
  const sb = templateSpec('spacebus4000')
  assert.equal(sb.specSources['wings[*].panels'].source, 'https://www.engineering.org.cn/engi/CN/10.1016/j.eng.2022.04.013')
  assert.equal(sb.specSources['wings[*].panels'].rep, null)
  // 默认卫星整模板是示意外形：有值的字段出处一律 illustrative、不带链接 / 代表星；补位与轭长同样标示意
  for (const [k, f] of Object.entries(TEMPLATES[DEFAULT_TEMPLATE_ID].fields)) assert.ok(f.value === null || (f.source === 'illustrative' && f.url === null && !f.rep), `default-sat.${k} 须为示意值`)
  const d = templateSpec(DEFAULT_TEMPLATE_ID)
  assert.equal(d.specSources['bus.xM'].kind, 'illustrative')
  assert.equal(d.specSources['wings[*].panelHM'].kind, 'illustrative')
  assert.equal(d.specSources['wings[*].yokeLenM'].kind, 'illustrative')
  assert.equal(sb.specSources['wings[*].yokeLenM'].kind, 'derived', '有出处跨度 → 反推轭长')
  near(sb.spec.wings[0].yokeLenM, (34 - 2.2) / 2 - DETAIL_PRESETS.geo.sadaLenM - 4 * 3.66 - 3 * DETAIL_PRESETS.geo.gapM, 1e-3, 'SB4000 轭长')
  assert.equal(e3.spec.wings[0].panels, 4, 'E3000 按 Y1A 跨度反推 L 型 4 块')
  assert.equal(e3.spec.wings[0].panelHM, 3.915)
  const r = buildTemplateModel('spacebus4000')
  near(r.bboxBody.max[1] - r.bboxBody.min[1], 34, 1e-6, 'SB4000 跨度复现 W3B 34 m')
  const e = buildTemplateModel('eurostar3000')
  near(e.bboxBody.max[1] - e.bboxBody.min[1], 39.4, 1e-6, 'E3000 跨度复现 Y1A 39.4 m')
})

t('缺口口径：needsInput = fill:"none" 那份 spec 的 validateSpec().missing；illustrative ⊇ needsInput；fill 档可生成', () => {
  const sorted = (a) => [...a].sort()
  for (const id of TEMPLATE_IDS) {
    const none = templateSpec(id, { fill: 'none' }), fill = templateSpec(id)
    assert.deepStrictEqual(sorted(validateSpec(none.spec).missing), sorted(none.needsInput), `${id} missing = needsInput`)
    assert.deepStrictEqual(validateSpec(none.spec).errors, [], `${id} none 档只缺不错`)
    assert.deepStrictEqual(TEMPLATES[id].needsInput, none.needsInput, `${id} 缓存一致`)
    assert.deepStrictEqual(fill.needsInput, none.needsInput, `${id} 两档 needsInput 相同`)
    assert.deepStrictEqual(none.illustrative, [], `${id} none 档无示意值`)
    for (const p of none.needsInput) assert.ok(fill.illustrative.includes(p), `${id} ${p} 在 fill 档被示意值补上`)
    assert.ok(validateSpec(fill.spec).ok, `${id} fill 档可生成`)
    // illustrative 的每条路径都在 spec 里有值、且 specSources（下标换 [*]）标成示意
    for (const p of fill.illustrative) {
      const key = p.replace(/\[\d+\]/g, '[*]')
      assert.equal(fill.specSources[key]?.kind, 'illustrative', `${id} ${p} 出处标示意`)
    }
    // 生成页「加翼 / 加反射面」的初值
    assert.ok(fill.itemDefaults.reflector && 'diameterM' in fill.itemDefaults.reflector, `${id} itemDefaults.reflector`)
    assert.equal(fill.itemDefaults.wing === null, TEMPLATES[id].layout === 'cubesat', `${id} itemDefaults.wing`)
  }
  // 审查复现：反射面缺数据的模板在 none 档必须报缺（旧实现永远进不了 missing）
  assert.deepStrictEqual(templateSpec('default-sat', { fill: 'none' }).needsInput, ['bus.xM', 'bus.yM', 'bus.zM', 'wings', 'reflectors'])
  for (const id of ['default-sat', 'spacebus4000']) assert.ok(validateSpec(templateSpec(id, { fill: 'none' }).spec).missing.includes('reflectors'), `${id} 反射面报缺`)
  assert.deepStrictEqual(templateSpec('ssl1300', { fill: 'none' }).needsInput, ['wings'])
  assert.deepStrictEqual(templateSpec('flat-leo', { fill: 'none' }).needsInput, ['bus.zM', 'wings[0].panels'])
  // 用户只把平台体与翼补上、反射面仍空 → 仍然不能生成（旧实现这里放行，生成出一颗没有反射面的星）
  const d = templateSpec('default-sat', { fill: 'none' })
  const withWings = { ...d.spec, bus: { ...d.spec.bus, xM: 2.36, yM: 2.1, zM: 3.6 }, wings: ['+Y', '-Y'].map((side) => ({ side, ...d.itemDefaults.wing })) }
  assert.deepStrictEqual(validateSpec(withWings).missing, ['reflectors'])
  // 加一副空白反射面 → 报条目路径；填上口径 → 可生成
  const withBlank = { ...withWings, reflectors: [{ ...d.itemDefaults.reflector }] }
  assert.deepStrictEqual(validateSpec(withBlank).missing, ['reflectors[0].diameterM'])
  withBlank.reflectors[0].diameterM = 2.2
  assert.ok(validateSpec(withBlank).ok)
  assert.equal(buildParamModel(withBlank).parts.filter((p) => p.role === 'reflector').length, 1)
  // SSL-1300：翼数未知 → 加翼后条目字段（板数 / 板尺寸）继续报缺
  const ssl = templateSpec('ssl1300', { fill: 'none' })
  const sslW = { ...ssl.spec, wings: [{ side: '+Y', ...ssl.itemDefaults.wing }] }
  assert.deepStrictEqual(validateSpec(sslW).missing, ['wings[0].panels', 'wings[0].panelHM', 'wings[0].panelWM'])
  // 审查点名的 illustrative 写法：默认卫星 fill 档
  assert.deepStrictEqual(templateSpec('default-sat').illustrative, ['bus.xM', 'bus.yM', 'bus.zM', 'wings', 'reflectors', 'reflectors[0].diameterM', 'reflectors[1].diameterM', 'reflectors[2].diameterM', 'reflectors[3].diameterM'])
  assert.deepStrictEqual(templateSpec('spacebus4000').illustrative, ['wings', 'reflectors'], 'SB4000 反射面口径有出处，只有数量是示意')
  assert.deepStrictEqual(templateCatalog().find((c) => c.templateId === 'default-sat').needsInput, TEMPLATES['default-sat'].needsInput)
})

t('fill:"none" → buildParamModel 抛 SPEC_INVALID；非法值给 errors 而非 missing', () => {
  const d = templateSpec('default-sat', { fill: 'none' })
  assert.throws(() => buildParamModel(d.spec), (e) => e.code === 'SPEC_INVALID' && e.missing.includes('bus.xM') && e.missing.includes('wings') && e.missing.includes('reflectors'))
  const e4 = templateSpec('dfh4e', { fill: 'none' })          // 旧 id 别名
  assert.ok(validateSpec(e4.spec).missing.includes('bus.xM'))
  const bad = normalizeSpec(templateSpec('generic').spec); bad.wings[0].panels = 0
  assert.ok(validateSpec(bad).errors.some((x) => x.startsWith('wings[0].panels')))
  assert.ok(validateSpec({ ...bad, reflectors: 'x' }).errors.includes('reflectors：须为数组'))
})

t('立方星：CDS 尺寸复现、四根导轨贯通全长、展开板选项、塔馈反射面让出贴片天线', () => {
  const r = buildTemplateModel('cubesat-3u')
  const bb = r.bboxBody
  nearV(sub(bb.max, bb.min), [0.1, 0.1, 0.3405], 1e-9, '3U 包络 100×100×340.5 mm')
  assert.ok(r.ir.nodes.some((x) => x.name === 'patch_antenna'))
  const s = templateSpec('cubesat-6u').spec; s.cubesat.deployPanels = 2
  const d = buildParamModel(s)
  assert.equal(d.solarPanelGroups.length, 3, '体装 + 两翼')
  assert.equal(d.articulations.length, 0, '立方星展开板无 SADA，不设关节')
  near(d.bboxBody.max[1] - d.bboxBody.min[1], 0.2263 + 2 * (0.366 - 2 * DETAIL_PRESETS.cubesat.railFootM), 1e-9, '6U 展开跨度')
  const dk = buildParamModel({ ...templateSpec('cubesat-6u').spec, reflectors: [{ mount: 'deck', diameterM: 0.5 }] })
  assert.ok(!dk.ir.nodes.some((x) => x.name === 'patch_antenna') && dk.ir.nodes.some((x) => x.name === 'antenna_tower'), '对地面中心让给天线塔')
  assert.equal(matByNode(dk.ir, nodeByName(dk.ir, 'reflector_1')).key, 'reflector_mesh', '0.5 m > 立方星档 meshAboveDM → 网状')
})

// ───────── ⑧ 默认卫星 / 目录撤下中国平台模板（2026-09-24） ─────────

// 原 dfh4e 模板两档 spec（撤下前由 templateSpec('dfh4e') 逐字段导出；template / name 两个记录字段不参与几何，另比）。
// 导出时核过：两份去掉 template / name 后的 specHash 与撤下前的原模板相同（fill 档 949cffb8062993c8、none 档 02852a1beb3b6138），
// 生成几何摘要（IR 网格逐字节 + 节点 / 挂点 / 关节 / 太阳翼组 / 质量特性 / 部件 / 包围盒）3b40967f66f46f10a2fd763628e9523e 相同。
const ORIG_DFH4E_FILL = {
  layout: 'geo', detailPreset: 'geo', massTargetKg: 5550,
  bus: { shape: 'box', xM: 2.36, yM: 2.1, zM: 3.6, mli: 'mli_gold', massKg: null },
  wings: ['+Y', '-Y'].map((side) => ({ side, panels: 4, panelHM: 3.3, panelWM: 2.36, sidePanels: 0, yokeLenM: 2.5, gapM: 0.05, tiltDeg: 0, axis: 'y' })),
  reflectors: [
    { slot: '+X', mount: 'side', diameterM: 2.5, focalM: 2, offsetHM: null, posBody: null, boresightBody: [0, 0, 1], feedType: 'horn', mesh: false, shaped: false },
    { slot: '-X', mount: 'side', diameterM: 2.5, focalM: 2, offsetHM: null, posBody: null, boresightBody: [0, 0, 1], feedType: 'horn', mesh: false, shaped: false },
    { slot: 'deck+Y', mount: 'deck', diameterM: 1.2, focalM: 0.96, offsetHM: null, posBody: null, boresightBody: [0, 0, 1], feedType: 'horn', mesh: false, shaped: false },
    { slot: 'deck-Y', mount: 'deck', diameterM: 1.2, focalM: 0.96, offsetHM: null, posBody: null, boresightBody: [0, 0, 1], feedType: 'horn', mesh: false, shaped: false }
  ],
  detail: { mli: true, radiators: true, thrusters: true, adapter: true, deckHorns: 3 }
}
const ORIG_DFH4E_NONE = {
  layout: 'geo', detailPreset: 'geo', massTargetKg: 5550,
  bus: { shape: 'box', xM: null, yM: null, zM: null, mli: 'mli_gold', massKg: null },
  wings: null, reflectors: null,
  detail: { mli: true, radiators: true, thrusters: true, adapter: true, deckHorns: 3 }
}
const noRec = (sp) => { const o = clone(sp); delete o.template; delete o.name; return o }

t('目录无中国平台模板：列表 / 条目 / 两档 spec / 出处 / 密度表文字都不含中国平台字样；默认卫星排第一', () => {
  for (const c of templateCatalog()) {
    for (const x of [c.id, c.templateId, c.title, c.titleZh, ...c.aliases, c.source.credit]) assert.ok(!/dfh|东方红|DFH|中国|China/i.test(x), `目录条目 ${c.id}：${x}`)
  }
  assert.ok(!TEMPLATE_IDS.some((id) => /dfh/i.test(id)), 'TEMPLATE_IDS')
  assert.ok(!Object.keys(TEMPLATES).some((id) => /dfh/i.test(id)), 'TEMPLATES')
  const BAD = /dfh|东方红|东四|东五|中国|china|亚太|apstar|实践|中星|空间技术研究院|cgwic|astronautix/i
  const texts = [['catalog', JSON.stringify(templateCatalog())], ['TEMPLATES', JSON.stringify(TEMPLATES)], ['DENSITY', JSON.stringify(DENSITY)]]
  for (const id of TEMPLATE_IDS) {
    for (const fill of ['illustrative', 'none']) texts.push([`${id}/${fill}`, JSON.stringify(templateSpec(id, { fill }))])
    const r = buildTemplateModel(id)
    texts.push([`${id}/build`, JSON.stringify({ template: r.template, warnings: r.warnings, spec: r.spec })])
  }
  for (const [k, x] of texts) { const m = x.match(BAD) || x.match(/CAST/); assert.equal(m, null, `${k} 含「${m && m[0]}」`) }
  assert.equal(TEMPLATE_IDS[0], DEFAULT_TEMPLATE_ID)
  assert.equal(DEFAULT_MODEL_ID, 'param:default-sat')
  const c = templateCatalog().find((x) => x.templateId === DEFAULT_TEMPLATE_ID)
  assert.equal(c.id, DEFAULT_MODEL_ID); assert.equal(c.titleZh, '默认卫星'); assert.equal(c.title, 'Default satellite'); assert.equal(c.fidelity, 'parametric')
  assert.ok(c.tags.includes('geo') && c.tags.includes('comsat'))
  assert.equal(c.source.credit, '卫星仿真平台参数化生成')
})

t('旧模板 id 静默别名：dfh4 / dfh4e / dfh5（及 param: 前缀）一律解析到 default-sat，所有入口都认、任何列表都不列', () => {
  const cur = { fill: templateSpec('default-sat'), none: templateSpec('default-sat', { fill: 'none' }), model: buildTemplateModel('default-sat') }
  for (const old of ['dfh4', 'dfh4e', 'dfh5']) {
    assert.equal(resolveTemplateId(old), 'default-sat'); assert.ok(isTemplateId(old))
    assert.equal(resolveParamModelId(`param:${old}`), 'param:default-sat')
    assert.ok(!Object.hasOwn(TEMPLATES, old) && !TEMPLATE_IDS.includes(old) && !templateCatalog().some((c) => c.templateId === old))
    assert.deepStrictEqual(templateSpec(old), cur.fill, `${old} fill 档`)
    assert.deepStrictEqual(templateSpec(old, { fill: 'none' }), cur.none, `${old} none 档`)
    const r = buildTemplateModel(old)
    assert.equal(r.template.id, 'default-sat'); assert.equal(r.template.titleZh, '默认卫星'); assert.equal(r.spec.template, 'default-sat')
    assert.equal(r.specHash, cur.model.specHash)
    // 老 spec 里记的源模板 id 归一成现行 id：同参数的老 spec 与现模板 spec 拿到同一个 param:<hash>
    const oldSpec = { ...cur.fill.spec, template: old }
    assert.equal(normalizeSpec(oldSpec).template, 'default-sat')
    assert.equal(paramModelIdForSpec(oldSpec), paramModelIdForSpec(cur.fill.spec))
  }
  for (const id of ['param:default-sat', 'param:ssl1300', 'param:0123456789ab', 'nasa:terra', 'dfh4']) assert.equal(resolveParamModelId(id), id)
  assert.equal(resolveParamModelId(null), null)
  for (const x of ['nope', 'toString', '', null, undefined, 42]) { assert.equal(resolveTemplateId(x), null, String(x)); assert.ok(!isTemplateId(x)) }
  assert.equal(normalizeSpec({ template: 'gen:x' }).template, 'gen:x', '未知来源原样留')
  assert.equal(templateSpec('nope').spec, null)
  assert.throws(() => buildTemplateModel('nope'), (e) => e.code === 'NO_TEMPLATE')
})

t('default-sat = 原 dfh4e：两档 spec 逐字段相同；生成几何逐位相同（IR 含 TypedArray、挂点、关节、太阳翼组、质量特性、部件、包围盒）', () => {
  const fill = templateSpec('default-sat'), none = templateSpec('default-sat', { fill: 'none' })
  assert.deepStrictEqual(noRec(fill.spec), ORIG_DFH4E_FILL, 'fill 档 spec')
  assert.deepStrictEqual(noRec(none.spec), ORIG_DFH4E_NONE, 'none 档 spec')
  assert.equal(fill.spec.template, 'default-sat'); assert.equal(fill.spec.name, '默认卫星')
  assert.deepStrictEqual(none.needsInput, ['bus.xM', 'bus.yM', 'bus.zM', 'wings', 'reflectors'], 'needsInput 同原模板')
  const a = buildTemplateModel('default-sat')
  const b = buildParamModel({ ...ORIG_DFH4E_FILL, template: 'dfh4e', name: 'DFH-4E' })
  assert.deepStrictEqual(a.ir, b.ir, 'IR')
  for (const k of ['attachPoints', 'articulations', 'solarPanelGroups', 'massProps', 'parts', 'frame', 'bboxBody', 'boundingRadiusM', 'specOriginBody', 'warnings']) assert.deepStrictEqual(a[k], b[k], k)
  // 两份 spec 只差记录字段 name（template 归一后同为 default-sat）
  assert.equal(specHash({ ...b.spec, name: a.spec.name }), a.specHash)
  near(a.massProps.massKg, 5550, 1e-6, '整星估算质量')
})

console.log(`modelParamBus: ${n} 项通过`)
