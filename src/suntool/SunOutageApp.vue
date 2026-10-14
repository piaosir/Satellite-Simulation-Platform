<script setup>
// 日凌预报（GSO）独立窗口 —— 与雨衰计算页同一范式的三栏工作台：
//   左「配置列表」（configs.sun.json，ConfigTree 三件套）· 中「站表」（StationGrid，一行一站）·
//   右「结果」（按站 × 季，读数卡 + 逐日表）。
// 计算在主进程（core.calculateSunOutageSeasons，v5.2 引擎），本组件只负责采集 / 展示 / 持久化。
// 取星两档：定轨＝把卫星当理想地球静止轨道（按轨位）；星历＝按该星 GP 根数逐时刻 SGP4 推算。
// 判据两档：恶化门限＝ D(θ) ≥ D_th；纯几何＝ θ_th ≡ θ_3dB = 70λ/D。
import { ref, reactive, shallowRef, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { askConfirm } from '../shared/ui/useConfirm.js'   // 确认框（全平台一份）
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ActivationLock from '../components/ActivationLock.vue'
import Icon from '../components/Icon.vue'
import StationGrid from '../linkbudget/StationGrid.vue'
import ConfigTree from '../components/ConfigTree.vue'
import ConfigTreeMenu from '../components/ConfigTreeMenu.vue'
import TzPicker from '../components/TzPicker.vue'
import WinStatusBar from '../components/WinStatusBar.vue'
import LbVersionsDialog from '../components/LbVersionsDialog.vue'
import { useNotice } from '../shared/useNotice.js'
import { reportError } from '../shared/reportError.js'
import { errText } from '../shared/errText.js'
import { useConfigTree } from '../shared/useConfigTree.js'
import { useConfigAutosave } from '../shared/useConfigAutosave.js'
import { useConfigVersions } from '../shared/useConfigVersions.js'
import { stableStringify } from '../shared/configDirty.js'
import { tzParts, tzTag, normTzMode } from '../shared/tz.js'
import { byLang, curLang } from '../shared/i18n/lang.js'
import { halfStr } from '../shared/num.js'
import { epochMs } from '../shared/epochMs.js'
import { fmtGeoSlot, classifyOrbit } from '../shared/orbitClass.js'
import { SAT_PRESETS } from '../linkbudget/satPresets.js'
import { ensureSearchPool, findPoolByNorad, orbitSpecOf, slotLonOf } from '../ngso/satSearchPool.js'
import {
  sunFields, GRID_GROUPS, RESULT_DIGITS, SEASONS, SEASON_CN, normSeasons,
  defaultRow, effectiveRow, buildSpec, blankState, normState, equinoxApproxMs,
  normSatName, matchSat, SAT_SOURCE_LABEL, ORBIT_TYPE, ORBIT_INLINE_MAX
} from './sunParams.js'

const api = (typeof window !== 'undefined' && window.api) ? window.api.sunOutage : null
const STATE_KEY = 'sun/last'      // 只记「上次打开的是哪一份」；v1.5.1 及以前存的是整份场景（见 onMounted 的迁移）
const winApi = (typeof window !== 'undefined' && window.api) || null   // 配置库（store.*）走总桥
const p2 = (n) => String(n).padStart(2, '0')
const pf = (v) => { const x = parseFloat(halfStr(v)); return Number.isFinite(x) ? x : NaN }
const fx = (v, d) => (v == null || !Number.isFinite(+v)) ? '—' : (+v).toFixed(d)

// ============ 窗内提示（shared/useNotice：普通 4 s · 导出带「打开 · 在文件夹中显示」· 失败常驻）============
const N = useNotice()
const { toast, toastFile } = N
// 主进程保存处理器回的实际写入路径（新字段 path / paths；兼容旧的 filePath）
const outPath = (r) => (r && (r.path || (Array.isArray(r.paths) && r.paths[0]) || r.filePath)) || ''
// 站表「导入 / 导出 Excel」的回执（StationGrid emit xlsxDone）
function onGridXlsx(r) { if (!r) return; if (r.kind === 'export') { if (r.path) toastFile('已导出 Excel', r.path); else toast('已导出 Excel') } else toast(`已导入 ${r.rows || 0} 行`) }
const baseName = (p) => String(p || '').split(/[\\/]/).pop()

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
const criterion = reactive({ mode: 'degradation', degDb: '1' })
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
  criterion: { mode: criterion.mode, degDb: criterion.degDb }
})

