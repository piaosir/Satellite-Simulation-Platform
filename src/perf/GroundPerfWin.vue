<script setup>
// 对地性能指标表（独立窗口）。对标 SATSOFT 两步法、合为一窗：上 = 城市（增删改、城市设置）；
// 下 = 只读性能结果（仅列覆盖该城市的波束）。
// 数据分工：城市列表 / 选项 / 城市组的【编辑】在本地（usePerfTable 的编辑模型，网格回调当场拿到行数、
// 撤销重做也在本地），改完整份发回主窗口；主窗口按天线取值后把结果行推回来。城市在地图上的
// 指向误差框由主窗口按同一份城市与设置画（见 viz/grd/cityBoxes.js）。
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import Icon from '../components/Icon.vue'
import ExcelGrid from '../components/ExcelGrid.vue'
import { useGridSelect } from '../viz/grd/useGridSelect.js'
import { usePerfTable, PERF_COL_DEFS, PERF_COL_GROUPS, perfVisibleColumns, fillOpts } from '../viz/grd/usePerfTable.js'
import { sheetModel, exportSheets, importWorkbook, sheetToRecords, sheetToTsv, pickSheet, safeFileName } from '../shared/gridXlsx.js'
import { appAlert } from '../stores/alert.js'
import { cityName } from '../shared/cityName.js'
import { byLang } from '../shared/i18n/lang.js'
import { useBridge, useMirror } from './bridge.js'
import { persistedRef } from './prefs.js'
import PwMenu from './PwMenu.vue'
import PwDialog from './PwDialog.vue'
import CityPicker from '../components/CityPicker.vue'
import MarkerPick from './MarkerPick.vue'
import PerfOptsDialog from './PerfOptsDialog.vue'

const B = useBridge()
const { st, act, req } = B
const key = B.self.key
const pl = usePerfTable()
pl.setActiveKey(key)

// ===== 镜像：城市列表 / 选项 / 城市组（口径见 bridge.useMirror）=====
const stSig = (list) => JSON.stringify((list || []).map((s) => [s.id, s.country, s.city, s.desig, s.lon, s.lat]))
useMirror(st, 'stations', {
  sigOf: stSig,
  apply: (v) => pl.setStationsOf(key, v),
  local: () => pl.stations.value,
  send: (v) => act('stations', v)
})
const optSig = (o) => JSON.stringify(fillOpts(o))
useMirror(st, 'opts', {
  sigOf: optSig,
  apply: (v) => pl.setOptsOf(key, v),
  local: () => pl.optsByAnt.value[key],
  send: (v) => act('opts', v)
})
const grpSig = (list) => JSON.stringify((list || []).map((g) => [g.id, g.name, (g.cities || []).map((c) => [c.country, c.city, c.desig, c.lon, c.lat])]))
useMirror(st, 'cityGroups', {
  sigOf: grpSig,
  apply: (v) => pl.setCityGroups(v),
  local: () => pl.cityGroups.value,
  send: (v) => act('cityGroups', v)
})
watch(() => st.ctxBeams, (v) => { pl.ctxBeams.value = Array.isArray(v) ? v : [] }, { immediate: true })
const opts = computed(() => pl.getOpts(key))
const ctx = computed(() => st.ctx || null)

// 城市库（约 360 座国内城市 + 国际城市，与 GEO 链路预算共用同一 IPC 源）：城市名 → 经纬度自动补全
onMounted(async () => {
  try {
    const api = window.api && window.api.linkBudget
    const c = api && await api.cities()
    if (c && c.length) { pl.setCities(c); pl.applyCityGeoAll() }
  } catch { /* 无 IPC：自动补全暂不可用 */ }
  B.ready()
})

