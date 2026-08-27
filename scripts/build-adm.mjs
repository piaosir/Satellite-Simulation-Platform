// 全球行政边界构建：一级(ADM1) / 二级(ADM2) → resources/adm/{ISO3}-adm{1,2}.json
//   另出两份小文件到 src/viz/globe3d/data/adm/：index.json（有哪些国家的包）与 ATTRIBUTION.json（逐国署名）。
//   逐国包放 resources 是因为它有两百多个：进渲染端打包会让 rollup 生成两百多个 chunk，实测默认堆 OOM；
//   改由主进程按需读盘（electron/services/admBoundaries.js）经 IPC 送给渲染端。
//   本脚本取代原 build-provinces.js / build-cities.js（中国省界/地级市界，阿里 DataV 源）。
//
// 数据源
//   ADM1  Natural Earth 10m admin_1_states_provinces（公有领域，251 个国家/地区、4596 个单元）
//   ADM2  geoBoundaries gbOpen 逐国（CC BY 4.0 / ODbL / PDDL，逐国许可，见 ATTRIBUTION.json）
//   ★ 中国两级都例外，改走阿里 DataV GeoAtlas（民政部行政区划），见 lib/chinaDatav.mjs 的文件头：
//     NE 的 CHN admin_1 只有 32 个（台港澳被 NE 当独立 admin_0），geoBoundaries 的 CHN ADM2 是
//     【县级】2391 个且全是拼音 —— 两者都不是本平台要的东西（要的是 34 省 + 333 地级市，带中文）。
//
// 算法与 build-provinces.js 一脉相承：只保留【被两个单元共享的边】（出现 ≥2 次），
// 丢掉只属一个单元的外缘边（= 国境/海岸，由底图兜底）。区别是不再用 toFixed(5) 拼串比对坐标 ——
// 坐标先按 3 位小数量化，边键直接用量化后的整数对，快且不产生浮点毛刺。
//
// ★ 名称两档：「中文 / 英文」。
//   · 中文取 NE 的 name_zh（4589/4596 个单元有，全部含汉字）；没有才回落 name_local（本地文字，只有 430 个有）。
//   · 英文取 NE 的 name_en，没有才回落 name。
//     ★ 别拿 name 当英文：那是「本地拼写的拉丁转写」——德国的萨克森是 Sachsen 不是 Saxony、
//       印尼的东加里曼丹是 Kalimantan Timur 不是 East Kalimantan、以色列的南区是 HaDarom 不是 Southern；
//       还有 67 个单元的 name 里带非拉丁附加符（Đắk Nông / Kangwŏn-do / Ōita）。
//       全球 1265 个单元两者不同，而 name_en 平均只长 0.3 个字符 —— 换过去不占版面。
//   · geoBoundaries 的 shapeName 全是英文/拼音 —— 只有英文这一档；
//   · 中国走 DataV，本地名（中文简称）是数据自带的；英文这一档：省级 34 条手写通行译名，
//     地级市按 NE populated_places 的 NAME_ZH 对上就取其 NAME，对不上的回落中文（覆盖率见构建日志）。
//
// ★ wv（适用视角）：某些单元在不同视角下不属于本国（如印度的阿鲁纳恰尔在中国视角下属中国）。
//   构建期拿【运行时那份解算器】逐单元判一遍全部预设视角，只在本国的视角集合不是全集时才标 wv。
//   输出把这类单元的边与标注拆进 groups[]，通用的仍留在 borders/labels —— 老格式的消费方读不到 groups 也能用。
//
// 用法：
//   node scripts/build-adm.mjs                 ADM1 全球 + ADM2 全部有数据的国家（约 180 个，耗时长）
//   node scripts/build-adm.mjs --adm1          只出 ADM1
//   node scripts/build-adm.mjs CHN USA IND     只出这几个国家（ADM1 + ADM2）
// 需联网，原始数据缓存在 scripts/_ne/。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { neLayer, cached } from './lib/neFetch.mjs'
import { unzip } from './lib/shapefile.mjs'
import { polysOf, inRings, ringArea, interiorPoint } from './lib/geomUtil.mjs'
import * as CN from './lib/chinaDatav.mjs'
import * as R from '../src/viz/geo/povResolver.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// 逐国包（两百多个文件）落 resources/adm：随安装包分发、由主进程按需读盘，不进渲染端打包 ——
// 走 import.meta.glob 会让 rollup 生成两百多个 chunk，实测默认堆直接 OOM。
const OUT = path.join(ROOT, 'resources', 'adm')
// 索引与署名表小且要早用（国家选择器、关于窗口），仍留在渲染端能直接 import 的地方
const META_OUT = path.join(ROOT, 'src', 'viz', 'globe3d', 'data', 'adm')
const CACHE = path.join(ROOT, 'scripts', '_ne')
const GB_META = 'https://raw.githubusercontent.com/wmgeolab/geoBoundaries/main/releaseData/geoBoundariesOpen-meta.csv'
const Q = 1000            // 坐标量化：3 位小数（≈110 m），边键与输出都用它
// 抽稀阈值（度，Douglas–Peucker）：0.003° ≈ 330 m。2D 平面图放到头（scale=60）也才 ~150 px/度，
// 即 0.45 px —— 看不出来，体积能省一半以上。
// ★ 抽稀只能在【串成折线之后】做：逐单元先抽稀会让相邻单元的共享边坐标对不上，共享边判定当场失效。
const SIMPLIFY = 0.003
const POVS = R.povList().map((p) => p.id)

