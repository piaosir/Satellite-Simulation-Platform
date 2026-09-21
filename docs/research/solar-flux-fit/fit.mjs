// NoRP 日流量（1 / 2 / 3.75 / 9.4 / 17 GHz）对 DRAO F10.7（观测值，20 UT）的线性回归：S_f = a_f + b_f·F10.7
// 输出：逐频 a、b、R²、残差 σ、N；换算到光学盘立体角下的亮温 T_b（F=67 / 120 / 200 sfu 三档）
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const NORP = path.join(HERE, 'norp')
const FLUX = path.join(HERE, 'pent', 'fluxtable.txt')

// ---- DRAO：每天取 20:00 UT（当地正午）的 fluxobsflux；缺 20 UT 就取当天任意一次
const f107 = new Map()
{
  const lines = readFileSync(FLUX, 'utf8').split(/\r?\n/)
  const tmp = new Map()
  for (const ln of lines) {
    const m = /^(\d{8})\s+(\d{6})\s+\S+\s+\S+\s+([\d.]+)\s+([\d.]+)/.exec(ln)
    if (!m) continue
    const d = m[1], t = m[2], obs = parseFloat(m[3])
    if (!(obs > 0)) continue
    const key = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
    const cur = tmp.get(key)
    if (!cur || t === '200000') tmp.set(key, { obs, t })
  }
  for (const [k, v] of tmp) f107.set(k, v.obs)
}
console.log('DRAO days', f107.size)

// ---- NoRP：nbymYYMM
const FREQ = [1000, 2000, 3750, 9400, 17000]
const rows = []   // { date, F, s: [5] }
let files = 0, bad = 0
for (const fn of readdirSync(NORP).filter((x) => /^nbym\d{4}$/.test(x)).sort()) {
  const txt = readFileSync(path.join(NORP, fn), 'utf8')
  const lines = txt.split(/\r?\n/)
  const hdr = lines.find((l) => /^\s+1000\s+2000/.test(l))
  if (!hdr) { bad++; continue }
  files++
  for (const ln of lines) {
    const m = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(ln)
    if (!m) continue
    const toks = m[2].trim().split(/\s+/)
    if (toks.length < 5) continue
    const s = toks.slice(0, 5).map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? parseFloat(x) : NaN))
    const F = f107.get(m[1])
    if (!(F > 0)) continue
    rows.push({ date: m[1], F, s })
  }
}
console.log('NoRP files', files, 'bad', bad, 'joined days', rows.length, rows[0] && rows[0].date, rows[rows.length - 1] && rows[rows.length - 1].date)

function linfit(xs, ys) {
  const n = xs.length
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i] }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  const a = (sy - b * sx) / n
  let ssr = 0, sst = 0
  const my = sy / n
  for (let i = 0; i < n; i++) { const r = ys[i] - (a + b * xs[i]); ssr += r * r; sst += (ys[i] - my) ** 2 }
  return { a, b, r2: 1 - ssr / sst, sig: Math.sqrt(ssr / (n - 2)), n }
}
function robust(xs, ys, k = 3, iters = 5) {
  let idx = xs.map((_, i) => i)
  let fit = null
  for (let it = 0; it < iters; it++) {
    fit = linfit(idx.map((i) => xs[i]), idx.map((i) => ys[i]))
    const keep = idx.filter((i) => Math.abs(ys[i] - (fit.a + fit.b * xs[i])) <= k * fit.sig)
    if (keep.length === idx.length) break
    idx = keep
  }
  return { ...fit, kept: idx.length }
}

// 亮温换算：T = S·λ²/(2k·Ω)，Ω 取光学盘（视直径 0.5334°，1 AU）
const KB = 1.380649e-23, SFU = 1e-22
const OMEGA = Math.PI / 4 * Math.pow(0.5334 * Math.PI / 180, 2)
const Tb = (fGHz, sfu) => sfu * SFU * Math.pow(0.299792458 / fGHz, 2) / (2 * KB * OMEGA)

