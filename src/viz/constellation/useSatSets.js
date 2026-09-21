// 卫星集注册表：把「内置星座 / 卫星组 / 导入星历组 / 自定义星座」摊成一张【有序表】，每一项同一套口径 ——
// 显隐、顺序、改名、配色、剔除成员、删除、重置。
//
// 各类的「本体」仍在各自的库里（satGroups / customConst / 主进程 custom.json / CelesTrak 组），这里只记
// 【顺序 + 可见集合 + 覆盖层】：
//   · 内置星座没有自己的存储，改名 / 改色 / 剔星 / 删除都是覆盖（items[id]），「重置」= 把覆盖删掉；
//   · 导入组的剔星也记在这里（组本身在 custom.json，不动它）；
//   · 卫星组 / 自定义星座的名字、颜色、成员由各自的库管，这里不记第二份。
// id 约定：'g:<内置组 key>' | 's:<卫星组 id>' | 'i:<导入组 id>' | 'c:<自定义星座 id>'；'q' 是搜索结果（不入表、不入序）。
import { ref } from 'vue'

const STORE_KEY = 'constellation3d/satSets'
export const kindOf = (id) => ({ g: 'builtin', s: 'group', i: 'import', c: 'custom', q: 'search' }[String(id || '')[0]] || '')
const clean = (o) => {
  const out = {}
  for (const k of Object.keys(o || {})) {
    const v = o[k]
    if (v == null || v === '' || v === false) continue
    if (Array.isArray(v) && !v.length) continue
    out[k] = v
  }
  return out
}