// 视角敏感国家 + 争议面包围盒：绝大多数国家在各套视角下疆域完全一样，逐单元判视角纯属白做。
// 先从底图里把「有争议面牵涉到的国家」和「争议面的包围盒」算出来，只有落进盒子里的单元才逐视角判。
const SENSITIVE = new Set(), DBOX = []
{
  const feats = R.resolvedFeatures('10m')
  for (const f of feats) {
    if (!f.over) continue
    let x0 = 180, x1 = -180, y0 = 90, y1 = -90
    for (const rings of polysOf(f.geometry)) for (const q0 of rings[0]) { if (q0[0] < x0) x0 = q0[0]; if (q0[0] > x1) x1 = q0[0]; if (q0[1] < y0) y0 = q0[1]; if (q0[1] > y1) y1 = q0[1] }
    DBOX.push([x0 - 0.5, x1 + 0.5, y0 - 0.5, y1 + 0.5])
  }
  for (const id of POVS) {
    R.setPov(id, {})
    for (const u of ['IN-ARP', 'CN-AKS', 'CN-SHK', 'IN-PK-KAS', 'PK-AZK', 'PK-GB', 'UA-CR', 'UA-DPR', 'UA-LPR', 'MA-EH', 'EH-SADR', 'IL-GOL', 'SD-ABY', 'GE-AB', 'GE-SO', 'MD-TRA', 'AZ-ART', 'RU-KUR', 'KE-ILEMI', 'SS-ILEMI', 'KOS', 'CYN', 'SOL', 'SAH']) {
      const o = R.ownerOf(u); if (o && o !== 'disputed') SENSITIVE.add(o)
      const p0 = R.unitProps(u); if (p0 && p0.own0 && p0.own0 !== 'disputed') SENSITIVE.add(p0.own0)
      if (p0 && p0.host) { const h = R.unitProps(p0.host); if (h && h.own0) SENSITIVE.add(h.own0) }
    }
  }
  R.setPov(R.DEFAULT_POV, {})
}
const inDbox = (x, y) => DBOX.some((b) => x >= b[0] && x <= b[1] && y >= b[2] && y <= b[3])

const q = (v) => Math.round(v * Q)
const unq = (v) => v / Q
const clean = (v) => (typeof v === 'string' && v.trim() && v !== '-99' ? v.trim() : null)
// NE 的 name_local 有「繁體|简体」两段的写法，取简体那段
const localOf = (p) => { const v = clean(p.name_zh) || clean(p.name_local); return v ? (v.includes('|') ? v.split('|').pop().trim() : v) : null }

