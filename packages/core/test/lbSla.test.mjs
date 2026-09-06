// 「SLA 建议」纯逻辑自测。运行：npm test
// 被测文件是渲染端 ESM（src/shared/lbSla.js），故本测试也是 .mjs。
//
// 关键不变式：
//   ① 上下行不可用度按比例缩放到给定系统可用度：两侧相等时是 √ 关系、不等时比例守恒、k 单调；
//   ② 可用度向下取档（够不着最低档就留空）、丢包向上取档（超出全部档位照实报）；
//   ③ 丢包 = 1 − (1 − 10⁻ⁿ)^(8L)，RTT = ⌈(2·单程 + 2·预留)/10⌉×10；
//   ④ MIR 只在选了 MODCOD 标准时按「门限 + 系统余量 ≤ 晴空 Es/N₀」取最高效率档，
//      Eb/N₀ 口径的表行按引擎同一式 esno = ebno + 10lg(fec·rs·log2M/m) 换算；
//   ⑤ 建议值只从引擎出参与留底入参推导；ok=false 的行建议一律留空、依据列照给数字并标红；
//   ⑥ 各体制该出哪些组：再生下行/星间/激光无发射合规组、激光无可用度组、端到端带宽逐透明星；
//   ⑦ include 缺键 = 入报告；全不勾 → 报告块为 null；adopt 留空 → 报告写建议值；lang='en' 取 labelEn；
//   ⑧ 可用度构成：引擎那份只是【传播可用度】，地球站 / 空间段 / 地面段是 SLA 参数，按体制决定
//      计入哪几项各几次（填 100 即不计入、地面段另有勾选闸），系统可用度 = 传播 × 各因子连乘。

const {
  AVAIL_TIERS, LOSS_TIERS, DEFAULT_SLA_PARAMS, SLA_GROUPS, SLA_ITEMS, MIN_PER_MONTH,
  snapDown, snapUp, splitUnavailability, packetLossPct, berExpOf, pickMir, worstMonthAvail,
  deriveSla, slaRows, slaReportBlock, normSlaParams, normRowSla, slaIncludeCount, basisText,
  equipSlots, equipAvails, equipFactor, slaParamRows, sunOutageSummary
} = await import('../../../src/shared/lbSla.js')

// 传播口径的参数：把设备/空间段/地面段全填 100（＝不计入），于是可用度那几条只剩雨衰统计。
// 缺省参数是【计入设备】的（三项 99.9 %），下面 ⑧ 专门测那一路 —— 分开测，两边都说得清。
const PROP_ONLY = Object.assign({}, DEFAULT_SLA_PARAMS, { esTxAvail: 100, esRxAvail: 100, spaceAvail: 100, groundOn: 0 })

