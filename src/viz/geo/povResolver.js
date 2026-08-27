// 主权解算器 —— 底图渲染的单一真相源。
//
// 底图不再是「一份画好的国界」：basemap-*.json 给的是「争议单元级的面」+「每条 arc 两侧是哪两个单元」，
// 国界线、陆地着色、右键点选、国名标注全部由本模块按【归属】实时解算。视角 = 一张归属表。
//
// 归属优先级（★ 最外层是冻结常量，见 frozen.js 的红线）：
//   owner = FROZEN[u] ?? userOverride[u] ?? pov.own[u] ?? baseOwner[u]
// 取值域：<ISO3> 归某国 | 'disputed' 争议 | 'none' 不显示（落到宿主，等于当这块叠加不存在）
//
// 国界派生规则（一遍扫 adj）：
//   任一侧 'disputed' → indefinite（虚线）
//   两侧 owner 不同   → admin0（实线）
//   两侧 owner 相同   → 溶解，不画
//   一侧无邻（海）    → coast
// 再叠一层 basemap 的 lineCls（构建期从 NE 自带线精确对到 arc 上的分类）：已成线的段落若被标成
// loc / indefinite 就按它走 —— 停火线与未定界靠归属推不出来。
// 自带几何的线（loc / claim / 派生表达不出来的 indefinite）按 wv 与视角的 lines.claim 门控。
//
// ★ 代码里任何地方都不许出现 pov.id === 'CN' 这类硬判断来决定画不画某条线 ——
//   唯一判据是 wv 与 lines.claim 的交集。povInvariants.test.mjs 会 grep 本文件与两个渲染器。
import { feature } from 'topojson-client'
import topo10 from '../globe3d/data/basemap-10m.json' with { type: 'json' }
import NAMES from '../globe3d/data/country-names-zh.json' with { type: 'json' }
import { FROZEN, expandOverrides } from './frozen.js'
import { POV_FILES, DEFAULT_POV, POV_SOLID, normMapPov, povTableOf } from './povList.js'
import { onMapPov, bootMapPov } from '../../stores/mapPov.js'

export { DEFAULT_POV }

// 中文名别名（与换源前一致）：这三个的官方长名不适合上图
const ZH_ALIAS = { 156: '中国', 408: '朝鲜', 410: '韩国' }

const state = {
  id: DEFAULT_POV,
  overrides: {},                                   // 单元 id → 归属（UI 的分组键由 frozen.expandOverrides 展开）
  layers: { claim: true, loc: true, indefinite: true }   // 附加线图层总开关
}
const listeners = new Set()
function emit() { for (const fn of [...listeners]) { try { fn() } catch (e) { console.warn('[pov] onChange', e) } } }

export function onPovChange(fn) { listeners.add(fn); return () => listeners.delete(fn) }
export function getPov() { return { id: state.id, overrides: { ...state.overrides }, layers: { ...state.layers } } }
export function povList() { return Object.values(POV_FILES).map((p) => ({ id: p.id, zh: p.name_zh, en: p.name_en })) }
// 生效视角 id：'custom'（以及任何不认识的 id）算作默认视角 —— 与 povTableOf 同一口径，
// 否则自带线的 wv 门控会把「只在中国视角出现」的线在自定义视角下漏掉（南海十段线踩过）。
const effId = () => (POV_FILES[state.id] ? state.id : DEFAULT_POV)

// 设置页那一坨（{ id, overrides(分组键), layers }）→ 解算器状态。分组键在这里展开成逐单元覆写，
// FROZEN 的键在 expandOverrides 与 setPov 两处都会被剔掉（红线不给任何旁路）。
export function applyMapPov(cfg) {
  const c = normMapPov(cfg)
  setPov(c.id, expandOverrides(c.overrides), c.layers)
  return c
}

