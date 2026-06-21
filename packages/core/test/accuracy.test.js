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

// 链路预算回归基线（锁定当前实现，防回归）
approx('合成 C/N 回归', r.carrierTotalCN, 9.41, 0.05)
approx('上行 C/N 回归', r.uplinkCN, 17.45, 0.05)
approx('下行 C/N 回归', r.downlinkCN, 10.15, 0.05)
approx('链路余量回归', r.linkmargin, 3.0, 0.01)

ok('NGSO 引擎可用', typeof core.calculateLinkBudgetNGSO === 'function')

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
