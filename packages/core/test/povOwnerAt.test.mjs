// 点选 ownerAt 与地图「画出来的归属」一致（src/viz/geo/povResolver.js）。运行：npm test
//
// 两处曾经对不上（2026-10-20 做「环境场 · 时区」图层时查出来，tzLayer.test.mjs 当时只好按画序自己判）：
//   ① 南极内陆点不中。南极本土环横跨满 360°：10m / 50m 以查询点为锚逐点展开后，查询点离环起点超过 180° 时
//      整段展开区间错开一圈（10m 东经 128° 以东、50m 东经 123° 以东的内陆全落空）；110m 的环贴 −90° 只有一条
//      180 → −180 的边，最短夹角为 0，展开后闭不上，东半球整片落空。右键「设置此国大地颜色」在那里什么都找不到。
//   ② 叠加面互相重叠时取错层。渲染按数组次序画叠加面、后画的盖住先画的，ownerAt 却取第一个命中：
//      50m 的谢巴农场（NE-B58）落在戈兰高地（IL-GOL）里，地图上画黎巴嫩，点到的是叙利亚 / 以色列。
//      只倒序也不够 —— 50m 的 NE-B91（归以色列、宿主以色列，resolvedFeatures 不画它）同样落在戈兰高地里，
//      倒序先命中它，中国视角下画成叙利亚的戈兰就点成了以色列。
// 判据一律取渲染端自己的几何，不拿 ownerAt 的写法对拍它自己：
//   南极 = globe3d/antarctica.js 的 antarcticaFillRings（2D 等距圆柱与 3D 球体画南极洲用的就是它）；
//   叠加面 = resolvedFeatures 按数组次序、最后命中的那一层（与 tzLayer.test.mjs 同口径）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as R from '../../../src/viz/geo/povResolver.js'
import { antarcticaFillRings } from '../../../src/viz/globe3d/antarctica.js'
import { countryAt } from '../../../src/viz/globe3d/countryPick.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

// 10m 静态常驻；50m / 110m 在 Node 里走 registerDetail（ensureDetail 的动态 import 带不了导入属性，见 povResolver.js）
const BUNDLE = { '10m': await R.ensureDetail('10m') }
for (const d of ['50m', '110m']) BUNDLE[d] = R.registerDetail(d, JSON.parse(readFileSync(join(ROOT, 'src/viz/globe3d/data/basemap-' + d + '.json'), 'utf8')))
const POVS = R.povList().map((p) => p.id)
const polysOf = (g) => !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
// 平面偶奇判定（环首尾重不重复都行）。争议面与基础面都已在 ±180° 处切开、没有跨日界线的边，平面判定即画面。
function inRing(r, x, y) {
  let ins = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1]
    if ((yi > y) !== (yj > y) && xi + (y - yi) / (yj - yi) * (xj - xi) > x) ins = !ins
  }
  return ins
}
const inPoly = (rings, x, y) => rings.reduce((acc, r) => acc !== inRing(r, x, y), false)
const boxOf = (rings) => {
  let a = 180, b = -180, c = 90, e = -90
  for (const [x, y] of rings[0]) { if (x < a) a = x; if (x > b) b = x; if (y < c) c = y; if (y > e) e = y }
  return [a, c, b, e]
}
const boxed = (geom) => polysOf(geom).map((p) => ({ p, box: boxOf(p) }))
const inBoxed = (polys, x, y) => polys.some((q) => x >= q.box[0] && x <= q.box[2] && y >= q.box[1] && y <= q.box[3] && inPoly(q.p, x, y))
const fmt = (h) => h ? h.owner + '/' + h.u : 'null'

// ---------- ① 南极内陆 ----------
// 南纬 61° 以南只有南极洲：网格点凡画成南极的，ownerAt 必须是 ATA；凡画成海的，必须为 null ——
// 两头都核，展开区间挪错了也逃不掉。经度取 −177.5 … 177.5（避开 ±180° 收口经线本身）；
// 纬度 −61 … −84 逐度，另加 −84.5 / −84.9 两排（10m / 50m 收口经线顶到 −84.35°、110m 的环在 −84.71° 收口，
// 这一带只有补对了极点收口才判得对）。−85° 以南是 ownerAt 的极冠捷径，不在这里核。
R.setPov(R.DEFAULT_POV, {})
const LATS = []
for (let lat = -61; lat >= -84; lat--) LATS.push(lat)
LATS.push(-84.5, -84.9)
const REPORTED = [[135, -75], [135, -78.59], [150, -79.72]]
for (const d of ['10m', '50m', '110m']) {
  const ata = R.resolvedFeatures(d).find((f) => f.id === 'ATA')
  const fill = ata ? antarcticaFillRings(ata) : []
  const painted = (x, y) => fill.some((r) => [-360, 0, 360].some((s) => inRing(r, x + s, y)))
  const rep = REPORTED.map(([x, y]) => x + ',' + y + '=' + fmt(R.ownerAt(x, y, d)))
  ok(`① [${d}] 报案点 ownerAt 都是 ATA`, rep.every((s) => s.endsWith('=ATA/ATA')), rep.join(' '))
  let land = 0, east = 0, sea = 0
  const bad = []
  for (const lat of LATS) for (let lon = -177.5; lon < 180; lon += 5) {
    const want = painted(lon, lat) ? 'ATA' : null
    const h = R.ownerAt(lon, lat, d), got = h ? h.owner : null
    if (want) { land++; if (lon > 120) east++ } else sea++
    if (got !== want) bad.push(`${lon},${lat} 画 ${want} 点 ${got}`)
  }
  // 东经 120° 以东正是原先整片落空的那一段，必须真撒到点
  ok(`① [${d}] 南纬 61° 以南网格：画成南极的点都点得中、画成海的点都点不中`, bad.length === 0 && land > 600 && east > 100 && sea > 300,
    bad.slice(0, 4).join(' | ') || `陆 ${land}（东经 120° 以东 ${east}）· 海 ${sea}`)
}
const pick = countryAt(135, -75)
ok('①b 右键「设置此国大地颜色」在南极内陆取到南极洲', !!pick && pick.id === 'ATA' && pick.zh === '南极洲', JSON.stringify(pick))

