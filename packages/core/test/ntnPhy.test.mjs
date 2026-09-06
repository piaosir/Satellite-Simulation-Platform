// 3GPP NTN 物理层口径：占用带宽 / 信道带宽 / TBS / 信息速率 / 含重复的有效门限。运行：npm test
//
// 锁定五件事：
//   ① TS 38.101-5 的「信道带宽 ↔ N_RB」逐值不变，且信道带宽反查取「装得下的最小档」；
//   ② 占用带宽 B_occ = N_RB×12×SCS —— 它是每 RE SNR 的噪声带宽，整套口径的地基，动一位就全错；
//   ③ TS 38.214 §5.1.3.2 精确 TBS 的两个手算校验值 + 量化表 93 档首尾与单调；
//   ④ NB-IoT 的 TBS/RU 时长两个校验值，以及越界返回 null（不静默回落到相邻档）；
//   ⑤ 引擎侧（CJS，packages/core）与渲染侧（ESM，src/shared/ntnPhy.js）两份实现【逐条同值】：
//      载波面板要在渲染端实时算占用带宽与信息速率，走 IPC 问不现实，只能各留一份，那就必须对拍。
import { createRequire } from 'module'
import * as R from '../../../src/shared/ntnPhy.js'
const require = createRequire(import.meta.url)
const C = require('../utils/ntnPhy.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps) => a != null && b != null && Math.abs(a - b) <= (eps == null ? 1e-9 : eps)

/* ---- ① 信道带宽 ↔ N_RB（TS 38.101-5 V19.5.0 Table 5.3.2-1 / 5.3.2-2）---- */
// FR1 与 FR2 必须分成两张：同一个 60 kHz / 50 MHz，FR1 是 65 RB、FR2 是 66 RB。
const RB1_15 = { 3: 15, 5: 25, 10: 52, 15: 79, 20: 106, 25: 133, 30: 160, 35: 188, 50: 270 }
const RB1_30 = { 5: 11, 10: 24, 15: 38, 20: 51, 25: 65, 30: 78, 35: 92, 50: 133, 70: 189, 100: 273 }
const RB1_60 = { 10: 11, 15: 18, 20: 24, 25: 31, 30: 38, 35: 44, 50: 65, 70: 93, 100: 135 }
const RB2_60 = { 50: 66, 100: 132, 200: 264 }
const RB2_120 = { 50: 32, 100: 66, 200: 132, 400: 264 }
ok('FR1-NTN 15 kHz 档 N_RB 逐值 = Table 5.3.2-1（3…50 MHz → 15/25/52/79/106/133/160/188/270）',
  JSON.stringify(C.nrRbTable(15, 1)) === JSON.stringify(RB1_15))
ok('FR1-NTN 30 kHz 档 N_RB 逐值 = 原表（到 100 MHz = 273 RB）', JSON.stringify(C.nrRbTable(30, 1)) === JSON.stringify(RB1_30))
ok('FR1-NTN 60 kHz 档 N_RB 逐值 = 原表', JSON.stringify(C.nrRbTable(60, 1)) === JSON.stringify(RB1_60))
ok('FR2-NTN 60 kHz 档 N_RB 逐值 = Table 5.3.2-2', JSON.stringify(C.nrRbTable(60, 2)) === JSON.stringify(RB2_60))
ok('FR2-NTN 120 kHz 档 N_RB 逐值 = Table 5.3.2-2', JSON.stringify(C.nrRbTable(120, 2)) === JSON.stringify(RB2_120))
// ★ 这一条是拆表的理由本身：合成一张表就是同一个键两个值，谁后写谁赢
ok('★ 60 kHz / 50 MHz 两个 FR 不同值：FR1 = 65 RB、FR2 = 66 RB',
  C.nrRbTable(60, 1)[50] === 65 && C.nrRbTable(60, 2)[50] === 66)
ok('FR1 没有 120 kHz、FR2 没有 15 / 30 kHz（别凭插值造一档）',
  C.nrRbTable(120, 1) === null && C.nrRbTable(15, 2) === null && C.nrRbTable(30, 2) === null)
ok('没有 5 MHz@60 kHz 这一档', C.nrRbTable(60, 1)[5] === undefined)
ok('认不出的 SCS 返回 null（不回落到 15 kHz）', C.nrRbTable(45, 1) === null && C.nrRbTable('x', 1) === null)

/* ---- ①ᵇ NTN 频段表（Table 5.2.2-1 / 5.2.3-1 / 5.3.5-1 / 5.3.5-2）---- */
// 逐频段的信道带宽档是【另一张表】：只看 N_RB 表，5 MHz@30 kHz、n254 的 20 MHz、任何频段的
// 30 MHz 都配得出来 —— 标准里没有这些载波。
{
  const B = C.NTN_BANDS
  const keys = Object.keys(B)
  ok('NTN 频段共 14 个：FR1 九个（n256…n247）+ FR2 五个（n512…n508）',
    keys.join(',') === 'n256,n255,n254,n253,n252,n251,n250,n248,n247,n512,n511,n510,n509,n508', keys.join(','))
  ok('FR 归属逐条不变（n248/n247 是 FR1 的 Ku，n509/n508 是 FR2 的 Ku）',
    keys.filter((k) => B[k].fr === 1).join(',') === 'n256,n255,n254,n253,n252,n251,n250,n248,n247' &&
    keys.filter((k) => B[k].fr === 2).join(',') === 'n512,n511,n510,n509,n508')
  // 频率范围逐值（Table 5.2.2-1 / 5.2.3-1，MHz，UL / DL）
  const FREQ = {
    n256: [[1980, 2010], [2170, 2200]], n255: [[1626.5, 1660.5], [1525, 1559]],
    n254: [[1610, 1626.5], [2483.5, 2500]], n253: [[1668, 1675], [1518, 1525]],
    n252: [[2000, 2020], [2180, 2200]], n251: [[1626.5, 1660.5], [1518, 1559]],
    n250: [[1668, 1675], [1518, 1559]], n248: [[14000, 14500], [10700, 12750]],
    n247: [[13750, 14000], [10700, 12750]], n512: [[27500, 30000], [17300, 20200]],
    n511: [[28350, 30000], [17300, 20200]], n510: [[27500, 28350], [17300, 20200]],
    n509: [[14000, 14500], [10700, 12750]], n508: [[13750, 14000], [10700, 12750]]
  }
  ok('各频段的收发频率范围逐值 = 原表',
    keys.every((k) => JSON.stringify([B[k].ul, B[k].dl]) === JSON.stringify(FREQ[k])),
    keys.filter((k) => JSON.stringify([B[k].ul, B[k].dl]) !== JSON.stringify(FREQ[k])).join(','))
  // 逐频段档位：'3o' = 3 MHz 本版可选、'10d' = 10 MHz 只用于下行
  const tag = (e) => String(e.mhz) + (e.optional ? 'o' : '') + (e.dlOnly ? 'd' : '')
  const listOf = (k, scs) => ((B[k].bw[scs] || []).map(tag).join(' '))
  const WANT = {
    n256: ['3o 5 10 15 20', '10 15 20', '10 15 20'], n255: ['3o 5 10 15 20', '10 15 20', '10 15 20'],
    n254: ['3o 5 10 15', '10 15', '10 15'], n253: ['5', '', ''],
    n252: ['5 10 15 20', '10 15 20', '10 15 20'], n251: ['5 10 15 20', '10 15 20', '10 15 20'],
    n250: ['5 10d 15d 20d', '10d 15d 20d', '10d 15d 20d'],
    n248: ['10 15 25 35 50', '10 20 25 35 50 70 100', ''], n247: ['10 15 25 35 50', '10 20 25 35 50 70 100', '']
  }
  const badFr1 = Object.keys(WANT).filter((k) =>
    [15, 30, 60].some((scs, i) => listOf(k, scs) !== WANT[k][i]))
  ok('FR1-NTN 逐频段信道带宽档逐值 = Table 5.3.5-1（含 3 MHz 可选、n250 的仅下行）',
    badFr1.length === 0, badFr1.map((k) => k + ':' + [15, 30, 60].map((c) => listOf(k, c)).join('|')).join(' '))
  const badFr2 = ['n512', 'n511', 'n510'].filter((k) =>
    listOf(k, 60) !== '50 100 200o' || listOf(k, 120) !== '50 100 200o 400o')
  ok('FR2-NTN n512/n511/n510 逐值 = Table 5.3.5-2', badFr2.length === 0,
    badFr2.map((k) => listOf(k, 60) + ' / ' + listOf(k, 120)).join(' '))
  ok('FR2-NTN n509/n508 只有 120 kHz；n508 的 400 MHz 是可选且仅下行',
    listOf('n509', 60) === '' && listOf('n509', 120) === '50 100 200o 400o' &&
    listOf('n508', 60) === '' && listOf('n508', 120) === '50 100 200o 400od',
    listOf('n509', 120) + ' / ' + listOf('n508', 120))
  // ★ 30 MHz 在 5.3.5-1 里一个频段都没有：CR 0033 只往 N_RB 表加了一列
  ok('★ 30 MHz 不在任何频段的档位里（N_RB 表有 160/78/38，逐频段表没有）',
    keys.every((k) => [15, 30, 60, 120].every((scs) => (B[k].bw[scs] || []).every((e) => e.mhz !== 30))) &&
    C.nrRbTable(15, 1)[30] === 160 && C.nrRbTable(30, 1)[30] === 78 && C.nrRbTable(60, 1)[30] === 38)
}

/* ---- ①ᶜ 频段 × 子载波间隔 × 信道带宽的组合校验 ---- */
{
  const rv = (o) => C.resolve(Object.assign({ kind: 'nr', dir: 'dl', scs: 15, nRb: 25 }, o), 2, 0.5)
  ok('5 MHz@30 kHz 报错（任何 NTN 频段的 30 kHz 一行都没有 5 MHz）',
    /没有 5 MHz 这一档/.test(rv({ scs: 30, nRb: 11, chBwMHz: 5 }).error), rv({ scs: 30, nRb: 11, chBwMHz: 5 }).error)
  ok('n254 的 20 MHz 报错（它是 16.5 MHz 宽的频段，15 kHz 只到 15 MHz）',
    /n254 .*没有 20 MHz/.test(rv({ band: 'n254', nRb: 106, chBwMHz: 20 }).error), rv({ band: 'n254', nRb: 106, chBwMHz: 20 }).error)
  ok('30 MHz 对每一个频段都报错',
    Object.keys(C.NTN_BANDS).every((b) => rv({ band: b, scs: 15, nRb: 160, chBwMHz: 30 }).error !== ''))
  ok('n248（Ku）30 kHz / 100 MHz = 273 PRB 算得通',
    rv({ band: 'n248', scs: 30, nRb: 273, chBwMHz: 100 }).error === '' &&
    rv({ band: 'n248', scs: 30, nRb: 273, chBwMHz: 100 }).bOccKHz === 273 * 12 * 30)
  ok('n250 的 10 MHz 只用于下行：上行选它报错，下行算得通',
    /只用于下行/.test(rv({ band: 'n250', dir: 'ul', scs: 15, nRb: 52, chBwMHz: 10 }).error) &&
    rv({ band: 'n250', dir: 'dl', scs: 15, nRb: 52, chBwMHz: 10 }).error === '')
  ok('n253 只有 15 kHz / 5 MHz 一档；给它 30 kHz 报「没有这一档子载波间隔」',
    rv({ band: 'n253', scs: 15, nRb: 25, chBwMHz: 5 }).error === '' &&
    /没有 30 kHz 这一档子载波间隔/.test(rv({ band: 'n253', scs: 30, nRb: 11 }).error))
  ok('认不出的频段名报错（不静默换一个）', /不在 TS 38.101-5 的频段表里/.test(rv({ band: 'n999' }).error))
  ok('PRB 数按【该频段】的顶格判，不按表级上限（n256@15 kHz 顶格 20 MHz = 106 PRB）',
    /超出 n256 .*106 PRB/.test(rv({ band: 'n256', nRb: 200 }).error) &&
    rv({ band: 'n248', nRb: 200, scs: 15 }).error === '', rv({ band: 'n256', nRb: 200 }).error)
  ok('老配置不指定频段：按该 FR 所有频段的并集放行（逐位照旧算得通）',
    rv({ band: '', nRb: 25, chBwMHz: 5 }).error === '' && C.normalizePhy({ kind: 'nr' }).band === '')
}

/* ---- ①ᵈ FR 归属决定 N_RB 表与开销系数，不由子载波间隔决定 ---- */
ok('frOf：给了频段按频段的 FR，没给按子载波间隔兜底（120 kHz 只在 FR2）',
  C.frOf({ band: 'n510', scs: 60 }) === 2 && C.frOf({ band: 'n256', scs: 60 }) === 1 &&
  C.frOf({ band: '', scs: 60 }) === 1 && C.frOf({ band: '', scs: 120 }) === 2)
{
  // ★ 原来 ohOf 按 scs >= 120 判 FR2，于是 n510-n512 的 60 kHz 配置拿的是 FR1 的开销（0.14/0.08）
  const mk = (o) => C.normalizePhy(Object.assign({ kind: 'nr', scs: 60, nRb: 60, rateModel: 'oh38306' }, o))
  const rate = (o, Qm, R) => C.nrInfoRateKbps(mk(o), Qm, R)
  const ohBack = (o) => 1 - rate(o, 2, 0.5) / (C.nrOccupiedBwKHz(mk(o)) * (14 / 15) * 2 * 0.5)
  ok('★ ohOf(n510, 60 kHz) 取 FR2 的 0.18 / 0.10（不是 FR1 的 0.14 / 0.08）',
    near(ohBack({ band: 'n510', dir: 'dl' }), 0.18, 1e-9) && near(ohBack({ band: 'n510', dir: 'ul' }), 0.10, 1e-9),
    ohBack({ band: 'n510', dir: 'dl' }).toFixed(4) + ' / ' + ohBack({ band: 'n510', dir: 'ul' }).toFixed(4))
  ok('ohOf(n256, 60 kHz) 仍取 FR1 的 0.14 / 0.08',
    near(ohBack({ band: 'n256', dir: 'dl' }), 0.14, 1e-9) && near(ohBack({ band: 'n256', dir: 'ul' }), 0.08, 1e-9))
}

const nr = (o) => C.normalizePhy(Object.assign({ kind: 'nr', dir: 'dl', scs: 15, nRb: 25 }, o))
ok('占用带宽 = N_RB×12×SCS：25 RB@15 kHz = 4500 kHz', C.nrOccupiedBwKHz(nr({})) === 4500)
ok('占用带宽：106 RB@15 kHz = 19080 kHz', C.nrOccupiedBwKHz(nr({ nRb: 106 })) === 19080)
ok('占用带宽：51 RB@30 kHz = 18360 kHz', C.nrOccupiedBwKHz(nr({ scs: 30, nRb: 51 })) === 18360)
ok('信道带宽反查：25 RB@15 kHz → 5000 kHz', C.nrChannelBwKHz(nr({})) === 5000)
ok('信道带宽反查：30 RB@15 kHz → 10 MHz 档（取装得下的最小档，不是最近档）',
  C.nrChannelBwKHz(nr({ nRb: 30 })) === 10000)
ok('信道带宽反查：106 RB@15 kHz → 20 MHz', C.nrChannelBwKHz(nr({ nRb: 106 })) === 20000)
ok('显式给了 chBwMHz 就用它（上行小分配落在大信道里）',
  C.nrChannelBwKHz(nr({ nRb: 1, chBwMHz: 20 })) === 20000)
ok('装不下任何档时退回占用带宽（不报假信道带宽）',
  C.nrChannelBwKHz(nr({ nRb: 300 })) === 300 * 12 * 15)
// ★ 上行是一个终端的分配，不是整载波：拿「装得下 1 PRB 的最小档」当它的载波带宽，
//   会把 180 kHz 的 PUSCH 报成 5 MHz，转发器带宽占用比虚高 27 倍
ok('上行不查档位表：信道带宽 = 占用带宽（1 PRB → 180 kHz，不是 5 MHz）',
  C.nrChannelBwKHz(nr({ dir: 'ul', nRb: 1 })) === 180 &&
  C.nrChannelBwKHz(nr({ dir: 'dl', nRb: 1 })) === 5000)
ok('上行显式给了信道带宽仍以它为准（要按整载波算占用时用）',
  C.nrChannelBwKHz(nr({ dir: 'ul', nRb: 1, chBwMHz: 5 })) === 5000)
// 任务书 §3.4：信道带宽当噪声带宽会低报 0.18~0.46 dB，故它只用于档位核对
const dbCh = 10 * Math.log10(5000 / 4500)
ok('信道带宽 vs 占用带宽的差 = 0.457 dB（5 MHz@15 kHz），故不拿信道带宽当噪声带宽', near(dbCh, 0.4576, 5e-4))

/* ---- ② 信息速率：RE 速率恒 = B_occ × 14/15，TS 38.306 校验值 85.07 Mbps ---- */
// N_RB·12/T_s（T_s = 1ms/(14·2^μ)）≡ B_occ·14/15 —— 这个恒等式是 oh38306 模型能写成带宽式的前提
for (const [scs, nRb] of [[15, 106], [30, 51], [60, 24], [120, 66]]) {
  const p = nr({ scs, nRb })
  const mu = C.MU_OF[scs]
  ok(`RE 速率恒等式 ${scs} kHz × ${nRb} RB：N_RB·12/T_s = B_occ·14/15`,
    near(nRb * 12 / (1e-3 / (14 * Math.pow(2, mu))), C.nrOccupiedBwKHz(p) * 1000 * 14 / 15, 1e-3))
}
const p38306 = nr({ nRb: 106, rateModel: 'oh38306' })   // 20 MHz@15 kHz、64QAM 948/1024、ν=1、OH 0.14
ok('TS 38.306 §4.1.2 校验值：106 RB@15 kHz、64QAM 948/1024、OH 0.14 → 85.07 Mbps',
  near(C.nrInfoRateKbps(p38306, 6, 948 / 1024) / 1000, 85.07, 5e-3),
  (C.nrInfoRateKbps(p38306, 6, 948 / 1024) / 1000).toFixed(4) + ' Mbps')
ok('OH 缺省按方向取：下行 0.14 / 上行 0.08（FR1）',
  near(C.nrInfoRateKbps(nr({ nRb: 106, rateModel: 'oh38306', dir: 'ul' }), 6, 948 / 1024)
     / C.nrInfoRateKbps(p38306, 6, 948 / 1024), (1 - 0.08) / (1 - 0.14), 1e-12))
ok('FR2（120 kHz）OH 取 0.18 / 0.10',
  near(C.nrInfoRateKbps(nr({ scs: 120, nRb: 66, rateModel: 'oh38306', dir: 'ul' }), 6, 0.5)
     / C.nrInfoRateKbps(nr({ scs: 120, nRb: 66, rateModel: 'oh38306' }), 6, 0.5), (1 - 0.10) / (1 - 0.18), 1e-12))
ok('显式 oh 覆盖缺省', near(C.nrInfoRateKbps(nr({ nRb: 106, rateModel: 'oh38306', oh: 0 }), 6, 948 / 1024),
  19080 * (14 / 15) * 6 * (948 / 1024), 1e-6))

/* ---- ③ TS 38.214 §5.1.3.2 精确 TBS ---- */
ok('量化表 Table 5.1.3.2-1 共 93 档', C.TBS_QUANT.length === 93)
ok('量化表首 24 末 3824', C.TBS_QUANT[0] === 24 && C.TBS_QUANT[92] === 3824)
ok('量化表严格递增', C.TBS_QUANT.every((v, i) => i === 0 || v > C.TBS_QUANT[i - 1]))
ok('量化表全是 8 的整数倍（TBS 恒是字节对齐的）', C.TBS_QUANT.every((v) => v % 8 === 0))
// 校验值一：1 PRB、14 符号、DMRS 12 RE、表1 MCS0(QPSK 120/1024) → N_RE 156、N_info 36.56 → TBS 32
const tbsA = nr({ nRb: 1, nSymb: 14, nDmrs: 12 })
ok('精确 TBS 校验值①：1 PRB / 14 符号 / DMRS 12 / MCS0 → 32 bit/时隙',
  C.nrTbsPerSlot(tbsA, 2, 120 / 1024) === 32)
ok('  → 15 kHz 下 32 bit/时隙 = 32 kbps', C.nrInfoRateKbps(tbsA, 2, 120 / 1024) === 32)
ok('  → 30 kHz 下时隙缩一半，速率翻倍 = 64 kbps',
  C.nrInfoRateKbps(nr({ scs: 30, nRb: 1, nSymb: 14, nDmrs: 12 }), 2, 120 / 1024) === 64)
// 校验值二：25 PRB、14 符号、DMRS 12 RE、MCS9(QPSK 679/1024) → N_info 5172.07 → N'_info 5120 → TBS 5120
const tbsB = nr({ nRb: 25, nSymb: 14, nDmrs: 12 })
ok('精确 TBS 校验值②：25 PRB / MCS9 → 5120 bit/时隙（走 >3824 的那条分支）',
  C.nrTbsPerSlot(tbsB, 2, 679 / 1024) === 5120)
ok('  → 15 kHz 下 = 5.12 Mbps', C.nrInfoRateKbps(tbsB, 2, 679 / 1024) === 5120)
ok('N_RE 每 PRB 封顶 156（12×14=168 减 DMRS 12 正好 156；符号再多也不涨）',
  C.nrTbsPerSlot(nr({ nRb: 1, nSymb: 14, nDmrs: 0 }), 2, 120 / 1024) ===
  C.nrTbsPerSlot(nr({ nRb: 1, nSymb: 14, nDmrs: 12 }), 2, 120 / 1024))
ok('xOverhead 扣掉 RE：nOh 18 比 nOh 0 的 TBS 小',
  C.nrTbsPerSlot(nr({ nRb: 25, nOh: 18 }), 6, 0.9) < C.nrTbsPerSlot(nr({ nRb: 25, nOh: 0 }), 6, 0.9))
ok('DL 缺省 12 符号（留 2 个给 PDCCH）、UL 缺省 14 符号',
  nr({}).nSymb === 12 && C.normalizePhy({ kind: 'nr', dir: 'ul' }).nSymb === 14)
ok('TBS 随 MCS 单调不降（表1 全 29 档，25 PRB）', (() => {
  const R1024 = [120, 157, 193, 251, 308, 379, 449, 526, 602, 679, 340, 378, 434, 490, 553, 616, 658,
    438, 466, 517, 567, 616, 666, 719, 772, 822, 873, 910, 948]
  const Qm = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 4, 4, 4, 4, 4, 4, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6]
  let prev = -1
  for (let i = 0; i < 29; i++) {
    const t = C.nrTbsPerSlot(tbsB, Qm[i], R1024[i] / 1024)
    if (t == null || t < prev) return false
    prev = t
  }
  return true
})())
ok('调制阶数或码率无效时返回 null（不按 QPSK 静默垫）',
  C.nrTbsPerSlot(tbsB, 0, 0.5) === null && C.nrTbsPerSlot(tbsB, 2, 0) === null)

