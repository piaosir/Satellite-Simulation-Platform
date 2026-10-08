// 模型工作台「卫星」页选星下拉的纯逻辑（src/model/satPickLogic.js）单测：树节点绑定键与 3D 页同规则（NORAD < 800000 / 合成号查池 /
// 回退 name: / 无 NORAD → grdsat: / 仰角线跳过 / 同星两节点只出一行）、轨道区制、四路来源去重优先级与 hint 并集、
// 已绑定行借别的来源的名字、筛选、编目组只在有搜索词时出现、按键回填 metaForKey、等不等候选池（treeKeyNeedsPool / keyNeedsPool）、
// 旧 grdsat: 绑定（关联合成号的节点）认回节点。
// 裸 node 跑：satPickLogic.js 只 import packages/core 与 src/shared 的零依赖模块（相对路径），不碰 satellite.js / vue / DOM。
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(path.join(HERE, p)).href)
const L = await imp('../../../src/model/satPickLogic.js')
const SCH = await imp('../models/schema.mjs')

let n = 0
const ok = (name, fn) => { fn(); n++ }

// 池行（satSources.catalogPool 的形状）：{rec, key, name, altName, norad, group}
const poolRow = (rec, key, group = '') => ({ rec, key, name: rec.name, altName: rec.altName || '', norad: String(rec.noradId || ''), group })
const ISS = { name: 'ISS (ZARYA)', noradId: '25544', orbitType: 'omm', meanMotion: '15.5', ecc: '0.0005', incl: '51.6' }
const CS6E = { name: 'CHINASAT 6E', noradId: '58700', orbitType: 'omm', meanMotion: '1.0027', ecc: '0.0002', incl: '0.05' }
const EPH = { name: 'SAT-A', noradId: '800003', orbitType: 'ephem', ref: { groupId: 'g1', key: 'A' }, meanMotion: null }
const CC = { name: 'W-1-1', noradId: '900000', orbitType: 'elements', elements: { altKm: 550, ecc: 0, incl: 53 }, meanMotion: '15.06' }
const pool = [poolRow(ISS, 'norad:25544'), poolRow(CS6E, 'norad:58700', 'GEO'), poolRow(EPH, 'ephem:g1:A', '星历 · g'), poolRow(CC, 'cc:c1:W-1-1', '自定义 · W')]
const byNorad = new Map(pool.map((x) => [x.norad, x]))
const byKey = new Map(pool.map((x) => [x.key, x]))

ok('树节点绑定键：与 3D 页 grdSatKeyOfNode 同规则', () => {
  assert.equal(L.treeKeyOf({ folder: 'f1', satName: 'ISS', noradId: '25544' }), 'norad:25544')
  assert.equal(L.treeKeyOf({ folder: 'f1', satName: 'ISS', noradId: '00025544' }), 'norad:25544', '前导零去掉')
  assert.equal(L.treeKeyOf({ folder: 'f1', satName: 'X', noradId: 799999 }), 'norad:799999')
  // ≥ 800000：查池拿星历 / 自定义星座的键；池里没有退 name:<星名>；池没给也退 name:
  assert.equal(L.treeKeyOf({ folder: 'f2', satName: '点序列星', noradId: '800003' }, byNorad), 'ephem:g1:A')
  assert.equal(L.treeKeyOf({ folder: 'f3', satName: 'W 星', noradId: 900000 }, byNorad), 'cc:c1:W-1-1')
  assert.equal(L.treeKeyOf({ folder: 'f4', satName: ' 合成星 ', noradId: '812345' }, byNorad), 'name:合成星')
  assert.equal(L.treeKeyOf({ folder: 'f4', satName: '合成星', noradId: '800003' }), 'name:合成星')
  assert.notEqual(L.treeKeyOf({ folder: 'f4', satName: '合成星', noradId: '800003' }), SCH.grdSatKey('f4'), '旧实现的 grdsat: 是错的')
  // 没有 NORAD → grdsat:<folder>；仰角线不是卫星
  assert.equal(L.treeKeyOf({ folder: 'cs26', satName: 'CS26', noradId: null, lon: 125 }), 'grdsat:cs26')
  assert.equal(L.treeKeyOf({ folder: 'el1', satName: '仰角线', kind: 'elevline' }), null)
  assert.equal(L.treeKeyOf(null), null)
  // 与 core satKeyOf 对「没解析到条目」的回退一致（3D 页 satKeyOf({noradId, name})）
  assert.equal(L.treeKeyOf({ folder: 'f5', satName: 'Y', noradId: '812345' }), SCH.satKeyOf({ noradId: '812345', name: 'Y' }))
  assert.equal(L.treeKeyOf({ folder: 'f5', satName: 'Y', noradId: '1234' }), SCH.satKeyOf({ noradId: '1234', name: 'Y' }))
})

