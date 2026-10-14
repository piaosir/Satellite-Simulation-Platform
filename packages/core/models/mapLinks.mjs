// 图上链路（STK Chain 范式）纯逻辑：星座 3D 主窗建链 / 呈现、四个链路预算窗口导入共用。
// 纯 ESM、零依赖、Node 可测（设计稿 docs/图上链路与地球站参数设计_2026-10-07.md）。
//
// 一条链路 = 单向有序节点序列（双向由用户自己建两条，reverseLink 只是帮他抄一份反向的）：
//   link = { id, name, nameAuto, color?, show?, nodes: [node, …] }
//   node = { k: 'st', id }                                        地球站（标记层 stations 的 id）
//        | { k: 'pt', id }                                        点标记（标记层 points 的 id；只有位置，按地面端算，参数取各窗缺省）
//        | { k: 'pg', id, pick }                                  Polygon（globe3d/polygons 的 id）：取若干代表点（质心 / 顶点 / 边界等分）
//        | { k: 'tj', id, pick }                                  航迹（标记层 trajectories 的 id）：取若干代表点（载具 / 航点 / 沿迹等分）
//            pick 的形状与几何口径见 mapLinkPoints.mjs；两类都是地面端（相邻规则同地球站），一个节点可落成多个代表点
//        | { k: 'sat', key, name, regen?: true, laser?: true,     卫星（satKey + 显示名快照）
//            info: { noradId, geo, slotLon, folder, altKm, inclDeg } }   导入用身份快照（主窗每次落盘刷新）
//   regen：转发方式再生（缺省透明 / 弯管）；链端卫星恒按再生（不看这一位，与端到端引擎同口径：链端没有来波或去处）。
//   laser：本星发往【下一颗卫星】的星间跳用激光（缺省微波）；下一节点不是卫星时不看。
//          激光跳两端卫星恒按再生（光链路必然星上解调）——不看 regen 位，与链端同口径。
//   中间的地球站 = 地面转接站（再生节点）。
//
// 校验（linkIssues）：≥ 2 节点；相邻不同为地球站；相邻不为同一对象；激光跳两端必须再生；引用的站 / 星解析不到。
// 允许：同一卫星非相邻多次出现（双跳经同一颗星）；首尾同一地球站（环回）。
//
// 可导入（linkTargets）——拓扑决定能进哪个计算模块：
//   linkbudget（GSO 弯管）  站 → 星(透明，GEO) → 站
//   ngso（NGSO 弯管）       站 → 星(透明，非 GEO) → 站
//   regen（再生式）         每颗卫星都是再生（链端自动算再生）：逐跳拆成上行 / 下行 / 星间微波 / 星间激光行
//   e2e（端到端）           任何有效链路
//
// 导入载荷（chainPayload）：站拿名字 / 经纬度 / 口径 / 天线罩，星拿身份快照 + 转发方式；跳给类型。主进程按同一形状清洗。
//
// 支路（linkStrands，STK Chain 的 strand）：Polygon / 航迹节点取了 k 个代表点，这条链路就展开成 k 条支路（两端都取多点时 = 两端点数之积），
//   每条支路一份单点载荷（代表点落成地面端 {t:'es'}，带 altM 高度），附 grp = 来源链路 id、sl = 支路名。单点链路展开成 1 条，与改前逐位相同。

import { normPick, pickCount as pickCountOf, PICK_MAX } from './mapLinkPoints.mjs'

export const LINK_TARGETS = Object.freeze(['linkbudget', 'ngso', 'regen', 'e2e'])
/** 每条链路节点数上限（端到端工作台的链条再长也用不到这么多）与每份存档链路数上限。 */
export const LINK_NODES_MAX = 32, LINKS_MAX = 500
/** 每条链路导入时最多展开多少条支路（超出整条不导入）。 */
export const STRANDS_MAX = 512
export { PICK_MAX }
/** 地球站天线口径的合法范围（m）：0 < d ≤ 1000。 */
export const DIA_M_MAX = 1000

const fin = Number.isFinite
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (v == null ? '' : String(v))

export const okDiaM = (v) => typeof v === 'number' && fin(v) && v > 0 && v <= DIA_M_MAX
/** 地球站功放功率的合法范围（W）：0 < p ≤ 100000。 */
export const PWR_W_MAX = 100000
export const okPwrW = (v) => typeof v === 'number' && fin(v) && v > 0 && v <= PWR_W_MAX

