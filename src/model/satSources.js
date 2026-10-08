// 卫星页的「选星」来源与分析页的「轨道」解析（渲染端，走 window.api 只读通道 + 同源 localStorage）。
//
// 三路来源（DESIGN2 §3 卫星页）：
//   ① 目录星：ngso/satSearchPool.js 的共享候选池（CelesTrak active 全域 + 常用名组 + 本机自定义卫星库 + 星历点序列 + Walker 自定义星座）——
//      与 NGSO / 端到端窗口「搜索卫星」同一份池，同一颗星在几处算出同一个几何；
//   ② 链路预算四窗卫星库条目：window.api.store.getLibrary(ns)（ns = geo / ngso / regen / e2e，userData/library.json 的分区）；
//   ③ GRD 树星：localStorage('globe3d/settings').grd.sats（星座 3D 页持久化的卫星树，同源共享，ngso/satTree.js 读法）。
// 绑定键（schema.mjs）：目录星 norad:<号>（< 800000）、星历点序列 ephem:<组>:<key>、Walker 合成星 cc:<星座 id>:<名>、
//   GRD 树无目录身份的星 grdsat:<folder>、库条目 lbsat:<ns>:<条目 id>、其余 name:<名>。
//   树节点 → 键的完整规则（合成号查池、仰角线跳过，与 3D 页同一套）在 satPickLogic.treeKeyOf。
//
// 轨道（分析页用）：resolveOrbit(satKey, hint) → { kind:'prop', prop }（satrec 或星历表，取位唯一入口 satPos.posAt）
//   | { kind:'fixed', rEcef }（GRD 预置 GEO 星这类只有星下点快照的）| null。stateFn(orbit)(tMs) → {rEcef, vEcef, gmstRad}：
//   TEME → ECEF 只做绕极轴转 GMST（与 satellite.js eciToEcf、bodyRuntime.stateInto 同式），速度是【惯性速度】的 ECEF 分量。
//   树节点解出的轨道另带 treeFolder（satStore 据此判 3D 页改了哪个节点、当前轨道要不要作废）。
// 六根数的历元：树节点存在 node.elements.epoch（shared/treeOrbitEpoch.js，全软件同一口径）；没有的旧数据按固定常量，不取「此刻」——
//   取此刻就成了每个窗口 / 每次解析各一个历元，同一时刻工作台与 3D 页的星不在轨道同一处。
import sat from '../viz/constellation/satellite.js'
import { posAt } from '../viz/constellation/satPos.js'
import { tableFrom } from '../viz/constellation/ephemTable.js'
import { ensureSearchPool, loadCustomSats } from '../ngso/satSearchPool.js'
import { generateConstellation } from '../viz/constellation/walker.js'
import { customConstellationsToOmmRecords } from '../viz/constellation/useCustomConstellations.js'
import { loadSatTree } from '../ngso/satTree.js'
import { geodeticToEcef, RS_GEO } from '../viz/wgs84.js'
import { gmstRadAt } from '@core/models/attitude.mjs'
import { SATKEY_NORAD_MAX, grdSatKey, lbSatKey } from '@core/models/schema.mjs'
import { lbAntennaSummary, lbAntennaInfo } from './mountLogic.js'
import { freshTreeNode, lbTreeNode } from './satPickLogic.js'
import { elementsOmm, orbitSpecWithEpoch } from '../shared/treeOrbitEpoch.js'
import { scenarioEpochPatch } from '../shared/lbTreeOrbit.js'

const api = typeof window !== 'undefined' ? window.api : null
const CUSTOM_KEY = 'constellation3d/customConsts', NORAD_BASE = 900000, NORAD_STEP = 10000
export const LB_NS = ['geo', 'ngso', 'regen', 'e2e']

// ───────────────────────────── ③ GRD 树 ─────────────────────────────

/** GRD 卫星树（含天线名）：[{folder, satName, noradId, kind, lon, lat, altKm, omm, elements, antennas:[{name}]}] */
export function grdTreeSats() {
  let grd = null
  try { grd = JSON.parse(localStorage.getItem('globe3d/settings') || 'null')?.grd } catch { grd = null }
  const base = loadSatTree().sats
  const byFolder = new Map(((grd && grd.sats) || []).map((s) => [s.folder, s]))
  return base.map((s) => {
    const raw = byFolder.get(s.folder) || {}
    return { ...s, antennas: (raw.antennas || []).filter((a) => a && a.name).map((a) => ({ name: a.name, band: a.band || '', imported: !!a.imported })) }
  })
}

