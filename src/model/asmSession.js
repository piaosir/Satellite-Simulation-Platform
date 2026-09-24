// 装配页会话（P3，契约 scratchpad p3/CONTRACT.md §6.6）：ModelApp 建一份、provide('asm')。
//
// 分工：
//   · 文档与交互全在编辑器（src/viz/models/assemblyEditor.js，第一次进装配页才建）；本会话只做三件事：
//     ① 页签进出时借还视口（wb.lendViewport / reclaimViewport）并 attach / detach 编辑器；
//     ② 把编辑器事件落进一份响应式 ui（树 / 属性 / 功能区 / 读数只读它）：stats / drag 节流到 ≤ 15 Hz，松手后精确一次；
//     ③ 消费 wb.asm.req（库页「在装配页打开」、功能区「新建」、「从模板开始」、「转为装配」），并把每次提交交给 wb（草稿 + 自动入库）。
//   · 编辑器对象 markRaw、放在响应式之外（three 对象挂满全身，Vue 深代理会把它弄坏）。编辑器模块（TransformControls / BVH 求交 …）
//     第一次进装配页才动态 import：没用过装配页的窗口不为它付加载与解析的代价。
//   · 快捷键（§5.5）在这里分发：页签守卫 st.tab === 'asm'；焦点在输入框 / 下拉 / 可编辑区 / 表格里、输入法组字中、事件已被处理（树的
//     Delete / 回车）时一律不管。1 / 3 / 7 / 0 视角与 F 取景仍归 ModelApp（F 在装配页转给 frameSelection）。
//   · 工具状态（吸附 / 对称 / 坐标系 / 栏宽 …）存 localStorage model/asm/ui（便利数据，坏了回缺省）。
import { reactive, shallowRef, markRaw, watch } from 'vue'
import { theme } from '../stores/theme.js'
import { curLang } from '../shared/i18n/lang.js'
import { UI_KEY, sanitizeUi, nextSpace } from './asmLogic.js'
import { clearBuildCache } from '@core/models/assembly.mjs'

const errText = (e) => (e && e.message) || String(e)
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const UI_HZ_MS = 66   // 拖动中 UI 读数 / 属性面板刷新间隔（≤ 15 Hz）

/**
 * @param {{wb:object, getVp:()=>object|null, ov?:object}} o
 */
