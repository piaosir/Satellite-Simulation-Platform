// 链路预算三窗 / 星间距离工具 / 干扰分析 / 性能表弹窗：树节点历元与全软件一条时间线（src/shared/lbTreeOrbit.js + 各窗口接线）。
// 运行：node packages/core/test/treeEpochWindows.test.mjs
//   ① 源码钉：三份 treeNodeOrbit（NGSO / 再生式面板 / 端到端面板）根数星一律 treeElementsSpec(el, node.noradId)，不再读 node.epoch
//      （那个字段不存在，主进程只好按计算那一刻编历元）；再生式 / 端到端面板把 treeNodeOrbit 与 orbitToForm 从模块作用域导出给窗口刷新用
//   ② 源码钉：送引擎的出口都经 lbOrbitSpec（NGSO solveSelectedGeom / geomBatchSpec、再生式 orbitSpecOf 且无内联副本、端到端 e2eParams.orbitSpecOf）
//   ③ 源码钉：刷新卫星树重解已选星（三窗同一写法：先算出新轨道、与现值比过才写）、自定义星座星跟上场景历元（三窗）
//   ④ 源码钉：「此刻」一律取场景时刻 —— 三窗搜索起点、星间距离工具、干扰分析 NGSO 起点、性能表弹窗只敲时分的日期基准
//   ⑤ 源码钉：干扰分析 GRD 树按 globe3d/grdLive 覆盖实时星位（同 grdParam），关联星无星历不取值
//   ⑥ lbOrbitSpec：旧库条目 elements spec（epoch:null）按所选树节点历元补；节点不在 / 非树来源 → 旧数据常量；其余原样；深拷贝
//   ⑦ 同一颗星同一处：旧库条目经 lbOrbitSpec 送主进程 buildSatrec，与 3D 页（elementsOmm→omm2satrec）同一绝对时刻位置逐位一致
//   ⑧ scenarioEpochPatch：自定义星座搜索选星（拍下的是旧场景历元）→ 当前 loadCustomSats 的场景历元；星座改过参数 / 号不对 / 已是当前 → 不动
//      ⑧b 轨道向导地固 / 日固设计量的星座：池记录按当前场景历元重解 RAAN；库条目 RAAN 恰好差这段历元增量才认、连 RAAN 一起换
//   ⑨ e2eParams.orbitSpecOf(cfg, treeSats)：选星补历元、GSO / 手填不受影响
//   ⑩ pinCircularEpoch：星间几何的手动圆轨道历元钉到本批 t0（再生式微波 / 激光、端到端星间跳），结果只由 t0 定
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import sat from '../../../src/viz/constellation/satellite.js'
import { elementsOmm, treeElementsSpec, TREE_ORBIT_LEGACY_EPOCH } from '../../../src/shared/treeOrbitEpoch.js'
import { pickedTreeNode, lbOrbitSpec, scenarioEpochPatch, pinCircularEpoch } from '../../../src/shared/lbTreeOrbit.js'

// satSearchPool.loadCustomSats 现读 localStorage：node 里垫一个最小实现（只给 ⑧ 用）
const _ls = new Map()
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => { _ls.set(k, String(v)) }, removeItem: (k) => { _ls.delete(k) } }
const { loadCustomSats, orbitSpecOf: poolOrbitSpecOf } = await import('../../../src/ngso/satSearchPool.js')
const { resolveScenarioEpoch } = await import('../../../src/viz/constellation/useCustomConstellations.js')
const { orbitSpecOf: e2eOrbitSpecOf } = await import('../../../src/e2e/e2eParams.js')

