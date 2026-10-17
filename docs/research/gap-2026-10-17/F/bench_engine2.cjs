'use strict'
// 带雨衰（可用度 99.9%）与站址的单次耗时 + sweepLink 一维（正确 spec）
const path = require('path')
const repo = process.argv[2]
const core = require(path.join(repo, 'packages/core/index.js'))
const quiet = (fn) => { const o = { log: console.log, info: console.info, debug: console.debug, warn: console.warn }; console.log = console.info = console.debug = console.warn = () => {}; try { return fn() } finally { Object.assign(console, o) } }
const sat = { frequencyBand: 'Ku', satelliteName: 'BENCH', orbitPosition: '110.5' }
const link = { longitude: '116.4', latitude: '39.9', rxLongitude: '121.5', rxLatitude: '31.2', uplinkAvailability: '99.9', rxDownlinkAvailability: '99.9', rainRate: '40', rxRainRate: '50' }
function bench(label, n, fn) {
  quiet(() => { for (let i = 0; i < 30; i++) fn(i) })
  const t0 = process.hrtime.bigint(); let ok = 0, last = null
  quiet(() => { for (let i = 0; i < n; i++) { const r = fn(i); if (r && r.success) ok++; last = r } })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`${label}: n=${n} ok=${ok} per-run=${(ms / n).toFixed(4)} ms runs/s=${Math.round(n / (ms / 1000))}`)
  return last
}
const r = bench('GEO margin + rain 99.9%', 2000, () => core.computeLinkMode(sat, link, { mode: 'margin' }))
if (r && r.data) console.log('  rain up/down =', r.data.uplinkRainAttenuation, '/', r.data.downlinkRainAttenuationResult || r.data.rxRainAttenuationResult)
bench('GEO balance + rain 99.9%', 1000, () => core.computeLinkMode(sat, link, { mode: 'balance' }))
const spec = { engine: 'geo', satParams: sat, linkParams: link, opt: { mode: 'margin' }, x: { key: 'antennaDiameter', target: 'link', min: 1.2, max: 9, steps: 400 } }
const t0 = process.hrtime.bigint()
const s = quiet(() => core.sweepLink(spec))
const ms = Number(process.hrtime.bigint() - t0) / 1e6
console.log(`sweepLink 400 pts (antennaDiameter): ok=${s.ok} fail=${s.fail} msg=${s.message || ''} total=${ms.toFixed(1)} ms, outputs=${Object.keys(s.series || {}).length}`)