const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const modeSolver = require('../utils/modeSolver.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps)

console.log('=== SLA 建议 · 纯逻辑 ===\n')

// —— ① 不可用度按比例缩放 ——
const s1 = splitUnavailability(99.9, 99.9, 99.9)
ok('两侧相等 → √ 关系（99.9/99.9 要到 99.9 系统 ⇒ 两侧 99.95）',
  s1 && near(s1.up, 99.95, 2e-4) && near(s1.dn, 99.95, 2e-4), s1 && s1.up.toFixed(5))
ok('缩放后乘积恰为目标档', s1 && near(s1.up * s1.dn / 100, 99.9, 1e-6))
const s2 = splitUnavailability(99.99, 99.9, 99.8)
ok('不等分配时比例 1:10 守恒',
  s2 && near((100 - s2.up) * 10, (100 - s2.dn), 1e-9), s2 && `${(100 - s2.up).toExponential(4)} / ${(100 - s2.dn).toExponential(4)}`)
ok('不等分配缩放后乘积恰为目标档', s2 && near(s2.up * s2.dn / 100, 99.8, 1e-6))
const s3 = splitUnavailability(100, 99.9, 99.5)
ok('ab = 0 退化分支（一侧 100%）', s3 && near(s3.up, 100) && near(s3.dn, 99.5), s3 && s3.dn.toFixed(5))
const kA = splitUnavailability(99.9, 99.9, 99.99).k
const kB = splitUnavailability(99.9, 99.9, 99.9).k
const kC = splitUnavailability(99.9, 99.9, 99.5).k
ok('k 随目标档下降而单调增', kA < kB && kB < kC, `${kA.toFixed(4)} < ${kB.toFixed(4)} < ${kC.toFixed(4)}`)
const s4 = splitUnavailability(99.9, 99.5, 100)
ok('S = 100 → 两侧 100', s4 && near(s4.up, 100) && near(s4.dn, 100) && near(s4.k, 0))
ok('两侧已 100% 而 S < 100 → 缩放无解', splitUnavailability(100, 100, 99.9) === null)

// —— ② 取档 ——
ok('snapDown(AVAIL_TIERS, 99.8001) = 99.8', snapDown(AVAIL_TIERS, 99.8001) === 99.8)
ok('档位补到 98 / 98.5（Ka 小站与月口径很容易掉到 99 以下）',
  AVAIL_TIERS[0] === 98 && AVAIL_TIERS[1] === 98.5 && AVAIL_TIERS.length === 9, AVAIL_TIERS.join(','))
ok('snapDown(AVAIL_TIERS, 98.9) = 98.5', snapDown(AVAIL_TIERS, 98.9) === 98.5)
ok('snapDown(AVAIL_TIERS, 97.9) = null（够不着最低档）', snapDown(AVAIL_TIERS, 97.9) === null)
ok('snapDown 恰好落档取该档', snapDown(AVAIL_TIERS, 99.95) === 99.95)
ok('snapUp(LOSS_TIERS, 0.12) = 0.5', snapUp(LOSS_TIERS, 0.12) === 0.5)
ok('snapUp(LOSS_TIERS, 1.3) = 1.3（超出全部档位照实报）', snapUp(LOSS_TIERS, 1.3) === 1.3)

// —— ③ 丢包与 RTT ——
const pl = packetLossPct(7, 1500)
ok('packetLossPct(7, 1500) ≈ 0.1199 %', near(pl, 0.11992796, 1e-6), pl.toFixed(6))
ok('packetLossPct 与闭式一致', near(pl, (1 - Math.pow(1 - 1e-7, 12000)) * 100, 1e-9))
ok('packetLossPct 缺参 / 非法 → null', packetLossPct(null, 1500) === null && packetLossPct(7, 0) === null && packetLossPct('x', 1500) === null)
// RTT 口径：⌈(2 × 单程 + 2 × 处理时延预留) / 10⌉ × 10
const rttOf = (owd, proc) => Math.ceil((2 * owd + 2 * proc) / 10) * 10
ok('RTT：单程 119.6、预留 20 → 280 ms', rttOf(119.6, 20) === 280, String(rttOf(119.6, 20)))
ok('RTT 恰好整十不再上跳', rttOf(120, 20) === 280)
ok('RTT 超一点即进位', rttOf(120.1, 20) === 290)

// —— BER 串解析（端到端各段之和是非整幂）——
ok("berExpOf('1×10⁻⁷') = 7", near(berExpOf('1×10⁻⁷'), 7))
ok("berExpOf('2×10⁻⁷') ≈ 6.699", near(berExpOf('2×10⁻⁷'), 6.69897, 1e-5))
ok("berExpOf('1.5e-8') ≈ 7.824", near(berExpOf('1.5e-8'), 7.82391, 1e-5))
ok('berExpOf 空 / 非法 → null', berExpOf('') === null && berExpOf('—') === null)

// —— ④ MIR ——
// DVB-S2 片段（threshold 为 Es/N₀ 口径，与内置表同形）
const S2 = [
  { label: 'QPSK 3/4', modulation: 'QPSK', fec: '3/4', rsCode: '1', noiseRatioMode: 'esno', threshold: 4.03 },
  { label: '8PSK 3/4', modulation: '8PSK', fec: '3/4', rsCode: '1', noiseRatioMode: 'esno', threshold: 7.91 },
  { label: '16APSK 3/4', modulation: '16APSK', fec: '3/4', rsCode: '1', noiseRatioMode: 'esno', threshold: 10.21 },
  { label: '32APSK 4/5', modulation: '32APSK', fec: '4/5', rsCode: '1', noiseRatioMode: 'esno', threshold: 13.64 }
]
const mirBase = { modcodRows: S2, dvbStandard: 'DVB-S2', form: { m: '1' }, symbolRateKsps: 1000, cirKbps: 1500, marginDb: 3 }
const m1 = pickMir(Object.assign({}, mirBase, { esnoClear: 11.5 }))
ok('MIR 选出「门限 + 余量 ≤ 晴空」的最高效率档', m1.label === '8PSK 3/4', m1.label + ' ' + m1.mir.toFixed(1))
ok('MIR = 符号率 × log2M·fec·rs / m', near(m1.mir, 1000 * 3 * 0.75, 1e-9), m1.mir.toFixed(3))
const m2 = pickMir(Object.assign({}, mirBase, { esnoClear: 14 }))
ok('晴空更好 → 切到更高档', m2.label === '16APSK 3/4' && near(m2.mir, 3000, 1e-9), m2.label)
const m3 = pickMir(Object.assign({}, mirBase, { esnoClear: 6 }))
ok('选不出比 CIR 更高的档 → MIR = CIR、无档名', m3.mir === 1500 && m3.label === '')
const m4 = pickMir(Object.assign({}, mirBase, { dvbStandard: 'custom', esnoClear: 14 }))
ok('未选 MODCOD 标准（custom）→ MIR = CIR', m4.mir === 1500 && m4.label === '')
const m5 = pickMir(Object.assign({}, mirBase, { esnoClear: null }))
ok('晴空样本缺失 → MIR = CIR', m5.mir === 1500 && m5.label === '')
// Eb/N₀ 口径的表行：与 linkCalculator.js 同一式 esno = ebno + 10lg(fec·rs·log2M/m)
// QPSK 3/4、188/204、m = 1：k = 0.75 × (188/204) × 2 = 1.382353，10lg k = 1.40534 dB
const kQ = 0.75 * (188 / 204) * 2
const dQ = 10 * Math.log10(kQ)
const EB = [{ label: 'QPSK 3/4', modulation: 'QPSK', fec: '3/4', rsCode: '188/204', noiseRatioMode: 'ebno', threshold: 5.5 }]
const m6 = pickMir({ modcodRows: EB, dvbStandard: 'DVB-S', form: { m: '1' }, symbolRateKsps: 1000, cirKbps: 100, marginDb: 0, esnoClear: 5.5 + dQ })
ok('Eb/N₀ 口径表行按引擎同一式换算（恰好卡在门限上 → 选中）', m6.label === 'QPSK 3/4', `10lg k = ${dQ.toFixed(5)} dB`)
ok('Eb/N₀ 口径换算后 MIR = 符号率 × k', near(m6.mir, 1000 * kQ, 1e-9), m6.mir.toFixed(4))
const m7 = pickMir({ modcodRows: EB, dvbStandard: 'DVB-S', form: { m: '1' }, symbolRateKsps: 1000, cirKbps: 100, marginDb: 0, esnoClear: 5.5 + dQ - 0.01 })
ok('晴空差 0.01 dB 就选不上（门限严格）', m7.label === '')

// —— ⑤ deriveSla：GSO 真引擎算例 ——
// 主用例是【两地站】（北京发 → 上海收）：上下行落在两片雨区，传播可用度按乘积。
// 引擎缺省两侧同在北京 —— 那是回环，雨衰完全相关、按 min 走，另立一条（见「同站回环」）。
const RX_SH = { rxLatitude: 31.2304, rxLongitude: 121.4737 }
const geo = modeSolver.computeLinkMode({}, RX_SH, { mode: 'margin' })
ok('GSO 两地站算例可算', !!(geo && geo.success), geo && geo.message)
const geoCtx = {
  orbitType: 'GEO', data: geo.data, ok: true, resolvedMargin: geo.resolvedMargin,
  params: { satParams: {}, linkParams: Object.assign({}, RX_SH), opt: { mode: 'margin' } },
  carrierForm: { dvbStandard: 'custom', ber: '7', m: '1' }, modcodRows: [],
  slaParams: PROP_ONLY
}
const dGeo = deriveSla(geoCtx)
const sysA = parseFloat(geo.data.systemAvailabilityResult)
ok('系统可用度 = 上下行之积（99.9 × 99.9 = 99.8001）', near(sysA, 99.8001, 1e-4), geo.data.systemAvailabilityResult)
ok('可用度建议 = 向下取档 99.8', dGeo.items.sysAvail.suggest === 99.8)
ok('依据列把两侧之积摆在明处（署名 + 数字）',
  /^上行 99\.900 % × 下行 99\.900 % = 99\.800 %$/.test(basisText(dGeo.items.sysAvail.basis)), basisText(dGeo.items.sysAvail.basis))
ok('取档没有可见差别时不摆「→」（99.8001 与 99.8 都印成 99.800 %）',
  basisText(dGeo.items.sysAvail.basis).indexOf('→') < 0, basisText(dGeo.items.sysAvail.basis))
ok('依据列英文版把署名换掉、数字一字不动',
  basisText(dGeo.items.sysAvail.basis, true) === 'Uplink 99.900 % × Downlink 99.900 % = 99.800 %',
  basisText(dGeo.items.sysAvail.basis, true))
const cbw = parseFloat(geo.data.allocBandwidthResult), pbw = parseFloat(geo.data.PowerBWResult)
ok('结算带宽 = max(载波带宽, 功率带宽)', near(dGeo.items.settledBw.suggest, Math.max(cbw, pbw), 1e-9),
  `${cbw} / ${pbw} → ${dGeo.items.settledBw.suggest}`)
ok('CIR = 信息速率', near(dGeo.items.cir.suggest, parseFloat(geo.data.infoRateResult), 1e-9))
ok('未选 MODCOD 标准 → MIR = CIR', dGeo.items.mir.suggest === dGeo.items.cir.suggest)
ok('单程时延 = 引擎链路时延', near(dGeo.items.owd.suggest, parseFloat(geo.data.linkDelayResult), 1e-9))
ok('RTT = ⌈(2×单程 + 2×20)/10⌉×10',
  dGeo.items.rtt.suggest === Math.ceil((2 * parseFloat(geo.data.linkDelayResult) + 40) / 10) * 10, String(dGeo.items.rtt.suggest))
ok('丢包上限向上取档', dGeo.items.loss.suggest === 0.5, `原值 ${dGeo.items.loss.raw.toFixed(5)} % → ${dGeo.items.loss.suggest} %`)
ok('合规四项齐全（频率 / 占用带宽 / EIRP / PSD）',
  !!(dGeo.items.txFreq && dGeo.items.txBw && dGeo.items.txEirp && dGeo.items.txPsd))
ok('最大 EIRP = 站 EIRP + 容差', near(dGeo.items.txEirp.suggest, parseFloat(geo.data.stationEIRPResult) + 1, 1e-9))
ok('最大 PSD = 站 PSD + 36.02 + 容差', near(dGeo.items.txPsd.suggest, parseFloat(geo.data.stationPSDResult) + 36.02 + 1, 1e-9))
ok('极化原样带出（V/H/L/R 是数据不是判定）', dGeo.items.txPol.suggest === geo.data.uplinkPolarizationResult)
ok('极化隔离度下限取场景参数', dGeo.items.txXpd.suggest === 30)
ok('故障响应 / 恢复取缺省，依据列为「—」',
  dGeo.items.respond.suggest === 30 && dGeo.items.restore.suggest === 4 && basisText(dGeo.items.respond.basis) === '—')
ok('五个组齐出', dGeo.groups.join(',') === 'avail,bw,delay,ops,tx', dGeo.groups.join(','))
// 依据列里的汉字只许是【操作数署名】，且每片都得自带英文：漏一片，英文报告里就是一块中文
const noEn = []
for (const k of dGeo.order) for (const pt of (dGeo.items[k].basis || [])) {
  if (/[一-鿿]/.test(pt.text) && !pt.textEn) noEn.push(k + ':' + pt.text)
}
ok('带汉字的依据片都自带英文', noEn.length === 0, noEn.join(','))
const hanInEn = dGeo.order.filter((k) => /[一-鿿]/.test(basisText(dGeo.items[k].basis, true)))
ok('依据列英文版全无汉字', hanInEn.length === 0, hanInEn.join(','))
// 署名自成一片：与数字拼在一起，呈现层就查不到这条词条了
const glued = []
for (const k of dGeo.order) for (const pt of (dGeo.items[k].basis || [])) {
  if (/[一-鿿]/.test(pt.text) && /[0-9]/.test(pt.text)) glued.push(k + ':' + pt.text)
}
ok('署名不与数字拼在同一片', glued.length === 0, glued.join(','))

// ok = false：建议留空、依据列照给数字并标红
const dBad = deriveSla(Object.assign({}, geoCtx, { ok: false }))
ok('链路不成立 → 全部建议值留空', dBad.order.every((k) => dBad.items[k].suggest === null))
ok('链路不成立 → 依据列的诊断数标红', dBad.items.sysAvail.basis.some((p) => p.bad))
const rBad = slaRows(dBad, {}, PROP_ONLY)
ok('链路不成立 → 年中断上限也留空', rBad.find((r) => r.key === 'outageMin').suggestText === '')

// —— 年中断上限跟着采用值走 ——
const rowsGeo = slaRows(dGeo, {}, PROP_ONLY)
const outRow = rowsGeo.find((r) => r.key === 'outageMin')
ok('年中断上限 = (100 − 99.8)/100 × 525960 ≈ 1052 min', outRow.suggestText === '1052', outRow.suggestText)
const rowsAdopt = slaRows(dGeo, { adopt: { sysAvail: '99.9' } }, PROP_ONLY)
ok('改采用可用度 → 年中断上限跟着变（99.9% → 526 min）',
  rowsAdopt.find((r) => r.key === 'outageMin').suggestText === '526', rowsAdopt.find((r) => r.key === 'outageMin').suggestText)
ok('采用值填了就用采用值', rowsAdopt.find((r) => r.key === 'sysAvail').effective === 99.9)

// —— ⑤ 着色：采用值比建议更激进 ——
const cir0 = dGeo.items.cir.suggest
const rHot = slaRows(dGeo, { adopt: { cir: String(cir0 * 2), rtt: '100', settledBw: '1', txEirp: '99' } }, PROP_ONLY)
const badKeys = rHot.filter((r) => r.kind === 'item' && r.bad).map((r) => r.key).sort()
ok('CIR/RTT/结算带宽/EIRP 四项越界均着色', badKeys.join(',') === 'cir,rtt,settledBw,txEirp', badKeys.join(','))
const rCool = slaRows(dGeo, { adopt: { cir: String(cir0 / 2), rtt: '9999' } }, PROP_ONLY)
ok('采用值更保守则不着色', !rCool.filter((r) => r.kind === 'item').some((r) => r.bad))

// —— ⑥ 各体制该出哪些组 ——
const mk = (o) => deriveSla(Object.assign({
  data: geo.data, ok: true, resolvedMargin: 3, params: geoCtx.params,
  carrierForm: geoCtx.carrierForm, modcodRows: [], slaParams: PROP_ONLY
}, o))
ok('再生式上行：有发射合规组', mk({ orbitType: 'REGEN', regenMode: 'uplink' }).groups.includes('tx'))
ok('再生式下行：无发射合规组', !mk({ orbitType: 'REGEN', regenMode: 'downlink' }).groups.includes('tx'))
ok('再生式星间：无发射合规组', !mk({ orbitType: 'REGEN', regenMode: 'isl' }).groups.includes('tx'))
ok('再生式激光：无发射合规组；可用度与微波星间同口径（互视那一行）', (() => {
  const d = mk({ orbitType: 'REGEN', regenMode: 'laser' })
  return !d.groups.includes('tx') && d.groups.includes('avail')
})())
// 星间：微波与激光的 systemAvailabilityResult 都是【几何互视占比】，同一个物理量不该两种待遇
{
  const both = ['isl', 'laser'].map((rm) => deriveSla(Object.assign({
    orbitType: 'REGEN', regenMode: rm, data: geo.data, ok: true, resolvedMargin: 3,
    params: geoCtx.params, carrierForm: geoCtx.carrierForm, modcodRows: [], slaParams: DEFAULT_SLA_PARAMS
  })))
  ok('星间（微波 / 激光）出的是「互视可用度」不是「传播可用度」',
    both.every((d) => !!d.items.visAvail && !d.items.propAvail && d.items.visAvail.kind === 'ro'))
  ok('星间依据列署名「互视」，并连乘卫星与载荷 × 2',
    both.every((d) => /^互视 [\d.]+ % × 卫星与载荷 [\d.]+ % × 卫星与载荷 [\d.]+ % = /.test(basisText(d.items.sysAvail.basis))),
    basisText(both[0].items.sysAvail.basis))
  ok('星间依据列英文版署名 Visibility',
    both.every((d) => basisText(d.items.sysAvail.basis, true).indexOf('Visibility ') === 0),
    basisText(both[1].items.sysAvail.basis, true))
  ok('星间手动几何（引擎给空串）整组不出',
    !deriveSla({
      orbitType: 'REGEN', regenMode: 'isl', data: { systemAvailabilityResult: '' }, ok: true,
      params: null, carrierForm: {}, slaParams: DEFAULT_SLA_PARAMS
    }).groups.includes('avail'))
}
ok('再生式上行/下行不出 RTT（只报本段单程时延）',
  !mk({ orbitType: 'REGEN', regenMode: 'uplink' }).items.rtt && !!mk({ orbitType: 'REGEN', regenMode: 'uplink' }).items.owd)

// 端到端：带宽逐透明星、无链级合成行
const e2eData = {
  systemAvailabilityResult: '99.60040', e2eDelayResult: '246.500', propDelayResult: '240.500', procDelayResult: '6.000',
  e2eBerResult: '2×10⁻⁷', infoRateResult: '2048.000', symbolRateResult: '1481.48',
  allocBandwidthResult: '1777.778',
  transponders: [
    { name: '星A', carrierBandwidthResult: '1777.778', powerRatioResult: '3.20', transponderBandwidthResult: '36.00' },
    { name: '星B', carrierBandwidthResult: '1777.778', powerRatioResult: '8.00', transponderBandwidthResult: '54.00' }
  ],
  hops: [
    { type: 'up', availabilityResult: '99.80000', frequencyResult: '14.2500', polarizationResult: 'V', stationEirpResult: '65.43', stationPsdResult: '-27.07' },
    { type: 'down', availabilityResult: '99.80000' }
  ]
}
const dE2e = deriveSla({ orbitType: 'E2E', data: e2eData, ok: true, resolvedMargin: 3, params: null, carrierForm: {}, slaParams: PROP_ONLY })
const bwKeys = dE2e.order.filter((k) => k.indexOf('settledBw') === 0)
ok('端到端带宽逐透明星（两颗 → 两行）', bwKeys.length === 2, bwKeys.join(','))
ok('端到端不出链级合成带宽行', !dE2e.items.settledBw)
ok('端到端带宽 = max(载波带宽, 功率占用 × 转发器带宽)',
  near(dE2e.items['settledBw:1'].suggest, 8 / 100 * 54 * 1000, 1e-6), String(dE2e.items['settledBw:1'].suggest))
ok('端到端可用度依据列 = 各星地跳之积（再写向下取档那一步）',
  basisText(dE2e.items.sysAvail.basis) === '99.800 % × 99.800 % = 99.600 % → 99.500 %', basisText(dE2e.items.sysAvail.basis))
ok('端到端 MIR = CIR（逐段体制可不同，不做 ACM 外推）', dE2e.items.mir.suggest === dE2e.items.cir.suggest)
ok('端到端 BER 串解析进丢包（2×10⁻⁷ × 12000 bit ≈ 0.24 % → 取档 0.5 %）',
  dE2e.items.loss.suggest === 0.5 && near(dE2e.items.loss.raw, packetLossPct(berExpOf('2×10⁻⁷'), 1500), 1e-12))
ok('端到端合规取链首上行跳', dE2e.items.txPol.suggest === 'V' && near(dE2e.items.txEirp.suggest, 66.43, 1e-9))
ok('端到端单程时延依据 = 传播 + 星上处理 = 合计（两个「处理」各自署名）',
  basisText(dE2e.items.owd.basis) === '传播 240.500 + 星上处理 6.000 = 246.500 ms', basisText(dE2e.items.owd.basis))
ok('端到端单程时延依据英文版',
  basisText(dE2e.items.owd.basis, true) === 'Propagation 240.500 + On-board processing 6.000 = 246.500 ms',
  basisText(dE2e.items.owd.basis, true))
ok('端到端往返时延里的「处理」署名【地面处理】（与星上处理不是一个量）',
  /地面处理 20\)/.test(basisText(dE2e.items.rtt.basis)), basisText(dE2e.items.rtt.basis))

