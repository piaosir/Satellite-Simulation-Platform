<script setup>
// 日凌预报（GSO）独立窗口 —— 与雨衰计算页同一范式的三栏工作台：
//   左「配置列表」（configs.sun.json，ConfigTree 三件套）· 中「站表」（StationGrid，一行一站）·
//   右「结果」（按站 × 季，读数卡 + 逐日表）。
// 计算在主进程（core.calculateSunOutageSeasons，v5.2 引擎），本组件只负责采集 / 展示 / 持久化。
// 取星两档：定轨＝把卫星当理想地球静止轨道（按轨位）；星历＝按该星 GP 根数逐时刻 SGP4 推算。
// 判据两档：恶化门限＝ D(θ) ≥ D_th；纯几何＝ θ_th ≡ θ_3dB = 70λ/D。
import { ref, reactive, shallowRef, computed, watch, onMounted } from 'vue'
import ActivationLock from '../components/ActivationLock.vue'
import Icon from '../components/Icon.vue'
import StationGrid from '../linkbudget/StationGrid.vue'
import ConfigTree from '../components/ConfigTree.vue'
import ConfigTreeMenu from '../components/ConfigTreeMenu.vue'
import TzPicker from '../components/TzPicker.vue'
import { useConfigTree } from '../shared/useConfigTree.js'
import { stableStringify } from '../shared/configDirty.js'
import { tzParts, tzTag, normTzMode } from '../shared/tz.js'
import { byLang } from '../shared/i18n/lang.js'
import { halfStr } from '../shared/num.js'
import { fmtGeoSlot, classifyOrbit } from '../shared/orbitClass.js'
import { SAT_PRESETS } from '../linkbudget/satPresets.js'
import { ensureSearchPool, findPoolByNorad, orbitSpecOf, slotLonOf } from '../ngso/satSearchPool.js'
import {
  sunFields, GRID_GROUPS, RESULT_DIGITS, SEASONS, SEASON_CN, normSeasons,
  defaultRow, effectiveRow, buildSpec, blankState, normState, equinoxApproxMs,
  normSatName, matchSat, ORBIT_TYPE, ORBIT_INLINE_MAX
} from './sunParams.js'

const api = (typeof window !== 'undefined' && window.api) ? window.api.sunOutage : null
const STATE_KEY = 'sun/last'
const p2 = (n) => String(n).padStart(2, '0')
const pf = (v) => { const x = parseFloat(halfStr(v)); return Number.isFinite(x) ? x : NaN }
const fx = (v, d) => (v == null || !Number.isFinite(+v)) ? '—' : (+v).toFixed(d)

// ============ 窗内提示 ============
const notice = ref('')
let _noticeT = null
function toast(msg) { notice.value = msg; clearTimeout(_noticeT); _noticeT = setTimeout(() => (notice.value = ''), 4000) }

// ============ 显示时区（窗口偏好，不进配置）============
const tzMode = ref(normTzMode(localStorage.getItem('sun/tz'), 'local'))
watch(tzMode, (v) => { try { localStorage.setItem('sun/tz', String(v)) } catch (e) { /* ignore */ } })