// 设置视角。id 不在 POV_FILES 里（如 'custom'）＝以中国视角的归属表为底，只在其上叠用户覆写（见 povTableOf）。
export function setPov(id, overrides, layers) {
  let dirty = false
  if (typeof id === 'string' && id !== state.id) { state.id = id; dirty = true }
  if (overrides && typeof overrides === 'object') {
    const next = {}
    for (const [u, v] of Object.entries(overrides)) if (typeof v === 'string' && v && !FROZEN[u]) next[u] = v
    if (JSON.stringify(next) !== JSON.stringify(state.overrides)) { state.overrides = next; dirty = true }
  }
  if (layers && typeof layers === 'object') {
    for (const k of ['claim', 'loc', 'indefinite']) if (typeof layers[k] === 'boolean' && layers[k] !== state.layers[k]) { state.layers[k] = layers[k]; dirty = true }
  }
  if (dirty) emit()
  return dirty
}

// ---------- 底图分档：10m 静态、50m/110m 懒加载（与换源前的加载策略一致） ----------
const polysOf = (g) => !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
function prep(topo) {
  const units = feature(topo, topo.objects.units).features
  const lines = feature(topo, topo.objects.lines).features
  const byU = new Map()
  for (const f of units) byU.set(f.properties.u, f)
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate
  const arcs = topo.arcs.map((a) => {
    let x = 0, y = 0
    return a.map((d) => { x += d[0]; y += d[1]; return [x * sx + tx, y * sy + ty] })
  })
  // 纬度包围盒（点选粗筛，无需解缠即可预计算）
  const lat = units.map((f) => polysOf(f.geometry).map((rings) => {
    let lo = 90, hi = -90
    for (const p of rings[0]) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1] }
    return [lo, hi]
  }))
  return { topo, units, lines, byU, arcs, adj: topo.adj, lineCls: topo.lineCls || {}, lat, meta: topo.meta || {} }
}
const bundles = { '10m': prep(topo10) }
export function hasDetail(d) { return !!bundles[d] }
export async function ensureDetail(detail) {
  if (bundles[detail]) return bundles[detail]
  // 字面量 import() 让 Vite 各自打成独立 chunk（变量路径无法分析、构建后会失效）
  // ★ 动态 import 不许带 with { type: 'json' }：dev 期 Vite 把 .json 转成 JS 模块再吐，
  //   浏览器拿导入属性一核对 MIME 就整个拒掉（"Failed to fetch dynamically imported module"），
  //   于是 50m/110m 两档在开发态一次都加载不上。静态那条不受影响（构建期就被内联掉了）。
  //   ★ 代价：Node 里这行跑不通（Node 导 JSON 必须带属性）。本函数只有两个渲染器在浏览器里调，
  //     单测与构建脚本都只用静态的 10m —— 真要在 Node 里换档，得另走 fs.readFileSync。
  const mod = detail === '110m' ? await import('../globe3d/data/basemap-110m.json') : await import('../globe3d/data/basemap-50m.json')
  bundles[detail] = prep(mod.default || mod)
  return bundles[detail]
}
const B = (d) => bundles[d] || bundles['10m']

// 订阅轻量状态源：设置页改视角 → stores/mapPov 广播 → 这里重算 → 两个渲染器整份重建。
// bootMapPov 把「设置」里存的视角读进来，只读一次；没有 window.api 时静默保持默认。
// 放在解算器里而不是某个页面里：底图由谁先画都一样生效，且只有真要画底图的模块才拉到这条链。
onMapPov((c) => applyMapPov(c))
bootMapPov()