// ===== 上：城市输入（可编辑 ExcelGrid）=====
const inCols = [
  { key: 'country', label: '国家' },
  { key: 'city', label: '城市' },
  { key: 'desig', label: '代号' },
  { key: 'lon', label: '经度', num: true, unit: '°E' },
  { key: 'lat', label: '纬度', num: true, unit: '°N' }
]
const inGrid = useGridSelect({
  gridId: 'pw-in',
  rows: () => pl.stations.value,
  cols: () => inCols,
  cellText: (r, c) => { const v = r[c.key]; return v == null ? '' : String(v) },
  // 编辑城市名后，若精确命中城市库 → 自动补全经纬度（与 GEO 链路预算一致）
  onEdit: (id, k, val) => { pl.updateStation(id, { [k]: val }); if (k === 'city') pl.applyCityGeo(id) },
  onPasteBlock: (anchorId, startKey, text) => pl.pasteBlock(anchorId, startKey, text),
  onPasteAppend: (text) => pl.addStationsBulk(text),
  onClear: (cells) => cells.forEach(({ rowId, key: k }) => pl.updateStation(rowId, { [k]: '' })),
  onInsertRows: (at, n) => { for (let k = 0; k < n; k++) pl.addEmptyStation(at + k); return n },
  onDeleteRows: (ids) => { const s = new Set(ids); const before = pl.stations.value.length; pl.stations.value = pl.stations.value.filter((x) => !s.has(x.id)); return before - pl.stations.value.length },
  pushUndo: () => pl.pushUndo(), dropUndo: () => pl.dropUndo(), refresh: () => {},
  undo: () => undo(), redo: () => redo()
})
function addRow() {
  pl.pushUndo()
  const ri = inGrid.sel.value.ri
  const at = ri >= 0 ? ri + 1 : pl.stations.value.length
  pl.addEmptyStation(at)
  nextTick(() => { inGrid.sel.value = { ar: at, ac: 0, ri: at, ci: 0 }; inGrid.focusGrid() })
}
function addRowEnd() {
  pl.pushUndo()
  const at = pl.stations.value.length
  pl.addEmptyStation(at)
  nextTick(() => { inGrid.sel.value = { ar: at, ac: 0, ri: at, ci: 0 }; inGrid.focusGrid() })
}
function delStation(id) { pl.pushUndo(); pl.removeStation(id) }
function clearStations() { if (!pl.stations.value.length) return; pl.pushUndo(); pl.clearStations() }
function undo() { pl.undo() }
function redo() { pl.redo() }

// —— 典型城市（城市库选点，与链路预算即点即入同口径）——
const cityOpen = ref(false)
const hasLL = (lon, lat) => pl.stations.value.some((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat) && Math.abs(s.lon - lon) < 1e-4 && Math.abs(s.lat - lat) < 1e-4)
function addCities(list) {
  pl.pushUndo()
  const n = pl.addStations(list.map((c) => ({ country: c.country || byLang('中国', 'China'), city: cityName(c), desig: '', lon: c.lon, lat: c.lat })))
  if (!n) pl.dropUndo()
}