const require = createRequire(import.meta.url)
const { buildSatrec, solveIslWorstCase } = require('../utils/ngsoGeometry.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }
const src = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
// 取一段函数体：从 head 起到第一处顶格 / 指定缩进的收尾 '}'
const fnBody = (text, head, close = '\n}\n') => {
  const i = text.indexOf(head)
  if (i < 0) return ''
  const j = text.indexOf(close, i)
  return j < 0 ? '' : text.slice(i, j + close.length)
}

const NGSO = src('src/ngso/NgsoLinkBudgetApp.vue')
const REGEN = src('src/regen/RegenLinkBudgetApp.vue')
const REGEN_P = src('src/regen/RegenSatPanel.vue')
const E2E = src('src/e2e/E2eLinkBudgetApp.vue')
const E2E_P = src('src/e2e/E2eSatPanel.vue')
const E2E_PARAMS = src('src/e2e/e2eParams.js')
const ISL = src('src/components/LbIslRangeTool.vue')
const CI = src('src/ci/useInterference.js')
const GPW = src('src/perf/GroundPerfWin.vue')
const MET = src('src/perf/MetTableWin.vue')

// ① 三份 treeNodeOrbit
const copies = [
  ['NGSO', fnBody(NGSO, 'async function treeNodeOrbit(node) {')],
  ['再生式面板', fnBody(REGEN_P, 'export async function treeNodeOrbit(node) {')],
  ['端到端面板', fnBody(E2E_P, 'export async function treeNodeOrbit(node) {')]
]
for (const [name, body] of copies) {
  ok(body.length > 200, `${name} treeNodeOrbit 找得到`)
  ok(!/node\.epoch/.test(body), `${name} treeNodeOrbit 不读 node.epoch`)
  ok(body.includes('return treeElementsSpec(el, node.noradId)'), `${name} treeNodeOrbit 根数星走 treeElementsSpec（历元取节点 elements.epoch）`)
  // 关联星（池记录）：NGSO 走取星的唯一出口 satSearchPool.orbitSpecOf（历元在那里取 rec.epoch，见下方 ①b）；
  // 两份面板目录星 / 六根数仍手拼（带 rec.epoch），点序列星走 orbitSpecOf（见 lbWorkbenchResults ⑥ 末段）
  ok(name === 'NGSO' ? body.includes('return orbitSpecOf(rec)') : body.includes('epoch: rec.epoch'), `${name} treeNodeOrbit 关联星（池记录）照旧取 rec.epoch`)
}
// ①b orbitSpecOf：目录星 / 自定义星座照旧带 rec.epoch；星历点序列只带引用（早先 NGSO 手拼把它拼成全空 OMM）
{
  const omm = poolOrbitSpecOf({ orbitType: 'omm', noradId: 25544, epoch: '2026-10-16T00:00:00Z', meanMotion: '15.5', ecc: '0.0005', incl: '51.6', raan: '10', argp: '20', ma: '30', bstar: '0.0001', mdot: '0', mddot: '0' })
  ok(omm.type === 'omm' && omm.epoch === '2026-10-16T00:00:00Z' && omm.meanMotion === 15.5 && omm.noradId === '25544', 'orbitSpecOf：OMM 记录带 rec.epoch、数值归一')
  const el = poolOrbitSpecOf({ orbitType: 'elements', noradId: '900001', epoch: '2026-10-16T08:00:00.000Z', elements: { altKm: 550, ecc: 0, incl: 53, raan: 1, argp: 2, ma: 3 } })
  ok(el.type === 'elements' && el.epoch === '2026-10-16T08:00:00.000Z' && el.altKm === 550, 'orbitSpecOf：自定义星座记录带场景历元')
  const eph = poolOrbitSpecOf({ orbitType: 'ephem', noradId: '800001', name: 'EPH', ref: { groupId: 'g1', key: 'k1' }, summary: { t0: 1, t1: 2 }, meanMotion: null, incl: null })
  ok(eph.type === 'ephem' && eph.ref.groupId === 'g1' && eph.ref.key === 'k1' && !('meanMotion' in eph), 'orbitSpecOf：点序列记录只带引用（不拼 OMM）')
  let threw = ''
  try { poolOrbitSpecOf({ orbitType: 'ephem', noradId: '800002' }) } catch (e) { threw = e.message }
  ok(!!threw, 'orbitSpecOf：点序列缺引用点名报错（不静默造一颗）', threw)
}
ok((NGSO.match(/async function treeNodeOrbit\(/g) || []).length === 1, 'NGSO 只有一份 treeNodeOrbit')
for (const [name, text] of [['再生式面板', REGEN_P], ['端到端面板', E2E_P]]) {
  const setupAt = text.indexOf('<script setup>')
  ok(setupAt > 0 && text.indexOf('export async function treeNodeOrbit(') < setupAt && text.indexOf('export function orbitToForm(form, orbit)') < setupAt,
    `${name}：treeNodeOrbit / orbitToForm 在普通 <script> 块导出（<script setup> 之前）`)
  ok(text.includes('function applyOrbitToForm(orbit) { orbitToForm(props.form, orbit) }'), `${name}：面板回显走同一份 orbitToForm`)
  ok(/import \{ treeElementsSpec \} from '\.\.\/shared\/treeOrbitEpoch\.js'/.test(text), `${name}：引入 treeElementsSpec`)
}
ok(/import RegenSatPanel, \{ treeNodeOrbit, orbitToForm \} from '\.\/RegenSatPanel\.vue'/.test(REGEN), '再生式窗口引入面板的 treeNodeOrbit / orbitToForm')
ok(/import E2eSatPanel, \{ treeNodeOrbit, orbitToForm \} from '\.\/E2eSatPanel\.vue'/.test(E2E), '端到端窗口引入面板的 treeNodeOrbit / orbitToForm')

// ② 送引擎的出口
const ssg = fnBody(NGSO, 'async function solveSelectedGeom(')
const gbs = fnBody(NGSO, 'function geomBatchSpec(')
ok(ssg.includes('lbOrbitSpec(sat.ngsoSat, satTree.value)') && gbs.includes('lbOrbitSpec(sat.ngsoSat, satTree.value)'), 'NGSO solveSelectedGeom / geomBatchSpec 经 lbOrbitSpec')
ok(!NGSO.includes('JSON.parse(JSON.stringify(sat.ngsoSat.orbit))'), 'NGSO 不再原样深拷贝 ngsoSat.orbit 送引擎')
// 几何预解按行 _id 对齐、整批只算开算那一刻的行快照（v1.5.0 上线前排查 #42：早先按下标对齐，预解那几秒里增删一行，几何就套到相邻那行上）
{
  const cmp = fnBody(NGSO, 'async function compute() {')
  ok(cmp.includes('const jobRows = linkRows.slice()') && cmp.includes('geomBatch.set(r._id,') && cmp.includes('geomBatch.get(row._id)') && !/geomBatch\[i\]/.test(cmp),
    'NGSO 几何预解按行 _id 对齐（不按下标）')
  ok(cmp.includes('resultsStale.value = _inGen !== gen0'), 'NGSO 算的途中输入又变了 → 「输入已变」保持亮')
}
const rOrb = fnBody(REGEN, 'function orbitSpecOf(sat) {')
ok(rOrb.includes('lbOrbitSpec(ns, satTree.value)'), '再生式 orbitSpecOf 经 lbOrbitSpec')
ok(!REGEN.includes('JSON.parse(JSON.stringify(ns.orbit))\n'), '再生式 computeGround 里的内联副本已收回 orbitSpecOf')
ok(REGEN.includes('const orbitSpec = orbitSpecOf(sat)'), '再生式上下行轨道走 orbitSpecOf')
ok(fnBody(E2E_PARAMS, 'export function orbitSpecOf(cfg, treeSats) {').includes('lbOrbitSpec(ns, treeSats)'), 'e2eParams.orbitSpecOf 经 lbOrbitSpec')
ok(E2E.includes('const satOrbitOf = (nd) => orbitSpecOf(satCfgOf(nd), satTree.value)') && E2E.includes('orbit: orbitSpecOf(c, satTree.value)'), '端到端两处调用方都带卫星树')

// ③ 刷新卫星树
// NGSO 与再生式 / 端到端同一写法（v1.5.0 上线前排查 #31）：早先 NGSO 刷新直接调 applyTreeSatOrbitFor（先置 null 再写新对象），
// 根数一位没变也让资源库深监听看见变动 —— 每次切回窗口都亮「输入已变」并空写一次资源库
ok(!fnBody(NGSO, 'async function reloadSatTree() {').includes('applyTreeSatOrbitFor('), 'NGSO 刷新：不再走先置 null 的 applyTreeSatOrbitFor')
for (const [name, text] of [['NGSO', NGSO], ['再生式', REGEN], ['端到端', E2E]]) {
  const body = fnBody(text, 'async function reloadSatTree() {')
  ok(body.includes('await treeNodeOrbit(node)') && body.includes('pickedTreeNode(ns, satTree.value)'), `${name} 刷新：取自卫星树的已选星按树里现在的节点重解`)
  ok(body.includes("orbit.type !== 'unresolved'") && body.includes('stableStringify(orbit) !== stableStringify(ns.orbit)'), `${name} 刷新：反解不出不顶掉已存轨道、只在真变了时写`)
  ok(body.includes('scenarioEpochPatch(ns.orbit, custSats())'), `${name} 刷新：自定义星座星换当前场景历元`)
  // 树来源：先换场景历元再比（否则池缓存的旧历元每次刷新都「写旧→换新」两遍，结果全标过期）
  const iPatch = body.indexOf("if (orbit.type === 'elements') orbit = scenarioEpochPatch(orbit, custSats()) || orbit")
  ok(iPatch > 0 && iPatch < body.indexOf('stableStringify(orbit) !== stableStringify(ns.orbit)'), `${name} 刷新：树来源先换场景历元再比，不重复写`)
  // 反解要等候选池：等完先认一下条目是否还指着这个节点，免得旧节点顶掉期间新选的星
  const iAwait = body.indexOf('await treeNodeOrbit(node)'), iGuard = body.indexOf("if (ns.mode !== 'tree' || ns.folder !== node.folder) continue")
  ok(iAwait > 0 && iGuard > iAwait && iGuard < body.indexOf('ns.name = node.satName'), `${name} 刷新：反解后先认条目仍指此节点再写`)
}
{
  const ap = fnBody(NGSO, 'async function applyTreeSatOrbitFor(cfg, node) {')
  const iAwait = ap.indexOf('await treeNodeOrbit(node)'), iGuard = ap.indexOf("if (ns.mode !== 'tree' || ns.folder !== node.folder) return")
  ok(iAwait > 0 && iGuard > iAwait && iGuard < ap.indexOf('ns.orbit = orbit'), 'NGSO applyTreeSatOrbitFor：反解后先认条目仍指此节点再写')
}
ok(fnBody(REGEN_P, 'async function onPickTree() {').includes("if (props.ngsoSat.mode !== 'tree' || props.ngsoSat.folder !== node.folder) return"), '再生式面板选星：反解后先认仍是这颗再写')
ok(fnBody(E2E_P, 'async function onPickTree() {').includes("if (ns.mode !== 'tree' || ns.folder !== node.folder) return"), '端到端面板选星：反解后先认仍是这颗再写')
ok(/window\.addEventListener\('focus', reloadSatTree\)/.test(REGEN) && /window\.removeEventListener\('focus', reloadSatTree\)/.test(REGEN), '再生式：切回窗口即刷新（与 NGSO / 端到端同）')
ok(/window\.addEventListener\('focus', reloadSatTree\)/.test(E2E), '端到端：切回窗口即刷新')

// ④ 一条时间线：搜索起点经场景的「起点」设置取（shared/geoT0.js，取值口径另见 geoT0.test.mjs），缺省档＝时间轴（场景时刻）；
//    「系统时钟」档是用户在功能区显式选的，窗口里不再有自取系统钟的起点
ok(NGSO.includes('function searchT0ISO() { return resolveGeoT0ISO(geoT0Mode.value, geoT0ISO.value) }'), 'NGSO 搜索起点经起点设置取')
ok(REGEN.includes('function searchT0ISO() { return resolveGeoT0ISO(geoT0Mode.value, geoT0ISO.value) }'), '再生式搜索起点经起点设置取')
ok(fnBody(E2E, 'async function solveChainGeometry(row, chain) {').includes('const t0ISO = resolveGeoT0ISO(geoT0Mode.value, geoT0ISO.value)'), '端到端几何起点经起点设置取')
for (const [name, text] of [['NGSO', NGSO], ['再生式', REGEN], ['端到端', E2E]]) {
  ok(/import \{[^}]*\bresolveGeoT0ISO\b[^}]*\} from '\.\.\/shared\/geoT0\.js'/.test(text) && text.includes("const geoT0Mode = ref('scene')"), `${name} 起点缺省档＝时间轴`)
  ok(!/t0ISO = new Date\(\)\.toISOString\(\)|return new Date\(\)\.toISOString\(\)/.test(text), `${name} 不再以系统钟作搜索起点`)
}
ok(ISL.includes("function nowT0() { t0Local.value = inputText(sceneNowMs(), 'local') }"), '星间距离工具「此刻」＝场景时刻')
ok(!/new Date\(\)/.test(ISL), '星间距离工具不再取系统钟（含起点留空的兜底）')
// 星间几何：手动圆轨道历元钉到本批 t0（主进程 _islNode 缺历元按计算那一刻补，与时间轴 t0 不同步）
const rIsl = REGEN.split('\n').filter((l) => l.includes('api.linkBudget.islGeometry('))
ok(rIsl.length === 2 && rIsl.every((l) => l.includes('orbitA: pinCircularEpoch(orbitSpecOf(txSat), t0ISO), orbitB: pinCircularEpoch(orbitSpecOf(rxSat), t0ISO), t0ISO')), '再生式微波 / 激光星间：圆轨道历元钉到本批 t0')
ok(fnBody(E2E, 'async function solveChainGeometry(row, chain) {').includes('const orbitA = pinCircularEpoch(satOrbitOf(a), t0ISO), orbitB = pinCircularEpoch(satOrbitOf(b), t0ISO)'), '端到端星间跳：圆轨道历元钉到本链 t0')
const ngp = fnBody(CI, '  function ngsoPayload() {', '\n  }\n')
ok(ngp.includes('const startMs = ngso.startIso ? Date.parse(ngso.startIso) : sceneNowMs()') && /\n {6}startMs,\n/.test(ngp), '干扰分析 NGSO 起点留空＝场景时刻')
ok(ngp.includes('epoch: ngso.startIso || new Date(startMs).toISOString()'), '干扰分析 walker 设计历元与起点同一刻')
ok(!/Date\.now\(\)|new Date\(\)\./.test(ngp.replace(/\/\/.*$/gm, '')), '干扰分析 NGSO 载荷里没有系统钟（注释除外）')
for (const [name, text] of [['对地性能表', GPW], ['气象指标表', MET]]) {
  ok(text.includes("const sceneBaseMs = () => { const t = Number(st.nowMs); return Number.isFinite(t) && t > 0 ? t : sceneNowMs() }"), `${name}：日期基准＝宿主 nowMs > 场景时刻镜像`)
  ok(!/parseTzText\([^)]*Date\.now\(\)\)/.test(text), `${name}：只敲时分不再落在系统今天`)
  // parseTzText 的基准缺省会隐式落到 Date.now()（tzText.js）：每处调用都得显式给场景基准（行内已有时刻的沿用该行那天）
  const calls = text.split('\n').filter((l) => l.includes('parseTzText(') && !/^\s*import /.test(l))
  ok(calls.length >= 3 && calls.every((l) => l.includes('sceneBaseMs()')), `${name}：每处 parseTzText 都显式带场景基准（${calls.length} 处）`)
}
ok(fnBody(GPW, 'function editTime(id, val) {').includes('parseTzText(val, tzMode.value, Number.isFinite(s.tMs) ? s.tMs : sceneBaseMs())'), '对地性能表逐格改时间：空行只敲时分落在时间轴那天')

