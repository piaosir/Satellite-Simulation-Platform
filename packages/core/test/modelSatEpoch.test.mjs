// 模型工作台与天线树历元 / 全软件时间线（src/model/satSources.js · satStore.js · anaContext.js · AnalysisTab.vue · satPickLogic.js）。
// 运行：node packages/core/test/modelSatEpoch.test.mjs
//   ① 树节点改动判据（satPickLogic.treeOrbitSig / treeSigMap / changedFolders）：根数 / 历元 / OMM / 关联号 / 固定星星下点变了才算；
//      根数星 / 关联星的实时星位（grdLive 叠上来的 lon/lat/altKm，播放中一直在变）不算
//   ② 快照换现节点（freshTreeNode）、库条目「从树挑的星」按现节点解（lbTreeNode：只认六根数 / OMM 节点）
//   ③ 工作台建 satrec 的口径：elementsOmm 的 noradId 兜底（99999 / 'SIM'）不影响推演 → 与 3D 页逐位一致；
//      旧库条目 spec（epoch:null）经 orbitSpecWithEpoch 与旧树节点（无历元）解出同一颗星；自定义星座池记录带场景历元；
//      库条目里的自定义星座星换成当前场景历元（scenarioEpochPatch）后与池记录同一颗星同一处
//   ④ 源码钉：satSources 六根数路径不再取「此刻」当历元、库 spec 先换场景历元；satStore 盯 'globe3d/settings' + 焦点作废轨道、
//      dispose 摘监听、重选同一颗也翻 orbitRev；分析页「当前时刻」= 场景时刻（sceneNowMs），星位缓存键带轨道版本
// satSources / satStore 走 Vite 别名（@core）与 vue，裸 node 不能 import —— 逻辑放在 satPickLogic（零依赖）里测，接线用源码钉。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(path.join(HERE, p)).href)
const src = (p) => readFileSync(path.join(HERE, p), 'utf8')
const L = await imp('../../../src/model/satPickLogic.js')
const { default: sat } = await imp('../../../src/viz/constellation/satellite.js')
const E = await imp('../../../src/shared/treeOrbitEpoch.js')
const LT = await imp('../../../src/shared/lbTreeOrbit.js')

let n = 0
const ok = (name, fn) => { fn(); n++ }

const EL = { altKm: 550, ecc: 0.001, incl: 53, raan: 120, argp: 30, ma: 45, epoch: '2026-10-06T02:30:00.000Z' }
const orbitNode = { folder: 'o1', satName: 'O1', kind: 'orbit', lon: 10, lat: 20, altKm: 551, elements: EL, omm: null, noradId: null }
const fixedNode = { folder: 'g1', satName: 'G1', kind: 'preset', lon: 125, lat: 0, altKm: 35786, elements: null, omm: null, noradId: null }
const linkedNode = { folder: 'l1', satName: 'ISS', kind: 'linked', lon: 0, lat: 0, altKm: 420, elements: null, omm: null, noradId: '25544' }

