// 链路预算「报告」的单一真值源（GSO / NGSO / 再生式 / 端到端 四窗共用）。
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

// 参考文献只从标准台账（packages/core/data/standards.json）出，见 methodology ② 与 shared/stdLedger.js
import { reportRefGroups } from './stdLedger.js'

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
  REGEN: ['再生式（星上处理）体制', 'Regenerative (On-Board Processing)'],
  E2E: ['端到端多跳 / 混合转发', 'End-to-End Multi-Hop / Hybrid Relay']
}
const REGEN_NAME = {
  uplink: ['上行（地球站 → 卫星）', 'Uplink (Earth Station → Satellite)'],
  downlink: ['下行（卫星 → 地球站）', 'Downlink (Satellite → Earth Station)'],
  isl: ['星间微波链路', 'Inter-Satellite Link (RF)'],
  laser: ['星间激光链路', 'Inter-Satellite Link (Optical)']
}
// 短名：Excel 工作表名（上限 31 字符）与多模块报告里并列时用
const REGEN_SHORT = {
  uplink: ['上行', 'Uplink'],
  downlink: ['下行', 'Downlink'],
  isl: ['星间微波', 'ISL RF'],
  laser: ['星间激光', 'ISL Optical']
}
export const REGEN_MODE_KEYS = ['uplink', 'downlink', 'isl', 'laser']
export const regenModeName = (mode, lang) => (REGEN_NAME[mode] || REGEN_NAME.uplink)[lang === 'en' ? 1 : 0]
export const regenModeShort = (mode, lang) => (REGEN_SHORT[mode] || REGEN_SHORT.uplink)[lang === 'en' ? 1 : 0]
// 再生式的模式参数既可以是一个 key（一份报告只讲一段链路），也可以是一组 key（一份配置装了几个
// 计算模块，报告按模块分节）。规整成去重后的合法 key 列表；空 → ['uplink']（旧口径的缺省）。
function normRegenModes(regenMode) {
  const list = Array.isArray(regenMode) ? regenMode : [regenMode]
  const out = []
  for (const k of list) if (REGEN_NAME[k] && !out.includes(k)) out.push(k)
  return out.length ? out : ['uplink']
}

export function schemeOf(orbitType, regenMode) {
  const ot = (orbitType === 'NGSO' || orbitType === 'REGEN' || orbitType === 'E2E') ? orbitType : 'GEO'
  const [zh, en] = SCHEME_NAME[ot]
  const modes = ot === 'REGEN' ? normRegenModes(regenMode) : []
  // 多模块：副标题把各段并列（「上行（…） · 星间微波链路 · 下行（…）」），次序即报告分节次序
  const subs = modes.map((k) => REGEN_NAME[k])
  return {
    orbitType: ot,
    // regenMode 仍是单个 key（首个模块）——老消费者（几何表 / 汇总行）按它走；多模块时各节自带 regenMode
    regenMode: modes[0] || '',
    regenModes: modes,
    label: zh, labelEn: en,
    subLabel: subs.map((s) => s[0]).join(' · '), subLabelEn: subs.map((s) => s[1]).join(' · ')
  }
}
export const schemeName = (scheme, lang) => (lang === 'en' ? scheme.labelEn : scheme.label)
export const schemeSub = (scheme, lang) => (lang === 'en' ? scheme.subLabelEn : scheme.subLabel)

// 默认报告名：正式技术文档的取名法「对象 + 范围 + 文档类型」，
// 即「<卫星> 卫星 <频段> 频段链路预算报告」。封面上它是唯一的一行主标题，故必须自己说全，
// 不靠副标题补充（用户 2026-08-02 定：一个醒目的主标题即可）。
// 端到端链没有「那颗卫星」也没有「那个频段」——一条链跨着几颗星、上下行各一个频段，
// 拿其中任何一个来取名都是以偏概全。故本体制的默认名不带对象与范围，只说文档类型。
export function reportTitle(satName, band, lang, orbitType) {
  if (orbitType === 'E2E') return lang === 'en' ? 'End-to-End Link Budget Report' : '端到端链路预算报告'
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
    title: reportTitle(satName, band, lang, scheme && scheme.orbitType),
    docNo: '', classification: '', org: '',
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    logo: null
  }
}

