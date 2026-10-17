// 模型工作台的状态与编排（一个窗口一份，ModelApp 建好后 provide 给各页签）。
//
// 分工：
//   · 数据来自主进程 window.api.models（契约见 electron/services/models.js 文件头）。每个调用都 catch，并识别 {locked:true}
//     （未激活时 gated 通道一律回它；遮罩由 ActivationLock 盖，这里只让调用静默失败、不报红）。
//   · 画面在 viewport.js；本模块只把「当前模型」的根与元数据交给它（setModel），元数据改一格就用同一根重喂一次（轴向 / 叠加层
//     跟着变），不重新加载几何。
//   · 模型根（three 对象）一律 markRaw、放在响应式之外：Vue 的深代理套在几十万个顶点的几何上既慢又会把 three 的内部对象弄坏。
//   · 元数据的工作副本 cur.meta 是响应式的（表单直接绑）；喂视口 / 送 IPC 前一律现造纯数据（memory ipc-no-reactive-proxy）。
//   · 改动即落盘（DESIGN §7）：编辑后 500 ms 防抖 saveMeta；远端 / 内置模型的改写由主进程写成本机覆盖层。关窗时主进程守卫转来
//     modelwb:closeRequested，flushForClose 把待存的元数据、全部签的草稿与入库作业落定后再关（2026-10-06 任务书 §3.4）。
//     ★ 待存的改动绑在「改的是哪个模型」上（metaId，排期时记下），换模型 / 删模型 / 关窗前先把它按原 id 存掉 ——
//       不能到时候再读 cur.id：防抖期间导入完成自动选中、升档重载、外部跳转都会换掉 cur.id / cur.meta，旧改动丢、新模型白写一份。
//     ★ 只有用户改动才落盘：视口按当前 LOD 量出来的包围盒 / 三角形数是读数（cur.view），不写进元数据 —— 否则光是浏览一下
//       远端模型、关窗时就会给它写一份覆盖层，把清单里的 geometry 永久盖住。
//   · geometry.bboxM 一律【模型轴、米】（轴映射终案 ④，已乘 scaleToMeters）：本体系尺寸不落盘，由 frame 现算（wbLogic.bodyBoxOfMeta）。
//     读数（cur.view.bboxM）是本体系的，只在屏上显示。
//   · 渲染端导入（OBJ / STL / FBX）的 frame.q 缺省按来源（bodyFrame.defaultImportQ，user → +Y 天顶），导出时烘成 STK 映射落盘。
//   · 装配页（P3，契约 scratchpad p3/CONTRACT.md §7）：视口可被装配页「借走」（lendViewport → st.vpOwner = 'asm'），借出期间本模块的一切
//     喂视口调用照常改 root / cur、只是不喂；还回来（reclaimViewport）按当前 root 重喂一次。装配文档的入库走 saveImported 的 asm 分支
//     （id = asm:<12 位十六进制>，终身不变）：每次提交写本机草稿（按文档分槽）+ 1.5 s 停手自动入库（glb + 缩略图），离开设计页 / 关签 / 关窗立即 flush；
//     换签只写草稿、不强制入库（排着的自动入库照常在后台跑完、按文档回写）。
//   · 设计页文档标签条（2026-10-06，任务书 §3.1）：打开的每份文档一个 DocState（st.docs / st.activeDoc），wb.asm 是激活装配签的视图，见「设计页文档」一节。
//     实体模板（ent:）像参数化模板一样运行时现生成；entityTemplates.mjs 走 import.meta.glob 软依赖（没落地 / 加载失败时库里就没有 ent 条目）。
import { reactive, markRaw, computed, watch } from 'vue'
import * as THREE from 'three'
import { loadModel, disposeObject } from '../viz/models/loader.js'
import { irToThree } from '../viz/models/irToThree.js'
import { renderThumb, applyRestPose, restoreFilePose, exactBox, TPL_THUMB_VER } from '../viz/models/thumbs.js'
import { createAnalyzer } from '../viz/models/analyze.js'
import { importFile } from '../viz/models/importers.js'
import { exportGlb } from '../viz/models/exporter.js'
import { exportAssemblyInWorker, asmThumbInWorker, compThumbInWorker, paramThumbInWorker, disposeAsmExport } from '../viz/models/asmExport.js'
import { gltfMaterialFallback } from '../viz/models/materials.js'
import { patchGlbJson } from '@core/models/glb.mjs'
import { modelToBodyMatrix } from '../viz/models/view.js'
import { buildParamModel } from '@core/models/paramBus.mjs'
import { templateCatalog, templateSpec, templateModelId, TEMPLATE_IDS, TEMPLATES } from '@core/models/paramTemplates.mjs'
import { fleetCatalog, buildFleetModel, fleetSig } from '@core/models/fleet/index.mjs'
import { normalizeMeta } from '@core/models/schema.mjs'
import { defaultImportQ, quatToMat, matToQuat } from '@core/models/bodyFrame.mjs'
import { getComponent, getPreset, fillParams, homeDomain } from '@core/models/components/index.mjs'
import { addComp } from '@core/models/asmSnap.mjs'
import { ASM_DOMAINS, newAsmId, normalizeAssembly, buildAssembly, buildComponent, asmHash } from '@core/models/assembly.mjs'
import { assemblyModelMeta, defaultAsmName } from '@core/models/asmMeta.mjs'
import { newDrivenDoc, isDriven } from '@core/models/drive.mjs'
import { canon, fnv1a64Hex } from '@core/models/paramBus.mjs'
import { guessUnits } from '@core/models/units.mjs'
import { byLang } from '../shared/i18n/lang.js'
import { mergeSegment, importRoute, extOf, entryFacts, restoreJob, canCancelJob, meshUnitTieBreak, mergeParamMeta, bodyBoxToModelBox, docKeyOf, libIdOfDoc, evictDrafts, cycleIndex, neighborAfterClose, copyNameOf, numberedNameOf, displayName, reframeMeta, previewLod } from './wbLogic.js'
import { DRAFT_KEY, LAST_KEY, provKey, draftOk, pickDraft, sanitizeProv, templateSources, libKeyParams } from './asmLogic.js'
import { postImportPatch, postImportBasis } from './postImportMerge.js'

const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const errText = (e) => (e && e.message) || String(e)
const isLocked = (r) => !!(r && r.locked)
const stemOf = (s) => String(s || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
const dirOf = (p) => { const s = String(p || ''); const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')); return i >= 0 ? s.slice(0, i) : '' }
const joinPath = (d, n) => (d ? d.replace(/[\\/]+$/, '') + '\\' + String(n).replace(/^[\\/]+/, '').replace(/\//g, '\\') : n)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LOCKED = Object.freeze({ locked: true })
// 参数化模板缩略图的本机缓存（localStorage，纯便利：丢了就现场重画）。版本号 TPL_THUMB_VER 在 thumbs.js（3D 页侧栏同取那一份），
// 跟着材质 / 光照口径改，旧图自动作废
const RECENT_KEY = 'model/recentImports'
const RECENT_MAX = 40
// 实体模板缩略图的出图口径版本（缓存键里 TPL_THUMB_VER 之后再加这一段）：r2 = 出图时带上关节元数据按静止位姿摆（地球站碟面
// 按 el0 仰起）；口径变了升一格，模板文档没变也会重画
const ENT_THUMB_REV = 'r2'

// 实体模板（A3 交付 packages/core/models/entityTemplates.mjs）：软依赖。没落地时 glob 为空、加载失败时只告警——库里没有 ent 条目，别的不受影响
const ENT_LOADERS = import.meta.glob('../../packages/core/models/entityTemplates.mjs')
let ENT = null
const entReady = (async () => {
  for (const load of Object.values(ENT_LOADERS)) {
    try { ENT = await load() } catch (e) { console.warn('[modelwb] 实体模板加载失败：' + errText(e)) }
  }
  return ENT
})()
const lsJson = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null } catch { return null } }
const lsPut = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)) } catch { /* 便利数据：配额满 / 被禁都不挡 */ } }
const lsRaw = (k) => { try { return localStorage.getItem(k) } catch { return null } }
const LIB_PANE_KEY = 'model/lib/pane'
// 绕本体 X 轴 180°（行主序 3×3）：组件预览把「朝 +Z 长」的件立起来摆（同组件卡片缩略图的口径）
const RX180 = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]

/** 实体模板 → 库条目（「装配」段；排在参数化模板之后，tplOrder 100+） */
function entityEntries() {
  if (!ENT || typeof ENT.entityTemplateCatalog !== 'function') return []
  try {
    return ENT.entityTemplateCatalog().map((t, i) => ({
      ...t, schema: 2, origin: 'entTemplate', tplOrder: 100 + i, local: {}, files: {},
      units: { scaleToMeters: 1, unitGuess: 'm', sizeVerified: false }, frame: null, geometry: null
    }))
  } catch (e) { console.warn('[modelwb] 实体模板目录：' + errText(e)); return [] }
}

/** 参数化模板 → 库条目（参数化段；排在最前，tplOrder 定序） */
function templateEntries() {
  return [
    ...templateCatalog().map((t, i) => ({
      ...t, schema: 2, origin: 'template', tplOrder: i, local: {}, files: {},
      units: { scaleToMeters: 1, unitGuess: 'm', sizeVerified: false },
      frame: null, geometry: null
    })),
    // 星座精模（fleet/）：与模板同为「内置、运行时现生成、只读」，排在参数化模板之后；fleet 标记让选中 / 出图走 buildFleetModel
    ...fleetCatalog().map((t, i) => ({
      ...t, schema: 2, origin: 'template', fleet: true, tplOrder: 50 + i, local: {}, files: {},
      units: { scaleToMeters: 1, unitGuess: 'm', sizeVerified: true },
      frame: null, geometry: null
    }))
  ]
}

/**
 * @param {{toast:(msg:string)=>void, hint:(msg:string)=>void, askConfirm:(msg:string)=>Promise<boolean>}} ui
 */