// ① 改动判据
ok('treeOrbitSig：历元 / 根数变了签名变', () => {
  const s0 = L.treeOrbitSig(orbitNode)
  assert.notEqual(L.treeOrbitSig({ ...orbitNode, elements: { ...EL, epoch: '2026-10-07T00:00:00.000Z' } }), s0, '只改历元也算改动')
  assert.notEqual(L.treeOrbitSig({ ...orbitNode, elements: { ...EL, ma: 46 } }), s0)
  assert.notEqual(L.treeOrbitSig({ ...orbitNode, omm: { meanMotion: 15 } }), s0)
  assert.equal(L.treeOrbitSig({ ...orbitNode, satName: '改名' }), s0, '星名不影响轨道')
})
ok('treeOrbitSig：根数星 / 关联星的实时星位不进签名，固定星的星下点进', () => {
  assert.equal(L.treeOrbitSig({ ...orbitNode, lon: 11, lat: 21, altKm: 560 }), L.treeOrbitSig(orbitNode), '根数星：grdLive 星位在变不算')
  assert.equal(L.treeOrbitSig({ ...linkedNode, lon: 99 }), L.treeOrbitSig(linkedNode), '关联星：同上')
  assert.notEqual(L.treeOrbitSig({ ...linkedNode, noradId: '25545' }), L.treeOrbitSig(linkedNode), '关联号换了算')
  assert.notEqual(L.treeOrbitSig({ ...fixedNode, lon: 126 }), L.treeOrbitSig(fixedNode), '固定星挪了轨位算')
  assert.equal(L.treeOrbitSig(null), '')
})
ok('treeSigMap / changedFolders：改了 / 新增 / 删了；同 folder 取第一个；无 folder 跳过', () => {
  const a = L.treeSigMap([orbitNode, fixedNode, linkedNode, { satName: '无 folder' }, { ...orbitNode, elements: null }])
  assert.deepEqual([...a.keys()], ['o1', 'g1', 'l1'])
  assert.equal(a.get('o1'), L.treeOrbitSig(orbitNode), '同 folder 取第一个')
  assert.equal(L.changedFolders(a, L.treeSigMap([orbitNode, fixedNode, linkedNode])).size, 0, '没变：空集')
  assert.equal(L.changedFolders(a, L.treeSigMap([{ ...orbitNode, lon: 99 }, fixedNode, { ...linkedNode, lat: 5 }])).size, 0, '只有实时星位变：空集（不作废）')
  const b = L.treeSigMap([{ ...orbitNode, elements: { ...EL, epoch: '2026-12-01T00:00:00Z' } }, linkedNode, { ...fixedNode, folder: 'g2' }])
  assert.deepEqual([...L.changedFolders(a, b)].sort(), ['g1', 'g2', 'o1'], '改历元 o1 · 删 g1 · 新增 g2')
  assert.deepEqual([...L.changedFolders(null, L.treeSigMap([orbitNode]))], ['o1'])
})

// ② 快照换现节点 / 库条目按现节点
ok('freshTreeNode：按 folder 换成现在的；树里没了用快照', () => {
  const now = { ...orbitNode, elements: { ...EL, epoch: '2026-12-01T00:00:00.000Z' } }
  assert.equal(L.freshTreeNode(orbitNode, [fixedNode, now]), now)
  assert.equal(L.freshTreeNode(orbitNode, [fixedNode]), orbitNode)
  assert.equal(L.freshTreeNode(null, [now]), null)
  const nf = { satName: 'x' }
  assert.equal(L.freshTreeNode(nf, [now]), nf, '没有 folder：原样')
})
ok('lbTreeNode：从树挑的根数 / OMM 星按现节点；关联星 / 固定星 / 手动 / 节点没了 → null', () => {
  const nodes = [orbitNode, fixedNode, linkedNode, { folder: 'm1', omm: { meanMotion: 15.5 } }]
  const e = (ns) => ({ ns: 'ngso', id: 'x', ngsoSat: ns })
  assert.equal(L.lbTreeNode(e({ mode: 'tree', folder: 'o1', orbit: { type: 'elements', epoch: null } }), nodes), orbitNode)
  assert.equal(L.lbTreeNode(e({ mode: 'tree', folder: 'm1' }), nodes), nodes[3])
  assert.equal(L.lbTreeNode(e({ mode: 'tree', folder: 'l1' }), nodes), null, '关联星：库里的池 spec 照用')
  assert.equal(L.lbTreeNode(e({ mode: 'tree', folder: 'g1' }), nodes), null, '固定星：走原来的 folder 兜底')
  assert.equal(L.lbTreeNode(e({ mode: 'manual', folder: 'o1' }), nodes), null)
  assert.equal(L.lbTreeNode(e({ mode: 'tree', folder: 'gone' }), nodes), null)
  assert.equal(L.lbTreeNode({ ns: 'geo', id: 'y' }, nodes), null)
  assert.equal(L.lbTreeNode(null, nodes), null)
})