ok('树行：跳过仰角线、同星两节点合一行（天线数合计）、区制 / 轨位 / 高度 / NORAD 进副行、hint 带节点与池记录', () => {
  const nodes = [
    { folder: 'a', satName: '空间站', noradId: '25544', antennas: [{ name: 'A1' }] },
    { folder: 'el', satName: '仰角线 10°', kind: 'elevline' },
    { folder: 'b', satName: '空间站（备）', noradId: 25544, antennas: [{ name: 'B1' }, { name: 'B2' }] },
    { folder: 'cs26', satName: 'CS26', lon: 125, lat: 0, altKm: 35786, antennas: [] },
    { folder: 'leo', satName: '根数星', elements: { altKm: 600, ecc: 0.001, incl: 97.6 } },
    { folder: 'eph', satName: '点序列星', noradId: '800003' }
  ]
  const rows = L.treeRows(nodes, byNorad)
  assert.deepEqual(rows.map((r) => r.key), ['norad:25544', 'grdsat:cs26', 'grdsat:leo', 'ephem:g1:A'])
  const iss = rows[0]
  assert.equal(iss.name, '空间站', '同键取第一个节点')
  assert.match(iss.sub, /^NORAD 25544 · LEO · 3 /, '天线数 1 + 2')
  assert.equal(iss.src, 'tree')
  assert.equal(iss.hint.treeNode, nodes[0])
  assert.equal(iss.hint.poolRec, ISS)
  assert.equal(iss.hint.orbitKind, 'LEO')
  assert.deepEqual(iss.terms, ['a', 'b'])
  assert.equal(rows[1].hint.orbitKind, 'GEO')
  assert.ok(rows[1].sub.includes('GEO') && rows[1].sub.includes('125.0°E'), rows[1].sub)
  assert.equal(rows[2].hint.orbitKind, 'LEO')
  assert.ok(rows[2].sub.includes('600 km'), rows[2].sub)
  assert.equal(rows[3].hint.poolRec, EPH)
  assert.equal(rows[3].hint.orbitKind, '', '星历点序列没有根数')
  // 池没就绪：关联星不按存盘星下点猜区制（loadSatTree 给缺高度的补 GEO 高度）
  const r0 = L.treeRows([{ folder: 'x', satName: 'X', noradId: '25544', lon: 0, lat: 0, altKm: 35786 }])
  assert.equal(r0[0].hint.orbitKind, '')
  assert.equal(r0[0].hint.poolRec, undefined)
})

ok('轨道区制：平均运动 / 六根数 / 池记录', () => {
  assert.equal(L.kindOfMeanMotion(1.00273896, 0, 0), 'GEO')
  assert.equal(L.kindOfMeanMotion('15.5', '0.0005', '51.6'), 'LEO')
  assert.equal(L.kindOfMeanMotion(2.0056, 0.001, 55), 'MEO')
  assert.equal(L.kindOfMeanMotion(null, 0, 0), '')
  assert.equal(L.kindOfElements({ altKm: 35786, ecc: 0, incl: 0 }), 'GEO')
  assert.equal(L.kindOfElements({ altKm: 500, ecc: 0.7, incl: 63.4 }), 'HEO')
  assert.equal(L.poolOrbitKind(CS6E), 'GEO')
  assert.equal(L.poolOrbitKind(CC), 'LEO')
  assert.equal(L.poolOrbitKind(EPH), '')
})