// ─────────────────────────────── 节点 / 跳 ───────────────────────────────

// 地面端：地球站 / 点标记 / Polygon / 航迹（跳类型、拓扑判据都一样）；多点端 = Polygon / 航迹（一个节点落成若干代表点）
const isSt = (n) => !!n && (n.k === 'st' || n.k === 'pt' || n.k === 'pg' || n.k === 'tj')
const isSat = (n) => !!n && n.k === 'sat'
/** 是否 Polygon / 航迹节点（取代表点的那两类） */
export const isAreaNode = (n) => !!n && (n.k === 'pg' || n.k === 'tj')
/** 两节点是否同一对象（站 / 点 / Polygon / 航迹比 id、星比 key）。 */
export function sameNode(a, b) {
  if (!a || !b || a.k !== b.k) return false
  return a.k === 'sat' ? str(a.key) === str(b.key) : str(a.id) === str(b.id)
}
/**
 * 跳类型：站→星 'up'、星→站 'down'、星→星 'isl'（发端星 laser 位为真则 'laser'）、站→站 null（非法）。
 */
export function hopKind(a, b) {
  if (isSt(a) && isSat(b)) return 'up'
  if (isSat(a) && isSt(b)) return 'down'
  if (isSat(a) && isSat(b)) return a.laser ? 'laser' : 'isl'
  return null
}
/** 链上第 i 个节点按再生算吗：链端卫星、激光跳两端卫星恒再生；其余中间卫星看 regen 位；地面端不是卫星，返回 false。 */
export function satRegenAt(link, i) {
  const ns = (link && link.nodes) || [], n = ns[i]
  if (!isSat(n)) return false
  if (i === 0 || i === ns.length - 1) return true
  if (n.regen === true) return true
  return satLaserAt(link, i)
}
/** 第 i 颗卫星是否挂着激光跳（发出的或收到的）。 */
export function satLaserAt(link, i) {
  const ns = (link && link.nodes) || [], n = ns[i], p = ns[i - 1]
  if (!isSat(n)) return false
  return (n.laser === true && isSat(ns[i + 1])) || (isSat(p) && p.laser === true)
}

// ─────────────────────────────── 校验 ───────────────────────────────

/**
 * 链路问题清单（空数组 = 有效）。ctx（可选）：hasStation(id) / hasPoint(id) → bool、satOk(node) → bool、
 * area(node) → Polygon / 航迹对象 | null；不给就不查存在性。
 * 每项 { code, at }：at = 节点下标（跳问题给发端下标）。
 *   'short' 不足两个节点 · 'st-st' 相邻同为地面端 · 'same' 相邻为同一对象 · 'laser' 激光跳一端不是再生卫星
 *   'no-st' 地球站已删除 · 'no-pt' 点标记已删除 · 'no-pg' Polygon 已删除 · 'no-tj' 航迹已删除 · 'no-sat' 卫星无法解析
 *   'no-pick' 未选取代表点 · 'pick-max' 代表点超过 PICK_MAX 个
 */
export function linkIssues(link, ctx) {
  const out = []
  const ns = (link && Array.isArray(link.nodes)) ? link.nodes : []
  if (ns.length < 2) out.push({ code: 'short', at: -1 })
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i]
    if (ctx && n && n.k === 'st' && typeof ctx.hasStation === 'function' && !ctx.hasStation(n.id)) out.push({ code: 'no-st', at: i })
    if (ctx && n && n.k === 'pt' && typeof ctx.hasPoint === 'function' && !ctx.hasPoint(n.id)) out.push({ code: 'no-pt', at: i })
    if (ctx && isAreaNode(n) && typeof ctx.area === 'function') {
      const o = ctx.area(n)
      if (!o) out.push({ code: n.k === 'pg' ? 'no-pg' : 'no-tj', at: i })
      else {
        const c = pickCountOf(n.k, o, n.pick)
        if (!c) out.push({ code: 'no-pick', at: i })
        else if (c > PICK_MAX) out.push({ code: 'pick-max', at: i })
      }
    }
    if (ctx && isSat(n) && typeof ctx.satOk === 'function' && !ctx.satOk(n)) out.push({ code: 'no-sat', at: i })
    if (i === ns.length - 1) break
    const m = ns[i + 1]
    if (sameNode(n, m)) { out.push({ code: 'same', at: i }); continue }
    if (isSt(n) && isSt(m)) { out.push({ code: 'st-st', at: i }); continue }
    if (hopKind(n, m) === 'laser' && !(satRegenAt(link, i) && satRegenAt(link, i + 1))) out.push({ code: 'laser', at: i })
  }
  return out
}
export const linkValid = (link, ctx) => linkIssues(link, ctx).length === 0