// ---------- NE 的 admin_1 分级不齐：这几个国家先并到真正的一级 ----------
// NE 的 admin_1_states_provinces 对多数国家给的是省/州/邦，但对少数几个给到了更细的一层：
//   · 英国 232 个地方议会区（正确的一级是四个构成国：英格兰/苏格兰/威尔士/北爱尔兰）
//   · 法国 101 个省 département（正确的一级是 18 个大区 région，含五个海外大区）
//   · 马耳他 68 个地方议会（NE 自带的上一级是三个 region）
// 一个 8.7°×10.4° 的岛上摆 232 个名字，字直接糊成一坨 —— 那不是「密」，是分错了级。
// 并法：按 NE 自带的上一级字段把 feature 归组，组内几何拼成一个 MultiPolygon 单元。
// 归组之后组内的公共边成了「同一单元内部的边」，shareNet 的「两个不同单元共享」判据自然把它溶解掉，
// 不需要另写合并逻辑（与 buildChinaAdm2 把省直辖县级并进地级市是同一条路子）。
const ADM1_GROUP = {
  GBR: { key: (p) => p.gu_a3 || p.geonunit, en: (p) => p.geonunit },
  FRA: { key: (p) => p.region || p.geonunit, en: (p) => p.region || p.geonunit },
  MLT: { key: (p) => p.region || p.geonunit, en: (p) => p.region || p.geonunit }
}
// 并级之后组名取自 NE 的上一级字段，那是本地文字（法国大区是法文、马耳他 region 是马耳他语）。
// 有通行英文名的在这里给，查不到就沿用原名 —— 法国多数大区的英文就是法文原名，不硬译。
const ADM1_GROUP_EN = {
  FRA: {
    'Bretagne': 'Brittany', 'Normandie': 'Normandy', 'Corse': 'Corsica', 'Guyane française': 'French Guiana',
    'Réunion': 'Réunion', 'Centre-Val de Loire': 'Centre-Val de Loire', 'Pays de la Loire': 'Pays de la Loire'
  },
  MLT: { 'Malta Majjistral': 'Northern', 'Malta Xlokk': 'South Eastern', 'Gozo': 'Gozo' }
}
// 合并后的组名（NE 只给英文/法文，中文得自己来）。查不到就回落英文，两档都出英文。
const ADM1_GROUP_ZH = {
  GBR: { ENG: '英格兰', SCT: '苏格兰', WLS: '威尔士', NIR: '北爱尔兰' },
  FRA: {
    'Hauts-de-France': '上法兰西', 'Grand Est': '大东部', 'Normandie': '诺曼底', 'Bretagne': '布列塔尼',
    'Pays de la Loire': '卢瓦尔河地区', 'Centre-Val de Loire': '中央-卢瓦尔河谷', 'Île-de-France': '法兰西岛',
    'Bourgogne-Franche-Comté': '勃艮第-弗朗什-孔泰', 'Auvergne-Rhône-Alpes': '奥弗涅-罗纳-阿尔卑斯',
    'Nouvelle-Aquitaine': '新阿基坦', 'Occitanie': '奥克西塔尼', "Provence-Alpes-Côte-d'Azur": '普罗旺斯-阿尔卑斯-蓝色海岸',
    'Corse': '科西嘉', 'Guyane française': '法属圭亚那', 'Martinique': '马提尼克', 'Guadeloupe': '瓜德罗普',
    'Réunion': '留尼汪', 'Mayotte': '马约特'
  },
  MLT: { 'Malta Majjistral': '马耳他西北', 'Malta Xlokk': '马耳他东南', 'Gozo': '戈佐' }
}
// 单元名覆写：NE 少数几条给的是行政级别的全称而不是地图上该写的通名。
// 键为 ISO3 → NE 的英文 name，值为 [英文, 中文]。
const ADM1_RENAME = {
  NGA: { 'Federal Capital Territory': ['Abuja', '阿布贾'] }   // 地图上写首都名就够了，不写「联邦首都特区」
}
const renameAdm1 = (iso, en, zh) => {
  const t = (ADM1_RENAME[iso] || {})[en]
  return t ? { en: t[0], zh: t[1] } : { en, zh }
}

