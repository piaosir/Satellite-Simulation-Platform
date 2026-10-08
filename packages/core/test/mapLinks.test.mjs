// 图上链路纯逻辑（packages/core/models/mapLinks.mjs）+ 链路预算地球站库站型对号（src/shared/lbStationType.js）。
//
// 关键不变式：
//   ① 拓扑决定可导入模块：站→透明 GEO→站 只进 GSO（及端到端）；非 GEO 只进 NGSO；全再生才进再生式；端到端收一切有效链路；
//   ② 站接站 / 相邻同一对象 / 激光跳接透明星 = 无效；同一颗星非相邻两次、首尾同站（环回）有效；
//   ③ 反向链路的激光位跟着「发端」挪，再生位留在原卫星上；
//   ④ 导入载荷只带站名 / 经纬度 / 口径 / 天线罩与星的身份快照，链端卫星恒按再生；
//   ⑤ 站型对号：口径 + 带罩与否；建条目只改口径与（带罩时）两项综合损耗，库里别的参数照抄底本；不带罩的名字交还自动命名。
import {
  hopKind, linkIssues, linkValid, linkTargets, targetReason, linkAutoName, reverseLink,
  sanitizeLinks, chainPayload, radomeLossDb, satRegenAt, normNode
} from '../models/mapLinks.mjs'
import { esStationType, esIsRadome } from '../../../src/shared/lbStationType.js'
import { sanitizeMarkers } from '../models/entityRuntime.mjs'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
}

const ST = (id) => ({ k: 'st', id })
const SAT = (key, o = {}) => ({ k: 'sat', key, name: o.name || key, ...(o.regen ? { regen: true } : {}), ...(o.laser ? { laser: true } : {}), info: { geo: !!o.geo, noradId: o.norad || '' } })
const L = (...nodes) => ({ id: 'l1', name: '', nameAuto: true, nodes })

// ---- 跳类型 ----
ok('站→星 = 上行', hopKind(ST('a'), SAT('s')) === 'up')
ok('星→站 = 下行', hopKind(SAT('s'), ST('a')) === 'down')
ok('星→星 = 星间微波', hopKind(SAT('s'), SAT('t')) === 'isl')
ok('发端带激光位 = 星间激光', hopKind(SAT('s', { laser: true }), SAT('t')) === 'laser')
ok('站→站 = null', hopKind(ST('a'), ST('b')) === null)

// ---- 校验 ----
ok('单节点无效', linkIssues(L(ST('a')))[0].code === 'short')
ok('站接站无效', linkIssues(L(ST('a'), ST('b'), SAT('s'))).some((x) => x.code === 'st-st'))
ok('相邻同一颗星无效', linkIssues(L(ST('a'), SAT('s'), SAT('s'), ST('b'))).some((x) => x.code === 'same'))
ok('激光跳两端恒按再生：中间星没勾再生也有效、可进再生式', (() => { const l = L(ST('a'), SAT('s', { laser: true }), SAT('t'), ST('b')); return linkValid(l) && satRegenAt(l, 1) && satRegenAt(l, 2) && linkTargets(l).regen })())
ok('激光跳两端再生有效', linkValid(L(ST('a'), SAT('s', { laser: true, regen: true }), SAT('t', { regen: true }), ST('b'))))
ok('链端卫星恒按再生：星→星激光有效', linkValid(L(SAT('s', { laser: true }), SAT('t'))))
ok('双跳经同一颗星有效', linkValid(L(ST('a'), SAT('s'), ST('hub'), SAT('s'), ST('b'))))
ok('首尾同站（环回）有效', linkValid(L(ST('a'), SAT('s'), ST('a'))))
ok('地球站已删除 → no-st', linkIssues(L(ST('a'), SAT('s'), ST('b')), { hasStation: (id) => id === 'a', satOk: () => true }).some((x) => x.code === 'no-st' && x.at === 2))
ok('链端卫星 satRegenAt 恒真', satRegenAt(L(SAT('s'), ST('a')), 0) === true && satRegenAt(L(ST('a'), SAT('s'), ST('b')), 1) === false)

