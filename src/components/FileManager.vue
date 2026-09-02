<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { fileBridge, bumpLibrary, bumpCustomSats } from '../stores/fileBridge'
import { readCustomConstellationSummary, customConstellationsToOmmRecords, renameCustomConstellation } from '../viz/constellation/useCustomConstellations.js'
import { parseGxt, metaFromName } from '../viz/gxt/parse.js'
import { parseKmlBeams } from '../viz/kml/parse.js'
import { loadSatNodes } from '../shared/freqPlanSats.js'
import { fmtGeoSlot } from '../shared/orbitClass.js'
import { serializeGxt } from '../viz/gxt/serialize.js'
import { serializeKml } from '../viz/kml/serialize.js'
import { grdToStkAzEl } from '../viz/grd/stkPattern.js'
import { grdToAcp4, grdToEutelsat } from '../viz/grd/patFormats.js'
import { repackGrdCommonGrid } from '../viz/grd/synth.js'
import { displaySatName } from '../viz/satName.js'
import { logMsg } from '../stores/log'
import Icon from './Icon.vue'
import ExcelGrid from './ExcelGrid.vue'
import MiniSendDialog from './MiniSendDialog.vue'
import SceneLibEditor from './SceneLibEditor.vue'
import { fpMiniItem } from '../shared/fpMiniExport.js'
import { useGridSelect } from '../viz/grd/useGridSelect.js'
import { exportSheets, importWorkbook } from '../shared/gridXlsx.js'
import { MODCOD_COLS, modcodGridCols, cellText as mcCellText, cellTip as mcCellTip, setCell, emptyRow,
  modcodSheets, modcodSheetNames, modcodFileName, standardsFromSheets, rejectedModulations } from '../shared/modcodTable.js'
import { MOD_FAMILIES, ordersOf, isValidOrderFor, composeModulation, parseModulation, modFactorOf } from '../shared/carrierRate.js'

const emit = defineEmits(['close'])
const api = typeof window !== 'undefined' ? window.api : null
const tab = ref('omm')
const msg = ref('')
// 面板内瞬时提示 + 落底部日志窗格（两者共用同一份文案，覆盖本文件全部 30 处导入/导出/删除反馈，无需逐处补记）
function flash(t) { msg.value = t; logMsg(`文件管理：${t}`, /失败/.test(t) ? 'warn' : 'info'); setTimeout(() => { if (msg.value === t) msg.value = '' }, 4000) }

// 应用内确认弹窗（替代原生 confirm）：Electron 的原生 confirm/alert 关闭后会打断渲染进程焦点，
// 导致之后输入框点击聚焦失灵（最小化再恢复才好）。改用 Promise 化的内嵌弹窗，彻底规避。
const confirmMsg = ref('')
let _confirmResolve = null
function ask(message) { confirmMsg.value = message; return new Promise((res) => { _confirmResolve = res }) }
function answerConfirm(ok) { confirmMsg.value = ''; const r = _confirmResolve; _confirmResolve = null; if (r) r(ok) }

// latin1 字符串 → 原始字节（保真导出 GRD/GXT 二进制原文）
const toBytes = (s) => Uint8Array.from(String(s == null ? '' : s), (c) => c.charCodeAt(0) & 0xff)
function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso); if (isNaN(d)) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ===================== ① 星历 / OMM ===================== */
const OMM_LABELS = {
  starlink: 'Starlink', oneweb: 'OneWeb', kuiper: 'Kuiper', gps: 'GPS', beidou: '北斗',
  galileo: 'Galileo', qianfan: '千帆星座', guowang: '中国星网', geo: 'GEO 静止轨道',
  glonass: 'GLONASS', o3b: 'O3b', iridium: '铱星 Iridium', globalstar: 'Globalstar',
  stations: '空间站', planet: 'Planet', spire: 'Spire', active: '全部活跃卫星'
}
// 六种官方格式的显示名（解析/序列化在主进程 core/utils/ommFormats.js，这里只要标签）
const EPH_FMT = { 'omm-csv': 'OMM CSV', 'omm-json': 'OMM JSON', 'omm-kvn': 'OMM KVN', 'omm-xml': 'OMM XML', tle: 'TLE', '3le': '3LE' }
const ommRows = ref([])
const ommBusy = ref('')
async function loadOmm() { try { ommRows.value = api?.omm?.list ? await api.omm.list() : [] } catch { ommRows.value = [] } }
// 该组是否有可用数据（用户缓存或内置快照）；兼容旧主进程仅返回 exists 的情形。
const ommAvail = (row) => row.source ? row.source !== 'none' : !!row.exists
// 状态徽标：已缓存（用户联网下载）/ 内置（软件自带兜底快照）/ 未下载。
const ommStatus = (row) => (row.source === 'cache' || (!row.source && row.exists)) ? '已缓存' : (row.source === 'bundled' ? '内置' : '未下载')
async function importOmm(row) {
  if (!api?.omm?.import) return
  ommBusy.value = row.key
  try {
    const r = await api.omm.import(row.key)
    if (r && r.canceled) return
    if (r && r.ok) { flash(`已替换「${OMM_LABELS[row.key] || row.key}」：${r.count} 颗卫星`); await loadOmm() }
    else flash('导入失败：' + ((r && r.error) || '未知错误'))
  } finally { ommBusy.value = '' }
}
async function exportOmm(row) {
  if (!api?.omm?.export) return
  const r = await api.omm.export(row.key, 'omm-csv')
  if (r && r.canceled) return
  if (r && r.ok) flash('已导出：' + r.filePath)
  else flash('导出失败：' + ((r && r.error) || '未知错误'))
}

/* ---- 自定义卫星（逐条配置：各自导入/导出/删除，无全局合并）----
   两类条目、与「星座地图 3D」星座列表同源：
   ① 自建星座（Walker，localStorage）——历元=场景历元；只读镜像(在「星座3D」增删)，可逐座导出星历；
   ② 导入组（每个导入的 OMM/TLE 文件 = 一组，主进程 custom.json）——历元=文件内；可逐组导出/删除。
   两类都并入链路预算搜索池；但地图「自定义卫星」分组只含 ②（导入库），① 在星座列表下方「自定义星座」
   区独立显隐（该分组只读 omm.customCsv，自建星座不在其中）。 */
const customGroups = ref([])        // 导入组 [{ id, name, importedAt, format, count, sats:[...] }]
const customConsts = ref([])        // 自建星座概览 [{ id, name, incl, count, color }]
const customBusy = ref(false)
const hasCustomAny = computed(() => customGroups.value.length > 0 || customConsts.value.length > 0)
// r.error = 库文件与备份都解析不出来（此时组列表为空，但那不是「库是空的」，主进程也会拒绝写入）
async function loadCustomGroups() { try { const r = api?.omm?.customList ? await api.omm.customList() : null; customGroups.value = (r && r.groups) || []; if (r && r.error) flash(r.error) } catch { customGroups.value = [] } }
function loadCustomConsts() { try { customConsts.value = readCustomConstellationSummary() } catch { customConsts.value = [] } }
// 汇总导入结果 → 一句反馈
function summarizeImport(r) {
  const parts = []
  if (r.groups) parts.push(`${r.groups} 组 / ${r.sats} 颗`)
  if (r.replaced) parts.push(`替换 ${r.replaced}`)
  if (r.invalid) parts.push(`无效 ${r.invalid}`)
  let msg = parts.length ? parts.join(' · ') : '无变化'
  const errs = (r.errors || []).filter(Boolean)
  const warns = (r.warnings || []).filter(Boolean)
  if (warns.length) msg += `；${warns.length} 条告警`
  if (errs.length) msg += `；${errs.length} 条失败：${errs[0]}${errs.length > 1 ? ' …' : ''}`
  return msg
}
async function importCustom() {
  if (!api?.omm?.customImport) return
  customBusy.value = true
  try {
    const r = await api.omm.customImport()
    if (r && r.canceled) return
    if (r && r.ok) { flash('导入星历：' + summarizeImport(r)); await loadCustomGroups(); bumpCustomSats() }
    else flash('导入失败：' + ((r && r.error) || '未知错误'))
  } finally { customBusy.value = false }
}
async function removeCustomGroup(g) {
  if (!(await ask(`删除导入组「${g.name}」（${g.count} 颗）？`))) return
  await api.omm.customRemove(g.id); await loadCustomGroups(); bumpCustomSats()
  flash(`已删除导入组「${g.name}」`)
}
// 逐组导出（导入组：文件历元）
async function exportGroup(g) {
  if (!api?.omm?.customExportGroup) return
  const r = await api.omm.customExportGroup(g.id, g.name, g.format || 'omm-csv')
  if (r && r.canceled) return
  if (r && r.ok) flash('已导出：' + r.filePath)
  else flash('导出失败：' + ((r && r.error) || '未知错误'))
}
// 逐座导出（自建星座：场景历元，展开为 OMM 记录传给主进程序列化保存）
async function exportConstellation(c) {
  if (!api?.omm?.exportRecords) return
  let recs = []
  try { recs = customConstellationsToOmmRecords(c.id) } catch { recs = [] }
  if (!recs.length) { flash('该星座无可导出的卫星'); return }
  const r = await api.omm.exportRecords(recs, c.name, 'omm-csv')
  if (r && r.canceled) return
  if (r && r.ok) flash('已导出：' + r.filePath)
  else flash('导出失败：' + ((r && r.error) || '未知错误'))
}
const fmtGroupMeta = (g) => `${g.count} 颗 · ${EPH_FMT[g.format] || 'OMM'} · ${fmtTime(g.importedAt)}`

// —— 逐条改名（自建星座 + 导入组，点名称/「改名」进入编辑，✓/回车提交，Esc 取消）——
const custEdit = ref('')   // 正在改名的行键：'k'+星座id / 'g'+组id
const custVal = ref('')
const custInput = ref(null)
const setCustInput = (el) => { custInput.value = el }
async function startRenameCust(key, name) {
  custEdit.value = key; custVal.value = name
  await nextTick(); if (custInput.value && custInput.value.focus) { custInput.value.focus(); custInput.value.select && custInput.value.select() }
}
function cancelRenameCust() { custEdit.value = '' }
async function commitRenameCust() {
  const key = custEdit.value, name = custVal.value.trim()
  if (!key) return
  if (!name) { flash('名称不能为空'); return }
  if (key[0] === 'k') {          // 自建星座：优先走活实例（失效缓存+重渲染），否则回退改 localStorage
    const id = key.slice(1)
    const cc = fileBridge.customConst
    if (cc && cc.update) cc.update(id, { name }); else renameCustomConstellation(id, name)
    loadCustomConsts(); bumpCustomSats()
  } else if (key[0] === 'g') {   // 导入组
    const id = key.slice(1)
    const r = await api.omm.customRename(id, name)
    if (!(r && r.ok)) { flash('改名失败：' + ((r && r.error) || '未知')); return }
    await loadCustomGroups(); bumpCustomSats()
  }
  custEdit.value = ''
  flash('已改名为「' + name + '」')
}