// ============ 三栏宽度 ============
const CFG_W_MIN = 170, CFG_W_MAX = 460, RES_W_MIN = 360, RES_W_MAX = 760
const numLS = (k, d) => { const v = Number(localStorage.getItem(k)); return Number.isFinite(v) && v > 0 ? v : d }
const configsWidth = ref(Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, numLS('sun/configsWidth', 230))))
const resultWidth = ref(Math.min(RES_W_MAX, Math.max(RES_W_MIN, numLS('sun/resultWidth', 540))))
const cfgResizing = ref(false)
const resResizing = ref(false)
function startResize(which, e) {
  const right = which === 'res'
  const w = right ? resultWidth : configsWidth
  const min = right ? RES_W_MIN : CFG_W_MIN, max = right ? RES_W_MAX : CFG_W_MAX
  const startX = e.clientX, startW = w.value
  const flag = right ? resResizing : cfgResizing
  flag.value = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  const move = (ev) => { const d = (ev.clientX - startX) * (right ? -1 : 1); w.value = Math.min(max, Math.max(min, startW + d)) }
  const up = () => {
    flag.value = false; document.body.style.cursor = ''; document.body.style.userSelect = ''
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    try { localStorage.setItem(right ? 'sun/resultWidth' : 'sun/configsWidth', String(w.value)) } catch (e2) { /* ignore */ }
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// ============ 全局量（一份配置一颗星）============
const sat = reactive({ name: 'CHINASAT 6C', noradId: '', source: 'slot', slotLon: '130.5', orbit: null, epoch: '', inclDeg: null, groupLabel: '' })
const year = ref(String(new Date().getFullYear()))
const seasons = ref(SEASONS.slice())
const criterion = reactive({ mode: 'degradation', degDb: '1', solarTemp: '' })
const DEG_PRESETS = ['0.5', '1', '3']

function toggleSeason(s) {
  const has = seasons.value.includes(s)
  if (has && seasons.value.length === 1) return   // 至少留一枚：点最后一枚不响应
  seasons.value = normSeasons(has ? seasons.value.filter((x) => x !== s) : seasons.value.concat(s))
}
const seasonOn = (s) => seasons.value.includes(s)

// ============ 站表 ============
let _sid = 1
function mkRow(over) { return { ...defaultRow(), ...(over || {}), _id: 's' + (_sid++) } }
const stations = reactive([mkRow()])
const fields = computed(() => sunFields(seasons.value))
const cities = ref([])
async function citySearch(kw) { try { return (api && await api.searchCities(kw)) || [] } catch (e) { return [] } }

// ============ 结果（按行 _id 存，绝不按下标）============
const resultById = shallowRef({})     // { 行_id: { vernal: r|null, autumnal: r|null } }
const computing = ref(false)
const progress = ref('')
const resultsStale = ref(false)
const hasResults = computed(() => stations.some((r) => resultById.value[r._id]))
const selectedId = ref(stations[0]._id)

const globals = () => ({
  satSource: sat.source, slotLon: sat.slotLon, orbit: sat.orbit,
  year: year.value, seasons: seasons.value,
  criterion: { mode: criterion.mode, degDb: criterion.degDb, solarTemp: criterion.solarTemp }
})

// 任一计算输入变化 → 亮「输入已变」（不做打字防抖自动重算，与雨衰页同口径）
watch([sat, year, seasons, criterion, stations], () => { if (hasResults.value) resultsStale.value = true }, { deep: true })

// —— 表内结果列取值 ——
const extraValues = computed(() => {
  const out = {}
  for (const row of stations) {
    const r = resultById.value[row._id]
    if (!r) continue
    const any = r.vernal || r.autumnal
    const bad = !any || any.error
    const o = {
      satAz: bad ? '✕' : fx(any.satAz, RESULT_DIGITS.satAz),
      satEl: bad ? '✕' : fx(any.satEl, RESULT_DIGITS.satEl),
      thresholdAngle: bad ? '✕' : fx(any.thresholdAngle, RESULT_DIGITS.thresholdAngle)
    }
    for (const [s, dk, mk] of [['vernal', 'vDays', 'vMax'], ['autumnal', 'aDays', 'aMax']]) {
      const q = r[s]
      if (!q) continue
      o[dk] = q.error ? '✕' : String(q.totalDays)
      o[mk] = q.error ? '✕' : (q.maxDurationSec / 60).toFixed(RESULT_DIGITS[mk])
    }
    out[row._id] = o
  }
  return out
})
// 算不出的站整行结果格标红（数值着色保留，不出文字判定）
function cellClassFn(f, row) {
  if (!f.ro) return null
  const r = resultById.value[row._id]
  if (!r) return null
  const any = r.vernal || r.autumnal
  return (!any || any.error) ? 'st-bad' : null
}

// ============ 计算（按 8 行一块分批，算完一块就上屏）============
let _gen = 0
async function compute() {
  if (!api) { toast('计算需在桌面客户端中运行'); return }
  if (!stations.length) { toast('请先添加地球站'); return }
  const y = parseInt(String(halfStr(year.value)), 10)
  if (!(y >= 1900 && y <= 2200)) { toast('年份需在 1900 ~ 2200 之间'); return }
  if (sat.source === 'slot' && !Number.isFinite(pf(sat.slotLon))) { toast('请先填写卫星轨位'); return }
  if (criterion.mode === 'degradation' && !(pf(criterion.degDb) > 0)) { toast('恶化门限需大于 0 dB'); return }

  const gen = ++_gen
  computing.value = true
  const ids = stations.map((r) => r._id)
  const g = globals()
  const specs = stations.map((r) => buildSpec(r, g))
  const acc = {}
  try {
    for (let i = 0; i < specs.length; i += 8) {
      const chunk = JSON.parse(JSON.stringify(specs.slice(i, i + 8)))   // 出 IPC 前落成纯数据
      progress.value = specs.length > 8 ? byLang(`计算中… ${Math.min(i + 8, specs.length)}/${specs.length}`, `Computing… ${Math.min(i + 8, specs.length)}/${specs.length}`) : ''
      const out = await api.computeBatch(chunk)
      if (gen !== _gen) return                                        // 重算期间又点了计算：本轮作废
      const arr = Array.isArray(out) ? out : []
      for (let j = 0; j < arr.length; j++) if (ids[i + j]) acc[ids[i + j]] = arr[j]
      resultById.value = { ...acc }
    }
    resultsStale.value = false
    const errs = Object.values(acc).filter((x) => { const a = x && (x.vernal || x.autumnal); return !a || a.error }).length
    toast(errs ? byLang(`完成，${errs}/${ids.length} 个地球站算不出（见表内 ✕）`, `Done, ${errs}/${ids.length} stations failed`)
      : byLang(`完成，共 ${ids.length} 个地球站`, `Done, ${ids.length} stations`))
  } catch (e) {
    if (gen === _gen) { toast('计算失败：' + ((e && e.message) || e)); resultById.value = {} }
  } finally {
    if (gen === _gen) { computing.value = false; progress.value = '' }
  }
}
const calcText = computed(() => {
  const n = stations.length
  const s = seasons.value.length === 2 ? byLang('两季', 'both') : SEASON_CN[seasons.value[0]]
  return byLang(`计算（${n} 站 · ${s}）`, `Compute (${n} sta · ${s})`)
})

// ============ 卫星检索 ============
const kw = ref('')
const searchOpen = ref(false)
const poolRecs = shallowRef(null)
const poolLoading = ref(false)
const poolErr = ref('')
async function ensurePool() {
  if (poolRecs.value || poolLoading.value) return
  poolLoading.value = true; poolErr.value = ''
  try {
    const res = await ensureSearchPool()
    // 本窗口只算 GSO：候选只留 GEO / IGSO（区制判定走 shared/orbitClass.js 同一份）
    poolRecs.value = (res.all || []).filter((r) => {
      const mm = Number(r.meanMotion)
      const k = classifyOrbit({ e: Number(r.ecc) || 0, inclDeg: Number(r.incl) || 0, periodMin: mm > 0 ? 1440 / mm : NaN })
      return k === 'GEO' || k === 'IGSO'
    })
  } catch (e) {
    poolErr.value = ((e && e.message) || String(e))
  } finally { poolLoading.value = false }
}
// 候选 = 星历池（GEO/IGSO）∪ 预设表，按规范化名去重、池记录优先（预设名留作检索别名）
const candidates = computed(() => {
  const out = [], seen = new Map()
  for (const r of (poolRecs.value || [])) {
    const key = normSatName(r.name)
    if (seen.has(key)) continue
    const rec = { ...r, _key: key, src: 'pool' }
    seen.set(key, rec); out.push(rec)
  }
  for (const p of SAT_PRESETS) {
    const key = normSatName(p.name)
    const hit = seen.get(key)
    if (hit) { hit.presetName = p.name; continue }
    const rec = { name: p.name, noradId: '', presetName: p.name, slotLon: Number(p.position), _key: key, src: 'preset' }
    seen.set(key, rec); out.push(rec)
  }
  return out
})
const searchRes = computed(() => {
  const q = kw.value.trim()
  if (!q) return []
  const hit = []
  for (const r of candidates.value) { if (matchSat(r, q)) { hit.push(r); if (hit.length >= 60) break } }
  return hit.map((r) => {
    const lon = r.src === 'preset' ? Number(r.slotLon) : slotLonOf(r)
    const incl = Number(r.incl) || 0
    return { ...r, _slot: Number.isFinite(lon) ? lon : NaN, _igso: incl >= 5 }
  })
})
function onSearchFocus() { ensurePool(); searchOpen.value = true }
function onSearchBlur() { setTimeout(() => { searchOpen.value = false }, 150) }
function pickSat(rec) {
  searchOpen.value = false
  sat.name = rec.name
  sat.groupLabel = rec.groupLabel || ''
  if (rec.src === 'preset') {
    sat.noradId = ''; sat.orbit = null; sat.epoch = ''; sat.inclDeg = null; sat.source = 'slot'
  } else {
    sat.noradId = String(rec.noradId || '')
    try { sat.orbit = orbitSpecOf(rec) } catch (e) { sat.orbit = null; toast('这颗星的轨道类型无法用于日凌计算') }
    sat.epoch = rec.epoch || ''
    sat.inclDeg = Number(rec.incl) || 0
  }
  if (Number.isFinite(rec._slot)) sat.slotLon = rec._slot.toFixed(2)
  kw.value = ''
}
async function refreshOrbit() {
  if (!sat.noradId) return
  const rec = await findPoolByNorad(sat.noradId)
  if (!rec) { toast('星历库里没有这颗星'); return }
  try { sat.orbit = orbitSpecOf(rec) } catch (e) { toast('这颗星的轨道类型无法用于日凌计算'); return }
  sat.epoch = rec.epoch || ''
  sat.inclDeg = Number(rec.incl) || 0
  const lon = slotLonOf(rec)
  if (Number.isFinite(lon)) sat.slotLon = lon.toFixed(2)
  toast(byLang('已刷新星历', 'Ephemeris refreshed'))
}
const canEphem = computed(() => !!sat.orbit)
function setSatSource(s) {
  if (s === 'ephemeris' && !canEphem.value) return
  sat.source = s
}
const slotText = computed(() => fmtGeoSlot(pf(sat.slotLon)) || (sat.slotLon ? sat.slotLon + '°E' : '—'))
// 星历档读数：历元 · 距各分点天数 · 倾角（含运行时数据的读数行，口径说明放 title）
const epochRead = computed(() => {
  if (sat.source !== 'ephemeris' || !sat.epoch) return null
  const ms = Date.parse(sat.epoch)
  if (!Number.isFinite(ms)) return null
  const t = tzParts(ms, tzMode.value)
  const y = parseInt(String(halfStr(year.value)), 10)
  const gaps = seasons.value.map((s) => {
    const eq = equinoxApproxMs(y, s)
    const d = Number.isFinite(eq) ? Math.round((eq - ms) / 86400e3) : NaN
    return { season: s, label: SEASON_CN[s], days: Number.isFinite(d) ? String(d).replace("-", "−") : "—", far: Number.isFinite(d) && Math.abs(d) > 60 }
  })
  return {
    stamp: `${t.y}-${p2(t.mo)}-${p2(t.d)} ${p2(t.h)}:${p2(t.mi)}`,
    gaps,
    incl: Number.isFinite(Number(sat.inclDeg)) ? Number(sat.inclDeg).toFixed(2) : '—'
  }
})
// 星历覆盖区间（本期 SGP4 恒无区间；外部星历接进来时这一行才会出现）
const spanRead = computed(() => {
  const r = selResult.value && (selResult.value.vernal || selResult.value.autumnal)
  const sp = r && r.model && r.model.ephemSpan
  if (!sp) return null
  const d = (iso) => { const t = tzParts(Date.parse(iso), tzMode.value); return `${p2(t.mo)}-${p2(t.d)}` }
  const cov = r.coverageDays == null ? null : (61 - r.coverageDays)
  return { start: d(sp.start), end: d(sp.end), miss: cov }
})

// ============ 结果栏 ============
watch(() => stations.map((s) => s._id).join(','), () => {
  if (!stations.length) { selectedId.value = null; return }
  if (!stations.some((s) => s._id === selectedId.value)) selectedId.value = stations[0]._id
})
function onRowFocus(i, id) { if (id) selectedId.value = id }
const selRow = computed(() => stations.find((s) => s._id === selectedId.value) || null)
const selResult = computed(() => (selRow.value && resultById.value[selRow.value._id]) || null)
const selError = computed(() => {
  const r = selResult.value
  if (!r) return ''
  const any = r.vernal || r.autumnal
  return (any && any.error) ? (any.message || '计算失败') : ''
})
const stationLabel = (row, i) => `${i + 1} · ${(row.stationName || '').trim() || byLang('地球站', 'Station')}`
// 选中站 × 所选季的分段（春分在前）
const sections = computed(() => {
  const r = selResult.value
  if (!r) return []
  const out = []
  for (const s of seasons.value) {
    const q = r[s]
    if (!q || q.error) continue
    out.push({ key: s, label: SEASON_CN[s], r: q })
  }
  return out
})
// 时刻：引擎给 UTC 日期 + UTC 时刻 → 按显示时区平移（自动含跨日）
function shift(dateUTC, hms) {
  const ms = Date.parse(`${dateUTC}T${hms}Z`)
  if (!Number.isFinite(ms)) return { date: dateUTC, time: hms, sec: 0, ms: NaN }
  const t = tzParts(ms, tzMode.value)
  return { date: `${t.y}-${p2(t.mo)}-${p2(t.d)}`, time: `${p2(t.h)}:${p2(t.mi)}:${p2(t.s)}`, sec: t.h * 3600 + t.mi * 60 + t.s, ms }
}
const dDate = (d) => shift(d.date, d.startTimeUTC).date
// 日凌区间：按显示时区取首末日期（引擎的 startDate/endDate 是 UTC 日期，换档会与逐日表对不上）
function spanOf(sec) {
  const rows = sec.r.dailyResults
  if (!rows.length) return '—'
  return dDate(rows[0]) + ' ~ ' + dDate(rows[rows.length - 1])
}
const dStart = (d) => shift(d.date, d.startTimeUTC).time
const dPeak = (d) => shift(d.date, d.peakTimeUTC).time
const dEnd = (d) => shift(d.date, d.endTimeUTC).time
// 峰值恶化三档着色（数值着色，不出文字判定）
const degClass = (v) => (v >= 10 ? 'v-danger' : v >= 3 ? 'v-warn' : 'v-ok')
function tagOf(sec) { return tzTag(tzMode.value, sec) }
const secLabel = (sec) => {
  const r = sec && sec.r
  const ms = r ? Date.parse(`${r.equinoxDate}T12:00:00Z`) : Date.now()
  return tagOf(ms)
}

// ============ 导出 ============
// 逐站导出对象：Excel 吃 *Sec（秒）、Word 吃 *Disp（显示串），一套 payload 两处共用。
function stationExport(row) {
  const e = effectiveRow(row)
  const r = resultById.value[row._id] || {}
  const any = r.vernal || r.autumnal
  const good = any && !any.error
  const out = {
    name: e.stationName, lat: pf(e.latitude), lon: pf(e.longitude),
    band: e.band, freq: pf(e.frequency), diameter: pf(e.diameter), sysTemp: pf(e.sysTemp),
    satAz: good ? any.satAz : null, satEl: good ? any.satEl : null,
    beamWidth: good ? any.beamWidth : null, thresholdAngle: good ? any.thresholdAngle : null,
    boresightDeg: good && any.model ? any.model.boresightDeg : null,
    solarTemp: good && any.model ? any.model.solarTemp : null,
    error: good ? '' : ((any && any.message) || '')
  }
  for (const s of seasons.value) {
    const q = r[s]
    out[s] = (q && !q.error) ? {
      days: q.totalDays,
      maxMin: Math.round(q.maxDurationSec / 6) / 10,
      equinoxDate: q.equinoxDate,
      rows: q.dailyResults.map((d, i) => {
        const st = shift(d.date, d.startTimeUTC), pk = shift(d.date, d.peakTimeUTC), en = shift(d.date, d.endTimeUTC)
        return {
          no: i + 1, date: st.date, dateUTC: d.date,
          startSec: st.sec, peakSec: pk.sec, endSec: en.sec,
          dateDisp: st.date, startDisp: st.time, peakDisp: pk.time, endDisp: en.time,
          peakUtc: d.peakTimeUTC, startUtc: d.startTimeUTC, endUtc: d.endTimeUTC,
          durMin: Math.round(d.durationSec / 6) / 10, durStr: d.durationStr,
          peakDb: d.peakCNdeg, sep: d.peakSeparation, isPeak: !!d.isPeak
        }
      })
    } : null
  }
  return out
}
const tzLabel = computed(() => {
  const y = parseInt(String(halfStr(year.value)), 10)
  const ref = equinoxApproxMs(y, seasons.value[0] || 'vernal')
  return tagOf(Number.isFinite(ref) ? ref : Date.now())
})
function exportPayload() {
  return JSON.parse(JSON.stringify({
    sat: {
      name: (sat.name || '').trim() || slotText.value,
      slotText: slotText.value,
      source: sat.source, noradId: sat.noradId || null,
      epoch: sat.epoch || null, inclDeg: sat.inclDeg
    },
    year: parseInt(String(halfStr(year.value)), 10),
    seasons: seasons.value.slice(),
    tzLabel: tzLabel.value,
    criterion: { mode: criterion.mode, degDb: criterion.degDb },
    stations: stations.map(stationExport)
  }))
}
const fileBase = computed(() => `日凌预报_${(sat.name || '').trim() || slotText.value}_${year.value}`)
async function runExport(kind) {
  if (!api || !hasResults.value) return
  const p = exportPayload()
  p.defaultName = `${fileBase.value}.${kind === 'excel' ? 'xlsx' : kind === 'word' ? 'docx' : 'ics'}`
  const fn = kind === 'excel' ? api.exportExcel : kind === 'word' ? api.exportWord : api.exportIcs
  if (!fn) { toast('导出需在桌面客户端中运行'); return }
  try {
    const r = await fn(p)
    if (r && r.ok) toast(byLang('已导出：', 'Exported: ') + r.filePath)
    else if (r && !r.canceled) toast('导出失败：' + (r && r.error))
  } catch (e) { toast('导出失败：' + ((e && e.message) || e)) }
}

// ============ 配置持久化（configs.sun.json，ns='sun'）============
// 星历正文 ≤ 4 KB 内嵌配置（OMM / elements 都远小于此）—— 离线打开旧配置也能按当时的根数重算，
// 「刷新星历」才换；超过 4 KB 的（将来的外部星历）只存引用 { type, ref }，正文不搬进配置。
function satOrbitForSave() {
  const o = sat.orbit
  if (!o) return null
  if (o.ref) return o
  return JSON.stringify(o).length <= ORBIT_INLINE_MAX ? o : { type: o.type, ref: null }
}
function serializeState() {
  return normState({
    orbitType: ORBIT_TYPE, name: '',
    sat: { name: sat.name, noradId: sat.noradId, source: sat.source, slotLon: sat.slotLon, orbit: satOrbitForSave(), epoch: sat.epoch, inclDeg: sat.inclDeg, groupLabel: sat.groupLabel },
    year: year.value, seasons: seasons.value,
    criterion: { mode: criterion.mode, degDb: criterion.degDb, solarTemp: criterion.solarTemp },
    stations: stations.map((r) => { const o = {}; for (const k in r) if (k !== '_id') o[k] = r[k]; return o })
  })
}
function applyState(st) {
  const s = normState(st)
  // orbit 原样落回（含将来的 { type, ref } 引用形状）：引用怎么解析是主进程 resolveOrbitSpec 的事，窗口不碰
  Object.assign(sat, s.sat)
  year.value = s.year
  seasons.value = s.seasons.slice()
  criterion.mode = s.criterion.mode; criterion.degDb = s.criterion.degDb; criterion.solarTemp = s.criterion.solarTemp
  stations.splice(0, stations.length, ...s.stations.map((r) => mkRow(r)))
  selectedId.value = stations[0] ? stations[0]._id : null
  resultById.value = {}        // 换一份配置就把结果撤掉（重算是秒级的）
  resultsStale.value = false
}

// —— 脏态 ——
function fingerprint() { return stableStringify(serializeState()) }
let activeBaseline = ''
const dirtyFlag = ref(false)
function setBaseline() { activeBaseline = fingerprint(); dirtyFlag.value = false }
function isDirty() { return !!cfgTree.activeId.value && fingerprint() !== activeBaseline }

// —— 工作状态 ——
let _stateT = null
function flushSaveState() {
  clearTimeout(_stateT)
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...serializeState(), activeId: cfgTree.activeId.value })) } catch (e) { /* ignore */ }
}
function scheduleSaveState() { clearTimeout(_stateT); _stateT = setTimeout(() => { flushSaveState(); dirtyFlag.value = isDirty() }, 600) }
watch([sat, year, seasons, criterion, stations], scheduleSaveState, { deep: true })