/* ---- ④ NB-IoT ---- */
const nb = (o) => C.normalizePhy(Object.assign({ kind: 'nbiot', dir: 'ul', scs: 15, nTones: 12 }, o))
ok('NB-IoT TBS 表 14 行（I_TBS 0–13，Rel-14 全表）', C.NB_TBS_UL.length === 14 && C.NB_TBS_DL.length === 14)
ok('Rel-14 表没有空格（Rel-13 那 32 个空档全填上了）',
  C.NB_TBS_DL.every((r) => r.length === 8 && r.every((v) => v > 0)) &&
  C.NB_TBS_UL.every((r) => r.length === 8 && r.every((v) => v > 0)))
ok('Rel-13 的每一格原值不变（上行 (6,7) 仍 1000、(7,5) 仍 712）',
  C.NB_TBS_UL[6][7] === 1000 && C.NB_TBS_UL[7][5] === 712)
ok('(I_TBS 12, I_RU 7) = 2280（Rel-13 这一格是空的）', C.NB_TBS_UL[12][7] === 2280)
// ★ V14.2.0 印 1128、V17.4.0 / V18.3.0 印 1032 —— 以新版为准，别按 Rel-14 老文本改回去
ok('★ (I_TBS 13, I_SF 3) = 1032（新版值，不是 V14.2.0 的 1128）',
  C.NB_TBS_DL[13][3] === 1032 && C.NB_TBS_UL[13][3] === 1032)