/* ===================== ② GRD（镜像 3D 页活树）===================== */
const grdApi = computed(() => fileBridge.grd)
const grdSats = computed(() => (fileBridge.grd ? fileBridge.grd.sats.value : []))
// GRD 树行经度：实时关联星跟随星历实时（与覆盖分析/编辑弹窗一致），固定星用其静态值。
function grdLonText(sat) {
  void fileBridge.liveTick   // 依赖实时 tick → 星动时本行重渲染
  const a = fileBridge.grdActions
  const p = a && a.livePos && a.livePos(sat.folder)
  const lon = (p && Number.isFinite(p.lon)) ? p.lon : (sat.lon != null ? Number(sat.lon) : null)
  return lon != null ? fmtGeoSlot(lon) + ' · ' : ''   // °E/°W 折算（西经不再写成负°E）
}
// 改星后让 3D 场景里的卫星图标/仰角线同步刷新（3D 页注入的 redrawSats）
function grdRedraw() { const a = fileBridge.grdActions; if (a && a.redraw) a.redraw() }
const grdKeyOf = (sat, a) => `${sat.folder}|${a.name}`
async function importGrd(sat) { if (fileBridge.grd) await fileBridge.grd.importGrd(sat) }
async function removeGrdAnt(sat, a) { if (fileBridge.grd && await ask(`删除天线「${a.name}」？`)) { fileBridge.grd.removeAntenna(sat.folder, a.name); grdRedraw() } }
async function removeGrdSat(sat) { if (fileBridge.grd && await ask(`删除卫星「${sat.satName}」及其全部天线？`)) { fileBridge.grd.removeSatellite(sat.folder); grdRedraw() } }

// —— 添加 / 编辑卫星：直接复用覆盖分析「原版」卫星弹窗（含定位方式 / 星座关联，仅隐藏图标·字号·仰角线·颜色
//    等可视化项）。弹窗浮在文件管理器之上、与之共存（不关闭文件管理）。两处完全同一弹窗，行为一致。
function openAddGrdSat() {
  const a = fileBridge.grdActions
  if (!a || !a.openAddSat) { flash('请在「星座地图 3D」页操作'); return }
  a.openAddSat()
}
function openEditGrdSat(sat) {
  const a = fileBridge.grdActions
  if (!a || !a.openEditSat) { flash('请在「星座地图 3D」页操作'); return }
  a.openEditSat(sat.folder)
}

/* ===================== ②b 频率计划（挂在卫星下，与 GRD 天线平级）=====================
   宿主卫星树与 GRD 天线同源：3D 页在场时用活树（拿得到刚加的星），否则退到 localStorage 快照，
   使本页不依赖「必须先去过 3D 页」。编辑一律在独立窗口进行——这里只做文件级的增删改查。 */
const fpRows = ref([])
const fpBusy = ref(false)
async function loadFreqPlans() {
  try { fpRows.value = api?.freqPlan?.list ? await api.freqPlan.list() : [] } catch { fpRows.value = [] }
}
// 卫星清单：活树优先（含尚未持久化的新星），否则读快照
const fpSats = computed(() => {
  const live = fileBridge.grd ? fileBridge.grd.sats.value : null
  if (live && live.length) return live.map((s) => ({ folder: s.folder, satName: s.satName, lon: s.lon }))
  return loadSatNodes()
})
// 卫星 → 其下的频率计划；宿主已不在树中的单列，避免条目从界面上凭空消失
const fpGroups = computed(() => {
  const by = new Map()
  for (const e of fpRows.value) {
    const k = e.satFolder || ''
    if (!by.has(k)) by.set(k, [])
    by.get(k).push(e)
  }
  const out = fpSats.value.map((s) => ({ folder: s.folder, label: fpSatLabel(s), plans: by.get(s.folder) || [], sat: s }))
  for (const s of fpSats.value) by.delete(s.folder)
  for (const [k, plans] of by) out.push({ folder: k, label: k ? `（卫星已不在树中：${plans[0].satName || k}）` : '（未归属卫星）', plans, orphan: true })
  return out
})
function fpSatLabel(s) {
  const lon = Number(s.lon)
  return Number.isFinite(lon) && lon !== 0 ? `${s.satName}（${fmtGeoSlot(lon)}）` : s.satName   // 与 freqPlanSats.satLabel 同式（°E/°W）
}
function fmtFpMeta(e) {
  const parts = [e.band || '—', `${e.transponderCount} 转发器`]
  if (e.beamCount) parts.push(`${e.beamCount} 波束`)
  parts.push(fmtTime(e.updatedAt))
  return parts.join(' · ')
}
function openFreqPlanWin(planId) { api?.freqPlan?.open?.(planId || '') }
async function addFreqPlan(g) {
  if (!api?.freqPlan) return
  fpBusy.value = true
  try {
    const r = await api.freqPlan.save({ name: `${g.sat?.satName || '卫星'} 频率计划`, satFolder: g.folder, satName: g.sat?.satName || '', band: 'Ku', channels: [], los: [], beams: [] })
    if (r?.ok) { await loadFreqPlans(); openFreqPlanWin(r.id); flash('已新建频率计划，已在编辑窗口打开') }
  } finally { fpBusy.value = false }
}
async function removeFreqPlan(e) {
  if (!(await ask(`删除频率计划「${e.name}」？此操作不可撤销。`))) return
  await api.freqPlan.remove(e.id)
  await loadFreqPlans()
  flash(`已删除「${e.name}」`)
}
async function exportFreqPlan(e) {
  const p = await api.freqPlan.get(e.id)
  if (!p) { flash('计划不存在'); return }
  const r = await api.freqPlan.exportFile('json', JSON.stringify(p, null, 2), p.name || '频率计划')
  if (r?.canceled) return
  flash(r?.ok ? '已导出：' + r.filePath : '导出失败：' + (r?.error || '未知错误'))
}
async function importFreqPlanJson() {
  const r = await api?.freqPlan?.importJson?.()
  if (!r || r.canceled) return
  await loadFreqPlans()
  flash(`导入 ${r.added} 份${r.replaced ? `，覆盖 ${r.replaced} 份` : ''}${r.errors?.length ? `，${r.errors.length} 份失败` : ''}`)
}
// —— 发送到小程序（频率计划）——
// 送出去的是【导出那一刻的版式】：小程序不重算 layout（那套口径 2026-07~08 连改三轮，照抄一份
// 必漂，见 shared/fpMiniExport.js 文件头），故平台把绘制指令连同解析结果一起打包。
// 计划改了要重发——这是「只能从仿真平台导入」这个定位下的应有代价。
const fpMiniOpen = ref(false)
const fpMiniPack = ref(null)     // { name, items }
const fpMiniConfigured = ref(false)
// 刻度是整份计划的属性（工作台那一个下拉，存 localStorage，与频率计划窗口同 origin）。
// 小程序侧【不给单位切换】——再给一个下拉就是第二个真相源，故导出时定死这一把尺子。
function freqPlanUnit() {
  try { return JSON.parse(localStorage.getItem('freqplan/opt') || '{}').unit || 'MHz' } catch { return 'MHz' }
}
async function sendFreqPlanToMini(e) {
  if (!api?.freqPlan) return
  fpBusy.value = true
  try {
    const p = await api.freqPlan.get(e.id)
    if (!p) { flash('计划不存在'); return }
    fpMiniPack.value = { name: p.name || e.name || '频率计划', items: [fpMiniItem(p, { unit: freqPlanUnit() })] }
    fpMiniOpen.value = true
  } catch (err) {
    flash('准备失败：' + ((err && err.message) || err))
  } finally { fpBusy.value = false }
}

const fpEdit = ref('')
const fpVal = ref('')
function startRenameFp(e) { fpEdit.value = e.id; fpVal.value = e.name }
async function commitRenameFp(e) {
  const name = fpVal.value.trim()
  if (!name) { flash('名称不能为空'); return }
  await api.freqPlan.rename(e.id, name)
  fpEdit.value = ''
  await loadFreqPlans()
  flash('已改名为「' + name + '」')
}
function cancelRenameFp() { fpEdit.value = '' }

// —— 天线重命名（点名称或「改名」进入编辑，✓/回车提交）——
const grdAntEdit = ref('')   // 正在重命名的天线 key（folder|name）
const grdAntVal = ref('')
function startRenameGrdAnt(sat, a) { grdAntEdit.value = grdKeyOf(sat, a); grdAntVal.value = a.name }
function commitRenameGrdAnt(sat, a) {
  if (grdAntEdit.value === '') return
  if (fileBridge.grd.renameAntenna(sat.folder, a.name, grdAntVal.value) === false) { flash('天线名为空或与同星其他天线重名'); return }
  grdAntEdit.value = ''; grdRedraw()
}
function cancelRenameGrdAnt() { grdAntEdit.value = '' }
// ── 方向图导出：GRASP GRD / STK / ACP4 / Eutelsat 四选一 ──
// 四条路都从落盘的原始 GRD 文本出发（外部格式在导入时已转成 GRASP，见 useGrdCoverage.importGrd）。
// 菜单用 position:fixed 落点 —— .tnode 有 overflow:hidden，行内绝对定位会被裁掉。
const expMenu = ref({ key: '', x: 0, y: 0, ant: null })
const EXP_FMTS = [
  { id: 'grd', label: 'GRASP GRD', ext: 'grd' },
  { id: 'stk', label: 'STK 外部方向图', ext: 'txt' },
  { id: 'acp4', label: 'ACP4', ext: 'pat' },
  { id: 'eutelsat', label: 'Eutelsat', ext: 'pat' }
]
function toggleExpMenu(ev, sat, a) {
  const k = grdKeyOf(sat, a)
  if (expMenu.value.key === k) { expMenu.value = { key: '', x: 0, y: 0, ant: null }; return }
  const r = ev.currentTarget.getBoundingClientRect()
  const h = EXP_FMTS.length * 26 + 10
  expMenu.value = { key: k, x: r.right, y: r.bottom + 4 + h > window.innerHeight ? r.top - 4 - h : r.bottom + 4, ant: a }
}
async function saveOut(text, defaultName, filters, msg) {
  const save = await api.exportFile({ defaultName, data: toBytes(text), filters: [...filters, { name: '所有文件', extensions: ['*'] }] })
  if (save && save.ok) flash(msg + '：' + save.filePath)
  else if (save && save.error) flash('导出失败：' + save.error)
}
async function doExport(fmt) {
  const a = expMenu.value.ant
  expMenu.value = { key: '', x: 0, y: 0, ant: null }
  if (!a) return
  if (!a.imported || !a.file) { flash('预置天线无原始方向图可导出'); return }
  try {
    const r = await api.coverageGrd.raw(a.file)
    if (fmt === 'grd') {
      // 合成的多馈源 .grd 各波束用各自小窗口，SATSOFT 会把全部波束摆到波束1处（见 repackGrdCommonGrid 注释）。
      // 导出前重打包到公共网格（各波束落真实位置）；仅对本平台合成件(含 SYNTHMETA)生效，真实导入件原样导出。
      let text = r.text
      if (text && text.includes('SYNTHMETA')) { try { text = repackGrdCommonGrid(text) } catch (err) { console.warn('公共网格重打包失败，导出原始多窗口 .grd', err) } }
      return await saveOut(text, `${a.name}.grd`, [{ name: 'GRASP 网格', extensions: ['grd'] }], '已导出')
    }
    if (fmt === 'stk') {
      const s = grdToStkAzEl(r.text, { name: a.name })
      return await saveOut(s.text, `${a.name}_STK.txt`, [{ name: 'STK 外部天线方向图', extensions: ['txt', 'pattern', 'ant'] }],
        `已导出 STK 方向图（${s.nx}×${s.ny} · ${s.nBeams} 波束 · 峰值 ${s.peakDbi.toFixed(1)} dBi）`)
    }
    if (fmt === 'acp4') {
      const s = grdToAcp4(r.text, { name: a.name })
      return await saveOut(s.text, `${a.name}.pat`, [{ name: 'ACP4 方向图', extensions: ['pat', 'txt'] }],
        `已导出 ACP4（${s.nBeams} 波束 · 峰值 ${s.peakDb.toFixed(1)} dB）`)
    }
    const s = grdToEutelsat(r.text, { name: a.name })
    return await saveOut(s.text, `${a.name}_EUT.pat`, [{ name: 'Eutelsat 方向图', extensions: ['pat', 'txt'] }],
      `已导出 Eutelsat（${s.nx}×${s.ny}${s.nBeams > 1 ? ` · ${s.nBeams} 波束取包络` : ''} · 峰值 ${s.peakDb.toFixed(1)} dB）`)
  } catch (e) { flash('导出失败：' + (e.message || e)) }
}
// 树上如实标出来源格式；ACP4/Eutelsat 只有标量幅度，AR/XPD 对它们无意义（说明放 title，不占版面）
const SRC_LABEL = { acp4: 'ACP4', eutelsat: 'Eutelsat' }
const srcLabel = (a) => (a.imported ? (SRC_LABEL[a.src] || '导入') : '预置')
// 整串写死不拼接 —— 词典按整串精确匹配，拼出来的串翻不了（见 uiDict.data.js 的约定）
const SRC_TITLE = {
  acp4: '由 ACP4 转入：该格式只有标量幅度，无相位与交叉极化分量，轴比 AR 与 XPD 对本天线不适用',
  eutelsat: '由 Eutelsat 转入：该格式只有标量幅度，无相位与交叉极化分量，轴比 AR 与 XPD 对本天线不适用'
}
const srcTitle = (a) => SRC_TITLE[a.src] || ''

