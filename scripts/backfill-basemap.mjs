// 底图精度档的「单元回填」—— 把 10m 有、粗档没有的单元，原样搬进 basemap-50m.json / basemap-110m.json。
//
// 为什么要这一步：三档底图各自从 Natural Earth 的同名图层构建，而 NE 在粗档上会整块整块地删东西 ——
//   · 50m 的 admin_0_map_units 里没有南沙群岛(PGA)、西沙群岛(PFA)、黄岩岛(SCR)、克利珀顿(CLP)、
//     珊瑚海群岛(CSI)、美国本土外小岛屿(UMI 的九个环礁)、直布罗陀(GIB)…
//   · 50m 的争议面图层是 breakaway_disputed_areas，只有 25 个面，10m 的 disputed_areas 有 72 个 ——
//     钓鱼岛(JP-SEN)、独岛(KR-DOK)、中不争议区、哈拉伊卜、埃塞奎博全都不在。
//   后果是【同一套视角表在不同画质档下算出不同的疆域】：中国视角的归属表在 50m 有 13 条落空，
//   十段线照画、线里的岛没了。这是精度档不该带来的差异 —— 精度档只该影响海岸线的细腻程度。
//
// 做法（不动运行时架构，只补数据）：
//   1. 逐个缺失单元取内点，问【目标档】这个点落在哪个单元里 → 宿主 H（落在海里则无宿主）。
//   2. 只是同一块地的更细拆分的（10m 把挪威拆成本土+扬马延+斯瓦尔巴、伊拉克拆出库尔德斯坦…，
//      粗档用的是合并单元）跳过 —— 判据：非争议单元且与 H 的 own0 相同。搬进去只会与 H 完全重叠。
//   3. 其余原样搬入：几何按目标档的 transform 重新量化，arc 拓扑在【同批搬入的单元之间】保留
//      （藏南那五块彼此的公共边不会被画两遍），与目标档已有单元之间无共享 —— 本来也没有。
//   4. adj 两侧：另一侧若是同批搬入的单元就照抄；否则落到宿主 H；无宿主则留空（＝海岸线）。
//      钓鱼岛这类「10m 里与日本本体几何重复、粗档上压根没有的小岛」由此正确地拿到一圈海岸线。
//   5. 落在别人境内的（直布罗陀、关塔那摩、拜科努尔…）一律标成 dispute+host 的【叠加】：
//      争议叠加是「盖在宿主上面画」的，天然不需要对宿主做布尔差，也不会被宿主的面盖住。
//
// ★ 几何精度：搬进来的单元是 10m 精度，比周围的粗档海岸线细。它们都是极小的岛礁/飞地，
//   与粗档单元的接缝只出现在「叠加面与宿主边界重合」的那几处（埃塞奎博、哈拉伊卜），
//   错位量 ≤ 粗档的抽稀阈值，放到最大倍才看得出来。归属正确 > 边缘严丝合缝。
//
// 用法：node scripts/backfill-basemap.mjs [50m|110m …]（缺省 50m）。纯离线，只读 basemap-10m.json。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { polysOf, inRings, ringArea, interiorPoint } from './lib/geomUtil.mjs'
import { normOwner } from '../src/viz/geo/povList.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'src', 'viz', 'globe3d', 'data')
const rd = (s) => JSON.parse(fs.readFileSync(path.join(DIR, 'basemap-' + s + '.json'), 'utf8'))

