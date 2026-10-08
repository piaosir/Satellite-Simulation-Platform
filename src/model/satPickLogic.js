// 卫星页「选择卫星」的纯逻辑（SatPick.vue 的下拉、satStore 选星回填共用）：四路来源 → 行、跨来源去重合并、按绑定键回填名称与 hint。
// 裸 node 可 import（只走相对路径；不碰 satellite.js / vue / DOM）——packages/core/test/modelSatPick.test.mjs 直接测。
//
// 行：{ key, name, sub, src:'bound'|'tree'|'lb'|'cat', hint, terms?, n? }
//   key  = 绑定键（schema.mjs）；name = 显示名；sub = 一行短数据（NORAD / 轨位 / 区制 + 高度 / 天线数 / 库条目摘要）；
//   hint = 选星时手里的来源记录 {poolRec?, treeNode?, lbEntry?, orbitKind?}（satSources.resolveOrbit 解析轨道、
//          satStore.resolvedModel 自动匹配模型用）；terms = 额外参与筛选的字段（folder / 常用名 / 条目 id）；
//   folders = 树行合进来的节点 folder（认旧 grdsat: 绑定用）。
//
// 卫星天线树节点的绑定键与 3D 页同一套（ConstellationMap3D grdSatKeyOfNode → satKeyOf）——两个窗口对同一颗星给出同一个键：
//   · NORAD 1..799999            → norad:<号>
//   · NORAD ≥ 800000（星历点序列 / 自定义星座合成号）→ 候选池里同号那条的键（ephem:<组>:<key> / cc:<星座>:<名>），
//                                    池里没有 → name:<星名>
//   · 没有 NORAD                  → grdsat:<folder>
//   · 仰角线节点（kind 'elevline'）不是卫星，跳过；两个节点关联同一颗星时只出一行（天线数合计）。
import { SATKEY_NORAD_MAX, grdSatKey, lbSatKey } from '../../packages/core/models/schema.mjs'
import { classifyOrbit, fmtGeoSlot } from '../shared/orbitClass.js'
import { byLang } from '../shared/i18n/lang.js'

const RE = 6378.137, MU = 398600.4418, TWO_PI = 2 * Math.PI
/** 编目分组最多列几条（候选池上万颗，搜索结果截断） */
export const CAT_MAX = 100

// ───────────────────────────── 筛选 ─────────────────────────────

/** 归一：大写，去空白、连字符、下划线、全 / 半角括号（「中星-6E」「CHINASAT 6E」「ChinaSat_6E」同搜） */
export const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/[\s\-_()（）]+/g, '')
/** q 为空恒真；否则任一字段归一后包含 q */
export function matchQ(q, ...xs) {
  const k = norm(q)
  return !k || xs.some((x) => norm(x).includes(k))
}

// ───────────────────────────── 轨道区制 ─────────────────────────────

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v))
/** 平均运动（rev/day）· 偏心率 · 倾角（°）→ 轨道区制（orbitClass.classifyOrbit）；平均运动缺失返回 '' */
export function kindOfMeanMotion(mm, ecc, incl) {
  const n = num(mm)
  if (!(n > 0)) return ''
  const w = n * TWO_PI / 86400
  return classifyOrbit({ aKm: Math.cbrt(MU / (w * w)), e: num(ecc) || 0, inclDeg: num(incl) || 0 })
}
/** 六根数 {altKm, ecc, incl}：altKm 是近地点高度，a = (RE + altKm) / (1 − e)（与 satSources.satrecFromElements 同式） */
export function kindOfElements(el) {
  if (!el || typeof el !== 'object') return ''
  const alt = num(el.altKm)
  if (!Number.isFinite(alt)) return ''
  const e = Math.max(0, Math.min(0.999, num(el.ecc) || 0))
  return classifyOrbit({ aKm: (RE + alt) / (1 - e), e, inclDeg: num(el.incl) || 0 })
}
/** 候选池记录 → 区制（elements 型按六根数，omm 型按平均运动；星历点序列没有根数 → ''） */
export function poolOrbitKind(rec) {
  if (!rec) return ''
  if (rec.orbitType === 'elements' && rec.elements) return kindOfElements(rec.elements) || kindOfMeanMotion(rec.meanMotion, rec.ecc, rec.incl)
  return kindOfMeanMotion(rec.meanMotion, rec.ecc, rec.incl)
}

