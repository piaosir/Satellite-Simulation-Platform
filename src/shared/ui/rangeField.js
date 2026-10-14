// 滑杆 = Blender / Unreal 式融合数值条：条内已走过的部分染色，紧随其后的数值读数叠进条内右端，读数本身即输入框。
// 画法在 styles/controls.css「滑块」与「滑杆配数值框」两节；本文件管三件 CSS 做不到的事：
//   ① 已走过的填充：把归一化值写成滑杆上的 --p。拖动走 input 事件；Vue 的 :value / v-model 改的是 value 属性、
//      不派发事件 —— 故包一层 HTMLInputElement.prototype 的 value / valueAsNumber / min / max setter（只认 range）。
//   ② 读数叠进条内：负 margin =（读数实宽 + 与条的实际间距），按现场量出来写在读数的行内样式上。
//      时机：Vue 挂载时的 value 写入 → 微任务里接上 ResizeObserver（RO 回调在布局后、绘制前，不闪）；
//      兜底：滑杆插入 / 重新显示时 CSS 给的 1ms animationstart。读数宽度变了 RO 再量一次。
//   ③ 读数即输入框（下述）。
//
// 读数怎么认：
//   · 自动：滑杆紧随其后的 <span> / <b> / <output>，里面有字、不含任何控件或图标 —— 全库 .srow 的「滑杆 + .u」、
//     视频导出的 .rv、雨衰 / PFD / 3D 模型窗的各式读数都是这个形状，模板一处不用改。
//   · 显式：读数不紧挨滑杆时（中间隔着按钮、或在别的格子里）给读数打 data-rnum，向上三层内找滑杆配对。
// 读数 ↔ 滑杆值的换算在开编辑时现场推（rangeFieldCore.inferScale）；推不出线性倍率的（对数刻度、时刻）
// 由组件在滑杆上挂 :rnumMap.prop="{ fromNum(n) → 值 }" 或 "{ fromText(文本) → 值 }"。
//
// 交互：
//   · 单击读数 → 原地变成输入框、全选；Enter 提交并把焦点还给滑杆，Esc 撤回，失焦即提交。
//   · 按住读数横拖 = 连续拖动数值，约 240px 走完全程（与参数行标签的数值拖拽同口径：Shift 快 10 倍、Alt 慢 4 倍、Esc 撤回）。
//   · 滑杆有焦点时直接打数字（或 Enter / F2）→ 打开它的输入框，键入的那一位已经填进去。
//   · 微调一档 = 约全程 1% 的整齐数（rangeFieldCore.nudgeOf），并吸附到它的整数倍：滑杆有焦点时的方向键、
//     编辑中的 ↑ / ↓ 与滚轮（Shift ×10）、PageUp / PageDown 十档。整数台阶的量（根数、序号、时刻、像素）仍一按一个台阶。
//   · 支持算式（「0.5*3」「(12+4)/2」）、全角数字、「50%」与带单位照抄（「1.5×」）。
//   · 越界夹到滑杆两端，读数闪一下示意；键入值不吸附到台阶（整数台阶的量按整数收）。
//
// 数据路径与拖滑杆完全相同：写 range.value，派发 input + change —— v-model / :value + @input / @change
// 各种写法一视同仁，不碰 Vue 的回写（见「输入框跳变陷阱」）。要收下台阶以外的值，
// 派发期间临时把 step 置为 any（否则浏览器会把 value 吸到台阶上），事件同步读完再还原。

import { normTyped, parseReadout, inferScale, decimalsOf, settle, parseTyped, fmtDisplay, nudgeOf, nudgeTo, scrubRate, snapStep } from './rangeFieldCore.js'

const RANGE = 'input[type="range"]'
const BLOCK = 'svg, input, button, select, textarea'
const TAGS = new Set(['SPAN', 'B', 'OUTPUT'])
const UP = 3
const SCRUB_PX = 3

function isAutoReadout(el) {
  return !!el && TAGS.has(el.tagName) && !el.classList.contains('rnum-ed') && el.textContent.trim() !== '' && !el.querySelector(BLOCK)
}

export function rangeOfReadout(el) {
  if (!el || el.nodeType !== 1) return null
  if (el.hasAttribute('data-rnum')) {
    let p = el.parentElement
    for (let i = 0; p && i < UP; i++, p = p.parentElement) {
      const r = p.querySelector(RANGE)
      if (r) return r
    }
    return null
  }
  const prev = el.previousElementSibling
  return prev && prev.matches(RANGE) && isAutoReadout(el) ? prev : null
}

