// 链路预算「链路视图」的 3D 地球（GSO / NGSO / 再生式三窗共用）。
//
// 与星座 3D（viz/globe3d/scene.js）的分工：那一头地图是主角，要 10m 岸线、省界、地名、
// 覆盖填充；这里地球只是**舞台**，主角是站与星之间的那几条线。所以不复用那套重家伙，
// 另起一份轻的：
//   · 地球=一张等经纬贴图，用与地理场图同一份 50m 底图数据、同一套配色（shared/lbBasemap）
//     现画出来 —— 上下两张图并排放着，海陆颜色与岸线粗细必须是一家人；
//   · 除站/星/链路线外不放任何别的东西：一张图只讲一件事。
//
// 尺度**严格按真实比例**：地球半径 1，卫星按其真实高度摆（GEO 就在 6.6 个地球半径外）。
// 压缩径向比例能让 GEO 那张图“好看些”，但那是骗人——链路视图的全部价值就在于让人一眼
// 看出这条链路的几何有多长、擦地擦得多低。
//
// three 由调用方动态 import 本模块时一并拉起（见 LbLinkPane），不进三窗首屏包。
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { loadBasemap, basemapPaths, OCEAN, LAND, COAST, BORDER } from '../../shared/lbBasemap.js'
import { uiFontStack, DOC_FONT_STACK } from '../../shared/lbFont.js'

const RE_KM = 6378.137
const D2R = Math.PI / 180
// 标注字体（canvas 取不到 CSS 变量，栈定义在 shared/lbFont.js）：
// 屏上跟界面走无衬线；出图那一瞬换成报告的衬线栈，出完再换回来（见 snapshot）。
// 精灵的贴图是 setScene 一次性烤好的，改字体必须整场重建 —— 故用 let 而不是 const。
let LABEL_FONT = null            // null = 跟界面字体走（用时现读）；出图期间钉成报告的衬线栈

// 渲染倍率 = 物理像素密度 × 2（超采样），封顶 3。
// 这是本图与星座 3D 那颗地球「清晰度差一大截」的头号原因：那边 viz/globe3d/scene.js 的
// capPixelRatio 是 min(请求值, dpr×2, 4)、画质档默认请求 2.0~3.0，等于在物理像素之上再超采样
// 一倍；这边原来只写 min(2, dpr) —— Windows 100%/150% 缩放下就是 1.0/1.5，线宽不到一个物理
// 像素的岸线、精灵描边全靠一次采样凑，自然发虚。这张图是静止的（dirty 用完就停渲染），
// 超采样只在交互那几帧多花点填充率，代价可以忽略。
const SS_CAP = 2, SS_MAX = 3
function renderScale() {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
  return Math.max(1, Math.min(dpr * SS_CAP, SS_MAX))
}
// 精灵（标注/站点/卫星标记）的画布倍率固定 4：与出图倍率（snapshot 默认 4）对齐，
// 屏上按 CSS 像素定尺寸后即 4:1 降采样 —— 与星座 3D 标注「fs=54 高分辨率纹理再缩」同一招。
// 跟着 dpr 走的话，dpr=1 的机器上出图要把 1× 的字硬拉到 4×，报告里的站名就是糊的；
// 比出图倍率低同理（原来是 3，出 4 倍图时站名要被拉伸 4/3，笔画边上就带一圈毛边）。
const SPRITE_SS = 4

// 链路方向配色：取 shared/lbPlotTheme 的分类三槽（普鲁士蓝 / 赭橙 / 靛紫），
// 与本窗其它图同一套色，读者换一张图不必重新认色。
const DIR_COLOR = {
  light: { up: 0x15619b, down: 0xb8571a, isl: 0x6a3d9a },
  dark: { up: 0x4a8fc9, down: 0xd2792f, isl: 0x9878d8 }
}

// 经纬高 → 场景坐标（地球半径 = 1，y 轴为地轴）。
//
// 这里的取向不是随便定的，必须与 SphereGeometry 的 uv 对上，否则贴图整体偏一个角度——
// 表现为「北京画在埃及上空」这种一眼看不出错在哪的错。SphereGeometry 的 u=0 落在 −x 轴
// （x = −cos(2πu)·sinθ、z = sin(2πu)·sinθ），而本模块的贴图是 x_px=(lon+180)/360·W，
// 即 u=0 ⇔ 经度 −180°。令 ψ = lon + 180° 代入即得下式（0°E 落在 +x）。
function lla(latDeg, lonDeg, altKm) {
  const r = (RE_KM + (altKm || 0)) / RE_KM
  const φ = latDeg * D2R, λ = lonDeg * D2R
  return new THREE.Vector3(r * Math.cos(φ) * Math.cos(λ), r * Math.sin(φ), -r * Math.cos(φ) * Math.sin(λ))
}