// feature 列表 → 归组后的「单元 + 名称」两份数组；无归组规则的国家原样返回。
function groupAdm1(iso, feats) {
  const G = ADM1_GROUP[iso]
  if (!G) {
    return {
      units: feats,
      names: feats.map((f) => {
        const n = renameAdm1(iso, clean(f.properties.name_en) || clean(f.properties.name) || '—', localOf(f.properties))
        return labelOf(f, n.en, n.zh, Number(f.properties.longitude), Number(f.properties.latitude), Number(f.properties.labelrank))
      })
    }
  }
  const zh = ADM1_GROUP_ZH[iso] || {}
  const bag = new Map()
  for (const f of feats) {
    const k = G.key(f.properties)
    if (!k) continue
    let g = bag.get(k)
    if (!g) bag.set(k, g = { k, polys: [], best: null, bestA: -1, rk: 99 })
    for (const rings of polysOf(f.geometry)) {
      g.polys.push(rings)
      const a = ringArea(rings[0])
      if (a > g.bestA) { g.bestA = a; g.best = f.properties }      // 组内最大的一块：拿它的标注点当锚点提示
    }
    const r = Number(f.properties.labelrank)
    if (Number.isFinite(r) && r < g.rk) g.rk = r                    // 组的 labelrank 取组内最靠前的那个
  }
  const units = [], names = []
  for (const g of bag.values()) {
    const u = { type: 'Feature', properties: g.best, geometry: { type: 'MultiPolygon', coordinates: g.polys } }
    const raw = G.en(g.best) || g.k
    const n = renameAdm1(iso, ((ADM1_GROUP_EN[iso] || {})[raw] || raw), zh[g.k] || zh[raw] || null)
    units.push(u)
    names.push(labelOf(u, n.en, n.zh, Number(g.best.longitude), Number(g.best.latitude), g.rk))
  }
  console.log('  ' + iso + ' 并级：' + feats.length + ' → ' + units.length + ' 个（NE 的 admin_1 给到了更细的一层）')
  return { units, names }
}

// ---------- geoBoundaries 元数据 ----------
function parseCsvLine(l) {
  const out = []; let c = '', qd = false
  for (let i = 0; i < l.length; i++) {
    const ch = l[i]
    if (qd) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++ } else qd = false } else c += ch }
    else if (ch === '"') qd = true
    else if (ch === ',') { out.push(c); c = '' }
    else c += ch
  }
  out.push(c); return out
}
async function gbMeta() {
  const f = await cached(GB_META, 'gb-meta.csv')
  const rows = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)
  const H = parseCsvLine(rows[0])
  const ix = (n) => H.indexOf(n)
  const out = {}
  for (const line of rows.slice(1)) {
    const r = parseCsvLine(line)
    if (r.length < H.length - 2) continue
    const iso = r[ix('boundaryISO')], lvl = r[ix('boundaryType')]
    if (!/^ADM[12]$/.test(lvl)) continue
    ;(out[iso] || (out[iso] = {}))[lvl.toLowerCase()] = {
      units: Number(r[ix('admUnitCount')]) || 0,
      license: r[ix('boundaryLicense')], source: r[ix('boundarySource')],
      url: r[ix('staticDownloadLink')], year: r[ix('boundaryYearRepresented')]
    }
  }
  return out
}
async function gbFeatures(iso, lvl, url) {
  const zip = await cached(url, `gb-${iso}-${lvl}.zip`)
  const files = unzip(fs.readFileSync(zip))
  const key = Object.keys(files).find((k) => /simplified\.geojson$/i.test(k)) || Object.keys(files).find((k) => /\.geojson$/i.test(k))
  if (!key) throw new Error(iso + ' ' + lvl + ' 包里没有 geojson')
  return JSON.parse(files[key].toString('utf8')).features
}