// —— 三个对话框 ——
const confirmDlg = reactive({ open: false, msg: '' })
let _confirmResolve = null
function askConfirm(msg) { confirmDlg.msg = msg; confirmDlg.open = true; return new Promise((res) => { _confirmResolve = res }) }
function answerConfirm(ok) { confirmDlg.open = false; const r = _confirmResolve; _confirmResolve = null; if (r) r(ok) }
const leaveDlg = reactive({ open: false, name: '' })
let _leaveResolve = null
function leaveAnswer(ans) { leaveDlg.open = false; const r = _leaveResolve; _leaveResolve = null; if (r) r(ans) }
async function guardedLeave() {
  if (!isDirty()) return true
  const ans = await new Promise((res) => { leaveDlg.name = cfgTree.activeName(); leaveDlg.open = true; _leaveResolve = res })
  if (ans === 'cancel') return false
  if (ans === 'save') return await updateConfig()
  return true
}
// 出厂名＝星名（或轨位）+ 年份 + 存盘时刻（自命名随平台语言走）
function defaultCfgName() {
  const t = tzParts(Date.now(), tzMode.value)
  const stamp = `${p2(t.mo)}-${p2(t.d)} ${p2(t.h)}:${p2(t.mi)}`
  const who = (sat.name || '').trim() || slotText.value
  return byLang(`${who} 日凌 ${year.value} ${stamp}`, `${who} Sun Outage ${year.value} ${stamp}`)
}

