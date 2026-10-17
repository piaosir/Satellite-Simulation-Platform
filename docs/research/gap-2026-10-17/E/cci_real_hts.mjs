// 真实 HTS 方向图（用户库 EIRP_OK1.grd，94 波束 igrid=4，181²/0.1°）上的 C/CCI：
// 平台缺省「idx % N 轮转着色」 vs 「按几何复用距离着色」（同仓 synth.colorFreqPlan，与波束合成「自动分配」同一函数）
// 只读：载入已有 .grdbin（grdSampler.loadBin），节点直接取值（不插值），天线角空间内计算（与星位无关）。
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const REPO = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sampler = require(REPO + '/packages/core/utils/grdSampler.js')
const { colorFreqPlan } = await import(pathToFileURL(REPO + '/src/viz/grd/synth.js').href)
const ciCci = require(REPO + '/packages/core/utils/interference/ciCci.js')

const file = process.argv[2] || 'C:/Users/85256/AppData/Roaming/satellite-sim-platform/coverage-grd-imported/EIRP_OK1.grd.grdbin'
const L = sampler.loadBin(fs.readFileSync(file))
const B = L.beams, nb = B.length
const g = B[0].grid
for (const b of B) if (b.grid.NX !== g.NX || b.grid.NY !== g.NY || b.grid.XS !== g.XS || b.grid.YE !== g.YE) throw new Error('各 set 网格不同，本脚本假设公共网格')
const N = g.NX * g.NY
const dx = (g.XE - g.XS) / (g.NX - 1), dy = (g.YE - g.YS) / (g.NY - 1)
console.log(`文件 ${file.split('/').pop()}：${nb} 波束 igrid=${L.igrid} icomp=${L.icomp} 网格 ${g.NX}×${g.NY} 步距 ${dx.toFixed(3)}°`)
// 逐波束 RSS dB（与 C/CCI 缺省 pol='RSS' 同口径）
const db = B.map((b) => { const a = new Float32Array(N); for (let i = 0; i < N; i++) { const p = b.c1re[i] ** 2 + b.c1im[i] ** 2 + b.c2re[i] ** 2 + b.c2im[i] ** 2; a[i] = p > 0 ? 10 * Math.log10(p) : -300 } return a })
const peak = db.map((a) => { let m = -Infinity, k = 0; for (let i = 0; i < N; i++) if (a[i] > m) { m = a[i]; k = i } return { m, k } })
// 波束中心与 −3 dB 等效半径
const nodes = peak.map((p, bi) => {
  const col = p.k % g.NX, row = (p.k / g.NX) | 0
  let cnt = 0; for (let i = 0; i < N; i++) if (db[bi][i] >= p.m - 3) cnt++
  const area = cnt * Math.abs(dx * dy)
  return { az: g.XS + col * dx, el: g.YS + row * dy, r: Math.sqrt(area / Math.PI) }
})
const rMed = nodes.map((n) => n.r).sort((a, b) => a - b)[nb >> 1]
// 最近邻间距中位
const nn = nodes.map((a, i) => { let d = Infinity; nodes.forEach((b, j) => { if (j !== i) d = Math.min(d, Math.hypot(a.az - b.az, a.el - b.el)) }); return d }).sort((a, b) => a - b)
console.log(`−3 dB 等效半径中位 ${rMed.toFixed(3)}°（θ3≈${(2 * rMed).toFixed(3)}°），最近邻中心距中位 ${nn[nb >> 1].toFixed(3)}°`)
const idx = B.map((_, i) => i)
function stats(coloring, label) {
  const out = []; let none = 0, cov = 0
  for (let i = 0; i < N; i++) {
    // 服务区：最强波束 ≥ 其峰值 − 5 dB（剔除覆盖区外的节点）
    let s = -1; for (let b = 0; b < nb; b++) if (s < 0 || db[b][i] > db[s][i]) s = b
    if (db[s][i] < peak[s].m - 5) continue
    cov++
    const vals = db.map((a) => (a[i] > -299 ? a[i] : null))
    const r = ciCci.cciAtPoint(vals, idx, { coloring, floorDb: 60 })
    if (!r || r.cciDb == null) { none++; continue }
    out.push(r.cciDb)
  }
  out.sort((a, b) => a - b)
  const q = (p) => out[Math.min(out.length - 1, Math.floor(out.length * p))]
  console.log(`${label.padEnd(34)} 服务区节点 ${cov}，C/CCI 5%分位 ${q(0.05).toFixed(1)} dB · 中位 ${q(0.5).toFixed(1)} dB · 95%分位 ${q(0.95).toFixed(1)} dB · 无同色 ${none}`)
  return out
}
for (const k of [3, 4, 7]) {
  console.log(`\n== ${k} 色 ==`)
  stats(ciCci.defaultColoring(idx, k), `平台缺省 idx%${k} 轮转`)
  const geo = colorFreqPlan(nodes, k)
  const col = {}; geo.colors.forEach((c, i) => { col[i] = c })
  stats(col, `几何复用距离着色（冲突 ${geo.conflicts} 对）`)
}