// topojson 的 arcs 是「按 transform 量化后的 delta 整数」，解出经纬度 / 编回整数各一支
function decodeArcs(topo) {
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate
  return topo.arcs.map((a) => {
    let x = 0, y = 0
    return a.map((d) => { x += d[0]; y += d[1]; return [x * sx + tx, y * sy + ty] })
  })
}
function encodeArc(pts, transform) {
  const [sx, sy] = transform.scale, [tx, ty] = transform.translate
  let px = 0, py = 0
  const out = []
  for (const p of pts) {
    const x = Math.round((p[0] - tx) / sx), y = Math.round((p[1] - ty) / sy)
    out.push([x - px, y - py]); px = x; py = y
  }
  return out
}
// 几何里出现的所有 arc 序号（去负号）
function arcIdx(g, out = new Set()) {
  const w = (a) => { if (!a.length) return; if (Array.isArray(a[0])) return a.forEach(w); for (const i of a) out.add(i < 0 ? ~i : i) }
  w(g.arcs || [])
  return out
}
// 按 map 重写几何里的 arc 序号（保留正负向）
function remapArcs(arcs, map) {
  const w = (a) => (!a.length ? a : Array.isArray(a[0]) ? a.map(w) : a.map((i) => (i < 0 ? ~map.get(~i) : map.get(i))))
  return w(arcs)
}

