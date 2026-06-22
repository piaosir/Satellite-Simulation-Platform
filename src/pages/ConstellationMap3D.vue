<script setup>
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { cursor } from '../stores/cursor'
defineOptions({ inheritAttrs: false })   // 不把父级传入的 title 落到根节点（去掉鼠标悬停的“星座3D”原生提示）
import { createGlobeScene } from '../viz/globe3d/scene.js'
import { createFlatCoverage } from '../viz/flatmap/flatCoverage.js'
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
const flatCanvas = ref(null)       // 平面覆盖图 canvas
const flatView = ref(false)        // 平面图 / 球体 切换
let flat = null                    // 平面渲染器实例
let covGeom = { lines: [], dots: [], labels: [], sats: [] }   // 覆盖几何（3D 与 平面图共用）
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
let provincesData = null
const timeOffset = ref(0)   // 分钟，0~1440（未来 24h）
const timePct = ref(0)
const keyword = ref('')
const searchResults = ref([])
const selected = ref(null)
// 波束角
const beam = ref('')
const beamAuto = ref('')
const beamLock = ref(false)
const geoOpen = ref(false)         // 地名设置面板开关
const apiOk = typeof window !== 'undefined' && !!(window.api && window.api.omm)
const covApiOk = typeof window !== 'undefined' && !!(window.api && window.api.coverage)

// ===================== 覆盖图（GEO 卫星，两级模型：卫星 → 批次） =====================
// covItems: 已添加的卫星 [{ folder, type:'EIRP'|'GT', band:'all'|频段, batches:[batch] }]
//   batch: { id, name, beams:[beamId], gains:[number], custom:'', mode:'gradient'|'solid'|'perGain', solid:'#hex', gainColors:{gain:'#hex'} }
const covOpen = ref(false)        // 右侧覆盖面板开关
const covSats = ref([])           // 索引：[{folder,displayName,satName,lon,beams:[{band,beam,type,gains,file}...]}]
const covItems = ref([])          // 已添加卫星（两级结构）
const covAddSel = ref('')         // 「添加卫星」下拉临时值
const showBeamLabels = ref(true)
const beamLabelSize = ref(16)     // 波束名字号（6–32，内部映射为标签 hpx）
const showBore = ref(true)        // 波束中心点
const boreSize = ref(5)           // 波束中心点大小（1–12，映射球半径）
const showContourLabels = ref(false) // 等值线数值标签
const contourLabelSize = ref(12)  // 数值标签字号（2–20）
const countryNameSize = ref(1)    // 国家名/大洋名字号倍率（0.6–2.0）
const provNameSize = ref(1)       // 省名字号倍率（0.6–2.0）
const elevText = ref('')          // 等仰角线，如 "5,10"
const covStatus = ref('')
const covLegend = ref([])         // [{ name, mode, gmin, gmax, type, solid }]
let covLoaded = false
const covCache = {}               // file -> 数据（避免重复加载）
let covSeq = 0                    // 卫星/批次唯一 id
const newCovId = () => 'c' + (++covSeq)
let covColorCursor = 0           // 新批次默认配色游标
const DEF_COLORS = [0xff5a5a, 0x5ad1ff, 0xffd24a, 0x7cff8a, 0xc78bff, 0xff9a5a, 0x66ddff, 0xff6fae]

const clamp01 = (v) => Math.max(0, Math.min(1, v))
// HSL(蓝→红) -> 0xRRGGBB（按增益强弱渐变，供 three 线条用）
function gainHex(t) {
  const h = (1 - clamp01(t)) * 240 / 360, s = 0.9, l = 0.55, a = s * Math.min(l, 1 - l)
  const f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255)
}
const hexToCss = (n) => '#' + (n & 0xffffff).toString(16).padStart(6, '0')
const cssToHex = (s) => { const n = parseInt(String(s || '').replace('#', ''), 16); return Number.isFinite(n) ? n : 0xff5a5a }
const parseNums = (s) => String(s || '').split(/[,，\s]+/).map((x) => parseFloat(x)).filter((x) => Number.isFinite(x))

