<script setup>
// 可编程导入：把任意格式的波束地图文件（私有格式、第三方导出…）交给用户脚本解析，导入覆盖库（波束地图库）。
// 与「可编程波束地图」导出对话框（BeamScriptDialog.vue）对称：同一个沙箱 Worker、同一个编辑器、同一套脚本库手感 ——
//   内置模板 = 本软件认得的各种格式的解析器本身（GXT / KML / GeoJSON / CSV / Shapefile / MapInfo / 基带网管 …），复制一份就能改；
//   导入脚本返回「波束」，形状与导出脚本读到的 data.beams 相同（见 shared/beamScript/importModel.js）。
// 脚本头部写了「//! match: *.xxx」（可加「//! sniff: 正则」）的，文件管理「导入…」遇到认不出的文件会自动交给它。
import { ref, shallowRef, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import AppDialog from './AppDialog.vue'
import Icon from './Icon.vue'
import { createBeamScriptRunner } from '../viz/beamScript/runner.js'
import { loadMonaco, setScriptMode } from '../viz/beamScript/monaco.js'
import { builtinImportTemplates, blankImportScript, loadScripts, saveScripts, newScriptId, newScriptName, copyScriptName, uniqueName, IMPORT_NS } from '../viz/beamScript/library.js'
import { scriptMatchInfo, acceptingOrder, recognized } from '../shared/beamScript/importRuntime.js'
import { workerExec } from '../viz/beamScript/importDispatch.js'
import { sniffDecode } from '../shared/beamScript/importStdlib.js'
import { toLibraryItems } from '../shared/beamScript/importModel.js'
import { beamColor } from '../viz/beammap/useBeamMapDisplay.js'
import { bumpLibrary } from '../stores/fileBridge'
import { curLang, byLang } from '../shared/i18n/lang.js'
import { onLangChange } from '../shared/i18n/runtime.js'
import { reportError } from '../shared/reportError.js'

const props = defineProps({
  files: { type: Array, default: () => [] },     // 初始输入文件 [{ name, bytes:Uint8Array }]
  layer: { type: String, default: 'dialog' }      // 从文件管理里开（压在它上面）传 'pop'，见 AppDialog
})
const emit = defineEmits(['close', 'imported'])

const UI_KEY = 'beamImport/ui'
const ui = reactive((() => {
  const d = { sel: 'b:constellation-opt', tab: 'res', live: true, rightW: 0 }
  try { return { ...d, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') } } catch { return d }
})())
watch(ui, (v) => { try { localStorage.setItem(UI_KEY, JSON.stringify(v)) } catch { /* 隐私模式：只是不记住 */ } }, { deep: true })

const lang = ref(curLang())
const templates = computed(() => builtinImportTemplates(lang.value))
const scripts = ref([])
const inputs = shallowRef((props.files || []).filter((f) => f && f.bytes).map((f) => ({ name: String(f.name), bytes: f.bytes })))
// 文件管理「导入…」那边已经试过、没认出这个文件的候选键（随文件带来的 tried：内置解析器 + 导入脚本），自动挑脚本时跳过
const failedFor = new Map((props.files || []).filter((f) => f && f.name && Array.isArray(f.tried)).map((f) => [String(f.name).toLowerCase(), new Set(f.tried)]))
let pickSeq = 0   // 自动挑脚本（autoPick）的轮次：换输入 / 动手改代码 / 卸载都 +1，进行中的试跑回来据此作废
const inSel = ref(0)

const edEl = ref(null), pvEl = ref(null), bodyEl = ref(null), fileEl = ref(null), scrEl = ref(null), mapEl = ref(null)
const ready = ref(false)
const loadErr = ref('')
let monaco = null, editor = null, viewer = null, pvModel = null
const models = new Map()
let muteFork = false
const runner = createBeamScriptRunner()
runner.setData(inputs.value)

const current = computed(() => {
  const [k, id] = String(ui.sel).split(/:(.*)/s)
  if (k === 'u') { const s = scripts.value.find((x) => x.id === id); if (s) return { kind: 'user', id, name: s.name, script: s } }
  const t = templates.value.find((x) => x.id === id) || templates.value[0]
  return t ? { kind: 'builtin', id: t.id, name: t.name, tpl: t } : null
})

/* ===================== 运行 ===================== */
const run = reactive({ busy: false, ok: null, ms: 0, beams: [], stats: null, logs: [], error: null, seq: 0, importing: false })
let liveT = 0
const codeNow = () => (editor && editor.getModel() ? editor.getModel().getValue() : '')
async function execute(timeoutMs) {
  const seq = ++run.seq
  run.busy = true
  const res = await runner.run(codeNow(), { mode: 'import', lang: lang.value, timeoutMs })
  if (res.canceled || seq !== run.seq) return null
  run.busy = false
  run.ok = !!res.ok; run.ms = res.ms || 0; run.error = res.error || null
  run.logs = res.logs || []
  run.beams = res.ok ? (res.beams || []) : []
  run.stats = res.ok ? (res.stats || null) : null
  setRunMarkers(res.error)
  nextTick(drawMap)
  return res
}
function runNow() { clearTimeout(liveT); execute(30000).then((res) => { if (res && !res.ok) ui.tab = 'con' }) }
function scheduleLive() {
  clearTimeout(liveT)
  if (!ui.live || run.importing || !inputs.value.length) return
  liveT = setTimeout(() => execute(15000), 500)
}
watch(() => ui.live, (v) => { if (v) scheduleLive() })
function setRunMarkers(err) {
  if (!monaco || !editor || !editor.getModel()) return
  const m = editor.getModel()
  const marks = []
  if (err && err.line && err.line <= m.getLineCount()) {
    const ln = err.line, col = Math.max(1, Math.min(err.col || 1, m.getLineMaxColumn(ln)))
    marks.push({ startLineNumber: ln, startColumn: col, endLineNumber: ln, endColumn: err.col ? Math.min(col + 1, m.getLineMaxColumn(ln)) : m.getLineMaxColumn(ln), message: err.message, severity: monaco.MarkerSeverity.Error })
  }
  monaco.editor.setModelMarkers(m, 'beamimport-run', marks)
}
function gotoLine(line, col) {
  if (!editor || !line) return
  editor.revealLineInCenterIfOutsideViewport(line)
  editor.setPosition({ lineNumber: line, column: col || 1 })
  editor.focus()
}
const errCount = computed(() => run.logs.filter((l) => l.level === 'error').length + (run.error ? 1 : 0))
const warnCount = computed(() => run.logs.filter((l) => l.level === 'warn').length)

/* ===================== 输入文件 ===================== */
const PV_CAP = 400_000
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B')
const extOf = (n) => { const b = String(n || '').split(/[\\/]/).pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : '' }
const LANG_BY_EXT = { gxt: 'ini', ini: 'ini', kml: 'xml', xml: 'xml', gml: 'xml', geojson: 'bm-json', json: 'bm-json', csv: 'bm-csv', tsv: 'bm-csv', txt: 'plaintext', mif: 'plaintext', mid: 'bm-csv' }
const BIN_EXT = new Set(['zip', 'kmz', 'shp', 'dbf', 'shx'])
const inFile = computed(() => inputs.value[inSel.value] || null)
const inInfo = computed(() => {
  const f = inFile.value
  if (!f || BIN_EXT.has(extOf(f.name)) || (f.bytes[0] === 0x50 && f.bytes[1] === 0x4b)) return null
  const d = sniffDecode(f.bytes.length > PV_CAP ? f.bytes.subarray(0, PV_CAP) : f.bytes)
  return { text: d.text, encoding: d.encoding, cut: f.bytes.length > PV_CAP }
})
watch(inFile, syncViewer)
function syncViewer() {
  if (!monaco || !pvModel) return
  const f = inFile.value, info = inInfo.value
  const text = info ? info.text : ''
  monaco.editor.setModelLanguage(pvModel, f ? (LANG_BY_EXT[extOf(f.name)] || 'plaintext') : 'plaintext')
  if (pvModel.getValue() !== text) pvModel.setValue(text)
}
function setInputs(list) {
  pickSeq++   // 输入文件变了：进行中的自动挑脚本（按旧文件试跑的）作废
  inputs.value = list
  if (inSel.value >= list.length) inSel.value = Math.max(0, list.length - 1)
  runner.setData(list.map((f) => ({ name: f.name, bytes: f.bytes })))
  syncViewer()
  if (list.length) scheduleLive()
  else { run.beams = []; run.stats = null; run.ok = null; run.logs = []; run.error = null; nextTick(drawMap) }
}
async function addFiles(fileList) {
  const add = []
  for (const f of fileList) {
    try { add.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }) }
    catch (e) { flash(byLang(`无法读取「${f.name}」：`, `Cannot read "${f.name}": `) + ((e && e.message) || e), 'error') }
  }
  if (!add.length) return
  const names = new Set(add.map((f) => f.name.toLowerCase()))
  for (const n of names) failedFor.delete(n)   // 同名新文件：内容换了，之前「没认出」的结论作废
  setInputs([...inputs.value.filter((f) => !names.has(f.name.toLowerCase())), ...add])
  if (add.length && inputs.value.length === add.length) autoPick()
}
function pickFiles() { if (fileEl.value) { fileEl.value.value = ''; fileEl.value.click() } }
async function onPickFiles(e) { await addFiles([...((e.target && e.target.files) || [])]) }
function removeInput(i) { const l = inputs.value.slice(); l.splice(i, 1); setInputs(l) }
const dragOn = ref(false)
function onDragOver(e) { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dragOn.value = true } }
function onDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) dragOn.value = false }
async function onDrop(e) { dragOn.value = false; const fl = e.dataTransfer && e.dataTransfer.files; if (fl && fl.length) { e.preventDefault(); await addFiles([...fl]) } }
// 首次放进文件时挑脚本 —— 与文件管理「导入…」同口径（importRuntime.autoImport）：认领 ≠ 认出。
// 认领这个文件的候选按「用户脚本 → 内置模板」排好，先剔掉文件管理那边已经试过没认出的；剩下不止一个就逐个试跑，
// 选第一个跑通且返回波束的。都没认出时停在最具体的认领者上（写了 sniff 的优先）—— 实时运行把它为什么不行摆在控制台里。
async function autoPick() {
  const f = inputs.value[0]
  if (!f) return
  const my = ++pickSeq
  const cands = [
    ...scripts.value.map((s) => ({ key: 'u:' + s.id, code: s.code, info: scriptMatchInfo(s.code) })),
    ...templates.value.map((t) => ({ key: 'b:' + t.id, code: t.code, info: t.match }))
  ]
  const order = acceptingOrder(cands, { name: f.name, head: sniffDecode(f.bytes.subarray(0, 65536)).text })
  if (!order.length) return
  const failed = failedFor.get(f.name.toLowerCase())
  const fresh = failed ? order.filter((k) => !failed.has(cands[k].key)) : order
  const pool = fresh.length ? fresh : order
  const spec = pool.find((k) => cands[k].info.sniff)
  let pick = spec != null ? spec : pool[0]
  if (fresh.length > 1) {
    const sel0 = ui.sel
    clearTimeout(liveT)
    const files = inputs.value.map((x) => ({ name: x.name, bytes: x.bytes }))
    for (const k of fresh) {
      const r = await workerExec(cands[k].code, files, { lang: lang.value, timeoutMs: 15000 })
      if (my !== pickSeq || ui.sel !== sel0) return   // 试跑期间用户自己挑了脚本 / 换了文件 / 关了对话框：不再替他选
      if (recognized(r)) { pick = k; break }
    }
  }
  const key = cands[pick].key
  if (ui.sel === key && editor && editor.getModel() === models.get(key)) scheduleLive()
  else select(key)
}

