// 全球底图「主权解算层」构建：Natural Earth 5.x → src/viz/globe3d/data/basemap-{110m,50m,10m}.json
//
// 与旧 countries-*.json（world-atlas，一份画好的国界）最大的不同：
//   底图 = 「争议单元级的面」+「一张归属映射表」，国界/着色/点选/标注全部在运行时按归属解算。
//   视角只是一张归属表（src/viz/geo/povs/*.json，每套几 KB），几何全球唯一一份。
//
// 数据源（均为公有领域，naciscdn 官方分发，shapefile zip）：
//   ne_*_admin_0_map_units             基础单元（铺满陆地的分区）
//   ne_10m_admin_0_disputed_areas      争议单元（★ 是叠加层，与 map_units 几何重叠，见下）
//   ne_50m_admin_0_breakaway_disputed_areas  同上，50m 档 NE 用的是这个名字
//   （110m 档 NE 根本不出争议面图层 → 该档只有基础单元级的视角差异，见 DISPUTED_LAYER）
//   ne_*_admin_0_boundary_lines_land   自带几何的线（停火线/未定界/主张线）
//
// ★ 关于「重叠」——与任务书设想的「一张互斥分区」不同，NE 的实际数据模型是【基础分区 + 争议叠加】：
//   经点判定实测，阿克赛钦/藏南/克里米亚/西撒等争议面都落在某个 map_unit 里面（宿主 host），
//   而不是从宿主里挖掉的。要变成互斥分区就得做面的布尔差，那需要引入裁剪库并自担精度风险。
//   这里改用等价、且不需要任何布尔运算的做法：
//     · 面：先画基础单元、再把争议单元按解算出的归属【盖在上面】——争议面 ⊂ 宿主面，覆盖即等于挖掉。
//     · 线：arc 归属表 adj 已把争议单元替换进对应 arc 的一侧（见 adj 段），派生规则与任务书一字不差。
//     · 点选：先测争议单元（更小更具体），再测基础单元。
//   校验口径随之改为：基础单元之间无重叠（arc 至多两个基础 owner）、每个争议单元恰好一个宿主。
//
// ★ 与旧 nanhaiDashes.js 同一句话：南海十段线为「近似示意坐标」，仅供工程显示。正式对外发布须替换为
//   国家测绘地理信息主管部门批准的审图号底图（如天地图 / GS(xxxx)xxxx 号）坐标，
//   本文件的 CLAIM_LINES 即为该替换入口。
//
// 用法：node scripts/build-basemap.mjs [110m|50m|10m ...]（缺省三档全出）。需联网，原始数据缓存在 scripts/_ne/。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { topology } from 'topojson-server'
import { neLayer } from './lib/neFetch.mjs'
import { polysOf, linesOf, inRings, ringArea, interiorPoint, decodeArc, arcsOfGeom } from './lib/geomUtil.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUTDIR = path.join(ROOT, 'src', 'viz', 'globe3d', 'data')
const POVDIR = path.join(ROOT, 'src', 'viz', 'geo', 'povs')
const QUANT = 1e5   // 与旧 world-atlas 底图同一量化档（scale ≈ 0.0036°/格），换源不改精度观感

// ---------- 稳定单元 id ----------
// 基础单元缺省用 NE 的 SU_A3（map_units 层内唯一、跨版本稳定）；下面几项改成可读 id，
// 因为它们要出现在冻结常量 src/viz/geo/frozen.js 里（那份表是人读人改的）。
const ID_BASE = { TWN: 'CN-TW', HKG: 'CN-HK', MAC: 'CN-MO' }
// 争议单元用 NE 的 BRK_A3（B00…C04）作稳定键；常被引用的这些给可读 id。
const ID_DISP = {
  B05: 'IN-PK-KAS', B09: 'PK-AZK', B08: 'PK-GB', B45: 'KAS-SIA', B07: 'CN-AKS', B06: 'CN-SHK',
  B00: 'IN-ARP', B03: 'IN-CN-DMC', B04: 'IN-CN-SMD', B01: 'IN-CN-TRP', B02: 'IN-CN-BRH',
  B89: 'UA-CR', C02: 'UA-DPR', C03: 'UA-LPR', B19: 'MA-EH', B28: 'EH-SADR', B16: 'IL-GOL',
  B13: 'SD-ABY', B35: 'GE-AB', B37: 'GE-SO', B36: 'MD-TRA', B38: 'AZ-ART', B29: 'RU-KUR',
  B18: 'JP-SEN', B39: 'KR-DOK', B46: 'SPRATLY', B47: 'PARACEL', B70: 'SCARBOROUGH',
  B50: 'CU-GTMO', B17: 'KE-ILEMI', B74: 'SS-ILEMI', B93: 'EG-HAL', B94: 'BIR-TAWIL',
  B75: 'BT-CN-NW', B76: 'BT-CN-CHUMBI', B56: 'GY-ESSEQUIBO', B97: 'AR-CL-SPI'
}
// 手工修正表（NE 的 map_units + disputed_areas 并非完美互补，会留下少量 sliver / 宿主判错）。
// 键为单元 id：{ host } 强制宿主、'drop' 整条丢弃。留空即表示当前三档实测无需修正（校验会打印异常清单）。
const OVERRIDE = {}

