// NTN 信道库集成算例：用 3GPP TR 38.821 V16.2.0 的链路预算表对拍（packages/core/utils/ntnChannel/）。
// 运行：node packages/core/test/ntnChannelBudget.test.mjs
//
// 一、复现 Table 6.1.3.3-1 全部 30 个用例 × 上下行（60 行）：
//   · 自由空间损耗：tr38811 式 (6.6-2)(6.6-3)，几何取 Table 6.1.3.2-1 的目标仰角（LEO 30°、GEO Set-1 12.5°、GEO Set-2 20°）；
//   · 闪烁损耗：tr38811 §6.6.6（S 频段电离层 2.2 dB；Ka 频段 Table 6.6.6.2.1-1，按 3GPP「最近参考仰角」取）；
//   · 终端 G/T：p372.gOverTDb（TR 38.821 式 6.1.3.1-3 / TR 38.811 Table 4.4-1 NOTE 1），手持 0 dBi/NF 7/290 K、VSAT 39.7 dBi/NF 1.2/150 K；
//   · 卫星 EIRP / G/T：Table 6.1.1.1-1（Set-1）/ 6.1.1.1-2（Set-2）的 EIRP 密度 + 10lg(带宽)；
//   · 阴影余量：Table 6.1.3.2-1（VSAT 0 dB、其余 3 dB）；大气损耗按表值（P.676 不在本库）；
//   · CNR：式 (6.1.3.1-2)，k = −228.6 dBW/K/Hz。上行手持带宽 360 kHz（Table 6.1.3.2-1；表里印成 0.4 MHz 是四舍五入）。
// 二、把表里写死的几项换成本库的 3GPP / ITU 口径，看结论怎么变：
//   A. SC4（GEO S 频段手持 12.5°）的固定 3 dB 阴影余量 → TR 38.811 位置覆盖概率；
//   B. SC9（LEO-600 S 频段手持 30°）的 290 K 天线噪温 → P.372-18 室外 / 室内估值；
//   C. SC9 的阴影余量 → P.681-11 二状态模型（2.2 GHz 郊区 30°）的衰落余量，与 TR 38.811 郊区结果互相印证；
//   D. SC6（LEO-600 Ka VSAT 30°）的 0 dB 阴影余量在 TR 38.811 乡村口径下只对应约 46% 的位置。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { tr38811: T, p681: P681, p372: N } = require('../utils/ntnChannel/index.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps) => a != null && b != null && Math.abs(a - b) <= (eps == null ? 1e-9 : eps)
const r1 = (x) => Math.round(x * 10) / 10

// ===== TR 38.821 Table 6.1.1.1-1 / -2：卫星参数（DL EIRP 密度 dBW/MHz、UL G/T dB/K）=====
const SAT = {
  'Set 1': { GEO: { S: [59, 19], Ka: [40, 28] }, 'LEO-1200': { S: [40, 1.1], Ka: [10, 13] }, 'LEO-600': { S: [34, 1.1], Ka: [4, 13] } },
  'Set 2': { GEO: { S: [53.5, 14], Ka: [32, 20] }, 'LEO-1200': { S: [34, -4.9], Ka: [2, 5] }, 'LEO-600': { S: [28, -4.9], Ka: [-4, 5] } }
}
const ALT_M = { GEO: 35786e3, 'LEO-1200': 1200e3, 'LEO-600': 600e3 }
// Table 6.1.3.2-1：目标仰角
const ELEV = (orbit, set) => (orbit === 'GEO' ? (set === 'Set 1' ? 12.5 : 20) : 30)
// Table 6.1.1.1-9：用例 → 轨道 / 参数集 / 终端 / 频段 / 复用选项（Option 1 = 全带宽、2 = 1/3、3 = 1/2）
const CASES = {}
{
  const rows = [
    [1, 'GEO', 'Set 1', 'VSAT', 1], [2, 'GEO', 'Set 1', 'VSAT', 2], [3, 'GEO', 'Set 1', 'VSAT', 3], [4, 'GEO', 'Set 1', 'HH', 1], [5, 'GEO', 'Set 1', 'HH', 2],
    [6, 'LEO-600', 'Set 1', 'VSAT', 1], [7, 'LEO-600', 'Set 1', 'VSAT', 2], [8, 'LEO-600', 'Set 1', 'VSAT', 3], [9, 'LEO-600', 'Set 1', 'HH', 1], [10, 'LEO-600', 'Set 1', 'HH', 2],
    [11, 'LEO-1200', 'Set 1', 'VSAT', 1], [12, 'LEO-1200', 'Set 1', 'VSAT', 2], [13, 'LEO-1200', 'Set 1', 'VSAT', 3], [14, 'LEO-1200', 'Set 1', 'HH', 1], [15, 'LEO-1200', 'Set 1', 'HH', 2],
    [16, 'GEO', 'Set 2', 'VSAT', 1], [17, 'GEO', 'Set 2', 'VSAT', 2], [18, 'GEO', 'Set 2', 'VSAT', 3], [19, 'GEO', 'Set 2', 'HH', 1], [20, 'GEO', 'Set 2', 'HH', 2],
    [21, 'LEO-600', 'Set 2', 'VSAT', 1], [22, 'LEO-600', 'Set 2', 'VSAT', 2], [23, 'LEO-600', 'Set 2', 'VSAT', 3], [24, 'LEO-600', 'Set 2', 'HH', 1], [25, 'LEO-600', 'Set 2', 'HH', 2],
    [26, 'LEO-1200', 'Set 2', 'VSAT', 1], [27, 'LEO-1200', 'Set 2', 'VSAT', 2], [28, 'LEO-1200', 'Set 2', 'VSAT', 3], [29, 'LEO-1200', 'Set 2', 'HH', 1], [30, 'LEO-1200', 'Set 2', 'HH', 2]
  ]
  for (const [n, orbit, set, term, opt] of rows) CASES['SC' + n] = { orbit, set, term, opt }
}

