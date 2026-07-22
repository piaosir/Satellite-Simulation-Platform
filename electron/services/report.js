// 报告生成服务（主进程，Node）。从链路结果生成 Word / Excel；返回 Buffer 由调用方写盘。
// 移植自小程序云函数（docx / exceljs）。PDF 因需内嵌中文字体，后续单独处理。
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, WidthType, AlignmentType, BorderStyle
} = require('docx')
const ExcelJS = require('exceljs')

// 报告字段表：标签 / 结果键 / 单位
const ROWS = [
  ['—— 几何', null, ''],
  ['仰角', 'elevationResult', '°'],
  ['方位角', 'azimuthResult', '°'],
  ['斜距', 'slantRangeResult', 'km'],
  ['单向时延', 'linkDelayResult', 'ms'],
  ['—— 上行链路', null, ''],
  ['上行站 EIRP', 'stationEIRPResult', 'dBW'],
  ['上行自由空间损耗', 'uplinkFSLResult', 'dB'],
  ['上行雨衰 (P.618)', 'uplinkRainAttenuation', 'dB'],
  ['上行大气衰减 (P.676)', 'uplinkAtmosphericAttenuationResult', 'dB'],
  ['上行云衰 (P.840)', 'uplinkCloudAttenuation', 'dB'],
  ['上行 C/N', 'uplinkCN', 'dB'],
  ['—— 卫星', null, ''],
  ['卫星下行 EIRP', 'EIRPsResult', 'dBW'],
  ['卫星 G/T', 'satelliteGTResult', 'dB/K'],
  ['饱和通量密度 SFD', 'SFDsResult', 'dBW/m²'],
  ['转发器带宽', 'transponderBandwidthResult', 'MHz'],
  ['—— 下行链路', null, ''],
  ['下行自由空间损耗', 'downlinkFSLResult', 'dB'],
  ['下行雨衰 (P.618)', 'downlinkRainAttenuationResult', 'dB'],
  ['下行大气衰减 (P.676)', 'downlinkAtmosphericAttenuationResult', 'dB'],
  ['下行云衰 (P.840)', 'downlinkCloudAttenuation', 'dB'],
  ['接收 G/Te', 'gOverTeResult', 'dB/K'],
  ['下行 C/N', 'downlinkCN', 'dB'],
  ['—— 合成与余量', null, ''],
  ['合成 C/N', 'carrierTotalCN', 'dB'],
  ['门限 C/N', 'thresholdCN', 'dB'],
  ['链路余量', 'linkmargin', 'dB'],
  ['系统可用度', 'systemAvailabilityResult', '%'],
  ['—— 通信参数', null, ''],
  ['信息速率', 'infoRateResult', 'kbps'],
  ['调制方式', 'modulationResult', ''],
  ['FEC 码率', 'fecResult', ''],
  ['符号率', 'symbolRateResult', 'kbaud'],
  ['频谱效率', 'spectralEfficiencyResult', 'bps/Hz']
]

function val(results, key) {
  if (!key) return ''
  const v = results && results[key]
  return v === undefined || v === null || v === '-' ? '—' : String(v)
}

function cell(text, align, bold) {
  return new TableCell({
    width: { size: 33, type: WidthType.PERCENTAGE },
    children: [new Paragraph({
      alignment: align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text: String(text), bold: !!bold, size: 20 })]
    })]
  })
}

async function buildWord(payload) {
  const { results = {}, params = {}, meta = {} } = payload
  const header = new TableRow({ children: [cell('环节', 'left', true), cell('数值', 'right', true), cell('单位', 'left', true)] })
  const body = ROWS.map(([label, key, unit]) => {
    const isSection = key === null
    return new TableRow({ children: [cell(label, 'left', isSection), cell(val(results, key), 'right'), cell(unit)] })
  })
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: meta.title || '卫星链路预算报告', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun({
          text: `卫星：${params.satelliteName || '—'}    频段：${params.frequencyBand || '—'}    生成时间：${new Date().toLocaleString()}`,
          size: 18, color: '666666'
        })] }),
        new Paragraph({ text: '' }),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...body] }),
        new Paragraph({ text: '' }),
        new Paragraph({ children: [new TextRun({ text: '模型：ITU-R P.618 / P.676 / P.837 / P.838 / P.840 / P.839', size: 16, color: '999999' })] })
      ]
    }]
  })
  return Packer.toBuffer(doc)
}

async function buildExcel(payload) {
  const { results = {}, params = {}, meta = {} } = payload
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('链路预算')
  ws.mergeCells('A1:C1')
  ws.getCell('A1').value = meta.title || '卫星链路预算报告'
  ws.getCell('A1').font = { size: 14, bold: true }
  ws.getCell('A2').value = `卫星 ${params.satelliteName || '—'} · 频段 ${params.frequencyBand || '—'} · ${new Date().toLocaleString()}`
  ws.addRow([])
  const head = ws.addRow(['环节', '数值', '单位'])
  head.font = { bold: true }
  ROWS.forEach(([label, key, unit]) => {
    const row = ws.addRow([label, val(results, key), unit])
    if (key === null) row.font = { bold: true }
  })
  ws.columns = [{ width: 30 }, { width: 16 }, { width: 12 }]
  return wb.xlsx.writeBuffer()
}

// ===== 工作台链路结果导出（Phase 5/6）=====
// payload: { links:[{ti,ri,txName,rxName,ok,error,metric,data,segments}], pairMode, lang, params, meta }
// 两类表：① 链路汇总（每条一行，纵向列表——常规计算/矩阵计算共用同一种纵向布局，仅首列「序号」/「坐标」不同；
//           三线表/Times New Roman/舒朗行距）
//        ② 详细计算结果：每条链路一个 sheet（七段瀑布，仿小程序专业版，与 UI 瀑布同源），表名=坐标+发信站-收信站。
// 不再生成"结果矩阵"宽表——多数使用者按行纵向阅读表格，矩阵计算的 m×n 组合已在①里逐行列全，常规计算的
// 1↔1 配对用宽矩阵展示反而大半是空格；纵向列表对两种配对方式都更直观，也更方便排序/筛选。
// 标签中英文由 lang('zh'|'en') 控制；详细计算结果表的标签翻译表统一在 packages/core 的 waterfallBuilder.js
// WF_DICT 维护（与结果区实时瀑布同源，避免两处译法不一致），此文件只维护链路汇总表自己的列头/标题译法。
const FNT = 'Times New Roman'       // 数字/拉丁；中文由 Excel 按字形自动回退
const CJK = '微软雅黑'               // 中文标签/标题
const MED = { style: 'medium', color: { argb: 'FF000000' } }
const THIN = { style: 'thin', color: { argb: 'FF000000' } }
const HAIR = { style: 'hair', color: { argb: 'FF999999' } }

// 中英文字符串表（链路汇总表头/标题等）。英文措辞对齐卫星通信工程报告的学术/行业惯用语，并与
// WF_DICT（瀑布详情表）的译法保持一致（如 Allocated Bandwidth / Link Margin / System Availability 等），
// 避免同一份工作簿里术语不统一。
const STR = {
  zh: {
    reportTitle: 'GEO 链路预算结果', sheetSummary: '链路汇总',
    paRecW: '功放建议 (W)', paRecDbw: '功放建议 (dBW)', paActW: '功放实际输出 (W)',
    linkMargin: '链路余量 (dB)', allocBw: '载波带宽 (kHz)', powerBw: '功率带宽 (kHz)',
    bwUsage: '带宽占用 (%)', pwUsage: '功率占用 (%)',
    upCN: '上行 C/N (dB)', downCN: '下行 C/N (dB)', totalCN: '合计 C/N (dB)', thresholdCN: '门限 C/N (dB)',
    ebno: 'Eb/N₀ (dB)', esno: 'Es/N₀ (dB)', psd: '载波功率谱密度 (dBW/Hz)', avail: '系统可用度 (%)', availUp: '上行可用度 (%)',
    specEff: '频谱效率 (bps/Hz)', capacity: '容量 (Mbps)',
    status: '合格', statusOk: '是', statusBad: '否', statusErr: '错误',
    pairSeq: '常规计算（1↔1）', pairMatrix: '矩阵计算（m×n）',
    subtitle: (sat, band, mode, pair, date) => `卫星 ${sat} · 频段 ${band} · 计算方式 ${mode} · 配对方式 ${pair} · ${date}`,
    calcFailed: '计算失败：',
    capHeader: (n, failed) => `容量汇总（${n} 条链路${failed ? ` · ${failed} 条失败已排除` : ''}）`,
    totalCap: '总容量', totalBw: '总带宽', avgEff: '平均频谱效率',
    param: '参数', uplink: '上行', downlink: '下行', total: '合计', value: '数值', unit: '单位',
    // 再生式各体制汇总表专属列头（上行/下行/星间微波/星间激光按信号流向裁剪，避免整列空白）
    satGtDn: '收信站 G/T (dB/K)', satEirpDn: '卫星下行 EIRP (dBW)', availDown: '下行可用度 (%)',
    islFreq: '星间频率 (GHz)', islDist: '星间距离 (km)', islTxEirp: '发射卫星 EIRP (dBW)',
    islRxGt: '接收卫星 G/T (dB/K)', islCN: '星间 C/N (dB)', islVis: '互视可见度 (%)', availSys: '系统可用度 (%)',
    laserDist: '星间距离 (km)', laserTxPower: '发射光功率 (dBm)', laserPrx: '接收光功率 (dBm)',
    laserPreq: '所需接收功率 (dBm)', laserDoppler: '相干多普勒 (GHz)', dataRate: '信息速率 (kbps)',
    geo: {
      sheetName: '几何关系',
      title: 'NGSO 卫星—地球站几何关系报告',
      subtitle: (sat, band, prop, date) => `卫星 ${sat} · 频段 ${band} · 传播器 ${prop} · ${date}`,
      attrHead: '场景与轨道属性',
      kSat: '卫星', kProp: '传播器', kFrame: '坐标系', kEpoch: '场景历元 t0', kHorizon: '搜索时窗', kTimeSys: '时标',
      frameVal: 'TEME（轨道传播）· WGS84 椭球（站址）', timeSysVal: 'UTCG（协调世界时·格里高利）',
      elemHead: '轨道根数', elemStatic: '历元静态', elemVirtual: '虚拟圆轨道',
      a: '半长轴 a', e: '偏心率 e', i: '倾角 i', raan: '升交点赤经 Ω', argp: '近地点幅角 ω', ma: '平近点角 M',
      mm: '平均运动 n', period: '轨道周期 T', peri: '近地点高度', apo: '远地点高度', norad: '卫星编号 (NORAD)',
      accHead: '互视访问窗口（两站同刻可见）',
      accNo: '#', accLink: '链路', accPair: '发信站 → 收信站',
      accStart: '起始 (UTCG)', accStop: '结束 (UTCG)', accDur: '持续 (min)', accTypical: '典型时刻 t* (UTCG)',
      accClip: ' (clipped)',
      accNA: '手动 / 静态轨道：几何为历元无关的最差工况或星下点静态几何，无时间访问窗口。',
      aerHead: '站星几何（斜距 / 仰角 / 覆盖）',
      aerLink: '链路', aerDir: '方向', aerStn: '地球站', aerLat: '纬度 (°)', aerLon: '经度 (°)', aerMinEl: '最低仰角 (°)',
      aerEl: '仰角 (°)', aerRange: '斜距 (km)', aerSatAlt: '卫星高度 (km)', aerHalf: '覆盖半角 (°)', aerCovR: '覆盖半径 (km)', aerPass: '过境时长 (min)',
      dirUp: '↑ 上行', dirDn: '↓ 下行', resident: '∞',
      dynHead: '卫星运动与多普勒',
      dynLink: '链路', dynVi: '轨道速度·惯性 (km/s)', dynVg: '相对地面速度 (km/s)',
      dynDu: '上行多普勒 (kHz)', dynDd: '下行多普勒 (kHz)', dynDelay: '单程时延 (ms)', dynEst: ' ·估算',
      infeasHead: '不可行链路', infeasReason: '原因',
      foot: '几何口径：选星取单一典型时刻 t*（SGP4/SDP4 同一物理瞬间，两站同刻可见、仰角尽量贴近各自最低）；手动圆轨道取每站「≥ 自身最低仰角」处的最大斜距（闭式球面）。覆盖半角 λ = arccos((Re/r)·cosε) − ε，覆盖半径 = Re·λ，过境时长 = 2λ/|ω_s − ω_E·cos i|。Re = 6378.137 km，μ = 398600.4418 km³/s²。'
    }
  },
  en: {
    reportTitle: 'GEO Link Budget Results', sheetSummary: 'Link Summary',
    paRecW: 'Recommended PA Power (W)', paRecDbw: 'Recommended PA Power (dBW)', paActW: 'Actual PA Output (W)',
    linkMargin: 'Link Margin (dB)', allocBw: 'Allocated Bandwidth (kHz)', powerBw: 'Power Bandwidth (kHz)',
    bwUsage: 'Bandwidth Usage Ratio (%)', pwUsage: 'Power Usage Ratio (%)',
    upCN: 'Uplink C/N (dB)', downCN: 'Downlink C/N (dB)', totalCN: 'Combined C/N (dB)', thresholdCN: 'Threshold C/N (dB)',
    ebno: 'Eb/N₀ (dB)', esno: 'Es/N₀ (dB)', psd: 'Satellite PSD (dBW/Hz)', avail: 'System Availability (%)', availUp: 'Uplink Availability (%)',
    specEff: 'Spectral Efficiency (bps/Hz)', capacity: 'Capacity (Mbps)',
    status: 'Status', statusOk: 'Pass', statusBad: 'Fail', statusErr: 'Error',
    pairSeq: 'Sequential (1:1)', pairMatrix: 'Full Matrix (m×n)',
    subtitle: (sat, band, mode, pair, date) => `Satellite ${sat} · Band ${band} · Calculation Mode: ${mode} · Pairing: ${pair} · ${date}`,
    calcFailed: 'Calculation Failed: ',
    capHeader: (n, failed) => `Capacity Summary (${n} link${n > 1 ? 's' : ''}${failed ? `, ${failed} failed excluded` : ''})`,
    totalCap: 'Total Capacity', totalBw: 'Total Bandwidth', avgEff: 'Average Spectral Efficiency',
    param: 'Parameter', uplink: 'Uplink', downlink: 'Downlink', total: 'Total', value: 'Value', unit: 'Unit',
    // Per-scheme regenerative summary column heads (trimmed by signal flow to avoid all-blank columns)
    satGtDn: 'Rx Station G/T (dB/K)', satEirpDn: 'Sat Downlink EIRP (dBW)', availDown: 'Downlink Availability (%)',
    islFreq: 'ISL Frequency (GHz)', islDist: 'Inter-Sat Range (km)', islTxEirp: 'Tx Sat EIRP (dBW)',
    islRxGt: 'Rx Sat G/T (dB/K)', islCN: 'ISL C/N (dB)', islVis: 'Mutual Visibility (%)', availSys: 'System Availability (%)',
    laserDist: 'Inter-Sat Range (km)', laserTxPower: 'Tx Optical Power (dBm)', laserPrx: 'Rx Optical Power (dBm)',
    laserPreq: 'Required Rx Power (dBm)', laserDoppler: 'Coherent Doppler (GHz)', dataRate: 'Information Rate (kbps)',
    geo: {
      sheetName: 'Geometry',
      title: 'NGSO Satellite–Facility Geometry Report',
      subtitle: (sat, band, prop, date) => `Satellite ${sat} · Band ${band} · Propagator ${prop} · ${date}`,
      attrHead: 'Scenario & Orbit Attributes',
      kSat: 'Satellite', kProp: 'Propagator', kFrame: 'Coordinate Frame', kEpoch: 'Scenario Epoch t0', kHorizon: 'Search Horizon', kTimeSys: 'Time System',
      frameVal: 'TEME (orbit) · WGS84 ellipsoid (facility)', timeSysVal: 'UTCG (UTC · Gregorian)',
      elemHead: 'Orbital Elements', elemStatic: 'Epoch', elemVirtual: 'Virtual Circular',
      a: 'Semi-major Axis a', e: 'Eccentricity e', i: 'Inclination i', raan: 'RAAN Ω', argp: 'Arg. of Perigee ω', ma: 'Mean Anomaly M',
      mm: 'Mean Motion n', period: 'Orbital Period T', peri: 'Perigee Altitude', apo: 'Apogee Altitude', norad: 'Satellite (NORAD)',
      accHead: 'Mutual-Visibility Access (Both Stations Simultaneously Visible)',
      accNo: '#', accLink: 'Link', accPair: 'Tx → Rx',
      accStart: 'Start (UTCG)', accStop: 'Stop (UTCG)', accDur: 'Duration (min)', accTypical: 'Typical Instant t* (UTCG)',
      accClip: ' (clipped)',
      accNA: 'Manual / static orbit: epoch-independent worst-case or sub-satellite static geometry — no time-domain access window.',
      aerHead: 'Satellite Geometry (Range / Elevation / Coverage)',
      aerLink: 'Link', aerDir: 'Dir', aerStn: 'Facility', aerLat: 'Lat (°)', aerLon: 'Lon (°)', aerMinEl: 'Min El (°)',
      aerEl: 'Elevation (°)', aerRange: 'Range (km)', aerSatAlt: 'Sat Alt (km)', aerHalf: 'Cov. Half-Angle (°)', aerCovR: 'Cov. Radius (km)', aerPass: 'Max Pass (min)',
      dirUp: '↑ Up', dirDn: '↓ Dn', resident: '∞',
      dynHead: 'Satellite Dynamics & Doppler',
      dynLink: 'Link', dynVi: 'Orbital Vel · Inertial (km/s)', dynVg: 'Ground-Relative Vel (km/s)',
      dynDu: 'Uplink Doppler (kHz)', dynDd: 'Downlink Doppler (kHz)', dynDelay: 'One-Way Delay (ms)', dynEst: ' · est.',
      infeasHead: 'Infeasible Links', infeasReason: 'Reason',
      foot: "Geometry basis: selected satellites use a single typical instant t* (same physical SGP4/SDP4 moment, both stations visible with elevations near their minimums); manual circular orbits use each station's max slant range at its own min elevation (closed-form spherical). Coverage half-angle λ = arccos((Re/r)·cosε) − ε, coverage radius = Re·λ, max pass = 2λ/|ω_s − ω_E·cos i|. Re = 6378.137 km, μ = 398600.4418 km³/s²."
    }
  }
}
const strFor = (lang) => (lang === 'en' ? STR.en : STR.zh)

