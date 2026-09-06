// 3GPP NTN 的 snr 口径进三个引擎 + 端到端链。运行：npm test
//
// 锁定四件事：
//   ⑥ 等价性 —— snr 行（按 phy 算占用带宽）与「手工把帧效率填成 (14/15)(1−OH)、滚降填成 B_ch/B_occ」
//      的 esno 行【逐位相同】。这条证明新分支没有改口径，只是把「按经验系数反推」换成「按分配算」；
//      把帧效率换回平台原来的 0.9，噪声带宽差 0.497 dB（下行 OH 0.14）/ 0.204 dB（上行 OH 0.08）
//      —— 这就是旧链比厂家口径乐观的那一点，钉死到 1e-3。
//   ⑦ 不变式 —— thresholdCN ≡ 含重复的门限 SNR；esnoActual ≡ snrActual；noiseBw ≡ 占用带宽。
//   ⑧ 老行不变 —— dvbStandard 是 3GPP 但 noiseRatioMode 还是 esno、没有 phy 的老配置，逐位走老链。
//   ⑨ PSD —— snr 行按占用带宽算，DVB 行一位不变。
import { createRequire } from 'module'
import fs from 'fs'
const require = createRequire(import.meta.url)
const core = require('../index.js')
const ntnPhy = require('../utils/ntnPhy.js')
// 出参默认两位小数，0.497 dB 这种量级的差会被四舍五入吃掉半个 mdB。等价性与差值断言一律在
// 六位小数下跑（与 linkSweep 扫描期的 _precise 同一把闸）。
const boost = (n) => { for (const m of ['../utils/linkCalculator.js', '../utils/linkCalculatorNGSO.js', '../utils/linkCalculatorRegen.js']) { const f = require(m).setOutputPrecisionBoost; if (typeof f === 'function') f(n) } }
boost(4)

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps) => Number.isFinite(Number(a)) && Math.abs(Number(a) - Number(b)) <= eps

const SAT = { frequencyBand: 'Ku', satelliteName: 'NTN-TEST' }
const GEO_BASE = { rainRate: 60, uplinkAvailability: 99.5, rxRainRate: 60, rxDownlinkAvailability: 99.5, margin: '3' }
const NGSO_BASE = Object.assign({}, GEO_BASE, { orbitAltitude: 1200, rxOrbitAltitude: 1200 })

// 被比较的出参：口径链上每一环都取到，任何一处走岔都会在这里露出来
// ★ 两个 PSD 刻意不在这份清单里：snr 行的 PSD 按占用带宽算、反配的 esno 行按载波带宽算，
//   这正是本任务唯一有意改掉的一处（见 ⑨），拿它比等价就自相矛盾了。
const KEYS = ['thresholdCN', 'linkmargin', 'esnoActualResult', 'ebnoResult', 'esnoResult', 'RXnoiseBW',
  'stationEIRPResult', 'uplinkCN', 'downlinkCN', 'carrierTotalCN', 'infoRateResult', 'allocBandwidthResult',
  'bandwidthUsageRatioResult']
const pick = (d) => KEYS.map((k) => k + '=' + d[k]).join(' ')

