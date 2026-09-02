// 应用场景仿真 · 渲染端纯逻辑自测（拓扑分层布局 + 符号覆盖）。运行：npm test
//
// 锁定：
//   ① 布局是纯函数：同一份数据两次布局逐位相同（不然拖一下面板图就跳）；
//   ② 纵轴分带按物理层走，★挂载件跟宿主同带（图传挂无人机上就该在临空层，不该掉回地面层）；
//   ③ 横轴按业务流的信号流向定序：末端在左、中心在右；
//   ④ 库里每个模块都解析得出图标（逐条映射与回放在 scene.test.mjs 里锁）；
//   ⑤ 二期的正交路由：零边穿节点、零标签压标签、20 节点场景排版+路由 < 30 ms。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const core = require('../index.js')
const RED = require('../utils/sceneReduce.js')
const LIB = require('../utils/sceneLibrary.js')
const { layout, bandOf } = await import('../../../src/viz/scene/topoLayout.js')

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

/* ⑤ 符号：每个模块解析得出图标（逐条映射与回放的完整断言在 scene.test.mjs） */
{
  const { iconOf } = await import('../../../src/viz/scene/sceneSymbols.js')
  const { FALLBACK_ICON } = await import('../../../src/viz/scene/sceneSymbolMap.js')
  const miss = LIB.BUILTIN.filter((m) => iconOf(m) === FALLBACK_ICON).map((m) => m.id)
  ok('★ 库里每个模块都解析得出图标（落到兜底件＝地图上一个没有含义的方点）',
    miss.length === 0, miss.join(' ') || `${LIB.BUILTIN.length} 条`)
}