// 再生式「几何关系」sheet 专属文案（复用 STR.geo 的属性/根数/AER/多普勒列头，仅补再生式特有措辞）：
// 地面—空间（上行/下行）与 空间—空间（星间微波/激光）两套版式各取所需。
const RGEO = {
  zh: {
    groundTitle: (isUp) => `再生式${isUp ? '上行' : '下行'} 卫星—地球站 几何关系报告`,
    spaceTitle: (isLaser) => `再生式星间链路（${isLaser ? '激光' : '微波'}） 两星几何关系报告`,
    subGround: (sat, band, prop, date) => `卫星 ${sat} · 频段 ${band} · 传播器 ${prop} · ${date}`,
    subSpace: (grp, extra, prop, date) => `卫星群 ${grp} · ${extra} · 传播器 ${prop} · ${date}`,
    staUp: '发信站', staDn: '收信站', station: '地球站',
    frameGround: 'TEME（轨道传播）· WGS84 椭球（站址）', frameSpace: 'TEME（轨道传播）· ECEF 地心（星间几何）',
    // 地面—空间：访问窗口 / AER / 多普勒
    accHead: '访问窗口（满足最低仰角的全部过境）',
    accNo: '#', accLink: '链路', accStart: '起始 (UTCG)', accStop: '结束 (UTCG)', accDur: '持续 (min)',
    accPeakEl: '峰值仰角 (°)', accPeakRange: '峰值斜距 (km)', accPeak: '峰值时刻 (UTCG)',
    accNAg: '手动圆轨道 / 静态星：几何为历元无关最差工况或星下点静态几何，无时间访问窗口。',
    aerHead: '站星几何（最差工况：斜距 / 仰角 / 覆盖）',
    dynHead: '卫星运动与多普勒', dynSat: '卫星', dynDop: '最大多普勒 (kHz)', dynDelay: '单程时延 (ms)',
    // 空间—空间：属性 / 两星根数 / 互视窗 / 最差几何 / 两星运动
    kAtm: '大气余量', kBlock: 'LOS 遮挡半径 R_block', kIslFreq: '星间频率', kLambda: '波长 λ',
    elem2Head: '两星轨道根数', endTx: '发射星', endRx: '接收星', end: '端', sat: '卫星',
    pairArrow: (a, b) => `${a} → ${b}`,
    mAccHead: '互视访问窗口（两星同刻互视）', mAccPair: '发射星 → 接收星', mAccMaxR: '窗口最大距离 (km)',
    mAccNA: '手动圆轨道 / 快照星：几何为历元无关最差工况，无时间访问窗口。',
    worstHead: '星间几何（最差工况）', wPair: '发射星 → 接收星', wRange: '星间距离 (km)',
    wTxAlt: '发射星高度 (km)', wRxAlt: '接收星高度 (km)', wCentral: '地心夹角 (°)', wGraz: 'LOS 掠地高度 (km)',
    wDelay: '单程时延 (ms)', wRR: '距离变化率 (km/s)', wDopRf: '最大多普勒 (kHz)', wDopOpt: '相干多普勒 Δf (GHz)', wVis: '互视可见度 (%)',
    dyn2Head: '两星运动（惯性系 / 相对地面速度）', dTxVi: '发射星·惯性 (km/s)', dRxVi: '接收星·惯性 (km/s)',
    dTxVg: '发射星·对地 (km/s)', dRxVg: '接收星·对地 (km/s)', dRR: '距离变化率 (km/s)',
    a: '半长轴 a (km)', e: '偏心率 e', i: '倾角 i (°)', raan: 'Ω (°)', period: '周期 T (min)',
    peri: '近地点 (km)', apo: '远地点 (km)', norad: 'NORAD',
    footGround: '几何口径：选星取单一典型时刻 t*（SGP4/SDP4 同一物理瞬间，站星仰角贴近最低仰角）；手动圆轨道取「≥ 最低仰角」处的最大斜距（闭式球面）；静态星取星下点固定几何。覆盖半角 λ = arccos((Re/r)·cosε) − ε，覆盖半径 = Re·λ，过境时长 = 2λ/|ω_s − ω_E·cos i|。多普勒取全时窗峰值径向速率 × f/c。Re = 6378.137 km。',
    footSpace: '几何口径：双星各自 SGP4/SDP4 传播至 ECEF，星间距离/掠地/夹角取互视样本中最大星间距离（最大 FSL → 最差工况）；距离变化率取全时窗峰值（中心差分，帧无关）。互视判据：LOS 线段最近地心距 ≥ Re + 大气余量（R_block）。微波多普勒 = |ṙ|·f/c；激光相干多普勒 Δf = |ṙ|·c/λ ÷ ... 取光频 c/λ 折算。Re = 6378.137 km。'
  },
  en: {
    groundTitle: (isUp) => `Regenerative ${isUp ? 'Uplink' : 'Downlink'} Satellite–Facility Geometry Report`,
    spaceTitle: (isLaser) => `Regenerative Inter-Satellite (${isLaser ? 'Laser' : 'Microwave'}) Two-Body Geometry Report`,
    subGround: (sat, band, prop, date) => `Satellite ${sat} · Band ${band} · Propagator ${prop} · ${date}`,
    subSpace: (grp, extra, prop, date) => `Constellation ${grp} · ${extra} · Propagator ${prop} · ${date}`,
    staUp: 'Tx Station', staDn: 'Rx Station', station: 'Facility',
    frameGround: 'TEME (orbit) · WGS84 ellipsoid (facility)', frameSpace: 'TEME (orbit) · ECEF geocentric (inter-sat)',
    accHead: 'Access Windows (All Passes Above Min Elevation)',
    accNo: '#', accLink: 'Link', accStart: 'Start (UTCG)', accStop: 'Stop (UTCG)', accDur: 'Duration (min)',
    accPeakEl: 'Peak El (°)', accPeakRange: 'Peak Range (km)', accPeak: 'Peak Instant (UTCG)',
    accNAg: 'Manual circular / static satellite: epoch-independent worst-case or sub-satellite static geometry — no time-domain access window.',
    aerHead: 'Satellite Geometry (Worst Case: Range / Elevation / Coverage)',
    dynHead: 'Satellite Dynamics & Doppler', dynSat: 'Satellite', dynDop: 'Max Doppler (kHz)', dynDelay: 'One-Way Delay (ms)',
    kAtm: 'Atmospheric Margin', kBlock: 'LOS Block Radius R_block', kIslFreq: 'ISL Frequency', kLambda: 'Wavelength λ',
    elem2Head: 'Two-Body Orbital Elements', endTx: 'Tx Sat', endRx: 'Rx Sat', end: 'End', sat: 'Satellite',
    pairArrow: (a, b) => `${a} → ${b}`,
    mAccHead: 'Mutual-Visibility Access (Both Satellites Simultaneously Visible)', mAccPair: 'Tx Sat → Rx Sat', mAccMaxR: 'Window Max Range (km)',
    mAccNA: 'Manual circular / snapshot satellite: epoch-independent worst-case — no time-domain access window.',
    worstHead: 'Inter-Satellite Geometry (Worst Case)', wPair: 'Tx Sat → Rx Sat', wRange: 'Inter-Sat Range (km)',
    wTxAlt: 'Tx Sat Alt (km)', wRxAlt: 'Rx Sat Alt (km)', wCentral: 'Geocentric Angle (°)', wGraz: 'LOS Graze Alt (km)',
    wDelay: 'One-Way Delay (ms)', wRR: 'Range Rate (km/s)', wDopRf: 'Max Doppler (kHz)', wDopOpt: 'Coherent Doppler Δf (GHz)', wVis: 'Mutual Visibility (%)',
    dyn2Head: 'Two-Body Dynamics (Inertial / Ground-Relative Velocity)', dTxVi: 'Tx · Inertial (km/s)', dRxVi: 'Rx · Inertial (km/s)',
    dTxVg: 'Tx · Ground (km/s)', dRxVg: 'Rx · Ground (km/s)', dRR: 'Range Rate (km/s)',
    a: 'Semi-major a (km)', e: 'Ecc. e', i: 'Incl. i (°)', raan: 'Ω (°)', period: 'Period T (min)',
    peri: 'Perigee (km)', apo: 'Apogee (km)', norad: 'NORAD',
    footGround: 'Geometry basis: selected satellites use a single typical instant t* (same SGP4/SDP4 moment, elevation near min); manual circular orbits use max slant range at min elevation (closed-form spherical); static satellites use fixed sub-satellite geometry. Coverage half-angle λ = arccos((Re/r)·cosε) − ε, radius = Re·λ, max pass = 2λ/|ω_s − ω_E·cos i|. Doppler = window-peak range rate × f/c. Re = 6378.137 km.',
    footSpace: 'Geometry basis: each satellite propagated by SGP4/SDP4 to ECEF; inter-sat range / graze / angle taken at the max inter-sat range among mutually visible samples (max FSL → worst case); range rate is the window peak (central difference, frame-independent). Visibility: LOS segment min geocentric distance ≥ Re + atmospheric margin (R_block). Microwave Doppler = |ṙ|·f/c; laser coherent Doppler Δf uses optical frequency c/λ. Re = 6378.137 km.'
  }
}
const rgeoFor = (lang) => (lang === 'en' ? RGEO.en : RGEO.zh)

