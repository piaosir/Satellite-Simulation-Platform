<script setup>
// 雨衰计算 独立窗口 —— 通用，面向所有种类卫星（仰角驱动）。
// Excel 式批量计算（每行一算例，计算结果就地进表）+ 右侧单算例细致分析（交互式坐标系 + SatMaster 版详情）。
// 计算在主进程 core.calculateRainAttenuation（复用 ITU-R 传播模型），本组件负责采集/展示/配置持久化。
import { ref, reactive, shallowRef, computed, watch, nextTick, onMounted } from 'vue'
import StationGrid from '../linkbudget/StationGrid.vue'   // 通用表格组件（Regen 先例：直接复用）
import ConfigTree from '../components/ConfigTree.vue'
import Icon from '../components/Icon.vue'
import RainPlot from './RainPlot.vue'
import { rainFields, RESULT_KEYS, POL_LABEL, defaultRow, buildRainCase } from './rainParams.js'
import { stableStringify } from '../shared/configDirty.js'
import { halfStr } from '../shared/num.js'

const api = (typeof window !== 'undefined' && window.api) ? window.api.rainAttenuation : null

// —— 全局选项 ——
const orbitMode = ref('geo')        // 'geo'（输入 GEO 轨位算仰角）| 'ngso'（直接输入仰角，任意非静止轨道）
const direction = ref('down')       // 'down' | 'up'（G/T 衰减 / DND 为下行专属）
const rainModel = ref('auto')       // 'auto'（经纬度→ITU-R P.837 自动填 R0.01）| 'manual'（手填）
// 动态字段集：GEO 有 轨位+仰角(只读)，NGSO 仅 仰角(可编辑)
const fields = computed(() => rainFields(orbitMode.value))
// 只读字段：结果列恒只读；自动降雨模型→R0.01 只读；GEO 模式→仰角只读（由轨位换算）
const readonlyKeys = computed(() => {
  const ks = RESULT_KEYS.slice()
  if (rainModel.value === 'auto') ks.push('rainRate')
  if (orbitMode.value === 'geo') ks.push('elevation')
  return ks
})
const geoTip = computed(() => orbitMode.value === 'geo'
  ? 'GEO：输入 GEO 轨位，自动换算仰角（仰角只读）'
  : 'NGSO：直接输入仰角（LEO/MEO/HEO 等任意非静止轨道通用）')

// —— 算例表（每行一个完整算例；_id 用 'c' 前缀避免与 StationGrid 内部 'r' 前缀冲突）——
let _cid = 1
function mkCase(over) { return { ...defaultRow(), ...(over || {}), _id: 'c' + (_cid++) } }
const cases = reactive([mkCase()])

// —— 计算结果 ——
const results = shallowRef([])      // 与 cases 同序；主进程返回的纯对象数组（IPC 克隆安全）
const computing = ref(false)
const selectedIdx = ref(0)

const notice = ref('')
let _noticeT = null
function toast(msg) { notice.value = msg; clearTimeout(_noticeT); _noticeT = setTimeout(() => (notice.value = ''), 4000) }

// GEO 定点经度 → 站心仰角（与 core 内部同式）——用于 satLon 便捷列自动回填仰角
function geoElevation(lat, lon, satLon) {
  const D2R = Math.PI / 180
  const cosT = Math.cos(lat * D2R) * Math.cos((satLon - lon) * D2R)
  const den = Math.sqrt(Math.max(1e-10, 1 - cosT * cosT))
  return Math.atan((cosT - 0.15127) / den) / D2R
}
// satLon / 经纬度变化时把 GEO 反算仰角写回 elevation 格（signature 判定：仅这三者变才写，
// 不会覆盖用户在 satLon 保持不变时对仰角格的手动改动；清空 satLon 则保留当前仰角供手填）。
const _elevSig = new Map()
function syncElevations() {
  if (orbitMode.value !== 'geo') return   // 仅 GEO 由轨位反算仰角；NGSO 仰角为用户直接输入
  for (const row of cases) {
    const sl = halfStr(row.satLon), la = halfStr(row.latitude), lo = halfStr(row.longitude)
    const sig = sl + '|' + la + '|' + lo
    if (_elevSig.get(row._id) === sig) continue
    _elevSig.set(row._id, sig)
    const slN = parseFloat(sl), laN = parseFloat(la), loN = parseFloat(lo)
    if (Number.isFinite(slN) && Number.isFinite(laN) && Number.isFinite(loN)) {
      const e = geoElevation(laN, loN, slN)
      if (Number.isFinite(e)) row.elevation = e.toFixed(2)
    }
  }
}
watch(cases, syncElevations, { deep: true, flush: 'post' })