// ---- 可导入判定 ----
const geoBent = L(ST('a'), SAT('g', { geo: true }), ST('b'))
const leoBent = L(ST('a'), SAT('l'), ST('b'))
const regenOne = L(ST('a'), SAT('g', { geo: true, regen: true }), ST('b'))
const tGeo = linkTargets(geoBent), tLeo = linkTargets(leoBent), tReg = linkTargets(regenOne)
ok('GEO 弯管 → GSO + 端到端', tGeo.linkbudget && !tGeo.ngso && !tGeo.regen && tGeo.e2e, JSON.stringify(tGeo))
ok('非 GEO 弯管 → NGSO + 端到端', !tLeo.linkbudget && tLeo.ngso && !tLeo.regen && tLeo.e2e, JSON.stringify(tLeo))
ok('再生单星 → 再生式 + 端到端，不进 GSO', !tReg.linkbudget && !tReg.ngso && tReg.regen && tReg.e2e, JSON.stringify(tReg))
ok('站→星（星上终结）→ 再生式', linkTargets(L(ST('a'), SAT('s'))).regen)
ok('星→站 → 再生式', linkTargets(L(SAT('s'), ST('a'))).regen)
ok('星→星 → 再生式', linkTargets(L(SAT('s'), SAT('t'))).regen)
const mixed = L(ST('a'), SAT('s'), SAT('t', { regen: true }), ST('b'))
ok('含透明星的多跳只进端到端', (() => { const t = linkTargets(mixed); return t.e2e && !t.regen && !t.linkbudget && !t.ngso })())
ok('无效链路全 false', Object.values(linkTargets(L(ST('a'), ST('b')))).every((v) => !v))
ok('GSO 不收非 GEO 的原因', targetReason(leoBent, 'linkbudget') === '卫星不是地球静止轨道')
ok('再生式不收透明星的原因', targetReason(geoBent, 'regen') === '链路中有透明转发卫星')
ok('能导入时原因为空', targetReason(geoBent, 'linkbudget') === '')

// ---- 自动名 / 反向 ----
const names = { a: '北京站', b: '广州站', hub: '主站' }
const nameOf = (n) => (n.k === 'st' ? names[n.id] : n.name)
ok('自动名按信号流向', linkAutoName(L(ST('a'), SAT('s', { name: '中星6D' }), ST('b')), nameOf) === '北京站 → 中星6D → 广州站')
ok('节点多于 5 个省略中段', linkAutoName(L(ST('a'), SAT('s'), ST('hub'), SAT('t'), ST('b'), SAT('u'), ST('a')), nameOf).includes('…'))
const fwd = L(ST('a'), SAT('s', { regen: true, laser: true }), SAT('t', { regen: true }), ST('b'))
const rev = reverseLink(fwd, () => 'l2')
ok('反向：节点倒序', rev.nodes.map((n) => n.id || n.key).join(',') === 'b,t,s,a', rev.nodes.map((n) => n.id || n.key).join(','))
ok('反向：激光位挪到新的发端（原接收星 t）', rev.nodes[1].laser === true && !rev.nodes[2].laser)
ok('反向：再生位留在原卫星上', rev.nodes[1].regen === true && rev.nodes[2].regen === true)
ok('反向：仍有效且仍是激光跳', linkValid(rev) && hopKind(rev.nodes[1], rev.nodes[2]) === 'laser')
ok('反向：新 id、交还自动名', rev.id === 'l2' && rev.nameAuto === true && rev.name === '')
ok('反向不改原链路', fwd.nodes[1].laser === true && fwd.nodes[0].id === 'a')

