<script setup>
import { ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue'
import { cursor } from '../stores/cursor'
defineOptions({ inheritAttrs: false })   // 不把父级传入的 title 落到根节点（去掉鼠标悬停的“星座3D”原生提示）
import { createGlobeScene } from '../viz/globe3d/scene.js'
import sat from '../viz/constellation/satellite.js'
import { parseOMMCsv, fetchGroupLiveOrSup } from '../viz/constellation/tle.js'

// 分组与「星座地图」(2D) 完全一致：同一份列表 / 顺序 / 默认「中国星网」。
const GROUPS = [
  { key: 'all', label: '全部卫星' },
  { key: 'gps', label: 'GPS' },
  { key: 'glonass', label: 'GLONASS' },
  { key: 'beidou', label: '北斗' },
  { key: 'galileo', label: 'Galileo' },
  { key: 'o3b', label: 'O3b' },
  { key: 'geo', label: 'GEO' },
  { key: 'starlink', label: 'Starlink' },
  { key: 'oneweb', label: 'OneWeb' },
  { key: 'kuiper', label: 'Kuiper' },
  { key: 'qianfan', label: '千帆星座' },
  { key: 'guowang', label: '中国星网' },
  { key: 'iridium', label: '铱星' },
  { key: 'globalstar', label: 'Globalstar' },
  { key: 'stations', label: '空间站' },
  { key: 'planet', label: 'Planet' },
  { key: 'spire', label: 'Spire' }
]
const GROUP_LABEL = {}
GROUPS.forEach((g) => { GROUP_LABEL[g.key] = g.label })
const DEFAULT_GROUP = Math.max(0, GROUPS.findIndex((g) => g.key === 'geo'))

const RE = 6378.137
const DEG = Math.PI / 180
const MAX_RENDER = 9000
const MAX_RENDER_ALL = 14000
const STORE_KEY = 'constellation3d/selection'
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

const el = ref(null)
const fileInput = ref(null)
const groupIndex = ref(DEFAULT_GROUP)
const status = ref('')
const satCount = ref(0)     // 该组卫星总数
const shownCount = ref(0)   // 实际渲染点数
const dataTime = ref('')
const live = ref(false)     // 实时刷新（与 2D 默认一致：关）
const autoRotate = ref(true)
const nameMode = ref('off')   // 国名：'zh' | 'en' | 'off'
const showProvinces = ref(false)
let provincesLoaded = false
const timeOffset = ref(0)   // 分钟，0~1440（未来 24h）
const timePct = ref(0)
const keyword = ref('')
const searchResults = ref([])
const selected = ref(null)
// 波束角
const beam = ref('')
const beamAuto = ref('')
const beamLock = ref(false)
const apiOk = typeof window !== 'undefined' && !!(window.api && window.api.omm)
const covApiOk = typeof window !== 'undefined' && !!(window.api && window.api.coverage)

// ===================== 覆盖图（GEO 卫星，仿小程序卫星覆盖） =====================
const covOpen = ref(false)        // 右侧覆盖面板开关
const covSats = ref([])           // 索引：[{folder,displayName,lon,beams:[{band,beam,type,gains,file}...]}]
const covSatFolder = ref('')
const covBand = ref('all')        // 频段过滤
const covType = ref('EIRP')       // EIRP / GT
const selBeams = ref([])          // 选中波束 id（'band|beam'），可多选
const selGains = ref([])          // 选中增益档位（数值）
const customGain = ref('')        // 自定义增益（逗号分隔）
const showBeamLabels = ref(true)
const beamNames = reactive({})    // 波束 id -> 自定义显示名（覆盖默认）
const showBore = ref(true)        // 波束中心点
const showContourLabels = ref(false) // 等值线数值标签
const elevText = ref('')          // 等仰角线，如 "5,10"
const covStatus = ref('')
const covLegend = ref(null)       // { gmin, gmax, type }
let covLoaded = false
const covCache = {}               // file -> 数据（避免重复加载）

const clamp01 = (v) => Math.max(0, Math.min(1, v))
function gainCss(t) { const h = (1 - clamp01(t)) * 240; return `hsl(${h},90%,55%)` }
// 档位色块颜色：与地图等值线完全同一套取值（用已绘制的 gmin/gmax；单值时 t=1，与地图一致）
function gainColorCss(g) {
  const L = covLegend.value
  if (!L) return gainCss(1)
  const t = L.gmax > L.gmin ? (g - L.gmin) / (L.gmax - L.gmin) : 1
  return gainCss(t)
}
// HSL(蓝→红) -> 0xRRGGBB（与 gainCss 同色，供 three 线条用）
function gainHex(t) {
  const h = (1 - clamp01(t)) * 240 / 360, s = 0.9, l = 0.55, a = s * Math.min(l, 1 - l)
  const f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255)
}
const parseNums = (s) => String(s || '').split(/[,，\s]+/).map((x) => parseFloat(x)).filter((x) => Number.isFinite(x))
const curSat = () => covSats.value.find((x) => x.folder === covSatFolder.value)
function covBands() { const s = curSat(); if (!s) return []; return [...new Set(s.beams.filter((b) => b.type === covType.value).map((b) => b.band))] }
function beamRows() {
  const s = curSat(); if (!s) return []
  const map = new Map()
  for (const b of s.beams) {
    if (b.type !== covType.value) continue
    if (covBand.value !== 'all' && b.band !== covBand.value) continue
    const id = b.band + '|' + b.beam
    if (!map.has(id)) map.set(id, { id, band: b.band, beam: b.beam, label: `${b.band}·${b.beam}`, file: b.file, gains: b.gains || [] })
  }
  return [...map.values()]
}
function unionGains() {
  const set = new Set()
  for (const r of beamRows()) if (selBeams.value.includes(r.id)) for (const g of r.gains) set.add(g)
  return [...set].sort((a, b) => a - b)
}
function effectiveGainSet() {
  const set = new Set(selGains.value)
  for (const v of parseNums(customGain.value)) set.add(v)
  return set
}

let scene = null
let entries = []        // 全部 {rec, name, noradId, group}
let renderEntries = []  // 抽稀后、与点云顺序一致
let selEntry = null
let baseTime = Date.now()
let timer = null, ro = null
let pendingNorad = null, pendingNoFace = false

function calcAt() { return live.value ? new Date() : new Date(baseTime + timeOffset.value * 60000) }

const curKey = () => GROUPS[groupIndex.value].key
const fmtSlot = (lonDeg) => { const v = ((lonDeg % 360) + 540) % 360 - 180; return `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'E' : 'W'}` }
const fmtDate = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }

// ===================== 信息卡（字段/顺序与 2D 完全一致） =====================
function cardFor(e) {
  const now = calcAt(), gmst = sat.gstime(now)
  const pv = sat.propagate(e.rec, now)
  if (!pv || !pv.position) return null
  const gd = sat.eciToGeodetic(pv.position, gmst), v = pv.velocity, r = pv.position
  const WE = 7.2921159e-5
  const speedAbs = v ? Math.hypot(v.x, v.y, v.z) : 0
  const speedRel = (v && r) ? Math.hypot(v.x + WE * r.y, v.y - WE * r.x, v.z) : 0
  const rec = e.rec
  const isGeo = (e.group || curKey()) === 'geo'
  return {
    name: e.name, noradId: e.noradId,
    slot: isGeo ? fmtSlot(sat.degreesLong(gd.longitude)) : '',
    alt: gd.height.toFixed(0), lat: sat.degreesLat(gd.latitude).toFixed(2), lon: sat.degreesLong(gd.longitude).toFixed(2),
    incl: (rec.inclo / DEG).toFixed(1), ecc: rec.ecco.toFixed(4), period: ((2 * Math.PI) / rec.no).toFixed(0),
    perigee: (rec.altp * RE).toFixed(0), apogee: (rec.alta * RE).toFixed(0),
    raan: (((rec.nodeo / DEG) % 360 + 360) % 360).toFixed(1), argp: (((rec.argpo / DEG) % 360 + 360) % 360).toFixed(1),
    speedAbs: speedAbs.toFixed(2), speedRel: speedRel.toFixed(2)
  }
}

