<script setup>
// 可编程波束地图：把当前绘制的波束地图（覆盖等值线 + 波束中心 + Polygon + 标记）交给用户脚本，按自己的格式导出。
//
// 范式取自成熟的「脚本化导出」实现：
//   · DataGrip 数据导出脚本 —— 内置的几种格式本身就是用同一套 API 写的脚本，复制一份就能改（左栏「内置模板」）；
//   · Node-RED 函数节点 / Postman 脚本 —— Monaco 编辑器 + 注入的全局 API；本软件知道数据的确切形状，
//     故按 beammap.dts.txt 给出类型感知的补全与悬停文档（Node-RED 做不到这一点，它不知道 msg 长什么样）；
//   · n8n 代码节点 —— 输入数据 | 代码 | 输出 三栏，边改边看结果（实时预览）。
// 执行在沙箱 Worker 里（viz/beamScript/beamScript.worker.js），每次运行一个新实例、超时即掐。
//
// 交互口径：
//   · 内置模板只读；首次改动即另存为「用户脚本」（同一个编辑模型接着用，光标与撤销链不断）。
//   · 用户脚本自动保存（停顿 0.6 s / 关窗时落盘），删除可在页脚撤销。
//   · 实时预览：停顿 0.5 s 自动运行；「导出…」总是重新完整跑一遍再落盘。
//   · 单个文件走保存框，多个文件选择输出目录（文件名可带子目录）。
import { ref, shallowRef, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import AppDialog from './AppDialog.vue'
import Icon from './Icon.vue'
import BeamDataTree from './BeamDataTree.vue'
import { createBeamScriptRunner } from '../viz/beamScript/runner.js'
import { loadMonaco } from '../viz/beamScript/monaco.js'
import { builtinTemplates, blankScript, loadScripts, saveScripts, newScriptId, newScriptName, copyScriptName, uniqueName } from '../viz/beamScript/library.js'
import { beamMapStats } from '../shared/beamScript/model.js'
import { curLang, byLang } from '../shared/i18n/lang.js'
import { onLangChange } from '../shared/i18n/runtime.js'
import { showExported } from '../stores/statusMsg.js'
import { reportError } from '../shared/reportError.js'
import { unzipSync } from 'fflate'

const props = defineProps({
  snapshot: { type: Object, required: true },        // BeamMap（shared/beamScript/model.js）
  recollect: { type: Function, default: null },       // () => Promise<BeamMap>：重新采集（当前画面 / 覆盖库，按 meta.scope）
  layer: { type: String, default: 'dialog' }          // 从文件管理里开（压在它上面）传 'pop'，见 AppDialog
})
const emit = defineEmits(['close'])

const UI_KEY = 'beamScript/ui'
const ui = reactive((() => {
  const d = { sel: 'b:gxt', tab: 'out', live: true, rightW: 0 }
  try { return { ...d, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') } } catch { return d }
})())
watch(ui, (v) => { try { localStorage.setItem(UI_KEY, JSON.stringify(v)) } catch { /* 隐私模式：只是不记住 */ } }, { deep: true })

const lang = ref(curLang())
const templates = computed(() => builtinTemplates(lang.value))
const scripts = ref([])
const data = shallowRef(props.snapshot)
const stats = computed(() => beamMapStats(data.value))
const fromLibrary = computed(() => !!(data.value && data.value.meta && data.value.meta.scope === 'library'))

const edEl = ref(null), pvEl = ref(null), bodyEl = ref(null), fileEl = ref(null)
const ready = ref(false)
const loadErr = ref('')
let monaco = null, editor = null, viewer = null, pvModel = null
const models = new Map()        // 'b:<模板 id>' | 'u:<脚本 id>' → Monaco 模型
let muteFork = false            // 程序改写模型内容时不触发「另存为用户脚本」
const runner = createBeamScriptRunner()
runner.setData(props.snapshot)

const current = computed(() => {
  const [k, id] = String(ui.sel).split(/:(.*)/s)
  if (k === 'u') { const s = scripts.value.find((x) => x.id === id); if (s) return { kind: 'user', id, name: s.name, script: s } }
  const t = templates.value.find((x) => x.id === id) || templates.value[0]
  return t ? { kind: 'builtin', id: t.id, name: t.name, tpl: t } : null
})

/* ===================== 运行 ===================== */
const run = reactive({ busy: false, ok: null, ms: 0, files: [], logs: [], error: null, seq: 0, exporting: false })
const outSel = ref(0)
let liveT = 0
function codeNow() { return editor && editor.getModel() ? editor.getModel().getValue() : '' }
function scriptName() { return (current.value && current.value.name) || 'beam-map' }
async function execute(timeoutMs) {
  const seq = ++run.seq
  run.busy = true
  const res = await runner.run(codeNow(), { lang: lang.value, scriptName: scriptName(), timeoutMs })
  if (res.canceled || seq !== run.seq) return null
  run.busy = false
  run.ok = !!res.ok; run.ms = res.ms || 0; run.error = res.error || null
  run.logs = res.logs || []
  if (res.ok) {
    const prev = run.files[outSel.value] && run.files[outSel.value].name
    run.files = res.files || []
    const keep = run.files.findIndex((f) => f.name === prev)
    outSel.value = keep >= 0 ? keep : 0
  }
  setRunMarkers(res.error)
  return res
}
function runNow() {
  clearTimeout(liveT)
  execute(10000).then((res) => { if (res && !res.ok) ui.tab = 'con' })
}
function scheduleLive() {
  clearTimeout(liveT)
  if (!ui.live || run.exporting) return   // 导出那一轮在跑：别让预览把它顶掉
  liveT = setTimeout(() => execute(6000), 500)
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
  monaco.editor.setModelMarkers(m, 'beamscript-run', marks)
}
function gotoLine(line, col) {
  if (!editor || !line) return
  editor.revealLineInCenterIfOutsideViewport(line)
  editor.setPosition({ lineNumber: line, column: col || 1 })
  editor.focus()
}

/* ===================== 输出预览 ===================== */
const outFile = computed(() => run.files[outSel.value] || null)
const extOf = (n) => { const b = String(n || '').split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : '' }
const LANG_BY_EXT = { gxt: 'ini', ini: 'ini', kml: 'xml', xml: 'xml', svg: 'xml', gpx: 'xml', gml: 'xml', dae: 'xml', html: 'xml', geojson: 'bm-json', json: 'bm-json', topojson: 'bm-json', csv: 'bm-csv', tsv: 'bm-csv', txt: 'plaintext' }
const ZIP_EXT = new Set(['zip', 'kmz'])
const IMG_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }
const PV_CAP = 2_000_000
const pvTruncated = computed(() => !!(outFile.value && outFile.value.kind === 'text' && outFile.value.text.length > PV_CAP))
const zipList = computed(() => {
  const f = outFile.value
  if (!f || f.kind !== 'binary' || !ZIP_EXT.has(extOf(f.name))) return null
  const list = []
  try { unzipSync(f.bytes, { filter: (e) => { list.push({ name: e.name, size: e.originalSize }); return false } }) } catch { return null }
  return list
})
const imgUrl = ref('')
watch(outFile, (f) => {
  if (imgUrl.value) { URL.revokeObjectURL(imgUrl.value); imgUrl.value = '' }
  if (f && f.kind === 'binary' && IMG_EXT[extOf(f.name)]) imgUrl.value = URL.createObjectURL(new Blob([f.bytes], { type: IMG_EXT[extOf(f.name)] }))
  syncViewer()
})
function syncViewer() {
  if (!monaco || !pvModel) return
  const f = outFile.value
  const text = f && f.kind === 'text' ? (f.text.length > PV_CAP ? f.text.slice(0, PV_CAP) : f.text) : ''
  monaco.editor.setModelLanguage(pvModel, f && f.kind === 'text' ? (LANG_BY_EXT[extOf(f.name)] || 'plaintext') : 'plaintext')
  if (pvModel.getValue() !== text) pvModel.setValue(text)
}
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B')
const ENC_TAG = { 'utf-8-bom': 'UTF-8 BOM', gbk: 'GBK', latin1: 'Latin-1', 'utf-16le': 'UTF-16LE' }
const totalSize = computed(() => run.files.reduce((s, f) => s + (f.size || 0), 0))
const errCount = computed(() => run.logs.filter((l) => l.level === 'error').length + (run.error ? 1 : 0))
const warnCount = computed(() => run.logs.filter((l) => l.level === 'warn').length)

/* ===================== 脚本库 ===================== */
let saveT = 0
// 磁盘上的脚本库读回之前不写盘（否则只剩本次新建的几条）；期间要存的记下，读回并入后补存
let libReady = false, libDirty = false
function persist(now) {
  clearTimeout(saveT)
  if (!libReady) { libDirty = true; saveT = 0; return }
  const go = () => { Promise.resolve(saveScripts(scripts.value)).catch((e) => reportError('脚本保存失败', e)) }
  if (now) go(); else saveT = setTimeout(go, 600)
}
function modelFor(key) {
  let m = models.get(key)
  if (m && !m.isDisposed()) return m
  const [k, id] = key.split(/:(.*)/s)
  const code = k === 'u' ? ((scripts.value.find((x) => x.id === id) || {}).code || '') : ((templates.value.find((x) => x.id === id) || {}).code || '')
  // URI 只给 TypeScript 语言服务当文件名用；每个模型一个新号（模板另存后原模型改归用户脚本，模板再开要新文件名）
  m = monaco.editor.createModel(code, 'javascript', monaco.Uri.parse(`file:///beammap/s${models.size + 1}-${Date.now().toString(36)}.js`))
  m.updateOptions({ tabSize: 2, insertSpaces: true })
  m.onDidChangeContent(() => onEdit(m))
  models.set(key, m)
  return m
}
function keyOfModel(m) { for (const [k, v] of models) if (v === m) return k; return '' }
function onEdit(m) {
  if (muteFork) return
  const key = keyOfModel(m)
  if (key.startsWith('b:')) forkBuiltin(key, m)
  else if (key.startsWith('u:')) {
    const s = scripts.value.find((x) => 'u:' + x.id === key)
    if (s) { s.code = m.getValue(); s.updatedAt = new Date().toISOString(); persist() }
  }
  if (editor && editor.getModel() === m) scheduleLive()
}
// 内置模板首次改动：就地另存为用户脚本 —— 同一个模型改归新脚本（光标、撤销链不断），模板下次再开时重建一份原样的
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
  run.files = []; run.logs = []; run.error = null; run.ok = null
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
function newScript() { addScript(newScriptName(scripts.value.map((x) => x.name)), blankScript(lang.value)) }
function duplicateTpl(t) { addScript(copyScriptName(t.name, scripts.value.map((x) => x.name)), t.code, t.id) }
function duplicateUser(s) { addScript(copyScriptName(s.name, scripts.value.map((x) => x.name)), (models.get('u:' + s.id) || { getValue: () => s.code }).getValue(), s.from) }
// 删除：先摘掉，页脚给 8 s 撤销
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
// 行内改名：Enter / 失焦提交，Esc 放弃（Esc 就地拦下，别让对话框关掉）
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
// 列表行的键盘：只认焦点就在行本身时（行里的改名框照常打字）
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
// 导入 / 导出脚本文件（.js 纯文本）
function pickImport() { if (fileEl.value) { fileEl.value.value = ''; fileEl.value.click() } }
async function onImportFile(e) {
  const files = [...((e.target && e.target.files) || [])]
  for (const f of files) {
    try {
      const text = await f.text()
      addScript(f.name.replace(/\.(m?js|bmjs|txt)$/i, '') || newScriptName(scripts.value.map((x) => x.name)), text.replace(/^﻿/, ''))
    } catch (err) { flash(byLang(`无法读取「${f.name}」：`, `Cannot read "${f.name}": `) + ((err && err.message) || err), 'error') }
  }
}
async function exportScriptFile(s) {
  const api = window.api
  if (!api || !api.exportFile) { flash(byLang('需在桌面客户端中运行', 'Requires the desktop app'), 'error'); return }
  const m = models.get('u:' + s.id)
  const code = m && !m.isDisposed() ? m.getValue() : s.code
  const r = await api.exportFile({ defaultName: s.name.replace(/[\\/:*?"<>|]+/g, '_') + '.js', data: code, filters: [{ name: 'JavaScript', extensions: ['js'] }] })
  if (r && r.ok) { const p = r.path || r.filePath; if (p) showExported(p); flash(byLang('已导出：', 'Exported: ') + String(p || '').split(/[\\/]/).pop()) }
  else if (r && !r.canceled) flash(byLang('导出失败：', 'Export failed: ') + (r.error || ''), 'error')
}

/* ===================== 导出 ===================== */
async function doExport() {
  if (run.exporting) return
  const api = window.api
  if (!api || !api.exportFile) { flash(byLang('需在桌面客户端中运行', 'Requires the desktop app'), 'error'); return }
  run.exporting = true
  clearTimeout(liveT)
  try {
    const res = await execute(60000)
    if (!res) return
    if (!res.ok) { ui.tab = 'con'; return }
    const files = res.files || []
    if (!files.length) { flash(byLang('无输出文件。', 'No output files.'), 'warn'); return }
    if (files.length === 1) {
      const f = files[0]
      const base = f.name.split('/').pop()
      const ext = extOf(base)
      const payload = (f.kind === 'text' && f.encoding === 'utf-8') ? f.text : f.bytes
      const filters = ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: '所有文件', extensions: ['*'] }] : [{ name: '所有文件', extensions: ['*'] }]
      const r = await api.exportFile({ defaultName: base, data: payload, filters })
      if (r && r.ok) { const p = r.path || r.filePath; if (p) showExported(p); flash(byLang('已导出：', 'Exported: ') + String(p || base).split(/[\\/]/).pop()) }
      else if (r && !r.canceled) flash(byLang('导出失败：', 'Export failed: ') + (r.error || ''), 'error')
    } else {
      const r = await api.exportFiles({
        dirLabel: '选择输出目录',
        files: files.map((f) => ((f.kind === 'text' && f.encoding === 'utf-8') ? { filename: f.name, text: f.text } : { filename: f.name, data: f.bytes }))
      })
      if (r && r.ok) { if (r.path) showExported(r.path); flash(byLang(`已导出 ${files.length} 个文件`, `Exported ${files.length} files`)) }
      else if (r && !r.canceled) flash(byLang('导出失败：', 'Export failed: ') + (r.error || ''), 'error')
    }
  } catch (e) {
    flash(byLang('导出失败：', 'Export failed: ') + ((e && e.message) || e), 'error')
  } finally { run.exporting = false }
}

/* ===================== 数据 ===================== */
const recollecting = ref(false)
async function recollectNow() {
  if (!props.recollect || recollecting.value) return
  recollecting.value = true
  try {
    const d = await props.recollect()
    if (d) { data.value = d; runner.setData(d); if (ui.live) scheduleLive() }
  } catch (e) { flash(byLang('重新采集失败：', 'Recapture failed: ') + ((e && e.message) || e), 'error') }
  finally { recollecting.value = false }
}
function insertPath(p) {
  if (!editor) return
  const sel = editor.getSelection()
  editor.executeEdits('beammap-data', [{ range: sel, text: p, forceMoveMarkers: true }])
  editor.focus()
}
const capturedAt = computed(() => {
  const t = data.value && data.value.meta && data.value.meta.createdAt
  if (!t) return ''
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
})

/* ===================== 页脚状态句 ===================== */
const msg = reactive({ text: '', level: 'info' })
let msgT = 0
function flash(text, level = 'info', ms = 5000) {
  clearTimeout(msgT)
  msg.text = text; msg.level = level
  msgT = setTimeout(() => { msg.text = '' }, ms)
}

/* ===================== 右栏宽度（拖分隔条） ===================== */
const rightW = computed(() => (ui.rightW > 0 ? ui.rightW + 'px' : '38%'))
function startDrag(ev) {
  const box = bodyEl.value
  if (!box) return
  const rect = box.getBoundingClientRect()
  const move = (e) => { ui.rightW = Math.round(Math.max(260, Math.min(rect.width * 0.6, rect.right - e.clientX))) }
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.documentElement.classList.remove('ui-col-resize') }
  document.documentElement.classList.add('ui-col-resize')
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  ev.preventDefault()
}

/* ===================== 生命周期 ===================== */
let offLang = null
onMounted(async () => {
  try {
    // 脚本库与编辑器各自载入：库先回来就先并入（载入期间新建 / 导入的条目排在后面），不等编辑器
    const libP = loadScripts().then((list) => {
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
    openCurrent()
    offLang = onLangChange((l) => {
      lang.value = l
      // 内置模板的注释与文件名跟着语言换（内置模型从不带用户改动——一改就另存了）
      muteFork = true
      try { for (const [k, m] of models) { if (k.startsWith('b:')) { const t = templates.value.find((x) => 'b:' + x.id === k); if (t && m.getValue() !== t.code) m.setValue(t.code) } } }
      finally { muteFork = false }
    })
  } catch (e) {
    loadErr.value = String((e && e.message) || e)
    reportError('编辑器加载失败', e)
  }
})
onBeforeUnmount(() => {
  clearTimeout(liveT); clearTimeout(msgT); clearTimeout(undoT)
  if (saveT) persist(true)
  if (offLang) offLang()
  runner.dispose()
  if (imgUrl.value) URL.revokeObjectURL(imgUrl.value)
  try { if (editor) editor.dispose(); if (viewer) viewer.dispose(); if (pvModel) pvModel.dispose(); for (const m of models.values()) m.dispose() } catch { /* 已释放 */ }
  models.clear()
})
</script>

<template>
  <AppDialog :width="'min(1360px, calc(100vw - 32px))'" flush dialog-class="bsd-dlg" initial-focus=".bsd-run" :layer="layer" @close="emit('close')">
    <template #title>可编程波束地图<span v-if="fromLibrary" class="bsd-src" data-i18n-skip>{{ data.meta.title }}</span></template>
    <div ref="bodyEl" class="bsd" :style="{ '--bsd-right': rightW }">
      <!-- ① 脚本库 -->
      <aside class="bsd-lib">
        <div class="bsd-ph">
          <span class="bsd-pt">脚本库</span>
          <button type="button" class="ibtn sm" title="新建脚本" :disabled="!ready" @click="newScript"><Icon name="plus" :size="14" /></button>
          <button type="button" class="ibtn sm" title="导入脚本（.js）" :disabled="!ready" @click="pickImport"><Icon name="file-import" :size="14" /></button>
          <input ref="fileEl" type="file" accept=".js,.mjs,.bmjs,.txt" multiple hidden @change="onImportFile" />
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
          <button type="button" class="btn sm bsd-run" title="运行脚本（F5 / Ctrl+Enter）" :disabled="!ready" @click="runNow"><Icon name="play" :size="12" />运行脚本</button>
        </div>
        <div class="bsd-code">
          <div ref="edEl" class="bsd-monaco" data-i18n-skip />
          <div v-if="!ready" class="bsd-loading">{{ loadErr ? loadErr : '' }}</div>
        </div>
      </section>

      <div class="bsd-split" role="separator" aria-orientation="vertical" title="拖动调整宽度" @pointerdown="startDrag" />

      <!-- ③ 输出 / 控制台 / 数据 -->
      <section class="bsd-out">
        <div class="bsd-ph">
          <div class="seg sm" role="tablist">
            <button type="button" class="sg" role="tab" :aria-selected="ui.tab === 'out'" :class="{ on: ui.tab === 'out' }" @click="ui.tab = 'out'">输出文件<b v-if="run.files.length" class="bsd-n">{{ run.files.length }}</b></button>
            <button type="button" class="sg" role="tab" :aria-selected="ui.tab === 'con'" :class="{ on: ui.tab === 'con' }" @click="ui.tab = 'con'">控制台<b v-if="errCount" class="bsd-n err">{{ errCount }}</b><b v-else-if="warnCount" class="bsd-n warn">{{ warnCount }}</b><b v-else-if="run.logs.length" class="bsd-n">{{ run.logs.length }}</b></button>
            <button type="button" class="sg" role="tab" :aria-selected="ui.tab === 'data'" :class="{ on: ui.tab === 'data' }" @click="ui.tab = 'data'">输入数据</button>
          </div>
          <span class="bsd-sp" />
          <template v-if="ui.tab === 'data'">
            <span v-if="capturedAt" class="bsd-ro" title="采集时刻">{{ capturedAt }}</span>
            <button v-if="recollect" type="button" class="ibtn sm" :title="fromLibrary ? '重新读取覆盖库' : '重新采集当前地图数据'" :disabled="recollecting" @click="recollectNow"><Icon name="refresh-cw" :size="13" /></button>
          </template>
        </div>

        <!-- 输出 -->
        <div v-show="ui.tab === 'out'" class="bsd-pane bsd-outp">
          <div v-if="run.files.length" class="bsd-files">
            <button v-for="(f, i) in run.files" :key="f.name" type="button" class="bsd-file" :class="{ on: i === outSel }" :title="f.name" @click="outSel = i">
              <span class="bsd-fn" data-i18n-skip>{{ f.name }}</span>
              <span v-if="ENC_TAG[f.encoding]" class="bsd-enc">{{ ENC_TAG[f.encoding] }}</span>
              <span class="bsd-fs">{{ fmtSize(f.size) }}</span>
            </button>
          </div>
          <div v-show="outFile && outFile.kind === 'text'" class="bsd-viewer">
            <div ref="pvEl" class="bsd-monaco" data-i18n-skip />
          </div>
          <div v-if="pvTruncated" class="bsd-trunc"><span>预览仅显示前</span> <b>{{ fmtSize(PV_CAP) }}</b></div>
          <div v-if="outFile && outFile.kind === 'binary'" class="bsd-bin">
            <img v-if="imgUrl" :src="imgUrl" class="bsd-img" alt="" />
            <table v-else-if="zipList" class="bsd-zip">
              <tr v-for="z in zipList" :key="z.name"><td data-i18n-skip>{{ z.name }}</td><td>{{ fmtSize(z.size) }}</td></tr>
            </table>
            <div v-else class="bsd-empty">{{ fmtSize(outFile.size) }}</div>
          </div>
          <div v-if="!run.files.length" class="bsd-empty">{{ run.busy ? '' : (run.ok === false ? '运行失败。' : '无输出文件。') }}</div>
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

        <!-- 数据 -->
        <div v-show="ui.tab === 'data'" class="bsd-pane bsd-data">
          <BeamDataTree :value="data" name="data" path="data" open @pick="insertPath" />
        </div>
      </section>
    </div>

    <template #footer>
      <div class="adlg-ft-l bsd-ft">
        <button type="button" class="btn sm" :class="{ on: ui.live }" :aria-pressed="ui.live" title="编辑停止 0.5 s 后自动运行" @click="ui.live = !ui.live">实时预览</button>
        <span class="bsd-stat">
          <b>{{ stats.beams }}</b><span>个波束</span><i>·</i><b>{{ stats.contours }}</b><span>条等值线</span><i>·</i><b>{{ stats.polygons }}</b><span>个 Polygon</span><i>·</i><b>{{ stats.markers }}</b><span>个标记</span>
        </span>
        <span v-if="msg.text" class="bsd-msg" :class="'lv-' + msg.level">
          <span>{{ msg.text }}</span>
          <button v-if="undo" type="button" class="bsd-link" @click="undoRemove">撤销</button>
        </span>
        <span v-else-if="run.busy && run.exporting" class="bsd-msg">正在运行…</span>
        <span v-else-if="run.error" class="bsd-msg lv-error" :title="run.error.message">
          <span v-if="run.error.line">{{ run.error.line }}:{{ run.error.col || 1 }}</span>
          <span class="bsd-emsg" data-i18n-skip>{{ run.error.message }}</span>
        </span>
        <span v-else-if="run.ok" class="bsd-stat">
          <b>{{ run.ms }}</b><span>ms</span><i>·</i><b>{{ run.files.length }}</b><span>个文件</span><i>·</i><b>{{ fmtSize(totalSize) }}</b>
        </span>
      </div>
      <button type="button" class="btn" @click="emit('close')">关闭</button>
      <button type="button" class="btn primary" :disabled="!ready || run.exporting" @click="doExport">导出…</button>
    </template>
  </AppDialog>
</template>

<style scoped>
.bsd { --bsd-left: 232px; display: grid; grid-template-columns: var(--bsd-left) minmax(0, 1fr) 5px var(--bsd-right); height: min(780px, calc(100vh - 150px)); min-height: 420px; background: var(--surface); }
.bsd-lib, .bsd-ed, .bsd-out { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.bsd-lib { border-right: 1px solid var(--border); }
.bsd-out { position: relative; }
/* 栏头：30 px，标题 + 动作 */
.bsd-ph { flex: none; display: flex; align-items: center; gap: 4px; height: 32px; padding: 0 6px 0 10px; border-bottom: 1px solid var(--border); background: var(--surface-2); }
.bsd-pt { flex: 1; font-size: var(--fs-2); font-weight: 600; color: var(--text-muted); letter-spacing: var(--ls-label); }
.bsd-sp { flex: 1; }
.bsd-cur { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-3); font-weight: 600; color: var(--text); }
.bsd-src { margin-left: 10px; font-weight: 400; color: var(--text-muted); }
.bsd-tag { flex: none; padding: 0 5px; line-height: 16px; font-size: var(--fs-1); color: var(--text-muted); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); }
.bsd-ro { font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
/* 脚本库 */
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
/* 编辑器 */
.bsd-code { position: relative; flex: 1; min-height: 0; background: var(--field-bg); }
.bsd-monaco { position: absolute; inset: 0; }
.bsd-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: var(--fs-3); color: var(--danger); }
.bsd-run :deep(svg) { color: var(--accent-ui); }
/* 分隔条 */
.bsd-split { cursor: col-resize; background: var(--surface); border-left: 1px solid var(--border); border-right: 1px solid var(--border); }
.bsd-split:hover { background: var(--accent-ui-weak); }
/* 右栏 */
.bsd-n { margin-left: 5px; padding: 0 5px; min-width: 16px; line-height: 15px; border-radius: var(--r-pill); font-size: var(--fs-1); font-weight: 600; background: color-mix(in srgb, var(--text) 14%, transparent); color: inherit; }
.bsd-n.err { background: var(--danger); color: #fff; }
.bsd-n.warn { background: var(--warn); color: #fff; }
.bsd-pane { flex: 1; min-height: 0; overflow: auto; }
.bsd-abs { position: absolute; top: 32px; left: 0; right: 0; bottom: 0; }
.bsd-outp { display: flex; flex-direction: column; overflow: hidden; }
.bsd-files { flex: none; max-height: 38%; overflow: auto; padding: 4px 0; border-bottom: 1px solid var(--border); }
.bsd-file { display: flex; align-items: center; gap: 8px; width: 100%; height: 24px; padding: 0 10px; border: 0; border-radius: 0; background: transparent; text-align: left; font-size: var(--fs-3); color: var(--text); }
.bsd-file:hover { background: var(--wash-hover); }
.bsd-file.on { background: var(--accent-ui-weak); }
.bsd-fn { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bsd-enc { flex: none; padding: 0 4px; line-height: 15px; font-size: var(--fs-1); color: var(--text-muted); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); }
.bsd-fs { flex: none; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.bsd-viewer { position: relative; flex: 1; min-height: 0; background: var(--field-bg); }
.bsd-trunc { flex: none; padding: 3px 10px; font-size: var(--fs-2); color: var(--warn); border-top: 1px solid var(--border); }
.bsd-bin { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px; background: var(--field-bg); }
.bsd-img { max-width: 100%; background: repeating-conic-gradient(color-mix(in srgb, var(--text) 8%, transparent) 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
.bsd-zip { width: 100%; border-collapse: collapse; font-size: var(--fs-3); }
.bsd-zip td { padding: 3px 4px; border-bottom: 1px solid var(--border); }
.bsd-zip td + td { text-align: right; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
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
.bsd-data { padding: 4px 4px 8px; }
/* 页脚 */
.bsd-ft { min-width: 0; gap: 12px; }
.bsd-stat { display: inline-flex; align-items: baseline; gap: 3px; font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.bsd-stat b { font-weight: 600; color: var(--text); }
.bsd-stat i { font-style: normal; color: var(--text-faint); padding: 0 3px; }
.bsd-msg { display: inline-flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; overflow: hidden; }
.bsd-msg.lv-error { color: var(--danger); }
.bsd-msg.lv-warn { color: var(--warn); }
.bsd-emsg { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.bsd-link { flex: none; height: auto; padding: 0; border: 0; background: transparent; font: inherit; color: var(--accent-ui); text-decoration: underline; text-underline-offset: 2px; }
</style>

<style>
/* 框体高度由正文网格定，不让外壳再滚一层；Monaco 的浮层（补全 / 悬停）是 fixed，不被栏格裁掉 */
.bsd-dlg .adlg-bd { overflow: hidden; }
</style>
