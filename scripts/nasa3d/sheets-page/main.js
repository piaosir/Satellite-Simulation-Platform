// nasa3d:sheets 离屏出图页：主进程（scripts/nasa3d/sheets.mjs）经 executeJavaScript 逐条调 window.sheets.* 出图。
//
// ★ 渲染与工作台 / 3D 页【同一套代码、同一个朝向】：thumbs.renderThumb（studio 影棚光、materials 材质库、ACES、2× 超采样、
//   缺省「自动」视角 autoViewFor）、loader.loadModel（meshopt / Draco 解码、删相机灯光、SpecGloss 转换）、irToThree + paramBus。
//   本页不再自己摆朝向（2026-09-24 修：之前按「天顶朝上」翻过模型，画廊缩略图与点开后的预览上下颠倒；显示系与第一眼视角
//   的口径只在 view.js / thumbs.js 一处定，工作台预览、应用内重拍的缩略图、这里三处自动一致——那边改了，这里跟着变）。
//
// 本页只多做一件事——稳健取景（细长件不撑画面）：
//   ① 先用 renderThumb 按 RENDER 边长出一张全景（与应用内同参，只是更大），把 alpha 掩模交给 crop.contentSquare：
//      腐蚀掉细杆 / 线天线后取「有厚度的部分」的正方形框；
//   ② 框比全景小（放大 > 1.02×）就【重新渲染】那一块：同一台相机（同一方向、同一取景距离、同一布光），
//      用 PerspectiveCamera.setViewOffset 只画框内那一块，按缩略图边长 × 2 超采样出图——不是把全景的像素放大，
//      所以放大倍数不用再封顶 3×（之前 cluster-ii / wind 这类本体只剩 50 px）；透视与全景完全一致（伸向相机的长杆不会变成前景大块）。
//      相机、布光的算法与 thumbs.renderThumb 逐行对应（mountForRender），第二台 renderer 与 thumbs 的单例互不干扰。
//   ③ 出图后量一次画面（crop.thumbQa：占画面比例、亮度均值 / 方差），过暗 / 过曝发白 / 太小的记进 sheets.json，build 的 REPORT 列出来。
//
// 隐藏窗口的坑（memory：spin-harness-electron-raf / canvas-pixel-diff-trap）：窗口不显示时 rAF 停、挂在 DOM 上的 canvas 没有后备存储、
//   定时器被节流。所以这里全程不用 rAF / setTimeout：renderer 画在 OffscreenCanvas 上，同步 render 一次就拷进 2D 画布，
//   之后只有 convertToBlob / createImageBitmap 这类 Promise（不受节流影响）。
import * as THREE from 'three'
import { renderThumb, renderThreeView, applyRestPose, autoViewFor, disposeThumbs } from '../../../src/viz/models/thumbs.js'
import { configureRenderer, createStudio, rigOrientFor } from '../../../src/viz/models/studio.js'
import { setMaterialAnisotropy } from '../../../src/viz/models/materials.js'
import { createGpuReleaser } from '../../../src/viz/models/gpuRelease.js'
import { loadModel, setDecoderBase, disposeLoaders } from '../../../src/viz/models/loader.js'
import { irToThree } from '../../../src/viz/models/irToThree.js'
import { BODY_TO_DISPLAY, ZENITH_DISPLAY, modelToBodyMatrix, viewDir, sampleWorldPoints, fitPerspective, boundingRadius } from '../../../src/viz/models/view.js'
import { buildTemplateModel } from '../../../packages/core/models/paramBus.mjs'
import { contentSquare, thumbQa } from './crop.mjs'

const LIBS = new URL('../../../node_modules/three/examples/jsm/libs/', import.meta.url).href
setDecoderBase({ draco: LIBS + 'draco/gltf/', basis: LIBS + 'basis/' })

const THUMB = 512
const REVIEW_CELL = 512
// 全景边长：3 倍于缩略图（renderThumb 自己再 2× 超采样），腐蚀取框的分辨率够细
const RENDER = THUMB * 3
const SS = 2
const ISO = viewDir('iso', new THREE.Vector3())