// ===================== 选中几何：轨道圈 / 星下点轨迹 / 覆盖足迹 =====================
function buildSelectedGeometry() {
  if (!selEntry || !scene) return
  const rec = selEntry.rec
  const now = calcAt(), gmstNow = sat.gstime(now)
  const periodMin = (2 * Math.PI) / rec.no, N = 120

  // 轨道圈：一个周期内逐点，统一用 now 的 gmst 冻结成当前朝向
  const orbit = []
  for (let k = 0; k <= N; k++) {
    const t = new Date(now.getTime() + (k / N) * periodMin * 60000)
    const pv = sat.propagate(rec, t)
    if (pv && pv.position) { const gd = sat.eciToGeodetic(pv.position, gmstNow); orbit.push({ lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), altKm: gd.height }) }
  }
  // 星下点轨迹：逐时刻 gmst -> 真实地表轨迹
  const track = []
  for (let k = 0; k <= N; k++) {
    const t = new Date(now.getTime() + (k / N) * periodMin * 60000)
    const pv = sat.propagate(rec, t)
    if (!pv || !pv.position) continue
    const gd = sat.eciToGeodetic(pv.position, sat.gstime(t))
    track.push({ lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude) })
  }
  scene.setOrbit(orbit)
  scene.setGroundTrack(track)
  buildFootprint(rec, now, gmstNow)
}

// 覆盖足迹圈：与 2D 同一套几何（全波束角 B，半角 η=B/2；地心半角 λ=arcsin(r/RE·sinη)−η，夹断到 ε=0 上限）
function buildFootprint(rec, now, gmstNow) {
  const pv = sat.propagate(rec, now)
  if (!pv || !pv.position) { scene.setFootprint(null); return }
  const gd = sat.eciToGeodetic(pv.position, gmstNow)
  const lat0 = sat.degreesLat(gd.latitude), lon0 = sat.degreesLong(gd.longitude), h = gd.height
  scene.setHighlightLLA({ lat: lat0, lon: lon0, altKm: h })
  if (!(h > 0)) { scene.setFootprint(null); return }
  const r = RE + h
  const etaMax = Math.asin(clamp(RE / r, -1, 1))
  const bMaxDeg = 2 * etaMax / DEG

  const raw = parseFloat(beam.value)
  let bDeg, clampText = null
  if (!(raw > 0)) bDeg = bMaxDeg
  else if (raw > bMaxDeg) { bDeg = bMaxDeg; clampText = bMaxDeg.toFixed(1) }
  else bDeg = raw

  const eta = (bDeg / 2) * DEG
  const lambda = Math.asin(clamp(r / RE * Math.sin(eta), -1, 1)) - eta
  scene.setFootprint(circleLatLon(lat0, lon0, lambda, 72))

  // placeholder 常显 ε=0 上限；用户超限回写夹断值（锁定态不回写）
  const autoText = bMaxDeg.toFixed(1)
  if (autoText !== beamAuto.value) beamAuto.value = autoText
  if (clampText != null && !beamLock.value && clampText !== beam.value) beam.value = clampText
}

// 以 (lat0,lon0) 为心、地心半角 lambda 的地表小圆 -> 经纬度点列
function circleLatLon(lat0, lon0, lambda, N) {
  const la = lat0 * DEG, lo = lon0 * DEG
  const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]
  let ref = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  let e1 = [u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]]
  const n1 = Math.hypot(e1[0], e1[1], e1[2]) || 1; e1 = [e1[0] / n1, e1[1] / n1, e1[2] / n1]
  const e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]]
  const cosL = Math.cos(lambda), sinL = Math.sin(lambda), out = []
  for (let k = 0; k <= N; k++) {
    const th = (k / N) * 2 * Math.PI, c = Math.cos(th), s = Math.sin(th)
    const w = [cosL * u[0] + sinL * (c * e1[0] + s * e2[0]), cosL * u[1] + sinL * (c * e1[1] + s * e2[1]), cosL * u[2] + sinL * (c * e1[2] + s * e2[2])]
    out.push({ lat: Math.asin(clamp(w[2], -1, 1)) / DEG, lon: Math.atan2(w[1], w[0]) / DEG })
  }
  return out
}

// ===================== 抽稀 + 渲染集 =====================
function decimate(arr, n) {
  if (arr.length <= n) return arr
  const out = [], step = arr.length / n
  for (let k = 0; k < n; k++) out.push(arr[Math.floor(k * step)])
  return out
}

// 换组/加载后：算一次此刻位置，确定（固定的）渲染抽稀子集
function rebuildRenderSet() {
  if (!scene) return
  const now = calcAt(), gmst = sat.gstime(now)
  const valid = []
  for (const e of entries) {
    try { const pv = sat.propagate(e.rec, now); if (pv && pv.position) valid.push(e) } catch { /* skip */ }
  }
  if (curKey() === 'all') {
    const nonStar = [], star = []
    for (const e of valid) (e.group === 'starlink' ? star : nonStar).push(e)
    const head = decimate(nonStar, MAX_RENDER_ALL)
    const remain = MAX_RENDER_ALL - head.length
    renderEntries = remain > 0 ? head.concat(decimate(star, remain)) : head
  } else {
    renderEntries = decimate(valid, MAX_RENDER)
  }
  satCount.value = entries.length
  refreshPositions()
}

// 时间推进 / 实时刷新：只重算渲染子集位置（不重新抽稀），并刷新选中几何/信息卡
function refreshPositions() {
  if (!scene) return
  const now = calcAt(), gmst = sat.gstime(now)
  const positions = []
  for (const e of renderEntries) {
    try {
      const pv = sat.propagate(e.rec, now)
      if (pv && pv.position) { const gd = sat.eciToGeodetic(pv.position, gmst); positions.push({ lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), altKm: gd.height }) }
      else positions.push({ lat: 0, lon: 0, altKm: -RE })   // 占位，保持索引对齐（落到地心不可见）
    } catch { positions.push({ lat: 0, lon: 0, altKm: -RE }) }
  }
  scene.setSatellites(positions)
  shownCount.value = renderEntries.length
  if (selEntry) { const c = cardFor(selEntry); if (c) selected.value = c; buildSelectedGeometry() }
}

// ===================== 数据加载 =====================
function ingest(sats, payloadGroup, fetchedAt) {
  entries = []
  for (const s of sats) {
    try { const r = sat.omm2satrec(s); if (r && !r.error) entries.push({ rec: r, name: s.name, noradId: s.noradId, group: s._group || payloadGroup || '' }) } catch { /* skip */ }
  }
  dataTime.value = fetchedAt ? fmtDate(new Date(fetchedAt)) : '—'
  rebuildRenderSet()
  status.value = entries.length ? '' : '无有效卫星'
  // 跨分组/恢复选中：按 NORAD 定位
  if (pendingNorad) {
    const e = entries.find((x) => String(x.noradId) === String(pendingNorad))
    const noFace = pendingNoFace
    pendingNorad = null; pendingNoFace = false
    if (e) { selectSat(e, !noFace) }
  }
}

