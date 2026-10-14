// 「链路分析」视图节点选择器的候选来源（界面在 components/LinkNodePicker.vue，落库在宿主的 pick 回调）。
//
// 两层视图：
//   根视图 —— 地球站 · 点标记 · 航迹 · Polygon · 城市库（选中即在该处新建地球站）· 常用卫星（链路里已有的 / 聚焦集 / 天线树）· 卫星集。
//     航迹 / Polygon 选中即带缺省取点放进链路（Polygon 取质心；航迹运动档取载具、静止档取航点），读数报缺省取点里最差的那个。
//     有检索词时卫星改列全量检索（'*' 全部卫星那一集）按相关度的前 PICK_SAT_ROOT 条，组头报命中总数，
//     选择器再给一行「全部 N 颗」直达整份命中表；卫星集按集名过滤。
//   卫星集视图 —— 进入某一集（检索范围）后列它的全部成员：'*' 全部卫星 · '@' 当前显示 · 卫星天线树 / 内置星座 / 卫星组 /
//     导入星历 / 自定义星座（与星座侧栏「卫星集」同一张表、同一个次序，见宿主 setList）。成员表按集缓存（宿主回同一个
//     对象 = 成员没变），检索与排序都在本地做，几万颗也只是一遍扫描。
//
// 每条卫星候选按「放进这一位」算几何：与前后邻成跳的仰角 / 星间距离、此刻可见与否（linkGeom.slotFit，与链路读数同一口径），
// 据此排序（可见在前、仰角降序 / 星间距离升序）并出读数；与邻节点相同的灰显（title 报原因），站接站的整组不列（slotAccepts）；
// 集里有、当前星历里解不出的成员（卫星组里已离轨的号）列在末尾、灰显。
//
// 检索相关度（matchRank，越小越靠前）：全名 / 编号全等 0 · 名称前缀 1 · 编号前缀 / 词首 2 · 包含（含去掉空格连字符后包含）3 ·
//   轨道位置 4 · 来源标签 5（只在跨来源的集里比）。多个词（空格分开）须同时命中、取最差那一档；大小写 / 全角半角不计（NFKC）。
//   同档内有几何就按几何、否则保持该集的次序（天线树 / 卫星组 / 自定义星座按各自的成员序，其余按名称自然序）。
//
// 星位：一集几万颗时逐颗 SGP4 要几百毫秒 —— 按计算时刻分桶（STEP_MS）缓存、跨集共用；算的时候分片让出主线程（打字不卡），
//   新的一次刷新把旧的作废（tok.dead）。
//
// ★ 条目只放纯数据，不放星座条目：条目满是 satrec，进了组件的响应式就成 Proxy —— 一旦经节点缓存漏进选中集，
//   聚焦几何 Worker 会 DataCloneError。条目 → 节点由 nodeOf(item) 现查本模块自己的表（集缓存的 ents / 常用星的 ents）。
//
// 宿主注入（host）：
//   stations() / points()      标记层两个数组（原对象，只读）
//   trajectories() / polygons() 航迹 / Polygon 两个数组（原对象，只读；可缺）
//   areaNode(k, id)            Polygon / 航迹 → 带缺省取点的链路节点 | null（useMapLinks.areaNode）
//   nodeEnds(node)             节点此刻的全部端点（Polygon / 航迹 = 取到的各代表点；useMapLinks.nodeEnds）
//   trajSub(t)                 航迹行的副标题（类型 · 航点数 · 时段），可缺
//   nodePos(node)              链上节点此刻的端点 { ground, lat, lon, ecef } | null（useMapLinks.nodePos）
//   satPool()                  常用卫星 [{ entry, key, tier }]：tier 小的在前；已按 key 去重
//   setList()                  卫星集 [{ id, kind, name, lit, count, icon, tip }]（lit = 名字是界面词、跟语言走；用户起的名字为 false；tip = 悬停说明）
//   setEntries(id)             该集成员 → Promise<{ entries:[星座条目], missing:[{ id, name }], natural }> | null；
//                              成员没变就回同一个对象（本模块按它缓存条目表）。natural = 保持成员原序（否则按名称排）
//   satKeyOf(entry)            星座条目 → 卫星身份键（norad: / cc: / ephem: / grdsat: / name:）| null
//   satMeta(entry)             星座条目 → { name, tag, norad, slot, orb }（显示名 / 来源标签 / 真实 NORAD（合成号给 ''）/
//                              GEO 定点标注 / 无定点时的轨道读数）
//   satNode(entry)             星座条目 → 链路节点 { k:'sat', key, name, info? } | null
//   satKeyNode(key, name)      身份键 → 链路节点（条目表换代后按键补查；可缺）
//   satEcef(entry)             星座条目此刻 ECEF（km）| null
//   nowMs()                    当前计算时刻（ms；星位缓存按它分桶，可缺）
//   cities(q)                  城市库检索 → Promise<[core.searchCities 的条目]>
//   minEl()                    仰角门限（°）
//   fmtLL(lat, lon)            坐标读数