// ───────────────────────────── 卫星天线树 ─────────────────────────────

const realNorad = (v) => {
  const raw = String(v == null ? '' : v).trim()
  if (!/^\d{1,9}$/.test(raw)) return 0
  const n = Number(raw)
  return n >= 1 && n < SATKEY_NORAD_MAX ? n : 0
}
const poolRowOf = (node, poolByNorad) => (node && node.noradId && poolByNorad && poolByNorad.get ? poolByNorad.get(String(node.noradId).trim()) || null : null)

/** 树节点 → 绑定键（规则见文件头）；仰角线 / 空节点返回 null。poolByNorad：NORAD 字符串 → 池行（satSources.catalogPool().byNorad） */
export function treeKeyOf(node, poolByNorad) {
  if (!node || node.kind === 'elevline') return null
  if (node.noradId) {
    const n = realNorad(node.noradId)
    if (n) return 'norad:' + n
    const p = poolRowOf(node, poolByNorad)
    if (p && p.key) return p.key
    const nm = String(node.satName || '').trim()
    if (nm) return 'name:' + nm
  }
  return grdSatKey(node.folder)
}
/** 树节点的键要不要等候选池：关联的不是目录号（合成号 ≥ 800000 等）——池没好时 treeKeyOf 只能给临时的 name:<星名> */
export function treeKeyNeedsPool(node) {
  return !!(node && node.kind !== 'elevline' && node.noradId && !realNorad(node.noradId))
}
/**
 * 这个绑定键的名字 / hint（poolRec、区制）要不要等候选池：norad / cc / ephem / name 键在池里；
 * grdsat:<folder> 只有该树节点关联了 NORAD（旧键，见 legacyTreeRow）才要；lbsat 与无关联的 grdsat 不要。
 * @param {string} key
 * @param {Array} [nodes] 卫星天线树（satSources.grdTreeSats 的输出；只有 grdsat 键才看）
 */
export function keyNeedsPool(key, nodes) {
  const k = String(key || '')
  if (/^(?:norad|cc|ephem|name):/.test(k)) return true
  const m = /^grdsat:(.+)$/.exec(k)
  return !!m && (nodes || []).some((n) => n && n.kind !== 'elevline' && n.noradId && String(n.folder || '').trim() === m[1])
}
// 树节点的区制：池记录 > 节点 OMM > 六根数 > 定点星（星下点快照：a = RE + 高度、e = 0、倾角 = |纬度|）。
// 关联星（有 NORAD）池还没就绪时不按存盘星下点猜：loadSatTree 给缺高度的节点补 GEO 高度，低轨星会被猜成 GEO
function treeOrbitKind(node, poolRow) {
  if (poolRow) { const k = poolOrbitKind(poolRow.rec); if (k) return k }
  if (node.omm) { const k = kindOfMeanMotion(node.omm.meanMotion, node.omm.ecc, node.omm.incl); if (k) return k }
  if (node.elements) { const k = kindOfElements(node.elements); if (k) return k }
  if (node.noradId) return ''
  const alt = num(node.altKm)
  return Number.isFinite(alt) ? classifyOrbit({ aKm: RE + alt, e: 0, inclDeg: Math.abs(num(node.lat) || 0) }) : ''
}
const antWord = (n) => byLang('副天线', n === 1 ? 'antenna' : 'antennas')

/**
 * 卫星天线树（satSources.grdTreeSats 的输出）→ 行。同键（两个节点关联同一颗星）只留第一条，天线数合计。
 * @param {Array} nodes
 * @param {Map<string, {key, rec, group?}>} [poolByNorad]
 */
