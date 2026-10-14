// 主窗口「场景级」撤销 / 重做栈：侧栏 × 删掉的站 / 点 / 航迹 / Polygon / 链路 / 波束组，图上拖动改过的
// 标记位置 / Polygon 顶点 / 天线指向，都压一条 { label, undo, redo } 进来。Ctrl+Z / Ctrl+Y（或状态栏「撤销」）走它。
//
// 只存内存、上限 50 步（与表格类撤销同量级）；状态本身都在 localStorage 的几个场景键里，undo/redo 由各条目
// 自己的 apply 写回并落盘，别的窗口照常经 storage 事件同步。表格浮窗、波束合成各自的撤销栈仍归它们自己。
import { reactive } from 'vue'

const MAX = 50
const undoStack = []
const redoStack = []
export const sceneUndoState = reactive({ canUndo: false, canRedo: false, undoAt: 0, redoAt: 0, undoLabel: '', redoLabel: '' })

function sync() {
  const u = undoStack[undoStack.length - 1], r = redoStack[redoStack.length - 1]
  sceneUndoState.canUndo = !!u; sceneUndoState.canRedo = !!r
  sceneUndoState.undoAt = u ? u.at : 0; sceneUndoState.redoAt = r ? r.at : 0
  sceneUndoState.undoLabel = u ? u.label : ''; sceneUndoState.redoLabel = r ? r.label : ''
}

/** e = { label, undo(), redo() } */
export function pushSceneUndo(e) {
  if (!e || typeof e.undo !== 'function' || typeof e.redo !== 'function') return
  undoStack.push({ label: String(e.label || ''), undo: e.undo, redo: e.redo, at: performance.now() })
  if (undoStack.length > MAX) undoStack.shift()
  redoStack.length = 0
  sync()
}

export function sceneUndo() {
  const e = undoStack.pop(); if (!e) return null
  try { e.undo() } catch (x) { console.error('[撤销]', x) }
  e.at = performance.now(); redoStack.push(e); sync()
  return e
}

export function sceneRedo() {
  const e = redoStack.pop(); if (!e) return null
  try { e.redo() } catch (x) { console.error('[重做]', x) }
  e.at = performance.now(); undoStack.push(e); sync()
  return e
}

export function clearSceneUndo() { undoStack.length = 0; redoStack.length = 0; sync() }