// ⑤ 干扰分析 GRD 树实时星位
const lgt = fnBody(CI, '  function loadGrdTree() {', '\n  }\n')
ok(lgt.includes("read('globe3d/grdLive')") && lgt.includes('(s.noradId || s.elements) ? live[s.folder] : undefined'), '干扰分析 loadGrdTree 按 grdLive 覆盖实时星位（只认此刻仍是实时星的节点）')
ok(lgt.includes('satLon: lon, satLat: lat, satAlt: altKm'), '干扰分析：实时星天线基底也换成实时星位')
ok((CI.match(/if \(a\.node\.noEph\) \{ msg\.value = '关联卫星当前无星历'; return \}/g) || []).length === 2, '干扰分析：关联星无星历时两处 GRD 取值（C/XPI 取值、C/CCI 计算）都不拿旧星位顶替')
// C/CCI 目标波束的足迹（波束图）同样不取：状态落在足迹那一格的报错位上
ok(fnBody(CI, '  async function refreshCciBeams() {', '\n  }\n').includes("if (a.node.noEph) { cci.tgtBeams = null; cci.tgtBeamsErr = '关联卫星当前无星历'; return }"), '干扰分析：关联星无星历时 C/CCI 波束足迹不取值')

// ⑥ lbOrbitSpec
const EP = '2026-09-30T04:00:00.000Z'
const nodeEl = { altKm: 550, ecc: 0.0012, incl: 53, raan: 120, argp: 30, ma: 45, epoch: '2026-09-30T04:00:00Z' }
const tree = [{ folder: 'A', satName: 'A', kind: 'orbit', noradId: null, elements: nodeEl }, { folder: 'L', satName: 'L', kind: 'linked', noradId: 25544, elements: null }]
const legacySpec = { type: 'elements', altKm: 550, ecc: 0.0012, incl: 53, raan: 120, argp: 30, ma: 45, epoch: null, noradId: null }
const nsTree = { mode: 'tree', folder: 'A', orbit: legacySpec }
ok(pickedTreeNode(nsTree, tree) === tree[0] && pickedTreeNode({ ...nsTree, mode: 'search' }, tree) === null && pickedTreeNode({ ...nsTree, folder: 'X' }, tree) === null && pickedTreeNode(nsTree, null) === null, 'pickedTreeNode：tree 模式且 folder 在树里')
const s1 = lbOrbitSpec(nsTree, tree)
ok(s1.epoch === EP && legacySpec.epoch === null && s1 !== legacySpec, '旧条目 + 树节点在 → 补节点历元（规范化），不改库里那份')
ok(lbOrbitSpec({ ...nsTree, folder: 'X' }, tree).epoch === TREE_ORBIT_LEGACY_EPOCH, '节点不在树里 → 旧数据常量（不取此刻）')
ok(lbOrbitSpec({ mode: 'search', orbit: legacySpec }, tree).epoch === TREE_ORBIT_LEGACY_EPOCH, '非树来源缺历元 → 旧数据常量')
ok(lbOrbitSpec({ mode: 'tree', folder: 'L', orbit: legacySpec }, tree).epoch === TREE_ORBIT_LEGACY_EPOCH, '树节点没有根数（关联星）→ 旧数据常量')
const withEp = { ...legacySpec, epoch: '2026-10-01T00:00:00.000Z' }
const staleTree = lbOrbitSpec({ mode: 'tree', folder: 'A', orbit: { ...withEp, ma: 300 } }, tree)
ok(staleTree.epoch === EP && staleTree.ma === 45 && staleTree.type === 'elements', '树来源的根数星：一律按节点现在的根数 + 历元（库里存的旧历元 / 旧根数不送引擎）')
ok(lbOrbitSpec({ mode: 'search', orbit: withEp }, tree).epoch === withEp.epoch, '非树来源已带历元：原样')
const omm = { type: 'omm', noradId: '25544', epoch: '2026-10-05T12:00:00.000Z', meanMotion: 15.5, ecc: 0.0005, incl: 51.6, raan: 10, argp: 20, ma: 30, bstar: 0, mdot: 0, mddot: 0 }
const so = lbOrbitSpec({ mode: 'search', orbit: omm }, tree)
ok(so !== omm && JSON.stringify(so) === JSON.stringify(omm), 'omm 型原样深拷贝')
const snap = { type: 'snapshot', lonDeg: 110.5, latDeg: 0, altKm: 35786 }
ok(JSON.stringify(lbOrbitSpec({ mode: 'tree', folder: 'L', orbit: snap }, tree)) === JSON.stringify(snap), 'snapshot 型原样（关联星节点不按根数重出）')
ok(lbOrbitSpec({ mode: 'tree', orbit: null }, tree) === null && lbOrbitSpec(null, tree) === null, '没有 spec → null')
s1.altKm = 999
ok(nsTree.orbit.altKm === 550, '返回的是深拷贝（改它不动库条目）')