// ③ satrec 口径
const KEYS = ['jdsatepoch', 'jdsatepochF', 'no', 'ecco', 'inclo', 'nodeo', 'argpo', 'mo']
const sameRec = (a, b) => KEYS.every((k) => a[k] === b[k])
const posEq = (a, b, t) => { const p = sat.propagate(a, t).position, q = sat.propagate(b, t).position; return p.x === q.x && p.y === q.y && p.z === q.z }
const T = new Date('2026-10-06T08:00:00Z')
ok('工作台（noradId 兜底 99999）与 3D 页（SIM）同一份根数 + 历元：satrec 与同一时刻星位逐位一致', () => {
  for (const el of [EL, { altKm: 20200, ecc: 0.01, incl: 55, raan: 10, argp: 0, ma: 200, epoch: '2026-03-01T00:00:00Z' }, { altKm: 35786, ecc: 0, incl: 0.05, raan: 0, argp: 0, ma: 100 }]) {
    const wbRec = sat.omm2satrec(E.elementsOmm(el, 99999)), pageRec = sat.omm2satrec(E.elementsOmm(el, 'SIM'))
    assert.ok(!wbRec.error && sameRec(wbRec, pageRec), `satrec（altKm ${el.altKm}）`)
    assert.ok(posEq(wbRec, pageRec, T), `星位（altKm ${el.altKm}）`)
  }
})
ok('历元跟节点走：同根数不同历元 → 同一时刻不同星位；历元不随解析时刻变', () => {
  const a = sat.omm2satrec(E.elementsOmm(EL, 1)), b = sat.omm2satrec(E.elementsOmm({ ...EL, epoch: '2026-10-06T03:00:00Z' }, 1))
  assert.ok(!posEq(a, b, T), '历元差 30 min：星位不同')
  const legacy = { ...EL }; delete legacy.epoch
  const l1 = sat.omm2satrec(E.elementsOmm(legacy, 1)), l2 = sat.omm2satrec(E.elementsOmm(legacy, 1))
  assert.ok(sameRec(l1, l2) && E.elementsOmm(legacy, 1).epoch === E.TREE_ORBIT_LEGACY_EPOCH, '旧节点：固定常量（两次解析同一个历元）')
})
ok('旧库条目 spec（epoch:null）与旧树节点解出同一颗星；自定义星座池记录带场景历元', () => {
  const legacy = { ...EL }; delete legacy.epoch
  const spec = { type: 'elements', ...legacy, epoch: null, noradId: null }
  const fromSpec = sat.omm2satrec(E.elementsOmm(E.orbitSpecWithEpoch(spec), null))
  const fromNode = sat.omm2satrec(E.elementsOmm(legacy, null))
  assert.ok(sameRec(fromSpec, fromNode) && posEq(fromSpec, fromNode, T))
  const cc = { orbitType: 'elements', epoch: '2026-10-06T00:00:00.000Z', elements: legacy }
  assert.equal(E.elementsOmm({ ...cc.elements, epoch: cc.epoch }, 900000).epoch, cc.epoch, 'propOfPoolRec 把 rec.epoch 并进根数')
})
ok('库条目里的自定义星座星：挑星那天的场景历元换成当前的 → 与池记录（cc: / 3D 页）同一颗星同一处', () => {
  const legacy = { ...EL }; delete legacy.epoch
  const rec = { orbitType: 'elements', noradId: '900003', epoch: '2026-10-07T00:00:00.000Z', elements: legacy }
  const spec = { type: 'elements', ...legacy, epoch: '2026-10-06T00:00:00.000Z', noradId: '900003' }   // 前一天挑进库的
  const p = LT.scenarioEpochPatch(spec, [rec])
  assert.ok(p && p.epoch === rec.epoch && spec.epoch === '2026-10-06T00:00:00.000Z', '换历元、不改入参')
  const fromLb = sat.omm2satrec(E.elementsOmm(E.orbitSpecWithEpoch(p), p.noradId))
  const fromPool = sat.omm2satrec(E.elementsOmm({ ...rec.elements, epoch: rec.epoch }, rec.noradId))
  assert.ok(sameRec(fromLb, fromPool) && posEq(fromLb, fromPool, T))
  const stale = sat.omm2satrec(E.elementsOmm(E.orbitSpecWithEpoch(spec), spec.noradId))
  assert.ok(!posEq(stale, fromPool, T), '不换：差一天的推演，星位不同')
  assert.equal(LT.scenarioEpochPatch({ ...spec, ma: 46 }, [rec]), null, '星座参数改过（根数对不上）：不认、原样')
})