// ---- 规范化 ----
const sl = sanitizeLinks([
  { id: 'x', name: 'n', nodes: [{ k: 'st', id: 'a' }, { k: 'bad' }, { k: 'sat', key: 'norad:1', regen: 'yes', info: { slotLon: 999, geo: true } }], color: 'red' },
  { id: 'x', nodes: [] },
  { nodes: [] },
  'junk'
])
ok('同 id 只留一条、无 id / 非对象丢掉', sl.length === 1, String(sl.length))
ok('坏节点丢掉', sl[0].nodes.length === 2)
ok('regen 只认 true', !('regen' in sl[0].nodes[1]))
ok('越界定点经度丢掉、geo 保留', !('slotLon' in sl[0].nodes[1].info) && sl[0].nodes[1].info.geo === true)
ok('颜色只收 #rrggbb', !('color' in sl[0]))
ok('非数组 → []', sanitizeLinks(null).length === 0)
const mkd = { stations: [{ id: 'a', diaM: -1, radome: 'y' }, { id: 'b', diaM: 4.5, radome: true }], links: [{ id: 'l', nodes: [{ k: 'st', id: 'a' }] }] }
sanitizeMarkers(mkd)
ok('站口径非法删掉、天线罩只存 true', !('diaM' in mkd.stations[0]) && !('radome' in mkd.stations[0]) && mkd.stations[1].diaM === 4.5 && mkd.stations[1].radome === true)
ok('sanitizeMarkers 规范化 links', Array.isArray(mkd.links) && mkd.links[0].nameAuto === true)
const old = { points: [], stations: [{ id: 's', lat: 1, lon: 2, name: 'x' }], trajectories: [] }
sanitizeMarkers(old)
ok('老存档（无 links）不补字段', !('links' in old) && JSON.stringify(old.stations[0]) === '{"id":"s","lat":1,"lon":2,"name":"x"}')

// ---- 导入载荷 ----
const stations = { a: { id: 'a', name: '北京站', lat: 39.9, lon: 116.4, diaM: 4.5, radome: true }, b: { id: 'b', name: '广州站', lat: 23.1, lon: 113.3 } }
const pctx = { station: (id) => stations[id] || null, nameOf }
const pl = chainPayload({ ...geoBent, nodes: [ST('a'), { k: 'sat', key: 'norad:41838', name: '中星6D', info: { geo: true, noradId: '41838', slotLon: 125 } }, ST('b')] }, pctx)
ok('载荷节点与跳数对齐', pl && pl.nodes.length === 3 && pl.hops.length === 2 && pl.hops[0].type === 'up' && pl.hops[1].type === 'down')
ok('站带口径 / 天线罩，没带的不写', pl.nodes[0].diaM === 4.5 && pl.nodes[0].radome === true && !('diaM' in pl.nodes[2]) && !('radome' in pl.nodes[2]))
ok('星带身份快照、透明', pl.nodes[1].noradId === '41838' && pl.nodes[1].geo === true && pl.nodes[1].slotLon === 125 && pl.nodes[1].regen === false)
ok('自动名链路载荷 nameAuto 为真', pl.nameAuto === true && pl.name === '北京站 → 中星6D → 广州站', pl.name)
ok('自定义名照带', chainPayload({ ...geoBent, name: '主干', nameAuto: false }, pctx).name === '主干')
ok('站删了 → 载荷 null', chainPayload(L(ST('zz'), SAT('s'), ST('b')), pctx) === null)
ok('链端卫星载荷按再生', chainPayload(L(SAT('s'), ST('b')), pctx).nodes[0].regen === true)

// ---- 罩损档 ----
ok('罩损：C 0.2 / Ku 0.5 / Ka 1.0', radomeLossDb(6) === 0.2 && radomeLossDb(14.25) === 0.5 && radomeLossDb(29.5) === 1.0)
ok('罩损：取不到频率按 Ku', radomeLossDb('') === 0.5)