/* ================= ⑥ 等价性：snr 行 ≡ 按物理层反配的 esno 行 ================= */
// 用 oh38306 速率模型才谈得上等价：'tbs' 模型的信息速率来自量化过的 TBS，不是 B_occ 的连续函数，
// 反配不出一个能整除的帧效率。两个模型都走同一条 snr 分支，等价性验一个就够。
function equivPair(dir, scs, nRb, chBwMHz, Qm, R1024, mod, fecStr) {
  const oh = dir === 'ul' ? 0.08 : 0.14
  const phy = { kind: 'nr', dir, scs, nRb, chBwMHz, mcsTable: 't1', mcs: 9, rateModel: 'oh38306', nRep: 1 }
  const p = ntnPhy.normalizePhy(phy)
  const bOcc = ntnPhy.nrOccupiedBwKHz(p), bCh = ntnPhy.nrChannelBwKHz(p)
  const infoRate = ntnPhy.nrInfoRateKbps(p, Qm, R1024 / 1024)
  return {
    bOcc,
    snr: { modulation: mod, fec: fecStr, noiseRatioMode: 'snr', ebno: '3.00', phy },
    // ★ 反配：帧效率 = (14/15)(1−OH) 时 symbolRate = infoRate/(rs·R·Qm) 恰好等于 B_occ；
    //   滚降 = B_ch/B_occ 时载波带宽恰好等于信道带宽。此外一律照旧。
    esno: {
      modulation: mod, fec: fecStr, noiseRatioMode: 'esno', ebno: '3.00',
      infoRate: String(infoRate), rsCode: String((14 / 15) * (1 - oh)), bandwidthFactor: String(bCh / bOcc), m: '1'
    },
    // 平台原来那份：帧效率写死 0.9（「综合 CP 与 DMRS 开销」的工程值）
    legacy: {
      modulation: mod, fec: fecStr, noiseRatioMode: 'esno', ebno: '3.00',
      infoRate: String(infoRate), rsCode: '0.9', bandwidthFactor: '1.1', m: '1'
    },
    gapDb: 10 * Math.log10(0.9 / ((14 / 15) * (1 - oh)))
  }
}

for (const [engName, calc, base] of [['GSO', core.calculateLinkBudget, GEO_BASE], ['NGSO', core.calculateLinkBudgetNGSO, NGSO_BASE]]) {
  for (const dir of ['dl', 'ul']) {
    const c = equivPair(dir, 15, 25, 5, 2, 679, 'QPSK', '679/1024')
    const a = calc(SAT, Object.assign({}, base, c.snr))
    const b = calc(SAT, Object.assign({}, base, c.esno))
    ok(`⑥ ${engName} ${dir === 'ul' ? '上行' : '下行'}：snr 行与反配的 esno 行逐位相同`,
      a.success && b.success && pick(a.data) === pick(b.data),
      a.success && b.success && pick(a.data) !== pick(b.data) ? '差异 ' + KEYS.filter((k) => a.data[k] !== b.data[k]).join(',') : '')
    // 旧链（帧效率 0.9）：噪声带宽窄了，故同一门限下报出来的接收噪声功率偏低、要的站 EIRP 偏小
    const g = calc(SAT, Object.assign({}, base, c.legacy))
    ok(`⑥ ${engName} ${dir === 'ul' ? '上行' : '下行'}：旧链帧效率 0.9 的噪声带宽比占用带宽窄 ${c.gapDb.toFixed(3)} dB`,
      near(Number(a.data.RXnoiseBW) - Number(g.data.RXnoiseBW), c.gapDb, 1e-3),
      `实测 ${(Number(a.data.RXnoiseBW) - Number(g.data.RXnoiseBW)).toFixed(4)} dB`)
    ok(`⑥ ${engName} ${dir === 'ul' ? '上行' : '下行'}：这一点整条搬到站 EIRP 上（旧链省了同样多的功率）`,
      near(Number(a.data.stationEIRPResult) - Number(g.data.stationEIRPResult), c.gapDb, 2e-3))
    // 唯一有意的差别：PSD 的参考带宽（占用 vs 信道），差 10lg(B_ch/B_occ)
    ok(`⑥ ${engName} ${dir === 'ul' ? '上行' : '下行'}：两者只差 PSD 的参考带宽 10lg(B_ch/B_occ)`,
      near(Number(b.data.stationPSDResult) - Number(a.data.stationPSDResult),
        10 * Math.log10(4500 / 5000), 5e-3) &&
      near(Number(b.data.satellitePSDResult) - Number(a.data.satellitePSDResult),
        10 * Math.log10(4500 / 5000), 5e-3))
  }
}
ok('⑥ 差值就是任务书写的 0.497 dB（下行）/ 0.204 dB（上行）',
  near(10 * Math.log10(0.9 / ((14 / 15) * 0.86)), 0.497, 5e-4) &&
  near(10 * Math.log10(0.9 / ((14 / 15) * 0.92)), 0.204, 5e-4))