// ===== TR 38.821 Table 6.1.3.3-1（逐值转录）=====
// [用例, 方向, f GHz, EIRP dBm, G/T dB/K, 带宽 MHz, FSPL, 大气, 阴影余量, 闪烁, 极化, 附加, CNR]
const LB = [
  ['SC1', 'DL', 20.0, 96.0, 15.9, 400.0, 210.6, 1.2, 0.0, 1.1, 0.0, 0.0, 11.6], ['SC1', 'UL', 30.0, 76.2, 28.0, 400.0, 214.1, 1.1, 0.0, 1.1, 0.0, 0.0, 0.5],
  ['SC2', 'DL', 20.0, 91.2, 15.9, 133.3, 210.6, 1.2, 0.0, 1.1, 0.0, 0.0, 11.6], ['SC2', 'UL', 30.0, 76.2, 28.0, 133.3, 214.1, 1.1, 0.0, 1.1, 0.0, 0.0, 5.2],
  ['SC3', 'DL', 20.0, 93.0, 15.9, 200.0, 210.6, 1.2, 0.0, 1.1, 0.0, 0.0, 11.6], ['SC3', 'UL', 30.0, 76.2, 28.0, 200.0, 214.1, 1.1, 0.0, 1.1, 0.0, 0.0, 3.5],
  ['SC4', 'DL', 2.0, 103.8, -31.6, 30.0, 190.6, 0.2, 3.0, 2.2, 0.0, 0.0, 0.0], ['SC4', 'UL', 2.0, 23.0, 19.0, 0.4, 190.6, 0.2, 3.0, 2.2, 0.0, 0.0, -10.9],
  ['SC5', 'DL', 2.0, 99.0, -31.6, 10.0, 190.6, 0.2, 3.0, 2.2, 0.0, 0.0, 0.0], ['SC5', 'UL', 2.0, 23.0, 19.0, 0.4, 190.6, 0.2, 3.0, 2.2, 0.0, 0.0, -10.9],
  ['SC6', 'DL', 20.0, 60.0, 15.9, 400.0, 179.1, 0.5, 0.0, 0.3, 0.0, 0.0, 8.5], ['SC6', 'UL', 30.0, 76.2, 13.0, 400.0, 182.6, 0.5, 0.0, 0.3, 0.0, 0.0, 18.4],
  ['SC7', 'DL', 20.0, 55.2, 15.9, 133.3, 179.1, 0.5, 0.0, 0.3, 0.0, 0.0, 8.5], ['SC7', 'UL', 30.0, 76.2, 13.0, 133.3, 182.6, 0.5, 0.0, 0.3, 0.0, 0.0, 23.1],
  ['SC8', 'DL', 20.0, 57.0, 15.9, 200.0, 179.1, 0.5, 0.0, 0.3, 0.0, 0.0, 8.5], ['SC8', 'UL', 30.0, 76.2, 13.0, 200.0, 182.6, 0.5, 0.0, 0.3, 0.0, 0.0, 21.4],
  ['SC9', 'DL', 2.0, 78.8, -31.6, 30.0, 159.1, 0.1, 3.0, 2.2, 0.0, 0.0, 6.6], ['SC9', 'UL', 2.0, 23.0, 1.1, 0.4, 159.1, 0.1, 3.0, 2.2, 0.0, 0.0, 2.8],
  ['SC10', 'DL', 2.0, 74.0, -31.6, 10.0, 159.1, 0.1, 3.0, 2.2, 0.0, 0.0, 6.6], ['SC10', 'UL', 2.0, 23.0, 1.1, 0.4, 159.1, 0.1, 3.0, 2.2, 0.0, 0.0, 2.8],
  ['SC11', 'DL', 20.0, 66.0, 15.9, 400.0, 184.5, 0.5, 0.0, 0.3, 0.0, 0.0, 9.1], ['SC11', 'UL', 30.0, 76.2, 13.0, 400.0, 188.0, 0.5, 0.0, 0.3, 0.0, 0.0, 13.0],
  ['SC12', 'DL', 20.0, 61.2, 15.9, 133.3, 184.5, 0.5, 0.0, 0.3, 0.0, 0.0, 9.1], ['SC12', 'UL', 30.0, 76.2, 13.0, 133.3, 188.0, 0.5, 0.0, 0.3, 0.0, 0.0, 17.8],
  ['SC13', 'DL', 20.0, 63.0, 15.9, 200.0, 184.5, 0.5, 0.0, 0.3, 0.0, 0.0, 9.1], ['SC13', 'UL', 30.0, 76.2, 13.0, 200.0, 188.0, 0.5, 0.0, 0.3, 0.0, 0.0, 16.0],
  ['SC14', 'DL', 2.0, 84.8, -31.6, 30.0, 164.5, 0.1, 3.0, 2.2, 0.0, 0.0, 7.2], ['SC14', 'UL', 2.0, 23.0, 1.1, 0.4, 164.5, 0.1, 3.0, 2.2, 0.0, 0.0, -2.6],
  ['SC15', 'DL', 2.0, 80.0, -31.6, 10.0, 164.5, 0.1, 3.0, 2.2, 0.0, 0.0, 7.2], ['SC15', 'UL', 2.0, 23.0, 1.1, 0.4, 164.5, 0.1, 3.0, 2.2, 0.0, 0.0, -2.6],
  ['SC16', 'DL', 20.0, 88.0, 15.9, 400.0, 210.4, 0.8, 0.0, 0.5, 0.0, 0.0, 4.8], ['SC16', 'UL', 30.0, 76.2, 20.0, 400.0, 213.9, 0.7, 0.0, 0.5, 0.0, 0.0, -6.3],
  ['SC17', 'DL', 20.0, 83.2, 15.9, 133.3, 210.4, 0.8, 0.0, 0.5, 0.0, 0.0, 4.8], ['SC17', 'UL', 30.0, 76.2, 20.0, 133.3, 213.9, 0.7, 0.0, 0.5, 0.0, 0.0, -1.6],
  ['SC18', 'DL', 20.0, 85.0, 15.9, 200.0, 210.4, 0.8, 0.0, 0.5, 0.0, 0.0, 4.8], ['SC18', 'UL', 30.0, 76.2, 20.0, 200.0, 213.9, 0.7, 0.0, 0.5, 0.0, 0.0, -3.3],
  ['SC19', 'DL', 2.0, 98.3, -31.6, 30.0, 190.4, 0.1, 3.0, 2.2, 0.0, 0.0, -5.2], ['SC19', 'UL', 2.0, 23.0, 14.0, 0.4, 190.4, 0.1, 3.0, 2.2, 0.0, 0.0, -15.7],
  ['SC20', 'DL', 2.0, 93.5, -31.6, 10.0, 190.4, 0.1, 3.0, 2.2, 0.0, 0.0, -5.2], ['SC20', 'UL', 2.0, 23.0, 14.0, 0.4, 190.4, 0.1, 3.0, 2.2, 0.0, 0.0, -15.7],
  ['SC21', 'DL', 20.0, 52.0, 15.9, 400.0, 179.1, 0.5, 0.0, 0.3, 0.0, 0.0, 0.5], ['SC21', 'UL', 30.0, 76.2, 5.0, 400.0, 182.6, 0.5, 0.0, 0.3, 0.0, 0.0, 10.4],
  ['SC22', 'DL', 20.0, 47.2, 15.9, 133.3, 179.1, 0.5, 0.0, 0.3, 0.0, 0.0, 0.5], ['SC22', 'UL', 30.0, 76.2, 5.0, 133.3, 182.6, 0.5, 0.0, 0.3, 0.0, 0.0, 15.1],
  ['SC23', 'DL', 20.0, 49.0, 15.9, 200.0, 179.1, 0.5, 0.0, 0.3, 0.0, 0.0, 0.5], ['SC23', 'UL', 30.0, 76.2, 5.0, 200.0, 182.6, 0.5, 0.0, 0.3, 0.0, 0.0, 13.4],
  ['SC24', 'DL', 2.0, 72.8, -31.6, 30.0, 159.1, 0.1, 3.0, 2.2, 0.0, 0.0, 0.6], ['SC24', 'UL', 2.0, 23.0, -4.9, 0.4, 159.1, 0.1, 3.0, 2.2, 0.0, 0.0, -3.2],
  ['SC25', 'DL', 2.0, 68.0, -31.6, 10.0, 159.1, 0.1, 3.0, 2.2, 0.0, 0.0, 0.6], ['SC25', 'UL', 2.0, 23.0, -4.9, 0.4, 159.1, 0.1, 3.0, 2.2, 0.0, 0.0, -3.2],
  ['SC26', 'DL', 20.0, 58.0, 15.9, 400.0, 184.5, 0.5, 0.0, 0.3, 0.0, 0.0, 1.1], ['SC26', 'UL', 30.0, 76.2, 5.0, 400.0, 188.0, 0.5, 0.0, 0.3, 0.0, 0.0, 5.0],
  ['SC27', 'DL', 20.0, 53.2, 15.9, 133.3, 184.5, 0.5, 0.0, 0.3, 0.0, 0.0, 1.1], ['SC27', 'UL', 30.0, 76.2, 5.0, 133.3, 188.0, 0.5, 0.0, 0.3, 0.0, 0.0, 9.8],
  ['SC28', 'DL', 20.0, 55.0, 15.9, 200.0, 184.5, 0.5, 0.0, 0.3, 0.0, 0.0, 1.1], ['SC28', 'UL', 30.0, 76.2, 5.0, 200.0, 188.0, 0.5, 0.0, 0.3, 0.0, 0.0, 8.0],
  ['SC29', 'DL', 2.0, 78.8, -31.6, 30.0, 164.5, 0.1, 3.0, 2.2, 0.0, 0.0, 1.2], ['SC29', 'UL', 2.0, 23.0, -4.9, 0.4, 164.5, 0.1, 3.0, 2.2, 0.0, 0.0, -8.6],
  ['SC30', 'DL', 2.0, 74.0, -31.6, 10.0, 164.5, 0.1, 3.0, 2.2, 0.0, 0.0, 1.2], ['SC30', 'UL', 2.0, 23.0, -4.9, 0.4, 164.5, 0.1, 3.0, 2.2, 0.0, 0.0, -8.6]
]
const K_DBW = -228.6

