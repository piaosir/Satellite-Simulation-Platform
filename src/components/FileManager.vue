<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { fileBridge, bumpLibrary, bumpCustomSats } from '../stores/fileBridge'
import { readCustomConstellationSummary, customConstellationsToOmmRecords, renameCustomConstellation } from '../viz/constellation/useCustomConstellations.js'
import { parseGxt, metaFromName } from '../viz/gxt/parse.js'
import { serializeGxt } from '../viz/gxt/serialize.js'
import { grdToStkAzEl } from '../viz/grd/stkPattern.js'
import { repackGrdCommonGrid } from '../viz/grd/synth.js'
import { displaySatName } from '../viz/satName.js'
import { logMsg } from '../stores/log'
import Icon from './Icon.vue'

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
  const r = await api.omm.export(row.key)
  if (r && r.canceled) return
  if (r && r.ok) flash('已导出：' + r.filePath)
  else flash('导出失败：' + ((r && r.error) || '未知错误'))
}

/* ---- 自定义卫星（逐条配置：各自导入/导出/删除，无全局合并）----
   两类条目、与「星座地图 3D」星座列表同源：
   ① 自建星座（Walker，localStorage）——历元=场景历元；只读镜像(在「星座3D」增删)，可逐座导出星历；
   ② 导入组（每个导入的 OMM/TLE 文件 = 一组，主进程 custom.json）——历元=文件内；可逐组导出/删除。
   两类都并入地图「自定义卫星」分组与链路预算搜索池。 */
