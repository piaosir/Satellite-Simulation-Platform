// 应用场景仿真 · 渲染端场景状态（模块级 reactive，非 Pinia）。
//
// 为什么是模块级单例而不是组合式函数：这份状态要被三处同时读写 ——
// 侧栏面板（ScenePanel.vue）、拓扑视图（SceneTopology.vue）、3D 页的地图渲染
// （ConstellationMap3D.vue，11k 行）。做成 composable 就得把它穿过那个巨型页面
// 一路传 props；做成模块级单例，三处各自 import 即可，且天然是同一份数据 ——
// 「两种可视化是同一个场景的两个投影」这条设计约束在数据层就成立了。

import { reactive, computed, watch } from 'vue'
import { clock } from '../../stores/simClock.js'
import { orbitFromPoolRec, applyOrbitToForm } from '../../shared/satPick.js'
import {
  readWholeLibrary, writeSatList, normSatEntry, blankSatEntry, maxSatSeq,
  resolveSatNode, satOrbitSpec, satBrief
} from './sceneSatLib.js'

// ★ preload 暴露的全局名是 window.api（不是 electronAPI）—— 写错的话整个功能在真实应用里
//   静默失效：所有 IPC 调用都变成 undefined?.() 的可选链，不报错、也永远拿不到数据。
const api = () => (typeof window !== 'undefined' && window.api) || {}
const scn = () => (api().scene || {})
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

// 出厂载波体制：与端到端窗口的缺省一致（一条业务贯穿全链，各段可再改）
export const DEFAULT_CARRIER = {
  modulation: 'QPSK', fec: '3/4', ebno: '5.50', ber: '7', m: '1.00',
  bandwidthFactor: '1.20', rsCode: '188/204', noiseRatioMode: 'ebno'
}

export const scene = reactive({
  // ── 场景数据（存档就是这四项）──
  id: '', name: '未命名场景', tplId: '',
  modules: [], links: [], flows: [],
  carrier: { ...DEFAULT_CARRIER },
  nudge: {},                 // 拓扑图的手动微调 { modId: {dx,dy} }

  // ── 呈现态（不落存档）──
  view: 'map',               // 'map' 地理视图 | 'topo' 拓扑图
  sel: null,                 // { type:'module'|'link'|'flow', id }
  placing: null,             // 正在放置的库条目 id（点图落点）
  linking: null,             // 正在连线 { modId, portKey }
  editPos: false,            // ★ 位置解锁闸：照标记层的既定口径，不点「调整位置」不许拖
  showLayer: true,           // 场景层显隐
  labels: true,              // 显示模块名
  showLinks: true,           // 显示连线

  // ── 库与目录（IPC 取一次，缓存）──
  lib: [], libTree: [], catalog: null, templates: [], industries: [],
  libReady: false, libError: '',
  // ── 平台卫星库（library.json 的 'e2e'.sat，与端到端窗口共用同一份）──
  // ★ 卫星不在模块库里：一条卫星定义一次，两个工作台都用。见 sceneSatLib.js 的头注。
  satLib: [], satLibReady: false, satLibError: '', satPresets: [],

  // ── 计算 ──
  result: null, busy: false, error: '', dirty: true, ms: 0,
  // 几何预解：星地 / 星间边按真轨道解出的斜距与仰角（key 见 geoKeyOf）。
  // 解不出（无网 / 无星历 / 缺站址）就留空，core 退回圆轨道最差几何的闭式并照旧告警。
  geo: {}, geoWarn: [], geoBusy: false
})

// ── 索引 ──
export const modById = computed(() => new Map(scene.modules.map((m) => [m.id, m])))
export const libById = computed(() => new Map(scene.lib.map((m) => [m.id, m])))
export const linkById = computed(() => new Map(scene.links.map((l) => [l.id, l])))
export const satById = computed(() => new Map(scene.satLib.map((c) => [c.id, c])))
export const libOf = (m) => (m ? libById.value.get(m.libId) || null : null)
/** 场景实例引用的卫星库条目（kind:'sat' 的实例走这条） */
export const satEntryOf = (m) => (m && m.kind === 'sat' ? satById.value.get(m.satId) || null : null)
export const isSat = (m) => !!(m && m.kind === 'sat')

