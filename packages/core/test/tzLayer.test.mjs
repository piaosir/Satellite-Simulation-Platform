// 时区图层数据与解析自测（src/viz/geo/tzLayer.js + src/viz/geo/tz/tz-*.json）。运行：npm test
// 任务书 docs/环境场时区显示任务书_2026-10-20.md §7.2 / §7.3。三档拓扑与底图都用 fs 读进来注入。
//
// 这一层回答「地图上这块地此刻是几点」。会出错的地方：
//   ① 几何 —— 量化网格与底图不同、国界段与底图弧对不上（画出双线）、面有缝或重叠、陆地面积凭空增减；
//   ② 主权 —— 时区必须跟着底图「画出来的归属」走：归中国的地一律北京时间，台港澳用各自的时区，
//      藏南 / 阿克赛钦 / 南千岛随视角与自定义覆写换区，冻结单元（台港澳 / 南海诸岛 / 钓鱼岛）怎么覆写都不动；
//   ③ 具体地方的钟点 —— 跨区国家（加 / 美 / 俄 / 澳 / 哈）逐点抽样，海区航海带，日界线两侧差一天；
//   ④ 界线 —— 日界线与 Natural Earth 的日界线重合；同偏移的两区之间不画线（亚利桑那 / 犹他：1 月不画、7 月画）。
// 每条断言的期望值都是查得到的事实（tzdb 2026e 的规则、各国现行时制），不是跑一遍抄下来的数。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FROZEN, CUSTOMIZABLE_DISPUTES, expandOverrides } from '../../../src/viz/geo/frozen.js'
import * as R from '../../../src/viz/geo/povResolver.js'
import { setRules, zoneIndex, zoneName, zoneOffset, rulesVersion } from '../../../src/viz/geo/tzRules.js'
import * as T from '../../../src/viz/geo/tzLayer.js'
import { TZ_CREDIT } from '../../../src/viz/geo/tzCredit.js'
import { TZ_HUE4, tzFillColor, tzBandColor, tzInkFor, TZ_INK } from '../../../src/viz/geo/tzStyle.js'
import { offShort } from '../../../src/viz/env/useTzLayer.js'
import { EXACT } from '../../../src/shared/i18n/uiDict.data.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const J = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))
const SRC = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const noon = (d) => Date.parse(d + 'T12:00:00Z')
const DETAILS = ['10m', '50m', '110m']

setRules(J('src/viz/geo/tz/tzRules.json'))
const BASE = { '10m': J('src/viz/globe3d/data/basemap-10m.json'), '50m': J('src/viz/globe3d/data/basemap-50m.json'), '110m': J('src/viz/globe3d/data/basemap-110m.json') }
R.registerDetail('50m', BASE['50m']); R.registerDetail('110m', BASE['110m'])
const TOPO = {}, B = {}
for (const d of DETAILS) { TOPO[d] = J(`src/viz/geo/tz/tz-${d}.json`); B[d] = T.registerTzDetail(d, TOPO[d]) }

// ---- 小工具 ----
const decInt = (topo) => topo.arcs.map((a) => { let x = 0, y = 0; return a.map(([dx, dy]) => [x += dx, y += dy]) })
const ringArea = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return s / 2 }
const polyArea = (rings) => Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((a, r) => a + Math.abs(ringArea(r)), 0)
const polysOf = (g) => (!g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [])
function inRings(rings, x, y) {
  let ins = false
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1], yj = ring[j][1]
    if ((yi > y) !== (yj > y) && x < (ring[j][0] - ring[i][0]) * (y - yi) / (yj - yi) + ring[i][0]) ins = !ins
  }
  return ins
}
// 点所在的全部面（不止第一个）：查缝隙与重叠用
function facesAt(Bd, x, y) {
  const out = []
  Bd.faces.forEach((f, i) => {
    if (x < f.box[0] || x > f.box[2] || y < f.box[1] || y > f.box[3]) return
    for (const p of T.faceRings(Bd, i)) if (inRings(p, x, y)) { out.push(i); break }
  })
  return out
}
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}
const lineDist = (lines, x, y) => {
  let m = Infinity
  for (const L of lines) for (let i = 1; i < L.length; i++) m = Math.min(m, segDist(x, y, L[i - 1][0], L[i - 1][1], L[i][0], L[i][1]))
  return m
}
// 某时刻、当前视角下各面偏移
const offsAt = (d, ms, civil = true) => T.faceOffsets(B[d], T.resolveZones(B[d]), ms, civil)
const offAtPt = (d, lon, lat, ms) => { const i = T.hitFace(B[d], lon, lat); return i < 0 ? undefined : offsAt(d, ms)[i] }
let rng = 20261020
const rnd = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = (a) => a[Math.floor(rnd() * a.length) % a.length]

