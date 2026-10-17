// RR 附录 7（Rev.WRC-23）· 系统参数表与常数表
//
// 依据：ITU《无线电规则》2024 年版 第 2 卷（附录），官方合订本
//   https://www.itu.int/dms_pub/itu-r/opb/reg/R-REG-RR-2024-ZPF-E.zip
//   （zip SHA-256 ae59067722362d7059d16561abcaa646dca501d642e414faa1f5f6411cb99d8e；
//    卷 2 PDF「2400594-RR-Vol 2-E-A5.pdf」SHA-256 49e283a5c22e57b44b5e0220eee94df4a7d2055418662bf83c125475d98f3abf）
//   附录 7 = PDF 第 181–270 页（页眉 AP7-1 … AP7-90）。
//
// 转录方式：表 7a–10 在 PDF 中为旋转 90° 的横排页，逐页按字形坐标重建行列，再与 300–400 dpi 页面
// 图像逐格对照；上标脚注按字号区分（正文 2.47 / 上标 2.11，PDF 内部单位）。未凭记忆补任何数。
//
// 约定：
//   · null = 原表空格或「–」（不参与计算）；数值单位见各表 fields。
//   · fn = 该列各字段所挂脚注号，如 { Ms: [2], Gx: [2] } 表示「26 ²」「49 ²」。
//   · 频段统一给 bandsGHz（数值，GHz）+ bandsText（原文写法与原单位）。
//   · RR 2024 只有表 9a、9b，没有表 9c。
//
// 转录中发现的原文问题（不改数，只记录；详见 ap7.js 头注与测试）：
//   · 表 7b「14.8-15.35 GHz」一列用逗号作小数点（0,01 / 0,005 / 0,0025），按 0.01 / 0.005 / 0.0025 录入。
//   · 表 7c「24.65-25.25 / 27-27.5 GHz（HAPS 地面站）」列 p0 = 0.01、n = 1，但 p = 0.005（≠ p0/n）。
//   · 表 7c 第 4 列频段为「29.1-29.5」挂脚注 3（文本抽取会误成「29.1-29.53」）。
//   · 表 9a / 9b 中 GSO 接收站一列的 Gr 格内的「8」（9a）与「9」「10」（9b）是脚注号（= 按附件 5 计算），
//     不是 8/9/10 dBi；9a 末列与 9b 各 GSO 列排成正文字号，属排版不一致，按脚注解读。
//   · 表 8c 脚注 11 小型地球站分段在 G = 26 dBi 处不连续（−137 对 −140 dBW），照录。
//   · 表 8b、8c、9a 中 p0 = 0.005、n = 3 的列，p 印作 0.0017（p0/n 取两位有效数字），按印刷值录入；
//     与 p0/n 精确值相比，所需距离对应的预测损耗差 < 0.1 dB。

'use strict';

// ---------------------------------------------------------------------------
// 正文与附件中的小表
// ---------------------------------------------------------------------------

/** 表 3（§4.3）：传播模式 (1) 最大协调距离 dmax1（km），f ≤ 60 GHz。 */
const TABLE_3 = Object.freeze({ A1: 500, A2: 375, B: 900, C: 1200 });

/**
 * 表 4（附件 2 §3）：各雨气候区组的 R(0.3%)（mm/h）与 pc（%）。
 * pc：超过此时间百分比即可认为降雨率 R(p) 为零。eq 字段 = 该组 0.001% < p < 0.3% 所用的式号。
 */
const TABLE_4 = Object.freeze([
  { zones: ['A', 'B'], R03: 1.5, pc: 2, eq: 63 },
  { zones: ['C', 'D', 'E'], R03: 3.5, pc: 3, eq: 64 },
  { zones: ['F', 'G', 'H', 'J', 'K'], R03: 7.0, pc: 5, eq: 65 },
  { zones: ['L', 'M'], R03: 9.0, pc: 7.5, eq: 66 },
  { zones: ['N', 'P', 'Q'], R03: 25.0, pc: 10, eq: 67 }
]);

/** 表 5（附件 2 §3）：垂直极化雨衰系数 k、α。频率间插值：频率取对数、k 取对数、α 线性。 */
const TABLE_5 = Object.freeze([
  { fGHz: 1, k: 0.0000352, alpha: 0.880 },
  { fGHz: 4, k: 0.000591, alpha: 1.075 },
  { fGHz: 6, k: 0.00155, alpha: 1.265 },
  { fGHz: 8, k: 0.00395, alpha: 1.31 },
  { fGHz: 10, k: 0.00887, alpha: 1.264 },
  { fGHz: 12, k: 0.0168, alpha: 1.20 },
  { fGHz: 14, k: 0.029, alpha: 1.15 },
  { fGHz: 18, k: 0.055, alpha: 1.09 },
  { fGHz: 20, k: 0.0691, alpha: 1.065 },
  { fGHz: 22.4, k: 0.090, alpha: 1.05 },
  { fGHz: 25, k: 0.113, alpha: 1.03 },
  { fGHz: 28, k: 0.150, alpha: 1.01 },
  { fGHz: 30, k: 0.167, alpha: 1.00 },
  { fGHz: 35, k: 0.233, alpha: 0.963 },
  { fGHz: 40, k: 0.310, alpha: 0.929 },
  { fGHz: 40.5, k: 0.318, alpha: 0.926 }
]);

/**
 * 表 6（附件 7 §2.1）：双向频段协调中，表 9 未给值时接收地球站的系统噪声温度 Te（K）。
 * 原表三档为 f < 10、10 < f < 17、f > 17（GHz），端点 10、17 未定义——见 ap7.js 的 bidirectionalNoiseTemperature。
 */
const TABLE_6 = Object.freeze([
  { range: 'f < 10', TeK: 75 },
  { range: '10 < f < 17', TeK: 150 },
  { range: 'f > 17', TeK: 300 }
]);

// ---------------------------------------------------------------------------
// 表 7 / 8 / 9 的字段说明
// ---------------------------------------------------------------------------

const FIELDS_7 = Object.freeze({
  service: '发射地球站所属空间业务',
  bandsGHz: '频段（GHz，数值区间）',
  bandsText: '频段（原表写法）',
  terrestrialServices: '接收地面业务',
  method: '应采用的方法（正文章节）',
  modulation: '地面站调制方式（A 模拟 / N 数字）',
  p0: '全部干扰源合计可超过门限的时间百分比 p0（%）',
  n: '等效、等电平、等概率干扰进入数 n',
  p: '单一干扰源可超过容许干扰功率的时间百分比 p = p0/n（%）',
  NL: '链路噪声贡献 NL（dB）',
  Ms: '链路性能余量 Ms（dB）',
  W: '热噪声等效因子 W（dB）',
  Gx: '地面站天线最大增益 Gx（dBi，不含馈线损耗）',
  Te: '地面接收系统噪声温度 Te（K）',
  B: '参考带宽 B（Hz）',
  Pr: '容许干扰功率 Pr(p)（dBW，在 B 内）'
});

const FIELDS_8 = Object.freeze({
  service: '接收地球站所属空间业务',
  bandsGHz: '频段（GHz，数值区间）',
  bandsText: '频段（原表写法）',
  terrestrialServices: '发射地面业务',
  method: '应采用的方法（正文章节）',
  modulation: '地球站调制方式（A 模拟 / N 数字）',
  p0: '全部干扰源合计可超过门限的时间百分比 p0（%）',
  n: '等效干扰进入数 n',
  p: '单一干扰源时间百分比 p（%）',
  NL: '链路噪声贡献 NL（dB）',
  Ms: '链路性能余量 Ms（dB）',
  W: '热噪声等效因子 W（dB）',
  E: '地面站在 B 内的 e.i.r.p. E（dBW），按地面站调制 A/N 分列',
  Pt: '地面站在 B 内的发射功率 Pt（dBW），按地面站调制 A/N 分列',
  Gx: '地面站天线最大增益 Gx（dBi）',
  B: '参考带宽 B（Hz）',
  Pr: '容许干扰功率 Pr(p)（dBW，在 B 内）；空格表示须按式 (127) 由地球站 Te 计算'
});

const FIELDS_9 = Object.freeze({
  service: '发射地球站所属空间业务',
  bandsGHz: '频段（GHz，数值区间）',
  bandsText: '频段（原表写法）',
  rxService: '接收地球站所属空间业务',
  orbit: '接收地球站工作的轨道（GSO / non-GSO）',
  modulation: '接收地球站调制方式（A / N）',
  p0: 'p0（%）', n: 'n', p: 'p（%）', NL: 'NL（dB）', Ms: 'Ms（dB）', W: 'W（dB）',
  Gm: '接收地球站天线轴向增益 Gm（dBi）',
  Gr: '接收地球站地平线增益 Gr（dBi）；GSO 列为 null 并以 grMethod 指明按附件 5 计算',
  grMethod: "'annex5' = 附件 5 §2.1 + 附件 3 §3 方向图；'annex5-alt' = 附件 5 但用表 9b 脚注 10 的 32−25lgφ 方向图",
  epsMinDeg: '接收地球站最低工作仰角 εmin（°）',
  Te: '接收系统噪声温度 Te（K）；缺值按附件 7 §2.1 表 6',
  B: '参考带宽 B（Hz）',
  Pr: '容许干扰功率 Pr(p)（dBW，在 B 内）'
});

