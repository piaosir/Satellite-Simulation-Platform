// 「卫星组」：把星座页的「筛选结果」或「Ctrl 多选卫星」存成命名组（只记录成员 NORAD + 名称），
// 之后可在星座页一键重新显示——显示时按 NORAD 从全量搜索库解析回可渲染 entries，复用现成的
// filterEntries 显示管线（跨分组、点选、选中轨道/星下点/足迹、可见性分析全部自动获得）。
// 本层只负责「组列表 + 本地持久化」，不做卫星解算/渲染；与 useCustomConstellations 同构、互不相关。
import { ref } from 'vue'

const STORE_KEY = 'constellation3d/satGroups'

let _seq = 0
const genId = () => 'sg' + Date.now().toString(36) + (_seq++).toString(36)

// 规范化成员集：统一为 [{ id: NORAD 字符串, name }]，按 NORAD 去重、丢空号。
// 入参可为 [{ noradId, name }]（页面 entry）或 [{ id, name }]（已存组），两种都吃。
function normSats(arr) {
  const out = [], seen = new Set()
  for (const s of (arr || [])) {
    const raw = s && (s.noradId != null ? s.noradId : s.id)
    const id = String(raw == null ? '' : raw).trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: String((s && s.name) || '').trim() })
  }
  return out
}

// 规范化一条组，补齐缺省字段
function normalize(g) {
  return {
    id: g && g.id ? g.id : genId(),
    name: ((g && g.name) || '卫星组').trim() || '卫星组',
    color: (g && g.color) || '',
    sats: normSats(g && g.sats)
  }
}

export function useSatGroups() {
  const list = ref([])   // [{ id, name, color, sats:[{ id, name }] }]

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        items: list.value.map((g) => ({ id: g.id, name: g.name, color: g.color, sats: g.sats }))
      }))
    } catch { /* 存储失败不影响功能 */ }
  }

  function load() {
    try {
      const blob = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
      if (blob && Array.isArray(blob.items)) list.value = blob.items.map(normalize)
    } catch { /* 读失败按空处理 */ }
  }

  const find = (id) => list.value.find((g) => g.id === id) || null

  // 存一批卫星为新组。sats=[{noradId,name}] 或 [{id,name}]；空集合不存（返回 null）。返回新组对象。
  function add(sats, name) {
    const s = normSats(sats)
    if (!s.length) return null
    const nm = String(name == null ? '' : name).trim() || ('卫星组 ' + (list.value.length + 1))
    const g = normalize({ name: nm, sats: s })
    list.value = [...list.value, g]
    persist()
    return g
  }
  function rename(id, name) {
    const nm = String(name == null ? '' : name).trim(); if (!nm) return false
    const g = find(id); if (!g) return false
    g.name = nm; list.value = [...list.value]; persist(); return true
  }
  // 用一批新卫星覆盖某组成员（空集合不覆盖，避免误清空）
  function overwrite(id, sats) {
    const g = find(id); if (!g) return false
    const s = normSats(sats); if (!s.length) return false
    g.sats = s; list.value = [...list.value]; persist(); return true
  }
  // 向组【追加】卫星（按 NORAD 去重，只加新的）。sats=[{noradId,name}] 或 [{id,name}]。返回实际新增数。
  function append(id, sats) {
    const g = find(id); if (!g) return 0
    const add = normSats(sats); if (!add.length) return 0
    const have = new Set(g.sats.map((s) => s.id))
    const fresh = add.filter((s) => !have.has(s.id))
    if (!fresh.length) return 0
    g.sats = [...g.sats, ...fresh]; list.value = [...list.value]; persist(); return fresh.length
  }
  // 从组【移除】指定 NORAD 卫星。ids=[noradId...]。返回实际移除数。
  function removeSats(id, ids) {
    const g = find(id); if (!g) return 0
    const kill = new Set((ids || []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean))
    if (!kill.size) return 0
    const before = g.sats.length
    g.sats = g.sats.filter((s) => !kill.has(s.id))
    const removed = before - g.sats.length
    if (removed) { list.value = [...list.value]; persist() }
    return removed
  }
  function remove(id) { list.value = list.value.filter((g) => g.id !== id); persist() }

  return { list, load, persist, find, add, rename, overwrite, append, removeSats, remove }
}