// 视角 → NE 属性列。NE 官方对每个面都标了 32 套视角下的归属，本平台取其中四套。
const POVS = [
  { id: 'CN', zh: '中国视角', en: 'China', attr: 'ADM0_A3_CN' },
  { id: 'ISO', zh: 'ISO 中立', en: 'ISO neutral', attr: 'ADM0_ISO' },
  { id: 'US', zh: '美国视角', en: 'United States', attr: 'ADM0_A3_US' },
  { id: 'RU', zh: '俄罗斯视角', en: 'Russia', attr: 'ADM0_A3_RU' }
]

// 自带几何的线：只收派生规则表达不出来的三类。国际边界（International boundary）整类丢弃 ——
// 它与「两侧 owner 不同 → admin0」派生出的线是同一条，留着必成双线毛边。
const LINE_CLS = {
  'Line of control (please verify)': 'loc',
  'Indefinite (please verify)': 'indefinite',
  'Indeterminant frontier': 'indefinite',
  'Disputed (please verify)': 'indefinite'
}
// 去重缓冲半径（度）：自带线上的点落进任一条派生 arc 的该半径内即视为「派生线已表达」
const EPS = { '10m': 0.02, '50m': 0.05, '110m': 0.1 }
const COVER_FRAC = 0.8   // 覆盖率达到即整条丢弃

// 主张线（cls='claim'）——海上主张的通用槽位，南海十段线只是其中一条。
// 数据来源：geojson.cn《九段线》(MultiLineString)，底图取自中国民政部区划地名公共服务(xzqh.mca.gov.cn)
// + OpenStreetMap 关系，WGS-84 经纬度，按官方走向数字化。中国从未公布官方坐标，此为公开数字化成果中较权威的一版。
const NANHAI = [
  [[109.51763678906526, 16.360467782665847], [109.72339159230361, 16.05587198177934], [109.8780414893003, 15.766823920473868], [109.96506402665503, 15.526031073258686], [109.98526818797363, 15.335615618596712]],
  [[110.48331454715199, 12.431407837351566], [110.48240767589328, 12.085792287259398], [110.45136562643113, 11.863835000833953], [110.25652028695671, 11.393616070326182]],
  [[108.3388949586325, 7.26656318024262], [108.30727608084116, 6.727803403200289], [108.35631901989032, 6.112648053307836]],
  [[111.94112275674237, 3.553559321848772], [112.40151782268552, 3.646409974664658], [112.92104341055976, 3.845112027649191]],
  [[115.69079809651517, 7.29016984601141], [116.4095482213759, 8.137962397303875]],
  [[118.63503455703679, 11.080904139262175], [118.85587024190139, 11.457907321145406], [119.10128629647166, 12.062751715859875], [119.12181771101825, 12.135585760471585]],
  [[119.60808384544805, 18.143451232827125], [119.91075760817219, 18.77194701315816], [120.11918953031866, 19.117669954512905]],
  [[121.40591812413318, 20.8001943859176], [122.12216430894797, 21.716094829922323]],
  [[122.80328441666389, 23.665545127578547], [123.00481138309124, 24.74934291726869]],
  [[119.16836075308866, 15.107448879733406], [119.16981236678279, 15.755038547478351], [119.17823197590195, 16.265658015720753]]
]
const CLAIM_LINES = [{ id: 'nanhai-ten-dash', cls: 'claim', wv: ['CN'], name_en: 'Nanhai ten-dash line', name_local: '南海十段线', coords: NANHAI }]