/* ================= ⑦ 不变式 ================= */
const NB_PHY = { kind: 'nbiot', dir: 'ul', scs: 15, nTones: 1, iTbs: 0, iRu: 0, nRep: 16 }
const CASES = [
  ['NR 下行 5 MHz MCS9', { kind: 'nr', dir: 'dl', scs: 15, nRb: 25, chBwMHz: 5, mcs: 9 }, 'QPSK', '679/1024', -0.3],
  ['NR 上行 1 PRB ×4 重复', { kind: 'nr', dir: 'ul', scs: 30, nRb: 1, mcs: 2, nRep: 4 }, 'QPSK', '193/1024', -3.7],
  ['NB-IoT 上行单音 ×16 重复', NB_PHY, 'BPSK', '1/16', -4.2],
  ['NB-IoT 下行 I_TBS 4', { kind: 'nbiot', dir: 'dl', scs: 15, nTones: 12, iTbs: 4, iSf: 0 }, 'QPSK', '1/5', -2.0]
]
for (const [name, phy, mod, fec, thr] of CASES) {
  for (const [engName, calc, base] of [['GSO', core.calculateLinkBudget, GEO_BASE], ['NGSO', core.calculateLinkBudgetNGSO, NGSO_BASE]]) {
    const r = calc(SAT, Object.assign({}, base, { modulation: mod, fec, noiseRatioMode: 'snr', ebno: String(thr), phy }))
    const d = r.data
    const p = ntnPhy.normalizePhy(phy)
    const eff = ntnPhy.effectiveThresholdDb(thr, p)
    ok(`⑦ ${engName} ${name}：thresholdCN ≡ 含重复的门限 SNR`,
      r.success && d.thresholdCN === d.snrThresholdEffResult && near(d.thresholdCN, eff, 5e-3),
      `${d.thresholdCN} vs ${eff.toFixed(3)}`)
    ok(`⑦ ${engName} ${name}：esnoActual ≡ snrActual，且 = 门限 + 余量`,
      d.esnoActualResult === d.snrActualResult && near(d.snrActualResult, eff + Number(d.linkmargin), 5e-3))
    ok(`⑦ ${engName} ${name}：noiseBw ≡ 占用带宽，表值门限原样回显`,
      near(d.noiseBwResult, ntnPhy.occupiedBwKHz(p), 1e-6) && near(d.snrThresholdResult, thr, 5e-3))
    ok(`⑦ ${engName} ${name}：DVB 三个链读数留空（这条链上没有这几个量）`,
      d.symbolRateResult === '' && d.carrierRateResult === '' && d.ChipRateResult === '')
    ok(`⑦ ${engName} ${name}：信息速率取 phy 算出来的，不取表单里那个`,
      near(d.infoRateResult, ntnPhy.infoRateKbps(p, mod === 'BPSK' ? 1 : 2, fec.indexOf('/') > 0 ? Number(fec.split('/')[0]) / Number(fec.split('/')[1]) : Number(fec)), 1e-6))
  }
}
// 重复次数只提门限、不提余量以外的东西：×4 恰好降 6.02 dB
{
  const mk = (nRep) => core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE, {
    modulation: 'QPSK', fec: '193/1024', noiseRatioMode: 'snr', ebno: '-3.70',
    phy: { kind: 'nr', dir: 'ul', scs: 30, nRb: 1, mcs: 2, nRep }
  })).data
  ok('⑦ 重复 ×4 把门限降 6.02 dB、信息速率降到 1/4',
    near(Number(mk(1).thresholdCN) - Number(mk(4).thresholdCN), 6.0206, 5e-3) &&
    near(Number(mk(1).infoRateResult) / Number(mk(4).infoRateResult), 4, 1e-9))
}
// 参数越界当场抛错，不给半个能用的数
// ★ Rel-14 全表没有空格，「这一格没有」的老例子（I_TBS 12 / I_RU 7）现在是合法的 2280 bit；
//   改用带内部署的 NPDSCH I_TBS 11 —— TS 36.213 §16.4.1.5.1 规定带内只到 I_TBS 10。
{
  const BAD = {
    modulation: 'QPSK', fec: '1/2', noiseRatioMode: 'snr', ebno: '0',
    phy: { kind: 'nbiot', dir: 'dl', opMode: 'inband', nTones: 12, iTbs: 11, iSf: 0 }
  }
  let msg = ''
  try { core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE, BAD)) } catch (e) { msg = e.message }
  const r = core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE, BAD))
  const hit = (t) => String(t).indexOf('带内部署的 NPDSCH 只到 I_TBS 10') > -1 && String(t).indexOf('当前 11') > -1
  ok('⑦ phy 越界 → 引擎报错并说清是哪一条限制（不静默按相邻档算）',
    (msg && hit(msg)) || (r && !r.success && hit(r.message)), msg || (r && r.message))
  // 同一条配置换成独立部署就该算得通（证明报错来自部署模式这一条，不是别的）
  const okOne = core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE, BAD, {
    phy: Object.assign({}, BAD.phy, { opMode: 'standalone' })
  }))
  ok('⑦ 换成独立部署同一档就算得通（I_TBS 11 是 Rel-14 的合法档）', okOne && okOne.success)
}
// noiseRatioMode 是 snr、却没给 phy：engineChain 返回 null → 照旧走 DVB 链（不崩）
{
  const r = core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE, {
    modulation: 'QPSK', fec: '3/4', noiseRatioMode: 'snr', ebno: '5.5', infoRate: '2048'
  }))
  const base = core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE, {
    modulation: 'QPSK', fec: '3/4', noiseRatioMode: 'esno', ebno: '5.5', infoRate: '2048'
  }))
  ok('⑦ 标了 snr 却没有 phy：退回 Es/N₀ 那条老链，不崩也不静默造带宽',
    r.success && pick(r.data) === pick(base.data))
}

