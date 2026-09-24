// 参数化整星模板（任务书 §5.6、附录 A 档 1；设计契约 §3.5：模板 id → 模型 id `param:<模板 id>`）。
//
// ★ 数据纪律（任务书「查不到的留空让用户填，不许编」）：
//   · 模板里的平台数据（fields）每一项都是 {value, unit, source, url, rep?, note?, confidence?}，value 与出处逐条来自
//     研究整理稿 param-templates.json（2026-09-23，150 条引文已与原文存档逐字比对）。查不到的 value = null。
//     数值取自某颗具体卫星（代表星）时 rep = 星名，source = 「代表星 <星名>：<URL>」（任务书：source 里写明是哪颗星）；
//     url 恒为纯链接，给界面「打开出处」用。
//   · fieldGaps 列「生成几何必需、但查不到」的模板字段（功率 / 寿命一类只做展示的空值不列）。立方星除尺寸 / 质量
//     外的项是标准本身不规定，不算缺失。
//   · GEO 平台的布局类参数（反射面数量与口径、翼板数、板尺寸）只查到代表星的数时，用代表星（任务书口径）；
//     因此 SSL-1300 是 TerreStar-1 的 18 m 网状反射面、E3000 是 Inmarsat-4 的 9 m——两者都是非典型大口径
//     移动通信星，用户要常规 Ku/Ka 星时自己改口径。
//   · 轭长、板间缝、反射面焦径比、馈源口径、推力器尺寸……这些「工程细节」没有任何平台公开，也不是平台数据，
//     放在 DETAIL_PRESETS（全部 source:'illustrative'）。能由有出处的跨度反推的（轭长）优先反推，并记 derived。
//
// ★ 缺口口径（界面「描红 + 生成按钮禁用」只认这一套，路径全是 paramBus spec 路径，与 validateSpec().missing 同写法）：
//   · needsInput = templateSpec(id, {fill:'none'}) 那份 spec 里为 null 的路径 = validateSpec(那份 spec).missing（单测逐模板对拍）。
//     列表整体未知时是列表路径本身（'wings' / 'reflectors'，spec 里为 null）；列表已知、条目字段未知时是条目路径
//     （'wings[0].panelHM'）。TEMPLATES[id].needsInput 是同一结果的缓存。
//   · fill='illustrative'（缺省）：needsInput 的空位用示意值补上，illustrative[] 列出所有被示意值填上的具体路径
//     （⊇ needsInput；列表整体是示意时，新造条目里查不到数的字段也逐条列出，如 'reflectors[0].diameterM'）。
//     3D 页自动匹配到 param:<模板> 时用这一档。
//   · fill='none'：空位保持 null，validateSpec 报缺 → 生成按钮禁用；用户在表单里「加翼 / 加反射面」时用
//     itemDefaults.wing / itemDefaults.reflector 作新条目初值（有出处的值已填，查不到的为 null——加上之后
//     validateSpec().missing 会继续报条目路径）。
//   · specSources 的键是 spec 路径，条目字段用 [*]（'wings[*].panelHM'、'reflectors[*].focalM'）：表单查 title 时把下标换成 [*]。
//
// 轴向约定（本体系 +X 速度 / +Y 补全右手 / +Z 天底；GEO 下 +X≈东、+Y≈南、±Y 面挂太阳翼、±X 面挂反射面）：
//   原文尺寸大多不注明轴向。映射规则写死、逐条在 note 里说明：发射手册整星包络取最大者为 Z（发射轴 = 对地轴，
//   GEO 通信星的星箭接口在背地面），其余两项按原文顺序记 X、Y。
//
// ★ 2026-09-24（用户）：内置目录撤下三个旧平台模板，界面上也不出现；用户要用自己加。原先那份 GEO 大平台外形
//   改名「默认卫星」（default-sat）留作默认卫星模型：几何与参数逐字段不变（单测对拍几何摘要逐位相同），
//   出处 / 说明一律中性化为「典型 GEO 大平台」示意值。
//   旧模板 id 别名：撤下的旧 id 及 param:<旧 id> 静默指向 default-sat，不进任何对外列表（见 LEGACY_TEMPLATE_IDS）。
//
// 导出：
//   TEMPLATES                 { [templateId]: Template }（冻结；调用方别改，改用 templateSpec 的返回值）
//   TEMPLATE_IDS              模板 id 列表（顺序即界面下拉顺序；不含旧 id 别名）
//   DEFAULT_TEMPLATE_ID       'default-sat'（默认卫星模型的模板 id）；DEFAULT_MODEL_ID = 'param:default-sat'
//   DETAIL_PRESETS            工程细节示意值（按细节档；布局族可用哪几档见 paramBus.LAYOUT_PRESETS）
//   templateSpec(id, {fill})  → {spec, needsInput, illustrative, specSources, itemDefaults, warnings}（id 可为旧 id 别名）
//   templateCatalog()         → 参数化模型的 ModelMeta 片段（给 manifest / 库页）
//   templateModelId(id)       → 'param:<id>'
//   resolveTemplateId(id)     → 现行模板 id（旧 id 别名换成现行 id）；未知 → null
//   isTemplateId(id)          → 是否现行模板或旧 id 别名（运行时「按模板现生成」的判据用它，别用 TEMPLATE_IDS.includes）
//   resolveParamModelId(id)   → 'param:<旧 id>' 换成 'param:default-sat'；其余原样返回

// ───────────────────────────── 出处常量 ─────────────────────────────

const S = {
  ENG2022: 'https://www.engineering.org.cn/engi/CN/10.1016/j.eng.2022.04.013',
  VA207: 'https://europeanspaceflight.com/wp-content/uploads/2023/11/VA207-launchkit.pdf',
  V198: 'https://europeanspaceflight.com/wp-content/uploads/2023/11/V198-launchkit.pdf',
  SSL_ARCHIVE: 'http://web.archive.org/web/20210228024024/http://www.sslmda.com/html/products/1300.html',
  NSSDC_TERRESTAR1: 'https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=2009-035A',
  V197: 'https://europeanspaceflight.com/wp-content/uploads/2023/11/V197-launchkit.pdf',
  SKYROCKET_SB: 'https://space.skyrocket.de/doc_sat/aerosp_spacebus-c-class.htm',
  VA201: 'https://europeanspaceflight.com/wp-content/uploads/2023/11/VA201-launchkit.pdf',
  ESA_E3000_LX: 'https://connectivity.esa.int/projects/eurostar-e3000-large-mechanical-platform-development',
  ESA_E3000_SA: 'https://connectivity.esa.int/projects/e3000-second-generation-solar-array',
  INMARSAT4: 'https://web.archive.org/web/20180324040905/https://www.inmarsat.com/about-us/about-usour-satellites/inmarsat-4/',
  MCDOWELL_STARSIM: 'https://planet4589.org/astro/starsim/index.html',
  NSSDC_STARLINK: 'https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=2019-074D',
  SFN_STARLINK_V2: 'https://spaceflightnow.com/2023/02/26/spacex-unveils-first-batch-of-larger-upgraded-starlink-satellites/',
  SPACECOM_STARLINK: 'https://www.space.com/spacex-starlink-satellites.html',
  NASA_SOA_STRUCT: 'https://www.nasa.gov/wp-content/uploads/2024/02/6.soa-structures-2023.pdf',
  CDS_14_1: 'https://static1.squarespace.com/static/5418c831e4b0fa4ecac1bacd/t/62193b7fc9e72e0053f00910/1645820809779/CDS+REV14_1+2022-02-09.pdf'
}