/* ⑥ 正交路由（二期）——「这张图能不能看」的三条硬判据 */
// 一期的连线是「跨带中点折一次、同带跨层贝塞尔绕行」：穿卡片、互相重叠、没有避障。
// 这里把三件事钉死：
//   · 零边穿节点：路由折线的任何一段都不许落进【非端点】节点的矩形里；
//   · 零标签压标签：边标矩形两两不相交；
//   · 排版 + 路由的耗时（20 节点级的场景要在一帧里画得出来）。
{
  const { routeAll, polyDist, labelAnchor, placeLabels } = await import('../../../src/viz/scene/topoRoute.js')
  const { routeTopology } = await import('../../../src/viz/scene/topoRender.js')

  // 纯路由器的单元判据：两块障碍中间，线要绕过去而不是穿过去
  {
    const nodes = [
      { id: 'a', x: 60, y: 100, w: 100, h: 50 },
      { id: 'wall', x: 260, y: 100, w: 100, h: 50 },
      { id: 'b', x: 460, y: 100, w: 100, h: 50 }
    ]
    const r = routeAll(nodes, [{ id: 'e1', a: 'a', b: 'b' }], {})
    const pts = r.routes.get('e1')
    ok('★ 路由绕开中间的障碍（不从卡片身上压过去）', !!pts && !segsHitRect(pts, nodes[1]), pts ? pts.map((p) => p.join()).join(' → ') : '无路径')
    ok('路由是正交的（每段非横即竖）', !!pts && pts.every((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1][0]) < 1e-6 || Math.abs(p[1] - pts[i - 1][1]) < 1e-6))
  }
  // 平行段错开：两条边连同一对节点时不许叠成一条
  {
    const nodes = [{ id: 'a', x: 60, y: 100, w: 100, h: 50 }, { id: 'b', x: 400, y: 100, w: 100, h: 50 }]
    const r = routeAll(nodes, [{ id: 'e1', a: 'a', b: 'b' }, { id: 'e2', a: 'a', b: 'b', role: 'backup' }], {})
    const p1 = r.routes.get('e1'), p2 = r.routes.get('e2')
    const far = p1 && p2 && Math.max(...p1.map((p) => Math.min(...p2.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))))) > 4
    ok('★ 主备两条边不重叠（备份走外侧通道）', !!far)
  }
  // 布局是纯函数这条对新布局同样成立（重心排序 + 站点聚合都不许引入不定序）
  {
    const a = build('tpl.water.dam'), b = build('tpl.water.dam')
    const sig = (l) => JSON.stringify(l.nodes.map((n) => [n.id, n.band, n.rank, Math.round(n.x), Math.round(n.y), n.w]))
    ok('★ 加了重心排序与站点聚合之后，布局仍是纯函数', sig(a.lay) === sig(b.lay))
  }
  // 15 个模板全量：零边穿节点 + 零标签压标签 + 计时
  {
    const measure = (t, px) => { let w = 0; for (const c of String(t || '')) w += /[⺀-鿿＀-￯]/.test(c) ? 1 : 0.55; return w * px }
    const mediaOf = (k) => core.sceneMedia.mediaOf(k)
    const tierOf = (k) => { const m = mediaOf(k); return m ? m.tier : null }
    let worstMs = 0, crossN = 0, overlapN = 0, bad = []
    for (const t of core.sceneTemplates.listTemplates()) {
      const s = core.sceneTemplates.buildTemplate(t.id)
      const r = core.computeScene(s, null, { carrier: CAR })
      const rs = RED.resolveScene(s, null)
      const t0 = Date.now()
      const lay = layout({ mods: rs.mods, links: s.links, flows: r.flows }, { measure, fontPx: 12 })
      const routed = routeTopology(lay, { links: s.links, mediaOf, tierOf, readings: () => [] }, { fontPx: 12, measure })
      const ms = Date.now() - t0
      worstMs = Math.max(worstMs, ms)
      // 边穿节点：折线段落进非端点节点的矩形里
      for (const lk of s.links) {
        const pts = routed.routes.get(lk.id)
        if (!pts) continue
        for (const n of lay.nodes) {
          if (n.id === lk.a.modId || n.id === lk.b.modId) continue
          if (segsHitRect(pts, n)) { crossN++; bad.push(`${t.id} ${lk.id}×${n.id}`); break }
        }
      }
      // 标签压标签
      const boxes = (routed.labels || []).filter((b) => !b.hide)
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j]
          if (Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h) { overlapN++; bad.push(`${t.id} 标签重叠`) }
        }
      }
    }
    ok('★ 15 个模板零边穿节点', crossN === 0, bad.slice(0, 4).join(' | '))
    ok('★ 15 个模板零标签压标签', overlapN === 0, bad.filter((x) => /标签/.test(x)).slice(0, 3).join(' | '))
    ok('★ 排版 + 路由耗时（最慢的一个模板）', worstMs < 120, `${worstMs} ms`)
  }
  // 20 节点场景的性能红线
  {
    const measure = (t, px) => String(t || '').length * px * 0.6
    const mods = new Map(), links = []
    for (let i = 0; i < 20; i++) mods.set('n' + i, { instId: 'n' + i, name: '节点' + i, cat: i === 0 ? 'A' : (i > 16 ? 'H' : 'E'), ports: [], place: { mode: 'fixed', lat: 30 + i, lon: 100 } })
    for (let i = 1; i < 20; i++) links.push({ id: 'l' + i, a: { modId: 'n' + (i - 1) }, b: { modId: 'n' + i }, medium: 'cat6', params: {} })
    const t0 = Date.now()
    const lay = layout({ mods, links, flows: [] }, { measure, fontPx: 12 })
    const nodes = lay.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }))
    routeAll(nodes, links.map((l) => ({ id: l.id, a: l.a.modId, b: l.b.modId })), {})
    const ms = Date.now() - t0
    ok('★ 20 节点场景排版 + 路由 < 30 ms', ms < 30, `${ms} ms`)
  }
  // 标签落位工具本身
  {
    const an = labelAnchor([[0, 0], [100, 0], [100, 50], [220, 50]])
    ok('边标落在最长的水平段中点', Math.abs(an.x - 160) < 1 && Math.abs(an.y - 50) < 1, `${an.x},${an.y} room=${an.room}`)
    const pl = placeLabels([{ id: 'a', x: 0, y: 0, w: 40, h: 14 }, { id: 'b', x: 0, y: 0, w: 40, h: 14 }], 14, 4)
    ok('两个同位置的标签被错开', Math.abs(pl[0].y - pl[1].y) >= 14)
    ok('折线距离量得出来（命中测试基础）', Math.abs(polyDist([[0, 0], [100, 0]], 50, 7) - 7) < 1e-6)
  }
}
function segsHitRect(pts, n) {
  const r = { x0: n.x - n.w / 2 + 1, x1: n.x + n.w / 2 - 1, y0: n.y - n.h / 2 + 1, y1: n.y + n.h / 2 - 1 }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    // 正交段：逐点采样够用（段要么横要么竖）
    const steps = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3))
    for (let k = 0; k <= steps; k++) {
      const x = a[0] + (b[0] - a[0]) * k / steps, y = a[1] + (b[1] - a[1]) * k / steps
      if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return true
    }
  }
  return false
}


console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
