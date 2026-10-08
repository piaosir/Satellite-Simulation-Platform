// 「链路分析」视图在面板里选节点：插入位判据（mapLinks.slotAccepts / slotIssue）、跳几何（viz/links/linkGeom.js）、
// 插入光标（useMapLinks：startNew / startAt / addNode / undoNode / replaceNode / removeNode / 悬停预览）、
// 候选来源（viz/links/linkPickSource.js：分组 / 灰显 / 按几何排序 / 常用星置顶 / 检索相关度 / 卫星集检索范围 / 星位缓存与作废）。
//
// 关键不变式：
//   ① 图上点选与面板选择往同一个插入光标插，插完光标后移；撤销只撤本次插入态里最后插的那个（原有节点不碰）；删光标前的节点光标跟着前移；
//   ② 该位前后有地面端就不列地面端（站接站），与邻节点相同的灰显；判据与 linkIssues 同口径；
//   ③ 替换卫星时转发方式 / 激光位留在这一位；
//   ④ 候选按「放进这一位」的几何排：可见在前、仰角降序；常用星（链路中 / 聚焦 / 天线树）恒在场景星之前。
import { ref } from 'vue'
import { slotAccepts, slotIssue, ISSUE_TEXT } from '../models/mapLinks.mjs'
import { hopGeom, slotFit, cmpFit } from '../../../src/viz/links/linkGeom.js'
import { useMapLinks } from '../../../src/viz/links/useMapLinks.js'
import { createLinkPickSource, matchRank, queryTerms, nfk, compact, MISS_TEXT, PICK_SAT_ROOT } from '../../../src/viz/links/linkPickSource.js'
import * as W from '../../../src/viz/wgs84.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
}

const ST = (id) => ({ k: 'st', id })
const PT = (id) => ({ k: 'pt', id })
const SAT = (key) => ({ k: 'sat', key, name: key })
const geo = (lon) => W.geodeticToEcef(lon, 0, 35786)
const gnd = (lat, lon) => ({ ground: true, lat, lon, ecef: W.geodeticToEcef(lon, lat, 0) })
const spc = (ecef) => ({ ground: false, ecef })

// ---- ① 插入位判据 ----
ok('链头空位：地面端 / 卫星都能放', slotAccepts(null, null).ground && slotAccepts(null, null).sat)
ok('站之后：不能放地面端', !slotAccepts(ST('a'), null).ground)
ok('点标记之前：不能放地面端', !slotAccepts(null, PT('p')).ground)
ok('两颗星之间：能放地面端（地面转接站）', slotAccepts(SAT('x'), SAT('y')).ground)
ok('与前邻相同 = same', slotIssue(SAT('x'), SAT('x'), null) === 'same')
ok('与后邻相同 = same', slotIssue(null, ST('a'), ST('a')) === 'same')
ok('站接站 = st-st', slotIssue(ST('a'), ST('b'), null) === 'st-st')
ok('站 → 星 → 站之间插星：可放', slotIssue(ST('a'), SAT('x'), SAT('y')) === '')
ok('问题码都有短句', !!ISSUE_TEXT.same && !!ISSUE_TEXT['st-st'])

// ---- ② 跳几何 ----
{
  const bj = gnd(39.9, 116.4), ny = gnd(40.7, -74.0), s = spc(geo(110.5))
  const up = hopGeom(bj, s, 0), far = hopGeom(ny, s, 0)
  ok('北京看 110.5°E GEO：仰角为正、可见', up.el > 30 && up.vis, String(up.el))
  ok('纽约看 110.5°E GEO：地平线下、不可见', far.el < 0 && !far.vis, String(far.el))
  ok('门限抬到 60°：北京那一跳不可见', !hopGeom(bj, s, 60).vis)
  const isl = hopGeom(spc(geo(100)), spc(geo(110)), 0)
  ok('GEO 星间 10°：视线不擦地、无仰角、有距离', isl.vis && isl.el == null && isl.rangeKm > 7000 && isl.rangeKm < 7500, String(isl.rangeKm))
  ok('GEO 星间 170°：被地球挡住', !hopGeom(spc(geo(0)), spc(geo(170)), 0).vis)
  const f = slotFit(bj, s, gnd(23.1, 113.3), 0)
  ok('站-星-站：两跳都可见、读数取较低仰角', f.n === 2 && f.vis && f.el <= up.el + 1e-9)
  ok('没有邻居：n = 0、不可比', slotFit(null, s, null, 0).n === 0)
  const a = slotFit(bj, s, null, 0), b = slotFit(ny, s, null, 0)
  ok('排序：可见在前', cmpFit(a, b) < 0 && cmpFit(b, a) > 0)
  ok('排序：算不出几何的在后', cmpFit(a, { n: 0 }) < 0)
}