/* ================= ⑧ 老行逐位不变 ================= */
// 平台原来的 3GPP 行长这样：帧效率 0.9、滚降 1.1、口径 esno、没有 phy。本任务的分支只认 'snr'，
// 故这样的老配置必须与改动前一字不差 —— 这里用「有没有 dvbStandard 标记」证明引擎压根不看它。
{
  const LEGACY = { modulation: '64QAM', fec: '948/1024', rsCode: '0.9', bandwidthFactor: 1.1, noiseRatioMode: 'esno', ebno: '25.56', infoRate: '20000' }
  for (const [engName, calc, base] of [['GSO', core.calculateLinkBudget, GEO_BASE], ['NGSO', core.calculateLinkBudgetNGSO, NGSO_BASE]]) {
    const a = calc(SAT, Object.assign({}, base, LEGACY))
    const b = calc(SAT, Object.assign({}, base, LEGACY, { dvbStandard: '3GPP NR-NTN' }))
    const c = calc(SAT, Object.assign({}, base, LEGACY, { dvbStandard: '3GPP NR-NTN', phy: { kind: 'nr', nRb: 106 } }))
    ok(`⑧ ${engName} 老 3GPP 行（esno + 0.9 + 1.1）逐位不变，且 phy 在 esno 口径下不生效`,
      a.success && pick(a.data) === pick(b.data) && pick(a.data) === pick(c.data))
    ok(`⑧ ${engName} 老行照旧出符号率/载波速率/码片速率，snr 专有出参留空`,
      a.data.symbolRateResult !== '' && a.data.snrThresholdEffResult === '' &&
      a.data.noiseBwResult === '' && a.data.phyDescResult === '')
  }
}