/**
 * 一条有出处（或明确为空）的平台数据。extra.rep = 代表星名（数值取自这颗星而非平台通用指标）：
 * source 写成「代表星 <星名>：<URL>」，url 保留纯链接。source 为 'illustrative' 时 url = null。
 */
const F = (value, unit, source, extra = {}) => {
  const url = typeof source === 'string' && /^https?:\/\//.test(source) ? source : null
  const o = { value, unit, source: source ?? null, url, ...extra }
  if (extra.rep && url) o.source = `代表星 ${extra.rep}：${url}`
  return o
}
/** 查不到：value 与 source 都是 null，note 写清为什么空。 */
const NIL = (unit, note) => ({ value: null, unit, source: null, url: null, note })

// ───────────────────────────── 默认卫星与旧 id 别名 ─────────────────────────────

/** 默认卫星模型（autoMatch 的 GEO 缺省与兜底、3D 页替身都用它）。 */
export const DEFAULT_TEMPLATE_ID = 'default-sat'
export const DEFAULT_MODEL_ID = `param:${DEFAULT_TEMPLATE_ID}`

/**
 * 旧模板 id 别名 → 现行模板 id。2026-09-24 撤下的三个模板一律指向默认卫星：老代码 / 老存档里写死的旧 id（含 param: 前缀）
 * 照样能生成、能匹配，但这些 id 不出现在 TEMPLATE_IDS / TEMPLATES / templateCatalog 里。
 * ★ 放在模块前部：文件末尾的 needsInput 缓存循环在加载期就调 templateSpec → resolveTemplateId，晚于它初始化会 TDZ。
 */
const LEGACY_TEMPLATE_IDS = Object.freeze({ dfh4: DEFAULT_TEMPLATE_ID, dfh4e: DEFAULT_TEMPLATE_ID, dfh5: DEFAULT_TEMPLATE_ID })

/** 现行模板 id（旧 id 别名换成现行 id）；不是字符串或未知 → null。 */
export function resolveTemplateId(id) {
  if (typeof id !== 'string') return null
  const k = Object.hasOwn(LEGACY_TEMPLATE_IDS, id) ? LEGACY_TEMPLATE_IDS[id] : id
  return Object.hasOwn(T, k) ? k : null
}
/** 现行模板或旧 id 别名。 */
export const isTemplateId = (id) => resolveTemplateId(id) !== null
/** 'param:<旧 id>' → 'param:<现行 id>'；别的 id（含 param:<hash>、nasa:…、null）原样返回。 */
export function resolveParamModelId(id) {
  if (typeof id !== 'string' || !id.startsWith('param:')) return id
  const k = id.slice(6)
  return Object.hasOwn(LEGACY_TEMPLATE_IDS, k) ? `param:${LEGACY_TEMPLATE_IDS[k]}` : id
}

// GEO 布局缺口的示意补位：典型 GEO 大平台的平台体与单板尺寸（界面只写「典型 GEO 大平台」）。
// 数值为 GEO 大平台公开参数（2026-09-24 旧模板撤下时原样保留）：平台体 2360 × 2100 × 3600 mm（按原文顺序记 X × Y × Z）、
//   单板 3.30 × 2.36 m（沿翼展 × 横宽）。
const GEO_FILL = Object.freeze({
  bus: Object.freeze({ xM: 2.36, yM: 2.1, zM: 3.6 }),
  panel: Object.freeze({ alongM: 3.3, acrossM: 2.36 })
})

// ───────────────────────────── 工程细节示意值 ─────────────────────────────
//
// 这里没有一个数有出处——它们是生成器把「平台级数据」画成一颗像样的星所需的建模细节，任何平台都不公开。
// 全部 source:'illustrative'；数值取工程上常见量级的整数 / 半整数，只影响外观与估算质量的次要项。
//
// ★ 每一档都必须带齐它所配布局族的生成器会读的键（paramBus.PRESET_KEYS，单测逐档查）。反射面那组键四档都有：
//   生成页允许在任何模板上加反射面，缺一个键生成器就读到 undefined、整副反射面变 NaN（09-23 审查实测过）。
//   reflDetailScale：反射面附件（展开臂 / 铰座 / 支架 / 塔顶与近缘净空 / 双反射面间距）的绝对尺寸按它缩放——
//   这些常数按 GEO 米级反射面定（1 = 原值），照搬到 1 m 平台或 10 cm 立方星上会比星体还粗。
//   meshTrussDepthFrac / meshTrussRodFrac：网状反射面周边桁架深度 / 杆半径占口径的比例（AstroMesh 类外观）。

// 平台 ~1 m 量级（通用小卫星 / LEO 平板）共用的反射面细节
const REFL_SMALL = Object.freeze({
  feedInsetM: 0.05, feedStandoffM: 0.1, wallGapM: 0.1, fdSolid: 0.8, fdMesh: 0.5, meshAboveDM: 5, shellM: 0.02, towerWM: 0.25,
  reflDetailScale: 0.5, meshTrussDepthFrac: 0.05, meshTrussRodFrac: 0.0025
})

