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
import { ENV_R, envSphereParams } from '../env/envSphere.js'
import { NANHAI_DASHES, NANHAI_WIDTH_MUL, NANHAI_MIN_WIDTH } from '../nanhaiDashes.js'
import { CHINA, ARCTIC_ISLAND_LAT, landColors, setLandPalette } from '../landPalette.js'
import { antarcticaFillRings } from './antarctica.js'
import { solarGeometry, terminatorRing } from '../terminator.js'

const RE = 6371

// 画布文字（地名/大洋/波束标签）与界面同一字体栈：Times New Roman 打西文，宋体接中文。
// 与 styles/global.css 的 --font-serif 保持一致（canvas 取不到 CSS 变量，此处手工镜像）。
const UI_FONT = '"Times New Roman", Times, "SimSun", "宋体", serif'

// 渲染分辨率倍率上限：实际渲染不超过显示器物理像素密度的 SS_CAP 倍。
// 超出物理像素的超采样屏幕根本无法显示，纯属浪费 GPU——裁掉它对画质无影响（MSAA 仍负责边缘抗锯齿）。
// 低端办公机多为 DPR=1，由此把默认/高档位的 2~3× 超采样压到 ≤1.5×，片元着色负载按面积平方下降（≈省一半到四分之三）。
// HiDPI 屏（DPR≥1.5）取 min 后仍按原生密度渲染，保持锐利、不降画质。需要更多超采样可调大 SS_CAP。
const SS_CAP = 2
function capPixelRatio(n) {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
  return Math.max(0.25, Math.min(n, dpr * SS_CAP, 4))
}

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

// 陆地配色（LAND/CHINA/ICE/基调方案/逐国覆盖）统一收拢到 ../landPalette.js（与 2D 平面图共用单一来源）
const OCEAN = '#15426b'

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

  function pushVert(lon, lat) {
    const v = llaToVec(lat, lon, 0)   // 半径 1，贴在海洋球(0.999)之上
    positions.push(v.x, v.y, v.z)
    colors.push(col.r, col.g, col.b)   // 颜色按「多边形」决定（北极岛屿整块冰白），不再逐顶点纬度渐变
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
    // 南极洲：海岸线收口到南极点直接三角化（替代普通 addPolygon + −82° 极冠）。
    // 修复 50m 本土不填充（其本土被编码为退化外环+海岸线洞，earcut 得 0），并消除 −82° 极冠对海洋的污染与接缝。
    if (id === '010') {
      col.set(landColors(id, idx).base)   // 南极洲：默认冰白，可被逐国覆盖改色
      for (const ring of antarcticaFillRings(f)) {
        const flat = []
        for (const p of ring) { flat.push(p[0], p[1]) }
        const tri = earcut(flat, [])
        for (let t = 0; t < tri.length; t += 3) {
          const i0 = tri[t] * 2, i1 = tri[t + 1] * 2, i2 = tri[t + 2] * 2
          emitTri([flat[i0], flat[i0 + 1]], [flat[i1], flat[i1 + 1]], [flat[i2], flat[i2 + 1]], 0)
        }
      }
      return
    }
    const { base, arctic } = landColors(id, idx)
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    // 北极岛屿（多边形质心纬度 ≥ ARCTIC_ISLAND_LAT）整块染冰白：格陵兰本就冰白；
    // 加拿大北极群岛、俄罗斯北极诸岛、斯瓦尔巴等离散海岛 → 冰白；各大陆/阿拉斯加/冰岛(质心<65°) → 普通陆地。
    // 用户逐国设色时 arctic=用户色（整国一色，见 landPalette.js）。
    for (const rings of polys) {
      const o = rings[0]; let sy = 0; for (const p of o) sy += p[1]
      col.set((sy / o.length) >= ARCTIC_ISLAND_LAT ? arctic : base)
      addPolygon(rings)
    }
  })

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }))
}