// ============ F10.7 数据（顶栏读数）============
// 太阳亮温按野边山回归谱 + F10.7 算出来，F10.7 由主进程按分点日从 NOAA SWPC 取。
// 这一行只报【本机这份 SWPC 数据的时间与来源】；点一下硬刷一遍全链路。
// 刷新完不自动重算 —— 结果卡里那一行写的是算的时候用的值。
const sfStatus = shallowRef(null)
const sfBusy = ref(false)
// 非空 = 最近一次手动刷新没取到新数据：读数行如实挂「更新失败」，原因在悬停 title（不弹框）
const sfFail = ref('')
const sfFresh = (s) => !!(s && (s.source === 'network' || s.source === 'cloud'))
async function loadSolarFlux() {
  if (!api || !api.solarFlux) return
  const before = sfStatus.value
  try {
    const s = await api.solarFlux()
    sfStatus.value = s
    // 后台那一轮（主进程开窗 / 算完顺手刷）换到了新数据：撤掉上次手动刷新留下的失败标记
    if (sfFail.value && sfFresh(s) && (!before || before.fetchedAt !== s.fetchedAt)) sfFail.value = ''
  } catch (e) { /* 取不到就不显示这一行 */ }
}
async function refreshSolarFlux() {
  if (!api || !api.solarFluxRefresh || sfBusy.value) return
  sfBusy.value = true
  const before = sfStatus.value
  try {
    const s = await api.solarFluxRefresh()
    sfStatus.value = s
    // 主进程刷新失败不抛、照样回 status（数据仍是原来那份）。强制刷新真成功时来源必是直连 / 云镜像，
    // 且不会与刷新前那份直连 / 云镜像数据同一时间。
    const ok = sfFresh(s) && !(sfFresh(before) && before.fetchedAt === s.fetchedAt)
    sfFail.value = ok ? '' : (s && s.offline ? byLang('离线', 'Offline') : byLang('SWPC 与云镜像均不可用', 'SWPC and cloud mirror unavailable'))
  } catch (e) { sfFail.value = errText(e) }
  finally { sfBusy.value = false }
}
const SF_SRC = { network: ['直连', 'Direct'], cloud: ['云镜像', 'Cloud mirror'], cache: ['本地缓存', 'Local cache'], bundled: ['内置快照', 'Bundled snapshot'] }
const sfText = computed(() => {
  const s = sfStatus.value
  if (!s || !s.source) return ''
  const src = SF_SRC[s.source] ? byLang(SF_SRC[s.source][0], SF_SRC[s.source][1]) : s.source
  const d = s.fetchedAt ? String(s.fetchedAt).slice(0, 10) : '—'
  return `${d} · ${src}`
})
// F10.7 的来源词表（结果卡里那一行；与主进程 solarFluxPick 的 source 一一对应）
const F107_SRC = {
  daily: ['观测', 'Observed'], forecast45: ['45 天预报', '45-day forecast'],
  monthly: ['观测月均', 'Monthly mean'], predicted: ['预测', 'Predicted'],
  'predicted-tail': ['预测末值', 'Predicted (tail)'], default: ['缺省', 'Default']
}
function f107Line(m) {
  if (!m || !(m.f107 > 0)) return ''
  const s = F107_SRC[m.f107Source] ? byLang(F107_SRC[m.f107Source][0], F107_SRC[m.f107Source][1]) : (m.f107Source || '')
  return `F10.7 ${m.f107.toFixed(1)} · ${s}${m.f107At ? ' ' + m.f107At : ''}`
}