// ---- 站型对号 ----
const lib = [
  { id: 'es1', name: '关口站 6.2m', nameAuto: false, form: { antennaDiameter: '6.2', antennaEfficiency: '65', uplinkOtherLoss: '0.3', downlinkOtherLoss: '0.3', upcValue: '2' } },
  { id: 'es2', name: '干线站 3.7m', nameAuto: false, form: { antennaDiameter: '3.7', antennaEfficiency: '65', uplinkOtherLoss: '0.3', downlinkOtherLoss: '0.3' } },
  { id: 'es3', name: '4.5 m 天线罩', nameAuto: false, form: { antennaDiameter: '4.5', uplinkOtherLoss: '0.8', downlinkOtherLoss: '0.8' } }
]
const keys = { up: 'uplinkOtherLoss', dn: 'downlinkOtherLoss' }
ok('既没口径也没罩 → 不对号', esStationType(lib, { prefer: lib[0], lossKeys: keys }) === null)
ok('口径相同 → 命中已有条目', esStationType(lib, { diaM: 3.7, prefer: lib[0], lossKeys: keys }).hit === lib[1])
ok('带罩 + 口径相同 → 命中带罩条目', esStationType(lib, { diaM: 4.5, radome: true, prefer: lib[0], lossKeys: keys }).hit === lib[2])
ok('带罩判据按名字', esIsRadome(lib[2]) && !esIsRadome(lib[0]))
const mk1 = esStationType(lib, { diaM: 1.2, prefer: lib[0], lossKeys: keys, freq: { up: 14.25, dn: 12.5 } }).make
ok('新口径不带罩：只改口径、名字交还自动命名', mk1.form.antennaDiameter === '1.2' && mk1.form.uplinkOtherLoss === '0.3' && mk1.form.upcValue === '2' && mk1.name === '' && mk1.nameAuto === true)
const mk2 = esStationType(lib, { diaM: 6.2, radome: true, prefer: lib[0], lossKeys: keys, freq: { up: 14.25, dn: 12.5 } }).make
ok('带罩新建：两项综合损耗各加 Ku 罩损', mk2.form.uplinkOtherLoss === '0.8' && mk2.form.downlinkOtherLoss === '0.8', JSON.stringify(mk2.form))
ok('带罩新建：名字「6.2 m 天线罩」、不跟自动命名', mk2.name === '6.2 m 天线罩' && mk2.nameAuto === false)
ok('不改底本', lib[0].form.uplinkOtherLoss === '0.3')
const mk3 = esStationType(lib, { radome: true, prefer: lib[1], lossKeys: keys, freq: { up: 6, dn: 4 } }).make
ok('没带口径但带罩：沿用底本口径、按 C 段加罩损', mk3.form.antennaDiameter === '3.7' && mk3.form.uplinkOtherLoss === '0.5' && mk3.form.downlinkOtherLoss === '0.5', JSON.stringify(mk3.form))
ok('端到端（库里没有损耗字段）：只按口径对号', esStationType(lib, { diaM: 6.2, radome: true, prefer: lib[0], lossKeys: null }).hit === lib[0])

// 点标记当端点：只有位置
{
  const l = L({ k: 'pt', id: 'p1' }, SAT('g', { geo: true }), ST('b'))
  const cx = { hasStation: () => true, hasPoint: (id) => id === 'p1', station: () => ({ name: 'B', lat: 1, lon: 2, diaM: 4.5, pwrW: 40 }), point: () => ({ name: 'P', lat: 3, lon: 4 }) }
  ok('点标记 → GEO → 站可进 GSO', linkTargets(l, cx).linkbudget)
  const pl = chainPayload(l, cx)
  ok('点标记载荷只带名字与位置', pl && pl.nodes[0].t === 'es' && pl.nodes[0].lat === 3 && !('diaM' in pl.nodes[0]) && pl.hops[0].type === 'up')
  ok('站载荷带功率', pl.nodes[2].pwrW === 40)
  ok('点标记删了无效', linkIssues(l, { ...cx, hasPoint: () => false }).some((x) => x.code === 'no-pt'))
  ok('点接站无效', linkIssues(L({ k: 'pt', id: 'p1' }, ST('b'))).some((x) => x.code === 'st-st'))
  ok('点节点规范化保留', normNode({ k: 'pt', id: 'p1' }).k === 'pt')
}
// 功率进对号键
{
  const lib2 = [{ id: 'a', name: '', form: { antennaDiameter: '4.5', paPowerW: '40' } }]
  ok('同口径同功率命中', esStationType(lib2, { diaM: 4.5, powerW: 40, powerKey: 'paPowerW', prefer: lib2[0], lossKeys: null }).hit === lib2[0])
  const m = esStationType(lib2, { diaM: 4.5, powerW: 100, powerKey: 'paPowerW', prefer: lib2[0], lossKeys: null })
  ok('功率不同新建并写入功率', m.make && m.make.form.paPowerW === '100' && m.make.form.antennaDiameter === '4.5')
  ok('只给功率也对号', !!esStationType(lib2, { powerW: 100, powerKey: 'paPowerW', prefer: lib2[0] }))
}

console.log(`mapLinks: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