// 由本库 + 原文参数表重算一行
function rebuild(row) {
  const [sc, dir, f] = row
  const c = CASES[sc]
  const band = f < 6 ? 'S' : 'Ka'
  const elev = ELEV(c.orbit, c.set)
  const sysBw = band === 'S' ? 30 : 400                                   // Table 6.1.3.2-1 系统带宽
  const bw = dir === 'UL' && c.term === 'HH' ? 0.36 : sysBw / [1, 1, 3, 2][c.opt]
  const [eirpDens, satGt] = SAT[c.set][c.orbit][band]
  const termGt = c.term === 'HH' ? N.gOverTDb(0, 7, 290) : N.gOverTDb(39.7, 1.2, 150)   // Table 6.1.1.1-3
  const eirpDbm = dir === 'DL' ? eirpDens + 10 * Math.log10(bw) + 30 : (c.term === 'HH' ? 23 + 0 : 33 + 43.2)
  const gt = dir === 'DL' ? termGt : satGt
  const fspl = T.fsplDb(T.slantRangeM(ALT_M[c.orbit], elev), f)
  const scint = T.scintillationLossDb(f, elev, { elevRule: 'nearest' })
  const sm = c.term === 'VSAT' ? 0 : 3
  const atm = row[7]                                                       // 大气损耗按表值
  const cnr = eirpDbm - 30 + gt - K_DBW - fspl - atm - sm - scint - row[10] - row[11] - 10 * Math.log10(bw * 1e6)
  return { eirpDbm, gt, bw, fspl, scint, sm, cnr, elev, band }
}

