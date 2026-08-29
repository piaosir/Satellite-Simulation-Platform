// 勾选列表的多选交互（一份共用口径，三处在用）
//
//   ① 对地 / 对星覆盖分析侧栏的「Beams To Plot」（components/GrdSetSections.vue，两视图同一份 UI）
//   ② 对地性能指标表的「波束筛选」（pages/ConstellationMap3D.vue）
//   ③ 对星性能指标表的「波束筛选」（components/SatCovWindows.vue）
//
// 与 SatList.vue 的区别：那里的「选中」是转瞬即逝的一次挑选（挑完交给操作条），这里的勾选【本身就是
// 一份状态】（勾了就画），故不做 Excel 的「点一下只剩它一个」，而是资源管理器勾选列那套：
//   点一行     = 只翻这一行（并把「翻成什么」记成本次刷选的目标状态）
//   按住拖     = 把该目标状态刷到经过的每一行 —— 长按多选；拖出上/下沿自动滚动，可一路刷到表尾
//   Shift 点   = 把该目标状态刷到锚点与本行之间一整段
//   Space      = 翻当前行 · ↑↓/Home/End 移动当前行（配 Shift 即扩刷）· Ctrl+A 勾上当前筛选结果
//
// ★ 刷选期间只动【暂态】pending，松手才 commit 一次。这三处的每一次落库都要整轮重算覆盖场 / 重建表
//   （94 波束下那是主要开销），逐行落库会把一次拖刷变成几十轮重绘。
// ★ 行号一律按【指针坐标】算，不靠逐行 mouseenter：拖出列表之后鼠标已不在任何行上，而那正是需要
//   自动滚动的时刻。行高不齐（相邻行多一道 1px 分隔线），故按下时把每行 offsetTop 量一次再二分查。
// ★ 每次 mousemove 都查 e.buttons：只靠 window 的 mouseup 收尾，一旦那次 mouseup 没送达（窗口外松手、
//   被别处 stopPropagation 掉），刷选就永久卡住 —— 此后光鼠标划过就把勾选刷成一片。
import { ref, shallowRef, computed, onBeforeUnmount } from 'vue'

const EDGE = 16          // 距上/下沿多少像素起自动滚动
const AUTO_MS = 16
const AUTO_MAX = 20      // 自动滚动封顶 px/帧

/**
 * @param {object} cfg
 *   rows()            → 当前【筛选视图】的行数组（顺序即屏幕顺序）
 *   idOf(row)         → 行的稳定标识（勾选集里存的就是它）
 *   isOn(id)          → 真值：该行此刻勾没勾（不读暂态，暂态由本模块自己叠）
 *   current()         → 真值：当前勾选集（数组，用于起一份可改的副本 / 报个数）
 *   commit(ids)       → 落库：把整份勾选集写回去（一次拖刷只调一次）
 *   el()              → 列表滚动容器
 *   rowSelector       → 行元素选择器，缺省 '.bitem'
 *   headSelector      → 置顶「(全选)」行的选择器，缺省 '.ball'（滚动定位时给它让位）
 *   beforeDown()      → 可选：按下前的钩子（如把正在改名的那一行先落库）
 */
