// 应用场景仿真 · 渲染端场景状态（模块级 reactive，非 Pinia）。
//
// 为什么是模块级单例而不是组合式函数：这份状态要被三处同时读写 ——
// 侧栏面板（ScenePanel.vue）、拓扑视图（SceneTopology.vue）、3D 页的地图渲染
// （ConstellationMap3D.vue，11k 行）。做成 composable 就得把它穿过那个巨型页面
// 一路传 props；做成模块级单例，三处各自 import 即可，且天然是同一份数据 ——
// 「两种可视化是同一个场景的两个投影」这条设计约束在数据层就成立了。

import { reactive, computed, watch } from 'vue'

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

  // ── 计算 ──
  result: null, busy: false, error: '', dirty: true, ms: 0
})

// ── 索引 ──
export const modById = computed(() => new Map(scene.modules.map((m) => [m.id, m])))
export const libById = computed(() => new Map(scene.lib.map((m) => [m.id, m])))
export const linkById = computed(() => new Map(scene.links.map((l) => [l.id, l])))
export const libOf = (m) => (m ? libById.value.get(m.libId) || null : null)
/** 实例的有效值：库条目 + 逐条覆盖（ov）。渲染与检查器都走它，别各算各的 */
export function effective(m) {
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
    scene.libReady = true
  } catch (e) {
    scene.libError = e && e.message ? e.message : String(e)
  }
}
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
export async function applyTemplate(id) {
  const t = await scn().template?.(id)
  if (!t) return false
  loadScene({ name: t.name, tplId: t.tplId, modules: t.modules, links: t.links, flows: t.flows })
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
export async function compute() {
  if (scene.busy) return
  scene.busy = true; scene.error = ''
  const t0 = performance.now()
  try {
    // ★ IPC 收不了 Vue 的响应式代理（结构化克隆过不去，且 invoke 会当场抛），出门前现造纯数据
    const payload = {
      scene: JSON.parse(JSON.stringify({ modules: scene.modules, links: scene.links, flows: scene.flows })),
      opts: { carrier: JSON.parse(JSON.stringify(scene.carrier)) }
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

// 改了数据就把结果标记为过期（不自动重算：整场景重算要跑真引擎，逐字符触发会卡）
watch(() => [scene.modules, scene.links, scene.flows, scene.carrier], () => { scene.dirty = true }, { deep: true })

export default scene