export const DETAIL_PRESETS = Object.freeze({
  // GEO 通信平台（2–4 m 平台体、十几 m 单翼）
  geo: Object.freeze({
    sadaLenM: 0.2, sadaDM: 0.3,          // 太阳翼驱动机构（SADA）外露段
    yokeLenM: 2.5, yokeRodDM: 0.06,      // 连接架（轭）：翼根到第一块板；有出处的跨度可反推时以反推为准
    gapM: 0.05, panelTM: 0.025,          // 板间缝、铝蜂窝基板厚
    cellMarginM: 0.03,                   // 电池片区距板边
    mliOffM: 0.02,                       // MLI 离结构面距离（包覆层单独成节点）
    radiatorFrac: 0.8,                   // 南北面 OSR 散热面覆盖比例（按边长）
    adapterDM: 1.194, adapterHM: 0.12,   // 星箭对接环（常见 Ø1194 mm 档，示意）
    feedInsetM: 0.1, feedStandoffM: 0.25,// 侧挂反射面馈源：离东西侧壁内缩、高出对地板
    wallGapM: 0.2,                       // 侧挂反射面内缘离侧壁的净空
    fdSolid: 0.8, fdMesh: 0.5,           // 母抛物面焦径比 f/D：实面 / 网状
    meshAboveDM: 5,                      // 口径超过它按可展开网状反射面画（reflector_mesh）
    shellM: 0.02,                        // 实面反射面边缘厚度环（任务书：2 cm）
    towerWM: 0.5,                        // 对地板天线塔截面边长（有对地板反射面才画）
    reflDetailScale: 1,                  // 反射面附件绝对尺寸比例（见上）
    meshTrussDepthFrac: 0.05, meshTrussRodFrac: 0.0025,  // 网状反射面周边桁架：深 5 % 口径、杆半径 0.25 % 口径
    deckHorns: 3, hornApM: 0.12, hornLenM: 0.25,  // 对地板小喇叭（测控 / 信标）
    laeExitDM: 0.3, laeLenM: 0.35,       // 远地点发动机喷管
    rcsExitDM: 0.05, rcsLenM: 0.08,      // 姿轨控推力器
    illustrativeReflectorDM: 2.5, illustrativeDeckReflectorDM: 1.2
  }),
  // 通用小卫星（~1 m 平台）
  small: Object.freeze({
    sadaLenM: 0.08, sadaDM: 0.12, yokeLenM: 0.4, yokeRodDM: 0.025, gapM: 0.03, panelTM: 0.02, cellMarginM: 0.02,
    mliOffM: 0.01, radiatorFrac: 0.7, adapterDM: 0.937, adapterHM: 0.08,
    ...REFL_SMALL,
    deckHorns: 2, hornApM: 0.06, hornLenM: 0.12, laeExitDM: 0.1, laeLenM: 0.12, rcsExitDM: 0.025, rcsLenM: 0.04,
    illustrativeReflectorDM: 0.8, illustrativeDeckReflectorDM: 0.5
  }),
  // LEO 平板（Starlink 类）
  leo: Object.freeze({
    sadaLenM: 0.1, sadaDM: 0.12, yokeRodDM: 0.05, gapM: 0.02, panelTM: 0.02, cellMarginM: 0.02,
    phasedTiles: 4, phasedTileFrac: 0.45, phasedTileTM: 0.015,  // 对地面相控阵面：2×2 块、每块占边长 45 %
    thrusterDM: 0.08, thrusterLenM: 0.12,                         // 电推力器（示意）
    ...REFL_SMALL                                                 // 模板本身无反射面；用户在生成页加的才用到
  }),
  // 立方星（CDS）
  cubesat: Object.freeze({
    railWM: 0.0085,          // 导轨截面边长（示意）
    railFootM: 0.00675,      // 导轨端脚：由 1U 长 113.5 mm 与 100 mm 立方体推算 (113.5−100)/2（示意）
    panelTM: 0.0016,         // 展开板（PCB 基板）厚
    cellMarginM: 0.004, bodyCellFrac: 0.8, cellLiftM: 0.001,
    bodyInsetM: 0.0015,      // 侧板相对导轨外缘内缩：体装电池片（离板 1 mm）仍在导轨包络内（CDS：导轨外缘即包络）
    patchWM: 0.05,           // 对地端贴片天线边长（示意）
    // 反射面（模板本身没有；用户加的——RainCube 一类分米级可展开天线）：比 0.3 m 大按网状画，附件尺寸缩到 GEO 的 1/10
    feedInsetM: 0.01, feedStandoffM: 0.02, wallGapM: 0.01, fdSolid: 0.6, fdMesh: 0.5, meshAboveDM: 0.3, shellM: 0.003, towerWM: 0.03,
    reflDetailScale: 0.1, meshTrussDepthFrac: 0.05, meshTrussRodFrac: 0.0025
  })
})

// ───────────────────────────── 模板 ─────────────────────────────
//
// Template = {
//   id, title, titleZh, layout:'geo'|'leo-flat'|'cubesat', detail:<DETAIL_PRESETS 键>, manufacturer, representative,
//   fields: { bus, launchMassKg, repMassKg?（代表星单值发射质量，作估算质量）, dryMassKg, payloadMassKg, payloadPowerKW, totalPowerKW, designLifeYr,
//             wings, panelsPerWing, sidePanelsPerWing?, panelSize, spanM, reflectors, antennas?, … },
//   fieldGaps: [模板字段路径]      // 数据缺口（模板字段口径，给人看 / 数据纪律单测用）
//   needsInput: [spec 路径]       // 模块加载时由 templateSpec(id,{fill:'none'}) 算出并缓存（见文件头「缺口口径」）
// }
// bus.value = {xM, yM, zM}（本体轴，见文件头映射规则）；panelSize.value = {alongM 沿翼展, acrossM 横宽}；
// reflectors.value = {count, diametersM:number[]|null}。

const GEO_COMMON_NOTE_BUS_ENVELOPE = '发射手册给的是整星收拢包络（含收拢天线），当平台体用偏大'

const T = {}

// 默认卫星：GEO 三轴稳定通信大平台的示意外形（2026-09-24 起的默认卫星模型；autoMatch 的 GEO 缺省与兜底）。
// 字段与撤下的旧模板逐项同值、同缺口（bus / wings / reflectors 仍是缺口，fill 档用示意值补齐），所以两档 spec 与生成几何
// 都与原模板逐位相同（单测按原模板 spec 逐字段、生成结果逐位对拍）；出处 / 说明一律是中性的「典型 GEO 大平台」示意值。
// 数值口径（GEO 大平台公开参数，界面不显示出处）：发射质量 5500–6000 kg、平台干重 ≤ 2700 kg、载荷 800–1000 kg、
//   载荷功率 ≥ 10 kW、整星功率 ≥ 13.5 kW、寿命 15 年、估算质量 5550 kg、每翼 4 块、单板 3.30 × 2.36 m；
//   平台体 / 单板的示意补位值见 GEO_FILL 的注释。
const ILL_GEO = '示意：典型 GEO 大平台'
T[DEFAULT_TEMPLATE_ID] = {
  id: DEFAULT_TEMPLATE_ID, title: 'Default satellite', titleZh: '默认卫星', layout: 'geo', detail: 'geo',
  manufacturer: null,
  representative: null,
  illustrative: true,   // 整个模板是示意外形（字段 source 一律 'illustrative'）
  fields: {
    bus: NIL('m', `未给定；示意档取典型 GEO 大平台 ${GEO_FILL.bus.xM} × ${GEO_FILL.bus.yM} × ${GEO_FILL.bus.zM} m`),
    launchMassKg: F({ min: 5500, max: 6000 }, 'kg', 'illustrative', { note: `${ILL_GEO}发射质量` }),
    repMassKg: F(5550, 'kg', 'illustrative', { note: `${ILL_GEO}；作整星估算质量` }),
    dryMassKg: F({ max: 2700 }, 'kg', 'illustrative', { note: `${ILL_GEO}平台干重上限，非整星干重` }),
    payloadMassKg: F({ min: 800, max: 1000 }, 'kg', 'illustrative', { note: `${ILL_GEO}载荷质量` }),
    payloadPowerKW: F({ min: 10 }, 'kW', 'illustrative', { note: `${ILL_GEO}载荷功率` }),
    totalPowerKW: F({ min: 13.5 }, 'kW', 'illustrative', { note: `${ILL_GEO}整星功率` }),
    designLifeYr: F(15, 'yr', 'illustrative', { note: `${ILL_GEO}设计寿命` }),
    wings: NIL('翼', '未给定；示意档取南北两翼'),
    panelsPerWing: F(4, '块', 'illustrative', { note: `${ILL_GEO}每翼板数` }),
    panelSize: F({ alongM: GEO_FILL.panel.alongM, acrossM: GEO_FILL.panel.acrossM }, 'm', 'illustrative', { note: `${ILL_GEO}单板尺寸（沿翼展 × 横宽）` }),
    spanM: NIL('m', '由轭长与板长决定'),
    reflectors: NIL('副', '未给定；示意档取东西侧各 1 副 + 对地板南北各 1 副')
  },
  fieldGaps: ['bus', 'wings', 'reflectors']
}

