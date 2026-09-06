// 独立《服务等级指标（SLA）》报告的模型（渲染端组装，纯数据）。
//
// 与 lbReport.js 的分工：那边是【链路预算报告】的模型（级联、瀑布、图件、输入清单），这边只组
// SLA 那一份 —— 不取图、不组瀑布、不带输入清单。两个 Word/Excel 渲染器（reportSlaDocx.js /
// reportSla.js）都只认这里翻好的字，不各带一份字典（同 lbReport 的口径）。
//
// 口径：
//   ① 条款的值一律来自 lbSla.slaReportBlock（已按单位档格式化、已按 lang 翻好），本文件不算数；
//   ② definitions 只列【这份报告里真出现过的条款】—— 报告里没有的指标不该给读者一条定义；
//   ③ refs 同理，只列真用到的建议书/标准（月口径才有 P.841、有 DVB 链路才有 EN 302 307…）；
//   ④ 纯数字：定义与口径可以成段写（报告是交付文档不是界面），但一样禁「达标/合格/受限/满足」
//      一类文字判定 —— 见仓库根 CLAUDE.md。
//   ⑤ scan.rows / summary 里的数都是【数】，小数位由渲染器定（同瀑布段 fixedDecimals 的做法）。

import { labelBundle, schemeOf, schemeName, schemeSub, defaultDocInfo, translate } from './lbReport.js'
import { num } from './lbSla.js'

/** 报告名：与全报告 §4 的章名一致（「服务等级指标（SLA）」），不叫「服务等级协议技术附件」 */
export function slaReportTitle(satName, band, lang, orbitType) {
  const en = lang === 'en'
  if (orbitType === 'E2E') return en ? 'End-to-End Link Service Level Metrics (SLA)' : '端到端链路服务等级指标（SLA）'
  const sat = String(satName || '').trim()
  const bd = String(band || '').trim()
  if (en) {
    const head = [sat && sat + ' Satellite', bd && bd + '-Band'].filter(Boolean).join(' ')
    return (head ? head + ' ' : 'Satellite ') + 'Service Level Metrics (SLA)'
  }
  const head = [sat && sat + ' 卫星', bd && bd + ' 频段'].filter(Boolean).join(' ')
  return (head || '卫星') + '服务等级指标（SLA）'
}