// ---- ③ 插入光标 ----
const stations = ref([
  { id: 's1', name: '北京站', lat: 39.9, lon: 116.4 },
  { id: 's2', name: '广州站', lat: 23.1, lon: 113.3 },
  { id: 's3', name: '纽约站', lat: 40.7, lon: -74.0 }
])
const points = ref([])
const links = ref([])
const SATPOS = { 'norad:1': geo(110.5), 'norad:2': geo(134.5), 'norad:3': geo(-70), 'norad:4': geo(87.5) }
let idSeq = 0
const lnk = useMapLinks({
  links, stations, points, newId: () => 'L' + (++idSeq),
  commit: () => {}, satEcefAt: (k) => SATPOS[k] || null, satInfo: () => null, status: () => {}
})
{
  const id = lnk.startNew()
  ok('新建：光标在 0', lnk.cursorOf(id) === 0)
  ok('插站', lnk.addNode(ST('s1')) === '' && lnk.cursorOf(id) === 1)
  ok('站后再插站被拒、光标不动', lnk.addNode(ST('s2')) === ISSUE_TEXT['st-st'] && lnk.cursorOf(id) === 1)
  lnk.addNode(SAT('norad:1')); lnk.addNode(ST('s2'))
  const l = lnk.linkOf(id)
  ok('依次插三个：北京 → 星1 → 广州，光标在尾', l.nodes.map((n) => n.id || n.key).join(',') === 's1,norad:1,s2' && lnk.cursorOf(id) === 3)
  lnk.undoNode()
  ok('撤销删光标前那个', l.nodes.length === 2 && lnk.cursorOf(id) === 2)
  lnk.addNode(ST('s2'))
  lnk.startAt(id, 1)
  ok('同一条挪光标：仍在插入态、快照不变（新建的那条）', lnk.cursorOf(id) === 1 && lnk.draw.value.isNew === true)
  ok('中间插星：北京 → 星2 → 星1 → 广州', lnk.addNode(SAT('norad:2')) === '' && l.nodes.map((n) => n.id || n.key).join(',') === 's1,norad:2,norad:1,s2' && lnk.cursorOf(id) === 2)
  ok('中间再插与后邻相同的星被拒', lnk.addNode(SAT('norad:1')) === ISSUE_TEXT.same)
  lnk.removeNode(id, 0)
  ok('删光标前的节点：光标跟着前移', lnk.cursorOf(id) === 1)
  lnk.startAt(id, 0)
  lnk.addNode(ST('s1'))
  ok('光标挪到链头补回北京站', l.nodes.map((n) => n.id || n.key).join(',') === 's1,norad:2,norad:1,s2' && lnk.cursorOf(id) === 1)
  lnk.finish()
  ok('完成：退出插入态、链路保留', lnk.draw.value === null && !!lnk.linkOf(id) && lnk.cursorOf(id) === -1)

  // 替换：卫星换卫星，转发方式 / 激光位留在这一位
  l.nodes[1].regen = true; l.nodes[1].laser = true
  ok('替换成与邻节点相同的被拒', lnk.replaceNode(id, 1, SAT('norad:1')) === ISSUE_TEXT.same)
  ok('卫星换卫星', lnk.replaceNode(id, 1, SAT('norad:4')) === '' && l.nodes[1].key === 'norad:4')
  ok('这一位的再生 / 激光位留下', l.nodes[1].regen === true && l.nodes[1].laser === true)
  ok('站换成站之间夹着星可以', lnk.replaceNode(id, 0, ST('s3')) === '' && l.nodes[0].id === 's3')

  // 已有链路在中间进入插入态，取消回到进入前
  const before = JSON.stringify(l.nodes)
  lnk.startAt(id, 2)
  lnk.addNode(ST('s1'))
  lnk.cancel()
  ok('已有链路：取消恢复原样', JSON.stringify(lnk.linkOf(id).nodes) === before)

  // 新建后取消：整条丢掉
  const id2 = lnk.startNew(ST('s2'))
  ok('从站新建：光标在 1', lnk.cursorOf(id2) === 1)
  lnk.cancel()
  ok('新建后取消：整条丢掉', !lnk.linkOf(id2))

  // 悬停预览：多出一条 ':pv' 载荷、两跳都是虚线
  lnk.preview.value = { id, at: 1, rep: false, node: ST('s2') }
  const r = lnk.compute(Date.UTC(2026, 9, 7))
  const g = r.scene.find((x) => x.id === id + ':pv')
  ok('预览：载荷带一条虚线跳（站接站那一侧不画）', !!g && g.hops.length === 1 && g.hops.every((h) => h.vis === false))
  lnk.preview.value = { id, at: 1, rep: false, node: SAT('norad:2') }
  const g2 = lnk.compute(Date.UTC(2026, 9, 7)).scene.find((x) => x.id === id + ':pv')
  ok('预览候选是星：两跳 + 一枚星点', !!g2 && g2.hops.length === 2 && g2.sats.length === 1)
  lnk.preview.value = null
  ok('清预览', !lnk.compute(Date.UTC(2026, 9, 7)).scene.some((x) => String(x.id).endsWith(':pv')))
}