// —— 导入 ▾：标记（点标记 / 地球站 / 航迹，一个对话框三栏勾选）/ Excel / 剪贴板 ——
const mkOpen = ref(false)
const markers = computed(() => st.markers || { pts: [], sts: [], trajs: [] })
const importItems = computed(() => [
  { key: 'mk', label: '从标记 / 航迹导入…', icon: 'map-pin', title: '勾选地图上的点标记 / 地球站 / 航迹导入为城市（航迹每个航点一行）' },
  { key: 'xlsx', label: '从 Excel 导入…', icon: 'import', title: '按表头匹配列；无表头时末两列作经纬度' },
  { key: 'clip', label: '粘贴剪贴板', icon: 'clipboard', title: '每行一站，末两列 = 经度、纬度，可含 国家/城市/代号' }
])
async function onImport(k) {
  if (k === 'mk') { mkOpen.value = true; return }
  if (k === 'xlsx') { await importXlsx(); return }
  if (k === 'clip') { await pasteClip(); return }
}
// 三栏一起落：点标记 / 地球站就地导入；航迹的航点向主窗口取（列表里只带条数，不带整条航点）
async function confirmMk(sel) {
  const pts = (markers.value.pts || []).filter((p) => sel.pts.includes(p.id))
  const sts = (markers.value.sts || []).filter((s) => sel.sts.includes(s.id))
  mkOpen.value = false
  let trajs = []
  if (sel.trajs && sel.trajs.length) {
    try { trajs = (await req('trajPts', { ids: sel.trajs })) || [] } catch { trajs = [] }
  }
  if (!pts.length && !sts.length && !trajs.length) return
  pl.pushUndo()
  const n = pl.importFromMarkers(pts, sts) + (trajs.length ? pl.importFromTrajectories(trajs) : 0)
  if (!n) { pl.dropUndo(); appAlert('所选标记均已在城市列表中') }
}
async function pasteClip() {
  let text = ''
  try { text = await navigator.clipboard.readText() } catch { appAlert('无法读取剪贴板，请在表格内按 Ctrl+V'); return }
  pl.pushUndo()
  const n = pl.addStationsBulk(text)
  if (!n) { pl.dropUndo(); appAlert('剪贴板没有可识别的经纬度数据（约定末两列为 经度、纬度）') }
}
// 导入城市列表：按表头匹配「国家/城市/代号/经度/纬度」；认不出表头就退回剪贴板那条位置约定（末两列=经纬度）
async function importXlsx() {
  const res = await importWorkbook({ title: '导入城市列表（追加）' })
  if (!res || res.canceled) return
  if (!res.ok) { appAlert('导入失败：' + (res.error || '无法读取该文件')); return }
  const sheet = pickSheet(res.sheets, inCols)
  if (!sheet) { appAlert('这份工作簿里没有数据'); return }
  const { records } = sheetToRecords(sheet, inCols)
  pl.pushUndo()
  let n = 0
  if (records) {
    for (const rec of records) {
      const s = pl.addEmptyStation()
      pl.updateStation(s.id, { country: rec.country || '', city: rec.city || '', desig: rec.desig || '', lon: rec.lon, lat: rec.lat })
      n++
    }
  } else n = pl.addStationsBulk(sheetToTsv(sheet))
  if (!n) { pl.dropUndo(); appAlert('没有读到数据（表头需含「经度 / 纬度」，或把经纬度放在最后两列）'); return }
  pl.applyCityGeoAll()
}
const xlsxVal = (r, c) => { const v = r[c.key]; if (v == null || v === '') return null; return (c.num && typeof v === 'number') ? v : String(v) }
const ctxName = () => (ctx.value ? ctx.value.satName + '_' + ctx.value.antName : '性能指标表')
const citySheet = () => sheetModel({ name: '城市输入', cols: inCols, rows: pl.stations.value, value: xlsxVal })
async function exportCities() {
  if (!pl.stations.value.length) { appAlert('城市列表为空'); return }
  const r = await exportSheets({ defaultName: safeFileName('城市列表_' + ctxName(), '城市列表') + '.xlsx', title: '导出城市列表', sheets: [citySheet()] })
  if (r && r.error) appAlert('导出失败：' + r.error)
}

// —— 城市组 ▾：载入 / 管理 ——
const grpOpen = ref(false)
const grpSel = ref('')            // 最近载入的组 id（管理对话框里高亮）
const newGrpName = ref(''), renameId = ref(''), renameVal = ref(''), delId = ref('')
const groupItems = computed(() => {
  const gs = pl.cityGroups.value
  const items = gs.map((g) => ({ key: 'g:' + g.id, label: g.name, skip: true, note: String(g.cities.length), icon: 'layers', title: '载入：用此组城市替换当前列表（可撤销）' }))
  if (gs.length) items.push({ sep: true })
  items.push({ key: 'manage', label: '管理城市组…', icon: 'settings' })
  return items
})
function onGroupPick(k) {
  if (k === 'manage') { delId.value = ''; renameId.value = ''; newGrpName.value = ''; grpOpen.value = true; return }
  if (k.startsWith('g:')) loadGroup(pl.cityGroups.value.find((g) => g.id === k.slice(2)))
}
function loadGroup(g) {
  if (!g) return
  pl.pushUndo()
  const n = pl.loadCityGroup(g.id)
  grpSel.value = g.id
  if (!n) appAlert('该城市组为空')
}
function createGroup() {
  if (!pl.stations.value.length) { appAlert('当前城市列表为空，无法存为组'); return }
  const id = pl.addCityGroup(newGrpName.value)
  if (id) { newGrpName.value = ''; grpSel.value = id }
}
function appendGroup(g) { pl.pushUndo(); const n = pl.appendCityGroup(g.id); if (!n) { pl.dropUndo(); appAlert('该组城市已全部在当前列表中（按坐标去重）') } }
function overwriteGroup(g) { if (!pl.stations.value.length) { appAlert('当前城市列表为空，无法覆盖'); return } pl.overwriteCityGroup(g.id) }
function startRename(g) { delId.value = ''; renameId.value = g.id; renameVal.value = g.name }
function commitRename(g) { if (pl.renameCityGroup(g.id, renameVal.value)) renameId.value = '' }
// 两步删除：首次点击进入「确认」态，再点一次才真正删除
function deleteGroup(g) { if (delId.value !== g.id) { delId.value = g.id; return } pl.removeCityGroup(g.id); if (grpSel.value === g.id) grpSel.value = ''; delId.value = '' }

