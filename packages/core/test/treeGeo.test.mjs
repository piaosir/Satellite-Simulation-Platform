// 天线树里的同步轨道定点星 → 星座条目（src/viz/grd/treeGeo.js + satPos 的 __fix 取位）。运行：node packages/core/test/treeGeo.test.mjs
//
//   ① isTreeGeoNode：只收固定经纬度（custom / preset）且高度在同步轨道带（GEO / IGSO 同 orbitClass 口径）的星；关联 / 根数 / 仰角线不收。
//   ② treeGeoIds：合成号确定、唯一、落在号段内、与树序无关（撞号按 folder 字典序顺延）。
//   ③ syncTreeGeoEntries：条目对象跨重建复用；节点改经纬度 / 名字就地换 rec；删了 / 改成非同步高度 → gone。
//   ④ 取位钉在定点上：±1 年任意时刻，posAt 的星下点经纬度 / 高度与节点逐位一致（ECEF 与 W.geodeticToEcef 同一点）；
//      速度 = ω⊕ × r；posAtMs 与 posAt 同值；一个恒星日后回到同一惯性位置（轨道圈闭合）。
//   ⑤ 读数：GEO 平根数（倾角 = |纬度|、近圆、周期≈恒星日）、区制 GEO / IGSO、定点标注按节点经度、传播器「定点」。
//   ⑥ 本体身份 grdsat:<folder>（与树上 GRD 天线同一份）；页面接线按源码钉。
import { readFileSync } from 'node:fs'
import sat from '../../../src/viz/constellation/satellite.js'
import { posAt, posAtMs, periodMinOf, propagatorLabel, validSpan, keepInRenderSet, SIDEREAL_MIN } from '../../../src/viz/constellation/satPos.js'
import { isTreeGeoNode, treeGeoIds, syncTreeGeoEntries, TREE_GEO_NORAD_BASE, TREE_GEO_GROUP, TREE_GEO_LABEL } from '../../../src/viz/grd/treeGeo.js'
import { geodeticToEcef } from '../../../src/viz/wgs84.js'
import { metricsFromSatrec } from '../../../src/shared/satrecMetrics.js'
import { classifyOrbit, fmtGeoSlot } from '../../../src/shared/orbitClass.js'
import { geoSlotOfSatrec } from '../../../src/shared/geoSlot.js'
import { grdSatKey } from '../models/schema.mjs'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }
const wrapLon = (d) => ((d + 540) % 360) - 180

const geo = (folder, lon, lat = 0, altKm = 35786, extra = {}) => ({ folder, satName: folder, kind: 'custom', lon, lat, altKm, noradId: null, elements: null, ...extra })

// ---------- ① 判据 ----------
{
  ok(isTreeGeoNode(geo('A', 87.5)), '固定 GEO（35786 km、赤道）')
  ok(isTreeGeoNode({ ...geo('P', 110.5), kind: 'preset' }), '预置星（GEO 定点）')
  ok(isTreeGeoNode(geo('B', 125, 0, 36000)) && isTreeGeoNode(geo('B2', 125, 0, 35300)), '同步带内的高度（±2% 恒星日）')
  ok(isTreeGeoNode(geo('I', 100, 8)), '纬度 8°（同步带 · IGSO）照收')
  ok(!isTreeGeoNode(geo('L', 100, 0, 550)) && !isTreeGeoNode(geo('M', 100, 0, 20200)) && !isTreeGeoNode(geo('H', 100, 0, 38000)), 'LEO / MEO / 同步带外 → 不收')
  ok(!isTreeGeoNode(geo('N', 87.5, 0, 35786, { noradId: '39017', kind: 'linked' })), '关联星（有号）不收：它本来就在星座里')
  ok(!isTreeGeoNode(geo('O', 87.5, 0, 35786, { elements: { altKm: 35786 }, kind: 'orbit' })), '轨道根数星不收')
  ok(!isTreeGeoNode({ ...geo('E', 87.5), kind: 'elevline' }), '仰角线不收')
  ok(!isTreeGeoNode(geo('X', NaN)) && !isTreeGeoNode(geo('Y', 10, 0, NaN)) && !isTreeGeoNode(null), '坏经度 / 坏高度 / 空节点 → 不收')
}