// —— 条款定义表 ——
// 每条 { key, term, definition, formula, period, basis }：
//   formula 用与依据列同一套符号（读者拿依据列的数代进来就能复算）；
//   period  随考核周期；basis 写标准编号，没有出处的（合同条款）留「—」，不编。
const D = (zh, en) => ({ zh, en })
const DEFS = {
  propAvail: {
    def: D('链路在给定时间百分比内不因传播（雨衰、云衰、大气吸收）中断的时间占比。',
      'Fraction of time the link is not interrupted by propagation effects (rain, cloud and gaseous attenuation).'),
    fml: 'A_传播 = A_上行 × A_下行',
    fmlEn: 'A_prop = A_up × A_down',
    basis: 'ITU-R P.618-14 / P.837-7 / P.838-3 / P.839-4 / P.840-9 / P.676-13'
  },
  visAvail: {
    def: D('星间链路两端卫星几何互视的时间占比。', 'Fraction of time the two satellites of an inter-satellite link see each other geometrically.'),
    fml: 'A_互视 = T_互视 / T', fmlEn: 'A_vis = T_visible / T', basis: '—'
  },
  sysAvail: {
    def: D('传播、发信射频、收信射频、卫星与载荷（及基带/骨干网）各环节同时可用的时间占比，向下取标准档。',
      'Fraction of time the propagation path, the transmit and receive RF chains, the satellite and payload (and optionally the baseband/backbone) are all available; snapped down to a standard tier.'),
    fml: 'A = A_传播 × A_发信射频 × A_收信射频 × A_卫星与载荷 × A_基带骨干网',
    fmlEn: 'A = A_prop × A_txRF × A_rxRF × A_sat × A_backbone',
    basis: 'ITU-R S.579'
  },
  outageMin: {
    def: D('一个考核周期内允许的累计中断时长上限，由采用可用度换算。',
      'Upper bound on the cumulative outage time within one assessment period, derived from the adopted availability.'),
    fml: 'T_中断 = (100 − A) / 100 × T_周期', fmlEn: 'T_outage = (100 − A) / 100 × T_period', basis: '—'
  },
  settledBw: {
    def: D('转发器上按带宽与功率两本账取大者结算的带宽。', 'Transponder bandwidth billed as the larger of the bandwidth-limited and power-limited demands.'),
    fml: 'B_结算 = max(B_载波, 功率占用比 × B_转发器)', fmlEn: 'B_settled = max(B_carrier, power ratio × B_transponder)', basis: '—'
  },
  cir: {
    def: D('设计可用度下、链路余量不小于零时的信息速率。', 'Information rate at the design availability with a link margin of not less than zero.'),
    fml: 'CIR = 符号率 × 组合效率', fmlEn: 'CIR = symbol rate × combined efficiency',
    basis: 'ETSI EN 302 307-1/-2'
  },
  mir: {
    def: D('ACM 在同一符号率内切到晴空可支撑的最高效率档时的信息速率，保留同样的系统余量。',
      'Information rate when ACM switches, at the same symbol rate, to the highest-efficiency mode the clear-sky condition supports, keeping the same system margin.'),
    fml: 'Es/N₀(晴空) − 系统余量 ≥ 门限(档)', fmlEn: 'Es/N₀(clear sky) − system margin ≥ threshold(mode)',
    basis: 'ETSI EN 302 307-1/-2'
  },
  owd: {
    def: D('信号自发信端到收信端的单程传输时延，不含地面段与排队。',
      'One-way transmission delay from the transmit end to the receive end, excluding the terrestrial segment and queuing.'),
    fml: 'T_单程 = Σ 路径距离 / c', fmlEn: 'T_one-way = Σ path range / c', basis: '—'
  },
  rtt: {
    def: D('一次往返的时延上限，计入两趟单程传输与调制解调的处理时延预留，向上取到 10 ms。',
      'Upper bound on round-trip delay, counting two one-way transmissions plus the modem processing allowance, rounded up to 10 ms.'),
    fml: 'RTT = ⌈2 × (T_单程 + T_处理) / 10⌉ × 10',
    fmlEn: 'RTT = ⌈2 × (T_one-way + T_proc) / 10⌉ × 10', basis: '—'
  },
  jitter: {
    def: D('相邻分组时延之差的上限，按合同约定给定。', 'Upper bound on the variation of packet delay, given by contract.'),
    fml: '—', fmlEn: '—', basis: '—'
  },
  berTarget: {
    def: D('载波配置中设定的解调门限对应的误码率。', 'Bit error ratio at which the demodulation threshold of the carrier configuration is defined.'),
    fml: '—', fmlEn: '—', basis: 'ITU-R S.1062'
  },
  loss: {
    def: D('可用时间内 IP 分组丢失比例的上限；中断时段不计入本项统计。',
      'Upper bound on the proportion of IP packets lost within the available time; outage periods are excluded from this statistic.'),
    fml: 'p = 1 − (1 − FER)^N_f，N_f = ⌈8L / K⌉',
    fmlEn: 'p = 1 − (1 − FER)^N_f, N_f = ⌈8L / K⌉',
    basis: 'ETSI EN 302 307-1 §4.1（QEF）/ ITU-R S.1062',
    basisEn: 'ETSI EN 302 307-1 §4.1 (QEF) / ITU-R S.1062'
  },
  respond: {
    def: D('自故障申告至响应的时限，按合同约定给定。', 'Time limit from fault report to response, given by contract.'),
    fml: '—', fmlEn: '—', basis: '—'
  },
  restore: {
    def: D('自故障申告至业务恢复的时限，按合同约定给定。', 'Time limit from fault report to service restoration, given by contract.'),
    fml: '—', fmlEn: '—', basis: '—'
  },
  sunOutage: {
    def: D('春分、秋分前后太阳进入收信站天线主瓣所致的年度预计中断时长，列为免责事件。',
      'Predicted annual outage caused by the Sun entering the receive antenna main lobe around the equinoxes; listed as an excluded event.'),
    fml: 'ΔT_太阳 / T_系统 → C/N 恶化 ≥ 1 dB', fmlEn: 'ΔT_sun / T_sys → C/N degradation ≥ 1 dB', basis: '—'
  },
  txFreq: {
    def: D('上行载波中心频率及其占用的频段。', 'Uplink carrier centre frequency and the band it occupies.'),
    fml: 'f_c ± B / 2', fmlEn: 'f_c ± B / 2', basis: '—'
  },
  txBw: {
    def: D('上行载波的分配带宽。', 'Allocated bandwidth of the uplink carrier.'),
    fml: 'B = 符号率 × 带宽系数', fmlEn: 'B = symbol rate × bandwidth factor', basis: '—'
  },
  txEirp: {
    def: D('发信站在雨衰工况下的最大等效全向辐射功率，含上行功率控制抬升与容差。',
      'Maximum equivalent isotropically radiated power of the transmit station under rain, including the uplink power control increase and the tolerance.'),
    fml: 'EIRP_max = EIRP_晴空 + UPC + 容差', fmlEn: 'EIRP_max = EIRP_clear sky + UPC + tolerance', basis: '—'
  },
  txPsd: {
    def: D('发信站在 4 kHz 参考带宽内的最大功率谱密度，含上行功率控制抬升与容差。',
      'Maximum power spectral density of the transmit station in a 4 kHz reference bandwidth, including the uplink power control increase and the tolerance.'),
    fml: 'PSD_max = PSD + 10·lg(4000) + UPC + 容差', fmlEn: 'PSD_max = PSD + 10·lg(4000) + UPC + tolerance', basis: '—'
  },
  txPol: {
    def: D('上行载波的极化方式。', 'Polarisation of the uplink carrier.'), fml: '—', fmlEn: '—', basis: '—'
  },
  txXpd: {
    def: D('发信站天线的交叉极化隔离度下限，按运营商入网要求给定。',
      'Lower bound on the cross-polarisation isolation of the transmit antenna, given by the operator access requirements.'),
    fml: '—', fmlEn: '—', basis: '—'
  }
}

