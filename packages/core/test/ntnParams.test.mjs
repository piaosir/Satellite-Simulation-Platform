// 3GPP NTN 参数核对 + 载波带宽限值自测。运行：npm test
// 被测的限值判据是渲染端 ESM（src/shared/ntnLimits.js），故本测试自身也是 .mjs。
//
// 锁定五件事：
//   ① NR-NTN 五张 MODCOD 表的【调制方式 + 目标码率】必须逐条等于 TS 38.214 的原表
//      （表 1/2/3 = Table 5.1.3.1-1/-2/-3，变换预编码表 1/2 = Table 6.1.4.1-1/-2）——
//      这两列是标准原值，任何改动都是错的。门限一列是公开链路级仿真的重定基线（3GPP 不规定
//      MCS↔SNR），不逐值锁死，只查单调性与「拟合式能重现」。
//   ② NB-IoT 三张表的码率与 TS 36.213 的 TBS 相符，索引覆盖完整。
//   ③ 八张 3GPP 表一律 snr 口径，且 rsCode / bandwidthFactor 两列【不参与计算】——
//      原来的「bandwidthFactor === 1.1」断言随口径改造作废，换成这一条。
//   ④ 门限口径的第三档 snr 在合并层认得出；老 modcod.json（无 idx / 无 phy）读得进；
//      新增的六个内置 key 同样「只存差异」。
//   ⑤ 载波带宽超出该体制信道带宽档位时必须报「over」；snr 口径的行恒不判；DVB 体制一律不判。
import { createRequire } from 'module'
import { checkNtnBandwidth, NTN_BW_LIMITS, isNtnStandard } from '../../../src/shared/ntnLimits.js'
const require = createRequire(import.meta.url)
const C = require('../utils/constants.js')
const M = require('../utils/modcodTables.js')
const ntnPhy = require('../utils/ntnPhy.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const frac = (s) => { const p = String(s).split('/'); return Number(p[0]) / Number(p[1]) }

console.log('=== 3GPP NTN 参数核对 ===\n')

/* —— ① NR 五张表：TS 38.214 原值逐条对表 —— */
// 每项 [Qm, R×1024]；变换预编码两张表前几档的 q=1/q=2 在本清单里也拆成两项（顺序同表）
const MOD_OF = { 1: 'BPSK', 2: 'QPSK', 4: '16QAM', 6: '64QAM', 8: '256QAM' }
const T1 = [[2, 120], [2, 157], [2, 193], [2, 251], [2, 308], [2, 379], [2, 449], [2, 526], [2, 602], [2, 679],
  [4, 340], [4, 378], [4, 434], [4, 490], [4, 553], [4, 616], [4, 658],
  [6, 438], [6, 466], [6, 517], [6, 567], [6, 616], [6, 666], [6, 719], [6, 772], [6, 822], [6, 873], [6, 910], [6, 948]]
const T2 = [[2, 120], [2, 193], [2, 308], [2, 449], [2, 602],
  [4, 378], [4, 434], [4, 490], [4, 553], [4, 616], [4, 658],
  [6, 466], [6, 517], [6, 567], [6, 616], [6, 666], [6, 719], [6, 772], [6, 822], [6, 873],
  [8, 682.5], [8, 711], [8, 754], [8, 797], [8, 841], [8, 885], [8, 916.5], [8, 948]]
const T3 = [[2, 30], [2, 40], [2, 50], [2, 64], [2, 78], [2, 99], [2, 120], [2, 157], [2, 193], [2, 251],
  [2, 308], [2, 379], [2, 449], [2, 526], [2, 602],
  [4, 340], [4, 378], [4, 434], [4, 490], [4, 553], [4, 616],
  [6, 438], [6, 466], [6, 517], [6, 567], [6, 616], [6, 666], [6, 719], [6, 772]]
// Table 6.1.4.1-1：MCS 0/1 的 q 档；q=1 → π/2-BPSK 240、314；q=2 → QPSK 120、157
const TP1 = [[1, 240], [2, 120], [1, 314], [2, 157],
  [2, 193], [2, 251], [2, 308], [2, 379], [2, 449], [2, 526], [2, 602], [2, 679],
  [4, 340], [4, 378], [4, 434], [4, 490], [4, 553], [4, 616], [4, 658],
  [6, 466], [6, 517], [6, 567], [6, 616], [6, 666], [6, 719], [6, 772], [6, 822], [6, 873], [6, 910], [6, 948]]
// Table 6.1.4.1-2：MCS 0–5 的 q 档
const TP2 = [[1, 60], [2, 30], [1, 80], [2, 40], [1, 100], [2, 50], [1, 128], [2, 64], [1, 156], [2, 78], [1, 198], [2, 99],
  [2, 120], [2, 157], [2, 193], [2, 251], [2, 308], [2, 379], [2, 449], [2, 526], [2, 602], [2, 679],
  [4, 378], [4, 434], [4, 490], [4, 553], [4, 616], [4, 658], [4, 699], [4, 772],
  [6, 567], [6, 616], [6, 666], [6, 772]]

const NR_TABLES = [
  ['表 1（64QAM，Table 5.1.3.1-1）', C.NR_NTN_MODCOD_TABLE, T1, '3GPP NR-NTN'],
  ['表 2（256QAM，Table 5.1.3.1-2）', C.NR_NTN_T2_MODCOD_TABLE, T2, '3GPP NR-NTN T2'],
  ['表 3（低频谱效率，Table 5.1.3.1-3）', C.NR_NTN_T3_MODCOD_TABLE, T3, '3GPP NR-NTN T3'],
  ['变换预编码表 1（Table 6.1.4.1-1）', C.NR_NTN_TP1_MODCOD_TABLE, TP1, '3GPP NR-NTN TP1'],
  ['变换预编码表 2（Table 6.1.4.1-2）', C.NR_NTN_TP2_MODCOD_TABLE, TP2, '3GPP NR-NTN TP2']
]
for (const [name, tbl, ref] of NR_TABLES) {
  ok(`NR ${name} 共 ${ref.length} 档`, tbl.length === ref.length, `实际 ${tbl.length}`)
  const bad = []
  ref.forEach(([Qm, r1024], i) => {
    const e = tbl[i]
    if (!e || e.modulation !== MOD_OF[Qm] || e.fec !== `${r1024}/1024`) {
      bad.push(`#${i} ${e ? e.modulation + ' ' + e.fec : '缺'} ≠ ${MOD_OF[Qm]} ${r1024}/1024`)
    }
  })
  ok(`NR ${name} 调制/码率逐条等于标准原表`, bad.length === 0, bad.slice(0, 3).join(' | ') || `${ref.length}/${ref.length} 一致`)
  ok(`NR ${name} 门限随档位单调不降`, tbl.every((e, i) => i === 0 || e.threshold >= tbl[i - 1].threshold),
    tbl.map((e) => e.threshold).join(','))
  ok(`NR ${name} idx 是 MCS 序号（q 档两行同号）`,
    tbl.every((e) => Number.isInteger(e.idx) && e.idx >= 0) &&
    tbl.every((e, i) => i === 0 || e.idx >= tbl[i - 1].idx))
}
// 门限一列能由 §4.2 的拟合式重现（Shannon 极限 + 按调制族线性拟合的实现差距）——
// 142 个数手抄进来，靠这条防止抄错一位而没人发现。基线本身四舍五入到 0.1 dB，故容差 0.06。
{
  const gap = (Qm, SE) => (Qm <= 2 ? 1.606 - 0.270 * SE : (Qm === 4 ? 1.689 + 0.094 * SE : 2.019 + 0.121 * SE))
  const bad = []
  for (const [name, tbl] of NR_TABLES) {
    for (const e of tbl) {
      const Qm = { BPSK: 1, QPSK: 2, '16QAM': 4, '64QAM': 6, '256QAM': 8 }[e.modulation]
      const SE = Qm * frac(e.fec)
      const want = 10 * Math.log10(Math.pow(2, SE) - 1) + gap(Qm, SE)
      if (Math.abs(want - e.threshold) > 0.06) bad.push(`${name} ${e.label}: ${e.threshold} vs ${want.toFixed(2)}`)
    }
  }
  ok('NR 五张表的门限逐条能由基线拟合式重现（±0.06 dB）', bad.length === 0, bad.slice(0, 3).join(' | '))
}

/* —— ② NB-IoT 三张表 —— */
// 每传输块的编码比特数（P2-5）：★ 原先三张表的 fec 列一律写成 TBS/264，而 264 =（14−3）×12×2
// 对哪一张表都不是分母 —— 编出来的数。正确的分母按 TS 36.211 的结构算：
//   NPDSCH 168 RE − 16 RE（2 个 NRS 端口）= 152 RE → 304 bit；带内部署 104 RE → 208 bit
//   NPUSCH 多音 144 RE → 288 bit；单音 96 RE → 96 bit（π/2-BPSK）/ 192 bit（π/4-QPSK）
// 分子含 24 bit CRC，与 NR 的 R 同口径。
const CRC = 24
const NB_TABLES = [
  ['NPDSCH', C.NB_IOT_NTN_MODCOD_TABLE, ntnPhy.NB_TBS_DL, '3GPP NB-IoT NTN', 304],
  ['NPUSCH 多音', C.NB_IOT_NTN_MT_MODCOD_TABLE, ntnPhy.NB_TBS_UL, '3GPP NB-IoT NTN NPUSCH MT', 288]
]
for (const [name, tbl, tbs, , coded] of NB_TABLES) {
  ok(`NB-IoT ${name} 覆盖 I_TBS 0–13（Rel-14 Cat-NB2 全档）`,
    tbl.length === 14 && tbl.every((e, i) => e.idx === i), `实际 ${tbl.length} 档`)
  ok(`NB-IoT ${name} 各档码率分母 = ${coded}（不是编出来的 264）`,
    tbl.every((e) => String(e.fec).endsWith('/' + coded)), tbl.map((e) => e.fec).join(','))
  ok(`NB-IoT ${name} 各档分子 = TBS(I_SF/I_RU=0) + 24 bit CRC`,
    tbl.every((e, i) => Number(String(e.fec).split('/')[0]) === tbs[i][0] + CRC),
    tbl.map((e) => e.fec).join(','))
  ok(`NB-IoT ${name} 各档码率与引擎现算的一致（I_SF/I_RU = 0、独立部署）`,
    tbl.every((e, i) => {
      const dir = name === 'NPDSCH' ? 'dl' : 'ul'
      const phy = ntnPhy.normalizePhy({ kind: 'nbiot', dir, nTones: 12, iTbs: i, iSf: 0, iRu: 0 })
      return Math.abs(frac(e.fec) - ntnPhy.nbCodeRate(phy)) < 1e-12
    }))
  ok(`NB-IoT ${name} 全 QPSK`, tbl.every((e) => e.modulation === 'QPSK'))
  ok(`NB-IoT ${name} 门限单调不降`, tbl.every((e, i) => i === 0 || e.threshold >= tbl[i - 1].threshold))
  ok(`NB-IoT ${name} 标签不再印假分数（改印 TBS）`,
    tbl.every((e) => e.label.indexOf('/264') < 0 && /TBS \d+$/.test(e.label)), tbl[0].label)
}
{
  const st = C.NB_IOT_NTN_ST_MODCOD_TABLE
  ok('NB-IoT NPUSCH 单音覆盖 I_MCS 0–10 共 11 档', st.length === 11)
  ok('NB-IoT 单音行按 I_TBS 升序排（I_MCS 1 与 2 的 I_TBS 是反的，照 I_MCS 排门限就不单调）',
    st.map((e) => e.idx).join(',') === '0,2,1,3,4,5,6,7,8,9,10')
  ok('NB-IoT 单音门限单调不降', st.every((e, i) => i === 0 || e.threshold >= st[i - 1].threshold),
    st.map((e) => e.threshold).join(','))
  ok('NB-IoT 单音前两档是 π/2-BPSK（I_MCS 0 / 1），其余 π/4-QPSK',
    st.filter((e) => e.modulation === 'BPSK').map((e) => e.idx).sort((a, b) => a - b).join(',') === '0,1' &&
    st.filter((e) => e.modulation === 'QPSK').length === 9)
  // 单音每 RU 的编码比特：(16 slot × 7 符号 − 16 DMRS) × Qm = 96 / 192
  ok('NB-IoT 单音码率分母 = 96（π/2-BPSK）/ 192（π/4-QPSK）',
    st.every((e) => String(e.fec).endsWith(e.modulation === 'BPSK' ? '/96' : '/192')))
  ok('NB-IoT 单音各档分子 = 该 I_TBS 的 TBS（I_RU=0）+ 24 bit CRC',
    st.every((e) => {
      const m = ntnPhy.nbSingleToneMcs(e.idx)
      return Number(String(e.fec).split('/')[0]) === ntnPhy.NB_TBS_UL[m.iTbs][0] + CRC
    }), st.map((e) => e.fec).join(','))
  ok('NB-IoT 单音各档码率与引擎现算的一致（分母 96 × Qm）',
    st.every((e) => {
      const m = ntnPhy.nbSingleToneMcs(e.idx)
      const phy = ntnPhy.normalizePhy({ kind: 'nbiot', dir: 'ul', nTones: 1, iTbs: m.iTbs, iRu: 0 })
      return Math.abs(frac(e.fec) - ntnPhy.nbCodeRate(phy)) < 1e-12
    }))
  ok('NB-IoT 单音只到 I_MCS 10（对应 I_TBS 0–10），表里没有 11–13 那三档',
    st.every((e) => e.idx <= 10) && st.length === 11)
}

/* —— ③ 八张表一律 snr 口径，帧效率/滚降不参与计算 —— */
{
  const all = NR_TABLES.map((x) => x[1]).concat(NB_TABLES.map((x) => x[1]), [C.NB_IOT_NTN_ST_MODCOD_TABLE])
  const keys = NR_TABLES.map((x) => x[3]).concat(NB_TABLES.map((x) => x[3]), ['3GPP NB-IoT NTN NPUSCH ST'])
  ok('八张 3GPP 表的门限口径一律 snr（每 RE 信噪比 = 占用带宽内的 C/N）',
    all.every((t) => t.every((e) => e.noiseRatioMode === 'snr')))
  // 原来的「bandwidthFactor === 1.1」断言在这里作废：占用带宽→信道带宽的换算改由 phy 的 PRB 数
  // 与子载波间隔算，1.1 只对 5 MHz@15 kHz 一档准（真值 1.111/1.068/1.055/1.048/1.042）。
  ok('★ snr 行的帧效率与滚降两列不参与计算（写 1 只是占位）',
    all.every((t) => t.every((e) => Number(e.rsCode) === 1 && Number(e.bandwidthFactor) === 1)))
  ok('八张表都有条件元数据（BLER 目标 / 信道 / 码块规模 / 出处 / SNR 参考点）',
    keys.every((k) => {
      const m = C.NTN_TABLE_META[k]
      return m && m.bler === 0.1 && m.channel && m.block && m.rep === 1 && m.snrRef === 'perRE' && m.source
    }), keys.filter((k) => !C.NTN_TABLE_META[k]).join(','))
  ok('八张表都在合并层的内置清单里，且各有 phy 骨架',
    keys.every((k) => M.BUILTIN_KEYS.indexOf(k) > -1 && M.phyOf(k)),
    keys.filter((k) => M.BUILTIN_KEYS.indexOf(k) < 0).join(','))
  ok('phy 骨架的体制/方向/表号对得上（下行 NR 走 t1/t2/t3，上行走 tp1/tp2，NB 单音 1 音）',
    M.phyOf('3GPP NR-NTN').mcsTable === 't1' && M.phyOf('3GPP NR-NTN').dir === 'dl' &&
    M.phyOf('3GPP NR-NTN TP1').mcsTable === 'tp1' && M.phyOf('3GPP NR-NTN TP1').dir === 'ul' &&
    M.phyOf('3GPP NB-IoT NTN').dir === 'dl' && M.phyOf('3GPP NB-IoT NTN NPUSCH ST').nTones === 1)
  // ★ 新选一次 MODCOD 才铺这两个字段；老配置没有它们，归一化按「不指定 / 独立部署」放行
  ok('NR 骨架缺省频段 n256（S 频段，TR 38.821 的基线）',
    ['3GPP NR-NTN', '3GPP NR-NTN T2', '3GPP NR-NTN T3', '3GPP NR-NTN TP1', '3GPP NR-NTN TP2']
      .every((k) => M.phyOf(k).band === 'n256'))
  ok('NB 骨架带 st 与部署模式（NPDSCH null / 多音 false / 单音 true，一律独立部署）',
    M.phyOf('3GPP NB-IoT NTN').st === null && M.phyOf('3GPP NB-IoT NTN NPUSCH MT').st === false &&
    M.phyOf('3GPP NB-IoT NTN NPUSCH ST').st === true &&
    ['3GPP NB-IoT NTN', '3GPP NB-IoT NTN NPUSCH MT', '3GPP NB-IoT NTN NPUSCH ST']
      .every((k) => M.phyOf(k).opMode === 'standalone'))
  ok('内置骨架的每一条都在标准表里配得出来（频段 × 子载波间隔 × 信道带宽）',
    ['3GPP NR-NTN', '3GPP NR-NTN T2', '3GPP NR-NTN T3', '3GPP NR-NTN TP1', '3GPP NR-NTN TP2',
      '3GPP NB-IoT NTN', '3GPP NB-IoT NTN NPUSCH MT', '3GPP NB-IoT NTN NPUSCH ST']
      .every((k) => ntnPhy.resolve(M.phyOf(k), 2, 0.5).error === ''),
    ['3GPP NR-NTN', '3GPP NB-IoT NTN NPUSCH ST'].map((k) => ntnPhy.resolve(M.phyOf(k), 2, 0.5).error).join(' | '))
  ok('DVB 各体制没有 phy（照旧走 DVB 换算链）',
    ['DVB-S', 'DVB-S2', 'DVB-S2X', 'DVB-RCS2', 'custom'].every((k) => M.phyOf(k) === null))
  // 两个老 key 一个字都不许改：改了老配置里的 dvbStandard 就指空，MODCOD 下拉退回「自定义」
  ok('★ 两个老 key 原字不动（3GPP NR-NTN / 3GPP NB-IoT NTN）',
    M.BUILTIN_KEYS.indexOf('3GPP NR-NTN') > -1 && M.BUILTIN_KEYS.indexOf('3GPP NB-IoT NTN') > -1)
}

/* —— ④ 合并层：口径识别、只存差异、老档兼容 —— */
ok('normMode 认得出 SNR 的各种写法', ['SNR', 'snr', 'SNR(dB)', 'SINR', 'sinr', '信噪比', 'SNR (dB)'].every((v) => M.normMode(v) === 'snr'))
ok('normMode 不把 Es/N₀ 与 Eb/N₀ 误判成 snr',
  ['Es/N₀', 'EsNo', 'Es/N0', ''].every((v) => M.normMode(v) === 'esno') &&
  ['Eb/N₀', 'EbNo', 'ebno'].every((v) => M.normMode(v) === 'ebno'))
ok('listStandards 现在有 12 个内置标准（4 DVB + 5 NR + 3 NB）', M.listStandards().length === 12)
ok('下拉分组齐全（DVB / 3GPP NR-NTN / 3GPP NB-IoT NTN）',
  ['DVB', '3GPP NR-NTN', '3GPP NB-IoT NTN'].every((g) => M.listStandards().some((s) => s.group === g)))
ok('★ 没动过就不落库：storeFromList(listStandards()) 是空差异（升级后新版门限直接生效）', (() => {
  const st = M.storeFromList(M.listStandards())
  return Object.keys(st.overrides).length === 0 && st.custom.length === 0
})())
ok('改一张新表的一档才落这一张（其余七张仍跟版本走）', (() => {
  const list = M.listStandards().map((s) => (s.key === '3GPP NR-NTN T3'
    ? { ...s, rows: s.rows.map((r, i) => (i === 0 ? { ...r, threshold: -11.0 } : r)) } : s))
  const st = M.storeFromList(list)
  return Object.keys(st.overrides).join(',') === '3GPP NR-NTN T3'
})())
ok('★ 老 modcod.json（无 idx、无 phy、门限口径写 Es/N₀）照旧读得进', (() => {
  const legacy = {
    version: 1,
    overrides: { 'DVB-S2': { rows: [{ label: 'QPSK 1/2', modulation: 'QPSK', fec: '1/2', rsCode: '0.9', bandwidthFactor: 1.2, noiseRatioMode: 'esno', threshold: 1.0 }] } },
    custom: [{ key: 'usr:1', label: '厂家A', rows: [{ label: 'x', modulation: '16APSK', fec: '2/3', noiseRatioMode: 'Es/N0', threshold: 6.5 }] }]
  }
  const st = M.normalizeStore(legacy)
  const r = st.overrides['DVB-S2'].rows[0], c = st.custom[0]
  return r.idx === null && r.noiseRatioMode === 'esno' && r.threshold === 1.0 &&
    c.phy === null && c.meta === null && c.rows[0].idx === null && c.rows[0].modulation === '16APSK'
})())
ok('自建标准可以挂体制骨架与条件元数据，且往返不丢', (() => {
  const st = M.storeFromList([{ key: 'usr:1', label: '厂家A', rows: [{ label: 'a', modulation: 'QPSK', fec: '1/2', noiseRatioMode: 'SNR', threshold: -5.8, idx: 0 }], phy: 'nbiot', meta: { bler: 0.01, channel: 'NTN-TDL-D', source: '厂家实测' } }])
  const c = st.custom[0]
  const back = M.listStandards(st).find((s) => s.key === 'usr:1')
  return c.phy === 'nbiot' && c.meta.bler === 0.01 && c.meta.channel === 'NTN-TDL-D' &&
    c.rows[0].noiseRatioMode === 'snr' && c.rows[0].idx === 0 &&
    back.phy.kind === 'nbiot' && back.meta.source === '厂家实测'
})())
ok('自建标准的体制骨架只认 nr / nbiot，乱填当没填', (() => {
  const st = M.storeFromList([{ key: 'usr:1', label: 'x', rows: [{ label: 'a', modulation: 'QPSK', fec: '1/2' }], phy: 'lte' }])
  return st.custom[0].phy === null
})())

/* —— ⑤ 载波带宽限值判据 —— */
ok('DVB 体制不判', checkNtnBandwidth('DVB-S2X', 36000) === null)
ok('自定义不判', checkNtnBandwidth('custom', 999999) === null)
ok('带宽无效不判', checkNtnBandwidth('3GPP NR-NTN', NaN) === null)
ok('★ snr 口径的行恒不判（带宽本来就是从档位表查出来的，判不出「超限」这件事）',
  checkNtnBandwidth('3GPP NR-NTN', 36000, 'snr') === null &&
  checkNtnBandwidth('3GPP NB-IoT NTN', 999, 'snr') === null)
ok('老式 esno 行照旧判', checkNtnBandwidth('3GPP NR-NTN', 36000, 'esno').level === 'over')

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
// ★ 30 MHz 不再是一档：TS 38.101-5 三个版本的逐频段表（5.3.5-1）里没有任何频段有 30 MHz，
//   CR 0033 只往 N_RB 表加了一列。老式 esno 行的判据回到 Rel-17 的 L/S 四档。
ok('NR-NTN 20 MHz 边界不算超', checkNtnBandwidth('3GPP NR-NTN', 20000).level === 'ok')
ok('★ NR-NTN 25 MHz 判超限（30 MHz 那一档不存在）', checkNtnBandwidth('3GPP NR-NTN', 25000).level === 'over')
ok('★ NR-NTN 30 MHz 判超限', checkNtnBandwidth('3GPP NR-NTN', 30000).level === 'over')
ok('新增的六个 3GPP key 按前缀共用同一份限值', ['3GPP NR-NTN T2', '3GPP NR-NTN T3', '3GPP NR-NTN TP1', '3GPP NR-NTN TP2'].every((k) => isNtnStandard(k) && checkNtnBandwidth(k, 12000).fitKHz === 15000) &&
  ['3GPP NB-IoT NTN NPUSCH MT', '3GPP NB-IoT NTN NPUSCH ST'].every((k) => isNtnStandard(k) && checkNtnBandwidth(k, 198).fitKHz === 200))
// ★ 档位改成写死的 Rel-17 四档：这条判据只对老式 esno 行生效，那些配置成型时平台里只有
//   Rel-17 的 L/S 频段。Rel-19 把 Ku 开到 100 MHz、FR2 开到 400 MHz，并进来只会让「填了 36 MHz」
//   这种明显配不出的带宽落到 50 MHz 档上。新配置走 phy 描述，按频段逐档校验（本判据恒不出）。
ok('老式判据的档位 = Rel-17 的 L/S 四档（5/10/15/20 MHz）',
  NTN_BW_LIMITS['3GPP NR-NTN'].steps.join(',') === '5000,10000,15000,20000')
ok('不再带 rel17MaxKHz 与 30 MHz 文案', NTN_BW_LIMITS['3GPP NR-NTN'].rel17MaxKHz === undefined &&
  NTN_BW_LIMITS['3GPP NR-NTN'].scope.indexOf('30 MHz') < 0)
ok('出处改到 TS 38.101-5 V19.5.0 Table 5.3.5-1 与 TS 36.102 §5.3B',
  NTN_BW_LIMITS['3GPP NR-NTN'].ref === 'TS 38.101-5 V19.5.0 Table 5.3.5-1' &&
  NTN_BW_LIMITS['3GPP NB-IoT NTN'].ref === 'TS 36.102 §5.3B · TS 36.211 §10')
ok('FR2 文案带上 Ku 的 n509 / n508', NTN_BW_LIMITS['3GPP NR-NTN'].fr2Scope.indexOf('n509') > -1 &&
  NTN_BW_LIMITS['3GPP NR-NTN'].fr2Scope.indexOf('n508') > -1)
ok('限值表档位单调递增', Object.values(NTN_BW_LIMITS).every((L) => L.steps.every((s, i) => i === 0 || s > L.steps[i - 1])))

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
