// 精度/回归测试（无框架，纯断言）。运行： npm test
// 既做几何自洽校验，也锁定当前引擎输出作为回归基线；后续可加 ITU-R 官方算例对照。
const core = require('../index.js')

let pass = 0, fail = 0
function approx(name, got, want, tol) {
  const g = parseFloat(got)
  const ok = Number.isFinite(g) && Math.abs(g - want) <= tol
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + `  (got=${g}, want≈${want} ±${tol})`)
  ok ? pass++ : fail++
}
function ok(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name)
  cond ? pass++ : fail++
}

console.log('=== satlink-core 精度/回归测试 ===\n')

const res = core.calculateLinkBudget({ frequencyBand: 'Ku', satelliteName: 'DEMO' }, {})
ok('GEO 计算成功', res.success)
const r = res.data

// 几何自洽
approx('GEO 仰角(北京→110.5°E)', r.elevationResult, 43.43, 0.3)
approx('GEO 斜距', r.slantRangeResult, 37524, 80)
approx('单向时延', r.linkDelayResult, 250.3, 2)
ok('上行FSL > 下行FSL(上行频率更高)', parseFloat(r.uplinkFSLResult) > parseFloat(r.downlinkFSLResult))

// 星下点几何：站点位于星下点，仰角应≈90°
const sub = core.calculateSatelliteAngle(0, 110.5, 110.5)
approx('星下点正下方仰角≈90°', sub.elevation, 90, 1.0)

// 链路预算回归基线（锁定当前实现，防回归）。
// 2026-07 重锁：本用例以空 linkParams 调引擎，走的是「空值回退默认」路径。已把回退常数对齐字段默认
// （发信站口径 7.3→6.2m、馈线 0.2→3.5dB、收信站口径 1.2→3.7m、SFDref -82→-84 等），故此默认配置下
// 上行 C/N 随发信站口径变小+馈线加大而降、下行 C/N 随收信站口径变大而升，基线相应更新。
approx('合成 C/N 回归', r.carrierTotalCN, 9.91, 0.05)
approx('上行 C/N 回归', r.uplinkCN, 12.86, 0.05)
approx('下行 C/N 回归', r.downlinkCN, 12.97, 0.05)
approx('链路余量回归', r.linkmargin, 3.0, 0.01)

ok('NGSO 引擎可用', typeof core.calculateLinkBudgetNGSO === 'function')

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
