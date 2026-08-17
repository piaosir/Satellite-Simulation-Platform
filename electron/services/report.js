// 报告生成服务（主进程，Node）。从链路结果生成 Word / Excel；返回 Buffer 由调用方写盘。
// 移植自小程序云函数（docx / exceljs）。PDF 因需内嵌中文字体，后续单独处理。
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, WidthType, AlignmentType, BorderStyle
} = require('docx')
const ExcelJS = require('exceljs')
const adaptiveUnits = require('../../packages/core/utils/adaptiveUnits.js')
// 列宽/行高自适应：各表的宽高常数按「常见内容」定，遇到长站名 / 长标签 / 英文导出会被截断，
// 故写盘前整本过一遍，只把装不下的列与行放大到刚好装下（只增不减，版式不变）。
const { autofitBook } = require('./reportAutofit')

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
    styles: WORD_STYLES,
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
  ws.getCell('A1').font = { name: FNT, size: 14, bold: true }
  ws.getCell('A2').value = `卫星 ${params.satelliteName || '—'} · 频段 ${params.frequencyBand || '—'} · ${new Date().toLocaleString()}`
  ws.addRow([])
  const head = ws.addRow(['环节', '数值', '单位'])
  head.font = { name: FNT, bold: true }
  ROWS.forEach(([label, key, unit]) => {
    const row = ws.addRow([label, val(results, key), unit])
    row.font = { name: FNT, bold: key === null }
  })
  ws.columns = [{ width: 30 }, { width: 16 }, { width: 12 }]
  autofitBook(wb)
  return applyBookFont(wb).xlsx.writeBuffer()
}

// ===== 链路预算工作台的表格件（供交付级报告复用）=====
// 这一段维护三样东西：链路汇总的指标矩阵（summaryRows / adaptSummaryUnits，横表与纵表都由它转置而来）、
// 瀑布段的三线表表体（writeSegmentBlocks，与屏幕「详细预算」同一份 segments），以及 NGSO / 再生式的
// 「几何关系」STK 版式表。报告的装配在文件末尾的 buildReportWorkbook。
// 标签中英文由 lang('zh'|'en') 控制；瀑布段的标签翻译在 packages/core 的 waterfallBuilder.js 的 WF_DICT
// （与结果区实时瀑布同源，避免两处译法不一致），此文件只维护汇总/几何表自己的列头译法。
// 导出文档字体（模板《技术文档标准模板.docx》口径，也是用户明确要求）：
// 西文与数字一律 Times New Roman；中文正文宋体、中文标题与题注黑体。
const FNT = 'Times New Roman'
const SONG = '宋体'          // 模板 docDefaults 的 eastAsia：中文正文与表内文字
const HEI = '黑体'           // 模板 标题 1–4 / 图号格式 / 表号格式：中文标题与题注
// CJK 是「这格是中文正文」的语义别名（本文件里用得极多，故保留旧名）
const CJK = SONG

// Word（docx）的字体分「西文 / 东亚」两栏，故分别指定：西文 Times New Roman、中文宋体。
// 正文默认样式 + 各级标题都要指（标题默认吃主题字体 Calibri Light，不覆盖会漏网）。
const WORD_RUN = { font: { ascii: FNT, hAnsi: FNT, cs: FNT, eastAsia: SONG } }
const WORD_STYLES = {
  default: {
    document: { run: WORD_RUN }, title: { run: WORD_RUN },
    heading1: { run: WORD_RUN }, heading2: { run: WORD_RUN }, heading3: { run: WORD_RUN },
    heading4: { run: WORD_RUN }, heading5: { run: WORD_RUN }, heading6: { run: WORD_RUN }
  }
}

// ★ xlsx 的 <font> 只有一个 name 字段（不像 docx 分 ascii / eastAsia 两栏），一个单元格因此
// 只能有一种字体。要「中文宋体 + 西文数字 Times New Roman」，唯一的办法是把这一格写成**富文本**
// （sharedStrings 里逐段带 rPr），于是下面这一支：写盘前整本过一遍，把中西混排的字符串按
// 「中文段 / 西文段」切开，两段各挂各的字体；纯中文或纯西文的格不拆，只把 name 归位。
//
// 各表写格时用 name 表明意图：'黑体' = 中文标题/题注、'宋体' = 中文正文、TNR = 纯西文或数字。
// 数字格（value 是 number）不能富文本，本来也只有数字，一律 TNR。
const CJK_CH = /[⺀-〾ぁ-㏿㐀-䶿一-鿿豈-﫿︰-﹏＀-￯]/
// 破折号 / 省略号 / 箭头：TNR 里没有 →↑↓ 的字形，按中文字体走才不至于让 Excel 自己去回落。
// 中点 · (U+00B7) 是中文的间隔号，跟着中文段走——不然「　·　」会被切成三段，
// 中间那个点用 TNR 出来又小又高，与两侧全角空格对不齐。
const CJK_SYM = /[—―…·←-⇿]/
const isCjkCh = (ch) => CJK_CH.test(ch) || CJK_SYM.test(ch)
const hasCjk = (s) => { for (const ch of s) if (isCjkCh(ch)) return true; return false }
const hasLatin = (s) => { for (const ch of s) if (!isCjkCh(ch) && !/\s/.test(ch)) return true; return false }

// 切成交替的中文段 / 西文段。半角空白是中性的——归进当前段，免得「上行 C/N」被切成三段。
// ★ 全角空格（U+3000）不算中性：它是中文标点，用 TNR 渲染会缩成半角宽，
//   「1　逐参数对照」这类标题的对齐就散了。它落进 CJK_CH，随中文段走。
const NEUTRAL_SP = /[ \t\r\n]/
function splitCjkRuns(text) {
  const out = []
  let cur = null
  for (const ch of String(text)) {
    if (cur && NEUTRAL_SP.test(ch)) { cur.text += ch; continue }
    const k = isCjkCh(ch)
    if (cur && cur.cjk === k) cur.text += ch
    else { cur = { cjk: k, text: ch }; out.push(cur) }
  }
  return out
}

// 一格的字体归位。返回 true 表示把 value 换成了富文本。
function fixCellFont(cell) {
  const f = Object.assign({}, cell.font)
  const v = cell.value
  // 已经是富文本（本文件不主动写，留给未来）：只补 name 缺省
  if (v && typeof v === 'object' && Array.isArray(v.richText)) return false
  const cjkFont = (f.name === HEI) ? HEI : SONG
  const text = (typeof v === 'string') ? v : null
  if (text === null) {
    // 数字 / 日期 / 公式：不能走富文本。数字本来就只有西文；公式（详情索引的跳转链接）
    // 按缓存结果里有没有汉字选一种——那一格的文字是工作表名，常常是中文站名。
    const res = (v && typeof v === 'object' && v.formula !== undefined && v.result != null) ? String(v.result) : ''
    cell.font = Object.assign(f, { name: hasCjk(res) ? cjkFont : FNT })
    return false
  }
  if (!hasCjk(text)) { cell.font = Object.assign(f, { name: FNT }); return false }
  if (!hasLatin(text)) { cell.font = Object.assign(f, { name: cjkFont }); return false }
  // 混排：拆富文本。cell.font 仍写中文那一档——它是这一格的「默认字体」，
  // 自适应算宽（reportAutofit）与用户导出后续打的字都按它走。
  cell.value = {
    richText: splitCjkRuns(text).map((seg) => ({
      font: Object.assign({}, f, { name: seg.cjk ? cjkFont : FNT }),
      text: seg.text
    }))
  }
  cell.font = Object.assign(f, { name: cjkFont })
  return true
}

// 整本归位 + 换掉工作簿主题字体（Excel「正文/标题」的来源，exceljs 硬写 Calibri/Cambria）：
// 空白格与用户导出后新键入的内容也跟着是 TNR + 宋体。主题那一段走 exceljs 内部模块，故 try 兜底，
// 失败只是默认字体没换，已写入的单元格字体不受影响。
function applyBookFont(wb) {
  try {
    const theme1 = require('exceljs/lib/xlsx/xml/theme1.js')
    // 注意：wb.model 的 getter 每次现造一个对象，改它的字段无效——主题存在 wb._themes 上（writer 由此取）
    wb._themes = {
      theme1: String(theme1)
        .replace(/<a:latin typeface="(Calibri|Cambria)"\/>/g, `<a:latin typeface="${FNT}"/>`)
        .replace(/<a:ea typeface=""\/>/g, `<a:ea typeface="${SONG}"/>`)
    }
  } catch (e) { /* exceljs 内部结构变了就跳过，不影响导出 */ }
  wb.eachSheet((ws) => {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => { fixCellFont(cell) })
    })
  })
  return wb
}
const MED = { style: 'medium', color: { argb: 'FF000000' } }
const THIN = { style: 'thin', color: { argb: 'FF000000' } }
const HAIR = { style: 'hair', color: { argb: 'FF999999' } }

// 中英文字符串表（链路汇总表头/标题等）。英文措辞对齐卫星通信工程报告的学术/行业惯用语，并与
// WF_DICT（瀑布详情表）的译法保持一致（如 Allocated Bandwidth / Link Margin / System Availability 等），
// 避免同一份工作簿里术语不统一。
const STR = {
  zh: {
    paRecW: '功放建议 (W)', paRecDbw: '功放建议 (dBW)', paActW: '功放实际输出 (W)',
    linkMargin: '链路余量 (dB)', allocBw: '载波带宽 (kHz)', powerBw: '功率带宽 (kHz)',
    bwUsage: '带宽占用 (%)', pwUsage: '功率占用 (%)',
    upCN: '上行 C/N (dB)', downCN: '下行 C/N (dB)', totalCN: '合计 C/N (dB)', thresholdCN: '门限 C/N (dB)',
    ebno: 'Eb/N₀ (dB)', esno: 'Es/N₀ (dB)', psd: '载波功率谱密度 (dBW/Hz)', avail: '系统可用度 (%)', availUp: '上行可用度 (%)',
    specEff: '频谱效率 (bps/Hz)', capacity: '容量 (Mbps)',
    calcFailed: '计算失败：',
    capHeader: (n, failed) => `容量汇总（${n} 条链路${failed ? ` · ${failed} 条失败已排除` : ''}）`,
    totalCap: '总容量', totalBw: '总带宽', totalPbw: '总功率带宽', avgEff: '平均频谱效率',
    param: '参数', uplink: '上行', downlink: '下行', total: '合计', value: '数值', unit: '单位',
    // 再生式各体制汇总表专属列头（上行/下行/星间微波/星间激光按信号流向裁剪，避免整列空白）
    satGtDn: '收信站 G/T (dB/K)', satEirpDn: '卫星下行 EIRP (dBW)', availDown: '下行可用度 (%)',
    islFreq: '星间频率 (GHz)', islDist: '星间距离 (km)', islTxEirp: '发射卫星 EIRP (dBW)',
    islRxGt: '接收卫星 G/T (dB/K)', islCN: '星间 C/N (dB)', islVis: '互视可见度 (%)', availSys: '系统可用度 (%)',
    laserDist: '星间距离 (km)', laserTxPower: '发射光功率 (dBm)', laserPrx: '接收光功率 (dBm)',
    laserPreq: '所需接收功率 (dBm)', laserDoppler: '相干多普勒 (GHz)', dataRate: '信息速率 (kbps)',
    // 端到端（第四窗）汇总列头：链是一串节点，指标按「构成 → 段结算 → 链级性能 → 时延」四段排
    e2eNodes: '节点数', e2eHops: '跳数', e2eSegs: '段数', e2eWeakest: '最弱段',
    e2eWeakCN: '最弱段 C/(N+I) (dB)', e2eMargin: '端到端余量 (dB)', e2eBer: '端到端 BER',
    e2eOutage: '年中断 (min)', e2ePropDelay: '传播时延 (ms)', e2eProcDelay: '处理时延 (ms)', e2eDelay: '端到端时延 (ms)',
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
    paRecW: 'Recommended PA Power (W)', paRecDbw: 'Recommended PA Power (dBW)', paActW: 'Actual PA Output (W)',
    linkMargin: 'Link Margin (dB)', allocBw: 'Allocated Bandwidth (kHz)', powerBw: 'Power Bandwidth (kHz)',
    bwUsage: 'Bandwidth Usage Ratio (%)', pwUsage: 'Power Usage Ratio (%)',
    upCN: 'Uplink C/N (dB)', downCN: 'Downlink C/N (dB)', totalCN: 'Combined C/N (dB)', thresholdCN: 'Threshold C/N (dB)',
    ebno: 'Eb/N₀ (dB)', esno: 'Es/N₀ (dB)', psd: 'Satellite PSD (dBW/Hz)', avail: 'System Availability (%)', availUp: 'Uplink Availability (%)',
    specEff: 'Spectral Efficiency (bps/Hz)', capacity: 'Capacity (Mbps)',
    calcFailed: 'Calculation Failed: ',
    capHeader: (n, failed) => `Capacity Summary (${n} link${n > 1 ? 's' : ''}${failed ? `, ${failed} failed excluded` : ''})`,
    totalCap: 'Total Capacity', totalBw: 'Total Bandwidth', totalPbw: 'Total Power Bandwidth', avgEff: 'Average Spectral Efficiency',
    param: 'Parameter', uplink: 'Uplink', downlink: 'Downlink', total: 'Total', value: 'Value', unit: 'Unit',
    // Per-scheme regenerative summary column heads (trimmed by signal flow to avoid all-blank columns)
    satGtDn: 'Rx Station G/T (dB/K)', satEirpDn: 'Sat Downlink EIRP (dBW)', availDown: 'Downlink Availability (%)',
    islFreq: 'ISL Frequency (GHz)', islDist: 'Inter-Sat Range (km)', islTxEirp: 'Tx Sat EIRP (dBW)',
    islRxGt: 'Rx Sat G/T (dB/K)', islCN: 'ISL C/N (dB)', islVis: 'Mutual Visibility (%)', availSys: 'System Availability (%)',
    laserDist: 'Inter-Sat Range (km)', laserTxPower: 'Tx Optical Power (dBm)', laserPrx: 'Rx Optical Power (dBm)',
    laserPreq: 'Required Rx Power (dBm)', laserDoppler: 'Coherent Doppler (GHz)', dataRate: 'Information Rate (kbps)',
    // End-to-end (fourth workbench) summary column heads
    e2eNodes: 'Nodes', e2eHops: 'Hops', e2eSegs: 'Segments', e2eWeakest: 'Weakest Segment',
    e2eWeakCN: 'Weakest-Segment C/(N+I) (dB)', e2eMargin: 'End-to-End Margin (dB)', e2eBer: 'End-to-End BER',
    e2eOutage: 'Annual Outage (min)', e2ePropDelay: 'Propagation Delay (ms)', e2eProcDelay: 'Processing Delay (ms)', e2eDelay: 'End-to-End Delay (ms)',
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
    R(t.availDown, 'systemAvailabilityResult')
  ]
  if (regenMode === 'isl') return [
    R(t.islFreq, 'islRfFreqResult'), R(t.islDist, 'islRfDistResult'),
    R(t.islTxEirp, 'islRfEirpResult'), R(t.islRxGt, 'islRfGtResult'),
    R(t.linkMargin, 'linkmargin'), R(t.allocBw, 'allocBandwidthResult'),
    R(t.specEff, 'spectralEfficiencyResult'), { label: t.capacity, get: capMbpsCell },
    R(t.islCN, 'carrierTotalCN'), R(t.thresholdCN, 'thresholdCN'),
    R(t.ebno, 'ebnoActualResult'), R(t.esno, 'esnoActualResult'),
    R(t.islVis, 'islVisibleFracResult'), R(t.availSys, 'systemAvailabilityResult')
  ]
  if (regenMode === 'laser') return [
    R(t.laserDist, 'laserDistResult'), R(t.laserTxPower, 'laserTxPowerResult'),
    R(t.laserPrx, 'laserPrxResult'), R(t.laserPreq, 'laserPreqResult'),
    R(t.linkMargin, 'linkmargin'), R(t.laserDoppler, 'laserDopplerResult'),
    R(t.islVis, 'islVisibleFracResult'), R(t.availSys, 'systemAvailabilityResult')
  ]
  // 默认：再生式上行
  return [
    R(t.paRecW, 'paRecommendation'), R(t.paRecDbw, 'paRecommendationdBResult'),
    R(t.paActW, 'selectedPowerWResult'), R(t.linkMargin, 'linkmargin'),
    R(t.allocBw, 'allocBandwidthResult'), R(t.specEff, 'spectralEfficiencyResult'),
    { label: t.capacity, get: capMbpsCell },
    R(t.upCN, 'carrierTotalCN'), R(t.thresholdCN, 'thresholdCN'),
    R(t.ebno, 'ebnoActualResult'), R(t.esno, 'esnoActualResult'),
    R(t.psd, 'stationPSDResult'), R(t.availUp, 'systemAvailabilityResult')
  ]
}

