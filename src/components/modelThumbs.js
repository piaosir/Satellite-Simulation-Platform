// 模型缩略图（3D 页共用：「卫星模型」侧栏的库网格 / 当前卫星、标记侧栏的「模型」小块、模型选择弹层）。
// 从 ModelSidePanel 原样抽出来的一份模块级单例 —— 侧栏与弹层共享同一份缓存，同一张图不画两遍。
//   · 有文件的模型：主进程 models.thumbnail（远端的由主进程下到本机缓存）；
//   · 参数化模板 param:：主进程回 missing → 现场生成（与模型工作台同一套 thumbs.renderThumb、同一把 localStorage 钥匙，值 {sig, url}
//     按几何签名作废）；
//   · 实体模板 ent:（地球站 / 飞机 / 船 / 车）：buildAssembly 现场出图，缓存键与工作台 wbStore.entThumb 同一把
//     （model/entThumb/<TPL_THUMB_VER>-r2/<id>，值 {sig: asmHash(doc), url}）—— 两个窗口同源，谁先画谁存，模板数据改了按哈希自动重画。
// 现场出图一张占主线程几十毫秒：排队、两张之间让一次空闲回调（同 wbStore.pumpRender），侧栏一展开十几张卡片不把界面卡住。
// 失效：3D 页 onModelsChanged 收到 meta（工作台重拍缩略图 / 装配件重新入库 / 改元数据）与缩略图下载完成时调 refreshThumb(id)。
// ★ 所有 api 调用都 catch（未激活时 gate 通道回 {locked:true}，这里当「没有图」处理，界面静默）。
import { shallowRef } from 'vue'
import { renderThumb, TPL_THUMB_VER } from '../viz/models/thumbs.js'
import { irToThree } from '../viz/models/irToThree.js'
import { disposeObject } from '../viz/models/loader.js'
import { buildParamModel } from '@core/models/paramBus.mjs'
import { templateSpec, resolveTemplateId } from '@core/models/paramTemplates.mjs'
import { buildAssembly, asmHash } from '@core/models/assembly.mjs'
import { entityTemplateDoc } from '@core/models/entityTemplates.mjs'
import { buildFleetModel, isFleetId, fleetSig } from '@core/models/fleet/index.mjs'

const models = () => (typeof window !== 'undefined' && window.api && window.api.models) || null

/** id → url（没有图的不在表里）；整份换引用，模板里 thumbs.value.get(id) 随之重渲染 */
export const thumbs = shallowRef(new Map())
const asked = new Set()
// 每个 id 的取图代次（取过的 id 都在表里）：重取一次 +1，在途的上一次回来就作废——不拿旧图盖掉新图
const gen = new Map()
function putThumb(id, url) { if (thumbs.value.get(id) === url) return; const m = new Map(thumbs.value); m.set(id, url); thumbs.value = m }
function dropThumb(id) { if (!thumbs.value.has(id)) return; const m = new Map(thumbs.value); m.delete(id); thumbs.value = m }
// 主进程回「没有缩略图」（本机导入件的缩略图要等部件分割与质量估算跑完才拍）：过这么久允许同一 id 再取一次——
// 卡片重新可见 / 页面重渲染时会再要；正常情况等不到这么久，补拍落盘的 meta 事件先到（refreshThumb）
const MISS_RETRY_MS = 5000

