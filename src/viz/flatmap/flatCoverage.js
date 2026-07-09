// 平面覆盖图渲染器（2D Canvas，等距圆柱投影 / plate carrée，从西经30°切开）。
// 底图（陆地配色/国界/国家名/大洋名/省界省名/标记）与 3D 球体保持一致；叠加覆盖图数据。
// 不画星座、卫星点、卫星名、卫星连线。配色常量与 globe3d/scene.js 同源。
import { feature } from 'topojson-client'
import topo from '../globe3d/data/countries-10m.json'
import NAMES from '../globe3d/data/country-names-zh.json'
import { CHINA_IDS, NO_LABEL_IDS } from '../globe3d/cnClaims.js'
import { NANHAI_DASHES, NANHAI_WIDTH_MUL, NANHAI_MIN_WIDTH } from '../nanhaiDashes.js'
// 陆地配色（LAND/CHINA/ICE/基调方案/逐国覆盖）统一收拢到 ../landPalette.js（与 3D 球体共用单一来源）
import { CHINA, ARCTIC_ISLAND_LAT, landColors, setLandPalette } from '../landPalette.js'

const OCEAN = '#15426b'
// 南极极冠：南极洲数据止于约 -85°，极点处留有空洞，补到 -90°。
const SOUTH_CAP_LAT = -82
const BORDER = '#5b7088', GRID = 'rgba(255,255,255,0.12)', PROV = '#9aa3b0', BG = '#070b12'
const LON0 = -30          // 切口：西经30°为左边缘，经度范围 [-30, 330)
const OCEANS = [
  ['太平洋', 'Pacific Ocean', -155, 25], ['太平洋', 'Pacific Ocean', -130, -22],
  ['大西洋', 'Atlantic Ocean', -35, 28], ['大西洋', 'Atlantic Ocean', -18, -25],
  ['印度洋', 'Indian Ocean', 78, -28], ['北冰洋', 'Arctic Ocean', 0, 85], ['南大洋', 'Southern Ocean', 40, -62]
]
// 大洋名描边色（与 3D 同：斜体浅蓝）
const OCEAN_FILL = 'rgba(150,195,230,0.92)'
// 地面站图标（与 3D 同一张 SVG）
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
function unwrap(ring) {
  const out = new Array(ring.length); let prev = ring[0][0]; out[0] = [prev, ring[0][1]]
  for (let i = 1; i < ring.length; i++) { let lo = ring[i][0]; while (lo - prev > 180) lo -= 360; while (lo - prev < -180) lo += 360; out[i] = [lo, ring[i][1]]; prev = lo }
  return out
}
function centroidLonLat(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates
  let best = null, bl = -1
  for (const rings of polys) { const r = rings[0]; if (r && r.length > bl) { bl = r.length; best = r } }
  if (!best) return null
  let sx = 0, sy = 0; for (const p of best) { sx += p[0]; sy += p[1] }
  return [sx / best.length, sy / best.length]
}
function featureExtent(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates
  let best = null, bl = -1
  for (const rings of polys) { const r = rings[0]; if (r && r.length > bl) { bl = r.length; best = r } }
  if (!best) return 0
  let a = 180, b = -180, c = 90, d = -90
  for (const p of best) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; if (p[1] < c) c = p[1]; if (p[1] > d) d = p[1] }
  const cl = Math.max(Math.cos((c + d) / 2 * Math.PI / 180), 0.1)
  return Math.sqrt((b - a) * cl * (d - c))
}

