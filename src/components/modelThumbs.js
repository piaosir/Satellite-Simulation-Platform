// 模型缩略图（3D 页共用：「卫星模型」侧栏的库网格 / 当前卫星、标记侧栏的「模型」小块、模型选择弹层）。
// 从 ModelSidePanel 原样抽出来的一份模块级单例 —— 侧栏与弹层共享同一份缓存，同一张图不画两遍。
//   · 有文件的模型：主进程 models.thumbnail（远端的由主进程下到本机缓存）；
//   · 参数化模板 param:：主进程回 missing → 现场生成（与模型工作台同一套 thumbs.renderThumb、同一把 localStorage 钥匙）；
//   · 实体模板 ent:（地球站 / 飞机 / 船 / 车）：buildAssembly 现场出图，缓存键与工作台 wbStore.entThumb 同一把
//     （model/entThumb/<TPL_THUMB_VER>-r2/<id>，值 {sig: asmHash(doc), url}）—— 两个窗口同源，谁先画谁存，模板数据改了按哈希自动重画。
// 现场出图一张占主线程几十毫秒：排队、两张之间让一次空闲回调（同 wbStore.pumpRender），侧栏一展开十几张卡片不把界面卡住。
// ★ 所有 api 调用都 catch（未激活时 gate 通道回 {locked:true}，这里当「没有图」处理，界面静默）。
import { shallowRef } from 'vue'
import { renderThumb, TPL_THUMB_VER } from '../viz/models/thumbs.js'
import { irToThree } from '../viz/models/irToThree.js'
import { disposeObject } from '../viz/models/loader.js'
import { buildParamModel } from '@core/models/paramBus.mjs'
import { templateSpec, resolveTemplateId } from '@core/models/paramTemplates.mjs'
import { buildAssembly, asmHash } from '@core/models/assembly.mjs'
import { entityTemplateDoc } from '@core/models/entityTemplates.mjs'

const models = () => (typeof window !== 'undefined' && window.api && window.api.models) || null

/** id → url（没有图的不在表里）；整份换引用，模板里 thumbs.value.get(id) 随之重渲染 */
export const thumbs = shallowRef(new Map())
const asked = new Set()
function putThumb(id, url) { const m = new Map(thumbs.value); m.set(id, url); thumbs.value = m }

/** 取一张缩略图（幂等：同一 id 只取一次；下载完成后要重取先 forgetThumb） */
export async function requestThumb(id) {
  if (!id || asked.has(id)) return
  asked.add(id)
  let url = ''
  try {
    const api = models()
    const r = api && api.thumbnail ? await api.thumbnail(id) : null
    if (r && r.state === 'ready' && r.url) url = r.url
  } catch { /* 取不到就留占位图标 */ }
  const s = String(id)
  if (!url && s.startsWith('param:')) { try { url = await queued(() => paramThumb(s.slice(6))) } catch { url = '' } }
  else if (!url && s.startsWith('ent:')) { try { url = await queued(() => entThumb(s)) } catch { url = '' } }
  if (url) putThumb(id, url)
}
/** 下载 / 元数据变了：允许同一 id 再取一次 */
export function forgetThumb(id) { asked.delete(id) }

// ---- 现场出图队列 ----
const queue = []
let pumping = false
const idleSlot = () => new Promise((r) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => r(), { timeout: 250 }) : setTimeout(r, 16)))
function queued(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject })
    if (!pumping) pump()
  })
}
async function pump() {
  pumping = true
  while (queue.length) {
    const it = queue.shift()
    try { it.resolve(await it.job()) } catch (e) { it.reject(e) }
    if (queue.length) await idleSlot()
  }
  pumping = false
}

function blobToDataUrl(b) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b) }) }

// 模板缩略图缓存：与模型工作台（src/model/wbStore.js 的 templateThumb）同一把 localStorage 钥匙、同一组出图参数
const TPL_THUMB_KEY = (tid) => `model/tplThumb/${TPL_THUMB_VER}/${tid}`
// 实体模板：与 wbStore.entThumb 同一把钥匙（ENT_THUMB_REV = 'r2'，两边一起升）
const ENT_THUMB_KEY = (id) => `model/entThumb/${TPL_THUMB_VER}-r2/${id}`
// 更旧版本的模板缩略图（data URL，每张几十 KB）占着 localStorage 配额：本窗口第一次取模板图时扫一遍清掉。
// 只清版本号【小于】本份的 —— 工作台先升了版本、这里还没跟上时，不能把它的新图当旧图删（两边来回删 / 来回画）
let tplThumbSwept = false
function sweepOldTplThumbs() {
  if (tplThumbSwept) return
  tplThumbSwept = true
  try {
    const curN = Number(TPL_THUMB_VER.slice(1)), dead = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i), m = k && /^model\/(?:tplThumb|entThumb)\/v(\d+)[/-]/.exec(k)
      if (m && Number(m[1]) < curN) dead.push(k)
    }
    for (const k of dead) localStorage.removeItem(k)
  } catch { /* 存储不可用：不清 */ }
}
async function paramThumb(id) {
  // 旧 id 别名换成现行模板 id：缓存钥匙与工作台同一把（按现行 id 存），老存档的 param:<旧 id> 直接复用那张图
  const tid = resolveTemplateId(id)
  if (!tid) return ''
  sweepOldTplThumbs()
  try { const u = localStorage.getItem(TPL_THUMB_KEY(tid)); if (u) return u } catch { /* 无 */ }
  const t = templateSpec(tid)
  const r = buildParamModel(t.spec)
  const rt = irToThree(r.ir)
  try {
    const url = await blobToDataUrl(await renderThumb(rt, { frame: r.frame, units: { scaleToMeters: 1 } }, { size: 384 }))
    try { localStorage.setItem(TPL_THUMB_KEY(tid), url) } catch { /* 配额满：下次再画 */ }
    return url
  } finally { disposeObject(rt) }
}
async function entThumb(id) {
  const t = entityTemplateDoc(id)
  if (!t) return ''
  sweepOldTplThumbs()
  const key = ENT_THUMB_KEY(id), sig = asmHash(t.doc)
  try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && c.sig === sig && c.url) return c.url } catch { /* 坏缓存：重画 */ }
  const r = buildAssembly(t.doc)
  const rt = irToThree(r.ir)
  try {
    // 关节元数据一起给：renderThumb 按关节初值摆静止位姿（地球站碟面按 el0 仰起，与工作台 / 3D 页同样子）
    const url = await blobToDataUrl(await renderThumb(rt, { frame: r.frame, units: { scaleToMeters: 1 }, articulations: r.articulations }, { size: 384 }))
    try { localStorage.setItem(key, JSON.stringify({ sig, url })) } catch { /* 配额满：下次再画 */ }
    return url
  } finally { disposeObject(rt) }
}

/**
 * 可见才取：卡片进视口（外扩 rootMargin）时 requestThumb(el.dataset.id)。函数 ref 直接传 observe。
 * @returns {{observe(el:Element|null):void, disconnect():void}}
 */
export function createThumbObserver(rootMargin = '120px') {
  const io = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((ents) => {
      for (const en of ents) if (en.isIntersecting) { requestThumb(en.target.dataset.id); io.unobserve(en.target) }
    }, { rootMargin })
    : null
  return {
    observe(el) {
      if (!el || !el.dataset || !el.dataset.id) return
      if (asked.has(el.dataset.id)) return
      if (io) io.observe(el); else requestThumb(el.dataset.id)
    },
    disconnect() { if (io) io.disconnect() }
  }
}
