// 应用场景仿真 · 渲染端纯逻辑自测（拓扑分层布局 + 符号覆盖）。运行：npm test
//
// 锁定：
//   ① 布局是纯函数：同一份数据两次布局逐位相同（不然拖一下面板图就跳）；
//   ② 纵轴分带按物理层走，★挂载件跟宿主同带（图传挂无人机上就该在临空层，不该掉回地面层）；
//   ③ 横轴按业务流的信号流向定序：末端在左、中心在右；
//   ④ 库里用到的每一个 symbol 在符号表里都画得出来（缺一个就是地图上一个空白）。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const core = require('../index.js')
const RED = require('../utils/sceneReduce.js')
const LIB = require('../utils/sceneLibrary.js')
const { layout, bandOf } = await import('../../../src/viz/scene/topoLayout.js')
const fs = require('fs')
const path = require('path')

let pass = 0, fail = 0
const ok = (n, c, e) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (e ? `  (${e})` : '')); c ? pass++ : fail++ }

const CAR = { modulation: 'QPSK', fec: '3/4', ebno: '5.50', ber: '7', m: '1.00', bandwidthFactor: '1.20', rsCode: '188/204', noiseRatioMode: 'ebno' }
const build = (id) => {
  const s = core.sceneTemplates.buildTemplate(id)
  const r = core.computeScene(s, null, { carrier: CAR })
  const rs = RED.resolveScene(s, null)
  return { s, r, lay: layout({ mods: rs.mods, links: s.links, flows: r.flows }) }
}

/* ① 纯函数 */
{
  const a = build('tpl.lowalt.nest'), b = build('tpl.lowalt.nest')
  const sig = (l) => JSON.stringify(l.nodes.map((n) => [n.id, n.band, n.rank, Math.round(n.x), Math.round(n.y)]))
  ok('布局是纯函数：同一份数据两次结果逐位相同', sig(a.lay) === sig(b.lay))
  ok('画布尺寸随内容算出来（不是写死的）', a.lay.w > 400 && a.lay.h > 200, `${a.lay.w}×${a.lay.h}`)
}

/* ② 分带 */
{
  const { lay } = build('tpl.lowalt.nest')
  const by = new Map(lay.nodes.map((n) => [n.mod.name, n]))
  ok('卫星进轨道层', by.get('中星 26 号').band === 0)
  ok('无人机进临空层', by.get('巡检多旋翼').band === 1)
  ok('★ 挂在无人机上的图传发射机跟宿主同带（不掉回地面层）', by.get('图传发射机').band === 1)
  ok('★ 挂在无人机上的云台也跟宿主同带', by.get('机载云台').band === 1)
  ok('机巢 / 信关站 / 平台在地面层',
    by.get('无人机机巢').band === 2 && by.get('Ka 信关站').band === 2 && by.get('巡检运营平台').band === 2)
}

/* ③ 横向定序：末端在左、中心在右 */
{
  const { lay } = build('tpl.power.dtu')
  const by = new Map(lay.nodes.map((n) => [n.mod.name, n]))
  ok('信号流向定序：DTU < 地面站 < 信关站 < 主站',
    by.get('10 kV 线路 DTU').rank < by.get('C 频段物联站').rank &&
    by.get('C 频段物联站').rank < by.get('北京信关站').rank &&
    by.get('北京信关站').rank < by.get('地区调度主站').rank,
    lay.nodes.map((n) => n.mod.name + ':' + n.rank).join(' '))
  ok('中心（H 类）恒在最右', by.get('地区调度主站').rank === lay.maxRank)
}

/* ④ 每个模板都布得出来，且没有节点落在画布外 */
for (const t of core.sceneTemplates.listTemplates()) {
  const { lay } = build(t.id)
  const bad = lay.nodes.filter((n) => !isFinite(n.x) || !isFinite(n.y) || n.x < 0 || n.y < 0)
  ok(`模板「${t.zh}」布局有效`, lay.nodes.length > 0 && bad.length === 0, `${lay.nodes.length} 节点 / ${lay.bands.length} 带`)
}

/* ⑤ 符号覆盖：库里用到的每一个 symbol 都要画得出来 */
{
  const src = fs.readFileSync(path.join(process.cwd(), 'src/viz/scene/sceneSymbols.js'), 'utf8')
  const body = src.slice(src.indexOf('const SYMBOLS = {'), src.indexOf('// 别名'))
  const have = new Set()
  for (const m of body.matchAll(/^\s{2}'?([a-zA-Z][a-zA-Z0-9-]*)'?:/gm)) have.add(m[1])
  for (const m of src.slice(src.indexOf('const ALIAS')).matchAll(/'?([a-zA-Z][a-zA-Z0-9-]*)'?:\s*'/g)) have.add(m[1])
  const used = [...new Set(LIB.BUILTIN.map((x) => x.symbol))]
  const miss = used.filter((x) => !have.has(x))
  ok('★ 库里用到的每个符号都在符号表里（缺一个＝地图上一个空白）', miss.length === 0, miss.join(' ') || `${used.length} 种`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