// ④ 源码钉
const S = src('../../../src/model/satSources.js')
const ST = src('../../../src/model/satStore.js')
const AC = src('../../../src/model/anaContext.js')
const AT = src('../../../src/model/AnalysisTab.vue')
// 函数体：从 head 那一行到同缩进的第一个「}」行
const fnBody = (text, head) => {
  const i = text.indexOf(head)
  assert.ok(i >= 0, '找不到 ' + head)
  const ls = text.lastIndexOf('\n', i) + 1
  const indent = /^[ \t]*/.exec(text.slice(ls, i))[0]
  const j = text.indexOf('\n' + indent + '}', i)
  assert.ok(j > i, '找不到函数尾 ' + head)
  return text.slice(i, j)
}
ok('satSources：六根数一律走 elementsOmm，不取「此刻」当历元', () => {
  assert.ok(!/new Date\(\)\.toISOString\(\)/.test(S), '不再有 new Date().toISOString() 兜底')
  assert.ok(!/Date\.now\(\)/.test(S))
  assert.ok(S.includes("import { elementsOmm, orbitSpecWithEpoch } from '../shared/treeOrbitEpoch.js'"))
  assert.match(fnBody(S, 'function satrecFromElements('), /return satrecFromOmm\(elementsOmm\(el, noradId \|\| 99999\)\)/)
  assert.match(fnBody(S, 'async function propOfSpec('), /satrecFromElements\(orbitSpecWithEpoch\(spec\), spec\.noradId\)/)
  assert.match(fnBody(S, 'async function propOfPoolRec('), /satrecFromElements\(\{ \.\.\.\(rec\.elements \|\| \{\}\), epoch: rec\.epoch \}, rec\.noradId\)/)
  assert.match(fnBody(S, 'async function treeNodeOrbitRaw('), /satrecFromElements\(node\.elements, node\.noradId\)/)
  assert.match(fnBody(S, 'async function orbitOfTreeNode('), /treeFolder: String\(node\.folder\)/)
})
ok('satSources：hint 快照换现节点；库条目从树挑的星先按现节点解', () => {
  assert.match(fnBody(S, 'export async function resolveOrbit('), /orbitOfTreeNode\(freshNode\(hint\.treeNode\)\)/)
  const lb = fnBody(S, 'async function orbitOfLbEntry(')
  const i = lb.indexOf("ns.mode === 'tree' ? lbTreeNode(e, grdTreeSats())"), j = lb.indexOf('if (ns.orbit)')
  assert.ok(i > 0 && j > i, '现节点在库存 spec 之前')
  assert.match(lb, /propOfSpec\(withScenarioEpoch\(ns\.orbit\)\)/, '库存 spec 先换当前场景历元')
  assert.ok(S.includes("import { scenarioEpochPatch } from '../shared/lbTreeOrbit.js'"))
  assert.match(fnBody(S, 'function withScenarioEpoch('), /scenarioEpochPatch\(spec, cust\) \|\| spec/)
  assert.match(fnBody(S, 'function withScenarioEpoch('), /loadCustomSats\(\)\.sats/)
})
ok('satStore：盯 globe3d/settings + 焦点，节点变了作废轨道；dispose 摘监听', () => {
  assert.ok(ST.includes("e.key === 'globe3d/settings'"))
  assert.ok(ST.includes("window.addEventListener('storage', onTreeStorage)") && ST.includes("window.addEventListener('focus', onTreeFocus)"))
  const disp = fnBody(ST, 'function dispose() {')
  assert.ok(disp.includes("window.removeEventListener('storage', onTreeStorage)") && disp.includes("window.removeEventListener('focus', onTreeFocus)"))
  const sync = fnBody(ST, 'function syncTree() {')
  assert.ok(/changedFolders\(treeSig, next\)/.test(sync) && /st\.orbit = null; st\.orbitKey = ''; st\.orbitErr = ''; st\.orbitRev\+\+/.test(sync) && /st\.treeRev\+\+/.test(sync))
  assert.match(sync, /treeNode: fresh/, 'hint 快照换现节点')
  assert.match(sync, /st\.hint\.lbEntry\.ngsoSat/, '还没解出轨道时，从树挑的库条目也认得出依赖的节点')
  assert.match(fnBody(ST, 'async function ensureOrbit() {'), /rev !== st\.orbitRev/, '解析途中节点又改：重解')
  assert.match(fnBody(ST, 'async function selectSat(o) {'), /st\.orbit = null; st\.orbitKey = ''; st\.orbitErr = ''; st\.orbitRev\+\+/, '重选同一颗也翻轨道版本（分析页缓存键带它）')
})
ok('分析页：「当前时刻」= 场景时刻；星位缓存键带轨道版本', () => {
  assert.ok(AC.includes("import { sceneNowMs } from '../shared/sceneClock.js'"))
  assert.match(AC, /export const minuteNow = \(\) => Math\.floor\(sceneNowMs\(\) \/ 60000\) \* 60000/)
  assert.ok(!/Date\.now\(\)/.test(AC), 'anaContext 不再取系统钟')
  assert.match(AC, /t0: minuteNow\(\)/)
  assert.match(fnBody(AC, 'function keyOf() {'), /sat\.st\.orbitRev/)
  assert.ok(!/Date\.now\(\)/.test(AT), 'AnalysisTab 不再取系统钟')
  assert.match(AT, /function nowT0\(\) \{ W\.t0 = minuteNow\(\); ana\.invalidate\(\) \}/)
})
// ⑤ 叠加星历（主窗口导入星历「对应已有卫星」/ 改对应 / 删组）：工作台开着时也要跟上
ok('叠加星历：焦点回来当场重核，按对应关系签名比；注册表真换了才通知（本窗口首灌不通知）', () => {
  assert.ok(S.includes("window.addEventListener('focus', () => { _ovlP = null; ensureOverlays() })"), '焦点回来立即重核，不等下一次解析轨道')
  const eo = fnBody(S, 'function ensureOverlays() {')
  assert.match(eo, /if \(sig === _ovlSig\) return/, '对应关系没变：不重取采样表')
  assert.match(eo, /if \(reg === _regSig\) return/, '注册表没变：不通知')
  assert.match(eo, /const first = _regSig === null/)
  assert.match(eo, /if \(!first\) for \(const fn of _ovlSubs\)/, '首灌不通知')
  assert.match(S, /export function onOverlaysChange\(fn\)/)
  assert.match(fnBody(S, 'export async function resolveOrbit('), /await ensureOverlays\(\)/, '解析轨道前注册表先就位')
})
ok('叠加星历：satStore 订阅换版 → 当前星轨道作废（orbitRev+1）、ovlRev+1；dispose 退订；分析页缓存键带 ovlRev', () => {
  assert.ok(ST.includes('const offOverlays = onOverlaysChange(syncOverlays)'))
  const so = fnBody(ST, 'function syncOverlays() {')
  assert.match(so, /st\.ovlRev\+\+/)
  assert.match(so, /st\.orbit = null; st\.orbitKey = ''; st\.orbitErr = ''; st\.orbitRev\+\+/)
  assert.match(fnBody(ST, 'function dispose() {'), /offOverlays\(\)/)
  assert.match(fnBody(AC, 'function keyOf() {'), /sat\.st\.ovlRev/)
})

console.log(`modelSatEpoch: ${n} 项通过`)