export function readoutOfRange(range) {
  const n = range.nextElementSibling
  if (isAutoReadout(n)) return n
  let p = range.parentElement
  for (let i = 0; p && i < UP; i++, p = p.parentElement) {
    for (const r of p.querySelectorAll('[data-rnum]')) if (rangeOfReadout(r) === range) return r
  }
  return null
}

// —— ① 已走过的填充 ——
function syncFill(r) {
  const min = r.min !== '' && Number.isFinite(Number(r.min)) ? Number(r.min) : 0
  const max = r.max !== '' && Number.isFinite(Number(r.max)) ? Number(r.max) : 100
  const p = max > min ? (Number(r.value) - min) / (max - min) : 0
  const s = (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0).toFixed(4)
  if (r.__rnumP !== s) { r.__rnumP = s; r.style.setProperty('--p', s) }
  syncCover(r)
}
// 刻线进了叠放读数的框：刻线藏起来（data-rnum-under），填充边界照样标出当前值 —— 否则「0.90」读成「0|90」。
// 条宽 / 读数宽由 place() 量好缓存在元素上，拖动时这里只做算术、不读布局。
function syncCover(r) {
  const W = r.__rnumW, cover = r.__rnumCover
  const x = W > 2 ? 1 + Number(r.__rnumP || 0) * (W - 2) : 0
  const under = cover > 0 && x >= W - cover - 1
  if (under !== !!r.__rnumUnder) { r.__rnumUnder = under; r.toggleAttribute('data-rnum-under', under) }
}

// —— ② 读数叠进条内 ——
let ro$ = null
function place(ro) {
  if (!ro) return
  const r = ro.previousElementSibling
  if (!r || r.tagName !== 'INPUT' || r.type !== 'range' || !isAutoReadout(ro)) return
  if (!ro.isConnected || ro.offsetParent == null || ro.offsetParent !== r.offsetParent) return
  const m = parseFloat(getComputedStyle(ro).marginLeft) || 0
  const gap = ro.offsetLeft - m - (r.offsetLeft + r.offsetWidth)
  const sameLine = Math.abs((ro.offsetTop + ro.offsetHeight / 2) - (r.offsetTop + r.offsetHeight / 2)) <= 4
  const want = sameLine && gap > -2 && gap < 48 ? -(ro.offsetWidth + gap) : 0
  if (Math.abs(want - m) > 0.5) ro.style.marginLeft = want ? want + 'px' : ''
  r.__rnumW = r.offsetWidth
  r.__rnumCover = want ? ro.offsetWidth : 0
  syncCover(r)
}
function track(r) {
  if (!r.isConnected) return
  syncFill(r)
  const ro = r.nextElementSibling
  if (!isAutoReadout(ro)) return
  // 读数与条都要盯：条变宽（侧栏拖宽）时读数不变，但刻线进不进读数框跟着变
  if (!ro$) ro$ = new ResizeObserver((es) => { for (const e of es) place(e.target.tagName === 'INPUT' ? e.target.nextElementSibling : e.target) })
  if (ro.__rnumObs) { place(ro); return }
  ro.__rnumObs = true
  ro$.observe(ro)
  ro$.observe(r)
}
function onRangeSet(r) {
  syncFill(r)
  if (!r.__rnumT) { r.__rnumT = true; queueMicrotask(() => track(r)) }
}
function hookProto(win) {
  const P = win.HTMLInputElement && win.HTMLInputElement.prototype
  if (!P || P.__rnumHooked) return
  P.__rnumHooked = true
  for (const k of ['value', 'valueAsNumber', 'min', 'max']) {
    const d = Object.getOwnPropertyDescriptor(P, k)
    if (!d || !d.set) continue
    Object.defineProperty(P, k, {
      ...d,
      set(v) { d.set.call(this, v); if (this.type === 'range') onRangeSet(this) }
    })
  }
}

function hitReadout(t) {
  for (let el = t, i = 0; el && el.nodeType === 1 && i < 3; el = el.parentElement, i++) {
    const r = rangeOfReadout(el)
    if (r) return { ro: el, range: r }
  }
  return null
}

function bounds(range) {
  const s = range.getAttribute('step')
  const step = s === 'any' ? 0 : (Number(s) > 0 ? Number(s) : 1)
  const min = range.min !== '' && Number.isFinite(Number(range.min)) ? Number(range.min) : 0
  const max = range.max !== '' && Number.isFinite(Number(range.max)) ? Number(range.max) : 100
  return { step, min, max }
}