T.ssl1300 = {
  id: 'ssl1300', title: 'SSL-1300', titleZh: 'SSL-1300（Maxar 1300）', layout: 'geo', detail: 'geo',
  manufacturer: 'Space Systems Loral / Maxar',
  representative: 'EchoStar XVII（Jupiter 1）；反射面取 TerreStar-1',
  fields: {
    bus: F({ xM: 3.2, yM: 3.1, zM: 8.0 }, 'm', S.VA207, { rep: 'EchoStar XVII',
      confidence: 'primary',
      note: `EchoStar XVII「Dimensions 8.0 x 3.2 x 3.1 m at launch」（Arianespace VA207）；${GEO_COMMON_NOTE_BUS_ENVELOPE}。最大者 8.0 m 取 Z，其余按原文顺序 X、Y`
    }),
    launchMassKg: F(6100, 'kg', S.VA207, { rep: 'EchoStar XVII', confidence: 'primary', note: 'EchoStar XVII' }),
    dryMassKg: F(2393, 'kg', S.V198, { rep: 'Intelsat 17', confidence: 'primary', note: 'Intelsat 17（LS 1300 Omega）' }),
    payloadPowerKW: NIL('kW', 'SSL 未单列载荷功率'),
    totalPowerKW: F({ min: 5, max: 25 }, 'kW', S.SSL_ARCHIVE, { confidence: 'primary', note: 'SSL 官网存档：全寿命整星功率 5–25 kW；EchoStar XVII 16.1 kW' }),
    designLifeYr: F(15, 'yr', S.VA207, { rep: 'EchoStar XVII', confidence: 'primary', note: 'EchoStar XVII' }),
    wings: NIL('翼', '未找到逐字来源'),
    panelsPerWing: NIL('块', '未找到可核对来源'),
    panelSize: NIL('m', '未找到'),
    spanM: F(26.07, 'm', S.VA207, { rep: 'EchoStar XVII', confidence: 'primary', note: 'EchoStar XVII「Span in orbit 26.07 m」' }),
    reflectors: F({ count: 1, diametersM: [18] }, '副', S.NSSDC_TERRESTAR1, { rep: 'TerreStar-1',
      confidence: 'primary',
      note: '代表星 TerreStar-1（LS-1300S）S 频段 MSS「18 m deployable reflector」，非典型大型网状反射面；常规 Ku/Ka 1300 星反射面口径无公开一手数据'
    })
  },
  fieldGaps: ['wings', 'panelsPerWing', 'panelSize']
}

T.spacebus4000 = {
  id: 'spacebus4000', title: 'Spacebus 4000', titleZh: '空间客车4000（Spacebus 4000）', layout: 'geo', detail: 'geo',
  manufacturer: 'Thales Alenia Space',
  representative: 'Eutelsat W3B（Spacebus 4000 C3）',
  fields: {
    bus: F({ xM: 2.0, yM: 2.2, zM: 5.8 }, 'm', S.V197, { rep: 'Eutelsat W3B',
      confidence: 'primary',
      note: `W3B「Dimensions 5.8 x 2.0 x 2.2 m」（Arianespace V197）；${GEO_COMMON_NOTE_BUS_ENVELOPE}。5.8 m 取 Z，其余按原文顺序 X、Y`
    }),
    launchMassKg: F({ min: 3000, max: 5900 }, 'kg', S.SKYROCKET_SB, { confidence: 'secondary', note: 'Gunter 转录 Thales 产品说明；W3B 实星 5370 kg（V197）' }),
    repMassKg: F(5370, 'kg', S.V197, { rep: 'Eutelsat W3B', confidence: 'primary', note: 'W3B 实星发射质量；作整星估算质量' }),
    dryMassKg: NIL('kg', '未找到'),
    payloadPowerKW: F({ max: 11.6 }, 'kW', S.SKYROCKET_SB, { confidence: 'secondary' }),
    totalPowerKW: F({ max: 15.8 }, 'kW', S.SKYROCKET_SB, { confidence: 'secondary', note: 'W3B 12 kW（V197）' }),
    designLifeYr: F(15, 'yr', S.V197, { rep: 'Eutelsat W3B', confidence: 'primary', note: 'W3B' }),
    wings: NIL('翼', '未找到逐字来源'),
    panelsPerWing: F(4, '块', S.ENG2022, {
      confidence: 'primary',
      note: '《Engineering》2022 表 2「four solar panels and two side solar panels」（原文拼作 PaceBus4000，同行功率 / 电池类型与 Thales 说明有出入，谨慎用）：串联 4 块 + 侧板 2 块'
    }),
    sidePanelsPerWing: F(2, '块', S.ENG2022, { confidence: 'primary', note: '同上；侧板的拼接位置无公开几何，生成器画在最外一块两侧' }),
    panelSize: F({ alongM: 3.66, acrossM: 2.22 }, 'm', S.ENG2022, {
      confidence: 'primary', note: '表 2「3.66 × 2.22」未注明方向：按 W3B 跨度 34 m 自洽判 3.66 m 沿翼展（反过来轭长 > 6 m 不合理）'
    }),
    spanM: F(34, 'm', S.V197, { rep: 'Eutelsat W3B', confidence: 'primary', note: 'W3B「Span in orbit 34 m」' }),
    reflectors: F({ count: null, diametersM: [2.4] }, '副', S.SKYROCKET_SB, {
      confidence: 'secondary', note: '平台可容纳反射面「from 2.4 m to 3.2 × 2.4 m」（容纳范围，非某星实配）；数量未公开'
    })
  },
  fieldGaps: ['wings', 'reflectors.count']
}

T.eurostar3000 = {
  id: 'eurostar3000', title: 'Eurostar 3000', titleZh: '欧洲之星3000（Eurostar E3000）', layout: 'geo', detail: 'geo',
  manufacturer: 'Airbus Defence and Space（原 EADS Astrium）',
  representative: 'Yahsat Y1A；反射面取 Inmarsat-4',
  fields: {
    bus: F({ xM: 2.1, yM: 2.3, zM: 5.5 }, 'm', S.VA201, { rep: 'Yahsat Y1A',
      confidence: 'primary',
      note: `Yahsat Y1A「Dimensions 5.5 x 2.1 x 2.3 m」（Arianespace VA201）；${GEO_COMMON_NOTE_BUS_ENVELOPE}。5.5 m 取 Z，其余按原文顺序 X、Y`
    }),
    launchMassKg: F({ max: 6400 }, 'kg', S.ESA_E3000_LX, { confidence: 'primary', note: 'E3000 LX 上限；Y1A 实星 5935 kg（VA201）' }),
    repMassKg: F(5935, 'kg', S.VA201, { rep: 'Yahsat Y1A', confidence: 'primary', note: 'Yahsat Y1A 实星发射质量；作整星估算质量' }),
    dryMassKg: NIL('kg', '未找到'),
    payloadPowerKW: F({ min: 4.5, max: 14 }, 'kW', S.ESA_E3000_SA, { confidence: 'primary' }),
    totalPowerKW: F(14, 'kW', S.VA201, { rep: 'Yahsat Y1A', confidence: 'primary', note: 'Y1A「On-board power 14 kW (end of life)」' }),
    designLifeYr: F(15, 'yr', S.VA201, { rep: 'Yahsat Y1A', confidence: 'primary', note: 'Y1A' }),
    wings: NIL('翼', '未找到逐字写明整星翼数的来源（ESA「2 solar array wings」指鉴定件）'),
    panelsPerWing: F({ min: 3, max: 5 }, '块', S.ESA_E3000_SA, {
      confidence: 'primary',
      note: 'SX=3 短板、S=4 短板、L=4 长板、LX=5 长板。按 Y1A 跨度 39.4 m 反推只有 L 型（4 块长板）自洽：5 块长板超跨度、4 块短板轭长 > 6 m'
    }),
    panelSize: F({ short: { alongM: 3.05, acrossM: 2.28 }, long: { alongM: 3.915, acrossM: 2.28 } }, 'm', S.ESA_E3000_SA, {
      confidence: 'primary', note: '「panel size of 3.050 x 2.28 m」/「3.915 x 2.28 m」；2.28 m 与平台东西边相当判为横宽'
    }),
    spanM: F(39.4, 'm', S.VA201, { rep: 'Yahsat Y1A', confidence: 'primary', note: 'Y1A「Span in orbit 39.4 m」' }),
    reflectors: F({ count: 1, diametersM: [9] }, '副', S.INMARSAT4, { rep: 'Inmarsat-4',
      confidence: 'primary',
      note: '代表星 Inmarsat-4（E3000 派生）L 频段主反射面「Nine metres wide」，非典型大口径；常规 E3000 Ku/Ka 星反射面口径无一手来源'
    })
  },
  fieldGaps: ['wings']
}

