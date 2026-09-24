// 「卫星」「分析」两个页签共用的状态（DESIGN2 §3）：当前卫星、它的绑定工作副本（模型 / 姿态律 / 挂点）、选中挂点、轨道。
// ModelApp 建一份 provide 给两页；预览视口里画的挂点、掩模片、天线视角都从这里取。
//
// 绑定表的真相在主进程（userData/models.bindings.json，契约 electron/services/models.js 文件头）：
//   · 读：models.bindingsGet() → {prefs, bindings}；主进程广播 models:changed {type:'bindings'} 时重读（别的窗口 / 3D 页改了）。
//   · 写：models.bindingsSet({satKey, binding|null})，纯数据（memory ipc-no-reactive-proxy：出 IPC 前现造）。
//     改动 400 ms 防抖落盘；换星 / 关窗前先把待存的按原键写掉（与 wbStore 的元数据同一口径：待存改动绑在「改的是哪颗星」上）。
//     绑定什么都没写（模型自动、无挂点、nadir）时写 null——绑定表不留空壳。
// 撤销：绑定快照栈（换星清空），Ctrl+Z / Ctrl+Y 在卫星页生效。
import { reactive, computed, watch } from 'vue'
import { normalizeBinding, emptyBinding, isEmptyBinding, coneHalfOf, articulationStateOf, maskSigFor } from './mountLogic.js'
import { resolveOrbit } from './satSources.js'
import { match as autoMatch } from '@core/models/autoMatch.mjs'
import { decodeMask, maskRayOrigin } from '@core/models/mask.mjs'
import { byLang } from '../shared/i18n/lang.js'

const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const errText = (e) => (e && e.message) || String(e)

/** 绑定键 → 界面上的短名（没有更好的名字时） */
export function keyLabel(k) {
  const s = String(k || '')
  const m = /^(norad|grdsat|name):(.+)$/.exec(s) || /^(?:ephem|cc|lbsat):[^:]+:(.+)$/.exec(s)
  if (!m) return s
  return m[1] === 'norad' ? 'NORAD ' + m[2] : (m[2] || m[1])
}

/**
 * @param {object} wb 工作台（wbStore.createWorkbench 的返回）
 */