ok('链路预算 / 已绑定 / 编目行', () => {
  const lb = L.lbRows([
    { ns: 'geo', id: 's1', name: '中星 6E', summary: 'Ku · 125°', form: { orbitPosition: '125' } },
    { ns: 'ngso', id: 's2', name: 'LEO-1', summary: '', ngsoSat: { orbit: { type: 'elements', altKm: 550, ecc: 0, incl: 53 } } },
    { ns: 'geo', id: 's1', name: '重复' },
    { ns: 'bad ns', id: 's3', name: '坏命名空间' },
    null
  ])
  assert.deepEqual(lb.map((r) => r.key), ['lbsat:geo:s1', 'lbsat:ngso:s2'])
  assert.equal(lb[0].sub, 'GEO · Ku · 125°')
  assert.equal(lb[0].hint.orbitKind, 'GEO')
  assert.equal(lb[1].hint.orbitKind, 'LEO')
  assert.equal(lb[1].hint.lbEntry.id, 's2')
  const bd = L.boundRows([{ key: 'norad:25544', label: 'NORAD 25544', n: 2 }, { key: '', label: 'x', n: 0 }])
  assert.deepEqual(bd, [{ key: 'norad:25544', name: 'NORAD 25544', sub: 'norad:25544', src: 'bound', hint: null, n: 2 }])
  const cat = L.catalogRows([pool[0], pool[3]])
  assert.equal(cat[0].sub, 'NORAD 25544 · LEO')
  assert.equal(cat[1].sub, 'LEO · 自定义 · W', '合成号不显示 NORAD')
  assert.equal(cat[0].hint.poolRec, ISS)
})

ok('合并：同键只出一次（已绑定 > 树 > 库 > 编目）、hint 并集、已绑定行借名字、挂点数', () => {
  const bound = L.boundRows([{ key: 'norad:25544', label: 'NORAD 25544', n: 2 }, { key: 'grdsat:gone', label: 'gone', n: 1 }, { key: 'lbsat:geo:s1', label: 's1', n: 0 }])
  const tree = L.treeRows([{ folder: 'a', satName: '空间站', noradId: '25544', antennas: [{ name: 'A1' }] }, { folder: 'cs26', satName: 'CS26', lon: 125, altKm: 35786 }])
  const lb = L.lbRows([{ ns: 'geo', id: 's1', name: '中星 6E', summary: 'Ku', form: { orbitPosition: '125' } }])
  const cat = L.catalogRows([pool[0], pool[1]])
  const gs = L.mergeGroups({ bound, tree, lb, cat }, '')
  assert.deepEqual(gs.map((g) => g.key), ['bound', 'tree'], '空搜索词：编目组不出；库条目已在已绑定组里，库组空了不出')
  assert.deepEqual(gs.map((g) => g.title), ['已绑定', '卫星天线树'])
  const b = gs[0].rows
  assert.deepEqual(b.map((r) => r.key), ['norad:25544', 'grdsat:gone', 'lbsat:geo:s1'])
  assert.equal(b[0].name, '空间站', '已绑定行借树上的名字')
  assert.match(b[0].sub, /^NORAD 25544/)
  assert.equal(b[0].n, 2)
  assert.equal(b[0].hint.treeNode.folder, 'a')
  assert.equal(b[0].hint.poolRec, undefined, '空搜索词：编目行不参与合并')
  assert.equal(b[0].hint.orbitKind, undefined, '树没拿到池：关联星区制留空')
  assert.equal(b[1].name, 'gone', '没有别的来源：保留键名兜底')
  assert.equal(b[1].sub, 'grdsat:gone')
  assert.equal(b[1].hint, null)
  assert.equal(b[2].name, '中星 6E')
  assert.equal(b[2].hint.lbEntry.id, 's1')
  assert.equal(b[2].n, 0)
  assert.deepEqual(gs[1].rows.map((r) => r.key), ['grdsat:cs26'])
  assert.equal(gs[1].rows[0].n, null)
  // 有搜索词：编目组出现，已在别组的键去重；hint 并集（树行 + 编目行）
  const g2 = L.mergeGroups({ bound: [], tree, lb, cat: L.catalogRows([pool[1]]) }, 'chinasat')   // 不命中任何非编目行
  assert.deepEqual(g2.map((g) => g.key), ['cat'])
  assert.deepEqual(g2[0].rows.map((r) => r.key), ['norad:58700'])
  const g3 = L.mergeGroups({ bound: [], tree, lb, cat }, '25544')
  assert.deepEqual(g3.map((g) => g.key), ['tree', 'cat'])
  assert.deepEqual(g3[0].rows.map((r) => r.key), ['norad:25544'])
  assert.deepEqual(g3[1].rows.map((r) => r.key), ['norad:58700'], '25544 已在树组，编目组只剩别的')
  // 编目命中、树行本身文字不命中：整键可见，出现在更靠前的树组里（名字仍是树上的）
  const g4 = L.mergeGroups({ tree, cat: L.catalogRows([pool[0]]) }, 'zarya')
  assert.deepEqual(g4.map((g) => g.key), ['tree'])
  assert.equal(g4[0].rows[0].name, '空间站')
  assert.equal(g4[0].rows[0].hint.poolRec, ISS)
  // 每个键全局只出现一次
  const keys = L.mergeGroups({ bound, tree, lb, cat }, 'a').flatMap((g) => g.rows.map((r) => r.key))
  assert.equal(new Set(keys).size, keys.length)
})

