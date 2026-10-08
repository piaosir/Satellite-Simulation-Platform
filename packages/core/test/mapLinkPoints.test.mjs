// 图上链路 · Polygon / 航迹端点的代表点（packages/core/models/mapLinkPoints.mjs）+ 支路展开（mapLinks.linkStrands）。
//
// 关键不变式：
//   ① Polygon 质心 = 球面面积质心：对称形对称、跨 ±180° 不跑到 0° 经线、高纬带比经纬平面质心偏赤道；凹形落区外改取区内点（moved）；
//   ② 边界等分：N 点、第一点 = 顶点 1、相邻弧长相等、点都在边上（经纬度线性的边，与画法一致）；
//   ③ 取舍：离散族 'all' ⇄ 数组 ⇄ 去掉 三态往返，取满回 'all'；等分族 ds 取满回到缺省；改点数作废逐点取舍；
//   ④ 航迹：航点按 id 认（插航点不串位）、载具随时刻走、沿迹等分含两端、飞行有高度；缺省取点按运动档 / 航点数分；
//   ⑤ 链路：Polygon / 航迹是地面端（站接站规则照旧）；删了 / 没取点 / 取超 64 个 = 无效；支路 = 各多点节点点数之积，
//      展开序前慢后快、名字带支路名、航迹点带 altM；超 512 条不导入。
import {
  pgRing, pgCentroid, pgContains, pgAreaKm2, pgBoundaryDiv, pgCands, tjCands, nodePoints, pickCount,
  pickToggle, pickFamily, pickSetDiv, pickFamStat, defaultPick, normPick, wrapLon, PICK_MAX, TJ_ALL_MAX, DIV_DEF
} from '../models/mapLinkPoints.mjs'
import {
  linkIssues, linkValid, linkTargets, targetReason, linkStrandCount, linkStrands, normNode, sanitizeLinks, reverseLink, hopKind, slotIssue, isAreaNode, STRANDS_MAX
} from '../models/mapLinks.mjs'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
}
const near = (a, b, tol) => Math.abs(a - b) <= tol
const D2R = Math.PI / 180
function arcDeg(a, b) {
  const p1 = a.lat * D2R, p2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R
  return Math.acos(Math.max(-1, Math.min(1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl)))) / D2R
}

// ---- ① 环与质心 ----
const sq = [[100, 20], [110, 20], [110, 30], [100, 30]]
ok('pgRing：去闭合点', pgRing([...sq, [100, 20]]).length === 4)
ok('pgRing：去相邻重复', pgRing([[100, 20], [100, 20], [110, 20], [110, 30]]).length === 3)
ok('pgRing：不足三点 → []', pgRing([[1, 2], [3, 4]]).length === 0)
const cSq = pgCentroid(pgRing(sq))
ok('正方形质心经度在中线', near(cSq.lon, 105, 1e-9), String(cSq.lon))
ok('正方形质心纬度略偏赤道（球面面积加权）', cSq.lat < 25 && cSq.lat > 24.8, String(cSq.lat))
ok('正方形质心在区内、未挪', pgContains(pgRing(sq), cSq.lat, cSq.lon) && cSq.moved === false)
const band = [[0, 50], [40, 50], [40, 80], [0, 80]]
const cBand = pgCentroid(pgRing(band))
ok('高纬带：球面质心比经纬平面质心（65°）偏赤道', cBand.lat < 65 && cBand.lat > 60, String(cBand.lat))
const am = [[170, -10], [-170, -10], [-170, 10], [170, 10]]   // 跨 ±180°
const cAm = pgCentroid(pgRing(am))
ok('跨 ±180°：质心在 180° 附近（不跑到 0°）', Math.abs(Math.abs(cAm.lon) - 180) < 1e-6 && near(cAm.lat, 0, 1e-9), JSON.stringify(cAm))
ok('跨 ±180°：区内判定', pgContains(pgRing(am), 0, 179.5) && pgContains(pgRing(am), 5, -175) && !pgContains(pgRing(am), 0, 160))
// 反向绕的同一个正方形：质心不变
const cRev = pgCentroid(pgRing(sq.slice().reverse()))
ok('绕向无关', near(cRev.lat, cSq.lat, 1e-9) && near(cRev.lon, cSq.lon, 1e-9))
// 凹的 C 形：面积质心落在缺口里 → 改取区内点
const cShape = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 8], [10, 8], [10, 10], [0, 10]]
const rC = pgRing(cShape), cC = pgCentroid(rC)
ok('C 形：质心挪到区内', cC.moved === true && pgContains(rC, cC.lat, cC.lon), JSON.stringify(cC))
ok('C 形：区内点落在竖臂（经度 < 2）', cC.lon < 2 && cC.lon > 0, String(cC.lon))
ok('面积：大的大', pgAreaKm2(pgRing(band)) > pgAreaKm2(pgRing(sq)))
ok('wrapLon', wrapLon(190) === -170 && wrapLon(-180) === 180 && wrapLon(45) === 45)

