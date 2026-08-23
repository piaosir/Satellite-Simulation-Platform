// 「卫星组」：把星座页的「筛选结果」或「Ctrl 多选卫星」存成命名组（只记录成员 NORAD + 名称），
// 之后可在星座页一键重新显示——显示时按 NORAD 从全量搜索库解析回可渲染 entries，复用现成的
// filterEntries 显示管线（跨分组、点选、选中轨道/星下点/足迹、可见性分析全部自动获得）。
// 本层只负责「组列表 + 本地持久化」，不做卫星解算/渲染；与 useCustomConstellations 同构、互不相关。
import { ref } from 'vue'

const STORE_KEY = 'constellation3d/satGroups'

let _seq = 0
const genId = () => 'sg' + Date.now().toString(36) + (_seq++).toString(36)

// 颜色一律 '#rrggbb' 小写；其余一概视为「未设置」（''）。
// 注意入参可能是自定义星座 entry 的 [r,g,b] 数组，必须先验 string 再验格式。
const HEX6 = /^#[0-9a-fA-F]{6}$/
const normColor = (c) => (typeof c === 'string' && HEX6.test(c)) ? c.toLowerCase() : ''

// 规范化成员集：统一为 [{ id: NORAD 字符串, name, color?, missAt? }]，按 NORAD 去重、丢空号。
// 入参可为 [{ noradId, name }]（页面 entry）或 [{ id, name, color }]（已存组），两种都吃。
// color 是逐颗覆盖色（优先于组色），未设置不落键，保持存量数据形状不变。
// missAt 是「首次在一份完整目录里缺席」的星历时刻（见 reconcile），同样不落键。
function normSats(arr) {
  const out = [], dup = new Set()
  for (const s of (arr || [])) {
    const raw = s && (s.noradId != null ? s.noradId : s.id)
    const id = String(raw == null ? '' : raw).trim()
    if (!id || dup.has(id)) continue
    dup.add(id)
    const o = { id, name: String((s && s.name) || '').trim() }
    const c = normColor(s && s.color)
    if (c) o.color = c
    if (s && typeof s.missAt === 'string' && s.missAt) o.missAt = s.missAt
    out.push(o)
  }
  return out
}
// 两个「摘掉一个可选键」的小工具：可选键未设置时不落键，故只能重建对象，不能 delete 后复用。
const clearMiss = (s) => { const o = { id: s.id, name: s.name }; if (s.color) o.color = s.color; return o }   // 该星回到目录里了 → 撤销缺席观察
const clearColor = (s) => { const o = { id: s.id, name: s.name }; if (s.missAt) o.missAt = s.missAt; return o } // 清除逐颗覆盖色