T['flat-leo'] = {
  id: 'flat-leo', title: 'Flat-panel LEO (Starlink v1.5 class)', titleZh: '平板 LEO（星链 v1.5 类）', layout: 'leo-flat', detail: 'leo',
  manufacturer: 'SpaceX（参照）',
  representative: 'Starlink v1.0 / v1.5',
  fields: {
    bus: F({ xM: 1.3, yM: 2.8, zM: null }, 'm', S.MCDOWELL_STARSIM, { rep: 'Starlink v1.5',
      confidence: 'secondary',
      note: 'v1.5「2.8 x 1.3m」（McDowell 转录 SpaceX 2022-10 FCC 文件）。太阳翼沿 2.8 m 边伸出（2.8+8.1≈11 m 端到端），故 2.8 m 记 Y（翼轴）、1.3 m 记 X；厚度未给'
    }),
    launchMassKg: F(260, 'kg', S.NSSDC_STARLINK, { rep: 'Starlink v1.0', confidence: 'primary', note: 'v1.0（NSSDCA）；v1.5 为 303 kg（McDowell）' }),
    repMassKg: F(303, 'kg', S.MCDOWELL_STARSIM, { rep: 'Starlink v1.5', confidence: 'secondary', note: 'v1.5「303」kg（与平台 / 阵列尺寸同一版本）；作整星估算质量' }),
    dryMassKg: NIL('kg', '未公开'),
    payloadPowerKW: NIL('kW', '未公开'),
    totalPowerKW: NIL('kW', '未公开'),
    designLifeYr: F(5, 'yr', S.SPACECOM_STARLINK, { confidence: 'secondary', note: '媒体口径约 5 年' }),
    wings: F(1, '翼', S.NSSDC_STARLINK, { rep: 'Starlink v1.0', confidence: 'primary', note: '「a flat panel design with a single solar panel」' }),
    panelsPerWing: NIL('块', '未公开'),
    panelSize: F({ alongM: 8.1, acrossM: 2.8 }, 'm', S.MCDOWELL_STARSIM, { rep: 'Starlink v1.5', confidence: 'secondary', note: 'v1.5 单翼阵列「2.8 x 8.1m」' }),
    spanM: F(11, 'm', S.SFN_STARLINK_V2, { rep: 'Starlink v1 系列', confidence: 'secondary', note: 'v1 系列「about 36 feet (11 meters) end-to-end」（近似）' }),
    reflectors: F({ count: 0, diametersM: [] }, '副', null, { note: '平板相控阵，无反射面天线（结构属性，非数值来源）' })
  },
  fieldGaps: ['bus.zM', 'panelsPerWing']
}

// 立方星：CDS 的六种标准尺寸。NASA SOA 2023 表 6-1 是主值（CDS Rev 14.1 附录 B 的尺寸是位图，无法逐字检索）。
const CUBESAT_ROWS = [
  ['cubesat-1u', '1U', { xM: 0.1, yM: 0.1, zM: 0.1135 }, 2, '1U 100 x 100 x 113.5'],
  ['cubesat-1.5u', '1.5U', { xM: 0.1, yM: 0.1, zM: 0.1702 }, 3, '1.5U 100 x 100 x 170.2'],
  ['cubesat-2u', '2U', { xM: 0.1, yM: 0.1, zM: 0.227 }, 4, '2U 100 x 100 x 227'],
  ['cubesat-3u', '3U', { xM: 0.1, yM: 0.1, zM: 0.3405 }, 6, '3U 100 x 100 x 340.5'],
  ['cubesat-6u', '6U', { xM: 0.1, yM: 0.2263, zM: 0.366 }, 12, '6U 100 x 226.3 x 366'],
  ['cubesat-12u', '12U', { xM: 0.2263, yM: 0.2263, zM: 0.366 }, 24, '12U 226.3 x 226.3 x 366']
]
for (const [id, u, dims, mMax, quote] of CUBESAT_ROWS) {
  T[id] = {
    id, title: `CubeSat ${u}`, titleZh: `立方星 ${u}`, layout: 'cubesat', detail: 'cubesat',
    manufacturer: '标准：Cal Poly CubeSat Design Specification Rev. 14.1（2022-02）',
    representative: null,
    fields: {
      bus: F(dims, 'm', S.NASA_SOA_STRUCT, {
        confidence: 'primary',
        note: `NASA《State-of-the-Art of Small Spacecraft Technology》2023 表 6-1「${quote}」（mm→m）；轴向按 CDS：Z 为导轨方向（长轴）`
      }),
      launchMassKg: F({ max: mMax }, 'kg', S.CDS_14_1, { confidence: 'primary', note: 'CDS Rev 14.1 表 1 典型最大质量（可按任务放宽）；生成器把它当估算质量' }),
      wings: F(0, '翼', null, { note: '标准未规定展开板；缺省体装电池片（结构选项，非数值来源）' })
    },
    fieldGaps: []
  }
}

T.generic = {
  id: 'generic', title: 'Generic small satellite', titleZh: '通用小卫星', layout: 'geo', detail: 'small',
  manufacturer: null,
  representative: null,
  illustrative: true,   // 整个模板都是工程示意（任务书：generic 可取整数常见值）
  fields: {
    bus: F({ xM: 1.0, yM: 1.0, zM: 1.2 }, 'm', 'illustrative'),
    wings: F(2, '翼', 'illustrative'),
    panelsPerWing: F(2, '块', 'illustrative'),
    panelSize: F({ alongM: 1.0, acrossM: 0.9 }, 'm', 'illustrative'),
    spanM: NIL('m', '由轭长与板长决定'),
    reflectors: F({ count: 0, diametersM: [] }, '副', 'illustrative', { note: '盒 + 两翼；对地板只放小喇叭' })
  },
  fieldGaps: []
}

export const templateModelId = (id) => `param:${id}`

// ───────────────────────────── 模板 → spec ─────────────────────────────

