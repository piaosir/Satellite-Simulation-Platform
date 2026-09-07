// 日凌引擎回归（utils/sunOutageCalculator.js）：日内插值 + 赤纬预筛之后的结果，与改算法前逐秒全算的原版
// 输出（fixtures/sunOutage.golden.json，2026-09-07 抓的 8 季 90 天）逐日对拍。
// 判据：天数与日期逐日相同；起止 / 峰值时刻差 ≤ 1 s（求根容差 0.5 s 的量级）；时长差 ≤ 1 s；
//       峰值恶化差 ≤ 0.01 dB；分点日门限角 / 波束宽逐位相同（这两项不经插值）。
// 另验：卫星在地平线下报错不算；长事件季（小口径 C 频段）预筛不会把事件筛没、逐日连续。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { calculateSunOutage } = require('../utils/sunOutageCalculator.js')
const G = JSON.parse(readFileSync(path.join(HERE, 'fixtures/sunOutage.golden.json'), 'utf8'))
const sec = (s) => { const [h, m, x] = s.split(':').map(Number); return h * 3600 + m * 60 + x }
const dayNo = (d) => { const [y, m, x] = d.split('-').map(Number); return Date.UTC(y, m - 1, x) / 86400e3 }

let n = 0, worst = 0, ms = 0
for (const g of G) {
  const { days, season, thr, bw, maxDur, ...k } = g
  const tag = `${k.lat},${k.lon}→${k.satLon} ${k.diameter}m ${season}`
  const t0 = process.hrtime.bigint()
  const r = calculateSunOutage({ ...k, degThreshold: 1, year: 2026, season })
  ms += Number(process.hrtime.bigint() - t0) / 1e6
  assert.equal(r.error, false, tag)
  assert.equal(r.dailyResults.length, days.length, tag + ' 天数')
  assert.equal(r.thresholdAngle, thr, tag + ' 门限角')
  assert.equal(r.beamWidth, bw, tag + ' 波束宽')
  assert.ok(Math.abs(r.maxDurationSec - maxDur) <= 1, tag + ' 最长时长')
  days.forEach((d, i) => {
    const q = r.dailyResults[i]
    assert.equal(q.date, d[0], tag + ' 日期')
    for (const [a, b] of [[q.startTimeUTC, d[1]], [q.endTimeUTC, d[2]], [q.peakTimeUTC, d[3]]]) {
      const dt = Math.abs(sec(a) - sec(b))
      worst = Math.max(worst, dt)
      assert.ok(dt <= 1, `${tag} ${d[0]} 时刻差 ${dt}s`)
    }
    assert.ok(Math.abs(q.durationSec - d[4]) <= 1, `${tag} ${d[0]} 时长差`)
    assert.ok(Math.abs(q.peakCNdeg - d[5]) <= 0.01 + 1e-9, `${tag} ${d[0]} 峰值恶化差`)
    n++
  })
}

// 卫星在地平线下：报错，不出结果
assert.equal(calculateSunOutage({ lat: 70, lon: 0, satLon: 180, diameter: 2.4, customFreq: 12.5, sysTemp: 150, year: 2026, season: 'vernal' }).error, true)

// 长事件季：预筛不能把事件筛没，且事件日逐日连续（中间不许出现被误筛掉的空洞）
{
  const r = calculateSunOutage({ lat: 30, lon: 120, satLon: 110.5, diameter: 0.6, customFreq: 3.95, sysTemp: 80, year: 2026, season: 'autumnal' })
  assert.equal(r.error, false)
  assert.ok(r.totalDays >= 20, '0.6 m C 频段秋分季应有 20 天以上事件，实得 ' + r.totalDays)
  for (let i = 1; i < r.dailyResults.length; i++) {
    assert.equal(dayNo(r.dailyResults[i].date) - dayNo(r.dailyResults[i - 1].date), 1, '事件日不连续：' + r.dailyResults[i - 1].date + ' → ' + r.dailyResults[i].date)
  }
  // 窗口内的物理约束：峰值恶化 ≥ 门限 1 dB、峰值时刻落在起止之间
  for (const d of r.dailyResults) {
    assert.ok(d.peakCNdeg >= 1 - 1e-6, d.date + ' 峰值恶化 ' + d.peakCNdeg)
    assert.ok(sec(d.startTimeUTC) <= sec(d.peakTimeUTC) && sec(d.peakTimeUTC) <= sec(d.endTimeUTC), d.date + ' 峰值时刻越界')
  }
}

console.log(`sunOutage: ${G.length} 季 ${n} 天逐日对拍通过，最坏时刻差 ${worst}s，均 ${(ms / G.length).toFixed(1)} ms/季`)
