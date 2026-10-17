// 主窗口「场景级」撤销 / 重做栈：侧栏 × 删掉的站 / 点 / 航迹 / Polygon / 链路 / 波束组，图上拖动改过的
// 标记位置 / Polygon 顶点 / 天线指向，都压一条 { label, undo, redo } 进来。Ctrl+Z / Ctrl+Y（或状态栏「撤销」）走它。
//
// 只存内存、上限 50 步（与表格类撤销同量级）；状态本身都在 localStorage 的几个场景键里，undo/redo 由各条目
// 自己的 apply 写回并落盘，别的窗口照常经 storage 事件同步。表格浮窗、波束合成各自的撤销栈仍归它们自己。
//
// ★ 快照式条目（整份回放某个域的快照）带 dom + stale：撤销 / 重做前先核对「此刻的状态」是不是这一步记下的
//   after（撤销）/ before（重做）。对不上 = 这一步之后该域有没进栈的改动（漏包的写入口、表格浮窗、别的窗口同步来的），
//   这时回放旧快照会把那些改动一并抹掉 —— 不回放，该域的条目在两个栈里整条作废，返回 { stale: true } 由宿主报一句状态。
//   （2026-10-16 体检 #5：撤一步把之后没进栈的新建 / 编辑一起抹掉，重做也找不回）
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

/**
 * e = { label, undo(), redo(), dom?, stale?(dir) }
 *   dom：状态域（同一域的条目按快照首尾相接）；stale(dir)：dir = 'undo' | 'redo'，返回 true = 此刻的状态已接不上这一步
 */
export function pushSceneUndo(e) {
  if (!e || typeof e.undo !== 'function' || typeof e.redo !== 'function') return
  const it = { label: String(e.label || ''), undo: e.undo, redo: e.redo, at: performance.now() }
  // 核对函数另存为 check：撤 / 重做成功时返回的就是条目本身，宿主按 e.stale 判「接不上」，不能让它是个函数
  if (e.dom && typeof e.stale === 'function') { it.dom = String(e.dom); it.check = e.stale }
  undoStack.push(it)
  if (undoStack.length > MAX) undoStack.shift()
  redoStack.length = 0
  sync()
}

// 该域的条目整条作废（两个栈都清）：同域条目按快照首尾相接，顶上那条接不上，下面的回放出来同样会抹掉那次改动
function dropDom(dom) {
  for (const st of [undoStack, redoStack]) for (let i = st.length - 1; i >= 0; i--) if (st[i].dom === dom) st.splice(i, 1)
}
// 核对抛错按「接不上」处理：宁可不撤，也不拿一份对不上的快照去盖
function isStale(e, dir) {
  if (!e.dom || !e.check) return false
  try { return !!e.check(dir) } catch (x) { console.error('[撤销]', x); return true }
}

export function sceneUndo() {
  const e = undoStack[undoStack.length - 1]; if (!e) return null
  if (isStale(e, 'undo')) { dropDom(e.dom); sync(); return { stale: true, label: e.label, dom: e.dom } }
  undoStack.pop()
  try { e.undo() } catch (x) { console.error('[撤销]', x) }
  e.at = performance.now(); redoStack.push(e); sync()
  return e
}

export function sceneRedo() {
  const e = redoStack[redoStack.length - 1]; if (!e) return null
  if (isStale(e, 'redo')) { dropDom(e.dom); sync(); return { stale: true, label: e.label, dom: e.dom } }
  redoStack.pop()
  try { e.redo() } catch (x) { console.error('[重做]', x) }
  e.at = performance.now(); undoStack.push(e); sync()
  return e
}

export function clearSceneUndo() { undoStack.length = 0; redoStack.length = 0; sync() }

