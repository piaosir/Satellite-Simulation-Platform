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

// 聚焦卫星图标：白填充 / 黑描边，姿态倾斜。极简——仅双侧 3×2 圆角块 + 中央星体。
const SAT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'>" +
  "<g transform='rotate(-20 60 60)' fill='#ffffff' stroke='#0d1117' stroke-width='3' stroke-linejoin='round'>" +
  "<rect x='8' y='41' width='10' height='16' rx='3'/><rect x='21' y='41' width='10' height='16' rx='3'/><rect x='34' y='41' width='10' height='16' rx='3'/>" +
  "<rect x='8' y='63' width='10' height='16' rx='3'/><rect x='21' y='63' width='10' height='16' rx='3'/><rect x='34' y='63' width='10' height='16' rx='3'/>" +  // 左阵 3×2
  "<rect x='76' y='41' width='10' height='16' rx='3'/><rect x='89' y='41' width='10' height='16' rx='3'/><rect x='102' y='41' width='10' height='16' rx='3'/>" +
  "<rect x='76' y='63' width='10' height='16' rx='3'/><rect x='89' y='63' width='10' height='16' rx='3'/><rect x='102' y='63' width='10' height='16' rx='3'/>" +  // 右阵 3×2
  "<rect x='49' y='35' width='22' height='50' rx='10'/>" +                                    // 星体
  "</g></svg>"

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
  let nameMode = 'off', provVisible = false, prov = null
  let mk = { points: [], stations: [], trajectories: [] }
  let focusSat = null   // 聚焦卫星星下点 { lat, lon }，null 表示无聚焦
  const sizes = { beamFont: 16, contourFont: 12, dotSize: 5, showBore: true, nameScale: 1, provScale: 1, ptFont: 14, stIcon: 32, stFont: 17, satIcon: 30 }

  // 地面站图标
  const stationImg = new Image(); let stationReady = false
  stationImg.onload = () => { stationReady = true; draw() }
  stationImg.src = 'data:image/svg+xml;base64,' + btoa(STATION_SVG)
  // 聚焦卫星图标
  const satImg = new Image(); let satReady = false
  satImg.onload = () => { satReady = true; draw() }
  satImg.src = 'data:image/svg+xml;base64,' + btoa(SAT_SVG)

  // 预处理底图：陆地多边形（按国家配色）+ 国家名 + 大洋名
  const feats = feature(topo, topo.objects.countries).features
  const land = [], clabels = [], seenLabel = new Set()   // 同一国家 id 只标一次（澳大利亚等含本体+外岛）
  feats.forEach((f, idx) => {
    if (!f.geometry) return
    const id = String(f.id)
    const fill = CHINA_IDS.has(id) ? CHINA : ICE_IDS.has(id) ? ICE : LAND[idx % LAND.length]
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    const shapes = []
    for (const rings of polys) {
      const urings = []; let lo = Infinity, hi = -Infinity
      for (const ring of rings) { const u = unwrap(ring); for (const p of u) { const x = p[0] - LON0; if (x < lo) lo = x; if (x > hi) hi = x }; urings.push(u) }
      shapes.push({ rings: urings, lo, hi })
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

  function fit() { base = Math.min(cw / 360, ch / 180); scale = 1; tx = (cw - 360 * base) / 2; ty = (ch - 180 * base) / 2 }
  const k = () => base * scale
  const WXN = (lon) => (((lon - LON0) % 360) + 360) % 360
  const PX = (lon) => WXN(lon) * k() + tx
  const PY = (lat) => (90 - lat) * k() + ty

  function drawLand() {
    const kk = k()
    for (const c of land) {
      for (const sh of c.shapes) {
        for (const off of [-360, 0, 360]) {
          if (sh.hi + off < 0 || sh.lo + off > 360) continue
          ctx.beginPath()
          for (const ring of sh.rings) { for (let i = 0; i < ring.length; i++) { const x = (ring[i][0] - LON0 + off) * kk + tx, y = (90 - ring[i][1]) * kk + ty; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) } ctx.closePath() }
          ctx.fillStyle = c.fill; ctx.fill('evenodd')
          ctx.lineWidth = 0.8; ctx.strokeStyle = BORDER; ctx.stroke()
        }
      }
    }
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

  function draw() {
    if (cw < 2 || ch < 2) return
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = BG; ctx.fillRect(0, 0, cw, ch)
    ctx.save()
    const rx = PX(LON0), ry = PY(90), rw = 360 * k(), rh = 180 * k()
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    ctx.fillStyle = OCEAN; ctx.fillRect(rx, ry, rw, rh)
    drawLand(); drawGrid()
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
    // 聚焦卫星：图标居中于实时星下点（最上层，带柔和投影）
    if (focusSat && satReady) {
      const x = PX(focusSat.lon), y = PY(focusSat.lat), s = sizes.satIcon || 44
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 1
      ctx.drawImage(satImg, x - s / 2, y - s / 2, s, s)
      ctx.restore()
    }
    ctx.restore()
  }

  // ---- 交互 ----
  function onWheel(e) {
    e.preventDefault()
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top
    const kk = k(), wx = (mx - tx) / kk, wy = (my - ty) / kk
    scale = clamp(scale * Math.exp(-e.deltaY * 0.0015), 0.9, 60)
    const k2 = k(); tx = mx - wx * k2; ty = my - wy * k2; draw()
  }
  let dragging = false, lx = 0, ly = 0
  function onDown(e) { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing' }
  function onMove(e) { if (!dragging) return; tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; draw() }
  function onUp() { dragging = false; canvas.style.cursor = 'grab' }
  function onDbl() { fit(); draw() }
  // 屏幕坐标 -> 经纬度（投影逆运算）；超出地图范围返回 null
  function screenToLonLat(clientX, clientY) {
    const r = canvas.getBoundingClientRect(), kk = k()
    const wx = (clientX - r.left - tx) / kk, wy = (clientY - r.top - ty) / kk
    if (wy < 0 || wy > 180) return null
    let lon = wx + LON0; lon = ((lon % 360) + 540) % 360 - 180
    return { lat: 90 - wy, lon }
  }
  let onRightClick = null
  function onCtx(e) { e.preventDefault(); if (onRightClick) onRightClick(screenToLonLat(e.clientX, e.clientY)) }
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointerleave', onUp)
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
    draw()
  }

  return {
    setGeom(g) { geom = g; draw() },
    setSizes(s) { Object.assign(sizes, s || {}); draw() },
    setNameMode(m) { nameMode = m; draw() },
    setProvinces,
    setProvincesVisible(v) { provVisible = !!v; draw() },
    setOnRightClick(fn) { onRightClick = fn },
    setMarkers(points, stations, trajectories) { mk = { points: points || [], stations: stations || [], trajectories: trajectories || [] }; draw() },
    setFocusSat(p) { focusSat = (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) ? { lat: p.lat, lon: p.lon } : null; draw() },
    resize() {
      const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 0, h = canvas.clientHeight || canvas.parentElement?.clientHeight || 0
      if (!w || !h) return
      const firstFit = cw < 2 || ch < 2; cw = w; ch = h; dpr = Math.max(1, window.devicePixelRatio || 1)
      if (firstFit) fit(); draw()
    },
    reset() { fit(); draw() },
    destroy() {
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointerleave', onUp); canvas.removeEventListener('dblclick', onDbl)
      canvas.removeEventListener('contextmenu', onCtx)
    }
  }
}