// 任一计算输入变化 → 亮「输入已变」（不做打字防抖自动重算，与雨衰页同口径）
// ★ F10.7 不在其中：它不是用户输入，刷新它也不该把结果判作过期。
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
// 返回是否按当前输入算完了整表（逐站算不出的 ✕ 也算算完）：导出前补算要据此决定导不导（见 runExport）
let _gen = 0
async function compute() {
  if (!api) { toast('计算需在桌面客户端中运行'); return false }
  if (!stations.length) { toast('暂无地球站。'); return false }
  const y = parseInt(String(halfStr(year.value)), 10)
  if (!(y >= 1900 && y <= 2200)) { toast('年份需在 1900 ~ 2200 之间'); return false }
  if (sat.source === 'slot' && !Number.isFinite(pf(sat.slotLon))) { toast('卫星轨位未填写。'); return false }
  if (criterion.mode === 'degradation' && !(pf(criterion.degDb) > 0)) { toast('恶化门限需大于 0 dB'); return false }

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
      if (gen !== _gen) return false                                  // 重算期间又点了计算：本轮作废
      const arr = Array.isArray(out) ? out : []
      for (let j = 0; j < arr.length; j++) if (ids[i + j]) acc[ids[i + j]] = arr[j]
      resultById.value = { ...acc }
    }
    resultsStale.value = false
    loadSolarFlux()        // 算完再取一次：主进程算的时候可能顺手把 SWPC 刷新了
    const errs = Object.values(acc).filter((x) => { const a = x && (x.vernal || x.autumnal); return !a || a.error }).length
    toast(errs ? byLang(`完成，${errs}/${ids.length} 个地球站算不出（见表内 ✕）`, `Done, ${errs}/${ids.length} stations failed`)
      : byLang(`完成，共 ${ids.length} 个地球站`, `Done, ${ids.length} stations`))
    return true
  } catch (e) {
    if (gen === _gen) { reportError('计算失败', e); resultById.value = {} }
    return false
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
    try { sat.orbit = orbitSpecOf(rec) } catch (e) { sat.orbit = null; toast('该卫星的轨道类型无法用于日凌计算') }
    sat.epoch = rec.epoch || ''
    sat.inclDeg = Number(rec.incl) || 0
  }
  if (Number.isFinite(rec._slot)) sat.slotLon = rec._slot.toFixed(2)
  kw.value = ''
}
async function refreshOrbit() {
  if (!sat.noradId) return
  const rec = await findPoolByNorad(sat.noradId)
  if (!rec) { toast('星历库中未找到该卫星'); return }
  try { sat.orbit = orbitSpecOf(rec) } catch (e) { toast('该卫星的轨道类型无法用于日凌计算'); return }
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

// —— 主窗口带上下文打开（地图右键 / 卫星信息栏「分析 ▸ 日凌预报」）——
// 一份配置一颗星：带来的星不是当前这颗 → 新建一份配置承接（当前配置有没存的改动照常先问），原配置不动；
// 是同一颗 → 只追加站。星取自星历池（按 NORAD，与搜索选星同一出口 pickSat）；池里没有就按定点经度（轨位法）。
// 站址追加成行；新建的配置里那条出厂默认行由站址行顶替。开窗时配置未载入则排队。
const _ctxQueue = []
let _ctxReady = false, _ctxChain = Promise.resolve()
function onToolContext(c) { if (!_ctxReady) { _ctxQueue.push(c); return } _ctxChain = _ctxChain.then(() => applyToolContext(c)).catch((e) => { reportError('载入地图带入的对象', e) }) }
function flushToolContext() { _ctxReady = true; for (const c of _ctxQueue.splice(0)) onToolContext(c) }
const ctxNameKey = (s) => String(s || '').trim().toLowerCase()
const isCurSat = (s) => (s.noradId && sat.noradId ? String(sat.noradId) === s.noradId : ctxNameKey(sat.name) === ctxNameKey(s.name))
async function applyToolContext(c) {
  if (!c) return
  const s = c.sat, sites = c.sites || []
  let fresh = false
  if (s && !isCurSat(s)) {
    // 带来的是另一颗星：另建一份配置承接（当前配置的改动先落盘），原配置不动；
    // 新配置名字随内容（星名 + 年份），带来的星 / 站直接写进它
    const n = await cfgTree.createAndOpen({ state: blankState(), nameAuto: true })
    if (!n) return
    fresh = true
    let rec = null
    if (s.noradId) { try { rec = await findPoolByNorad(s.noradId) } catch (e) { rec = null } }
    if (rec) {
      const lon = slotLonOf(rec)
      pickSat({ ...rec, _slot: Number.isFinite(lon) ? lon : (s.slotLon != null ? s.slotLon : NaN) })
    } else {
      // 池里没有（离线 / 天线树虚拟星的合成号）：不记编号，免得之后「刷新星历」按一个查不到的号去找
      Object.assign(sat, { name: s.name || sat.name, noradId: '', orbit: null, epoch: '', inclDeg: null, groupLabel: '', source: 'slot' })
      if (s.slotLon != null) sat.slotLon = s.slotLon.toFixed(2)
    }
  }
  if (sites.length) {
    const rows = sites.map((x) => mkRow({ stationName: x.name || '', longitude: String(x.lon), latitude: String(x.lat) }))
    if (fresh) stations.splice(0, stations.length, ...rows)
    else stations.push(...rows)
  }
  toast((sites.length
    ? byLang(`已添加 ${sites.length} 个地球站（${sat.name}）`, `Added ${sites.length} station${sites.length === 1 ? '' : 's'} (${sat.name})`)
    : byLang(`已载入卫星：${sat.name}`, `Satellite loaded: ${sat.name}`)))
}
const _stopCtx = (typeof window !== 'undefined' && window.api && window.api.tools) ? window.api.tools.onContext(onToolContext) : null
onBeforeUnmount(() => { if (_stopCtx) _stopCtx() })
const slotText = computed(() => fmtGeoSlot(pf(sat.slotLon)) || (sat.slotLon ? sat.slotLon + '°E' : '—'))
// 星历档读数：历元 · 距各分点天数 · 倾角（含运行时数据的读数行，口径说明放 title）
const epochRead = computed(() => {
  if (sat.source !== 'ephemeris' || !sat.epoch) return null
  const ms = epochMs(sat.epoch)          // OMM 历元不带 Z，裸 Date.parse 会按本机时区解，差几小时
  if (!Number.isFinite(ms)) return null
  const t = tzParts(ms, tzMode.value)
  const y = parseInt(String(halfStr(year.value)), 10)
  const gaps = seasons.value.map((s) => {
    const eq = equinoxApproxMs(y, s)
    const d = Number.isFinite(eq) ? Math.round((eq - ms) / 86400e3) : NaN
    return {
      season: s,
      // 含运行时数据的读数：整串由 byLang 出中英，不进呈现层词典
      text: byLang('距' + SEASON_CN[s], 'from ' + (s === 'vernal' ? 'spring equinox' : 'autumn equinox')),
      days: Number.isFinite(d) ? String(d).replace('-', '−') : '—',
      far: Number.isFinite(d) && Math.abs(d) > 60
    }
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
  return {
    start: d(sp.start), end: d(sp.end),
    miss: cov ? byLang(`缺 ${cov} 天`, `${cov} days missing`) : ''
  }
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

// —— 逐日表一行 → 主窗口（C3，api.scene.cmd）：拨时间轴到该日峰值时刻 · 聚焦这颗星 · 时间轴上标出该日日凌窗口 ——
// 主窗口不在 / 老主进程没有 scene 通道时按钮不出。时刻按引擎给的 UTC 日期 + 时刻还原（跨 UTC 零点的那一日把
// 峰值 / 结束顺延一天）；星按当前这颗认（NORAD 优先，定轨档没有编号就按星名）。
const sceneApi = (typeof window !== 'undefined' && window.api && window.api.scene && window.api.scene.cmd) ? window.api.scene : null
async function locateInMain(d) {
  if (!sceneApi || !d) return
  const at = (hms) => Date.parse(`${d.date}T${hms}Z`)
  const t0 = at(d.startTimeUTC)
  const fix = (t) => (Number.isFinite(t) && Number.isFinite(t0) && t < t0 ? t + 86400e3 : t)
  const tp = fix(at(d.peakTimeUTC)), t1 = fix(at(d.endTimeUTC))
  if (!Number.isFinite(tp)) return
  const row = selRow.value
  const site = (row && String(effectiveRow(row).stationName || '').trim()) || byLang('地球站', 'Station')
  try {
    await sceneApi.cmd('seekClock', { tMs: tp })
    if (sat.noradId || (sat.name || '').trim()) {
      await sceneApi.cmd('focusSat', sat.noradId ? { norad: String(sat.noradId), name: sat.name || '' } : { name: String(sat.name).trim() })
    }
    if (Number.isFinite(t0)) {
      await sceneApi.cmd('markTime', { t0, t1: Number.isFinite(t1) ? t1 : undefined, label: byLang('日凌 ', 'Sun outage ') + site, src: 'suntool' })
    }
  } catch (e) { reportError('在主窗口定位', e) }
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
    // F10.7 的取值与出处（Word 参数表「太阳亮温」行 + 方法段那一句、ICS 描述行）
    f107: good && any.model ? any.model.f107 : null,
    f107Source: good && any.model ? any.model.f107Source : null,
    f107At: good && any.model ? any.model.f107At : null,
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
          durSec: d.durationSec, durMin: Math.round(d.durationSec / 6) / 10, durStr: d.durationStr,
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
      slotLon: Number.isFinite(pf(sat.slotLon)) ? pf(sat.slotLon) : null,
      source: sat.source, noradId: sat.noradId || null,
      epoch: sat.epoch || null, inclDeg: sat.inclDeg
    },
    year: parseInt(String(halfStr(year.value)), 10),
    seasons: seasons.value.slice(),
    tzLabel: tzLabel.value,
    criterion: { mode: criterion.mode, degDb: criterion.degDb },
    stations: stations.map(stationExport),
    lang: curLang()      // Word / Excel / ICS 的表头 / 表题 / 表注跟界面语言（report.js 日凌三件）
  }))
}
const fileBase = computed(() => `${byLang('日凌预报', 'Sun Outage Forecast')}_${(sat.name || '').trim() || slotText.value}_${year.value}`)
async function runExport(kind) {
  if (!api || computing.value) return
  // 导出讲【当前输入】（口径同链路预算四窗的导出前补算）：输入已变或还没算过，先按当前输入算一遍；
  // 算不成就不导 —— 文件里不许是新参数配旧日凌窗口。原因 compute 已就地提示。
  if (resultsStale.value || !hasResults.value) {
    if (!(await compute()) || !hasResults.value) return
  }
  const p = exportPayload()
  p.defaultName = `${fileBase.value}.${kind === 'excel' ? 'xlsx' : kind === 'word' ? 'docx' : 'ics'}`
  const fn = kind === 'excel' ? api.exportExcel : kind === 'word' ? api.exportWord : api.exportIcs
  if (!fn) { toast('导出需在桌面客户端中运行'); return }
  try {
    const r = await fn(p)
    if (r && r.ok) { const fp = outPath(r); toastFile(byLang('已导出：', 'Exported: ') + baseName(fp), fp) }
    else if (r && !r.canceled) reportError('导出失败', r.error)
  } catch (e) { reportError('导出失败', e) }
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
    criterion: { mode: criterion.mode, degDb: criterion.degDb },
    stations: stations.map((r) => { const o = {}; for (const k in r) if (k !== '_id') o[k] = r[k]; return o })
  })
}
// 站表组件（StationGrid）：载入配置时要清它的撤销 / 重做栈
const stationGridRef = ref(null)
function applyState(st) {
  // 换了一份内容：表格撤销栈里存的是上一份的行，不清的话一按撤销就把它整张灌进当前配置（表格不随配置重建）
  if (stationGridRef.value) stationGridRef.value.clearHistory()
  const s = normState(st)
  // orbit 原样落回（含将来的 { type, ref } 引用形状）：引用怎么解析是主进程 resolveOrbitSpec 的事，窗口不碰
  Object.assign(sat, s.sat)
  year.value = s.year
  seasons.value = s.seasons.slice()
  criterion.mode = s.criterion.mode; criterion.degDb = s.criterion.degDb
  stations.splice(0, stations.length, ...s.stations.map((r) => mkRow(r)))
  selectedId.value = stations[0] ? stations[0]._id : null
  resultById.value = {}        // 换一份配置就把结果撤掉（重算是秒级的）
  resultsStale.value = false
}

