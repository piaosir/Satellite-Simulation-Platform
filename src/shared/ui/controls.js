// 控件行为基线（画法在 styles/controls.css，这里只放纯 CSS 管不了的那几件）。
// 每个窗口入口在引 styles/global.css 之后引一次本模块。
// 滑杆配数值框（读数即输入框）单独成文件：rangeField.js。
//
// 滚轮误改数值：<input type=number> 只要拿到焦点，鼠标滚轮划过就会加减步长。本软件里有 256 个
// 数字框，且大多挨着可滚动的面板 —— 用户以为在滚面板，实际把口径/频率/增益改掉了，改完还不报错，
// 一路算到结果里才发现。故：滚轮落在已聚焦的数字框上时先让它失焦，滚动照旧交给面板。
// 不用 preventDefault —— 那样连面板都滚不动了。

import { installRangeFields } from './rangeField.js'
import { pairSrowLabel } from './srowLabelsCore.js'

export function installControlGuards(doc = document) {
  doc.addEventListener('wheel', (e) => {
    const el = doc.activeElement
    if (el && el.tagName === 'INPUT' && el.type === 'number' && (el === e.target || el.contains(e.target))) el.blur()
  }, { capture: true, passive: true })
}

// 数值拖拽（hot text）：参数行 .srow 的标签按住横拖，改同一行的数字框 —— After Effects / Premiere 的可拖数值、
// Resolve / Blender 的数值横拖，同一件事。
//   · 只认「.srow 的直接子级 <label> + 同一行恰好一个可编辑的 input[type=number]，且框里有值」。
//     链路预算四窗的参数框是文本框（留空 = 走默认值、自动回填、3/4 这类写法），两张 Excel 式表格不用 .srow，都不匹配。
//     空框不起拖：本平台「留空 = 默认 / 跟全局」有工程含义，一拖就成了手填值。光标提示的条件在 controls.css 里同口径。
//   · 每 SCRUB_PX 像素一个 step（框自己的 step 属性，没有按 1）；Shift ×10、Alt ×0.1；以按下时的值为基准按增量走，夹到 min / max。
//   · 数据路径与键入相同：值真的变了才写 el.value，并派发 input + change，一帧至多一次 ——
//     v-model / v-model.lazy / @change / NumBox 四种写法一视同仁（「输入框跳变陷阱」：不碰 Vue 的回写，只走事件）。
//   · Esc 撤回到按下前的值；横移不到 SCRUB_PX 就松手 = 普通点击，什么都不做。
//   · 只接左键：右键也捕获指针会让 pointerup 丢失（2026-08「画完 Polygon 输入框不能聚焦」那次）。
const SCRUB_PX = 3

function scrubInput(label) {
  const row = label.parentElement
  if (!row || !row.classList.contains('srow') || label.querySelector('input, select, textarea, button')) return null
  let hit = null
  for (const c of row.children) {
    if (c.tagName === 'INPUT' && c.type === 'number') { if (hit) return null; hit = c }
  }
  if (!hit || hit.disabled || hit.readOnly || hit.value.trim() === '') return null
  return hit
}