// —— 城市选址 + 经纬度自动填（复用链路预算 link:* 通道）——
const cities = ref([])
async function citySearch(kw) { try { return (api && await api.searchCities(kw)) || [] } catch (e) { return [] } }
async function autoGeo(row) {
  if (!api) return
  const lat = parseFloat(halfStr(row.latitude)), lon = parseFloat(halfStr(row.longitude))
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
  try {
    const r = await api.geoFill(lat, lon)
    if (!r) return
    if (r.altitude != null) row.altitude = String(Math.round(r.altitude))
    if (rainModel.value === 'auto' && r.rainRate != null) row.rainRate = String(Math.round(r.rainRate * 1000) / 1000)
  } catch (e) { /* ignore */ }
}

// —— 计算结果就地回填到行（只读字段，可选中/复制）——
const fmt = (v, d = 2) => (v == null || !Number.isFinite(+v)) ? '—' : (+v).toFixed(d)
function writeResults() {
  const rs = results.value || []
  cases.forEach((row, i) => {
    const r = rs[i]
    for (const k of RESULT_KEYS) {
      if (!r) { row[k] = ''; continue }
      if (r.error) { row[k] = '✕'; continue }
      let v = r[k]
      if (k === 'gtDegradation' && direction.value === 'up') v = null    // G/T衰减为下行专属
      row[k] = (v == null || !Number.isFinite(+v)) ? '—' : (+v).toFixed(2)
    }
  })
}

// —— 计算（批量，一次 IPC）——
async function compute() {
  if (!api) { toast('计算需在桌面客户端中运行'); return }
  if (!cases.length) { toast('请先添加算例'); return }
  computing.value = true
  try {
    const payload = cases.map((row) => buildRainCase(row, { direction: direction.value, orbitMode: orbitMode.value }))
    const out = await api.computeBatch(payload)
    results.value = Array.isArray(out) ? out : []
    writeResults()
    const errs = results.value.filter((r) => r && r.error).length
    toast(errs ? `完成，${errs}/${cases.length} 个算例有问题（见表内 ✕）` : `完成，共 ${cases.length} 个算例`)
  } catch (e) { toast('计算失败：' + (e && e.message ? e.message : e)); results.value = [] }
  finally { computing.value = false }
}
// 方向切换：下行/上行影响 G/T 衰减列，已算过则自动重算
watch(direction, () => { if (results.value.length) compute() })
// 轨道类型切换：GEO→重新由轨位算仰角；已算过则重算（几何变化）
watch(orbitMode, (m) => { if (m === 'geo') syncElevations(); if (results.value.length) compute() })
// 降雨模型切到「自动」：把各行 R0.01 按 ITU-R P.837 重新填上（此后只读）
watch(rainModel, (m) => { if (m === 'auto') cases.forEach((row) => autoGeo(row)) })

// —— 选中算例 → 详情 + 曲线 ——
watch(() => cases.length, (n) => { if (selectedIdx.value >= n) selectedIdx.value = Math.max(0, n - 1) })
const selectedResult = computed(() => (results.value || [])[selectedIdx.value] || null)
const selectedParams = computed(() => (cases[selectedIdx.value] ? buildRainCase(cases[selectedIdx.value], { direction: direction.value, orbitMode: orbitMode.value }) : null))
const selName = (i) => (cases[i] && cases[i].stationName) || ('算例 ' + (i + 1))