// ---------------------------------------------------------------------------
// 地球贴图：等经纬（Plate Carrée）一张，与地理场图同源同色
// ---------------------------------------------------------------------------
// 只缓当前主题这一份：3072×1536 一份就 18 MB，两份不值当（换主题重生成约 330 ms，很少发生）
let _tex = null, _texKey = ''
async function earthTexture(dark) {
  const key = dark ? 'dark' : 'light'
  if (_tex && _texKey === key) return _tex
  const map = await loadBasemap()
  // 3072×1536：这颗球默认取景约 300 CSS px 宽、超采样后约 750 设备像素，正面半球（180° 经度）
  // 摊开是 1536 texel —— minification ≈ 2.05，采样正好落在 mip 1（一份盒式滤波过的 1536 图）
  // 这一整级上，既不跨级混合（trilinear 混出来的那点糊正是原来 2048 配 mip 0.45 的观感），
  // 又等于把岸线按 2× 超采样再降下来；滚轮放大一档也还有真细节。
  // 再往上（4096）实测绘制 120→270 ms、换主题到见效 330→520 ms、显存翻倍，却因为采样落在
  // mip 1.45 上跨级混合，默认视角并不更清楚 —— 到此为止。
  const W = 3072, H = 1536
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const cx = cv.getContext('2d')
  cx.fillStyle = OCEAN
  cx.fillRect(0, 0, W, H)
  const view = { lon0: -180, lon1: 180, lat0: -90, lat1: 90 }, size = { w: W, h: H }
  const opt = { minPx: 1.1, minSize: 1.6 }
  const land = basemapPaths(map.land, view, size, opt)
  const borders = basemapPaths(map.borders, view, size, opt)
  // 陆地面的环要闭合（内环挖空靠 evenodd）；国界是开口折线，闭合会凭空多出一条弦
  const trace = (paths, close) => {
    cx.beginPath()
    for (const p of paths) {
      cx.moveTo(p[0], p[1])
      for (let i = 2; i < p.length; i += 2) cx.lineTo(p[i], p[i + 1])
      if (close) cx.closePath()
    }
  }
  if (land.length) { trace(land, true); cx.fillStyle = LAND; cx.fill('evenodd') }
  // 洗淡一道：满饱和的海陆会把叠在上面的链路线压住（暗色主题则是整颗球发光刺眼）。
  // 比地理场图轻——那边底图退到场后面，这里球面本身就是主景，退过头就只剩一团灰。
  cx.fillStyle = dark ? 'rgba(0,0,0,0.30)' : 'rgba(255,255,255,0.12)'
  cx.fillRect(0, 0, W, H)
  cx.lineJoin = 'round'
  // 线宽按「落到屏幕上有多粗」定，不是按贴图上好看定。这颗球默认取景约 300 CSS px 宽，
  // 球心一带 1 CSS px ≈ 3.2 texel（3072 texel/360° ÷ 半径 152 px 的弧度密度），故
  // 2.4/1.9 texel 上屏正好是 0.75/0.6 CSS px —— 与地理场图那张的岸线/国界同粗
  //（见 LbSurfacePlot 的 0.75k / 0.6k：那张图三轮减重、连衬底一并去掉之后线又细了一档，
  // 这边跟着走，两张图并排放着必须一家人）。反过来也有下限：更早按 1.2/0.9 texel 画，
  // 上屏只有半个像素宽，岸线灰淡发虚——细不等于虚，得按上屏像素算，别按贴图观感调。
  // 色值与地理场图**刻意不同**：那边线压在 Turbo 场上、取中段明度的半透明灰；放到这颗
  // 浅海蓝 + 浅陆黄绿的球上等于没画，故这边仍是不透明的深一档灰。
  // 同族冷灰、同一层级（岸线深于国界），这才是「统一」。
  if (borders.length) { trace(borders, false); cx.strokeStyle = BORDER; cx.lineWidth = 1.9; cx.stroke() }
  if (land.length) { trace(land, true); cx.strokeStyle = COAST; cx.lineWidth = 2.4; cx.stroke() }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 16                    // 临边（视线掠过球面处）压缩极大，各向异性采样是唯一救法
  if (_tex) _tex.dispose()               // 换主题：旧的那份连同 18 MB 画布一起放掉
  _tex = tex; _texKey = key
  return tex
}