/** 问题码 → 界面短句（状态行 / 灰显项的 title 用；中文是源串，英文由界面翻译层出）。 */
export const ISSUE_TEXT = Object.freeze({
  short: '节点不足两个',
  'st-st': '相邻节点同为地面端',
  same: '相邻节点相同',
  laser: '激光星间跳两端须为再生卫星',
  'no-st': '地球站已删除',
  'no-pt': '点标记已删除',
  'no-pg': 'Polygon 已删除',
  'no-tj': '航迹已删除',
  'no-sat': '卫星无法解析',
  'no-pick': '未选取代表点',
  'pick-max': '代表点超过 64 个',
  strands: '支路超过 512 条'
})

// ─────────────────────────────── 插入位 ───────────────────────────────
// 图上点选与「链路」视图的节点选择器共用一个插入位：prev / next = 该位前后的节点（替换某个节点时 = 它的两个邻居），
// 链头 / 链尾那一侧给 null。判据与 linkIssues 的相邻两条同口径，只是提前到「放进去之前」。

/** 该位能放哪类节点：地面端（站 / 点）要求两侧都不是地面端；卫星恒可（与邻节点相同的那一颗由 slotIssue 逐个判）。 */
export function slotAccepts(prev, next) {
  return { ground: !isSt(prev) && !isSt(next), sat: true }
}
/** 候选节点放进该位的问题码：'' 可放 · 'same' 与相邻节点相同 · 'st-st' 与相邻地面端相接（短句见 ISSUE_TEXT）。 */
export function slotIssue(prev, cand, next) {
  if (sameNode(prev, cand) || sameNode(cand, next)) return 'same'
  if (isSt(cand) && (isSt(prev) || isSt(next))) return 'st-st'
  return ''
}

// ─────────────────────────────── 可导入判定 ───────────────────────────────

/**
 * 一条链路能进哪几个计算模块：{ linkbudget, ngso, regen, e2e } 各为布尔。无效链路全 false。
 * GEO 判定取卫星节点的身份快照 info.geo（主窗建链 / 落盘时按星历判）。
 */
export function linkTargets(link, ctx) {
  const r = { linkbudget: false, ngso: false, regen: false, e2e: false }
  if (!linkValid(link, ctx)) return r
  if (linkStrandCount(link, ctx) > STRANDS_MAX) return r
  const ns = link.nodes
  r.e2e = true
  // 弯管单跳：站 → 透明星 → 站（中间那颗按 regen 位：没勾再生 = 透明）
  if (ns.length === 3 && isSt(ns[0]) && isSat(ns[1]) && isSt(ns[2]) && ns[1].regen !== true) {
    const geo = !!(ns[1].info && ns[1].info.geo)
    r.linkbudget = geo
    r.ngso = !geo
  }
  // 再生式：每颗卫星都按再生（链端恒再生、中间看 regen 位）——这样每一跳都能独立成一行
  r.regen = ns.every((n, i) => !isSat(n) || satRegenAt(link, i))
  return r
}
/** 某一目标下不能导入的原因（短句，灰显项 title 用）；能导入返回 ''。 */
export function targetReason(link, kind, ctx) {
  const iss = linkIssues(link, ctx)
  if (iss.length) return ISSUE_TEXT[iss[0].code] || ''
  if (linkStrandCount(link, ctx) > STRANDS_MAX) return ISSUE_TEXT.strands
  const t = linkTargets(link, ctx)
  if (t[kind]) return ''
  const ns = link.nodes
  const bent = ns.length === 3 && isSt(ns[0]) && isSat(ns[1]) && isSt(ns[2])
  if (kind === 'linkbudget') return !bent ? '仅支持 地球站 → 卫星 → 地球站' : ns[1].regen === true ? '卫星为再生转发' : '卫星不是地球静止轨道'
  if (kind === 'ngso') return !bent ? '仅支持 地球站 → 卫星 → 地球站' : ns[1].regen === true ? '卫星为再生转发' : '卫星为地球静止轨道'
  if (kind === 'regen') return '链路中有透明转发卫星'
  return ''
}