/* ===================== 解析结果 ===================== */
const satRows = computed(() => {
  const m = new Map()
  run.beams.forEach((b, i) => {
    const k = b.satellite.toLowerCase()
    if (!m.has(k)) m.set(k, { name: b.satellite, lon: b.orbitLon, beams: [] })
    const levels = b.contours.map((c) => c.g).filter((g) => g != null)
    const lv = levels.length ? (Math.min(...levels) === Math.max(...levels) ? String(levels[0]) : `${Math.min(...levels)} ~ ${Math.max(...levels)}`) : '—'
    m.get(k).beams.push({ i, name: b.name, band: b.band, type: b.type, n: b.contours.length, lv, color: beamColor(i), tip: propsTip(b.props) })
  })
  return [...m.values()]
})
function propsTip(p) {
  if (!p || typeof p !== 'object') return ''
  const out = []
  for (const [k, v] of Object.entries(p)) {
    if (v == null || v === '') continue
    if (Array.isArray(v)) for (const x of v) out.push(k + ': ' + (x && typeof x === 'object' ? JSON.stringify(x) : String(x)))
    else out.push(k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)))
  }
  return out.join('\n')
}
const lonStr = (v) => (Number.isFinite(v) ? `${Math.abs(v)}°${v < 0 ? 'W' : 'E'}` : '')
// 小地图：全部等值线按经纬度直接铺（等距圆柱、按数据范围自适应），一束一色（与「按波束」配色同一套色）
let mapRo = null
function drawMap() {
  const cv = mapEl.value
  if (!cv) return
  const box = cv.parentElement.getBoundingClientRect()
  const W = Math.max(10, Math.floor(box.width)), H = Math.max(10, Math.floor(box.height))
  const dpr = window.devicePixelRatio || 1
  cv.width = W * dpr; cv.height = H * dpr
  cv.style.width = W + 'px'; cv.style.height = H + 'px'
  const g = cv.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, W, H)
  const beams = run.beams
  if (!beams.length) return
  const css = getComputedStyle(document.documentElement)
  const faint = css.getPropertyValue('--border').trim() || '#888'
  // 统一解缠：以各束轨位（缺省首点）的中位数为参照，跨 ±180° 的波束不被横扫
  const refs = beams.map((b) => (Number.isFinite(b.orbitLon) ? b.orbitLon : (b.contours[0] && b.contours[0].p[0] ? b.contours[0].p[0][0] : 0))).sort((a, b) => a - b)
  const ref = refs[Math.floor(refs.length / 2)]
  const un = (lon) => ref + ((((lon - ref) % 360) + 540) % 360 - 180)
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const b of beams) for (const c of b.contours) for (const q of c.p) { const x = un(q[0]); if (x < x0) x0 = x; if (x > x1) x1 = x; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1] }
  if (!Number.isFinite(x0)) return
  const pad = 12, sx = (W - 2 * pad) / Math.max(1e-6, x1 - x0), sy = (H - 2 * pad) / Math.max(1e-6, y1 - y0)
  const s = Math.min(sx, sy)
  const ox = pad + ((W - 2 * pad) - (x1 - x0) * s) / 2, oy = pad + ((H - 2 * pad) - (y1 - y0) * s) / 2
  const P = (lon, lat) => [ox + (un(lon) - x0) * s, oy + (y1 - lat) * s]
  // 经纬网（10° / 跨度大时 30°）
  const step = Math.max(x1 - x0, y1 - y0) > 120 ? 30 : 10
  g.strokeStyle = faint; g.lineWidth = 1
  g.beginPath()
  for (let lon = Math.ceil(x0 / step) * step; lon <= x1; lon += step) { const a = ox + (lon - x0) * s; g.moveTo(a, oy); g.lineTo(a, oy + (y1 - y0) * s) }
  for (let lat = Math.ceil(y0 / step) * step; lat <= y1; lat += step) { const b = oy + (y1 - lat) * s; g.moveTo(ox, b); g.lineTo(ox + (x1 - x0) * s, b) }
  g.stroke()
  g.lineWidth = 1.3
  beams.forEach((b, i) => {
    const col = beamColor(i)
    g.strokeStyle = col
    g.fillStyle = col + '22'
    for (const c of b.contours) {
      if (!c.p.length) continue
      g.beginPath()
      c.p.forEach((q, k) => { const [x, y] = P(q[0], q[1]); if (k) g.lineTo(x, y); else g.moveTo(x, y) })
      g.closePath(); g.fill(); g.stroke()
    }
    for (const q of b.bore) { const [x, y] = P(q[0], q[1]); g.beginPath(); g.moveTo(x - 4, y); g.lineTo(x + 4, y); g.moveTo(x, y - 4); g.lineTo(x, y + 4); g.stroke() }
  })
}
watch(() => ui.tab, () => nextTick(drawMap))