// ---------- 归属 ----------
function rawOwner(u, b) {
  if (FROZEN[u]) return FROZEN[u]                    // ★ 红线：最外层，谁都盖不过
  if (state.overrides[u]) return state.overrides[u]
  const pov = povTableOf(state.id)
  const v = pov && pov.own ? pov.own[u] : null
  if (v) return v
  const f = b.byU.get(u)
  return f ? f.properties.own0 : null
}
// 'none' = 这块争议叠加不显示 → 归属落到宿主（宿主还 'none' 就继续往上，最多 8 层）。
// 没有宿主的单元（基础分区里的国家、以及不在 map_units 里的礁岛）落回 own0 —— 它本来就不是叠加，
// 「不显示」对它没有意义，但绝不能返回 null：那会让它的国界退化成海岸线。
export function ownerOf(u, detail) {
  const b = B(detail)
  let cur = u
  for (let i = 0; i < 8; i++) {
    const o = rawOwner(cur, b)
    if (o !== 'none') return o || null
    const f = b.byU.get(cur)
    if (!f) return null
    if (!f.properties.host) return f.properties.own0 || null
    cur = f.properties.host
  }
  return null
}
export function unitProps(u, detail) { const f = B(detail).byU.get(u); return f ? f.properties : null }
export function iso3n3(detail) { return B(detail).meta.iso3n3 || {} }

// ---------- 面：按归属合并的国家面 → 喂 buildLandMesh / buildBaseGeo ----------
// 返回的 feature 带 { id: 归属(ISO3/单元 id), idx: 取色序号, over: 是否争议叠加 }。
// ★ 数组顺序即绘制顺序：基础单元在前、争议叠加在后 —— 争议面 ⊂ 宿主面，盖上去等于从宿主里挖掉。
export function resolvedFeatures(detail) {
  const b = B(detail)
  const order = [], byOwn = new Map()
  const slot = (own) => {
    let g = byOwn.get(own)
    if (!g) { g = { id: own, idx: order.length, polys: [] }; byOwn.set(own, g); order.push(g) }
    return g
  }
  for (const f of b.units) {
    const p = f.properties
    if (p.dispute) continue
    const own = ownerOf(p.u, detail) || p.u
    const g = slot(own)
    for (const rings of polysOf(f.geometry)) g.polys.push(rings)
  }
  const out = order.map((g) => ({ id: g.id, idx: g.idx, geometry: geomOf(g.polys) }))
  for (const f of b.units) {
    const p = f.properties
    if (!p.dispute) continue
    const own = ownerOf(p.u, detail)
    if (own === 'none' || own === null) continue
    const hostOwn = p.host ? ownerOf(p.host, detail) : null
    let paint = own
    if (own === 'disputed') {
      // 争议归属不重新着色：宿主的颜色透上来，靠 indefinite 虚线表达争议。
      // 没有宿主的（不在 map_units 里的礁岛）必须自己画，否则整块地不见了。
      if (p.host) continue
      paint = p.own0 && p.own0 !== 'disputed' ? p.own0 : p.u
    }
    if (p.host && paint === hostOwn) continue      // 与宿主同色 → 盖了也白盖
    const g = byOwn.get(paint)
    out.push({ id: paint, idx: g ? g.idx : slot(paint).idx, over: true, geometry: geomOf(polysOf(f.geometry)) })
  }
  return out
}
const geomOf = (polys) => polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys }

// 一条折线是否落在某国境内：沿线等距取至多 8 个点问 ownerAt。界线本就压在两国交界上，
// 逐点判会两边都命中 —— 命中一次即算数（调用方要的就是「这条线跟这个国家有关」）。
function touchesOwner(coords, iso, detail) {
  const n = coords.length
  if (!n) return false
  const step = Math.max(1, Math.floor(n / 8))
  for (let i = 0; i < n; i += step) {
    const h = ownerAt(coords[i][0], coords[i][1], detail)
    if (h && h.owner === iso) return true
  }
  return false
}

