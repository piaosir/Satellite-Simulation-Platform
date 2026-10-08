// 天线树里的虚拟卫星（定点星 / 轨道根数星）→ 星座条目（src/viz/grd/treeGeo.js + satPos 的 __fix 取位）。运行：node packages/core/test/treeGeo.test.mjs
//
//   ① isTreeGeoNode：只收固定经纬度（custom / preset）且高度在同步轨道带（GEO / IGSO 同 orbitClass 口径）的星；关联 / 根数 / 仰角线不收。
//      isTreeSatNode：全部虚拟星 —— 无号、非仰角线，且有根数或有效定点（经度有限、高度 > 0）。
//   ② treeGeoIds：合成号确定、唯一、落在号段内、与树序无关（撞号按 folder 字典序顺延）；两轮发号 —— 同步定点星的号
//      与「只收同步星」那一版逐位一致，加减非同步 / 根数星不挪任何一颗同步星的号。isTreeGeoId 只认合成号段。
//   ③ syncTreeGeoEntries：条目对象跨重建复用；节点改经纬度 / 名字 / 高度就地换 rec（进 changed）；删了 / 关联上星座 → gone。
//      根数星的 rec 由调用方注入（orbitRec）：条目 rec 就是注入的那一份；根数一变换 rec、对象不换；解不出（error）→ 不出条目 / 掉出。
//   ③c 根数星的历元跟着节点走（elements.epoch，shared/treeOrbitEpoch.js）：同历元逐位同位、历元不同各在一处、旧节点按固定常量；
//      页面 / useGrdCoverage 的接线（新建取时间轴此刻、弹窗保留与改历元、恢复时迁移并落盘）按源码钉在 ⑥；⑦ satTree 读树时规范历元。
//   ④ 取位钉在定点上：±1 年任意时刻，posAt 的星下点经纬度 / 高度与节点逐位一致（ECEF 与 W.geodeticToEcef 同一点）；
//      速度 = ω⊕ × r；posAtMs 与 posAt 同值；一个恒星日后回到同一惯性位置（轨道圈闭合）。LEO 高度（1000 km）的定点同样钉住。
//   ⑤ 读数：GEO 平根数（倾角 = |纬度|、近圆、周期≈恒星日）、区制 GEO / IGSO、定点标注按节点经度、传播器「定点」。
//   ⑥ 本体身份 grdsat:<folder>（与树上 GRD 天线同一份）；页面接线按源码钉（卫星集「卫星天线树」't:tree'、TDZ 顺序、信息栏口径、
//      各成员表不出合成号、卫星集标签不并空树、搜索下拉重新展开）。
import { readFileSync } from 'node:fs'
import sat from '../../../src/viz/constellation/satellite.js'
import { posAt, posAtMs, periodMinOf, propagatorLabel, validSpan, keepInRenderSet, SIDEREAL_MIN } from '../../../src/viz/constellation/satPos.js'
import { isTreeGeoNode, isTreeSatNode, isTreeGeoId, treeGeoIds, syncTreeGeoEntries, TREE_GEO_NORAD_BASE, TREE_GEO_GROUP, TREE_GEO_LABEL } from '../../../src/viz/grd/treeGeo.js'
import { geodeticToEcef } from '../../../src/viz/wgs84.js'
import { metricsFromSatrec } from '../../../src/shared/satrecMetrics.js'
import { classifyOrbit, fmtGeoSlot } from '../../../src/shared/orbitClass.js'
import { geoSlotOfSatrec } from '../../../src/shared/geoSlot.js'
import { grdSatKey } from '../models/schema.mjs'
import { elementsOmm, TREE_ORBIT_LEGACY_EPOCH } from '../../../src/shared/treeOrbitEpoch.js'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }
const wrapLon = (d) => ((d + 540) % 360) - 180

