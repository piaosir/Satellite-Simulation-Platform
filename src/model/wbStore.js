// 模型工作台的状态与编排（一个窗口一份，ModelApp 建好后 provide 给各页签）。
//
// 分工：
//   · 数据来自主进程 window.api.models（契约见 electron/services/models.js 文件头）。每个调用都 catch，并识别 {locked:true}
//     （未激活时 gated 通道一律回它；遮罩由 ActivationLock 盖，这里只让调用静默失败、不报红）。
//   · 画面在 viewport.js；本模块只把「当前模型」的根与元数据交给它（setModel），元数据改一格就用同一根重喂一次（轴向 / 叠加层
//     跟着变），不重新加载几何。
//   · 模型根（three 对象）一律 markRaw、放在响应式之外：Vue 的深代理套在几十万个顶点的几何上既慢又会把 three 的内部对象弄坏。
//   · 元数据的工作副本 cur.meta 是响应式的（表单直接绑）；喂视口 / 送 IPC 前一律现造纯数据（memory ipc-no-reactive-proxy）。
//   · 改动即落盘（窗口无关窗守卫，DESIGN §7）：编辑后 500 ms 防抖 saveMeta；远端 / 内置模型的改写由主进程写成本机覆盖层。
//     ★ 待存的改动绑在「改的是哪个模型」上（metaId，排期时记下），换模型 / 删模型 / 关窗前先把它按原 id 存掉 ——
//       不能到时候再读 cur.id：防抖期间导入完成自动选中、升档重载、外部跳转都会换掉 cur.id / cur.meta，旧改动丢、新模型白写一份。
//     ★ 只有用户改动才落盘：视口按当前 LOD 量出来的包围盒 / 三角形数是读数（cur.view），不写进元数据 —— 否则光是浏览一下
//       远端模型、关窗时就会给它写一份覆盖层，把清单里的 geometry 永久盖住。
//   · geometry.bboxM 一律【模型轴、米】（轴映射终案 ④，已乘 scaleToMeters）：本体系尺寸不落盘，由 frame 现算（wbLogic.bodyBoxOfMeta）。
//     读数（cur.view.bboxM）是本体系的，只在屏上显示。
//   · 渲染端导入（OBJ / STL / FBX）的 frame.q 缺省按来源（bodyFrame.defaultImportQ，user → +Y 天顶），导出时烘成 STK 映射落盘。
//   · 装配页（P3，契约 scratchpad p3/CONTRACT.md §7）：视口可被装配页「借走」（lendViewport → st.vpOwner = 'asm'），借出期间本模块的一切
//     喂视口调用照常改 root / cur、只是不喂；还回来（reclaimViewport）按当前 root 重喂一次。装配文档的入库走 saveImported 的 asm 分支
//     （id = asm:<12 位十六进制>，终身不变）：每次提交写本机草稿 + 1.5 s 停手自动入库（glb + 缩略图），离开页签 / 换文档 / 关窗立即 flush。
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
import { templateCatalog, templateSpec, TEMPLATE_IDS, TEMPLATES } from '@core/models/paramTemplates.mjs'
import { normalizeMeta } from '@core/models/schema.mjs'
import { defaultImportQ } from '@core/models/bodyFrame.mjs'
import { getComponent } from '@core/models/components/index.mjs'
import { ASM_DOMAINS, newAsmId, normalizeAssembly, buildAssembly, buildComponent, specToAssembly, asmHash } from '@core/models/assembly.mjs'
import { assemblyModelMeta, defaultAsmName } from '@core/models/asmMeta.mjs'
import { canon, fnv1a64Hex } from '@core/models/paramBus.mjs'
import { guessUnits } from '@core/models/units.mjs'
import { byLang } from '../shared/i18n/lang.js'
import { mergeSegment, importRoute, extOf, entryFacts, restoreJob, canCancelJob, meshUnitTieBreak, mergeParamMeta, bodyBoxToModelBox } from './wbLogic.js'
import { DRAFT_KEY, LAST_KEY, provKey, draftOk, pickDraft, sanitizeProv, templateSources } from './asmLogic.js'

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
const lsPutRaw = (k, str) => { try { localStorage.setItem(k, str) } catch { /* 同上 */ } }

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
  return templateCatalog().map((t, i) => ({
    ...t, schema: 2, origin: 'template', tplOrder: i, local: {}, files: {},
    units: { scaleToMeters: 1, unitGuess: 'm', sizeVerified: false },
    frame: null, geometry: null
  }))
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
    busy: '',                    // 功能区右缘的运行时状态
    imports: [],                 // 导入作业（最近的在前）
    lastExport: null,            // {path, bytes, ms, nodes, warnings}
    vpOwner: '',                 // '' | 'asm'：视口借给了谁（装配页借走期间本模块不喂视口）
    compThumbs: {}               // 组件 type → 缩略图 dataURL（装配页组件库）
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
      const k = id + '|' + lod
      const ws = waiters.get(k); waiters.delete(k)
      if (ws) for (const w of ws) w(ev)
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
  async function templateThumb(e) {
    const key = `model/tplThumb/${TPL_THUMB_VER}/${e.templateId}`
    try { const u = localStorage.getItem(key); if (u) { st.thumbs[e.id] = u; thumbState.set(e.id, 'done'); return } } catch { /* 无 */ }
    const t = templateSpec(e.templateId)
    // 出图在 Worker 里做（生成 + 离屏渲染 + 编码；主线程第一次建离屏上下文光编着色器就要几百毫秒）；Worker 不可用退回主线程
    const w = await paramThumbInWorker(plain(t.spec), 384)
    let blob = w && w.ok && w.thumb ? new Blob([w.thumb], { type: w.thumbType || 'image/webp' }) : null
    if (!blob) {
      const r = buildParamModel(t.spec)
      await idleSlot()
      const rt = irToThree(r.ir)
      try { await idleSlot(); blob = await renderThumb(rt, { frame: r.frame, units: { scaleToMeters: 1 } }, { size: 384 }) } finally { disposeObject(rt) }
    }
    const url = await blobToDataUrl(blob)
    st.thumbs[e.id] = url
    thumbState.set(e.id, 'done')
    try { localStorage.setItem(key, url) } catch { /* 配额满：下次再画 */ }
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
   * 装配页组件库卡片的缩略图：缺省参数 buildComponent → 128 px。本机缓存键带几何签名（包围盒 / 网格规模 / 节点名），
   * 组件定义改了（A3 还在调几何）自动重画，不用等 TPL_THUMB_VER 升版。
   * 卫星件局部 −Z 贴父面、几何朝 +Z 长（显示系 +Z 朝下）：出图时绕 X 转 180°，一律「立着」拍；地面 / 飞机 / 船 / 车件本来就朝上长。
   */
  const compThumbState = new Map()
  function componentThumb(type) {
    if (!type || compThumbState.has(type)) return
    compThumbState.set(type, 'pending')
    enqueueRender(() => renderCompThumb(type))
  }
  async function renderCompThumb(type) {
    const key0 = `model/asmThumb/${TPL_THUMB_VER}/${type}`
    const c0 = lsJson(key0)
    // 本机缓存那张先挂上（不等 Worker 起来）；Worker 里按几何签名复核，签名变了（组件定义改了）才出新图
    if (c0 && c0.url) st.compThumbs[type] = c0.url
    const w = await compThumbInWorker(type, 128, c0 && c0.url ? c0.sig : '')
    if (w && w.ok) {
      if (w.same && c0 && c0.url) { compThumbState.set(type, 'done'); return }
      if (w.thumb) {
        const url = await blobToDataUrl(new Blob([w.thumb], { type: w.thumbType || 'image/webp' }))
        st.compThumbs[type] = url
        compThumbState.set(type, 'done')
        lsPut(key0, { sig: w.sig, url })
        return
      }
    } else if (w && w.code === 'build') { compThumbState.set(type, 'fail'); return }
    // Worker 不可用 / 离屏 WebGL 起不来：退回主线程（原口径）
    let r = null
    try { r = buildComponent(type, {}) } catch { compThumbState.set(type, 'fail'); return }
    const sig = fnv1a64Hex(canon({ b: r.bbox, m: r.ir.meshes.map((m) => [m.position.length, m.index.length, m.material]), n: r.ir.nodes.map((n) => n.name), k: r.ir.materials.map((x) => x && x.key) }))
    const key = `model/asmThumb/${TPL_THUMB_VER}/${type}`
    const c = lsJson(key)
    if (c && c.sig === sig && c.url) { st.compThumbs[type] = c.url; compThumbState.set(type, 'done'); return }
    const def = getComponent(type)
    const ms = def ? r.sockets.find((s) => s.id === def.mountSocket) : null
    const q = ms && ms.n[2] < -0.5 ? [1, 0, 0, 0] : [0, 0, 0, 1]
    const rt = irToThree(r.ir)
    try {
      const blob = await renderThumb(rt, { frame: { q_model2body: q, t_model2body: [0, 0, 0] }, units: { scaleToMeters: 1 } }, { size: 128 })
      const url = await blobToDataUrl(blob)
      st.compThumbs[type] = url
      compThumbState.set(type, 'done')
      lsPut(key, { sig, url })
    } catch { compThumbState.set(type, 'fail') } finally { disposeObject(rt) }
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

  /** 取某档的 URL：就绪直接给；在下载就先给回退档（能先出图），完成事件到了再换 */
  async function ensureUrl(id, lod, tok) {
    for (let guard = 0; guard < 3; guard++) {
      const r = await call('ensure', { id, lod })
      if (!r || r === LOCKED) throw new Error(byLang('无法读取模型。', 'Cannot read model.'))
      if (r.ok === false) throw new Error(r.error || '')
      if (r.state === 'ready') return { url: r.url, lod: r.lod || lod }
      if (r.state === 'param') return { param: true }
      if (r.state === 'missing') throw new Error(byLang('本机没有该模型文件。', 'Model file not available.'))
      if (r.state === 'error') { if (r.fallback && r.fallback.url) return { url: r.fallback.url, lod: r.fallback.lod }; throw new Error(r.message || byLang('下载失败。', 'Download failed.')) }
      if (r.state === 'downloading') {
        st.dl[id] = { lod: r.lod, phase: 'downloading', received: r.received || 0, total: r.total || 0, message: '' }
        if (r.fallback && r.fallback.url) return { url: r.fallback.url, lod: r.fallback.lod, pending: r.lod }
        cur.stage = 'download'
        const ev = await waitDownload(id, r.lod)
        if (tok !== loadTok) return null
        if (ev.phase === 'error') throw new Error(ev.message || byLang('下载失败。', 'Download failed.'))
        if (ev.phase === 'canceled') throw new Error(byLang('已取消。', 'Canceled.'))
      }
    }
    throw new Error(byLang('无法读取模型。', 'Cannot read model.'))
  }

  /**
   * 选中并预览 / 编辑一个库条目。lod：库页预览 'lod2'；模型 / 导出页要 'lod0'（部件三角形号、拾取、导出都以 lod0 为准）。
   * @param {string} id
   * @param {{lod?:string, keepView?:boolean, force?:boolean, fresh?:boolean}} [o] fresh：连元数据一起重读（不走同一模型换档的保留元数据分支）
   */
  async function select(id, o = {}) {
    const e = byId(id)
    st.selId = id
    if (!e) return
    const want = o.lod || 'lod2'
    if (!o.force && cur.id === id && !cur.error && (cur.kind !== 'glb' || lodRank(cur.lod) >= lodRank(want) || cur.loading && lodRank(cur.wantLod) >= lodRank(want))) return
    const tok = ++loadTok
    cur.id = id; cur.error = ''; cur.loading = true; cur.stage = 'load'; cur.wantLod = want
    const t0 = performance.now()
    try {
      if (e.origin === 'entTemplate') {
        const t = ENT && ENT.entityTemplateDoc(e.templateId || e.id)
        if (!t) throw new Error(byLang('实体模板不可用。', 'Template unavailable.'))
        if (tok !== loadTok) return
        showAssembly(t.doc, { id: e.id, name: e.titleZh || e.title, title: e.title, source: plain(e.source) }, o)
      } else if (e.origin === 'template') {
        const t = templateSpec(e.templateId)
        const r = buildParamModel(t.spec)
        if (tok !== loadTok) return
        const meta = paramMeta(r, { id: e.id, title: e.title, titleZh: e.titleZh, source: e.source })
        adoptRoot(irToThree(r.ir), null, meta, 'tpl', 'lod0', o)
        paramRes = r
      } else if (e.source && e.source.kind === 'param' && !(e.spec && e.spec.kind === 'assembly')) {
        const meta = await fullMeta(e)
        if (tok !== loadTok) return
        if (!meta.spec) throw new Error(byLang('参数化模型缺少生成参数。', 'Missing spec.'))
        if (meta.spec.kind === 'assembly') throw new Error(byLang('装配文档只能配 asm: id。', 'Assembly spec requires an asm: id.'))
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
        const u = await ensureUrl(id, want, tok)
        if (!u || tok !== loadTok) return
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
  /** 当前模型换成 lod0（模型 / 导出页进来时调；已经是 lod0 就不动） */
  function ensureFullDetail() {
    if (!cur.id || cur.kind !== 'glb') return
    if (cur.lod === 'lod0' || (cur.loading && cur.wantLod === 'lod0')) return
    select(cur.id, { lod: 'lod0', keepView: true, force: true })
  }

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
    if (r.state === 'downloading') st.dl[id] = { lod: r.lod, phase: 'downloading', received: r.received || 0, total: r.total || 0, message: '' }
    else if (r.state === 'error') ui.hint(byLang('下载失败：', 'Download failed: ') + (r.message || ''))
    else if (r.state === 'missing') ui.hint(byLang('离线，无法下载。', 'Offline.'))
    else refreshSoon(0)
  }
  function cancel(id) { if (api) try { api.cancel(id) } catch { /* 无 */ } delete st.dl[id] }
  async function remove(id) {
    const e = byId(id)
    if (!e || e.origin === 'template' || e.origin === 'entTemplate') return
    const f = entryFacts(e)
    const local = f.local || f.stk || (e.source && e.source.kind === 'param')
    const ok = await ui.askConfirm(local ? byLang('删除本机模型「', 'Delete local model “') + (e.titleZh || e.title) + byLang('」？', '”?') : byLang('移除「', 'Remove cached files of “') + (e.titleZh || e.title) + byLang('」的本机缓存？', '”?'))
    if (!ok) return
    // 要删的模型还有没存的改动：不存了（删完再写只会凭空写出一份覆盖层 / 孤立元数据）；别的模型的照常先存
    if (pend && pend.id === id && local) { clearTimeout(saveT); saveT = 0; pend = null }
    // 删的正是装配页当前那份：先停自动保存（否则删完它又被存回来），删完装配页换一份新的空文档、清草稿
    if (local && asm.id === id) { asmRemoved.add(id); clearTimeout(asmSaveT); asmSaveT = 0; asm.dirty = false; asmDoc = null }
    const r = await call('remove', id)
    if (!r || r === LOCKED) return
    if (local && asm.id === id) {
      lsPut(DRAFT_KEY, null); lsPut(LAST_KEY, null); lsPut(provKey(id), null)
      asm.inLib = false
      asm.req = { kind: 'new', domain: asm.domain }
    }
    if (cur.id === id && local) { showBlank('') }
    thumbState.delete(id); delete st.thumbs[id]
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
        for (const id of ids) { j.phase = 'analyze'; persistRecent(); await postImport(id, j); lastId = id }
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
        return [fx.id]
      }
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
        const out = await exportGlb(imp.root, meta, { originAtCom: false })
        stop()
        j.phase = 'write'
        const r = await call('saveImported', { glb: out.glb, meta: { ...out.satsimJson, units: { scaleToMeters: ug.scaleToMeters, unitGuess: ug.unitGuess, sizeVerified: false } } })
        if (r === LOCKED) throw new Error(byLang('未激活', 'Not activated'))
        if (!r || !r.ok) throw new Error((r && r.error) || byLang('保存失败', 'Save failed'))
        j.modelId = r.id
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
      if (r.errors && r.errors.length) j.error = r.errors.map((x) => `${x.file}：${x.message}`).slice(0, 3).join('；')
      j.modelId = ids[ids.length - 1] || ''
      if (!ids.length) throw new Error(j.error || byLang('没有导入任何模型', 'Nothing imported'))
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
   * @returns {Promise<{id:string, stats:object}|null>}
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
      return { id: s.id, stats }
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
   * 导入后自动：单位推断 → 部件分割（Worker）→ 表面 / 体积 / 闭合性（Worker，无质量不出 massProps）→ 缩略图 → saveMeta。
   * 任何一步失败只记进作业的 error，不挡后面的步骤。
   */
  async function postImport(id, j) {
    const meta0 = await call('getMeta', id)
    if (!meta0 || meta0 === LOCKED || meta0.ok === false) return
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
      } catch (e) { notes.push(byLang('分割失败', 'segment failed')) }
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
      } catch (e) { notes.push(byLang('缩略图失败', 'thumbnail failed')) }
      // ⑤ 落盘
      const r = await call('saveMeta', { id, meta })
      if (r && r.ok === false) notes.push(byLang('元数据：', 'meta: ') + ((r.errors && r.errors[0]) || r.error || ''))
      if (j && notes.length) j.error = [j.error, ...notes].filter(Boolean).join('；')
      if (j && j.tris == null && meta.geometry) j.tris = meta.geometry.tris
    } finally {
      loaded.handle.release()
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

  // 当前装配文档的状态（文档本身在编辑器里；这里只记身份、存盘状态与最近一次提交的快照）
  const asm = reactive({
    id: '', domain: 'spacecraft', name: '', origin: 'new', templateId: '',   // origin：new | lib | template | spec | draft
    inLib: false, dirty: false, saving: false, saveErr: '', savedAt: 0, rev: 0,
    invalid: 0, empty: true,     // 参数非法件数 / 空文档（两者都不自动入库）
    prov: null,                  // 从模板复制来的文档：{illustrative, touched}（示意值描红 / 用户改过的不再描红）
    req: null                    // 外部打开请求（库页右键 / 双击、功能区「新建」…）：装配页会话消费后置 null
  })
  let asmDoc = null              // 最近一次提交的文档（冻结纯数据）；自动保存存的就是它
  let asmSeq = 0                 // 换文档计数：存盘回来时文档已经换了 → 状态不往新文档上记
  let asmSavedRev = -1           // 本文档已入库的提交号（同一份提交不重复存）
  let asmSaveT = 0, asmDragging = false, asmSaveRun = null
  const asmRemoved = new Set()   // 本窗口里删掉的装配件 id：途中的存盘作业不许把它存回来
  let asmDocJson = ''            // asmDoc 的 JSON 串（编辑器提交时现成的 after 串：比「与库里相同」、写草稿都不再序列化一遍）
  let asmLibJson = ''            // 库里这件（asm.id）的装配文档 JSON 串：提交 / 存盘内容与它相同就不标脏、不入库（撤销回到已存的样子、空操作）
  const asmDiscarded = new Map() // 问过并确认放弃的文档：文档序号 → 放弃时的提交号（这之前排上 / 在途的存盘作业不许落库）
  let draftIdle = 0              // 草稿写入排在空闲时段（提交路径上不做 localStorage 写）
  let staleAsm = ''              // 视口借给装配页期间重新入库、又正被库 / 模型 / 导出页选着的装配件：还视口时再按库里那份整件重读
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

  function beginAsm(id, doc, o) {
    ++asmSeq
    clearTimeout(asmSaveT); asmSaveT = 0
    asmDoc = null; asmDocJson = ''; asmSavedRev = -1
    asmLibJson = typeof o.libJson === 'string' ? o.libJson : ''
    cancelDraftWrite()
    asm.id = id; asm.domain = doc.domain; asm.name = doc.name; asm.origin = o.origin; asm.templateId = o.templateId || ''
    asm.inLib = !!o.inLib; asm.dirty = !!o.dirty; asm.saving = false; asm.saveErr = ''; asm.savedAt = 0; asm.rev = 0
    asm.invalid = 0; asm.empty = !doc.comps.length
    asm.prov = o.prov !== undefined ? o.prov : sanitizeProv(lsJson(provKey(id)))
  }
  /** 新建空文档（不入库；第一次提交后才有草稿，加了第一件才会自动入库） */
  function newAssembly(domain) {
    flushAssemblySave()
    const d = ASM_DOMAINS.includes(domain) ? domain : 'spacecraft'
    const doc = normalizeAssembly({ kind: 'assembly', domain: d, name: defaultAsmName(d), comps: [] })
    const id = newAsmId()
    beginAsm(id, doc, { origin: 'new', inLib: false, dirty: false, prov: null })
    return { id, doc }
  }
  /** 打开库里的装配件；本机草稿比库里那份新（关窗前没来得及入库）就用草稿、标脏、随后自动入库 */
  async function openAssembly(id) {
    flushAssemblySave()
    const m = await call('getMeta', id)
    if (!m || m === LOCKED || m.ok === false || !m.spec || m.spec.kind !== 'assembly') {
      if (m !== LOCKED) ui.hint(byLang('打不开该装配件。', 'Cannot open this assembly.'))
      return null
    }
    const draft = lsJson(DRAFT_KEY)
    const useDraft = pickDraft(draft, m)
    const doc = normalizeAssembly(useDraft ? draft.doc : m.spec)
    let libJson = ''
    try { libJson = useDraft ? JSON.stringify(normalizeAssembly(m.spec)) : JSON.stringify(doc) } catch { libJson = '' }
    beginAsm(id, doc, { origin: 'lib', inLib: true, dirty: useDraft, libJson })
    lsPut(LAST_KEY, { id })
    if (useDraft) ui.toast(byLang('已恢复未保存的改动。', 'Unsaved changes restored.'))
    return { id, doc, meta: m, restoredDraft: useDraft }
  }
  /** 进装配页时接着上次：本机草稿（库里有那份 → openAssembly 比新旧；没入过库 → 直接用草稿）→ 上次打开的库件 → null */
  async function resumeAssembly() {
    const d = lsJson(DRAFT_KEY)
    if (draftOk(d)) {
      if (!st.loaded) await refresh()
      if (byId(d.id)) return openAssembly(d.id)
      flushAssemblySave()
      const doc = normalizeAssembly(d.doc)
      beginAsm(d.id, doc, { origin: 'draft', templateId: typeof d.templateId === 'string' ? d.templateId : '', inLib: false, dirty: true, prov: sanitizeProv(d.prov) || undefined })
      ui.toast(byLang('已恢复未保存的改动。', 'Unsaved changes restored.'))
      return { id: d.id, doc, restoredDraft: true }
    }
    const last = lsJson(LAST_KEY)
    if (last && typeof last.id === 'string') {
      if (!st.loaded) await refresh()
      if (byId(last.id)) return openAssembly(last.id)
    }
    return null
  }
  /** 从实体模板开始：复制成 asm:<新 id> 用户件；模板里的示意值路径记进来源标记（属性面板描红） */
  function fromTemplate(entId) {
    const t = ENT && typeof ENT.entityTemplateDoc === 'function' ? ENT.entityTemplateDoc(entId) : null
    if (!t) { ui.hint(byLang('实体模板不可用。', 'Template unavailable.')); return null }
    flushAssemblySave()
    const tpl = typeof ENT.getEntityTemplate === 'function' ? ENT.getEntityTemplate(entId) : null
    const doc = normalizeAssembly({ ...plain(t.doc), name: (tpl && tpl.titleZh) || t.doc.name || '' })
    const id = newAsmId()
    const prov = { illustrative: Array.isArray(t.illustrative) ? t.illustrative.slice() : [], touched: [], sources: templateSources(t, doc) }
    lsPut(provKey(id), prov)
    beginAsm(id, doc, { origin: 'template', templateId: entId, inLib: false, dirty: true, prov })
    return { id, doc, prov }
  }
  /** 参数化整星 spec → 装配文档（「转为装配」）；新 id、标脏（随后自动入库） */
  function assemblyFromSpec(spec, base = {}) {
    const warnings = []
    let doc
    try { doc = specToAssembly(spec, { warnings }) } catch (e) { ui.hint(errText(e)); return null }
    flushAssemblySave()
    doc = normalizeAssembly({ ...doc, name: base.titleZh || base.title || doc.name || defaultAsmName('spacecraft') })
    const id = newAsmId()
    beginAsm(id, doc, { origin: 'spec', inLib: false, dirty: true, prov: null })
    if (warnings.length) ui.hint(warnings[0])
    return { id, doc, warnings }
  }
  /** 库条目 → 装配文档：参数化模板取模板 spec、另存的参数化件取存档 spec、实体模板走 fromTemplate */
  async function assemblyFromEntry(id) {
    const e = byId(id)
    if (!e) return null
    if (e.origin === 'entTemplate') return fromTemplate(id)
    let spec = null
    if (e.origin === 'template') spec = templateSpec(e.templateId).spec
    else if (e.source && e.source.kind === 'param') {
      const m = await call('getMeta', id)
      spec = m && m !== LOCKED && m.ok !== false ? m.spec : null
    }
    if (!spec || spec.kind === 'assembly') { ui.hint(byLang('该模型不能转为装配件。', 'Cannot convert this model.')); return null }
    return assemblyFromSpec(spec, { titleZh: e.titleZh || e.title })
  }
  /** 只读预览一份装配文档（实体模板条目选中时走它）：与入库件同一套元数据口径 */
  function showAssembly(doc, base, o = {}) {
    const r = buildAssembly(doc)
    const meta = assemblyModelMeta(r, base)
    if (base && base.title) meta.title = base.title
    adoptRoot(irToThree(r.ir), null, meta, 'tpl', 'lod0', o)
    paramRes = r
  }

  /** 草稿（本机 localStorage）：文档部分直接拼现成的 JSON 串，不再把整份文档序列化一遍。 */
  function writeDraft(doc, json) {
    cancelDraftWrite()
    const head = JSON.stringify({ id: asm.id, domain: doc.domain, name: doc.name, origin: asm.origin, templateId: asm.templateId, at: Date.now(), prov: asm.prov ? plain(asm.prov) : null })
    lsPutRaw(DRAFT_KEY, head.slice(0, -1) + ',"doc":' + (typeof json === 'string' && json ? json : JSON.stringify(doc)) + '}')
  }
  function cancelDraftWrite() {
    if (!draftIdle) return
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(draftIdle); else clearTimeout(draftIdle)
    draftIdle = 0
  }
  /** 提交路径上只排一次空闲写草稿（连续提交只写最后一份；最迟 300 ms 内写上）。 */
  function scheduleDraft() {
    if (draftIdle) return
    const run = () => { draftIdle = 0; if (asm.dirty && asmDoc && asm.id) writeDraft(asmDoc, asmDocJson) }
    draftIdle = typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 300 }) : setTimeout(run, 50)
  }
  /** 立即写上排着的草稿（关窗 / 换文档前）。 */
  function flushDraft() { if (draftIdle) { cancelDraftWrite(); if (asm.dirty && asmDoc && asm.id) writeDraft(asmDoc, asmDocJson) } }
  function syncAsmFacts(doc) { asm.name = doc.name; asm.domain = doc.domain; asm.empty = !doc.comps.length }
  /** 编辑器载入文档后（change 事件 reason = load）：只记快照；本来就是脏的（模板 / 转换 / 草稿）才写草稿、排自动保存 */
  function asmAdopt(doc, json) {
    asmDoc = doc
    asmDocJson = typeof json === 'string' ? json : ''
    syncAsmFacts(doc)
    if (asm.dirty) { writeDraft(doc, asmDocJson); scheduleAsmSave() }
  }
  /**
   * 每次提交（命令 / 拖动松手 / 撤销重做）：标脏、排草稿（空闲时段写）、排自动保存。提交路径上不算哈希、不序列化文档
   * （编辑器给现成的 JSON 串）。
   * 兜底：内容与库里那份相同（撤销回到已存的样子、编辑器漏判的空操作）且没有存盘在途 → 不标脏、清草稿、不入库
   * （入库件的 glb 带时间戳，同样内容再存一次 sha 也会变，3D 页会整件重挂模型）。判据 = JSON 串相等（两边都是归一文档的 JSON）。
   */
  function asmCommit(doc, json) {
    asmDoc = doc
    asmDocJson = typeof json === 'string' ? json : ''
    asm.rev++
    syncAsmFacts(doc)
    if (asmDocJson && asmDocJson === asmLibJson && asm.inLib && !asmSaveRun) {
      clearTimeout(asmSaveT); asmSaveT = 0
      cancelDraftWrite()
      asmSavedRev = asm.rev
      asm.dirty = false; asm.saveErr = ''
      lsPut(DRAFT_KEY, null)
      return
    }
    asm.dirty = true
    scheduleDraft()
    scheduleAsmSave()
  }
  /**
   * 换文档前问过「放弃未保存的改动？」且确认放弃：不入库、清掉本文档的草稿、记下放弃点（这之前已排上 / 在途的存盘作业到落库那一步前作废）。
   * 随后的 flushAssemblySave 因为不脏直接返回；关窗重开也不会再把放弃掉的草稿恢复回来。
   */
  function discardAssembly() {
    clearTimeout(asmSaveT); asmSaveT = 0
    cancelDraftWrite()
    asmDiscarded.set(asmSeq, asm.rev)
    asm.dirty = false; asm.saveErr = ''
    asmDoc = null; asmDocJson = ''
    const d = lsJson(DRAFT_KEY)
    if (d && d.id === asm.id) lsPut(DRAFT_KEY, null)
  }
  const discardedJob = (job) => asmDiscarded.has(job.seq) && job.rev <= asmDiscarded.get(job.seq)
  function asmSetInvalid(n) { asm.invalid = n > 0 ? n : 0 }
  /** 拖动中不自动入库（导出 glb + 缩略图会抢主线程）；松手后照常排 */
  function asmSetDragging(on) {
    asmDragging = !!on
    if (!asmDragging && asm.dirty && !asmSaveT && asmDoc) scheduleAsmSave()
  }
  /** 模板示意值 / 有出处的参数路径被用户改过 → 不再描红、不再标出处 */
  function asmTouch(path) {
    const p = asm.prov
    const sourced = !!(p && p.sources && Object.hasOwn(p.sources, path))
    if (!p || (!p.illustrative.includes(path) && !sourced) || p.touched.includes(path)) return
    asm.prov = { illustrative: p.illustrative.slice(), touched: [...p.touched, path], sources: { ...(p.sources || {}) } }
    lsPut(provKey(asm.id), plain(asm.prov))
  }
  function scheduleAsmSave(ms = 1500) {
    clearTimeout(asmSaveT)
    asmSaveT = setTimeout(() => {
      asmSaveT = 0
      if (asmDragging) { scheduleAsmSave(ms); return }
      flushAssemblySave()
    }, ms)
  }
  /** 立即把待存的提交入库（离开页签 / 换文档 / 关窗；没有待存的就什么都不做）。同步段就取好 id 与文档 */
  function flushAssemblySave() {
    clearTimeout(asmSaveT); asmSaveT = 0
    if (!asm.dirty || !asmDoc || !asm.id) return Promise.resolve(null)
    flushDraft()
    return saveAssembly(asmDoc, { json: asmDocJson })
  }
  /**
   * 装配文档入库（串行：一次只跑一个，排队的依次跑）。asNew = 另存为新 id（原 id 在库里的那份不动）。
   * 管线：校验（空 / 非法不存）→ [Worker：buildAssembly → 元数据 → irToThree → exportGlb（保留领域 q：bakeFrame:false，几何不动）]
   *      → saveImported（asm 分支：顶替同 id 旧文件、含不可分发件整件拒收）→ saveThumb（缩略图随 glb 在 Worker 里一起出）→ 刷新清单。
   *      Worker 没出成缩略图时（离屏 WebGL 起不来）退回主线程，推迟到离开装配页再出。
   * 调用时同步记下文档序号 / 提交号：跑完时文档换了，结果只进库、不往新文档的状态上记。非另存作业的 id 在运行时才定（见 runAsmSave）。
   * @returns {Promise<{ok:boolean, id?:string, code?:string, error?:string}|null>}
   */
  function saveAssembly(doc, o = {}) {
    if (o.asNew) { clearTimeout(asmSaveT); asmSaveT = 0 }
    const json = typeof o.json === 'string' && o.json ? o.json : JSON.stringify(doc)
    const job = { doc: JSON.parse(json), json, asNew: !!o.asNew, id: asm.id, seq: asmSeq, rev: asm.rev }
    const run = (asmSaveRun || Promise.resolve()).catch(() => null).then(() => runAsmSave(job))
    asmSaveRun = run
    run.finally(() => { if (asmSaveRun === run) asmSaveRun = null })
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
    const mine = () => job.seq === asmSeq
    // 非另存的作业在运行时才定 id：排队期间「另存」把当前文档换成了新 id，之后的改动跟着文档进新 id，不落回已另存离开的原件
    const idNow = () => (job.asNew ? '' : (mine() ? asm.id : job.id))
    if (!job.asNew && (asmRemoved.has(idNow()) || (mine() && job.rev <= asmSavedRev) || discardedJob(job))) return { ok: true, id: idNow(), skipped: true }
    // 校验不在主线程整份跑（每件都要算一遍插座 / 面：船体一份 ~25 ms，停手 1.5 s 自动入库正撞上转视角）：空文档直接判；
    // 编辑器报了非法件（参数 / 安装解算）直接判；其余交给 Worker 里的 buildAssembly（它先校验，非法以 SPEC_INVALID 退回）
    if (!Array.isArray(job.doc.comps) || !job.doc.comps.length) { if (mine()) asm.saveErr = ''; return { ok: false, code: 'empty' } }
    if (mine() && asm.invalid > 0 && asm.rev === job.rev) { asm.saveErr = byLang('参数非法。', 'Invalid parameters.'); return { ok: false, code: 'invalid' } }
    if (!api) return { ok: false, code: 'no-api' }
    // 与库里那份内容相同（撤销回到已存的样子 / 漏判的空操作）：不导出、不入库（入库件带时间戳，再存一次 sha 也会变）
    if (!job.asNew && mine() && job.json === asmLibJson && asm.inLib) {
      asmSavedRev = Math.max(asmSavedRev, job.rev)
      if (asm.rev === job.rev) { asm.dirty = false; asm.saveErr = ''; lsPut(DRAFT_KEY, null) }
      return { ok: true, id: idNow(), skipped: true }
    }
    // 等一个空闲时段再开工：刚停手又接着拖的时候不抢帧。等的这段里又有了新提交、且它的自动保存已经排上：这一份就不存了
    await idleSlot()
    if (!job.asNew && mine() && asm.rev !== job.rev && asmSaveT) return { ok: true, id: idNow(), skipped: true }
    const id = job.asNew ? newAsmId() : idNow()
    if (!job.asNew && asmRemoved.has(id)) return { ok: true, id, skipped: true }
    if (mine()) asm.saving = true
    try {
      const ex = await exportAsm(job.doc, { id, name: job.doc.name })
      // 导出途中确认放弃了这份文档（换文档时问过）：不落库
      if (!job.asNew && discardedJob(job)) return { ok: true, id, skipped: true }
      if (!ex.ok) {
        const msg = ex.code === 'not-redistributable' ? byLang('含不可分发的模型。', 'Contains a non-redistributable model.') : ex.code === 'invalid' ? byLang('参数非法。', 'Invalid parameters.') : ex.error
        if (mine()) asm.saveErr = msg
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
        if (mine()) asm.saveErr = msg
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
      if (mine()) {
        if (job.asNew) {
          if (asm.prov) lsPut(provKey(newId), plain(asm.prov))
          asm.id = newId; asm.origin = 'lib'
          asmSavedRev = job.rev
          asm.dirty = asm.rev !== job.rev
          // 草稿跟着换成新 id（另存期间又有提交就留着待存，否则清掉）
          if (asm.dirty && asmDoc) { writeDraft(asmDoc, asmDocJson); scheduleAsmSave() } else { cancelDraftWrite(); lsPut(DRAFT_KEY, null) }
        } else {
          asmSavedRev = Math.max(asmSavedRev, job.rev)
          if (asm.rev === job.rev) { asm.dirty = false; cancelDraftWrite(); lsPut(DRAFT_KEY, null) } else {
            // 入库途中又有提交：草稿重盖一次时间（晚于主进程刚盖的 updatedAt），关窗重开照样取草稿
            if (asmDoc) writeDraft(asmDoc, asmDocJson)
            if (!asmSaveT) scheduleAsmSave()
          }
        }
        if (asm.id === newId) asmLibJson = job.json
        asm.inLib = true; asm.saveErr = ''; asm.savedAt = Date.now()
        lsPut(LAST_KEY, { id: asm.id })
      }
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
      if (mine()) asm.saveErr = msg
      return { ok: false, code: (e && e.code) || 'error', error: msg }
    } finally {
      if (mine()) asm.saving = false
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
  /** 外部请求装配页打开 / 新建 / 从模板 / 转换：记下请求并切到装配页（装配页会话消费） */
  function requestAssembly(req) {
    if (!req || typeof req !== 'object') return
    asm.req = plain(req)
    st.tab = 'asm'
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
    flushDraft()
    flushAssemblySave()
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
    setViewport, select, ensureFullDetail, showGenerated, showBlank,
    edit, flushSave, saveSoon, hasPending, syncGeometryFromView, currentRoot, currentParam, viewMeta,
    pushUndo, dropUndo, undo, redo,
    download, cancel, remove, setGeoDefault,
    importFiles, importStk, cancelImport, canCancelJob,
    exportCurrent, saveParam, displayTitle,
    onTarget, dispose,
    TEMPLATES, TEMPLATE_IDS,
    // 装配页（P3）
    asm, lendViewport, reclaimViewport, newAssembly, openAssembly, resumeAssembly, fromTemplate, assemblyFromSpec, assemblyFromEntry,
    showAssembly, asmAdopt, asmCommit, asmSetInvalid, asmSetDragging, asmTouch, saveAssembly, flushAssemblySave, discardAssembly, requestAssembly,
    componentThumb, entityApi, entReady
  }
}
