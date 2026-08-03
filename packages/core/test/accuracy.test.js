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
// 2026-07-25 再锁：科学性修正——云噪声温度按吸收/辐射自洽计入系统噪温（默认场景 ΔT≈20.4 K，
// G/T 降 ~0.68 dB → 分配口径下 上行 C/N 12.86→12.99、下行 12.97→12.84）；雨噪介质温度 273.15→275 K。
// 合成 C/N 与链路余量为目标值构造，不随链路参数变，保持不动。
approx('合成 C/N 回归', r.carrierTotalCN, 9.91, 0.05)
approx('上行 C/N 回归', r.uplinkCN, 12.99, 0.05)
approx('下行 C/N 回归', r.downlinkCN, 12.84, 0.05)
approx('链路余量回归', r.linkmargin, 3.0, 0.01)

ok('NGSO 引擎可用', typeof core.calculateLinkBudgetNGSO === 'function')

// 圆极化两套写法必须同口径：链路预算三窗的极化下拉存 'L'/'R'，早期配置与雨衰页存 'LHCP'/'RHCP'。
// 只认后者时 'L'/'R' 会掉进线极化分支（τ 取极化偏转角而非 45°），P.618-14 §4.1 的雨致 XPD 虚高十几 dB。
const POL_IN = {
  rainRate: 60, uplinkAvailability: 99.5, rxRainRate: 60, rxDownlinkAvailability: 99.5,
  orbitAltitude: 1200, rxOrbitAltitude: 1200
}
const POL_KEYS = ['uplinkRainXPDResult', 'downlinkRainXPDResult',
  'effectiveXpolUplinkFactorResult', 'effectiveXpolDownlinkFactorResult',
  'uplinkCN', 'downlinkCN', 'carrierTotalCN',
  'uplinkPolarizationAngleResult', 'downlinkPolarizationAngleResult']
function polRun(calc, pol) {
  const rr = calc({ frequencyBand: 'Ku', satelliteName: 'DEMO' },
    Object.assign({}, POL_IN, { uplinkPolarization: pol }))
  return rr.success ? rr.data : null
}
for (const [engName, calc] of [['GEO', core.calculateLinkBudget], ['NGSO', core.calculateLinkBudgetNGSO]]) {
  for (const [short, long] of [['L', 'LHCP'], ['R', 'RHCP']]) {
    const a = polRun(calc, short), b = polRun(calc, long)
    ok(`${engName} 极化 ${short} 与 ${long} 结果逐位一致`,
      !!a && !!b && POL_KEYS.every(k => String(a[k]) === String(b[k])))
  }
  // 显示值不被归一化改写（报表照原样出 L/R）
  ok(`${engName} 极化显示值保持 L`, (polRun(calc, 'L') || {}).uplinkPolarizationResult === 'L')
  // 圆极化 τ=45° 的 XPD 必须低于线极化 —— 归一化真的落到了 XPD 算式上
  const cir = polRun(calc, 'L'), lin = polRun(calc, 'V')
  ok(`${engName} 圆极化雨致 XPD 低于线极化`,
    !!cir && !!lin && parseFloat(cir.uplinkRainXPDResult) < parseFloat(lin.uplinkRainXPDResult) - 8)
}

// 调制因子必须取 constants.js 那份（面板下拉与 MODCOD 预设表同源）。引擎曾各抄一份且漏了 '64QAM'，
// 查表落空回退 QPSK：3GPP NR-NTN 的 MCS17–28 全是 64QAM，符号率/带宽错 3 倍、Es/N₀→Eb/N₀ 折算错 4.77 dB。
// 余量因门限与实际同错而抵消，界面看着正常 —— 故此处锁的是符号率与调制因子本身，不是余量。
// orbitAltitude 两项是 NGSO 引擎的必填几何（GEO 引擎不读），与调制口径无关
const MOD_IN = { infoRate: 2048, fec: '438/1024', rsCode: '0.9', bandwidthFactor: 1.1, m: 1, noiseRatioMode: 'esno', ebno: 12.79,
  orbitAltitude: 1200, rxOrbitAltitude: 1200 }
const modRun = (calc, mod) => {
  const rr = calc({}, Object.assign({}, MOD_IN, { modulation: mod }))
  return rr.success ? rr.data : null
}
const MOD_KEYS = ['modulationFactorResult', 'symbolRateResult', 'allocBandwidthResult', 'ebnoResult', 'spectralEfficiencyResult']
for (const [engName, calc] of [['GEO', core.calculateLinkBudget], ['NGSO', core.calculateLinkBudgetNGSO]]) {
  const q = modRun(calc, '64QAM')
  ok(`${engName} 64QAM 调制因子 = 6`, !!q && Number(q.modulationFactorResult) === 6)
  // 同为 6 bit/symbol 的 64APSK 作对照：除调制方式名外全部数值必须逐位一致
  const ap = modRun(calc, '64APSK')
  ok(`${engName} 64QAM 与 64APSK 数值逐位一致`,
    !!q && !!ap && MOD_KEYS.every(k => String(q[k]) === String(ap[k])))
  // 反向证伪：查表落空的回退值就是 2，若表又漏键则本条与上面两条同时挂
  ok(`${engName} 64QAM 未退化成 QPSK`,
    !!q && String(q.symbolRateResult) !== String(modRun(calc, 'QPSK').symbolRateResult))
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