function backfill(scale) {
  const S = rd('10m'), T = rd(scale)
  // ★ 原地改写，不幂等：重复跑会把同一批单元搬第二遍。回填过就拒绝，还原用 git checkout 那个 json。
  if (T.meta && T.meta.backfilled) {
    console.log('\n=== ' + scale + ' ===\n  已经回填过（meta.backfilled 在场，' + T.meta.backfilled.units.length + ' 个单元）。' +
      '要重跑请先 git checkout src/viz/globe3d/data/basemap-' + scale + '.json')
    return
  }
  const sGeo = S.objects.units.geometries, tGeo = T.objects.units.geometries
  const have = new Set(tGeo.map((g) => g.properties.u))
  const missIdx = []
  sGeo.forEach((g, i) => { if (!have.has(g.properties.u)) missIdx.push(i) })
  console.log('\n=== ' + scale + ' ===')
  console.log('  目标档单元 ' + tGeo.length + ' 个 · 10m 有而它没有的 ' + missIdx.length + ' 个')

  // ---- 目标档的面（用于内点归宿判定）----
  const tArcs = decodeArcs(T)
  const geomOf = (g) => {
    const rebuild = (a) => a.map((i) => { const r = tArcs[i < 0 ? ~i : i]; return i < 0 ? [...r].reverse() : r })
    const ring = (list) => { const parts = rebuild(list); const out = []; for (const p of parts) for (let k = out.length ? 1 : 0; k < p.length; k++) out.push(p[k]); return out }
    if (g.type === 'Polygon') return { type: 'Polygon', coordinates: g.arcs.map(ring) }
    if (g.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: g.arcs.map((poly) => poly.map(ring)) }
    return null
  }
  const tShapes = tGeo.map((g) => ({ p: g.properties, polys: polysOf(geomOf(g)) }))
  // 点 → 目标档里包含它的【最小】单元（嵌套时取更具体的那个）
  const hostAt = (x, y) => {
    let best = null, bestA = Infinity
    for (const s of tShapes) for (const rings of s.polys) {
      if (!inRings(rings, x, y)) continue
      const a = ringArea(rings[0])
      if (a < bestA) { bestA = a; best = s.p }
    }
    return best
  }

  // ---- 逐个判定：跳过 / 搬入 ----
  const sArcs = decodeArcs(S)
  const take = [], skip = []
  for (const i of missIdx) {
    const g = sGeo[i], p = g.properties
    const pt = interiorPoint(srcGeom(sArcs, g), Number.NaN, Number.NaN)
    const H = pt ? hostAt(pt[0], pt[1]) : null
    // 只是同一块地的更细拆分（10m 的 map subunit vs 粗档的合并单元）：搬进去只会完全重叠
    if (!p.dispute && H && normOwner(H.own0) === normOwner(p.own0)) { skip.push(p.u + '→' + H.u); continue }
    take.push({ i, p, host: H ? H.u : null })
  }
  console.log('  跳过（粗档已用合并单元表达）' + skip.length + ' 个：' + (skip.join(' ') || '—'))
  console.log('  搬入 ' + take.length + ' 个：' + take.map((t) => t.p.u + (t.host ? '@' + t.host : '')).join(' '))
  if (!take.length) { console.log('  无事可做'); return }

  // ---- arc 池：同批搬入的单元之间保留共享 ----
  const need = new Set()
  for (const t of take) arcIdx(sGeo[t.i], need)
  const map = new Map()
  for (const a of [...need].sort((x, y) => x - y)) { map.set(a, T.arcs.length); T.arcs.push(encodeArc(sArcs[a], T.transform)) }

  // ---- 单元 ----
  const takenU = new Set(take.map((t) => t.p.u))
  for (const t of take) {
    const src = sGeo[t.i]
    const props = { ...src.properties }
    if (t.host) { props.dispute = true; props.host = t.host }   // 落在别人境内 → 当叠加画（盖在宿主上，不需布尔差）
    else { delete props.host }                                  // 落在海里 → 独立单元，无宿主
    tGeo.push({ type: src.type, arcs: remapArcs(src.arcs, map), properties: props })
  }
  // ---- adj：另一侧同批搬入就照抄，否则落到宿主，无宿主则留空（海岸线）----
  const hostOf = new Map(take.map((t) => [t.p.u, t.host]))
  for (const t of take) {
    for (const a of arcIdx(sGeo[t.i])) {
      const na = map.get(a)
      const pair = (S.adj[a] || [null, null]).map((s) => (s && (takenU.has(s) || have.has(s)) ? s : null))
      // 10m 里的另一侧若在粗档不存在（如钓鱼岛与日本本体共享的那几段，粗档根本没有这些小岛）→ 落宿主
      const self = pair.indexOf(t.p.u)
      if (self >= 0 && pair[1 - self] == null) pair[1 - self] = hostOf.get(t.p.u) || null
      T.adj[na] = pair
    }
  }
  // ---- 英文名补表 ----
  T.meta.iso3name = T.meta.iso3name || {}
  let addName = 0
  for (const t of take) {
    const own = normOwner(t.p.own0)
    if (own && own !== 'disputed' && !T.meta.iso3name[own]) { T.meta.iso3name[own] = (S.meta.iso3name || {})[own] || t.p.name_en || own; addName++ }
  }
  T.meta.backfilled = { from: '10m', units: take.map((t) => t.p.u), note: '见 scripts/backfill-basemap.mjs：粗档缺失的岛礁/飞地/争议面按 10m 原样补入，使各精度档的归属口径一致' }

  const f = path.join(DIR, 'basemap-' + scale + '.json')
  const before = fs.statSync(f).size
  fs.writeFileSync(f, JSON.stringify(T))
  const after = fs.statSync(f).size
  console.log('  arcs ' + (T.arcs.length - map.size) + ' → ' + T.arcs.length + ' · units → ' + tGeo.length +
    ' · 补英文名 ' + addName + ' 条 · ' + (before / 1e6).toFixed(2) + ' → ' + (after / 1e6).toFixed(2) + ' MB')
}
// 源单元 → GeoJSON 几何（只为取内点）
function srcGeom(sArcs, g) {
  const rebuild = (a) => a.map((i) => { const r = sArcs[i < 0 ? ~i : i]; return i < 0 ? [...r].reverse() : r })
  const ring = (list) => { const parts = rebuild(list); const out = []; for (const p of parts) for (let k = out.length ? 1 : 0; k < p.length; k++) out.push(p[k]); return out }
  if (g.type === 'Polygon') return { type: 'Polygon', coordinates: g.arcs.map(ring) }
  return { type: 'MultiPolygon', coordinates: g.arcs.map((poly) => poly.map(ring)) }
}

const want = process.argv.slice(2).filter((a) => /^(50m|110m)$/.test(a))
for (const s of (want.length ? want : ['50m'])) backfill(s)