/* ---- 一、复现 Table 6.1.3.3-1 ---- */
{
  const bad = { eirp: [], gt: [], bw: [], fspl: [], scint: [], sm: [], cnr: [] }
  let worst = 0
  for (const row of LB) {
    const r = rebuild(row)
    const tag = row[0] + row[1]
    if (r1(r.eirpDbm) !== row[3]) bad.eirp.push(tag)
    if (r1(r.gt) !== row[4]) bad.gt.push(tag)
    if (r1(r.bw) !== row[5] && !(r.bw === 0.36 && row[5] === 0.4)) bad.bw.push(tag)
    if (r1(r.fspl) !== row[6]) bad.fspl.push(tag)
    if (r1(r.scint) !== row[9]) bad.scint.push(tag)
    if (r.sm !== row[8]) bad.sm.push(tag)
    worst = Math.max(worst, Math.abs(r.cnr - row[12]))
    if (Math.abs(r.cnr - row[12]) > 0.1) bad.cnr.push(tag + ':' + r.cnr.toFixed(2))
  }
  ok('60 行全部转录（30 用例 × 上下行）', LB.length === 60 && new Set(LB.map((r) => r[0])).size === 30)
  ok('EIRP：下行 = 参数集 EIRP 密度 + 10lg(带宽)，上行 VSAT 33 + 43.2 / 手持 23 + 0 dBm，到 0.1 dB 全对', bad.eirp.length === 0, bad.eirp.join(','))
  ok('复用 Option 2 的带宽是 400/3 MHz（表印 133.3）：SC2 / SC17 下行 EIRP = 40 / 32 dBW/MHz + 10lg(400/3) + 30 = 91.249 / 83.249 dBm',
    near(rebuild(LB[2]).bw, 400 / 3, 1e-12) && near(rebuild(LB[2]).eirpDbm, 91.249, 0.001) && near(rebuild(LB[32]).eirpDbm, 83.249, 0.001))
  ok('G/T：手持 −31.6、VSAT 15.9 由 p372.gOverTDb 算出，卫星 G/T 取参数集，全对', bad.gt.length === 0, bad.gt.join(','))
  ok('带宽：系统带宽 / 复用（Option 1/2/3 → 1、1/3、1/2）；上行手持 360 kHz（表印 0.4）', bad.bw.length === 0, bad.bw.join(','))
  ok('FSPL：tr38811 式 (6.6-2)(6.6-3) × 目标仰角，60 行到 0.1 dB 全对', bad.fspl.length === 0, bad.fspl.join(','))
  ok('闪烁：tr38811 §6.6.6（S 2.2 dB；Ka 按最近参考仰角 1.08 / 0.48 / 0.30 dB），60 行全对', bad.scint.length === 0, bad.scint.join(','))
  ok('阴影余量：VSAT 0 dB、手持 3 dB（Table 6.1.3.2-1）', bad.sm.length === 0, bad.sm.join(','))
  ok('CNR：式 (6.1.3.1-2) 用本库各项重算，60 行与表值差 ≤ 0.1 dB（输入各自四舍五入所致）', bad.cnr.length === 0,
    'max |Δ| = ' + worst.toFixed(3) + (bad.cnr.length ? '; ' + bad.cnr.join(',') : ''))
  ok('闪烁换成线性插值口径时 Ka GEO Set-1（12.5°）为 0.93 dB，与表的 1.1 对不上 —— 对拍 38.821 必须用 nearest',
    near(T.scintillationLossDb(20, 12.5), 0.93, 1e-12))
}