const clone = (o) => JSON.parse(JSON.stringify(o))
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
/** 模板字段 → specSources 条目。source 可能带代表星前缀；url 是纯链接（'illustrative' 等非链接出处为 null）。 */
const src = (f) => (f && f.source ? { source: f.source, url: f.url || null, rep: f.rep || null, note: f.note || null, kind: f.source === 'illustrative' ? 'illustrative' : 'source' } : null)
const ill = (note) => ({ source: 'illustrative', url: null, rep: null, note, kind: 'illustrative' })
const der = (note, from) => ({ source: 'derived', url: null, rep: null, note, kind: 'derived', from })
// 从模板字段取数（null / 缺 → null）
const val = (f) => (f && f.value !== undefined ? f.value : null)
const SIDE_SLOTS = ['+X', '-X', '+X2', '-X2']

/**
 * 数据缺口登记器（缺口口径见文件头）。
 *   gap(path, fillValue, note, ssKey)：path 进 needsInput；fill 模式返回示意值、登记 illustrative 与 specSources[ssKey]，
 *     none 模式返回 null（spec 里留空，validateSpec 报缺）。
 *   illOnly(path, value, note, ssKey)：列表本身是缺口、fill 模式新造出来的条目里的示意字段——none 模式下这些条目根本
 *     不存在，所以不进 needsInput，只进 illustrative。
 */
function gapper(out, doFill) {
  return {
    gap(path, fillValue, note, ssKey = path) {
      out.needsInput.push(path)
      if (!doFill) return null
      out.illustrative.push(path); out.specSources[ssKey] = ill(note)
      return fillValue
    },
    illOnly(path, value, note, ssKey = path) { out.illustrative.push(path); out.specSources[ssKey] = ill(note); return value }
  }
}

/** 空白反射面条目（口径未知）：生成页「加反射面」的初值；焦距 / 偏置留 null = paramBus 按 f/D 与槽位自动。 */
const blankReflector = () => ({ diameterM: null, focalM: null, offsetHM: null, posBody: null, boresightBody: [0, 0, 1], feedType: 'horn', mesh: false, shaped: false })

/**
 * 整星估算质量（spec.massTargetKg）：代表星单值 > 平台发射质量单值 > 区间中值（记 derived）> 无（按密度表）。
 * 为什么要它：发射手册的平台尺寸多是含收拢天线的包络，按体密度算会把 SSL-1300 算成二十多吨；
 * 有出处的发射质量把总量钉住，平台体吃掉余量（paramBus 里做），质心仍按各组件位置算。
 */
function massTarget(f) {
  const rep = val(f.repMassKg), lm = val(f.launchMassKg)
  if (isNum(rep)) return { value: rep, src: src(f.repMassKg) }
  if (isNum(lm)) return { value: lm, src: src(f.launchMassKg) }
  if (lm && isNum(lm.min) && isNum(lm.max)) return { value: (lm.min + lm.max) / 2, src: der(`发射质量区间 ${lm.min}–${lm.max} kg 中值`, f.launchMassKg.url) }
  return { value: null, src: null }
}

/**
 * GEO 布局族：模板 → spec。
 * 次序：先填有出处的，再按需反推（轭长、E3000 板型），缺口一律经 gapper 走（none 留 null / fill 补示意值）。
 */