const cfgTree = useConfigTree({
  ns: 'sun', orbitType: ORBIT_TYPE, api: (typeof window !== 'undefined' && window.api) || null, storageKey: 'sun/cfgExpanded',
  toast, blankState, serializeState, applyState, setBaseline, guardedLeave, askConfirm, defaultCfgName
})
const {
  configs, activeId, focusId, expandedFolders, editing, cfgClip, cfgDlg, ctxMenu,
  loadConfigs, selectConfig, openSaveDlg, confirmCfgDlg, updateConfig, saveCurrent,
  toggleFolder, expandAll, collapseAll,
  addFolder, addBlankConfig, onDeleteItem, onMove, moveToRoot,
  startRename, commitRename, cancelRename,
  copyItem, cutItem, pasteConfig, ctxItem, ctxIsFolder, openCtx, closeCtx, onCfgKey
} = cfgTree
const showConfigs = ref(true)

onMounted(async () => {
  // 城市库全量：StationGrid 拿它做「站名 → 经纬度」反查（CityPicker 自己走 window.api.linkBudget，与本窗口无关）
  try { cities.value = (api && await api.cities()) || [] } catch (e) { cities.value = [] }
  await loadConfigs()
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (raw) {
      const st = JSON.parse(raw)
      const c = st.activeId && configs.value.find((x) => x.id === st.activeId)
      if (c) { activeId.value = c.id; applyState(c.state); setBaseline(); applyState(st) }
      else applyState(st)
      dirtyFlag.value = isDirty()
    }
  } catch (e) { /* ignore */ }
  // 关窗序：守卫（可保存 / 取消）→ 冲刷工作状态 → 放行关闭
  api?.onCloseRequested?.(async () => {
    let go = false
    try { go = await guardedLeave() } catch (e) { toast('关闭前保存失败：' + ((e && e.message) || e)); return }
    if (!go) return
    flushSaveState(); api.confirmClose()
  })
  window.addEventListener('beforeunload', flushSaveState)
})
</script>