/* ===================== ③ 覆盖图 / GXT（用户库）===================== */
const gxtIndex = ref({ satellites: [] })
// 内置覆盖（resources/coverage，软件自带的「默认 GXT 数据」）：只读展示 + 可导出为 GXT
const presetSats = ref([])
const gxtExpanded = ref({})
async function loadPreset() { try { presetSats.value = api?.coverage ? (((await api.coverage.index()) || {}).satellites || []).map((s) => ({ ...s, displayName: displaySatName(s.displayName) })) : [] } catch { presetSats.value = [] } }
function toggleSat(key) { gxtExpanded.value = { ...gxtExpanded.value, [key]: !gxtExpanded.value[key] } }
async function exportPresetBeam(satName, beam) {
  try {
    const j = await api.coverage.get(beam.file)
    const text = serializeGxt({ lon: j.lon != null ? j.lon : beam.lon, satName: j.sat || satName, bore: j.bore || [], contours: j.contours || [], beamId: beam.beam, emiRcp: 'E' })
    const save = await api.exportFile({ defaultName: `${j.sat || satName}_${beam.band}_${beam.beam}_${beam.type}.gxt`, data: text, filters: [{ name: 'GXT 等值线', extensions: ['gxt'] }] })
    if (save && save.ok) flash('已导出：' + save.filePath)
    else if (save && save.error) flash('导出失败：' + save.error)
  } catch (e) { flash('导出失败：' + (e.message || e)) }
}
// 内置 + 用户库【按卫星名合并】成一棵树：同名内置/用户卫星合为一个节点，统一加波束/删除。
// 内置只读（软件自带），删除走 hidden 软隐藏；用户侧可增删。节点带 userSatId / presetFolder 双来源指针。
const allSats = computed(() => {
  const hiddenSats = new Set((gxtIndex.value.hidden && gxtIndex.value.hidden.sats) || [])
  const hiddenBeams = new Set((gxtIndex.value.hidden && gxtIndex.value.hidden.beams) || [])
  const byName = new Map(); const order = []
  const nodeFor = (name, lon) => {
    const k = String(name || '').toLowerCase()
    let n = byName.get(k)
    if (!n) { n = { key: 'g:' + k, name, lon, userSatId: null, presetFolder: null, beams: [] }; byName.set(k, n); order.push(n) }
    if (n.lon == null && lon != null) n.lon = lon
    return n
  }
  for (const s of (presetSats.value || [])) {
    if (hiddenSats.has(s.folder)) continue
    const n = nodeFor(s.displayName, s.lon); n.presetFolder = s.folder
    for (const b of (s.beams || [])) {
      if (hiddenBeams.has(b.key)) continue
      n.beams.push({ key: 'p:' + b.key, presetKey: b.key, name: b.beam, type: b.type, band: b.band, meta: ((b.gains || []).length) + ' 档', file: b.file, lon: b.lon, source: 'preset' })
    }
  }
  for (const s of (gxtIndex.value.satellites || [])) {
    const n = nodeFor(s.name, s.lon); n.userSatId = s.id
    for (const b of (s.beams || [])) {
      n.beams.push({ key: 'u:' + b.id, id: b.id, name: b.name, type: b.type, band: b.band, file: b.file, rawFile: b.rawFile, contours: b.contours, importedAt: b.importedAt, sourceFormat: b.sourceFormat, source: 'user' })
    }
  }
  return order.filter((n) => n.beams.length || n.userSatId)
})
// 给节点确保有用户侧卫星承载新波束（内置节点首次加波束时按同名建用户卫星）
async function ensureUserSat(node) {
  if (node.userSatId) return node.userSatId
  const r = await api.coverageGxt.ensureSat(node.name, node.lon)
  await loadGxt()
  return r.id
}
// 统一导出：内置走 exportPresetBeam，用户走 exportGxtBeam
async function exportBeam(sat, beam) {
  if (beam.source === 'preset') return exportPresetBeam(sat.name, { beam: beam.name, band: beam.band, type: beam.type, file: beam.file, lon: beam.lon != null ? beam.lon : sat.lon })
  return exportGxtBeam(beam)
}
// 导出为 KML（Google Earth 通用）：内置/用户同一条路径，从归一化数据重建（轨位/频段/类型写进 ExtendedData，可再导回来）
async function exportBeamKml(sat, beam) {
  if (!beam.file) { flash('该波束尚未导入数据'); return }
  try {
    const j = beam.source === 'preset' ? await api.coverage.get(beam.file) : await api.coverageGxt.get(beam.file)
    const lon = [j.lon, beam.lon, sat.lon].map(Number).find(Number.isFinite)
    const text = serializeKml(
      [{ name: beam.name, satName: j.sat || sat.name, lon, type: beam.type, band: beam.band, bore: j.bore || [], contours: j.contours || [] }],
      { name: `${sat.name} ${beam.name}` }
    )
    const save = await api.exportFile({ defaultName: `${sat.name}_${beam.name}.kml`, data: text, filters: [{ name: 'KML', extensions: ['kml'] }] })
    if (save && save.ok) flash('已导出：' + save.filePath)
    else if (save && save.error) flash('导出失败：' + save.error)
  } catch (e) { flash('导出失败：' + (e.message || e)) }
}
const newSat = ref({ name: '', lon: '' })
const addBeamFor = ref('')          // 正在添加波束的卫星 id
const newBeam = ref({ name: '', type: 'EIRP', band: '' })
async function loadGxt() { try { gxtIndex.value = api?.coverageGxt ? await api.coverageGxt.index() : { satellites: [] }; if (gxtIndex.value?.corrupt) flash('覆盖库索引损坏') } catch { gxtIndex.value = { satellites: [] } } }
// 扩展名兜底：老版 IPC 不返回 ext，且用户可能把 KML 存成别的后缀 —— 认文件头
const isKmlFile = (f) => String(f.ext || '').toLowerCase() === 'kml' || /^\s*(<\?xml|<kml)/i.test(f.text || '')
// 批量导入：多选 .gxt / .kml → 自动归类建星/建波束并导入，一次完成。
// GXT：一个文件 = 一个波束，卫星/频段/波束/类型按文件名（卫星_频段_波束_类型）拆，留原文供原样再导出。
// KML：一个文件可含多卫星多波束（文件夹树即层级），逐个建；不留原文，再导出由归一化数据重建。
async function importGxtBatch() {
  const res = await api.coverageGxt.open()
  if (!res || res.canceled) return
  const files = res.files || []
  const items = [], errs = []
  let noGain = 0, skipPolys = 0
  for (const f of files) {
    if (f.error || !f.text) { errs.push((f.base || '文件') + '：' + (f.error || '空文件')); continue }
    if (isKmlFile(f)) {
      let r
      try { r = parseKmlBeams(f.text) } catch (e) { errs.push((f.base || '文件') + '：解析失败 ' + (e.message || e)); continue }
      noGain += r.noGain; skipPolys += r.polys
      const fb = metaFromName(String(f.base || '').replace(/\.kml$/i, ''))
      for (const b of r.beams) {
        const satName = b.satName || fb.sat || fb.name || '卫星'
        const beamName = b.beamName || fb.beam || '波束'
        items.push({
          satName, lon: b.lon, beamName, type: b.type || 'EIRP', band: b.band || '',
          rawText: null, sourceName: f.base, sourceFormat: 'kml',
          json: { sat: satName, band: b.band || '', beam: beamName, type: b.type || 'EIRP', lon: b.lon, bore: b.bore, contours: b.contours }
        })
      }
      continue
    }
    let parsed
    try { parsed = parseGxt(f.text) } catch (e) { errs.push((f.base || '文件') + '：解析失败 ' + (e.message || e)); continue }
    const meta = metaFromName(f.base)
    items.push({
      satName: meta.sat || meta.name, lon: parsed.lon, beamName: meta.beam || meta.name,
      type: meta.type || 'EIRP', band: meta.band || '', rawText: f.text, sourceName: f.base, sourceFormat: 'gxt',
      json: { sat: meta.sat, band: meta.band, beam: meta.beam, type: meta.type || 'EIRP', lon: parsed.lon, bore: parsed.bore, contours: parsed.contours }
    })
  }
  if (!items.length) { flash('未能导入：' + (errs[0] || '没有有效的 GXT / KML 文件')); return }
  const r = await api.coverageGxt.importBatch(items)
  await loadGxt(); bumpLibrary()
  // 自动展开本次涉及的卫星，便于查看（节点按名合并，key = 'g:'+小写名）
  const exp = { ...gxtExpanded.value }
  for (const it of items) exp['g:' + String(it.satName || '').toLowerCase()] = true
  gxtExpanded.value = exp
  const extra = [errs.length ? `${errs.length} 个失败` : '', noGain ? `${noGain} 个多边形无增益档` : '', skipPolys ? `${skipPolys} 个协调区多边形已跳过` : ''].filter(Boolean)
  flash(`导入 ${files.length} 个文件 → ${items.length} 个波束，新增 ${r.sats} 卫星 / ${r.beams} 波束` + (extra.length ? `（${extra.join('，')}）` : ''))
}
async function addGxtSat() {
  const name = newSat.value.name.trim(); if (!name) { flash('请填写卫星名'); return }
  const lon = newSat.value.lon === '' ? null : Number(newSat.value.lon)
  await api.coverageGxt.addSat(name, Number.isFinite(lon) ? lon : null)
  newSat.value = { name: '', lon: '' }; await loadGxt(); bumpLibrary()
}
const beamInput = ref(null)
const setBeamInput = (el) => { beamInput.value = el }
async function openAddBeam(node) {
  const id = await ensureUserSat(node)
  addBeamFor.value = addBeamFor.value === id ? '' : id
  newBeam.value = { name: '', type: 'EIRP', band: '' }
  // 表单出现后：若节点折叠则自动展开（否则表单藏在折叠区里），再程序化聚焦（等渲染落定，避免点不进）
  if (addBeamFor.value) {
    gxtExpanded.value = { ...gxtExpanded.value, [node.key]: true }
    await nextTick(); if (beamInput.value && beamInput.value.focus) beamInput.value.focus()
  }
}
async function addGxtBeam(node) {
  const id = node.userSatId || await ensureUserSat(node)
  const name = newBeam.value.name.trim() || '波束'
  await api.coverageGxt.addBeam(id, name, newBeam.value.type, newBeam.value.band.trim())
  addBeamFor.value = ''; await loadGxt(); bumpLibrary()
}
// 导入到指定波束：KML 含多个波束时只收第一个（目标波束是用户点定的，多的那些走批量导入才归得对位）
async function importGxtToBeam(node, beam) {
  const res = await api.coverageGxt.open()
  if (!res || res.canceled) return
  const files = res.files || []
  const f = files[0]
  if (!f || f.error || !f.text) { flash('读取失败：' + ((f && f.error) || '空文件')); return }
  const kml = isKmlFile(f)
  let parsed, rest = 0
  if (kml) {
    let r
    try { r = parseKmlBeams(f.text) } catch (e) { flash('KML 解析失败：' + (e.message || e)); return }
    const b = r.beams[0]; rest = r.beams.length - 1
    parsed = { lon: b.lon, bore: b.bore, contours: b.contours, band: b.band, type: b.type }
  } else {
    try { parsed = parseGxt(f.text) } catch (e) { flash('GXT 解析失败：' + (e.message || e)); return }
  }
  const meta = metaFromName(f.base)
  const json = {
    sat: node.name || meta.sat, band: beam.band || parsed.band || meta.band, beam: beam.name || meta.beam,
    type: beam.type || parsed.type || meta.type || 'EIRP',
    lon: parsed.lon, bore: parsed.bore, contours: parsed.contours
  }
  const r = await api.coverageGxt.attach(node.userSatId, beam.id, {
    rawText: kml ? null : f.text, sourceName: f.base, sourceFormat: kml ? 'kml' : 'gxt', json, type: json.type, band: json.band
  })
  if (r && r.ok) { flash(`已导入 ${f.base}（${parsed.contours.length} 条等值线${rest > 0 ? `；文件里另有 ${rest} 个波束未收，用「导入 GXT / KML…」批量导` : ''}）`); await loadGxt(); bumpLibrary() }
  else flash('导入失败：' + ((r && r.error) || '未知'))
}
async function exportGxtBeam(beam) {
  if (!beam.rawFile && !beam.file) { flash('该波束尚未导入数据'); return }
  try {
    let text
    if (beam.rawFile) { const r = await api.coverageGxt.raw(beam.rawFile); text = r.text }
    else { const j = await api.coverageGxt.get(beam.file); text = serializeGxt({ lon: j.lon, satName: j.sat, bore: j.bore, contours: j.contours, beamId: beam.name }) }
    const save = await api.exportFile({ defaultName: `${beam.name || 'beam'}.gxt`, data: beam.rawFile ? toBytes(text) : text, filters: [{ name: 'GXT 等值线', extensions: ['gxt'] }] })
    if (save && save.ok) flash('已导出：' + save.filePath)
    else if (save && save.error) flash('导出失败：' + save.error)
  } catch (e) { flash('导出失败：' + (e.message || e)) }
}
async function removeGxtSat(node) {
  const hasP = !!node.presetFolder, hasU = !!node.userSatId
  const msg = hasP && hasU ? `删除卫星「${node.name}」？自建波束将删除，内置波束将从列表隐藏。`
    : hasP ? `从列表隐藏内置卫星「${node.name}」？（不会删除软件自带数据）`
    : `删除卫星「${node.name}」及其全部波束？`
  if (!(await ask(msg))) return
  if (hasU) await api.coverageGxt.removeSat(node.userSatId)
  if (hasP) await api.coverageGxt.hidePreset('sat', node.presetFolder)
  await loadGxt(); bumpLibrary()
}
async function removeGxtBeam(node, beam) {
  if (!(await ask(`删除波束「${beam.name}」？` + (beam.source === 'preset' ? '（内置波束，仅从列表隐藏）' : '')))) return
  if (beam.source === 'user') await api.coverageGxt.removeBeam(node.userSatId, beam.id)
  else await api.coverageGxt.hidePreset('beam', beam.presetKey)
  await loadGxt(); bumpLibrary()
}

