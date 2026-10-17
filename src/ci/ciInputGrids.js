// 干扰分析窗的三张可编辑输入表（干扰星 / C/CCI 取值点 / NGSO 干扰星座）：
// 列定义 + 取值 / 写值口径 + useGridSelect 接线，渲染走 components/ExcelGrid.vue。
//
// ★ 行对象的形状一个字段都不改：网格行是 { id: o._id, o } 的薄包装，读写都落在 useInterference 的 reactive 行对象上，
//   snapshot / applySnapshot 与各引擎读到的字段名、类型与改造前逐字一致——
//   数字列存 number，空串 '' 照旧表示「留空 = 按缺省」；勾选存 boolean；极化存 '' | 'H' | 'V' | 'L' | 'R'。
// 枚举列的选项值 = 屏上显示的那串（「是 / 否」「—」「星历 / Walker」）：ExcelGrid 按 text(row,col) 与 option.value
// 比对来给当前项打勾，粘贴 / 填充柄送进来的也是显示串，写值时再折回存储值（parse）。
import { computed } from 'vue'
import { useGridSelect } from '../viz/grd/useGridSelect.js'

// —— 取值 / 写值口径 ——（parse 返回 undefined = 不认，不写）
const cleanNum = (v) => String(v == null ? '' : v).trim().replace(/[，]/g, '.').replace(/[－−]/g, '-')
const parseNum = (v) => { const s = cleanNum(v); if (s === '') return ''; const n = Number(s); return Number.isFinite(n) ? n : undefined }
const showNum = (v) => (v == null || v === '' ? '' : String(v))
const parseBool = (v) => {
  const s = String(v == null ? '' : v).trim().toLowerCase()
  if (['是', 'true', '1', 'y', 'yes', 'on', '√', '✓'].includes(s)) return true
  if (['否', 'false', '0', 'n', 'no', 'off', ''].includes(s)) return false
  return undefined
}
const POLS = ['H', 'V', 'L', 'R']
const parsePol = (v) => { const s = String(v == null ? '' : v).trim().toUpperCase(); if (s === '' || s === '—' || s === '-') return ''; return POLS.includes(s) ? s : undefined }
const parseSrc = (v) => { const s = String(v == null ? '' : v).trim().toLowerCase(); if (s === 'walker') return 'walker'; if (s === '星历' || s === 'group') return 'group'; return undefined }

const YESNO = [{ value: '是' }, { value: '否' }]
const POL_OPTS = [{ value: '—' }, ...POLS.map((p) => ({ value: p }))]

// 列构造：num / text / bool / pol / src 五种口径；blank = 清除时写回的值（undefined = 该列不收清除）
const num = (key, label, unit, w, extra) => ({ key, label, unit, w, num: true, get: (o) => showNum(o[key]), parse: parseNum, blank: '', ...extra })
const txt = (key, label, w, extra) => ({ key, label, w, get: (o) => String(o[key] == null ? '' : o[key]), parse: (v) => String(v == null ? '' : v).trim(), blank: '', ...extra })
const bool = (key, label, w, extra) => ({ key, label, w, options: YESNO, get: (o) => (o[key] ? '是' : '否'), parse: parseBool, ...extra })
const pol = (key, w, extra) => ({ key, label: '极化', w, options: POL_OPTS, get: (o) => o[key] || '—', parse: parsePol, blank: '', ...extra })

