import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import earcut from 'earcut'
import { feature } from 'topojson-client'
import topo from './data/countries-10m.json'
import NAMES from './data/country-names-zh.json'
import { CHINA_IDS, NO_LABEL_IDS } from './cnClaims.js'

const RE = 6371

function llaToVec(latDeg, lonDeg, altKm) {
  const r = (RE + altKm) / RE
  const phi = (90 - latDeg) * Math.PI / 180
  const theta = (lonDeg + 180) * Math.PI / 180
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  )
}

const LAND = ['#8fa89b', '#b0a98f', '#9fb0c0', '#c0a99f', '#a9b08f', '#9f9fb0', '#b8a0a0', '#90b0a8', '#b0b090', '#a0a8b8', '#bca890', '#98a0a8']
const OCEAN = '#15426b'
const CHINA = '#b85a52'   // 中国底色：降低饱和度的砖红（原 #c62f2f 太炸眼）
const ICE = '#edf2f6'     // 极地冰盖：白色填充（格陵兰 304、南极 010）
const ICE_IDS = new Set(['304', '010'])
// 北极冰盖：高纬陆地（加拿大北部、俄罗斯北部、北极群岛等）随纬度渐变染白，
// 北极圈附近(EDGE)起淡入、FULL 以北全白；只染陆地，北冰洋保持海色。
const ICE_LAT_EDGE = 66.5, ICE_LAT_FULL = 75
// 南极极冠：数据集南极洲只到约 -85°，极点处留有圆形空洞，补一块极冠盖到 -90°。
const SOUTH_CAP_LAT = -82

function centroidLonLat(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates
  let best = null, bestLen = -1
  for (const rings of polys) { const r = rings[0]; if (r && r.length > bestLen) { bestLen = r.length; best = r } }
  if (!best) return null
  let sx = 0, sy = 0
  for (const p of best) { sx += p[0]; sy += p[1] }
  return [sx / best.length, sy / best.length]
}

// 经度解缠：让环内相邻点经度差不超过 180°（消除跨 ±180° 的跳变），再整体平移到 [-180,180) 附近。
// 不解缠的话，斐济/俄罗斯/南极洲等跨反子午线的多边形会在等距圆柱纹理里横向拉成长条。
function unwrapRing(ring) {
  const out = new Array(ring.length)
  let prev = ring[0][0]
  out[0] = [prev, ring[0][1]]
  for (let i = 1; i < ring.length; i++) {
    let lon = ring[i][0]
    while (lon - prev > 180) lon -= 360
    while (lon - prev < -180) lon += 360
    out[i] = [lon, ring[i][1]]
    prev = lon
  }
  let s = 0; for (const p of out) s += p[0]
  const shift = -360 * Math.round((s / out.length) / 360)
  if (shift) for (const p of out) p[0] += shift
  return out
}

// 陆地填色：矢量几何（earcut 三角化 + 投影到球面），任何缩放级别都无限锐利、零虚化。
// 大三角形投影后会塌陷成弦切入球内，故按经纬度自适应细分到 ≤MAXSEG° 再投影，紧贴球面。
function buildLandMesh(features) {
  const MAXSEG = 3            // 三角形最长边超过该度数就细分
  const positions = [], colors = []
  const col = new THREE.Color()
  const ICE_COL = new THREE.Color(ICE), _tmpCol = new THREE.Color()

  function pushVert(lon, lat) {
    const v = llaToVec(lat, lon, 0)   // 半径 1，贴在海洋球(0.999)之上
    positions.push(v.x, v.y, v.z)
    // 高纬度顶点向冰色渐变（北极圈以北逐渐染白）；细分后顶点稠密，渐变边自然柔和。
    let c = col
    if (lat > ICE_LAT_EDGE) {
      const t = lat >= ICE_LAT_FULL ? 1 : (lat - ICE_LAT_EDGE) / (ICE_LAT_FULL - ICE_LAT_EDGE)
      c = _tmpCol.copy(col).lerp(ICE_COL, t)
    }
    colors.push(c.r, c.g, c.b)
  }
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1])
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
  // 细分到每条边 ≤MAXSEG° 再投影。关键：是否切分由「边自身长度」决定（而非三角形），
  // 相邻三角形共享边的端点/长度完全相同 -> 切分点一致 -> 无 T 形接缝（裂纹）。
  function emitTri(a, b, c, depth) {
    const sAB = dist(a, b) > MAXSEG, sBC = dist(b, c) > MAXSEG, sCA = dist(c, a) > MAXSEG
    const n = (sAB ? 1 : 0) + (sBC ? 1 : 0) + (sCA ? 1 : 0)
    if (n === 0 || depth >= 14) { pushVert(a[0], a[1]); pushVert(b[0], b[1]); pushVert(c[0], c[1]); return }
    const d = depth + 1
    if (n === 3) {
      const mAB = mid(a, b), mBC = mid(b, c), mCA = mid(c, a)
      emitTri(a, mAB, mCA, d); emitTri(mAB, b, mBC, d); emitTri(mCA, mBC, c, d); emitTri(mAB, mBC, mCA, d)
      return
    }
    if (n === 1) {
      if (sAB) { const m = mid(a, b); emitTri(a, m, c, d); emitTri(m, b, c, d) }
      else if (sBC) { const m = mid(b, c); emitTri(b, m, a, d); emitTri(m, c, a, d) }
      else { const m = mid(c, a); emitTri(c, m, b, d); emitTri(m, a, b, d) }
      return
    }
    // n === 2：切两条边，分成 3 个三角形，未切的那条边保持整段
    if (!sCA) { const m1 = mid(a, b), m2 = mid(b, c); emitTri(a, m1, m2, d); emitTri(a, m2, c, d); emitTri(m1, b, m2, d) }
    else if (!sAB) { const m1 = mid(b, c), m2 = mid(c, a); emitTri(b, m1, m2, d); emitTri(b, m2, a, d); emitTri(m1, c, m2, d) }
    else { const m1 = mid(c, a), m2 = mid(a, b); emitTri(c, m1, m2, d); emitTri(c, m2, b, d); emitTri(m1, a, m2, d) }
  }
  // 三角化一个多边形（rings = [外环, 洞...]），先解缠并把洞对齐到外环窗口
  function addPolygon(rings) {
    const uw = rings.map(unwrapRing)
    const meanLon = (r) => { let s = 0; for (const p of r) s += p[0]; return s / r.length }
    const om = meanLon(uw[0])
    for (let i = 1; i < uw.length; i++) {
      const k = Math.round((om - meanLon(uw[i])) / 360)
      if (k) for (const p of uw[i]) p[0] += k * 360
    }
    const flat = [], holeIdx = []
    for (let r = 0; r < uw.length; r++) {
      if (r > 0) holeIdx.push(flat.length / 2)
      for (const p of uw[r]) { flat.push(p[0], p[1]) }
    }
    const tri = earcut(flat, holeIdx)
    for (let t = 0; t < tri.length; t += 3) {
      const i0 = tri[t] * 2, i1 = tri[t + 1] * 2, i2 = tri[t + 2] * 2
      emitTri([flat[i0], flat[i0 + 1]], [flat[i1], flat[i1 + 1]], [flat[i2], flat[i2 + 1]], 0)
    }
  }

  features.forEach((f, idx) => {
    const g = f.geometry
    if (!g) return
    const id = String(f.id)
    col.set(CHINA_IDS.has(id) ? CHINA : ICE_IDS.has(id) ? ICE : LAND[idx % LAND.length])
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    for (const rings of polys) addPolygon(rings)
  })

  // 南极极冠：南极洲多边形止于约 -85°，极点附近留有圆形空洞。用一圈贴极点的四边形
  // （每经度两点共塌缩到极点）补齐到 -90°，emitTri 自带细分贴球；南极洲本就 ICE 白，无缝。
  col.copy(ICE_COL)
  for (let lon = -180; lon < 180; lon += 3) {
    const a = [lon, -90], b = [lon, SOUTH_CAP_LAT], c = [lon + 3, SOUTH_CAP_LAT], d = [lon + 3, -90]
    emitTri(a, b, c, 0); emitTri(a, c, d, 0)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }))
}