async function loadGroup() {
  if (!apiOk) { status.value = '需在 Electron 中运行（npm run dev）'; return }
  const g = GROUPS[groupIndex.value]
  resetBeam(); selEntry = null; selected.value = null; scene && scene.clearSelectionGeom()
  status.value = `加载 ${g.label} …`
  try {
    if (g.key === 'all') { await loadAll(); return }
    const payload = await fetchGroupLiveOrSup(g.key)
    ingest(payload.sats, g.key, payload.fetchedAt)
  } catch (e) { status.value = `${g.label} 获取失败：${(e && e.message) || '网络不可达'}` }
}

async function loadAll() {
  const keys = GROUPS.filter((g) => g.key !== 'all').map((g) => g.key)
  let done = 0
  status.value = `加载全部卫星 0/${keys.length} …`
  const tasks = keys.map((key) => fetchGroupLiveOrSup(key)
    .then((p) => { done++; status.value = `加载全部卫星 ${done}/${keys.length} …`; for (const s of p.sats) s._group = key; return p.sats })
    .catch(() => { done++; status.value = `加载全部卫星 ${done}/${keys.length} …`; return [] }))
  const arrs = await Promise.all(tasks)
  const sats = []
  for (const a of arrs) for (const s of a) sats.push(s)
  if (!sats.length) { status.value = '暂无卫星数据（网络不可达）'; return }
  ingest(sats, 'all', new Date().toISOString())
}

// ===================== 选择 / 搜索 =====================
function selectSat(e, face) {
  selEntry = e
  resetBeam()
  const c = cardFor(e); if (c) selected.value = c
  buildSelectedGeometry()
  if (face && scene) {
    const now = calcAt(), gmst = sat.gstime(now)
    const pv = sat.propagate(e.rec, now)
    if (pv && pv.position) {
      const gd = sat.eciToGeodetic(pv.position, gmst)
      const lat = sat.degreesLat(gd.latitude), lon = sat.degreesLong(gd.longitude)
      const phi = (90 - lat) * Math.PI / 180, theta = (lon + 180) * Math.PI / 180
      // 与场景 llaToVec 同向的单位方向；faceTo 内部会归一化
      scene.faceTo({ x: -Math.sin(phi) * Math.cos(theta), y: Math.cos(phi), z: Math.sin(phi) * Math.sin(theta) })
      autoRotate.value = false
    }
  }
  saveSelection()
}

function onSearch(e) {
  keyword.value = e.target.value
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) { searchResults.value = []; return }
  const now = new Date(), gmst = sat.gstime(now), geo = curKey() === 'geo'
  const out = []
  for (let i = 0; i < entries.length && out.length < 40; i++) {
    const en = entries[i]
    if (en.name.toLowerCase().includes(kw) || String(en.noradId).includes(kw)) {
      let slot = ''
      if (geo) { const pv = sat.propagate(en.rec, now); if (pv && pv.position) slot = fmtSlot(sat.degreesLong(sat.eciToGeodetic(pv.position, gmst).longitude)) }
      out.push({ en, name: en.name, noradId: en.noradId, groupLabel: GROUP_LABEL[en.group] || GROUP_LABEL[curKey()] || '', slot })
    }
  }
  searchResults.value = out
}
function clearSearch() { keyword.value = ''; searchResults.value = [] }
function pickResult(item) { searchResults.value = []; keyword.value = ''; selectSat(item.en, true) }
function closeCard() { selEntry = null; selected.value = null; resetBeam(); scene && scene.clearSelectionGeom(); saveSelection() }

// ===================== 波束角 =====================
function resetBeam() { if (!beamLock.value) beam.value = ''; beamAuto.value = '' }
function onBeam(e) {
  beam.value = e.target.value
  if (selEntry) { const now = calcAt(); buildFootprint(selEntry.rec, now, sat.gstime(now)) }
}
function toggleBeamLock() { beamLock.value = !beamLock.value }

// ===================== 时间轴 =====================
function applyTime(v) {
  timeOffset.value = clamp(v, 0, 1440); timePct.value = timeOffset.value / 1440 * 100
  if (live.value) { live.value = false; if (timer) { clearInterval(timer); timer = null } baseTime = Date.now() }
  refreshPositions()
}
function step(min) { applyTime((timeOffset.value || 0) + min) }
function resetTime() { if (!timeOffset.value && !live.value) return; baseTime = Date.now(); applyTime(0) }
function toggleLive() {
  live.value = !live.value
  if (live.value) { if (!timer) timer = setInterval(refreshPositions, 1000); refreshPositions() }
  else { if (timer) { clearInterval(timer); timer = null } baseTime = Date.now(); timeOffset.value = 0; timePct.value = 0; refreshPositions() }
}
function toggleRotate() { autoRotate.value = !autoRotate.value; scene && scene.setAutoRotate(autoRotate.value) }
function setNameMode(m) { nameMode.value = m; scene && scene.setLabelMode(m) }
async function toggleProvinces() {
  showProvinces.value = !showProvinces.value
  if (showProvinces.value && !provincesLoaded) {
    try { const mod = await import('../viz/globe3d/data/china-provinces.json'); scene && scene.setProvinces(mod.default || mod); provincesLoaded = true }
    catch (e) { /* 省界数据缺失 */ }
  }
  scene && scene.setProvincesVisible(showProvinces.value)
}

// ===================== 覆盖图 =====================
async function ensureCovIndex() {
  if (covLoaded || !covApiOk) return
  covLoaded = true
  try { const idx = await window.api.coverage.index(); covSats.value = (idx && idx.satellites) || [] }
  catch (e) { covStatus.value = '覆盖索引加载失败' }
}
async function toggleCoverage() {
  covOpen.value = !covOpen.value
  if (covOpen.value) { await ensureCovIndex(); redraw() }
  // 关闭对话框不清空：已绘制的覆盖图保留在地图上（与标记一致）
}

function onCovSat(e) {
  covSatFolder.value = e.target.value
  covBand.value = 'all'; selBeams.value = []; selGains.value = []; customGain.value = ''
  Object.keys(beamNames).forEach((k) => delete beamNames[k])   // 清掉旧卫星的自定义名
  redraw()
}
function onCovBand(e) {
  covBand.value = e.target.value
  const ids = beamRows().map((r) => r.id)
  selBeams.value = selBeams.value.filter((id) => ids.includes(id))
  selGains.value = unionGains()
  redraw()
}
function setType(t) { if (covType.value === t) return; covType.value = t; selBeams.value = []; selGains.value = []; redraw() }
function toggleBeam(id) {
  const i = selBeams.value.indexOf(id)
  if (i >= 0) selBeams.value.splice(i, 1); else selBeams.value.push(id)
  selGains.value = unionGains()   // 选择变化 -> 增益档位默认全选
  redraw()
}
function allBeams(on) { selBeams.value = on ? beamRows().map((r) => r.id) : []; selGains.value = unionGains(); redraw() }
function toggleGain(g) {
  const i = selGains.value.indexOf(g)
  if (i >= 0) selGains.value.splice(i, 1); else selGains.value.push(g)
  redraw()
}
function allGains(on) { selGains.value = on ? unionGains() : []; redraw() }
function onCustomGain(e) { customGain.value = e.target.value; redraw() }
function toggleBeamLabels() { showBeamLabels.value = !showBeamLabels.value; redraw() }
const selectedBeamRows = () => beamRows().filter((r) => selBeams.value.includes(r.id))
function setBeamName(id, v) { beamNames[id] = v; redraw() }
function toggleBore() { showBore.value = !showBore.value; redraw() }
function toggleContourLabels() { showContourLabels.value = !showContourLabels.value; redraw() }
function applyElev(e) { elevText.value = e.target.value; redraw() }

