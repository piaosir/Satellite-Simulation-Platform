<script setup>
// 雨衰计算 独立窗口 —— 通用，面向所有种类卫星（仰角驱动）。
// Excel 式批量计算（每行一算例，雨衰以只读计算列进表）+ 右侧单算例细致分析（交互式坐标系 + SatMaster 版详情），
// 点表格任一行即在右侧细看该算例。算例表与链路预算链路表同一套表格口径（两层表头分区 / 不冻结数据列 / 结果格着色）。
// 计算在主进程 core.calculateRainAttenuation（复用 ITU-R 传播模型），本组件负责采集/展示/配置持久化。
import { ref, reactive, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { askConfirm } from '../shared/ui/useConfirm.js'   // 确认框（全平台一份）
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ActivationLock from '../components/ActivationLock.vue'
import StationGrid from '../linkbudget/StationGrid.vue'   // 通用表格组件（Regen 先例：直接复用）
import ConfigTree from '../components/ConfigTree.vue'
import Icon from '../components/Icon.vue'
import RainPlot from './RainPlot.vue'
import RainDiversity from './RainDiversity.vue'
import WinStatusBar from '../components/WinStatusBar.vue'
import ConfigTreeMenu from '../components/ConfigTreeMenu.vue'
import LbVersionsDialog from '../components/LbVersionsDialog.vue'
import { useConfigTree } from '../shared/useConfigTree.js'
import { useConfigAutosave } from '../shared/useConfigAutosave.js'
import { useConfigVersions } from '../shared/useConfigVersions.js'
import { useNotice } from '../shared/useNotice.js'
import { reportError } from '../shared/reportError.js'
import { rainFields, GRID_GROUPS, RESULT_KEYS, RESULT_DIGITS, LEGACY_KEYS, POL_LABEL, defaultRow, effectiveRow, buildRainCase } from './rainParams.js'
import { stableStringify } from '../shared/configDirty.js'
import { fmtGeoSlot } from '../shared/orbitClass.js'   // 轨位 °E/°W 折算（西经不再写成负°E）
import { byLang, curLang } from '../shared/i18n/lang.js'
import { halfStr } from '../shared/num.js'

const api = (typeof window !== 'undefined' && window.api) ? window.api.rainAttenuation : null
const winApi = (typeof window !== 'undefined' && window.api) || null   // 配置库（store.*）走总桥

// —— 全局选项 ——
const orbitMode = ref('geo')        // 'geo'（输入 GEO 轨位算仰角）| 'ngso'（轨道三要素 → P.618-14 §8 等效仰角）
const direction = ref('down')       // 'down' | 'up'（G/T 衰减 / DND 为下行专属）
const rainModel = ref('auto')       // 'auto'（经纬度→ITU-R P.837 自动填 R0.01）| 'manual'（手填）
// 字段集：几何是全局参数、派生结果收进详情 → 两种轨道类型同一套列
// 多站汇总开关（底栏）：一处控三件事 —— 表加「多站」列组、底栏出多站设置、右栏换成多站结果。
// 关掉即完全回到单算例形态（表不变宽、右栏是曲线+详情），故不需要「页签」这一层。
const divOn = ref(false)
const fields = computed(() => rainFields({ diversity: divOn.value, byAvail: divOpt.inputMode === 'avail' }))
// 只读字段：自动降雨模型 → R0.01 只读（结果列由 f.ro 恒只读，不必列在此）
const readonlyKeys = computed(() => (rainModel.value === 'auto' ? ['rainRate'] : []))
// —— 全局几何（一颗星 / 一个星座对全表地球站，不再逐行填）——
const geoSatLon = ref('130.5')                                        // GEO 定点轨位（°E）
const ngsoOrbit = reactive({ alt: '550', incl: '53', minEl: '10' })   // NGSO 近圆轨道三要素

// 行 → 引擎入参的公共 opts（几何从全局注入）
function caseOpts() {
  return {
    direction: direction.value, orbitMode: orbitMode.value,
    satLon: geoSatLon.value,
    orbitAltKm: ngsoOrbit.alt, inclDeg: ngsoOrbit.incl, minElevDeg: ngsoOrbit.minEl
  }
}

// —— 算例表（每行一个完整算例；_id 用 'c' 前缀避免与 StationGrid 内部 'r' 前缀冲突）——
let _cid = 1
function mkCase(over) { return { ...defaultRow(), ...(over || {}), _id: 'c' + (_cid++) } }
const cases = reactive([mkCase()])

// —— 计算结果 ——
// 按行 _id 存，不按数组下标：算例表可插行/删行/上下移动，下标一变，「results[i] 配 cases[i]」
// 的对应就整体串位（右侧详情张冠李戴、表内雨衰挂错行）。_id 随行走，增删改序都不会错配。
// 也不写回行对象（与链路预算结果列同口径）：不进撤销快照、不惊动存档/脏检/过期 watcher。
const resultById = shallowRef({})    // { 行_id: 主进程返回的纯对象结果（IPC 克隆安全）}
// 计算时留底的入参（按行 _id，与 resultById 同一轮写入）：右栏曲线与详情只认这一份。
// 曾按「当前行 + 当前全局几何」现组——算完再改可用度 / 频率 / 轨位，曲线按新入参重画，
// 标记点（取自结果）却还是旧的那一个，一张图上两套输入。现在改了输入只亮「输入已变」，重算才换。
const paramsById = shallowRef({})    // { 行_id: buildRainCase 出参（纯数据）}
const computing = ref(false)
const selectedId = ref(cases[0]._id)  // 右侧「单算例分析」当前所分析的算例 _id
const hasResults = computed(() => cases.some((c) => resultById.value[c._id]))

// 窗内提示（shared/useNotice：普通 4 s · 导出带「打开 · 在文件夹中显示」· 失败常驻）
const N = useNotice()
const { toast, toastFile } = N
// 主进程保存处理器回的实际写入路径（新字段 path / paths；兼容旧的 filePath）
const outPath = (r) => (r && (r.path || (Array.isArray(r.paths) && r.paths[0]) || r.filePath)) || ''
// 算例表「导入 / 导出 Excel」的回执（StationGrid emit xlsxDone）
function onGridXlsx(r) { if (!r) return; if (r.kind === 'export') { if (r.path) toastFile('已导出 Excel', r.path); else toast('已导出 Excel') } else toast(`已导入 ${r.rows || 0} 行`) }
const baseName = (p) => String(p || '').split(/[\\/]/).pop()

// —— 结果过期提示（与链路预算同口径）：出结果后任何计算输入再变化 → 亮「输入已变」提醒重算 ——
// 不做「打字防抖自动重算」：轨位打到一半就会被当成完整值跑一遍全表，表里数字乱跳、右上角提示乱弹，
// 而表格内的编辑又从来不自动重算 —— 一半自动一半手动才是这页最别扭的地方。统一成手动重算 + 亮灯。
const resultsStale = ref(false)
watch([geoSatLon, ngsoOrbit, rainModel, cases], () => { if (hasResults.value) resultsStale.value = true }, { deep: true })

// —— 城市选址 + 经纬度自动填（复用链路预算 link:* 通道）——
const cities = ref([])
async function citySearch(kw) { try { return (api && await api.searchCities(kw)) || [] } catch (e) { return [] } }
// skip：粘贴/填充整行时已显式带入的自动列（R0.01 / 海拔）——重算不得覆盖它们（与链路预算同口径）。
// 少了这层，整行粘贴一进来就把粘贴过来的降雨率/海拔按站址查表冲掉，看着像「粘完自己改了」。
async function autoGeo(row, skip) {
  if (!api) return
  const lat = parseFloat(halfStr(row.latitude)), lon = parseFloat(halfStr(row.longitude))
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
  try {
    const r = await api.geoFill(lat, lon)
    if (!r) return
    if (r.altitude != null && !(skip && skip.has('altitude'))) row.altitude = String(Math.round(r.altitude))
    if (rainModel.value === 'auto' && r.rainRate != null && !(skip && skip.has('rainRate'))) row.rainRate = String(Math.round(r.rainRate * 1000) / 1000)
  } catch (e) { /* ignore */ }
}

// —— 多站总可用度 ——
// 设置与「计算」按钮都在中间栏底部，与单算例共用一个按钮、一盏「输入已变」灯：
// 一次点击先算整表单算例，多站开关打开时再顺带算一遍系统聚合。
const divResult = shallowRef(null)
const divOpt = reactive({
  // inputMode: 'atten' 由可承受衰减反解可用度 | 'avail' 直接读表内「可用度」列
  inputMode: 'atten', target: 'rainAtten', nMin: '', tSwMin: '', nSwPerYear: ''
})
// 逐站反解结果按行 _id 存（与单算例结果同口径，不写回行对象、不串位）
const divByRow = shallowRef({})
// 底栏输入框收的是字符串，出 IPC 前统一归一（留空 = 不传，引擎按缺省处理，不编数）
const nOrUndef = (v) => { const n = parseFloat(halfStr(v)); return Number.isFinite(n) ? n : undefined }

async function computeDiversity(ids) {
  const payload = JSON.parse(JSON.stringify(cases.map((row) => buildRainCase(row, caseOpts()))))
  const plain = {
    inputMode: divOpt.inputMode,
    target: divOpt.target,
    nMin: nOrUndef(divOpt.nMin),
    tSwMin: nOrUndef(divOpt.tSwMin),
    nSwPerYear: nOrUndef(divOpt.nSwPerYear)
  }
  const r = await api.solveMultiSite(payload, plain)
  divResult.value = r || null
  // 逐站反解回填到表内两个结果列
  const m = {}
  if (r && Array.isArray(r.sites)) {
    r.sites.forEach((s, i) => {
      const id = ids[i]; if (!id) return
      const q = s.solve
      m[id] = q && q.state !== 'err'
        ? { availSolved: q.availability, outagePct: q.outagePct, downtimeH: q.downtimeYear, _state: q.state }
        : { availSolved: null, downtimeH: null, _state: 'err' }
    })
  }
  divByRow.value = m
  if (r && r.error) return '多站计算失败：' + r.message
  return ''
}
// 多站设置也算「计算输入」：改了要亮灯，否则灯说谎
watch(divOpt, () => { if (hasResults.value || divResult.value) resultsStale.value = true }, { deep: true })
// 关掉多站开关：结果与表内反解列一并清掉，免得留着一份对不上当前形态的旧数
watch(divOn, (on) => { if (!on) { divResult.value = null; divByRow.value = {} } })
// 多站开着却还没有多站结果（单算例算完才勾上的多站）：右栏多站页空着、导出会退回批量结果页——
// 与「输入已变」同一盏灯、同一个补算条件。按状态推出而不是勾的那一下置灯：再取消勾选，
// 单算例结果仍对应当前输入，灯随之熄
const divMissing = computed(() => divOn.value && !divResult.value)

// —— 表内结果列取值（StationGrid 计算列口径：{ 行_id: { 列key: 值 } }）——
// 小数位按 RESULT_DIGITS 逐列取：可用度列 2 位会把 99.99% 与 99.999% 显示成同一个数。
const extraValues = computed(() => {
  const out = {}
  for (const row of cases) {
    const r = resultById.value[row._id]
    const d = divByRow.value[row._id]
    if (!r && !d) continue
    const o = {}
    for (const k of RESULT_KEYS) {
      const src = (k === 'availSolved' || k === 'downtimeH') ? d : r
      if (!src) { o[k] = ''; continue }
      const digits = RESULT_DIGITS[k] == null ? 2 : RESULT_DIGITS[k]
      o[k] = src.error ? '✕' : ((src[k] == null || !Number.isFinite(+src[k])) ? '—' : (+src[k]).toFixed(digits))
    }
    out[row._id] = o
  }
  return out
})
// 结果列着色：该算例算不出来时标红（保留数值着色与报错诊断，不出文字判定）。
// 多站那两列走各自的反解状态：钳到定义域端点的标警示色（越界只标色 + title，不禁用）。
function cellClassFn(f, row) {
  if (!f.ro) return null
  if (f.key === 'availSolved' || f.key === 'downtimeH') {
    const d = divByRow.value[row._id]
    if (!d) return null
    if (d._state === 'err') return 'st-bad'
    if (d._state === 'below' || d._state === 'above' || d._state === 'flat') return 'st-warn'
    return null
  }
  const r = resultById.value[row._id]
  return (r && r.error) ? 'st-bad' : null
}

// —— 计算（批量，一次 IPC）——
// 返回是否按当前输入算完了整表（逐例算不出的 ✕ 也算算完）：导出前补算要据此决定导不导（见 exportExcel）
async function compute() {
  if (!api) { toast('计算需在桌面客户端中运行'); return false }
  if (!cases.length) { toast('暂无算例。'); return false }
  // 全局几何先行校验（缺了会让全表统一报错，不如一句话说清）
  const pf = (v) => parseFloat(halfStr(v))
  if (orbitMode.value === 'ngso') {
    if (!(pf(ngsoOrbit.alt) > 0) || !Number.isFinite(pf(ngsoOrbit.incl)) || !Number.isFinite(pf(ngsoOrbit.minEl))) {
      toast('轨道高度 / 倾角 / 最低仰角未填写。'); return false
    }
  } else if (!Number.isFinite(pf(geoSatLon.value))) {
    toast('GEO 轨位未填写。'); return false
  }
  computing.value = true
  try {
    const ids = cases.map((row) => row._id)          // 先固定本轮行序：await 期间用户可能又增删了行
    const payload = cases.map((row) => buildRainCase(row, caseOpts()))
    const out = await api.computeBatch(payload)
    const arr = Array.isArray(out) ? out : []
    const m = {}, pm = {}
    ids.forEach((id, i) => { if (arr[i]) { m[id] = arr[i]; pm[id] = payload[i] } })
    resultById.value = m
    paramsById.value = pm   // 入参与结果同一轮落定：右栏曲线 / 详情按它画（见 paramsById 头注）
    const errs = arr.filter((r) => r && r.error).length
    // 多站开关打开时，同一次点击顺带把系统聚合算了（一个按钮、一盏灯）
    let divMsg = ''
    if (divOn.value) {
      if (!api.solveMultiSite) divMsg = '多站计算需在桌面客户端中运行'
      else divMsg = await computeDiversity(ids)
    }
    resultsStale.value = false
    toast(divMsg || (errs ? `完成，${errs}/${ids.length} 个算例计算失败（见表内 ✕）`
      : `完成，共 ${ids.length} 个算例${divOn.value ? ' · 多站汇总已出' : ''}`))
    return true
  } catch (e) { reportError('计算失败', e); resultById.value = {}; paramsById.value = {}; return false }
  finally { computing.value = false }
}
// 方向切换：下行/上行影响 G/T 衰减列，已算过则自动重算（单击即定，不存在「打一半」的中间态）
watch(direction, () => { if (hasResults.value) compute() })
// 轨道类型切换：几何口径变了，已算过则重算
watch(orbitMode, () => { if (hasResults.value) compute() })
// 降雨模型切到「自动」：把各行 R0.01 按 ITU-R P.837 重新填上（此后只读）
watch(rainModel, (m) => { if (m === 'auto') cases.forEach((row) => autoGeo(row)) })

// —— 选中算例 → 详情 + 曲线 ——
// 选中项按 _id 跟随，行被删/被移动都不会跳到别的算例；行没了则退到首行。
watch(() => cases.map((c) => c._id).join(','), () => {
  if (!cases.length) { selectedId.value = null; return }
  if (!cases.some((c) => c._id === selectedId.value)) selectedId.value = cases[0]._id
})
const selectedCase = computed(() => cases.find((c) => c._id === selectedId.value) || null)
const selectedResult = computed(() => (selectedCase.value && resultById.value[selectedCase.value._id]) || null)
// 点表格任一行（鼠标或键盘导航）→ 右侧分析跟着切到该行，与链路预算表口径一致；表头下拉仍可用，两者同步
function onRowFocus(i, id) { if (id) selectedId.value = id }
// 曲线面板入参：取计算时留底的那一份（与表内结果、右栏详情同一套输入），再把算出的仰角回灌进去，
// 好让「仰角」轴能标出当前取值点（计算时被全局几何覆盖）
const selectedParams = computed(() => {
  const row = selectedCase.value
  const p = row ? paramsById.value[row._id] : null
  if (!p) return null
  const r = selectedResult.value
  const elevation = (r && !r.error && Number.isFinite(+r.elevation)) ? +r.elevation : undefined
  return { ...p, elevation }
})
const caseName = (c, i) => (c && c.stationName) || ('算例 ' + (i + 1))
const selName = computed(() => caseName(selectedCase.value, cases.findIndex((c) => c._id === selectedId.value)))

// SatMaster 版详情三段
const detail = computed(() => {
  const r = selectedResult.value, row = selectedCase.value
  if (!r || r.error || !row) return null
  const f = (v, d = 2, u = '') => (v == null || !Number.isFinite(+v)) ? '—' : ((+v).toFixed(d) + (u ? ' ' + u : ''))
  // 可用度：小数位跟着不可用度的量级走。固定 3 位会把 99.99999 显示成 100.000 —— 多少个 9
  // 正是这一栏唯一的信息量，不能被四舍五入吃掉
  const fa = (v) => {
    if (v == null || !Number.isFinite(+v)) return '—'
    const a = +v, u = 100 - a
    if (!(u > 0)) return '100 %'
    const s = a.toFixed(Math.min(9, Math.max(3, Math.ceil(-Math.log10(u)) + 1)))
    return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') + ' %'
  }
  // 停时：h / min / s 自适应（同 RainDiversity 的 yearly）。5 个 9 以上按小时读全是 0.00
  const fh = (v) => {
    if (v == null || !Number.isFinite(+v)) return '—'
    const h = +v
    if (h >= 1) return h.toFixed(2) + ' h'
    const m = h * 60
    return m >= 1 ? (m.toFixed(2) + ' min') : ((m * 60).toFixed(2) + ' s')
  }
  const down = r.direction === 'down'
  const s = r.s8 || null                     // NGSO 统计口径（ITU-R P.618-14 §8）诊断块
  // 「输入参数」段回显的是**实际入算的值**：留空列取该列默认（与表内灰字占位同口径），
  // 故站名/海拔取 buildRainCase 归一后的入参，而不是行里的原始空串。
  const p = selectedParams.value || {}
  return {
    error: r.error ? (r.message || '计算失败') : '',
    input: [
      ['地球站', p.stationName || '—'],
      ['纬度', f(r.lat, 4, '°')],
      ['经度', f(r.lon, 4, '°')],
      ['海拔', f(p.altitude, 0, 'm')],
      s
        ? ['轨道（近圆）', f(s.orbitAltKm, 0, 'km') + ' / 倾角 ' + f(s.inclDeg, 1, '°')]
        : ['GEO 轨位', r.satLon != null ? (fmtGeoSlot(Number(r.satLon)) || f(r.satLon, 2, '°E')) : '—（直接指定仰角）'],
      ['频率', f(r.freq, 3, 'GHz')],
      ['极化', POL_LABEL[r.polDisplay] || POL_LABEL[r.pol] || r.pol],
      ['R0.01% 降雨率', f(r.rainRate, 3, 'mm/h') + (r.rainRateAuto ? '（ITU-R P.837 自动）' : '（手动）')],
      ['年可用度', fa(r.availability)],
      ['系统噪温（晴空）', down ? f(r.systemNoiseTemp, 0, 'K') : '—（上行不适用）'],
      ['馈线损耗', down ? f(r.feederLoss, 2, 'dB') : '—（上行不适用）'],
      ['链路方向', down ? '下行' : '上行']
    ],
    look: s ? [
      ['最低工作仰角', f(s.minElevDeg, 2, '°')],
      ['可达最高仰角', f(s.maxElevDeg, 2, '°')],
      ['卫星可见时间占比', f(s.visFrac * 100, 3, '%')],
      ['仰角增量宽度', f(s.binDeg, 1, '°') + '（' + s.binCount + ' 个增量）'],
      ['§8 等效仰角', f(r.elevation, 2, '°')],
      ['雨衰 @ 最低仰角', f(s.attenAtMinElev, 2, 'dB')],
      ['§8 加权后修正', s.degenerate ? '—' : ('−' + f(s.overestimateAtMinElev, 2, 'dB'))],
      ['降雨高度 hR', f(r.rainHeight, 3, 'km')]
    ] : [
      ['仰角', f(r.elevation, 2, '°')],
      ['方位角', r.azimuth != null ? f(r.azimuth, 2, '°') : '—'],
      ['星地斜距', r.slantRange != null ? f(r.slantRange, 2, 'km') : '—'],
      ['降雨高度 hR', f(r.rainHeight, 3, 'km')]
    ],
    prop: [
      ['气体吸收 (P.676)', f(r.gasAtten, 2, 'dB'), false],
      ['对流层闪烁', f(r.scintillation, 2, 'dB'), false],
      ['云衰减 (P.840-9)', f(r.cloudAtten, 2, 'dB'), false],
      ['雨衰 (P.618-14)', f(r.rainAtten, 2, 'dB'), true],
      ['合计衰减（气体+云+雨）', f(r.totalAtten, 2, 'dB'), true],
      ['降雨噪声致 G/T 衰减', down ? f(r.gtDegradation, 2, 'dB') : '—（下行专属）', true],
      ['下行链路劣化 DND', down ? f(r.dnd, 2, 'dB') : '—（下行专属）', true],
      ['雨致去极化 XPD', f(r.rainXPD, 2, 'dB'), false],
      ['年不可用时长', fh(r.downtimeYear), false],
      ['最坏月可用度', fa(r.worstMonthAvail), false],
      ['最坏月不可用时长', fh(r.downtimeWorstMonth), false]
    ],
    propNote: down
      ? `DND = (雨衰+云衰 ${f(r.precipAtten, 2)} dB) + G/T衰减 ${f(r.gtDegradation, 2)} dB。降雨噪声 = T_sky(气体+云+雨) − T_sky(气体)（P.618-14 式(69)(70)），经馈线 ${f(r.feederLoss, 2)} dB 折算；闪烁不计入（折射，不辐射噪声）。`
      : '上行不计降雨噪声：G/T 衰减与 DND 为下行专属。'
  }
})

// —— Excel 导出 ——
async function exportExcel() {
  if (!api) { toast('导出需在桌面客户端中运行'); return }
  if (computing.value) return
  // 导出讲【当前输入】（口径同链路预算四窗的导出前补算）：输入已变或还没算过，先按当前输入算一遍；
  // 算不成就不导 —— 文件里不许是新参数配旧雨衰值。原因 compute 已就地提示。
  // 多站开着却还没有多站结果（divMissing）同样先补算——不补，导出的就是批量结果页而非多站页
  if (resultsStale.value || !hasResults.value || divMissing.value) {
    if (!(await compute()) || !hasResults.value) return
  }
  try {
    const pf = (v) => { const x = parseFloat(halfStr(v)); return Number.isFinite(x) ? x : null }
    const divOut = (divOn.value && divResult.value && !divResult.value.error) ? JSON.parse(JSON.stringify(divResult.value)) : null
    const payload = {
      lang: curLang(),     // 导出文件的表头 / 表题 / 表注跟界面语言（report.buildRainAttenuationExcel）
      defaultName: divOut ? byLang('多站总可用度.xlsx', 'Multi-site Availability.xlsx') : byLang('雨衰计算结果.xlsx', 'Rain Attenuation Results.xlsx'),
      orbitMode: orbitMode.value,
      direction: direction.value,
      rainModel: rainModel.value,
      // 全局几何（进副标题；几何列已不逐行进表）
      geom: orbitMode.value === 'ngso'
        ? { orbitAltKm: pf(ngsoOrbit.alt), inclDeg: pf(ngsoOrbit.incl), minElevDeg: pf(ngsoOrbit.minEl) }
        : { satLon: pf(geoSatLon.value) },
      rows: cases.map((c) => { const { _id, ...r } = effectiveRow(c); return r }),
      // 报表按下标把 rows[i] 与 results[i] 配对 → 这里按当前行序摊平（未算出的行留 null 占位，不串位）
      results: JSON.parse(JSON.stringify(cases.map((c) => resultById.value[c._id] || null))),
      // 多站汇总打开且已算出 → 汇总页同步进导出（「多站汇总」sheet 替代批量结果页，三线表模板版式）
      div: divOut
    }
    const r = await api.exportExcel(payload)
    if (r && r.ok) { const fp = outPath(r); toastFile('已导出：' + baseName(fp), fp) }
    else if (r && !r.canceled) reportError('导出失败', r.error || '未知错误')
  } catch (e) { reportError('导出失败', e) }
}

// ========================= 配置持久化（与链路预算四窗同口径：配置树 + 自动保存 + 历史版本）=========================
// 2026-10-15 起取消「保存 / 另存」按钮与「是否保存」三选一：工作区恒对应配置列表里的一份配置，改动约 1 s 后写回
// （shared/useConfigAutosave.js），后悔药是历史版本（shared/useConfigVersions.js + LbVersionsDialog）。
// 树的增删改移 / 剪贴板 / 右键 / 键盘全在 shared/useConfigTree.js；这里只留本窗的场景序列化。
const STATE_KEY = 'rain/last'      // 只记「上次打开的是哪一份」；v1.5.1 及以前这里存的是整份场景（见 onMounted 的迁移）

const DROP_KEYS = new Set([...RESULT_KEYS, ...LEGACY_KEYS])
function serializeState() {
  // 剥离 _id、结果字段（不入存档，载入后待重算）与历史遗留列（几何已上提为全局、派生量已收进详情）
  const strip = (r) => { const o = {}; for (const k in r) if (k !== '_id' && !DROP_KEYS.has(k)) o[k] = r[k]; return o }
  return {
    orbitType: 'RAIN',
    orbitMode: orbitMode.value, direction: direction.value, rainModel: rainModel.value,
    satLon: geoSatLon.value,
    orbit: { alt: ngsoOrbit.alt, incl: ngsoOrbit.incl, minEl: ngsoOrbit.minEl },
    // 多站汇总的开关与设置随档走（结果不入档，载入后待重算）
    div: { on: divOn.value, inputMode: divOpt.inputMode, target: divOpt.target, nMin: divOpt.nMin, tSwMin: divOpt.tSwMin, nSwPerYear: divOpt.nSwPerYear },
    cases: cases.map(strip),
    // 存档里仍按下标记（_id 是会话内的临时键，不入档）
    selectedIdx: Math.max(0, cases.findIndex((c) => c._id === selectedId.value))
  }
}
// 旧存档迁移：几何列曾逐行进表（satLon / orbitAltitude / orbitInclination / minElevation），
// 现为全局参数 → 取首行值上提；行内所有已移除的键统一清除（见 rainParams.LEGACY_KEYS）。
// 算例表组件（StationGrid）：载入配置时要清它的撤销 / 重做栈
const caseGridRef = ref(null)
function applyState(st) {
  if (!st || typeof st !== 'object') return
  // 换了一份内容：表格撤销栈里存的是上一份的行，不清的话一按撤销就把它整张灌进当前配置（表格不随配置重建）
  if (caseGridRef.value) caseGridRef.value.clearHistory()
  if (st.orbitMode) orbitMode.value = st.orbitMode
  if (st.direction) direction.value = st.direction
  if (st.rainModel) rainModel.value = st.rainModel
  const first = (Array.isArray(st.cases) && st.cases[0]) || {}
  if (st.satLon != null && st.satLon !== '') geoSatLon.value = String(st.satLon)
  else if (first.satLon != null && first.satLon !== '') geoSatLon.value = String(first.satLon)
  if (st.orbit && typeof st.orbit === 'object') {
    if (st.orbit.alt != null) ngsoOrbit.alt = String(st.orbit.alt)
    if (st.orbit.incl != null) ngsoOrbit.incl = String(st.orbit.incl)
    if (st.orbit.minEl != null) ngsoOrbit.minEl = String(st.orbit.minEl)
  } else {
    if (first.orbitAltitude != null && first.orbitAltitude !== '') ngsoOrbit.alt = String(first.orbitAltitude)
    if (first.orbitInclination != null && first.orbitInclination !== '') ngsoOrbit.incl = String(first.orbitInclination)
    if (first.minElevation != null && first.minElevation !== '') ngsoOrbit.minEl = String(first.minElevation)
  }
  if (Array.isArray(st.cases) && st.cases.length) {
    cases.splice(0, cases.length, ...st.cases.map((r) => {
      const row = { ...defaultRow(), ...r, _id: 'c' + (_cid++) }
      if (String(row.polarization || '').toUpperCase() === 'C') row.polarization = 'RHCP'   // 旧存档圆极化 C → RHCP
      for (const k of DROP_KEYS) delete row[k]   // 历史遗留列 + 旧版曾写进行里的结果值（现为计算列）
      return row
    }))
  }
  // 多站汇总的开关与设置（旧存档无 div 字段 → 回到默认关闭，不沿用上一份配置的选择）
  const dv = (st.div && typeof st.div === 'object') ? st.div : {}
  divOn.value = !!dv.on
  divOpt.inputMode = dv.inputMode === 'avail' ? 'avail' : 'atten'
  divOpt.target = (dv.target === 'totalAtten' || dv.target === 'dnd') ? dv.target : 'rainAtten'
  divOpt.nMin = dv.nMin != null ? String(dv.nMin) : ''
  divOpt.tSwMin = dv.tSwMin != null ? String(dv.tSwMin) : ''
  divOpt.nSwPerYear = dv.nSwPerYear != null ? String(dv.nSwPerYear) : ''
  const si = (st.selectedIdx != null) ? Math.min(st.selectedIdx, Math.max(0, cases.length - 1)) : 0
  selectedId.value = cases[si] ? cases[si]._id : (cases[0] ? cases[0]._id : null)
  resultById.value = {}       // 载入配置后清空旧结果，待重新计算
  paramsById.value = {}       // 留底入参随结果一起清
  divResult.value = null      // 多站结果同样不跨配置存活
  divByRow.value = {}
  resultsStale.value = false
}
function blankState() { return { orbitType: 'RAIN', orbitMode: 'geo', direction: 'down', rainModel: 'auto', satLon: '130.5', orbit: { alt: '550', incl: '53', minEl: '10' }, div: { on: false, inputMode: 'atten', target: 'rainAtten', nMin: '', tSwMin: '', nSwPerYear: '' }, cases: [defaultRow()], selectedIdx: 0 } }

// 指纹（只取内容，不含 selectedIdx 视图态）→ 自动保存据此判断要不要写盘（全局几何与多站设置属内容，计入）
function fingerprintOf(s) { return stableStringify({ orbitMode: s.orbitMode, direction: s.direction, rainModel: s.rainModel, satLon: s.satLon, orbit: s.orbit, div: s.div, cases: s.cases }) }
// 出厂空白的内容指纹（与 serializeState 同一口径：行按 applyState 补齐默认列、去掉结果 / 遗留列）
function blankFingerprint() {
  const b = blankState()
  return fingerprintOf({ ...b, cases: b.cases.map((r) => { const o = { ...defaultRow(), ...r }; for (const k of DROP_KEYS) delete o[k]; return o }) })
}
// 自动名（名字随内容的配置用）：「<首站> 雨衰 N 例」，按平台语言出字
function defaultCfgName() { return (cases[0] && cases[0].stationName ? cases[0].stationName + ' ' : '') + byLang(`雨衰 ${cases.length} 例`, `${cases.length} Rain Cases`) }
function cfgLabelOf(st) {
  const cs = (st && Array.isArray(st.cases)) ? st.cases : []
  return (cs[0] && cs[0].stationName ? cs[0].stationName + ' ' : '') + byLang(`雨衰 ${cs.length} 例`, `${cs.length} Rain Cases`)
}

const cfgTree = useConfigTree({
  ns: 'rain', orbitType: 'RAIN', api: winApi, storageKey: 'rain/expandedFolders',
  toast, blankState, serializeState, applyState, setBaseline, guardedLeave, askConfirm, defaultCfgName,
  autosave: true, onNameAuto: (id) => { if (id === activeId.value) autosave.flush() }
})
const {
  configs, activeId, focusId, expandedFolders, editing, cfgClip, ctxMenu,
  loadConfigs, uniqueCfgName, activeName, ensureActive, duplicateItem,
  toggleFolder, expandAll, collapseAll,
  addFolder, addBlankConfig, onDeleteItem, onMove, moveToRoot,
  startRename, commitRename, cancelRename, selectConfig,
  copyItem, cutItem, pasteConfig, ctxItem, ctxIsFolder, openCtx, closeCtx, onCfgKey
} = cfgTree
const autosave = useConfigAutosave({
  ns: 'rain', api: winApi, activeId, itemById: cfgTree.itemById, serialize: serializeState, fingerprint: fingerprintOf,
  autoName: defaultCfgName, uniqueName: uniqueCfgName, summarize: (st) => ({ label: cfgLabelOf(st) }), toast
})
const { error: saveError } = autosave
let stopAutosaveListen = null
onBeforeUnmount(() => { if (stopAutosaveListen) stopAutosaveListen(); autosave.dispose() })
const { verDlg, openVersions, restoreVersion, duplicateVersion } = useConfigVersions({
  ns: 'rain', api: winApi, tree: cfgTree, autosave, applyState,
  summarize: (st) => ({ label: cfgLabelOf(st) }), fingerprint: fingerprintOf, toast
})
// 场景一变就交给自动保存（防抖写回当前配置）；「上次打开的是哪一份」随 activeId 记一笔
watch([orbitMode, direction, rainModel, geoSatLon, ngsoOrbit, cases, divOn, divOpt], () => autosave.touch(), { deep: true })
watch(activeId, (id) => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ activeId: id || null })) } catch (e) { /* 配额满等忽略 */ } })
// 一份配置刚载入工作区：以当前内容为已落盘基线（useConfigTree 在载入 / 新建后调）
function setBaseline() { autosave.attach() }
// 离开当前配置（切换 / 新建 / 副本）前：把没落盘的改动写进去；写不进去才问一句
async function guardedLeave() {
  if (await autosave.flush()) return true
  return await askConfirm(`「${activeName()}」的改动未能写入磁盘（${saveError.value}）。仍要离开？`)
}