// 列构造：缺省字段统一补 null，免得调用方逐个判 undefined
function c7(o) {
  return Object.freeze(Object.assign({
    service: null, bandsGHz: [], bandsText: '', terrestrialServices: null, method: null, modulation: null,
    p0: null, n: null, p: null, NL: null, Ms: null, W: null, Gx: null, Te: null, B: null, Pr: null,
    fn: {}, note: null
  }, o));
}
function c8(o) {
  return Object.freeze(Object.assign({
    service: null, subColumn: null, bandsGHz: [], bandsText: '', terrestrialServices: null, method: null,
    modulation: null, p0: null, n: null, p: null, NL: null, Ms: null, W: null,
    E: { A: null, N: null }, Pt: { A: null, N: null }, Gx: null, B: null, Pr: null, fn: {}, note: null
  }, o));
}
function c9(o) {
  return Object.freeze(Object.assign({
    service: null, bandsGHz: [], bandsText: '', rxService: null, orbit: null, modulation: null,
    p0: null, n: null, p: null, NL: null, Ms: null, W: null, Gm: null, Gr: null, grMethod: null,
    epsMinDeg: null, Te: null, B: null, Pr: null, fn: {}, note: null
  }, o));
}

// ---------------------------------------------------------------------------
// 表 7a（Rev.WRC-12），AP7-76（PDF p.256）—— 发射地球站；原表频段单位 MHz
// ---------------------------------------------------------------------------
const TABLE_7A = Object.freeze({
  id: '7a', revision: 'Rev.WRC-12', page: 'AP7-76', pdfPage: 256, kind: 'tx',
  title: 'Parameters required for the determination of coordination distance for a transmitting earth station',
  fields: FIELDS_7,
  footnotes: Object.freeze({
    1: 'A: analogue modulation; N: digital modulation.',
    2: 'The parameters for the terrestrial station associated with transhorizon systems have been used. Line-of-sight radio-relay parameters associated with the frequency band 1 668.4-1 675 MHz may also be used to determine a supplementary contour. (WRC-03)',
    3: 'Feeder losses are not included.'
  }),
  rowFootnotes: Object.freeze({ modulation: [1], Gx: [3] }),
  columns: Object.freeze([
    c7({ service: 'Mobile-satellite, space operation', bandsGHz: [[0.148, 0.1499]], bandsText: '148.0-149.9 MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'A',
      p0: 1.0, n: 1, p: 1.0, Gx: 8, B: 4e3, Pr: -153 }),
    c7({ service: 'Earth exploration-satellite, meteorological-satellite', bandsGHz: [[0.401, 0.403]], bandsText: '401-403 MHz',
      terrestrialServices: 'Meteorological aids', method: '§ 2.1, § 2.2', modulation: 'A' }),
    c7({ service: 'Earth exploration-satellite, meteorological-satellite', bandsGHz: [[0.401, 0.403]], bandsText: '401-403 MHz',
      terrestrialServices: 'Meteorological aids', method: '§ 2.1, § 2.2', modulation: 'N' }),
    c7({ service: 'Space operation', bandsGHz: [[0.43375, 0.43425]], bandsText: '433.75-434.25 MHz',
      terrestrialServices: 'Amateur, radiolocation fixed, mobile', method: '§ 2.1, § 2.2' }),
    c7({ service: 'Space research, space operation', bandsGHz: [[0.44975, 0.45025]], bandsText: '449.75-450.25 MHz',
      terrestrialServices: 'Fixed, mobile, radiolocation', method: '§ 2.1, § 2.2', modulation: 'A and N',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 20, W: 0, Gx: 16, Te: 750, B: 12.5e3, Pr: -139 }),
    c7({ service: 'Mobile-satellite', bandsGHz: [[0.806, 0.840]], bandsText: '806-840 MHz',
      terrestrialServices: 'Fixed, mobile broadcasting, aeronautical radionavigation', method: '§ 1.4.6', modulation: 'A and N',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 20, W: 0, Gx: 16, Te: 750, B: 12.5e3, Pr: -139 }),
    c7({ service: 'Space operation', bandsGHz: [[1.427, 1.429]], bandsText: '1 427-1 429 MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'A',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 33, W: 0, Gx: 33, Te: 750, B: 4e3, Pr: -131 }),
    c7({ service: 'Space operation', bandsGHz: [[1.427, 1.429]], bandsText: '1 427-1 429 MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 33, W: 0, Gx: 33, Te: 750, B: 1e6, Pr: -107 }),
    c7({ service: 'Mobile-satellite, radiodetermination-satellite', bandsGHz: [[1.610, 1.6265]], bandsText: '1 610-1 626.5 MHz',
      terrestrialServices: 'Aeronautical radionavigation', method: '§ 1.4.6' }),
    c7({ service: 'Mobile-satellite', bandsGHz: [[1.6684, 1.675]], bandsText: '1 668.4-1 675 MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 1.4.6', modulation: 'A',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 33, W: 0, Gx: 35, Te: 750, B: 4e3, Pr: -131 }),
    c7({ service: 'Mobile-satellite', bandsGHz: [[1.6684, 1.675]], bandsText: '1 668.4-1 675 MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 1.4.6', modulation: 'N',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 33, W: 0, Gx: 35, Te: 750, B: 1e6, Pr: -107 }),
    c7({ service: 'Space operation, space research', bandsGHz: [[1.750, 1.850]], bandsText: '1 750-1 850 MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'A',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 33, W: 0, Gx: 35, Te: 750, B: 4e3, Pr: -131 }),
    c7({ service: 'Space operation, space research', bandsGHz: [[1.750, 1.850]], bandsText: '1 750-1 850 MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 33, W: 0, Gx: 35, Te: 750, B: 1e6, Pr: -107 }),
    c7({ service: 'Mobile-satellite', bandsGHz: [[1.980, 2.025]], bandsText: '1 980-2 025 MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 1.4.6', modulation: 'A',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 26, W: 0, Gx: 49, Te: 500, B: 4e3, Pr: -140,
      fn: { Ms: [2], Gx: [2], Te: [2] } }),
    c7({ service: 'Mobile-satellite', bandsGHz: [[1.980, 2.025]], bandsText: '1 980-2 025 MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 1.4.6', modulation: 'N',
      note: '原表此 N 子列全空' }),
    c7({ service: 'Space research, space operation, Earth exploration-satellite', bandsGHz: [[2.025, 2.110], [2.110, 2.120]],
      bandsText: '2 025-2 110 MHz; 2 110-2 120 MHz (Deep space)',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'A',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 26, W: 0, Gx: 49, Te: 500, B: 4e3, Pr: -140,
      fn: { Ms: [2], Gx: [2], Te: [2] } })
  ])
});

// ---------------------------------------------------------------------------
// 表 7b（Rev.WRC-23），AP7-77（PDF p.257）—— 发射地球站；GHz
// ---------------------------------------------------------------------------
const TABLE_7B = Object.freeze({
  id: '7b', revision: 'Rev.WRC-23', page: 'AP7-77', pdfPage: 257, kind: 'tx',
  title: 'Parameters required for the determination of coordination distance for a transmitting earth station',
  fields: FIELDS_7,
  footnotes: Object.freeze({
    1: 'A: analogue modulation; N: digital modulation.',
    2: 'The parameters for the terrestrial station associated with transhorizon systems have been used. Line-of-sight radio-relay parameters associated with the frequency band 5 725-7 075 MHz may also be used to determine a supplementary contour with the exception that Gx = 37 dBi.',
    3: 'Feeder links of non-geostationary satellite systems in the mobile-satellite service.',
    4: 'Feeder losses are not included.',
    5: 'Actual frequency bands are 7 190-7 250 MHz for the Earth exploration-satellite service, 7 100-7 155 MHz and 7 190-7 235 MHz for the space operation service and 7 145-7 235 MHz for the space research service.'
  }),
  rowFootnotes: Object.freeze({ modulation: [1], Gx: [4] }),
  columns: Object.freeze([
    c7({ service: 'Fixed-satellite, mobile-satellite', bandsGHz: [[2.655, 2.690]], bandsText: '2.655-2.690',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'A',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 26, W: 0, Gx: 49, Te: 500, B: 4e3, Pr: -140,
      fn: { Ms: [2], Gx: [2], Te: [2] } }),
    c7({ service: 'Aeronautical mobile-satellite (R) service', bandsGHz: [[5.030, 5.091]], bandsText: '5.030-5.091',
      terrestrialServices: 'Aeronautical radionavigation', method: '§ 2.1, § 2.2', Gx: 6, B: 150e3, Pr: -160 }),
    c7({ service: 'Aeronautical mobile-satellite (R) service', bandsGHz: [[5.030, 5.091]], bandsText: '5.030-5.091',
      terrestrialServices: 'Aeronautical mobile (R)', method: '§ 2.1, § 2.2', Gx: 10, B: 37.5e3, Pr: -157 }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[5.091, 5.150]], bandsText: '5.091-5.150',
      terrestrialServices: 'Aeronautical radionavigation', Gx: 6, B: 150e3, Pr: -160 }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[5.091, 5.150]], bandsText: '5.091-5.150',
      terrestrialServices: 'Aeronautical mobile (R)', Gx: 6, B: 1e6, Pr: -143 }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[5.725, 5.850]], bandsText: '5.725-5.850',
      terrestrialServices: 'Radiolocation', method: '§ 2.1', note: '原表除方法外全空' }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[5.725, 7.075]], bandsText: '5.725-7.075',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'A',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 33, W: 0, Gx: 46, Te: 750, B: 4e3, Pr: -131 }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[5.725, 7.075]], bandsText: '5.725-7.075',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.005, n: 2, p: 0.0025, NL: 0, Ms: 37, W: 0, Gx: 46, Te: 750, B: 1e6, Pr: -103 }),
    c7({ service: 'Earth exploration-satellite, space operation, space research', bandsGHz: [[7.100, 7.250]], bandsText: '7.100-7.250 ⁵',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'A',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 33, W: 0, Gx: 46, Te: 750, B: 4e3, Pr: -131, fn: { bands: [5] } }),
    c7({ service: 'Earth exploration-satellite, space operation, space research', bandsGHz: [[7.100, 7.250]], bandsText: '7.100-7.250 ⁵',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.005, n: 2, p: 0.0025, NL: 0, Ms: 37, W: 0, Gx: 46, Te: 750, B: 1e6, Pr: -103, fn: { bands: [5] } }),
    c7({ service: 'Fixed-satellite, mobile-satellite, meteorological-satellite', bandsGHz: [[7.900, 8.400]], bandsText: '7.900-8.400',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'A',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 33, W: 0, Gx: 46, Te: 750, B: 4e3, Pr: -131 }),
    c7({ service: 'Fixed-satellite, mobile-satellite, meteorological-satellite', bandsGHz: [[7.900, 8.400]], bandsText: '7.900-8.400',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.005, n: 2, p: 0.0025, NL: 0, Ms: 37, W: 0, Gx: 46, Te: 750, B: 1e6, Pr: -103 }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[10.7, 11.7]], bandsText: '10.7-11.7',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'A',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 33, W: 0, Gx: 50, Te: 1500, B: 4e3, Pr: -128 }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[10.7, 11.7]], bandsText: '10.7-11.7',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.005, n: 2, p: 0.0025, NL: 0, Ms: 40, W: 0, Gx: 50, Te: 1100, B: 1e6, Pr: -98 }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[12.5, 14.8]], bandsText: '12.5-14.8',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'A',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 33, W: 0, Gx: 52, Te: 1500, B: 4e3, Pr: -128 }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[12.5, 14.8]], bandsText: '12.5-14.8',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.005, n: 2, p: 0.0025, NL: 0, Ms: 40, W: 0, Gx: 52, Te: 1100, B: 1e6, Pr: -98 }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[13.75, 14.3]], bandsText: '13.75-14.3',
      terrestrialServices: 'Radiolocation radionavigation (land only)', method: '§ 2.1', modulation: '−',
      p0: 0.01, n: 1, p: 0.01, NL: 0, Ms: 1, W: 0, Gx: 36, Te: 2636, B: 1e7, Pr: -131 }),
    c7({ service: 'Space research', bandsGHz: [[14.8, 15.35]], bandsText: '14.8-15.35',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'A',
      p0: 0.01, n: 2, p: 0.005, NL: 0, Ms: 33, W: 0, Gx: 52, Te: 1500, B: 4e3, Pr: -128,
      note: '原表以逗号作小数点：0,01 / 0,005' }),
    c7({ service: 'Space research', bandsGHz: [[14.8, 15.35]], bandsText: '14.8-15.35',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.005, n: 2, p: 0.0025, NL: 0, Ms: 40, W: 0, Gx: 52, Te: 1100, B: 1e6, Pr: -98,
      note: '原表以逗号作小数点：0,005 / 0,0025' }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[15.43, 15.65]], bandsText: '15.43-15.65',
      terrestrialServices: 'Aeronautical radionavigation', fn: { service: [3] }, note: '原表全空' }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[17.7, 18.4]], bandsText: '17.7-18.4',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.005, n: 2, p: 0.0025, NL: 0, Ms: 25, W: 0, Gx: 48, Te: 1100, B: 1e6, Pr: -113 }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[19.3, 19.7]], bandsText: '19.3-19.7',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.2', modulation: 'N',
      p0: 0.005, n: 2, p: 0.0025, NL: 0, Ms: 25, W: 0, Gx: 48, Te: 1100, B: 1e6, Pr: -113, fn: { service: [3] } })
  ])
});