const customGroups = ref([])        // 导入组 [{ id, name, importedAt, format, count, sats:[...] }]
const customConsts = ref([])        // 自建星座概览 [{ id, name, incl, count, color }]
const customBusy = ref(false)
const hasCustomAny = computed(() => customGroups.value.length > 0 || customConsts.value.length > 0)
async function loadCustomGroups() { try { const r = api?.omm?.customList ? await api.omm.customList() : null; customGroups.value = (r && r.groups) || [] } catch { customGroups.value = [] } }
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
  const r = await api.omm.customExportGroup(g.id, g.name)
  if (r && r.canceled) return
  if (r && r.ok) flash('已导出：' + r.filePath)
  else flash('导出失败：' + ((r && r.error) || '未知错误'))
}
// 逐座导出（自建星座：场景历元，展开为 OMM 记录传给主进程序列化保存）
async function exportConstellation(c) {
  if (!api?.omm?.exportOmmCsv) return
  let recs = []
  try { recs = customConstellationsToOmmRecords(c.id) } catch { recs = [] }
  if (!recs.length) { flash('该星座无可导出的卫星'); return }
  const r = await api.omm.exportOmmCsv(recs, c.name)
  if (r && r.canceled) return
  if (r && r.ok) flash('已导出：' + r.filePath)
  else flash('导出失败：' + ((r && r.error) || '未知错误'))
}
const fmtGroupMeta = (g) => `${g.count} 颗 · ${g.format === 'tle' ? 'TLE' : 'OMM'} · ${fmtTime(g.importedAt)}`

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
  return lon != null ? lon.toFixed(1) + '°E · ' : ''
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
async function exportGrdAnt(a) {
  if (!a.imported || !a.file) { flash('预置天线无原始 GRD 可导出'); return }
  try {
    const r = await api.coverageGrd.raw(a.file)
    // 合成的多馈源 .grd 各波束用各自小窗口，SATSOFT 会把全部波束摆到波束1处（见 repackGrdCommonGrid 注释）。
    // 导出前重打包到公共网格（各波束落真实位置）；仅对本平台合成件(含 SYNTHMETA)生效，真实导入件原样导出。
    let text = r.text
    if (text && text.includes('SYNTHMETA')) { try { text = repackGrdCommonGrid(text) } catch (err) { console.warn('公共网格重打包失败，导出原始多窗口 .grd', err) } }
    const save = await api.exportFile({ defaultName: `${a.name}.grd`, data: toBytes(text), filters: [{ name: 'GRASP 网格', extensions: ['grd'] }] })
    if (save && save.ok) flash('已导出：' + save.filePath)
    else if (save && save.error) flash('导出失败：' + save.error)
  } catch (e) { flash('导出失败：' + (e.message || e)) }
}
// 导出为 STK 外部天线方向图（AzElPattern，增益 dBi）：解析 GRD → az/el 增益网格 → STK ASCII。
// 多波束合成为最大值包络（STK 每文件只读一个方向图）。文件为纯 ASCII，扩展名用 STK 常见的 .txt。
async function exportGrdAntStk(a) {
  if (!a.imported || !a.file) { flash('预置天线无原始 GRD 可导出'); return }
  try {
    const r = await api.coverageGrd.raw(a.file)
    const stk = grdToStkAzEl(r.text, { name: a.name })
    const save = await api.exportFile({ defaultName: `${a.name}_STK.txt`, data: toBytes(stk.text), filters: [{ name: 'STK 外部天线方向图', extensions: ['txt', 'pattern', 'ant'] }, { name: '所有文件', extensions: ['*'] }] })
    if (save && save.ok) flash(`已导出 STK 方向图（${stk.nx}×${stk.ny} · ${stk.nBeams} 波束 · 峰值 ${stk.peakDbi.toFixed(1)} dBi）：` + save.filePath)
    else if (save && save.error) flash('导出失败：' + save.error)
  } catch (e) { flash('导出失败：' + (e.message || e)) }
}

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
      n.beams.push({ key: 'u:' + b.id, id: b.id, name: b.name, type: b.type, band: b.band, file: b.file, rawFile: b.rawFile, contours: b.contours, importedAt: b.importedAt, source: 'user' })
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
const newSat = ref({ name: '', lon: '' })
const addBeamFor = ref('')          // 正在添加波束的卫星 id
const newBeam = ref({ name: '', type: 'EIRP', band: '' })
async function loadGxt() { try { gxtIndex.value = api?.coverageGxt ? await api.coverageGxt.index() : { satellites: [] } } catch { gxtIndex.value = { satellites: [] } } }
// 批量导入：多选 .gxt → 按文件名（卫星_频段_波束_类型）自动归类建星/建波束并导入，一次完成
async function importGxtBatch() {
  const res = await api.coverageGxt.open()
  if (!res || res.canceled) return
  const files = res.files || []
  const items = [], errs = []
  for (const f of files) {
    if (f.error || !f.text) { errs.push((f.base || '文件') + '：' + (f.error || '空文件')); continue }
    let parsed
    try { parsed = parseGxt(f.text) } catch (e) { errs.push((f.base || '文件') + '：解析失败 ' + (e.message || e)); continue }
    const meta = metaFromName(f.base)
    items.push({
      satName: meta.sat || meta.name, lon: parsed.lon, beamName: meta.beam || meta.name,
      type: meta.type || 'EIRP', band: meta.band || '', rawText: f.text, sourceName: f.base,
      json: { sat: meta.sat, band: meta.band, beam: meta.beam, type: meta.type || 'EIRP', lon: parsed.lon, bore: parsed.bore, contours: parsed.contours }
    })
  }
  if (!items.length) { flash('未能导入：' + (errs[0] || '没有有效的 GXT 文件')); return }
  const r = await api.coverageGxt.importBatch(items)
  await loadGxt(); bumpLibrary()
  // 自动展开本次涉及的卫星，便于查看（节点按名合并，key = 'g:'+小写名）
  const exp = { ...gxtExpanded.value }
  for (const it of items) exp['g:' + String(it.satName || '').toLowerCase()] = true
  gxtExpanded.value = exp
  flash(`导入 ${items.length} 个文件 → 新增 ${r.sats} 卫星 / ${r.beams} 波束` + (errs.length ? `（${errs.length} 个失败）` : ''))
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
async function importGxtToBeam(node, beam) {
  const res = await api.coverageGxt.open()
  if (!res || res.canceled) return
  const files = res.files || []
  const f = files[0]
  if (!f || f.error || !f.text) { flash('读取失败：' + ((f && f.error) || '空文件')); return }
  let parsed
  try { parsed = parseGxt(f.text) } catch (e) { flash('GXT 解析失败：' + (e.message || e)); return }
  const meta = metaFromName(f.base)
  const json = {
    sat: meta.sat, band: beam.band || meta.band, beam: beam.name || meta.beam, type: beam.type || meta.type || 'EIRP',
    lon: parsed.lon, bore: parsed.bore, contours: parsed.contours
  }
  const r = await api.coverageGxt.attach(node.userSatId, beam.id, { rawText: f.text, sourceName: f.base, json, type: json.type, band: json.band })
  if (r && r.ok) { flash(`已导入 ${f.base}（${parsed.contours.length} 条等值线）`); await loadGxt(); bumpLibrary() }
  else flash('导入失败：' + ((r && r.error) || '未知'))
}
async function exportGxtBeam(beam) {
  if (!beam.rawFile && !beam.file) { flash('该波束尚未导入 GXT'); return }
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

onMounted(() => { loadOmm(); loadCustomGroups(); loadCustomConsts(); loadGxt(); loadPreset() })
</script>

<template>
  <div class="mask">
    <div class="dlg" role="dialog" aria-modal="true">
      <header class="dhd">
        <span class="dt">文件管理</span>
        <button class="winx" type="button" aria-label="关闭" title="关闭" @click="emit('close')">
          <Icon name="x" :size="11" />
        </button>
      </header>

      <div class="wrap">
        <nav class="rail">
          <button class="rb" :class="{ on: tab === 'omm' }" @click="tab = 'omm'">星历 OMM</button>
          <button class="rb" :class="{ on: tab === 'grd' }" @click="tab = 'grd'">GRD 天线</button>
          <button class="rb" :class="{ on: tab === 'gxt' }" @click="tab = 'gxt'">GXT 文件管理</button>
        </nav>

        <div class="pane">
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
                  <span class="cnm rn" title="点击改名" @click="startRenameCust('k' + c.id, c.name)">{{ c.name }}</span>
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
                  <span class="cnm rn" title="点击改名" @click="startRenameCust('g' + g.id, g.name)">{{ g.name }}</span>
                  <span class="cmeta">{{ fmtGroupMeta(g) }}</span>
                  <span class="cops">
                    <button class="mini ghost" @click="exportGroup(g)">导出</button>
                    <button class="mini del" @click="removeCustomGroup(g)">删除</button>
                  </span>
                </template>
              </div>
              <div v-if="!hasCustomAny" class="cempty">暂无自定义卫星 — 点「导入星历」加载 OMM CSV / TLE（每文件成一组，支持一文件多星、Alpha-5 编号），或在「星座地图 3D」用 Walker 生成器自建星座。</div>
            </div>

            <div class="secbar top"><span class="sect">内置星座组</span></div>
            <p class="lead">每组对应一份 CelesTrak OMM（CSV）。软件已内置一份最新快照，无网络时也能查看星座；联网时自动改用更新的一版。可导入本地文件替换、或导出当前数据。</p>
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
            <p class="lead">卫星 / 天线树（与「星座地图 3D」的覆盖分析共用）。「添加 / 编辑卫星」会在本窗口之上弹出覆盖分析的同一弹窗（定位方式 / 星座关联一应俱全，仅隐藏图标·字号·仰角线·颜色等显示项）。也可导入 GRD 新建天线、重命名、导出原始 GRD。</p>
            <div v-if="!grdApi" class="empty-hint">GRD 数据随「星座地图 3D」加载——请切换到该页面后再来管理。</div>
            <template v-else>
              <div class="addbar sub">
                <button class="mini imp" @click="openAddGrdSat"><Icon name="plus" :size="12" /> 添加卫星</button>
                <span class="dimnote">支持固定经纬度 / 轨道根数定位</span>
              </div>
              <div v-if="!grdSats.length" class="empty-hint">暂无卫星。可点「添加卫星」新建一颗，或为卫星导入 GRD。</div>
              <div v-else class="tree">
                <div v-for="sat in grdSats" :key="sat.folder" class="tnode">
                  <div class="trow sat">
                    <span class="tname">{{ sat.satName }}</span>
                    <span class="tcount">{{ grdLonText(sat) }}{{ sat.antennas.length }} 天线</span>
                    <span class="trops">
                      <button class="mini" @click="openEditGrdSat(sat)">编辑</button>
                      <button class="mini" @click="importGrd(sat)"><Icon name="plus" :size="12" /> 导入 GRD</button>
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
                      <span class="tname rn" title="点击重命名" @click="startRenameGrdAnt(sat, a)">{{ a.name }}</span>
                      <span class="tmeta">{{ a.beams }} 波束 · {{ a.imported ? '导入' : '预置' }}<template v-if="a.peakDb != null"> · 峰值 {{ Number(a.peakDb).toFixed(1) }} dB</template></span>
                      <span class="trops">
                        <button class="mini ghost" @click="startRenameGrdAnt(sat, a)">改名</button>
                        <button class="mini ghost" :disabled="!a.imported" title="导出原始 GRASP ASCII 网格" @click="exportGrdAnt(a)">导出 GRD</button>
                        <button class="mini ghost" :disabled="!a.imported" title="导出为 STK 外部天线方向图（AzElPattern，增益 dBi）" @click="exportGrdAntStk(a)">导出 STK</button>
                        <button class="mini del" @click="removeGrdAnt(sat, a)">删除</button>
                      </span>
                    </template>
                  </div>
                  <div v-if="!sat.antennas.length" class="noant">暂无天线 — 点上方「导入 GRD」</div>
                </div>
              </div>
            </template>
          </section>

          <!-- ③ GXT -->
          <section v-else-if="tab === 'gxt'">
            <p class="lead">卫星 → 波束 → GXT 文件。直接「导入 GXT 文件」可多选一批，按文件名（卫星_频段_波束_类型）自动归类建立卫星与波束；导入后能在 3D 页「覆盖图（GXT）」面板选用绘制。软件自带的默认覆盖只读、可导出。</p>

            <div class="addbar">
              <button class="mini imp" @click="importGxtBatch">导入 GXT 文件…</button>
              <span class="dimnote">可多选，按文件名自动归类</span>
              <span class="spacer"></span>
              <button class="mini ghost" :disabled="!canExportCurrent" title="把 3D 页当前绘制的覆盖（GXT/GRD 来源）转为 GXT 文件导出" @click="exportCurrentGxt">当前覆盖转为 GXT 导出</button>
            </div>
            <div class="addbar sub">
              <span class="dimnote">或手动新建：</span>
              <input class="ci" v-model="newSat.name" placeholder="卫星名" @keydown.enter="addGxtSat" />
              <input class="ci nar" v-model="newSat.lon" placeholder="经度°E" @keydown.enter="addGxtSat" />
              <button class="mini ghost" @click="addGxtSat"><Icon name="plus" :size="12" /> 空白卫星</button>
            </div>

            <div v-if="!allSats.length" class="empty-hint">暂无覆盖数据。可新建卫星并导入 GXT。</div>
            <div v-else class="tree">
              <div v-for="sat in allSats" :key="sat.key" class="tnode">
                <div class="trow sat clk" @click="toggleSat(sat.key)">
                  <span class="tw"><Icon :name="gxtExpanded[sat.key] ? 'chevron-down' : 'chevron-right'" :size="12" /></span>
                  <span class="tname">{{ sat.name }}</span>
                  <span class="tcount">{{ (sat.lon != null ? sat.lon + '°E · ' : '') }}{{ sat.beams.length }} 波束</span>
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
                    <span class="tname">{{ beam.name }}</span>
                    <span class="tmeta">
                      <template v-if="beam.source === 'preset'">{{ beam.type }}<template v-if="beam.band"> · {{ beam.band }}</template> · {{ beam.meta }}</template>
                      <template v-else-if="beam.file">{{ beam.type }}<template v-if="beam.band"> · {{ beam.band }}</template> · {{ beam.contours }} 等值线 · {{ fmtTime(beam.importedAt) }}</template>
                      <template v-else><span class="dim">未导入 GXT</span></template>
                    </span>
                    <span class="trops">
                      <button v-if="beam.source === 'user'" class="mini" @click="importGxtToBeam(sat, beam)">{{ beam.file ? '重新导入' : '导入 GXT' }}</button>
                      <button class="mini ghost" :disabled="beam.source === 'user' && !beam.file" @click="exportBeam(sat, beam)">导出 GXT</button>
                      <button class="mini del" @click="removeGxtBeam(sat, beam)">删除</button>
                    </span>
                  </div>
                  <div v-if="!sat.beams.length" class="noant">暂无波束 — 点上方「＋ 波束」</div>
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
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; }
.dlg { position: relative; width: 860px; max-width: calc(100vw - 32px); height: 620px; max-height: calc(100vh - 64px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 2px; box-shadow: 0 10px 32px rgba(0,0,0,0.45); overflow: hidden; }
.dhd { display: flex; align-items: stretch; justify-content: space-between; border-bottom: 1px solid var(--border); }
.dt { font-family: var(--font-serif); font-size: 14px; padding: 11px 16px; align-self: center; }
/* Windows 风格关闭：整块矩形热区，悬停变红 */
.winx { width: 44px; align-self: stretch; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background .12s, color .12s; }
.winx:hover { background: #c42b1c; color: #fff; }
.wrap { flex: 1; min-height: 0; display: flex; }
.rail { width: 128px; flex: none; padding: 8px; border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; }
.rb { display: flex; align-items: center; padding: 8px 11px; border: 0; background: transparent; color: var(--text-muted);
  text-align: left; cursor: pointer; border-radius: 2px; font-size: 12.5px; border-left: 2px solid transparent; transition: background .12s, color .12s; }
.rb:hover { background: var(--bg); color: var(--text); }
.rb.on { background: var(--bg); color: var(--text); border-left-color: var(--accent); }
.pane { flex: 1; min-width: 0; overflow: auto; padding: 14px 16px; }
.lead { font-size: 12px; color: var(--text-faint); line-height: 1.6; margin: 0 0 12px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tbl th { text-align: left; color: var(--text-faint); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--border); font-size: 11.5px; }
.tbl td { padding: 7px 8px; border-bottom: 1px solid var(--border); color: var(--text); }
.tbl td.nm { font-weight: 600; }
.tbl td.dim, .dim { color: var(--text-faint); }
.tbl td.ops { text-align: right; white-space: nowrap; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 2px; border: 1px solid var(--border); background: transparent; color: var(--text-muted); }
.badge.off { color: var(--text-faint); }
/* 内置兜底快照：区别于「已缓存」（用户联网数据），用低调蓝调描边表示软件自带 */
.badge.bundled { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
/* 统一低调描边按钮（去掉满屏亮色实心），主次靠位置与标签区分 */
.mini { padding: 3px 10px; margin-left: 6px; cursor: pointer; font-size: 11.5px; border-radius: 2px;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  background: var(--bg); border: 1px solid var(--border); color: var(--text-muted); transition: color .12s, border-color .12s; }
.mini:hover { color: var(--text); border-color: var(--accent); }
.mini:disabled { opacity: .4; cursor: not-allowed; }
.mini:disabled:hover { color: var(--text-muted); border-color: var(--border); }
.mini.ghost { color: var(--text-muted); }
.mini.del { color: var(--text-muted); }
.mini.del:hover { color: #d07a72; border-color: #d07a72; }
.empty-hint { padding: 28px 12px; text-align: center; color: var(--text-faint); font-size: 12.5px; line-height: 1.7; }
.tree { display: flex; flex-direction: column; gap: 10px; }
.tnode { border: 1px solid var(--border); border-radius: 2px; overflow: hidden; }
.trow { display: flex; align-items: center; gap: 10px; padding: 7px 10px; }
.trow.sat { background: var(--bg); border-bottom: 1px solid var(--border); }
.trow.ant { padding-left: 22px; border-bottom: 1px solid var(--border); }
.trow.ant:last-child { border-bottom: 0; }
.tname { font-size: 12.5px; color: var(--text); font-weight: 600; }
.trow.ant .tname { font-weight: 500; }
.tcount, .tmeta { font-size: 11.5px; color: var(--text-faint); }
.trops { margin-left: auto; white-space: nowrap; display: flex; }
.noant { padding: 8px 22px; font-size: 11.5px; color: var(--text-faint); }
.trow.sat.clk { cursor: pointer; }
.trow.sat.clk:hover { background: var(--surface); }
.tw { width: 12px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); flex: none; }
.addbar, .addbeam { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.addbar.sub { margin-top: -4px; margin-bottom: 14px; }
.mini.imp { margin-left: 0; color: var(--accent); border-color: var(--accent); padding: 4px 14px; }
.mini.imp:hover { background: var(--accent); color: var(--bg); }
.dimnote { font-size: 11px; color: var(--text-faint); }
.addbeam { padding: 8px 10px 8px 22px; background: var(--bg); border-bottom: 1px solid var(--border); margin: 0; }
/* 显式允许文本选择：全局 body 设了 user-select:none，继承到输入框在 Electron 的 Chromium 下会
   阻止「点击放置光标」（表现为点不进、只能程序聚焦）。这里强制恢复，保证可点击聚焦与选词。 */
.ci { border: 1px solid var(--border); background: var(--bg); color: var(--text); padding: 5px 8px; outline: none; font-size: 12.5px; border-radius: 2px; min-width: 0; user-select: text; -webkit-user-select: text; }
.ci:focus { border-color: var(--accent); }
.ci.nar { width: 96px; flex: none; }
.ci.wide { width: 150px; flex: none; }
/* 天线名可点重命名：悬停提示可交互 */
.tname.rn { cursor: pointer; }
.tname.rn:hover { color: var(--accent); }
.addbar .ci:first-child { width: 180px; flex: none; }
.spacer { flex: 1; }
/* 应用内确认弹窗（覆盖在文件管理器之上，居中） */
.cmask { position: absolute; inset: 0; z-index: 10; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; }
.cbox { width: 340px; max-width: calc(100% - 48px); background: var(--surface); border: 1px solid var(--border-strong); border-radius: 2px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); padding: 18px 18px 14px; }
.cmsg { font-size: 13px; color: var(--text); line-height: 1.6; margin-bottom: 16px; }
.cbtns { display: flex; justify-content: flex-end; gap: 8px; }
.cbtns .mini { margin-left: 0; padding: 5px 16px; }
.dft { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-top: 1px solid var(--border); }
.dft .msg { flex: 1; font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dft button { padding: 6px 18px; cursor: pointer; border-radius: 2px; font-size: 12.5px; }
.ok { background: var(--accent); border: 1px solid var(--accent); color: var(--bg); }
/* 自定义卫星：轻量分区（与星座列表同风格），非大块卡片 */
.secbar { display: flex; align-items: center; gap: 8px; padding-bottom: 6px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
.secbar.top { margin-top: 18px; }
.sect { font-size: 12.5px; color: var(--text); font-weight: 600; }
.sctag { font-size: 11px; color: var(--text-faint); }
.secbar .mini { margin-left: 0; }
.clist { display: flex; flex-direction: column; }
.csub { font-size: 11px; color: var(--text-faint); padding: 8px 4px 4px; letter-spacing: .02em; }
.crow { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-bottom: 1px solid var(--border); }
.crow:last-child { border-bottom: 0; }
.cdot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; opacity: .85; }
.cdot.imp { background: var(--text-muted); }
.cnm { font-size: 12.5px; color: var(--text); font-weight: 500; flex: none; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cnm.rn { cursor: pointer; }
.cnm.rn:hover { color: var(--accent); }
.ci.cnmedit { width: 200px; flex: none; padding: 3px 8px; }
.cmeta { font-size: 11.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cops { margin-left: auto; flex: none; display: flex; align-items: center; gap: 2px; }
.cops .mini { margin-left: 4px; padding: 2px 9px; }
.cro { font-size: 10.5px; color: var(--text-faint); opacity: .8; margin-left: 6px; }
.cempty { padding: 12px 4px; font-size: 11.5px; color: var(--text-faint); line-height: 1.6; }
</style>