export function useSatSets() {
  const order = ref([])           // 有序 id（不含 'q'）
  const items = ref({})           // id -> { name?, color?, hidden?: [NORAD…], removed?: true }
  const visible = ref(new Set())  // 可见集合（可含 'q'）
  const solo = ref(null)          // { id, prev: [id…] }：「仅显示」进入前的可见集合留在 prev

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        order: order.value,
        items: items.value,
        visible: [...visible.value].filter((id) => id !== 'q'),
        solo: solo.value && solo.value.id !== 'q' ? { id: solo.value.id, prev: solo.value.prev.filter((x) => x !== 'q') } : null
      }))
    } catch { /* 存储失败不影响功能 */ }
  }
  // 读回；返回 false 表示没有存档（调用方按旧存档迁移）
  function load() {
    let s = null
    try { s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null') } catch { s = null }
    if (!s || !Array.isArray(s.order)) return false
    order.value = s.order.filter((id) => typeof id === 'string' && id !== 'q')
    items.value = (s.items && typeof s.items === 'object') ? s.items : {}
    visible.value = new Set(Array.isArray(s.visible) ? s.visible : [])
    solo.value = (s.solo && typeof s.solo.id === 'string') ? { id: s.solo.id, prev: Array.isArray(s.solo.prev) ? s.solo.prev : [] } : null
    return true
  }

  const ov = (id) => items.value[id] || {}
  function setOv(id, patch) {
    const cur = clean({ ...ov(id), ...patch })
    const next = { ...items.value }
    if (Object.keys(cur).length) next[id] = cur; else delete next[id]
    items.value = next
    persist()
  }
  const isRemoved = (id) => !!ov(id).removed
  const hasOverride = (id) => { const o = ov(id); return !!(o.name || o.color || (o.hidden && o.hidden.length)) }
  const nameOf = (id) => ov(id).name || ''
  const colorOf = (id) => ov(id).color || ''
  const hiddenOf = (id) => new Set(ov(id).hidden || [])

  // 登记：不在表里的 id 排进来（新建的东西放最前，迁移的放最后）；标了 removed 的内置项不回来
  function ensure(ids, atTop) {
    const cur = order.value.slice()
    let changed = false
    for (const id of ids) {
      if (!id || id === 'q' || cur.includes(id) || isRemoved(id)) continue
      if (atTop) cur.unshift(id); else cur.push(id)
      changed = true
    }
    if (changed) { order.value = cur; persist() }
  }
  // 只留仍然存在的（各库删了东西 → 表里的引用跟着掉）
  function prune(keep) {
    const cur = order.value.filter((id) => keep(id))
    const v = new Set([...visible.value].filter((id) => id === 'q' || keep(id)))
    let changed = cur.length !== order.value.length || v.size !== visible.value.size
    if (solo.value && solo.value.id !== 'q' && !keep(solo.value.id)) { solo.value = null; changed = true }
    if (solo.value) { const p = solo.value.prev.filter((id) => id === 'q' || keep(id)); if (p.length !== solo.value.prev.length) { solo.value = { ...solo.value, prev: p }; changed = true } }
    if (changed) { order.value = cur; visible.value = v; persist() }
  }
  // 从表里拿掉（内置项另记 removed，之后可从「＋ 添加」找回；其它类由各自的库删本体后调这里）
  function drop(id, remember) {
    order.value = order.value.filter((x) => x !== id)
    const v = new Set(visible.value); v.delete(id); visible.value = v
    if (solo.value && solo.value.id === id) solo.value = null
    else if (solo.value) solo.value = { ...solo.value, prev: solo.value.prev.filter((x) => x !== id) }
    const next = { ...items.value }
    if (remember) next[id] = { removed: true }; else delete next[id]
    items.value = next
    persist()
  }
  function restoreRemoved(id) { setOv(id, { removed: false }); ensure([id], true) }
  function move(id, to) {
    if (!order.value.includes(id)) return
    const cur = order.value.filter((x) => x !== id)
    const i = Math.max(0, Math.min(Number(to) || 0, cur.length))
    cur.splice(i, 0, id)
    order.value = cur; persist()
  }
  function moveBy(id, delta) { const i = order.value.indexOf(id); if (i < 0) return; move(id, i + delta) }
  function resetOrder(defaultIds) {
    const set = new Set(order.value)
    const head = defaultIds.filter((id) => set.has(id))
    const rest = order.value.filter((id) => !head.includes(id))
    order.value = head.concat(rest); persist()
  }

  // —— 显隐 / 仅显示 ——
  const isVisible = (id) => visible.value.has(id)
  function setVisible(ids) { visible.value = new Set(ids); persist() }
  function toggle(id) {
    const next = new Set(visible.value)
    if (next.has(id)) next.delete(id); else next.add(id)
    if (solo.value) {
      if (solo.value.id === id && !next.has(id)) solo.value = null        // 把仅显示的那层也关掉 = 退出仅显示
      else if (next.size > 1) solo.value = null                            // 仅显示态下再开别的 = 变回普通多开
    }
    visible.value = next; persist()
  }
  function soloOn(id) {
    const prev = solo.value ? solo.value.prev : [...visible.value]
    solo.value = { id, prev }
    visible.value = new Set([id]); persist()
  }
  // 还原到进入「仅显示」前的可见集合；keep 判某个 id 现在还能不能显示（搜索结果层没了就不还原它）
  function restore(keep) {
    const s = solo.value; if (!s) return
    solo.value = null
    visible.value = new Set(s.prev.filter((id) => !keep || keep(id))); persist()
  }

  // —— 覆盖层 ——
  const rename = (id, name) => setOv(id, { name: String(name || '').trim() })
  const setColor = (id, hex) => setOv(id, { color: hex || '' })
  function hide(id, norads) { const h = hiddenOf(id); for (const n of norads) h.add(String(n)); setOv(id, { hidden: [...h] }) }
  function unhide(id, norads) { const h = hiddenOf(id); if (norads) for (const n of norads) h.delete(String(n)); else h.clear(); setOv(id, { hidden: [...h] }) }
  const reset = (id) => setOv(id, { name: '', color: '', hidden: [] })

  return {
    order, items, visible, solo,
    persist, load, ensure, prune, drop, restoreRemoved, move, moveBy, resetOrder,
    isVisible, setVisible, toggle, soloOn, restore,
    isRemoved, hasOverride, nameOf, colorOf, hiddenOf, rename, setColor, hide, unhide, reset
  }
}
