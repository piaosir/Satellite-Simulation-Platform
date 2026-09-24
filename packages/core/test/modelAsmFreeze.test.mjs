// 冻结快照不毒化热路径（P3 修复轮 rv1）：编辑器发给 UI 的文档快照若把 t / q / uv 这些数字数组也冻结，冻结数组的元素类型是通用标记型，
// 一旦有人拿它调 solvePose（旧的属性面板就这么做），fromQT / faceFrameAt / quatOk 的同一批读取点混进两种元素类型，
// 优化后的代码从此把双精度装箱——编辑器拖动热路径每帧分配 ~25 KB（100 件）。asmSnap.freezeDoc 只冻结对象、不冻结纯数字数组。
//   ① freezeDoc：对象冻结、数字数组不冻结、嵌套对象数组冻结；
//   ② 先拿 freezeDoc 的快照调 solvePose（每 4 帧一次，模拟 UI 混喂），再用 HeapProfiler（含新生代回收掉的对象）量工作文档的
//      solvePose + combineMass：每帧 ≤ 100 B（对照：旧的全冻结快照混喂 → 每帧上 KB，本测试也量出来作为反证）。
// 独立子进程各量一遍（混喂过的优化状态是全进程的，不能在同一进程里先毒化再量干净的）。不联网。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODELS = pathToFileURL(path.resolve(HERE, '../models') + '/').href
let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }

if (process.argv[2] === '--child') {
  const mode = process.argv[3]
  const inspector = await import('node:inspector/promises')
  const A = await import(MODELS + 'assembly.mjs'), P = await import(MODELS + 'paramTemplates.mjs'), S = await import(MODELS + 'asmSnap.mjs')
  let doc = A.specToAssembly(P.templateSpec(P.DEFAULT_TEMPLATE_ID).spec)
  const bus = doc.comps[0].id
  const types = ['sat.sensor.sun', 'sat.thruster', 'sat.sensor.star', 'sat.feed.horn']
  let k = 0
  for (const face of ['+X', '-X']) for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) { const r = S.addComp(doc, { type: types[k++ % 4], parent: bus, attach: { mode: 'surface', face, uv: [-1.5 + i * 0.43, -0.75 + j * 0.5], roll: 0 } }); if (r.ok) doc = r.doc }
  doc = A.normalizeAssembly(JSON.parse(JSON.stringify(doc)))   // 编辑器里的工作文档（JSON 往返后归一）
  const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const kk of Object.keys(o)) deepFreeze(o[kk]) } return o }
  const snap = mode === 'none' ? null : mode === 'deep' ? deepFreeze(JSON.parse(JSON.stringify(doc))) : S.freezeDoc(JSON.parse(JSON.stringify(doc)))
  const tgt = doc.comps.find((c) => c.type === 'sat.sensor.star' && c.attach.mode === 'surface')
  const poses = new Map(), mo = {}, uiPoses = new Map()
  const step = (i) => { tgt.attach.uv[0] = -1 + (i % 50) * 0.01; A.solvePose(doc, poses); A.combineMass(doc, mo) }
  for (let i = 0; i < 3000; i++) { step(i); if (snap && i % 4 === 0) A.solvePose(snap, uiPoses) }
  const s = new inspector.Session(); s.connect()
  await s.post('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
  const N = 4000
  for (let i = 0; i < N; i++) step(i)
  const { profile } = await s.post('HeapProfiler.stopSampling')
  let tot = 0
  const walk = (nd) => { tot += nd.selfSize || 0; for (const c of nd.children) walk(c) }
  walk(profile.head)
  process.stdout.write(JSON.stringify({ mode, perFrame: tot / N }))
  process.exit(0)
}

const { freezeDoc } = await import(MODELS + 'asmSnap.mjs')
t('freezeDoc：对象冻结、纯数字数组不冻结、对象数组冻结', () => {
  const d = freezeDoc({ comps: [{ id: 'a', t: [0, 1.5, 2], q: [0, 0, 0, 1], attach: { uv: [0.1, 0.2], mode: 'surface' }, params: { x: 1 } }], name: 'x' })
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.comps) && Object.isFrozen(d.comps[0]) && Object.isFrozen(d.comps[0].attach) && Object.isFrozen(d.comps[0].params))
  assert.ok(!Object.isFrozen(d.comps[0].t) && !Object.isFrozen(d.comps[0].q) && !Object.isFrozen(d.comps[0].attach.uv))
})

const measure = (mode) => JSON.parse(execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--child', mode], { encoding: 'utf8', timeout: 240000 }))
t('混喂 freezeDoc 快照后，工作文档的 solvePose + combineMass 每帧 ≤ 100 B（全冻结快照混喂作反证）', () => {
  const none = measure('none'), fz = measure('freeze'), deep = measure('deep')
  console.log(`  每帧分配（B）：只有工作文档 ${none.perFrame.toFixed(0)} · 混喂 freezeDoc 快照 ${fz.perFrame.toFixed(0)} · 混喂全冻结快照 ${deep.perFrame.toFixed(0)}`)
  assert.ok(none.perFrame <= 100, `只有工作文档 ${none.perFrame.toFixed(0)} B/帧`)
  assert.ok(fz.perFrame <= 100, `混喂 freezeDoc 快照 ${fz.perFrame.toFixed(0)} B/帧`)
})

console.log(`modelAsmFreeze: ${n} 项通过`)
