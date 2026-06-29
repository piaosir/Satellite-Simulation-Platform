// 从阿里 DataV GeoAtlas 生成中国「地级市界」+ 地级市名标注 -> src/viz/globe3d/data/china-cities.json
//
// 数据源：DataV GeoAtlas（https://geo.datav.aliyun.com，基于民政部行政区划，与 china-provinces.json 同源同口径）。
// 逐省拉取 {省级adcode}_full.json（含该省全部地级行政区的边界 MultiPolygon + center 标注点）。
//
// 与 build-provinces.js 同思路，但输出「完整地级边界网」：
//   · 凡被两个地级单元共享的边(>=2) 都输出 —— 含省内市界，也含省界那条。
//   · 只属于一个单元的外缘边 = 海岸/国境（丢弃，由底图国境线兜底）。
// 这样市界层单独显示也完整自洽（不依赖省界层），挨省界的城市不缺边；与省界层叠加时省界画在其上更醒目。
// 每省用其全部要素（含省直辖县级）参与算边 → 分区网铺满不留空洞。
// 注意：各省分文件拉取，跨省省界在两边坐标不一致 → 共享边逻辑抓不到，故另把 china-provinces.json 的省界并入。
//
// 只显示「地级市」：地名仅标地级行政区（mod100===0：市/自治州/盟/地区），位置取 centroid 使其居中。
// 所有省直辖县级（adcode%100≠0：新疆兵团师市 / 海南直管县市 / 湖北仙桃潜江天门神农架）都不是地级，
// 一律「并入相邻地级市」——不标注、其领地溶进周边地级市，地图上不留空白格、也不出现非地级名。
// 归并用「从地级市向内泛洪」：被删县级若被其他被删县级包住（如海南岛内部），逐层把地级市归属传播进去。
// REMOVE 额外列出要并掉的「地级市」（本是地级但按需删除）：鹤壁（与安阳几乎垂直重叠）。以后加 adcode 重跑即可。
//
// 4 直辖市（无内部地级市）、港澳台不参与。用法：node scripts/build-cities.js（需联网）。
const fs = require('fs'), path = require('path')
const topojson = require('topojson-client')

const OUT = path.join(__dirname, '..', 'src', 'viz', 'globe3d', 'data', 'china-cities.json')
// 底图（Natural Earth）中国陆地多边形：用来把市界裁剪到底图国境以内，
// 避免 DataV（含藏南等声索界）的地级界伸出底图国境线之外（如山南↔林芝在藏南露线）。
const NE_TOPO = path.join(__dirname, '..', 'src', 'viz', 'globe3d', 'data', 'countries-10m.json')
function loadChinaRings() {
  const topo = JSON.parse(fs.readFileSync(NE_TOPO, 'utf8'))
  const fc = topojson.feature(topo, topo.objects.countries)
  const cn = fc.features.find((f) => /China|中国/i.test((f.properties && (f.properties.name || f.properties.NAME || f.properties.admin)) || ''))
  if (!cn) return null
  const polys = cn.geometry.type === 'Polygon' ? [cn.geometry.coordinates] : cn.geometry.coordinates
  const rings = []
  for (const poly of polys) for (const ring of poly) {
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity
    for (const p of ring) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1] }
    rings.push({ ring, minx, maxx, miny, maxy })
  }
  return rings
}
// 偶次穿越法（向 +x 发射射线，含洞自然处理）：点在中国陆地内？bbox 先快速排除
function insideChina(rings, x, y) {
  let c = false
  for (const R of rings) {
    if (y < R.miny || y > R.maxy || x > R.maxx) continue
    const r = R.ring
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const yi = r[i][1], yj = r[j][1]
      if ((yi > y) !== (yj > y) && x < (r[j][0] - r[i][0]) * (y - yi) / (yj - yi) + r[i][0]) c = !c
    }
  }
  return c
}
const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound/'