import { slotAccepts, slotIssue, sameNode, ISSUE_TEXT } from '../../../packages/core/models/mapLinks.mjs'
import { slotFit, cmpFit, cmpVis, fmtKm } from './linkGeom.js'
import { pointFallbackName, stationFallbackName } from '../../shared/markerNames.js'
import { byLang } from '../../shared/i18n/lang.js'
import { cityName, citySubtitle } from '../../shared/cityName.js'
import * as W from '../wgs84.js'

export const PICK_MAX = 60        // 根视图地球站 / 点标记 / 常用卫星每组最多列几条（组头读数报「列出 / 总数」）
export const PICK_CITY_MAX = 8
export const PICK_SAT_ROOT = 40   // 根视图有检索词时卫星列几条（其余由「全部 N 颗」进全量表）
export const PICK_SET_ROOT = 8    // 根视图有检索词时卫星集列几条
export const STEP_MS = 2000       // 星位缓存的时刻分桶
export const MISS_TEXT = '未在当前星历中找到'

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase()
const gpos = (lat, lon) => ({ ground: true, lat, lon, ecef: W.geodeticToEcef(lon, lat, 0) })
// 稳定排序（Array.prototype.sort 在现代引擎里本就稳定，这里显式带下标兜底，免得依赖实现）
function stableSort(arr, cmp) {
  return arr.map((x, i) => [x, i]).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map((p) => p[0])
}

// ---- 检索规整与相关度 ----
/** 规整：NFKC（全角半角）+ 小写 */
export function nfk(s) {
  const t = String(s == null ? '' : s)
  try { return t.normalize('NFKC').toLowerCase() } catch { return t.toLowerCase() }
}
const SEP_CLS = '\\s\\-_·.,/()（）\\[\\]【】°'
const SEP_G = new RegExp('[' + SEP_CLS + ']+', 'g')
const SEP_1 = new RegExp('[' + SEP_CLS + ']')
/** 去掉空白与连字符一类：「starlink1007」命中「STARLINK-1007」、「1105e」命中「110.5°E」 */
export const compact = (s) => String(s || '').replace(SEP_G, '')
/** 检索词 → [[词, 去分隔后的词], …]（空格分开的多个词须同时命中） */
export function queryTerms(q) {
  const s = nfk(q).trim()
  if (!s) return []
  return s.split(/\s+/).filter(Boolean).map((t) => [t, compact(t)])
}
// 词首命中：t 出现在开头之外、且前一个字符是分隔符（「ISS (ZARYA)」里的「zarya」）
function wordStart(s, t) {
  let i = s.indexOf(t, 1)
  while (i > 0) {
    if (SEP_1.test(s[i - 1])) return true
    i = s.indexOf(t, i + 1)
  }
  return false
}
function termRank(it, t, tc) {
  const lc = it.lc
  if (lc === t || (it.nid && it.nid === t)) return 0
  if (lc.startsWith(t)) return 1
  if ((it.nid && it.nid.startsWith(t)) || wordStart(lc, t)) return 2
  if (lc.includes(t) || (tc && it.lcc.includes(tc))) return 3
  if (it.sl && (it.sl.includes(t) || (tc && it.slc.includes(tc)))) return 4
  if (it.tl && it.tl.includes(t)) return 5
  return -1
}
/** 一条候选对检索词的档次：-1 = 不中；多个词取最差的一档 */
export function matchRank(it, terms) {
  let worst = 0
  for (const [t, tc] of terms) {
    const r = termRank(it, t, tc)
    if (r < 0) return -1
    if (r > worst) worst = r
  }
  return worst
}
// 检索用的规整字段（显示字段原样留着）
function keyed(it, name, nid, slot, tag) {
  it.lc = nfk(name); it.lcc = compact(it.lc)
  it.nid = nid || ''
  it.sl = nfk(slot); it.slc = compact(it.sl)
  it.tl = nfk(tag)
  return it
}