// —— 列定义 ——
export const SRC_COLS = [
  bool('enabled', '启用', 54),
  txt('name', '名称', 168),
  num('lonDeg', '轨位', '°E', 92, { tip: '轨位（东经为正，西经为负）' }),
  num('eirpDensityDbWPerHz', '下行 EIRP 密度', 'dBW/Hz', 156, { tip: '邻星朝本站方向的下行 EIRP 密度' }),
  pol('polarization', 84, { label: '下行极化' }),
  // 上行 C/ASI 的干扰量：邻网发端站朝本星方向的离轴 EIRP 密度（引擎 ciAsi.uplinkCAsi 的 explicit 口径）
  num('offAxisEirpDensityDbWPerHz', '上行离轴 EIRP 密度', 'dBW/Hz', 176, { tip: '邻网发端站朝本星方向的离轴 EIRP 密度', blankTip: '留空 = 上行不计这一源' }),
  // 上行 C/ASI 比的是干扰载波的上行极化；留空由引擎按下行的同/反极化关系推定（ciAsi.resolveUplinkPolarization）
  pol('upPolarization', 84, { label: '上行极化', tip: '留空 = 按下行的同/反极化关系推定', blankTip: '留空 = 按下行的同/反极化关系推定' }),
  num('xpdDb', 'XPD', 'dB', 80, { tip: '留空 = 25', blankTip: '留空 = 25' }),
  num('overlapFactor', '重叠', '', 72, { tip: '留空 = 1', blankTip: '留空 = 1' })
]
export const PT_COLS = [
  txt('name', '名称', 180),
  num('lon', '经度', '°E', 108),
  num('lat', '纬度', '°N', 108)
]
// NGSO 干扰星座：轨道五列只对 Walker 行开放（星历行的根数由星历给出，格里显示的是星历实参速览，只读）；
// 「名称 / 星座」一列对 Walker 行是自由文本名称，对星历行是星座选择——那是带分组的动态下拉，不进网格，
// 由表下方的「当前行」选择框改（见 CiApp）。
const ORBIT = { orbit: true }
export const NG_COLS = [
  bool('enabled', '启用', 54),
  { key: 'source', label: '来源', w: 80, options: [{ value: '星历' }, { value: 'Walker' }], get: (o) => (o.source === 'walker' ? 'Walker' : '星历'), parse: parseSrc },
  txt('name', '名称 / 星座', 200),
  num('altKm', '高度', 'km', 84, ORBIT),
  num('incl', '倾角', '°', 76, ORBIT),
  num('planes', '轨道面数', '', 76, ORBIT),
  num('perPlane', '每面星数', '', 76, ORBIT),
  num('phase', '相位因子 F', '', 84, ORBIT),
  num('eirpDensityDbWPerHz', 'EIRP 密度', 'dBW/Hz', 132),
  pol('polarization', 66),
  bool('selfSystem', '自系统', 66, { tip: '同星座内的其他星（服务星自身不计为干扰）' })
]

// 列头悬停：口径说明 / 「留空 = 缺省」（原先是格里的 placeholder；空格悬停另有 blankTip）。整串写成字面量，词典才对得上
export const headTip = (c) => c.tip || c.label

// TSV / CSV 块：制表符 > 逗号 > 整行一格（同 MODCOD 表口径）
const splitCells = (t) => (t.includes('\t') ? t.split('\t') : (t.includes(',') ? t.split(',') : [t])).map((x) => x.trim())
const splitLines = (t) => String(t || '').split(/\r?\n/).filter((l) => l.trim() !== '')

/**
 * 一张输入网格。
 *   list()      当前行对象数组（可以是派生数组，如「已启用的干扰星」）
 *   base()      撤销快照的对象数组（list 为派生时给源数组；缺省 = list）
 *   cols        列定义（上面几份之一）
 *   text?       (o, col) => 显示串，缺省 col.get(o)
 *   editable?   (o, col) => boolean 逐格可编辑性
 *   add?        (at?) => 新行对象；给了才有表尾追加、插入行与「粘贴越过表尾自动续行」
 *   remove?     (id) => void；给了才有删除行
 */