// ⑦ 同一颗星同一处：旧库条目经 lbOrbitSpec → 主进程 buildSatrec，与 3D 页 elementsOmm→omm2satrec 逐位一致
const recCore = buildSatrec(lbOrbitSpec(nsTree, tree))
const recPage = sat.omm2satrec(elementsOmm(nodeEl, 'SIM'))
const recSpec = buildSatrec(treeElementsSpec(nodeEl, null))
ok(recCore.jdsatepoch === recPage.jdsatepoch && recCore.no === recPage.no && recCore.mo === recPage.mo, '旧条目补历元后与 3D 页 satrec 同历元同根数', `jd ${recCore.jdsatepoch}`)
ok(recSpec.jdsatepoch === recCore.jdsatepoch, '与树节点新 spec（treeElementsSpec）同历元')
let same = true
for (const t of [Date.UTC(2026, 9, 6, 0, 0, 0), Date.UTC(2026, 9, 6, 7, 31, 17), Date.UTC(2026, 9, 20, 12, 0, 0)]) {
  const a = sat.propagate(recCore, new Date(t)).position, b = sat.propagate(recPage, new Date(t)).position
  if (!(a && b && a.x === b.x && a.y === b.y && a.z === b.z)) same = false
}
ok(same, '同一绝对时刻两边位置逐位一致（不再随计算那一刻漂）')

