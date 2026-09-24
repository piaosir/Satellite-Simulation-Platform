// 工作台「本体轴 · 出厂映射」= 入库时的 q_model2body（src/model/wbLogic.js 的 factoryFrameQ）。
// 裸 node 跑：wbLogic.js 引 packages/core 一律相对路径，不碰 three / vue / DOM。
// 口径（轴映射终案 ②，W17a 报告 ④）：frame.importQ 在就用它；NASA → Q_YUP_ZENITH、STK 本机件 / 参数化件 → Q_STK（只按来源，
// 手加挂点 / 关节不翻）；本机导入 / 社区件 meta 没记带没带 extras.satsim（烘过的 OBJ·STL·FBX / 本工具导出件是 Q_STK，
// 普通 glb / STEP 是 Q_YUP_ZENITH），看当前 q 最近的 90° 基准是哪种缺省；都不是才按 importDefaultQOf（带 AGI → Q_STK）。
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const W = await import(pathToFileURL(path.join(HERE, '../../../src/model/wbLogic.js')).href)
const BF = await import(pathToFileURL(path.join(HERE, '../models/bodyFrame.mjs')).href)
const S = await import(pathToFileURL(path.join(HERE, '../models/schema.mjs')).href)
const { factoryFrameQ, sameRotation } = W
const { Q_STK, Q_YUP_ZENITH, DEFAULT_Q_MODEL2BODY, axisStep, fineRotate } = BF

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error('✗ ' + name); throw e } }
const is = (q, ref, msg) => assert.ok(sameRotation(q, ref, 1e-9), (msg || '') + ' 得到 ' + JSON.stringify(q))
// 非轴向的 q 经归一 / 规范化有浮点误差，acos 在 1 附近放大到 1e-6° 量级：按 1e-4° 比
const near = (q, ref, msg) => assert.ok(sameRotation(q, ref, 1e-4), (msg || '') + ' 得到 ' + JSON.stringify(q))
const AP = [{ name: 'ant1', posBody: [0, 0, 1] }]

t('STK 本机件 → STK 映射', () => {
  is(factoryFrameQ({ id: 'stk:0123456789ab', source: { kind: 'stk-local' } }), Q_STK)
  is(factoryFrameQ({ id: 'stk:0123456789ab' }), Q_STK, 'stk: 前缀缺来源')
})

t('参数化件（模板 / 存库的 param:<hash>）→ STK 映射', () => {
  is(factoryFrameQ({ id: 'param:default-sat', source: { kind: 'param' } }), Q_STK)
  is(factoryFrameQ({ id: 'param:0123456789ab', source: { kind: 'param' } }), Q_STK)
})

t('NASA 件 → +Y 天顶（含随包 builtin 按 nasa: 前缀还原）', () => {
  is(factoryFrameQ({ id: 'nasa:tdrs-d', source: { kind: 'nasa' } }), Q_YUP_ZENITH)
  is(factoryFrameQ({ id: 'nasa:tdrs-d', source: { kind: 'builtin' } }), Q_YUP_ZENITH)
  is(factoryFrameQ({ id: 'nasa:tdrs-d' }), Q_YUP_ZENITH)
})

t('NASA 件手加了挂点 / 关节 / 太阳翼组：仍是 +Y 天顶（importDefaultQOf 原样会判成 STK 映射）', () => {
  const m = { id: 'nasa:tdrs-d', source: { kind: 'nasa' }, attachPoints: AP, articulations: [{ name: 'a', stages: [] }], solarPanelGroups: [{ name: 'g' }] }
  is(factoryFrameQ(m), Q_YUP_ZENITH)
  // （schema.importDefaultQOf 直接对这份 meta 会判成 STK 映射：它把非空挂点当 AGI 扩展。这里不对它断言，schema 以后收紧判据也不牵连本测试）
})

t('普通导入件没有 frame：无 AGI → +Y 天顶；带 AGI 挂点 → STK 映射（与 importDefaultQOf 逐条一致）', () => {
  const plain = { id: 'user:0123456789ab', source: { kind: 'user' } }
  const agi = { id: 'user:0123456789ab', source: { kind: 'user' }, attachPoints: AP }
  is(factoryFrameQ(plain), Q_YUP_ZENITH)
  is(factoryFrameQ(agi), Q_STK)
  for (const m of [plain, agi, { id: 'community:x', source: { kind: 'community' } }]) assert.deepEqual(factoryFrameQ(m), S.importDefaultQOf(m))
})

t('NASA / STK 本机 / 参数化件不看 meta.frame 里现有的 q（只按来源）', () => {
  const fr = (q) => ({ q_model2body: q.slice(), t_model2body: [0, 0, 0], verified: false })
  is(factoryFrameQ({ id: 'nasa:x', source: { kind: 'nasa' }, frame: fr(Q_STK) }), Q_YUP_ZENITH)
  is(factoryFrameQ({ id: 'stk:0123456789ab', source: { kind: 'stk-local' }, frame: fr(Q_YUP_ZENITH) }), Q_STK)
  is(factoryFrameQ({ id: 'param:default-sat', source: { kind: 'param' }, frame: fr(Q_YUP_ZENITH) }), Q_STK)
})