export function treeRows(nodes, poolByNorad) {
  const acc = new Map()
  for (const node of nodes || []) {
    const key = treeKeyOf(node, poolByNorad)
    if (!key) continue
    const ants = Array.isArray(node.antennas) ? node.antennas.length : 0
    const a = acc.get(key)
    if (a) { a.ants += ants; if (node.folder) a.folders.push(node.folder); continue }
    acc.set(key, { node, ants, folders: node.folder ? [node.folder] : [] })
  }
  const out = []
  for (const [key, a] of acc) {
    const node = a.node
    const pr = poolRowOf(node, poolByNorad)
    const kind = treeOrbitKind(node, pr)
    const n = realNorad(node.noradId)
    const fixed = !node.noradId && !node.elements && !node.omm
    const bits = []
    if (n) bits.push('NORAD ' + n)
    if (kind) bits.push(kind)
    if (fixed && kind === 'GEO') bits.push(fmtGeoSlot(num(node.lon)))
    else if (!node.noradId) {
      const alt = node.elements ? num(node.elements.altKm) : num(node.altKm)
      if (Number.isFinite(alt)) bits.push(Math.round(alt) + ' km')
    } else if (!n && pr && pr.group) bits.push(pr.group)
    if (a.ants) bits.push(a.ants + ' ' + antWord(a.ants))
    const hint = { treeNode: node, orbitKind: kind }
    if (pr && pr.rec) hint.poolRec = pr.rec
    out.push({ key, name: String(node.satName || node.folder || key), sub: bits.filter(Boolean).join(' · '), src: 'tree', hint, terms: a.folders, folders: a.folders })
  }
  return out
}
// ── 天线树节点改动（3D 页改了根数 / 历元等）：satStore 据此作废轨道缓存、satSources 据此换掉快照 ──

/**
 * 节点的「轨道相关」签名：OMM · 六根数（含 elements.epoch）· 关联号 · 固定星的星下点。
 * 根数星 / 关联星的 lon/lat/altKm 是 grdLive 的实时星位（loadSatTree 叠上来的，播放中一直在变），不进签名。
 */
export function treeOrbitSig(n) {
  if (!n) return ''
  const moving = !!(n.omm || n.elements || n.noradId)
  return JSON.stringify([n.omm || null, n.elements || null, n.noradId || null, moving ? null : [n.lon, n.lat, n.altKm]])
}
/** 树 → Map(folder → 轨道签名)；同 folder 取第一个，没有 folder 的跳过 */
export function treeSigMap(nodes) {
  const m = new Map()
  for (const n of nodes || []) if (n && n.folder != null && !m.has(String(n.folder))) m.set(String(n.folder), treeOrbitSig(n))
  return m
}
/** 两份签名表之间变了的 folder（改了 / 新增 / 删了） */
export function changedFolders(prev, next) {
  const out = new Set()
  const a = prev || new Map(), b = next || new Map()
  for (const [f, s] of b) if (a.get(f) !== s) out.add(f)
  for (const f of a.keys()) if (!b.has(f)) out.add(f)
  return out
}
/** 选星时拿到的节点快照 → 树里现在的同 folder 节点（树里没了用快照） */
export function freshTreeNode(node, nodes) {
  if (!node || node.folder == null) return node
  return (nodes || []).find((s) => s && s.folder === node.folder) || node
}
/**
 * 链路预算库条目是从天线树挑的星（ngsoSat.mode 'tree'）、节点还在、轨道由节点自己定义（六根数 / OMM）→ 该节点；否则 null。
 * 库里存的 ngsoSat.orbit 是挑星那一刻的快照（旧条目还没有历元），这种条目按现在的节点解，3D 页改了根数 / 历元才跟得上。
 */
export function lbTreeNode(e, nodes) {
  const ns = (e && e.ngsoSat) || {}
  if (ns.mode !== 'tree' || ns.folder == null || ns.folder === '') return null
  const n = (nodes || []).find((s) => s && s.folder === ns.folder)
  return n && (n.elements || n.omm) ? n : null
}