// ---- ③b 撤销只撤本次插入态里插进去的节点（2026-10-08 #25：在已有链路上接着加时，横幅「撤销」/ Backspace 会把原有节点删掉）----
{
  const names = (l) => l.nodes.map((n) => n.id || n.key).join(',')
  const id = lnk.startNew(ST('s1'))
  ok('新建：起点也算这次加的、可撤销', lnk.canUndo() === true)
  lnk.addNode(SAT('norad:1')); lnk.addNode(ST('s2'))
  lnk.finish()
  const l = lnk.linkOf(id)
  ok('建好一条三节点链路', names(l) === 's1,norad:1,s2')
  lnk.startAt(id)                                                     // 已有链路末尾接着加（STK Extend）
  ok('已有链路进插入态：没有可撤销的', lnk.canUndo() === false)
  lnk.undoNode()
  ok('没插过就撤销：原有节点一个不少（原来删掉末尾的广州站）', names(l) === 's1,norad:1,s2' && lnk.cursorOf(id) === 3)
  ok('插一个之后可撤销', lnk.addNode(SAT('norad:2')) === '' && lnk.canUndo() === true)
  lnk.startAt(id, 1)                                                  // 挪光标到链头之后再插一颗
  ok('中间再插一颗', lnk.addNode(SAT('norad:4')) === '' && names(l) === 's1,norad:4,norad:1,s2,norad:2')
  lnk.undoNode()
  ok('撤销先撤最后插的那颗（中间那颗），光标回到它那道缝', names(l) === 's1,norad:1,s2,norad:2' && lnk.cursorOf(id) === 1)
  lnk.undoNode()
  ok('再撤销撤末尾那颗（光标在它前面也照撤）', names(l) === 's1,norad:1,s2' && lnk.cursorOf(id) === 3)
  lnk.undoNode()
  ok('本次插的撤完了：再按撤销什么也不做', names(l) === 's1,norad:1,s2' && lnk.canUndo() === false)
  // 更换本次插的 → 换上来的仍可撤；更换原有的 → 不进撤销
  lnk.addNode(SAT('norad:2'))
  ok('更换本次插的那颗', lnk.replaceNode(id, 3, SAT('norad:3')) === '' && names(l) === 's1,norad:1,s2,norad:3')
  lnk.undoNode()
  ok('撤销撤掉换上来的那颗', names(l) === 's1,norad:1,s2' && lnk.canUndo() === false)
  ok('更换原有节点', lnk.replaceNode(id, 1, SAT('norad:4')) === '' && names(l) === 's1,norad:4,s2')
  ok('更换原有节点不进撤销', lnk.canUndo() === false)
  lnk.undoNode()
  ok('撤销不动被换的原有位', names(l) === 's1,norad:4,s2')
  // 删掉本次插的 → 不再可撤；取消照旧回到进入前
  lnk.addNode(SAT('norad:2'))
  lnk.removeNode(id, 3)
  ok('本次插的被删掉：没有可撤销的', lnk.canUndo() === false && names(l) === 's1,norad:4,s2')
  lnk.cancel()
  ok('取消：回到进入插入态之前', names(lnk.linkOf(id)) === 's1,norad:1,s2' && lnk.draw.value === null)
  ok('不在插入态：没有可撤销的', lnk.canUndo() === false)
  lnk.remove(id)
}