// ─────────────────────────────── 名称 / 反向 ───────────────────────────────

/**
 * 自动名：节点名用「 → 」连起来；节点多于 5 个时只留首、次、末两个，中间写「…」。
 * nameOf(node) → 节点显示名（站名 / 星名）；取不到的节点写 '?'。
 */
export function linkAutoName(link, nameOf) {
  const ns = (link && link.nodes) || []
  const nm = (n) => { const s = typeof nameOf === 'function' ? str(nameOf(n)).trim() : ''; return s || (isSat(n) ? str(n.name).trim() : '') || '?' }
  if (!ns.length) return ''
  const names = ns.map(nm)
  if (names.length <= 5) return names.join(' → ')
  return [names[0], names[1], '…', names[names.length - 2], names[names.length - 1]].join(' → ')
}
/**
 * 反向链路：节点倒序；laser 位跟着「发端」挪——原第 i 跳（i → i+1）记在 i 上，反向后它的发端是原 i+1。
 * newId() → 新链路 id。名字交还自动命名，颜色不抄（宿主另配）。
 */
export function reverseLink(link, newId) {
  const ns = (link && Array.isArray(link.nodes)) ? link.nodes : []
  const nodes = ns.map((n) => {
    const c = { ...n, info: n.info ? { ...n.info } : n.info }
    if (n.pick) c.pick = JSON.parse(JSON.stringify(n.pick))   // 代表点取法跟着节点走（深拷：两条链路各改各的）
    return c
  }).reverse()
  for (const n of nodes) if (isSat(n)) delete n.laser
  // 原跳 i（ns[i] → ns[i+1]）在反向序里是 nodes[L-2-i] → nodes[L-1-i]，发端 = nodes[L-2-i] = 原 ns[i+1]
  const L = ns.length
  for (let i = 0; i < L - 1; i++) if (isSat(ns[i]) && ns[i].laser && isSat(ns[i + 1])) nodes[L - 2 - i].laser = true
  for (const n of nodes) { if (n.info === undefined) delete n.info; if (n.regen !== true) delete n.regen }
  return { id: typeof newId === 'function' ? newId() : '', name: '', nameAuto: true, nodes }
}

// ─────────────────────────────── 规范化（存档 / 主进程前） ───────────────────────────────

