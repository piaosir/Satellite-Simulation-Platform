// 平面覆盖图渲染器（2D Canvas，等距圆柱投影 / plate carrée，从西经30°切开）。
// 底图（陆地配色/国界/国家名/大洋名/省界省名/标记）与 3D 球体保持一致；叠加覆盖图数据。
// 不画星座、卫星点、卫星名、卫星连线。配色常量与 globe3d/scene.js 同源。
// 陆地配色（LAND/CHINA/ICE/基调方案/逐国覆盖）统一收拢到 ../landPalette.js（与 3D 球体共用单一来源）
import { ARCTIC_ISLAND_LAT, landColors, setLandPalette } from '../landPalette.js'
// 底图的面/线/国名/点选全部由主权解算层按归属实时算出（与 3D 球体同一份），视角 = 一张归属表
import { resolvedFeatures, resolvedLines, labelSet, ensureDetail, onPovChange } from '../geo/povResolver.js'
// 五类边界线的渲染次序 / 出厂样式 / 屏幕像素虚线图案 / 缩放淡出档位：与 3D 球体共用同一份常量
import { BORDER_DEF, DASH_PX, DASH_SCALE, BORDER_DRAW, CFG_KEY, fadeFactor, admFade } from '../geo/borderStyle.js'
import { terminatorFlat } from '../terminator.js'

const OCEAN = '#15426b'
// 南极极冠：南极洲数据止于约 -85°，极点处留有空洞，补到 -90°。
const SOUTH_CAP_LAT = -82
const GRID = 'rgba(255,255,255,0.12)', BG = '#070b12'
const LON0 = -30          // 切口：西经30°为左边缘，经度范围 [-30, 330)
const OCEANS = [
  ['太平洋', 'Pacific Ocean', -155, 25], ['太平洋', 'Pacific Ocean', -130, -22],
  ['大西洋', 'Atlantic Ocean', -35, 28], ['大西洋', 'Atlantic Ocean', -18, -25],
  ['印度洋', 'Indian Ocean', 78, -28], ['北冰洋', 'Arctic Ocean', 0, 85], ['南大洋', 'Southern Ocean', 40, -62]
]
// 大洋名描边色（与 3D 同：斜体浅蓝）
const OCEAN_FILL = 'rgba(150,195,230,0.92)'
// 地球站图标（与 3D 同一张 SVG）
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

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const hex = (c) => typeof c === 'number' ? '#' + (c & 0xffffff).toString(16).padStart(6, '0') : (c || '#fff')
// 经度解缠：把一条折线/环上各点搬到连续窗口，避免跨 ±180 时被画成横贯全图的假线
function unwrap(ring) {
  const out = new Array(ring.length); let prev = ring[0][0]; out[0] = [prev, ring[0][1]]
  for (let i = 1; i < ring.length; i++) { let lo = ring[i][0]; while (lo - prev > 180) lo -= 360; while (lo - prev < -180) lo += 360; out[i] = [lo, ring[i][1]]; prev = lo }
  return out
}