function makeLabelSprite(text, hpx, fill, strokePx = 4) {
  const pad = 8, fs = 54   // 高分辨率纹理：放大后文字更锐利
  const c = document.createElement('canvas')
  let cx = c.getContext('2d')
  cx.font = `${fs}px ${UI_FONT}`
  const w = Math.ceil(cx.measureText(text).width) + pad * 2
  c.width = w; c.height = fs + pad * 2
  cx = c.getContext('2d')
  cx.font = `${fs}px ${UI_FONT}`
  cx.textBaseline = 'middle'; cx.textAlign = 'center'
  cx.lineJoin = 'round'; cx.miterLimit = 2
  cx.lineWidth = strokePx; cx.strokeStyle = 'rgba(0,0,0,0.8)'   // 黑色描边(casing)：strokePx 控粗细
  if (strokePx > 0) cx.strokeText(text, c.width / 2, c.height / 2)
  // 字面烘成纯白，颜色由 SpriteMaterial.color 着色（运行时可改）：白×色=色，黑色描边×色仍≈黑，casing 保留
  cx.fillStyle = '#ffffff'; cx.fillText(text, c.width / 2, c.height / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  // depthTest 关：正面标签始终完整显示，不被球面裁切；背面由每帧半球剔除隐藏
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: fill || '#eef2f6', depthTest: false, depthWrite: false, transparent: true }))
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
function buildBorders(features, thin = 0.025) {
  const pos = []
  for (const f of features) {
    const g = f.geometry
    if (!g) continue
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    for (const rings of polys) {
      for (const ring0 of rings) {
        const ring = thin > 0 ? decimateRing(ring0, thin) : ring0
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
  const font = `italic ${fs}px ${UI_FONT}`
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
  ['太平洋', 'Pacific Ocean', -155, 25], ['太平洋', 'Pacific Ocean', -130, -22],
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

export function createGlobeScene(container, quality = {}) {
  const w = container.clientWidth || 800, h = container.clientHeight || 600
  // 画质参数（见 stores/displayQuality.js）：pixelRatio 渲染分辨率倍率、msaa 抗锯齿、sphereSeg 海洋球细分、
  // mapDetail/mapThin 底图精度、fps 帧率上限。msaa 是上下文创建期参数，运行时不可改（由上层按 key 重挂载切换）。
  let pixelRatio = quality.pixelRatio || 3
  const sphereSeg0 = quality.sphereSeg || 128
  let fpsCap = quality.fps || 0
  // 用标准深度缓冲（保证 MSAA 抗锯齿生效，线条不闪）。各贴地线层用 depthWrite=false + renderOrder
  // 分层，避免互相 z-fighting，故不再需要对数深度缓冲（它会让 gl_FragDepth 失效从而破坏 MSAA）。
  const renderer = new THREE.WebGLRenderer({ antialias: quality.msaa !== false, powerPreference: 'high-performance' })
  // updateStyle=false：不往 canvas 写内联 px 尺寸，CSS 100% 由容器控制。若写内联 px，
  // 亚像素舍入会反过来撑大布局，与外层滚动条形成「量尺寸→写尺寸」振荡回路（窗口化抖动）。
  renderer.setSize(w, h, false)
  // 清晰度：渲染分辨率倍率，封顶为「物理像素密度 × SS_CAP」（capPixelRatio）。运行时可经 setPixelRatio 热切。
  renderer.setPixelRatio(capPixelRatio(pixelRatio))
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x070b12)
  // near 0.1：最近可视面距相机 0.15 不裁切。far 120：覆盖拉远到 maxDistance(50) + 大轨道半径(GEO≈6.6/HEO 更大)，避免远端轨道被远裁剪面切掉露出黑底
  const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 120)
  camera.position.copy(llaToVec(36, 104, 0).multiplyScalar(3.0))   // 默认以中国（约 104°E, 36°N）为中心
  // 标记/标签「随缩放联动」的基准相机距离：在此距离上标记=其设定的当前像素大小（≈默认贴合视角），
  // 拉近变大、拉远变小，与国家名/省名等世界尺寸地名同步缩放（取默认初始距离 3.0）。
  const LABEL_REF_DIST = 3.0
  const SAT_POINT_PX = 3.2   // 卫星点基准像素（基准距离上的屏幕大小，逐帧按缩放联动）

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
  // 缩放进度（底部状态栏进度条）：距离[min,max]对数映射到 t∈[0,1]，t=0 最远(缩小)、t=1 最近(放大)。
  // 对数映射 → 进度条每一格的“距离倍率”恒定，靠近地球时绝对步进更小，天然支持精细化缩放。
  const _lnMin = Math.log(controls.minDistance), _lnMax = Math.log(controls.maxDistance)
  const distToT = (d) => (_lnMax - Math.log(d)) / (_lnMax - _lnMin)
  const tToDist = (t) => Math.exp(_lnMax - Math.max(0, Math.min(1, t)) * (_lnMax - _lnMin))
  let onZoom = null
  const reportZoom = () => { if (onZoom) onZoom(distToT(zoomTarget)) }
  renderer.domElement.addEventListener('wheel', (e) => {
    e.preventDefault()
    const factor = Math.exp(e.deltaY * 0.0018)   // 每格 deltaY≈±100 -> ~±20% 距离
    zoomTarget = Math.max(controls.minDistance, Math.min(controls.maxDistance, zoomTarget * factor))
    reportZoom()
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

  let features = feature(topo, topo.objects.countries).features
  let mapThin = quality.mapThin != null ? quality.mapThin : 0.025
  // 海洋：纯色球（半径 0.998，留足与陆地细分塌陷下限 ~0.9995 的间隙，标准深度下不 z-fighting）
  // 海洋球：保留几何/材质引用，供 setOceanColor 改色、setSphereDetail 改细分段数
  const oceanMat = new THREE.MeshBasicMaterial({ color: OCEAN })
  let oceanMesh = new THREE.Mesh(new THREE.SphereGeometry(0.998, sphereSeg0, sphereSeg0), oceanMat)
  scene.add(oceanMesh)
  // 陆地：矢量三角网填色（零虚化，替代原 8192 纹理）。保留引用供 setMapDetail 重建。
  let landMesh = buildLandMesh(features)
  scene.add(landMesh)

  // 矢量国界/海岸线 + 矢量经纬网：粗线，放大/高分辨率下都锐利清晰
  // 经纬网 / 海岸线 渲染序高于覆盖填充(5)+各类数据线(等值线/波束线/仰角线/轨迹线，统一 6)、低于点/标注：
  // 地理骨架贯穿覆盖区之上 → 覆盖与底图融为一体（平级），不再像贴纸浮在地图上面。depthWrite=false，纯绘制顺序。
  scene.add(fatSegments(buildGraticule(), 0xffffff, 0.8, 0.12, 6.3))
  // 国界/海岸线：保留材质引用，供 setBorderStyle 运行时改线宽/颜色/透明度；setMapDetail 时重建
  const borderCfg = { natColor: 0x5b7088, natWidth: 0.8, natOpacity: 1.0, provColor: 0x9aa3b0, provWidth: 1.2, provOpacity: 0.8, cityColor: 0xb6bcc6, cityWidth: 0.5, cityOpacity: 0.6 }
  let coastBorders = fatSegments(buildBorders(features, mapThin), borderCfg.natColor, borderCfg.natWidth, borderCfg.natOpacity, 6.5)
  scene.add(coastBorders)
  // 南海十段线：颜色随中国国土(CHINA)、线宽/透明度随省界(borderCfg.prov*)，线宽×惯例倍数（略粗于省界）。
  // 每段为多点折线 → 展开成相邻点对喂给 LineSegments（v0-v1, v1-v2, ...）。
  const nanhaiPos = []
  for (const seg of NANHAI_DASHES) {
    for (let i = 0; i + 1 < seg.length; i++) {
      const a = llaToVec(seg[i][1], seg[i][0], 0).multiplyScalar(1.0005)
      const b = llaToVec(seg[i + 1][1], seg[i + 1][0], 0).multiplyScalar(1.0005)
      nanhaiPos.push(a.x, a.y, a.z, b.x, b.y, b.z)
    }
  }
  const nanhaiW = (pw) => Math.max(NANHAI_MIN_WIDTH, pw * NANHAI_WIDTH_MUL)
  const nanhaiLine = fatSegments(nanhaiPos, CHINA, nanhaiW(borderCfg.provWidth), borderCfg.provOpacity, 6.5)
  scene.add(nanhaiLine)

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
  // 地名字号缩放：国家名/大洋名(cf) 与 省名(pf) 与 地级市名(cityf) 分开
  let nameScaleC = 1, nameScaleP = 1, nameScaleCity = 1
  function applyNameScale(group, f) { if (group) group.traverse((c) => { if (c._base) c.scale.copy(c._base).multiplyScalar(f) }) }
  function setNameScale(cf, pf, cityf) {
    nameScaleC = cf || 1; nameScaleP = pf != null ? pf : nameScaleC
    if (cityf != null) nameScaleCity = cityf
    applyNameScale(labelsZh, nameScaleC); applyNameScale(labelsEn, nameScaleC)
    applyNameScale(oceanZh, nameScaleC); applyNameScale(oceanEn, nameScaleC)
    applyNameScale(provinceLabels, nameScaleP)
    applyNameScale(cityLabels, nameScaleCity)
  }
  // 地名颜色/透明度：国家名(cf) 与 省名(pf) 分开。字面已烘白 → 改 SpriteMaterial.color 即着色，opacity 控整体淡入淡出。
  // 省名标签懒加载，故同时存进 labelCfg，setProvinces 创建时套用。大洋名维持其固有蓝，不随国家色改。
  const labelCfg = { countryColor: '#eef2f6', countryOpacity: 1, provColor: '#ffe6a8', provOpacity: 1, cityColor: '#cdd6e0', cityOpacity: 1 }
  function applyLabelStyle(group, color, opacity) {
    if (!group) return
    group.traverse((c) => { if (c.isSprite && c.material) { if (color != null) c.material.color.set(color); if (opacity != null) { c._baseOpacity = opacity; c.material.opacity = opacity } } })
  }
  function setLabelStyle(s) {
    if (!s) return
    Object.assign(labelCfg, s)
    if (s.countryColor != null || s.countryOpacity != null) { applyLabelStyle(labelsZh, s.countryColor, s.countryOpacity); applyLabelStyle(labelsEn, s.countryColor, s.countryOpacity) }
    if (s.provColor != null || s.provOpacity != null) applyLabelStyle(provinceLabels, s.provColor, s.provOpacity)
    if (s.cityColor != null || s.cityOpacity != null) applyLabelStyle(cityLabels, s.cityColor, s.cityOpacity)
  }
  // 大海颜色（限蓝色系）：直接改海洋球材质色
  function setOceanColor(c) { if (c) oceanMat.color.set(c) }

  // ===================== 显示画质：运行时可热切的项 =====================
  // 渲染分辨率倍率（超采样）：THREE setPixelRatio，封顶 4x、下限 0.25x。
  function setPixelRatio(n) {
    if (!Number.isFinite(n)) return
    pixelRatio = Math.max(0.25, Math.min(n, 4))   // 保留「用户请求值」备查
    renderer.setPixelRatio(capPixelRatio(pixelRatio))   // 实际渲染倍率按物理像素封顶
    renderer.setSize(curW, curH, false)          // 重设尺寸使新 DPR 生效；false：不写内联样式，见构造处注释
    for (const m of lineMats) m.resolution.set(curW, curH)
  }
  // 渲染帧率上限（0=每帧不限；30/60=节流省电）。在 loop 中据此跳帧。
  function setRenderFps(n) { fpsCap = Number.isFinite(n) && n > 0 ? n : 0 }
  // 海洋球细分段数：重建球几何（材质/颜色保留）。
  function setSphereDetail(seg) {
    const s = Math.max(16, Math.min(seg | 0 || 128, 256))
    scene.remove(oceanMesh); oceanMesh.geometry.dispose()
    oceanMesh = new THREE.Mesh(new THREE.SphereGeometry(0.998, s, s), oceanMat)
    scene.add(oceanMesh)
  }
  // 释放一条粗线（LineSegments2）：移出场景 + 注销线材质 + dispose
  function disposeFatLine(o) {
    if (!o) return
    scene.remove(o)
    if (o.geometry) o.geometry.dispose()
    if (o.material) { lineMats.delete(o.material); o.material.dispose() }
  }
  // 底图精细化：'10m'(精细) / '50m'(粗)。换 topojson 源 → 重建陆地网格 + 国界/海岸线。
  // 50m 数据按需懒加载（避免拖慢首屏）。thin=边界抽稀阈值（度）。
  let mapDetail0 = '10m'        // 创建时恒以静态 10m 构建；切到 50m/110m 由 setMapDetail 异步换源
  const featCache = { '10m': features }   // 各精度 features 缓存（10m 静态，其余懒加载）
  const featsOf = (m) => { const t = m.default || m; return feature(t, t.objects.countries).features }
  const loadFeatures = async (detail) => {
    if (featCache[detail]) return featCache[detail]
    // 字面量 import() 让 Vite 各自打成独立 chunk（变量路径无法分析、构建后会失效）
    const mod = detail === '110m' ? await import('./data/countries-110m.json') : await import('./data/countries-50m.json')
    featCache[detail] = featsOf(mod)
    return featCache[detail]
  }
  async function setMapDetail(detail, thin) {
    const t = (thin != null) ? thin : mapThin
    const changedThin = t !== mapThin
    if (detail === mapDetail0 && !changedThin) return
    mapThin = t
    let feats
    try { feats = await loadFeatures(detail) }
    catch (e) { console.warn(detail + ' 底图加载失败，保持当前精度', e); return }
    mapDetail0 = detail
    features = feats
    // 重建陆地三角网
    scene.remove(landMesh); landMesh.geometry.dispose(); landMesh.material.dispose()
    landMesh = buildLandMesh(feats); scene.add(landMesh)
    // 重建国界/海岸线（沿用当前线样式）
    disposeFatLine(coastBorders)
    coastBorders = fatSegments(buildBorders(feats, mapThin), borderCfg.natColor, borderCfg.natWidth, borderCfg.natOpacity, 6.5)
    scene.add(coastBorders)
  }
  // 大地颜色（基调方案 + 逐国覆盖，与 2D 平面图同步）：写入公共色板状态后重建陆地三角网。
  // 颜色烘焙在顶点色里，改色必须重建；仅用户在设置面板操作时触发，代价可接受。
  function setLandColors(s) {
    setLandPalette(s)
    scene.remove(landMesh); landMesh.geometry.dispose(); landMesh.material.dispose()
    landMesh = buildLandMesh(features); scene.add(landMesh)
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
    provinceBorders = fatSegments(pos, borderCfg.provColor, borderCfg.provWidth, borderCfg.provOpacity, 6.6)   // 同海岸线：压在覆盖之上，与底图平级
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
    applyLabelStyle(provinceLabels, labelCfg.provColor, labelCfg.provOpacity)   // 套用当前省名颜色/透明度
    scene.add(provinceLabels)
  }
  function setProvincesVisible(v) { if (provinceBorders) provinceBorders.visible = !!v; if (provinceLabels) provinceLabels.visible = !!v }

  // 中国地级市界 + 地级市名（按需由上层注入数据，格式同省界）。渲染序 6.55：压在省界(6.6)之下、海岸/覆盖之上 → 省界更醒目。
  let cityBorders = null, cityLabels = null
  function setCities(data) {
    if (cityBorders || !data) return
    const pos = []
    for (const ring of (data.borders || [])) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = llaToVec(ring[i][1], ring[i][0], 0).multiplyScalar(1.0004)
        const b = llaToVec(ring[i + 1][1], ring[i + 1][0], 0).multiplyScalar(1.0004)
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    }
    cityBorders = fatSegments(pos, borderCfg.cityColor, borderCfg.cityWidth, borderCfg.cityOpacity, 6.55)
    cityBorders.visible = false; scene.add(cityBorders)
    cityLabels = new THREE.Group(); cityLabels.visible = false
    for (const l of (data.labels || [])) {
      // 地级市名密集 → 基准字号偏小（小空间），整体再由 nameScaleCity 缩放；黑边尽量细但保留(2px)
      const spr = makeLabelSprite(l.name, 0.012, labelCfg.cityColor, 2)
      spr.position.copy(llaToVec(l.lat, l.lon, 16)); spr._dir = spr.position.clone().normalize()
      cityLabels.add(spr)
    }
    applyNameScale(cityLabels, nameScaleCity)
    applyLabelStyle(cityLabels, labelCfg.cityColor, labelCfg.cityOpacity)
    scene.add(cityLabels)
  }
  function setCitiesVisible(v) { if (cityBorders) cityBorders.visible = !!v; if (cityLabels) cityLabels.visible = !!v }
  // 国界/省界线样式（线宽 px / 颜色 / 透明度）。merge 到 borderCfg 并改对应材质 uniform；
  // 省界材质可能尚未创建（懒加载），故同时存进 borderCfg，setProvinces 创建时套用。
  function setBorderStyle(s) {
    if (!s) return
    Object.assign(borderCfg, s)
    if (coastBorders) {
      const m = coastBorders.material
      if (s.natColor != null) m.color.set(s.natColor)
      if (s.natWidth != null) m.linewidth = s.natWidth
      if (s.natOpacity != null) m.opacity = s.natOpacity
    }
    if (nanhaiLine) {   // 南海十段线随省界透明度，线宽=省界×惯例倍数（颜色固定为国土色）
      const m = nanhaiLine.material
      if (s.provWidth != null) m.linewidth = nanhaiW(s.provWidth)
      if (s.provOpacity != null) m.opacity = s.provOpacity
    }
    if (provinceBorders) {
      const m = provinceBorders.material
      if (s.provColor != null) m.color.set(s.provColor)
      if (s.provWidth != null) m.linewidth = s.provWidth
      if (s.provOpacity != null) m.opacity = s.provOpacity
    }
    if (cityBorders) {
      const m = cityBorders.material
      if (s.cityColor != null) m.color.set(s.cityColor)
      if (s.cityWidth != null) m.linewidth = s.cityWidth
      if (s.cityOpacity != null) m.opacity = s.cityOpacity
    }
  }

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
  const RING_PX = 26  // 选中环固定屏幕像素大小，与缩放无关
  // 环可以有多个：点选星一个 + 对星覆盖分析「聚焦特效」每颗被点亮的星各一个（源星与其对星跟踪的目标星）。
  // 共用同一张纹理，精灵按需扩池、只增不减（多出来的隐藏），每帧逐个反缩放 + 背面剔除。
  const ringTex = makeRingTexture()
  const ringSprs = []
  function ringSprite() {
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, depthTest: false, depthWrite: false, transparent: true }))
    spr.renderOrder = 20; spr.visible = false
    scene.add(spr); ringSprs.push(spr)
    return spr
  }
  ringSprite()
  let hlPos = []  // 选中星/聚焦星的世界坐标列表（空=一个都不画）

  // 选中卫星几何：轨道圈（3D）、星下点轨迹（贴地）、覆盖足迹圈（贴地）。
  // 球体不透明 + 默认深度测试 -> 背面线段被地球天然遮挡，无需手动分正/背面。
  let orbitLine = null, trackLine = null, footLine = null
  function disposeLine(l) { if (l) { scene.remove(l); l.geometry.dispose(); if (l.material) { lineMats.delete(l.material); l.material.dispose() } } }
  function lineFromLLA(points, color, opacity, width) {
    const pts = points.map((p) => llaToVec(p.lat, p.lon, p.altKm || 0))
    return fatStrip(pts, color, width || 1.4, opacity, 6)   // 与 GRD 等值线/Polygon 线同层(6)：覆盖填充(5)之上、国界省界(6.5+)之下
  }
  const LIFT = 12  // 轨迹/足迹抬离地表 ~12km，避免与球面 z-fighting
  // 选中星「在轨点」大号圆点屏幕像素：略大于星点云(SAT_POINT_PX≈3.2)，压在细轨道之上、落在高亮环内；primary 更大一档
  const SEL_DOT_PX = 11
  const SEL_DOT_PX_PRIMARY = 13
  function setOrbit(points) {
    disposeLine(orbitLine); orbitLine = null
    if (points && points.length) { orbitLine = lineFromLLA(points, 0x6f9fc8, 0.75, 1.5); scene.add(orbitLine) }
  }
  function setGroundTrack(points) {
    disposeLine(trackLine); trackLine = null
    if (points && points.length) { trackLine = lineFromLLA(points.map((p) => ({ lat: p.lat, lon: p.lon, altKm: LIFT })), 0xe8c074, 1, 1.6); scene.add(trackLine) }
  }
  // 覆盖足迹画成虚线：示意性范围（非精确实测覆盖区），与星下点轨迹（实线，真实星下点）区分开。
  // footprintEllipsoid 固定按 72 段采样且首尾闭合 -> 隔段取一画一，得到 36 段均匀虚线、首尾自然衔接。
  function setFootprint(points) {
    disposeLine(footLine); footLine = null
    if (!points || points.length < 2) return
    const pts = points.map((p) => llaToVec(p.lat, p.lon, LIFT))
    const flat = []
    for (let i = 0; i + 1 < pts.length; i += 2) { const a = pts[i], b = pts[i + 1]; flat.push(a.x, a.y, a.z, b.x, b.y, b.z) }
    footLine = fatSegments(flat, 0xb8e6fa, 1.6, 1, 6); scene.add(footLine)   // 与 GRD 等值线/Polygon 线同层(6)
  }
  // 多选：一组卫星各自的轨道圈/星下点轨迹/覆盖足迹（按各自颜色），primary 更亮更粗。
  let selSetGroup = null, selDotGroup = null   // selDotGroup：选中星「在轨点」大号圆点层（压在细轨道之上，随缩放联动）
  function disposeSelSet() {
    if (selSetGroup) {
      for (const l of selSetGroup.children) { l.geometry.dispose(); if (l.material) { lineMats.delete(l.material); l.material.dispose() } }
      scene.remove(selSetGroup); selSetGroup = null
    }
    disposeGroup(selDotGroup); selDotGroup = null   // 精灵点用 disposeGroup（连同 canvas 贴图一起释放）
  }
  // 合批：同样式的线并进一条 LineSegments2，线对象数与聚焦颗数无关（3 条 + primary 轨道 1 条），
  // 多选几百颗时重建与绘制都不再随颗数线性膨胀。Line2 内部本就把折线拆成相邻点对喂同一材质，
  // 故合批后画面与逐条画完全一致（颜色/线宽/透明度照旧，primary 仍单独一条以加粗加亮）。
  function pushStripSegs(out, pts) {
    for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1]; out.push(a.x, a.y, a.z, b.x, b.y, b.z) }
  }
  function setSelectionSet(items) {
    disposeSelSet()
    if (!items || !items.length) return
    selSetGroup = new THREE.Group()
    const dotG = new THREE.Group()
    const orbSeg = [], trkSeg = [], fpSeg = []
    for (const it of items) {
      // 轨道圈/星下点轨迹(金)/覆盖足迹(青) 都用与单选时相同的固定原色，多颗同时叠画；primary 仅加粗加亮以区分聚焦星（不用变色）
      // 轨道线宽收细（primary 1.3 / 其余 1.0）：与选中星「在轨点」大号圆点配合，点更醒目、线不再吃掉点
      if (it.orbit && it.orbit.length) {
        if (it.primary) selSetGroup.add(lineFromLLA(it.orbit, 0x6f9fc8, 0.9, 1.3))
        else pushStripSegs(orbSeg, it.orbit.map((p) => llaToVec(p.lat, p.lon, p.altKm || 0)))
      }
      if (it.track && it.track.length) pushStripSegs(trkSeg, it.track.map((p) => llaToVec(p.lat, p.lon, LIFT)))
      if (it.footprint && it.footprint.length > 1) {
        const pts = it.footprint.map((p) => llaToVec(p.lat, p.lon, LIFT))
        for (let i = 0; i + 1 < pts.length; i += 2) { const a = pts[i], b = pts[i + 1]; fpSeg.push(a.x, a.y, a.z, b.x, b.y, b.z) }
      }
      // 选中星「在轨点」：在卫星真实在轨位置画大号圆点，跟随星点原色。renderOrder 7 > 轨道线 6 → 同深度时点画在线之上，不被细轨道盖住；
      // makeDot 自带 depthTest 开 → 背面星点仍由不透明地球深度天然剔除（绝不能关 depthTest）。随缩放联动见 rescaleMarkers。
      if (it.satPos && Number.isFinite(it.satPos.lat) && Number.isFinite(it.satPos.lon)) {
        const dot = makeDot(it.satPos.color || '#9fd0ef')
        dot.position.copy(llaToVec(it.satPos.lat, it.satPos.lon, it.satPos.altKm || 0))
        dot._px = it.primary ? SEL_DOT_PX_PRIMARY : SEL_DOT_PX; dot._ar = 1; dot.renderOrder = 7
        dotG.add(dot)
      }
    }
    if (orbSeg.length) selSetGroup.add(fatSegments(orbSeg, 0x6f9fc8, 1.0, 0.5, 6))
    if (trkSeg.length) selSetGroup.add(fatSegments(trkSeg, 0xe8c074, 1.6, 1, 6))
    if (fpSeg.length) selSetGroup.add(fatSegments(fpSeg, 0xb8e6fa, 1.6, 1, 6))
    scene.add(selSetGroup)
    if (dotG.children.length) { selDotGroup = dotG; scene.add(selDotGroup) }
  }
  function clearSelectionGeom() { setOrbit(null); setGroundTrack(null); setFootprint(null); setHighlight(null); disposeSelSet() }

  // 旋转相机使指定方向正对视图（搜索定位时用），保持当前距离
  function faceTo(vec) {
    if (!vec) return
    const dist = camera.position.length()
    camera.position.copy(vec).normalize().multiplyScalar(dist)
    controls.autoRotate = false
    controls.update()
  }
  // 键盘方向键：绕地心步进旋转（dAz 水平/经向、dPol 垂直/纬向，弧度）。保持相机距离，
  // 关自转并经 stopAutoRotate 同步按钮态；phi 夹在两极附近避免翻面。与 faceTo 一样直接改相机位后 update()。
  const _rotSph = new THREE.Spherical()
  const _rotOff = new THREE.Vector3()
  function rotateBy(dAz, dPol) {
    if (!dAz && !dPol) return
    _rotOff.copy(camera.position).sub(controls.target)
    _rotSph.setFromVector3(_rotOff)
    _rotSph.theta += (dAz || 0)
    _rotSph.phi = Math.max(1e-4, Math.min(Math.PI - 1e-4, _rotSph.phi + (dPol || 0)))
    _rotOff.setFromSpherical(_rotSph)
    camera.position.copy(controls.target).add(_rotOff)
    stopAutoRotate()
    controls.update()
  }
  function setAutoRotate(v) { controls.autoRotate = !!v }
  function setAutoRotateSpeed(v) { if (Number.isFinite(v)) controls.autoRotateSpeed = v }
  function setOnAutoRotateOff(fn) { onAutoRotateOff = fn }

  // ===================== GEO 卫星覆盖（仿小程序卫星覆盖，移到 3D 地球） =====================
  let covGroup = null
  // 覆盖用小标签（波束名）：白字描边，depthTest 开 -> 背面被地球遮挡
  function makeCovLabel(text, hpx, color) {
    const fs = 50, pad = 8, font = `${fs}px ${UI_FONT}`, c = document.createElement('canvas')
    let x = c.getContext('2d'); x.font = font
    c.width = Math.ceil(x.measureText(text).width) + pad * 2; c.height = fs + pad * 2
    x = c.getContext('2d'); x.font = font; x.textBaseline = 'middle'; x.textAlign = 'center'
    // 文字描边套色(casing)：沿字形勾一圈与底色同调的窄边——专业制图标准，密集时也清晰，不用底色色块
    x.lineJoin = 'round'; x.miterLimit = 2
    x.lineWidth = 3.5; x.strokeStyle = 'rgba(6,11,18,0.82)'; x.strokeText(text, c.width / 2, c.height / 2)
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

  // ===================== 晨昏线 / 夜区 =====================
  // 夜区＝以「反日下点」为心、张角 90° 的球冠 —— 正好是 three.js SphereGeometry 的 thetaLength=π/2，
  // 零自定义三角化：建一个半球壳，再把它的 +Y 轴转到反日下点方向即可。
  // 球背面那半由深度测试自然剔除（陆/海球写深度，夜区壳 depthWrite=false 只读），无需手工裁剪。
  //
  // 渲染序 4.5：压在数据层（GRD 覆盖 5 / 等值线·波束·轨迹 6 / 经纬网 6.3 / 国界 6.5）【之下】。
  // 夜区是「打光」不是「数据」——它只该压暗底图，不该把覆盖场和等值线一起蒙灰、更不该盖住地理骨架。
  // 地球本身用 MeshBasicMaterial 不打光（见 :414），故这里走独立叠加层而非真实光照。
  //
  // ★ 半径与细分是【一对必须一起算】的参数，别单独调其中一个：
  //   陆地网格顶点严格在半径 1.0，但按 MAXSEG=3° 细分后三角形是弦，面心下陷到约 0.9996。
  //   夜区壳同理有弦切下陷 sag = 1 − cos(δ)，δ＝格子半对角。壳的【最低点】必须仍高于陆地的【最高点】1.0，
  //   否则两套疏密不同的球面剖分互相穿插 → 斜向摩尔纹条纹（v1.3.9 首版 R=1.0002 + 96×48 就是这么翻的：
  //   δ≈2.1° → 最低仅 0.99953，比陆地顶点还低 4.7e-4）。
  //   现取 R=1.0008 + 180×45：δ=√(1²+1²)=1.414° → sag=3.0e-4 → 最低 1.00050，比陆地高 5.0e-4，够。
  //   R 也不能一味加大：1.0008 相当于 5 km 高，再高地平处会看出夜区与地表错开的视差。
  //   另加 polygonOffset 朝相机偏一点作保险。这条不变式由 packages/core/test/terminatorRender.test.mjs 守着。
  const TERM_CAP_R = 1.0008, TERM_CAP_W = 180, TERM_CAP_H = 45
  const TERM_LINE_R = 1.0012   // 分界线：压在夜区壳之上（壳最高 1.0008），也远高于陆地
  const TERM_UP = new THREE.Vector3(0, 1, 0)
  let termGroup = null, termCap = null, termLine = null
  function clearTerminator() {
    if (!termGroup) return
    termGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { lineMats.delete(o.material); o.material.dispose() } })
    scene.remove(termGroup); termGroup = null; termCap = null; termLine = null
  }
  // 球冠几何【只建一次】：它随时刻变的只有朝向，改 quaternion 即可。
  // 首版每次调用整体重建，而本函数在实时模式每秒调一次、拖时间轴每帧调一次 —— 等于每秒重建 1.6 万个三角形。
  function ensureTerminator() {
    if (termGroup) return
    termGroup = new THREE.Group()
    termCap = new THREE.Mesh(
      new THREE.SphereGeometry(TERM_CAP_R, TERM_CAP_W, TERM_CAP_H, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x0a1120, transparent: true, opacity: 0.42, depthWrite: false,
        // FrontSide（非 DoubleSide）：始终从球外看，只会看到壳的外面；用 DoubleSide 则地平附近掠射的
        // 视线会穿过壳两次、叠两遍 alpha，沿晨昏线压出一条更暗的假边。
        side: THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
      })
    )
    termCap.renderOrder = 4.5
    termGroup.add(termCap)
    // 线：材质常驻（regMat 登记进 lineMats 由 resize 统一更新分辨率），几何每次重建——
    // 720 点的重建成本可忽略，且避免 LineGeometry.setPositions 反复换 buffer 留下不回收的 GPU 缓冲。
    termLine = new Line2(new LineGeometry(), regMat(new LineMaterial({
      color: 0xffd27a, linewidth: 1.2, transparent: true, opacity: 0.75, worldUnits: false, depthWrite: false
    })))
    termLine.renderOrder = 6.2
    termGroup.add(termLine)
    scene.add(termGroup)
  }
  // date = UTC 时刻（跟随时间轴，非系统时钟）；传 null 清层。
  // opts: { night:bool, line:bool, nightColor, nightOpacity, lineColor, lineWidth, lineOpacity, steps }
  function setTerminator(date, opts) {
    if (!date) { clearTerminator(); return }
    ensureTerminator()
    const o = opts || {}
    termCap.visible = o.night !== false
    if (termCap.visible) {
      const { anti } = solarGeometry(date)
      // SphereGeometry 的 theta 自 +Y 起算 → 把 +Y 转到反日下点方向，球冠即罩住整个夜半球
      termCap.quaternion.setFromUnitVectors(TERM_UP, llaToVec(anti.lat, anti.lon, 0).normalize())
      if (o.nightColor != null) termCap.material.color.setHex(o.nightColor)
      if (o.nightOpacity != null) termCap.material.opacity = o.nightOpacity
    }
    termLine.visible = o.line !== false
    if (termLine.visible) {
      const ring = terminatorRing(date, o.steps || 720)
      const flat = new Array((ring.length + 1) * 3)
      for (let i = 0; i <= ring.length; i++) {
        const p = ring[i % ring.length]   // 末点回到首点即闭合
        const v = llaToVec(p.lat, p.lon, 0).multiplyScalar(TERM_LINE_R)
        flat[i * 3] = v.x; flat[i * 3 + 1] = v.y; flat[i * 3 + 2] = v.z
      }
      termLine.geometry.dispose()
      const g = new LineGeometry(); g.setPositions(flat)
      termLine.geometry = g
      if (o.lineColor != null) termLine.material.color.setHex(o.lineColor)
      if (o.lineWidth != null) termLine.material.linewidth = o.lineWidth
      if (o.lineOpacity != null) termLine.material.opacity = o.lineOpacity
    }
  }

  // ===================== GRD 覆盖（独立图层：填充面 + 等值线，与烘焙 setCoverage 互不干扰） =====================
  // fillBands=[{color:[r,g,b], verts:Float64Array[x,y,...], counts:Int32Array}]（分带填充扁平几何，可空）；segGroups=[{segs:[[[lon,lat],[lon,lat]]...], color, width, opacity}]（逐档等值线，可空）；
  // opts={alpha}。整层一个 group，重设即整体替换。
  let covFieldGroup = null
  let covLayers = new Map()   // 层 id → { group, li }：每个覆盖层(天线·波束)独立子组，支持拖拽时按层增量重建
  let covOpts = {}
  function disposeCovGroup(grp) {
    grp.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { lineMats.delete(o.material); if (o.material.map) o.material.map.dispose(); o.material.dispose() } })
  }
  function clearCoverageField() {
    if (!covFieldGroup) return
    covRayGroup = null                 // 视轴子组挂在 covFieldGroup 下，随它一起被 disposeCovGroup 收走
    disposeCovGroup(covFieldGroup)
    scene.remove(covFieldGroup); covFieldGroup = null; covLayers = new Map()
  }

  // ===== STK Coverage 覆盖分析【专用通道】：独立于 GRD 覆盖场(setCoverageField/covFieldGroup)，互不覆写。=====
  // 一张 FOM 分带热力图（各胞元四角多边形上色），复用 makeFill/updateFill（贴球细分 + 持久缓冲）。
  // 静态快照：随算随画、不随时间轴每帧重建。renderOrder 略低于 GRD 覆盖(5) → 二者同显时 GRD 天线足迹在其上。
  let covGridGroup = null, covGridFill = null
  function clearCovGrid() {
    if (!covGridGroup) return
    disposeCovGroup(covGridGroup); scene.remove(covGridGroup); covGridGroup = null; covGridFill = null
  }
  function setCovGrid(layer, opts) {
    clearCovGrid()
    if (!layer || !layer.fillBands || !layer.fillBands.length) return
    const alpha = opts && opts.alpha != null ? opts.alpha : 0.82
    const g = new THREE.Group()
    covGridFill = makeFill(alpha)
    covGridFill.mesh.renderOrder = 4.9
    updateFill(covGridFill, layer.fillBands, alpha, 1.00058)
    g.add(covGridFill.mesh)
    covGridGroup = g; scene.add(g)
  }
  function setCovGridAlpha(a) { if (covGridFill) covGridFill.mat.opacity = a }

  // ===== 对星覆盖分析【轨道壳层专用通道】：波束打在球壳上的分带填充 + 等值线。=====
  // 与 GRD 对地覆盖(covFieldGroup)、STK Coverage(covGridGroup) 三条通道互不覆写，同屏可叠。
  // 层 L = { id, R(壳层地心半径 km), fillBands, segGroups, bore, name }：
  //   · 顶点是【地心】经纬度（壳层本就是地心球，llaToVec 也是纯地心球，两边同源，喂进去精确落在壳面）；
  //   · 且【已在参数域预细分】→ updateFill 走 preTess=true 跳过经纬度域细分（跨极点/接缝的坑见那边注释）。
  // ★ 场景单位：半径 1 = RE(6371 km 平均半径)，不是 WGS84 长半轴。故壳层半径一律由 R 现算，
  //   别拿「轨道高度」直接喂 llaToVec —— 两者差 7.137 km。
  let shellGroup = null, shellLayers = new Map(), shellOpts = {}
  const shellAlt = (R) => R - RE          // R(km) → 场景 llaToVec 的 altKm
  function clearShellField() {
    if (!shellGroup) return
    disposeCovGroup(shellGroup)           // 含 sprite 纹理（material.map）一并释放
    scene.remove(shellGroup); shellGroup = null; shellLayers.clear()
  }
  // 一层的装饰（等值线 + 数值/名称/峰值标签 + 波束中心点）：与对地 buildDeco 同策略——相对填充轻量，每次重建。
  function buildShellDeco(L, o) {
    const out = []
    const la = shellAlt(L.R || RE)
    for (const grp of (L.segGroups || [])) {
      if (!grp.segs || !grp.segs.length) continue
      const flat = []
      for (const sg of grp.segs) {
        const a = llaToVec(sg[0][1], sg[0][0], la), b = llaToVec(sg[1][1], sg[1][0], la)
        flat.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
      out.push(fatSegments(flat, grp.color != null ? grp.color : 0xffffff, grp.width || 1.2, grp.opacity != null ? grp.opacity : 0.95, 6))
    }
    // 数值标签：每档一处（锚点由上游按等值线环给）
    if (o.showVal) for (const grp of (L.segGroups || [])) {
      if (grp.txt == null) continue
      for (const an of (grp.labels || [])) {
        const spr = makeCovLabel(String(grp.txt), (o.valSize || 12) / 533, '#ffffff')
        const pos = llaToVec(an[1], an[0], la)
        pos.addScaledVector(pos.clone().normalize(), spr.scale.y * 0.6)
        spr.position.copy(pos); spr.renderOrder = 12; out.push(spr)
      }
    }
    // 波束中心（峰值方向与壳层的交点）+ 波束名：与对地覆盖同款，只是锚在壳面上
    const b = L.bore
    if (b) {
      const anchor = llaToVec(b.lat, b.lon, la)
      // 连线不在这儿画：对星视图的射线是【天线视轴】那一条，由 setShellRays 单独出（波束打不到壳层时也得有）
      if (o.showBore) {
        const dot = new THREE.Mesh(new THREE.SphereGeometry((o.boreSize || 0.5) * 0.0014, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }))
        dot.position.copy(anchor); dot.renderOrder = 11; out.push(dot)
      }
      if (o.showName && L.name) {
        const spr = makeCovLabel(L.name, (o.nameSize || 16) / 533, '#ffffff')
        spr.center.set(0.5, -0.35); spr.position.copy(anchor); spr.renderOrder = 13; out.push(spr)
      }
      if (o.showPeak && b.peak != null) {
        const spr = makeCovLabel(b.peak.toFixed(2) + ' dB', (o.peakSize || 5) / 533, '#cfd6df')
        spr.center.set(0.5, 1.15); spr.position.copy(anchor); spr.renderOrder = 12; out.push(spr)
      }
    }
    return out
  }
  // 一层实体 { group, fill(持久填充网格), deco }：填充原地写回既有缓冲，装饰重建（对地 ensureLayerEntry 同款）。
  function ensureShellEntry(L, o, prev) {
    let entry = prev
    if (!entry) entry = { group: new THREE.Group(), fill: null, deco: [] }
    else disposeDeco(entry)
    const R = L.R || RE
    const alpha = L.alpha != null ? L.alpha : (o.alpha != null ? o.alpha : 0.55)
    if (L.fillBands && L.fillBands.length) {
      if (!entry.fill) {
        entry.fill = makeFill(alpha)
        entry.fill.mesh.renderOrder = 4.7                      // 低于 GRD 对地覆盖(5)：同屏时地表足迹压在壳层之上
        entry.group.add(entry.fill.mesh)
      }
      updateFill(entry.fill, L.fillBands, alpha, R / RE, true) // 已在参数域预细分 → 跳过经纬度域细分
    } else if (entry.fill) { entry.fill.mesh.visible = false; if (entry.fill.geo.index) entry.fill.geo.setDrawRange(0, 0) }
    const deco = buildShellDeco(L, o)
    for (const d of deco) entry.group.add(d)
    entry.deco = deco
    return entry
  }
  function setShellField(layers, opts) {
    clearShellField()
    shellOpts = opts || {}
    if (!(layers || []).length) return
    shellGroup = new THREE.Group()
    scene.add(shellGroup)
    updateShellField(layers, shellOpts)
  }
  // 全量【增量】更新：按层 id 复用上一轮实体（填充网格原地写回顶点缓冲，只重建线与标签），
  // 只有真正消失的 id 才销毁。
  // ★ 时间推进走这条，不走 setShellField —— 后者是整组销毁重建（每拍 makeFill + 全量上传 + 标签纹理
  //   重烘），正是对星视图「点播放就卡」的大头。两条路出来的画面逐字一致（层内容全由 L 定，与建层路径无关）。
  function updateShellField(layers, opts) {
    if (!shellGroup) { setShellField(layers, opts); return }
    if (opts) shellOpts = opts
    const o = shellOpts, seen = new Set()
    let auto = 0
    for (const L of (layers || [])) {
      const id = L.id != null ? L.id : '#' + auto++
      const prev = shellLayers.get(id)
      const entry = ensureShellEntry(L, o, prev)
      if (!prev) { shellLayers.set(id, entry); shellGroup.add(entry.group) }
      seen.add(id)
    }
    for (const [id, e] of [...shellLayers]) {
      if (seen.has(id)) continue
      shellGroup.remove(e.group); disposeCovGroup(e.group); shellLayers.delete(id)
    }
  }
  function setShellFieldAlpha(a) { for (const e of shellLayers.values()) if (e.fill) e.fill.mat.opacity = a }

  // 壳层参照网（经纬 30° 稀疏球面格网）：等值线悬在空中没有「面」的落点，画一层极淡的格网当参照。
  // 与场数据分开成组：改指向/电平时只重建场，参照网不动。list=[{R, color, alpha}]。
  let shellGuideGroup = null
  function clearShellGuides() {
    if (!shellGuideGroup) return
    shellGuideGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose() })
    scene.remove(shellGuideGroup); shellGuideGroup = null
  }
  function setShellGuides(list) {
    clearShellGuides()
    if (!list || !list.length) return
    const g = new THREE.Group()
    for (const sh of list) {
      const la = shellAlt(sh.R), pos = []
      const push = (lat, lon) => { const v = llaToVec(lat, lon, la); pos.push(v.x, v.y, v.z) }
      for (let lon = -180; lon < 180; lon += 30) {                       // 经线
        for (let lat = -90; lat < 90; lat += 5) { push(lat, lon); push(lat + 5, lon) }
      }
      for (let lat = -60; lat <= 60; lat += 30) {                        // 纬线
        for (let lon = -180; lon < 180; lon += 5) { push(lat, lon); push(lat, lon + 5) }
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(sh.color != null ? sh.color : 0x6b8199), transparent: true, opacity: sh.alpha != null ? sh.alpha : 0.14, depthWrite: false })
      const ls = new THREE.LineSegments(geo, mat)
      ls.renderOrder = 4.6; ls.frustumCulled = false
      g.add(ls)
    }
    shellGuideGroup = g; scene.add(g)
  }

  // 波束射线（对星覆盖分析）：从卫星沿天线视轴射出去的一条线。与「卫星↔波束中心」的连线不同，它
  // 【不依赖有没有画出覆盖】—— 波束转到空无一物的方向时，这条线就是唯一还看得见的把手（拖拽时全靠它）。
  // list = [{ from:{lon,lat,rKm}, to:{lon,lat,rKm}, color? }]：地心经纬度 + 地心半径 km（与壳层层同一口径，
  // 半径经 shellAlt(R)=R−RE 换算成场景高度；别拿「轨道高度」直接喂 llaToVec，两者差 7.137 km）。
  let shellRayGroup = null
  function clearShellRays() {
    if (!shellRayGroup) return
    shellRayGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { lineMats.delete(o.material); o.material.dispose() } })
    scene.remove(shellRayGroup); shellRayGroup = null
  }
  function setShellRays(list) {
    clearShellRays()
    if (!list || !list.length) return
    const g = new THREE.Group()
    for (const ry of list) {
      if (!ry || !ry.from || !ry.to) continue
      const a = llaToVec(ry.from.lat || 0, ry.from.lon, shellAlt(ry.from.rKm || RE))
      const b = llaToVec(ry.to.lat || 0, ry.to.lon, shellAlt(ry.to.rKm || RE))
      g.add(fatStrip([a, b], new THREE.Color(ry.color != null ? ry.color : 0xffb14a), ry.width != null ? ry.width : 1.2, ry.opacity != null ? ry.opacity : 0.75, 6))
    }
    shellRayGroup = g; scene.add(g)
  }

  // ===== 环境场【专用通道】：一张等经纬贴图（ITU 降雨率/零度等温线/海拔…）+ 逐档等值线 =====
  // 连续场用贴图而不是分带多边形：一个 draw call、零细分，避开覆盖填充那条球面细分的老性能坑。
  //
  // 半径挑在【陆地网格(1.0) 与 岸线/国界(1.0004/1.0005) 之间】：场压住海陆填色，岸线国界仍压在场之上
  // ——与 2D 侧「地物线在场之上」的制图口径一致。renderOrder 4.5 < 覆盖网格 4.9 < GRD 覆盖 5。
  //
  // 贴图定向（phiStart/thetaStart 的推导见 ../env/envSphere.js，那里有对应的离屏单测——
  //「贴图偏 90°／上下颠倒」在代码里看不出来，只有把球建出来逐点比对才发现得了）。
  let envMesh = null, envTex = null, envKey = '', envLineGroup = null
  function clearEnvRaster() {
    if (envMesh) { scene.remove(envMesh); envMesh.geometry.dispose(); envMesh.material.dispose(); envMesh = null }
    if (envTex) { envTex.dispose(); envTex = null }
    envKey = ''
  }
  function setEnvRaster(canvas, opts) {
    const o = opts || {}
    if (!canvas) { clearEnvRaster(); return }
    const bb = o.bbox || { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }
    const alpha = o.alpha != null ? o.alpha : 0.78
    const key = [bb.lonMin, bb.lonMax, bb.latMin, bb.latMax].join(',')
    if (envMesh && key !== envKey) { scene.remove(envMesh); envMesh.geometry.dispose(); envMesh.material.dispose(); envMesh = null }
    if (!envMesh) {
      const P = envSphereParams(bb)
      const geo = new THREE.SphereGeometry(P.radius, P.widthSeg, P.heightSeg, P.phiStart, P.phiLength, P.thetaStart, P.thetaLength)
      const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: alpha, depthWrite: false, side: THREE.FrontSide })
      envMesh = new THREE.Mesh(geo, mat); envMesh.renderOrder = 4.5; envMesh.frustumCulled = false
      scene.add(envMesh); envKey = key
    }
    if (envTex) envTex.dispose()
    envTex = new THREE.CanvasTexture(canvas)
    envTex.colorSpace = THREE.SRGBColorSpace
    // 分级填色要看得见档与档的硬边界（那条边界就是等值线）→ 放大时用最近邻，否则线性
    envTex.magFilter = o.smooth === false ? THREE.NearestFilter : THREE.LinearFilter
    envTex.minFilter = THREE.LinearMipmapLinearFilter
    envTex.anisotropy = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1
    envMesh.material.map = envTex
    envMesh.material.opacity = alpha
    envMesh.material.needsUpdate = true
  }
  function setEnvAlpha(a) { if (envMesh) envMesh.material.opacity = a }
  // 等值线：与 2D 同一份经纬折线，逐档一个 LineSegments2（整档打包成一条批，几百条线也只一个 draw call）
  function clearEnvContours() {
    if (!envLineGroup) return
    envLineGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { lineMats.delete(o.material); o.material.dispose() } })
    scene.remove(envLineGroup); envLineGroup = null
  }
  function setEnvContours(groups) {
    clearEnvContours()
    if (!groups || !groups.length) return
    const g = new THREE.Group()
    for (const grp of groups) {
      const flat = []
      for (const ln of (grp.lines || [])) {
        for (let i = 1; i < ln.length; i++) {
          const a = llaToVec(ln[i - 1][1], ln[i - 1][0], 0).multiplyScalar(ENV_R + 0.0001)
          const b = llaToVec(ln[i][1], ln[i][0], 0).multiplyScalar(ENV_R + 0.0001)
          flat.push(a.x, a.y, a.z, b.x, b.y, b.z)
        }
      }
      if (!flat.length) continue
      g.add(fatSegments(flat, new THREE.Color(grp.color || '#ffffff'), grp.width || 1, 1, 4.6))
    }
    envLineGroup = g; scene.add(g)
  }
  function clearEnv() { clearEnvRaster(); clearEnvContours() }
  // 分带填充：与 2D 同源——直接用 bandGeometry 逐三角形切出的各档环带多边形（lon/lat）构网格。
  // 每个凸多边形扇形三角化，顶点色 = 该档颜色 → 填充边界即等值线、精确重合，无毛刺。地平/接缝裁剪
  // 已在 bandGeometry 内完成（多边形已切在 0°仰角线内、跨缝已解缠），无需再在着色器里 discard。
  // 持久化填充网格（拖拽热路径核心）：几何/材质/缓冲只建一次，每帧把新顶点【写回既有缓冲】并标记更新，
  // 仅在容量不足时才扩容重分配 → 不再每帧 new BufferGeometry/Material/Mesh 并整块重传 GPU（旧版每帧
  // dispose+重建是 GPU churn / command_buffer 崩溃风险的根因），同时内联 lla→vec 免去逐顶点 new Vector3。
  function makeFill(alpha) {
    const geo = new THREE.BufferGeometry()
    // frustumCulled=false → 该网格的 boundingSphere 永不参与裁剪/拾取，故设一个固定大球占位，
    // updateFill 不再每帧 computeBoundingSphere（大波束十几万顶点的逐帧遍历，纯属浪费）。
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2)
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: alpha != null ? alpha : 0.85, side: THREE.DoubleSide, depthWrite: false })
    const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = 5; mesh.frustumCulled = false
    return { geo, mat, mesh, posArr: null, colArr: null, idxArr: null, vcap: 0, icap: 0 }
  }
  const D2R_ = Math.PI / 180
  // 覆盖填充面片贴球细分：lon/lat 平面上的大三角形直接投到球面会塌成弦、切入不透明地球被深度剔除 → 3D 上
  // 表现为覆盖区里的斜向条纹（2D 平面图无深度/无球面，不受影响）。与陆地 buildLandMesh / Polygon 填充同口径：
  // 逐三角按最长边 >2° 二分细分后再投球面，使填充紧贴球面、任意图层抬升(li)下都不下沉。栈式 DFS 零分配。
  const _COV_MAXSEG2 = 4                     // 最长边阈值（度²）：≤2°；2° 弦下垂≈1.5e-4 < 填充抬升(≥6e-4)，不被地球吃
  const _covSub = new Float64Array(7 * 256)  // 细分 DFS 栈：每三角 7 float（ax,ay,bx,by,cx,cy,depth）
  // fillBands=[{color:[r,g,b], verts:Float64Array[x,y,...], counts:Int32Array(各多边形顶点数)}]（bandGeometry 扁平输出，零分配）。
  // 细分后叶三角输出【独立顶点】（不共享，索引顺序递增）；顶点数与数据相关 → 先数一遍精确定容量再写入
  // （两趟细分极廉价，远小于逐帧投影开销；持久缓冲仅在不足时 ×2 扩容，拖拽热路径不每帧重分配）。
  // preTess：调用方已把多边形细分好（对星覆盖的壳层层在【参数域】里细分——见 shellProj.tessellateFills），
  //   此时必须跳过下面这套【经纬度域】细分：壳层投影可能跨极点/跨 ±180°，在经纬度域里对半劈会横穿整个球。
  function updateFill(fm, fillBands, alpha, lift, preTess = false) {
    if (alpha != null) fm.mat.opacity = alpha
    const St = _covSub
    let n = 0, triN = 0, cr = 0, cg = 0, cb = 0
    let pos = null, col = null, idx = null
    const emitVert = (lon, lat) => {   // 内联 llaToVec(lat,lon,0)*lift（球半径 1）→ 免逐顶点 Vector3 分配
      const phi = (90 - lat) * D2R_, theta = (lon + 180) * D2R_, sp = Math.sin(phi), o3 = n * 3
      pos[o3] = -lift * sp * Math.cos(theta); pos[o3 + 1] = lift * Math.cos(phi); pos[o3 + 2] = lift * sp * Math.sin(theta)
      col[o3] = cr; col[o3 + 1] = cg; col[o3 + 2] = cb; idx[n] = n; n++
    }
    const countLeaf = () => { triN++ }
    const emitLeaf = (ax, ay, bx, by, cx, cy) => { emitVert(ax, ay); emitVert(bx, by); emitVert(cx, cy) }
    // 逐三角最长边二分到 ≤2°，对每个叶三角调 leaf(ax,ay,bx,by,cx,cy)。栈满/超深兜底为不细分（图面退化不崩）。
    const subdivide = (ax, ay, bx, by, cx, cy, leaf) => {
      let sp = 0
      St[sp++] = ax; St[sp++] = ay; St[sp++] = bx; St[sp++] = by; St[sp++] = cx; St[sp++] = cy; St[sp++] = 0
      while (sp > 0) {
        const d = St[--sp], Cy = St[--sp], Cx = St[--sp], By = St[--sp], Bx = St[--sp], Ay = St[--sp], Ax = St[--sp]
        const ab = (Ax - Bx) * (Ax - Bx) + (Ay - By) * (Ay - By)
        const bc = (Bx - Cx) * (Bx - Cx) + (By - Cy) * (By - Cy)
        const ca = (Cx - Ax) * (Cx - Ax) + (Cy - Ay) * (Cy - Ay)
        const mx = ab > bc ? (ab > ca ? ab : ca) : (bc > ca ? bc : ca)
        if (d >= 14 || mx <= _COV_MAXSEG2 || sp + 14 > St.length) { leaf(Ax, Ay, Bx, By, Cx, Cy); continue }
        if (mx === ab) {
          const mX = (Ax + Bx) * 0.5, mY = (Ay + By) * 0.5
          St[sp++] = Ax; St[sp++] = Ay; St[sp++] = mX; St[sp++] = mY; St[sp++] = Cx; St[sp++] = Cy; St[sp++] = d + 1
          St[sp++] = mX; St[sp++] = mY; St[sp++] = Bx; St[sp++] = By; St[sp++] = Cx; St[sp++] = Cy; St[sp++] = d + 1
        } else if (mx === bc) {
          const mX = (Bx + Cx) * 0.5, mY = (By + Cy) * 0.5
          St[sp++] = Bx; St[sp++] = By; St[sp++] = mX; St[sp++] = mY; St[sp++] = Ax; St[sp++] = Ay; St[sp++] = d + 1
          St[sp++] = mX; St[sp++] = mY; St[sp++] = Cx; St[sp++] = Cy; St[sp++] = Ax; St[sp++] = Ay; St[sp++] = d + 1
        } else {
          const mX = (Cx + Ax) * 0.5, mY = (Cy + Ay) * 0.5
          St[sp++] = Cx; St[sp++] = Cy; St[sp++] = mX; St[sp++] = mY; St[sp++] = Bx; St[sp++] = By; St[sp++] = d + 1
          St[sp++] = mX; St[sp++] = mY; St[sp++] = Ax; St[sp++] = Ay; St[sp++] = Bx; St[sp++] = By; St[sp++] = d + 1
        }
      }
    }
    // 一趟遍历：扇形三角化每个多边形，逐三角细分后交 leaf（count/emit 复用；color 逐 band 设，count 趟无害）。
    const run = (leaf) => {
      for (const fb of fillBands) {
        cr = fb.color[0] / 255; cg = fb.color[1] / 255; cb = fb.color[2] / 255
        const verts = fb.verts, counts = fb.counts
        let vi = 0
        for (let j = 0; j < counts.length; j++) {
          const plen = counts[j]
          const a0x = verts[vi * 2], a0y = verts[vi * 2 + 1]
          for (let q = 1; q < plen - 1; q++) {
            const bx = verts[(vi + q) * 2], by = verts[(vi + q) * 2 + 1]
            const cx = verts[(vi + q + 1) * 2], cy = verts[(vi + q + 1) * 2 + 1]
            if (preTess) leaf(a0x, a0y, bx, by, cx, cy)
            else subdivide(a0x, a0y, bx, by, cx, cy, leaf)
          }
          vi += plen
        }
      }
    }
    triN = 0; run(countLeaf)                  // 第一趟：数叶三角，精确定容量
    if (!triN) { fm.mesh.visible = false; if (fm.geo.index) fm.geo.setDrawRange(0, 0); return }
    fm.mesh.visible = true
    const needV = triN * 3
    if (needV > fm.vcap) {                     // 扩容：×2 预留，避免拖拽中频繁重分配
      fm.vcap = needV * 2
      fm.posArr = new Float32Array(fm.vcap * 3); fm.colArr = new Float32Array(fm.vcap * 3)
      fm.geo.setAttribute('position', new THREE.BufferAttribute(fm.posArr, 3))
      fm.geo.setAttribute('color', new THREE.BufferAttribute(fm.colArr, 3))
      fm.icap = fm.vcap; fm.idxArr = new Uint32Array(fm.icap); fm.geo.setIndex(new THREE.BufferAttribute(fm.idxArr, 1))
    }
    pos = fm.posArr; col = fm.colArr; idx = fm.idxArr
    n = 0; run(emitLeaf)                       // 第二趟：写顶点/颜色/顺序索引
    fm.geo.setDrawRange(0, n)
    fm.geo.attributes.position.needsUpdate = true
    fm.geo.attributes.color.needsUpdate = true
    fm.geo.index.needsUpdate = true
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
    // 波束中心（boresight）：白点 + 指向所属卫星的连线。波束名贴中心【上方】、峰值贴【下方】，
    // 用 billboard 的 center 在【屏幕方向】上下分置（旧版按半径抬高，屏幕上几乎重合）。
    const b = L.bore
    if (b) {
      // 中心点锚（贴地）：白点 + 卫星连线落点
      const anchor = llaToVec(b.lat, b.lon, 0).multiplyScalar(1.0012)
      // 文字锚：径向再抬出 ~45km。billboard 整体深度≈锚点深度，抬到球面之前 → 标签（尤其位于中心点下方的峰值）
      // 不再被地球模型遮挡；depthTest 仍为真，背面波束的标签照常被球体隐藏。
      const labelAnchor = llaToVec(b.lat, b.lon, 45)
      // 视轴不在这儿画：它是【一根天线一条】（opts.rays，由 buildAxisRays 出），不是逐波束的连线。
      // 原先每个波束层都画一条卫星→波束中心的粗线，94 波束就是每次重建 94 次几何分配 —— 播放时的卡顿大头之一。
      if (o.showBore) {
        const dotR = (o.boreSize || 0.5) * 0.0014
        const dot = new THREE.Mesh(new THREE.SphereGeometry(dotR, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }))
        dot.position.copy(anchor); dot.renderOrder = 11; out.push(dot)
      }
      // 波束中心峰值 dB：中心点【下方】，中性次级色（弱于波束名，做读数，不再用卡通暖黄）
      if (o.showPeak && b.peak != null) {
        const spr = makeCovLabel(b.peak.toFixed(2) + ' dB', (o.peakSize || 5) / 533, '#cfd6df')
        spr.center.set(0.5, 1.15); spr.position.copy(labelAnchor); spr.renderOrder = 12; out.push(spr)
      }
      // 波束名：中心点【上方】
      if (o.showName && L.name) {
        const spr = makeCovLabel(L.name, (o.nameSize || 16) / 533, '#ffffff')
        spr.center.set(0.5, -0.35); spr.position.copy(labelAnchor); spr.renderOrder = 13; out.push(spr)
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
    setCovRays(covOpts.rays)
  }
  // 天线视轴（对地视图）：一根天线一条，不随波束数增长。自成一个子组，拖拽指向时只换这一组
  // ——不能跟着波束层走：那样 94 波束就是 94 条线、每次重建 94 次几何分配。
  let covRayGroup = null
  function clearCovRays() {
    if (!covRayGroup) return
    covRayGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { lineMats.delete(o.material); o.material.dispose() } })
    covRayGroup.parent && covRayGroup.parent.remove(covRayGroup)
    covRayGroup = null
  }
  function setCovRays(list) {
    clearCovRays()
    if (!covFieldGroup || !list || !list.length) return
    const g = new THREE.Group()
    for (const ry of list) {
      if (!ry || !ry.from || !ry.to) continue
      const a = llaToVec(ry.from.lat || 0, ry.from.lon, shellAlt(ry.from.rKm || RE))
      const b = llaToVec(ry.to.lat || 0, ry.to.lon, shellAlt(ry.to.rKm || RE))
      g.add(fatStrip([a, b], new THREE.Color(ry.color != null ? ry.color : 0xffb14a), ry.width != null ? ry.width : 1.2, ry.opacity != null ? ry.opacity : 0.75, 5))
    }
    covRayGroup = g; covFieldGroup.add(g)
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
    if (opts && opts.rays) setCovRays(opts.rays)   // 拖指向时视轴要跟着转（一条线，重建不心疼）
  }
  // 全量【增量】更新：按 id 复用上一轮的图层实体（填充网格原地写回顶点缓冲，只重建线与标签），
  // 只有真正消失的 id 才销毁。
  // ★ 时间推进走这条，不走 setCoverageField —— 后者是整组销毁重建，94 波束就是每次 94 个球面细分
  //   网格重新分配 + 重新上传，正是「点播放就卡」的大头。两条路出来的画面逐字一致（层序仍由 li 定：
  //   半径抬升与 renderOrder 都按 li 算，与场景图里的子节点顺序无关）。
  function updateCoverageField(layers, opts) {
    if (!covFieldGroup) { setCoverageField(layers, opts); return }
    if (opts) covOpts = opts
    const seen = new Set()
    let li = 0
    for (const L of (layers || [])) {
      const id = L.id != null ? L.id : '#' + li
      const prev = covLayers.get(id)
      const entry = ensureLayerEntry(L, covOpts, li, prev)
      if (!prev) { covLayers.set(id, entry); covFieldGroup.add(entry.group) }
      seen.add(id); li++
    }
    for (const [id, e] of [...covLayers]) {
      if (seen.has(id)) continue
      covFieldGroup.remove(e.group); disposeCovGroup(e.group); covLayers.delete(id)
    }
    setCovRays(covOpts.rays)
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
  //         labels:[{lon,lat,text,hpx?,color?,alt?}], sats:[{lon,lat,altKm,name,color?}],
  //         fills:[{p:[[lon,lat]...]（未闭合外环）, color, opacity}]（Polygon 区域填充） }
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
    // Polygon 区域填充：lon/lat 平面 earcut 三角化，再按最长边二分递归细分贴球——大三角形的平面弦
    // 会切入地球内部被深度测试吃掉（与折线 densify 同一问题）。细分中点取 lon/lat 线性中点，与边界线
    // densifyDeg 的线性插值几何一致。
    for (const f of (spec.fills || [])) {
      if (!f.p || f.p.length < 3) continue
      const ring = unwrapRing(f.p)
      const flat = []
      for (const q of ring) flat.push(q[0], q[1])
      const idx = earcut(flat, [])
      if (!idx.length) continue
      const pos = []
      // 半径 1.00075 + 最长边 ≤2°：2° 弦的最大下垂 ≈R·θ²/8≈1.5e-4，最低点 1.0006 仍高于陆地面(1.0004)不被吃；
      // 又低于本层线(1.0008)。
      const push = (q) => { const v = llaToVec(q[1], q[0], 0).multiplyScalar(1.00075); pos.push(v.x, v.y, v.z) }
      const e2 = (u, w) => { const dx = u[0] - w[0], dy = u[1] - w[1]; return dx * dx + dy * dy }
      const mid = (u, w) => [(u[0] + w[0]) / 2, (u[1] + w[1]) / 2]
      const sub = (a, b, c, depth) => {
        const ab = e2(a, b), bc = e2(b, c), ca = e2(c, a), mx = Math.max(ab, bc, ca)
        if (depth >= 14 || mx <= 4) { push(a); push(b); push(c); return }   // 最长边 ≤2°
        if (mx === ab) { const m = mid(a, b); sub(a, m, c, depth + 1); sub(m, b, c, depth + 1) }
        else if (mx === bc) { const m = mid(b, c); sub(b, m, a, depth + 1); sub(m, c, a, depth + 1) }
        else { const m = mid(c, a); sub(c, m, b, depth + 1); sub(m, a, b, depth + 1) }
      }
      for (let t = 0; t < idx.length; t += 3) {
        const i0 = idx[t] * 2, i1 = idx[t + 1] * 2, i2 = idx[t + 2] * 2
        sub([flat[i0], flat[i0 + 1]], [flat[i1], flat[i1 + 1]], [flat[i2], flat[i2 + 1]], 0)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      // 与 GRD 覆盖的叠加规则（2D/3D 统一）：填充画在覆盖场之前（renderOrder 4 < 覆盖 5）——
      // 叠加区只显示覆盖图颜色，Polygon 在该处只剩边线（边线 renderOrder 6 始终在覆盖之上）。
      // 半径 1.00075 仅为高于陆地面不被地形吃掉；混合先后由 renderOrder 决定，与半径无关（均不写深度）。
      const op = Math.max(0, Math.min(1, f.opacity != null ? f.opacity : 0.18))
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: f.color != null ? f.color : 0x66ddff, transparent: true, opacity: op, side: THREE.DoubleSide, depthWrite: false
      }))
      mesh.renderOrder = 4
      g.add(mesh)
    }
    for (const ln of (spec.lines || [])) {
      if (!ln.p || ln.p.length < 2) continue
      const pts = ln.p.map(([lon, lat]) => llaToVec(lat, lon, 0).multiplyScalar(1.0008))
      if (ln.closed !== false) pts.push(pts[0].clone())
      g.add(fatStrip(pts, ln.color != null ? ln.color : 0x66ddff, ln.width || 1.4, ln.opacity != null ? ln.opacity : 0.92, 6))
    }
    for (const d of (spec.dots || [])) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(d.r || 0.009, 12, 12), new THREE.MeshBasicMaterial({ color: d.color != null ? d.color : 0xffd27a }))
      dot.position.copy(llaToVec(d.lat, d.lon, 0).multiplyScalar(1.002)); dot.renderOrder = 11; g.add(dot)   // 1.002：抬离陆地面(1.0004)，斜视角不被地表吃掉
    }
    for (const l of (spec.labels || [])) {
      const spr = makeCovLabel(l.text, l.hpx, l.color)
      spr.position.copy(llaToVec(l.lat, l.lon, l.alt != null ? l.alt : 60)); spr.renderOrder = 12
      // top：关深度测试（不被球面裁切/遮挡）+ _dir 半球剔除（转到背面由 updateLabels 淡出隐藏），
      // 与国家名/标记文字同一套策略；未标 top 的（如仰角线角度标注）维持原有开深度测试行为。
      if (l.top) { spr.material.depthTest = false; spr._dir = spr.position.clone().normalize() }
      g.add(spr)
    }
    // 卫星名：显示仰角线的卫星，在其真实位置（轨道高度处）画名称（颜色随该星仰角线色）；不画星点本体
    for (const s of (spec.sats || [])) {
      if (s.lon == null || !Number.isFinite(s.lat) || !s.name || s.labelShow === false) continue
      const spr = makeCovLabel(s.name, (s.labelSize || 9) / 533, s.nameColor)
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
  // 拖拽波束（对地）/ 拖数值标签 专用拾取：命中地球取落点；未命中（光标推出地球轮廓）按
  // 【方位不变、极角钉在地平圈】给点，让拖拽贴着地平推到可见极限。
  // 别拿「射线对球心的最近趋近点」当兜底：那个点的极角是 90°−ψ，光标越往外拖落点反而往回缩，
  // 到轮廓处折返，拖起来像被弹回去。这里用显式的 (轴, 面内垂向) 分解，全程单调。
  function pickGlobeOrLimb(clientX, clientY) {
    const hit = pickGlobe(clientX, clientY)
    if (hit) return hit
    const r = renderer.domElement.getBoundingClientRect()
    const ndcv = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndcv, camera)
    const o = ray.ray.origin, d = ray.ray.direction.clone().normalize()
    const D = o.length()
    if (!(D > 1)) return null
    const axis = o.clone().divideScalar(D)             // 地心 → 相机 单位矢量
    const cosPsi = -d.dot(axis)
    const perp = d.clone().addScaledVector(axis, cosPsi)
    const pl = perp.length()
    if (pl < 1e-9) return null
    perp.divideScalar(pl)
    const th = Math.acos(Math.min(1, 1 / D))           // 切点自轴起算的地心角（地平圈）
    return vecToLatLon(axis.multiplyScalar(Math.cos(th)).addScaledVector(perp, Math.sin(th)))
  }

  // ===== 对星覆盖分析的拖拽：绕【源星】转方向 =====
  // 不能沿用「光标落在某个球面上」那一套：源星常常根本不在画面里（GEO 源星在 6.6RE，相机看地球时它在视锥外），
  // 以它为心的拾取球也就无从抓起。这里改成【相机轴转台】：光标的屏幕位移 → 绕相机 右/上 轴转视轴，
  //   · 没有屏幕锚点，源星在不在画面里都能拖；
  //   · 转量随光标线性累加，不封顶 —— 4π 全向可达（一次拖不到就松开再拖，转角连续累加）；
  //   · 增益 = |相机→落点| / |源星→落点|，即「屏上转多少度、波束就跟着转多少度」的一阶跟手比例，
  //     GEO 打地球这类长射线增益 ≈0.36（拖得慢而准），近距离对星增益接近 1。
  // 回调给的是【世界系旋转四元数】而不是经纬度：指向是 3D 转动，用一个落点表达不了（少一个自由度）。
  let beamDragPivot = null, ttA = null
  const TT_GAIN = [0.12, 6]
  // 高度直接当场景高度用：这两个点只用来算增益（一个比值），差那 7 km 的 A/RE 口径无关紧要
  const llaVecOf = (p) => (p && Number.isFinite(p.lon) ? llaToVec(p.lat || 0, p.lon, p.altKm || 0) : null)
  // ★ 渲染系 → ECEF 的定轴换算（由 llaToVec 反推：渲染 (x,y,z) = ECEF (X, Z, −Y)，故反向是 (x, −z, y)）。
  //   转出去的四元数要作用在【ECEF 的视轴】上，轴不换算就是绕错轴转 —— 表现为「拖了半天只挪一点点、
  //   方向还不对」，且随卫星经度变化而变，极难从画面上看出来。
  const toEcefAxis = (v) => new THREE.Vector3(v.x, -v.z, v.y)
  function beginTurntable(clientX, clientY) {
    const S = llaVecOf(beamDragPivot && beamDragPivot.sat)
    if (!S) { ttA = null; return }
    const T = llaVecOf(beamDragPivot.tip)
    const L = T ? Math.max(1e-4, T.distanceTo(S)) : Math.max(1e-4, camera.position.distanceTo(S) * 0.5)
    const a = camera.position.distanceTo(T || S)
    ttA = {
      x: clientX, y: clientY,
      right: toEcefAxis(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize()),
      up: toEcefAxis(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize()),
      gain: Math.min(TT_GAIN[1], Math.max(TT_GAIN[0], a / L)),
      k: 2 * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, renderer.domElement.getBoundingClientRect().height)
    }
  }
  const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion()
  function turntableQuat(clientX, clientY) {
    if (!ttA) return null
    const ax = Math.atan((clientX - ttA.x) * ttA.k) * ttA.gain        // 右拖 → 视轴朝屏幕右转
    const ay = Math.atan((clientY - ttA.y) * ttA.k) * ttA.gain        // 下拖 → 视轴朝屏幕下转
    _q1.setFromAxisAngle(ttA.up, -ax)
    _q2.setFromAxisAngle(ttA.right, -ay)
    _q1.multiply(_q2)
    return { q: [_q1.x, _q1.y, _q1.z, _q1.w] }
  }
  const pickDragStart = (x, y) => { if (!beamDragPivot) return pickGlobeOrLimb(x, y); beginTurntable(x, y); return turntableQuat(x, y) }
  const pickDragMove = (x, y) => (beamDragPivot ? turntableQuat(x, y) : pickGlobeOrLimb(x, y))
  let onHover = null, onRightClick = null
  function setOnHover(fn) { onHover = fn }
  function setOnRightClick(fn) { onRightClick = fn }
  // 拖拽波束模式：左键拖动地球时不旋转，改为回调经纬度（拖动 boresight）
  let beamDragMode = false, onBeamDrag = null, beamDragging = false
  // 拖拽数值标签模式：左键拖动地球时不旋转，改为回调经纬度（拖动等值线数值标签沿线滑动）
  let labelDragMode = false, onLabelDrag = null, labelDragging = false
  // 协调区多边形 hold-to-draw：绘制态下左键按住沿路径拖动，按屏幕像素阈值连续加点（同样不旋转地球）。右键加点仍并存。
  let polyDrawMode = false, onPolyDraw = null, polyDrawing = false, drawLX = 0, drawLY = 0
  // 放置模式（波束合成）：左键点击（未拖动）在球面落点回调 onPlace(ll)；拖动仍旋转地球
  let placeMode = false, onPlace = null
  const POLY_DRAW_MIN2 = 14 * 14   // 相邻加点最小屏幕间距²（px）
  const updateRotate = () => { controls.enableRotate = !(beamDragMode || labelDragMode || polyDrawMode) }   // 拖波束/拖标签/绘制态均停旋转
  function setBeamDragMode(v) { beamDragMode = !!v; if (!v) beamDragging = false; updateRotate(); renderer.domElement.style.cursor = beamDragMode ? 'move' : (labelDragMode ? 'move' : (polyDrawMode ? 'crosshair' : '')) }
  function setOnBeamDrag(fn) { onBeamDrag = fn }
  // 拖拽的拾取方式：给 {sat:{lon,lat,altKm}, tip:{lon,lat,altKm}} → 绕源星转方向（对星覆盖分析，
  // tip=当前视轴落点，只用来定转动增益）；给 null → 回到地表落点拾取（对地覆盖分析）。
  function setBeamDragPivot(p) {
    beamDragPivot = (p && p.sat && Number.isFinite(p.sat.lon)) ? { sat: p.sat, tip: p.tip || null } : null
  }
  function setLabelDragMode(v) { labelDragMode = !!v; if (!v) labelDragging = false; updateRotate(); renderer.domElement.style.cursor = labelDragMode ? 'move' : (beamDragMode ? 'move' : (polyDrawMode ? 'crosshair' : '')) }
  function setOnLabelDrag(fn) { onLabelDrag = fn }
  function setPolyDrawMode(v) { polyDrawMode = !!v; polyDrawing = false; updateRotate(); renderer.domElement.style.cursor = polyDrawMode ? 'crosshair' : (beamDragMode ? 'move' : (placeMode ? 'crosshair' : '')) }
  // 放置模式（波束合成）：不停旋转（拖动仍导航），仅把「无拖动的左键点击」变为落点
  function setPlaceMode(v) { placeMode = !!v; renderer.domElement.style.cursor = placeMode ? 'crosshair' : (polyDrawMode ? 'crosshair' : ((beamDragMode || labelDragMode) ? 'move' : '')) }
  function setOnPlace(fn) { onPlace = fn }
  function setOnPolyDraw(fn) { onPolyDraw = fn }
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (beamDragging) { const ll = pickDragMove(e.clientX, e.clientY); if (ll && onBeamDrag) onBeamDrag(ll, 'move') }
    if (labelDragging) { const ll = pickGlobeOrLimb(e.clientX, e.clientY); if (ll && onLabelDrag) onLabelDrag(ll, 'move') }
    if (polyDrawing) { const dx = e.clientX - drawLX, dy = e.clientY - drawLY; if (dx * dx + dy * dy >= POLY_DRAW_MIN2) { drawLX = e.clientX; drawLY = e.clientY; const ll = pickGlobe(e.clientX, e.clientY); if (ll && onPolyDraw) onPolyDraw(ll, 'move') } }
    if (onHover) onHover(pickGlobe(e.clientX, e.clientY))
  })
  renderer.domElement.addEventListener('pointerleave', () => { if (onHover) onHover(null) })
  renderer.domElement.addEventListener('contextmenu', (e) => { e.preventDefault(); if (onRightClick) onRightClick(pickGlobe(e.clientX, e.clientY), { x: e.clientX, y: e.clientY }) })

  // 地球站图标（J4：精致立体卡塞格伦天线——淡填充碟面 + 边缘高光 + 四脚馈源 + 叉臂座架 + 落影），共用一张贴图
  const STATION_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>" +
    "<ellipse cx='32' cy='58' rx='12' ry='2' fill='#000000' opacity='0.18'/>" +
    "<path d='M23 57 L28 43 L36 43 L41 57 Z' fill='#c3c8cd' stroke='#9aa1a8' stroke-width='0.6'/>" +
    "<path d='M32 57 L36 43 L41 57 Z' fill='#000000' opacity='0.05'/>" +
    "<ellipse cx='32' cy='43' rx='4' ry='1.5' fill='#dde1e4'/>" +
    "<rect x='29.8' y='33' width='4.4' height='11' rx='0.9' fill='#b9bec3' stroke='#9aa1a8' stroke-width='0.5'/>" +
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

  // 聚焦卫星图标（与 2D 平面图 drawSatIcon 同款矢量：双侧 3×2 太阳能板 + 中央星体），白色，复用一张贴图
  const FOCUS_SAT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'>" +
    "<g fill='#ffffff' stroke='rgba(8,12,18,0.92)' stroke-width='4' stroke-linejoin='round' transform='rotate(-20 60 60)'>" +
    "<rect x='8' y='41' width='10' height='16' rx='3'/><rect x='21' y='41' width='10' height='16' rx='3'/><rect x='34' y='41' width='10' height='16' rx='3'/>" +
    "<rect x='8' y='63' width='10' height='16' rx='3'/><rect x='21' y='63' width='10' height='16' rx='3'/><rect x='34' y='63' width='10' height='16' rx='3'/>" +
    "<rect x='76' y='41' width='10' height='16' rx='3'/><rect x='89' y='41' width='10' height='16' rx='3'/><rect x='102' y='41' width='10' height='16' rx='3'/>" +
    "<rect x='76' y='63' width='10' height='16' rx='3'/><rect x='89' y='63' width='10' height='16' rx='3'/><rect x='102' y='63' width='10' height='16' rx='3'/>" +
    "<rect x='49' y='35' width='22' height='50' rx='10'/></g></svg>"
  let focusSatTex = null
  function focusSatTexture() {
    if (focusSatTex) return focusSatTex
    focusSatTex = new THREE.Texture(); focusSatTex.colorSpace = THREE.SRGBColorSpace
    const img = new Image(); img.onload = () => { focusSatTex.image = img; focusSatTex.needsUpdate = true }
    img.src = 'data:image/svg+xml;base64,' + btoa(FOCUS_SAT_SVG)
    return focusSatTex
  }
  // 圆点精灵：同色共用一份贴图 + 一份材质。多选聚焦几百颗时，每次刷新都为每颗现画一张 32px canvas
  // 并上传纹理是纯固定开销；缓存后同色只做一次。共享件打 _shared 标记，disposeGroup 见到就跳过。
  // （调用处只改 position/scale/renderOrder，从不改材质属性，故材质可安全共享。）
  const dotCache = new Map()
  function makeDot(hex) {
    let hit = dotCache.get(hex)
    if (!hit) {
      const s = 32, c = document.createElement('canvas'); c.width = c.height = s
      const x = c.getContext('2d')
      x.beginPath(); x.arc(16, 16, 9, 0, Math.PI * 2); x.fillStyle = hex; x.fill()
      x.lineWidth = 3; x.strokeStyle = 'rgba(255,255,255,0.92)'; x.stroke()
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t._shared = true
      const m = new THREE.SpriteMaterial({ map: t, depthTest: true, depthWrite: false, transparent: true }); m._shared = true
      hit = { mat: m }
      dotCache.set(hex, hit)
    }
    return new THREE.Sprite(hit.mat)
  }

  let markersGroup = null, trajGroup = null, focusSatGroup = null
  function disposeGroup(grp) { if (grp) { grp.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && !o.material._shared) { lineMats.delete(o.material); if (o.material.map && !o.material.map._shared && o.material.map !== stationTex && o.material.map !== focusSatTex) o.material.map.dispose(); o.material.dispose() } }); scene.remove(grp) } }
  // 聚焦卫星当前星下点图标（与 2D 同款，固定 30px 基准——与 2D sizes.satIcon 默认值一致，随 3D 缩放联动）；
  // depthTest 关 + _dir 半球剔除，复用地球站图标同一套策略，转到背面自动隐藏，不会被地球遮挡。
  const FOCUS_SAT_PX = 30
  // p：单个 {lat,lon} 或数组（多选时每颗聚焦星各画一个图标，同款同大小，聚焦星区分靠轨道加粗+高亮环，图标本身不再分主次）
  // sizePx/colorHex 为全局默认（旧调用签名）；单点可用 q.px / q.colorHex 覆盖 —— 供聚焦星下点(白·30)
  // 与可见性可见星星下点(面板色·滑块大小)在同一 replace-all 通道里混绘（各自样式，互不覆盖）。
  function setFocusSatLLA(p, sizePx, colorHex) {
    disposeGroup(focusSatGroup); focusSatGroup = null
    const list = (Array.isArray(p) ? p : (p ? [p] : [])).filter((q) => q && Number.isFinite(q.lat) && Number.isFinite(q.lon))
    if (!list.length) return
    const pxG = Number(sizePx) > 0 ? Number(sizePx) : FOCUS_SAT_PX   // 可选大小（可见性分析按其滑块传入；默认 30 = 聚焦星）
    const tintG = Number.isFinite(colorHex) ? colorHex : 0xffffff    // 可选染色（白=纹理原色；可见性传图标色 → 与 2D 一致）
    const g = new THREE.Group()
    for (const q of list) {
      const px = Number(q.px) > 0 ? Number(q.px) : pxG                       // 单点大小覆盖
      const tint = Number.isFinite(q.colorHex) ? q.colorHex : tintG          // 单点染色覆盖
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: focusSatTexture(), color: tint, depthTest: false, depthWrite: false, transparent: true }))
      spr.position.copy(llaToVec(q.lat, q.lon, 0).multiplyScalar(1.0012))
      spr._px = px; spr._ar = 1; spr._dir = spr.position.clone().normalize(); spr.renderOrder = 17
      g.add(spr)
    }
    focusSatGroup = g; scene.add(g)
  }
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
    // 点标记圆点直径：用 2D 半径口径 sz.ptDot（默认 3.5）×2.2 换算到 3D 屏幕像素，保持与 2D 观感一致、可调
    const ptDotPx = (sz.ptDot != null ? sz.ptDot : 3.5) * 2.2
    disposeGroup(markersGroup); markersGroup = null
    const g = new THREE.Group()
    for (const p of (points || [])) {
      const dot = makeDot('#ffd24a'); dot.position.copy(llaToVec(p.lat, p.lon, 0).multiplyScalar(1.0012)); dot._px = ptDotPx; dot._ar = 1; dot.renderOrder = 15; g.add(dot)
      if (p.label) g.add(labelSprite(p.label, p.lat, p.lon, '#ffffff', -0.35, ptFont))   // 坐标：白字
      if (p.el) g.add(labelSprite(p.el, p.lat, p.lon, '#ffffff', 1.35, ptFont * 0.9))     // 聚焦卫星仰角：亮白，标记下方
    }
    for (const s of (stations || [])) {
      // 关闭深度测试 + 半球剔除（_dir）：与文字标签同策略。地球站图标是「从地表立起」的精灵，开 depthTest 时
      // 整张图按锚点(地表)深度参与测试，低视角/近地平边缘处上半部分会被更近的地球曲面截断遮挡。改为始终完整浮于
      // 地表之上，转到背面时由 rescaleMarkers 按 _dir 自动隐藏/淡出（不会透出地球背面的站点）。
      const st = new THREE.Sprite(new THREE.SpriteMaterial({ map: stationTexture(), depthTest: false, depthWrite: false, transparent: true }))
      st.position.copy(llaToVec(s.lat, s.lon, 0).multiplyScalar(1.0012)); st.center.set(0.5, 0); st._px = stIcon; st._ar = 1; st._dir = st.position.clone().normalize(); st.renderOrder = 15; g.add(st)
      if (s.name) g.add(labelSprite(s.name, s.lat, s.lon, '#ffffff', 0.82, stFont))   // 名称紧贴地球站底座下方：亮白
      if (s.el) g.add(labelSprite(s.el, s.lat, s.lon, '#ffffff', 1.87, stFont * 0.9))   // 聚焦卫星仰角：亮白，名称下方
    }
    markersGroup = g; scene.add(g)
  }
  function slerp(a, b, t) {
    const d = Math.max(-1, Math.min(1, a.dot(b))), ang = Math.acos(d)
    if (ang < 1e-6) return a.clone()
    const s = Math.sin(ang)
    return a.clone().multiplyScalar(Math.sin((1 - t) * ang) / s).add(b.clone().multiplyScalar(Math.sin(t * ang) / s))
  }
  // list:[{pts:[{lat,lon}], color, kind}]；sizes.trajDot 控制轨迹圆点大小（2D 半径口径，×2.5 换算到 3D 屏幕像素）
  function setTrajectories(list, sizes) {
    const trajDotPx = ((sizes && sizes.trajDot != null) ? sizes.trajDot : 2.5) * 2.5
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
      if (verts.length > 1) g.add(fatStrip(verts, tr.color != null ? tr.color : 0xff5a5a, 2.2, 0.95, 6))   // 与 GRD 等值线/Polygon 线同层(6)：压在国界(6.5)/省界(6.6)之下，与边界共存
      for (const p of pts) { const dot = makeDot(tr.kind === 'flight' ? '#5ad1ff' : '#ff9a5a'); dot.position.copy(llaToVec(p.lat, p.lon, 0).multiplyScalar(1.002)); dot._px = trajDotPx; dot._ar = 1; dot.renderOrder = 15; g.add(dot) }
    }
    trajGroup = g; scene.add(g)
  }
  // 标记/轨迹精灵每帧随缩放「均匀」联动：屏幕像素 = 设定像素 × zoomK，zoomK = 基准距离/相机到目标距离。
  // 默认视角(相机距=LABEL_REF_DIST) zoomK=1 → 即其设定的原始像素大小；拉近 zoomK>1 变大、拉远变小，与地名同步。
  // 用「相机→目标」统一系数（而非各标记自身距离）→ 全部标记同屏幕大小，不再近大远小。带 _dir 的文字做半球剔除。
  function rescaleMarkers() {
    const tanH = Math.tan(camera.fov * 0.5 * Math.PI / 180) || 1
    const cd = camera.position.clone().normalize()
    const zoomK = LABEL_REF_DIST / camera.position.distanceTo(controls.target)
    const go = (grp) => {
      if (!grp) return
      for (const o of grp.children) {
        if (o._dir) {   // 文字标签：近地平淡出，避免边缘跳变
          const dot = o._dir.dot(cd)
          if (dot <= 0.05) { o.visible = false; continue }
          o.visible = true; o.material.opacity = dot >= 0.22 ? 1 : (dot - 0.05) / 0.17
        }
        if (o._px) { const dd = camera.position.distanceTo(o.position); const h = o._px * zoomK * (2 * dd * tanH) / curH; o.scale.set(h * (o._ar || 1), h, 1) }
      }
    }
    go(markersGroup); go(trajGroup); go(focusSatGroup); go(selDotGroup)   // selDotGroup：选中星在轨点随缩放联动（无 _dir，靠 depthTest 挡背面）
  }

  let satPoints = null
  // positions: [{lat,lon,altKm}]；colors（可选）: Float32Array 长度 = positions.length*3 的逐点 RGB(0..1)。
  // 传 colors 时启用逐点顶点色（自定义星座按面/按星座上色）；不传则沿用统一的默认星点色。
  function setSatellites(positions, colors) {
    if (satPoints) { scene.remove(satPoints); satPoints.geometry.dispose(); satPoints.material.dispose() }
    const arr = new Float32Array(positions.length * 3)
    for (let i = 0; i < positions.length; i++) {
      const v = llaToVec(positions[i].lat, positions[i].lon, positions[i].altKm)
      arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    const useColors = colors && colors.length === positions.length * 3
    if (useColors) geo.setAttribute('color', new THREE.BufferAttribute(colors instanceof Float32Array ? colors : Float32Array.from(colors), 3))
    // 卫星点：随缩放联动（基准距离上 SAT_POINT_PX 像素，拉近变大、拉远变小，见 loop 内逐帧更新 size）；
    // 拾取命中半径独立按距离折算固定 ~14px（见 pointerup），故缩小后仍可点。下限钳制保证拉远不至于消失。
    // vertexColors 时基色取白（three.js 用材质色乘顶点色），逐点色即最终色；否则用统一的默认星点色。
    const mat = useColors
      ? new THREE.PointsMaterial({ size: SAT_POINT_PX, sizeAttenuation: false, vertexColors: true })
      : new THREE.PointsMaterial({ color: 0x9fd0ef, size: SAT_POINT_PX, sizeAttenuation: false })
    satPoints = new THREE.Points(geo, mat)
    scene.add(satPoints)
  }
  // vec：单个 Vector3 / Vector3 数组 / null（清空）。p 同理，收 {lat,lon,altKm} 或其数组。
  function setHighlight(vec) {
    const list = (Array.isArray(vec) ? vec : (vec ? [vec] : [])).filter(Boolean)
    hlPos = list.map((v) => v.clone())
    for (let i = hlPos.length; i < ringSprs.length; i++) ringSprs[i].visible = false   // 多余的精灵收起来
  }
  function setHighlightLLA(p) {
    const list = (Array.isArray(p) ? p : (p ? [p] : [])).filter((q) => q && Number.isFinite(q.lat) && Number.isFinite(q.lon))
    setHighlight(list.map((q) => llaToVec(q.lat, q.lon, q.altKm)))
  }

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
    if (beamDragMode && e.button === 0) { beamDragging = true; const ll = pickDragStart(e.clientX, e.clientY); if (ll && onBeamDrag) onBeamDrag(ll, 'start') }
    else if (labelDragMode && e.button === 0) { labelDragging = true; const ll = pickGlobeOrLimb(e.clientX, e.clientY); if (ll && onLabelDrag) onLabelDrag(ll, 'start') }
    else if (polyDrawMode && e.button === 0) { polyDrawing = true; drawLX = e.clientX; drawLY = e.clientY; try { renderer.domElement.setPointerCapture(e.pointerId) } catch { /* ignore */ } const ll = pickGlobe(e.clientX, e.clientY); if (ll && onPolyDraw) onPolyDraw(ll, 'start') }
  })
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (polyDrawing) { polyDrawing = false; try { renderer.domElement.releasePointerCapture(e.pointerId) } catch { /* ignore */ } if (onPolyDraw) onPolyDraw(null, 'end'); return }   // 绘制笔画结束（显式释放捕获，勿只靠隐式）；不当作选星
    if (beamDragging) { beamDragging = false; if (onBeamDrag) onBeamDrag(null, 'end'); return }   // 拖波束结束，不当作选星
    if (labelDragging) { labelDragging = false; if (onLabelDrag) onLabelDrag(null, 'end'); return }   // 拖标签结束，不当作选星
    if (e.button !== 0) return   // 仅左键当作选星；右键（标点）/中键不改变聚焦
    // 拖动（旋转）-> 停自转、不当作点击
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 6) { stopAutoRotate(); return }
    // 放置模式：左键点击 = 在球面落点放置（波束合成），不当作选星
    if (placeMode) { const ll = pickGlobe(e.clientX, e.clientY); if (ll && onPlace) onPlace(ll); return }
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
    const addToSel = e.ctrlKey || e.metaKey || e.shiftKey   // 按住 Ctrl/Cmd/Shift 点选=加入多选
    if (best) onPick(best.index, best.point, addToSel); else onPick(-1, null, addToSel)
  })
  // 指针被取消（触控/系统抢占）：复位绘制笔画并释放捕获，避免残留捕获截走之后的点击（输入框点不进）。
  renderer.domElement.addEventListener('pointercancel', (e) => {
    if (polyDrawing) { polyDrawing = false; if (onPolyDraw) onPolyDraw(null, 'end') }
    try { renderer.domElement.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  })

  const camDir = new THREE.Vector3()
  // 标签：近地平处用透明度平滑淡出（而非硬切换显隐），消除旋转时边缘的闪烁/跳变。
  // dot>0.22 全显；0.05~0.22 线性淡出；<0.05 隐藏。
  function fadeLabel(s, dot) {
    if (dot <= 0.05) { s.visible = false; return }
    s.visible = true
    // 地平淡出系数 × 用户设定的基准透明度（_baseOpacity，默认 1）：二者相乘，使透明度设置不被每帧淡出覆盖
    const base = s._baseOpacity != null ? s._baseOpacity : 1
    s.material.opacity = (dot >= 0.22 ? 1 : (dot - 0.05) / 0.17) * base
  }
  function updateLabels() {
    camDir.copy(camera.position).normalize()
    const cull = (grp) => { if (!grp || !grp.visible) return; for (const s of grp.children) if (s._dir) fadeLabel(s, s._dir.dot(camDir)) }
    cull(labelsZh); cull(labelsEn); cull(oceanZh); cull(oceanEn); cull(provinceLabels); cull(cityLabels)
    cull(satLayerGroup)   // 卫星/仰角线/Polygon 独立图层里带 _dir 的标签（如 Polygon 名称数值）：同样近地平淡出、背面隐藏
  }

  const zoomDir = new THREE.Vector3()
  let raf = 0, lastFrameT = 0, running = true
  function loop(now) {
    if (!running) return   // 已暂停（切到 2D 平面图）：停掉 rAF 链，不再空转渲染被盖住的球面
    raf = requestAnimationFrame(loop)
    // 帧率上限（省电）：未到间隔则跳过本帧的更新与渲染（留 1ms 余量避免临界抖动）
    if (fpsCap > 0) { if (now && (now - lastFrameT) < (1000 / fpsCap - 1)) return; lastFrameT = now || 0 }
    controls.update()   // 旋转/阻尼（半径在此保持不变）
    // 滚轮缩放缓动：把当前半径向 zoomTarget 逼近（0.18 的缓动系数 -> 顺滑且跟手）
    const cur = camera.position.distanceTo(controls.target)
    if (Math.abs(cur - zoomTarget) > 1e-4) {
      const next = cur + (zoomTarget - cur) * 0.18
      zoomDir.copy(camera.position).sub(controls.target).normalize()
      camera.position.copy(controls.target).addScaledVector(zoomDir, next)
    }
    // 卫星点随缩放联动：基准距离上 SAT_POINT_PX，拉近变大、拉远变小；下限 0.5×/上限 4× 钳制保证可见且不过大
    if (satPoints) satPoints.material.size = SAT_POINT_PX * Math.max(0.5, Math.min(4, LABEL_REF_DIST / cur))
    // 选中环：固定屏幕像素大小（不随缩放变化，拉远也能看清选中的是哪颗），背面被地球挡住时隐藏
    if (hlPos.length) {
      const tanHalf = Math.tan(camera.fov * 0.5 * Math.PI / 180) || 1
      for (let i = 0; i < hlPos.length; i++) {
        const P = hlPos[i], spr = ringSprs[i] || ringSprite()
        const d = camera.position.distanceTo(P)
        const sz = RING_PX * (2 * d * tanHalf) / curH
        spr.position.copy(P)
        spr.scale.set(sz, sz, 1)
        spr.visible = !occludedByGlobe(P)
      }
    }
    rescaleMarkers()
    updateLabels()
    renderer.render(scene, camera)
  }
  loop()
  // 渲染循环暂停/恢复（切 2D/3D 时由页面调用）：切到 2D 平面图后 3D 画布被盖住，仍每帧渲染整球
  // + 覆盖大网格纯属浪费主线程/GPU，还拖慢 2D。pause 停掉 rAF 链；resume 立即补画一帧并续帧。
  function pause() { if (!running) return; running = false; cancelAnimationFrame(raf); raf = 0 }
  function resume() { if (running) return; running = true; loop() }

  function resize() {
    const ww = container.clientWidth, hh = container.clientHeight
    if (!ww || !hh) return
    curW = ww; curH = hh
    camera.aspect = ww / hh; camera.updateProjectionMatrix(); renderer.setSize(ww, hh, false)   // false：不写内联样式，见构造处注释
    for (const m of lineMats) m.resolution.set(ww, hh)   // 粗线宽度依赖分辨率
    renderer.render(scene, camera)   // 立即补画一帧，避免 setSize 清空缓冲后等到下帧才重绘 → 黑一下
  }
  function destroy() {
    clearEnv()          // 贴图/几何不随 renderer.dispose 走，显式释放（切页面重挂载时会反复走这里）
    clearTerminator()   // 同上：夜区球壳几何 + 线材质（materials 还挂在 lineMats 里）也要显式还
    clearShellField(); clearShellGuides()   // 对星覆盖壳层：标签用的 canvas 贴图同样不随 dispose 走
    cancelAnimationFrame(raf); controls.dispose(); renderer.dispose()
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
  }

  return {
    setSatellites, setLabelMode, setHighlight, setHighlightLLA, setOnPick,
    setOrbit, setGroundTrack, setFootprint, setSelectionSet, clearSelectionGeom,
    setCoverage, clearCoverage, setCoverageField, updateCoverageField, patchCoverageLayers, clearCoverageField, setCoverageFieldAlpha, setCovGrid, clearCovGrid, setCovGridAlpha,
    setShellField, updateShellField, clearShellField, setShellFieldAlpha, setShellGuides, clearShellGuides, setShellRays, clearShellRays,
    setTerminator, clearTerminator,
    setEnvRaster, setEnvAlpha, setEnvContours, clearEnv,
    setSatLayer, clearSatLayer, faceLonLat, setProvinces, setProvincesVisible, setCities, setCitiesVisible, setBorderStyle, setNameScale, setLabelStyle, setOceanColor, setLandColors,
    setPixelRatio, setRenderFps, setSphereDetail, setMapDetail,
    setMarkers, setTrajectories, setFocusSatLLA, setOnHover, setOnRightClick, setBeamDragMode, setOnBeamDrag, setBeamDragPivot, setLabelDragMode, setOnLabelDrag, setPolyDrawMode, setOnPolyDraw, setPlaceMode, setOnPlace,
    faceTo, rotateBy, setAutoRotate, setAutoRotateSpeed, setOnAutoRotateOff, resize, pause, resume, destroy,
    // 缩放进度条接口：getZoom 读当前进度、setZoom 设到进度 t、setOnZoom 注册滚轮缩放回填回调
    getZoom: () => distToT(zoomTarget),
    setZoom: (t) => { zoomTarget = Math.max(controls.minDistance, Math.min(controls.maxDistance, tToDist(t))) },
    setOnZoom: (fn) => { onZoom = fn },
    // 完整视图记忆：相机朝向(单位方向)+缩放进度 t。getView 读、setView 复原（朝向+距离）。
    getView: () => { const p = camera.position; return { x: p.x, y: p.y, z: p.z, t: distToT(zoomTarget) } },
    setView: (v) => {
      if (!v) return
      if (Number.isFinite(v.t)) zoomTarget = Math.max(controls.minDistance, Math.min(controls.maxDistance, tToDist(v.t)))
      if (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) {
        const d = Math.hypot(v.x, v.y, v.z) || 1
        camera.position.set(v.x / d * zoomTarget, v.y / d * zoomTarget, v.z / d * zoomTarget)
        controls.update()
      }
    }
  }
}