// ---- ④ 候选来源 ----
{
  const ENT = { 1: { id: 1 }, 2: { id: 2 }, 3: { id: 3 } }
  const host = {
    stations: () => stations.value,
    points: () => [{ id: 'p1', lat: 30, lon: 110 }],
    nodePos: (n) => lnk.nodePos(n, 0),
    satPool: () => [
      { entry: ENT[3], key: 'norad:3', tier: 1 },
      { entry: ENT[1], key: 'norad:1', tier: 1 },
      { entry: ENT[2], key: 'norad:2', tier: 0 }
    ],
    satSearch: async () => ({ items: [], total: 0 }),
    satEntryOf: () => null,
    satKeyOf: (e) => 'norad:' + e.id,
    satMeta: (e) => ({ name: 'SAT-' + e.id, tag: '', norad: String(e.id) }),
    satNode: (e) => ({ k: 'sat', key: 'norad:' + e.id, name: 'SAT-' + e.id }),
    satEcef: (e) => SATPOS['norad:' + e.id] || null,
    cities: async () => [],
    minEl: () => 0,
    fmtLL: (lat, lon) => lat + ',' + lon
  }
  const src = createLinkPickSource(host)
  ok('站之后：地面端两组都不列', src.ground('', { prev: ST('s1'), next: null }) === null)
  const g = src.ground('', { prev: SAT('norad:1'), next: null })
  ok('星之后：列地球站与点标记', g && g.st.items.length === 3 && g.pt.items.length === 1)
  ok('地球站按对前邻星的仰角排：看得见的在前、纽约在末且标暗', g.st.items[2].id === 'st:s3' && g.st.items[2].off && !g.st.items[0].off)
  ok('读数是仰角', /°$/.test(g.st.items[0].rd))
  const g2 = src.ground('广州', { prev: SAT('norad:1'), next: null })
  ok('检索词过滤站名', g2.st.items.length === 1 && g2.st.items[0].id === 'st:s2' && g2.pt.items.length === 0)
  const sl = src.satsLocal({ prev: ST('s1'), next: null })
  ok('常用星置顶', sl.items[0].id === 'sat:norad:2')
  ok('场景星按可见排：110.5°E 在前、西半球那颗在后', sl.items[1].id === 'sat:norad:1' && sl.items[2].id === 'sat:norad:3' && sl.items[2].off)
  ok('常用与场景之间一道分隔', sl.items[1].sep === true && !sl.items[0].sep)
  ok('组头总数', sl.total === 3)
  const sl2 = src.satsLocal({ prev: SAT('norad:1'), next: null })
  ok('与前邻相同的星灰显、title 报原因', sl2.items.find((it) => it.id === 'sat:norad:1').dis === ISSUE_TEXT.same)
  ok('星间候选读数是距离', /km$/.test(sl2.items.find((it) => it.id === 'sat:norad:2').rd))
  const rep = src.satsLocal({ prev: ST('s1'), next: ST('s2'), cur: SAT('norad:1') })
  ok('替换位：被换的那颗标当前、不灰显', (() => { const it = rep.items.find((x) => x.id === 'sat:norad:1'); return it.cur && !it.dis })())
  ok('条目 → 节点（星走宿主补身份）', src.nodeOf(sl.items[0]).key === 'norad:2')
  ok('条目 → 节点（站直接给）', src.nodeOf(g.st.items[0]).k === 'st')
}