export function createFlatCoverage(canvas) {
  let ctx = canvas.getContext('2d')   // 绘制目标上下文：导出时临时切到离屏 canvas / svgcanvas（见 exportRender）
  // 导出兼容模式：svgcanvas/canvas2svg 忽略 Path2D 与 evenodd 入参，故导出时把陆地/覆盖填充/等值线
  // 改为「子路径回放」（moveTo/lineTo），实时绘制仍走 Path2D 缓存（更快）。compat 同时用于离屏高清 PNG，
  // 保证 PNG 与 PDF 完全一致。textFont：导出可指定字体族名（PDF 用注册名匹配嵌入的中文字体）。
  let compat = false
  // 导出（PNG/PDF）物理分辨率远高于屏幕，文字描边按同一相对粗细在高清大图上观感发粗 → 导出时额外收细。
  const EXPORT_STROKE_K = 0.6
  let textFont = '"Microsoft YaHei", sans-serif'
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
  // GRD 全局标注选项（与 3D 同步）：天线名 / 波束中心 / 数值标签
  let fieldOpts = { showName: true, nameSize: 16, showBore: true, boreSize: 5, showPeak: false, peakSize: 12, showVal: false, valSize: 12 }
  let nameMode = 'off', provVisible = false, prov = null, cityVisible = false, city = null
  // 国界(海岸线)/省界/地级市界线样式：线宽为恒定屏幕 px、颜色十六进制、透明度 0–1（与 3D 同步）
  let borderStyle = { natColor: BORDER, natWidth: 0.8, natOpacity: 1.0, provColor: PROV, provWidth: 1.2, provOpacity: 0.8, cityColor: '#b6bcc6', cityWidth: 0.5, cityOpacity: 0.6 }
  // 地名颜色/透明度：国家名 与 省名 与 地级市名 分开（大洋名维持固有蓝，不随国家色改）
  let labelStyle = { countryColor: '#eef2f6', countryOpacity: 1, provColor: '#ffe6a8', provOpacity: 1, cityColor: '#cdd6e0', cityOpacity: 1 }
  let oceanColor = OCEAN   // 大海填充色（可调，限蓝色系），与 3D 球体同步
  let mk = { points: [], stations: [], trajectories: [] }
  let focusSats = []    // 聚焦卫星星下点列表 [{ lat, lon }...]（多选=每颗各一个图标，同款同大小，不分主次）
  let selGeomList = []  // 聚焦卫星几何列表 [{ footprint:[{lat,lon}...], track:[{lat,lon}...] }...]，与 3D 同源（覆盖范围蓝 + 星下点轨迹黄，多颗同时叠画）
  let satLayer = null   // 卫星/仰角线独立图层 { lines, dots, labels, sats }（与 geom/field 互不干扰）
  const sizes = { beamFont: 16, contourFont: 12, dotSize: 5, showBore: true, nameScale: 1, provScale: 1, cityScale: 1, ptFont: 14, stIcon: 32, stFont: 17, satIcon: 30, ptDot: 3.5, trajDot: 2.5 }
  const SAT_ICON_K = 0.85   // 卫星图标：同地面站 ST_ICON_K，2D 观感偏大于 3D，收一档对齐（经验系数，可微调）

  // 地面站图标
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
  let land = [], clabels = []
  let mapDetail0 = '10m', mapThin = 0
  const featsOf = (m) => { const t = m.default || m; return feature(t, t.objects.countries).features }
  const featCache = { '10m': feature(topo, topo.objects.countries).features }   // 10m 静态；50m/110m 懒加载
  const loadFeatures = async (detail) => {
    if (featCache[detail]) return featCache[detail]
    const mod = detail === '110m' ? await import('../globe3d/data/countries-110m.json') : await import('../globe3d/data/countries-50m.json')
    featCache[detail] = featsOf(mod)
    return featCache[detail]
  }
  function buildBaseGeo(feats, thin) {
    land = []; clabels = []
    const seenLabel = new Set()   // 同一国家 id 只标一次（澳大利亚等含本体+外岛）
    feats.forEach((f, idx) => {
      if (!f.geometry) return
      const id = String(f.id)
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
      // 国家名
      if (NO_LABEL_IDS.has(id) || seenLabel.has(id)) return
      const rec = NAMES[id]; let zh = rec ? rec[0] : null
      if (id === '156') zh = '中国'; if (id === '408') zh = '朝鲜'; if (id === '410') zh = '韩国'
      if (!zh) return
      seenLabel.add(id)
      let lon = rec && rec[1] != null ? rec[1] : null, lat = rec && rec[2] != null ? rec[2] : null
      if (lon == null || lat == null) { const c = centroidLonLat(f.geometry); if (!c) return; lon = c[0]; lat = c[1] }
      const en = (f.properties && f.properties.name) || zh
      const px = clamp(Math.round(10 + featureExtent(f.geometry) * 0.22), 10, 20)
      clabels.push({ zh, en, lon, lat, px })
    })
  }
  buildBaseGeo(featCache['10m'], 0)

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
  // 仅填充陆地（海岸线描边移到覆盖之上的 strokeLand）。覆盖填充叠在陆地填充之上、按 alpha 混合 → 覆盖区底色随之透出。
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
  // 海岸线描边：画在覆盖填充【之上】，使海岸线在覆盖区内外连续 → 覆盖像染进地图、与底图平级，而非浮在其上。
  function strokeLand() {
    const kk = k()
    ctx.strokeStyle = borderStyle.natColor; ctx.lineWidth = borderStyle.natWidth / kk   // /kk → 恒定屏幕 px
    ctx.globalAlpha = borderStyle.natOpacity
    const wl = -tx / kk, wr = (cw - tx) / kk
    for (const off of [-360, 0, 360]) {
      ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
      if (compat) {
        // 导出：海岸线同色 → 合并成单条 path 一次描边（数千节点 → 1 节点）
        ctx.beginPath()
        for (const c of land) for (const sh of c.shapes) { if (sh.hi + off < wl || sh.lo + off > wr) continue; for (const r of sh.rings) { for (let i = 0; i < r.length; i++) i === 0 ? ctx.moveTo(r[i][0], r[i][1]) : ctx.lineTo(r[i][0], r[i][1]); ctx.closePath() } }
        ctx.stroke()
      } else for (const c of land) for (const sh of c.shapes) {
        if (sh.hi + off < wl || sh.lo + off > wr) continue
        ctx.stroke(sh.path)
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1
  }
  // 南极极冠：补 SOUTH_CAP_LAT 以南的中央空洞（取南极洲当前填色——默认冰白，被逐国设色时随用户色，无缝衔接）。
  // 北极岛屿改由 buildBaseGeo 按「多边形整块」染冰白（与 3D 同口径），不再有北极纬度渐变，故此处只剩南极极冠。
  function drawIceCaps() {
    const kk = k(), x0 = PX(LON0), w = 360 * kk
    const yCap = PY(SOUTH_CAP_LAT)
    ctx.fillStyle = landColors('010', 0).base; ctx.fillRect(x0, yCap, w, PY(-90) - yCap)
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
    ctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${px}px ${textFont}`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    // 文字描边套色(casing)：沿字形勾一圈与底色同调的窄边，把字从背景里「切」出来——专业制图标准，不用底色色块
    // 粗细 = px*strokeScale（默认 0.14），下限 strokeMin（默认 1.5）；地级市名传更细值（尽量细但保留）
    const sScale = o.strokeScale != null ? o.strokeScale : 0.14, sMin = o.strokeMin != null ? o.strokeMin : 1.5
    const ek = compat ? EXPORT_STROKE_K : 1
    const lw = Math.max(sMin * ek, px * sScale * ek)
    if (lw > 0) { ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(6,11,18,0.82)'; ctx.strokeText(text, x, y) }
    ctx.fillStyle = color; ctx.fillText(text, x, y)
  }
  function dot(lon, lat, r, fill, ring) {
    const x = PX(lon), y = PY(lat)
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill()
    if (ring) { ctx.lineWidth = Math.max(1, r * 0.35); ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.stroke() }
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
  // GRD 标注层（天线名 / 波束中心点 / 数值标签）：画在填充+等值线之上，随各层 bore/segGroups 数据
  function drawFieldOverlays() {
    const o = fieldOpts
    // 覆盖分析(GRD)四项注记（天线名/波束中心/峰值/数值）随缩放「克制版」联动：乘 iz=√scale。
    // scale=1 时即当前大小；放大时缓增（不像 ×scale 那样在 2D 大缩放幅度下膨成过大色块/字）。
    const iz = Math.sqrt(scale)
    for (const L of fieldLayers) {
      if (o.showVal) for (const grp of (L.segGroups || [])) { if (grp.txt == null) continue; for (const an of (grp.labels || [])) drawText(String(grp.txt), an[0], an[1], (o.valSize || 12) * iz, '#ffffff') }
      const b = L.bore; if (!b) continue
      const br = (o.boreSize != null ? o.boreSize : 5) * iz
      if (o.showBore) dot(b.lon, b.lat, Math.max(0.3, br), '#ffffff', true)
      // 波束中心峰值 dB：标在中心点下方（2D 无卫星连线）
      if (o.showPeak && b.peak != null) { const pf = (o.peakSize || 12) * iz; drawText(b.peak.toFixed(1) + ' dB', b.lon, b.lat, pf, '#cfd6df', { dy: (o.showBore ? br : 0) + pf * 0.7 + 3 * iz }) }
      if (o.showName && L.name) { const nf = (o.nameSize || 16) * iz; drawText(L.name, b.lon, b.lat, nf, '#ffffff', { dy: -((o.showBore ? br : 0) + nf * 0.6 + 2 * iz) }) }
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
    // iz=√scale 是「克制版」联动：点标记/地面站/航迹这类实心图标若按 mz 满速放大，2D 缩放幅度大(可达60×)会膨成大色块，
    // 故按 √scale 缓增——仍随缩放变化、scale=1 时不变，但放大时增长更温和、不至于过大。
    const mz = scale, iz = Math.sqrt(scale)
    // 与 3D 球体标记观感对齐：3D 的文字/圆点精灵都含画布留白（makeCovLabel 字号50→画布高66；dot 直径18的圆居中于32画布），
    // 其屏幕尺寸按整张画布计 → 实际可见的字/点偏小。2D 直接按字号/半径作画、无留白，故乘同等系数收小，两视图一致。
    const MK_FONT_K = 50 / 66      // 文字：3D 实际字高 = 字号 × 50/66 ≈ 0.76
    const DOT3D_FILL = 18 / 32     // 3D 圆点：实心圆占精灵的比例（其余为留白）
    const ST_ICON_K = 0.85         // 地面站图标：2D 观感略大于 3D，收一档对齐（经验系数，可微调）
    // 海岸线 + 经纬网画在覆盖填充之上：地理骨架贯穿覆盖区内外，覆盖与底图融为一体（平级），不再像贴纸浮在上面
    drawGrid(); strokeLand()
    // 南海十段线：颜色随中国国土(CHINA)，透明度随省界，线宽=省界×惯例倍数（比省界略粗）
    ctx.globalAlpha = borderStyle.provOpacity
    const nhW = Math.max(NANHAI_MIN_WIDTH, borderStyle.provWidth * NANHAI_WIDTH_MUL)
    for (const seg of NANHAI_DASHES) drawPolyline(seg, CHINA, nhW)
    ctx.globalAlpha = 1
    // 地级市界（画在省界之下，省界更醒目）
    if (cityVisible && city) {
      ctx.globalAlpha = borderStyle.cityOpacity
      for (const ring of city.borders) drawPolyline(ring, borderStyle.cityColor, borderStyle.cityWidth)
      ctx.globalAlpha = 1
    }
    // 省界
    if (provVisible && prov) {
      ctx.globalAlpha = borderStyle.provOpacity
      for (const ring of prov.borders) drawPolyline(ring, borderStyle.provColor, borderStyle.provWidth)
      ctx.globalAlpha = 1
    }
    // 覆盖数据标注（GXT 波束线本体已移入 drawDataLines：与 GRD 等值线/Polygon 边线同层、压在国界省界之下）
    if (geom) {
      if (sizes.showBore) for (const d of (geom.dots || [])) dot(d.lon, d.lat, Math.max(1, sizes.dotSize) * iz, '#fff')   // GXT 波束中心点：克制版联动
    }
    // 轨迹圆点（折线本体已移入 drawDataLines；圆点大小可调 sizes.trajDot，按克制版 iz 联动）
    const trajR = (sizes.trajDot != null ? sizes.trajDot : 2.5) * iz * (DOT3D_FILL * 2.5 / 2)   // 3D 轨迹点 ×2.5，对齐其可见直径
    for (const t of mk.trajectories) {
      for (const p of (t.pts || [])) dot(p.lon, p.lat, trajR, t.kind === 'flight' ? '#5ad1ff' : '#ff9a5a', true)
    }
    // 点标记 + 地面站（圆点大小可调 sizes.ptDot、图标 sizes.stIcon，按克制版 iz 联动）
    const si = sizes.stIcon * iz * ST_ICON_K, ptR = (sizes.ptDot != null ? sizes.ptDot : 3.5) * iz * (DOT3D_FILL * 2.2 / 2)   // 3D 点标记 ×2.2，对齐其可见直径
    for (const p of mk.points) dot(p.lon, p.lat, ptR, '#ffd24a', true)
    for (const s of mk.stations) { const x = PX(s.lon), y = PY(s.lat); if (stationReady) ctx.drawImage(stationImg, x - si / 2, y - si, si, si); else dot(s.lon, s.lat, ptR, '#cfeaff', true) }
    // 地名层：字号随缩放联动，且与 3D 球体的「世界尺寸」地名严格一致。
    // 原理：3D 地名是世界尺寸（固定地理度数），其屏幕 px = 地理度数 × 每度像素。2D 同覆盖下每度像素 = k()。
    // 故 2D 字号 = 地理度数 × k()。标定：3D 普通省名 hpx=0.02→1.146°，对应 2D 基准 l.px=15 → 系数 k()/13.1。
    // 这样把"每度像素"折进 zf：font = l.px × 倍率 × (k()/13.1)，与窗口尺寸无关、与 3D 一致。
    // 标记/波束/数值/覆盖/卫星层等注记文字：随缩放联动（乘 mz=scale，scale=1 即当前大小，与国家名同率缩放）；
    // 卫星图标改按 mz 联动（与卫星名标签同率缩放，避免图标/标签缩放不一致），不同于地面站/点标记的克制版 iz。
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
    for (const p of mk.points) {
      const pf = sizes.ptFont * iz * MK_FONT_K   // 点标记文字：×MK_FONT_K 与 3D 字高对齐（与图标同用克制版 iz）
      drawText(p.label, p.lon, p.lat, pf, '#ffffff', { dy: pf * 0.9 + 5 * iz })
      if (p.el) drawText(p.el, p.lon, p.lat, pf * 0.9, '#ffffff', { dy: pf * 1.9 + 8 * iz })   // 聚焦卫星仰角：亮白
    }
    for (const s of mk.stations) {
      const sf = sizes.stFont * iz * MK_FONT_K   // 地面站文字：×MK_FONT_K 与 3D 字高对齐（与图标同用克制版 iz）
      drawText(s.name, s.lon, s.lat, sf, '#ffffff', { dy: sf * 0.5 + 0.5 * iz })
      if (s.el) drawText(s.el, s.lon, s.lat, sf * 0.9, '#ffffff', { dy: sf * 1.5 + 3.5 * iz })   // 聚焦卫星仰角：亮白
    }
    // 卫星 / 仰角线独立图层：等仰角线 + 卫星图标 + 名称（在覆盖/标记之上、聚焦图标之下）
    if (satLayer) {
      // 卫星层所有线（Polygon 边线随 drawSatPolyLines、仰角线等随 drawDataLines）均画在 below/above 之间
      // → 压在国界/省界/地名之下，与之共存；这里只画点/标签/卫星图标
      // d.px：屏幕恒定像素半径（Polygon 顶点手柄，不随缩放变大）；否则沿用世界联动尺寸
      for (const d of (satLayer.dots || [])) dot(d.lon, d.lat, d.px != null ? Math.max(1, d.px) : Math.max(2, d.r != null ? d.r : 4) * mz, hex(d.color != null ? d.color : 0xffd27a), true)
      for (const l of (satLayer.labels || [])) drawText(l.text, l.lon, l.lat, Math.round((l.hpx || 0.026) * 750 * zf), l.color || '#fff')   // 世界尺寸字号：与 3D makeCovLabel 同源（套用地名标定 hpx0.02↔px15，zf=k()/13.1），2D/3D 一致
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
    for (const ln of (satLayer.lines || [])) if (ln.under && ln.p && ln.p.length > 1) drawPolyline(ln.p, hex(ln.color != null ? ln.color : 0x66ddff), Math.max(0.2, ln.width || 1.4))
  }
  // 数据线统一层（GXT 波束线 / 仰角线等卫星层线 / 轨迹折线 / 聚焦卫星足迹与轨迹）：与 GRD 等值线、
  // Polygon 边线同一画法同一层——画在覆盖之上、above 快照（国界/省界/市界/地名）之下 → 与国界省界共存，
  // 边界压在线上仍清晰可见。各线的圆点/标签仍留在 above 层或顶层（属标注，不遮边界线）。
  function drawDataLines() {
    if (geom) for (const ln of (geom.lines || [])) if (ln.p && ln.p.length > 1) drawPolyline(ln.p, hex(ln.color), Math.max(0.2, ln.width || 1.6))
    for (const t of mk.trajectories) if (t.pts && t.pts.length > 1) drawPolyline(t.pts, hex(t.color != null ? t.color : 0xff5a5a), 2.2)
    if (satLayer) for (const ln of (satLayer.lines || [])) if (!ln.under && ln.p && ln.p.length > 1) drawPolyline(ln.p, hex(ln.color != null ? ln.color : 0x66ddff), Math.max(0.2, ln.width || 1.4))   // 下限 0.2：跟随 Polygon 线粗滑杆最小档
    // 聚焦卫星几何（实时，不入快照）：覆盖范围(浅蓝虚线，示意非精确覆盖区) + 星下点轨迹(金黄实线)，颜色与 3D 球体同源；多选=每颗都画，固定原色不按星变色
    for (const g of selGeomList) {
      if (g.footprint && g.footprint.length > 1) drawPolyline(g.footprint, '#b8e6fa', 1.8, false, [7, 5])
      if (g.track && g.track.length > 1) drawPolyline(g.track, '#e8c074', 2.0)
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
    drawSatFills()       // Polygon 区域填充（覆盖场之下：叠加区只显示覆盖图颜色）
    drawField()          // GRD 覆盖填充面 + 等值线（在底图/Polygon 填充之上、标注之下）
    drawSatPolyLines()   // Polygon 边线（覆盖之上、国界/地名之下：叠加区仍见边线）
    drawDataLines()      // 波束线/仰角线/轨迹线/聚焦卫星线（同上：覆盖之上、国界省界之下，与边界共存）
    ctx.restore()
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(aboveCanvas, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    drawFieldOverlays()   // GRD 天线名/波束中心/数值标签（覆盖层之上）
    for (const p of focusSats) drawSatIcon(p.lon, p.lat, sizes.satIcon * Math.sqrt(scale) * SAT_ICON_K, '#ffffff')   // 聚焦卫星（最上层）：按 iz=√scale 克制联动（与 2D 导出/地面站/航迹一致，防止高倍放大时膨大、更贴 3D）；多选=每颗各一个图标
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
    dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'
  }
  function onMove(e) {
    if (moveDragging) {
      const ll = screenToLonLat(e.clientX, e.clientY)
      if (ll && moveLast && onPolyMove) {
        let dlon = ll.lon - moveLast.lon; dlon = ((dlon + 540) % 360) - 180   // 跨 ±180° 取短路增量
        onPolyMove(dlon, ll.lat - moveLast.lat, 'move'); moveLast = ll
      }
    }
    else if (vertDragging >= 0) { const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onVertexDrag) onVertexDrag(vertDragging, ll, 'move') }
    else if (beamDragging) { const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onBeamDrag) onBeamDrag(ll, 'move') }
    else if (polyDrawing) {   // 绘制态：光标每移过阈值距离落一个点
      const dx = e.clientX - drawLX, dy = e.clientY - drawLY
      if (dx * dx + dy * dy >= POLY_DRAW_MIN2) { drawLX = e.clientX; drawLY = e.clientY; const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onPolyDraw) onPolyDraw(ll, 'move') }
    }
    else if (dragging) { tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; invalidateStatic(); requestDraw() }
    else if (editVerts) {   // 悬停提示：可拖顶点 / 可拖多边形内部
      canvas.style.cursor = (editVerts.move ? pointInEditPoly(e.clientX, e.clientY) : vertexAt(e.clientX, e.clientY) >= 0) ? 'move' : 'grab'
    }
    if (onHover) onHover(screenToLonLat(e.clientX, e.clientY))   // 实时经纬度（拖拽时也更新）
  }
  function onUp() {
    if (vertDragging >= 0 && onVertexDrag) onVertexDrag(null, null, 'end')
    if (moveDragging && onPolyMove) onPolyMove(0, 0, 'end')
    if (beamDragging && onBeamDrag) onBeamDrag(null, 'end')
    if (polyDrawing && onPolyDraw) onPolyDraw(null, 'end')
    dragging = false; beamDragging = false; vertDragging = -1; moveDragging = false; moveLast = null; polyDrawing = false
    canvas.style.cursor = polyDrawMode ? 'crosshair' : (beamDragMode ? 'move' : 'grab')
  }
  function onLeave() { onUp(); if (onHover) onHover(null) }       // 移出地图：清空读数
  function onDbl() { fit(); invalidateStatic(); requestDraw(); if (onZoom) onZoom(scaleToT()) }
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
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('dblclick', onDbl)
  canvas.addEventListener('contextmenu', onCtx)
  canvas.style.cursor = 'grab'

  // 省界数据解析（与 3D setProvinces 同款格式）
  function setProvinces(data) {
    if (prov || !data) return
    const labels = (data.labels || []).map((l) => {
      const tiny = l.name === '香港' || l.name === '澳门'
      const muni = l.name === '北京' || l.name === '上海' || l.name === '天津' || l.name === '重庆'
      return { name: l.name, lon: l.lon, lat: l.lat, px: tiny ? 9 : muni ? 12 : 15 }
    })
    prov = { borders: data.borders || [], labels }
    invalidateStatic(); requestDraw()
  }

  // 地级市界数据解析（与 3D setCities 同款格式）。地名密集 → 基准 px 偏小（小空间）
  function setCities(data) {
    if (city || !data) return
    const labels = (data.labels || []).map((l) => ({ name: l.name, lon: l.lon, lat: l.lat, px: 11 }))
    city = { borders: data.borders || [], labels }
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
    setSizes(s) { Object.assign(sizes, s || {}); invalidateStatic(); requestDraw() },
    setNameMode(m) { nameMode = m; invalidateStatic(); requestDraw() },
    setProvinces,
    setProvincesVisible(v) { provVisible = !!v; invalidateStatic(); requestDraw() },
    setCities,
    setCitiesVisible(v) { cityVisible = !!v; invalidateStatic(); requestDraw() },
    // 国界/省界线样式（与 3D 同步）：{ natColor, natWidth, natOpacity, provColor, provWidth, provOpacity }
    setBorderStyle(s) { Object.assign(borderStyle, s || {}); invalidateStatic(); requestDraw() },
    // 地名颜色/透明度（与 3D 同步）：{ countryColor, countryOpacity, provColor, provOpacity }
    setLabelStyle(s) { Object.assign(labelStyle, s || {}); invalidateStatic(); requestDraw() },
    // 大海填充色（与 3D 同步，限蓝色系）
    setOceanColor(c) { if (c) { oceanColor = c; invalidateStatic(); requestDraw() } },
    // 大地颜色（基调方案 + 逐国覆盖，与 3D 同步）：写入公共色板状态后重建陆地 Path2D 并重绘静态层
    setLandColors(s) { setLandPalette(s); buildBaseGeo(featCache[mapDetail0] || featCache['10m'], mapThin); invalidateStatic(); requestDraw() },
    setOnRightClick(fn) { onRightClick = fn },
    setOnHover(fn) { onHover = fn },
    // 缩放进度条接口：getZoom 读当前进度、setZoom 设到进度 t、setOnZoom 注册滚轮缩放回填回调
    getZoom: () => scaleToT(),
    setZoom: (t) => setZoomT(t),
    setOnZoom(fn) { onZoom = fn },
    // 完整视图记忆：缩放 scale + 画面中心的「世界坐标」(cx=lon-LON0, cy=90-lat)。
    // 用世界中心点而非 tx/ty → 窗口尺寸变化后仍能复原到同一地理中心。setView 需在 resize 后调用（base 已就绪）。
    getView() { const kk = k(); return { scale, cx: (cw / 2 - tx) / kk, cy: (ch / 2 - ty) / kk } },
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
    // 底图精细化（与 3D 同步）：'10m'/'50m'/'110m' + thin 抽稀阈值。换 topojson 源重建陆地/海岸线。50m/110m 懒加载。
    async setMapDetail(detail, thin) {
      const t = (thin != null) ? thin : mapThin
      if (detail === mapDetail0 && t === mapThin) return
      let feats
      try { feats = await loadFeatures(detail) }
      catch (e) { console.warn(detail + ' 底图加载失败，保持当前精度', e); return }
      mapDetail0 = detail; mapThin = t
      buildBaseGeo(feats, t)
      invalidateStatic(); requestDraw()
    },
    setBeamDragMode(v) { beamDragMode = !!v; beamDragging = false; canvas.style.cursor = polyDrawMode ? 'crosshair' : (v ? 'move' : 'grab') },
    setOnBeamDrag(fn) { onBeamDrag = fn },
    // 协调区多边形 hold-to-draw 模式：开启后左键按住沿路径连续加点
    setPolyDrawMode(v) { polyDrawMode = !!v; polyDrawing = false; canvas.style.cursor = v ? 'crosshair' : (beamDragMode ? 'move' : 'grab') },
    setOnPolyDraw(fn) { onPolyDraw = fn },
    // Polygon 顶点编辑/整体拖动：v={ pts:[[lon,lat],...], px 顶点半径, move 整体拖动模式 } 开启
    // （pts 传引用，外部改动即时生效）；null 关闭
    setEditVerts(v) { editVerts = (v && v.pts) ? v : null; vertDragging = -1; moveDragging = false; moveLast = null; if (!editVerts) canvas.style.cursor = beamDragMode ? 'move' : 'grab' },
    setOnVertexDrag(fn) { onVertexDrag = fn },
    setOnPolyMove(fn) { onPolyMove = fn },
    setMarkers(points, stations, trajectories) { mk = { points: points || [], stations: stations || [], trajectories: trajectories || [] }; invalidateStatic(); requestDraw() },
    // p：单个 {lat,lon} 或数组，兼容旧单选调用；聚焦星每帧实时绘制，不在快照内
    setFocusSat(p) { focusSats = (Array.isArray(p) ? p : (p ? [p] : [])).filter((q) => q && Number.isFinite(q.lat) && Number.isFinite(q.lon)); requestDraw() },
    // g：单个 {footprint,track} 或数组（多选=每颗都画），随时间实时，不入快照
    setSelGeom(g) { selGeomList = Array.isArray(g) ? g.filter(Boolean) : (g ? [g] : []); requestDraw() },
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
    // opts: { width, height, pixelScale=1, background=true, fontFamily, view=false }。
    //   view=false：整幅世界图，fit 一次性绘制；view=true：所见即所得，按当前屏幕缩放/平移出图。绘后恢复在屏视图。
    // compat=true 走子路径回放（不依赖 Path2D / evenodd 入参）→ PNG 与 PDF 完全一致。
    exportRender(targetCtx, opts) {
      const o = opts || {}
      // view=true：所见即所得，保留当前 base/scale/tx/ty 与屏幕 cw/ch，仅按 pixelScale 放大输出；
      // 否则：整幅世界图，重置 cw/ch=W/H 后 fit() 一次。
      const viewMode = o.view === true
      const W = o.width || 1600, H = o.height || (W / 2), ps = o.pixelScale || 1
      const SV = { ctx, dpr, cw, ch, base, scale, tx, ty, font: textFont }
      ctx = targetCtx; dpr = ps; compat = true
      if (o.fontFamily) textFont = o.fontFamily
      if (viewMode) { /* 保留当前屏幕视图（cw/ch/base/scale/tx/ty 不变） */ }
      else { cw = W; ch = H; fit() }
      const rx = PX(LON0), ry = PY(90), rw = 360 * k(), rh = 180 * k()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (o.background !== false) { ctx.fillStyle = BG; ctx.fillRect(0, 0, cw, ch) }
      drawBelowContent(rx, ry, rw, rh)
      ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip(); drawSatFills(); drawField(); drawSatPolyLines(); drawDataLines(); ctx.restore()
      drawAboveContent(rx, ry, rw, rh)
      ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
      drawFieldOverlays()
      for (const p of focusSats) drawSatIcon(p.lon, p.lat, sizes.satIcon * Math.sqrt(scale) * SAT_ICON_K, '#ffffff')
      ctx.restore()
      ctx = SV.ctx; dpr = SV.dpr; cw = SV.cw; ch = SV.ch; base = SV.base; scale = SV.scale; tx = SV.tx; ty = SV.ty; textFont = SV.font; compat = false
      staticValid = false; requestDraw()
    },
    destroy() {
      if (rafId) cancelAnimationFrame(rafId)
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('dblclick', onDbl)
      canvas.removeEventListener('contextmenu', onCtx)
    }
  }
}