ok('(I_TBS 13, I_RU 7) = 2536', C.NB_TBS_UL[13][7] === 2536 && C.NB_TBS_DL[13][7] === 2536)
ok('I_SF / I_RU → 子帧数/RU 数 = 1,2,3,4,5,6,8,10', C.NB_SF_COUNT.join(',') === '1,2,3,4,5,6,8,10')
// 校验值一：单音 15 kHz、I_TBS 0、I_RU 0、N_rep 1 → 16 bit / 8 ms = 2 kbps，噪声带宽 15 kHz
const nbA = nb({ nTones: 1, iTbs: 0, iRu: 0 })
ok('NB-IoT 校验值①：单子载波 15 kHz / I_TBS 0 / I_RU 0 → 2 kbps',
  C.nbTbs(nbA) === 16 && C.nbRuMs(nbA) === 8 && C.nbInfoRateKbps(nbA) === 2)
ok('  → 噪声带宽 = 子载波数×SCS = 15 kHz（不是 180 kHz，差 10.8 dB）',
  C.nbOccupiedBwKHz(nbA) === 15 && near(10 * Math.log10(180 / 15), 10.79, 5e-3))
// 校验值二：12 音、I_TBS 12、I_RU 3 → 1000 bit / 4 ms = 250 kbps，噪声带宽 180 kHz
const nbB = nb({ nTones: 12, iTbs: 12, iRu: 3 })
ok('NB-IoT 校验值②：12 子载波 / I_TBS 12 / I_RU 3 → 250 kbps',
  C.nbTbs(nbB) === 1000 && C.nbRuMs(nbB) === 1 && C.nbInfoRateKbps(nbB) === 250)