// ---- ⑤ 检索相关度 ----
{
  const it = (name, nid, slot, tag) => {
    const lc = nfk(name)
    return { lc, lcc: compact(lc), nid: nid || '', sl: nfk(slot || ''), slc: compact(nfk(slot || '')), tl: nfk(tag || '') }
  }
  const r = (x, q) => matchRank(x, queryTerms(q))
  const iss = it('ISS (ZARYA)', '25544'), sl = it('STARLINK-1007', '44713'), zx = it('ZHONGXING-6E', '49335', '115.5°E', 'GEO')
  ok('全名全等 = 0（不分大小写）', r(sl, 'starlink-1007') === 0)
  ok('编号全等 = 0', r(iss, '25544') === 0)
  ok('名称前缀 = 1', r(sl, 'starl') === 1)
  ok('编号前缀 = 2', r(iss, '255') === 2)
  ok('词首 = 2（括号后的 ZARYA）', r(iss, 'zarya') === 2)
  ok('包含 = 3', r(sl, 'link') === 3)
  ok('去掉连字符后包含 = 3（starlink1007）', r(sl, 'starlink1007') === 3)
  ok('全角输入照样命中（ＳＴＡＲ）', r(sl, 'ＳＴＡＲ') === 1)
  ok('轨道位置 = 4（115.5）', r(zx, '115.5') === 4)
  ok('轨道位置去分隔（1155e）= 4', r(zx, '1155e') === 4)
  ok('来源标签 = 5（geo）', r(zx, 'geo') === 5)
  ok('多个词同时命中、取最差一档（iss zarya = 2）', r(iss, 'iss zarya') === 2)
  ok('多个词有一个不中 = -1', r(iss, 'iss mir') === -1)
  ok('不中 = -1', r(sl, 'oneweb') === -1)
  ok('空检索词 = 无词', queryTerms('   ').length === 0)
}

