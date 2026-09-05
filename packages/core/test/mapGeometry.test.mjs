// 地图几何的不变量 —— 《地图核查修正任务书_2026-09-05》阶段二五项修正的守门人。
// 运行：npm test
//
// 五段各守一项，都是「改了就静默错、肉眼要拉到特定视角才看得见」的那类：
//   ① 南极洲 2D 填充点判（三档 × 11 个点）—— 110m 档原先在 −84.71° 以南整条横带不填充
//   ② 174 个国名锚点落在本国 10m 单元内 —— NE 的 LABEL_X/Y 对多岛国取整体形心，会落海
//   ③ seamCrossing 左出 / 右出与 y 插值 —— 2D 跨接缝那一段原先整段丢掉
//   ④ tileClip 全级全片不越世界矩形 —— L0/L1 的补边片原先绕过 ±180 压在正确的片上
//   ⑤ densifyLonLat —— 沿纬线的长段在 3D 上沉进球面且走向与 2D 不一致
//
// 判据一律拿【底图原始 NE 单元面】（topojson objects.units）算，与视角、归属解算无关：
// 主权画法怎么变，一个点是海是陆、在不在某个单元里不变。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { feature } from 'topojson-client'
import { antarcticaFillRings } from '../../../src/viz/globe3d/antarctica.js'
import { densifyLonLat, seamCrossing } from '../../../src/viz/geo/lineGeom.js'
import { tileClip, tileBox, span, cols, rows, MAXZ } from '../../../src/viz/imageryTiles.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}

const inRing = (ring, x, y) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
const basemap = (d) => JSON.parse(readFileSync(join(ROOT, 'src/viz/globe3d/data/basemap-' + d + '.json'), 'utf8'))
const unitsOf = (d) => feature(basemap(d), basemap(d).objects.units).features
const polysOf = (g) => !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.coordinates