/**
 * mountLogic.hpbwOf / fovFullOf / coneHalfOf 的外部取值（ext）：
 *   grdPeakDbi(folder|name)：GRD 树导入天线的峰值增益（3D 页卫星树存的 peakDb，存活波束里最高的那个）+ 该天线的增益偏置；
 *   lbInfo(ns:id)：链路预算卫星库条目的 G/T、挂的 G/T 方向图（mountLogic.lbAntennaInfo）。
 * @param {object[]} [lbList] lbLibrarySats() 的结果（没给只认 GRD）
 */
export function antennaExt(lbList = []) {
  let g = null
  try { g = JSON.parse(localStorage.getItem('globe3d/settings') || 'null')?.grd } catch { g = null }
  const peaks = new Map()
  for (const s of (g && Array.isArray(g.sats) ? g.sats : [])) {
    for (const a of (s && Array.isArray(s.antennas) ? s.antennas : [])) {
      if (!a || !a.name || !Number.isFinite(a.peakDb)) continue
      const key = `${s.folder}|${a.name}`
      const c = g.cfgs && typeof g.cfgs === 'object' ? g.cfgs[key] : null
      peaks.set(key, a.peakDb + (c && Number.isFinite(c.gainOffset) ? c.gainOffset : 0))
    }
  }
  const lb = new Map((Array.isArray(lbList) ? lbList : []).filter((e) => e && e.ns && e.id).map((e) => [`${e.ns}:${e.id}`, e]))
  return {
    grdPeakDbi: (key) => (peaks.has(key) ? peaks.get(key) : null),
    lbInfo: (id) => { const e = lb.get(id); return e ? lbAntennaInfo(e) : null }
  }
}

// ───────────────────────────── ② 链路预算卫星库 ─────────────────────────────

/**
 * 四窗卫星库条目：[{ns, id, name, summary, form, ngsoSat?, grd?}]（读不到的窗口跳过）。
 * summary = 频段 · 上 / 下行频率 · G/T · EIRP（有的才列）· GEO 轨位（mountLogic.lbAntennaSummary；天线下拉的短标签）
 */
export async function lbLibrarySats() {
  const out = []
  if (!api || !api.store || !api.store.getLibrary) return out
  // 四个分区并发读（各自兜错），出参仍按 LB_NS 的顺序排
  const libs = await Promise.all(LB_NS.map(async (ns) => { try { return await api.store.getLibrary(ns) } catch { return null } }))
  for (let i = 0; i < LB_NS.length; i++) {
    const ns = LB_NS[i], lib = libs[i]
    for (const e of (lib && Array.isArray(lib.sat) ? lib.sat : [])) {
      if (!e || !e.id) continue
      const f = e.form || {}
      const rec = { ns, id: e.id, name: String(f.satelliteName || e.name || e.id), summary: '', form: f, ngsoSat: e.ngsoSat || null, grd: e.grd || null }
      rec.summary = lbAntennaSummary(rec)
      out.push(rec)
    }
  }
  return out
}

// ───────────────────────────── ① 目录星（共享候选池） ─────────────────────────────

