// 链路预算「报告」的单一真值源（GSO / NGSO / 再生式三窗共用）。
//
// 一份报告要出两种文件（.xlsx 与 .pdf），两条渲染路径分居主进程与打印窗：
//   模型  本文件（渲染进程）   把屏幕上那次计算的全部东西——元信息、输入、结果、瀑布段、图——
//                             收成一个纯数据对象；
//   Excel electron/services/report.js（主进程 exceljs）
//   PDF   src/report/*（隐藏窗渲染 + printToPDF）
// 两个渲染器都只认这一个模型，且都不再自己算数：数字、标签、单位、译法全在模型里定死，
// 于是「屏幕上核对的、Excel 里交出去的、PDF 里打印的」必然是同一份东西。
//
// 主进程收到模型后还会补一段 summary（链路汇总的横表/纵表/统计），见 report.js 的 enrichReportModel——
// 那几张表的列定义、单位自适应、中英译法早已在主进程维护着，不再往渲染端镜像一份。
//
// 纯数字口径（见 memory「链路预算纯数字口径」）：模型里不带任何达标/合格/资源判定一类的文字结论，
// 只有数值、单位与出处。报告要说的话由读者从数字里读，不由软件替他下结论。

// —— 报告元信息（导出对话框填写，按窗口记住上次输入）——
// 字段只留《技术文档标准模板》封面上真有栏位的那五项：名称 / 编号 / 密级 / 编制单位 / 日期。
// 2026-08-02 精简（用户定）：阶段与公司名（与单位重复）、备注（不进任何文件）、项目名称，
// 以及编写/校对/审核/批准四项签署——新模板封面没有签署栏，文档控制页也一并去掉了，
// 留着就是四个填了没去处的空格子。
export const DOC_FIELDS = [
  { key: 'title', label: '名称', labelEn: 'Title', wide: true },
  { key: 'docNo', label: '编号', labelEn: 'Document No.' },
  { key: 'classification', label: '密级', labelEn: 'Classification' },
  { key: 'org', label: '编制单位', labelEn: 'Organisation', wide: true },
  { key: 'date', label: '日期', labelEn: 'Date' }
]

// 体制名。★ 不带「链路预算」四个字——报告标题里已经有了，副标题再说一遍就是同一句话说两遍
//（用户 2026-08-02 指出的「重复取名」）。现在它只出现在导出对话框的抬头与 Excel 主表的摘要行，
// 封面上不再有副标题。再生式按信号流向再分四档——一份再生式报告只讲其中一段链路。
const SCHEME_NAME = {
  GEO: ['GSO 透明转发（弯管）体制', 'GSO Transparent (Bent-Pipe)'],
  NGSO: ['NGSO 透明转发（弯管）体制', 'NGSO Transparent (Bent-Pipe)'],
  REGEN: ['再生式（星上处理）体制', 'Regenerative (On-Board Processing)']
}
const REGEN_NAME = {
  uplink: ['上行（地球站 → 卫星）', 'Uplink (Earth Station → Satellite)'],
  downlink: ['下行（卫星 → 地球站）', 'Downlink (Satellite → Earth Station)'],
  isl: ['星间微波链路', 'Inter-Satellite Link (RF)'],
  laser: ['星间激光链路', 'Inter-Satellite Link (Optical)']
}

export function schemeOf(orbitType, regenMode) {
  const ot = (orbitType === 'NGSO' || orbitType === 'REGEN') ? orbitType : 'GEO'
  const [zh, en] = SCHEME_NAME[ot]
  const sub = ot === 'REGEN' ? (REGEN_NAME[regenMode] || REGEN_NAME.uplink) : null
  return {
    orbitType: ot,
    regenMode: ot === 'REGEN' ? (regenMode || 'uplink') : '',
    label: zh, labelEn: en,
    subLabel: sub ? sub[0] : '', subLabelEn: sub ? sub[1] : ''
  }
}
export const schemeName = (scheme, lang) => (lang === 'en' ? scheme.labelEn : scheme.label)
export const schemeSub = (scheme, lang) => (lang === 'en' ? scheme.subLabelEn : scheme.subLabel)

