import { createRequire } from 'node:module'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const REPO = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const { axialRatioDb } = await import(pathToFileURL(REPO + '/src/viz/grd/coverage.js').href)
const sampler = require(REPO + '/packages/core/utils/grdSampler.js')
const L = sampler.loadBin(fs.readFileSync('C:/Users/85256/AppData/Roaming/satellite-sim-platform/coverage-grd-imported/300_X02G_EIRP.grd.grdbin'))
const b = L.beams[0], n = b.grid.NX * b.grid.NY
let best = -1, k = 0; for (let i = 0; i < n; i++) { const t = b.c1re[i] ** 2 + b.c1im[i] ** 2 + b.c2re[i] ** 2 + b.c2im[i] ** 2; if (t > best) { best = t; k = i } }
const comp = { re1: b.c1re[k], im1: b.c1im[k], re2: b.c2re[k], im2: b.c2im[k] }
console.log('300_X02G icomp=' + L.icomp + '（Ludwig-3 线极化基）峰值处：按线极化基 Stokes 求得 AR =', axialRatioDb(comp, 1).toFixed(2), 'dB；平台按 icomp=3 分支给出', axialRatioDb(comp, 3).toFixed(3), 'dB')
