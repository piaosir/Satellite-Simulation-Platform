// 链路分析 · Polygon / 航迹节点接进组合式（src/viz/links/useMapLinks.js）的端到端行为：
// 真组合式 + 假宿主（GEO 星固定在 115.5°E），走 建链 → 每拍几何 / 读数 → 渲染载荷 → 取点编辑 → 导入支路 一整圈。
//
// 关键不变式：
//   ① 缺省取点：Polygon = 质心（单子跳，读数与站一样是「仰角 · 斜距」），取顶点后成一束（n = 点数，最差那条不 thin，其余 thin）；
//   ② 渲染载荷：代表点（gpts）逐个给；编辑器开着才给候选点（cands，含没取的），链路无效（一个点都没取）时候选点照给；
//   ③ 编辑器读数：每个候选点一条（键 = 候选键），载具行带此刻位置；
//   ④ 导入：一条链路按代表点展开成支路，站名「对象名·代表点」，航迹点带 altM；GSO 计数报 条 / 支路；
//   ⑤ 运动档载具随时刻走（两个时刻的斜距不同），飞行途中代表点带高度（3D 端点 altKm > 0）；
//   ⑥ 删掉编辑器开着的那个节点，编辑器随之关掉；删掉 Polygon 对象，节点报 no-pg、链路不画。
import { ref } from 'vue'
import { useMapLinks } from '../../../src/viz/links/useMapLinks.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
}

const T0 = Date.UTC(2026, 9, 8, 0, 0, 0)
const R_GEO = 42164.17, LON = 115.5 * Math.PI / 180
const GEO_ECEF = [R_GEO * Math.cos(LON), R_GEO * Math.sin(LON), 0]
let nid = 0
const host = {
  links: ref([]),
  stations: ref([{ id: 'hub', name: '北京站', lat: 40, lon: 116.4 }]),
  points: ref([]),
  polygons: ref([{ id: 'pg1', name: '华东区', pts: [[118, 28], [122, 28], [122, 33], [118, 33]], show: true }]),
  trajectories: ref([
    { id: 'tj1', name: '飞行1', kind: 'flight', t0Ms: T0, speedKmh: 800, pts: [{ id: 'a', lat: 39.9, lon: 116.4 }, { id: 'b', lat: 31.2, lon: 121.5 }, { id: 'c', lat: 22.3, lon: 114.2 }] },
    { id: 'tj2', name: '航行1', kind: 'sea', pts: [{ id: 'p', lat: 30, lon: 123 }, { id: 'q', lat: 25, lon: 120 }] }
  ]),
  trajShown: () => false,
  nowMs: () => T0,
  newId: () => 'id' + (++nid),
  commit: () => {},
  satEcefAt: (key) => (key === 'norad:1' ? GEO_ECEF : null),
  satInfo: () => ({ noradId: '1', geo: true, slotLon: 115.5 }),
  status: () => {}
}
const L = useMapLinks(host)
const SAT = { k: 'sat', key: 'norad:1', name: 'ZX-6D', info: { geo: true, slotLon: 115.5 } }

// ---- ① 建链：Polygon（缺省取质心）→ GEO → 站 ----
const pgNode = L.areaNode('pg', 'pg1')
ok('areaNode：缺省取质心', pgNode && JSON.stringify(pgNode.pick) === '{"c":true}')
ok('areaNode：对象不存在 → null', L.areaNode('pg', 'nope') === null)
const id = L.startNew(pgNode)
ok('加星', L.addNode({ ...SAT }) === '')
ok('星后接站', L.addNode({ k: 'st', id: 'hub' }) === '')
L.finish()
const link = L.linkOf(id)
ok('链路三节点', link.nodes.map((n) => n.k).join() === 'pg,sat,st')
// Polygon 与站之间（光标落在 Polygon 后）插站：地面端相邻，不插、报原因
L.startAt(id, 1)
ok('Polygon 紧跟站 → 拒（地面端相邻）', L.addNode({ k: 'st', id: 'hub' }) !== '' && link.nodes.length === 3)
L.cancel()

let r = L.compute(T0)
let rd = L.read.value.get(id)
ok('质心：单子跳', rd.hops[0].n === 1 && rd.hops[0].el > 30 && rd.hops[0].el < 70, JSON.stringify(rd.hops[0]))
ok('状态 ok、支路 1', rd.state === 'ok' && rd.strands === 1)
ok('渲染：两跳、一个代表点、无候选点', r.scene[0].hops.length === 2 && r.scene[0].gpts.length === 1 && r.scene[0].cands.length === 0)