// ---- ② 边界等分 ----
const div8 = pgBoundaryDiv(pgRing(sq), 8)
ok('边界等分 8 点', div8.length === 8)
ok('第一点 = 顶点 1', near(div8[0].lat, 20, 1e-9) && near(div8[0].lon, 100, 1e-9))
{
  const r = pgRing(sq), segs = []
  for (let i = 0; i < 8; i++) {
    // 相邻两点沿边界的弧长：用加密折线量（等分点之间可能跨顶点）
    const a = div8[i], b = div8[(i + 1) % 8]
    segs.push({ a, b })
  }
  // 点在边上：到四条边（经纬度线性）的距离 ~0
  const onEdge = (p) => near(p.lat, 20, 1e-6) || near(p.lat, 30, 1e-6) || near(p.lon, 100, 1e-6) || near(p.lon, 110, 1e-6)
  ok('等分点都在边上', div8.every(onEdge), JSON.stringify(div8))
  ok('等分点都在区边界（不在区内深处）', div8.every((p) => !pgContains(r, p.lat + (p.lat < 25 ? 0.5 : -0.5), p.lon) || onEdge(p)))
}
{
  // 弧长相等：在加密的边界上量累计弧长差
  const ring = pgRing(sq), pts = []
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; for (let k = 0; k < 400; k++) pts.push({ lat: a.lat + (b.lat - a.lat) * k / 400, lon: a.lon + (b.lon - a.lon) * k / 400 }) }
  const cum = [0]
  for (let i = 1; i <= pts.length; i++) cum.push(cum[i - 1] + arcDeg(pts[i - 1], pts[i % pts.length]))
  const sAt = (p) => { let best = 0, bd = Infinity; pts.forEach((q, i) => { const d = arcDeg(p, q); if (d < bd) { bd = d; best = cum[i] } }); return best }
  const s = div8.map(sAt), tot = cum[cum.length - 1]
  const gaps = s.map((v, i) => ((i + 1 < s.length ? s[i + 1] : tot) - v))
  ok('相邻等分点弧长相等（≤ 0.5%）', gaps.every((g) => Math.abs(g - tot / 8) <= tot / 8 * 0.005), JSON.stringify(gaps.map((g) => g.toFixed(4))))
}