// —— 左侧栏：配置列表（可拖宽 / 可收起；功能区「配置列表」与栏头 × 互为一对）——
const SIDE_KEY = 'rain/sideView'
const sideView = ref((() => { try { const v = localStorage.getItem(SIDE_KEY); return (v === 'configs' || v === '') ? v : 'configs' } catch (e) { return 'configs' } })())
watch(sideView, (v) => { try { localStorage.setItem(SIDE_KEY, v) } catch (e) { /* ignore */ } })
function toggleSide(v) { sideView.value = sideView.value === v ? '' : v }
const CFG_W_MIN = 180, CFG_W_MAX = 520
const configsWidth = ref((() => { try { const n = Number(localStorage.getItem('rain/configsWidth')); return Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, Number.isFinite(n) && n > 0 ? n : 220)) } catch (e) { return 220 } })())
const sideResizing = ref(false)
function startResize(e) {
  const startX = e.clientX, startW = configsWidth.value
  sideResizing.value = true; document.documentElement.classList.add('ui-col-resize')
  const move = (ev) => { configsWidth.value = Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, startW + ev.clientX - startX)) }
  const up = () => {
    sideResizing.value = false; document.documentElement.classList.remove('ui-col-resize')
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    try { localStorage.setItem('rain/configsWidth', String(configsWidth.value)) } catch (e2) { /* ignore */ }
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}
// Ctrl+Enter = 计算（全部计算窗同一个键）
function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing && !computing.value) { e.preventDefault(); compute() }
}
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))