// —— 报告名称的「钉住」（导出对话框按窗口存一份；全报告与 SLA 报告各存各的，规则相同）——
// 报告名称走自动命名的规矩（同资源库条目名）：没改过就随当前卫星 / 频段 / 体制 / 语言重算，改过就钉住。
// ★ 钉住的名字只对「它替换掉的那个自动名」有效：自动名变了（换了卫星 / 频段 / 语言）就回到新的自动名——
//   否则 A 星改过一次名，切到 B 星导出时文件名已是 B 星，封面、Excel 首行、PDF 书签却仍印 A 星的名字。
//   各自动名下的钉住名分开记，切回 A 星，A 星那个名字还在。
// stored：本地存的 { title, titleDefault, pins }；老版本只存了一对 { title, titleDefault }，当作只钉了一条读进来。
const TITLE_PIN_MAX = 32
function titlePins(stored) {
  const pins = {}
  if (!stored || typeof stored !== 'object') return pins
  if (stored.pins && typeof stored.pins === 'object') {
    for (const k of Object.keys(stored.pins)) {
      const v = stored.pins[k]
      if (typeof v === 'string' && v.trim() && v.trim() !== k) pins[k] = v
    }
  } else if (typeof stored.title === 'string' && stored.title.trim() && stored.titleDefault && stored.title !== stored.titleDefault) {
    pins[stored.titleDefault] = stored.title
  }
  return pins
}
// 打开对话框时显示的名称：当前自动名名下钉过就用钉住的，否则就是自动名
export function resolveReportTitle(stored, autoTitle) {
  return titlePins(stored)[autoTitle] || autoTitle
}
// 存盘：这次的名称记到当前自动名名下（与自动名相同或留空＝没钉，删掉这一条），只留最近 TITLE_PIN_MAX 条。
// title / titleDefault 两键照旧写——老版本读这份存档时行为与从前一样。
export function pinReportTitle(stored, autoTitle, title) {
  const pins = titlePins(stored)
  const t = String(title == null ? '' : title)
  delete pins[autoTitle]
  if (t.trim() && t.trim() !== autoTitle) pins[autoTitle] = t
  const keys = Object.keys(pins)
  for (let i = 0; i < keys.length - TITLE_PIN_MAX; i++) delete pins[keys[i]]
  return { title: t, titleDefault: autoTitle, pins }
}

// —— 输入清单（可复算）——
// 直接走各窗自己的 FIELD_GROUPS：那份声明里标签、单位、分组、target 都齐了，报告不再另立一份
// 字段字典（另立必然与表单漂移——表单加一个字段，报告里就少一项，且没人会发现）。
// 取值取「本行真正送进引擎的那份入参」（satParams / linkParams / opt），不是取表单当前值：
// 用户算完又改了表单时，报告写的必须是算出这组结果的那些数。
//
// 'station' 组（地球站库）按 side 拆成发射链/接收链两块并入两端站的块里——库里一份配置同时供着
// 收发两端，平铺成一块的话读者分不清哪几行属于发信站。
// target:'op' 的字段在 opt 里的键名。功放功率预设 GSO / NGSO 叫 paPowerW、再生式叫 opPowerW，进求解器都是 opt.powerW
// （只有「设置功放功率 / 设置工作点」方式才带；设置余量时功放是反解出来的，opt 里没有，这一行自然不出）
const OP_KEYS = { paPowerW: 'powerW', opPowerW: 'powerW' }

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

// 存值是代码、界面上给人看的是名字的字段：值 → 显示名。名字本身中英同形（Eb/N₀），不再过 translate。
const VALUE_NAMES = {
  noiseRatioMode: { ebno: 'Eb/N₀', esno: 'Es/N₀', snr: 'SNR' }
}
// 一格的显示串（null = 这一项不进清单）：
//   · 对象 / 数组不是一格写得下的东西——3GPP 的物理层描述子（phy）就是，其各项已在详细预算「载波」段逐行列出；
//   · 代码值换显示名（门限模式 ebno → Eb/N₀）；下拉选项若是 { value, label } 取 label；
//   · 中文下拉值（UPC「否 / 是 / 自定义」、天线噪温模式「自动 / 自定义」）随报告语言翻；其余值（站名、数值）原样。
function displayValue(f, v, t) {
  if (v !== null && typeof v === 'object') return null
  if (typeof v === 'boolean') return t(v ? '是' : '否')
  const s = String(v)
  const names = VALUE_NAMES[f.key]
  if (names && Object.prototype.hasOwnProperty.call(names, s)) return names[s]
  const opt = Array.isArray(f.options) ? f.options.find((o) => o && typeof o === 'object' && String(o.value) === s) : null
  if (opt && opt.label != null) return t(String(opt.label))
  return f.type === 'select' ? t(s) : s
}