/* ===================== 导入覆盖库 ===================== */
const canImport = computed(() => ready.value && !run.importing && run.ok && run.beams.length > 0)
async function doImport() {
  if (!canImport.value) return
  const api = window.api
  if (!api || !api.coverageGxt || !api.coverageGxt.importBatch) { flash(byLang('需在桌面客户端中运行', 'Requires the desktop app'), 'error'); return }
  run.importing = true
  clearTimeout(liveT)
  try {
    const res = await execute(60000)   // 落库前完整重跑一遍（编辑停顿中的那一版不算数）
    if (!res) return
    if (!res.ok) { ui.tab = 'con'; return }
    if (!res.beams.length) { flash(byLang('脚本没有返回任何波束。', 'The script returned no beams.'), 'warn'); return }
    const fmt = current.value ? (current.value.kind === 'builtin' ? current.value.id : current.value.name) : 'script'
    const items = toLibraryItems(res.beams, { sourceName: inputs.value.map((f) => f.name).join(', '), sourceFormat: 'script:' + fmt })
    const r = await api.coverageGxt.importBatch(JSON.parse(JSON.stringify(items)))
    if (!r || !r.ok) { flash(byLang('导入失败：', 'Import failed: ') + ((r && r.error) || ''), 'error'); return }
    bumpLibrary()
    const nSat = new Set(res.beams.map((b) => b.satellite.toLowerCase())).size
    flash(byLang(`已导入 ${nSat} 颗卫星、${res.beams.length} 个波束`, `Imported ${nSat} satellites, ${res.beams.length} beams`))
    emit('imported', { satellites: nSat, beams: res.beams.length })
  } catch (e) {
    flash(byLang('导入失败：', 'Import failed: ') + ((e && e.message) || e), 'error')
  } finally { run.importing = false }
}

