// 装配属性面板 / 功能区的纯逻辑单测（2026-10-06 设计页交互重构任务书 §3.3.3，EDITOR-B）：
//   ① 平移步长偏好迁移（新装缺省「自动」、老偏好保持、moveSet 标志位）与步长读数；
//   ② 「安装」节数值补丁（偏移 / 倾角）、锚点读数、自由件锚系位姿换分量；
//   ③ 「自动」步长的基准（面安装 / 接口所在面 / 父件包围盒短边）与内核 autoGridStep 同式；
//   ④ 悬停里的放置键位（Tab / B / Alt / Q / E / Shift / 右键 / Esc）；
//   ⑤ 面板写入路径（setAttach 带 off / tilt，经 asmSnap.applyCmd）：法向偏移 0.2 m + 倾角 15° 后改父件尺寸 → 子件跟随；
//      先偏移后改滚转 → 安装点世界位置不变；面安装件的面内偏移恒 0。
// 裸 node 跑：asmLogic.js 只 import packages/core（相对路径）。
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(path.join(HERE, p)).href)
const L = await imp('../../../src/model/asmLogic.js')
const S = await imp('../models/asmSnap.mjs')
const A = await imp('../models/assembly.mjs')

let n = 0
const ok = (name, fn) => { try { fn() } catch (e) { console.error('✗ ' + name); throw e } n++ }
const near = (a, b, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≠ ${b}`)
const nearV = (a, b, tol = 1e-9, msg = '') => { assert.equal(a.length, b.length, msg); a.forEach((x, i) => near(x, b[i], tol, msg + '[' + i + ']')) }

// ─────────────────────────── ① 平移步长偏好 ───────────────────────────
ok('平移步长：新装缺省「自动」；老偏好无标志时 0.05（旧出厂）→ 自动、改过的保持；手动选过（moveSet）按所选', () => {
  assert.equal(L.UI_DEFAULTS.snap.move, 'auto')
  assert.equal(L.UI_DEFAULTS.snap.moveSet, false)
  const cases = [
    [null, 'auto', false],
    [{ snap: { move: 0.05 } }, 'auto', false],          // 老用户、从未显式设置（等于旧出厂值）
    [{ snap: { move: 0.1 } }, 0.1, true],               // 老用户改过 → 保持
    [{ snap: { move: 0.5, on: false } }, 0.5, true],
    [{ snap: { move: 0.05, moveSet: true } }, 0.05, true],   // 手动选过旧出厂值 → 保持
    [{ snap: { move: 'auto', moveSet: true } }, 'auto', true],
    [{ snap: { move: 0.07, moveSet: true } }, 'auto', false], // 坏值 → 出厂
    [{ snap: { move: 'auto' } }, 'auto', false],
    [{ snap: { move: '0.1' } }, 'auto', false]
  ]
  for (const [raw, move, set] of cases) {
    const s = L.sanitizeUi(raw).snap
    assert.equal(s.move, move, JSON.stringify(raw))
    assert.equal(s.moveSet, set, JSON.stringify(raw))
  }
  // 往返稳定：清洗结果再清洗一次不变
  for (const [raw] of cases) { const a = L.sanitizeUi(raw); assert.deepEqual(L.sanitizeUi(JSON.parse(JSON.stringify(a))), a) }
  for (const v of S.MOVE_STEP_OPTS) assert.equal(L.sanitizeUi({ snap: { move: v, moveSet: true } }).snap.move, v)
})
ok('步长显示：「自动」/「0.05 m」；读数三位有效、不出科学计数法', () => {
  assert.equal(L.moveStepLabel('auto'), '自动')
  assert.equal(L.moveStepLabel(0.05), '0.05 m')
  assert.deepEqual(S.MOVE_STEP_OPTS.map(L.moveStepLabel), ['自动', '0.01 m', '0.05 m', '0.1 m', '0.5 m'])
  assert.equal(L.fmtStep(0.002), '0.002 m')
  assert.equal(L.fmtStep(0.1), '0.1 m')
  assert.equal(L.fmtStep(1), '1 m')
  assert.equal(L.fmtStep(null), '')
  assert.equal(L.fmtStep(0), '')
})

// ─────────────────────────── ② 数值补丁 / 锚点 / 锚系位姿 ───────────────────────────
ok('偏移补丁：接口件三分量各自改；面安装件面内两分量恒 0；−0 记 0；坏值补 0', () => {
  assert.deepEqual(L.offAxesOf('socket'), [0, 1, 2])
  assert.deepEqual(L.offAxesOf('surface'), [2])
  assert.deepEqual(L.offAxesOf('free'), [])
  const sock = { mode: 'socket', off: [0.1, 0.2, 0.3] }
  assert.deepEqual(L.offPatch(sock, 1, -0.5), { off: [0.1, -0.5, 0.3] })
  assert.deepEqual(L.offPatch(sock, 2, -0), { off: [0.1, 0.2, 0] })
  assert.ok(!Object.is(L.offPatch(sock, 2, -0).off[2], -0))
  assert.deepEqual(L.offPatch({ mode: 'surface', off: [0.1, 0.2, 0.3] }, 2, 0.2), { off: [0, 0, 0.2] })
  assert.deepEqual(L.offPatch({ mode: 'socket' }, 0, 0.4), { off: [0.4, 0, 0] }, '旧文档没有 off')
  assert.deepEqual(L.offPatch({ mode: 'socket', off: 'x' }, 0, NaN), { off: [0, 0, 0] })
  assert.deepEqual(L.offOf(null), [0, 0, 0])
  assert.deepEqual(L.tiltOf({ tilt: [5, -0] }), [5, 0])
})
ok('倾角补丁：t0 夹在 ±90°、t1 不夹；另一轴原样', () => {
  const a = { mode: 'surface', tilt: [10, 20] }
  assert.deepEqual(L.tiltPatch(a, 0, 15), { tilt: [15, 20] })
  assert.deepEqual(L.tiltPatch(a, 0, 120), { tilt: [90, 20] })
  assert.deepEqual(L.tiltPatch(a, 0, -95), { tilt: [-90, 20] })
  assert.deepEqual(L.tiltPatch(a, 1, 170), { tilt: [10, 170] })
  assert.deepEqual(L.tiltPatch({}, 1, 5), { tilt: [0, 5] })
  assert.equal(L.attachMergeKey('rcs1', 'off'), 'rcs1|attach.off')
  assert.notEqual(L.attachMergeKey('rcs1', 'off'), L.attachMergeKey('rcs1', 'tilt'))
})
ok('锚点读数：接口锚 / 面锚（含 u v）/ 无锚；与解算同口径（socket 键优先，方式互斥）', () => {
  assert.deepEqual(L.anchorOf({ mode: 'free', socket: 'focus', face: null }), { kind: 'socket', id: 'focus', label: '焦点' })
  assert.deepEqual(L.anchorOf({ mode: 'free', socket: null, face: '-Z', uv: [1.03, -0.9] }), { kind: 'face', id: '-Z', label: '-Z', uv: [1.03, -0.9] })
  assert.deepEqual(L.anchorOf({ mode: 'free', face: 'top', uv: null }), { kind: 'face', id: 'top', label: '顶面', uv: [0, 0] })
  assert.equal(L.anchorOf({ mode: 'free', socket: null, face: null }), null)
  assert.equal(L.anchorOf(null), null)
  assert.equal(L.optText('焦点', 'focus'), '焦点 · focus')
  assert.equal(L.optText('接口 +X', '+X'), '接口 +X')
  assert.equal(L.optText('面心 +Z', '@+Z'), '面心 +Z · @+Z')
})
ok('锚系位姿换分量：改平移 q 逐位不动、改欧拉角 t 逐位不动；读数回到所设值', () => {
  const t = [0.12, -0.3, 0.05], q = [0.1, 0.2, -0.3, 0.927]
  const qn = Math.hypot(...q); const q1 = q.map((x) => x / qn)
  const r0 = L.tqReadout(t, q1)
  for (let k = 0; k < 6; k++) {
    const v = k < 3 ? 0.75 - k * 0.1 : (k - 3) * 20 - 25
    const r = L.tqWith(t, q1, k, v)
    if (k < 3) assert.deepEqual(r.q, q1, 'q 不动')
    else assert.deepEqual(r.t, t, 't 不动')
    const rr = L.tqReadout(r.t, r.q)
    const want = [...r0.t, ...r0.rpy]; want[k] = v
    nearV([...rr.t, ...rr.rpy], want, 1e-8, 'k' + k)
  }
  assert.deepEqual(L.tqReadout(null, null), { t: [0, 0, 0], rpy: [0, 0, 0] })
})

// ─────────────────────────── ③ 「自动」步长基准 ───────────────────────────
const BUS = { id: 'bus', type: 'sat.bus.box', parent: null, params: { xM: 2, yM: 1.6, zM: 3 } }
const DOC = {
  kind: 'assembly', domain: 'spacecraft', comps: [
    BUS,
    { id: 'star', type: 'sat.sensor.star', parent: 'bus', params: {}, attach: { mode: 'surface', face: '+Z', uv: [0.2, 0.1], roll: 0 } },
    { id: 'k', type: 'sat.sensor.star', parent: 'bus', params: {}, attach: { mode: 'socket', socket: '+X', roll: 0 } },
    { id: 'f', type: 'sat.sensor.sun', parent: 'bus', params: {}, attach: { mode: 'free', socket: null, face: null }, t: [0, 0, 2], q: [0, 0, 0, 1] },
    { id: 'g', type: 'sat.sensor.sun', parent: 'bus', params: {}, attach: { mode: 'free', socket: null, face: '-Y', uv: [0.1, 0] }, t: [0, 0, 0.1], q: [0, 0, 0, 1] }
  ]
}
ok('「自动」步长：面安装 / 面锚 → 该面；接口 → 接口所在的面；无锚 → 父件包围盒短边；数值档原样；根件 null', () => {
  const bus = L.compById(DOC, 'bus')
  const faces = L.facesOf(bus)
  const fz = faces.find((f) => f.id === '+Z'), fx = faces.find((f) => f.id === '+X'), fy = faces.find((f) => f.id === '-Y')
  assert.equal(L.moveStepRef(DOC, L.compById(DOC, 'star')).id, '+Z')
  assert.equal(L.moveStepRef(DOC, L.compById(DOC, 'k')).id, '+X')
  assert.equal(L.moveStepRef(DOC, L.compById(DOC, 'g')).id, '-Y')
  assert.equal(L.effMoveStep(DOC, L.compById(DOC, 'star'), 'auto'), S.autoGridStep(fz))
  assert.equal(L.effMoveStep(DOC, L.compById(DOC, 'k'), 'auto'), S.autoGridStep(fx))
  assert.equal(L.effMoveStep(DOC, L.compById(DOC, 'g'), 'auto'), S.autoGridStep(fy))
  const b = A.componentBox(BUS.type, BUS.params)
  const short = Math.min(b[3] - b[0], b[4] - b[1], b[5] - b[2])
  near(L.moveStepRef(DOC, L.compById(DOC, 'f')), short, 1e-12)
  assert.equal(L.effMoveStep(DOC, L.compById(DOC, 'f'), 'auto'), S.autoGridStep(short))
  assert.equal(L.effMoveStep(DOC, L.compById(DOC, 'star'), 0.1), 0.1)
  assert.equal(L.effMoveStep(DOC, bus, 'auto'), null)
  assert.ok(S.GRID_STEPS.includes(L.effMoveStep(DOC, L.compById(DOC, 'star'), 'auto')))
})

// ─────────────────────────── ④ 悬停键位 ───────────────────────────
ok('放置键位：组件卡片 / 功能区悬停含 Q / E、Tab、B、Alt、Shift、右键、Esc；卡片末行仍是 type', () => {
  for (const k of ['Q / E', 'Tab', 'B ', 'Alt', 'Shift', '右键', 'Esc']) assert.ok(L.PLACE_KEYS_TIP.includes(k), k)
  const tip = L.compTip({ titleZh: '星敏感器', title: 'Star tracker', type: 'sat.sensor.star' })
  for (const k of ['拖至结构树某一行 = 安装到该件', 'Q / E 旋转朝向', 'Tab 切换落点候选', 'B 切换安装接口', '按住 Alt 移动指针旋转视角', '双击：安装到选中件']) assert.ok(tip.includes(k), k)
  assert.equal(tip.split('\n').pop(), 'sat.sensor.star')
})

// ─────────────────────────── ⑤ 面板写入路径（setAttach 带 off / tilt） ───────────────────────────
const D2R = Math.PI / 180
const xf = (M, p) => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]]
const xd = (M, d) => [M[0] * d[0] + M[4] * d[1] + M[8] * d[2], M[1] * d[0] + M[5] * d[1] + M[9] * d[2], M[2] * d[0] + M[6] * d[1] + M[10] * d[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
/** 件 id 的安装点（世界）与安装端外法向（世界） */
function mountWorld(doc, id) {
  const c = L.compById(doc, id)
  const M = A.solvePose(doc).get(id).m
  const ms = S.mountSocketOf(c)
  return { p: xf(M, ms.pos), n: xd(M, ms.n) }
}
/** 父件某个面的世界面心与外法向 */
function faceWorld(doc, pid, fid) {
  const p = L.compById(doc, pid)
  const M = A.solvePose(doc).get(pid).m
  const f = L.facesOf(p).find((x) => x.id === fid)
  return { o: xf(M, f.origin), n: xd(M, f.n), f }
}
/** 面板的数值写入（AsmProps.setAttachNum 同一条路）：setAttach + patch，返回新文档 */
function panelSet(doc, id, patch) {
  const c = L.compById(doc, id)
  const r = S.applyCmd(doc, { type: 'setAttach', id, attach: { ...c.attach, ...patch } })
  assert.ok(r.ok, r.error)
  return r.doc
}
ok('面安装件：法向偏移 0.2 m、倾角 15° 写入 → 安装点离面 0.2 m、安装法向与面法向成 15°；改父件尺寸 → 子件跟随（离面 / 倾角不变）', () => {
  let d = A.normalizeAssembly(JSON.parse(JSON.stringify(DOC)))
  d = panelSet(d, 'star', L.offPatch(L.compById(d, 'star').attach, 2, 0.2))
  d = panelSet(d, 'star', L.tiltPatch(L.compById(d, 'star').attach, 0, 15))
  const a = L.compById(d, 'star').attach
  assert.deepEqual([a.mode, a.face, a.off, a.tilt], ['surface', '+Z', [0, 0, 0.2], [15, 0]])
  assert.equal(d.schema, 2, '非缺省 off / tilt → schema 2')
  const check = (doc, msg) => {
    const m = mountWorld(doc, 'star'), f = faceWorld(doc, 'bus', '+Z')
    near(dot([m.p[0] - f.o[0], m.p[1] - f.o[1], m.p[2] - f.o[2]], f.n), 0.2, 1e-9, msg + ' 离面')
    near(Math.acos(Math.max(-1, Math.min(1, dot(m.n.map((x) => -x), f.n)))), 15 * D2R, 1e-9, msg + ' 倾角')
  }
  check(d, '写入后')
  const z0 = mountWorld(d, 'star').p
  const r = S.applyCmd(d, { type: 'setParams', id: 'bus', params: { zM: 4 } })
  assert.ok(r.ok, r.error)
  check(r.doc, '改尺寸后')
  near(mountWorld(r.doc, 'star').p[2] - z0[2], 0.5, 1e-9, '+Z 面外移 0.5 m，子件跟随')
  assert.deepEqual(L.compById(r.doc, 'star').attach.off, [0, 0, 0.2])
  assert.deepEqual(L.compById(r.doc, 'star').attach.tilt, [15, 0])
})
ok('接口件：先偏移（x / y / 法向）后改滚转 → 安装点世界位置不变；倾角写入不动安装点', () => {
  let d = A.normalizeAssembly(JSON.parse(JSON.stringify(DOC)))
  for (const [k, v] of [[0, 0.15], [1, -0.08], [2, 0.2]]) d = panelSet(d, 'k', L.offPatch(L.compById(d, 'k').attach, k, v))
  assert.deepEqual(L.compById(d, 'k').attach.off, [0.15, -0.08, 0.2])
  const p0 = mountWorld(d, 'k').p
  for (const roll of [90, 33, -120]) {
    const d2 = panelSet(d, 'k', { roll })
    nearV(mountWorld(d2, 'k').p, p0, 1e-9, 'roll ' + roll)
  }
  const d3 = panelSet(d, 'k', L.tiltPatch(L.compById(d, 'k').attach, 0, 30))
  nearV(mountWorld(d3, 'k').p, p0, 1e-9, '倾角')
  const d4 = panelSet(d3, 'k', L.tiltPatch(L.compById(d3, 'k').attach, 1, -40))
  nearV(mountWorld(d4, 'k').p, p0, 1e-9, '倾角 2')
})
ok('换回缺省（偏移 / 倾角全 0）→ 文档与改前逐字节相同（存档只写非缺省、schema 回 1）', () => {
  const d0 = A.normalizeAssembly(JSON.parse(JSON.stringify(DOC)))
  let d = panelSet(d0, 'k', L.offPatch(L.compById(d0, 'k').attach, 2, 0.3))
  d = panelSet(d, 'k', L.tiltPatch(L.compById(d, 'k').attach, 0, 12))
  d = panelSet(d, 'k', L.offPatch(L.compById(d, 'k').attach, 2, 0))
  d = panelSet(d, 'k', L.tiltPatch(L.compById(d, 'k').attach, 0, 0))
  assert.equal(JSON.stringify(A.compactAssembly(d)), JSON.stringify(A.compactAssembly(d0)))
  assert.equal(A.asmHash(d), A.asmHash(d0))
})

console.log(`modelAsmPanel：${n} 项通过`)