/** 取一张缩略图（幂等：同一 id 只取一次；元数据 / 缩略图变了用 refreshThumb 重取） */
export async function requestThumb(id) {
  if (!id || asked.has(id)) return
  asked.add(id)
  const g = (gen.get(id) || 0) + 1
  gen.set(id, g)
  let url = '', miss = false
  try {
    const api = models()
    const r = api && api.thumbnail ? await api.thumbnail(id) : null
    if (r && r.state === 'ready' && r.url) url = r.url
    else if (r && r.state === 'missing') miss = true
  } catch { /* 取不到就留占位图标 */ }
  if (gen.get(id) !== g) return   // 期间又重取过：以后一次为准
  const s = String(id)
  // 参数化 / 实体模板：主进程没有图时现场出图（失败也不再定时重取：出一张要几十毫秒，坏了反复画不值）
  const local = s.startsWith('param:') || s.startsWith('ent:')
  if (!url && s.startsWith('param:')) { try { url = await queued(() => paramThumb(s.slice(6))) } catch { url = '' } }
  else if (!url && s.startsWith('ent:')) { try { url = await queued(() => entThumb(s)) } catch { url = '' } }
  if (gen.get(id) !== g) return
  if (url) { putThumb(id, url); return }
  if (miss && !local) {
    // 库里明确没有图（换图后旧文件已删、或还没拍）：表里的旧地址摘掉，退回占位图标而不是裂图；过一会儿允许再取
    dropThumb(id)
    setTimeout(() => { if (gen.get(id) === g) asked.delete(id) }, MISS_RETRY_MS)
  }
}
/** 允许同一 id 再取一次（不立即取） */
export function forgetThumb(id) { asked.delete(id) }
/**
 * 元数据 / 缩略图变了（3D 页收到 models:changed 的 meta、或缩略图下载完成）：取过的 id 立即重取一次（在途的旧一次作废）；
 * 从没取过的不动——它显示出来时自然会取到新的。工作台改完装配件自动入库、导入件分析完补拍、重拍缩略图都走这里。
 */
export function refreshThumb(id) {
  if (!id || !gen.has(id)) return
  asked.delete(id)
  requestThumb(id)
}

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
// 星座精模：与 wbStore.fleetThumb 同一把钥匙
const FLEET_THUMB_KEY = (id) => `model/fleetThumb/${TPL_THUMB_VER}-f1/${String(id).replace(/^param:/, '')}`
// 更旧版本的模板缩略图（data URL，每张几十 KB）占着 localStorage 配额：本窗口第一次取模板图时扫一遍清掉。
// 只清版本号【小于】本份的 —— 工作台先升了版本、这里还没跟上时，不能把它的新图当旧图删（两边来回删 / 来回画）
let tplThumbSwept = false
function sweepOldTplThumbs() {
  if (tplThumbSwept) return
  tplThumbSwept = true
  try {
    const curN = Number(TPL_THUMB_VER.slice(1)), dead = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i), m = k && /^model\/(?:tplThumb|entThumb|fleetThumb)\/v(\d+)[/-]/.exec(k)
      if (m && Number(m[1]) < curN) dead.push(k)
    }
    for (const k of dead) localStorage.removeItem(k)
  } catch { /* 存储不可用：不清 */ }
}
async function paramThumb(id) {
  // 旧 id 别名换成现行模板 id：缓存钥匙与工作台同一把（按现行 id 存），老存档的 param:<旧 id> 直接复用那张图
  const tid = resolveTemplateId(id)
  if (!tid && isFleetId(id)) return fleetThumb(id)
  if (!tid) return ''
  sweepOldTplThumbs()
  // 值 {sig, url}：sig = 生成结果的几何签名（与工作台 wbStore.templateThumb 同式），生成器造型改了自动重画；老格式（裸 data URL）当过期
  const t = templateSpec(tid)
  const r = buildParamModel(t.spec)
  const key = TPL_THUMB_KEY(tid), sig = fleetSig(r)
  try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && c.sig === sig && c.url) return c.url } catch { /* 坏缓存 / 老格式：重画 */ }
  const rt = irToThree(r.ir)
  try {
    const url = await blobToDataUrl(await renderThumb(rt, { frame: r.frame, units: { scaleToMeters: 1 } }, { size: 384 }))
    try { localStorage.setItem(key, JSON.stringify({ sig, url })) } catch { /* 配额满：下次再画 */ }
    return url
  } finally { disposeObject(rt) }
}
// 星座精模（fleet/）：缓存键与工作台 wbStore.fleetThumb 同一把，值 {sig, url}——sig 是生成结果的几何签名（fleetSig），
// 造型改了自动重画，不必逐型号记版本号
async function fleetThumb(id) {
  sweepOldTplThumbs()
  const r = buildFleetModel(id)
  const key = FLEET_THUMB_KEY(id), sig = fleetSig(r)
  try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && c.sig === sig && c.url) return c.url } catch { /* 坏缓存：重画 */ }
  const rt = irToThree(r.ir)
  try {
    const url = await blobToDataUrl(await renderThumb(rt, { frame: r.frame, units: { scaleToMeters: 1 }, articulations: r.articulations }, { size: 384 }))
    try { localStorage.setItem(key, JSON.stringify({ sig, url })) } catch { /* 配额满：下次再画 */ }
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