// 默认报告名：正式技术文档的取名法「对象 + 范围 + 文档类型」，
// 即「<卫星> 卫星 <频段> 频段链路预算报告」。封面上它是唯一的一行主标题，故必须自己说全，
// 不靠副标题补充（用户 2026-08-02 定：一个醒目的主标题即可）。
export function reportTitle(satName, band, lang) {
  const sat = String(satName || '').trim()
  const bd = String(band || '').trim()
  if (lang === 'en') {
    const head = [sat && sat + ' Satellite', bd && bd + '-Band'].filter(Boolean).join(' ')
    return (head ? head + ' ' : 'Satellite ') + 'Link Budget Report'
  }
  // 中文不在「频段」与「链路预算报告」之间断词——那是一个完整的名词短语
  const head = [sat && sat + ' 卫星', bd && bd + ' 频段'].filter(Boolean).join(' ')
  return (head || '卫星') + '链路预算报告'
}

// 默认元信息：能自动填的一律自动填（报告名随卫星与频段走、日期取今天），用户只需要补编号与单位。
// logo：{ dataUrl, w, h } —— 用户上传的台标，贴在三份文件的右上角。矢量图（SVG）在上传时
// 就已在渲染端栅格化成 PNG（Excel 与 Word 的图都只吃位图），故这里一律是 PNG 的 data URL。
// ★ 编制单位一律留空由用户填——软件不替任何人预设单位名。
export function defaultDocInfo(scheme, satName, lang, band) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return {
    title: reportTitle(satName, band, lang),
    docNo: '', classification: '', org: '',
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    logo: null
  }
}

// —— 输入清单（可复算）——
// 直接走各窗自己的 FIELD_GROUPS：那份声明里标签、单位、分组、target 都齐了，报告不再另立一份
// 字段字典（另立必然与表单漂移——表单加一个字段，报告里就少一项，且没人会发现）。
// 取值取「本行真正送进引擎的那份入参」（satParams / linkParams / opt），不是取表单当前值：
// 用户算完又改了表单时，报告写的必须是算出这组结果的那些数。
//
// 'station' 组（地球站库）按 side 拆成发射链/接收链两块并入两端站的块里——库里一份配置同时供着
// 收发两端，平铺成一块的话读者分不清哪几行属于发信站。
const OP_KEYS = { paPowerW: 'powerW' }   // target:'op' 的字段在 opt 里的键名

function fieldValue(f, params, side) {
  const { satParams = {}, linkParams = {}, opt = {} } = params || {}
  if (f.target === 'op') { const k = OP_KEYS[f.key]; return k ? opt[k] : undefined }
  // 收发共用字段（天线口径）：收侧另有引擎键名 rxKey
  const key = (side === 'rx' && f.rxKey) ? f.rxKey : f.key
  if (f.target === 'sat') return satParams[key]
  const v = linkParams[key]
  return v === undefined ? satParams[key] : v
}
const emptyVal = (v) => (v === undefined || v === null || v === '' || v === '—')

function digestRows(fields, params, side, t) {
  const rows = []
  for (const f of fields || []) {
    if (f.target === 'meta') continue          // 界面专用（库条目选择列），不是物理参数
    const v = fieldValue(f, params, side)
    if (emptyVal(v)) continue
    rows.push({ label: t(f.label), value: String(v), unit: f.unit || '' })
  }
  return rows
}

// groups: 各窗的 FIELD_GROUPS；params: { satParams, linkParams, opt }
// 返回 [{ title, rows:[{label,value,unit}] }]，空块自动略去。
export function buildInputDigest(groups, params, lang) {
  const t = (s) => translate(s, lang)
  const g = (k) => (groups || []).find((x) => x.key === k)
  const esFields = ((g('station') || {}).fields) || []
  const bySide = (s) => esFields.filter((f) => f.side === s || f.side === 'common')
  const blocks = []
  const push = (key, title, rows) => { if (rows.length) blocks.push({ key, title, rows }) }

  for (const grp of groups || []) {
    if (!grp || grp.key === 'station') continue      // 地球站库随两端站块一起出
    const rows = digestRows(grp.fields, params, grp.key === 'downlink' ? 'rx' : 'tx', t)
    if (grp.key === 'uplink') push(grp.key, t(grp.title), rows.concat(digestRows(bySide('tx'), params, 'tx', t)))
    else if (grp.key === 'downlink') push(grp.key, t(grp.title), rows.concat(digestRows(bySide('rx'), params, 'rx', t)))
    else push(grp.key, t(grp.title), rows)
  }
  return blocks
}