function geoSpec(tpl, fill, out) {
  const D = DETAIL_PRESETS[tpl.detail]
  const f = tpl.fields
  const doFill = fill === 'illustrative'
  const ss = out.specSources
  const { gap, illOnly } = gapper(out, doFill)
  // 示意补位的说明：数据模板写明「无公开数据」，整模板都是示意的（默认卫星）不写
  const fillWhy = tpl.illustrative ? '' : '无公开数据，'

  // —— 平台体
  const bv = val(f.bus) || {}
  const bus = { shape: 'box', xM: null, yM: null, zM: null, mli: 'mli_gold', massKg: null }
  for (const k of ['xM', 'yM', 'zM']) {
    if (isNum(bv[k])) { bus[k] = bv[k]; ss[`bus.${k}`] = src(f.bus) }
    else bus[k] = gap(`bus.${k}`, GEO_FILL.bus[k], `示意值：${fillWhy}取典型 GEO 大平台对应边 ${GEO_FILL.bus[k]} m`)
  }

  // —— 太阳翼：翼数
  let nWings = val(f.wings)
  const wingsGap = !isNum(nWings)
  if (!wingsGap) ss.wings = src(f.wings)
  else nWings = gap('wings', 2, '示意值：GEO 三轴稳定平台南北两翼布局')

  // —— 板数 / 板尺寸（有出处的数据值；E3000 按跨度反推板型）
  let panelSize = val(f.panelSize)
  let panelSrc = src(f.panelSize)
  let panels = val(f.panelsPerWing)
  let panelsSrc = src(f.panelsPerWing)
  const span = val(f.spanM)
  const spanNum = isNum(span) ? span : null
  const spanTxt = spanNum !== null ? `${f.spanM.rep ? f.spanM.rep + ' ' : ''}跨度 ${spanNum} m` : ''
  const wingLenOf = (yM) => (spanNum !== null && isNum(yM) ? (spanNum - yM) / 2 : null)

  // E3000：研究稿给的是 SX/S/L/LX 四型范围 → 按 Y1A 跨度反推取 L 型（4 块长板），出处与推理都记下
  if (panelSize && panelSize.long && panels && typeof panels === 'object') {
    const wingLen = wingLenOf(bus.yM)
    const cand = [['long', 5], ['long', 4], ['short', 4], ['short', 3]]
    let pick = null
    for (const [kind, n] of cand) {
      const p = panelSize[kind]
      if (wingLen === null) break
      const yoke = wingLen - D.sadaLenM - n * p.alongM - (n - 1) * D.gapM
      if (yoke >= 0.5 && yoke <= 4) { pick = { kind, n, p }; break }
    }
    if (pick) {
      panels = pick.n; panelSize = pick.p
      panelsSrc = der(`由${spanTxt}（${f.spanM.url}）反推：只有 ${pick.kind === 'long' ? 'L 型（长板）' : 'S 型（短板）'} ${pick.n} 块时轭长落在 0.5–4 m`, f.panelsPerWing.url)
      panelSrc = der(`${pick.kind === 'long' ? '长板' : '短板'} ${pick.p.alongM} × ${pick.p.acrossM} m（${f.panelSize.url}）`, f.panelSize.url)
    } else { panels = null; panelSize = null }
  }
  const psData = panelSize && isNum(panelSize.alongM) && isNum(panelSize.acrossM) ? panelSize : null
  const nData = isNum(panels) ? panels : null
  if (psData) { ss['wings[*].panelHM'] = panelSrc; ss['wings[*].panelWM'] = panelSrc }
  if (nData !== null) ss['wings[*].panels'] = panelsSrc
  const sidePanels = isNum(val(f.sidePanelsPerWing)) ? val(f.sidePanelsPerWing) : 0
  if (sidePanels) ss['wings[*].sidePanels'] = src(f.sidePanelsPerWing)
  ss['wings[*].gapM'] = ill(`示意值 ${D.gapM} m`)

  // 示意补位的取值（只在 fill 模式真正写进 spec）
  const psFill = psData || { alongM: GEO_FILL.panel.alongM, acrossM: GEO_FILL.panel.acrossM }
  let nFill = nData, nFillNote = null
  if (nFill === null) {
    // 跨度有出处时按跨度排得下的块数（轭长 ≥ 1 m）取，否则 4 块
    const wl = wingLenOf(bus.yM)
    nFill = wl !== null ? Math.max(1, Math.floor((wl - D.sadaLenM - 1 + D.gapM) / (psFill.alongM + D.gapM))) : 4
    nFillNote = wl !== null ? `示意值：按${spanTxt}排得下的块数（轭长 ≥ 1 m）` : '示意值：每翼 4 块'
  }

  // 轭长：跨度（精确值，不是下限）+ 平台 Y + 块数 + 板长齐了就反推；否则示意。块数 / 板长取本模式下条目里实际写的值
  const yokeFor = (n, ps, anyIll, warn) => {
    const wl = wingLenOf(bus.yM)
    if (wl === null || !isNum(n) || !ps || !isNum(ps.alongM)) return null
    const y = wl - D.sadaLenM - n * ps.alongM - (n - 1) * D.gapM
    if (!(y >= 0.3 && y <= 8)) {
      if (warn) out.warnings.push(`${spanTxt}反推的轭长 ${y.toFixed(2)} m 越出 0.3–8 m，取示意值 ${D.yokeLenM} m`)
      return null
    }
    return {
      value: Math.round(y * 1000) / 1000,
      src: der(`(${spanTxt} − 平台 Y ${bus.yM} m)/2 − SADA ${D.sadaLenM} − ${n}×${ps.alongM} − ${n - 1}×缝 ${D.gapM}${anyIll ? '（部分输入为示意值）' : ''}`, f.spanM.url)
    }
  }
  const anyIll = doFill && (nData === null || !psData || out.needsInput.includes('bus.yM'))
  const yk = yokeFor(doFill ? nFill : nData, doFill ? psFill : psData, anyIll, true)
  const yokeLenM = yk ? yk.value : D.yokeLenM
  ss['wings[*].yokeLenM'] = yk ? yk.src : ill(`示意值 ${D.yokeLenM} m`)
  const ykData = doFill ? yokeFor(nData, psData, false, false) : yk

  // 「加翼」初值：只放有出处 / 可反推的值，查不到的为 null
  out.itemDefaults.wing = {
    panels: nData, panelHM: psData ? psData.alongM : null, panelWM: psData ? psData.acrossM : null,
    sidePanels, yokeLenM: ykData ? ykData.value : D.yokeLenM, gapM: D.gapM, tiltDeg: 0, axis: 'y'
  }

  let wingList = null
  if (isNum(nWings)) {
    wingList = []
    if (nWings > 2) out.warnings.push(`翼数 ${nWings} 超出南北两翼布局，只画 2 翼`)
    const sides = nWings >= 2 ? ['+Y', '-Y'] : (nWings === 1 ? ['+Y'] : [])
    sides.forEach((side, i) => {
      // 翼数有出处 → 条目字段缺口进 needsInput；翼数本身是示意（只有 fill 模式走到这）→ 只进 illustrative
      const put = (key, v, note) => (wingsGap ? illOnly(`wings[${i}].${key}`, v, note, `wings[*].${key}`) : gap(`wings[${i}].${key}`, v, note, `wings[*].${key}`))
      const w = { side, ...out.itemDefaults.wing, yokeLenM }
      if (nData === null) w.panels = put('panels', nFill, nFillNote)
      if (!psData) {
        w.panelHM = put('panelHM', psFill.alongM, `示意值：${fillWhy}取典型 GEO 大平台板长 ${psFill.alongM} m`)
        w.panelWM = put('panelWM', psFill.acrossM, `示意值：${fillWhy}取典型 GEO 大平台板宽 ${psFill.acrossM} m`)
      }
      wingList.push(w)
    })
  }

  // —— 反射面
  const rv = val(f.reflectors)
  const dList = rv && Array.isArray(rv.diametersM) && rv.diametersM.length ? rv.diametersM : null
  const mkRefl = (slot, D0) => {
    const mesh = D0 > D.meshAboveDM
    const fd = mesh ? D.fdMesh : D.fdSolid
    const r = { ...blankReflector(), diameterM: D0, focalM: Math.round(fd * D0 * 1000) / 1000, feedType: mesh ? 'array' : 'horn', mesh }
    return slot ? { slot, mount: slot.startsWith('deck') ? 'deck' : 'side', ...r } : r
  }
  out.itemDefaults.reflector = dList && dList.length === 1 ? mkRefl(null, dList[0]) : blankReflector()
  let reflectors
  if (dList && isNum(rv.count)) {
    // 数量与口径都有出处（SSL-1300 / E3000 的代表星）
    reflectors = []
    for (let i = 0; i < rv.count && i < SIDE_SLOTS.length; i++) reflectors.push(mkRefl(SIDE_SLOTS[i], dList[Math.min(i, dList.length - 1)]))
    if (rv.count > SIDE_SLOTS.length) out.warnings.push(`反射面 ${rv.count} 副超出东西侧 ${SIDE_SLOTS.length} 个槽位，只画 ${SIDE_SLOTS.length} 副`)
    ss.reflectors = src(f.reflectors); ss['reflectors[*].diameterM'] = src(f.reflectors)
  } else if (rv && rv.count === 0) {
    reflectors = []
    ss.reflectors = src(f.reflectors)
  } else if (dList) {
    // 只有口径（Spacebus 4000）：数量是缺口；示意 2 副（东西各一），口径有出处
    ss['reflectors[*].diameterM'] = src(f.reflectors)
    reflectors = gap('reflectors', [mkRefl('+X', dList[0]), mkRefl('-X', dList[0])], '示意值：东西侧各 1 副')
  } else {
    const d1 = D.illustrativeReflectorDM, d2 = D.illustrativeDeckReflectorDM
    reflectors = gap('reflectors', [mkRefl('+X', d1), mkRefl('-X', d1), mkRefl('deck+Y', d2), mkRefl('deck-Y', d2)], '示意值：东西侧各 1 副 + 对地板南北各 1 副')
    if (reflectors) reflectors.forEach((r, i) => illOnly(`reflectors[${i}].diameterM`, r.diameterM, `示意值：侧挂 ${d1} m、对地板 ${d2} m`, 'reflectors[*].diameterM'))
  }
  ss['reflectors[*].focalM'] = ill(`示意值：f/D ${D.fdSolid}（实面）/ ${D.fdMesh}（网状，> ${D.meshAboveDM} m）`)
  ss['reflectors[*].offsetHM'] = ill('自动：内缘离侧壁留净空')

  const mt = massTarget(f)
  if (mt.src) ss.massTargetKg = mt.src
  out.spec = {
    layout: 'geo', template: tpl.id, name: tpl.titleZh, detailPreset: tpl.detail,
    massTargetKg: mt.value,
    bus, wings: wingList, reflectors,
    detail: { mli: true, radiators: true, thrusters: true, adapter: true, deckHorns: D.deckHorns }
  }
}