// —— 配置自动保存（与链路预算四窗同口径，2026-10-15 起取消「保存 / 另存」）——
// 工作区恒对应配置列表里的一份配置，改动约 1 s 后写回；后悔药是历史版本。
function fingerprintOf(st) { return stableStringify(normState(st)) }
// 自动名（名字随内容的配置用）：星名（或轨位）+ 年份，按平台语言出字
function defaultCfgName() {
  const who = (sat.name || '').trim() || slotText.value
  return byLang(`${who} 日凌 ${year.value}`, `${who} Sun Outage ${year.value}`)
}
function cfgLabelOf(st) {
  const n = normState(st)
  const who = ((n.sat && n.sat.name) || '').trim() || (n.sat && n.sat.slotLon != null && n.sat.slotLon !== '' ? (fmtGeoSlot(Number(n.sat.slotLon)) || '') : '')
  return byLang(`${who} 日凌 ${n.year} · ${n.stations.length} 站`, `${who} Sun Outage ${n.year} · ${n.stations.length} sta`)
}
function setBaseline() { autosave.attach() }
async function guardedLeave() {
  if (await autosave.flush()) return true
  return await askConfirm(`「${cfgTree.activeName()}」的改动未能写入磁盘（${saveError.value}）。仍要离开？`)
}