/* ================= ⑨ PSD 参考带宽 ================= */
{
  const phy = { kind: 'nr', dir: 'dl', scs: 15, nRb: 25, chBwMHz: 5, mcs: 9, rateModel: 'oh38306' }
  const d = core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE,
    { modulation: 'QPSK', fec: '679/1024', noiseRatioMode: 'snr', ebno: '3.00', phy })).data
  // 占用 4500 kHz、信道 5000 kHz：按信道带宽算会把 PSD 低报 10lg(5000/4500) = 0.458 dB
  ok('⑨ snr 行的 PSD 按占用带宽算（不是信道带宽）',
    near(Number(d.stationEIRPResult) - Number(d.stationPSDResult), 10 * Math.log10(4500 * 1000), 5e-3),
    `差 ${(Number(d.stationEIRPResult) - Number(d.stationPSDResult)).toFixed(3)} dB`)
  ok('⑨ 载波带宽仍是信道带宽（转发器占用比按它算）', Number(d.allocBandwidthResult) === 5000)
  const dvb = core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE,
    { modulation: '8PSK', fec: '3/4', rsCode: '0.9', bandwidthFactor: 1.05, noiseRatioMode: 'esno', ebno: '7.91', infoRate: '8000' })).data
  ok('⑨ DVB 行的 PSD 照旧按载波带宽算（一位不变）',
    near(Number(dvb.stationEIRPResult) - Number(dvb.stationPSDResult), 10 * Math.log10(Number(dvb.allocBandwidthResult) * 1000), 5e-3))
}

/* ================= 再生式：实际值 = 门限 + 单侧余量 ================= */
{
  const phy = { kind: 'nbiot', dir: 'ul', scs: 15, nTones: 1, iTbs: 0, iRu: 0, nRep: 16 }
  const inp = Object.assign({}, NGSO_BASE, { modulation: 'BPSK', fec: '1/16', noiseRatioMode: 'snr', ebno: '-4.20', phy })
  const up = core.computeRegenUplinkMode(SAT, inp, { mode: 'margin' })
  ok('再生式上行：snr 行算得通', up && up.success)
  if (up && up.success) {
    const d = up.data
    const eff = ntnPhy.effectiveThresholdDb(-4.2, ntnPhy.normalizePhy(phy))
    ok('再生式上行：snrActual = 含重复的门限 + 再生单侧余量（与 esnoActual 同数）',
      d.snrActualResult === d.esnoActualResult && near(d.snrActualResult, eff + Number(d.linkmargin), 5e-3),
      `${d.snrActualResult} = ${eff.toFixed(2)} + ${d.linkmargin}`)
    ok('再生式上行：门限 C/N 就是含重复的门限 SNR（−4.20 − 10lg16 = −16.24）',
      near(d.thresholdCN, -16.2412, 5e-3), String(d.thresholdCN))
  }
  const dn = core.computeRegenDownlinkMode(SAT, inp, { mode: 'margin' })
  ok('再生式下行：snr 行算得通且 snrActual 与 esnoActual 同数',
    dn && dn.success && dn.data.snrActualResult === dn.data.esnoActualResult)
}

/* ================= 端到端链：phy 逐段照抄 ================= */
{
  // carrierInto / carrierEchoOf 都不是导出符号（linkChain 只对外给 computeLinkChain），
  // 故这两条走源码级不变量 —— 与 flatExportCompat.test.mjs 同一手法。
  const src = fs.readFileSync(new URL('../utils/linkChain.js', import.meta.url), 'utf8')
  ok('端到端：carrierInto 把 phy 一起拷进 linkParams（链首定的 phy 逐段照抄）', /lp\.phy = c\.phy/.test(src))
  ok('端到端：载波回显键表里有 snr 那一组出参',
    /snrThresholdEffResult/.test(src) && /noiseBwResult/.test(src) && /phyDescResult/.test(src))
}