// —— ⑦ include / adopt / lang ——
ok('include 缺键 = 入报告', slaIncludeCount(dGeo, {}) === dGeo.order.length)
ok('include 显式 false 才不入报告', slaIncludeCount(dGeo, { include: { cir: false } }) === dGeo.order.length - 1)
const blkAll = slaReportBlock(dGeo, {}, PROP_ONLY, 'zh')
ok('报告块条款数 = 入报告条款数', blkAll.rows.length === dGeo.order.length)
ok('adopt 留空 → 报告矩阵格写建议值',
  blkAll.rows.find((r) => r.key === 'sysAvail').value === '99.800' && blkAll.rows.find((r) => r.key === 'sysAvail').adopt === '')
const blkAdopt = slaReportBlock(dGeo, { adopt: { sysAvail: '99.5' } }, PROP_ONLY, 'zh')
ok('adopt 填了 → 报告矩阵格写采用值', blkAdopt.rows.find((r) => r.key === 'sysAvail').value === '99.500')
const noneSla = { include: Object.fromEntries(dGeo.order.map((k) => [k, false])) }
ok('全不勾 → 报告块为 null', slaReportBlock(dGeo, noneSla, PROP_ONLY, 'zh') === null)
const blkEn = slaReportBlock(dGeo, {}, PROP_ONLY, 'en')
ok("lang='en' → 条款名与组名取 labelEn",
  blkEn.rows[0].label === 'System availability' && blkEn.rows[0].groupLabel === 'Availability', blkEn.rows[0].label)
// 端到端逐透明星那几行：星名单独放 sub，不拼进 label —— 总报告矩阵是多条链共用一行，
// 各链的那颗星未必是同一颗，拼上就是给一行数据挂了个只对第一条链成立的名字
{
  const be = slaReportBlock(dE2e, {}, PROP_ONLY, 'zh')
  const r0 = be.rows.find((r) => r.key === 'settledBw:0')
  ok('报告块：条款名与「哪颗星」分开带走', r0.label === '结算带宽' && r0.sub === '星A', r0.label + ' / ' + r0.sub)
  ok('报告块：没有 sub 的条款 sub 为空串', be.rows.find((r) => r.key === 'cir').sub === '')
}
ok('报告块无任何文字判定（达标/合格/受限/满足）',
  !JSON.stringify(blkAll).match(/达标|合格|受限|满足|资源判定/))

// —— 存档规整 ——
ok('slaParams 缺省补齐', normSlaParams({ pktBytes: 512 }).procMsPerEnd === DEFAULT_SLA_PARAMS.procMsPerEnd
  && normSlaParams({ pktBytes: 512 }).pktBytes === 512)
ok('slaParams 非法值退缺省', normSlaParams({ pktBytes: 'x' }).pktBytes === 1500 && normSlaParams(null).xpdMinDb === 30)
const ns = normRowSla({ adopt: { cir: '2048', mir: '  ' }, include: { cir: true, mir: false } })
ok('row.sla 只留用户填过的采用值与显式取消的勾选',
  JSON.stringify(ns) === JSON.stringify({ adopt: { cir: '2048' }, include: { mir: false } }), JSON.stringify(ns))
ok('row.sla 空对象规整成空', JSON.stringify(normRowSla(null)) === '{}' && JSON.stringify(normRowSla({ adopt: {} })) === '{}')