// 端到端（第四窗）的汇总参数行。一条链是一串节点，没有「上行/下行」两侧可列，故整套另开：
// 构成（节点/跳/段）→ 载波（速率/带宽/效率）→ 段结算（最弱段与其 C/(N+I)、门限、余量）→
// 链级性能（可用度、年中断、端到端 BER）→ 时延（传播 / 处理 / 合计）。
// ★ 不列「功率占用 / 带宽占用 / 功放建议」：占比是某一颗透明星的资源账，链上有几颗星就有几份，
//   取其一或取最大都是编出来的链级指标（见 linkChain.js 出参处的同一条注记）；功放建议属于反算，
//   端到端只有正向递推。逐颗星的占用在详情表的「透明转发器占用」段里各归各位。
function e2eSummaryRows(t) {
  const R = (label, key) => ({ label, get: (l) => val(l.data, key) })
  return [
    R(t.e2eNodes, 'nodeCount'), R(t.e2eHops, 'hopCount'), R(t.e2eSegs, 'segmentCount'),
    R(t.dataRate, 'infoRateResult'), R(t.allocBw, 'allocBandwidthResult'), R(t.specEff, 'spectralEfficiencyResult'),
    R(t.e2eWeakest, 'weakestSegment'), R(t.e2eWeakCN, 'carrierTotalCN'), R(t.thresholdCN, 'thresholdCN'),
    R(t.e2eMargin, 'e2eMarginResult'),
    R(t.avail, 'systemAvailabilityResult'), R(t.e2eOutage, 'interruptionMinutes'), R(t.e2eBer, 'e2eBerResult'),
    R(t.e2ePropDelay, 'propDelayResult'), R(t.e2eProcDelay, 'procDelayResult'), R(t.e2eDelay, 'e2eDelayResult')
  ]
}

// 链路汇总的"参数行"：矩阵显示全部指标 ∪ 结果卡片全部字段。每行一个参数，纵向排列——
// 这样每条链路占一整列，从上往下读完一列就是这条链路的完整结果，跟下面单链路详细计算结果表
// （参数纵向列在左、数值在右）是同一种阅读方式，多条链路时天然变成左右并排的对比表。
function summaryRows(t, orbitType, regenMode) {
  // 端到端：链级指标另成一套（见 e2eSummaryRows）
  if (orbitType === 'E2E') return e2eSummaryRows(t)
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
    { label: availLabel, get: (l) => val(l.data, 'systemAvailabilityResult') }
  ]
}
// 汇总表显示单位自适应（与 UI 结果列同规则）：从行标签尾部 '(单位)' 识别可缩放量，
// 每个指标行跨全部链路共选一个档位（W→mW、kHz→MHz/GHz、整行<0dBW→dBm），
// 重写标签单位并包裹取值函数（数值换算、'—'/文本原样）
function adaptSummaryUnits(rows, links) {
  for (const row of rows) {
    if (row.text) continue
    const m = /^(.*)\((\S+)\)\s*$/.exec(row.label || '')
    if (!m) continue
    const p = adaptiveUnits.pickColumn(links.map((l) => parseFloat(row.get(l))), m[2])
    if (!p) continue
    const g = row.get
    row.get = (l) => { const v = g(l); const n = parseFloat(v); return isFinite(n) ? Number(adaptiveUnits.fmtScaled(p.conv(n))) : v }
    row.label = m[1] + '(' + p.unit + ')'
  }
}

// 瀑布段渲染辅助（与小程序 exportLinkBudget 同口径：黑白三线表）
const valueHeaders = (cols, t) => (cols >= 3 ? [t.uplink, t.downlink, t.total] : cols >= 2 ? [t.uplink, t.downlink] : [t.value])
const rowValues = (row, cols) => (cols >= 3 ? [row.up || '', row.down || '', row.total || ''] : cols >= 2 ? [row.up || '', row.down || ''] : [row.up || ''])
// 机读数值（waterfallBuilder 在行上挂的 num/numDown/numTotal，严格解析、语言无关）：
// 有值就直接写数值单元格，免得再去 Number() 反解已格式化的显示串。null＝这一格不是纯数值
// （'QPSK'、'3/4'、'1×10⁻⁷' 一类），退回 numOrText 走原来的文本/数值判定。
const rowNums = (row, cols) => (cols >= 3 ? [row.num, row.numDown, row.numTotal] : cols >= 2 ? [row.num, row.numDown] : [row.num])
// 段题注：core 编好的章节号（§1…§n）随段带出，屏幕「详细预算」区与本表同号同序，
// 交叉核对时说「§5 第二行」两边都能对上。旧记录/未编号的构建器没有 no，退回纯标题。
const segCaption = (seg) => (seg && seg.no ? '§' + seg.no + '  ' + (seg.title || '') : (seg && seg.title) || '')
const labelWithSign = (row) => (row.sign ? row.sign + ' ' : '') + (row.label || '')