// 计算设置块：计算方式、目标余量、过载余量——它们不在 FIELD_GROUPS 里（是求解策略，不是链路参数），
// 但少了它整份预算就复算不出来（同一组参数，不同计算方式给的是不同的数）。
// solveMode：再生式窗口的「计算方式」一栏报的是链路类型（再生式上行/下行/星间），求解策略另占一行。
export function calcBlock(calc, lang) {
  const t = (s) => translate(s, lang)
  const rows = []
  if (calc.mode) rows.push({ label: t('计算方式'), value: calc.mode, unit: '' })
  if (calc.solveMode) rows.push({ label: t('求解方式'), value: calc.solveMode, unit: '' })
  if (!emptyVal(calc.targetMargin)) rows.push({ label: t('目标系统余量'), value: String(calc.targetMargin), unit: 'dB' })
  if (!emptyVal(calc.overDb)) rows.push({ label: t('过载门限'), value: String(calc.overDb), unit: 'dB' })
  return rows.length ? { key: 'calc', title: t('计算设置'), rows } : null
}

// —— 中英对照（报告自己的语汇；输入清单的字段标签也走这里）——
// 与 shared/lbDocI18n.js 同一套办法：中文原文为键、未命中原样返回。分成两份是因为这一份
// 只在导出报告时用得着，混进「详细预算」那份会让那份字典的用途糊掉。
export const LB_REPORT_EN = {
  // 报告结构
  '链路预算报告': 'Link Budget Report', '总报告': 'Master Report', '目录': 'Contents',
  '报告说明': 'Scope & Basis', '场景与假设': 'Scenario & Assumptions', '链路清单': 'Link Schedule',
  '逐参数对照': 'Parameter Comparison', '容量与统计': 'Capacity & Statistics',
  '输入参数': 'Input Parameters', '详情索引': 'Detail Index', '计算模型与参考': 'Models & References',
  '几何关系': 'Geometry', '链路详情': 'Link Details',
  '日期': 'Date', '密级': 'Classification', '报告编号': 'Document No.',
  '编制单位': 'Organisation', '报告名称': 'Report Title',
  '生成时间': 'Generated', '软件版本': 'Software Version',
  '序号': 'No.', '链路': 'Link', '发信站': 'Tx Station', '收信站': 'Rx Station',
  // 模板封面栏名
  '名称': 'Title', '编号': 'Document No.',
  // 方法学章节
  '计算链路与口径': 'Computation Chain and Conventions', '引用建议书与标准': 'Normative References',
  '物理常数与基准': 'Physical Constants and Reference Values', '本报告中的用途': 'Use in this report',
  '符号': 'Symbol', '取值': 'Value', '出处': 'Source', '类别': 'Category',
  'Word（.docx）': 'Word (.docx)',
  // 导出对话框
  '导出报告': 'Export Report', '输出': 'Output', '包含图件': 'Include figures',
  '取消': 'Cancel', '关闭': 'Close', '生成中…': 'Generating…', '生成报告': 'Generate', '条链路': 'links',
  '字体': 'Font', '语言': 'Language',
  '选择图片': 'Choose image', '更换': 'Replace', '移除': 'Remove',
  '贴在每一页右上角': 'Placed at the top-right of every page and worksheet; remembered across windows',
  '图片读取失败': 'Could not read the image',
  '第一张表为总报告，其后每条链路一张详情表': 'First sheet is the master report; one detail sheet per link follows',
  '封面 / 目录 / 总报告为 A4 纵向，逐链路详情为 A4 横向': 'Cover / contents / master report in A4 portrait; per-link details in A4 landscape',
  '图表区已关闭（功能区「视图 → 图表」），本次导出没有图': 'The figure pane is hidden (View → Figures); this export will contain no figures',
  '逐条链路生成地理场图与链路视图（每条链路需重新执行一次网格扫描，链路较多时耗时增加）': 'Renders the geographic field and link view for every link (each re-runs a full grid sweep — slow with many links)',
  '卫星': 'Satellite', '频段': 'Band', '体制': 'Scheme', '计算方式': 'Calculation Mode',
  '参数': 'Parameter', '数值': 'Value', '单位': 'Unit', '说明': 'Note',
  '计算失败': 'Calculation failed', '本条链路未计算成功，故无结果与图': 'This link did not compute successfully; no results or figures are available.',
  '图': 'Figure', '表': 'Table', '目标系统余量': 'Target System Margin', '过载门限': 'Overload Threshold',
  '求解方式': 'Solve Mode',
  '计算设置': 'Calculation Settings', '载波与调制': 'Carrier & Modulation', '地球站': 'Earth Station',
  '卫星与转发器': 'Satellite & Transponder', '上行 · 发信站': 'Uplink · Tx Station',
  '下行 · 收信站': 'Downlink · Rx Station', '卫星群': 'Satellite Group', '发信站群': 'Tx Stations',
  '收信站群': 'Rx Stations', '星间链路群': 'Inter-Satellite Links', '星间激光链路群': 'Optical ISLs',
  // 输入清单里的字段标签（FIELD_GROUPS 的 label，三窗共用一份）
  '信息速率': 'Information Rate', '调制方式': 'Modulation', 'FEC 码率': 'FEC Rate', '门限': 'Threshold',
  '误码率 10⁻ⁿ': 'BER 10⁻ⁿ', '扩频增益': 'Spreading Gain', '滚降系数 (1+α)': 'Roll-off (1+α)',
  '帧效率': 'Frame Efficiency', '门限模式': 'Threshold Mode', '系统余量': 'System Margin',
  '天线口径': 'Antenna Diameter', '天线效率': 'Antenna Efficiency', '功放功率预设': 'HPA Power (preset)',
  '功放回退': 'HPA Back-off', '馈线损耗': 'Feeder Loss', 'UPC': 'UPC', 'UPC值': 'UPC Value',
  '其他损耗': 'Other Losses', '天线噪温模式': 'Antenna Noise Temp. Mode', '天线噪温': 'Antenna Noise Temp.',
  '接收机噪温': 'Receiver Noise Temp.', '卫星名称': 'Satellite Name', '工作频段': 'Frequency Band',
  '上行频率': 'Uplink Frequency', '上行极化': 'Uplink Polarisation', '下行频率': 'Downlink Frequency',
  '下行极化': 'Downlink Polarisation', '定点轨道经度': 'Orbital Longitude', 'SFDref': 'SFDref',
  'G/Tref': 'G/Tref', 'Tpdr.带宽': 'Tpdr. Bandwidth', 'Tpdr. IBO': 'Tpdr. IBO', 'Tpdr. OBO': 'Tpdr. OBO',
  'Tpdr. C/IM': 'Tpdr. C/IM', '上行C/ACI': 'Uplink C/ACI', '上行C/ASI': 'Uplink C/ASI',
  '上行C/XPI': 'Uplink C/XPI', 'HPA C/IM': 'HPA C/IM', '下行C/ACI': 'Downlink C/ACI',
  '下行C/ASI': 'Downlink C/ASI', '下行C/XPI': 'Downlink C/XPI', '地球站位置': 'Station Location',
  '经度': 'Longitude', '纬度': 'Latitude', '海拔': 'Altitude', '卫星G/T': 'Satellite G/T',
  'R0.01%': 'R0.01%', '可用度': 'Availability', '卫星EIRP': 'Satellite EIRP',
  '轨道高度': 'Orbit Altitude', '轨道倾角': 'Inclination', '最低仰角': 'Min Elevation',
  '卫星编号': 'NORAD ID', '轨道根数': 'Orbital Elements'
}
export function translate(s, lang) {
  if (lang !== 'en' || !s) return s
  return LB_REPORT_EN[s] !== undefined ? LB_REPORT_EN[s] : s
}
export const reportT = (lang) => (s) => translate(s, lang)