// 导出当前画面绘制的覆盖（GXT+GRD 来源）为 GXT 文件
const canExportCurrent = computed(() => !!fileBridge.collectGxt)
async function exportCurrentGxt() {
  if (!fileBridge.collectGxt) { flash('请先在「星座地图 3D」绘制覆盖'); return }
  const beams = fileBridge.collectGxt()
  if (!beams || !beams.length) { flash('当前画面没有可导出的覆盖等值线'); return }
  // 多波束合并为一个多 diagram GXT：逐波束 serialize 后拼接（每波束独立 COHeader 区块）
  const blocks = beams.map((b, i) => serializeGxt({ ...b, beamId: b.name || (i + 1) }))
  const text = blocks.join('\r\n')
  const save = await api.exportFile({ defaultName: '当前覆盖.gxt', data: text, filters: [{ name: 'GXT 等值线', extensions: ['gxt'] }] })
  if (save && save.ok) flash('已导出：' + save.filePath)
  else if (save && save.error) flash('导出失败：' + save.error)
}

/* ===================== ④ MODCOD 表（调制编码标准库）=====================
   六张内置预设表（DVB-S / S2 / RCS2 / S2X / 3GPP NR-NTN / NB-IoT NTN）原先写死在
   packages/core/utils/constants.js 里，用户既加不了自家体制、也改不了某一档门限（各家调制解调器的
   实测门限与标准仿真值差一两个 dB 是常态）。这里把它做成可编辑的库：
     · 内置标准可改、可改名，改过的给「恢复默认」；★主进程只存【与内置表的差异】，
       没动过的标准照旧跟着软件版本走（否则用户改一条 DVB-S2，其余五张表就永远冻在这个版本上）；
     · 自定义标准可增删，key 用 usr: 前缀与内置分家，改名不会让已存配置里的 dvbStandard 指空；
     · 整库 ⇄ Excel：一个标准一张工作表，表名即标准名，故导入一份工作簿即可一次改多个标准 +
       一次新建多个自定义标准。导出走三线表版式（与链路预算报告里的表同款）。
   改完在链路预算各窗口点顶栏「刷新」即生效（那按钮本就重拉 link:baseband）。          */
const MC_STORE_KEYS = ['key', 'label', 'rows']
const mcStds = ref([])            // [{ key, label, builtin, modified, rows:[{id,...}] }]
const mcSel = ref('')
const mcReadOnly = ref(false)     // 库文件损坏：只读展示，不许写回去覆盖
let _mcRowSeq = 1
const mcNewRowId = () => 'mc' + (_mcRowSeq++)
const mcCur = computed(() => mcStds.value.find((s) => s.key === mcSel.value) || null)
const mcRows = () => (mcCur.value ? mcCur.value.rows : [])

async function loadModcod() {
  if (!api?.modcod?.list) { mcStds.value = []; return }
  try {
    const r = await api.modcod.list()
    mcStds.value = ((r && r.standards) || []).map((s) => ({ ...s, rows: (s.rows || []).map((x) => ({ ...x, id: mcNewRowId() })) }))
    mcReadOnly.value = !!(r && r.readOnly)
    if (r && r.error) flash(r.error)
    if (!mcStds.value.some((s) => s.key === mcSel.value)) mcSel.value = mcStds.value.length ? mcStds.value[0].key : ''
  } catch { mcStds.value = [] }
}

// 落库：改一处存一处（与「编辑卫星实时生效」同口径），合并同一串键入
let _mcSaveT = null
function mcSave() {
  if (mcReadOnly.value) return
  clearTimeout(_mcSaveT)
  _mcSaveT = setTimeout(async () => {
    if (!api?.modcod?.save) return
    const payload = mcStds.value.map((s) => {
      const o = {}
      for (const k of MC_STORE_KEYS) o[k] = k === 'rows' ? s.rows.map((r) => ({ ...r, id: undefined })) : s[k]
      return o
    })
    const r = await api.modcod.save(payload)
    if (!r || !r.ok) { flash('MODCOD 保存失败：' + ((r && r.error) || '未知错误')); return }
    // 只回填「改过没有」这一位：整份回填会在用户还在键入时把「1.」这类中间态归一掉
    for (const s of r.standards || []) { const l = mcStds.value.find((x) => x.key === s.key); if (l) l.modified = s.modified }
  }, 260)
}

/* ---- 撤销 / 重做：整库快照（六张表合起来也就几百行，够小）---- */
const mcUndoStack = [], mcRedoStack = []
const mcSnap = () => JSON.stringify(mcStds.value)
const mcApply = (s) => { mcStds.value = JSON.parse(s); if (!mcStds.value.some((x) => x.key === mcSel.value)) mcSel.value = mcStds.value[0]?.key || '' }
function mcPushUndo() { mcUndoStack.push(mcSnap()); if (mcUndoStack.length > 100) mcUndoStack.shift(); mcRedoStack.length = 0 }
function mcDropUndo() { mcUndoStack.pop() }
function mcUndo() { if (!mcUndoStack.length) return false; mcRedoStack.push(mcSnap()); mcApply(mcUndoStack.pop()); mcSave(); return true }
function mcRedo() { if (!mcRedoStack.length) return false; mcUndoStack.push(mcSnap()); mcApply(mcRedoStack.pop()); mcSave(); return true }

