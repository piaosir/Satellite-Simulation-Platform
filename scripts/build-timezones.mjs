// 时区图层数据构建（主窗「地图综合设置」视图的「时区」分区；任务书 docs/环境场时区显示任务书_2026-10-20.md）
//
//   → src/viz/geo/tz/tz-{10m,50m,110m}.json   时区面平面剖分（TopoJSON；量化网格与同档底图逐位相同，
//                                             国界段坐标与底图弧逐点相等，两条线严丝合缝）
//   → src/viz/geo/tz/tzRules.json              tzdb 2026e 规则表（rearguard 正夏令时语义；显式跃迁 + POSIX 脚注）
//
// 数据源（全部钉版本与 sha256；原始件缓存 .tz-src/，不进仓库）：
//   · timezone-boundary-builder 2026e「1970 合并版」陆地时区面 —— ODbL 1.0，© OpenStreetMap contributors
//   · PyPI tzdata 2026.5（= IANA tzdb 2026e）的 TZif 编译件 + zone1970.tab / iso3166.tab —— 公有领域
//   · Natural Earth 10m time_zones（日界线凸区的海面分块）/ geographic_lines（日界线）—— 公有领域，走 scripts/_ne/ 缓存
//   · 本平台底图 src/viz/globe3d/data/basemap-{10m,50m,110m}.json —— 公有领域（NE）
//
// 几何剖分在 Python 里做（scripts/lib/tz_partition.py：shapely ≥ 2.1 的覆盖简化、Voronoi、多边形化），
// 本脚本负责取数、组装口径表、建拓扑、出规则表与构建期自检。Python 解释器按 TZ_PYTHON → py -3 → python3 → python 依次找。
//
// 用法：node scripts/build-timezones.mjs [10m|50m|110m ...]（缺省三档全出；10m 档会顺带产出内陆水域参照，粗档依赖它）
//       npm run tz:build
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { topology } from 'topojson-server'
import { download, neLayer, CACHE as NE_CACHE } from './lib/neFetch.mjs'
import { unzip, shapefileFromZip } from './lib/shapefile.mjs'
import { parseTzif, zonePeriods, rearguard } from './lib/tzif.mjs'
import { FROZEN, CUSTOMIZABLE_DISPUTES } from '../src/viz/geo/frozen.js'
import { POV_FILES, normOwner } from '../src/viz/geo/povList.js'
import { parsePosixTz, posixAt, posixStdBase } from '../src/viz/geo/tzPosix.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, '.tz-src')
const WORK = path.join(SRC, 'work')
const OUTDIR = path.join(ROOT, 'src', 'viz', 'geo', 'tz')
const BASEDIR = path.join(ROOT, 'src', 'viz', 'globe3d', 'data')

const TBB = {
  ver: '2026e',
  url: 'https://github.com/evansiroky/timezone-boundary-builder/releases/download/2026e/timezones-1970.geojson.zip',
  file: 'timezones-1970.geojson.zip',
  sha256: '3de9301809f44d0ac5ca902b40835d85d9980a35497f0ffda293e98955dc3fb7'
}
const TZDATA = {
  ver: '2026.5', iana: '2026e',
  url: 'https://files.pythonhosted.org/packages/94/21/1e5995a1c920cce14e4bffae20c665ec10e7ed03ab25e006cd741092b718/tzdata-2026.5-py2.py3-none-any.whl',
  file: 'tzdata-2026.5-py2.py3-none-any.whl',
  sha256: 'b683bd1b6659ddcd810ff02ad09ba821d4bf1065072805063eb35c49617905ac'
}
// 中国全境北京时间：tzdb 的 Asia/Urumqi（UTC+6，新疆民间习惯）当别名并入 Asia/Shanghai，任何归属下都不出现。
// 台港澳三个冻结单元归 CHN 时仍用自己的 tzdb 时区（1992 年以来与北京时间逐时刻相同，只在 1986–1991 年夏令时期间如实不同）。
const ALIAS = { 'Asia/Urumqi': 'Asia/Shanghai' }
const CHINA = { owner: 'CHN', zone: 'Asia/Shanghai', keepOwn: ['CN-TW', 'CN-HK', 'CN-MO'] }
// 底图里改了可读 id 的三个基础单元（build-basemap.mjs 的 ID_BASE）
const UNIT_ISO2 = { 'CN-TW': 'TW', 'CN-HK': 'HK', 'CN-MO': 'MO' }
const DETAILS = ['10m', '50m', '110m']
const BUDGET = { '10m': 5.0e6, '50m': 1.5e6, '110m': 0.35e6, rules: 0.3e6 }

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const t0 = Date.now()
const lap = () => ((Date.now() - t0) / 1000).toFixed(1) + 's'