function makeLabelSprite(text, hpx, fill) {
  const pad = 8, fs = 54   // 高分辨率纹理：放大后文字更锐利
  const c = document.createElement('canvas')
  let cx = c.getContext('2d')
  cx.font = `${fs}px "Microsoft YaHei", sans-serif`
  const w = Math.ceil(cx.measureText(text).width) + pad * 2
  c.width = w; c.height = fs + pad * 2
  cx = c.getContext('2d')
  cx.font = `${fs}px "Microsoft YaHei", sans-serif`
  cx.textBaseline = 'middle'; cx.textAlign = 'center'
  cx.lineJoin = 'round'; cx.miterLimit = 2
  cx.lineWidth = 4; cx.strokeStyle = 'rgba(0,0,0,0.8)'
  cx.strokeText(text, c.width / 2, c.height / 2)
  cx.fillStyle = fill || '#eef2f6'; cx.fillText(text, c.width / 2, c.height / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  // depthTest 关：正面标签始终完整显示，不被球面裁切；背面由每帧半球剔除隐藏
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true }))
  spr.scale.set((c.width / c.height) * hpx, hpx, 1)
  spr._base = spr.scale.clone()   // 基准尺寸（供地名字号缩放）
  spr.renderOrder = 10
  return spr
}

// 国家「视觉大小」近似：最大环的经纬包围盒线度（按纬度余弦修正）。用来按国家大小定标签字号——
// 大国字大、欧洲那种小国字小，全部显示也不会糊成一片。
function featureExtent(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates
  let best = null, bl = -1
  for (const rings of polys) { const r = rings[0]; if (r && r.length > bl) { bl = r.length; best = r } }
  if (!best) return 0
  let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90
  for (const p of best) { if (p[0] < minLon) minLon = p[0]; if (p[0] > maxLon) maxLon = p[0]; if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1] }
  const cl = Math.max(Math.cos((minLat + maxLat) / 2 * Math.PI / 180), 0.1)
  return Math.sqrt((maxLon - minLon) * cl * (maxLat - minLat))  // ~ 线度(度)
}

function buildLabels(features, lang) {
  const group = new THREE.Group()
  group.visible = false
  const seen = new Set()   // 同一国家 id 只标一次（topojson 中澳大利亚等含本体+外岛多个 feature）
  for (const f of features) {
    const id = String(f.id)
    if (NO_LABEL_IDS.has(id) || seen.has(id)) continue
    const rec = NAMES[id]
    let zh = rec ? rec[0] : null
    if (id === '156') zh = '中国'
    if (id === '408') zh = '朝鲜'
    if (id === '410') zh = '韩国'
    if (!zh) continue   // 仅标注有中文名的国家（中/英两套用同一集合与位置）
    let lon = rec && rec[1] != null ? rec[1] : null
    let lat = rec && rec[2] != null ? rec[2] : null
    if (lon == null || lat == null) { const c = centroidLonLat(f.geometry); if (!c) continue; lon = c[0]; lat = c[1] }
    const en = (f.properties && f.properties.name) || zh   // 英文名取自 topojson
    const name = lang === 'en' ? en : zh
    // 字号随国家线度：小国（如欧洲诸国）更小，大国更大；夹在 [0.016, 0.030]
    const ext = featureExtent(f.geometry)
    const hpx = Math.max(0.016, Math.min(0.030, 0.012 + ext * 0.0016))
    const spr = makeLabelSprite(name, hpx)
    spr.position.copy(llaToVec(lat, lon, 25))
    spr._dir = spr.position.clone().normalize()
    group.add(spr); seen.add(id)
  }
  return group
}

// 把各国多边形的所有环转成线段几何（贴在略高于球面处），作为「矢量轮廓」。
// 纹理里的描边在放大后会糊；矢量线在任何缩放级别都保持锐利。
// 距离抽稀：10m 海岸线点距 ~1km，远超所需；按 ~2.5km 抽稀，段数减半以上而肉眼无差。
function decimateRing(ring, minD) {
  if (ring.length < 3) return ring
  const out = [ring[0]]; let last = ring[0]
  for (let i = 1; i < ring.length - 1; i++) {
    const p = ring[i]
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= minD) { out.push(p); last = p }
  }
  out.push(ring[ring.length - 1])
  return out
}
function buildBorders(features) {
  const pos = []
  for (const f of features) {
    const g = f.geometry
    if (!g) continue
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    for (const rings of polys) {
      for (const ring0 of rings) {
        const ring = decimateRing(ring0, 0.025)
        for (let i = 0; i + 1 < ring.length; i++) {
          // 抬高 0.04%（标准深度可分辨，视差仍小到看不出；depthWrite=false 保证不与填色 z-fight）
          const a = llaToVec(ring[i][1], ring[i][0], 0).multiplyScalar(1.0004)
          const b = llaToVec(ring[i + 1][1], ring[i + 1][0], 0).multiplyScalar(1.0004)
          pos.push(a.x, a.y, a.z, b.x, b.y, b.z)
        }
      }
    }
  }
  return pos   // 段端点坐标对，交给 fatSegments 画成可控宽度的粗线
}

// 矢量经纬网坐标（半径略低于国界线，使国界压在网格之上）
function buildGraticule() {
  const pos = []
  const push = (lat, lon) => { const v = llaToVec(lat, lon, 0).multiplyScalar(1.0003); pos.push(v.x, v.y, v.z) }
  for (let lat = -75; lat <= 75; lat += 15) {
    for (let lon = -180; lon < 180; lon += 3) { push(lat, lon); push(lat, lon + 3) }
  }
  for (let lon = -180; lon < 180; lon += 15) {
    for (let lat = -87; lat < 87; lat += 3) { push(lat, lon); push(lat + 3, lon) }
  }
  return pos
}

// 大洋标记：斜体浅蓝、半透明，区别于国家名
function makeOceanLabel(text) {
  const pad = 10, fs = 40
  const c = document.createElement('canvas')
  let cx = c.getContext('2d')
  const font = `italic ${fs}px "Microsoft YaHei", sans-serif`
  cx.font = font
  const w = Math.ceil(cx.measureText(text).width) + pad * 2
  c.width = w; c.height = fs + pad * 2
  cx = c.getContext('2d')
  cx.font = font
  cx.textBaseline = 'middle'; cx.textAlign = 'center'
  cx.lineJoin = 'round'; cx.miterLimit = 2
  cx.lineWidth = 4; cx.strokeStyle = 'rgba(0,0,0,0.55)'
  cx.strokeText(text, c.width / 2, c.height / 2)
  cx.fillStyle = 'rgba(150,195,230,0.92)'; cx.fillText(text, c.width / 2, c.height / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true }))
  const hpx = 0.034
  spr.scale.set((c.width / c.height) * hpx, hpx, 1)
  spr._base = spr.scale.clone()
  spr.renderOrder = 9
  return spr
}

// 几大洋（[中文, 英文, 经度, 纬度]）；太平洋/大西洋面积大，分东西两处各标一次
const OCEANS = [
  ['太平洋', 'Pacific Ocean', -150, 5], ['太平洋', 'Pacific Ocean', 175, -10],
  ['大西洋', 'Atlantic Ocean', -35, 28], ['大西洋', 'Atlantic Ocean', -18, -25],
  ['印度洋', 'Indian Ocean', 78, -28],
  ['北冰洋', 'Arctic Ocean', 0, 85],
  ['南大洋', 'Southern Ocean', 40, -62]
]