/** 实例的有效值：库条目 + 逐条覆盖（ov）。渲染与检查器都走它，别各算各的 */
export function effective(m) {
  // 卫星：库在平台卫星库里，形状由 sceneSatLib.resolveSatNode 拼（与 core 的同名函数同构）
  if (isSat(m)) {
    const e = satEntryOf(m)
    if (!e) return null
    const r = resolveSatNode(e, m)
    r.instId = m.id
    return r
  }
  const b = libOf(m)
  if (!b) return null
  const out = JSON.parse(JSON.stringify(b))
  deepAssign(out, m.ov || {})
  out.instId = m.id
  out.name = m.name || b.zh
  out.place = Object.assign({ mode: 'fixed' }, b.place, m.place || {})
  return out
}
function deepAssign(dst, src) {
  for (const k of Object.keys(src || {})) {
    const v = src[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) { if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {}; deepAssign(dst[k], v) }
    else dst[k] = v
  }
  return dst
}
export { deepAssign }

/** 模块的绝对坐标（挂载件取宿主的）。拿不到返回 null —— 不拿 0 顶替 */
export function placeOf(mid) {
  let m = modById.value.get(mid), d = 0
  while (m && m.place && m.place.mode === 'mounted' && m.place.hostId && d++ < 8) m = modById.value.get(m.place.hostId)
  const p = m && m.place
  return (p && p.lat != null && p.lon != null) ? p : null
}

// ═══════════════════════════════════════════════════════════════════════════
// 库与目录
// ═══════════════════════════════════════════════════════════════════════════
export async function loadLibrary(force) {
  if (scene.libReady && !force) return
  try {
    const [l, t, c, tp] = await Promise.all([scn().libList?.({}), scn().libTree?.(), scn().catalog?.(), scn().templates?.()])
    scene.lib = (l && l.modules) || []
    scene.libError = (l && l.error) || ''
    scene.libTree = (t && t.tree) || []
    scene.catalog = c || null
    scene.templates = (tp && tp.list) || []
    scene.industries = (tp && tp.industries) || []
    scene.satPresets = (c && c.satPresets) || []
    scene.libReady = true
    await loadSatLibrary(force)
  } catch (e) {
    scene.libError = e && e.message ? e.message : String(e)
  }
}
// ═══════════════════════════════════════════════════════════════════════════
// 平台卫星库
// ═══════════════════════════════════════════════════════════════════════════
/** 读库。force=true 用于 window focus 时把另一个窗口的改动收进来 */
export async function loadSatLibrary(force) {
  if (scene.satLibReady && !force) return
  try {
    const lib = await readWholeLibrary()
    const list = (lib && Array.isArray(lib.sat)) ? lib.sat : []
    scene.satLib = list.map(normSatEntry)
    scene.satLibError = ''
    scene.satLibReady = true
  } catch (e) {
    scene.satLibError = (e && e.message) || String(e)
  }
}
/** 写库（读 → 只改 sat 数组 → 写；不碰端到端窗口的地球站库与 seq） */
export async function saveSatLibrary() {
  const r = await writeSatList(scene.satLib)
  if (!r.ok) scene.satLibError = r.error
  return r
}
let _satSaveT = null
/** 防抖写库：检查器里逐字符改参数不能每敲一下就落一次盘 */
export function scheduleSatSave() {
  clearTimeout(_satSaveT)
  _satSaveT = setTimeout(() => { saveSatLibrary() }, 500)
}
/** 新建一条卫星库条目（form 为出厂值上的覆盖）。返回条目 */
export function addSatEntry(name, form, ngsoSat, presetKey) {
  const id = 'sat' + (maxSatSeq(scene.satLib) + 1)
  const e = blankSatEntry(id, name || '')
  if (form) Object.assign(e.form, form)
  if (ngsoSat) e.ngsoSat = JSON.parse(JSON.stringify(ngsoSat))
  if (presetKey) e.presetKey = presetKey       // 模板按 preset 找条目时认这个（老存档迁移同法）
  scene.satLib.push(e)
  scheduleSatSave()
  return e
}
/**
 * 星历池里的一条记录 → 卫星库条目。轨道来自真实根数（OMM / 六根数），
 * ★ 电平类参数一律留默认由工程师填 —— 平台既定：卫星 EIRP / G·T 不做自动取值。
 * @param opt { gso: 建成静止星条目, lon: 定点经度, zh: 中文名 }
 */