// 要拉取的省级 adcode（排除 4 直辖市 110000/120000/310000/500000 与港澳台 710000/810000/820000）
const PROVINCES = [
  130000, 140000, 150000, 210000, 220000, 230000, 320000, 330000, 340000, 350000,
  360000, 370000, 410000, 420000, 430000, 440000, 450000, 460000, 510000, 520000,
  530000, 540000, 610000, 620000, 630000, 640000, 650000
]

// 额外并掉的「地级市」（本是地级，按需删除）。省直辖县级(mod100≠0)由 isRemoved 统一并掉，无需在此列。
//   410600 鹤壁市（与安阳几乎垂直重叠，按用户要求删除）
const REMOVE = new Set([410600])
// 是否「并入相邻、不标注」：所有省直辖县级(mod100≠0) + REMOVE 中点名的地级市
const isRemoved = (ad) => REMOVE.has(ad) || ad % 100 !== 0

// 自治州命名里出现即截断的民族关键字（取其前缀作为简称）
const ETHNIC = ['维吾尔', '哈萨克', '柯尔克孜', '蒙古族', '蒙古', '藏族', '回族', '彝族', '苗族', '侗族',
  '白族', '傣族', '景颇族', '傈僳族', '壮族', '布依族', '土家族', '朝鲜族', '羌族', '纳西族',
  '拉祜族', '佤族', '哈尼族', '黎族', '满族']

function shortName(n) {
  if (n === '海南藏族自治州') return '海南州'   // 与海南省区分
  if (n.endsWith('盟')) return n                 // 兴安盟/锡林郭勒盟/阿拉善盟保留
  if (n.endsWith('林区')) return n.replace(/林区$/, '')   // 神农架林区→神农架
  if (n.includes('自治州')) {
    let cut = n.length
    for (const e of ETHNIC) { const i = n.indexOf(e); if (i >= 0 && i < cut) cut = i }
    return n.slice(0, cut)
  }
  return n.replace(/地区$/, '').replace(/市$/, '')
}

const round = (p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]
const ek = (a, b) => {
  const ka = a[0].toFixed(5) + ',' + a[1].toFixed(5), kb = b[0].toFixed(5) + ',' + b[1].toFixed(5)
  return ka < kb ? ka + '|' + kb : kb + '|' + ka
}
const polysOf = (g) => g.type === 'Polygon' ? [g.coordinates] : g.coordinates

async function fetchProvince(ad) {
  const url = BASE + ad + '_full.json'
  const r = await fetch(url)
  if (!r.ok) throw new Error(ad + ' HTTP ' + r.status)
  return r.json()
}

// 边长（度，近似按纬度余弦修正）：用于给被删单元找「共享边界最长」的父级邻区
const segLen = (a, b) => { const cl = Math.cos((a[1] + b[1]) / 2 * Math.PI / 180); return Math.hypot((a[0] - b[0]) * cl, a[1] - b[1]) }