// ⑧ scenarioEpochPatch：自定义星座搜索选星
localStorage.setItem('constellation3d/customConsts', JSON.stringify({ items: [{ name: 'TEST', params: { name: 'TEST', pattern: 'delta', T: 6, P: 2, F: 1, incl: 55, shape: 'circ', perigeeKm: 1200, apogeeKm: 1200, argp: 0, raan0: 0, m0: 0 } }] }))
const cust = loadCustomSats()
const curEp = resolveScenarioEpoch(JSON.parse(localStorage.getItem('constellation3d/customConsts')))
ok(cust.sats.length === 6 && cust.epoch === curEp && cust.sats[0].epoch === curEp, '自定义星座池记录带当前场景历元', curEp)
const rec = cust.sats[2], e = rec.elements
const stale = { type: 'elements', altKm: Number(e.altKm) || 0, ecc: Number(e.ecc) || 0, incl: Number(e.incl) || 0, raan: Number(e.raan) || 0, argp: Number(e.argp) || 0, ma: Number(e.ma) || 0, epoch: '2026-01-02T00:00:00.000Z', noradId: rec.noradId }
const p = scenarioEpochPatch(stale, cust.sats)
ok(p && p.epoch === curEp && stale.epoch === '2026-01-02T00:00:00.000Z' && p.raan === stale.raan && p.noradId === stale.noradId, '选星拍下的旧场景历元 → 当前场景历元（不改入参、根数不动）')
ok(scenarioEpochPatch({ ...stale, epoch: curEp }, cust.sats) === null, '已是当前场景历元 → 不动')
ok(scenarioEpochPatch({ ...stale, raan: stale.raan + 1 }, cust.sats) === null, '星座改过参数（根数对不上）→ 不动')
ok(scenarioEpochPatch({ ...stale, noradId: '123' }, cust.sats) === null && scenarioEpochPatch({ ...stale, noradId: null }, cust.sats) === null, '号对不上 / 没有号（树里根数星）→ 不动')
ok(scenarioEpochPatch({ ...omm }, cust.sats) === null && scenarioEpochPatch(null, cust.sats) === null && scenarioEpochPatch(stale, null) === null, '非 elements / 空 → 不动')
const recCc = buildSatrec(p)
ok(Math.abs(recCc.jdsatepoch + (recCc.jdsatepochF || 0) - (Date.parse(curEp) / 86400000 + 2440587.5)) < 1e-9, '刷新后的 spec 送主进程即按当前场景历元建星')