function leoSpec(tpl, fill, out) {
  const D = DETAIL_PRESETS[tpl.detail]
  const f = tpl.fields
  const ss = out.specSources
  const { gap } = gapper(out, fill === 'illustrative')
  const bv = val(f.bus)
  const bus = { shape: 'box', xM: bv.xM, yM: bv.yM, zM: null, mli: null, massKg: null }
  ss['bus.xM'] = src(f.bus); ss['bus.yM'] = src(f.bus)
  if (isNum(bv.zM)) { bus.zM = bv.zM; ss['bus.zM'] = src(f.bus) }
  else bus.zM = gap('bus.zM', 0.25, '示意值：平板平台厚 0.25 m')
  const nData = isNum(val(f.panelsPerWing)) ? val(f.panelsPerWing) : null
  if (nData !== null) ss['wings[*].panels'] = src(f.panelsPerWing)
  const ps = val(f.panelSize)
  ss['wings[*].panelHM'] = src(f.panelSize); ss['wings[*].panelWM'] = src(f.panelSize)
  ss.wings = src(f.wings)
  // 轭长：端到端 11 m − 平台 2.8 m − 阵列 8.1 m（− SADA）
  let yokeLenM = 0.1
  const span = val(f.spanM)
  if (isNum(span)) {
    const y = span - bus.yM - ps.alongM - D.sadaLenM
    yokeLenM = Math.max(0, Math.round(y * 1000) / 1000)
    ss['wings[*].yokeLenM'] = der(`端到端 ${span} m − 平台 ${bus.yM} m − 阵列 ${ps.alongM} m − SADA ${D.sadaLenM} m（夹到 ≥ 0）`, f.spanM.url)
  } else ss['wings[*].yokeLenM'] = ill(`示意值 ${yokeLenM} m`)
  ss['wings[*].gapM'] = ill(`示意值 ${D.gapM} m`)
  out.itemDefaults.wing = { panels: nData, panelHM: ps.alongM, panelWM: ps.acrossM, sidePanels: 0, yokeLenM, gapM: D.gapM, tiltDeg: 0, axis: 'y' }
  out.itemDefaults.reflector = blankReflector()
  // 单翼（McDowell：阵列沿 2.8 m 边伸出，一侧），翼数有出处 → 条目字段缺口进 needsInput
  const w = { side: '+Y', ...out.itemDefaults.wing }
  if (nData === null) w.panels = gap('wings[0].panels', 1, '示意值：单条连续阵列画作 1 块', 'wings[*].panels')
  const mt = massTarget(f)
  if (mt.src) ss.massTargetKg = mt.src
  out.spec = {
    layout: 'leo-flat', template: tpl.id, name: tpl.titleZh, detailPreset: tpl.detail,
    massTargetKg: mt.value,
    bus,
    wings: [w],
    reflectors: [],
    phasedArray: { tiles: D.phasedTiles },
    detail: { mli: false, radiators: false, thrusters: true, adapter: false, deckHorns: 0 }
  }
  ss.reflectors = src(f.reflectors)
  ss['phasedArray.tiles'] = ill(`示意值：对地面 ${D.phasedTiles} 块相控阵面`)
}

function cubesatSpec(tpl, fill, out) {
  const f = tpl.fields
  const ss = out.specSources
  const bv = val(f.bus)
  const mMax = val(f.launchMassKg)
  out.spec = {
    layout: 'cubesat', template: tpl.id, name: tpl.titleZh, detailPreset: tpl.detail,
    massTargetKg: mMax && isNum(mMax.max) ? mMax.max : null,
    bus: { shape: 'box', xM: bv.xM, yM: bv.yM, zM: bv.zM, mli: null, massKg: null },
    wings: [], reflectors: [],
    cubesat: { bodyCells: true, deployPanels: 0 },
    detail: { mli: false, radiators: false, thrusters: false, adapter: false, deckHorns: 0 }
  }
  out.itemDefaults.reflector = blankReflector()
  ss['bus.xM'] = src(f.bus); ss['bus.yM'] = src(f.bus); ss['bus.zM'] = src(f.bus)
  ss.massTargetKg = { ...src(f.launchMassKg), note: 'CDS 典型最大质量，当整星估算质量用' }
  ss['cubesat.bodyCells'] = ill('示意：体装电池片')
}

function genericSpec(tpl, fill, out) {
  geoSpec(tpl, fill, out)
  out.spec.detail.deckHorns = DETAIL_PRESETS.small.deckHorns
}

/**
 * 模板 → paramBus spec（缺口口径见文件头）。
 * @param {string} id 模板 id（TEMPLATE_IDS 之一；旧 id 别名按 resolveTemplateId 换成现行模板，返回的 spec.template 是现行 id）
 * @param {{fill?:'illustrative'|'none'}} [opts]
 * @returns {{ spec:object|null, needsInput:string[], illustrative:string[],
 *             specSources:Object<string,{source:string,url:string|null,rep:string|null,note:string|null,kind:'source'|'derived'|'illustrative',from?:string}>,
 *             itemDefaults:{wing:object|null, reflector:object|null},
 *             warnings:string[] }}
 *   未知 id 返回 spec:null。
 */
export function templateSpec(id, opts = {}) {
  const tid = resolveTemplateId(id)
  const tpl = tid ? T[tid] : null
  const out = { spec: null, needsInput: [], illustrative: [], specSources: {}, itemDefaults: { wing: null, reflector: null }, warnings: [] }
  if (!tpl) { out.warnings.push(`未知模板「${id}」`); return out }
  const fill = opts && opts.fill === 'none' ? 'none' : 'illustrative'
  if (tpl.layout === 'leo-flat') leoSpec(tpl, fill, out)
  else if (tpl.layout === 'cubesat') cubesatSpec(tpl, fill, out)
  else if (tpl.id === 'generic') genericSpec(tpl, fill, out)
  else geoSpec(tpl, fill, out)
  out.spec = clone(out.spec)
  out.itemDefaults = clone(out.itemDefaults)
  return out
}

/**
 * 参数化模型条目（ModelMeta 片段，给内置 manifest / 库页用；几何运行时由 paramBus 生成，没有 files）。
 * source.kind='param'、redistributable=true（本平台生成的几何，无第三方权利）。needsInput 为 spec 路径。
 */
export function templateCatalog() {
  return TEMPLATE_IDS.map((id) => {
    const t = T[id]
    const tags = ['param', t.layout]
    if (t.layout === 'geo' && id !== 'generic') tags.push('geo', 'comsat')
    const aliases = [t.title, t.titleZh].filter(Boolean)
    return {
      id: templateModelId(id), templateId: id, title: t.title, titleZh: t.titleZh,
      kind: 'spacecraft', group: 'spacecraft', fidelity: 'parametric',
      source: { kind: 'param', url: '', credit: '卫星仿真平台参数化生成' + (t.representative ? `；尺寸参照 ${t.representative}` : ''), license: 'param', redistributable: true },
      tags, aliases, needsInput: t.needsInput.slice()
    }
  })
}

// ───────────────────────────── 缓存 needsInput + 冻结 ─────────────────────────────
// 放在文件末尾：templateSpec 用到上面的 const 工具（TDZ），必须等它们都初始化完才能在加载期调用。
for (const id of Object.keys(T)) T[id].needsInput = templateSpec(id, { fill: 'none' }).needsInput

// 冻结：模板是只读参考数据，调用方误改会串到其它窗口 / 下次生成。
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]) } return o }
export const TEMPLATES = deepFreeze(T)
export const TEMPLATE_IDS = Object.freeze([DEFAULT_TEMPLATE_ID, 'ssl1300', 'spacebus4000', 'eurostar3000', 'flat-leo',
  'cubesat-1u', 'cubesat-1.5u', 'cubesat-2u', 'cubesat-3u', 'cubesat-6u', 'cubesat-12u', 'generic'])