// ─────────────────────────────── 小工具 ───────────────────────────────
async function blobToB64(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return btoa(s)
}
function b64ToU8(b64) {
  const s = atob(b64)
  const u8 = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i)
  return u8
}
const now = () => performance.now()

// ─────────────────────────────── 第二台 renderer：只画裁切框（与 thumbs.js 的 ctx / mount / renderThumb 逐行对应） ───────────────────────────────
let _R = null
function framedCtx(W) {
  if (!_R) {
    const canvas = new OffscreenCanvas(W, W)
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(1)
    renderer.setClearColor(0x000000, 0)
    configureRenderer(renderer)
    setMaterialAnisotropy(renderer)
    const gpu = createGpuReleaser(renderer)
    const scene = new THREE.Scene()
    const body = new THREE.Group(); body.matrixAutoUpdate = false; body.matrix.copy(BODY_TO_DISPLAY)
    const holder = new THREE.Group(); holder.matrixAutoUpdate = false
    body.add(holder); scene.add(body)
    const studio = createStudio(renderer, scene, { mode: 'studio', shadowMapSize: 2048 })
    studio.setUp(ZENITH_DISPLAY)
    _R = { canvas, renderer, scene, body, holder, studio, gpu }
  }
  if (_R.canvas.width !== W || _R.canvas.height !== W) _R.renderer.setSize(W, W, false)
  return _R
}
function disposeFramed() {
  if (!_R) return
  _R.gpu.releaseAll()
  _R.studio.dispose()
  _R.renderer.dispose()
  try { _R.renderer.forceContextLoss() } catch { /* ignore */ }
  _R = null
}
const _rq = new THREE.Quaternion(), _q0 = new THREE.Quaternion()

/**
 * 与 thumbs.renderThumb 同一台相机，只画全景（full × full 像素）里的 crop 框，输出 out × out。
 * 步骤逐行对应 thumbs.js：mount（克隆 → 静止位姿 → 模型→本体矩阵 → 采样 3 万点 → 布光按包围球）→ 自动视角 → 灯组随视角 →
 * fitPerspective(30°, 8 % 边) → near / far；多出来的只有 setViewOffset。
 */
function renderCrop(root, meta, full, crop, out) {
  const W = out * SS
  const T = framedCtx(W)
  const clone = root.clone(true)
  applyRestPose(clone, meta)
  T.gpu.track(clone)
  modelToBodyMatrix(meta, T.holder.matrix)
  T.holder.matrixWorldNeedsUpdate = true
  T.holder.add(clone)
  T.scene.updateMatrixWorld(true)
  try {
    const pts = sampleWorldPoints(clone, 30000)
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1], z = pts[i + 2]
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z
    }
    const center = pts.length ? new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2) : new THREE.Vector3()
    const radius = pts.length ? Math.max(1e-3, boundingRadius(pts, center.x, center.y, center.z)) : 1
    T.studio.setMode('studio')
    T.studio.fit(center, radius)
    const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 1000)
    const dir = autoViewFor(clone)
    T.studio.orient(rigOrientFor(dir, ISO, _rq))
    const fit = fitPerspective(pts, dir, cam.fov, 1, 0.08)
    cam.position.copy(fit.target).addScaledVector(dir, fit.dist)
    cam.near = Math.max(1e-3, (fit.dist - fit.radius * 2) * 0.5, fit.dist * 0.01)
    cam.far = fit.dist + fit.radius * 4
    cam.lookAt(fit.target)
    cam.setViewOffset(full, full, crop.x, crop.y, crop.side, crop.side)
    cam.updateProjectionMatrix()
    T.renderer.setClearColor(0x000000, 0)
    T.renderer.render(T.scene, cam)
    const c = new OffscreenCanvas(out, out)
    const g = c.getContext('2d')
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'
    g.drawImage(T.canvas, 0, 0, out, out)
    return c
  } finally {
    T.studio.orient(_q0)
    T.holder.remove(clone)
    T.gpu.releaseTree(clone, { kinds: ['geo', 'tex'], keepShared: true })
  }
}