async function pinned(spec) {
  const dest = path.join(SRC, spec.file)
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(SRC, { recursive: true })
    process.stdout.write('  下载 ' + spec.file + ' … ')
    await download(spec.url, dest)
    console.log((fs.statSync(dest).size / 1e6).toFixed(2) + ' MB')
  }
  const buf = fs.readFileSync(dest)
  const h = sha256(buf)
  if (h !== spec.sha256) throw new Error(`${spec.file} sha256 不符：${h}（应为 ${spec.sha256}）—— 删掉 .tz-src/ 里这份重下，或核实上游是否换了包`)
  return buf
}

function findPython() {
  const tries = []
  if (process.env.TZ_PYTHON) tries.push([process.env.TZ_PYTHON, []])
  tries.push(['py', ['-3']], ['python3', []], ['python', []])
  for (const [cmd, pre] of tries) {
    const r = spawnSync(cmd, [...pre, '-c', 'import shapely,numpy;print(shapely.__version__)'], { encoding: 'utf8' })
    if (r.status === 0) {
      const v = r.stdout.trim().split('.').map(Number)
      if (v[0] > 2 || (v[0] === 2 && v[1] >= 1)) return [cmd, pre]
    }
  }
  throw new Error('找不到装了 shapely ≥ 2.1 与 numpy 的 Python：设环境变量 TZ_PYTHON 指向它（pip install "shapely>=2.1" numpy）')
}