// —— 主窗口带上下文打开（地图右键 / 卫星信息栏「分析 ▸ 雨衰计算」）——
// 几何是全局参数（一份配置一颗星 / 一个星座）：带来的星与当前几何不同 → 新建一份配置承接（当前配置的改动先落盘），
// 原配置不动；相同或没带星 → 只追加算例。GSO 星填定点轨位，非 GSO 星填近圆轨道高度 / 倾角
// （主窗口那一拍的值）。站址追加成算例并联动 autoGeo 补降雨 / 海拔；新建配置里那条出厂默认算例由站址顶替。
const _ctxQueue = []
let _ctxReady = false, _ctxChain = Promise.resolve()
function onToolContext(c) { if (!_ctxReady) { _ctxQueue.push(c); return } _ctxChain = _ctxChain.then(() => applyToolContext(c)).catch((e) => { reportError('载入地图带入的对象', e) }) }
function flushToolContext() { _ctxReady = true; for (const c of _ctxQueue.splice(0)) onToolContext(c) }
const r2 = (v) => String(Math.round(v * 100) / 100)
function isCurGeom(s) {
  if (s.geo) return orbitMode.value === 'geo' && s.slotLon != null && Math.abs(parseFloat(geoSatLon.value) - s.slotLon) < 0.05
  return orbitMode.value === 'ngso' && s.altKm != null && s.inclDeg != null &&
    Math.abs(parseFloat(ngsoOrbit.alt) - s.altKm) < 1 && Math.abs(parseFloat(ngsoOrbit.incl) - s.inclDeg) < 0.1
}
async function applyToolContext(c) {
  if (!c) return
  const s0 = c.sat, sites = c.sites || []
  // 带来的星取不到几何（导入星历表太短 / 坏表等，发送端给 geo=false 且高度 / 倾角为空）：不换几何、不新建配置，
  // 站照常追加到当前配置，只如实报一句——不能拿出厂 550 km / 53° 顶替还说「已载入」
  const geomOk = !!s0 && (s0.geo ? s0.slotLon != null : (s0.altKm != null && s0.inclDeg != null))
  const s = geomOk ? s0 : null, noGeo = !!s0 && !geomOk
  let fresh = false
  if (s && !isCurGeom(s)) {
    // 带来的星与当前几何不同：另建一份配置承接（当前配置的改动先落盘），原配置不动；
    // 新配置的名字随内容（自动命名），带来的几何 / 站直接写进它
    const st = blankState()
    if (s.geo) { st.orbitMode = 'geo'; if (s.slotLon != null) st.satLon = r2(s.slotLon) }
    else {
      st.orbitMode = 'ngso'
      if (s.altKm != null) st.orbit.alt = String(Math.round(s.altKm))
      if (s.inclDeg != null) st.orbit.incl = r2(s.inclDeg)
    }
    const n = await cfgTree.createAndOpen({ state: st, nameAuto: true })
    if (!n) return
    fresh = true
  }
  if (sites.length) {
    const rows = sites.map((x) => mkCase({ stationName: x.name || '', longitude: String(x.lon), latitude: String(x.lat) }))
    const at = fresh ? 0 : cases.length
    cases.splice(at, fresh ? cases.length : 0, ...rows)
    const fills = []
    for (let i = at; i < at + rows.length; i++) fills.push(autoGeo(cases[i]))   // 取回响应式代理：异步回填才触发重绘
    // 等海拔 / 降雨率回填落定再往下走（autoGeo 自带 try/catch、从不 reject，取不到就原样留着）；回填值随后由自动保存落盘
    await Promise.all(fills)
  }
  const who = s0 ? (s0.name || '') : ''
  const noGeoTip = noGeo ? byLang(`未取到卫星几何：${who}`, `No satellite geometry: ${who}`) : ''
  toast((sites.length
    ? (noGeoTip ? noGeoTip + byLang('；', '; ') : '') + byLang(`已添加 ${sites.length} 个算例${who && !noGeo ? '（' + who + '）' : ''}`, `Added ${sites.length} case${sites.length === 1 ? '' : 's'}${who && !noGeo ? ' (' + who + ')' : ''}`)
    : (noGeoTip || byLang(`已载入卫星几何：${who}`, `Satellite geometry loaded: ${who}`))))
}
const _stopCtx = (typeof window !== 'undefined' && window.api && window.api.tools) ? window.api.tools.onContext(onToolContext) : null
onBeforeUnmount(() => { if (_stopCtx) _stopCtx() })