// ---------- ② 合成号 ----------
{
  const nodes = [geo('ZX-12', 87.5), geo('CUSTOM-GEO', 125), geo('L', 100, 0, 550), geo('ZX-6E', 115.5)]
  const a = treeGeoIds(nodes), b = treeGeoIds([nodes[3], nodes[2], nodes[0], nodes[1]])
  ok(a.size === 3 && !a.has('L'), '只给同步定点星发号')
  ok([...a].every(([f, id]) => b.get(f) === id), '与树序无关（打乱顺序同一组号）')
  ok([...a.values()].every((id) => +id >= TREE_GEO_NORAD_BASE && +id < TREE_GEO_NORAD_BASE + 90000), '号在号段内', [...a.values()].join(','))
  // 撞号：3000 颗必然有同余，号全不重复；删掉其中一颗，其余不受影响的保持原号
  const many = Array.from({ length: 3000 }, (_, i) => geo('S' + i, i % 360))
  const m1 = treeGeoIds(many)
  ok(new Set(m1.values()).size === 3000, '3000 颗全部不重号（撞号顺延）')
  const m2 = treeGeoIds(many.slice().reverse())
  ok([...m1].every(([f, id]) => m2.get(f) === id), '大批量也与树序无关')
}

// ---------- ③ 条目表 ----------
const T0 = Date.UTC(2026, 8, 24, 12, 0, 0)
{
  const cache = new Map()
  const A = geo('ZX-12', 87.5), C = geo('CUSTOM-GEO', 125), L = geo('LEO-FIX', 100, 0, 550)
  let r = syncTreeGeoEntries([A, C, L], cache)
  const eA = r.byId.get(r.ids.get('ZX-12'))
  ok(r.list.length === 2 && r.list[0] === eA && eA.name === 'ZX-12' && eA.group === TREE_GEO_GROUP && eA.groupLabel === TREE_GEO_LABEL && eA._grdFolder === 'ZX-12', '按树序出条目，带分组 / 来源 folder')
  ok(typeof eA.noradId === 'number' && String(eA.noradId) === r.ids.get('ZX-12'), '条目号＝合成号（数字）')
  const rec0 = eA.rec
  r = syncTreeGeoEntries([A, C, L], cache)
  ok(r.byId.get(r.ids.get('ZX-12')) === eA && eA.rec === rec0 && !r.gone.length, '节点没变：同一个对象、同一个 rec')
  A.lon = 88.0; A.satName = 'ZX-12 新名'
  r = syncTreeGeoEntries([A, C, L], cache)
  ok(r.byId.get(r.ids.get('ZX-12')) === eA && eA.rec !== rec0 && eA.name === 'ZX-12 新名' && eA.rec.__fix.lon === 88, '改经度 / 改名：对象不换，rec 就地换新')
  A.altKm = 600
  r = syncTreeGeoEntries([A, C, L], cache)
  ok(r.gone.length === 1 && r.gone[0] === eA && !r.byId.has(String(eA.noradId)) && !cache.has('ZX-12'), '改成非同步高度 → 掉出（gone）')
  r = syncTreeGeoEntries([L], cache)
  ok(r.gone.length === 1 && r.gone[0]._grdFolder === 'CUSTOM-GEO' && r.list.length === 0 && cache.size === 0, '删掉节点 → 掉出')
}

