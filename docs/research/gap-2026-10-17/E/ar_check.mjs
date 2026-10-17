// 轴比 AR 口径核对：coverage.axialRatioDb 的 icomp 分支 vs GRD 权威定义（icomp 2 = RHC/LHC 圆极化基；3 = Ludwig-3 线极化 co/cx）
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const REPO = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const { axialRatioDb } = await import(pathToFileURL(REPO + '/src/viz/grd/coverage.js').href)
const sampler = require(REPO + '/packages/core/utils/grdSampler.js')
for (const f of ['EIRP_OK1.grd.grdbin', '300_X02G_EIRP.grd.grdbin']) {
  const L = sampler.loadBin(fs.readFileSync('C:/Users/85256/AppData/Roaming/satellite-sim-platform/coverage-grd-imported/' + f))
  const b = L.beams[0], n = b.grid.NX * b.grid.NY
  let best = -1, k = 0; for (let i = 0; i < n; i++) { const t = b.c1re[i] ** 2 + b.c1im[i] ** 2 + b.c2re[i] ** 2 + b.c2im[i] ** 2; if (t > best) { best = t; k = i } }
  const comp = { re1: b.c1re[k], im1: b.c1im[k], re2: b.c2re[k], im2: b.c2im[k] }
  const p1 = comp.re1 ** 2 + comp.im1 ** 2, p2 = comp.re2 ** 2 + comp.im2 ** 2
  // 圆极化基下的真值：AR = (|E1|+|E2|)/||E1|−|E2||
  const a = Math.sqrt(p1), c = Math.sqrt(p2), arCirc = 20 * Math.log10((a + c) / Math.abs(a - c))
  console.log(`${f}: icomp=${L.icomp}，峰值处 P1/P2=${(10 * Math.log10(p1 / p2)).toFixed(2)} dB；平台 axialRatioDb(comp, icomp)=${axialRatioDb(comp, L.icomp)?.toFixed(2)} dB；按圆极化基真值=${arCirc.toFixed(3)} dB；若按 icomp=3 分支=${axialRatioDb(comp, 3)?.toFixed(3)} dB`)
}
// 平台合成 GRD（icomp=3、分量2≡0）＝纯共极化 Ludwig-3 线极化 → 真 AR=∞（60 封顶）
console.log('合成件 icomp=3、c2≡0：平台 AR =', axialRatioDb({ re1: 1, im1: 0, re2: 0, im2: 0 }, 3), 'dB（Ludwig-3 线极化纯共极化的真值应为 ∞/60 封顶）')