// 旧绑定：改键前的选星器把关联合成号（≥ 800000）的树节点记成 grdsat:<folder>（3D 页从来不读这个键）；现在该节点的键是
// cc: / ephem: / name:，旧记录只剩「已绑定」里一行。按 folder 认回现行那一行（名字 / hint 借它；副行仍是键，与现行那行区分）
function legacyTreeRow(key, tree) {
  const m = /^grdsat:(.+)$/.exec(String(key || ''))
  if (!m) return null
  return (tree || []).find((r) => r && r.key !== key && (r.folders || []).some((f) => String(f).trim() === m[1])) || null
}

// ───────────────────────────── 链路预算卫星库 ─────────────────────────────

const lbNsShort = (ns) => ({ geo: 'GEO', ngso: 'NGSO', regen: byLang('再生式', 'Regen'), e2e: byLang('端到端', 'E2E') })[ns] || String(ns || '')
// 库条目的区制：GEO 窗口有定点经度 → GEO；NGSO / 再生式 / 端到端带了轨道 spec 的按它算；其余未知
function lbOrbitKind(e) {
  const f = (e && e.form) || {}
  if (e && e.ns === 'geo' && Number.isFinite(num(f.orbitPosition))) return 'GEO'
  const o = e && e.ngsoSat && e.ngsoSat.orbit
  if (!o || typeof o !== 'object') return ''
  if (o.type === 'elements') return kindOfElements(o)
  if (o.type === 'omm') return kindOfMeanMotion(o.meanMotion, o.ecc, o.incl)
  return ''
}
/** 四窗卫星库条目（satSources.lbLibrarySats 的输出）→ 行 */
export function lbRows(list) {
  const out = [], seen = new Set()
  for (const e of list || []) {
    if (!e) continue
    const key = lbSatKey(e.ns, e.id)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ key, name: String(e.name || e.id), sub: [lbNsShort(e.ns), e.summary].filter(Boolean).join(' · '), src: 'lb', hint: { lbEntry: e, orbitKind: lbOrbitKind(e) }, terms: [e.id] })
  }
  return out
}

// ───────────────────────────── 已绑定 / 编目 ─────────────────────────────

/** satStore.boundList（[{key, label, n}]）→ 行。名字只是键名兜底（keyLabel），合并时从别的来源取真名 */
export function boundRows(list) {
  return (list || []).filter((b) => b && b.key).map((b) => ({ key: b.key, name: String(b.label || b.key), sub: b.key, src: 'bound', hint: null, n: b.n == null ? null : b.n }))
}
/** 候选池命中（satSources.searchPool 的输出：[{rec, key, name, altName, norad, group}]）→ 行 */
export function catalogRows(hits) {
  const out = []
  for (const x of hits || []) {
    if (!x || !x.key) continue
    const kind = poolOrbitKind(x.rec)
    const nn = Number(x.norad)
    out.push({
      key: x.key, name: String(x.name || x.key),
      sub: [x.norad && nn >= 1 && nn < SATKEY_NORAD_MAX ? 'NORAD ' + x.norad : '', kind, x.group].filter(Boolean).join(' · '),
      src: 'cat', hint: { poolRec: x.rec, orbitKind: kind }, terms: [x.altName]
    })
  }
  return out
}

// ───────────────────────────── 合并 ─────────────────────────────

const blank = (v) => v === undefined || v === null || v === ''
/** hint 合并：base 已有（非空）的字段不动，add 只补空缺；什么都没补返回 base 本身（调用方据此判「变没变」） */
export function mergeHint(base, add) {
  if (!add || typeof add !== 'object') return base
  let out = null
  for (const k of Object.keys(add)) {
    if (blank(add[k]) || (base && !blank(base[k]))) continue
    if (!out) out = { ...(base || {}) }
    out[k] = add[k]
  }
  return out || base
}
/** 多条来源行的 hint 并集（靠前的优先） */
export function mergeHints(rows) {
  let h = null
  for (const r of rows || []) if (r && r.hint) h = mergeHint(h, r.hint)
  return h
}

export const GROUPS = Object.freeze([
  { key: 'bound', title: '已绑定' },
  { key: 'tree', title: '卫星天线树' },
  { key: 'lb', title: '链路预算' },
  { key: 'cat', title: '编目' }
])