function digestRows(fields, params, side, t) {
  const rows = []
  for (const f of fields || []) {
    if (!f || f.target === 'meta') continue    // 界面专用（库条目选择列），不是物理参数
    const v = fieldValue(f, params, side)
    if (emptyVal(v)) continue
    const s = displayValue(f, v, t)
    if (emptyVal(s)) continue
    rows.push({ label: t(f.label), value: s, unit: f.unit || '' })
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
    const title = t(grp.title || '')
    const rows = digestRows(grp.fields, params, grp.key === 'downlink' ? 'rx' : 'tx', t)
    if (grp.key === 'uplink') push(grp.key, title, rows.concat(digestRows(bySide('tx'), params, 'tx', t)))
    else if (grp.key === 'downlink') push(grp.key, title, rows.concat(digestRows(bySide('rx'), params, 'rx', t)))
    else push(grp.key, title, rows)
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
  // 服务等级指标节。★ 报告里不叫「SLA 建议」：那是工作台里的说法（工具算出建议、工程师可改），
  // 印进交付文档的是【已定稿的指标】，再写「建议」既贬低了它、读起来也像软件在替甲方拿主意。
  '服务等级指标（SLA）': 'Service Level Metrics (SLA)',
  'SLA 建议': 'SLA Recommendations', '条款': 'Clause', '计算依据': 'Basis',
  '建议值': 'Recommended', '采用值': 'Adopted', 'SLA 参数': 'SLA Parameters',
  '含服务等级指标（SLA）': 'Include service level metrics (SLA)',
  '按各链路勾选的条款出「服务等级指标」一节：总报告一张矩阵，逐链路详情一张明细表':
    'Adds a Service Level Metrics section from the clauses ticked on each link: one matrix in the master report and one detail table per link',
  '没有任何链路勾选了 SLA 条款': 'No SLA clauses are ticked on any link',
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
  // 导出报告对话框「字体」三档
  '西文': 'Latin', '中文正文': 'Chinese Body', '中文标题': 'Chinese Headings',
  'Excel 与 Word 仅写入字体名；PDF 用本机字体': 'Excel and Word carry font names only; PDF uses fonts installed on this machine',
  '选择图片': 'Choose image', '更换': 'Replace', '移除': 'Remove',
  '贴在每一页右上角': 'Placed at the top-right of every page and worksheet; remembered across windows',
  '图片读取失败': 'Could not read the image',
  '第一张表为总报告，其后每条链路一张详情表': 'First sheet is the master report; one detail sheet per link follows',
  '第一张表为总报告，其后为几何关系表与逐链路详情表': 'First sheet is the master report, followed by the geometry sheet(s) and one detail sheet per link',
  '服务等级指标总表 · 指标定义 · 每条链路一张 · 引用标准': 'Service level metrics summary · metric definitions · one sheet per link · referenced standards',
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
  // v1.5.0「卫星EIRP」按口径拆名（GSO / NGSO 整波束饱和值、再生式单载波值）；译法与详细预算 WF_DICT、界面词典一致。
  // 「综合损耗 / 附加损耗」统一回「其他损耗」（上面那条）。旧名几条留作别名：报表标签取自当前字段表，按理不再出现，
  // 留着是防哪处漏改时整格漏成中文（此前 NGSO / 再生式英文报告的「综合损耗」就是这么漏的）
  '卫星饱和 EIRP': 'Satellite Saturated EIRP', '再生下行 EIRP': 'Regenerative Downlink EIRP',
  '综合损耗': 'Other Losses', '附加损耗': 'Other Losses',
  '轨道高度': 'Orbit Altitude', '轨道倾角': 'Inclination', '最低仰角': 'Min Elevation',
  '卫星编号': 'NORAD ID', '轨道根数': 'Orbital Elements',
  // 下拉的中文选项值（UPC / 天线噪温模式，输入清单按显示名出）与再生式卫星群 / 星间 / 激光几组字段的标签
  //（2026-10-16 补：英文报告的输入清单此前这几格整格漏成中文）。译法与界面词典、详细预算 WF_DICT 一致
  '否': 'No', '是': 'Yes', '自定义': 'Custom', '自动': 'Auto', '下行C/IM': 'Downlink C/IM',
  '发射EIRP': 'Tx EIRP', '接收G/T': 'Rx G/T', '星间C/I': 'ISL C/I', '星间频率': 'ISL Frequency',
  '大气余量': 'Atmospheric Margin', '最大工作距离': 'Max Operating Range', '星间链路距离': 'ISL Range',
  '发射光功率 P_tx': 'Tx Optical Power P_tx', '波长 λ': 'Wavelength λ', '发射口径 D_tx': 'Tx Aperture D_tx',
  '接收口径 D_rx': 'Rx Aperture D_rx', '发射光学效率 η_tx': 'Transmit Optical Efficiency η_tx',
  '接收光学效率 η_rx': 'Receive Optical Efficiency η_rx', '发射指向误差': 'Tx Pointing Error',
  '接收指向误差': 'Rx Pointing Error', '接收机灵敏度 P_req': 'Receiver Sensitivity P_req', '其他损耗 L': 'Other Losses L',
  // 这两条原先漏在字典外，英文报告里那两个章名/表名是中文（2026-09-06 补）
  '详细计算结果': 'Detailed Results', '图件': 'Figures',
  // 独立《服务等级指标（SLA）》报告
  '服务范围': 'Service Scope', '指标定义与考核口径': 'Metric Definitions and Assessment Conventions',
  '服务等级指标总表': 'Service Level Metrics Summary', '逐链路指标明细': 'Per-Link Metric Details',
  '可用度档位': 'Availability Tiers', '日凌预计中断': 'Sun Outage (predicted)',
  '日凌预计窗口': 'Predicted Sun Outage Windows', '参数与假设': 'Parameters and Assumptions',
  '引用标准': 'Normative References', '免责事件': 'Excluded Events',
  '指标定义': 'Metric Definitions',
  '定义': 'Definition', '计算式': 'Formula', '依据': 'Basis',
  '可用度构成': 'Availability Composition', '计入次数': 'Count',
  '考核周期': 'Assessment Period', '年平均': 'Annual mean', '最坏月': 'Worst month',
  '单位显示': 'Unit Display', '锁定': 'Locked', '自适应': 'Adaptive',
  '载波': 'Carrier', '速率': 'Rate', '符号率': 'Symbol Rate', '带宽': 'Bandwidth',
  '仰角': 'Elevation', '斜距': 'Slant Range',
  '档位': 'Tier', '综合': 'Composite', '上行雨衰': 'Uplink Rain', '下行雨衰': 'Downlink Rain',
  '链路余量': 'Link Margin', '功率占用': 'Power Use', '带宽占用': 'Bandwidth Use', '中断时长': 'Outage',
  '起': 'Start', '止': 'End', '时长': 'Duration', '北京时间': 'Beijing time',
  '导出 SLA 报告': 'Export SLA Report', '导出报告（SLA）': 'Export report (SLA)',
  '保存 SLA 报告': 'Save SLA report',
  '按各链路勾选的条款单出一份《服务等级指标（SLA）》报告（Excel / Word）': 'Exports a standalone Service Level Metrics (SLA) report (Excel / Word) from the clauses ticked on each link',
  '尚无 SLA 条款': 'No SLA clauses yet',
  // 独立《容量汇总》报告（导出对话框的抬头与 Excel 选项悬停；报告正文的字在 lbCapReport.js 里按 lang 出好）
  '导出容量报告': 'Export Capacity Report',
  '容量汇总 · 逐转发器明细 · 计算口径': 'Capacity summary · Per-transponder details · Conventions',
  '平台标志': 'Platform mark',
  '用本软件自己的标志（与「关于」窗口同一枚）': 'Use this application’s own mark (the same one shown in the About window)'
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
// used = 本份报告各链路实际用到的载波体制与终端类型（usedStandards(links)，决定 ② 里列哪几份体制标准与 P.2041）；
// 缺省按改前口径（DVB-S2/S2X 与 3GPP 两族照列，RCS2 与机载不列）。
export function methodology(scheme, lang, used) {
  const en = lang === 'en'
  const e2e = scheme.orbitType === 'E2E'
  // ★ ngso 只管「引擎是否走 §8 仰角统计 + SGP4 站星最差工况」——端到端不在其中：
  //   它的几何是逐跳给定（手动）或逐跳解最差工况（自动），可用度是逐跳站址值连乘，
  //   没有 §8 那套分箱加权。故 e2e 另立分支，只在参考文献那一组沿用轨道与时空基准。
  const ngso = scheme.orbitType === 'NGSO' || scheme.orbitType === 'REGEN'
  const regen = scheme.orbitType === 'REGEN'
  // 再生式按【报告里真出现的模块】取旗标：一份配置装了上行 + 星间时，几何一段要两种都说到
  const rmodes = regen ? (Array.isArray(scheme.regenModes) && scheme.regenModes.length ? scheme.regenModes : [scheme.regenMode]) : []
  const isl = regen && rmodes.some((m) => m === 'isl' || m === 'laser')
  const laser = regen && rmodes.includes('laser')
  const ground = !regen || rmodes.some((m) => m === 'uplink' || m === 'downlink')

  // ① 计算链路与口径
  const basis = []
  const put = (zh, ezh) => basis.push({ title: en ? ezh[0] : zh[0], text: en ? ezh[1] : zh[1] })

  // 端到端是另一套算法（正向电平递推 + 再生节点切段），三窗那两句（弯管合成 / 再生单段）
  // 都不是它做的事，故整条另写——方法学章节只许写引擎真正做了的。
  if (e2e) {
    put(['链路方程与级联',
      '端到端链路按正向电平递推计算：自发信站功放输出起，沿节点链逐跳把增益与损耗加减下去，每一行均可由上一行手工推算。'
      + '透明（弯管）节点只作变频放大转发，其上行与下行同属一段，段内 C/N 按功率倒数相加合成；'
      + '再生（星上处理）节点与地面转接站解调重调，把链切成若干段，段与段之间载噪比不再传递。'
      + '各段独立解调，端到端余量取各段余量的最小值（最弱段），链级门限与合成载噪比取同一段的那一份。'
      + '多跳下不作反算：目标余量可由发信站功放、任一透明星回退、任一再生星 EIRP 分别去凑，反算欠定。'],
    ['Link equation and cascade',
      'The end-to-end chain is computed as a forward level recursion: starting from the transmit HPA output, gains and losses are '
      + 'added and subtracted hop by hop along the node chain, so that every line can be re-derived by hand from the line above. '
      + 'A transparent (bent-pipe) node only frequency-converts and amplifies, so its uplink and downlink belong to one segment and '
      + 'their C/N values are combined by reciprocal power addition; a regenerative (on-board processing) node — or a ground relay — '
      + 'demodulates and remodulates, cutting the chain into segments across which carrier-to-noise no longer propagates. '
      + 'Each segment is demodulated independently, so the end-to-end margin is the minimum of the per-segment margins (the weakest '
      + 'segment), and the chain-level threshold and combined ratio are taken from that same segment. No back-solving is performed: '
      + 'with multiple hops a target margin could be met by the transmit HPA, by any transparent transponder back-off or by any '
      + 'regenerative satellite EIRP, so the inverse problem is under-determined.'])
  } else {
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
  }

  put(['干扰合成',
    '干扰按功率与热噪声一并合成为 C/(N+I)：计入邻道干扰 C/ACI、邻星干扰 C/ASI、交叉极化干扰 C/XPI、'
    + '发射机高功放互调 C/IM 与转发器互调 C/IM 各项，各项以其载干比的功率倒数求和后与 C/N 合成。各项取值为工程给定的系统级参数。'],
  ['Interference aggregation',
    'Interference is aggregated with thermal noise into C/(N+I): adjacent-channel (C/ACI), adjacent-satellite (C/ASI), '
    + 'cross-polarisation (C/XPI), HPA intermodulation and transponder intermodulation contributions are summed as reciprocal '
    + 'carrier-to-interference power ratios and then combined with C/N. Each ratio is a system-level input value.'])

  put(['噪声温度合成',
    '接收系统噪声温度由天线噪温、接收机噪温与馈线损耗折算合成。天线噪温可取手工给定值（视为晴空值），也可按 ITU-R P.618-14 §3 '
    + '式(69) 由路径气体衰减求取天空噪温，并叠加 25 K 的地面旁瓣拾取常数；介质平均辐射温度按式(70) 取 T_mr = 37.34 + 0.81·T_s'
    + '（T_s 为站址地面温度）。降雨工况下气体、云、雨三项衰减先合成再代入式(69)，云与雨带来的噪温增量 T_sky(气体+云+雨) − T_sky(气体) '
    + '经馈线折算入系统噪温，该项与雨衰共同构成下行链路劣化。'],
  ['Noise temperature budget',
    'System noise temperature is composed of antenna noise, receiver noise and the feeder-loss referral. Antenna noise is either '
    + 'entered manually (taken as the clear-sky value) or derived from the path gaseous attenuation per ITU-R P.618-14 §3 eq. (69), with a '
    + '25 K ground-pickup constant added; the mean radiating temperature follows eq. (70), T_mr = 37.34 + 0.81·T_s (T_s: surface '
    + 'temperature at the site). Under rain, the gaseous, cloud and rain attenuations are combined before entering eq. (69); the resulting '
    + 'increment T_sky(gas + cloud + rain) − T_sky(gas) is referred through the feeder into the system noise temperature and, together '
    + 'with rain attenuation, constitutes the downlink degradation.'])

  if (e2e) {
    put(['可用度与时延、误码的链级口径',
      '传播余量按年时间百分比统计：给定链路可用度对应的超越时间百分比即雨衰预测的输入；降雨率取 ITU-R P.837-7 的 '
      + '0.01% 超越降雨率（可按站址自动取值或手工指定）。链级系统可用度取各星地跳站址可用度之积（各跳雨区独立假设）；'
      + '星间跳为真空段，不贡献可用度损失。地面转接站的上、下行同址同雨，独立相乘是保守包络。'
      + '端到端误码率取各段设计误码率之和——各段独立解调、比特透传，误码一旦产生下游无法恢复。'
      + '端到端时延 = 各跳传播时延（斜距 / 光速）之和 + 各再生类节点的处理时延之和。'],
    ['Availability, delay and error-rate conventions for the chain',
      'Propagation margins are stated as annual time percentages: the exceedance percentage corresponding to the required '
      + 'availability is the input to the rain-attenuation prediction; rain rate is the 0.01 % exceedance value of ITU-R P.837-7 '
      + '(taken automatically from the site coordinates or entered manually). Chain availability is the product of the site '
      + 'availabilities of the Earth–space hops (rain cells assumed independent); inter-satellite hops are vacuum paths and '
      + 'contribute no availability loss. For a ground relay the uplink and downlink share one site and one rain cell, so the '
      + 'independent product is a conservative envelope. The end-to-end bit error ratio is the sum of the per-segment design '
      + 'values — each segment is demodulated independently and bits are passed through, so an error once made cannot be '
      + 'recovered downstream. End-to-end delay is the sum of the per-hop propagation delays (slant range / c) plus the '
      + 'processing delay of every regenerative node.'])

    put(['几何与轨道',
      '逐跳几何有两档口径，由用户在功能区选定，报告写的是本次计算实际所用的那一档：'
      + '手动档由各跳直接给定斜距与对卫星仰角（星间跳给星间距离）；自动最差档按各跳卫星自身的轨道解最差工况——'
      + '静止轨道按定点经度与站址经纬度的闭式球面解算，非静止轨道由 NORAD 两行根数 / OMM 经 SGP4/SDP4 传播至 TEME 惯性系、'
      + '取满足最低工作仰角的最大斜距，星间跳在地心固连系（ECEF）内取给定时窗内的最大互视距离。'
      + '站址一律取 WGS84 椭球坐标；斜距工具按「绕站一圈」求 WGS84 椭球上的最大值。'],
    ['Geometry and orbits',
      'Per-hop geometry follows one of two conventions selected by the user; this report states the one actually used for this '
      + 'computation. In manual mode the slant range and elevation of each hop (or the range of each inter-satellite hop) are '
      + 'entered directly. In automatic worst-case mode each hop is solved from the orbit of its own satellite: geostationary '
      + 'geometry in closed form on the sphere from the orbital longitude and site coordinates; non-geostationary orbits '
      + 'propagated from NORAD two-line elements / OMM by SGP4/SDP4 into the TEME inertial frame, taking the maximum slant '
      + 'range that still satisfies the minimum operating elevation; inter-satellite hops taken as the maximum mutually visible '
      + 'range within the given horizon in the Earth-fixed (ECEF) frame. Facility positions always use WGS84 ellipsoidal '
      + 'coordinates, and the slant-range tool takes the maximum over a full revolution about the site on the WGS84 ellipsoid.'])
  } else {
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

    // 站星与星间两句按报告里真有的模块各出各的：上行/下行有站星几何，星间微波/激光有两星几何，同装时两句都出
    put(['几何与轨道',
      ngso
        ? '轨道由 NORAD 两行根数 / OMM 经 SGP4/SDP4 传播至 TEME 惯性系，站址取 WGS84 椭球坐标；'
        + (ground ? '站星几何取满足最低工作仰角的最差工况（最大斜距）。' : '')
        + (isl ? '星间几何在地心固连系（ECEF）内解算，互视判据为视线段最近地心距不小于地球半径加大气余量。' : '')
      : '静止轨道几何按定点轨道经度与站址经纬度的闭式球面解算，取斜距、仰角与方位角；单程时延由斜距与光速给出。'],
    ['Geometry and orbits',
      ngso
        ? 'Orbits are propagated from NORAD two-line elements / OMM by SGP4/SDP4 into the TEME inertial frame; facility positions use '
        + 'WGS84 ellipsoidal coordinates. '
        + (ground ? 'Station–satellite geometry is taken at the worst case (maximum slant range) satisfying the minimum operating elevation. ' : '')
        + (isl ? 'Inter-satellite geometry is solved in the Earth-fixed (ECEF) frame; mutual visibility '
          + 'requires the minimum geocentric distance of the line-of-sight segment to be no less than the Earth radius plus an atmospheric margin.' : '')
      : 'Geostationary geometry is solved in closed form on the sphere from the orbital longitude and the site coordinates, giving slant '
        + 'range, elevation and azimuth; the one-way delay follows from slant range and the speed of light.'])
  }

  if (laser) {
    put(['光学链路口径',
      '星间激光链路按光功率预算计算：发射光功率经收发光学效率、收发望远镜增益、指向损耗、自由空间衰减与其他损耗得到接收光功率，'
      + '与给定的接收机灵敏度（所需接收功率）相比得到余量；相干多普勒按视向速率与光频折算。'],
    ['Optical link basis',
      'The optical inter-satellite link is computed as an optical power budget: transmit optical power through transmit and receive '
      + 'optical efficiency, telescope gains, pointing loss, free-space attenuation and other losses yields the received power, which is compared '
      + 'with the specified receiver sensitivity (required received power); the coherent Doppler shift follows from the range rate and the optical frequency.'])
  }

  // RR Art.21 落地 PFD：三窗下行（GSO / NGSO 弯管、再生式下行）才有这组出参（packages/core/utils/itu/art21.js）
  const art21 = !e2e && (!regen || rmodes.includes('downlink'))
  if (art21) {
    put(['落地功率通量密度',
      '下行到达地面的功率通量密度给两种口径：「到达端通量密度」为工作点实际值（整载波，含大气、云、雨衰减与其他损耗，'
      + '与下行功率链逐行自洽）；「自由空间到达 PFD（参考带宽内）」按 RR No.21.16 取假定自由空间传播条件，只计扩散 10·lg(4πd²)，'
      + '载波按均匀谱折算到 RR Art.21 Table 21-4 该行的参考带宽内（占用带宽窄于参考带宽时整个载波计入），与同一参考带宽内的限值相减得余量。'
      + '限值按下行频率、到达角（收信站仰角）、轨道类别与收信站所在 ITU 区域（RR No.5.3–5.9）查 RR 2024 版 Table 21-4；'
      + '非静止轨道的 X（No.21.16.6）、Y（No.21.16.15）按星座颗数、可见颗数与同频同时发射颗数取值，缺这些参数时不给限值。'
      + 'RR 在该频段对该业务与轨道没有限值时不给限值与余量。评估点只取收信站一点。'],
    ['Power flux-density at the Earth’s surface',
      'Two downlink PFD quantities are given. "PFD at Rx Side" is the operating-point value (whole carrier, including gaseous, cloud, '
      + 'rain and other losses, consistent line by line with the downlink power cascade). "Free-Space PFD (Ref. Bandwidth)" follows '
      + 'RR No. 21.16 — assumed free-space propagation, spreading 10·lg(4πd²) only — with the carrier taken as a uniform spectrum and '
      + 'referred to the reference bandwidth of the applicable row of RR Article 21 Table 21-4 (the whole carrier when its occupied '
      + 'bandwidth is narrower than the reference bandwidth); the margin is the limit minus this value in the same reference bandwidth. '
      + 'The limit is looked up in Table 21-4 of the 2024 edition by downlink frequency, angle of arrival (receive-station elevation), '
      + 'orbit class and the ITU Region of the receive station (RR Nos. 5.3–5.9); for non-GSO systems X (No. 21.16.6) and Y '
      + '(No. 21.16.15) depend on the number of satellites, the number visible and the number transmitting co-frequency, and no limit '
      + 'is given without them. Where the RR sets no limit for the band, service and orbit, neither limit nor margin is given. '
      + 'The receive station is the only point evaluated.'])
  }

  put(['数值口径',
    '全篇数值不作合格性判定，仅给出计算结果与其单位；显示单位在同一指标内跨链路统一选档（如 W/mW/kW、kHz/MHz/GHz），'
    + '级联算式行不作单位换算以保证逐行可手工验算。'],
  ['Numerical conventions',
    'No pass/fail judgement is made anywhere in this report; only computed values and their units are given. Display units are chosen '
    + 'per quantity consistently across links (e.g. W/mW/kW, kHz/MHz/GHz); cascade rows are never unit-converted so that each line remains hand-checkable.'])

  // ② 引用建议书与标准（分组 + 具体用途）—— 一律从标准台账出（packages/core/data/standards.json，经 shared/stdLedger.js），
  //    这里不再硬编码。只列本次计算实际用到的：传播组只在有星地跳时出，§8 只在 NGSO / 再生式写进 P.618 的用途；
  //    无线电规则组只在出落地 PFD 限值时（同上面 art21）；轨道组只在 NGSO / 再生式 / 端到端；体制组按各链路载波的标准取
  //    （DVB-S2 → EN 302 307-1 V1.4.1、DVB-S2X → -2 V1.4.1、RCS2、NR / NB-IoT 各自那几份）；P.2041-1 只在有机载终端时。
  //    2026-10-17 删去 P.453-14（闪烁的 N_wet 取常数，没接它的数字图）与 P.372-16（天空噪温按 P.618-14 §3，全仓无 P.372 实现）。
  const G = (zh, e) => (en ? e : zh)
  const refGroups = reportRefGroups({ orbitType: scheme.orbitType, regenModes: rmodes, used: used || null }, lang)

  // ③ 物理常数与基准
  const constants = [
    { name: G('玻尔兹曼常数', 'Boltzmann constant'), symbol: 'k', value: '−228.6', unit: 'dBW/(K·Hz)', src: G('10·lg(1.380649×10⁻²³)', '10·lg(1.380649×10⁻²³)') },
    { name: G('真空光速', 'Speed of light in vacuum'), symbol: 'c', value: '299 792.458', unit: 'km/s', src: 'SI' },
    { name: G('地球赤道半径', 'Earth equatorial radius'), symbol: 'Re', value: '6 378.137', unit: 'km', src: 'WGS 84' },
    { name: G('地心引力常数', 'Earth gravitational constant'), symbol: 'μ', value: '398 600.4418', unit: 'km³/s²', src: 'WGS 84 / EGM' },
    { name: G('介质平均辐射温度', 'Mean radiating temperature of the medium'), symbol: 'T_mr', value: '37.34 + 0.81·T_s', unit: 'K', src: G('ITU-R P.618-14 式(70)', 'ITU-R P.618-14 eq. (70)') },
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
    // 服务等级指标节（§4）：矩阵与逐链路明细共用这几个栏名
    sla: t('服务等级指标（SLA）'), slaTerm: t('条款'), slaBasis: t('计算依据'),
    slaSuggest: t('建议值'), slaAdopt: t('采用值'), slaParams: t('SLA 参数'),
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
    cvClass: lang === 'en' ? 'Classification' : '密　　级',
    // —— 独立《服务等级指标（SLA）》报告（lbSlaReport.js + 两个渲染器）——
    // 章名、表头与那几个只在这份文件里出现的栏名。全报告的 §4 用的是上面 sla* 那几项，两边共用。
    slaScope: t('服务范围'), slaDefs: t('指标定义与考核口径'), slaMatrix: t('服务等级指标总表'),
    slaDetail: t('逐链路指标明细'), slaTiers: t('可用度档位'), slaSun: t('日凌预计窗口'),
    slaAssump: t('参数与假设'), slaRefs: t('引用标准'), slaExcl: t('免责事件'),
    // 工作表名 Excel 上限 31 字符：英文的「指标定义与考核口径」超了，故另给一个短名
    slaDefsSheet: t('指标定义'),
    slaDefinition: t('定义'), slaFormula: t('计算式'), slaSource: t('依据'),
    slaComposition: t('可用度构成'), slaSlots: t('计入次数'),
    period: t('考核周期'), periodYear: t('年平均'), periodMonth: t('最坏月'),
    unitMode: t('单位显示'), unitLocked: t('锁定'), unitAdaptive: t('自适应'),
    carrier: t('载波'), rate: t('速率'), modcod: 'MODCOD', symbolRate: t('符号率'),
    bandwidth: t('带宽'), elevation: t('仰角'), slantRange: t('斜距'),
    tier: t('档位'), composite: t('综合'), rainUp: t('上行雨衰'), rainDown: t('下行雨衰'),
    marginCol: t('链路余量'), powerUse: t('功率占用'), bwUse: t('带宽占用'), outageCol: t('中断时长'),
    start: t('起'), end: t('止'), duration: t('时长'), utc: 'UTC', localTime: t('北京时间'),
    exportSla: t('导出 SLA 报告')
  }
}

// —— 载波「标准」的显示名（总报告「逐参数对照」表头的「标准」行）——
// 引擎不认识「标准」（选一条 MODCOD 只是把八个值整套填进表单），这一格只能从载波表单来。
// 内置键本身就是可读名（'DVB-S2X'），中文版取下拉里的那个名（3GPP 各表带中文注名）、英文版用键；
// 自建标准（usr:）的键与名分家，按库里的名字；没套标准（custom）如实报「自定义」。
export function carrierStdLabel(form, opts, lang) {
  const key = String((form && form.dvbStandard) || 'custom')
  const en = lang === 'en'
  if (key === 'custom') return en ? 'Custom' : '自定义'
  const hit = ((opts && opts.dvbStandards) || []).find((x) => x && x.value === key)
  if (key.startsWith('usr:')) return (hit && hit.label) || key
  return en ? key : ((hit && hit.label) || key)
}
// 一条链路的载波身份（link.carrier）：stds 逐段一份（端到端再生节点之后可换体制；其余体制就一段）。
// keys = 同序的 dvbStandard 键（不随语言变），方法学 ② 据它判本份报告用到了哪几份体制标准（usedStandards）
export function carrierIdentity(forms, opts, lang) {
  const list = Array.isArray(forms) ? forms : (forms ? [forms] : [])
  return {
    stds: list.map((f) => carrierStdLabel(f, opts, lang)),
    keys: list.map((f) => String((f && f.dvbStandard) || 'custom'))
  }
}

// 本份报告实际用到的载波体制与终端类型 —— 决定方法学 ② 列哪几份体制标准、要不要列 P.2041-1（见 shared/stdLedger.js）。
//   载波：各链路 link.carrier.keys（端到端逐段）；一条链路都没带键 → 载波未知，体制一族按改前口径照列。
//   DVB-S2X 正常帧表里的 S2 遗留档门限出自 EN 302 307-1 表 13，故 S2X 正常帧连带列 -1。
//   机载 / 高空终端：P.2041-1 的修正由站点离地高度触发（引擎不设机载开关，见 core/utils/itu/p2041.js、gasSite.js 的 agl），
//   故看引擎回显的离地高度（uplinkAglResult / downlinkAglResult / aglResult，km）> 0，或 terminalTypeResult === 'airborne'；
//   端到端看各跳 hops[]。引擎尚未回显这几个键时一律当地面站（不列 P.2041-1，宁少不多）。
const AGL_KEYS = ['aglResult', 'uplinkAglResult', 'downlinkAglResult']
const isAirborneOne = (d) => !!d && (String(d.terminalTypeResult || '').toLowerCase() === 'airborne' ||
  AGL_KEYS.some((k) => Number(d[k]) > 0.001))
const isAirborne = (d) => isAirborneOne(d) || (!!d && Array.isArray(d.hops) && d.hops.some(isAirborneOne))
export function usedStandards(links) {
  const list = Array.isArray(links) ? links : []
  const airborne = list.some((l) => l && isAirborne(l.data))
  const keys = []
  let known = false
  for (const l of list) {
    const k = l && l.carrier && Array.isArray(l.carrier.keys) ? l.carrier.keys : null
    if (k) { known = true; keys.push(...k.map(String)) }
  }
  if (!known) return airborne ? { dvbS2: true, dvbS2x: true, rcs2: false, nr: true, nbiot: true, airborne } : null
  const has = (re) => keys.some((k) => re.test(k))
  return {
    dvbS2: has(/^DVB-S2X?$/), dvbS2x: has(/^DVB-S2X/), rcs2: has(/^DVB-RCS2$/),
    nr: has(/^3GPP NR-NTN/), nbiot: has(/^3GPP NB-IoT NTN/), airborne
  }
}

// —— 报告模型 ——
// links 由各窗按自己的数据结构组装好后传入（见各窗 buildReportLinks）：
//   { no, rowId, txName, rxName, ok, error, data, segments, inputs, figures, carrier, geom, islGeo }
export function buildReportModel(o) {
  const {
    lang = 'zh', orbitType = 'GEO', regenMode = 'uplink',
    doc = {}, links = [], calc = {}, appVersion = '', satelliteName = '', frequencyBand = '',
    adaptUnits = false, slaParams = null, sections = null, capacity = null
  } = o || {}
  // 分节（再生式一份配置装了几个计算模块）：sections = [{ key, regenMode, title, short, count }]，
  // 各链路以 link.sec（节下标）归属；体制描述子按全部模块取（副标题并列、方法学按并集）。
  // 不分节的窗口（GSO / NGSO / 端到端 / 只有一个模块的再生式）照旧只传 regenMode。
  const secs = Array.isArray(sections) && sections.length
    ? sections.map((s) => ({
      key: s.key, regenMode: s.regenMode || s.key,
      title: s.title || regenModeName(s.regenMode || s.key, lang),
      short: s.short || regenModeShort(s.regenMode || s.key, lang),
      count: s.count != null ? s.count : links.filter((l) => l && l.sec === sections.indexOf(s)).length
    }))
    : null
  const scheme = schemeOf(orbitType, secs ? secs.map((s) => s.regenMode) : regenMode)
  return {
    v: 1,
    lang,
    ...(secs ? { sections: secs } : {}),
    // SLA 建议（§4）：逐链路的条款挂在 links[i].sla 上（导出对话框没勾「含 SLA 建议」时为 null）；
    // 一条都没有 ⇒ hasSla 为假 ⇒ 三个渲染器整节不出、目录不列、表号不占。
    hasSla: links.some((l) => l && l.sla && l.sla.rows && l.sla.rows.length),
    slaParams: slaParams || null,
    // 容量汇总（§2）：渲染端按节出好的逐转发器表（shared/lbCapacity.capReportBlock），下标对齐 sections
    //（不分节＝一个元素）；null ＝ 该窗没有这个模块（端到端），主进程照旧出它自己的统计行。
    ...(Array.isArray(capacity) ? { capacity } : {}),
    // 结果显示单位的档位（功能区「单位」，出厂锁定＝false）：报告与屏幕同口径——主进程据此决定
    // 汇总行要不要整行换档（report.adaptSummaryUnits）、详表瀑布要不要换档（buildWaterfallSegments）。
    adaptUnits: !!adaptUnits,
    scheme,
    t: labelBundle(lang),
    doc: Object.assign({}, defaultDocInfo(scheme, satelliteName, lang, frequencyBand), doc, {
      appVersion,
      generatedAt: new Date().toISOString()
    }),
    calc: Object.assign({ satelliteName, frequencyBand }, calc),
    links,
    method: methodology(scheme, lang, usedStandards(links))
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
