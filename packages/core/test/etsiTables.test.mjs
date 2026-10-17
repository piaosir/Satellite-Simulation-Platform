// ETSI DVB-S2 / S2X 门限原表逐值钉住。运行：npm test
//
// 外部金标准（ETSI 官方交付目录，免费下载）：
//   EN 302 307-1 V1.4.1 (2014-11) 第 6 章 表 13「Es/No performance at Quasi Error Free PER = 10-7 (AWGN channel)」（第 36 页）
//     https://www.etsi.org/deliver/etsi_en/302300_302399/30230701/01.04.01_60/en_30230701v010401p.pdf
//     SHA-256 19077f80420eb17519fcf6f83e2847d7a877940b134c5306814b8c6f60d8475d
//   EN 302 307-2 V1.4.1 (2024-08) 第 6 章 表 20a「Performance at Quasi Error Free FER=10-5, Normal FECFRAMES」、
//     表 20b（medium XFECFRAMEs）、表 20c（Short XFECFRAMEs）（第 53–54 页）
//     https://www.etsi.org/deliver/etsi_en/302300_302399/30230702/01.04.01_60/en_30230702v010401p.pdf
//     SHA-256 72b013ca8ca957c26a8e5fc70d491fc5c49065d25ff56ab8ae86087f35664fdd
//
// 下面的期望值是对着原文 PDF【另行手抄】的一份（与 scripts/build-etsi-dvb-tables.mjs 的机器抽取互为对照）：
//   ① packages/core/data/etsiDvbS2.json 与手抄表逐值相同（行数、名字、Es/N0、表 20a 的 Csat/(N0Rs)、表注帧长）；
//   ② constants.js 由它生成的内置 MODCOD 表逐值等于原表（门限、调制、码率、BPSK-S 的扩频因子、-L 名字）；
//   ③ 2026-10-17 前手抄表的已知偏差确已订正（差距分析 C-07：S2 QPSK 1/4、1/3、2/5 应为 −2.35 / −1.24 / −0.30 dB，
//      S2X 19 档偏高 0.03–1.15 dB，13 个 -L 档缺失或丢后缀）；
//   ④ QEF 判据与帧长的两份查法（主进程 modcodTables.etsiRowOf / 渲染端 lbSla.qefOf）逐行同值。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const J = require('../data/etsiDvbS2.json')
const C = require('../utils/constants.js')
const M = require('../utils/modcodTables.js')
const { qefOf } = await import('../../../src/shared/lbSla.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

// —— 手抄原表 ——
// EN 302 307-1 V1.4.1 表 13：[名字, 频谱效率, Ideal Es/No]，FECFRAME 64 800
const T13 = [
  ['QPSK 1/4', 0.490243, -2.35], ['QPSK 1/3', 0.656448, -1.24], ['QPSK 2/5', 0.789412, -0.30], ['QPSK 1/2', 0.988858, 1.00],
  ['QPSK 3/5', 1.188304, 2.23], ['QPSK 2/3', 1.322253, 3.10], ['QPSK 3/4', 1.487473, 4.03], ['QPSK 4/5', 1.587196, 4.68],
  ['QPSK 5/6', 1.654663, 5.18], ['QPSK 8/9', 1.766451, 6.20], ['QPSK 9/10', 1.788612, 6.42],
  ['8PSK 3/5', 1.779991, 5.50], ['8PSK 2/3', 1.980636, 6.62], ['8PSK 3/4', 2.228124, 7.91], ['8PSK 5/6', 2.478562, 9.35],
  ['8PSK 8/9', 2.646012, 10.69], ['8PSK 9/10', 2.679207, 10.98],
  ['16APSK 2/3', 2.637201, 8.97], ['16APSK 3/4', 2.966728, 10.21], ['16APSK 4/5', 3.165623, 11.03], ['16APSK 5/6', 3.300184, 11.61],
  ['16APSK 8/9', 3.523143, 12.89], ['16APSK 9/10', 3.567342, 13.13],
  ['32APSK 3/4', 3.703295, 12.73], ['32APSK 4/5', 3.951571, 13.64], ['32APSK 5/6', 4.119540, 14.28], ['32APSK 8/9', 4.397854, 15.69],
  ['32APSK 9/10', 4.453027, 16.05]
]
// EN 302 307-2 V1.4.1 表 20a：[名字, 频谱效率, Ideal Es/N0（AWGN 线性）, Ideal Csat/(N0Rs)（硬限幅，资料性）]
// 注 3：QPSK 2/9 的 FECFRAME 长 61 560，其余 64 800
const T20A = [
  ['QPSK 2/9', 0.434841, -2.85, -2.45], ['QPSK 13/45', 0.567805, -2.03, -1.60], ['QPSK 9/20', 0.889135, 0.22, 0.69],
  ['QPSK 11/20', 1.088581, 1.45, 1.97], ['8APSK 5/9-L', 1.647211, 4.73, 5.95], ['8APSK 26/45-L', 1.713601, 5.13, 6.35],
  ['8PSK 23/36', 1.896173, 6.12, 6.96], ['8PSK 25/36', 2.062148, 7.02, 7.93], ['8PSK 13/18', 2.145136, 7.49, 8.42],
  ['16APSK 1/2-L', 1.972253, 5.97, 8.4], ['16APSK 8/15-L', 2.104850, 6.55, 9.0], ['16APSK 5/9-L', 2.193247, 6.84, 9.35],
  ['16APSK 26/45', 2.281645, 7.51, 9.17], ['16APSK 3/5', 2.370043, 7.80, 9.38], ['16APSK 3/5-L', 2.370043, 7.41, 9.94],
  ['16APSK 28/45', 2.458441, 8.10, 9.76], ['16APSK 23/36', 2.524739, 8.38, 10.04], ['16APSK 2/3-L', 2.635236, 8.43, 11.06],
  ['16APSK 25/36', 2.745734, 9.27, 11.04], ['16APSK 13/18', 2.856231, 9.71, 11.52], ['16APSK 7/9', 3.077225, 10.65, 12.50],
  ['16APSK 77/90', 3.386618, 11.99, 14.00], ['32APSK 2/3-L', 3.291954, 11.10, 13.81], ['32APSK 32/45', 3.510192, 11.75, 14.50],
  ['32APSK 11/15', 3.620536, 12.17, 14.91], ['32APSK 7/9', 3.841226, 13.05, 15.84], ['64APSK 32/45-L', 4.206428, 13.98, 17.7],
  ['64APSK 11/15', 4.338659, 14.81, 17.97], ['64APSK 7/9', 4.603122, 15.47, 19.10], ['64APSK 4/5', 4.735354, 15.87, 19.54],
  ['64APSK 5/6', 4.936639, 16.55, 20.44], ['128APSK 3/4', 5.163248, 17.73, 21.43], ['128APSK 7/9', 5.355556, 18.53, 22.21],
  ['256APSK 29/45-L', 5.065690, 16.98, 21.6], ['256APSK 2/3-L', 5.241514, 17.24, 21.89], ['256APSK 31/45-L', 5.417338, 18.10, 22.9],
  ['256APSK 32/45', 5.593162, 18.59, 22.91], ['256APSK 11/15-L', 5.768987, 18.84, 23.80], ['256APSK 3/4', 5.900855, 19.57, 24.02]
]
// 表 20b（VL-SNR 中帧，FECFRAME 30 780，75 次迭代）：[名字, Es/N0]
const T20B = [['BPSK 1/5', -6.85], ['BPSK 11/45', -5.50], ['BPSK 1/3', -4.00]]
// 表 20c（短帧 16 200；注 1：BPSK-S 两档 15 390；注 2：π/2-BPSK 1/5、4/15 两档 14 976）：[名字, Es/N0, 帧长]
const T20C = [
  ['BPSK-S 1/5', -9.9, 15390], ['BPSK-S 11/45', -8.3, 15390], ['BPSK 1/5', -6.1, 14976], ['BPSK 4/15', -4.9, 14976],
  ['BPSK 1/3', -3.72, 16200], ['QPSK 11/45', -2.50, 16200], ['QPSK 4/15', -2.24, 16200], ['QPSK 14/45', -1.46, 16200],
  ['QPSK 7/15', 0.60, 16200], ['QPSK 8/15', 1.45, 16200], ['QPSK 32/45', 3.66, 16200], ['8PSK 7/15', 3.83, 16200],
  ['8PSK 8/15', 4.71, 16200], ['8PSK 26/45', 5.52, 16200], ['8PSK 32/45', 7.54, 16200], ['16APSK 7/15', 5.99, 16200],
  ['16APSK 8/15', 6.93, 16200], ['16APSK 26/45', 7.66, 16200], ['16APSK 3/5', 8.10, 16200], ['16APSK 32/45', 9.81, 16200],
  ['32APSK 2/3', 11.41, 16200], ['32APSK 32/45', 12.18, 16200]
]

/* ---- ① 数据文件 = 手抄原表 ---- */
const tb = J.tables
ok('出处：两份原文的版本号与 SHA-256',
  J.sources['EN302307-1'].doc === 'ETSI EN 302 307-1 V1.4.1 (2014-11)' && J.sources['EN302307-1'].sha256 === '19077f80420eb17519fcf6f83e2847d7a877940b134c5306814b8c6f60d8475d' &&
  J.sources['EN302307-2'].doc === 'ETSI EN 302 307-2 V1.4.1 (2024-08)' && J.sources['EN302307-2'].sha256 === '72b013ca8ca957c26a8e5fc70d491fc5c49065d25ff56ab8ae86087f35664fdd')
ok('表 13：28 行逐值（名字 / 频谱效率 / Es/No）', tb['S2-13'].rows.length === 28 &&
  T13.every(([n, se, es], i) => { const r = tb['S2-13'].rows[i]; return r.name === n && r.se === se && r.esno === es }))
ok('表 20a：39 行逐值（名字 / 频谱效率 / Es/N0 / Csat/(N0Rs)）', tb['S2X-20a'].rows.length === 39 &&
  T20A.every(([n, se, es, hl], i) => { const r = tb['S2X-20a'].rows[i]; return r.name === n && r.se === se && r.esno === es && r.hl === hl }))
ok('表 20a 注 3：只有 QPSK 2/9 的帧长 61560', tb['S2X-20a'].rows.filter((r) => r.frame).map((r) => r.name + '@' + r.frame).join() === 'QPSK 2/9@61560')
ok('表 20b：3 行逐值', tb['S2X-20b'].rows.length === 3 && T20B.every(([n, es], i) => tb['S2X-20b'].rows[i].name === n && tb['S2X-20b'].rows[i].esno === es))
ok('表 20c：22 行逐值（含注 1 / 注 2 的帧长）', tb['S2X-20c'].rows.length === 22 &&
  T20C.every(([n, es, fr], i) => { const r = tb['S2X-20c'].rows[i]; return r.name === n && r.esno === es && (r.frame || tb['S2X-20c'].frame) === fr }))
ok('表级判据：表 13 = PER 10⁻⁷（TS 包）/ 64800；表 20a–20c = FER 10⁻⁵ / 64800·30780·16200',
  tb['S2-13'].qef.kind === 'PER' && tb['S2-13'].qef.exp === 7 && tb['S2-13'].frame === 64800 &&
  ['S2X-20a', 'S2X-20b', 'S2X-20c'].every((k) => tb[k].qef.kind === 'FER' && tb[k].qef.exp === 5) &&
  tb['S2X-20a'].frame === 64800 && tb['S2X-20b'].frame === 30780 && tb['S2X-20c'].frame === 16200)
ok('名字拆分：-L 后缀、BPSK-S（π/2-BPSK、扩频因子 2）', (() => {
  const all = [...tb['S2-13'].rows, ...tb['S2X-20a'].rows, ...tb['S2X-20b'].rows, ...tb['S2X-20c'].rows]
  return all.filter((r) => r.L).length === 13 && all.filter((r) => r.spread === 2).map((r) => r.name).join() === 'BPSK-S 1/5,BPSK-S 11/45' &&
    all.every((r) => r.name === (r.spread === 2 ? 'BPSK-S' : r.mod) + ' ' + r.fec + (r.L ? '-L' : ''))
})())
const BITS = { BPSK: 1, QPSK: 2, '8PSK': 3, '8APSK': 3, '16APSK': 4, '32APSK': 5, '64APSK': 6, '128APSK': 7, '256APSK': 8 }
const rate = (f) => { const [a, b] = f.split('/').map(Number); return a / b }
ok('频谱效率 / (log2M × 码率) 落在 0.95–0.995（列没错位）', [...tb['S2-13'].rows, ...tb['S2X-20a'].rows]
  .every((r) => { const e = r.se / (BITS[r.mod] * rate(r.fec)); return e > 0.95 && e < 0.995 }))

/* ---- ② 内置 MODCOD 表 = 原表 ---- */
const lab = (r) => r.label
ok('DVB-S2 内置表 = 表 13 逐档（门限 / 调制 / 码率 / 次序）', C.DVBS2_MODCOD_TABLE.length === 28 &&
  T13.every(([n, , es], i) => { const r = C.DVBS2_MODCOD_TABLE[i]; return lab(r) === n && r.threshold === es && r.modulation + ' ' + r.fec === n && r.m === 1 && r.hl === null }))
ok('DVB-S2X 正常帧内置表 = 表 20a ∪ 表 13（67 档，无重名）', (() => {
  const t = C.DVBS2X_MODCOD_TABLE
  const want = new Map([...T20A.map(([n, , es, hl]) => [n, [es, hl]]), ...T13.map(([n, , es]) => [n, [es, null]])])
  return t.length === 67 && new Set(t.map(lab)).size === 67 && t.every((r) => want.has(lab(r)) && want.get(lab(r))[0] === r.threshold && want.get(lab(r))[1] === r.hl)
})())
ok('DVB-S2X 短帧 = 表 20c、VL-SNR 中帧 = 表 20b（BPSK-S 记 BPSK + 扩频增益 2）',
  C.DVBS2X_SHORT_MODCOD_TABLE.length === 22 && T20C.every(([n, es], i) => { const r = C.DVBS2X_SHORT_MODCOD_TABLE[i]; return lab(r) === n && r.threshold === es && r.m === (/^BPSK-S/.test(n) ? 2 : 1) && r.modulation === (/^BPSK/.test(n) ? 'BPSK' : n.split(' ')[0]) }) &&
  C.DVBS2X_MEDIUM_MODCOD_TABLE.length === 3 && T20B.every(([n, es], i) => lab(C.DVBS2X_MEDIUM_MODCOD_TABLE[i]) === n && C.DVBS2X_MEDIUM_MODCOD_TABLE[i].threshold === es))
ok('帧效率 0.9 / 滚降 1.05 / Es/N₀ 口径沿用改前工程口径',
  [C.DVBS2_MODCOD_TABLE, C.DVBS2X_MODCOD_TABLE, C.DVBS2X_SHORT_MODCOD_TABLE, C.DVBS2X_MEDIUM_MODCOD_TABLE].every((t) => t.every((r) => r.rsCode === '0.9' && r.bandwidthFactor === 1.05 && r.noiseRatioMode === 'esno')))
ok('合并层归一化后（自动名收空串）逐值不漂', (() => {
  const L = M.listStandards(null)
  return ['DVB-S2', 'DVB-S2X', 'DVB-S2X Short', 'DVB-S2X VL-SNR Medium'].every((k) => {
    const src = { 'DVB-S2': C.DVBS2_MODCOD_TABLE, 'DVB-S2X': C.DVBS2X_MODCOD_TABLE, 'DVB-S2X Short': C.DVBS2X_SHORT_MODCOD_TABLE, 'DVB-S2X VL-SNR Medium': C.DVBS2X_MEDIUM_MODCOD_TABLE }[k]
    const s = L.find((x) => x.key === k)
    return s.rows.length === src.length && s.rows.every((r, i) => M.labelOf(r) === src[i].label && r.threshold === src[i].threshold && r.hl === src[i].hl && r.m === src[i].m)
  })
})())

/* ---- ③ 2026-10-17 前手抄表的已知偏差已订正（差距分析 §4 C-07）---- */
const thOf = (t, n) => (t.find((r) => lab(r) === n) || {}).threshold
ok('DVB-S2 QPSK 1/4、1/3、2/5 = −2.35 / −1.24 / −0.30 dB（旧表 −1.20 / −0.70 / 0.00）',
  thOf(C.DVBS2_MODCOD_TABLE, 'QPSK 1/4') === -2.35 && thOf(C.DVBS2_MODCOD_TABLE, 'QPSK 1/3') === -1.24 && thOf(C.DVBS2_MODCOD_TABLE, 'QPSK 2/5') === -0.30)
ok('S2X 代表档：QPSK 9/20 0.22（旧 0.69）、16APSK 3/5 7.80（旧 8.38）、32APSK 32/45 11.75（旧 12.14）',
  thOf(C.DVBS2X_MODCOD_TABLE, 'QPSK 9/20') === 0.22 && thOf(C.DVBS2X_MODCOD_TABLE, '16APSK 3/5') === 7.80 && thOf(C.DVBS2X_MODCOD_TABLE, '32APSK 32/45') === 11.75)
// 差距分析按同名比得 19 档（含 S2 遗留的 QPSK 1/4 / 1/3 / 2/5）；丢了 -L 的 32APSK 2/3 同名比不上，按新名再比多出 1 档
ok('旧 S2X 表相对原表：同名可比的 19 档 + 改名的 32APSK 2/3-L 1 档，全部偏高 0.03–1.15 dB', (() => {
  const d = M.LEGACY_V1['DVB-S2X'].map(([n, t]) => {
    const nn = (M.RENAMED_V2['DVB-S2X'] || {})[n] || n
    return [n, nn, Math.round((t - thOf(C.DVBS2X_MODCOD_TABLE, nn)) * 100) / 100]
  }).filter(([, , x]) => Math.abs(x) > 0.005)
  return d.length === 20 && d.filter(([n, nn]) => n === nn).length === 19 && d.every(([, , x]) => x >= 0.03 && x <= 1.15) &&
    d.some(([n, nn, x]) => n === '32APSK 2/3' && nn === '32APSK 2/3-L' && x === 0.65)
})())
ok('13 个 -L 档齐全，旧表里丢了 -L 后缀的 6 档不再以无后缀名出现', (() => {
  const t = C.DVBS2X_MODCOD_TABLE
  const L = t.filter((r) => /-L$/.test(lab(r))).map(lab)
  return L.length === 13 && Object.keys(M.RENAMED_V2['DVB-S2X']).every((old) => !t.some((r) => lab(r) === old)) &&
    Object.values(M.RENAMED_V2['DVB-S2X']).every((nn) => L.includes(nn))
})())

/* ---- ④ QEF 判据 / 帧长：两份查法逐行同值 ---- */
{
  const mm = M.modcodMap(null)
  const mis = []
  for (const k of ['DVB-S2', 'DVB-S2X', 'DVB-S2X Short', 'DVB-S2X VL-SNR Medium']) {
    for (const r of mm[k]) {
      const form = { dvbStandard: k, modcodLabel: r.label, modulation: r.modulation, fec: r.fec, m: r.m }
      const a = qefOf(form, null), b = qefOf(form, mm[k])
      if (!a || !b || a.exp !== r.qefExp || b.exp !== r.qefExp || a.frame !== r.frameBits || a.table !== r.etsiTable) mis.push(k + ' ' + r.label)
    }
  }
  ok('主进程 withEtsi 与渲染端 qefOf（有表行 / 无表行两条路）逐行同值', mis.length === 0, mis.slice(0, 5).join(', '))
  ok('S2X 正常帧：表 20a 档 FER 10⁻⁵（39 档）、S2 遗留档 PER 10⁻⁷（28 档）',
    mm['DVB-S2X'].filter((r) => r.qefExp === 5).length === 39 && mm['DVB-S2X'].filter((r) => r.qefExp === 7).length === 28)
  ok('非 S2/S2X 标准 qefOf 返回 null（走场景参数）', ['DVB-S', 'DVB-RCS2', 'custom', 'usr:1', '3GPP NR-NTN'].every((k) => qefOf({ dvbStandard: k, modulation: 'QPSK', fec: '1/2' }, null) === null))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