// —— 计算模型与参考（报告的方法学章节）——
// 这一章是报告的权威性所在：第三方要能据此复核每一个数字是怎么来的。三部分——
//   ① 计算链路与口径：逐段说明链路方程的组成、干扰与噪声的合成方式、可用度口径；
//   ② 引用建议书与标准：编号 + 名称 + 在本报告中的具体用途（版本号对得上引擎里实现的那一版）；
//   ③ 物理常数与基准：报告里出现的每个常数的取值与出处。
// 只写引擎真正做了的事：没实现的不写、没核实的不写（宁可少一条，不可多一条错的）。
export function methodology(scheme, lang) {
  const en = lang === 'en'
  const ngso = scheme.orbitType === 'NGSO' || scheme.orbitType === 'REGEN'
  const regen = scheme.orbitType === 'REGEN'
  const isl = regen && (scheme.regenMode === 'isl' || scheme.regenMode === 'laser')
  const laser = regen && scheme.regenMode === 'laser'

  // ① 计算链路与口径
  const basis = []
  const put = (zh, ezh) => basis.push({ title: en ? ezh[0] : zh[0], text: en ? ezh[1] : zh[1] })

  put(['链路方程与级联',
    '链路预算按逐段功率级联计算，每一行均可由上一行手工推算：发射端由功放输出经回退、馈线损耗与发射天线增益得到 EIRP；'
    + '经自由空间损耗与大气路径衰减（气体吸收、云衰、雨衰及其他综合损耗）得到接收端载波电平；与接收品质因数 G/T 合成载波噪声比 '
    + 'C/T，再由玻尔兹曼常数与载波噪声带宽折算为 C/N。' + (regen ? '再生式体制上下行独立解调，故总载噪比即本段自身的 C/(N+I)。'
      : '透明转发体制的上行与下行 C/N 按功率倒数相加合成总载噪比，转发器工作点由饱和通量密度 SFD 与输入/输出回退（IBO/OBO）确定。')],
  ['Link equation and cascade',
    'The budget is computed as a term-by-term power cascade in which every line can be re-derived by hand from the line above: '
    + 'transmit EIRP follows from HPA output, back-off, feeder loss and transmit antenna gain; the received carrier level follows '
    + 'from free-space loss and the atmospheric path (gaseous absorption, cloud and rain attenuation, plus lumped other losses); '
    + 'the carrier-to-noise-temperature ratio C/T follows from the receive figure of merit G/T, and C/N from Boltzmann’s constant '
    + 'and the carrier noise bandwidth. ' + (regen ? 'In a regenerative payload each hop is demodulated on board, so the total ratio is the C/(N+I) of the hop itself.'
      : 'For a transparent (bent-pipe) payload the uplink and downlink C/N are combined by reciprocal power addition, with the transponder operating point set by the saturation flux density (SFD) and the input/output back-off (IBO/OBO).')])

  put(['干扰合成',
    '干扰按功率与热噪声一并合成为 C/(N+I)：计入邻道干扰 C/ACI、邻星干扰 C/ASI、交叉极化干扰 C/XPI、'
    + '发射机高功放互调 C/IM 与转发器互调 C/IM 各项，各项以其载干比的功率倒数求和后与 C/N 合成。各项取值为工程给定的系统级参数。'],
  ['Interference aggregation',
    'Interference is aggregated with thermal noise into C/(N+I): adjacent-channel (C/ACI), adjacent-satellite (C/ASI), '
    + 'cross-polarisation (C/XPI), HPA intermodulation and transponder intermodulation contributions are summed as reciprocal '
    + 'carrier-to-interference power ratios and then combined with C/N. Each ratio is a system-level input value.'])

  put(['噪声温度合成',
    '接收系统噪声温度由天线噪温、接收机噪温与馈线损耗折算合成。天线噪温可取手工给定值，也可按 ITU-R P.618-14 §3 '
    + '由晴空路径衰减与链路仰角实时求取天空噪温，并叠加 25 K 的地面旁瓣拾取常数。降雨工况下另计降雨与云层的介质辐射噪声'
    + '（平均辐射温度 275 K，经馈线折算入系统噪温），该项与雨衰共同构成下行链路劣化。'],
  ['Noise temperature budget',
    'System noise temperature is composed of antenna noise, receiver noise and the feeder-loss referral. Antenna noise is either '
    + 'entered manually or derived in real time from the clear-sky path attenuation and link elevation per ITU-R P.618-14 §3, with a '
    + '25 K ground-pickup constant added. Under rain, the medium-radiated noise of rain and cloud is added as well (mean radiating '
    + 'temperature 275 K, referred through the feeder), which together with rain attenuation constitutes the downlink degradation.'])

  put(['可用度与统计口径',
    '传播余量按年时间百分比统计：给定链路可用度对应的超越时间百分比即雨衰预测的输入。上行与下行各自独立统计，'
    + '系统可用度由两段联合给出。降雨率取 ITU-R P.837-7 的 0.01% 超越降雨率（可按站址自动取值或手工指定）。'
    + (ngso ? '非静止轨道链路的仰角随时间变化，故按 ITU-R P.618-14 §8 的统计口径处理：将可服务仰角区间分箱，'
      + '以各箱的可见时间占比对该仰角下的超越时间占比加权求和，并以「等效仰角」表述结果——该仰角不对应任何瞬时几何。' : '')],
  ['Availability and statistical basis',
    'Propagation margins are stated as annual time percentages: the exceedance percentage corresponding to the required link '
    + 'availability is the input to the rain-attenuation prediction. Uplink and downlink are treated independently and the system '
    + 'availability follows from the two hops jointly. Rain rate is the 0.01 % exceedance value of ITU-R P.837-7 (taken automatically '
    + 'from the site coordinates or entered manually).'
    + (ngso ? ' For non-GSO links the elevation angle varies with time, so the statistics follow ITU-R P.618-14 §8: the serviceable '
      + 'elevation range is binned, each bin’s visibility fraction weights the exceedance fraction at that elevation, and the result is '
      + 'expressed as an "equivalent elevation" that corresponds to no instantaneous geometry.' : '')])

  put(['几何与轨道',
    ngso
      ? '轨道由 NORAD 两行根数 / OMM 经 SGP4/SDP4 传播至 TEME 惯性系，站址取 WGS84 椭球坐标；'
        + (isl ? '星间几何在地心固连系（ECEF）内解算，互视判据为视线段最近地心距不小于地球半径加大气余量。'
          : '站星几何取满足最低工作仰角的最差工况（最大斜距）。')
      : '静止轨道几何按定点轨道经度与站址经纬度的闭式球面解算，取斜距、仰角与方位角；单程时延由斜距与光速给出。'],
  ['Geometry and orbits',
    ngso
      ? 'Orbits are propagated from NORAD two-line elements / OMM by SGP4/SDP4 into the TEME inertial frame; facility positions use '
        + 'WGS84 ellipsoidal coordinates. ' + (isl ? 'Inter-satellite geometry is solved in the Earth-fixed (ECEF) frame; mutual visibility '
          + 'requires the minimum geocentric distance of the line-of-sight segment to be no less than the Earth radius plus an atmospheric margin.'
          : 'Station–satellite geometry is taken at the worst case (maximum slant range) satisfying the minimum operating elevation.')
      : 'Geostationary geometry is solved in closed form on the sphere from the orbital longitude and the site coordinates, giving slant '
        + 'range, elevation and azimuth; the one-way delay follows from slant range and the speed of light.'])

  if (laser) {
    put(['光学链路口径',
      '星间激光链路按第一性原理的光功率预算计算：发射光功率经发射光学增益、指向损耗、自由空间衰减与接收光学效率得到接收光功率，'
      + '与由光子/比特灵敏度导出的所需接收功率相比得到余量；相干多普勒按视向速率与光频折算。'],
    ['Optical link basis',
      'The optical inter-satellite link is computed as a first-principles optical power budget: transmit optical power through transmit '
      + 'optical gain, pointing loss, free-space attenuation and receive optical efficiency yields the received power, which is compared '
      + 'with the required power derived from the photons-per-bit sensitivity; the coherent Doppler shift follows from the range rate and the optical frequency.'])
  }

  put(['数值口径',
    '全篇数值不作合格性判定，仅给出计算结果与其单位；显示单位在同一指标内跨链路统一选档（如 W/mW/kW、kHz/MHz/GHz），'
    + '级联算式行不作单位换算以保证逐行可手算。'],
  ['Numerical conventions',
    'No pass/fail judgement is made anywhere in this report; only computed values and their units are given. Display units are chosen '
    + 'per quantity consistently across links (e.g. W/mW/kW, kHz/MHz/GHz); cascade rows are never unit-converted so that each line remains hand-checkable.'])

  // ② 引用建议书与标准（分组 + 具体用途）
  const G = (zh, e) => (en ? e : zh)
  const refGroups = [
    {
      group: G('传播与衰减', 'Propagation and attenuation'),
      items: [
        { id: 'ITU-R P.618-14', title: G('地球—空间链路传播数据与预测方法', 'Propagation data and prediction methods required for the design of Earth-space telecommunication systems'), use: G('雨衰预测、雨致去极化 XPD、天空噪温（§3）' + (ngso ? '、非静止轨道仰角统计（§8）' : ''), 'Rain attenuation, rain-induced XPD, sky-noise temperature (§3)' + (ngso ? ', non-GSO elevation statistics (§8)' : '')) },
        { id: 'ITU-R P.676-13', title: G('大气气体衰减及相关效应', 'Attenuation by atmospheric gases and related effects'), use: G('氧气与水汽的路径吸收衰减（逐线法）', 'Oxygen and water-vapour path absorption (line-by-line method)') },
        { id: 'ITU-R P.837-7', title: G('降雨特性建模', 'Characteristics of precipitation for propagation modelling'), use: G('站址 0.01% 超越降雨率 R0.01', 'Site 0.01 % exceedance rain rate R0.01') },
        { id: 'ITU-R P.838-3', title: G('雨衰比衰减系数模型', 'Specific attenuation model for rain for use in prediction methods'), use: G('由降雨率与频率、极化求比衰减 γR', 'Specific attenuation γR from rain rate, frequency and polarisation') },
        { id: 'ITU-R P.839-4', title: G('降雨高度模型', 'Rain height model for prediction methods'), use: G('等效降雨高度 hR 与倾斜路径长度', 'Effective rain height hR and slant path length') },
        { id: 'ITU-R P.840-9', title: G('云雾衰减', 'Attenuation due to clouds and fog'), use: G('液态水含量统计给出的云衰减', 'Cloud attenuation from liquid-water content statistics') },
        { id: 'ITU-R P.836-6', title: G('水汽：地面密度与柱含量', 'Water vapour: surface density and total columnar content'), use: G('气体衰减所需的水汽密度', 'Water-vapour density input to the gaseous attenuation') },
        { id: 'ITU-R P.453-14', title: G('无线电折射率及其对传播的影响', 'The radio refractive index: its formula and refractivity data'), use: G('折射率相关量的取值基准', 'Refractivity reference data') }
      ]
    },
    {
      group: G('噪声与系统', 'Noise and system'),
      items: [
        // S.465-6 与 S.524-9 两条已撤（2026-08-07）：链路预算侧唯一的消费点是「邻星离轴口径」，
        // 那组量随 deltaTheta 一并移除，本报告不再有任何数出自这两份建议书。干扰分析模块仍在用它们，
        // 但那是另一份报告的参考文献——列在这里就是给读者一个本报告根本没算的出处。
        { id: 'ITU-R P.372-16', title: G('无线电噪声', 'Radio noise'), use: G('天空噪声温度与噪声环境基准', 'Sky-noise temperature and noise environment reference') }
      ]
    }
  ]
  if (ngso) {
    refGroups.push({
      group: G('轨道与时空基准', 'Orbits and reference frames'),
      items: [
        { id: 'SGP4 / SDP4 (Hoots & Roehrich, Spacetrack Report No. 3)', title: G('NORAD 通用摄动轨道传播模型', 'NORAD general perturbations orbit propagation model'), use: G('由两行根数 / OMM 传播至 TEME 惯性系', 'Propagation from TLE/OMM into the TEME inertial frame') },
        { id: 'CCSDS 502.0-B-3', title: G('轨道数据报文（OMM）', 'Orbit Data Messages (Orbit Mean-Elements Message)'), use: G('星历数据交换格式', 'Ephemeris data interchange format') },
        { id: 'WGS 84 (NIMA TR8350.2)', title: G('世界大地测量系统 1984', 'World Geodetic System 1984'), use: G('站址坐标与地球椭球基准', 'Facility coordinates and Earth ellipsoid reference') }
      ]
    })
  }
  refGroups.push({
    group: G('体制与通信标准', 'Air interface and system standards'),
    items: [
      { id: 'ETSI EN 302 307-1/-2 (DVB-S2 / S2X)', title: G('数字卫星广播第二代及其扩展', 'Second generation framing, coding and modulation for satellite broadcasting and extensions'), use: G('调制与前向纠错的门限 Es/N₀ 与频谱效率基准', 'Threshold Es/N₀ and spectral efficiency reference for modulation and FEC') },
      { id: '3GPP TS 38.101-5 / TR 38.821', title: G('非地面网络（NTN）射频与体系', 'Non-terrestrial networks: radio transmission/reception and solutions'), use: G('NTN 载波与信道带宽的参数基准', 'Parameter reference for NTN carriers and channel bandwidths') }
    ]
  })

  // ③ 物理常数与基准
  const constants = [
    { name: G('玻尔兹曼常数', 'Boltzmann constant'), symbol: 'k', value: '−228.6', unit: 'dBW/(K·Hz)', src: G('10·lg(1.380649×10⁻²³)', '10·lg(1.380649×10⁻²³)') },
    { name: G('真空光速', 'Speed of light in vacuum'), symbol: 'c', value: '299 792.458', unit: 'km/s', src: 'SI' },
    { name: G('地球赤道半径', 'Earth equatorial radius'), symbol: 'Re', value: '6 378.137', unit: 'km', src: 'WGS 84' },
    { name: G('地心引力常数', 'Earth gravitational constant'), symbol: 'μ', value: '398 600.4418', unit: 'km³/s²', src: 'WGS 84 / EGM' },
    { name: G('雨介质平均辐射温度', 'Mean radiating temperature of rain medium'), symbol: 'T_mr', value: '275', unit: 'K', src: 'ITU-R P.618-14' },
    { name: G('地面旁瓣拾取噪温', 'Ground sidelobe pickup noise temperature'), symbol: 'T_gnd', value: '25', unit: 'K', src: G('ITU-R P.618-14 §3（自动天线噪温）', 'ITU-R P.618-14 §3 (automatic antenna noise)') },
    { name: G('参考噪声温度', 'Reference noise temperature'), symbol: 'T₀', value: '290', unit: 'K', src: G('噪声系数折算基准', 'Noise-figure conversion reference') }
  ]
  return { basis, refGroups, constants }
}