// ★ 上行的信道带宽 ≡ 占用带宽：一条上行载波是一个终端的分配，占的就是自己那几个子载波，
//   不该把 200 kHz 栅格里的保护带算进去（与 NR 上行同一把尺）。下行才是整载波的 200 kHz。
ok('  → 上行 12 子载波：噪声带宽与信道带宽同为 180 kHz',
  C.nbOccupiedBwKHz(nbB) === 180 && C.nbChannelBwKHz(nbB) === 180)
ok('  → 下行整载波才是 200 kHz 栅格（占用仍 180）',
  C.nbChannelBwKHz(nb({ dir: 'dl', iTbs: 4, iSf: 3 })) === 200 &&
  C.nbOccupiedBwKHz(nb({ dir: 'dl', iTbs: 4, iSf: 3 })) === 180)
// ★ NPDSCH 的载波结构定死：下行给什么子载波间隔/子载波数都归位到 12 × 15 kHz = 180 kHz
//   （3.75 kHz 与少于 12 个子载波都只存在于上行 NPUSCH）
ok('  → 下行强制 12 子载波 × 15 kHz：填 3.75 kHz / 单子载波也归位',
  (() => { const d = C.normalizePhy({ kind: 'nbiot', dir: 'dl', scs: 3.75, nTones: 1, iTbs: 4, iSf: 3 })
    return d.scs === 15 && d.nTones === 12 && C.nbOccupiedBwKHz(d) === 180 })())
ok('Rel-14 起 I_TBS 12 / I_RU 7 是合法格（2280 bit，Rel-13 时它是空的）',
  C.nbTbs(nb({ iTbs: 12, iRu: 7 })) === 2280 && C.nbInfoRateKbps(nb({ iTbs: 12, iRu: 7 })) === 228)
ok('I_TBS 13 收录了（Cat-NB2）', C.nbTbs(nb({ iTbs: 13, iRu: 0 })) === 224)
ok('I_TBS 14 报「16QAM 档为 Rel-17 的 14–21」（不静默按 13 档算）',
  /16QAM 档为 Rel-17/.test(C.resolve({ kind: 'nbiot', dir: 'ul', nTones: 12, iTbs: 14, iRu: 0 }, 2, 0.5).error),
  C.resolve({ kind: 'nbiot', dir: 'ul', nTones: 12, iTbs: 14, iRu: 0 }, 2, 0.5).error)
// 每行的合法上限：Cat-NB1 的 TBS 有天花板（下行 680 bit / 上行 1000 bit），I_TBS 越高行越短
ok('nbMaxSfIdx：Rel-14 全表没有空格，14 行一律 7',
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].every((i) =>
    C.nbMaxSfIdx(nb({ dir: 'dl', iTbs: i })) === 7 && C.nbMaxSfIdx(nb({ dir: 'ul', iTbs: i })) === 7) &&
  C.nbMaxSfIdx(nb({ iTbs: 14 })) === -1)