/* ---- 剪贴板：制表符 > 逗号 > 整行一格。★不退回「按空白切」——
   MODCOD 名恒含空格（'QPSK 3/4'、'MCS0  QPSK  120/1024'），按空白切会把一个名字拆成三格。 ---- */
const mcSplit = (t) => (t.includes('\t') ? t.split('\t') : (t.includes(',') ? t.split(',') : [t])).map((x) => x.trim())
const mcLines = (t) => String(t || '').split(/\r?\n/).filter((l) => l.trim() !== '')
function mcPasteBlock(anchorId, startKey, text) {
  const cur = mcCur.value; if (!cur) return 0
  const grid = mcLines(text).map(mcSplit); if (!grid.length) return 0
  const c0 = Math.max(0, MODCOD_COLS.findIndex((c) => c.key === startKey))
  let idx = anchorId ? cur.rows.findIndex((r) => r.id === anchorId) : cur.rows.length
  if (idx < 0) idx = cur.rows.length
  for (const cells of grid) {
    if (idx >= cur.rows.length) cur.rows.push(emptyRow(cur.rows[cur.rows.length - 1], mcNewRowId()))
    const row = cur.rows[idx]
    cells.forEach((v, i) => { const c = MODCOD_COLS[c0 + i]; if (c) setCell(row, c.key, v) })
    idx++
  }
  return grid.length
}
function mcPasteAppend(text) {
  const cur = mcCur.value; if (!cur) return 0
  const grid = mcLines(text).map(mcSplit); if (!grid.length) return 0
  for (const cells of grid) {
    const row = emptyRow(cur.rows[cur.rows.length - 1], mcNewRowId())
    cells.forEach((v, i) => { const c = MODCOD_COLS[i]; if (c) setCell(row, c.key, v) })
    cur.rows.push(row)
  }
  return grid.length
}

// 网格列＝带枚举 options 的那份：调制方式与门限口径只能从列表里挑。
// used 把「本表已用到的调制方式」并进候选，否则用 M 现造出来的档（如 1024QAM）会从它自己那格的下拉里消失。
const MC_GRID_COLS = modcodGridCols(() => mcRows().map((r) => r.modulation))
const mcGrid = useGridSelect({
  gridId: 'mc',
  rows: mcRows,
  cols: () => MC_GRID_COLS,
  cellText: mcCellText,
  // 编辑框里显示的原文＝屏上显示的那一串：门限口径列存的是 'esno'，双击进编辑却蹦出个内部值
  // 就没法照着改了。setCell 那头两种写法都认，故所见即所改。
  cellRaw: mcCellText,
  onEdit: (id, key, val) => { const r = mcRows().find((x) => x.id === id); if (r) setCell(r, key, val) },
  onClear: (cells) => cells.forEach(({ rowId, key }) => { const r = mcRows().find((x) => x.id === rowId); if (r) setCell(r, key, '') }),
  onPasteBlock: mcPasteBlock,
  onPasteAppend: mcPasteAppend,
  onInsertRows: (at, n) => {
    const cur = mcCur.value; if (!cur) return 0
    for (let k = 0; k < n; k++) cur.rows.splice(at + k, 0, emptyRow(cur.rows[Math.max(0, at - 1)], mcNewRowId()))
    return n
  },
  onDeleteRows: (ids) => {
    const cur = mcCur.value; if (!cur) return 0
    const s = new Set(ids), before = cur.rows.length
    cur.rows = cur.rows.filter((r) => !s.has(r.id))
    return before - cur.rows.length
  },
  pushUndo: mcPushUndo, dropUndo: mcDropUndo, refresh: mcSave, undo: mcUndo, redo: mcRedo
})
function mcAddRow() {
  const cur = mcCur.value; if (!cur) return
  mcPushUndo(); cur.rows.push(emptyRow(cur.rows[cur.rows.length - 1], mcNewRowId())); mcSave()
}

/* ---- 标准的增 / 删 / 改名 / 恢复默认 ---- */
// 自建标准的 key 与主进程同一套（usr: + 最小空号）；主进程仍会兜底去重
function mcNewKey() {
  const taken = new Set(mcStds.value.map((s) => s.key))
  let n = 1
  while (taken.has('usr:' + n)) n++
  return 'usr:' + n
}
function mcUniqLabel(base) {
  const taken = new Set(mcStds.value.map((s) => s.label))
  if (!taken.has(base)) return base
  let k = 2
  while (taken.has(base + ' ' + k)) k++
  return base + ' ' + k
}
function mcAddStd() {
  mcPushUndo()
  const s = { key: mcNewKey(), label: mcUniqLabel('自定义标准'), builtin: false, modified: false, rows: [] }
  mcStds.value.push(s); mcSel.value = s.key
  mcSave(); mcRename(s)
}
async function mcRemoveStd(s) {
  if (!s || s.builtin) return
  if (!(await ask(`删除标准「${s.label}」（${s.rows.length} 条 MODCOD）？已引用它的载波配置会失去这一档快选，配置里已填好的值不受影响。`))) return
  mcPushUndo()
  mcStds.value = mcStds.value.filter((x) => x.key !== s.key)
  if (mcSel.value === s.key) mcSel.value = mcStds.value[0]?.key || ''
  mcSave(); flash(`已删除标准「${s.label}」`)
}
async function mcResetStd(s) {
  if (!s || !s.builtin || !s.modified) return
  if (!(await ask(`把「${s.label}」恢复为软件内置的出厂表？本标准下的改动将全部丢弃。`))) return
  const r = api?.modcod?.reset ? await api.modcod.reset(s.key) : null
  if (!r || !r.ok) { flash('恢复失败：' + ((r && r.error) || '未知错误')); return }
  mcUndoStack.length = 0; mcRedoStack.length = 0
  await loadModcod(); flash(`已恢复「${s.label}」的出厂表`)
}
// 标准改名：内置标准也允许（存的是 key，改名不影响已存配置的引用）
const mcEdit = ref('')
const mcVal = ref('')
const mcInputEl = ref(null)
const setMcInput = (el) => { mcInputEl.value = el }
function mcRename(s) { mcEdit.value = s.key; mcVal.value = s.label; nextTick(() => { const el = mcInputEl.value; if (el) { el.focus(); el.select() } }) }
function mcCancelRename() { mcEdit.value = ''; mcVal.value = '' }
function mcCommitRename() {
  const s = mcStds.value.find((x) => x.key === mcEdit.value)
  const nm = mcVal.value.trim()
  mcEdit.value = ''
  if (!s || !nm || nm === s.label) return
  if (mcStds.value.some((x) => x !== s && x.label === nm)) { flash(`已有名为「${nm}」的标准`); return }
  mcPushUndo(); s.label = nm; mcSave()
}

/* ---- 调制方式：按「制式族 + 星座阶数 M」现造一个（挂在枚举下拉的底部插槽里）----
   内置那 11 项覆盖不到用户自家的体制（如 1024QAM），但「随便打一串字」又是最坏的出路：
   调制因子查不到就静默按 2 bit/符号算。故给一条受约束的生成路径 —— 族只有三个、
   M 必须是该族允许的 2 的整数次幂，两条都满足才给「用」。 */
const mcGenFam = ref('psk')
const mcGenOrder = ref('4')
const mcGenName = computed(() => composeModulation(mcGenFam.value, Number(mcGenOrder.value)))
const mcGenBits = computed(() => modFactorOf(mcGenName.value))
const mcGenRange = computed(() => { const o = ordersOf(mcGenFam.value); return o[0] + '–' + o[o.length - 1] })
const mcGenBad = computed(() => !isValidOrderFor(mcGenFam.value, Number(mcGenOrder.value)))
// 打开下拉时按该格现有的值把族与 M 摆好（改一个已有档时不必从头选）
watch(() => mcGrid.pick.open, (on) => {
  if (!on || mcGrid.pick.ri < 0 || mcGrid.pick.ci < 0) return   // ★ 不能写 !pick.ri：第 1 行的下标就是 0
  const col = MC_GRID_COLS[mcGrid.pick.ci]
  if (!col || col.key !== 'modulation') return
  const row = mcRows()[mcGrid.pick.ri]
  const p = row ? parseModulation(row.modulation) : null
  if (p) { mcGenFam.value = p.family; mcGenOrder.value = String(p.order) }
})
function mcSetGenFam(k) {
  mcGenFam.value = k
  // 换族后原来的 M 可能不在新族的范围里（8 对 APSK 就不成立），钳到最近的合法档
  const o = ordersOf(k), cur = Number(mcGenOrder.value)
  if (!o.includes(cur)) mcGenOrder.value = String(o.reduce((b, x) => (Math.abs(x - cur) < Math.abs(b - cur) ? x : b), o[0]))
}

/* ---- 整库 ⇄ Excel ---- */
async function mcExport() {
  if (!mcStds.value.length) return
  const r = await exportSheets({
    defaultName: modcodFileName(), title: '导出 MODCOD 表',
    style: 'report', sheets: modcodSheets(mcStds.value)
  })
  if (r && r.canceled) return
  if (r && r.ok) flash('已导出：' + r.filePath)
  else flash('导出失败：' + ((r && r.error) || '未知错误'))
}
async function mcImport() {
  if (mcReadOnly.value) { flash('MODCOD 库文件损坏，导入已取消'); return }
  const r = await importWorkbook({ title: '导入 MODCOD 表' })
  if (!r || r.canceled) return
  if (!r.ok) { flash('导入失败：' + (r.error || '未知错误')); return }
  const incoming = standardsFromSheets(r.sheets)
  if (!incoming.length) { flash('这份工作簿里没读到 MODCOD 数据'); return }
  // 按标准名对号入座：对得上的整表替换，对不上的新建为自定义标准。
  // ★ 两把尺子都要试 —— Excel 的表名不许超 31 字符、不许带 `: \ / ? * [ ]`，故长名/带这些字符的
  //   自定义标准导出时表名必被改写。只比字面量的话，「导出→原样导回」会凭空多出一个重名标准而不是
  //   覆盖原来那个。第二把尺子 modcodSheetNames 预演一遍导出名，把改写过的名字认回原标准。
  const byExportName = modcodSheetNames(mcStds.value)
  const hit = [], add = [], taken = new Set()
  for (const it of incoming) {
    let t = mcStds.value.find((s) => s.label === it.name) || byExportName.get(it.name) || null
    if (t && taken.has(t.key)) t = null   // 一份工作簿里两张表指向同一个标准：只认第一张，其余当新建
    if (t) { taken.add(t.key); hit.push({ target: t, rows: it.rows }) } else add.push(it)
  }
  const parts = []
  if (hit.length) parts.push(`覆盖 ${hit.length} 个已有标准（${hit.map((h) => h.target.label).join('、')}）`)
  if (add.length) parts.push(`新建 ${add.length} 个自定义标准（${add.map((a) => a.name).join('、')}）`)
  if (!(await ask(`将${parts.join('，')}。继续？`))) return
  mcPushUndo()
  for (const h of hit) h.target.rows = h.rows.map((x) => ({ ...x, id: mcNewRowId() }))
  for (const a of add) {
    mcStds.value.push({ key: mcNewKey(), label: mcUniqLabel(a.name || '导入标准'), builtin: false, modified: false, rows: a.rows.map((x) => ({ ...x, id: mcNewRowId() })) })
  }
  if (add.length) mcSel.value = mcStds.value[mcStds.value.length - 1].key
  else if (hit.length) mcSel.value = hit[0].target.key
  mcSave()
  const bad = rejectedModulations(incoming)
  const tail = bad.length ? `；${bad.length} 种调制方式不认得，相关行已跳过：${bad.slice(0, 3).join('、')}${bad.length > 3 ? ' …' : ''}` : ''
  flash(`已导入：${hit.length} 个覆盖 · ${add.length} 个新建 · 共 ${incoming.reduce((n, s) => n + s.rows.length, 0)} 条 MODCOD${tail}`)
}

