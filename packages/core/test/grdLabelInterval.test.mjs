// 等值线数值标签沿线布点（coverage.loopLabelsAtInterval）：SATSOFT Contour Labels 的 Interval。运行：npm test
import assert from 'node:assert'
import { loopLabelsAtInterval, loopLen, loopPointAtFraction } from '../../../src/viz/grd/coverage.js'

let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }

// 赤道上一条水平直线：弧长 = 经度跨度（纬度 0 处经差与纬差同量纲）
const line = (x0, x1, n = 41) => Array.from({ length: n }, (_, i) => [x0 + (x1 - x0) * i / (n - 1), 0])
const L20 = line(0, 20)
ok(Math.abs(loopLen(L20) - 20) < 1e-9, `直线弧长 20°（实得 ${loopLen(L20).toFixed(6)}）`)

// ① 个数 = 弧长 /（标签宽 × 间隔）
for (const [w, k, want] of [[1, 1, 20], [2, 1, 10], [1, 4, 5], [0.5, 8, 5], [1, 3, 6]]) {
  const an = loopLabelsAtInterval(L20, w, k)
  ok(an.length === want, `标签宽 ${w}° × 间隔 ${k} → ${want} 个（实得 ${an.length}）`)
}

// ② 开口链：首尾都不贴端点，间距恒为「标签宽 × 间隔」，余量首尾均摊
{
  const w = 1, k = 3, an = loopLabelsAtInterval(L20, w, k)
  ok(an[0][0] > 0.01 && an[an.length - 1][0] < 19.99, `首尾不贴端点（首 ${an[0][0].toFixed(3)}° 末 ${an[an.length - 1][0].toFixed(3)}°）`)
  let worst = 0
  for (let i = 1; i < an.length; i++) worst = Math.max(worst, Math.abs((an[i][0] - an[i - 1][0]) - w * k))
  ok(worst < 1e-6, `相邻间距恒为 ${w * k}°（最大偏差 ${worst.toExponential(1)}）`)
  const pad0 = an[0][0], pad1 = 20 - an[an.length - 1][0]
  ok(Math.abs(pad0 - pad1) < 1e-6, `首尾余量均摊（${pad0.toFixed(3)} vs ${pad1.toFixed(3)}）`)
}

// ③ 闭合环：n 等分、首个落在半格处（接缝上不压字）
{
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
  const tot = loopLen(sq)
  const an = loopLabelsAtInterval(sq, 1, 10)
  ok(an.length === Math.floor(tot / 10), `闭合环 ${an.length} 个（弧长 ${tot}° / 间隔 10°）`)
  const first = loopPointAtFraction(sq, 0.5 / an.length)
  ok(Math.abs(an[0][0] - first[0]) < 1e-9 && Math.abs(an[0][1] - first[1]) < 1e-9, '首个落在半格处')
  ok(!(Math.abs(an[0][0]) < 1e-9 && Math.abs(an[0][1]) < 1e-9), '首个不压在接缝点上')
}

// ④ 线比一个间隔还短 → 中点标一个（一条线总得认得出是哪一档）
{
  const an = loopLabelsAtInterval(line(0, 2), 1, 35)
  ok(an.length === 1 && Math.abs(an[0][0] - 1) < 1e-9, '短线只在中点标一个')
}

// ⑤ 退化输入不抛
ok(loopLabelsAtInterval(null, 1, 1).length === 0, 'null → 空')
ok(loopLabelsAtInterval([[0, 0]], 1, 1).length === 0, '单点 → 空')
ok(loopLabelsAtInterval(L20, 0, 35).length >= 1, '标签宽 0 → 不除零、至少一个')

console.log(`grdLabelInterval.test.mjs：${pass} 条断言全绿`)