// 微调一档：小数台阶的量按约全程 1% 的整齐档走；整数台阶（根数、序号、像素）与自定义换算（对数刻度、时刻）仍按台阶
function nudgeStep(range, b) {
  if (b.step >= 1 || (range.rnumMap && typeof range.rnumMap === 'object')) return { n: b.step > 0 ? b.step : (b.max - b.min) / 100, grid: false }
  return { n: nudgeOf(b.min, b.max, b.step), grid: true }
}
function nudgedValue(range, b, base, dir, mult) {
  const { n, grid } = nudgeStep(range, b)
  if (grid) return nudgeTo(base, dir, n * mult, b.min, b.max)
  return Math.min(b.max, Math.max(b.min, Number((base + dir * n * mult).toPrecision(12))))
}

function writeRange(range, x, exact) {
  const prev = range.getAttribute('step')
  const off = exact && prev !== 'any'
  if (off) range.setAttribute('step', 'any')
  range.value = String(x)
  range.dispatchEvent(new Event('input', { bubbles: true }))
  range.dispatchEvent(new Event('change', { bubbles: true }))
  if (off) { if (prev == null) range.removeAttribute('step'); else range.setAttribute('step', prev) }
}

function flash(ro) {
  ro.removeAttribute('data-rnum-flash')
  void ro.offsetWidth
  ro.setAttribute('data-rnum-flash', '')
  clearTimeout(ro.__rnumFlashT)
  ro.__rnumFlashT = setTimeout(() => ro.removeAttribute('data-rnum-flash'), 700)
}

// 开编辑那一刻的口径快照
function probe(range, ro) {
  const map = range.rnumMap && typeof range.rnumMap === 'object' ? range.rnumMap : null
  const { step, min, max } = bounds(range)
  const v = Number(range.value)
  const rd = parseReadout(ro.textContent)
  if (map && typeof map.fromText === 'function') {
    return { map, k: null, step, min, max, suf: '', text: ro.textContent.replace(/\s+/g, ' ').trim(), v0: v, dec: 0 }
  }
  if (map && typeof map.fromNum === 'function') {
    return { map, k: null, step, min, max, suf: rd ? rd.suf : '', text: rd ? rd.numText : '', v0: v, dec: rd ? rd.dec : 0 }
  }
  const k = inferScale(v, rd, step, max)
  if (k == null) {
    const dec = decimalsOf(step || 0.001)
    return { map: null, k: 1, step, min, max, suf: '', text: fmtDisplay(v, dec), v0: v, dec }
  }
  // 撤回的基准取读数（它是模型里的值）；滑杆 DOM 可能已被吸到台阶上
  return { map: null, k, step, min, max, suf: rd.suf, text: rd.numText, v0: rd.num / k, dec: Math.max(rd.dec, decimalsOf(step * k)) }
}

function toValue(info, text) {
  if (info.map && info.map.fromText) {
    const v = Number(info.map.fromText(normTyped(text)))
    return Number.isFinite(v) ? v : NaN
  }
  const n = parseTyped(text, info.suf)
  if (!Number.isFinite(n)) return NaN
  if (info.map) {
    const v = Number(info.map.fromNum(n))
    return Number.isFinite(v) ? v : NaN
  }
  return n / info.k
}

let cur = null   // 当前打开的编辑框（全窗口至多一个）

function closeEditor(focusRange) {
  const c = cur
  if (!c) return
  cur = null
  c.box.remove()
  c.ro.removeAttribute('data-rnum-on')
  if (focusRange && c.range.isConnected) c.range.focus({ preventScroll: true })
}

// 提交键入：成功 → true；无法解析 → false（编辑框留着）
function commit(c) {
  const text = c.inp.value
  if (text.trim() === c.shown.trim()) return true
  const x = toValue(c.info, text)
  if (!Number.isFinite(x)) return false
  const r = settle(x, c.info.min, c.info.max, c.info.step)
  if (!r) return false
  writeRange(c.range, r.v, true)
  if (r.clamped) flash(c.ro)
  return true
}

function refreshText(c, x) {
  const { info } = c
  if (!info.map) {
    c.inp.value = c.shown = fmtDisplay(x * info.k, info.dec)
    c.inp.select()
    return
  }
  // 自定义换算：读数由组件格式化，等 Vue 刷完那一拍再读
  queueMicrotask(() => {
    if (cur !== c) return
    const t = info.map.fromText ? c.ro.textContent.replace(/\s+/g, ' ').trim() : (parseReadout(c.ro.textContent) || {}).numText
    if (t != null) { c.inp.value = c.shown = t; c.inp.select() }
  })
}