// —— 单位档：速率/带宽换档时，值与单位分列、采用值按基准单位存 ——
{
  const { fmtQtyParts } = await import('../../../src/shared/adaptUnits.js')
  const lock = (v, u) => fmtQtyParts(v, u, false)
  const auto = (v, u) => fmtQtyParts(v, u, true)
  const rowOf = (rows, k) => rows.find((r) => r.key === k)
  const rl = slaRows(dGeo, {}, DEFAULT_SLA_PARAMS, lock)
  const ra = slaRows(dGeo, {}, DEFAULT_SLA_PARAMS, auto)
  ok('锁定档：留在引擎基准单位（kbps），倍率 1',
    rowOf(rl, 'cir').unit === 'kbps' && rowOf(rl, 'cir').factor === 1, rowOf(rl, 'cir').suggestText + ' ' + rowOf(rl, 'cir').unit)
  ok('锁定档：数值不带浮点噪声（≤4 位小数、去尾零）',
    !/\d{6,}$/.test(rowOf(rl, 'mir').suggestText), rowOf(rl, 'mir').suggestText)
  ok('自适应档：2048 kbps → 2.048 Mbps，单位落在单独一列',
    rowOf(ra, 'cir').suggestText === '2.048' && rowOf(ra, 'cir').unit === 'Mbps' && rowOf(ra, 'cir').factor === 1e-3,
    rowOf(ra, 'cir').suggestText + ' ' + rowOf(ra, 'cir').unit)
  ok('自适应档：结算带宽 1777.838 kHz → 1.7778 MHz',
    rowOf(ra, 'settledBw').unit === 'MHz', rowOf(ra, 'settledBw').suggestText + ' ' + rowOf(ra, 'settledBw').unit)
  // 采用值以基准单位存；屏上按当前档显示 —— 换档只改显示，存的那个数一个字不动
  const adopted = { adopt: { cir: '2500' } }   // 2500 kbps
  ok('采用值以基准单位存：锁定档显示 2500 kbps',
    rowOf(slaRows(dGeo, adopted, DEFAULT_SLA_PARAMS, lock), 'cir').adoptShown === 2500)
  ok('采用值以基准单位存：自适应档同一个数显示成 2.5 Mbps',
    Math.abs(rowOf(slaRows(dGeo, adopted, DEFAULT_SLA_PARAMS, auto), 'cir').adoptShown - 2.5) < 1e-12)
  ok('非速率项不受单位档影响（可用度恒 %）',
    rowOf(ra, 'sysAvail').unit === '%' && rowOf(ra, 'sysAvail').factor === 1)
  // 报告块跟着走：单位列报的是屏上那一档，值与它自洽
  const bl = slaReportBlock(dGeo, adopted, DEFAULT_SLA_PARAMS, 'zh', auto).rows.find((r) => r.key === 'cir')
  ok('报告块的单位列 = 屏上那一档，值与它自洽', bl.unit === 'Mbps' && bl.value === '2.5', bl.value + ' ' + bl.unit)
  // 依据列为空时补「—」：把建议值原样抄一遍不是依据（合同条款那两条本就没有算式）
  ok('依据列为空补「—」', rowOf(rl, 'respond').basisText === '—', rowOf(rl, 'respond').basisText)
  ok('中心频率依据 = fc ± B/2（没引用频率计划时就这一段）',
    /^[\d.]+ ± [\d.]+ MHz$/.test(rowOf(rl, 'txFreq').basisText), rowOf(rl, 'txFreq').basisText)
  ok('载波带宽依据 = 符号率 × 带宽系数 = 结果',
    /^[\d.]+ ksps × [\d.]+ = [\d.]+ kHz$/.test(rowOf(rl, 'txBw').basisText), rowOf(rl, 'txBw').basisText)
  // GSO 引擎不出分段时延，依据列按 (上行斜距 + 下行斜距) / c 写，且必须算得平
  const owdB = rowOf(rl, 'owd').basisText
  const owdM = /^\((\d+\.\d+) \+ (\d+\.\d+)\) km \/ 299792\.458 km\/s = (\d+\.\d+) ms$/.exec(owdB)
  ok('单程时延依据 = (上行斜距 + 下行斜距) / c', !!owdM, owdB)
  ok('单程时延依据算得平',
    !!owdM && near((parseFloat(owdM[1]) + parseFloat(owdM[2])) / 299792.458 * 1000, parseFloat(owdM[3]), 0.06), owdB)
  // 处理时延预留是【单程】口径（发端调制 + 收端解调），一次往返穿两趟 → 整体 × 2（与旧式恒等）
  ok('往返时延依据把取整那一步也写出来（2 × (单程 + 预留)）',
    /^⌈2 × \([\d.]+ \+ 地面处理 20\) \/ 10⌉ × 10 = \d+ ms$/.test(rowOf(rl, 'rtt').basisText), rowOf(rl, 'rtt').basisText)
  ok('丢包依据 = 1 − (1 − p)^(8L) 再向上取档',
    /^1 − \(1 − 10⁻⁷\)\^12000 = [\d.]+ % → 0\.500 %$/.test(rowOf(rl, 'loss').basisText), rowOf(rl, 'loss').basisText)
  ok('年中断依据写到结果为止',
    /^\(100 − 99\.800\) \/ 100 × 525960 = \d+ min$/.test(rowOf(rl, 'outageMin').basisText), rowOf(rl, 'outageMin').basisText)
  ok('EIRP / PSD 依据写到结果为止',
    /= -?[\d.]+ dBW$/.test(rowOf(rl, 'txEirp').basisText) && /= -?[\d.]+ dBW\/4kHz$/.test(rowOf(rl, 'txPsd').basisText),
    rowOf(rl, 'txEirp').basisText + ' | ' + rowOf(rl, 'txPsd').basisText)
  ok('结算带宽依据把功率等效带宽展开成 占用比 × 转发器带宽',
    /^max\([\d.]+, [\d.]+ % × [\d.]+\) = [\d.]+ kHz$/.test(rowOf(rl, 'settledBw').basisText), rowOf(rl, 'settledBw').basisText)
  ok('CIR 依据 = 符号率 × 组合效率 = 结果',
    /^[\d.]+ ksps × [\d.]+ = [\d.]+ kbps$/.test(rowOf(rl, 'cir').basisText), rowOf(rl, 'cir').basisText)
}

// —— 扫描接上之后：档位表 / 最高可行档 / MIR ——
{
  const tiers = [99, 99.5, 99.7, 99.8, 99.9, 99.95, 99.99]
  const margins = [5.18, 4.45, 3.72, 3.00, 1.44, -0.59, -7.23]
  const fakeScan = {
    pin: { kind: 'pa', powerW: 2.4762258 },
    rows: tiers.map((t, i) => ({
      tag: String(t), tier: t, up: t, dn: 100, ok: true, message: '',
      data: { linkmargin: margins[i], powerUsageRatio: 12 + i, bandwidthUsageRatio: 4.9, interruptionMinutes: (100 - t) / 100 * 525960, uplinkRainAttenuation: 1 + i, downlinkRainAttenuationResult: 0.5 + i }
    })),
    clear: { tag: 'clear', tier: null, ok: true, data: { esnoActualResult: 14.018896, linkmargin: 7.11 } },
    message: ''
  }
  const withScan = deriveSla(Object.assign({}, geoCtx, {
    scan: fakeScan,
    carrierForm: { dvbStandard: 'DVB-S2', ber: '7', m: '1', modcodLabel: 'QPSK 3/4' },
    modcodRows: S2, resolvedMargin: 3
  }))
  ok('档位表原样带到面板（晴空样本不在其中）', withScan.scanRows.length === 7 && withScan.scanRows.every((r) => r.tag !== 'clear'))
  ok('工作点回显给表头 title', withScan.scanPin && withScan.scanPin.kind === 'pa')
  ok('最高可行档 = 余量 ≥ 0 的最高那一档（99.9）', withScan.feasibleTier === 99.9, String(withScan.feasibleTier))
  ok('MIR 按晴空 Es/N₀ 切档（14.02 dB − 3 dB 余量 → 16APSK 3/4）',
    withScan.items.mir.suggest > withScan.items.cir.suggest && /16APSK 3\/4/.test(basisText(withScan.items.mir.basis)),
    basisText(withScan.items.mir.basis))
  ok('MIR 依据列写「晴空 Es/N₀ − 系统余量 = 门限预算 · 当前档 → 选中档 = 该档速率」',
    basisText(withScan.items.mir.basis) === '14.02 − 3.00 = 11.02 dB QPSK 3/4 → 16APSK 3/4 = 4444.590 kbps',
    basisText(withScan.items.mir.basis))
  // 切不出更高档时门限预算与速率之间是「→」不是「=」（dB 与 kbps 不能划等号）
  const noHigher = deriveSla(Object.assign({}, geoCtx, {
    scan: fakeScan, carrierForm: { dvbStandard: 'DVB-S2', ber: '7', m: '1' }, modcodRows: [], resolvedMargin: 3
  }))
  ok('MIR 切不出档：门限预算 → 速率（不写等号）',
    / dB → [\d.]+ kbps$/.test(basisText(noHigher.items.mir.basis)), basisText(noHigher.items.mir.basis))
  const rowsScan = slaRows(withScan, { adopt: { sysAvail: '99.95' } }, DEFAULT_SLA_PARAMS)
  ok('可用度采用值超过最高可行档 → 着色', rowsScan.find((r) => r.key === 'sysAvail').bad)
  const rowsOk = slaRows(withScan, { adopt: { sysAvail: '99.9' } }, DEFAULT_SLA_PARAMS)
  ok('采用值恰在最高可行档 → 不着色', !rowsOk.find((r) => r.key === 'sysAvail').bad)
  // 没扫过时退到建议值当参照（保守代理：只标「超出当前设计点」的，不漏标）
  const noScanHot = slaRows(dGeo, { adopt: { sysAvail: '99.99' } }, DEFAULT_SLA_PARAMS)
  ok('没扫过时可用度参照退到建议值：超出即着色', noScanHot.find((r) => r.key === 'sysAvail').bad)
  const noScanCool = slaRows(dGeo, { adopt: { sysAvail: '99.7' } }, DEFAULT_SLA_PARAMS)
  ok('没扫过时不超出建议值即不着色', !noScanCool.find((r) => r.key === 'sysAvail').bad)
  // 扫过之后参照放宽到「余量 ≥ 0 的最高档」：同一个采用值，扫过的不再着色
  const relaxed = slaRows(withScan, { adopt: { sysAvail: '99.9' } }, DEFAULT_SLA_PARAMS)
  const strict = slaRows(dGeo, { adopt: { sysAvail: '99.9' } }, DEFAULT_SLA_PARAMS)
  ok('扫过之后参照放宽到最高可行档（99.9 由着色转为不着色）',
    !relaxed.find((r) => r.key === 'sysAvail').bad && strict.find((r) => r.key === 'sysAvail').bad)
  // 再生式那三条子链路的 out 里没有 resolvedMargin → 退到引擎回显的 marginResult
  const noRm = deriveSla(Object.assign({}, geoCtx, {
    scan: fakeScan, resolvedMargin: undefined,
    carrierForm: { dvbStandard: 'DVB-S2', ber: '7', m: '1' }, modcodRows: S2
  }))
  ok('缺 resolvedMargin 时退到引擎回显的系统余量（MIR 照样切得出档）', noRm.items.mir.suggest === withScan.items.mir.suggest,
    `${noRm.items.mir.suggest} vs ${withScan.items.mir.suggest}`)
}