/** 画布 → 缩略图 WebP + 画面质检 */
async function finish(canvas, zoom, cropInfo) {
  const g = canvas.getContext('2d', { willReadFrequently: true })
  const px = g.getImageData(0, 0, canvas.width, canvas.height).data
  const qa = thumbQa(px, canvas.width)
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })
  if (blob.type !== 'image/webp') throw new Error(`编码结果是 ${blob.type || '未知类型'}，不是 image/webp`)
  return { blob, zoom: +zoom.toFixed(3), qa, crop: cropInfo }
}

/**
 * 缩略图：renderThumb 全景（与应用内同一张脸）→ 稳健取景框 → 框比全景小就只重画那一块（见文件头 ②）。
 * @returns {{blob, zoom, qa, crop}}
 */
async function thumbWebp(root, meta) {
  const big = await renderThumb(root, meta, { size: RENDER, mode: 'studio', type: 'image/png' })
  const bmp = await createImageBitmap(big)
  try {
    const probe = new OffscreenCanvas(RENDER, RENDER)
    const pg = probe.getContext('2d', { willReadFrequently: true })
    pg.drawImage(bmp, 0, 0)
    const px = pg.getImageData(0, 0, RENDER, RENDER).data
    const alpha = new Uint8Array(RENDER * RENDER)
    for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3]
    const crop = contentSquare(alpha, RENDER)
    if (crop.zoom <= 1.02) {
      const out = new OffscreenCanvas(THUMB, THUMB)
      const g = out.getContext('2d', { willReadFrequently: true })
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'
      g.drawImage(bmp, 0, 0, THUMB, THUMB)
      return finish(out, 1, null)
    }
    const c = renderCrop(root, meta, RENDER, crop, THUMB)
    return finish(c, crop.zoom, { x: +crop.x.toFixed(1), y: +crop.y.toFixed(1), side: +crop.side.toFixed(1), full: RENDER })
  } finally { bmp.close() }
}

// ─────────────────────────────── 复核图：抬头两行 + 三视图四宫格 ───────────────────────────────
async function reviewPng(root, meta, head) {
  const tv = await renderThreeView(root, meta, { cell: REVIEW_CELL })
  const bmp = await createImageBitmap(tv)
  const HH = 64
  const c = new OffscreenCanvas(bmp.width, bmp.height + HH)
  const g = c.getContext('2d')
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height)
  g.drawImage(bmp, 0, HH)
  bmp.close()
  // 抬头按宽度缩字号（长标题的条目不截断；缩到 11 px 仍放不下才截断加省略号）
  const fitText = (s, y, weight, px, color) => {
    const maxW = c.width - 28
    let f = px
    for (; f > 11; f--) { g.font = `${weight} ${f}px "Microsoft YaHei", "Segoe UI", Arial, sans-serif`; if (g.measureText(s).width <= maxW) break }
    g.font = `${weight} ${f}px "Microsoft YaHei", "Segoe UI", Arial, sans-serif`
    let t = s
    while (t.length > 1 && g.measureText(t).width > maxW) t = t.slice(0, -2) + '…'
    g.fillStyle = color
    g.fillText(t, 14, y)
  }
  g.textBaseline = 'middle'
  fitText(head[0] || '', 20, 600, 20, '#1f2328')
  fitText(head[1] || '', 46, 400, 15, '#4b5563')
  g.strokeStyle = 'rgba(120,124,130,0.55)'; g.lineWidth = 1
  g.beginPath(); g.moveTo(0, HH - 0.5); g.lineTo(c.width, HH - 0.5); g.stroke()
  return c.convertToBlob({ type: 'image/png' })
}

function countTris(root) {
  let t = 0
  root.traverse((o) => { if (o.isMesh && o.geometry) { const g = o.geometry; t += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3) } })
  return t
}