// ---------- ① 南极洲 2D 填充点判 ----------
// 2D 的世界度坐标：x = ((lon − LON0) mod 360)、y = 90 − lat，陆地按 ±360 三档环绕副本画
// （见 flatCoverage 的 drawLand）。这里按【改后】的口径复算：三档一律走 antarcticaFillRings，
// 逐环各成一个 shape（实测三档无洞环、互不嵌套 → evenodd 等于并集）。
// 期望值取自任务书附录 A：极点附近与几个内陆点必须在里面，几片深入到 −85° 的海必须在外面。
const LON0 = -30
const ATA_PTS = [
  ['极点附近 (0,-89.5)', 0, -89.5, true],
  ['(90,-88)', 90, -88, true],
  ['(-120,-86)', -120, -86, true],
  ['东南极内陆 (100,-75)', 100, -75, true],
  ['南极半岛 (-63,-70)', -63, -70, true],
  ['威德尔海 (-40,-70)', -40, -70, false],
  ['南大洋 (0,-60)', 0, -60, false],
  ['(180,-70)', 180, -70, false],
  ['(-179,-86)', -179, -86, true],
  ['(179,-88)', 179, -88, true],
  // 罗斯冰架前缘之外：三档现状都判在外，任务书没有给期望值，这里只钉「三档一致」（见下）
  ['罗斯冰架 (175,-82)', 175, -82, null]
]
for (const d of ['10m', '50m', '110m']) {
  const ata = unitsOf(d).find((f) => f.properties.u === 'ATA')
  const fr = antarcticaFillRings(ata)
  const filled = (lon, lat) => {
    const wx = (((lon - LON0) % 360) + 360) % 360, wy = 90 - lat
    for (const off of [-360, 0, 360]) {
      for (const r of fr) if (inRing(r.map((p) => [p[0] - LON0 + off, 90 - p[1]]), wx, wy)) return true
    }
    return false
  }
  const bad = ATA_PTS.filter(([, lon, lat, exp]) => exp != null && filled(lon, lat) !== exp)
  ok('① ' + d + ' 南极填充点判（' + ATA_PTS.filter((t) => t[3] != null).length + ' 点）',
    bad.length === 0, bad.map((b) => b[0]).join(' / ') || fr.length + ' 环 · 主环 ' + fr[0].length + ' 点')
  // 收口件的形状不变量：主环末尾追两枚 −90° 顶点把海岸线收成简单多边形。
  //   （两枚 −90° 之间的经度跨度不同档不一样：110m 的主环首尾在 ±180，那两枚就横跨满经度；
  //     10m / 50m 的环自身已经走到 −90°、首尾在 −52° 附近，那两枚只是一段短补丁。故不能拿跨度当判据。）
  const m = fr[0], n = m.length
  ok('① ' + d + ' 主环末尾收口到 −90°', m[n - 1][1] === -90 && m[n - 2][1] === -90,
    '末两点 ' + JSON.stringify(m[n - 2]) + ' → ' + JSON.stringify(m[n - 1]))
  // 真正要守的是【极冠整圈都填上】—— 110m 原先坏的就是这一条（−84.71° 以南整条横带是海色）。
  // ★ 取样经度避开 ±180：主环解缠后的世界 X 跨度恰好是 360°，两个 ±360 副本就在那里拼接，
  //   点正好落在共用边上时 evenodd 射线法是平局（实测 10m 的环在 lon=180 正好有顶点）。
  //   画面上不会缺：两份副本各填半个像素、AA 后合成不透。拼接严不严丝合缝另由下一条守。
  const capMiss = []
  for (let lon = -172.5; lon < 180; lon += 15) for (const lat of [-85.5, -87, -89, -89.9]) if (!filled(lon, lat)) capMiss.push(`${lon},${lat}`)
  ok('① ' + d + ' 极冠整圈都在多边形内（24经×4纬）', capMiss.length === 0, capMiss.slice(0, 6).join(' | ') || '96 点全过')
  // 主环的世界 X 跨度恰为 360° → ±360 三档副本刚好铺满、无重叠无缝（drawLand 就靠这一条）
  let lo = Infinity, hi = -Infinity
  for (const q of m) { if (q[0] < lo) lo = q[0]; if (q[0] > hi) hi = q[0] }
  ok('① ' + d + ' 主环的经度跨度恰为 360°（±360 副本无缝拼接）', Math.abs((hi - lo) - 360) < 1e-9,
    'lon ' + lo.toFixed(4) + ' .. ' + hi.toFixed(4))
}
// 三档对同一个点必须给同一个答案（含没有给期望值的罗斯冰架那一点）
{
  const per = ['10m', '50m', '110m'].map((d) => {
    const fr = antarcticaFillRings(unitsOf(d).find((f) => f.properties.u === 'ATA'))
    return (lon, lat) => {
      const wx = (((lon - LON0) % 360) + 360) % 360, wy = 90 - lat
      for (const off of [-360, 0, 360]) for (const r of fr) if (inRing(r.map((p) => [p[0] - LON0 + off, 90 - p[1]]), wx, wy)) return true
      return false
    }
  })
  const dis = ATA_PTS.filter(([, lon, lat]) => { const v = per.map((f) => f(lon, lat)); return v[0] !== v[1] || v[1] !== v[2] })
  ok('① 三档对同一点给同一答案', dis.length === 0, dis.map((b) => b[0]).join(' / ') || ATA_PTS.length + ' 点全档一致')
}

