// 续：同批窄波束换成「圆口径 parabolic-on-pedestal 远场」复制品（同峰值、同 θ3，不截窗），看与真实 GRD 的接近程度
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const REPO = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sampler = require(REPO + '/packages/core/utils/grdSampler.js')
const ciCci = require(REPO + '/packages/core/utils/interference/ciCci.js')
const { colorFreqPlan } = await import(pathToFileURL(REPO + '/src/viz/grd/synth.js').href)
const J = (n, x) => { const M = 2000, h = Math.PI / M; let s = 0; for (let i = 0; i <= M; i++) { const t = i * h, w = (i === 0 || i === M) ? 1 : (i % 2 ? 4 : 2); s += w * Math.cos(n * t - x * Math.sin(t)) } return s * h / 3 / Math.PI }
function pedTab(Tdb) { const p = Math.pow(10, Tdb / 20), q = 1 - p
  const F = (u) => { const l1 = Math.abs(u) < 1e-6 ? 1 : 2 * J(1, u) / u, l2 = Math.abs(u) < 1e-6 ? 1 : 8 * J(2, u) / (u * u); return (2 * p * l1 + q * l2) / (2 * p + q) }
  let lo = 0.5, hi = 3.5; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (F(m) ** 2 > 0.5) lo = m; else hi = m } const uh = (lo + hi) / 2
  const T = new Float64Array(3001); for (let i = 0; i <= 3000; i++) { const f = F(uh * 2 * (i / 200)); T[i] = 10 * Math.log10(Math.max(f * f, 1e-9)) }
  return (r) => { const x = r * 200, i = Math.floor(x); if (i >= 3000) return T[3000]; const t = x - i; return T[i] * (1 - t) + T[i + 1] * t } }
const L = sampler.loadBin(fs.readFileSync(process.argv[2]))
const g = L.beams[0].grid, N = g.NX * g.NY, dx = (g.XE - g.XS) / (g.NX - 1), dy = (g.YE - g.YS) / (g.NY - 1)
const all = L.beams.map((b) => { const a = new Float32Array(N); for (let i = 0; i < N; i++) { const p = b.c1re[i] ** 2 + b.c1im[i] ** 2 + b.c2re[i] ** 2 + b.c2im[i] ** 2; a[i] = p > 0 ? 10 * Math.log10(p) : -300 } return a })
const inf = all.map((a) => { let m = -Infinity, k = 0; for (let i = 0; i < N; i++) if (a[i] > m) { m = a[i]; k = i } let c = 0; for (let i = 0; i < N; i++) if (a[i] >= m - 3) c++; return { m, k, az: g.XS + (k % g.NX) * dx, el: g.YS + ((k / g.NX) | 0) * dy, r: Math.sqrt(c * Math.abs(dx * dy) / Math.PI) } })
const sel = inf.map((x, i) => i).filter((i) => inf[i].r < 0.5)
const real = sel.map((i) => all[i]), idx = sel.map((_, j) => j)
const replica = (pat) => sel.map((i) => { const q = inf[i], th = 2 * q.r, a = new Float32Array(N); for (let n = 0; n < N; n++) { const X = g.XS + (n % g.NX) * dx, Y = g.YS + ((n / g.NX) | 0) * dy; a[n] = q.m + pat(Math.hypot(X - q.az, Y - q.el) / th) } return a })
function run(set, coloring) { const out = []; for (let n = 0; n < N; n++) { let s = -1; for (let b = 0; b < real.length; b++) if (s < 0 || real[b][n] > real[s][n]) s = b; if (real[s][n] < inf[sel[s]].m - 4) continue; const r = ciCci.cciAtPoint(set.map((a) => (a[n] > -299 ? a[n] : null)), idx, { coloring, floorDb: 60 }); out.push(r && r.cciDb != null ? r.cciDb : Infinity) } out.sort((a, b) => a - b); const q = (p) => out[Math.min(out.length - 1, Math.floor(out.length * p))]; const f = (v) => Number.isFinite(v) ? v.toFixed(1) : '无同色'; return `5% ${f(q(0.05))} · 中位 ${f(q(0.5))} · 95% ${f(q(0.95))} dB` }
for (const k of [4, 7]) {
  const geo = colorFreqPlan(sel.map((i) => inf[i]), k); const col = {}; geo.colors.forEach((c, j) => { col[j] = c })
  console.log(`\n== ${k} 色 ==`)
  console.log('真实 GRD               ', run(real, col))
  for (const T of [-10, -14, -18]) console.log(`口径锥度 ${T} dB 复制品  `, run(replica(pedTab(T)), col))
}
