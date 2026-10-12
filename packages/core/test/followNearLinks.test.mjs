// 跟随卫星视角与 3D 视图一致（2026-10-08 用户：跟随视角里链路不显示、别的聚焦星没有模型）：
//  ① zoomScale 跟随档：缩放联动距离 = 3 / 0.55（星点 / 标记）；点层系数 0.55；模型图标系数 1；scene.zoomDist 取它不写死
//  ② 链路材质：近场档（occ / cut）开 LINK_OCC、不吃色调映射；缺省档逐项不变；终点在地球背后不画箭头（按终点本身判）
//  ③ 链路载荷：卫星终点带身份键（scene 认它画没画模型图标）；每跳带起点身份 s（近场线芯从起点符号外沿起画）
//  ④ 模型层近场链路：终点是主星本体的段（tip.z = 3）终点挪到「起点射向原点先撞上的本体外包盒面」；端点落在邻星旁的钉到邻星的
//     局部位置、箭头让邻星此刻的屏上半径（逐帧）；局部相机 far 够到最远端点
//  ⑤ 跟随中别的聚焦星照画模型图标，直径 = 图标像素 × 跟随档系数（不按相机离地心 1.0x 个地球半径放大三倍）
//  ⑥ 页面接线（源码钉）：锚点先于本拍各路几何给场景；链路的星先认聚焦集条目；图标表剔主星与邻星；scene.destroy 不再引用已删的 linkArrowTex
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const THREE = await import('three')
const { LineSegments2 } = await import('three/addons/lines/LineSegments2.js')
const { LineSegmentsGeometry } = await import('three/addons/lines/LineSegmentsGeometry.js')
const Z = await import(SRC + 'viz/globe3d/zoomScale.js')
const ML = await import(SRC + 'viz/globe3d/modelLayer.js')
const LM = await import(SRC + 'viz/globe3d/linkLineMaterial.js')
const { llaToVec } = await import(SRC + 'viz/globe3d/focusLanes.js')
const sat = (await import(SRC + 'viz/constellation/satellite.js')).default
const { posAt } = await import(SRC + 'viz/constellation/satPos.js')
const { Q_BODY2L_NADIR } = await import(CORE + 'models/attitude.mjs')
const { ref } = await import('vue')
const { useMapLinks } = await import(SRC + 'viz/links/useMapLinks.js')

// 假 document：邻星圆点 / 名字标签 / HUD 要一块能画的 canvas（只量字宽，不真画）
if (!globalThis.document) {
  const ctx2d = () => ({ font: '', textBaseline: '', lineJoin: '', strokeStyle: '', lineWidth: 0, fillStyle: '', measureText: (s) => ({ width: String(s).length * 48 * 0.6 }),
    strokeText() {}, fillText() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, rect() {}, roundRect() {}, scale() {}, translate() {}, rotate() {},
    createRadialGradient: () => ({ addColorStop() {} }) })
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: ctx2d }) }
}