const fpMiniDeviceId = ref('')
onMounted(() => {
  loadOmm(); loadCustomGroups(); loadCustomConsts(); loadGxt(); loadPreset(); loadFreqPlans(); loadModcod()
  // 「发送到小程序」的凭证与本机ID（缺凭证时按钮仍在，点开即说明原因，不静默失效）
  api?.share?.configured?.().then((v) => { fpMiniConfigured.value = !!v }).catch(() => {})
  api?.app?.deviceId?.().then((v) => { fpMiniDeviceId.value = String(v || '') }).catch(() => {})
})
// 频率计划在独立窗口编辑，改动不会回推本页 —— 切回本页签时重新拉一次索引，
// 免得用户编辑完回来看到的还是旧的转发器数/更新时间。
watch(tab, (t) => { if (t === 'freqplan') loadFreqPlans() })
</script>

<template>
  <div class="mask">
    <div class="dlg" role="dialog" aria-modal="true">
      <header class="dhd">
        <span class="dt">文件管理</span>
        <button class="winx" type="button" aria-label="关闭" title="关闭" @click="emit('close')">
          <Icon name="x" :size="12" />
        </button>
      </header>

      <div class="wrap">
        <nav class="rail">
          <button class="rb" :class="{ on: tab === 'omm' }" @click="tab = 'omm'">轨道星历</button>
          <button class="rb" :class="{ on: tab === 'grd' }" @click="tab = 'grd'">天线方向图</button>
          <button class="rb" :class="{ on: tab === 'freqplan' }" @click="tab = 'freqplan'">频率计划</button>
          <button class="rb" :class="{ on: tab === 'modcod' }" @click="tab = 'modcod'">MODCOD 表</button>
          <button class="rb" :class="{ on: tab === 'scenelib' }" @click="tab = 'scenelib'">场景模块库</button>
          <button class="rb" :class="{ on: tab === 'gxt' }" @click="tab = 'gxt'">GXT/KML 管理</button>
        </nav>

        <div class="pane" :class="{ fill: tab === 'modcod' || tab === 'scenelib' }">
          <!-- ① OMM -->
          <section v-if="tab === 'omm'">
            <!-- 自定义卫星：逐条配置，各自导出/删除。自建星座(场景历元，只读镜像) + 导入组(文件历元) -->
            <div class="secbar">
              <span class="sect">自定义卫星</span>
              <span class="spacer"></span>
              <button class="mini imp" :disabled="customBusy" @click="importCustom">{{ customBusy ? '导入中…' : '导入星历' }}</button>
            </div>
            <div class="clist">
              <!-- ① 自建星座（Walker，历元=场景历元）：只读镜像，在「星座3D」增删；可逐座导出/改名 -->
              <div v-if="customConsts.length" class="csub">自建星座 · {{ customConsts.length }} 座 · 场景历元</div>
              <div v-for="c in customConsts" :key="'k' + c.id" class="crow">
                <span class="cdot" :style="{ background: c.color }"></span>
                <template v-if="custEdit === 'k' + c.id">
                  <input class="ci cnmedit" :ref="setCustInput" v-model="custVal" @keydown.enter="commitRenameCust" @keydown.esc="cancelRenameCust" />
                  <span class="cops">
                    <button class="mini imp" @mousedown.prevent @click="commitRenameCust">确定</button>
                    <button class="mini ghost" @click="cancelRenameCust">取消</button>
                  </span>
                </template>
                <template v-else>
                  <span class="cnm rn" title="点击改名" @click="startRenameCust('k' + c.id, c.name)" data-i18n-skip>{{ c.name }}</span>
                  <span class="cmeta">{{ c.incl.toFixed(1) }}° · {{ c.count }} 颗</span>
                  <span class="cops">
                    <button class="mini ghost" @click="exportConstellation(c)">导出</button>
                    <span class="cro">在「星座3D」管理</span>
                  </span>
                </template>
              </div>
              <!-- ② 导入组（每个 OMM/TLE 文件一组，历元=文件内）：逐组导出/删除/改名 -->
              <div v-if="customGroups.length" class="csub">导入组 · {{ customGroups.length }} 组 · 文件历元</div>
              <div v-for="g in customGroups" :key="'g' + g.id" class="crow">
                <span class="cdot imp"></span>
                <template v-if="custEdit === 'g' + g.id">
                  <input class="ci cnmedit" :ref="setCustInput" v-model="custVal" @keydown.enter="commitRenameCust" @keydown.esc="cancelRenameCust" />
                  <span class="cops">
                    <button class="mini imp" @mousedown.prevent @click="commitRenameCust">确定</button>
                    <button class="mini ghost" @click="cancelRenameCust">取消</button>
                  </span>
                </template>
                <template v-else>
                  <span class="cnm rn" title="点击改名" @click="startRenameCust('g' + g.id, g.name)" data-i18n-skip>{{ g.name }}</span>
                  <span class="cmeta">{{ fmtGroupMeta(g) }}</span>
                  <span class="cops">
                    <button class="mini ghost" @click="exportGroup(g)">导出</button>
                    <button class="mini del" @click="removeCustomGroup(g)">删除</button>
                  </span>
                </template>
              </div>
              <div v-if="!hasCustomAny" class="cempty">暂无自定义卫星。</div>
            </div>

            <div class="secbar top"><span class="sect">内置星座组</span></div>
            <table class="tbl">
              <thead><tr><th>星座组</th><th>卫星数</th><th>更新时间</th><th>状态</th><th></th></tr></thead>
              <tbody>
                <tr v-for="row in ommRows" :key="row.key">
                  <td class="nm">{{ OMM_LABELS[row.key] || row.key }}</td>
                  <td>{{ ommAvail(row) ? row.count : '—' }}</td>
                  <td class="dim">{{ fmtTime(row.mtime) }}</td>
                  <td><span class="badge" :class="{ off: !ommAvail(row), bundled: row.source === 'bundled' }">{{ ommStatus(row) }}</span></td>
                  <td class="ops">
                    <button class="mini" :disabled="ommBusy === row.key" @click="importOmm(row)">{{ ommBusy === row.key ? '导入中…' : '导入替换' }}</button>
                    <button class="mini ghost" :disabled="!ommAvail(row)" @click="exportOmm(row)">导出</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <!-- ② GRD -->
          <section v-else-if="tab === 'grd'">
            <div v-if="!grdApi" class="empty-hint">GRD 数据尚未加载。</div>
            <template v-else>
              <div class="addbar sub">
                <button class="mini imp" @click="openAddGrdSat"><Icon name="plus" :size="12" /> 添加卫星</button>
              </div>
              <div v-if="!grdSats.length" class="empty-hint">暂无卫星。</div>
              <div v-else class="tree">
                <div v-for="sat in grdSats" :key="sat.folder" class="tnode">
                  <div class="trow sat">
                    <span class="tname">{{ sat.satName }}</span>
                    <span class="tcount">{{ grdLonText(sat) }}{{ sat.antennas.length }} 天线</span>
                    <span class="trops">
                      <button class="mini" @click="openEditGrdSat(sat)">编辑</button>
                      <button class="mini" title="导入 GRASP GRD / ACP4 / Eutelsat 方向图（可多选，每文件一根天线）" @click="importGrd(sat)"><Icon name="plus" :size="12" /> 导入方向图</button>
                      <button class="mini del" @click="removeGrdSat(sat)">删除卫星</button>
                    </span>
                  </div>
                  <div v-for="a in sat.antennas" :key="a.name" class="trow ant">
                    <template v-if="grdAntEdit === grdKeyOf(sat, a)">
                      <input class="ci wide" v-model="grdAntVal" @keydown.enter="commitRenameGrdAnt(sat, a)" @keydown.esc="cancelRenameGrdAnt" />
                      <span class="trops">
                        <button class="mini imp" @mousedown.prevent @click="commitRenameGrdAnt(sat, a)"><Icon name="check" :size="12" /> 确定</button>
                        <button class="mini ghost" @click="cancelRenameGrdAnt">取消</button>
                      </span>
                    </template>
                    <template v-else>
                      <span class="tname rn" title="点击重命名" @click="startRenameGrdAnt(sat, a)" data-i18n-skip>{{ a.name }}</span>
                      <span class="tmeta" :title="srcTitle(a)">{{ a.beams }} 波束 · {{ srcLabel(a) }}<template v-if="a.peakDb != null"> · 峰值 {{ Number(a.peakDb).toFixed(1) }} dB</template></span>
                      <span class="trops">
                        <button class="mini ghost" @click="startRenameGrdAnt(sat, a)">改名</button>
                        <button class="mini ghost" :disabled="!a.imported" title="导出为 GRASP GRD / STK / ACP4 / Eutelsat" @click="toggleExpMenu($event, sat, a)">导出</button>
                        <button class="mini del" @click="removeGrdAnt(sat, a)">删除</button>
                      </span>
                    </template>
                  </div>
                  <div v-if="!sat.antennas.length" class="noant">暂无天线。</div>
                </div>
              </div>
            </template>
          </section>

          <!-- ②b 频率计划 -->
          <section v-else-if="tab === 'freqplan'">
            <div class="addbar">
              <button class="mini imp" @click="openFreqPlanWin('')"><Icon name="layers" :size="12" /> 打开频率计划工作台</button>
              <button class="mini ghost" @click="importFreqPlanJson"><Icon name="import" :size="12" /> 导入 JSON…</button>
            </div>

            <div v-if="!fpSats.length && !fpRows.length" class="empty-hint">暂无卫星。</div>
            <div v-else class="tree">
              <div v-for="g in fpGroups" :key="g.folder || 'none'" class="tnode">
                <div class="trow sat">
                  <span class="tname" :class="{ orphanname: g.orphan }">{{ g.label }}</span>
                  <span class="tcount">{{ g.plans.length }} 份计划</span>
                  <span class="trops">
                    <button v-if="!g.orphan" class="mini" :disabled="fpBusy" @click="addFreqPlan(g)"><Icon name="plus" :size="12" /> 新建计划</button>
                  </span>
                </div>
                <div v-for="e in g.plans" :key="e.id" class="trow ant">
                  <template v-if="fpEdit === e.id">
                    <input class="ci wide" v-model="fpVal" @keydown.enter="commitRenameFp(e)" @keydown.esc="cancelRenameFp" />
                    <span class="trops">
                      <button class="mini imp" @mousedown.prevent @click="commitRenameFp(e)"><Icon name="check" :size="12" /> 确定</button>
                      <button class="mini ghost" @click="cancelRenameFp">取消</button>
                    </span>
                  </template>
                  <template v-else>
                    <span class="tname rn" title="点击重命名" @click="startRenameFp(e)" data-i18n-skip>{{ e.name }}</span>
                    <span class="tmeta">{{ fmtFpMeta(e) }}</span>
                    <span class="trops">
                      <button class="mini" @click="openFreqPlanWin(e.id)">打开</button>
                      <button class="mini ghost" @click="startRenameFp(e)">改名</button>
                      <button class="mini ghost" title="导出为 JSON（可交换 / 备份）" @click="exportFreqPlan(e)">导出</button>
                      <button class="mini ghost" :disabled="fpBusy" title="生成只读快照并上传，返回 8 位密钥；在小程序「工具栏 · 频率计划」输入该密钥即可查看。快照对应当前版式，计划变更后需重新发送" @click="sendFreqPlanToMini(e)">发送到小程序</button>
                      <button class="mini del" @click="removeFreqPlan(e)">删除</button>
                    </span>
                  </template>
                </div>
                <div v-if="!g.plans.length" class="noant">暂无频率计划。</div>
              </div>
            </div>
          </section>

          <!-- ④ MODCOD 表（调制编码标准库）-->
          <section v-else-if="tab === 'scenelib'" class="mcsec">
            <SceneLibEditor v-if="tab === 'scenelib'" />
          </section>

          <section v-else-if="tab === 'modcod'" class="mcsec">
            <div class="addbar">
              <button class="mini imp" @click="mcAddStd"><Icon name="plus" :size="12" /> 新建标准</button>
              <span class="spacer"></span>
              <button class="mini ghost" title="一个标准一张工作表，表名即标准名：名字对得上的整表替换，对不上的新建为自定义标准" @click="mcImport"><Icon name="import" :size="12" /> 导入 Excel…</button>
              <button class="mini ghost" :disabled="!mcStds.length" @click="mcExport">导出 Excel</button>
            </div>

            <div class="mctabs">
              <button v-for="s in mcStds" :key="s.key" class="mctab" :class="{ on: s.key === mcSel }"
                      :title="s.rows.length + ' 条 MODCOD'" @click="mcSel = s.key">
                <span data-i18n-skip>{{ s.label }}</span><i class="mcn">{{ s.rows.length }}</i>
                <em v-if="s.modified" class="mcmod" title="已改写"></em>
              </button>
            </div>

            <div v-if="!mcCur" class="empty-hint">还没有标准。</div>
            <template v-else>
              <div class="mcbar">
                <input v-if="mcEdit === mcCur.key" class="ci wide" :ref="setMcInput" v-model="mcVal"
                       @keydown.enter="mcCommitRename" @keydown.esc="mcCancelRename" @blur="mcCommitRename" />
                <template v-else>
                  <span class="mcname rn" title="点击改名" data-i18n-skip @click="mcRename(mcCur)">{{ mcCur.label }}</span>
                  <span v-if="mcCur.builtin" class="badge">内置</span>
                </template>
                <span class="spacer"></span>
                <button v-if="mcCur.builtin" class="mini ghost" :disabled="!mcCur.modified" @click="mcResetStd(mcCur)">恢复默认</button>
                <button v-else class="mini del" @click="mcRemoveStd(mcCur)">删除标准</button>
              </div>
              <ExcelGrid class="mcgrid" :grid="mcGrid" :cols="MC_GRID_COLS" :text="mcCellText" :cell-tip="mcCellTip"
                         :head-tip="(c) => c.tip || c.label" empty-text="还没有 MODCOD。"
                         add-label="添加 MODCOD" del-label="删除所选行" @add="mcAddRow">
                <template #pick-foot="{ col, apply }">
                  <div v-if="col && col.key === 'modulation'" class="mcgen">
                    <div class="mcgen-r">
                      <button v-for="f in MOD_FAMILIES" :key="f.key" type="button" class="mcgen-f"
                              :class="{ on: mcGenFam === f.key }" @click="mcSetGenFam(f.key)">{{ f.label }}</button>
                    </div>
                    <div class="mcgen-r">
                      <label class="mcgen-m">M<input class="ci" v-model="mcGenOrder" @keydown.enter="mcGenName && apply(mcGenName)" /></label>
                      <span v-if="mcGenBad" class="mcgen-o bad">须为 {{ mcGenRange }} 内 2 的整数次幂</span>
                      <span v-else class="mcgen-o">{{ mcGenName }} · {{ mcGenBits }} bit/符号</span>
                      <button type="button" class="mini imp" :disabled="mcGenBad" @click="apply(mcGenName)">用</button>
                    </div>
                  </div>
                </template>
              </ExcelGrid>
            </template>
          </section>

          <!-- ③ GXT -->
          <section v-else-if="tab === 'gxt'">

            <div class="addbar">
              <button class="mini imp" title="GXT：一个文件一个波束，按文件名「卫星_频段_波束_类型」归类；KML：按文件夹树还原卫星 → 波束 → 等值线" @click="importGxtBatch">导入 GXT / KML…</button>
              <span class="spacer"></span>
              <button class="mini ghost" :disabled="!canExportCurrent" title="将 3D 页当前绘制的覆盖（GXT/GRD 来源）转为 GXT 文件导出" @click="exportCurrentGxt">当前覆盖转为 GXT 导出</button>
            </div>
            <div class="addbar sub">
              <span class="dimnote">或手动新建：</span>
              <input class="ci" v-model="newSat.name" placeholder="卫星名" @keydown.enter="addGxtSat" />
              <input class="ci nar" v-model="newSat.lon" placeholder="经度°E" @keydown.enter="addGxtSat" />
              <button class="mini ghost" @click="addGxtSat"><Icon name="plus" :size="12" /> 空白卫星</button>
            </div>

            <div v-if="!allSats.length" class="empty-hint">暂无覆盖数据。</div>
            <div v-else class="tree">
              <div v-for="sat in allSats" :key="sat.key" class="tnode">
                <div class="trow sat clk" @click="toggleSat(sat.key)">
                  <span class="tw"><Icon :name="gxtExpanded[sat.key] ? 'chevron-down' : 'chevron-right'" :size="12" /></span>
                  <span class="tname" data-i18n-skip>{{ sat.name }}</span>
                  <span class="tcount">{{ (sat.lon != null ? (fmtGeoSlot(Number(sat.lon)) || sat.lon + '°') + ' · ' : '') }}{{ sat.beams.length }} 波束</span>
                  <span class="trops" @click.stop>
                    <button class="mini" @click="openAddBeam(sat)"><Icon name="plus" :size="12" /> 波束</button>
                    <button class="mini del" @click="removeGxtSat(sat)">删除卫星</button>
                  </span>
                </div>
                <template v-if="gxtExpanded[sat.key]">
                  <div v-if="sat.userSatId && addBeamFor === sat.userSatId" class="addbeam">
                    <input class="ci" :ref="setBeamInput" v-model="newBeam.name" placeholder="波束名" @keydown.enter="addGxtBeam(sat)" />
                    <select class="ci nar" v-model="newBeam.type"><option>EIRP</option><option>GT</option></select>
                    <input class="ci nar" v-model="newBeam.band" placeholder="频段 Ku" @keydown.enter="addGxtBeam(sat)" />
                    <button class="mini" @click="addGxtBeam(sat)">确定</button>
                    <button class="mini ghost" @click="addBeamFor = ''">取消</button>
                  </div>
                  <div v-for="beam in sat.beams" :key="beam.key" class="trow ant">
                    <span class="tname" data-i18n-skip>{{ beam.name }}</span>
                    <span class="tmeta">
                      <template v-if="beam.source === 'preset'">{{ beam.type }}<template v-if="beam.band"> · {{ beam.band }}</template> · {{ beam.meta }}</template>
                      <template v-else-if="beam.file">{{ beam.type }}<template v-if="beam.band"> · {{ beam.band }}</template> · {{ beam.contours }} 等值线<template v-if="beam.sourceFormat === 'kml'"> · KML</template> · {{ fmtTime(beam.importedAt) }}</template>
                      <template v-else><span class="dim">未导入数据</span></template>
                    </span>
                    <span class="trops">
                      <button v-if="beam.source === 'user'" class="mini" @click="importGxtToBeam(sat, beam)">{{ beam.file ? '重新导入' : '导入 GXT / KML' }}</button>
                      <button class="mini ghost" :disabled="beam.source === 'user' && !beam.file" @click="exportBeam(sat, beam)">导出 GXT</button>
                      <button class="mini ghost" :disabled="!beam.file" @click="exportBeamKml(sat, beam)">导出 KML</button>
                      <button class="mini del" @click="removeGxtBeam(sat, beam)">删除</button>
                    </span>
                  </div>
                  <div v-if="!sat.beams.length" class="noant">暂无波束。</div>
                </template>
              </div>
            </div>
          </section>
        </div>
      </div>

      <div v-if="confirmMsg" class="cmask">
        <div class="cbox">
          <div class="cmsg">{{ confirmMsg }}</div>
          <div class="cbtns">
            <button class="mini ghost" @click="answerConfirm(false)">取消</button>
            <button class="mini imp" @click="answerConfirm(true)">确定</button>
          </div>
        </div>
      </div>

      <footer class="dft">
        <span class="msg">{{ msg }}</span>
        <button class="ok" @click="emit('close')">完成</button>
      </footer>
    </div>
    <MiniSendDialog v-model:open="fpMiniOpen" :build="() => fpMiniPack || { name: '', items: [] }"
      :device-id="fpMiniDeviceId" :configured="fpMiniConfigured" @toast="flash" />
    <template v-if="expMenu.key">
      <div class="expback" @click="expMenu = { key: '', x: 0, y: 0, ant: null }"></div>
      <div class="expmenu" :style="{ left: expMenu.x + 'px', top: expMenu.y + 'px' }">
        <button v-for="f in EXP_FMTS" :key="f.id" @click="doExport(f.id)">{{ f.label }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; }
