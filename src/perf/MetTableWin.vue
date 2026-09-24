<script setup>
// 气象指标表（独立窗口）。上 = 站点输入（可编辑，先经后纬）；下 = 只读读数表，列由「指标」勾选。
// ★ 读数跟随时间轴 —— 主窗口的时钟一动，整表由它重算后推过来。
// 站点列表在本地编辑（网格回调当场拿到行数），改完整份发回主窗口；显示列 / 和风取数 / 从标记导入
// 一律发回主窗口执行（它握着气象立方体与标记）。
import { ref, computed, watch, onMounted } from 'vue'
import Icon from '../components/Icon.vue'
import ExcelGrid from '../components/ExcelGrid.vue'
import { useGridSelect } from '../viz/grd/useGridSelect.js'
import { MET_COL_DEFS, MET_COL_GROUPS, metCellText, PTYPE_ZH } from '../viz/env/useLiveField.js'
import { sheetModel, exportSheets, importWorkbook, sheetToRecords, pickSheet, safeFileName } from '../shared/gridXlsx.js'
import { appAlert } from '../stores/alert.js'
import { cityName } from '../shared/cityName.js'
import { byLang } from '../shared/i18n/lang.js'
import { fmtTzTime, fmtTzTimeOff, parseTzText } from '../shared/tzText.js'
import { useBridge, useMirror } from './bridge.js'
import { persistedRef } from './prefs.js'
import PwMenu from './PwMenu.vue'
import PwDialog from './PwDialog.vue'
import CityPicker from '../components/CityPicker.vue'
import MarkerPick from './MarkerPick.vue'

const B = useBridge()
const { st, act } = B
onMounted(() => B.ready())