// ---------- 共享边网 ----------
// 单元列表 → { borders(通用), groups(按 wv 分组) }。wvOf(i) 返回该单元的适用视角数组或 null（=通用）。
function shareNet(units, wvOf) {
  const cnt = new Map(), owner = new Map()
  const key = (a, b) => { const ka = a[0] * 100000 + a[1], kb = b[0] * 100000 + b[1]; return ka < kb ? ka + '|' + kb : kb + '|' + ka }
  const each = (i, cb) => {
    for (const rings of polysOf(units[i].geometry)) for (const ring of rings) {
      let pa = [q(ring[0][0]), q(ring[0][1])]
      for (let k = 1; k < ring.length; k++) {
        const pb = [q(ring[k][0]), q(ring[k][1])]
        if (pa[0] !== pb[0] || pa[1] !== pb[1]) cb(pa, pb)
        pa = pb
      }
    }
  }
  for (let i = 0; i < units.length; i++) each(i, (a, b) => {
    const k = key(a, b)
    cnt.set(k, (cnt.get(k) || 0) + 1)
    const o = owner.get(k)
    if (!o) owner.set(k, [i]); else if (o.length < 2 && o[0] !== i) o.push(i)
  })
  // 共享边按「适用视角」分桶。同一条边两侧单元的 wv 取交集：任一侧在某视角下不属本国，
  // 这条内部界在那个视角就不该画。
  const done = new Set(), buckets = new Map()
  for (let i = 0; i < units.length; i++) each(i, (a, b) => {
    const k = key(a, b)
    const sides = owner.get(k) || [i]
    // ★ 判据是「两个【不同】单元共享」而不是「出现两次」：中国地级市那一路会把省直辖县级并进地级市，
    //   同一个单元里两块相邻子面之间的那条边会出现两次 —— 按次数判就会把它当内部界画出来（该溶解掉）。
    if ((cnt.get(k) || 0) < 2 || sides.length < 2 || done.has(k)) return
    done.add(k)
    let wv = null
    for (const t of sides) { const w = wvOf(t); if (w) wv = wv ? wv.filter((x) => w.includes(x)) : w.slice() }
    const kk = wv ? wv.join(',') : ''
    const bk = buckets.get(kk) || (buckets.set(kk, { wv, segs: [] }), buckets.get(kk))
    bk.segs.push([a, b])
  })
  const out = { borders: [], groups: [] }
  for (const [kk, bk] of buckets) {
    const lines = chain(bk.segs).map((pts) => simplify(pts, SIMPLIFY))
    if (kk === '') out.borders = lines
    else out.groups.push({ wv: bk.wv, borders: lines, labels: [] })
  }
  return out
}

// 线段 → 极长折线：按量化端点建邻接，从「度数≠2」的点起走，走完再收环。
// 串起来既省体积（少一半端点），也让抽稀有得可抽 —— 两点段没有中间点可丢。
function chain(segs) {
  const adj = new Map(), used = new Array(segs.length).fill(false)
  const kp = (p) => p[0] * 100000 + p[1]
  segs.forEach(([a, b], i) => {
    ;(adj.get(kp(a)) || (adj.set(kp(a), []), adj.get(kp(a)))).push(i)
    ;(adj.get(kp(b)) || (adj.set(kp(b), []), adj.get(kp(b)))).push(i)
  })
  const walk = (start) => {
    const pts = [start]
    let cur = start
    for (;;) {
      const list = adj.get(kp(cur)) || []
      const i = list.find((x) => !used[x])
      if (i == null) break
      used[i] = true
      const [a, b] = segs[i]
      const nxt = (kp(a) === kp(cur)) ? b : a
      pts.push(nxt); cur = nxt
    }
    return pts
  }
  const lines = []
  // 先从端点（度数≠2）起走，剩下的都是闭环
  for (const [k, list] of adj) {
    if (list.length === 2) continue
    for (const i of list) {
      if (used[i]) continue
      const [a, b] = segs[i]
      const pts = walk(kp(a) === k ? a : b)
      if (pts.length > 1) lines.push(pts)
    }
  }
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    const pts = walk(segs[i][0])
    if (pts.length > 1) lines.push(pts)
  }
  return lines.map((pts) => pts.map((q0) => [unq(q0[0]), unq(q0[1])]))
}

