// 2D 平面图「换平面」之后的两件事（体检 2026-10-16 第二档）。运行：npm test -- flatPlaneChange
//
// ① 换投影 / 改画面中心 / 坐标系恢复默认后 2D 回全图，但缩放条与视图记忆没跟上：
//    rebuildPlane 真 fit 了却不回调 onZoom（状态栏还挂着旧缩放读数，点「＋」跳一档）；视图记忆只存 scale 与平面坐标 cx / cy，
//    换了平面同一对数指到地图上别处 —— 关软件再开，2D 按旧平面坐标恢复成一块错位的放大区域。
//    修：fit 了就回调 onZoom（宿主回填缩放条 + 重记视图）；getView 带平面指纹 plane（planeSigOf），宿主首次进 2D 指纹对不上就不恢复。
// ② 非等距圆柱投影下，环境场 / 实时气象换字段、换配色、时间轴换帧都不刷新：
//    上色那一侧同尺寸复用同一张 canvas，而栅格重投影缓存与方位等距的源图缩略图都按 __rpId 认图 —— 身份不换就一直命中旧缓存。
//    修：setEnvRaster 每次提交都给图换重投影身份；缩略图分影像 / 其余两个槽，环境场重烘不再把影像那张挤掉。
//
// flatCoverage 是 DOM 模块：这里给最小的假 canvas / 假 2D 上下文（方法一律空跑，drawImage 记账），真跑 createFlatCoverage。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}

// ---------- 假 DOM ----------
const drawLog = []    // 每次 drawImage 的入参（判「烘了没有」：重投影逐三角 drawImage(源, 0, 0)，缩略图 drawImage(源, 0, 0, w, h)）
const mkCtx = () => new Proxy({}, {
  get(t, k) {
    if (k in t) return t[k]
    if (k === 'drawImage') return (...a) => { drawLog.push(a) }
    if (k === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 })
    if (k === 'getImageData' || k === 'createImageData') return () => ({ data: new Uint8ClampedArray(4) })
    if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop() {} })
    if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
    if (k === 'isPointInPath' || k === 'isPointInStroke') return () => false
    if (k === 'canvas') return null
    return typeof k === 'string' ? () => {} : undefined
  },
  set(t, k, v) { t[k] = v; return true }
})
const mkCanvas = (w = 800, h = 400) => ({
  width: w, height: h, clientWidth: w, clientHeight: h, style: {},
  getContext: (kind) => (kind === '2d' ? mkCtx() : null),
  addEventListener() {}, removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h }),
  setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false, toDataURL: () => ''
})
globalThis.window = globalThis
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}
globalThis.devicePixelRatio = 1
globalThis.document = { createElement: () => mkCanvas(), documentElement: { style: {} }, fonts: { load: async () => [], check: () => true } }
globalThis.requestAnimationFrame = () => 0
globalThis.cancelAnimationFrame = () => {}
globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} bezierCurveTo() {} quadraticCurveTo() {} }
globalThis.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h } }
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.Image = class { constructor() { this.complete = false; this.width = 0; this.height = 0 } addEventListener() {} }
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
if (!globalThis.localStorage) globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }

const { createFlatCoverage, planeSigOf } = await import('../../../src/viz/flatmap/flatCoverage.js')
const { mapCrs, setMapCrs, projOpts, centerToLon0, MAP_CRS_DEF } = await import('../../../src/stores/mapCrs.js')

// ---------- ① 平面指纹 planeSigOf（纯函数）----------
{
  ok('① 等距圆柱只认切口（中心纬度 / 标准纬线不进指纹）',
    planeSigOf('equirect', -30, { lat0: 40, par1: 10, par2: 60 }) === planeSigOf('equirect', -30, {}) && planeSigOf('equirect', -30, {}) === 'equirect|-30',
    planeSigOf('equirect', -30, { lat0: 40 }))
  ok('① 方位等距认中心纬度、阿尔伯斯认两条标准纬线（缺省按中国全图那一对）',
    planeSigOf('azeq', 0, { lat0: 35 }) !== planeSigOf('azeq', 0, { lat0: 36 }) &&
    planeSigOf('albers', 0, {}) === planeSigOf('albers', 0, { par1: 25, par2: 47 }) &&
    planeSigOf('albers', 0, { par1: 20 }) !== planeSigOf('albers', 0, {}) &&
    planeSigOf('mercator', 0, { lat0: 35, par1: 20 }) === planeSigOf('mercator', 0, {}))
  ok('① ±180 是同一条经线；末位浮点抖动不算换了平面；差 0.001° 算',
    planeSigOf('robinson', 180, {}) === planeSigOf('robinson', -180, {}) &&
    planeSigOf('robinson', 179.9999999999, {}) === planeSigOf('robinson', -180, {}) &&
    planeSigOf('equirect', -29.999999999999996, {}) === planeSigOf('equirect', -30, {}) &&
    planeSigOf('equirect', -30.001, {}) !== planeSigOf('equirect', -30, {}))
  ok('① 认不出的档按出厂档（与 makeProjection 同口径）', planeSigOf('bogus', -30, {}) === planeSigOf(MAP_CRS_DEF.proj, MAP_CRS_DEF.lon0, MAP_CRS_DEF))
}

