// 结果列的显示顺序（GSO / NGSO / 再生式三窗共用；纯逻辑，无框架依赖）。
// 顺序表＝全量 key 序（含未勾选的），按窗口 / 模式各记各的（localStorage）；勾选集仍是原来那份。
// 表里显示的列 = 顺序表 ∩ 勾选集，本行读数同序。声明表里新加的键（升级后多出来的指标）自动补到末尾，
// 撤掉的键自动剔除——存的是 key 不是下标，改声明表不会把用户排好的序打乱。

// 已知键按 order 排、其余按声明序补末尾；未知键 / 重复键剔除
export function normalizeOrder(order, defs) {
  const keys = defs.map((d) => d.key), known = new Set(keys), seen = new Set()
  const out = []
  for (const k of (Array.isArray(order) ? order : [])) if (known.has(k) && !seen.has(k)) { seen.add(k); out.push(k) }
  for (const k of keys) if (!seen.has(k)) { seen.add(k); out.push(k) }
  return out
}
export function loadOrder(storeKey, defs) {
  let raw = null
  try { raw = typeof localStorage === 'undefined' ? null : JSON.parse(localStorage.getItem(storeKey) || 'null') } catch (e) { raw = null }
  return normalizeOrder(raw, defs)
}
export function saveOrder(storeKey, order) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(storeKey, JSON.stringify(order)) } catch (e) { /* 配额满等忽略 */ }
}
// 把 key 挪到下标 to（以移除该 key 之后的数组计，越界夹取）；返回新数组，原数组不动
export function moveKey(order, key, to) {
  const i = order.indexOf(key)
  if (i < 0) return order.slice()
  const out = order.slice(); out.splice(i, 1)
  out.splice(Math.max(0, Math.min(out.length, to)), 0, key)
  return out
}
// 拖动排序的鼠标手柄。纯鼠标事件、不走 HTML5 DnD：省掉幽灵图，也绕开 Chromium「拖源节点被搬动就提前发 dragend」的脾气。
// 按下把手记住 key（state.key，调用方给 reactive 对象以便渲染「拖动中」态）；光标移到别的条目上，
// 从上往下拖过了它的中线 / 从下往上拖没到它的中线才换位——中线附近不来回抖；松开即结束。
// 顺序在每次换位时已经 setOrder 写回，持久化由调用方的 watch 接手。
export function makeDragOrder({ state, getOrder, setOrder, onEnd }) {
  const win = typeof window === 'undefined' ? null : window
  const body = typeof document === 'undefined' ? null : document.body
  function end() {
    if (!state.key) return
    state.key = ''
    if (win) win.removeEventListener('mouseup', end)
    if (body) body.style.cursor = ''
    if (onEnd) onEnd()
  }
  return {
    start(e, key) {
      if (e.button !== 0) return
      e.preventDefault()
      state.key = key
      if (body) body.style.cursor = 'grabbing'
      if (win) win.addEventListener('mouseup', end)
    },
    over(e, key) {
      if (!state.key || state.key === key) return
      const order = getOrder()
      const from = order.indexOf(state.key), to = order.indexOf(key)
      if (from < 0 || to < 0) return
      const r = e.currentTarget.getBoundingClientRect()
      const below = e.clientY > r.top + r.height / 2
      if ((from < to && below) || (from > to && !below)) setOrder(moveKey(order, state.key, to))
    },
    end
  }
}