// ===== 站点列表：本地编辑模型 + 镜像 =====
const sites = ref([])
let _sid = 0
const nextId = () => 'pw' + Date.now().toString(36) + '-' + (_sid++).toString(36)
const fmtLL = (lon, lat) => `${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'} ${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`
// 「时间」列按主窗口的显示时区读写；带时刻的行读那一刻的气象帧 / 和风值 / 卫星几何，不带的跟时间轴
const tzMode = computed(() => (st.tzMode == null ? 'local' : st.tzMode))
const tText = (ms) => fmtTzTime(ms, tzMode.value)
const siteSig = (list) => JSON.stringify((list || []).map((s) => [s.id, s.name, s.tMs, s.lon, s.lat, s.src]))
useMirror(st, 'sites', {
  sigOf: siteSig,
  apply: (v) => { sites.value = (Array.isArray(v) ? v : []).map((s) => ({ id: s.id || nextId(), name: String(s.name == null ? '' : s.name), tMs: Number.isFinite(s.tMs) ? s.tMs : null, lon: s.lon == null ? null : Number(s.lon), lat: s.lat == null ? null : Number(s.lat), src: s.src || 'manual' })) },
  local: () => sites.value,
  send: (v) => act('sites', v)
})
// 时间插在经纬度之前：整块粘贴按「末两列 = 经度、纬度」认坐标
const inCols = [
  { key: 'name', label: '站名' },
  { key: 'tMs', label: '时间' },
  { key: 'lon', label: '经度', num: true, unit: '°E' },
  { key: 'lat', label: '纬度', num: true, unit: '°N' }
]
const inText = (r, c) => (c.key === 'tMs' ? tText(r.tMs) : (r[c.key] == null ? '' : String(r[c.key])))
// 经纬度是数字列（空串＝清空，非数字文本不落库）；站名随便填；时间按显示时区读（只敲时分沿用该行原来那天，空 = 跟时间轴）
function siteUpdate(id, key, val) {
  const s = sites.value.find((x) => x.id === id); if (!s) return
  if (key === 'name') { s.name = String(val == null ? '' : val); return }
  const t = String(val == null ? '' : val).trim()
  if (key === 'tMs') {
    if (t === '') { s.tMs = null; return }
    const ms = parseTzText(t, tzMode.value, Number.isFinite(s.tMs) ? s.tMs : Date.now())
    if (Number.isFinite(ms)) s.tMs = ms
    return
  }
  if (t === '') { s[key] = null; return }
  const n = Number(t)
  if (Number.isFinite(n)) s[key] = key === 'lat' ? Math.max(-90, Math.min(90, n)) : Math.max(-180, Math.min(180, n))
}
const newSite = (o) => ({ id: nextId(), name: '', tMs: null, lon: null, lat: null, src: 'manual', ...o })
function addRow(at) {
  const list = sites.value
  const i = at == null || at < 0 || at > list.length ? list.length : at
  list.splice(i, 0, newSite({}))
}
function pasteBlock(anchorId, startKey, text) {
  const list = sites.value
  const r0 = list.findIndex((x) => x.id === anchorId); if (r0 < 0) return 0
  const c0 = inCols.findIndex((c) => c.key === startKey); if (c0 < 0) return 0
  const grid = String(text || '').replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((l) => l.split('\t'))
  grid.forEach((cells, dr) => {
    const ri = r0 + dr
    while (ri >= list.length) list.push(newSite({}))
    cells.forEach((v, dc) => { const c = inCols[c0 + dc]; if (c) siteUpdate(list[ri].id, c.key, v) })
  })
  return grid.length
}
// 整块追加：≥2 列时按「末两列 = 经度、纬度」解析，前面若还有一列就当站名
function pasteAppend(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').trim().split('\n')
  let n = 0
  for (const l of lines) {
    const p = l.split(/\t|\s*,\s*|\s{2,}/).map((x) => x.trim()).filter((x) => x !== '')
    if (p.length < 2) continue
    const lat = Number(p[p.length - 1]), lon = Number(p[p.length - 2])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    // 经纬度前一格是时刻（本表复制出来的整行：站名 / 时间 / 经度 / 纬度）→ 取作该行时刻，不并进站名
    let head = p.slice(0, p.length - 2), tMs = null
    if (head.length) { const ms = parseTzText(head[head.length - 1], tzMode.value, Date.now()); if (Number.isFinite(ms)) { tMs = ms; head = head.slice(0, -1) } }
    sites.value.push(newSite({ name: head.length ? head.join(' ') : fmtLL(lon, lat), tMs, lon, lat }))
    n++
  }
  return n
}
const inGrid = useGridSelect({
  gridId: 'pw-met-in',
  rows: () => sites.value,
  cols: () => inCols,
  cellText: inText,
  onEdit: (id, key, val) => siteUpdate(id, key, val),
  onPasteBlock: pasteBlock,
  onPasteAppend: pasteAppend,
  onClear: (cells) => cells.forEach(({ rowId, key }) => siteUpdate(rowId, key, '')),
  onInsertRows: (at, n) => { for (let k = 0; k < n; k++) addRow(at + k); return n },
  onDeleteRows: (ids) => removeSiteIds(ids),
  refresh: () => {}
})
function delSite(id) { sites.value = sites.value.filter((s) => s.id !== id) }
// 整行删站（站点表与读数表共用：读数行一行＝一站、同一个 id）；返回真正删掉的行数
function removeSiteIds(ids) { const s = new Set(ids); const before = sites.value.length; sites.value = sites.value.filter((x) => !s.has(x.id)); return before - sites.value.length }
function clearSites() { sites.value = [] }
const hasLL = (lon, lat) => sites.value.some((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat) && Math.round(s.lon * 100) === Math.round(lon * 100) && Math.round(s.lat * 100) === Math.round(lat * 100))
function addCities(list) {
  let n = 0
  for (const c of list) { if (hasLL(c.lon, c.lat)) continue; sites.value.push(newSite({ name: cityName(c), lon: Number(c.lon), lat: Number(c.lat), src: 'city' })); n++ }
  if (!n) appAlert('所选城市均已在站点列表中')
}

