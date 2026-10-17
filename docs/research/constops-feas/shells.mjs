// 可行性验证：仅凭公开 GP 快照（单历元），能否把一个巨型星座拆成 壳层 → 轨道面 → 槽位，并给出生命周期状态
// 用法：node shells.mjs <csv.gz> [名称]
import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const label = process.argv[3] || file
const MINC = +(process.argv[4] || 40)
const t0 = performance.now()
const txt = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
const lines = txt.split(/\r?\n/).filter(Boolean)
const head = lines[0].split(',')
const col = Object.fromEntries(head.map((h, i) => [h, i]))
const MU = 398600.4418, RE = 6378.137, J2 = 1.08262668e-3
const D2R = Math.PI / 180

const sats = []
for (let k = 1; k < lines.length; k++) {
  const c = lines[k].split(',')
  const n = +c[col.MEAN_MOTION]                      // rev/day
  const e = +c[col.ECCENTRICITY]
  const i = +c[col.INCLINATION]
  const raan = +c[col.RA_OF_ASC_NODE]
  const argp = +c[col.ARG_OF_PERICENTER]
  const M = +c[col.MEAN_ANOMALY]
  const ep = Date.parse(c[col.EPOCH] + 'Z')
  const ndot = +c[col.MEAN_MOTION_DOT]               // rev/day^2（TLE 的 ndot/2）
  const nRad = n * 2 * Math.PI / 86400
  const a = Math.cbrt(MU / (nRad * nRad))
  const p = a * (1 - e * e)
  const k2 = 1.5 * J2 * (RE / p) ** 2
  const dRaan = -k2 * nRad * Math.cos(i * D2R)                       // rad/s
  const dArgp = 0.5 * k2 * nRad * (5 * Math.cos(i * D2R) ** 2 - 1)
  const dM = nRad * (1 + 0.5 * k2 * Math.sqrt(1 - e * e) * (3 * Math.cos(i * D2R) ** 2 - 1))
  sats.push({
    name: c[col.OBJECT_NAME], id: +c[col.NORAD_CAT_ID], cospar: c[col.OBJECT_ID],
    n, e, i, raan, argp, M, ep, ndot, a,
    h: a - RE, hp: a * (1 - e) - RE, ha: a * (1 + e) - RE,
    dRaan, dArgp, dM,
  })
}
const tRef = Math.max(...sats.map(s => s.ep))
const norm = x => ((x % 360) + 360) % 360
for (const s of sats) {
  const dt = (tRef - s.ep) / 1000
  s.raanRef = norm(s.raan + s.dRaan * dt / D2R)
  s.uRef = norm(s.argp + s.M + (s.dArgp + s.dM) * dt / D2R)
  s.ageH = (tRef - s.ep) / 3.6e6
}
const tParse = performance.now() - t0

// ---------- 1) 倾角众数 ----------
function peaks1d(vals, bin, minCount, lo, hi) {
  const nb = Math.ceil((hi - lo) / bin)
  const hist = new Array(nb).fill(0)
  for (const v of vals) { const b = Math.floor((v - lo) / bin); if (b >= 0 && b < nb) hist[b]++ }
  const pk = []
  for (let b = 0; b < nb; b++) {
    const v = hist[b]
    if (v < minCount) continue
    if (v >= (hist[b - 1] ?? 0) && v > (hist[b + 1] ?? 0)) pk.push({ at: lo + (b + 0.5) * bin, count: v })
  }
  return pk
}
// 只用「像在工作」的星找壳：近圆、非低轨衰减段
const healthy = sats.filter(s => s.e < 0.003 && s.hp > 300)
const incPk0 = peaks1d(healthy.map(s => s.i), 0.05, MINC, 0, 180); const incPk = []; for (const p of incPk0) { const l = incPk[incPk.length - 1]; if (l && p.at - l.at <= 0.12) { if (p.count > l.count) Object.assign(l, p) } else incPk.push({ ...p }) }