function buildOceanLabels(lang) {
  const group = new THREE.Group()
  group.visible = false
  for (const [zh, en, lon, lat] of OCEANS) {
    const spr = makeOceanLabel(lang === 'en' ? en : zh)
    spr.position.copy(llaToVec(lat, lon, 25))
    spr._dir = spr.position.clone().normalize()
    group.add(spr)
  }
  return group
}

export function createGlobeScene(container) {
  const w = container.clientWidth || 800, h = container.clientHeight || 600
  // 用标准深度缓冲（保证 MSAA 抗锯齿生效，线条不闪）。各贴地线层用 depthWrite=false + renderOrder
  // 分层，避免互相 z-fighting，故不再需要对数深度缓冲（它会让 gl_FragDepth 失效从而破坏 MSAA）。
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setSize(w, h)
  // 清晰度：至少 3x 超采样，高 DPI 用原生，封顶 4x（MSAA 已恢复，3x 也不再闪）
  renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio || 1, 3), 4))
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x070b12)
  // near 0.1：最近可视面距相机 0.15 不裁切。far 120：覆盖拉远到 maxDistance(50) + 大轨道半径(GEO≈6.6/HEO 更大)，避免远端轨道被远裁剪面切掉露出黑底
  const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 120)
  camera.position.copy(llaToVec(36, 104, 0).multiplyScalar(3.0))   // 默认以中国（约 104°E, 36°N）为中心

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minDistance = 1.15
  controls.maxDistance = 50
  controls.rotateSpeed = 0.5
  controls.enablePan = false    // 关掉平移：右键留给“标点”，避免误平移
  controls.enableZoom = false   // 自定义滚轮缩放（见下方 wheel）：指数步进 + 每帧缓动，手感更顺、不突兀
  controls.autoRotate = true
  controls.autoRotateSpeed = 0.5
  // 拖动旋转才停自转（滚轮缩放不影响旋转，与 2D 星座地图一致）；停转时通知上层同步开关
  let onAutoRotateOff = null
  function stopAutoRotate() { if (controls.autoRotate) { controls.autoRotate = false; if (onAutoRotateOff) onAutoRotateOff() } }

  // 滚轮缩放：维护一个「目标距离」，按指数步进（zoomTarget *= e^(deltaY·k)）——
  // 乘性步进天然就是梯度：离地球近时每格走得少（精细），远时每格走得多（快速）。
  // 每帧把实际距离向目标距离缓动逼近，连续顺滑；累积的滚动一次到位，不必狂滚。
  let zoomTarget = camera.position.length()
  renderer.domElement.addEventListener('wheel', (e) => {
    e.preventDefault()
    const factor = Math.exp(e.deltaY * 0.0018)   // 每格 deltaY≈±100 -> ~±20% 距离
    zoomTarget = Math.max(controls.minDistance, Math.min(controls.maxDistance, zoomTarget * factor))
  }, { passive: false })

  let curW = w, curH = h

  // ---- 粗线（Line2/LineSegments2）：线宽以像素为单位、与 DPR 无关，高分辨率下也清晰不变细 ----
  const lineMats = new Set()
  function regMat(m) { m.resolution.set(curW, curH); lineMats.add(m); return m }
  // depthTest 开（被地球背面遮挡）、depthWrite 关（线之间不写深度 -> 不互相 z-fighting，靠 renderOrder 分层）
  function fatSegments(flat, color, width, opacity, order) {
    const g = new LineSegmentsGeometry(); g.setPositions(flat)
    const m = regMat(new LineMaterial({ color, linewidth: width, transparent: true, opacity, worldUnits: false, depthWrite: false }))
    const o = new LineSegments2(g, m); o.renderOrder = order || 0; return o
  }
  function fatStrip(vecs, color, width, opacity, order) {
    const flat = []; for (const v of vecs) { flat.push(v.x, v.y, v.z) }
    const g = new LineGeometry(); g.setPositions(flat)
    const m = regMat(new LineMaterial({ color, linewidth: width, transparent: true, opacity, worldUnits: false, depthWrite: false }))
    const o = new Line2(g, m); o.renderOrder = order || 0; return o
  }

  const features = feature(topo, topo.objects.countries).features
  // 海洋：纯色球（半径 0.998，留足与陆地细分塌陷下限 ~0.9995 的间隙，标准深度下不 z-fighting）
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(0.998, 128, 128), new THREE.MeshBasicMaterial({ color: OCEAN })))
  // 陆地：矢量三角网填色（零虚化，替代原 8192 纹理）
  scene.add(buildLandMesh(features))

  // 矢量国界/海岸线 + 矢量经纬网：粗线，放大/高分辨率下都锐利清晰
  scene.add(fatSegments(buildGraticule(), 0xffffff, 0.8, 0.12, 1))
  scene.add(fatSegments(buildBorders(features), 0x5b7088, 0.8, 0.9, 2))

  // 国名/洋名：中、英两套（按需切换显隐），初始全隐
  const labelsZh = buildLabels(features, 'zh'); scene.add(labelsZh)
  const labelsEn = buildLabels(features, 'en'); scene.add(labelsEn)
  const oceanZh = buildOceanLabels('zh'); scene.add(oceanZh)
  const oceanEn = buildOceanLabels('en'); scene.add(oceanEn)
  function setLabelMode(mode) {   // 'zh' | 'en' | 'off'
    const zh = mode === 'zh', en = mode === 'en'
    labelsZh.visible = zh; oceanZh.visible = zh
    labelsEn.visible = en; oceanEn.visible = en
  }
  // 地名字号缩放：国家名/大洋名(cf) 与 省名(pf) 分开
  let nameScaleC = 1, nameScaleP = 1
  function applyNameScale(group, f) { if (group) group.traverse((c) => { if (c._base) c.scale.copy(c._base).multiplyScalar(f) }) }
  function setNameScale(cf, pf) {
    nameScaleC = cf || 1; nameScaleP = pf != null ? pf : nameScaleC
    applyNameScale(labelsZh, nameScaleC); applyNameScale(labelsEn, nameScaleC)
    applyNameScale(oceanZh, nameScaleC); applyNameScale(oceanEn, nameScaleC)
    applyNameScale(provinceLabels, nameScaleP)
  }

  // 中国省界 + 省名（按需由上层注入数据）
  let provinceBorders = null, provinceLabels = null
  function setProvinces(data) {
    if (provinceBorders || !data) return
    const pos = []
    for (const ring of (data.borders || [])) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = llaToVec(ring[i][1], ring[i][0], 0).multiplyScalar(1.0005)
        const b = llaToVec(ring[i + 1][1], ring[i + 1][0], 0).multiplyScalar(1.0005)
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    }
    provinceBorders = fatSegments(pos, 0x9aa3b0, 1.3, 0.6, 3)
    provinceBorders.visible = false; scene.add(provinceBorders)
    provinceLabels = new THREE.Group(); provinceLabels.visible = false
    for (const l of (data.labels || [])) {
      // 香港/澳门很小且相邻，字号最小；直辖市（京津沪渝）面积小，字号也调小
      const tiny = l.name === '香港' || l.name === '澳门'
      const muni = l.name === '北京' || l.name === '上海' || l.name === '天津' || l.name === '重庆'
      const hpx = tiny ? 0.007 : muni ? 0.013 : 0.02
      const spr = makeLabelSprite(l.name, hpx, '#ffe6a8')
      spr.position.copy(llaToVec(l.lat, l.lon, 25)); spr._dir = spr.position.clone().normalize()
      provinceLabels.add(spr)
    }
    applyNameScale(provinceLabels, nameScaleP)   // 套用当前省名字号
    scene.add(provinceLabels)
  }
  function setProvincesVisible(v) { if (provinceBorders) provinceBorders.visible = !!v; if (provinceLabels) provinceLabels.visible = !!v }

  // 选中高亮：金色圆环（与 2D 星座地图一致）。用 Sprite + 每帧反缩放成固定屏幕尺寸 ->
  // 任何缩放级别都清晰看到选中的是哪颗；被地球挡住时隐藏。
  function makeRingTexture() {
    const s = 128, c = document.createElement('canvas')
    c.width = c.height = s
    const x = c.getContext('2d')
    x.strokeStyle = '#ffd27a'; x.lineWidth = 9; x.shadowColor = 'rgba(0,0,0,0.6)'; x.shadowBlur = 4
    x.beginPath(); x.arc(s / 2, s / 2, s / 2 - 12, 0, Math.PI * 2); x.stroke()
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const ringSpr = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeRingTexture(), depthTest: false, depthWrite: false, transparent: true }))
  ringSpr.renderOrder = 20
  ringSpr.visible = false
  scene.add(ringSpr)
  let hlPos = null  // 选中星的世界坐标（null=未选中）

  // 选中卫星几何：轨道圈（3D）、星下点轨迹（贴地）、覆盖足迹圈（贴地）。
  // 球体不透明 + 默认深度测试 -> 背面线段被地球天然遮挡，无需手动分正/背面。
  let orbitLine = null, trackLine = null, footLine = null
  function disposeLine(l) { if (l) { scene.remove(l); l.geometry.dispose(); if (l.material) { lineMats.delete(l.material); l.material.dispose() } } }
  function lineFromLLA(points, color, opacity, width) {
    const pts = points.map((p) => llaToVec(p.lat, p.lon, p.altKm || 0))
    return fatStrip(pts, color, width || 1.4, opacity, 4)
  }
  const LIFT = 12  // 轨迹/足迹抬离地表 ~12km，避免与球面 z-fighting
  function setOrbit(points) {
    disposeLine(orbitLine); orbitLine = null
    if (points && points.length) { orbitLine = lineFromLLA(points, 0x6f9fc8, 0.75, 1.5); scene.add(orbitLine) }
  }
  function setGroundTrack(points) {
    disposeLine(trackLine); trackLine = null
    if (points && points.length) { trackLine = lineFromLLA(points.map((p) => ({ lat: p.lat, lon: p.lon, altKm: LIFT })), 0xc2a25e, 0.85, 1.6); scene.add(trackLine) }
  }
  function setFootprint(points) {
    disposeLine(footLine); footLine = null
    if (points && points.length) { footLine = lineFromLLA(points.map((p) => ({ lat: p.lat, lon: p.lon, altKm: LIFT })), 0x96d7f0, 0.95, 1.6); scene.add(footLine) }
  }
  function clearSelectionGeom() { setOrbit(null); setGroundTrack(null); setFootprint(null); setHighlight(null) }

  // 旋转相机使指定方向正对视图（搜索定位时用），保持当前距离
  function faceTo(vec) {
    if (!vec) return
    const dist = camera.position.length()
    camera.position.copy(vec).normalize().multiplyScalar(dist)
    controls.autoRotate = false
    controls.update()
  }
  function setAutoRotate(v) { controls.autoRotate = !!v }
  function setOnAutoRotateOff(fn) { onAutoRotateOff = fn }

  // ===================== GEO 卫星覆盖（仿小程序卫星覆盖，移到 3D 地球） =====================
  let covGroup = null
  // 覆盖用小标签（波束名）：白字描边，depthTest 开 -> 背面被地球遮挡
  function makeCovLabel(text, hpx, color) {
    const fs = 50, pad = 8, font = `${fs}px "Microsoft YaHei", sans-serif`, c = document.createElement('canvas')   // 常规字重 + 细描边，密集时更清晰
    let x = c.getContext('2d'); x.font = font
    c.width = Math.ceil(x.measureText(text).width) + pad * 2; c.height = fs + pad * 2
    x = c.getContext('2d'); x.font = font; x.textBaseline = 'middle'; x.textAlign = 'center'
    x.lineJoin = 'round'; x.miterLimit = 2
    x.lineWidth = 3.5; x.strokeStyle = 'rgba(0,0,0,0.8)'; x.strokeText(text, c.width / 2, c.height / 2)
    x.fillStyle = color || '#ffffff'; x.fillText(text, c.width / 2, c.height / 2)
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: true, depthWrite: false, transparent: true }))
    const s = hpx || 0.03; spr.scale.set((c.width / c.height) * s, s, 1)
    return spr
  }
  function clearCoverage() {
    if (!covGroup) return
    covGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { lineMats.delete(o.material); if (o.material.map) o.material.map.dispose(); o.material.dispose() } })
    scene.remove(covGroup); covGroup = null
  }
  // spec: { lines:[{p:[[lon,lat]...], color, width?, opacity?, closed?}], dots:[{lon,lat}], bores:[{lon,lat,satLon}], labels:[{lon,lat,text,hpx?,color?,alt?}], sats:[{lon,name}], dotR? }
  function setCoverage(spec) {
    clearCoverage()
    if (!spec) return
    const g = new THREE.Group()
    for (const ln of (spec.lines || [])) {
      if (!ln.p || ln.p.length < 2) continue
      const pts = ln.p.map(([lon, lat]) => llaToVec(lat, lon, 0).multiplyScalar(1.0005))
      if (ln.closed !== false) pts.push(pts[0].clone())
      g.add(fatStrip(pts, ln.color, ln.width || 1.6, ln.opacity != null ? ln.opacity : 0.95, 6))
    }
    // 波束中心 -> 所属卫星(GEO)的连线（多星时各成扇形；独立于选中/聚焦）
    for (const b of (spec.bores || [])) {
      if (b.satLon == null) continue
      g.add(fatStrip([llaToVec(0, b.satLon, 35786), llaToVec(b.lat, b.lon, 0).multiplyScalar(1.0012)], 0xffb14a, 1.0, 0.3, 5))
    }
    const dotR = spec.dotR || 0.007
    for (const d of (spec.dots || [])) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(dotR, 10, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }))
      dot.position.copy(llaToVec(d.lat, d.lon, 0).multiplyScalar(1.0012)); g.add(dot)
    }
    for (const l of (spec.labels || [])) {
      const spr = makeCovLabel(l.text, l.hpx, l.color)
      spr.position.copy(llaToVec(l.lat, l.lon, l.alt != null ? l.alt : 130)); spr.renderOrder = 12; g.add(spr)
    }
    // 卫星名称标签：贴在卫星正上方（sprite.center 上移，紧贴星点；不再画菱形本体，高亮由 selectSat 的环负责）
    for (const s of (spec.sats || [])) {
      if (s.lon == null || !s.name) continue
      const spr = makeCovLabel(s.name)
      spr.position.copy(llaToVec(0, s.lon, 35786))
      spr.center.set(0.5, -0.45)
      spr.renderOrder = 13; g.add(spr)
    }
    covGroup = g; scene.add(g)
  }
  // ===================== GRD 覆盖（独立图层：填充面 + 等值线，与烘焙 setCoverage 互不干扰） =====================
  // fillBands=[{color:[r,g,b], polys:[[[lon,lat]...]]}]（分带填充多边形，可空）；segGroups=[{segs:[[[lon,lat],[lon,lat]]...], color, width, opacity}]（逐档等值线，可空）；
  // opts={alpha}。整层一个 group，重设即整体替换。
  let covFieldGroup = null
  let covLayers = new Map()   // 层 id → { group, li }：每个覆盖层(天线·波束)独立子组，支持拖拽时按层增量重建
  let covOpts = {}
  function disposeCovGroup(grp) {
    grp.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { lineMats.delete(o.material); o.material.dispose() } })
  }
  function clearCoverageField() {
    if (!covFieldGroup) return
    disposeCovGroup(covFieldGroup)
    scene.remove(covFieldGroup); covFieldGroup = null; covLayers = new Map()
  }
  // 分带填充：与 2D 同源——直接用 bandGeometry 逐三角形切出的各档环带多边形（lon/lat）构网格。
  // 每个凸多边形扇形三角化，顶点色 = 该档颜色 → 填充边界即等值线、精确重合，无毛刺。地平/接缝裁剪
  // 已在 bandGeometry 内完成（多边形已切在 0°仰角线内、跨缝已解缠），无需再在着色器里 discard。
  // 持久化填充网格（拖拽热路径核心）：几何/材质/缓冲只建一次，每帧把新顶点【写回既有缓冲】并标记更新，
  // 仅在容量不足时才扩容重分配 → 不再每帧 new BufferGeometry/Material/Mesh 并整块重传 GPU（旧版每帧
  // dispose+重建是 GPU churn / command_buffer 崩溃风险的根因），同时内联 lla→vec 免去逐顶点 new Vector3。
  function makeFill(alpha) {
    const geo = new THREE.BufferGeometry()
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: alpha != null ? alpha : 0.85, side: THREE.DoubleSide, depthWrite: false })
    const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = 5; mesh.frustumCulled = false
    return { geo, mat, mesh, posArr: null, colArr: null, idxArr: null, vcap: 0, icap: 0 }
  }
  const D2R_ = Math.PI / 180
  function updateFill(fm, fillBands, alpha, lift) {
    let nv = 0, ni = 0
    for (const fb of fillBands) for (const poly of fb.polys) if (poly.length >= 3) { nv += poly.length; ni += (poly.length - 2) * 3 }
    if (alpha != null) fm.mat.opacity = alpha
    if (!nv) { fm.mesh.visible = false; if (fm.geo.index) fm.geo.setDrawRange(0, 0); return }
    fm.mesh.visible = true
    if (nv > fm.vcap) {   // 扩容：×2 预留，避免拖拽中频繁重分配
      fm.vcap = nv * 2
      fm.posArr = new Float32Array(fm.vcap * 3); fm.colArr = new Float32Array(fm.vcap * 3)
      fm.geo.setAttribute('position', new THREE.BufferAttribute(fm.posArr, 3))
      fm.geo.setAttribute('color', new THREE.BufferAttribute(fm.colArr, 3))
    }
    if (ni > fm.icap) { fm.icap = ni * 2; fm.idxArr = new Uint32Array(fm.icap); fm.geo.setIndex(new THREE.BufferAttribute(fm.idxArr, 1)) }
    const pos = fm.posArr, col = fm.colArr, idx = fm.idxArr
    let n = 0, ii = 0
    for (const fb of fillBands) {
      const cr = fb.color[0] / 255, cg = fb.color[1] / 255, cb = fb.color[2] / 255
      for (const poly of fb.polys) {
        if (poly.length < 3) continue
        const start = n
        for (const p of poly) {   // 内联 llaToVec(lat,lon,0)*lift（r=1）→ 免逐顶点 Vector3 分配
          const phi = (90 - p[1]) * D2R_, theta = (p[0] + 180) * D2R_, sp = Math.sin(phi)
          const o3 = n * 3
          pos[o3] = -lift * sp * Math.cos(theta); pos[o3 + 1] = lift * Math.cos(phi); pos[o3 + 2] = lift * sp * Math.sin(theta)
          col[o3] = cr; col[o3 + 1] = cg; col[o3 + 2] = cb; n++
        }
        for (let i = 1; i < poly.length - 1; i++) { idx[ii++] = start; idx[ii++] = start + i; idx[ii++] = start + i + 1 }   // 扇形三角化
      }
    }
    fm.geo.setDrawRange(0, ii)
    fm.geo.attributes.position.needsUpdate = true
    fm.geo.attributes.color.needsUpdate = true
    fm.geo.index.needsUpdate = true
    fm.geo.computeBoundingSphere()
  }
  // 一层的「装饰」子物体（等值线 + 数值/峰值/名称标签 + 波束中心点/连线）：相对填充轻量，每次 patch 重建。
  function buildDeco(L, o, li) {
    const base = 1.0006 + li * 0.00012, lineLift = base + 0.00003
    const out = []
    for (const grp of (L.segGroups || [])) {
      if (!grp.segs || !grp.segs.length) continue
      const flat = []
      for (const sg of grp.segs) {   // 紧贴本层填充面之上，避免视差错位
        const a = llaToVec(sg[0][1], sg[0][0], 0).multiplyScalar(lineLift), b = llaToVec(sg[1][1], sg[1][0], 0).multiplyScalar(lineLift)
        flat.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
      out.push(fatSegments(flat, grp.color != null ? grp.color : 0xffffff, grp.width || 1.2, grp.opacity != null ? grp.opacity : 0.95, 6))
    }
    // 数值标签：每条等值线最上端点处各标一次档值（相对/绝对，文本由上游决定）。
    // billboard 朝向相机，下半部分会探入地球被遮挡 → 沿径向抬出约半个标签高度（随字号缩放），整块浮在地表之上。
    if (o.showVal) for (const grp of (L.segGroups || [])) {
      if (grp.txt == null) continue
      for (const an of (grp.labels || [])) {
        const spr = makeCovLabel(String(grp.txt), (o.valSize || 12) / 533, '#ffffff')
        const pos = llaToVec(an[1], an[0], 50); pos.addScaledVector(pos.clone().normalize(), spr.scale.y * 0.6)
        spr.position.copy(pos); spr.renderOrder = 12; out.push(spr)
      }
    }
    // 波束中心（boresight）：白点 + 指向所属卫星的连线；天线名标签贴在中心上方
    const b = L.bore
    if (b) {
      if (o.showBore) {
        // 连线(卫星↔波束中心)仅当该卫星「卫星名」也显示时才画（3D 专属，2D 无连线）
        if (b.satShown) out.push(fatStrip([llaToVec(b.satLat || 0, b.satLon, b.satAlt || 35786), llaToVec(b.lat, b.lon, 0).multiplyScalar(1.0012)], 0xffb14a, 1.0, 0.3, 5))
        const dotR = (o.boreSize || 5) * 0.0014
        const dot = new THREE.Mesh(new THREE.SphereGeometry(dotR, 10, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }))
        dot.position.copy(llaToVec(b.lat, b.lon, 0).multiplyScalar(1.0012)); dot.renderOrder = 11; out.push(dot)
      }
      // 波束中心峰值 dB：贴在中心点上方（位于天线名标签之下）
      if (o.showPeak && b.peak != null) {
        const spr = makeCovLabel(b.peak.toFixed(1) + ' dB', (o.peakSize || 12) / 533, '#ffe1a0')
        const pos = llaToVec(b.lat, b.lon, 40); pos.addScaledVector(pos.clone().normalize(), spr.scale.y * 0.6)
        spr.position.copy(pos); spr.renderOrder = 12; out.push(spr)
      }
      if (o.showName && L.name) {
        const spr = makeCovLabel(L.name, (o.nameSize || 16) / 533)
        const pos = llaToVec(b.lat, b.lon, 80); pos.addScaledVector(pos.clone().normalize(), spr.scale.y * 0.6)   // 同数值标签：径向抬出避免被地球遮挡
        spr.position.copy(pos); spr.renderOrder = 13; out.push(spr)
      }
    }
    return out
  }
  function disposeDeco(entry) {
    for (const d of entry.deco) { entry.group.remove(d); if (d.geometry) d.geometry.dispose(); if (d.material) { lineMats.delete(d.material); if (d.material.map) d.material.map.dispose(); d.material.dispose() } }
    entry.deco = []
  }
  // layers=[{fillBands:[{color:[r,g,b], polys}]|null, segGroups, bore}]；多天线各一层(THREE.Group)。
  // 多层叠加：逐层抬升半径(li·step) 稳定层叠（末层=最上），半透明 alpha 混合；等值线略高于本层填充面。
  // li = 层序。entry={ group, li, fill(持久填充网格), deco(每次重建的线/标签/中心) }。
  function ensureLayerEntry(L, o, li, prev) {
    let entry = prev
    if (!entry) { entry = { group: new THREE.Group(), li, fill: null, deco: [] } }
    else { disposeDeco(entry); entry.li = li }
    const base = 1.0006 + li * 0.00012
    if (L.fillBands && L.fillBands.length) {
      if (!entry.fill) { entry.fill = makeFill(o.alpha); entry.group.add(entry.fill.mesh) }
      updateFill(entry.fill, L.fillBands, o.alpha, base)
    } else if (entry.fill) { entry.fill.mesh.visible = false; if (entry.fill.geo.index) entry.fill.geo.setDrawRange(0, 0) }
    const deco = buildDeco(L, o, li)
    for (const d of deco) entry.group.add(d)
    entry.deco = deco
    return entry
  }
  function setCoverageField(layers, opts) {
    clearCoverageField()
    covOpts = opts || {}
    const g = new THREE.Group()
    ;(layers || []).forEach((L, li) => {
      const entry = ensureLayerEntry(L, covOpts, li, null)
      covLayers.set(L.id != null ? L.id : '#' + li, entry)
      g.add(entry.group)
    })
    covFieldGroup = g; scene.add(g)
  }
  // 拖拽热路径：只更新给定层（聚焦天线各波束）——填充网格原地写回顶点、装饰轻量重建，其余层 GPU 资源原样保留。
  function patchCoverageLayers(layers, opts) {
    if (!covFieldGroup) { setCoverageField(layers, opts); return }
    if (opts) covOpts = opts
    let nextLi = covLayers.size
    for (const L of (layers || [])) {
      const id = L.id != null ? L.id : '#' + nextLi
      const prev = covLayers.get(id)
      const li = prev ? prev.li : nextLi++
      const entry = ensureLayerEntry(L, covOpts, li, prev)
      if (!prev) { covLayers.set(id, entry); covFieldGroup.add(entry.group) }
    }
  }
  function setCoverageFieldAlpha(a) {
    if (!covFieldGroup) return
    covFieldGroup.traverse((o) => {
      if (!o.material) return
      if (o.material.uniforms && o.material.uniforms.uOpacity) o.material.uniforms.uOpacity.value = a
      else if (o.material.vertexColors) o.material.opacity = a
    })
  }

  // ===================== 卫星 / 仰角线（独立图层：等仰角线 + 星下点 + 星点，与 GXT/GRD 覆盖互不干扰） =====================
  // spec: { lines:[{p:[[lon,lat]...], color, width?, opacity?, closed?}], dots:[{lon,lat,color?,r?}],
  //         labels:[{lon,lat,text,hpx?,color?,alt?}], sats:[{lon,lat,altKm,name,color?}] }
  let satLayerGroup = null
  function clearSatLayer() {
    if (!satLayerGroup) return
    satLayerGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { lineMats.delete(o.material); if (o.material.map) o.material.map.dispose(); o.material.dispose() } })
    scene.remove(satLayerGroup); satLayerGroup = null
  }
  function setSatLayer(spec) {
    clearSatLayer()
    if (!spec) return
    const g = new THREE.Group()
    for (const ln of (spec.lines || [])) {
      if (!ln.p || ln.p.length < 2) continue
      const pts = ln.p.map(([lon, lat]) => llaToVec(lat, lon, 0).multiplyScalar(1.0008))
      if (ln.closed !== false) pts.push(pts[0].clone())
      g.add(fatStrip(pts, ln.color != null ? ln.color : 0x66ddff, ln.width || 1.4, ln.opacity != null ? ln.opacity : 0.92, 6))
    }
    for (const d of (spec.dots || [])) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(d.r || 0.009, 12, 12), new THREE.MeshBasicMaterial({ color: d.color != null ? d.color : 0xffd27a }))
      dot.position.copy(llaToVec(d.lat, d.lon, 0).multiplyScalar(1.0014)); dot.renderOrder = 11; g.add(dot)
    }
    for (const l of (spec.labels || [])) {
      const spr = makeCovLabel(l.text, l.hpx, l.color)
      spr.position.copy(llaToVec(l.lat, l.lon, l.alt != null ? l.alt : 60)); spr.renderOrder = 12; g.add(spr)
    }
    // 卫星名：显示仰角线的卫星，在其真实位置（轨道高度处）画名称（颜色随该星仰角线色）；不画星点本体
    for (const s of (spec.sats || [])) {
      if (s.lon == null || !Number.isFinite(s.lat) || !s.name || s.labelShow === false) continue
      const spr = makeCovLabel(s.name, (s.labelSize || 14) / 533, s.nameColor)
      spr.position.copy(llaToVec(s.lat, s.lon, s.altKm != null ? s.altKm : 35786)); spr.renderOrder = 14; g.add(spr)
    }
    satLayerGroup = g; scene.add(g)
  }

  // 把视角转到某经纬度正对（覆盖加载后定位用）
  function faceLonLat(lon, lat) { faceTo(llaToVec(lat || 0, lon, 0)) }

  // ===================== 鼠标拾取经纬度 / 标记 / 轨迹 =====================
  // 渲染坐标(半径1) -> 经纬度（llaToVec 的逆）
  function vecToLatLon(p) {
    const lat = 90 - Math.acos(Math.max(-1, Math.min(1, p.y))) * 180 / Math.PI
    let lon = Math.atan2(p.z, -p.x) * 180 / Math.PI - 180
    lon = ((lon % 360) + 540) % 360 - 180
    return { lat, lon }
  }
  // 屏幕坐标 -> 地球表面经纬度（命中近侧半球），未命中返回 null
  function pickGlobe(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect()
    const ndcv = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndcv, camera)
    const o = ray.ray.origin, d = ray.ray.direction
    const b = 2 * o.dot(d), c = o.dot(o) - 1, disc = b * b - 4 * c
    if (disc < 0) return null
    const t = (-b - Math.sqrt(disc)) / 2
    if (t < 0) return null
    return vecToLatLon(o.clone().add(d.clone().multiplyScalar(t)))
  }
  // 拖拽波束专用拾取：命中地球取地表点；未命中（光标移出球面）取射线最近趋近点投到球面=屏幕轮廓(地平)，
  // 让拖拽能贴着地平推到可见极限（否则光标一离开球面就停更，拖不到高纬/南北极限）。
  function pickGlobeOrLimb(clientX, clientY) {
    const hit = pickGlobe(clientX, clientY)
    if (hit) return hit
    const r = renderer.domElement.getBoundingClientRect()
    const ndcv = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndcv, camera)
    const o = ray.ray.origin, d = ray.ray.direction
    const tc = -o.dot(d) / d.dot(d)                    // 射线对地心的最近趋近参数
    const p = o.clone().add(d.clone().multiplyScalar(tc)).normalize()   // 投到单位球(地平)
    return vecToLatLon(p)
  }
  let onHover = null, onRightClick = null
  function setOnHover(fn) { onHover = fn }
  function setOnRightClick(fn) { onRightClick = fn }
  // 拖拽波束模式：左键拖动地球时不旋转，改为回调经纬度（拖动 boresight）
  let beamDragMode = false, onBeamDrag = null, beamDragging = false
  function setBeamDragMode(v) { beamDragMode = !!v; controls.enableRotate = !beamDragMode; if (!v) beamDragging = false; renderer.domElement.style.cursor = beamDragMode ? 'move' : '' }
  function setOnBeamDrag(fn) { onBeamDrag = fn }
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (beamDragging) { const ll = pickGlobeOrLimb(e.clientX, e.clientY); if (ll && onBeamDrag) onBeamDrag(ll, 'move') }
    if (onHover) onHover(pickGlobe(e.clientX, e.clientY))
  })
  renderer.domElement.addEventListener('pointerleave', () => { if (onHover) onHover(null) })
  renderer.domElement.addEventListener('contextmenu', (e) => { e.preventDefault(); if (onRightClick) onRightClick(pickGlobe(e.clientX, e.clientY), { x: e.clientX, y: e.clientY }) })

  // 地面站图标（J4：精致立体卡塞格伦天线——淡填充碟面 + 边缘高光 + 四脚馈源 + 叉臂座架 + 落影），共用一张贴图
  const STATION_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>" +
    "<ellipse cx='32' cy='55' rx='10' ry='2' fill='#000000' opacity='0.22'/>" +
    "<path d='M25 54 L29 44 M39 54 L35 44' stroke='#46566a' stroke-width='2' stroke-linecap='round' fill='none'/>" +
    "<path d='M28 44 a 4 4 0 0 1 8 0 z' fill='#46566a'/><rect x='30.5' y='36' width='3' height='6' fill='#46566a'/>" +
    "<g transform='rotate(-26 32 26)'>" +
    "<ellipse cx='32' cy='26' rx='16.5' ry='11' fill='#eef3f7' stroke='#2f3a48' stroke-width='1.3'/>" +
    "<ellipse cx='32' cy='26' rx='16.5' ry='11' fill='none' stroke='#ffffff' stroke-width='0.7' opacity='0.5'/>" +
    "<ellipse cx='32' cy='26' rx='8' ry='5' fill='none' stroke='#8696a8' stroke-width='0.8'/>" +
    "<path d='M23.5 19.5 L32 11.5 M40.5 19.5 L32 11.5 M27 31.5 L32 11.5 M37 31.5 L32 11.5' fill='none' stroke='#aebccb' stroke-width='0.9' stroke-linecap='round'/>" +
    "<circle cx='32' cy='11.5' r='2.4' fill='#dfe7ee' stroke='#5d6e82' stroke-width='0.8'/></g></svg>"
  let stationTex = null
  function stationTexture() {
    if (stationTex) return stationTex
    stationTex = new THREE.Texture(); stationTex.colorSpace = THREE.SRGBColorSpace
    const img = new Image(); img.onload = () => { stationTex.image = img; stationTex.needsUpdate = true }
    img.src = 'data:image/svg+xml;base64,' + btoa(STATION_SVG)
    return stationTex
  }
  function makeDot(hex) {
    const s = 32, c = document.createElement('canvas'); c.width = c.height = s
    const x = c.getContext('2d')
    x.beginPath(); x.arc(16, 16, 9, 0, Math.PI * 2); x.fillStyle = hex; x.fill()
    x.lineWidth = 3; x.strokeStyle = 'rgba(255,255,255,0.92)'; x.stroke()
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: true, depthWrite: false, transparent: true }))
  }

  let markersGroup = null, trajGroup = null
  function disposeGroup(grp) { if (grp) { grp.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { lineMats.delete(o.material); if (o.material.map && o.material.map !== stationTex) o.material.map.dispose(); o.material.dispose() } }); scene.remove(grp) } }
  // 文字标签：depthTest 关 + 半球剔除 -> 不会被地球边缘裁掉一半，背面整体隐藏
  function labelSprite(text, lat, lon, color, centerY, px) {
    const spr = makeCovLabel(text, 0.03, color || '#ffffff')
    spr.material.depthTest = false
    spr.center.set(0.5, centerY != null ? centerY : -0.35)   // 文字浮在标记上方
    spr.position.copy(llaToVec(lat, lon, 0).multiplyScalar(1.0012))
    spr._dir = spr.position.clone().normalize()
    spr._px = px || 16; spr._ar = spr.scale.x / spr.scale.y; spr.renderOrder = 16
    return spr
  }
  // points:[{lat,lon,label?}]  stations:[{lat,lon,name?}]  sizes:{ptFont,stIcon,stFont}
  function setMarkers(points, stations, sizes) {
    const sz = sizes || {}, ptFont = sz.ptFont || 14, stIcon = sz.stIcon || 32, stFont = sz.stFont || 17
    disposeGroup(markersGroup); markersGroup = null
    const g = new THREE.Group()
    for (const p of (points || [])) {
      const dot = makeDot('#ffd24a'); dot.position.copy(llaToVec(p.lat, p.lon, 0).multiplyScalar(1.0012)); dot._px = 11; dot._ar = 1; dot.renderOrder = 15; g.add(dot)
      if (p.label) g.add(labelSprite(p.label, p.lat, p.lon, '#ffffff', -0.35, ptFont))   // 坐标：白字
      if (p.el) g.add(labelSprite(p.el, p.lat, p.lon, '#cdd6de', 1.35, ptFont * 0.9))     // 聚焦卫星仰角：素灰，标记下方
    }
    for (const s of (stations || [])) {
      const st = new THREE.Sprite(new THREE.SpriteMaterial({ map: stationTexture(), depthTest: true, depthWrite: false, transparent: true }))
      st.position.copy(llaToVec(s.lat, s.lon, 0).multiplyScalar(1.0012)); st.center.set(0.5, 0); st._px = stIcon; st._ar = 1; st.renderOrder = 15; g.add(st)
      if (s.name) g.add(labelSprite(s.name, s.lat, s.lon, '#cfeaff', 1.05, stFont))   // 名称紧贴地面站图标下方
      if (s.el) g.add(labelSprite(s.el, s.lat, s.lon, '#cdd6de', 2.1, stFont * 0.9))   // 聚焦卫星仰角：素灰，名称下方
    }
    markersGroup = g; scene.add(g)
  }
  function slerp(a, b, t) {
    const d = Math.max(-1, Math.min(1, a.dot(b))), ang = Math.acos(d)
    if (ang < 1e-6) return a.clone()
    const s = Math.sin(ang)
    return a.clone().multiplyScalar(Math.sin((1 - t) * ang) / s).add(b.clone().multiplyScalar(Math.sin(t * ang) / s))
  }
  // list:[{pts:[{lat,lon}], color, kind}]
  function setTrajectories(list) {
    disposeGroup(trajGroup); trajGroup = null
    const g = new THREE.Group()
    for (const tr of (list || [])) {
      const pts = tr.pts || []
      const verts = []
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = llaToVec(pts[i].lat, pts[i].lon, 0), b = llaToVec(pts[i + 1].lat, pts[i + 1].lon, 0)
        const steps = Math.max(2, Math.ceil(a.angleTo(b) / (2 * Math.PI / 180)))
        for (let s = 0; s <= steps; s++) verts.push(slerp(a, b, s / steps).multiplyScalar(1.002))
      }
      if (verts.length > 1) g.add(fatStrip(verts, tr.color != null ? tr.color : 0xff5a5a, 2.2, 0.95, 7))
      for (const p of pts) { const dot = makeDot(tr.kind === 'flight' ? '#5ad1ff' : '#ff9a5a'); dot.position.copy(llaToVec(p.lat, p.lon, 0).multiplyScalar(1.002)); dot._px = 8; dot._ar = 1; dot.renderOrder = 15; g.add(dot) }
    }
    trajGroup = g; scene.add(g)
  }
  // 标记/轨迹精灵每帧反缩放成固定屏幕尺寸；带 _dir 的文字标签做半球剔除（避免被地球裁切）
  function rescaleMarkers() {
    const tanH = Math.tan(camera.fov * 0.5 * Math.PI / 180) || 1
    const cd = camera.position.clone().normalize()
    const go = (grp) => {
      if (!grp) return
      for (const o of grp.children) {
        if (o._dir) {   // 文字标签：近地平淡出，避免边缘跳变
          const dot = o._dir.dot(cd)
          if (dot <= 0.05) { o.visible = false; continue }
          o.visible = true; o.material.opacity = dot >= 0.22 ? 1 : (dot - 0.05) / 0.17
        }
        if (o._px) { const dd = camera.position.distanceTo(o.position); const h = o._px * (2 * dd * tanH) / curH; o.scale.set(h * (o._ar || 1), h, 1) }
      }
    }
    go(markersGroup); go(trajGroup)
  }

  let satPoints = null
  function setSatellites(positions) {
    if (satPoints) { scene.remove(satPoints); satPoints.geometry.dispose(); satPoints.material.dispose() }
    const arr = new Float32Array(positions.length * 3)
    for (let i = 0; i < positions.length; i++) {
      const v = llaToVec(positions[i].lat, positions[i].lon, positions[i].altKm)
      arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    // 固定屏幕尺寸（不随距离缩小）：拉远地球变小时卫星仍清晰可见、可点
    satPoints = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x9fd0ef, size: 3.2, sizeAttenuation: false }))
    scene.add(satPoints)
  }
  function setHighlight(vec) { hlPos = vec ? vec.clone() : null; if (!hlPos) ringSpr.visible = false }
  function setHighlightLLA(p) { setHighlight(p ? llaToVec(p.lat, p.lon, p.altKm) : null) }

  // 拾取卫星：非拖拽的点击 -> 离光标最近、且未被地球遮挡的星点
  const ray = new THREE.Raycaster()
  let onPick = null
  function setOnPick(fn) { onPick = fn }

  // 相机到 P 的视线是否在到达 P 之前先穿过地球（即 P 在地球背面被挡住）
  function occludedByGlobe(P) {
    const C = camera.position
    const dx = P.x - C.x, dy = P.y - C.y, dz = P.z - C.z
    const a = dx * dx + dy * dy + dz * dz
    const b = 2 * (C.x * dx + C.y * dy + C.z * dz)
    const c = C.x * C.x + C.y * C.y + C.z * C.z - 1
    const disc = b * b - 4 * a * c
    if (disc <= 0) return false
    const sq = Math.sqrt(disc), EPS = 1e-4
    const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a)
    return (t1 > EPS && t1 < 1 - EPS) || (t2 > EPS && t2 < 1 - EPS)
  }

  let downX = 0, downY = 0
  renderer.domElement.addEventListener('pointerdown', (e) => {
    downX = e.clientX; downY = e.clientY
    if (beamDragMode && e.button === 0) { beamDragging = true; const ll = pickGlobeOrLimb(e.clientX, e.clientY); if (ll && onBeamDrag) onBeamDrag(ll, 'start') }
  })
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (beamDragging) { beamDragging = false; if (onBeamDrag) onBeamDrag(null, 'end'); return }   // 拖波束结束，不当作选星
    if (e.button !== 0) return   // 仅左键当作选星；右键（标点）/中键不改变聚焦
    // 拖动（旋转）-> 停自转、不当作点击
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 6) { stopAutoRotate(); return }
    if (!satPoints || !onPick) return
    const r = renderer.domElement.getBoundingClientRect()
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    // 命中半径随相机距离缩放，保持屏幕上 ~14px 的固定手感（地球缩小时也好点）
    const tanHalf = Math.tan(camera.fov * 0.5 * Math.PI / 180) || 1
    const dist = camera.position.distanceTo(controls.target)
    ray.params.Points.threshold = Math.max(0.01, Math.min(0.4, 14 * 2 * dist * tanHalf / curH))
    ray.setFromCamera(v, camera)
    const hits = ray.intersectObject(satPoints)
    // 取离视线最近、且不在地球背面的星点
    let best = null
    for (const hit of hits) {
      if (occludedByGlobe(hit.point)) continue
      if (!best || hit.distanceToRay < best.distanceToRay) best = hit
    }
    if (best) onPick(best.index, best.point); else onPick(-1, null)
  })

  const camDir = new THREE.Vector3()
  // 标签：近地平处用透明度平滑淡出（而非硬切换显隐），消除旋转时边缘的闪烁/跳变。
  // dot>0.22 全显；0.05~0.22 线性淡出；<0.05 隐藏。
  function fadeLabel(s, dot) {
    if (dot <= 0.05) { s.visible = false; return }
    s.visible = true
    s.material.opacity = dot >= 0.22 ? 1 : (dot - 0.05) / 0.17
  }
  function updateLabels() {
    camDir.copy(camera.position).normalize()
    const cull = (grp) => { if (!grp || !grp.visible) return; for (const s of grp.children) fadeLabel(s, s._dir.dot(camDir)) }
    cull(labelsZh); cull(labelsEn); cull(oceanZh); cull(oceanEn); cull(provinceLabels)
  }

  const zoomDir = new THREE.Vector3()
  let raf = 0
  function loop() {
    controls.update()   // 旋转/阻尼（半径在此保持不变）
    // 滚轮缩放缓动：把当前半径向 zoomTarget 逼近（0.18 的缓动系数 -> 顺滑且跟手）
    const cur = camera.position.distanceTo(controls.target)
    if (Math.abs(cur - zoomTarget) > 1e-4) {
      const next = cur + (zoomTarget - cur) * 0.18
      zoomDir.copy(camera.position).sub(controls.target).normalize()
      camera.position.copy(controls.target).addScaledVector(zoomDir, next)
    }
    // 选中环：固定屏幕直径 ~24px，背面被地球挡住时隐藏
    if (hlPos) {
      const tanHalf = Math.tan(camera.fov * 0.5 * Math.PI / 180) || 1
      const d = camera.position.distanceTo(hlPos)
      const sz = 24 * (2 * d * tanHalf) / curH
      ringSpr.position.copy(hlPos)
      ringSpr.scale.set(sz, sz, 1)
      ringSpr.visible = !occludedByGlobe(hlPos)
    }
    rescaleMarkers()
    updateLabels()
    renderer.render(scene, camera)
    raf = requestAnimationFrame(loop)
  }
  loop()

  function resize() {
    const ww = container.clientWidth, hh = container.clientHeight
    if (!ww || !hh) return
    curW = ww; curH = hh
    camera.aspect = ww / hh; camera.updateProjectionMatrix(); renderer.setSize(ww, hh)
    for (const m of lineMats) m.resolution.set(ww, hh)   // 粗线宽度依赖分辨率
  }
  function destroy() {
    cancelAnimationFrame(raf); controls.dispose(); renderer.dispose()
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
  }

  return {
    setSatellites, setLabelMode, setHighlight, setHighlightLLA, setOnPick,
    setOrbit, setGroundTrack, setFootprint, clearSelectionGeom,
    setCoverage, clearCoverage, setCoverageField, patchCoverageLayers, clearCoverageField, setCoverageFieldAlpha, setSatLayer, clearSatLayer, faceLonLat, setProvinces, setProvincesVisible, setNameScale,
    setMarkers, setTrajectories, setOnHover, setOnRightClick, setBeamDragMode, setOnBeamDrag,
    faceTo, setAutoRotate, setOnAutoRotateOff, resize, destroy
  }
}