const okSatInfo = (v) => isObj(v)
function normSatInfo(v) {
  if (!okSatInfo(v)) return null
  const num = (x) => (typeof x === 'number' && fin(x) ? x : null)
  const o = {}
  const nid = str(v.noradId).replace(/[^\w-]/g, '').slice(0, 24)
  if (nid) o.noradId = nid
  if (v.geo === true) o.geo = true
  const slot = num(v.slotLon); if (slot != null && Math.abs(slot) <= 360) o.slotLon = slot
  const f = str(v.folder).slice(0, 160); if (f) o.folder = f
  const alt = num(v.altKm); if (alt != null && alt > -1000 && alt < 1e7) o.altKm = alt
  const inc = num(v.inclDeg); if (inc != null && Math.abs(inc) <= 180) o.inclDeg = inc
  return o
}
/** 一个节点 → 规范化的新对象 | null（坏节点）。 */
export function normNode(n) {
  if (!isObj(n)) return null
  if (n.k === 'st' || n.k === 'pt') { const id = str(n.id).slice(0, 80); return id ? { k: n.k, id } : null }
  if (n.k === 'pg' || n.k === 'tj') {
    const id = str(n.id).slice(0, 80)
    if (!id) return null
    const o = { k: n.k, id }
    const pk = normPick(n.k, n.pick)
    if (pk) o.pick = pk   // 没有 / 坏的取点：不写（运行时按缺省取点）
    return o
  }
  if (n.k === 'sat') {
    const key = str(n.key).slice(0, 200)
    if (!key) return null
    const o = { k: 'sat', key, name: str(n.name).slice(0, 160) }
    if (n.regen === true) o.regen = true
    if (n.laser === true) o.laser = true
    const info = normSatInfo(n.info)
    if (info) o.info = info
    return o
  }
  return null
}
/** 一条链路 → 规范化的新对象 | null（没有 id）。坏节点丢掉、超长截断；name / color 限长。 */
export function normLink(l) {
  if (!isObj(l)) return null
  const id = str(l.id).slice(0, 80)
  if (!id) return null
  const nodes = (Array.isArray(l.nodes) ? l.nodes : []).slice(0, LINK_NODES_MAX).map(normNode).filter(Boolean)
  const o = { id, name: str(l.name).slice(0, 200), nameAuto: l.nameAuto !== false, nodes }
  const c = str(l.color)
  if (/^#[0-9a-fA-F]{6}$/.test(c)) o.color = c
  if (l.show === false) o.show = false
  return o
}
/** 存档里的 links 数组 → 规范化的新数组（非数组 → []；同 id 只留第一条）。 */
export function sanitizeLinks(arr) {
  if (!Array.isArray(arr)) return []
  const seen = new Set(), out = []
  for (const l of arr.slice(0, LINKS_MAX)) {
    const o = normLink(l)
    if (!o || seen.has(o.id)) continue
    seen.add(o.id); out.push(o)
  }
  return out
}

// ─────────────────────────────── 导入载荷 ───────────────────────────────

/**
 * 导入载荷（推：tool:open 的 ctx.links[i]；拉：计算窗对话框读 localStorage 现造）：
 *   { name, nameAuto, nodes: [ {t:'es', name, lat, lon, diaM?, radome?, pwrW?, altM?} | {t:'sat', key, name, noradId, geo, slotLon, folder, altKm, inclDeg, regen} ],
 *     hops: [ {type:'up'|'down'|'isl'|'laser'} ] }
 * ctx.station(id) / ctx.point(id) → 标记层的站 / 点对象（取不到 → 返回 null，即该链路不能导入）；ctx.nameOf(node) 可选（自动名用）。
 * 点标记只带名字与位置（口径 / 天线罩 / 功率取各窗缺省）。
 * Polygon / 航迹节点：ctx.pointAt(i, node) → 这一位取定的那个代表点 { name, lat, lon, altM? }（linkStrands 逐支路给；没给 → null）；
 *   落成地面端，altM = 航迹代表点的实际高度（m，计算窗「海拔」列写它、不再按地形取）。
 * 卫星节点的 regen = 按再生算（链端恒真）。
 */
export function chainPayload(link, ctx) {
  const ns = (link && Array.isArray(link.nodes)) ? link.nodes : []
  if (ns.length < 2) return null
  const nodes = []
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i]
    if (isAreaNode(n)) {
      const p = ctx && typeof ctx.pointAt === 'function' ? ctx.pointAt(i, n) : null
      if (!p || !fin(Number(p.lat)) || !fin(Number(p.lon))) return null
      const o = { t: 'es', name: str(p.name), lat: Number(p.lat), lon: Number(p.lon) }
      if (fin(p.altM)) o.altM = Math.round(p.altM)
      nodes.push(o)
    } else if (isSt(n)) {
      const pt = n.k === 'pt'
      const fn = ctx && (pt ? ctx.point : ctx.station)
      const s = typeof fn === 'function' ? fn(n.id) : null
      if (!s || !fin(Number(s.lat)) || !fin(Number(s.lon))) return null
      const o = { t: 'es', name: str(s.name), lat: Number(s.lat), lon: Number(s.lon) }
      if (!pt) {
        if (okDiaM(s.diaM)) o.diaM = s.diaM
        if (s.radome === true) o.radome = true
        if (okPwrW(s.pwrW)) o.pwrW = s.pwrW
      }
      nodes.push(o)
    } else if (isSat(n)) {
      const inf = n.info || {}
      const o = { t: 'sat', key: str(n.key), name: str(n.name), regen: satRegenAt(link, i) }
      if (inf.noradId) o.noradId = str(inf.noradId)
      o.geo = inf.geo === true
      if (fin(inf.slotLon)) o.slotLon = inf.slotLon
      if (inf.folder) o.folder = str(inf.folder)
      if (fin(inf.altKm)) o.altKm = inf.altKm
      if (fin(inf.inclDeg)) o.inclDeg = inf.inclDeg
      nodes.push(o)
    } else return null
  }
  const hops = []
  for (let i = 0; i < ns.length - 1; i++) {
    const t = hopKind(ns[i], ns[i + 1])
    if (!t) return null
    hops.push({ type: t })
  }
  // 名字：用户起过名（nameAuto === false）就用它，否则按节点现出自动名；nameAuto 一并带上，接收端（端到端的链路名）据此决定跟不跟自己的自动命名
  const custom = link.nameAuto === false ? str(link.name).trim() : ''
  return { name: custom || linkAutoName(link, ctx && ctx.nameOf), nameAuto: !custom, nodes, hops }
}