// ---------- 线：五组 ----------
// 每组为「折线数组」，折线是 [[lon,lat], …]。相邻不同类的线共享同一个 arc 端点，接头天然严丝合缝。
export function resolvedLines(detail) {
  const b = B(detail)
  const solidIso = POV_SOLID[effId()] || null
  const out = { coast: [], admin0: [], indefinite: [], loc: [], claim: [] }
  for (const k in b.adj) {
    const pair = b.adj[k]
    const oa = pair[0] ? ownerOf(pair[0], detail) : null
    const ob = pair[1] ? ownerOf(pair[1], detail) : null
    if (!oa && !ob) continue
    let cls
    if (!oa || !ob) cls = 'coast'
    else if (oa === 'disputed' || ob === 'disputed') cls = 'indefinite'
    else if (oa !== ob) cls = 'admin0'
    else continue                                   // 两侧同属 → 溶解
    // 自带线给出的分类顶替派生分类：停火线(loc)/未定界(indefinite) 是「两侧 owner 不同」这条规则
    // 表达不出来的，构建期已把这些自带线与派生 arc 精确对上并记进 lineCls，此处只对已成线的那些生效
    // （溶解掉的段落不复活 —— 一个国家内部不该有停火线）。海岸线不受影响。
    if (cls !== 'coast' && b.lineCls[k]) cls = b.lineCls[k]
    // ★ 本视角声明「这个国家的国境一律实线」时，凡有一侧是它的未定界一律升格成国界（见 POV_SOLID）
    if (cls === 'indefinite' && solidIso && (oa === solidIso || ob === solidIso)) cls = 'admin0'
    out[cls].push(b.arcs[+k])
  }
  const pov = povTableOf(state.id)
  const claimOn = new Set((pov && pov.lines && pov.lines.claim) || [])
  for (const f of b.lines) {
    const p = f.properties
    if (Array.isArray(p.wv) && !p.wv.includes(effId())) continue           // 适用视角门控
    if (p.cls === 'claim' && !(p.id && claimOn.has(p.id))) continue        // 主张线：本视角声明了才画
    const g = f.geometry
    const cs = g.type === 'LineString' ? [g.coordinates] : g.coordinates
    // 自带的未定界线只有几条（藏南 / 南千岛 / 刻赤 / 温哥华岛一带），它们不是派生 arc，
    // 上面那条「升格成国界」的规则管不到 —— 这里按落点判：线上任一采样点归属是 solidIso 就整条不画。
    // ★ 判据必须是【归属】不是【经纬度盒子】：藏南在中国视角下属中国、在印度视角下属印度，
    //   同一条线在两套视角下的去留正好相反，用盒子写死就错了。
    if (solidIso && p.cls === 'indefinite' && cs.some((c) => touchesOwner(c, solidIso, detail))) continue
    for (const c of cs) out[p.cls].push(c)
  }
  for (const k of ['claim', 'loc', 'indefinite']) if (!state.layers[k]) out[k] = []
  return out
}