export function createWorkbench(ui) {
  const api = (typeof window !== 'undefined' && window.api && window.api.models) ? window.api.models : null

  // ───────────────── 响应式状态 ─────────────────
  const st = reactive({
    locked: false,
    loaded: false,
    list: [],                    // manifest 条目 + 参数化模板
    prefs: {},
    cache: { bytes: 0, cap: 0 },
    dl: {},                      // id → {lod, phase, received, total, message}
    thumbs: {},                  // id → url（'' = 没有）
    selId: '',
    tab: 'lib',
    // 设计页打开的文档（2026-10-06 文档标签条，任务书 §3.1）：docs = 各签的 DocState（顺序即签序），activeDoc = 激活签的 DocState.id（'' = 没有签）。
    // 设计页显示什么只由激活签决定（不再有独立的 designKind 状态）
    docs: [],
    activeDoc: '',
    // 旧口径的只读推导量：激活签的类型 'asm' | 'model'（没有签 ''）。写它是空操作（旧验证台脚本会写）
    get designKind() { const d = docsById.get(this.activeDoc); return d ? d.kind : '' },
    set designKind(_v) { /* 由激活签推导，不可写 */ },
    busy: '',                    // 功能区右缘的运行时状态
    imports: [],                 // 导入作业（最近的在前）
    lastExport: null,            // {path, bytes, ms, nodes, warnings}
    vpOwner: '',                 // '' | 'asm'：视口借给了谁（装配页借走期间本模块不喂视口）
    compThumbs: {},              // 组件库卡片键（type 或 `${type}#${型号 id}`）→ 缩略图 dataURL（装配页组件库）
    // 库页左栏的档（2026-10-12）：'model' 模型库 | 'comp' 组件库（全部组件与常用型号）；selComp = 组件档里正在视口预览的卡片键（'' = 没有；与 selId 互斥）
    libPane: lsRaw(LIB_PANE_KEY) === 'comp' ? 'comp' : 'model',
    selComp: '',
    // 导出页的导出对象（任务书 §3.1「其它页签对象」）：'doc:<签 id>' | 'lib:<库 id>' | ''。进导出页时按来处定缺省（设计页 → 激活签、库页 → 库选中项）
    exportTarget: ''
  })
  try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); if (Array.isArray(a)) st.imports = a.filter((x) => x && x.name && x.id).slice(0, RECENT_MAX).map(restoreJob) } catch { /* 便利数据，丢了无妨 */ }

  const cur = reactive({
    id: '', kind: '',            // kind：'glb' | 'tpl'（参数化模板）| 'param'（已存的参数化）| 'gen'（生成页的临时星）
    meta: null,                  // 工作副本（完整 ModelMeta）
    loading: false, stage: '', error: '',
    lod: '', wantLod: '',
    loadMs: 0,
    editable: false,
    saving: false, saveErr: '', savedAt: 0,
    rev: 0,                      // 元数据每改一次 +1（各节据此刷新派生读数）
    geomRev: 0,                  // 几何 / 轴向 / 缩放变了 +1（部件读数、挂点拾取要跟着重算）
    undoN: 0, redoN: 0,
    view: null,                  // 视口按屏上几何量出的读数 {bboxM, radiusM}（本体系、米、关节初值位姿）；不落盘（落盘的 bboxM 是模型轴）
    blank: '',                   // 视口空着时的一句状态（生成页缺值时「缺值。」）
    asm: false                   // 当前模型是装配件（asm: / 装配文档）：模型页只读，改动只能在装配页
  })
  let root = null, handle = null, paramRes = null
  let metaId = ''                // cur.meta 这份工作副本属于哪个模型（加载途中 cur.id 已经是新模型、cur.meta 还是旧的）
  let pend = null                // 待存的改动 {id}（排期时记下的 metaId）
  let vp = null
  const analyzer = createAnalyzer()

  const byId = (id) => st.list.find((e) => e.id === id) || null
  const selected = computed(() => byId(st.selId))
  const lang = () => (byLang('zh', 'en') === 'en' ? 'en' : 'zh')

  // ───────────────── IPC 包装 ─────────────────
  async function call(name, ...args) {
    if (!api || typeof api[name] !== 'function') return null
    try {
      const r = await api[name](...args)
      if (isLocked(r)) { st.locked = true; return LOCKED }
      return r
    } catch (e) {
      console.warn('[modelwb] ' + name + ' 失败：' + errText(e))
      return { ok: false, error: errText(e) }
    }
  }

  // ───────────────── 清单 ─────────────────
  let refreshing = null
  async function refresh() {
    if (refreshing) return refreshing
    refreshing = (async () => {
      const tpls = templateEntries()
      const ents = entityEntries()
      const tplById = new Map([...tpls, ...ents].map((t) => [t.id, t]))
      const r = api ? await call('manifest') : null
      // 内置清单里也登记了参数化模板（param:<模板 id>，带随包缩略图）：条目按清单的（缩略图 / 本机状态），身份仍是模板 ——
      // 选中走 templateSpec 现生成（清单条目没有 spec，当成「已存参数化模型」去 getMeta 会报缺参数）
      const models = (r && Array.isArray(r.models) ? r.models : []).map((m) => {
        const t = tplById.get(m.id)
        return t ? { ...m, origin: t.origin, tplOrder: t.tplOrder, templateId: t.templateId } : m
      })
      const have = new Set(models.map((m) => m.id))
      st.list = [...tpls.filter((t) => !have.has(t.id)), ...ents.filter((t) => !have.has(t.id)), ...models]
      if (r && r.prefs) st.prefs = r.prefs
      if (r && r.cache) st.cache = r.cache
      st.loaded = true
      // 条目的缩略图就绪状态可能变了（下载完 / 重拍过）：失败记账清掉，下次可见时再要
      for (const [id, s] of thumbState) if (s !== 'done') thumbState.delete(id)
      resumeAsmThumbs()
    })()
    try { await refreshing } finally { refreshing = null }
  }
  let refreshT = 0
  function refreshSoon(ms = 250) { clearTimeout(refreshT); refreshT = setTimeout(() => refresh(), ms) }
  async function refreshRemote() {
    st.busy = byLang('刷新清单…', 'Refreshing…')
    const r = await call('refreshManifest')
    st.busy = ''
    if (r === LOCKED) return
    await refresh()
    return r
  }

  // ───────────────── 下载进度与等待 ─────────────────
  const waiters = new Map()   // `${id}|${lod}` → [resolve]
  function waitDownload(id, lod, signal) {
    return new Promise((resolve) => {
      const k = id + '|' + lod
      if (!waiters.has(k)) waiters.set(k, [])
      const fn = (ev) => resolve(ev)
      waiters.get(k).push(fn)
      if (signal) signal.onAbort = () => resolve({ phase: 'aborted' })
    })
  }
  function onDownload(ev) {
    const id = ev.id
    if (!id) return
    const lod = ev.lod
    if (lod === 'thumb') {
      if (ev.phase === 'ready' || ev.phase === 'error' || ev.phase === 'canceled') { thumbState.delete(id); const e = byId(id); if (e) requestThumb(e) }
      return
    }
    if (ev.phase === 'ready' || ev.phase === 'error' || ev.phase === 'canceled') {
      delete st.dl[id]
      userDl.delete(id)
      if (ev.phase === 'ready') { noFull.delete(id); autoCanceled.delete(id) }
      // 主进程 cancel(id) 广播的 canceled 不带 lod（按条目取消它的全部下载）：这件各档的等待者一并放行，缩略图记账清掉（可见时再要）
      const ks = lod ? [id + '|' + lod] : [...waiters.keys()].filter((k) => k.startsWith(id + '|'))
      if (!lod) thumbState.delete(id)
      for (const k of ks) {
        const ws = waiters.get(k); waiters.delete(k)
        if (ws) for (const w of ws) w(ev)
      }
      refreshSoon(150)
      if (ev.phase === 'error') ui.hint(byLang('下载失败：', 'Download failed: ') + (ev.message || ''))
    } else {
      st.dl[id] = { lod, phase: ev.phase, received: ev.received || 0, total: ev.total || 0, message: ev.message || '' }
    }
  }

  // ───────────────── 缩略图 ─────────────────
  const thumbState = new Map()      // id → 'pending' | 'done' | 'fail'
  const THUMB_FETCH_MAX = 4e6       // 为出缩略图而下载的 lod2 体积上限（字节）
  let offlineSeen = false           // 拉 lod2 失败过一次（离线 / 服务不可达）就不再为缩略图下载，本窗口内不重试
  const renderQueue = []
  let rendering = false
  const objectUrls = []
  function requestThumb(e) {
    if (!e || !e.id || thumbState.has(e.id)) return
    thumbState.set(e.id, 'pending')
    // 模板：清单给了随包缩略图就用它（与别的内置卡片同一条出图管线），没给就当场画
    if (e.origin === 'template' && !(e.files && e.files.thumb)) { enqueueRender(() => templateThumb(e)); return }
    if (e.origin === 'entTemplate' && !(e.files && e.files.thumb)) { enqueueRender(() => entThumb(e)); return }
    thumbFromMain(e)
  }
  async function thumbFromMain(e) {
    const r = await call('thumbnail', e.id)
    if (e.origin === 'template' && !(r && r !== LOCKED && r.state === 'ready' && r.url)) { enqueueRender(() => templateThumb(e)); return }
    if (e.origin === 'entTemplate' && !(r && r !== LOCKED && r.state === 'ready' && r.url)) { enqueueRender(() => entThumb(e)); return }
    if (!r || r === LOCKED) { thumbState.set(e.id, 'fail'); return }
    if (r.state === 'ready' && r.url) { st.thumbs[e.id] = r.url; thumbState.set(e.id, 'done'); return }
    if (r.state === 'downloading') return   // 下载完成的事件会再要一次
    // 本机有模型但没有缩略图（老导入件 / 渲染失败过）：现场补一张并存回
    const f = e.local || {}
    if (f.lod0 === 'ready' || f.lod1 === 'ready' || f.lod2 === 'ready' || e.source?.kind === 'param') enqueueRender(() => rebakeThumb(e))
    // 云端条目清单里没带缩略图（离线管线还没出图时）：可见的卡片按需拉最轻的 lod2（≤ 4 MB）现场出图并存回 ——
    // 画廊一张张补齐，拉下来的 lod2 进缓存，点开预览也就不用再等。离线 / 拉不下来就留占位图，不重试。
    else if (!offlineSeen && e.origin === 'remote' && e.files && e.files.lod2 && e.files.lod2.bytes <= THUMB_FETCH_MAX) enqueueRender(() => rebakeThumb(e, { fetch: true }))
    else thumbState.set(e.id, 'fail')
  }
  function enqueueRender(job) {
    renderQueue.push(job)
    if (!rendering) pumpRender()
  }
  // 出图一张要占主线程几十到上百毫秒（离屏渲染 + 读回 + 编码）：两张之间等一次空闲回调（最多 250 ms），
  // 让拖动 / 滚动的帧先走 —— 装配页组件库一进来就要出十几张，一口气连着出会把界面卡成 10 fps
  const idleSlot = () => new Promise((r) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => r(), { timeout: 250 }) : setTimeout(r, 16)))
  async function pumpRender() {
    rendering = true
    while (renderQueue.length) {
      const job = renderQueue.shift()
      try { await job() } catch (err) { console.warn('[modelwb] 缩略图：' + errText(err)) }
      await idleSlot()
    }
    rendering = false
  }
  async function blobToU8(b) { return new Uint8Array(await b.arrayBuffer()) }
  function blobToDataUrl(b) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b) }) }
  /**
   * 星座精模缩略图：缓存键与 3D 页 modelThumbs.fleetThumb 同一把（值 {sig, url}，sig = fleetSig 几何签名，造型改了自动重画）。
   * 生成只要几毫秒，出图在主线程、两段之间让空闲时段（同 entThumb 的退路）。
   */
  async function fleetThumbWb(e) {
    const key = `model/fleetThumb/${TPL_THUMB_VER}-f1/${e.templateId}`
    const r = buildFleetModel(e.templateId)
    const sig = fleetSig(r)
    try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && c.sig === sig && c.url) { st.thumbs[e.id] = c.url; thumbState.set(e.id, 'done'); return } } catch { /* 坏缓存：重画 */ }
    await idleSlot()
    const rt = irToThree(r.ir)
    let blob
    try { await idleSlot(); blob = await renderThumb(rt, { frame: r.frame, units: { scaleToMeters: 1 }, articulations: r.articulations }, { size: 384 }) } finally { disposeObject(rt) }
    const url = await blobToDataUrl(blob)
    st.thumbs[e.id] = url
    thumbState.set(e.id, 'done')
    try { localStorage.setItem(key, JSON.stringify({ sig, url })) } catch { /* 配额满：下次再画 */ }
  }
  /**
   * 参数化模板缩略图：缓存键与 3D 页 modelThumbs.paramThumb 同一把，值 {sig, url}——sig 是生成结果的几何签名（fleetSig 同式：
   * specHash + 网格 / 节点矩阵 / 材质摘要）。生成器造型改了（2026-10-08 十字翼 / 反射面低挂等）旧图自动重画，不再靠升 TPL_THUMB_VER；
   * 老格式（值是裸 data URL）解析不出 sig，同样当过期重画。生成一颗模板十几到几十毫秒，在空闲时段里做。
   */
  async function templateThumb(e) {
    if (e.fleet) return fleetThumbWb(e)
    const key = `model/tplThumb/${TPL_THUMB_VER}/${e.templateId}`
    const t = templateSpec(e.templateId)
    await idleSlot()
    const r = buildParamModel(t.spec)
    const sig = fleetSig(r)
    const c = lsJson(key)
    if (c && c.sig === sig && c.url) { st.thumbs[e.id] = c.url; thumbState.set(e.id, 'done'); return }
    // 出图在 Worker 里做（生成 + 离屏渲染 + 编码；主线程第一次建离屏上下文光编着色器就要几百毫秒）；Worker 不可用退回主线程
    const w = await paramThumbInWorker(plain(t.spec), 384)
    let blob = w && w.ok && w.thumb ? new Blob([w.thumb], { type: w.thumbType || 'image/webp' }) : null
    if (!blob) {
      await idleSlot()
      const rt = irToThree(r.ir)
      try { await idleSlot(); blob = await renderThumb(rt, { frame: r.frame, units: { scaleToMeters: 1 } }, { size: 384 }) } finally { disposeObject(rt) }
    }
    const url = await blobToDataUrl(blob)
    st.thumbs[e.id] = url
    thumbState.set(e.id, 'done')
    lsPut(key, { sig, url })
  }
  /**
   * 实体模板缩略图（384 px）：本机缓存按模板文档哈希作废（模板数据改了自动重画）。出图在 Worker 里做（buildAssembly + 离屏渲染 + 编码；
   * 船模一张在主线程要 ~150 ms，库页一进来十几张）；Worker 不可用时退回主线程、各段之间让空闲时段。
   */
  async function entThumb(e) {
    const t = ENT && ENT.entityTemplateDoc(e.templateId || e.id)
    if (!t) { thumbState.set(e.id, 'fail'); return }
    const key = `model/entThumb/${TPL_THUMB_VER}-${ENT_THUMB_REV}/${e.id}`
    const sig = asmHash(t.doc)
    const c = lsJson(key)
    if (c && c.sig === sig && c.url) { st.thumbs[e.id] = c.url; thumbState.set(e.id, 'done'); return }
    let blob = null
    const w = await asmThumbInWorker(plain(t.doc), 384)
    if (w && w.ok && w.thumb) blob = new Blob([w.thumb], { type: w.thumbType || 'image/webp' })
    else {
      const r = buildAssembly(t.doc)
      await idleSlot()
      const rt = irToThree(r.ir)
      try {
        await idleSlot()
        // 关节元数据一起给：renderThumb 按关节初值摆静止位姿（地球站碟面按 el0 仰起、与 3D 页 / 装配页同样子）
        blob = await renderThumb(rt, { frame: r.frame, units: { scaleToMeters: 1 }, articulations: r.articulations }, { size: 384 })
      } finally { disposeObject(rt) }
    }
    const url = await blobToDataUrl(blob)
    st.thumbs[e.id] = url
    thumbState.set(e.id, 'done')
    lsPut(key, { sig, url })
  }
  /**
   * 装配页组件库卡片的缩略图：buildComponent → 128 px。卡片键 = type（缺省参数）或 `${type}#${型号 id}`（常用型号：按型号参数出图）。
   * 本机缓存键带几何签名（包围盒 / 网格规模 / 节点名），
   * 组件定义改了（A3 还在调几何）自动重画，不用等 TPL_THUMB_VER 升版。
   * 卫星件局部 −Z 贴父面、几何朝 +Z 长（显示系 +Z 朝下）：出图时绕 X 转 180°，一律「立着」拍；地面 / 飞机 / 船 / 车件本来就朝上长。
   */
  const compThumbState = new Map()
  function componentThumb(ckey) {
    if (!ckey || compThumbState.has(ckey)) return
    compThumbState.set(ckey, 'pending')
    enqueueRender(() => renderCompThumb(ckey))
  }
  async function renderCompThumb(ckey) {
    const hash = ckey.indexOf('#')
    const type = hash < 0 ? ckey : ckey.slice(0, hash)
    const pr = hash < 0 ? null : getPreset(type, ckey.slice(hash + 1))
    if (hash >= 0 && !pr) { compThumbState.set(ckey, 'fail'); return }
    const params = pr ? { ...pr.params } : {}
    const key0 = `model/asmThumb/${TPL_THUMB_VER}/${ckey}`
    const c0 = lsJson(key0)
    // 本机缓存那张先挂上（不等 Worker 起来）；Worker 里按几何签名复核，签名变了（组件定义改了）才出新图
    if (c0 && c0.url) st.compThumbs[ckey] = c0.url
    const w = await compThumbInWorker(type, 128, c0 && c0.url ? c0.sig : '', params)
    if (w && w.ok) {
      if (w.same && c0 && c0.url) { compThumbState.set(ckey, 'done'); return }
      if (w.thumb) {
        const url = await blobToDataUrl(new Blob([w.thumb], { type: w.thumbType || 'image/webp' }))
        st.compThumbs[ckey] = url
        compThumbState.set(ckey, 'done')
        lsPut(key0, { sig: w.sig, url })
        return
      }
    } else if (w && w.code === 'build') { compThumbState.set(ckey, 'fail'); return }
    // Worker 不可用 / 离屏 WebGL 起不来：退回主线程（原口径）
    let r = null
    try { r = buildComponent(type, params) } catch { compThumbState.set(ckey, 'fail'); return }
    const sig = fnv1a64Hex(canon({ b: r.bbox, m: r.ir.meshes.map((m) => [m.position.length, m.index.length, m.material]), n: r.ir.nodes.map((n) => n.name), k: r.ir.materials.map((x) => x && x.key) }))
    const key = key0
    const c = lsJson(key)
    if (c && c.sig === sig && c.url) { st.compThumbs[ckey] = c.url; compThumbState.set(ckey, 'done'); return }
    const def = getComponent(type)
    const ms = def ? r.sockets.find((s) => s.id === def.mountSocket) : null
    const q = ms && ms.n[2] < -0.5 ? [1, 0, 0, 0] : [0, 0, 0, 1]
    const rt = irToThree(r.ir)
    try {
      const blob = await renderThumb(rt, { frame: { q_model2body: q, t_model2body: [0, 0, 0] }, units: { scaleToMeters: 1 } }, { size: 128 })
      const url = await blobToDataUrl(blob)
      st.compThumbs[ckey] = url
      compThumbState.set(ckey, 'done')
      lsPut(key, { sig, url })
    } catch { compThumbState.set(ckey, 'fail') } finally { disposeObject(rt) }
  }
  async function rebakeThumb(e, o = {}) {
    let loaded = null, rt = null, meta = null
    try {
      meta = await call('getMeta', e.id)
      if (!meta || meta === LOCKED || meta.ok === false) { thumbState.set(e.id, 'fail'); return }
      if (meta.spec && meta.spec.kind !== 'assembly' && (e.source?.kind === 'param')) { const r = buildParamModel(meta.spec); rt = irToThree(r.ir) }
      else {
        let ens = await call('ensure', { id: e.id, lod: 'lod2' })
        if (o.fetch && ens && ens.state === 'downloading') {
          st.dl[e.id] = { lod: ens.lod || 'lod2', phase: 'downloading', received: ens.received || 0, total: ens.total || 0, message: '' }
          const ev = await waitDownload(e.id, ens.lod || 'lod2')
          ens = ev && ev.phase === 'ready' ? await call('ensure', { id: e.id, lod: 'lod2' }) : null
        }
        if (!ens || ens.state !== 'ready') {
          if (o.fetch && ens && (ens.state === 'missing' || ens.state === 'error')) offlineSeen = true
          thumbState.set(e.id, 'fail'); return
        }
        loaded = await loadModel(ens.url)
        rt = loaded.root
      }
      const blob = await renderThumb(rt, meta, { size: 512 })
      const url = URL.createObjectURL(blob); objectUrls.push(url)
      st.thumbs[e.id] = url
      thumbState.set(e.id, 'done')
      if (/webp/.test(blob.type)) call('saveThumb', { id: e.id, webp: await blobToU8(blob) })
    } finally {
      if (loaded) loaded.handle.release()
      else if (rt) disposeObject(rt)
    }
  }

  // ───────────────── 当前模型：加载 / 切换 ─────────────────
  let loadTok = 0
  // 拿不到 lod0 的件（见 select）：调用方（ModelApp）的 watch 带着 cur.loading，每加载完一次都会再调 ensureFullDetail —— 不记下就成了无限重载
  const noFull = new Set()
  // 设计页模型签自动拉全精度（syncModelDoc 先出低档 / ensureFullDetail 升 lod0）只为激活着的那一个模型签拉：autoFullId = 那一件。
  // 切走 / 关闭该签（stopAutoFull）取消它在途的下载——快速切签不让 lod0 下载并发堆积；再激活时按需重拉。
  // autoCanceled：被这样取消、还有 select 在等下载的件（等待者收到 canceled 不报「已取消。」，cur 退回屏上那件）；
  // userDl：库页「下载」显式要的（切签不取消它）
  let autoFullId = ''
  const autoCanceled = new Set()
  const userDl = new Set()
  function setViewport(v) { vp = v; if (root && cur.meta && !st.vpOwner) { vp.setModel(root, viewMeta()); syncView() } }
  function viewMeta() { return plain(cur.meta) }
  function releaseCurrent() {
    if (handle) { handle.release(); handle = null } else if (root) disposeObject(root)
    root = null; paramRes = null
  }
  /**
   * 换上一个模型根。o.keepMeta：同一模型换 LOD（升档 / 模型页要全精度）—— 元数据工作副本、撤销栈、待存改动、关节滑杆都原样留着，只换几何。
   */
  let warmTok = 0   // adoptRoot 的「先编译再挂」作业号：期间又换了模型，旧的那份不再挂
  function adoptRoot(r, h, meta, kind, lod, o = {}) {
    const same = !!o.keepMeta
    if (!same && pend) flushSave()   // 旧模型的待存改动按旧 id 先存掉（同步读的是还没换掉的 cur.meta）
    const prevId = metaId
    releaseCurrent()
    root = r ? markRaw(r) : null; handle = h || null
    cur.meta = meta
    metaId = meta ? cur.id : ''
    // 刚分析完的导入件：这份元数据可能取在分析落盘之前（大件解析要几秒），补并分析结果（见 notePostImport）
    if (!same && metaId) reapplyPostImport(metaId)
    cur.kind = kind; cur.lod = lod || ''
    // 装配件（入库的 asm: 与实体模板预览）：frame / 挂点 / 关节都由装配文档生成，模型页改了下次入库就被盖掉 → 只读
    cur.asm = !!(meta && ((typeof cur.id === 'string' && cur.id.startsWith('asm:')) || (meta.spec && meta.spec.kind === 'assembly')))
    cur.editable = !!api && (kind === 'glb' || kind === 'param') && !st.locked && !cur.asm
    cur.blank = ''
    if (!same) { cur.saveErr = ''; clearUndo() }
    cur.rev++; cur.geomRev++
    if (vp && !st.vpOwner) {
      const vo = { keepView: !!o.keepView && prevId === metaId, keepPose: same }
      const tok = ++warmTok
      if (o.warm && root && typeof vp.precompile === 'function') {
        // 视口从装配页收回、整件重读刚入库的这份（staleAsm）：先把它的材质异步编好（KHR_parallel_shader_compile）再挂——
        // 第一帧不再同步 link 着色器；挂上之前视口照旧显示装配页留下的那份
        const r0 = root
        Promise.resolve(vp.precompile(r0)).catch(() => null).then(() => {
          if (tok !== warmTok || root !== r0 || st.vpOwner) return
          vp.setModel(root, viewMeta(), vo)
          syncView()
        })
      } else {
        vp.setModel(root, viewMeta(), vo)
        syncView()
      }
    }
  }
  /** 视口读数（本体系、米、关节初值位姿；逐顶点精确）：只作显示，不写进元数据 */
  function syncView() {
    if (!vp || !root) { cur.view = null; return }
    const b = vp.bounds
    cur.view = { bboxM: { min: b.bboxBody.min.slice(), max: b.bboxBody.max.slice() }, radiusM: b.radiusFromOrigin }
  }
  /**
   * 用户改了轴向 / 缩放 / 原点之后：包围盒跟着几何走，写回 geometry（这是用户改动的一部分，随之落盘）。
   * bboxM 是模型轴米（轴映射终案 ④）：换轴向 / 原点它本来就不变，缩放由 wbLogic 按解析式 ×k；这里再按屏上几何逐顶点重量一遍
   * （模型轴下、关节初值位姿），只在屏上是全精度几何（lod0 / 参数化）时写 —— lod2 抽稀过，外包比原件小一圈。
   * boundingRadiusM（离本体原点的最远距离）随平移原点变，同样按屏上重量。三角形数不动（那是 lod0 的，屏上可能是别档）。
   */
  function syncGeometryFromView() {
    syncView()
    if (!vp || !cur.meta || !root) return
    if (cur.kind === 'glb' && cur.lod !== 'lod0') return
    const b = vp.bounds
    const g = cur.meta.geometry || (cur.meta.geometry = {})
    if (b.bboxModelM) g.bboxM = { min: b.bboxModelM.min.map((v) => +v.toFixed(6)), max: b.bboxModelM.max.map((v) => +v.toFixed(6)) }
    g.boundingRadiusM = +b.radiusFromOrigin.toFixed(6)
  }

  async function fullMeta(e) {
    const m = await call('getMeta', e.id)
    if (m && m !== LOCKED && m.ok !== false && m.id) return m
    return normalizeMeta(e)   // 未激活 / 取不到：用清单精简版
  }

  /**
   * 取某档的 URL：就绪直接给；在下载就先给回退档（能先出图），完成事件到了再换。
   * auto（设计页模型签自动拉全精度）：ensure 回来时该签已被切走 / 关掉（autoFullId 换了）→ 刚起的下载当场取消、返回 null；
   * 等下载期间被 stopAutoFull 取消 → 返回 null（不报「已取消。」）。
   */
  async function ensureUrl(id, lod, tok, auto) {
    for (let guard = 0; guard < 3; guard++) {
      const r = await call('ensure', { id, lod })
      if (!r || r === LOCKED) throw new Error(byLang('无法读取模型。', 'Cannot read model.'))
      if (r.ok === false) throw new Error(r.error || '')
      if (r.state === 'ready') return { url: r.url, lod: r.lod || lod }
      if (r.state === 'param') return { param: true }
      if (r.state === 'missing') throw new Error(byLang('本机不存在该模型文件。', 'Model file not available.'))
      if (r.state === 'error') { if (r.fallback && r.fallback.url) return { url: r.fallback.url, lod: r.fallback.lod }; throw new Error(r.message || byLang('下载失败。', 'Download failed.')) }
      if (r.state === 'downloading') {
        if (auto && autoFullId !== id && !userDl.has(id)) { cancel(id); return null }
        st.dl[id] = { lod: r.lod, phase: 'downloading', received: r.received || 0, total: r.total || 0, message: '' }
        if (r.fallback && r.fallback.url) return { url: r.fallback.url, lod: r.fallback.lod, pending: r.lod }
        cur.stage = 'download'
        const ev = await waitDownload(id, r.lod)
        if (tok !== loadTok) return null
        if (ev.phase === 'error') throw new Error(ev.message || byLang('下载失败。', 'Download failed.'))
        if (ev.phase === 'canceled') { if (autoCanceled.delete(id)) return null; throw new Error(byLang('已取消。', 'Canceled.')) }
      }
    }
    throw new Error(byLang('无法读取模型。', 'Cannot read model.'))
  }

  /**
   * 选中并预览 / 编辑一个库条目。lod：库页预览按体积取最细的一档（wbLogic.previewLod）；模型 / 导出页要 'lod0'（部件三角形号、拾取、导出都以 lod0 为准）。
   * @param {string} id
   * @param {{lod?:string, keepView?:boolean, force?:boolean, fresh?:boolean}} [o] fresh：连元数据一起重读（不走同一模型换档的保留元数据分支）
   */
  async function select(id, o = {}) {
    const e = byId(id)
    st.selId = id
    st.selComp = ''   // 视口换成库条目：库页组件档的预览不再挂着（previewComp 反过来清 selId）
    if (!e) return
    const want = o.lod || 'lod2'
    if (!o.force && cur.id === id && !cur.error && (cur.kind !== 'glb' || lodRank(cur.lod) >= lodRank(want) || cur.loading && lodRank(cur.wantLod) >= lodRank(want))) return
    const tok = ++loadTok
    // 换到另一件：新件的元数据到位之前表单只读（cur.id 已是新件、cur.meta 还是旧件，这期间改的会落进旧件）；adoptRoot 按新件重定
    if (cur.id !== id) cur.editable = false
    cur.id = id; cur.error = ''; cur.loading = true; cur.stage = 'load'; cur.wantLod = want
    const t0 = performance.now()
    try {
      if (e.origin === 'entTemplate') {
        const t = ENT && ENT.entityTemplateDoc(e.templateId || e.id)
        if (!t) throw new Error(byLang('实体模板不可用。', 'Template unavailable.'))
        if (tok !== loadTok) return
        showAssembly(t.doc, { id: e.id, name: e.titleZh || e.title, title: e.title, source: plain(e.source) }, o)
      } else if (e.origin === 'template') {
        const r = e.fleet ? buildFleetModel(e.templateId) : buildParamModel(templateSpec(e.templateId).spec)
        if (tok !== loadTok) return
        const meta = paramMeta(r, { id: e.id, title: e.title, titleZh: e.titleZh, source: e.source })
        adoptRoot(irToThree(r.ir), null, meta, 'tpl', 'lod0', o)
        paramRes = r
      } else if (e.source && e.source.kind === 'param' && !(e.spec && e.spec.kind === 'assembly')) {
        const meta = await fullMeta(e)
        if (tok !== loadTok) return
        if (!meta.spec) throw new Error(byLang('参数化模型缺少生成参数。', 'Missing spec.'))
        if (meta.spec.kind === 'assembly') throw new Error(byLang('装配文档仅支持 asm: id。', 'Assembly spec requires an asm: id.'))
        const r = buildParamModel(meta.spec)
        // 几何按 spec 现生成；质量特性 / 轴向 / 部件 / 关节 / 太阳翼组 / 挂点以存档为准（用户在模型页改过的都在里面）
        const full = mergeParamMeta(meta, { ...paramGeomFields(r), attachPoints: plain(r.attachPoints) })
        adoptRoot(irToThree(r.ir), null, full, 'param', 'lod0', o)
        paramRes = r
      } else {
        // 同一模型换档（lod2 → lod0：升档、模型 / 导出页要全精度）：元数据工作副本就是最新的（可能刚改过、还没存），
        // 不再 getMeta 覆盖它，撤销栈也留着 —— 只换几何。o.fresh：库里那份整件换过了（装配件重新入库）→ 元数据也要重读
        const upgrade = !o.fresh && metaId === id && !!cur.meta && cur.kind === 'glb'
        const meta = upgrade ? null : await fullMeta(e)
        if (tok !== loadTok) return
        const u = await ensureUrl(id, want, tok, !!o.auto)
        if (!u || tok !== loadTok) {
          // 自动拉全精度被取消（切走 / 关了模型签）且这件还没换上：cur 退回屏上那件（cur.id 与元数据 / 视口一致；再激活该签时 syncModelDoc 重拉）
          if (!u && tok === loadTok && metaId !== id) cur.id = metaId
          return
        }
        // 要 lod0 却只拿到低档、也没在下载（离线、只有随包的 lod2）：记下，ensureFullDetail 不再对它反复升档（下载完成时清掉）
        if (want === 'lod0' && u.lod && u.lod !== 'lod0' && !u.pending) noFull.add(id); else if (u.lod === 'lod0') noFull.delete(id)
        cur.stage = 'parse'
        const loaded = await loadModel(u.url, { renderer: vp ? vp.renderer : undefined })
        if (tok !== loadTok) { loaded.handle.release(); return }
        // （换别的模型、生成页出图、删除都会先 ++loadTok，走到这里 metaId 仍是 id）
        if (upgrade) adoptRoot(loaded.root, loaded.handle, cur.meta, 'glb', u.lod, { ...o, keepMeta: true, keepView: true })
        else adoptRoot(loaded.root, loaded.handle, meta, 'glb', u.lod, o)
        if (u.pending) upgradeWhenReady(id, u.pending, tok)
      }
      cur.loadMs = Math.round(performance.now() - t0)
    } catch (err) {
      if (tok === loadTok) cur.error = errText(err)
    } finally {
      if (tok === loadTok) { cur.loading = false; cur.stage = '' }
    }
  }
  const lodRank = (l) => (l === 'lod0' ? 3 : l === 'lod1' ? 2 : l === 'lod2' ? 1 : 0)
  async function upgradeWhenReady(id, lod, tok) {
    const ev = await waitDownload(id, lod)
    if (tok !== loadTok || cur.id !== id || ev.phase !== 'ready') return
    select(id, { lod, keepView: true, force: true })
  }
  /**
   * 当前模型换成 lod0（设计页模型签 / 导出页进来时调；已经是 lod0 就不动）。
   * 正在加载（模型签先按本机现成的低档立即出图）：等这一档挂上再升，不把它半路取消 —— 调用方的 watch 带着 cur.loading，加载完会再调一次。
   * 设计页激活的是模型签：cur 不是那一件（自动拉取被取消后退回了屏上那件 / 别页改写过）先跟上它；升档记为该签的自动拉取（切走即取消）。
   */
  function ensureFullDetail() {
    const d = st.tab === 'design' ? activeDocState() : null
    const auto = !!d && d.kind === 'model'
    if (auto && cur.id !== d.libId) { if (!cur.loading) syncModelDoc(); return }
    // 出错 / 元数据还不是这一件（cur.kind、cur.lod 属于屏上那件）：不升，否则出错的件每加载完一次又升一次
    if (!cur.id || cur.kind !== 'glb' || cur.loading || cur.error || metaId !== cur.id) return
    if (cur.lod === 'lod0' || noFull.has(cur.id)) return
    if (auto) autoFullId = cur.id
    select(cur.id, { lod: 'lod0', keepView: true, force: true, auto })
  }
  /** 模型签被切走 / 关掉：它自动拉的全精度若还在下载就取消（库页显式「下载」的不动）；有 select 在等这次下载 → 记下，等待者静默返回 */
  function stopAutoFull(libId) {
    if (!libId || autoFullId !== libId) return
    autoFullId = ''
    const dl = st.dl[libId]
    if (!dl || dl.lod === 'thumb' || userDl.has(libId)) return
    if (cur.id === libId && cur.loading) autoCanceled.add(libId)
    cancel(libId)
  }
  /** 这一件拿不到全精度（离线、只有随包的低档）：元数据副本按它禁用 */
  const fullDetailMissing = (id) => noFull.has(id)

  // 参数化结果 → 元数据（几何字段来自生成结果；本机无文件）
  function paramGeomFields(r) {
    return {
      frame: plain(r.frame),
      units: { scaleToMeters: 1, unitGuess: 'm', sizeVerified: false },
      parts: plain(r.parts), massProps: { massKg: r.massProps.massKg, comBody: r.massProps.comBody, inertiaBody: r.massProps.inertiaBody, source: 'components', confidence: 'low' },
      articulations: plain(r.articulations), solarPanelGroups: plain(r.solarPanelGroups),
      // bboxM：模型轴米（paramBus 按本体系量的 bboxBody 经 frame 逆变换；STK 映射是带号置换，精确）
      geometry: { bboxM: bodyBoxToModelBox(r.bboxBody, r.frame) || plain(r.bboxBody), boundingRadiusM: r.boundingRadiusM, tris: r.ir.meshes.reduce((s, m) => s + m.index.length / 3, 0), areaM2: 0, volumeM3: null, closed: false, centroidM: [0, 0, 0] }
    }
  }
  function paramMeta(r, base) {
    return normalizeMeta({
      schema: 2, kind: 'spacecraft', group: 'spacecraft', fidelity: 'parametric',
      ...base, spec: plain(r.spec), attachPoints: plain(r.attachPoints), ...paramGeomFields(r)
    })
  }
  /** 生成页：把一次生成结果挂到视口（临时星，不可编辑、不落盘） */
  function showGenerated(r, base, o = {}) {
    ++loadTok
    cur.id = base.id; cur.error = ''; cur.loading = false; cur.stage = ''
    const meta = paramMeta(r, base)
    adoptRoot(irToThree(r.ir), null, meta, 'gen', 'lod0', { keepView: o.keepView })
    paramRes = r
  }
  /** 视口清空、只留一句状态（生成页缺值时：上一颗星留在屏上会被当成当前参数的结果） */
  function showBlank(text) {
    ++loadTok
    if (pend) flushSave()
    releaseCurrent()
    cur.id = ''; cur.meta = null; cur.kind = ''; cur.lod = ''; cur.editable = false; cur.asm = false
    cur.error = ''; cur.loading = false; cur.stage = ''; cur.saveErr = ''
    cur.blank = text || ''
    metaId = ''
    clearUndo()
    cur.rev++; cur.geomRev++
    cur.view = null
    if (vp && !st.vpOwner) vp.setModel(null, null)
  }

  // ───────────────── 撤销 / 重做（元数据快照；换模型清空）─────────────────
  const undoStack = [], redoStack = []
  function pushUndo() {
    if (!cur.meta) return
    undoStack.push(JSON.stringify(cur.meta))
    if (undoStack.length > 60) undoStack.shift()
    redoStack.length = 0
    cur.undoN = undoStack.length; cur.redoN = 0
  }
  function dropUndo() { undoStack.pop(); cur.undoN = undoStack.length }
  function restoreSnap(json) {
    const m = JSON.parse(json)
    const geom = JSON.stringify([m.frame, m.units]) !== JSON.stringify([cur.meta.frame, cur.meta.units])
    cur.meta = m
    cur.rev++
    if (geom) cur.geomRev++
    // 快照里的 geometry 就是当时的，不必重量；只刷新读数
    if (vp && root && !st.vpOwner) { vp.setModel(root, viewMeta(), { keepView: true }); if (geom) syncView() }
    if (cur.editable) saveSoon()
  }
  function undo() {
    if (!undoStack.length || !cur.meta) return false
    redoStack.push(JSON.stringify(cur.meta))
    restoreSnap(undoStack.pop())
    cur.undoN = undoStack.length; cur.redoN = redoStack.length
    return true
  }
  function redo() {
    if (!redoStack.length || !cur.meta) return false
    undoStack.push(JSON.stringify(cur.meta))
    restoreSnap(redoStack.pop())
    cur.undoN = undoStack.length; cur.redoN = redoStack.length
    return true
  }
  function clearUndo() { undoStack.length = 0; redoStack.length = 0; cur.undoN = 0; cur.redoN = 0 }

  // ───────────────── 元数据编辑与落盘 ─────────────────
  let saveT = 0
  /** 有没有待存的改动（验证台 / 关窗用） */
  const hasPending = () => !!pend
  /**
   * 改工作副本：fn(meta) 就地改（meta 是响应式代理）。geom=true 表示轴向 / 缩放 / 几何口径变了（重算包围盒）。
   * 视口立即按新元数据重喂；可编辑的模型 500 ms 后落盘。undo:false = 调用方已自己压过撤销快照（表格内核的 pushUndo）。
   */
  function edit(fn, o = {}) {
    if (!cur.meta) return
    if (o.undo !== false) pushUndo()
    fn(cur.meta)
    cur.rev++
    if (o.geom) cur.geomRev++
    if (vp && root && !st.vpOwner) {
      vp.setModel(root, viewMeta(), { keepView: true })
      if (o.geom) syncGeometryFromView()
    }
    if (cur.editable && o.save !== false) saveSoon()
  }
  function saveSoon() {
    if (!cur.editable || !metaId) return
    pend = { id: metaId }
    clearTimeout(saveT); saveT = setTimeout(flushSave, 500)
  }
  /**
   * 把待存的改动写出去（没有待存的就什么都不做 —— 关窗时照样调，浏览过的模型不会被写出覆盖层）。
   * 同步段就把 id 与元数据快照取好：换模型之前调它，读到的还是旧模型那一份。
   */
  async function flushSave() {
    clearTimeout(saveT); saveT = 0
    const p = pend; pend = null
    if (!p || !cur.meta || p.id !== metaId) return
    const meta = plain(cur.meta)
    cur.saving = true
    const r = await call('saveMeta', { id: p.id, meta })
    cur.saving = false
    if (!r || r === LOCKED || metaId !== p.id) return   // 存完已经换了模型：状态不往新模型上记
    if (r.ok) { cur.saveErr = ''; cur.savedAt = Date.now() }
    else cur.saveErr = (r.errors && r.errors.length ? r.errors.slice(0, 3).join('；') : (r.error || byLang('保存失败', 'Save failed')))
  }
  /** 当前模型的根（导出 / 缩略图 / 分析用；只读，别改） */
  const currentRoot = () => root
  const currentParam = () => paramRes

  // ───────────────── 库操作 ─────────────────
  async function download(id, lod = 'lod0') {
    const r = await call('ensure', { id, lod })
    if (!r || r === LOCKED) return
    if (r.state === 'downloading') { userDl.add(id); st.dl[id] = { lod: r.lod, phase: 'downloading', received: r.received || 0, total: r.total || 0, message: '' } }
    else if (r.state === 'error') ui.hint(byLang('下载失败：', 'Download failed: ') + (r.message || ''))
    else if (r.state === 'missing') ui.hint(byLang('离线，无法下载。', 'Offline.'))
    else refreshSoon(0)
  }
  function cancel(id) { if (api) try { api.cancel(id) } catch { /* 无 */ } delete st.dl[id]; userDl.delete(id) }
  async function remove(id) {
    const e = byId(id)
    if (!e || e.origin === 'template' || e.origin === 'entTemplate') return
    const f = entryFacts(e)
    const local = f.local || f.stk || (e.source && e.source.kind === 'param')
    const ok = await ui.askConfirm(local ? byLang('删除本机模型「', 'Delete local model “') + (e.titleZh || e.title) + byLang('」？', '”?') : byLang('移除「', 'Remove cached files of “') + (e.titleZh || e.title) + byLang('」的本机缓存？', '”?'))
    if (!ok) return
    // 要删的模型还有没存的改动：不存了（删完再写只会凭空写出一份覆盖层 / 孤立元数据）；别的模型的照常先存
    if (pend && pend.id === id && local) { clearTimeout(saveT); saveT = 0; pend = null }
    // 打开着的签（装配件本身 / 它的模型签）：先停自动保存（否则删完它又被存回来），删完关签、清暂存与草稿
    const victims = local ? st.docs.filter((d) => d.id === id || d.libId === id) : []
    if (local) for (const d of victims) if (d.kind === 'asm') { asmRemoved.add(id); d._rt.removed = true; clearTimeout(d._rt.saveT); d._rt.saveT = 0; cancelDraftWrite(d); d.dirty = false }
    const r = await call('remove', id)
    if (!r || r === LOCKED) return
    if (local) {
      for (const d of victims) dropDoc(d)
      if (id.startsWith('asm:')) { dropDraft(id); lsPut(provKey(id), null) }
    }
    if (cur.id === id && local) { showBlank('') }
    thumbState.delete(id); delete st.thumbs[id]; postDone.delete(id)
    await refresh()
    ui.toast(local ? byLang('已删除。', 'Deleted.') : byLang('缓存已移除。', 'Cache removed.'))
  }
  async function setGeoDefault(id) {
    const r = await call('bindingsSet', { prefs: { ...plain(st.prefs || {}), geoDefault: id } })
    if (!r || r === LOCKED) return
    if (r.ok === false) { ui.hint((r.errors && r.errors[0]) || r.error || ''); return }
    st.prefs = { ...st.prefs, geoDefault: id }
    ui.toast(byLang('已设为 GEO 默认模型。', 'Set as GEO default.'))
  }

  // ───────────────── 导入 ─────────────────
  const jobsQueue = []
  let importing = false
  function persistRecent() {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(st.imports.slice(0, RECENT_MAX).map((j) => ({ id: j.id, name: j.name, fmt: j.fmt, tris: j.tris, ms: j.ms, modelId: j.modelId, phase: j.phase, error: j.error, at: j.at })))) } catch { /* 便利数据 */ }
  }
  function newJob(o) {
    // id = 作业自己的键（表格行键）；modelId = 入库后的模型 id
    const j = reactive({ id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: o.name, fmt: extOf(o.name), path: o.path || '', bytes: o.bytes || null, route: o.route || importRoute(o.name), stk: o.stk || null, phase: 'queued', tris: null, ms: null, modelId: '', error: '', at: Date.now(), live: true, token: '' })
    st.imports.unshift(j)
    if (st.imports.length > RECENT_MAX) st.imports.length = RECENT_MAX
    return j
  }
  /** 导入若干文件：[{path?, name, bytes?}]（原生对话框给 path；拖放在拿不到路径时给 bytes） */
  function importFiles(files) {
    const list = []
    for (const f of files || []) {
      if (!f || !f.name) continue
      const route = importRoute(f.name)
      if (!route) { const j = newJob({ name: f.name, route: null }); j.phase = 'error'; j.error = byLang('不支持的格式', 'Unsupported format'); j.live = false; continue }
      list.push(newJob({ ...f, route }))
    }
    for (const j of list) jobsQueue.push(j)
    persistRecent()
    if (!importing) pumpImports()
    return list
  }
  /** STK 本机导入：{dir, files:[rel]} → 一个作业一批 */
  function importStk(dir, files) {
    const j = newJob({ name: files.length === 1 ? files[0] : `STK × ${files.length}`, route: 'stk', stk: { dir, files: files.slice() } })
    j.fmt = 'stk'
    jobsQueue.push(j)
    persistRecent()
    if (!importing) pumpImports()
    return j
  }
  async function pumpImports() {
    importing = true
    let lastId = ''
    // 导完自动选中最后一件 —— 只在用户还在导入页、这期间也没选过别的模型时：否则正在模型页改别的星、或在生成页，
    // 导入一完成预览和表单就被换掉（还会顺手把正在改的那颗的待存改动冲掉）
    const selAt = st.selId
    while (jobsQueue.length) {
      const j = jobsQueue.shift()
      const t0 = performance.now()
      try {
        const ids = await runImport(j)
        // 库里早就有的件（同一文件再导入，主进程回 existed）：不再自动分割 / 重存元数据——部件表可能已手工标定（改名、合并、角色），
        // 整表换成自动识别结果会丢（postImport 再按「已有部件表」兜一道）
        for (const id of ids) { j.phase = 'analyze'; persistRecent(); await postImport(id, j, { existed: !!(j.existedIds && j.existedIds.includes(id)) }); lastId = id }
        j.phase = 'done'
        if (j.ms == null) j.ms = Math.round(performance.now() - t0)
      } catch (err) {
        if (j.aborted) { j.phase = 'canceled'; j.error = '' } else { j.phase = 'error'; j.error = errText(err) }
      }
      j.live = false; j.bytes = null
      persistRecent()
    }
    importing = false
    await refresh()
    if (lastId && st.tab === 'import' && st.selId === selAt) select(lastId, { lod: 'lod2', force: true })
  }
  async function runImport(j) {
    if (!api) throw new Error(byLang('需在桌面客户端中运行', 'Desktop client required'))
    if (j.route === 'glb') {
      j.phase = 'read'
      const r = await call('importGlb', j.path ? { path: j.path } : { bytes: j.bytes, name: j.name })
      if (r === LOCKED) throw new Error(byLang('未激活', 'Not activated'))
      if (!r || !r.ok) throw new Error((r && r.error) || byLang('导入失败', 'Import failed'))
      j.modelId = r.id
      j.tris = r.meta && r.meta.geometry ? r.meta.geometry.tris : null
      // 材质兜底（与 OBJ / STL / FBX、离线管线同口径）：主进程原样入库之后，对存下来的那一份 JSON 块补一道，改了就重存、原件删掉
      const fx = r.existed ? null : await glbMaterialFallback(r.id, r.meta)
      if (fx) {
        j.modelId = fx.id
        j.matNote = { noMaterial: fx.stats.noMaterialPrims, fixed: fx.stats.degenerate.fixed.slice(0, 8) }
        if (fx.existed) j.existedIds = [fx.id]
        return [fx.id]
      }
      if (r.existed) j.existedIds = [r.id]
      return [r.id]
    }
    if (j.route === 'cad') {
      if (!j.path) throw new Error(byLang('STEP / IGES / BREP 需要文件路径', 'File path required'))
      j.token = 'wb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
      j.phase = 'start'
      cadJobs.set(j.token, j)
      const r = await call('importCad', { path: j.path, token: j.token })
      cadJobs.delete(j.token)
      if (r === LOCKED) throw new Error(byLang('未激活', 'Not activated'))
      if (!r || !r.ok) throw new Error((r && r.error) || byLang('导入失败', 'Import failed'))
      j.modelId = r.id; j.tris = r.tris; j.ms = r.ms
      if (r.existed) j.existedIds = [r.id]
      return [r.id]
    }
    if (j.route === 'mesh') {
      const stop = () => { if (j.aborted) throw new Error(byLang('已取消', 'Canceled')) }
      j.phase = 'read'
      let bytes = j.bytes, dir = ''
      if (j.path) {
        const f = await call('readFile', j.path)
        if (!f || f === LOCKED || f.ok === false || !f.bytes) throw new Error((f && f.error) || byLang('读取失败', 'Read failed'))
        bytes = f.bytes; dir = f.dir || dirOf(j.path)
      }
      stop()
      j.phase = 'convert'
      const readSibling = async (rel) => {
        if (!dir) return null
        const f = await call('readFile', joinPath(dir, rel))
        return f && f.bytes ? f.bytes : null
      }
      const imp = await importFile({ bytes, name: j.name }, { readSibling })
      j.tris = imp.tris
      try {
        stop()
        // 单位：按模型原单位的包围盒最大边 + 导出器线索（OBJ 头注释 / FBX UnitScaleFactor）猜；STL 在厘米 / 毫米两可的那一档按毫米
        const box = new THREE.Box3().setFromObject(imp.root, true)
        const size = box.getSize(new THREE.Vector3())
        const span = Math.max(size.x, size.y, size.z)
        const head = imp.format === 'obj' ? new TextDecoder().decode(bytes.subarray(0, 4096)) : ''
        const ug = meshUnitTieBreak(guessUnits({ bboxSpanModelUnits: span, sourceFormat: imp.format, headerHints: { objHeader: head, objUnit: imp.unitHint !== 'unknown' ? imp.unitHint : undefined, fbxUnitScaleFactor: imp.fbxUnitScaleFactor ?? undefined } }), imp.format)
        // ★ glb 按【源单位】存（导出时比例取 1、不烘进几何），猜出来的单位写进 units：「单位」节看得到这次猜的是什么，
        //   猜错了改比例 / 已知尺寸反算就能纠正。烘进去再标「米 × 1」，推断结果就丢了（mm 件被猜成 cm 时大十倍却无从察觉）
        // 轴向缺省按来源（轴映射终案 ②）：用户导入的普通件按 glTF「+Y 朝上」建模 → +Y 天顶（Q_YUP_ZENITH）；导出时烘成 STK 映射落盘
        const meta = normalizeMeta({
          id: '', title: stemOf(j.name), kind: 'spacecraft', fidelity: 'cad',
          source: { kind: 'user', url: '', credit: '', license: '', redistributable: true },
          units: { scaleToMeters: 1, unitGuess: 'unknown', sizeVerified: false },
          frame: { q_model2body: defaultImportQ({ sourceKind: 'user', hasAgi: false, satsimFrame: null }), t_model2body: [0, 0, 0], verified: false }
        })
        // stamp:false：导出时刻不写进 extras.satsim——入库 id = glb 字节 sha，同一文件再导入得出同一份字节，主进程才认得出是同一件
        //（existed：已标定的部件表 / 单位 / 本体轴不被重做覆盖，库里也不多出一份）。体检 2026-10-16 二.24
        const out = await exportGlb(imp.root, meta, { originAtCom: false, stamp: false })
        stop()
        j.phase = 'write'
        // 只带身份与口径（名称 / 类别 / 细节档 / 单位 / 本体轴）：三角形数与包围盒由主进程按这份 glb 算，部件 / 面积 / 体积由 postImport 补。
        // 整份 satsimJson 里有 normalizeMeta 补出的全零 geometry，带过去会盖掉主进程算的值（「概况 · 三角形」恒为 0）
        const sj = out.satsimJson
        const r = await call('saveImported', { glb: out.glb, meta: { title: sj.title, kind: sj.kind, fidelity: sj.fidelity, frame: sj.frame, units: { scaleToMeters: ug.scaleToMeters, unitGuess: ug.unitGuess, sizeVerified: false } } })
        if (r === LOCKED) throw new Error(byLang('未激活', 'Not activated'))
        if (!r || !r.ok) throw new Error((r && r.error) || byLang('保存失败', 'Save failed'))
        j.modelId = r.id
        if (r.existed) j.existedIds = [r.id]
        // 导入器告警（缺少贴图 / 材质库）进作业读数：OBJ 的 .mtl 引用的贴图读不到时模型照样入库，只是没贴图——不能一声不吭
        if (Array.isArray(imp.warnings) && imp.warnings.length) j.error = [j.error, ...imp.warnings.slice(0, 3)].filter(Boolean).join('；')
        j.unitNote = `${ug.unitGuess} · ${ug.rule}`
        const mf = imp.materialFallback
        if (mf && (mf.noMaterialMeshes || mf.degenerate.fixed.length)) j.matNote = { noMaterial: mf.noMaterialMeshes, fixed: mf.degenerate.fixed.slice(0, 8) }
        return [r.id]
      } finally { disposeObject(imp.root) }
    }
    if (j.route === 'stk') {
      j.phase = 'read'
      // ★ j 是 reactive：j.stk.files 是 Vue 代理，过 contextBridge 就抛「An object could not be cloned」—— 现造纯数组
      const r = await call('importStk', { dir: String(j.stk.dir), files: [...j.stk.files].map(String) })
      if (r === LOCKED) throw new Error(byLang('未激活', 'Not activated'))
      if (!r || r.ok === false) throw new Error((r && r.error) || byLang('导入失败', 'Import failed'))
      const ids = (r.imported || []).map((x) => x.id)
      j.existedIds = (r.imported || []).filter((x) => x.existed).map((x) => x.id)
      if (r.errors && r.errors.length) j.error = r.errors.map((x) => `${x.file}：${x.message}`).slice(0, 3).join('；')
      j.modelId = ids[ids.length - 1] || ''
      if (!ids.length) throw new Error(j.error || byLang('未导入任何模型', 'Nothing imported'))
      return ids
    }
    throw new Error(byLang('不支持的格式', 'Unsupported format'))
  }
  /**
   * 普通 glb / glTF 入库后的材质兜底（materials.gltfMaterialFallback：无材质图元 → 中性浅灰、退化黑按名字还原）。
   *   · 只对本次新入库的用户件做（existed：库里早就有的不动 —— 可能已被卫星绑定引用）；STK 本机件（stk-local）不经这里
   *     （saveImported 也不收），授权闸不变：importGlb 已按原路径 / 原字节判过身份，重存的这份只改了材质。
   *   · 只改 JSON 块（glb.patchGlbJson：BIN 与其它块逐字节不动）；一处都不用改时什么都不做。
   *   · 改了：saveImported 存成新 id（用户件 id 跟文件 sha 走）、删掉原样入库的那一份；存不上就留原件（能用，只是没兜底）。
   * @returns {Promise<{id:string, stats:object, existed:boolean}|null>}  existed：兜底后的那份字节库里早就有（同一文件再导入）
   */
  async function glbMaterialFallback(id, meta) {
    if (!meta || !meta.source || meta.source.kind !== 'user') return null
    try {
      const ens = await call('ensure', { id, lod: 'lod0' })
      if (!ens || ens === LOCKED || ens.state !== 'ready' || !ens.url) return null
      const resp = await fetch(ens.url)
      if (!resp.ok) return null
      const bytes = new Uint8Array(await resp.arrayBuffer())
      let stats = null
      const p = patchGlbJson(bytes, (json) => { stats = gltfMaterialFallback(json); return stats.changed ? undefined : false })
      if (!p.ok || !p.changed) return null
      const keep = {}
      for (const k of ['title', 'titleZh', 'kind', 'group', 'fidelity', 'units', 'frame', 'tags', 'aliases']) if (meta[k] !== undefined) keep[k] = plain(meta[k])
      const s = await call('saveImported', { glb: p.glb, meta: keep })
      if (!s || s === LOCKED || !s.ok) return null
      if (s.id !== id) await call('remove', id)
      return { id: s.id, stats, existed: !!s.existed }
    } catch (e) {
      console.warn('[modelwb] glb 材质兜底失败（留原件）：' + errText(e))
      return null
    }
  }
  // CAD 进度（models:changed {type:'import', token, phase}）
  const cadJobs = new Map()
  function onImportEvent(ev) {
    if (!ev.token) return
    const j = cadJobs.get(ev.token)
    if (!j) return
    if (ev.phase && ev.phase !== 'done') j.phase = ev.phase
    if (ev.phase === 'error' && ev.message) j.error = ev.message
  }
  function cancelImport(j) {
    if (!j || !canCancelJob(j)) return false
    const i = jobsQueue.indexOf(j)
    if (i >= 0) { jobsQueue.splice(i, 1); j.phase = 'canceled'; j.live = false; persistRecent(); return true }
    j.aborted = true
    if (j.route === 'cad' && j.token && api) try { api.cancel(j.token) } catch { /* 无 */ }
    return true
  }

  /**
   * 导入后自动：单位推断 → 部件分割（Worker）→ 表面 / 体积 / 闭合性（Worker，无质量不出 massProps）→ 缩略图 →
   * saveMeta（只提交算出的字段，与此刻那份三方合并）。任何一步失败只记进作业的 error，不挡后面的步骤。
   */
  async function postImport(id, j, o = {}) {
    const meta0 = await call('getMeta', id)
    if (!meta0 || meta0 === LOCKED || meta0.ok === false) return
    // 同一文件再导入（existed）且库里那份已有部件表：什么都不做（自动分割会整表覆盖已标定的部件表、缩略图与单位也早就有了）。
    // 没有部件表的（上次导入半路被打断）照常补做
    if (o.existed && Array.isArray(meta0.parts) && meta0.parts.length) return
    let meta = plain(meta0)
    const ens = await call('ensure', { id, lod: 'lod0' })
    if (!ens || ens.state !== 'ready') return
    const loaded = await loadModel(ens.url)
    const rt = loaded.root
    const notes = []
    // 关节摆到「加载时的位姿」（initialValue）再量：STK 件的喷焰是初值 0 的缩放关节，按文件位姿量包围盒、分割、表面积全被火焰撑大。
    // collapse：初值为 0 的件真缩成一点（分析 Worker 不看 visible，零面积三角形自动跳过，三角形编号不变）；出缩略图前复原（它自己摆）
    const pose = applyRestPose(rt, meta, { collapse: true })
    try {
      // ① 单位：主进程已按 STEP 头 / extras.satsim / 包围盒定过；这里只在仍是「未知 × 1」时按包围盒量级再猜一次
      if (meta.units && meta.units.unitGuess === 'unknown' && meta.units.scaleToMeters === 1 && !meta.units.sizeVerified) {
        rt.updateMatrixWorld(true)
        const eb = exactBox(rt)
        const ug = guessUnits({ bboxSpanModelUnits: Math.max(eb.max[0] - eb.min[0], eb.max[1] - eb.min[1], eb.max[2] - eb.min[2]), sourceFormat: 'glb', headerHints: {} })
        if (ug.scaleToMeters !== 1) { meta.units = { ...meta.units, scaleToMeters: ug.scaleToMeters, unitGuess: ug.unitGuess }; notes.push(ug.unitGuess) }
      }
      // ② 部件分割
      if (j) j.phase = 'segment'
      try {
        const seg = await analyzer.segment(rt, meta)
        meta = mergeSegment(meta, seg)
      } catch (e) { notes.push(byLang('部件分割失败', 'segment failed')) }
      // ③ 表面 / 体积 / 闭合性（无质量：只写 geometry，不造 massProps）
      if (j) j.phase = 'mass'
      try {
        const mp = await analyzer.massProps(rt, meta)
        if (mp) {
          const g = meta.geometry || (meta.geometry = {})
          g.closed = !!mp.closed
          g.volumeM3 = mp.volumeM3 == null ? null : mp.volumeM3
          g.areaM2 = mp.areaM2 || g.areaM2 || 0
          if (Array.isArray(mp.comBody)) g.centroidM = mp.comBody
        }
      } catch (e) { notes.push(byLang('质量特性估算失败', 'mass estimate failed')) }
      // 包围盒：bboxM = 模型轴米（轴映射终案 ④：模型系坐标 × scaleToMeters，逐顶点精确、只算可见件、关节初值位姿）；
      // boundingRadiusM = 本体系里离本体原点最远的顶点（随 frame 的平移）
      const s0 = meta.units && meta.units.scaleToMeters > 0 ? meta.units.scaleToMeters : 1
      rt.updateMatrixWorld(true)
      const bm = exactBox(rt, new THREE.Matrix4().makeScale(s0, s0, s0))
      const grp = new THREE.Group(); grp.matrixAutoUpdate = false
      modelToBodyMatrix(meta, grp.matrix); grp.add(rt); grp.updateMatrixWorld(true)
      const bb = exactBox(rt)
      grp.remove(rt)
      rt.updateMatrixWorld(true)
      if (!bm.empty) {
        const g = meta.geometry || (meta.geometry = {})
        g.bboxM = { min: bm.min.map((v) => +v.toFixed(6)), max: bm.max.map((v) => +v.toFixed(6)) }
      }
      if (!bb.empty) (meta.geometry || (meta.geometry = {})).boundingRadiusM = +bb.radius.toFixed(6)
      restoreFilePose(pose)
      rt.updateMatrixWorld(true)
      // ④ 缩略图
      if (j) j.phase = 'thumb'
      try {
        const blob = await renderThumb(rt, meta, { size: 512 })
        if (/webp/.test(blob.type)) {
          const r = await call('saveThumb', { id, webp: await blobToU8(blob) })
          if (r && r.ok) { thumbState.delete(id); delete st.thumbs[id] }
        }
      } catch (e) { notes.push(byLang('缩略图生成失败', 'thumbnail failed')) }
      // ⑤ 落盘：只提交本轮自己算出的字段（部件 / 挂点 / 太阳翼组 / geometry / 自动补的单位），按「此刻那份」三方合并（postImportMerge.js）。
      //   分析期间用户可能已打开这件改了名 / 单位 / 本体轴：按开头的快照整份写回会把这些改动回滚；用户那边整份落盘又会清掉部件表（体检 2026-10-16 二.25）。
      //   该件正开着：先落定它待存的用户改动，此刻那份 = 工作副本，合并结果同时并进工作副本与撤销栈快照（mergeIntoOpen）
      const base = postImportBasis(meta0), ours = postImportBasis(meta)
      notePostImport(id, base, ours)
      if (pend && pend.id === id) await flushSave()
      const live = metaId === id && !!cur.meta
      const theirs = live ? plain(cur.meta) : await call('getMeta', id)
      const p = theirs && theirs !== LOCKED && theirs.ok !== false ? postImportPatch(base, ours, theirs) : null
      if (p) {
        if (live) mergeIntoOpen(p, base, ours)
        const r = await call('saveMeta', { id, meta: p })
        if (r && r.ok === false) notes.push(byLang('元数据：', 'meta: ') + ((r.errors && r.errors[0]) || r.error || ''))
      }
      if (j && notes.length) j.error = [j.error, ...notes].filter(Boolean).join('；')
      if (j && j.tris == null && meta.geometry) j.tris = meta.geometry.tris
    } finally {
      loaded.handle.release()
    }
  }
  // 最近分析完的导入件（id → {base, ours, at}）：选中这件时 getMeta 发在分析落盘之前、模型在那之后才挂上（大件解析要几秒），
  // 工作副本里就没有分析结果——用户接着改、整份落盘会把库里刚写的部件表清掉。adoptRoot 按这里留的两份补并（三方合并幂等，多并一次无害）。
  // 只留最近几件、几分钟（部件表大件可达数 MB）
  const postDone = new Map()
  const POST_KEEP_N = 4, POST_KEEP_MS = 5 * 60 * 1000
  function notePostImport(id, base, ours) {
    postDone.delete(id)
    postDone.set(id, { base, ours, at: Date.now() })
    while (postDone.size > POST_KEEP_N) postDone.delete(postDone.keys().next().value)
  }
  function reapplyPostImport(id) {
    const e = postDone.get(id)
    if (!e || !cur.meta) return
    if (Date.now() - e.at > POST_KEEP_MS) { postDone.delete(id); return }
    const p = postImportPatch(e.base, e.ours, plain(cur.meta))
    if (p) for (const k of Object.keys(p)) cur.meta[k] = p[k]
  }
  /**
   * 分析结果并进正开着的这件（工作副本 + 撤销 / 重做栈）：不入撤销栈（不是用户的一步），也不另排落盘（库里那份由 postImport 自己提交；
   * 用户待存的改动整份落盘时带着它）。撤销栈的快照是这一件此前的各个状态，各按各自的口径并上同一份结果——撤销到分析完成之前的某一步，
   * 部件表不会跟着回到空、再被落盘清掉。
   */
  function mergeIntoOpen(p, base, ours) {
    for (const k of Object.keys(p)) cur.meta[k] = p[k]
    cur.rev++
    if (p.units) cur.geomRev++
    if (vp && root && !st.vpOwner) { vp.setModel(root, viewMeta(), { keepView: true }); if (p.units) syncView() }
    for (const stack of [undoStack, redoStack]) {
      for (let i = 0; i < stack.length; i++) {
        let s = null
        try { s = JSON.parse(stack[i]) } catch { continue }
        const q = postImportPatch(base, ours, s)
        if (q) stack[i] = JSON.stringify({ ...s, ...q })
      }
    }
  }

  // ───────────────── 导出 ─────────────────
  /**
   * 导出当前模型：lod0 根 → exportGlb → 主进程另存对话框落盘。
   * @param {{lod:string, meshopt:boolean, gmdf:boolean, satsim:boolean, originAtCom:boolean}} o
   */
  async function exportCurrent(o) {
    if (!cur.meta || !root) return null
    const t0 = performance.now()
    const meta = plain(cur.meta)
    const out = await exportGlb(root, meta, { lod: o.lod, meshopt: !!o.meshopt, originAtCom: !!o.originAtCom, alreadyLod: false })
    const name = String(displayTitle(meta) || 'model').replace(/[\\/:*?"<>|]+/g, '_')
    const r = await call('exportModel', {
      id: cur.id, glb: out.glb, suggestedName: name + (o.lod && o.lod !== 'lod0' ? '_' + o.lod : '') + '.glb',
      gmdf: o.gmdf && out.gmdf ? out.gmdf : undefined,
      satsimJson: o.satsim ? out.satsimJson : undefined
    })
    if (!r || r === LOCKED) return null
    if (!r.ok) {
      if (r.code === 'canceled') return { canceled: true }
      throw new Error(r.code === 'not-redistributable' ? byLang('该模型不可导出。', 'This model cannot be exported.') : (r.error || byLang('导出失败', 'Export failed')))
    }
    st.lastExport = { path: r.path, bytes: out.info.bytes, nodes: out.info.nodes, ms: Math.round(performance.now() - t0), warnings: out.info.warnings.slice(0, 6), errors: out.info.errors.slice(0, 6), lodTris: out.info.lodTris || null }
    return st.lastExport
  }
  function displayTitle(m) { return m ? (lang() === 'en' ? (m.title || m.titleZh) : (m.titleZh || m.title)) : '' }

  // ───────────────── 参数化「保存到库」 ─────────────────
  async function saveParam(r, base) {
    const meta = paramMeta(r, base)
    const rt = irToThree(r.ir)
    try {
      const out = await exportGlb(rt, meta, { originAtCom: false })
      const satsim = { ...out.satsimJson, id: base.id, source: { kind: 'param', url: '', credit: '', license: '', redistributable: true }, spec: plain(r.spec) }
      const res = await call('saveImported', { glb: out.glb, meta: satsim })
      if (!res || res === LOCKED) return null
      if (!res.ok) throw new Error(res.error || byLang('保存失败', 'Save failed'))
      try {
        const blob = await renderThumb(rt, meta, { size: 512 })
        if (/webp/.test(blob.type)) await call('saveThumb', { id: res.id, webp: await blobToU8(blob) })
      } catch { /* 缩略图失败不挡保存 */ }
      await refresh()
      return res.id
    } finally { disposeObject(rt) }
  }

  // ───────────────── 库条目的副本口径（§3.2；模型签「另存副本 / 编辑副本」、库页右键共用）─────────────────
  /**
   * 'template' 卫星整星模板 / 实体模板 → 打开模板签（编辑时自动创建副本）；'drive' 已存参数化整星 → 驱动装配件副本；
   * 'asm' 装配件 → 直接复制；'mesh' 导入件 / NASA / 内置 / 星座精模 → 元数据副本；'stk' STK 本机件（不可分发）；'' 没有这一项。
   */
  function copyKindOf(libId) {
    const e = byId(libId)
    if (!e) return ''
    if (e.origin === 'entTemplate' || (e.origin === 'template' && !e.fleet)) return 'template'
    if (typeof e.id === 'string' && e.id.startsWith('asm:')) return 'asm'
    if (entryFacts(e).stk || (e.source && e.source.redistributable === false)) return 'stk'
    if (e.source && e.source.kind === 'param' && !e.fleet) return 'drive'
    return 'mesh'
  }
  /**
   * 元数据副本：当前根（lod0 全精度）+ 当前元数据（含刚改、还没落盘的）导出 glb → saveImported 非 asm 分支 → 新的 user: 条目，打开为新模型签。
   * 名称中英两份「<名称> 副本」/「<name> Copy」（与库内及已打开签重名时递增）。署名 / 许可文本由主进程按原条目（copyOf）保留，来源身份是 user；
   * STK 本机件主进程拒收（界面上按钮已禁用）。几何口径同「导出」：轴向烘进几何、原点不动；包围盒由主进程按新 glb 重量（旧件的 bboxM 是旧模型轴的）。
   * 标定编辑（单位 / 本体轴 / 质量 / 部件 / 挂点…）仍作用于原条目本身（3D 页依赖），副本是另一件。
   */
  async function saveModelCopy(libId) {
    const e = byId(libId)
    if (!e || copyKindOf(libId) !== 'mesh' || !api || st.locked) return { ok: false, code: 'unavailable' }
    if (cur.id !== libId || cur.error) await select(libId, { lod: 'lod0', keepView: true })
    if (cur.id === libId && cur.kind === 'glb' && cur.lod !== 'lod0' && !cur.loading) await select(libId, { lod: 'lod0', keepView: true, force: true })
    if (cur.id !== libId || !cur.meta || !root || cur.loading || (cur.kind === 'glb' && cur.lod !== 'lod0')) {
      ui.hint(noFull.has(libId) ? byLang('完整精度模型不可用。', 'Full-detail model unavailable.') : byLang('模型尚未加载完成。', 'Model not loaded yet.'))
      return { ok: false, code: 'not-loaded' }
    }
    if (pend) await flushSave()
    const taken = takenNames()
    const titleZh = copyNameOf(displayName(e, 'zh'), taken, 'zh'), title = copyNameOf(displayName(e, 'en'), taken, 'en')
    const r0 = root
    const meta = plain(cur.meta)
    meta.titleZh = titleZh; meta.title = title
    st.busy = byLang('另存副本…', 'Saving copy…')
    try {
      const out = await exportGlb(r0, meta, { originAtCom: false })
      const sj = { ...out.satsimJson }
      delete sj.id; delete sj.spec; delete sj.geometry; delete sj.local; delete sj.files
      const s0 = meta.source || {}
      const res = await call('saveImported', {
        glb: out.glb,
        meta: { ...sj, title, titleZh, copyOf: libId, source: { kind: 'user', url: s0.url || '', credit: s0.credit || '', license: s0.license || '', redistributable: true } }
      })
      if (!res || res === LOCKED) return { ok: false, code: 'locked' }
      if (!res.ok) {
        const msg = res.code === 'not-redistributable' || res.code === 'stk' ? byLang('不可分发。', 'Not redistributable.') : (res.error || byLang('保存失败', 'Save failed'))
        ui.hint(msg)
        return { ok: false, code: res.code || 'save', error: msg }
      }
      try {
        const blob = await renderThumb(r0, meta, { size: 512 })
        if (/webp/.test(blob.type)) await call('saveThumb', { id: res.id, webp: await blobToU8(blob) })
      } catch { /* 缩略图失败不挡副本 */ }
      thumbState.delete(res.id); delete st.thumbs[res.id]
      await refresh()
      openModelTab(res.id)
      ui.toast(byLang('已另存副本。', 'Copy saved.'))
      return { ok: true, id: res.id }
    } catch (err) {
      const msg = err && err.code === 'not-redistributable' ? byLang('不可分发。', 'Not redistributable.') : errText(err)
      ui.hint(msg)
      return { ok: false, code: (err && err.code) || 'error', error: msg }
    } finally { st.busy = '' }
  }


  // ───────────────── 装配页（P3，契约 §7）─────────────────
  // 视口借还：装配页借走视口挂 live 树（编辑器），借出期间上面那些喂视口的调用只改 root / cur、不喂；还回来按当前 root 重喂一次。
  function lendViewport(owner) { st.vpOwner = owner || ''; return vp }
  function reclaimViewport(o = {}) {
    st.vpOwner = ''
    flushAsmThumbs()
    if (!vp) return
    // 借出期间当前模型（库 / 模型 / 导出页选着的这件）重新入过库：几何与元数据都换成库里那份（不在编辑途中解析 glb）
    if (staleAsm && staleAsm === cur.id && !cur.loading) { const id = staleAsm; staleAsm = ''; select(id, { lod: cur.lod || 'lod2', keepView: true, force: true, fresh: true, warm: true }); return }
    staleAsm = ''
    if (root && cur.meta) { vp.setModel(root, viewMeta(), { keepView: !!o.keepView }); syncView() } else vp.setModel(null, null)
  }

  // ───────────────── 设计页文档（2026-10-06 文档标签条，任务书 §3.1）─────────────────
  // 每个打开的文档一份 DocState（响应式；st.docs 的顺序 = 签序，st.activeDoc = 激活签的 id）：
  //   {id, kind:'asm'|'model', name, domain, origin:'new'|'lib'|'template'|'copy'|'draft', templateId, templateKey, libId,
  //    inLib, dirty, rev, savedRev, libJson, openJson, saveErr, invalid, empty, driven, prov, saving, savedAt, seq,
  //    pane:'quick'|'lib', treeShut:string[], stash:{json, state, sym, posePreview}|null, _rt:{…运行时，不进响应式}}
  //   · kind 'asm'：装配文档（含驱动装配件），id = asm:<12 位十六进制>（终身不变，入库也用它）。文档本身在编辑器里；DocState 记身份、
  //     存盘状态与最近一次提交（_rt.doc 冻结纯数据 + _rt.json 现成的 JSON 串）。libJson = 库里这件的文档 JSON（提交 / 存盘内容与它相同
  //     就不标脏、不入库）；openJson = 打开时的快照（库件 = 库里那份；第二段「另存副本并还原原件」用）。
  //     templateKey = 模板条目 id + '|tpl'（模板签，§3.2）：打开时文档名就定成副本名（byLang「<模板名> 副本」，重名递增）——模板签原样不入库；
  //     第一次提交后内容 ≠ 模板基线（_rt.baseJson）时就地分叉（forkTemplate：清 templateKey、origin 'copy'、换新 id、来源标记迁过去，
  //     编辑器不重载），随后照常自动入库；被手动「保存」进库同样成副本。从此再打开该模板 = 新的模板签。
  //   · kind 'model'：库里一件模型的模型视图（导入件 / NASA / STK / 已存参数化件 / 星座精模 / 只读查看的模板与装配件），id = 'm|' + libId；
  //     视口与表单走 cur（激活 = select(libId)）。★ 模型签的撤销栈不跨签保留：元数据撤销栈全局一份，换模型即清。
  //   · stash（暂存）：装配签被换下时编辑器里的状态（撤销栈 + 指针、选择、相机）+ 对称档 / 初值姿态；换回来按它还原（asmSession 写 / 取）。
  //   · pane：左栏档（快速设置 / 组件），按签记；空装配文档缺省组件库。
  //   · treeShut：结构树里收起的件（组件 id），按签记、随签列表落盘（与 pane 同一口径）：各签的组件 id 常同名（bus / refl1 / wing1），
  //     共用一份折叠集时在一个签里收起「星体」，换到另一个签它也是收起的（体检 2026-10-16 二.23）。
  // wb.asm 是激活装配签的视图（Proxy：读写都落到激活的那份 DocState；没有激活的装配签时读到缺省空值）—— 现有读者 wb.asm.xxx 不改读法。
  // 存盘作业记下排上时的 DocState（job.d），跑完按它回写，不再看「是不是当前文档」；放弃点、草稿、自动保存定时器都按文档各记各的。
  // 草稿按文档分槽 model/asm/draft/<id>（上限 12，打开着的签不参与淘汰）；签列表与激活签存本机 model/design/tabs，下次开窗恢复。
  const DOC_TABS_KEY = 'model/design/tabs'
  const DRAFT_PREFIX = 'model/asm/draft/'
  const DRAFT_INDEX_KEY = 'model/asm/drafts'
  const DRAFT_MAX = 12
  const RESTORE_MAX = 40
  const NO_ASM = Object.freeze({
    id: '', kind: 'asm', name: '', domain: 'spacecraft', origin: 'new', templateId: '', templateKey: '', libId: '',
    inLib: false, dirty: false, rev: 0, savedRev: -1, libJson: '', openJson: '', saveErr: '', invalid: 0, empty: true, driven: false,
    prov: null, saving: false, savedAt: 0, seq: 0, pane: 'quick', treeShut: Object.freeze([]), stash: null
  })
  // docsById 是 st.docs 的按 id 索引（同一批响应式代理）。读它的地方都先读过 st.activeDoc（响应式），换签 / 增删签都先改它再改 activeDoc
  const docsById = new Map()
  let docSeqN = 0
  const activeDocState = () => docsById.get(st.activeDoc) || null
  const activeAsmDoc = () => { const d = docsById.get(st.activeDoc); return d && d.kind === 'asm' ? d : null }
  const activeKind = () => { const d = docsById.get(st.activeDoc); return d ? d.kind : '' }
  const isDocOpen = (d) => !!d && !!d.id && docsById.get(d.id) === d
  /** 激活装配签的视图（读写透传；没有激活的装配签读到 NO_ASM 的缺省值、写丢弃） */
  const asm = new Proxy({}, {
    get(_t, k) { if (k === '__v_skip') return true; const d = activeAsmDoc(); return d ? d[k] : NO_ASM[k] },
    set(_t, k, v) { const d = activeAsmDoc(); if (d) d[k] = v; return true },
    has(_t, k) { return k in NO_ASM },
    ownKeys() { return Reflect.ownKeys(NO_ASM) },
    getOwnPropertyDescriptor(_t, k) { return k in NO_ASM ? { configurable: true, enumerable: true, writable: true, value: (activeAsmDoc() || NO_ASM)[k] } : undefined }
  })
  function mkDoc(o) {
    return reactive({
      id: o.id, kind: o.kind === 'model' ? 'model' : 'asm', name: o.name || '', domain: o.domain || 'spacecraft',
      origin: o.origin || 'new', templateId: o.templateId || '', templateKey: o.templateKey || '', libId: o.libId || '',
      inLib: !!o.inLib, dirty: !!o.dirty, rev: 0, savedRev: -1, libJson: o.libJson || '', openJson: o.openJson || '',
      saveErr: '', invalid: 0, empty: true, driven: false, prov: o.prov || null, saving: false, savedAt: 0, seq: ++docSeqN,
      pane: o.pane === 'lib' ? 'lib' : 'quick', treeShut: treeShutOf(o.treeShut), stash: null,
      // 运行时（markRaw，不进响应式）：最近一次提交 / 自动保存与草稿的定时器 / 草稿写到哪一次提交 / 草稿写失败的那句 / 放弃点 /
      // 在途存盘作业数 / 已关签 / 库里已删 / 模板基线 JSON（模板签与它分叉出、尚未入库的副本：内容回到基线 = 不分叉、不入库）/
      // 内容代次（「还原原件」整份换掉内容时 +1：编辑器里载着的旧版本作废，asmSession 按代次判断要不要重载、暂存）/
      // 出自哪个模板签（模板条目 id + '|tpl'；分叉后照留：分叉又撤回模板原样、未入库无草稿的副本，开窗按它重建）/
      // 下次编辑器载入时把基线换成编辑器归一过的 JSON（按模板重建的副本用）
      // 出自哪张组件卡片（库页组件档「新建装配件」；没动过、未入库的签开窗时按它重建）
      _rt: markRaw({ doc: null, json: '', saveT: 0, draftIdle: 0, draftRev: -1, draftErr: '', discardRev: -Infinity, jobs: 0, closed: false, removed: false, baseJson: '', epoch: 0, fromTpl: '', rebase: false, fromComp: '' })
    })
  }
  const defaultPane = (doc) => (isDriven(doc) ? 'quick' : doc && Array.isArray(doc.comps) && doc.comps.length ? 'quick' : 'lib')
  // 结构树折叠集的存档形状：非空字符串、去重、封顶（签列表在本机存储里，坏数据 / 老版本没有这一项都回空表）
  const TREE_SHUT_MAX = 512
  const treeShutOf = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x))].slice(0, TREE_SHUT_MAX) : [])
  function syncAsmFacts(d, doc) { d.name = doc.name; d.domain = doc.domain; d.empty = !doc.comps.length; d.driven = isDriven(doc) }
  /** 新开的装配文档：记下初始文档（编辑器载入前按它载；载入后 change(load) 换成编辑器那份冻结快照） */
  function initAsm(d, doc) {
    d._rt.doc = doc
    d._rt.json = JSON.stringify(doc)
    if (!d.openJson) d.openJson = d.libJson || d._rt.json
    syncAsmFacts(d, doc)
    return d
  }

  // 视口借给装配页期间重新入库、又正被库 / 模型 / 导出页选着的装配件：还视口时再按库里那份整件重读
  let staleAsm = ''
  let asmDragging = false, asmSaveRun = null
  const asmRemoved = new Set()   // 本窗口里删掉的装配件 id：途中的存盘作业不许把它存回来
  const asmThumbs = new Map()    // 待出缩略图的装配件 id → 文档（null = 出图时按库里那份）：离开装配页（或入库时已不在装配页）才出，编辑途中不占主线程
  // 待出缩略图的 id 同时记在本机（在装配页里直接关窗：下次开窗补出，库卡片不一直挂着旧图）
  const THUMB_PENDING_KEY = 'model/asm/thumbPending'
  let thumbPendingResumed = false
  function markThumbPending(id, on) {
    const l0 = lsJson(THUMB_PENDING_KEY)
    const l = (Array.isArray(l0) ? l0 : []).filter((x) => typeof x === 'string' && x !== id)
    if (on) l.push(id)
    lsPut(THUMB_PENDING_KEY, l.slice(-50))
  }
  /** 开窗后第一次读完清单：上次没来得及出的装配件缩略图排上（不在装配页时出） */
  function resumeAsmThumbs() {
    if (thumbPendingResumed) return
    thumbPendingResumed = true
    const l = lsJson(THUMB_PENDING_KEY)
    for (const id of Array.isArray(l) ? l : []) if (typeof id === 'string' && byId(id) && !asmThumbs.has(id)) asmThumbs.set(id, null)
    flushAsmThumbs()
  }

  // ── 草稿（按文档分槽）──
  const draftKey = (id) => DRAFT_PREFIX + id
  const lsTry = (k, s) => { try { localStorage.setItem(k, s); return true } catch { return false } }
  function draftIndex() {
    const l = lsJson(DRAFT_INDEX_KEY)
    return (Array.isArray(l) ? l : []).filter((x) => x && typeof x.id === 'string' && Number.isFinite(x.at))
  }
  function readDraft(id) { const x = lsJson(draftKey(id)); return draftOk(x) && x.id === id ? x : null }
  function dropDraft(id) {
    if (!id) return
    if (lsRaw(draftKey(id)) != null) lsPut(draftKey(id), null)
    const l = draftIndex(), k = l.filter((x) => x.id !== id)
    if (k.length !== l.length) lsPut(DRAFT_INDEX_KEY, k)
  }
  /**
   * 写这份文档的草稿（文档部分直接拼现成的 JSON 串，不再把整份文档序列化一遍）。上限 DRAFT_MAX 份：超了按时间淘汰最旧的，打开着的签不参与淘汰。
   * 写不进去（配额满 / 被禁）→ 该签 saveErr「草稿未写入。」；之后写成了只清自己那一句（入库失败的原因不被它盖掉）。
   */
  function writeDraft(d) {
    cancelDraftWrite(d)
    const r = d._rt
    if (!d.id || !r.doc || r.closed) return false
    const at = Date.now()
    const head = JSON.stringify({ id: d.id, domain: r.doc.domain, name: r.doc.name, origin: d.origin, templateId: d.templateId, templateKey: d.templateKey, at, prov: d.prov ? plain(d.prov) : null })
    if (!lsTry(draftKey(d.id), head.slice(0, -1) + ',"doc":' + (r.json || JSON.stringify(r.doc)) + '}')) {
      r.draftErr = byLang('草稿未写入。', 'Draft not written.')
      d.saveErr = r.draftErr
      return false
    }
    r.draftRev = d.rev
    if (r.draftErr) { if (d.saveErr === r.draftErr) d.saveErr = ''; r.draftErr = '' }
    const l = draftIndex().filter((x) => x.id !== d.id)
    l.push({ id: d.id, at })
    const ev = evictDrafts(l, st.docs.map((x) => x.id), DRAFT_MAX)
    for (const id of ev.drop) lsPut(draftKey(id), null)
    lsPut(DRAFT_INDEX_KEY, ev.keep)
    return true
  }
  function cancelDraftWrite(d) {
    const r = d._rt
    if (!r.draftIdle) return
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(r.draftIdle); else clearTimeout(r.draftIdle)
    r.draftIdle = 0
  }
  /** 提交路径上只排一次空闲写草稿（连续提交只写最后一份；最迟 300 ms 内写上）。 */
  function scheduleDraft(d) {
    const r = d._rt
    if (r.draftIdle) return
    const run = () => { r.draftIdle = 0; if (d.dirty && r.doc && d.id) writeDraft(d) }
    r.draftIdle = typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 300 }) : setTimeout(run, 50)
  }
  /** 立即写上排着的草稿（换签 / 关窗前）。 */
  function flushDraft(d) { if (d && d.kind === 'asm' && d._rt.draftIdle) { cancelDraftWrite(d); if (d.dirty && d._rt.doc && d.id) writeDraft(d) } }
  /** 旧版单槽草稿（model/asm/draft）迁进分槽；返回迁进来的那份（没有 null）。 */
  function migrateOldDraft() {
    const old = lsJson(DRAFT_KEY)
    if (draftOk(old) && !readDraft(old.id) && lsTry(draftKey(old.id), JSON.stringify(old))) {
      const l = draftIndex().filter((x) => x.id !== old.id)
      l.push({ id: old.id, at: old.at })
      lsPut(DRAFT_INDEX_KEY, l)
    }
    if (lsRaw(DRAFT_KEY) != null) lsPut(DRAFT_KEY, null)
    return draftOk(old) ? old : null
  }

  // ── 新开装配文档（只造 DocState，不进签；requestAssembly / openTemplateTab 负责进签与激活）──
  /** 空白文档（不入库；加了第一件、停手后才自动入库）。左栏缺省组件库 */
  function newAssembly(domain) {
    const dm = ASM_DOMAINS.includes(domain) ? domain : 'spacecraft'
    const doc = normalizeAssembly({ kind: 'assembly', domain: dm, name: defaultAsmName(dm), comps: [] })
    return initAsm(mkDoc({ id: newAsmId(), kind: 'asm', origin: 'new', pane: 'lib' }), doc)
  }
  /**
   * 库里的装配件：本机草稿比库里那份新（关窗前没来得及入库）就用草稿、标脏，载入编辑器后自动入库；与库里相同的草稿顺手清掉。
   * @returns {Promise<object|null>} DocState
   */
  async function loadLibAsm(id, o = {}) {
    const m = await call('getMeta', id)
    if (!m || m === LOCKED || m.ok === false || !m.spec || m.spec.kind !== 'assembly') {
      if (m !== LOCKED && !o.quiet) ui.hint(byLang('无法打开该装配件。', 'Cannot open this assembly.'))
      return null
    }
    const draft = readDraft(id)
    const useDraft = pickDraft(draft, m)
    const doc = normalizeAssembly(useDraft ? draft.doc : m.spec)
    let libJson = ''
    try { libJson = JSON.stringify(normalizeAssembly(m.spec)) } catch { libJson = '' }
    const d = mkDoc({ id, kind: 'asm', origin: 'lib', inLib: true, dirty: useDraft, libJson, prov: sanitizeProv(lsJson(provKey(id))), pane: defaultPane(doc) })
    initAsm(d, doc)
    if (useDraft) d._rt.draftRev = 0
    else if (draft) dropDraft(id)
    return d
  }
  /**
   * 实体模板 → 模板签（复制成 asm:<新 id>；模板里的示意值路径记进来源标记，属性面板红色标示）。
   * 不标脏：原样的模板签不入库（库里不平白多一份），第一次修改后才自动入库；要原样存一份用「保存」。o.name：文档名（模板签给副本名）
   */
  function fromTemplate(entId, o = {}) {
    const t = ENT && typeof ENT.entityTemplateDoc === 'function' ? ENT.entityTemplateDoc(entId) : null
    if (!t) { ui.hint(byLang('实体模板不可用。', 'Template unavailable.')); return null }
    const tpl = typeof ENT.getEntityTemplate === 'function' ? ENT.getEntityTemplate(entId) : null
    const doc = normalizeAssembly({ ...plain(t.doc), name: o.name || (tpl && tpl.titleZh) || t.doc.name || '' })
    const id = newAsmId()
    const prov = { illustrative: Array.isArray(t.illustrative) ? t.illustrative.slice() : [], touched: [], sources: templateSources(t, doc) }
    // 来源标记此时只在内存：模板签每次开窗按模板重建（新 id），开窗即落本机会留下孤立键；分叉（forkTemplate）/ 入库时才落
    return initAsm(mkDoc({ id, kind: 'asm', origin: 'template', templateId: entId, templateKey: entId + '|tpl', prov, pane: defaultPane(doc) }), doc)
  }
  /**
   * 驱动装配件（设计页快速设置层，drive.mjs）：卫星整星模板 id → 模板签；现成整星 spec → 副本。
   * 整星参数留在文档里当驱动参数（快速设置改它、组件随之重生成，详细编辑的改写保留）。与实体模板同一口径：原样不入库，第一次修改后自动入库。
   * @param {{templateId?:string, spec?:object, name?:string}} src
   */
  function newDrivenAssembly(src = {}) {
    let doc
    try { doc = newDrivenDoc(src) } catch (e) { ui.hint(errText(e)); return null }
    const tplId = (doc.drive && doc.drive.templateId) || ''
    const isTpl = !src.spec && !!src.templateId
    return initAsm(mkDoc({ id: newAsmId(), kind: 'asm', origin: isTpl ? 'template' : 'copy', templateId: tplId, templateKey: isTpl ? templateEntryIdOf(src.templateId) + '|tpl' : '', pane: 'quick' }), doc)
  }
  /** 参数化整星 spec → 驱动装配件副本（已存参数化件「新建可编辑副本」） */
  function assemblyFromSpec(spec, base = {}) {
    return newDrivenAssembly({ spec, name: base.titleZh || base.title || '' })
  }
  /** 库条目 → 装配文档：卫星整星模板 / 实体模板 → 模板签；已存参数化件 → 驱动装配件副本；星座精模不是整星 spec，拆不出组件 */
  async function assemblyFromEntry(id) {
    const e = byId(id)
    if (!e) return null
    if (e.origin === 'entTemplate' || (e.origin === 'template' && !e.fleet)) return templateDoc(id)
    let spec = null
    if (e.source && e.source.kind === 'param' && e.origin !== 'template') {
      const m = await call('getMeta', id)
      spec = m && m !== LOCKED && m.ok !== false ? m.spec : null
    }
    if (!spec || spec.kind === 'assembly') { ui.hint(byLang('该模型无法转为装配件。', 'Cannot convert this model.')); return null }
    // 副本名同 §3.2 口径（byLang「<名称> 副本」，重名递增）
    const lg = lang()
    return assemblyFromSpec(spec, { titleZh: copyNameOf(displayName(e, lg), takenNames(), lg) })
  }
  /** 整星模板 id（default-sat …）→ 库里的模板条目 id（param:<id>） */
  function templateEntryIdOf(templateId) {
    const e = st.list.find((x) => x.origin === 'template' && !x.fleet && x.templateId === templateId)
    return e ? e.id : templateModelId(templateId)
  }
  /**
   * 模板条目 id → 新的模板签 DocState（不进签）。文档名打开时就定成副本名（byLang「<模板名> 副本」/「<name> Copy」，与库内及已打开签重名时递增）：
   * 分叉不必再改名，第一次撤销不会只撤掉一次改名；签上显示模板名（DocTabs），分叉后显示文档名。模板基线 = 这份初始文档的 JSON
   * （编辑器载入后换成它归一过的那份，见 asmAdopt）。
   */
  function templateDoc(entryId) {
    const e = byId(entryId)
    const lg = lang()
    const name = e ? copyNameOf(displayName(e, lg), takenNames(), lg) : ''
    let d = null
    if ((e && e.origin === 'entTemplate') || (!e && /^ent:/.test(entryId))) d = fromTemplate(entryId, { name })
    else if (e && e.origin === 'template' && !e.fleet) d = newDrivenAssembly({ templateId: e.templateId, name: name || e.titleZh || e.title || '' })
    else if (!e && /^param:/.test(entryId)) d = newDrivenAssembly({ templateId: entryId.slice(6) })
    if (d) { d.templateKey = entryId + '|tpl'; d.origin = 'template'; d._rt.baseJson = d._rt.json; d._rt.fromTpl = d.templateKey }
    return d
  }
  /** 重名判据用的名字表：库内条目名（中英两份）+ 已打开装配签的文档名（except 除外） */
  function takenNames(except) {
    const s = new Set()
    for (const e of st.list) { if (e.titleZh) s.add(e.titleZh); if (e.title) s.add(e.title) }
    for (const d of st.docs) if (d !== except && d.kind === 'asm' && d.name) s.add(d.name)
    return s
  }
  /** 只读预览一份装配文档（实体模板条目选中时走它）：与入库件同一套元数据口径 */
  function showAssembly(doc, base, o = {}) {
    const r = buildAssembly(doc)
    const meta = assemblyModelMeta(r, base)
    if (base && base.title) meta.title = base.title
    adoptRoot(irToThree(r.ir), null, meta, 'tpl', 'lod0', o)
    paramRes = r
  }

  // ── 组件（库页「组件」档，2026-10-12）──
  /** 卡片键 → {type, params, def, preset, titleZh, title, domain}（组件不存在 null）；domain = 组件的设计领域（单独新建 / 预览按它） */
  function compCard(ckey) {
    const { type, params } = libKeyParams(ckey)
    const def = getComponent(type)
    if (!def) return null
    const i = String(ckey).indexOf('#'), pr = i < 0 ? null : getPreset(type, String(ckey).slice(i + 1))
    return { type, params, def, preset: pr, titleZh: pr ? pr.titleZh : def.titleZh, title: pr ? pr.title : def.title, domain: homeDomain(def) }
  }
  /** 单件装配文档（根件 = 这一件；组件 id 同编辑器加件的口径 asmSnap.compIdFor） */
  function compDoc(c, name) {
    const r = addComp(normalizeAssembly({ kind: 'assembly', domain: c.domain, name, comps: [] }), { type: c.type, params: c.params, parent: null })
    if (!r.ok) throw new Error(r.error || byLang('无法生成该组件。', 'Cannot build this component.'))
    return r.doc
  }
  /** 同 compDoc，但保证能入库：缺省不计质量的小件（测控天线 / 敏感器）单件文档总质量为 0、buildAssembly 拒收 ——
   *  根件给 1 kg（与预览同口径；属性面板里可改） */
  function compDocBuildable(c, name) {
    const doc = compDoc(c, name)
    try { buildAssembly(doc) } catch (e) {
      if (!(e && e.code === 'SPEC_INVALID' && /总质量为 0/.test(e.message || ''))) throw e
      doc.comps = doc.comps.map((x) => (x.parent == null ? { ...x, massKg: 1 } : x))
    }
    return doc
  }
  /**
   * 库页组件档选中一张卡片：视口里只读预览这一件（单件装配文档按组件的设计领域现生成，与入库件同一套元数据口径）。
   * 朝 +Z 长的件（卫星件局部 −Z 贴父面；FRD 领域的吊挂件）与卡片缩略图同样立起来摆：本体系绕 X 转 180°，挂点 / 质心 / 惯量随之转
   * （wbLogic.reframeMeta）。cur.id = 'cmp:<卡片键>'；与库页选模型互斥：这里清 st.selId，select 清 st.selComp。
   */
  function previewComp(ckey) {
    const c = compCard(ckey)
    if (!c) return false
    libPicked = ''
    st.selComp = ckey
    st.selId = ''
    const id = 'cmp:' + ckey
    if (cur.id === id && cur.meta && !cur.error && !cur.loading) return true
    ++loadTok
    cur.id = id; cur.error = ''; cur.loading = false; cur.stage = ''; cur.editable = false
    try {
      const lg = lang()
      const doc = compDoc(c, lg === 'en' ? c.title : c.titleZh)
      // 缺省不计质量的小件（测控天线 / 敏感器）单件文档总质量为 0、buildAssembly 拒收：按 1 kg 生成，预览不给质量读数
      let r, massless = false
      try { r = buildAssembly(doc) } catch (e) {
        if (!(e && e.code === 'SPEC_INVALID')) throw e
        r = buildAssembly({ ...doc, comps: doc.comps.map((x) => ({ ...x, massKg: 1 })) })
        massless = true
      }
      let meta = assemblyModelMeta(r, { id, name: c.titleZh, source: { kind: 'param', url: '', credit: '', license: '', redistributable: true } })
      meta.title = c.title
      if (massless) meta.massProps = null
      let ms = null
      try { ms = c.def.sockets(fillParams(c.def, c.params)).find((s) => s.id === c.def.mountSocket) || null } catch { ms = null }
      const q0 = meta.frame && meta.frame.q_model2body
      if (ms && ms.n[2] < -0.5 && Array.isArray(q0)) {
        const R = quatToMat(q0)
        if (R) meta = reframeMeta(meta, q0, matToQuat(RX180.map((row) => [0, 1, 2].map((j) => row[0] * R[0][j] + row[1] * R[1][j] + row[2] * R[2][j]))))
      }
      adoptRoot(irToThree(r.ir), null, meta, 'tpl', 'lod0', {})
      paramRes = r
      return true
    } catch (err) {
      cur.error = errText(err)
      return false
    }
  }
  /**
   * 以组件为根件新建装配件（库页组件档双击 / Enter / 右键「新建装配件」）：领域 = 组件的设计领域（相控阵 → 卫星文档、主焦反射面 → 地球站文档），
   * 文档名 = 卡片名（当前界面语言；与库内及已打开签重名时编号）。与空白新建同口径：原样不入库，第一次修改后自动入库，「保存」可原样入库；
   * 同一张卡片新建、还没动过的签已开着 → 激活它（连点两下不开出两份）。签记下出自哪张卡片（_rt.fromComp），没动过的开窗时按它重建。
   */
  function newAssemblyFromComp(ckey) {
    const c = compCard(ckey)
    if (!c) return null
    libPicked = ''
    const ex = st.docs.find((d) => d.kind === 'asm' && !d.inLib && !d.dirty && d._rt.fromComp === ckey)
    if (ex) { activateDoc(ex.id); st.tab = 'design'; return ex }
    let doc
    const lg = lang()
    try { doc = compDocBuildable(c, numberedNameOf(lg === 'en' ? c.title : c.titleZh, takenNames(), lg)) } catch (e) { ui.hint(errText(e)); return null }
    const d = initAsm(mkDoc({ id: newAsmId(), kind: 'asm', origin: 'new', pane: 'quick' }), doc)
    d._rt.fromComp = ckey
    addDoc(d); activateDoc(d.id)
    st.tab = 'design'
    return d
  }

  // ── 编辑器提交 → 文档状态（asmSession 转来；d 缺省 = 激活装配签）──
  /** 编辑器载入文档后（change 事件 reason = load）：只记快照；本来就是脏的（草稿恢复 / 暂存的未入库改动）才补草稿、排自动保存 */
  function asmAdopt(doc, json, d0) {
    const d = d0 || activeAsmDoc()
    if (!d) return
    const r = d._rt
    r.doc = doc
    r.json = typeof json === 'string' ? json : ''
    syncAsmFacts(d, doc)
    // 模板签的基线换成编辑器归一过的那份 JSON（与之后每次提交的 JSON 同一口径比较）；按模板重建的副本（restoreOne）同样换一次
    if ((d.templateKey || r.rebase) && r.json) { r.baseJson = r.json; r.rebase = false }
    if (d.dirty && !r.closed) {
      if (r.draftRev !== d.rev) writeDraft(d)
      if (d.savedRev < d.rev) scheduleAsmSave(d)
    }
  }
  /**
   * 每次提交（命令 / 拖动松手 / 撤销重做）：标脏、排草稿（空闲时段写）、排自动保存。提交路径上不算哈希、不序列化文档（编辑器给现成的 JSON 串）。
   * 兜底：内容与库里那份相同（撤销回到已存的样子、编辑器漏判的空操作）且这份文档没有存盘在途 → 不标脏、清草稿、不入库
   * （入库件的 glb 带时间戳，同样内容再存一次 sha 也会变，3D 页会整件重挂模型）。判据 = JSON 串相等（两边都是归一文档的 JSON）。
   */
  function asmCommit(doc, json, d0) {
    const d = d0 || activeAsmDoc()
    if (!d) return
    const r = d._rt
    r.doc = doc
    r.json = typeof json === 'string' ? json : ''
    d.rev++
    syncAsmFacts(d, doc)
    // 与库里那份相同（入库件）/ 与模板基线相同（模板签的空操作、已分叉未入库的副本撤销回基线）：不标脏、不入库、清草稿；
    // 模板签因此不分叉，已分叉的副本保持副本身份（签不变回模板）
    const same = !!r.json && !r.jobs && (d.inLib ? r.json === d.libJson : r.json === r.baseJson)
    if (same) {
      clearTimeout(r.saveT); r.saveT = 0
      cancelDraftWrite(d)
      d.savedRev = d.rev
      d.dirty = false; d.saveErr = ''; r.draftErr = ''
      dropDraft(d.id)
      return
    }
    d.dirty = true
    if (d.templateKey) forkTemplate(d, { rekey: true })
    scheduleDraft(d)
    scheduleAsmSave(d)
  }
  /**
   * 模板签就地分叉成副本（§3.2）：第一次提交后内容 ≠ 模板基线（asmCommit），或原样被「保存」进库（runAsmSave）。
   *   · 清 templateKey（不再占模板的签键：再打开该模板 = 新的模板签）、origin 'copy'；文档名打开时已是副本名，这里不改文档；
   *   · o.rekey（提交路径）：换新 id、来源标记迁到新 id。没入过库、也没有在途存盘作业才换（入库路径上 id 已经用来存了，不能再换）；
   *   · 不经 editor.load：撤销栈 / 选择 / 相机 / 左栏原样（编辑器按 DocState 对象认文档，换 id 不重载）。
   * 状态短语「已创建副本。」由 asmSession 在提交后看到 templateKey 清掉时出。
   */
  function forkTemplate(d, o = {}) {
    if (!d || !d.templateKey) return
    d.templateKey = ''
    if (d.origin === 'template') d.origin = 'copy'
    const r = d._rt
    if (o.rekey && !d.inLib && !r.jobs && isDocOpen(d)) {
      const oldId = d.id, nid = newAsmId()
      lsPut(provKey(oldId), null)
      dropDraft(oldId)
      rekeyDoc(d, nid)
    }
    // 来源标记从分叉起落本机（模板签原样时只在内存，见 fromTemplate）
    if (d.prov) lsPut(provKey(d.id), plain(d.prov))
    persistTabs()
    if (edBridge && typeof edBridge.forked === 'function') { try { edBridge.forked(d) } catch (e) { console.warn('[modelwb] 分叉通知：' + errText(e)) } }
  }
  // 编辑器桥（asmSession 注册，wb 不直接碰编辑器）：stateOf(d) = 这份文档在编辑器里的相机 / 选择 / 对称档 / 初值姿态（另存副本带过去；
  // 不在编辑器里 null）；forked(d) = 模板签分叉了（出状态短语）
  let edBridge = null
  function setEditorBridge(b) { edBridge = b && typeof b === 'object' ? b : null }
  /**
   * 关签时问过「放弃更改？」且确认放弃：不入库、清掉这份文档的草稿、记下放弃点（这之前已排上 / 在途的存盘作业到落库那一步前作废）。
   */
  function discardDoc(d) {
    if (!d || d.kind !== 'asm') return
    const r = d._rt
    clearTimeout(r.saveT); r.saveT = 0
    cancelDraftWrite(d)
    r.discardRev = d.rev
    d.dirty = false; d.saveErr = ''; r.draftErr = ''
    dropDraft(d.id)
  }
  function discardAssembly() { discardDoc(activeAsmDoc()) }
  function asmSetInvalid(n, d0) { const d = d0 || activeAsmDoc(); if (d) d.invalid = n > 0 ? n : 0 }
  /** 拖动中不自动入库（导出 glb + 缩略图会抢主线程）；松手后照常排 */
  function asmSetDragging(on) {
    asmDragging = !!on
    const d = activeAsmDoc()
    if (!asmDragging && d && d.dirty && !d._rt.saveT && d._rt.doc) scheduleAsmSave(d)
  }
  /** 模板示意值 / 有出处的参数路径被用户改过 → 不再描红、不再标出处 */
  function asmTouch(path) {
    const d = activeAsmDoc()
    const p = d && d.prov
    const sourced = !!(p && p.sources && Object.hasOwn(p.sources, path))
    if (!p || (!p.illustrative.includes(path) && !sourced) || p.touched.includes(path)) return
    d.prov = { illustrative: p.illustrative.slice(), touched: [...p.touched, path], sources: { ...(p.sources || {}) } }
    // 模板签（还没分叉）只改内存：随后那次提交分叉时 forkTemplate 按新 id 落本机
    if (!d.templateKey) lsPut(provKey(d.id), plain(d.prov))
  }
  function scheduleAsmSave(d, ms = 1500) {
    const r = d._rt
    clearTimeout(r.saveT); r.saveT = 0
    if (r.closed) return
    r.saveT = setTimeout(() => {
      r.saveT = 0
      if (asmDragging && d === activeAsmDoc()) { scheduleAsmSave(d, ms); return }
      flushDocSave(d)
    }, ms)
  }
  /** 立即把这份文档待存的提交入库（没有待存的就什么都不做）。o.force（功能区「保存」）：从未入库的新文档原样也存一份 */
  function flushDocSave(d, o = {}) {
    if (!d || d.kind !== 'asm') return Promise.resolve(null)
    const r = d._rt
    clearTimeout(r.saveT); r.saveT = 0
    if (!(d.dirty || (o.force && !d.inLib && !d.empty)) || !r.doc || !d.id) return Promise.resolve(null)
    flushDraft(d)
    return saveAssembly(r.doc, { json: r.json, d, force: !!o.force })
  }
  /** 激活装配签的待存提交立即入库（功能区「保存」/ 离开设计页） */
  function flushAssemblySave(o = {}) { return flushDocSave(activeAsmDoc(), o) }
  /** 关窗 / 卸载：全部签的草稿同步写上、待存的入库作业排上（异步，来不及完成的下次开窗按草稿恢复）、签列表落盘 */
  function flushAllDocs() {
    for (const d of st.docs) if (d.kind === 'asm') { flushDraft(d); flushDocSave(d) }
    if (persistT) { clearTimeout(persistT); writeTabs() }
  }
  /**
   * 关窗守卫（主进程 close 时经 modelwb:closeRequested 转来，§3.4）：全部签的草稿同步写上、签列表落盘，待存的元数据与装配入库作业排上，
   * 等它们跑完（至多 ms）再让主进程真关。来不及的入库下次开窗按草稿恢复（草稿已在同步段写上）。
   */
  async function flushForClose(ms = 2500) {
    const metaP = pend ? flushSave() : null
    flushAllDocs()
    writeTabs()
    const all = Promise.all([metaP, asmSaveRun].map((p) => (p ? Promise.resolve(p).catch(() => null) : null)))
    await Promise.race([all, sleep(ms)])
  }
  /**
   * 装配文档入库（串行：一次只跑一个，排队的依次跑）。asNew = 这份文档原位换成新 id 再存（原 id 在库里的那份不动；旧「另存」口径，
   * 界面已改为「另存副本」= 新签新 id，见 saveDocCopy；保留给脚本 / 验证台）。force = 手动「保存」（与模板基线相同也照存）。
   * 管线：校验（空 / 非法不存）→ [Worker：buildAssembly → 元数据 → irToThree → exportGlb（保留领域 q：bakeFrame:false，几何不动）]
   *      → saveImported（asm 分支：顶替同 id 旧文件、含不可分发件整件拒收）→ saveThumb（缩略图随 glb 在 Worker 里一起出）→ 刷新清单。
   *      Worker 没出成缩略图时（离屏 WebGL 起不来）退回主线程，推迟到离开装配页再出。
   * 作业记下 DocState 与提交号（job.d / job.rev），跑完按它回写；非另存作业的 id 在运行时取 d.id（见 runAsmSave）。
   * @param {object} doc
   * @param {{json?:string, asNew?:boolean, force?:boolean, d?:object}} [o] d 缺省 = 激活装配签
   * @returns {Promise<{ok:boolean, id?:string, code?:string, error?:string}|null>}
   */
  function saveAssembly(doc, o = {}) {
    const d = o.d || activeAsmDoc()
    if (!d) return Promise.resolve(null)
    if (o.asNew) { clearTimeout(d._rt.saveT); d._rt.saveT = 0 }
    const json = typeof o.json === 'string' && o.json ? o.json : JSON.stringify(doc)
    const job = { doc: JSON.parse(json), json, asNew: !!o.asNew, force: !!o.force, d, rev: d.rev }
    d._rt.jobs++
    const run = (asmSaveRun || Promise.resolve()).catch(() => null).then(() => runAsmSave(job))
    asmSaveRun = run
    run.finally(() => { d._rt.jobs--; if (asmSaveRun === run) asmSaveRun = null })
    return run
  }
  /**
   * 生成并导出装配件 glb：优先 Worker（主线程只剩 IPC）；Worker 不可用时退回主线程分段做（生成 / 建 three 树 / 导出之间各让一次空闲时段）。
   * @returns {Promise<{ok:true, glb:Uint8Array, satsimJson:object, meta:object, spec:object}|{ok:false, code:string, error:string}>}
   */
  async function exportAsm(doc, base) {
    const w = await exportAssemblyInWorker(doc, base, { thumb: 512 })
    if (w) return w
    let r
    try { r = buildAssembly(doc) } catch (e) { return { ok: false, code: e && e.code === 'SPEC_INVALID' ? 'invalid' : 'build', error: errText(e) } }
    await idleSlot()
    const meta = assemblyModelMeta(r, base)
    const rt = irToThree(r.ir)
    try {
      await idleSlot()
      const out = await exportGlb(rt, meta, { originAtCom: false, bakeFrame: false })
      return { ok: true, glb: out.glb, satsimJson: out.satsimJson, meta, spec: plain(r.spec), thumb: null }
    } catch (e) { return { ok: false, code: (e && e.code) || 'error', error: errText(e) } } finally { disposeObject(rt) }
  }
  async function runAsmSave(job) {
    const d = job.d, r = d._rt
    // 非另存的作业在运行时才定 id：排队期间「另存」把这份文档换成了新 id，之后的改动跟着文档进新 id，不落回已另存离开的原件
    const idNow = () => (job.asNew ? '' : d.id)
    // 作废：关签时确认放弃过（放弃点之前的提交）/ 库里已删
    const dropped = () => job.rev <= r.discardRev || r.removed
    if (!job.asNew && (asmRemoved.has(idNow()) || job.rev <= d.savedRev || dropped())) return { ok: true, id: idNow(), skipped: true }
    // 校验不在主线程整份跑（每件都要算一遍插座 / 面：船体一份 ~25 ms，停手 1.5 s 自动入库正撞上转视角）：空文档直接判；
    // 编辑器报了非法件（参数 / 安装解算）直接判；其余交给 Worker 里的 buildAssembly（它先校验，非法以 SPEC_INVALID 退回）
    if (!Array.isArray(job.doc.comps) || !job.doc.comps.length) { if (!r.draftErr) d.saveErr = ''; return { ok: false, code: 'empty' } }
    if (d.invalid > 0 && d.rev === job.rev) { d.saveErr = byLang('参数无效。', 'Invalid parameters.'); return { ok: false, code: 'invalid' } }
    if (!api) return { ok: false, code: 'no-api' }
    // 与库里那份内容相同（撤销回到已存的样子 / 漏判的空操作）：不导出、不入库（入库件带时间戳，再存一次 sha 也会变）
    // 未入库、内容与模板基线相同（已分叉的副本撤销回了基线）：同样不入库（手动「保存」除外）
    if (!job.asNew && (d.inLib ? job.json === d.libJson : (!job.force && !!r.baseJson && job.json === r.baseJson))) {
      d.savedRev = Math.max(d.savedRev, job.rev)
      if (d.rev === job.rev) { d.dirty = false; d.saveErr = ''; r.draftErr = ''; dropDraft(d.id) }
      return { ok: true, id: idNow(), skipped: true }
    }
    // 等一个空闲时段再开工：刚停手又接着拖的时候不抢帧。等的这段里又有了新提交、且它的自动保存已经排上：这一份就不存了
    await idleSlot()
    if (!job.asNew && d.rev !== job.rev && r.saveT) return { ok: true, id: idNow(), skipped: true }
    const id = job.asNew ? newAsmId() : idNow()
    if (!job.asNew && asmRemoved.has(id)) return { ok: true, id, skipped: true }
    d.saving = true
    try {
      const ex = await exportAsm(job.doc, { id, name: job.doc.name })
      // 导出途中确认放弃了这份文档 / 库里删了它：不落库
      if (!job.asNew && dropped()) return { ok: true, id, skipped: true }
      if (!ex.ok) {
        const msg = ex.code === 'not-redistributable' ? byLang('含不可分发的模型。', 'Contains a non-redistributable model.') : ex.code === 'invalid' ? byLang('参数无效。', 'Invalid parameters.') : ex.error
        d.saveErr = msg
        return { ok: false, code: ex.code, error: msg }
      }
      const meta = ex.meta
      const res = await call('saveImported', {
        glb: ex.glb,
        meta: {
          ...ex.satsimJson, id,
          source: { kind: 'user', url: '', credit: '', license: '', redistributable: true },
          spec: plain(ex.spec), kind: meta.kind, group: meta.group, fidelity: 'parametric',
          title: meta.title, titleZh: meta.titleZh, tags: plain(meta.tags), aliases: plain(meta.aliases)
        }
      })
      if (!res || res === LOCKED) return { ok: false, code: 'locked' }
      if (!res.ok) {
        const msg = res.code === 'not-redistributable' ? byLang('含不可分发的模型。', 'Contains a non-redistributable model.') : (res.error || byLang('保存失败', 'Save failed'))
        d.saveErr = msg
        return { ok: false, code: res.code || 'save', error: msg }
      }
      const newId = res.id || id
      // 缩略图：Worker 已随 glb 一起出好（主线程只剩这一次 IPC）；没出成（离屏 WebGL 起不来）才退回主线程——
      // 记下最新一份文档，离开装配页（或此刻本就不在装配页）再出，编辑途中不占主线程
      let thumbDone = false
      if (ex.thumb && /webp/.test(ex.thumbType || '')) {
        try {
          const tr = await call('saveThumb', { id: newId, webp: ex.thumb })
          if (tr && tr !== LOCKED && tr.ok) {
            const u = URL.createObjectURL(new Blob([ex.thumb], { type: ex.thumbType }))
            objectUrls.push(u); st.thumbs[newId] = u; thumbState.set(newId, 'done')
            thumbDone = true
          }
        } catch (e) { console.warn('[modelwb] 装配件缩略图：' + errText(e)) }
      }
      if (!thumbDone) { asmThumbs.set(newId, job.doc); markThumbPending(newId, true) } else if (asmThumbs.has(newId)) { asmThumbs.delete(newId); markThumbPending(newId, false) }
      if (job.asNew) {
        // 另存：这份文档换成新 id（签留在原位；原 id 在库里的那份不动，它的草稿作废）
        if (d.prov) lsPut(provKey(newId), plain(d.prov))
        const oldId = d.id
        rekeyDoc(d, newId)
        if (oldId !== newId) dropDraft(oldId)
        d.origin = 'lib'
        d.savedRev = job.rev
        d.dirty = d.rev !== job.rev
        if (d.dirty && r.doc) { writeDraft(d); scheduleAsmSave(d) } else cancelDraftWrite(d)
      } else {
        d.savedRev = Math.max(d.savedRev, job.rev)
        if (d.rev === job.rev) { d.dirty = false; cancelDraftWrite(d); dropDraft(d.id) } else {
          // 入库途中又有提交：草稿重盖一次时间（晚于主进程刚盖的 updatedAt），关窗重开照样取草稿
          if (r.doc) writeDraft(d)
          if (!r.saveT) scheduleAsmSave(d)
        }
      }
      if (d.id === newId) d.libJson = job.json
      d.inLib = true; d.saveErr = ''; r.draftErr = ''; d.savedAt = Date.now()
      // 入了库：之后的「内容没变」按库里那份判，模板基线不再用
      if (d.templateKey) forkTemplate(d)
      r.baseJson = ''; r.rebase = false
      persistTabs()
      await refresh()
      // 库 / 模型 / 导出页当前选着这件：几何与元数据（挂点 / 关节 / 太阳翼组 / 质量 / spec）一起换成库里这份。
      // 视口借给装配页期间不在编辑途中解析 glb：记下，还视口时再整件重读
      if (cur.id === newId && !cur.loading) {
        if (st.vpOwner === 'asm') { staleAsm = newId; await refreshCurMeta(newId) }
        else select(newId, { lod: cur.lod || 'lod2', keepView: true, force: true, fresh: true })
      }
      if (st.vpOwner !== 'asm') flushAsmThumbs()
      return { ok: true, id: newId }
    } catch (e) {
      const msg = e && e.code === 'not-redistributable' ? byLang('含不可分发的模型。', 'Contains a non-redistributable model.') : errText(e)
      d.saveErr = msg
      return { ok: false, code: (e && e.code) || 'error', error: msg }
    } finally {
      d.saving = false
    }
  }
  /**
   * 视口借给装配页期间，库 / 模型 / 导出页选着的那件重新入了库：元数据（挂点 / 关节 / 太阳翼组 / 质量 / spec）先换成库里那份
   * （一次 IPC，不解析 glb）；几何等还视口时整件重读（staleAsm）。装配件在模型页只读，没有待存改动会被盖掉。
   */
  async function refreshCurMeta(id) {
    const m = await call('getMeta', id)
    if (!m || m === LOCKED || m.ok === false || !m.id || cur.id !== id || cur.loading) return
    cur.meta = m
    cur.rev++
  }
  /** 待出的装配件缩略图：不在装配页时逐张排进出图队列（队列本身两张之间让空闲时段）。 */
  function flushAsmThumbs() {
    if (!asmThumbs.size || st.vpOwner === 'asm') return
    const jobs = [...asmThumbs]
    asmThumbs.clear()
    for (const [id, doc] of jobs) enqueueRender(() => renderAsmThumb(id, doc))
  }
  async function renderAsmThumb(id, doc0) {
    if (!byId(id) || asmRemoved.has(id)) { markThumbPending(id, false); return }
    let doc = doc0
    if (!doc) {
      const m = await call('getMeta', id)
      doc = m && m !== LOCKED && m.ok !== false && m.spec && m.spec.kind === 'assembly' ? m.spec : null
      if (!doc) { markThumbPending(id, false); return }
    }
    // 退回路径（Worker 没出成图）：生成 / 建树 / 出图之间各让一次空闲时段，不在切页签的同一个任务里连着做
    await idleSlot()
    let r
    try { r = buildAssembly(doc) } catch { markThumbPending(id, false); return }
    const meta = assemblyModelMeta(r, { id, name: doc.name })
    await idleSlot()
    const rt = irToThree(r.ir)
    try {
      await idleSlot()
      const blob = await renderThumb(rt, meta, { size: 512 })
      if (/webp/.test(blob.type)) {
        const tr = await call('saveThumb', { id, webp: await blobToU8(blob) })
        if (tr && tr !== LOCKED && tr.ok) { const u = URL.createObjectURL(blob); objectUrls.push(u); st.thumbs[id] = u; thumbState.set(id, 'done') }
      }
      markThumbPending(id, false)
    } catch (e) { console.warn('[modelwb] 装配件缩略图：' + errText(e)) } finally { disposeObject(rt) }
  }

  // ── 签：增删 / 激活 / 查找 ──
  // 签键（wbLogic.docKeyOf）：库件 = (库 id, 文档类型)；模板签 = 模板条目 id + '|tpl'；未入库装配文档 = (自己的 id, 'asm')
  function findDoc(key) { for (const d of st.docs) if (docKeyOf(d) === key) return d; return null }
  /** 签对应的库条目 id（库页选中跟随用；wbLogic.libIdOfDoc） */
  const libIdOf = (d) => libIdOfDoc(d)
  /** 加一个签（插在激活签右侧；同 id 已开就用已开的那份） */
  function addDoc(d) {
    if (docsById.has(d.id)) return docsById.get(d.id)
    const i = st.docs.findIndex((x) => x.id === st.activeDoc)
    if (i >= 0) st.docs.splice(i + 1, 0, d); else st.docs.push(d)
    docsById.set(d.id, d)
    persistTabs()
    return d
  }
  /** 激活一个签（被换下的装配签排着的草稿立即写上；编辑器的暂存 / 还原由 asmSession 跟着激活签做） */
  function activateDoc(id) {
    const d = docsById.get(id)
    if (!d) return null
    if (st.activeDoc !== id) {
      const prev = activeDocState()
      flushDraft(prev)
      if (prev && prev.kind === 'model') stopAutoFull(prev.libId)
      st.activeDoc = id
      persistTabs()
    }
    return d
  }
  /** Ctrl+Tab / Ctrl+Shift+Tab：按签顺序循环 */
  function cycleDoc(dir) {
    const j = cycleIndex(st.docs.length, st.docs.findIndex((x) => x.id === st.activeDoc), dir)
    return j >= 0 ? activateDoc(st.docs[j].id) : null
  }
  /** 另存成新 id 后：签原位换 id（索引 / 激活签跟着换） */
  function rekeyDoc(d, newId) {
    const oldId = d.id
    if (oldId === newId) return
    const was = st.activeDoc === oldId
    if (docsById.get(oldId) === d) docsById.delete(oldId)
    d.id = newId
    if (!d._rt.closed) docsById.set(newId, d)
    if (was) st.activeDoc = newId
    if (st.exportTarget === 'doc:' + oldId) st.exportTarget = 'doc:' + newId
    persistTabs()
  }
  /** 拿掉一个签（不问、不存）：暂存与草稿一并清掉；关的是激活签 → 激活右邻（没有取左邻） */
  function dropDoc(d) {
    const i = st.docs.indexOf(d)
    if (i < 0) return
    const r = d._rt
    r.closed = true
    clearTimeout(r.saveT); r.saveT = 0
    if (d.kind === 'asm') {
      cancelDraftWrite(d)
      dropDraft(d.id)
      if (!d.inLib) lsPut(provKey(d.id), null)
    } else stopAutoFull(d.libId)
    d.stash = null
    const j = neighborAfterClose(st.docs.length, i)
    st.docs.splice(i, 1)
    docsById.delete(d.id)
    if (st.activeDoc === d.id) st.activeDoc = j >= 0 ? st.docs[j].id : ''
    persistTabs()
  }
  /**
   * 关签前把这份文档落定：模型签把待存的元数据存掉；装配签先写草稿、入库（等它跑完）。
   * 返回 'ok'（没有会丢的改动）/ 'ask'（参数无效 / 入库失败 / 无法入库：调用方问「放弃更改？」）。
   */
  async function settleDoc(d) {
    if (!d) return 'ok'
    if (d.kind === 'model') { if (cur.id === d.libId && hasPending()) await flushSave(); return 'ok' }
    flushDraft(d)
    if (d.dirty && !d.invalid && api) { try { await flushDocSave(d) } catch (e) { console.warn('[modelwb] 关签入库：' + errText(e)) } }
    // 从没入过库的空文档：没有可丢的东西
    return d.dirty && !(d.empty && !d.inLib) ? 'ask' : 'ok'
  }
  /** 关一个签：先落定；落不定 → 应用内确认「放弃更改？」，取消则不关。返回是否关了 */
  async function closeDoc(id) {
    const d = docsById.get(id)
    if (!d) return true
    if ((await settleDoc(d)) === 'ask') {
      if (!(await ui.askConfirm(byLang('放弃更改？', 'Discard changes?')))) return false
      discardDoc(d)
    }
    if (isDocOpen(d)) dropDoc(d)
    return true
  }
  /** 关闭其他：逐个落定，落不定的合并成一次「放弃更改？」；留下的签激活 */
  async function closeOtherDocs(keepId) {
    const asks = []
    for (const d of st.docs.filter((x) => x.id !== keepId)) {
      if ((await settleDoc(d)) === 'ask') asks.push(d)
      else if (isDocOpen(d)) dropDoc(d)
    }
    if (asks.length && (await ui.askConfirm(byLang('放弃更改？', 'Discard changes?')))) for (const d of asks) { discardDoc(d); if (isDocOpen(d)) dropDoc(d) }
    if (docsById.has(keepId)) activateDoc(keepId)
  }
  // ── 另存副本（§3.2）──
  /**
   * 签右键 / 功能区「另存副本」可不可用：装配签 = 有组件、参数有效（模板签不给：它编辑即成副本，原样存一份用「保存」）；
   * 模型签 = 网格 / 星座精模（元数据副本）或装配件（直接复制）；STK 本机件不可分发。
   */
  function canSaveDocCopy(id) {
    const d = docsById.get(id)
    if (!d || !api || st.locked) return false
    if (d.kind === 'asm') return !d.templateKey && !d.empty && !d.invalid && !!d._rt.doc
    const k = copyKindOf(d.libId)
    // 网格件要按全精度复制：拿不到 lod0（离线、只有随包低档）不给——与功能区「另存副本」同一判据
    return k === 'asm' || (k === 'mesh' && !noFull.has(d.libId))
  }
  /** 「另存副本并还原原件」可不可用：我的装配件（入过库）、打开之后改过 */
  function canRevertDocCopy(id) {
    const d = docsById.get(id)
    return canSaveDocCopy(id) && d.kind === 'asm' && d.inLib && !!d.openJson && (d._rt.json || '') !== d.openJson
  }
  /**
   * 另存副本：
   *   · 装配签：当前内容（最近一次提交）→ 新 id、byLang「<名称> 副本」（重名递增）、新签打开并激活、立即入库；原签保留（不动它的内容与撤销栈）。
   *     相机 / 选择 / 对称档带到新签（编辑器桥给），撤销栈从新签开始。o.restore（「另存副本并还原原件」）：原件写回打开时的快照（revertDoc）。
   *   · 模型签：网格 / 星座精模 → 元数据副本（saveModelCopy）；装配件 → 直接复制（copyLibAsm）。
   * @returns {Promise<{ok:boolean, id?:string, code?:string, error?:string}>}
   */
  async function saveDocCopy(id, o = {}) {
    const d = docsById.get(id)
    if (!d || !canSaveDocCopy(id)) return { ok: false, code: 'unavailable' }
    if (d.kind === 'model') {
      if (copyKindOf(d.libId) === 'asm') return copyLibAsm(d.libId)
      // 元数据副本按 cur 出（要先把这一件载成 lod0）：先激活这个签，视口 / 表单 / 签三者始终是同一件（右键的是非激活签时也一样）
      activateDoc(d.id)
      st.tab = 'design'
      return saveModelCopy(d.libId)
    }
    const src = d._rt.doc
    const lg = lang()
    const doc = normalizeAssembly({ ...plain(src), name: copyNameOf(src.name || defaultAsmName(src.domain), takenNames(), lg) })
    const c = initAsm(mkDoc({ id: newAsmId(), kind: 'asm', origin: 'copy', templateId: d.templateId, prov: d.prov ? plain(d.prov) : null, pane: d.pane, treeShut: d.treeShut }), doc)
    if (c.prov) lsPut(provKey(c.id), plain(c.prov))
    let es = null
    try { es = edBridge && typeof edBridge.stateOf === 'function' ? edBridge.stateOf(d) : null } catch { es = null }
    if (es) c.stash = markRaw({ json: c._rt.json, state: { hist: [], hptr: 0, sel: Array.isArray(es.sel) ? es.sel.slice() : [], view: es.view || null }, sym: es.sym || null, posePreview: !!es.posePreview })
    c.dirty = true
    if (o.restore && canRevertDocCopy(id)) revertDoc(d)
    addDoc(c); activateDoc(c.id)
    st.tab = 'design'
    const res = await flushDocSave(c, { force: true })
    if (res && res.ok === false) return res
    ui.toast(o.restore ? byLang('已另存副本，原件已还原。', 'Copy saved; original restored.') : byLang('已另存副本。', 'Copy saved.'))
    return { ok: true, id: c.id }
  }
  /**
   * 原件写回打开时的快照（DM-2：自动入库已把改动存进原件，「另存副本并还原原件」= 副本拿走改动、原件回到打开时）：
   * 排着 / 在途的入库作业（打开之后的改动）在落库前作废（放弃点），内容换成 openJson、暂存清掉、代次 +1（编辑器里载着的旧版本作废，
   * 下次换上它按新内容重载）；库里那份已被改过 → 立即把快照存回去。
   */
  function revertDoc(d) {
    if (!d || d.kind !== 'asm' || !d.openJson) return false
    let doc
    try { doc = normalizeAssembly(JSON.parse(d.openJson)) } catch { return false }
    const r = d._rt
    clearTimeout(r.saveT); r.saveT = 0
    cancelDraftWrite(d)
    r.discardRev = d.rev
    d.rev++
    r.doc = Object.freeze(doc)
    r.json = d.openJson
    r.epoch++
    d.stash = null
    syncAsmFacts(d, doc)
    d.saveErr = ''; r.draftErr = ''
    if (!d.inLib || (d.libJson === r.json && !r.jobs)) { d.dirty = false; d.savedRev = d.rev; dropDraft(d.id) }
    else { d.dirty = true; writeDraft(d); flushDocSave(d) }
    persistTabs()
    return true
  }
  /** 内容代次（asmSession 判编辑器里那份是不是旧版本） */
  const docEpoch = (d) => (d && d._rt ? d._rt.epoch : -1)
  /**
   * 库里的装配件直接复制一份（库页右键「新建副本」/ 模型签「另存副本」）：已打开着 = 按签里的当前内容另存副本；
   * 否则按库里那份（本机草稿更新就用草稿）复制、新签打开并入库。
   */
  async function copyLibAsm(id) {
    const open = docsById.get(id)
    if (open && open.kind === 'asm') return saveDocCopy(id)
    const src = await loadLibAsm(id)
    if (!src) return { ok: false, code: 'missing' }
    const sd = src._rt.doc
    const doc = normalizeAssembly({ ...plain(sd), name: copyNameOf(sd.name || defaultAsmName(sd.domain), takenNames(), lang()) })
    const c = initAsm(mkDoc({ id: newAsmId(), kind: 'asm', origin: 'copy', prov: src.prov ? plain(src.prov) : null, pane: defaultPane(doc) }), doc)
    if (c.prov) lsPut(provKey(c.id), plain(c.prov))
    c.dirty = true
    addDoc(c); activateDoc(c.id)
    st.tab = 'design'
    const res = await flushDocSave(c, { force: true })
    if (res && res.ok === false) return res
    ui.toast(byLang('已另存副本。', 'Copy saved.'))
    return { ok: true, id: c.id }
  }

  // ── 打开为签（库页双击 / Enter / 右键「打开」、功能区「新建」、外部跳转）──
  /** 模型签：库里一件模型的模型视图（已开 = 激活） */
  function openModelTab(libId) {
    const e = byId(libId)
    if (!e) return null
    libPicked = ''
    const d = findDoc(libId + '|model') || addDoc(mkDoc({ id: 'm|' + libId, kind: 'model', libId, name: e.titleZh || e.title || libId, domain: e.kind || 'spacecraft', origin: 'lib', inLib: true }))
    activateDoc(d.id)
    st.tab = 'design'
    return d
  }
  /** 模板签（卫星整星模板 / 实体模板）：同一模板已有模板签 = 激活它 */
  function openTemplateTab(entryId) {
    libPicked = ''
    const ex = findDoc(entryId + '|tpl')
    if (ex) { activateDoc(ex.id); st.tab = 'design'; return ex }
    const d = templateDoc(entryId)
    if (!d) return null
    addDoc(d); activateDoc(d.id)
    st.tab = 'design'
    return d
  }
  /** 库里的装配件（已开 = 激活） */
  async function openLibAsm(id) {
    if (docsById.has(id)) return activateDoc(id)
    const d = await loadLibAsm(id)
    if (!d) return null
    if (docsById.has(id)) return activateDoc(id)   // 等 getMeta 期间同一件已经开了
    addDoc(d); activateDoc(d.id)
    if (d.dirty) ui.toast(byLang('已恢复未保存的更改。', 'Unsaved changes restored.'))
    return d
  }
  /** 旧名：打开库里的装配件为签 */
  const openAssembly = (id) => openLibAsm(id)
  let openChain = Promise.resolve(null)
  /**
   * 打开 / 新建装配文档为签（库页右键 / 功能区「新建」/ 从模板 / 转换 / 外部跳转 / 验证台都走它）：
   *   {kind:'open', id} 库里的装配件（已开 = 激活）；{kind:'new', domain} 空白文档（每次一个新签）；
   *   {kind:'template', entId} 实体模板签；{kind:'drive', templateId} 整星模板签；{kind:'drive', spec, name} 整星 spec 副本；
   *   {kind:'spec', from|spec, base} 已存参数化件 / 整星 spec → 驱动装配件副本（from 是模板条目 = 模板签）。
   * 串行（连点两下不开出两份）；开成了才切到设计页。返回打开 / 激活的 DocState（失败 null）。
   */
  function requestAssembly(req) {
    if (!req || typeof req !== 'object') return Promise.resolve(null)
    libPicked = ''   // 显式的打开 / 新建：库页先前那次选择不再在进设计页时另开一个签
    const q = plain(req)
    const p = openChain.catch(() => null).then(() => openFromReq(q)).then(
      (d) => { if (d) st.tab = 'design'; return d || null },
      (e) => { console.warn('[modelwb] 打开文档：' + errText(e)); return null })
    openChain = p
    return p
  }
  async function openFromReq(q) {
    if (q.kind === 'open') return typeof q.id === 'string' ? openLibAsm(q.id) : null
    if (q.kind === 'template') return openTemplateTab(q.entId)
    if (q.kind === 'drive' && !q.spec) return openTemplateTab(templateEntryIdOf(q.templateId))
    if (q.kind === 'spec' && q.from) {
      const e = byId(q.from)
      if (e && (e.origin === 'entTemplate' || (e.origin === 'template' && !e.fleet))) return openTemplateTab(q.from)
    }
    let d = null
    if (q.kind === 'new') d = newAssembly(q.domain)
    else if (q.kind === 'drive') d = newDrivenAssembly({ spec: q.spec, name: q.name })
    else if (q.kind === 'spec') d = q.from ? await assemblyFromEntry(q.from) : assemblyFromSpec(q.spec, q.base || {})
    if (!d) return null
    addDoc(d); activateDoc(d.id)
    return d
  }
  /**
   * 在设计页打开库里的一项（库页双击 / Enter / 右键「打开」、导入完成后的「打开」、3D 页「在工作台中打开」）= 打开或激活签：
   *   装配件 → 装配签；卫星整星模板 / 实体模板 → 模板签；其余（导入件 / NASA / STK / 已存参数化件 / 星座精模）→ 模型签。
   */
  function openInDesign(id) {
    if (typeof id !== 'string' || !id) return null
    libPicked = ''
    const e = byId(id)
    if (id.startsWith('asm:')) return requestAssembly({ kind: 'open', id })
    if (e && (e.origin === 'entTemplate' || (e.origin === 'template' && !e.fleet))) return openTemplateTab(id)
    return e ? openModelTab(id) : null
  }
  /** 设计页正显示装配视图 / 模型视图（各节的快捷键、预览点选按它守卫） */
  const designAsm = () => st.tab === 'design' && activeKind() === 'asm'
  const designModel = () => st.tab === 'design' && activeKind() === 'model'

  // ── 装配签换下 / 换上的暂存（asmSession 调）──
  /** 记下装配签的暂存：编辑器状态（撤销栈 + 指针、选择、相机）+ 对称档 / 初值姿态；文档 JSON 取这份文档最近一次提交 */
  function stashDoc(d, s = {}) {
    if (!isDocOpen(d) || d.kind !== 'asm') return
    d.stash = markRaw({ json: d._rt.json || JSON.stringify(d._rt.doc), state: s.state || null, sym: s.sym || null, posePreview: !!s.posePreview })
  }
  /** 取走暂存（取一次就清；没有 null） */
  function takeStash(d) { const s = d && d.stash; if (s) d.stash = null; return s || null }
  /** 这份装配文档该载进编辑器的那份（最近一次提交 / 初始文档） */
  const docOf = (d) => (d && d._rt ? d._rt.doc : null)

  // ── 签列表落盘 / 开窗恢复 ──
  let persistT = 0, tabsRestored = false, restoring = null
  function persistTabs() { clearTimeout(persistT); persistT = setTimeout(writeTabs, 200) }
  function writeTabs() {
    clearTimeout(persistT); persistT = 0
    if (!tabsRestored) return   // 恢复完成之前不写：否则开窗时一份空表把上次的签覆盖掉
    const list = st.docs.map((d) => ({ id: d.id, kind: d.kind, libId: d.libId, templateKey: d.templateKey, templateId: d.templateId, fromTpl: d.kind === 'asm' && !d.inLib ? d._rt.fromTpl || '' : '', fromComp: d.kind === 'asm' && !d.inLib ? d._rt.fromComp || '' : '', origin: d.origin, inLib: d.inLib, name: d.name, domain: d.domain, pane: d.pane, treeShut: d.kind === 'asm' && d.treeShut.length ? d.treeShut.slice() : undefined }))
    lsPut(DOC_TABS_KEY, { v: 1, list, active: st.activeDoc })
  }
  const tplKeyOk = (k) => typeof k === 'string' && /\|tpl$/.test(k)
  /**
   * 恢复一个签：库件按 id 重读（草稿比库里新就用草稿）→ 未入库按草稿 → 模板签按模板重建 →
   * 模板签分叉后又撤回到模板原样的副本（未入库、不脏、草稿已清；fromTpl 记着出自哪个模板）：按模板重建内容、沿用原 id 与文档名、仍是副本 →
   * 都没有 null（丢弃）
   */
  async function restoreOne(it) {
    if (!it || typeof it !== 'object' || typeof it.id !== 'string') return null
    if (it.kind === 'model') {
      const lid = typeof it.libId === 'string' ? it.libId : ''
      const e = byId(lid)
      return e ? mkDoc({ id: 'm|' + lid, kind: 'model', libId: lid, name: e.titleZh || e.title || lid, domain: e.kind || 'spacecraft', origin: 'lib', inLib: true }) : null
    }
    if (!/^asm:[0-9a-f]{12}$/.test(it.id)) return null
    let d = byId(it.id) ? await loadLibAsm(it.id, { quiet: true }) : null
    if (!d) {
      const dr = readDraft(it.id)
      if (dr) {
        const doc = normalizeAssembly(dr.doc)
        const origin = ['new', 'template', 'copy', 'draft'].includes(dr.origin) ? dr.origin : 'draft'
        const tk = typeof dr.templateKey === 'string' && /\|tpl$/.test(dr.templateKey) ? dr.templateKey : ''
        d = mkDoc({ id: it.id, kind: 'asm', origin, templateId: typeof dr.templateId === 'string' ? dr.templateId : '', templateKey: tk, dirty: true, prov: sanitizeProv(dr.prov) || sanitizeProv(lsJson(provKey(it.id))), pane: defaultPane(doc) })
        initAsm(d, doc)
        d._rt.draftRev = 0
        d._rt.fromTpl = tk || (tplKeyOk(it.fromTpl) ? it.fromTpl : '')
      }
    }
    if (!d && !byId(it.id) && tplKeyOk(it.templateKey)) {
      // 原样的模板签：按模板重建（新 id）。旧版开窗即写的来源标记顺手清掉（现在模板签分叉前不落本机）
      if (lsRaw(provKey(it.id)) != null) lsPut(provKey(it.id), null)
      d = templateDoc(it.templateKey.slice(0, -4))
    } else if (!d && !byId(it.id) && tplKeyOk(it.fromTpl)) {
      const t = templateDoc(it.fromTpl.slice(0, -4))
      if (t) {
        const doc = normalizeAssembly({ ...plain(t._rt.doc), name: typeof it.name === 'string' && it.name ? it.name : t._rt.doc.name })
        d = mkDoc({ id: it.id, kind: 'asm', origin: 'copy', templateId: t.templateId, prov: sanitizeProv(lsJson(provKey(it.id))) || (t.prov ? plain(t.prov) : null), pane: defaultPane(doc) })
        initAsm(d, doc)
        d._rt.baseJson = d._rt.json; d._rt.rebase = true; d._rt.fromTpl = it.fromTpl
      }
    } else if (!d && !byId(it.id) && typeof it.fromComp === 'string' && it.fromComp) {
      // 库页组件档「新建装配件」开出、还没动过的签：按那张卡片重建（沿用原 id 与文档名）
      const c = compCard(it.fromComp)
      if (c) {
        try {
          const doc = compDocBuildable(c, typeof it.name === 'string' && it.name ? it.name : c.titleZh)
          d = initAsm(mkDoc({ id: it.id, kind: 'asm', origin: 'new', pane: 'quick' }), doc)
          d._rt.fromComp = it.fromComp
        } catch { d = null }
      }
    }
    if (d && (it.pane === 'lib' || it.pane === 'quick')) d.pane = it.pane
    if (d && d.kind === 'asm' && Array.isArray(it.treeShut)) d.treeShut = treeShutOf(it.treeShut)
    return d
  }
  /**
   * 开窗恢复上次的签（ModelApp 读完清单后调一次）。第一次用标签条（本机还没有签列表）：旧版单槽草稿与「上次那件」各开一个签。
   * 恢复期间用户已经打开的签排在后面、激活签按用户的。
   */
  function restoreDocs() {
    if (restoring) return restoring
    restoring = (async () => {
      try {
        const saved = lsJson(DOC_TABS_KEY)
        const old = migrateOldDraft()
        let items = saved && Array.isArray(saved.list) ? saved.list : null
        let active = saved && typeof saved.active === 'string' ? saved.active : ''
        if (!items) {
          items = []
          if (old) items.push({ id: old.id, kind: 'asm' })
          const last = lsJson(LAST_KEY)
          if (last && typeof last.id === 'string' && !(old && old.id === last.id)) items.push({ id: last.id, kind: 'asm' })
          active = items.length ? items[0].id : ''
        }
        // 旧口径的本机记忆（设计页视图种类 / 左栏档 / 上次那件）一并作废：都改按签记
        for (const k of [LAST_KEY, 'model/design/kind', 'model/design/pane']) if (lsRaw(k) != null) lsPut(k, null)
        if (!st.loaded) await refresh()
        await entReady
        const got = []
        let activeD = null, drafts = 0
        for (const it of items.slice(0, RESTORE_MAX)) {
          let d = null
          try { d = await restoreOne(it) } catch (e) { console.warn('[modelwb] 恢复签：' + errText(e)) }
          if (!d) continue
          // 去重按签键（模板签每次按模板重建、id 都是新的，只比 id 认不出）：恢复期间用户 / 外部跳转已经打开的同一签留那一份
          const k = docKeyOf(d)
          if (docsById.has(d.id) || findDoc(k) || got.some((x) => x.id === d.id || docKeyOf(x) === k)) continue
          if (d.dirty) drafts++
          got.push(d)
          if (it.id === active) activeD = d
        }
        if (got.length) {
          const mine = st.docs.slice()
          for (const d of got) docsById.set(d.id, d)
          st.docs.splice(0, st.docs.length, ...got, ...mine)
          if (!activeDocState()) st.activeDoc = (activeD || got[0]).id
        }
        if (drafts) ui.toast(byLang('已恢复未保存的更改。', 'Unsaved changes restored.'))
      } finally {
        tabsRestored = true
        persistTabs()
      }
    })()
    return restoring
  }

  // ── 页签进出与激活签联动 ──
  /**
   * 设计页激活的是模型签：cur 跟上这件（卫星 / 分析页、库页单击都会改写 cur；回到设计页按激活签重新同步）。
   * 先按本机现成的低档（lod2 / lod1）立即出图，lod0 由 ensureFullDetail 随后升（加载完才升，不半路取消）；
   * 这些都记为本签的自动拉取（autoFullId）：切走 / 关闭该签时取消在途下载，再激活时按需重拉。
   */
  function syncModelDoc() {
    const d = activeDocState()
    if (!d || d.kind !== 'model') return
    const e = byId(d.libId)
    if (!e) return
    // 已是这一件（元数据到位）或正在载它：不重载；正在载的若是本签的自动拉取，记回本签（切走后又切回来，在途的不取消）
    if (cur.id === d.libId && !cur.error && (metaId === d.libId || cur.loading)) { if (cur.loading) autoFullId = d.libId; return }
    const loc = e.local || {}
    const lod = loc.lod2 === 'ready' ? 'lod2' : loc.lod1 === 'ready' ? 'lod1' : 'lod0'
    autoFullId = d.libId
    select(d.libId, { lod, auto: true })
  }
  watch(() => [st.tab, st.activeDoc, st.loaded], () => { if (st.tab === 'design') syncModelDoc() })
  // 设计页没有打开的文档：视口清空（借给 'empty'，cur 原样留着给库 / 导出页），离开设计页 / 打开了文档再还回来
  watch(() => [st.tab, st.activeDoc, st.vpOwner], () => {
    const empty = st.tab === 'design' && !activeDocState()
    if (empty && st.vpOwner === '') { lendViewport('empty'); if (vp) vp.setModel(null, null) }
    else if (!empty && st.vpOwner === 'empty') reclaimViewport()
  }, { immediate: true })
  // 库页的选择动作（单击 / 方向键）：离开设计页之后选过的那一项，进设计页时打开为签（事件触发，不比较状态）。
  // 进库页：库选中项跟随激活签对应的库条目（模板签 → 模板条目；已入库装配件 → 它自己；模型签 → 那一件）
  let libPicked = ''
  function notePick(id) { libPicked = typeof id === 'string' ? id : '' }
  function followActiveInLib() {
    // 库页停在组件档：视口接着预览组件档里选中的那张卡片（离开期间设计页 / 卫星页换过 cur），不跟激活签
    if (st.libPane === 'comp') { if (libCompLast) previewComp(libCompLast); return }
    const lid = libIdOf(activeDocState())
    if (lid && byId(lid) && st.selId !== lid) select(lid, { lod: 'lod2' })
  }
  // 组件档最近选中的卡片（selComp 会被别处的 select 清掉；回到组件档时按它重新预览）
  let libCompLast = ''
  watch(() => st.selComp, (k) => { if (k) libCompLast = k })
  watch(() => st.libPane, (v) => { try { localStorage.setItem(LIB_PANE_KEY, v === 'comp' ? 'comp' : 'model') } catch { /* 便利数据 */ } })
  /**
   * 库页左栏换档：组件档 = 接着预览上次选中的卡片；模型档 = 接着预览上次选中的模型（组件档期间 st.selId 被清过）。
   * 两档各记各的选中项，视口显示当前档的那一件。
   */
  let libModelLast = ''
  watch(() => st.selId, (id) => { if (id) libModelLast = id })
  function setLibPane(p) {
    const v = p === 'comp' ? 'comp' : 'model'
    if (st.libPane === v) return
    st.libPane = v
    if (v === 'comp') { if (libCompLast && compCard(libCompLast)) previewComp(libCompLast) } else if (libModelLast && byId(libModelLast)) {
      const e = byId(libModelLast)
      select(libModelLast, { lod: previewLod(e) })
    } else if (String(cur.id).startsWith('cmp:')) {
      // 模型档还没选过：不让组件预览挂在模型档的视口里
      st.selComp = ''
      showBlank('')
    }
  }
  // 外部跳转直接进导出页（goTarget {tab:'export', modelId}）钉的导出对象：进导出页的缺省规则不覆盖它（一次性，下一次切页签即清）
  let exportPin = ''
  function pinExportTarget(key) { const k = typeof key === 'string' ? key : ''; st.exportTarget = k; exportPin = k }
  watch(() => st.tab, (t, prev) => {
    if (prev === 'design' && t !== 'design') libPicked = ''
    if (t === 'design' && prev !== 'design' && libPicked) { const id = libPicked; libPicked = ''; if (byId(id)) openInDesign(id) }
    if (t === 'lib' && prev !== 'lib') followActiveInLib()
    // 进导出页：导出对象缺省按来处——从设计页来取激活签、从库页来取库选中项；从别处来沿用上次的（失效了再按激活签 / 库选中项）
    if (t === 'export' && prev !== 'export') {
      if (exportPin && st.exportTarget === exportPin && exportTargetOf(exportPin)) { /* 外部跳转钉的这一件 */ }
      else if (prev === 'design' && st.activeDoc) st.exportTarget = 'doc:' + st.activeDoc
      else if (prev === 'lib' && byId(st.selId)) st.exportTarget = 'lib:' + st.selId
      else if (!exportTargetOf(st.exportTarget)) st.exportTarget = defaultExportTarget()
    }
    exportPin = ''
  })

  // ── 导出页的导出对象（§3.1「其它页签对象」）──
  /** 签的显示名（标签条 / 导出对象下拉共用）：模型签 = 库条目名；模板签 = 模板名；其余 = 文档名 */
  function docTitle(d, lg = lang()) {
    if (!d) return ''
    if (d.kind === 'model') { const e = byId(d.libId); return (e && displayName(e, lg)) || d.name || d.libId }
    if (d.templateKey) { const e = byId(String(d.templateKey).replace(/\|tpl$/, '')); if (e) return displayName(e, lg) }
    return d.name || defaultAsmName(d.domain)
  }
  const defaultExportTarget = () => (st.activeDoc && docsById.has(st.activeDoc) ? 'doc:' + st.activeDoc : byId(st.selId) ? 'lib:' + st.selId : '')
  /**
   * 导出对象 'doc:<签 id>' | 'lib:<库 id>' → {key, kind, d, libId}：kind 'model' 模型签（libId = 那一件）/ 'template' 模板签（libId = 模板条目，
   * 只出图）/ 'asm' 装配签（入过库 libId = 自己的 id，否则 ''：导出时先入库）/ 'lib' 库选中项。失效（签已关 / 条目没了）null。
   */
  function exportTargetOf(key) {
    const k = typeof key === 'string' ? key : ''
    if (k.startsWith('doc:')) {
      const d = docsById.get(k.slice(4))
      if (!d) return null
      if (d.kind === 'model') return { key: k, kind: 'model', d, libId: d.libId }
      if (d.templateKey) return { key: k, kind: 'template', d, libId: String(d.templateKey).replace(/\|tpl$/, '') }
      return { key: k, kind: 'asm', d, libId: d.inLib ? d.id : '' }
    }
    if (k.startsWith('lib:')) { const id = k.slice(4); return byId(id) ? { key: k, kind: 'lib', d: null, libId: id } : null }
    return null
  }
  /** 导出对象下拉的候选：已打开的签 + 库中选中项（它已开成模型签时不重复列） */
  function exportTargets() {
    const lg = lang()
    const out = st.docs.map((d) => ({ key: 'doc:' + d.id, label: docTitle(d, lg), group: 'doc' }))
    const e = byId(st.selId)
    if (e && !st.docs.some((d) => d.kind === 'model' && d.libId === e.id)) out.push({ key: 'lib:' + e.id, label: displayName(e, lg) || e.id, group: 'lib' })
    return out
  }
  /** 等这份文档排着 / 在途的入库作业跑完（入库串行：等链尾；最多约 2 s 的兜底轮询） */
  async function docIdle(d) {
    for (let i = 0; i < 40 && d && d._rt.jobs > 0; i++) {
      const p = asmSaveRun
      if (p) await p.catch(() => null); else await sleep(50)
    }
  }
  /**
   * 把导出对象载进 cur（lod0；导出 glb / 缩略图 / 三视图 / 视图截图都按 cur 出，授权闸仍在主进程按库里那份判）：
   *   装配签先把待存的提交入库、等在途作业跑完再按 id 读库里那份；o.save（「导出」按钮）：从未入库的先入库。模板签按模板条目（只出图）。
   * 返回 cur 已是的库 id；没有可载的（未入库 / 入库失败 / 等待期间换了导出对象）''。
   */
  async function loadExportTarget(key, o = {}) {
    let t = exportTargetOf(key)
    if (!t) return ''
    if (t.kind === 'asm') {
      const d = t.d
      if (o.save && (d.dirty || !d.inLib) && !d.empty) await flushDocSave(d, { force: true })
      else if (d.dirty && !d.invalid) flushDocSave(d)
      await docIdle(d)
      if (st.exportTarget !== key || !d.inLib) return ''
      t = exportTargetOf(key)
      if (!t) return ''
    }
    const id = t.libId
    if (!id || !byId(id) || st.exportTarget !== key) return ''
    if (cur.id !== id || (cur.kind === 'glb' && cur.lod !== 'lod0') || cur.error) await select(id, { lod: 'lod0', force: cur.id === id && !cur.loading })
    return cur.id === id ? id : ''
  }
  const entityApi = () => ENT

  // ───────────────── 事件订阅 ─────────────────
  const offs = []
  if (api) {
    try {
      offs.push(api.onChanged((ev) => {
        if (!ev || typeof ev !== 'object') return
        if (ev.type === 'download') onDownload(ev)
        else if (ev.type === 'import') onImportEvent(ev)
        else if (ev.type === 'manifest' || ev.type === 'cache') refreshSoon()
        else if (ev.type === 'meta') { if (ev.id) { thumbState.delete(ev.id) } refreshSoon() }
        else if (ev.type === 'bindings') refreshSoon()
      }))
    } catch (e) { console.warn('[modelwb] 订阅 models:changed 失败：' + errText(e)) }
  }
  function onTarget(cb) {
    if (!api || typeof api.onTarget !== 'function') return
    try { offs.push(api.onTarget(cb)) } catch (e) { console.warn('[modelwb] 订阅 modelwb:target 失败：' + errText(e)) }
  }

  // 实体模板晚到（glob 异步加载）：清单已经读过就补刷一次，库里出现 ent 条目
  entReady.then((m) => { if (m && st.loaded) refresh() })

  function dispose() {
    if (pend) flushSave()
    flushAllDocs()
    writeTabs()
    disposeAsmExport()
    for (const off of offs) { try { off && off() } catch { /* 无 */ } }
    offs.length = 0
    ++loadTok
    releaseCurrent()
    analyzer.dispose()
    for (const u of objectUrls) URL.revokeObjectURL(u)
    for (const ws of waiters.values()) for (const w of ws) w({ phase: 'aborted' })
    waiters.clear()
  }

  return {
    api, st, cur, analyzer,
    askConfirm: ui.askConfirm, toast: ui.toast, hint: ui.hint,
    byId, selected, lang, call, LOCKED,
    refresh, refreshRemote, refreshSoon,
    requestThumb,
    setViewport, select, ensureFullDetail, fullDetailMissing, showGenerated, showBlank,
    edit, flushSave, saveSoon, hasPending, syncGeometryFromView, currentRoot, currentParam, viewMeta,
    pushUndo, dropUndo, undo, redo,
    download, cancel, remove, setGeoDefault,
    importFiles, importStk, cancelImport, canCancelJob,
    exportCurrent, saveParam, displayTitle,
    onTarget, dispose,
    TEMPLATES, TEMPLATE_IDS,
    // 装配编辑（P3）：wb.asm = 激活装配签的视图
    asm, lendViewport, reclaimViewport, newAssembly, openAssembly, fromTemplate, newDrivenAssembly, assemblyFromSpec, assemblyFromEntry,
    openInDesign, designAsm, designModel,
    showAssembly, asmAdopt, asmCommit, asmSetInvalid, asmSetDragging, asmTouch, saveAssembly, flushAssemblySave, discardAssembly, requestAssembly,
    componentThumb, entityApi, entReady,
    // 库页组件档（2026-10-12）：预览 / 以组件新建装配件 / 左栏换档
    compCard, previewComp, newAssemblyFromComp, setLibPane,
    // 设计页文档标签条（2026-10-06）：DocState 表在 st.docs / st.activeDoc
    activeDocState, activeAsmDoc, activeKind, isDocOpen, docKeyOf, findDoc, libIdOf,
    activateDoc, cycleDoc, closeDoc, closeOtherDocs, discardDoc, flushDocSave, flushAllDocs, flushForClose,
    openModelTab, openTemplateTab, templateEntryIdOf, notePick, restoreDocs,
    stashDoc, takeStash, docOf, docEpoch, docTitle, setEditorBridge,
    // 副本口径（§3.2）
    canSaveDocCopy, canRevertDocCopy, saveDocCopy, revertDoc, copyLibAsm, copyKindOf, saveModelCopy,
    // 导出页的导出对象
    exportTargets, exportTargetOf, loadExportTarget, pinExportTarget
  }
}