// ==================== ① 结构 ====================
for (const d of DETAILS) {
  const tz = TOPO[d], bm = BASE[d], Bd = B[d]
  ok(`① [${d}] 量化网格与同档底图逐位相同`, JSON.stringify(tz.transform) === JSON.stringify(bm.transform))

  // 国界 / 岸线段：两侧是不同基础单元（或陆 / 海）的弧，每个顶点要么就是底图顶点，
  // 要么是剖分时在底图线段上插入的交点 —— 后者量化取整最多偏 √2/2 格（取整到最近格点的最坏情形）
  const bv = new Set()
  const bArcs = decInt(bm)
  for (const a of bArcs) for (const [x, y] of a) bv.add(x + ',' + y)
  const CELL = 4000, idx = new Map()
  for (const a of bArcs) for (let i = 1; i < a.length; i++) {
    const [x0, y0] = a[i - 1], [x1, y1] = a[i]
    for (let cx = Math.floor(Math.min(x0, x1) / CELL); cx <= Math.floor(Math.max(x0, x1) / CELL); cx++) {
      for (let cy = Math.floor(Math.min(y0, y1) / CELL); cy <= Math.floor(Math.max(y0, y1) / CELL); cy++) {
        const k = cx + ',' + cy; let L = idx.get(k); if (!L) idx.set(k, L = []); L.push([x0, y0, x1, y1])
      }
    }
  }
  const nearBm = (x, y) => {
    let m = Infinity; const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL)
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const s of (idx.get((cx + i) + ',' + (cy + j)) || [])) m = Math.min(m, segDist(x, y, s[0], s[1], s[2], s[3]))
    return m
  }
  const tArcs = decInt(tz), nA = tz.arcs.length
  let border = 0, exact = 0, worst = 0
  for (const [ai, a, b] of Bd.adj) {
    if (ai >= nA || a < 0 || b < 0) continue
    const fa = Bd.faces[a], fb = Bd.faces[b]
    if (fa.k !== 'l' && fb.k !== 'l') continue
    if (fa.k === 'l' && fb.k === 'l' && fa.u === fb.u && fa.d === fb.d) continue
    border++
    let allIn = true
    for (const [x, y] of tArcs[ai]) if (!bv.has(x + ',' + y)) { allIn = false; worst = Math.max(worst, nearBm(x, y)) }
    if (allIn) exact++
  }
  ok(`① [${d}] 国界 / 岸线段落在底图线上（插入的交点偏离 ≤ √2/2 格）`, border > 0 && worst <= Math.SQRT1_2 + 1e-9, `${border} 段，${exact} 段逐点就是底图顶点；插点最大偏离 ${worst.toFixed(3)} 格`)

  // 陆地面积守恒（平面经纬度面积：剖分前后同一把尺子）
  let tzLand = 0, all = 0
  Bd.faces.forEach((f, i) => { for (const p of T.faceRings(Bd, i)) { const s = polyArea(p); all += s; if (f.k === 'l') tzLand += s } })
  let bmLand = 0
  for (const f of R.resolvedFeatures(d)) if (!f.over) for (const p of polysOf(f.geometry)) bmLand += polyArea(p)
  const rel = Math.abs(tzLand - bmLand) / bmLand
  ok(`① [${d}] 陆地面积守恒（相对差 < 1e-5）`, rel < 1e-5, `时区陆面 ${tzLand.toFixed(2)} / 底图 ${bmLand.toFixed(2)} deg²，相对差 ${rel.toExponential(2)}`)
  ok(`① [${d}] 全部面铺满整幅（面积和 = 360 × 180）`, Math.abs(all - 64800) / 64800 < 1e-4, `${all.toFixed(2)} deg²`)

  // 面不重叠、无缝：随机点（按面积均匀）恰好落在一个面里
  let zero = 0, multi = 0, firstBad = ''
  for (let n = 0; n < 1500; n++) {
    const x = -180 + 360 * rnd(), y = Math.asin(2 * rnd() - 1) * 180 / Math.PI
    const h = facesAt(Bd, x, y)
    if (h.length === 0) { zero++; if (!firstBad) firstBad = `缝 ${x.toFixed(3)},${y.toFixed(3)}` }
    if (h.length > 1) { multi++; if (!firstBad) firstBad = `叠 ${x.toFixed(3)},${y.toFixed(3)}` }
  }
  ok(`① [${d}] 1500 个随机点各恰好落在一个面里（无缝、无重叠）`, zero === 0 && multi === 0, firstBad)

  // 每面都有解：陆地面在每个视角下都解得出时区；海区偏移是整点或日界线凸区的固定值
  let unsolved = 0, seaBad = 0
  for (const id of [...R.povList().map((p) => p.id), 'custom']) {
    R.setPov(id, {})
    const Z = T.resolveZones(Bd)
    Bd.faces.forEach((f, i) => { if (f.k === 'l' && !(Z[i] >= 0 && zoneName(Z[i]))) unsolved++ })
  }
  // 唯一的非整点海区：查塔姆群岛周边 +12:45（NE time_zones 在那里单划了一块，与岛上民用时一致）
  Bd.faces.forEach((f) => { if (f.k === 's' && !((Number.isInteger(f.o / 60) || f.o === 765) && f.o >= -720 && f.o <= 840)) seaBad++ })
  ok(`① [${d}] 陆地面在每个视角下都解得出时区`, unsolved === 0, `未解 ${unsolved}`)
  ok(`① [${d}] 海区偏移为整点（查塔姆 +12:45 除外）、落在 −12 … +14`, seaBad === 0, `坏 ${seaBad}`)
  ok(`① [${d}] 内陆水域存在且不赋偏移`, Bd.faces.some((f) => f.k === 'w'))

  // 画出来的归属：每个陆地面锚点处，底图【画在最上面】的那一层的归属 = 本面解算用的归属
  // （底图叠加面按数组次序绘制、后者盖前者；ownerAt 取的是第一个命中，与画面在叠加面互相重叠时不一致，故这里按画序自己判）。
  // 叠加面归属是 disputed / none 时底图不画它（露出底下的单元），时区则取事实时区 z —— 两头各按各的口径，单独核
  let mism = 0, firstM = '', dz = 0
  for (const id of R.povList().map((p) => p.id)) {
    R.setPov(id, {})
    const F = R.resolvedFeatures(d).map((f) => ({ id: f.id, polys: polysOf(f.geometry).map((p) => {
      let x0 = 180, x1 = -180, y0 = 90, y1 = -90
      for (const [x, y] of p[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
      return { p, box: [x0, y0, x1, y1] }
    }) }))
    const painted = (x, y) => {
      for (let k = F.length - 1; k >= 0; k--) for (const q of F[k].polys) if (x >= q.box[0] && x <= q.box[2] && y >= q.box[1] && y <= q.box[3] && inRings(q.p, x, y)) return F[k].id
      return null
    }
    const Z = T.resolveZones(Bd)
    Bd.faces.forEach((f, i) => {
      if (f.k !== 'l' || !f.a) return
      const got = R.ownerOf(f.d || f.u, d)
      if (f.d && (got === 'disputed' || got === 'none')) { if (Z[i] !== f.z) { dz++; if (!firstM) firstM = `${id} ${f.d} 归 ${got} 却没取事实时区` } return }
      const want = painted(f.a[0], f.a[1])
      if (want !== got) { mism++; if (!firstM) firstM = `${id} ${f.d || f.u} @${f.a[0]},${f.a[1]} 画的是 ${want} / 解的是 ${got}` }
    })
  }
  ok(`① [${d}] 每个陆地面的归属 = 底图在该处画出来的归属（四套视角；待定归属的叠加面取事实时区）`, mism === 0 && dz === 0, firstM)
}

// ==================== ② 主权 ====================
// 全部预设视角（+ custom + 不认识的 id）× 随机自定义覆写（按界面给得出的选项生成），并蓄意往逐单元覆写里注入冻结单元键
const OCT20 = noon('2026-10-20')
const GROUP = Object.fromEntries(CUSTOMIZABLE_DISPUTES.map((g) => [g.key, g]))
const inGroup = (key) => new Set(GROUP[key].units)
const AKS = inGroup('aksai-chin'), ARP = inGroup('arunachal')
const JUNK = ['IND', 'PAK', 'USA', 'JPN', 'TWN', 'disputed', 'none', '', 'XXX']
const XINJIANG = [[87.6, 43.8, '乌鲁木齐'], [75.99, 39.47, '喀什'], [80.26, 37.11, '和田']]
function sovCheck(d, label) {
  const Bd = B[d], Z = T.resolveZones(Bd), offs = T.faceOffsets(Bd, Z, OCT20, true)
  const errs = []
  Bd.faces.forEach((f, i) => {
    if (f.k !== 'l') return
    const unit = f.d || f.u, own = R.ownerOf(unit, d), off = offs[i]
    if (own === 'CHN' && off !== 480) errs.push(`${unit} 归 CHN 却是 ${off}`)
    if ((FROZEN[f.u] || FROZEN[f.d]) && off !== 480) errs.push(`冻结单元 ${unit} 是 ${off}`)
    if (AKS.has(f.d) && off !== (own === 'IND' ? 330 : 480)) errs.push(`阿克赛钦 ${f.d} 归 ${own} 却是 ${off}`)
    if (ARP.has(f.d) && own === 'CHN' && off !== 480) errs.push(`藏南 ${f.d} 归 CHN 却是 ${off}`)
    if (ARP.has(f.d) && own === 'IND' && off !== 330) errs.push(`藏南 ${f.d} 归 IND 却是 ${off}`)
    if (f.d === 'UA-CR' && (zoneName(Z[i]) !== 'Europe/Simferopol' || off !== 180)) errs.push(`克里米亚归 ${own} 却是 ${zoneName(Z[i])} ${off}`)
    if (f.d === 'RU-KUR' && own === 'RUS' && off !== 660) errs.push(`南千岛归 RUS 却是 ${off}`)
    if (f.d === 'RU-KUR' && own === 'JPN' && off !== 540) errs.push(`南千岛归 JPN 却是 ${off}`)
  })
  for (const [x, y, nm] of XINJIANG) { const i = T.hitFace(Bd, x, y); if (!(i >= 0 && offs[i] === 480)) errs.push(`${nm} 是 ${i >= 0 ? offs[i] : '无面'}`) }
  return errs.map((e) => `${label} ${e}`)
}
{
  const povIds = [...R.povList().map((p) => p.id), 'custom', 'nonexistent']
  for (const d of DETAILS) {
    let cases = 0
    const errs = []
    for (const id of povIds) {
      for (let n = 0; n < 60; n++) {
        const byKey = {}
        for (const g of CUSTOMIZABLE_DISPUTES) if (rnd() < 0.6) byKey[g.key] = pick([...g.opts, 'none'])
        const ov = expandOverrides(byKey)
        for (const f of Object.keys(FROZEN)) if (rnd() < 0.5) ov[f] = pick(JUNK)   // 蓄意注入（setPov 会剔掉）
        R.setPov(id, ov)
        cases++
        errs.push(...sovCheck(d, `${id}#${n}`))
      }
    }
    ok(`② [${d}] ${cases} 组视角 × 覆写：归 CHN 的面 +8、冻结单元 +8、新疆 +8、阿克赛钦 / 藏南随归属、克里米亚恒 Simferopol、南千岛随归属`, errs.length === 0, errs.slice(0, 4).join('；'))
  }
  // 预设视角下的具体期望（藏南 / 南千岛的归属本身由视角决定）
  const at = (d, id, x, y) => { R.setPov(id, {}); return offAtPt(d, x, y, OCT20) }
  const kurAnchor = (d) => { const f = B[d].faces.find((g) => g.d === 'RU-KUR'); return f ? f.a : null }
  for (const d of ['10m', '50m']) {   // 110m 没有争议叠加面（NE 不出这一档），藏南随印度底面
    ok(`② [${d}] 藏南（伊塔那加）中国视角 +480`, at(d, 'CN', 93.62, 27.08) === 480)
    ok(`② [${d}] 藏南（伊塔那加）ISO 视角 +330`, at(d, 'ISO', 93.62, 27.08) === 330)
    const k = kurAnchor(d)
    ok(`② [${d}] 南千岛：中国视角归 JPN → +540`, k && at(d, 'CN', k[0], k[1]) === 540)
    ok(`② [${d}] 南千岛：ISO 视角归 RUS → +660`, k && at(d, 'ISO', k[0], k[1]) === 660)
    ok(`② [${d}] 阿克赛钦四套视角都 +480`, R.povList().every((p) => at(d, p.id, 79.5, 35.2) === 480))
    R.setPov('custom', expandOverrides({ 'aksai-chin': 'IND' }))
    ok(`② [${d}] 阿克赛钦自定义归 IND → +330`, offAtPt(d, 79.5, 35.2, OCT20) === 330)
    for (const v of ['UKR', 'RUS']) {
      R.setPov('custom', expandOverrides({ crimea: v }))
      const i = T.hitFace(B[d], 34.1, 44.95), Z = T.resolveZones(B[d])
      ok(`② [${d}] 克里米亚归 ${v}：Europe/Simferopol +180`, zoneName(Z[i]) === 'Europe/Simferopol' && offAtPt(d, 34.1, 44.95, OCT20) === 180)
    }
  }
  // 台港澳：取各自面的锚点（城市坐标在粗档里可能落到海上）；110m 底图把港澳并进了 CHN，只剩台湾单列
  for (const d of DETAILS) {
    R.setPov('CN', {})
    const Z = T.resolveZones(B[d]), offs = T.faceOffsets(B[d], Z, OCT20, true)
    const want = { 'CN-TW': 'Asia/Taipei', 'CN-HK': 'Asia/Hong_Kong', 'CN-MO': 'Asia/Macau' }
    const present = Object.keys(want).filter((u) => B[d].faces.some((f) => f.u === u))
    const bad = []
    B[d].faces.forEach((f, i) => { if (want[f.u] && !(zoneName(Z[i]) === want[f.u] && offs[i] === 480)) bad.push(`${f.u} ${zoneName(Z[i])} ${offs[i]}`) })
    ok(`② [${d}] ${present.join(' / ')} +480，各用自己的时区`, present.includes('CN-TW') && (d === '110m' || present.length === 3) && bad.length === 0, bad.join('；'))
  }
  // 反证：把「中国一律北京时间」那条数据规则拿掉（新疆那块面改回 TBB 的事实时区 = 东六区），检查必须报错 —— 证明上面不是空转
  {
    const d = '10m', Bd = B[d]
    R.setPov('CN', {})
    const i = T.hitFace(Bd, 87.6, 43.8), f = Bd.faces[i]
    const plus6 = ['Asia/Dhaka', 'Asia/Bishkek', 'Asia/Thimphu'].map(zoneIndex).find((z) => z >= 0 && zoneOffset(z, OCT20, true) === 360)
    const keep = { z: f.z, t: f.t }
    f.z = plus6; f.t = null
    const errs = sovCheck(d, '反证')
    f.z = keep.z; f.t = keep.t
    ok('② 反证：新疆那块面改成东六区，主权检查必须报错', plus6 >= 0 && errs.some((e) => /乌鲁木齐|归 CHN/.test(e)), errs[0] || '没报错')
    ok('② 反证后复原：新疆 +480', offAtPt(d, 87.6, 43.8, OCT20) === 480)
  }
}

// ==================== ③ 国家抽样（中国视角；跨区国家逐点） ====================
{
  R.setPov('CN', {})
  const PTS = [
    // [名, lon, lat, 日期, 期望]
    ['加拿大 BC（温哥华）', -123.12, 49.28, '2026-12-01', -420], ['加拿大 阿尔伯塔（卡尔加里）', -114.07, 51.05, '2026-12-01', -360],
    ['加拿大 萨斯喀彻温（里贾纳）', -104.6, 50.45, '2026-12-01', -360], ['加拿大 曼尼托巴（温尼伯）', -97.14, 49.9, '2026-12-01', -300],
    ['加拿大 魁北克南部（蒙特利尔）', -73.57, 45.5, '2026-12-01', -300],
    ['美国 亚利桑那（凤凰城，纳瓦霍保留地外）', -112.07, 33.45, '2026-07-01', -420], ['美国 犹他（盐湖城）', -111.89, 40.76, '2026-07-01', -360],
    ['美国 印第安纳 Gary（中部夏令时）', -87.35, 41.59, '2026-07-01', -300], ['美国 纳瓦霍保留地（窗岩，随夏令时）', -109.05, 35.68, '2026-07-01', -360],
    ['俄罗斯 伏尔加格勒', 44.51, 48.71, '2026-07-01', 180], ['俄罗斯 萨马拉', 50.15, 53.2, '2026-07-01', 240], ['俄罗斯 鄂木斯克', 73.37, 54.99, '2026-07-01', 360],
    ['俄罗斯 新西伯利亚', 82.92, 55.03, '2026-07-01', 420], ['俄罗斯 萨哈林', 142.73, 46.96, '2026-07-01', 660], ['俄罗斯 楚科奇（阿纳德尔）', 177.5, 64.73, '2026-07-01', 720],
    ['澳大利亚 布罗肯希尔（随南澳）', 141.47, -31.95, '2026-07-15', 570], ['澳大利亚 悉尼（冬季）', 151.2, -33.87, '2026-07-15', 600],
    ['蒙古 乌兰巴托', 106.9, 47.92, '2026-07-01', 480], ['蒙古 科布多（西部）', 91.64, 48.0, '2026-07-01', 420],
    ['巴西 巴西利亚', -47.93, -15.78, '2026-07-01', -180], ['巴西 马瑙斯', -60.02, -3.1, '2026-07-01', -240],
    ['印度尼西亚 雅加达', 106.85, -6.2, '2026-07-01', 420], ['印度尼西亚 查亚普拉', 140.7, -2.53, '2026-07-01', 540],
    ['刚果（金）金沙萨', 15.31, -4.32, '2026-07-01', 60], ['刚果（金）卢本巴希', 27.48, -11.66, '2026-07-01', 120],
    ['西班牙 加那利（大加那利岛）', -15.6, 28.0, '2026-07-01', 60, '小岛'], ['葡萄牙 亚速尔（圣米格尔岛）', -25.45, 37.78, '2026-07-01', 0, '小岛']
  ]
  for (const d of DETAILS) {
    const bad = []
    // 110m 底图没有大西洋小岛（加那利 / 亚速尔），那一档跳过这两点
    const use = PTS.filter((p) => !(d === '110m' && p[5] === '小岛'))
    for (const [nm, x, y, day, exp] of use) { const v = offAtPt(d, x, y, noon(day)); if (v !== exp) bad.push(`${nm} ${v}（应 ${exp}）`) }
    ok(`③ [${d}] ${use.length} 个地点的当地偏移`, bad.length === 0, bad.join('；'))
    const offs = offsAt(d, noon('2026-07-01')), kaz = []
    B[d].faces.forEach((f, i) => { if (f.k === 'l' && f.u === 'KAZ' && !f.d && offs[i] !== 300) kaz.push(offs[i]) })
    ok(`③ [${d}] 哈萨克斯坦全境 2026 年 +300`, kaz.length === 0 && B[d].faces.some((f) => f.u === 'KAZ'), kaz.join(','))
    const offsStd = offsAt(d, noon('2026-07-01'), false)
    const iS = T.hitFace(B[d], -111.89, 40.76), iA = T.hitFace(B[d], -112.07, 33.45)
    ok(`③ [${d}] 标准时档：犹他与亚利桑那都是 −420`, offsStd[iS] === -420 && offsStd[iA] === -420)
  }
}

// ==================== ④ 海区 ====================
for (const d of DETAILS) {
  R.setPov('CN', {})
  const ms = noon('2026-07-01')
  ok(`④ [${d}] (−150°, 20°N) 航海带 −10`, offAtPt(d, -150, 20, ms) === -600)
  ok(`④ [${d}] (150°, 0°) 航海带 +10`, offAtPt(d, 150, 0, ms) === 600)
  ok(`④ [${d}] 基里巴斯凸区 (−155°, −2°) +14`, offAtPt(d, -155, -2, ms) === 840)
  ok(`④ [${d}] (−170°, −15°)（萨摩亚以东、日界线东侧）−11`, offAtPt(d, -170, -15, ms) === -660)
  const ic = T.hitFace(B[d], 51, 42)
  ok(`④ [${d}] 里海中心无时区`, ic >= 0 && B[d].faces[ic].k === 'w' && Number.isNaN(offAtPt(d, 51, 42, ms)))
}

// ==================== ⑤ 界线 ====================
// 日界线：与 Natural Earth 10m geographic_lines 的日界线（下表是它在这些纬度的穿越经度）重合。
// 容差 0.005°：NE 自己的两个图层（time_zones 的凸区边与 geographic_lines 的日界线）实测相差到 0.002°，
// 海区凸区按前者建，故不苛求与后者逐格相等。
const NE_IDL = [
  [-60, [180]], [-45, [-172.5]], [-30, [-172.5]], [-20, [-172.5]], [-10, [-171.098, -154.996, -150]], [-5, [-151.828]],
  [0, [180, -158.771, -153.697]], [5, [180]], [20, [180]], [40, [180]], [50, [176.092]], [52, [172.064]], [55, [172.915]],
  [60, [-179.165]], [65, [-170.042]], [70, [-171.778]], [80, [180]]
]
const lonDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180)
for (const d of DETAILS) {
  R.setPov('CN', {})
  const L = T.boundaryLines(B[d], offsAt(d, noon('2026-07-01')))
  const cross = (lines, y) => {
    const out = []
    for (const P of lines) for (let i = 1; i < P.length; i++) {
      const [x0, y0] = P[i - 1], [x1, y1] = P[i]
      if ((y0 > y) !== (y1 > y)) out.push(x0 + (y - y0) / (y1 - y0) * (x1 - x0))
    }
    return out
  }
  const bad = []
  for (const [y, want] of NE_IDL) {
    const got = cross(L.idl, y)
    const okRow = got.length === want.length && want.every((w) => got.some((g) => lonDiff(g, w) <= 0.005))
    if (!okRow) bad.push(`${y}°: ${got.map((g) => g.toFixed(3)).join(',')}（NE ${want.join(',')}）`)
  }
  ok(`⑤ [${d}] 日界线在 ${NE_IDL.length} 条纬线上的穿越点与 NE 日界线重合（≤ 0.005°）`, L.idl.length > 0 && bad.length === 0, bad.join('；'))
  // 日界线两侧：每段日界线中点往两侧各挪一点，两边偏移差 ≥ 12 h
  let segs = 0, wrong = 0, firstW = ''
  for (const P of L.idl) for (let i = 1; i < P.length; i++) {
    const [x0, y0] = P[i - 1], [x1, y1] = P[i], len = Math.hypot(x1 - x0, y1 - y0)
    if (len < 0.05 || Math.abs(y0) > 89 || Math.abs(y1) > 89) continue
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, nx = -(y1 - y0) / len * 0.01, ny = (x1 - x0) / len * 0.01
    const a = offAtPt(d, mx + nx, my + ny, noon('2026-07-01')), b = offAtPt(d, mx - nx, my - ny, noon('2026-07-01'))
    segs++
    if (!(Math.abs(a - b) >= 720)) { wrong++; if (!firstW) firstW = `${mx.toFixed(3)},${my.toFixed(3)}：${a} / ${b}` }
  }
  ok(`⑤ [${d}] 日界线 ${segs} 段两侧偏移差都 ≥ 12 h`, segs > 20 && wrong === 0, firstW)
  // 同偏移不画线：亚利桑那 / 犹他之间（37°N，纳瓦霍保留地以西）—— 1 月两边都是 MST 不画，7 月犹他夏令时要画
  const jan = T.boundaryLines(B[d], offsAt(d, noon('2026-01-15'))), jul = L
  const all = (q) => q.land.concat(q.sea, q.idl)
  const dJan = lineDist(all(jan), -112.5, 37.0), dJul = lineDist(all(jul), -112.5, 37.0)
  ok(`⑤ [${d}] 亚利桑那 / 犹他界：1 月不画、7 月画`, dJan > 0.05 && dJul < 0.01, `1 月最近界线 ${dJan.toFixed(3)}°，7 月 ${dJul.toFixed(4)}°`)
  // 岸线不是时区界：沿海城市外海一点、陆上一点同偏移时，两者之间不该冒出一条线（取青岛：陆 +8 / 海 +8）
  ok(`⑤ [${d}] 岸线不算时区界（青岛陆海同为 +8，近岸无界线）`, lineDist(all(jul), 120.4, 36.05) > 0.2)
  // 陆上时区界与海上航海带分界分两类（样式不同）：陆上那类两侧都是陆地、海上那类两侧都是海
  const sideKinds = (cls) => {
    let bad = 0
    for (const [ai, a, b] of B[d].adj) {
      if (a < 0 || b < 0) continue
      const arc = B[d].arcs[ai]
      if (!L[cls].includes(arc)) continue
      const want = cls === 'land' ? 'l' : 's'
      if (B[d].faces[a].k !== want || B[d].faces[b].k !== want) bad++
    }
    return bad
  }
  ok(`⑤ [${d}] 陆上时区界两侧都是陆地、海上分界两侧都是海`, L.land.length > 0 && L.sea.length > 0 && sideKinds('land') === 0 && sideKinds('sea') === 0)
}