// ---------- 点选 ----------
// 经度差 → (-180, 180] 内的最短夹角（带符号）
const dlon = (l, ref) => ((l - ref + 540) % 360 + 360) % 360 - 180
// 多边形（外环+洞）偶奇判定：环上各点先转成以 ref 为锚点的「连续展开」本地 x —— 逐点用与上一点的
// 最短夹角累加，而非各自独立对 ref 取模。独立取模时，测试点的对跖经线正好穿过该国国土（如堪萨斯↔中国西部）
// 会把环切成跳变的两段，射线交叉数算错、误判成毫不相关的国家。
function hitPolygon(rings, lon, lat) {
  let inside = false
  for (const ring of rings) {
    const n = ring.length
    const xs = new Array(n)
    xs[0] = dlon(ring[0][0], lon)
    for (let k = 1; k < n; k++) xs[k] = xs[k - 1] + dlon(ring[k][0], ring[k - 1][0])
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = ring[i][1], yj = ring[j][1]
      if ((yi > lat) === (yj > lat)) continue
      if (xs[i] + (lat - yi) / (yj - yi) * (xs[j] - xs[i]) > 0) inside = !inside
    }
  }
  return inside
}
// 经纬度 → { u, owner, n3, zh, en }；不在任何单元内返回 null。
// 先扫争议单元（更小更具体，与「盖在上面」的绘制顺序一致），再扫基础单元。
export function ownerAt(lon, lat, detail) {
  const b = B(detail)
  if (lat <= -85) return pack('ATA', 'ATA', b)      // 南极数据止于约 −85°，极冠直接判南极洲
  for (const pass of [true, false]) {
    for (let i = 0; i < b.units.length; i++) {
      const f = b.units[i], p = f.properties
      if (!!p.dispute !== pass) continue
      const own = ownerOf(p.u, detail)
      if (!own || own === 'none') continue
      const polys = polysOf(f.geometry), bounds = b.lat[i]
      for (let k = 0; k < polys.length; k++) {
        const bb = bounds[k]
        if (lat < bb[0] || lat > bb[1]) continue
        if (hitPolygon(polys[k], lon, lat)) return pack(own, p.u, b)
      }
    }
  }
  return null
}
function pack(own, u, b) {
  const n3 = (b.meta.iso3n3 || {})[own] || null
  return { u, owner: own, n3, zh: zhOf(n3), en: (b.meta.iso3name || {})[own] || own }
}
function zhOf(n3) {
  if (!n3) return null
  if (ZH_ALIAS[+n3]) return ZH_ALIAS[+n3]
  const rec = NAMES[n3]
  return rec ? rec[0] : null
}

// ---------- 国名标注 ----------
// 返回 [{ owner, n3, zh, en, name, lon, lat, ext }]，ext = 国家「视觉大小」（最大环包围盒线度，按纬度余弦修正），
// 两个渲染器各自把 ext 映射成自己的字号（3D 用世界高度、2D 用像素），映射式子与换源前一字不改。
export function labelSet(lang, detail) {
  const b = B(detail)
  const pov = povTableOf(state.id)
  const hide = new Set((pov && pov.labels && pov.labels.hide) || [])
  const names = (pov && pov.names) || {}
  const acc = new Map()
  for (const f of b.units) {
    const p = f.properties
    if (p.dispute || hide.has(p.u)) continue
    const own = ownerOf(p.u, detail)
    if (!own || own === 'disputed' || own === 'none' || hide.has(own)) continue
    let a = acc.get(own)
    if (!a) acc.set(own, a = { best: null, bl: -1 })
    for (const rings of polysOf(f.geometry)) { const r = rings[0]; if (r && r.length > a.bl) { a.bl = r.length; a.best = r } }
  }
  const out = []
  for (const [own, a] of acc) {
    const n3 = (b.meta.iso3n3 || {})[own] || null
    const zh = names[own] || zhOf(n3)
    if (!zh) continue                                // 仅标注有中文名的国家（中/英两套用同一集合与位置）
    const rec = n3 ? NAMES[n3] : null
    let lon = rec && rec[1] != null ? rec[1] : null
    let lat = rec && rec[2] != null ? rec[2] : null
    if (lon == null || lat == null) { const c = centroid(a.best); if (!c) continue; lon = c[0]; lat = c[1] }
    const en = (b.meta.iso3name || {})[own] || zh
    out.push({ owner: own, n3, zh, en, name: lang === 'en' ? en : zh, lon, lat, ext: extentOf(a.best) })
  }
  return out
}
function centroid(ring) {
  if (!ring || !ring.length) return null
  let sx = 0, sy = 0
  for (const p of ring) { sx += p[0]; sy += p[1] }
  return [sx / ring.length, sy / ring.length]
}
function extentOf(ring) {
  if (!ring) return 0
  let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90
  for (const p of ring) { if (p[0] < minLon) minLon = p[0]; if (p[0] > maxLon) maxLon = p[0]; if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1] }
  const cl = Math.max(Math.cos((minLat + maxLat) / 2 * Math.PI / 180), 0.1)
  return Math.sqrt((maxLon - minLon) * cl * (maxLat - minLat))
}