ok('筛选：名称 / 副行 / 键 / folder / 常用名，归一（大小写、空格、连字符、括号）', () => {
  const tree = L.treeRows([{ folder: 'fold_x', satName: 'Zhong-Xing 6E', noradId: null, lon: 125, altKm: 35786 }])
  const f = (q) => L.mergeGroups({ tree }, q).length
  assert.equal(f('zhongxing6e'), 1)
  assert.equal(f('ZHONG XING'), 1)
  assert.equal(f('（6E）'), 1)
  assert.equal(f('125.0'), 1, '副行里的轨位')
  assert.equal(f('grdsat'), 1, '键')
  assert.equal(f('FOLDX'), 1, 'folder')
  assert.equal(f('starlink'), 0)
  assert.equal(L.matchQ('', 'x'), true)
  assert.equal(L.matchQ('iss', 'ISS (ZARYA)'), true)
  const cat = L.catalogRows([{ ...pool[0], altName: 'ZARYA' }])
  assert.equal(L.mergeGroups({ tree: [], cat }, 'q').length, 1, '编目行是池搜索的命中，本身不再筛')
})

ok('metaForKey：按键回填名字与 hint（树 > 库 > 池），找不到 null', () => {
  const tree = L.treeRows([{ folder: 'a', satName: '空间站', noradId: '25544' }, { folder: 'cs26', satName: 'CS26', lon: 125, altKm: 35786 }], byNorad)
  const lb = L.lbRows([{ ns: 'geo', id: 's1', name: '中星 6E', form: { orbitPosition: '125' } }])
  const m1 = L.metaForKey('norad:25544', { tree, lb, poolByKey: byKey })
  assert.equal(m1.label, '空间站')
  assert.equal(m1.hint.treeNode.folder, 'a')
  assert.equal(m1.hint.poolRec, ISS)
  assert.equal(m1.hint.orbitKind, 'LEO')
  const m2 = L.metaForKey('norad:58700', { tree, lb, poolByKey: byKey })
  assert.equal(m2.label, 'CHINASAT 6E', '只有池里有：取池名')
  assert.equal(m2.hint.orbitKind, 'GEO')
  assert.equal(L.metaForKey('grdsat:cs26', { tree }).label, 'CS26')
  assert.equal(L.metaForKey('lbsat:geo:s1', { tree, lb }).hint.lbEntry.id, 's1')
  assert.equal(L.metaForKey('cc:c1:W-1-1', { poolByKey: byKey }).hint.poolRec, CC)
  assert.equal(L.metaForKey('norad:1', { tree, lb, poolByKey: byKey }), null)
  assert.equal(L.metaForKey('', {}), null)
})