export function addSatEntryFromRec(rec, opt) {
  if (!rec) return null
  const o = opt || {}
  const form = {}
  form.satelliteName = o.zh || rec.name
  form.orbitClass = o.gso ? 'GSO' : 'NGSO'
  if (o.gso && o.lon != null) form.orbitLongitude = String(o.lon)
  // 预置里有同名星就把它的频段带上（中星 / 亚太那 20 颗）；没有就留出厂默认
  const pre = (scene.satPresets || []).find((p) => String(p.en || '').toUpperCase() === String(rec.name || '').toUpperCase())
  if (pre && pre.band) form.frequencyBand = pre.band
  const ngsoSat = { mode: 'search', orbit: orbitFromPoolRec(rec), name: rec.name, noradId: rec.noradId || null, folder: '' }
  applyOrbitToForm(form, ngsoSat.orbit)
  return addSatEntry(o.zh || rec.name, form, ngsoSat, pre ? pre.key : '')
}

export function removeSatEntry(id) {
  scene.satLib = scene.satLib.filter((c) => c.id !== id)
  scheduleSatSave()
}
/** 场景里引用某条卫星库条目的模块数（删条目前要问一句） */
export const satRefCount = (id) => scene.modules.filter((m) => m.kind === 'sat' && m.satId === id).length
export { satBrief, satOrbitSpec }

export const mediaOf = (key) => (scene.catalog ? (scene.catalog.media || []).find((m) => m.key === key) || null : null)
export const mediaLabel = (key) => { const m = mediaOf(key); return m ? m.zh : key }
export const tierOf = (key) => { const m = mediaOf(key); return m ? m.tier : null }
export const catLabel = (k) => { const c = (scene.catalog && scene.catalog.modCats || []).find((x) => x.key === k); return c ? c.zh : k }

// ═══════════════════════════════════════════════════════════════════════════
// 编辑
// ═══════════════════════════════════════════════════════════════════════════
function touch() { scene.dirty = true }

export function addModule(libId, place, name) {
  const b = libById.value.get(libId)
  if (!b) return null
  const m = {
    id: uid('m'), libId,
    name: name || uniqName(b.zh),
    place: Object.assign({ mode: (b.place && b.place.modes && b.place.modes[0]) || 'fixed' }, place || {}),
    ov: {}
  }
  scene.modules.push(m); touch()
  return m
}
/**
 * 往场景里放一颗卫星（引用平台卫星库的一条）。
 * ★ 与 addModule 分开：卫星没有 libId、没有站址，参数真值在卫星库里不在模块库里。
 */
export function addSatModule(satId, name) {
  const e = satById.value.get(satId)
  if (!e) return null
  const m = {
    id: uid('m'), kind: 'sat', satId,
    name: name || uniqName(e.name || (e.form && e.form.satelliteName) || '卫星'),
    place: { mode: 'orbit' }, ov: {}
  }
  scene.modules.push(m); touch()
  return m
}

function uniqName(base) {
  const used = new Set(scene.modules.map((m) => m.name))
  if (!used.has(base)) return base
  let i = 2; while (used.has(base + ' ' + i)) i++
  return base + ' ' + i
}
export function removeModule(id) {
  scene.modules = scene.modules.filter((m) => m.id !== id)
  // 连着它的边、以它为端点的流、挂在它身上的件一并清掉——留着就是悬空引用
  scene.links = scene.links.filter((l) => l.a.modId !== id && l.b.modId !== id)
  scene.flows = scene.flows.filter((f) => f.aId !== id && f.bId !== id)
  for (const m of scene.modules) if (m.place && m.place.hostId === id) { m.place = { mode: 'fixed', lat: null, lon: null } }
  if (scene.sel && scene.sel.id === id) scene.sel = null
  touch()
}
export function moveModule(id, lat, lon) {
  const m = modById.value.get(id); if (!m) return
  m.place = Object.assign({}, m.place, { lat, lon }); touch()
}