// —— 3GPP NTN：没有符号率这一列，CIR 依据走 TBS / (TTI × N_rep) ——
{
  const { nbTbs, nbRuMs, NB_SF_COUNT, nrTbsPerSlot, normalizePhy } = await import('../../../src/shared/ntnPhy.js')
  // NB-IoT 下行：TTI = N_SF 个子帧，一个子帧 1 ms
  const nb = { kind: 'nbiot', dir: 'dl', iTbs: 4, iSf: 3, nRep: 4 }
  const nbP = normalizePhy(nb)
  const nbTb = nbTbs(nbP), nbSf = NB_SF_COUNT[nbP.iSf]
  const nbRate = nbTb / (nbSf * nbP.nRep)
  const dNb = deriveSla({
    orbitType: 'GEO', ok: true, params: null, slaParams: PROP_ONLY,
    carrierForm: { dvbStandard: 'custom', ber: '7', m: '1', noiseRatioMode: 'snr', phy: nb },
    data: { infoRateResult: nbRate.toFixed(3), symbolRateResult: '', phyTbsResult: String(nbTb), phyRepResult: '4' }
  })
  ok('NB-IoT 下行 CIR 依据 = TBS / (N_SF ms × N_rep) = 速率',
    basisText(dNb.items.cir.basis) === `${nbTb} bit / (${nbSf} ms × 4) = ${nbRate.toFixed(3)} kbps`,
    basisText(dNb.items.cir.basis))
  // NB-IoT 上行单音：TTI = N_RU × 一个 RU 的时长（1 音 15 kHz → 8 ms）
  const nbu = { kind: 'nbiot', dir: 'ul', nTones: 1, iTbs: 2, iRu: 2, nRep: 1 }
  const nbuP = normalizePhy(nbu)
  const nbuTb = nbTbs(nbuP), nbuMs = NB_SF_COUNT[nbuP.iRu] * nbRuMs(nbuP)
  const nbuRate = nbuTb / nbuMs
  const dNbu = deriveSla({
    orbitType: 'GEO', ok: true, params: null, slaParams: PROP_ONLY,
    carrierForm: { dvbStandard: 'custom', ber: '7', m: '1', noiseRatioMode: 'snr', phy: nbu },
    data: { infoRateResult: nbuRate.toFixed(3), symbolRateResult: '', phyTbsResult: String(nbuTb), phyRepResult: '1' }
  })
  ok('NB-IoT 上行 CIR 依据 = TBS / (N_RU × T_RU)，N_rep = 1 时不写那一乘',
    basisText(dNbu.items.cir.basis) === `${nbuTb} bit / ${nbuMs} ms = ${nbuRate.toFixed(3)} kbps`,
    basisText(dNbu.items.cir.basis))
  // NR：TBS 是「每时隙」的，每 ms 有 2^μ 个时隙 → TTI = 1/2^μ ms（30 kHz → 0.5 ms）
  const nr = { kind: 'nr', dir: 'dl', scs: 30, nRb: 24, mcs: 10, nRep: 1 }
  const nrP = normalizePhy(nr)
  const nrTb = nrTbsPerSlot(nrP, 2, 0.5), nrRate = nrTb * 2
  const dNr = deriveSla({
    orbitType: 'GEO', ok: true, params: null, slaParams: PROP_ONLY,
    carrierForm: { dvbStandard: 'custom', ber: '7', m: '1', noiseRatioMode: 'snr', phy: nr },
    data: { infoRateResult: nrRate.toFixed(3), symbolRateResult: '', phyTbsResult: String(nrTb), phyRepResult: '1' }
  })
  ok('NR CIR 依据 = TBS / (1/2^μ ms)（30 kHz → 0.5 ms）',
    basisText(dNr.items.cir.basis) === `${nrTb} bit / 0.5 ms = ${nrRate.toFixed(3)} kbps`,
    basisText(dNr.items.cir.basis))
  // 算不平就不摆式子：38.306 近似式那条路速率不由 TBS 定，硬写会得出一个对不上的数
  const dBadRate = deriveSla({
    orbitType: 'GEO', ok: true, params: null, slaParams: PROP_ONLY,
    carrierForm: { dvbStandard: 'custom', ber: '7', m: '1', noiseRatioMode: 'snr', phy: nr },
    data: { infoRateResult: '123.000', symbolRateResult: '', phyTbsResult: String(nrTb), phyRepResult: '1' }
  })
  ok('TBS 与速率对不上账就不摆式子（留「—」）', dBadRate.items.cir.basis.length === 0,
    basisText(dBadRate.items.cir.basis))
  // 信道带宽这一格：NTN 报的是栅格档，依据只能写它至少要装下的占用带宽
  const dCh = deriveSla({
    orbitType: 'GEO', ok: true, params: null, slaParams: PROP_ONLY,
    carrierForm: { dvbStandard: 'custom', ber: '7', m: '1', noiseRatioMode: 'snr', phy: nb },
    data: { uplinkFrequencyResult: '14.19', allocBandwidthResult: '200', noiseBwResult: '180', symbolRateResult: '' }
  })
  ok('NTN 信道带宽依据 = ≥ 占用带宽', basisText(dCh.items.txBw.basis) === '≥ 180.000 kHz',
    basisText(dCh.items.txBw.basis))
  ok('NTN 中心频率依据仍给 fc ± B/2', basisText(dCh.items.txFreq.basis) === '14190.0000 ± 0.1000 MHz',
    basisText(dCh.items.txFreq.basis))
}

// —— 分享包往返：row.sla 与 slaParams 随 state 深拷贝走，格式不升级（仍是 v3）——
const { makeBundle, encodeShare, decodeShare } = await import('../../../src/shared/lbShare.js')
const shareState = {
  v: 3, orbitType: 'GEO',
  rows: [{ earthStationLocation: '北京', sla: { adopt: { sysAvail: '99.5', txPol: 'H' }, include: { mir: false } } }, { earthStationLocation: '上海' }],
  satId: 'sat1',
  slaParams: { pktBytes: 512, procMsPerEnd: 15, eirpTolDb: 1.5, xpdMinDb: 27, respondMin: 15, restoreH: 2 }
}
const bundle = makeBundle({ mod: 'GEO', from: 'test', configs: [{ name: 'A', path: [], state: shareState }], lib: null })
const back = decodeShare(encodeShare(bundle))
const bst = back.configs[0].state
ok('分享码往返：row.sla 一字不差', JSON.stringify(bst.rows[0].sla) === JSON.stringify(shareState.rows[0].sla), JSON.stringify(bst.rows[0].sla))
ok('分享码往返：没写过 SLA 的行不平白多出 sla 键', bst.rows[1].sla === undefined)
ok('分享码往返：slaParams 一字不差', JSON.stringify(bst.slaParams) === JSON.stringify(shareState.slaParams))
ok('分享包格式不升级（仍是 v3）', back.v === 3, String(back.v))
ok('分享码往返出来的是新对象（深拷贝，不与源共用引用）', bst.rows[0].sla !== shareState.rows[0].sla)

