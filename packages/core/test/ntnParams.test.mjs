// 3GPP NTN 参数核对 + 载波带宽限值自测。运行：npm test
// 被测的限值判据是渲染端 ESM（src/shared/ntnLimits.js），故本测试自身也是 .mjs。
//
// 锁定两件事：
//   ① NR-NTN MODCOD 表的【调制方式 + 目标码率】必须逐条等于 3GPP TS 38.214 Table 5.1.3.1-1
//      (MCS index table 1, 最高 64QAM) —— 这两列是标准原值，任何改动都是错的。
//      门限 Es/N₀ 一列是工程仿真预置（3GPP 不规定 MCS↔SNR），不在本测试的锁定范围，只查单调性。
//   ② NB-IoT NTN 各档 fec 必须与 TS 36.213 Table 16.4.1.5.1-1 的 TBS（I_SF=0 列）/264 相符。
//   ③ 载波带宽超出该体制信道带宽档位时必须报「over」，DVB 体制一律不判。
import { createRequire } from 'module'
import { checkNtnBandwidth, NTN_BW_LIMITS, isNtnStandard } from '../../../src/shared/ntnLimits.js'
const require = createRequire(import.meta.url)
const C = require('../utils/constants.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

console.log('=== 3GPP NTN 参数核对 ===\n')

// —— ① NR-NTN：TS 38.214 Table 5.1.3.1-1（MCS 0–28，Qm 与 R×1024）——
const TS38214_T1 = [
  ['QPSK', 120], ['QPSK', 157], ['QPSK', 193], ['QPSK', 251], ['QPSK', 308],
  ['QPSK', 379], ['QPSK', 449], ['QPSK', 526], ['QPSK', 602], ['QPSK', 679],
  ['16QAM', 340], ['16QAM', 378], ['16QAM', 434], ['16QAM', 490], ['16QAM', 553],
  ['16QAM', 616], ['16QAM', 658],
  ['64QAM', 438], ['64QAM', 466], ['64QAM', 517], ['64QAM', 567], ['64QAM', 616],
  ['64QAM', 666], ['64QAM', 719], ['64QAM', 772], ['64QAM', 822], ['64QAM', 873],
  ['64QAM', 910], ['64QAM', 948]
]
const nr = C.NR_NTN_MODCOD_TABLE
ok('NR-NTN 表含 MCS 0–28 共 29 档', nr.length === 29, `实际 ${nr.length}`)
let nrBad = []
TS38214_T1.forEach(([mod, r1024], i) => {
  const e = nr[i]
  if (!e || e.modulation !== mod || e.fec !== `${r1024}/1024`) nrBad.push(`MCS${i}`)
})
ok('NR-NTN 调制/码率逐条等于 TS 38.214 Table 5.1.3.1-1', nrBad.length === 0, nrBad.join(',') || '29/29 一致')
ok('NR-NTN 门限随 MCS 单调不降', nr.every((e, i) => i === 0 || e.threshold >= nr[i - 1].threshold))
ok('NR-NTN 带宽因子统一为 1.1（占用带宽→信道带宽）', nr.every((e) => e.bandwidthFactor === 1.1))

// —— ② NB-IoT NTN：TS 36.213 Table 16.4.1.5.1-1，I_SF=0 那一列的 TBS ——
const NB_TBS = { 0: 16, 2: 32, 4: 56, 5: 72, 6: 88, 8: 120, 11: 176, 12: 208 }
const BITS_PER_SF = (14 - 3) * 12 * 2   // 264
const nb = C.NB_IOT_NTN_MODCOD_TABLE
const frac = (s) => { const p = String(s).split('/'); return Number(p[0]) / Number(p[1]) }
let nbBad = []
nb.forEach((e) => {
  const m = /I_TBS=(\d+)/.exec(e.label)
  if (!m) { nbBad.push(e.label); return }
  const tbs = NB_TBS[Number(m[1])]
  if (tbs == null) { nbBad.push(e.label); return }
  // 标注码率是 TBS/264 的约分值，允许 ±12% 的约分偏差（如 120/264=0.4545 标作 1/2）
  if (Math.abs(frac(e.fec) - tbs / BITS_PER_SF) > 0.12 * (tbs / BITS_PER_SF) + 1e-9) nbBad.push(`${e.label} ${e.fec} vs ${tbs}/264`)
})
ok('NB-IoT NTN 各档码率与 TS 36.213 的 TBS/264 相符', nbBad.length === 0, nbBad.join(' | ') || `${nb.length}/${nb.length} 一致`)
ok('NB-IoT NTN 全 QPSK（NPDSCH 只有 QPSK）', nb.every((e) => e.modulation === 'QPSK'))
ok('NB-IoT NTN 无外码 rsCode=1', nb.every((e) => Number(e.rsCode) === 1))

// —— ③ 载波带宽限值判据 ——
ok('DVB 体制不判', checkNtnBandwidth('DVB-S2X', 36000) === null)
ok('自定义不判', checkNtnBandwidth('custom', 999999) === null)
ok('带宽无效不判', checkNtnBandwidth('3GPP NR-NTN', NaN) === null)

const nbOver = checkNtnBandwidth('3GPP NB-IoT NTN', 500)
ok('NB-IoT 500 kHz 判超限', nbOver && nbOver.level === 'over', nbOver && nbOver.text)
const nbOk = checkNtnBandwidth('3GPP NB-IoT NTN', 198)
ok('NB-IoT 198 kHz 在 200 kHz 信道内', nbOk && nbOk.level === 'ok' && nbOk.fitKHz === 200)
ok('NB-IoT 200 kHz 边界不算超', checkNtnBandwidth('3GPP NB-IoT NTN', 200).level === 'ok')
ok('NB-IoT 200.001 kHz 算超', checkNtnBandwidth('3GPP NB-IoT NTN', 200.001).level === 'over')

const nrOver = checkNtnBandwidth('3GPP NR-NTN', 36000)   // 典型转发器切片，NR-NTN 配不出来
ok('NR-NTN 36 MHz 判超限', nrOver && nrOver.level === 'over', nrOver && nrOver.text)
ok('NR-NTN 4.95 MHz 落 5 MHz 档', checkNtnBandwidth('3GPP NR-NTN', 4950).fitKHz === 5000)
ok('NR-NTN 12 MHz 落 15 MHz 档', checkNtnBandwidth('3GPP NR-NTN', 12000).fitKHz === 15000)
ok('NR-NTN 25 MHz 落 30 MHz 档（Rel-18 n255）', checkNtnBandwidth('3GPP NR-NTN', 25000).fitKHz === 30000)
ok('NR-NTN 30 MHz 边界不算超', checkNtnBandwidth('3GPP NR-NTN', 30000).level === 'ok')

ok('两个 3GPP 体制都在限值表内', isNtnStandard('3GPP NR-NTN') && isNtnStandard('3GPP NB-IoT NTN'))
ok('限值表档位单调递增', Object.values(NTN_BW_LIMITS).every((L) => L.steps.every((s, i) => i === 0 || s > L.steps[i - 1])))

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
