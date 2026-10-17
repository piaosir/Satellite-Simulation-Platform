// 真实 HTS 窄波束：覆盖边缘（服务波束 峰值−4…−3 dB 带）在指向误差圆（半径 e）上的最差增益跌落
import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire(import.meta.url)
const sampler = require('C:/Users/85256/WeChatProjects/卫星仿真平台/packages/core/utils/grdSampler.js')
const L = sampler.loadBin(fs.readFileSync(process.argv[2]))
const g = L.beams[0].grid, NX = g.NX, NY = g.NY, N = NX * NY, dx = (g.XE - g.XS) / (NX - 1), dy = (g.YE - g.YS) / (NY - 1)
const all = L.beams.map((b) => { const a = new Float32Array(N); for (let i = 0; i < N; i++) { const p = b.c1re[i] ** 2 + b.c1im[i] ** 2 + b.c2re[i] ** 2 + b.c2im[i] ** 2; a[i] = p > 0 ? 10 * Math.log10(p) : -300 } return a })
const pk = all.map((a) => { let m = -Infinity; for (let i = 0; i < N; i++) if (a[i] > m) m = a[i]; let c = 0; for (let i = 0; i < N; i++) if (a[i] >= m - 3) c++; return { m, r: Math.sqrt(c * Math.abs(dx * dy) / Math.PI) } })
const sel = pk.map((x, i) => i).filter((i) => pk[i].r < 0.5)
const bil = (a, fc, fr) => { const c0 = Math.floor(fc), r0 = Math.floor(fr); if (c0 < 0 || r0 < 0 || c0 >= NX - 1 || r0 >= NY - 1) return null; const tx = fc - c0, ty = fr - r0; const v = (c, r) => Math.pow(10, a[r * NX + c] / 10); const p = v(c0, r0) * (1 - tx) * (1 - ty) + v(c0 + 1, r0) * tx * (1 - ty) + v(c0, r0 + 1) * (1 - tx) * ty + v(c0 + 1, r0 + 1) * tx * ty; return 10 * Math.log10(p) }
for (const e of [0.05, 0.1, 0.15]) {
  const drops = []
  for (let n = 0; n < N; n++) {
    let s = -1; for (const b of sel) if (s < 0 || all[b][n] > all[s][n]) s = b
    const v = all[s][n]; if (v < pk[s].m - 4 || v > pk[s].m - 3) continue
    const c = n % NX, r = (n / NX) | 0
    let mn = v
    for (let k = 0; k < 24; k++) { const t = 2 * Math.PI * k / 24; const w = bil(all[s], c + e * Math.cos(t) / Math.abs(dx), r + e * Math.sin(t) / Math.abs(dy)); if (w != null && w < mn) mn = w }
    drops.push(mn - v)
  }
  drops.sort((a, b) => a - b)
  const q = (p) => drops[Math.min(drops.length - 1, Math.floor(drops.length * p))]
  console.log(`指向误差半径 ${e}°：边缘带 ${drops.length} 点，最差增益跌落 中位 ${q(0.5).toFixed(2)} dB · 最坏 5% ${q(0.05).toFixed(2)} dB`)
}
