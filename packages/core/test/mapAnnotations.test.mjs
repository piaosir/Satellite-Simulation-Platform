// 地图注记两张表的不变量：水域注记（src/viz/geo/waterNames.js）+ 岛链参考线（src/viz/geo/islandChains.js）。
// 运行：npm test
//
// 水域注记那张表是手写的经纬度，最容易犯的错就是「名字落到陆地上」——图上看是一个海名压在沙特境内，
// 而它又占着避让的位置，把真正该显示的名字挤掉。故这里拿 50m 底图的陆地面做一次逐点判定。
// 判据用的是【原始 NE 单元面】（topojson objects.units），与视角、归属解算无关：
// 主权画法怎么变，一个点是海是陆不变。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { feature } from 'topojson-client'
import { WATERS, waterList, waterLabels } from '../../../src/viz/geo/waterNames.js'
import { CHAINS, chainList, CHAIN_DEF } from '../../../src/viz/geo/islandChains.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}

// ---------- ① 表结构 ----------
ok('① 两档都非空', waterList('ocean').length > 0 && waterList('sea').length > 0,
  '大洋 ' + waterList('ocean').length + ' / 海域 ' + waterList('sea').length)

const badField = WATERS.filter((w) => !w.id || !w.zh || !w.en || !(w.tier === 'ocean' || w.tier === 'sea') ||
  !(w.px > 0) || !(w.lon >= -180 && w.lon <= 180) || !(w.lat >= -90 && w.lat <= 90))
ok('② 每条都有 id / 中英名 / 合法档位 / 正字号 / 合法经纬', badField.length === 0,
  badField.map((w) => w.zh).join(' ') || WATERS.length + ' 条全过')

// 同一 id 必须同名同档（太平洋标两处，两处得是同一个名字）
const byId = new Map()
const idConflict = []
for (const w of WATERS) {
  const p = byId.get(w.id)
  if (!p) { byId.set(w.id, w); continue }
  if (p.zh !== w.zh || p.en !== w.en || p.tier !== w.tier || p.px !== w.px) idConflict.push(w.id)
}
ok('③ 同 id 的多处标注同名同档同字号', idConflict.length === 0, idConflict.join(' ') || byId.size + ' 个 id')

// 反过来：同名不得占两个 id（否则勾选清单里会出现两行一模一样的字）
const nameOwner = new Map(), nameDup = []
for (const w of byId.values()) {
  if (nameOwner.has(w.zh) && nameOwner.get(w.zh) !== w.id) nameDup.push(w.zh)
  nameOwner.set(w.zh, w.id)
}
ok('④ 中文名不重复', nameDup.length === 0, nameDup.join(' ') || nameOwner.size + ' 个名字')

// 制图层级：大洋一律不小于任何海域（层级靠 px 给，见 waterNames.js 的注释）
const oMin = Math.min(...waterList('ocean').map((w) => w.px))
const sMax = Math.max(...waterList('sea').map((w) => w.px))
ok('⑤ 大洋字号不低于海域', oMin >= sMax, '大洋最小 ' + oMin + ' / 海域最大 ' + sMax)

// ---------- ⑥ 逐条显隐 ----------
const one = waterList('sea')[0]
ok('⑥ waterLabels 按 id 过滤', waterLabels('sea', { [one.id]: true }).every((w) => w.id !== one.id) &&
  waterLabels('sea').some((w) => w.id === one.id), '试关 ' + one.zh)
ok('⑦ waterList 按 id 去重', waterList('ocean').length < WATERS.filter((w) => w.tier === 'ocean').length,
  '大洋 ' + WATERS.filter((w) => w.tier === 'ocean').length + ' 处标注 → ' + waterList('ocean').length + ' 个名字')