function decimalsOf(x) {
  const s = String(x)
  const e = s.indexOf('e-')
  if (e >= 0) return Number(s.slice(e + 2))
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

export function installNumberScrub(doc = document) {
  doc.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return
    const label = e.target && e.target.closest ? e.target.closest('label') : null
    if (!label) return
    const inp = scrubInput(label)
    if (!inp) return
    const start = Number(inp.value)
    if (!Number.isFinite(start)) return
    const step = Number(inp.step) > 0 ? Number(inp.step) : 1
    const min = inp.min !== '' && Number.isFinite(Number(inp.min)) ? Number(inp.min) : -Infinity
    const max = inp.max !== '' && Number.isFinite(Number(inp.max)) ? Number(inp.max) : Infinity
    const startText = inp.value
    const html = doc.documentElement
    const pid = e.pointerId
    let x0 = e.clientX
    let lastX = e.clientX
    let active = false
    let acc = 0                 // 相对起点累计的增量（值单位）
    let shown = start           // 框里当前的值
    let raf = 0

    const write = (text) => {
      inp.value = text
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const flush = () => { raf = 0; if (Number(inp.value) !== shown) write(String(shown)) }
    const move = (ev) => {
      if (ev.pointerId !== pid) return
      if (!active) {
        if (Math.abs(ev.clientX - x0) < SCRUB_PX) return
        active = true
        lastX = x0 = ev.clientX
        try { label.setPointerCapture(pid) } catch { /* 指针已不在 */ }
        html.classList.add('ui-scrub')
        return
      }
      const inc = step * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1)
      acc += ((ev.clientX - lastX) / SCRUB_PX) * inc
      lastX = ev.clientX
      // 夹在 [min, max] 时把累计量一并夹住：拖过头再往回拖立刻就动，不用先把多拖的那段还回去
      acc = Math.min(max, Math.max(min, start + acc)) - start
      const dec = Math.min(10, Math.max(decimalsOf(inc), Math.min(6, decimalsOf(start))))
      const v = Number(Math.min(max, Math.max(min, start + Math.round(acc / inc) * inc)).toFixed(dec))
      if (v !== shown) { shown = v; if (!raf) raf = requestAnimationFrame(flush) }
    }
    const end = (ev) => {
      if (ev && ev.pointerId !== pid) return
      doc.removeEventListener('pointermove', move, true)
      doc.removeEventListener('pointerup', end, true)
      doc.removeEventListener('pointercancel', end, true)
      doc.removeEventListener('keydown', esc, true)
      if (!active) return
      if (raf) { cancelAnimationFrame(raf); flush() }
      html.classList.remove('ui-scrub')
      try { label.releasePointerCapture(pid) } catch { /* 已释放 */ }
    }
    const esc = (ev) => {
      if (ev.key !== 'Escape' || !active) return
      ev.preventDefault(); ev.stopPropagation()
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      shown = start
      if (inp.value !== startText) write(startText)
      end()
    }
    doc.addEventListener('pointermove', move, true)
    doc.addEventListener('pointerup', end, true)
    doc.addEventListener('pointercancel', end, true)
    doc.addEventListener('keydown', esc, true)
  })
}

// 参数行标签的程序化关联（读屏念得出控件名）：.srow 的「label + 控件」兄弟结构自动配 id / for 或 aria-labelledby。
// 判定与配法在 srowLabelsCore.js（纯逻辑，有单测）。这里只管时机：启动扫一遍全文档，之后盯 DOM 增删 ——
// 新挂上的子树里找 .srow > label；挂进现有 .srow 的节点（v-if 换了控件 / 标签）就重配那一行。同一微任务内合批。
// 不改结构、不碰 Vue 管的属性（控件已有 id / aria-* 的跳过），故与模板、运行时翻译、数值横拖互不干涉。
export function installSrowLabels(doc = document) {
  if (typeof MutationObserver === 'undefined' || !doc || !doc.documentElement) return
  let seq = 0
  const nextId = (p) => { let id; do { id = p + (++seq).toString(36) } while (doc.getElementById(id)); return id }
  const pairRow = (row) => { for (const c of row.children) if (c.tagName === 'LABEL') pairSrowLabel(c, nextId) }
  const scan = (root) => {
    if (root.classList && root.classList.contains('srow')) pairRow(root)
    if (root.querySelectorAll) for (const l of root.querySelectorAll('.srow > label')) pairSrowLabel(l, nextId)
  }
  let pending = new Set()
  let queued = false
  const flush = () => {
    queued = false
    const roots = pending
    pending = new Set()
    for (const r of roots) if (r.isConnected) scan(r)
  }
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue
        const p = n.parentElement
        pending.add(p && p.classList.contains('srow') ? p : n)
      }
    }
    if (!queued && pending.size) { queued = true; queueMicrotask(flush) }
  })
  const start = () => {
    scan(doc.body || doc.documentElement)
    mo.observe(doc.documentElement, { childList: true, subtree: true })
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}

installControlGuards()
installNumberScrub()
installRangeFields()
installSrowLabels()