/* ---- ④ᵈ 部署模式（P2-4）：带内的 NPDSCH 只到 I_TBS 10 ---- */
ok('部署模式缺省独立（NTN 的典型形态），只认 standalone / guardband / inband',
  nb({}).opMode === 'standalone' && nb({ opMode: 'inband' }).opMode === 'inband' &&
  nb({ opMode: 'guardband' }).opMode === 'guardband' && nb({ opMode: 'lte' }).opMode === 'standalone')
{
  const dl = (o) => C.resolve(Object.assign({ kind: 'nbiot', dir: 'dl', iSf: 0 }, o), 2, 0.5)
  const ul = (o) => C.resolve(Object.assign({ kind: 'nbiot', dir: 'ul', nTones: 12, iRu: 0 }, o), 2, 0.5)
  ok('带内部署的 NPDSCH 只到 I_TBS 10（TS 36.213 §16.4.1.5.1）',
    /带内部署的 NPDSCH 只到 I_TBS 10/.test(dl({ opMode: 'inband', iTbs: 11 }).error) &&
    dl({ opMode: 'inband', iTbs: 10 }).error === '', dl({ opMode: 'inband', iTbs: 11 }).error)
  ok('★ NPUSCH 不受这一条限制（带内 I_TBS 11/13 照旧算得通）',
    ul({ opMode: 'inband', iTbs: 11 }).error === '' && ul({ opMode: 'inband', iTbs: 13 }).error === '')
  ok('独立 / 保护带部署的 NPDSCH 到 I_TBS 13',
    dl({ opMode: 'standalone', iTbs: 13 }).error === '' && dl({ opMode: 'guardband', iTbs: 13 }).error === '')
}

/* ---- ④ᵉ 有效码率（P2-5）：分母按 TS 36.211 的结构算，不是编出来的 264 ---- */
ok('每传输块编码比特数：NPDSCH 独立 304 / 带内 208、NPUSCH 多音 288 / 单音 96×Qm',
  JSON.stringify(C.NB_CODED_BITS) === JSON.stringify({ dlStandalone: 304, dlInband: 208, ulMulti: 288, ulSingle: 96 }) &&
  C.NB_CRC_BITS === 24)
{
  const cb = (o) => C.nbCodedBitsPerUnit(C.normalizePhy(Object.assign({ kind: 'nbiot' }, o)))
  ok('分母随部署模式与子载波数走（下行 304 / 208；多音 3/6/12 都是 288；单音 BPSK 96、QPSK 192）',
    cb({ dir: 'dl' }) === 304 && cb({ dir: 'dl', opMode: 'inband' }) === 208 &&
    [3, 6, 12].every((t) => cb({ dir: 'ul', nTones: t }) === 288) &&
    cb({ dir: 'ul', nTones: 1, iTbs: 0 }) === 96 && cb({ dir: 'ul', nTones: 1, iTbs: 2 }) === 96 &&
    cb({ dir: 'ul', nTones: 1, iTbs: 1 }) === 192 && cb({ dir: 'ul', nTones: 1, iTbs: 5 }) === 192)
  const cr = (o) => C.nbCodeRate(C.normalizePhy(Object.assign({ kind: 'nbiot' }, o)))
  ok('有效码率 =（TBS + 24 bit CRC）/（每单元编码比特数 × 单元数）',
    near(cr({ dir: 'dl', iTbs: 4, iSf: 0 }), 80 / 304, 1e-12) &&
    near(cr({ dir: 'dl', iTbs: 4, iSf: 3 }), (256 + 24) / (304 * 4), 1e-12) &&
    near(cr({ dir: 'ul', nTones: 12, iTbs: 0, iRu: 0 }), 40 / 288, 1e-12))
  ok('★ 带内部署 (I_TBS 10, I_SF 0) 的码率 = (144 + 24) / 208',
    near(cr({ dir: 'dl', opMode: 'inband', iTbs: 10, iSf: 0 }), 168 / 208, 1e-12),
    String(cr({ dir: 'dl', opMode: 'inband', iTbs: 10, iSf: 0 })))
  ok('码率恒 ≤ 1（分母抄错会当场露馅）', (() => {
    for (const dir of ['dl', 'ul']) for (const nTones of [1, 3, 12]) {
      // 单子载波只到 I_TBS 10（下一条断言管这件事）
      const top = (dir === 'ul' && nTones === 1) ? 10 : 13
      for (let iTbs = 0; iTbs <= top; iTbs++) for (let i = 0; i <= 7; i++) {
        const v = cr({ dir, nTones, iTbs, iSf: i, iRu: i })
        if (v == null || !(v > 0) || v > 1) return false
      }
    }
    return true
  })())
  // ★ 上一条断言顺手挖出来的：单音的 I_TBS 只到 10（Table 16.5.1.2-1 的单音行只有 I_MCS 0–10），
  //   11–13 那三档单音根本取不到；放任它算，「有效码率」会算出 1.04~1.33 这种 >1 的数。
  ok('★ NPUSCH 单子载波 I_TBS 11–13 报错（标准的单音行只到 I_MCS 10）',
    [11, 12, 13].every((t) => /单子载波只到 I_TBS 10/.test(
      C.resolve({ kind: 'nbiot', dir: 'ul', nTones: 1, iTbs: t, iRu: 0 }, 2, 0.5).error)) &&
    C.resolve({ kind: 'nbiot', dir: 'ul', nTones: 1, iTbs: 10, iRu: 0 }, 2, 0.5).error === '',
    C.resolve({ kind: 'nbiot', dir: 'ul', nTones: 1, iTbs: 11, iRu: 0 }, 2, 0.5).error)
}

/* ---- ④ᶠ Kodheli 表 3 的 SE 列反推：证明 Rel-14 表抄对了 ---- */
// 每档取最大吞吐：max_i TBS(I_TBS, i) / (N_SF(i) × 1 ms) / 180 kHz 必须等于表 3 的 SE 列。
// 25/28 格逐值吻合（1e-4）；三格不吻合，各有出处：
//   · I_TBS 3 / 4 两列都差 ±0.002 —— 作者自己那一档的取整
//   · I_TBS 12 的【下行】印 1.3889 = 1000/4/180，而 1000 是 NPUSCH 表那一格；NPDSCH 表这一格是
//     904（→ 1.2667）。即他们的下行 SE 抄了上行的数。这一条反过来证明本平台的下行表没抄错。
{
  const KOD_DL = [0.1444, 0.2, 0.2667, 0.324, 0.3867, 0.4844, 0.5733, 0.68, 0.7611, 0.8722, 0.9689, 1.1244, 1.3889, 1.4333]
  const KOD_MT = [0.1444, 0.2, 0.2667, 0.324, 0.3867, 0.4844, 0.5611, 0.6944, 0.7689, 0.8722, 0.9689, 1.1244, 1.3889, 1.4333]
  const seOf = (row) => Math.max(...row.map((t, i) => t / C.NB_SF_COUNT[i])) / 180
  const SKIP = [3, 4]
  const badDl = [], badMt = []
  for (let i = 0; i < 14; i++) {
    if (SKIP.indexOf(i) > -1) continue
    if (i !== 12 && Math.abs(seOf(C.NB_TBS_DL[i]) - KOD_DL[i]) > 1e-4) badDl.push(i + ':' + seOf(C.NB_TBS_DL[i]).toFixed(4))
    if (Math.abs(seOf(C.NB_TBS_UL[i]) - KOD_MT[i]) > 1e-4) badMt.push(i + ':' + seOf(C.NB_TBS_UL[i]).toFixed(4))
  }
  ok('Rel-14 下行表能反推出 Kodheli 表 3 的 NPDSCH SE 列（11/12 档，1e-4）', badDl.length === 0, badDl.join(' '))
  ok('Rel-14 上行表能反推出 Kodheli 表 3 的 NPUSCH 多音 SE 列（12/12 档，1e-4）', badMt.length === 0, badMt.join(' '))
  ok('★ I_TBS 12 的下行 SE：表 3 印 1.3889 取自 NPUSCH 的 1000/4，NPDSCH 这一格是 904 → 1.2667',
    near(seOf(C.NB_TBS_DL[12]), 228 / 180, 1e-9) && near(seOf(C.NB_TBS_UL[12]), 250 / 180, 1e-9) &&
    C.NB_TBS_DL[12][3] === 904 && C.NB_TBS_UL[12][3] === 1000,
    seOf(C.NB_TBS_DL[12]).toFixed(4) + ' vs 印 1.3889')
  ok('I_TBS 6 的两列本就不同（下行 1032/10 = 0.5733、上行 808/8 = 0.5611）',
    near(seOf(C.NB_TBS_DL[6]), 0.5733, 1e-4) && near(seOf(C.NB_TBS_UL[6]), 0.5611, 1e-4))
}
ok('RU 时长：12/6/3 音 = 1/2/4 ms，单音 15 kHz = 8 ms、3.75 kHz = 32 ms',
  C.nbRuMs(nb({ nTones: 12 })) === 1 && C.nbRuMs(nb({ nTones: 6 })) === 2 && C.nbRuMs(nb({ nTones: 3 })) === 4 &&
  C.nbRuMs(nb({ nTones: 1 })) === 8 && C.nbRuMs(nb({ scs: 3.75 })) === 32)