// ==================== ⑥ 连通区 / 描亮 / 色块 / 命中 ====================
{
  const d = '50m', Bd = B[d]
  R.setPov('CN', {})
  const offs = offsAt(d, OCT20)
  const C = T.components(Bd, offs)
  const cn = C.list.filter((c) => c.k === 'l' && c.off === 480)
  ok('⑥ 连通区：+8 陆地区存在且都有锚点', cn.length > 0 && cn.every((c) => c.anchor && c.anchor.length === 3))
  const iBj = T.hitFace(Bd, 116.4, 39.9), iSh = T.hitFace(Bd, 121.47, 31.23), iUr = T.hitFace(Bd, 87.6, 43.8)
  ok('⑥ 连通区：北京、上海、乌鲁木齐同一个区', C.comp[iBj] === C.comp[iSh] && C.comp[iSh] === C.comp[iUr])
  const hi = T.highlightLines(Bd, offs, 480)
  ok('⑥ 描亮 +8：外轮廓非空，且不含 ±180° 图边', hi.length > 0 && hi.every((P) => !P.every(([x]) => Math.abs(Math.abs(x) - 180) < 1e-9)))
  // 选择时区多选：单值与单元素数组同一结果；+8 与 +9 合选 ⊇ 各自外轮廓（公共边照样勾）；空选为空
  const h9 = T.highlightLines(Bd, offs, 540), h89 = new Set(T.highlightLines(Bd, offs, [480, 540]))
  ok('⑥ 选择时区：[+8] 与 +8 同一组弧', T.highlightLines(Bd, offs, [480]).length === hi.length && T.highlightLines(Bd, offs, [480]).every((a, i) => a === hi[i]))
  ok('⑥ 选择时区：+8、+9 合选含两者各自的全部外轮廓', hi.every((a) => h89.has(a)) && h9.every((a) => h89.has(a)) && h89.size <= hi.length + h9.length)
  ok('⑥ 选择时区：空选不勾', T.highlightLines(Bd, offs, []).length === 0)
  const G = T.fillGroups(Bd, offs)
  const seaCount = G.filter((g) => g.k === 's').length, landCount = G.filter((g) => g.k === 'l').length
  ok('⑥ 色块分组：陆 / 海分开，组内偏移一致', seaCount > 0 && landCount > 0 && G.every((g) => g.faces.every((i) => offs[i] === g.off && Bd.faces[i].k === g.k)))
  ok('⑥ 命中：经度绕回（−180 / 180 / 540）同一面', T.hitFace(Bd, 179.99, 10) === T.hitFace(Bd, -180.01, 10) && T.hitFace(Bd, 116.4, 39.9) === T.hitFace(Bd, 116.4 + 360, 39.9))
  ok('⑥ 偏移签名：同一组偏移签名相同，改一面就变', T.offsetsSig(offs) === T.offsetsSig(Float64Array.from(offs)) && T.offsetsSig(offs) !== T.offsetsSig(Float64Array.from(offs, (v, i) => (i === iBj ? v + 60 : v))))
  // 夏令时跃迁：欧洲 2026-03-29 01:00Z 前后，偏移签名必变（每拍增量重建靠它）
  const s0 = T.offsetsSig(offsAt(d, Date.parse('2026-03-29T00:59:00Z'))), s1 = T.offsetsSig(offsAt(d, Date.parse('2026-03-29T01:01:00Z')))
  ok('⑥ 欧洲夏令时跃迁前后偏移签名不同', s0 !== s1)
}