// ---------- 2) 每个倾角族内的高度众数 → 壳层 ----------
const shells = []
for (const ip of incPk) {
  const fam = healthy.filter(s => Math.abs(s.i - ip.at) < 0.08)
  const hPk = peaks1d(fam.map(s => s.h), 2, MINC, 150, 2500)
  // 合并相邻 ≤4 km 的峰
  const merged = []
  for (const p of hPk) {
    const last = merged[merged.length - 1]
    if (last && p.at - last.at <= 4) { if (p.count > last.count) Object.assign(last, p) }
    else merged.push({ ...p })
  }
  for (const hp of merged) {
    const mem = fam.filter(s => Math.abs(s.h - hp.at) <= 6)
    const hMed = median(mem.map(s => s.h))
    const iMed = median(mem.map(s => s.i))
    shells.push({ inc: iMed, alt: hMed, members: mem })
  }
}
function median(a) { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN }

// ---------- 3) 壳内轨道面：RAAN 圆周聚类（间隙切分） ----------
function circClusters(vals, gapDeg) {
  const v = [...vals].sort((x, y) => x - y)
  if (!v.length) return []
  // 找最大间隙作起点，避免 0/360 处把一个面切成两半
  let maxGap = -1, at = 0
  for (let k = 0; k < v.length; k++) {
    const g = (k === v.length - 1 ? v[0] + 360 : v[k + 1]) - v[k]
    if (g > maxGap) { maxGap = g; at = k + 1 }
  }
  const r = v.slice(at).concat(v.slice(0, at).map(x => x + 360))
  const out = [[r[0]]]
  for (let k = 1; k < r.length; k++) {
    if (r[k] - r[k - 1] > gapDeg) out.push([r[k]])
    else out[out.length - 1].push(r[k])
  }
  return out
}
for (const sh of shells) {
  const cl = circClusters(sh.members.map(s => s.raanRef), 1.2)
  const sizes = cl.map(c => c.length)
  sh.planes = cl.length
  sh.planesBig = sizes.filter(x => x >= 5).length
  sh.perPlaneMed = median(sizes.filter(x => x >= 5))
  // 面间距：大面质心排序后的相邻差中位数
  const cents = cl.filter(c => c.length >= 5).map(c => norm(c.reduce((s, x) => s + x, 0) / c.length)).sort((a, b) => a - b)
  const gaps = cents.map((c, k) => (k === cents.length - 1 ? cents[0] + 360 : cents[k + 1]) - c)
  sh.spacing = median(gaps)
}

// ---------- 4) 生命周期状态（单历元启发式） ----------
// 在壳：|h−h壳|≤6 且属于某壳；其余按高度 + ndot 符号分：
//   衰减/再入：近地点 < 250 km
//   升轨：低于最近壳 >6 km 且 ndot ≤ 0（拟合出的平均运动在减小 = 在抬高）
//   降轨/离轨：低于最近壳 >6 km 且 ndot > 0 且（ndot 大 或 高度 < 400）
//   其他：高于壳 / 偏心 / 不归壳
const inShell = new Set()
for (const sh of shells) for (const s of sh.members) inShell.add(s.id)
const st = { inShell: 0, raising: 0, lowering: 0, decaying: 0, other: 0 }
const ndotOp = median(shells.flatMap(sh => sh.members.map(s => s.ndot)))
for (const s of sats) {
  if (inShell.has(s.id)) { s.state = 'inShell'; st.inShell++; continue }
  if (s.hp < 250) { s.state = 'decaying'; st.decaying++; continue }
  const near = shells.filter(sh => Math.abs(sh.inc - s.i) < 0.5).sort((x, y) => Math.abs(x.alt - s.h) - Math.abs(y.alt - s.h))[0]
  if (near && s.h < near.alt - 6) {
    if (s.ndot <= 0) { s.state = 'raising'; st.raising++ }
    else { s.state = 'lowering'; st.lowering++ }
    continue
  }
  s.state = 'other'; st.other++
}
const tAll = performance.now() - t0