const cfgTree = useConfigTree({
  ns: 'sun', orbitType: ORBIT_TYPE, api: winApi, storageKey: 'sun/cfgExpanded',
  toast, blankState, serializeState, applyState, setBaseline, guardedLeave, askConfirm, defaultCfgName,
  autosave: true, onNameAuto: (id) => { if (id === activeId.value) autosave.flush() }
})
const {
  configs, activeId, focusId, expandedFolders, editing, cfgClip, ctxMenu,
  loadConfigs, uniqueCfgName, selectConfig, ensureActive, duplicateItem,
  toggleFolder, expandAll, collapseAll,
  addFolder, addBlankConfig, onDeleteItem, onMove, moveToRoot,
  startRename, commitRename, cancelRename,
  copyItem, cutItem, pasteConfig, ctxItem, ctxIsFolder, openCtx, closeCtx, onCfgKey
} = cfgTree
const autosave = useConfigAutosave({
  ns: 'sun', api: winApi, activeId, itemById: cfgTree.itemById, serialize: serializeState, fingerprint: fingerprintOf,
  autoName: defaultCfgName, uniqueName: uniqueCfgName, summarize: (st) => ({ label: cfgLabelOf(st) }), toast
})
const { error: saveError } = autosave
let stopAutosaveListen = null
onBeforeUnmount(() => { if (stopAutosaveListen) stopAutosaveListen(); autosave.dispose() })
const { verDlg, openVersions, restoreVersion, duplicateVersion } = useConfigVersions({
  ns: 'sun', api: winApi, tree: cfgTree, autosave, applyState, summarize: (st) => ({ label: cfgLabelOf(st) }), fingerprint: fingerprintOf, toast
})
watch([sat, year, seasons, criterion, stations], () => autosave.touch(), { deep: true })
watch(activeId, (id) => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ activeId: id || null })) } catch (e) { /* 配额满等忽略 */ } })

// 左侧栏「配置列表」显隐（功能区「配置列表」与栏头 × / 右键「隐藏配置列表」互为一对；记住上次）
const showConfigs = ref((() => { try { return localStorage.getItem('sun/showConfigs') !== '0' } catch (e) { return true } })())
watch(showConfigs, (v) => { try { localStorage.setItem('sun/showConfigs', v ? '1' : '0') } catch (e) { /* ignore */ } })
// Ctrl+Enter = 计算（全部计算窗同一个键）
function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing && !computing.value) { e.preventDefault(); compute() }
}
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))

onMounted(async () => {
  // 城市库全量：StationGrid 拿它做「站名 → 经纬度」反查（CityPicker 自己走 window.api.linkBudget，与本窗口无关）
  try { cities.value = (api && await api.cities()) || [] } catch (e) { cities.value = [] }
  loadSolarFlux()          // 不 await：这一行只是读数，开窗不必等它
  await loadConfigs()
  // 打开上次那份配置；它没了就开树上第一份，一份都没有就新建一份空白配置（工作区恒对应一份配置）。
  // 迁移：v1.5.1 及以前「上次会话」存的是整份场景——对应的配置还在就接上那份改动；不属于任何配置、
  // 又不是出厂空白的（旧版允许不存配置直接用）存成一份新配置，免得升级后丢了。
  let last = null
  try { last = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') } catch (e) { last = null }
  const hasScene = !!(last && Array.isArray(last.stations))
  if (hasScene && !last.activeId && fingerprintOf(last) !== fingerprintOf(blankState())) await cfgTree.createAndOpen({ state: last, nameAuto: true })
  await ensureActive(last && last.activeId)
  if (hasScene && last.activeId && last.activeId === activeId.value) { applyState(last); autosave.touch() }
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ activeId: activeId.value || null })) } catch (e) { /* 配额满等忽略 */ }
  // 关窗：把挂起的写盘冲掉即放行；只有写不进磁盘时才问一句
  api?.onCloseRequested?.(async () => {
    const ok = await autosave.flush()
    if (!ok && !(await askConfirm(`「${cfgTree.activeName()}」的改动未能写入磁盘（${saveError.value}）。仍要关闭窗口？`))) return
    api.confirmClose()
  })
  stopAutosaveListen = autosave.listen()   // 窗口失焦 / 页面隐藏时立即写盘
  window.addEventListener('keydown', onGlobalKey)
  flushToolContext()   // 配置已载入：处理开窗时随窗带来的主窗口上下文
})
</script>