export function createFlatCoverage(canvas) {
  let ctx = canvas.getContext('2d')   // 绘制目标上下文：导出时临时切到离屏 canvas / svgcanvas（见 exportRender）
  // 导出兼容模式：svgcanvas/canvas2svg 忽略 Path2D 与 evenodd 入参，故导出时把陆地/覆盖填充/等值线
  // 改为「子路径回放」（moveTo/lineTo），实时绘制仍走 Path2D 缓存（更快）。compat 同时用于离屏高清 PNG，
  // 保证 PNG 与 PDF 完全一致。textFont/textFontLatin：导出可指定字体族名（PDF 用注册名匹配嵌入的中文/西文面）。
  let compat = false
  // 导出（PNG/PDF）物理分辨率远高于屏幕，文字描边按同一相对粗细在高清大图上观感发粗 → 导出时额外收细。
  const EXPORT_STROKE_K = 0.6
  // 与界面同栈（styles/global.css 的 --font-serif 手工镜像）：Times New Roman 打西文，宋体接中文
  let textFont = '"Times New Roman", Times, "SimSun", "宋体", serif'
  // 导出 PDF 专用：西文/数字单独的族名。PDF 的字体按资源整体选用、不像浏览器逐字形回落，故拉丁与中文
  // 各嵌一套，此处按「这条文本里有没有汉字」二选一。null=不分面（屏幕/PNG 走上面的完整回退栈即可）。
  let textFontLatin = null
  const CJK_RE = /[⺀-鿿㐀-䶿豈-﫿　-〿＀-￯]/   // 汉字/假名/中文标点/全角
  // 渲染分辨率倍率（与 3D 同一画质档位）：null=跟随系统 DPR；否则为请求倍率，但封顶为「物理像素密度 × SS_CAP」。
  // 超出物理像素的超采样屏幕无法显示、纯耗 GPU，封顶后对画质无影响（与 3D 球体同策略，见 globe3d/scene.js）。
  let renderScale = null
  const SS_CAP = 1.5
  const effDpr = () => {
    const dpr = window.devicePixelRatio || 1
    return renderScale != null
      ? Math.max(0.25, Math.min(renderScale, dpr * SS_CAP, 4))
      : Math.max(1, dpr)
  }
  let dpr = effDpr()
  let cw = 1, ch = 1, base = 1, scale = 1, tx = 0, ty = 0
  let geom = null
  let fieldLayers = [], fieldAlpha = 0.8   // GRD 覆盖多层（每层=一个天线：分带填充 Path2D + 逐档等值线，独立于 geom）
  let covGridLayers = [], covGridAlpha = 0.82   // STK Coverage 覆盖分析【专用通道】：FOM 分带热力图（各胞元四角），独立于 GRD 覆盖场
  // 环境场【专用通道】：一张等经纬位图（ITU 降雨率/零度等温线/海拔…）+ 逐档等值线。
  // 位图不走分带多边形——连续场用栅格一次 drawImage 即可，缩放平移零成本、也不受多边形数量拖累。
  let envImg = null, envBBox = null, envAlpha = 0.78, envSmooth = true
  let envContours = []   // [{ level, text, color, width, lines:[[[lon,lat]...]], labels:[{lon,lat,a}] }]
  // 晨昏线 / 夜区：随时间轴每次推进重算，只存当次的点列（约 360 点，逐帧直接 trace，不烘 Path2D
  // ——量级比覆盖分带小两三个数量级，缓存收益还不如省掉 compat 分支的复杂度）
  let termData = null, termOpts = {}
  // GRD 全局标注选项（与 3D 同步）：波束名 / 峰值点 / 数值标签
  let fieldOpts = { showName: true, nameSize: 16, showBore: true, boreSize: 0.5, showPeak: false, peakSize: 5, showVal: false, valSize: 12 }
  let nameMode = 'off', provVisible = false, prov = null, cityVisible = false, city = null
  // 国界(海岸线)/省界/地级市界线样式：线宽为恒定屏幕 px、颜色十六进制、透明度 0–1（与 3D 同步）
  // 五类边界线 + 两级行政区的样式：出厂值与 3D 球体同源（src/viz/geo/borderStyle.js）
  let borderStyle = { ...BORDER_DEF }
  let borderPaths = null   // 五类线烘成的世界度坐标 Path2D（换视角/换精度档/改线型时作废）
  // 地名颜色/透明度：国家名 与 省名 与 地级市名 分开（大洋名维持固有蓝，不随国家色改）
  let labelStyle = { countryColor: '#eef2f6', countryOpacity: 1, provColor: '#ffe6a8', provOpacity: 1, cityColor: '#cdd6e0', cityOpacity: 1 }
  let oceanColor = OCEAN   // 大海填充色（可调，限蓝色系），与 3D 球体同步
  let mk = { points: [], stations: [], trajectories: [] }
  let focusSats = []    // 聚焦卫星星下点列表 [{ lat, lon }...]（多选=每颗各一个图标，同款同大小，不分主次）
  let selGeomList = []  // 聚焦卫星几何列表 [{ footprint:[{lat,lon}...], track:[{lat,lon}...], sub:{lat,lon} }...]，与 3D 同源（多颗同时叠画）
  // 聚焦卫星显示样式（与 3D 同一份设置，由 3D 页 setFocusStyle 推入；线宽/图标尺寸口径与 3D 同为屏幕 px）
  const focusCfg = {
    trkOn: true, trkColor: '#e8c074', trkWidth: 1.6, trkOpacity: 1, trkDash: 'solid',
    fpOn: true, fpColor: '#b8e6fa', fpWidth: 1.6, fpOpacity: 1, fpDash: 'dash',
    fpFillColor: '#b8e6fa', fpFillOpacity: 0,
    subOn: true, subPx: 30, subColor: '#ffffff'
  }
  // 线型 → canvas 虚线数组（屏幕 px；3D 那份按世界弧长切段，两边观感对齐即可，不求逐段一致）
  const DASH_2D = { dash: [7, 5], dot: [1.2, 4] }
  let satLayer = null   // 卫星/仰角线独立图层 { lines, dots, labels, sats }（与 geom/field 互不干扰）
  const sizes = { beamFont: 16, contourFont: 12, dotSize: 5, showBore: true, nameScale: 1, provScale: 1, cityScale: 1, ptFont: 14, stIcon: 32, stFont: 17, satIcon: 30, ptDot: 3.5, trajDot: 2.5 }
  const SAT_ICON_K = 0.85   // 卫星图标：同地球站 ST_ICON_K，2D 观感偏大于 3D，收一档对齐（经验系数，可微调）

  // 地球站图标
  const stationImg = new Image(); let stationReady = false
  stationImg.onload = () => { stationReady = true; invalidateStatic(); requestDraw() }
  stationImg.src = 'data:image/svg+xml;base64,' + btoa(STATION_SVG)

  // 预处理底图：陆地多边形（按国家配色）+ 国家名 + 大洋名。可经 setMapDetail 换源(10m/50m)重建。
  // 边界抽稀（thin>0，单位度）：与 3D 一致地稀疏化各环顶点，低画质档减少 Path2D 顶点。
  const decimateRing = (ring, minD) => {
    if (!minD || ring.length < 3) return ring
    const out = [ring[0]]; let last = ring[0]
    for (let i = 1; i < ring.length - 1; i++) { const p = ring[i]; if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= minD) { out.push(p); last = p } }
    out.push(ring[ring.length - 1]); return out
  }
  let land = [], clabels = [], borderLines = null
  let mapDetail0 = '10m', mapThin = 0
  function buildBaseGeo(feats, thin) {
    land = []; clabels = []
    borderLines = null
    feats.forEach((f, i) => {
      if (!f.geometry) return
      const id = String(f.id)
      const idx = f.idx != null ? f.idx : i     // 取色序号按【归属】定，争议叠加与其基础面取同一号
      const { base: fill, arctic } = landColors(id, idx)
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
      const shapes = [], iceShapes = []   // 普通陆地色 / 北极岛屿冰白（按多边形质心纬度分流）
      for (const rings of polys) {
        let lo = Infinity, hi = -Infinity
        const path = new Path2D()
        const xy = []   // 导出回放用：该多边形各环的「世界度坐标」点列（x=lon-LON0, y=90-lat）
        for (const ring of rings) {
          const u = thin > 0 ? decimateRing(unwrap(ring), thin) : unwrap(ring)
          const r = new Array(u.length)
          for (let i = 0; i < u.length; i++) { const x = u[i][0] - LON0, y = 90 - u[i][1]; if (x < lo) lo = x; if (x > hi) hi = x; i === 0 ? path.moveTo(x, y) : path.lineTo(x, y); r[i] = [x, y] }
          path.closePath()
          xy.push(r)
        }
        // 北极岛屿（外环质心纬度 ≥ ARCTIC_ISLAND_LAT）整块染冰白；其余按国家色。与 3D 球体同口径，不再纬度渐变。
        const o = rings[0]; let sy = 0; for (const p of o) sy += p[1]
        const shape = { lo, hi, path, rings: xy }
        ;((sy / o.length) >= ARCTIC_ISLAND_LAT ? iceShapes : shapes).push(shape)
      }
      if (shapes.length) land.push({ shapes, fill })
      if (iceShapes.length) land.push({ shapes: iceShapes, fill: arctic })   // 逐国设色时 arctic=用户色（整国一色）
    })
    // 国家名：位置/线度来自解算器的 labelSet（按归属合并，per-POV 改名与 hide 在那里做）；
    // 线度→像素字号的映射式子与换源前一字不改
    for (const l of labelSet('zh', mapDetail0)) clabels.push({ zh: l.zh, en: l.en, lon: l.lon, lat: l.lat, px: clamp(Math.round(10 + l.ext * 0.22), 10, 20) })
  }
  buildBaseGeo(resolvedFeatures('10m'), 0)
  // 视角/用户覆写改动由解算器广播回来：底图面/线/国名整份重建 + 静态层快照作废
  const offPov = onPovChange(() => {
    borderPaths = null
    buildBaseGeo(resolvedFeatures(mapDetail0), mapThin)
    invalidateStatic(); requestDraw()
  })

  // 合帧：把一帧内的多次重绘请求合并成一次 rAF 渲染（拖拽/缩放不再被高频事件淹没）。
  let rafId = 0
  function requestDraw() { if (rafId) return; rafId = requestAnimationFrame(() => { rafId = 0; draw() }) }

  // 静态层快照（拖拽波束/调覆盖参数提速核心）：底图(海陆/冰盖/网格)与标注(省界/国家名/标记/卫星层)在拖拽中
  // 完全不变，却原本每帧重画（含上百国家名描边文字，开销大）。把它们渲到离屏缓冲，只在视图变换或静态数据
  // 变化时重建；覆盖图(GRD 填充/等值线)夹在二者之间，故拆「below(field 之下) + above(field 之上)」两张快照。
  // 拖拽/改场只重绘覆盖层，复合 = blit(below) + 覆盖填充/线 + blit(above) + 覆盖标注 + 聚焦星。
  let belowCanvas = null, belowCtx = null, aboveCanvas = null, aboveCtx = null
  let staticValid = false
  function invalidateStatic() { staticValid = false }

  function fit() { base = Math.min(cw / 360, ch / 180); scale = 1; tx = (cw - 360 * base) / 2; ty = (ch - 180 * base) / 2 }
  const k = () => base * scale
  const WXN = (lon) => (((lon - LON0) % 360) + 360) % 360
  const PX = (lon) => WXN(lon) * k() + tx
  const PY = (lat) => (90 - lat) * k() + ty

  // 陆地：把 pan/zoom 烘进变换矩阵，直接填充缓存的 Path2D（每帧零顶点遍历）。
  // 经度环绕用 -360/0/360 三档偏移，按视口裁剪只画可见副本；描边线宽除以缩放保持 0.8px 恒定。
  // 仅填充陆地（海岸线与其余四类边界线移到覆盖之上的 drawBorders）。覆盖填充叠在陆地填充之上、按 alpha 混合 → 覆盖区底色随之透出。
  function drawLand() {
    const kk = k()
    const wl = -tx / kk, wr = (cw - tx) / kk   // 视口世界 X 范围（未含 off）
    for (const off of [-360, 0, 360]) {
      ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
      if (compat) {
        // 导出：按填充色合并成「每色一条 path」（节点数不变，但 <path> 元素从「多边形数」降到「颜色数」）。
        // svg2pdf 逐节点 getComputedStyle 是导出耗时主因——10m 底图有数千多边形，不合并会产生数千节点。
        const byColor = new Map()
        for (const c of land) for (const sh of c.shapes) { if (sh.hi + off < wl || sh.lo + off > wr) continue; let a = byColor.get(c.fill); if (!a) { a = []; byColor.set(c.fill, a) } a.push(sh) }
        for (const [fill, shs] of byColor) { ctx.fillStyle = fill; ctx.beginPath(); for (const sh of shs) for (const r of sh.rings) { for (let i = 0; i < r.length; i++) i === 0 ? ctx.moveTo(r[i][0], r[i][1]) : ctx.lineTo(r[i][0], r[i][1]); ctx.closePath() } ctx.fill('evenodd') }
      } else for (const c of land) {
        let colored = false
        for (const sh of c.shapes) {
          if (sh.hi + off < wl || sh.lo + off > wr) continue
          if (!colored) { ctx.fillStyle = c.fill; colored = true }
          ctx.fill(sh.path, 'evenodd')
        }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)   // 恢复屏幕坐标，后续图层照旧
  }
  // 五类边界线（coast / claim / loc / indefinite / admin0），画在覆盖填充【之上】，
  // 使地理骨架在覆盖区内外连续 → 覆盖像染进地图、与底图平级。
  // 与陆地填充同一套「世界度坐标 Path2D + 三档经度环绕 + 视口裁剪」，故拖拽时零顶点遍历。
  // ★ 线宽与虚线图案都除以 kk：canvas 的 lineWidth / lineDash 都算在用户空间，除掉缩放即得恒定屏幕像素。
  function bakeBorders() {
    const L = resolvedLines(mapDetail0)
    const out = {}
    for (const cls of BORDER_DRAW) {
      const list = []
      for (const poly of (L[cls] || [])) {
        if (!poly || poly.length < 2) continue
        const u = unwrap(poly)
        let lo = Infinity, hi = -Infinity
        const path = new Path2D()
        for (let i = 0; i < u.length; i++) {
          const x = u[i][0] - LON0, y = 90 - u[i][1]
          if (x < lo) lo = x
          if (x > hi) hi = x
          i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)
        }
        list.push({ lo, hi, path })
      }
      out[cls] = list
    }
    borderPaths = out
    return out
  }
  function drawBorders() {
    const kk = k()
    const P = borderPaths || bakeBorders()
    const wl = -tx / kk, wr = (cw - tx) / kk
    for (const cls of BORDER_DRAW) {
      const list = P[cls]
      if (!list || !list.length) continue
      const key = CFG_KEY[cls]
      ctx.strokeStyle = borderStyle[key + 'Color']
      ctx.lineWidth = borderStyle[key + 'Width'] / kk
      ctx.globalAlpha = borderStyle[key + 'Opacity']
      const px = DASH_PX[borderStyle[key + 'Dash'] || 'solid']
      ctx.setLineDash(px ? px.map((v) => v * (DASH_SCALE[cls] || 1) / kk) : [])
      for (const off of [-360, 0, 360]) {
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
        for (const sh of list) { if (sh.hi + off < wl || sh.lo + off > wr) continue; ctx.stroke(sh.path) }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.setLineDash([])
  }
  // 南极极冠：补 SOUTH_CAP_LAT 以南的中央空洞（取南极洲当前填色——默认冰白，被逐国设色时随用户色，无缝衔接）。
  // 北极岛屿改由 buildBaseGeo 按「多边形整块」染冰白（与 3D 同口径），不再有北极纬度渐变，故此处只剩南极极冠。
  function drawIceCaps() {
    const kk = k(), x0 = PX(LON0), w = 360 * kk
    const yCap = PY(SOUTH_CAP_LAT)
    ctx.fillStyle = landColors('ATA', 0).base; ctx.fillRect(x0, yCap, w, PY(-90) - yCap)
  }
  // 卫星图标（矢量复刻聚焦卫星 SVG：双侧 3×2 太阳能板 + 中央星体）。按 color 填充、size 缩放。
  // 仰角线卫星与聚焦卫星共用此函数 —— 平面图上卫星统一为同一枚图标，颜色随各自设置。
  const SAT_BLOCKS = [[8, 41], [21, 41], [34, 41], [8, 63], [21, 63], [34, 63], [76, 41], [89, 41], [102, 41], [76, 63], [89, 63], [102, 63]]
  function drawSatIcon(lon, lat, size, color) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return
    const x = PX(lon), y = PY(lat), s = size || sizes.satIcon || 30
    ctx.save()
    ctx.translate(x, y); ctx.rotate(-20 * Math.PI / 180); ctx.scale(s / 120, s / 120); ctx.translate(-60, -60)
    ctx.fillStyle = color || '#ffffff'; ctx.strokeStyle = 'rgba(8,12,18,0.92)'; ctx.lineWidth = 4; ctx.lineJoin = 'round'
    const rrect = (rx, ry, rw, rh, r) => {
      ctx.beginPath(); ctx.moveTo(rx + r, ry)
      ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, r); ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, r)
      ctx.arcTo(rx, ry + rh, rx, ry, r); ctx.arcTo(rx, ry, rx + rw, ry, r)
      ctx.closePath(); ctx.fill(); ctx.stroke()
    }
    for (const [bx, by] of SAT_BLOCKS) rrect(bx, by, 10, 16, 3)
    rrect(49, 35, 22, 50, 10)
    ctx.restore()
  }
  function drawGrid() {
    const kk = k(), x0 = tx, x1 = tx + 360 * kk
    ctx.strokeStyle = GRID; ctx.lineWidth = 0.8; ctx.beginPath()
    for (let lon = -180; lon <= 180; lon += 15) { const x = WXN(lon) * kk + tx; ctx.moveTo(x, PY(90)); ctx.lineTo(x, PY(-90)) }
    for (let lat = -75; lat <= 75; lat += 15) { const y = PY(lat); ctx.moveTo(x0, y); ctx.lineTo(x1, y) }
    ctx.stroke()
  }
  function drawPolyline(p, color, width, closed, dash) {
    const kk = k()
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    if (dash) ctx.setLineDash(dash)
    ctx.beginPath(); let started = false, pwx = 0
    for (let i = 0; i < p.length; i++) {
      const a = p[i], lon = Array.isArray(a) ? a[0] : a.lon, lat = Array.isArray(a) ? a[1] : a.lat
      const wx = WXN(lon), x = wx * kk + tx, y = (90 - lat) * kk + ty
      if (started && Math.abs(wx - pwx) > 180) { ctx.stroke(); ctx.beginPath(); started = false }
      started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true); pwx = wx
    }
    ctx.stroke()
    if (dash) ctx.setLineDash([])
  }
  function drawText(text, lon, lat, px, color, opt) {
    const o = opt || {}
    const x = PX(lon) + (o.dx || 0), y = PY(lat) + (o.dy || 0)
    const fam = (textFontLatin && !CJK_RE.test(text)) ? textFontLatin : textFont
    ctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${px}px ${fam}`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    // 文字描边套色(casing)：沿字形勾一圈与底色同调的窄边，把字从背景里「切」出来——专业制图标准，不用底色色块
    // 粗细 = px*strokeScale（默认 0.14），下限 strokeMin（默认 1.5）；地级市名传更细值（尽量细但保留）
    const sScale = o.strokeScale != null ? o.strokeScale : 0.14, sMin = o.strokeMin != null ? o.strokeMin : 1.5
    const ek = compat ? EXPORT_STROKE_K : 1
    const lw = Math.max(sMin * ek, px * sScale * ek)
    // o.rot：字随线转（等值线标注用）。转轴放在锚点上，故转后就地画在原点。
    const rot = o.rot ? o.rot * Math.PI / 180 : 0
    if (rot) { ctx.save(); ctx.translate(x, y); ctx.rotate(rot) }
    const tx0 = rot ? 0 : x, ty0 = rot ? 0 : y
    if (lw > 0) { ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(6,11,18,0.82)'; ctx.strokeText(text, tx0, ty0) }
    ctx.fillStyle = color; ctx.fillText(text, tx0, ty0)
    if (rot) ctx.restore()
  }
  function dot(lon, lat, r, fill, ring) {
    const x = PX(lon), y = PY(lat)
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill()
    if (ring) { ctx.lineWidth = Math.max(1, r * 0.35); ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.stroke() }
  }
  // 峰值点标记：细十字（对齐 SATSOFT §11.1 Contour Dialog 的 Beam Peak Label「+」；3D 侧 makeCovCross 同款）。
  // 叉心＝那个点，两条细臂不遮挡下面的等值线/填充。span = 十字全长(px)。
  // ★ 线宽【恒定屏幕像素】，不随 span 走：按比例给线宽的话，放大几档笔画就跟着变粗，十字成了一个又粗又笨
  //   的实心加号（SATSOFT 的十字自始至终是一根细线）。与等值线同档线宽，故也不需要深色套边——等值线自己也没有。
  const CROSS_W = 1.3            // 十字线宽（屏幕 px），与 3D 侧 scene.js 的 CROSS_W 同值
  function cross(lon, lat, span, color) {
    const x = PX(lon), y = PY(lat), a = span * 0.5
    ctx.save()
    ctx.lineCap = 'butt'
    ctx.lineWidth = CROSS_W; ctx.strokeStyle = color
    ctx.beginPath()
    ctx.moveTo(x - a, y); ctx.lineTo(x + a, y); ctx.moveTo(x, y - a); ctx.lineTo(x, y + a)
    ctx.stroke()
    ctx.restore()
  }

  // GRD 分带填充：与 3D 同源——由 bandGeometry 逐三角形切出的各档环带多边形（lon/lat）。每档把全部多边形
  // 烘成一个「世界度坐标」Path2D（x=lon-LON0, y=90-lat，仅在 setField 时一次），同档多边形并入一条 path
  // 一次 fill → 相邻三角形无 AA 缝隙。draw() 随 pan/zoom 只用 setTransform 平移缩放矢量填充（清晰、分辨率无关），
  // 并在 -360/0/+360 三档经度环绕各填一份 → 跨东经180° 无缝。地平/接缝裁剪已在 bandGeometry 内完成。
  // 一层覆盖在「世界 X」(=lon-LON0) 上的经度跨度，供 drawField 的 ±360 环绕做视口裁剪（只填可见副本）。
  function layerBounds(L) {
    let lo = Infinity, hi = -Infinity
    const upd = (lon) => { const x = lon - LON0; if (x < lo) lo = x; if (x > hi) hi = x }
    if (L.fillBands) for (const fb of L.fillBands) { const v = fb.verts; for (let i = 0; i < v.length; i += 2) upd(v[i]) }
    if (L.segGroups) for (const grp of L.segGroups) for (const sg of (grp.segs || [])) { upd(sg[0][0]); upd(sg[1][0]) }
    if (lo > hi) return null
    return { lo, hi }
  }
  function buildFillPaths(fillBands) {
    return fillBands.map((fb) => {
      const path = new Path2D()
      const verts = fb.verts, counts = fb.counts
      let vi = 0
      for (let j = 0; j < counts.length; j++) {
        const plen = counts[j]
        // 扁平缓冲上就近解缠（跨 ±180° 的多边形不会被直线横扫全图）：首点原值，后续相对滚动 prev 取最近副本
        let prev = verts[vi * 2]
        path.moveTo(prev - LON0, 90 - verts[vi * 2 + 1])
        for (let q = 1; q < plen; q++) {
          let lo = verts[(vi + q) * 2]; while (lo - prev > 180) lo -= 360; while (lo - prev < -180) lo += 360
          path.lineTo(lo - LON0, 90 - verts[(vi + q) * 2 + 1]); prev = lo
        }
        path.closePath()
        vi += plen
      }
      return { color: 'rgb(' + fb.color[0] + ',' + fb.color[1] + ',' + fb.color[2] + ')', path }
    })
  }
  // 等值线：与填充同策略——每档一条「世界坐标」Path2D（x=lon-LON0, y=90-lat），仅在 setField/patchField 时烘一次。
  // draw() 随 pan/zoom 只用 setTransform 平移缩放矢量描边（每帧零路径构建），±360 环绕在 drawField 内按视口裁剪。
  // 段两端就近解缠（跨 ±180° 不被直线横扫全图）。线宽在描边时 /kk 保持恒定屏幕 px。
  function buildSegPaths(segGroups) {
    return segGroups.map((grp) => {
      const path = new Path2D()
      for (const sg of (grp.segs || [])) {
        let a = sg[0][0], b = sg[1][0]; while (b - a > 180) b -= 360; while (b - a < -180) b += 360
        path.moveTo(a - LON0, 90 - sg[0][1]); path.lineTo(b - LON0, 90 - sg[1][1])
      }
      return { color: grp.color || 'rgba(255,255,255,0.9)', width: grp.width || 1.2, path }
    })
  }

  // 导出回放：把一档填充环带 / 一组等值线段描进当前路径（与 buildFillPaths/buildSegPaths 同款就近解缠）。
  function traceFillBand(fb) {
    const verts = fb.verts, counts = fb.counts
    let vi = 0; ctx.beginPath()
    for (let j = 0; j < counts.length; j++) {
      const plen = counts[j]; let prev = verts[vi * 2]
      ctx.moveTo(prev - LON0, 90 - verts[vi * 2 + 1])
      for (let q = 1; q < plen; q++) { let lo = verts[(vi + q) * 2]; while (lo - prev > 180) lo -= 360; while (lo - prev < -180) lo += 360; ctx.lineTo(lo - LON0, 90 - verts[(vi + q) * 2 + 1]); prev = lo }
      ctx.closePath(); vi += plen
    }
  }
  function traceSegGroup(grp) {
    ctx.beginPath()
    for (const sg of (grp.segs || [])) { let a = sg[0][0], b = sg[1][0]; while (b - a > 180) b -= 360; while (b - a < -180) b += 360; ctx.moveTo(a - LON0, 90 - sg[0][1]); ctx.lineTo(b - LON0, 90 - sg[1][1]) }
  }

  // 夜区填充 + 晨昏分界线。世界坐标 x=lon−LON0、y=90−lat，与覆盖层同一套 setTransform + ±360 环绕。
  // 采样起点已在 terminatorFlat 里对齐到 LON0（地图接缝）→ 世界 X 单调 0→360，多边形不会被接缝撕开。
  // 画在 drawEnvRaster 之前（即所有数据层之下、底图之上）：夜区是「打光」不是「数据」，
  // 只该压暗底图，不该把覆盖场/等值线一起蒙灰；国界地名在 aboveCanvas，天然压在其上。
  function drawTerminator() {
    if (!termData) return
    const kk = k(), wl = -tx / kk, wr = (cw - tx) / kk
    const o = termOpts
    ctx.save()
    for (const off of [-360, 0, 360]) {
      if (off + 360 < wl || off > wr) continue          // 该副本整幅落在视口外
      ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
      if (o.night !== false) {
        ctx.globalAlpha = o.nightOpacity != null ? o.nightOpacity : 0.42
        ctx.fillStyle = o.nightColor || '#0a1120'
        ctx.beginPath()
        const ng = termData.night
        ctx.moveTo(ng[0][0] - LON0, 90 - ng[0][1])
        for (let i = 1; i < ng.length; i++) ctx.lineTo(ng[i][0] - LON0, 90 - ng[i][1])
        ctx.closePath(); ctx.fill()
      }
      if (o.line !== false) {
        ctx.globalAlpha = o.lineOpacity != null ? o.lineOpacity : 0.75
        ctx.strokeStyle = o.lineColor || '#ffd27a'
        ctx.lineWidth = (o.lineWidth || 1.2) / kk       // 除以缩放 → 恒定屏幕像素宽
        ctx.lineJoin = 'round'; ctx.lineCap = 'round'
        ctx.beginPath()
        const ln = termData.line
        ctx.moveTo(ln[0][0] - LON0, 90 - ln[0][1])
        for (let i = 1; i < ln.length; i++) ctx.lineTo(ln[i][0] - LON0, 90 - ln[i][1])
        ctx.stroke()
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.restore()
  }

  function drawField() {
    const kk = k()
    // 填充：把 pan/zoom 烘进变换矩阵，直接填充缓存的世界坐标 Path2D（每帧零顶点遍历），-360/0/+360 三档环绕。
    // 环绕副本按视口裁剪：放大到某区域时三份里通常只有一份可见 → 大足迹填充成本直降到 1/3（拖拽开填充提速核心）。
    const wl = -tx / kk, wr = (cw - tx) / kk
    ctx.save(); ctx.globalAlpha = fieldAlpha
    for (const L of fieldLayers) {
      if (!L.fillPaths || !L.fillPaths.length) continue
      for (const off of [-360, 0, 360]) {
        if (L.bounds && (L.bounds.hi + off < wl || L.bounds.lo + off > wr)) continue
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
        if (compat) for (const fb of (L.fillBands || [])) { ctx.fillStyle = 'rgb(' + fb.color[0] + ',' + fb.color[1] + ',' + fb.color[2] + ')'; traceFillBand(fb); ctx.fill() }
        else for (const fb of L.fillPaths) { ctx.fillStyle = fb.color; ctx.fill(fb.path) }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.restore()
    // 逐档等值线（多层，每层每档一色）：复用缓存的世界坐标 Path2D，setTransform 平移缩放矢量描边（每帧零构建），
    // ±360 环绕按视口裁剪只描可见副本（与填充同策略）。线宽 /kk 保持恒定屏幕 px。
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    for (const L of fieldLayers) {
      if (!L.segPaths || !L.segPaths.length) continue
      for (const off of [-360, 0, 360]) {
        if (L.bounds && (L.bounds.hi + off < wl || L.bounds.lo + off > wr)) continue
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
        if (compat) for (const grp of (L.segGroups || [])) { if (!grp.segs || !grp.segs.length) continue; ctx.strokeStyle = grp.color || 'rgba(255,255,255,0.9)'; ctx.lineWidth = (grp.width || 1.2) / kk; traceSegGroup(grp); ctx.stroke() }
        else for (const sp of L.segPaths) { ctx.strokeStyle = sp.color; ctx.lineWidth = sp.width / kk; ctx.stroke(sp.path) }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  // STK Coverage FOM 热力图填充：与 drawField 填充同款（缓存的世界坐标 Path2D + setTransform + ±360 环绕视口裁剪），
  // 用独立 covGridLayers / covGridAlpha，画在 GRD 覆盖场【之下】（叠加时 GRD 天线足迹在其上）。无等值线。
  // 环境场栅格：整张等经纬位图一次 drawImage，按 ±360 环绕补副本（与分带填充同样的三档裁剪）。
  // 位图边界不受缩放影响 → 放大后看到的是数据本身的格子，不再有矢量层的重建成本。
  // 矢量 PDF 那条路（svgcanvas）把位图转成 <image>，但不认 globalAlpha —— 直接画会比 PNG 深一截。
  // 故导出时把整层透明度先烘进一张临时位图，两条导出路径才逐像素一致。缓存随图/透明度失效。
  let envFade = null, envFadeKey = ''
  function envImageForDraw() {
    if (!compat || !(envAlpha < 0.999)) return envImg
    const key = envImg.width + 'x' + envImg.height + '@' + envAlpha
    if (envFadeKey !== key) {
      const c = document.createElement('canvas')
      c.width = envImg.width; c.height = envImg.height
      const g = c.getContext('2d'); g.globalAlpha = envAlpha; g.drawImage(envImg, 0, 0)
      envFade = c; envFadeKey = key
    }
    return envFade
  }
  function drawEnvRaster() {
    if (!envImg || !envBBox) return
    const kk = k(), bb = envBBox
    const x0 = WXN(bb.lonMin), w = (bb.lonMax - bb.lonMin) * kk
    const y = PY(bb.latMax), h = (bb.latMax - bb.latMin) * kk
    const img = envImageForDraw()
    ctx.save(); ctx.globalAlpha = img === envImg ? envAlpha : 1
    // 分级填色要看得见硬边界（那条边界就是等值线），故插值开关跟着显示模式走
    const sm = ctx.imageSmoothingEnabled
    ctx.imageSmoothingEnabled = envSmooth
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high'
    for (const off of [-360, 0, 360]) {
      const x = (x0 + off) * kk + tx
      if (x > cw || x + w < 0) continue
      ctx.drawImage(img, x, y, w, h)
    }
    ctx.imageSmoothingEnabled = sm; ctx.globalAlpha = 1; ctx.restore()
  }
  // 环境场等值线（+ 沿线数值标注）：画在场之上，仍压在国界/地名之下
  function drawEnvContours() {
    if (!envContours.length) return
    const iz = Math.sqrt(scale)
    for (const g of envContours) {
      for (const ln of (g.lines || [])) drawPolyline(ln, g.color, Math.max(0.1, (g.width || 1) / Math.max(1, iz * 0.9)))
    }
    for (const g of envContours) {
      if (!g.text) continue
      for (const an of (g.labels || [])) drawText(g.text, an.lon, an.lat, Math.max(7, 11 * (k() / 13.1)), g.labelColor || '#ffffff', { rot: an.a, strokeScale: 0.16 })
    }
  }
  function drawCovGrid() {
    if (!covGridLayers.length) return
    const kk = k()
    const wl = -tx / kk, wr = (cw - tx) / kk
    ctx.save(); ctx.globalAlpha = covGridAlpha
    for (const L of covGridLayers) {
      if (!L.fillPaths || !L.fillPaths.length) continue
      for (const off of [-360, 0, 360]) {
        if (L.bounds && (L.bounds.hi + off < wl || L.bounds.lo + off > wr)) continue
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
        if (compat) for (const fb of (L.fillBands || [])) { ctx.fillStyle = 'rgb(' + fb.color[0] + ',' + fb.color[1] + ',' + fb.color[2] + ')'; traceFillBand(fb); ctx.fill() }
        else for (const fb of L.fillPaths) { ctx.fillStyle = fb.color; ctx.fill(fb.path) }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.restore()
  }
  // GRD 标注层（波束名 / 峰值点 / 数值标签）：画在填充+等值线之上，随各层 bore/segGroups 数据
  function drawFieldOverlays() {
    const o = fieldOpts
    // 覆盖分析(GRD)注记：十字(峰值点)与文字(波束名/峰值/数值)一律按【世界尺寸】联动。
    // 文字为何用世界尺寸：3D 侧这三种标签都由 makeCovLabel(hpx=字号/533) 生成 = 世界尺寸精灵（随缩放线性变化、含每度像素）。
    // 旧实现 2D 文字用「字号 × iz」——既非世界尺寸律(iz=√scale)、又漏掉每度像素 base → 切到 3D 后 2D 明显偏大(默认视角约 2.6×)。
    // 改为与 3D 同源：2D 世界尺寸 px = hpx × 750 × zf(=k()/13.1)，与卫星层数值标签、地名标定完全一致，两视图恒同大。
    const zf = k() / 13.1
    const covFont = (size) => Math.round(size / 533 * 750 * zf)   // 字号(valSize/peakSize/nameSize) → 2D 世界尺寸 px，与 3D makeCovLabel(字号/533) 一致
    for (const L of fieldLayers) {
      if (o.showVal) for (const grp of (L.segGroups || [])) { if (grp.txt == null) continue; for (const an of (grp.labels || [])) drawText(String(grp.txt), an[0], an[1], covFont(o.valSize || 12), '#ffffff') }
      const b = L.bore; if (!b) continue
      // b.hit=false ＝ 峰值方向越过地平（对星壳层视图＝没打到那层壳）：十字与峰值电平一律不画，
      // b.lon/lat 此时只是该方向的地平/相切点，仅作波束名的锚。
      const hit = b.hit !== false
      // 十字全长(px) = 世界尺寸 × 750 × zf = boreSize × BORE_SPAN(0.024, 见 scene.js) × 750 × zf
      // → boreSize × 18 × zf。两视图恒同大；圆点那版走的是「克制版 iz」，与 3D 对不上，一并归位。
      const span = (o.boreSize != null ? o.boreSize : 0.5) * 18 * zf
      const crossOn = o.showBore && hit
      const peakOn = o.showPeak && hit && b.peak != null
      const pf = covFont(o.peakSize || 5), nf = covFont(o.nameSize || 16)
      const lift = (crossOn ? span * 0.5 : 0) + 1.125 * zf     // 让开十字上臂 + 一点空隙
      if (crossOn) cross(b.lon, b.lat, span, '#ffffff')
      // 峰值读数与波束名自上而下码在十字【上方】（SATSOFT 排布：波束名 / 读数 / ＋）；读数只印数字不带单位
      if (peakOn) drawText(b.peak.toFixed(2), b.lon, b.lat, pf, '#cfd6df', { dy: -(lift + pf * 0.5) })
      if (o.showName && L.name) drawText(L.name, b.lon, b.lat, nf, '#ffffff', { dy: -(lift + (peakOn ? pf * 1.15 : 0) + nf * 0.5) })
    }
  }

  // field 之下的底图（海陆/冰盖/网格）。渲到主画布后由 renderStaticLayers 拷到 belowCanvas。
  function drawBelowContent(rx, ry, rw, rh) {
    ctx.save()
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    ctx.fillStyle = oceanColor; ctx.fillRect(rx, ry, rw, rh)
    drawLand(); drawIceCaps()
    ctx.restore()
  }
  // field 之上的标注（省界/标记/国家名/卫星层点标注等）。透明背景，叠在覆盖填充之上。
  // 各类数据线（GXT 波束线/仰角线/轨迹线/聚焦卫星线）不在此层——见 drawDataLines（压在国界省界之下）。
  function drawAboveContent(rx, ry, rw, rh) {
    ctx.save()
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    // 随缩放联动系数：mz=scale（与国家名同率，用于数值/覆盖/卫星层等注记）；scale=1 即当前大小。
    // iz=√scale 是「克制版」联动：点标记/地球站/航迹这类实心图标若按 mz 满速放大，2D 缩放幅度大(可达60×)会膨成大色块，
    // 故按 √scale 缓增——仍随缩放变化、scale=1 时不变，但放大时增长更温和、不至于过大。
    const mz = scale, iz = Math.sqrt(scale)
    // 与 3D 球体标记观感对齐：3D 的文字/圆点精灵都含画布留白（makeCovLabel 字号50→画布高66；dot 直径18的圆居中于32画布），
    // 其屏幕尺寸按整张画布计 → 实际可见的字/点偏小。2D 直接按字号/半径作画、无留白，故乘同等系数收小，两视图一致。
    const MK_FONT_K = 50 / 66      // 文字：3D 实际字高 = 字号 × 50/66 ≈ 0.76
    const DOT3D_FILL = 18 / 32     // 3D 圆点：实心圆占精灵的比例（其余为留白）
    const ST_ICON_K = 0.85         // 地球站图标：2D 观感略大于 3D，收一档对齐（经验系数，可微调）
    // 经纬网 + 行政区界 + 五类边界线画在覆盖填充之上：地理骨架贯穿覆盖区内外，覆盖与底图融为一体（平级），
    // 不再像贴纸浮在上面。次序从下往上：经纬网 → 二级行政区 → 一级行政区 → 海岸 → 主张 → 停火 → 未定 → 国界。
    drawGrid()
    // 缩放分级：全球视角下二级行政区完全淡出、一级降到 0.3（政治五类不参与——国界在任何尺度都在）
    const admF = admFade(borderStyle.fade ? fadeFactor(1 / k()) : 1)
    // 二级行政区界（画在一级之下，一级更醒目）
    if (cityVisible && city && admF.adm2 > 0.01) {
      ctx.globalAlpha = borderStyle.cityOpacity * admF.adm2
      for (const ring of city.borders) drawPolyline(ring, borderStyle.cityColor, borderStyle.cityWidth)
      ctx.globalAlpha = 1
    }
    // 一级行政区界
    if (provVisible && prov) {
      ctx.globalAlpha = borderStyle.provOpacity * admF.adm1
      for (const ring of prov.borders) drawPolyline(ring, borderStyle.provColor, borderStyle.provWidth)
      ctx.globalAlpha = 1
    }
    drawBorders()   // 海岸 → 主张 → 停火 → 未定 → 国界（国界压在最上面）
    // 覆盖数据标注（GXT 波束线本体已移入 drawDataLines：与 GRD 等值线/Polygon 边线同层、压在国界省界之下）
    if (geom) {
      if (sizes.showBore) for (const d of (geom.dots || [])) dot(d.lon, d.lat, Math.max(1, sizes.dotSize) * iz, '#fff')   // GXT 波束中心点：克制版联动
    }
    // 轨迹圆点（折线本体已移入 drawDataLines；圆点大小可调 sizes.trajDot，按克制版 iz 联动）
    const trajR = (sizes.trajDot != null ? sizes.trajDot : 2.5) * iz * (DOT3D_FILL * 2.5 / 2)   // 3D 轨迹点 ×2.5，对齐其可见直径
    for (const t of mk.trajectories) {
      for (const p of (t.pts || [])) dot(p.lon, p.lat, trajR, t.kind === 'flight' ? '#5ad1ff' : '#ff9a5a', true)
    }
    // 点标记 + 地球站（圆点大小可调 sizes.ptDot、图标 sizes.stIcon，按克制版 iz 联动）
    const si = sizes.stIcon * iz * ST_ICON_K, ptR = (sizes.ptDot != null ? sizes.ptDot : 3.5) * iz * (DOT3D_FILL * 2.2 / 2)   // 3D 点标记 ×2.2，对齐其可见直径
    for (const p of mk.points) dot(p.lon, p.lat, ptR, '#ffd24a', true)
    for (const s of mk.stations) { const x = PX(s.lon), y = PY(s.lat); if (stationReady) ctx.drawImage(stationImg, x - si / 2, y - si, si, si); else dot(s.lon, s.lat, ptR, '#cfeaff', true) }
    // 地名层：字号随缩放联动，且与 3D 球体的「世界尺寸」地名严格一致。
    // 原理：3D 地名是世界尺寸（固定地理度数），其屏幕 px = 地理度数 × 每度像素。2D 同覆盖下每度像素 = k()。
    // 故 2D 字号 = 地理度数 × k()。标定：3D 普通省名 hpx=0.02→1.146°，对应 2D 基准 l.px=15 → 系数 k()/13.1。
    // 这样把"每度像素"折进 zf：font = l.px × 倍率 × (k()/13.1)，与窗口尺寸无关、与 3D 一致。
    // 标记/波束/数值/覆盖/卫星层等注记文字：随缩放联动（乘 mz=scale，scale=1 即当前大小，与国家名同率缩放）；
    // 卫星图标改按 mz 联动（与卫星名标签同率缩放，避免图标/标签缩放不一致），不同于地球站/点标记的克制版 iz。
    const ns = sizes.nameScale || 1, zf = k() / 13.1
    if (nameMode !== 'off') {
      ctx.globalAlpha = labelStyle.countryOpacity
      for (const l of clabels) drawText(nameMode === 'en' ? l.en : l.zh, l.lon, l.lat, Math.round(l.px * ns * zf), labelStyle.countryColor)
      ctx.globalAlpha = 1   // 大洋名维持固有蓝与不透明度
      for (const [zh, en, lon, lat] of OCEANS) drawText(nameMode === 'en' ? en : zh, lon, lat, Math.round(15 * ns * zf), OCEAN_FILL, { italic: true })
    }
    if (cityVisible && city) {
      const cs = sizes.cityScale || 1
      ctx.globalAlpha = labelStyle.cityOpacity
      for (const l of city.labels) drawText(l.name, l.lon, l.lat, Math.round(l.px * cs * zf), labelStyle.cityColor, { strokeScale: 0.07, strokeMin: 0.8 })
      ctx.globalAlpha = 1
    }
    if (provVisible && prov) {
      const ps = sizes.provScale || 1
      ctx.globalAlpha = labelStyle.provOpacity
      for (const l of prov.labels) drawText(l.name, l.lon, l.lat, Math.round(l.px * ps * zf), labelStyle.provColor, { strokeScale: 0.09, strokeMin: 1.0 })
      ctx.globalAlpha = 1
    }
    if (geom) {   // GXT 覆盖图标签（波束名/数值）：克制版联动 iz
      for (const l of (geom.labels || [])) drawText(l.text, l.lon, l.lat, Math.round((l.hpx || 0.03) * 533 * iz), l.color || '#fff')
    }
    // 坐标在圆点上方、仰角在下方：与 3D 侧 setMarkers 的 sprite center.y（-0.35 / 1.35）同口径。
    // 换算：sprite 屏幕高 H = pf / MK_FONT_K，字在其中垂直居中，center.y = c 时字心距锚点 (0.5 - c)·H；
    // 2D textBaseline='middle'，dy 即字心偏移，canvas 向上为负 → dy = ∓(0.5 - c)·H = ∓0.85·H。
    // 点标记是用户点/拖出来的，标签在下方会被鼠标指针（箭头本体在热点右下）当场压住。
    const MK_UP = 0.85 / MK_FONT_K   // ≈1.122：字心到锚点的距离 ÷ 字高
    for (const p of mk.points) {
      const pf = sizes.ptFont * iz * MK_FONT_K   // 点标记文字：×MK_FONT_K 与 3D 字高对齐（与图标同用克制版 iz）
      drawText(p.label, p.lon, p.lat, pf, '#ffffff', { dy: -pf * MK_UP })
      if (p.el) drawText(p.el, p.lon, p.lat, pf * 0.9, '#ffffff', { dy: pf * 0.9 * MK_UP })   // 聚焦卫星仰角：亮白，标记下方
    }
    for (const s of mk.stations) {
      const sf = sizes.stFont * iz * MK_FONT_K   // 地球站文字：×MK_FONT_K 与 3D 字高对齐（与图标同用克制版 iz）
      drawText(s.name, s.lon, s.lat, sf, '#ffffff', { dy: sf * 0.5 + 0.5 * iz })
      if (s.el) drawText(s.el, s.lon, s.lat, sf * 0.9, '#ffffff', { dy: sf * 1.5 + 3.5 * iz })   // 聚焦卫星仰角：亮白
    }
    // 卫星 / 仰角线独立图层：等仰角线 + 卫星图标 + 名称（在覆盖/标记之上、聚焦图标之下）
    if (satLayer) {
      // 卫星层所有线（Polygon 边线随 drawSatPolyLines、仰角线等随 drawDataLines）均画在 below/above 之间
      // → 压在国界/省界/地名之下，与之共存；这里只画点/标签/卫星图标
      // d.px：屏幕恒定像素半径（Polygon 顶点手柄，不随缩放变大）；否则沿用世界联动尺寸
      for (const d of (satLayer.dots || [])) {
        const dx = PX(d.lon), dy2 = PY(d.lat)   // 视口外剔除：波束合成大群（数百点）放大后大多在屏外，逐点画纯浪费
        if (dx < -24 || dx > cw + 24 || dy2 < -24 || dy2 > ch + 24) continue
        dot(d.lon, d.lat, d.px != null ? Math.max(1, d.px) : Math.max(2, d.r != null ? d.r : 4) * mz, hex(d.color != null ? d.color : 0xffd27a), true)
      }
      for (const l of (satLayer.labels || [])) {   // 世界尺寸字号：与 3D makeCovLabel 同源（套用地名标定 hpx0.02↔px15，zf=k()/13.1），2D/3D 一致
        const px = Math.round((l.hpx || 0.026) * 750 * zf)
        if (l.cullPx && px < l.cullPx) continue    // 自适应编号：小于可读下限的糊点直接不画（缩小看大群时天量文字全免）
        const lx2 = PX(l.lon), ly2 = PY(l.lat)
        const mw = px * (String(l.text == null ? '' : l.text).length * 0.4 + 1)
        if (lx2 < -mw || lx2 > cw + mw || ly2 < -px || ly2 > ch + px) continue   // 视口外剔除（含文字宽裕量）
        drawText(l.text, l.lon, l.lat, px, l.color || '#fff')
      }
      for (const s of (satLayer.sats || [])) { if (s.lon == null || s.lat == null || s.iconShow === false) continue; drawSatIcon(s.lon, s.lat, (s.iconSize || sizes.satIcon || 30) * mz * SAT_ICON_K, hex(s.color != null ? s.color : 0xffd27a)) }   // 颜色/大小随各星设置；图标按 mz 联动，与卫星名标签同率缩放；iconShow 单独控制显隐
      for (const s of (satLayer.sats || [])) {
        if (!s.name || s.lon == null || s.lat == null || s.labelShow === false) continue
        const ls = (s.labelSize || 9) * mz
        // 名称紧贴图标：间隙=0，只留图标半高的偏移（无图标时名称直接锚在星位置）
        drawText(s.name, s.lon, s.lat, ls, hex(s.color != null ? s.color : 0xffd27a), { dy: -(s.iconShow !== false ? (s.iconSize || sizes.satIcon || 30) * mz * SAT_ICON_K * 0.5 : 0) })
      }
    }
    ctx.restore()
  }
  // 重建两张静态快照：分别渲到主画布再拷到离屏缓冲（below 不透明含底色；above 透明叠加）。
  function renderStaticLayers() {
    const rx = PX(LON0), ry = PY(90), rw = 360 * k(), rh = 180 * k()
    const bw = belowCanvas.width, bh = belowCanvas.height
    // below：海陆/冰盖/网格（含背景底色）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = BG; ctx.fillRect(0, 0, cw, ch)
    drawBelowContent(rx, ry, rw, rh)
    belowCtx.setTransform(1, 0, 0, 1, 0, 0); belowCtx.clearRect(0, 0, bw, bh); belowCtx.drawImage(canvas, 0, 0)
    // above：省界/覆盖数据/标记/国家名/卫星层（透明）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch)
    drawAboveContent(rx, ry, rw, rh)
    aboveCtx.setTransform(1, 0, 0, 1, 0, 0); aboveCtx.clearRect(0, 0, bw, bh); aboveCtx.drawImage(canvas, 0, 0)
  }

  // Polygon 区域填充：画在 GRD 覆盖场之前（叠加规则 2D/3D 统一：叠加区只显示覆盖图颜色，
  // Polygon 在该处只剩边线——边线由 drawSatPolyLines 画在覆盖之后）。100% 不透明也不遮国界/地名
  // （above 层在其后）。填充用世界度坐标（x=WXN 就近解缠, y=90-lat），±360 环绕副本各填一份
  // （跨东经 180° 无缝），调用方已裁剪到地图矩形。实时走 Path2D + 变换矩阵；导出 compat 模式
  // （svgcanvas 忽略 Path2D）改屏幕坐标子路径回放，与陆地/覆盖填充同策略。
  function drawSatFills() {
    if (!satLayer) return
    const kk = k()
    ctx.save()
    for (const f of (satLayer.fills || [])) {
      if (!f.p || f.p.length < 3) continue
      const W = []
      let prev = WXN(f.p[0][0]), lo = prev, hi = prev
      W.push([prev, 90 - f.p[0][1]])
      for (let i = 1; i < f.p.length; i++) {
        let wx = WXN(f.p[i][0])
        while (wx - prev > 180) wx -= 360
        while (wx - prev < -180) wx += 360
        if (wx < lo) lo = wx
        if (wx > hi) hi = wx
        W.push([wx, 90 - f.p[i][1]]); prev = wx
      }
      let path = null
      if (!compat) {
        path = new Path2D()
        path.moveTo(W[0][0], W[0][1])
        for (let i = 1; i < W.length; i++) path.lineTo(W[i][0], W[i][1])
        path.closePath()
      }
      ctx.fillStyle = hex(f.color); ctx.globalAlpha = f.opacity != null ? f.opacity : 0.18
      for (const s of [-360, 0, 360]) {
        if (hi + s < 0 || lo + s > 360) continue   // 该副本完全在地图外 → 跳过
        if (compat) {
          ctx.beginPath()
          ctx.moveTo((W[0][0] + s) * kk + tx, W[0][1] * kk + ty)
          for (let i = 1; i < W.length; i++) ctx.lineTo((W[i][0] + s) * kk + tx, W[i][1] * kk + ty)
          ctx.closePath(); ctx.fill()
        } else {
          ctx.save(); ctx.translate(tx + s * kk, ty); ctx.scale(kk, kk); ctx.fill(path); ctx.restore()
        }
      }
    }
    ctx.restore()
  }
  // Polygon 边线（under:true 的线）：画在 GRD 覆盖之后（叠加区仍可见）、above 层之前（被国界/地名
  // 压在下面）
  function drawSatPolyLines() {
    if (!satLayer) return
    for (const ln of (satLayer.lines || [])) if (ln.under && ln.p && ln.p.length > 1) drawPolyline(ln.p, hex(ln.color != null ? ln.color : 0x66ddff), Math.max(0.1, ln.width || 1.4))
  }
  // 数据线统一层（GXT 波束线 / 仰角线等卫星层线 / 轨迹折线 / 聚焦卫星足迹与轨迹）：与 GRD 等值线、
  // Polygon 边线同一画法同一层——画在覆盖之上、above 快照（国界/省界/市界/地名）之下 → 与国界省界共存，
  // 边界压在线上仍清晰可见。各线的圆点/标签仍留在 above 层或顶层（属标注，不遮边界线）。
  function drawDataLines() {
    if (geom) for (const ln of (geom.lines || [])) if (ln.p && ln.p.length > 1) drawPolyline(ln.p, hex(ln.color), Math.max(0.1, ln.width || 1.6))
    for (const t of mk.trajectories) if (t.pts && t.pts.length > 1) drawPolyline(t.pts, hex(t.color != null ? t.color : 0xff5a5a), 2.2)
    if (satLayer) for (const ln of (satLayer.lines || [])) if (!ln.under && ln.p && ln.p.length > 1) drawPolyline(ln.p, hex(ln.color != null ? ln.color : 0x66ddff), Math.max(0.1, ln.width || 1.4))   // 下限 0.1：跟随全库统一的线粗最细档
    // 聚焦卫星几何（实时，不入快照）：覆盖范围 + 星下点轨迹，样式与 3D 球体同一份设置；多选=每颗都画
    const sa = ctx.globalAlpha
    for (const g of selGeomList) {
      if (focusCfg.fpOn && g.footprint && g.footprint.length > 1) {
        ctx.globalAlpha = sa * Math.max(0, Math.min(1, focusCfg.fpOpacity))
        drawPolyline(g.footprint, focusCfg.fpColor, Math.max(0.1, focusCfg.fpWidth), false, DASH_2D[focusCfg.fpDash] || null)
      }
      if (focusCfg.trkOn && g.track && g.track.length > 1) {
        ctx.globalAlpha = sa * Math.max(0, Math.min(1, focusCfg.trkOpacity))
        drawPolyline(g.track, focusCfg.trkColor, Math.max(0.1, focusCfg.trkWidth), false, DASH_2D[focusCfg.trkDash] || null)
      }
    }
    ctx.globalAlpha = sa
  }
  // 覆盖圈填充（与 Polygon 区域填充同一层band：画在 GRD 覆盖场之前）。世界度坐标 + ±360 环绕副本，
  // 与 drawSatFills 同策略；★足迹可以套住极点（极轨星过极区就是），此时解缠后经度跨满 360° 且首尾不闭合
  //   —— 必须补两点收到极点边上，否则 canvas 自动收口成一条横穿地图的直边、填出一块假区域。
  function drawFocusFills() {
    if (!focusCfg.fpOn || !(focusCfg.fpFillOpacity > 0)) return
    const kk = k()
    ctx.save()
    ctx.fillStyle = focusCfg.fpFillColor; ctx.globalAlpha = Math.max(0, Math.min(1, focusCfg.fpFillOpacity))
    for (const g of selGeomList) {
      const ring = g.footprint
      if (!ring || ring.length < 3) continue
      const W = []
      let prev = WXN(ring[0].lon), lo = prev, hi = prev, latSum = 0
      W.push([prev, 90 - ring[0].lat]); latSum += ring[0].lat
      for (let i = 1; i < ring.length; i++) {
        let wx = WXN(ring[i].lon)
        while (wx - prev > 180) wx -= 360
        while (wx - prev < -180) wx += 360
        if (wx < lo) lo = wx
        if (wx > hi) hi = wx
        W.push([wx, 90 - ring[i].lat]); prev = wx; latSum += ring[i].lat
      }
      // 绕极判据：解缠后首尾经度差满一圈（足迹环按方位等分生成，绕极时必然单调走满 360°）
      if (Math.abs(W[W.length - 1][0] - W[0][0]) > 300) {
        const north = g.sub && Number.isFinite(g.sub.lat) ? g.sub.lat >= 0 : latSum >= 0
        const py = north ? 0 : 180   // y = 90 - lat
        W.push([W[W.length - 1][0], py], [W[0][0], py])
      }
      for (const s of [-360, 0, 360]) {
        if (hi + s < 0 || lo + s > 360) continue   // 该副本完全在地图外 → 跳过
        ctx.beginPath()
        ctx.moveTo((W[0][0] + s) * kk + tx, W[0][1] * kk + ty)
        for (let i = 1; i < W.length; i++) ctx.lineTo((W[i][0] + s) * kk + tx, W[i][1] * kk + ty)
        ctx.closePath(); ctx.fill()
      }
    }
    ctx.restore()
  }
  // 聚焦卫星星下点图标（最上层）：按 iz=√scale 克制联动（与 2D 导出/地球站/航迹一致，防止高倍放大时
  // 膨大、更贴 3D）；多选=每颗各一个。大小/颜色取聚焦设置，单点可用 px/colorHex 覆盖（对星分析用）。
  function drawFocusIcons() {
    if (!focusCfg.subOn) return
    const iz = Math.sqrt(scale) * SAT_ICON_K
    // ★ 颗数多时改画实心点：卫星图形是十来个圆角矩形，canvas 上实测 30~60 µs/个 —— 三千颗一次重绘就是
    //   100 ms 以上，平移/缩放会拖住整张图；而那个密度下图形本身也糊成一团。点保留位置与颜色，
    //   一颗都不丢（3D 端已合批成贴图点层，不受此限）。
    const dotMode = focusSats.length > 300
    for (const p of focusSats) {
      const px = Number(p.px) > 0 ? Number(p.px) : focusCfg.subPx
      const color = p.color || focusCfg.subColor
      if (dotMode) {
        const r = Math.max(1, px * iz * 0.14)
        ctx.beginPath(); ctx.arc(PX(p.lon), PY(p.lat), r, 0, Math.PI * 2)
        ctx.fillStyle = color; ctx.fill()
        ctx.lineWidth = Math.max(0.6, r * 0.5); ctx.strokeStyle = 'rgba(8,12,18,0.92)'; ctx.stroke()
      } else drawSatIcon(p.lon, p.lat, px * iz, color)
    }
  }

  function draw() {
    if (cw < 2 || ch < 2 || !belowCanvas) return
    if (!staticValid) { renderStaticLayers(); staticValid = true }
    const bw = belowCanvas.width, bh = belowCanvas.height
    const rx = PX(LON0), ry = PY(90), rw = 360 * k(), rh = 180 * k()
    // 复合：blit below（不透明）→ Polygon 填充 + 覆盖填充/线（夹在中间）→ blit above（透明）→ 覆盖标注 → 聚焦星
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, bw, bh); ctx.drawImage(belowCanvas, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    drawTerminator()     // 夜区遮罩 + 晨昏线（最底：是「打光」不是数据，只压暗底图、不蒙灰数据层）
    drawEnvRaster()      // ITU 环境场栅格（气象/地形是背景量，谁都压得住它）
    drawEnvContours()    // 环境场等值线 + 数值标注（紧跟其场，不与覆盖层混层）
    drawSatFills()       // Polygon 区域填充（覆盖场之下：叠加区只显示覆盖图颜色）
    drawFocusFills()     // 聚焦卫星覆盖圈填充（同上一层band，紧跟 Polygon 填充）
    drawCovGrid()        // STK Coverage FOM 热力图（Polygon 填充之上、GRD 覆盖场之下）
    drawField()          // GRD 覆盖填充面 + 等值线（在底图/Polygon 填充之上、标注之下）
    drawSatPolyLines()   // Polygon 边线（覆盖之上、国界/地名之下：叠加区仍见边线）
    drawDataLines()      // 波束线/仰角线/轨迹线/聚焦卫星线（同上：覆盖之上、国界省界之下，与边界共存）
    ctx.restore()
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(aboveCanvas, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    drawFieldOverlays()   // GRD 波束名/峰值点/数值标签（覆盖层之上）
    drawFocusIcons()      // 聚焦卫星星下点图标（最上层）
    ctx.restore()
  }

  // ---- 缩放进度（底部状态栏进度条）：scale[0.9,60] 对数映射到 t∈[0,1]，t=0 缩小到底、t=1 放大到底。
  // 对数映射 → 进度条每格的缩放倍率恒定，放大时绝对步进更细，支持精细化缩放。
  const SMIN = 0.9, SMAX = 60, _lnS0 = Math.log(SMIN), _lnS1 = Math.log(SMAX)
  const scaleToT = () => (Math.log(scale) - _lnS0) / (_lnS1 - _lnS0)
  let onZoom = null
  // ---- 交互 ----
  function onWheel(e) {
    e.preventDefault()
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top
    const kk = k(), wx = (mx - tx) / kk, wy = (my - ty) / kk
    scale = clamp(scale * Math.exp(-e.deltaY * 0.0015), SMIN, SMAX)
    const k2 = k(); tx = mx - wx * k2; ty = my - wy * k2; invalidateStatic(); requestDraw()
    if (onZoom) onZoom(scaleToT())
  }
  // 进度条设缩放：绕画布中心缩放（锚定中心世界点），t∈[0,1]
  function setZoomT(t) {
    const mx = cw / 2, my = ch / 2, kk = k(), wx = (mx - tx) / kk, wy = (my - ty) / kk
    scale = clamp(Math.exp(_lnS0 + Math.max(0, Math.min(1, t)) * (_lnS1 - _lnS0)), SMIN, SMAX)
    const k2 = k(); tx = mx - wx * k2; ty = my - wy * k2; invalidateStatic(); requestDraw()
  }
  let dragging = false, lx = 0, ly = 0
  let beamDragMode = false, onBeamDrag = null, beamDragging = false   // 拖拽波束（不平移地图）
  let labelDragMode = false, onLabelDrag = null, labelDragging = false   // 拖拽等值线数值标签（沿线滑动，不平移地图）
  // 协调区多边形 hold-to-draw：绘制态下左键按住沿路径拖动，按屏幕像素阈值连续加点（不平移地图）。
  // 回调 onPolyDraw(lonlat, 'start'|'move'|'end')；右键加点（onRightClick）仍并存。
  let polyDrawMode = false, onPolyDraw = null, polyDrawing = false, drawLX = 0, drawLY = 0
  const POLY_DRAW_MIN2 = 14 * 14   // 相邻加点最小屏幕间距²（px）：按住走一段才落一个点
  // 顶点编辑（Polygon 调整顶点 / 整体拖动）：editVerts={ pts:[[lon,lat],...], px, move }。
  //  - move=false：按下命中半径内的顶点即拖动该点（回调 onVertexDrag(index, lonlat, 'start'|'move'|'end')）；
  //  - move=true：按下落在多边形内部即整体拖动（回调 onPolyMove(dlon, dlat, 'start'|'move'|'end')，增量制）。
  // 未命中则照常平移地图。
  let editVerts = null, onVertexDrag = null, vertDragging = -1
  let onPolyMove = null, moveDragging = false, moveLast = null
  // 放置模式（波束合成）：左键点击落点（按下武装 → 拖过阈值解除=平移 → 原地抬起触发 onPlace）
  let placeMode = false, onPlace = null, placeArmed = false, placeSX = 0, placeSY = 0
  // 框选模式（站点栅编辑）：左键拖矩形。'start'/'move' 回屏幕像素（页面画橡皮筋），'end' 回两角经纬（夹到地图边）；
  // 原地点击（未拖过阈值）'end' 回 null＝清选。框选期间不平移。
  let boxMode = false, onBoxSelect = null, boxDragging = false, boxSX = 0, boxSY = 0
  function vertexAt(clientX, clientY) {
    if (!editVerts || !editVerts.pts || !editVerts.pts.length) return -1
    const r = canvas.getBoundingClientRect()
    const mx = clientX - r.left, my = clientY - r.top
    let best = -1, bd = Math.max(7, (editVerts.px || 3) + 5)   // 命中半径：顶点半径+5px、下限 7px
    editVerts.pts.forEach((p, i) => {
      const d = Math.hypot(PX(p[0]) - mx, PY(p[1]) - my)
      if (d < bd) { bd = d; best = i }
    })
    return best
  }
  // 屏幕坐标是否落在编辑多边形内（射线法，投影后逐边判交）
  function pointInEditPoly(clientX, clientY) {
    if (!editVerts || !editVerts.pts || editVerts.pts.length < 3) return false
    const r = canvas.getBoundingClientRect()
    const mx = clientX - r.left, my = clientY - r.top
    const pts = editVerts.pts; let inside = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = PX(pts[i][0]), yi = PY(pts[i][1]), xj = PX(pts[j][0]), yj = PY(pts[j][1])
      if ((yi > my) !== (yj > my) && mx < (xj - xi) * (my - yi) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
  function onDown(e) {
    if (editVerts && e.button === 0) {
      if (editVerts.move) {
        if (pointInEditPoly(e.clientX, e.clientY)) {
          moveDragging = true; canvas.setPointerCapture(e.pointerId)
          moveLast = screenToLonLat(e.clientX, e.clientY)
          if (onPolyMove) onPolyMove(0, 0, 'start')
          return
        }
      } else {
        const vi = vertexAt(e.clientX, e.clientY)
        if (vi >= 0) { vertDragging = vi; canvas.setPointerCapture(e.pointerId); const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onVertexDrag) onVertexDrag(vi, ll, 'start'); return }
      }
    }
    if (polyDrawMode && e.button === 0) {   // 绘制态：左键按住起笔，沿路径连续加点
      polyDrawing = true; canvas.setPointerCapture(e.pointerId)
      drawLX = e.clientX; drawLY = e.clientY
      const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onPolyDraw) onPolyDraw(ll, 'start')
      return
    }
    if (beamDragMode && e.button === 0) { beamDragging = true; canvas.setPointerCapture(e.pointerId); const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onBeamDrag) onBeamDrag(ll, 'start'); return }
    if (labelDragMode && e.button === 0) { labelDragging = true; canvas.setPointerCapture(e.pointerId); const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onLabelDrag) onLabelDrag(ll, 'start'); return }
    if (boxMode && e.button === 0) {   // 框选：起框并捕获（不平移）
      boxDragging = true; boxSX = e.clientX; boxSY = e.clientY
      canvas.setPointerCapture(e.pointerId)
      if (onBoxSelect) onBoxSelect('start', { x0: boxSX, y0: boxSY, x1: boxSX, y1: boxSY })
      return
    }
    if (placeMode && e.button === 0) { placeArmed = true; placeSX = e.clientX; placeSY = e.clientY }   // 武装放置（不 return：拖动仍平移）
    // 仅左键平移并夺指针捕获。右键/中键只用于 contextmenu（Polygon 加点 / 右键菜单）——若在此为右键 setPointerCapture，
    // 其 pointerup 会被 preventDefault 的 contextmenu 手势吞掉（Chromium 行为），捕获永不释放，此后点任何输入框都被
    // canvas 截走 → 「画完 Polygon 后输入框不能聚焦」。故非左键直接返回，绝不捕获。
    if (e.button !== 0) return
    dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'
  }
  function onMove(e) {
    if (boxDragging) {
      if (onBoxSelect) onBoxSelect('move', { x0: boxSX, y0: boxSY, x1: e.clientX, y1: e.clientY })
      if (onHover) onHover(screenToLonLat(e.clientX, e.clientY))
      return
    }
    if (placeArmed && Math.abs(e.clientX - placeSX) + Math.abs(e.clientY - placeSY) > 6) placeArmed = false   // 拖过阈值 → 是平移不是点击
    if (moveDragging) {
      const ll = screenToLonLat(e.clientX, e.clientY)
      if (ll && moveLast && onPolyMove) {
        let dlon = ll.lon - moveLast.lon; dlon = ((dlon + 540) % 360) - 180   // 跨 ±180° 取短路增量
        onPolyMove(dlon, ll.lat - moveLast.lat, 'move'); moveLast = ll
      }
    }
    else if (vertDragging >= 0) { const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onVertexDrag) onVertexDrag(vertDragging, ll, 'move') }
    else if (beamDragging) { const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onBeamDrag) onBeamDrag(ll, 'move') }
    else if (labelDragging) { const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onLabelDrag) onLabelDrag(ll, 'move') }
    else if (polyDrawing) {   // 绘制态：光标每移过阈值距离落一个点
      const dx = e.clientX - drawLX, dy = e.clientY - drawLY
      if (dx * dx + dy * dy >= POLY_DRAW_MIN2) { drawLX = e.clientX; drawLY = e.clientY; const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onPolyDraw) onPolyDraw(ll, 'move') }
    }
    else if (dragging) { tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; invalidateStatic(); requestDraw() }
    else if (editVerts) {   // 悬停提示：可拖顶点 / 可拖多边形内部（cursor 可覆盖命中态提示，如删除模式用 'pointer' 而非 'move'）
      canvas.style.cursor = (editVerts.move ? pointInEditPoly(e.clientX, e.clientY) : vertexAt(e.clientX, e.clientY) >= 0) ? (editVerts.cursor || 'move') : 'grab'
    }
    if (onHover) onHover(screenToLonLat(e.clientX, e.clientY))   // 实时经纬度（拖拽时也更新）
  }
  function onUp(e) {
    if (boxDragging) {
      boxDragging = false
      if (e && onBoxSelect) {
        const moved = Math.abs(e.clientX - boxSX) + Math.abs(e.clientY - boxSY) > 6
        const add = !!(e.ctrlKey || e.metaKey)   // Ctrl/⌘ = 累加（框选并入 / 点击增减）
        onBoxSelect('end', moved ? { a: screenToLonLatClamp(boxSX, boxSY), b: screenToLonLatClamp(e.clientX, e.clientY), add } : { add, at: screenToLonLatClamp(boxSX, boxSY) })   // 原地点击带落点：命中站点=单选
      } else if (onBoxSelect) onBoxSelect('end', null)
    }
    if (placeArmed) { placeArmed = false; const ll = screenToLonLat(placeSX, placeSY); if (ll && onPlace) onPlace(ll) }   // 原地抬起 = 点击放置
    if (vertDragging >= 0 && onVertexDrag) onVertexDrag(null, null, 'end')
    if (moveDragging && onPolyMove) onPolyMove(0, 0, 'end')
    if (beamDragging && onBeamDrag) onBeamDrag(null, 'end')
    if (labelDragging && onLabelDrag) onLabelDrag(null, 'end')
    if (polyDrawing && onPolyDraw) onPolyDraw(null, 'end')
    dragging = false; beamDragging = false; labelDragging = false; vertDragging = -1; moveDragging = false; moveLast = null; polyDrawing = false
    canvas.style.cursor = (polyDrawMode || placeMode) ? 'crosshair' : ((beamDragMode || labelDragMode) ? 'move' : 'grab')
    // 显式释放指针捕获（不只依赖 pointerup 的隐式释放）：pointercancel / 抬起点在画布外等边角情形下隐式释放可能不发生，
    // 残留捕获会把之后所有点击截给 canvas，导致输入框点不进。有 e.pointerId 就按其释放，无（onLeave 调用）则整体兜底。
    try {
      if (e && e.pointerId != null) { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId) }
    } catch { /* ignore */ }
  }
  function onLeave() { placeArmed = false; onUp(); if (onHover) onHover(null) }       // 移出地图：清空读数（放置武装作废，避免离屏误落点）
  function onDbl() { fit(); invalidateStatic(); requestDraw(); if (onZoom) onZoom(scaleToT()) }
  // 屏幕坐标 -> 经纬度（夹到地图边缘，框选角点用：框拖出地图外也取有效角）
  function screenToLonLatClamp(clientX, clientY) {
    const r = canvas.getBoundingClientRect(), kk = k()
    const wx = (clientX - r.left - tx) / kk
    const wy = Math.max(0, Math.min(180, (clientY - r.top - ty) / kk))
    let lon = wx + LON0; lon = ((lon % 360) + 540) % 360 - 180
    return { lat: 90 - wy, lon }
  }
  // 屏幕坐标 -> 经纬度（投影逆运算）；超出地图范围返回 null
  function screenToLonLat(clientX, clientY) {
    const r = canvas.getBoundingClientRect(), kk = k()
    const wx = (clientX - r.left - tx) / kk, wy = (clientY - r.top - ty) / kk
    if (wy < 0 || wy > 180) return null
    let lon = wx + LON0; lon = ((lon % 360) + 540) % 360 - 180
    return { lat: 90 - wy, lon }
  }
  let onRightClick = null, onHover = null
  function onCtx(e) { e.preventDefault(); if (onRightClick) onRightClick(screenToLonLat(e.clientX, e.clientY), { x: e.clientX, y: e.clientY }) }
  // 放置模式（波束合成）：左键「点击」（按下→未拖动→抬起）回调 onPlace(ll)；拖动仍平移地图。
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)   // 指针被系统取消（如触控/被抢占）：同样跑清理，释放捕获、复位拖拽状态
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('dblclick', onDbl)
  canvas.addEventListener('contextmenu', onCtx)
  canvas.style.cursor = 'grab'

  // 一级行政区数据（与 3D setProvinces 同款格式）。★ 可反复调用：多选国家时上层并成一份重新喂进来。
  function setProvinces(data) {
    prov = data ? { borders: data.borders || [], labels: (data.labels || []).map((l) => ({ name: l.name, lon: l.lon, lat: l.lat, px: l.px2d != null ? l.px2d : 15 })) } : null
    invalidateStatic(); requestDraw()
  }

  // 二级行政区数据（同上）。地名密集 → 基准 px 偏小（小空间）
  function setCities(data) {
    city = data ? { borders: data.borders || [], labels: (data.labels || []).map((l) => ({ name: l.name, lon: l.lon, lat: l.lat, px: l.px2d != null ? l.px2d : 11 })) } : null
    invalidateStatic(); requestDraw()
  }

  return {
    setGeom(g) { geom = g; invalidateStatic(); requestDraw() },
    // GRD 覆盖多层：layers=[{fillBands:[{color:[r,g,b], verts:Float64Array[x,y,...], counts:Int32Array}]|null, segGroups:[...]}]；
    // opts={alpha}。setField 时把每层 fillBands 烘成各档世界坐标 Path2D 缓存（fillPaths），draw 只设变换矢量填充。整体替换。
    setField(layers, opts) {
      fieldLayers = (layers || []).map((L) => ({ ...L, fillPaths: L.fillBands ? buildFillPaths(L.fillBands) : null, segPaths: L.segGroups ? buildSegPaths(L.segGroups) : null, bounds: layerBounds(L) }))
      if (opts) { if (opts.alpha != null) fieldAlpha = opts.alpha; fieldOpts = { ...fieldOpts, ...opts } }
      requestDraw()
    },
    // 拖拽热路径：只替换给定层（聚焦天线各波束，按 id 匹配），其余层缓存的 fillPaths 原样保留 → 不再每帧全量重建。
    patchField(layers, opts) {
      if (opts) { if (opts.alpha != null) fieldAlpha = opts.alpha; fieldOpts = { ...fieldOpts, ...opts } }
      for (const L of (layers || [])) {
        const entry = { ...L, fillPaths: L.fillBands ? buildFillPaths(L.fillBands) : null, segPaths: L.segGroups ? buildSegPaths(L.segGroups) : null, bounds: layerBounds(L) }
        const i = L.id != null ? fieldLayers.findIndex((x) => x.id === L.id) : -1
        if (i >= 0) fieldLayers[i] = entry; else fieldLayers.push(entry)
      }
      requestDraw()
    },
    setFieldAlpha(a) { fieldAlpha = a; requestDraw() },   // 仅覆盖层透明度，静态快照不变
    // STK Coverage 覆盖分析【专用通道】：layer={fillBands:[{color:[r,g,b],verts,counts}]}, opts={alpha}。整体替换（单层）。
    // ---- 环境场（ITU 气象/地形栅格 + 等值线）----
    // img = 等经纬位图（canvas/ImageBitmap），bbox = 其覆盖的经纬范围；smooth=false 走最近邻（分级填色看硬边界）
    setEnvRaster(img, opts) {
      const o = opts || {}
      envImg = img || null
      envBBox = img ? (o.bbox || { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }) : null
      if (o.alpha != null) envAlpha = o.alpha
      if (o.smooth != null) envSmooth = !!o.smooth
      envFadeKey = ''   // 图变了 → 导出用的烘透明度副本作废
      requestDraw()
    },
    setEnvAlpha(a) { envAlpha = a; envFadeKey = ''; requestDraw() },
    setEnvContours(groups) { envContours = Array.isArray(groups) ? groups : []; requestDraw() },
    clearEnv() { envImg = null; envBBox = null; envContours = []; envFadeKey = ''; requestDraw() },
    // ---- 晨昏线 / 夜区 ----
    // date = UTC 时刻（跟随时间轴，非系统时钟）；传 null 清层。opts 同 3D：
    // { night, line, nightColor, nightOpacity, lineColor, lineWidth, lineOpacity, steps }
    // 采样起点钉在 LON0（地图接缝）—— 否则夜区多边形横跨接缝、填充被撕成两半。
    // steps 默认 1440（0.25°/段）：平面图能放大到 60×，360 段（1°/段）在高倍下会看出折线棱角。
    // 逐帧只是 1440 次 lineTo，与覆盖分带填充比可忽略，故直接给足而不做自适应。
    setTerminator(date, opts) {
      if (opts) termOpts = { ...termOpts, ...opts }
      termData = date ? terminatorFlat(date, { steps: (termOpts.steps || 1440), lon0: LON0 }) : null
      requestDraw()
    },
    clearTerminator() { termData = null; requestDraw() },
    setCovGrid(layer, opts) {
      covGridLayers = (layer && layer.fillBands && layer.fillBands.length) ? [{ ...layer, fillPaths: buildFillPaths(layer.fillBands), bounds: layerBounds(layer) }] : []
      if (opts && opts.alpha != null) covGridAlpha = opts.alpha
      requestDraw()
    },
    clearCovGrid() { covGridLayers = []; requestDraw() },
    setCovGridAlpha(a) { covGridAlpha = a; requestDraw() },
    setSizes(s) { Object.assign(sizes, s || {}); invalidateStatic(); requestDraw() },
    setNameMode(m) { nameMode = m; invalidateStatic(); requestDraw() },
    setProvinces,
    setProvincesVisible(v) { provVisible = !!v; invalidateStatic(); requestDraw() },
    setCities,
    setCitiesVisible(v) { cityVisible = !!v; invalidateStatic(); requestDraw() },
    // 国界/省界线样式（与 3D 同步）：{ natColor, natWidth, natOpacity, provColor, provWidth, provOpacity }
    setBorderStyle(s) {
      const reDash = s && Object.keys(s).some((k) => /Dash$/.test(k))
      Object.assign(borderStyle, s || {})
      if (reDash) borderPaths = null   // 线型换了要重烘（虚线图案本身不入 path，但这里顺手清一次最省心）
      invalidateStatic(); requestDraw()
    },
    // 地名颜色/透明度（与 3D 同步）：{ countryColor, countryOpacity, provColor, provOpacity }
    setLabelStyle(s) { Object.assign(labelStyle, s || {}); invalidateStatic(); requestDraw() },
    // 大海填充色（与 3D 同步，限蓝色系）
    setOceanColor(c) { if (c) { oceanColor = c; invalidateStatic(); requestDraw() } },
    // 大地颜色（基调方案 + 逐国覆盖，与 3D 同步）：写入公共色板状态后重建陆地 Path2D 并重绘静态层
    setLandColors(s) { setLandPalette(s); buildBaseGeo(resolvedFeatures(mapDetail0), mapThin); invalidateStatic(); requestDraw() },
    setOnRightClick(fn) { onRightClick = fn },
    setOnHover(fn) { onHover = fn },
    // 缩放进度条接口：getZoom 读当前进度、setZoom 设到进度 t、setOnZoom 注册滚轮缩放回填回调
    getZoom: () => scaleToT(),
    setZoom: (t) => setZoomT(t),
    setOnZoom(fn) { onZoom = fn },
    // 完整视图记忆：缩放 scale + 画面中心的「世界坐标」(cx=lon-LON0, cy=90-lat)。
    // 用世界中心点而非 tx/ty → 窗口尺寸变化后仍能复原到同一地理中心。setView 需在 resize 后调用（base 已就绪）。
    getView() { const kk = k(); return { scale, cx: (cw / 2 - tx) / kk, cy: (ch / 2 - ty) / kk } },
    // 键盘方向键：把视窗中心按屏幕像素平移（dxPx 右为正 → 中心东移，dyPx 下为正 → 中心南移）。
    // tx/ty 为 CSS 像素平移量（与鼠标拖拽同一坐标系），故与缩放无关：每次移动固定屏幕距离。
    panByPixels(dxPx, dyPx) {
      const dx = Number.isFinite(dxPx) ? dxPx : 0, dy = Number.isFinite(dyPx) ? dyPx : 0
      if (!dx && !dy) return
      tx -= dx; ty -= dy
      invalidateStatic(); requestDraw()
    },
    setView(v) {
      if (!v || !Number.isFinite(v.scale)) return
      scale = clamp(v.scale, SMIN, SMAX)
      const kk = k()
      if (Number.isFinite(v.cx)) tx = cw / 2 - v.cx * kk
      if (Number.isFinite(v.cy)) ty = ch / 2 - v.cy * kk
      invalidateStatic(); requestDraw()
    },
    // 渲染分辨率倍率（画质档位）：改后重建位图。this.resize 重算 dpr/位图尺寸并重绘。
    setRenderScale(n) { renderScale = Number.isFinite(n) ? n : null; this.resize() },
    // 底图精细化（与 3D 同步）：'10m'/'50m'/'110m' + thin 抽稀阈值。换源重建陆地面与五类边界线。50m/110m 懒加载。
    async setMapDetail(detail, thin) {
      const t = (thin != null) ? thin : mapThin
      if (detail === mapDetail0 && t === mapThin) return
      try { await ensureDetail(detail) }
      catch (e) { console.warn(detail + ' 底图加载失败，保持当前精度', e); return }
      mapDetail0 = detail; mapThin = t
      borderPaths = null
      buildBaseGeo(resolvedFeatures(detail), t)
      invalidateStatic(); requestDraw()
    },
    // 销毁：退订主权解算层的广播（不退的话卸载后的画布仍会被换视角触发重建）
    destroy() { offPov() },
    setBeamDragMode(v) { beamDragMode = !!v; beamDragging = false; canvas.style.cursor = polyDrawMode ? 'crosshair' : ((v || labelDragMode) ? 'move' : 'grab') },
    setOnBeamDrag(fn) { onBeamDrag = fn },
    setLabelDragMode(v) { labelDragMode = !!v; labelDragging = false; canvas.style.cursor = polyDrawMode ? 'crosshair' : ((v || beamDragMode) ? 'move' : 'grab') },
    setOnLabelDrag(fn) { onLabelDrag = fn },
    // 协调区多边形 hold-to-draw 模式：开启后左键按住沿路径连续加点
    setPolyDrawMode(v) { polyDrawMode = !!v; polyDrawing = false; canvas.style.cursor = v ? 'crosshair' : (beamDragMode ? 'move' : 'grab') },
    setOnPolyDraw(fn) { onPolyDraw = fn },
    // Polygon 顶点编辑/整体拖动：v={ pts:[[lon,lat],...], px 顶点半径, move 整体拖动模式 } 开启
    // （pts 传引用，外部改动即时生效）；null 关闭
    setEditVerts(v) {
      const nv = (v && v.pts) ? v : null
      // 拖拽进行中被重新喂入（外部数据变动重建了顶点快照——如波束合成「调整中心」拖动时，深监听会 redrawSats+syncEdit
      // 逐帧回刷 editVerts）：若新旧顶点数一致，保住当前拖拽索引/整体拖动态，别把正在进行的拖动掐断，否则按住只跳一下
      // 就断、无法连续调整。仅在清空 / 切换到不同长度的编辑目标时才复位拖拽状态。
      const keepDrag = !!nv && !!editVerts && (vertDragging >= 0 || moveDragging) && nv.pts.length === editVerts.pts.length
      editVerts = nv
      if (!keepDrag) { vertDragging = -1; moveDragging = false; moveLast = null }
      if (!editVerts) canvas.style.cursor = placeMode ? 'crosshair' : (beamDragMode ? 'move' : 'grab')
    },
    setOnVertexDrag(fn) { onVertexDrag = fn },
    // 放置模式（波束合成）：左键点击落点；拖动仍平移
    setPlaceMode(v) { placeMode = !!v; placeArmed = false; canvas.style.cursor = placeMode ? 'crosshair' : (polyDrawMode ? 'crosshair' : ((beamDragMode || labelDragMode) ? 'move' : 'grab')) },
    setOnPlace(fn) { onPlace = fn },
    // 框选模式（站点栅编辑）：左键拖矩形选站；开启期间不平移
    setBoxSelectMode(v) { boxMode = !!v; boxDragging = false; canvas.style.cursor = boxMode ? 'crosshair' : (placeMode || polyDrawMode ? 'crosshair' : ((beamDragMode || labelDragMode) ? 'move' : 'grab')) },
    setOnBoxSelect(fn) { onBoxSelect = fn },
    setOnPolyMove(fn) { onPolyMove = fn },
    setMarkers(points, stations, trajectories) { mk = { points: points || [], stations: stations || [], trajectories: trajectories || [] }; invalidateStatic(); requestDraw() },
    // p：单个 {lat,lon} 或数组，兼容旧单选调用；聚焦星每帧实时绘制，不在快照内
    setFocusSat(p) { focusSats = (Array.isArray(p) ? p : (p ? [p] : [])).filter((q) => q && Number.isFinite(q.lat) && Number.isFinite(q.lon)); requestDraw() },
    // g：单个 {footprint,track} 或数组（多选=每颗都画），随时间实时，不入快照
    setSelGeom(g) { selGeomList = Array.isArray(g) ? g.filter(Boolean) : (g ? [g] : []); requestDraw() },
    // 聚焦卫星显示样式（轨道线只在 3D 有，这里收轨迹/覆盖圈/星下点图标三项）
    setFocusStyle(s) { Object.assign(focusCfg, s || {}); requestDraw() },
    setSatLayer(spec) { satLayer = spec; invalidateStatic(); requestDraw() },
    resize() {
      const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 0, h = canvas.clientHeight || canvas.parentElement?.clientHeight || 0
      if (!w || !h) return
      const firstFit = cw < 2 || ch < 2; cw = w; ch = h; dpr = effDpr()
      const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr)   // 仅在尺寸真正变化时重设位图，避免无谓清空
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh }
      // 离屏静态快照缓冲随主画布尺寸（设备像素）创建/重建
      if (!belowCanvas) { belowCanvas = document.createElement('canvas'); belowCtx = belowCanvas.getContext('2d'); aboveCanvas = document.createElement('canvas'); aboveCtx = aboveCanvas.getContext('2d') }
      if (belowCanvas.width !== canvas.width || belowCanvas.height !== canvas.height) { belowCanvas.width = canvas.width; belowCanvas.height = canvas.height; aboveCanvas.width = canvas.width; aboveCanvas.height = canvas.height }
      invalidateStatic()
      if (firstFit) fit()
      draw()   // 同步立即重绘：canvas.width 重设会清空画布，若只 requestDraw 会隔一帧露出深色底 → 黑一下
    },
    reset() { fit(); invalidateStatic(); requestDraw() },
    // 当前屏幕视图的逻辑尺寸（CSS px）：供「所见即所得」导出按当前画面比例/范围出图
    viewportSize: () => ({ w: cw, h: ch }),
    // 整幅世界图在当前屏幕画布上 fit 后的逻辑尺寸（CSS px，严格 2:1）：全球图导出以此为逻辑大小、
    // 只提像素倍率 → 恒定屏幕 px 的线宽/图标/注记与在屏整幅图完全同比例（所见即所得）。画布未就绪返回 null。
    fittedWorldSize() { const sb = Math.min(cw / 360, ch / 180); return (cw > 50 && ch > 50) ? { w: 360 * sb, h: 180 * sb } : null },
    // 导出平面图到任意 2D 上下文：离屏高清 canvas → PNG；svgcanvas → SVG/PDF。
    // opts: { width, height, pixelScale=1, background=true, fontFamily, fontFamilyLatin, view=false }。
    //   fontFamily=中文面族名，fontFamilyLatin=西文面族名（仅 PDF 需分面，见 textFontLatin 注释）。
    //   view=false：整幅世界图，fit 一次性绘制；view=true：所见即所得，按当前屏幕缩放/平移出图。绘后恢复在屏视图。
    // compat=true 走子路径回放（不依赖 Path2D / evenodd 入参）→ PNG 与 PDF 完全一致。
    exportRender(targetCtx, opts) {
      const o = opts || {}
      // view=true：所见即所得，保留当前 base/scale/tx/ty 与屏幕 cw/ch，仅按 pixelScale 放大输出；
      // 否则：整幅世界图，重置 cw/ch=W/H 后 fit() 一次。
      const viewMode = o.view === true
      const W = o.width || 1600, H = o.height || (W / 2), ps = o.pixelScale || 1
      const SV = { ctx, dpr, cw, ch, base, scale, tx, ty, font: textFont, fontLatin: textFontLatin }
      ctx = targetCtx; dpr = ps; compat = true
      if (o.fontFamily) textFont = o.fontFamily
      if (o.fontFamilyLatin) textFontLatin = o.fontFamilyLatin
      if (viewMode) { /* 保留当前屏幕视图（cw/ch/base/scale/tx/ty 不变） */ }
      else { cw = W; ch = H; fit() }
      const rx = PX(LON0), ry = PY(90), rw = 360 * k(), rh = 180 * k()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (o.background !== false) { ctx.fillStyle = BG; ctx.fillRect(0, 0, cw, ch) }
      drawBelowContent(rx, ry, rw, rh)
      // 层序必须与 draw() 逐字一致（所见即所得）：晨昏线夜区打头，与屏幕上同为最底层
      ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip(); drawTerminator(); drawEnvRaster(); drawEnvContours(); drawSatFills(); drawFocusFills(); drawCovGrid(); drawField(); drawSatPolyLines(); drawDataLines(); ctx.restore()
      drawAboveContent(rx, ry, rw, rh)
      ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
      drawFieldOverlays()
      drawFocusIcons()
      ctx.restore()
      ctx = SV.ctx; dpr = SV.dpr; cw = SV.cw; ch = SV.ch; base = SV.base; scale = SV.scale; tx = SV.tx; ty = SV.ty; textFont = SV.font; textFontLatin = SV.fontLatin; compat = false
      staticValid = false; requestDraw()
    },
    destroy() {
      if (rafId) cancelAnimationFrame(rafId)
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('dblclick', onDbl)
      canvas.removeEventListener('contextmenu', onCtx)
    }
  }
}