// ---- ③ Polygon 取点与取舍 ----
const PG = { id: 'pg1', name: '华东区', pts: sq }
ok('缺省取点 = 质心', JSON.stringify(defaultPick('pg', PG)) === '{"c":true}')
ok('缺省：一个点', nodePoints('pg', PG, null, 0).length === 1 && nodePoints('pg', PG, null, 0)[0].key === 'c')
let pk = pickFamily('pg', PG, { c: true }, 'v', true)
ok('取顶点族 → all', pk.v === 'all' && pickCount('pg', PG, pk) === 5)
pk = pickToggle('pg', PG, pk, 'v1')
ok('舍一个顶点 → 数组', Array.isArray(pk.v) && pk.v.join() === '0,2,3' && pickCount('pg', PG, pk) === 4)
pk = pickToggle('pg', PG, pk, 'v1')
ok('取回来 → all', pk.v === 'all')
pk = pickToggle('pg', PG, { v: [2] }, 'v2')
ok('舍空 → 整族去掉', !('v' in pk) && pickCount('pg', PG, pk) === 0)
pk = pickToggle('pg', PG, { c: true }, 'c')
ok('质心翻转', !pk.c && pickCount('pg', PG, pk) === 0)
pk = pickFamily('pg', PG, {}, 'd', true)
ok('取等分族缺省 8 点', pk.d === DIV_DEF && pickCount('pg', PG, pk) === 8)
pk = pickToggle('pg', PG, pk, 'd3')
ok('舍一个等分点 → ds', Array.isArray(pk.ds) && pk.ds.length === 7 && !pk.ds.includes(3))
pk = pickSetDiv('pg', PG, pk, 12)
ok('改点数：ds 作废、全取', pk.d === 12 && !('ds' in pk) && pickCount('pg', PG, pk) === 12)
ok('点数夹到上限', pickSetDiv('pg', PG, {}, 999).d === 64 && pickSetDiv('pg', PG, {}, 1).d === 2)
{
  const cs = pgCands(PG, { c: true, v: [0, 2] })
  ok('候选点：质心 + 全部顶点（等分没取就不列）', cs.length === 5 && cs.filter((c) => c.sel).map((c) => c.key).join() === 'c,v0,v2')
  const st = pickFamStat('pg', PG, { v: [0, 2] }, 'v')
  ok('族统计 2/4', st.on && st.k === 2 && st.n === 4)
}
ok('下标越界的顶点不计数', pickCount('pg', PG, { v: [0, 9] }) === 1)
ok('normPick 清坏字段', JSON.stringify(normPick('pg', { c: 1, v: [3, 3, -1, 'x', 1], d: 99, ds: [1, 99], zz: 1 })) === '{"v":[1,3],"d":64,"ds":[1]}')
ok('normPick 非对象 → null', normPick('pg', null) === null && normPick('pg', [1]) === null)

// ---- ④ 航迹 ----
const T0 = Date.UTC(2026, 9, 8, 0, 0, 0)
const sea = { id: 't1', name: '航行1', kind: 'sea', pts: [{ id: 'a', lat: 30, lon: 122 }, { id: 'b', lat: 20, lon: 115 }, { id: 'c', lat: 1.3, lon: 103.8 }] }
const seaMov = { ...sea, id: 't2', t0Ms: T0, speedKmh: 30 }
ok('缺省：静止档少航点 → 全部航点', JSON.stringify(defaultPick('tj', sea)) === '{"w":"all"}')
ok('缺省：运动档 → 载具', JSON.stringify(defaultPick('tj', seaMov)) === '{"veh":true}')
const many = { id: 't3', kind: 'sea', pts: Array.from({ length: TJ_ALL_MAX + 1 }, (_, i) => ({ id: 'p' + i, lat: i * 0.5, lon: 120 })) }
ok('缺省：静止档航点多 → 沿迹等分 8', JSON.stringify(defaultPick('tj', many)) === '{"d":8}')
{
  const cs = tjCands(sea, { w: 'all' }, T0)
  ok('航迹候选：载具 + 3 航点', cs.length === 4 && cs[0].key === 'veh' && cs.slice(1).map((c) => c.key).join() === 'w:a,w:b,w:c')
  ok('静止档载具在航迹头', near(cs[0].lat, 1.3, 1e-9) && near(cs[0].lon, 103.8, 1e-9))
  ok('航行高度 0', cs.every((c) => c.altM === 0))
}
{
  let p = pickToggle('tj', sea, { w: 'all' }, 'w:b')
  ok('舍航点 b → [a, c]', Array.isArray(p.w) && p.w.join() === 'a,c')
  // 在 a、b 之间插一个航点：按 id 认，选择不串位
  const sea2 = { ...sea, pts: [sea.pts[0], { id: 'x', lat: 25, lon: 119 }, sea.pts[1], sea.pts[2]] }
  const sel = tjCands(sea2, p, T0).filter((c) => c.sel).map((c) => c.key)
  ok('插航点后仍取 a、c', sel.join() === 'w:a,w:c', sel.join())
  p = pickToggle('tj', sea, p, 'w:b')
  ok('取满回 all', p.w === 'all')
}
{
  const mid = T0 + 3600e3 * 30   // 出发后 30 h
  const v = tjCands(seaMov, { veh: true }, mid).find((c) => c.key === 'veh')
  const s = v.sM
  ok('运动档载具随时刻：走了 30 km/h × 30 h ≈ 900 km', near(s, 900e3, 1), String(s))
  const v0 = tjCands(seaMov, { veh: true }, T0 - 3600e3).find((c) => c.key === 'veh')
  ok('出发前载具在起点', near(v0.lat, 30, 1e-9) && near(v0.lon, 122, 1e-9))
}
{
  const cs = tjCands(seaMov, { d: 5 }, T0).filter((c) => c.fam === 'd')
  ok('沿迹等分 5 点含两端', cs.length === 5 && near(cs[0].lat, 30, 1e-9) && near(cs[4].lat, 1.3, 1e-9))
  ok('沿迹等分里程等差', cs.every((c, i) => near(c.sM, cs[4].sM * i / 4, 1e-6)))
  ok('沿迹等分时刻随里程（匀速）', cs.every((c) => near(c.tMs, T0 + c.sM / (30 / 3.6) * 1000, 1)))
}
{
  const fl = { id: 'f1', name: '飞行1', kind: 'flight', pts: [{ id: 'p', lat: 40, lon: 116 }, { id: 'q', lat: 31, lon: 121 }], t0Ms: T0, speedKmh: 800 }
  const cs = tjCands(fl, { w: 'all', d: 3 }, T0 + 3600e3 * 0.75)
  const veh = cs.find((c) => c.key === 'veh'), w = cs.filter((c) => c.fam === 'w'), d = cs.filter((c) => c.fam === 'd')
  ok('飞行：起降航点高度 0', w.every((c) => c.altM === 0))
  ok('飞行：途中等分点有巡航高度', d[1].altM > 9000, String(d[1].altM))
  ok('飞行：载具有高度', veh.altM > 0, String(veh.altM))
}
ok('航迹删光有效航点：0 个点', pickCount('tj', { pts: [{ lat: NaN, lon: 1 }] }, { veh: true, w: 'all' }) === 0)
ok('normPick 航迹', JSON.stringify(normPick('tj', { veh: true, w: ['a', 'a', 3, ''], d: 3 })) === '{"veh":true,"w":["a","3"],"d":3}')