/**
 * 条款定义表：只列 keys 里真出现过的条款（顺序按 SLA_ITEMS 的排布，由调用方给的 keys 顺序定）。
 * @param keys  出现过的条款 key（端到端的 settledBw:0 这类按基名归并）
 */
export function slaDefinitions(keys, terms, lang, monthly) {
  const en = lang === 'en'
  const period = en ? (monthly ? 'Worst month' : 'Annual mean') : (monthly ? '最坏月' : '年平均')
  const inTime = en ? 'Within available time' : '可用时间内'
  const PERIOD_OF = { propAvail: period, visAvail: period, sysAvail: period, outageMin: period, loss: inTime, sunOutage: en ? 'Annual' : '年' }
  const out = []
  for (const k of keys) {
    const d = DEFS[k]
    if (!d) continue
    out.push({
      key: k,
      term: terms[k] || k,
      definition: en ? d.def.en : d.def.zh,
      formula: en ? d.fmlEn : d.fml,
      period: PERIOD_OF[k] || '—',
      basis: en ? (d.basisEn || d.basis) : d.basis
    })
  }
  return out
}

/** 免责事件里那三条合同惯例条款：只列名，不编数（日凌另有预计窗口，见逐链路详情） */
export function slaExclusions(lang) {
  return lang === 'en'
    ? ['Planned maintenance agreed by both parties', 'Force majeure', 'Customer-side equipment and operation']
    : ['经双方确认的计划维护', '不可抗力', '客户侧设备与操作原因']
}