// Douglas–Peucker（度为单位，不做纬度余弦修正 —— 阈值本就取得远小于一个像素）
function simplify(pts, eps) {
  if (pts.length < 3 || !(eps > 0)) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [i0, i1] = stack.pop()
    if (i1 - i0 < 2) continue
    const [x0, y0] = pts[i0], [x1, y1] = pts[i1]
    const dx = x1 - x0, dy = y1 - y0, dd = dx * dx + dy * dy
    let best = -1, bd = eps
    for (let i = i0 + 1; i < i1; i++) {
      const [x, y] = pts[i]
      let d
      if (dd < 1e-18) d = Math.hypot(x - x0, y - y0)
      else { const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / dd)); d = Math.hypot(x - x0 - t * dx, y - y0 - t * dy) }
      if (d > bd) { bd = d; best = i }
    }
    if (best > 0) { keep[best] = 1; stack.push([i0, best], [best, i1]) }
  }
  const out = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  return out
}

// ---------- 逐国出包 ----------
// rk = NE 的 labelrank（越小越该先标，全球统一尺度：德国的州 3、英国的区 9、马耳他的地方议会 20）。
// 渲染端的地名避让拿它当第一排序键 —— 屏幕上放不下时，先让位的是 NE 制图师本来就认为次要的那些。
function labelOf(f, nameEn, nameLocal, hintLon, hintLat, rk) {
  const pt = interiorPoint(f.geometry, hintLon, hintLat)
  if (!pt) return null
  const o = { name_en: nameEn, name_local: nameLocal || null, lon: Math.round(pt[0] * Q) / Q, lat: Math.round(pt[1] * Q) / Q }
  if (Number.isFinite(rk)) o.rk = rk
  return o
}
// 单元的适用视角：内点在各套预设视角下是否仍归本国。全归 → null（通用）
function wvSetOf(geom, iso, hintLon, hintLat) {
  if (!SENSITIVE.has(iso)) return null              // 该国疆域不随视角变，直接通用
  const pt = interiorPoint(geom, hintLon, hintLat)
  if (!pt) return null
  if (!inDbox(pt[0], pt[1])) return null             // 离所有争议面都远，判也是全六套
  const keep = []
  for (const id of POVS) { R.setPov(id, {}); const o = R.ownerAt(pt[0], pt[1]); if (o && o.owner === iso) keep.push(id) }
  R.setPov(R.DEFAULT_POV, {})
  return keep.length === POVS.length ? null : keep
}

function writePack(iso, lvl, units, names, isoOf) {
  const wvCache = units.map((u, i) => wvSetOf(u.geometry, isoOf(i), names[i] ? names[i].lon : NaN, names[i] ? names[i].lat : NaN))
  const net = shareNet(units, (i) => wvCache[i])
  net.labels = []
  for (let i = 0; i < units.length; i++) {
    const l = names[i]
    if (!l) continue
    const w = wvCache[i]
    if (!w) net.labels.push(l)
    else {
      const kk = w.join(',')
      let g = net.groups.find((x) => x.wv.join(',') === kk)
      if (!g) net.groups.push(g = { wv: w, borders: [], labels: [] })
      g.labels.push(l)
    }
  }
  const out = { borders: net.borders, labels: net.labels }
  if (net.groups.length) out.groups = net.groups
  fs.mkdirSync(OUT, { recursive: true })
  const f = path.join(OUT, iso + '-' + lvl + '.json')
  fs.writeFileSync(f, JSON.stringify(out))
  const wvN = net.groups.reduce((s, g) => s + g.labels.length, 0)
  console.log(`  ${iso} ${lvl}：单元 ${units.length} · 内部界 ${out.borders.length} 条折线` +
    (net.groups.length ? ` (+${net.groups.reduce((s, g) => s + g.borders.length, 0)} 条随视角)` : '') +
    ` · 标注 ${out.labels.length}` + (wvN ? ` (+${wvN} 随视角)` : '') +
    ` · ${(fs.statSync(f).size / 1e6).toFixed(2)} MB`)
  return out
}