// SatMaster 版详情三段
const detail = computed(() => {
  const r = selectedResult.value, row = cases[selectedIdx.value]
  if (!r || r.error || !row) return null
  const f = (v, d = 2, u = '') => (v == null || !Number.isFinite(+v)) ? '—' : ((+v).toFixed(d) + (u ? ' ' + u : ''))
  const down = r.direction === 'down'
  return {
    error: r.error ? (r.message || '计算失败') : '',
    input: [
      ['地球站', row.stationName || '—'],
      ['纬度', f(r.lat, 4, '°')],
      ['经度', f(r.lon, 4, '°')],
      ['海拔', (row.altitude === '' || row.altitude == null) ? '0 m' : (row.altitude + ' m')],
      ['GEO 轨位', r.satLon != null ? f(r.satLon, 2, '°E') : '—（直接指定仰角）'],
      ['频率', f(r.freq, 3, 'GHz')],
      ['极化', POL_LABEL[r.polDisplay] || POL_LABEL[r.pol] || r.pol],
      ['R0.01% 降雨率', f(r.rainRate, 3, 'mm/h') + (r.rainRateAuto ? '（ITU-R P.837 自动）' : '（手动）')],
      ['年可用度', f(r.availability, 3, '%')],
      ['系统噪温（晴空）', down ? f(r.systemNoiseTemp, 0, 'K') : '—（上行不适用）'],
      ['馈线损耗', down ? f(r.feederLoss, 2, 'dB') : '—（上行不适用）'],
      ['链路方向', down ? '下行' : '上行']
    ],
    look: [
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
      ['年不可用时长', f(r.downtimeYear, 2, 'h'), false],
      ['最坏月可用度', f(r.worstMonthAvail, 3, '%'), false],
      ['最坏月不可用时长', f(r.downtimeWorstMonth, 2, 'h'), false]
    ],
    propNote: down
      ? `DND = (雨衰+云衰 ${f(r.precipAtten, 2)} dB) + G/T衰减 ${f(r.gtDegradation, 2)} dB。降雨噪声按 雨+云、T_mr=275K、经馈线 ${f(r.feederLoss, 2)} dB 折算；气体不计入（晴空已含，不构成劣化），闪烁不计入（折射，不辐射噪声）。`
      : '上行不计降雨噪声：G/T 衰减与 DND 为下行专属。'
  }
})

// —— Excel 导出 ——
async function exportExcel() {
  if (!api) { toast('导出需在桌面客户端中运行'); return }
  if (!results.value.length) { toast('请先计算'); return }
  try {
    const payload = {
      defaultName: '雨衰计算结果.xlsx',
      orbitMode: orbitMode.value,
      direction: direction.value,
      rainModel: rainModel.value,
      rows: cases.map(({ _id, ...r }) => ({ ...r })),
      results: JSON.parse(JSON.stringify(results.value))
    }
    const r = await api.exportExcel(payload)
    if (r && r.ok) toast('已导出：' + r.filePath)
    else if (r && !r.canceled) toast('导出失败：' + (r.error || '未知错误'))
  } catch (e) { toast('导出失败：' + (e && e.message ? e.message : e)) }
}

// ========================= 配置持久化（与链路预算同口径，orbitType:'RAIN'）=========================
const STATE_KEY = 'rain/last'
const EXP_KEY = 'rain/expandedFolders'
const configs = ref([])
const activeId = ref(null)
const expandedFolders = ref(new Set())
try { const raw = localStorage.getItem(EXP_KEY); if (raw) expandedFolders.value = new Set(JSON.parse(raw)) } catch (e) { /* ignore */ }
function persistExpanded() { try { localStorage.setItem(EXP_KEY, JSON.stringify([...expandedFolders.value])) } catch (e) { /* ignore */ } }
function toggleFolder(f) { if (expandedFolders.value.has(f.id)) expandedFolders.value.delete(f.id); else expandedFolders.value.add(f.id); persistExpanded() }

function serializeState() {
  // 剥离 _id 与结果字段（结果不入存档，载入后待重算）
  const strip = (r) => { const o = {}; for (const k in r) if (k !== '_id' && !RESULT_KEYS.includes(k)) o[k] = r[k]; return o }
  return {
    orbitType: 'RAIN',
    orbitMode: orbitMode.value, direction: direction.value, rainModel: rainModel.value,
    cases: cases.map(strip),
    selectedIdx: selectedIdx.value
  }
}
function applyState(st) {
  if (!st || typeof st !== 'object') return
  if (st.orbitMode) orbitMode.value = st.orbitMode
  if (st.direction) direction.value = st.direction
  if (st.rainModel) rainModel.value = st.rainModel
  if (Array.isArray(st.cases) && st.cases.length) {
    cases.splice(0, cases.length, ...st.cases.map((r) => {
      const row = { ...defaultRow(), ...r, _id: 'c' + (_cid++) }
      if (String(row.polarization || '').toUpperCase() === 'C') row.polarization = 'RHCP'   // 旧存档圆极化 C → RHCP
      return row
    }))
  }
  if (st.selectedIdx != null) selectedIdx.value = Math.min(st.selectedIdx, Math.max(0, cases.length - 1))
  results.value = []          // 载入配置后清空旧结果，待重新计算
  _elevSig.clear()
}
function blankState() { return { orbitType: 'RAIN', orbitMode: 'geo', direction: 'down', rainModel: 'auto', cases: [defaultRow()], selectedIdx: 0 } }

let _stateT = null
function scheduleSaveState() { clearTimeout(_stateT); _stateT = setTimeout(() => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...serializeState(), activeId: activeId.value })) } catch (e) { /* ignore */ } }, 600) }
watch([orbitMode, direction, rainModel, cases, selectedIdx, activeId], scheduleSaveState, { deep: true })