<template>
  <div class="lb-shell">
    <ActivationLock />
    <ConfigTreeMenu
      :menu="ctxMenu" :item="ctxItem" :is-folder="ctxIsFolder" :clip="cfgClip" :has-api="!!winApi" autosave
      @close="closeCtx" @rename="startRename" @new-folder="addFolder" @new-config="addBlankConfig"
      @cut="cutItem" @copy="copyItem" @paste="pasteConfig" @move-root="moveToRoot"
      @delete="onDeleteItem" @expand-all="expandAll" @collapse-all="collapseAll" @hide="showConfigs = false"
      @duplicate="duplicateItem" @versions="(it) => openVersions(it.id)"
    />


    <div class="lb-body">
      <!-- ① 配置列表 -->
      <aside v-show="showConfigs" class="lb-col lb-side lb-configs" :class="{ resizing: cfgResizing }" :style="{ width: configsWidth + 'px' }">
        <div class="lb-col-hd">
          <span class="lb-cfg-hd-t">配置列表</span>
          <span class="lb-cfg-acts">
            <button class="lb-mini lb-mini-ico" title="新建文件夹" :disabled="!winApi" @click="addFolder(null)"><Icon name="folder-plus" :size="12" /></button>
            <button class="lb-mini lb-mini-ico" title="新建配置" :disabled="!winApi" @click="addBlankConfig(null)"><Icon name="plus" :size="12" /></button>
            <button class="lb-mini lb-mini-ico" title="隐藏配置列表" @click="showConfigs = false"><Icon name="x" :size="12" /></button>
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
        <div class="lbr">
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big primary" :disabled="computing || !api || !stations.length" :title="calcText + '（Ctrl+Enter）'" @click="compute">
                <svg viewBox="0 0 16 16" class="lbr-svg fill"><path d="M4 2.5 13 8 4 13.5z" /></svg>
                {{ computing ? '计算中…' : '计算' }}
              </button>
            </div>
            <div class="lbr-cap">计算</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="!winApi || !activeId" title="历史版本：自动留存于打开时、编辑中每 10 分钟、还原前" @click="openVersions(activeId)"><Icon name="history" :size="16" />历史版本</button>
              <button v-if="saveError" class="lbr-big lbx-savefail" :title="'配置未能写入磁盘：' + saveError + '。单击重试'" @click="autosave.flush()"><Icon name="alert-triangle" :size="16" />未写入</button>
              <button class="lbr-big" :class="{ on: showConfigs }" :aria-pressed="showConfigs ? 'true' : 'false'" title="左侧栏显示「配置列表」" @click="showConfigs = !showConfigs"><Icon name="panel-left" :size="16" />配置列表</button>
            </div>
            <div class="lbr-cap">文件</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="!api || computing || !stations.length" title="导出 Excel 日凌时间表（每季一张工作表）" @click="runExport('excel')"><Icon name="file-export" :size="16" />Excel</button>
              <button class="lbr-big" :disabled="!api || computing || !stations.length" title="导出 Word 报告（逐站一节）" @click="runExport('word')"><Icon name="file-text" :size="16" />Word</button>
              <button class="lbr-big" :disabled="!api || computing || !stations.length" title="RFC 5545 iCalendar，Outlook / Google / Apple 日历直接导入，含提前 1 天与 30 分钟提醒" @click="runExport('ics')"><Icon name="calendar" :size="16" />ICS</button>
            </div>
            <div class="lbr-cap">导出</div>
          </div>
          <div v-if="sfText || sfFail" class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :class="{ spin: sfBusy }" :disabled="sfBusy" title="重新联网取 SWPC 太阳射电流量" @click="refreshSolarFlux">
                <Icon name="refresh-cw" :size="16" />
                刷新
              </button>
              <div class="so-reads">
                <div class="so-read-l"><span class="so-read-k">F10.7</span><b data-i18n-skip>{{ sfText || '—' }}</b></div>
                <div v-if="sfFail" class="so-read-l so-sf-err" :title="sfFail">更新失败</div>
              </div>
            </div>
            <div class="lbr-cap">数据</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <TzPicker v-model="tzMode" title="逐日表与报告的时标（ICS 日历事件恒用 UTC，导入后由日历软件换算）" />
            </div>
            <div class="lbr-cap">时区</div>
          </div>
        </div>
        <div class="rain-toolbar">
          <div class="rain-seg-grp so-sat">
            <span class="rain-seg-lb">卫星</span>
            <label class="so-search">
              <input v-model="kw" class="search-field" placeholder="名称 / NORAD" spellcheck="false" @focus="onSearchFocus" @blur="onSearchBlur" />
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
            <div class="seg" role="radiogroup" aria-label="取星">
              <button type="button" class="sg" role="radio" :aria-checked="sat.source === 'slot'" :class="{ on: sat.source === 'slot' }" title="定轨：按轨位把卫星当理想地球静止轨道" @click="setSatSource('slot')">{{ SAT_SOURCE_LABEL.slot }}</button>
              <button type="button" class="sg" role="radio" :aria-checked="sat.source === 'ephemeris'" :class="{ on: sat.source === 'ephemeris' }" :disabled="!canEphem"
                      :title="canEphem ? '星历：按该星 GP 根数逐时刻 SGP4/SDP4 推算真实位置（含倾角、偏心率与漂移，不含轨道保持机动）' : '需先检索到带星历的卫星'"
                      @click="setSatSource('ephemeris')">{{ SAT_SOURCE_LABEL.ephemeris }}</button>
            </div>
            <label class="rain-geom" :title="sat.source === 'ephemeris' ? '历元星下点经度（星历档下由根数计算得出）' : '定点轨位（东经为正，西经为负）'">
              <span>轨位</span><input v-model="sat.slotLon" :readonly="sat.source === 'ephemeris'" spellcheck="false" /><i>°E</i>
            </label>
          </div>
          <div v-if="epochRead" class="so-read">
            <span class="so-read-k">历元</span><b data-i18n-skip>{{ epochRead.stamp }}</b>
            <template v-for="g in epochRead.gaps" :key="g.season">
              <span class="so-d" data-i18n-skip>·</span><span class="so-read-k" data-i18n-skip>{{ g.text }}</span><b :class="{ far: g.far }" data-i18n-skip>{{ g.days }}</b><span class="so-read-k">天</span>
            </template>
            <span class="so-d" data-i18n-skip>·</span><span class="so-read-k">倾角</span><b data-i18n-skip>{{ epochRead.incl }}°</b>
            <button v-if="sat.orbit && sat.orbit.type === 'omm'" class="lb-mini" title="按 NORAD 回星历库重取根数" @click="refreshOrbit">刷新星历</button>
          </div>
          <div v-if="spanRead" class="so-read">
            <span class="so-read-k">星历覆盖</span><b data-i18n-skip>{{ spanRead.start }} ~ {{ spanRead.end }}</b>
            <template v-if="spanRead.miss"><span class="so-d" data-i18n-skip>·</span><span class="so-read-k" data-i18n-skip>{{ spanRead.miss }}</span></template>
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
              <button v-for="s in SEASONS" :key="s" type="button" class="btn sm" :class="{ on: seasonOn(s) }" :aria-pressed="(seasonOn(s)) ? 'true' : 'false'" @click="toggleSeason(s)">{{ SEASON_CN[s] }}</button>
            </span>
          </div>
          <div class="rain-seg-grp">
            <span class="rain-seg-lb">判据</span>
            <div class="seg" role="radiogroup" aria-label="判据">
              <button type="button" class="sg" role="radio" :aria-checked="criterion.mode === 'degradation'" :class="{ on: criterion.mode === 'degradation' }" title="恶化门限：D(θ) = 10·lg(1 + ΔT(θ)/T_sys) ≥ D_th" @click="criterion.mode = 'degradation'">恶化门限</button>
              <button type="button" class="sg" role="radio" :aria-checked="criterion.mode === 'geometric'" :class="{ on: criterion.mode === 'geometric' }" title="纯几何：门限角 θ_th ≡ θ_3dB = 70λ/D（全宽，不加太阳视半径）" @click="criterion.mode = 'geometric'">纯几何</button>
            </div>
            <label class="rain-geom"><input v-model="criterion.degDb" :disabled="criterion.mode === 'geometric'" spellcheck="false" /><i>dB</i></label>
            <span v-if="criterion.mode === 'geometric'" class="so-read-k" data-i18n-skip>θ_th = θ_3dB</span>
            <span v-else class="seg nseg" role="radiogroup" aria-label="门限预设">
              <button v-for="p in DEG_PRESETS" :key="p" type="button" class="sg" role="radio" :aria-checked="criterion.degDb === p" :class="{ on: criterion.degDb === p }" @click="criterion.degDb = p">{{ p }} dB</button>
            </span>
          </div>
        </div>

        <div class="rain-grid">
          <StationGrid
            ref="stationGridRef" grid-id="sun.stations" :stations="stations" :fields="fields" :groups="GRID_GROUPS" :freeze-keys="false"
            @xlsx-done="onGridXlsx"
            :cities="cities" :city-search="citySearch"
            :extra-values="extraValues" :cell-class="cellClassFn" :focus-id="selectedId" label="地球站"
            @row-focus="onRowFocus"
          />
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
          <!-- 不挂 data-i18n-skip：引擎报错串是固定文案，交给呈现层查词典（词条在 uiDict.data.js 的 EXACT）。
               词典里没有的串原样返回，与挂 skip 时的表现一致。 -->
          <div v-if="selError" class="rain-err">{{ selError }}</div>
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
                <div class="card"><i>判据</i><b data-i18n-skip>{{ sec.r.model.criterion === 'geometric' ? 'θ_th = θ_3dB' : '≥' + sec.r.model.degThreshold + ' dB' }}</b></div>
                <div class="card"><i>接收系统噪声温度</i><b data-i18n-skip>{{ sec.r.model.sysTemp }} K</b></div>
                <div class="card" title="野边山 1–17 GHz 逐日流量对 F10.7 回归谱 · 17 GHz 以上按 NoRP 35/80 GHz 标定锚定"><i>太阳亮温</i><b data-i18n-skip>{{ sec.r.model.solarTemp }} K</b><span v-if="f107Line(sec.r.model)" class="card-u" data-i18n-skip>{{ f107Line(sec.r.model) }}</span></div>
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
                    <th v-if="sceneApi" class="c"></th>
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
                    <td v-if="sceneApi" class="c so-loc-td">
                      <button class="so-loc" title="在主窗口定位" @click="locateInMain(d)"><Icon name="locate-fixed" :size="12" /></button>
                    </td>
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

    <WinStatusBar :n="N" :busy="progress || (computing ? '计算中…' : '')" :stale="resultsStale" stale-title="计算输入已被修改，结果对应修改前的参数">
      <span v-if="!api" class="lb-hint"><Icon name="alert-triangle" :size="12" /> 需在桌面客户端中运行</span>
    </WinStatusBar>
    <LbVersionsDialog v-model:open="verDlg.open" ns="sun" :cfg-id="verDlg.id" :cfg-name="verDlg.name" @restore="restoreVersion" @duplicate="duplicateVersion" />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