// ---------- ② 叠加面互相重叠 ----------
// 争议单元两两找重叠：每对多边形的包围盒交集上撒 24×24 格点，留同时落在两块面里的点。
// 四套视角下，这些点上 ownerAt 必须等于 resolvedFeatures 按画序最后命中的那层的归属。
const pairsOf = {}
for (const d of ['10m', '50m']) {
  const disp = BUNDLE[d].units.filter((f) => f.properties.dispute).map((f) => ({ u: f.properties.u, polys: boxed(f.geometry) }))
  const pairs = new Set(), pts = []
  for (let a = 0; a < disp.length; a++) for (let c = a + 1; c < disp.length; c++) {
    for (const qa of disp[a].polys) for (const qc of disp[c].polys) {
      const x0 = Math.max(qa.box[0], qc.box[0]), x1 = Math.min(qa.box[2], qc.box[2])
      const y0 = Math.max(qa.box[1], qc.box[1]), y1 = Math.min(qa.box[3], qc.box[3])
      if (x0 >= x1 || y0 >= y1) continue
      for (let s = 0; s < 24; s++) for (let t = 0; t < 24; t++) {
        const x = x0 + (x1 - x0) * (s + 0.5) / 24, y = y0 + (y1 - y0) * (t + 0.5) / 24
        if (inPoly(qa.p, x, y) && inPoly(qc.p, x, y)) { pts.push([x, y]); pairs.add([disp[a].u, disp[c].u].sort().join('∩')) }
      }
    }
  }
  pairsOf[d] = pairs
  const bad = []
  for (const id of POVS) {
    R.setPov(id, {})
    const F = R.resolvedFeatures(d).map((f) => ({ id: f.id, polys: boxed(f.geometry) }))
    const top = (x, y) => { for (let k = F.length - 1; k >= 0; k--) if (inBoxed(F[k].polys, x, y)) return F[k].id; return null }
    for (const [x, y] of pts) {
      const h = R.ownerAt(x, y, d), want = top(x, y)
      if (!h || h.owner !== want) bad.push(`${id} ${x.toFixed(3)},${y.toFixed(3)} 画 ${want} 点 ${fmt(h)}`)
    }
  }
  R.setPov(R.DEFAULT_POV, {})
  ok(`② [${d}] 四套视角下叠加面重叠处，点到的都是画在最上面的那层`, bad.length === 0,
    bad.slice(0, 3).join(' | ') || `${pairs.size} 对重叠（${[...pairs].join(' ') || '无'}）· ${pts.length} 点 × ${POVS.length} 套视角`)
}
// 50m 的三处嵌套必须真被撒到，否则 ② 在 50m 上是空转
const NEED = ['IL-GOL∩NE-B58', 'IL-GOL∩NE-B91', 'PK-AZK∩PK-GB']
ok('②b 50m 的叠加面嵌套确实撒到了点（谢巴农场 ⊂ 戈兰高地 · NE-B91 ⊂ 戈兰高地 · 自由克什米尔 ⊂ 吉尔吉特-巴尔蒂斯坦）',
  NEED.every((k) => pairsOf['50m'].has(k)), NEED.filter((k) => !pairsOf['50m'].has(k)).join(' ') || NEED.join(' '))

// 报案点，四套视角逐个写死：谢巴农场画成黎巴嫩（伊索中立视角下两层都与宿主同归属、不画，露出以色列）；
// NE-B91 那一点只倒序不跳过会点成以色列，中国 / 俄罗斯视角下戈兰画的是叙利亚
const CASES = [
  ['②c 50m 谢巴农场 (35.65, 33.27) 点到的是画出来的那层', [35.65, 33.27], { CN: 'LBN', ISO: 'ISR', US: 'LBN', RU: 'LBN' }],
  ['②d 50m 戈兰高地里 NE-B91 那一块 (35.58, 33.00) 点到的是画出来的那层', [35.58, 33.0], { CN: 'SYR', ISO: 'ISR', US: 'ISR', RU: 'SYR' }]
]
for (const [name, [x, y], want] of CASES) {
  const got = {}
  for (const id of POVS) { R.setPov(id, {}); const h = R.ownerAt(x, y, '50m'); got[id] = h ? h.owner : null }
  R.setPov(R.DEFAULT_POV, {})
  ok(name, POVS.every((id) => got[id] === want[id]), POVS.map((id) => id + '=' + got[id]).join(' · '))
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