export function createAsmSession({ wb, getVp }) {
  const { st } = wb
  const prefs = (() => { try { return sanitizeUi(JSON.parse(localStorage.getItem(UI_KEY) || 'null')) } catch { return sanitizeUi(null) } })()

  const ui = reactive({
    ready: false, active: false,
    tool: prefs.tool, space: prefs.space, snap: { ...prefs.snap }, sym: { ...prefs.sym },
    posePreview: prefs.posePreview, showCom: prefs.showCom, showSockets: prefs.showSockets, showAxes: prefs.showAxes, posFrame: prefs.posFrame,
    selIds: [], primary: null, canUndo: false, canRedo: false,
    mode: 'idle', status: { kind: '', text: '' }, dragging: false, dragKind: '',
    invalid: {},
    stats: { count: 0, tris: 0, massKg: 0, com: [0, 0, 0], inertiaDiag: [0, 0, 0], inertia: null, bbox: [0, 0, 0, 0, 0, 0], clashes: 0, invalid: 0, massWarn: '' },
    dockW: prefs.dockW, split: prefs.split, libQ: prefs.libQ, secOpen: { ...prefs.secOpen },
    ctx: null,        // 右键菜单 {ids, x, y}（树 / 视口共用一份）
    live: null,       // 拖动中被拖件（且是选中件）的实时量 {id, parent, attach, t, q, m, pm}（编辑器 liveOf：小对象，不深拷整份文档）
    renaming: ''      // 结构树里正在改名的件
  })
  const doc = shallowRef(null)     // 编辑器最近一次提交的冻结快照（树 / 属性面板只读它）
  let editor = null
  const offs = []
  let started = false, attached = false, busy = null, pendingLoad = null, loadSeq = 0, loadSeen = -1
  let docFor = ''                  // 编辑器里这份文档属于哪个装配件 id（「打开同一件」时跳过重载的判据）

  // ── 工具状态落盘（防抖）──
  let prefT = 0
  watch(() => [ui.tool, ui.space, ui.snap.on, ui.snap.move, ui.snap.rot, ui.sym.op, ui.sym.n, ui.dockW, ui.split, ui.libQ, ui.posePreview, ui.showCom, ui.showSockets, ui.showAxes, ui.posFrame, JSON.stringify(ui.secOpen)], () => {
    clearTimeout(prefT)
    prefT = setTimeout(() => {
      const v = { tool: ui.tool, space: ui.space, snap: plain(ui.snap), sym: plain(ui.sym), dockW: ui.dockW, split: ui.split, libQ: ui.libQ, secOpen: plain(ui.secOpen), posePreview: ui.posePreview, showCom: ui.showCom, showSockets: ui.showSockets, showAxes: ui.showAxes, posFrame: ui.posFrame }
      try { localStorage.setItem(UI_KEY, JSON.stringify(v)) } catch { /* 便利数据 */ }
    }, 300)
  })

  // ── 状态行（运行时状态）──
  // 编辑器发来的状态（吸附 / 穿插 / 命令告警）由编辑器自己管时长（告警 4 s 后编辑器清、再发一次空状态）；本会话自己的短语（模块加载失败、
  // 命令抛错）按 ms 清，清的时候顺手让编辑器也清掉同一条（两边不留一边清了一边还记着的旧值：否则同一条告警第二次会被编辑器的去重吞掉）
  let statusT = 0
  function setStatus(kind, text, ms = 0) {
    clearTimeout(statusT); statusT = 0
    ui.status = { kind: kind || '', text: text || '' }
    // 会话这边清空（Esc / 程序性清除）：编辑器那边同步清，免得它还记着旧告警、同一条第二次被去重吞掉
    if (!text && editor && typeof editor.clearStatus === 'function') { try { editor.clearStatus() } catch { /* 无 */ } }
    if (ms > 0) {
      statusT = setTimeout(() => {
        statusT = 0
        if (ui.status.text !== text) return
        ui.status = { kind: '', text: '' }
        if (editor && typeof editor.clearStatus === 'function') { try { editor.clearStatus(text) } catch { /* 无 */ } }
      }, ms)
    }
  }

  // ── 读数节流：拖动中 ≤ 15 Hz，其余即时 ──
  let statsSrc = null, statsT = 0
  function flushStats() {
    clearTimeout(statsT); statsT = 0
    const s = statsSrc
    if (!s) return
    const o = ui.stats
    o.count = s.count | 0; o.tris = s.tris | 0; o.massKg = Number(s.massKg) || 0
    o.com = [s.com[0], s.com[1], s.com[2]]
    o.inertiaDiag = [s.inertiaDiag[0], s.inertiaDiag[1], s.inertiaDiag[2]]
    o.inertia = Array.isArray(s.inertia) ? s.inertia.map((r) => Array.from(r)) : null
    o.bbox = Array.from(s.bbox)
    o.clashes = s.clashes | 0; o.invalid = s.invalid | 0
    if (o.massWarn !== (s.massWarn || '')) o.massWarn = s.massWarn || ''
  }
  function onStats(s) {
    statsSrc = s
    if (ui.dragging) { if (!statsT) statsT = setTimeout(flushStats, UI_HZ_MS) } else flushStats()
  }
  // 拖动中属性面板的实时量：只取被拖件的安装量与位姿（编辑器 liveOf，小对象；≤ 15 Hz）。结构类选项（父件 / 插座 / 面 / 参数行）
  // 不跟着拖动重算——拖动中只有安装量与位姿在变
  let liveT = 0, liveId = null
  function flushLive() {
    liveT = 0
    if (!ui.dragging || !editor || !liveId || !ui.selIds.includes(liveId)) { if (ui.live) ui.live = null; return }
    let v = null
    try { v = editor.liveOf(liveId) } catch { v = null }
    ui.live = v ? Object.freeze(v) : null
  }
  function onDrag(d) {
    if (!d) return
    if (d.phase === 'start') {
      ui.dragging = true; ui.dragKind = d.kind || ''; liveId = d.id || null
      wb.asmSetDragging(true)
    } else if (d.phase === 'move') {
      liveId = d.id || liveId
      if (!liveT) liveT = setTimeout(flushLive, UI_HZ_MS)
    } else {
      ui.dragging = false; ui.dragKind = ''
      clearTimeout(liveT); liveT = 0; liveId = null; ui.live = null
      wb.asmSetDragging(false)
      flushStats()
    }
  }

  function wire(ed) {
    const on = (name, fn) => { try { const off = ed.on(name, fn); if (typeof off === 'function') offs.push(off) } catch (e) { console.warn('[asm] 订阅 ' + name + '：' + errText(e)) } }
    on('change', (e) => {
      if (!e || !e.doc) return
      doc.value = e.doc
      if (e.reason === 'load') { loadSeen = loadSeq; wb.asmAdopt(e.doc, e.json) }
      else if (e.changed !== false) wb.asmCommit(e.doc, e.json)   // Esc 取消 / 点了手柄没拖 / 原地放下：只换快照，不算一次提交
      // 选中件被删掉了（撤销 / 删除）：选择由编辑器发 select 事件，这里只防树上还挂着改名框
      if (ui.renaming && !e.doc.comps.some((c) => c.id === ui.renaming)) ui.renaming = ''
    })
    on('select', (e) => { ui.selIds = e && Array.isArray(e.ids) ? e.ids.slice() : []; ui.primary = (e && e.primary) || null })
    on('stats', onStats)
    on('drag', onDrag)
    on('status', (s) => { if (s) setStatus(s.kind, s.text) })   // 时长由编辑器管（见 setStatus 注释）
    on('history', (h) => { ui.canUndo = !!(h && h.canUndo); ui.canRedo = !!(h && h.canRedo) })
    on('mode', (m) => { if (m && m.state) ui.mode = m.state })
    on('context', (c) => { if (c) ui.ctx = { ids: Array.isArray(c.ids) ? c.ids.slice() : [], x: c.clientX, y: c.clientY } })
    on('invalid', (e) => { const by = (e && e.byId) || {}; ui.invalid = plain(by); wb.asmSetInvalid(Object.keys(by).length) })
  }
  let edLoad = null
  async function ensureEditor() {
    if (editor) return editor
    const vp = getVp()
    if (!vp) return null
    if (!edLoad) edLoad = import('../viz/models/assemblyEditor.js')
    let mod
    try { mod = await edLoad } catch (e) { edLoad = null; console.error('[asm] 编辑器模块：', e); setStatus('error', errText(e), 6000); return null }
    if (editor) return editor
    editor = markRaw(mod.createAssemblyEditor(vp, { theme: theme.resolved === 'dark' ? 'dark' : 'light', lang: () => (curLang() === 'en' ? 'en' : 'zh') }))
    wire(editor)
    return editor
  }
  /** 工具状态推给编辑器（attach 之后、换文档之后都推一遍：编辑器不记 UI 偏好） */
  function pushPrefs(ed) {
    try {
      ed.setTool(ui.tool); ed.setSpace(ui.space)
      ed.setSnap({ on: ui.snap.on, move: ui.snap.move, rotate: ui.snap.rot })
      ed.setSym({ op: ui.sym.op, n: ui.sym.n })
      ed.setShowCom(ui.showCom); ed.setShowSockets(ui.showSockets)
      if (typeof ed.setShowAxes === 'function') ed.setShowAxes(ui.showAxes)
      ed.setPosePreview(ui.posePreview)
    } catch (e) { console.warn('[asm] 工具状态：' + errText(e)) }
  }

  // ── 页签进出 ──
  async function activate() {
    if (ui.active) return
    const vp = getVp()
    if (!vp) return
    ui.active = true
    wb.lendViewport('asm')
    const ed = await ensureEditor()
    if (!ed || !ui.active) return   // 等编辑器模块期间又切走了：deactivate 已还视口
    // attach 抛了也按「已借上」处理：它多半只是某个叠加件没建起来，live 根与指针钩子已经挂上；
    // 当成没挂上的话之后的文档全压在 pendingLoad 里，整页卡在空文档（detach 照样会调，钩子撤得掉）
    try { ed.attach() } catch (e) { console.error('[asm] attach：', e) } finally { attached = true }
    pushPrefs(ed)
    ui.ready = true
    if (pendingLoad) { const p = pendingLoad; pendingLoad = null; loadDoc(p.doc, p.o) }
    if (wb.asm.req) await consumeReq()
    else if (!doc.value) {
      await run(async () => {
        if (doc.value || pendingLoad || wb.asm.req) return   // 排队期间别的请求已经载入了文档
        const r = await wb.resumeAssembly()
        if (doc.value || wb.asm.req) return
        loadDoc((r || wb.newAssembly('spacecraft')).doc, { fit: true })
      })
    }
  }
  function deactivate() {
    if (!ui.active) return
    ui.active = false
    ui.ctx = null; ui.renaming = ''
    if (editor && attached) { try { editor.detach() } catch (e) { console.error('[asm] detach：', e) } }
    attached = false
    wb.flushAssemblySave()
    wb.reclaimViewport()
    // 模块级生成缓存（网格数组住在 JS 堆里）不在离开装配页之后常驻；编辑器解算计划里的轻结果照留，回来不重生成
    clearBuildCache()
  }
  /** 串行跑一段异步（打开 / 恢复 / 换文档不交错） */
  function run(fn) {
    const p = (busy || Promise.resolve()).then(fn).catch((e) => { console.error('[asm]', e); setStatus('error', errText(e), 4000) })
    busy = p
    p.finally(() => { if (busy === p) busy = null })
    return p
  }
  function loadDoc(d, o = {}) {
    if (!d) return
    if (!editor || !ui.active || !attached) { pendingLoad = { doc: d, o }; return }
    const seq = ++loadSeq
    docFor = wb.asm.id
    try { editor.load(d, { fit: o.fit !== false }) } catch (e) {
      console.error('[asm] load：', e); setStatus('error', errText(e), 4000)
      // 抛在工作文档换上之后（叠加层 / 取景出错）：树与属性跟着编辑器实际持有的那份走，不挂着上一份
      let g = null
      try { g = editor.getDoc() } catch { g = null }
      if (g && g.domain === d.domain && g.comps.length === d.comps.length && loadSeen !== seq) { doc.value = Object.freeze(g); wb.asmAdopt(doc.value, JSON.stringify(g)) }
      return
    }
    // 编辑器 load 会同步发 change(load)；万一没发，这里兜一份快照（不然树 / 属性还挂着上一份文档）
    if (loadSeen !== seq) {
      const g = editor.getDoc()
      if (g) { doc.value = Object.freeze(g); wb.asmAdopt(doc.value, JSON.stringify(g)) }
    }
    ui.live = null
    pushPrefs(editor)
  }
  /**
   * 当前文档有改动而且存不进去（非法件 / 上次入库失败）：换文档前问一句。
   * 返回 'ok'（不用问）/ 'discard'（问过、确认放弃：调用方先 wb.discardAssembly，随后换文档时的 flush 不会把它存进库）/ false（取消）
   */
  async function confirmDiscard() {
    if (!(wb.asm.dirty && (wb.asm.invalid > 0 || !!wb.asm.saveErr))) return 'ok'
    return (await wb.askConfirm('放弃未保存的改动？')) ? 'discard' : false
  }
  function consumeReq() {
    return run(async () => {
      const req = wb.asm.req
      wb.asm.req = null
      if (!req || !ui.active) return
      if (req.kind === 'open' && req.id === wb.asm.id && doc.value && docFor === req.id) return
      const c = await confirmDiscard()
      if (!c) return
      if (c === 'discard' && typeof wb.discardAssembly === 'function') wb.discardAssembly()
      let r = null
      if (req.kind === 'open') r = await wb.openAssembly(req.id)
      else if (req.kind === 'new') r = wb.newAssembly(req.domain)
      else if (req.kind === 'template') r = wb.fromTemplate(req.entId)
      else if (req.kind === 'spec') r = req.from ? await wb.assemblyFromEntry(req.from) : wb.assemblyFromSpec(req.spec, req.base || {})
      if (r && r.doc) loadDoc(r.doc, { fit: true })
    })
  }
  watch(() => wb.asm.req, (r) => { if (r && ui.active) consumeReq() })
  // 页签驱动：先于卫星页等的视口联动注册（ModelApp 在 setup 里先建本会话），切走时先还视口、它们再喂
  watch(() => st.tab, (t, o) => {
    if (!started) return
    if (t === 'asm') activate()
    else if (o === 'asm') deactivate()
  })
  watch(() => theme.resolved, (t) => { if (editor && typeof editor.setTheme === 'function') editor.setTheme(t === 'dark' ? 'dark' : 'light') })
  /** ModelApp 在视口建好、清单读过之后调一次 */
  function start() {
    started = true
    if (st.tab === 'asm') activate()
  }

  // ── 薄包装（统一 catch；失败只写状态短语）──
  function cmd(c) {
    if (!editor) return { ok: false }
    let r
    try { r = editor.apply(plain(c)) } catch (e) { r = { ok: false, error: errText(e) } }
    if (r && r.ok === false && r.error) setStatus('error', r.error, 4000)
    return r || { ok: false }
  }
  const call = (name, ...a) => { if (!editor) return undefined; try { return editor[name](...a) } catch (e) { console.error('[asm] ' + name + '：', e); setStatus('error', errText(e), 4000); return undefined } }
  const select = (ids, o) => call('select', Array.isArray(ids) ? ids.slice() : [], o || {})
  const frameSelection = () => call('frameSelection')
  function setTool(t) { ui.tool = t === 'rotate' ? 'rotate' : 'move'; call('setTool', ui.tool) }
  function setSpace(s) { ui.space = s; call('setSpace', s) }
  function setSnap(p) { Object.assign(ui.snap, p); call('setSnap', { on: ui.snap.on, move: ui.snap.move, rotate: ui.snap.rot }) }
  function setSym(p) { Object.assign(ui.sym, p); call('setSym', { op: ui.sym.op, n: ui.sym.n }) }
  function setPosePreview(on) { ui.posePreview = !!on; call('setPosePreview', ui.posePreview) }
  function setShowCom(on) { ui.showCom = !!on; call('setShowCom', ui.showCom) }
  function setShowSockets(on) { ui.showSockets = !!on; call('setShowSockets', ui.showSockets) }
  function setShowAxes(on) { ui.showAxes = !!on; call('setShowAxes', ui.showAxes) }
  /** 某件的本体系位姿（编辑器解算表的副本，16 个数；没有 null）：属性面板的位置读数 */
  const poseOf = (id) => (editor ? call('poseOf', id) || null : null)
  const undo = () => call('undo')
  const redo = () => call('redo')
  const duplicate = () => call('duplicate')
  const remove = () => call('remove')
  const pickup = () => call('pickup')
  const mirror = () => call('mirror')
  const quickAdd = (type) => call('quickAdd', type)
  const beginDragFromLib = (type, x, y, o) => !!call('beginDragFromLib', type, x, y, o || {})
  /** 库卡片按下（还没过拖动门槛）：编辑器先把这件建进缓存、边线 / BVH 插队、ghost 材质异步编译 */
  const prewarm = (type, o) => { if (editor && ui.active && typeof editor.prewarmGhost === 'function') call('prewarmGhost', type, o || {}) }
  /** 保存：立即入库（有未存改动时） */
  function save() { return wb.flushAssemblySave() }
  /** 另存：当前文档存成新 id（原件在库里不动） */
  async function saveAs() {
    const d = editor ? editor.getDoc() : null
    if (!d) return null
    const r = await wb.saveAssembly(d, { asNew: true })
    // 另存成功：编辑器里这份文档换成了新 id（wb.asm.id）——之后在库页双击这件新的另存件，判「打开同一件」时对得上，不重读、不清撤销栈
    if (r && r.ok && wb.asm.id === r.id) docFor = wb.asm.id
    if (r && r.ok) wb.toast('已另存。')
    else if (r && (r.error || r.code === 'invalid' || r.code === 'empty')) setStatus('error', r.error || (r.code === 'empty' ? '还没有组件。' : '参数非法。'), 4000)
    return r
  }

  // ── 快捷键 ──
  const editing = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || !!(t.closest && t.closest('.eg-scroll')))
  function onKey(e) {
    if (st.tab !== 'asm' || !editor || !ui.active) return
    if (e.defaultPrevented || e.isComposing || editing(e.target)) return
    if (document.querySelector('.lb-mask')) return   // 应用内确认框开着
    const k = String(e.key || '').toLowerCase()
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.altKey) {
      if (k === 'z' && !e.shiftKey) { undo(); e.preventDefault() }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { redo(); e.preventDefault() }
      else if (k === 'd') { duplicate(); e.preventDefault() }
      return
    }
    if (e.altKey || e.repeat) return
    switch (k) {
      case 'w': setTool('move'); break
      case 'e': setTool('rotate'); break
      case 'q': setSpace(nextSpace(ui.space)); break
      case 'g': pickup(); break
      case 'm': mirror(); break
      case 'delete': case 'backspace': remove(); break
      case 'escape':
        // 拖入 / 拾起 / gizmo 拖动中的 Esc 由编辑器自己收；空闲时 Esc = 清选择
        if (ui.ctx) ui.ctx = null
        else if (ui.mode === 'idle' || ui.mode === 'hover') select([])
        else return
        break
      default: return
    }
    e.preventDefault()
  }
  window.addEventListener('keydown', onKey)

  function dispose() {
    window.removeEventListener('keydown', onKey)
    clearTimeout(prefT); clearTimeout(statusT); clearTimeout(statsT); clearTimeout(liveT)
    for (const off of offs) { try { off() } catch { /* 无 */ } }
    offs.length = 0
    if (editor) { try { editor.dispose() } catch (e) { console.error('[asm] dispose：', e) } editor = null }
  }

  return {
    ui, doc, editor: () => editor,
    start, activate, deactivate, onKey, dispose,
    cmd, select, frameSelection, setTool, setSpace, setSnap, setSym, setPosePreview, setShowCom, setShowSockets, setShowAxes, poseOf,
    undo, redo, duplicate, remove, pickup, mirror, quickAdd, beginDragFromLib, prewarm, save, saveAs, setStatus
  }
}