// ---- ⑥ 卫星集（检索范围）：清单 / 集内列表 / 几何排序 / 解不出的成员 / 星位缓存 / 作废 / 条目 → 节点 ----
{
  const BJ = { k: 'st', id: 'bj' }
  const BJ_POS = gnd(39.9, 116.4)
  const E = {
    zx6: { key: 'norad:49335', name: 'ZHONGXING-6E', norad: '49335', slot: '115.5°E', tag: 'GEO', ecef: geo(115.5) },
    zx10: { key: 'norad:44240', name: 'ZHONGXING-10', norad: '44240', slot: '110.5°E', tag: 'GEO', ecef: geo(110.5) },
    gal: { key: 'norad:27445', name: 'GALAXY 3C', norad: '27445', slot: '95.0°W', tag: 'GEO', ecef: geo(-95) },
    stl: { key: 'norad:44713', name: 'STARLINK-1007', norad: '44713', slot: '', tag: 'Starlink', ecef: W.geodeticToEcef(116.4, 39.9, 550) },
    iss: { key: 'norad:25544', name: 'ISS (ZARYA)', norad: '25544', slot: '', tag: '空间站', ecef: W.geodeticToEcef(0, -30, 420) },
    tre: { key: 'grdsat:f1', name: '中星26号', norad: '', slot: '125.0°E', tag: '卫星天线树', ecef: geo(125) }
  }
  const byKey = new Map(Object.values(E).map((e) => [e.key, e]))
  const RES = {
    '*': { entries: [E.zx6, E.gal, E.stl, E.iss, E.tre, E.zx10], missing: [], natural: false },
    's:g1': { entries: [E.gal, E.zx6], missing: [{ id: '99999', name: 'OLD-SAT' }], natural: true },
    'c:k': { entries: [E.iss, E.stl], missing: [], natural: true }
  }
  let ecefN = 0, metaN = 0, tMs = Date.UTC(2026, 9, 8)
  const host = {
    stations: () => [], points: () => [],
    nodePos: (n) => (n.k === 'st' ? BJ_POS : (byKey.get(n.key) ? spc(byKey.get(n.key).ecef) : null)),
    satPool: () => [],
    setList: () => [
      { id: '*', kind: 'all', name: '全部卫星', lit: true, count: 6, icon: 'globe' },
      { id: 's:g1', kind: 'group', name: '中星系列', lit: false, count: 3, icon: 'layers' },
      { id: 'c:k', kind: 'custom', name: 'Walker', lit: false, count: 2, icon: 'orbit' }
    ],
    setEntries: async (id) => RES[id] || null,
    satKeyOf: (e) => e.key,
    satMeta: (e) => { metaN++; return { name: e.name, tag: e.tag, norad: e.norad, slot: e.slot } },
    satNode: (e) => ({ k: 'sat', key: e.key, name: e.name }),
    satKeyNode: (key, name) => ({ k: 'sat', key, name, fallback: true }),
    satEcef: (e) => { ecefN++; return e.ecef },
    nowMs: () => tMs,
    cities: async () => [],
    minEl: () => 0,
    fmtLL: (lat, lon) => lat + ',' + lon
  }
  const src = createLinkPickSource(host)
  const ids = (r) => r.items.map((x) => x.key)

  const s0 = src.sets('')
  ok('卫星集清单：三集、条目是导航行', s0.items.length === 3 && s0.items.every((x) => x.kind === 'set') && s0.items[0].id === 'set:*' && s0.items[0].sid === '*')
  ok('卫星集按集名过滤', src.sets('中星').items.map((x) => x.sid).join() === 's:g1')
  ok('集名过滤不分大小写 / 全半角', src.sets('ＷＡＬＫＥＲ').items.map((x) => x.sid).join() === 'c:k')
  ok('用户起的集名不跟语言（lit=false）', src.sets('walker').items[0].lit === false && s0.items[0].lit === true)

  const all = await src.scopeList('*', '', { prev: BJ, next: null }, { dead: false })
  ok('全部卫星：六颗、全数列出', all.total === 6 && all.n === 6 && all.nb === true)
  ok('站后：头顶那颗 Starlink 仰角最高排第一', all.items[0].key === 'norad:44713' && /°$/.test(all.items[0].rd), ids(all).join())
  ok('站后：看不见的（西半球 GEO / 南半球 ISS）排在后面且标暗', all.items.slice(-2).every((x) => x.off) && ids(all).slice(-2).sort().join() === 'norad:25544,norad:27445', ids(all).join())
  ok('此刻可见颗数', all.visN === 4)
  ok('可见档内按仰角降序', all.items.slice(0, 4).every((x, i, a) => i === 0 || a[i - 1].fit.el >= x.fit.el))
  const n1 = ecefN
  await src.scopeList('*', '', { prev: BJ, next: null }, { dead: false })
  ok('同一时刻桶再列：星位走缓存不再解算', ecefN === n1)
  tMs += 60000
  await src.scopeList('*', '', { prev: BJ, next: null }, { dead: false })
  ok('换了时刻桶：星位重算', ecefN === n1 + 6)
  ok('成员没变：条目表不重建（satMeta 只调第一遍）', metaN === 6, String(metaN))

  const zx = await src.scopeList('*', 'zhongxing', { prev: BJ, next: null }, { dead: false })
  ok('集内检索：命中两颗中星、组头报命中 / 全部', zx.n === 2 && zx.total === 6 && ids(zx).every((k) => /4933|4424/.test(k)))
  ok('同档相关度内按几何（115.5°E 比 110.5°E 仰角高）', zx.items[0].fit.el >= zx.items[1].fit.el)
  const zr = await src.scopeList('*', '25544', { prev: null, next: null }, { dead: false })
  ok('编号全等排第一', zr.items[0].key === 'norad:25544')
  const slot = await src.scopeList('*', '115.5', { prev: null, next: null }, { dead: false })
  ok('按轨道位置检索', slot.n === 1 && slot.items[0].key === 'norad:49335')
  ok('跨来源的集：行上带来源标签', all.items.find((x) => x.key === 'grdsat:f1').tag === '卫星天线树')
  ok('天线树虚拟星不报 NORAD', all.items.find((x) => x.key === 'grdsat:f1').norad === '')

  const g0 = await src.scopeList('s:g1', '', { prev: null, next: null }, { dead: false })
  ok('卫星组：保持组内次序、解不出的成员在末尾灰显', ids(g0).join() === 'norad:27445,norad:49335,norad:99999' && g0.items[2].dis === MISS_TEXT && g0.items[2].miss, ids(g0).join())
  ok('没有邻居：不出读数', g0.items.every((x) => !x.rd) && g0.nb === false)
  ok('单一来源的集：行上不重复来源标签', g0.items[0].tag === '')
  const g1 = await src.scopeList('s:g1', '', { prev: BJ, next: null }, { dead: false })
  ok('卫星组 + 站后：可见的提前、解不出的仍在末尾', ids(g1).join() === 'norad:49335,norad:27445,norad:99999', ids(g1).join())
  ok('解不出的成员不能变成节点', src.nodeOf(g1.items[2]) === null)
  ok('集内条目 → 节点（按该集的条目表）', src.nodeOf(g1.items[0]).key === 'norad:49335' && !src.nodeOf(g1.items[0]).fallback)

  const isl = await src.scopeList('*', '', { prev: { k: 'sat', key: 'norad:49335' }, next: null }, { dead: false })
  ok('星后：与前邻同一颗灰显、报原因', isl.items.find((x) => x.key === 'norad:49335').dis === ISSUE_TEXT.same)
  ok('星后：读数是星间距离', /km$/.test(isl.items.find((x) => x.key === 'norad:44240').rd))
  const rp = await src.scopeList('c:k', '', { prev: BJ, next: null, cur: { k: 'sat', key: 'norad:25544' } }, { dead: false })
  ok('替换位：被换的那颗 cur 且可选', (() => { const x = rp.items.find((y) => y.key === 'norad:25544'); return x.cur && !x.dis })())

  ok('已作废的那次返回 null', (await src.scopeList('*', '', { prev: BJ, next: null }, { dead: true })) === null)
  ok('该集不在了（删了）返回 null', (await src.scopeList('s:none', '', {}, { dead: false })) === null)

  const hs = await src.satsSearch('star', { prev: BJ, next: null }, { dead: false })
  ok('根视图全量检索：命中 Starlink、total = 命中数', hs.total === 1 && hs.items[0].key === 'norad:44713')
  ok('根视图空检索词不查', (await src.satsSearch('  ', {}, { dead: false })).total === 0)

  // 条目表换代（宿主回了新对象）：旧条目照样能变节点（按 id 认新表），新表没有的按键补查
  const old = all.items.find((x) => x.key === 'norad:25544')
  RES['*'] = { entries: [E.zx6, E.stl], missing: [], natural: false }
  await src.scopeList('*', '', {}, { dead: false })
  ok('换代后旧条目：新表里没有 → 按键补查（宿主 satKeyNode）', src.nodeOf(old).fallback === true && src.nodeOf(old).key === 'norad:25544')
  ok('换代后新表生效', (await src.scopeList('*', '', {}, { dead: false })).total === 2)
}