/* ===================== 脚本库（与导出对话框同一手感，存在 beamImportScripts 命名空间） ===================== */
let saveT = 0
let libReady = false, libDirty = false
function persist(now) {
  clearTimeout(saveT)
  if (!libReady) { libDirty = true; saveT = 0; return }
  const go = () => { Promise.resolve(saveScripts(scripts.value, IMPORT_NS)).catch((e) => reportError('脚本保存失败', e)) }
  if (now) go(); else saveT = setTimeout(go, 600)
}
function modelFor(key) {
  let m = models.get(key)
  if (m && !m.isDisposed()) return m
  const [k, id] = key.split(/:(.*)/s)
  const code = k === 'u' ? ((scripts.value.find((x) => x.id === id) || {}).code || '') : ((templates.value.find((x) => x.id === id) || {}).code || '')
  m = monaco.editor.createModel(code, 'javascript', monaco.Uri.parse(`file:///beamimport/s${models.size + 1}-${Date.now().toString(36)}.js`))
  m.updateOptions({ tabSize: 2, insertSpaces: true })
  m.onDidChangeContent(() => onEdit(m))
  models.set(key, m)
  return m
}
function keyOfModel(m) { for (const [k, v] of models) if (v === m) return k; return '' }
function onEdit(m) {
  if (muteFork) return
  pickSeq++   // 用户动手改代码了：进行中的自动挑脚本作废，试跑回来不再换掉他正在改的脚本
  const key = keyOfModel(m)
  if (key.startsWith('b:')) forkBuiltin(key, m)
  else if (key.startsWith('u:')) {
    const s = scripts.value.find((x) => 'u:' + x.id === key)
    if (s) { s.code = m.getValue(); s.updatedAt = new Date().toISOString(); persist() }
  }
  if (editor && editor.getModel() === m) scheduleLive()
}
function forkBuiltin(key, m) {
  const tpl = templates.value.find((t) => 'b:' + t.id === key)
  const now = new Date().toISOString()
  const s = { id: newScriptId(), name: copyScriptName(tpl ? tpl.name : 'Script', scripts.value.map((x) => x.name)), code: m.getValue(), from: tpl ? tpl.id : '', createdAt: now, updatedAt: now }
  scripts.value = [...scripts.value, s]
  models.delete(key)
  models.set('u:' + s.id, m)
  ui.sel = 'u:' + s.id
  persist()
  flash(byLang(`已另存为「${s.name}」`, `Saved as "${s.name}"`))
}
function select(key) {
  if (ui.sel === key && editor && editor.getModel() === models.get(key)) return
  ui.sel = key
  openCurrent()
}
function openCurrent() {
  if (!editor || !current.value) return
  const key = current.value.kind === 'user' ? 'u:' + current.value.id : 'b:' + current.value.id
  const m = modelFor(key)
  if (editor.getModel() !== m) editor.setModel(m)
  editor.focus()
  run.beams = []; run.logs = []; run.error = null; run.ok = null; run.stats = null
  nextTick(drawMap)
  if (ui.live) scheduleLive()
}
function addScript(name, code, from = '') {
  const now = new Date().toISOString()
  const s = { id: newScriptId(), name: uniqueName(name, scripts.value.map((x) => x.name)), code, from, createdAt: now, updatedAt: now }
  scripts.value = [...scripts.value, s]
  persist()
  select('u:' + s.id)
  return s
}
function newScript() { addScript(newScriptName(scripts.value.map((x) => x.name)), blankImportScript(lang.value)) }
function duplicateTpl(t) { addScript(copyScriptName(t.name, scripts.value.map((x) => x.name)), t.code, t.id) }
function duplicateUser(s) { addScript(copyScriptName(s.name, scripts.value.map((x) => x.name)), (models.get('u:' + s.id) || { getValue: () => s.code }).getValue(), s.from) }
const undo = shallowRef(null)
let undoT = 0
function removeScript(s) {
  const idx = scripts.value.findIndex((x) => x.id === s.id)
  if (idx < 0) return
  const m = models.get('u:' + s.id)
  const code = m && !m.isDisposed() ? m.getValue() : s.code
  scripts.value = scripts.value.filter((x) => x.id !== s.id)
  if (m) { if (editor && editor.getModel() === m) editor.setModel(null); models.delete('u:' + s.id); m.dispose() }
  persist(true)
  if (ui.sel === 'u:' + s.id) { ui.sel = 'b:' + (templates.value[0] && templates.value[0].id); openCurrent() }
  clearTimeout(undoT)
  undo.value = { script: { ...s, code }, idx }
  flash(byLang(`已删除「${s.name}」`, `Deleted "${s.name}"`), 'info', 8000)
  undoT = setTimeout(() => { undo.value = null }, 8000)
}
function undoRemove() {
  const u = undo.value
  if (!u) return
  undo.value = null
  const list = [...scripts.value]
  list.splice(Math.min(u.idx, list.length), 0, u.script)
  scripts.value = list
  persist(true)
  select('u:' + u.script.id)
  msg.text = ''
}
const renaming = ref('')
const renameVal = ref('')
function startRename(s) { renaming.value = s.id; renameVal.value = s.name; nextTick(() => { const el = bodyEl.value && bodyEl.value.querySelector('.bsd-rn'); if (el) { el.focus(); el.select() } }) }
function commitRename() {
  const id = renaming.value
  if (!id) return
  renaming.value = ''
  const s = scripts.value.find((x) => x.id === id)
  const v = String(renameVal.value || '').trim()
  if (!s || !v || v === s.name) return
  s.name = uniqueName(v, scripts.value.filter((x) => x.id !== id).map((x) => x.name))
  s.updatedAt = new Date().toISOString()
  scripts.value = [...scripts.value]
  persist()
}
function cancelRename() { renaming.value = '' }
function rowKey(e, s) {
  if (e.target !== e.currentTarget) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const rows = [...e.currentTarget.parentElement.querySelectorAll('.bsd-it')]
    const nx = rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]
    if (nx) nx.focus()
  } else if (e.key === 'Enter') { e.preventDefault(); select(s ? 'u:' + s.id : e.currentTarget.dataset.key) }
  else if (s && e.key === 'F2') { e.preventDefault(); startRename(s) }
  else if (s && e.key === 'Delete') { e.preventDefault(); removeScript(s) }
}
function pickScriptImport() { if (scrEl.value) { scrEl.value.value = ''; scrEl.value.click() } }
async function onImportScript(e) {
  for (const f of [...((e.target && e.target.files) || [])]) {
    try { addScript(f.name.replace(/\.(m?js|bmjs|txt)$/i, '') || newScriptName(scripts.value.map((x) => x.name)), (await f.text()).replace(/^﻿/, '')) }
    catch (err) { flash(byLang(`无法读取「${f.name}」：`, `Cannot read "${f.name}": `) + ((err && err.message) || err), 'error') }
  }
}
async function exportScriptFile(s) {
  const api = window.api
  if (!api || !api.exportFile) { flash(byLang('需在桌面客户端中运行', 'Requires the desktop app'), 'error'); return }
  const m = models.get('u:' + s.id)
  const code = m && !m.isDisposed() ? m.getValue() : s.code
  const r = await api.exportFile({ defaultName: s.name.replace(/[\\/:*?"<>|]+/g, '_') + '.js', data: code, filters: [{ name: 'JavaScript', extensions: ['js'] }] })
  if (r && r.ok) flash(byLang('已导出：', 'Exported: ') + String(r.path || r.filePath || '').split(/[\\/]/).pop())
  else if (r && !r.canceled) flash(byLang('导出失败：', 'Export failed: ') + (r.error || ''), 'error')
}

/* ===================== 页脚状态句 ===================== */
const msg = reactive({ text: '', level: 'info' })
let msgT = 0
function flash(text, level = 'info', ms = 5000) { clearTimeout(msgT); msg.text = text; msg.level = level; msgT = setTimeout(() => { msg.text = '' }, ms) }

/* ===================== 右栏宽度 ===================== */
const rightW = computed(() => (ui.rightW > 0 ? ui.rightW + 'px' : '40%'))
function startDrag(ev) {
  const box = bodyEl.value
  if (!box) return
  const rect = box.getBoundingClientRect()
  const move = (e) => { ui.rightW = Math.round(Math.max(280, Math.min(rect.width * 0.6, rect.right - e.clientX))) }
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.documentElement.classList.remove('ui-col-resize'); drawMap() }
  document.documentElement.classList.add('ui-col-resize')
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  ev.preventDefault()
}

/* ===================== 生命周期 ===================== */
let offLang = null
onMounted(async () => {
  try {
    const libP = loadScripts(IMPORT_NS).then((list) => {
      const have = new Set(list.map((x) => x.id))
      const extra = scripts.value.filter((x) => !have.has(x.id))
      const names = list.map((x) => x.name)
      for (const x of extra) { x.name = uniqueName(x.name, names); names.push(x.name) }
      scripts.value = [...list, ...extra]
      libReady = true
      if (libDirty || extra.length) { libDirty = false; persist(true) }
    })
    const [core] = await Promise.all([loadMonaco(), libP])
    monaco = core.monaco
    setScriptMode('import')
    await nextTick()
    if (!edEl.value) return
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim() || 'Consolas, monospace'
    const common = {
      automaticLayout: true, minimap: { enabled: false }, fontFamily: font, scrollBeyondLastLine: false, fixedOverflowWidgets: true,
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false }, stickyScroll: { enabled: false },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false }, overviewRulerBorder: false
    }
    editor = monaco.editor.create(edEl.value, {
      ...common, model: null, fontSize: 13, lineHeight: 20, tabSize: 2, insertSpaces: true, renderLineHighlight: 'all',
      padding: { top: 6, bottom: 6 }, bracketPairColorization: { enabled: true }, guides: { indentation: true, bracketPairs: false },
      quickSuggestions: { other: true, comments: false, strings: false }, suggest: { showWords: false }, wordBasedSuggestions: 'off',
      tabCompletion: 'on', formatOnPaste: false, smoothScrolling: true
    })
    viewer = monaco.editor.create(pvEl.value, {
      ...common, readOnly: true, domReadOnly: true, fontSize: 12, lineHeight: 18, renderLineHighlight: 'none', lineNumbersMinChars: 3,
      folding: true, renderValidationDecorations: 'off', occurrencesHighlight: 'off', selectionHighlight: false, links: false
    })
    pvModel = monaco.editor.createModel('', 'plaintext')
    viewer.setModel(pvModel)
    editor.addCommand(monaco.KeyCode.F5, runNow)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runNow)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => persist(true))
    ready.value = true
    if (inputs.value.length) autoPick()
    openCurrent()
    syncViewer()
    offLang = onLangChange((l) => {
      lang.value = l
      muteFork = true
      try { for (const [k, m] of models) { if (k.startsWith('b:')) { const t = templates.value.find((x) => 'b:' + x.id === k); if (t && m.getValue() !== t.code) m.setValue(t.code) } } }
      finally { muteFork = false }
      setScriptMode('import')
    })
    if (mapEl.value && typeof ResizeObserver === 'function') { mapRo = new ResizeObserver(() => drawMap()); mapRo.observe(mapEl.value.parentElement) }
  } catch (e) {
    loadErr.value = String((e && e.message) || e)
    reportError('编辑器加载失败', e)
  }
})
onBeforeUnmount(() => {
  pickSeq++   // 自动挑脚本的试跑还在路上：回来后不再动已卸载的界面
  clearTimeout(liveT); clearTimeout(msgT); clearTimeout(undoT)
  if (saveT) persist(true)
  if (offLang) offLang()
  if (mapRo) mapRo.disconnect()
  runner.dispose()
  setScriptMode('export')   // 导出对话框那套声明挂回去
  try { if (editor) editor.dispose(); if (viewer) viewer.dispose(); if (pvModel) pvModel.dispose(); for (const m of models.values()) m.dispose() } catch { /* 已释放 */ }
  models.clear()
})
</script>