function setRowBorder(ws, rowNumber, fromCol, toCol, edges) {
  for (let c = fromCol; c <= toCol; c++) {
    const cell = ws.getCell(rowNumber, c)
    const b = Object.assign({}, cell.border)
    if (edges.top) b.top = edges.top
    if (edges.bottom) b.bottom = edges.bottom
    cell.border = b
  }
}
// 数字单元格：能转数字则存数字（右对齐、可排序/计算），否则原样（'—'/'✕'/字符串）
function numOrText(v) {
  if (v === undefined || v === null || v === '' || v === '—' || v === '✕') return v == null ? '' : v
  const n = Number(v)
  return Number.isFinite(n) && String(v).trim() !== '' ? n : v
}

// 单链路容量 kbps = 频谱效率 η(bps/Hz) × 载波带宽 B(kHz)——与工作台结果区「容量汇总」同口径
function capKbpsOf(d) {
  if (!d) return NaN
  const bw = parseFloat(d.allocBandwidthResult)
  const eta = parseFloat(d.spectralEfficiencyResult)
  return (isFinite(bw) && isFinite(eta)) ? eta * bw : NaN
}
// 汇总块自适应单位（与工作台 UI 同规则）：容量 kbps→Mbps→Gbps；带宽 kHz→MHz→GHz
function fmtCapText(kbps) {
  const n = Number(kbps)
  if (!isFinite(n) || n <= 0) return '0 kbps'
  if (n >= 1e6) return (n / 1e6).toFixed(3) + ' Gbps'
  if (n >= 1e3) return (n / 1e3).toFixed(3) + ' Mbps'
  return n.toFixed(n >= 100 ? 1 : 2) + ' kbps'
}
function fmtBwText(khz) {
  const n = Number(khz)
  if (!isFinite(n) || n <= 0) return '0 kHz'
  if (n >= 1e6) return (n / 1e6).toFixed(3) + ' GHz'
  if (n >= 1e3) return (n / 1e3).toFixed(3) + ' MHz'
  return n.toFixed(n >= 100 ? 1 : 3) + ' kHz'
}

// 容量列（Mbps）：η(bps/Hz)×B(kHz) → Mbps；无带宽/效率则 '—'
const capMbpsCell = (l) => { const k = capKbpsOf(l.data); return isFinite(k) ? (k / 1000).toFixed(3) : '—' }
const statusCell = (t) => ({ label: t.status, get: (l) => (l.error ? t.statusErr : (l.ok ? t.statusOk : t.statusBad)), text: true })

// 再生式四体制各自的汇总参数行（按信号流向裁剪：只列该体制真正有值的指标，读表不见整列空白）。
// 上行=功放/EIRP·上行C/N·上行可用度；下行=收信站G/T·下行C/N·卫星EIRP；星间微波=星间频率/距离·EIRP·G/T·星间C/N·互视；
// 星间激光=光功率链 P_tx/P_rx/P_req·相干多普勒·互视（无载波带宽/门限C/N口径）。
function regenSummaryRows(t, regenMode) {
  const R = (label, key) => ({ label, get: (l) => val(l.data, key) })
  if (regenMode === 'downlink') return [
    R(t.satGtDn, 'gOverTeResult'), R(t.linkMargin, 'linkmargin'),
    R(t.allocBw, 'allocBandwidthResult'), R(t.specEff, 'spectralEfficiencyResult'),
    { label: t.capacity, get: capMbpsCell },
    R(t.downCN, 'carrierTotalCN'), R(t.thresholdCN, 'thresholdCN'),
    R(t.ebno, 'ebnoActualResult'), R(t.esno, 'esnoActualResult'),
    R(t.psd, 'satellitePSDResult'), R(t.satEirpDn, 'EIRPsResult'),
    R(t.availDown, 'systemAvailabilityResult'), statusCell(t)
  ]
  if (regenMode === 'isl') return [
    R(t.islFreq, 'islRfFreqResult'), R(t.islDist, 'islRfDistResult'),
    R(t.islTxEirp, 'islRfEirpResult'), R(t.islRxGt, 'islRfGtResult'),
    R(t.linkMargin, 'linkmargin'), R(t.allocBw, 'allocBandwidthResult'),
    R(t.specEff, 'spectralEfficiencyResult'), { label: t.capacity, get: capMbpsCell },
    R(t.islCN, 'carrierTotalCN'), R(t.thresholdCN, 'thresholdCN'),
    R(t.ebno, 'ebnoActualResult'), R(t.esno, 'esnoActualResult'),
    R(t.islVis, 'islVisibleFracResult'), R(t.availSys, 'systemAvailabilityResult'), statusCell(t)
  ]
  if (regenMode === 'laser') return [
    R(t.laserDist, 'laserDistResult'), R(t.laserTxPower, 'laserTxPowerResult'),
    R(t.laserPrx, 'laserPrxResult'), R(t.laserPreq, 'laserPreqResult'),
    R(t.linkMargin, 'linkmargin'), R(t.laserDoppler, 'laserDopplerResult'),
    R(t.islVis, 'islVisibleFracResult'), R(t.availSys, 'systemAvailabilityResult'), statusCell(t)
  ]
  // 默认：再生式上行
  return [
    R(t.paRecW, 'paRecommendation'), R(t.paRecDbw, 'paRecommendationdBResult'),
    R(t.paActW, 'selectedPowerWResult'), R(t.linkMargin, 'linkmargin'),
    R(t.allocBw, 'allocBandwidthResult'), R(t.specEff, 'spectralEfficiencyResult'),
    { label: t.capacity, get: capMbpsCell },
    R(t.upCN, 'carrierTotalCN'), R(t.thresholdCN, 'thresholdCN'),
    R(t.ebno, 'ebnoActualResult'), R(t.esno, 'esnoActualResult'),
    R(t.psd, 'stationPSDResult'), R(t.availUp, 'systemAvailabilityResult'), statusCell(t)
  ]
}

// 链路汇总的"参数行"：矩阵显示全部指标 ∪ 结果卡片全部字段。每行一个参数，纵向排列——
// 这样每条链路占一整列，从上往下读完一列就是这条链路的完整结果，跟下面单链路详细计算结果表
// （参数纵向列在左、数值在右）是同一种阅读方式，多条链路时天然变成左右并排的对比表。
function summaryRows(t, orbitType, regenMode) {
  // 再生式四体制各自裁剪汇总列（按信号流向只列有效指标，避免上/下/星间口径混列的整列空白）
  if (orbitType === 'REGEN') return regenSummaryRows(t, regenMode)
  // 再生式上下行解耦：系统可用度 = 上行可用度，汇总列头据此改标（GEO/NGSO 仍为联合系统可用度）
  const availLabel = orbitType === 'REGEN' ? t.availUp : t.avail
  return [
    { label: t.paRecW, get: (l) => val(l.data, 'paRecommendation') },
    { label: t.paRecDbw, get: (l) => val(l.data, 'paRecommendationdBResult') },
    { label: t.paActW, get: (l) => val(l.data, 'selectedPowerWResult') },
    { label: t.linkMargin, get: (l) => val(l.data, 'linkmargin') },
    { label: t.allocBw, get: (l) => val(l.data, 'allocBandwidthResult') },
    { label: t.powerBw, get: (l) => val(l.data, 'PowerBWResult') },
    { label: t.specEff, get: (l) => val(l.data, 'spectralEfficiencyResult') },
    { label: t.capacity, get: (l) => { const k = capKbpsOf(l.data); return isFinite(k) ? (k / 1000).toFixed(3) : '—' } },
    { label: t.bwUsage, get: (l) => val(l.data, 'bandwidthUsageRatio') },
    { label: t.pwUsage, get: (l) => val(l.data, 'powerUsageRatio') },
    { label: t.upCN, get: (l) => val(l.data, 'uplinkCN') },
    { label: t.downCN, get: (l) => val(l.data, 'downlinkCN') },
    { label: t.totalCN, get: (l) => val(l.data, 'carrierTotalCN') },
    { label: t.thresholdCN, get: (l) => val(l.data, 'thresholdCN') },
    { label: t.ebno, get: (l) => val(l.data, 'ebnoActualResult') },
    { label: t.esno, get: (l) => val(l.data, 'esnoActualResult') },
    { label: t.psd, get: (l) => val(l.data, 'satellitePSDResult') },
    { label: availLabel, get: (l) => val(l.data, 'systemAvailabilityResult') },
    { label: t.status, get: (l) => (l.error ? t.statusErr : (l.ok ? t.statusOk : t.statusBad)), text: true }
  ]
}
// 每条链路的列头：常规计算用 #序号，矩阵计算用坐标；第二行换行写发信站→收信站
function linkColHeader(l, idx, isSequential) {
  return `${isSequential ? '#' + (idx + 1) : l.coord}\n${l.txName || ''} → ${l.rxName || ''}`
}

// 瀑布段渲染辅助（与小程序 exportLinkBudget 同口径：黑白三线表）
const valueHeaders = (cols, t) => (cols >= 3 ? [t.uplink, t.downlink, t.total] : cols >= 2 ? [t.uplink, t.downlink] : [t.value])
const rowValues = (row, cols) => (cols >= 3 ? [row.up || '', row.down || '', row.total || ''] : cols >= 2 ? [row.up || '', row.down || ''] : [row.up || ''])
const labelWithSign = (row) => (row.sign ? row.sign + ' ' : '') + (row.label || '')