// ---- 两级模型查询辅助 ----
const idxOf = (folder) => covSats.value.find((x) => x.folder === folder)
function itemBands(it) { const s = idxOf(it.folder); if (!s) return []; return [...new Set(s.beams.filter((b) => b.type === it.type).map((b) => b.band))] }
// 提取波束名里的第一个整数作为波束号（CS26 "1 拉萨"→1、CS19 "Beam No.10"→10；无号→Infinity）
const beamNum = (s) => { const m = String(s).match(/\d+/); return m ? parseInt(m[0], 10) : Infinity }
// 某卫星在其 type/band 过滤下的波束行（按波束号升序，无号者保持原序置后，并标 1-based 序号 seq）
function beamRowsOf(it) {
  const s = idxOf(it.folder); if (!s) return []
  const map = new Map()
  for (const b of s.beams) {
    if (b.type !== it.type) continue
    if (it.band !== 'all' && b.band !== it.band) continue
    const id = b.band + '|' + b.beam
    if (!map.has(id)) map.set(id, { id, band: b.band, beam: b.beam, label: `${b.band}·${b.beam}`, file: b.file, gains: b.gains || [] })
  }
  const rows = [...map.values()]
  rows.sort((a, b) => beamNum(a.beam) - beamNum(b.beam))   // Array.sort 稳定：同号/无号保持原序
  rows.forEach((r, i) => { r.seq = i + 1 })
  return rows
}
// 搜索词若是纯序号语法（如 "1-62"、"1,3,5"、"1-10,20-30"）则返回序号集合，否则 null
function parseSeqSet(q) {
  const set = new Set()
  for (const part of q.split(/[,，\s]+/)) {
    if (!part) continue
    const m = part.match(/^(\d+)\s*[-~]\s*(\d+)$/)
    if (m) { const a = +m[1], b = +m[2]; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i) }
    else if (/^\d+$/.test(part)) set.add(+part)
    else return null   // 含非序号字符 -> 当作文字搜索
  }
  return set.size ? set : null
}
const beamRowGains = (it, id) => { const r = beamRowsOf(it).find((x) => x.id === id); return r ? r.gains : [] }
// 按批次搜索词过滤波束行：纯序号语法（"1-62" 等）按序号选，否则按 label/beam 名（大小写不敏感）
function filteredBeamRows(it, ba) {
  const q = (ba.q || '').trim()
  const rows = beamRowsOf(it)
  if (!q) return rows
  const seqSet = parseSeqSet(q)
  if (seqSet) return rows.filter((r) => seqSet.has(r.seq))
  const ql = q.toLowerCase()
  return rows.filter((r) => r.label.toLowerCase().includes(ql) || r.beam.toLowerCase().includes(ql))
}
// 当前过滤结果是否已全选（用于全选/取消按钮文案）
const allFilteredOn = (it, ba) => { const rows = filteredBeamRows(it, ba); return rows.length > 0 && rows.every((r) => ba.beams.includes(r.id)) }
// 批次已选波束的增益档并集（供档位 chips）
function batchGains(it, ba) {
  const set = new Set()
  for (const r of beamRowsOf(it)) if (ba.beams.includes(r.id)) for (const g of r.gains) set.add(g)
  return [...set].sort((a, b) => a - b)
}
// 批次生效的增益档（含自定义输入）
function batchEffGains(ba) {
  const set = new Set(ba.gains)
  for (const v of parseNums(ba.custom)) set.add(v)
  return set
}
// 单条等值线最终颜色（按批次统一配色模式）
function contourColor(ba, g, gmin, gmax) {
  if (ba.mode === 'solid') return cssToHex(ba.solid)
  if (ba.mode === 'perGain') { const c = ba.gainColors && ba.gainColors[g]; if (c) return cssToHex(c) }
  const t = gmax > gmin ? (g - gmin) / (gmax - gmin) : 1
  return gainHex(t)
}
// 面板里某增益档的色块色（与地图同一套取值）
function gainSwatchCss(ba, g) {
  const arr = [...batchEffGains(ba)]
  const gmin = arr.length ? Math.min(...arr) : 0, gmax = arr.length ? Math.max(...arr) : 1
  return hexToCss(contourColor(ba, g, gmin, gmax))
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
function setNameMode(m) { nameMode.value = m; scene && scene.setLabelMode(m); if (flat) flat.setNameMode(m) }
async function toggleProvinces() {
  showProvinces.value = !showProvinces.value
  if (showProvinces.value && !provincesLoaded) {
    try { const mod = await import('../viz/globe3d/data/china-provinces.json'); provincesData = mod.default || mod; scene && scene.setProvinces(provincesData); if (flat) flat.setProvinces(provincesData); provincesLoaded = true }
    catch (e) { /* 省界数据缺失 */ }
  }
  scene && scene.setProvincesVisible(showProvinces.value)
  if (flat) flat.setProvincesVisible(showProvinces.value)
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
// 球体 <-> 平面覆盖图 切换
async function toggleFlat() {
  flatView.value = !flatView.value
  if (!flatView.value) return
  await ensureCovIndex(); redraw()
  await nextTick()
  if (!flat && flatCanvas.value) flat = createFlatCoverage(flatCanvas.value)
  if (flat) {
    flat.resize()
    flat.setNameMode(nameMode.value)
    if (provincesData) flat.setProvinces(provincesData)
    flat.setProvincesVisible(showProvinces.value)
    flat.setMarkers(
      points.value.map((p) => ({ lat: p.lat, lon: p.lon, label: fmtLL(p.lat, p.lon) })),
      stations.value.map((s) => ({ lat: s.lat, lon: s.lon, name: s.name })),
      trajectories.value.map((t) => ({ pts: t.pts, kind: t.kind, color: t.kind === 'flight' ? 0x5ad1ff : 0xff6a4a }))
    )
    flat.setSizes({ beamFont: beamLabelSize.value, contourFont: contourLabelSize.value, dotSize: boreSize.value, showBore: showBore.value, nameScale: countryNameSize.value, provScale: provNameSize.value, ptFont: markPtFont.value, stIcon: stIconSize.value, stFont: stFontSize.value })
    flat.setGeom(covGeom)
  }
}

// ---- 批次 / 卫星 增删改 ----
function newBatch() {
  const color = hexToCss(DEF_COLORS[covColorCursor++ % DEF_COLORS.length])
  return { id: newCovId(), name: '', q: '', beams: [], gains: [], custom: '', mode: 'gradient', solid: color, gainColors: {}, width: 1.6 }
}
function addCovSat() {
  const folder = covAddSel.value; if (!folder) return
  covAddSel.value = ''
  if (covItems.value.find((i) => i.folder === folder)) return   // 已添加则跳过
  const idx = idxOf(folder); if (!idx) return
  covItems.value.push({ id: newCovId(), folder, type: 'EIRP', band: 'all', batches: [newBatch()] })
  redraw()
}
function removeCovSat(it) { const i = covItems.value.indexOf(it); if (i >= 0) covItems.value.splice(i, 1); redraw() }
function setItemType(it, t) {
  if (it.type === t) return
  it.type = t; it.band = 'all'
  for (const ba of it.batches) { ba.beams = []; ba.gains = [] }
  redraw()
}
function onItemBand(it, e) {
  it.band = e.target.value
  const ids = beamRowsOf(it).map((r) => r.id)
  for (const ba of it.batches) { ba.beams = ba.beams.filter((id) => ids.includes(id)); ba.gains = batchGains(it, ba) }
  redraw()
}
function addBatch(it) { it.batches.push(newBatch()); redraw() }
function removeBatch(it, ba) { const i = it.batches.indexOf(ba); if (i >= 0) it.batches.splice(i, 1); redraw() }
function setBatchName(it, ba, e) { ba.name = e.target.value }
function focusCovSat(it) { const idx = idxOf(it.folder); if (idx && idx.lon != null) { scene.faceLonLat(idx.lon, 0); autoRotate.value = false } }

// 批次内设置统一作用于全部波束。增删波束时【保留已选增益档】（新增的波束并入其档，删除的仅去掉失效档）
function toggleBatchBeam(it, ba, id) {
  const i = ba.beams.indexOf(id)
  if (i >= 0) {
    ba.beams.splice(i, 1)
    const all = new Set(batchGains(it, ba))
    ba.gains = ba.gains.filter((g) => all.has(g))                                  // 删波束：保留已选，仅去掉已不可选的档
  } else {
    ba.beams.push(id)
    ba.gains = [...new Set([...ba.gains, ...beamRowGains(it, id)])].sort((a, b) => a - b)   // 加波束：并入新档，保留已选
  }
  redraw()
}
function onBatchQuery(it, ba, e) { ba.q = e.target.value }   // 仅过滤波束列表，无需重绘
// 全选/取消：作用于【当前过滤结果】，可多次累加，便于在大量波束里分批多选
function allBatchBeams(it, ba, on) {
  const rows = filteredBeamRows(it, ba)
  if (on) {
    const bset = new Set(ba.beams), gset = new Set(ba.gains)
    for (const r of rows) { bset.add(r.id); for (const g of r.gains) gset.add(g) }
    ba.beams = [...bset]; ba.gains = [...gset].sort((a, b) => a - b)
  } else {
    const rem = new Set(rows.map((r) => r.id))
    ba.beams = ba.beams.filter((id) => !rem.has(id))
    const all = new Set(batchGains(it, ba))
    ba.gains = ba.gains.filter((g) => all.has(g))
  }
  redraw()
}
// 反选：对当前过滤结果取反
function invertBatchBeams(it, ba) {
  const rows = filteredBeamRows(it, ba)
  const sel = new Set(ba.beams), gset = new Set(ba.gains)
  for (const r of rows) { if (sel.has(r.id)) sel.delete(r.id); else { sel.add(r.id); for (const g of r.gains) gset.add(g) } }
  ba.beams = [...sel]
  const all = new Set(batchGains(it, ba))
  ba.gains = [...gset].filter((g) => all.has(g)).sort((a, b) => a - b)
  redraw()
}
function toggleBatchGain(it, ba, g) { const i = ba.gains.indexOf(g); if (i >= 0) ba.gains.splice(i, 1); else ba.gains.push(g); redraw() }
function allBatchGains(it, ba, on) { ba.gains = on ? batchGains(it, ba) : []; redraw() }
function onBatchCustom(it, ba, e) { ba.custom = e.target.value; redraw() }
function setBatchMode(it, ba, m) { if (ba.mode === m) return; ba.mode = m; redraw() }
function onBatchSolid(it, ba, e) { ba.solid = e.target.value; redraw() }
function onGainColor(it, ba, g, e) { ba.gainColors[g] = e.target.value; redraw() }
function onBatchWidth(it, ba, e) { ba.width = Number(e.target.value); redraw() }

function toggleBeamLabels() { showBeamLabels.value = !showBeamLabels.value; redraw() }
function setBeamFont(e) { beamLabelSize.value = Number(e.target.value); redraw() }
function setBoreSize(e) { boreSize.value = Number(e.target.value); redraw() }
function setContourSize(e) { contourLabelSize.value = Number(e.target.value); redraw() }
function applyNameScale() { if (scene) scene.setNameScale(countryNameSize.value, provNameSize.value); if (flat) flat.setSizes({ nameScale: countryNameSize.value, provScale: provNameSize.value }) }
function setCountryNameSize(e) { countryNameSize.value = Number(e.target.value); applyNameScale() }
function setProvNameSize(e) { provNameSize.value = Number(e.target.value); applyNameScale() }
function setPtFont(e) { markPtFont.value = Number(e.target.value); syncMarkers() }
function setStIcon(e) { stIconSize.value = Number(e.target.value); syncMarkers() }
function setStFont(e) { stFontSize.value = Number(e.target.value); syncMarkers() }
function toggleBore() { showBore.value = !showBore.value; redraw() }
function toggleContourLabels() { showContourLabels.value = !showContourLabels.value; redraw() }
function applyElev(e) { elevText.value = e.target.value; redraw() }

// 等仰角线：GEO 卫星(赤道, satLon)下，仰角 El 对应地心角 γ=acos(k·cosEl)−El（k=Re/Rs）。
// 等仰角线 = 以星下点(0,satLon)为心、角半径 γ 的地表小圆。
function elevationLines() {
  const els = parseNums(elevText.value); if (!els.length || !covItems.value.length) return []
  const Re = 6378.137, Rs = 42164.0, k = Re / Rs, out = []
  const lons = [...new Set(covItems.value.map((it) => { const s = idxOf(it.folder); return s ? s.lon : null }).filter((v) => v != null))]
  for (const lon of lons) for (const el of els) {
    if (!(el > 0 && el < 90)) continue
    const elR = el * Math.PI / 180, cosElk = k * Math.cos(elR)
    if (Math.abs(cosElk) > 1) continue
    const gamma = Math.acos(cosElk) - elR
    if (gamma <= 0 || gamma >= Math.PI / 2) continue
    out.push({ p: circleLonLatArr(0, lon, gamma, 160), color: 0x66ddff, opacity: 0.9 })
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
  const lines = [], dots = [], labels = [], sats = [], bores = [], legend = []
  let loading = false
  for (const it of covItems.value) {
    const idx = idxOf(it.folder); if (!idx) continue
    sats.push({ lon: idx.lon, name: idx.displayName })
    const rowById = new Map(beamRowsOf(it).map((r) => [r.id, r]))
    for (const ba of it.batches) {
      const eff = batchEffGains(ba)   // 批次统一生效增益档；空=不画等值线
      // 加载该批次波束数据（带缓存）
      const datas = []
      for (const id of ba.beams) {
        const r = rowById.get(id); if (!r) continue
        try {
          if (!covCache[r.file]) { loading = true; covStatus.value = '加载覆盖…'; covCache[r.file] = await window.api.coverage.get(r.file) }
          datas.push({ r, d: covCache[r.file] })
        } catch (e) { /* skip */ }
      }
      if (seq !== redrawSeq) return   // 已被更新的重绘取代
      const allG = []
      for (const { d } of datas) for (const c of d.contours) if (eff.has(c.g)) allG.push(c.g)
      const gmin = allG.length ? Math.min(...allG) : 0, gmax = allG.length ? Math.max(...allG) : 1
      for (const { r, d } of datas) {
        for (const c of d.contours) {
          if (!eff.has(c.g)) continue
          lines.push({ p: c.p, color: contourColor(ba, c.g, gmin, gmax), width: ba.width })
          if (showContourLabels.value && c.p.length) {
            let top = c.p[0]; for (const pt of c.p) if (pt[1] > top[1]) top = pt
            labels.push({ lon: top[0], lat: top[1], text: String(c.g), hpx: contourLabelSize.value / 533, color: '#ffffff', alt: 50 })
          }
        }
        if (showBore.value) for (const b of (d.bore || [])) { dots.push({ lon: b[0], lat: b[1] }); bores.push({ lon: b[0], lat: b[1], satLon: idx.lon }) }
        if (showBeamLabels.value && d.bore && d.bore[0]) labels.push({ lon: d.bore[0][0], lat: d.bore[0][1], text: r.beam, hpx: beamLabelSize.value / 533 })
      }
      if (allG.length) legend.push({ name: (ba.name && ba.name.trim()) ? ba.name : idx.displayName, mode: ba.mode, gmin, gmax, type: it.type, solid: ba.solid })
    }
  }
  for (const e of elevationLines()) lines.push(e)
  scene.setCoverage({ lines, dots, labels, sats, bores, dotR: boreSize.value * 0.0014 })
  covGeom = { lines, dots, labels, sats }   // 平面图共用同一份几何（不含卫星连线 bores）
  if (flat) { flat.setSizes({ beamFont: beamLabelSize.value, contourFont: contourLabelSize.value, dotSize: boreSize.value, showBore: showBore.value, nameScale: countryNameSize.value, provScale: provNameSize.value }); flat.setGeom(covGeom) }
  covLegend.value = legend
  if (!loading) covStatus.value = ''
}
// 清空所有覆盖卫星与批次
function clearCoverage() { covItems.value = []; covLegend.value = []; elevText.value = ''; covStatus.value = ''; redraw() }

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
const markPtFont = ref(14)         // 点标记坐标字号（6–32）
const stIconSize = ref(32)         // 地面站图标大小（16–60）
const stFontSize = ref(17)         // 地面站名称字号（6–32）
let mkSeq = 1
const newId = () => 'm' + Date.now().toString(36) + (mkSeq++)   // 跨会话唯一，避免与已存数据撞 key

// 经度在前、纬度在后，保留两位小数
const fmtLL = (lat, lon) => `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}, ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`
const validLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90
const validLon = (v) => Number.isFinite(v) && v >= -180 && v <= 180

const markSizes = () => ({ ptFont: markPtFont.value, stIcon: stIconSize.value, stFont: stFontSize.value })
function syncMarkers() {
  if (!scene) return
  const pts = points.value.map((p) => ({ lat: p.lat, lon: p.lon, label: fmtLL(p.lat, p.lon) }))
  const sts = stations.value.map((s) => ({ lat: s.lat, lon: s.lon, name: s.name }))
  const trs = trajectories.value.map((t) => ({ pts: t.pts, kind: t.kind, color: t.kind === 'flight' ? 0x5ad1ff : 0xff6a4a }))
  scene.setMarkers(pts, sts, markSizes()); scene.setTrajectories(trs)
  if (flat) { flat.setMarkers(pts, sts, trs); flat.setSizes(markSizes()) }
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
function toggleGeo() { geoOpen.value = !geoOpen.value }

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
// 批次内设置统一，但持久化时按波束各存一份（每条波束记录自带其增益档/颜色/线粗，便于波束级追溯）
function serializeCov() {
  return covItems.value.map((it) => ({
    id: it.id, folder: it.folder, type: it.type, band: it.band,
    batches: it.batches.map((ba) => ({
      id: ba.id, name: ba.name,
      beams: ba.beams.map((bid) => ({
        id: bid, gains: ba.gains.slice(), custom: ba.custom,
        mode: ba.mode, solid: ba.solid, gainColors: { ...ba.gainColors }, width: ba.width
      }))
    }))
  }))
}
// 反序列化：把按波束存的记录还原为运行时的批次统一设置（取该批首个波束记录为准）
function deserializeCov(items) {
  return (items || []).filter((it) => it && idxOf(it.folder)).map((it) => ({
    id: it.id, folder: it.folder, type: it.type || 'EIRP', band: it.band || 'all',
    batches: (it.batches || []).map((ba) => {
      const bms = ba.beams || [], f = bms[0] || {}
      return {
        id: ba.id, name: ba.name || '', q: '',
        beams: bms.map((b) => (typeof b === 'string' ? b : b.id)),
        gains: Array.isArray(f.gains) ? f.gains : [], custom: f.custom || '',
        mode: f.mode || 'gradient', solid: f.solid || '#ff5a5a',
        gainColors: f.gainColors || {}, width: Number.isFinite(f.width) ? f.width : 1.6
      }
    })
  }))
}
function snapshot() {
  return {
    nameMode: nameMode.value, countryName: countryNameSize.value, provName: provNameSize.value, showProvinces: showProvinces.value, autoRotate: autoRotate.value, live: live.value, beamLock: beamLock.value,
    mkPt: markPtFont.value, mkStIcon: stIconSize.value, mkStFont: stFontSize.value,
    covOpen: covOpen.value, mkOpen: mkOpen.value, geoOpen: geoOpen.value,
    cov: {
      items: serializeCov(),
      beamLabels: showBeamLabels.value, beamFont: beamLabelSize.value, bore: showBore.value, boreSize: boreSize.value,
      contourLabels: showContourLabels.value, contourSize: contourLabelSize.value,
      elev: elevText.value
    }
  }
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot())) } catch { /* ignore */ } }
async function restoreSettings() {
  let s; try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') } catch { s = null }
  if (!s) return
  if (s.nameMode === 'zh' || s.nameMode === 'en' || s.nameMode === 'off') { nameMode.value = s.nameMode; scene.setLabelMode(nameMode.value) }
  if (Number.isFinite(s.countryName)) countryNameSize.value = s.countryName
  else if (Number.isFinite(s.geoName)) countryNameSize.value = s.geoName   // 兼容旧字段
  if (Number.isFinite(s.provName)) provNameSize.value = s.provName
  else if (Number.isFinite(s.geoName)) provNameSize.value = s.geoName
  scene.setNameScale(countryNameSize.value, provNameSize.value)
  if (Number.isFinite(s.mkPt)) markPtFont.value = s.mkPt
  if (Number.isFinite(s.mkStIcon)) stIconSize.value = s.mkStIcon
  if (Number.isFinite(s.mkStFont)) stFontSize.value = s.mkStFont
  syncMarkers()   // 以恢复后的尺寸重建标记
  if (typeof s.autoRotate === 'boolean') { autoRotate.value = s.autoRotate; scene.setAutoRotate(autoRotate.value) }
  if (typeof s.beamLock === 'boolean') beamLock.value = s.beamLock
  if (typeof s.mkOpen === 'boolean') mkOpen.value = s.mkOpen
  if (typeof s.geoOpen === 'boolean') geoOpen.value = s.geoOpen
  if (s.showProvinces) {
    showProvinces.value = true
    try { const mod = await import('../viz/globe3d/data/china-provinces.json'); provincesData = mod.default || mod; scene.setProvinces(provincesData); scene.setProvincesVisible(true); provincesLoaded = true } catch { /* ignore */ }
  }
  if (s.live) { live.value = true; if (!timer) timer = setInterval(refreshPositions, 1000) }
  const c = s.cov
  if (c && Array.isArray(c.items) && c.items.length) {
    covOpen.value = !!s.covOpen
    await ensureCovIndex()
    // 仅恢复索引中仍存在的卫星；同步 id 游标避免冲突
    const items = deserializeCov(c.items)
    for (const it of items) {
      const ids = [it.id, ...(it.batches || []).map((b) => b.id)].map((x) => parseInt(String(x).replace(/\D/g, ''), 10)).filter(Number.isFinite)
      for (const n of ids) if (n > covSeq) covSeq = n
    }
    covItems.value = items
    showBeamLabels.value = c.beamLabels !== false
    if (Number.isFinite(c.beamFont)) beamLabelSize.value = c.beamFont
    showBore.value = c.bore !== false
    if (Number.isFinite(c.boreSize)) boreSize.value = c.boreSize
    showContourLabels.value = !!c.contourLabels
    if (Number.isFinite(c.contourSize)) contourLabelSize.value = c.contourSize
    elevText.value = c.elev || ''
    redraw()
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
    const t = curTraj()
    if (t) { t.pts.push({ lat: ll.lat, lon: ll.lon }); syncMarkers() }   // 轨迹编辑中 -> 右键加航点
    else addPoint(ll.lat, ll.lon)                                          // 否则 -> 右键标点
  })
  loadMarkers(); syncMarkers()
  ro = new ResizeObserver(() => { if (scene) scene.resize(); if (flat && flatView.value) flat.resize() }); ro.observe(el.value)

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
onBeforeUnmount(() => { cursor.ll = null; if (timer) clearInterval(timer); if (ro) ro.disconnect(); if (flat) flat.destroy(); if (scene) { scene.clearCoverage(); scene.destroy() } })
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
      <span class="beamc">
        <template v-if="selected">
          <span class="bl">波束角</span>
          <input class="bi" :value="beam" :placeholder="beamAuto || '自动'" @input="onBeam" />
          <span class="bu">°</span>
          <span class="lock" :class="{ on: beamLock }" @click="toggleBeamLock">{{ beamLock ? '🔒' : '🔓' }}</span>
        </template>
        <span v-else class="hint">点击卫星设置波束角</span>
      </span>
    </div>

    <div class="body">
      <div class="lefttools">
        <span v-if="covApiOk" class="mini" :class="{ on: covOpen }" @click="toggleCoverage">覆盖图（GXT）</span>
        <span class="mini" :class="{ on: mkOpen }" @click="toggleMarkers">标记</span>
        <span class="mini" :class="{ on: autoRotate }" @click="toggleRotate">{{ autoRotate ? '旋转中' : '旋转停' }}</span>
        <span class="mini" :class="{ on: geoOpen }" @click="toggleGeo">地名</span>
        <span class="mini" :class="{ on: live }" @click="toggleLive">{{ live ? '实时开' : '实时关' }}</span>
      </div>
      <div class="stage-wrap">
        <div ref="el" class="stage"></div>
        <canvas v-show="flatView" ref="flatCanvas" class="flat"></canvas>
        <div class="hint-fl">{{ flatView ? '平面覆盖图 · 拖动平移 · 滚轮缩放 · 双击复位' : '点击星点查看 · 拖动旋转 · 滚轮缩放 · 右键标点' }}</div>

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
            <span class="cn" :title="selected.name">{{ selected.name }}</span>
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
            <div class="kv wide"><span class="k">近/远地点</span><span class="v">{{ selected.perigee }} / {{ selected.apogee }} km</span></div>
            <div class="kv"><span class="k">Ω</span><span class="v">{{ selected.raan }}°</span></div>
            <div class="kv"><span class="k">ω</span><span class="v">{{ selected.argp }}°</span></div>
            <div class="kv wide"><span class="k">星下点</span><span class="v">{{ selected.lat }}, {{ selected.lon }}</span></div>
          </div>
        </div>
      </div>

      <div v-if="covOpen" class="cov-side">
        <div class="csh"><span class="csn">GEO 卫星覆盖（GXT）</span>
          <span class="flatbtn" :class="{ on: flatView }" @click="toggleFlat">{{ flatView ? '球体' : '平面图' }}</span>
          <span class="csx" @click="toggleCoverage">✕</span></div>

        <div class="sec">
          <div class="srow"><label>添加卫星</label>
            <select :value="covAddSel" @change="e => { covAddSel = e.target.value; addCovSat() }">
              <option value="" disabled>选择卫星…</option>
              <option v-for="s in covSats" :key="s.folder" :value="s.folder"
                      :disabled="covItems.some(i => i.folder === s.folder)">{{ s.displayName }}（{{ s.lon }}°）</option>
            </select>
          </div>
          <div v-if="!covItems.length" class="tip">添加一颗或多颗卫星，各自可建多个批次（波束分组），分别设增益档与颜色。</div>
        </div>

        <!-- 每颗已添加卫星 -->
        <div v-for="it in covItems" :key="it.id" class="sec satcard">
          <div class="sath">
            <span class="satn">{{ idxOf(it.folder)?.displayName }} <em>{{ idxOf(it.folder)?.lon }}°</em></span>
            <span class="seg sm">
              <span class="sg" :class="{ on: it.type === 'EIRP' }" @click="setItemType(it, 'EIRP')">EIRP</span>
              <span class="sg" :class="{ on: it.type === 'GT' }" @click="setItemType(it, 'GT')">G/T</span>
            </span>
            <span class="ic" title="定位" @click="focusCovSat(it)">◎</span>
            <span class="ic del" title="移除该星" @click="removeCovSat(it)">✕</span>
          </div>
          <div class="srow"><label>频段</label>
            <select :value="it.band" @change="e => onItemBand(it, e)">
              <option value="all">全部频段</option>
              <option v-for="b in itemBands(it)" :key="b" :value="b">{{ b }}</option>
            </select>
          </div>

          <!-- 批次 -->
          <div v-for="(ba, bi) in it.batches" :key="ba.id" class="batch">
            <div class="bah">
              <input class="bnm" :value="ba.name" :placeholder="'批次' + (bi + 1)" @input="e => setBatchName(it, ba, e)" />
              <span class="ic del" title="删除批次" @click="removeBatch(it, ba)">✕</span>
            </div>

            <div class="bsub">波束
              <span class="lnk" @click="allBatchBeams(it, ba, !allFilteredOn(it, ba))">{{ allFilteredOn(it, ba) ? '取消' : '全选' }}</span>
              <span class="lnk" @click="invertBatchBeams(it, ba)">反选</span>
              <span class="cnt2">已选 {{ ba.beams.length }}</span>
            </div>
            <input class="ci bq" :value="ba.q" placeholder="搜索：拉萨 / Beam 3，或序号 1-62、1,3,5" @input="e => onBatchQuery(it, ba, e)" />
            <div class="list">
              <label v-for="r in filteredBeamRows(it, ba)" :key="r.id" class="chk">
                <input type="checkbox" :checked="ba.beams.includes(r.id)" @change="toggleBatchBeam(it, ba, r.id)" />
                <span class="bseq">{{ r.seq }}</span><span>{{ r.label }}</span>
              </label>
              <div v-if="!filteredBeamRows(it, ba).length" class="empty">{{ beamRowsOf(it).length ? '无匹配波束' : '该频段/类型无波束' }}</div>
            </div>

            <template v-if="ba.beams.length">
              <!-- 增益档（批次统一） -->
              <div class="bsub">增益档
                <span class="lnk" @click="allBatchGains(it, ba, ba.gains.length !== batchGains(it, ba).length)">{{ ba.gains.length === batchGains(it, ba).length && batchGains(it, ba).length ? '取消' : '全选' }}</span>
              </div>
              <div class="chips">
                <span v-for="g in batchGains(it, ba)" :key="g" class="chip" :class="{ on: ba.gains.includes(g) }"
                      :style="ba.gains.includes(g) ? { borderColor: gainSwatchCss(ba, g), color: gainSwatchCss(ba, g) } : {}"
                      @click="toggleBatchGain(it, ba, g)">
                  <span v-if="ba.mode === 'perGain' && ba.gains.includes(g)" class="dot" :style="{ background: gainSwatchCss(ba, g) }"></span>{{ g }}
                </span>
              </div>
              <div class="srow"><label>自定义</label><input class="ci" :value="ba.custom" placeholder="如 48,52" @input="e => onBatchCustom(it, ba, e)" /></div>

              <!-- 配色（批次统一） -->
              <div class="bsub">配色
                <span class="seg sm">
                  <span class="sg" :class="{ on: ba.mode === 'gradient' }" @click="setBatchMode(it, ba, 'gradient')">渐变</span>
                  <span class="sg" :class="{ on: ba.mode === 'solid' }" @click="setBatchMode(it, ba, 'solid')">纯色</span>
                  <span class="sg" :class="{ on: ba.mode === 'perGain' }" @click="setBatchMode(it, ba, 'perGain')">逐档</span>
                </span>
                <input v-if="ba.mode === 'solid'" class="clr" type="color" :value="ba.solid" @input="e => onBatchSolid(it, ba, e)" />
              </div>
              <div v-if="ba.mode === 'perGain' && ba.gains.length" class="pglist">
                <label v-for="g in ba.gains" :key="g" class="pgrow">
                  <input class="clr" type="color" :value="ba.gainColors[g] || gainSwatchCss(ba, g)" @input="e => onGainColor(it, ba, g, e)" />
                  <span>{{ g }}</span>
                </label>
              </div>

              <!-- 线粗细（批次统一） -->
              <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.6" max="5" step="0.2" :value="ba.width" @input="e => onBatchWidth(it, ba, e)" /><span class="u">{{ ba.width }}</span></div>
            </template>
          </div>
          <div class="addbatch" @click="addBatch(it)">＋ 新建批次</div>
        </div>

        <div class="sec">
          <div class="sect"><span>显示选项</span></div>
          <label class="chk2"><input type="checkbox" :checked="showBeamLabels" @change="toggleBeamLabels" /><span>显示波束名</span></label>
          <div v-if="showBeamLabels" class="srow"><label>字号</label><input class="rng" type="range" min="6" max="32" step="1" :value="beamLabelSize" @input="setBeamFont" /><span class="u">{{ beamLabelSize }}</span></div>
          <label class="chk2"><input type="checkbox" :checked="showBore" @change="toggleBore" /><span>显示波束中心</span></label>
          <div v-if="showBore" class="srow"><label>大小</label><input class="rng" type="range" min="1" max="12" step="1" :value="boreSize" @input="setBoreSize" /><span class="u">{{ boreSize }}</span></div>
          <label class="chk2"><input type="checkbox" :checked="showContourLabels" @change="toggleContourLabels" /><span>显示数值标签</span></label>
          <div v-if="showContourLabels" class="srow"><label>字号</label><input class="rng" type="range" min="2" max="20" step="1" :value="contourLabelSize" @input="setContourSize" /><span class="u">{{ contourLabelSize }}</span></div>
          <div class="srow"><label>等仰角线</label><input class="ci" :value="elevText" placeholder="如 5,10,20" @input="applyElev" /><span class="u">°</span></div>
          <div class="tip">对所有已添加卫星绘制等仰角线（0–90°，逗号分隔）</div>
        </div>

        <div v-if="covLegend.length" class="legend">
          <div class="lrow" v-for="(L, li) in covLegend" :key="li">
            <span class="lname">{{ L.name }}<em>{{ L.type === 'GT' ? ' G/T' : ' EIRP' }}</em></span>
            <span v-if="L.mode === 'solid'" class="lsw" :style="{ background: L.solid }"></span>
            <template v-else><span class="lbar2"></span><span class="lsc2">{{ L.gmin }}~{{ L.gmax }}</span></template>
          </div>
        </div>

        <div class="csfoot">
          <span v-if="covStatus" class="cst">{{ covStatus }}</span>
          <span class="cclr" @click="clearCoverage">清除全部</span>
        </div>
      </div>

      <div v-if="geoOpen" class="cov-side geo-side">
        <div class="csh"><span class="csn">地名</span><span class="csx" @click="toggleGeo">✕</span></div>
        <div class="sec">
          <div class="srow"><label>国家名</label>
            <span class="seg">
              <span class="sg" :class="{ on: nameMode === 'zh' }" @click="setNameMode('zh')">中文</span>
              <span class="sg" :class="{ on: nameMode === 'en' }" @click="setNameMode('en')">英文</span>
              <span class="sg" :class="{ on: nameMode === 'off' }" @click="setNameMode('off')">不显示</span>
            </span>
          </div>
          <div class="srow"><label>国家名字号</label><input class="rng" type="range" min="0.6" max="2" step="0.1" :value="countryNameSize" @input="setCountryNameSize" /><span class="u">{{ countryNameSize.toFixed(1) }}</span></div>
          <label class="chk2"><input type="checkbox" :checked="showProvinces" @change="toggleProvinces" /><span>显示中国省界 / 省名</span></label>
          <div class="srow"><label>省名字号</label><input class="rng" type="range" min="0.6" max="2" step="0.1" :value="provNameSize" @input="setProvNameSize" /><span class="u">{{ provNameSize.toFixed(1) }}</span></div>
          <div class="tip">国家名(含大洋名)与省名字号分开调，同时作用于 3D 与平面图。</div>
        </div>
      </div>

      <div v-if="mkOpen" class="cov-side mk-side">
        <div class="csh"><span class="csn">标记</span><span class="csx" @click="toggleMarkers">✕</span></div>

        <div class="sec">
          <div class="sect"><span>点标记</span></div>
          <div class="srow"><label>纬度</label><input class="ci" v-model="ptLat" placeholder="-90 ~ 90" /></div>
          <div class="srow"><label>经度</label><input class="ci" v-model="ptLon" placeholder="-180 ~ 180" /><span class="addb" @click="addPointInput">添加</span></div>
          <div class="tip">右键地图也可直接标点</div>
          <div class="srow"><label>坐标字号</label><input class="rng" type="range" min="6" max="32" step="1" :value="markPtFont" @input="setPtFont" /><span class="u">{{ markPtFont }}</span></div>
          <div class="mlist">
            <div v-for="p in points" :key="p.id" class="mrow"><span class="mc">{{ fmtLL(p.lat, p.lon) }}</span><span class="del" @click="removePoint(p.id)">✕</span></div>
          </div>
        </div>

        <div class="sec">
          <div class="sect"><span>地面站</span></div>
          <div class="srow"><label>纬度</label><input class="ci" v-model="stLat" placeholder="-90 ~ 90" /></div>
          <div class="srow"><label>经度</label><input class="ci" v-model="stLon" placeholder="-180 ~ 180" /></div>
          <div class="srow"><label>名称</label><input class="ci" v-model="stName" placeholder="如 北京站" /><span class="addb" @click="addStation">添加</span></div>
          <div class="srow"><label>图标大小</label><input class="rng" type="range" min="16" max="60" step="2" :value="stIconSize" @input="setStIcon" /><span class="u">{{ stIconSize }}</span></div>
          <div class="srow"><label>名称字号</label><input class="rng" type="range" min="6" max="32" step="1" :value="stFontSize" @input="setStFont" /><span class="u">{{ stFontSize }}</span></div>
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
.tl .beamc { display: inline-flex; align-items: center; gap: 6px; margin-left: 6px; flex: none; }
.tl .bl { color: var(--text-muted); }
.tl .bi { width: 56px; border: 0; border-bottom: 1px solid var(--border-strong); background: transparent; outline: none; color: var(--text); font-size: 11.5px; }
.tl .bu { color: var(--text-muted); }
.tl .lock { cursor: pointer; }
.tl .hint { color: var(--text-faint); }
.mini { padding: 3px 10px; border: 1px solid var(--border); cursor: pointer; color: var(--text-muted); font-size: 12px; }
.mini.on { color: var(--text); border-color: var(--accent); }
.body { flex: 1; min-height: 0; display: flex; }
.lefttools { width: 106px; flex: none; border-right: 1px solid var(--border); background: var(--bg); display: flex; flex-direction: column; gap: 6px; padding: 8px; }
.lefttools .mini { text-align: center; }
.stage-wrap { flex: 1; min-width: 0; position: relative; }
.stage { width: 100%; height: 100%; background: #070b12; }
.flat { position: absolute; inset: 0; width: 100%; height: 100%; background: #0b1a2b; }
.hint-fl { position: absolute; right: 14px; bottom: 10px; font-size: 11px; color: #6b7686; }
.dl-banner { position: absolute; left: 50%; top: 55%; transform: translate(-50%, -50%); width: 420px; max-width: 86%; background: rgba(20,22,28,0.94); border: 1px solid #34384a; border-radius: 6px; padding: 16px 18px; color: #d7dde6; text-align: center; }
.dl-msg { font-size: 13px; margin-bottom: 12px; color: #f0c674; line-height: 1.5; }
.dl-row { display: flex; gap: 10px; justify-content: center; }
.dl-row button { border: 1px solid #4a5168; background: #1c2230; color: #d7dde6; padding: 6px 14px; cursor: pointer; border-radius: 4px; font-size: 12.5px; }
.dl-row button:hover { border-color: #6b7490; }
.card { position: absolute; right: 14px; top: 14px; width: 224px; background: var(--bg); border: 1px solid var(--border-strong); padding: 8px 11px; }
.ch { display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.cn { font-family: var(--font-serif); font-size: 13.5px; flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cs { font-size: 11px; color: var(--text-muted); flex: none; white-space: nowrap; }
.cx { flex: none; cursor: pointer; color: var(--text-faint); align-self: center; line-height: 1; }
.cg { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 14px; font-size: 11px; }
.kv { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; min-width: 0; white-space: nowrap; }
.kv.wide { grid-column: 1 / 3; }
.kv .k { color: var(--text-muted); flex: none; }
.kv .v { font-family: var(--font-mono); min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* 覆盖图：右侧停靠面板（挤压地球，独占右栏） */
.cov-side { width: 286px; flex: none; border-left: 1px solid var(--border-strong); background: var(--bg); overflow-y: auto; display: flex; flex-direction: column; font-size: 12px; }
.csh { display: flex; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.csn { font-family: var(--font-serif); font-size: 14px; }
.flatbtn { margin-left: 10px; flex: none; border: 1px solid var(--border); padding: 2px 9px; font-size: 11.5px; color: var(--text-muted); cursor: pointer; }
.flatbtn:hover { border-color: var(--accent); color: var(--text); }
.flatbtn.on { background: var(--accent); color: #fff; border-color: var(--accent); }
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
.chk .bseq { flex: none; min-width: 20px; text-align: right; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
.chk input, .chk2 input { accent-color: var(--accent); }
.empty { color: var(--text-faint); padding: 4px 0; }
.cnt { margin-top: 6px; color: var(--text-faint); font-size: 11.5px; }
.cnt .lnk2 { margin-left: 8px; color: var(--accent); cursor: pointer; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; max-height: 120px; overflow-y: auto; }
.chip { padding: 2px 7px; border: 1px solid var(--border); cursor: pointer; color: var(--text-muted); font-family: var(--font-mono); font-size: 11px; }
.chip.on { color: var(--text); }
.chk2 { display: flex; align-items: center; gap: 6px; margin-top: 8px; cursor: pointer; }
.tip { color: var(--text-faint); font-size: 11px; margin-top: 4px; line-height: 1.5; }
/* 两级覆盖：卫星卡 / 批次 */
.satcard { border-left: 2px solid var(--accent); }
.sath { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.satn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.satn em { color: var(--text-muted); font-style: normal; font-weight: 400; font-size: 11px; }
.seg.sm .sg { padding: 2px 7px; font-size: 11px; }
.ic { flex: none; cursor: pointer; color: var(--text-faint); padding: 0 1px; }
.ic:hover { color: var(--text); }
.ic.del:hover { color: #e66; }
.batch { border: 1px solid var(--border); padding: 7px 8px; margin-top: 8px; }
.bah { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.bnm { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 2px 6px; font-size: 11.5px; color: var(--text); outline: none; }
.bnm:focus { border-color: var(--accent); }
.clr { flex: none; width: 26px; height: 20px; padding: 0; border: 1px solid var(--border); background: none; cursor: pointer; }
.rng { flex: 1; min-width: 0; accent-color: var(--accent); }
.srow .u { min-width: 18px; text-align: right; }
.bsub { display: flex; align-items: center; gap: 8px; margin: 7px 0 4px; color: var(--text-muted); font-size: 11.5px; }
.bsub .lnk { color: var(--accent); cursor: pointer; font-size: 11.5px; }
.bsub .cnt2 { margin-left: auto; color: var(--text-faint); font-size: 11px; }
.bq { display: block; width: 100%; box-sizing: border-box; margin-bottom: 5px; border: 1px solid var(--border); background: var(--bg); padding: 3px 6px; font-size: 11.5px; color: var(--text); outline: none; }
.bq:focus { border-color: var(--accent); }
.chip .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
.pglist { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.pgrow { display: flex; align-items: center; gap: 4px; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); cursor: pointer; }
.addbatch { margin-top: 8px; text-align: center; border: 1px dashed var(--border); padding: 4px; color: var(--accent); cursor: pointer; font-size: 11.5px; }
.addbatch:hover { border-color: var(--accent); background: var(--surface); }
.legend { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.legend .lrow { display: flex; align-items: center; gap: 6px; }
.legend .lname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text); }
.legend .lname em { color: var(--text-muted); font-style: normal; }
.legend .lsw { width: 22px; height: 10px; flex: none; border: 1px solid var(--border); }
.legend .lbar2 { width: 56px; height: 10px; flex: none; border: 1px solid var(--border); background: linear-gradient(to right, hsl(240,90%,55%), hsl(120,90%,55%), hsl(0,90%,55%)); }
.legend .lsc2 { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); flex: none; }
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