// ---------- ⑧ 名字必须落在水面上 ----------
// 射线法：点在任一陆地环内即判陆地。环取 NE 50m 的国家单元面（含内环，但内环是飞地不是湖，
// 按外环判已足够——本表没有一条落在飞地里）。
const topo = JSON.parse(readFileSync(join(ROOT, 'src', 'viz', 'globe3d', 'data', 'basemap-50m.json'), 'utf8'))
const land = feature(topo, topo.objects.units)
const inRing = (ring, x, y) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
const polys = []
for (const f of land.features) {
  const g = f.geometry
  if (!g) continue
  const list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
  for (const p of list) polys.push({ name: f.properties.name_en || f.properties.u, outer: p[0] })
}
const onLand = []
for (const w of WATERS) {
  const hit = polys.find((p) => inRing(p.outer, w.lon, w.lat))
  if (hit) onLand.push(w.zh + ' (' + w.lon + ',' + w.lat + ') → ' + hit.name)
}
ok('⑧ 每条注记都落在水面上', onLand.length === 0, onLand.join(' | ') || WATERS.length + ' 处全在水上（50m 陆地面 ' + polys.length + ' 环）')


// ---------- ⑨ 岛链 ----------
// 岛链没有带坐标的官方文件，但它串起来的【岛屿】是确定的：本表逐个岛给经纬度再连线（见
// islandChains.js 的口径段）。故这里除了工程约束，还能真的核对精度 —— ⑮ 逐点判岛、⑯ 钉端点。
ok('⑨ 三条岛链都在，且 id 不重复', CHAINS.length === 3 && new Set(CHAINS.map((c) => c.id)).size === 3,
  CHAINS.map((c) => c.zh + '(' + c.nodes.length + ' 岛 → ' + c.pts.length + ' 点)').join(' '))

const chBad = CHAINS.filter((c) => !c.id || !c.zh || !c.en || c.pts.length < 2 ||
  !(c.label[0] >= -180 && c.label[0] <= 180 && c.label[1] >= -90 && c.label[1] <= 90) ||
  c.pts.some(([lo, la]) => !(lo >= -180 && lo <= 180 && la >= -90 && la <= 90)))
ok('⑩ 每条都有中英名 / 合法锚点 / 合法顶点', chBad.length === 0, chBad.map((c) => c.zh).join(' ') || '3 条全过')

// 顶点加密：相邻点间距不许超过 DENSE_DEG 的两倍 —— 疏了的话 2D 的直线与 3D 的大圆会长成两个样子
let maxGap = 0, gapAt = ''
for (const c of CHAINS) {
  for (let i = 1; i < c.pts.length; i++) {
    let dx = c.pts[i][0] - c.pts[i - 1][0]
    if (dx > 180) dx -= 360; else if (dx < -180) dx += 360      // 第三岛链跨日界线
    const d = Math.hypot(dx, c.pts[i][1] - c.pts[i - 1][1])
    if (d > maxGap) { maxGap = d; gapAt = c.zh }
  }
}
ok('⑪ 顶点已加密（相邻间距 ≤ 2°）', maxGap <= 2.0, '最大间距 ' + maxGap.toFixed(2) + '° @ ' + gapAt)

ok('⑫ chainList 按 id 过滤', chainList({ chain3: true }).length === 2 && chainList().length === 3, '试关第三岛链')
ok('⑬ 出厂样式齐备且是虚线', CHAIN_DEF.color && CHAIN_DEF.width > 0 && CHAIN_DEF.dash !== 'solid' && CHAIN_DEF.name === 'zh',
  CHAIN_DEF.color + ' / ' + CHAIN_DEF.width + ' / ' + CHAIN_DEF.dash)

// 名字锚点也得落在水上（线本身沿岛弧走，必然穿陆地，那不算问题）
const chOnLand = []
for (const c of CHAINS) {
  const hit = polys.find((p) => inRing(p.outer, c.label[0], c.label[1]))
  if (hit) chOnLand.push(c.zh + ' → ' + hit.name)
}
ok('⑭ 岛链名的锚点落在水面上', chOnLand.length === 0, chOnLand.join(' | ') || '3 处全在水上')