<template>
  <div class="lb-shell">
    <ActivationLock />
    <ConfigTreeMenu
      :menu="ctxMenu" :item="ctxItem" :is-folder="ctxIsFolder" :clip="cfgClip" :has-api="!!api"
      @close="closeCtx" @rename="startRename" @new-folder="addFolder" @new-config="addBlankConfig"
      @save-new="openSaveDlg" @cut="cutItem" @copy="copyItem" @paste="pasteConfig" @move-root="moveToRoot"
      @delete="onDeleteItem" @expand-all="expandAll" @collapse-all="collapseAll" @hide="showConfigs = false"
    />

    <div class="lb-topbar">
      <span class="lb-brand">日凌预报 · GSO</span>
      <span class="lb-flex"></span>
      <span v-if="notice" class="lb-notice">{{ notice }}</span>
      <span v-if="!api" class="lb-warn">需在桌面客户端中运行</span>
      <TzPicker v-model="tzMode" align="right" title="逐日表与报告的时标（ICS 日历事件恒用 UTC，导入后由日历软件换算）" />
      <button class="lb-mini" :disabled="!api || !hasResults" title="导出 Excel（两张三线表：地球站参数 / 逐日日凌窗口）" @click="runExport('excel')">导出 Excel</button>
      <button class="lb-mini" :disabled="!api || !hasResults" title="导出 Word 报告（逐站一节）" @click="runExport('word')">导出 Word</button>
      <button class="lb-mini" :disabled="!api || !hasResults" title="RFC 5545 iCalendar，Outlook / Google / Apple 日历直接导入，含提前 1 天与 30 分钟提醒" @click="runExport('ics')">导出 ICS</button>
    </div>

    <div class="lb-body">
      <!-- ① 配置列表 -->
      <aside v-show="showConfigs" class="lb-col lb-side lb-configs" :class="{ resizing: cfgResizing }" :style="{ width: configsWidth + 'px' }">
        <div class="lb-col-hd">
          <span class="lb-cfg-hd-t">配置列表</span>
          <span class="lb-cfg-acts">
            <button class="lb-mini" :title="activeId ? '保存修改到当前配置' : '保存为新配置'" :disabled="!api" @click="saveCurrent">保存<span v-if="dirtyFlag" class="lbx-dirty"></span></button>
            <button class="lb-mini" :disabled="!api" title="另存为新配置" @click="openSaveDlg">另存</button>
            <button class="lb-mini lb-mini-ico" title="新建文件夹" :disabled="!api" @click="addFolder(null)"><Icon name="folder-plus" :size="12" /></button>
            <button class="lb-mini lb-mini-ico" title="新建配置" :disabled="!api" @click="addBlankConfig(null)"><Icon name="plus" :size="12" /></button>
          </span>
        </div>
        <div class="lb-col-bd" tabindex="0" @keydown="onCfgKey" @contextmenu="openCtx($event, null)">
          <ConfigTree
            :items="configs" :active-id="activeId" :focus-id="focusId" :editing-id="editing.id" :editing-name="editing.name"
            :expanded="expandedFolders"
            :cut-id="cfgClip && cfgClip.mode === 'cut' ? cfgClip.id : null"
            @select="selectConfig" @toggle="toggleFolder" @delete="onDeleteItem" @move="onMove" @focus="focusId = $event.id"
            @add-folder="addFolder" @add-config="addBlankConfig" @context="openCtx"
            @rename-start="startRename" @rename-input="editing.name = $event" @rename-commit="commitRename" @rename-cancel="cancelRename"
          />
        </div>
        <div class="lb-cfg-resizer" title="拖动调整栏宽" @mousedown.prevent="startResize('cfg', $event)"></div>
      </aside>

      <!-- ② 站表 -->
      <section class="lb-col lb-build">
        <div class="rain-toolbar">
          <div class="rain-seg-grp so-sat">
            <span class="rain-seg-lb">卫星</span>
            <label class="so-search">
              <input v-model="kw" placeholder="名称 / NORAD" spellcheck="false" @focus="onSearchFocus" @blur="onSearchBlur" />
              <div v-if="searchOpen && (kw.trim() || poolLoading || poolErr)" class="so-drop">
                <div v-if="poolLoading" class="so-drop-i dim">载入星历…</div>
                <div v-else-if="poolErr" class="so-drop-i dim" data-i18n-skip>{{ poolErr }}</div>
                <div v-for="r in searchRes" :key="r._key + r.noradId" class="so-drop-i" @mousedown.prevent="pickSat(r)">
                  <b data-i18n-skip>{{ r.name }}</b>
                  <span class="so-d" data-i18n-skip>·</span>
                  <span v-if="r.src === 'preset'" class="so-tag">预设</span>
                  <span v-else class="so-n" data-i18n-skip>{{ r.noradId }}</span>
                  <template v-if="r._slot === r._slot"><span class="so-d" data-i18n-skip>·</span><span class="so-n" data-i18n-skip>{{ fmtGeoSlot(r._slot) }}</span></template>
                  <span v-if="r._igso" class="so-tag igso">IGSO</span>
                  <span v-if="r.groupLabel" class="so-g" data-i18n-skip>{{ r.groupLabel }}</span>
                </div>
                <div v-if="kw.trim() && !searchRes.length && !poolLoading" class="so-drop-i dim">无匹配卫星</div>
              </div>
            </label>
            <label class="rain-geom so-name" title="卫星名称（检索到的星取编目名，可改）"><input v-model="sat.name" spellcheck="false" /></label>
            <div class="rain-seg">
              <button :class="{ on: sat.source === 'slot' }" title="定轨：按轨位把卫星当理想地球静止轨道" @click="setSatSource('slot')">定轨</button>
              <button :class="{ on: sat.source === 'ephemeris' }" :disabled="!canEphem"
                      :title="canEphem ? '星历：按该星 GP 根数逐时刻 SGP4/SDP4 推算真实位置（含倾角、偏心率与漂移，不含轨道保持机动）' : '需先检索到带星历的卫星'"
                      @click="setSatSource('ephemeris')">星历</button>
            </div>
            <label class="rain-geom" :title="sat.source === 'ephemeris' ? '历元星下点经度（星历档下由根数算出）' : '定点轨位（东经为正，西经为负）'">
              <span>轨位</span><input v-model="sat.slotLon" :readonly="sat.source === 'ephemeris'" spellcheck="false" /><i>°E</i>
            </label>
          </div>
          <div v-if="epochRead" class="so-read">
            <span class="so-read-k">历元</span><b data-i18n-skip>{{ epochRead.stamp }}</b>
            <template v-for="g in epochRead.gaps" :key="g.season">
              <span class="so-d" data-i18n-skip>·</span><span class="so-read-k">距{{ g.label }}</span><b :class="{ far: g.far }" data-i18n-skip>{{ g.days }}</b><span class="so-read-k">天</span>
            </template>
            <span class="so-d" data-i18n-skip>·</span><span class="so-read-k">倾角</span><b data-i18n-skip>{{ epochRead.incl }}°</b>
            <button v-if="sat.orbit && sat.orbit.type === 'omm'" class="lb-mini" title="按 NORAD 回星历库重取根数" @click="refreshOrbit">刷新星历</button>
          </div>
          <div v-if="spanRead" class="so-read">
            <span class="so-read-k">星历覆盖</span><b data-i18n-skip>{{ spanRead.start }} ~ {{ spanRead.end }}</b>
            <template v-if="spanRead.miss"><span class="so-d" data-i18n-skip>·</span><span class="so-read-k">缺</span><b data-i18n-skip>{{ spanRead.miss }}</b><span class="so-read-k">天</span></template>
          </div>
        </div>

        <div class="rain-toolbar">
          <div class="rain-seg-grp">
            <span class="rain-seg-lb">年份</span>
            <label class="rain-geom"><input v-model="year" spellcheck="false" inputmode="numeric" /></label>
          </div>
          <div class="rain-seg-grp">
            <span class="rain-seg-lb">分点</span>
            <span class="chips">
              <button v-for="s in SEASONS" :key="s" class="chip" :class="{ on: seasonOn(s) }" @click="toggleSeason(s)">{{ SEASON_CN[s] }}</button>
            </span>
          </div>
          <div class="rain-seg-grp">
            <span class="rain-seg-lb">判据</span>
            <div class="rain-seg">
              <button :class="{ on: criterion.mode === 'degradation' }" title="恶化门限：D(θ) = 10·lg(1 + ΔT(θ)/T_sys) ≥ D_th" @click="criterion.mode = 'degradation'">恶化门限</button>
              <button :class="{ on: criterion.mode === 'geometric' }" title="纯几何：门限角 θ_th ≡ θ_3dB = 70λ/D（全宽，不加太阳视半径）" @click="criterion.mode = 'geometric'">纯几何</button>
            </div>
            <label class="rain-geom"><input v-model="criterion.degDb" :disabled="criterion.mode === 'geometric'" spellcheck="false" /><i>dB</i></label>
            <span v-if="criterion.mode === 'geometric'" class="so-read-k" data-i18n-skip>θ_th = θ_3dB</span>
            <span v-else class="chips">
              <button v-for="p in DEG_PRESETS" :key="p" class="chip" :class="{ on: criterion.degDb === p }" @click="criterion.degDb = p">{{ p }} dB</button>
            </span>
          </div>
          <div class="rain-seg-grp">
            <span class="rain-seg-lb nocap">T_sun</span>
            <label class="rain-geom" title="太阳射电亮温：留空按 F10.7（周期均值 120）与当日太阳视直径逐日推算"><input v-model="criterion.solarTemp" spellcheck="false" /><i>K</i></label>
          </div>
        </div>

        <div class="rain-grid">
          <StationGrid
            grid-id="sun.stations" :stations="stations" :fields="fields" :groups="GRID_GROUPS" :freeze-keys="false"
            :cities="cities" :city-search="citySearch"
            :extra-values="extraValues" :cell-class="cellClassFn" :focus-id="selectedId" label="地球站"
            @row-focus="onRowFocus"
          />
        </div>

        <div class="lb-foot">
          <span v-if="resultsStale" class="rain-stale">输入已变</span>
          <span v-if="progress" class="lb-notice" data-i18n-skip>{{ progress }}</span>
          <span class="lb-flex"></span>
          <button class="lb-calc" :disabled="computing || !api" @click="compute">{{ computing ? '计算中…' : calcText }}</button>
        </div>
      </section>

      <!-- ③ 结果 -->
      <aside class="lb-col lb-result" :class="{ resizing: resResizing }" :style="{ width: resultWidth + 'px' }">
        <div class="lb-cfg-resizer so-res-resizer" title="拖动调整栏宽" @mousedown.prevent="startResize('res', $event)"></div>
        <div class="lb-col-hd">
          <span class="lb-cfg-hd-t">结果</span>
          <select v-model="selectedId" class="rain-sel">
            <option v-for="(row, i) in stations" :key="row._id" :value="row._id" data-i18n-skip>{{ stationLabel(row, i) }}</option>
          </select>
        </div>
        <div class="lb-result-bd">
          <div v-if="selError" class="rain-err" data-i18n-skip>{{ selError }}</div>
          <template v-else-if="sections.length">
            <section v-for="sec in sections" :key="sec.key" class="so-sec">
              <h3 class="so-sec-t"><span>{{ sec.label }}</span> <b data-i18n-skip>{{ sec.r.equinoxDate }}</b></h3>
              <div class="cards">
                <div class="card"><i>分点</i><b data-i18n-skip>{{ sec.r.equinoxDate }}</b></div>
                <div class="card"><i>日凌区间</i><b data-i18n-skip>{{ spanOf(sec) }}</b><span class="card-u">{{ sec.r.totalDays }} 天</span></div>
                <div class="card"><i>单日最长</i><b data-i18n-skip>{{ sec.r.maxDurationStr }}</b></div>
                <div class="card" title="太阳视位置 VSOP87+章动；太阳均匀盘 × 高斯主瓣精确卷积 → ΔT(θ)，D(θ)=10lg(1+ΔT/T_sys)"><i>主轴对准恶化上限</i><b data-i18n-skip>{{ sec.r.model.boresightDeg }} dB</b></div>
                <div class="card" title="70λ/D（全宽）"><i>3 dB 波束宽</i><b data-i18n-skip>{{ sec.r.model.beamWidth3dB }}°</b></div>
                <div class="card"><i>门限角</i><b data-i18n-skip>{{ sec.r.thresholdAngle }}°</b></div>
                <div class="card"><i>卫星指向</i><b data-i18n-skip>Az {{ sec.r.satAz }}° · El {{ sec.r.satEl }}°</b></div>
                <div class="card"><i>判据与噪温</i><b data-i18n-skip>{{ sec.r.model.criterion === 'geometric' ? 'θ_th = θ_3dB' : '≥' + sec.r.model.degThreshold + ' dB' }} · T_sys {{ sec.r.model.sysTemp }} K</b></div>
                <div class="card" title="默认由太阳射电流量 F10.7=120（周期均值）按频率外推；太阳活动峰年实际值可高约 30%"><i>T_sun</i><b data-i18n-skip>{{ sec.r.model.solarTemp }} K</b></div>
                <div v-if="sec.r.satSource === 'ephemeris'" class="card" title="星历档：分点日正午（UT）的星下点经度"><i>星下点</i><b data-i18n-skip>{{ sec.r.satLonEff }}°E</b></div>
              </div>

              <div v-if="sec.r.dailyResults.length" class="tblwrap">
              <table class="tbl">
                <thead>
                  <tr>
                    <th class="c">#</th>
                    <th>日期</th>
                    <th class="r">开始 <span data-i18n-skip>({{ secLabel(sec) }})</span></th>
                    <th class="r">峰值 <span data-i18n-skip>({{ secLabel(sec) }})</span></th>
                    <th class="r">结束 <span data-i18n-skip>({{ secLabel(sec) }})</span></th>
                    <th class="r">时长</th>
                    <th class="r">峰值恶化 dB</th>
                    <th class="r">最小夹角 °</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(d, i) in sec.r.dailyResults" :key="d.date" :class="{ peak: d.isPeak }">
                    <td class="c mono">{{ i + 1 }}</td>
                    <td class="mono" data-i18n-skip>{{ dDate(d) }}<span v-if="d.isPeak" class="star" title="最长日"> <Icon name="star" :size="12" /></span></td>
                    <td class="r mono" data-i18n-skip>{{ dStart(d) }}</td>
                    <td class="r mono strong" data-i18n-skip>{{ dPeak(d) }}</td>
                    <td class="r mono" data-i18n-skip>{{ dEnd(d) }}</td>
                    <td class="r mono" data-i18n-skip>{{ d.durationStr }}</td>
                    <td class="r mono" :class="degClass(d.peakCNdeg)" data-i18n-skip>{{ d.peakCNdeg }}</td>
                    <td class="r mono" data-i18n-skip>{{ d.peakSeparation }}</td>
                  </tr>
                </tbody>
              </table>
              </div>
              <div v-else class="so-empty">
                <p>本季无满足判据的日凌事件。</p>
                <p class="dim" data-i18n-skip>{{ sec.r.model.boresightDeg }} dB · {{ sec.r.model.degThreshold }} dB</p>
              </div>
            </section>
          </template>
          <template v-else-if="selResult">
            <div class="so-empty"><p>本季无满足判据的日凌事件。</p></div>
          </template>
          <div v-else class="so-empty"><p>尚无计算结果。</p></div>
        </div>
      </aside>
    </div>

    <div v-if="cfgDlg.open" class="lb-mask" @click="cfgDlg.open = false">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">保存为新配置</div>
        <input v-model="cfgDlg.name" class="lb-dlg-inp" placeholder="配置名称" @keyup.enter="confirmCfgDlg" />
        <div class="lb-dlg-acts">
          <button class="lb-mini" @click="cfgDlg.open = false">取消</button>
          <button class="lb-mini pri" @click="confirmCfgDlg">保存</button>
        </div>
      </div>
    </div>

    <div v-if="leaveDlg.open" class="lb-mask" @click="leaveAnswer('cancel')">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">配置已修改</div>
        <div class="lb-dlg-msg">「<b data-i18n-skip>{{ leaveDlg.name }}</b>」有未保存的修改，是否保存？</div>
        <div class="lb-dlg-acts">
          <button class="lb-mini" @click="leaveAnswer('cancel')">取消</button>
          <button class="lb-mini" @click="leaveAnswer('discard')">不保存</button>
          <button class="lb-mini pri" @click="leaveAnswer('save')">保存</button>
        </div>
      </div>
    </div>

    <div v-if="confirmDlg.open" class="lb-mask" @click="answerConfirm(false)">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">确认</div>
        <div class="lb-dlg-msg" data-i18n-skip>{{ confirmDlg.msg }}</div>
        <div class="lb-dlg-acts">
          <button class="lb-mini" @click="answerConfirm(false)">取消</button>
          <button class="lb-mini pri" @click="answerConfirm(true)">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 工作台外壳（.lb-* 一族）——这套类是各工作台窗口共用的「壳」，但一向由各 App 在自己的
   <style scoped> 里各写一份（scoped 会给选择器缀上 data-v-，别的组件吃不到）。本文件这一段
   整块抄自 src/rain/RainApp.vue，只补了本窗口自己的 .so-* 几件。 */