onMounted(async () => {
  try { cities.value = (api && await api.cities()) || [] } catch (e) { cities.value = [] }
  await loadConfigs()
  // 打开上次那份配置；它没了就开树上第一份，一份都没有就新建一份空白配置（工作区恒对应一份配置）。
  // 迁移：v1.5.1 及以前「上次会话」存的是整份场景（含没点保存的改动）——
  //   · 对应的配置还在：把那份改动接上，随即由自动保存写盘（写盘前先给它留一档「打开时」）；
  //   · 不属于任何配置、又不是出厂空白（旧版允许不存配置直接用）：存成一份新配置，免得升级后丢了。
  let last = null
  try { last = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') } catch (e) { last = null }
  const hasScene = !!(last && Array.isArray(last.cases))
  if (hasScene && !last.activeId && fingerprintOf(last) !== blankFingerprint()) await cfgTree.createAndOpen({ state: last, nameAuto: true })
  await ensureActive(last && last.activeId)
  if (hasScene && last.activeId && last.activeId === activeId.value) { applyState(last); autosave.touch() }
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ activeId: activeId.value || null })) } catch (e) { /* 配额满等忽略 */ }
  // 关窗：把挂起的写盘冲掉即放行；只有写不进磁盘时才问一句
  api?.onCloseRequested?.(async () => {
    const ok = await autosave.flush()
    if (!ok && !(await askConfirm(`「${activeName()}」的改动未能写入磁盘（${saveError.value}）。仍要关闭窗口？`))) return
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
    <!-- 配置右键菜单（各工作台共用一份，条目与快捷键一致） -->
    <ConfigTreeMenu
      :menu="ctxMenu" :item="ctxItem" :is-folder="ctxIsFolder" :clip="cfgClip" :has-api="!!winApi" autosave
      @close="closeCtx" @rename="startRename" @new-folder="addFolder" @new-config="addBlankConfig"
      @cut="cutItem" @copy="copyItem" @paste="pasteConfig" @move-root="moveToRoot"
      @delete="onDeleteItem" @expand-all="expandAll" @collapse-all="collapseAll" @hide="sideView = ''"
      @duplicate="duplicateItem" @versions="(it) => openVersions(it.id)"
    />

    <div class="lb-body">
      <!-- ① 配置列表（可拖宽 / 可收起） -->
      <aside v-show="sideView === 'configs'" class="lb-col lb-side lb-configs" :class="{ resizing: sideResizing }" :style="{ width: configsWidth + 'px' }">
        <div class="lb-col-hd">
          <span class="lb-cfg-hd-t">配置列表</span>
          <span class="lb-cfg-acts">
            <button class="lb-mini lb-mini-ico" title="新建文件夹" :disabled="!winApi" @click="addFolder(null)"><Icon name="folder-plus" :size="12" /></button>
            <button class="lb-mini lb-mini-ico" title="添加空白配置" :disabled="!winApi" @click="addBlankConfig(null)"><Icon name="plus" :size="12" /></button>
            <button class="lb-mini lb-mini-ico" title="隐藏配置列表" @click="sideView = ''"><Icon name="x" :size="12" /></button>
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
        <div class="lb-cfg-resizer" title="拖动调整栏宽" @mousedown.prevent="startResize($event)"></div>
      </aside>

      <!-- ② 功能区 + 参数条 + Excel 批量算例 -->
      <section class="lb-col lb-build">
        <div class="lbr">
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big primary" :disabled="computing || !cases.length" :title="`计算全部 ${cases.length} 个算例${divOn ? '并汇总多站可用度' : ''}（Ctrl+Enter）`" @click="compute">
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
              <button class="lbr-big" :class="{ on: sideView === 'configs' }" :aria-pressed="(sideView === 'configs') ? 'true' : 'false'" title="左侧栏显示「配置列表」" @click="toggleSide('configs')"><Icon name="panel-left" :size="16" />配置列表</button>
            </div>
            <div class="lbr-cap">文件</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="computing || !cases.length" title="导出批量结果 Excel（输入已变或未算过时先按当前输入补算）" @click="exportExcel"><Icon name="file-export" :size="16" />Excel</button>
            </div>
            <div class="lbr-cap">导出</div>
          </div>
        </div>

        <div class="rain-toolbar">
          <div class="rain-seg-grp">
            <span class="rain-seg-lb">轨道类型</span>
            <div class="seg" role="radiogroup" aria-label="轨道类型">
              <button type="button" class="sg" role="radio" :aria-checked="orbitMode === 'geo'" :class="{ on: orbitMode === 'geo' }" title="静止轨道：填定点轨位，各站仰角自动换算" @click="orbitMode = 'geo'">GEO</button>
              <button type="button" class="sg" role="radio" :aria-checked="orbitMode === 'ngso'" :class="{ on: orbitMode === 'ngso' }" title="非静止轨道（近圆 LEO/MEO）：填轨道高度/倾角/最低仰角，按 ITU-R P.618-14 §8 仰角加权反解各站等效仰角" @click="orbitMode = 'ngso'">NGSO</button>
            </div>
          </div>
          <!-- 全局几何：一颗星 / 一个星座对全表地球站，不逐行填 -->
          <div v-if="orbitMode === 'geo'" class="rain-seg-grp">
            <span class="rain-seg-lb">GEO 轨位</span>
            <label class="rain-geom" title="GEO 定点轨位（全局，各站共用；各站仰角由此换算）">
              <input v-model="geoSatLon" spellcheck="false" /><i>°E</i>
            </label>
          </div>
          <div v-else class="rain-seg-grp">
            <span class="rain-seg-lb">近圆轨道</span>
            <label class="rain-geom" title="轨道高度（km，近圆轨道）"><span>高度</span><input v-model="ngsoOrbit.alt" spellcheck="false" /><i>km</i></label>
            <label class="rain-geom" title="轨道倾角（°）"><span>倾角</span><input v-model="ngsoOrbit.incl" spellcheck="false" /><i>°</i></label>
            <label class="rain-geom" title="最低工作仰角（°）——§8 仰角分布的下界"><span>最低仰角</span><input v-model="ngsoOrbit.minEl" spellcheck="false" /><i>°</i></label>
          </div>
          <div class="rain-seg-grp">
            <span class="rain-seg-lb">链路方向</span>
            <div class="seg" role="radiogroup" aria-label="链路方向">
              <button type="button" class="sg" role="radio" :aria-checked="direction === 'down'" :class="{ on: direction === 'down' }" @click="direction = 'down'">下行</button>
              <button type="button" class="sg" role="radio" :aria-checked="direction === 'up'" :class="{ on: direction === 'up' }" @click="direction = 'up'">上行</button>
            </div>
          </div>
          <div class="rain-seg-grp">
            <span class="rain-seg-lb">降雨模型</span>
            <div class="seg" role="radiogroup" aria-label="降雨模型">
              <button type="button" class="sg" role="radio" :aria-checked="rainModel === 'auto'" :class="{ on: rainModel === 'auto' }" title="经纬度→ITU-R P.837 自动取 R0.01" @click="rainModel = 'auto'">ITU-R 自动</button>
              <button type="button" class="sg" role="radio" :aria-checked="rainModel === 'manual'" :class="{ on: rainModel === 'manual' }" title="R0.01 手工填写" @click="rainModel = 'manual'">手动 (mm/h)</button>
            </div>
          </div>
        </div>

        <div class="rain-grid">
          <!-- 表格口径与链路表统一：两层表头分区（groups）+ 不冻结任何数据列（freeze-keys=false，
               全列随横滚；原先「地球站」列粘性固定，横滚时与其它列错位、和链路表也不一样） -->
          <StationGrid
            ref="caseGridRef" grid-id="rain.cases" :stations="cases" :fields="fields" :groups="GRID_GROUPS" :freeze-keys="false"
            @xlsx-done="onGridXlsx"
            :cities="cities" :city-search="citySearch" :auto-geo="autoGeo"
            :readonly-keys="readonlyKeys" :extra-values="extraValues" :cell-class="cellClassFn" label="算例"
            @row-focus="onRowFocus"
          />
        </div>

        <!-- 多站汇总设置条：开关打开时这一条出设置，关掉只剩开关（「计算」在功能区） -->
        <div class="rain-foot">
          <label class="rain-sw" title="把整张算例表当站表：逐站取可用度（表内直接给，或由「可承受衰减」反解），聚合成系统总可用度；右栏换成汇总结果">
            <input v-model="divOn" type="checkbox" /><span>多站汇总</span>
          </label>

          <template v-if="divOn">
            <div class="rain-seg-grp">
              <span class="rain-seg-lb">输入</span>
              <div class="seg" role="radiogroup" aria-label="输入">
                <button type="button" class="sg" role="radio" :aria-checked="divOpt.inputMode === 'atten'" :class="{ on: divOpt.inputMode === 'atten' }" title="表内填「可承受衰减」，由 ITU-R P.618-14 标度式反解各站可用度" @click="divOpt.inputMode = 'atten'">可承受衰减</button>
                <button type="button" class="sg" role="radio" :aria-checked="divOpt.inputMode === 'avail'" :class="{ on: divOpt.inputMode === 'avail' }" title="直接读表内「可用度」列，不走反解 —— 纯概率论入口，零传播模型假设。结果中同时给出该可用度对应的雨衰 / 合计 / 下行总劣化" @click="divOpt.inputMode = 'avail'">站可用度</button>
              </div>
            </div>
            <label class="rain-geom" title="系统可用 = 至少这么多站不处于中断。留空按全部站数（一站倒系统即倒）">
              <span>最少可用</span><input v-model="divOpt.nMin" spellcheck="false" placeholder="全部" /><i>站</i>
            </label>
            <div v-if="divOpt.inputMode === 'atten'" class="rain-seg-grp">
              <span class="rain-seg-lb">可承受衰减</span>
              <!-- 表内那一列填的数，到底对标哪一项 —— 三档差值可达 4 dB，不说清同一个 12 dB 会算出不同的可用度 -->
              <select v-model="divOpt.target" class="rain-sel" title="表内「可承受衰减」列填的数对标哪一项衰减。北京站 12.5 GHz、99.9% 实测三档分别为 3.57 / 4.00 / 7.51 dB">
                <option value="rainAtten">单独雨衰</option>
                <option value="totalAtten">气体吸收 + 云衰 + 雨衰</option>
                <option value="dnd">雨衰 + 云衰 + 噪声抬升（下行总劣化）</option>
              </select>
            </div>
            <div class="rain-seg-grp">
              <span class="rain-seg-lb">切换</span>
              <label class="rain-geom" title="单次切换的业务中断时长"><span>时间</span><input v-model="divOpt.tSwMin" spellcheck="false" placeholder="时长" /><i>min</i></label>
              <label class="rain-geom" title="一年切换多少次。切换进不了联合概率模型（静态模型没有时间轴），仅作为独立可加项 U_sw = 次数 × 时间 / 525960，与站点中断项相加进年度总账"><span>次数</span><input v-model="divOpt.nSwPerYear" spellcheck="false" placeholder="次/年" /><i>次/年</i></label>
            </div>
          </template>
        </div>
      </section>

      <!-- ③ 结果栏：多站开关决定看哪一份 -->
      <section class="lb-col lb-result">
        <div class="lb-col-hd">
          <span class="lb-cfg-hd-t">{{ divOn ? '多站汇总' : '单算例分析' }}</span>
          <template v-if="!divOn">
            <select v-model="selectedId" class="rain-sel" title="选择要细致分析的算例（点表格中的行亦可）">
              <option v-for="(c, i) in cases" :key="c._id" :value="c._id">{{ (i + 1) + ' · ' + caseName(c, i) }}</option>
            </select>
          </template>
        </div>
        <RainDiversity v-if="divOn" :result="divResult" />
        <div v-else class="lb-result-bd">
          <template v-if="!hasResults">
            <div class="rain-ph">尚无计算结果。</div>
          </template>
          <template v-else-if="selectedResult && selectedResult.error">
            <div class="rain-err"><Icon name="alert-triangle" :size="12" /> {{ selectedResult.message || '该算例无法计算' }}</div>
          </template>
          <template v-else-if="!selectedResult">
            <div class="rain-ph">该算例（{{ selName }}）尚未计入上次计算。</div>
          </template>
          <template v-else-if="detail">
            <!-- 交互式坐标系（在详情上方）-->
            <RainPlot :params="selectedParams" :result="selectedResult" :station="selName" @exported="(fp) => (fp ? toastFile('已导出：' + baseName(fp), fp) : toast('已导出'))" />

            <!-- SatMaster 版详细结果 -->
            <div class="rain-detail">
              <div class="rd-sec">
                <div class="rd-hd">输入参数</div>
                <div class="rd-row" v-for="row in detail.input" :key="row[0]"><span class="rd-k">{{ row[0] }}</span><span class="rd-v">{{ row[1] }}</span></div>
              </div>
              <div class="rd-sec">
                <div class="rd-hd">卫星视角</div>
                <div class="rd-row" v-for="row in detail.look" :key="row[0]"><span class="rd-k">{{ row[0] }}</span><span class="rd-v">{{ row[1] }}</span></div>
              </div>
              <div class="rd-sec">
                <div class="rd-hd" :title="detail.propNote || null">传播结果</div>
                <div class="rd-row" :class="{ em: row[2] }" v-for="row in detail.prop" :key="row[0]"><span class="rd-k">{{ row[0] }}</span><span class="rd-v">{{ row[1] }}</span></div>
              </div>
            </div>
          </template>
        </div>
      </section>
    </div>

    <WinStatusBar :n="N" :busy="computing ? '计算中…' : ''" :stale="!!((resultsStale || divMissing) && (hasResults || divResult))" stale-title="计算输入已被修改，表内结果列与右栏数值对应修改前的参数">
      <span v-if="!api" class="lb-hint"><Icon name="alert-triangle" :size="12" /> 需在桌面客户端中运行</span>
    </WinStatusBar>

    <LbVersionsDialog v-model:open="verDlg.open" ns="rain" :cfg-id="verDlg.id" :cfg-name="verDlg.name" @restore="restoreVersion" @duplicate="duplicateVersion" />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
/* 窗口骨架（.lb-shell / .lb-body / .lb-col / .lb-side / .lb-mini…）在 styles/lbworkbench.css，此处只留本窗的变体 */
.lb-shell { font-size: var(--fs-4); overflow: hidden; }

.lb-configs { background: var(--surface); }
.lb-result { width: 468px; flex: none; border-left: 1px solid var(--border); background: var(--surface); }


.rain-sel { font: inherit; font-size: var(--fs-3); padding: 3px 6px; border: 1px solid var(--field-border); border-radius: var(--r-ctl); background-color: var(--surface-2); color: var(--text); max-width: 220px; }

/* 参数条（轨道类型 / 几何 / 链路方向 / 降雨模型）：功能区之下、算例表之上 */
/* 窄栏下按整组换行、组内文字不折断（避免「链路方/向」「ITU-R 自/动」式中途断行） */
.rain-toolbar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
.rain-seg-grp { flex: none; display: inline-flex; align-items: center; gap: 7px; }
.rain-seg-lb { flex: none; white-space: nowrap; font-size: var(--fs-2); letter-spacing: var(--ls-label); color: var(--text-muted); text-transform: uppercase; }
/* 全局几何输入（GEO 轨位 / NGSO 轨道三要素）：与分段控件同高（--h-ctl，含描边），标签内嵌 + 单位后缀。
   它是输入框不是按钮：底色 / 描边 / 悬停 / 焦点跟全局输入框一套（field-*），焦点环描整个框而不是框里的裸 input */
.rain-geom { flex: none; display: inline-flex; align-items: center; gap: 5px; height: var(--h-ctl); box-sizing: border-box; padding: 0 7px 0 8px; border: 1px solid var(--field-border); border-radius: var(--r-ctl); background: var(--field-bg); }
.rain-geom:hover { border-color: var(--field-border-hover); }
.rain-geom:focus-within { border-color: var(--accent-ui); background: var(--field-bg); }
.rain-geom:has(input:focus-visible) { outline: 2px solid var(--accent-ui); outline-offset: -1px; }
.rain-geom input:focus-visible { outline: none !important; }
.rain-geom:has(input:disabled), .rain-geom:has(input[readonly]) { background: var(--field-disabled-bg); border-color: var(--border); }
.rain-geom span { font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
.rain-geom input { width: 48px; padding: 0; border: 0; background: transparent; color: var(--text); font: inherit; font-size: var(--fs-3); text-align: right; outline: none; font-variant-numeric: tabular-nums; }
.rain-geom i { font-style: normal; font-size: var(--fs-1); color: var(--text-faint); }

.rain-grid { flex: 1 1 auto; min-height: 0; min-width: 0; overflow: hidden; display: flex; padding: 8px; }
.rain-grid > * { flex: 1 1 auto; min-height: 0; min-width: 0; }
/* 结果格算不出来时标红：走 lbworkbench.css 的 .sg-cell.st-bad（与链路表同一条规则），此处不再另写 */

/* 多站汇总设置条：窄窗口下按整组换行（组内不折断，与参数条同一套办法） */
.rain-foot { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 7px 12px; padding: 6px 12px; border-top: 1px solid var(--border); background: var(--surface); }
/* 多站开关：设置条第一项 */
.rain-sw { flex: none; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; white-space: nowrap; }
.rain-sw input { margin: 0; cursor: pointer; }
.rain-sw span { font-size: var(--fs-3); font-weight: 600; }
.rain-sel-sm { font-size: var(--fs-2); padding: 2px 4px; max-width: 74px; }

/* 结果栏 */
.lb-result-bd { flex: 1 1 auto; overflow: auto; padding: 10px; }
/* 空态（P14）：居中一句，距栏头底线 18px（外层 10 + 8） */
.rain-ph { color: var(--text-faint); font-size: var(--fs-3); line-height: 1.7; text-align: center; padding: 8px 6px; }
.rain-err { color: var(--danger); font-size: var(--fs-4); padding: 16px 8px; }

.rain-detail { margin-top: 12px; }
.rd-sec { margin-bottom: 12px; border: 1px solid var(--border); border-radius: var(--r-box); overflow: hidden; }
.rd-hd { padding: 5px 10px; font-size: var(--fs-2); letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-muted); background: var(--surface-2); border-bottom: 1px solid var(--border); font-weight: 600; }
.rd-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 4px 10px; font-size: var(--fs-3); }
.rd-row + .rd-row { border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.rd-k { color: var(--text-muted); flex: 0 1 auto; }
.rd-v { font-family: var(--font-mono); color: var(--text); text-align: right; white-space: nowrap; }
.rd-row.em { background: color-mix(in srgb, var(--accent-ui) 6%, transparent); }
.rd-row.em .rd-k { color: var(--text); font-weight: 600; }
.rd-row.em .rd-v { color: color-mix(in srgb, var(--accent) 82%, var(--text)); font-weight: 600; }
.rd-note { padding: 6px 10px 7px; font-size: var(--fs-2); line-height: 1.6; color: var(--text-faint); border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent); background: color-mix(in srgb, var(--surface-2) 45%, transparent); }
</style>