// ==================== ⑦ 署名与版本 ====================
{
  const tbb = /timezone-boundary-builder (\S+)/
  const vers = DETAILS.map((d) => (tbb.exec(TOPO[d].meta.source || '') || [])[1])
  ok('⑦ 三档拓扑的 TBB 版本一致', vers.every((v) => v && v === vers[0]), vers.join(','))
  ok('⑦ 三档拓扑的 tzdb 版本 = 规则表版本', DETAILS.every((d) => (TOPO[d].meta.source || '').includes('tzdb ' + rulesVersion())))
  ok('⑦ 署名串里的 TBB / tzdb 版本与随包数据一致', TZ_CREDIT.includes('timezone-boundary-builder ' + vers[0]) && TZ_CREDIT.includes('tzdb ' + rulesVersion()), TZ_CREDIT)
  ok('⑦ 署名串写明 © OpenStreetMap 与 ODbL', /© OpenStreetMap/.test(TZ_CREDIT) && /ODbL/.test(TZ_CREDIT))
  ok('⑦ 署名串在 uiDict 里有英文（整串 EXACT 键）', typeof EXACT[TZ_CREDIT] === 'string' && !/[一-鿿]/.test(EXACT[TZ_CREDIT]), EXACT[TZ_CREDIT] || '缺')
  ok('⑦ 规则表区数 = 拓扑登记的区数', DETAILS.every((d) => TOPO[d].meta.nzone === J('src/viz/geo/tz/tzRules.json').zones.length))
  const lic = SRC('resources/licenses/license.timezone-boundary-builder.txt')
  ok('⑦ 许可说明含 ODbL URI 与改制方法', /opendatacommons\.org\/licenses\/odbl\/1-0/.test(lic) && /Method of alteration/.test(lic))
}