// ---------- ① 实例：fit 了才回调 onZoom；getView 带平面指纹 ----------
const f = createFlatCoverage(mkCanvas())
f.resize()
const zoomCalls = []
f.setOnZoom((t) => zoomCalls.push(t))
{
  const v0 = f.getView()
  ok('① getView 带平面指纹，与实例的 planeSig() 一致', typeof v0.plane === 'string' && v0.plane === f.planeSig() && v0.plane === 'equirect|-30', JSON.stringify(v0))
  f.setZoom(0.8)
  const tIn = f.getZoom()
  f.setProjection('mercator', {})
  const tFit = f.getZoom()
  ok('① 换投影档 → fit 回全图并回调 onZoom（带的是 fit 之后的缩放读数）',
    zoomCalls.length === 1 && Math.abs(zoomCalls[0] - tFit) < 1e-12 && f.getView().scale === 1 && tIn > tFit + 0.1,
    `调用 ${zoomCalls.length} 次 · 放大时 ${tIn.toFixed(3)} → fit ${tFit.toFixed(3)}`)
  ok('① 换投影档后视图记忆的指纹换成新平面', f.getView().plane === 'mercator|-30' && f.getView().plane !== v0.plane, f.getView().plane)
  f.setZoom(0.6)
  const before = f.getView(), n0 = zoomCalls.length
  f.setLon0(20, true, {})
  const after = f.getView()
  ok('① 跟随式换切口（keepView）：不 fit、不回调，视图原样，指纹换了',
    zoomCalls.length === n0 && after.scale === before.scale && Math.abs(after.cx - before.cx) < 1e-9 && Math.abs(after.cy - before.cy) < 1e-9 && after.plane !== before.plane,
    `${before.plane} → ${after.plane}`)
  f.setLon0(75)
  ok('① 改画面中心（setLon0 不带 keepView）→ fit 并回调', zoomCalls.length === n0 + 1 && f.getView().scale === 1, `调用 ${zoomCalls.length - n0} 次`)
  f.setProjection('azeq', { lat0: 10 })
  const n1 = zoomCalls.length
  f.setZoom(0.7)
  f.setProjParams({ lat0: 40 })
  ok('① 方位等距改中心纬度：平面尺寸不变 → 不 fit、不回调', zoomCalls.length === n1 && f.getView().scale > 1.5 && /^azeq\|.*\|40$/.test(f.planeSig()), f.planeSig())
  // 宿主按 mapCrs 现算的指纹与实例回读的逐字相同（首次进 2D 比的就是这两份）
  setMapCrs({ proj: 'albers', lon0: centerToLon0(105), par1: 20, par2: 50 })
  f.setLon0(mapCrs.lon0); f.setProjection(mapCrs.proj, projOpts())
  ok('① 按 mapCrs 现算的指纹 = 实例此刻的指纹（阿尔伯斯 + 105°E + 自定标准纬线）',
    f.planeSig() === planeSigOf(mapCrs.proj, mapCrs.lon0, projOpts()), f.planeSig() + ' vs ' + planeSigOf(mapCrs.proj, mapCrs.lon0, projOpts()))
  setMapCrs(MAP_CRS_DEF)
}