// ---------- ② 国名锚点必须落在本国 10m 单元内 ----------
// ★ 这条不变量是本平台自己的口径，不是上游数据的：锚点取自 NE 的 LABEL_X/LABEL_Y，
//   而 NE 对多岛国取整体形心、允许落海（GNQ/NZL/TTO 三条实测与 DBF 逐位相等）。
//   本平台的国名层点选与避让都按落点算，故要求落陆。改锚点会当场被这条拓出来。
{
  const src = readFileSync(join(ROOT, 'src/viz/geo/countryZh.js'), 'utf8')
  const body = src.match(/export const COUNTRY_ZH = \{([\s\S]*?)\n\}/)[1]
  const re = /^\s*([A-Z0-9]{3}): \['([^']*)', ('\d{3}'|null), ([-\d.]+|null), ([-\d.]+|null)\]/gm
  const anchors = []
  let m
  while ((m = re.exec(body))) if (m[4] !== 'null') anchors.push({ iso: m[1], zh: m[2], lon: +m[4], lat: +m[5] })

  const units = unitsOf('10m')
  const hits = (lon, lat) => {
    const out = []
    for (const f of units) {
      for (const rings of polysOf(f.geometry)) {
        if (!inRing(rings[0], lon, lat)) continue
        let hole = false
        for (let i = 1; i < rings.length; i++) if (inRing(rings[i], lon, lat)) hole = true
        if (!hole) out.push(f.properties)
      }
    }
    return out
  }
  ok('② 锚点数与表规模', anchors.length === 174, anchors.length + ' 条带锚点')
  const bad = []
  for (const a of anchors) {
    const hs = hits(a.lon, a.lat)
    if (!hs.length) { bad.push(a.iso + ' ' + a.zh + ' 落在海上'); continue }
    if (!hs.some((p) => p.own0 === a.iso || p.u === a.iso)) bad.push(a.iso + ' ' + a.zh + ' 落在 ' + hs.map((p) => p.u).join('/'))
  }
  ok('② 每个国名锚点都落在本国 10m 单元内', bad.length === 0, bad.join(' | ') || anchors.length + ' 条全过')
  // 三条覆写值单独钉一遍：别人顺手「改回 NE 原值」时要看得见是在改什么
  const OVR = { GNQ: [10.35, 1.65], NZL: [175.6, -39.2], TTO: [-61.25, 10.45] }
  const NE_ORIG = { GNQ: [8.9902, 2.333], NZL: [172.787, -39.759], TTO: [-60.9184, 10.9989] }
  const ovBad = Object.keys(OVR).filter((k) => {
    const a = anchors.find((x) => x.iso === k)
    return !a || a.lon !== OVR[k][0] || a.lat !== OVR[k][1]
  })
  ok('② GNQ/NZL/TTO 三条仍是本平台覆写值（NE 原值落海）', ovBad.length === 0,
    ovBad.join(' ') || Object.keys(OVR).map((k) => k + ' ' + NE_ORIG[k].join(',') + ' → ' + OVR[k].join(',')).join(' | '))
}

// ---------- ③ seamCrossing ----------
// 2D 世界度坐标 x ∈ [0,360)，接缝在两条边上。调用方已判定 |Δwx| > 180。
{
  // 往西走出左边缘：pwx 小、wx 大（解缠后 wx−360 < 0）
  const a = seamCrossing(10, 30, 350, 50)
  ok('③ 左出：从 x=0 出、x=360 进', a.xOut === 0 && a.xIn === 360, JSON.stringify({ ...a }))
  // 解缠后 wx′ = −10，t = (0−10)/(−10−10) = 0.5 → y = 30 + 0.5×(50−30) = 40
  ok('③ 左出：y 按解缠后的线性插值', Math.abs(a.y - 40) < 1e-12, 'y=' + a.y + '（期望 40）')

  // 往东走出右边缘：pwx 大、wx 小（解缠后 wx+360 > 360）
  const b = seamCrossing(350, 30, 10, 50)
  ok('③ 右出：从 x=360 出、x=0 进', b.xOut === 360 && b.xIn === 0, JSON.stringify({ ...b }))
  // wx′ = 370，t = (360−350)/(370−350) = 0.5 → y = 40
  ok('③ 右出：y 按解缠后的线性插值', Math.abs(b.y - 40) < 1e-12, 'y=' + b.y + '（期望 40）')

  // 不对称一段：pwx=359, wx=1 → wx′=361，t = 1/2 → y 取中点
  const c = seamCrossing(359, 0, 1, 10)
  ok('③ 贴边的短段：t 落在 [0,1] 且 y 在两端之间', c.xOut === 360 && c.y > 0 && c.y < 10, 'y=' + c.y.toFixed(4))

  // t 恒在 [0,1]：随机扫一遍所有跨缝组合
  let outside = 0, worst = ''
  for (let p = 0; p < 360; p += 3) for (let w = 0; w < 360; w += 3) {
    if (Math.abs(w - p) <= 180) continue
    const r = seamCrossing(p, 0, w, 100)
    if (!(r.y >= -1e-9 && r.y <= 100 + 1e-9)) { outside++; if (!worst) worst = `pwx=${p} wx=${w} y=${r.y}` }
    if (r.xIn !== 360 - r.xOut) { outside++; if (!worst) worst = `pwx=${p} wx=${w} 出入边不互补` }
  }
  ok('③ 全组合扫描：y 恒在两端之间、出入边互补', outside === 0, worst || '跨缝组合全过')
}