ok('3.75 kHz 只有单音（填 12 音也归正成 1）', nb({ scs: 3.75, nTones: 12 }).nTones === 1)
ok('3.75 kHz 单音噪声带宽 3.75 kHz（比 180 kHz 低 16.8 dB）',
  C.nbOccupiedBwKHz(nb({ scs: 3.75 })) === 3.75 && near(10 * Math.log10(180 / 3.75), 16.81, 5e-3))
ok('下行按 I_SF 取子帧数：NPDSCH I_TBS 4 / I_SF 0 → 56 bit/1 ms = 56 kbps',
  C.nbInfoRateKbps(nb({ dir: 'dl', iTbs: 4, iSf: 0 })) === 56)
ok('下行信道带宽恒 200 kHz、占用 180 kHz', C.nbChannelBwKHz(nb({ dir: 'dl' })) === 200)
ok('单音上行信道带宽 = 占用带宽（没有 200 kHz 栅格可言）', C.nbChannelBwKHz(nb({ nTones: 1 })) === 15)
// 单音 I_MCS → (调制, I_TBS)，TS 36.213 Table 16.5.1.2-1
ok('单音 I_MCS 0/1 是 π/2-BPSK（I_TBS 0/2），2 起是 π/4-QPSK（I_TBS 1,3,4…10）',
  C.nbSingleToneMcs(0).modulation === 'BPSK' && C.nbSingleToneMcs(0).iTbs === 0 &&
  C.nbSingleToneMcs(1).modulation === 'BPSK' && C.nbSingleToneMcs(1).iTbs === 2 &&
  C.nbSingleToneMcs(2).modulation === 'QPSK' && C.nbSingleToneMcs(2).iTbs === 1 &&
  C.nbSingleToneMcs(3).iTbs === 3 && C.nbSingleToneMcs(10).iTbs === 10 && C.NB_ST_MCS.length === 11)
ok('单音 I_MCS 越界返回 null', C.nbSingleToneMcs(11) === null && C.nbSingleToneMcs(-1) === null)

/* ---- ④ᵇ 单音表 / 多音表与子载波数解耦（P1-1）+ 变换预编码表只用于上行（P1-2）---- */
// 根因：面板的「子载波数」下拉对任何 NB-IoT 上行表都给 [1,3,6,12]，而「行号是 I_MCS 还是 I_TBS」
// 却按当前子载波数判 —— 选了单音表再改成 12 音，门限仍是单音那一列（高 1.6~3.8 dB），
// I_MCS 又被当 I_TBS 直读（1↔2 互换）。改法：子载波数由标准锁定（st），不由用户随手改。
ok('st:true（单音表）填 12 子载波也归 1', C.normalizePhy({ kind: 'nbiot', dir: 'ul', st: true, nTones: 12 }).nTones === 1)
ok('st:true 填 3.75 kHz 照旧留 3.75（单音表本就允许这一档）',
  C.normalizePhy({ kind: 'nbiot', dir: 'ul', st: true, scs: 3.75, nTones: 12 }).scs === 3.75)
ok('st:false（多音表）填 3.75 kHz 归 15（3.75 kHz 只有单音）',
  C.normalizePhy({ kind: 'nbiot', dir: 'ul', st: false, scs: 3.75, nTones: 6 }).scs === 15 &&
  C.normalizePhy({ kind: 'nbiot', dir: 'ul', st: false, scs: 3.75, nTones: 6 }).nTones === 6)
{
  // ★ 不归正成 3 音：悄悄换一个用户没选的配置，而门限还是多音那一列，账面上一切正常
  const r = C.resolve({ kind: 'nbiot', dir: 'ul', st: false, nTones: 1, iTbs: 0, iRu: 0 }, 2, 0.5)
  ok('st:false 填 1 子载波 → resolve 报错，不静默归正', r.error === 'NPUSCH 多音表不含单子载波配置' &&
    r.phy.nTones === 1 && r.bOccKHz === null && r.infoRateKbps === null, r.error)
}
ok('st 缺省 null（老配置 / 自建标准不锁，逐位照旧）',
  C.normalizePhy({ kind: 'nbiot', dir: 'ul', nTones: 12 }).st === null &&
  C.normalizePhy({ kind: 'nbiot', dir: 'ul', nTones: 1 }).nTones === 1 &&
  C.resolve({ kind: 'nbiot', dir: 'ul', nTones: 1, iTbs: 0, iRu: 0 }, 2, 0.5).error === '')
ok('变换预编码表强制上行（TS 38.214 §6.1.4.1：PDSCH 没有这两张表）',
  C.normalizePhy({ kind: 'nr', dir: 'dl', mcsTable: 'tp1' }).dir === 'ul' &&
  C.normalizePhy({ kind: 'nr', dir: 'dl', mcsTable: 'tp2' }).dir === 'ul' &&
  C.normalizePhy({ kind: 'nr', dir: 'dl', mcsTable: 'tp1' }).nSymb === 14)
ok('表 1/2/3 收发共用，方向照填的来（transform precoding 关掉的 PUSCH 走 §5.1.3.1 那三张）',
  ['t1', 't2', 't3'].every((t) => C.normalizePhy({ kind: 'nr', dir: 'dl', mcsTable: t }).dir === 'dl' &&
    C.normalizePhy({ kind: 'nr', dir: 'ul', mcsTable: t }).dir === 'ul'))