async function main() {
  // 收集全部地级单元要素（REMOVE 的也收集，参与算边以便「并入相邻」时正确溶解/扩张边界，但不标注）
  const feats = []
  for (const ad of PROVINCES) {
    const j = await fetchProvince(ad)
    for (const f of j.features) {
      const p = f.properties
      if (!p || !f.geometry || p.adcode == null) continue
      feats.push({ adcode: p.adcode, name: p.name, center: p.center, centroid: p.centroid, geom: f.geometry })
    }
    process.stdout.write('.')
  }
  process.stdout.write('\n')

  // 第一遍：edgeOwners[边]=含该边的 adcode 列表；nbrLen=相邻单元共享边界长度（用于归并打分）
  const edgeOwners = new Map(), coord = new Map(), nameOf = new Map()
  for (const f of feats) {
    nameOf.set(f.adcode, f.name)
    for (const rings of polysOf(f.geom)) for (const ring of rings)
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = ring[i], b = ring[i + 1], k = ek(a, b)
        let arr = edgeOwners.get(k); if (!arr) { arr = []; edgeOwners.set(k, arr); coord.set(k, [a, b]) }
        arr.push(f.adcode)
      }
  }
  const nbrLen = new Map()
  const addNbr = (x, y, L) => { let m = nbrLen.get(x); if (!m) { m = new Map(); nbrLen.set(x, m) } m.set(y, (m.get(y) || 0) + L) }
  for (const [k, owners] of edgeOwners) {
    if (owners.length < 2) continue
    const [a, b] = coord.get(k), L = segLen(a, b)
    for (let i = 0; i < owners.length; i++) for (let j = i + 1; j < owners.length; j++) {
      if (owners[i] === owners[j]) continue
      addNbr(owners[i], owners[j], L); addNbr(owners[j], owners[i], L)
    }
  }
  // 归并：从地级市(保留)向内泛洪。被删单元按「与各已定组的共享边界总长」选最长者并入；
  // 逐轮传播，使被其他被删单元包住的县级（如海南岛内部）也能最终并入某个地级市。
  const finalGroup = new Map()
  for (const f of feats) if (!isRemoved(f.adcode)) finalGroup.set(f.adcode, f.adcode)
  let changed = true
  while (changed) {
    changed = false
    for (const f of feats) {
      if (finalGroup.has(f.adcode)) continue
      const nb = nbrLen.get(f.adcode); if (!nb) continue
      const tally = new Map()
      for (const [n, L] of nb) { const g = finalGroup.get(n); if (g == null) continue; tally.set(g, (tally.get(g) || 0) + L) }
      let best = null, bl = -1
      for (const [g, l] of tally) if (l > bl) { bl = l; best = g }
      if (best != null) { finalGroup.set(f.adcode, best); changed = true }
    }
  }
  for (const f of feats) if (isRemoved(f.adcode)) console.log('  并入:', f.name, '→', nameOf.get(finalGroup.get(f.adcode)) || '(未定，保留)')
  const groupOf = (ad) => finalGroup.get(ad) || ad

  // 第二遍：按「归属组」算边——一条边仅当两侧属于不同组时才画。
  // 被删单元与其归属地级市之间的边溶解（不画），与其他组之间的边成为该地级市扩张后的边界（画）。
  const emit = new Set()
  for (const [k, owners] of edgeOwners) {
    const groups = new Set(owners.map(groupOf))
    if (groups.size >= 2) emit.add(k)   // 跨两个不同组 → 行政边界；单组(内部/海岸)不画
  }
  // 裁剪到底图中国陆地以内：丢弃中点落在底图国境外的市界段（藏南/阿克赛钦等 DataV 与底图不一致处的露线）
  const chinaRings = loadChinaRings()
  const borders = []
  let clipped = 0
  for (const k of emit) {
    const [a, b] = coord.get(k)
    if (chinaRings && !insideChina(chinaRings, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) { clipped++; continue }
    borders.push([round(a), round(b)])
  }
  console.log('裁剪掉国境外市界段:', clipped)
  // 各省是分文件拉取的，跨省的省界边在两边坐标不一致 → 不会被上面的共享边逻辑捕获。
  // 故并入权威省界（china-provinces.json，来自 100000_full 省级面），使市界层自成完整行政网、可脱离省界层单独显示。
  const PROV_JSON = path.join(__dirname, '..', 'src', 'viz', 'globe3d', 'data', 'china-provinces.json')
  let provBorderN = 0
  try { const pj = JSON.parse(fs.readFileSync(PROV_JSON, 'utf8')); for (const seg of (pj.borders || [])) { borders.push(seg); provBorderN++ } }
  catch (e) { console.warn('未能并入省界（china-provinces.json 缺失？）：', e.message) }

  // 地名：仅保留的地级行政区（isRemoved 排除省直辖县级与点名删除项）。位置用 centroid（几何中心，居中）→ 回退 center
  const labels = []
  for (const f of feats) {
    if (isRemoved(f.adcode)) continue
    const c = f.centroid || f.center
    if (c) labels.push({ name: shortName(f.name), lon: c[0], lat: c[1] })
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ borders, labels }))
  console.log('地级单元:', feats.length, ' 地名标注:', labels.length, ' 边段:', borders.length, '(含并入省界', provBorderN, ') bytes:', fs.statSync(OUT).size)
}
main().catch((e) => { console.error(e); process.exit(1) })