// ① 链路汇总（纵向：参数名在左侧纵列，每条链路占一列；常规计算/矩阵计算共用同一种纵向布局，
// 仅列头标识不同——常规计算 #序号，矩阵计算坐标 T#R#）
function buildSummarySheet(wb, links, params, meta, t, isSequential, orbitType, regenMode) {
  const rows = summaryRows(t, orbitType, regenMode)
  const ncol = 1 + links.length
  const ws = wb.addWorksheet(t.sheetSummary, { views: [{ showGridLines: false, state: 'frozen', xSplit: 1, ySplit: 4 }] })
  ws.mergeCells(1, 1, 1, ncol)
  const title = ws.getCell(1, 1); title.value = meta.title || t.reportTitle
  title.font = { name: CJK, size: 15, bold: true }; title.alignment = { vertical: 'middle' }; ws.getRow(1).height = 28
  ws.mergeCells(2, 1, 2, ncol)
  const s = ws.getCell(2, 1)
  s.value = t.subtitle(params.satelliteName || '—', params.frequencyBand || '—', meta.mode || '—', meta.pairMode || (isSequential ? t.pairSeq : t.pairMatrix), new Date().toLocaleString())
  s.font = { name: CJK, size: 10, color: { argb: 'FF666666' } }; s.alignment = { vertical: 'middle' }; ws.getRow(2).height = 20
  // 表头（第 4 行）：左上角「参数」+ 每条链路一列
  const hr = 4
  const corner = ws.getCell(hr, 1); corner.value = t.param
  corner.font = { name: CJK, bold: true, size: 10 }; corner.alignment = { vertical: 'middle', horizontal: 'left' }
  links.forEach((l, idx) => {
    const cell = ws.getCell(hr, idx + 2)
    cell.value = linkColHeader(l, idx, isSequential)
    cell.font = { name: CJK, bold: true, size: 10 }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  })
  setRowBorder(ws, hr, 1, ncol, { top: MED, bottom: THIN }); ws.getRow(hr).height = 34
  // 数据行：一行一个参数，横向铺开各条链路的值
  let r = hr + 1
  rows.forEach((row) => {
    const lc = ws.getCell(r, 1); lc.value = row.label
    lc.font = { name: CJK, size: 10 }; lc.alignment = { vertical: 'middle', horizontal: 'left' }
    links.forEach((l, idx) => {
      const raw = row.get(l)
      const cell = ws.getCell(r, idx + 2)
      cell.value = row.text ? (raw == null ? '' : raw) : numOrText(raw)
      cell.font = { name: row.text ? CJK : FNT, size: 10 }
      cell.alignment = { vertical: 'middle', horizontal: row.text ? 'center' : 'right' }
    })
    ws.getRow(r).height = 19
    r++
  })
  if (rows.length) setRowBorder(ws, r - 1, 1, ncol, { bottom: MED })
  // 容量汇总（与工作台结果区同口径）：总带宽 = Σ 载波带宽，总容量 = Σ(η×B) 逐链路相乘再求和，
  // 平均频谱效率 = 总容量/总带宽（带宽加权）；失败链路排除并在标题注明。
  // 再生式激光星间无载波带宽/频谱效率口径（给定速率的光学功率预算），容量汇总恒为 0 → 直接略去。
  const done = links.filter((l) => l.data && !l.error)
  if (done.length && regenMode !== 'laser') {
    let bwKHz = 0, capKbps = 0
    for (const l of done) {
      const bw = parseFloat(l.data.allocBandwidthResult)
      if (isFinite(bw)) bwKHz += bw
      const k = capKbpsOf(l.data)
      if (isFinite(k)) capKbps += k
    }
    r++
    ws.mergeCells(r, 1, r, ncol)
    const hd = ws.getCell(r, 1); hd.value = t.capHeader(done.length, links.length - done.length)
    hd.font = { name: CJK, size: 11, bold: true }; hd.alignment = { vertical: 'middle', horizontal: 'left' }
    setRowBorder(ws, r, 1, ncol, { bottom: THIN }); ws.getRow(r).height = 22; r++
    const capRows = [
      [t.totalCap, fmtCapText(capKbps)],
      [t.totalBw, fmtBwText(bwKHz)],
      [t.avgEff, bwKHz > 0 ? (capKbps / bwKHz).toFixed(3) + ' bps/Hz' : '—']
    ]
    for (const [label, value] of capRows) {
      const lc = ws.getCell(r, 1); lc.value = label
      lc.font = { name: CJK, size: 10 }; lc.alignment = { vertical: 'middle', horizontal: 'left' }
      const vc = ws.getCell(r, 2); vc.value = value
      vc.font = { name: FNT, size: 10, bold: true }; vc.alignment = { vertical: 'middle', horizontal: 'right' }
      ws.getRow(r).height = 19; r++
    }
    setRowBorder(ws, r - 1, 1, ncol, { bottom: MED })
  }
  ws.columns = [{ width: 24 }, ...links.map(() => ({ width: 15 }))]
}

// ② 单链路详细计算结果（七段瀑布，仿小程序专业版三线表；标签翻译来自 buildWaterfallSegments 本身）
function writeLinkDetailSheet(ws, link, t) {
  const MAXCOL = 5
  ws.columns = [{ width: 32 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 10 }]
  let r = 1
  ws.mergeCells(r, 1, r, MAXCOL)
  const tc = ws.getCell(r, 1); tc.value = link.name || ''
  tc.font = { name: CJK, bold: true, size: 15 }; tc.alignment = { horizontal: 'left', vertical: 'middle' }; ws.getRow(r).height = 28; r++
  if (link.subtitle) {
    ws.mergeCells(r, 1, r, MAXCOL)
    const sub = ws.getCell(r, 1); sub.value = link.subtitle
    sub.font = { name: CJK, size: 10, color: { argb: 'FF666666' } }; sub.alignment = { horizontal: 'left', vertical: 'middle' }; ws.getRow(r).height = 18; r++
  }
  r++
  for (const seg of (link.segments || [])) {
    if (!seg || !seg.rows || !seg.rows.length) continue
    const cols = seg.cols || 1
    const vh = valueHeaders(cols, t)
    const totalCols = 2 + vh.length
    ws.mergeCells(r, 1, r, totalCols)
    const cap = ws.getCell(r, 1); cap.value = seg.title || ''
    cap.font = { name: CJK, bold: true, size: 12 }; cap.alignment = { horizontal: 'left', vertical: 'middle' }; ws.getRow(r).height = 24; r++
    // 表头
    const headerTexts = [t.param, ...vh, t.unit]
    headerTexts.forEach((h, i) => {
      const cell = ws.getCell(r, i + 1); cell.value = h
      cell.font = { name: CJK, bold: true, size: 10 }
      cell.alignment = { horizontal: i === 0 ? 'left' : (i === totalCols - 1 ? 'left' : 'right'), vertical: 'middle' }
    })
    setRowBorder(ws, r, 1, totalCols, { top: MED, bottom: THIN }); ws.getRow(r).height = 20; r++
    // 数据行
    const dataRows = seg.rows
    dataRows.forEach((row, ri) => {
      const isLast = ri === dataRows.length - 1
      const vals = rowValues(row, cols)
      const strong = ['base', 'sub', 'chk', 'kpi', 'margin'].indexOf(row.kind) > -1
      const sepTop = ['sub', 'margin'].indexOf(row.kind) > -1
      const lc = ws.getCell(r, 1); lc.value = labelWithSign(row)
      lc.font = { name: CJK, size: 10, bold: strong, color: { argb: 'FF1A1A1A' } }; lc.alignment = { horizontal: 'left', vertical: 'middle' }
      vals.forEach((v, vi) => {
        const isTotalCol = cols >= 3 && vi === 2
        const cell = ws.getCell(r, 2 + vi)
        cell.value = numOrText(v)
        cell.font = { name: FNT, size: 10, bold: strong || isTotalCol }; cell.alignment = { horizontal: 'right', vertical: 'middle' }
      })
      const uc = ws.getCell(r, totalCols); uc.value = row.unit || ''
      uc.font = { name: FNT, size: 9, color: { argb: 'FF555555' } }; uc.alignment = { horizontal: 'left', vertical: 'middle' }
      const edges = {}
      if (sepTop) edges.top = HAIR
      if (isLast) edges.bottom = MED
      if (edges.top || edges.bottom) setRowBorder(ws, r, 1, totalCols, edges)
      ws.getRow(r).height = 18
      r++
    })
    r++
  }
}

