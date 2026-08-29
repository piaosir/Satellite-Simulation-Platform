import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import earcut from 'earcut'
import { ENV_R, envSphereParams } from '../env/envSphere.js'
import { ARCTIC_ISLAND_LAT, landColors, setLandPalette, getLandPalette } from '../landPalette.js'
// 注记描边色/粗细随底色现算：与 2D 平面图共用单一来源
import { haloColor, haloScale, IMAGERY_HALO, IMAGERY_SCALE } from '../labelHalo.js'
// 底图不再是「一份画好的国界」：面/线/标注/点选全部由主权解算层按归属实时算出（视角 = 一张归属表）
import { resolvedFeatures, resolvedLines, labelSet, ensureDetail, onPovChange } from '../geo/povResolver.js'
// 边界线显示规范（渲染次序 / 出厂样式 / 线型的屏幕像素图案 / 缩放淡出）：与 2D 平面图共用同一份
import { ORDER, BORDER_DEF, DASH_PX, DASH_SCALE, BORDER_CLASSES, CFG_KEY, fadeFactor, admFade } from '../geo/borderStyle.js'
// 水域注记（大洋 + 海域）：与 2D 平面图共用同一份表
import { waterLabels } from '../geo/waterNames.js'
// 岛链参考线：与 2D 平面图共用同一份表
import { chainList, CHAIN_DEF, CHAIN_ORDER, CHAIN_LABEL_PX } from '../geo/islandChains.js'
import { antarcticaFillRings } from './antarctica.js'
import { solarGeometry, terminatorRing } from '../terminator.js'
// 点标记序号徽标（圈 1、圈 2）：与 2D 平面图共用同一支画笔，两视图观感一致
import { paintNumBadge, BADGE_TEX_FILL, badgeLabelUp } from '../markers/numBadge.js'
// 地球站符号：与 2D 平面图共用同一份定义（原来两处各存一份逐字符相同的副本）
import { stationSvg, STATION_ANCHOR_X, STATION_ANCHOR_Y } from '../stationSymbol.js'
import { vehicleCanvas } from '../vehicleSymbol.js'
// 顶点级几何原语：与聚焦几何 Worker 共用同一份实现（别在这里再写一份）
import { RE, LIFT, llaToVec, pushStripSegs, pushDashed, densifyArc, DASH_SPEC, FILL_R, FILL_CELL, slerpUnit, footprintFill, coneFace, createSink } from './focusLanes.js'


// 画布文字（地名/大洋/波束标签）：无衬线，独立一档，【不跟】界面字体走
//（原为 global.css --font-ui 的手工镜像；2026-08-29 界面字体做成设置项后两者分家）。
// ★ 与 2D 平面图的 textFont 必须同栈 —— 同一个地名
// 在平面图与球面上是同一个字。刻意不跟 --font-doc 的衬线栈，理由见 flatmap/flatCoverage.js 那处注释。
const UI_FONT = '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif'

// 注记套边（casing）粗细 / 字号。与 2D 平面图 flatmap/flatCoverage.js 的 CASE_K / CASE_K_P / CASE_K_C
// **必须逐项同值** —— 同一个地名在平面图与球面上是同一个字，套边粗细也得是同一个。
// ★ 一律写成「比例 × 该画布的字号」，不要在某一处退回写死像素：各处的贴图字号并不相同
//   （地名 54 / 大洋名 40 / 覆盖标注按 hpx 折算），写死像素等于每处各是一个比例。
//   大洋名曾经就是写死的 4px（相当于 0.10×字号），比 2D 那份细三分之一。
const CASE_K = 0.15     // 默认档：国名 / 大洋名 / 波束名 / 数值 / 标记注记
const CASE_K_P = 0.13   // 一级行政区
const CASE_K_C = 0.11   // 二级行政区（字最小，套边最细）

// 渲染分辨率倍率上限：实际渲染不超过显示器物理像素密度的 SS_CAP 倍。
// 超出物理像素的超采样屏幕根本无法显示，纯属浪费 GPU——裁掉它对画质无影响（MSAA 仍负责边缘抗锯齿）。
// 低端办公机多为 DPR=1，由此把默认/高档位的 2~3× 超采样压到 ≤1.5×，片元着色负载按面积平方下降（≈省一半到四分之三）。
// HiDPI 屏（DPR≥1.5）取 min 后仍按原生密度渲染，保持锐利、不降画质。需要更多超采样可调大 SS_CAP。
const SS_CAP = 2
function capPixelRatio(n) {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
  return Math.max(0.25, Math.min(n, dpr * SS_CAP, 4))
}