// ==================== ⑧ 配色（CIA 体例） ====================
{
  const hue = (h) => TZ_HUE4[((h % 4) + 4) % 4]
  // 相邻整点必不同色、同偏移全球同色；陆地全调、海区同色相的浅调
  let adjSame = 0
  for (let h = -12; h < 14; h++) if (tzFillColor(h * 60, 'l').color === tzFillColor((h + 1) * 60, 'l').color) adjSame++
  ok('⑧ 相邻整点时区的陆地色两两不同（−12 … +14）', adjSame === 0)
  ok('⑧ 四色循环：+8 与 −8、0 同色（≡0 鼠尾草绿），+5 与 +1 同色（≡1 沙黄）',
    tzFillColor(480, 'l').color === hue(0).land && tzFillColor(-480, 'l').color === hue(0).land && tzFillColor(0, 'l').color === hue(0).land &&
    tzFillColor(300, 'l').color === hue(1).land && tzFillColor(60, 'l').color === hue(1).land)
  ok('⑧ 海区取同色相的浅调', tzFillColor(480, 's').color === hue(0).sea && tzBandColor(8) === hue(0).sea && tzBandColor(-5) === hue(3).sea)
  const ind = tzFillColor(330, 'l'), cha = tzFillColor(765, 's')
  ok('⑧ 半点 / 45 分区是上下两个整点色的斜纹（印度 +5:30 = 沙黄 / 赤陶；查塔姆海区 +12:45 = 浅绿 / 浅沙）',
    ind.color === hue(1).land && ind.hatch === hue(2).land && cha.color === hue(0).sea && cha.hatch === hue(1).sea && !!ind.flat)
  ok('⑧ 墨色两档：色块铺着按纸图深色，色块关着且底下是影像按浅色', tzInkFor(true, '#e8e0c9', 1) === TZ_INK.paper && tzInkFor(true, '#e8e0c9', 0) === TZ_INK.dark && tzInkFor(false, '#e8e0c9', 0) === TZ_INK.paper)
  ok('⑧ 时区号写法：+8 / −5 / +5:30 / +12:45 / 0', offShort(480) === '+8' && offShort(-300) === '−5' && offShort(330) === '+5:30' && offShort(765) === '+12:45' && offShort(0) === '0')
}