// ---- ⑤ 链路 ----
const ST = (id) => ({ k: 'st', id })
const PGN = (id, pick) => ({ k: 'pg', id, ...(pick ? { pick } : {}) })
const TJN = (id, pick) => ({ k: 'tj', id, ...(pick ? { pick } : {}) })
const GEO = { k: 'sat', key: 'norad:1', name: 'ZX-6D', info: { geo: true } }
const L = (...nodes) => ({ id: 'l1', name: '', nameAuto: true, nodes })
const objs = { pg1: PG, t1: sea, t2: seaMov }
const stObj = { hub: { id: 'hub', name: '北京站', lat: 40, lon: 116 } }
const ctx = {
  hasStation: (id) => !!stObj[id], station: (id) => stObj[id] || null, satOk: () => true,
  area: (n) => objs[n.id] || null,
  nameOf: (n) => (n.k === 'st' ? stObj[n.id].name : n.k === 'sat' ? n.name : (objs[n.id] || {}).name || ''),
  points: (n) => {
    const o = objs[n.id]
    return nodePoints(n.k, o, n.pick, T0).map((c) => ({ ...c, label: c.key, name: o.name + '·' + c.key, altM: n.k === 'tj' ? c.altM : undefined }))
  }
}
ok('Polygon / 航迹是地面端', isAreaNode(PGN('pg1')) && hopKind(PGN('pg1'), GEO) === 'up' && hopKind(GEO, TJN('t1')) === 'down')
ok('Polygon 接站 = 站接站', slotIssue(PGN('pg1'), ST('hub'), null) === 'st-st' && linkIssues(L(PGN('pg1'), ST('hub'), GEO)).some((x) => x.code === 'st-st'))
ok('Polygon → GEO → 站 有效、可进 GSO', linkValid(L(PGN('pg1'), GEO, ST('hub')), ctx) && linkTargets(L(PGN('pg1'), GEO, ST('hub')), ctx).linkbudget)
ok('Polygon 删了 → no-pg', linkIssues(L(PGN('zz'), GEO, ST('hub')), ctx).some((x) => x.code === 'no-pg' && x.at === 0))
ok('航迹删了 → no-tj', linkIssues(L(ST('hub'), GEO, TJN('zz')), ctx).some((x) => x.code === 'no-tj' && x.at === 2))
ok('没取点 → no-pick', linkIssues(L(PGN('pg1', {}), GEO, ST('hub')), ctx).some((x) => x.code === 'no-pick'))
{
  const big = { id: 'big', name: 'B', pts: Array.from({ length: PICK_MAX + 2 }, (_, i) => [100 + 10 * Math.cos(i / (PICK_MAX + 2) * 2 * Math.PI), 30 + 10 * Math.sin(i / (PICK_MAX + 2) * 2 * Math.PI)]) }
  objs.big = big
  ok('取超 64 个 → pick-max', linkIssues(L(PGN('big', { v: 'all' }), GEO, ST('hub')), ctx).some((x) => x.code === 'pick-max'))
}
{
  const l = L(PGN('pg1', { c: true, v: 'all' }), GEO, TJN('t1', { w: 'all' }))
  ok('支路数 = 5 × 3', linkStrandCount(l, ctx) === 15)
  const s = linkStrands(l, ctx)
  ok('展开 15 条', s.length === 15)
  ok('展开序：前一个多点节点变得慢', s[0].sl === 'c / w:a' && s[1].sl === 'c / w:b' && s[3].sl === 'v0 / w:a', s.slice(0, 4).map((x) => x.sl).join(' | '))
  ok('载荷名带支路名', s[0].name.endsWith(' · c / w:a'))
  ok('都带 grp', s.every((x) => x.grp === 'l1'))
  ok('Polygon 点落成地面端、不带高度', s[0].nodes[0].t === 'es' && s[0].nodes[0].name === '华东区·c' && !('altM' in s[0].nodes[0]))
  ok('航迹点带高度', s[0].nodes[2].altM === 0)
  ok('跳类型照旧', s[0].hops.map((h) => h.type).join() === 'up,down')
}
{
  const l = L(ST('hub'), GEO, PGN('pg1'))
  const s = linkStrands(l, ctx)
  ok('单代表点：1 条、名字不追加', s.length === 1 && !s[0].name.includes(' · '))
  const plain = L(ST('hub'), GEO, ST('hub'))
  ok('没有多点节点：1 条', linkStrands(plain, ctx).length === 1)
}
{
  objs.big2 = { id: 'big2', name: 'C', pts: Array.from({ length: 40 }, (_, i) => [100 + Math.cos(i / 40 * 6.283), 30 + Math.sin(i / 40 * 6.283)]) }
  const l = L(PGN('big2', { v: 'all' }), GEO, PGN('big', { d: 20 }))
  ok('支路超 512 → 不导入', linkStrandCount(l, ctx) === 800 && linkStrands(l, ctx).length === 0 && !linkTargets(l, ctx).e2e && targetReason(l, 'e2e', ctx) === '支路超过 512 条', String(linkStrandCount(l, ctx)))
  ok('STRANDS_MAX = 512', STRANDS_MAX === 512)
}
{
  const n = normNode({ k: 'pg', id: 'pg1', pick: { c: true, v: [2, 2, 'x'] }, extra: 1 })
  ok('normNode Polygon', JSON.stringify(n) === '{"k":"pg","id":"pg1","pick":{"c":true,"v":[2]}}')
  ok('normNode 航迹无 pick 不写', JSON.stringify(normNode({ k: 'tj', id: 't1' })) === '{"k":"tj","id":"t1"}')
  const ls = sanitizeLinks([{ id: 'x', nodes: [{ k: 'pg', id: 'pg1', pick: { c: true } }, { k: 'sat', key: 'norad:1' }, { k: 'tj', id: 't1', pick: { veh: true } }] }])
  ok('sanitizeLinks 留住两类节点', ls[0].nodes.length === 3 && ls[0].nodes[0].k === 'pg' && ls[0].nodes[2].pick.veh === true)
  const src = L(PGN('pg1', { v: [0] }), GEO, ST('hub'))
  const r = reverseLink(src, () => 'r1')
  r.nodes[2].pick.v.push(1)
  ok('反向链路深拷取点', src.nodes[0].pick.v.length === 1 && r.nodes[2].k === 'pg')
}

console.log(`mapLinkPoints: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