// 指纹（只取内容，不含 selectedIdx 视图态）→ 脏检测
function fingerprintOf(s) { return stableStringify({ orbitMode: s.orbitMode, direction: s.direction, rainModel: s.rainModel, cases: s.cases }) }
function fingerprint() { return fingerprintOf(serializeState()) }
let activeBaseline = ''
function setBaseline() { activeBaseline = fingerprint() }
function isDirty() { return !!activeId.value && fingerprint() !== activeBaseline }
function activeName() { const c = configs.value.find((x) => x.id === activeId.value); return c ? c.name : '' }

async function loadConfigs() {
  try {
    const all = (window.api && window.api.store ? await window.api.store.listConfigs() : []) || []
    configs.value = all.filter((it) => (it.type === 'folder') ? (it.orbitType === 'RAIN') : (it.state && it.state.orbitType === 'RAIN'))
  } catch (e) { configs.value = [] }
  const ids = new Set(configs.value.filter((c) => c.type === 'folder').map((c) => c.id))
  for (const id of [...expandedFolders.value]) if (!ids.has(id)) expandedFolders.value.delete(id)
}
function uniqueCfgName(base) { const n = new Set(configs.value.map((c) => c.name)); if (!n.has(base)) return base; let i = 2; while (n.has(base + ' ' + i)) i++; return base + ' ' + i }
function defaultCfgName() { return (cases[0] && cases[0].stationName ? cases[0].stationName + ' ' : '') + `雨衰 ${cases.length} 例` }

// 保存 / 更新 / 改名 / 删除
const cfgDlg = reactive({ open: false, name: '' })
function openSaveDlg() { if (!api) { toast('保存需在桌面客户端中运行'); return } cfgDlg.name = defaultCfgName(); cfgDlg.open = true }
async function confirmCfgDlg() {
  const name = (cfgDlg.name || '').trim(); if (!name) { toast('请输入配置名称'); return }
  const item = await window.api.store.saveConfig({ name, state: serializeState() })
  cfgDlg.open = false; await loadConfigs(); if (item && item.id) { activeId.value = item.id; setBaseline() }
  toast('已保存配置：' + name)
}
async function updateConfig() {
  if (!activeId.value) return
  const c = configs.value.find((x) => x.id === activeId.value); if (!c) return
  await window.api.store.saveConfig({ id: c.id, name: c.name, state: serializeState() }); setBaseline(); await loadConfigs(); toast('已保存修改到：' + c.name)
}
async function saveCurrent() { if (!api) { toast('保存需在桌面客户端中运行'); return } if (activeId.value) await updateConfig(); else openSaveDlg() }
const editing = reactive({ id: null, name: '' })
function startRename(c) { editing.id = c.id; editing.name = c.name; nextTick(() => { const el = document.querySelector('.lb-tree-rename'); if (el) { el.focus(); el.select() } }) }
function cancelRename() { editing.id = null }
async function commitRename() {
  const id = editing.id; if (id == null) return
  const c = configs.value.find((x) => x.id === id); const nm = (editing.name || '').trim(); editing.id = null
  if (c && nm && nm !== c.name) { await window.api.store.saveConfig({ id: c.id, name: nm }); await loadConfigs(); toast('已改名：' + nm) }
}
function applyConfig(c) { if (!c) return; activeId.value = c.id; applyState(c.state); setBaseline() }
async function selectConfig(c) { if (!c || c.id === activeId.value) return; if (!(await guardedLeave())) return; applyConfig(c) }
async function removeConfig(id) { if (!api) return; await window.api.store.deleteConfig(id); if (activeId.value === id) { activeId.value = null; activeBaseline = '' } await loadConfigs() }