// ---- ② 取点编辑：开编辑器 → 取顶点族 ----
L.openPick(id, 0)
ok('编辑器开在第 0 个节点', L.pickIdx() === 0)
L.pickFam('v', true)
ok('取顶点族 → v = all', link.nodes[0].pick.v === 'all')
r = L.compute(T0)
rd = L.read.value.get(id)
const h0 = rd.hops[0]
ok('多点束：n = 5（质心 + 4 顶点）', h0.n === 5 && h0.visN === 5)
ok('读数：最低 ≤ 最高、最差点有名', h0.el <= h0.elMax && h0.worst && (h0.worst.fam === 'v' || h0.worst.fam === 'c'))
ok('支路 5', rd.strands === 5)
const s3 = r.scene.find((x) => x.id === id)
ok('渲染：束 5 条（4 条 thin）+ 下行 1 条', s3.hops.length === 6 && s3.hops.filter((h) => h.thin).length === 4)
ok('渲染：最差那条排在束末（压在上面）', !s3.hops[4].thin && s3.hops.slice(0, 4).every((h) => h.thin))
ok('渲染：代表点 5 个', s3.gpts.length === 5)
ok('渲染：候选点 5 个、全部已取', s3.cands.length === 5 && s3.cands.every((c) => c.sel))
ok('编辑器读数：5 个候选点', rd.cand && rd.cand.i === 0 && rd.cand.map.size === 5 && rd.cand.map.get('v0').el > 0)
// 平面图载荷同构
const s2 = r.flat.find((x) => x.id === id)
ok('平面图：同样 6 段、5 个代表点、5 个候选点', s2.hops.length === 6 && s2.gpts.length === 5 && s2.cands.length === 5 && s2.hops[0].pts.length >= 2)
// 方向标（末端单箭头）：每段带终点身份 e；汇聚束（多个代表点 → 同一颗星）只给最差那条画箭头（de），下行照画
ok('终点身份：束 → 星、下行 → 站', s3.hops.slice(0, 5).every((h) => h.e && h.e.k === 'sat') && s3.hops[5].e.k === 'st' && s3.hops[5].e.id === 'hub')
ok('箭头去叠：汇聚束只最差那条画、下行画', s3.hops.slice(0, 4).every((h) => h.de === false) && s3.hops[4].de === true && s3.hops[5].de === true)
ok('平面图的 e / de 与 3D 同口径', s2.hops.every((h, i) => h.e.k === s3.hops[i].e.k && h.de === s3.hops[i].de))

// 逐点舍：舍掉质心与一个顶点
L.pickKey('c'); L.pickKey('v2')
rd = (L.compute(T0), L.read.value.get(id))
ok('舍两点 → 3 个代表点', rd.hops[0].n === 3 && JSON.stringify(link.nodes[0].pick) === '{"v":[0,1,3]}', JSON.stringify(link.nodes[0].pick))
// 全舍：链路无效，候选点仍照画
L.pickFam('v', false)
r = L.compute(T0)
rd = L.read.value.get(id)
ok('一个点都没取 → no-pick、无效', rd.state === 'bad' && rd.issues.some((x) => x.code === 'no-pick'))
const s3b = r.scene.find((x) => x.id === id)
ok('无效时不画跳，但候选点照画（取得回来）', s3b && s3b.hops.length === 0 && s3b.cands.length === 5 && s3b.cands.every((c) => !c.sel))
// 边界等分 8
L.pickFam('d', true)
r = L.compute(T0)
rd = L.read.value.get(id)
ok('边界等分 8：束 8 条', rd.hops[0].n === 8 && rd.strands === 8)
ok('候选点：质心 + 4 顶点 + 8 等分', r.scene.find((x) => x.id === id).cands.length === 13)
L.pickDiv(4)
ok('改点数 4', link.nodes[0].pick.d === 4 && (L.compute(T0), L.read.value.get(id).hops[0].n === 4))