// 争议面图层在各档的官方文件名。110m 无此图层 —— NE 就没做，不是漏下；该档的视角差异只到基础单元级
// （台湾/港澳/科索沃/北塞浦路斯/索马里兰/西撒 SADR 这些本就是独立 map_unit，照常随视角走），
// 阿克赛钦/藏南/克里米亚这类「宿主里的一块」在 110m 表达不出来。
const DISPUTED_LAYER = { '10m': 'admin_0_disputed_areas', '50m': 'admin_0_breakaway_disputed_areas', '110m': null }

// ★ 冻结常量的键（台湾/港澳）——运行时权威在 src/viz/geo/frozen.js，这里留一份只为「视角文件里不许出现它们」。
// 两处不一致会被 packages/core/test/povInvariants.test.mjs 当场抓出来。
const FROZEN_KEYS = ['CN-TW', 'CN-HK', 'CN-MO']

const A3 = (v) => (typeof v === 'string' && /^[A-Za-z0-9]{3}$/.test(v) ? v.toUpperCase() : null)
// NE 用 B00…B99 / C01…C04 这段码位专表「无公认主权方」，其余三字码都是国家/属地码。
// 归属值落进这段 → 'disputed'；空 / -99 → null（表示该视角没有对这块地表态，回落到 own0）。
const owner = (v) => { const a = A3(v); return !a ? null : /^[BC]\d\d$/.test(a) ? 'disputed' : a }
const clean = (v) => (typeof v === 'string' && v && v !== '-99' ? v : null)
const fc = (list) => ({ type: 'FeatureCollection', features: list.map((x) => ({ type: 'Feature', properties: {}, geometry: x.f.geometry })) })