/** 连线。返回 { ok, reason }；不兼容的端口在这里就挡住，不留到计算时才报 */
export function addLink(aMod, aPort, bMod, bPort, medium, role) {
  if (aMod === bMod) return { ok: false, reason: '不能连到自己' }
  const ea = effective(modById.value.get(aMod)), eb = effective(modById.value.get(bMod))
  const pa = ea && (ea.ports || []).find((p) => p.key === aPort)
  const pb = eb && (eb.ports || []).find((p) => p.key === bPort)
  if (!pa || !pb) return { ok: false, reason: '端口不存在' }
  const c = portsCompatible(pa, pb)
  if (!c.ok) return { ok: false, reason: c.why }
  const dup = scene.links.find((l) => (l.a.modId === aMod && l.a.portKey === aPort && l.b.modId === bMod && l.b.portKey === bPort)
    || (l.b.modId === aMod && l.b.portKey === aPort && l.a.modId === bMod && l.a.portKey === bPort))
  if (dup) return { ok: false, reason: '这两个端口已经连过了' }
  const med = medium || pa.medium
  const mm = mediaOf(med)
  const lk = {
    id: uid('l'), a: { modId: aMod, portKey: aPort }, b: { modId: bMod, portKey: bPort },
    medium: med, role: role || 'main', params: Object.assign({}, (mm && mm.defaults) || {})
  }
  scene.links.push(lk); touch()
  return { ok: true, link: lk }
}
/** 端口相容（与 core 的 portsCompatible 同判据；渲染端要在连线【当时】就给出理由） */
export function portsCompatible(pa, pb) {
  const ma = mediaOf(pa.medium), mb = mediaOf(pb.medium)
  if (!ma || !mb) return { ok: false, why: '介质未知' }
  if (ma.conn !== mb.conn) return { ok: false, why: `接口类型不符（${connLabel(ma.conn)} ↔ ${connLabel(mb.conn)}）` }
  const da = pa.dir || 'trx', db = pb.dir || 'trx'
  const okDir = da === 'trx' || db === 'trx' || (da === 'tx' && db === 'rx') || (da === 'rx' && db === 'tx')
  if (!okDir) return { ok: false, why: '收发方向不相容' }
  if (ma.conn === 'air') {
    const ba = pa.band || ma.band, bb = pb.band || mb.band
    if (ba && bb && ba !== bb) return { ok: false, why: `频段不符（${ba} ↔ ${bb}）` }
  }
  return { ok: true, why: '' }
}
const connLabel = (k) => { const c = (scene.catalog && scene.catalog.connectors || []).find((x) => x.key === k); return c ? c.zh : k }

export function removeLink(id) {
  scene.links = scene.links.filter((l) => l.id !== id)
  for (const f of scene.flows) { f.pathAb = (f.pathAb || []).filter((x) => x !== id); f.pathBa = (f.pathBa || []).filter((x) => x !== id) }
  if (scene.sel && scene.sel.id === id) scene.sel = null
  touch()
}
export function addFlow(aId, bId) {
  const f = {
    id: uid('f'), name: '业务流 ' + (scene.flows.length + 1), aId, bId, dir: 'bidir',
    rateAbBps: 64000, rateBaBps: 64000, availReqPct: null, latReqMs: null
  }
  scene.flows.push(f); touch(); return f
}
export function removeFlow(id) {
  scene.flows = scene.flows.filter((f) => f.id !== id)
  if (scene.sel && scene.sel.id === id) scene.sel = null
  touch()
}

/** 逐条覆盖库参数（检查器改一个值走这里）。写 null 即恢复库值 */
export function setOv(modId, path, val) {
  const m = modById.value.get(modId); if (!m) return
  if (!m.ov) m.ov = {}
  const ks = path.split('.')
  let o = m.ov
  for (let i = 0; i < ks.length - 1; i++) { if (!o[ks[i]] || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]] }
  if (val === null || val === '') delete o[ks[ks.length - 1]]
  else o[ks[ks.length - 1]] = val
  touch()
}
export function ovOf(modId, path) {
  const m = modById.value.get(modId); if (!m || !m.ov) return undefined
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), m.ov)
}

// ═══════════════════════════════════════════════════════════════════════════
// 模板与存档
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 预置 key → 平台卫星库里的条目。已经建过就复用（按 presetKey 认，改过名也认得出），
 * 没有就建一条。★ 模板与老存档都走这条，两边不许各建一份。
 */
export async function ensureSatEntry(presetKey, name) {
  await loadSatLibrary()
  const hit = scene.satLib.find((c) => c.presetKey === presetKey)
  if (hit) return hit
  const p = await scn().satPreset?.(presetKey)
  if (!p) return null
  // 预置里的 sat 是 SAT_FIELDS 形状的出厂值，直接盖在空壳的默认值上
  const form = {}
  for (const k of Object.keys(p.sat || {})) form[k] = p.sat[k] == null ? '' : String(p.sat[k])
  return addSatEntry(name || p.zh, form, null, presetKey)
}