const out = {}
for (let j = 0; j < FREQ.length; j++) {
  const xs = [], ys = []
  for (const r of rows) if (Number.isFinite(r.s[j]) && r.s[j] > 0) { xs.push(r.F); ys.push(r.s[j]) }
  const f = robust(xs, ys)
  const fq = FREQ[j] / 1000
  out[FREQ[j]] = f
  console.log(`\n${fq} GHz: S = ${f.a.toFixed(2)} + ${f.b.toFixed(4)}·F10.7   R²=${f.r2.toFixed(3)} σ=${f.sig.toFixed(1)} sfu  N=${f.n} (kept ${f.kept}/${xs.length})`)
  for (const F of [67, 90, 120, 150, 200]) {
    const S = f.a + f.b * F
    console.log(`   F10.7=${F}: S=${S.toFixed(1)} sfu → T_b(光学盘)=${Tb(fq, S).toFixed(0)} K`)
  }
  // 分段检验：低活动（F<90）与高活动（F>150）各自的均值比 —— 看线性是否成立
  const lo = [], hi = []
  for (let i = 0; i < xs.length; i++) { if (xs[i] < 90) lo.push(ys[i] - (f.a + f.b * xs[i])); else if (xs[i] > 150) hi.push(ys[i] - (f.a + f.b * xs[i])) }
  const mean = (a) => a.reduce((p, q) => p + q, 0) / (a.length || 1)
  console.log(`   残差均值 低活动(F<90,n=${lo.length}) ${mean(lo).toFixed(2)}  高活动(F>150,n=${hi.length}) ${mean(hi).toFixed(2)}`)
  // 二次项检验
  const q = quadfit(xs, ys)
  console.log(`   二次拟合: ${q.c0.toFixed(2)} + ${q.c1.toFixed(4)}·F + ${q.c2.toExponential(3)}·F²  R²=${q.r2.toFixed(4)}`)
}

function quadfit(xs, ys) {
  // 正规方程 3x3
  let n = xs.length, s1 = 0, s2 = 0, s3 = 0, s4 = 0, sy = 0, sxy = 0, sx2y = 0
  for (let i = 0; i < n; i++) { const x = xs[i], y = ys[i]; s1 += x; s2 += x * x; s3 += x ** 3; s4 += x ** 4; sy += y; sxy += x * y; sx2y += x * x * y }
  const A = [[n, s1, s2], [s1, s2, s3], [s2, s3, s4]], B = [sy, sxy, sx2y]
  const c = solve3(A, B)
  let ssr = 0, sst = 0; const my = sy / n
  for (let i = 0; i < n; i++) { const r = ys[i] - (c[0] + c[1] * xs[i] + c[2] * xs[i] * xs[i]); ssr += r * r; sst += (ys[i] - my) ** 2 }
  return { c0: c[0], c1: c[1], c2: c[2], r2: 1 - ssr / sst }
}
function solve3(A, B) {
  const M = A.map((r, i) => [...r, B[i]])
  for (let i = 0; i < 3; i++) {
    let p = i; for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r
    ;[M[i], M[p]] = [M[p], M[i]]
    for (let r = 0; r < 3; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c < 4; c++) M[r][c] -= f * M[i][c] }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]]
}

// 月均回归（对照）
{
  const mon = new Map()
  for (const r of rows) {
    const k = r.date.slice(0, 7)
    const m = mon.get(k) || { F: [], s: FREQ.map(() => []) }
    m.F.push(r.F); r.s.forEach((v, j) => { if (Number.isFinite(v) && v > 0) m.s[j].push(v) })
    mon.set(k, m)
  }
  const mean = (a) => a.reduce((p, q) => p + q, 0) / (a.length || 1)
  console.log('\n月均回归（N 月 = ' + mon.size + '）')
  for (let j = 2; j < FREQ.length; j++) {
    const xs = [], ys = []
    for (const m of mon.values()) if (m.F.length >= 15 && m.s[j].length >= 15) { xs.push(mean(m.F)); ys.push(mean(m.s[j])) }
    const f = linfit(xs, ys)
    console.log(`  ${FREQ[j] / 1000} GHz: S = ${f.a.toFixed(2)} + ${f.b.toFixed(4)}·F   R²=${f.r2.toFixed(3)} σ=${f.sig.toFixed(1)} N=${f.n}`)
  }
}
console.log('\nJSON', JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { a: +v.a.toFixed(3), b: +v.b.toFixed(5), r2: +v.r2.toFixed(4), sig: +v.sig.toFixed(2), n: v.kept }]))))

// 终值落盘，供 check.mjs（RSTN 交叉验证）与任务书引用
import { writeFileSync } from 'node:fs'
writeFileSync(path.join(HERE, 'coef.json'), JSON.stringify({ fitted: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { a: +v.a.toFixed(3), b: +v.b.toFixed(5), r2: +v.r2.toFixed(4), sig: +v.sig.toFixed(2), n: v.kept }])), days: rows.length, span: [rows[0].date, rows[rows.length - 1].date] }, null, 2))