function nudge(c, dir, mult) {
  const base = Number(c.range.value)
  const x = nudgedValue(c.range, c.info, base, dir, mult)
  if (x === base) { flash(c.box); return }
  writeRange(c.range, x, false)
  c.nudged = true
  refreshText(c, Number(c.range.value))
}

// 另一个读数上按下 / 开编辑时，先把手上这个提交掉（按下被 preventDefault 时焦点不一定挪走，等不来 blur）
function settleOpen() {
  if (!cur) return
  commit(cur)
  closeEditor(false)
}

function openEditor(range, ro, seed) {
  settleOpen()
  const info = probe(range, ro)
  const doc = ro.ownerDocument
  const cs = getComputedStyle(ro)
  // 计算样式的宽（读数自己的 CSS 像素），不取 getBoundingClientRect：祖先带 CSS zoom 时后者是放大后的视觉宽
  const w = parseFloat(cs.width) || ro.offsetWidth
  const box = doc.createElement('span')
  box.className = 'rnum-ed'
  box.setAttribute('data-i18n-skip', '')
  box.style.width = Math.max(w, 30) + 'px'
  box.style.font = cs.font
  box.style.letterSpacing = cs.letterSpacing
  // 叠在条内的读数：编辑框沿用它的负 margin 与高，原位盖在条的右端
  box.style.marginLeft = cs.marginLeft
  if (parseFloat(cs.height) > 0) box.style.height = cs.height
  const inp = doc.createElement('input')
  inp.type = 'text'
  inp.spellcheck = false
  inp.autocomplete = 'off'
  inp.setAttribute('inputmode', info.map && info.map.fromText ? 'text' : 'decimal')
  inp.setAttribute('aria-label', range.getAttribute('aria-label') || range.title || '')
  inp.value = seed != null ? seed : info.text
  box.appendChild(inp)
  if (info.suf) {
    const u = doc.createElement('i')
    u.textContent = info.suf
    box.appendChild(u)
  }
  ro.setAttribute('data-rnum-on', '')
  ro.after(box)
  const c = { range, ro, box, inp, info, shown: info.text, nudged: false }
  cur = c
  inp.focus({ preventScroll: true })
  if (seed != null) inp.setSelectionRange(inp.value.length, inp.value.length)
  else inp.select()

  inp.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    e.stopPropagation()   // 别让窗口快捷键（J/K/L、Delete、数字切页…）吃掉键入
    const mult = e.shiftKey ? 10 : 1
    switch (e.key) {
      case 'Enter':
        e.preventDefault()
        if (commit(c)) closeEditor(true)
        else { box.removeAttribute('data-bad'); void box.offsetWidth; box.setAttribute('data-bad', ''); inp.select() }
        break
      case 'Escape':
        e.preventDefault()
        if (c.nudged) writeRange(range, info.v0, true)
        closeEditor(true)
        break
      case 'ArrowUp': e.preventDefault(); nudge(c, 1, mult); break
      case 'ArrowDown': e.preventDefault(); nudge(c, -1, mult); break
      case 'PageUp': e.preventDefault(); nudge(c, 1, 10); break
      case 'PageDown': e.preventDefault(); nudge(c, -1, 10); break
    }
  })
  inp.addEventListener('input', () => box.removeAttribute('data-bad'))
  inp.addEventListener('wheel', (e) => {
    if (cur !== c || e.deltaY === 0) return
    e.preventDefault()
    nudge(c, e.deltaY < 0 ? 1 : -1, e.shiftKey ? 10 : 1)
  }, { passive: false })
  inp.addEventListener('blur', () => {
    if (cur !== c) return
    commit(c)
    closeEditor(false)
  })
}