// ⑧b 轨道向导里地固 / 日固设计量的星座（体检 2026-10-16 #4）：池记录按当前场景历元重解 RAAN、带 epochFrame；
//     库条目拍下的是选星那天的 RAAN —— 其余根数相同、RAAN 恰好差这段历元的 GMST / 太阳平黄经增量才认，连 RAAN 一起换
{
  const { default: OD } = await import('../../../src/viz/constellation/orbitDesign.js')
  const { customConstSats } = await import('../../../src/viz/constellation/customConstGen.js')
  const RAD = 180 / Math.PI, DAY = 86400000
  const gm = (ms) => sat.gstime(new Date(ms))
  const curMs = Date.parse(curEp), E_OLD = curMs - 30 * DAY, oldIso = new Date(E_OLD).toISOString()
  const solveOld = (type, inp) => OD.solveDesign(type, inp, E_OLD, { gmst: gm(E_OLD) }).seed
  const geoIn = { subLonDeg: 110.5, inclDeg: 0 }, ssoIn = { driver: 'alt', altKm: 800, localTime: '10:30', localMode: 'ltan' }
  // 30 天前用向导建的两座（params 是那天解的）+ 一座纯 Walker
  const items = [
    { id: 'g', name: 'GEO', params: OD.seedToParams(solveOld('geosync', geoIn), { pattern: 'single' }, 'GEO'), design: { type: 'geosync', inputs: geoIn }, noradBase: 900000 },
    { id: 's', name: 'SSO', params: OD.seedToParams(solveOld('sunSync', ssoIn), { pattern: 'delta', T: 6, P: 3, F: 1 }, 'SSO'), design: { type: 'sunSync', inputs: ssoIn }, noradBase: 910000 },
    { id: 't', name: 'TEST', params: { name: 'TEST', pattern: 'delta', T: 6, P: 2, F: 1, incl: 55, shape: 'circ', perigeeKm: 1200, apogeeKm: 1200, argp: 0, raan0: 0, m0: 0 }, noradBase: 920000 }
  ]
  localStorage.setItem('constellation3d/customConsts', JSON.stringify({ items }))
  const cs = loadCustomSats()
  const ep = cs.epoch, epMs = Date.parse(ep)   // 当前场景历元按池里解出的那个比（不怕跑测试时恰好跨过零点）
  const byNo = (n) => cs.sats.find((r) => r.noradId === String(n))
  const g = byNo(900000), s4 = byNo(910004), t2 = byNo(920002)
  ok(g && s4 && t2 && g.epochFrame === 'earth' && s4.epochFrame === 'sun' && !('epochFrame' in t2), '池记录：地固 / 日固设计量带 epochFrame，惯性 RAAN 的不带')
  ok(Math.abs(OD.raanToLon(g.elements.raan + g.elements.argp + g.elements.ma, gm(epMs)) - 110.5) < 1e-9, '★ 池记录（NGSO / 再生式 / 端到端 / 工作台取星）：30 天前建的地球同步星在当前场景历元仍是 110.5°E')
  ok(Math.abs(OD.raanToLtan(byNo(910000).elements.raan, epMs) - 10.5) < 1e-9, '★ 池记录：30 天前建的太阳同步星当前 LTAN 仍是 10:30')
  // 30 天前选星拍下的 spec（satSearchPool.orbitSpecOf 的形状；RAAN 是那天的）
  const specOf = (c, i, no) => { const el = customConstSats(c, oldIso)[i].elements; return { type: 'elements', noradId: String(no), epoch: oldIso, altKm: el.altKm, ecc: el.ecc, incl: el.incl, raan: el.raan, argp: el.argp, ma: el.ma } }
  const sg = specOf(items[0], 0, 900000), ss = specOf(items[1], 4, 910004)
  const pg = scenarioEpochPatch(sg, cs.sats), ps = scenarioEpochPatch(ss, cs.sats)
  ok(pg && pg.epoch === ep && pg.raan === g.elements.raan && pg.ma === sg.ma && pg.incl === sg.incl && sg.epoch === oldIso, '★ 库条目（地固）：历元与 RAAN 一起换成当前的（不改入参）')
  ok(ps && ps.epoch === ep && ps.raan === s4.elements.raan && ps.ma === ss.ma, '★ 库条目（日固，第 3 面那颗）：历元与 RAAN 一起换成当前的')
  const rg = buildSatrec(pg)
  ok(Math.abs(OD.raanToLon((rg.nodeo + rg.argpo + rg.mo) * RAD, rg.gsto) - 110.5) < 1e-9, '★ 换过的 spec 送主进程 buildSatrec：当前场景历元下仍在 110.5°E')
  ok(scenarioEpochPatch({ ...sg, raan: sg.raan + 0.5 }, cs.sats) === null, '设计改过（RAAN 差的不是这段历元增量）→ 不动')
  ok(scenarioEpochPatch({ ...sg, raan: g.elements.raan }, cs.sats) === null, '旧历元配当前 RAAN（修复前建的老星座重新生成后）→ 认不出、不动')
  ok(scenarioEpochPatch({ ...sg, incl: 1 }, cs.sats) === null && scenarioEpochPatch({ ...sg, epoch: null }, cs.sats) === null, '其余根数对不上 / 拍下时没有历元 → 不动')
  const st = specOf(items[2], 2, 920002), pt = scenarioEpochPatch(st, cs.sats)
  ok(pt && pt.epoch === ep && pt.raan === st.raan, '惯性 RAAN 的星座照旧只换历元')
  ok(/customConstParams\(c, epoch\)/.test(CI), '干扰分析：自定义星座的参数按场景历元重解（customConstParams）')
}