async function buildScale(scale) {
  console.log('\n=== ' + scale + ' ===')
  const MU = await neLayer(scale, 'admin_0_map_units')
  const DA = DISPUTED_LAYER[scale] ? await neLayer(scale, DISPUTED_LAYER[scale]) : { type: 'FeatureCollection', features: [] }
  const BL = await neLayer(scale, 'admin_0_boundary_lines_land')
  console.log('  源要素：map_units ' + MU.features.length + ' · disputed ' + DA.features.length + ' · lines ' + BL.features.length)

  // ---- 单元候选 ----
  const seen = new Set()
  const base = []
  for (const f of MU.features) {
    const p = f.properties
    const su = A3(p.SU_A3) || A3(p.ADM0_A3) || A3(p.ISO_A3)
    if (!su) { console.log('  ! map_unit 无可用 id：', p.NAME); continue }
    let u = ID_BASE[su] || su
    if (seen.has(u)) { console.log('  ! 基础单元 id 重复：', u, p.NAME); u = u + '~' + seen.size }
    seen.add(u)
    base.push({ u, f, dispute: false, props: p })
  }
  const disp = []
  for (const f of DA.features) {
    const p = f.properties
    const brk = A3(p.BRK_A3)
    if (!brk) { console.log('  ! disputed 无 BRK_A3：', p.BRK_NAME); continue }
    disp.push({ u: ID_DISP[brk] || ('NE-' + brk), f, dispute: true, props: p })
  }

  // ---- 第一遍拓扑：只为「争议面是否与某基础单元完全重复」做判定 ----
  // 判据：基础单元的全部 arc 都被该争议面复用 → 两者是同一块地（如 map_units 的台湾 vs disputed 的台湾），
  // 此时丢掉叠加层、由基础分区自己当这个争议单元用，免得同一块地出现两份。
  const t1 = topology({ b: fc(base), d: fc(disp) })
  const arcsB = base.map((_, i) => arcsOfGeom(t1.objects.b.geometries[i]))
  const arcsD = disp.map((_, i) => arcsOfGeom(t1.objects.d.geometries[i]))
  // 另一路判据（跨比例尺更稳）：面积与包围盒都对得上 —— 50m 档的西亚琴冰川就是这一路抓到的，
  // 它在 map_units 与 disputed 两层各有一份、arc 却因简化程度不同不完全共享。
  const bboxArea = (g) => {
    let x0 = 180, x1 = -180, y0 = 90, y1 = -90, a = 0
    for (const rings of polysOf(g)) { a += ringArea(rings[0]); for (const p of rings[0]) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1] } }
    return { x0, x1, y0, y1, a }
  }
  const bbB = base.map((b) => bboxArea(b.f.geometry)), bbD = disp.map((d) => bboxArea(d.f.geometry))
  const dupOf = new Map()
  for (let i = 0; i < disp.length; i++) {
    for (let k = 0; k < base.length; k++) {
      const B = arcsB[k]
      let sub = B.size > 0
      for (const a of B) if (!arcsD[i].has(a)) { sub = false; break }
      if (!sub) {
        const p = bbD[i], q = bbB[k]
        sub = q.a > 0 && Math.abs(p.a - q.a) / q.a < 0.05 &&
          Math.abs(p.x0 - q.x0) < 0.2 && Math.abs(p.x1 - q.x1) < 0.2 && Math.abs(p.y0 - q.y0) < 0.2 && Math.abs(p.y1 - q.y1) < 0.2
      }
      if (sub) { dupOf.set(i, base[k].u); break }
    }
  }
  const kept = disp.filter((d, i) => !dupOf.has(i) && OVERRIDE[d.u] !== 'drop')
  console.log('  争议面 ' + disp.length + ' 条：与基础单元重复 ' + dupOf.size + ' 条（并入基础分区）· 保留叠加 ' + kept.length + ' 条')

  // ---- 宿主：争议面内点落在哪个基础单元里 ----
  for (const d of kept) {
    const ov = OVERRIDE[d.u]
    if (ov && ov.host) { d.host = ov.host; continue }
    const hx = Number(d.props.LABEL_X), hy = Number(d.props.LABEL_Y)
    const pt = interiorPoint(d.f.geometry, hx, hy)
    d.host = null
    if (!pt) continue
    let bestA = Infinity
    for (const b of base) for (const rings of polysOf(b.f.geometry)) {
      if (!inRings(rings, pt[0], pt[1])) continue
      const a = ringArea(rings[0])
      if (a < bestA) { bestA = a; d.host = b.u }   // 嵌套时取最小的那个（更具体）
    }
  }
  const noHost = kept.filter((d) => !d.host)
  if (noHost.length) console.log('  无宿主（视为独立陆地/海上单元）：' + noHost.map((d) => d.u).join(' '))

  // ---- 自带线 + 最终拓扑（面与线共享同一个 arcs 池） ----
  const cand = []
  for (const f of BL.features) {
    const cls = LINE_CLS[f.properties.FEATURECLA]
    if (!cls) continue
    const cs = linesOf(f.geometry)
    if (cs.length) cand.push({ cls, coords: cs, name_en: clean(f.properties.NAME) })
  }
  const units = base.concat(kept)
  const srcLines = cand.concat(CLAIM_LINES)
  const topo = topology({
    units: fc(units),
    lines: { type: 'FeatureCollection', features: srcLines.map((l) => ({ type: 'Feature', properties: {}, geometry: l.coords.length === 1 ? { type: 'LineString', coordinates: l.coords[0] } : { type: 'MultiLineString', coordinates: l.coords } })) }
  }, QUANT)

  // ★ 第一路去重（精确、无阈值）：自带线与面共用同一个 arcs 池，凡是【同一条 arc】的段落就是同一段几何 ——
  //   丢掉自带线那一份，改成给这条派生 arc 打一个分类标记 lineCls。这样既不双线毛边，又保住了
  //   派生规则表达不出来的分类（停火线 loc / 未定界 indefinite）——单靠「整条丢弃」会把这个分类丢掉。
  const uArcs = new Set()
  for (const g of topo.objects.units.geometries) arcsOfGeom(g, uArcs)
  const RANK = { indefinite: 1, loc: 2 }
  const lineCls = {}
  const runsOf = (g, keep) => {   // 把线几何按 keep(arc) 切成若干「连续保留段」，返回 arc 序列数组
    const out = []
    const lists = g.type === 'MultiLineString' ? g.arcs : [g.arcs]
    for (const list of lists) {
      let cur = []
      for (const a of list) { if (keep(a < 0 ? ~a : a)) cur.push(a); else { if (cur.length) out.push(cur); cur = [] } }
      if (cur.length) out.push(cur)
    }
    return out
  }
  let sharedN = 0
  topo.objects.lines.geometries.forEach((g, i) => {
    if (i >= cand.length) return                    // 主张线不参与去重（在海上，与任何派生 arc 都不共线）
    const cls = cand[i].cls
    for (const a of arcsOfGeom(g)) {
      if (!uArcs.has(a)) continue
      sharedN++
      if ((RANK[cls] || 0) > (RANK[lineCls[a]] || 0)) lineCls[a] = cls
    }
  })

  // ★ 第二路去重（ε 缓冲，兜住「几乎重合但坐标对不上」的）：自带线剩下的独有 arc 上，
  //   若 ≥COVER_FRAC 的点落在任一条派生 arc 的 ε 邻域内，整条丢弃。ε 按精度档取。
  const eps = EPS[scale]
  const grid = new Map()
  const put = (x, y) => { const k = Math.floor(x / eps) + ',' + Math.floor(y / eps); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(x, y) }
  for (const a of uArcs) {
    const pts = decodeArc(topo, topo.arcs[a])
    for (let i = 0; i < pts.length; i++) {
      put(pts[i][0], pts[i][1])
      if (i + 1 < pts.length) {
        const p = pts[i], q = pts[i + 1]
        const n = Math.min(4096, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (eps / 2)))
        for (let k = 1; k < n; k++) put(p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n)
      }
    }
  }
  const near = (x, y) => {
    const cx = Math.floor(x / eps), cy = Math.floor(y / eps)
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const a = grid.get((cx + i) + ',' + (cy + j))
      if (!a) continue
      for (let k = 0; k < a.length; k += 2) if (Math.hypot(a[k] - x, a[k + 1] - y) <= eps) return true
    }
    return false
  }
  let dropWhole = 0, keepSeg = 0
  const outLines = []
  topo.objects.lines.geometries.forEach((g, i) => {
    const src = srcLines[i]
    if (i >= cand.length) { outLines.push({ g, src }); return }   // 主张线原样保留
    const runs = runsOf(g, (a) => !uArcs.has(a))
    if (!runs.length) { dropWhole++; return }
    // 逐段过 ε 缓冲
    const left = []
    for (const run of runs) {
      let tot = 0, cov = 0
      for (const a of run) for (const p of decodeArc(topo, topo.arcs[a < 0 ? ~a : a])) { tot++; if (near(p[0], p[1])) cov++ }
      if (tot && cov / tot >= COVER_FRAC) continue
      left.push(run)
    }
    if (!left.length) { dropWhole++; return }
    keepSeg += left.length
    outLines.push({ g: left.length === 1 ? { type: 'LineString', arcs: left[0] } : { type: 'MultiLineString', arcs: left }, src })
  })
  topo.objects.lines.geometries = outLines.map((x) => x.g)
  console.log('  自带线去重：候选 ' + cand.length + ' 条 → 与派生 arc 精确共享 ' + sharedN + ' 段（转成 lineCls 分类标注，不再画第二遍）· 整条丢弃 ' + dropWhole + ' 条 · 保留自带几何 ' + keepSeg + ' 段（另加主张线 ' + CLAIM_LINES.length + ' 条）')

  // ---- 属性回填 ----
  // ★ 不再产出 iso3n3（ISO3 → ISO 数字码）：那张表是从 map_unit 的 ISO_N3 列「先到先得」猜出来的，
  //   法国被拆成本土+五个海外省时取到的是子单元的码（10m 取到 254 圭亚那 / 50m 取到 249 法国本土），
  //   正确的 250 一次都没取到；AUS/CSI/ATC 与 ATA/ATG 还会撞到同一个码，地图上就出现两个「澳大利亚」。
  //   运行时的国名 / 数字码 / 标注锚点一律走 src/viz/geo/countryZh.js 那张按 ISO3 索引的静态表。
  const iso3name = {}
  topo.objects.units.geometries.forEach((g, i) => {
    const it = units[i], p = it.props
    const n3raw = clean(String(p.ISO_N3_EH == null ? '' : p.ISO_N3_EH)) || clean(String(p.ISO_N3 == null ? '' : p.ISO_N3))
    const n3 = n3raw && n3raw !== '-99' ? n3raw : null
    const own0 = owner(p.ADM0_A3) || owner(p.SOV_A3) || null
    g.properties = {
      u: it.u,
      iso: A3(p.ADM0_A3) || A3(p.ISO_A3) || null,
      n3,
      name_en: clean(p.NAME) || clean(p.NAME_EN) || it.u,   // NE 的 NAME 是短显示名（China），NAME_EN 是全称（People's Republic of China）——标注要短名
      name_local: null,
      own0: own0 || 'disputed'
    }
    if (it.dispute) g.properties.dispute = true
    if (it.host) g.properties.host = it.host
    if (!it.dispute && own0 && own0 !== 'disputed') {
      // owner（ISO3）→ 英文国名：10m 档把英法等再拆成 map subunit，此时没有 u==='GBR' 的单元，
      // 标注要的是 admin-0 名（NE 的 ADMIN 列 = 'United Kingdom'），不是子单元名（'Scotland'）。
      if (!iso3name[own0]) iso3name[own0] = clean(p.ADMIN) || clean(p.NAME) || own0
    }
  })
  topo.objects.lines.geometries.forEach((g, i) => {
    const l = outLines[i].src
    g.properties = { cls: l.cls }
    if (l.id) g.properties.id = l.id
    if (l.wv) g.properties.wv = l.wv
    if (l.name_en) g.properties.name_en = l.name_en
    if (l.name_local) g.properties.name_local = l.name_local
  })

  // ---- adj：每条 arc 两侧的单元 ----
  const useB = new Map(), useD = new Map()
  topo.objects.units.geometries.forEach((g, i) => {
    const it = units[i], m = it.dispute ? useD : useB
    for (const a of arcsOfGeom(g)) { let s = m.get(a); if (!s) m.set(a, s = new Set()); s.add(it.u) }
  })
  const hostOf = {}
  for (const d of kept) hostOf[d.u] = d.host || null
  const adj = {}
  const bad = []
  for (const a of new Set([...useB.keys(), ...useD.keys()])) {
    const b = [...(useB.get(a) || [])], d = [...(useD.get(a) || [])]
    if (b.length > 2 || d.length > 2) bad.push({ a, b, d })
    let pair
    if (d.length >= 2) pair = [d[0], d[1]]
    else if (d.length === 1) {
      const D = d[0], h = hostOf[D]
      const other = b.filter((x) => x !== h)
      pair = other.length ? [D, other[0]] : [D, b.length ? null : (h || null)]
    } else pair = [b[0], b.length > 1 ? b[1] : null]
    adj[a] = pair
  }
  if (bad.length) { console.log('  ✗ 拓扑校验失败：以下 arc 超过两个 owner'); for (const x of bad.slice(0, 40)) console.log('    arc', x.a, 'base=[' + x.b + '] disp=[' + x.d + ']') }

  // ---- 基础单元重叠校验 ----
  let overlap = 0
  const pts = base.map((b) => interiorPoint(b.f.geometry, NaN, NaN))
  for (let i = 0; i < base.length; i++) {
    const pt = pts[i]
    if (!pt) continue
    for (let k = 0; k < base.length; k++) {
      if (k === i) continue
      let hit = false
      for (const rings of polysOf(base[k].f.geometry)) if (inRings(rings, pt[0], pt[1])) { hit = true; break }
      if (hit) { overlap++; console.log('  ! 基础单元重叠：' + base[i].u + ' 内点落在 ' + base[k].u); break }
    }
  }
  console.log('  校验：arc 超两侧 ' + bad.length + ' 处 · 基础单元重叠 ' + overlap + ' 处 · 无宿主争议面 ' + noHost.length + ' 条')
  if (bad.length || overlap) { console.error('拓扑校验未通过'); process.exitCode = 1 }

  // ---- arc 压实：丢掉的自带线会留下一批没人引用的 arc，重排索引把它们清出去 ----
  const used = new Set()
  for (const obj of Object.values(topo.objects)) for (const g of obj.geometries) arcsOfGeom(g, used)
  const orphan = topo.arcs.length - used.size
  const map = new Int32Array(topo.arcs.length).fill(-1)
  const arcs2 = []
  for (let i = 0; i < topo.arcs.length; i++) if (used.has(i)) { map[i] = arcs2.length; arcs2.push(topo.arcs[i]) }
  const remap = (g) => {
    if (!g || !g.arcs) return
    const walk = (a) => { if (!a.length) return a; if (Array.isArray(a[0])) return a.map(walk); return a.map((i) => (i < 0 ? ~map[~i] : map[i])) }
    g.arcs = walk(g.arcs)
  }
  for (const obj of Object.values(topo.objects)) for (const g of obj.geometries) remap(g)
  const adj2 = {}, lineCls2 = {}
  for (const k in adj) if (map[+k] >= 0) adj2[map[+k]] = adj[k]
  for (const k in lineCls) if (map[+k] >= 0) lineCls2[map[+k]] = lineCls[k]
  topo.arcs = arcs2

  topo.adj = adj2
  topo.lineCls = lineCls2
  topo.meta = {
    scale,
    source: 'Natural Earth 5.x (public domain) — admin_0_map_units / admin_0_disputed_areas / admin_0_boundary_lines_land',
    model: '基础分区(units 里 dispute!=true) + 争议叠加(dispute==true，落在 host 内)；面按数组顺序覆盖，线按 adj 派生',
    lineCls_note: 'arc 序号 → 自带线给出的分类（loc/indefinite）。派生规则算出 admin0/indefinite 时由它顶替 —— 停火线/未定界是「两侧 owner 不同」这条规则表达不出来的',
    iso3name,
    claim_note_zh: '南海十段线为近似示意坐标，仅供工程显示。正式对外发布须替换为国家测绘地理信息主管部门批准的审图号底图（如天地图 / GS(xxxx)xxxx 号）坐标；替换入口在 scripts/build-basemap.mjs 的 CLAIM_LINES。'
  }
  fs.mkdirSync(OUTDIR, { recursive: true })
  const out = path.join(OUTDIR, 'basemap-' + scale + '.json')
  fs.writeFileSync(out, JSON.stringify(topo))
  console.log('  写出 ' + path.relative(ROOT, out) + '：arcs ' + topo.arcs.length + '（清掉无人引用的 ' + orphan + ' 条）· units ' + units.length + ' · lines ' + outLines.length + ' · lineCls 标注 ' + Object.keys(lineCls2).length + ' 段 · ' + (fs.statSync(out).size / 1e6).toFixed(2) + ' MB')
  return { units }
}

