// 通用 Excel 式表格交互：框选（鼠标拖拽 / Shift 扩选）+ 键盘导航 + 区域复制 +（可选）双击/键入编辑、区域粘贴、区域清除。
// 与具体数据解耦——行/列/取值/写值全部由 cfg 注入；同一份逻辑可挂在「城市输入」（可编辑）与「性能结果」（只读）两张表上。
// 选区 = 锚点(ar,ac) → 活动格(ri,ci) 构成的矩形（ri=行下标，ci=列下标，均以 cfg.rows()/cfg.cols() 的当前顺序计）。
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'

export function useGridSelect(cfg) {
  // cfg:
  //   rows:      () => Row[]            每行需有稳定 id（编辑/粘贴定位用）
  //   cols:      () => Col[]            { key, num, fix, editable? }；editable !== false 且非只读表时该列可编辑
  //   readOnly?: boolean               只读表：仅框选 + 复制 + 导航，无编辑/粘贴/清除
  //   cellText:  (row, col) => string  显示/复制文本
  //   cellRaw?:  (row, col) => any      进入编辑时的原始值（默认 row[col.key]）
  //   onEdit?:   (rowId, key, value)    提交单格（外部负责写库；本模块已先 pushUndo）
  //   onPasteBlock?: (anchorRowId, startKey, text) => number   以锚点为左上角定位填充，返回填充行数
  //   onPasteAppend?:(text) => number   无选区/空表时的整块追加，返回新增行数
  //   onClear?:  (cells:{rowId,key}[])  批量清空（已先 pushUndo）
  //   pushUndo? / dropUndo? / refresh?  撤销快照 / 撤回空操作快照 / 变更后重算
  const sel = ref({ ar: -1, ac: -1, ri: -1, ci: -1 })
  const edit = ref({ ri: -1, ci: -1 })
  const editSeed = ref(null)              // 键入进入编辑的首字符（null=保留原值并全选）
  const editEl = ref(null)                // 编辑中 input 的 DOM
  const bodyEl = ref(null)                // 网格容器（接收键盘/复制焦点）
  let dragging = false

  const rect = computed(() => {
    const s = sel.value
    return { r0: Math.min(s.ar, s.ri), r1: Math.max(s.ar, s.ri), c0: Math.min(s.ac, s.ci), c1: Math.max(s.ac, s.ci) }
  })
  const inSel = (ri, ci) => { const r = rect.value; return r.r0 >= 0 && ri >= r.r0 && ri <= r.r1 && ci >= r.c0 && ci <= r.c1 }
  const isActive = (ri, ci) => sel.value.ri === ri && sel.value.ci === ci
  const isEdit = (ri, ci) => edit.value.ri === ri && edit.value.ci === ci
  const colEditable = (c) => !cfg.readOnly && !!c && c.editable !== false

  function focusGrid() { const el = bodyEl.value; if (el) el.focus() }
  function setSel(ri, ci, extend) { const s = sel.value; sel.value = extend && s.ar >= 0 ? { ar: s.ar, ac: s.ac, ri, ci } : { ar: ri, ac: ci, ri, ci } }
  function cellDown(e, ri, ci) {
    if (isEdit(ri, ci)) return                        // 正在编辑此格 → 交给 input
    e.preventDefault()
    if (edit.value.ri >= 0) commitEdit()
    setSel(ri, ci, e.shiftKey); dragging = !e.shiftKey; focusGrid()
  }
  function cellEnter(ri, ci) { if (dragging) setSel(ri, ci, true) }
  function up() { dragging = false }
  function tryEdit(ri, ci, seed) {
    const c = cfg.cols()[ci]; if (!colEditable(c)) return
    sel.value = { ar: ri, ac: ci, ri, ci }; editSeed.value = seed; edit.value = { ri, ci }
  }
  function rawText(r, c) { const v = cfg.cellRaw ? cfg.cellRaw(r, c) : r[c.key]; return v == null ? '' : String(v) }
  function commitEdit() {
    const { ri, ci } = edit.value; if (ri < 0) return
    const el = editEl.value, r = cfg.rows()[ri], c = cfg.cols()[ci]
    edit.value = { ri: -1, ci: -1 }; editSeed.value = null
    if (el && r && c && el.value !== rawText(r, c)) {   // 仅值确实变化才记撤销
      cfg.pushUndo && cfg.pushUndo(); cfg.onEdit && cfg.onEdit(r.id, c.key, el.value)
    }
    cfg.refresh && cfg.refresh()
  }
  function cancelEdit() { edit.value = { ri: -1, ci: -1 }; editSeed.value = null; focusGrid() }
  function move(dr, dc, extend) {
    const nr = cfg.rows().length, nc = cfg.cols().length; if (!nr || !nc) return
    let ri = sel.value.ri < 0 ? 0 : sel.value.ri, ci = sel.value.ci < 0 ? 0 : sel.value.ci
    ri = Math.min(nr - 1, Math.max(0, ri + dr)); ci = Math.min(nc - 1, Math.max(0, ci + dc))
    setSel(ri, ci, extend)
  }
  function rangeTSV() {
    const rows = cfg.rows(), cols = cfg.cols(), rc = rect.value
    if (rc.r0 < 0 || !rows.length) return ''
    const lines = []
    for (let ri = rc.r0; ri <= rc.r1; ri++) {
      const r = rows[ri]; if (!r) continue
      const cells = []; for (let ci = rc.c0; ci <= rc.c1; ci++) cells.push(cfg.cellText(r, cols[ci]))
      lines.push(cells.join('\t'))
    }
    return lines.join('\n')
  }
  // 同步优先：execCommand('copy') 必须在用户手势（keydown/click）同步栈内执行才有效；
  // 一旦 await 过 navigator.clipboard 就丢失 user activation，故把同步路径放第一位，异步 API 仅兜底。
  function writeClip(text) {
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
    if (!ok) { try { navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {}) } catch {} }
    return ok
  }
  function copySel() { const t = rangeTSV(); if (t) { writeClip(t); focusGrid() } }
  function clearRange() {
    if (cfg.readOnly || !cfg.onClear) return
    const rows = cfg.rows(), cols = cfg.cols(), rc = rect.value; if (rc.r0 < 0) return
    const cells = []
    for (let ri = rc.r0; ri <= rc.r1; ri++) { const r = rows[ri]; if (!r) continue; for (let ci = rc.c0; ci <= rc.c1; ci++) { const c = cols[ci]; if (colEditable(c)) cells.push({ rowId: r.id, key: c.key }) } }
    if (!cells.length) return
    cfg.pushUndo && cfg.pushUndo(); cfg.onClear(cells); cfg.refresh && cfg.refresh()
  }
  // 非编辑态 Ctrl+V：容器不可编辑时浏览器不派发 paste，故读剪贴板。有选区→按左上角定位填充；空表/未选→整块追加。
  async function doPaste() {
    if (cfg.readOnly) return
    let text = ''
    try { text = await navigator.clipboard.readText() } catch { alert('无法读取剪贴板，请用「粘贴」按钮'); return }
    if (!text || !text.trim()) return
    cfg.pushUndo && cfg.pushUndo()
    const rc = rect.value, rows = cfg.rows(), c = cfg.cols()[rc.c0]
    const anchorId = (rc.r0 >= 0 && rows[rc.r0]) ? rows[rc.r0].id : null
    const n = (anchorId && c && cfg.onPasteBlock) ? cfg.onPasteBlock(anchorId, c.key, text) : (cfg.onPasteAppend ? cfg.onPasteAppend(text) : 0)
    if (n) { cfg.refresh && cfg.refresh() } else { cfg.dropUndo && cfg.dropUndo() }
  }
  // 编辑中 input 内 Ctrl+V：整块→以该格定位填充（单值走普通输入）
  function cellPaste(e, r, key) {
    if (cfg.readOnly || !cfg.onPasteBlock) return
    const text = e.clipboardData ? e.clipboardData.getData('text') : ''
    if (!text || !/[\t\n,]/.test(text.trim())) return
    e.preventDefault()
    cfg.pushUndo && cfg.pushUndo()
    const n = cfg.onPasteBlock(r ? r.id : null, key, text)
    if (n) { cfg.refresh && cfg.refresh() } else { cfg.dropUndo && cfg.dropUndo() }
  }
  function gridKey(e) {
    if (edit.value.ri >= 0) {                          // 编辑态：仅接管提交/取消/跳格
      if (e.key === 'Enter') { e.preventDefault(); commitEdit(); move(1, 0); focusGrid() }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
      else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); move(0, e.shiftKey ? -1 : 1); focusGrid() }
      return
    }
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copySel(); return }
    if (ctrl && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); const nr = cfg.rows().length, nc = cfg.cols().length; if (nr && nc) sel.value = { ar: 0, ac: 0, ri: nr - 1, ci: nc - 1 }; return }
    if (!cfg.readOnly && ctrl && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); copySel(); clearRange(); return }
    if (!cfg.readOnly && ctrl && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); doPaste(); return }
    const { ri, ci } = sel.value; if (ri < 0) return
    const ext = e.shiftKey
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); move(-1, 0, ext); break
      case 'ArrowDown': e.preventDefault(); move(1, 0, ext); break
      case 'ArrowLeft': e.preventDefault(); move(0, -1, ext); break
      case 'ArrowRight': e.preventDefault(); move(0, 1, ext); break
      case 'Enter': e.preventDefault(); move(1, 0, false); break
      case 'Tab': e.preventDefault(); move(0, ext ? -1 : 1, false); break
      case 'F2': if (!cfg.readOnly) { e.preventDefault(); tryEdit(ri, ci, null) } break
      case 'Delete': case 'Backspace': if (!cfg.readOnly) { e.preventDefault(); clearRange() } break
      default: if (!cfg.readOnly && e.key.length === 1 && !ctrl && !e.altKey) { e.preventDefault(); tryEdit(ri, ci, e.key) }
    }
  }
  // 进入编辑后聚焦 input：键入进入→光标末尾；F2/双击进入→全选
  watch(() => edit.value, (v) => { if (v.ri >= 0) nextTick(() => { const el = editEl.value; if (el) { el.focus(); if (editSeed.value == null) el.select() } }) })
  onMounted(() => window.addEventListener('mouseup', up))
  onBeforeUnmount(() => window.removeEventListener('mouseup', up))

  return {
    sel, edit, editSeed, editEl, bodyEl, rect, inSel, isActive, isEdit, colEditable,
    focusGrid, cellDown, cellEnter, tryEdit, commitEdit, cancelEdit, gridKey, cellPaste, copySel, doPaste, clearRange
  }
}