// —— 城市设置（SATSOFT Cities 页：标签 / 标记 / 指向误差）——
const setOpen = ref(false)

// ===== 下：性能结果（只读）=====
const query = ref('')
const optsOpen = ref(false)
const rows = computed(() => (Array.isArray(st.rows) ? st.rows : []))
const filteredRows = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return rows.value
  return rows.value.filter((r) => [r.country, r.city, r.desig].some((v) => String(v || '').toLowerCase().includes(q)))
})
const cols = computed(() => perfVisibleColumns(opts.value))
const resGrid = useGridSelect({
  gridId: 'pw-res',
  rows: () => filteredRows.value,
  cols: () => cols.value,
  readOnly: true,
  cellText: (r, c) => { const v = r[c.key]; if (c.num && c.fix != null) return v == null ? '' : Number(v).toFixed(c.fix); return v == null ? '' : String(v) }
})
const fx = (v, n) => (v == null ? '—' : Number(v).toFixed(n == null ? 2 : n))
function resText(r, c) {
  if (c.num) return c.fix != null ? fx(r[c.key], c.fix) : (r[c.key] == null ? '—' : String(r[c.key]))
  return r[c.key] || ''
}
// 列单位：param 随参数计算口径动态（dB / 功率 / 电压；Same as Antenna 恒 dB），其余取列定义
function colUnit(c) {
  if (!c) return ''
  if (c.key === 'param') {
    const o = opts.value
    if (!o || o.sameAsAnt || o.unit === 'dB') return 'dB'
    return o.unit === 'power' ? '功率' : o.unit === 'voltage' ? '电压' : 'dB'
  }
  return c.unit || ''
}
function writeClipboard(text) {
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
  return ok
}
function copyResult() {
  const cs = cols.value, rs = filteredRows.value
  if (!rs.length) { appAlert('结果表为空'); return }
  const head = cs.map((c) => { const u = colUnit(c); return c.label + (u ? '(' + u + ')' : '') }).join('\t')
  const body = rs.map((r) => cs.map((c) => { const v = r[c.key]; if (c.num && c.fix != null) return v == null ? '' : Number(v).toFixed(c.fix); return v == null ? '' : String(v) }).join('\t')).join('\n')
  if (!writeClipboard(head + '\n' + body)) appAlert('复制失败，请检查剪贴板权限')
}
async function exportResult() {
  if (!cols.value.length) { appAlert('当前没有显示任何列'); return }
  const c = ctx.value
  const note = [c ? '卫星 ' + c.satName : '', c ? '天线 ' + c.antName : '', c ? c.beams + ' 波束' : ''].filter(Boolean).join(' · ')
  const sheets = [
    sheetModel({ name: '性能结果', cols: cols.value, rows: resGrid.rows.value, value: xlsxVal, unitOf: colUnit, note }),
    citySheet()
  ]
  const r = await exportSheets({ defaultName: safeFileName('性能指标表_' + ctxName(), '性能指标表') + '.xlsx', title: '导出性能指标表', sheets })
  if (r && r.error) appAlert('导出失败：' + r.error)
}
function resetOpts() { pl.resetOpts(key) }