// ---- ⑦ 大集：根视图截断、名称自然序、分片算完不丢 ----
{
  const N = 5000
  const ents = []
  for (let i = N; i >= 1; i--) ents.push({ key: 'norad:' + (10000 + i), name: 'SAT-' + i, ecef: geo((i * 0.07) % 360 - 180) })
  const res = { entries: ents, missing: [], natural: false }
  const host = {
    stations: () => [], points: () => [],
    nodePos: (n) => (n.k === 'st' ? gnd(0, 0) : null),
    satPool: () => [], setList: () => [],
    setEntries: async () => res,
    satKeyOf: (e) => e.key,
    satMeta: (e) => ({ name: e.name, tag: '', norad: e.key.slice(6), slot: '' }),
    satNode: (e) => ({ k: 'sat', key: e.key, name: e.name }),
    satEcef: (e) => e.ecef,
    nowMs: () => 0, cities: async () => [], minEl: () => 0, fmtLL: () => ''
  }
  const src = createLinkPickSource(host)
  const r0 = await src.scopeList('*', '', {}, { dead: false })
  ok('大集按名称自然序（SAT-2 在 SAT-10 前）', r0.items[0].name === 'SAT-1' && r0.items[1].name === 'SAT-2' && r0.items[9].name === 'SAT-10', r0.items.slice(0, 3).map((x) => x.name).join())
  const r1 = await src.scopeList('*', '', { prev: { k: 'st', id: 'x' }, next: null }, { dead: false })
  ok('大集几何：全部算完（可见 + 不可见 = 全部）', r1.n === N && r1.items.filter((x) => x.fit && x.fit.n).length === N)
  ok('大集几何：可见的全在前', (() => { let seenOff = false; for (const x of r1.items) { if (x.off) seenOff = true; else if (seenOff) return false } return true })())
  const h = await src.satsSearch('sat-1', {}, { dead: false })
  ok('根视图截断到 PICK_SAT_ROOT、total 报全部命中', h.items.length === PICK_SAT_ROOT && h.total > PICK_SAT_ROOT, h.items.length + '/' + h.total)
  ok('根视图命中按相关度：全名 SAT-1 排第一', h.items[0].name === 'SAT-1')
}

console.log(`mapLinksPick: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