.dlg { position: relative; width: 980px; max-width: calc(100vw - 32px); height: 680px; max-height: calc(100vh - 64px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); box-shadow: var(--shadow-3); overflow: hidden; }
.dhd { display: flex; align-items: stretch; justify-content: space-between; border-bottom: 1px solid var(--border); }
.dt { font-family: var(--font-serif); font-size: var(--fs-5); padding: 11px 16px; align-self: center; }
/* Windows 风格关闭：整块矩形热区，悬停变红 */
.winx { width: 44px; align-self: stretch; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background .12s, color .12s; }
.winx:hover { background: #c42b1c; color: #fff; }
.wrap { flex: 1; min-height: 0; display: flex; }
.rail { width: 128px; flex: none; padding: 8px; border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; }
.rb { display: flex; align-items: center; padding: 8px 11px; border: 0; background: transparent; color: var(--text-muted);
  text-align: left; cursor: pointer; border-radius: var(--r-ctl); font-size: var(--fs-4); border-left: 2px solid transparent; transition: background .12s, color .12s; }
.rb:hover { background: var(--bg); color: var(--text); }
.rb.on { background: var(--bg); color: var(--text); border-left-color: var(--accent); }
.pane { flex: 1; min-width: 0; overflow: auto; padding: 14px 16px; }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-4); }
.tbl th { text-align: left; color: var(--text-faint); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--border); font-size: var(--fs-3); }
.tbl td { padding: 7px 8px; border-bottom: 1px solid var(--border); color: var(--text); }
.tbl td.nm { font-weight: 600; }
.tbl td.dim, .dim { color: var(--text-faint); }
.tbl td.ops { text-align: right; white-space: nowrap; }
.badge { font-size: var(--fs-2); padding: 1px 7px; border-radius: var(--r-ctl); border: 1px solid var(--border); background: transparent; color: var(--text-muted); }
.badge.off { color: var(--text-faint); }
/* 内置兜底快照：区别于「已缓存」（用户联网数据），用低调蓝调描边表示软件自带 */
.badge.bundled { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
/* 统一低调描边按钮（去掉满屏亮色实心），主次靠位置与标签区分 */
.mini { padding: 3px 10px; margin-left: 6px; cursor: pointer; font-size: var(--fs-3); border-radius: var(--r-ctl);
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  background: var(--bg); border: 1px solid var(--border); color: var(--text-muted); transition: color .12s, border-color .12s; }
.mini:hover { color: var(--text); border-color: var(--accent); }
.mini:disabled { opacity: .4; cursor: not-allowed; }
.mini:disabled:hover { color: var(--text-muted); border-color: var(--border); }
.mini.ghost { color: var(--text-muted); }
.mini.del { color: var(--text-muted); }
.mini.del:hover { color: #d07a72; border-color: #d07a72; }
.empty-hint { padding: 28px 12px; text-align: center; color: var(--text-faint); font-size: var(--fs-4); line-height: 1.7; }
.tree { display: flex; flex-direction: column; gap: 10px; }
.tnode { border: 1px solid var(--border); border-radius: var(--r-ctl); overflow: hidden; }
.trow { display: flex; align-items: center; gap: 10px; padding: 7px 10px; }
.trow.sat { background: var(--bg); border-bottom: 1px solid var(--border); }
.trow.ant { padding-left: 22px; border-bottom: 1px solid var(--border); }
.trow.ant:last-child { border-bottom: 0; }
.tname { font-size: var(--fs-4); color: var(--text); font-weight: 600; }
.trow.ant .tname { font-weight: 500; }
.tcount, .tmeta { font-size: var(--fs-3); color: var(--text-faint); }
.trops { margin-left: auto; white-space: nowrap; display: flex; }
/* 导出格式菜单：定位用 fixed —— .tnode 的 overflow:hidden 会裁掉行内绝对定位的浮层 */
.expback { position: fixed; inset: 0; z-index: 2100; }
.expmenu { position: fixed; z-index: 2101; transform: translateX(-100%); min-width: 148px; padding: 4px 0;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-ctl); box-shadow: var(--shadow-2);
  display: flex; flex-direction: column; }
.expmenu button { appearance: none; border: 0; background: none; color: var(--text-muted); text-align: left;
  padding: 5px 14px; font-size: var(--fs-3); cursor: pointer; white-space: nowrap; }
.expmenu button:hover { background: var(--accent); color: var(--bg); }
.noant { padding: 8px 22px; font-size: var(--fs-3); color: var(--text-faint); }
.trow.sat.clk { cursor: pointer; }
.trow.sat.clk:hover { background: var(--surface); }
.tw { width: 12px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); flex: none; }
.addbar, .addbeam { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.addbar.sub { margin-top: -4px; margin-bottom: 14px; }
.mini.imp { margin-left: 0; color: var(--accent); border-color: var(--accent); height: var(--h-ctl-lg); white-space: nowrap; padding: 0 14px; }
.mini.imp:hover { background: var(--accent); color: var(--bg); }
.dimnote { font-size: var(--fs-2); color: var(--text-faint); }
.addbeam { padding: 8px 10px 8px 22px; background: var(--bg); border-bottom: 1px solid var(--border); margin: 0; }
/* 显式允许文本选择：全局 body 设了 user-select:none，继承到输入框在 Electron 的 Chromium 下会
   阻止「点击放置光标」（表现为点不进、只能程序聚焦）。这里强制恢复，保证可点击聚焦与选词。 */
.ci { border: 1px solid var(--border); background-color: var(--bg); color: var(--text); padding: 5px 8px; outline: none; font-size: var(--fs-4); border-radius: var(--r-ctl); min-width: 0; user-select: text; -webkit-user-select: text; }
.ci:focus { border-color: var(--accent-ui); }
.ci.nar { width: 96px; flex: none; }
.ci.wide { width: 150px; flex: none; }
/* 天线名可点重命名：悬停提示可交互 */
.tname.rn { cursor: pointer; }
.tname.rn:hover { color: var(--accent); }
/* 宿主卫星已不在树中的频率计划：标黄而不隐藏——条目还在，只是需要重新指定卫星 */
.tname.orphanname { color: var(--warn); font-weight: 500; }
.addbar .ci:first-child { width: 180px; flex: none; }
.spacer { flex: 1; }
/* 应用内确认弹窗（覆盖在文件管理器之上，居中） */
.cmask { position: absolute; inset: 0; z-index: 10; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; }
.cbox { width: 340px; max-width: calc(100% - 48px); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); box-shadow: var(--shadow-3); padding: 18px 18px 14px; }
.cmsg { font-size: var(--fs-4); color: var(--text); line-height: 1.6; margin-bottom: 16px; }
.cbtns { display: flex; justify-content: flex-end; gap: 8px; }
.cbtns .mini { margin-left: 0; height: var(--h-ctl-lg); white-space: nowrap; padding: 0 16px; }
.dft { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-top: 1px solid var(--border); }
.dft .msg { flex: 1; font-size: var(--fs-3); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dft button { height: var(--h-ctl-lg); white-space: nowrap; padding: 0 18px; cursor: pointer; border-radius: var(--r-ctl); font-size: var(--fs-4); }
.ok { background: var(--accent); border: 1px solid var(--accent); color: var(--bg); }
/* 自定义卫星：轻量分区（与星座列表同风格），非大块卡片 */
.secbar { display: flex; align-items: center; gap: 8px; padding-bottom: 6px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
.secbar.top { margin-top: 18px; }
.sect { font-size: var(--fs-4); color: var(--text); font-weight: 600; }
.sctag { font-size: var(--fs-2); color: var(--text-faint); }
.secbar .mini { margin-left: 0; }
.clist { display: flex; flex-direction: column; }
.csub { font-size: var(--fs-2); color: var(--text-faint); padding: 8px 4px 4px; letter-spacing: var(--ls-tight); }
.crow { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-bottom: 1px solid var(--border); }
.crow:last-child { border-bottom: 0; }
.cdot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; opacity: .85; }
.cdot.imp { background: var(--text-muted); }
.cnm { font-size: var(--fs-4); color: var(--text); font-weight: 500; flex: none; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cnm.rn { cursor: pointer; }
.cnm.rn:hover { color: var(--accent); }
.ci.cnmedit { width: 200px; flex: none; padding: 3px 8px; }
.cmeta { font-size: var(--fs-3); color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cops { margin-left: auto; flex: none; display: flex; align-items: center; gap: 2px; }
.cops .mini { margin-left: 4px; height: var(--h-ctl); white-space: nowrap; padding: 0 9px; }
.cro { font-size: var(--fs-2); color: var(--text-faint); opacity: .8; margin-left: 6px; }
.cempty { padding: 12px 4px; font-size: var(--fs-3); color: var(--text-faint); line-height: 1.6; }
/* MODCOD 表：标准页签在上、网格吃掉剩余高度（整页不滚，只网格自己滚——60 行的 S2X 表若跟着整页滚，
   列头一滚就没了）。故这一页的 .pane 关掉溢出，由 .mcsec 撑满并把高度让给网格。 */
.pane.fill { overflow: hidden; }
.mcsec { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.mctabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; flex: none; }
.mctab { display: inline-flex; align-items: center; gap: 5px; padding: 0 10px; height: var(--h-ctl); cursor: pointer;
  background: var(--bg); border: 1px solid var(--border); color: var(--text-muted); border-radius: var(--r-ctl); font-size: var(--fs-3); }
.mctab:hover { color: var(--text); border-color: var(--accent-ui); }
.mctab.on { color: var(--text); border-color: var(--accent-ui); background: color-mix(in srgb, var(--accent-ui) 12%, transparent); }
.mctab .mcn { font-style: normal; color: var(--text-faint); font-size: var(--fs-2); }
.mctab .mcmod { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.mcbar { display: flex; align-items: center; gap: 8px; padding-bottom: 6px; margin-bottom: 8px; border-bottom: 1px solid var(--border); flex: none; }
.mcbar .mini { margin-left: 0; }
.mcname { font-size: var(--fs-4); color: var(--text); font-weight: 600; }
.mcname.rn { cursor: pointer; }
.mcname.rn:hover { color: var(--accent); }
.mcgrid { flex: 1; min-height: 0; overflow: auto; outline: none; border: 1px solid var(--border); border-radius: var(--r-ctl); }
/* 调制方式下拉底部的「按族 + 阶数现造」条（ExcelGrid 的 pick-foot 插槽，故不带 .mcgrid 前缀也进不到别处） */
.mcgen { flex: none; border-top: 1px solid var(--border); padding: 6px 8px; display: flex; flex-direction: column; gap: 5px; }
.mcgen-r { display: flex; align-items: center; gap: 5px; }
.mcgen-f { flex: 1; padding: 2px 0; border: 1px solid var(--border); background: var(--bg); color: var(--text-muted);
  border-radius: var(--r-ctl); font-size: var(--fs-2); cursor: pointer; }
.mcgen-f.on { border-color: var(--accent-ui); color: var(--text); background: color-mix(in srgb, var(--accent-ui) 14%, transparent); }
.mcgen-m { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-2); color: var(--text-faint); flex: none; }
.mcgen-m .ci { width: 56px; padding: 2px 6px; font-size: var(--fs-3); font-family: var(--font-mono); }
.mcgen-o { flex: 1; min-width: 0; font-size: var(--fs-2); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcgen-o.bad { color: var(--warn); }
.mcgen .mini { margin-left: 0; height: var(--h-ctl); padding: 0 10px; }
</style>