// —— ⑧ 可用度构成：传播之外的发信射频 / 收信射频 / 卫星与载荷 / 基带骨干网 ——
{
  ok('缺省计入三项 99.99 %（发信射频 / 收信射频 / 卫星与载荷），基带/骨干网默认不勾',
    DEFAULT_SLA_PARAMS.esTxAvail === 99.99 && DEFAULT_SLA_PARAMS.esRxAvail === 99.99
    && DEFAULT_SLA_PARAMS.spaceAvail === 99.99 && DEFAULT_SLA_PARAMS.groundAvail === 99.99
    && DEFAULT_SLA_PARAMS.groundOn === 0)
  // 格一级：只看体制，不看值（参数轨据此决定显示哪几格 —— 填 100 的那格也得留着，否则改不回来）
  const slots = (o) => equipSlots(o).map((x) => x.key + '×' + x.count).join(',')
  ok('GSO：发信射频 · 收信射频 · 卫星与载荷（+ 基带/骨干网那一格）',
    slots({ orbitType: 'GEO' }) === 'esTxAvail×1,esRxAvail×1,spaceAvail×1,groundAvail×1', slots({ orbitType: 'GEO' }))
  ok('再生式上行：没有收信射频（对端是卫星）',
    slots({ orbitType: 'REGEN', regenMode: 'uplink' }) === 'esTxAvail×1,spaceAvail×1,groundAvail×1')
  ok('再生式下行：没有发信射频',
    slots({ orbitType: 'REGEN', regenMode: 'downlink' }) === 'esRxAvail×1,spaceAvail×1,groundAvail×1')
  ok('再生式星间：两颗星各算一次', slots({ orbitType: 'REGEN', regenMode: 'isl' }) === 'spaceAvail×2,groundAvail×1')
  // 中间转接站在链上既收又发，两条射频链都可能坏 → 发信射频除末站外每站一次、收信射频除首站外每站一次
  ok('端到端两站链：发信 ×1、收信 ×1（与旧口径逐位相同）',
    slots({ orbitType: 'E2E', esCount: 2, satCount: 1 }) === 'esTxAvail×1,esRxAvail×1,spaceAvail×1,groundAvail×1',
    slots({ orbitType: 'E2E', esCount: 2, satCount: 1 }))
  ok('端到端三站链：中间转接站两条射频链各计一次',
    slots({ orbitType: 'E2E', esCount: 3, satCount: 2 }) === 'esTxAvail×2,esRxAvail×2,spaceAvail×2,groundAvail×1',
    slots({ orbitType: 'E2E', esCount: 3, satCount: 2 }))
  // 值一级：100 / 留空即不计入；地面段还要过 groundOn 那道闸
  const parts = (sp) => equipAvails({ orbitType: 'GEO', slaParams: sp }).map((f) => f.key).join(',')
  ok('缺省下基带/骨干网不计入', parts(DEFAULT_SLA_PARAMS) === 'esTxAvail,esRxAvail,spaceAvail', parts(DEFAULT_SLA_PARAMS))
  ok('勾了基带/骨干网才乘进去',
    parts(Object.assign({}, DEFAULT_SLA_PARAMS, { groundOn: 1 })) === 'esTxAvail,esRxAvail,spaceAvail,groundAvail')
  ok('填 100 即该项不计入', parts(Object.assign({}, DEFAULT_SLA_PARAMS, { esRxAvail: 100 })) === 'esTxAvail,spaceAvail')
  ok('全填 100 → 一个因子都不剩、系数恒 1',
    parts(PROP_ONLY) === '' && equipFactor(equipAvails({ orbitType: 'GEO', slaParams: PROP_ONLY })) === 1)
  ok('连乘系数 = Π(v/100)', near(equipFactor([{ pct: 99.99 }, { pct: 99.99 }, { pct: 99.99 }]), Math.pow(0.9999, 3), 1e-12))

  // deriveSla：传播单列一行，系统可用度 = 传播 × 各因子
  const dc = deriveSla(Object.assign({}, geoCtx, { slaParams: DEFAULT_SLA_PARAMS }))
  const comp = sysA * Math.pow(0.9999, 3)
  ok('计入设备后多出「传播可用度」一行（只读，无采用值格）',
    !!dc.items.propAvail && dc.items.propAvail.kind === 'ro' && near(dc.items.propAvail.suggest, sysA, 1e-9))
  ok('系统可用度 = 传播 × 三项设备因子再向下取档（99.80 → 99.70）',
    dc.items.sysAvail.suggest === snapDown(AVAIL_TIERS, comp) && dc.items.sysAvail.suggest === 99.7,
    `${comp.toFixed(4)} → ${dc.items.sysAvail.suggest}`)
  ok('依据列把连乘摆在明处（每个环节都署名）',
    basisText(dc.items.sysAvail.basis)
      === `传播 99.800 % × 发信射频 99.990 % × 收信射频 99.990 % × 卫星与载荷 99.990 % = ${comp.toFixed(3)} % → 99.700 %`,
    basisText(dc.items.sysAvail.basis))
  ok('连乘的英文版逐片换名、数字一字不动',
    basisText(dc.items.sysAvail.basis, true)
      === `Propagation 99.800 % × Tx RF 99.990 % × Rx RF 99.990 % × Satellite & payload 99.990 % = ${comp.toFixed(3)} % → 99.700 %`,
    basisText(dc.items.sysAvail.basis, true))
  ok('一个因子都不计入时不出「传播可用度」那一行（同一个数不印两遍）',
    !deriveSla(Object.assign({}, geoCtx, { slaParams: PROP_ONLY })).items.propAvail)
  ok('年中断跟着【综合】可用度走，不跟传播走',
    slaRows(dc, {}, DEFAULT_SLA_PARAMS).find((r) => r.key === 'outageMin').suggestText === '1578',
    slaRows(dc, {}, DEFAULT_SLA_PARAMS).find((r) => r.key === 'outageMin').suggestText)
  ok('传播那一行没有采用值格：存量场景里留着的 adopt 也一律按建议值走',
    slaRows(dc, { adopt: { propAvail: '99.99' } }, DEFAULT_SLA_PARAMS).find((r) => r.key === 'propAvail').effective === dc.items.propAvail.suggest)
  ok('参数轨该显示哪几格由 eqSlots 给（星间只剩卫星与载荷 + 基带/骨干网那一格）',
    dc.eqSlots.join(',') === 'esTxAvail,esRxAvail,spaceAvail,groundAvail'
    && deriveSla(Object.assign({}, geoCtx, { orbitType: 'REGEN', regenMode: 'laser', slaParams: DEFAULT_SLA_PARAMS })).eqSlots.join(',') === 'spaceAvail,groundAvail',
    dc.eqSlots.join(','))
  ok('档位表用的连乘系数 = 各因子之积', near(dc.eqFactor, Math.pow(0.9999, 3), 1e-12), String(dc.eqFactor))
  // 着色参照：扫描给的是【传播档】，要按同一系数折算到综合域才和采用值可比
  const fakeScan2 = { pin: { kind: 'pa', powerW: 12.3 }, rows: [{ tag: '99.9', tier: 99.9, data: { linkmargin: '1.44' } }], clear: null, message: '' }
  const dcScan = deriveSla(Object.assign({}, geoCtx, { scan: fakeScan2, slaParams: DEFAULT_SLA_PARAMS }))
  ok('最高可行档按设备因子折算后当参照（99.9 传播档 → 99.87 综合，采用 99.9 即着色）',
    !slaRows(dcScan, { adopt: { sysAvail: '99.8' } }, DEFAULT_SLA_PARAMS).find((r) => r.key === 'sysAvail').bad
    && slaRows(dcScan, { adopt: { sysAvail: '99.9' } }, DEFAULT_SLA_PARAMS).find((r) => r.key === 'sysAvail').bad,
    (99.9 * dcScan.eqFactor).toFixed(3))
  // 报告 §4 末尾那行参数表
  const prZh = slaParamRows(DEFAULT_SLA_PARAMS, 'zh').map((r) => r.label).join(',')
  ok('报告参数表不列没勾的基带/骨干网', prZh.indexOf('基带/骨干网') < 0 && prZh.indexOf('发信射频可用度') === 0, prZh)
  ok('勾了基带/骨干网就列出来',
    slaParamRows(Object.assign({}, DEFAULT_SLA_PARAMS, { groundOn: 1 }), 'zh').some((r) => r.label === '基带/骨干网可用度'))
  ok('报告参数表英文取 labelEn',
    slaParamRows(DEFAULT_SLA_PARAMS, 'en')[0].label === 'Transmit RF availability'
    && slaParamRows(DEFAULT_SLA_PARAMS, 'en')[0].value === '99.99')
  ok('groundOn 是数（0/1）不是布尔：normSlaParams 走 num()，布尔会被当非法值丢掉',
    normSlaParams({ groundOn: 1 }).groundOn === 1 && normSlaParams({ groundOn: true }).groundOn === 0)
}