// —— 标签包 ——
// 两个渲染器（主进程 exceljs / 打印窗 HTML）都不认中文原文、也不各带一份字典：报告里要用到的
// 每一个标签在这里按当前语言翻好后随模型带走。主进程 report.js 里原有的汇总/几何表仍走它自己的
// STR（那几张表早于本模块存在，译法已与 WF_DICT 对齐），新增的部分一律取本包。
export function labelBundle(lang) {
  const t = (s) => translate(s, lang)
  return {
    master: t('总报告'), contents: t('目录'), scope: t('报告说明'),
    scenario: t('场景与假设'), schedule: t('链路清单'), compare: t('逐参数对照'),
    capacity: t('容量与统计'), inputs: t('输入参数'), index: t('详情索引'),
    refs: t('计算模型与参考'), geometry: t('几何关系'), detail: t('链路详情'),
    mBasis: t('计算链路与口径'), mRefs: t('引用建议书与标准'), mConst: t('物理常数与基准'),
    mId: t('编号'), mTitle: t('名称'), mUse: t('本报告中的用途'),
    mSymbol: t('符号'), mValue: t('取值'), mSrc: t('出处'), mGroup: t('类别'),
    results: t('详细计算结果'), figures: t('图件'),
    no: t('序号'), link: t('链路'), tx: t('发信站'), rx: t('收信站'),
    param: t('参数'), value: t('数值'), unit: t('单位'), note: t('说明'),
    title: t('名称'), docNo: t('编号'), org: t('编制单位'),
    classification: t('密级'),
    date: t('日期'), generated: t('生成时间'), appVersion: t('软件版本'),
    scheme: t('体制'), satellite: t('卫星'), band: t('频段'), calcMode: t('计算方式'),
    calcFailed: t('计算失败'), noResult: t('本条链路未计算成功，故无结果与图'),
    figure: t('图'), table: t('表'), continued: lang === 'en' ? '(continued)' : '（续）',
    // 三线表列头（与屏幕瀑布表同一套译法，见 shared/lbDocI18n.js）
    uplink: lang === 'en' ? 'Uplink' : '上行', downlink: lang === 'en' ? 'Downlink' : '下行',
    total: lang === 'en' ? 'Total' : '合计',
    // 封面栏名（带全角空格，与模板一致：模板封面顶上就是「密级：」「文档编号：」两行）
    cvDocNo: lang === 'en' ? 'Doc. No.' : '文档编号',
    cvClass: lang === 'en' ? 'Classification' : '密　　级'
  }
}