// ===== 中缝：拖拽调整上下高度 =====
const inH = persistedRef('ground/inH', 200, { min: 72, max: Math.max(72, window.innerHeight - 180) })   // 中缝高度：记住上次
function dragSplit(e) {
  if (e.button !== 0) return
  e.preventDefault()
  const sy = e.clientY, o = inH.value
  const onMove = (ev) => { inH.value = Math.max(72, Math.min(window.innerHeight - 180, o + (ev.clientY - sy))) }
  const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); document.body.style.userSelect = '' }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
}
const ptText = computed(() => { const o = opts.value; return o ? `Az ${Number(o.pointAz) || 0}° · El ${Number(o.pointEl) || 0}° · Yaw ${Number(o.pointYaw) || 0}°` : '' })
</script>

<template>
  <div class="pw-body">
    <!-- 上：城市 -->
    <section class="pw-in" :style="{ height: inH + 'px' }">
      <div class="pw-bar">
        <span class="pw-t">城市</span>
        <span class="ptb sq" :class="{ dis: !pl.canUndo.value }" title="撤销 (Ctrl+Z)" @click="undo"><Icon name="undo-2" :size="12" /></span>
        <span class="ptb sq" :class="{ dis: !pl.canRedo.value }" title="重做 (Ctrl+Y)" @click="redo"><Icon name="redo-2" :size="12" /></span>
        <span class="pw-sep"></span>
        <span class="ptb" title="在选中行下方增加一行（直接在表格里键入或粘贴）" @click="addRow"><Icon name="plus" :size="12" /> 增加</span>
        <span class="ptb" title="从城市库选点：城市名 / 省份 / 拼音首字母检索，点一座加一座" @click="cityOpen = true"><Icon name="map-pin" :size="12" /> 典型城市…</span>
        <PwMenu label="导入" icon="import" :items="importItems" title="从标记 / 航迹 / Excel / 剪贴板导入城市" @pick="onImport" />
        <span class="ptb" :class="{ dis: !pl.stations.value.length }" title="把城市列表导出为 Excel" @click="exportCities"><Icon name="download" :size="12" /> 导出 Excel</span>
        <span class="ptb" :class="{ dis: !inGrid.selRowCount.value }" title="删除选中的城市（可撤销；表内 Ctrl+- 同）" @click="inGrid.deleteRows()"><Icon name="minus" :size="12" /> 删除选中<em v-if="inGrid.selRowCount.value" class="ptb-n">{{ inGrid.selRowCount.value }}</em></span>
        <span class="ptb" :class="{ dis: !pl.stations.value.length }" title="清空城市列表（可撤销）" @click="clearStations"><Icon name="trash" :size="12" /> 清空</span>
        <span class="pw-sep"></span>
        <PwMenu label="城市组" icon="layers" :items="groupItems" title="载入已存的城市组，或管理城市组（存为新组 / 追加 / 覆盖 / 重命名 / 删除）" @pick="onGroupPick" />
        <span class="ptb" :class="{ on: setOpen }" title="城市设置：标签 / 标记 / 指向误差（指向误差同时决定 Min/Max Pointing 列与地图上的误差框）" @click="setOpen = true"><Icon name="settings" :size="12" /> 城市设置…</span>
        <span class="pw-cnt">{{ pl.stations.value.length }} 城市</span>
      </div>
      <ExcelGrid class="pw-grid eg-host" :grid="inGrid" :cols="inCols" :text="(r, c) => (r[c.key] == null ? '' : String(r[c.key]))"
                 :actions-width="26" empty-text="暂无城市。" add-label="增加一行" @add="addRowEnd">
        <template #actions="{ row }">
          <span class="del" title="删除该城市" @click="delStation(row.id)"><Icon name="x" :size="12" /></span>
        </template>
      </ExcelGrid>
    </section>

    <div class="pw-split" title="拖拽调整上下高度" @mousedown="dragSplit"><span class="grip"></span></div>

    <!-- 下：性能结果 -->
    <section class="pw-res">
      <div class="pw-bar">
        <span class="pw-t">性能结果<em>只读</em></span>
        <label class="pw-chk"><input type="checkbox" v-model="opts.filterOn" title="仅列方向性≥阈值（覆盖该城市）的波束" /> 仅覆盖波束</label>
        <!-- 数字框 .lazy：每敲一个字符就整表重算一次，且中途拿的是半截数字；失焦或回车才生效 -->
        <label class="pw-chk" :class="{ dis: !opts.filterOn }">阈值<input class="ci" type="number" step="0.5" v-model.lazy.number="opts.minDir" :disabled="!opts.filterOn" /><span class="u">dB</span></label>
        <input class="pw-q" v-model="query" placeholder="查询：国家 / 城市 / 代号" />
        <span class="ptb" title="复制整张结果表（含表头，TSV，可粘进 Excel）" @click="copyResult"><Icon name="copy" :size="12" /> 复制全表</span>
        <span class="ptb" title="导出为 Excel（性能结果 + 城市输入两张工作表；数字列存真数字）" @click="exportResult"><Icon name="download" :size="12" /> 导出 Excel</span>
        <span class="ptb" :class="{ on: optsOpen }" title="显示列 / 波束筛选 / 过滤 / 参数计算" @click="optsOpen = true"><Icon name="sliders-horizontal" :size="12" /> 选项…</span>
        <span class="pw-cnt">{{ filteredRows.length }} 行</span>
      </div>
      <ExcelGrid class="pw-grid eg-host" :grid="resGrid" :cols="cols" :text="resText"
                 :serial="!cols.some((c) => c.key === 'no')" :head-unit="colUnit"
                 :head-tip="(c) => (c.na ? '本数据仅含功率（无相位），AR 暂不可算' : (c.tip || c.label))"
                 :row-class="(r) => (r.inPattern ? null : 'out')"
                 :empty-text="pl.stations.value.length ? '没有波束覆盖这些城市。' : '暂无城市。'" />
    </section>

    <!-- 状态栏：上下文 + 指向误差 + 取值时刻 -->
    <div class="pw-status">
      <span v-if="ctx" data-i18n-skip>{{ ctx.satName }} / {{ ctx.antName }}</span>
      <span v-if="ctx">{{ ctx.beams }} 波束</span>
      <span title="指向误差（全幅）：Min/Max Pointing 列与地图上的误差框按 ±输入/2 取值"><span>指向误差</span> <span data-i18n-skip>{{ ptText }}</span></span>
      <span v-if="st.stamp" class="r" data-i18n-skip>{{ st.stamp }}</span>
    </div>

    <!-- 弹层 -->
    <CityPicker v-if="cityOpen" :has="hasLL" @add="addCities" @close="cityOpen = false" />
    <MarkerPick v-if="mkOpen" :pts="markers.pts || []" :sts="markers.sts || []" :trajs="markers.trajs || []" traj-note="每个航点一行，城市名取「航迹名#序号」" @confirm="confirmMk" @close="mkOpen = false" />
    <PerfOptsDialog v-if="optsOpen" title="性能表选项" :sub="ctx ? ctx.antName : ''" :opts="opts" :col-defs="PERF_COL_DEFS" :col-groups="PERF_COL_GROUPS" :ctx-beams="pl.ctxBeams.value" unit-choice @close="optsOpen = false" @reset="resetOpts" />

    <!-- 城市设置（SATSOFT §4.2.2 Cities：Label / Marker / Pointing Error） -->
    <PwDialog v-if="setOpen" title="城市设置" :sub="ctx ? ctx.antName : ''" :width="560" @close="setOpen = false">
      <div class="po-body cs-body">
        <section class="po-card">
          <label class="po-ct po-chk"><input type="checkbox" v-model="opts.cityLabelOn" /><span>标签</span></label>
          <div class="po-row"><label>类型</label><select v-model="opts.cityLabelType"><option value="city">城市名</option><option value="desig">代号</option></select></div>
          <div class="po-row"><label>位置</label><select v-model="opts.cityLabelAlign"><option value="right">右侧</option><option value="left">左侧</option><option value="above">上方</option><option value="below">下方</option></select></div>
          <div class="po-row"><label>字号</label><input class="ci" type="number" step="1" min="4" max="36" v-model.lazy.number="opts.cityLabelPt" /><span class="u">pt</span></div>
        </section>
        <section class="po-card">
          <label class="po-ct po-chk"><input type="checkbox" v-model="opts.cityMarkOn" /><span>标记</span></label>
          <div class="po-row"><label>类型</label><select v-model="opts.cityMarkType" title="矩形：刚性标记，同一设置下所有城市同一尺寸（Az / El 误差按星下点尺度折成经纬度），四边沿经纬线、任何视图下不变形；椭圆：指向误差的真实轨迹（随投影变形）"><option value="rect">矩形</option><option value="ellipse">椭圆（可变形）</option></select></div>
          <div class="po-row"><label>颜色</label><input class="pw-clr" type="color" v-model="opts.cityMarkColor" /><input class="ci" type="number" step="0.2" min="0.2" max="6" v-model.lazy.number="opts.cityMarkWidth" title="线宽" /><span class="u">px</span></div>
          <div class="po-sub">指向误差</div>
          <div class="po-row"><label>方位</label><input class="ci" type="number" step="any" min="0" v-model.lazy.number="opts.pointAz" title="东西向总指向误差（全幅，°）；对静止轨道即俯仰 pitch" /><span class="u">°</span></div>
          <div class="po-row"><label>俯仰</label><input class="ci" type="number" step="any" min="0" v-model.lazy.number="opts.pointEl" title="南北向总指向误差（全幅，°）；对静止轨道即滚动 roll" /><span class="u">°</span></div>
          <div class="po-row"><label>偏航</label><input class="ci" type="number" step="any" min="0" v-model.lazy.number="opts.pointYaw" title="绕偏航轴的总误差（°）：只放大框，离星下点越远放得越大" /><span class="u">°</span></div>
        </section>
      </div>
      <template #foot>
        <span class="save" @click="setOpen = false">完成</span>
      </template>
    </PwDialog>

    <!-- 城市组管理 -->
    <PwDialog v-if="grpOpen" title="城市组" :width="480" @close="grpOpen = false">
      <div class="grp-save">
        <input class="grp-name" v-model="newGrpName" :placeholder="'新组名称（默认：城市组 ' + (pl.cityGroups.value.length + 1) + '）'" @keydown.enter="createGroup" />
        <span class="save" :class="{ dis: !pl.stations.value.length }" @click="createGroup">存当前 {{ pl.stations.value.length }} 城市为新组</span>
      </div>
      <div class="grp-list">
        <div v-for="g in pl.cityGroups.value" :key="g.id" class="grp-row" :class="{ cur: grpSel === g.id }">
          <template v-if="renameId === g.id">
            <input class="grp-name f1" v-model="renameVal" @keydown.enter="commitRename(g)" @keydown.esc="renameId = ''" />
            <span class="gic ok" title="确认重命名" @click="commitRename(g)"><Icon name="check" :size="12" /></span>
            <span class="gic" title="取消" @click="renameId = ''"><Icon name="x" :size="12" /></span>
          </template>
          <template v-else>
            <span class="grp-nm" :title="g.name" data-i18n-skip>{{ g.name }}</span>
            <span class="grp-cnt">{{ g.cities.length }} 城市</span>
            <span class="gbtn" title="载入：用此组城市替换当前列表（可撤销）" @click="loadGroup(g)">载入</span>
            <span class="gbtn" title="追加此组城市到当前列表（按坐标去重）" @click="appendGroup(g)">追加</span>
            <span class="gbtn" title="用当前城市列表覆盖此组" @click="overwriteGroup(g)">覆盖</span>
            <span class="gic" title="重命名" @click="startRename(g)"><Icon name="pencil" :size="12" /></span>
            <span class="gic del" :class="{ warn: delId === g.id }" :title="delId === g.id ? '再次点击确认删除' : '删除此组'" @click="deleteGroup(g)"><Icon name="trash" :size="12" /></span>
          </template>
        </div>
        <div v-if="!pl.cityGroups.value.length" class="grp-empty">还没有城市组。</div>
      </div>
      <template #foot><span class="save" @click="grpOpen = false">完成</span></template>
    </PwDialog>
  </div>
</template>