// ---------------------------------------------------------------------------
// 精灵：文字标注 / 站点 / 卫星
// ---------------------------------------------------------------------------
// 一律不参与深度测试。贴在球面上的标记与标注，锚点就在球面上，而广告牌是平的：
// 稍稍偏离锚点的那些像素就落到球面之后，被深度测试一格一格切掉——表现为「站点还在、
// 名字没了」，只在锚点附近剩一小撮笔画。挡不挡改由 syncSprites 逐帧做「从相机看它是不是
// 被地球挡住」的射线判定（见那里），同一件事，但边缘是干净的。
function spriteFrom(draw, w, h) {
  const cv = document.createElement('canvas')
  cv.width = Math.round(w * SPRITE_SS); cv.height = Math.round(h * SPRITE_SS)
  const cx = cv.getContext('2d')
  cx.__i18nSkip = true                    // 标注语言由「报表语言」管辖（LB_DOC_EN），不随界面语言走
  cx.scale(SPRITE_SS, SPRITE_SS)
  draw(cx, w, h)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false })
  const sp = new THREE.Sprite(mat)
  sp.userData.px = { w, h }
  return sp
}

function labelSprite(text, color, halo) {
  const fs = 13, pad = 3
  const probe = document.createElement('canvas').getContext('2d')
  probe.__i18nSkip = true                 // 量宽与绘制同语言（报表语言），见 spriteFrom
  probe.font = `${fs}px ${LABEL_FONT || uiFontStack()}`
  const w = Math.ceil(probe.measureText(text).width) + pad * 2
  const h = fs + pad * 2
  return spriteFrom((cx) => {
    cx.font = `${fs}px ${LABEL_FONT || uiFontStack()}`
    cx.textBaseline = 'middle'
    cx.lineJoin = 'round'
    cx.lineWidth = 2.8
    cx.strokeStyle = halo                 // 描边光晕：字压在海陆交界上也读得出
    cx.strokeText(text, pad, h / 2)
    cx.fillStyle = color
    cx.fillText(text, pad, h / 2)
  }, w, h)
}

// 地球站：小圆点 + 外环（外环留白一圈，压在深色海面上也分得清）
function stationSprite(color) {
  const S = 18
  return spriteFrom((cx) => {
    cx.translate(S / 2, S / 2)
    cx.beginPath(); cx.arc(0, 0, 6.4, 0, Math.PI * 2)
    cx.strokeStyle = 'rgba(255,255,255,0.9)'; cx.lineWidth = 1.9; cx.stroke()
    cx.beginPath(); cx.arc(0, 0, 6.4, 0, Math.PI * 2)
    cx.strokeStyle = color; cx.lineWidth = 1.3; cx.stroke()
    cx.beginPath(); cx.arc(0, 0, 2.6, 0, Math.PI * 2)
    cx.fillStyle = color; cx.fill()
  }, S, S)
}

// 卫星：一眼认得出的星体轮廓（本体 + 两翼太阳帆板），不用抽象圆点——
// 图上同时有站有星，形状差异比颜色差异更快被读出来。
function satSprite(color) {
  const S = 26, c = S / 2
  return spriteFrom((cx) => {
    cx.translate(c, c)
    cx.lineJoin = 'round'; cx.lineCap = 'round'
    const stroke = (w, s) => { cx.strokeStyle = s; cx.lineWidth = w }
    const body = () => { cx.beginPath(); cx.rect(-3.2, -3.2, 6.4, 6.4) }
    const panels = () => {
      cx.beginPath()
      cx.moveTo(-3.6, 0); cx.lineTo(-9.5, 0)
      cx.moveTo(3.6, 0); cx.lineTo(9.5, 0)
    }
    const wings = () => {
      cx.beginPath()
      cx.rect(-9.6, -2.6, 5.4, 5.2)
      cx.rect(4.2, -2.6, 5.4, 5.2)
    }
    // 先描一圈白，让星体在深蓝海面/彩色链路线上都留得住边
    stroke(2.7, 'rgba(255,255,255,0.92)'); body(); cx.stroke(); panels(); cx.stroke(); wings(); cx.stroke()
    stroke(1.3, color); body(); cx.stroke(); wings(); cx.stroke()
    stroke(1.1, color); panels(); cx.stroke()
    body(); cx.fillStyle = color; cx.fill()
  }, S, S)
}

