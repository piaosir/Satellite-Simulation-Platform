// 平面覆盖图渲染器（2D Canvas，等距圆柱投影 / plate carrée，从西经30°切开）。
// 底图（陆地配色/国界/国家名/大洋名/省界省名/标记）与 3D 球体保持一致；叠加覆盖图数据。
// 不画星座、卫星点、卫星名、卫星连线。配色常量与 globe3d/scene.js 同源。
import { feature } from 'topojson-client'
import topo from '../globe3d/data/countries-10m.json'
import NAMES from '../globe3d/data/country-names-zh.json'
import { CHINA_IDS, NO_LABEL_IDS } from '../globe3d/cnClaims.js'

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
  let dpr = Math.max(1, window.devicePixelRatio || 1)
  let cw = 1, ch = 1, base = 1, scale = 1, tx = 0, ty = 0
  let geom = null
  let fieldLayers = [], fieldAlpha = 0.8   // GRD 覆盖多层（每层=一个天线：分带填充 Path2D + 逐档等值线，独立于 geom）
  // GRD 全局标注选项（与 3D 同步）：天线名 / 波束中心 / 数值标签
  let fieldOpts = { showName: true, nameSize: 16, showBore: true, boreSize: 5, showPeak: false, peakSize: 12, showVal: false, valSize: 12 }
  let nameMode = 'off', provVisible = false, prov = null
  let mk = { points: [], stations: [], trajectories: [] }
  let focusSat = null   // 聚焦卫星星下点 { lat, lon }，null 表示无聚焦
  let satLayer = null   // 卫星/仰角线独立图层 { lines, dots, labels, sats }（与 geom/field 互不干扰）
  const sizes = { beamFont: 16, contourFont: 12, dotSize: 5, showBore: true, nameScale: 1, provScale: 1, ptFont: 14, stIcon: 32, stFont: 17, satIcon: 30 }

  // 地面站图标
  const stationImg = new Image(); let stationReady = false
  stationImg.onload = () => { stationReady = true; requestDraw() }
  stationImg.src = 'data:image/svg+xml;base64,' + btoa(STATION_SVG)

  // 预处理底图：陆地多边形（按国家配色）+ 国家名 + 大洋名
  const feats = feature(topo, topo.objects.countries).features
  const land = [], clabels = [], seenLabel = new Set()   // 同一国家 id 只标一次（澳大利亚等含本体+外岛）
  // 静态底图路径只构建一次：每个多边形烘成「世界度坐标」(x=lon-LON0, y=90-lat) 的 Path2D，
  // 之后渲染只靠 setTransform 平移缩放，不再每帧遍历 54 万顶点。allLandPath 供北极冰盖裁剪复用。
  const allLandPath = new Path2D()
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
        const u = unwrap(ring)
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
  const landClipPath = new Path2D()
  for (const off of [-360, 0, 360]) landClipPath.addPath(allLandPath, new DOMMatrix([1, 0, 0, 1, off, 0]))

  // 合帧：把一帧内的多次重绘请求合并成一次 rAF 渲染（拖拽/缩放不再被高频事件淹没）。
  let rafId = 0
  function requestDraw() { if (rafId) return; rafId = requestAnimationFrame(() => { rafId = 0; draw() }) }

  function fit() { base = Math.min(cw / 360, ch / 180); scale = 1; tx = (cw - 360 * base) / 2; ty = (ch - 180 * base) / 2 }
  const k = () => base * scale
  const WXN = (lon) => (((lon - LON0) % 360) + 360) % 360
  const PX = (lon) => WXN(lon) * k() + tx
  const PY = (lat) => (90 - lat) * k() + ty

  // 陆地：把 pan/zoom 烘进变换矩阵，直接填充缓存的 Path2D（每帧零顶点遍历）。
  // 经度环绕用 -360/0/360 三档偏移，按视口裁剪只画可见副本；描边线宽除以缩放保持 0.8px 恒定。
  function drawLand() {
    const kk = k()
    ctx.strokeStyle = BORDER; ctx.lineWidth = 0.8 / kk
    const wl = -tx / kk, wr = (cw - tx) / kk   // 视口世界 X 范围（未含 off）
    for (const off of [-360, 0, 360]) {
      ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
      for (const c of land) {
        let colored = false
        for (const sh of c.shapes) {
          if (sh.hi + off < wl || sh.lo + off > wr) continue
          if (!colored) { ctx.fillStyle = c.fill; colored = true }
          ctx.fill(sh.path, 'evenodd'); ctx.stroke(sh.path)
        }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)   // 恢复屏幕坐标，后续图层照旧
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
    ctx.lineJoin = 'round'; ctx.miterLimit = 2
    ctx.lineWidth = Math.max(1.4, px * 0.13); ctx.strokeStyle = 'rgba(0,0,0,0.72)'
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
  function buildFillPaths(fillBands) {
    return fillBands.map((fb) => {
      const path = new Path2D()
      for (const poly of fb.polys) {
        for (let i = 0; i < poly.length; i++) { const x = poly[i][0] - LON0, y = 90 - poly[i][1]; i === 0 ? path.moveTo(x, y) : path.lineTo(x, y) }
        path.closePath()
      }
      return { color: 'rgb(' + fb.color[0] + ',' + fb.color[1] + ',' + fb.color[2] + ')', path }
    })
  }

  function drawField() {
    const kk = k()
    // 填充：把 pan/zoom 烘进变换矩阵，直接填充缓存的世界坐标 Path2D（每帧零顶点遍历），-360/0/+360 三档环绕
    ctx.save(); ctx.globalAlpha = fieldAlpha
    for (const L of fieldLayers) {
      if (!L.fillPaths || !L.fillPaths.length) continue
      for (const off of [-360, 0, 360]) {
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
        for (const fb of L.fillPaths) { ctx.fillStyle = fb.color; ctx.fill(fb.path) }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.restore()
    // 逐档等值线（多层，每层每档一色）：段两端就近解缠，三档环绕
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    for (const L of fieldLayers) {
      for (const grp of (L.segGroups || [])) {
        if (!grp.segs || !grp.segs.length) continue
        const path = new Path2D()
        for (const sg of grp.segs) {
          let a = sg[0][0], b = sg[1][0]; while (b - a > 180) b -= 360; while (b - a < -180) b += 360
          const ax = (a - LON0) * kk + tx, ay = (90 - sg[0][1]) * kk + ty
          const bx = (b - LON0) * kk + tx, by = (90 - sg[1][1]) * kk + ty
          for (const off of [-360, 0, 360]) { const o = off * kk; path.moveTo(ax + o, ay); path.lineTo(bx + o, by) }
        }
        ctx.strokeStyle = grp.color || 'rgba(255,255,255,0.9)'; ctx.lineWidth = grp.width || 1.2; ctx.stroke(path)
      }
    }
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
      if (o.showPeak && b.peak != null) drawText(b.peak.toFixed(1) + ' dB', b.lon, b.lat, o.peakSize || 12, '#ffe1a0', { dy: (o.showBore ? br : 0) + (o.peakSize || 12) * 0.7 + 3 })
      if (o.showName && L.name) drawText(L.name, b.lon, b.lat, o.nameSize || 16, '#ffffff', { dy: -((o.showBore ? br : 0) + (o.nameSize || 16) * 0.6 + 2) })
    }
  }

  function draw() {
    if (cw < 2 || ch < 2) return
    // 画布位图尺寸只在 resize() 里重设，这里不再每帧重分配（避免每帧清空+重建后备缓冲）。
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = BG; ctx.fillRect(0, 0, cw, ch)
    ctx.save()
    const rx = PX(LON0), ry = PY(90), rw = 360 * k(), rh = 180 * k()
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    ctx.fillStyle = OCEAN; ctx.fillRect(rx, ry, rw, rh)
    drawLand(); drawIceCaps(); drawGrid()
    drawField()   // GRD 覆盖填充面（在底图之上、等值线/标记之下）
    // 省界
    if (provVisible && prov) for (const ring of prov.borders) drawPolyline(ring, PROV, 1.0)
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
      for (const l of clabels) drawText(nameMode === 'en' ? l.en : l.zh, l.lon, l.lat, Math.round(l.px * ns), '#eef2f6')
      for (const [zh, en, lon, lat] of OCEANS) drawText(nameMode === 'en' ? en : zh, lon, lat, Math.round(15 * ns), OCEAN_FILL, { italic: true })
    }
    if (provVisible && prov) { const ps = sizes.provScale || 1; for (const l of prov.labels) drawText(l.name, l.lon, l.lat, Math.round(l.px * ps), '#ffe6a8') }
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
    drawFieldOverlays()   // GRD 天线名/波束中心/数值标签（覆盖层之上）
    // 聚焦卫星：图标居中于实时星下点（最上层，默认白色）
    if (focusSat) drawSatIcon(focusSat.lon, focusSat.lat, sizes.satIcon, '#ffffff')
    ctx.restore()
  }

  // ---- 交互 ----
  function onWheel(e) {
    e.preventDefault()
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top
    const kk = k(), wx = (mx - tx) / kk, wy = (my - ty) / kk
    scale = clamp(scale * Math.exp(-e.deltaY * 0.0015), 0.9, 60)
    const k2 = k(); tx = mx - wx * k2; ty = my - wy * k2; requestDraw()
  }
  let dragging = false, lx = 0, ly = 0
  let beamDragMode = false, onBeamDrag = null, beamDragging = false   // 拖拽波束（不平移地图）
  function onDown(e) {
    if (beamDragMode && e.button === 0) { beamDragging = true; canvas.setPointerCapture(e.pointerId); const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onBeamDrag) onBeamDrag(ll, 'start'); return }
    dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'
  }
  function onMove(e) {
    if (beamDragging) { const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onBeamDrag) onBeamDrag(ll, 'move') }
    else if (dragging) { tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; requestDraw() }
    if (onHover) onHover(screenToLonLat(e.clientX, e.clientY))   // 实时经纬度（拖拽时也更新）
  }
  function onUp() { if (beamDragging && onBeamDrag) onBeamDrag(null, 'end'); dragging = false; beamDragging = false; canvas.style.cursor = beamDragMode ? 'move' : 'grab' }
  function onLeave() { onUp(); if (onHover) onHover(null) }       // 移出地图：清空读数
  function onDbl() { fit(); requestDraw() }
  // 屏幕坐标 -> 经纬度（投影逆运算）；超出地图范围返回 null
  function screenToLonLat(clientX, clientY) {
    const r = canvas.getBoundingClientRect(), kk = k()
    const wx = (clientX - r.left - tx) / kk, wy = (clientY - r.top - ty) / kk
    if (wy < 0 || wy > 180) return null
    let lon = wx + LON0; lon = ((lon % 360) + 540) % 360 - 180
    return { lat: 90 - wy, lon }
  }
  let onRightClick = null, onHover = null
  function onCtx(e) { e.preventDefault(); if (onRightClick) onRightClick(screenToLonLat(e.clientX, e.clientY)) }
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
    requestDraw()
  }

  return {
    setGeom(g) { geom = g; requestDraw() },
    // GRD 覆盖多层：layers=[{fillBands:[{color:[r,g,b], polys:[[[lon,lat]...]]}]|null, segGroups:[...]}]；
    // opts={alpha}。setField 时把每层 fillBands 烘成各档世界坐标 Path2D 缓存（fillPaths），draw 只设变换矢量填充。整体替换。
    setField(layers, opts) {
      fieldLayers = (layers || []).map((L) => ({ ...L, fillPaths: L.fillBands ? buildFillPaths(L.fillBands) : null }))
      if (opts) { if (opts.alpha != null) fieldAlpha = opts.alpha; fieldOpts = { ...fieldOpts, ...opts } }
      requestDraw()
    },
    // 拖拽热路径：只替换给定层（聚焦天线各波束，按 id 匹配），其余层缓存的 fillPaths 原样保留 → 不再每帧全量重建。
    patchField(layers, opts) {
      if (opts) { if (opts.alpha != null) fieldAlpha = opts.alpha; fieldOpts = { ...fieldOpts, ...opts } }
      for (const L of (layers || [])) {
        const entry = { ...L, fillPaths: L.fillBands ? buildFillPaths(L.fillBands) : null }
        const i = L.id != null ? fieldLayers.findIndex((x) => x.id === L.id) : -1
        if (i >= 0) fieldLayers[i] = entry; else fieldLayers.push(entry)
      }
      requestDraw()
    },
    setFieldAlpha(a) { fieldAlpha = a; requestDraw() },
    setSizes(s) { Object.assign(sizes, s || {}); requestDraw() },
    setNameMode(m) { nameMode = m; requestDraw() },
    setProvinces,
    setProvincesVisible(v) { provVisible = !!v; requestDraw() },
    setOnRightClick(fn) { onRightClick = fn },
    setOnHover(fn) { onHover = fn },
    setBeamDragMode(v) { beamDragMode = !!v; beamDragging = false; canvas.style.cursor = v ? 'move' : 'grab' },
    setOnBeamDrag(fn) { onBeamDrag = fn },
    setMarkers(points, stations, trajectories) { mk = { points: points || [], stations: stations || [], trajectories: trajectories || [] }; requestDraw() },
    setFocusSat(p) { focusSat = (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) ? { lat: p.lat, lon: p.lon } : null; requestDraw() },
    setSatLayer(spec) { satLayer = spec; requestDraw() },
    resize() {
      const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 0, h = canvas.clientHeight || canvas.parentElement?.clientHeight || 0
      if (!w || !h) return
      const firstFit = cw < 2 || ch < 2; cw = w; ch = h; dpr = Math.max(1, window.devicePixelRatio || 1)
      const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr)   // 仅在尺寸真正变化时重设位图，避免无谓清空
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh }
      if (firstFit) fit(); requestDraw()
    },
    reset() { fit(); requestDraw() },
    destroy() {
      if (rafId) cancelAnimationFrame(rafId)
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('dblclick', onDbl)
      canvas.removeEventListener('contextmenu', onCtx)
    }
  }
}