/* ================= ⑩ 2026-09-05 口径修正（详细计算结果那一轮） ================= */
{
  // ⑩-1 NB-IoT 下行的载波结构是定死的：12 子载波 × 15 kHz。面板曾放任下行选 3.75 kHz / 单子载波，
  //      占用带宽算成 3.75 kHz、频谱效率报出 34 bps/Hz。
  const badDl = ntnPhy.resolve({ kind: 'nbiot', dir: 'dl', scs: 3.75, nTones: 1, iTbs: 8, iSf: 2 }, 2, 0.5)
  ok('⑩ NB-IoT 下行强制 12 子载波 × 15 kHz（占用 180 / 信道 200）',
    badDl.phy.scs === 15 && badDl.phy.nTones === 12 && badDl.bOccKHz === 180 && badDl.bChKHz === 200)

  // ⑩-2 上行的信道带宽 ≡ 占用带宽，与 NR 上行同一把尺（曾把 12 子载波报成 200 kHz 栅格宽）
  const ul12 = ntnPhy.resolve({ kind: 'nbiot', dir: 'ul', scs: 15, nTones: 12, iTbs: 4, iRu: 3 }, 2, 0.5)
  ok('⑩ NB-IoT 上行 12 子载波：信道带宽 = 占用带宽 = 180 kHz', ul12.bChKHz === 180 && ul12.bOccKHz === 180)

  // ⑩-3 占用带宽不许超过信道带宽；PRB 数不许超过该 SCS 的最大档
  const over = ntnPhy.resolve({ kind: 'nr', dir: 'dl', scs: 15, nRb: 50, chBwMHz: 5, mcs: 7 }, 2, 526 / 1024)
  ok('⑩ 占用带宽超信道带宽当场报错（5 MHz 信道塞 50 PRB）',
    /超过信道带宽/.test(over.error) && over.bOccKHz === null, over.error)
  const many = ntnPhy.resolve({ kind: 'nr', dir: 'ul', scs: 15, nRb: 400, mcs: 7 }, 2, 526 / 1024)
  ok('⑩ 上行 PRB 数超最大信道档也报错（15 kHz 顶格 160 PRB）', /超出/.test(many.error), many.error)

  // ⑩-4 再生式下行的卫星 PSD 与弯管引擎同口径（都按占用带宽）——曾按信道带宽算，差 0.458 dB
  const phyDl = { kind: 'nr', dir: 'dl', scs: 15, nRb: 25, chBwMHz: 5, mcsTable: 't1', mcs: 7, nRep: 1 }
  const inp = Object.assign({}, NGSO_BASE, {
    modulation: 'QPSK', fec: '526/1024', noiseRatioMode: 'snr', ebno: '1.50', phy: phyDl, satEirp: '50'
  })
  const rg = core.computeRegenDownlinkMode(SAT, inp, { mode: 'power' })
  const eirp = Number(rg.data.EIRPsResult)
  ok('⑩ 再生式下行 PSD 按占用带宽（与弯管同口径）',
    near(rg.data.satellitePSDResult, eirp - 10 * Math.log10(4500 * 1000), 5e-3),
    `${rg.data.satellitePSDResult} vs ${(eirp - 10 * Math.log10(4500 * 1000)).toFixed(3)}`)

  // ⑩-5 ITU PFD 限值的参考带宽跟着功率走（占用带宽），与同一份结果里的 PSD 同一把尺
  const gsoSnr = core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE, {
    modulation: 'QPSK', fec: '526/1024', noiseRatioMode: 'snr', ebno: '1.50', phy: phyDl
  }))
  const lim4k = Number(gsoSnr.data.ituPfdLimitPerM2) - 10 * Math.log10(4500 / 4)
  const byCh = lim4k + 10 * Math.log10(5000 / 4)
  ok('⑩ ITU PFD 限值按占用带宽折算（不是含保护带的信道带宽，差 0.458 dB）',
    Math.abs(Number(gsoSnr.data.ituPfdLimitPerM2) - byCh) > 0.4)

  // ⑩-6 表 1 的 MCS15 与其余四张表的同款（16QAM 616/1024）门限必须同值
  const C = require('../utils/constants.js')
  const thrOf = (t, mod, fec) => (C[t].find((r) => r.modulation === mod && r.fec === fec) || {}).threshold
  const same = ['NR_NTN_MODCOD_TABLE', 'NR_NTN_T2_MODCOD_TABLE', 'NR_NTN_T3_MODCOD_TABLE',
    'NR_NTN_TP1_MODCOD_TABLE', 'NR_NTN_TP2_MODCOD_TABLE'].map((t) => thrOf(t, '16QAM', '616/1024'))
  ok('⑩ 五张 NR 表里 16QAM 616/1024 的门限同为 8.30', same.every((v) => v === 8.30), same.join(' / '))
}