export function useCiGrid({ gridId, list, base, cols, text, editable, add, remove }) {
  const rowsC = computed(() => (list() || []).map((o) => ({ id: o._id, o })))
  const textOf = (r, c) => (text ? text(r.o, c) : c.get(r.o))
  const canEdit = (o, c) => !!o && !!c && c.editable !== false && (!editable || editable(o, c) !== false)
  const findO = (id) => (list() || []).find((o) => o._id === id)
  function write(o, c, v) {
    if (!canEdit(o, c)) return false
    const val = c.parse(v)
    if (val === undefined) return false
    o[c.key] = val
    return true
  }
  // 撤销：整份行数组的 JSON 快照（几行到几十行，够小）。恢复时按位换回，_id 不变，网格选区仍指得到
  const undoStack = [], redoStack = []
  const baseArr = () => (base ? base() : list())
  const snap = () => JSON.stringify(baseArr())
  const restore = (s) => { const arr = baseArr(); arr.splice(0, arr.length, ...JSON.parse(s)) }
  function pushUndo() { undoStack.push(snap()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0 }
  function dropUndo() { undoStack.pop() }
  function undo() { if (!undoStack.length) return false; redoStack.push(snap()); restore(undoStack.pop()); return true }
  function redo() { if (!redoStack.length) return false; undoStack.push(snap()); restore(redoStack.pop()); return true }
  // 换了一份配置时清栈（窗口的 applyState 调）：栈里是上一份的整张表，留着的话一按 Ctrl+Z / Ctrl+Y
  // 就把上一份的行整张换进当前配置、约 1 s 后自动写盘（网格不随配置重建，栈不会自己清）
  function clearHistory() { undoStack.length = 0; redoStack.length = 0 }

  let g = null
  const visCols = () => (g && g.visCols ? g.visCols.value : cols)
  function pasteBlock(anchorId, startKey, block) {
    const grid = splitLines(block).map(splitCells)
    if (!grid.length) return 0
    const vc = visCols()
    const c0 = Math.max(0, vc.findIndex((c) => c.key === startKey))
    let idx = anchorId ? list().findIndex((o) => o._id === anchorId) : list().length
    if (idx < 0) idx = list().length
    let n = 0
    for (const cells of grid) {
      let o = list()[idx]
      if (!o) { if (!add) break; o = add() }
      if (!o) break
      cells.forEach((v, i) => { const c = vc[c0 + i]; if (c) write(o, c, v) })
      idx++; n++
    }
    return n
  }

  g = useGridSelect({
    gridId,
    rows: () => rowsC.value,
    cols: () => cols,
    cellText: textOf,
    // 编辑框里的原文 = 屏上那串（枚举列尤其要紧：填充柄把它原样送回 onEdit，再由 parse 折回存储值）
    cellRaw: textOf,
    cellEditable: (r, c) => canEdit(r.o, c),
    onEdit: (id, key, v) => { const o = findO(id), c = cols.find((x) => x.key === key); if (o && c) write(o, c, v) },
    onClear: (cells) => cells.forEach(({ rowId, key }) => {
      const o = findO(rowId), c = cols.find((x) => x.key === key)
      if (o && c && c.blank !== undefined && canEdit(o, c)) o[c.key] = c.blank
    }),
    onPasteBlock: pasteBlock,
    onPasteAppend: add ? (block) => pasteBlock(null, cols[0].key, block) : undefined,
    onInsertRows: add ? (at, count) => { let n = 0; for (let k = 0; k < count; k++) if (add(at + k)) n++; return n } : undefined,
    onDeleteRows: remove ? (ids) => { let n = 0; for (const id of ids) if (findO(id)) { remove(id); n++ } return n } : undefined,
    pushUndo, dropUndo, undo, redo
  })
  // 表尾「＋」追加一行并把活动格落到新行首格
  function append() {
    if (!add) return
    pushUndo()
    const o = add()
    if (!o) { dropUndo(); return }
    const ri = rowsC.value.findIndex((r) => r.id === o._id)
    if (ri >= 0) g.sel.value = { ar: ri, ac: 0, ri, ci: 0 }
  }
  // 当前行 = 活动格所在行的行对象（没有活动格时 null）
  const activeRow = computed(() => { const ri = g.sel.value.ri; const r = ri >= 0 ? g.rows.value[ri] : null; return r ? r.o : null })
  return { g, append, activeRow, textOf, clearHistory }
}