const geo = (folder, lon, lat = 0, altKm = 35786, extra = {}) => ({ folder, satName: folder, kind: 'custom', lon, lat, altKm, noradId: null, elements: null, ...extra })
const orb = (folder, elements) => ({ folder, satName: folder, kind: 'orbit', lon: 0, lat: 0, altKm: elements.altKm, noradId: null, elements })
// 页面 orbitSatrec 的同款（经典根数 + 节点自己的历元 → satrec；按 folder + 根数签名缓存，同根数＝同一个对象）
function recOfElements(el) { return sat.omm2satrec(elementsOmm(el, 'SIM')) }
// 改造前页面 elementsToSatrec 的内联算式（历元由调用方给）：换成 elementsOmm 之后同一历元下逐位不变
function recOfElementsOld(el, epoch) {
  const ecc = Math.max(0, Math.min(0.999, Number(el.ecc) || 0))
  const a = (6378.137 + (Number(el.altKm) || 0)) / (1 - ecc)
  const meanMotion = 86400 * Math.sqrt(398600.4418 / (a * a * a)) / (2 * Math.PI)
  return sat.omm2satrec({ noradId: 'SIM', epoch, meanMotion, ecc, incl: Number(el.incl) || 0, raan: Number(el.raan) || 0, argp: Number(el.argp) || 0, ma: Number(el.ma) || 0, bstar: 0, mdot: 0, mddot: 0 })
}
function makeOrbitRec() {
  const cache = new Map()
  const fn = (n) => {
    const sig = JSON.stringify(n.elements), hit = cache.get(n.folder)
    if (hit && hit.sig === sig) return hit.rec
    const rec = recOfElements(n.elements)
    cache.set(n.folder, { sig, rec })
    return rec
  }
  fn.recOf = (folder) => (cache.get(folder) || {}).rec
  return fn
}

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

  // isTreeSatNode：全部虚拟星
  ok(isTreeSatNode(geo('A', 87.5)) && isTreeSatNode(geo('L', 100, 0, 550)) && isTreeSatNode(geo('M', 100, 0, 20200)) && isTreeSatNode(geo('H', 100, 0, 38000)), 'isTreeSatNode：定点星不论高度都收（同步 / LEO / MEO / 同步带外）')
  ok(isTreeSatNode(orb('O', { altKm: 550, incl: 53 })) && isTreeSatNode({ ...geo('P2', NaN, 0, NaN), kind: 'preset', elements: { altKm: 1200 } }), 'isTreeSatNode：轨道根数星收（不看经纬高；按字段判，预置星带根数也收）')
  ok(!isTreeSatNode(geo('N', 87.5, 0, 35786, { noradId: '39017', kind: 'linked' })) && !isTreeSatNode({ ...geo('P3', 87.5), kind: 'preset', noradId: 41838 }) && !isTreeSatNode(geo('N2', 0, 0, 0, { noradId: 25544, elements: { altKm: 400 } })), 'isTreeSatNode：有号（关联星 / 带号的预置星 / 带号又带根数）不收')
  ok(!isTreeSatNode({ ...geo('E', 87.5), kind: 'elevline' }) && !isTreeSatNode({ ...orb('E2', { altKm: 500 }), kind: 'elevline' }) && !isTreeSatNode(geo('X', NaN)) && !isTreeSatNode(geo('Y', 10, 0, NaN)) && !isTreeSatNode(geo('Z', 10, 0, 0)) && !isTreeSatNode(geo('Z2', 10, 0, -5)) && !isTreeSatNode(null), 'isTreeSatNode：仰角线 / 坏经度 / 坏高度 / 高度 ≤ 0 / 空节点不收')
  const pool = [geo('A', 87.5), geo('I', 100, 8), geo('L', 100, 0, 550), geo('N', 87.5, 0, 35786, { noradId: '1' }), orb('O', { altKm: 35786 }), { ...geo('E', 87.5), kind: 'elevline' }]
  ok(pool.every((n) => !isTreeGeoNode(n) || isTreeSatNode(n)), '同步定点星是虚拟星的子集')
}