/* ---- 二、A：SC4 的 3 dB 阴影余量 → TR 38.811 位置覆盖概率 ---- */
{
  const nn = { elevRule: 'nearest' }          // 与 38.821 同口径（12.5° → 10° 档）
  const cov = Object.fromEntries(T.SCENARIOS.map((s) => [s, T.coverageProbability(3, s, 'S', 12.5, nn)]))
  ok('SC4：3 dB 余量在郊区 / 乡村只覆盖 75.2% 的位置', near(cov.rural, 0.752357711792493, 1e-9) && cov.suburban === cov.rural)
  ok('SC4：城区 19.0%、密集城区 24.2%（低仰角 NLOS 占比高、CL ≈ 34 dB）', near(cov.urban, 0.19024973999400674, 1e-9) &&
    near(cov.denseUrban, 0.24241607903077933, 1e-9))
  const req = Object.fromEntries(T.SCENARIOS.map((s) => [s, T.requiredMarginDb(0.95, s, 'S', 12.5, nn)]))
  ok('SC4：95% 位置覆盖所需余量 郊区 / 乡村 26.1 dB、城区 43.3 dB、密集城区 57.2 dB —— 远超 3 dB',
    near(req.rural, 26.14, 0.01) && near(req.urban, 43.32, 0.01) && near(req.denseUrban, 57.22, 0.01),
    T.SCENARIOS.map((s) => s + ' ' + req[s].toFixed(2)).join(', '))
  // CNR 换算：表的 0.0 dB 已扣 3 dB；不扣阴影余量时 CNR = 3.0，按 95% 覆盖扣 req → CNR_95
  const cnr95 = 3.0 - req.rural
  ok('SC4 下行按 95% 郊区位置覆盖重算 CNR = 3.0 − 26.1 = −23.1 dB（表值 0.0 dB）', near(cnr95, -23.14, 0.01))
}

