// ACM 时间加权频谱效率 vs 固定 MODCOD（按 99.7% 可用度选档）的量级：平台自己的 P.618 + DVB-S2X 表
const path = require('path'); const root = process.argv[2]
const R = require(path.join(root, 'packages/core/utils/rainAttenuation.js'))
const C = require(path.join(root, 'packages/core/utils/constants.js'))
const tab = C.DVBS2X_MODCOD_TABLE.map((r) => { const [a, b] = String(r.fec).split('/').map(Number); const m = { BPSK: 1, QPSK: 2, '8PSK': 3, '8APSK': 3, '16APSK': 4, '32APSK': 5, '64APSK': 6, '128APSK': 7, '256APSK': 8 }[String(r.modulation).replace(/-L$/, '')] || NaN; return { lab: r.label, th: r.threshold, se: m * a / b } }).filter((r) => Number.isFinite(r.se) && Number.isFinite(r.th)).sort((x, y) => x.th - y.th)
const best = (esno) => { let b = null; for (const r of tab) if (r.th <= esno && (!b || r.se > b.se)) b = r; return b }
const site = { lat: 23.13, lon: 113.26, satLon: 125, freq: 19.7, pol: 'C', diameter: 0.75, efficiency: 60, systemNoiseTemp: 250, direction: 'down' }
const ps = []; for (let lg = -3; lg <= Math.log10(50); lg += 0.02) ps.push(Math.pow(10, lg))   // 0.001% … 50%
const dnd = (p) => { const r = R.calculateRainAttenuation({ ...site, availability: 100 - p }); return r.dnd }
for (const clear of [10, 14, 18]) {
  // 时间加权：p 档之间按前向差（取更深那一端），p>50% 视作晴空
  let acc = 0, prevP = 0
  const pts = ps.map((p) => ({ p, d: dnd(p) }))
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i].p, w = (p - prevP) / 100; const b = best(clear - pts[i].d); acc += w * (b ? b.se : 0); prevP = p
  }
  const bClear = best(clear); acc += (1 - prevP / 100) * (bClear ? bClear.se : 0)
  const fix = best(clear - dnd(0.3))
  console.log(`晴空 Es/N0 ${clear} dB：ACM 年均频谱效率 ${acc.toFixed(3)} b/sym；固定档(99.7%) ${fix ? fix.lab + ' ' + fix.se.toFixed(3) : '无'}；比值 ${fix ? (acc / fix.se).toFixed(2) : '—'}×；晴空档 ${bClear.lab} ${bClear.se.toFixed(3)}`)
}
console.log('DND(0.3%)=', dnd(0.3).toFixed(2), 'dB  DND(0.01%)=', dnd(0.01).toFixed(2), 'dB')