// ---------- 视角文件（从 NE 自带的 32 套官方归属列里取六套） ----------
// units：三档合并后的单元清单（同 id 取首次出现的属性）——各档 SU_A3 会有出入
// （10m 把叙利亚/挪威/荷兰/比利时等再拆成 map subunit，50m/110m 不拆），合并后视角表对三档都齐。
function writePovs(units) {
  fs.mkdirSync(POVDIR, { recursive: true })
  for (const pov of POVS) {
    const own = {}
    for (const it of units) {
      if (FROZEN_KEYS.includes(it.u)) continue   // ★ 台湾/港澳不进任何视角表：主权归属由 frozen.js 恒定
      const b = owner(it.props.ADM0_A3) || 'disputed'
      const v = owner(it.props[pov.attr])
      if (v && v !== b) own[it.u] = v
    }
    const j = {
      id: pov.id, name_zh: pov.zh, name_en: pov.en,
      own,
      lines: { claim: pov.id === 'CN' ? ['nanhai-ten-dash'] : [] },
      names: {},
      labels: { hide: pov.id === 'CN' ? ['CN-TW'] : [] }
    }
    const f = path.join(POVDIR, pov.id + '.json')
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n')
    console.log('  视角 ' + pov.id + '：own 差异 ' + Object.keys(own).length + ' 条 → ' + path.relative(ROOT, f))
  }
  // ISO 数字码 → ISO3（老存档「逐国大地颜色」的键从 world-atlas 的数字码迁到 ISO3 时要查）
  // 不再在构建期生成：它由 src/viz/geo/countryZh.js 那张静态表反建（ISO_NUM_TO_A3），
  // 从 NE 猜数字码正是法国丢名、澳大利亚重名的病根，见该文件头。
}

const want = process.argv.slice(2).filter((a) => /^(110m|50m|10m)$/.test(a))
const scales = want.length ? want : ['110m', '50m', '10m']
const merged = new Map()
for (const s of scales) {
  const r = await buildScale(s)
  for (const it of r.units) if (!merged.has(it.u)) merged.set(it.u, it)
}
console.log('\n=== 视角文件（三档单元清单合并后生成，共 ' + merged.size + ' 个单元） ===')
writePovs([...merged.values()])