// ---------------------------------------------------------------- 口径表
function tabRows(txt) { return txt.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t')) }

// TBB 的「1970 合并版」只看 1970 年以来 UT 偏移是否相同（不管缩写），zone1970.tab 却按缩写分列 ——
// Africa/Maputo 并进了 Africa/Johannesburg、Asia/Kuching 并进了 Asia/Makassar。按 TZif 的偏移时间线自己求等价类，
// 国家码按整类取并集；落到某国时换成类里属于该国的那个名字（卢本巴希显示 Africa/Maputo，不显示约翰内斯堡）。
function zoneClasses(wheel, names) {
  const bySig = new Map(), sigOf = new Map()
  for (const z of names) {
    const buf = wheel['tzdata/zoneinfo/' + z]
    if (!buf) continue
    const segs = zonePeriods(parseTzif(buf), 2037)
    const sig = segs.map((q) => (Number.isFinite(q.t) ? q.t : '-') + ':' + q.utoff).join(',')
    sigOf.set(z, sig)
    if (!bySig.has(sig)) bySig.set(sig, [])
    bySig.get(sig).push(z)
  }
  const cls = {}
  for (const [z, sig] of sigOf) cls[z] = bySig.get(sig).slice().sort()
  return cls
}

function buildMeta(wheel, tbbIds) {
  const zoneCodes = {}, principal = {}
  for (const [codes, , zone] of tabRows(wheel['tzdata/zoneinfo/zone1970.tab'].toString('utf8'))) {
    zoneCodes[zone] = codes.split(',')
    for (const c of codes.split(',')) if (!principal[c]) principal[c] = zone
  }
  // ISO3 / SU_A3 / ADM0_A3 → ISO2：取 NE map_units 的 ISO_A2_EH（-99 的不要）
  const iso2 = { ...UNIT_ISO2 }
  const mu = shapefileFromZip(fs.readFileSync(path.join(NE_CACHE, 'ne_10m_admin_0_map_units.zip')))
  const ok = (v) => v && v !== '-99' && /^[A-Z]{2}$/.test(v)
  for (const f of mu.features) {
    const p = f.properties
    if (!ok(p.ISO_A2_EH)) continue
    if (p.SU_A3 && !iso2[p.SU_A3]) iso2[p.SU_A3] = p.ISO_A2_EH
    if (ok(p.ISO_A2_EH) && p.ISO_A3_EH && p.ISO_A3_EH !== '-99' && !iso2[p.ISO_A3_EH]) iso2[p.ISO_A3_EH] = p.ISO_A2_EH
  }
  for (const f of mu.features) {             // 主权单元：ADM0_A3 取「SU_A3 == ADM0_A3」那一条的码
    const p = f.properties
    if (p.SU_A3 === p.ADM0_A3 && ok(p.ISO_A2_EH)) iso2[p.ADM0_A3] = p.ISO_A2_EH
  }
  // 候选归属：own0（由 Python 从底图读）+ FROZEN + 可自定义争议区选项 + 各套视角表
  const owners = {}
  const add = (u, o) => { o = normOwner(o); if (!o) return; (owners[u] = owners[u] || new Set()).add(o) }
  for (const [u, o] of Object.entries(FROZEN)) add(u, o)
  for (const d of CUSTOMIZABLE_DISPUTES) for (const u of d.units) for (const o of d.opts) add(u, o)
  for (const pov of Object.values(POV_FILES)) for (const [u, o] of Object.entries(pov.own || {})) add(u, o)
  const zoneClass = zoneClasses(wheel, new Set([...Object.keys(zoneCodes), ...tbbIds]))
  return {
    zoneCodes, zoneClass, principal, iso2, alias: ALIAS,
    owners: Object.fromEntries(Object.entries(owners).map(([u, s]) => [u, [...s].sort()])),
    keepOwn: CHINA.keepOwn, chinaOwner: CHINA.owner, chinaZone: CHINA.zone
  }
}

// ---------------------------------------------------------------- 规则表
// 每区：显式跃迁到最后一次为止（rearguard 已处理），之后按脚注现算 —— 运行时与这里用同一份 tzPosix.js。
function buildRules(wheel, names) {
  const zones = [...names].sort()
  const data = [], foot = [], fstart = []
  for (const z of zones) {
    const buf = wheel['tzdata/zoneinfo/' + z]
    if (!buf) throw new Error('tzdata 里没有 ' + z)
    const tz = parseTzif(buf)
    const full = rearguard(zonePeriods(tz, 2100))
    const last = tz.times.length ? tz.times[tz.times.length - 1] : -Infinity
    const keep = full.filter((s) => !Number.isFinite(s.t) || s.t <= last + 1)
    const arr = [keep[0].off, keep[0].dst]
    let prev = 0
    for (let i = 1; i < keep.length; i++) { arr.push(keep[i].t - prev, keep[i].off, keep[i].dst); prev = keep[i].t }
    data.push(arr)
    foot.push(tz.footer || '')
    fstart.push(Number.isFinite(last) ? last : 0)   // 脚注只管 TZif 最后一次跃迁之后（那次跃迁可能是偏移不变的标记，去重后不在 keep 里，Norfolk 2019-06-30 即是）
    // 自检：运行时算法（显式段二分 + 脚注）在 2100 年前的每个跃迁前后都与全展开的 rearguard 段一致
    const rt = runtimeEval(arr, tz.footer || '', Number.isFinite(last) ? last : 0)
    for (const s of full) {
      if (!Number.isFinite(s.t)) continue
      for (const dt of [-3600, 0, 3600]) {
        const t = s.t + dt
        const want = full.filter((q) => !Number.isFinite(q.t) || q.t <= t).pop()
        const got = rt(t)
        if (Math.abs(got.off - want.off) > 1e-9 || Math.abs(got.dst - want.dst) > 1e-9) throw new Error(`规则表自检失败：${z} @ ${new Date(t * 1000).toISOString()} 得 ${got.off}/${got.dst} 应 ${want.off}/${want.dst}`)
      }
    }
  }
  return { v: TZDATA.iana, zones, data, foot, fs: fstart }
}

// 与 src/viz/geo/tzRules.js 同一算法（构建期自检用）
function runtimeEval(arr, footer, fs0) {
  const ts = [-Infinity], off = [arr[0]], dst = [arr[1]]
  let t = 0
  for (let i = 2; i < arr.length; i += 3) { t += arr[i]; ts.push(t); off.push(arr[i + 1]); dst.push(arr[i + 2]) }
  const tz = footer ? parsePosixTz(footer) : null
  return (sec) => {
    let lo = 0, hi = ts.length - 1
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ts[m] <= sec) lo = m; else hi = m - 1 }
    if (lo === ts.length - 1 && tz && tz.dst && sec >= fs0) {
      const st = posixAt(tz, sec, Math.max(ts[lo], fs0))
      if (st) return { off: st.utoff / 60, dst: (st.utoff - posixStdBase(tz)) / 60 }
    }
    return { off: off[lo], dst: dst[lo] }
  }
}