// ---------- ② 合成号 ----------
{
  const nodes = [geo('ZX-12', 87.5), geo('CUSTOM-GEO', 125), geo('L', 100, 0, 550), geo('ZX-6E', 115.5), orb('SIM', { altKm: 550, incl: 53 }), geo('LINK', 87.5, 0, 35786, { noradId: '39017' }), { ...geo('EL', 87.5), kind: 'elevline' }]
  const a = treeGeoIds(nodes), b = treeGeoIds([nodes[3], nodes[6], nodes[2], nodes[4], nodes[0], nodes[5], nodes[1]])
  ok(a.size === 5 && a.has('L') && a.has('SIM') && !a.has('LINK') && !a.has('EL'), '全部虚拟星发号（同步 / 非同步定点 / 根数星）；关联星 / 仰角线不发')
  ok([...a].every(([f, id]) => b.get(f) === id), '与树序无关（打乱顺序同一组号）')
  ok(new Set(a.values()).size === a.size, '号互不相同')
  // 两轮发号：同步定点星的号与「只收同步星」那一版逐位一致 —— 找一个散列号位正好撞上 ZX-12 的非同步 folder，它也让不动 ZX-12
  const syncOnly = treeGeoIds([geo('ZX-12', 87.5), geo('CUSTOM-GEO', 125), geo('ZX-6E', 115.5)])
  const slotOf = (f) => treeGeoIds([geo(f, 0, 0, 550)]).get(f)
  let clash = ''
  for (let i = 0; i < 2e6 && !clash; i++) if (slotOf('LEO-' + i) === syncOnly.get('ZX-12')) clash = 'LEO-' + i
  const withExtra = treeGeoIds([geo(clash, 10, 0, 550), geo('ZX-12', 87.5), orb('SIM', { altKm: 550 }), geo('CUSTOM-GEO', 125), geo('ZX-6E', 115.5)])
  ok(!!clash && [...syncOnly].every(([f, id]) => withExtra.get(f) === id) && withExtra.get(clash) !== syncOnly.get('ZX-12'), '两轮发号：撞上同步星号位的非同步星顺延，同步星的号一个不挪', `${clash} → ${withExtra.get(clash)}，ZX-12 = ${syncOnly.get('ZX-12')}`)
  const manySync = Array.from({ length: 3000 }, (_, i) => geo('G' + i, i % 360))
  const manyLeo = Array.from({ length: 3000 }, (_, i) => (i % 2 ? geo('F' + i, i % 360, 0, 500 + i) : orb('R' + i, { altKm: 500 + i })))
  const s1 = treeGeoIds(manySync), s2 = treeGeoIds([...manyLeo.slice(0, 1500), ...manySync, ...manyLeo.slice(1500)])
  ok([...s1].every(([f, id]) => s2.get(f) === id) && new Set(s2.values()).size === 6000, '大批量：3000 颗同步星混进 3000 颗非同步 / 根数星，同步星的号全不变、6000 个号全不重')
  ok([...a.values()].every((id) => +id >= TREE_GEO_NORAD_BASE && +id < TREE_GEO_NORAD_BASE + 90000), '号在号段内', [...a.values()].join(','))
  ok([...s2.values()].every((id) => isTreeGeoId(id) && isTreeGeoId(Number(id))) && isTreeGeoId(TREE_GEO_NORAD_BASE) && isTreeGeoId(TREE_GEO_NORAD_BASE + 89999), 'isTreeGeoId：发出去的号（串 / 数字）都认、号段两端都认')
  ok(![25544, '39017', 339999, 800001, 900001, 1699999, 1790000, 1800000, '', null, undefined, 'abc', 1700000.5].some(isTreeGeoId), 'isTreeGeoId：目录号 / 点序列 / 自定义星座 / 向导预览号段、号段外、空值、非整数都不认')
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
  const eA = r.byId.get(r.ids.get('ZX-12')), eL = r.byId.get(r.ids.get('LEO-FIX'))
  ok(r.list.length === 3 && r.list[0] === eA && r.list[2] === eL && eA.name === 'ZX-12' && eA.group === TREE_GEO_GROUP && eA.groupLabel === TREE_GEO_LABEL && eA._grdFolder === 'ZX-12' && eA._treeKind === 'fixed' && eL._treeKind === 'fixed', '按树序出条目（非同步定点星也出），带分组 / 来源 folder / 种类')
  ok(typeof eA.noradId === 'number' && String(eA.noradId) === r.ids.get('ZX-12'), '条目号＝合成号（数字）')
  ok(eA.rec.__fix.sync === true && eL.rec.__fix.sync === false && eL.rec.error === 0, '__fix.sync：同步定点 true、LEO 定点 false（satrec 照样完好）')
  ok(r.ids.size === 3 && !r.changed.length && !r.gone.length, '首轮：ids 只含出了条目的、没有 changed / gone')
  const rec0 = eA.rec
  r = syncTreeGeoEntries([A, C, L], cache)
  ok(r.byId.get(r.ids.get('ZX-12')) === eA && eA.rec === rec0 && !r.gone.length && !r.changed.length, '节点没变：同一个对象、同一个 rec、不进 changed')
  A.lon = 88.0; A.satName = 'ZX-12 新名'
  r = syncTreeGeoEntries([A, C, L], cache)
  ok(r.byId.get(r.ids.get('ZX-12')) === eA && eA.rec !== rec0 && eA.name === 'ZX-12 新名' && eA.rec.__fix.lon === 88 && r.changed.length === 1 && r.changed[0] === eA, '改经度 / 改名：对象不换，rec 就地换新、进 changed')
  A.altKm = 600
  r = syncTreeGeoEntries([A, C, L], cache)
  ok(r.byId.get(String(eA.noradId)) === eA && cache.get('ZX-12') === eA && !r.gone.length && eA.rec.__fix.sync === false && eA.rec.__fix.altKm === 600 && r.changed.includes(eA), '改成非同步高度：仍在（同一对象），rec 换成非同步定点、进 changed')
  A.noradId = '39017'
  r = syncTreeGeoEntries([A, C, L], cache)
  ok(r.gone.length === 1 && r.gone[0] === eA && !r.ids.has('ZX-12') && !cache.has('ZX-12'), '关联上星座（有号）→ 掉出（gone）')
  r = syncTreeGeoEntries([L], cache)
  ok(r.gone.length === 1 && r.gone[0]._grdFolder === 'CUSTOM-GEO' && r.list.length === 1 && r.list[0] === eL && cache.size === 1, '删掉节点 → 掉出')
}

// ---------- ③b 轨道根数星（rec 由调用方注入）----------
{
  const cache = new Map(), orbitRec = makeOrbitRec()
  const G = geo('ZX-12', 87.5), O = orb('SIM-1', { altKm: 550, ecc: 0, incl: 53, raan: 10, argp: 0, ma: 20 })
  let r = syncTreeGeoEntries([G, O], cache, orbitRec)
  const eO = r.byId.get(r.ids.get('SIM-1'))
  ok(!!eO && eO._treeKind === 'orbit' && eO.rec === orbitRec.recOf('SIM-1') && !eO.rec.__fix && r.list[1] === eO, '根数星：出条目，rec 就是注入的那一份（不钉，按 SGP4 推演）')
  ok(r.ids.get('ZX-12') === treeGeoIds([G]).get('ZX-12'), '树里多了根数星，同步星的号不变')
  const t = new Date(T0), p1 = posAt(eO, t).position, p2 = sat.propagate(orbitRec.recOf('SIM-1'), t).position
  ok(p1.x === p2.x && p1.y === p2.y && p1.z === p2.z, 'posAt(条目) ＝ 注入 rec 的 SGP4（与覆盖源点同一份星历）')
  r = syncTreeGeoEntries([G, O], cache, orbitRec)
  ok(r.byId.get(String(eO.noradId)) === eO && !r.changed.length, '根数没变：同一个 rec、不进 changed')
  G.satName = '改名'
  r = syncTreeGeoEntries([G, O], cache, orbitRec)
  ok(r.changed.length === 1 && r.changed[0] !== eO, '只改了别的星：根数星不进 changed')
  const recOld = eO.rec
  O.elements = { ...O.elements, altKm: 1200 }
  r = syncTreeGeoEntries([G, O], cache, orbitRec)
  ok(r.byId.get(String(eO.noradId)) === eO && eO.rec !== recOld && eO.rec === orbitRec.recOf('SIM-1') && r.changed.length === 1 && r.changed[0] === eO, '改根数：条目对象不换，rec 换成新注入的那一份、进 changed')
  const recSame = eO.rec
  O.satName = 'SIM-1 新名'
  r = syncTreeGeoEntries([G, O], cache, orbitRec)
  ok(eO.rec === recSame && eO.name === 'SIM-1 新名' && r.changed.length === 1 && r.changed[0] === eO, '根数星只改名：rec 不换，但进 changed（模型自动匹配按名字认）')
  O.satName = 'SIM-1'
  r = syncTreeGeoEntries([G, O], cache, orbitRec)
  const bad = { error: 2 }
  r = syncTreeGeoEntries([G, O], cache, () => bad)
  ok(r.gone.length === 1 && r.gone[0] === eO && !r.ids.has('SIM-1') && !cache.has('SIM-1') && r.list.length === 1, '注入的 rec 报错（error ≠ 0）→ 当它不在：掉出、ids 不含它')
  r = syncTreeGeoEntries([G, O], cache)
  ok(!r.ids.has('SIM-1') && r.list.length === 1, '不给 orbitRec → 根数星不出条目')
  r = syncTreeGeoEntries([G, O], cache, () => { throw new Error('bad elements') })
  ok(!r.ids.has('SIM-1') && r.list.length === 1, 'orbitRec 抛错 → 不出条目、不往外抛')
  r = syncTreeGeoEntries([G, O], cache, orbitRec)
  const eO2 = r.byId.get(r.ids.get('SIM-1'))
  ok(!!eO2 && eO2 !== eO && eO2.rec === orbitRec.recOf('SIM-1') && String(eO2.noradId) === String(eO.noradId), '又解得出 → 新条目，号不变')
  O.elements = null; O.lon = 30; O.altKm = 800; O.kind = 'custom'
  r = syncTreeGeoEntries([G, O], cache, orbitRec)
  ok(r.byId.get(r.ids.get('SIM-1')) === eO2 && eO2._treeKind === 'fixed' && !!eO2.rec.__fix && eO2.rec.__fix.sync === false && r.changed.includes(eO2), '根数星改成定点：同一对象，种类换成 fixed、rec 换成钉住的定点')
}