// —— 报告模型 ——
// links 由各窗按自己的数据结构组装好后传入（见各窗 buildReportLinks）：
//   { no, rowId, txName, rxName, ok, error, data, segments, inputs, figures, geom, islGeo }
export function buildReportModel(o) {
  const {
    lang = 'zh', orbitType = 'GEO', regenMode = 'uplink',
    doc = {}, links = [], calc = {}, appVersion = '', satelliteName = '', frequencyBand = ''
  } = o || {}
  const scheme = schemeOf(orbitType, regenMode)
  return {
    v: 1,
    lang,
    scheme,
    t: labelBundle(lang),
    doc: Object.assign({}, defaultDocInfo(scheme, satelliteName, lang, frequencyBand), doc, {
      appVersion,
      generatedAt: new Date().toISOString()
    }),
    calc: Object.assign({ satelliteName, frequencyBand }, calc),
    links,
    method: methodology(scheme, lang)
  }
}

// 图题注：「图 3-2　地理场图 · 链路余量」——章号取链路序号，两个渲染器共用一套编号，
// 于是 Excel 里的图和 PDF 里的图叫同一个名字。
export function figureCaption(linkNo, idx, title, lang) {
  const t = translate('图', lang)
  return lang === 'en' ? `Figure ${linkNo}-${idx + 1}  ${title}` : `${t} ${linkNo}-${idx + 1}　${title}`
}
export function tableCaption(no, title, lang) {
  const t = translate('表', lang)
  return lang === 'en' ? `Table ${no}  ${title}` : `${t} ${no}　${title}`
}