// ---------- ④ tileClip ----------
// L0/L1 的网格比世界大（切片脚本按边缘复制补齐了越界部分），渲染端必须按世界矩形裁，
// 否则那段补边内容绕过 ±180 压在正确的片上、同半径同 polygonOffset z-fighting。
{
  let bad = [], nullish = [], overs = []
  for (let z = 0; z <= MAXZ; z++) {
    for (let r = 0; r < rows(z); r++) for (let c = 0; c < cols(z); c++) {
      const q = tileClip(z, r, c)
      if (!q) { nullish.push(`L${z}/${r}/${c}`); continue }
      if (!(q.west + q.spanX <= 180 + 1e-9)) bad.push(`L${z}/${r}/${c} 东边 ${q.west + q.spanX}`)
      if (!(q.north - q.spanY >= -90 - 1e-9)) bad.push(`L${z}/${r}/${c} 南边 ${q.north - q.spanY}`)
      if (!(q.fx > 0 && q.fx <= 1 && q.fy > 0 && q.fy <= 1)) bad.push(`L${z}/${r}/${c} f=${q.fx},${q.fy}`)
      if (q.fx < 1 || q.fy < 1) overs.push(`L${z}/${r}/${c}`)
    }
  }
  ok('④ 全级全片都在世界矩形之内', bad.length === 0, bad.slice(0, 4).join(' | ') || 'L0–L' + MAXZ + ' 全过')
  ok('④ 网格内每一片都有非空的裁剪结果', nullish.length === 0, nullish.slice(0, 4).join(' | ') || '无空片')

  // L3 起世界尺寸恰是片跨度的整数倍 → 本函数是恒等
  const notIdent = []
  for (let z = 3; z <= MAXZ; z++) for (let r = 0; r < rows(z); r++) for (let c = 0; c < cols(z); c++) {
    const q = tileClip(z, r, c), b = tileBox(z, r, c)
    if (q.fx !== 1 || q.fy !== 1 || q.spanX !== b.span || q.spanY !== b.span) notIdent.push(`L${z}/${r}/${c}`)
  }
  ok('④ L3 起 fx = fy = 1（恒等）', notIdent.length === 0, notIdent.slice(0, 4).join(' | ') || 'L3–L' + MAXZ + ' 全恒等')

  // 需要裁的恰好是 L0/L1/L2 的那几片，且裁掉的量与网格越界量对得上
  ok('④ 需要裁的片只出现在 L0–L2', overs.every((k) => /^L[012]\//.test(k)), overs.join(' ') || '（无）')
  const L0c1 = tileClip(0, 0, 1), L1c2 = tileClip(1, 0, 2)
  ok('④ L0 第 1 列裁到东经 180（原 east=396，环绕带 216° 宽）',
    L0c1.west === 108 && L0c1.spanX === 72 && Math.abs(L0c1.fx - 0.25) < 1e-12,
    `west=${L0c1.west} spanX=${L0c1.spanX} fx=${L0c1.fx}`)
  ok('④ L1 第 2 列裁到东经 180（原 east=252，环绕带 72° 宽）',
    L1c2.west === 108 && L1c2.spanX === 72 && Math.abs(L1c2.fx - 0.5) < 1e-12,
    `west=${L1c2.west} spanX=${L1c2.spanX} fx=${L1c2.fx}`)
  const L0r0 = tileClip(0, 0, 0)
  ok('④ L0 单行裁到南纬 −90（原 south=−198）',
    L0r0.north === 90 && L0r0.spanY === 180 && Math.abs(L0r0.fy - 180 / span(0)) < 1e-12,
    `north=${L0r0.north} spanY=${L0r0.spanY} fy=${L0r0.fy.toFixed(4)}`)

  // 越界的行列号返回 null（渲染端据此跳过）
  ok('④ 越界行列号返回 null',
    tileClip(0, 0, cols(0)) === null && tileClip(0, rows(0), 0) === null && tileClip(-1, 0, 0) === null &&
    tileClip(0, -1, 0) === null && tileClip(0, 0, -1) === null)

  // 纹理窗口的自证等式：fx = fy = 1 时与旧的 offset=g/N、repeat=TILE/N 逐项相等
  const TILE = 512, g = 1, N = TILE + 2 * g
  ok('④ 纹理窗口在 fx=fy=1 时退化为旧值', Math.abs((1 - (g + 1 * TILE) / N) - g / N) < 1e-15,
    `1 − (g+TILE)/N = ${(1 - (g + TILE) / N).toFixed(12)} = g/N`)
}

// ---------- ⑤ densifyLonLat ----------
{
  // 端点不动
  const src = [[-139.06, 60], [-120, 60]]
  const d1 = densifyLonLat(src, 1)
  ok('⑤ 端点原样保留', d1[0][0] === -139.06 && d1[0][1] === 60 && d1[d1.length - 1][0] === -120 && d1[d1.length - 1][1] === 60,
    JSON.stringify([d1[0], d1[d1.length - 1]]))
  const gap = (pts) => {
    let mx = 0
    for (let i = 1; i < pts.length; i++) {
      let dx = pts[i][0] - pts[i - 1][0]
      while (dx > 180) dx -= 360
      while (dx < -180) dx += 360
      mx = Math.max(mx, Math.hypot(dx, pts[i][1] - pts[i - 1][1]))
    }
    return mx
  }
  ok('⑤ 加密后相邻间距 ≤ maxDeg', gap(d1) <= 1 + 1e-9, '最大 ' + gap(d1).toFixed(4) + '°（' + d1.length + ' 点）')
  ok('⑤ 换 maxDeg 跟着变', gap(densifyLonLat(src, 5)) <= 5 + 1e-9 && densifyLonLat(src, 5).length < d1.length,
    '5° 档 ' + densifyLonLat(src, 5).length + ' 点 vs 1° 档 ' + d1.length + ' 点')

  // 跨 ±180 的段：就近解缠后插值，不许横穿全图
  const cross = densifyLonLat([[179, 10], [-179, 12]], 1)
  ok('⑤ 跨 ±180 的段不横穿全图', gap(cross) <= 1 + 1e-9 && cross.length >= 3, cross.length + ' 点，最大间距 ' + gap(cross).toFixed(4) + '°')
  ok('⑤ 跨 ±180 的插值点落在 |lon| ≥ 179 那一带（不是绕回 0°）',
    cross.every((p) => Math.abs(p[0]) >= 178.9), JSON.stringify(cross.map((p) => +p[0].toFixed(2))))
  ok('⑤ 输出经度都折回 [−180, 180)', cross.every((p) => p[0] >= -180 && p[0] < 180) && d1.every((p) => p[0] >= -180 && p[0] < 180))

  // 已经够密的原样返回（同一个数组对象）—— 五类边界线的热路径靠这条不多分配
  const dense = [[0, 0], [0.5, 0], [1, 0]]
  ok('⑤ 已够密的原样返回、不复制', densifyLonLat(dense, 1) === dense)
  ok('⑤ 少于两点原样返回', densifyLonLat([[1, 2]], 1).length === 1 && densifyLonLat([], 1).length === 0)

  // 真数据：行政区包里沿纬线的长段加密后弦垂降到抬高量之下
  //   直弦沉深 = (1 − cos(半段角)) × R；省界的抬高量 LIFT−1 = 5e−4 R = 3.19 km。
  //   沉球门槛：1 − cos(d/2) > 5e−4 → d > 3.62°（任务书说的「约 3.6°」就是这个）。
  const LIFT_KM = 0.0005 * 6371
  const sagKm = (deg) => (1 - Math.cos(deg / 2 * Math.PI / 180)) * 6371
  // 门槛解析解：d = 2·acos(1 − 5e−4) = 3.6230°（任务书说的「约 3.6°」）。取 3.6 / 3.7 夹住它。
  const dCrit = 2 * Math.acos(1 - 0.0005) * 180 / Math.PI
  ok('⑤ 沉球门槛 = 2·acos(1−5e−4) ≈ 3.62°', sagKm(3.7) > LIFT_KM && sagKm(3.6) < LIFT_KM && Math.abs(dCrit - 3.623) < 0.002,
    '临界 ' + dCrit.toFixed(4) + '°；3.60° 沉 ' + sagKm(3.6).toFixed(3) + ' km < 抬高 ' + LIFT_KM.toFixed(3) + ' km < 3.70° 的 ' + sagKm(3.7).toFixed(3) + ' km')
  ok('⑤ 加拿大 60°N 那一段：19° 直连沉到陆地面之下，加密到 1° 后沉深只剩抬高的十分之一',
    sagKm(19) - LIFT_KM > 80 && sagKm(1) < LIFT_KM / 10,
    '19° → 沉 ' + sagKm(19).toFixed(1) + ' km（减抬高后仍在陆地面下 ' + (sagKm(19) - LIFT_KM).toFixed(1) + ' km）· 1° → 沉 ' + sagKm(1).toFixed(3) + ' km vs 抬高 ' + LIFT_KM.toFixed(2) + ' km')

  const pack = JSON.parse(readFileSync(join(ROOT, 'resources/adm/CAN-adm1.json'), 'utf8'))
  const lines = [...(pack.borders || [])]
  for (const g of (pack.groups || [])) lines.push(...(g.borders || []))
  let before = 0, after = 0
  for (const ln of lines) { before = Math.max(before, gap(ln)); after = Math.max(after, gap(densifyLonLat(ln))) }
  ok('⑤ CAN-adm1 全包加密后最长段 ≤ 1°', after <= 1 + 1e-9, '加密前 ' + before.toFixed(2) + '° → 加密后 ' + after.toFixed(4) + '°')

  // 岛链表已改调本函数：三条的最大间距仍守在 mapAnnotations 的 2° 门槛内
  const { CHAINS } = await import('../../../src/viz/geo/islandChains.js')
  const chainGap = Math.max(...CHAINS.map((c) => gap(c.pts)))
  ok('⑤ 岛链改调共用件后间距不变（≤ 2°）', chainGap <= 2, '最大 ' + chainGap.toFixed(4) + '°')
}

// ---------- ⑥ 接线检查（源码级）----------
// ★ 上面五段守的是【纯函数算得对】，而这五项的错没一个在纯函数里 —— 错在【没接上】：
//   antarcticaFillRings 一直是对的，只是 2D 的 buildBaseGeo 不调它；tileClip 再对，渲染端
//   不走它也白搭。故这一段拿源码直接判接线（同 flatExportCompat.test.mjs 的做法）：
//   把任一处回退成旧写法，这里当场红。
{
  const FLAT = readFileSync(join(ROOT, 'src/viz/flatmap/flatCoverage.js'), 'utf8')
  const SCENE = readFileSync(join(ROOT, 'src/viz/globe3d/scene.js'), 'utf8')
  const CHAINS_SRC = readFileSync(join(ROOT, 'src/viz/geo/islandChains.js'), 'utf8')
  const seg = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to))

  // 2.5 南极填充：2D 的 buildBaseGeo 必须走收口件，不能照普通国家那样 closePath
  const bbg = seg(FLAT, 'function buildBaseGeo', 'buildBaseGeo(resolvedFeatures(')
  ok('⑥ 2D buildBaseGeo 对 ATA 走 antarcticaFillRings（与 3D 同源）',
    /id === 'ATA'/.test(bbg) && /antarcticaFillRings\(/.test(bbg))
  ok('⑥ 3D scene 也走同一个收口件', /id === 'ATA'/.test(SCENE) && /antarcticaFillRings\(/.test(SCENE))

  // 2.3 接缝：drawPolyline 跨缝时必须插值断开，不能光 stroke + beginPath 就完事
  const dpl = seg(FLAT, 'function drawPolyline', 'function drawText')
  ok('⑥ drawPolyline 调 seamCrossing', /seamCrossing\(/.test(dpl))
  ok('⑥ drawPolyline 出边画到边、入边接回来（否则仍是断开）',
    /lineTo\(c\.xOut/.test(dpl) && /moveTo\(c\.xIn/.test(dpl))

  // 2.2 加密：3D 的三条线路径都要先过经纬面加密
  ok('⑥ classPos（五类国界）先 densifyLonLat 再投影',
    /densifyLonLat\(/.test(seg(SCENE, 'function classPos', 'function buildBorderLines')))
  ok('⑥ setProvinces（一级行政区）先 densifyLonLat 再投影',
    /densifyLonLat\(/.test(seg(SCENE, 'function setProvinces', 'function setProvincesVisible')))
  ok('⑥ setCities（二级行政区）先 densifyLonLat 再投影',
    /densifyLonLat\(/.test(seg(SCENE, 'function setCities', 'function setCitiesVisible')))
  ok('⑥ 岛链表改调共用件、不再自带一份 densify',
    /densifyLonLat\(/.test(CHAINS_SRC) && !/^function densify\(/m.test(CHAINS_SRC))

  // 2.1 瓦片：几何与纹理窗口都要走 tileClip，且几何缓存键得带上宽度
  const mtm = seg(SCENE, 'function makeTileMesh', 'function dropTileMesh')
  const tg = seg(SCENE, 'function tileGeometry', 'function makeTileMesh')
  const tt = seg(SCENE, 'function tileTexture', 'const geoCache')
  ok('⑥ makeTileMesh 走 tileClip 并对 null 跳过', /tileClip\(/.test(mtm) && /if \(!q\) return null/.test(mtm))
  ok('⑥ 几何按裁过的跨度建（不再用整片 b.span）',
    /tileGeometry\(z, r, q\.spanX, q\.spanY\)/.test(mtm) && /spanX \* Math\.PI \/ 180/.test(tg) && /spanY \* Math\.PI \/ 180/.test(tg))
  ok('⑥ 几何缓存键带 spanX（L0/L1 同一行会有两种宽度）', /z \+ '\/' \+ r \+ '\/' \+ spanX/.test(tg))
  ok('⑥ 纹理窗口按 fx / fy 缩（否则几何裁了、图还是整片的）',
    /fx \* TILE \/ N/.test(tt) && /fy \* TILE \/ N/.test(tt) && /1 - \(g \+ fy \* TILE\) \/ N/.test(tt))
  ok('⑥ 细节层与底层两处调用点都对 null 跳过',
    (SCENE.match(/makeTileMesh\([^)]*\)\s*\r?\n\s*if \(!m\) continue/g) || []).length === 2)
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