// ===================== 域快照撤销（主窗口：标记 / Polygon / 天线指向）=====================
// 域 = 一份可整份拍下 / 套回的状态：{ snap(), apply(s), sig?(s), cur?(ref) }
//   snap()    拍此刻的状态（深拷贝）；apply(s) 套回一份快照（推图 / 落盘由它自己做）
//   sig(s)    比较用的签名（缺省 JSON 串）：显隐这类视图态在这里剔掉，不让它左右撤销
//   cur(ref)  与条目 ref 对照的「此刻」（缺省 snap()）：天线指向按条目记的那根天线取，不是此刻聚焦的那根
// run：一次修改前后各拍一份，有变化压一条带 dom / stale 的条目。嵌套调用只跑 fn（外层那一步已包住）。
// 一段编辑（一次描绘 / 一次建链 / 连拖的取色框与滑杆）：begin 拍 before、end 比对压一步 —— 一次描绘 = 一步撤销。
//   每个域同一时刻至多一段；同域的单步修改 / 拖动 / 撤销重做前先把那段收掉（落栈），描绘还没完（alive()）的随后接着记，
//   保证同一域的条目首尾相接（stale 核对的前提）。描绘进行中顺手改的样式（begin 不带 alive）并进那次描绘。
export function createDomainUndo(domains) {
  let depth = 0, drag = null
  const sess = new Map()        // dom → { dom, label, key, alive, before }
  const timers = new Map()      // live 段静止收尾：key → 定时器
  const D = (dom) => domains[dom] || null
  const sigOf = (dom, s) => { const d = D(dom); return d.sig ? d.sig(s) : JSON.stringify(s) }
  const curOf = (dom, ref) => { const d = D(dom); return d.cur ? d.cur(ref) : d.snap() }
  function entry(dom, label, before, after) {
    const d = D(dom)
    return {
      label, dom,
      undo: () => d.apply(before), redo: () => d.apply(after),
      // 撤销要求此刻 = after，重做要求此刻 = before
      stale: (dir) => { const ref = dir === 'redo' ? before : after; return sigOf(dom, curOf(dom, ref)) !== sigOf(dom, ref) }
    }
  }
  // 有变化才压栈；返回 { pushed, label }（label 可传函数：收尾时才取，名字取改完的）
  function commit(dom, label, before, after) {
    if (sigOf(dom, before) === sigOf(dom, after)) return { pushed: false, label: '' }
    const lb = String((typeof label === 'function' ? label() : label) || '')
    pushSceneUndo(entry(dom, lb, before, after))
    return { pushed: true, label: lb }
  }
  function flushDom(dom) {
    const s = sess.get(dom)
    if (!s) return null
    sess.delete(dom)
    commit(dom, s.label, s.before, D(dom).snap())
    return s
  }
  // 收掉进行中的段（only = 只收这一个域）；返回收掉的那些（resume 续记用）
  function flushAll(only) { const out = []; for (const dom of [...sess.keys()]) { if (only && dom !== only) continue; const s = flushDom(dom); if (s) out.push(s) } return out }
  // 描绘还在进行：从此刻起接着记（新的 before）
  function resume(list) {
    for (const s of list || []) if (s && s.alive && !sess.has(s.dom) && D(s.dom) && s.alive()) sess.set(s.dom, { ...s, before: D(s.dom).snap() })
  }
  function begin(dom, label, key, alive) {
    if (depth || !D(dom)) return
    const cur = sess.get(dom)
    if (cur) {
      if (cur.key === key) return
      if (cur.alive && !alive && cur.alive()) return
      flushDom(dom)
    }
    sess.set(dom, { dom, label, key, alive: typeof alive === 'function' ? alive : null, before: D(dom).snap() })
  }
  function end(key) {
    for (const [dom, s] of sess) if (s.key === key) { flushDom(dom); return true }
    return false
  }
  function run(dom, label, fn) {
    if (depth || !D(dom)) return { r: fn(), pushed: false, label: '' }
    const s = flushDom(dom)
    const before = D(dom).snap()
    let r, c = { pushed: false, label: '' }
    depth++
    try { r = fn() } finally {
      depth--
      c = commit(dom, label, before, D(dom).snap())
      resume(s ? [s] : null)
    }
    return { r, ...c }
  }
  // 连发的同一项修改（取色框 / 滑杆）：首次拍 before，静止 ms 后（或同域别的动作到来时）收成一步
  function live(dom, label, key, fn, ms) {
    if (depth || !D(dom)) return fn()
    begin(dom, label, key)
    const r = fn()
    if (timers.has(key)) clearTimeout(timers.get(key))
    timers.set(key, setTimeout(() => { timers.delete(key); end(key) }, ms > 0 ? ms : 700))
    return r
  }
  // 拖动：按下拍、松手比对（拖动中逐帧改的是同一份数据，不逐帧压）
  function dragBegin(dom, label) {
    if (!D(dom)) return
    const s = flushDom(dom)
    drag = { dom, label, before: D(dom).snap(), s }
  }
  function dragCommit() {
    const d = drag; drag = null
    if (!d) return { pushed: false, label: '' }
    const c = commit(d.dom, d.label, d.before, D(d.dom).snap())
    resume(d.s ? [d.s] : null)
    return c
  }
  return { run, begin, end, live, flushAll, resume, dragBegin, dragCommit, pending: () => [...sess.values()].map((s) => s.key) }
}