// ---------------------------------------------------------------- 拓扑
function buildTopo(detail, faces, zoneIndex, nzone, base) {
  const fc = {
    type: 'FeatureCollection',
    features: faces.map((f) => ({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: f.g } }))
  }
  const topo = topology({ faces: fc })           // 不量化：先按坐标逐位相等找共享弧，再按底图网格量化
  const [sx, sy] = base.transform.scale, [tx, ty] = base.transform.translate
  const q = (x, y) => [Math.round((x - tx) / sx), Math.round((y - ty) / sy)]
  let maxDev = 0
  const qArcs = topo.arcs.map((arc) => {
    const out = []
    for (const [x, y] of arc) {
      const p = q(x, y)
      const dx = Math.abs(tx + p[0] * sx - x) / sx, dy = Math.abs(ty + p[1] * sy - y) / sy
      if (dx > maxDev) maxDev = dx
      if (dy > maxDev) maxDev = dy
      const l = out[out.length - 1]
      if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p)
    }
    if (out.length < 2) out.push(out[0].slice())
    return out
  })
  topo.arcs = qArcs.map((out) => {
    const d = [out[0]]
    for (let i = 1; i < out.length; i++) d.push([out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]])
    return d
  })
  topo.transform = { scale: base.transform.scale.slice(), translate: base.transform.translate.slice() }
  delete topo.bbox
  const adj = {}
  const G = topo.objects.faces.geometries
  G.forEach((g, i) => {
    const f = faces[i]
    const pr = { k: f.k === 'land' ? 'l' : f.k === 'sea' ? 's' : 'w', a: f.a }
    if (f.u) pr.u = f.u
    if (f.d) pr.d = f.d
    if (f.z0) pr.z = zoneIndex.get(f.z0)
    if (f.zt && Object.keys(f.zt).length) pr.t = Object.fromEntries(Object.entries(f.zt).map(([o, z]) => [o, zoneIndex.get(z)]))
    if (f.k === 'sea') pr.o = f.off
    g.properties = pr
    const rings = g.type === 'Polygon' ? g.arcs : g.type === 'MultiPolygon' ? g.arcs.flat() : []
    for (const r of rings) for (const a of r) { const k = a < 0 ? ~a : a; (adj[k] = adj[k] || []).push(i) }
  })
  topo.adj = adj
  // 跨 180° 经线的相邻：平面里 ±180° 是两条图边，东西两侧的面在拓扑上不相邻。把图边上的弧按纬度段配对，
  // 存成 seam = [[南纬, 北纬, 东侧(+180)面, 西侧(−180)面]]，运行时当作沿 180° 的边参与界线 / 连通区 ——
  // 日界线沿 180° 的那几段（48°N 到赤道南、两极附近）就靠它画出来。
  const QX = Math.round((180 - tx) / sx)
  const east = [], west = []
  qArcs.forEach((pts, ai) => {            // 逐段判：一条弧可能只有一截压在图边上
    const fs = adj[ai]
    if (!fs || fs.length !== 1) return
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], c = pts[i]
      if (p[1] === c[1]) continue
      if (p[0] === QX && c[0] === QX) east.push([Math.min(p[1], c[1]), Math.max(p[1], c[1]), fs[0]])
      else if (p[0] === 0 && c[0] === 0) west.push([Math.min(p[1], c[1]), Math.max(p[1], c[1]), fs[0]])
    }
  })
  const seam = []
  for (const [e0, e1, fe] of east) for (const [w0, w1, fw] of west) {
    const a = Math.max(e0, w0), b = Math.min(e1, w1)
    if (b > a) seam.push([+(ty + a * sy).toFixed(7), +(ty + b * sy).toFixed(7), fe, fw])
  }
  seam.sort((u, v) => u[0] - v[0])
  topo.seam = seam
  topo.meta = {
    scale: detail, nzone,
    source: `timezone-boundary-builder ${TBB.ver} (ODbL 1.0, © OpenStreetMap contributors) · tzdb ${TZDATA.iana} · Natural Earth 10m time_zones / geographic_lines (public domain) · basemap-${detail}`,
    generated: new Date().toISOString().slice(0, 10)
  }
  return { topo, maxDev }
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const want = process.argv.slice(2).filter((a) => DETAILS.includes(a))
  const details = want.length ? DETAILS.filter((d) => want.includes(d)) : DETAILS
  fs.mkdirSync(WORK, { recursive: true }); fs.mkdirSync(OUTDIR, { recursive: true })

  console.log('[1/5] 取数 ' + lap())
  const tbbZip = await pinned(TBB)
  const wheel = unzip(await pinned(TZDATA))
  const tbbJson = path.join(WORK, 'tbb-1970.json')
  if (!fs.existsSync(tbbJson)) {
    const files = unzip(tbbZip)
    const name = Object.keys(files).find((k) => /\.json$/i.test(k))
    fs.writeFileSync(tbbJson, files[name])
  }
  const neTz = await neLayer('10m', 'time_zones', 'cultural')
  const neGeo = await neLayer('10m', 'geographic_lines', 'physical')
  const idl = neGeo.features.find((f) => /date line/i.test(String(f.properties.NAME || f.properties.name || '')))
  if (!idl) throw new Error('NE geographic_lines 里找不到 International Date Line')
  const idlParts = idl.geometry.type === 'LineString' ? [idl.geometry.coordinates] : idl.geometry.coordinates
  fs.writeFileSync(path.join(WORK, 'idl.json'), JSON.stringify(idlParts))
  fs.writeFileSync(path.join(WORK, 'netz.json'), JSON.stringify({
    type: 'FeatureCollection',
    features: neTz.features.map((f) => ({ type: 'Feature', properties: { zone: Number(f.properties.zone ?? f.properties.ZONE) }, geometry: f.geometry }))
  }))

  console.log('[2/5] 口径表 ' + lap())
  const tbbIds = new Set(JSON.parse(fs.readFileSync(tbbJson, 'utf8')).features.map((f) => f.properties.tzid))
  const meta = buildMeta(wheel, tbbIds)
  const notTab = [...tbbIds].filter((z) => !meta.zoneCodes[z] && !ALIAS[z])
  if (notTab.length) console.warn('  ⚠ 这些 TBB 时区不在 zone1970.tab：' + notTab.join(' '))

  console.log('[3/5] 几何剖分（Python）' + lap())
  const [py, pre] = findPython()
  const facesBy = {}
  const order = details.includes('10m') ? ['10m', ...details.filter((d) => d !== '10m')] : details
  for (const d of order) {
    const m = { ...meta }
    const ref = path.join(WORK, 'faces-10m.json')
    if (d !== '10m' && fs.existsSync(ref)) m.inlandRef = JSON.parse(fs.readFileSync(ref, 'utf8')).inlandRef || null
    const metaPath = path.join(WORK, `meta-${d}.json`)
    fs.writeFileSync(metaPath, JSON.stringify(m))
    const out = path.join(WORK, `faces-${d}.json`)
    const r = spawnSync(py, [...pre, '-I', path.join(ROOT, 'scripts', 'lib', 'tz_partition.py'),
      'detail=' + d, 'meta=' + metaPath, 'basemap=' + path.join(BASEDIR, `basemap-${d}.json`),
      'tbb=' + tbbJson, 'netz=' + path.join(WORK, 'netz.json'), 'idl=' + path.join(WORK, 'idl.json'), 'out=' + out],
    { stdio: ['ignore', 'inherit', 'inherit'] })
    if (r.status !== 0) throw new Error(`Python 剖分失败（${d}）`)
    facesBy[d] = JSON.parse(fs.readFileSync(out, 'utf8')).faces
  }

  console.log('[4/5] 规则表 ' + lap())
  const names = new Set(['Asia/Shanghai', 'Asia/Macau'])
  // 规则表收齐三档用到的全部时区（只重建某一档时，其余档沿用上次的剖分结果，规则表不能因此缺区）
  for (const d of DETAILS) {
    const fp = path.join(WORK, `faces-${d}.json`)
    const fs_ = facesBy[d] || (fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')).faces : [])
    for (const f of fs_) { if (f.z0) names.add(f.z0); for (const z of Object.values(f.zt || {})) names.add(z) }
  }
  const rules = buildRules(wheel, names)
  const rulesTxt = JSON.stringify(rules)
  fs.writeFileSync(path.join(OUTDIR, 'tzRules.json'), rulesTxt)
  console.log(`  规则表 ${rules.zones.length} 区 · ${(rulesTxt.length / 1e3).toFixed(0)} KB`)
  const zoneIndex = new Map(rules.zones.map((z, i) => [z, i]))

  console.log('[5/5] 拓扑 ' + lap())
  for (const d of DETAILS) {
    if (!facesBy[d]) {
      const fp = path.join(WORK, `faces-${d}.json`)
      if (!fs.existsSync(fp)) continue
      facesBy[d] = JSON.parse(fs.readFileSync(fp, 'utf8')).faces
    }
    const base = JSON.parse(fs.readFileSync(path.join(BASEDIR, `basemap-${d}.json`), 'utf8'))
    const { topo, maxDev } = buildTopo(d, facesBy[d], zoneIndex, rules.zones.length, base)
    const txt = JSON.stringify(topo)
    fs.writeFileSync(path.join(OUTDIR, `tz-${d}.json`), txt)
    const nl = facesBy[d].filter((f) => f.k === 'land').length, ns = facesBy[d].filter((f) => f.k === 'sea').length
    console.log(`  tz-${d}.json ${(txt.length / 1e6).toFixed(2)} MB · 面 ${facesBy[d].length}（陆 ${nl} / 海 ${ns}）· 弧 ${topo.arcs.length} · 量化最大偏移 ${maxDev.toFixed(3)} 格`)
    if (txt.length > BUDGET[d]) console.warn(`  ⚠ 超出体积预算 ${(BUDGET[d] / 1e6).toFixed(2)} MB`)
  }
  if (rulesTxt.length > BUDGET.rules) console.warn('  ⚠ 规则表超出体积预算')
  console.log('完成 ' + lap())
}

main().catch((e) => { console.error(e); process.exit(1) })