/* ================= ⑪ 详细计算结果的载波段（真实出表，不看行表源码） ================= */
{
  const { buildWaterfallSegments } = require('../utils/waterfallBuilder.js')
  // 段里的行：id 就是字段名（字面量行取 slug），label 是当前语言下给人看的那几个字
  const carrierRows = (data) => {
    const segs = buildWaterfallSegments({ results: data, lang: 'zh', orbitType: 'GEO' })
    const seg = segs.find((g) => g.id === 'carrier')
    return (seg && seg.rows) || []
  }
  const labelOf = (rows, id) => (rows.find((r) => r.id === id) || {}).label

  // NB-IoT 下行（截图那条：I_TBS 4 / 1 子帧 / 不重复）
  const nbRows = carrierRows(core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE, {
    modulation: 'QPSK', fec: '56/264', noiseRatioMode: 'snr', ebno: '-2.00',
    phy: { kind: 'nbiot', dir: 'dl', scs: 15, nTones: 12, iTbs: 4, iSf: 0, nRep: 1 }
  })).data)
  ok('⑪ 3GPP 行的载波带宽改叫「信道带宽」，与紧随的「占用带宽」分得开',
    labelOf(nbRows, 'allocBandwidthResult') === '信道带宽' && labelOf(nbRows, 'noiseBwResult') === '占用带宽')
  ok('⑪ 「物理层配置」那句压缩串已拆成逐项（子载波间隔 / 子载波数 / 子帧数 / I_TBS）',
    !nbRows.some((r) => r.id === 'phyDescResult') &&
    labelOf(nbRows, 'phyScsResult') === '子载波间隔' && labelOf(nbRows, 'phyUnitsResult') === '子载波数' &&
    labelOf(nbRows, 'phySpanResult') === '子帧数' && labelOf(nbRows, 'phyMcsResult') === 'I_TBS')
  ok('⑪ NB-IoT 一律说「子载波数」，表里一个「音」字都不出现',
    !nbRows.some((r) => String(r.label).indexOf('音') >= 0))
  ok('⑪ 不再并排出与门限 SNR 同数的「门限 Es/N₀」；重复 ×1 时「表值」那行也不出',
    !nbRows.some((r) => r.id === 'esnoResult') && !nbRows.some((r) => r.id === 'snrThresholdResult') &&
    nbRows.some((r) => r.id === 'snrThresholdEffResult'))
  ok('⑪ 逐项都有值（不是摆了一排空行）',
    ['phyDirTextResult', 'phyScsResult', 'phyUnitsResult', 'phySpanResult', 'phyMcsResult']
      .every((k) => { const r = nbRows.find((x) => x.id === k); return r && r.up && r.up !== '—' }))

  // —— P2-6：3GPP 行印「目标 BLER」，不印「误码率」——
  // 根因：3GPP 各表的门限按 BLER 10% 首传给，而误码率那一行的值来自 DVB 的表单缺省 1×10⁻⁷，
  // 对 3GPP 行既无意义又误导，还一路带进报表。
  ok('⑪ 3GPP 行出「目标 BLER」不出「误码率」，值是纯数字 10',
    nbRows.some((r) => r.id === 'phyBlerResult') && labelOf(nbRows, 'phyBlerResult') === '目标 BLER' &&
    !nbRows.some((r) => r.id === 'berResult') &&
    (nbRows.find((r) => r.id === 'phyBlerResult') || {}).up === '10',
    String((nbRows.find((r) => r.id === 'phyBlerResult') || {}).up))
  // —— P2-5：NB 行的「FEC 码率」由引擎按当前 I_SF / I_RU 与部署模式现算 ——
  ok('⑪ NB-IoT 行的 FEC 码率走 phyCodeRateResult（表里那一列只是 I_SF = 0 那一格）',
    (nbRows.find((r) => r.id === 'phyCodeRateResult') || {}).label === 'FEC 码率' &&
    !nbRows.some((r) => r.id === 'fecResult'),
    String((nbRows.find((r) => r.id === 'phyCodeRateResult') || {}).up))

  // 重复 >1 时「表值」那行要回来（它与含重复的有效门限不是同一个数）
  const repRows = carrierRows(core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE, {
    modulation: 'QPSK', fec: '56/264', noiseRatioMode: 'snr', ebno: '-2.00',
    phy: { kind: 'nbiot', dir: 'dl', scs: 15, nTones: 12, iTbs: 4, iSf: 3, nRep: 16 }
  })).data)
  ok('⑪ 重复 ×16 时「门限 SNR（表值）」回来（与有效门限差 10lg16）',
    repRows.some((r) => r.id === 'snrThresholdResult'))

  // NR 上行：标签随体制/方向换
  const nrData = core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE, {
    modulation: 'QPSK', fec: '526/1024', noiseRatioMode: 'snr', ebno: '1.50',
    phy: { kind: 'nr', dir: 'ul', band: 'n256', scs: 15, nRb: 25, mcsTable: 't1', mcs: 7, nRep: 1 }
  })).data
  const nrRows = carrierRows(nrData)
  ok('⑪ NR 换成「PRB 数」「MCS」，方向与档位照实报',
    labelOf(nrRows, 'phyUnitsResult') === 'PRB 数' && labelOf(nrRows, 'phyMcsResult') === 'MCS' &&
    nrData.phyDirTextResult === '上行' && nrData.phyMcsResult === '表1 · MCS 7', nrData.phyMcsResult)
  ok('⑪ NR 没有子帧数那一行（那是 NB-IoT 的量）', !nrRows.some((r) => r.id === 'phySpanResult'))
  // —— P1-3：NTN 频段进级联（它决定可选的信道带宽档）；NR 行的码率照旧回显表值 ——
  ok('⑪ NR 行出「NTN 频段」，值是频段名本身',
    labelOf(nrRows, 'phyBandResult') === 'NTN 频段' && nrData.phyBandResult === 'n256', nrData.phyBandResult)
  ok('⑪ NR 行的 FEC 码率照旧回显表值 R（有效码率那条只对 NB-IoT 出）',
    nrRows.some((r) => r.id === 'fecResult') && !nrRows.some((r) => r.id === 'phyCodeRateResult'))
  ok('⑪ NR 行同样出目标 BLER', nrData.phyBlerResult === '10')
  // 老配置没指定频段 → 那一行整行不出（空值行由级联表自己滤掉，不摆一排空行）
  {
    const noBand = carrierRows(core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE, {
      modulation: 'QPSK', fec: '526/1024', noiseRatioMode: 'snr', ebno: '1.50',
      phy: { kind: 'nr', dir: 'ul', scs: 15, nRb: 25, mcsTable: 't1', mcs: 7, nRep: 1 }
    })).data)
    ok('⑪ 不指定频段的老行：NTN 频段那一行整行不出', !noBand.some((r) => r.id === 'phyBandResult'))
  }

  // DVB 行照旧：名字不变、Es/N₀ 照出、物理层那几行一个不出
  const dvbRows = carrierRows(core.calculateLinkBudget(SAT, Object.assign({}, GEO_BASE, {
    modulation: 'QPSK', fec: '3/4', noiseRatioMode: 'esno', ebno: '4.03',
    infoRate: '2048', rsCode: '0.9', bandwidthFactor: '1.05', m: '1'
  })).data)
  ok('⑪ DVB 行仍叫「载波带宽」、照旧出「门限 Es/N₀」，物理层与占用带宽那几行一个不出',
    labelOf(dvbRows, 'allocBandwidthResult') === '载波带宽' && dvbRows.some((r) => r.id === 'esnoResult') &&
    !dvbRows.some((r) => String(r.id).indexOf('phy') === 0) && !dvbRows.some((r) => r.id === 'noiseBwResult'))
  ok('⑪ DVB 行照旧出「误码率」，一位不变',
    labelOf(dvbRows, 'berResult') === '误码率' &&
    (dvbRows.find((r) => r.id === 'berResult') || {}).up === '1×10⁻⁷',
    String((dvbRows.find((r) => r.id === 'berResult') || {}).up))
  ok('⑪ DVB 行的载波速率 / 符号率 / 码片率照旧在表上',
    ['carrierRateResult', 'symbolRateResult', 'ChipRateResult'].every((k) => dvbRows.some((r) => r.id === k)))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
