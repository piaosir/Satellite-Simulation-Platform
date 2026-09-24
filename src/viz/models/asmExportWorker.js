// 装配件入库的重活（P3 修复轮 rv1 / rv2）：buildAssembly → 元数据 → irToThree → exportGlb 整段放 Worker，缩略图也在这里出（rv2）。
// 主线程上 100 件实测：buildAssembly 36 ms、irToThree 4 ms、exportGlb 墙钟 142 ms（其中一帧长 125 ms）；缩略图在主线程另要
// 着色器编译 ~300 ms（离屏上下文第一次）+ 编码 ~90 ms——推迟到离开装配页再出，等于把整段压进切页签那一个任务里。
// 现在：导出之后 Worker 手里已有同一棵 three 树，接着在 OffscreenCanvas 的 WebGL 上下文里出 512 px 缩略图（与库卡片同一套取景 /
// 光照：thumbs.js 不依赖 document），webp 与 glb 一起 transfer 回去；主线程只剩 saveImported / saveThumb 两次 IPC。
// 库页实体模板缩略图（384 px，带关节初值）与装配页组件库卡片（128 px）也走这里（thumbAsm / thumbComp）。
//
// 由 asmExport.js 以 new Worker(new URL('./asmExportWorker.js', import.meta.url), { type: 'module' }) 启动（同 analyzeWorker 的写法）。
// 消息：
//   { id, kind:'export'（缺省）, doc, base:{id, name}, thumb?:number（边长，0 / 缺 = 不出） }
//     → { id, ok:true, glb:ArrayBuffer（transfer）, satsimJson, meta, spec, thumb:ArrayBuffer|null, thumbType, thumbErr? } | { id, ok:false, code, error }
//   { id, kind:'thumbAsm', doc, size } → { id, ok:true, thumb, thumbType } | { id, ok:false, code, error }
//   { id, kind:'thumbComp', type, size, haveSig? } → { id, ok:true, sig, same?:true, thumb?, thumbType? } | { id, ok:false, ... }
//   { id, kind:'thumbParam', spec, size } → { id, ok:true, thumb, thumbType } | { id, ok:false, code, error }（参数化模板卡片）
//   { id, kind:'densKeys', domain } → { id, ok:true, keys:string[] }（本领域组件缺省参数生成时读到的密度表键：属性面板密度节用，不在主线程把整个领域生成一遍）
//     （haveSig = 主线程本机缓存里那张的几何签名：一样就不出图，只回 same）
// 入参 / 出参都是纯数据。材质贴图在这里走 OffscreenCanvas（materials.js 没有 document 时自动退），GLTFExporter 同样认 OffscreenCanvas。
import { buildAssembly, buildComponent, componentDensityKeys } from '@core/models/assembly.mjs'
import { assemblyModelMeta } from '@core/models/asmMeta.mjs'
import { getComponent, listComponents } from '@core/models/components/index.mjs'
import { canon, fnv1a64Hex, buildParamModel } from '@core/models/paramBus.mjs'
import { irToThree } from './irToThree.js'
import { exportGlb } from './exporter.js'
import { renderThumb } from './thumbs.js'

const errText = (e) => (e && e.message) || String(e)

function disposeTree(root) {
  const geoms = new Set(), mats = new Set()
  root.traverse((o) => {
    if (o.geometry) geoms.add(o.geometry)
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []
    for (const m of ms) if (!(m.userData && m.userData._shared)) mats.add(m)
  })
  for (const g of geoms) g.dispose()
  for (const m of mats) m.dispose()
}

/** 出一张缩略图（blob → ArrayBuffer）。WebGL 在 Worker 里起不来等失败时回 {buf:null, err}（调用方退回主线程出图）。 */
async function thumbOf(rt, meta, size) {
  try {
    const blob = await renderThumb(rt, meta, { size })
    return { buf: await blob.arrayBuffer(), type: blob.type, err: '' }
  } catch (e) { return { buf: null, type: '', err: errText(e) } }
}

/** 组件卡片缩略图的几何签名（包围盒 / 网格规模 / 节点名 / 材质键）：组件定义一改自动重画（与主线程原口径相同）。 */
const compSig = (r) => fnv1a64Hex(canon({ b: r.bbox, m: r.ir.meshes.map((m) => [m.position.length, m.index.length, m.material]), n: r.ir.nodes.map((n) => n.name), k: r.ir.materials.map((x) => x && x.key) }))