.lb-shell {
  --ok: #4a7a62; --warn: #8a7038; --danger: #9c5751;
  display: flex; flex-direction: column; height: 100vh; background: var(--bg); color: var(--text);
  font-size: var(--fs-4); overflow: hidden;
}
:root[data-theme="dark"] .lb-shell { --ok: #6f9d85; --warn: #b59a5e; --danger: #c08079; }

.lb-topbar { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--surface); }
.lb-brand { font-family: var(--font-serif); font-size: var(--fs-5); font-weight: 600; }
.lb-flex { flex: 1 1 auto; }
.lb-notice { font-size: var(--fs-3); color: var(--ok); }
.lb-warn { font-size: var(--fs-3); color: var(--danger); }

.lb-body { flex: 1 1 auto; display: flex; min-height: 0; }
.lb-col { display: flex; flex-direction: column; min-height: 0; position: relative; }
.lb-configs { flex: none; border-right: 1px solid var(--border); background: var(--surface); }
.lb-build { flex: 1 1 auto; min-width: 0; overflow: hidden; }
.lb-result { flex: none; border-left: 1px solid var(--border); background: var(--surface); }

.lb-col-hd { flex: none; display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: var(--fs-2); letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-muted); }
.lb-cfg-hd-t { font-weight: 600; }
.lb-cfg-acts { display: inline-flex; gap: 4px; margin-left: auto; }
.lb-col-bd { flex: 1 1 auto; overflow: auto; padding: 6px; outline: none; }
.lb-cfg-resizer { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: col-resize; z-index: 6; }
.lb-cfg-resizer:hover, .lb-col.resizing .lb-cfg-resizer { background: var(--accent); opacity: .35; }
/* 结果栏贴窗口右沿，拖宽缝在左缘（startResize 的取负与之配套） */
.so-res-resizer { right: auto; left: 0; }