// ─────────────────────────────── 对外：主进程逐条调 ───────────────────────────────
/**
 * NASA 条目：o = { id, url（sheet://build/… 的 lod 文件）, meta（frame / units / attachPoints）, review, head:[两行], thumb? }
 * → { thumb: base64 webp, review?: base64 png, zoom, qa, crop, tris, ms:{load, thumb, review} }；出错 { error }
 * o.thumb === false：只出复核图（抬头变了、缩略图键没变——sheets.mjs 的 sheetPlan 'review'）→ { review, tris, ms }，不碰缩略图
 */
async function renderNasa(o) {
  const t0 = now()
  let loaded = null
  try {
    const res = await fetch(o.url)
    if (!res.ok) throw new Error(`取文件 HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    loaded = await loadModel({ bytes, name: o.id })   // 字节来源不进 loader 缓存：release 即释放（批量出图不攒内存）
    const t1 = now()
    const th = o.thumb === false ? null : await thumbWebp(loaded.root, o.meta)
    const t2 = now()
    const out = th ? { thumb: await blobToB64(th.blob), zoom: th.zoom, qa: th.qa, crop: th.crop, tris: countTris(loaded.root), thumbBytes: th.blob.size } : { tris: countTris(loaded.root) }
    if (o.review) out.review = await blobToB64(await reviewPng(loaded.root, o.meta, o.head || []))
    out.ms = { load: Math.round(t1 - t0), thumb: Math.round(t2 - t1), review: Math.round(now() - t2) }
    return out
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 400) }
  } finally {
    if (loaded) loaded.handle.release()
  }
}

/**
 * 参数化模板：o = { templateId, review, head, thumb? }；由 paramBus（确定性）+ irToThree 生成，与 3D 页 / 工作台同一条路。
 * o.thumb === false 同 renderNasa：只出复核图。
 * meta 只给 frame / units（与工作台 wbStore.templateThumb 同参）；复核图另带挂点。另回 specHash（builtin.mjs 核对缩略图是否还对得上当前模板）。
 */
async function renderTemplate(o) {
  const t0 = now()
  let root = null
  try {
    const r = buildTemplateModel(o.templateId)
    root = irToThree(r.ir)
    const meta = { frame: r.frame, units: { scaleToMeters: 1 } }
    const t1 = now()
    const th = o.thumb === false ? null : await thumbWebp(root, meta)
    const t2 = now()
    const out = th ? { thumb: await blobToB64(th.blob), zoom: th.zoom, qa: th.qa, crop: th.crop, tris: countTris(root), thumbBytes: th.blob.size, specHash: r.specHash } : { tris: countTris(root), specHash: r.specHash }
    if (o.review) out.review = await blobToB64(await reviewPng(root, { ...meta, attachPoints: r.attachPoints, articulations: r.articulations }, o.head || []))
    out.ms = { load: Math.round(t1 - t0), thumb: Math.round(t2 - t1), review: Math.round(now() - t2) }
    return out
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 400) }
  } finally {
    // irToThree 的材质来自共享材质库（_shared，disposeObject 会跳过）；几何各自一份，放掉
    if (root) root.traverse((x) => { if (x.isMesh && x.geometry && !(x.geometry.userData && x.geometry.userData._shared)) x.geometry.dispose() })
  }
}

/**
 * 退回 NASA 官方缩图：主进程取回的图片字节（jpg / png）→ 512×512 透明底、等比居中 → WebP。
 * 官方图多是 16:9 带黑 / 深色背景的渲染图，这里不抠图（不猜背景），原样等比放进方格。
 */
async function officialThumb(o) {
  try {
    const bmp = await createImageBitmap(new Blob([b64ToU8(o.b64)], { type: o.mime || 'image/png' }))
    const c = new OffscreenCanvas(THUMB, THUMB)
    const g = c.getContext('2d')
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'
    const k = Math.min(THUMB / bmp.width, THUMB / bmp.height)
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k)
    g.drawImage(bmp, Math.round((THUMB - w) / 2), Math.round((THUMB - h) / 2), w, h)
    bmp.close()
    const blob = await c.convertToBlob({ type: 'image/webp', quality: 0.9 })
    if (blob.type !== 'image/webp') throw new Error(`编码结果是 ${blob.type || '未知类型'}，不是 image/webp`)
    return { thumb: await blobToB64(blob), thumbBytes: blob.size }
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 400) }
  }
}

/** webp → png（复核 / 抽看用：看图工具不一定认 webp） */
async function webpToPng(o) {
  try {
    const bmp = await createImageBitmap(new Blob([b64ToU8(o.b64)], { type: 'image/webp' }))
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    c.getContext('2d').drawImage(bmp, 0, 0)
    bmp.close()
    return { png: await blobToB64(await c.convertToBlob({ type: 'image/png' })) }
  } catch (e) { return { error: String((e && e.message) || e) } }
}

/**
 * 对拍：同一模型，renderThumb 全景与本页第二台 renderer 的「整幅框」（crop = 全景）逐像素比（证明 renderCrop 与 thumbs 同一台相机、
 * 同一套布光）。sheets.mjs 每次真要出图前先跑一次当闸门（parityVerdict），验证台也用。
 *   o = { url, meta, id? } 按文件（NASA 件）或 { templateId } 按参数化模板生成（与 renderTemplate 同参）；size 缺省 512、tol 缺省 2。
 * → { diffPx（任一通道差 > tol 的像素数）, maxDiff, n }；出错 { error }
 */
async function selfCheck(o) {
  let loaded = null, gen = null
  try {
    let root, meta
    if (o.templateId) {
      const r = buildTemplateModel(o.templateId)
      gen = root = irToThree(r.ir)
      meta = { frame: r.frame, units: { scaleToMeters: 1 } }
    } else {
      const res = await fetch(o.url)
      if (!res.ok) throw new Error(`取文件 HTTP ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      loaded = await loadModel({ bytes, name: o.id || 'selfcheck' })
      root = loaded.root
      meta = o.meta
    }
    const S = o.size || 512
    const a = await createImageBitmap(await renderThumb(root, meta, { size: S, mode: 'studio', type: 'image/png' }))
    const ca = new OffscreenCanvas(S, S); const ga = ca.getContext('2d', { willReadFrequently: true }); ga.drawImage(a, 0, 0); a.close()
    const cb = renderCrop(root, meta, S, { x: 0, y: 0, side: S }, S)
    const pa = ga.getImageData(0, 0, S, S).data, pb = cb.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, S, S).data
    let diffPx = 0, maxDiff = 0
    const tol = o.tol ?? 2
    for (let i = 0; i < pa.length; i += 4) {
      let m = 0
      for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(pa[i + k] - pb[i + k]))
      if (m > tol) diffPx++
      if (m > maxDiff) maxDiff = m
    }
    return { diffPx, maxDiff, n: S * S }
  } catch (e) { return { error: String((e && e.message) || e) } } finally {
    if (loaded) loaded.handle.release()
    if (gen) gen.traverse((x) => { if (x.isMesh && x.geometry && !(x.geometry.userData && x.geometry.userData._shared)) x.geometry.dispose() })
  }
}

/** 探一次环境：WebGL2、WebP 编码、GPU 名（写进日志，软件光栅时一眼能看出来） */
async function probe() {
  const c = new OffscreenCanvas(8, 8)
  const gl = c.getContext('webgl2')
  let gpu = ''
  if (gl) { const ext = gl.getExtension('WEBGL_debug_renderer_info'); gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) }
  const oc = new OffscreenCanvas(4, 4)
  oc.getContext('2d').fillRect(0, 0, 4, 4)
  const b = await oc.convertToBlob({ type: 'image/webp' })
  return { webgl2: !!gl, gpu: String(gpu), webp: b.type === 'image/webp', three: THREE.REVISION }
}

async function shutdown() { await disposeThumbs(); disposeFramed(); disposeLoaders(); return true }

window.sheets = { renderNasa, renderTemplate, officialThumb, webpToPng, selfCheck, probe, shutdown }
window.sheetsReady = Promise.resolve(true)