async function doExport(d) {
  const { id, doc, base } = d
  let r
  // 非法文档：buildAssembly 先校验，以 SPEC_INVALID 退回（主线程不再整份校验一遍）
  try { r = buildAssembly(doc) } catch (e) { self.postMessage({ id, ok: false, code: e && e.code === 'SPEC_INVALID' ? 'invalid' : 'build', error: errText(e) }); return }
  let rt = null
  try {
    const meta = assemblyModelMeta(r, base || {})
    rt = irToThree(r.ir)
    const out = await exportGlb(rt, meta, { originAtCom: false, bakeFrame: false })
    const buf = out.glb.buffer.byteLength === out.glb.byteLength ? out.glb.buffer : out.glb.slice().buffer
    const th = d.thumb > 0 ? await thumbOf(rt, meta, d.thumb) : { buf: null, type: '', err: '' }
    const transfer = th.buf ? [buf, th.buf] : [buf]
    self.postMessage({ id, ok: true, glb: buf, satsimJson: out.satsimJson, meta: JSON.parse(JSON.stringify(meta)), spec: JSON.parse(JSON.stringify(r.spec)), thumb: th.buf, thumbType: th.type, thumbErr: th.err }, transfer)
  } catch (e) {
    self.postMessage({ id, ok: false, code: (e && e.code) || 'error', error: errText(e) })
  } finally { if (rt) disposeTree(rt) }
}

async function doThumbAsm(d) {
  const { id, doc, size } = d
  let r
  try { r = buildAssembly(doc) } catch (e) { self.postMessage({ id, ok: false, code: 'build', error: errText(e) }); return }
  const rt = irToThree(r.ir)
  try {
    // 关节元数据一起给：renderThumb 按关节初值摆静止位姿（地球站碟面按 el0 仰起、与 3D 页 / 装配页同样子）
    const th = await thumbOf(rt, { frame: r.frame, units: { scaleToMeters: 1 }, articulations: r.articulations }, size || 384)
    if (!th.buf) { self.postMessage({ id, ok: false, code: 'thumb', error: th.err }); return }
    self.postMessage({ id, ok: true, thumb: th.buf, thumbType: th.type }, [th.buf])
  } finally { disposeTree(rt) }
}

async function doThumbComp(d) {
  const { id, type, size, haveSig } = d
  let r
  try { r = buildComponent(type, {}) } catch (e) { self.postMessage({ id, ok: false, code: 'build', error: errText(e) }); return }
  const sig = compSig(r)
  if (haveSig && haveSig === sig) { self.postMessage({ id, ok: true, sig, same: true }); return }
  // 卫星件局部 −Z 贴父面、几何朝 +Z 长（显示系 +Z 朝下）：出图时绕 X 转 180°，一律「立着」拍；地面 / 飞机 / 船 / 车件本来就朝上长
  const def = getComponent(type)
  const ms = def ? r.sockets.find((s) => s.id === def.mountSocket) : null
  const q = ms && ms.n[2] < -0.5 ? [1, 0, 0, 0] : [0, 0, 0, 1]
  const rt = irToThree(r.ir)
  try {
    const th = await thumbOf(rt, { frame: { q_model2body: q, t_model2body: [0, 0, 0] }, units: { scaleToMeters: 1 } }, size || 128)
    if (!th.buf) { self.postMessage({ id, ok: false, code: 'thumb', error: th.err, sig }); return }
    self.postMessage({ id, ok: true, sig, thumb: th.buf, thumbType: th.type }, [th.buf])
  } finally { disposeTree(rt) }
}

async function doThumbParam(d) {
  const { id, spec, size } = d
  let r
  try { r = buildParamModel(spec) } catch (e) { self.postMessage({ id, ok: false, code: 'build', error: errText(e) }); return }
  const rt = irToThree(r.ir)
  try {
    const th = await thumbOf(rt, { frame: r.frame, units: { scaleToMeters: 1 } }, size || 384)
    if (!th.buf) { self.postMessage({ id, ok: false, code: 'thumb', error: th.err }); return }
    self.postMessage({ id, ok: true, thumb: th.buf, thumbType: th.type }, [th.buf])
  } finally { disposeTree(rt) }
}

async function doDensKeys(d) {
  const keys = new Set()
  for (const def of listComponents(d.domain)) for (const k of componentDensityKeys(def.type, {})) keys.add(k)
  self.postMessage({ id: d.id, ok: true, keys: [...keys] })
}

// 串行做（离屏 renderer 是 thumbs.js 的模块单例；导出与出图交错也不会互相踩——renderThumb 自己也排队）
let chain = Promise.resolve()
self.onmessage = (ev) => {
  const d = ev.data || {}
  const fn = d.kind === 'thumbAsm' ? doThumbAsm : d.kind === 'thumbComp' ? doThumbComp : d.kind === 'thumbParam' ? doThumbParam : d.kind === 'densKeys' ? doDensKeys : doExport
  chain = chain.then(() => fn(d)).catch((e) => { try { self.postMessage({ id: d.id, ok: false, code: 'error', error: errText(e) }) } catch { /* 无 */ } })
}