/**
 * 四路来源 → 分组列表 [{key, title, rows}]。
 *   · 同一个绑定键只出现一次：已绑定 > 卫星天线树 > 链路预算 > 编目；hint 取该键全部来源的并集；
 *   · 已绑定行的名字 / 副行取第一条别的来源（它自己只有「NORAD 25544」这类键名兜底）；旧 grdsat: 键按 folder 借现行树行（legacyTreeRow）；
 *   · 筛选：一个键的任一来源行命中 q 即整键可见（编目行本身就是池搜索的命中），出现在它所属的最靠前分组里；
 *   · 编目分组只在 q 非空时出现；空分组不出；
 *   · 每行带 n：该键在绑定表里的挂点数（没绑定为 null）。
 * @param {{bound?:Array, tree?:Array, lb?:Array, cat?:Array}} src 各自的行（boundRows / treeRows / lbRows / catalogRows）
 * @param {string} q
 */
export function mergeGroups(src, q) {
  const s = src || {}
  const hasQ = !!norm(q)
  const lists = { bound: s.bound || [], tree: s.tree || [], lb: s.lb || [], cat: hasQ ? (s.cat || []) : [] }
  const byKey = new Map()
  for (const g of GROUPS) {
    for (const r of lists[g.key]) {
      if (!r || !r.key) continue
      let a = byKey.get(r.key)
      if (!a) byKey.set(r.key, (a = []))
      a.push(r)
    }
  }
  // 只剩绑定记录的旧 grdsat: 键：借现行树行的名字 / hint（副行留键）
  for (const r of lists.bound) {
    const all = r && r.key ? byKey.get(r.key) : null
    if (!all || all.some((x) => x.src !== 'bound')) continue
    const lg = legacyTreeRow(r.key, lists.tree)
    if (lg) all.push({ ...lg, key: r.key, sub: r.sub, src: 'legacy' })
  }
  const nOf = new Map()
  for (const r of lists.bound) if (r && r.key && !nOf.has(r.key)) nOf.set(r.key, r.n == null ? null : r.n)
  const hit = (r) => r.src === 'cat' || matchQ(q, r.name, r.sub, r.key, ...(r.terms || []))
  const shown = new Set()
  const out = []
  for (const g of GROUPS) {
    const rows = []
    for (const r of lists[g.key]) {
      if (!r || !r.key || shown.has(r.key)) continue
      const all = byKey.get(r.key)
      if (hasQ && !all.some(hit)) continue
      shown.add(r.key)
      const other = g.key === 'bound' ? all.find((x) => x.src !== 'bound') : null
      rows.push({
        key: r.key, name: other ? other.name : r.name, sub: other ? other.sub : r.sub, src: g.key,
        n: nOf.has(r.key) ? nOf.get(r.key) : null, hint: mergeHints(all)
      })
    }
    if (rows.length) out.push({ key: g.key, title: g.title, rows })
  }
  return out
}

/**
 * 绑定键 → {label, hint} | null：选星时没带名字 / hint（3D 页「编辑…」、上次那颗星）的回填。
 * 名字取第一条来源（卫星天线树 > 链路预算 > 编目），hint 取并集；都没有时旧 grdsat: 键按 folder 认树行；都找不到返回 null。
 * 已绑定那一路只有键名兜底，给不出更好的名字，不参与。
 * @param {string} key
 * @param {{tree?:Array, lb?:Array, cat?:Array, poolByKey?:Map<string, object>}} src tree / lb / cat 为行；poolByKey 为池行索引
 */
export function metaForKey(key, src = {}) {
  if (!key) return null
  const rows = []
  for (const list of [src.tree, src.lb, src.cat]) for (const r of list || []) if (r && r.key === key) rows.push(r)
  if (src.poolByKey && typeof src.poolByKey.get === 'function') {
    const p = src.poolByKey.get(key)
    if (p) rows.push(...catalogRows([p]))
  }
  if (!rows.length) { const lg = legacyTreeRow(key, src.tree); if (lg) rows.push(lg) }
  if (!rows.length) return null
  return { label: rows[0].name || '', hint: mergeHints(rows) }
}
