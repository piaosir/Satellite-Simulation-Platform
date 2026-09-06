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

/* ---- ① 信道带宽 ↔ N_RB（TS 38.101-5 Table 5.3.2-1）---- */
const RB15 = { 5: 25, 10: 52, 15: 79, 20: 106, 30: 160 }
const RB30 = { 5: 11, 10: 24, 15: 38, 20: 51, 30: 78 }
const RB60 = { 10: 11, 15: 18, 20: 24, 30: 38, 50: 66, 100: 132, 200: 264 }
const RB120 = { 50: 32, 100: 66, 200: 132, 400: 264 }
ok('15 kHz 档 N_RB 逐值不变（5/10/15/20/30 MHz → 25/52/79/106/160）',
  JSON.stringify(C.nrRbTable(15)) === JSON.stringify(RB15))
ok('30 kHz 档 N_RB 逐值不变', JSON.stringify(C.nrRbTable(30)) === JSON.stringify(RB30))
ok('60 kHz 档 N_RB 逐值不变（含 FR2-NTN 50/100/200 MHz）', JSON.stringify(C.nrRbTable(60)) === JSON.stringify(RB60))
ok('120 kHz 档 N_RB 逐值不变（FR2-NTN 50/100/200/400 MHz）', JSON.stringify(C.nrRbTable(120)) === JSON.stringify(RB120))
ok('没有 5 MHz@60 kHz 这一档（标准里就没有，别凭插值造一个）', C.nrRbTable(60)[5] === undefined)
ok('认不出的 SCS 返回 null（不回落到 15 kHz）', C.nrRbTable(45) === null && C.nrRbTable('x') === null)

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
ok('NPUSCH TBS 表 13 行（I_TBS 0–12，Rel-13）', C.NB_TBS_UL.length === 13 && C.NB_TBS_DL.length === 13)
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
ok('越界返回 null：I_TBS 12 下 I_RU 7 标准表里就没有',
  C.nbTbs(nb({ iTbs: 12, iRu: 7 })) === null && C.nbInfoRateKbps(nb({ iTbs: 12, iRu: 7 })) === null)
ok('Rel-14 的 I_TBS 13 未收录 → TBS 返回 null（不静默按 12 档算）', C.nbTbs(nb({ iTbs: 13, iRu: 0 })) === null)
// 每行的合法上限：Cat-NB1 的 TBS 有天花板（下行 680 bit / 上行 1000 bit），I_TBS 越高行越短
ok('nbMaxSfIdx 逐行给出该 I_TBS 的最大 I_SF / I_RU',
  [7, 7, 7, 7, 7, 6, 5, 5, 4, 3, 3, 2, 2].every((m, i) => C.nbMaxSfIdx(nb({ dir: 'dl', iTbs: i })) === m) &&
  [7, 7, 7, 7, 7, 7, 7, 6, 5, 5, 5, 4, 3].every((m, i) => C.nbMaxSfIdx(nb({ dir: 'ul', iTbs: i })) === m) &&
  C.nbMaxSfIdx(nb({ iTbs: 13 })) === -1)
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
const rvErr = C.resolve({ kind: 'nbiot', dir: 'ul', nTones: 12, iTbs: 13, iRu: 0 }, 2, 0.5)
ok('resolve 越界：error 说清是哪一档，数值字段一律 null（不给半个能用的数）',
  rvErr.error.indexOf('I_TBS=13') > -1 && rvErr.bOccKHz === null && rvErr.infoRateKbps === null && rvErr.tbs === null)
// ★ 报的是「上限是多少、当前是多少」，且用界面上那个下拉真正显示的数（子帧数 / RU 数本身）——
//   I_SF / I_RU 这个下标在界面上一个字都不出现，照抄下标用户无从下手。
const rvLimDl = C.resolve({ kind: 'nbiot', dir: 'dl', nTones: 12, iTbs: 10, iSf: 7 }, 2, 0.5)
const rvLimUl = C.resolve({ kind: 'nbiot', dir: 'ul', nTones: 12, iTbs: 12, iRu: 7 }, 2, 0.5)
ok('resolve 越界报「上限 + 当前」，用界面上那个数而不是 I_SF / I_RU 下标',
  rvLimDl.error === 'NB-IoT I_TBS=10 的子帧数上限 4，当前 10' && rvLimDl.tbs === null &&
  rvLimUl.error === 'NB-IoT I_TBS=12 的 RU 数上限 4，当前 10' && rvLimUl.tbs === null,
  rvLimDl.error + ' / ' + rvLimUl.error)
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