.lb-mini { font: inherit; font-size: var(--fs-3); height: var(--h-ctl); white-space: nowrap; padding: 0 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); border-radius: var(--r-ctl); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.lb-mini:hover:not(:disabled) { border-color: var(--accent); }
.lb-mini:disabled { opacity: .5; cursor: default; }
.lb-mini.pri { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.lb-mini-ico { padding: 0 6px; }
.rain-sel { font: inherit; font-size: var(--fs-3); padding: 3px 6px; border: 1px solid var(--field-border); border-radius: var(--r-ctl); background-color: var(--surface-2); color: var(--text); margin-left: auto; max-width: 220px; }

/* 工具栏（两行：卫星 / 时间与判据） */
.rain-toolbar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
.rain-seg-grp { flex: none; display: inline-flex; align-items: center; gap: 7px; }
.rain-seg-lb.nocap { text-transform: none; }
.rain-seg-lb { flex: none; white-space: nowrap; font-size: var(--fs-2); letter-spacing: var(--ls-label); color: var(--text-muted); text-transform: uppercase; }
.rain-seg { flex: none; display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-ctl); overflow: hidden; }
.rain-seg button { flex: none; white-space: nowrap; font: inherit; font-size: var(--fs-3); height: var(--h-ctl); padding: 0 12px; border: 0; background: var(--surface-2); color: var(--text-muted); cursor: pointer; }
.rain-seg button + button { border-left: 1px solid var(--border); }
.rain-seg button.on { color: var(--text); box-shadow: inset 0 -2px 0 var(--accent-ui); background: var(--surface); }
.rain-seg button:disabled { opacity: .45; cursor: default; }
.rain-geom { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 25px; padding: 0 7px 0 8px; border: 1px solid var(--border); border-radius: var(--r-ctl); background: var(--surface-2); }
.rain-geom:focus-within { border-color: var(--accent-ui); background: var(--surface); }
.rain-geom span { font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
.rain-geom input { width: 62px; padding: 0; border: 0; background: transparent; color: var(--text); font: inherit; font-size: var(--fs-3); text-align: right; outline: none; font-variant-numeric: tabular-nums; }
.rain-geom input:disabled, .rain-geom input[readonly] { color: var(--text-faint); }
.rain-geom i { font-style: normal; font-size: var(--fs-1); color: var(--text-faint); }
.so-name input { width: 132px; text-align: left; }
.chips { display: inline-flex; gap: 5px; }
.chip { border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted); height: var(--h-ctl); padding: 0 10px; cursor: pointer; border-radius: var(--r-ctl); font-size: var(--fs-3); }
.chip:hover { border-color: var(--accent); color: var(--text); }
.chip.on { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 600; }