// —— ⑨ 2026-09-06 审查修正 ——
{
  // 9.1 同站回环：上下行雨衰完全相关，传播可用度取 min 不取乘积
  const loop = modeSolver.computeLinkMode({}, {}, { mode: 'margin' })   // 引擎缺省两侧同在北京
  const dLoop = deriveSla(Object.assign({}, geoCtx, {
    data: loop.data, resolvedMargin: loop.resolvedMargin,
    params: { satParams: {}, linkParams: {}, opt: { mode: 'margin' } }
  }))
  ok('同站回环：传播可用度 = min(上行, 下行) 而非乘积', dLoop.items.sysAvail.suggest === 99.9,
    String(dLoop.items.sysAvail.suggest))
  ok('同站回环依据列写成 min(…)，左括号不与署名分开',
    basisText(dLoop.items.sysAvail.basis) === 'min(上行 99.900 %, 下行 99.900 %) = 99.900 %',
    basisText(dLoop.items.sysAvail.basis))
  ok('同站回环依据英文版',
    basisText(dLoop.items.sysAvail.basis, true) === 'min(Uplink 99.900 %, Downlink 99.900 %) = 99.900 %',
    basisText(dLoop.items.sysAvail.basis, true))
  ok('两地站仍走乘积（回环判据只认坐标完全相同）',
    /^上行 [\d.]+ % × 下行 [\d.]+ % = /.test(basisText(dGeo.items.sysAvail.basis)),
    basisText(dGeo.items.sysAvail.basis))

  // 9.2 最大 EIRP / PSD 计入 UPC 抬升（运营商核准的是雨天峰值）
  const upcOn = modeSolver.computeLinkMode({}, Object.assign({}, RX_SH, { uplinkPowerControl: '是', rainRate: 60 }), { mode: 'margin' })
  const upcOff = modeSolver.computeLinkMode({}, Object.assign({}, RX_SH, { rainRate: 60 }), { mode: 'margin' })
  const mkUpc = (r) => deriveSla(Object.assign({}, geoCtx, { data: r.data, resolvedMargin: r.resolvedMargin }))
  const dUpcOn = mkUpc(upcOn), dUpcOff = mkUpc(upcOff)
  const eirp0 = parseFloat(upcOn.data.stationEIRPResult), upcDb = parseFloat(upcOn.data.UPCmarginResult)
  ok('UPC 算例：余量 = 上行雨衰', near(upcDb, parseFloat(upcOn.data.uplinkRainAttenuation), 1e-9), String(upcDb))
  ok('开 UPC：最大 EIRP = 晴空 EIRP + UPC 余量 + 容差',
    near(dUpcOn.items.txEirp.suggest, eirp0 + upcDb + 1, 1e-6), String(dUpcOn.items.txEirp.suggest))
  ok('开 UPC：最大 PSD 同样 + UPC 余量',
    near(dUpcOn.items.txPsd.suggest, parseFloat(upcOn.data.stationPSDResult) + 36.02 + upcDb + 1, 1e-6),
    String(dUpcOn.items.txPsd.suggest))
  ok('开 UPC：依据列三项一片一个数',
    basisText(dUpcOn.items.txEirp.basis) === eirp0.toFixed(2) + ' + ' + upcDb.toFixed(2) + ' + 1.0 = ' + (eirp0 + upcDb + 1).toFixed(2) + ' dBW',
    basisText(dUpcOn.items.txEirp.basis))
  ok('不开 UPC：与旧口径逐位相同（依据列不摆一个 + 0.00）',
    near(dUpcOff.items.txEirp.suggest, parseFloat(upcOff.data.stationEIRPResult) + 1, 1e-9)
    && /^[\d.]+ \+ 1\.0 = [\d.]+ dBW$/.test(basisText(dUpcOff.items.txEirp.basis)),
    basisText(dUpcOff.items.txEirp.basis))

  // 9.3 丢包：编码标准走帧差错模型，自定义保留随机误码模型
  const lossCtx = (form, data) => deriveSla(Object.assign({}, geoCtx, {
    carrierForm: Object.assign({ ber: '7', m: '1' }, form),
    data: Object.assign({}, geo.data, data || null)
  }))
  const dvb = lossCtx({ dvbStandard: 'DVB-S2', fec: '3/4' })
  ok('DVB-S2 QPSK 3/4、1500 B、FER 10⁻⁷ → N_f = 1，丢包 1.00e-5 % → 取档 0.001 %',
    dvb.items.loss.suggest === 0.001 && near(dvb.items.loss.raw, 1e-5, 1e-12),
    basisText(dvb.items.loss.basis))
  ok('帧差错依据列只写 N_f（不写 K，那是近似）',
    basisText(dvb.items.loss.basis) === '1 − (1 − 10⁻⁷)^1 = 1.00e-5 % → 0.001 %',
    basisText(dvb.items.loss.basis))
  ok('自定义（无编码）保留随机误码模型：BER 10⁻⁷、1500 B → 0.5 %',
    dGeo.items.loss.suggest === 0.5 && /\^12000 /.test(basisText(dGeo.items.loss.basis)),
    basisText(dGeo.items.loss.basis))
  // 3GPP NTN：一帧 = 一个传输块，K 取 TBS
  const ntn = lossCtx({ dvbStandard: '3GPP NTN NR', noiseRatioMode: 'snr' }, { phyTbsResult: '3000' })
  ok('3GPP NTN 帧差错按 TBS 分帧（8×1500 / 3000 = 4 帧）',
    /\)\^4 = /.test(basisText(ntn.items.loss.basis)) && near(ntn.items.loss.raw, (1 - Math.pow(1 - 1e-7, 4)) * 100, 1e-12),
    basisText(ntn.items.loss.basis))
  const fer9 = deriveSla(Object.assign({}, geoCtx, {
    carrierForm: { dvbStandard: 'DVB-S2', fec: '3/4', ber: '7', m: '1' },
    slaParams: Object.assign({}, PROP_ONLY, { ferExp: 9 })
  }))
  ok('帧差错率是场景参数（FER 10⁻⁹ → 1.00e-7 %）', near(fer9.items.loss.raw, 1e-7, 1e-16),
    basisText(fer9.items.loss.basis))
  ok('帧差错模型与随机模型差三四个数量级（0.001 % vs 0.5 %）',
    dvb.items.loss.suggest * 100 < dGeo.items.loss.suggest, dvb.items.loss.suggest + ' vs ' + dGeo.items.loss.suggest)

  // 9.4 设计误码率：只读文本，原样带出
  ok('设计误码率原样带出载波配置里那个数', dGeo.items.berTarget.suggest === geo.data.berResult,
    dGeo.items.berTarget.suggest)
  ok('设计误码率是只读文本（没有采用值格），依据「—」', (function () {
    const r = slaRows(dGeo, { adopt: { berTarget: '1×10⁻⁹' } }, PROP_ONLY).find((x) => x.key === 'berTarget')
    return r.ro === true && r.effective === geo.data.berResult && r.basisText === '—'
  })())
  ok('端到端设计误码率取链级 BER 串', dE2e.items.berTarget.suggest === '2×10⁻⁷', dE2e.items.berTarget.suggest)
  ok('组名改「时延与差错」（EN Delay & Errors）',
    SLA_GROUPS.find((g) => g.key === 'delay').label === '时延与差错'
    && SLA_GROUPS.find((g) => g.key === 'delay').labelEn === 'Delay & Errors')

  // 9.5 够不着最低标准档时取到 0.1 %（不留空格）
  const lowData = Object.assign({}, geo.data, { systemAvailabilityResult: '97.4321' })
  const dLow = deriveSla(Object.assign({}, geoCtx, { data: lowData }))
  ok('可用度够不着 98 时向下取到 0.1 %（97.4321 → 97.4）', dLow.items.sysAvail.suggest === 97.4,
    basisText(dLow.items.sysAvail.basis))
  ok('取到 0.1 % 这一步照样写「→」',
    /→ 97\.400 %$/.test(basisText(dLow.items.sysAvail.basis)), basisText(dLow.items.sysAvail.basis))

  // 9.6 处理时延预留改口径不改数
  ok('RTT 数值与「每端 × 2」的老式恒等',
    dGeo.items.rtt.suggest === Math.ceil((2 * parseFloat(geo.data.linkDelayResult) + 40) / 10) * 10,
    String(dGeo.items.rtt.suggest))
  ok('参数表把处理时延预留的单位改成 ms/单程',
    slaParamRows(DEFAULT_SLA_PARAMS, 'zh').find((r) => r.label === '处理时延预留').unit === 'ms/单程'
    && slaParamRows(DEFAULT_SLA_PARAMS, 'en').find((r) => r.label === 'Processing delay allowance').unit === 'ms/one-way')
  ok('帧差错率进报告参数表', slaParamRows(DEFAULT_SLA_PARAMS, 'zh').some((r) => r.label === '帧差错率 10⁻ⁿ'))

  // 9.7 新参数进存档与分享包
  ok('ferExp 进 DEFAULT_SLA_PARAMS（缺省 7 = QEF）', DEFAULT_SLA_PARAMS.ferExp === 7)
  ok('ferExp 走 normSlaParams（缺省补齐 / 非法退缺省）',
    normSlaParams({ ferExp: 9 }).ferExp === 9 && normSlaParams({ ferExp: 'x' }).ferExp === 7 && normSlaParams(null).ferExp === 7)
  {
    const st = { v: 3, orbitType: 'GEO', rows: [{ earthStationLocation: '北京' }], satId: 's', slaParams: normSlaParams({ ferExp: 9 }) }
    const bk = decodeShare(encodeShare(makeBundle({ mod: 'GEO', from: 't', configs: [{ name: 'A', path: [], state: st }], lib: null })))
    ok('ferExp 随分享包往返', bk.configs[0].state.slaParams.ferExp === 9, JSON.stringify(bk.configs[0].state.slaParams))
  }

  // 9.8 依据列三条闸对新增的片同样成立
  const allDerived = [dLoop, dUpcOn, dvb, ntn, dE2e, dLow]
  const badParts = []
  for (const d of allDerived) for (const k of d.order) for (const pt of (d.items[k].basis || [])) {
    if (/[\u4e00-\u9fff]/.test(pt.text) && !pt.textEn) badParts.push(k + ':' + pt.text)
    if (/[\u4e00-\u9fff]/.test(pt.text) && /[0-9]/.test(pt.text)) badParts.push(k + '(glued):' + pt.text)
  }
  ok('新增依据片：带汉字的都自带英文、且不与数字同片', badParts.length === 0, badParts.join(','))
  const hanEn = []
  for (const d of allDerived) for (const k of d.order) if (/[\u4e00-\u9fff]/.test(basisText(d.items[k].basis, true))) hanEn.push(k)
  ok('新增依据片：英文版全无汉字', hanEn.length === 0, hanEn.join(','))
}