/* 窗口骨架（.lb-shell / .lb-body / .lb-col / .lb-side / .lb-mini…）在 styles/lbworkbench.css，此处只留本窗的变体 */
.lb-shell { font-size: var(--fs-4); overflow: hidden; }

.lb-configs { flex: none; border-right: 1px solid var(--border); background: var(--surface); }
.lb-result { flex: none; border-left: 1px solid var(--border); background: var(--surface); }

/* 结果栏贴窗口右沿，拖宽缝在左缘（startResize 的取负与之配套） */
.so-res-resizer { right: auto; left: 0; }

/* 功能区「数据」组的读数（F10.7 太阳射电流量）：运行时数据，口径在 title */
.so-reads { display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 0 4px; font-size: var(--fs-2); }
.so-read-l { display: flex; align-items: baseline; gap: 5px; white-space: nowrap; }
.so-read-l b { font-weight: 400; color: var(--text); font-family: var(--font-mono); }
.so-sf-err { color: var(--danger); }
.lbr-big.spin .app-icon { animation: ui-spin .7s linear infinite; transform-origin: 50% 50%; }
/* 逐日表行尾「在主窗口定位」：无框图标钮，悬停才显形 */
.tbl td.so-loc-td { padding: 0 4px; }
.so-loc { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 20px; padding: 0; border: 1px solid transparent; border-radius: var(--r-ctl); background: none; color: var(--text-faint); cursor: pointer; }
.so-loc:hover { color: var(--text); border-color: var(--border); background: var(--surface); }
.rain-sel { font: inherit; font-size: var(--fs-3); padding: 3px 6px; border: 1px solid var(--field-border); border-radius: var(--r-ctl); background-color: var(--surface-2); color: var(--text); margin-left: auto; max-width: 220px; }

