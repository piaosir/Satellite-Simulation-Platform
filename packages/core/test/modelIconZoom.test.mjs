// 3D 球上模型图标「随缩放联动」的口径（src/viz/globe3d/zoomScale.js；modelLayer 卫星图标 / entityLayer 实体图标 / scene 标记与星点层同一把尺）：
//   ① zoomScale：基准视距 3（出厂开场机位）、markerZoomK 不夹、pointZoomK 夹在 0.35 … 6
//   ② scene.js 不再自己写死基准视距：LABEL_REF_DIST 取自 zoomScale、贴图点层系数走 pointZoomK（防两处各改各的又分叉）
//   ③ 卫星模型图标（modelLayer）：屏幕直径 = px × pointZoomK(相机距离)；D = 3 即设定像素；逐星 px 覆盖全局、没给按全局；
//      反证：原「屏幕恒定」口径下 D = 2 与 D = 6 一样大，这里必须差 3 倍
// 实体图标的同一口径在 modelEntityLayer.test.mjs ④（投影直径逐像素量）。画面在真 Electron 里看，这里不重复。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const THREE = await import('three')
const Z = await import(SRC + 'globe3d/zoomScale.js')
const ML = await import(SRC + 'globe3d/modelLayer.js')
const { llaToVec } = await import(SRC + 'globe3d/focusLanes.js')

let n = 0
const t = async (name, fn) => { try { await fn() } catch (e) { console.error('FAIL ' + name); throw e } n++ }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} ≠ ${b}`)

await t('① zoomScale：基准视距 3；markerZoomK 不夹；pointZoomK 夹在 0.35 … 6', () => {
  assert.equal(Z.ZOOM_REF_DIST, 3)
  near(Z.markerZoomK(3), 1, 1e-15, 'marker D=3')
  near(Z.markerZoomK(1.5), 2, 1e-15, 'marker D=1.5')
  near(Z.markerZoomK(30), 0.1, 1e-15, 'marker D=30（不夹）')
  near(Z.pointZoomK(3), 1, 1e-15, 'point D=3')
  near(Z.pointZoomK(6), 0.5, 1e-15, 'point D=6')
  assert.equal(Z.pointZoomK(30), 0.35, 'point 远处夹到 0.35')
  assert.equal(Z.pointZoomK(0.1), 6, 'point 近处夹到 6')
  assert.ok(Number.isFinite(Z.markerZoomK(0)) && Number.isFinite(Z.pointZoomK(0)), '距离 0 不出 Infinity / NaN')
})

await t('② scene.js 的基准视距与点层系数取自 zoomScale（单一真值源）', () => {
  const src = readFileSync(path.resolve(HERE, '../../../src/viz/globe3d/scene.js'), 'utf8')
  assert.match(src, /import\s*\{[^}]*\bZOOM_REF_DIST\b[^}]*\}\s*from\s*'\.\/zoomScale\.js'/)
  assert.match(src, /const LABEL_REF_DIST = ZOOM_REF_DIST\b/)
  assert.doesNotMatch(src, /const LABEL_REF_DIST = \d/, '不许再写死数字')
  assert.match(src, /const k = pointZoomK\(zoomDist\(\)\)/)
})

await t('③ 卫星模型图标：直径 = px × pointZoomK(D)；D = 3 即设定像素；逐星 px 覆盖全局；反证：D = 2 / 6 差 3 倍', async () => {
  const L = ML.createModelLayer({})
  const a = llaToVec(20, 110, 800)
  const anchor = [a.x, a.y, a.z]
  const ico = (key, px) => ({ key, modelId: 'ent:vsat-1p2', px, anchor, qL2S: [0, 0, 0, 1], altKm: 800, eclipse: 1 })
  L.setIconStyle({ on: true, px: 30 })
  L.setIcons([ico('own', 40), ico('glob', undefined)])
  const camAt = (D) => {
    const c = new THREE.PerspectiveCamera(42, 1600 / 900, 0.01, 100)
    c.position.copy(a.clone().normalize().multiplyScalar(D)); c.lookAt(0, 0, 0); c.updateMatrixWorld(true)
    return c
  }
  const sizes = (D) => {
    const c = camAt(D)
    for (let i = 0; i < 12; i++) L.overlay.update(0.05, c, 1600, 900)   // 淡入 0.3 s 走完
    return Object.fromEntries(L.stats().iconsPx)
  }
  // 模型现生成 + 等渲染器（node 里没有，模型层最多等 0.5 s）：轮询到两颗都在画
  const t0 = Date.now()
  while (Object.keys(sizes(3)).length < 2) {
    assert.ok(Date.now() - t0 < 10000, '图标 10 s 内没就绪')
    await new Promise((r) => setTimeout(r, 50))
  }
  const got = {}
  for (const D of [2, 3, 6, 20]) {
    const s = sizes(D)
    const k = Z.pointZoomK(D)
    near(s.own, 40 * k, 0.011, `逐星 px=40，D=${D}`)
    near(s.glob, 30 * k, 0.011, `跟全局 px=30，D=${D}`)
    got[D] = s.own
  }
  near(got[3], 40, 0.011, '默认视角（D = 3）= 设定像素')
  near(got[2] / got[6], 3, 1e-3, '反证：D=2 / D=6 直径比')
  near(got[20], 40 * 0.35, 0.011, '拉到很远夹在 0.35 倍（与聚焦星点层同口径）')
  // 全局改了（页面改样式后当场重喂一拍 setIcons）：没覆盖的那颗跟着变，覆盖的不动
  L.setIconStyle({ px: 60 })
  L.setIcons([ico('own', 40), ico('glob', undefined)])
  const s = sizes(3)
  near(s.glob, 60, 0.011, '全局改 60')
  near(s.own, 40, 0.011, '逐星覆盖不随全局')
  L.dispose()
})

console.log(`modelIconZoom: ${n} 项通过`)