// ---------- ④ 取位钉在定点上 ----------
{
  const cache = new Map()
  const nodes = [geo('G1', 87.5), geo('G2', -75.2), geo('G3', 179.9, 0, 35800), geo('I8', 100, 8, 35786)]
  const { list } = syncTreeGeoEntries(nodes, cache)
  let worstLon = 0, worstLat = 0, worstH = 0, worstEcef = 0, worstV = 0, worstMs = 0
  for (const e of list) {
    const n = nodes.find((x) => x.folder === e._grdFolder)
    const R = geodeticToEcef(n.lon, n.lat, n.altKm)
    for (const dd of [-365, -90, -30, -7, -1, -0.25, 0, 0.1, 1, 7, 30, 90, 180, 365]) {
      const t = new Date(T0 + dd * 864e5), g = sat.gstime(t)
      const pv = posAt(e, t)
      const gd = sat.eciToGeodetic(pv.position, g)
      worstLon = Math.max(worstLon, Math.abs(wrapLon(sat.degreesLong(gd.longitude) - n.lon)))
      worstLat = Math.max(worstLat, Math.abs(sat.degreesLat(gd.latitude) - n.lat))
      worstH = Math.max(worstH, Math.abs(gd.height - n.altKm))
      const ecf = sat.eciToEcf(pv.position, g)
      worstEcef = Math.max(worstEcef, Math.hypot(ecf.x - R[0], ecf.y - R[1], ecf.z - R[2]))
      // 速度 = ω⊕ × r（惯性系里跟着地球转）：与 r 垂直、大小 ω·r_xy
      const p = pv.position, v = pv.velocity
      const WE = 7.292115146706979e-5
      worstV = Math.max(worstV, Math.hypot(v.x + WE * p.y, v.y - WE * p.x, v.z))
      const pm = posAtMs(e.rec, t.getTime())
      worstMs = Math.max(worstMs, Math.hypot(pm.position.x - p.x, pm.position.y - p.y, pm.position.z - p.z))
    }
  }
  ok(worstLon < 1e-9 && worstLat < 1e-9, '±1 年任意时刻星下点经纬度与节点一致（SDP4 自由推演一个月就漂 0.3–0.9°）', `lon ${worstLon.toExponential(2)}° lat ${worstLat.toExponential(2)}°`)
  ok(worstH < 1e-6, '高度一致', `${worstH.toExponential(2)} km`)
  ok(worstEcef < 1e-6, '地固系位置与 W.geodeticToEcef（覆盖源点）同一点', `${worstEcef.toExponential(2)} km`)
  ok(worstV < 1e-12, '速度 = ω⊕ × r（相对地面静止）', `${worstV.toExponential(2)} km/s`)
  ok(worstMs < 1e-9, 'posAtMs（热路径）与 posAt 同值', `${worstMs.toExponential(2)} km`)
  const e = list[0], t = new Date(T0)
  const a = posAt(e, t).position, b = posAt(e, new Date(T0 + SIDEREAL_MIN * 60000)).position
  ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.01, '一个恒星日后回到同一惯性位置：轨道圈闭合', `${(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 1000).toFixed(2)} m`)
  ok(periodMinOf(e) === SIDEREAL_MIN && periodMinOf(e.rec) === SIDEREAL_MIN, '周期（轨道圈 / 轨迹长度口径）＝恒星日')
  ok(validSpan(e) === null && keepInRenderSet(e, t) === true, '无时段限制、留在渲染集')
  ok(propagatorLabel(e) === '定点', '传播器标注「定点」')
}

// ---------- ⑤ 读数 ----------
{
  const cache = new Map()
  const { list } = syncTreeGeoEntries([geo('G1', 87.5), geo('W', -61.0), geo('I8', 100, 8)], cache)
  const [g1, w, i8] = list
  const m = metricsFromSatrec(g1.rec)
  ok(m && Math.abs(m.incl) < 1e-9 && m.ecc === 0 && Math.abs(m.periodMin - 1436.07) < 0.5, 'GEO 平根数：倾角 0、近圆、周期≈恒星日', `T ${m && m.periodMin.toFixed(3)} min`)
  ok(Math.abs(m.perigeeKm - 35786) < 1e-6 && Math.abs(m.apogeeKm - 35786) < 1e-6, "近 / 远地点高度＝定点高度（半长轴按 SGP4 口径迭代到定点地心距）", `${m.perigeeKm.toFixed(1)} / ${m.apogeeKm.toFixed(1)}`)
  ok(classifyOrbit({ aKm: 6378.137 + (m.perigeeKm + m.apogeeKm) / 2, e: m.ecc, inclDeg: m.incl, periodMin: m.periodMin }) === 'GEO', '区制 GEO（模型自动匹配按它认 GEO 通信星）')
  ok(geoSlotOfSatrec(g1.rec) === fmtGeoSlot(87.5) && geoSlotOfSatrec(w.rec) === fmtGeoSlot(-61), '定点标注按节点经度（不取 SDP4 历元经度的 0.02° 偏置）', `${geoSlotOfSatrec(g1.rec)} / ${geoSlotOfSatrec(w.rec)}`)
  const mi = metricsFromSatrec(i8.rec)
  ok(Math.abs(mi.incl - 8) < 1e-9 && geoSlotOfSatrec(i8.rec) === '', '纬度 8°：倾角 8°、IGSO 不出定点标注')
  ok(g1.rec.error === 0 && g1.rec.satnum === String(g1.noradId), 'satrec 完好（satnum = 合成号）')
}