/**
 * 场景里的卫星实例归一：
 *   · 模板送来的是 { kind:'sat', preset }（core 侧已内联 sat 供单测直接算）——
 *     在这里换成对平台卫星库的引用，参数真值从此跟着库走；
 *   · 老存档送来的是 { libId:'sat.xxx' }（一期把卫星当模块库条目）—— 同法迁移一次。
 * 迁移只改引用，实例 ov（本场景那一片带宽 / G-T / EIRP）原样保留。
 */
let _migrating = null
async function migrateSatModules() {
  // ★ 重入保护：applyTemplate 里 loadScene 已经起过一轮（它是同步接口，只能 fire-and-forget），
  //   外层再 await 一次时不能【又】跑一遍 —— 两轮并发各自没看见对方建的条目，
  //   同一颗预置星就会在卫星库里建出两条。
  if (_migrating) { await _migrating; return }
  _migrating = (async () => { await _migrateSatModules() })()
  try { await _migrating } finally { _migrating = null }
}
async function _migrateSatModules() {
  let changed = false
  for (const m of scene.modules) {
    const preset = m.preset || (typeof m.libId === 'string' && m.libId.startsWith('sat.') ? m.libId.slice(4) : '')
    if (m.kind === 'sat' && m.satId) { cleanSatInst(m); continue }
    if (!preset) continue
    const e = await ensureSatEntry(preset, m.name)
    m.kind = 'sat'
    m.satId = e ? e.id : ''
    m.place = { mode: 'orbit' }
    delete m.libId
    cleanSatInst(m)
    changed = true
  }
  if (changed) touch()
}
// core 内联进来的那几个字段（sat / ports / symbol / cat / payloadKind / preset）不进存档：
// 它们是【库的投影】，留在实例上就成了第二份真值源，库改了实例不跟着变。
function cleanSatInst(m) {
  delete m.sat; delete m.ports; delete m.symbol; delete m.cat; delete m.payloadKind
  delete m.typical; delete m.preset; delete m.orbit
}

export async function applyTemplate(id) {
  const t = await scn().template?.(id)
  if (!t) return false
  loadScene({ name: t.name, tplId: t.tplId, modules: t.modules, links: t.links, flows: t.flows })
  await migrateSatModules()
  return true
}
export function newScene() {
  loadScene({ name: '未命名场景', modules: [], links: [], flows: [] })
}
export function loadScene(s) {
  scene.id = s.id || ''
  scene.name = s.name || '未命名场景'
  scene.tplId = s.tplId || ''
  scene.modules = JSON.parse(JSON.stringify(s.modules || []))
  scene.links = JSON.parse(JSON.stringify(s.links || []))
  scene.flows = JSON.parse(JSON.stringify(s.flows || []))
  scene.carrier = Object.assign({ ...DEFAULT_CARRIER }, s.carrier || {})
  scene.nudge = JSON.parse(JSON.stringify(s.nudge || {}))
  scene.sel = null; scene.result = null; scene.error = ''; scene.dirty = true
  scene.geo = {}; scene.geoWarn = []
  // 老存档里的卫星是模块库的 A 类条目（libId:'sat.*'）：进场即迁到平台卫星库的引用上。
  // 不 await —— loadScene 是同步接口（多处调用方不认 Promise）；迁移只改引用，
  // 迁完自然触发重绘，计算前 compute() 也会再看到迁好的那份。
  if (scene.modules.some((m) => m.kind === 'sat' || (typeof m.libId === 'string' && m.libId.startsWith('sat.')))) {
    migrateSatModules()
  }
}
/** 存档载荷（configs.scene.json 里存的就是它） */
export const snapshot = () => ({
  name: scene.name, tplId: scene.tplId,
  modules: scene.modules, links: scene.links, flows: scene.flows,
  carrier: scene.carrier, nudge: scene.nudge, orbitType: 'SCENE'
})

// ═══════════════════════════════════════════════════════════════════════════
// 计算
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 送算的场景载荷。★ 卫星模块在这里就地解析成【已带 sat 参数的节点】——
 * 平台卫星库在渲染端，主进程与 core 看不到也不该看到它（与「几何由调用方解好后注入」同一分工）。
 */