// ---- ④ 导入 ----
L.checked.value = new Set([id])
const cnt = L.targetCounts()
ok('计数：GSO 1 条 / 4 支路', cnt.linkbudget === 1 && cnt.rows.linkbudget === 4 && cnt.e2e === 1 && cnt.ngso === 0)
const pl = L.payloads('linkbudget')
ok('导入：4 条单点载荷、1 条链路', pl.list.length === 4 && pl.links === 1 && pl.skipped === 0)
ok('导入：站名 = 对象名·代表点', pl.list[0].nodes[0].name === '华东区·边界1' && pl.list[3].nodes[0].name === '华东区·边界4', pl.list.map((p) => p.nodes[0].name).join())
ok('导入：Polygon 点不带高度', !('altM' in pl.list[0].nodes[0]))
ok('导入：带 grp / sl、名字带支路名', pl.list.every((p) => p.grp === id && p.sl) && pl.list[0].name.endsWith(' · 边界1'))

// ---- ⑥ 删节点关编辑器 ----
L.removeNode(id, 0)
ok('删掉编辑器开着的节点 → 编辑器关', L.pickEd.value === null)

// ---- ⑤ 航迹：飞行载具随时刻走、带高度 ----
const tjNode = L.areaNode('tj', 'tj1')
ok('运动档航迹缺省取载具', JSON.stringify(tjNode.pick) === '{"veh":true}')
const id2 = L.startNew({ k: 'st', id: 'hub' })
L.addNode({ ...SAT }); L.addNode(tjNode); L.finish()
r = L.compute(T0 + 30 * 60e3)
let rd2 = L.read.value.get(id2)
const d30 = rd2.hops[1].rangeKm
const g30 = r.scene.find((x) => x.id === id2).hops[1]
ok('飞行途中载具端点在空中', g30.b.altKm > 1, String(g30.b.altKm))
ok('载具代表点、载具图标没画 → 终点按链路小圆点（gp）', g30.e.k === 'gp' && g30.de === true)
r = L.compute(T0 + 120 * 60e3)
rd2 = L.read.value.get(id2)
ok('载具随时刻走：两个时刻斜距不同', Math.abs(rd2.hops[1].rangeKm - d30) > 1, d30 + ' vs ' + rd2.hops[1].rangeKm)
L.checked.value = new Set([id2])
const pl2 = L.payloads('linkbudget')
ok('导入：航迹点带 altM、站名「航迹名·载具」', pl2.list.length === 1 && Number.isFinite(pl2.list[0].nodes[2].altM) && pl2.list[0].nodes[2].name === '飞行1·载具', JSON.stringify(pl2.list[0].nodes[2]))

// 静止档航行航迹：缺省全部航点，站名用「#序号」
const tjSea = L.areaNode('tj', 'tj2')
ok('静止档航迹缺省取全部航点', JSON.stringify(tjSea.pick) === '{"w":"all"}')
const id3 = L.startNew(tjSea); L.addNode({ ...SAT }); L.addNode({ k: 'st', id: 'hub' }); L.finish()
L.checked.value = new Set([id3])
const pl3 = L.payloads('linkbudget')
ok('航点支路 2 条、站名 航行1#1 / #2、高度 0', pl3.list.length === 2 && pl3.list[0].nodes[0].name === '航行1#1' && pl3.list[1].nodes[0].name === '航行1#2' && pl3.list[0].nodes[0].altM === 0)
// 发散束（星 → 多个航点）：终点各不相同，每条都画箭头
const id5 = L.startNew({ k: 'st', id: 'hub' }); L.addNode({ ...SAT }); L.addNode(L.areaNode('tj', 'tj2')); L.finish()
r = L.compute(T0)
const s5 = r.scene.find((x) => x.id === id5)
ok('发散束：每条都画箭头、终点按代表点', s5.hops.length === 3 && s5.hops[0].e.k === 'sat' && s5.hops.slice(1).every((h) => h.de === true && h.e.k === 'gp'))

// ---- ⑥ 删对象 ----
host.polygons.value = []
const id4 = L.startNew(null)
host.links.value.find((l) => l.id === id4).nodes.push({ k: 'pg', id: 'pg1', pick: { c: true } }, { ...SAT }, { k: 'st', id: 'hub' })
L.finish()
r = L.compute(T0)
const rd4 = L.read.value.get(id4)
ok('Polygon 对象删了 → no-pg、不画', rd4.issues.some((x) => x.code === 'no-pg') && !r.scene.find((x) => x.id === id4))

console.log(`mapLinksArea: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