// Walker 自定义星座：池记录只有合成 NORAD 号，按 3D 页同一套号段规则（noradBase 或 900000 起每座 +10000）反查星座 id
function customNoradMap() {
  const map = new Map()
  let blob = null
  try { blob = JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null') } catch { blob = null }
  if (!blob || !Array.isArray(blob.items)) return map
  let base = NORAD_BASE
  for (const c of blob.items) {
    const b = Number.isFinite(c.noradBase) ? c.noradBase : base
    let gen = []
    try { gen = generateConstellation(c.params || {}) } catch { gen = [] }
    for (let i = 0; i < gen.length; i++) map.set(String(b + i), { cfgId: c.id, name: gen[i].name })
    base += NORAD_STEP
  }
  return map
}
/** 池记录 → 绑定键（与 3D 页 satKeyOf 对同一颗星给出同一个键） */
export function poolKeyOf(rec, ccMap) {
  if (!rec) return null
  if (rec.orbitType === 'ephem' && rec.ref && rec.ref.groupId) return `ephem:${rec.ref.groupId}:${String(rec.ref.key || rec.name).trim()}`
  const n = Number(rec.noradId)
  if (rec.orbitType === 'elements' || n >= SATKEY_NORAD_MAX) {
    const c = ccMap && ccMap.get(String(rec.noradId))
    if (c && c.cfgId) return `cc:${c.cfgId}:${String(c.name || rec.name).trim()}`
    return rec.name ? `name:${String(rec.name).trim()}` : null
  }
  if (Number.isInteger(n) && n >= 1 && n < SATKEY_NORAD_MAX) return `norad:${n}`
  return rec.name ? `name:${String(rec.name).trim()}` : null
}
let _pool = null, _poolP = null, _cc = null, _sig = '', _gen = 0
// 本机自定义星座（星座页「生成卫星或星座」/ 编辑）的存档原文：池里 cc: 键与合成号都从它来，变了池就过时
const localSig = () => { try { return localStorage.getItem(CUSTOM_KEY) || '' } catch { return '' } }
/** 池建好之后本机自定义星座变了 → 过时（下次 catalogPool() 重建；天线树关联合成号的键要按新星座算，才与 3D 页一致） */
export function catalogPoolStale() { return !!_pool && _sig !== localSig() }
/** 作废候选池（连共享单例一起重建）：自定义星座 / 导入星历变了之后用 */
export function invalidateCatalogPool() { _gen++; _pool = null; _poolP = null; _cc = null; ensureSearchPool(true) }
/**
 * 候选池（按需建一次；与 NGSO / 端到端共用单例）：[{rec, key, name, altName, norad, group}]。
 * 数组上另挂两张只读索引（不可枚举，遍历 / find 的老调用方不受影响）：
 *   byNorad：NORAD 字符串 → 行（同号取池里第一条，与原先 pool.find 同一个结果）；byKey：绑定键 → 行（同键取第一条）。
 * 并发调用共用同一次构建；构建失败下次重试。本机自定义星座变了自动重建（catalogPoolStale）。
 */
export function catalogPool() {
  if (catalogPoolStale()) invalidateCatalogPool()
  if (_pool) return Promise.resolve(_pool)
  if (!_poolP) {
    const gen = _gen
    const p0 = (async () => {
      const sig = localSig()
      const p = await ensureSearchPool()
      if (gen !== _gen) return catalogPool()   // 建的途中被作废：改搭新的那一次
      _cc = customNoradMap()
      const rows = p.all.map((r) => ({ rec: r, key: poolKeyOf(r, _cc), name: r.name, altName: r.altName || '', norad: String(r.noradId || ''), group: r.groupLabel || '' })).filter((x) => x.key)
      const byNorad = new Map(), byKey = new Map()
      for (const x of rows) {
        if (x.norad && !byNorad.has(x.norad)) byNorad.set(x.norad, x)
        if (!byKey.has(x.key)) byKey.set(x.key, x)
      }
      Object.defineProperties(rows, { byNorad: { value: byNorad }, byKey: { value: byKey } })
      _pool = rows; _sig = sig
      return rows
    })().finally(() => { if (_poolP === p0) _poolP = null })
    _poolP = p0
  }
  return _poolP
}
/** 已建好的候选池（没建好返回 null；不触发构建）——选星时同步回填用 */
export function catalogPoolReady() { return _pool }
const norm = (s) => String(s || '').toUpperCase().replace(/[\s\-_()（）]+/g, '')
/** 搜索：名称 / 常用名 / NORAD 号，最多 max 条（按名前缀命中优先） */
export function searchPool(pool, q, max = 200) {
  const k = norm(q)
  if (!k) return []
  const pre = [], mid = []
  for (const x of pool) {
    const nm = norm(x.name), alt = norm(x.altName)
    if (x.norad === q.trim() || nm.startsWith(k) || alt.startsWith(k)) pre.push(x)
    else if (nm.includes(k) || alt.includes(k)) mid.push(x)
    if (pre.length >= max) break
  }
  return pre.concat(mid).slice(0, max)
}

// ───────────────────────────── 轨道解析 ─────────────────────────────

function satrecFromOmm(rec) {
  try { const r = sat.omm2satrec(rec); return r && !r.error ? r : null } catch { return null }
}
// 六根数 → satrec：与 3D 页、主进程 buildSatrec 同一份换算（elementsOmm）；历元取 el.epoch（规范化），没有按旧数据常量
function satrecFromElements(el, noradId) {
  return satrecFromOmm(elementsOmm(el, noradId || 99999))
}
async function ephemProp(groupId, key) {
  if (!api || !api.omm || !api.omm.ephemTable) return null
  let t = null
  try { t = await api.omm.ephemTable(groupId) } catch { t = null }
  const s = ((t && t.sats) || []).find((x) => x && (x.key === key || x.name === key))
  return s ? tableFrom(s) : null
}
/** 轨道 spec（satSearchPool.orbitSpecOf / 库条目 ngsoSat.orbit 的形状）→ 传播体 */
async function propOfSpec(spec) {
  if (!spec || typeof spec !== 'object') return null
  if (spec.type === 'omm') return satrecFromOmm({ ...spec, noradId: String(spec.noradId || 99999) })
  if (spec.type === 'elements') return satrecFromElements(orbitSpecWithEpoch(spec), spec.noradId)   // 旧库条目 epoch: null → 常量
  if (spec.type === 'ephem' && spec.ref) return ephemProp(spec.ref.groupId, spec.ref.key)
  return null
}
async function propOfPoolRec(rec) {
  if (!rec) return null
  if (rec.orbitType === 'ephem') return rec.ref ? ephemProp(rec.ref.groupId, rec.ref.key) : null
  if (rec.orbitType === 'elements') return satrecFromElements({ ...(rec.elements || {}), epoch: rec.epoch }, rec.noradId)   // 自定义星座：场景历元
  return satrecFromOmm(rec)
}
function fixedAt(lonDeg, latDeg, altKm) {
  const lon = Number(lonDeg), lat = Number(latDeg) || 0, alt = Number(altKm)
  if (!Number.isFinite(lon)) return null
  return { kind: 'fixed', rEcef: geodeticToEcef(lon, lat, Number.isFinite(alt) ? alt : RS_GEO - 6378.137) }
}
/** GRD 树节点 → 轨道（OMM / 六根数 / NORAD 反查池 / 星下点快照）；结果带 treeFolder = 节点 folder */
async function orbitOfTreeNode(node) {
  if (!node) return null
  const o = await treeNodeOrbitRaw(node)
  return o && node.folder != null ? { ...o, treeFolder: String(node.folder) } : o
}
async function treeNodeOrbitRaw(node) {
  if (node.omm) { const r = satrecFromOmm({ ...node.omm, noradId: String(node.omm.noradId || node.noradId || 99999) }); if (r) return { kind: 'prop', prop: r } }
  // 六根数：历元 = 节点自己的（node.elements.epoch，elementsOmm 里经 treeOrbitEpoch 规范化）
  if (node.elements) { const r = satrecFromElements(node.elements, node.noradId); if (r) return { kind: 'prop', prop: r } }
  if (node.noradId) {
    const pool = await catalogPool()
    const hit = pool.byNorad.get(String(node.noradId))
    if (hit) { const p = await propOfPoolRec(hit.rec); if (p) return { kind: 'prop', prop: p } }
  }
  return fixedAt(node.lon, node.lat, node.altKm)
}

/**
 * 绑定键 → 轨道。hint（可选）：{poolRec, lbEntry, treeNode}——选星时手里已有的记录，免得再查一遍。
 * 从天线树节点解出的带 treeFolder（该节点的 folder）。
 * @returns {Promise<{kind:'prop', prop, treeFolder?:string}|{kind:'fixed', rEcef:number[], treeFolder?:string}|null>}
 */
export async function resolveOrbit(satKey, hint = {}) {
  const k = String(satKey || '')
  try {
    if (hint.poolRec) { const p = await propOfPoolRec(hint.poolRec); if (p) return { kind: 'prop', prop: p } }
    if (hint.treeNode) return await orbitOfTreeNode(freshNode(hint.treeNode))
    if (hint.lbEntry) return await orbitOfLbEntry(hint.lbEntry)
    let m
    if ((m = /^norad:(\d+)$/.exec(k))) {
      const pool = await catalogPool()
      const hit = pool.byNorad.get(m[1])
      if (hit) { const p = await propOfPoolRec(hit.rec); if (p) return { kind: 'prop', prop: p } }
      const node = grdTreeSats().find((s) => String(s.noradId) === m[1])
      return node ? await orbitOfTreeNode(node) : null
    }
    if ((m = /^ephem:([^:]+):(.+)$/.exec(k))) { const p = await ephemProp(m[1], m[2]); return p ? { kind: 'prop', prop: p } : null }
    if ((m = /^cc:([^:]+):(.+)$/.exec(k))) {
      const rec = customConstellationsToOmmRecords(m[1]).find((r) => String(r.name).trim() === m[2])
      const p = rec ? satrecFromOmm(rec) : null
      return p ? { kind: 'prop', prop: p } : null
    }
    if ((m = /^grdsat:(.+)$/.exec(k))) return await orbitOfTreeNode(grdTreeSats().find((s) => s.folder === m[1]))
    if ((m = /^lbsat:([^:]+):(.+)$/.exec(k))) {
      const e = (await lbLibrarySats()).find((x) => x.ns === m[1] && x.id === m[2])
      return e ? await orbitOfLbEntry(e) : null
    }
    if ((m = /^name:(.+)$/.exec(k))) {
      const pool = await catalogPool()
      const hit = pool.find((x) => String(x.name).trim() === m[1])
      if (hit) { const p = await propOfPoolRec(hit.rec); if (p) return { kind: 'prop', prop: p } }
      const node = grdTreeSats().find((s) => s.satName === m[1])
      return node ? await orbitOfTreeNode(node) : null
    }
  } catch (e) { console.warn('[modelwb] 解析轨道失败：' + ((e && e.message) || e)) }
  return null
}
// 库条目里的 elements spec 若是本机自定义星座的星（同号、六根数逐位相同）：历元换成当前场景历元；认不出 / 不用换原样返回。
// loadCustomSats 要把各星座现生成一遍，只对带 NORAD 的 elements 型才读
function withScenarioEpoch(spec) {
  if (!spec || spec.type !== 'elements' || spec.noradId == null || spec.noradId === '') return spec
  let cust = []
  try { cust = loadCustomSats().sats } catch { cust = [] }
  return scenarioEpochPatch(spec, cust) || spec
}
// hint 里的树节点是选星那一刻的快照：按 folder 换成树里现在的（3D 页改了根数 / 历元），树里没了才用快照
function freshNode(n) {
  if (!n || n.folder == null) return n
  let nodes = []
  try { nodes = grdTreeSats() } catch { nodes = [] }
  return freshTreeNode(n, nodes)
}
/**
 * 链路预算库条目 → 轨道：从天线树挑的星且轨道由节点自己定义（satPickLogic.lbTreeNode）→ 按现在的节点解；
 * 其余 ngsoSat.orbit（spec；elements 型缺历元补常量）> ngsoSat.noradId（池）> 引了 GRD 树星 > GEO 定点经度。
 * 自定义星座星的 spec 存的是挑星那天的场景历元：先换成当前的（lbTreeOrbit.scenarioEpochPatch，与链路预算三窗同一口径，只换不回写库）。
 */
async function orbitOfLbEntry(e) {
  const ns = e.ngsoSat || {}
  const tn = ns.mode === 'tree' ? lbTreeNode(e, grdTreeSats()) : null
  if (tn) { const o = await orbitOfTreeNode(tn); if (o) return o }
  if (ns.orbit) { const p = await propOfSpec(withScenarioEpoch(ns.orbit)); if (p) return { kind: 'prop', prop: p } }
  const nid = ns.noradId || (ns.orbit && ns.orbit.noradId)
  if (nid) {
    const pool = await catalogPool()
    const hit = pool.byNorad.get(String(nid))
    if (hit) { const p = await propOfPoolRec(hit.rec); if (p) return { kind: 'prop', prop: p } }
  }
  const folder = ns.folder || (e.grd && e.grd.satFolder)
  if (folder) { const node = grdTreeSats().find((s) => s.folder === folder); if (node) return orbitOfTreeNode(node) }
  const lon = e.form && e.form.orbitPosition
  if (lon !== undefined && lon !== '' && Number.isFinite(Number(lon))) return fixedAt(Number(lon), 0, RS_GEO - 6378.137)
  return null
}

/** 轨道 → 取位函数 tMs → {rEcef, vEcef|null, gmstRad} | null（posAt 是渲染端唯一取位入口） */
export function stateFn(orbit) {
  if (!orbit) return () => null
  if (orbit.kind === 'fixed') { const r = orbit.rEcef.slice(); return (t) => ({ rEcef: r, vEcef: null, gmstRad: gmstRadAt(t) }) }
  const prop = orbit.prop
  return (t) => {
    const pv = posAt(prop, t)
    if (!pv || !pv.position) return null
    const g = gmstRadAt(t), c = Math.cos(g), s = Math.sin(g)
    const p = pv.position, v = pv.velocity
    const rEcef = [p.x * c + p.y * s, -p.x * s + p.y * c, p.z]
    const vEcef = v && Number.isFinite(v.x) ? [v.x * c + v.y * s, -v.x * s + v.y * c, v.z] : null
    return { rEcef, vEcef, gmstRad: g }
  }
}

export { grdSatKey, lbSatKey }