// —— 引用标准 ——
// 只列这份报告真用到的：传播那几项恒有；月口径才有 P.841；有 DVB / NTN 链路才有各自的标准。
const R = (id, zh, en, uzh, uen) => ({ id, zh, en, uzh, uen })
const REFS = {
  prop: [
    R('ITU-R P.618-14', '地球—空间链路传播数据与预测方法', 'Propagation data and prediction methods required for the design of Earth-space telecommunication systems',
      '雨衰预测与可用度统计', 'Rain attenuation prediction and availability statistics'),
    R('ITU-R P.837-7', '降雨特性建模', 'Characteristics of precipitation for propagation modelling', '站址 0.01% 超越降雨率 R0.01', 'Site 0.01 % exceedance rain rate R0.01'),
    R('ITU-R P.838-3', '雨衰比衰减系数模型', 'Specific attenuation model for rain for use in prediction methods', '由降雨率求比衰减 γR', 'Specific attenuation γR from rain rate'),
    R('ITU-R P.839-4', '降雨高度模型', 'Rain height model for prediction methods', '等效降雨高度与倾斜路径长度', 'Effective rain height and slant path length'),
    R('ITU-R P.840-9', '云雾衰减', 'Attenuation due to clouds and fog', '云衰减', 'Cloud attenuation'),
    R('ITU-R P.676-13', '大气气体衰减及相关效应', 'Attenuation by atmospheric gases and related effects', '氧气与水汽的路径吸收', 'Oxygen and water-vapour path absorption'),
    R('ITU-R P.453-14', '无线电折射率及其对传播的影响', 'The radio refractive index: its formula and refractivity data', '折射率相关量的取值基准', 'Refractivity reference data')
  ],
  monthly: [
    R('ITU-R P.841-6', '年统计量与最坏月统计量的换算', 'Conversion of annual statistics to worst-month statistics',
      '可用度由年平均折算到最坏月', 'Conversion of availability from the annual mean to the worst month')
  ],
  dvb: [
    R('ETSI EN 302 307-1/-2', '数字卫星广播第二代及其扩展（DVB-S2 / S2X）', 'Second generation framing, coding and modulation for satellite broadcasting and extensions (DVB-S2 / S2X)',
      '准无误码（QEF）门限定义与 FECFRAME 长度 —— 丢包率的帧差错口径', 'Quasi-error-free (QEF) threshold definition and FECFRAME length — the frame-error basis of the packet loss figure')
  ],
  ntn: [
    R('3GPP TS 38.211 / TS 38.214', 'NR 物理信道与物理层数据处理规程', 'NR physical channels and physical layer procedures for data',
      '传输块大小与 MCS 表 —— 信息速率与帧长', 'Transport block size and MCS tables — information rate and frame length'),
    R('3GPP TS 36.211', 'E-UTRA 物理信道与调制', 'E-UTRA physical channels and modulation', 'NB-IoT 资源单元与子帧结构', 'NB-IoT resource unit and subframe structure')
  ],
  sla: [
    R('ITU-R S.579-6', '固定卫星业务假想参考电路与数字链路的可用度目标', 'Availability objectives for a hypothetical reference circuit and a hypothetical reference digital path in the fixed-satellite service',
      '可用度指标的口径基准', 'Reference convention for the availability objective'),
    R('ITU-R S.1062-4', '固定卫星业务数字链路的误码性能', 'Allowable error performance for a hypothetical reference digital path in the fixed-satellite service',
      '误码与差错性能指标的口径基准', 'Reference convention for the error performance objectives')
  ]
}

/** 引用标准表：只列真用到的（分组已铺平，报告里就是一张三列表） */
export function slaRefs(lang, o) {
  o = o || {}
  const en = lang === 'en'
  const list = REFS.prop.slice()
  if (o.monthly) list.push(...REFS.monthly)
  if (o.hasDvb) list.push(...REFS.dvb)
  if (o.hasNtn) list.push(...REFS.ntn)
  list.push(...REFS.sla)
  return list.map((r) => ({ id: r.id, title: en ? r.en : r.zh, use: en ? r.uen : r.uzh }))
}

// —— 逐链路的一句话摘要（卫星 / 频段 / 载波 / 几何）——
// 数取引擎出参（与条款同源）；取不到的键留 null，渲染器按「—」出。
function summaryOf(l, calc) {
  const d = l.data || {}
  const c = calc || {}
  const n = (k) => num(d[k])
  return {
    satellite: l.satellite || c.satelliteName || '',
    band: l.band || c.frequencyBand || '',
    carrier: {
      infoRate: n('infoRateResult'),
      modcod: l.modcod || '',
      symbolRate: n('symbolRateResult'),
      bandwidth: n('allocBandwidthResult')
    },
    geometry: {
      elev: n('elevationResult') !== null ? n('elevationResult') : n('rxElevationResult'),
      slant: n('slantRangeResult') !== null ? n('slantRangeResult') : n('islRfDistResult')
    }
  }
}