// ---------- ⑮ 岛屿锚点真的落在那个岛上 ----------
// 这一条才是「画得准不准」：表里每个顶点都是一个具名岛屿，拿 10m 陆地面逐点判。
// 判 10m 不判 50m —— 50m 收不进小笠原、火山列岛、马里亚纳北段这些几平方公里的岛。
// 容差 15 km：岬角取的是岬尖坐标，底图简化后本就差几公里；岛屿取的是岛心。
const CH_TOL_KM = 15
// 连 10m 都收不进的小岛 / 环礁 —— 坐标是对的，是底图没有这块陆地。放宽到 150 km 仍能抓出粗错。
// 宝岛 7 km²、麦考利岛 3 km²，乌利西 / 恩古卢是环礁（露出水面的只有几个小沙洲）。
const CH_TINY = { 宝岛: 1, 乌利西环礁: 1, 恩古卢环礁: 1, 麦考利岛: 1 }
const CH_TINY_KM = 150
const topo10 = JSON.parse(readFileSync(join(ROOT, 'src', 'viz', 'globe3d', 'data', 'basemap-10m.json'), 'utf8'))
const land10 = feature(topo10, topo10.objects.units)
const polys10 = []
for (const f of land10.features) {
  const g = f.geometry
  if (!g) continue
  const list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
  for (const p of list) polys10.push({ name: f.properties.name_en || f.properties.u, outer: p[0] })
}
const gcKm = (lo1, la1, lo2, la2) => {
  const rad = Math.PI / 180
  let dl = (lo2 - lo1) * rad
  if (dl > Math.PI) dl -= 2 * Math.PI; else if (dl < -Math.PI) dl += 2 * Math.PI
  const p1 = la1 * rad, p2 = la2 * rad
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)))
}
const offIsland = []
let chWorst = 0, chWorstName = ''
for (const c of CHAINS) {
  for (const n of c.nodes) {
    let km = Infinity
    for (const p of polys10) {
      if (inRing(p.outer, n.lon, n.lat)) { km = 0; break }
      for (const [x, y] of p.outer) {
        if (Math.abs(y - n.lat) > 6) continue                    // 粗筛：6° 之外不可能更近
        const d = gcKm(n.lon, n.lat, x, y)
        if (d < km) km = d
      }
    }
    if (!CH_TINY[n.zh] && km > chWorst) { chWorst = km; chWorstName = n.zh }
    if (km > (CH_TINY[n.zh] ? CH_TINY_KM : CH_TOL_KM)) offIsland.push(n.zh + ' 差 ' + km.toFixed(0) + ' km')
  }
}
const chNodeCount = CHAINS.reduce((s, c) => s + c.nodes.length, 0)
ok('⑮ 每个岛屿锚点都落在那个岛上', offIsland.length === 0,
  offIsland.join(' | ') || chNodeCount + ' 个锚点全过（最远 ' + chWorst.toFixed(0) + ' km @ ' + chWorstName + '）')

// ---------- ⑯ 端点即口径 ----------
// 岛链的定义就写在两个端点上：第二岛链南端是【哈马黑拉岛】不是新几内亚，第一岛链南端是
// 加里曼丹岛西端。端点一改，整条线表达的就是另一份口径了 —— 故钉死。
const CH_ENDS = {
  chain1: ['占守岛', '拿督角'],      // 千岛群岛 → 大巽他群岛（加里曼丹岛）
  chain2: ['伊豆大岛', '甘尼'],      // 伊豆群岛 → 哈马黑拉岛南端
  chain3: ['阿图岛', '惠灵顿']       // 阿留申群岛 → 新西兰
}
const endBad = CHAINS.filter((c) => {
  const e = CH_ENDS[c.id]
  return !e || c.nodes[0].zh !== e[0] || c.nodes[c.nodes.length - 1].zh !== e[1]
})
ok('⑯ 三条的首尾端点符合定义', endBad.length === 0,
  endBad.map((c) => c.zh + ' 现为 ' + c.nodes[0].zh + '→' + c.nodes[c.nodes.length - 1].zh).join(' | ') ||
  CHAINS.map((c) => c.nodes[0].zh + '→' + c.nodes[c.nodes.length - 1].zh).join(' / '))

// 同一条里岛名不许重复（重复多半是复制粘贴漏改，线上会出现一个原地折返的尖角）
const dupNode = []
for (const c of CHAINS) {
  const seen = new Set()
  for (const n of c.nodes) { if (seen.has(n.zh)) dupNode.push(c.zh + '·' + n.zh); seen.add(n.zh) }
}
ok('⑰ 同一条里岛名不重复', dupNode.length === 0, dupNode.join(' ') || chNodeCount + ' 个岛名全过')

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
