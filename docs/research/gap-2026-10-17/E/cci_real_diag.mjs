import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire(import.meta.url)
const REPO = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sampler = require(REPO + '/packages/core/utils/grdSampler.js')
const file = process.argv[2]
const L = sampler.loadBin(fs.readFileSync(file))
const B = L.beams, nb = B.length, g = B[0].grid, N = g.NX * g.NY
const dx = (g.XE - g.XS) / (g.NX - 1), dy = (g.YE - g.YS) / (g.NY - 1)
const db = B.map((b) => { const a = new Float32Array(N); for (let i = 0; i < N; i++) { const p = b.c1re[i] ** 2 + b.c1im[i] ** 2 + b.c2re[i] ** 2 + b.c2im[i] ** 2; a[i] = p > 0 ? 10 * Math.log10(p) : -300 } return a })
const info = db.map((a, bi) => { let m = -Infinity, k = 0; for (let i = 0; i < N; i++) if (a[i] > m) { m = a[i]; k = i } let cnt = 0; for (let i = 0; i < N; i++) if (a[i] >= m - 3) cnt++; return { bi, m, az: g.XS + (k % g.NX) * dx, el: g.YS + ((k / g.NX) | 0) * dy, r: Math.sqrt(cnt * Math.abs(dx * dy) / Math.PI) } })
const nn = info.map((a) => { let d = Infinity, j0 = -1; info.forEach((b) => { if (b.bi !== a.bi) { const t = Math.hypot(a.az - b.az, a.el - b.el); if (t < d) { d = t; j0 = b.bi } } }); return { bi: a.bi, d, j0 } }).sort((a, b) => a.d - b.d)
console.log('最近邻最小 10 对：', nn.slice(0, 10).map((x) => `${x.bi + 1}-${x.j0 + 1}:${x.d.toFixed(2)}°`).join(' '))
const rs = info.map((x) => x.r).sort((a, b) => a - b)
console.log('−3dB 等效半径 分位 min/25/50/75/max：', [0, 0.25, 0.5, 0.75, 1].map((p) => rs[Math.min(nb - 1, Math.floor(p * nb))].toFixed(3)).join(' / '))
const pk = info.map((x) => x.m).sort((a, b) => a - b)
console.log('峰值 EIRP 分位 min/50/max：', pk[0].toFixed(1), pk[nb >> 1].toFixed(1), pk[nb - 1].toFixed(1))
// 共极化分量判别（峰值处哪个分量占优）
let co1 = 0, co2 = 0
for (const b of B) { let best = -1, bi = 0; const n = N; for (let i = 0; i < n; i++) { const t = b.c1re[i] ** 2 + b.c1im[i] ** 2 + b.c2re[i] ** 2 + b.c2im[i] ** 2; if (t > best) { best = t; bi = i } } const p1 = b.c1re[bi] ** 2 + b.c1im[bi] ** 2, p2 = b.c2re[bi] ** 2 + b.c2im[bi] ** 2; if (p2 > p1) co2++; else co1++ }
console.log(`共极化分量：P1 占优 ${co1} 束，P2 占优 ${co2} 束（icomp=${L.icomp}，2=RHC/LHC）`)