// 档位扫描表：整列都取不到数的列由渲染器裁，这里只把数原样搬过去（不做格式化）
function scanOf(l) {
  const s = l.scan
  if (!s || !Array.isArray(s.rows) || !s.rows.length) return null
  const rows = s.rows.filter((r) => r && r.tag !== 'clear').map((r) => {
    const d = (r && r.data) || {}
    return {
      tier: num(r.tier), comp: num(r.comp), up: num(r.up), dn: num(r.dn),
      uplinkRain: num(d.uplinkRainAttenuation), downlinkRain: num(d.downlinkRainAttenuationResult),
      margin: num(d.linkmargin), powerUsage: num(d.powerUsageRatio), bwUsage: num(d.bandwidthUsageRatio),
      outage: num(r.outage)
    }
  })
  return rows.length ? { pin: s.pin || null, rows } : null
}

/**
 * SLA 报告模型。
 * @param o {
 *   lang, adaptUnits, doc, appVersion, orbitType, regenMode, calc,
 *   slaParams  已翻好的参数行（lbSla.slaParamRows(...) 的产物）
 *   monthly    考核周期（0/1）
 *   links      [{ no, rowId, txName, rxName, ok, error, data, satellite, band, modcod,
 *                 sla（slaReportBlock 的产物）, scan（含 comp / outage 的档位行）, sunOutage }]
 *   definitions / refs  可选覆盖（缺省按本文件的表按 lang 组）
 * }
 */
export function buildSlaReportModel(o) {
  o = o || {}
  const lang = o.lang === 'en' ? 'en' : 'zh'
  const t = labelBundle(lang)
  const scheme = schemeOf(o.orbitType || 'GEO', o.regenMode || 'uplink')
  const monthly = !!num(o.monthly)
  const links = (o.links || []).map((l) => ({
    no: l.no, rowId: l.rowId, txName: l.txName || '', rxName: l.rxName || '',
    ok: !!l.ok, error: l.error || '',
    sla: l.sla || null,
    scan: scanOf(l),
    summary: summaryOf(l, o.calc),
    sunOutage: l.sunOutage || null
  }))
  const hasSla = links.some((l) => l.sla && l.sla.rows && l.sla.rows.length)

  // 条款定义只列真出现过的：端到端的 settledBw:0 / settledBw:1 归到 settledBw 一条
  const seen = []
  const terms = {}
  for (const l of links) {
    for (const r of ((l.sla && l.sla.rows) || [])) {
      const base = String(r.key).split(':')[0]
      if (!terms[base]) { terms[base] = r.label; seen.push(base) }
    }
  }
  // 引用哪几份标准由【链路真用了什么】定：3GPP NTN 看物理层出参或体制名，DVB 看「选了标准」。
  // 报告里没算的东西不该给读者一个出处（同 lbReport.methodology 里 extCI 那条口径）。
  const isNtn = (l) => /3GPP|NTN/i.test(String(l.carrierStd || '')) || num((l.data || {}).phyTbsResult) !== null
  const hasNtn = o.hasNtn !== undefined ? !!o.hasNtn : (o.links || []).some(isNtn)
  const hasDvb = o.hasDvb !== undefined ? !!o.hasDvb
    : (o.links || []).some((l) => String(l.carrierStd || 'custom') !== 'custom' && !isNtn(l))

  return {
    v: 1, kind: 'sla', lang, scheme, t, adaptUnits: !!o.adaptUnits, monthly,
    // 体制名按 lang 翻好随模型走（scheme 本身是描述子，label 恒中文——渲染器不该再去翻它）
    schemeText: schemeName(scheme, lang) + (schemeSub(scheme, lang) ? '　·　' + schemeSub(scheme, lang) : ''),
    doc: Object.assign({}, defaultDocInfo(scheme, (o.calc || {}).satelliteName, lang, (o.calc || {}).frequencyBand), o.doc, {
      title: (o.doc && o.doc.title) || slaReportTitle((o.calc || {}).satelliteName, (o.calc || {}).frequencyBand, lang, scheme.orbitType),
      appVersion: o.appVersion || '',
      generatedAt: new Date().toISOString()
    }),
    calc: Object.assign({}, o.calc || {}),
    hasSla,
    slaParams: o.slaParams || [],
    links,
    definitions: o.definitions || slaDefinitions(seen, terms, lang, monthly),
    exclusions: slaExclusions(lang),
    refs: o.refs || slaRefs(lang, { monthly, hasDvb, hasNtn }),
    unitMode: translate(o.adaptUnits ? '自适应' : '锁定', lang)
  }
}
