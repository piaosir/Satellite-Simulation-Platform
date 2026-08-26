// 全球行政边界构建：一级(ADM1) / 二级(ADM2) → resources/adm/{ISO3}-adm{1,2}.json
//   另出两份小文件到 src/viz/globe3d/data/adm/：index.json（有哪些国家的包）与 ATTRIBUTION.json（逐国署名）。
//   逐国包放 resources 是因为它有两百多个：进渲染端打包会让 rollup 生成两百多个 chunk，实测默认堆 OOM；
//   改由主进程按需读盘（electron/services/admBoundaries.js）经 IPC 送给渲染端。
//   本脚本取代原 build-provinces.js / build-cities.js（中国省界/地级市界，阿里 DataV 源）。
//
// 数据源
//   ADM1  Natural Earth 10m admin_1_states_provinces（公有领域，251 个国家/地区、4596 个单元）
//         ★ 中国例外：NE 的 CHN admin_1 只有 32 个（台湾/港澳被 NE 当成独立 admin_0），
//           与本平台「台港澳属中国」的口径不符 → 中国的 ADM1 改用 geoBoundaries CHN（34 个，含台港澳）。
//   ADM2  geoBoundaries gbOpen 逐国（CC BY 4.0 / ODbL / PDDL，逐国许可，见 ATTRIBUTION.json）
//         中国 ADM2 = 2391 个单元，源标注国家测绘部门，许可 ODC-PDDL 公共领域奉献。
//
// 算法与 build-provinces.js 一脉相承：只保留【被两个单元共享的边】（出现 ≥2 次），
// 丢掉只属一个单元的外缘边（= 国境/海岸，由底图兜底）。区别是不再用 toFixed(5) 拼串比对坐标 ——
// 坐标先按 3 位小数量化，边键直接用量化后的整数对，快且不产生浮点毛刺。
//
// ★ 名称（严格执行任务书的两档规则）：只有「本地名 / 英文」两档，默认英文；没有本地名就两档都用英文。
//   不做中文，不去挂 Wikidata / GeoNames 的中文别名。两处例外都是【数据源自带的本地名】：
//     · NE admin_1 自带 name_local / name_zh —— 直接用；
//     · geoBoundaries 的 shapeName 全是英文/拼音（任务书假设「中国的本地名就是中文，数据源自带」，实测不成立）。
//       中国 ADM1 的中文名由 NE admin_1 的 name_zh 按内点相交补上（台港澳三条在 CHN_SAR_ZH 里显式给），34 条全覆盖；
//       中国 ADM2 没有任何公有领域的中文名可用 → name_local 留空，按任务书的规则两档都回落英文（拼音）。
//       ★ 另一处实测差异：geoBoundaries 的 CHN ADM2 是【县级】2391 个（Mohexian / Tahexian …），
//         与平台原有的「地级市」333 个不是同一层级。改用 geoBoundaries 是任务书的明确要求（商用授权更干净），
//         照办；要换回地级市层只需把 CHN 从 ADM2 名单里去掉、另供一份包。
//
// ★ wv（适用视角）：某些单元在不同视角下不属于本国（如印度的阿鲁纳恰尔在中国视角下属中国）。
//   构建期拿【运行时那份解算器】逐单元判一遍六套视角，只在本国的视角集合不是全集时才标 wv。
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

// 视角敏感国家 + 争议面包围盒：绝大多数国家在六套视角下疆域完全一样，逐单元判视角纯属白做。
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

// 台港澳的中文名：geoBoundaries 的 CHN ADM1 里这三条是英文，NE admin_1 又没有它们（NE 把它们当独立 admin_0）
const CHN_SAR_ZH = { 'Taiwan Province': '台湾', 'Hong Kong Special Administrative Region': '香港', 'Macau Special Administrative Region': '澳门' }
// geoBoundaries 的 CHN ADM1 里「Guangzhou Province」是广东省的笔误（源数据如此），按源名匹配中文
const CHN_ADM1_FIX = { 'Guangzhou Province': '广东' }