// UTCG 时标（STK 口径）：把 ISO 时刻格式化为「1 Jul 2026 00:12:34.567」（英文月缩写，毫秒三位），
// 无论中/英文导出均用此格式——「对标 STK」即以其 UTCG 时间表述为准。
const UTCG_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function utcg(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const p = (n, w) => String(n).padStart(w || 2, '0')
  return `${d.getUTCDate()} ${UTCG_MON[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
}

// 传播器/几何算法名本地化：SGP4/SDP4 通用；手动/静态的中文名在英文导出时译出。
function propLabel(method, lang) {
  if (lang !== 'en') return method || '—'
  return ({ '闭式球面': 'Closed-form spherical', '静态几何': 'Static geometry' })[method] || method || '—'
}

// ③ NGSO 几何关系（STK 版式，单独一张 sheet；仅 orbitType==='NGSO' 生成）。
// 把 NGSO 特色几何量——互视访问窗口、时变斜距/仰角、卫星高度、覆盖半角/半径、过境时长、
// 轨道速度、多普勒、单程时延、轨道根数——从平台单一真值源（ngsoGeometry：选星=典型时刻 t*，
// 手动=闭式球面，静止/快照=静态几何）汇总为对标 STK 的报告表。轨道根数在多链路间共享（同一卫星），
// 故只列一次；t*/互视窗/斜距/高度等随站对不同而逐链路列出。station 经纬/最低仰角由 txGeo/rxGeo 透传。
function buildNgsoGeometrySheet(wb, links, params, meta, lang) {
  if (!links || !links.length) return
  const g = strFor(lang).geo
  const NCOL = 12
  const ws = wb.addWorksheet(g.sheetName, { views: [{ showGridLines: false }] })
  ws.columns = [{ width: 6 }, { width: 15 }, { width: 20 }, { width: 16 }, { width: 16 }, { width: 13 },
    { width: 16 }, { width: 13 }, { width: 13 }, { width: 14 }, { width: 13 }, { width: 13 }]
  let r = 1

  // —— 单元格辅助 ——
  const num = (rr, c, x, dp, bold) => {
    const cell = ws.getCell(rr, c); const v = (x == null || !isFinite(x)) ? null : Number(x)
    cell.value = v == null ? '—' : v
    if (v != null) cell.numFmt = dp > 0 ? '0.' + '0'.repeat(dp) : '0'
    cell.font = { name: FNT, size: 10, bold: !!bold }; cell.alignment = { horizontal: 'right', vertical: 'middle' }
  }
  const str = (rr, c, text, align, o) => {
    o = o || {}; const cell = ws.getCell(rr, c)
    cell.value = text == null ? '' : text
    cell.font = { name: o.font || CJK, size: o.size || 10, bold: !!o.bold, color: o.color ? { argb: o.color } : undefined }
    cell.alignment = { horizontal: align || 'left', vertical: 'middle', wrapText: !!o.wrap }
  }
  const section = (text, span) => {
    ws.mergeCells(r, 1, r, span); const cell = ws.getCell(r, 1)
    cell.value = text; cell.font = { name: CJK, bold: true, size: 12 }; cell.alignment = { horizontal: 'left', vertical: 'middle' }
    ws.getRow(r).height = 24; r++
  }
  const thead = (labels) => {
    labels.forEach((lb, i) => str(r, i + 1, lb, i === 0 ? 'left' : 'center', { bold: true, size: 9, wrap: true }))
    setRowBorder(ws, r, 1, labels.length, { top: MED, bottom: THIN }); ws.getRow(r).height = 30; r++
  }
  const kv = (label, value, unit, valFont) => {
    ws.mergeCells(r, 1, r, 2); str(r, 1, label, 'left', { size: 10 })
    ws.mergeCells(r, 3, r, 5); str(r, 3, value, 'left', { size: 10, font: valFont || FNT })
    str(r, 6, unit || '', 'left', { size: 9, font: FNT, color: 'FF555555' })
    ws.getRow(r).height = 18; r++
  }
  const kvNum = (label, v, dp, unit) => {
    ws.mergeCells(r, 1, r, 2); str(r, 1, label, 'left', { size: 10 })
    ws.mergeCells(r, 3, r, 5); num(r, 3, v, dp)
    str(r, 6, unit || '', 'left', { size: 9, font: FNT, color: 'FF555555' })
    ws.getRow(r).height = 18; r++
  }

  // 参考几何（共享轨道根数 / 传播器 / 场景历元）：优先取首个可行链路
  const refLink = links.find((l) => l.geom && l.geom.feasible) || links.find((l) => l.geom) || null
  const refGeom = refLink ? refLink.geom : null
  const propName = refGeom ? propLabel(refGeom.method, lang) : '—'
  const paren = lang === 'en' ? [' (', ')'] : ['（', '）']

  // —— 标题 + 副标题 ——
  ws.mergeCells(r, 1, r, NCOL)
  const tc = ws.getCell(r, 1); tc.value = g.title
  tc.font = { name: CJK, bold: true, size: 15 }; tc.alignment = { horizontal: 'left', vertical: 'middle' }; ws.getRow(r).height = 28; r++
  ws.mergeCells(r, 1, r, NCOL)
  const sc = ws.getCell(r, 1)
  sc.value = g.subtitle(params.satelliteName || '—', params.frequencyBand || '—', propName, new Date().toLocaleString())
  sc.font = { name: CJK, size: 10, color: { argb: 'FF666666' } }; sc.alignment = { horizontal: 'left', vertical: 'middle' }; ws.getRow(r).height = 18; r++
  r++

  // —— 场景与轨道属性（全局属性，STK 口径）——
  section(g.attrHead, 6)
  const coupledLinks = links.filter((l) => l.geom && l.geom.feasible && l.geom.coupled)
  const cgSearch = coupledLinks.length ? coupledLinks[0].geom.search : null
  kv(g.kSat, params.satelliteName || '—', '', CJK)
  kv(g.kProp, propName, '')
  kv(g.kFrame, g.frameVal, '', CJK)
  if (cgSearch) {
    kv(g.kEpoch, utcg(cgSearch.t0ISO), 'UTCG')
    kv(g.kHorizon, cgSearch.horizonHours != null ? String(cgSearch.horizonHours) : '—', 'h')
  }
  kv(g.kTimeSys, g.timeSysVal, '', CJK)
  r++

  // —— 轨道根数（同一卫星，多链路共享，只列一次）——
  if (refGeom && refGeom.elements) {
    const el = refGeom.elements
    section(`${g.elemHead}${paren[0]}${el.satnum == null ? g.elemVirtual : g.elemStatic}${paren[1]}`, 6)
    kvNum(g.a, el.a, 3, 'km'); kvNum(g.e, el.e, 6, ''); kvNum(g.i, el.iDeg, 4, '°')
    kvNum(g.raan, el.raanDeg, 4, '°'); kvNum(g.argp, el.argpDeg, 4, '°'); kvNum(g.ma, el.maDeg, 4, '°')
    kvNum(g.mm, el.meanMotionRevDay, 6, 'rev/day'); kvNum(g.period, el.periodMin, 3, 'min')
    kvNum(g.peri, el.perigeeAltKm, 1, 'km'); kvNum(g.apo, el.apogeeAltKm, 1, 'km')
    if (el.satnum) kv(g.norad, String(el.satnum), '')
    r++
  }

  // —— 互视访问窗口（STK Access 版式；仅选星耦合几何有时域窗）——
  const feasLinks = links.filter((l) => l.geom && l.geom.feasible)
  section(g.accHead, 7)
  if (coupledLinks.length) {
    thead([g.accNo, g.accLink, g.accPair, g.accStart, g.accStop, g.accDur, g.accTypical])
    coupledLinks.forEach((l, idx) => {
      const s = l.geom.search || {}, w = s.mutualWindow || {}
      str(r, 1, String(idx + 1), 'center', { font: FNT, size: 10 })
      str(r, 2, l.coord, 'center', { font: FNT, size: 10 })
      str(r, 3, `${l.txName || ''} → ${l.rxName || ''}`, 'left', { size: 10, wrap: true })
      str(r, 4, utcg(w.startISO), 'center', { font: FNT, size: 9, wrap: true })
      str(r, 5, utcg(w.endISO) + (w.clipped ? g.accClip : ''), 'center', { font: FNT, size: 9, wrap: true })
      num(r, 6, w.durationMin, 2)
      str(r, 7, utcg(s.typicalISO), 'center', { font: FNT, size: 9, wrap: true })
      ws.getRow(r).height = 26; r++
    })
    setRowBorder(ws, r - 1, 1, 7, { bottom: MED })
  } else if (feasLinks.length) {
    ws.mergeCells(r, 1, r, NCOL); str(r, 1, g.accNA, 'left', { size: 10, color: 'FF666666', wrap: true }); ws.getRow(r).height = 20; r++
  }
  r++

  // —— 站星几何（斜距 / 仰角 / 覆盖；每链路 上行·下行 两行）——
  if (feasLinks.length) {
    section(g.aerHead, NCOL)
    thead([g.aerLink, g.aerDir, g.aerStn, g.aerLat, g.aerLon, g.aerMinEl, g.aerEl, g.aerRange, g.aerSatAlt, g.aerHalf, g.aerCovR, g.aerPass])
    feasLinks.forEach((l) => {
      const w = l.geom.worst || {}
      const dirs = [
        { dir: g.dirUp, geo: l.txGeo || {}, side: w.up || {}, name: l.txName },
        { dir: g.dirDn, geo: l.rxGeo || {}, side: w.dn || {}, name: l.rxName }
      ]
      dirs.forEach((d, ri) => {
        str(r, 1, ri === 0 ? l.coord : '', 'center', { font: FNT, size: 10 })
        str(r, 2, d.dir, 'center', { size: 9, color: 'FF1A1A1A' })
        str(r, 3, d.geo.name || d.name || '', 'left', { size: 10, wrap: true })
        num(r, 4, d.geo.lat, 4); num(r, 5, d.geo.lon, 4); num(r, 6, d.geo.minEl, 2)
        num(r, 7, d.side.elevDeg, 2); num(r, 8, d.side.slantKm, 2); num(r, 9, d.side.altKm, 1)
        num(r, 10, d.side.coverageHalfAngleDeg, 3); num(r, 11, d.side.coverageRadiusKm, 1)
        if (d.side.maxPassMin == null) str(r, 12, g.resident, 'right', { font: FNT, size: 9, color: 'FF888888' })
        else num(r, 12, d.side.maxPassMin, 2)
        ws.getRow(r).height = 18; r++
      })
    })
    setRowBorder(ws, r - 1, 1, NCOL, { bottom: MED })
    r++

    // —— 卫星运动与多普勒 ——
    const anyEst = feasLinks.some((l) => l.geom.dopplerEstimate)
    section(g.dynHead, 6)
    thead([g.dynLink, g.dynVi, g.dynVg + (anyEst ? g.dynEst : ''), g.dynDu + (anyEst ? g.dynEst : ''), g.dynDd + (anyEst ? g.dynEst : ''), g.dynDelay])
    feasLinks.forEach((l) => {
      const w = l.geom.worst || {}
      str(r, 1, l.coord, 'center', { font: FNT, size: 10 })
      num(r, 2, w.speedInertialKmS, 3)
      num(r, 3, w.speedGroundRelKmS, 3)
      num(r, 4, w.maxDopplerUpHz != null ? w.maxDopplerUpHz / 1000 : null, 3)
      num(r, 5, w.maxDopplerDnHz != null ? w.maxDopplerDnHz / 1000 : null, 3)
      num(r, 6, w.oneWayDelayMs, 3)
      ws.getRow(r).height = 18; r++
    })
    setRowBorder(ws, r - 1, 1, 6, { bottom: MED })
    r++
  }

  // —— 不可行链路（列出原因，避免几何表里被静默漏掉）——
  const infeas = links.filter((l) => l.geom && !l.geom.feasible)
  if (infeas.length) {
    section(g.infeasHead, NCOL)
    str(r, 1, g.accLink, 'center', { bold: true, size: 9 })
    ws.mergeCells(r, 2, r, 3); str(r, 2, g.accPair, 'left', { bold: true, size: 9 })
    ws.mergeCells(r, 4, r, NCOL); str(r, 4, g.infeasReason, 'left', { bold: true, size: 9 })
    setRowBorder(ws, r, 1, NCOL, { top: MED, bottom: THIN }); ws.getRow(r).height = 20; r++
    infeas.forEach((l) => {
      str(r, 1, l.coord, 'center', { font: FNT, size: 10 })
      ws.mergeCells(r, 2, r, 3); str(r, 2, `${l.txName || ''} → ${l.rxName || ''}`, 'left', { size: 10, wrap: true })
      ws.mergeCells(r, 4, r, NCOL); str(r, 4, l.geom.reason || '—', 'left', { size: 10, color: 'FF666666', wrap: true })
      ws.getRow(r).height = 20; r++
    })
    setRowBorder(ws, r - 1, 1, NCOL, { bottom: MED })
    r++
  }

  // —— 方法学脚注 ——
  ws.mergeCells(r, 1, r, NCOL)
  const fc = ws.getCell(r, 1); fc.value = g.foot
  fc.font = { name: CJK, size: 9, color: { argb: 'FF999999' } }; fc.alignment = { horizontal: 'left', vertical: 'top', wrapText: true }
  ws.getRow(r).height = 48
}

// ============================================================================
// 再生式「几何关系」sheet（STK 三线表版式）——四体制分两族：
//   地面—空间（上行/下行）：站星 AER + 访问窗口 + 轨道根数 + 卫星运动/多普勒
//   空间—空间（星间微波/激光）：两星互视几何（最差工况）+ 互视窗 + 两星根数 + 两星运动
// 单独成 sheet 集中呈现几何（详情表仍保留瀑布式几何段，两者并存，与 NGSO 版式一致）。
// ============================================================================
// 几何 sheet 通用写入器：内含行指针 r，封装 STK 版式三线表小工具（数字/文本/分节/表头/键值/标题/脚注）。
function makeGeoWriter(ws, ncol) {
  const w = { ws, r: 1, ncol }
  w.num = (c, x, dp, bold) => {
    const cell = ws.getCell(w.r, c); const v = (x == null || !isFinite(x)) ? null : Number(x)
    cell.value = v == null ? '—' : v
    if (v != null) cell.numFmt = dp > 0 ? '0.' + '0'.repeat(dp) : '0'
    cell.font = { name: FNT, size: 10, bold: !!bold }; cell.alignment = { horizontal: 'right', vertical: 'middle' }
  }
  w.str = (c, text, align, o) => {
    o = o || {}; const cell = ws.getCell(w.r, c)
    cell.value = text == null ? '' : text
    cell.font = { name: o.font || CJK, size: o.size || 10, bold: !!o.bold, color: o.color ? { argb: o.color } : undefined }
    cell.alignment = { horizontal: align || 'left', vertical: 'middle', wrapText: !!o.wrap }
  }
  w.section = (text, span) => {
    ws.mergeCells(w.r, 1, w.r, span || ncol); const cell = ws.getCell(w.r, 1)
    cell.value = text; cell.font = { name: CJK, bold: true, size: 12 }; cell.alignment = { horizontal: 'left', vertical: 'middle' }
    ws.getRow(w.r).height = 24; w.r++
  }
  w.thead = (labels) => {
    labels.forEach((lb, i) => w.str(i + 1, lb, i === 0 ? 'left' : 'center', { bold: true, size: 9, wrap: true }))
    setRowBorder(ws, w.r, 1, labels.length, { top: MED, bottom: THIN }); ws.getRow(w.r).height = 30; w.r++
  }
  w.kv = (label, value, unit, valFont) => {
    ws.mergeCells(w.r, 1, w.r, 2); w.str(1, label, 'left', { size: 10 })
    ws.mergeCells(w.r, 3, w.r, 5); w.str(3, value, 'left', { size: 10, font: valFont || FNT })
    w.str(6, unit || '', 'left', { size: 9, font: FNT, color: 'FF555555' })
    ws.getRow(w.r).height = 18; w.r++
  }
  w.kvNum = (label, v, dp, unit) => {
    ws.mergeCells(w.r, 1, w.r, 2); w.str(1, label, 'left', { size: 10 })
    ws.mergeCells(w.r, 3, w.r, 5); w.num(3, v, dp)
    w.str(6, unit || '', 'left', { size: 9, font: FNT, color: 'FF555555' })
    ws.getRow(w.r).height = 18; w.r++
  }
  w.title = (title, subtitle) => {
    ws.mergeCells(w.r, 1, w.r, ncol)
    const tc = ws.getCell(w.r, 1); tc.value = title
    tc.font = { name: CJK, bold: true, size: 15 }; tc.alignment = { horizontal: 'left', vertical: 'middle' }; ws.getRow(w.r).height = 28; w.r++
    ws.mergeCells(w.r, 1, w.r, ncol)
    const sc = ws.getCell(w.r, 1); sc.value = subtitle
    sc.font = { name: CJK, size: 10, color: { argb: 'FF666666' } }; sc.alignment = { horizontal: 'left', vertical: 'middle' }; ws.getRow(w.r).height = 18; w.r++
    w.r++
  }
  w.foot = (text) => {
    ws.mergeCells(w.r, 1, w.r, ncol)
    const fc = ws.getCell(w.r, 1); fc.value = text
    fc.font = { name: CJK, size: 9, color: { argb: 'FF999999' } }; fc.alignment = { horizontal: 'left', vertical: 'top', wrapText: true }
    ws.getRow(w.r).height = 56; w.r++
  }
  w.rowEnd = (span) => setRowBorder(ws, w.r - 1, 1, span || ncol, { bottom: MED })
  w.gap = () => { w.r++ }
  return w
}

// —— 地面—空间几何（再生式上行 / 下行）——单站每链路，direction 决定取 up/dn 侧几何与上/下行多普勒。
function buildRegenGroundGeometrySheet(wb, links, params, meta, lang, direction) {
  if (!links || !links.length) return
  const g = strFor(lang).geo, rg = rgeoFor(lang)
  const isUp = direction !== 'downlink'
  const sideKey = isUp ? 'up' : 'dn'
  const dopKey = isUp ? 'maxDopplerUpHz' : 'maxDopplerDnHz'
  const staRole = isUp ? rg.staUp : rg.staDn
  const NCOL = 11
  const ws = wb.addWorksheet(g.sheetName, { views: [{ showGridLines: false }] })
  ws.columns = [{ width: 6 }, { width: 18 }, { width: 14 }, { width: 14 }, { width: 13 }, { width: 13 }, { width: 14 }, { width: 13 }, { width: 13 }, { width: 14 }, { width: 13 }]
  const W = makeGeoWriter(ws, NCOL)
  // 链路编号取「全链路数组中的稳定序号」（与汇总表 #N 一致），各表统一引用 l._no —— 避免各表按各自
  // 过滤子集(feas/withAcc/infeas)重新从 1 计数造成同一链路跨表串号、可行/不可行编号相撞。
  links.forEach((l, i) => { l._no = i + 1 })
  const feas = links.filter((l) => l.geom && l.geom.feasible)
  const refGeom = (feas[0] && feas[0].geom) || (links.find((l) => l.geom) || {}).geom || null
  const propName = refGeom ? propLabel(refGeom.method, lang) : '—'
  const paren = lang === 'en' ? [' (', ')'] : ['（', '）']

  W.title(rg.groundTitle(isUp), rg.subGround(params.satelliteName || '—', params.frequencyBand || '—', propName, new Date().toLocaleString()))

  // 场景与轨道属性
  W.section(g.attrHead, 6)
  const search = refGeom ? refGeom.search : null
  W.kv(g.kProp, propName, '')
  W.kv(g.kFrame, rg.frameGround, '', CJK)
  if (search) { W.kv(g.kEpoch, utcg(search.t0ISO), 'UTCG'); W.kv(g.kHorizon, search.horizonHours != null ? String(search.horizonHours) : '—', 'h') }
  W.kv(g.kTimeSys, g.timeSysVal, '', CJK)
  W.gap()

  // 轨道根数（按卫星去重：单星→键值块；多星→逐星一行表）
  const elemMap = new Map()
  for (const l of feas) {
    if (!l.geom.elements) continue
    const key = (l.satName || '') + '|' + (l.geom.elements.satnum == null ? '' : l.geom.elements.satnum)
    if (!elemMap.has(key)) elemMap.set(key, { name: l.satName || params.satelliteName || '—', el: l.geom.elements })
  }
  const elemList = [...elemMap.values()]
  if (elemList.length === 1) {
    const el = elemList[0].el
    W.section(`${g.elemHead}${paren[0]}${el.satnum == null ? g.elemVirtual : g.elemStatic}${paren[1]}`, 6)
    W.kvNum(g.a, el.a, 3, 'km'); W.kvNum(g.e, el.e, 6, ''); W.kvNum(g.i, el.iDeg, 4, '°')
    W.kvNum(g.raan, el.raanDeg, 4, '°'); W.kvNum(g.argp, el.argpDeg, 4, '°'); W.kvNum(g.ma, el.maDeg, 4, '°')
    W.kvNum(g.mm, el.meanMotionRevDay, 6, 'rev/day'); W.kvNum(g.period, el.periodMin, 3, 'min')
    W.kvNum(g.peri, el.perigeeAltKm, 1, 'km'); W.kvNum(g.apo, el.apogeeAltKm, 1, 'km')
    if (el.satnum) W.kv(g.norad, String(el.satnum), '')
    W.gap()
  } else if (elemList.length > 1) {
    W.section(g.elemHead, NCOL)
    W.thead([rg.sat, rg.a, rg.e, rg.i, rg.raan, rg.period, rg.peri, rg.apo, rg.norad])
    elemList.forEach((it) => {
      const el = it.el
      W.str(1, it.name, 'left', { size: 10, wrap: true })
      W.num(2, el.a, 3); W.num(3, el.e, 6); W.num(4, el.iDeg, 4); W.num(5, el.raanDeg, 4)
      W.num(6, el.periodMin, 3); W.num(7, el.perigeeAltKm, 1); W.num(8, el.apogeeAltKm, 1)
      W.str(9, el.satnum == null ? '—' : String(el.satnum), 'right', { font: FNT, size: 10 })
      ws.getRow(W.r).height = 18; W.r++
    })
    W.rowEnd(9); W.gap()
  }

  // 访问窗口（满足最低仰角的全部过境；无窗则示意几何注记）
  const withAcc = feas.filter((l) => l.access && Array.isArray(l.access.windows) && l.access.windows.length)
  W.section(rg.accHead, 9)
  if (withAcc.length) {
    W.thead([rg.accNo, rg.accLink, rg.station, rg.accStart, rg.accStop, rg.accDur, rg.accPeakEl, rg.accPeakRange, rg.accPeak])
    let n = 0
    withAcc.forEach((l, li) => {
      const wins = l.access.windows.slice(0, 12)
      wins.forEach((wd) => {
        n++
        W.str(1, String(n), 'center', { font: FNT, size: 10 })
        W.str(2, '#' + l._no, 'center', { font: FNT, size: 10 })
        W.str(3, (l.staGeo && l.staGeo.name) || l.satName || '', 'left', { size: 10, wrap: true })
        W.str(4, utcg(wd.startISO), 'center', { font: FNT, size: 9, wrap: true })
        W.str(5, utcg(wd.endISO) + (wd.clipped ? g.accClip : ''), 'center', { font: FNT, size: 9, wrap: true })
        W.num(6, wd.durationMin, 2); W.num(7, wd.peakElevDeg, 2); W.num(8, wd.peakSlantKm, 1)
        W.str(9, utcg(wd.peakISO), 'center', { font: FNT, size: 9, wrap: true })
        ws.getRow(W.r).height = 26; W.r++
      })
    })
    W.rowEnd(9)
  } else if (feas.length) {
    ws.mergeCells(W.r, 1, W.r, NCOL); W.str(1, rg.accNAg, 'left', { size: 10, color: 'FF666666', wrap: true }); ws.getRow(W.r).height = 20; W.r++
  }
  W.gap()

  // 站星几何（最差工况：斜距 / 仰角 / 覆盖）
  if (feas.length) {
    W.section(rg.aerHead, NCOL)
    W.thead([g.aerLink, rg.station, g.aerLat, g.aerLon, g.aerMinEl, g.aerEl, g.aerRange, g.aerSatAlt, g.aerHalf, g.aerCovR, g.aerPass])
    feas.forEach((l, li) => {
      const side = (l.geom.worst && l.geom.worst[sideKey]) || {}
      const sta = l.staGeo || {}
      W.str(1, '#' + l._no, 'center', { font: FNT, size: 10 })
      W.str(2, sta.name || l.satName || '', 'left', { size: 10, wrap: true })
      W.num(3, sta.lat, 4); W.num(4, sta.lon, 4); W.num(5, sta.minEl, 2)
      W.num(6, side.elevDeg, 2); W.num(7, side.slantKm, 2); W.num(8, side.altKm, 1)
      W.num(9, side.coverageHalfAngleDeg, 3); W.num(10, side.coverageRadiusKm, 1)
      if (side.maxPassMin == null) W.str(11, g.resident, 'right', { font: FNT, size: 9, color: 'FF888888' })
      else W.num(11, side.maxPassMin, 2)
      ws.getRow(W.r).height = 18; W.r++
    })
    W.rowEnd(NCOL); W.gap()

    // 卫星运动与多普勒
    const anyEst = feas.some((l) => l.geom.dopplerEstimate)
    W.section(rg.dynHead, 6)
    W.thead([g.aerLink, rg.dynSat, g.dynVi, g.dynVg + (anyEst ? g.dynEst : ''), rg.dynDop + (anyEst ? g.dynEst : ''), rg.dynDelay])
    feas.forEach((l, li) => {
      const wrs = l.geom.worst || {}
      W.str(1, '#' + l._no, 'center', { font: FNT, size: 10 })
      W.str(2, l.satName || params.satelliteName || '', 'left', { size: 10, wrap: true })
      W.num(3, wrs.speedInertialKmS, 3); W.num(4, wrs.speedGroundRelKmS, 3)
      W.num(5, wrs[dopKey] != null ? wrs[dopKey] / 1000 : null, 3); W.num(6, wrs.oneWayDelayMs, 3)
      ws.getRow(W.r).height = 18; W.r++
    })
    W.rowEnd(6); W.gap()
  }

  // 不可行链路
  const infeas = links.filter((l) => l.geom && !l.geom.feasible)
  if (infeas.length) {
    W.section(g.infeasHead, NCOL)
    W.str(1, g.accLink, 'center', { bold: true, size: 9 })
    ws.mergeCells(W.r, 2, W.r, 3); W.str(2, rg.station, 'left', { bold: true, size: 9 })
    ws.mergeCells(W.r, 4, W.r, NCOL); W.str(4, g.infeasReason, 'left', { bold: true, size: 9 })
    setRowBorder(ws, W.r, 1, NCOL, { top: MED, bottom: THIN }); ws.getRow(W.r).height = 20; W.r++
    infeas.forEach((l, li) => {
      W.str(1, '#' + l._no, 'center', { font: FNT, size: 10 })
      ws.mergeCells(W.r, 2, W.r, 3); W.str(2, (l.staGeo && l.staGeo.name) || l.satName || '', 'left', { size: 10, wrap: true })
      ws.mergeCells(W.r, 4, W.r, NCOL); W.str(4, (l.geom && l.geom.reason) || '—', 'left', { size: 10, color: 'FF666666', wrap: true })
      ws.getRow(W.r).height = 20; W.r++
    })
    W.rowEnd(NCOL); W.gap()
  }

  W.foot(rg.footGround)
}

// —— 空间—空间几何（再生式星间微波 / 激光）——每链路两星（发射星→接收星）互视最差工况。
function buildRegenSpaceGeometrySheet(wb, links, params, meta, lang, isLaser) {
  if (!links || !links.length) return
  const g = strFor(lang).geo, rg = rgeoFor(lang)
  const NCOL = 12
  const ws = wb.addWorksheet(g.sheetName, { views: [{ showGridLines: false }] })
  ws.columns = [{ width: 6 }, { width: 22 }, { width: 16 }, { width: 13 }, { width: 13 }, { width: 12 }, { width: 13 }, { width: 12 }, { width: 14 }, { width: 15 }, { width: 13 }, { width: 12 }]
  const W = makeGeoWriter(ws, NCOL)
  // 链路编号取全链路数组稳定序号（与汇总表 #N 一致），各表统一引用 l._no，避免跨表串号/编号相撞。
  links.forEach((l, i) => { l._no = i + 1 })
  const feas = links.filter((l) => l.islGeo && l.islGeo.feasible)
  const ref = (feas[0] && feas[0].islGeo) || (links.find((l) => l.islGeo) || {}).islGeo || null
  const propName = ref ? (lang === 'en' ? (ref.method || '—') : (ref.method || '—')) : '—'
  const rs = ref ? ref.search : null
  const extra = isLaser
    ? `${rg.kLambda} ${rs && rs.freqGHz ? (2.99792458e8 / rs.freqGHz).toFixed(0) : '—'} nm`
    : `${rg.kIslFreq} ${rs && rs.freqGHz ? rs.freqGHz : '—'} GHz`

  W.title(rg.spaceTitle(isLaser), rg.subSpace(params.satelliteName || '—', extra, propName, new Date().toLocaleString()))

  // 场景与几何属性
  W.section(g.attrHead, 6)
  W.kv(g.kProp, propName, '')
  W.kv(g.kFrame, rg.frameSpace, '', CJK)
  if (rs) {
    W.kv(g.kEpoch, utcg(rs.t0ISO), 'UTCG')
    W.kv(g.kHorizon, rs.horizonHours != null ? String(rs.horizonHours) : '—', 'h')
    W.kvNum(rg.kAtm, rs.atmMarginKm, 1, 'km'); W.kvNum(rg.kBlock, rs.blockRadiusKm, 1, 'km')
    if (isLaser) W.kvNum(rg.kLambda, rs.freqGHz ? 2.99792458e8 / rs.freqGHz : null, 0, 'nm')
    else W.kvNum(rg.kIslFreq, rs.freqGHz, 3, 'GHz')
  }
  W.kv(g.kTimeSys, g.timeSysVal, '', CJK)
  W.gap()

  // 两星轨道根数（每链路两行：发射星 / 接收星）
  W.section(rg.elem2Head, NCOL)
  W.thead([g.aerLink, rg.end, rg.sat, rg.a, rg.e, rg.i, rg.raan, rg.period, rg.peri, rg.apo, rg.norad])
  feas.forEach((l, li) => {
    const ends = [
      { tag: rg.endTx, el: l.islGeo.elements && l.islGeo.elements.tx, name: l.txName },
      { tag: rg.endRx, el: l.islGeo.elements && l.islGeo.elements.rx, name: l.rxName }
    ]
    ends.forEach((en, ri) => {
      const el = en.el || {}
      W.str(1, ri === 0 ? '#' + l._no : '', 'center', { font: FNT, size: 10 })
      W.str(2, en.tag, 'center', { size: 9, color: 'FF1A1A1A' })
      W.str(3, en.name || '', 'left', { size: 10, wrap: true })
      W.num(4, el.a, 3); W.num(5, el.e, 6); W.num(6, el.iDeg, 4); W.num(7, el.raanDeg, 4)
      W.num(8, el.periodMin, 3); W.num(9, el.perigeeAltKm, 1); W.num(10, el.apogeeAltKm, 1)
      W.str(11, el.satnum == null ? '—' : String(el.satnum), 'right', { font: FNT, size: 10 })
      ws.getRow(W.r).height = 18; W.r++
    })
  })
  if (feas.length) W.rowEnd(NCOL)
  W.gap()

  // 互视访问窗口
  const withWin = feas.filter((l) => l.islGeo.visibility && Array.isArray(l.islGeo.visibility.windows) && l.islGeo.visibility.windows.length)
  W.section(rg.mAccHead, 7)
  if (withWin.length) {
    W.thead([rg.accNo, g.aerLink, rg.mAccPair, rg.accStart, rg.accStop, rg.accDur, rg.mAccMaxR])
    let n = 0
    withWin.forEach((l, li) => {
      l.islGeo.visibility.windows.slice(0, 12).forEach((wd) => {
        n++
        W.str(1, String(n), 'center', { font: FNT, size: 10 })
        W.str(2, '#' + l._no, 'center', { font: FNT, size: 10 })
        W.str(3, rg.pairArrow(l.txName || '', l.rxName || ''), 'left', { size: 10, wrap: true })
        W.str(4, utcg(wd.startISO), 'center', { font: FNT, size: 9, wrap: true })
        W.str(5, utcg(wd.endISO) + (wd.clipped ? g.accClip : ''), 'center', { font: FNT, size: 9, wrap: true })
        W.num(6, wd.durationMin, 2); W.num(7, wd.maxRangeKm, 1)
        ws.getRow(W.r).height = 26; W.r++
      })
    })
    W.rowEnd(7)
  } else if (feas.length) {
    ws.mergeCells(W.r, 1, W.r, NCOL); W.str(1, rg.mAccNA, 'left', { size: 10, color: 'FF666666', wrap: true }); ws.getRow(W.r).height = 20; W.r++
  }
  W.gap()

  // 星间几何（最差工况）
  if (feas.length) {
    W.section(rg.worstHead, NCOL)
    W.thead([g.aerLink, rg.wPair, rg.wRange, rg.wTxAlt, rg.wRxAlt, rg.wCentral, rg.wGraz, rg.wDelay, rg.wRR, isLaser ? rg.wDopOpt : rg.wDopRf, rg.wVis])
    feas.forEach((l, li) => {
      const wrs = l.islGeo.worst || {}
      const vis = l.islGeo.visibility || {}
      W.str(1, '#' + l._no, 'center', { font: FNT, size: 10 })
      W.str(2, rg.pairArrow(l.txName || '', l.rxName || ''), 'left', { size: 10, wrap: true })
      W.num(3, wrs.rangeKm, 1); W.num(4, wrs.txAltKm, 1); W.num(5, wrs.rxAltKm, 1)
      W.num(6, wrs.centralAngleDeg, 3); W.num(7, wrs.grazAltKm, 1); W.num(8, wrs.oneWayDelayMs, 3)
      W.num(9, wrs.rangeRateKmS, 4)
      W.num(10, wrs.maxDopplerHz != null ? (isLaser ? wrs.maxDopplerHz / 1e9 : wrs.maxDopplerHz / 1000) : null, isLaser ? 3 : 2)
      W.num(11, vis.visibleFrac != null ? vis.visibleFrac * 100 : null, 2)
      ws.getRow(W.r).height = 18; W.r++
    })
    W.rowEnd(NCOL); W.gap()

    // 两星运动（惯性系 / 相对地面速度）
    W.section(rg.dyn2Head, 6)
    W.thead([g.aerLink, rg.dTxVi, rg.dRxVi, rg.dTxVg, rg.dRxVg, rg.dRR])
    feas.forEach((l, li) => {
      const wrs = l.islGeo.worst || {}
      W.str(1, '#' + l._no, 'center', { font: FNT, size: 10 })
      W.num(2, wrs.txSpeedKmS, 3); W.num(3, wrs.rxSpeedKmS, 3)
      W.num(4, wrs.txGroundSpeedKmS, 3); W.num(5, wrs.rxGroundSpeedKmS, 3); W.num(6, wrs.rangeRateKmS, 4)
      ws.getRow(W.r).height = 18; W.r++
    })
    W.rowEnd(6); W.gap()
  }

  // 不可行链路
  const infeas = links.filter((l) => l.islGeo && !l.islGeo.feasible)
  if (infeas.length) {
    W.section(g.infeasHead, NCOL)
    W.str(1, g.accLink, 'center', { bold: true, size: 9 })
    ws.mergeCells(W.r, 2, W.r, 4); W.str(2, rg.mAccPair, 'left', { bold: true, size: 9 })
    ws.mergeCells(W.r, 5, W.r, NCOL); W.str(5, g.infeasReason, 'left', { bold: true, size: 9 })
    setRowBorder(ws, W.r, 1, NCOL, { top: MED, bottom: THIN }); ws.getRow(W.r).height = 20; W.r++
    infeas.forEach((l, li) => {
      W.str(1, '#' + l._no, 'center', { font: FNT, size: 10 })
      ws.mergeCells(W.r, 2, W.r, 4); W.str(2, rg.pairArrow(l.txName || '', l.rxName || ''), 'left', { size: 10, wrap: true })
      ws.mergeCells(W.r, 5, W.r, NCOL); W.str(5, (l.islGeo && l.islGeo.reason) || '—', 'left', { size: 10, color: 'FF666666', wrap: true })
      ws.getRow(W.r).height = 20; W.r++
    })
    W.rowEnd(NCOL); W.gap()
  }

  W.foot(rg.footSpace)
}

// 再生式几何 sheet 分派：上行/下行→地面-空间；星间微波/激光→空间-空间。
function buildRegenGeometrySheet(wb, links, params, meta, lang, regenMode) {
  if (regenMode === 'isl') return buildRegenSpaceGeometrySheet(wb, links, params, meta, lang, false)
  if (regenMode === 'laser') return buildRegenSpaceGeometrySheet(wb, links, params, meta, lang, true)
  return buildRegenGroundGeometrySheet(wb, links, params, meta, lang, regenMode === 'downlink' ? 'downlink' : 'uplink')
}

async function buildLinkBudgetExcel(payload) {
  const { links = [], params = {}, meta = {}, lang = 'zh', pairMode = 'matrix', orbitType = 'GEO', regenMode = 'uplink' } = payload
  const t = strFor(lang)
  const isSequential = pairMode === 'sequential'
  const enriched = links.map((l) => ({ ...l, coord: 'T' + ((l.ti || 0) + 1) + 'R' + ((l.ri || 0) + 1) }))
  const wb = new ExcelJS.Workbook()
  wb.creator = lang === 'en' ? 'GEO Satellite Link Budget Workbench' : '卫星链路预算工作台'; wb.created = new Date()

  buildSummarySheet(wb, enriched, params, meta, t, isSequential, orbitType, regenMode)

  // 紧随汇总表后单立「几何关系」sheet（STK 版式），把体制特色几何量集中呈现。
  // NGSO：站星平台几何；再生式四体制：上/下行=地面-空间站星几何，星间微波/激光=空间-空间两星几何。
  if (orbitType === 'NGSO') buildNgsoGeometrySheet(wb, enriched, params, meta, lang)
  else if (orbitType === 'REGEN') buildRegenGeometrySheet(wb, enriched, params, meta, lang, regenMode)

  // 详细计算结果：每条链路一个 sheet，表名 = 坐标 + 发信站-收信站（去重、截断 31 字符）
  const used = {}
  for (const l of enriched) {
    let base = `${l.coord} ${l.txName || ''}-${l.rxName || ''}`.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || l.coord
    let name = base, k = 2
    while (used[name]) name = base.slice(0, 28) + '~' + (k++)
    used[name] = true
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }] })
    writeLinkDetailSheet(ws, {
      name: `${l.coord}　${l.txName || ''} → ${l.rxName || ''}`,
      subtitle: l.error ? (t.calcFailed + l.error) : t.subtitle(params.satelliteName || '—', params.frequencyBand || '—', meta.mode || '—', meta.pairMode || (isSequential ? t.pairSeq : t.pairMatrix), new Date().toLocaleString()),
      segments: l.segments || []
    }, t)
  }

  return wb.xlsx.writeBuffer()
}

// ===== 日凌预报报告（Word，交付级）=====
// payload: { result: calculateSunOutage 返回值, station:{name,lat,lon}, satellite:{name,lon}, tz:'local'|'utc' }
// 布局：标题 → 参数/模型信息块（键值两列）→ 逐日事件表（三线表）→ 方法学脚注。
// 时标由 tz 决定（默认本地=运行机时区，由 UTC 时刻换算，表头注明偏移；UTC 时刻在 ICS 日历中恒有）。

// 本地时刻：按地球站经度推算整点时区 round(经度/15)h，据 UTC 瞬间平移（随站点位置变化）
function soOffMinFromLon(lon) {
  const l = Number(lon)
  return isFinite(l) ? Math.round(l / 15) * 60 : 0
}
function soLocalOf(dateUTC, hmsUTC, offMin) {
  const dt = new Date(`${dateUTC}T${hmsUTC}Z`)
  if (isNaN(dt.getTime())) return { date: dateUTC, time: hmsUTC }
  dt.setTime(dt.getTime() + (offMin || 0) * 60000)
  const p = (n) => String(n).padStart(2, '0')
  return {
    date: `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`,
    time: `${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`
  }
}
function soLocalTzLabel(offMin) {
  const h = (offMin || 0) / 60
  return h === 0 ? 'UTC' : 'UTC' + (h > 0 ? '+' : '−') + Math.abs(h)
}

function soKV(k, v) {
  return new TableRow({ children: [
    new TableCell({ width: { size: 30, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: String(k), size: 18, color: '666666' })] })] }),
    new TableCell({ width: { size: 70, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: String(v), size: 18 })] })] })
  ] })
}
function soTd(text, opts) {
  opts = opts || {}
  return new TableCell({ children: [new Paragraph({
    alignment: opts.align === 'right' ? AlignmentType.RIGHT : opts.align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
    children: [new TextRun({ text: String(text), bold: !!opts.bold, size: 18 })]
  })] })
}

async function buildSunOutageWord(payload) {
  const { result: r = {}, station = {}, satellite = {}, tz = 'local' } = payload
  const m = r.model || {}
  const isLocal = tz !== 'utc'
  const staOffMin = soOffMinFromLon(station.lon)
  const tzLabel = isLocal ? `本地时 (${soLocalTzLabel(staOffMin)})` : 'UTC'
  const fmtLL = (lat, lon) => `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`

  const info = new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
    soKV('地球站', `${station.name || '—'}（${fmtLL(Number(station.lat) || 0, Number(station.lon) || 0)}）`),
    soKV('卫星', `${satellite.name || '—'} · 轨位 ${satellite.lon}°E`),
    soKV('指向', `方位 ${r.satAz}° · 仰角 ${r.satEl}°`),
    soKV('频率 / 口径', `${r.frequency} GHz · ${m.diameter} m（3dB 波束宽 ${m.beamWidth3dB}°）`),
    soKV('判据', `C/N 恶化 ≥ ${m.degThreshold} dB（T_sys = ${m.sysTemp} K，T_sun = ${m.solarTemp} K${m.solarTempSource === 'manual' ? '·手动指定' : `·由 F10.7=${m.f107} 推算`}）`),
    soKV('分点', `${r.seasonName} ${r.equinoxDate} · 主轴对准恶化上限 ${m.boresightDeg} dB`),
    soKV('事件概况', `${r.startDate} ~ ${r.endDate} 共 ${r.totalDays} 天 · 单日最长 ${r.maxDurationStr}`),
    soKV('时标', tzLabel),
    soKV('生成时间', new Date().toLocaleString())
  ] })

  const header = new TableRow({ children: [
    soTd('序号', { bold: true, align: 'center' }), soTd('日期', { bold: true }),
    soTd('开始', { bold: true, align: 'right' }), soTd('峰值', { bold: true, align: 'right' }),
    soTd('结束', { bold: true, align: 'right' }), soTd('时长', { bold: true, align: 'right' }),
    soTd('峰值恶化 (dB)', { bold: true, align: 'right' }), soTd('强度', { bold: true, align: 'center' })
  ] })
  const body = (r.dailyResults || []).map((d, i) => new TableRow({ children: [
    soTd(i + 1, { align: 'center' }),
    soTd((isLocal ? soLocalOf(d.date, d.startTimeUTC, staOffMin).date : d.date) + (d.isPeak ? ' ★' : ''), { bold: !!d.isPeak }),
    soTd(isLocal ? soLocalOf(d.date, d.startTimeUTC, staOffMin).time : d.startTimeUTC, { align: 'right' }),
    soTd(isLocal ? soLocalOf(d.date, d.peakTimeUTC, staOffMin).time : d.peakTimeUTC, { align: 'right', bold: !!d.isPeak }),
    soTd(isLocal ? soLocalOf(d.date, d.endTimeUTC, staOffMin).time : d.endTimeUTC, { align: 'right' }),
    soTd(d.durationStr, { align: 'right' }),
    soTd(d.peakCNdeg, { align: 'right' }),
    soTd(d.intensity, { align: 'center' })
  ] }))

  const doc = new Document({ sections: [{ children: [
    new Paragraph({ text: '日凌预报报告', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({
      text: `${satellite.name || ''} ${satellite.lon}°E → ${station.name || ''} · ${r.seasonName} ${String(r.equinoxDate || '').slice(0, 4)}`,
      size: 20, color: '444444'
    })] }),
    new Paragraph({ text: '' }),
    info,
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: `逐日日凌窗口（时标：${tzLabel}，★ 为最长日）`, bold: true, size: 20 })] }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...body] }),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({
      text: '方法：太阳视位置 VSOP87+IAU1980 章动（黄经精度 ≈1″）；窗口判据为 C/N 恶化门限——太阳均匀盘（当日视直径）与天线高斯主瓣（3dB 波束宽 70λ/D）作精确卷积得 ΔT(θ)，D(θ)=10lg(1+ΔT/T_sys)≥门限即计入窗口。太阳亮温由太阳射电流量指数 F10.7（2.8GHz 实测，NOAA SWPC 每日发布）锚定、按 (2.8/f)^1.8 谱外推（光球层 6000K floor）。采用当日实测 F10.7 与本站实测 T_sys 时峰值恶化不确定度约 ±1dB；起止时刻对噪温仅对数敏感（±数十秒）。',
      size: 16, color: '999999'
    })] }),
    new Paragraph({ children: [new TextRun({ text: '强度分级：高 ≥10dB（链路失锁）· 中 3~10dB · 低 <3dB。', size: 16, color: '999999' })] })
  ] }] })
  return Packer.toBuffer(doc)
}

// ============================ 雨衰计算 批量结果 Excel（通用，面向各类卫星）============================
// payload：{ direction:'down'|'up', rainModel:'auto'|'manual', rows:[算例输入行], results:[core 结果] }。
// Sheet1「雨衰批量结果」= 每行一个算例（输入 + 计算结果就地并排）；每算例再出一张 SatMaster 版详情表。
const POL_CN = { V: '垂直 (V)', H: '水平 (H)', C: '圆极化 (C)', RHCP: '右旋圆极化 (RHCP)', LHCP: '左旋圆极化 (LHCP)' }
function rainDetailRows(r, row, down) {
  const f = (v, d = 2) => (v == null || !Number.isFinite(+v)) ? '—' : (+v).toFixed(d)
  return [
    ['输入参数', null, null],
    ['地球站', row.stationName || '—', ''],
    ['纬度', f(r.lat, 4), '°'],
    ['经度', f(r.lon, 4), '°'],
    ['海拔', (row.altitude === '' || row.altitude == null) ? 0 : row.altitude, 'm'],
    ['GEO 轨位', r.satLon != null ? f(r.satLon, 2) : '—', r.satLon != null ? '°E' : ''],
    ['频率', f(r.freq, 3), 'GHz'],
    ['极化', POL_CN[r.polDisplay] || POL_CN[r.pol] || r.polDisplay || r.pol || '—', ''],
    ['R0.01% 降雨率', f(r.rainRate, 3), 'mm/h'],
    ['年可用度', f(r.availability, 3), '%'],
    ['系统噪温（晴空）', down ? f(r.systemNoiseTemp, 0) : '—', down ? 'K' : ''],
    ['馈线损耗', down ? f(r.feederLoss, 2) : '—', down ? 'dB' : ''],
    ['链路方向', down ? '下行' : '上行', ''],
    ['卫星视角', null, null],
    ['仰角', f(r.elevation, 2), '°'],
    ['方位角', r.azimuth != null ? f(r.azimuth, 2) : '—', r.azimuth != null ? '°' : ''],
    ['星地斜距', r.slantRange != null ? f(r.slantRange, 2) : '—', r.slantRange != null ? 'km' : ''],
    ['降雨高度 hR', f(r.rainHeight, 3), 'km'],
    ['传播结果', null, null],
    ['气体吸收 (P.676)', f(r.gasAtten, 2), 'dB'],
    ['对流层闪烁', f(r.scintillation, 2), 'dB'],
    ['云衰减 (P.840-9)', f(r.cloudAtten, 2), 'dB'],
    ['雨衰 (P.618-14)', f(r.rainAtten, 2), 'dB'],
    ['合计衰减（气体+云+雨）', f(r.totalAtten, 2), 'dB'],
    ['降雨噪声致 G/T 衰减', down ? f(r.gtDegradation, 2) : '—', down ? 'dB' : ''],
    ['下行链路劣化 DND', down ? f(r.dnd, 2) : '—', down ? 'dB' : ''],
    ['雨致去极化 XPD', f(r.rainXPD, 2), 'dB'],
    ['年不可用时长', f(r.downtimeYear, 2), 'h'],
    ['最坏月可用度', f(r.worstMonthAvail, 3), '%'],
    ['最坏月不可用时长', f(r.downtimeWorstMonth, 2), 'h']
  ]
}
async function buildRainAttenuationExcel(payload) {
  const { direction = 'down', rainModel = 'auto', orbitMode = 'geo', rows = [], results = [] } = payload || {}
  const down = direction !== 'up'
  const wb = new ExcelJS.Workbook()
  wb.creator = '卫星仿真平台'; wb.created = new Date()

  // —— Sheet 1：批量结果（每行一个算例）——
  const ws = wb.addWorksheet('雨衰批量结果', { views: [{ showGridLines: false, state: 'frozen', ySplit: 4, xSplit: 1 }] })
  const round2 = (v) => (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v * 100) / 100 : v
  const cols = [
    { k: 'stationName', h: '地球站', w: 14, text: true },
    { k: 'latitude', h: '纬度(°)', w: 10 },
    { k: 'longitude', h: '经度(°)', w: 10 },
    { k: 'altitude', h: '海拔(m)', w: 9 },
    { k: '_elev', h: '仰角(°)', w: 9 },
    { k: '_satLon', h: 'GEO轨位(°E)', w: 12 },
    { k: 'frequency', h: '频率(GHz)', w: 10 },
    { k: 'polarization', h: '极化', w: 7, text: true },
    { k: '_rain', h: 'R0.01(mm/h)', w: 12 },
    { k: 'availability', h: '可用度(%)', w: 10 },
    { k: 'systemNoiseTemp', h: '系统噪温(K)', w: 11 },
    { k: 'gasAtten', h: '气体(dB)', w: 9, res: true },
    { k: 'cloudAtten', h: '云衰(dB)', w: 9, res: true },
    { k: 'rainAtten', h: '雨衰(dB)', w: 9, res: true },
    { k: 'totalAtten', h: '合计(dB)', w: 9, res: true },
    { k: 'gtDegradation', h: 'G/T衰减(dB)', w: 11, res: true, dl: true },
    { k: 'rainXPD', h: '雨致XPD(dB)', w: 11, res: true },
    { k: 'downtimeYear', h: '年停时(h)', w: 10, res: true },
    { k: 'downtimeWorstMonth', h: '最坏月停时(h)', w: 13, res: true }
  ]
  const ncol = cols.length
  ws.mergeCells(1, 1, 1, ncol)
  const tt = ws.getCell(1, 1); tt.value = '雨衰计算结果'; tt.font = { name: CJK, size: 15, bold: true }; tt.alignment = { horizontal: 'center' }
  ws.mergeCells(2, 1, 2, ncol)
  const st = ws.getCell(2, 1)
  st.value = `轨道：${orbitMode === 'ngso' ? 'NGSO（仰角输入）' : 'GEO（轨位算仰角）'}　·　链路方向：${down ? '下行' : '上行'}　·　降雨模型：${rainModel === 'auto' ? 'ITU-R P.837 自动' : '手动'}　·　共 ${rows.length} 个算例`
  st.font = { name: CJK, size: 10, color: { argb: 'FF666666' } }; st.alignment = { horizontal: 'center' }
  const hr = 4
  cols.forEach((c, i) => {
    const cell = ws.getCell(hr, i + 1)
    cell.value = c.h; cell.font = { name: CJK, size: 10, bold: true }
    cell.alignment = { horizontal: 'center', wrapText: true }
    ws.getColumn(i + 1).width = c.w
  })
  setRowBorder(ws, hr, 1, ncol, { top: MED, bottom: THIN })
  rows.forEach((row, ri) => {
    const r = results[ri] || {}
    const rowNo = hr + 1 + ri
    cols.forEach((c, ci) => {
      const cell = ws.getCell(rowNo, ci + 1)
      let v
      if (c.res) { v = r.error ? '✕' : round2(r[c.k]); if (c.dl && !down) v = '—' }
      else if (c.k === '_elev') v = (r.elevation != null ? round2(r.elevation) : row.elevation)
      else if (c.k === '_satLon') v = (r.satLon != null ? r.satLon : '—')   // NGSO / 纯仰角：无 GEO 轨位
      else if (c.k === '_rain') v = (r.rainRate != null ? round2(r.rainRate) : row.rainRate)
      else v = row[c.k]
      cell.value = c.text ? (v == null ? '' : v) : numOrText(v)
      cell.font = { name: c.text ? CJK : FNT, size: 10 }
      cell.alignment = { horizontal: c.text ? 'left' : 'right' }
    })
  })
  if (rows.length) setRowBorder(ws, hr + rows.length, 1, ncol, { bottom: MED })

  // —— 每算例详情 sheet（SatMaster 三段版式）——
  const used = {}
  rows.forEach((row, ri) => {
    const r = results[ri]; if (!r || r.error) return
    const base = String(row.stationName || ('算例' + (ri + 1))).replace(/[\\/?*[\]:]/g, ' ').slice(0, 24)
    let name = ((ri + 1) + ' ' + base).slice(0, 31); let k = 2
    while (used[name]) { name = ((ri + 1) + ' ' + base).slice(0, 28) + '~' + k; k++ }
    used[name] = true
    const ds = wb.addWorksheet(name, { views: [{ showGridLines: false }] })
    ds.getColumn(1).width = 26; ds.getColumn(2).width = 18; ds.getColumn(3).width = 8
    ds.mergeCells(1, 1, 1, 3)
    const dt = ds.getCell(1, 1)
    dt.value = '雨衰详细计算结果 · ' + (row.stationName || ('算例' + (ri + 1)))
    dt.font = { name: CJK, size: 13, bold: true }; dt.alignment = { horizontal: 'left' }
    let rn = 3
    for (const [label, value, unit] of rainDetailRows(r, row, down)) {
      if (value === null && unit === null) {
        ds.mergeCells(rn, 1, rn, 3)
        const c = ds.getCell(rn, 1); c.value = label; c.font = { name: CJK, size: 10, bold: true }
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }
        setRowBorder(ds, rn, 1, 3, { top: THIN, bottom: HAIR }); rn++; continue
      }
      const a = ds.getCell(rn, 1); a.value = label; a.font = { name: CJK, size: 10 }
      const b = ds.getCell(rn, 2); b.value = numOrText(value); b.font = { name: FNT, size: 10 }; b.alignment = { horizontal: 'right' }
      const u = ds.getCell(rn, 3); u.value = unit; u.font = { name: CJK, size: 9, color: { argb: 'FF888888' } }
      rn++
    }
    setRowBorder(ds, rn - 1, 1, 3, { bottom: MED })
    // 口径说明（避免读者把 DND 和合计衰减混起来）
    rn += 1
    ds.mergeCells(rn, 1, rn, 3)
    const nt = ds.getCell(rn, 1)
    nt.value = down
      ? 'DND = (雨衰+云衰) + 降雨噪声致 G/T 衰减。降雨噪声按 雨+云、T_mr=275 K、经馈线折算；气体不计入（晴空已含、不构成劣化），闪烁不计入（折射，不辐射噪声）。'
      : '上行不计降雨噪声：G/T 衰减与 DND 为下行专属。'
    nt.font = { name: CJK, size: 9, color: { argb: 'FF888888' } }
    nt.alignment = { wrapText: true, vertical: 'top' }
    ds.getRow(rn).height = 32
  })

  return wb.xlsx.writeBuffer()
}

module.exports = { buildWord, buildExcel, buildLinkBudgetExcel, buildSunOutageWord, buildRainAttenuationExcel, ROWS }