// ---------- ③c 根数星的历元跟着节点走（elements.epoch）----------
{
  const el = { altKm: 550, ecc: 0.001, incl: 53, raan: 10, argp: 30, ma: 20 }
  const EP = '2026-10-06T02:30:00.000Z', EP2 = '2026-10-06T03:30:00.000Z'
  const a = recOfElements({ ...el, epoch: EP }), b = recOfElementsOld(el, EP)
  ok(['no', 'ecco', 'inclo', 'nodeo', 'argpo', 'mo', 'jdsatepoch', 'jdsatepochF'].every((k) => a[k] === b[k]) && a.error === 0, 'elementsOmm 与改造前页面的内联算式同一历元下逐位相同（只换了历元的来源）')
  const t = new Date(Date.UTC(2026, 9, 6, 12))
  const p1 = sat.propagate(recOfElements({ ...el, epoch: EP }), t).position, p2 = sat.propagate(recOfElements({ ...el, epoch: EP }), t).position
  const p3 = sat.propagate(recOfElements({ ...el, epoch: EP2 }), t).position
  ok(p1.x === p2.x && p1.y === p2.y && p1.z === p2.z, '同根数同历元：任何时候重建（切回页面 / 别的窗口）同一时刻逐位同位')
  ok(Math.hypot(p1.x - p3.x, p1.y - p3.y, p1.z - p3.z) > 100, '历元不同：同一时刻在轨道上不同处（各星历元可以不同）', `${Math.hypot(p1.x - p3.x, p1.y - p3.y, p1.z - p3.z).toFixed(0)} km`)
  const o1 = recOfElements(el), oc = recOfElementsOld(el, TREE_ORBIT_LEGACY_EPOCH)
  ok(o1.jdsatepoch === oc.jdsatepoch && o1.jdsatepochF === oc.jdsatepochF && o1.mo === oc.mo, '没有历元的旧根数按 TREE_ORBIT_LEGACY_EPOCH 建（固定常量，不取此刻）')
  const cache = new Map(), orbitRec = makeOrbitRec()
  const O = orb('EP-1', { ...el, epoch: EP })
  let r = syncTreeGeoEntries([O], cache, orbitRec)
  const e0 = r.byId.get(r.ids.get('EP-1')), rec0 = e0.rec
  O.elements = { ...O.elements, epoch: EP2 }
  r = syncTreeGeoEntries([O], cache, orbitRec)
  ok(r.byId.get(r.ids.get('EP-1')) === e0 && e0.rec !== rec0 && e0.rec === orbitRec.recOf('EP-1') && r.changed.includes(e0), '只改历元：条目对象不换、rec 换新（缓存签名含历元）、进 changed')
  const epochMsOf = (rec) => Math.round((rec.jdsatepoch + (rec.jdsatepochF || 0) - 2440587.5) * 864e5)   // 页面 epochMsOf 同式
  ok(epochMsOf(e0.rec) === Date.parse(EP2), '条目 rec 的历元就是节点存的那个（信息栏读数即推演用的历元）')
  // 信息栏按秒截断显示：儒略日换回毫秒不取整的话约一半整秒历元落在整秒之下、读数早一秒（与弹窗里的历元对不上）
  let off = 0, raw = 0
  for (let k = 0; k < 3600; k++) {
    const ms = Date.parse('2026-10-06T02:00:00.000Z') + k * 1000, r = recOfElements({ ...el, epoch: new Date(ms).toISOString() })
    if (epochMsOf(r) !== ms) off++
    if (Math.floor((r.jdsatepoch + (r.jdsatepochF || 0) - 2440587.5) * 864e5 / 1000) * 1000 !== ms) raw++
  }
  ok(off === 0, '3600 个整秒历元：信息栏取到的历元毫秒逐个等于节点存的（取整到毫秒）', `不取整时按秒截断错 ${raw} 个`)
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

// ---------- ④b LEO 高度的定点（非同步）同样钉住 ----------
{
  const cache = new Map()
  const n = geo('LEO-PIN', 116.4, 39.9, 1000)
  const e = syncTreeGeoEntries([n], cache).list[0]
  const R = geodeticToEcef(116.4, 39.9, 1000)
  ok(!!e && e.rec.error === 0 && e.rec.__fix.sync === false && e.rec._geoSlot === '' && geoSlotOfSatrec(e.rec) === '', 'LEO 定点（1000 km）：satrec 完好（error 0）、__fix.sync = false、无定点标注')
  ok(e.rec.__fix.r.length === 3 && e.rec.__fix.r.every((v, i) => v === R[i]), '__fix.r 与 W.geodeticToEcef（覆盖源点）逐位相同')
  let bit = true, worst = 0
  for (const t of [new Date(T0), new Date(T0 + 37 * 864e5 + 12345)]) {
    const g = sat.gstime(t), c = Math.cos(g), s = Math.sin(g)
    const p = posAt(e, t).position
    // TEME = Rz(−GMST)·r_ECEF：与 satPos 的定点取位同一式，逐位相等
    if (!(p.x === R[0] * c - R[1] * s && p.y === R[0] * s + R[1] * c && p.z === R[2])) bit = false
    const ecf = sat.eciToEcf(p, g)
    worst = Math.max(worst, Math.hypot(ecf.x - R[0], ecf.y - R[1], ecf.z - R[2]))
  }
  ok(bit, '两个时刻 posAt 位置 ＝ Rz(−GMST)·geodeticToEcef，逐位相等')
  ok(worst < 1e-9, '两个时刻转回地固系都落在 geodeticToEcef 那一点（不随 SGP4 飞走）', `${worst.toExponential(2)} km`)
  const cl = structuredClone(e.rec.__fix)
  ok(cl.sync === false && cl.r[0] === R[0], '__fix 可结构化克隆（聚焦几何 Worker 收得下）')
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
  ok(rb.includes('const treeOn = vis.has(TREE_SET)') && rb.includes('if (treeOn) add(treeGeoList.filter((e) => { const n = grdNodeOf(e._grdFolder); return !!n && satVisible(n) }))'), '渲染集收虚拟星：跟卫星集「卫星天线树」的眼睛，再逐颗跟树上的小眼睛')
  const iG = rb.indexOf("for (const id of vis) if (id[0] === 'g')"), iReal = rb.indexOf('entries = real'), iLnk = rb.indexOf('const e = liveEntryOf(n.noradId); if (e) linked.push(e)')
  ok(iG > 0 && iReal > iG && iLnk > iReal && rb.indexOf('add(linked)') > iLnk && /if \(!isTreeLinkedNode\(n\) \|\| !satVisible\(n\)\) continue/.test(rb), '「卫星天线树」里的关联星最后加（别的可见集同号对象先到先得）、不进 real')
  ok(body('function satEntryById(id) {').includes('treeGeoById.get(key)'), 'satEntryById 能按合成号取到（小眼睛关着、那一集关着也在）')
  const sy = body('function syncTreeGeo() {')
  ok(sy.includes('syncTreeGeoEntries(grdSats.value, treeGeoCache, orbitSatrec)') && sy.includes('stopFollow()') && sy.includes('closeCard()') && sy.includes('rebuildRenderSet()'), 'syncTreeGeo：根数星按 orbitSatrec 注入；掉出的条目移出聚焦集（先退出跟随），再重建渲染集')
  ok(sy.includes('for (const e of changed) modelMatchCache.delete(satKeyOf(e))') && sy.includes('poolEntries = null'), 'syncTreeGeo：rec 换了的条目作废模型自动匹配缓存；在选中集里的作废聚焦几何池那一份')
  ok(/watch\(\(\) => grdSats\.value\.map\(\(n\) => \(n && n\.kind !== 'elevline' && !n\.noradId \? `\$\{n\.folder\}\|\$\{n\.satName\}\|\$\{n\.lon\}\|\$\{n\.lat\}\|\$\{n\.altKm\}\|\$\{_elSig\(n\.elements\)\}\|\$\{satVisible\(n\) \? 1 : 0\}` : ''\)\)\.join\('\\n'\), syncTreeGeo, \{ immediate: true \}\)/.test(page), '树的增删改（含根数）/ 小眼睛 → syncTreeGeo')
  // TDZ：syncTreeGeo 的立即 watch 在 setup 期就调 orbitSatrec —— 那一块必须声明在它之前（也在条目表状态之前）
  const iOrb = page.indexOf('const customSatrecs = new Map()'), iFn = page.indexOf('function orbitSatrec(node) {'), iEl = page.indexOf("function elementsToSatrec(el) { return sat.omm2satrec(elementsOmm(el, 'SIM')) }")
  const iCache = page.indexOf('const treeGeoCache = new Map()'), iWatch = page.indexOf('syncTreeGeo, { immediate: true })')
  ok(iOrb > 0 && iFn > 0 && iEl > 0 && iOrb < iCache && iFn < iCache && iEl < iCache && iCache < iWatch, 'orbitSatrec 那一块（elementsToSatrec / customSatrecs）声明在条目表与立即 watch 之前（不撞 TDZ）')
  ok((page.match(/const customSatrecs = new Map\(\)/g) || []).length === 1 && (page.match(/function elementsToSatrec\(/g) || []).length === 1, '那一块只有一份（挪过去，不是复制）')
  // 历元跟节点走：页面不再有会话级共享历元（原 SIM_EPOCH 每次切回本页都换），根数 → omm2satrec 入参只走 treeOrbitEpoch.elementsOmm
  ok(!page.includes('SIM_EPOCH') && !/const MU = /.test(page) && page.includes("import { elementsOmm, normEpoch } from '../shared/treeOrbitEpoch.js'"), 'elementsToSatrec 用节点自己的历元（elementsOmm），页面没有 SIM_EPOCH / 第二份根数算式')
  ok(page.includes('const clockEpochISO = () => new Date(Math.floor(clock.tMs / 1000) * 1000).toISOString()') && /const defaultElements = \(\) => \(\{ altKm: 500, ecc: 0, incl: 53, raan: 0, argp: 0, ma: 0, epoch: clockEpochISO\(\) \}\)/.test(page), '新建星的根数草稿带历元 = 时间轴当前时刻（取整到秒）')
  const pf = body('function satPatchFrom(m, alert) {')
  ok(pf.includes("if (el.epoch == null || el.epoch === '') { epoch = clockEpochISO(); m.elements.epoch = epoch }") && pf.includes("else if (!(epoch = normEpoch(el.epoch))) { if (alert) appAlert('历元无效'); return null }") && pf.includes('ma: Number(el.ma) || 0, epoch }') && pf.indexOf('ma: Number(el.ma) || 0, epoch }') < pf.indexOf('elementsToSatrec(elements)'), 'satPatchFrom：重建根数时带上历元（规范化）；草稿没有就盖一次并写回草稿（播放中不反复盖）；解不出 → 拒收')
  ok(page.includes('<div class="srow stack"><label>历元</label><input class="ci" type="datetime-local" step="1" :value="satEpochVal()" @input="satEpochEdit = $event.target.value" @blur="satEpochDone" @keyup.enter="satEpochDone" /><span class="u">{{ satEpochTz() }}</span><span class="geobtn" title="设为时间轴当前时刻" @click="satEpochNow">此刻</span></div>') && page.indexOf('<label>历元</label><input class="ci" type="datetime-local"') < page.indexOf('v-model.number="satModal.elements.altKm"'), '弹窗根数块首行：历元（datetime-local 到秒 + 显示时区 + 「此刻」）')
  ok(!page.includes('@change="satEpochDone"'), '历元框只在回车 / 失焦提交：不接 change（Chromium 的 datetime-local 每键发 change，年份键到一半 0002 → 19xx 落库）')
  const sed = body('function satEpochDone() {')
  ok(body('function satEpochVal() {').includes('fmtGotoVal(Date.parse(ep))') && body('function satEpochTz() {').includes('return tzTag(tzMode.value, ep ? Date.parse(ep) : clock.tMs)') && sed.includes('const t = parseGotoVal(typed)') && body('function satEpochNow() {').includes('m.elements.epoch = clockEpochISO()') && page.includes('watch(satModal, () => { satPosEdit.value = null; satEpochEdit.value = null })'), '历元框按时间轴读数的时区档显示 / 解释（与跳到指定时刻同一套）；草稿随弹窗换星作废')
  ok(sed.includes('|| /^0/.test(typed)) return') && sed.indexOf('/^0/.test(typed)') < sed.indexOf('parseGotoVal(typed)'), '历元框：年份不足四位（首位 0）不收，回落到已存值')
  ok(page.includes('function scenarioEpochNow() { applyScenarioEpoch(new Date(Math.floor(clock.tMs / 1000) * 1000)) }') && !page.includes('applyScenarioEpoch(new Date())'), '自定义星座场景历元「当前」＝时间轴此刻（与树星「此刻」同一口径，不取系统时钟）')
  // 旧节点迁移（useGrdCoverage）：恢复 / 新建 / 改根数都补齐历元，补过就落盘；页面在自动落盘装上之后补存一次设置
  const gc = readFileSync(new URL('../../../src/viz/grd/useGrdCoverage.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const gbody = (sig) => { const i = gc.indexOf(sig), j = gc.indexOf('\n  }\n', i); return i >= 0 && j > i ? gc.slice(i, j) : '' }
  const we = gbody('function withEpoch(el, prev) {')
  ok(we.includes('if (!needsTreeEpoch(el)) return el') && we.includes('if (normEpoch(el.epoch)) return withTreeEpoch(el)') && we.includes('return pe ? { ...el, epoch: pe } : withTreeEpoch(el)'), 'withEpoch：已规范原样返回；带了能解的历元就规范化；没带先沿用节点已有的、再取旧数据常量')
  const rsb = gbody('function restoreSats() {')
  ok(rsb.includes('const elements = withEpoch(s.elements)') && rsb.includes('noradId: s.noradId || null, elements, els:') && rsb.includes('if (mig) { _epochMigrated = true; persistSats() }'), 'restoreSats：补历元并当场落 globe3d/grdSats')
  const rst = gc.slice(gc.indexOf('async function restoreState(st) {'), gc.indexOf('pendingCfgs.clear()', gc.indexOf('async function restoreState(st) {')))
  ok(rst.includes('const elements = withEpoch(ss.elements)') && rst.includes('const elements = withEpoch(ss.elements, node.elements)') && !rst.includes('node.elements = ss.elements') && rst.includes('if (mig) { _epochMigrated = true; if (loaded) persistSats() }'), 'restoreState：新建节点补历元；叠加时存档那份没带历元就沿用节点上的（不冲掉）')
  ok(gc.includes('elements: withEpoch(draft.elements),') && gbody('function updateSatellite(folder, patch) {').includes("if ('elements' in patch) patch = { ...patch, elements: withEpoch(patch.elements, n.elements) }") && /onTreeKeys, takeEpochMigrated,/.test(gc), 'addSatellite / updateSatellite 兜底补历元；导出 takeEpochMigrated')
  ok(page.indexOf('if (grd.takeEpochMigrated()) saveSettings()') > page.indexOf('watch(snapshot, saveSettings, { deep: true })'), '页面：迁移过就在自动落盘装上之后补存一次 globe3d/settings（别的窗口读这一份）')
  ok(page.includes("JSON.stringify({ t: nowMs, tMs: clock.tMs, pos, noEph })") && page.includes('const t = new Date(Number(tMs) || clock.tMs)'), 'grdLive 带场景时刻 tMs；liveSatPosAt 没给时刻取时间轴此刻（不取系统钟）')
  const pgl = body('function persistGrdLive() {')
  ok(pgl.includes('if (!_grdLiveTrail) _grdLiveTrail = setTimeout(() => { _grdLiveTrail = 0; persistGrdLive() }, Math.max(0, _grdLiveLast + 3000 - nowMs) + 20)') && pgl.indexOf('_grdLiveTrail = setTimeout') < pgl.indexOf('_grdLiveLast = nowMs') && pgl.includes('if (_grdLiveTrail) { clearTimeout(_grdLiveTrail); _grdLiveTrail = 0 }'), 'grdLive：被 3 s 闸挡下的那一拍补一次尾写（暂停 / 拖游标后 grdLive 跟到时间轴停下的那一刻）；真写了就撤')
  ok(page.includes('if (_grdLiveTrail) { clearTimeout(_grdLiveTrail); _grdLiveTrail = 0; _grdLiveGate.due(); persistGrdLive() }'), '离开 3D 页：排着的 grdLive 尾写立刻落')
  const el = body('async function ensureLinkedFolder(en) {')
  ok(el.includes('linkedNodesOf(grdSats.value, id, treeGeoIdMap.value)[0]') && el.indexOf('linkedNodesOf(grdSats.value, id, treeGeoIdMap.value)[0]') < el.indexOf('grd.addSatellite('), 'ensureLinkedFolder：定点星条目先认回它自己的节点（绝不再建一颗关联合成号的新星）')
  ok(page.includes("noradId: e._grdFolder ? '' : e.noradId, group:") && page.includes('function epochMsOf(rec) { return rec && !rec.__fix && Number.isFinite(rec.jdsatepoch) ? Math.round((rec.jdsatepoch + (rec.jdsatepochF || 0) - 2440587.5) * 864e5) : null }'), '信息栏：合成号不当 NORAD 显示、定点星不出历元；历元取整到毫秒（与 ③c 运行时同式）')
  const cf = body('function cardFor(e')   // 视频导出给它加了 tMs 参数（逐帧取读数）：按前缀找，签名再加参数也不失配
  ok(cf.includes("const epMs = e._grdFolder && e._treeKind !== 'orbit' ? null : epochMsOf(rec)") && cf.includes('epochMs: epMs,') && !/epochMsOf\(rec\) != null/.test(cf), '信息栏：天线树根数星出历元 / 历元龄（节点自己存的历元）；定点星不出')
  ok(cf.includes('const pin = !!(rec && rec.__fix && !rec.__fix.sync)') && cf.includes('const g = pin ? {} : (metricsFromEntry(e) || {})') && cf.includes('hasEl: !pin &&') && cf.includes("raan: rec && !pin ? ang(rec.nodeo) : ''"), '信息栏：非同步定点不出根数 / 区制 / 周期')
  ok(page.includes("const fid = tge ? satIdOf(tge) : 'f:' + node.folder") && body('function computeSatcovFocusGeometry() {').includes('add(fid, focusGeomStatic(node, node.elevColor))'), '对星聚焦特效：虚拟星按条目身份去重（被点选着时不画第二遍）')
  ok(body('function onSatSearch(e) {').includes('if (en._grdFolder) continue') && page.includes('if (!satModal.value || !en || en._grdFolder) return'), '添加 / 编辑卫星弹窗：搜索与点选都不收虚拟星条目（不许关联到合成号）')
  // 卫星集「卫星天线树」
  const rs = body('function registerSets() {')
  ok(rs.indexOf('TREE_SET,') > 0 && rs.indexOf('TREE_SET,') < rs.indexOf("BUILTIN_KEYS.map((k) => 'g:' + k)"), '注册表：卫星天线树恒登记、排在最前')
  const is = body('function initSatSets(legacy) {')
  ok(is.indexOf('const treeNew = !satSets.order.value.includes(TREE_SET)') > 0 && is.indexOf('const treeNew') < is.indexOf('registerSets()') && is.includes('const vis = [TREE_SET]') && is.includes('satSets.move(TREE_SET, 0)') && is.includes('satSets.setVisible([...satSets.visible.value, TREE_SET])'), '初始化：新装 / 升级上来第一次见到这一集 → 显示（升级的还置顶），地图上不少星')
  ok(page.includes("satSets.resetOrder([TREE_SET, ...BUILTIN_KEYS.map((k) => 'g:' + k)])"), '恢复默认顺序：卫星天线树在最前')
  ok(body('async function setSatsOf(id) {').includes("if (k === 't') return treeSetMembers(grdSats.value, treeGeoIdMap.value)"), '成员名录走天线树（不拿 \'tree\' 去联网读组名录）')
  ok(body('async function setColorOf(row, hex) {').includes("if (k === 'tree') { if (hex) setGroupColor(TREE_GEO_GROUP, hex); else resetGroupColor(TREE_GEO_GROUP); return }") && TREE_GEO_GROUP === 'grdtree', '星点色走 groupColors[grdtree]（与内置组同一套，随设置持久化）')
  const { kindOf } = await import('../../../src/viz/constellation/useSatSets.js')
  ok(kindOf('t:tree') === 'tree' && kindOf('g:geo') === 'builtin', "useSatSets.kindOf('t:tree') = 'tree'")
  ok(page.includes('const selFolderSet = computed(() => foldersForNorads(grdSats.value, selNoradList.value, treeGeoIdMap.value))'), '树上高亮认合成号')
  ok(page.includes('treeFollowFolder(grdSats.value, selPrimNorad.value, bs.satFolder.value, treeGeoIdMap.value)'), '波束合成跟随主选认合成号')
  ok((page.match(/linkedNodesOf\(grdSats\.value, [^)]*\)/g) || []).every((s) => s.includes('treeGeoIdMap.value')), '页面里每一处 linkedNodesOf 都带合成号映射')
  // 合成号不当 NORAD 显示：搜索结果 / 卫星组 / 查找对话框的成员行碰到天线树虚拟星都走 expTreeItem
  const xt = body('function expTreeItem(id, name, dot) {')
  ok(xt.includes('tip: nm') && !xt.includes('NORAD'), 'expTreeItem：悬停只给名字、行右小字不带号')
  ok(page.includes('(e._grdFolder ? expTreeItem(e.noradId, e.name, \'\') : expMkItem(') && page.includes('(isTreeGeoId(s.id) ? expTreeItem(s.id, s.name,') && page.includes('(en._grdFolder ? expTreeItem(en.noradId, en.name, \'\')'), '搜索结果 / 卫星组（含死号）/ 查找对话框：虚拟星成员行不出合成号')
  // 可见性分析「当前显示」标签：天线树一颗星都没往图上加时不算一集
  const sl = page.slice(page.indexOf('const satSetLabel = computed(() => {'), page.indexOf('// 【必须等在建的那一次】'))
  ok(sl.includes("(id !== TREE_SET || treeAdds())") && sl.includes('some((m) => satVisible(m.node))') && sl.includes('name: setName(ids[0])'), '卫星集标签：空的「卫星天线树」不并进「混合 · …」，名字与种类取自同一份 id 表')
  // 标题栏「在星座中搜索」：同一个词再搜一次也要重新展开下拉
  ok(page.includes('covNav.searchSats = (q) => { onSearch({ target: { value: q } }); searchOpenTick.value++ }') && page.includes('openTick: searchOpenTick.value,'), '标题栏搜索桥每调一次递增 openTick')
  const lp = readFileSync(new URL('../../../src/components/SatLayersPanel.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  ok(lp.includes('(k) => setDrop(!!k), { immediate: true })') && lp.includes('watch(() => props.search && props.search.openTick, () => {'), '搜索下拉：面板重挂时有词就展开；openTick 一变重新展开并聚焦')
}

// ---------- ⑦ 别的窗口读树（NGSO / 再生式 / 端到端 / 模型工作台）：satTree.loadSatTree 把历元规范一次 ----------
{
  const mem = new Map(), prevLS = globalThis.localStorage
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)) }, removeItem: (k) => { mem.delete(k) } }
  const { loadSatTree } = await import('../../../src/ngso/satTree.js')
  const el = { altKm: 550, ecc: 0, incl: 53, raan: 0, argp: 0, ma: 0 }
  mem.set('globe3d/settings', JSON.stringify({ grd: { sats: [
    { folder: 'OLD', satName: 'OLD', kind: 'orbit', elements: el },
    { folder: 'NOZ', satName: 'NOZ', kind: 'orbit', elements: { ...el, epoch: '2026-10-06T02:30:00' } },
    { folder: 'Z', satName: 'Z', kind: 'orbit', elements: { altKm: 1200, ecc: 0.01, incl: 87, raan: 5, argp: 6, ma: 7, epoch: '2026-10-06T02:30:00.000Z' } },
    { folder: 'FIX', satName: 'FIX', kind: 'custom', lon: 100, lat: 0, altKm: 35786, elements: null }
  ] } }))
  const t = loadSatTree().sats, by = (f) => t.find((s) => s.folder === f) || {}
  ok(by('OLD').elements && by('OLD').elements.epoch === TREE_ORBIT_LEGACY_EPOCH && by('OLD').elements.altKm === 550 && by('OLD').elements.incl === 53, '没迁移的旧节点：elements.epoch = TREE_ORBIT_LEGACY_EPOCH（与 3D 页迁移写进去的同一个值），其余根数不动')
  ok(by('NOZ').elements && by('NOZ').elements.epoch === '2026-10-06T02:30:00.000Z', '不带时区的历元按 UTC 规范成带 Z 的串', by('NOZ').elements && by('NOZ').elements.epoch)
  ok(by('Z').elements && by('Z').elements.epoch === '2026-10-06T02:30:00.000Z' && by('Z').elements.ma === 7 && by('Z').elements.ecc === 0.01, '已规范的历元与根数原样带出')
  ok(by('FIX').elements === null && by('FIX').lon === 100, '定点星 elements 仍为 null')
  globalThis.localStorage = prevLS
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail) process.exit(1)