// 中国那两级的署名（DataV 是公开服务、数据源为民政部行政区划）
const DATAV_CREDIT = {
  license: 'DataV.GeoAtlas 公共服务（数据源：中华人民共和国民政部行政区划）',
  source: '阿里云 DataV.GeoAtlas areas_v3',
  url: 'https://geo.datav.aliyun.com/areas_v3/bound/',
  note_zh: '日常仿真与内部报告适用；对外正式出版的地图须换用带审图号的底图。'
}

// ---------- 中国 ADM2：地级市（民政部口径） ----------
// 27 个省/自治区逐个拉（4 直辖市与港澳台下面直接是县区，没有地级这一层）；
// 省直辖县级（新疆兵团师市 / 海南直管县 / 湖北仙桃潜江天门神农架 / 河南济源）按共享边界最长并入邻近地级市，
// 领地溶进去、名字不出 —— 地图上既不留空格，也不冒出「非地级」的名字。
// 跨省的那条边在两个省文件里坐标对不上，共享边判定抓不到 → 省界不进本包，由 ADM1 那一层画（本层只在
// 「中国」被勾进一级行政区时才可开，两层必定同时在场，接不上的问题不存在）。
async function buildChinaAdm2(attribution) {
  const raw = await CN.fetchPrefectures()
  const group = CN.mergeGroups(raw, polysOf)
  const merged = new Map()          // 归属地级市 adcode → { adcode, name, centroid, polys[] }
  for (const f of raw) {
    const g = group.get(f.adcode) || f.adcode
    let u = merged.get(g)
    if (!u) { const host = raw.find((x) => x.adcode === g) || f; u = { adcode: g, name: host.name, centroid: host.centroid || host.center, polys: [] }; merged.set(g, u) }
    for (const rings of polysOf(f.geometry)) u.polys.push(rings)
  }
  const mergedIn = raw.filter((f) => CN.isMerged(f.adcode)).length
  const units = [...merged.values()].map((u) => ({ geometry: { type: 'MultiPolygon', coordinates: u.polys }, _u: u }))

  // 英文名：NE 10m populated_places 的 NAME_ZH 对上就取 NAME，对不上回落中文
  const pp = await neLayer('10m', 'populated_places')
  const zh2en = new Map()
  for (const f of pp.features) {
    const P = f.properties
    if ((P.ADM0_A3 || P.adm0_a3) !== 'CHN') continue
    const z = clean(P.NAME_ZH || P.name_zh), e = clean(P.NAME || P.name)
    if (z && e) { const k = z.replace(/(市|镇|县|区)$/, ''); if (!zh2en.has(k)) zh2en.set(k, e) }
  }
  let hitEn = 0
  const names = units.map((f) => {
    const u = f._u
    const zh = CN.cityShort(u.name)
    const en = CN.CITY_EN[zh] || zh2en.get(zh) || null
    if (en) hitEn++
    const c = u.centroid || []
    return labelOf(f, en || zh, zh, Number(c[0]), Number(c[1]), 12)   // rk=12：地级市，排在所有一级之后
  })
  console.log('  CHN adm2：拉到 ' + raw.length + ' 个单元 · 并掉省直辖县级等 ' + mergedIn + ' 个 · 地级市 ' + units.length +
    ' · 英文名对上 ' + hitEn + '/' + units.length + '（对不上的两档都出中文）')
  writePack('CHN', 'adm2', units, names, () => 'CHN')
  ;(attribution.CHN || (attribution.CHN = {})).adm2 = DATAV_CREDIT
}