// ---------------------------------------------------------------------------
// 表 7c（Rev.WRC-19），AP7-78（PDF p.258）—— 发射地球站；GHz
// ---------------------------------------------------------------------------
const TABLE_7C = Object.freeze({
  id: '7c', revision: 'Rev.WRC-19', page: 'AP7-78', pdfPage: 258, kind: 'tx',
  title: 'Parameters required for the determination of coordination distance for a transmitting earth station',
  fields: FIELDS_7,
  footnotes: Object.freeze({
    1: 'A: analogue modulation; N: digital modulation.',
    2: 'Non-geostationary satellites in the fixed-satellite service.',
    3: 'Feeder links to non-geostationary-satellite systems in the mobile-satellite service.',
    4: 'Feeder losses are not included.',
    5: 'Maximum HAPS ground station antenna gain toward the horizon.'
  }),
  rowFootnotes: Object.freeze({ modulation: [1], Gx: [4] }),
  columns: Object.freeze([
    c7({ service: 'Fixed-satellite', bandsGHz: [[24.65, 25.25], [27.0, 29.5]], bandsText: '24.65-25.25; 27.0-29.5',
      terrestrialServices: 'Fixed (except HAPS), mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.005, n: 1, p: 0.005, NL: 0, Ms: 25, W: 0, Gx: 50, Te: 2000, B: 1e6, Pr: -111 }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[24.65, 25.25], [27, 27.5]], bandsText: '24.65-25.25; 27-27.5',
      terrestrialServices: 'Fixed (HAPS ground station)', method: '§ 2.1', modulation: 'N',
      p0: 0.01, n: 1, p: 0.005, NL: 0, Ms: 10, W: 0, Gx: 0, Te: 350, B: 1e6, Pr: -134, fn: { Gx: [5] },
      note: '原表 p0 = 0.01、n = 1 而 p = 0.005（≠ p0/n），照录' }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[28.6, 29.1]], bandsText: '28.6-29.1',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.2', modulation: 'N',
      p0: 0.005, n: 2, p: 0.0025, NL: 0, Ms: 25, W: 0, Gx: 50, Te: 2000, B: 1e6, Pr: -111, fn: { service: [2] } }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[27.5, 28.6], [29.1, 29.5]], bandsText: '27.5-28.6; 29.1-29.5 ³',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.2', modulation: 'N',
      p0: 0.005, n: 1, p: 0.005, NL: 0, Ms: 25, W: 0, Gx: 50, Te: 2000, B: 1e6, Pr: -111, fn: { bands: [3] } }),
    c7({ service: 'Space research', bandsGHz: [[34.2, 34.7]], bandsText: '34.2-34.7',
      terrestrialServices: 'Fixed, mobile, radiolocation', note: '原表全空' }),
    c7({ service: 'Earth exploration-satellite, space research', bandsGHz: [[40.0, 40.5]], bandsText: '40.0-40.5',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.005, n: 1, p: 0.005, NL: 0, Ms: 25, W: 0, Gx: 42, Te: 2600, B: 1e6, Pr: -110 }),
    c7({ service: 'Fixed-satellite, mobile-satellite, radionavigation-satellite', bandsGHz: [[42.5, 47], [47.2, 50.2], [50.4, 51.4]],
      bandsText: '42.5-47; 47.2-50.2; 50.4-51.4',
      terrestrialServices: 'Fixed, mobile, radionavigation', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.005, n: 1, p: 0.005, NL: 0, Ms: 25, W: 0, Gx: 42, Te: 2600, B: 1e6, Pr: -110 }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[47.2, 50.2]], bandsText: '47.2-50.2',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.2', modulation: 'N',
      p0: 0.001, n: 1, p: 0.001, NL: 0, Ms: 25, W: 0, Gx: 46, Te: 2000, B: 1e6, Pr: -111, fn: { service: [2] } }),
    c7({ service: 'Fixed-satellite', bandsGHz: [[51.4, 52.4]], bandsText: '51.4-52.4',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.005, n: 1, p: 0.005, NL: 0, Ms: 25, W: 0, Gx: 42, Te: 2600, B: 1e6, Pr: -110 })
  ])
});