const q = (v) => Math.round(v * Q)
const unq = (v) => v / Q
const clean = (v) => (typeof v === 'string' && v.trim() && v !== '-99' ? v.trim() : null)
// NE 的 name_local 有「繁體|简体」两段的写法，取简体那段
const localOf = (p) => { const v = clean(p.name_zh) || clean(p.name_local); return v ? (v.includes('|') ? v.split('|').pop().trim() : v) : null }

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
    if ((cnt.get(k) || 0) < 2 || done.has(k)) return
    done.add(k)
    const sides = owner.get(k) || [i]
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
function labelOf(f, nameEn, nameLocal, hintLon, hintLat) {
  const pt = interiorPoint(f.geometry, hintLon, hintLat)
  if (!pt) return null
  return { name_en: nameEn, name_local: nameLocal || null, lon: Math.round(pt[0] * Q) / Q, lat: Math.round(pt[1] * Q) / Q }
}
// 单元的适用视角：内点在六套视角下是否仍归本国。全归 → null（通用）
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
  // 中国 ADM1：geoBoundaries 几何 + NE 的 name_zh 按内点相交补中文
  if (!only.length || only.includes('CHN')) {
    const m = meta.CHN && meta.CHN.adm1
    if (!m) console.log('  ! geoBoundaries 没有 CHN ADM1')
    else {
      const feats = await gbFeatures('CHN', 'ADM1', m.url)
      if (feats.length !== 34) console.log('  ! CHN ADM1 单元数 ' + feats.length + '（预期 34，含台港澳）—— 请人工核对后再用')
      const zhSrc = ne1.features.filter((f) => clean(f.properties.adm0_a3) === 'CHN')
        .map((f) => ({ zh: localOf(f.properties), lon: Number(f.properties.longitude), lat: Number(f.properties.latitude) }))
        .filter((x) => x.zh && Number.isFinite(x.lon))
      const names = feats.map((f) => {
        const en = clean(f.properties.shapeName) || '—'
        let zh = CHN_SAR_ZH[en] || CHN_ADM1_FIX[en] || null
        if (!zh) { const hit = zhSrc.find((x) => polysOf(f.geometry).some((rings) => inRings(rings, x.lon, x.lat))); if (hit) zh = hit.zh }
        return labelOf(f, en, zh, NaN, NaN)
      })
      const miss = names.filter((n) => n && !n.name_local).length
      if (miss) console.log('  ! CHN ADM1 有 ' + miss + ' 个单元没匹配到中文名（回落英文）')
      writePack('CHN', 'adm1', feats, names, () => 'CHN')
      attribution.CHN = { adm1: { license: m.license, source: m.source, url: m.url, year: m.year } }
    }
  }
  const isoList1 = Object.keys(byIso).filter((a) => !only.length || only.includes(a)).sort()
  for (const iso of isoList1) {
    const feats = byIso[iso]
    const names = feats.map((f) => labelOf(f, clean(f.properties.name) || clean(f.properties.name_en) || '—', localOf(f.properties), Number(f.properties.longitude), Number(f.properties.latitude)))
    writePack(iso, 'adm1', feats, names, () => iso)
    ;(attribution[iso] || (attribution[iso] = {})).adm1 = {
      license: 'Public domain', source: 'Natural Earth 10m Admin 1 – States, Provinces',
      url: 'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/'
    }
  }
  if (adm1Only) return finish(attribution)

  // ---------- ADM2 ----------
  console.log('\n=== 二级行政区（ADM2） ===')
  const isoList2 = Object.keys(meta).filter((a) => meta[a].adm2 && (!only.length || only.includes(a))).sort()
  let done = 0
  for (const iso of isoList2) {
    const m = meta[iso].adm2
    try {
      const feats = await gbFeatures(iso, 'ADM2', m.url)
      const names = feats.map((f) => labelOf(f, clean(f.properties.shapeName) || '—', null, NaN, NaN))
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
