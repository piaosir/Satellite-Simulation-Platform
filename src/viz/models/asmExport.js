// 装配件入库导出 / 出图的主线程端（P3 修复轮 rv1 / rv2）：把 buildAssembly + exportGlb + 缩略图交给 asmExportWorker.js，结果按请求号回送。
//   · Worker 第一次用到才起、之后常驻（材质库贴图、离屏 WebGL 上下文与着色器程序在 Worker 里只建一次）；dispose 时收掉。
//   · Worker 起不来 / 半路报错 / 超时 → 回 null，调用方退回主线程分段做（照样能存 / 能出图，只是慢）；之后不再试 Worker。
//   · 入参只收纯数据（JSON 深拷贝过的文档）：Vue Proxy 过不了结构化克隆。
const TIMEOUT_MS = 60000

let worker = null, dead = false, seq = 0
const waiting = new Map()   // id → {resolve, timer, map}

function failAll() {
  for (const [, w] of waiting) { clearTimeout(w.timer); w.resolve(null) }
  waiting.clear()
}
function ensure() {
  if (worker || dead) return worker
  try {
    worker = new Worker(new URL('./asmExportWorker.js', import.meta.url), { type: 'module' })
  } catch (e) {
    console.warn('[asmExport] Worker 起不来，改在主线程导出：' + ((e && e.message) || e))
    dead = true; worker = null
    return null
  }
  worker.onmessage = (ev) => {
    const m = ev.data || {}
    const w = waiting.get(m.id)
    if (!w) return
    waiting.delete(m.id); clearTimeout(w.timer)
    w.resolve(w.map(m))
  }
  const broken = (e) => {
    console.warn('[asmExport] Worker 出错，改在主线程导出：' + ((e && (e.message || e.type)) || e))
    dead = true
    try { worker.terminate() } catch { /* 无 */ }
    worker = null
    failAll()
  }
  worker.onerror = broken
  worker.onmessageerror = broken
  return worker
}
function ask(msg, map) {
  const w = ensure()
  if (!w) return Promise.resolve(null)
  const id = ++seq
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (waiting.delete(id)) resolve(null) }, TIMEOUT_MS)
    waiting.set(id, { resolve, timer, map })
    try { w.postMessage({ ...msg, id }) } catch (e) { waiting.delete(id); clearTimeout(timer); console.warn('[asmExport] 投递失败：' + ((e && e.message) || e)); resolve(null) }
  })
}
const thumbOut = (m) => (m.thumb ? new Uint8Array(m.thumb) : null)

/**
 * 在 Worker 里生成并导出装配件 glb；o.thumb = 缩略图边长（给了就在导出之后接着出图）。
 * @param {object} doc 纯数据装配文档
 * @param {{id:string, name?:string}} base
 * @param {{thumb?:number}} [o]
 * @returns {Promise<{ok:true, glb:Uint8Array, satsimJson:object, meta:object, spec:object, thumb:Uint8Array|null, thumbType:string}|{ok:false, code:string, error:string}|null>}
 *   null = Worker 不可用（调用方退回主线程）；thumb = null 表示 Worker 里没出成图（调用方退回主线程出图）
 */
export function exportAssemblyInWorker(doc, base, o = {}) {
  return ask({ kind: 'export', doc, base, thumb: o.thumb > 0 ? o.thumb : 0 }, (m) => (m.ok
    ? { ok: true, glb: new Uint8Array(m.glb), satsimJson: m.satsimJson, meta: m.meta, spec: m.spec, thumb: thumbOut(m), thumbType: m.thumbType || '', thumbErr: m.thumbErr || '' }
    : { ok: false, code: m.code || 'error', error: m.error || '' }))
}

/**
 * 在 Worker 里给一份装配文档出缩略图（带关节初值；库页实体模板卡片用）。
 * @returns {Promise<{ok:true, thumb:Uint8Array, thumbType:string}|{ok:false, code:string, error:string}|null>} null = Worker 不可用
 */
export function asmThumbInWorker(doc, size = 384) {
  return ask({ kind: 'thumbAsm', doc, size }, (m) => (m.ok ? { ok: true, thumb: thumbOut(m), thumbType: m.thumbType || '' } : { ok: false, code: m.code || 'error', error: m.error || '' }))
}

/**
 * 在 Worker 里给组件卡片出缩略图（缺省参数）。haveSig = 本机缓存那张的几何签名：一样就不出图（回 same:true）。
 * @returns {Promise<{ok:true, sig:string, same?:boolean, thumb?:Uint8Array, thumbType?:string}|{ok:false, code:string, error:string, sig?:string}|null>}
 */
export function compThumbInWorker(type, size = 128, haveSig = '') {
  return ask({ kind: 'thumbComp', type, size, haveSig: haveSig || '' }, (m) => (m.ok ? { ok: true, sig: m.sig, same: !!m.same, thumb: thumbOut(m), thumbType: m.thumbType || '' } : { ok: false, code: m.code || 'error', error: m.error || '', sig: m.sig || '' }))
}

/**
 * 在 Worker 里给参数化模板出缩略图（buildParamModel + 离屏渲染 + 编码）。
 * @returns {Promise<{ok:true, thumb:Uint8Array, thumbType:string}|{ok:false, code:string, error:string}|null>} null = Worker 不可用
 */
export function paramThumbInWorker(spec, size = 384) {
  return ask({ kind: 'thumbParam', spec, size }, (m) => (m.ok ? { ok: true, thumb: thumbOut(m), thumbType: m.thumbType || '' } : { ok: false, code: m.code || 'error', error: m.error || '' }))
}

/**
 * 在 Worker 里算某领域组件（缺省参数）生成时读到的密度表键（属性面板「密度」节）。
 * @returns {Promise<string[]|null>} null = Worker 不可用（调用方退回主线程）
 */
export function densKeysInWorker(domain) {
  return ask({ kind: 'densKeys', domain }, (m) => (m.ok && Array.isArray(m.keys) ? m.keys : null))
}

/** 当前是否还能用 Worker（验证台 / 读数用）。 */
export const asmExportWorkerOk = () => !dead

export function disposeAsmExport() {
  failAll()
  if (worker) { try { worker.terminate() } catch { /* 无 */ } worker = null }
}