/* 工具栏（两行：卫星 / 时间与判据） */
.rain-toolbar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
/* 第二条工具条（年份 / 分点 / 判据）无栏头可对，保持原 8px 节奏：两行 = 8+24+8+24+8+1 = 73 */
.rain-toolbar + .rain-toolbar { padding-top: 8px; padding-bottom: 8px; }
.rain-seg-grp { flex: none; display: inline-flex; align-items: center; gap: 7px; }
.rain-seg-lb.nocap { text-transform: none; }
.rain-seg-lb { flex: none; white-space: nowrap; font-size: var(--fs-2); letter-spacing: var(--ls-label); color: var(--text-muted); text-transform: uppercase; }
/* 几何框是输入框不是按钮：与分段同高（--h-ctl，含描边）；底色 / 描边 / 悬停 / 焦点跟全局输入框一套（field-*），
   焦点环描整个框而不是框里的裸 input */
.rain-geom { flex: none; display: inline-flex; align-items: center; gap: 5px; height: var(--h-ctl); box-sizing: border-box; padding: 0 7px 0 8px; border: 1px solid var(--field-border); border-radius: var(--r-ctl); background: var(--field-bg); }
.rain-geom:hover { border-color: var(--field-border-hover); }
.rain-geom:focus-within { border-color: var(--accent-ui); background: var(--field-bg); }
.rain-geom:has(input:focus-visible) { outline: 2px solid var(--accent-ui); outline-offset: -1px; }
.rain-geom input:focus-visible { outline: none !important; }
.rain-geom:has(input:disabled), .rain-geom:has(input[readonly]) { background: var(--field-disabled-bg); border-color: var(--border); }
.rain-geom span { font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
.rain-geom input { width: 62px; padding: 0; border: 0; background: transparent; color: var(--text); font: inherit; font-size: var(--fs-3); text-align: right; outline: none; font-variant-numeric: tabular-nums; }
.rain-geom input:disabled, .rain-geom input[readonly] { color: var(--text-faint); }
.rain-geom i { font-style: normal; font-size: var(--fs-1); color: var(--text-faint); }
.so-name input { width: 132px; text-align: left; }
.chips { display: inline-flex; gap: 5px; }

/* 卫星检索 */
.so-sat { position: relative; }
.so-search { position: relative; display: inline-flex; }
.so-search input { font: inherit; font-size: var(--fs-3); height: var(--h-ctl); width: 150px; padding: 0 8px; border: 1px solid var(--field-border); border-radius: var(--r-ctl); background-color: var(--field-bg); color: var(--text); outline: none; }
.so-drop { position: absolute; top: calc(100% + 3px); left: 0; min-width: 380px; max-height: 300px; overflow-y: auto; z-index: var(--z-pop); background: var(--bg); border: 1px solid var(--border-strong); box-shadow: var(--shadow-2); border-radius: var(--r-box); padding: 3px; animation: ui-float-in var(--dur-2) var(--ease-out); }
.so-drop-i { display: flex; align-items: baseline; gap: 5px; padding: 4px 8px; cursor: pointer; font-size: var(--fs-3); color: var(--text-muted); border-radius: var(--r-ctl); white-space: nowrap; }
.so-drop-i:hover { background: var(--wash-hover); color: var(--text); }
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

/* 空态（P14）：居中一句，距栏头底线 18px（外层 10 + 8） */
.so-empty { padding: 8px 6px; text-align: center; color: var(--text-faint); font-size: var(--fs-3); line-height: 1.7; }
.so-empty p { margin: 0; }
.so-empty .dim { color: var(--text-faint); font-family: var(--font-mono); margin-top: 6px; }
.rain-err { color: var(--danger); font-size: var(--fs-4); padding: 16px 8px; }

</style>