/* 卫星检索 */
.so-sat { position: relative; }
.so-search { position: relative; display: inline-flex; }
.so-search input { font: inherit; font-size: var(--fs-3); height: 25px; width: 150px; padding: 0 8px; border: 1px solid var(--field-border); border-radius: var(--r-ctl); background-color: var(--field-bg); color: var(--text); outline: none; }
.so-search input:focus { border-color: var(--accent-ui); }
.so-drop { position: absolute; top: calc(100% + 3px); left: 0; min-width: 380px; max-height: 300px; overflow-y: auto; z-index: 50; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-2); border-radius: var(--r-box); padding: 3px; }
.so-drop-i { display: flex; align-items: baseline; gap: 5px; padding: 4px 8px; cursor: pointer; font-size: var(--fs-3); color: var(--text-muted); border-radius: var(--r-ctl); white-space: nowrap; }
.so-drop-i:hover { background: var(--surface-2); color: var(--text); }
.so-drop-i.dim { color: var(--text-faint); cursor: default; }
.so-drop-i b { font-weight: 600; color: var(--text); }
.so-d { color: var(--text-faint); }
.so-n { font-family: var(--font-mono); color: var(--text-faint); }
.so-g { margin-left: auto; color: var(--text-faint); font-size: var(--fs-2); }
.so-tag { font-size: var(--fs-1); padding: 0 5px; border: 1px solid var(--border); border-radius: var(--r-ctl); color: var(--text-faint); }
.so-tag.igso { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }

/* 读数行（含运行时数据，口径说明在 title） */
.so-read { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-3); color: var(--text-muted); }
.so-read-k { font-size: var(--fs-2); color: var(--text-faint); white-space: nowrap; }
.so-read b { font-family: var(--font-mono); font-weight: 400; color: var(--text); }
.so-read b.far { color: var(--warn); }

.rain-grid { flex: 1 1 auto; min-height: 0; min-width: 0; overflow: hidden; display: flex; padding: 8px; }
.rain-grid > * { flex: 1 1 auto; min-height: 0; min-width: 0; }
.rain-stale { flex: none; font-size: var(--fs-2); padding: 2px 7px; color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); border-radius: var(--r-ctl); background: color-mix(in srgb, var(--warn) 8%, transparent); }

.lb-foot { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.lb-calc { flex: none; white-space: nowrap; font: inherit; font-size: var(--fs-4); font-weight: 600; height: var(--h-ctl-lg); padding: 0 18px; border: 1px solid var(--accent); background: var(--accent); color: var(--bg); border-radius: var(--r-ctl); cursor: pointer; }
.lb-calc:disabled { opacity: .55; cursor: default; }

/* 结果栏 */
.lb-result-bd { flex: 1 1 auto; overflow: auto; padding: 10px; }
.so-sec + .so-sec { margin-top: 18px; border-top: 1px solid var(--border); padding-top: 14px; }
.so-sec-t { margin: 0 0 8px; font-family: var(--font-serif); font-size: var(--fs-5); font-weight: 600; color: var(--text); }
.so-sec-t b { font-family: var(--font-mono); font-weight: 400; font-size: var(--fs-3); color: var(--text-faint); margin-left: 6px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; margin-bottom: 12px; }
.card { border: 1px solid var(--border); background: var(--bg); padding: 6px 9px; border-radius: var(--r-ctl); display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.card i { font-style: normal; font-size: var(--fs-1); color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-u { font-size: var(--fs-1); color: var(--text-faint); font-family: var(--font-mono); }
.card b { font-weight: 600; font-size: var(--fs-3); color: var(--text); font-family: var(--font-mono); }

/* 八列在 540 px 栏里放不下：整表可横滚，别把「峰值恶化」「最小夹角」两列挤没 */
.tblwrap { overflow-x: auto; }
.tbl { width: 100%; min-width: 520px; border-collapse: collapse; font-size: var(--fs-3); }
.tbl td, .tbl th { white-space: nowrap; }
.tbl th { text-align: left; color: var(--text-muted); font-weight: 500; border-top: 2px solid var(--border-strong); border-bottom: 1px solid var(--border-strong); padding: 5px 7px; white-space: nowrap; }
.tbl td { padding: 4px 7px; border-bottom: 1px solid var(--border); }
.tbl tr:last-child td { border-bottom: 2px solid var(--border-strong); }
.tbl .r { text-align: right; }
.tbl .c { text-align: center; }
.tbl .mono { font-family: var(--font-mono); }
.tbl .strong { font-weight: 600; }
.tbl tr.peak td { background: var(--surface-2); }
.star { color: var(--warn); }
.v-ok { color: var(--ok); }
.v-warn { color: var(--warn); }
.v-danger { color: var(--danger); }

.so-empty { padding: 40px 12px; text-align: center; color: var(--text-muted); font-size: var(--fs-3); }
.so-empty .dim { color: var(--text-faint); font-family: var(--font-mono); margin-top: 6px; }
.rain-err { color: var(--danger); font-size: var(--fs-4); padding: 16px 8px; }

/* 弹窗 */
.lb-mask { position: fixed; inset: 0; background: rgba(0,0,0,.28); display: flex; align-items: center; justify-content: center; z-index: 300; }
.lb-dlg { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card); padding: 16px; min-width: 300px; box-shadow: var(--shadow-3); }
.lb-dlg-hd { font-size: var(--fs-4); font-weight: 600; margin-bottom: 10px; }
.lb-dlg-msg { font-size: var(--fs-3); color: var(--text-muted); margin-bottom: 12px; line-height: 1.6; }
.lb-dlg-inp { width: 100%; box-sizing: border-box; font: inherit; padding: 6px 8px; border: 1px solid var(--field-border); border-radius: var(--r-ctl); background: var(--field-bg); color: var(--text); margin-bottom: 12px; }
.lb-dlg-acts { display: flex; justify-content: flex-end; gap: 8px; }
</style>
