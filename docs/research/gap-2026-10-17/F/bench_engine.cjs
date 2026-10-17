// F 路验证：单线程引擎吞吐（为参数化研究 / Monte Carlo 的执行层定量级）。只读仓库，不写任何文件。
// 用法：node bench_engine.cjs <repoRoot>
'use strict'
const path = require('path')
const repo = process.argv[2]
const core = require(path.join(repo, 'packages/core/index.js'))

const quiet = (fn) => {
  const o = { log: console.log, info: console.info, debug: console.debug, warn: console.warn }
  console.log = console.info = console.debug = console.warn = () => {}
  try { return fn() } finally { Object.assign(console, o) }
}
const sat = { frequencyBand: 'Ku', satelliteName: 'BENCH' }
const link = {}
function bench(label, n, fn) {
  quiet(() => { for (let i = 0; i < 50; i++) fn(i) })   // 预热
  const t0 = process.hrtime.bigint()
  let ok = 0
  quiet(() => { for (let i = 0; i < n; i++) { const r = fn(i); if (r && r.success) ok++ } })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`${label}: n=${n} ok=${ok} total=${ms.toFixed(1)} ms  per-run=${(ms / n).toFixed(4)} ms  runs/s=${Math.round(n / (ms / 1000))}`)
  return ms / n
}

const r0 = quiet(() => core.computeLinkMode(sat, link, { mode: 'margin' }))
console.log('baseline success =', r0 && r0.success, ' marginResult =', r0 && r0.data && r0.data.marginResult, ' fields =', r0 && r0.data ? Object.keys(r0.data).length : 0)

const pm = bench('GEO margin', 5000, (i) => core.computeLinkMode(sat, Object.assign({}, link, { margin: String(3 + (i % 10) * 0.1) }), { mode: 'margin' }))
const pb = bench('GEO balance', 2000, () => core.computeLinkMode(sat, link, { mode: 'balance' }))
const pp = bench('GEO power(10W)', 2000, () => core.computeLinkMode(sat, link, { mode: 'power', powerW: 10 }))

// linkSweep 一维（主进程 IPC link:sweep 同一函数）：当前上限 MAX_STEPS
try {
  const spec = { engine: 'geo', sat, link, opt: { mode: 'margin' }, axis: { key: 'margin', from: 0, to: 10, steps: 200 } }
  const t0 = process.hrtime.bigint()
  const s = quiet(() => core.sweepLink(spec))
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`sweepLink 200 pts: ok=${s.ok} fail=${s.fail} msg=${s.message || ''} total=${ms.toFixed(1)} ms; MAX_STEPS=${core.linkSweep ? core.linkSweep.MAX_STEPS : 'n/a'}`)
} catch (e) { console.log('sweepLink error:', e.message) }

// 量级外推：10^4 / 10^5 次 Monte Carlo 在单线程上的耗时（不含几何 / 传播重算）
for (const [lbl, p] of [['margin', pm], ['balance', pb]]) {
  console.log(`extrapolate ${lbl}: 1e4 runs ≈ ${(p * 1e4 / 1000).toFixed(1)} s, 1e5 runs ≈ ${(p * 1e5 / 1000).toFixed(1)} s (single thread, blocks Electron main process if run there)`)
}