// —— ⑩ 考核周期：年平均 vs 最坏月（ITU-R P.841）——
{
  // 换算表（附录 A 的六个数）：p_w = (p / 0.30)^(1/1.15)
  const WM = [[99.5, 98.441], [99.7, 99.000], [99.8, 99.297], [99.9, 99.615], [99.95, 99.789], [99.99, 99.948]]
  ok('P.841 年→最坏月折算与雨衰页同式',
    WM.every(([y, m]) => near(worstMonthAvail(y), m, 1e-3)),
    WM.map(([y]) => worstMonthAvail(y).toFixed(3)).join(' / '))
  ok('可用度 100 % 时不折算（p = 0）', worstMonthAvail(100) === 100)
  ok('一个考核月 = 一年的十二分之一', MIN_PER_MONTH === 525960 / 12, String(MIN_PER_MONTH))
  ok('考核周期缺省是年（现有场景数值一个字不动）', DEFAULT_SLA_PARAMS.monthly === 0)
  ok('monthly 是数（0/1）不是布尔', normSlaParams({ monthly: 1 }).monthly === 1 && normSlaParams({ monthly: true }).monthly === 0)

  const MON = Object.assign({}, PROP_ONLY, { monthly: 1 })
  const dMon = deriveSla(Object.assign({}, geoCtx, { slaParams: MON }))
  ok('月口径：传播先折到最坏月（99.800 → 99.297）再向下取档 99.0',
    dMon.items.sysAvail.suggest === 99 && /= 99\.297 % → 99\.000 %$/.test(basisText(dMon.items.sysAvail.basis)),
    basisText(dMon.items.sysAvail.basis))
  ok('月口径依据列把折算那一步写全',
    /^100 − \(\(100 − 99\.800\) \/ 0\.30\)\^\(1\/1\.15\) = /.test(basisText(dMon.items.sysAvail.basis)),
    basisText(dMon.items.sysAvail.basis))
  ok('月口径依据列无汉字可漏（纯算式）', !/[\u4e00-\u9fff]/.test(basisText(dMon.items.sysAvail.basis, true)))
  const rMon = slaRows(dMon, {}, MON)
  ok('月口径条款名改「系统可用度（月）」/「月中断时长上限」',
    rMon.find((r) => r.key === 'sysAvail').label === '系统可用度（月）'
    && rMon.find((r) => r.key === 'outageMin').label === '月中断时长上限',
    rMon.find((r) => r.key === 'outageMin').label)
  ok('月口径条款英文名',
    rMon.find((r) => r.key === 'sysAvail').labelEn === 'System availability (monthly)'
    && rMon.find((r) => r.key === 'outageMin').labelEn === 'Monthly outage (max)')
  ok('月中断上限 = (100 − 99.000)/100 × 43830 = 438 min',
    rMon.find((r) => r.key === 'outageMin').suggestText === '438'
    && /× 43830 = 438 min$/.test(rMon.find((r) => r.key === 'outageMin').basisText),
    rMon.find((r) => r.key === 'outageMin').basisText)
  // 设备因子在折算【之后】乘（设备可用度本就是长期平均，不折算）
  const dMonEq = deriveSla(Object.assign({}, geoCtx, { slaParams: Object.assign({}, DEFAULT_SLA_PARAMS, { monthly: 1 }) }))
  const wm = worstMonthAvail(parseFloat(geo.data.systemAvailabilityResult))
  ok('月口径 + 设备：连乘的第一项是折算后的传播值',
    near(dMonEq.items.propAvail.suggest, wm, 1e-9)
    && basisText(dMonEq.items.sysAvail.basis).indexOf('传播 ' + wm.toFixed(3) + ' %') === 0,
    basisText(dMonEq.items.sysAvail.basis))
  ok('月口径把「年」的断言完全留给缺省档（monthly = 0 时逐位不变）',
    dGeo.items.sysAvail.suggest === 99.8
    && slaRows(dGeo, {}, PROP_ONLY).find((r) => r.key === 'outageMin').suggestText === '1052')
  // 星间是几何互视占比，不是降雨统计 → 不折算
  const dIslMon = deriveSla({
    orbitType: 'REGEN', regenMode: 'isl', data: geo.data, ok: true, params: null,
    carrierForm: {}, slaParams: Object.assign({}, PROP_ONLY, { monthly: 1 })
  })
  ok('星间互视可用度不做 P.841 折算（那是降雨统计的经验式）',
    dIslMon.items.sysAvail.suggest === 99.8 && basisText(dIslMon.items.sysAvail.basis).indexOf('0.30') < 0,
    basisText(dIslMon.items.sysAvail.basis))
  // 端到端：各星地跳之积先算年口径，再整体折一次
  const dE2eMon = deriveSla({ orbitType: 'E2E', data: e2eData, ok: true, resolvedMargin: 3, params: null, carrierForm: {}, slaParams: MON })
  ok('端到端月口径：先乘完各跳再整体折算（依据列只出现一次折算式）',
    basisText(dE2eMon.items.sysAvail.basis).split('0.30').length === 2
    && /^100 − \(\(100 − 99\.600\)/.test(basisText(dE2eMon.items.sysAvail.basis)),
    basisText(dE2eMon.items.sysAvail.basis))
  // 着色参照：扫描给的是【传播域 · 年口径】的档，得折到同一个域才可比
  {
    const fake = { pin: { kind: 'pa', powerW: 12.3 }, rows: [{ tag: '99.9', tier: 99.9, data: { linkmargin: '1.44' } }], clear: null, message: '' }
    const dScanMon = deriveSla(Object.assign({}, geoCtx, { scan: fake, slaParams: MON }))
    ok('月口径下最高可行档按 P.841 折算后当参照（99.9 年 → 99.615 月）',
      near(dScanMon.items.sysAvail.ref, worstMonthAvail(99.9), 1e-9), String(dScanMon.items.sysAvail.ref))
    ok('月口径参照：采用 99.7 着色、99.5 不着色',
      slaRows(dScanMon, { adopt: { sysAvail: '99.7' } }, MON).find((r) => r.key === 'sysAvail').bad
      && !slaRows(dScanMon, { adopt: { sysAvail: '99.5' } }, MON).find((r) => r.key === 'sysAvail').bad)
  }
  // 报告参数行印「考核周期」
  ok('报告参数表印考核周期（年平均 / 最坏月），不是 0 / 1',
    slaParamRows(DEFAULT_SLA_PARAMS, 'zh').find((r) => r.label === '考核周期').value === '年平均'
    && slaParamRows(MON, 'zh').find((r) => r.label === '考核周期').value === '最坏月'
    && slaParamRows(MON, 'en').find((r) => r.label === 'Assessment period').value === 'Worst month')
  // 进分享包
  {
    const st = { v: 3, orbitType: 'GEO', rows: [{ earthStationLocation: '北京' }], satId: 's', slaParams: normSlaParams(MON) }
    const bk = decodeShare(encodeShare(makeBundle({ mod: 'GEO', from: 't', configs: [{ name: 'A', path: [], state: st }], lib: null })))
    ok('monthly 随分享包往返', bk.configs[0].state.slaParams.monthly === 1)
  }
  ok('derived 把考核周期带给面板（档位表的综合列与中断列据此换档）', dMon.monthly === true && dGeo.monthly === false)
}

// —— ⑪ 免责事件（日凌）与合同条款（抖动 / 故障额度）——
{
  const core = require('../index.js')
  // 固定站：北京 → 110.5°E、2.4 m、Ku 12.5 GHz、T_sys 150 K、判据 C/N 恶化 ≥ 1 dB
  const SUN = { lat: 39.9042, lon: 116.4074, satLon: 110.5, diameter: 2.4, customFreq: 12.5, sysTemp: 150, degThreshold: 1, year: 2026 }
  const raw = {
    vernal: core.calculateSunOutage(Object.assign({}, SUN, { season: 'vernal' })),
    autumnal: core.calculateSunOutage(Object.assign({}, SUN, { season: 'autumnal' }))
  }
  const sum = sunOutageSummary(raw)
  ok('日凌合计 = 逐日窗口时长之和（北京 2.4 m Ku → 春分 29.98 + 秋分 32.07 min）',
    near(sum.vernal.minutes, 29.98, 1) && near(sum.autumnal.minutes, 32.07, 1),
    `${sum.vernal.minutes.toFixed(2)} + ${sum.autumnal.minutes.toFixed(2)}`)
  ok('日凌逐日窗口带 UTC 与北京时两套时刻（报告那张表直接照抄）',
    sum.vernal.rows.length === sum.vernal.days
    && !!sum.vernal.rows[0].startUTC && !!sum.vernal.rows[0].startBJT && !!sum.vernal.rows[0].date,
    JSON.stringify(sum.vernal.rows[0]))
  ok('两季都算不出 → 整份为 null（不编一个 0 出来）',
    sunOutageSummary({ vernal: { error: true }, autumnal: null }) === null)

  const dSun = deriveSla(Object.assign({}, geoCtx, { sunOutage: sum }))
  const tot = sum.vernal.minutes + sum.autumnal.minutes
  ok('日凌单列一组「免责事件」，不并进可用度',
    dSun.groups.includes('excl') && dSun.items.sunOutage.group === 'excl'
    && dSun.groups.indexOf('excl') === dSun.groups.length - 1, dSun.groups.join(','))
  ok('日凌建议值 = 两季合计 min', near(dSun.items.sunOutage.suggest, tot, 1e-9), tot.toFixed(2))
  ok('日凌是只读条款（没有采用值格）', (() => {
    const r = slaRows(dSun, { adopt: { sunOutage: '5' } }, PROP_ONLY).find((x) => x.key === 'sunOutage')
    return r.ro === true && near(r.effective, tot, 1e-9)
  })())
  ok('日凌依据列两季各自署名',
    basisText(dSun.items.sunOutage.basis) === `春分 ${sum.vernal.minutes.toFixed(1)} + 秋分 ${sum.autumnal.minutes.toFixed(1)} = ${tot.toFixed(1)} min`,
    basisText(dSun.items.sunOutage.basis))
  ok('日凌依据列英文版',
    basisText(dSun.items.sunOutage.basis, true) === `Vernal ${sum.vernal.minutes.toFixed(1)} + Autumnal ${sum.autumnal.minutes.toFixed(1)} = ${tot.toFixed(1)} min`,
    basisText(dSun.items.sunOutage.basis, true))
  ok('日凌不进系统可用度连乘、也不进中断预算',
    basisText(dSun.items.sysAvail.basis).indexOf('min') < 0
    && slaRows(dSun, {}, PROP_ONLY).find((r) => r.key === 'outageMin').suggestText
       === slaRows(dGeo, {}, PROP_ONLY).find((r) => r.key === 'outageMin').suggestText)
  ok('没算日凌 → 整组不出（没有就是没有）', !dGeo.groups.includes('excl') && !dGeo.items.sunOutage)
  ok('只有 GEO 出日凌：NGSO / 再生式 / 端到端一律不出',
    ['NGSO'].every((o) => !deriveSla(Object.assign({}, geoCtx, { orbitType: o, sunOutage: sum })).groups.includes('excl'))
    && !deriveSla(Object.assign({}, geoCtx, { orbitType: 'REGEN', regenMode: 'uplink', sunOutage: sum })).groups.includes('excl')
    && !deriveSla({ orbitType: 'E2E', data: e2eData, ok: true, params: null, carrierForm: {}, slaParams: PROP_ONLY, sunOutage: sum }).groups.includes('excl'))

  // 时延抖动：纯合同条款
  ok('时延抖动取场景参数、依据「—」',
    dGeo.items.jitter.suggest === 30 && basisText(dGeo.items.jitter.basis) === '—')
  ok('抖动缺省 30 ms，走 normSlaParams',
    DEFAULT_SLA_PARAMS.jitterMs === 30 && normSlaParams({ jitterMs: 50 }).jitterMs === 50 && normSlaParams({ jitterMs: 'x' }).jitterMs === 30)
  ok('抖动进报告参数表', slaParamRows(DEFAULT_SLA_PARAMS, 'zh').some((r) => r.label === '时延抖动'))
  ok('抖动归在「时延与差错」组、且采用值比建议更小即着色',
    dGeo.items.jitter.group === 'delay'
    && slaRows(dGeo, { adopt: { jitter: '10' } }, PROP_ONLY).find((r) => r.key === 'jitter').bad)
  ok('没有单程时延（引擎没出这一列）就不出抖动那一行',
    !deriveSla(Object.assign({}, geoCtx, { data: Object.assign({}, geo.data, { linkDelayResult: '', e2eDelayResult: '', islDelayResult: '' }) })).items.jitter)

  // 隐含年故障次数上限（参数轨末尾的读数行）：三项 99.99 % → 157.8 min，恢复 4 h → 0.66 次/年
  {
    const f = Math.pow(0.9999, 3)
    const mins = (1 - f) * 525960
    ok('隐含年故障次数：157.8 min ÷ 240 min = 0.66 次/年',
      near(mins, 157.8, 0.1) && (mins / 240).toFixed(2) === '0.66', `${mins.toFixed(1)} / ${(mins / 240).toFixed(2)}`)
  }
  {
    const st = { v: 3, orbitType: 'GEO', rows: [{ earthStationLocation: '北京' }], satId: 's', slaParams: normSlaParams({ jitterMs: 50 }) }
    const bk = decodeShare(encodeShare(makeBundle({ mod: 'GEO', from: 't', configs: [{ name: 'A', path: [], state: st }], lib: null })))
    ok('jitterMs 随分享包往返', bk.configs[0].state.slaParams.jitterMs === 50)
  }
  // 依据列三条闸
  const bad3 = []
  for (const k of dSun.order) for (const pt of (dSun.items[k].basis || [])) {
    if (/[\u4e00-\u9fff]/.test(pt.text) && !pt.textEn) bad3.push(k + ':' + pt.text)
    if (/[\u4e00-\u9fff]/.test(pt.text) && /[0-9]/.test(pt.text)) bad3.push(k + '(glued):' + pt.text)
  }
  ok('日凌 / 抖动的依据片：带汉字的都自带英文、且不与数字同片', bad3.length === 0, bad3.join(','))
}

// —— 静态清单自洽 ——
ok('每条条款都归属于一个已声明的组', SLA_ITEMS.every((it) => SLA_GROUPS.some((g) => g.key === it.group)))
ok('每条条款都有中英名', SLA_ITEMS.every((it) => it.label && it.labelEn))
ok('条款 key 无重复', new Set(SLA_ITEMS.map((i) => i.key)).size === SLA_ITEMS.length)

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