// ⑨ e2eParams.orbitSpecOf(cfg, treeSats)
const cfgN = { form: { orbitClass: 'NGSO', orbitAltitude: '550', orbitInclination: '53' }, ngsoSat: { mode: 'tree', folder: 'A', orbit: legacySpec, name: 'A', noradId: null } }
ok(e2eOrbitSpecOf(cfgN, tree).epoch === EP, '端到端：树来源旧条目补节点历元')
ok(e2eOrbitSpecOf(cfgN).epoch === TREE_ORBIT_LEGACY_EPOCH, '端到端：不给树 → 旧数据常量（不取此刻）')
ok(JSON.stringify(e2eOrbitSpecOf({ form: { orbitClass: 'GSO', orbitLongitude: '110.5' } }, tree)) === JSON.stringify({ type: 'snapshot', lonDeg: 110.5, latDeg: 0, altKm: 35786 }), '端到端：GSO 定点不受影响')
ok(JSON.stringify(e2eOrbitSpecOf({ form: { orbitClass: 'NGSO', orbitAltitude: '550', orbitInclination: '53' }, ngsoSat: { mode: 'manual', orbit: null } }, tree)) === JSON.stringify({ type: 'circular', altKm: 550, inclDeg: 53 }), '端到端：手填圆轨道不受影响')

