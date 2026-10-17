// 同一批真实 HTS 窄波束（EIRP_OK1 中 −3dB 等效半径 <0.5° 的那些）：真实方向图 vs 平台「多馈源组」高斯复制品
// （同峰值、同等效 θ3、−12.0412(θ/θ3)²、地板 −50、矩形窗半宽 1.8θ3 外=null —— buildGaussGrd 同式）下的 C/CCI 分布
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const REPO = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sampler = require(REPO + '/packages/core/utils/grdSampler.js')
const ciCci = require(REPO + '/packages/core/utils/interference/ciCci.js')
const { colorFreqPlan } = await import(pathToFileURL(REPO + '/src/viz/grd/synth.js').href)
const L = sampler.loadBin(fs.readFileSync(process.argv[2]))
const g = L.beams[0].grid, N = g.NX * g.NY, dx = (g.XE - g.XS) / (g.NX - 1), dy = (g.YE - g.YS) / (g.NY - 1)
const all = L.beams.map((b) => { const a = new Float32Array(N); for (let i = 0; i < N; i++) { const p = b.c1re[i] ** 2 + b.c1im[i] ** 2 + b.c2re[i] ** 2 + b.c2im[i] ** 2; a[i] = p > 0 ? 10 * Math.log10(p) : -300 } return a })
const inf = all.map((a) => { let m = -Infinity, k = 0; for (let i = 0; i < N; i++) if (a[i] > m) { m = a[i]; k = i } let c = 0; for (let i = 0; i < N; i++) if (a[i] >= m - 3) c++; return { m, k, az: g.XS + (k % g.NX) * dx, el: g.YS + ((k / g.NX) | 0) * dy, r: Math.sqrt(c * Math.abs(dx * dy) / Math.PI) } })
const sel = inf.map((x, i) => i).filter((i) => inf[i].r < 0.5)
console.log(`窄波束 ${sel.length} 个，θ3 中位 ${(2 * inf[sel[sel.length >> 1]].r).toFixed(3)}°`)
const real = sel.map((i) => all[i])
const gaussOf = (win) => sel.map((i) => { const q = inf[i], th = 2 * q.r, a = new Float32Array(N)
  for (let n = 0; n < N; n++) { const X = g.XS + (n % g.NX) * dx, Y = g.YS + ((n / g.NX) | 0) * dy, ox = X - q.az, oy = Y - q.el
    if (win && (Math.abs(ox) > 1.8 * th || Math.abs(oy) > 1.8 * th)) { a[n] = -300; continue }
    let rel = -12.0412 * (ox * ox + oy * oy) / (th * th); if (win && rel < -50) rel = -50; a[n] = q.m + rel }
  return a })
const G1 = gaussOf(true), G2 = gaussOf(false)
const idx = sel.map((_, j) => j)
function run(set, coloring) {
  const out = []; let none = 0
  for (let n = 0; n < N; n++) {
    let s = -1; for (let b = 0; b < real.length; b++) if (s < 0 || real[b][n] > real[s][n]) s = b
    if (real[s][n] < inf[sel[s]].m - 4) continue            // 服务区 = 真实方向图最强窄波束 ≥ 峰值 − 4 dB（与哪种模型无关，同一批节点）
    const vals = set.map((a) => (a[n] > -299 ? a[n] : null))
    const r = ciCci.cciAtPoint(vals, idx, { coloring, floorDb: 60 })
    if (!r || r.cciDb == null) { none++; out.push(Infinity); continue }
    out.push(r.cciDb)
  }
  out.sort((a, b) => a - b)
  const q = (p) => out[Math.min(out.length - 1, Math.floor(out.length * p))]
  const f = (v) => Number.isFinite(v) ? v.toFixed(1) : '无同色'
  return `5% ${f(q(0.05))} · 中位 ${f(q(0.5))} · 95% ${f(q(0.95))} dB · 无同色 ${(100 * none / out.length).toFixed(0)}%`
}
for (const k of [4, 7]) {
  const geo = colorFreqPlan(sel.map((i) => inf[i]), k); const col = {}; geo.colors.forEach((c, j) => { col[j] = c })
  console.log(`\n== ${k} 色（几何着色，冲突 ${geo.conflicts} 对）==`)
  console.log('真实 GRD 方向图              ', run(real, col))
  console.log('平台高斯复制品（窗1.8θ3/地板−50）', run(G1, col))
  console.log('纯高斯（不截窗）              ', run(G2, col))
}