// 文件夹
const confirmDlg = reactive({ open: false, msg: '' })
let _confirmResolve = null
function askConfirm(msg) { confirmDlg.msg = msg; confirmDlg.open = true; return new Promise((res) => { _confirmResolve = res }) }
function answerConfirm(ok) { confirmDlg.open = false; const r = _confirmResolve; _confirmResolve = null; if (r) r(ok) }
async function addFolder(parentId = null) {
  if (!api) { toast('需在桌面客户端中运行'); return }
  const item = await window.api.store.saveConfig({ type: 'folder', name: uniqueCfgName('新建文件夹'), parentId: parentId || null, orbitType: 'RAIN' })
  if (parentId) expandedFolders.value.add(parentId)
  if (item && item.id) expandedFolders.value.add(item.id)
  persistExpanded(); await loadConfigs(); if (item && item.id) startRename(item)
}
async function addBlankConfig(parentId = null) {
  if (!api) { toast('需在桌面客户端中运行'); return }
  if (!(await guardedLeave())) return
  const state = blankState()
  const item = await window.api.store.saveConfig({ name: uniqueCfgName('新配置'), state, parentId: parentId || null })
  if (parentId) { expandedFolders.value.add(parentId); persistExpanded() }
  await loadConfigs(); if (item && item.id) { activeId.value = item.id; applyState(state); setBaseline() }; toast('已添加空白配置')
}
async function onMove(payload) {
  if (!api || !payload || !payload.dragId) return
  await window.api.store.moveItem({ id: payload.dragId, parentId: payload.parentId, anchorId: payload.anchorId, position: payload.position })
  if (payload.position === 'inside' && payload.parentId) { expandedFolders.value.add(payload.parentId); persistExpanded() }
  await loadConfigs()
}
async function removeFolder(folder) {
  if (!api || !folder) return
  const hasChildren = configs.value.some((c) => c.parentId === folder.id)
  if (hasChildren && !(await askConfirm(`删除文件夹「${folder.name}」及其中全部子项？此操作不可撤销。`))) return
  const removed = (await window.api.store.deleteFolder(folder.id)) || [folder.id]
  const rset = new Set(removed)
  if (activeId.value && rset.has(activeId.value)) { activeId.value = null; activeBaseline = '' }
  for (const id of removed) expandedFolders.value.delete(id)
  persistExpanded(); await loadConfigs(); toast('已删除文件夹：' + folder.name)
}
function onDeleteItem(item) { if (!item) return; if (item.type === 'folder') removeFolder(item); else removeConfig(item.id) }

// 右键菜单
const ctxMenu = reactive({ open: false, x: 0, y: 0, configId: null })
const ctxConfig = computed(() => (ctxMenu.configId ? configs.value.find((c) => c.id === ctxMenu.configId) : null))
const ctxIsFolder = computed(() => !!(ctxConfig.value && ctxConfig.value.type === 'folder'))
function openCtx(e, c) { e.preventDefault(); ctxMenu.configId = c ? c.id : null; ctxMenu.x = Math.min(e.clientX, window.innerWidth - 180); ctxMenu.y = Math.min(e.clientY, window.innerHeight - 200); ctxMenu.open = true }
function ctxDo(fn) { ctxMenu.open = false; fn() }

// 离开已改动配置前三选一
const leaveDlg = reactive({ open: false, name: '' })
let _leaveResolve = null
function askLeave(name) { return new Promise((res) => { leaveDlg.name = name; leaveDlg.open = true; _leaveResolve = res }) }
function leaveAnswer(ans) { leaveDlg.open = false; const r = _leaveResolve; _leaveResolve = null; if (r) r(ans) }
async function guardedLeave() {
  if (!isDirty()) return true
  const ans = await askLeave(activeName())
  if (ans === 'cancel') return false
  if (ans === 'save') await updateConfig()
  return true
}

onMounted(async () => {
  try { cities.value = (api && await api.cities()) || [] } catch (e) { cities.value = [] }
  await loadConfigs()
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (raw) {
      const st = JSON.parse(raw)
      const c = st.activeId && configs.value.find((x) => x.id === st.activeId)
      if (c) { activeId.value = c.id; applyState(c.state); setBaseline(); applyState(st) }
      else applyState(st)   // 无归属配置：仍恢复上次内容（不聚焦任何配置）
    }
  } catch (e) { /* ignore */ }
  syncElevations()
  api?.onCloseRequested?.(async () => { if (await guardedLeave()) api.confirmClose() })
})
</script>

