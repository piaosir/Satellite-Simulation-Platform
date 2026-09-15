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
// 2026-09-16 三锁：可用度出厂默认 99.90→100%（晴天：p=0，雨衰 / 云衰 / XPD 不计入，用户拍板），引擎空值回退同步改 100 →
// 分配口径下 上行 C/N 12.99→12.80、下行 12.84→13.04；合成 C/N 与链路余量为目标值构造，仍不变。
approx('合成 C/N 回归', r.carrierTotalCN, 9.91, 0.05)
approx('上行 C/N 回归', r.uplinkCN, 12.80, 0.05)
approx('下行 C/N 回归', r.downlinkCN, 13.04, 0.05)
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

// —— 出参不许带原始浮点尾巴 ——
// 引擎出参一律经 toFixed 收位，界面（详细预算 / 链路表 / 报表）直接把这个串印出来。
// 漏收一处，那一格就是 130.66666666666666 这种十几位的长串，把数值列撑破串到单位上
// （2026-09-06 的 infoRateResult：DVB 行是表单原值不显眼，3GPP NTN 行由 TBS ÷ 时长算出来才露出来）。
// 判据不点名字段：|值| ≥ 0.001 的数值出参一律 ≤ 6 位小数（各量按 2/3/5 位定格，留一位余地）；
// 更小的数是功放瓦数那条「毫瓦以下保 4 位有效数字」的定点格式，位数本就该多，故排除在外。
// ★ 本文件不动 FX（扫描期的小数位增量），故这条判据只在 FX=0 下成立。
{
  const NUMERIC = /^-?\d+(\.\d+)?$/
  const decimals = (s) => (String(s).split('.')[1] || '').length
  const CARRIERS = [
    ['DVB 默认', {}],
    ['DVB 非整速率', { infoRate: '1234.567', modulation: '8PSK', fec: '2/3', rsCode: '0.92', bandwidthFactor: '1.35' }],
    // 3GPP NTN：信息速率 = TBS ÷ 时长，392 bit ÷ 3 子帧 = 130.66666666666666 kbps（本条的靶子）
    ['NB-IoT 下行 I_TBS8', { modulation: 'QPSK', fec: '120/264', noiseRatioMode: 'snr', ebno: '1.30', phy: { kind: 'nbiot', dir: 'dl', scs: 15, nTones: 12, iTbs: 8, iSf: 2 } }],
    ['NB-IoT 上行单音 ×16', { modulation: 'BPSK', fec: '1/16', noiseRatioMode: 'snr', ebno: '-4.2', phy: { kind: 'nbiot', dir: 'ul', scs: 15, nTones: 1, iTbs: 0, iRu: 0, nRep: 16 } }],
    ['NR 下行 5 MHz', { modulation: 'QPSK', fec: '679/1024', noiseRatioMode: 'snr', ebno: '-0.3', phy: { kind: 'nr', dir: 'dl', scs: 15, nRb: 25, chBwMHz: 5, mcs: 9 } }],
    ['NR 下行 38.306 速率式', { modulation: '16APSK', fec: '3/4', noiseRatioMode: 'snr', ebno: '5', phy: { kind: 'nr', dir: 'dl', scs: 30, nRb: 51, chBwMHz: 20, rateModel: 'oh38306', mcs: 9 } }]
  ]
  const BASE = { rainRate: 60, uplinkAvailability: 99.5, rxRainRate: 60, rxDownlinkAvailability: 99.5, margin: '3' }
  const NGSO_BASE = Object.assign({}, BASE, { orbitAltitude: 1200, rxOrbitAltitude: 1200 })
  for (const [engName, calc, base] of [['GEO', core.calculateLinkBudget, BASE], ['NGSO', core.calculateLinkBudgetNGSO, NGSO_BASE]]) {
    const bad = []
    for (const [cname, over] of CARRIERS) {
      const rr = calc({ frequencyBand: 'Ku', satelliteName: 'FMT' }, Object.assign({}, base, over))
      if (!rr.success) { bad.push(`${cname}: 算不出（${rr.message}）`); continue }
      for (const k of Object.keys(rr.data)) {
        const v = rr.data[k]
        if (v === null || v === undefined || typeof v === 'object') continue
        const s = String(v)
        if (!NUMERIC.test(s) || Math.abs(Number(s)) < 0.001) continue
        if (decimals(s) > 6) bad.push(`${cname}: ${k}=${s}`)
      }
    }
    ok(`${engName} 出参无原始浮点尾巴（${CARRIERS.length} 种载波逐字段）` + (bad.length ? ' —— ' + bad.join('；') : ''), bad.length === 0)
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