<template>
  <AppDialog :width="'min(1360px, calc(100vw - 32px))'" flush dialog-class="bsd-dlg" initial-focus=".bsd-run" :layer="layer" @close="emit('close')">
    <template #title>可编程导入</template>
    <div ref="bodyEl" class="bsd" :class="{ dragon: dragOn }" :style="{ '--bsd-right': rightW }" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
      <!-- ① 脚本库 -->
      <aside class="bsd-lib">
        <div class="bsd-ph">
          <span class="bsd-pt">脚本库</span>
          <button type="button" class="ibtn sm" title="新建脚本" :disabled="!ready" @click="newScript"><Icon name="plus" :size="14" /></button>
          <button type="button" class="ibtn sm" title="导入脚本（.js）" :disabled="!ready" @click="pickScriptImport"><Icon name="file-import" :size="14" /></button>
          <input ref="scrEl" type="file" accept=".js,.mjs,.bmjs,.txt" multiple hidden @change="onImportScript" />
        </div>
        <div class="bsd-list" role="listbox">
          <div class="bsd-grp">内置模板</div>
          <div v-for="t in templates" :key="'b:' + t.id" class="bsd-it" :class="{ on: current && current.kind === 'builtin' && current.id === t.id }"
               role="option" :aria-selected="!!(current && current.kind === 'builtin' && current.id === t.id)" tabindex="0" :title="t.name"
               :data-key="'b:' + t.id" @click="select('b:' + t.id)" @keydown="rowKey($event, null)">
            <span class="bsd-in" data-i18n-skip>{{ t.name }}</span>
            <span class="bsd-ext" data-i18n-skip>{{ t.ext }}</span>
            <span class="bsd-acts">
              <button type="button" class="ibtn sm" title="复制为用户脚本" :disabled="!ready" @click.stop="duplicateTpl(t)"><Icon name="copy" :size="12" /></button>
            </span>
          </div>
          <div class="bsd-grp">用户脚本</div>
          <div v-for="s in scripts" :key="'u:' + s.id" class="bsd-it" :class="{ on: current && current.kind === 'user' && current.id === s.id }"
               role="option" :aria-selected="!!(current && current.kind === 'user' && current.id === s.id)" tabindex="0" :title="s.name"
               @click="renaming !== s.id && select('u:' + s.id)" @dblclick="startRename(s)" @keydown="rowKey($event, s)">
            <input v-if="renaming === s.id" v-model="renameVal" class="bsd-rn" spellcheck="false"
                   @click.stop @keydown.enter.stop.prevent="commitRename" @keydown.esc.stop.prevent="cancelRename" @blur="commitRename" />
            <span v-else class="bsd-in" data-i18n-skip>{{ s.name }}</span>
            <span v-if="renaming !== s.id" class="bsd-acts">
              <button type="button" class="ibtn sm" title="重命名（F2）" @click.stop="startRename(s)"><Icon name="pencil" :size="12" /></button>
              <button type="button" class="ibtn sm" title="复制" @click.stop="duplicateUser(s)"><Icon name="copy" :size="12" /></button>
              <button type="button" class="ibtn sm" title="导出脚本文件" @click.stop="exportScriptFile(s)"><Icon name="file-export" :size="12" /></button>
              <button type="button" class="ibtn sm danger" title="删除（Delete）" @click.stop="removeScript(s)"><Icon name="trash" :size="12" /></button>
            </span>
          </div>
          <div v-if="!scripts.length" class="bsd-empty">暂无用户脚本。</div>
        </div>
      </aside>

      <!-- ② 编辑器 -->
      <section class="bsd-ed">
        <div class="bsd-ph">
          <span class="bsd-cur" data-i18n-skip>{{ current ? current.name : '' }}</span>
          <span v-if="current && current.kind === 'builtin'" class="bsd-tag">内置</span>
          <span class="bsd-sp" />
          <button type="button" class="btn sm" title="格式化文档（Shift+Alt+F）" :disabled="!ready" @click="editor && editor.getAction('editor.action.formatDocument').run()">格式化</button>
          <button type="button" class="btn sm bsd-run" title="运行脚本（F5 / Ctrl+Enter）" :disabled="!ready || !inputs.length" @click="runNow"><Icon name="play" :size="12" />运行脚本</button>
        </div>
        <div class="bsd-code">
          <div ref="edEl" class="bsd-monaco" data-i18n-skip />
          <div v-if="!ready" class="bsd-loading">{{ loadErr ? loadErr : '' }}</div>
        </div>
      </section>

      <div class="bsd-split" role="separator" aria-orientation="vertical" title="拖动调整宽度" @pointerdown="startDrag" />

      <!-- ③ 解析结果 / 输入文件 / 控制台 -->
      <section class="bsd-out">
        <div class="bsd-ph">
          <div class="seg sm" role="tablist">
            <button type="button" class="sg" role="tab" :aria-selected="ui.tab === 'res'" :class="{ on: ui.tab === 'res' }" @click="ui.tab = 'res'">解析结果<b v-if="run.beams.length" class="bsd-n">{{ run.beams.length }}</b></button>
            <button type="button" class="sg" role="tab" :aria-selected="ui.tab === 'in'" :class="{ on: ui.tab === 'in' }" @click="ui.tab = 'in'">输入文件<b v-if="inputs.length" class="bsd-n">{{ inputs.length }}</b></button>
            <button type="button" class="sg" role="tab" :aria-selected="ui.tab === 'con'" :class="{ on: ui.tab === 'con' }" @click="ui.tab = 'con'">控制台<b v-if="errCount" class="bsd-n err">{{ errCount }}</b><b v-else-if="warnCount" class="bsd-n warn">{{ warnCount }}</b><b v-else-if="run.logs.length" class="bsd-n">{{ run.logs.length }}</b></button>
          </div>
          <span class="bsd-sp" />
          <button type="button" class="ibtn sm" title="添加输入文件（也可直接拖进来）" @click="pickFiles"><Icon name="plus" :size="13" /></button>
          <input ref="fileEl" type="file" multiple hidden @change="onPickFiles" />
        </div>

        <!-- 解析结果 -->
        <div v-show="ui.tab === 'res'" class="bsd-pane bsd-resp">
          <div class="bim-map"><canvas ref="mapEl" /></div>
          <div class="bim-tree">
            <div v-for="s in satRows" :key="s.name" class="bim-sat">
              <div class="bim-sh"><span class="bim-sn" data-i18n-skip>{{ s.name }}</span><span class="bim-sm">{{ lonStr(s.lon) }}</span><span class="bim-sc">{{ s.beams.length }}</span></div>
              <div v-for="b in s.beams" :key="b.i" class="bim-b" :title="b.tip || null">
                <i class="bim-sw" :style="{ background: b.color }" />
                <span class="bim-bn" data-i18n-skip>{{ b.name }}</span>
                <span class="bim-bm" data-i18n-skip>{{ [b.band, b.type].filter(Boolean).join(' · ') }}</span>
                <span class="bim-bv" data-i18n-skip>{{ b.lv }}</span>
                <span class="bim-bc">{{ b.n }}</span>
              </div>
            </div>
            <div v-if="!satRows.length" class="bsd-empty">{{ run.busy ? '' : (!inputs.length ? '暂无输入文件。' : (run.ok === false ? '解析失败。' : '尚无解析结果。')) }}</div>
          </div>
        </div>

        <!-- 输入文件 -->
        <div v-show="ui.tab === 'in'" class="bsd-pane bsd-outp">
          <div v-if="inputs.length" class="bsd-files">
            <div v-for="(f, i) in inputs" :key="f.name" class="bsd-file" :class="{ on: i === inSel }" :title="f.name" role="button" tabindex="0" @click="inSel = i" @keydown.enter="inSel = i">
              <span class="bsd-fn" data-i18n-skip>{{ f.name }}</span>
              <span class="bsd-fs">{{ fmtSize(f.bytes.length) }}</span>
              <button type="button" class="ibtn sm" title="移除" @click.stop="removeInput(i)"><Icon name="x" :size="12" /></button>
            </div>
          </div>
          <div v-show="inInfo" class="bsd-viewer">
            <div ref="pvEl" class="bsd-monaco" data-i18n-skip />
          </div>
          <div v-if="inInfo" class="bsd-trunc bim-enc"><span>{{ inInfo.encoding.toUpperCase() }}</span><template v-if="inInfo.cut"> · <span>预览仅显示前</span> <b>{{ fmtSize(PV_CAP) }}</b></template></div>
          <div v-if="inFile && !inInfo" class="bsd-empty">{{ fmtSize(inFile.bytes.length) }}</div>
          <div v-if="!inputs.length" class="bsd-empty">暂无输入文件。</div>
        </div>

        <!-- 控制台 -->
        <div v-show="ui.tab === 'con'" class="bsd-pane bsd-con" data-i18n-skip>
          <div v-for="(l, i) in run.logs" :key="i" class="bsd-log" :class="'lv-' + l.level">
            <Icon v-if="l.level === 'warn'" name="alert-triangle" :size="12" class="bsd-li" />
            <Icon v-else-if="l.level === 'error'" name="x" :size="12" class="bsd-li" />
            <span v-else class="bsd-li" />
            <pre class="bsd-lt">{{ l.text }}</pre>
            <button v-if="l.line" type="button" class="bsd-ln" @click="gotoLine(l.line)">:{{ l.line }}</button>
          </div>
          <div v-if="run.error" class="bsd-log lv-error">
            <Icon name="x" :size="12" class="bsd-li" />
            <pre class="bsd-lt">{{ run.error.name && run.error.name !== 'Error' && !String(run.error.message).startsWith(run.error.name) ? run.error.name + ': ' : '' }}{{ run.error.message }}</pre>
            <button v-if="run.error.line" type="button" class="bsd-ln" @click="gotoLine(run.error.line, run.error.col)">:{{ run.error.line }}</button>
          </div>
        </div>
        <div v-if="ui.tab === 'con' && !run.logs.length && !run.error" class="bsd-pane bsd-empty bsd-abs">暂无日志。</div>
      </section>
    </div>

    <template #footer>
      <div class="adlg-ft-l bsd-ft">
        <button type="button" class="btn sm" :class="{ on: ui.live }" :aria-pressed="ui.live" title="编辑停止 0.5 s 后自动运行" @click="ui.live = !ui.live">实时预览</button>
        <span v-if="run.stats" class="bsd-stat">
          <b>{{ run.stats.satellites }}</b><span>颗卫星</span><i>·</i><b>{{ run.stats.beams }}</b><span>个波束</span><i>·</i><b>{{ run.stats.contours }}</b><span>条等值线</span><i>·</i><b>{{ run.ms }}</b><span>ms</span>
        </span>
        <span v-if="msg.text" class="bsd-msg" :class="'lv-' + msg.level">
          <span>{{ msg.text }}</span>
          <button v-if="undo" type="button" class="bsd-link" @click="undoRemove">撤销</button>
        </span>
        <span v-else-if="run.busy && run.importing" class="bsd-msg">正在运行…</span>
        <span v-else-if="run.error" class="bsd-msg lv-error" :title="run.error.message">
          <span v-if="run.error.line">{{ run.error.line }}:{{ run.error.col || 1 }}</span>
          <span class="bsd-emsg" data-i18n-skip>{{ run.error.message }}</span>
        </span>
      </div>
      <button type="button" class="btn" @click="emit('close')">关闭</button>
      <button type="button" class="btn primary" :disabled="!canImport" @click="doImport">导入到波束地图库</button>
    </template>
  </AppDialog>