// ---------- ⑥ 身份与页面接线 ----------
{
  ok(grdSatKey('ZX-12') === 'grdsat:ZX-12', '本体身份键 grdsat:<folder>（与树上 GRD 天线同一份）')
  const page = readFileSync(new URL('../../../src/pages/ConstellationMap3D.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const body = (sig) => { const i = page.indexOf(sig), j = page.indexOf('\n}\n', i); return i >= 0 && j > i ? page.slice(i, j) : '' }
  ok(page.includes("function satKeyOf(e) { return e && e._grdFolder ? grdSatKey(e._grdFolder) : coreSatKeyOf(e) }"), '页面 satKeyOf：定点星条目认 grdsat:<folder>（模型 / 姿态 / 挂点与天线同一份）')
  const rb = body('function rebuildRenderSet() {')
  ok(rb.includes('add(treeGeoList.filter((e) => { const n = grdNodeOf(e._grdFolder); return !!n && satVisible(n) }))'), '渲染集收定点星，显隐跟树上的小眼睛')
  ok(body('function satEntryById(id) {').includes('treeGeoById.get(key)'), 'satEntryById 能按合成号取到（小眼睛关着也在）')
  const sy = body('function syncTreeGeo() {')
  ok(sy.includes('syncTreeGeoEntries(grdSats.value, treeGeoCache)') && sy.includes('stopFollow()') && sy.includes('closeCard()') && sy.includes('rebuildRenderSet()'), 'syncTreeGeo：掉出的条目移出聚焦集（先退出跟随），再重建渲染集')
  ok(/watch\(\(\) => grdSats\.value\.map\(\(n\) => \(n && n\.kind !== 'elevline' && !n\.noradId && !n\.elements \? `\$\{n\.folder\}\|\$\{n\.satName\}\|\$\{n\.lon\}\|\$\{n\.lat\}\|\$\{n\.altKm\}\|\$\{satVisible\(n\) \? 1 : 0\}` : ''\)\)\.join\('\\n'\), syncTreeGeo, \{ immediate: true \}\)/.test(page), '树的增删改 / 小眼睛 → syncTreeGeo')
  const el = body('async function ensureLinkedFolder(en) {')
  ok(el.includes('linkedNodesOf(grdSats.value, id, treeGeoIdMap.value)[0]') && el.indexOf('linkedNodesOf(grdSats.value, id, treeGeoIdMap.value)[0]') < el.indexOf('grd.addSatellite('), 'ensureLinkedFolder：定点星条目先认回它自己的节点（绝不再建一颗关联合成号的新星）')
  ok(page.includes("noradId: e._grdFolder ? '' : e.noradId, group:") && page.includes('function epochMsOf(rec) { return rec && !rec.__fix &&'), '信息栏：合成号不当 NORAD 显示、定点星不出历元')
  ok(page.includes('const selFolderSet = computed(() => foldersForNorads(grdSats.value, selNoradList.value, treeGeoIdMap.value))'), '树上高亮认合成号')
  ok(page.includes('treeFollowFolder(grdSats.value, selPrimNorad.value, bs.satFolder.value, treeGeoIdMap.value)'), '波束合成跟随主选认合成号')
  ok((page.match(/linkedNodesOf\(grdSats\.value, [^)]*\)/g) || []).every((s) => s.includes('treeGeoIdMap.value')), '页面里每一处 linkedNodesOf 都带合成号映射')
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail) process.exit(1)