// 陆地配色（LAND/CHINA/ICE/基调方案/逐国覆盖）统一收拢到 ../landPalette.js（与 2D 平面图共用单一来源）
const OCEAN = '#15426b'

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
  // 争议叠加面（f.over）抬高 0.002%：它盖在宿主面上、等高会 z-fight。这个高差 ≈ 0.13 km，
  // 肉眼与视差都看不出，却足够让深度测试分出先后。
  let R = 1

  function pushVert(lon, lat) {
    const v = llaToVec(lat, lon, 0).multiplyScalar(R)   // 半径 1，贴在海洋球(0.999)之上
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

  features.forEach((f, i) => {
    const g = f.geometry
    if (!g) return
    const id = String(f.id)
    const idx = f.idx != null ? f.idx : i     // 取色序号按【归属】定，叠加面与其基础面取同一号 → 同一国恒同色
    R = f.over ? 1.00002 : 1
    // 南极洲：海岸线收口到南极点直接三角化（替代普通 addPolygon + −82° 极冠）。
    // 修复 50m 本土不填充（其本土被编码为退化外环+海岸线洞，earcut 得 0），并消除 −82° 极冠对海洋的污染与接缝。
    if (id === 'ATA') {
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

// strokeK = 套边粗细 / 字号，取本文件顶部那三档（与 2D 的 CASE_K 三档逐项同值）。
// halo = 套边色、haloK = 粗细系数，都按当前底色现算（见 ../labelHalo.js）。★ 套边色是【烘进纹理】的，
// SpriteMaterial 的乘法着色改不动它 —— 底色换档时必须整份重烘，见 refreshHalo。
function makeLabelSprite(text, hpx, fill, strokeK = CASE_K, halo, haloK) {
  const pad = 8, fs = 54   // 高分辨率纹理：放大后文字更锐利
  const strokePx = strokeK * fs * (haloK != null ? haloK : 1)
  const c = document.createElement('canvas')
  let cx = c.getContext('2d')
  cx.font = `${fs}px ${UI_FONT}`
  const w = Math.ceil(cx.measureText(text).width) + pad * 2
  c.width = w; c.height = fs + pad * 2
  cx = c.getContext('2d')
  cx.font = `${fs}px ${UI_FONT}`
  cx.textBaseline = 'middle'; cx.textAlign = 'center'
  cx.lineJoin = 'round'; cx.miterLimit = 2
  cx.lineWidth = strokePx; cx.strokeStyle = halo || 'rgba(0,0,0,1)'   // 描边(casing)：strokePx 控粗细、halo 控色
  if (strokePx > 0) cx.strokeText(text, c.width / 2, c.height / 2)
  // 字面烘成纯白，颜色由 SpriteMaterial.color 着色（运行时可改）：白×色=色，黑色描边×色仍≈黑，casing 保留
  cx.fillStyle = '#ffffff'; cx.fillText(text, c.width / 2, c.height / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  // depthTest 关：正面标签始终完整显示，不被球面裁切；背面由每帧半球剔除隐藏
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: fill || '#eef2f6', depthTest: false, depthWrite: false, transparent: true }))
  spr.scale.set((c.width / c.height) * hpx, hpx, 1)
  spr._base = spr.scale.clone()   // 基准尺寸（供地名字号缩放）
  spr._txtK = fs / c.height       // 画布里字本身占的高度比（其余是描边留白）：地名避让按字高钳位，不按整张画布
  spr._wK = (c.width - pad * 2) / c.width   // 同理，宽度也要去掉两边的描边留白，否则碰撞盒凭空胖一圈
  spr.renderOrder = 10
  return spr
}


// 国名标注：位置/字号/中英两套全部来自解算器的 labelSet（按归属合并，per-POV 改名与 hide 也在那里做）。
// 字号映射式子（线度 → 世界高度）与换源前一字不改。
function buildLabels(lang, detail, halo, haloK) {
  const group = new THREE.Group()
  group.visible = false
  for (const l of labelSet(lang, detail)) {
    const hpx = Math.max(0.016, Math.min(0.030, 0.012 + l.ext * 0.0016))
    const spr = makeLabelSprite(l.name, hpx, undefined, CASE_K, halo, haloK)
    spr.position.copy(llaToVec(l.lat, l.lon, 25))
    spr._dir = spr.position.clone().normalize()
    spr._pri = l.ext            // 地名避让的排队依据：大国先得位（见 updateLabels）
    group.add(spr)
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
// 矢量经纬网（半径略低于国界线，使国界压在网格之上）。step = 网格间隔（度，可调）。
// 返回【折线数组】而不是散段：这样能和五类边界线走同一套虚线机器（pushDashed / pushStripSegs），
// 于是经纬网也能选线型、虚线周期也随缩放恒定。3° 一段是为了贴住球面。
function graticuleLines(step) {
  const d = step > 0 ? step : 15
  const out = []
  const at = (lat, lon) => llaToVec(lat, lon, 0).multiplyScalar(1.0003)
  for (let lat = -90 + d; lat <= 90 - d + 1e-9; lat += d) {
    const line = []
    for (let lon = -180; lon <= 180; lon += 3) line.push(at(lat, lon))
    out.push(line)
  }
  for (let lon = -180; lon < 180; lon += d) {
    const line = []
    for (let lat = -87; lat <= 87; lat += 3) line.push(at(lat, lon))
    out.push(line)
  }
  return out
}

// 水域标记（大洋 / 海域）：斜体，区别于国家名。套边按【海色】那一档算——它画在海上，而海色与陆色是
// 两个独立设置项，同一档判到底会在「浅陆深海」这类组合上错一边。
// px = 表里那一条的制图层级（见 ../geo/waterNames.js），大洋 15 为基准、按比例折成世界高。
// ★ 字面烘【白】、颜色交给 SpriteMaterial.color：与国名/省名同一套路，否则用户改不动这一层的颜色
//   （原先把浅蓝直接烘进纹理，再乘 material.color 只会越乘越暗）。出厂色见 labelCfg。
function makeWaterLabel(text, halo, haloK, px) {
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
  // 与国名同一档（CASE_K×字号）。原来是写死的 4px —— 该画布字号 40，相当于 0.10×，比 2D 那份细三分之一
  cx.lineWidth = CASE_K * fs * (haloK != null ? haloK : 1); cx.strokeStyle = halo || 'rgba(0,0,0,0.55)'
  cx.strokeText(text, c.width / 2, c.height / 2)
  cx.fillStyle = '#ffffff'; cx.fillText(text, c.width / 2, c.height / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true }))
  const hpx = 0.034 * ((px || 15) / 15)
  spr.scale.set((c.width / c.height) * hpx, hpx, 1)
  spr._base = spr.scale.clone()
  spr._txtK = fs / c.height
  spr._wK = (c.width - pad * 2) / c.width
  spr.renderOrder = 9
  return spr
}

// 水域注记一档（'ocean' 大洋 | 'sea' 海域）：表在 ../geo/waterNames.js，与 2D 平面图同一份。
// off = { id: true } 即用户逐条关掉的那些，整份重建时按当前 off 过滤。
function buildWaterLabels(tier, lang, halo, haloK, off) {
  const group = new THREE.Group()
  group.visible = false
  for (const w of waterLabels(tier, off)) {
    const spr = makeWaterLabel(lang === 'en' ? w.en : w.zh, halo, haloK, w.px)
    spr.position.copy(llaToVec(w.lat, w.lon, 25))
    spr._dir = spr.position.clone().normalize()
    spr._pri = w.pri
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
  controls.minDistance = 1.02   // 贴到离地面 0.02 R（≈130 km）：进度条那 100→120% 的余量就在这一段
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
  // 缩放进度（底部状态栏进度条）：距离对数映射到 t，t=0 最远(缩小)、t=1.2 最近(放大)。
  // 对数映射 → 进度条每一格的“距离倍率”恒定，靠近地球时绝对步进更小，天然支持精细化缩放。
  // ★ 分两段：0–1 仍钉在原来的最近距离 D_T1=1.15 上（这一段与改之前逐格一致，老存档的 t 不漂）；
  //   1–1.2 是新加的贴地余量 1.15→minDistance。纯对数一路延到 120% 会要求距离 0.54 —— 在地心里面，做不到。
  const TMAX = 1.2, D_T1 = 1.15
  const _lnT1 = Math.log(D_T1), _lnMin = Math.log(controls.minDistance), _lnMax = Math.log(controls.maxDistance)
  const distToT = (d) => (d >= D_T1
    ? (_lnMax - Math.log(d)) / (_lnMax - _lnT1)
    : 1 + (_lnT1 - Math.log(d)) / (_lnT1 - _lnMin) * (TMAX - 1))
  const tToDist = (t) => {
    const tt = Math.max(0, Math.min(TMAX, t))
    return tt <= 1 ? Math.exp(_lnMax - tt * (_lnMax - _lnT1))
      : Math.exp(_lnT1 - (tt - 1) / (TMAX - 1) * (_lnT1 - _lnMin))
  }
  // 近裁剪面随距离走：贴到 1.02 时固定 near=0.1 会把整个地球裁掉（最近可视面才 0.02 远）。
  // 按「相机到球面的距离」取一档，既不裁又不至于把 far/near 拉到 12000 那种精度（z-fighting）。
  function syncNear(d) {
    const n = Math.max(0.004, Math.min(0.1, (d - 1) * 0.4))
    if (Math.abs(camera.near - n) < 1e-6) return
    camera.near = n; camera.updateProjectionMatrix()
  }
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
  // 覆盖场等值线：逐组显式给的透明度(grp.opacity)优先，否则用整层设置(o.lineAlpha)，都没有才回落 0.95。
  // ★ 打 userData.covLine 标记 —— setCoverageLineAlpha 靠它认人。同一个 covFieldGroup 里还挂着
  //   天线视轴(covRayGroup，自有 rayOpacity)与峰值点十字，都是 LineMaterial，按材质类型一刀切会把它们一起调暗。
  // 对地(buildDeco) / 对星(buildShellDeco) 同一口径，改这里两边一起变。
  function covContourLine(flat, grp, o) {
    const ln = fatSegments(flat, grp.color != null ? grp.color : 0xffffff, grp.width || 1.2,
      grp.opacity != null ? grp.opacity : ((o && o.lineAlpha != null) ? o.lineAlpha : 0.95), 6)
    ln.userData.covLine = true
    return ln
  }
  function fatStrip(vecs, color, width, opacity, order) {
    const flat = []; for (const v of vecs) { flat.push(v.x, v.y, v.z) }
    const g = new LineGeometry(); g.setPositions(flat)
    const m = regMat(new LineMaterial({ color, linewidth: width, transparent: true, opacity, worldUnits: false, depthWrite: false }))
    const o = new Line2(g, m); o.renderOrder = order || 0; return o
  }

  let mapDetail0 = '10m'        // 创建时恒以静态 10m 构建；切到 50m/110m 由 setMapDetail 异步换源
  let features = resolvedFeatures(mapDetail0)
  let mapThin = quality.mapThin != null ? quality.mapThin : 0.025
  let curLines = null           // 解算出的五组线缓存（换视角/换精度档时作废）
  let dashRefWpp = 0            // 上次建虚线时用的「每像素多少世界单位」，变化超过一档才重建
  // 海洋：纯色球（半径 0.998，留足与陆地细分塌陷下限 ~0.9995 的间隙，标准深度下不 z-fighting）
  // 海洋球：保留几何/材质引用，供 setOceanColor 改色、setSphereDetail 改细分段数
  const oceanMat = new THREE.MeshBasicMaterial({ color: OCEAN })
  let oceanMesh = new THREE.Mesh(new THREE.SphereGeometry(0.998, sphereSeg0, sphereSeg0), oceanMat)
  scene.add(oceanMesh)
  // 陆地：矢量三角网填色（零虚化，替代原 8192 纹理）。保留引用供 setMapDetail 重建。
  let landMesh = buildLandMesh(features)
  scene.add(landMesh)
  // 影像底图：整幅等经纬贴图，开启后【顶替】上面这两层（海色球 + 陆地三角网），边界线/地名/覆盖场照旧叠其上。
  // 与海洋球同半径 0.998、同细分段数 —— 两者互斥显示，几何一致才不会在切换时看出位移。
  // 贴图取向：图左=180°W、图上=90°N，与 SphereGeometry 的 uv 天然对齐，不需旋转（详见 viz/imagery.js）。
  let imageryMesh = null, imageryMat = null, imageryOn = false, imageryBright = 1
  // 注记套边：颜色与粗细都按【当前底色】现算（见 ../labelHalo.js）。陆上的注记按陆地基调、
  // 大洋名按海色；开了真彩影像则一律退回恒定近黑（影像深浅混杂，按单一底色算不成立）。
  const landBg = () => { const sc = getLandPalette().scheme; return sc === 'morandi' ? '#8fa89b' : sc }
  const curHalo = () => (imageryOn ? IMAGERY_HALO : haloColor(landBg()))
  const curHaloK = () => (imageryOn ? IMAGERY_SCALE : haloScale(landBg()))
  const seaBg = () => '#' + oceanMat.color.getHexString()
  const oceanHalo = () => (imageryOn ? IMAGERY_HALO : haloColor(seaBg()))
  const oceanHaloK = () => (imageryOn ? IMAGERY_SCALE : haloScale(seaBg()))
  // 已烘进纹理的那一套的签名：底色换档时靠它判「要不要整份重烘」
  const haloKey = () => curHalo() + '|' + curHaloK().toFixed(3) + '|' + oceanHalo() + '|' + oceanHaloK().toFixed(3)
  let haloNow = ''
  let sphereSegCur = sphereSeg0        // 当前海洋球/影像球细分段数（setSphereDetail 会改，影像球须跟着走）

  // 矢量边界线 + 矢量经纬网：粗线，放大/高分辨率下都锐利清晰。
  // 渲染序高于覆盖填充(5)+各类数据线(等值线/波束线/仰角线/轨迹线，统一 6)、低于点/标注：
  // 地理骨架贯穿覆盖区之上 → 覆盖与底图融为一体（平级），不再像贴纸浮在地图上面。depthWrite=false，纯绘制顺序。
  // 经纬网：与五类边界线同样是「一条可改样式、可关掉」的线，样式收在 borderCfg 的 grid* 里。
  // 间隔变了要重建几何（点是按间隔生成的），颜色/线宽/透明度/显隐直接改材质。
  let graticule = null
  function gridPos(wpp) {
    const px = DASH_PX[borderCfg.gridDash || 'solid']
    const pat = px ? px.map((v) => v * wpp) : null
    const sink = createSink()
    for (const line of graticuleLines(borderCfg.gridStep)) { if (pat) pushDashed(sink, line, pat); else pushStripSegs(sink, line) }
    return sink.view()
  }
  function buildGrid() {
    disposeFatLine(graticule)
    graticule = fatSegments(gridPos(worldPerPx()), borderCfg.gridColor, borderCfg.gridWidth, borderCfg.gridOpacity, ORDER.grid)
    graticule.visible = borderCfg.gridOn !== false
    scene.add(graticule)
  }
  // 五类边界线：coast / admin0 / indefinite / loc / claim，各自独立的颜色/线宽/透明度/线型。
  // 保留对象引用，供 setBorderStyle 运行时改样式；换精度档 / 换视角 / 改缩放档位时按需重建。
  const borderCfg = { ...BORDER_DEF }
  const borderLines = {}     // cls → LineSegments2（首次构建在 offPov 之后 —— classPos 依赖的几个 const 还没初始化）


  // 国名：中、英两套（按需切换显隐），初始全隐
  let labelsZh = buildLabels('zh', mapDetail0, curHalo(), curHaloK()); scene.add(labelsZh)
  let labelsEn = buildLabels('en', mapDetail0, curHalo(), curHaloK()); scene.add(labelsEn)
  // 水域注记：大洋 / 海域两档，各自中、英两套。档位与国名【分开】——用户可以只要洋名不要国名。
  // waterOff = { id: true } 逐条关掉的那些：它决定造哪几个精灵，故改它要整份重建这四组。
  let waterOff = {}
  let oceanZh = buildWaterLabels('ocean', 'zh', oceanHalo(), oceanHaloK(), waterOff); scene.add(oceanZh)
  let oceanEn = buildWaterLabels('ocean', 'en', oceanHalo(), oceanHaloK(), waterOff); scene.add(oceanEn)
  let seaZh = buildWaterLabels('sea', 'zh', oceanHalo(), oceanHaloK(), waterOff); scene.add(seaZh)
  let seaEn = buildWaterLabels('sea', 'en', oceanHalo(), oceanHaloK(), waterOff); scene.add(seaEn)
  let waterMode = { ocean: 'off', sea: 'off' }
  // 岛链参考线：一条 LineSegments2（三条链共用一份几何）+ 一组名字精灵。默认整层不画。
  const chainCfg = { on: false, ...CHAIN_DEF }
  let chainOff = {}, chainLine = null, chainLabels = null
  haloNow = haloKey()
  function setLabelMode(mode) {   // 'zh' | 'en' | 'off'
    labelsZh.visible = mode === 'zh'
    labelsEn.visible = mode === 'en'
  }
  function applyWaterMode() {
    oceanZh.visible = waterMode.ocean === 'zh'; oceanEn.visible = waterMode.ocean === 'en'
    seaZh.visible = waterMode.sea === 'zh'; seaEn.visible = waterMode.sea === 'en'
  }
  // 水域注记档位：{ ocean, sea } 各自 'zh' | 'en' | 'off'（只给一个就只改那一个）
  function setWaterMode(m) { if (!m) return; if (m.ocean != null) waterMode.ocean = m.ocean; if (m.sea != null) waterMode.sea = m.sea; applyWaterMode() }
  // 水域注记逐条显隐：改的是「造不造这个精灵」，故整份重建（77 条，代价与一次换语言相当）
  function setWaterOff(o) { waterOff = { ...(o || {}) }; rebuildWaterLabels() }
  // 地名字号缩放：国家名(cf) 与 省名(pf) 与 地级市名(cityf) 与 大洋名(of) 与 海域名(sf) 分开
  let nameScaleC = 1, nameScaleP = 1, nameScaleCity = 1, nameScaleO = 1, nameScaleS = 1
  function applyNameScale(group, f) { if (group) group.traverse((c) => { if (c._base) c.scale.copy(c._base).multiplyScalar(f) }) }
  function setNameScale(cf, pf, cityf, of, sf) {
    nameScaleC = cf || 1; nameScaleP = pf != null ? pf : nameScaleC
    if (cityf != null) nameScaleCity = cityf
    if (of != null) nameScaleO = of
    if (sf != null) nameScaleS = sf
    applyNameScale(labelsZh, nameScaleC); applyNameScale(labelsEn, nameScaleC)
    applyNameScale(oceanZh, nameScaleO); applyNameScale(oceanEn, nameScaleO)
    applyNameScale(seaZh, nameScaleS); applyNameScale(seaEn, nameScaleS)
    applyNameScale(provinceLabels, nameScaleP)
    applyNameScale(cityLabels, nameScaleCity)
  }
  // 地名颜色/透明度：五档各自分开。字面已烘白 → 改 SpriteMaterial.color 即着色，opacity 控整体淡入淡出。
  // 省名标签懒加载，故同时存进 labelCfg，setProvinces 创建时套用。
  const labelCfg = {
    countryColor: '#eef2f6', countryOpacity: 1, provColor: '#ffe6a8', provOpacity: 1, cityColor: '#cdd6e0', cityOpacity: 1,
    oceanColor: '#96c3e6', oceanOpacity: 1, seaColor: '#86b0d4', seaOpacity: 1
  }
  function applyLabelStyle(group, color, opacity) {
    if (!group) return
    group.traverse((c) => { if (c.isSprite && c.material) { if (color != null) c.material.color.set(color); if (opacity != null) { c._baseOpacity = opacity; c.material.opacity = opacity } } })
  }
  function applyWaterStyle() {
    applyLabelStyle(oceanZh, labelCfg.oceanColor, labelCfg.oceanOpacity); applyLabelStyle(oceanEn, labelCfg.oceanColor, labelCfg.oceanOpacity)
    applyLabelStyle(seaZh, labelCfg.seaColor, labelCfg.seaOpacity); applyLabelStyle(seaEn, labelCfg.seaColor, labelCfg.seaOpacity)
  }
  function setLabelStyle(s) {
    if (!s) return
    Object.assign(labelCfg, s)
    if (s.countryColor != null || s.countryOpacity != null) { applyLabelStyle(labelsZh, s.countryColor, s.countryOpacity); applyLabelStyle(labelsEn, s.countryColor, s.countryOpacity) }
    if (s.provColor != null || s.provOpacity != null) applyLabelStyle(provinceLabels, s.provColor, s.provOpacity)
    if (s.cityColor != null || s.cityOpacity != null) applyLabelStyle(cityLabels, s.cityColor, s.cityOpacity)
    if (s.oceanColor != null || s.oceanOpacity != null || s.seaColor != null || s.seaOpacity != null) applyWaterStyle()
  }
  applyWaterStyle()   // 四组水域注记刚造出来是白的，先套上出厂色
  // 大海颜色（限蓝色系）：直接改海洋球材质色
  function setOceanColor(c) { if (c) { oceanMat.color.set(c); refreshHalo() } }
  // 底图三层的互斥可见性。★ 陆地网格在 rebuildBasemap / setLandColors 里是「整份重建」的，
  // 新建出来的 mesh 恒 visible=true，故那两处末尾都必须回头调这里，否则一改配色/换精度档，
  // 矢量陆地就从影像底下钻出来盖住影像。
  function applyBaseLayers() {
    const on = imageryOn && !!imageryMesh
    oceanMesh.visible = !on
    landMesh.visible = !on
    if (imageryMesh) imageryMesh.visible = on
  }
  // 影像底图。img=已解码的整幅等经纬 HTMLImageElement（见 viz/imagery.js），传 null 即卸载；
  // bright=亮度乘子：MeshBasicMaterial 的 color 对纹理是逐通道乘法，压暗是为了让叠在上面的
  // 边界线看得清 —— 满亮度的真彩影像会把冷蓝灰那族地物线整个吃掉（见 map-line-visual-hierarchy 的口径）。
  function setImagery(o) {
    if (!o) return
    if (o.bright != null) {
      imageryBright = Math.max(0.05, Math.min(2, Number(o.bright) || 1))
      if (imageryMat) imageryMat.color.setScalar(imageryBright)
    }
    if (o.img !== undefined) {
      // 换源/卸载：旧纹理连同显存一起放掉，不 dispose 会累积。
      // 显存账：RGBA8 每像素 4 字节，含 mipmap 再 ×1.33 —— 8192×4096 ≈ 179 MB、16384×8192 ≈ 716 MB。
      // 16K 那一档确实重，故 8K 作为低配选项保留在源清单里，不是冗余。
      if (imageryMesh) {
        scene.remove(imageryMesh); imageryMesh.geometry.dispose()
        if (imageryMat.map) imageryMat.map.dispose()
        imageryMat.dispose(); imageryMesh = null; imageryMat = null
      }
      if (o.img) {
        // ★ 超出本机 GPU 纹理上限时先缩：WebGL 对超限纹理【不报错】，而是整颗球变黑 —— 最难查的一种。
        //   16384 是多数机器的 MAX_TEXTURE_SIZE，但集显/老驱动上是 8192，这一步不能省。
        const maxTex = renderer.capabilities.maxTextureSize || 8192
        let src = o.img
        const iw = o.img.naturalWidth || o.img.width, ih = o.img.naturalHeight || o.img.height
        if (iw > maxTex) {
          const w = maxTex, h = Math.max(1, Math.round(maxTex * ih / iw))
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h
          cv.getContext('2d').drawImage(o.img, 0, 0, w, h)
          src = cv
        }
        const tex = new THREE.Texture(src)
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy()   // 临边（视线掠过球面处）压缩极大，各向异性采样是唯一救法
        tex.needsUpdate = true
        imageryMat = new THREE.MeshBasicMaterial({ map: tex })
        imageryMat.color.setScalar(imageryBright)
        imageryMesh = new THREE.Mesh(new THREE.SphereGeometry(0.998, sphereSegCur, sphereSegCur), imageryMat)
        scene.add(imageryMesh)
      }
    }
    if (o.on != null) imageryOn = !!o.on
    refreshHalo()   // 影像开/关＝套边在「随底色」与「恒定近黑」之间切换
    applyBaseLayers()
  }

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
    sphereSegCur = s
    scene.remove(oceanMesh); oceanMesh.geometry.dispose()
    oceanMesh = new THREE.Mesh(new THREE.SphereGeometry(0.998, s, s), oceanMat)
    scene.add(oceanMesh)
    if (imageryMesh) {   // 影像球与海洋球同几何，一起换段数（材质/纹理保留）
      scene.remove(imageryMesh); imageryMesh.geometry.dispose()
      imageryMesh = new THREE.Mesh(new THREE.SphereGeometry(0.998, s, s), imageryMat)
      scene.add(imageryMesh)
    }
    applyBaseLayers()
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
  // 当前分辨率下「1 屏幕像素 ≈ 多少个地球半径」：透视投影下距相机 d 处 1 px 的世界长度
  // = 2 d tan(fov/2) / 高度像素。取球面近侧 d = 相机距地心 − 1。虚线周期与淡出档位都按它反推。
  function worldPerPx() {
    const d = Math.max(0.05, camera.position.length() - 1)
    return 2 * d * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, curH)
  }
  const degPerPx = () => worldPerPx() * 180 / Math.PI
  const linesNow = () => (curLines || (curLines = resolvedLines(mapDetail0)))

  // 一类边界线的线段坐标：solid 直接连、其余按屏幕像素图案切虚线（先补密大圆，否则长弦会沉进地球）
  const BORDER_LIFT = 1.0004
  const _bp = []
  function classPos(cls, polys, wpp) {
    const kind = borderCfg[CFG_KEY[cls] + 'Dash'] || 'solid'
    const px = DASH_PX[kind]
    const pat = px ? px.map((v) => v * wpp * (DASH_SCALE[cls] || 1)) : null
    const sink = createSink()
    for (const poly of polys) {
      const line = mapThin > 0 ? decimateRing(poly, mapThin) : poly
      if (line.length < 2) continue
      _bp.length = 0
      for (const q of line) _bp.push(llaToVec(q[1], q[0], 0).multiplyScalar(BORDER_LIFT))
      const dense = densifyArc(_bp)
      if (pat) pushDashed(sink, dense, pat); else pushStripSegs(sink, dense)
    }
    return sink.view()
  }
  function buildBorderLines() {
    const wpp = worldPerPx()
    dashRefWpp = wpp
    const L = linesNow()
    for (const cls of BORDER_CLASSES) {
      disposeFatLine(borderLines[cls])
      const k = CFG_KEY[cls]
      const o = fatSegments(classPos(cls, L[cls], wpp), borderCfg[k + 'Color'], borderCfg[k + 'Width'], borderCfg[k + 'Opacity'], ORDER[cls])
      borderLines[cls] = o
      scene.add(o)
    }
  }
  // 缩放变了 → 只重建虚线类的几何（实线与缩放无关）。周期恒定靠这一步；6% 的死区避免逐帧重算。
  function refreshDashScale() {
    const wpp = worldPerPx()
    if (dashRefWpp > 0 && Math.abs(wpp - dashRefWpp) / dashRefWpp < 0.06) return
    dashRefWpp = wpp
    const L = linesNow()
    for (const cls of BORDER_CLASSES) {
      const o = borderLines[cls]
      if (!o || !DASH_PX[borderCfg[CFG_KEY[cls] + 'Dash'] || 'solid']) continue
      o.geometry.dispose()
      const g = new LineSegmentsGeometry(); g.setPositions(classPos(cls, L[cls], wpp))
      o.geometry = g
    }
    if (graticule && DASH_PX[borderCfg.gridDash || 'solid']) {
      graticule.geometry.dispose()
      const g = new LineSegmentsGeometry(); g.setPositions(gridPos(wpp))
      graticule.geometry = g
    }
    if (chainLine && DASH_PX[chainCfg.dash || 'solid']) {
      chainLine.geometry.dispose()
      const g = new LineSegmentsGeometry(); g.setPositions(chainPos(wpp))
      chainLine.geometry = g
    }
  }
  // ---- 岛链参考线 ----
  // 顶点表已在经纬度平面加密过（见 ../geo/islandChains.js），这里再补一次大圆只是让长弦不沉进地球；
  // 两个视图的走向由那一步加密保证一致，不是靠这里。
  const _cp = []
  function chainPos(wpp) {
    const px = DASH_PX[chainCfg.dash || 'solid']
    const pat = px ? px.map((v) => v * wpp) : null
    const sink = createSink()
    for (const c of chainList(chainOff)) {
      _cp.length = 0
      for (const q of c.pts) _cp.push(llaToVec(q[1], q[0], 0).multiplyScalar(BORDER_LIFT))
      const dense = densifyArc(_cp)
      if (pat) pushDashed(sink, dense, pat); else pushStripSegs(sink, dense)
    }
    return sink.view()
  }
  function buildChainLine() {
    disposeFatLine(chainLine)
    chainLine = fatSegments(chainPos(worldPerPx()), chainCfg.color, chainCfg.width, chainCfg.opacity, CHAIN_ORDER)
    chainLine.visible = !!chainCfg.on
    scene.add(chainLine)
  }
  // 名字：与水域注记同一支画笔（斜体 + 按海色现算的套边），故换底色时跟着 rebuildLabels 一起重烘
  function rebuildChainLabels() {
    if (chainLabels) disposeLabelGroup(chainLabels)
    chainLabels = new THREE.Group()
    const en = chainCfg.name === 'en'
    for (const c of chainList(chainOff)) {
      const spr = makeWaterLabel(en ? c.en : c.zh, oceanHalo(), oceanHaloK(), CHAIN_LABEL_PX)
      spr.position.copy(llaToVec(c.label[1], c.label[0], 25))
      spr._dir = spr.position.clone().normalize()
      spr._pri = 1e9
      spr.material.color.set(chainCfg.color)
      spr._baseOpacity = chainCfg.opacity
      spr.material.opacity = chainCfg.opacity
      spr.scale.copy(spr._base).multiplyScalar(chainCfg.nameSize || 1)
      chainLabels.add(spr)
    }
    chainLabels.visible = !!chainCfg.on && chainCfg.name !== 'off'
    scene.add(chainLabels)
  }
  // { on, off, color, width, opacity, dash, name, nameSize }：只改给到的那几项。
  // 几何只在【逐条显隐】或【线型】变了时才重建，颜色/线宽/透明度就地改材质（同 setBorderStyle 的口径）。
  function setChains(o) {
    if (!o) return
    const reGeom = (o.off && JSON.stringify({ ...o.off }) !== JSON.stringify(chainOff)) || (o.dash != null && o.dash !== chainCfg.dash)
    const reLabel = reGeom || (o.name != null && o.name !== chainCfg.name)
    if (o.off) chainOff = { ...o.off }
    for (const k of ['on', 'color', 'width', 'opacity', 'dash', 'name', 'nameSize']) if (o[k] != null) chainCfg[k] = o[k]
    if (reGeom) buildChainLine()
    else if (chainLine) {
      const m = chainLine.material
      if (o.color != null) m.color.set(o.color)
      if (o.width != null) m.linewidth = o.width
      if (o.opacity != null) m.opacity = o.opacity
      chainLine.visible = !!chainCfg.on
    }
    if (chainLine) chainLine.visible = !!chainCfg.on
    if (reLabel) rebuildChainLabels()
    else if (chainLabels) {
      for (const s of chainLabels.children) {
        if (o.color != null) s.material.color.set(o.color)
        if (o.opacity != null) { s._baseOpacity = o.opacity; s.material.opacity = o.opacity }
        if (o.nameSize != null) s.scale.copy(s._base).multiplyScalar(o.nameSize || 1)
      }
      chainLabels.visible = !!chainCfg.on && chainCfg.name !== 'off'
    }
  }
  // 缩放分级（1.6b 三）：全球视角下二级行政区完全淡出、一级降到 0.3，拉近后线性恢复。
  // 政治五类不参与 —— 国界在任何尺度都在。线淡出时名字跟着淡，否则会剩一地孤字。
  let fadeApplied = -1
  function applyFade() {
    const t = borderCfg.fade ? fadeFactor(degPerPx()) : 1
    if (Math.abs(t - fadeApplied) < 0.01) return
    fadeApplied = t
    const { adm1: f1, adm2: f2 } = admFade(t)
    if (provinceBorders) provinceBorders.material.opacity = borderCfg.provOpacity * f1
    if (cityBorders) cityBorders.material.opacity = borderCfg.cityOpacity * f2
    if (provinceLabels) provinceLabels.traverse((c) => { if (c.isSprite && c.material) c.material.opacity = (c._baseOpacity != null ? c._baseOpacity : 1) * f1 })
    if (cityLabels) cityLabels.traverse((c) => { if (c.isSprite && c.material) c.material.opacity = (c._baseOpacity != null ? c._baseOpacity : 1) * f2 })
  }
  // 换精度档 / 换视角 / 改用户覆写 走同一条重建通道：陆地三角网 + 五类边界线 + 国名标注
  function rebuildBasemap() {
    curLines = null
    features = resolvedFeatures(mapDetail0)
    scene.remove(landMesh); landMesh.geometry.dispose(); landMesh.material.dispose()
    landMesh = buildLandMesh(features); scene.add(landMesh)
    buildBorderLines()
    rebuildLabels()
    applyBaseLayers()   // 陆地是新建的 mesh，恒 visible → 影像模式下须重新压回去
    fadeApplied = -1
  }
  const disposeLabelGroup = (g) => {
    scene.remove(g)
    g.traverse((c) => { if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose() } })
  }
  // 四组水域注记整份重烘（换套边色 / 换逐条显隐都走这里），重建后把字号、颜色、档位原样套回去
  function rebuildWaterLabels() {
    for (const g of [oceanZh, oceanEn, seaZh, seaEn]) disposeLabelGroup(g)
    oceanZh = buildWaterLabels('ocean', 'zh', oceanHalo(), oceanHaloK(), waterOff); scene.add(oceanZh)
    oceanEn = buildWaterLabels('ocean', 'en', oceanHalo(), oceanHaloK(), waterOff); scene.add(oceanEn)
    seaZh = buildWaterLabels('sea', 'zh', oceanHalo(), oceanHaloK(), waterOff); scene.add(seaZh)
    seaEn = buildWaterLabels('sea', 'en', oceanHalo(), oceanHaloK(), waterOff); scene.add(seaEn)
    applyNameScale(oceanZh, nameScaleO); applyNameScale(oceanEn, nameScaleO)
    applyNameScale(seaZh, nameScaleS); applyNameScale(seaEn, nameScaleS)
    applyWaterStyle()
    applyWaterMode()
  }
  function rebuildLabels() {
    const mode = labelsZh.visible ? 'zh' : labelsEn.visible ? 'en' : 'off'
    for (const g of [labelsZh, labelsEn]) disposeLabelGroup(g)
    labelsZh = buildLabels('zh', mapDetail0, curHalo(), curHaloK()); scene.add(labelsZh)
    labelsEn = buildLabels('en', mapDetail0, curHalo(), curHaloK()); scene.add(labelsEn)
    applyNameScale(labelsZh, nameScaleC); applyNameScale(labelsEn, nameScaleC)
    applyLabelStyle(labelsZh, labelCfg.countryColor, labelCfg.countryOpacity)
    applyLabelStyle(labelsEn, labelCfg.countryColor, labelCfg.countryOpacity)
    setLabelMode(mode)
    rebuildWaterLabels()
    rebuildChainLabels()   // 岛链名的套边也按海色烘进纹理，换底色时一起重烘
    haloNow = haloKey()
  }
  // 底色换了 → 套边色/粗细跟着变，而它是【烘进纹理】的，只能整份重烘。签名不变就不动
  // （同一色值反复推入、或改的是与套边无关的项，都不该触发几百张画布的重建）。
  function refreshHalo() {
    if (haloKey() === haloNow) return
    rebuildLabels()
    if (lastProvData) setProvinces(lastProvData)
    if (lastCityData) setCities(lastCityData)
  }
  // 视角/用户覆写改动由解算器广播回来 —— 场景不关心是谁改的，一律整份重建
  const offPov = onPovChange(rebuildBasemap)
  buildBorderLines()   // 五类边界线首次构建（放在这里是因为 classPos 用到的 const 到此才初始化完）
  buildChainLine(); rebuildChainLabels()   // 岛链：同上（默认整层不可见）
  buildGrid()          // 经纬网同理：disposeFatLine / fatSegments 到此才可用

  async function setMapDetail(detail, thin) {
    const t = (thin != null) ? thin : mapThin
    const changedThin = t !== mapThin
    if (detail === mapDetail0 && !changedThin) return
    try { await ensureDetail(detail) }
    catch (e) { console.warn(detail + ' 底图加载失败，保持当前精度', e); return }
    mapDetail0 = detail; mapThin = t
    rebuildBasemap()
  }
  // 大地颜色（基调方案 + 逐国覆盖，与 2D 平面图同步）：写入公共色板状态后重建陆地三角网。
  // 颜色烘焙在顶点色里，改色必须重建；仅用户在设置面板操作时触发，代价可接受。
  function setLandColors(s) {
    setLandPalette(s)
    scene.remove(landMesh); landMesh.geometry.dispose(); landMesh.material.dispose()
    landMesh = buildLandMesh(features); scene.add(landMesh)
    applyBaseLayers()   // 同 rebuildBasemap：新 mesh 恒 visible，影像模式下须压回去
    refreshHalo()       // 陆地基调变了 → 套边色/粗细跟着算
  }

  // 一级行政区界 + 地名（按需由上层注入数据）。★ 可反复调用：多选国家时上层把各国的包并成一份重新喂进来，
  // 这里整层重建（原来是「建过就不再建」，多选做不了）。
  let provinceBorders = null, provinceLabels = null, lastProvData = null
  function disposeProvinces() {
    disposeFatLine(provinceBorders); provinceBorders = null
    if (provinceLabels) { scene.remove(provinceLabels); provinceLabels.traverse((c) => { if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose() } }); provinceLabels = null }
  }
  function setProvinces(data) {
    const wasVisible = provinceBorders ? provinceBorders.visible : false
    disposeProvinces()
    lastProvData = data || null      // 套边色是烘在纹理里的，底色换档时要按同一份数据重烘（见 refreshHalo）
    if (!data) return
    const pos = []
    for (const ring of (data.borders || [])) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = llaToVec(ring[i][1], ring[i][0], 0).multiplyScalar(1.0005)
        const b = llaToVec(ring[i + 1][1], ring[i + 1][0], 0).multiplyScalar(1.0005)
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    }
    provinceBorders = fatSegments(pos, borderCfg.provColor, borderCfg.provWidth, borderCfg.provOpacity, ORDER.adm1)   // 压在覆盖之上、国界与海岸之下
    provinceBorders.visible = wasVisible; scene.add(provinceBorders)
    provinceLabels = new THREE.Group(); provinceLabels.visible = wasVisible
    for (const l of (data.labels || [])) {
      // 面积很小的行政区（港澳、直辖市）字号调小，否则名字比辖区还大
      const hpx = l.px != null ? l.px : 0.02
      const spr = makeLabelSprite(l.name, hpx, '#ffe6a8', CASE_K_P, curHalo(), curHaloK())   // 一级行政区
      spr.position.copy(llaToVec(l.lat, l.lon, 25)); spr._dir = spr.position.clone().normalize(); spr._pri = l.pri; spr._rk = l.rk; spr._keep = !!l.keep
      provinceLabels.add(spr)
    }
    applyNameScale(provinceLabels, nameScaleP)   // 套用当前省名字号
    applyLabelStyle(provinceLabels, labelCfg.provColor, labelCfg.provOpacity)   // 套用当前省名颜色/透明度
    scene.add(provinceLabels)
  }
  function setProvincesVisible(v) { if (provinceBorders) provinceBorders.visible = !!v; if (provinceLabels) provinceLabels.visible = !!v }

  // 二级行政区界 + 地名（按需由上层注入数据，格式同一级行政区）。渲染序最低（ORDER.adm2）：压在一级行政区之下。
  let cityBorders = null, cityLabels = null, lastCityData = null
  function disposeCities() {
    disposeFatLine(cityBorders); cityBorders = null
    if (cityLabels) { scene.remove(cityLabels); cityLabels.traverse((c) => { if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose() } }); cityLabels = null }
  }
  function setCities(data) {
    const wasVisible = cityBorders ? cityBorders.visible : false
    disposeCities()
    lastCityData = data || null
    if (!data) return
    const pos = []
    for (const ring of (data.borders || [])) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = llaToVec(ring[i][1], ring[i][0], 0).multiplyScalar(1.0004)
        const b = llaToVec(ring[i + 1][1], ring[i + 1][0], 0).multiplyScalar(1.0004)
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    }
    cityBorders = fatSegments(pos, borderCfg.cityColor, borderCfg.cityWidth, borderCfg.cityOpacity, ORDER.adm2)
    cityBorders.visible = wasVisible; scene.add(cityBorders)
    cityLabels = new THREE.Group(); cityLabels.visible = wasVisible
    for (const l of (data.labels || [])) {
      // 地级市名密集 → 基准字号偏小（小空间），整体再由 nameScaleCity 缩放；黑边尽量细但保留(2px)
      const spr = makeLabelSprite(l.name, l.px != null ? l.px : 0.012, labelCfg.cityColor, CASE_K_C, curHalo(), curHaloK())   // 二级行政区
      spr.position.copy(llaToVec(l.lat, l.lon, 16)); spr._dir = spr.position.clone().normalize(); spr._pri = l.pri; spr._rk = l.rk; spr._keep = !!l.keep
      cityLabels.add(spr)
    }
    applyNameScale(cityLabels, nameScaleCity)
    applyLabelStyle(cityLabels, labelCfg.cityColor, labelCfg.cityOpacity)
    scene.add(cityLabels)
  }
  function setCitiesVisible(v) { if (cityBorders) cityBorders.visible = !!v; if (cityLabels) cityLabels.visible = !!v }
  // 边界线样式（五类各：颜色 / 线宽 px / 透明度 / 线型；ADM1/ADM2：颜色 / 线宽 / 透明度）。
  // merge 到 borderCfg 后改对应材质 uniform；线型改了要重切虚线几何，故那一路走重建。
  // ADM1/ADM2 材质可能尚未创建（懒加载），故一律先存进 borderCfg，setProvinces/setCities 创建时套用。
  //
  // ★「改没改」一律与当前值【比值】，不能按「键在不在 st 里」判：调用方（页面的 applyBorderStyle）
  //   传的是整份样式快照 {...borderStyle}，每个键恒在，按「键在不在」判等于每次都判成【线型变了】+
  //   【间隔变了】—— 拖一下颜色滑块就把五类边界线的几何整份重切一遍（10m 档 48 万个点：逐点 llaToVec
  //   三角函数 + densifyArc 补密 + 虚线切段 + 五次 GPU 重传）再加一次经纬网重建。这就是「调颜色很卡」
  //   的根因。颜色 / 线宽 / 透明度本来就只是材质的事，几何一点不用动。
  function setBorderStyle(st) {
    if (!st) return
    const chg = (k) => st[k] != null && st[k] !== borderCfg[k]     // 必须在 Object.assign 之前问
    let reDash = false
    for (const cls of BORDER_CLASSES) if (chg(CFG_KEY[cls] + 'Dash')) reDash = true
    const reGrid = chg('gridStep') || chg('gridDash')
    Object.assign(borderCfg, st)
    if (reDash) buildBorderLines()   // 重建即按新 borderCfg 建材质，无需再逐个改
    else for (const cls of BORDER_CLASSES) {
      const k = CFG_KEY[cls], o = borderLines[cls]
      if (!o) continue
      const m = o.material
      if (st[k + 'Color'] != null) m.color.set(st[k + 'Color'])
      if (st[k + 'Width'] != null) m.linewidth = st[k + 'Width']
      if (st[k + 'Opacity'] != null) m.opacity = st[k + 'Opacity']
    }
    // 经纬网：间隔 / 线型变了重建几何，其余就地改材质 / 显隐
    if (graticule) {
      if (reGrid) buildGrid()
      else {
        const m = graticule.material
        if (st.gridColor != null) m.color.set(st.gridColor)
        if (st.gridWidth != null) m.linewidth = st.gridWidth
        if (st.gridOpacity != null) m.opacity = st.gridOpacity
        if (st.gridOn != null) graticule.visible = st.gridOn !== false
      }
    }
    if (provinceBorders) {
      const m = provinceBorders.material
      if (st.provColor != null) m.color.set(st.provColor)
      if (st.provWidth != null) m.linewidth = st.provWidth
    }
    if (cityBorders) {
      const m = cityBorders.material
      if (st.cityColor != null) m.color.set(st.cityColor)
      if (st.cityWidth != null) m.linewidth = st.cityWidth
    }
    fadeApplied = -1   // 透明度由 applyFade 统一落（它还要乘缩放淡出系数）
  }

  // ===================== 聚焦卫星显示样式（用户可自定义） =====================
  // 由 3D 页「显示设置 · 聚焦卫星」经 setFocusStyle 推入；setSelectionSet / setFocusSatLLA / 高亮环
  // 每次重建时读取（重建每拍都做，故改样式无需另开通道，页面改完再 commit 一次即可）。
  // 颜色一律 0xRRGGBB 数值（#hex 由调用方转好，环色例外——它画进 canvas 纹理，直接用 CSS 串）；
  // 线宽 = 屏幕像素；透明度 0~1；线型 solid | dash | dot。
  // 在轨点像素：略大于星点云(SAT_POINT_PX≈3.2)，压在细轨道之上、落在高亮环内；非主选小一档。
  const focusCfg = {
    orbOn: true, orbColor: 0x6f9fc8, orbWidth: 1.3, orbOpacity: 0.9, orbDash: 'solid',
    trkOn: true, trkColor: 0xe8c074, trkWidth: 1.6, trkOpacity: 1, trkDash: 'solid',
    fpOn: true, fpColor: 0xb8e6fa, fpWidth: 1.6, fpOpacity: 1, fpDash: 'dash',
    fpFillColor: 0xb8e6fa, fpFillOpacity: 0,
    coneOn: false, coneFaceColor: 0xb8e6fa, coneFaceOpacity: 0.75,
    coneGenCount: 0, coneGenColor: 0xb8e6fa, coneGenWidth: 1, coneGenOpacity: 0.55, coneGenDash: 'solid',
    dotOn: true, dotPx: 13, subPx: 30, subColor: 0xffffff,
    ringOn: true, ringColor: '#ffd27a', ringPx: 26
  }
  // 出厂样式快照：可见性分析的「视线斜线 + 可见星点」借同一条通道呈现，但它不是聚焦星的轨道线，
  // 不该跟着聚焦样式一起变色/关掉 —— 那类条目标 raw:true，一律按这份出厂值画。
  const DEF_CFG = { ...focusCfg }
  function setFocusStyle(s) {
    if (!s) return
    const oldRing = focusCfg.ringColor
    Object.assign(focusCfg, s)
    if (focusCfg.ringColor !== oldRing) retintRing()
    // ★ 这里【不要】调 setOrbitRingSet() 去「就地重建」轨道圈：环现在由 setFocusLanes 产出，
    //   orbRingItems 恒为空，那个函数进去只会 disposeOrbRings() 然后早退 —— 轨道线当场消失，
    //   之后要么等调用方那次带 ringDirty 的 commit、要么等 TTL 到期才回得来（曾如此）。
    //   重建统一交给调用方：改样式后必跟一次 commitGeometry，且已置 ringDirty（见页面的 applyFocusStyle）。
    //   只有「关掉」是立刻的事，不必等下一拍。
    if (!focusCfg.orbOn) disposeOrbRings()
  }

  // 选中高亮：金色圆环（与 2D 星座地图一致），每颗聚焦星一个（主选略大一档，与在轨点/轨道线同一套主次口径）。
  // 画法＝贴图点层（见 buildPointLayers）：固定屏幕像素、一次 draw call、被地球挡住由深度测试自然剔除。
  // ★ 别退回「一星一个 Sprite + 每帧逐个反缩放/遮挡判定」：聚焦上千颗时那是几千个对象、几千次 draw call。
  function makeRingTexture(color) {
    const s = 128, c = document.createElement('canvas')
    c.width = c.height = s
    const x = c.getContext('2d')
    x.strokeStyle = color || '#ffd27a'; x.lineWidth = 9; x.shadowColor = 'rgba(0,0,0,0.6)'; x.shadowBlur = 4
    x.beginPath(); x.arc(s / 2, s / 2, s / 2 - 12, 0, Math.PI * 2); x.stroke()
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
    // 与 makeDotTex 同一条理由：本贴图全局只此一份，而挂着它的点层（ringGroup / laneHlGroup）每拍随
    // 几何重建、每拍走一次 disposeGroup —— 不打这个标志就会被连带 dispose 掉，此后每帧再被 three
    // 重新上传一遍（画面看不出来，纯白烧）。释放由 retintRing 换色时显式做，不归 disposeGroup 管。
    t._shared = true
    return t
  }
  // 环色画进贴图（不是材质染色），换色即重画贴图；点层每拍随几何一起重建，故只需换掉贴图本身。
  let ringTex = makeRingTexture(focusCfg.ringColor)
  function retintRing() {
    const old = ringTex
    ringTex = makeRingTexture(focusCfg.ringColor)
    if (ringGroup) for (const o of ringGroup.children) o.material.map = ringTex
    if (laneHlGroup) for (const o of laneHlGroup.children) o.material.map = ringTex
    if (old) old.dispose()
  }
  let ringGroup = null

  // 选中卫星几何：轨道圈（3D）、星下点轨迹（贴地）、覆盖足迹圈（贴地）。
  // 球体不透明 + 默认深度测试 -> 背面线段被地球天然遮挡，无需手动分正/背面。
  let orbitLine = null, trackLine = null, footLine = null
  function disposeLine(l) { if (l) { scene.remove(l); l.geometry.dispose(); if (l.material) { lineMats.delete(l.material); l.material.dispose() } } }
  function lineFromLLA(points, color, opacity, width) {
    const pts = points.map((p) => llaToVec(p.lat, p.lon, p.altKm || 0))
    return fatStrip(pts, color, width || 1.4, opacity, 6)   // 与 GRD 等值线/Polygon 线同层(6)：覆盖填充(5)之上、国界省界(6.5+)之下
  }
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
  // 合批：同样式的线并进一条 LineSegments2，线对象数与聚焦颗数无关（默认样式下 3~4 条）。
  // 多选几百颗时重建与绘制都不再随颗数线性膨胀。Line2 内部本就把折线拆成相邻点对喂同一材质，
  // 故合批后画面与逐条画完全一致（颜色/线宽/透明度照旧，primary 仍自成一档以加粗加亮）。
  // 合批出来的半透明面（覆盖圈填充 / 覆盖锥锥面各一批）
  function fillMesh(pos, color, opacity, order) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: Math.max(0, Math.min(1, opacity)), side: THREE.DoubleSide, depthWrite: false
    }))
    mesh.renderOrder = order
    return mesh
  }
  // 上一拍各桶的顶点数：这一拍照着预留，省掉 sink 从 8 KB 一路翻倍到上百 MB 的那串重分配拷贝
  //（几何逐拍几乎同量，估得准；估歪了也只是退回翻倍，不会出错）。
  const sinkHint = new Map()
  const hintedSink = (key) => createSink(Math.max(4096, sinkHint.get(key) || 0))
  // 选中星「在轨点」：合批成贴图点层，不再一星一个 Sprite。
  // ★ 与高亮环同一条理由（见 buildPointLayers 上方那段）：聚焦上千颗时逐个 Sprite 是几千个对象、
  //   每帧几千次 draw call，还要逐个反缩放 —— 取消颗数上限后这一层会先塌。
  // 外观逐样保留：底盘按星点原色染（disc 贴图是白的，靠材质 color 上色），白圈单独一层压在上面
  //（一张贴图做不到「盘染色、圈恒白」—— PointsMaterial 的 color 是整张贴图相乘）。
  let dotDiscTex = null, dotRingTex = null
  function makeDotTex(draw) {
    const s = 32, c = document.createElement('canvas'); c.width = c.height = s
    draw(c.getContext('2d'))
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
    t._shared = true   // 两张贴图全局各一份：点层每拍重建，disposeGroup 认这个标志才不会把它们连带释放
    return t
  }
  // 星点原色是 CSS 串（satDotHex），点层材质要数值
  const hexOf = (c) => { if (Number.isFinite(c)) return c; const n = typeof c === 'string' ? parseInt(String(c).replace('#', ''), 16) : NaN; return Number.isFinite(n) ? n : 0x9fd0ef }
  const discTex = () => (dotDiscTex || (dotDiscTex = makeDotTex((x) => { x.beginPath(); x.arc(16, 16, 9, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill() })))
  const dotRing = () => (dotRingTex || (dotRingTex = makeDotTex((x) => { x.beginPath(); x.arc(16, 16, 9, 0, Math.PI * 2); x.lineWidth = 3; x.strokeStyle = 'rgba(255,255,255,0.92)'; x.stroke() })))
  // list: [{lat, lon, altKm, px, colorHex}]
  function buildDotLayer(list) {
    if (!list.length) return null
    const g = new THREE.Group()
    const disc = buildPointLayers(list, discTex(), 13, 0xffffff, 7, 0)
    const ring = buildPointLayers(list.map((q) => ({ lat: q.lat, lon: q.lon, altKm: q.altKm, px: q.px })), dotRing(), 13, 0xffffff, 7.1, 0)
    if (disc) g.add(disc)
    if (ring) g.add(ring)
    return g.children.length ? g : null
  }
  function setSelectionSet(items) {
    disposeSelSet()
    if (!items || !items.length) return
    selSetGroup = new THREE.Group()
    const dotList = []
    // 半透明面（覆盖圈填充 / 覆盖锥锥面）按「层序|色|透明度」分桶，最后各成一个几何体。
    // 层序：填充 4.2＝Polygon 区域填充(4)之上、GRD 覆盖场(5)之下（叠加区仍以覆盖图为准）；
    //       锥面 5.5＝覆盖场之上、数据线(6)之下（锥体悬在地表之上该盖住它罩的那块场，但线是标注不该被糊掉）。
    const faceBuckets = new Map()
    const faceBucket = (order, color, opacity) => {
      const key = order + '|' + color + '|' + opacity
      let b = faceBuckets.get(key)
      if (!b) { b = { order, color, opacity, pos: hintedSink('f' + key) }; faceBuckets.set(key, b) }
      return b.pos
    }
    // 按「色|宽|透明度」分桶合批：默认样式下轨道(主/非主) + 轨迹 + 足迹共 4 桶，与颗数无关
    const buckets = new Map()
    const bucket = (color, width, opacity) => {
      const key = color + '|' + width + '|' + opacity
      let b = buckets.get(key)
      if (!b) { b = { color, width, opacity, seg: hintedSink('l' + key) }; buckets.set(key, b) }
      return b.seg
    }
    for (const it of items) {
      const cfg = it.raw ? DEF_CFG : focusCfg   // raw=可见性的视线斜线/可见星点：钉出厂样式，不跟聚焦设置走
      // 轨道圈/星下点轨迹/覆盖足迹各自取设置里的色/宽/透明度/线型，多颗同时叠画；
      // primary 仅加粗加亮以区分聚焦星（不变色）：非主选按 0.77 宽、0.56 透明度收一档（=旧的 1.3→1.0 / 0.9→0.5）
      if (cfg.orbOn && it.orbit && it.orbit.length > 1) {
        const w = it.primary ? cfg.orbWidth : cfg.orbWidth * 0.77
        const op = it.primary ? cfg.orbOpacity : cfg.orbOpacity * 0.56
        pushDashed(bucket(cfg.orbColor, w, op), it.orbit.map((p) => llaToVec(p.lat, p.lon, p.altKm || 0)), cfg.orbDash)
      }
      if (cfg.trkOn && it.track && it.track.length > 1) {
        pushDashed(bucket(cfg.trkColor, cfg.trkWidth, cfg.trkOpacity), densifyArc(it.track.map((p) => llaToVec(p.lat, p.lon, LIFT))), cfg.trkDash)
      }
      // 覆盖圈那一圈点：覆盖圈线与覆盖锥共用（关掉线只是不画线，锥还得靠它定底边）
      const ring = ((cfg.fpOn || cfg.coneOn) && it.footprint && it.footprint.length > 1)
        ? it.footprint.map((p) => llaToVec(p.lat, p.lon, LIFT)) : null
      if (ring && cfg.fpOn) {
        pushDashed(bucket(cfg.fpColor, cfg.fpWidth, cfg.fpOpacity), densifyArc(ring), cfg.fpDash)   // 补密只给【线】：填充/锥面各自有同款补密，ring 原样传下去
        if (cfg.fpFillOpacity > 0) footprintFill(ring, it.satPos, faceBucket(4.2, cfg.fpFillColor, cfg.fpFillOpacity))
      }
      // 覆盖锥：卫星本体 → 覆盖圈边界的锥面与母线。张角口径随覆盖圈定义走（波束全锥角 / 最低仰角）。
      // 只在 3D 球体画：等距圆柱图上锥面的正投影就是覆盖圈本身，画出来只是把那个圈再描一遍。
      if (cfg.coneOn && ring && it.satPos && Number.isFinite(it.satPos.altKm) && it.satPos.altKm > 0) {
        const apex = llaToVec(it.satPos.lat, it.satPos.lon, it.satPos.altKm)
        if (cfg.coneFaceOpacity > 0) coneFace(apex, ring, faceBucket(5.5, cfg.coneFaceColor, cfg.coneFaceOpacity))
        if (cfg.coneGenCount > 0) {
          const seg = bucket(cfg.coneGenColor, cfg.coneGenWidth, cfg.coneGenOpacity)
          const n = ring.length - 1                                  // 环首尾同点，取 n 个不重复方位
          const k = Math.max(1, Math.min(n, Math.round(cfg.coneGenCount)))
          for (let i = 0; i < k; i++) pushDashed(seg, [apex, ring[Math.round(i * n / k) % n]], cfg.coneGenDash)
        }
      }
      // 选中星「在轨点」：在卫星真实在轨位置画大号圆点，跟随星点原色。renderOrder 7 > 轨道线 6 → 同深度时点画在线之上，不被细轨道盖住；
      // makeDot 自带 depthTest 开 → 背面星点仍由不透明地球深度天然剔除（绝不能关 depthTest）。随缩放联动见 rescaleMarkers。
      if (cfg.dotOn && it.satPos && Number.isFinite(it.satPos.lat) && Number.isFinite(it.satPos.lon)) {
        dotList.push({
          lat: it.satPos.lat, lon: it.satPos.lon, altKm: it.satPos.altKm || 0,
          px: it.primary ? cfg.dotPx : Math.max(2, cfg.dotPx - 2),
          colorHex: hexOf(it.satPos.color)
        })
      }
    }
    for (const [k, b] of faceBuckets) { sinkHint.set('f' + k, b.pos.n); if (b.pos.n) selSetGroup.add(fillMesh(b.pos.view(), b.color, b.opacity, b.order)) }
    for (const [k, b] of buckets) { sinkHint.set('l' + k, b.seg.n); if (b.seg.n) selSetGroup.add(fatSegments(b.seg.view(), b.color, b.width, b.opacity, 6)) }
    scene.add(selSetGroup)
    selDotGroup = buildDotLayer(dotList)
    if (selDotGroup) scene.add(selDotGroup)
  }
  // ===================== 聚焦星轨道圈：独立一层，每拍只设一次朝向 =====================
  // 轨道圈画的是【惯性系】里那条闭合曲线，逐拍变的只有地球转角。所以它单独成组：几何只在重建时建一次，
  // 之后每拍给整组设一个绕极轴的四元数就位 —— 顶点不动、不重传、逐顶点计算归零。
  // ★ 必须与足迹/填充/覆盖锥/在轨点/星下点轨迹分开：那几样要么钉在【地球】上、要么跟着卫星走，
  //   跟着环一起转就全错了（星下点轨迹尤其 —— 它算过一次就钉死在地面上，转它等于让轨迹在地上滑）。
  //   故本组只收轨道圈，setSelectionSet 那边的 it.orbit 留给对星聚焦/可见性那类逐拍现算的条目。
  // 上游口径见 viz/constellation/focusGeomCache.js。
  let orbRingGroup = null, orbRingItems = null, orbRingSpin = 0
  const ORB_AXIS = new THREE.Vector3(0, 1, 0)      // llaToVec 里 Y 是极轴（不是 Z）
  function disposeOrbRings() {
    if (!orbRingGroup) return
    for (const l of orbRingGroup.children) { l.geometry.dispose(); if (l.material) { lineMats.delete(l.material); l.material.dispose() } }
    scene.remove(orbRingGroup); orbRingGroup = null
  }
  // items=[{ lla:[{lat,lon,altKm}...], primary }]，经纬高按【参考 gmst】给；省略 items 则按上次那份重建
  //（改样式走这条：颜色/线宽/线型变了但几何没变，不必让上游把整批星的 SGP4 重推一遍）。
  function setOrbitRingSet(items) {
    if (items !== undefined) orbRingItems = items
    disposeOrbRings()
    if (!orbRingItems || !orbRingItems.length || !focusCfg.orbOn) return
    // 与 setSelectionSet 同一套合批口径：色恒定，只按「宽|透明度」分主/非主两桶
    const buckets = new Map()
    for (const it of orbRingItems) {
      if (!it || !it.lla || it.lla.length < 2) continue
      const w = it.primary ? focusCfg.orbWidth : focusCfg.orbWidth * 0.77
      const op = it.primary ? focusCfg.orbOpacity : focusCfg.orbOpacity * 0.56
      const k = w + '|' + op
      let b = buckets.get(k)
      if (!b) { b = { w, op, seg: hintedSink('o' + k) }; buckets.set(k, b) }
      pushDashed(b.seg, it.lla.map((p) => llaToVec(p.lat, p.lon, p.altKm || 0)), focusCfg.orbDash)
    }
    let any = false
    const g = new THREE.Group()
    for (const [k, b] of buckets) { sinkHint.set('o' + k, b.seg.n); if (b.seg.n) { g.add(fatSegments(b.seg.view(), focusCfg.orbColor, b.w, b.op, 6)); any = true } }
    if (!any) return
    g.quaternion.setFromAxisAngle(ORB_AXIS, orbRingSpin)
    orbRingGroup = g
    scene.add(orbRingGroup)
  }
  // 每拍一次：rad = 参考 gmst − 当前 gmst（地球东转 ΔGMST，环相对地球就该反着转这么多）
  function setOrbitRingSpin(rad) {
    orbRingSpin = Number.isFinite(rad) ? rad : 0
    if (orbRingGroup) orbRingGroup.quaternion.setFromAxisAngle(ORB_AXIS, orbRingSpin)
  }
  // ===================== 聚焦星几何：预制顶点通道（Worker 池产出）=====================
  // 与 setSelectionSet 的分工：
  //   · setSelectionSet —— 逐拍现算的【少量】条目（对星覆盖聚焦特效、可见性叠加层），照旧「喂经纬度、这里算顶点」；
  //   · setFocusLanes   —— 聚焦选中集（可上万颗），顶点已在 Worker 里按【同一份】focusLanes 原语算好，
  //                        这里只建 BufferGeometry 上传，主线程逐顶点计算为零、逐颗建对象也为零。
  // shards: 每个分片一份 { orb, orbP, trk, fp, gen, fill, cone, sub, hl, hlP, dots:[{px,tint,n,buf}] }，
  //         其中 {n, buf} 是已 transfer 过来的 Float32Array 底层缓冲。
  // opt.ringBuild: 这一拍轨道圈几何有没有重建；没重建就不碰环组（它只需每拍设一次朝向）。
  let laneGroup = null, laneDotGroup = null, laneSubGroup = null, laneHlGroup = null
  function disposeLanes() {
    if (laneGroup) { for (const o of laneGroup.children) { o.geometry.dispose(); if (o.material) { lineMats.delete(o.material); o.material.dispose() } } scene.remove(laneGroup); laneGroup = null }
    disposeGroup(laneDotGroup); laneDotGroup = null
    disposeGroup(laneSubGroup); laneSubGroup = null
    disposeGroup(laneHlGroup); laneHlGroup = null
  }
  const laneArr = (x) => (x && x.n > 0 ? new Float32Array(x.buf, 0, x.n) : null)
  // 一批预制顶点 → 一个 THREE.Points（材质口径与 buildPointLayers 逐字一致：屏幕像素尺寸 + 着色器里剔背面）
  function lanePoints(pos, tex, px, tint, order) {
    if (!pos) return null
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const mat = cullBehindGlobe(new THREE.PointsMaterial({
      map: tex, color: tint, size: px, sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false, alphaTest: 0.02
    }))
    const o = new THREE.Points(geo, mat)
    o.renderOrder = order; o._px = px
    return o
  }
  function setFocusLanes(shards, opt) {
    disposeLanes()
    if (opt && opt.ringBuild) disposeOrbRings()
    if (!shards || !shards.length) { if (opt && opt.ringBuild) orbRingItems = null; return }
    const c = focusCfg
    const g = new THREE.Group()
    const dotG = new THREE.Group(), subG = new THREE.Group(), hlG = new THREE.Group()
    const rg = (opt && opt.ringBuild) ? new THREE.Group() : null
    // ★ 线必须跨分片【合成一条】：同一 renderOrder 下 three 对透明物体按深度排序，物体个数一变排法就变 ——
    //   不合的话画面会随 Worker 数抖动（实测线交叉处 0.14% 像素）。合成后每条线通道恒是一个对象，
    //   与 setSelectionSet 那条老路逐像素一致，也与分成几片无关。线的数据量不大（7000 颗约 6 MB），合得起。
    // ★ 半透明【面】不必合：同一通道内颜色与透明度都相同，逐层混合的结果与先后无关，合了只是白拷贝一百 MB。
    const cat = (k) => {
      let n = 0
      for (const sh of shards) n += (sh[k] && sh[k].n) || 0
      if (!n) return null
      if (shards.length === 1) return laneArr(shards[0][k])
      const out = new Float32Array(n)
      let o = 0
      for (const sh of shards) { const a = laneArr(sh[k]); if (a) { out.set(a, o); o += a.length } }
      return out
    }
    const line = (grp, a, color, w, op) => { if (a) grp.add(fatSegments(a, color, w, op, 6)) }
    const face = (a, color, op, order) => { if (a) g.add(fillMesh(a, color, op, order)) }
    if (rg) {
      line(rg, cat('orb'), c.orbColor, c.orbWidth * 0.77, c.orbOpacity * 0.56)   // 非主选收一档（与 setSelectionSet 同口径）
      line(rg, cat('orbP'), c.orbColor, c.orbWidth, c.orbOpacity)
    }
    line(g, cat('trk'), c.trkColor, c.trkWidth, c.trkOpacity)
    line(g, cat('fp'), c.fpColor, c.fpWidth, c.fpOpacity)
    line(g, cat('gen'), c.coneGenColor, c.coneGenWidth, c.coneGenOpacity)
    for (const sh of shards) {
      // 层序与 setSelectionSet 一致：填充 4.2（Polygon 之上、GRD 覆盖场之下）、锥面 5.5（覆盖场之上、数据线之下）
      face(laneArr(sh.fill), c.fpFillColor, c.fpFillOpacity, 4.2)
      face(laneArr(sh.cone), c.coneFaceColor, c.coneFaceOpacity, 5.5)
    }
    // ★ 点层与线同一条理由，也必须跨分片合成一个：这些图标半透明、且 depthTest 关（背面剔除在着色器里做），
    //   叠在一起时结果取决于画的先后；对象个数一随分片数变，three 对同 renderOrder 透明物体的深度排序就变，
    //   同一批星画出来的图便随 Worker 数抖动 —— 实测 400 颗密排 0.995% 的像素不一样（最大通道差 106），
    //   差异点全落在星下点图标 / 高亮环 / 在轨点这三层上。合并之后与单片（就地档）逐像素相同。
    //   在轨点按「像素大小|染色」分桶合（主选与非主选大小不同，是两个桶，不能混成一批）。
    const dotBuckets = new Map()
    for (const sh of shards) for (const d of (sh.dots || [])) {
      const a = laneArr(d)
      if (!a) continue
      const key = d.px + '|' + d.tint
      let b = dotBuckets.get(key)
      if (!b) { b = { px: d.px, tint: d.tint, parts: [], n: 0 }; dotBuckets.set(key, b) }
      b.parts.push(a); b.n += a.length
    }
    for (const b of dotBuckets.values()) {
      let pos = b.parts[0]
      if (b.parts.length > 1) { pos = new Float32Array(b.n); let o = 0; for (const a of b.parts) { pos.set(a, o); o += a.length } }
      const disc = lanePoints(pos, discTex(), b.px, b.tint, 7); if (disc) dotG.add(disc)
      const ring = lanePoints(pos, dotRing(), b.px, 0xffffff, 7.1); if (ring) dotG.add(ring)
    }
    { const o = lanePoints(cat('sub'), focusSatTexture(), Math.max(2, Number(c.subPx) || FOCUS_SAT_PX), Number.isFinite(c.subColor) ? c.subColor : 0xffffff, 17); if (o) subG.add(o) }
    const hpx = Math.max(2, Number(c.ringPx) || 26)
    { const o = lanePoints(cat('hl'), ringTex, hpx * 0.82, 0xffffff, 20); if (o) hlG.add(o) }
    { const o = lanePoints(cat('hlP'), ringTex, hpx, 0xffffff, 20); if (o) hlG.add(o) }
    if (g.children.length) { laneGroup = g; scene.add(g) }
    if (dotG.children.length) { laneDotGroup = dotG; scene.add(dotG) }
    if (subG.children.length) { laneSubGroup = subG; scene.add(subG) }
    if (hlG.children.length) { laneHlGroup = hlG; scene.add(hlG) }
    if (rg) { if (rg.children.length) { rg.quaternion.setFromAxisAngle(ORB_AXIS, orbRingSpin); orbRingGroup = rg; scene.add(rg) } orbRingItems = null }
  }
  function clearSelectionGeom() { setOrbit(null); setGroundTrack(null); setFootprint(null); setHighlight(null); disposeSelSet(); disposeLanes(); setOrbitRingSet(null) }

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
    x.lineWidth = CASE_K * fs * curHaloK(); x.strokeStyle = curHalo(); x.strokeText(text, c.width / 2, c.height / 2)   // 与 2D 的 CASE_K 同一档；色与粗细随底色
    x.fillStyle = color || '#ffffff'; x.fillText(text, c.width / 2, c.height / 2)
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: true, depthWrite: false, transparent: true }))
    const s = hpx || 0.03; spr.scale.set((c.width / c.height) * s, s, 1)
    return spr
  }
  // 峰值点标记＝细十字（对齐 SATSOFT §11.1 Contour Dialog 的 Beam Peak Label「+」）：叉心就是那个点，
  // 两条细臂不遮挡下面的等值线/填充——实心圆点会把它标的那一小块盖掉，且看不出准确落点在哪。
  // ★ 必须用 fatSegments 画，不能用贴图精灵：LineMaterial 的 linewidth 在 worldUnits:false 下是【屏幕
  //   像素】，放大只变长不变粗；贴图版的笔画是纹理里的固定比例，跟着尺寸一起放大，缩放几档后就成了一个
  //   又粗又笨的实心加号（SATSOFT 的十字自始至终是一根细线）。线宽与等值线同档，看上去就是「画在图上的
  //   一个十字」而不是贴上去的符号；也因此不再需要深色套边——等值线自己也没有。
  // 两条臂躺在当地切平面（东/北向），span = 十字全长（世界尺寸，与 makeCovLabel 的 hpx 同一套尺度）。
  // ★ 2D 平面图那份在 flatCoverage.drawFieldOverlays / cross()，尺寸律与线宽必须与此处一致。
  const CROSS_W = 1.3            // 十字线宽（屏幕 px），与等值线默认 1.2 同档
  const _cu = new THREE.Vector3(), _ce = new THREE.Vector3(), _cn = new THREE.Vector3()
  const _CY = new THREE.Vector3(0, 1, 0)
  function makeCovCross(anchor, span, color) {
    _cu.copy(anchor).normalize()
    _ce.crossVectors(_CY, _cu)
    if (_ce.lengthSq() < 1e-12) _ce.set(1, 0, 0)   // 正对极点：参考轴退化，换一根
    _ce.normalize()
    _cn.crossVectors(_cu, _ce).normalize()
    const h = span * 0.5
    const ex = _ce.x * h, ey = _ce.y * h, ez = _ce.z * h
    const nx = _cn.x * h, ny = _cn.y * h, nz = _cn.z * h
    return fatSegments([
      anchor.x - ex, anchor.y - ey, anchor.z - ez, anchor.x + ex, anchor.y + ey, anchor.z + ez,
      anchor.x - nx, anchor.y - ny, anchor.z - nz, anchor.x + nx, anchor.y + ny, anchor.z + nz
    ], color != null ? color : 0xffffff, CROSS_W, 1, 11)
  }
  // 十字全长 = boreSize × 此常量（世界尺寸）。默认 boreSize=0.5 → 0.012 ≈ 9 px，与默认峰值字号(5→7px)
  // 的比例正是 SATSOFT 图上那个「叉略大于读数字高」的观感。2D 侧同值（换算 px = 世界尺寸 × 750 × zf）。
  const BORE_SPAN = 0.024
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
  // 一层的装饰（等值线 + 数值/名称/峰值标签 + 峰值点）：与对地 buildDeco 同策略——相对填充轻量，每次重建。
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
      out.push(covContourLine(flat, grp, o))
    }
    // 数值标签：每档一处（锚点由上游按等值线环给）
    if (o.showVal) for (const grp of (L.segGroups || [])) {
      if (grp.txt == null) continue
      for (const an of (grp.labels || [])) {
        const spr = makeCovLabel(String(grp.txt), (o.valSize || 12) / 533, o.valColor || '#ffffff')
        const pos = llaToVec(an[1], an[0], la)
        pos.addScaledVector(pos.clone().normalize(), spr.scale.y * 0.6)
        spr.position.copy(pos); spr.renderOrder = 12; out.push(spr)
      }
    }
    // 峰值点（峰值方向与壳层的交点）+ 波束名：与对地覆盖同款（细十字 + 上方两行），只是锚在壳面上。
    // ★ b.hit=false ＝ 峰值方向压根没打到这层壳（相切兜底点不是射线真正到达的位置）：
    //   十字与峰值电平一律不画，b.lon/lat 只留作波束名的锚。
    const b = L.bore
    if (b) {
      const hit = b.hit !== false
      const anchor = llaToVec(b.lat, b.lon, la)
      const span = (o.boreSize || 0.5) * BORE_SPAN
      const crossOn = o.showBore && hit
      const peakOn = o.showPeak && hit && b.peak != null
      const peakH = (o.peakSize || 5) / 533, nameH = (o.nameSize || 16) / 533
      const lift = (crossOn ? span * 0.5 : 0) + 0.0015
      // 连线不在这儿画：对星视图的射线是【天线视轴】那一条，由 setShellRays 单独出（波束打不到壳层时也得有）
      if (crossOn) out.push(makeCovCross(anchor, span, o.boreColor || '#ffffff'))
      if (peakOn) {
        const spr = makeCovLabel(b.peak.toFixed(2), peakH, o.peakColor || '#cfd6df')
        spr.center.set(0.5, -(lift / peakH)); spr.position.copy(anchor); spr.renderOrder = 12; out.push(spr)
      }
      if (o.showName && L.name) {
        const spr = makeCovLabel(L.name, nameH, o.nameColor || '#ffffff')
        spr.center.set(0.5, -((lift + (peakOn ? peakH * 1.15 : 0)) / nameH))
        spr.position.copy(anchor); spr.renderOrder = 13; out.push(spr)
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

  // 壳层参照网（稀疏球面经纬格网）：等值线悬在空中没有「面」的落点，画一层极淡的格网当参照。
  // 与场数据分开成组：改指向/电平时只重建场，参照网不动。
  // list=[{R, color}]（颜色随壳层，兼列表身份色）；style={ step, latMax, width, alpha, dash } 全局一份。
  //
  // 走粗线基建（LineSegments2 + LineMaterial）而不是 LineBasicMaterial：后者的 linewidth 在 WebGL 下
  // 恒等于 1 设备像素，线宽根本调不动。代价是材质要进 lineMats（resize 时统一刷 resolution），
  // 于是 clearShellGuides 必须显式 lineMats.delete —— 漏掉就是集合泄漏 + resize 后线宽失真。
  const GUIDE_SAMP = 5                          // 折线采样步（°）：与格网间隔无关，只管球面弧够圆滑
  const GUIDE_DASH = 0.02, GUIDE_GAP = 0.012    // 虚线尺寸：场景世界单位（球半径 1 = 6371 km）
  let shellGuideGroup = null
  function clearShellGuides() {
    if (!shellGuideGroup) return
    shellGuideGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { lineMats.delete(o.material); o.material.dispose() } })
    scene.remove(shellGuideGroup); shellGuideGroup = null
  }
  function setShellGuides(list, style) {
    clearShellGuides()
    if (!list || !list.length) return
    const st = style || {}
    const step = Number(st.step) > 0 ? Number(st.step) : 30
    const latMax = Number(st.latMax) > 0 ? Math.min(Number(st.latMax), 89) : 60
    const width = Number(st.width) > 0 ? Number(st.width) : 0.8
    const alpha = st.alpha != null && Number.isFinite(Number(st.alpha)) ? Number(st.alpha) : 0.14   // 别用 Number(null)=0：会把整层网调成全透明
    const nLon = Math.max(1, Math.round(360 / step))
    const nLat = Math.floor(latMax / step)      // 纬线 = 间隔的整倍数 ∩ ±latMax（0° 赤道恒在内）
    const g = new THREE.Group()
    for (const sh of list) {
      const la = shellAlt(sh.R), pos = []
      const push = (lat, lon) => { const v = llaToVec(lat, lon, la); pos.push(v.x, v.y, v.z) }
      for (let k = 0; k < nLon; k++) {                                   // 经线：全程 −90…90
        const lon = -180 + k * step
        for (let lat = -90; lat < 90; lat += GUIDE_SAMP) { push(lat, lon); push(lat + GUIDE_SAMP, lon) }
      }
      for (let i = -nLat; i <= nLat; i++) {                              // 纬线
        const lat = i * step
        for (let lon = -180; lon < 180; lon += GUIDE_SAMP) { push(lat, lon); push(lat, lon + GUIDE_SAMP) }
      }
      const geo = new LineSegmentsGeometry(); geo.setPositions(pos)
      const mat = regMat(new LineMaterial({
        color: new THREE.Color(sh.color != null ? sh.color : 0x6b8199),
        linewidth: width, transparent: true, opacity: alpha, worldUnits: false, depthWrite: false,
        dashed: !!st.dash, dashSize: GUIDE_DASH, gapSize: GUIDE_GAP
      }))
      const ls = new LineSegments2(geo, mat)
      if (st.dash) ls.computeLineDistances()    // 虚线必做：不算线上距离，USE_DASH 分支拿不到 vLineDistance，虚线不显示
      ls.renderOrder = 4.6; ls.frustumCulled = false
      g.add(ls)
    }
    shellGuideGroup = g; scene.add(g)
  }

  // 波束射线（对星覆盖分析）：从卫星沿天线视轴射出去的一条线。与「卫星↔峰值点」的连线不同，它
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
  // 一层的「装饰」子物体（等值线 + 数值/峰值/名称标签 + 峰值点/连线）：相对填充轻量，每次 patch 重建。
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
      out.push(covContourLine(flat, grp, o))
    }
    // 数值标签：每条等值线最上端点处各标一次档值（相对/绝对，文本由上游决定）。
    // billboard 朝向相机，下半部分会探入地球被遮挡 → 沿径向抬出约半个标签高度（随字号缩放），整块浮在地表之上。
    if (o.showVal) for (const grp of (L.segGroups || [])) {
      if (grp.txt == null) continue
      for (const an of (grp.labels || [])) {
        const spr = makeCovLabel(String(grp.txt), (o.valSize || 12) / 533, o.valColor || '#ffffff')
        const pos = llaToVec(an[1], an[0], 50); pos.addScaledVector(pos.clone().normalize(), spr.scale.y * 0.6)
        spr.position.copy(pos); spr.renderOrder = 12; out.push(spr)
      }
    }
    // 峰值点：细十字。读数与波束名都码在十字【上方】——SATSOFT 的排布是「波束名 / 峰值读数 / ＋」
    // 自上而下一摞（见手册 §11.1 与多波束例图），不是一上一下分置。
    // 用 billboard 的 center 在【屏幕方向】叠放（旧版按半径抬高，屏幕上几乎重合）。
    // ★ b.hit=false ＝ 峰值方向越过地平、地表上根本没有这个点：十字与峰值电平一律不画，
    //   b.lon/lat 此时只是该方向的地平点，仅用来把波束名锚在那弯残余足迹的边上。
    const b = L.bore
    if (b) {
      const hit = b.hit !== false
      // b.onEarth=false ＝ 波束整个越过地平，地表上这一层一条线一片色都没有 → 名字也不画。
      const named = o.showName && L.name && b.onEarth !== false
      // 峰值点锚（贴地）
      const anchor = llaToVec(b.lat, b.lon, 0).multiplyScalar(1.0012)
      // 文字锚：径向再抬出 ~45km。billboard 整体深度≈锚点深度，抬到球面之前 → 标签不再被地球模型遮挡；
      // depthTest 仍为真，背面波束的标签照常被球体隐藏。
      const labelAnchor = llaToVec(b.lat, b.lon, 45)
      const span = (o.boreSize || 0.5) * BORE_SPAN
      const crossOn = o.showBore && hit
      const peakOn = o.showPeak && hit && b.peak != null
      const peakH = (o.peakSize || 5) / 533, nameH = (o.nameSize || 16) / 533
      const lift = (crossOn ? span * 0.5 : 0) + 0.0015     // 让开十字上臂 + 一点空隙（世界尺寸）
      // 视轴不在这儿画：它是【一根天线一条】（opts.rays，由 buildAxisRays 出），不是逐波束的连线。
      // 原先每个波束层都画一条卫星→峰值点的粗线，94 波束就是每次重建 94 次几何分配 —— 播放时的卡顿大头之一。
      if (crossOn) out.push(makeCovCross(anchor, span, o.boreColor || '#ffffff'))
      // 峰值读数：十字【正上方】第一行。SATSOFT 只印数字不带单位（与等值线标注同体例），此处照办。
      if (peakOn) {
        const spr = makeCovLabel(b.peak.toFixed(2), peakH, o.peakColor || '#cfd6df')
        spr.center.set(0.5, -(lift / peakH)); spr.position.copy(labelAnchor); spr.renderOrder = 12; out.push(spr)
      }
      // 波束名：再往上一行（读数在时让开它一行高，不在时直接贴十字上方）
      if (named) {
        const spr = makeCovLabel(L.name, nameH, o.nameColor || '#ffffff')
        spr.center.set(0.5, -((lift + (peakOn ? peakH * 1.15 : 0)) / nameH))
        spr.position.copy(labelAnchor); spr.renderOrder = 13; out.push(spr)
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
  // 等值线透明度：只动 LineMaterial（填充走 setCoverageFieldAlpha，两者互不影响）。
  // covOpts 同步写回 —— 下一次增量重建 deco 时才不会退回旧值。
  function setCoverageLineAlpha(a) {
    covOpts = { ...covOpts, lineAlpha: a }
    for (const e of covLayers.values()) for (const d of e.deco) if (d.userData && d.userData.covLine) d.material.opacity = a
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
  let stationTex = null
  function stationTexture() {
    if (stationTex) return stationTex
    stationTex = new THREE.Texture(); stationTex.colorSpace = THREE.SRGBColorSpace
    const img = new Image(); img.onload = () => { stationTex.image = img; stationTex.needsUpdate = true }
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(stationSvg())))
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
  // 航迹载具图标（船舶 / 飞机，与 2D 平面图同一份形状 → viz/vehicleSymbol.js）：单色件，按航迹色染。
  // 同（类型|色）共用一张贴图；打 _shared 标记，disposeGroup 见到就跳过 —— 航迹每改一次都重建整组，
  // 贴图不该跟着一起重造重传。
  const vehTexCache = new Map()
  function vehicleTexture(kind, ink) {
    const key = kind + '|' + ink
    let t = vehTexCache.get(key)
    if (!t) {
      // ★ 现画在 canvas 上（同步），不走「SVG → Image → Texture」那条异步路：出图/离屏只渲有限
      //   几帧，图片没回来那一帧上传的是空图，后面又没有帧来补传，图标会整个不出现。
      t = new THREE.CanvasTexture(vehicleCanvas(kind, ink, 256))
      t.colorSpace = THREE.SRGBColorSpace; t._shared = true
      vehTexCache.set(key, t)
    }
    return t
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
  // 点标记序号徽标精灵（圈 1、圈 2）：贴图按编号缓存 —— setMarkers 每推进一拍就重建一次（仰角要刷新），
  // 同一串编号不必反复现画画布 + 上传纹理。贴图打 _shared，disposeGroup 见到就跳过（同 dotCache）。
  const badgeCache = new Map()
  const BADGE_TEX = 128          // 贴图边长：徽标上屏一般十几到几十 px，128 足够清晰且不占显存
  function badgeTexture(text) {
    let t = badgeCache.get(text)
    if (!t) {
      const c = document.createElement('canvas'); c.width = c.height = BADGE_TEX
      paintNumBadge(c.getContext('2d'), BADGE_TEX / 2, BADGE_TEX / 2, BADGE_TEX * BADGE_TEX_FILL, text, UI_FONT)
      t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t._shared = true
      badgeCache.set(text, t)
    }
    return t
  }
  // ★ depthTest 关 + 半球剔除（_dir）：与文字标签 / 地球站图标同策略。开着 depthTest 时整枚徽标按锚点
  //   （地表）深度参与测试，而精灵是【屏幕朝向】的平面 —— 靠视野中心那一侧的地球曲面比锚点更近，会把
  //   徽标啃掉一块（症状：每枚徽标朝球心那侧缺一角，越大越明显）。改为始终完整浮在地表之上，转到背面
  //   由 rescaleMarkers 按 _dir 隐藏/淡出。圆点没这毛病是因为它只有几个像素，啃掉那一圈看不出来。
  // ★ 材质逐枚新建（贴图仍按编号共享）：_dir 的近地平淡出要改 material.opacity，共享材质会被互相改写。
  function makeNumBadge(text) {
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTexture(text), depthTest: false, depthWrite: false, transparent: true }))
  }

  let markersGroup = null, trajGroup = null, focusSatGroup = null
  function disposeGroup(grp) { if (grp) { grp.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && !o.material._shared) { lineMats.delete(o.material); if (o.material.map && !o.material.map._shared && o.material.map !== stationTex && o.material.map !== focusSatTex) o.material.map.dispose(); o.material.dispose() } }); scene.remove(grp) } }
  // 聚焦卫星当前星下点图标（与 2D 同款，固定 30px 基准——与 2D sizes.satIcon 默认值一致，随 3D 缩放联动）；
  // depthTest 关 + _dir 半球剔除，复用地球站图标同一套策略，转到背面自动隐藏，不会被地球遮挡。
  // 屏幕像素固定尺寸的「贴图点层」：同贴图、同（大小|染色）的点合成一个 THREE.Points —— 一次 draw call。
  // sizeAttenuation:false ⇒ material.size 就是屏幕像素（three 内部已乘 pixelRatio）；点在地表/轨道高度之上，
  // 被地球挡住由深度测试自然剔除，不再需要逐帧 occludedByGlobe / _dir 半球剔除。
  // pts._px 记基准像素，供随缩放联动的层逐帧改 size（见 rescalePointLayers）。
  // 背面剔除：深度测试对「点」是按点心那一个深度整片比的 —— 贴近地表的星下点图标在地平附近会被
  // 地球啃掉半块（点心在地表之上、可屏幕方块压在更近的球面上）。故 depthTest 关掉，改在顶点着色器里
  // 做与 occludedByGlobe 逐字相同的判定：相机→该点的线段若先穿过单位球，就把点尺寸打到 0（＝不画）。
  // ★ 这是原来 Sprite 版「depthTest:false + 每帧 _dir 半球剔除 / occludedByGlobe」的等价物，
  //   放进 GPU 后与颗数无关，而且比半球判据更准（卫星在轨高度时地平之外仍可见的那圈也对）。
  const CULL_GLSL = `
    vec3 camToP = -cameraPosition + transformed;
    float qa = dot(camToP, camToP);
    float qb = 2.0 * dot(cameraPosition, camToP);
    float qc = dot(cameraPosition, cameraPosition) - 1.0;
    float disc = qb * qb - 4.0 * qa * qc;
    if (disc > 0.0) {
      float t0 = (-qb - sqrt(disc)) / (2.0 * qa);
      if (t0 > 0.0 && t0 < 1.0) gl_PointSize = 0.0;
    }
  `
  function cullBehindGlobe(mat) {
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', '#include <fog_vertex>' + CULL_GLSL)
    }
    mat.customProgramCacheKey = () => 'cullBehindGlobe'
    return mat
  }
  function buildPointLayers(list, tex, pxDefault, tintDefault, order, liftMul) {
    const buckets = new Map()
    for (const q of list) {
      const px = Number(q.px) > 0 ? Number(q.px) : pxDefault
      const tint = Number.isFinite(q.colorHex) ? q.colorHex : tintDefault
      const key = px + '|' + tint
      let b = buckets.get(key)
      if (!b) { b = { px, tint, pos: [] }; buckets.set(key, b) }
      const v = llaToVec(q.lat, q.lon, q.altKm || 0)
      if (liftMul) v.multiplyScalar(liftMul)
      b.pos.push(v.x, v.y, v.z)
    }
    if (!buckets.size) return null
    const g = new THREE.Group()
    for (const b of buckets.values()) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3))
      const mat = cullBehindGlobe(new THREE.PointsMaterial({
        map: tex, color: b.tint, size: b.px, sizeAttenuation: false,
        transparent: true, depthTest: false, depthWrite: false, alphaTest: 0.02
      }))
      const pts = new THREE.Points(geo, mat)
      pts.renderOrder = order; pts._px = b.px
      g.add(pts)
    }
    return g
  }
  const FOCUS_SAT_PX = 30   // 出厂基准（focusCfg.subPx 的默认值，仅作旧签名兜底）
  // p：单个 {lat,lon} 或数组（多选时每颗聚焦星各画一个图标，同款同大小，聚焦星区分靠轨道加粗+高亮环，图标本身不再分主次）
  // sizePx/colorHex 为全局默认（旧调用签名）；单点可用 q.px / q.colorHex 覆盖 —— 供聚焦星下点(白·30)
  // 与可见性可见星星下点(面板色·滑块大小)在同一 replace-all 通道里混绘（各自样式，互不覆盖）。
  function setFocusSatLLA(p, sizePx, colorHex) {
    disposeGroup(focusSatGroup); focusSatGroup = null
    const list = (Array.isArray(p) ? p : (p ? [p] : [])).filter((q) => q && Number.isFinite(q.lat) && Number.isFinite(q.lon))
    if (!list.length) return
    const pxG = Number(sizePx) > 0 ? Number(sizePx) : (Number(focusCfg.subPx) > 0 ? Number(focusCfg.subPx) : FOCUS_SAT_PX)   // 可选大小（可见性分析按其滑块传入；缺省取聚焦星设置）
    const tintG = Number.isFinite(colorHex) ? colorHex : (Number.isFinite(focusCfg.subColor) ? focusCfg.subColor : 0xffffff)      // 可选染色（默认取聚焦星设置；可见性传图标色 → 与 2D 一致）
    focusSatGroup = buildPointLayers(list, focusSatTexture(), pxG, tintG, 17, 1.0012)
    if (focusSatGroup) scene.add(focusSatGroup)
  }
  // 标签精灵里字高占整张的比例：makeCovLabel 字号 50、画布高 50+8×2=66，其余是留白。
  // 标注让位要按【字高】算，不是按精灵整高。2D 侧 flatCoverage 的同名常量必须同值。
  const MK_FONT_K = 50 / 66
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
  // points:[{lat,lon,label?,idx?}]  stations:[{lat,lon,name?}]  sizes:{ptFont,stIcon,stFont,ptIdx}
  function setMarkers(points, stations, sizes) {
    const sz = sizes || {}, ptFont = sz.ptFont || 14, stIcon = sz.stIcon || 32, stFont = sz.stFont || 17
    // 点标记圆点直径：用 2D 半径口径 sz.ptDot（默认 3.5）×2.2 换算到 3D 屏幕像素，保持与 2D 观感一致、可调
    const ptDotPx = (sz.ptDot != null ? sz.ptDot : 3.5) * 2.2
    // 序号徽标直径（屏幕 px @100% 缩放，与 2D 同值）：精灵整张含留白，故 _px 要按占比放大回去
    const idxD = sz.ptIdx != null ? sz.ptIdx : 16
    disposeGroup(markersGroup); markersGroup = null
    const g = new THREE.Group()
    for (const p of (points || [])) {
      const pos = llaToVec(p.lat, p.lon, 0).multiplyScalar(1.0012)
      // p.idx 非空＝带序号：圆本身就是记号（圈心＝该点位置），不再另画圆点
      const mark = p.idx ? makeNumBadge(p.idx) : makeDot('#ffd24a')
      mark.position.copy(pos); mark._px = p.idx ? idxD / BADGE_TEX_FILL : ptDotPx; mark._ar = 1; mark.renderOrder = 15
      if (p.idx) mark._dir = pos.clone().normalize()   // 徽标关了 depthTest，背面靠半球剔除隐藏（见 makeNumBadge）
      g.add(mark)
      // 文字锚点让位：center.y 以精灵自身高度（＝其 _px）为单位，故把 badgeLabelUp 算出的字心距离
      // 折回该单位。0.5−0.85=−0.35 就是原来圆点那档，两视图共用同一支 badgeLabelUp、口径不会走偏。
      const dU = badgeLabelUp(0.85 * ptFont, p.idx ? idxD : 0, ptFont * MK_FONT_K)
      const hD = ptFont * 0.9, dD = badgeLabelUp(0.85 * hD, p.idx ? idxD : 0, hD * MK_FONT_K)
      if (p.label) g.add(labelSprite(p.label, p.lat, p.lon, '#ffffff', 0.5 - dU / ptFont, ptFont))   // 坐标：白字
      if (p.el) g.add(labelSprite(p.el, p.lat, p.lon, '#ffffff', 0.5 + dD / hD, hD))     // 聚焦卫星仰角：亮白，标记下方
    }
    for (const s of (stations || [])) {
      // 关闭深度测试 + 半球剔除（_dir）：与文字标签同策略。地球站图标是「从地表立起」的精灵，开 depthTest 时
      // 整张图按锚点(地表)深度参与测试，低视角/近地平边缘处上半部分会被更近的地球曲面截断遮挡。改为始终完整浮于
      // 地表之上，转到背面时由 rescaleMarkers 按 _dir 自动隐藏/淡出（不会透出地球背面的站点）。
      const st = new THREE.Sprite(new THREE.SpriteMaterial({ map: stationTexture(), depthTest: false, depthWrite: false, transparent: true }))
      // 锚点＝符号里那颗白色址点：center.y 自底算，故取 1−STATION_ANCHOR_Y（2D 侧对应 y − si·ANCHOR_Y）
      st.position.copy(llaToVec(s.lat, s.lon, 0).multiplyScalar(1.0012)); st.center.set(STATION_ANCHOR_X, 1 - STATION_ANCHOR_Y); st._px = stIcon; st._ar = 1; st._dir = st.position.clone().normalize(); st.renderOrder = 15; g.add(st)
      // 字要让开「符号落在锚点下方的那一截」（址点圆的下半），换算成各自字号的倍数加到 centerY 上
      const stUnder = stIcon * (1 - STATION_ANCHOR_Y)
      if (s.name) g.add(labelSprite(s.name, s.lat, s.lon, '#ffffff', 0.82 + stUnder / stFont, stFont))   // 名称紧贴地球站底座下方：亮白
      if (s.el) g.add(labelSprite(s.el, s.lat, s.lon, '#ffffff', 1.87 + stUnder / (stFont * 0.9), stFont * 0.9))   // 聚焦卫星仰角：亮白，名称下方
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
  // sizes.trajDot / sizes.trajIconPx 同一把尺：都是【屏幕 px @100% 缩放】、同一档位区间，圆点按
  // 【该数的一半】作可见直径（等大时实心圆比图标那种镂空剪影重得多）。而精灵整张含留白
  // （makeDot：直径 18 的圆居中于 32 画布），故 _px 要按占比放大回去 —— 2D 侧直接按半径作画、
  // 无留白，两视图这才一样大（同 numBadge 的 BADGE_TEX_FILL 那套换算）。
  const DOT_SPRITE_FILL = 18 / 32
  function setTrajectories(list, sizes) {
    const sz = sizes || {}
    const trajDotPx = (sz.trajDot != null ? sz.trajDot : 4) / 2 / DOT_SPRITE_FILL
    const vehOn = sz.trajIcon !== false, vehPx = sz.trajIconPx != null ? sz.trajIconPx : 26
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
      // ★ 航迹线 10.5：在地名（国家/省/市 10、大洋 9）【之上】，与本层的圆点(15)/载具图标(16)同侧 ——
      //   三样必须同侧，否则地名把线切断、圆点却浮在字上。曾经是 6（与 GRD 等值线/Polygon 线同层、
      //   压在国界之下），那一档让底图地名整段吃掉航迹，而线的连续性本身就是信息。2D 侧同口径
      //   （flatCoverage.drawTrajLayer 画在地名层之后）。仍低于覆盖标注(12/13)与卫星图标(14)。
      if (verts.length > 1) g.add(fatStrip(verts, tr.color != null ? tr.color : 0xff5a5a, 2.2, 0.95, 10.5))
      for (const p of pts) { const dot = makeDot(tr.kind === 'flight' ? '#5ad1ff' : '#ff9a5a'); dot.position.copy(llaToVec(p.lat, p.lon, 0).multiplyScalar(1.002)); dot._px = trajDotPx; dot._ar = 1; dot.renderOrder = 15; g.add(dot) }
      // 航迹头（末航点）上的载具图标。depthTest 关 + _dir 半球剔除：同地球站图标那套，转到背面自动隐藏。
      if (vehOn && vehPx > 0 && pts.length) {
        const hd = pts[pts.length - 1]
        const pos = llaToVec(hd.lat, hd.lon, 0).multiplyScalar(1.0025)
        const ink = '#' + (hexOf(tr.color != null ? tr.color : 0xff5a5a) & 0xffffff).toString(16).padStart(6, '0')
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: vehicleTexture(tr.kind === 'flight' ? 'flight' : 'sea', ink), depthTest: false, depthWrite: false, transparent: true }))
        spr.position.copy(pos); spr._px = vehPx; spr._ar = 1; spr._dir = pos.clone().normalize(); spr.renderOrder = 16
        // 朝向＝末段的大圆切向（3D 的航迹线是大圆，图标得贴着那条线；2D 那条线是经纬直连，故另算）。
        // 切向投到屏幕上的角度随镜头一转就变，这里只存世界向量，逐帧再求角（见 rescaleMarkers）。
        if (pts.length > 1) {
          const pv = llaToVec(pts[pts.length - 2].lat, pts[pts.length - 2].lon, 0).normalize()
          const hn = spr._dir
          const tan = pv.clone().addScaledVector(hn, -hn.dot(pv)).multiplyScalar(-1)   // 前一点 → 头 的切向
          if (tan.lengthSq() > 1e-12) spr._tan = tan.normalize()
        }
        g.add(spr)
      }
    }
    trajGroup = g; scene.add(g)
  }
  // 标记/轨迹精灵每帧随缩放「均匀」联动：屏幕像素 = 设定像素 × zoomK，zoomK = 基准距离/相机到目标距离。
  // 默认视角(相机距=LABEL_REF_DIST) zoomK=1 → 即其设定的原始像素大小；拉近 zoomK>1 变大、拉远变小，与地名同步。
  // 用「相机→目标」统一系数（而非各标记自身距离）→ 全部标记同屏幕大小，不再近大远小。带 _dir 的文字做半球剔除。
  const _pA = new THREE.Vector3(), _pB = new THREE.Vector3()   // rescaleMarkers 里投影用的临时件（project 会改原向量）
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
        if (o._tan) {   // 载具图标：把「位置」与「位置+切向」投到屏幕求夹角 —— NDC 的 x/y 缩放不同，得先折回像素比例
          _pA.copy(o.position).project(camera)
          _pB.copy(o.position).addScaledVector(o._tan, 0.01).project(camera)
          const sx = (_pB.x - _pA.x) * curW, sy = (_pB.y - _pA.y) * curH
          if (sx * sx + sy * sy > 1e-9) o.material.rotation = Math.atan2(-sx, sy)   // 精灵自身「上」＝船首/机头
        }
        if (o._px) { const dd = camera.position.distanceTo(o.position); const h = o._px * zoomK * (2 * dd * tanH) / curH; o.scale.set(h * (o._ar || 1), h, 1) }
      }
    }
    go(markersGroup); go(trajGroup)   // 选中星在轨点已改合批点层，随缩放联动走 rescalePointLayers
  }
  // 贴图点层随缩放联动：与原精灵同口径（基准 px × LABEL_REF_DIST/相机距离），上限 256px 防越过
  // gl_PointSize 的硬件天花板。高亮环刻意不联动（固定屏幕大小，拉远也认得出选中的是哪颗）。
  function rescalePointLayers() {
    if (!focusSatGroup && !selDotGroup && !laneDotGroup && !laneSubGroup) return
    const k = Math.max(0.35, Math.min(6, LABEL_REF_DIST / camera.position.distanceTo(controls.target)))
    const go = (grp) => { if (grp) for (const o of grp.children) { if (o._px) o.material.size = Math.min(256, o._px * k); else if (o.children) for (const c of o.children) if (c._px) c.material.size = Math.min(256, c._px * k) } }
    // 在轨点是「底盘 + 白圈」两层套一个 Group，故 go 要下探一层。
    // ★ 高亮环（laneHlGroup / ringGroup）刻意【不】参与缩放联动 —— 它是固定屏幕尺寸的选中标记，
    //   跟着拉远缩小就成了看不见的小点（老通道的 ringGroup 本来也不在这条链上）。
    go(focusSatGroup); go(selDotGroup); go(laneDotGroup); go(laneSubGroup)
  }

  let satPoints = null
  // 星座点云显隐（「聚焦卫星 · 卫星标记 · 星座点云」）：setSatellites 每拍重建点云，故开关记在这里、
  // 建出来就套上；关掉的同时不再参与拾取 —— 看不见的东西点得中，等于点空白也会选中星。
  let satPointsOn = true
  function setSatPointsVisible(v) {
    satPointsOn = v !== false
    if (satPoints) satPoints.visible = satPointsOn
  }
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
    satPoints.visible = satPointsOn
    scene.add(satPoints)
  }
  // p：{lat,lon,altKm,primary?} 或其数组 / null（清空）。每颗聚焦星一个环，primary=false 的收小一档。
  // ★ 这条通道现在只剩「对星覆盖分析聚焦特效」的环在用（聚焦选中集那批已并进 setFocusLanes 的 hl/hlP）。
  //   故【不受】focusCfg.ringOn 门控：那个开关管的是聚焦星自己的高亮环，关掉它不该把对星分析点亮的
  //   源星/目标星一并抹掉（那是另一个功能的呈现）。颜色与大小仍跟着设置走 —— 同一件东西该长一个样。
  function setHighlightLLA(p) {
    disposeGroup(ringGroup); ringGroup = null
    const list = (Array.isArray(p) ? p : (p ? [p] : [])).filter((q) => q && Number.isFinite(q.lat) && Number.isFinite(q.lon))
    if (!list.length) return
    const px = Math.max(2, Number(focusCfg.ringPx) || 26)
    const pts = list.map((q) => ({ lat: q.lat, lon: q.lon, altKm: q.altKm, px: q.primary === false ? px * 0.82 : px }))
    ringGroup = buildPointLayers(pts, ringTex, px, 0xffffff, 20, 1)
    if (ringGroup) scene.add(ringGroup)
  }
  // 旧签名（Vector3 列表 / null）：现仅 clearSelectionGeom 用来清空
  function setHighlight(vec) { if (!vec || (Array.isArray(vec) && !vec.length)) { disposeGroup(ringGroup); ringGroup = null } }

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
    if (!satPoints || !satPoints.visible || !onPick) return   // 点云关着就不拾取（见 setSatPointsVisible）
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
  // ============ 地名避让（与 2D flatmap/flatCoverage 同一套口径与常量）============
  // 精灵是「世界尺寸」的：地球放大多少，字就跟着放大多少，位置也同比拉开 —— 整幅版面是相似放大，
  // 重叠率与缩放【无关】。英国那 232 个地方议会区的名字，转到眼前放到最大，还是糊成一坨。
  // 两条一起才管用：① 把字的屏幕高钳进 [LB_MIN, LB_MAX] —— 有了上限，放大才真的腾出地方；
  //                ② 屏幕空间贪心避让 —— 按「层级 + _pri」排队摆位，撞上已摆的就隐藏。
  // ★ 下限是「太小就不画」，不是「撑大到这个数」：字号倍率能调到 0.1，撑大就等于把那个档位废掉。
  // 门槛压到 2.5px：倍率是用户自己设的，设成 0.2 就是要那一片小字，这一层只拦真正的单像素噪点。
  //（曾取 5px，配上出厂的省名 0.6 / 市名 0.2 倍率，等于把中国地级市这一层在低倍下整层关掉。）
  const LB_DROP = 2.5, LB_MAX = 22    // 低于 LB_DROP 像素不画，高于 LB_MAX 像素封顶
  const LB_DROP_KEEP = 1.2            // 常显标注的下限只剩物理的那一条：再小连一个像素都画不出
  const LB_TXT = 54 / 70              // 精灵画布里字本身占的高度比（makeLabelSprite：字号 54 / 画布高 70）
  // 碰撞盒按【字】不按【整张精灵画布】：画布四周有描边留白，拿它当盒子等于每个名字凭空胖三成，
  // 挤掉的全是港澳这种「小而重要」的邻居。半高 0.5 em（CJK 字面框正好一个 em）+ 半像素间隙。
  const LB_HK = 0.5, LB_PADX = 1, LB_PADY = 0.5
  // ★ 标注一律钉在单元质心上，不做「撞了挪一格」的候选位偏移：位置准确是第一位的，
  //   名字挪出辖区比少显示一个更糟。位置不动，改成【允许适度重叠】：判定盒按下面两个系数收缩，
  //   相邻名字可以互相侵入这么多而仍然都画。横向放 35%、纵向只放 12%（上下压住笔画就废了）。
  //   与 2D flatCoverage 同一组标定值，改动请两边一起改。
  const LB_OVX = 0.65, LB_OVY = 0.88
  const LB_SLOT = 64                  // 占位表网格边长（px）
  const lbSlots = new Map()
  const lbV = new THREE.Vector3()
  const lbBuf = []
  const lbRange = (x0, y0, x1, y1, fn) => {
    for (let i = Math.floor(x0 / LB_SLOT); i <= Math.floor(x1 / LB_SLOT); i++) {
      for (let j = Math.floor(y0 / LB_SLOT); j <= Math.floor(y1 / LB_SLOT); j++) if (fn(i + ',' + j)) return true
    }
    return false
  }
  // 一层：先按半球淡出定去留，再投影 + 钳字号，收进待摆队列（层级序由调用顺序保证）
  function lbCollect(grp, nameScale, tier, W, H, foc) {
    if (!grp || !grp.visible) return
    for (const s of grp.children) {
      if (s._dir) fadeLabel(s, s._dir.dot(camDir))
      if (!s.visible || !s._base) continue
      const dist = camera.position.distanceTo(s.position)
      // ★ 封顶只作用于【相机拉近带来的增长】，不作用于【用户拉的字号倍率】：倍率是用户的直接意图，
      //   拉了就得跟着走；封顶要管的是「拉近时字与间距同比涨、避让永远腾不出地方」那件事。
      //   故先按倍率 1.0 算屏幕高、对它封顶，再把倍率乘回去。
      const pxH0 = s._base.y * foc / Math.max(1e-6, dist)         // 倍率 1.0 时整张精灵的屏幕高
      const txt0 = pxH0 * (s._txtK || LB_TXT)
      const kk = (txt0 > LB_MAX ? LB_MAX / txt0 : 1) * nameScale
      const pxH = pxH0 * kk                                       // 实际屏幕高（已含封顶与倍率）
      const txt = pxH * (s._txtK || LB_TXT)                       // 其中字本身的高
      if (txt < (s._keep ? LB_DROP_KEEP : LB_DROP)) { s.visible = false; continue }   // 太小：不画，也不占位
      s.scale.set(s._base.x * kk, s._base.y * kk, 1)
      lbV.copy(s.position).project(camera)
      if (lbV.z > 1) { s.visible = false; continue }
      const x = (lbV.x * 0.5 + 0.5) * W, y = (0.5 - lbV.y * 0.5) * H
      const sprH = pxH, sprW = (s.scale.x / s.scale.y) * sprH             // 整张精灵的屏幕尺寸
      const hw = sprW * (s._wK != null ? s._wK : 1) * 0.5 * LB_OVX + LB_PADX   // 碰撞盒只算字，不算描边留白
      const hh = sprH * (s._txtK || LB_TXT) * LB_HK * LB_OVY + LB_PADY
      if (x + hw < 0 || x - hw > W || y + hh < 0 || y - hh > H) { s.visible = false; continue }
      lbBuf.push({ s, tier, keep: !!s._keep, rk: s._rk != null ? s._rk : 12, pri: s._pri || 0, x, y, hw, hh })
    }
  }
  function updateLabels() {
    camDir.copy(camera.position).normalize()
    const r = renderer.domElement
    const W = r.clientWidth || 1, H = r.clientHeight || 1
    const foc = H / (2 * Math.tan(camera.fov * Math.PI / 360))   // 焦距（像素）：世界高 × foc / 距离 = 屏幕高
    lbBuf.length = 0; lbSlots.clear()
    // 层级序（与 2D flatCoverage 的摆位次序同口径）：岛链 → 大洋 → 国家 → 海域 → 一级 → 二级
    lbCollect(chainLabels, chainCfg.nameSize || 1, 0, W, H, foc)
    lbCollect(oceanZh, nameScaleO, 1, W, H, foc); lbCollect(oceanEn, nameScaleO, 1, W, H, foc)
    lbCollect(labelsZh, nameScaleC, 2, W, H, foc); lbCollect(labelsEn, nameScaleC, 2, W, H, foc)
    lbCollect(seaZh, nameScaleS, 3, W, H, foc); lbCollect(seaEn, nameScaleS, 3, W, H, foc)
    lbCollect(provinceLabels, nameScaleP, 4, W, H, foc)
    lbCollect(cityLabels, nameScaleCity, 5, W, H, foc)
    lbBuf.sort((a, b) => ((b.keep ? 1 : 0) - (a.keep ? 1 : 0)) || (a.tier - b.tier) || (a.rk - b.rk) || (b.pri - a.pri))
    const lbFree = (x0, y0, x1, y1) => !lbRange(x0, y0, x1, y1, (k) => {
      const arr = lbSlots.get(k)
      if (!arr) return false
      for (const q of arr) if (x0 < q[2] && x1 > q[0] && y0 < q[3] && y1 > q[1]) return true
      return false
    })
    for (const e of lbBuf) {
      const x0 = e.x - e.hw, y0 = e.y - e.hh, x1 = e.x + e.hw, y1 = e.y + e.hh
      // 常显（KEEP_ISO 的国家）：不判碰撞，挤到也画；但照常登记占位，免得别人再压上来
      if (!e.keep && !lbFree(x0, y0, x1, y1)) { e.s.visible = false; continue }
      lbRange(x0, y0, x1, y1, (k) => { let a = lbSlots.get(k); if (!a) lbSlots.set(k, a = []); a.push([x0, y0, x1, y1]); return false })
    }
    // 卫星/仰角线/Polygon 独立图层里带 _dir 的标签（如 Polygon 名称数值）：只做半球淡出，不参与地名避让
    // —— 那些是用户数据，该显示就得显示，不能被底图地名挤掉。
    if (satLayerGroup && satLayerGroup.visible) for (const s of satLayerGroup.children) if (s._dir) fadeLabel(s, s._dir.dot(camDir))
  }

  const zoomDir = new THREE.Vector3()
  let raf = 0, lastFrameT = 0, running = true, frameHold = 0
  // 出帧闸：一拍里星位是同步算的、聚焦几何要等 Worker 回来，中间若出一帧就成了「星在 t、轨道在 t−Δ」——
  // 那正是 simClock「一次时钟回调 = 一个时刻的完整画面」明令禁止的。故整拍期间不出帧，画面停在上一拍的完整状态。
  // ★ 计数不是布尔：simClock 的 emit() 已是 async，而 setTime/stepBy/pause 那几个入口是「发了不等」，
  //   于是「拖游标」与「定时器那一拍」会并发跑两趟 refreshPositions，各自持一次闸。用布尔的话先算完
  //   的那趟一放行，另一趟还在算，出的正是这道闸要防的半拍画面。计数则要等最后一趟收工才放行。
  //   下限钳到 0：万一有不成对的 release，也只是提早放行，不会把闸永久压死。
  function holdFrames(on) { frameHold = on ? frameHold + 1 : Math.max(0, frameHold - 1) }
  function loop(now) {
    if (!running) return   // 已暂停（切到 2D 平面图）：停掉 rAF 链，不再空转渲染被盖住的球面
    raf = requestAnimationFrame(loop)
    if (frameHold) return
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
    syncNear(cur)   // 每帧无条件跟一次（内部等值即返回）：恢复视图/直接 setZoom 落在贴地档时也不会漏
    // 卫星点随缩放联动：基准距离上 SAT_POINT_PX，拉近变大、拉远变小；下限 0.5×/上限 4× 钳制保证可见且不过大
    if (satPoints) satPoints.material.size = SAT_POINT_PX * Math.max(0.5, Math.min(4, LABEL_REF_DIST / cur))
    // 高亮环：贴图点层本身就是固定屏幕像素 + 深度测试遮挡，逐帧无事可做（原来是每颗一次反缩放 + 遮挡射线）
    rescalePointLayers()
    rescaleMarkers()
    updateLabels()
    refreshDashScale()   // 虚线周期按屏幕像素恒定：缩放跨过一档就重切
    applyFade()          // 一/二级行政区随缩放淡入淡出
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
  // 出图：把渲染分辨率临时抬到 factor 倍取一帧，返回 PNG 字节。机位/图层/主题一概不动 → 所见即所得。
  //
  // 只动 setPixelRatio，**不动 lineMats 的 resolution**：LineMaterial 的线半宽 = linewidth/resolution.y
  // 个 NDC，而 resolution 记的是 CSS 尺寸，于是画布放大多少线就跟着粗多少，缩回原尺寸看与屏幕一模一样。
  // 把 resolution 一并乘上倍率等于把线钉死在「设备像素 linewidth」——出的图里岸线/轨道细如发丝，
  // 链路视图 3D 踩过这个坑（见 viz/lbglobe/linkGlobe.js 的 snapshot）。卫星点（PointsMaterial）由
  // three 自己乘 pixelRatio、标记/标签按 curH 折算世界尺寸，都跟着等比放大，无需另行处理。
  //
  // 地名/波束标签的纹理是 fs=54 的高分辨率画布（见 makeLabelSprite），屏上约 4 倍过采样：
  // 4× 出图正好 1:1 最锐 —— 这也是出图倍率封顶 4× 的原因之一（菜单里 6× 那档已删，见 exportGlobeShot）。
  async function snapshot(factor) {
    const cv = renderer.domElement
    const gl = renderer.getContext()
    // 先按驱动的帧缓冲上限收一道：超过 MAX_RENDERBUFFER_SIZE / MAX_TEXTURE_SIZE 必然分配失败
    const maxDim = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 8192, gl.getParameter(gl.MAX_TEXTURE_SIZE) || 8192)
    let s = Math.max(1, Math.min(factor || 4, maxDim / Math.max(curW, curH)))
    const prev = renderer.getPixelRatio()
    let cap = null, w = 0, h = 0
    try {
      // 显存不够分这么大一块（MSAA 下还要乘采样数）时浏览器不报错，而是把 drawingBuffer 悄悄收小、
      // canvas.width 照旧 —— 取回来的就是一张被拉伸的糊图。比对两者，不一致就重来一档：
      // 宁可倍率打折（实际倍率随返回值出去，文件名如实写），也不出一张看不出哪里不对的错图。
      //
      // 下一档不是盲目减半，而是照「浏览器把缓冲收到了多大」直接折算（留 2% 余量）——它其实已经
      // 把上限告诉我们了。盲目退让要试七八轮，每轮都真去申请一块大缓冲，反把显存压得更紧：
      // 实测 900×560 的画布请求 40× 时，退让法一路试到 3.8× 还在被收（前面几轮的巨块还没还干净）。
      // 折算法一两轮到位。谈不拢就退到 1×（屏幕原尺寸必然分得出来）。
      for (let i = 0; ; i++) {
        renderer.setPixelRatio(s)
        if (s <= 1 || (gl.drawingBufferWidth === cv.width && gl.drawingBufferHeight === cv.height)) break
        const fit = Math.min(gl.drawingBufferWidth / curW, gl.drawingBufferHeight / curH) * 0.98
        const next = Math.min(s * 0.8, fit)
        s = (i >= 4 || !(next > 1)) ? 1 : next
      }
      // 精灵/标签的世界尺寸由 rescaleMarkers 按当前机位算：出图前补一次，免得恰好一帧都没画过
      // （窗口在后台被 rAF 节流）时精灵还停在上一次的尺寸上。
      rescaleMarkers(); updateLabels()
      renderer.render(scene, camera)
      w = cv.width; h = cv.height
      // toBlob 在调用当场就把画布位图拷走（编码才是异步的），故 finally 里改回倍率不影响这一张。
      cap = new Promise((res, rej) => cv.toBlob((b) => b ? res(b) : rej(new Error('画布取图失败')), 'image/png'))
    } finally {
      renderer.setPixelRatio(prev)
      renderer.render(scene, camera)   // 改倍率会清空缓冲：立刻补画一帧，避免屏幕闪一下黑
    }
    const blob = await cap
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h, factor: s }
  }

  function destroy() {
    offPov()            // 退订主权解算层的广播：不退的话卸载后的场景仍会被换视角触发重建
    clearEnv()          // 贴图/几何不随 renderer.dispose 走，显式释放（切页面重挂载时会反复走这里）
    clearTerminator()   // 同上：夜区球壳几何 + 线材质（materials 还挂在 lineMats 里）也要显式还
    clearShellField(); clearShellGuides()   // 对星覆盖壳层：标签用的 canvas 贴图同样不随 dispose 走
    disposeOrbRings(); disposeLanes()   // 轨道圈与预制顶点各自成组：几何/线材质不随 renderer.dispose 走
    cancelAnimationFrame(raf); controls.dispose(); renderer.dispose()
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
  }

  return {
    setSatellites, setLabelMode, setHighlight, setHighlightLLA, setOnPick,
    setOrbit, setGroundTrack, setFootprint, setSelectionSet, setFocusLanes, setOrbitRingSet, setOrbitRingSpin, clearSelectionGeom,
    setCoverage, clearCoverage, setCoverageField, updateCoverageField, patchCoverageLayers, clearCoverageField, setCoverageFieldAlpha, setCoverageLineAlpha, setCovGrid, clearCovGrid, setCovGridAlpha,
    setShellField, updateShellField, clearShellField, setShellFieldAlpha, setShellGuides, clearShellGuides, setShellRays, clearShellRays,
    setTerminator, clearTerminator,
    setEnvRaster, setEnvAlpha, setEnvContours, clearEnv,
    setSatLayer, clearSatLayer, faceLonLat, setProvinces, setProvincesVisible, setCities, setCitiesVisible, setBorderStyle, setNameScale, setLabelStyle, setWaterMode, setWaterOff, setChains, setOceanColor, setLandColors, setImagery,
    setPixelRatio, setRenderFps, setSphereDetail, setMapDetail, holdFrames,
    setMarkers, setTrajectories, setFocusSatLLA, setFocusStyle, setSatPointsVisible, setOnHover, setOnRightClick, setBeamDragMode, setOnBeamDrag, setBeamDragPivot, setLabelDragMode, setOnLabelDrag, setPolyDrawMode, setOnPolyDraw, setPlaceMode, setOnPlace,
    faceTo, rotateBy, setAutoRotate, setAutoRotateSpeed, setOnAutoRotateOff, resize, pause, resume, snapshot, destroy,
    // 缩放进度条接口：getZoom 读当前进度、setZoom 设到进度 t、setOnZoom 注册滚轮缩放回填回调
    getZoom: () => distToT(zoomTarget),
    setZoom: (t) => { zoomTarget = Math.max(controls.minDistance, Math.min(controls.maxDistance, tToDist(t))); syncNear(zoomTarget) },
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