t('烘过的本机导入件（渲染端转的 OBJ / STL / FBX、本工具导出件重新导入）：q = STK 映射、无 AGI → 出厂 = STK 映射', () => {
  // 审查复现：normalizeMeta 之后原先得到 Q_YUP_ZENITH，「出厂映射」一点天底面朝天
  const m = S.normalizeMeta({ id: 'user:0123456789ab', source: { kind: 'user' }, frame: { q_model2body: Q_STK.slice() } })
  is(factoryFrameQ(m), Q_STK)
  assert.ok(sameRotation(m.frame.q_model2body, factoryFrameQ(m), 1e-6), 'isFactory 口径（SecFrame 同一容差）')
  is(factoryFrameQ({ id: 'community:x', source: { kind: 'community' }, frame: { q_model2body: Q_STK.slice() } }), Q_STK, '社区件同口径')
})

t('普通 glb 手加挂点 / 关节：q = +Y 天顶 → 出厂仍是 +Y 天顶（不因「像带 AGI」翻成 STK 映射）', () => {
  const m = S.normalizeMeta({ id: 'user:0123456789ab', source: { kind: 'user' }, frame: { q_model2body: Q_YUP_ZENITH.slice() }, attachPoints: AP, articulations: [{ name: 'a', stages: [] }] })
  assert.ok(m.attachPoints.length > 0, '挂点经 normalizeMeta 留下')
  is(factoryFrameQ(m), Q_YUP_ZENITH)
})

t('微调过（相对最近 90° 基准的滚转 / 俯仰 / 偏航）：出厂 = 那个基准', () => {
  const user = (q, extra) => ({ id: 'user:0123456789ab', source: { kind: 'user' }, frame: { q_model2body: q }, ...extra })
  is(factoryFrameQ(user(fineRotate(Q_STK, 3, -2, 5))), Q_STK)
  is(factoryFrameQ(user(fineRotate(Q_YUP_ZENITH, -4, 1, 30), { attachPoints: AP })), Q_YUP_ZENITH)
})

t('点过 ±90° 步进（基准不是两种缺省之一）：回到 importDefaultQOf —— 无 AGI → +Y 天顶，带 AGI → STK 映射', () => {
  for (const [axis, deg] of [['x', 90], ['y', -90], ['z', 90]]) {
    const q = axisStep(Q_STK, axis, deg)
    assert.ok(!sameRotation(q, Q_STK, 1) && !sameRotation(q, Q_YUP_ZENITH, 1), '步进后不是两种缺省之一')
    const plain = { id: 'user:0123456789ab', source: { kind: 'user' }, frame: { q_model2body: q } }
    is(factoryFrameQ(plain), Q_YUP_ZENITH)
    is(factoryFrameQ({ ...plain, attachPoints: AP }), Q_STK)
  }
})

t('frame.importQ（入库时记下的缺省）在就优先，来源不论；模长不对 / 形状不对的忽略', () => {
  const qCal = fineRotate(Q_YUP_ZENITH, 0, 0, 90)   // 核定过的 NASA 件：不是两种缺省之一
  near(factoryFrameQ({ id: 'nasa:x', source: { kind: 'nasa' }, frame: { q_model2body: qCal, importQ: qCal } }), qCal)
  assert.ok(!sameRotation(qCal, Q_STK, 1) && !sameRotation(qCal, Q_YUP_ZENITH, 1))
  is(factoryFrameQ({ id: 'user:0123456789ab', source: { kind: 'user' }, frame: { q_model2body: Q_YUP_ZENITH.slice(), importQ: Q_STK.slice() } }), Q_STK)
  is(factoryFrameQ({ id: 'user:0123456789ab', source: { kind: 'user' }, frame: { q_model2body: Q_STK.slice(), importQ: Q_STK.map((v) => v * 1.02) } }), Q_STK, '近单位长照用（归一）')
  is(factoryFrameQ({ id: 'nasa:x', source: { kind: 'nasa' }, frame: { importQ: [0, 0, 0, 5] } }), Q_YUP_ZENITH, '模长 5 忽略')
  is(factoryFrameQ({ id: 'nasa:x', source: { kind: 'nasa' }, frame: { importQ: [0, 0, 1] } }), Q_YUP_ZENITH, '三元忽略')
  is(factoryFrameQ({ id: 'nasa:x', source: { kind: 'nasa' }, frame: { importQ: [0, 0, 0, NaN] } }), Q_YUP_ZENITH, 'NaN 忽略')
})

t('坏输入不抛：null / 非对象 → 出厂 STK 映射（DEFAULT_Q_MODEL2BODY）；返回新数组', () => {
  is(factoryFrameQ(null), DEFAULT_Q_MODEL2BODY)
  is(factoryFrameQ(42), DEFAULT_Q_MODEL2BODY)
  const a = factoryFrameQ({ id: 'nasa:x' }), b = factoryFrameQ({ id: 'nasa:x' })
  assert.notEqual(a, b); a[0] = 99; is(factoryFrameQ({ id: 'nasa:x' }), Q_YUP_ZENITH)
})

console.log(`modelWbFrame: ${n} 项通过`)