// 瀑布段落的表体（题注 + 三线表），从第 r 行起写，返回写完后的下一行。
// 抽成独立一支供两处调用：旧版「详细计算结果」分表与新版报告的链路详情表——
// 两处画出来的必须是同一种表，否则同一份数据在两个文件里长得不一样。
// opts.fixedDecimals：按显示串的小数位给数字格式。数值单元格写的是【数】（要能在 Excel 里继续算），
// 而 Excel 的 General 会把 3.50 印成 3.5、0.00 印成 0 —— 端到端级联刻意把每一格钉成两位小数
// （单列密排，小数点要排成列，见 waterfallBuilder 的同一条注记），General 一印就把这条对齐拆了。
// ★ 只在端到端打开：三窗的显示串由 _fmt 去过尾零，本来就与 General 印出来的一样，
//   多这一句只会平白改动它们的输出，故整条挂在开关后面（默认关＝三窗逐字节不变）。
function writeSegmentBlocks(ws, segments, t, startRow, opts) {
  const fixedDecimals = !!(opts && opts.fixedDecimals)
  let r = startRow
  for (const seg of (segments || [])) {
    if (!seg || !seg.rows || !seg.rows.length) continue
    const cols = seg.cols || 1
    const vh = valueHeaders(cols, t)
    const totalCols = 2 + vh.length
    // 段题注：模板 表号格式（黑体 10.5pt 居中，在表上方）
    ws.mergeCells(r, 1, r, totalCols)
    const cap = ws.getCell(r, 1); cap.value = segCaption(seg)
    cap.font = { name: HEI, size: RSTY.size.caption }; cap.alignment = { horizontal: 'center', vertical: 'middle' }; ws.getRow(r).height = 24; r++
    // 表头（三线表：不加粗、不加底纹，中文黑体、居中）
    const headerTexts = [t.param, ...vh, t.unit]
    headerTexts.forEach((h, i) => {
      const cell = ws.getCell(r, i + 1); cell.value = h
      cell.font = { name: HEI, size: RSTY.size.table }
      cell.alignment = { horizontal: 'center', vertical: 'middle' }
    })
    setRowBorder(ws, r, 1, totalCols, { top: MED, bottom: THIN }); ws.getRow(r).height = 20; r++
    // 数据行
    const dataRows = seg.rows
    dataRows.forEach((row, ri) => {
      const isLast = ri === dataRows.length - 1
      const vals = rowValues(row, cols)
      const nums = rowNums(row, cols)
      // 端到端级联的两级分组行（kind head=段 / shead=跳·透明转发·收发站）：整行只有标签，
      // 数值列恒空。三线表不许底纹，故与本文件其它分组行（参考文献的类别行）同一手法——中文换黑体
      // 不加粗（黑体已是重字面，再加粗会被合成成假粗体糊成一团）；段标题上方另切一条栏目线。
      // ★ 不认识的 kind 一律走普通行分支照常写出，一行都不许丢。
      const isGroup = row.kind === 'head' || row.kind === 'shead'
      const strong = ['base', 'sub', 'chk', 'kpi', 'margin'].indexOf(row.kind) > -1
      const lc = ws.getCell(r, 1); lc.value = labelWithSign(row)
      lc.font = { name: isGroup ? HEI : CJK, size: RSTY.size.table, bold: strong, color: { argb: 'FF1A1A1A' } }
      lc.alignment = { horizontal: 'left', vertical: 'middle' }
      vals.forEach((v, vi) => {
        const isTotalCol = cols >= 3 && vi === 2
        const cell = ws.getCell(r, 2 + vi)
        const n = nums[vi]
        cell.value = (n === null || n === undefined) ? numOrText(v) : n
        if (fixedDecimals && typeof cell.value === 'number') {
          const dec = (String(v == null ? '' : v).split('.')[1] || '').length
          if (dec > 0 && dec <= 6) cell.numFmt = '0.' + '0'.repeat(dec)
        }
        cell.font = { name: FNT, size: RSTY.size.table, bold: strong || isTotalCol }; cell.alignment = { horizontal: 'right', vertical: 'middle' }
      })
      const uc = ws.getCell(r, totalCols); uc.value = row.unit || ''
      uc.font = { name: FNT, size: RSTY.size.table, color: { argb: 'FF555555' } }; uc.alignment = { horizontal: 'left', vertical: 'middle' }
      const edges = {}
      // 段标题行（head）上方 0.75pt 栏目线——它是表内最强的一层分组；跳标题（shead）只换字体不画线，
      // 十来跳各画一条会把表切成一堆横带。首行不画（表头下沿已有一条）。
      if (row.kind === 'head') { if (ri > 0) edges.top = THIN } else if (['sub', 'margin'].indexOf(row.kind) > -1) edges.top = HAIR
      if (isLast) edges.bottom = MED
      if (edges.top || edges.bottom) setRowBorder(ws, r, 1, totalCols, edges)
      ws.getRow(r).height = 18
      r++
    })
    r++
  }
  return r
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
    cell.font = { name: FNT, size: RSTY.size.table, bold: !!bold }; cell.alignment = { horizontal: 'right', vertical: 'middle' }
  }
  const str = (rr, c, text, align, o) => {
    o = o || {}; const cell = ws.getCell(rr, c)
    cell.value = text == null ? '' : text
    cell.font = { name: o.font || (o.hei ? HEI : CJK), size: o.size || RSTY.size.table, bold: !!o.bold, color: o.color ? { argb: o.color } : undefined }
    cell.alignment = { horizontal: align || 'left', vertical: 'middle', wrapText: !!o.wrap }
  }
  const section = (text, span) => {
    ws.mergeCells(r, 1, r, span); const cell = ws.getCell(r, 1)
    cell.value = text; cell.font = { name: HEI, size: RSTY.size.h1 }; cell.alignment = { horizontal: 'left', vertical: 'middle' }
    ws.getRow(r).height = 24; r++
  }
  const thead = (labels) => {
    labels.forEach((lb, i) => str(r, i + 1, lb, 'center', { hei: true, size: RSTY.size.tableDense, wrap: true }))
    setRowBorder(ws, r, 1, labels.length, { top: MED, bottom: THIN }); ws.getRow(r).height = 30; r++
  }
  const kv = (label, value, unit, valFont) => {
    ws.mergeCells(r, 1, r, 2); str(r, 1, label, 'left', {})
    ws.mergeCells(r, 3, r, 5); str(r, 3, value, 'left', { font: valFont || FNT })
    str(r, 6, unit || '', 'left', { font: FNT, color: 'FF555555' })
    ws.getRow(r).height = 18; r++
  }
  const kvNum = (label, v, dp, unit) => {
    ws.mergeCells(r, 1, r, 2); str(r, 1, label, 'left', {})
    ws.mergeCells(r, 3, r, 5); num(r, 3, v, dp)
    str(r, 6, unit || '', 'left', { font: FNT, color: 'FF555555' })
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
  tc.font = { name: HEI, size: RSTY.size.docTitle }; tc.alignment = { horizontal: 'center', vertical: 'middle' }; ws.getRow(r).height = 28; r++
  ws.mergeCells(r, 1, r, NCOL)
  const sc = ws.getCell(r, 1)
  sc.value = g.subtitle(params.satelliteName || '—', params.frequencyBand || '—', propName, new Date().toLocaleString())
  sc.font = { name: CJK, size: RSTY.size.table, color: { argb: 'FF666666' } }; sc.alignment = { horizontal: 'center', vertical: 'middle' }; ws.getRow(r).height = 18; r++
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
      str(r, 1, String(idx + 1), 'center', { font: FNT, size: RSTY.size.table })
      str(r, 2, l.coord, 'center', { font: FNT, size: RSTY.size.table })
      str(r, 3, `${l.txName || ''} → ${l.rxName || ''}`, 'left', { size: RSTY.size.table, wrap: true })
      str(r, 4, utcg(w.startISO), 'center', { font: FNT, size: RSTY.size.tableDense, wrap: true })
      str(r, 5, utcg(w.endISO) + (w.clipped ? g.accClip : ''), 'center', { font: FNT, size: RSTY.size.tableDense, wrap: true })
      num(r, 6, w.durationMin, 2)
      str(r, 7, utcg(s.typicalISO), 'center', { font: FNT, size: RSTY.size.tableDense, wrap: true })
      ws.getRow(r).height = 26; r++
    })
    setRowBorder(ws, r - 1, 1, 7, { bottom: MED })
  } else if (feasLinks.length) {
    ws.mergeCells(r, 1, r, NCOL); str(r, 1, g.accNA, 'left', { size: RSTY.size.table, color: 'FF666666', wrap: true }); ws.getRow(r).height = 20; r++
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
        str(r, 1, ri === 0 ? l.coord : '', 'center', { font: FNT, size: RSTY.size.table })
        str(r, 2, d.dir, 'center', { size: RSTY.size.tableDense, color: 'FF1A1A1A' })
        str(r, 3, d.geo.name || d.name || '', 'left', { size: RSTY.size.table, wrap: true })
        num(r, 4, d.geo.lat, 4); num(r, 5, d.geo.lon, 4); num(r, 6, d.geo.minEl, 2)
        num(r, 7, d.side.elevDeg, 2); num(r, 8, d.side.slantKm, 2); num(r, 9, d.side.altKm, 1)
        num(r, 10, d.side.coverageHalfAngleDeg, 3); num(r, 11, d.side.coverageRadiusKm, 1)
        if (d.side.maxPassMin == null) str(r, 12, g.resident, 'right', { font: FNT, size: RSTY.size.tableDense, color: 'FF888888' })
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
      str(r, 1, l.coord, 'center', { font: FNT, size: RSTY.size.table })
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
    str(r, 1, g.accLink, 'center', { bold: true, size: RSTY.size.tableDense })
    ws.mergeCells(r, 2, r, 3); str(r, 2, g.accPair, 'left', { bold: true, size: RSTY.size.tableDense })
    ws.mergeCells(r, 4, r, NCOL); str(r, 4, g.infeasReason, 'left', { bold: true, size: RSTY.size.tableDense })
    setRowBorder(ws, r, 1, NCOL, { top: MED, bottom: THIN }); ws.getRow(r).height = 20; r++
    infeas.forEach((l) => {
      str(r, 1, l.coord, 'center', { font: FNT, size: RSTY.size.table })
      ws.mergeCells(r, 2, r, 3); str(r, 2, `${l.txName || ''} → ${l.rxName || ''}`, 'left', { size: RSTY.size.table, wrap: true })
      ws.mergeCells(r, 4, r, NCOL); str(r, 4, l.geom.reason || '—', 'left', { size: RSTY.size.table, color: 'FF666666', wrap: true })
      ws.getRow(r).height = 20; r++
    })
    setRowBorder(ws, r - 1, 1, NCOL, { bottom: MED })
    r++
  }

  // —— 方法学脚注 ——
  ws.mergeCells(r, 1, r, NCOL)
  const fc = ws.getCell(r, 1); fc.value = g.foot
  fc.font = { name: CJK, size: RSTY.size.tableDense, color: { argb: 'FF999999' } }; fc.alignment = { horizontal: 'left', vertical: 'top', wrapText: true }
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
    cell.font = { name: FNT, size: RSTY.size.table, bold: !!bold }; cell.alignment = { horizontal: 'right', vertical: 'middle' }
  }
  w.str = (c, text, align, o) => {
    o = o || {}; const cell = ws.getCell(w.r, c)
    cell.value = text == null ? '' : text
    cell.font = { name: o.font || (o.hei ? HEI : CJK), size: o.size || RSTY.size.table, bold: !!o.bold, color: o.color ? { argb: o.color } : undefined }
    cell.alignment = { horizontal: align || 'left', vertical: 'middle', wrapText: !!o.wrap }
  }
  w.section = (text, span) => {
    ws.mergeCells(w.r, 1, w.r, span || ncol); const cell = ws.getCell(w.r, 1)
    cell.value = text; cell.font = { name: HEI, size: RSTY.size.h1 }; cell.alignment = { horizontal: 'left', vertical: 'middle' }
    ws.getRow(w.r).height = 24; w.r++
  }
  w.thead = (labels) => {
    labels.forEach((lb, i) => w.str(i + 1, lb, 'center', { hei: true, size: RSTY.size.tableDense, wrap: true }))
    setRowBorder(ws, w.r, 1, labels.length, { top: MED, bottom: THIN }); ws.getRow(w.r).height = 30; w.r++
  }
  w.kv = (label, value, unit, valFont) => {
    ws.mergeCells(w.r, 1, w.r, 2); w.str(1, label, 'left', {})
    ws.mergeCells(w.r, 3, w.r, 5); w.str(3, value, 'left', { font: valFont || FNT })
    w.str(6, unit || '', 'left', { font: FNT, color: 'FF555555' })
    ws.getRow(w.r).height = 18; w.r++
  }
  w.kvNum = (label, v, dp, unit) => {
    ws.mergeCells(w.r, 1, w.r, 2); w.str(1, label, 'left', {})
    ws.mergeCells(w.r, 3, w.r, 5); w.num(3, v, dp)
    w.str(6, unit || '', 'left', { font: FNT, color: 'FF555555' })
    ws.getRow(w.r).height = 18; w.r++
  }
  w.title = (title, subtitle) => {
    ws.mergeCells(w.r, 1, w.r, ncol)
    const tc = ws.getCell(w.r, 1); tc.value = title
    tc.font = { name: HEI, size: RSTY.size.docTitle }; tc.alignment = { horizontal: 'center', vertical: 'middle' }; ws.getRow(w.r).height = 28; w.r++
    ws.mergeCells(w.r, 1, w.r, ncol)
    const sc = ws.getCell(w.r, 1); sc.value = subtitle
    sc.font = { name: CJK, size: RSTY.size.table, color: { argb: 'FF666666' } }; sc.alignment = { horizontal: 'center', vertical: 'middle' }; ws.getRow(w.r).height = 18; w.r++
    w.r++
  }
  w.foot = (text) => {
    ws.mergeCells(w.r, 1, w.r, ncol)
    const fc = ws.getCell(w.r, 1); fc.value = text
    fc.font = { name: CJK, size: RSTY.size.caption, color: { argb: 'FF999999' } }; fc.alignment = { horizontal: 'left', vertical: 'top', wrapText: true }
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
      W.str(1, it.name, 'left', { size: RSTY.size.table, wrap: true })
      W.num(2, el.a, 3); W.num(3, el.e, 6); W.num(4, el.iDeg, 4); W.num(5, el.raanDeg, 4)
      W.num(6, el.periodMin, 3); W.num(7, el.perigeeAltKm, 1); W.num(8, el.apogeeAltKm, 1)
      W.str(9, el.satnum == null ? '—' : String(el.satnum), 'right', { font: FNT, size: RSTY.size.table })
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
        W.str(1, String(n), 'center', { font: FNT, size: RSTY.size.table })
        W.str(2, '#' + l._no, 'center', { font: FNT, size: RSTY.size.table })
        W.str(3, (l.staGeo && l.staGeo.name) || l.satName || '', 'left', { size: RSTY.size.table, wrap: true })
        W.str(4, utcg(wd.startISO), 'center', { font: FNT, size: RSTY.size.tableDense, wrap: true })
        W.str(5, utcg(wd.endISO) + (wd.clipped ? g.accClip : ''), 'center', { font: FNT, size: RSTY.size.tableDense, wrap: true })
        W.num(6, wd.durationMin, 2); W.num(7, wd.peakElevDeg, 2); W.num(8, wd.peakSlantKm, 1)
        W.str(9, utcg(wd.peakISO), 'center', { font: FNT, size: RSTY.size.tableDense, wrap: true })
        ws.getRow(W.r).height = 26; W.r++
      })
    })
    W.rowEnd(9)
  } else if (feas.length) {
    ws.mergeCells(W.r, 1, W.r, NCOL); W.str(1, rg.accNAg, 'left', { size: RSTY.size.table, color: 'FF666666', wrap: true }); ws.getRow(W.r).height = 20; W.r++
  }
  W.gap()

  // 站星几何（最差工况：斜距 / 仰角 / 覆盖）
  if (feas.length) {
    W.section(rg.aerHead, NCOL)
    W.thead([g.aerLink, rg.station, g.aerLat, g.aerLon, g.aerMinEl, g.aerEl, g.aerRange, g.aerSatAlt, g.aerHalf, g.aerCovR, g.aerPass])
    feas.forEach((l, li) => {
      const side = (l.geom.worst && l.geom.worst[sideKey]) || {}
      const sta = l.staGeo || {}
      W.str(1, '#' + l._no, 'center', { font: FNT, size: RSTY.size.table })
      W.str(2, sta.name || l.satName || '', 'left', { size: RSTY.size.table, wrap: true })
      W.num(3, sta.lat, 4); W.num(4, sta.lon, 4); W.num(5, sta.minEl, 2)
      W.num(6, side.elevDeg, 2); W.num(7, side.slantKm, 2); W.num(8, side.altKm, 1)
      W.num(9, side.coverageHalfAngleDeg, 3); W.num(10, side.coverageRadiusKm, 1)
      if (side.maxPassMin == null) W.str(11, g.resident, 'right', { font: FNT, size: RSTY.size.tableDense, color: 'FF888888' })
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
      W.str(1, '#' + l._no, 'center', { font: FNT, size: RSTY.size.table })
      W.str(2, l.satName || params.satelliteName || '', 'left', { size: RSTY.size.table, wrap: true })
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
    W.str(1, g.accLink, 'center', { bold: true, size: RSTY.size.tableDense })
    ws.mergeCells(W.r, 2, W.r, 3); W.str(2, rg.station, 'left', { bold: true, size: RSTY.size.tableDense })
    ws.mergeCells(W.r, 4, W.r, NCOL); W.str(4, g.infeasReason, 'left', { bold: true, size: RSTY.size.tableDense })
    setRowBorder(ws, W.r, 1, NCOL, { top: MED, bottom: THIN }); ws.getRow(W.r).height = 20; W.r++
    infeas.forEach((l, li) => {
      W.str(1, '#' + l._no, 'center', { font: FNT, size: RSTY.size.table })
      ws.mergeCells(W.r, 2, W.r, 3); W.str(2, (l.staGeo && l.staGeo.name) || l.satName || '', 'left', { size: RSTY.size.table, wrap: true })
      ws.mergeCells(W.r, 4, W.r, NCOL); W.str(4, (l.geom && l.geom.reason) || '—', 'left', { size: RSTY.size.table, color: 'FF666666', wrap: true })
      ws.getRow(W.r).height = 20; W.r++
    })
    W.rowEnd(NCOL); W.gap()
  }

  W.foot(rg.footGround)
}

// —— 空间—空间几何（再生式星间微波 / 激光）——每链路两星（发射星→接收星）互视最差工况。
function buildRegenSpaceGeometrySheet(wb, links, params, meta, lang, isLaser) {
  if (!links || !links.length) return
  // 手动几何：星间距离由用户逐条给定，压根没有解算出来的几何 —— 整张表不出，不留空表头
  if (!links.some((l) => l.islGeo)) return
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
      W.str(1, ri === 0 ? '#' + l._no : '', 'center', { font: FNT, size: RSTY.size.table })
      W.str(2, en.tag, 'center', { size: RSTY.size.tableDense, color: 'FF1A1A1A' })
      W.str(3, en.name || '', 'left', { size: RSTY.size.table, wrap: true })
      W.num(4, el.a, 3); W.num(5, el.e, 6); W.num(6, el.iDeg, 4); W.num(7, el.raanDeg, 4)
      W.num(8, el.periodMin, 3); W.num(9, el.perigeeAltKm, 1); W.num(10, el.apogeeAltKm, 1)
      W.str(11, el.satnum == null ? '—' : String(el.satnum), 'right', { font: FNT, size: RSTY.size.table })
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
        W.str(1, String(n), 'center', { font: FNT, size: RSTY.size.table })
        W.str(2, '#' + l._no, 'center', { font: FNT, size: RSTY.size.table })
        W.str(3, rg.pairArrow(l.txName || '', l.rxName || ''), 'left', { size: RSTY.size.table, wrap: true })
        W.str(4, utcg(wd.startISO), 'center', { font: FNT, size: RSTY.size.tableDense, wrap: true })
        W.str(5, utcg(wd.endISO) + (wd.clipped ? g.accClip : ''), 'center', { font: FNT, size: RSTY.size.tableDense, wrap: true })
        W.num(6, wd.durationMin, 2); W.num(7, wd.maxRangeKm, 1)
        ws.getRow(W.r).height = 26; W.r++
      })
    })
    W.rowEnd(7)
  } else if (feas.length) {
    ws.mergeCells(W.r, 1, W.r, NCOL); W.str(1, rg.mAccNA, 'left', { size: RSTY.size.table, color: 'FF666666', wrap: true }); ws.getRow(W.r).height = 20; W.r++
  }
  W.gap()

  // 星间几何（最差工况）
  if (feas.length) {
    W.section(rg.worstHead, NCOL)
    W.thead([g.aerLink, rg.wPair, rg.wRange, rg.wTxAlt, rg.wRxAlt, rg.wCentral, rg.wGraz, rg.wDelay, rg.wRR, isLaser ? rg.wDopOpt : rg.wDopRf, rg.wVis])
    feas.forEach((l, li) => {
      const wrs = l.islGeo.worst || {}
      const vis = l.islGeo.visibility || {}
      W.str(1, '#' + l._no, 'center', { font: FNT, size: RSTY.size.table })
      W.str(2, rg.pairArrow(l.txName || '', l.rxName || ''), 'left', { size: RSTY.size.table, wrap: true })
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
      W.str(1, '#' + l._no, 'center', { font: FNT, size: RSTY.size.table })
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
    W.str(1, g.accLink, 'center', { bold: true, size: RSTY.size.tableDense })
    ws.mergeCells(W.r, 2, W.r, 4); W.str(2, rg.mAccPair, 'left', { bold: true, size: RSTY.size.tableDense })
    ws.mergeCells(W.r, 5, W.r, NCOL); W.str(5, g.infeasReason, 'left', { bold: true, size: RSTY.size.tableDense })
    setRowBorder(ws, W.r, 1, NCOL, { top: MED, bottom: THIN }); ws.getRow(W.r).height = 20; W.r++
    infeas.forEach((l, li) => {
      W.str(1, '#' + l._no, 'center', { font: FNT, size: RSTY.size.table })
      ws.mergeCells(W.r, 2, W.r, 4); W.str(2, rg.pairArrow(l.txName || '', l.rxName || ''), 'left', { size: RSTY.size.table, wrap: true })
      ws.mergeCells(W.r, 5, W.r, NCOL); W.str(5, (l.islGeo && l.islGeo.reason) || '—', 'left', { size: RSTY.size.table, color: 'FF666666', wrap: true })
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

// ============================ 交付级链路预算报告（.xlsx）============================
// 模型由渲染进程按 src/shared/lbReport.js 组装（元信息 / 逐链路结果 / 瀑布段 / 输入清单 / 图件），
// 主进程在此补一段 summary（链路汇总的横表与纵表所共用的指标矩阵、容量统计），随后两条渲染路径
// 共吃这一份模型：本文件出 .xlsx，src/report/* + printToPDF 出 .pdf。
// summary 由主进程补而不是渲染端自己算——那几张表的列定义、单位自适应与中英译法早已在本文件
// 维护着（summaryRows / adaptSummaryUnits / STR），往渲染端镜像一份必然漂移。
//
// 版式照《技术文档标准模板.docx》：全篇三线表（顶/底 1.5pt、栏目线 0.75pt，无竖线、无底纹），
// 西文与数字 Times New Roman、中文正文宋体、中文标题与题注黑体，表题在表上方、图题在图下方；
// 不写任何达标/判定一类的文字结论（纯数字口径），读者从数字里读结论。

// 指标矩阵：一行一个指标、跨全部链路取值（单位已按整行共选档位换算好）。
// 横表（一行一链路）与纵表（一行一指标）是它的两种转置，两张表因此不可能对不上。
function enrichReportModel(model) {
  const lang = model.lang === 'en' ? 'en' : 'zh'
  const t = strFor(lang)
  const links = model.links || []
  const orbitType = (model.scheme && model.scheme.orbitType) || 'GEO'
  const regenMode = (model.scheme && model.scheme.regenMode) || 'uplink'
  const rows = summaryRows(t, orbitType, regenMode)
  adaptSummaryUnits(rows, links)
  const metrics = rows.map((r) => ({ label: r.label, values: links.map((l) => r.get(l)) }))

  const done = links.filter((l) => l.data && !l.error)
  const stats = []
  // 端到端：只出「总容量」= Σ 各链业务信息速率。业务速率在一条链上全程守恒（再生节点解调重调后
  // 速率不变），求和是实打实的服务总量；而带宽/功率占用逐段各不相同（各段体制可换、各透明星各占各的），
  // 加不出一个链级的数——不编造，那两行整体不出（口径同 linkChain.js「不出链级功率/带宽占比」）。
  if (orbitType === 'E2E') {
    if (done.length) {
      let capKbps = 0
      for (const l of done) { const k = parseFloat(l.data.infoRateResult); if (isFinite(k)) capKbps += k }
      stats.push({ label: t.totalCap, value: fmtCapText(capKbps) })
    }
  } else if (done.length && regenMode !== 'laser') {
    let bwKHz = 0, capKbps = 0, pbwKHz = 0, pbwN = 0
    for (const l of done) {
      const bw = parseFloat(l.data.allocBandwidthResult)
      if (isFinite(bw)) bwKHz += bw
      const k = capKbpsOf(l.data)
      if (isFinite(k)) capKbps += k
      // 功率带宽 = 功率占用 × 转发器带宽（kHz）。再生式排除在外：星上解调再调制、转发器不参与，
      // 其结果里的 PowerBWResult 是弯管引擎按占位转发器参数透传出来的（见 linkCalculatorRegen.js 文件头），
      // 与 regenSummaryRows 四体制都不列功率带宽、工作台再生式窗口不出该项同一口径。
      const pbw = orbitType === 'REGEN' ? NaN : parseFloat(l.data.PowerBWResult)
      if (isFinite(pbw)) { pbwKHz += pbw; pbwN++ }
    }
    stats.push({ label: t.totalCap, value: fmtCapText(capKbps) })
    stats.push({ label: t.totalBw, value: fmtBwText(bwKHz) })
    // 总功率带宽：转发器资源占用的另一维，与总带宽并列（口径同工作台「容量汇总」）
    if (pbwN) stats.push({ label: t.totalPbw, value: fmtBwText(pbwKHz) })
    stats.push({ label: t.avgEff, value: bwKHz > 0 ? (capKbps / bwKHz).toFixed(3) + ' bps/Hz' : '—' })
  }
  model.summary = {
    metrics,
    stats,
    statsTitle: done.length ? t.capHeader(done.length, links.length - done.length) : '',
    doneCount: done.length,
    failCount: links.length - done.length
  }
  return model
}

// PNG 的宽高：IHDR 就在头 24 字节里（8 字节签名 + 4 长度 + 4 'IHDR' + 4 宽 + 4 高），
// 无需解码整张图。报告里按版心宽等比缩放贴图要用它。
function pngSizeOf(dataUrl) {
  try {
    const b64 = String(dataUrl).split(',').pop()
    const buf = Buffer.from(b64.slice(0, 64), 'base64')
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20)
    return (w > 0 && h > 0) ? { w, h } : null
  } catch (e) { return null }
}

// —— 模板版式（《技术文档标准模板.docx》，参数见 electron/services/reportStyle.js）——
// 全篇一律三线表：顶线 / 底线 1.5pt、栏目线 0.75pt，无竖线、无底纹；字号 16/14/12/10.5pt 四档。
const RSTY = require('./reportStyle').TPL
// 给一片区域画三线表（模板「三线表」样式）：顶线 1.5pt、栏目线 0.75pt（表头下沿）、底线 1.5pt，
// 无竖线、无底纹。headRow 那一行另作表头处理：中文黑体、居中。
//
// 表头为什么用黑体而不是模板写的宋体：模板的表头靠 Word 的行距与单元格边距把它与数据行分开，
// Excel 里没有那两样，只剩一条 0.75pt 的栏目线，表头会糊进数据里。黑体是模板自己的字体
// （标题与题注即用它），不引入模板以外的东西，又刚好补上这一档视觉分隔。不加粗、不加底纹。
function bookBox(ws, r1, c1, r2, c2, headRow) {
  for (let c = c1; c <= c2; c++) {
    const top = ws.getCell(r1, c)
    top.border = Object.assign({}, top.border, { top: MED })
    const bot = ws.getCell(r2, c)
    bot.border = Object.assign({}, bot.border, { bottom: MED })
    if (!headRow) continue
    const h = ws.getCell(headRow, c)
    h.border = Object.assign({}, h.border, { bottom: THIN })
    if (hasCjk(String(h.value == null ? '' : h.value))) h.font = Object.assign({}, h.font, { name: HEI })
    h.alignment = Object.assign({}, h.alignment, { horizontal: 'center', vertical: 'middle', wrapText: true })
  }
}

// 表格式贴图：按目标显示宽等比缩放，返回占掉的行数（Excel 的图浮在格子上，不占行高，
// 不主动推进行号的话后面的内容会被图压住）。
const XLS_ROW_PX = 20
function placeImage(wb, ws, dataUrl, atRow, dispW) {
  const size = pngSizeOf(dataUrl)
  if (!size) return 0
  const w = dispW, h = Math.round(dispW * size.h / size.w)
  const id = wb.addImage({ base64: dataUrl, extension: 'png' })
  ws.addImage(id, { tl: { col: 0.15, row: atRow - 0.85 }, ext: { width: w, height: h } })
  return Math.ceil(h / XLS_ROW_PX) + 1
}

// —— 右上角 logo ——
// 用户上传的图（矢量图已在渲染端栅格化成 PNG，见 LbReportDialog）贴在每张工作表的右上角，
// 相当于每页页眉都有一枚台标。
//
// Excel 的图不占格子、只浮在格子上，位置是「哪一格 + 格内偏移」。故要贴到版心右边界，
// 得先把列宽单位折成像素（px ≈ 单位 × 7 + 5，Excel 的老口径），从右往左累加找到落点。
//
// ★ 偏移必须写 nativeColOff / nativeRowOff（EMU），不能用 exceljs 的小数 col：
//   它把「一个列宽单位」当 10000 EMU 折算，而真值是 ≈ 66675（7 px × 9525），
//   小数锚点因此会把图往左搬 6.7 倍——logo 会贴在倒数第二列的左边缘上。
const COL_PX = (w) => Math.round((typeof w === 'number' && w > 0 ? w : 8.43) * 7 + 5)
const EMU_PX = 9525
function placeLogo(wb, ws, logo, ncol) {
  if (!logo || !logo.dataUrl) return
  const size = pngSizeOf(logo.dataUrl)
  if (!size) return
  const C = RSTY.cover
  let w = C.logoWpx, h = Math.round(C.logoWpx * size.h / size.w)
  if (h > C.logoMaxHpx) { h = C.logoMaxHpx; w = Math.round(C.logoMaxHpx * size.w / size.h) }
  // 版心右边界：把 1..ncol 列的像素宽加起来
  const px = []
  let total = 0
  for (let c = 1; c <= ncol; c++) { px[c] = COL_PX(ws.getColumn(c).width); total += px[c] }
  // 从右往左退 w 像素，落在哪一列的哪个位置
  const left = Math.max(0, total - w)
  let acc = 0, col = ncol - 1, off = 0
  for (let c = 1; c <= ncol; c++) {
    if (acc + px[c] > left) { col = c - 1; off = left - acc; break }
    acc += px[c]
  }
  const id = wb.addImage({ base64: logo.dataUrl, extension: 'png' })
  ws.addImage(id, {
    tl: { nativeCol: col, nativeColOff: Math.round(off * EMU_PX), nativeRow: 0, nativeRowOff: 3 * EMU_PX },
    ext: { width: w, height: h },
    editAs: 'oneCell'
  })
}

// —— 主报告表（第一张 sheet）——
function buildMasterSheet(wb, model, t, L) {
  const links = model.links || []
  const sum = model.summary || { metrics: [], stats: [] }
  const nMetric = sum.metrics.length
  // 版心列数：本表最宽的一张是「逐参数对照」——一行一个指标、一列一条链路，故右端 = 1 + 链路数
  // （参考/常数/索引三张都在 8 列以内，另按 refLast 自行收窄）。分节标题与横线按此跨列，
  // 不能按指标数跨（那是转置前的横表口径，会把横线拉到表格外面去）。
  const NCOL = Math.max(6, 1 + links.length)
  const ws = wb.addWorksheet(L.master, { views: [{ showGridLines: false }] })
  // 列宽只给个起点：第 1 列同时承着指标名 / 常数名 / 序号，宽度由导出前的 autofit 按实际内容定。
  ws.columns = [{ width: 12 }, { width: 20 }, { width: 20 },
    ...Array.from({ length: Math.max(3, NCOL - 3) }, () => ({ width: 15 }))]
  let r = 1
  const doc = model.doc || {}

  const str = (row, col, text, align, o) => {
    o = o || {}
    const c = ws.getCell(row, col)
    c.value = text == null ? '' : text
    // 字体名同时是「中文用哪一档」的意图标记：黑体=标题与题注、宋体=正文与表内文字，
    // 西文与数字一律 TNR（混排格在写盘前由 applyBookFont 拆成富文本，见文件上半段）。
    c.font = { name: o.font || (o.hei ? HEI : CJK), size: o.size || RSTY.size.table, bold: !!o.bold, color: o.color ? { argb: o.color } : undefined }
    c.alignment = { horizontal: align || 'left', vertical: 'middle', wrapText: !!o.wrap }
    return c
  }
  // 章节标题：模板 标题 1（黑体 14pt）。下沿那条线是章的收口，不是表格的线。
  const section = (text) => {
    r++
    ws.mergeCells(r, 1, r, NCOL)
    str(r, 1, text, 'left', { hei: true, size: RSTY.size.h1 })
    setRowBorder(ws, r, 1, NCOL, { bottom: THIN })
    ws.getRow(r).height = 26; r++
  }
  // 表题：模板 表号格式（黑体 10.5pt 居中，在表**上方**）。跨整幅——它是一句话，
  // 不跨的话自适应会按这句话的长短去撑表格第 1 列。
  const tableCap = (no, title) => {
    ws.mergeCells(r, 1, r, NCOL)
    str(r, 1, model.lang === 'en' ? `Table ${no}  ${title}` : `${L.table} ${no}　${title}`, 'center', { hei: true, size: RSTY.size.caption })
    ws.getRow(r).height = 18; r++
  }

  // 报告头：模板 文档标题（黑体 16pt 居中）
  ws.mergeCells(r, 1, r, NCOL)
  str(r, 1, doc.title || L.master, 'center', { hei: true, size: RSTY.size.docTitle })
  ws.getRow(r).height = 30; r++
  // 摘要行：体制 · 编号 · 编制单位 · 日期。Excel 没有封面，这一行就是它唯一的上下文。
  // 体制名已不含「链路预算」四字（见 lbReport.js 的 SCHEME_NAME），与上面的报告名不重复。
  ws.mergeCells(r, 1, r, NCOL)
  const en = model.lang === 'en'
  const summaryLine = [
    (en ? model.scheme.labelEn : model.scheme.label) + ((en ? model.scheme.subLabelEn : model.scheme.subLabel) ? '　·　' + (en ? model.scheme.subLabelEn : model.scheme.subLabel) : ''),
    doc.docNo, doc.org, doc.date
  ].filter(Boolean).join('　·　')
  str(r, 1, summaryLine, 'center', { size: RSTY.size.table, color: 'FF666666' })
  ws.getRow(r).height = 18; r++

  // 逐参数对照（纵表：一行一个指标、每条链路一列——多条链路并排比对同一项）
  section('1　' + L.compare)
  tableCap(1, L.compare)
  str(r, 1, L.param, 'left', { size: RSTY.size.tableDense })
  links.forEach((l, li) => str(r, 2 + li, '#' + (l.no || li + 1) + '\n' + (l.txName || '') + ' → ' + (l.rxName || ''), 'center', { size: RSTY.size.tableDense, wrap: true }))
  const cmpHead = r
  ws.getRow(r).height = 34; r++
  sum.metrics.forEach((m) => {
    str(r, 1, m.label, 'left', { size: RSTY.size.table })
    m.values.forEach((v, li) => {
      const c = ws.getCell(r, 2 + li); c.value = numOrText(v)
      c.font = { name: FNT, size: RSTY.size.table }; c.alignment = { horizontal: 'right', vertical: 'middle' }
    })
    ws.getRow(r).height = 18; r++
  })
  if (nMetric) bookBox(ws, cmpHead, 1, r - 1, 1 + links.length, cmpHead)

  // 容量与统计
  if (sum.stats.length) {
    section('2　' + L.capacity)
    // 题注跨整幅（它是一句话，不是表格的第一列——不跨的话自适应会把第 1 列按这句话的长短撑宽）
    if (sum.statsTitle) {
      ws.mergeCells(r, 1, r, NCOL)
      str(r, 1, sum.statsTitle, 'left', { size: RSTY.size.table, color: 'FF666666' })
      ws.getRow(r).height = 18; r++
    }
    const stHead = r
    for (const s of sum.stats) {
      str(r, 1, s.label, 'left', { size: RSTY.size.table })
      str(r, 2, s.value, 'right', { font: FNT, size: RSTY.size.table, bold: true })
      ws.getRow(r).height = 19; r++
    }
    bookBox(ws, stHead, 1, r - 1, 2)
  }

  // 计算模型与参考（编号 3：与 Word / PDF 的总报告章节号一一对应，三份文件的「§1 逐参数对照」
  // 说的必须是同一张表。Excel 专有的「详情索引」是工作簿的导航件，不占章节号，附在最后。）
  // 三小节：3.1 计算链路与口径（逐段方法学说明）· 3.2 引用建议书与标准 · 3.3 物理常数与基准。
  const mth = model.method || { basis: [], refGroups: [], constants: [] }
  // 二级标题：模板 标题 2（黑体 12pt）
  const subsec = (text) => {
    r++
    ws.mergeCells(r, 1, r, NCOL)
    str(r, 1, text, 'left', { hei: true, size: RSTY.size.h2 })
    ws.getRow(r).height = 22; r++
  }
  section('3　' + L.refs)

  subsec('3.1　' + L.mBasis)
  for (const b of mth.basis) {
    ws.mergeCells(r, 1, r, NCOL)
    str(r, 1, b.title, 'left', { hei: true, size: RSTY.size.table })
    ws.getRow(r).height = 18; r++
    ws.mergeCells(r, 1, r, NCOL)
    str(r, 1, b.text, 'left', { size: RSTY.size.table, wrap: true })
    // 说明段的行高交给导出前的 autofit 按最终列宽排版数出来（合并单元格不会自动长高，
    // 这里只给一个单行的起点）
    ws.getRow(r).height = 18
    r += 2
  }

  subsec('3.2　' + L.mRefs)
  tableCap(2, L.mRefs)
  const refHead = r
  const refLast = Math.min(NCOL, 8)
  // 建议书名（英文动辄百来字符）单占一列会被挤成七八行，故名称与用途各占一段：名称 2..refMid、
  // 用途 refMid+1..refLast，两段宽度相当。
  const refMid = Math.min(refLast - 1, Math.max(2, Math.round((1 + refLast) / 2)))
  const refCols = (row) => {
    if (refMid > 2) ws.mergeCells(row, 2, row, refMid)
    if (refLast > refMid + 1) ws.mergeCells(row, refMid + 1, row, refLast)
  }
  str(r, 1, L.mId, 'left', { size: RSTY.size.table })
  refCols(r)
  str(r, 2, L.mTitle, 'left', { size: RSTY.size.table })
  str(r, refMid + 1, L.mUse, 'left', { size: RSTY.size.table })
  ws.getRow(r).height = 19; r++
  for (const g of mth.refGroups) {
    ws.mergeCells(r, 1, r, refLast)
    // 类别行（三组标准的分界）：三线表不许底纹，改用黑体把它与条目行分开
    str(r, 1, g.group, 'left', { hei: true, size: RSTY.size.table })
    ws.getRow(r).height = 18; r++
    for (const ref of g.items) {
      str(r, 1, ref.id, 'left', { font: FNT, size: RSTY.size.table, wrap: true })
      refCols(r)
      str(r, 2, ref.title, 'left', { size: RSTY.size.table, wrap: true })
      str(r, refMid + 1, ref.use, 'left', { size: RSTY.size.table, color: 'FF333333', wrap: true })
      ws.getRow(r).height = 30; r++
    }
  }
  bookBox(ws, refHead, 1, r - 1, refLast, refHead)

  subsec('3.3　' + L.mConst)
  tableCap(3, L.mConst)
  const cHead = r
  ;[L.param, L.mSymbol, L.mValue, L.unit, L.mSrc].forEach((h, i) => str(r, i + 1, h, 'center', { size: RSTY.size.table }))
  ws.getRow(r).height = 19; r++
  for (const c of mth.constants) {
    str(r, 1, c.name, 'left', { size: RSTY.size.table })
    str(r, 2, c.symbol, 'center', { font: FNT, size: RSTY.size.table })
    str(r, 3, c.value, 'right', { font: FNT, size: RSTY.size.table })
    str(r, 4, c.unit, 'left', { font: FNT, size: RSTY.size.table })
    str(r, 5, c.src, 'left', { size: RSTY.size.table, color: 'FF333333', wrap: true })
    ws.getRow(r).height = 18; r++
  }
  bookBox(ws, cHead, 1, r - 1, 5, cHead)

  // 详情索引：点一下跳到该链路的详情表。
  // 「站对」一栏铺到倒数第二列、跳转链接放末列：站名长起来（尤其英文导出）时，若仍挤在第 2 列，
  // 自适应会把第 2 列一路撑宽，而上面对照表的数值列正共用着这几列——一张表的长名字不该让另一张表变形。
  section(L.index)
  const idxHead = r
  const idxNameEnd = Math.max(2, NCOL - 1)
  const idxName = (text, o) => {
    if (idxNameEnd > 2) ws.mergeCells(r, 2, r, idxNameEnd)
    str(r, 2, text, 'left', o)
  }
  const headOpt = { size: RSTY.size.table }
  str(r, 1, L.no, 'center', headOpt)
  idxName(L.link, headOpt)
  str(r, NCOL, L.detail, 'left', headOpt)
  ws.getRow(r).height = 19; r++
  links.forEach((l, li) => {
    str(r, 1, String(l.no || li + 1), 'center', { font: FNT, size: RSTY.size.table })
    idxName((l.txName || '') + ' → ' + (l.rxName || ''), { size: RSTY.size.table })
    const c = ws.getCell(r, NCOL)
    c.value = { formula: `HYPERLINK("#'${l.sheetName}'!A1","${(l.sheetName || '').replace(/"/g, '')}")`, result: l.sheetName }
    c.font = { name: CJK, size: RSTY.size.table, color: { argb: 'FF15619B' }, underline: true }
    c.alignment = { horizontal: 'left', vertical: 'middle' }
    ws.getRow(r).height = 19; r++
  })
  if (links.length) bookBox(ws, idxHead, 1, r - 1, NCOL, idxHead)
}

// —— 单链路详情表 ——
// 自包含：输入参数（可复算）→ 详细计算结果（瀑布三线表）→ 图件。
// 输入参数只在 Excel 的详情表里全列；PDF 的详情页是屏幕排版的复刻（表 ‖ 图），输入另立附录。
function writeReportLinkSheet(wb, ws, link, model, t, L) {
  const MAXCOL = 5
  ws.columns = [{ width: 32 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 10 }]
  let r = 1
  const str = (row, col, text, align, o) => {
    o = o || {}
    const c = ws.getCell(row, col)
    c.value = text == null ? '' : text
    c.font = { name: o.font || (o.hei ? HEI : CJK), size: o.size || RSTY.size.table, bold: !!o.bold, color: o.color ? { argb: o.color } : undefined }
    c.alignment = { horizontal: align || 'left', vertical: 'middle', wrapText: !!o.wrap }
  }
  const section = (text) => {
    r++
    ws.mergeCells(r, 1, r, MAXCOL)
    str(r, 1, text, 'left', { hei: true, size: RSTY.size.h1 })   // 模板 标题 1：黑体 14pt
    setRowBorder(ws, r, 1, MAXCOL, { bottom: THIN }); ws.getRow(r).height = 26; r++
  }
  // 题注：模板 表号格式 / 图号格式（黑体 10.5pt 居中）。跨整幅——它是一句话，
  // 占着参数列会把参数列按题注的长短撑宽。
  const caption = (text) => {
    ws.mergeCells(r, 1, r, MAXCOL)
    str(r, 1, text, 'center', { hei: true, size: RSTY.size.caption })
    ws.getRow(r).height = 18; r++
  }

  ws.mergeCells(r, 1, r, MAXCOL)
  str(r, 1, '#' + link.no + '　' + (link.txName || '') + ' → ' + (link.rxName || ''), 'center', { hei: true, size: RSTY.size.docTitle })
  ws.getRow(r).height = 28; r++
  ws.mergeCells(r, 1, r, MAXCOL)
  const sub = [(model.calc && model.calc.satelliteName), (model.calc && model.calc.frequencyBand),
    (model.calc && model.calc.mode), (model.doc && model.doc.docNo)].filter(Boolean).join('　·　')
  str(r, 1, sub, 'center', { size: RSTY.size.table, color: 'FF666666' }); ws.getRow(r).height = 18; r++

  if (link.error) {
    r++
    ws.mergeCells(r, 1, r, MAXCOL)
    str(r, 1, t.calcFailed + link.error, 'left', { size: 11, color: 'FFB00000', wrap: true })
    ws.getRow(r).height = 22
    return
  }

  // 输入参数。表号按「链路序号-块序号」编（表 3-2 = 第 3 条链路的第 2 块输入），
  // 与图号同一套编法，读者从题注就知道它属于哪条链路。
  if (link.inputs && link.inputs.length) {
    section(L.inputs)
    link.inputs.forEach((blk, bi) => {
      caption(model.lang === 'en' ? `Table ${link.no}-${bi + 1}  ${blk.title}` : `${L.table} ${link.no}-${bi + 1}　${blk.title}`)
      const hb = r
      str(r, 1, L.param, 'left', { size: RSTY.size.table })
      str(r, 2, L.value, 'right', { size: RSTY.size.table })
      str(r, 3, L.unit, 'left', { size: RSTY.size.table })
      ws.getRow(r).height = 19; r++
      for (const row of blk.rows) {
        str(r, 1, row.label, 'left', { size: RSTY.size.table })
        const vc = ws.getCell(r, 2); vc.value = numOrText(row.value)
        vc.font = { name: FNT, size: RSTY.size.table }; vc.alignment = { horizontal: 'right', vertical: 'middle' }
        str(r, 3, row.unit, 'left', { font: FNT, size: RSTY.size.table, color: 'FF333333' })
        ws.getRow(r).height = 18; r++
      }
      bookBox(ws, hb, 1, r - 1, 3, hb)
      r++
    })
  }

  // 详细计算结果（与屏幕「详细预算」同一份 segments）
  section(L.results)
  // 端到端级联的数值定两位（见 writeSegmentBlocks 的 fixedDecimals），屏幕/TSV/Excel 三处印出来一致
  r = writeSegmentBlocks(ws, link.segments, t, r, { fixedDecimals: (model.scheme && model.scheme.orbitType) === 'E2E' })

  // 图件（与图上「出图」按钮出的是同一张）。图题在图**下方**——模板「图号格式」的口径，
  // 也是中文出版惯例（表题在上、图题在下）。
  const figs = (link.figures || []).filter((f) => f && f.dataUrl)
  if (figs.length) {
    section(L.figures)
    figs.forEach((f, i) => {
      const cap = model.lang === 'en' ? `Figure ${link.no}-${i + 1}  ${f.title || ''}` : `${L.figure} ${link.no}-${i + 1}　${f.title || ''}`
      r += placeImage(wb, ws, f.dataUrl, r, 460)
      caption(cap)
      r++
    })
  }
}

// sheet 名：Excel 上限 31 字符，且 : \ / ? * [ ] 不合法；重名自动加尾号
function sheetNameFor(link, used) {
  const raw = ('#' + link.no + ' ' + (link.txName || '') + '-' + (link.rxName || ''))
    .replace(/[\\/?*[\]:']/g, ' ').trim()
  let base = raw.slice(0, 31) || ('#' + link.no)
  let name = base, k = 2
  while (used[name]) name = base.slice(0, 28) + '~' + (k++)
  used[name] = true
  return name
}

async function buildReportWorkbook(model) {
  const lang = model.lang === 'en' ? 'en' : 'zh'
  const t = strFor(lang)
  const L = model.t || {}
  const links = model.links || []
  // 几何关系表按「全链路稳定序号」引用链路，与清单/详情表的 #N 同号
  links.forEach((l, i) => { if (!l.no) l.no = i + 1; l.coord = '#' + l.no })
  const used = {}
  links.forEach((l) => { l.sheetName = sheetNameFor(l, used) })

  const wb = new ExcelJS.Workbook()
  wb.creator = (model.doc && model.doc.org) || (lang === 'en' ? 'Satellite Link Budget Workbench' : '卫星链路预算工作台')
  wb.title = (model.doc && model.doc.title) || ''
  wb.created = new Date()

  buildMasterSheet(wb, model, t, L)

  // 几何关系（NGSO / 再生式各自的 STK 版式表，沿用已有构建器）
  const params = { satelliteName: (model.calc && model.calc.satelliteName) || '', frequencyBand: (model.calc && model.calc.frequencyBand) || '' }
  const meta = { title: (model.doc && model.doc.title) || '' }
  const ot = (model.scheme && model.scheme.orbitType) || 'GEO'
  // 端到端没有独立的「几何关系」sheet：一条链的几何是逐跳的（斜距/仰角/星间距离各跳一份），
  // 已由瀑布的「逐跳几何与时延」段逐跳列全，另开一张 STK 版式表只会把同一批数抄第二遍。
  if (ot === 'NGSO') buildNgsoGeometrySheet(wb, links, params, meta, lang)
  else if (ot === 'REGEN') buildRegenGeometrySheet(wb, links, params, meta, lang, (model.scheme && model.scheme.regenMode) || 'uplink')

  for (const l of links) {
    const ws = wb.addWorksheet(l.sheetName, { views: [{ showGridLines: false }] })
    writeReportLinkSheet(wb, ws, l, model, t, L)
  }
  // 列宽 / 行高自适应（放在最后：要按每张表实际写进去的内容量，而不是按写表时的预期）
  autofitBook(wb, { maxWidth: 56, maxHeight: 260 })
  // logo 贴在自适应**之后**：它按版心右边界定位，而版心宽正是刚刚才定下来的
  const logo = model.doc && model.doc.logo
  if (logo && logo.dataUrl) wb.eachSheet((ws) => placeLogo(wb, ws, logo, Math.max(1, ws.actualColumnCount || ws.columnCount || 1)))
  return applyBookFont(wb).xlsx.writeBuffer()
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

  const doc = new Document({ styles: WORD_STYLES, sections: [{ children: [
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
  const s = r.s8 || null   // NGSO 统计口径（ITU-R P.618-14 §8）
  // 卫星视角段：NGSO 展开 §8 的分箱/加权诊断，GEO 保持原样
  const lookRows = s ? [
    ['卫星视角（ITU-R P.618-14 §8）', null, null],
    ['最低工作仰角', f(s.minElevDeg, 2), '°'],
    ['可达最高仰角', f(s.maxElevDeg, 2), '°'],
    ['卫星可见时间占比', f(s.visFrac * 100, 3), '%'],
    ['仰角增量宽度', f(s.binDeg, 1), '°'],
    ['仰角增量个数', s.binCount, ''],
    ['§8 等效仰角', f(r.elevation, 2), '°'],
    ['雨衰 @ 最低仰角', f(s.attenAtMinElev, 2), 'dB'],
    ['§8 加权后修正', s.degenerate ? '—' : ('−' + f(s.overestimateAtMinElev, 2)), s.degenerate ? '' : 'dB'],
    ['降雨高度 hR', f(r.rainHeight, 3), 'km']
  ] : [
    ['卫星视角', null, null],
    ['仰角', f(r.elevation, 2), '°'],
    ['方位角', r.azimuth != null ? f(r.azimuth, 2) : '—', r.azimuth != null ? '°' : ''],
    ['星地斜距', r.slantRange != null ? f(r.slantRange, 2) : '—', r.slantRange != null ? 'km' : ''],
    ['降雨高度 hR', f(r.rainHeight, 3), 'km']
  ]
  return [
    ['输入参数', null, null],
    ['地球站', row.stationName || '—', ''],
    ['纬度', f(r.lat, 4), '°'],
    ['经度', f(r.lon, 4), '°'],
    ['海拔', (row.altitude === '' || row.altitude == null) ? 0 : row.altitude, 'm'],
    ...(s
      ? [['轨道高度（近圆）', f(s.orbitAltKm, 0), 'km'], ['轨道倾角', f(s.inclDeg, 2), '°']]
      : [['GEO 轨位', r.satLon != null ? f(r.satLon, 2) : '—', r.satLon != null ? '°E' : '']]),
    ['频率', f(r.freq, 3), 'GHz'],
    ['极化', POL_CN[r.polDisplay] || POL_CN[r.pol] || r.polDisplay || r.pol || '—', ''],
    ['R0.01% 降雨率', f(r.rainRate, 3), 'mm/h'],
    ['年可用度', f(r.availability, 3), '%'],
    ['系统噪温（晴空）', down ? f(r.systemNoiseTemp, 0) : '—', down ? 'K' : ''],
    ['馈线损耗', down ? f(r.feederLoss, 2) : '—', down ? 'dB' : ''],
    ['链路方向', down ? '下行' : '上行', ''],
    ...lookRows,
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
// 《三线表模板_TimesNewRoman_11pt.xlsx》（用户 Excel 文档模板）口径的表格工厂 —— 雨衰导出全簿统一用这一套：
// 全表 11 磅；表题在表上方居中加粗（表 N  标题，表号逐 sheet 自增）；顶线/底线 medium、表头下栏目线 thin；
// 无竖线、无表体内部横线、无底纹；表注在底线下方以「注：」起首；首列左对齐缩进 1，其余列居中；同列小数位一致。
function tplSheet(ws, startNo) {
  let rn = 1
  let tableNo = startNo || 0   // 起始表号（跨 sheet 连号的调用方传上一张的号；缺省从表 1 起）
  return {
    // 页首标题（模板「使用说明」页样式：加粗 13 磅、左对齐），下带一空行
    heading(text) {
      const c = ws.getCell(rn, 1)
      c.value = text; c.font = { name: CJK, size: 13, bold: true }
      ws.getRow(rn).height = 27.75
      rn += 2
    },
    caption(text, span) {
      ws.mergeCells(rn, 1, rn, span)
      tableNo++
      const c = ws.getCell(rn, 1)
      c.value = `表 ${tableNo}  ${text}`
      c.font = { name: CJK, size: 11, bold: true }
      c.alignment = { horizontal: 'center', vertical: 'middle' }
      ws.getRow(rn).height = 25.5
      rn++
    },
    headRow(cells) {
      cells.forEach((h, i) => {
        const c = ws.getCell(rn, i + 1)
        c.value = h
        c.font = { name: typeof h === 'number' ? FNT : CJK, size: 11 }
        c.alignment = i === 0
          ? { horizontal: 'left', vertical: 'middle', indent: 1 }
          : { horizontal: 'center', vertical: 'middle', wrapText: true }
      })
      setRowBorder(ws, rn, 1, cells.length, { top: MED, bottom: THIN })
      ws.getRow(rn).height = 21.75
      rn++
    },
    // fmts[i]：该列数字的小数位格式（模板：同列小数位一致）；'—' / 文本原样入格；Date 值配日期格式（如 'yyyy-mm-dd hh:mm:ss'）
    dataRow(vals, fmts) {
      vals.forEach((v, i) => {
        const c = ws.getCell(rn, i + 1)
        c.value = v
        if (fmts && fmts[i] && (typeof v === 'number' || v instanceof Date)) c.numFmt = fmts[i]
        c.font = { name: typeof v === 'number' ? FNT : CJK, size: 11 }
        c.alignment = i === 0
          ? { horizontal: 'left', vertical: 'middle', indent: 1 }
          : { horizontal: 'center', vertical: 'middle' }
      })
      ws.getRow(rn).height = 19.5
      rn++
    },
    // 表体最后一行的底线（medium）
    endTable(span) { setRowBorder(ws, rn - 1, 1, span, { bottom: MED }) },
    note(text, span) {
      ws.mergeCells(rn, 1, rn, span)
      const c = ws.getCell(rn, 1)
      c.value = '注：' + text
      c.font = { name: CJK, size: 11 }
      c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 }
      // 行高按折行数估：合并区可容纳字符数 ≈ 跨列宽度之和 ÷ 2（中文全角）
      const wSum = Array.from({ length: span }, (_, i) => ws.getColumn(i + 1).width || 10).reduce((a, b) => a + b, 0)
      ws.getRow(rn).height = Math.max(19.5, Math.ceil((text.length + 2) / Math.max(10, wSum / 2.1)) * 16 + 4)
      rn++
    },
    skip(n) { rn += (n == null ? 1 : n) }
  }
}

async function buildRainAttenuationExcel(payload) {
  const { direction = 'down', rainModel = 'auto', orbitMode = 'geo', rows = [], results = [] } = payload || {}
  const down = direction !== 'up'
  const dv = payload && payload.div
  const hasDiv = !!(dv && !dv.error && dv.activeCount && dv.system)
  const wb = new ExcelJS.Workbook()
  wb.creator = '卫星仿真平台'; wb.created = new Date()

  // —— Sheet 1：批量结果（每行一个算例，三线表模板版式）。多站汇总打开时不出（其数据已被「多站汇总」页覆盖）——
  if (!hasDiv) {
    // 冻结线钉在表头行（页首标题 1 + 空行 2 + 表题 3 + 表头 4）
    const ws = wb.addWorksheet('雨衰批量结果', { views: [{ showGridLines: false, state: 'frozen', ySplit: 4, xSplit: 1 }] })
    const round2 = (v) => (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v * 100) / 100 : v
    const isNgso = orbitMode === 'ngso'
    // 几何输入已上提为全局（工具栏）→ 写进表注；表内只留每站的仰角结果列
    const geomCols = [isNgso ? { k: '_elev', h: '§8等效仰角 (°)', w: 14, fmt: '0.00' } : { k: '_elev', h: '仰角 (°)', w: 10, fmt: '0.00' }]
    const cols = [
      { k: 'stationName', h: '地球站', w: 14, text: true },
      { k: 'latitude', h: '纬度 (°)', w: 10 },
      { k: 'longitude', h: '经度 (°)', w: 10 },
      { k: 'altitude', h: '海拔 (m)', w: 10 },
      ...geomCols,
      { k: 'frequency', h: '频率 (GHz)', w: 10 },
      { k: 'polarization', h: '极化', w: 8, text: true },
      { k: '_rain', h: 'R0.01 (mm/h)', w: 12, fmt: '0.000' },
      { k: 'availability', h: '可用度 (%)', w: 10 },
      { k: 'systemNoiseTemp', h: '系统噪温 (K)', w: 12 },
      { k: 'gasAtten', h: '气体 (dB)', w: 10, res: true, fmt: '0.00' },
      { k: 'cloudAtten', h: '云衰 (dB)', w: 10, res: true, fmt: '0.00' },
      { k: 'rainAtten', h: '雨衰 (dB)', w: 10, res: true, fmt: '0.00' },
      { k: 'totalAtten', h: '合计 (dB)', w: 10, res: true, fmt: '0.00' },
      { k: 'gtDegradation', h: 'G/T衰减 (dB)', w: 12, res: true, dl: true, fmt: '0.00' },
      { k: 'rainXPD', h: '雨致XPD (dB)', w: 12, res: true, fmt: '0.00' },
      { k: 'downtimeYear', h: '年停时 (h)', w: 10, res: true, fmt: '0.00' },
      { k: 'downtimeWorstMonth', h: '最坏月停时 (h)', w: 14, res: true, fmt: '0.00' }
    ]
    const ncol = cols.length
    cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.w })
    const fmts = cols.map((c) => c.fmt || '')
    const T = tplSheet(ws)
    T.heading('雨衰计算结果')
    T.caption('雨衰批量计算结果', ncol)
    T.headRow(cols.map((c) => c.h))
    rows.forEach((row, ri) => {
      const r = results[ri] || {}
      const vals = cols.map((c) => {
        let v
        if (c.res) { v = r.error ? '✕' : round2(r[c.k]); if (c.dl && !down) v = '—' }
        else if (c.k === '_elev') v = (r.elevation != null ? round2(r.elevation) : row.elevation)
        else if (c.k === '_rain') v = (r.rainRate != null ? round2(r.rainRate) : row.rainRate)
        else v = row[c.k]
        return c.text ? (v == null ? '' : v) : numOrText(v)
      })
      T.dataRow(vals, fmts)
    })
    if (rows.length) T.endTable(ncol)
    // 全局几何：优先 payload.geom（新导出）；缺则从首个成功结果兜底（r.s8 / r.satLon）
    const gm = (payload && payload.geom) || {}
    const firstOk = results.find((x) => x && !x.error) || {}
    const s8i = firstOk.s8 || {}
    const gv = (v, d) => (v == null || !Number.isFinite(+v)) ? '—' : (+v).toFixed(d)
    const geomTxt = isNgso
      ? `NGSO 近圆 ${gv(gm.orbitAltKm != null ? gm.orbitAltKm : s8i.orbitAltKm, 0)} km、倾角 ${gv(gm.inclDeg != null ? gm.inclDeg : s8i.inclDeg, 1)}°、最低仰角 ${gv(gm.minElevDeg != null ? gm.minElevDeg : s8i.minElevDeg, 1)}°（ITU-R P.618-14 §8 仰角加权 → 等效仰角）`
      : `GEO ${gv(gm.satLon != null ? gm.satLon : firstOk.satLon, 1)}°E（轨位算仰角）`
    T.note(`轨道：${geomTxt}；链路方向：${down ? '下行' : '上行'}；降雨模型：${rainModel === 'auto' ? 'ITU-R P.837 自动' : '手动'}；共 ${rows.length} 个算例。`, ncol)
  }

  // —— 多站汇总 sheet（「多站汇总」打开并算出时才有 payload.div）——
  // 版式按《三线表模板_TimesNewRoman_11pt》（用户 Excel 文档模板）：全表 11 磅；表题在表上方
  // 居中加粗（表 N  标题）；顶线/底线 medium、表头下栏目线 thin；无竖线、无表体内部横线、无底纹；
  // 表注在底线下方以「注：」起首、左对齐缩进 1；首列左对齐缩进 1，其余列居中；同列小数位一致。
  // 内容四张表镜像结果页：逐站 / 系统级联 / 中断站数分布 / 切换。数字格式函数与
  // src/rain/RainDiversity.vue 里的 pct/yearly/pmfPct 是手工镜像，改动须两处同步。
  if (hasDiv) {
    const sys = dv.system
    const sw = dv.switch || null
    const byAvail = dv.inputMode === 'avail'
    const dsites = Array.isArray(dv.sites) ? dv.sites : []
    const TGT = { rainAtten: '单独雨衰', totalAtten: '气体吸收 + 云衰 + 雨衰', dnd: '雨衰 + 云衰 + 噪声抬升' }
    const HOURS = 8766
    const pctS = (v) => {
      if (v == null || !Number.isFinite(v)) return '—'
      if (v === 0) return '0'
      const p = v * 100
      return p >= 1e-4 ? p.toFixed(6) : p.toExponential(3)
    }
    const yearlyS = (v) => {
      if (v == null || !Number.isFinite(v) || v <= 0) return '0'
      const h = v * HOURS
      if (h >= 1) return h.toFixed(2) + ' h/年'
      const m = h * 60
      return m >= 1 ? m.toFixed(2) + ' min/年' : (m * 60).toFixed(2) + ' s/年'
    }
    const pmfS = (v) => {
      if (v == null || !Number.isFinite(v) || v <= 0) return '0'
      const p = v * 100
      if (p >= 100) return '100'
      const d = Math.min(8, Math.max(0, 2 - Math.floor(Math.log10(p))))
      const s = p.toFixed(d)
      return parseFloat(s) === 0 ? '0' : s
    }
    const fx2 = (v, d) => (v == null || !Number.isFinite(+v)) ? '—' : (+v).toFixed(d)
    const nOrDash = (v) => (v == null || !Number.isFinite(+v)) ? '—' : +v
    const mcols = Math.max(byAvail ? 6 : 7, (Array.isArray(sys.pmf) ? sys.pmf.length : 0) + 1, 5)
    const mws = wb.addWorksheet('多站汇总', { views: [{ showGridLines: false }] })
    mws.getColumn(1).width = 18
    mws.getColumn(2).width = 24
    for (let ci = 3; ci <= mcols; ci++) mws.getColumn(ci).width = 14
    const T = tplSheet(mws)
    T.heading('多站总可用度')

    // —— 表 1  逐站可用度 ——
    const siteHead = ['站']
    if (!byAvail) siteHead.push('可承受 (dB)')
    siteHead.push('可用度 (%)', '年停时 (h)', '雨衰 (dB)', '合计 (dB)', '下行总劣化 (dB)')
    T.caption('逐站可用度', siteHead.length)
    T.headRow(siteHead)
    // 小数位与结果页逐列同口径（可用度 5 位——2 位会把 99.99 与 99.999 显示成同一个数）
    const siteFmts = ['']
    if (!byAvail) siteFmts.push('0.00')
    siteFmts.push('0.00000', '0.000', '0.00', '0.00', '0.00')
    dsites.forEach((s) => {
      const okS = s.solve && s.solve.state !== 'err'
      const vals = [s.name]
      if (!byAvail) vals.push(nOrDash(s.attenBudgetDb))
      vals.push(
        okS ? nOrDash(s.solve.availability) : '—',
        okS ? nOrDash(s.solve.downtimeYear) : '—',
        s.atten ? nOrDash(s.atten.rain) : '—',
        s.atten ? nOrDash(s.atten.total) : '—',
        s.atten ? nOrDash(s.atten.dnd) : '—'
      )
      T.dataRow(vals, siteFmts)
    })
    T.endTable(siteHead.length)
    if (!byAvail) T.note(`可承受衰减对标 ${TGT[dv.target] || dv.target}，可用度由 ITU-R P.618-14 反解。`, siteHead.length)
    T.skip()

    // —— 表 2  系统可用度（级联：P(S≥L) 逐项 → Σ → 切换 → 合计；闭账规则与结果页一致）——
    T.caption(`系统可用度（参与 ${sys.M} 站 · 最少可用 ${sys.nMin}）`, 5)
    T.headRow(['项', '算式', '不可用度 (%)', '可用度 (%)', '年停时'])
    const casRow = (label, formula, v) => {
      const num = v != null && Number.isFinite(v)
      // 不可用度：≥1e-4 % 定点 6 位（同 pctS），更小走 Excel 科学计数（页面 e 记法的等价形态）
      const uFmt = num && !(v === 0 || v * 100 >= 1e-4) ? '0.000E+00' : '0.000000'
      T.dataRow(
        [label, formula, num ? v * 100 : '—', num ? 100 - v * 100 : '—', yearlyS(v)],
        ['', '', uFmt, '0.000000', '']
      )
    }
    if (Array.isArray(sys.pmf) && sys.unavail > 0) {
      let shown = 0, lastJ = Math.max(0, sys.L) - 1, nTail = 0
      for (let j = Math.max(0, sys.L); j < sys.pmf.length; j++) {
        const v = sys.pmf[j]
        if (!(v >= sys.unavail * 1e-4) || nTail >= 6) break
        casRow(`恰好中断 ${j} 站`, `P(S=${j})`, v)
        shown += v; lastJ = j; nTail++
      }
      const rest = sys.unavail - shown
      if (rest >= sys.unavail * 1e-4) casRow(`其余 j ≥ ${lastJ + 1}`, `ΣP(S≥${lastJ + 1})`, rest)
    }
    casRow('站点中断', `P(S≥${sys.L}) = Σ`, sys.unavail)
    if (sw && sw.unavail != null) casRow('切换', `${fx2(sw.nSwPerYear, 0)} × ${fx2(sw.tSwMin, 0)} min ÷ 525960`, sw.unavail)
    if (sw && sw.total != null) casRow('合计', '站点中断 + 切换', sw.total)
    T.endTable(5)
    T.note('系统不可用度 = P(同时中断的站数 ≥ L)，L = 参与站数 − 最少可用站数 + 1，各站中断按相互独立计（Poisson–binomial 尾概率）。'
      + (sw ? '切换 U_sw = 次数 × 单次时长 ÷ 525960 min，作独立可加项与站点中断相加为合计。' : ''), 5)
    T.skip()

    // —— 表 3  中断站数分布 ——
    if (Array.isArray(sys.pmf)) {
      T.caption('中断站数分布', sys.pmf.length + 1)
      T.headRow(['同时中断站数 j'].concat(sys.pmf.map((_, j) => j)))
      const distFmts = ['']
      const distVals = ['占比 (%)']
      sys.pmf.forEach((v) => {
        // 值存真数、显示按 pmfS 的定点位数（禁科学计数，与结果页一致）
        const s = pmfS(v)
        const dec = (s.split('.')[1] || '').length
        distVals.push(s === '0' ? 0 : v * 100)
        distFmts.push(dec ? ('0.' + '0'.repeat(dec)) : '0')
      })
      T.dataRow(distVals, distFmts)
      T.endTable(sys.pmf.length + 1)
      T.note(`j ≥ ${sys.L} 各列之和 = 站点中断。`, sys.pmf.length + 1)
      T.skip()
    }

    // —— 表 4  切换预算 ——
    if (sw) {
      T.caption('切换预算', 3)
      T.headRow(['项', '数值', '单位'])
      T.dataRow(['切换时间', nOrDash(sw.tSwMin), 'min'], ['', '0.00', ''])
      T.dataRow(['切换次数', nOrDash(sw.nSwPerYear), '次/年'], ['', '0', ''])
      T.dataRow(['切换不可用度', sw.unavail == null ? '—' : pctS(sw.unavail), '%'])
      T.dataRow(['切换年停时', sw.unavail == null ? '—' : yearlyS(sw.unavail), ''])
      T.endTable(3)
    }
  }

  // —— 每算例详情 sheet（三线表模板版式：三段各成一张 项/数值/单位 表）——
  const used = {}
  rows.forEach((row, ri) => {
    const r = results[ri]; if (!r || r.error) return
    const base = String(row.stationName || ('算例' + (ri + 1))).replace(/[\\/?*[\]:]/g, ' ').slice(0, 24)
    let name = ((ri + 1) + ' ' + base).slice(0, 31); let k = 2
    while (used[name]) { name = ((ri + 1) + ' ' + base).slice(0, 28) + '~' + k; k++ }
    used[name] = true
    const ds = wb.addWorksheet(name, { views: [{ showGridLines: false }] })
    ds.getColumn(1).width = 26; ds.getColumn(2).width = 20; ds.getColumn(3).width = 10
    const T = tplSheet(ds)
    T.heading('雨衰详细计算结果 · ' + (row.stationName || ('算例' + (ri + 1))))
    let open = false
    for (const [label, value, unit] of rainDetailRows(r, row, down)) {
      if (value === null && unit === null) {          // 分段标记 → 上一张表收底线，起新表
        if (open) { T.endTable(3); T.skip() }
        T.caption(label, 3)
        T.headRow(['项', '数值', '单位'])
        open = true
        continue
      }
      T.dataRow([label, numOrText(value), unit || ''])
    }
    if (open) T.endTable(3)
    // 口径注（避免读者把 DND 和合计衰减混起来；NGSO 的等效仰角不是「某一时刻的仰角」）
    const dndNote = down
      ? 'DND = (雨衰+云衰) + 降雨噪声致 G/T 衰减。降雨噪声按 雨+云、T_mr=275 K、经馈线折算；气体不计入（晴空已含、不构成劣化），闪烁不计入（折射，不辐射噪声）。'
      : '上行不计降雨噪声：G/T 衰减与 DND 为下行专属。'
    const s8Note = r.s8
      ? 'NGSO 口径（ITU-R P.618-14 §8）：仰角范围按增量分箱，各增量的可见时间占比 × 该仰角下的超越时间占比再求和；等效仰角 = 使单仰角法给出同一雨衰的仰角，非任何瞬时几何。统计口径为卫星可服务期间。气体/云/闪烁/XPD/降雨噪温按该等效仰角求值（雨衰等效，属工程近似）。仰角分布为近圆轨道解析式，不适用于大偏心率轨道。'
      : ''
    T.note(s8Note + dndNote, 3)
  })

  return applyBookFont(wb).xlsx.writeBuffer()
}

// ==================== 可见性分析 · 时段过境导出 ====================
// 《三线表模板_TimesNewRoman_11pt.xlsx》版式，三张工作表：摘要（项目/数值/单位）、过境明细
// （两级表头含辅助线：UTC 组与本地组各 开始/结束/峰值，真日期值 + 同列统一数字格式）、逐星汇总。
// 时刻语义：payload 只送相对分钟（startMin…，与屏上甘特同一根相对轴）+ 时窗起点 baseMs，
// 绝对时刻在此重建 —— UTC 列 = baseMs + 相对分；本地列再 + tzOffsetMin。xlsx 的日期序列号没有
// 时区概念（exceljs 按 Date 的 UTC 分量入格），本地墙钟只能靠平移伪装，这是标准做法。
const DT_FMT = 'yyyy-mm-dd hh:mm:ss'
function buildVisAccessExcel(payload) {
  const p = payload || {}
  const base = Number(p.baseMs) || 0
  if (!base) throw new Error('缺少时窗起点（请先计算过境）')
  const offMs = (Number(p.tzOffsetMin) || 0) * 60000
  const tzTag = String(p.tzTag || '本地')
  const utcAt = (min) => new Date(base + min * 60000)
  const locAt = (min) => new Date(base + min * 60000 + offMs)
  const sats = Array.isArray(p.sats) ? p.sats : []
  const kpi = p.kpi || {}, tgt = p.target || {}
  const H = Number(p.horizonMin) || 0
  const anySlot = sats.some((s) => s && s.slot)
  const anyTrunc = sats.some((s) => ((s && s.windows) || []).some((w) => w.truncated))
  const wb = new ExcelJS.Workbook()
  wb.creator = '卫星仿真平台'; wb.created = new Date()

  // 明细行序＝全星按 AOS 混排（时间线视角）；逐星视角在「逐星汇总」表，两个视角各占一张
  const flat = []
  for (const s of sats) for (const w of (s.windows || [])) flat.push({ s, w })
  flat.sort((a, b) => a.w.startMin - b.w.startMin)

  const llTxt = (lat, lon) => (Number.isFinite(lat) && Number.isFinite(lon))
    ? Math.abs(lat).toFixed(4) + '°' + (lat >= 0 ? 'N' : 'S') + ', ' + Math.abs(lon).toFixed(4) + '°' + (lon >= 0 ? 'E' : 'W')
    : '—'

  // —— Sheet 1 摘要（项目 / 数值 / 单位）——
  {
    const ws = wb.addWorksheet('摘要', { views: [{ showGridLines: false }] })
    ws.getColumn(1).width = 26; ws.getColumn(2).width = 24; ws.getColumn(3).width = 8
    ws.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    const T = tplSheet(ws)
    T.heading('时段过境分析')
    T.caption('过境分析摘要', 3)
    T.headRow(['项目', '数值', '单位'])
    const rowsA = [
      ['分析目标', String(tgt.name || '—'), ''],
      ['目标坐标', llTxt(tgt.lat, tgt.lon), ''],
      ['卫星集', String(p.satSet || '—'), ''],
      ['扫描卫星数', Number(p.scanned) || 0, '颗', '0'],
      ['仰角门限', Number(p.minElevDeg) || 0, '°', '0'],
      ['时窗起点 (UTC)', utcAt(0), '', DT_FMT],
      ['时窗终点 (UTC)', utcAt(H), '', DT_FMT],
      ['时窗起点 (' + tzTag + ')', locAt(0), '', DT_FMT],
      ['时窗终点 (' + tzTag + ')', locAt(H), '', DT_FMT],
      ['时窗长度', H / 60, 'h', '0.0'],
      ['有过境的卫星', Number(kpi.sats) || 0, '颗', '0'],
      ['过境次数', Number(kpi.passes) || 0, '次', '0'],
      ['时间覆盖', Number(kpi.pct) || 0, '%', '0.00'],
      ['合计可视时长', Number(kpi.coveredMin) || 0, 'min', '0.0'],
      ['最长中断', Number(kpi.maxGapMin) || 0, 'min', '0.0'],
      ['中断段数', Number(kpi.gapCount) || 0, '段', '0']
    ]
    for (const r of rowsA) T.dataRow([r[0], r[1], r[2]], ['', r[3] || '', ''])
    T.endTable(3)
    T.note('时间覆盖＝全部过境窗口在时间轴上合并重叠后的可视时长 ÷ 时窗（多星同时可见只计一次）；最长中断含时窗首尾；被时窗截断的过境只计窗内一段。本地时间＝' + tzTag + '（导出主机系统时区）。', 3)
  }

  // —— Sheet 2 过境明细（两级表头，模板「三线表-含辅助线」版式）——
  {
    const ws = wb.addWorksheet('过境明细', { views: [{ showGridLines: false, state: 'frozen', ySplit: 3 }] })
    ws.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: 'landscape' }
    const single1 = [{ h: '序号', w: 6, fmt: '0' }, { h: '卫星', w: 16 }, { h: 'NORAD', w: 9 }]
    if (anySlot) single1.push({ h: '轨道位置', w: 10 })
    const single2 = [{ h: '时长 (min)', w: 10, fmt: '0.0' }, { h: '最高仰角 (°)', w: 12, fmt: '0.0' }]
    if (anyTrunc) single2.push({ h: '备注', w: 12 })
    const nCol = single1.length + 6 + single2.length
    const fmts = [...single1.map((s) => s.fmt || ''), ...Array(6).fill(DT_FMT), ...single2.map((s) => s.fmt || '')]
    let cc = 1
    for (const s of single1) ws.getColumn(cc++).width = s.w
    for (let i = 0; i < 6; i++) ws.getColumn(cc++).width = 19
    for (const s of single2) ws.getColumn(cc++).width = s.w
    // 表题（全簿连号：摘要=表 1，此表=表 2）
    ws.mergeCells(1, 1, 1, nCol)
    const cap = ws.getCell(1, 1)
    cap.value = '表 2  ' + (tgt.name ? tgt.name + ' ' : '') + '过境窗口明细'
    cap.font = { name: CJK, size: 11, bold: true }
    cap.alignment = { horizontal: 'center', vertical: 'middle' }
    ws.getRow(1).height = 25.5
    // 两级表头：单列头竖向合并（2..3 行）；时区组头横跨 3 列，组下辅助线（THIN）由整行下边线给出，只在组头下方可见
    const headCell = (r, col, text, left) => {
      const cell = ws.getCell(r, col)
      cell.value = text
      cell.font = { name: CJK, size: 11 }
      cell.alignment = left ? { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true } : { horizontal: 'center', vertical: 'middle', wrapText: true }
    }
    const GH = ['开始时间', '结束时间', '峰值时刻']
    cc = 1
    for (const s of single1) { ws.mergeCells(2, cc, 3, cc); headCell(2, cc, s.h, s.h === '卫星'); cc++ }
    for (const gh of ['UTC', '本地时间 (' + tzTag + ')']) {
      ws.mergeCells(2, cc, 2, cc + 2); headCell(2, cc, gh)
      for (let i = 0; i < 3; i++) headCell(3, cc + i, GH[i])
      cc += 3
    }
    for (const s of single2) { ws.mergeCells(2, cc, 3, cc); headCell(2, cc, s.h); cc++ }
    setRowBorder(ws, 2, 1, nCol, { top: MED, bottom: THIN })
    setRowBorder(ws, 3, 1, nCol, { bottom: THIN })
    ws.getRow(2).height = 21.75; ws.getRow(3).height = 21.75
    // 数据行
    let rn = 4
    flat.forEach((it, idx) => {
      const s = it.s, w = it.w
      const vals = [idx + 1, s.name, s.noradId]
      if (anySlot) vals.push(s.slot || '')
      vals.push(utcAt(w.startMin), utcAt(w.endMin), utcAt(w.peakMin), locAt(w.startMin), locAt(w.endMin), locAt(w.peakMin))
      vals.push(Number(w.durMin) || 0, Number(w.peakEl) || 0)
      if (anyTrunc) vals.push(w.truncated ? '截至时窗末' : '')
      vals.forEach((v, i) => {
        const cell = ws.getCell(rn, i + 1)
        cell.value = (v === '' || v == null) ? null : v
        cell.font = { name: (typeof v === 'number' || v instanceof Date) ? FNT : CJK, size: 11 }
        cell.alignment = i === 1 ? { horizontal: 'left', vertical: 'middle', indent: 1 } : { horizontal: 'center', vertical: 'middle' }
        if (fmts[i] && (typeof v === 'number' || v instanceof Date)) cell.numFmt = fmts[i]
      })
      ws.getRow(rn).height = 19.5
      rn++
    })
    setRowBorder(ws, Math.max(3, rn - 1), 1, nCol, { bottom: MED })
    // 表注（模板：底线下方、「注：」起首、左对齐缩进 1）
    ws.mergeCells(rn, 1, rn, nCol)
    const nt = ws.getCell(rn, 1)
    nt.value = '注：AOS（开始）/ LOS（结束）＝仰角穿越门限 ' + (Number(p.minElevDeg) || 0) + '° 的时刻；峰值时刻＝该窗内最高仰角时刻；本地时间＝' + tzTag + '；「截至时窗末」＝过境延伸到时窗外、按时窗截断。'
    nt.font = { name: CJK, size: 11 }
    nt.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 }
    ws.getRow(rn).height = 33.75
  }

  // —— Sheet 3 逐星汇总 ——
  {
    const ws = wb.addWorksheet('逐星汇总', { views: [{ showGridLines: false, state: 'frozen', ySplit: 2 }] })
    ws.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    const cols = [
      { h: '序号', w: 6, fmt: '0' }, { h: '卫星', w: 16 }, { h: 'NORAD', w: 9 },
      ...(anySlot ? [{ h: '轨道位置', w: 10 }] : []),
      { h: '过境次数', w: 9, fmt: '0' }, { h: '合计可视 (min)', w: 13, fmt: '0.0' }, { h: '最长单次 (min)', w: 13, fmt: '0.0' },
      { h: '最高仰角 (°)', w: 12, fmt: '0.0' }, { h: '首次 AOS (UTC)', w: 19, fmt: DT_FMT }, { h: '末次 LOS (UTC)', w: 19, fmt: DT_FMT }
    ]
    cols.forEach((c0, i) => { ws.getColumn(i + 1).width = c0.w })
    const rowFmts = cols.map((c0) => c0.fmt || '')
    const T = tplSheet(ws, 2)   // 接着明细连号：表 3
    T.caption('逐星过境汇总', cols.length)
    T.headRow(cols.map((c0) => c0.h))
    sats.forEach((s, i) => {
      const wl = s.windows || []
      let tot = 0, maxDur = 0, maxEl = 0, first = Infinity, last = -Infinity
      for (const w of wl) {
        tot += Number(w.durMin) || 0
        if (w.durMin > maxDur) maxDur = w.durMin
        if (w.peakEl > maxEl) maxEl = w.peakEl
        if (w.startMin < first) first = w.startMin
        if (w.endMin > last) last = w.endMin
      }
      const vals = [i + 1, s.name, s.noradId]
      if (anySlot) vals.push(s.slot || '')
      vals.push(wl.length, tot, maxDur, maxEl, first < Infinity ? utcAt(first) : '—', last > -Infinity ? utcAt(last) : '—')
      T.dataRow(vals, rowFmts)
    })
    T.endTable(cols.length)
    T.note('行序＝各星首次过境先后；合计可视＝该星各窗时长之和（同星窗口不重叠）；首次 AOS / 末次 LOS 为该星在时窗内的首末边界，UTC。', cols.length)
  }

  return applyBookFont(wb).xlsx.writeBuffer()
}

module.exports = {
  buildWord, buildExcel, buildSunOutageWord, buildRainAttenuationExcel, buildVisAccessExcel, ROWS,
  enrichReportModel, buildReportWorkbook
}