/* ---- 二、B：SC9 的 290 K 天线噪温 → P.372-18 ---- */
{
  const out = N.handheldVs38821({ fGHz: 2 })
  const ind = N.handheldVs38821({ fGHz: 2, manMade: 'indoor' })
  ok('SC9 下行：室外 T_a ≈ 139 K → G/T −31.15 dB/K，CNR 6.6 → 7.1 dB', near(out.gtDb, -31.146, 0.01) && near(6.6 + out.deltaGtDb, 7.08, 0.01))
  ok('SC9 下行：室内（P.372-18 §6.2 中值，ρη = 0.2）T_a ≈ 1 303 K → G/T −33.92 dB/K，CNR 6.6 → 4.3 dB（建筑物进入损耗另计，见 P.2109）',
    near(ind.gtDb, -33.920, 0.01) && near(6.6 + ind.deltaGtDb, 4.31, 0.01))
}

/* ---- 二、C：SC9 的阴影余量 → P.681-11 二状态模型 ---- */
{
  const sel = { fGHz: 2.0, env: 'suburban', elevDeg: 30 }   // 2 GHz → Table 8 的 2.2 GHz 表
  const f5 = P681.fadeMarginDb(5, sel), f1 = P681.fadeMarginDb(1, sel)
  ok('P.681 郊区 30°：95% / 99% 位置的衰落余量 14.7 / 21.6 dB（正文口径），用的是 2.2 GHz 表', near(f5.fadeDb, 14.72, 0.02) &&
    near(f1.fadeDb, 21.57, 0.02) && f5.table.fGHz === 2.2)
  const tr = T.requiredMarginDb(0.95, 'suburban', 'S', 30)
  ok('两套独立模型在郊区 30° 互相印证：P.681 二状态 95% 余量 14.7 dB vs TR 38.811 LOS/NLOS + 阴影 15.8 dB（差 < 1.5 dB）',
    Math.abs(f5.fadeDb - tr) < 1.5, f5.fadeDb.toFixed(2) + ' vs ' + tr.toFixed(2))
  ok('SC9 下行 CNR 6.6 dB（含 3 dB 阴影余量）换成 P.681 95% 余量后为 6.6 + 3 − 14.7 = −5.1 dB',
    near(6.6 + 3 - f5.fadeDb, -5.12, 0.02))
}

/* ---- 二、D：SC6 VSAT 的 0 dB 阴影余量 ---- */
ok('SC6（Ka 乡村 30°）：0 dB 余量对应 TR 38.811 位置覆盖 46.2%（LOS 也有 σ_SF = 1.9 dB 的阴影）',
  near(T.coverageProbability(0, 'rural', 'Ka', 30, { elevRule: 'nearest' }), 0.4615469077, 1e-9))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