/**
 * 支路数（导入时这条链路展开成几条单点载荷）= 各 Polygon / 航迹节点取到的代表点数之积；没有多点节点为 1。
 * ctx.area(node) → 对象 | null；对象没了（或没给 ctx.area）计 0。
 */
export function linkStrandCount(link, ctx) {
  const ns = (link && Array.isArray(link.nodes)) ? link.nodes : []
  let n = 1
  for (const x of ns) {
    if (!isAreaNode(x)) continue
    const o = ctx && typeof ctx.area === 'function' ? ctx.area(x) : null
    if (!o) return 0
    n *= pickCountOf(x.k, o, x.pick)
    if (n > 1e9) break
  }
  return n
}

/**
 * 按支路展开导入载荷：[payload, …]（每份 = chainPayload 的单点形状，另带 grp = 来源链路 id、sl = 支路名）。
 * ctx 同 chainPayload，另需 ctx.points(node) → 该 Polygon / 航迹节点取到的代表点 [{ name, label, lat, lon, altM? }]
 *   （name = 落成地面端时的站名，如「华东区·顶点3」；label = 支路名里用的短名，如「顶点3」）。
 * 展开序：前面的多点节点变得慢（行按第一个多点节点的代表点成组）。支路多于 STRANDS_MAX、或某个多点节点一个点都没取 → []。
 * 多于一条支路时载荷名追加「 · 支路名」（用户起的名字也追加，否则各行同名分不开）。
 */
export function linkStrands(link, ctx) {
  const ns = (link && Array.isArray(link.nodes)) ? link.nodes : []
  if (ns.length < 2) return []
  const multi = []
  let total = 1
  for (let i = 0; i < ns.length; i++) {
    if (!isAreaNode(ns[i])) continue
    const pts = ctx && typeof ctx.points === 'function' ? (ctx.points(ns[i]) || []) : []
    if (!pts.length) return []
    multi.push({ i, pts })
    total *= pts.length
    if (total > STRANDS_MAX) return []
  }
  const grp = str(link.id)
  if (!multi.length) { const p = chainPayload(link, ctx); if (p) p.grp = grp; return p ? [p] : [] }
  const out = [], idx = multi.map(() => 0)
  for (let s = 0; s < total; s++) {
    const at = new Map(multi.map((m, j) => [m.i, m.pts[idx[j]]]))
    const p = chainPayload(link, { ...ctx, pointAt: (i) => at.get(i) || null })
    if (p) {
      p.grp = grp
      p.sl = multi.map((m) => str(at.get(m.i).label || at.get(m.i).name)).join(' / ')
      if (total > 1) p.name = p.name + ' · ' + p.sl
      out.push(p)
    }
    for (let j = multi.length - 1; j >= 0; j--) { if (++idx[j] < multi[j].pts.length) break; idx[j] = 0 }
  }
  return out
}

// ─────────────────────────────── 天线罩 ───────────────────────────────

/**
 * 典型干燥天线罩插入损耗（dB），按工作频率（GHz）分档——导入时新建「带罩」地球站库条目，罩损并入综合 / 附加损耗用的出厂值，
 * 用户在库里改。档位取夹层玻璃钢罩 / 空间桁架罩的常见量级：L/S < 3 GHz 0.1 · C 3–8 GHz 0.2 · X 8–12 GHz 0.3 ·
 * Ku 12–18 GHz 0.5 · Ka 18–40 GHz 1.0 · Q/V > 40 GHz 1.5。频率取不到按 Ku 档。
 */
export function radomeLossDb(fGHz) {
  const f = Number(fGHz)
  if (!fin(f) || f <= 0) return 0.5
  if (f < 3) return 0.1
  if (f < 8) return 0.2
  if (f < 12) return 0.3
  if (f < 18) return 0.5
  if (f < 40) return 1.0
  return 1.5
}