// 等仰角线：GEO 卫星(赤道, satLon)下，仰角 El 对应地心角 γ=acos(k·cosEl)−El（k=Re/Rs）。
// 等仰角线 = 以星下点(0,satLon)为心、角半径 γ 的地表小圆。
function elevationLines() {
  const s = curSat(); if (!s || s.lon == null) return []
  const Re = 6378.137, Rs = 42164.0, k = Re / Rs, out = []
  for (const el of parseNums(elevText.value)) {
    if (!(el > 0 && el < 90)) continue
    const elR = el * Math.PI / 180, cosElk = k * Math.cos(elR)
    if (Math.abs(cosElk) > 1) continue
    const gamma = Math.acos(cosElk) - elR
    if (gamma <= 0 || gamma >= Math.PI / 2) continue
    out.push({ p: circleLonLatArr(0, s.lon, gamma, 160), color: 0x66ddff, opacity: 0.9 })
  }
  return out
}
// 以 (lat0,lon0) 为心、角半径 lambda 的地表小圆 -> [[lon,lat]...]
function circleLonLatArr(lat0, lon0, lambda, N) {
  const la = lat0 * DEG, lo = lon0 * DEG
  const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]
  let ref = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  let e1 = [u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]]
  const n1 = Math.hypot(e1[0], e1[1], e1[2]) || 1; e1 = [e1[0] / n1, e1[1] / n1, e1[2] / n1]
  const e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]]
  const cosL = Math.cos(lambda), sinL = Math.sin(lambda), out = []
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * 2 * Math.PI, c = Math.cos(th), si = Math.sin(th)
    const w = [cosL * u[0] + sinL * (c * e1[0] + si * e2[0]), cosL * u[1] + sinL * (c * e1[1] + si * e2[1]), cosL * u[2] + sinL * (c * e1[2] + si * e2[2])]
    out.push([Math.atan2(w[1], w[0]) / DEG, Math.asin(clamp(w[2], -1, 1)) / DEG])
  }
  return out
}

let redrawSeq = 0
async function redraw() {
  if (!scene) return
  const seq = ++redrawSeq
  const s = curSat()
  const chosen = s ? beamRows().filter((r) => selBeams.value.includes(r.id)) : []
  // 加载所选波束数据（带缓存）
  if (chosen.length) covStatus.value = '加载覆盖…'
  const datas = []
  for (const r of chosen) {
    try { if (!covCache[r.file]) covCache[r.file] = await window.api.coverage.get(r.file); datas.push({ r, d: covCache[r.file] }) }
    catch (e) { /* skip */ }
  }
  if (seq !== redrawSeq) return   // 已被更新的重绘取代
  const eff = effectiveGainSet()   // 选中的增益档位（含自定义）；空=不画等值线
  const allG = []
  for (const { d } of datas) for (const c of d.contours) if (eff.has(c.g)) allG.push(c.g)
  const gmin = allG.length ? Math.min(...allG) : 0, gmax = allG.length ? Math.max(...allG) : 1
  const lines = [], dots = [], labels = []
  for (const { r, d } of datas) {
    for (const c of d.contours) {
      if (!eff.has(c.g)) continue
      const t = gmax > gmin ? (c.g - gmin) / (gmax - gmin) : 1
      lines.push({ p: c.p, color: gainHex(t) })
      // 等值线数值标签：放在该等值线最北端的点上，颜色与线一致
      if (showContourLabels.value && c.p.length) {
        let top = c.p[0]; for (const pt of c.p) if (pt[1] > top[1]) top = pt
        labels.push({ lon: top[0], lat: top[1], text: String(c.g), hpx: 0.022, color: '#ffffff', alt: 50 })
      }
    }
    if (showBore.value) for (const b of (d.bore || [])) dots.push({ lon: b[0], lat: b[1] })
    if (showBeamLabels.value && d.bore && d.bore[0]) {
      const nm = beamNames[r.id]
      labels.push({ lon: d.bore[0][0], lat: d.bore[0][1], text: (nm && nm.trim()) ? nm : r.beam })
    }
  }
  for (const e of elevationLines()) lines.push(e)
  const satBore = (datas[0] && datas[0].d.bore && datas[0].d.bore[0]) || null
  // 只要选了卫星，就始终显示该 GEO 卫星本体（即使未选波束）
  scene.setCoverage({ lines, dots, labels, satLon: s ? s.lon : null, satName: s ? s.displayName : null, satBore })
  covLegend.value = allG.length ? { gmin, gmax, type: covType.value } : null
  covStatus.value = ''
}
// 清除等值线/仰角线等，但保留选中的卫星（GEO 仍显示）
function clearCoverage() { selBeams.value = []; selGains.value = []; customGain.value = ''; elevText.value = ''; covLegend.value = null; redraw() }
function focusBeam() { const d = beamRows().find((r) => selBeams.value.includes(r.id)); if (!d) return; const data = covCache[d.file]; if (data && data.bore && data.bore[0]) { scene.faceLonLat(data.bore[0][0], data.bore[0][1]); autoRotate.value = false } }

// ===================== 标记 / 地面站 / 轨迹 =====================
const MK_KEY = 'globe3d/markers'
const mkOpen = ref(false)
const points = ref([])             // [{id,lat,lon}]
const stations = ref([])           // [{id,lat,lon,name}]
const trajectories = ref([])       // [{id,name,kind,pts:[{lat,lon}]}]
const activeTraj = ref('')         // 当前编辑的轨迹 id
const ptLat = ref(''), ptLon = ref('')
const stLat = ref(''), stLon = ref(''), stName = ref('')
const wpLat = ref(''), wpLon = ref('')
let mkSeq = 1
const newId = () => 'm' + Date.now().toString(36) + (mkSeq++)   // 跨会话唯一，避免与已存数据撞 key

// 经度在前、纬度在后，保留两位小数
const fmtLL = (lat, lon) => `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}, ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`
const validLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90
const validLon = (v) => Number.isFinite(v) && v >= -180 && v <= 180

function syncMarkers() {
  if (!scene) return
  scene.setMarkers(
    points.value.map((p) => ({ lat: p.lat, lon: p.lon, label: fmtLL(p.lat, p.lon) })),
    stations.value.map((s) => ({ lat: s.lat, lon: s.lon, name: s.name }))
  )
  scene.setTrajectories(trajectories.value.map((t) => ({ pts: t.pts, kind: t.kind, color: t.kind === 'flight' ? 0x5ad1ff : 0xff6a4a })))
  persistMarkers()
}
function persistMarkers() {
  try { localStorage.setItem(MK_KEY, JSON.stringify({ points: points.value, stations: stations.value, trajectories: trajectories.value })) } catch { /* ignore */ }
}
function loadMarkers() {
  try {
    const d = JSON.parse(localStorage.getItem(MK_KEY) || 'null')
    if (d) { points.value = d.points || []; stations.value = d.stations || []; trajectories.value = d.trajectories || [] }
  } catch { /* ignore */ }
}
function toggleMarkers() { mkOpen.value = !mkOpen.value }