<template>
  <div class="lb-shell">
    <div class="lb-topbar">
      <span class="lb-brand">雨衰计算</span>
      <span class="lb-sub">ITU-R 传播模型 · 通用于各类卫星（仰角驱动）</span>
      <span class="lb-flex"></span>
      <span v-if="notice" class="lb-notice">{{ notice }}</span>
      <span v-if="!api" class="lb-warn">需在桌面客户端中运行</span>
    </div>

    <div class="lb-body">
      <!-- ① 配置列表 -->
      <aside class="lb-col lb-configs">
        <div class="lb-col-hd">
          <span class="lb-cfg-hd-t">配置列表</span>
          <span class="lb-cfg-acts">
            <button class="lb-mini" :title="activeId ? '保存修改到当前配置' : '保存为新配置'" :disabled="!api" @click="saveCurrent">保存</button>
            <button class="lb-mini lb-mini-ico" title="新建文件夹" :disabled="!api" @click="addFolder(null)"><Icon name="folder-plus" :size="13" /></button>
            <button class="lb-mini lb-mini-ico" title="添加空白配置" :disabled="!api" @click="addBlankConfig(null)"><Icon name="plus" :size="13" /></button>
          </span>
        </div>
        <div class="lb-col-bd" @contextmenu="openCtx($event, null)">
          <ConfigTree
            :items="configs" :active-id="activeId" :editing-id="editing.id" :editing-name="editing.name" :expanded="expandedFolders"
            @select="selectConfig" @toggle="toggleFolder" @delete="onDeleteItem" @move="onMove"
            @add-folder="addFolder" @add-config="addBlankConfig" @context="openCtx"
            @rename-start="startRename" @rename-input="editing.name = $event" @rename-commit="commitRename" @rename-cancel="cancelRename"
          />
        </div>
      </aside>

      <!-- ② Excel 批量算例 -->
      <section class="lb-col lb-build">
        <div class="rain-toolbar">
          <div class="rain-seg-grp">
            <span class="rain-seg-lb">轨道类型</span>
            <div class="rain-seg">
              <button :class="{ on: orbitMode === 'geo' }" title="静止轨道：输入 GEO 轨位，自动换算仰角" @click="orbitMode = 'geo'">GEO</button>
              <button :class="{ on: orbitMode === 'ngso' }" title="非静止轨道：直接输入仰角（LEO/MEO/HEO 通用）" @click="orbitMode = 'ngso'">NGSO</button>
            </div>
          </div>
          <div class="rain-seg-grp">
            <span class="rain-seg-lb">链路方向</span>
            <div class="rain-seg">
              <button :class="{ on: direction === 'down' }" @click="direction = 'down'">下行</button>
              <button :class="{ on: direction === 'up' }" @click="direction = 'up'">上行</button>
            </div>
          </div>
          <div class="rain-seg-grp">
            <span class="rain-seg-lb">降雨模型</span>
            <div class="rain-seg">
              <button :class="{ on: rainModel === 'auto' }" title="经纬度→ITU-R P.837 自动取 R0.01" @click="rainModel = 'auto'">ITU-R 自动</button>
              <button :class="{ on: rainModel === 'manual' }" title="R0.01 由自己手填" @click="rainModel = 'manual'">手动 (mm/h)</button>
            </div>
          </div>
          <span class="rain-tip">{{ geoTip }}</span>
        </div>

        <div class="rain-grid">
          <StationGrid
            :stations="cases" :fields="fields" :cities="cities" :city-search="citySearch" :auto-geo="autoGeo"
            :readonly-keys="readonlyKeys" label="算例"
          />
        </div>

        <div class="lb-foot">
          <span class="rain-foot-desc">每行一个独立算例 · 计算结果（雨衰 / G/T衰减 / 雨致XPD / 合计）就地进表</span>
          <span class="lb-flex"></span>
          <button class="lb-calc" :disabled="computing || !cases.length" @click="compute">
            {{ computing ? '计算中…' : ('计算（' + cases.length + ' 个算例）') }}
          </button>
        </div>
      </section>

      <!-- ③ 单算例细致分析 -->
      <section class="lb-col lb-result">
        <div class="lb-col-hd">
          <span class="lb-cfg-hd-t">单算例分析</span>
          <span class="lb-flex"></span>
          <select v-model.number="selectedIdx" class="rain-sel" title="选择要细致分析的算例">
            <option v-for="(c, i) in cases" :key="c._id" :value="i">{{ (i + 1) + ' · ' + selName(i) }}</option>
          </select>
          <button class="lb-mini" :disabled="!results.length" title="导出批量结果 Excel" @click="exportExcel">导出 Excel</button>
        </div>
        <div class="lb-result-bd">
          <template v-if="!results.length">
            <div class="rain-ph">点「计算」后，这里显示所选算例的雨衰函数曲线与 SatMaster 版详细结果。</div>
          </template>
          <template v-else-if="selectedResult && selectedResult.error">
            <div class="rain-err">✕ {{ selectedResult.message || '该算例无法计算' }}</div>
          </template>
          <template v-else-if="detail">
            <!-- 交互式坐标系（在详情上方）-->
            <RainPlot :params="selectedParams" :result="selectedResult" :station="selName(selectedIdx)" />

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
                <div class="rd-hd">传播结果</div>
                <div class="rd-row" :class="{ em: row[2] }" v-for="row in detail.prop" :key="row[0]"><span class="rd-k">{{ row[0] }}</span><span class="rd-v">{{ row[1] }}</span></div>
                <div v-if="detail.propNote" class="rd-note">{{ detail.propNote }}</div>
              </div>
            </div>
          </template>
        </div>
      </section>
    </div>

    <!-- 保存为新配置 -->
    <div v-if="cfgDlg.open" class="lb-mask" @click="cfgDlg.open = false">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">保存为新配置</div>
        <input v-model="cfgDlg.name" class="lb-dlg-inp" placeholder="配置名称" @keyup.enter="confirmCfgDlg" />
        <div class="lb-dlg-acts"><button class="lb-mini" @click="cfgDlg.open = false">取消</button><button class="lb-mini pri" @click="confirmCfgDlg">保存</button></div>
      </div>
    </div>
    <!-- 离开已改动配置 -->
    <div v-if="leaveDlg.open" class="lb-mask">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">「{{ leaveDlg.name }}」有未保存的改动</div>
        <div class="lb-dlg-msg">是否将改动保存回该配置？</div>
        <div class="lb-dlg-acts"><button class="lb-mini" @click="leaveAnswer('cancel')">取消</button><button class="lb-mini" @click="leaveAnswer('discard')">不保存</button><button class="lb-mini pri" @click="leaveAnswer('save')">保存</button></div>
      </div>
    </div>
    <!-- 通用确认 -->
    <div v-if="confirmDlg.open" class="lb-mask">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-msg">{{ confirmDlg.msg }}</div>
        <div class="lb-dlg-acts"><button class="lb-mini" @click="answerConfirm(false)">取消</button><button class="lb-mini pri" @click="answerConfirm(true)">确定</button></div>
      </div>
    </div>
    <!-- 右键菜单 -->
    <div v-if="ctxMenu.open" class="lb-ctx-mask" @click="ctxMenu.open = false" @contextmenu.prevent="ctxMenu.open = false">
      <div class="lb-ctx" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }" @click.stop>
        <button @click="ctxDo(() => addBlankConfig(ctxIsFolder ? ctxMenu.configId : null))">添加空白配置</button>
        <button @click="ctxDo(() => addFolder(ctxIsFolder ? ctxMenu.configId : null))">新建文件夹</button>
        <template v-if="ctxConfig">
          <div class="lb-ctx-sep"></div>
          <button @click="ctxDo(() => startRename(ctxConfig))">重命名</button>
          <button class="del" @click="ctxDo(() => onDeleteItem(ctxConfig))">删除</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 浅色精密仪器风（对齐链路预算视觉口径）：小圆角、克制配色、11/12/13 字号 */