</template>

<style scoped>
/* 布局与 BeamScriptDialog.vue 同源（两个对话框各自 scoped，改动请对照） */
.bsd { --bsd-left: 232px; display: grid; grid-template-columns: var(--bsd-left) minmax(0, 1fr) 5px var(--bsd-right); height: min(780px, calc(100vh - 150px)); min-height: 420px; background: var(--surface); }
.bsd.dragon { box-shadow: inset 0 0 0 2px var(--accent-ui); }
.bsd-lib, .bsd-ed, .bsd-out { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.bsd-lib { border-right: 1px solid var(--border); }
.bsd-out { position: relative; }
.bsd-ph { flex: none; display: flex; align-items: center; gap: 4px; height: 32px; padding: 0 6px 0 10px; border-bottom: 1px solid var(--border); background: var(--surface-2); }
.bsd-pt { flex: 1; font-size: var(--fs-2); font-weight: 600; color: var(--text-muted); letter-spacing: var(--ls-label); }
.bsd-sp { flex: 1; }
.bsd-cur { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-3); font-weight: 600; color: var(--text); }
.bsd-tag { flex: none; padding: 0 5px; line-height: 16px; font-size: var(--fs-1); color: var(--text-muted); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); }
.bsd-list { flex: 1; min-height: 0; overflow: auto; padding: 4px 0 8px; }
.bsd-grp { padding: 8px 10px 3px; font-size: var(--fs-1); color: var(--text-faint); letter-spacing: var(--ls-caps); }
.bsd-it { position: relative; display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px 0 12px; font-size: var(--fs-3); color: var(--text); cursor: pointer; outline: none; }
.bsd-it:hover { background: var(--wash-hover); }
.bsd-it.on { background: var(--accent-ui-weak); }
.bsd-it.on::before { content: ''; position: absolute; left: 0; top: 3px; bottom: 3px; width: 2px; background: var(--accent-ui); }
.bsd-it:focus-visible { box-shadow: inset 0 0 0 1px var(--focus-ring); }
.bsd-in { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bsd-ext { flex: none; font-family: var(--font-code); font-size: var(--fs-1); color: var(--text-faint); text-transform: uppercase; }
.bsd-acts { display: none; flex: none; align-items: center; gap: 1px; }
.bsd-it:hover .bsd-acts, .bsd-it:focus-within .bsd-acts { display: inline-flex; }
.bsd-it:hover .bsd-ext, .bsd-it:focus-within .bsd-ext { display: none; }
.bsd-rn { flex: 1 1 auto; min-width: 0; height: 20px !important; font-size: var(--fs-3); padding: 0 5px; }
.bsd-empty { padding: 10px 12px; font-size: var(--fs-3); color: var(--text-faint); }
.bsd-code { position: relative; flex: 1; min-height: 0; background: var(--field-bg); }
.bsd-monaco { position: absolute; inset: 0; }
.bsd-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: var(--fs-3); color: var(--danger); }
.bsd-run :deep(svg) { color: var(--accent-ui); }
.bsd-split { cursor: col-resize; background: var(--surface); border-left: 1px solid var(--border); border-right: 1px solid var(--border); }
.bsd-split:hover { background: var(--accent-ui-weak); }
.bsd-n { margin-left: 5px; padding: 0 5px; min-width: 16px; line-height: 15px; border-radius: var(--r-pill); font-size: var(--fs-1); font-weight: 600; background: color-mix(in srgb, var(--text) 14%, transparent); color: inherit; }
.bsd-n.err { background: var(--danger); color: #fff; }
.bsd-n.warn { background: var(--warn); color: #fff; }
.bsd-pane { flex: 1; min-height: 0; overflow: auto; }
.bsd-abs { position: absolute; top: 32px; left: 0; right: 0; bottom: 0; }
.bsd-outp { display: flex; flex-direction: column; overflow: hidden; }
.bsd-files { flex: none; max-height: 38%; overflow: auto; padding: 4px 0; border-bottom: 1px solid var(--border); }
.bsd-file { display: flex; align-items: center; gap: 8px; width: 100%; height: 24px; padding: 0 6px 0 10px; text-align: left; font-size: var(--fs-3); color: var(--text); cursor: pointer; outline: none; }
.bsd-file:hover { background: var(--wash-hover); }
.bsd-file.on { background: var(--accent-ui-weak); }
.bsd-file:focus-visible { box-shadow: inset 0 0 0 1px var(--focus-ring); }
.bsd-fn { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bsd-fs { flex: none; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.bsd-viewer { position: relative; flex: 1; min-height: 0; background: var(--field-bg); }
.bsd-trunc { flex: none; padding: 3px 10px; font-size: var(--fs-2); color: var(--text-faint); border-top: 1px solid var(--border); }
.bsd-con { padding: 4px 0; background: var(--field-bg); font-family: var(--font-code); font-size: var(--fs-3); }
.bsd-log { display: flex; align-items: flex-start; gap: 6px; padding: 2px 8px 2px 6px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
.bsd-li { flex: none; width: 12px; margin-top: 3px; }
.bsd-lt { flex: 1 1 auto; min-width: 0; margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; line-height: 18px; color: var(--text); }
.bsd-log.lv-warn { background: color-mix(in srgb, var(--warn) 10%, transparent); }
.bsd-log.lv-warn .bsd-li, .bsd-log.lv-warn .bsd-lt { color: var(--warn); }
.bsd-log.lv-error { background: color-mix(in srgb, var(--danger) 10%, transparent); }
.bsd-log.lv-error .bsd-li, .bsd-log.lv-error .bsd-lt { color: var(--danger); }
.bsd-log.lv-info .bsd-lt { color: var(--accent-ui); }
.bsd-ln { flex: none; height: 18px; padding: 0 4px; border: 0; background: transparent; font: inherit; color: var(--text-faint); text-decoration: underline; text-underline-offset: 2px; }
.bsd-ln:hover { color: var(--accent-ui); }
.bsd-ft { min-width: 0; gap: 12px; }
.bsd-stat { display: inline-flex; align-items: baseline; gap: 3px; font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.bsd-stat b { font-weight: 600; color: var(--text); }
.bsd-stat i { font-style: normal; color: var(--text-faint); padding: 0 3px; }
.bsd-msg { display: inline-flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; overflow: hidden; }
.bsd-msg.lv-error { color: var(--danger); }
.bsd-msg.lv-warn { color: var(--warn); }
.bsd-emsg { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.bsd-link { flex: none; height: auto; padding: 0; border: 0; background: transparent; font: inherit; color: var(--accent-ui); text-decoration: underline; text-underline-offset: 2px; }
/* 解析结果：上半小地图、下半卫星 → 波束清单 */
.bsd-resp { display: flex; flex-direction: column; overflow: hidden; }
.bim-map { position: relative; flex: 0 0 46%; min-height: 140px; border-bottom: 1px solid var(--border); background: var(--field-bg); }
.bim-map canvas { position: absolute; inset: 0; display: block; }
.bim-tree { flex: 1; min-height: 0; overflow: auto; padding: 4px 0 8px; }
.bim-sh { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px 2px; font-size: var(--fs-3); }
.bim-sn { font-weight: 600; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bim-sm { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.bim-sc { margin-left: auto; color: var(--text-faint); font-size: var(--fs-2); font-variant-numeric: tabular-nums; }
.bim-b { display: flex; align-items: center; gap: 8px; height: 22px; padding: 0 10px 0 18px; font-size: var(--fs-3); color: var(--text); }
.bim-b:hover { background: var(--wash-hover); }
.bim-sw { flex: none; width: 10px; height: 10px; border-radius: 2px; }
.bim-bn { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bim-bm { flex: none; color: var(--text-muted); font-size: var(--fs-2); }
.bim-bv { flex: none; min-width: 52px; text-align: right; color: var(--text-muted); font-family: var(--font-mono); font-size: var(--fs-2); }
.bim-bc { flex: none; min-width: 22px; text-align: right; color: var(--text-faint); font-size: var(--fs-2); font-variant-numeric: tabular-nums; }
.bim-enc { color: var(--text-faint); }
</style>

<style>
.bsd-dlg .adlg-bd { overflow: hidden; }
</style>