export function createSatStore(wb) {
  const api = wb.api
  const st = reactive({
    satKey: '', label: '', hint: null,     // 当前卫星（hint：选星时手里的来源记录，解析轨道用）
    binding: null,                          // 工作副本
    errors: [],                             // 归一时丢掉 / 纠正的项
    all: {}, prefs: {}, loaded: false,      // 绑定表（主进程）
    saving: false, saveErr: '', savedAt: 0, rev: 0,
    mountSel: '',                           // 选中挂点 id
    undoN: 0, redoN: 0,
    orbit: null, orbitKey: '', orbitErr: '', orbitBusy: false,
    maskRev: 0                              // 掩模缓存变了 +1（预览红色球面片、分析页读数跟着刷新）
  })
  // 掩模缓存（不进响应式：每张 65160 格 × 5 B）：挂点 id → {sig, mask:{blocked, clearance, hitNode?, nodeNames?}, originBody, stats?, ms?, sun?}
  // 认不认由 maskOf 拿【当前】输入（工作台当前模型、关节值、挂点位置 / 排除名单）现算期望签名（mountLogic.maskSigFor）判：
  // 换了模型 / 轴向 / 缩放 / 关节值 / 挂点，签名对不上就不认。换星、换绑定模型清空。
  const masks = new Map()
  // 掩模的关节值（分析页滑杆；关节名 → 各 stage 值，没动过的不在里面 = 初值）。放在这里而不是分析页里：
  // 预览红色球面片、万向节「查掩模」在分析页还没建出来时也要按它判签名。换模型清空（视口那边同时回初值）。
  const art = reactive({})
  const clearArt = () => { for (const k of Object.keys(art)) delete art[k] }
  watch(() => wb.cur.id, clearArt)

  // ───────── 绑定表 ─────────
  async function loadAll() {
    const r = await wb.call('bindingsGet')
    if (!r || r === wb.LOCKED || r.ok === false) { st.loaded = true; return }
    st.all = r.bindings || {}
    st.prefs = r.prefs || {}
    st.loaded = true
    // 别处改了当前这颗星（且本页没有待存改动）：工作副本跟上
    if (st.satKey && !pend && !saveT) {
      const next = normalizeBinding(st.all[st.satKey] || emptyBinding()).binding
      if (JSON.stringify(next) !== JSON.stringify(st.binding)) { st.binding = next; st.rev++ }
    }
  }
  let offChanged = null
  if (api && api.onChanged) {
    try { offChanged = api.onChanged((e) => { if (e && e.type === 'bindings') loadAll() }) } catch { offChanged = null }
  }
  /** 有绑定记录的星（「已绑定」列表） */
  const boundList = computed(() => Object.keys(st.all || {}).sort().map((k) => ({ key: k, label: keyLabel(k), n: (st.all[k].mounts || []).length })))

  // ───────── 选星 ─────────
  /**
   * @param {{satKey:string, label?:string, hint?:object}} o
   */
  async function selectSat(o) {
    if (!o || !o.satKey) return
    if (pend) await flushSave()
    if (!st.loaded) await loadAll()
    st.satKey = o.satKey
    st.label = o.label || keyLabel(o.satKey)
    st.hint = o.hint ? { ...o.hint } : null
    const nb = normalizeBinding(st.all[o.satKey] || emptyBinding())
    st.binding = nb.binding
    st.errors = nb.errors
    st.mountSel = st.binding.mounts.length ? st.binding.mounts[0].id : ''
    st.saveErr = ''
    st.orbit = null; st.orbitKey = ''; st.orbitErr = ''
    masks.clear(); st.maskRev++
    clearUndo()
    st.rev++
    try { localStorage.setItem('model/satLast', JSON.stringify({ satKey: st.satKey, label: st.label })) } catch { /* 便利数据 */ }
  }
  function clearSat() { if (pend) flushSave(); st.satKey = ''; st.label = ''; st.binding = null; st.mountSel = ''; st.orbit = null; st.orbitKey = ''; clearUndo(); st.rev++ }

  // ───────── 编辑 / 撤销 / 落盘 ─────────
  const undoStack = [], redoStack = []
  function clearUndo() { undoStack.length = 0; redoStack.length = 0; st.undoN = 0; st.redoN = 0 }
  function snapshot() { return JSON.stringify(st.binding) }
  /** fn(binding) 就地改工作副本；o.undo=false 不压撤销快照 */
  function edit(fn, o = {}) {
    if (!st.binding) return
    if (o.undo !== false) {
      undoStack.push(snapshot()); if (undoStack.length > 80) undoStack.shift()
      redoStack.length = 0; st.undoN = undoStack.length; st.redoN = 0
    }
    fn(st.binding)
    st.rev++
    saveSoon()
  }
  function pushUndo() { if (!st.binding) return; undoStack.push(snapshot()); redoStack.length = 0; st.undoN = undoStack.length; st.redoN = 0 }
  function dropUndo() { undoStack.pop(); st.undoN = undoStack.length }
  function undo() {
    if (!undoStack.length || !st.binding) return false
    redoStack.push(snapshot())
    st.binding = JSON.parse(undoStack.pop())
    st.undoN = undoStack.length; st.redoN = redoStack.length; st.rev++
    saveSoon(); return true
  }
  function redo() {
    if (!redoStack.length || !st.binding) return false
    undoStack.push(snapshot())
    st.binding = JSON.parse(redoStack.pop())
    st.undoN = undoStack.length; st.redoN = redoStack.length; st.rev++
    saveSoon(); return true
  }
  let saveT = 0, pend = null
  function saveSoon() {
    if (!st.satKey) return
    pend = { key: st.satKey }
    clearTimeout(saveT); saveT = setTimeout(flushSave, 400)
  }
  async function flushSave() {
    clearTimeout(saveT); saveT = 0
    const p = pend; pend = null
    if (!p || !st.binding || p.key !== st.satKey) return
    const b = plain(st.binding)
    const binding = isEmptyBinding(b) ? null : b
    st.saving = true
    const r = await wb.call('bindingsSet', { satKey: p.key, binding })
    st.saving = false
    if (!r || r === wb.LOCKED) return
    if (r.ok === false) { st.saveErr = (r.errors && r.errors.slice(0, 3).join('；')) || r.error || byLang('保存失败', 'Save failed'); return }
    st.saveErr = ''; st.savedAt = Date.now()
    if (binding) st.all = { ...st.all, [p.key]: binding }
    else { const n = { ...st.all }; delete n[p.key]; st.all = n }
  }
  const hasPending = () => !!pend

  // ───────── 派生 ─────────
  const mounts = computed(() => { void st.rev; return st.binding ? st.binding.mounts : [] })
  const selMount = computed(() => { void st.rev; return mounts.value.find((m) => m.id === st.mountSel) || null })
  /** 预览要画的挂点（纯数据 + 视场锥半角） */
  function mountsForViewport() {
    return mounts.value.map((m) => ({ id: m.id, name: m.name, posBody: m.posBody.slice(), boresightBody: m.boresightBody.slice(), upBody: m.upBody.slice(), attachPoint: m.attachPoint || null, coneHalfDeg: coneHalfOf(m) }))
  }

  /**
   * 这颗星用哪个模型：绑定写了具体 id 就用它；'auto' 按 autoMatch（名称 / NORAD / 组，与 3D 页同一口径；轨道类别未知时按名称兜底）；null = 不配模型。
   * @returns {{id:string|null, auto:boolean}}
   */
  function resolvedModel() {
    const b = st.binding
    if (!b) return { id: null, auto: true }
    const id = b.model ? b.model.id : 'auto'
    if (id === null) return { id: null, auto: false }
    if (id && id !== 'auto') return { id, auto: false }
    const k = st.satKey
    const nm = st.label || ''
    const m = /^norad:(\d+)$/.exec(k)
    const available = new Set(wb.st.list.map((e) => e.id))
    const hit = autoMatch({ name: nm, noradId: m ? m[1] : null, orbitKind: st.hint && st.hint.orbitKind ? st.hint.orbitKind : '', group: '' }, { available, prefs: st.prefs || undefined })
    return { id: hit ? hit.id : null, auto: true, rule: hit ? hit.rule : '' }
  }

  // ───────── 轨道（分析页用；按星缓存） ─────────
  async function ensureOrbit() {
    if (!st.satKey) return null
    if (st.orbit && st.orbitKey === st.satKey) return st.orbit
    const key = st.satKey
    st.orbitBusy = true; st.orbitErr = ''
    let o = null
    try { o = await resolveOrbit(key, st.hint || {}) } catch (e) { st.orbitErr = errText(e) }
    st.orbitBusy = false
    if (key !== st.satKey) return null
    st.orbit = o ? Object.freeze(o) : null
    st.orbitKey = key
    if (!o && !st.orbitErr) st.orbitErr = byLang('找不到这颗星的轨道。', 'No orbit for this satellite.')
    return st.orbit
  }

  // ───────── 掩模 ─────────
  /** 工作台当前模型（掩模签名的模型那一半）；没载入返回 null */
  function modelCtx() { const c = wb.cur; return c.meta ? { meta: c.meta, kind: c.kind, lod: c.lod, id: c.id } : null }
  /** 当前关节值（有 stage 的关节全列，没动过的取初值） */
  function artState() { return articulationStateOf(wb.cur.meta, art) }
  function setArt(name, vals) { art[name] = vals.slice() }
  function resetArt() { clearArt() }
  /** 挂点在当前输入下应有的掩模签名（模型没载入返回 null）。sunBin：对日扫描档号 */
  function expectedSig(m, sunBin = null) {
    const mc = modelCtx()
    return mc && m ? maskSigFor(mc, m, artState(), sunBin) : null
  }
  /** 挂点当前的掩模：缓存里有、且签名 = 当前输入的期望签名才给；否则 null（旧模型 / 旧位姿 / 旧关节值的一律不认） */
  function maskOf(mountId) {
    void st.maskRev
    const m = mounts.value.find((x) => x.id === mountId)
    const r = masks.get(mountId)
    if (!m || !r || !r.sig) return null
    return r.sig === expectedSig(m) ? r : null
  }
  /** 算好一张（transient：还没落盘 / 挂点没写签名的临时结果，签名对得上照样给预览和读数用） */
  function putMask(mountId, rec) { masks.set(mountId, rec); st.maskRev++ }
  /** 清掉全部挂点的掩模缓存（换绑定模型时；挂点上的 maskSig 由调用方在同一次 edit 里删） */
  function dropMasks() { masks.clear(); st.maskRev++ }
  /** 挂点写着 maskSig、且它就是当前输入的期望签名，而缓存里没有：从主进程取 .bin 解码（models.getMask；通道没有 / 文件没有返回 null） */
  async function loadMask(mountId) {
    const m = mounts.value.find((x) => x.id === mountId)
    if (!m || !m.maskSig || m.maskSig !== expectedSig(m)) return null
    const have = masks.get(mountId)
    if (have && have.sig === m.maskSig) return have
    if (!api || typeof api.getMask !== 'function') return null
    const sig = m.maskSig, sk = st.satKey
    let bytes = null
    try { bytes = await api.getMask(sig) } catch { bytes = null }
    if (!bytes || bytes.locked || st.satKey !== sk) return null
    const mk = decodeMask(bytes)
    if (!mk) return null
    const rec = { sig, mask: mk, originBody: maskRayOrigin(m.posBody, m.boresightBody, [0, 0, 0]), stats: null, ms: null, loaded: true }
    masks.set(mountId, rec); st.maskRev++
    return rec
  }
  // 选中挂点有签名、缓存里没有：自动读回（分析页没建出来时预览的红色球面片也要有）。模型载入 / 关节值变了再核一次
  watch(() => [st.mountSel, st.rev, wb.cur.id, wb.cur.rev, wb.cur.lod, !!wb.cur.meta, JSON.stringify(art)], () => {
    const m = selMount.value
    if (m && m.maskSig && !maskOf(m.id)) loadMask(m.id)
  })

  function dispose() { if (pend) flushSave(); if (offChanged) try { offChanged() } catch { /* ignore */ } }

  return {
    st, mounts, selMount, boundList,
    loadAll, selectSat, clearSat, edit, pushUndo, dropUndo, undo, redo, flushSave, hasPending,
    mountsForViewport, resolvedModel, ensureOrbit, maskOf, putMask, dropMasks, loadMask, dispose,
    modelCtx, artState, setArt, resetArt, expectedSig, art
  }
}
