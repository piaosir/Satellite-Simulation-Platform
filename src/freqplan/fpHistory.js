// 频率计划的整份快照撤销栈（调研 A4）。
//
// 口径照 viz/markers/useMarkerTable.js 的快照栈：整份全量快照、上限 100 步、撤销 / 重做两栈、新改动清空重做栈。
// 不同处只有一点 —— 不靠调用方逐处 pushUndo：计划的改动散在图 / 转发器表 / 检查器 / 批量条 / 分配表几十处
// （载波数组更是每次整份换新），逐处压栈迟早漏一处。故挂在与存盘同一个深监听上：
//   · 改动来了只记「待落步」（touch），平息 delayMs 后把「改动前那一份」压栈 —— 一次拖拽的几十帧、
//     连着敲的几个字都合成一步；
//   · 指针按住期间（拖载波 / 拖行选 / 拖栏宽）不落步，松手再算（hold）；
//   · 撤销 / 重做前先把挂着的待落步落掉，撤的就是最近那一笔；
//   · 快照比的是序列化串：改了又改回去不算一步，撤销后深监听再响一次也不会多出一步。
// 模块不碰 DOM、计时器可注入 —— node 里直接能跑。
import { ref } from 'vue'

export const HISTORY_MAX = 100
export const HISTORY_DELAY_MS = 700

/**
 * @param {object} o
 * @param {() => string|null} o.snapshot  当前计划的序列化串；没打开计划时回 null
 * @param {(s: string) => void} o.apply   把一份快照装回编辑区（撤销 / 重做）
 * @param {number} [o.delayMs]
 * @param {number} [o.max]
 * @param {{ set: Function, clear: Function }} [o.timers]
 */
export function createPlanHistory(o) {
  const { snapshot, apply } = o
  const delayMs = o.delayMs == null ? HISTORY_DELAY_MS : o.delayMs
  const max = o.max || HISTORY_MAX
  const T = o.timers || { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) }
  const undoStack = [], redoStack = []
  const canUndo = ref(false), canRedo = ref(false)
  let base = null          // 最近一次落定的那一份（null = 没挂着计划）
  let timer = null
  let pending = false      // 有改动还没落步
  let holding = false      // 指针按住中

  const flags = () => { canUndo.value = undoStack.length > 0; canRedo.value = redoStack.length > 0 }
  const stop = () => { if (timer != null) { T.clear(timer); timer = null } }
  function arm() { stop(); timer = T.set(() => { timer = null; if (!holding) commit() }, delayMs) }

  /** 换了一份计划（打开 / 新建 / 复制）：清栈，以当前内容为基线 */
  function reset() { stop(); pending = false; undoStack.length = 0; redoStack.length = 0; base = snapshot(); flags() }
  /** 不再挂着任何计划（当前那份被删） */
  function clear() { stop(); pending = false; undoStack.length = 0; redoStack.length = 0; base = null; flags() }

  /** 把挂着的改动落成一步；返回是否真落了一步 */
  function commit() {
    stop(); pending = false
    if (base == null) return false
    const cur = snapshot()
    if (cur == null || cur === base) return false
    undoStack.push(base)
    if (undoStack.length > max) undoStack.shift()
    redoStack.length = 0
    base = cur
    flags()
    return true
  }
  /** 计划或载波变了（深监听里调） */
  function touch() {
    if (base == null) return
    pending = true
    if (!holding) arm()
  }
  /** 指针按下 / 松开：按住期间的改动等松手再落步 */
  function hold(on) {
    holding = !!on
    if (holding) stop()
    else if (pending) arm()
  }
  function undo() {
    commit()
    if (!undoStack.length) return false
    redoStack.push(base)
    base = undoStack.pop()
    apply(base)
    flags()
    return true
  }
  function redo() {
    commit()   // 有没落步的新改动 → 它先成一步并清空重做栈（与「改了之后不能再重做」同口径）
    if (!redoStack.length) return false
    undoStack.push(base)
    base = redoStack.pop()
    apply(base)
    flags()
    return true
  }
  /**
   * 外部改了计划、又不该进撤销栈（别的窗口改名）：栈里每一份与基线一起跟着改，免得撤销把它改回去。
   * fn 收解析后的快照对象、回改好的对象。
   */
  function rebase(fn) {
    const map = (s) => { try { return JSON.stringify(fn(JSON.parse(s))) } catch (e) { return s } }
    for (let i = 0; i < undoStack.length; i++) undoStack[i] = map(undoStack[i])
    for (let i = 0; i < redoStack.length; i++) redoStack[i] = map(redoStack[i])
    if (base != null) base = map(base)
  }
  const sizes = () => ({ undo: undoStack.length, redo: redoStack.length })

  return { canUndo, canRedo, reset, clear, commit, touch, hold, undo, redo, rebase, sizes }
}