// ---------------------------------------------------------------------------
// 表 8a（Rev.WRC-23），AP7-79（PDF p.259）—— 接收地球站；原表频段单位 MHz
// ---------------------------------------------------------------------------
const TABLE_8A = Object.freeze({
  id: '8a', revision: 'Rev.WRC-23', page: 'AP7-79', pdfPage: 259, kind: 'rx',
  title: 'Parameters required for the determination of coordination distance for a receiving earth station',
  fields: FIELDS_8,
  footnotes: Object.freeze({
    1: 'In the band 2 160-2 200 MHz, the terrestrial station parameters of line-of-sight radio-relay systems have been used. If an administration believes that, in this band transhorizon systems need to be considered, the parameters associated with the frequency band 2 500-2 690 MHz may be used to determine the coordination area.',
    2: 'A: analogue modulation; N: digital modulation.',
    3: 'E is defined as the equivalent isotropically radiated power of the interfering terrestrial station in the reference bandwidth.',
    4: 'This value is reduced from the nominal value of 50 dBW for the purposes of determination of coordination area, recognizing the low probability of high power emissions falling fully within the relatively narrow bandwidth of the earth station.',
    5: 'The fixed-service parameters provided in the column for 163-167 MHz and 272-273 MHz are only applicable to the band 163-167 MHz.'
  }),
  rowFootnotes: Object.freeze({ modulation: [2], E: [3] }),
  columns: Object.freeze([
    c8({ service: 'Space operation, space research', bandsGHz: [[0.137, 0.138]], bandsText: '137-138 MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.1, n: 2, p: 0.05, NL: 0, Ms: 1, W: 0, B: 1, Pr: -199 }),
    c8({ service: 'Meteorological-satellite, mobile-satellite', bandsGHz: [[0.137, 0.138]], bandsText: '137-138 MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1' }),
    c8({ service: 'Space research', bandsGHz: [[0.1436, 0.14365]], bandsText: '143.6-143.65 MHz',
      terrestrialServices: 'Fixed, mobile, radiolocation', method: '§ 2.1', modulation: 'N',
      p0: 0.1, n: 2, p: 0.05, NL: 0, Ms: 1, W: 0, B: 1, Pr: -199 }),
    c8({ service: 'Space research, space operation', bandsGHz: [[0.174, 0.184]], bandsText: '174-184 MHz',
      terrestrialServices: 'Fixed, mobile, broadcasting', method: '§ 2.1' }),
    c8({ service: 'Space operation', bandsGHz: [[0.163, 0.167], [0.272, 0.273]], bandsText: '163-167 MHz; 272-273 MHz ⁵',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 1.0, n: 1, p: 1.0, NL: 0, Ms: 1, W: 0, E: { A: 15, N: 15 }, Pt: { A: -1, N: -1 }, Gx: 16, B: 1e3, Pr: -173,
      fn: { bands: [5] } }),
    c8({ service: 'Mobile-satellite', bandsGHz: [[0.3354, 0.3999]], bandsText: '335.4-399.9 MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 1.4.6' }),
    c8({ service: 'Meteorological-satellite', bandsGHz: [[0.40015, 0.401]], bandsText: '400.15-401 MHz',
      terrestrialServices: 'Meteorological aids', method: '§ 1.4.6',
      p0: 0.012, n: 1, p: 0.012, NL: 0, Ms: 4.3, W: 0, B: 177.5e3, Pr: -148 }),
    c8({ service: 'Mobile-satellite', bandsGHz: [[0.40015, 0.401]], bandsText: '400.15-401 MHz',
      terrestrialServices: 'Meteorological aids', method: '§ 1.4.6' }),
    c8({ service: 'Space research', bandsGHz: [[0.40015, 0.401]], bandsText: '400.15-401 MHz',
      terrestrialServices: 'Meteorological aids', method: '–', modulation: 'N',
      p0: 0.1, n: 2, p: 0.05, NL: 0, Ms: 1, W: 0, B: 1, Pr: -208 }),
    c8({ service: 'Space operation', bandsGHz: [[0.401, 0.402]], bandsText: '401-402 MHz',
      terrestrialServices: 'Meteorological aids, fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.1, n: 2, p: 0.05, NL: 0, Ms: 1, W: 0, B: 1, Pr: -208 }),
    c8({ service: 'Meteorological-satellite', bandsGHz: [[0.460, 0.470]], bandsText: '460-470 MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1',
      p0: 0.012, n: 1, p: 0.012, E: { A: 5, N: 5 }, Pt: { A: -11, N: -11 }, Gx: 16, B: 85, Pr: -178 }),
    c8({ service: 'Mobile-satellite', bandsGHz: [[0.856, 0.890]], bandsText: '856-890 MHz',
      terrestrialServices: 'Fixed, mobile, broadcasting', method: '§ 1.4.6' }),
    c8({ service: 'Broadcasting-satellite (DAB)', bandsGHz: [[1.452, 1.492]], bandsText: '1 452-1 492 MHz',
      terrestrialServices: 'Fixed, mobile, broadcasting', method: '§ 1.4.5', modulation: 'N',
      E: { A: 38, N: 38 }, Pt: { A: 3, N: 3 }, Gx: 35, B: 25e3 }),
    c8({ service: 'Mobile-satellite, land-mobile satellite, maritime mobile-satellite',
      bandsGHz: [[1.518, 1.530], [1.555, 1.559], [2.160, 2.200]], bandsText: '1 518-1 530; 1 555-1 559; 2 160-2 200 ¹ MHz',
      terrestrialServices: 'Fixed, mobile', method: '§ 1.4.6', modulation: 'N',
      p0: 10, n: 1, p: 10, NL: 0, Ms: 1, W: 0, E: { A: 37, N: 37 }, Pt: { A: 0, N: 0 }, Gx: 37, B: 4e3, Pr: -176,
      fn: { bands: [1], EA: [4] } })
  ])
});

// ---------------------------------------------------------------------------
// 表 8b（Rev.WRC-12），AP7-80（PDF p.260）—— 接收地球站；GHz
// ---------------------------------------------------------------------------
const TABLE_8B = Object.freeze({
  id: '8b', revision: 'Rev.WRC-12', page: 'AP7-80', pdfPage: 260, kind: 'rx',
  title: 'Parameters required for the determination of coordination distance for a receiving earth station',
  fields: FIELDS_8,
  footnotes: Object.freeze({
    1: 'See Table 10.',
    2: 'A: analogue modulation; N: digital modulation.',
    3: 'E is defined as the equivalent isotropically radiated power of the interfering terrestrial station in the reference bandwidth.',
    4: 'In this band, the parameters for the terrestrial stations associated with transhorizon systems have been used. If an administration believes that transhorizon systems do not need to be considered, the line-of-sight radio-relay parameters associated with the frequency band 3.4-4.2 GHz may be used to determine the coordination area, with the exception that E = 50 dBW for analogue terrestrial stations; and Gx = 37 dBi. However, for the space research service only, noting footnote 5 when transhorizon systems are not considered, E = 20 dBW and Pt = −17 dBW for analogue terrestrial stations, E = −23 dBW and Pt = −60 dBW for digital terrestrial stations; and Gx = 37 dBi.',
    5: 'These values are estimated for 1 Hz bandwidth and are 30 dB below the total power assumed for emission.',
    6: 'In the band 2.4835-2.5 GHz the terrestrial station parameters of line-of-sight radio-relay systems have been used. If an administration believes that, in this band, transhorizon systems need to be considered, the parameters associated with the frequency band 2 500-2 690 MHz may be used to determine the coordination area.'
  }),
  rowFootnotes: Object.freeze({ modulation: [2], E: [3] }),
  columns: Object.freeze([
    c8({ service: 'Space operation (GSO and non-GSO)', bandsGHz: [[1.525, 1.535]], bandsText: '1.525-1.535',
      terrestrialServices: 'Fixed', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 1.0, n: 1, p: 1.0, NL: 0, Ms: 1, W: 0, E: { A: 50, N: 37 }, Pt: { A: 13, N: 0 }, Gx: 37, B: 1e3, Pr: -184 }),
    c8({ service: 'Meteorological-satellite (non-GSO)', bandsGHz: [[1.670, 1.710]], bandsText: '1.670-1.710',
      terrestrialServices: 'Fixed, mobile, meteorological aids', method: '§ 2.2 and ¹', modulation: 'N',
      p0: 0.006, n: 3, p: 0.002, NL: 0, Ms: 2.8, W: 0, E: { A: 92, N: null }, Pt: { A: 40, N: null }, Gx: 52, B: 1e6, Pr: -142,
      fn: { method: [1], EA: [4], PtA: [4] } }),
    c8({ service: 'Meteorological-satellite (GSO)', bandsGHz: [[1.670, 1.710]], bandsText: '1.670-1.710',
      terrestrialServices: 'Fixed, mobile, meteorological aids', method: '§ 2.1 and ¹', modulation: 'N',
      p0: 0.011, n: 2, p: 0.0055, NL: 0, Ms: 0.9, W: 0, E: { A: 92, N: null }, Pt: { A: 40, N: null }, Gx: 52, B: 4e3, Pr: -177,
      fn: { method: [1], EA: [4], PtA: [4] } }),
    c8({ service: 'Space research near-Earth (non-GSO and GSO)', subColumn: 'Unmanned',
      bandsGHz: [[1.700, 1.710], [2.200, 2.290]], bandsText: '1.700-1.710; 2.200-2.290',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.1, n: 2, p: 0.05, NL: 0, Ms: 1, W: 0, E: { A: -27, N: -27 }, Pt: { A: -71, N: -71 }, Gx: 44, B: 1, Pr: -216,
      fn: { EA: [4, 5], PtA: [4, 5] }, note: 'NL 至 Pr 各行为 Unmanned/Manned 两子列合并格' }),
    c8({ service: 'Space research near-Earth (non-GSO and GSO)', subColumn: 'Manned',
      bandsGHz: [[1.700, 1.710], [2.200, 2.290]], bandsText: '1.700-1.710; 2.200-2.290',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.001, n: 1, p: 0.001, NL: 0, Ms: 1, W: 0, E: { A: -27, N: -27 }, Pt: { A: -71, N: -71 }, Gx: 44, B: 1, Pr: -216,
      fn: { EA: [4, 5], PtA: [4, 5] }, note: 'NL 至 Pr 各行为 Unmanned/Manned 两子列合并格' }),
    c8({ service: 'Space research deep space (non-GSO)', bandsGHz: [[2.290, 2.300]], bandsText: '2.290-2.300',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.2', modulation: 'N',
      p0: 0.001, n: 1, p: 0.001, NL: 0, Ms: 0.5, W: 0, E: { A: -27, N: -27 }, Pt: { A: -71, N: -71 }, Gx: 44, B: 1, Pr: -222,
      fn: { EA: [5], PtA: [5] } }),
    c8({ service: 'Space operation (non-GSO and GSO)', bandsGHz: [[2.200, 2.290]], bandsText: '2.200-2.290',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 1.0, n: 2, p: 0.5, NL: 0, Ms: 1, W: 0, E: { A: 72, N: 76 }, Pt: { A: 28, N: 32 }, Gx: 44, B: 1e6, Pr: -154 }),
    c8({ service: 'Earth exploration-satellite (GSO)', bandsGHz: [[2.200, 2.290]], bandsText: '2.200-2.290',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 1.0, n: 2, p: 0.5, E: { A: 72, N: 76 }, Pt: { A: 28, N: 32 }, Gx: 44, B: 1e6, Pr: -154,
      fn: { EA: [4], PtA: [4] } }),
    c8({ service: 'Broadcasting-satellite', bandsGHz: [[2.310, 2.360]], bandsText: '2.310-2.360',
      terrestrialServices: 'Fixed, mobile, radiolocation', method: '§ 1.4.5' }),
    c8({ service: 'Mobile-satellite, radiodetermination-satellite', bandsGHz: [[2.4835, 2.500]], bandsText: '2.4835-2.500 ⁶',
      terrestrialServices: 'Fixed, mobile, radiolocation', method: '§ 1.4.6', modulation: 'N',
      p0: 10, n: 1, p: 10, NL: 0, Ms: 1, W: 0, E: { A: 37, N: 37 }, Pt: { A: 0, N: 0 }, Gx: 37, B: 4e3, Pr: -176,
      fn: { bands: [6] } }),
    c8({ service: 'Fixed-satellite, broadcasting satellite', bandsGHz: [[2.500, 2.690]], bandsText: '2.500-2.690',
      terrestrialServices: 'Fixed, mobile radiolocation', method: '§ 1.4.5 and § 2.1', modulation: 'A',
      p0: 0.03, n: 3, p: 0.01, NL: 1, Ms: 7, W: 4, E: { A: 72, N: 76 }, Pt: { A: 28, N: 32 }, Gx: 44, B: 1e6,
      fn: { EA: [4], PtA: [4] } }),
    c8({ service: 'Fixed-satellite, broadcasting satellite', bandsGHz: [[2.500, 2.690]], bandsText: '2.500-2.690',
      terrestrialServices: 'Fixed, mobile radiolocation', method: '§ 1.4.5 and § 2.1', modulation: 'N',
      p0: 0.003, n: 3, p: 0.001, NL: 1, Ms: 2, W: 0, E: { A: 72, N: 76 }, Pt: { A: 28, N: 32 }, Gx: 44, B: 1e6,
      fn: { EA: [4], PtA: [4] } }),
    c8({ service: 'Fixed-satellite', bandsGHz: [[3.400, 4.200]], bandsText: '3.400-4.200',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'A',
      p0: 0.03, n: 3, p: 0.01, NL: 1, Ms: 7, W: 4, E: { A: 55, N: 42 }, Pt: { A: 13, N: 0 }, Gx: 42, B: 1e6 }),
    c8({ service: 'Fixed-satellite', bandsGHz: [[3.400, 4.200]], bandsText: '3.400-4.200',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.005, n: 3, p: 0.0017, NL: 1, Ms: 2, W: 0, E: { A: 55, N: 42 }, Pt: { A: 13, N: 0 }, Gx: 42, B: 1e6 })
  ])
});

// ---------------------------------------------------------------------------
// 表 8c（Rev.WRC-23），AP7-81 / 脚注 AP7-82（PDF p.261–262）—— 接收地球站；GHz
// ---------------------------------------------------------------------------
const TABLE_8C = Object.freeze({
  id: '8c', revision: 'Rev.WRC-23', page: 'AP7-81', pdfPage: 261, kind: 'rx',
  title: 'Parameters required for the determination of coordination distance for a receiving earth station',
  fields: FIELDS_8,
  footnotes: Object.freeze({
    1: 'A: analogue modulation; N: digital modulation.',
    2: 'E is defined as the equivalent isotropically radiated power of the interfering terrestrial station in the reference bandwidth.',
    3: 'In this band, the parameters for the terrestrial stations associated with transhorizon systems have been used. If an administration believes that transhorizon systems do not need to be considered, the line-of-sight radio-relay parameters associated with the frequency band 3.4-4.2 GHz may be used to determine the coordination area.',
    4: 'Digital systems assumed to be non-transhorizon. Therefore Gx = 42.0 dBi. For digital transhorizon systems, parameters for analogue transhorizon systems above have been used.',
    5: 'These values are estimated for 1 Hz bandwidth and are 30 dB below the total power assumed for emission.',
    6: 'In certain systems in the fixed-satellite service it may be desirable to choose a greater reference bandwidth B. However, a greater bandwidth will result in smaller coordination distances and a later decision to reduce the reference bandwidth may require recoordination of the earth station.',
    7: 'Geostationary-satellite systems.',
    8: 'Non-geostationary satellites in the meteorological-satellite service notified in accordance with No. 5.461A may use the same coordination parameters.',
    9: 'Non-geostationary satellite systems.',
    10: 'Space research earth stations in the frequency band 8.4-8.5 GHz operate with non-geostationary satellites.',
    11: 'For large earth stations: Pr(p) = (G − 180) dBW. For small earth stations: Pr(20%) = 2 (G − 26) − 140 dBW for 26 < G ≤ 29 dBi; Pr(20%) = G − 163 dBW for G > 29 dBi; Pr(p)% = G − 163 dBW for G ≤ 26 dBi.',
    12: 'Applies to the broadcasting-satellite service in unplanned bands in Region 3.'
  }),
  rowFootnotes: Object.freeze({ modulation: [1], E: [2], B: [6] }),
  columns: Object.freeze([
    c8({ service: 'Fixed-satellite', bandsGHz: [[4.500, 4.800]], bandsText: '4.500-4.800',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'A',
      p0: 0.03, n: 3, p: 0.01, NL: 1, Ms: 7, W: 4, E: { A: 92, N: 42 }, Pt: { A: 40, N: 0 }, Gx: 52, B: 1e6,
      fn: { EA: [3], EN: [4], PtA: [3], Gx: [3, 4] } }),
    c8({ service: 'Fixed-satellite', bandsGHz: [[4.500, 4.800]], bandsText: '4.500-4.800',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.005, n: 3, p: 0.0017, NL: 1, Ms: 2, W: 0, E: { A: 92, N: 42 }, Pt: { A: 40, N: 0 }, Gx: 52, B: 1e6,
      fn: { EA: [3], EN: [4], PtA: [3], Gx: [3, 4] } }),
    c8({ service: 'Fixed-satellite, radiodetermination satellite', bandsGHz: [[5.150, 5.216]], bandsText: '5.150-5.216',
      terrestrialServices: 'Aeronautical radionavigation', method: '§ 2.1' }),
    c8({ service: 'Fixed-satellite', bandsGHz: [[6.700, 7.075]], bandsText: '6.700-7.075',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.2', modulation: 'N',
      p0: 0.005, n: 3, p: 0.0017, NL: 1, Ms: 2, W: 0, E: { A: 55, N: 42 }, Pt: { A: 13, N: 0 }, Gx: 42, B: 1e6, Pr: -151.2 }),
    c8({ service: 'Fixed-satellite', bandsGHz: [[7.250, 7.750]], bandsText: '7.250-7.750',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'A',
      p0: 0.03, n: 3, p: 0.01, NL: 1, Ms: 7, W: 4, E: { A: 55, N: 42 }, Pt: { A: 13, N: 0 }, Gx: 42, B: 1e6 }),
    c8({ service: 'Fixed-satellite', bandsGHz: [[7.250, 7.750]], bandsText: '7.250-7.750',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.005, n: 3, p: 0.0017, NL: 1, Ms: 2, W: 0, E: { A: 55, N: 42 }, Pt: { A: 13, N: 0 }, Gx: 42, B: 1e6 }),
    c8({ service: 'Meteorological-satellite', bandsGHz: [[7.450, 7.550]], bandsText: '7.450-7.550',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.002, n: 2, p: 0.001, E: { A: 55, N: 42 }, Pt: { A: 13, N: 0 }, Gx: 42, B: 1e7, Pr: -125,
      fn: { service: [7, 8] } }),
    c8({ service: 'Meteorological-satellite', bandsGHz: [[7.750, 7.900]], bandsText: '7.750-7.900',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.2', modulation: 'N',
      p0: 0.001, n: 2, p: 0.0005, E: { A: 55, N: 42 }, Pt: { A: 13, N: 0 }, Gx: 42, B: 1e7, Pr: -125,
      fn: { service: [9] } }),
    c8({ service: 'Earth exploration-satellite', bandsGHz: [[8.025, 8.400]], bandsText: '8.025-8.400',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.083, n: 2, p: 0.0415, NL: 1, Ms: 2, W: 0, E: { A: 55, N: 42 }, Pt: { A: 13, N: 0 }, Gx: 42, B: 1e6, Pr: -154,
      fn: { service: [7], Pr: [11] } }),
    c8({ service: 'Earth exploration-satellite', bandsGHz: [[8.025, 8.400]], bandsText: '8.025-8.400',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.2', modulation: 'N',
      p0: 0.011, n: 2, p: 0.0055, NL: 0, Ms: 4.7, W: 0, E: { A: 55, N: 42 }, Pt: { A: 13, N: 0 }, Gx: 42, B: 1e6, Pr: -142,
      fn: { service: [9] } }),
    c8({ service: 'Space research', subColumn: 'Deep space', bandsGHz: [[8.400, 8.450]], bandsText: '8.400-8.450',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.2', modulation: 'N',
      p0: 0.001, n: 1, p: 0.001, NL: 0, Ms: 0.5, W: 0, E: { A: 25, N: -18 }, Pt: { A: -17, N: -60 }, Gx: 42, B: 1, Pr: -220,
      fn: { service: [10], EA: [5], PtA: [5] } }),
    c8({ service: 'Space research', bandsGHz: [[8.450, 8.500]], bandsText: '8.450-8.500',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.2', modulation: 'N',
      p0: 0.1, n: 2, p: 0.05, NL: 0, Ms: 1, W: 0, E: { A: 25, N: -18 }, Pt: { A: -17, N: -60 }, Gx: 42, B: 1, Pr: -216,
      fn: { service: [10], EA: [5], PtA: [5] } }),
    c8({ service: 'Fixed-satellite', bandsGHz: [[10.7, 12.75], [13.4, 13.65]], bandsText: '10.7-12.75; 13.4-13.65 ⁷',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'A',
      p0: 0.03, n: 2, p: 0.015, NL: 1, Ms: 7, W: 4, E: { A: 40, N: 43 }, Pt: { A: -5, N: -2 }, Gx: 45, B: 1e6,
      fn: { bands: [7] } }),
    c8({ service: 'Fixed-satellite', bandsGHz: [[10.7, 12.75], [13.4, 13.65]], bandsText: '10.7-12.75; 13.4-13.65 ⁷',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.003, n: 2, p: 0.0015, NL: 1, Ms: 4, W: 0, E: { A: 40, N: 43 }, Pt: { A: -5, N: -2 }, Gx: 45, B: 1e6,
      fn: { bands: [7] } }),
    c8({ service: 'Broadcasting-satellite', bandsGHz: [[12.5, 12.75]], bandsText: '12.5-12.75 ¹²',
      terrestrialServices: 'Fixed, mobile', method: '§ 1.4.5', modulation: 'A',
      p0: 0.03, n: 1, p: 0.03, NL: 1, Ms: 7, W: 4, E: { A: 55, N: 42 }, Pt: { A: 10, N: -3 }, Gx: 45, B: 27e6, Pr: -131,
      fn: { bands: [12] } }),
    c8({ service: 'Broadcasting-satellite', bandsGHz: [[12.5, 12.75]], bandsText: '12.5-12.75 ¹²',
      terrestrialServices: 'Fixed, mobile', method: '§ 1.4.5', modulation: 'N',
      p0: 0.003, n: 1, p: 0.003, NL: 1, Ms: 4, W: 0, E: { A: 55, N: 42 }, Pt: { A: 10, N: -3 }, Gx: 45, B: 27e6, Pr: -131,
      fn: { bands: [12] } }),
    c8({ service: 'Space research', bandsGHz: [[14.8, 15.35]], bandsText: '14.8-15.35',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.1, n: 2, p: 0.05, NL: 0, Ms: 1, W: 0, E: { A: 32, N: 40 }, Pt: { A: -5, N: -5 }, Gx: 35, B: 1e6, Pr: -156 }),
    c8({ service: 'Broadcasting-satellite', bandsGHz: [[17.7, 17.8]], bandsText: '17.7-17.8',
      terrestrialServices: 'Fixed', method: '§ 1.4.5',
      E: { A: null, N: 40 }, Pt: { A: null, N: -7 }, Gx: 47 }),
    c8({ service: 'Fixed-satellite', bandsGHz: [[17.7, 18.8], [19.3, 19.7]], bandsText: '17.7-18.8; 19.3-19.7',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.003, n: 2, p: 0.0015, NL: 1, Ms: 6, W: 0, E: { A: 35, N: 40 }, Pt: { A: -10, N: -5 }, Gx: 45, B: 1e6,
      fn: { service: [7] } })
  ])
});

// ---------------------------------------------------------------------------
// 表 8d（Rev.WRC-19），AP7-83（PDF p.263）—— 接收地球站；GHz
// ---------------------------------------------------------------------------
const TABLE_8D = Object.freeze({
  id: '8d', revision: 'Rev.WRC-19', page: 'AP7-83', pdfPage: 263, kind: 'rx',
  title: 'Parameters required for the determination of coordination distance for a receiving earth station',
  fields: FIELDS_8,
  footnotes: Object.freeze({
    1: 'A: analogue modulation; N: digital modulation.',
    2: 'E is defined as the equivalent isotropically radiated power of the interfering terrestrial station in the reference bandwidth.',
    3: 'Non-geostationary mobile-satellite service feeder links.',
    4: 'Non-geostationary-satellite systems.',
    5: 'Geostationary-satellite systems.',
    6: 'Non-geostationary fixed-satellite service systems.',
    7: 'In certain systems in the fixed-satellite service it may be desirable to choose a greater reference bandwidth B. However, a greater bandwidth will result in smaller coordination distances, and a later decision to reduce the reference bandwidth may require recoordination of the earth station.'
  }),
  rowFootnotes: Object.freeze({ modulation: [1], E: [2], B: [7] }),
  columns: Object.freeze([
    c8({ service: 'Meteorological-satellite', bandsGHz: [[18.0, 18.4]], bandsText: '18.0-18.4',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.05, n: 2, p: 0.025, NL: 0, Ms: 18.8, W: 0, E: { A: null, N: 40 }, Pt: { A: null, N: -7 }, Gx: 47, B: 1e7, Pr: -115 }),
    c8({ service: 'Fixed-satellite', bandsGHz: [[17.8, 18.6], [18.8, 19.3]], bandsText: '17.8-18.6 ⁴; 18.8-19.3',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.003, n: 2, p: 0.0015, NL: 0, Ms: 5, W: 0, E: { A: null, N: 40 }, Pt: { A: null, N: -7 }, Gx: 47, B: 1e6, Pr: -140,
      fn: { bands: [4] } }),
    c8({ service: 'Fixed-satellite', bandsGHz: [[19.3, 19.7]], bandsText: '19.3-19.7',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.2', modulation: 'N',
      p0: 0.01, n: 1, p: 0.01, NL: 0, Ms: 5, W: 0, E: { A: null, N: 40 }, Pt: { A: null, N: -7 }, Gx: 47, B: 1e6, Pr: -137,
      fn: { service: [3] } }),
    c8({ service: 'Broadcasting-satellite', bandsGHz: [[21.4, 22.0]], bandsText: '21.4-22.0',
      terrestrialServices: 'Fixed, mobile', method: '§ 1.4.5',
      E: { A: null, N: 40 }, Pt: { A: null, N: -7 }, Gx: 47 }),
    c8({ service: 'Earth exploration-satellite', bandsGHz: [[25.5, 27.0]], bandsText: '25.5-27.0',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.2', modulation: 'N',
      p0: 0.25, n: 2, p: 0.125, NL: 0, Ms: 11.4, W: 0, E: { A: null, N: 42 }, Pt: { A: null, N: -3 }, Gx: 45, B: 1e7, Pr: -120,
      fn: { service: [4] } }),
    c8({ service: 'Earth exploration-satellite', bandsGHz: [[25.5, 27.0]], bandsText: '25.5-27.0',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.25, n: 2, p: 0.125, NL: 0, Ms: 14, W: 0, E: { A: null, N: 42 }, Pt: { A: null, N: -3 }, Gx: 45, B: 1e7, Pr: -116,
      fn: { service: [5] } }),
    c8({ service: 'Space research (deep space)', bandsGHz: [[31.8, 32.3]], bandsText: '31.8-32.3',
      terrestrialServices: 'Fixed, radionavigation', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.001, n: 1, p: 0.001, NL: 0, Ms: 1, W: 0, E: { A: null, N: -28 }, Pt: { A: null, N: -81 }, Gx: 53, B: 1, Pr: -216 }),
    c8({ service: 'Space research', subColumn: 'Unmanned', bandsGHz: [[37.0, 38.0]], bandsText: '37.0-38.0',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.1, n: 1, p: 0.1, NL: 0, Ms: 1, W: 0, E: { A: null, N: -28 }, Pt: { A: null, N: -73 }, Gx: 45, B: 1, Pr: -217,
      note: 'NL 至 Pr 各行为 Unmanned/Manned 两子列合并格' }),
    c8({ service: 'Space research', subColumn: 'Manned', bandsGHz: [[37.0, 38.0]], bandsText: '37.0-38.0',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1, § 2.2', modulation: 'N',
      p0: 0.001, n: 1, p: 0.001, NL: 0, Ms: 1, W: 0, E: { A: null, N: -28 }, Pt: { A: null, N: -73 }, Gx: 45, B: 1, Pr: -217,
      note: 'NL 至 Pr 各行为 Unmanned/Manned 两子列合并格' }),
    c8({ service: 'Fixed-satellite', bandsGHz: [[37.5, 40.5]], bandsText: '37.5-40.5',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.2', modulation: 'N',
      p0: 0.02, NL: 1, Ms: 6.8, W: 0, E: { A: null, N: 35 }, Pt: { A: null, N: -10 }, Gx: 45, B: 1e6, Pr: -140,
      fn: { service: [6] }, note: '原表 n、p 两格为空' }),
    c8({ service: 'Fixed-satellite', bandsGHz: [[37.5, 40.5]], bandsText: '37.5-40.5',
      terrestrialServices: 'Fixed, mobile', method: '§ 2.1', modulation: 'N',
      p0: 0.003, n: 2, p: 0.0015, NL: 1, Ms: 6, W: 0, E: { A: null, N: 35 }, Pt: { A: null, N: -10 }, Gx: 45, B: 1e6,
      fn: { service: [5] } }),
    c8({ service: 'Mobile-satellite', bandsGHz: [[39.5, 40.5]], bandsText: '39.5-40.5',
      terrestrialServices: 'Fixed, mobile', method: '§ 1.4.6', modulation: 'N',
      E: { A: null, N: 35 }, Pt: { A: null, N: -10 }, Gx: 45, B: 1e6 }),
    c8({ service: 'Broadcasting-satellite, fixed-satellite', bandsGHz: [[40.5, 42.5]], bandsText: '40.5-42.5',
      terrestrialServices: 'Broadcasting, fixed', method: '§ 1.4.5, § 2.1', modulation: '–',
      E: { A: null, N: 44 }, Pt: { A: null, N: -1 }, Gx: 45, B: 1e6 }),
    c8({ service: 'Mobile-satellite', bandsGHz: [[43.5, 47.0]], bandsText: '43.5-47.0',
      terrestrialServices: 'Mobile', method: '§ 1.4.6', modulation: 'N',
      E: { A: null, N: 40 }, Pt: { A: null, N: -7 }, Gx: 47 }),
    c8({ service: 'Radionavigation-satellite', bandsGHz: [[43.5, 47.0]], bandsText: '43.5-47.0',
      terrestrialServices: 'Mobile', method: '–',
      E: { A: null, N: 40 }, Pt: { A: null, N: -7 }, Gx: 47 })
  ])
});

// ---------------------------------------------------------------------------
// 表 9a（Rev.WRC-19），AP7-84 / 脚注 AP7-85（PDF p.264–265）—— 双向频段发射地球站；GHz
// ---------------------------------------------------------------------------
const TABLE_9A = Object.freeze({
  id: '9a', revision: 'Rev.WRC-19', page: 'AP7-84', pdfPage: 264, kind: 'bidirectional',
  title: 'Parameters required for the determination of coordination distance for a transmitting earth station in bands shared bidirectionally with receiving earth stations',
  fields: FIELDS_9,
  footnotes: Object.freeze({
    1: 'A: analogue modulation; N: digital modulation.',
    2: 'On-axis gain of the receive earth station antenna.',
    3: 'Feeder links of non-geostationary-satellite systems in the mobile-satellite service.',
    4: 'Horizon antenna gain for the receive earth station (refer to § 3 of the main body of this Appendix and to § 3 of this Annex).',
    5: 'Minimum elevation angle of operation in degrees (non-geostationary or geostationary).',
    6: 'Orbit of the space service in which the receiving earth station operates (non-geostationary or geostationary).',
    7: 'The thermal noise temperature of the receiving system at the terminal of the receiving antenna (under clear-sky conditions). Refer to § 2.1 of this Annex for missing values.',
    8: 'Horizon antenna gain is calculated using the procedure of Annex 5. Where no value of Gm is specified, a value of 42 dBi is to be used.',
    9: 'Non-geostationary horizon antenna gain, Ge = Gmin + 20 dB (see § 2.2), with Gmin = 10 – 10 log (D/λ), D/λ = 13 (refer to Annex 3 for definition of symbols).'
  }),
  rowFootnotes: Object.freeze({ modulation: [1], Gm: [2], Gr: [4], epsMinDeg: [5], orbit: [6], Te: [7] }),
  columns: Object.freeze([
    c9({ service: 'Mobile-satellite', bandsGHz: [[0.272, 0.273]], bandsText: '0.272-0.273', rxService: 'Space operation',
      orbit: 'non-GSO', modulation: 'N', p0: 1.0, n: 1, p: 1.0, NL: 0, Ms: 1, W: 0, Gm: 20, Gr: 19, epsMinDeg: 10, Te: 500,
      B: 1e3, Pr: -177 }),
    c9({ service: 'Earth exploration-satellite, meteorological-satellite', bandsGHz: [[0.401, 0.402]], bandsText: '0.401-0.402',
      rxService: 'Space operation', orbit: 'non-GSO', modulation: 'N', p0: 0.1, n: 2, p: 0.05, NL: 0, Ms: 1, W: 0,
      Gm: 20, Gr: 19, epsMinDeg: 10, Te: 500, B: 1, Pr: -208 }),
    c9({ service: 'Mobile-satellite', bandsGHz: [[1.670, 1.675]], bandsText: '1.670-1.675', rxService: 'Meteorological-satellite',
      orbit: 'non-GSO', modulation: 'N', p0: 0.006, n: 3, p: 0.002, NL: 0, Ms: 2.8, W: 0, Gm: 30, Gr: 19, epsMinDeg: 5,
      Te: 370, B: 1e6, Pr: -145, fn: { Gr: [9] } }),
    c9({ service: 'Mobile-satellite', bandsGHz: [[1.670, 1.675]], bandsText: '1.670-1.675', rxService: 'Meteorological-satellite',
      orbit: 'GSO', modulation: 'N', p0: 0.011, n: 2, p: 0.0055, NL: 0, Ms: 0.9, W: 0, Gm: 45, grMethod: 'annex5',
      epsMinDeg: 3, Te: 118, B: 4e3, Pr: -178, fn: { Gr: [8] } }),
    c9({ service: 'Fixed-satellite, mobile-satellite', bandsGHz: [[2.655, 2.690]], bandsText: '2.655-2.690',
      rxService: 'Fixed-satellite, broadcasting-satellite', Ms: 2, epsMinDeg: 3, Te: 75,
      note: '原表除 Ms、εmin、Te 外为空' }),
    c9({ service: 'Aeronautical mobile-satellite (R) service', bandsGHz: [[5.030, 5.091]], bandsText: '5.030-5.091',
      rxService: 'Aeronautical mobile-satellite (R) service', orbit: 'non-GSO', Gm: 45, grMethod: 'annex5',
      epsMinDeg: 10, Te: 340, B: 37.5e3, Pr: -163.5, fn: { Gr: [8] },
      note: 'Gr 格为脚注 8（附件 5），原表对 non-GSO 列亦如此标注' }),
    c9({ service: 'Aeronautical mobile-satellite (R) service', bandsGHz: [[5.030, 5.091]], bandsText: '5.030-5.091',
      rxService: 'Aeronautical mobile-satellite (R) service', orbit: 'GSO', Gm: 45, grMethod: 'annex5',
      epsMinDeg: 10, Te: 340, B: 37.5e3, Pr: -163.5, fn: { Gr: [8] } }),
    c9({ service: 'Fixed-satellite', bandsGHz: [[5.150, 5.216]], bandsText: '5.150-5.216', rxService: 'Fixed-satellite',
      orbit: 'non-GSO', Ms: 2, Gm: 48.5, Gr: 10, epsMinDeg: 3, Te: 75, fn: { service: [3] } }),
    c9({ service: 'Fixed-satellite', bandsGHz: [[5.150, 5.216]], bandsText: '5.150-5.216',
      rxService: 'Radiodetermination-satellite', Ms: 2, epsMinDeg: 3, Te: 75, fn: { service: [3] } }),
    c9({ service: 'Fixed-satellite', bandsGHz: [[6.700, 7.075]], bandsText: '6.700-7.075', rxService: 'Fixed-satellite',
      orbit: 'non-GSO', modulation: 'N', p0: 0.005, n: 3, p: 0.0017, NL: 1, Ms: 2, W: 0, Gm: 50.7, Gr: 10, epsMinDeg: 3,
      Te: 75, B: 1e6, Pr: -151 }),
    c9({ service: 'Fixed-satellite, meteorological-satellite', bandsGHz: [[8.025, 8.400]], bandsText: '8.025-8.400',
      rxService: 'Earth exploration-satellite', orbit: 'non-GSO', modulation: 'N', p0: 0.011, n: 2, p: 0.0055, NL: 0,
      Ms: 4.7, W: 0, Gr: 10, epsMinDeg: 5, B: 1e6, Pr: -142 }),
    c9({ service: 'Fixed-satellite', bandsGHz: [[8.025, 8.400]], bandsText: '8.025-8.400', rxService: 'Earth exploration-satellite',
      orbit: 'GSO', modulation: 'N', p0: 0.083, n: 2, p: 0.0415, NL: 1, Ms: 2, W: 0, grMethod: 'annex5', epsMinDeg: 3,
      B: 1e6, Pr: -154, fn: { Gr: [8] }, note: 'Gr 格「8」排成正文字号，按脚注 8 解读；Gm 缺值按脚注 8 取 42 dBi' })
  ])
});

// ---------------------------------------------------------------------------
// 表 9b（Rev.WRC-19），AP7-86 / 脚注 AP7-87（PDF p.266–267）—— 双向频段发射地球站；GHz
// ---------------------------------------------------------------------------
const TABLE_9B = Object.freeze({
  id: '9b', revision: 'Rev.WRC-19', page: 'AP7-86', pdfPage: 266, kind: 'bidirectional',
  title: 'Parameters required for the determination of coordination distance for a transmitting earth station in bands shared bidirectionally with receiving earth stations',
  fields: FIELDS_9,
  footnotes: Object.freeze({
    1: 'A: analogue modulation; N: digital modulation.',
    2: 'On-axis gain of the receive earth station antenna.',
    3: 'Feeder links of non-geostationary-satellite systems in the mobile-satellite service.',
    4: 'Geostationary-satellite systems.',
    5: 'Horizon antenna gain for the receive earth station (refer to § 3 of the main body of the Appendix and to § 3 of this Annex).',
    6: 'Minimum elevation angle of operation in degrees (non-GSO or GSO).',
    7: 'Orbit of the space service in which the receiving earth station operates (GSO or non-GSO).',
    8: 'The thermal noise temperature of the receiving system at the terminal of the receiving antenna (under clear-sky conditions). Refer to § 2.1 of this Annex for missing values.',
    9: 'Horizon antenna gain is calculated using the procedure of Annex 5. Where no value of Gm is specified, a value of 42 dBi is to be used.',
    10: 'Horizon antenna gain is calculated using the procedure of Annex 5, except that the following antenna pattern may be used in place of that given in § 3 of Annex 3: G = 32 − 25 log φ for 1° ≤ φ < 48°; and G = −10 for 48° ≤ φ < 180°.',
    11: 'Non-geostationary horizon antenna gain. Ge = Gmax (see § 2.2) with the antenna pattern modelled by the equation G = 36 − 25 log (φ).',
    12: 'Non-geostationary horizon antenna gain. Ge = Gmax (see § 2.2) with the antenna pattern modelled by the equation G = 32 − 25 log (φ).'
  }),
  rowFootnotes: Object.freeze({ modulation: [1], Gm: [2], Gr: [5], epsMinDeg: [6], orbit: [7], Te: [8] }),
  columns: Object.freeze([
    c9({ service: 'Fixed-satellite', bandsGHz: [[10.7, 11.7]], bandsText: '10.7-11.7', rxService: 'Fixed-satellite',
      orbit: 'GSO', modulation: 'A', p0: 0.03, n: 2, p: 0.015, NL: 1, Ms: 7, W: 4, grMethod: 'annex5', epsMinDeg: 5,
      Te: 150, B: 1e6, Pr: -144, fn: { Gr: [9] }, note: 'Gr 格「9」为脚注号（附件 5），Gm 缺值按脚注 9 取 42 dBi' }),
    c9({ service: 'Fixed-satellite', bandsGHz: [[10.7, 11.7]], bandsText: '10.7-11.7', rxService: 'Fixed-satellite',
      orbit: 'GSO', modulation: 'N', p0: 0.003, n: 2, p: 0.0015, NL: 1, Ms: 4, W: 0, grMethod: 'annex5', epsMinDeg: 5,
      Te: 150, B: 1e6, Pr: -144, fn: { Gr: [9] } }),
    c9({ service: 'Fixed-satellite', bandsGHz: [[10.7, 11.7]], bandsText: '10.7-11.7', rxService: 'Fixed-satellite',
      orbit: 'non-GSO', modulation: 'N', p0: 0.003, n: 2, p: 0.0015, NL: 1, Ms: 4, W: 0, Gm: 51.9, Gr: 10, epsMinDeg: 6,
      Te: 150, B: 1e6, Pr: -144 }),
    c9({ service: 'Fixed-satellite', bandsGHz: [[12.5, 12.75]], bandsText: '12.5-12.75', rxService: 'Fixed-satellite',
      orbit: 'GSO', modulation: 'A', p0: 0.03, n: 2, p: 0.015, NL: 1, Ms: 7, W: 4, grMethod: 'annex5', epsMinDeg: 5,
      Te: 150, B: 1e6, Pr: -144, fn: { Gr: [9] } }),
    c9({ service: 'Fixed-satellite', bandsGHz: [[12.5, 12.75]], bandsText: '12.5-12.75', rxService: 'Fixed-satellite',
      orbit: 'GSO', modulation: 'N', p0: 0.003, n: 2, p: 0.0015, NL: 1, Ms: 4, W: 0, grMethod: 'annex5', epsMinDeg: 5,
      Te: 150, B: 1e6, Pr: -144, fn: { Gr: [9] } }),
    c9({ service: 'Fixed-satellite', bandsGHz: [[12.5, 12.75]], bandsText: '12.5-12.75', rxService: 'Fixed-satellite',
      orbit: 'non-GSO', p0: 0.003, n: 2, p: 0.0015, NL: 1, Ms: 4, W: 0, Gm: 31.2, Gr: 11, epsMinDeg: 10,
      Te: 150, B: 1e6, Pr: -144, fn: { Gr: [11] } }),
    c9({ service: 'Fixed-satellite', bandsGHz: [[17.3, 17.8]], bandsText: '17.3-17.8', rxService: 'Broadcasting-satellite',
      note: '原表全空' }),
    c9({ service: 'Fixed-satellite', bandsGHz: [[17.7, 18.4]], bandsText: '17.7-18.4',
      rxService: 'Fixed-satellite, meteorological-satellite', orbit: 'GSO', modulation: 'N', p0: 0.003, n: 2, p: 0.0015,
      NL: 1, Ms: 6, W: 0, Gm: 58.6, grMethod: 'annex5', epsMinDeg: 5, Te: 300, B: 1e6, Pr: -138, fn: { Gr: [9] } }),
    c9({ service: 'Fixed-satellite', bandsGHz: [[19.3, 19.6]], bandsText: '19.3-19.6', rxService: 'Fixed-satellite',
      orbit: 'non-GSO', modulation: 'N', p0: 0.01, n: 1, p: 0.01, NL: 0, Ms: 5, W: 0, Gm: 53.2, Gr: 10, epsMinDeg: 5,
      Te: 300, B: 1e6, Pr: -141, fn: { service: [3], rxService: [3] } }),
    c9({ service: 'Fixed-satellite', bandsGHz: [[19.3, 19.6]], bandsText: '19.3-19.6', rxService: 'Fixed-satellite',
      orbit: 'GSO', p0: 0.003, n: 2, p: 0.0015, NL: 1, Ms: 6, W: 0, Gm: 49.5, grMethod: 'annex5-alt', epsMinDeg: 10,
      Te: 300, fn: { service: [3], rxService: [4], Gr: [10] }, note: 'Gr 格「10」为脚注号（附件 5 + 32−25lgφ 方向图）' }),
    c9({ service: 'Earth exploration-satellite, space research', bandsGHz: [[40.0, 40.5]], bandsText: '40.0-40.5',
      rxService: 'Fixed-satellite, mobile-satellite', orbit: 'GSO', p0: 0.003, n: 2, p: 0.0015, NL: 1, Ms: 6, W: 0,
      Gm: 50.8, grMethod: 'annex5', epsMinDeg: 10, Te: 300, fn: { Gr: [9] } }),
    c9({ service: 'Earth exploration-satellite, space research', bandsGHz: [[40.0, 40.5]], bandsText: '40.0-40.5',
      rxService: 'Fixed-satellite, mobile-satellite', orbit: 'non-GSO', p0: 0.003, n: 2, p: 0.0015, NL: 1, Ms: 6, W: 0,
      Gm: 54.4, Gr: 7, epsMinDeg: 10, Te: 300, fn: { Gr: [12] } })
  ])
});

// ---------------------------------------------------------------------------
// 表 10（Rev.WRC-19），AP7-88 / 注 AP7-89（PDF p.268–269）—— 预定协调距离
// ---------------------------------------------------------------------------
const TABLE_10 = Object.freeze({
  id: '10', revision: 'Rev.WRC-19', page: 'AP7-88', pdfPage: 268,
  title: 'Predetermined coordination distances',
  fields: Object.freeze({
    earthStation: '地球站类型', terrestrialStation: '地面站类型',
    distanceKm: '协调距离（km，同等权利划分业务间）；null 时见 note'
  }),
  notes: Object.freeze({
    1: 'The coordination distance, d (km), for fixed earth stations in the meteorological-satellite service vis-à-vis stations in the meteorological aids service assumes a radiosonde altitude of 20 km and is determined as a function of the physical horizon elevation angle εh (degrees) for each azimuth: d = 100 for εh ≥ 11°; d = 582 (√(1 + (0.254 εh)²) − 0.254 εh) for 0° < εh < 11°; d = 582 for εh ≤ 0°. (WRC-2000)',
    2: 'For the coordination distance in the frequency band 5 091-5 150 MHz vis-à-vis stations in the aeronautical radionavigation service, see No. 5.444A. (WRC-15)'
  }),
  rows: Object.freeze([
    { earthStation: 'Ground-based in the bands below 1 GHz to which No. 9.11A applies. Ground-based mobile in the bands within the range 1-3 GHz to which No. 9.11A applies',
      terrestrialStation: 'Mobile (aircraft)', distanceKm: 500 },
    { earthStation: 'Aircraft (all bands)', terrestrialStation: 'Ground-based', distanceKm: 500 },
    { earthStation: 'Aircraft (all bands)', terrestrialStation: 'Mobile (aircraft)', distanceKm: 1000 },
    { earthStation: 'Ground-based in the bands: 400.15-401 MHz, 1 668.4-1 675 MHz',
      terrestrialStation: 'Station in the meteorological aids service (radiosonde)', distanceKm: 580 },
    { earthStation: 'Aircraft in the bands: 400.15-401 MHz, 1 668.4-1 675 MHz',
      terrestrialStation: 'Station in the meteorological aids service (radiosonde)', distanceKm: 1080 },
    { earthStation: 'Ground-based in the radiodetermination-satellite service (RDSS) in the bands: 1 610-1 626.5 MHz, 2 483.5-2 500 MHz, 2 500-2 516.5 MHz',
      terrestrialStation: 'Ground-based', distanceKm: 100 },
    { earthStation: 'Airborne earth station in the radiodetermination-satellite service (RDSS) in the bands: 1 610-1 626.5 MHz, 2 483.5-2 500 MHz, 2 500-2 516.5 MHz',
      terrestrialStation: 'Ground-based', distanceKm: 400 },
    { earthStation: 'Receiving earth stations in the meteorological-satellite service',
      terrestrialStation: 'Station in the meteorological aids service', distanceKm: null,
      note: 'Visibility distance as a function of the earth station horizon elevation angle for a radiosonde at an altitude of 20 km above mean sea level, assuming 4/3 Earth radius (see Note 1)', noteRef: 1 },
    { earthStation: 'Non-GSO MSS feeder-link earth stations (all bands)', terrestrialStation: 'Mobile (aircraft)', distanceKm: 500 },
    { earthStation: 'Non-GSO MSS feeder-link earth stations in the band 5 091-5 150 MHz',
      terrestrialStation: 'Station in the aeronautical radionavigation service', distanceKm: null, note: 'Note 2', noteRef: 2 },
    { earthStation: 'Receiving earth stations in the space research service in the band: 2 200-2 290 MHz',
      terrestrialStation: 'Mobile (aircraft)', distanceKm: 880 },
    { earthStation: 'Ground-based in the bands in which the frequency sharing situation is not covered in the rows above',
      terrestrialStation: 'Mobile (aircraft)', distanceKm: 500 }
  ].map(Object.freeze))
});

const TABLE_7 = Object.freeze({ a: TABLE_7A, b: TABLE_7B, c: TABLE_7C });
const TABLE_8 = Object.freeze({ a: TABLE_8A, b: TABLE_8B, c: TABLE_8C, d: TABLE_8D });
const TABLE_9 = Object.freeze({ a: TABLE_9A, b: TABLE_9B });
const PARAMETER_TABLES = Object.freeze([TABLE_7A, TABLE_7B, TABLE_7C, TABLE_8A, TABLE_8B, TABLE_8C, TABLE_8D, TABLE_9A, TABLE_9B]);

/**
 * 按频率（及可选的表号 / 业务 / 调制）检索表 7–9 的列。
 * @param {object} q { fGHz, table?: '7'|'8'|'9'|'7b'…, kind?: 'tx'|'rx'|'bidirectional', modulation?, service?(子串，忽略大小写) }
 * @returns {Array<{table:string, index:number, column:object}>} 频段含 fGHz（闭区间）的列，原表顺序
 */
function findColumns(q) {
  const o = q || {};
  const f = Number(o.fGHz);
  const out = [];
  for (const t of PARAMETER_TABLES) {
    if (o.table && !(t.id === String(o.table) || t.id.charAt(0) === String(o.table))) continue;
    if (o.kind && t.kind !== o.kind) continue;
    t.columns.forEach((c, i) => {
      if (Number.isFinite(f) && !c.bandsGHz.some(b => f >= b[0] && f <= b[1])) return;
      if (o.modulation && c.modulation !== o.modulation) return;
      if (o.service && !String(c.service || '').toLowerCase().includes(String(o.service).toLowerCase())) return;
      out.push({ table: t.id, index: i, column: c });
    });
  }
  return out;
}

module.exports = {
  TABLE_3, TABLE_4, TABLE_5, TABLE_6,
  TABLE_7, TABLE_7A, TABLE_7B, TABLE_7C,
  TABLE_8, TABLE_8A, TABLE_8B, TABLE_8C, TABLE_8D,
  TABLE_9, TABLE_9A, TABLE_9B,
  TABLE_10, PARAMETER_TABLES, findColumns
};