function addPoint(lat, lon, face) {
  if (!validLat(lat) || !validLon(lon)) return
  points.value.push({ id: newId(), lat, lon }); syncMarkers()
  if (face && scene) { scene.faceLonLat(lon, lat); autoRotate.value = false }
}
function addPointInput() { addPoint(parseFloat(ptLat.value), parseFloat(ptLon.value)); ptLat.value = ''; ptLon.value = '' }
function removePoint(id) { points.value = points.value.filter((p) => p.id !== id); syncMarkers() }

function addStation() {
  const lat = parseFloat(stLat.value), lon = parseFloat(stLon.value)
  if (!validLat(lat) || !validLon(lon)) return
  stations.value.push({ id: newId(), lat, lon, name: (stName.value || '').trim() || '地面站' })
  stLat.value = ''; stLon.value = ''; stName.value = ''; syncMarkers()
}
function setStationName(id, v) { const s = stations.value.find((x) => x.id === id); if (s) { s.name = v; syncMarkers() } }
function removeStation(id) { stations.value = stations.value.filter((s) => s.id !== id); syncMarkers() }

function newTraj(kind) {
  const t = { id: newId(), name: (kind === 'flight' ? '飞行' : '航行') + trajectories.value.length, kind, pts: [] }
  trajectories.value.push(t); activeTraj.value = t.id
}
function curTraj() { return trajectories.value.find((t) => t.id === activeTraj.value) }
function addWaypoint() {
  const t = curTraj(); if (!t) return
  const lat = parseFloat(wpLat.value), lon = parseFloat(wpLon.value)
  if (!validLat(lat) || !validLon(lon)) return
  t.pts.push({ lat, lon }); wpLat.value = ''; wpLon.value = ''; syncMarkers()
}
function removeWaypoint(t, i) { t.pts.splice(i, 1); syncMarkers() }
function setTrajName(id, v) { const t = trajectories.value.find((x) => x.id === id); if (t) { t.name = v; persistMarkers() } }
function removeTraj(id) { trajectories.value = trajectories.value.filter((t) => t.id !== id); if (activeTraj.value === id) activeTraj.value = ''; syncMarkers() }
function clearAllMarkers() { points.value = []; stations.value = []; trajectories.value = []; activeTraj.value = ''; syncMarkers() }