.lb-shell {
  --r-ctl: 2px; --r-box: 3px; --r-modal: 4px;
  --ok: #4a7a62; --warn: #8a7038; --danger: #9c5751;
  display: flex; flex-direction: column; height: 100vh; background: var(--bg); color: var(--text);
  font-size: 13px; overflow: hidden;
}
:root[data-theme="dark"] .lb-shell { --ok: #6f9d85; --warn: #b59a5e; --danger: #c08079; }

.lb-topbar { flex: none; display: flex; align-items: baseline; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--surface); }
.lb-brand { font-family: Georgia, 'Times New Roman', serif; font-size: 16px; font-weight: 600; }
.lb-sub { font-size: 11px; color: var(--text-faint); }
.lb-flex { flex: 1 1 auto; }
.lb-notice { font-size: 12px; color: var(--ok); }
.lb-warn { font-size: 12px; color: var(--danger); }

.lb-body { flex: 1 1 auto; display: flex; min-height: 0; }
.lb-col { display: flex; flex-direction: column; min-height: 0; }
.lb-configs { width: 220px; flex: none; border-right: 1px solid var(--border); background: var(--surface); }
.lb-build { flex: 1 1 auto; min-width: 0; overflow: hidden; }
.lb-result { width: 468px; flex: none; border-left: 1px solid var(--border); background: var(--surface); }

.lb-col-hd { flex: none; display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted); }
.lb-cfg-hd-t { font-weight: 600; }
.lb-cfg-acts { display: inline-flex; gap: 4px; margin-left: auto; }
.lb-col-bd { flex: 1 1 auto; overflow: auto; padding: 6px; }