// ---- 名称自然序：小集用 Intl.Collator（与星座侧栏成员表同序，中文名按本地规则），大集用补零键（几万条的 Collator 排序要几百毫秒）----
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const COLLATE_MAX = 3000
const natKey = (lc) => lc.replace(/\d+/g, (d) => d.padStart(12, '0'))
function sortByName(items) {
  if (items.length <= COLLATE_MAX) return items.sort((a, b) => NAME_COLLATOR.compare(a.name, b.name))
  for (const it of items) it.nk = natKey(it.lc)
  return items.sort((a, b) => (a.nk < b.nk ? -1 : a.nk > b.nk ? 1 : 0))
}

// ---- 分片让出主线程（MessageChannel：窗口最小化时也不被节流；Node 测试里退 setTimeout）----
const yieldNow = (typeof window !== 'undefined' && typeof MessageChannel === 'function')
  ? () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r() }; ch.port2.postMessage(0) })
  : () => new Promise((r) => setTimeout(r, 0))
const nowT = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
const SLICE_MS = 8

export function createLinkPickSource(host) {
  // 常用卫星条目 id → 星座条目（只在本模块里）。只增不删、过大才整表清：异步检索可能乱序回来，按次重置会把正在显示的那批冲掉
  let ents = new Map()
  const remember = (id, e) => { if (ents.size > 5000) ents = new Map(); ents.set(id, e) }
  // 卫星集缓存：id → { res, items, ents, size }。res 是宿主 setEntries 回的对象：同一个对象 = 成员没变，条目表照用
  const setCache = new Map()
  // 星位缓存：{ b: 时刻桶, m: Map(星座条目 → ECEF | null) }，跨集共用（「全部卫星」与「当前显示」大半是同一批对象）
  let posC = { b: NaN, m: new Map() }

  // 插入位两侧的端点（数组：Polygon / 航迹邻居 = 取到的各代表点，候选星要对它们全部可见才算可见；站 / 点 / 星 = 一个）
  const endsOf = (n) => {
    if (!n) return []
    if (host.nodeEnds) return host.nodeEnds(n) || []
    const p = host.nodePos(n)
    return p ? [p] : []
  }
  const nbrs = (slot) => ({ prev: endsOf(slot && slot.prev), next: endsOf(slot && slot.next) })
  // 候选（可能是多个代表点 cs）放进插入位：逐个组合按 slotFit 算，汇成最差（仰角取最低、星间距离取最远、全部可见才算可见）
  function fitOf(prev, cs, next, th) {
    const P = prev.length ? prev : [null], N = next.length ? next : [null]
    let a = null
    for (const c of cs) {
      if (!c) continue
      for (const p of P) {
        for (const q of N) {
          const f = slotFit(p, c, q, th)
          if (!a) { a = { el: f.el, rangeKm: f.rangeKm, vis: f.vis, n: f.n }; continue }
          if (f.n > a.n) a.n = f.n
          a.vis = a.vis && f.vis
          if (f.el != null) a.el = a.el == null ? f.el : Math.min(a.el, f.el)
          if (f.rangeKm != null) a.rangeKm = a.rangeKm == null ? f.rangeKm : Math.max(a.rangeKm, f.rangeKm)
        }
      }
    }
    return a || { el: null, rangeKm: null, vis: false, n: 0 }
  }
  const hasNb = (nb) => nb.prev.length > 0 || nb.next.length > 0
  // 读数：有站星跳报仰角、只有星间跳报距离；没有可比的邻居不出
  function decorate(it, fit) {
    it.fit = fit
    it.rd = ''; it.rdTitle = ''; it.off = false
    if (!fit || !fit.n) return it
    it.off = !fit.vis
    if (fit.el != null) { it.rd = fit.el.toFixed(1) + '°'; it.rdTitle = '仰角' }
    else if (fit.rangeKm != null) { it.rd = fmtKm(fit.rangeKm); it.rdTitle = '星间距离' }
    return it
  }
  // 不能放的原因（'' = 能放）；替换位上被换的那一个本身恒可（选中 = 不换）
  function disOf(slot, node) {
    if (slot.cur && sameNode(slot.cur, node)) return ''
    const code = slotIssue(slot.prev || null, node, slot.next || null)
    return code ? (ISSUE_TEXT[code] || '') : ''
  }
  const isCur = (slot, node) => !!(slot.cur && sameNode(slot.cur, node))
  // 截断到 PICK_MAX，组头报总数
  const cap = (items) => ({ items: items.slice(0, PICK_MAX), total: items.length })

  /**
   * 地球站 + 点标记 + 航迹 + Polygon（同步）：{ st, pt, tj, pg }（各 {items,total}）| null（该位不能放地面端：四组都不列）。
   * 有邻居就按几何排（可见在前、仰角降序），否则保持列表顺序。航迹 / Polygon 按缺省取点的各代表点算、报最差那个。
   */
  function ground(q, slot) {
    if (!slotAccepts(slot.prev || null, slot.next || null).ground) return null
    const nbs = nbrs(slot), { prev, next } = nbs
    const th = host.minEl(), kw = norm(q), nb = hasNb(nbs)
    const st = [], pt = [], tj = [], pg = []
    ;(host.stations() || []).forEach((s, i) => {
      if (!s || s.id == null || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return
      const nm = String(s.name || '').trim()
      const shown = nm || stationFallbackName(i)
      if (kw && !shown.toLowerCase().includes(kw)) return
      const node = { k: 'st', id: s.id }
      st.push(decorate({ id: 'st:' + s.id, kind: 'st', name: shown, sub: host.fmtLL(s.lat, s.lon), node, dis: disOf(slot, node), cur: isCur(slot, node) }, nb ? fitOf(prev, [gpos(s.lat, s.lon)], next, th) : null))
    })
    ;(host.points() || []).forEach((p, i) => {
      if (!p || p.id == null || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return
      const nm = String(p.name || '').trim() || pointFallbackName(i)
      if (kw && !nm.toLowerCase().includes(kw)) return
      const node = { k: 'pt', id: p.id }
      pt.push(decorate({ id: 'pt:' + p.id, kind: 'pt', name: nm, sub: host.fmtLL(p.lat, p.lon), node, dis: disOf(slot, node), cur: isCur(slot, node) }, nb ? fitOf(prev, [gpos(p.lat, p.lon)], next, th) : null))
    })
    // 航迹 / Polygon：节点带缺省取点（选中即放进链路的就是它）；没有有效几何的不列
    const area = (k, arr, out, subOf, icon) => {
      for (const o of (arr || [])) {
        if (!o || o.id == null) continue
        const nm = String(o.name || '').trim() || (k === 'pg' ? 'Polygon' : '')
        if (kw && !nm.toLowerCase().includes(kw)) continue
        const node = host.areaNode ? host.areaNode(k, o.id) : null
        if (!node) continue
        const ends = endsOf(node)
        if (!ends.length) continue
        out.push(decorate({ id: k + ':' + o.id, kind: k, icon: icon(o), name: nm, sub: subOf(o), node, dis: disOf(slot, node), cur: isCur(slot, node) }, nb ? fitOf(prev, ends, next, th) : null))
      }
    }
    area('tj', host.trajectories ? host.trajectories() : [], tj, (t) => (host.trajSub ? host.trajSub(t) : ''), (t) => (t.kind === 'flight' ? 'plane' : 'ship'))
    area('pg', host.polygons ? host.polygons() : [], pg, (p) => { const n = Array.isArray(p.pts) ? p.pts.length : 0; return byLang(`${n} 个顶点`, `${n} vertices`) }, () => 'polygon')
    const by = (a, b) => cmpFit(a.fit, b.fit)
    const srt = (arr) => cap(nb ? stableSort(arr, by) : arr)
    return { st: srt(st), pt: srt(pt), tj: srt(tj), pg: srt(pg) }
  }

  // 星座条目 → 卫星候选的基础字段（与插入位无关的那部分；检索字段一并规整好）。multi = 跨来源的集（行上带来源标签）
  function satBase(e, key, cs, multi) {
    const m = host.satMeta(e) || {}
    const name = m.name || key
    const tag = multi ? (m.tag || '') : ''
    const it = { id: 'sat:' + key, kind: 'sat', key, cs, name, tag, norad: m.norad || '', slot: m.slot || '', orb: m.slot ? '' : (m.orb || '') }
    return keyed(it, name, it.norad, it.slot, tag)
  }
  // 放进这一位：节点 / 灰显原因 / 当前标记 + 几何读数（新对象：集缓存里的基础条目不动）
  function place(base, slot, fit, rank) {
    const node = { k: 'sat', key: base.key }
    return decorate({ ...base, node, rank: rank || 0, dis: base.miss ? MISS_TEXT : disOf(slot, node), cur: isCur(slot, node) }, fit)
  }
  function satItem(e, key, slot, fit, tag) {
    const base = satBase(e, key, '', true)
    if (tag) { base.tag = tag; base.tl = nfk(tag) }
    const it = place(base, slot, fit, 0)
    remember(it.id, e)
    return it
  }

  /**
   * 常用卫星（根视图空检索词，同步）：宿主给的常用池（链路里已有的 / 聚焦集 / 天线树）按 tier 分档、档内按几何排；
   * 截断到 PICK_MAX，组头报池子总数。档与档之间那一条打 sep（列表里画一道细分隔）。
   */
  function satsLocal(slot) {
    const nbs = nbrs(slot), { prev, next } = nbs
    const th = host.minEl(), nb = hasNb(nbs)
    const pool = host.satPool() || []
    let rows = pool.map((p) => ({ p, fit: nb ? fitOf(prev, [(() => { const x = host.satEcef(p.entry); return x ? { ground: false, ecef: x } : null })()], next, th) : null }))
    rows = stableSort(rows, (a, b) => (a.p.tier - b.p.tier) || cmpFit(a.fit, b.fit))
    const items = []
    for (const r of rows.slice(0, PICK_MAX)) items.push(satItem(r.p.entry, r.p.key, slot, r.fit, ''))
    const i1 = rows.findIndex((r) => r.p.tier > rows[0].p.tier)
    if (i1 > 0 && i1 < items.length) items[i1].sep = true
    return { items, total: pool.length }
  }

  /** 卫星集（同步）：有检索词按集名过滤并截断到 PICK_SET_ROOT；条目 { id:'set:<集 id>', kind:'set', sid, setKind, name, lit, count, icon } */
  function sets(q) {
    const list = host.setList ? (host.setList() || []) : []
    const terms = queryTerms(q)
    const out = []
    for (const s of list) {
      if (!s || !s.id) continue
      if (terms.length) { const lc = nfk(s.name), lcc = compact(lc); if (!terms.every(([t, tc]) => lc.includes(t) || (tc && lcc.includes(tc)))) continue }
      out.push({ id: 'set:' + s.id, kind: 'set', sid: s.id, setKind: s.kind || '', name: s.name || '', lit: !!s.lit, count: s.count, icon: s.icon || '', tip: s.tip || '', dis: '' })
    }
    return { items: terms.length ? out.slice(0, PICK_SET_ROOT) : out, total: out.length }
  }

  // 取一集的条目表：成员没变（宿主回同一个对象）就用缓存的那份；同一份成员正在建就搭车（几万条的建表不因连着打字一再重来）
  const building = new Map()   // id → { res, p }
  async function loadSet(id) {
    if (!host.setEntries) return null
    const res = await host.setEntries(id)
    if (!res) return null
    const c = setCache.get(id)
    if (c && c.res === res) return c
    const f = building.get(id)
    if (f && f.res === res) return f.p
    const job = { res, p: null }
    job.p = buildSet(id, res).then((S) => { setCache.set(id, S); return S }).finally(() => { if (building.get(id) === job) building.delete(id) })
    building.set(id, job)
    return job.p
  }
  async function buildSet(id, res) {
    const multi = id === '*' || id === '@'
    const em = new Map(), items = [], seen = new Set()
    const list = res.entries || [], ks = Array.isArray(res.keys) && res.keys.length === list.length ? res.keys : null
    let t0 = nowT(), k = 0
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      const key = e ? (ks ? ks[i] : host.satKeyOf(e)) : null
      if (!key || seen.has(key)) continue
      seen.add(key)
      const it = satBase(e, key, id, multi)
      em.set(it.id, e); items.push(it)
      if ((++k & 255) === 0 && nowT() - t0 > SLICE_MS) { await yieldNow(); t0 = nowT() }
    }
    if (!res.natural) sortByName(items)
    // 集里有、星历里解不出的成员：灰显列在末尾（行上照样报编号，用户认得出是哪颗）
    for (const m of res.missing || []) {
      const nid = m && m.id != null ? String(m.id).trim() : ''
      const key = m && m.key ? m.key : (/^\d+$/.test(nid) ? 'norad:' + Number(nid) : '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      const name = String((m && m.name) || '').trim() || ('NORAD ' + nid)
      items.push(keyed({ id: 'sat:' + key, kind: 'sat', key, cs: id, name, tag: '', norad: nid, slot: '', orb: '', miss: true }, name, nid, '', ''))
    }
    return { res, items, ents: em, size: items.length }
  }
  function posBucket() {
    const t = Number(host.nowMs ? host.nowMs() : Date.now())
    const b = Math.floor((Number.isFinite(t) ? t : Date.now()) / STEP_MS)
    if (posC.b !== b) posC = { b, m: new Map() }
    return posC
  }
  function posOf(pc, e) {
    if (pc.m.has(e)) return pc.m.get(e)
    let x = null
    try { x = host.satEcef(e) || null } catch { x = null }
    pc.m.set(e, x)
    return x
  }
  // 把 rows 里还没算过的星位补齐（分片让出主线程）；被作废返回 false
  async function fillPos(S, rows, pc, tok) {
    let t0 = nowT(), k = 0
    for (const r of rows) {
      if (r.it.miss) continue
      const e = S.ents.get(r.it.id)
      if (!e || pc.m.has(e)) continue
      posOf(pc, e)
      if ((++k & 63) === 0 && nowT() - t0 > SLICE_MS) {
        await yieldNow()
        if (tok && tok.dead) return false
        t0 = nowT()
      }
    }
    return true
  }

  /**
   * 卫星集视图（异步）：该集全部成员按检索词过滤、按「相关度 → 几何 → 集内次序」排好、带读数。
   * 返回 { items, total（该集颗数）, n（命中颗数）, visN（此刻可见的颗数，有邻居时才有意义）, nb（该位有可比的邻居）}；
   * 被作废（tok.dead）返回 null。
   */
  async function scopeList(id, q, slot, tok) {
    const S = await loadSet(id)
    if (!S || (tok && tok.dead)) return null
    const sl = slot || {}
    const terms = queryTerms(q)
    let rows
    if (terms.length) { rows = []; for (const it of S.items) { const r = matchRank(it, terms); if (r >= 0) rows.push({ it, r }) } }
    else rows = S.items.map((it) => ({ it, r: 0 }))
    const nbs = nbrs(sl), { prev, next } = nbs
    const nb = hasNb(nbs), th = host.minEl()
    const pc = nb ? posBucket() : null
    if (nb && !(await fillPos(S, rows, pc, tok))) return null
    if (tok && tok.dead) return null
    let visN = 0, t0 = nowT()
    const out = new Array(rows.length)
    for (let i = 0; i < rows.length; i++) {
      const { it, r } = rows[i]
      let fit = null
      if (nb && !it.miss) {
        const x = pc.m.get(S.ents.get(it.id))
        fit = fitOf(prev, [x ? { ground: false, ecef: x } : null], next, th)
        if (fit.vis) visN++
      }
      out[i] = place(it, sl, fit, r)
      if ((i & 255) === 255 && nowT() - t0 > SLICE_MS) {
        await yieldNow()
        if (tok && tok.dead) return null
        t0 = nowT()
      }
    }
    // 无词无邻居 = 集内次序原样（解不出的成员本就在末尾）；否则按「解不出的在末 → 相关度 → 几何」排。
    // 原生 sort 自 ES2019 起规定稳定：同档保持集内次序（几万条不再套一层下标数组）
    if (terms.length || nb) out.sort((a, b) => ((a.miss ? 1 : 0) - (b.miss ? 1 : 0)) || (a.rank - b.rank) || (nb ? cmpFit(a.fit, b.fit) : 0))
    return { items: out, total: S.size, n: out.length, visN, nb }
  }

  /** 卫星（根视图有检索词，异步）：全量（'*'）里按相关度 → 几何的前 PICK_SAT_ROOT 条，total = 命中总数；被作废返回 null */
  async function satsSearch(q, slot, tok) {
    if (!queryTerms(q).length) return { items: [], total: 0 }
    const r = await scopeList('*', q, slot, tok)
    if (!r) return tok && tok.dead ? null : { items: [], total: 0 }
    return { items: r.items.slice(0, PICK_SAT_ROOT), total: r.n }
  }

  /**
   * 城市库（有检索词、该位能放地面端时，异步）：选中即在该城市新建一座地球站。已有同名地球站的城市不列
   * （要的多半就是那座站，地球站组里已经有了）。命中顺序即相关度，按可见稳定分两档。
   */
  async function cities(q, slot) {
    if (!norm(q) || !slotAccepts(slot.prev || null, slot.next || null).ground) return { items: [], total: 0 }
    let r = null
    try { r = await host.cities(q) } catch { r = null }
    const list = Array.isArray(r) ? r : []
    const nbs = nbrs(slot), { prev, next } = nbs
    const th = host.minEl(), nb = hasNb(nbs)
    const have = new Set((host.stations() || []).map((s) => norm(s && s.name)).filter(Boolean))
    const items = []
    for (const c of list) {
      const lat = Number(c.lat), lon = Number(c.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      const nm = cityName(c)
      if (!nm || have.has(norm(nm)) || have.has(norm(c.name)) || have.has(norm(c.en))) continue
      items.push(decorate({ id: 'city:' + c.name + '@' + lon.toFixed(3) + ',' + lat.toFixed(3), kind: 'city', name: nm, sub: citySubtitle(c) || host.fmtLL(lat, lon), ll: { lat, lon }, dis: '', cur: false }, nb ? fitOf(prev, [gpos(lat, lon)], next, th) : null))
      if (items.length >= PICK_CITY_MAX) break
    }
    return { items: nb ? stableSort(items, (a, b) => cmpVis(a.fit, b.fit)) : items, total: items.length }
  }

  /** 条目 → 链路节点（站 / 点直接给；航迹 / Polygon 现造一份带缺省取点的；星现查本模块的表、由宿主补身份快照；集已换代则按键补查）；城市 / 卫星集条目返回 null */
  function nodeOf(it) {
    if (!it || !it.node) return null
    if (it.kind === 'st' || it.kind === 'pt') return { k: it.kind, id: it.node.id }
    if (it.kind === 'tj' || it.kind === 'pg') return host.areaNode ? host.areaNode(it.kind, it.node.id) : null
    if (it.kind === 'sat') {
      if (it.miss) return null
      const S = it.cs ? setCache.get(it.cs) : null
      const e = (S && S.ents.get(it.id)) || ents.get(it.id) || null
      if (e) return host.satNode(e)
      return host.satKeyNode ? host.satKeyNode(it.key, it.name) : null
    }
    return null
  }

  return { ground, satsLocal, sets, scopeList, satsSearch, cities, nodeOf }
}