async function main() {
  const args = process.argv.slice(2)
  const only = args.filter((a) => /^[A-Z]{3}$/.test(a))
  const adm1Only = args.includes('--adm1')
  const meta = await gbMeta()
  const attribution = {}

  // ---------- ADM1 ----------
  console.log('=== 一级行政区（ADM1） ===')
  const ne1 = await neLayer('10m', 'admin_1_states_provinces')
  const byIso = {}
  for (const f of ne1.features) {
    const a = clean(f.properties.adm0_a3)
    if (!a || a === 'CHN') continue          // 中国另走 geoBoundaries（NE 少了台港澳）
    ;(byIso[a] || (byIso[a] = [])).push(f)
  }
  // 中国 ADM1：DataV（民政部行政区划）—— 34 个省级单元，中文自带，与地级市那一层同一套几何
  if (!only.length || only.includes('CHN')) {
    const j = await CN.datavFull(100000)
    const feats = j.features.filter((f) => f.geometry && f.properties && CN.isProvince(f.properties))
    if (feats.length !== 34) console.log('  ! CHN ADM1 单元数 ' + feats.length + '（预期 34，含台港澳）—— 请人工核对后再用')
    const names = feats.map((f) => {
      const p0 = f.properties
      const c = p0.centroid || p0.center || []
      // rk=4：中国的省与德国的州、美国的州同一量级（NE 给这类 labelrank 3~5），排在英国那 232 个区之前
      return labelOf(f, CN.PROV_EN[p0.adcode] || CN.provShort(p0.adcode, p0.name), CN.provShort(p0.adcode, p0.name), Number(c[0]), Number(c[1]), 4)
    })
    writePack('CHN', 'adm1', feats, names, () => 'CHN')
    attribution.CHN = { adm1: DATAV_CREDIT }
  }
  const isoList1 = Object.keys(byIso).filter((a) => !only.length || only.includes(a)).sort()
  for (const iso of isoList1) {
    const { units, names } = groupAdm1(iso, byIso[iso])
    writePack(iso, 'adm1', units, names, () => iso)
    ;(attribution[iso] || (attribution[iso] = {})).adm1 = {
      license: 'Public domain', source: 'Natural Earth 10m Admin 1 – States, Provinces',
      url: 'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/'
    }
  }
  if (adm1Only) return finish(attribution)

  // ---------- ADM2 ----------
  console.log('\n=== 二级行政区（ADM2） ===')
  if (!only.length || only.includes('CHN')) await buildChinaAdm2(attribution)
  const isoList2 = Object.keys(meta).filter((a) => a !== 'CHN' && meta[a].adm2 && (!only.length || only.includes(a))).sort()
  let done = 0
  for (const iso of isoList2) {
    const m = meta[iso].adm2
    try {
      const feats = await gbFeatures(iso, 'ADM2', m.url)
      const names = feats.map((f) => labelOf(f, clean(f.properties.shapeName) || '—', null, NaN, NaN, 14))   // rk=14：二级，最后摆
      writePack(iso, 'adm2', feats, names, () => iso)
      ;(attribution[iso] || (attribution[iso] = {})).adm2 = { license: m.license, source: m.source, url: m.url, year: m.year }
      done++
    } catch (e) { console.log('  ! ' + iso + ' ADM2 失败：' + e.message) }
  }
  console.log('ADM2 出包 ' + done + ' / ' + isoList2.length)
  finish(attribution)
}

function finish(attribution) {
  fs.mkdirSync(META_OUT, { recursive: true })
  const f = path.join(META_OUT, 'ATTRIBUTION.json')
  const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}
  for (const [k, v] of Object.entries(attribution)) prev[k] = { ...(prev[k] || {}), ...v }
  fs.writeFileSync(f, JSON.stringify(prev, null, 1) + '\n')
  console.log('\n署名表 ' + Object.keys(prev).length + ' 个国家 → ' + path.relative(ROOT, f))
  // 目录：界面的国家选择器只列【本地确实有包】的国家，避免出现点了没数据的死选项。
  // 按目录里实际存在的文件生成，故增量出几个国家的包后重跑一次即可对上。
  const idx = { adm1: [], adm2: [] }
  for (const n of fs.readdirSync(OUT)) {
    const m = /^([A-Z]{3})-adm([12])\.json$/.exec(n)
    if (m) idx['adm' + m[2]].push(m[1])
  }
  idx.adm1.sort(); idx.adm2.sort()
  const fi = path.join(META_OUT, 'index.json')
  fs.writeFileSync(fi, JSON.stringify(idx) + '\n')
  console.log('目录：一级 ' + idx.adm1.length + ' 国 · 二级 ' + idx.adm2.length + ' 国 → ' + path.relative(ROOT, fi))
}

await main()