// 规范化一条组，补齐缺省字段
function normalize(g) {
  return {
    id: g && g.id ? g.id : genId(),
    name: ((g && g.name) || '卫星组').trim() || '卫星组',
    color: normColor(g && g.color),
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

  // 未占用的默认组名（删过组后仍不重名）
  function nextName() {
    const used = new Set(list.value.map((g) => g.name))
    let i = list.value.length + 1
    while (used.has('卫星组 ' + i)) i++
    return '卫星组 ' + i
  }

  // 存一批卫星为新组。sats=[{noradId,name}] 或 [{id,name}]；空集合不存（返回 null）。返回新组对象。
  function add(sats, name) {
    const s = normSats(sats)
    if (!s.length) return null
    const nm = String(name == null ? '' : name).trim() || nextName()
    const g = normalize({ name: nm, sats: s })
    list.value = [...list.value, g]
    persist()
    return g
  }
  // 建【空组】：add 有意拒绝空集合（防止误存），而「先建组、再搜索逐颗添加」的流程必须能先有个空壳。
  function create(name) {
    const g = normalize({ name: String(name == null ? '' : name).trim() || nextName(), sats: [] })
    list.value = [...list.value, g]
    persist()
    return g
  }
  // 复制一组（含成员与配色），插在原组之后
  function duplicate(id) {
    const g = find(id); if (!g) return null
    const c = normalize({ name: g.name + ' 副本', color: g.color, sats: g.sats.map((s) => ({ id: s.id, name: s.name, color: s.color, missAt: s.missAt })) })
    const next = [...list.value]
    next.splice(list.value.findIndex((x) => x.id === id) + 1, 0, c)
    list.value = next
    persist()
    return c
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

  // 组色：''=清除（回到「随所属星座」）。返回是否有实际改动。
  function setColor(id, hex) {
    const g = find(id); if (!g) return false
    const c = normColor(hex)
    if (hex !== '' && !c) return false   // 非法色值不落（'' 是合法的「清除」指令）
    if (g.color === c) return false
    g.color = c; list.value = [...list.value]; persist(); return true
  }
  // 逐颗覆盖色：为组内指定 NORAD 批量设色（优先于组色）；hex=''=清除覆盖、回到组色。
  // 成员数组整体换新（不可变更新）：行内展开列表按数组身份做缓存，原地改对象会看不见变化。
  function colorSats(id, ids, hex) {
    const g = find(id); if (!g) return 0
    const c = normColor(hex)
    if (hex !== '' && !c) return 0
    const want = new Set((ids || []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean))
    if (!want.size) return 0
    let n = 0
    const next = g.sats.map((s) => {
      if (!want.has(s.id) || (s.color || '') === c) return s
      n++
      return c ? { ...s, color: c } : clearColor(s)   // 清色不能顺手把缺席观察标记也清掉
    })
    if (n) { g.sats = next; list.value = [...list.value]; persist() }
    return n
  }

  // —— 按最新真实星历核对成员：确认在轨 / 自动移除已离轨 ——
  // probe(id) → true=本次目录里有这颗 / false=缺席 / 其它（null）=不参与核对（自定义星座合成星走这支）。
  // epoch＝本次目录里【最旧】一份的下载时间（ISO 串）。取最旧不取最新：只有参与并集的每一份星历都比
  // 某成员的缺席记录新，「它还缺席」才是可信的证据；某组回落到旧缓存/内置快照时不能拿别组的新时间去判它。
  //
  // 【两次确认】才移除，一次只记账：
  //   · 在目录里            → 清掉 missAt（曾漏过一轮又回来了，撤销观察）
  //   · 缺席 · 无 missAt    → 记 missAt = epoch，本轮不动它
  //   · 缺席 · 有 missAt 且 epoch 比它新 → 判离轨，移除
  //   · 缺席 · 有 missAt 但 epoch 不更新（同一份目录重复跑）→ 不动
  // 单次缺席不算数，是因为「查不到」在本地分不清是真离轨还是目录这一次没取全；隔一份更新的完整目录
  // 仍然缺席，才排除得掉偶发。存量组的成员本来就没有 missAt，故第一轮一律只观察，从第二轮起才会掉。
  //
  // 安全阀 maxDropRatio：单组一次要掉的占比超阈值则整组原地不动（连 missAt 也不记）只如实报告 ——
  // 真实离轨是零星发生的，一次掉一大片必是数据侧出了问题，宁可不删。minGroupSize 以下的小组不设阀
  // （三颗星掉两颗完全可能是真的，按比例卡会把小组永远锁死）。
  //
  // 返回 [{ id, name, removed:[{id,name}], remain, skipped, total }]：removed 非空＝真移除了，
  // skipped 非空＝撞了安全阀没动。怎么讲给用户听由调用方决定，本层不碰 UI。
  function reconcile(probe, epoch, opts) {
    const ep = Date.parse(epoch || '')
    if (!(ep > 0) || typeof probe !== 'function') return []
    const epStr = String(epoch)
    const maxDropRatio = (opts && typeof opts.maxDropRatio === 'number') ? opts.maxDropRatio : 0.5
    const minGroupSize = (opts && typeof opts.minGroupSize === 'number') ? opts.minGroupSize : 5
    const report = []
    let dirty = false
    for (const g of list.value) {
      const keep = [], drop = []
      let marked = false
      for (const s of g.sats) {
        const p = probe(s.id)
        if (p === true) { if (s.missAt) { keep.push(clearMiss(s)); marked = true } else keep.push(s); continue }
        if (p !== false) { keep.push(s); continue }                     // 不参与核对（合成星等）
        const ma = s.missAt ? Date.parse(s.missAt) : NaN
        if (ma > 0) { if (ep > ma) drop.push(s); else keep.push(s); continue }
        keep.push({ ...s, missAt: epStr }); marked = true               // 首次缺席：只记账，不移除
      }
      if (drop.length && g.sats.length >= minGroupSize && drop.length / g.sats.length > maxDropRatio) {
        report.push({ id: g.id, name: g.name, removed: [], remain: g.sats.length, skipped: drop.length, total: g.sats.length })
        continue   // 整组原地不动，等下一份正常目录再核对
      }
      if (!drop.length && !marked) continue
      const total = g.sats.length
      g.sats = keep
      dirty = true
      if (drop.length) report.push({ id: g.id, name: g.name, removed: drop.map((s) => ({ id: s.id, name: s.name })), remain: keep.length, skipped: 0, total })
    }
    if (dirty) { list.value = [...list.value]; persist() }
    return report
  }

  return { list, load, persist, find, add, create, duplicate, rename, overwrite, append, removeSats, remove, setColor, colorSats, reconcile }
}