const timeLabel = () => {
  if (live.value) return '实时'
  if (!timeOffset.value) return '此刻'
  const oh = Math.floor(timeOffset.value / 60), om = timeOffset.value % 60
  const d = calcAt(), p = (n) => String(n).padStart(2, '0')
  return `+${oh}h${p(om)}m · ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ===================== 持久化（记住分组 + 选中星） =====================
function saveSelection() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ groupIndex: groupIndex.value, selNorad: selEntry ? String(selEntry.noradId) : '' })) } catch { /* ignore */ }
}
function onGroup(e) {
  groupIndex.value = Number(e.target.value); clearSearch()
  loadGroup(); saveSelection()
}

// ===================== 全部选项/设置本地缓存（无感） =====================
const SETTINGS_KEY = 'globe3d/settings'
function snapshot() {
  return {
    nameMode: nameMode.value, showProvinces: showProvinces.value, autoRotate: autoRotate.value, live: live.value, beamLock: beamLock.value,
    covOpen: covOpen.value, mkOpen: mkOpen.value,
    cov: {
      sat: covSatFolder.value, band: covBand.value, type: covType.value,
      beams: selBeams.value.slice(), gains: selGains.value.slice(), custom: customGain.value,
      beamLabels: showBeamLabels.value, bore: showBore.value, contourLabels: showContourLabels.value,
      elev: elevText.value, names: { ...beamNames }
    }
  }
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot())) } catch { /* ignore */ } }
async function restoreSettings() {
  let s; try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') } catch { s = null }
  if (!s) return
  if (s.nameMode === 'zh' || s.nameMode === 'en' || s.nameMode === 'off') { nameMode.value = s.nameMode; scene.setLabelMode(nameMode.value) }
  if (typeof s.autoRotate === 'boolean') { autoRotate.value = s.autoRotate; scene.setAutoRotate(autoRotate.value) }
  if (typeof s.beamLock === 'boolean') beamLock.value = s.beamLock
  if (typeof s.mkOpen === 'boolean') mkOpen.value = s.mkOpen
  if (s.showProvinces) {
    showProvinces.value = true
    try { const mod = await import('../viz/globe3d/data/china-provinces.json'); scene.setProvinces(mod.default || mod); scene.setProvincesVisible(true); provincesLoaded = true } catch { /* ignore */ }
  }
  if (s.live) { live.value = true; if (!timer) timer = setInterval(refreshPositions, 1000) }
  const c = s.cov
  if (c && c.sat) {
    covOpen.value = !!s.covOpen
    await ensureCovIndex()
    if (curSat() || covSats.value.find((x) => x.folder === c.sat)) {
      covSatFolder.value = c.sat; covBand.value = c.band || 'all'; covType.value = c.type || 'EIRP'
      selBeams.value = Array.isArray(c.beams) ? c.beams : []
      selGains.value = Array.isArray(c.gains) ? c.gains : []
      customGain.value = c.custom || ''
      showBeamLabels.value = c.beamLabels !== false
      showBore.value = c.bore !== false
      showContourLabels.value = !!c.contourLabels
      elevText.value = c.elev || ''
      if (c.names) for (const k in c.names) beamNames[k] = c.names[k]
      redraw()
    }
  } else if (s.covOpen) { covOpen.value = true; await ensureCovIndex() }
}

// ===================== TLE 文件导入（兜底） =====================
function pickFile() { fileInput.value && fileInput.value.click() }
function onFile(e) {
  const f = e.target.files && e.target.files[0]; if (!f) return
  const reader = new FileReader()
  reader.onload = () => {
    const sats = parseOMMCsv(String(reader.result || ''))
    if (sats.length) ingest(sats, 'import', new Date().toISOString())
    else status.value = '文件解析失败：请用 CelesTrak「FORMAT=csv」的 OMM 文件'
  }
  reader.readAsText(f); e.target.value = ''
}

onMounted(async () => {
  scene = createGlobeScene(el.value)
  scene.setAutoRotate(autoRotate.value)
  scene.setLabelMode(nameMode.value)
  scene.setOnAutoRotateOff(() => { autoRotate.value = false })
  scene.setOnPick((index) => {
    if (index < 0) { closeCard(); return }
    const en = renderEntries[index]; if (!en) return
    selectSat(en, false)
  })
  // 鼠标实时经纬度（底部状态栏显示）+ 右键标点/加航点
  scene.setOnHover((ll) => { cursor.ll = ll })
  scene.setOnRightClick((ll) => {
    if (!ll) return
    if (!mkOpen.value) mkOpen.value = true
    const t = curTraj()
    if (t) { t.pts.push({ lat: ll.lat, lon: ll.lon }); syncMarkers() }   // 轨迹编辑中 -> 右键加航点
    else addPoint(ll.lat, ll.lon)                                          // 否则 -> 右键标点
  })
  loadMarkers(); syncMarkers()
  ro = new ResizeObserver(() => scene && scene.resize()); ro.observe(el.value)

  // 恢复上次分组 + 选中星
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    if (saved && Number.isInteger(saved.groupIndex) && saved.groupIndex >= 0 && saved.groupIndex < GROUPS.length) groupIndex.value = saved.groupIndex
    if (saved && saved.selNorad) { pendingNorad = saved.selNorad; pendingNoFace = true }
  } catch { /* ignore */ }

  await restoreSettings()   // 恢复全部选项/设置（无感）
  loadGroup()
  watch(snapshot, saveSettings, { deep: true })   // 此后任意改动自动本地缓存
})
onBeforeUnmount(() => { cursor.ll = null; if (timer) clearInterval(timer); if (ro) ro.disconnect(); if (scene) { scene.clearCoverage(); scene.destroy() } })
</script>

<template>
  <div class="g3">
    <div class="bar">
      <span class="t">星座地图 · 3D</span>
      <select :value="groupIndex" @change="onGroup">
        <option v-for="(g, i) in GROUPS" :key="g.key" :value="i">{{ g.label }}</option>
      </select>
      <div class="search">
        <input :value="keyword" placeholder="搜索卫星名 / 编号" @input="onSearch" />
        <span v-if="keyword" class="clr" @click="clearSearch">✕</span>
        <div v-if="searchResults.length" class="panel">
          <div v-for="item in searchResults" :key="item.noradId" class="item" @click="pickResult(item)">
            <div class="nm">{{ item.name }}</div>
            <div class="sub">{{ item.groupLabel }} · NORAD {{ item.noradId }}<span v-if="item.slot"> · {{ item.slot }}</span></div>
          </div>
        </div>
      </div>
      <span class="meta">在轨 {{ satCount }}<template v-if="shownCount && shownCount < satCount"> · 渲染 {{ shownCount }}</template>
        <template v-if="dataTime"> · OMM {{ dataTime }}</template>
        <template v-if="status"> · {{ status }}</template></span>
    </div>

    <div class="tl">
      <input type="range" min="0" max="1440" step="1" :value="timeOffset"
             @input="e => applyTime(Number(e.target.value))" :disabled="live" />
      <span class="tlab">{{ timeLabel() }}</span>
      <span class="st" :class="{ dis: live }" @click="step(-60)">−1h</span>
      <span class="st" :class="{ dis: live }" @click="step(-10)">−10m</span>
      <span class="st" :class="{ dis: live }" @click="step(-1)">−1m</span>
      <span class="st" :class="{ dis: live || !timeOffset }" @click="resetTime">此刻</span>
      <span class="st" :class="{ dis: live }" @click="step(1)">+1m</span>
      <span class="st" :class="{ dis: live }" @click="step(10)">+10m</span>
      <span class="st" :class="{ dis: live }" @click="step(60)">+1h</span>
    </div>

    <div class="beam">
      <template v-if="selected">
        <span class="bl">波束角</span>
        <input class="bi" :value="beam" :placeholder="beamAuto || '自动'" @input="onBeam" />
        <span class="bu">°</span>
        <span class="lock" :class="{ on: beamLock }" @click="toggleBeamLock">{{ beamLock ? '🔒' : '🔓' }}</span>
      </template>
      <span v-else class="hint">点击卫星设置波束角</span>
      <div class="toggles">
        <span v-if="covApiOk" class="mini" :class="{ on: covOpen }" @click="toggleCoverage">覆盖图（GXT）</span>
        <span class="mini" :class="{ on: mkOpen }" @click="toggleMarkers">标记</span>
        <span class="mini" :class="{ on: autoRotate }" @click="toggleRotate">{{ autoRotate ? '旋转中' : '旋转停' }}</span>
        <span class="mini" :class="{ on: showProvinces }" @click="toggleProvinces">省名</span>
        <span class="seg nseg">
          <span class="sg" :class="{ on: nameMode === 'zh' }" @click="setNameMode('zh')">中文</span>
          <span class="sg" :class="{ on: nameMode === 'en' }" @click="setNameMode('en')">英文</span>
          <span class="sg" :class="{ on: nameMode === 'off' }" @click="setNameMode('off')">不显示</span>
        </span>
        <span class="mini" :class="{ on: live }" @click="toggleLive">{{ live ? '实时开' : '实时关' }}</span>
      </div>
    </div>

    <div class="body">
      <div class="stage-wrap">
        <div ref="el" class="stage"></div>
        <div class="hint-fl">点击星点查看 · 拖动旋转 · 滚轮缩放 · 右键标点</div>

        <div v-if="!satCount && status" class="dl-banner">
          <div class="dl-msg">{{ status }}</div>
          <div class="dl-row">
            <button @click="loadGroup">重试下载</button>
            <button @click="pickFile">导入 TLE 文件(CSV)</button>
          </div>
          <input ref="fileInput" type="file" accept=".csv,.txt" style="display:none" @change="onFile" />
        </div>

        <div v-if="selected" class="card">
          <div class="ch">
            <span class="cn">{{ selected.name }}</span>
            <span v-if="selected.slot" class="cs">{{ selected.slot }}</span>
            <span class="cx" @click="closeCard">✕</span>
          </div>
          <div class="cg">
            <div class="kv"><span class="k">NORAD</span><span class="v">{{ selected.noradId }}</span></div>
            <div class="kv"><span class="k">高度</span><span class="v">{{ selected.alt }} km</span></div>
            <div class="kv"><span class="k">倾角</span><span class="v">{{ selected.incl }}°</span></div>
            <div class="kv"><span class="k">偏心率</span><span class="v">{{ selected.ecc }}</span></div>
            <div class="kv"><span class="k">惯性速度</span><span class="v">{{ selected.speedAbs }} km/s</span></div>
            <div class="kv"><span class="k">对地速度</span><span class="v">{{ selected.speedRel }} km/s</span></div>
            <div class="kv"><span class="k">周期</span><span class="v">{{ selected.period }} min</span></div>
            <div class="kv"><span class="k">近/远地点</span><span class="v">{{ selected.perigee }}/{{ selected.apogee }}</span></div>
            <div class="kv"><span class="k">Ω</span><span class="v">{{ selected.raan }}°</span></div>
            <div class="kv"><span class="k">ω</span><span class="v">{{ selected.argp }}°</span></div>
            <div class="kv wide"><span class="k">星下点</span><span class="v">{{ selected.lat }}, {{ selected.lon }}</span></div>
          </div>
        </div>
      </div>

      <div v-if="covOpen" class="cov-side">
        <div class="csh"><span class="csn">GEO 卫星覆盖（GXT）</span><span class="csx" @click="toggleCoverage">✕</span></div>

        <div class="sec">
          <div class="srow"><label>卫星</label>
            <select :value="covSatFolder" @change="onCovSat">
              <option value="" disabled>选择卫星</option>
              <option v-for="s in covSats" :key="s.folder" :value="s.folder">{{ s.displayName }}（{{ s.lon }}°）</option>
            </select>
          </div>
          <div class="srow"><label>频段</label>
            <select :value="covBand" @change="onCovBand" :disabled="!covSatFolder">
              <option value="all">全部频段</option>
              <option v-for="b in covBands()" :key="b" :value="b">{{ b }}</option>
            </select>
          </div>
          <div class="srow"><label>类型</label>
            <span class="seg">
              <span class="sg" :class="{ on: covType === 'EIRP' }" @click="setType('EIRP')">EIRP</span>
              <span class="sg" :class="{ on: covType === 'GT' }" @click="setType('GT')">G/T</span>
            </span>
          </div>
        </div>

        <div class="sec" v-if="covSatFolder">
          <div class="sect"><span>波束（可多选）</span>
            <span class="lnk" @click="allBeams(selBeams.length !== beamRows().length)">{{ selBeams.length === beamRows().length && beamRows().length ? '取消' : '全选' }}</span>
          </div>
          <div class="list">
            <label v-for="r in beamRows()" :key="r.id" class="chk">
              <input type="checkbox" :checked="selBeams.includes(r.id)" @change="toggleBeam(r.id)" />
              <span>{{ r.label }}</span>
            </label>
            <div v-if="!beamRows().length" class="empty">该频段/类型无波束</div>
          </div>
          <div class="cnt">已选 {{ selBeams.length }} 个波束<span class="lnk2" v-if="selBeams.length" @click="focusBeam">定位</span></div>
        </div>

        <div class="sec" v-if="selBeams.length">
          <div class="sect"><span>增益档位</span>
            <span class="lnk" @click="allGains(selGains.length !== unionGains().length)">{{ selGains.length === unionGains().length && unionGains().length ? '取消' : '全选' }}</span>
          </div>
          <div class="chips">
            <span v-for="g in unionGains()" :key="g" class="chip" :class="{ on: selGains.includes(g) }"
                  :style="selGains.includes(g) ? { borderColor: gainColorCss(g) } : {}"
                  @click="toggleGain(g)">{{ g }}</span>
          </div>
          <div class="srow"><label>自定义</label><input class="ci" :value="customGain" placeholder="如 48,52" @input="onCustomGain" /></div>
          <label class="chk2"><input type="checkbox" :checked="showBeamLabels" @change="toggleBeamLabels" /><span>显示波束名</span></label>
          <div v-if="showBeamLabels" class="bnlist">
            <div v-for="r in selectedBeamRows()" :key="r.id" class="bnrow">
              <span class="bntag">{{ r.label }}</span>
              <input class="bni" :value="beamNames[r.id] !== undefined ? beamNames[r.id] : r.beam"
                     :placeholder="r.beam" @input="e => setBeamName(r.id, e.target.value)" />
            </div>
          </div>
          <label class="chk2"><input type="checkbox" :checked="showBore" @change="toggleBore" /><span>显示波束中心</span></label>
          <label class="chk2"><input type="checkbox" :checked="showContourLabels" @change="toggleContourLabels" /><span>显示数值标签</span></label>
        </div>

        <div class="sec">
          <div class="sect"><span>等仰角线</span></div>
          <div class="srow"><label>仰角</label><input class="ci" :value="elevText" placeholder="如 5,10,20" @input="applyElev" /><span class="u">°</span></div>
          <div class="tip">GEO 卫星到地面的等仰角线（0–90°，逗号分隔）</div>
        </div>

        <div v-if="covLegend" class="legend">
          <div class="lt">{{ covLegend.type === 'GT' ? 'G/T (dB/K)' : 'EIRP (dBW)' }}</div>
          <div class="lbar"></div>
          <div class="lsc"><span>{{ covLegend.gmin }}</span><span>{{ covLegend.gmax }}</span></div>
        </div>

        <div class="csfoot">
          <span v-if="covStatus" class="cst">{{ covStatus }}</span>
          <span class="cclr" @click="clearCoverage">清除全部</span>
        </div>
      </div>

      <div v-if="mkOpen" class="cov-side mk-side">
        <div class="csh"><span class="csn">标记</span><span class="csx" @click="toggleMarkers">✕</span></div>

        <div class="sec">
          <div class="sect"><span>点标记</span></div>
          <div class="srow"><label>纬度</label><input class="ci" v-model="ptLat" placeholder="-90 ~ 90" /></div>
          <div class="srow"><label>经度</label><input class="ci" v-model="ptLon" placeholder="-180 ~ 180" /><span class="addb" @click="addPointInput">添加</span></div>
          <div class="tip">右键地图也可直接标点</div>
          <div class="mlist">
            <div v-for="p in points" :key="p.id" class="mrow"><span class="mc">{{ fmtLL(p.lat, p.lon) }}</span><span class="del" @click="removePoint(p.id)">✕</span></div>
          </div>
        </div>

        <div class="sec">
          <div class="sect"><span>地面站</span></div>
          <div class="srow"><label>纬度</label><input class="ci" v-model="stLat" placeholder="-90 ~ 90" /></div>
          <div class="srow"><label>经度</label><input class="ci" v-model="stLon" placeholder="-180 ~ 180" /></div>
          <div class="srow"><label>名称</label><input class="ci" v-model="stName" placeholder="如 北京站" /><span class="addb" @click="addStation">添加</span></div>
          <div class="mlist">
            <div v-for="s in stations" :key="s.id" class="mrow">
              <input class="sni" :value="s.name" @input="e => setStationName(s.id, e.target.value)" />
              <span class="mc2">{{ fmtLL(s.lat, s.lon) }}</span><span class="del" @click="removeStation(s.id)">✕</span>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sect"><span>轨迹</span>
            <span class="lnk" @click="newTraj('sea')">+航行</span>
            <span class="lnk" @click="newTraj('flight')">+飞行</span>
          </div>
          <div v-for="t in trajectories" :key="t.id" class="tcard" :class="{ act: activeTraj === t.id }">
            <div class="trow">
              <span class="tk" :class="t.kind"></span>
              <input class="tni" :value="t.name" @input="e => setTrajName(t.id, e.target.value)" />
              <span class="tsel" :class="{ on: activeTraj === t.id }" @click="activeTraj = t.id">{{ activeTraj === t.id ? '编辑中' : '编辑' }}</span>
              <span class="del" @click="removeTraj(t.id)">✕</span>
            </div>
            <div class="twp">
              <span v-for="(p, i) in t.pts" :key="i" class="wp">{{ p.lat.toFixed(1) }},{{ p.lon.toFixed(1) }}<span class="wdel" @click="removeWaypoint(t, i)">×</span></span>
              <span v-if="!t.pts.length" class="empty">无航点</span>
            </div>
          </div>
          <div v-if="activeTraj" class="srow">
            <label>航点</label>
            <input class="ci nrw" v-model="wpLat" placeholder="纬" />
            <input class="ci nrw" v-model="wpLon" placeholder="经" />
            <span class="addb" @click="addWaypoint">加点</span>
          </div>
          <div v-if="!trajectories.length" class="tip">+航行 / +飞行 新建轨迹，再加航点</div>
        </div>

        <div class="csfoot"><span class="cclr" @click="clearAllMarkers">清空全部</span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.g3 { display: flex; flex-direction: column; height: 100%; position: relative; }
.bar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--border); flex: none; font-size: 12.5px; }
.bar .t { font-family: var(--font-serif); font-size: 14px; }
.bar select { border: 1px solid var(--border); background: var(--bg); padding: 3px 8px; }
.search { position: relative; }
.search input { border: 1px solid var(--border); background: var(--bg); padding: 3px 8px; outline: none; width: 180px; }
.search .clr { position: absolute; right: 8px; top: 4px; cursor: pointer; color: var(--text-faint); }
.search .panel { position: absolute; top: 28px; left: 0; width: 260px; max-height: 260px; overflow: auto; background: var(--bg); border: 1px solid var(--border-strong); z-index: 5; }
.search .item { padding: 6px 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
.search .item:hover { background: var(--surface); }
.search .nm { font-size: 12.5px; }
.search .sub { color: var(--text-faint); font-size: 11px; }
.meta { margin-left: auto; color: var(--text-faint); }
.tl { display: flex; align-items: center; gap: 10px; padding: 6px 16px; border-bottom: 1px solid var(--border); flex: none; font-size: 11.5px; }
.tl input[type=range] { flex: 1; }
.tlab { font-family: var(--font-mono); min-width: 150px; color: var(--text-muted); }
.tl .st { padding: 2px 8px; border: 1px solid var(--border); cursor: pointer; color: var(--text-muted); }
.tl .st.dis { opacity: 0.4; pointer-events: none; }
.beam { display: flex; align-items: center; gap: 8px; padding: 6px 16px; border-bottom: 1px solid var(--border); flex: none; font-size: 12.5px; }
.beam .bl { color: var(--text-muted); }
.beam .bi { width: 60px; border: 0; border-bottom: 1px solid var(--border-strong); background: transparent; outline: none; color: var(--text); }
.beam .lock { cursor: pointer; }
.beam .hint { color: var(--text-faint); }
.toggles { margin-left: auto; display: flex; gap: 8px; }
.mini { padding: 3px 10px; border: 1px solid var(--border); cursor: pointer; color: var(--text-muted); }
.mini.on { color: var(--text); border-color: var(--accent); }
.body { flex: 1; min-height: 0; display: flex; }
.stage-wrap { flex: 1; min-width: 0; position: relative; }
.stage { width: 100%; height: 100%; background: #070b12; }
.hint-fl { position: absolute; right: 14px; bottom: 10px; font-size: 11px; color: #6b7686; }
.dl-banner { position: absolute; left: 50%; top: 55%; transform: translate(-50%, -50%); width: 420px; max-width: 86%; background: rgba(20,22,28,0.94); border: 1px solid #34384a; border-radius: 6px; padding: 16px 18px; color: #d7dde6; text-align: center; }
.dl-msg { font-size: 13px; margin-bottom: 12px; color: #f0c674; line-height: 1.5; }
.dl-row { display: flex; gap: 10px; justify-content: center; }
.dl-row button { border: 1px solid #4a5168; background: #1c2230; color: #d7dde6; padding: 6px 14px; cursor: pointer; border-radius: 4px; font-size: 12.5px; }
.dl-row button:hover { border-color: #6b7490; }
.card { position: absolute; right: 14px; top: 14px; width: 240px; background: var(--bg); border: 1px solid var(--border-strong); padding: 10px 12px; }
.ch { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cn { font-family: var(--font-serif); font-size: 14px; }
.cs { font-size: 11px; color: var(--text-muted); }
.cx { margin-left: auto; cursor: pointer; color: var(--text-faint); }
.cg { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 12px; font-size: 11.5px; }
.kv { display: flex; justify-content: space-between; gap: 6px; }
.kv.wide { grid-column: 1 / 3; }
.kv .k { color: var(--text-muted); }
.kv .v { font-family: var(--font-mono); }

/* 覆盖图：右侧停靠面板（挤压地球，独占右栏） */
.cov-side { width: 286px; flex: none; border-left: 1px solid var(--border-strong); background: var(--bg); overflow-y: auto; display: flex; flex-direction: column; font-size: 12px; }
.csh { display: flex; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.csn { font-family: var(--font-serif); font-size: 14px; }
.csx { margin-left: auto; cursor: pointer; color: var(--text-faint); }
.sec { padding: 10px 12px; border-bottom: 1px solid var(--border); }
.srow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.srow:last-child { margin-bottom: 0; }
.srow label { color: var(--text-muted); width: 36px; flex: none; }
.srow select, .srow .ci { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 3px 6px; font-size: 12px; outline: none; color: var(--text); }
.srow .u { color: var(--text-muted); }
.seg { display: flex; border: 1px solid var(--border); }
.seg .sg { padding: 3px 12px; cursor: pointer; color: var(--text-muted); }
.seg .sg.on { background: var(--accent); color: #fff; }
.nseg { font-size: 12px; }
.nseg .sg { padding: 3px 8px; }
.nseg .sg + .sg { border-left: 1px solid var(--border); }
.sect { display: flex; align-items: center; margin-bottom: 6px; color: var(--text-muted); }
.sect .lnk { margin-left: auto; color: var(--accent); cursor: pointer; font-size: 11.5px; }
.list { max-height: 150px; overflow-y: auto; border: 1px solid var(--border); padding: 4px 6px; }
.chk { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; }
.chk input, .chk2 input { accent-color: var(--accent); }
.empty { color: var(--text-faint); padding: 4px 0; }
.cnt { margin-top: 6px; color: var(--text-faint); font-size: 11.5px; }
.cnt .lnk2 { margin-left: 8px; color: var(--accent); cursor: pointer; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; max-height: 120px; overflow-y: auto; }
.chip { padding: 2px 7px; border: 1px solid var(--border); cursor: pointer; color: var(--text-muted); font-family: var(--font-mono); font-size: 11px; }
.chip.on { color: var(--text); }
.chk2 { display: flex; align-items: center; gap: 6px; margin-top: 8px; cursor: pointer; }
.bnlist { margin: 6px 0 2px; display: flex; flex-direction: column; gap: 5px; }
.bnrow { display: flex; align-items: center; gap: 6px; }
.bntag { flex: none; max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 11px; }
.bni { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 2px 6px; font-size: 11.5px; outline: none; color: var(--text); }
.bni:focus { border-color: var(--accent); }
.tip { color: var(--text-faint); font-size: 11px; margin-top: 4px; line-height: 1.5; }
.legend { padding: 10px 12px; }
.legend .lt { font-size: 11px; color: var(--text-muted); margin-bottom: 3px; }
.legend .lbar { height: 10px; border: 1px solid var(--border); background: linear-gradient(to right, hsl(240,90%,55%), hsl(180,90%,55%), hsl(120,90%,55%), hsl(60,90%,55%), hsl(0,90%,55%)); }
.legend .lsc { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.csfoot { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
.cst { font-size: 11px; color: var(--text-faint); }
.cclr { margin-left: auto; font-size: 11.5px; color: var(--text-muted); border: 1px solid var(--border); padding: 3px 10px; cursor: pointer; }
.cclr:hover { border-color: var(--accent); color: var(--text); }

/* 标记面板 */
.addb { flex: none; border: 1px solid var(--accent); color: var(--accent); padding: 2px 8px; cursor: pointer; font-size: 11.5px; }
.addb:hover { background: var(--accent); color: #fff; }
.ci.nrw { width: 0; }
.mlist { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; max-height: 150px; overflow-y: auto; }
.mrow { display: flex; align-items: center; gap: 6px; }
.mrow .mc { flex: 1; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); }
.mrow .mc2 { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-faint); }
.mrow .sni { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 2px 6px; font-size: 11.5px; outline: none; color: var(--text); }
.del { flex: none; cursor: pointer; color: var(--text-faint); padding: 0 2px; }
.del:hover { color: #e26a6a; }
.tcard { border: 1px solid var(--border); padding: 6px; margin-bottom: 6px; }
.tcard.act { border-color: var(--accent); }
.trow { display: flex; align-items: center; gap: 6px; }
.trow .tk { width: 10px; height: 10px; flex: none; border-radius: 2px; }
.trow .tk.sea { background: #ff6a4a; }
.trow .tk.flight { background: #5ad1ff; }
.trow .tni { flex: 1; min-width: 0; border: 0; border-bottom: 1px solid var(--border); background: transparent; outline: none; color: var(--text); font-size: 12px; }
.trow .tsel { flex: none; font-size: 11px; color: var(--text-muted); border: 1px solid var(--border); padding: 1px 7px; cursor: pointer; }
.trow .tsel.on { color: var(--accent); border-color: var(--accent); }
.twp { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.twp .wp { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); border: 1px solid var(--border); padding: 1px 5px; }
.twp .wdel { margin-left: 4px; cursor: pointer; color: var(--text-faint); }
.twp .wdel:hover { color: #e26a6a; }
</style>