// ---------- 5) 在壳星的面内相位均匀度（槽位偏差）----------
for (const sh of shells) {
  const cl = circClusters(sh.members.map(s => s.raanRef), 1.2).filter(c => c.length >= 5)
  // 用每个面的成员 u 做「理想等间隔」拟合：u_k = u0 + k·360/N，取相位残差 RMS
  let res = [], used = 0
  const byPlane = new Map()
  for (const s of sh.members) {
    const c = cl.findIndex(cc => cc.some(x => Math.abs(norm(x) - s.raanRef) < 1e-9))
    if (c < 0) continue
    if (!byPlane.has(c)) byPlane.set(c, [])
    byPlane.get(c).push(s.uRef)
  }
  for (const us of byPlane.values()) {
    const N = us.length
    if (N < 5) continue
    const step = 360 / N
    const u = [...us].sort((a, b) => a - b)
    // 最佳 u0 = 圆均值( u_k − k·step )
    let cx = 0, cy = 0
    u.forEach((x, k) => { const r = (x - k * step) * D2R; cx += Math.cos(r); cy += Math.sin(r) })
    const u0 = Math.atan2(cy, cx) / D2R
    u.forEach((x, k) => { let d = norm(x - (u0 + k * step)); if (d > 180) d -= 360; res.push(d) })
    used++
  }
  sh.phaseRms = res.length ? Math.sqrt(res.reduce((s, d) => s + d * d, 0) / res.length) : NaN
}

console.log(`\n== ${label} ==  ${sats.length} 条   参考历元 ${new Date(tRef).toISOString()}   解析 ${tParse.toFixed(0)} ms / 全流程 ${tAll.toFixed(0)} ms`)
console.log(`历元龄中位 ${median(sats.map(s => s.ageH)).toFixed(1)} h，在壳星 ndot 中位 ${ndotOp.toExponential(2)} rev/d²`)
console.log('壳层（倾角° / 高度km / 颗数 / RAAN簇 / ≥5颗的面 / 每面中位 / 面间距° / 面内相位残差RMS°）')
for (const sh of shells.sort((a, b) => a.inc - b.inc || a.alt - b.alt)) {
  console.log(`  ${sh.inc.toFixed(2).padStart(6)}  ${sh.alt.toFixed(1).padStart(6)}  ${String(sh.members.length).padStart(5)}  ${String(sh.planes).padStart(4)}  ${String(sh.planesBig).padStart(4)}  ${String(sh.perPlaneMed).padStart(4)}  ${sh.spacing?.toFixed(2).padStart(6)}  ${sh.phaseRms?.toFixed(1).padStart(6)}`)
}
console.log('状态：', st)
// 偏离壳的分布摘要
const oth = sats.filter(s => s.state !== 'inShell')
const hb = {}
for (const s of oth) { const b = Math.floor(s.h / 50) * 50; hb[b] = (hb[b] || 0) + 1 }
console.log('非在壳星平均高度分布（50 km 档）：', hb)

// ---------- 6) 壳层 × 发射批次（COSPAR 年-序号）----------
if (process.argv[5] === 'launch') {
  for (const sh of shells) {
    const by = new Map()
    for (const s of sh.members) { const L = s.cospar.slice(0, 8); by.set(L, (by.get(L) || 0) + 1) }
    const yrs = {}
    for (const s of sh.members) { const y = s.cospar.slice(0, 4); yrs[y] = (yrs[y] || 0) + 1 }
    const nd = sh.members.map(s => s.ndot)
    const neg = nd.filter(x => x < 0).length
    console.log(`壳 ${sh.inc.toFixed(2)}° ${sh.alt.toFixed(0)}km：${sh.members.length} 颗 来自 ${by.size} 次发射；年份 ${JSON.stringify(yrs)}；ndot<0 占 ${(100 * neg / nd.length).toFixed(0)}%`)
  }
  const ev = {}
  for (const s of sats.filter(s => s.state !== 'inShell')) { const y = s.cospar.slice(0, 4); ev[s.state + ':' + y] = (ev[s.state + ':' + y] || 0) + 1 }
  console.log('非在壳星 状态:年份 →', ev)
}

// ---------- 7) 与 CelesTrak SATCAT 运行状态码对拍 ----------
if (process.argv[6]) {
  const t = zlib.gunzipSync(fs.readFileSync(process.argv[6])).toString('utf8')
  const L = t.split(/\r?\n/).filter(Boolean)
  const H = L[0].split(','); const ix = Object.fromEntries(H.map((h, i) => [h, i]))
  const ops = new Map()
  for (let k = 1; k < L.length; k++) { const c = L[k].split(','); ops.set(+c[ix.NORAD_CAT_ID], c[ix.OPS_STATUS_CODE] || '') }
  const m = {}
  for (const s of sats) { const key = s.state + '→' + (ops.get(s.id) ?? '缺'); m[key] = (m[key] || 0) + 1 }
  console.log('本判状态 → 编目 OPS_STATUS 交叉：', m)
}