let n = 0
const t = async (name, fn) => { try { await fn() } catch (e) { console.error('FAIL ' + name); throw e } n++ }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} ≠ ${b}`)
// 源码钉按 LF 写正则：core.autocrlf=true 的检出（3D 页、scene.js 在工作树里就是 CRLF）先统一成 LF 再比
const src = (p) => readFileSync(path.resolve(HERE, '../../../src', p), 'utf8').replace(/\r\n/g, '\n')
const RE_M = 6371000

await t('① zoomScale 跟随档：距离 3 / 0.55、点层 0.55、图标 1；scene.zoomDist 取自 zoomScale', () => {
  near(Z.FOLLOW_ZOOM_DIST, 3 / 0.55, 1e-12, '跟随档距离')
  near(Z.FOLLOW_POINT_K, Z.pointZoomK(3 / 0.55), 1e-15, '点层系数')
  near(Z.FOLLOW_POINT_K, 0.55, 1e-12, '点层 0.55')
  assert.equal(Z.FOLLOW_ICON_K, 1)
  const s = src('viz/globe3d/scene.js')
  assert.match(s, /function zoomDist\(\) \{ return followDriver \? FOLLOW_ZOOM_DIST : /)
  assert.doesNotMatch(s, /LABEL_REF_DIST \/ 0\.55/, '不许再写死 0.55')
})

await t('② 链路材质：缺省档逐项不变；近场档 LINK_OCC / cut / 不吃色调映射；终点在地球背后不画箭头', () => {
  const m0 = LM.createLinkLineMaterial({ color: '#ffb547', core: 0.6, arrow: true })
  assert.ok(!('LINK_OCC' in (m0.defines || {})), '缺省档不开 LINK_OCC')
  assert.equal(m0.uniforms.uCut.value, 0)
  assert.equal(m0.uniforms.uIconK.value, 1)
  assert.equal(m0.toneMapped, true)
  const m1 = LM.createLinkLineMaterial({ color: '#ffb547', core: 0.6, arrow: true, occ: true, cut: true })
  assert.ok('LINK_OCC' in m1.defines)
  assert.equal(m1.uniforms.uCut.value, 1)
  assert.ok(m1.uniforms.uOcc.value.isVector4)
  assert.equal(m1.toneMapped, false, '局部那一趟开着 ACES：近场链路不吃它')
  const vs = m1.vertexShader, fs = m1.fragmentShader
  // 箭头按终点本身判遮挡（逐片元判不出：跟随时箭头像素按透视映回线段上离相机很近的点）
  assert.match(vs, /if \( vTip > 0\.0 && ! endCut && linkOccluded\( end\.xyz \) \) vTip = - 1\.0;/)
  // 终点符号圆口径：z = 2 走 uIconK，z = 3（主星本体）屏幕恒定
  assert.match(vs, /instanceTip\.z > 2\.5 \? 1\.0 : \( instanceTip\.z > 1\.5 \? uIconK : \( instanceTip\.z > 0\.5 \? uZoomK : 1\.0 \) \)/)
  assert.match(fs, /if \( uCut > 0\.5 && vEdge > 0\.0 \) core \*= clamp\( vEdge - along \+ 0\.5, 0\.0, 1\.0 \);/)
  assert.match(fs, /if \( uCut > 0\.5 && vStart > 0\.0 \) core \*= clamp\( along - vStart \+ 0\.5, 0\.0, 1\.0 \);/)
  assert.match(fs, /if \( s1 > 0\.0 && s1 < pl \) discard;/)
})

await t('③ 链路载荷：卫星终点带身份键、每跳带起点身份', () => {
  const R_GEO = 42164.17, LON = 115.5 * Math.PI / 180
  const host = {
    links: ref([{ id: 'L', name: '', nameAuto: true, nodes: [{ k: 'st', id: 'hub' }, { k: 'sat', key: 'norad:1', name: 'S1' }, { k: 'st', id: 'hub2' }] }]),
    stations: ref([{ id: 'hub', name: '北京站', lat: 40, lon: 116.4 }, { id: 'hub2', name: '广州站', lat: 23.1, lon: 113.3 }]),
    points: ref([]), polygons: ref([]), trajectories: ref([]),
    trajShown: () => false, nowMs: () => 0, newId: () => 'x', commit: () => {},
    satEcefAt: (key) => (key === 'norad:1' ? [R_GEO * Math.cos(LON), R_GEO * Math.sin(LON), 0] : null),
    satInfo: () => null, status: () => {}
  }
  const L = useMapLinks(host)
  const r = L.compute(0)
  const hs = r.scene[0].hops
  assert.equal(hs.length, 2)
  assert.deepEqual(hs[0].e, { k: 'sat', key: 'norad:1' }, '上行：终点是星、带身份键')
  assert.deepEqual(hs[0].s, { k: 'st', id: 'hub' }, '上行：起点是站')
  assert.deepEqual(hs[1].s, { k: 'sat', key: 'norad:1' }, '下行：起点是星')
  assert.deepEqual(hs[1].e, { k: 'st', id: 'hub2' })
})

// 一颗低轨星的跟随状态（与页面 followPrep 同一份 satStateAt 算式）
const ISS = sat.twoline2satrec('1 25544U 98067A   26265.47000000  .00016717  00000+0  30000-3 0  9990', '2 25544  51.6300 180.2400 0004800 167.1100 193.0000 15.49050000400000')
const T0 = Date.UTC(2026, 8, 24, 4, 0, 0)
const d0 = new Date(T0), g0 = sat.gstime(d0)
const sun = ML.sunStateAt(d0)
const st = ML.satStateAt(posAt(ISS, d0), g0, sun.sunE)
const qL2S = new THREE.Quaternion(st.qL2S[0], st.qL2S[1], st.qL2S[2], st.qL2S[3]).normalize()
const qS2L = qL2S.clone().invert()
const qB2L = new THREE.Quaternion(Q_BODY2L_NADIR[0], Q_BODY2L_NADIR[1], Q_BODY2L_NADIR[2], Q_BODY2L_NADIR[3])
const toScene = (vL) => new THREE.Vector3(vL[0], vL[1], vL[2]).applyQuaternion(qL2S).multiplyScalar(1 / RE_M)   // L 系米 → 场景单位（相对锚点）
const toL = (v) => v.clone().multiplyScalar(RE_M).applyQuaternion(qS2L)
const NB_REL = [20000, 3000, -1000]   // 邻星：主星 L 系里 20 km 外
const followState = () => ({ key: 'iss', modelId: 'ent:vsat-1p2', anchor: st.anchor, qL2S: st.qL2S, qB2L: Q_BODY2L_NADIR, velL: [1, 0, 0], eclipse: 1, altKm: st.altKm,
  others: [{ key: 'nb', modelId: null, relL: NB_REL, name: 'NB' }], near: null })

await t('④ 近场链路：终点挪到本体外包盒面；端点钉到邻星、箭头让邻星屏上半径；局部相机 far 够到最远端点', async () => {
  const L = ML.createModelLayer({})
  L.follow(followState())
  // 两段：远处 2000 km（沿迹前方偏上）→ 主星本体；主星 → 邻星（链路按大地经纬高落点，与邻星真位置差 0.5%）
  const T = toScene([2.0e6, 1.5e5, -4.0e5])
  const NBs = toScene(NB_REL).multiplyScalar(1.005)
  const geo = new LineSegmentsGeometry()
  geo.setPositions([T.x, T.y, T.z, 0, 0, 0, 0, 0, 0, NBs.x, NBs.y, NBs.z])
  geo.setAttribute('instanceTip', new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 3, 1, 0, 14, 2, 1]), 4))
  geo.setAttribute('instanceTip0', new THREE.InstancedBufferAttribute(new Float32Array([0, 7, 1, 1, 0, 0, 0, 0]), 4))
  const g = new THREE.Group(); g.add(new LineSegments2(geo, LM.createLinkLineMaterial({ occ: true, cut: true, arrow: true })))
  L.overlay.setNearLinks(g)
  assert.equal(L.stats().nearLinkSegs, 2)
  // 等主星模型挂上（node 里没有渲染器，模型层最多等 0.5 s）
  const t0 = Date.now()
  while (!L.stats().followBox) { assert.ok(Date.now() - t0 < 10000, '主星模型 10 s 内没挂上'); await new Promise((r) => setTimeout(r, 50)) }
  const box = L.stats().followBox
  const P = geo.attributes.instanceStart.data.array
  // 段 0 终点：本体系落在外包盒面上，且在「起点 → 原点」这条线上
  const eL = toL(new THREE.Vector3(P[3], P[4], P[5]))
  const eB = eL.clone().applyQuaternion(qB2L.clone().invert())
  const inBox = [0, 1, 2].every((k) => eB.getComponent(k) >= box.min[k] - 1e-4 && eB.getComponent(k) <= box.max[k] + 1e-4)
  const onFace = [0, 1, 2].some((k) => Math.abs(eB.getComponent(k) - box.min[k]) < 1e-4 || Math.abs(eB.getComponent(k) - box.max[k]) < 1e-4)
  assert.ok(inBox && onFace, `终点不在外包盒面上：${eB.toArray()} / ${JSON.stringify(box)}`)
  const sL = toL(T)
  assert.ok(eL.clone().cross(sL).length() / (eL.length() * sL.length()) < 1e-6, '终点不在起点 → 原点那条线上')
  assert.ok(eL.length() > 0.05 && eL.length() < 3, `终点离本体中心 ${eL.length()} m`)
  // 段 1 终点：钉到邻星的局部位置（真 ECEF 差）
  const nL = toL(new THREE.Vector3(P[9], P[10], P[11]))
  near(nL.distanceTo(new THREE.Vector3(...NB_REL)), 0, 1e-3, '邻星端点钉到邻星局部位置（m）')
  // 逐帧：箭头让邻星此刻的屏上半径（邻星没模型 → 圆点 6 px → 半径 3，屏幕恒定口径）；局部相机 far 够到 2000 km 外的起点
  const cam = new THREE.PerspectiveCamera(42, 1600 / 900, 0.1, 120)
  const drv = L.followDriver()
  drv.apply(cam, 0)
  L.overlay.update(0.016, cam, 1600, 900)
  const Tp = geo.attributes.instanceTip.array
  assert.deepEqual([Tp[4], Tp[5], Tp[6]], [0, 3, 0], '邻星终点的箭头让圆点半径')
  assert.deepEqual(Array.from(Tp.slice(0, 4)), [0, 0, 3, 1], '本体终点 tip 不动（模型在 → 半径 0、口径 3）')
  assert.ok(L._localCamera().far >= sL.length(), `局部相机 far ${L._localCamera().far} < 端点距离 ${sL.length()}`)
  // 换下近场链路：组摘掉、段数归零
  L.overlay.setNearLinks(null)
  assert.equal(L.stats().nearLinkSegs, 0)
  assert.equal(g.parent, null)
  L.dispose()
})

await t('⑤ 跟随中别的聚焦星照画模型图标：直径 = 图标像素 × FOLLOW_ICON_K；不跟随时按相机离地心距离', async () => {
  const L = ML.createModelLayer({})
  L.setIconStyle({ on: true, px: 30 })
  // 另一颗聚焦星：主星沿迹前方 1000 km
  const o = toScene([1.0e6, 0, 0]).add(new THREE.Vector3(...st.anchor))
  const ico = { key: 'far', modelId: 'ent:vsat-1p2', px: 30, anchor: [o.x, o.y, o.z], qL2S: st.qL2S, altKm: st.altKm, eclipse: 1 }
  L.follow(followState())
  const cam = new THREE.PerspectiveCamera(42, 1600 / 900, 0.1, 120)
  const drv = L.followDriver()
  const sizes = () => { L.setIcons([ico]); for (let i = 0; i < 12; i++) { drv.apply(cam, 0.05); L.overlay.update(0.05, cam, 1600, 900) } return Object.fromEntries(L.stats().iconsPx) }
  const t0 = Date.now()
  while (!sizes().far) { assert.ok(Date.now() - t0 < 10000, '图标 10 s 内没就绪'); await new Promise((r) => setTimeout(r, 50)) }
  near(sizes().far, 30 * Z.FOLLOW_ICON_K, 0.011, '跟随中图标直径')
  const D = cam.position.length()
  assert.ok(Math.abs(Z.pointZoomK(D) - Z.FOLLOW_ICON_K) > 1, `反证：照原式（D = ${D.toFixed(3)}）会是 ${Z.pointZoomK(D)} 倍`)
  // 退出跟随：回到按相机离地心距离
  L.follow(null)
  const c2 = new THREE.PerspectiveCamera(42, 1600 / 900, 0.1, 120)
  c2.position.copy(o.clone().normalize().multiplyScalar(4)); c2.lookAt(0, 0, 0); c2.updateMatrixWorld(true)
  L.setIcons([ico]); for (let i = 0; i < 12; i++) L.overlay.update(0.05, c2, 1600, 900)
  near(Object.fromEntries(L.stats().iconsPx).far, 30 * Z.pointZoomK(4), 0.011, '不跟随：按相机距离')
  L.dispose()
})

await t('⑥ 页面接线（源码钉）', () => {
  const pg = src('pages/ConstellationMap3D.vue')
  // 锚点先于本拍各路几何（聚焦几何 / 链路）给场景
  const iA = pg.indexOf('scene.setFollowAnchor(fo ? fo.st.anchor : null)')
  const iC = pg.indexOf('commitGeometry()', iA), iL = pg.indexOf('pushLinks()        // 图上链路随时钟', iA)
  assert.ok(iA > 0 && iC > iA && iL > iA, '刷新拍里 setFollowAnchor 要在 commitGeometry / pushLinks 之前')
  // 链路的星先认聚焦集条目（全量池换版后选中集仍指着旧条目，两版星历差十几公里）；缓存随池换版作废
  assert.match(pg, /function linkSatEntry\(key\) \{\n  if \(!key\) return null\n  const se = selEntryByKey\(key\)\n  if \(se\) return se\n  if \(_lnkSatSrc !== renderEntries \|\| _lnkSatPool !== poolTick\.value\)/)
  // 图标表：跟随中照画，剔主星与局部那一趟的邻星
  assert.match(pg, /const iconFeedOn = \(\) => !!\(modelLayer && !flatView\.value && focusStyle\.modelOn && selEntries\.length\)/)
  assert.match(pg, /if \(fs && e === followEntry\) continue/)
  assert.match(pg, /if \(local && local\.has\(key\)\) continue/)
  // scene.destroy：已删的 linkArrowTex 不再引用（原来卸载时抛 ReferenceError，后面的释放 / 摘画布 / 停 rAF 全没跑）
  const sc = src('viz/globe3d/scene.js')
  assert.doesNotMatch(sc, /if \(linkArrowTex\)|linkArrowTex\.dispose|linkArrowTex = /)
  assert.match(sc, /setLinks\(null\); if \(linkRingTex\) \{ linkRingTex\.dispose\(\); linkRingTex = null \}/)
})

console.log(`followNearLinks: ${n} 项通过`)