// ===== 导入 ▾：标记（点标记 / 地球站 / 航迹，一个对话框三栏勾选）/ Excel / 剪贴板 =====
const cityOpen = ref(false), mkOpen = ref(false)
const markers = computed(() => st.markers || { pts: [], sts: [], trajs: [] })
const importItems = computed(() => [
  { key: 'mk', label: '从标记 / 航迹导入…', icon: 'map-pin', title: '勾选地图上的点标记 / 地球站 / 航迹导入为站点（航迹每个航点一行；航迹排得出时刻的，每行带上经过该点的时刻，读数取那一刻）' },
  { key: 'xlsx', label: '从 Excel 导入…', icon: 'import', title: '按表头匹配 站名 / 经度 / 纬度' },
  { key: 'clip', label: '粘贴剪贴板', icon: 'clipboard', title: '每行至少两列，末两列为经度、纬度，其余作站名' }
])
async function onImport(k) {
  if (k === 'mk') { mkOpen.value = true; return }
  if (k === 'xlsx') { await importXlsx(); return }
  if (k === 'clip') { await pasteClip(); return }
}
// 三栏一起交给主窗口（它握着标记与航迹的原始数据，按站点去重后推回来）
function confirmMk(sel) { mkOpen.value = false; act('importMarkers', sel) }
async function pasteClip() {
  let txt = ''
  try { txt = await navigator.clipboard.readText() } catch { appAlert('无法读取剪贴板，请在表格内按 Ctrl+V'); return }
  const n = pasteAppend(txt)
  if (!n) appAlert('剪贴板中没有可解析的坐标（每行至少两列，末两列为经度、纬度）')
}
async function importXlsx() {
  const res = await importWorkbook({ title: '导入站点' })
  if (!res || !res.ok) { if (res && res.message) appAlert(res.message); return }
  const sheet = pickSheet(res.sheets, inCols)
  if (!sheet) { appAlert('该工作簿中没有可识别的站点表'); return }
  const { records } = sheetToRecords(sheet, inCols)
  let n = 0
  for (const rec of (records || [])) {
    const lon = Number(rec.lon), lat = Number(rec.lat)
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    const ms = rec.tMs != null && String(rec.tMs).trim() !== '' ? parseTzText(rec.tMs, tzMode.value, Date.now()) : NaN
    sites.value.push(newSite({ name: String(rec.name || '').trim() || fmtLL(lon, lat), tMs: Number.isFinite(ms) ? ms : null, lon, lat }))
    n++
  }
  if (!n) appAlert('无可导入的行（需经度、纬度两列）')
}