// ==================== ⑨ 源码级不变量 ====================
{
  const page = SRC('src/pages/ConstellationMap3D.vue')
  const geoAt = page.indexOf("v-show=\"shellUi.side === 'geo'\"")
  const s0 = page.indexOf('data-sec="geo-tz"'), s1 = page.indexOf('data-sec="geo-crs"', s0)
  const sec = s0 >= 0 && s1 > s0 ? page.slice(s0, s1) : ''
  ok('⑨ 时区分区在「地图综合设置」视图里（岛链之后、坐标系之前），环境场视图里不再有', geoAt >= 0 && s0 > geoAt && s0 > page.indexOf('data-sec="geo-chain"') && !/data-sec="env-tz"/.test(page))
  ok('⑨ 分区头带 layersw 拨杆与「恢复本节默认」', /class="layersw sect-layersw"/.test(sec) && /resetSec\('tz'\)/.test(sec))
  ok('⑨ 分区内没有 .tip / .note / .hint / .lead 说明元素', sec && !/class="[^"]*\b(tip|note|hint|lead)\b/.test(sec))
  ok('⑨ 口径是必选其一的分段（现行 / 标准时）', /aria-label="时区口径"/.test(sec) && /class="seg nseg"/.test(sec))
  ok('⑨ 宿主每拍喂时刻、切 2D 补喂、换底图档换拓扑、悬停勾轮廓、启动时恢复',
    /tz\.tick\(clock\.tMs\)/.test(page) && /flat\.setTzLayer\(tz\.currentSpec\(\)\)/.test(page) && /tz\.setDetail\(\)/.test(page) &&
    /tz\.hoverAt\(ll\.lat, ll\.lon\)/.test(page) && /tz\.start\(\)/.test(page))
  const flat = SRC('src/viz/flatmap/flatCoverage.js')
  const body = (name) => { const i = flat.indexOf(name); if (i < 0) return ''; let k = flat.indexOf('{', i), dep = 0; for (let j = k; j < flat.length; j++) { if (flat[j] === '{') dep++; else if (flat[j] === '}' && --dep === 0) return flat.slice(k, j + 1) } return '' }
  ok('⑨ 2D 静态层三处都画时区（色块 / 界线 / 标注）', /drawTzFill\(\)/.test(body('function drawBelowContent')) && /drawTzLines\(\)/.test(body('function drawLinesContent')) && /drawTzLabels\(/.test(body('function drawTextContent')))
  ok('⑨ 2D 屏上 draw 与导出 exportRender 都画时区条；悬停轮廓只在屏上', /drawTzStrips\(\)/.test(body('  function draw()')) && /drawTzStrips\(\)/.test(body('    exportRender(targetCtx, opts)')) &&
    /drawTzHover\(\)/.test(body('  function draw()')) && !/drawTzHover\(\)/.test(body('    exportRender(targetCtx, opts)')))
  ok('⑨ 导出走同一套静态内容（下层 + 上层）', /drawBelowContent\(/.test(body('    exportRender(targetCtx, opts)')) && /drawAboveContent\(/.test(body('    exportRender(targetCtx, opts)')))
  const scene = SRC('src/viz/globe3d/scene.js')
  ok('⑨ 3D 场景导出 setTzLayer / setTzHover', /\bsetTzLayer,/.test(scene) && /\bsetTzHover,/.test(scene))
  const about = SRC('src/components/AboutDialog.vue')
  ok('⑨ 关于窗口有署名一行（且不恢复整节「第三方署名」）', /\{\{ TZ_CREDIT \}\}/.test(about) && !/>第三方署名</.test(about))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