.lb-mini { font: inherit; font-size: 12px; padding: 3px 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); border-radius: var(--r-ctl); cursor: pointer; }
.lb-mini:hover:not(:disabled) { border-color: var(--accent); }
.lb-mini:disabled { opacity: .5; cursor: default; }
.lb-mini.pri { background: var(--accent); color: #fff; border-color: var(--accent); }
.lb-mini-ico { display: inline-flex; align-items: center; padding: 3px 6px; }
.rain-sel { font: inherit; font-size: 12px; padding: 3px 6px; border: 1px solid var(--border); border-radius: var(--r-ctl); background: var(--surface-2); color: var(--text); max-width: 220px; }

/* 工具栏 */
/* 窄栏下按整组换行、组内文字不折断（避免「链路方/向」「ITU-R 自/动」式中途断行） */
.rain-toolbar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
.rain-seg-grp { flex: none; display: inline-flex; align-items: center; gap: 7px; }
.rain-seg-lb { flex: none; white-space: nowrap; font-size: 11px; letter-spacing: 1px; color: var(--text-muted); text-transform: uppercase; }
.rain-seg { flex: none; display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-ctl); overflow: hidden; }
.rain-seg button { flex: none; white-space: nowrap; font: inherit; font-size: 12px; padding: 4px 12px; border: 0; background: var(--surface-2); color: var(--text-muted); cursor: pointer; }
.rain-seg button + button { border-left: 1px solid var(--border); }
.rain-seg button.on { color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); background: var(--surface); }
.rain-tip { flex: 1 1 200px; min-width: 0; font-size: 11px; color: var(--text-faint); }

.rain-grid { flex: 1 1 auto; min-height: 0; min-width: 0; overflow: hidden; display: flex; padding: 8px; }
.rain-grid > * { flex: 1 1 auto; min-height: 0; min-width: 0; }

.lb-foot { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.rain-foot-desc { font-size: 11px; color: var(--text-faint); }
.lb-calc { flex: none; white-space: nowrap; font: inherit; font-size: 13px; font-weight: 600; padding: 6px 18px; border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: var(--r-ctl); cursor: pointer; }
.rain-foot-desc { min-width: 0; }
.lb-calc:disabled { opacity: .55; cursor: default; }

/* 结果栏 */
.lb-result-bd { flex: 1 1 auto; overflow: auto; padding: 10px; }
.rain-ph { color: var(--text-faint); font-size: 12px; line-height: 1.7; padding: 20px 8px; }
.rain-err { color: var(--danger); font-size: 13px; padding: 16px 8px; }

.rain-detail { margin-top: 12px; }
.rd-sec { margin-bottom: 12px; border: 1px solid var(--border); border-radius: var(--r-box); overflow: hidden; }
.rd-hd { padding: 5px 10px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted); background: var(--surface-2); border-bottom: 1px solid var(--border); font-weight: 600; }
.rd-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 4px 10px; font-size: 12px; }
.rd-row + .rd-row { border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.rd-k { color: var(--text-muted); flex: 0 1 auto; }
.rd-v { font-family: var(--font-mono); color: var(--text); text-align: right; white-space: nowrap; }
.rd-row.em { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.rd-row.em .rd-k { color: var(--text); font-weight: 600; }
.rd-row.em .rd-v { color: color-mix(in srgb, var(--accent) 82%, var(--text)); font-weight: 600; }
.rd-note { padding: 6px 10px 7px; font-size: 11px; line-height: 1.6; color: var(--text-faint); border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent); background: color-mix(in srgb, var(--surface-2) 45%, transparent); }

/* 弹窗 / 菜单 */
.lb-mask { position: fixed; inset: 0; background: rgba(0,0,0,.28); display: flex; align-items: center; justify-content: center; z-index: 50; }
.lb-dlg { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-modal); padding: 16px; min-width: 300px; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
.lb-dlg-hd { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
.lb-dlg-msg { font-size: 12px; color: var(--text-muted); margin-bottom: 12px; line-height: 1.6; }
.lb-dlg-inp { width: 100%; box-sizing: border-box; font: inherit; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--r-ctl); background: var(--bg); color: var(--text); margin-bottom: 12px; }
.lb-dlg-acts { display: flex; justify-content: flex-end; gap: 8px; }
.lb-ctx-mask { position: fixed; inset: 0; z-index: 60; }
.lb-ctx { position: fixed; min-width: 160px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-box); box-shadow: 0 8px 28px rgba(0,0,0,.24); padding: 4px; display: flex; flex-direction: column; }
.lb-ctx button { font: inherit; font-size: 12px; text-align: left; padding: 6px 10px; border: 0; background: transparent; color: var(--text); border-radius: var(--r-ctl); cursor: pointer; }
.lb-ctx button:hover { background: var(--surface-2); }
.lb-ctx button.del:hover { color: var(--danger); }
.lb-ctx-sep { height: 1px; background: var(--border); margin: 4px 0; }
</style>