// ⑩ pinCircularEpoch：手动圆轨道历元钉到 t0 → 星间几何只由 t0 定，不随点「计算」的那一刻漂
const T0 = '2026-03-15T00:00:00.000Z'
const cA = { type: 'circular', altKm: 550, inclDeg: 53 }, cB = { type: 'circular', altKm: 1200, inclDeg: 87 }
const pA = pinCircularEpoch(cA, T0)
ok(pA !== cA && pA.epoch === T0 && cA.epoch === undefined && pA.altKm === 550 && pA.inclDeg === 53, '圆轨道缺历元 → 钉 t0（新对象，不改入参）')
ok(pinCircularEpoch({ ...cA, epoch: '2026-01-01T00:00:00.000Z' }, T0).epoch === '2026-01-01T00:00:00.000Z', '已带历元原样')
ok(pinCircularEpoch(omm, T0) === omm && pinCircularEpoch(snap, T0) === snap && pinCircularEpoch(legacySpec, T0) === legacySpec, '非圆轨道原样（同一对象）')
ok(pinCircularEpoch(null, T0) === null && pinCircularEpoch(cA, '') === cA, '空 spec / 没给 t0 → 原样')
const islOpt = (a, b) => ({ orbitA: a, orbitB: b, t0ISO: T0, horizonHours: 6, freqGHz: 23 })
const g1 = solveIslWorstCase(islOpt(pA, pinCircularEpoch(cB, T0)))
const g2 = solveIslWorstCase(islOpt({ ...cA, epoch: T0 }, { ...cB, epoch: T0 }))
ok(g1.feasible && g1.worst.rangeKm === g2.worst.rangeKm && g1.visibility.visibleFrac === g2.visibility.visibleFrac, '钉 t0 后星间最差距离 / 互视占比只由 t0 定', `${g1.worst.rangeKm.toFixed(1)} km`)
const iso7 = new Date(Date.parse(T0) + 7 * 60000).toISOString()
const g3 = solveIslWorstCase(islOpt({ ...cA, epoch: iso7 }, { ...cB, epoch: iso7 }))
ok(g3.feasible && (g3.worst.rangeKm !== g1.worst.rangeKm || g3.visibility.visibleFrac !== g1.visibility.visibleFrac), '圆轨道历元差 7 分钟结果就变（不钉则随计算那一刻漂）', `${g3.worst.rangeKm.toFixed(1)} km`)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
