// 按部件类型赋密度的质量特性估算（packages/core/models/partMass.mjs，2026-10 专业度审查 P0-1 / P0-2）单测。
// 拿参数化整星当「标准答案」：生成器的部件划分与真值质量特性都已知，把它的 IR 当导入件喂进去——
// ① 质心误差：新口径对全部 GEO / LEO / 小卫星 / 立方星模板 ≤ 0.35 m，且对旧口径（面积形心）误差大的那几颗显著变小
//    （SSL-1300 旧 5.13 m、平板 LEO 旧 3.69 m、E3000 旧 1.25 m，与审查实测吻合）；
// ② 惯量：主惯量与真值相对误差 ≤ 45 %（旧口径对不闭合网格根本给不出惯量）；
// ③ 总质量缩放到给定值；不给总质量按名义密度；
// ④ 组件档单位质量惯量：× 质量后与估算逐件一致；部件归属按节点名 / 实例内三角形区间，未归属三角形并成「其余」。
// 不联网。

import assert from 'node:assert/strict'
import { estimateByParts, partInertiaPerKg, partGeometry } from '../models/partMass.mjs'
import { estimateMassProps, principalInertia } from '../models/massProps.mjs'
import { buildParamModel } from '../models/paramBus.mjs'
import { templateSpec } from '../models/paramTemplates.mjs'
import { nodeWorldMatrices } from '../models/ir.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const mul4 = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o }
const invRigid = (m) => { const o = new Array(16).fill(0); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[4 * c + r] = m[4 * r + c]; for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14]); o[15] = 1; return o }
/** IR 实例 → 本体系（根节点矩阵是本体 → 模型轴，乘它的逆；与分析 Worker 的 bodyMatrix 同一口径） */
function instOf(ir) {
  const W = nodeWorldMatrices(ir), out = [], toBody = invRigid(ir.nodes[0].matrix)
  ir.nodes.forEach((nd, i) => { if (Number.isInteger(nd.mesh) && ir.meshes[nd.mesh] && W[i]) out.push({ node: nd.name, position: ir.meshes[nd.mesh].position, index: ir.meshes[nd.mesh].index || null, matrix: mul4(toBody, W[i]) }) })
  return out
}
const CASES = {}
for (const id of ['default-sat', 'ssl1300', 'flat-leo', 'eurostar3000', 'spacebus4000', 'generic', 'cubesat-6u']) {
  const r = buildParamModel(templateSpec(id).spec)
  CASES[id] = { r, inst: instOf(r.ir) }
}

t('质心：新口径 ≤ 0.35 m；旧口径（面积形心）误差大的几颗显著变小', () => {
  for (const [id, c] of Object.entries(CASES)) {
    const truth = c.r.massProps
    const est = estimateByParts({ instances: c.inst, parts: c.r.parts, massKg: truth.massKg })
    const e = dist(est.comBody, truth.comBody)
    assert.ok(e <= 0.35, `${id} 质心误差 ${e.toFixed(3)} m`)
    const old = estimateMassProps({ meshes: c.inst, massKg: truth.massKg })
    const eo = dist(old.comBody, truth.comBody)
    if (eo > 1) assert.ok(e < eo / 4, `${id} 新 ${e.toFixed(3)} vs 旧 ${eo.toFixed(3)}`)
  }
})

t('惯量：主惯量与真值相对误差 ≤ 45 %，且三个都给得出', () => {
  for (const [id, c] of Object.entries(CASES)) {
    const truth = c.r.massProps
    const est = estimateByParts({ instances: c.inst, parts: c.r.parts, massKg: truth.massKg })
    assert.ok(Array.isArray(est.inertiaBody), id)
    const a = principalInertia(truth.inertiaBody).moments, b = principalInertia(est.inertiaBody).moments
    for (let k = 0; k < 3; k++) {
      if (a[k] < 1e-3) continue
      const rel = Math.abs(b[k] - a[k]) / a[k]
      assert.ok(rel <= 0.45, `${id} I${k + 1} ${b[k].toFixed(1)} vs ${a[k].toFixed(1)}（${(rel * 100).toFixed(0)} %）`)
    }
  }
})

t('总质量：给定时等比缩放到给定值；不给按名义密度（scale = 1）', () => {
  const c = CASES['default-sat']
  const a = estimateByParts({ instances: c.inst, parts: c.r.parts, massKg: 1234 })
  assert.ok(Math.abs(a.massKg - 1234) < 1e-6)
  const b = estimateByParts({ instances: c.inst, parts: c.r.parts })
  assert.equal(b.scale, 1)
  assert.ok(b.massKg > 1000, '星体 290 kg/m³ 量级')
  // 质心与惯量分布不随总质量变（惯量按比例）
  assert.ok(dist(a.comBody, b.comBody) < 1e-9)
  const k = 1234 / b.massKg
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(a.inertiaBody[i][j] - k * b.inertiaBody[i][j]) <= 1e-6 * Math.abs(a.inertiaBody[0][0]))
})

t('组件档：单位质量惯量 × 质量 = 估算逐件自身惯量；部件 id 对得上', () => {
  const c = CASES['eurostar3000']
  const est = estimateByParts({ instances: c.inst, parts: c.r.parts })
  const jpk = partInertiaPerKg({ instances: c.inst, parts: c.r.parts })
  const by = new Map(jpk.map((x) => [x.id, x]))
  for (const p of est.partsMass) {
    const j = by.get(p.id)
    assert.ok(j, p.id)
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) assert.ok(Math.abs(j.inertiaPerKg[i][k] * p.massKg - p.inertiaCom[i][k]) <= 1e-9 * Math.max(1, Math.abs(p.inertiaCom[0][0])))
  }
})

t('部件归属：整实例按节点名、实例内按三角形区间；未归属的并成「其余」', () => {
  const quad = (z) => ({ position: new Float64Array([0, 0, z, 1, 0, z, 1, 1, z, 0, 1, z]), index: new Uint32Array([0, 1, 2, 0, 2, 3]) })
  const inst = [{ node: 'a', ...quad(0) }, { node: 'b', ...quad(1) }, { node: 'c', ...quad(2) }]
  const g = partGeometry(inst, [{ id: 'P', role: 'solarArray', nodes: ['a'] }, { id: 'Q', role: 'reflector', triRanges: [{ node: 'b', ranges: [[1, 1]] }] }])
  const by = Object.fromEntries(g.map((x) => [x.id, x.index.length / 3]))
  assert.deepEqual(by, { P: 2, Q: 1, '~rest': 3 })
  assert.equal(g.find((x) => x.id === '~rest').role, 'other')
})

console.log(`modelPartMass: ${n} 项通过`)