/* ---- ④ᶜ 重复次数值域（P3-9）---- */
// 现在填 3 或 5000 都照算：门限按 10lg N 白降下来，配出来的是网络根本下发不了的重复次数
ok('NB-IoT 重复次数枚举逐值不变（NPDSCH 16 档到 2048 / NPUSCH 8 档到 128）',
  C.NB_NREP_DL.join(',') === '1,2,4,8,16,32,64,128,192,256,384,512,768,1024,1536,2048' &&
  C.NB_NREP_UL.join(',') === '1,2,4,8,16,32,64,128')
{
  const bad = C.resolve({ kind: 'nbiot', dir: 'ul', nTones: 12, iTbs: 0, iRu: 0, nRep: 3 }, 2, 0.5)
  const over = C.resolve({ kind: 'nbiot', dir: 'ul', nTones: 12, iTbs: 0, iRu: 0, nRep: 256 }, 2, 0.5)
  ok('NPUSCH 重复 3 不在枚举里 → 报错并列出合法值', /不是 NPUSCH 的合法档/.test(bad.error) &&
    bad.error.indexOf('128') > -1 && bad.infoRateKbps === null, bad.error)
  ok('NPUSCH 重复 256 超枚举（NPDSCH 才有这一档）→ 报错', over.error !== '' &&
    C.resolve({ kind: 'nbiot', dir: 'dl', nTones: 12, iTbs: 0, iSf: 0, nRep: 256 }, 2, 0.5).error === '')
  ok('NB-IoT 枚举内的重复次数照旧算得通（16 档 / 8 档全试）',
    C.NB_NREP_DL.every((n) => C.resolve({ kind: 'nbiot', dir: 'dl', nTones: 12, iTbs: 0, iSf: 0, nRep: n }, 2, 0.5).error === '') &&
    C.NB_NREP_UL.every((n) => C.resolve({ kind: 'nbiot', dir: 'ul', nTones: 12, iTbs: 0, iRu: 0, nRep: n }, 2, 0.5).error === ''))
}
{
  // NR 只判上限：PDSCH 16（repetitionNumber-r16/-v1730）、PUSCH 32（numberOfSlotsTBoMS-r17）
  const dlOk = C.resolve({ kind: 'nr', dir: 'dl', scs: 15, nRb: 25, nRep: 16 }, 2, 0.5)
  const dlBad = C.resolve({ kind: 'nr', dir: 'dl', scs: 15, nRb: 25, nRep: 32 }, 2, 0.5)
  const ulOk = C.resolve({ kind: 'nr', dir: 'ul', scs: 15, nRb: 1, nRep: 32 }, 2, 0.5)
  const ulBad = C.resolve({ kind: 'nr', dir: 'ul', scs: 15, nRb: 1, nRep: 64 }, 2, 0.5)
  ok('NR 重复上限：PDSCH 16 / PUSCH 32，超出报错（TS 38.331 V17.5.0）',
    dlOk.error === '' && /超出 PDSCH 上限 16/.test(dlBad.error) &&
    ulOk.error === '' && /超出 PUSCH 上限 32/.test(ulBad.error),
    dlBad.error + ' / ' + ulBad.error)
  ok('NR 不卡枚举（3 / 7 / 12 这些非 2 的幂照算，档位随版本增补）',
    [3, 7, 12].every((n) => C.resolve({ kind: 'nr', dir: 'ul', scs: 15, nRb: 1, nRep: n }, 2, 0.5).error === ''))
}

/* ---- ⑤ 重复折算 ---- */
ok('N_rep 4 → 门限降 6.02 dB', near(C.effectiveThresholdDb(0, nb({ nRep: 4 })), -6.0206, 5e-4))
ok('N_rep 4 + 合并损失 1 dB → −5.02 dB', near(C.effectiveThresholdDb(0, nb({ nRep: 4, combLossDb: 1 })), -5.0206, 5e-4))
ok('N_rep 1 不动门限', C.effectiveThresholdDb(-5.8, nb({ nRep: 1 })) === -5.8)
ok('N_rep 2048（NPDSCH 上限）→ 降 33.1 dB', near(C.effectiveThresholdDb(0, nb({ nRep: 2048 })), -33.11, 5e-3))
ok('重复同时把信息速率除下去（门限降 6 dB、速率降到 1/4）',
  C.nbInfoRateKbps(nb({ nTones: 12, iTbs: 12, iRu: 3, nRep: 4 })) === 250 / 4)
ok('门限非数返回 null', C.effectiveThresholdDb('', nb({})) === null && C.effectiveThresholdDb(null, nb({})) === null)

/* ---- 归一化与 resolve ---- */
ok('非 3GPP 载波 → normalizePhy/resolve 返回 null（DVB 行据此走老链）',
  C.normalizePhy(null) === null && C.normalizePhy({}) === null && C.normalizePhy({ kind: 'dvb' }) === null &&
  C.resolve(undefined, 2, 0.5) === null)
const rv = C.resolve({ kind: 'nr', dir: 'dl', scs: 15, nRb: 25, nSymb: 14, nDmrs: 12 }, 2, 679 / 1024)
ok('resolve 一次算齐：B_occ 4500 / B_ch 5000 / TBS 5120 / 速率 5120 kbps / 无错',
  rv.bOccKHz === 4500 && rv.bChKHz === 5000 && rv.tbs === 5120 && rv.infoRateKbps === 5120 && rv.error === '')
const rvErr = C.resolve({ kind: 'nbiot', dir: 'ul', nTones: 12, iTbs: 14, iRu: 0 }, 2, 0.5)
ok('resolve 越界：error 说清是哪一档，数值字段一律 null（不给半个能用的数）',
  rvErr.error.indexOf('I_TBS=14') > -1 && rvErr.bOccKHz === null && rvErr.infoRateKbps === null && rvErr.tbs === null)
// Rel-14 全表没有空格，「这一格没有」的错法只剩 I_TBS 越界；「上限 + 当前」那条报法留着
// —— 16QAM 档（Rel-17）收进来之后，带内部署的 I_TBS 上限还会用到它。
ok('Rel-14 全表下 13 行 × 8 档 × 收发两向全部算得通（不再有「这一档没有」）', (() => {
  for (const dir of ['dl', 'ul']) for (let iTbs = 0; iTbs <= 13; iTbs++) for (let i = 0; i <= 7; i++) {
    const r = C.resolve({ kind: 'nbiot', dir, nTones: 12, iTbs, iSf: i, iRu: i }, 2, 0.5)
    if (r.error !== '' || !(r.tbs > 0)) return false
  }
  return true
})())
ok('normalizePhy 只读不写，返回全新对象（IPC 过来的纯数据 / 渲染端代理都吃得下）', (() => {
  const src = { kind: 'nr', dir: 'ul', scs: 30, nRb: 1, nRep: 4 }
  const a = C.normalizePhy(src)
  a.nRb = 999
  return src.nRb === 1 && C.normalizePhy(src).nRb === 1 && a !== C.normalizePhy(src)
})())
ok('认不出的 SCS / 音数归正到缺省（15 kHz / 12 音），不抛错',
  C.normalizePhy({ kind: 'nr', scs: 45 }).scs === 15 && nb({ nTones: 7 }).nTones === 12)
ok('nRep 下限 1（填 0 或负数不会把门限抬成 Infinity）',
  nb({ nRep: 0 }).nRep === 1 && nb({ nRep: -3 }).nRep === 1)

/* ---- 描述串（数据，byLang 现造）---- */
ok('describe 中文：NR 下行 · 25 PRB × 15 kHz · 表1 MCS7 · ×1',
  C.describe({ kind: 'nr', dir: 'dl', scs: 15, nRb: 25, mcsTable: 't1', mcs: 7 }, 'zh')
  === 'NR 下行 · 25 PRB × 15 kHz · 表1 MCS7 · ×1')
