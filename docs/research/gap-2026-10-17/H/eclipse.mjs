// 用平台自己的 eclipseFactor + sunEcefApprox 算理想 GEO（115.5°E）2027 年地影季：起止日、日最长地影
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
const att = await import(pathToFileURL(root + '/packages/core/models/attitude.mjs').href)
const A = 42164.17, slot = 115.5 * Math.PI / 180
const r = [A * Math.cos(slot), A * Math.sin(slot), 0]
const t0 = Date.UTC(2027, 0, 1), day = 86400e3, step = 30e3
const days = []
for (let d = 0; d < 365; d++) {
  let ecl = 0, pen = 0, first = null, last = null
  for (let t = t0 + d * day; t < t0 + (d + 1) * day; t += step) {
    const s = att.sunEcefApprox(t); const e = att.eclipseFactor(r, s, { sunDistKm: att.sunDistanceAu(t) * 1.495978707e8 })
    if (e < 1) { if (first == null) first = t; last = t; if (e <= 0) ecl += step / 60e3; else pen += step / 60e3 }
  }
  if (first != null) days.push({ d: new Date(t0 + d * day).toISOString().slice(0, 10), umbra: ecl, pen, mid: new Date((first + last) / 2).toISOString().slice(11, 16) })
}
const seasons = []; let cur = null
for (const x of days) { const dt = Date.parse(x.d); if (!cur || dt - Date.parse(cur.end) > day) { cur = { start: x.d, end: x.d, max: x.umbra + x.pen, maxDay: x.d, n: 1 }; seasons.push(cur) } else { cur.end = x.d; cur.n++; if (x.umbra + x.pen > cur.max) { cur.max = x.umbra + x.pen; cur.maxDay = x.d } } }
for (const s of seasons) console.log(`地影季 ${s.start} → ${s.end}（${s.n} 天），日最长 ${s.max.toFixed(1)} min @ ${s.maxDay}`)
console.log('样例：', days.filter((x, i) => i % 15 === 0).slice(0, 6).map((x) => `${x.d} 本影${x.umbra.toFixed(1)}+半影${x.pen.toFixed(1)}min 中心${x.mid}UTC`).join(' | '))