// 星下点：地面上的小十字环（与站点区分开——它不是设施，只是投影）
function nadirSprite(color) {
  const S = 14, c = S / 2
  return spriteFrom((cx) => {
    cx.translate(c, c)
    cx.beginPath(); cx.arc(0, 0, 4.2, 0, Math.PI * 2)
    cx.strokeStyle = 'rgba(255,255,255,0.85)'; cx.lineWidth = 1.7; cx.stroke()
    cx.beginPath(); cx.arc(0, 0, 4.2, 0, Math.PI * 2)
    cx.moveTo(-5.6, 0); cx.lineTo(5.6, 0)
    cx.moveTo(0, -5.6); cx.lineTo(0, 5.6)
    cx.strokeStyle = color; cx.lineWidth = 1; cx.stroke()
  }, S, S)
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
export function createLinkGlobe(container) {
  const w0 = Math.max(1, container.clientWidth || 480), h0 = Math.max(1, container.clientHeight || 320)
  // 不透明底（清屏色 = 页面底色）而非 alpha 通道：出图直接就是不透明的 PNG，
  // 贴进 Word 不会露出下面的东西。
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  renderer.setSize(w0, h0, false)
  renderer.setPixelRatio(renderScale())
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  // near 0.02 / far 400：GEO 站在 6.6 个地球半径外，拉远看全景时远裁剪面不能切掉它
  const camera = new THREE.PerspectiveCamera(38, w0 / h0, 0.02, 400)
  camera.position.set(0, 0, 3.2)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.09
  controls.enablePan = false          // 平移会把地球推出画面，且这张图本就只该绕着看
  controls.rotateSpeed = 0.42
  controls.enableZoom = false   // 自定义滚轮缩放（见下方 wheel）：与星座 3D 页同一套指数步进 + 每帧缓动
  // 下限压得很小：自动取景的目标点常常就落在地表上（近地链路的节点全挤在一小片上），
  // 若按「离地心一个半径」设下限，取景算出来的机位会被这条限位一把拽走，各体制的图
  // 全成一个样。真正防止扎进地球的是取景里那条「相机离地心 ≥1.75 R」，见 frame()。
  controls.minDistance = 0.12
  controls.autoRotateSpeed = 0.6

  // 地球：不打光的平涂贴图（MeshBasicMaterial），与星座 3D 那颗（viz/globe3d/scene.js
  // 的海洋球/陆地网格，同样一律 MeshBasicMaterial）同一个渲染口径 —— 一个软件里两颗地球
  // 应该长成一家人。曾经用 Lambert + 环境光 0.6/顺相机方向光 0.42 做临边压暗，本意是让它
  // 「读起来是个球而不是个圆片」，实测代价太大：边缘一路暗到 0.6，海陆本就洗淡过一道，
  // 再压一层就整颗发灰发糊；再叠上原来那层菲涅尔大气外晕（已删），看着就是罩了层蓝雾。
  // 球感由链路线、星下点垂线与两极贴图的收敛来交待，够了。
  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 64),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  )
  scene.add(globe)

  // 链路层：一次 setScene 全量重建（节点最多四五个，增量更新不值得）
  const layer = new THREE.Group()
  scene.add(layer)
  const lineMats = new Set()
  let curW = w0, curH = h0
  let dark = false
  let dirty = 6                        // 待渲染帧数：交互/改数时补满，静止时降到 0 不空转
  const mark = (n) => { dirty = Math.max(dirty, n || 30) }
  controls.addEventListener('change', () => mark(2))

  // 滚轮缩放：与星座 3D 页（viz/globe3d/scene.js）同一套手感，两颗地球滚起来该是一个软件。
  // OrbitControls 自带的 dolly 每格只走 ~4%（0.95^zoomSpeed）且一帧到位——要滚十几下才动
  // 得起来，动起来又是一跳一跳的。改成维护一个「目标距离」按指数步进（每格 ≈ ±20% 距离，
  // 乘性步进天然带梯度：离地球近时每格走的绝对距离就小，精细；远时走得多，快），
  // 每帧再把实际半径向它缓动逼近，连续顺滑，累积的滚动一次到位。
  let zoomTarget = camera.position.distanceTo(controls.target)
  const syncZoomTarget = () => { zoomTarget = camera.position.distanceTo(controls.target) }
  renderer.domElement.addEventListener('wheel', (e) => {
    // enableZoom=false 后 OrbitControls 不再拦滚轮，这里必须自己拦：
    // 这张图嵌在链路预算那一整页可滚动的工作台里，不拦就是滚一下缩放、整页跟着窜一截。
    e.preventDefault()
    const factor = Math.exp(e.deltaY * 0.0018)   // 每格 deltaY≈±100 -> ~±20% 距离
    zoomTarget = Math.max(controls.minDistance, Math.min(controls.maxDistance, zoomTarget * factor))
    mark(4)
  }, { passive: false })

  // 缩放缓动：每帧把实际半径向 zoomTarget 逼近 0.18（与星座 3D 同系数）。
  // 未收敛就自己把帧续上——这张图静止时 dirty 会归零停渲染，不续帧缓动只会走一帧就卡住。
  const zoomDir = new THREE.Vector3()
  function easeZoom() {
    const cur = camera.position.distanceTo(controls.target)
    if (Math.abs(cur - zoomTarget) < 1e-4) return
    const next = cur + (zoomTarget - cur) * 0.18
    zoomDir.copy(camera.position).sub(controls.target).normalize()
    camera.position.copy(controls.target).addScaledVector(zoomDir, next)
    mark(2)
  }

  function clearLayer() {
    layer.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) {
        if (o.material.map && o.material.map.isCanvasTexture) o.material.map.dispose()
        lineMats.delete(o.material)
        o.material.dispose()
      }
    })
    layer.clear()
  }

  function fatLine(a, b, color, width, dashed) {
    const g = new LineGeometry()
    g.setPositions([a.x, a.y, a.z, b.x, b.y, b.z])
    const m = new LineMaterial({
      color, linewidth: width, transparent: true, opacity: dashed ? 0.75 : 1,
      dashed: !!dashed, dashSize: 0.055, gapSize: 0.04, depthWrite: false
    })
    m.resolution.set(curW, curH)
    lineMats.add(m)
    const o = new Line2(g, m)
    o.computeLineDistances()
    o.renderOrder = dashed ? 3 : 4
    return o
  }

  // 精灵按「屏幕像素」定尺寸：拉远拉近都保持同样大小，标注不会缩成一团或糊满屏。
  const pxSprites = []
  function addSprite(sp, pos, offsetPx) {
    sp.position.copy(pos)
    sp.userData.offsetPx = offsetPx || [0, 0]
    sp.renderOrder = 6
    pxSprites.push(sp)
    layer.add(sp)
    return sp
  }
  // 相机到 p 的连线是否被地球挡住（球半径取 0.998，免得贴在地表的站点被自己脚下那点球面判成遮挡）
  const _seg = new THREE.Vector3()
  function occluded(p) {
    _seg.copy(p).sub(camera.position)
    const a = _seg.lengthSq()
    if (a < 1e-12) return false
    const b = camera.position.dot(_seg)
    const t = -b / a                                     // 连线上离地心最近的参数
    if (t <= 0 || t >= 1) return false                   // 最近点在两端之外 → 挡不住
    const R = 0.998
    return camera.position.lengthSq() + 2 * t * b + t * t * a < R * R
  }
  function syncSprites() {
    if (!pxSprites.length) return
    const vh = 2 * Math.tan((camera.fov * D2R) / 2)      // 单位距离上的视口高度（世界单位）
    for (const sp of pxSprites) {
      sp.visible = !occluded(sp.position)                // 转到地球背面就收起来（替代深度测试，见 spriteFrom）
      if (!sp.visible) continue
      const d = camera.position.distanceTo(sp.position)
      const k = (vh * d) / Math.max(1, curH)             // 每屏幕像素 = 多少世界单位
      const { w, h } = sp.userData.px
      sp.scale.set(w * k, h * k, 1)
      const [ox, oy] = sp.userData.offsetPx
      if (ox || oy) {
        sp.center.set(0.5 - ox / w, 0.5 - oy / h)        // 用 center 平移：不动位置，标注挂在锚点旁
      }
    }
  }

  let current = null
  // keepView：换主题时只重建线与标注的颜色，不把用户转到一半的视角拽回原位
  function setScene(desc, keepView) {
    current = desc || null
    clearLayer()
    pxSprites.length = 0
    if (!current || !current.nodes || !current.nodes.length) { mark(2); return }
    const C = dark ? DIR_COLOR.dark : DIR_COLOR.light
    const cs = getComputedStyle(document.documentElement)
    const textColor = (cs.getPropertyValue('--text') || '').trim() || (dark ? '#e8e6e1' : '#1f1f1d')
    const halo = dark ? 'rgba(20,20,18,0.88)' : 'rgba(255,255,255,0.92)'
    const hex = (n) => '#' + n.toString(16).padStart(6, '0')

    const pos = {}
    for (const n of current.nodes) pos[n.id] = lla(n.latDeg, n.lonDeg, n.altKm)

    // 链路线（站-星直线即真实电波路径），先画线后画点：点压在线头上更利索。
    // 线宽 1.5 CSS px（原 2.4）：这颗球默认只有三百来像素宽，一条 2.4 px 的线摊在上面
    // 有地球直径的百分之一那么粗，看着像根管子而不是一条视线；而这张图要交待的是
    // 「这条链路的几何」，线只需存在感够、不必粗。
    for (const leg of (current.legs || [])) {
      const a = pos[leg.from], b = pos[leg.to]
      if (!a || !b) continue
      layer.add(fatLine(a, b, C[leg.dir] || C.up, 1.5, false))
    }

    for (const n of current.nodes) {
      const p = pos[n.id]
      // 该节点的用色随它参与的链路方向走（发端站与上行线同色，一眼看出谁是谁）
      const leg = (current.legs || []).find((l) => l.from === n.id || l.to === n.id)
      const col = C[(leg && leg.dir) || 'up'] || C.up
      if (n.kind === 'sat') {
        // 星下点 + 虚线垂线：卫星飘在天上，不落到地面就说不清它此刻在哪儿上空
        const sub = lla(n.latDeg, n.lonDeg, 0)
        layer.add(fatLine(sub, p, col, 0.9, true))
        addSprite(nadirSprite(hex(col)), sub, [0, 0])
        addSprite(satSprite(hex(col)), p, [0, 0])
        addSprite(labelSprite(n.name, textColor, halo), p, [0, 15])
      } else {
        // 收信站的名字挂在下方：GEO 那张图上地球只有一两百像素宽，同一片区域的两个站
        // 名字一律朝上就会叠在一起，两端分开挂正好各占一边
        addSprite(stationSprite(hex(col)), p, [0, 0])
        addSprite(labelSprite(n.name, textColor, halo), p, [0, n.role === 'rx' ? -13 : 13])
      }
    }
    if (!keepView) frame()
    mark(40)
  }

  // 自动取景：让站、星、星下点都落进画面，视线抬高一点——正对着链路看时那几条线在
  // 视线方向上退化成一个点，长度全看不出来，斜着看才有「这条链路有多长」的实感。
  //
  // 取景不按 3D 包围球算，而是逐点解「它落在画幅内需要多远」。包围球在 GEO 上会差出一倍：
  // 所有节点几乎在同一个方向上（站在地面、星在其正上方 6.6 个地球半径处），包围球半径量的
  // 是那条深度方向的长度——而深度方向根本不占屏幕，等于为一个看不见的维度让出全部画幅，
  // 结果是一颗指甲盖大的地球泡在一片空白里。逐点式：把点拆成「沿视线的深度 z」与「横向偏移
  // x/y」，要它落在画幅中央 FILL 见方内即 |x| / (D − z) ≤ FILL·tan(fovH/2)，解出
  //   D ≥ z + |x| / (FILL·tan(fovH/2))，纵向同理，取各点最大者。
  // 横纵分别按各自视场角算，16:9 的画幅才用得上（按 min(fovH,fovV) 一刀切等于当成方画幅）。
  // 不用「真投影 + 二分」：机位从近推到远的途中会正好穿过卫星，那一带投影发散、并不单调，
  // 二分会落到错误的分支上（实测 GEO 一路收到最近距离，整幅只剩地表一块）。
  const WORLD_UP = new THREE.Vector3(0, 1, 0)
  const FILL = 0.82        // 画幅利用率：节点投影落在中央 82% 见方内，余下留给标注与地球轮廓
  let home = { target: new THREE.Vector3(), pos: new THREE.Vector3(0, 0, 3.2) }
  function frame() {
    const pts = []
    const dir = new THREE.Vector3()
    let hMax = 0
    if (current && current.nodes) {
      for (const n of current.nodes) {
        const p = lla(n.latDeg, n.lonDeg, n.altKm)
        pts.push(p)
        if (n.altKm > 0) pts.push(lla(n.latDeg, n.lonDeg, 0))   // 星下点也框进来（虚线垂线的另一头）
        dir.add(p.clone().normalize())
        hMax = Math.max(hMax, (n.altKm || 0) / RE_KM)
      }
    }
    if (!pts.length) pts.push(new THREE.Vector3(0, 0, 1))
    if (dir.lengthSq() < 1e-9) dir.set(0, 0.35, 1)
    dir.normalize()
    // 视线从「正对着这条链路」转开一个角度，否则站-星那一段正对相机、在屏幕上退化成一个点，
    // 「这条链路有多长、擦地擦得多低」全看不出来。转开的量随轨道高度走：
    //   方位（绕地轴）把星地那一段甩到画面横向——16:9 的画幅横向最宽，GEO 那 6.6 个地球
    //     半径正该摊在这条轴上；高轨转得多，近地不必（近地链路本就该像地图一样正着看）。
    //   俯仰（抬高）只给一点点，够看出这是个球、星确实浮在球面之上即可；抬多了近地链路
    //     整片区域被压扁成一条边。
    const k = Math.min(1, hMax / 1.2)
    const az = (12 + 38 * k) * D2R
    const el = (24 - 17 * k) * D2R
    dir.applyAxisAngle(WORLD_UP, az)
    const axis = new THREE.Vector3().crossVectors(dir, WORLD_UP)
    if (axis.lengthSq() > 1e-9) dir.applyAxisAngle(axis.normalize(), el)
    const center = new THREE.Vector3()
    for (const p of pts) center.add(p)
    center.divideScalar(pts.length)
    // 屏幕两轴（相机 up 恒为地轴，见 resetView：地球正着看，北在上）
    const right = new THREE.Vector3().crossVectors(dir, WORLD_UP)
    if (right.lengthSq() < 1e-9) right.set(1, 0, 0)
    right.normalize()
    const upv = new THREE.Vector3().crossVectors(right, dir).normalize()
    const tanV = Math.tan(camera.fov * D2R / 2) * FILL, tanH = tanV * camera.aspect
    let dist = 0
    const v = new THREE.Vector3()
    for (const p of pts) {
      v.copy(p).sub(center)
      const z = v.dot(dir)
      dist = Math.max(dist, z + Math.abs(v.dot(right)) / tanH, z + Math.abs(v.dot(upv)) / tanV)
    }
    // 相机离地心不少于 1.75 R：贴太近整幅只剩一块地皮，看不出这条链路落在地球的哪儿
    //（近地链路的节点全挤在一小片上，光按节点取景会一头扎进地表）
    for (let k = 0; k < 400 && v.copy(center).addScaledVector(dir, dist).length() < 1.75; k++) dist += 0.05
    home = { target: center.clone(), pos: center.clone().addScaledVector(dir, dist) }
    controls.maxDistance = Math.max(8, dist * 3)
    resetView()
  }
  function resetView() {
    controls.target.copy(home.target)
    camera.position.copy(home.pos)
    camera.up.set(0, 1, 0)
    controls.update()
    syncZoomTarget()   // 目标距离跟着复位，否则复位后滚一下会被旧目标一把拽回上一个机位
    mark(40)
  }

  async function applyTheme(isDark) {
    dark = !!isDark
    const cs = getComputedStyle(document.documentElement)
    const bg = (cs.getPropertyValue('--bg') || '').trim() || (dark ? '#1c1c1a' : '#ffffff')
    try { renderer.setClearColor(new THREE.Color(bg), 1) } catch (e) { renderer.setClearColor(dark ? 0x1c1c1a : 0xffffff, 1) }
    const tex = await earthTexture(dark)
    globe.material.map = tex
    globe.material.needsUpdate = true
    if (current) setScene(current, true)          // 线与标注的颜色跟着主题重来一遍，视角不动
    mark(40)
  }

  function resize() {
    const w = Math.max(1, container.clientWidth || curW), h = Math.max(1, container.clientHeight || curH)
    if (w === curW && h === curH) return
    curW = w; curH = h
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    for (const m of lineMats) m.resolution.set(w, h)
    mark(6)
  }

  // 出图：临时把渲染分辨率抬到 scale 倍再取一帧（一张 ~900 CSS px 宽的图出来是 3600 px，
  // 报告里按整幅宽放置约合 600 dpi）。上限按最大边 8192 收——再大的帧缓冲在一部分驱动上
  // 直接分配失败，toDataURL 取回来的是一张黑图，而用户看到的只是「出图坏了」。
  function snapshot(scale) {
    const cap = Math.max(1, Math.min(8, 8192 / Math.max(curW, curH)))
    const s = Math.max(1, Math.min(cap, scale || 4))
    const dpr = renderer.getPixelRatio()
    try {
      renderer.setPixelRatio(s)
      // 线宽（Line2/LineMaterial）**不动 resolution**。材质里线的半宽 = linewidth / resolution.y
      // 个 NDC，也就是「resolution 这套坐标下的 linewidth 像素」；屏上 resolution 记的是 CSS
      // 尺寸，于是 dpr 抬多少线就跟着粗多少，上屏恒为 1.5 CSS px。出图同理：保持 CSS 尺寸不动，
      // 4 倍的画布上线自然是 4 倍粗，缩回原尺寸看与屏幕一模一样。早先这里把 resolution 一并
      // 乘上 s，等于把线钉死在「设备像素 1.5 px」——出的图里链路线细得像根头发丝，
      // 正是「出图质量差」在这张图上的样子。
      // 出图也不能只是「再画一帧」：标注与标记的世界尺寸由 syncSprites 按当前机位算，
      // 若这一帧之前恰好一帧都没画过（换了链路就立刻点出图、或窗口在后台被节流），
      // 精灵还停在默认的 1 个世界单位上——出来的图里一个站点标记有半个地球那么大。
      // 字体：屏上是界面字体，导进报告的这一份换成报告的衬线栈。精灵贴图在 setScene 里烤死，
      // 故先整场重建一次再渲；current 就是上一次 setScene 的入参，keepView 保住用户的机位。
      LABEL_FONT = DOC_FONT_STACK
      setScene(current, true)
      syncSprites()
      renderer.render(scene, camera)
      return renderer.domElement.toDataURL('image/png')
    } finally {
      LABEL_FONT = null
      setScene(current, true)       // 换回屏上那一份；机位不动，用户看不出中间那一帧
      renderer.setPixelRatio(dpr)   // 抛了也要还原，否则整块画布卡在出图分辨率上
      mark(6)
    }
  }

  let raf = 0, timer = 0, disposed = false
  function step() {
    if (disposed) return
    if (dirty <= 0 && !controls.autoRotate) return
    dirty--
    controls.update()   // 旋转/阻尼（半径在此保持不变）
    easeZoom()          // 再把半径向滚轮的目标距离缓动一步
    syncSprites()
    renderer.render(scene, camera)
  }
  function loop() {
    if (disposed) return
    raf = requestAnimationFrame(loop)
    step()
  }
  loop()
  // rAF + 100 ms 定时器双保险（同 viz/globe3d/scene.js 的 schedule）：窗口最小化、
  // 或这张图所在的画布暂时不合成时，rAF 被浏览器节流到 0 fps——只挂 rAF 的话，
  // 此间换一条链路就再也画不出来，回到前台看到的还是上一条的几何。
  timer = setInterval(step, 100)

  const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(resize) : null
  if (ro) ro.observe(container)

  return {
    setScene,
    applyTheme,
    resize,
    resetView,
    snapshot,
    setAutoRotate(on) { controls.autoRotate = !!on; mark(4) },
    dispose() {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      if (timer) clearInterval(timer)
      if (ro) ro.disconnect()
      clearLayer()
      controls.dispose()
      globe.geometry.dispose(); globe.material.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
  }
}