ok('等不等候选池：合成号树节点的键、在池里的键（grdsat 只认关联了 NORAD 的旧键）', () => {
  assert.equal(L.treeKeyNeedsPool({ folder: 'f', satName: 'W', noradId: '900000' }), true, '合成号：池没好只能给临时 name:')
  assert.equal(L.treeKeyNeedsPool({ folder: 'f', satName: 'ISS', noradId: '25544' }), false, '目录号键不变')
  assert.equal(L.treeKeyNeedsPool({ folder: 'f', satName: 'CS26', lon: 125 }), false)
  assert.equal(L.treeKeyNeedsPool({ folder: 'el', kind: 'elevline', noradId: '900000' }), false)
  assert.equal(L.treeKeyNeedsPool(null), false)
  const nodes = [{ folder: 'w', satName: 'W', noradId: '900000' }, { folder: 'cs26', satName: 'CS26', lon: 125 }]
  for (const k of ['norad:25544', 'cc:c1:W-1-1', 'ephem:g1:A', 'name:X']) assert.equal(L.keyNeedsPool(k, nodes), true, k)
  assert.equal(L.keyNeedsPool('lbsat:geo:s1', nodes), false)
  assert.equal(L.keyNeedsPool('grdsat:cs26', nodes), false, '定点星不在池里')
  assert.equal(L.keyNeedsPool('grdsat:w', nodes), true, '旧键：节点关联了合成号')
  assert.equal(L.keyNeedsPool('grdsat:w'), false, '没给树')
  assert.equal(L.keyNeedsPool('', nodes), false)
})

ok('旧 grdsat: 绑定（关联合成号的节点）：已绑定行认回节点星名与 hint，副行留键；metaForKey 同样认', () => {
  const nodes = [{ folder: 'w', satName: 'W 星', noradId: '900000', antennas: [{ name: 'A' }] }]
  const tree = L.treeRows(nodes, byNorad)
  assert.equal(tree[0].key, 'cc:c1:W-1-1')
  assert.deepEqual(tree[0].folders, ['w'])
  const bound = L.boundRows([{ key: 'grdsat:w', label: 'w', n: 3 }, { key: 'grdsat:gone', label: 'gone', n: 1 }])
  const gs = L.mergeGroups({ bound, tree }, '')
  assert.deepEqual(gs.map((g) => g.key), ['bound', 'tree'], '旧键与现行键各一行')
  const old = gs[0].rows[0]
  assert.equal(old.key, 'grdsat:w')
  assert.equal(old.name, 'W 星')
  assert.equal(old.sub, 'grdsat:w', '副行留键，与现行那行区分')
  assert.equal(old.n, 3)
  assert.equal(old.hint.treeNode, nodes[0])
  assert.equal(old.hint.poolRec, CC)
  assert.equal(gs[0].rows[1].name, 'gone', '找不到节点：键名兜底')
  assert.deepEqual(gs[1].rows.map((r) => r.key), ['cc:c1:W-1-1'])
  // 按节点星名能搜到旧键那行
  const g2 = L.mergeGroups({ bound, tree }, 'w星')
  assert.deepEqual(g2.flatMap((g) => g.rows.map((r) => r.key)), ['grdsat:w', 'cc:c1:W-1-1'])
  const m = L.metaForKey('grdsat:w', { tree })
  assert.equal(m.label, 'W 星')
  assert.equal(m.hint.poolRec, CC)
  // 节点没关联 NORAD：grdsat 就是现行键，不走旧键那条
  const t2 = L.treeRows([{ folder: 'cs26', satName: 'CS26', lon: 125, altKm: 35786 }])
  const g3 = L.mergeGroups({ bound: L.boundRows([{ key: 'grdsat:cs26', label: 'cs26', n: 1 }]), tree: t2 }, '')
  assert.deepEqual(g3.map((g) => g.key), ['bound'])
  assert.equal(g3[0].rows[0].sub, t2[0].sub)
})

ok('mergeHint：只补空缺，不覆盖；没补东西返回原对象', () => {
  const base = { treeNode: { folder: 'a' }, orbitKind: '' }
  const out = L.mergeHint(base, { orbitKind: 'GEO', treeNode: { folder: 'b' }, poolRec: null })
  assert.notEqual(out, base)
  assert.deepEqual(out, { treeNode: { folder: 'a' }, orbitKind: 'GEO' })
  assert.equal(L.mergeHint(out, { orbitKind: 'LEO' }), out)
  assert.equal(L.mergeHint(null, null), null)
  assert.deepEqual(L.mergeHint(null, { poolRec: ISS }), { poolRec: ISS })
})

console.log(`modelSatPick: ${n} 项通过`)