// 按住读数：横移不到 SCRUB_PX 松手 = 单击（开编辑），超过即横拖改值。
function onPointerDown(e) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey) return
  const t = e.target
  if (!t || !t.closest || t.closest('.rnum-ed')) return
  const hit = hitReadout(t)
  if (!hit || hit.range.disabled) return
  const { ro, range } = hit
  const doc = ro.ownerDocument
  const html = doc.documentElement
  e.preventDefault()
  settleOpen()
  const { step, min, max } = bounds(range)
  const rate = scrubRate(min, max, step)
  const start = Number(range.value)
  const pid = e.pointerId
  let x0 = e.clientX
  let lastX = x0
  let active = false
  let acc = 0
  let shown = start
  let raf = 0

  const flush = () => { raf = 0; if (Number(range.value) !== shown) writeRange(range, shown, false) }
  const move = (ev) => {
    if (ev.pointerId !== pid) return
    if (!active) {
      if (Math.abs(ev.clientX - x0) < SCRUB_PX) return
      active = true
      lastX = x0 = ev.clientX
      try { ro.setPointerCapture(pid) } catch { /* 指针已不在 */ }
      html.classList.add('ui-scrub')
      return
    }
    // 连续累计（值域单位），夹在两端：拖过头再往回拉立刻有反应
    acc += (ev.clientX - lastX) * rate * (ev.shiftKey ? 10 : 1) / (ev.altKey ? 4 : 1)
    lastX = ev.clientX
    acc = Math.min(max - start, Math.max(min - start, acc))
    const v = snapStep(start + acc, min, max, step)
    if (v !== shown) { shown = v; if (!raf) raf = requestAnimationFrame(flush) }
  }
  const cleanup = () => {
    doc.removeEventListener('pointermove', move, true)
    doc.removeEventListener('pointerup', up, true)
    doc.removeEventListener('pointercancel', cancel, true)
    doc.removeEventListener('keydown', esc, true)
    if (active) {
      html.classList.remove('ui-scrub')
      try { ro.releasePointerCapture(pid) } catch { /* 已释放 */ }
    }
  }
  // 吃掉紧随其后的 click：读数在 <label> 里时，click 会把焦点交给滑杆、刚开的输入框随即失焦
  const eatClick = () => {
    const kill = (ev) => {
      const tg = ev.target
      if (tg && (tg === ro || ro.contains(tg) || (tg.contains && tg.contains(ro)))) ev.preventDefault()
    }
    doc.addEventListener('click', kill, true)
    setTimeout(() => doc.removeEventListener('click', kill, true), 0)
  }
  const up = (ev) => {
    if (ev.pointerId !== pid) return
    cleanup()
    eatClick()
    if (active) { if (raf) { cancelAnimationFrame(raf); flush() } return }
    if (ro.isConnected && !range.disabled) openEditor(range, ro, null)
  }
  const cancel = (ev) => {
    if (ev.pointerId !== pid) return
    if (raf) { cancelAnimationFrame(raf); flush() }
    cleanup()
  }
  const esc = (ev) => {
    if (ev.key !== 'Escape' || !active) return
    ev.preventDefault(); ev.stopPropagation()
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    shown = start
    if (Number(range.value) !== start) writeRange(range, start, true)
    cleanup()
    eatClick()
  }
  doc.addEventListener('pointermove', move, true)
  doc.addEventListener('pointerup', up, true)
  doc.addEventListener('pointercancel', cancel, true)
  doc.addEventListener('keydown', esc, true)
}

// 滑杆有焦点时直接打数：打开它的输入框，键入的那一位先填进去
function onKeyDown(e) {
  const t = e.target
  if (!t || t.tagName !== 'INPUT' || t.type !== 'range' || t.disabled) return
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
  // 方向键：小数台阶的量按整齐档走（浏览器原生一按一个台阶，台阶细了就要按几百下）；整数台阶照原生
  const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key]
  if (dir) {
    const b = bounds(t)
    if (!nudgeStep(t, b).grid) return
    e.preventDefault()
    const base = Number(t.value)
    const x = nudgedValue(t, b, base, dir, e.shiftKey ? 10 : 1)
    if (x !== base) writeRange(t, x, false)
    return
  }
  const seed = /^[0-9.+-]$/.test(e.key) ? e.key : null
  if (seed == null && e.key !== 'Enter' && e.key !== 'F2') return
  const ro = readoutOfRange(t)
  if (!ro) return
  e.preventDefault()
  e.stopPropagation()
  openEditor(t, ro, seed)
}

export function installRangeFields(doc = document) {
  hookProto(doc.defaultView || window)
  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('keydown', onKeyDown, true)
  // 拖动 / 方向键 / 我们自己派发的 input：同步填充
  doc.addEventListener('input', (e) => { const t = e.target; if (t && t.type === 'range') syncFill(t) }, true)
  // 兜底：滑杆插入或重新显示（v-show / 折叠区展开）时 controls.css 给的 1ms 动画
  doc.addEventListener('animationstart', (e) => {
    const t = e.target
    if (e.animationName === 'rnum-seen' && t && t.type === 'range') { t.__rnumT = true; track(t) }
  }, true)
}