ok('describe 英文：NR DL · 25 PRB × 15 kHz · T1 MCS7 · ×1',
  C.describe({ kind: 'nr', dir: 'dl', scs: 15, nRb: 25, mcsTable: 't1', mcs: 7 }, 'en')
  === 'NR DL · 25 PRB × 15 kHz · T1 MCS7 · ×1')
ok('describe NB 单音中英',
  C.describe({ kind: 'nbiot', dir: 'ul', scs: 3.75, nTones: 1, iTbs: 0, nRep: 16 }, 'zh')
  === 'NB-IoT 上行 · 1 子载波 × 3.75 kHz · I_TBS 0 · ×16' &&
  C.describe({ kind: 'nbiot', dir: 'ul', scs: 3.75, nTones: 1, iTbs: 0, nRep: 16 }, 'en')
  === 'NB-IoT UL · 1 SC × 3.75 kHz · I_TBS 0 · ×16')
ok('非 3GPP 载波 describe 返回空串', C.describe({ kind: 'dvb' }, 'zh') === '')

/* ---- ⑤ 引擎侧与渲染侧逐条对拍 ---- */
const VECTORS = []
for (const scs of [15, 30, 60, 120, 45]) {
  for (const nRb of [1, 25, 30, 106, 300]) {
    for (const dir of ['dl', 'ul']) {
      for (const rateModel of ['tbs', 'oh38306']) {
        for (const nRep of [1, 4, 32]) {
          VECTORS.push([{ kind: 'nr', dir, scs, nRb, rateModel, nRep, nSymb: 14, nDmrs: 12 }, 6, 948 / 1024])
          VECTORS.push([{ kind: 'nr', dir, scs, nRb, rateModel, nRep }, 2, 120 / 1024])
        }
      }
    }
  }
}
for (const nTones of [1, 3, 6, 12, 7]) {
  for (const scs of [15, 3.75]) {
    for (const dir of ['dl', 'ul']) {
      for (const st of [undefined, true, false]) {
        for (let iTbs = 0; iTbs <= 13; iTbs++) {
          for (const idx of [0, 3, 7]) {
            VECTORS.push([{ kind: 'nbiot', dir, st, scs, nTones, iTbs, iSf: idx, iRu: idx, nRep: 1 }, 2, 0.5])
          }
        }
      }
    }
  }
}
// 值域越界与变换预编码表也进对拍（错误串两边必须一字不差，否则面板与引擎各报各的）
for (const nRep of [1, 3, 16, 32, 64, 2048]) {
  VECTORS.push([{ kind: 'nbiot', dir: 'dl', nTones: 12, iTbs: 0, iSf: 0, nRep }, 2, 0.5])
  VECTORS.push([{ kind: 'nbiot', dir: 'ul', nTones: 12, iTbs: 0, iRu: 0, nRep }, 2, 0.5])
  VECTORS.push([{ kind: 'nr', dir: 'dl', scs: 15, nRb: 25, nRep }, 2, 0.5])
  VECTORS.push([{ kind: 'nr', dir: 'ul', scs: 15, nRb: 1, nRep }, 2, 0.5])
}
for (const mcsTable of ['t1', 't2', 't3', 'tp1', 'tp2']) {
  for (const dir of ['dl', 'ul']) VECTORS.push([{ kind: 'nr', dir, mcsTable, scs: 15, nRb: 25 }, 2, 0.5])
}
VECTORS.push([null, 2, 0.5], [{}, 2, 0.5], [{ kind: 'dvb' }, 2, 0.5], [{ kind: 'nr' }, 0, 0])
const mism = VECTORS.filter(([p, qm, r]) =>
  JSON.stringify(C.resolve(p, qm, r)) !== JSON.stringify(R.resolve(p, qm, r)) ||
  JSON.stringify(C.normalizePhy(p)) !== JSON.stringify(R.normalizePhy(p)) ||
  C.describe(p, 'zh') !== R.describe(p, 'zh') || C.describe(p, 'en') !== R.describe(p, 'en'))
ok(`引擎侧与渲染侧 resolve / normalizePhy / describe 逐条同值（${VECTORS.length} 个向量）`,
  mism.length === 0, mism.slice(0, 3).map(([p]) => JSON.stringify(p)).join(' | '))
ok('两份的常量表逐值同（RB 表 / TBS 量化表 / NB 两张 TBS 表 / 单音映射）',
  JSON.stringify(C.NR_RB_TABLE) === JSON.stringify(R.NR_RB_TABLE) &&
  JSON.stringify(C.TBS_QUANT) === JSON.stringify(R.TBS_QUANT) &&
  JSON.stringify(C.NB_TBS_DL) === JSON.stringify(R.NB_TBS_DL) &&
  JSON.stringify(C.NB_TBS_UL) === JSON.stringify(R.NB_TBS_UL) &&
  JSON.stringify(C.NB_ST_MCS) === JSON.stringify(R.NB_ST_MCS) &&
  JSON.stringify(C.MU_OF) === JSON.stringify(R.MU_OF) &&
  JSON.stringify(C.NB_NREP_DL) === JSON.stringify(R.NB_NREP_DL) &&
  JSON.stringify(C.NB_NREP_UL) === JSON.stringify(R.NB_NREP_UL) &&
  C.NR_NREP_MAX_UL === R.NR_NREP_MAX_UL && C.NR_NREP_MAX_DL === R.NR_NREP_MAX_DL)
const thrMis = [1, 2, 4, 8, 16, 128, 2048].filter((n) =>
  C.effectiveThresholdDb(-5.8, { nRep: n, combLossDb: 0.5 }) !== R.effectiveThresholdDb(-5.8, { nRep: n, combLossDb: 0.5 }))
ok('两份 effectiveThresholdDb 逐条同值', thrMis.length === 0)
// nbMaxSfIdx 两份必须同值：载波面板拿渲染侧那份灰下拉档，引擎拿这一份判越界，
// 两边一旦漂开，就会出现「下拉让选、算起来报错」或反过来「合法档被灰掉」。
const maxMis = []
for (const dir of ['dl', 'ul']) for (let iTbs = 0; iTbs <= 13; iTbs++) {
  const p = { kind: 'nbiot', dir, nTones: 12, iTbs }
  if (C.nbMaxSfIdx(C.normalizePhy(p)) !== R.nbMaxSfIdx(R.normalizePhy(p))) maxMis.push(dir + iTbs)
}
ok('两份 nbMaxSfIdx 逐行同值（下拉灰档与引擎判越界同一把尺）', maxMis.length === 0, maxMis.join(','))
// 换 MODCOD 时的钳制规则（载波面板 applyModcod）：钳到上限后必然落在标准表里
const clampBad = []
for (const dir of ['dl', 'ul']) for (let iTbs = 0; iTbs <= 12; iTbs++) for (let idx = 0; idx <= 7; idx++) {
  const mx = C.nbMaxSfIdx(nb({ dir, iTbs }))
  const kept = Math.min(idx, mx)
  if (C.nbTbs(nb({ dir, iTbs, iSf: kept, iRu: kept })) == null) clampBad.push(`${dir}/${iTbs}/${idx}`)
}
ok('钳到上限后必落在标准表里（13 行 × 8 档 × 收发两向全试）', clampBad.length === 0, clampBad.slice(0, 3).join(','))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