// ---------- ② 环境场栅格：同一张 canvas 重提交 → 投影档重投影缓存作废 ----------
{
  const WORLD = { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }
  const env = mkCanvas(800, 400)
  const out = mkCtx()
  const draws = (src, n) => drawLog.filter((a) => a[0] === src && a.length === n).length
  const render = (o) => { drawLog.length = 0; f.exportRender(out, { view: true, ...(o || {}) }) }
  f.setImagery({ on: false })
  f.setProjection('robinson', {})
  f.setEnvRaster(env, { alpha: 1, bbox: WORLD, smooth: true })
  render()
  const baked0 = draws(env, 3)
  render()
  const hit = draws(env, 3)
  f.setEnvRaster(env, { alpha: 1, bbox: WORLD, smooth: true })   // 同一张 canvas、内容换了（换字段 / 换配色 / 换帧）
  render()
  const baked1 = draws(env, 3)
  ok('② 罗宾逊：首帧重投影烘一次、不变则命中缓存', baked0 > 0 && hit === 0, `烘 ${baked0} 三角 · 命中时 ${hit}`)
  ok('② 罗宾逊：同一张 canvas 重提交 → 重烘（换字段 / 换配色 / 时间轴换帧都靠这一条刷新）', baked1 > 0, `重提交后烘 ${baked1} 三角`)
  const id0 = env.__rpId
  f.setEnvAlpha(0.6); f.setEnvAlpha(1)
  render()
  ok('② 只改透明度不换身份、不重烘（透明度在贴图时才乘）', env.__rpId === id0 && draws(env, 3) === 0, `rpId ${id0} → ${env.__rpId}`)
  // 方位等距：源图先缩一张再逐三角贴。影像底图（整幅档）与环境场各占一个缩略图槽
  const img = mkCanvas(4096, 2048)
  f.setProjection('azeq', { lat0: 0 })
  f.setImagery({ on: true, img, set: null })
  f.setEnvRaster(env, { alpha: 1, bbox: WORLD, smooth: true })
  render({ raster: true })
  const imgThumb0 = draws(img, 5), envThumb0 = draws(env, 5)
  f.setEnvRaster(env, { alpha: 1, bbox: WORLD, smooth: true })
  render({ raster: true })
  const imgThumb1 = draws(img, 5), envThumb1 = draws(env, 5)
  ok('② 方位等距：影像与环境场各缩一张缩略图', imgThumb0 === 1 && envThumb0 === 1, `影像 ${imgThumb0} · 环境场 ${envThumb0}`)
  ok('② 方位等距：环境场重提交 → 它的缩略图重缩（旧图不再顶着）', envThumb1 === 1, `环境场 ${envThumb1}`)
  ok('② 方位等距：环境场重缩不把影像那张挤掉（影像不从原图重缩）', imgThumb1 === 0, `影像 ${imgThumb1}`)
  f.setImagery({ on: false, img: null })
  f.setEnvRaster(null)
}

// ---------- 宿主接线（ConstellationMap3D.vue）----------
{
  const lf = (t) => t.replace(/\r\n/g, '\n')
  const VUE = lf(readFileSync(join(ROOT, 'src', 'pages', 'ConstellationMap3D.vue'), 'utf8'))
  const FLAT = lf(readFileSync(join(ROOT, 'src', 'viz', 'flatmap', 'flatCoverage.js'), 'utf8'))
  const fnBody = (name) => (VUE.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}')) || [''])[0]
  ok('接线：rebuildPlane 真 fit 了才回调 onZoom', /const refit = op\.refit === true/.test(FLAT) && /if \(refit && onZoom\) onZoom\(scaleToT\(\)\)/.test(FLAT))
  ok('接线：setEnvRaster 每次提交换重投影身份', /if \(img\) img\.__rpId = \+\+rpSeq/.test(FLAT))
  ok('接线：onZoom 回调在 2D 回填缩放条、任何视图下都重记平面图视图',
    /flat\.setOnZoom\(\(t\) => \{ if \(flatView\.value\) \{ zoom\.value = t; grd\.onZoomEnd\(\) \} saveFlatView\(\) \}\)/.test(VUE))
  const sfv = fnBody('saveFlatView')
  ok('接线：平面图视图只在它按记忆恢复过之后才记（首次进 2D 的 feedFlat 里那次 fit 不冲掉存档）',
    /if \(!flat \|\| !viewRestoredFlat\) return/.test(sfv) && /savedView\.flat = flat\.getView\(\)/.test(sfv))
  ok('接线：saveView 在 2D 下走 saveFlatView', /if \(flatView\.value\) \{ saveFlatView\(\); return \}/.test(fnBody('saveView')))
  const fits = fnBody('flatViewFits')
  ok('接线：首次进 2D 指纹对得上才恢复；老存档只在出厂平面下认',
    /if \(flatViewFits\(savedView\.flat\)\) flat\.setView\(savedView\.flat\)/.test(VUE) &&
    /v\.plane === flat\.planeSig\(\)/.test(fits) && /planeSigOf\(MAP_CRS_DEF\.proj, MAP_CRS_DEF\.lon0, MAP_CRS_DEF\)/.test(fits))
  ok('接线：不 fit 的换平面（中心纬度 / 标准纬线 / 拖动调整松手 / 恢复默认）也重记视图',
    /saveFlatView\(\)/.test(fnBody('setProjLat0')) && /saveFlatView\(\)/.test(fnBody('setProjPar')) &&
    /if \(!r\.live\) saveFlatView\(\)/.test(fnBody('onFlatRotate')) && /saveFlatView\(\)/.test(VUE.match(/function resetCrs\(\) \{[^\n]*\}/)?.[0] || ''))
  ok('接线：星下点跟随换投影中心时重记视图；「跟随卫星」借走的那份不记（退出时整套还回去）',
    /if \(!_flatFollowSat\) saveFlatView\(\)/.test(fnBody('centerOnSubPt')))
  ok('接线：关软件 / 离开本页时挂着的视图记忆立刻落盘',
    /window\.addEventListener\('beforeunload', flushViewSave\)/.test(VUE) && /window\.removeEventListener\('beforeunload', flushViewSave\)\n\s*flushViewSave\(\)/.test(VUE))
}

console.log('\nflatPlaneChange: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)   // 平面渲染器起了几个空闲定时器（量刷新周期 / 预热 110m），不等它们