export function useCheckList(cfg) {
  const rowsOf = () => cfg.rows() || []
  const idOf = cfg.idOf || ((r) => r.id)
  const elOf = () => (cfg.el && cfg.el()) || null
  const ROWSEL = cfg.rowSelector || '.bitem'
  const HEADSEL = cfg.headSelector || '.ball'

  const pending = shallowRef(null)   // 刷选暂态：Set(id)；null = 没在刷，一切读真值
  const anchor = ref(-1)             // 连选锚点（筛选视图下标）
  const cur = ref(-1)                // 当前行（键盘焦点 / 刷选落点）
  let paintOn = true                 // 本次刷选要刷成的状态
  let dragging = false, lastIdx = -1, tops = null, ptrY = 0, timer = null, vel = 0

  const isOn = (id) => (pending.value ? pending.value.has(id) : cfg.isOn(id))
  const onCount = computed(() => (pending.value ? pending.value.size : (cfg.current() || []).length))
  const allOn = () => { const r = rowsOf(); return r.length > 0 && r.every((x) => isOn(idOf(x))) }
  const anyOn = () => rowsOf().some((x) => isOn(idOf(x)))
  const painting = computed(() => !!pending.value)

  function focusList() { const el = elOf(); if (el) el.focus({ preventScroll: true }) }

  // 把 paintOn 刷到筛选视图下标 [lo,hi] 这一段上。刷选中写暂态，否则直接落库。
  function paint(lo, hi) {
    const r = rowsOf()
    const a = Math.max(0, Math.min(lo, hi)), z = Math.min(r.length - 1, Math.max(lo, hi))
    if (z < a) return
    const set = new Set(pending.value ? pending.value : (cfg.current() || []))
    for (let k = a; k <= z; k++) { const it = r[k]; if (!it) continue; paintOn ? set.add(idOf(it)) : set.delete(idOf(it)) }
    if (pending.value) pending.value = set     // 换引用触发重渲染（Set 就地改动不惊动模板）
    else cfg.commit([...set])
  }

  /* ——— 鼠标 ——— */
  function stopAuto() { if (timer) { clearInterval(timer); timer = null } vel = 0 }
  function idxAt(clientY) {
    const el = elOf()
    if (!el || !tops || !tops.length) return -1
    const y = clientY - el.getBoundingClientRect().top + el.scrollTop
    if (y <= tops[0]) return 0
    let lo = 0, hi = tops.length - 1
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tops[m] <= y) lo = m; else hi = m - 1 }
    return lo
  }
  function extend() {
    const i = idxAt(ptrY)
    if (i < 0 || i === lastIdx) return
    const prev = lastIdx
    lastIdx = i; cur.value = i
    paint(prev < 0 ? i : prev, i)      // 跨过的行一个不漏：快拖 / 自动滚动会一次跳好几行
  }
  function onMove(e) {
    if (!dragging) return
    if (!(e.buttons & 1)) { endDrag(); return }
    ptrY = e.clientY
    extend()
    const el = elOf(); if (!el) return
    const r = el.getBoundingClientRect()
    const up = (r.top + EDGE) - e.clientY, dn = e.clientY - (r.bottom - EDGE)
    vel = up > 0 ? -Math.min(AUTO_MAX, 2 + up * 0.4) : (dn > 0 ? Math.min(AUTO_MAX, 2 + dn * 0.4) : 0)
    if (vel && !timer) timer = setInterval(autoTick, AUTO_MS)
    else if (!vel) stopAuto()
  }
  function autoTick() {
    const el = elOf()
    if (!el || !dragging || !vel) { stopAuto(); return }
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const next = Math.max(0, Math.min(max, el.scrollTop + vel))
    if (next === el.scrollTop) return   // 已到头：停在边界但不撤计时器（用户可能又往回拖）
    el.scrollTop = next
    extend()
  }
  function flush() {
    const p = pending.value
    pending.value = null; tops = null
    if (p) cfg.commit([...p])
  }
  function endDrag() {
    if (!dragging) return
    dragging = false; stopAuto()
    window.removeEventListener('mousemove', onMove)
    flush()
  }
  /** 行上按下：翻这一行（Shift＝刷一整段），并进入刷选 */
  function onRowDown(e, idx) {
    if (e.button !== 0) return
    const it = rowsOf()[idx]; if (!it) return
    e.preventDefault()                       // 不让「在行上按住拖」变成拖选文字
    if (cfg.beforeDown) cfg.beforeDown()
    cur.value = idx
    pending.value = new Set(cfg.current() || [])
    if (e.shiftKey && anchor.value >= 0) paint(anchor.value, idx)     // 连选照上一次点选定下的状态刷
    else { paintOn = !isOn(idOf(it)); anchor.value = idx; paint(idx, idx) }
    dragging = true; lastIdx = idx; ptrY = e.clientY
    const el = elOf()
    tops = el ? [...el.querySelectorAll(ROWSEL)].map((x) => x.offsetTop) : null
    window.addEventListener('mousemove', onMove)
    focusList()
  }
  /** 「(全选)」行按下：作用于当前筛选结果（无搜索词即全表），一次落库 */
  function onHeadDown(e) {
    if (e.button !== 0) return
    e.preventDefault()
    if (cfg.beforeDown) cfg.beforeDown()
    paintOn = !allOn(); anchor.value = -1
    paint(0, rowsOf().length - 1)
    focusList()
  }

  /* ——— 键盘 ——— */
  function ensureVisible(i) {
    const el = elOf(); if (!el) return
    const row = el.querySelectorAll(ROWSEL)[i]; if (!row) return
    const head = el.querySelector(HEADSEL)
    const hh = head ? head.offsetHeight : 0        // 「(全选)」行是 sticky，别把目标行滚到它底下
    if (row.offsetTop - hh < el.scrollTop) el.scrollTop = Math.max(0, row.offsetTop - hh)
    else if (row.offsetTop + row.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = row.offsetTop + row.offsetHeight - el.clientHeight
  }
  function onKey(e) {
    const n = rowsOf().length
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); paintOn = true; paint(0, n - 1); return }
    if (!n) return
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault()
      const i = cur.value < 0 ? 0 : cur.value, it = rowsOf()[i]
      if (it) { paintOn = !isOn(idOf(it)); anchor.value = i; cur.value = i; paint(i, i) }
      return
    }
    let i = cur.value
    if (e.key === 'ArrowDown') i = i < 0 ? 0 : Math.min(n - 1, i + 1)
    else if (e.key === 'ArrowUp') i = i < 0 ? 0 : Math.max(0, i - 1)
    else if (e.key === 'Home') i = 0
    else if (e.key === 'End') i = n - 1
    else return
    e.preventDefault()
    cur.value = i
    if (e.shiftKey && anchor.value >= 0) paint(anchor.value, i); else anchor.value = i
    ensureVisible(i)
  }

  /** 换数据源（切天线 / 切表）：丢掉暂态与锚点，别让上一份的刷选落到新的一份头上 */
  function reset() {
    dragging = false; stopAuto()
    window.removeEventListener('mousemove', onMove)
    pending.value = null; tops = null; lastIdx = -1
    anchor.value = -1; cur.value = -1
  }

  // 捕获相：内层若把 mouseup stopPropagation 掉了，冒泡相的收尾就永远等不到（暂态卡住不落库）
  window.addEventListener('mouseup', endDrag, true)
  onBeforeUnmount(() => {
    window.removeEventListener('mouseup', endDrag, true)
    window.removeEventListener('mousemove', onMove)
    stopAuto()
  })

  return { isOn, onCount, allOn, anyOn, painting, cur, anchor, onRowDown, onHeadDown, onKey, ensureVisible, reset }
}