// ===== 下：读数表 =====
const colKeys = computed(() => (Array.isArray(st.cols) ? st.cols : []))
const cols = computed(() => MET_COL_DEFS.filter((c) => colKeys.value.includes(c.key)))
const rows = computed(() => (Array.isArray(st.rows) ? st.rows : []))
const resText = (r, c) => metCellText(r, c, tText)
const resGrid = useGridSelect({ gridId: 'pw-met-res', rows: () => rows.value, cols: () => cols.value, readOnly: true, cellText: resText, onDeleteRows: removeSiteIds })
const optsOpen = ref(false)
const colDef = (k) => MET_COL_DEFS.find((c) => c.key === k) || null
const colLabel = (k) => { const c = colDef(k); return c ? c.label + (c.unit ? '（' + c.unit + '）' : '') : k }
const colSatOff = (k) => { const c = colDef(k); return !!(c && c.sat) && !st.satReady }
const colObsOff = (k) => { const c = colDef(k); return !!(c && c.obs) && !st.obsAt }
const colOff = (k) => colSatOff(k) || colObsOff(k)
const colTip = (k) => {
  const c = colDef(k)
  if (colSatOff(k)) return '须先在主窗口「实时气象 · 链路参数」指定目标卫星'
  if (colObsOff(k)) return '须先在表内执行「获取和风数据」'
  return (c && c.tip) || (c ? c.label : k)
}
const obsAtText = computed(() => {
  const t = Number(st.obsAt) || 0
  if (!t) return ''
  const d = new Date(t), p = (n) => String(n).padStart(2, '0')
  const kinds = new Set()
  for (const r of rows.value) if (r.oKind) kinds.add(r.oKind)
  const k = kinds.size === 1 ? [...kinds][0] : (kinds.size ? '观测＋预报' : '')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${k ? ' · ' + k : ''}`
})
const pointOk = computed(() => st.pointOk !== false)
const fetchDis = computed(() => !!st.obsBusy || !sites.value.length || !pointOk.value)
function fetchObs() { if (!fetchDis.value) act('fetchObs') }
function copyResult() {
  const cs = cols.value
  const head = cs.map((c) => c.label + (c.unit ? '(' + c.unit + ')' : '')).join('\t')
  const body = resGrid.rows.value.map((r) => cs.map((c) => { const t = resText(r, c); return t === '—' ? '' : t }).join('\t'))
  const text = [head, ...body].join('\n')
  let ok = false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0'
    document.body.appendChild(ta)
    ta.focus(); ta.select()
    ok = document.execCommand('copy')
    document.body.removeChild(ta)
  } catch { ok = false }
  if (!ok) { try { navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {}) } catch { /* 剪贴板不可用 */ } }
}
const xlsxVal = (r, c) => {
  if (c.time) return Number.isFinite(r[c.key]) ? fmtTzTimeOff(r[c.key], tzMode.value) : ''   // 带时区偏移：换台机器读回来不走样
  if (!c.num) return c.key === 'ptype' ? (PTYPE_ZH[r.ptype] || '') : (r[c.key] == null ? '' : String(r[c.key]))
  const v = Number(r[c.key]) * (c.mul || 1)
  return Number.isFinite(v) ? v : ''
}
async function exportXlsx() {
  if (!cols.value.length) { appAlert('当前未显示任何指标列'); return }
  const m = st.siteMeta
  const note = m ? `${m.model} · ${new Date(m.frameT).toISOString().slice(0, 16).replace('T', ' ')}Z` : ''
  const sheets = [
    sheetModel({ name: '气象指标', cols: cols.value, rows: resGrid.rows.value, value: xlsxVal, unitOf: (c) => c.unit, note }),
    sheetModel({ name: '站点输入', cols: inCols, rows: sites.value, value: (r, c) => (c.key === 'tMs' ? (Number.isFinite(r.tMs) ? fmtTzTimeOff(r.tMs, tzMode.value) : null) : r[c.key]) })
  ]
  const r = await exportSheets({ defaultName: safeFileName('气象指标表', '气象指标表') + '.xlsx', title: '导出气象指标表', sheets })
  if (r && r.error) appAlert('导出失败：' + r.error)
}
function toggleCol(k) {
  const on = colKeys.value.includes(k)
  const next = on ? colKeys.value.filter((x) => x !== k) : [...colKeys.value, k]
  if (!next.length) return            // 至少留一列，否则表整个消失
  act('cols', MET_COL_DEFS.filter((c) => next.includes(c.key)).map((c) => c.key))
}
const emptyText = computed(() => (sites.value.length ? (st.hasMeta ? '当前时刻不在已获取的气象时段内。' : '尚未获取气象数据。') : '还没有站点。'))

// ===== 中缝 =====
const inH = persistedRef('met/inH', 160, { min: 72, max: Math.max(72, window.innerHeight - 180) })   // 中缝高度：记住上次
function dragSplit(e) {
  if (e.button !== 0) return
  e.preventDefault()
  const sy = e.clientY, o = inH.value
  const onMove = (ev) => { inH.value = Math.max(72, Math.min(window.innerHeight - 180, o + (ev.clientY - sy))) }
  const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); document.body.style.userSelect = '' }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
}
</script>

<template>
  <div class="pw-body">
    <section class="pw-in" :style="{ height: inH + 'px' }">
      <div class="pw-bar">
        <span class="pw-t">站点</span>
        <span class="ptb" title="在末尾增加一行（可直接键入或粘贴；先经度、后纬度）" @click="addRow(null)"><Icon name="plus" :size="12" /> 增加</span>
        <span class="ptb" title="从城市库选点：城市名 / 省份 / 拼音首字母检索，点一座加一座" @click="cityOpen = true"><Icon name="map-pin" :size="12" /> 典型城市…</span>
        <PwMenu label="导入" icon="import" :items="importItems" title="从标记 / 航迹 / Excel / 剪贴板导入站点" @pick="onImport" />
        <span class="ptb" :class="{ dis: !inGrid.selRowCount.value }" title="删除选中的站点（表内 Ctrl+- 同）" @click="inGrid.deleteRows()"><Icon name="minus" :size="12" /> 删除选中<em v-if="inGrid.selRowCount.value" class="ptb-n">{{ inGrid.selRowCount.value }}</em></span>
        <span class="ptb" :class="{ dis: !sites.length }" title="清空站点列表" @click="clearSites"><Icon name="trash" :size="12" /> 清空</span>
        <span class="pw-cnt">{{ sites.length }} 站</span>
      </div>
      <ExcelGrid class="pw-grid eg-host" :grid="inGrid" :cols="inCols" :text="inText"
                 :actions-width="26" empty-text="还没有站点。" add-label="增加一行" @add="addRow(null)">
        <template #actions="{ row }">
          <span class="del" title="删除该站" @click="delSite(row.id)"><Icon name="x" :size="12" /></span>
        </template>
      </ExcelGrid>
    </section>

    <div class="pw-split" title="拖拽调整上下高度" @mousedown="dragSplit"><span class="grip"></span></div>

    <section class="pw-res">
      <div class="pw-bar">
        <span class="pw-t">计算结果<em>只读 · 随时间轴更新</em></span>
        <span class="ptb" :class="{ dis: fetchDis }" :title="pointOk ? '向和风天气请求各站在时间轴当前时刻的值，写入「和风」列组（逐站各一次请求，按站计费；本小时取实况观测，未来取逐小时预报，无历史数据。取一次即覆盖整条时间轴，之后拖动时间轴不再发请求）' : (st.pointMsg || '和风天气未配置')" @click="fetchObs">
          <Icon name="cloud-rain" :size="12" /> {{ st.obsBusy ? '获取中…' : `获取和风数据（${sites.length} 站）` }}</span>
        <span v-if="obsAtText" class="pw-cnt" title="和风列对应的时刻与口径，与左侧模式列同一时刻"><span>和风</span> <span data-i18n-skip>{{ obsAtText }}</span></span>
        <span v-if="st.msg" class="pw-cnt" data-i18n-skip>{{ st.msg }}</span>
        <span class="ptb" :class="{ dis: !resGrid.selRowCount.value }" title="删除选中行对应的站点（表内 Delete / Ctrl+- 同）" @click="resGrid.deleteRows()"><Icon name="minus" :size="12" /> 删除选中<em v-if="resGrid.selRowCount.value" class="ptb-n">{{ resGrid.selRowCount.value }}</em></span>
        <span class="ptb" title="复制整张结果表（含表头，TSV，可粘贴至 Excel）" @click="copyResult"><Icon name="copy" :size="12" /> 复制全表</span>
        <span class="ptb" title="导出为 Excel（计算结果 + 站点输入两张工作表；数字列写入数值）" @click="exportXlsx"><Icon name="download" :size="12" /> 导出 Excel</span>
        <span class="ptb" :class="{ on: optsOpen }" title="选择显示的气象与链路指标" @click="optsOpen = true"><Icon name="sliders-horizontal" :size="12" /> 指标…</span>
        <span v-if="st.busy" class="pw-cnt">计算中…</span>
        <span v-else class="pw-cnt">{{ rows.length }} 行</span>
      </div>
      <ExcelGrid class="pw-grid eg-host" :grid="resGrid" :cols="cols" :text="resText"
                 :head-tip="(c) => (c.tip || c.label)"
                 :row-class="(r) => (r.note && r.totalDb == null ? 'out' : null)"
                 :empty-text="emptyText" />
    </section>

    <div class="pw-status">
      <span v-if="st.siteMeta" data-i18n-skip>{{ st.siteMeta.model }}</span>
      <span v-if="st.timeText" data-i18n-skip>{{ st.timeText }}</span>
      <span v-else-if="!st.hasMeta">尚未获取气象数据</span>
      <span v-if="st.satName" class="r"><span>目标卫星</span> <span data-i18n-skip>{{ st.satName }}</span></span>
    </div>

    <CityPicker v-if="cityOpen" :has="hasLL" @add="addCities" @close="cityOpen = false" />
    <MarkerPick v-if="mkOpen" :pts="markers.pts || []" :sts="markers.sts || []" :trajs="markers.trajs || []" traj-note="每个航点一行；读数为当前时刻沿该航线各点的衰减" @confirm="confirmMk" @close="mkOpen = false" />

    <!-- 指标选择：只换「看哪些量」 -->
    <PwDialog v-if="optsOpen" title="显示指标" :width="560" @close="optsOpen = false">
      <section class="po-card po-cols met-po-cols">
        <div class="po-scroll">
          <div v-for="grp in MET_COL_GROUPS" :key="grp.title" class="po-grp">
            <div class="po-gt">{{ grp.title }}</div>
            <label v-for="k in grp.keys" :key="k" class="po-ck" :class="{ dis: colOff(k) }" :title="colTip(k)">
              <input type="checkbox" :checked="colKeys.includes(k)" @change="toggleCol(k)" />
              <span>{{ colLabel(k) }}</span>
            </label>
          </div>
        </div>
      </section>
      <template #foot>
        <span class="save ghost po-reset" title="恢复出厂勾选" @click="act('resetCols')">恢复默认</span>
        <span class="save" @click="optsOpen = false">完成</span>
      </template>
    </PwDialog>
  </div>
</template>