export function computePayloadScene() {
  const modules = []
  for (const m of scene.modules) {
    if (m.kind === 'sat') {
      const e = effective(m)
      if (!e) { modules.push({ id: m.id, kind: 'sat', satId: m.satId, name: m.name, sat: {} }); continue }
      modules.push({
        id: m.id, kind: 'sat', satId: m.satId, name: m.name,
        sat: e.sat, payloadKind: e.payloadKind, typical: !!e.typical, symbol: e.symbol
      })
    } else modules.push(m)
  }
  return JSON.parse(JSON.stringify({ modules, links: scene.links, flows: scene.flows }))
}

export async function compute() {
  if (scene.busy) return
  scene.busy = true; scene.error = ''
  const t0 = performance.now()
  try {
    await solveGeometry()
    // ★ IPC 收不了 Vue 的响应式代理（结构化克隆过不去，且 invoke 会当场抛），出门前现造纯数据
    const payload = {
      scene: computePayloadScene(),
      opts: {
        carrier: JSON.parse(JSON.stringify(scene.carrier)),
        geo: JSON.parse(JSON.stringify(scene.geo))
      }
    }
    const r = await scn().compute?.(payload)
    if (!r || !r.ok) { scene.error = (r && r.error) || '计算失败'; scene.result = null }
    else { scene.result = r.result; scene.dirty = false }
  } catch (e) {
    scene.error = e && e.message ? e.message : String(e)
    scene.result = null
  } finally {
    scene.ms = Math.round(performance.now() - t0)
    scene.busy = false
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 几何预解：星地 / 星间边走真轨道
// ═══════════════════════════════════════════════════════════════════════════
// 一期的星地几何只有两条闭式：GSO 静止闭式、NGSO「圆轨道高度 + 最低仰角」的最差斜距 ——
// 后者连星历都不解，轨道高度还得手填。二期改成：卫星库条目有轨道 spec 时，把它连同站址
// 交给主进程的 link:ngsoGeometry（core 的 solveNgsoMutualWorstCase，SGP4/SDP4 单一典型时刻
// 最差几何），结果注入 opts.geo，与端到端窗口同一颗星同一站址逐位一致。
//
// ★ 解不出（无网 / 无星历 / 缺站址 / 没有轨道）不兜底编数：留空即可，
//   core 的 buildChainDescriptor 会退回闭式并照旧报出那条「按圆轨道…最差几何计」的告警。
//
// ★ 缓存 key 要把「会改变几何的东西」全带上、把不相关的全排除：改一个功放功率不该重解一遍轨道。
const geoKeyOf = (o) => JSON.stringify([o.orbit, o.st, o.t0ISO, o.horizonHours])

/** 站址描述子（与端到端窗口的 stationGeoOf 同形） */
function stationOf(mod, link) {
  const pl = placeOf(mod.id)
  if (!pl || pl.lat == null || pl.lon == null) return null
  const lp = (link && link.params) || {}
  return {
    lonDeg: +pl.lon, latDeg: +pl.lat, altKm: (+pl.altM || 0) / 1000,
    minElevDeg: lp.minElevDeg != null && lp.minElevDeg !== '' ? +lp.minElevDeg : 10,
    freqGHz: +lp.freqUpGHz || +lp.freqGHz || 14
  }
}

const _geoCache = new Map()

/**
 * 逐条卫星边解几何，写进 scene.geo。
 * 键是 `${dir}:${linkId}`（core 侧 buildChainDescriptor 按这个键取）——最差几何与走向无关，
 * 故 ab / ba 注同一份值。
 */
export async function solveGeometry() {
  const lb = (api().linkBudget) || {}
  scene.geoWarn = []
  const out = {}
  if (!lb.ngsoGeometry) { scene.geo = out; return out }
  scene.geoBusy = true
  const t0ISO = new Date(clock.tMs || Date.now()).toISOString()
  const horizonHours = 24
  try {
    for (const lk of scene.links) {
      const med = mediaOf(lk.medium)
      if (!med || med.tier !== 'satellite') continue
      const ea = effective(modById.value.get(lk.a.modId))
      const eb = effective(modById.value.get(lk.b.modId))
      if (!ea || !eb) continue
      const isIsl = lk.medium === 'isl_rf' || lk.medium === 'isl_laser'
      let req = null, kind = ''
      if (isIsl) {
        if (!ea.orbit || !eb.orbit) { scene.geoWarn.push(`「${ea.name} ↔ ${eb.name}」星间几何：两端须各有可用轨道`); continue }
        req = { orbitA: ea.orbit, orbitB: eb.orbit, t0ISO, horizonHours, freqGHz: +((lk.params || {}).freqGHz) || 23 }
        kind = 'isl'
      } else {
        const sat = ea.cat === 'A' ? ea : (eb.cat === 'A' ? eb : null)
        const es = ea.cat === 'A' ? eb : ea
        if (!sat) continue
        if (!sat.orbit) { scene.geoWarn.push(`「${sat.name}」没有可用轨道（GSO 需定点经度；NGSO 需轨道高度或选一颗星）`); continue }
        const st = stationOf(scene.modules.find((m) => m.id === es.instId) || {}, lk)
        if (!st) { scene.geoWarn.push(`「${es.name}」没有站址坐标，几何按闭式最差值计`); continue }
        req = { orbit: sat.orbit, st, t0ISO, horizonHours }
        kind = 'es'
      }
      const key = kind + '|' + geoKeyOf(kind === 'isl' ? { orbit: [req.orbitA, req.orbitB], st: null, t0ISO, horizonHours } : req)
      let g = _geoCache.get(key)
      if (g === undefined) {
        try {
          g = kind === 'isl'
            ? await lb.islGeometry({ orbitA: req.orbitA, orbitB: req.orbitB, t0ISO, horizonHours, freqGHz: req.freqGHz })
            : await lb.ngsoGeometry({ orbit: req.orbit, tx: req.st, rx: req.st, t0ISO, horizonHours })
        } catch { g = null }
        _geoCache.set(key, g)
        // 缓存无上限会随「拖时间轴 + 改站址」一路涨；几十条封顶足够一轮计算复用
        if (_geoCache.size > 200) _geoCache.delete(_geoCache.keys().next().value)
      }
      if (!g || !g.feasible) { scene.geoWarn.push(`「${ea.name} ↔ ${eb.name}」几何无解：${(g && g.reason) || '求解失败'}，按闭式最差值计`); continue }
      const v = kind === 'isl'
        ? { rangeKm: g.worst && g.worst.rangeKm, method: g.method || '' }
        : { slantRange: g.worst.up.slantKm, elevation: g.worst.up.elevDeg, method: g.method || '' }
      out['ab:' + lk.id] = v
      out['ba:' + lk.id] = v
    }
  } finally { scene.geoBusy = false }
  scene.geo = out
  return out
}

// 结果索引：按流 id 取
export const flowResult = (fid) => (scene.result ? (scene.result.flows || []).find((f) => f.id === fid) || null : null)
export const energyOf = (mid) => (scene.result ? (scene.result.modules || []).find((m) => m.instId === mid) || null : null)

/** 一条边在结果里的逐向读数（拓扑图与地图上给连线标数用） */
export function linkReadings(linkId) {
  const out = []
  if (!scene.result) return out
  for (const f of scene.result.flows || []) {
    for (const d of f.dirs || []) {
      const i = (d.path || []).indexOf(linkId)
      if (i < 0) continue
      const seg = (d.segments || []).find((s) => s.kind === 'terr' && (d.path || [])[i] === linkId)
      out.push({ flow: f.name, dir: d.dir, seg: seg || null, ok: d.ok })
    }
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// 自检钩子
// ═══════════════════════════════════════════════════════════════════════════
// 与平台既有的 window.__reportReady / window.__i18nMisses 同一套做法：把这份模块级单例
// 挂出来，供 .sceneharness/electron-check.mjs 在【真 Electron 窗口】里跑端到端自检。
// ★ 这三条 vite 验证台测不了，只能在真窗口里验：星历取自主进程（内置 OMM 兜底 + 联网）、
//   卫星库落在 userData/library.json、几何走 link:ngsoGeometry。
// 只挂只读引用，不改变任何运行时行为。
if (typeof window !== 'undefined') {
  window.__sceneStore = {
    scene, effective, satOrbitSpec,
    loadLibrary, loadSatLibrary, saveSatLibrary,
    newScene, applyTemplate, compute, solveGeometry, computePayloadScene,
    addSatEntry, addSatEntryFromRec, addSatModule, addModule, addLink, addFlow,
    ensureSearchPool: () => import('../../ngso/satSearchPool.js').then((m) => m.ensureSearchPool())
  }
}

// 改了数据就把结果标记为过期（不自动重算：整场景重算要跑真引擎，逐字符触发会卡）
watch(() => [scene.modules, scene.links, scene.flows, scene.carrier], () => { scene.dirty = true }, { deep: true })

export default scene
