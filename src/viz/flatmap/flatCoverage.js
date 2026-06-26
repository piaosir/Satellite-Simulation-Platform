// 平面覆盖图渲染器（2D Canvas，等距圆柱投影 / plate carrée，从西经30°切开）。
// 底图（陆地配色/国界/国家名/大洋名/省界省名/标记）与 3D 球体保持一致；叠加覆盖图数据。
// 不画星座、卫星点、卫星名、卫星连线。配色常量与 globe3d/scene.js 同源。
import { feature } from 'topojson-client'
import topo from '../globe3d/data/countries-10m.json'
import NAMES from '../globe3d/data/country-names-zh.json'
import { CHINA_IDS, NO_LABEL_IDS } from '../globe3d/cnClaims.js'
import { NANHAI_DASHES, NANHAI_WIDTH_MUL, NANHAI_MIN_WIDTH } from '../nanhaiDashes.js'

const LAND = ['#8fa89b', '#b0a98f', '#9fb0c0', '#c0a99f', '#a9b08f', '#9f9fb0', '#b8a0a0', '#90b0a8', '#b0b090', '#a0a8b8', '#bca890', '#98a0a8']
const OCEAN = '#15426b', CHINA = '#b85a52', ICE = '#edf2f6'
const ICE_IDS = new Set(['304', '010'])
// 北极冰盖：高纬陆地随纬度渐变染白（北极圈 EDGE 起淡入、FULL 以北全白），只染陆地。
const ICE_LAT_EDGE = 66.5, ICE_LAT_FULL = 75, ICE_RGB = '237,242,246'   // = #edf2f6
// 南极极冠：南极洲数据止于约 -85°，极点处留有空洞，补到 -90°。
const SOUTH_CAP_LAT = -82
const BORDER = '#5b7088', GRID = 'rgba(255,255,255,0.12)', PROV = '#9aa3b0', BG = '#070b12'
const LON0 = -30          // 切口：西经30°为左边缘，经度范围 [-30, 330)
const OCEANS = [
  ['太平洋', 'Pacific Ocean', -150, 5], ['太平洋', 'Pacific Ocean', 175, -10],
  ['大西洋', 'Atlantic Ocean', -35, 28], ['大西洋', 'Atlantic Ocean', -18, -25],
  ['印度洋', 'Indian Ocean', 78, -28], ['北冰洋', 'Arctic Ocean', 0, 85], ['南大洋', 'Southern Ocean', 40, -62]
]
// 大洋名描边色（与 3D 同：斜体浅蓝）
const OCEAN_FILL = 'rgba(150,195,230,0.92)'
// 地面站图标（与 3D 同一张 SVG）
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
  const ctx = canvas.getContext('2d')
  // 渲染分辨率倍率（与 3D 同一画质档位）：null=跟随系统 DPR；否则作为绝对设备像素倍率（0.25~4）。
  let renderScale = null
  const effDpr = () => renderScale != null ? Math.max(0.25, Math.min(renderScale, 4)) : Math.max(1, window.devicePixelRatio || 1)
  let dpr = effDpr()
  let cw = 1, ch = 1, base = 1, scale = 1, tx = 0, ty = 0
  let geom = null
  let fieldLayers = [], fieldAlpha = 0.8   // GRD 覆盖多层（每层=一个天线：分带填充 Path2D + 逐档等值线，独立于 geom）
  // GRD 全局标注选项（与 3D 同步）：天线名 / 波束中心 / 数值标签
  let fieldOpts = { showName: true, nameSize: 16, showBore: true, boreSize: 5, showPeak: false, peakSize: 12, showVal: false, valSize: 12 }
  let nameMode = 'off', provVisible = false, prov = null
  // 国界(海岸线)/省界线样式：线宽为恒定屏幕 px、颜色十六进制、透明度 0–1（与 3D 同步）
  let borderStyle = { natColor: BORDER, natWidth: 0.8, natOpacity: 1.0, provColor: PROV, provWidth: 1.2, provOpacity: 0.8 }
  // 地名颜色/透明度：国家名 与 省名 分开（大洋名维持固有蓝，不随国家色改）
  let labelStyle = { countryColor: '#eef2f6', countryOpacity: 1, provColor: '#ffe6a8', provOpacity: 1 }
  let oceanColor = OCEAN   // 大海填充色（可调，限蓝色系），与 3D 球体同步
  let mk = { points: [], stations: [], trajectories: [] }
  let focusSat = null   // 聚焦卫星星下点 { lat, lon }，null 表示无聚焦
  let selGeom = null    // 聚焦卫星几何：{ footprint:[{lat,lon}...], track:[{lat,lon}...] }，与 3D 同源（覆盖范围蓝 + 星下点轨迹黄）
  let satLayer = null   // 卫星/仰角线独立图层 { lines, dots, labels, sats }（与 geom/field 互不干扰）
  const sizes = { beamFont: 16, contourFont: 12, dotSize: 5, showBore: true, nameScale: 1, provScale: 1, ptFont: 14, stIcon: 32, stFont: 17, satIcon: 30 }

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
  let land = [], clabels = [], allLandPath = new Path2D(), landClipPath = new Path2D()
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
    land = []; clabels = []; allLandPath = new Path2D()
    const seenLabel = new Set()   // 同一国家 id 只标一次（澳大利亚等含本体+外岛）
    feats.forEach((f, idx) => {
      if (!f.geometry) return
      const id = String(f.id)
      const fill = CHINA_IDS.has(id) ? CHINA : ICE_IDS.has(id) ? ICE : LAND[idx % LAND.length]
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
      const shapes = []
      for (const rings of polys) {
        let lo = Infinity, hi = -Infinity
        const path = new Path2D()
        for (const ring of rings) {
          const u = thin > 0 ? decimateRing(unwrap(ring), thin) : unwrap(ring)
          for (let i = 0; i < u.length; i++) { const x = u[i][0] - LON0, y = 90 - u[i][1]; if (x < lo) lo = x; if (x > hi) hi = x; i === 0 ? path.moveTo(x, y) : path.lineTo(x, y) }
          path.closePath()
        }
        allLandPath.addPath(path)
        shapes.push({ lo, hi, path })
      }
      land.push({ shapes, fill })
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
    // 北极冰盖裁剪用：陆地路径的 -360/0/360 三份副本合一（跨切口的格陵兰/俄罗斯也能正确裁剪）。
    landClipPath = new Path2D()
    for (const off of [-360, 0, 360]) landClipPath.addPath(allLandPath, new DOMMatrix([1, 0, 0, 1, off, 0]))
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
      for (const c of land) {
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
      for (const c of land) for (const sh of c.shapes) {
        if (sh.hi + off < wl || sh.lo + off > wr) continue
        ctx.stroke(sh.path)
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1
  }
  // 极地冰盖：北极高纬陆地渐变染白 + 补全南极极点空洞。
  function drawIceCaps() {
    const kk = k(), x0 = PX(LON0), w = 360 * kk
    // 南极极冠：补 SOUTH_CAP_LAT 以南的中央空洞（南极洲本就 ICE 白，无缝衔接）。
    const yCap = PY(SOUTH_CAP_LAT)
    ctx.fillStyle = ICE; ctx.fillRect(x0, yCap, w, PY(-90) - yCap)
    // 北极：仅在陆地范围内，自北极圈向北渐变染白。裁剪复用缓存的 landClipPath（世界坐标）。
    ctx.save()
    ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * tx, dpr * ty)
    ctx.clip(landClipPath, 'evenodd')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const g = ctx.createLinearGradient(0, PY(90), 0, PY(ICE_LAT_EDGE))
    g.addColorStop(0, `rgba(${ICE_RGB},1)`)
    g.addColorStop((90 - ICE_LAT_FULL) / (90 - ICE_LAT_EDGE), `rgba(${ICE_RGB},1)`)
    g.addColorStop(1, `rgba(${ICE_RGB},0)`)
    ctx.fillStyle = g; ctx.fillRect(x0, PY(90), w, PY(ICE_LAT_EDGE) - PY(90))
    ctx.restore()
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
  function drawPolyline(p, color, width, closed) {
    const kk = k()
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    ctx.beginPath(); let started = false, pwx = 0
    for (let i = 0; i < p.length; i++) {
      const a = p[i], lon = Array.isArray(a) ? a[0] : a.lon, lat = Array.isArray(a) ? a[1] : a.lat
      const wx = WXN(lon), x = wx * kk + tx, y = (90 - lat) * kk + ty
      if (started && Math.abs(wx - pwx) > 180) { ctx.stroke(); ctx.beginPath(); started = false }
      started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true); pwx = wx
    }
    ctx.stroke()
  }
  function drawText(text, lon, lat, px, color, opt) {
    const o = opt || {}
    const x = PX(lon) + (o.dx || 0), y = PY(lat) + (o.dy || 0)
    ctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${px}px "Microsoft YaHei", sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    // 文字描边套色(casing)：沿字形勾一圈与底色同调的窄边，把字从背景里「切」出来——专业制图标准，不用底色色块
    ctx.lineJoin = 'round'; ctx.miterLimit = 2
    ctx.lineWidth = Math.max(1.5, px * 0.14); ctx.strokeStyle = 'rgba(6,11,18,0.82)'
    ctx.strokeText(text, x, y); ctx.fillStyle = color; ctx.fillText(text, x, y)
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
        for (const fb of L.fillPaths) { ctx.fillStyle = fb.color; ctx.fill(fb.path) }
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
        for (const sp of L.segPaths) { ctx.strokeStyle = sp.color; ctx.lineWidth = sp.width / kk; ctx.stroke(sp.path) }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  // GRD 标注层（天线名 / 波束中心点 / 数值标签）：画在填充+等值线之上，随各层 bore/segGroups 数据
  function drawFieldOverlays() {
    const o = fieldOpts
    for (const L of fieldLayers) {
      if (o.showVal) for (const grp of (L.segGroups || [])) { if (grp.txt == null) continue; for (const an of (grp.labels || [])) drawText(String(grp.txt), an[0], an[1], o.valSize || 12, '#ffffff') }
      const b = L.bore; if (!b) continue
      const br = o.boreSize != null ? o.boreSize : 5
      if (o.showBore) dot(b.lon, b.lat, Math.max(0.3, br), '#ffffff', true)
      // 波束中心峰值 dB：标在中心点下方（2D 无卫星连线）
      if (o.showPeak && b.peak != null) drawText(b.peak.toFixed(1) + ' dB', b.lon, b.lat, o.peakSize || 12, '#cfd6df', { dy: (o.showBore ? br : 0) + (o.peakSize || 12) * 0.7 + 3 })
      if (o.showName && L.name) drawText(L.name, b.lon, b.lat, o.nameSize || 16, '#ffffff', { dy: -((o.showBore ? br : 0) + (o.nameSize || 16) * 0.6 + 2) })
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
  // field 之上的标注（省界/覆盖数据/轨迹/标记/国家名/卫星层）。透明背景，叠在覆盖填充之上。
  function drawAboveContent(rx, ry, rw, rh) {
    ctx.save()
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    // 海岸线 + 经纬网画在覆盖填充之上：地理骨架贯穿覆盖区内外，覆盖与底图融为一体（平级），不再像贴纸浮在上面
    drawGrid(); strokeLand()
    // 南海十段线：颜色随中国国土(CHINA)，透明度随省界，线宽=省界×惯例倍数（比省界略粗）
    ctx.globalAlpha = borderStyle.provOpacity
    const nhW = Math.max(NANHAI_MIN_WIDTH, borderStyle.provWidth * NANHAI_WIDTH_MUL)
    for (const seg of NANHAI_DASHES) drawPolyline(seg, CHINA, nhW)
    ctx.globalAlpha = 1
    // 省界
    if (provVisible && prov) {
      ctx.globalAlpha = borderStyle.provOpacity
      for (const ring of prov.borders) drawPolyline(ring, borderStyle.provColor, borderStyle.provWidth)
      ctx.globalAlpha = 1
    }
    // 覆盖数据
    if (geom) {
      for (const ln of (geom.lines || [])) if (ln.p && ln.p.length > 1) drawPolyline(ln.p, hex(ln.color), Math.max(0.8, ln.width || 1.6))
      if (sizes.showBore) for (const d of (geom.dots || [])) dot(d.lon, d.lat, Math.max(1, sizes.dotSize), '#fff')
    }
    // 轨迹
    for (const t of mk.trajectories) {
      if (t.pts && t.pts.length > 1) drawPolyline(t.pts, hex(t.color != null ? t.color : 0xff5a5a), 2.2)
      for (const p of (t.pts || [])) dot(p.lon, p.lat, 3.2, t.kind === 'flight' ? '#5ad1ff' : '#ff9a5a', true)
    }
    // 点标记 + 地面站
    const si = sizes.stIcon
    for (const p of mk.points) dot(p.lon, p.lat, 5, '#ffd24a', true)
    for (const s of mk.stations) { const x = PX(s.lon), y = PY(s.lat); if (stationReady) ctx.drawImage(stationImg, x - si / 2, y - si, si, si); else dot(s.lon, s.lat, 5, '#cfeaff', true) }
    // 文字层（固定字号）
    const ns = sizes.nameScale || 1
    if (nameMode !== 'off') {
      ctx.globalAlpha = labelStyle.countryOpacity
      for (const l of clabels) drawText(nameMode === 'en' ? l.en : l.zh, l.lon, l.lat, Math.round(l.px * ns), labelStyle.countryColor)
      ctx.globalAlpha = 1   // 大洋名维持固有蓝与不透明度
      for (const [zh, en, lon, lat] of OCEANS) drawText(nameMode === 'en' ? en : zh, lon, lat, Math.round(15 * ns), OCEAN_FILL, { italic: true })
    }
    if (provVisible && prov) {
      const ps = sizes.provScale || 1
      ctx.globalAlpha = labelStyle.provOpacity
      for (const l of prov.labels) drawText(l.name, l.lon, l.lat, Math.round(l.px * ps), labelStyle.provColor)
      ctx.globalAlpha = 1
    }
    if (geom) {
      for (const l of (geom.labels || [])) drawText(l.text, l.lon, l.lat, Math.round((l.hpx || 0.03) * 533), l.color || '#fff')
    }
    for (const p of mk.points) {
      drawText(p.label, p.lon, p.lat, sizes.ptFont, '#ffffff', { dy: sizes.ptFont * 0.9 + 5 })
      if (p.el) drawText(p.el, p.lon, p.lat, sizes.ptFont * 0.9, '#cdd6de', { dy: sizes.ptFont * 1.9 + 8 })   // 聚焦卫星仰角：素灰
    }
    for (const s of mk.stations) {
      drawText(s.name, s.lon, s.lat, sizes.stFont, '#cfeaff', { dy: sizes.stFont * 0.5 + 3 })
      if (s.el) drawText(s.el, s.lon, s.lat, sizes.stFont * 0.9, '#cdd6de', { dy: sizes.stFont * 1.5 + 6 })   // 聚焦卫星仰角：素灰
    }
    // 卫星 / 仰角线独立图层：等仰角线 + 卫星图标 + 名称（在覆盖/标记之上、聚焦图标之下）
    if (satLayer) {
      for (const ln of (satLayer.lines || [])) if (ln.p && ln.p.length > 1) drawPolyline(ln.p, hex(ln.color != null ? ln.color : 0x66ddff), Math.max(0.8, ln.width || 1.4))
      for (const d of (satLayer.dots || [])) dot(d.lon, d.lat, Math.max(2, d.r != null ? d.r : 4), hex(d.color != null ? d.color : 0xffd27a), true)
      for (const l of (satLayer.labels || [])) drawText(l.text, l.lon, l.lat, Math.round((l.hpx || 0.026) * 533), l.color || '#fff')
      for (const s of (satLayer.sats || [])) drawSatIcon(s.lon, s.lat, s.iconSize || sizes.satIcon, hex(s.color != null ? s.color : 0xffd27a))   // 颜色/大小随各星设置
      for (const s of (satLayer.sats || [])) {
        if (!s.name || s.lon == null || s.lat == null || s.labelShow === false) continue
        const ls = s.labelSize || 14
        drawText(s.name, s.lon, s.lat, ls, hex(s.color != null ? s.color : 0xffd27a), { dy: -((s.iconSize || sizes.satIcon || 30) * 0.5 + ls * 0.6) })
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

  function draw() {
    if (cw < 2 || ch < 2 || !belowCanvas) return
    if (!staticValid) { renderStaticLayers(); staticValid = true }
    const bw = belowCanvas.width, bh = belowCanvas.height
    const rx = PX(LON0), ry = PY(90), rw = 360 * k(), rh = 180 * k()
    // 复合：blit below（不透明）→ 覆盖填充/线（夹在中间）→ blit above（透明）→ 覆盖标注 → 聚焦星
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, bw, bh); ctx.drawImage(belowCanvas, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    drawField()   // GRD 覆盖填充面 + 等值线（在底图之上、标注之下）
    ctx.restore()
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(aboveCanvas, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    drawFieldOverlays()   // GRD 天线名/波束中心/数值标签（覆盖层之上）
    // 聚焦卫星几何（实时，不入静态快照）：覆盖范围(浅蓝) + 星下点轨迹(金黄)，颜色与 3D 球体同源
    if (selGeom) {
      if (selGeom.footprint && selGeom.footprint.length > 1) drawPolyline(selGeom.footprint, '#96d7f0', 1.8)
      if (selGeom.track && selGeom.track.length > 1) drawPolyline(selGeom.track, '#c2a25e', 2.0)
    }
    if (focusSat) drawSatIcon(focusSat.lon, focusSat.lat, sizes.satIcon, '#ffffff')   // 聚焦卫星（最上层）
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
  function onDown(e) {
    if (beamDragMode && e.button === 0) { beamDragging = true; canvas.setPointerCapture(e.pointerId); const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onBeamDrag) onBeamDrag(ll, 'start'); return }
    dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'
  }
  function onMove(e) {
    if (beamDragging) { const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onBeamDrag) onBeamDrag(ll, 'move') }
    else if (dragging) { tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; invalidateStatic(); requestDraw() }
    if (onHover) onHover(screenToLonLat(e.clientX, e.clientY))   // 实时经纬度（拖拽时也更新）
  }
  function onUp() { if (beamDragging && onBeamDrag) onBeamDrag(null, 'end'); dragging = false; beamDragging = false; canvas.style.cursor = beamDragMode ? 'move' : 'grab' }
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
    // 国界/省界线样式（与 3D 同步）：{ natColor, natWidth, natOpacity, provColor, provWidth, provOpacity }
    setBorderStyle(s) { Object.assign(borderStyle, s || {}); invalidateStatic(); requestDraw() },
    // 地名颜色/透明度（与 3D 同步）：{ countryColor, countryOpacity, provColor, provOpacity }
    setLabelStyle(s) { Object.assign(labelStyle, s || {}); invalidateStatic(); requestDraw() },
    // 大海填充色（与 3D 同步，限蓝色系）
    setOceanColor(c) { if (c) { oceanColor = c; invalidateStatic(); requestDraw() } },
    setOnRightClick(fn) { onRightClick = fn },
    setOnHover(fn) { onHover = fn },
    // 缩放进度条接口：getZoom 读当前进度、setZoom 设到进度 t、setOnZoom 注册滚轮缩放回填回调
    getZoom: () => scaleToT(),
    setZoom: (t) => setZoomT(t),
    setOnZoom(fn) { onZoom = fn },
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
    setBeamDragMode(v) { beamDragMode = !!v; beamDragging = false; canvas.style.cursor = v ? 'move' : 'grab' },
    setOnBeamDrag(fn) { onBeamDrag = fn },
    setMarkers(points, stations, trajectories) { mk = { points: points || [], stations: stations || [], trajectories: trajectories || [] }; invalidateStatic(); requestDraw() },
    setFocusSat(p) { focusSat = (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) ? { lat: p.lat, lon: p.lon } : null; requestDraw() },   // 聚焦星每帧实时绘制，不在快照内
    setSelGeom(g) { selGeom = g || null; requestDraw() },   // 聚焦卫星几何（覆盖范围 + 星下点轨迹），随时间实时，不入快照
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
      if (firstFit) fit(); requestDraw()
    },
    reset() { fit(); invalidateStatic(); requestDraw() },
    destroy() {
      if (rafId) cancelAnimationFrame(rafId)
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('dblclick', onDbl)
      canvas.removeEventListener('contextmenu', onCtx)
    }
  }
}
