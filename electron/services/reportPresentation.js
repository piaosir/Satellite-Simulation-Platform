// Presentation copy is derived from the exported calculation snapshot. It never
// solves a budget, makes a compliance judgment, or imports example-report data.
const present = (v) => v !== null && v !== undefined && String(v).trim() !== ''
const numeric = (v) => present(v) && Number.isFinite(Number(v)) ? Number(v) : null
const text = (v) => present(v) ? String(v) : '—'
const unique = (xs) => [...new Set(xs.filter(present).map(String))]

// The overview is a selection of the same exported SLA clauses as the detail
// tables. row.value is the software-resolved effective value; older snapshots
// may only carry adopt/suggest. Never resolve a real zero through truthiness.
// Structure reference: Hughes Texas DIR, Services Offered and Management Plan,
// metric / inputs and calculations / measurement window / service requirement.
// The provider's contractual numbers and branding are never copied.
function slaMetricTable(model) {
  const en = model.lang === 'en', labels = model.t || {}
  const definitions = new Map((model.definitions || []).map((r) => [r.key, r]))
  const rows = []
  for (const link of model.links || []) {
    const clauses = (link.sla && link.sla.rows) || []
    const picked = ['sysAvail', 'cir', 'owd'].map((key) => clauses.find((r) => r.key === key)).filter(Boolean)
    for (const clause of (picked.length ? picked : clauses.slice(0, 3))) {
      const definition = definitions.get(String(clause.key).split(':')[0]) || {}
      const applied = present(clause.value) ? clause.value : present(clause.adopt) ? clause.adopt : clause.suggest
      rows.push([
        '#' + text(link.no) + ' · ' + text(clause.label), text(clause.basis), text(definition.period),
        text(clause.suggest), text(applied), text(clause.unit)
      ])
    }
  }
  return {
    title: en ? 'Key metric summary' : '关键指标摘要',
    head: [labels.slaTerm || (en ? 'Metric' : '指标'), labels.slaBasis || (en ? 'Calculation basis' : '计算依据'),
      labels.period || (en ? 'Assessment period' : '考核周期'), en ? 'Suggested' : labels.slaSuggest || '建议值',
      en ? 'Applied value' : '采用值', labels.unit || (en ? 'Unit' : '单位')],
    rows
  }
}

function buildReportPresentation(model) {
  const en = model.lang === 'en'
  const L = (zh, eng) => en ? eng : zh
  const kind = model.kind || 'full'
  const links = model.links || []
  const calc = model.calc || {}
  const doc = model.doc || {}
  const scheme = model.scheme || {}
  const schemeText = model.schemeText || (en ? scheme.labelEn : scheme.label) || ''
  const good = links.filter((l) => l && !l.error && (kind === 'sla' ? l.ok : l.data))
  const failed = links.filter((l) => l && (l.error || !(kind === 'sla' ? l.ok : l.data)))
  const title = kind === 'sla' ? L('服务等级概览', 'Service level overview')
    : kind === 'cap' ? L('容量规划概览', 'Capacity planning overview')
      : L('方案概述', 'Solution overview')
  const facts = [
    { label: L('通信体制', 'Architecture'), value: schemeText },
    { label: L('卫星', 'Satellite'), value: calc.satelliteName },
    { label: L('频段', 'Frequency band'), value: calc.frequencyBand },
    { label: L('计算方式', 'Calculation mode'), value: calc.mode }
  ].filter((r) => present(r.value))
  const cards = []
  const sections = []
  let intro
  let scopeNote
  let routes = []
  let metricTable = null
  if (kind === 'cap') {
    const scope = model.scope || []
    const scopeAt = (...labels) => (scope.find((r) => labels.includes(r[0])) || [])[1]
    const groups = (model.sections || []).reduce((n, s) => n + (s.detail || []).length, 0)
    cards.push(
      { label: L('资源组', 'Resource groups'), value: text(groups) },
      { label: L('列入链路', 'Links included'), value: text(scopeAt('列入链路', 'Links included')) },
      { label: L('载波数', 'Carriers'), value: text(scopeAt('载波数', 'Carriers')) },
      { label: L('汇总模块', 'Modules reported'), value: String((model.sections || []).length) }
    )
    intro = L('本方案按软件中列入容量汇总的链路及载波数量，逐资源组展示业务容量、带宽与资源占用。资源矩阵给出总览，逐组明细保留每条链路的贡献及小计。',
      'This plan presents service capacity, bandwidth and resource usage by resource group, using the links and carrier counts included in the software. Resource matrices provide the overview; group details retain individual link contributions and subtotals.')
    sections.push({ title: L('资源配置与费用口径', 'Resource allocation and costing'), text: L('按软件中各转发器或卫星资源组的口径分别列账。带宽、功率带宽、结算带宽和费用仅在对应明细及计算口径存在时列出；各组的分配带宽与资源占用以资源矩阵为准。',
      'Resources are accounted for separately for each transponder or satellite group. Bandwidth, power bandwidth, billable bandwidth and costs are reported where present in the detailed model and definitions. The resource matrices retain each group’s allocated bandwidth and resource usage.') })
    sections.push({ title: L('容量规划与实施', 'Capacity planning and implementation'), text: L('配置资源时使用逐组明细中的载波数、单链路读数与小计核对采购带宽。业务规模调整后，应在软件中更新列入范围及载波数量，重新计算并生成本报告。',
      'Use carrier counts, individual link values and group subtotals to reconcile bandwidth procurement. After changing service scale, update included links and carrier counts in the software, recalculate and regenerate this report.') })
    scopeNote = L('未列入及计算失败链路在汇总范围中单列；本报告不将缺失结果作为零占用。', 'Excluded and failed links are identified in the reporting scope. Missing results are not treated as zero usage.')
  } else if (kind === 'sla') {
    metricTable = slaMetricTable(model)
    const clauses = links.flatMap((l) => (l.sla && l.sla.rows) || [])
    const terms = unique(clauses.map((r) => r.key))
    const covered = links.filter((l) => l.sla && l.sla.rows && l.sla.rows.length)
    cards.push(
      { label: L('链路数', 'Links'), value: String(links.length) },
      { label: L('含服务条款', 'Links with terms'), value: String(covered.length) },
      { label: L('指标项', 'Metric terms'), value: String(terms.length) },
      { label: L('考核周期', 'Assessment period'), value: model.monthly ? L('最坏月', 'Worst month') : L('年平均', 'Annual average') }
    )
    intro = L('本方案把链路预算及所选服务参数整理为可评审的服务等级指标。总表用于比较各链路采用值，逐链路明细保留计算依据、建议值与采用值，便于双方核对服务范围。',
      'This plan organizes the link budget and selected service parameters into service level metrics for review. The matrix compares adopted values, while link details retain calculation bases, suggested values and adopted values for agreement on service scope.')
    sections.push({ title: L('服务边界与考核口径', 'Service scope and assessment basis'), text: L('服务范围、考核周期、指标定义与免责事件按本报告对应章节列示。传播、设备及空间段的可用度按软件中实际计入的构成分别保留，不将传播可用度替代为整体服务承诺。',
      'Service scope, assessment periods, metric definitions and exclusions are set out in the corresponding sections. Propagation, equipment and space segment availability retain the components included in the software; propagation availability is not substituted for an overall service commitment.') })
    sections.push({ title: L('服务约定与交付', 'Service agreement and delivery'), text: L('采用值为空时沿用软件建议值。签署服务约定前应逐链路核对采用值、故障响应与恢复参数，以及已列出的可用度档位和日凌窗口；未经扫描或计算的结果不补写。',
      'An empty adopted value uses the software’s suggested value. Before agreeing service terms, review adopted values, fault response and restoration parameters, and any reported availability tiers and sun outage windows for each link. Uncomputed scans and results are not supplied.') })
    scopeNote = L('指标为当前配置与假设下的计算值和采用值，实际服务承诺以双方确认的条款为准。', 'Metrics reflect the current configuration, assumptions and adopted values. Service commitments are subject to the terms agreed by the parties.')
  } else {
    const marginKey = scheme.orbitType === 'E2E' ? 'e2eMarginResult' : 'linkmargin'
    const margins = good.map((l) => ({ no: l.no, value: numeric(l.data[marginKey]) })).filter((r) => r.value !== null)
    const minimum = margins.length ? margins.reduce((a, b) => a.value <= b.value ? a : b) : null
    cards.push(
      { label: L('链路数', 'Links'), value: String(links.length) },
      { label: L('有计算结果', 'Calculated links'), value: String(good.length) },
      { label: L('计算失败或无结果', 'Failed or unavailable'), value: String(failed.length) },
      { label: L('最低链路余量', 'Minimum link margin'), value: minimum ? minimum.value.toFixed(2) : '—', unit: 'dB' }
    )
    intro = L(`本方案围绕当前配置的 ${links.length} 条通信链路，汇总技术配置、链路预算与资源安排。其中 ${good.length} 条链路有计算结果，${failed.length} 条计算失败或无结果。总览用于方案评审，后续技术结果与逐链路预算用于工程核对。`,
      `This solution covers ${links.length} communication links in the current configuration, including technical configuration, link budgets and resource allocation. Results are available for ${good.length} links; ${failed.length} links failed or have no result. The overview supports solution review, followed by technical results and individual budgets for engineering verification.`)
    const standards = unique(good.flatMap((l) => l.carrier && l.carrier.stds || []))
    const moduleNames = unique((model.sections || []).map((s) => s.title))
    const architecture = [schemeText, ...moduleNames].filter(present).join(' · ')
    sections.push({ title: L('通信架构与配置', 'Communications architecture and configuration'), text: L(`通信体制为 ${architecture || '—'}。${standards.length ? `载波标准包括 ${standards.join('、')}。` : ''}各链路的收发端、载波与余量见配置清单；天线、功放、卫星、传播及干扰参数在逐链路输入与预算中保留。`,
      `The architecture is ${architecture || '—'}. ${standards.length ? `Carrier standards include ${standards.join(', ')}. ` : ''}The configuration schedule identifies endpoints, carriers and margins. Antenna, amplifier, satellite, propagation and interference parameters are retained in individual inputs and budgets.`) })
    sections.push({ title: L('预算结果与资源安排', 'Budget results and resource allocation'), text: minimum
      ? L(`当前有数值余量的链路中，最低值为 #${minimum.no} 的 ${minimum.value.toFixed(2)} dB。逐参数对照保留各链路读数；容量与统计按软件已有的转发器或模块口径列示，带宽与功率资源需结合对应资源组核对。`,
        `Among links with a numeric margin, the minimum is ${minimum.value.toFixed(2)} dB on #${minimum.no}. The parameter comparison retains individual readings. Capacity and statistics follow the software’s transponder or module basis; bandwidth and power resources should be reviewed within their corresponding groups.`)
      : L('本次配置没有可用于总览的数值链路余量。逐参数对照、错误记录及逐链路明细保留实际结果，容量与资源按软件已有口径列示。',
        'No numeric link margin is available for this overview. The comparison, error records and individual budgets retain the actual results; capacity and resources follow the software’s existing accounting basis.') })
    sections.push({ title: L('工程实施与核验建议', 'Engineering implementation and verification'), text: L('建议以逐链路输入清单落实天线口径、发射功率、收发频率及调制编码，再按相同传播工况核对预算。设备或站址变更后应重新计算；存在失败或无结果的链路时，应先处理对应错误，再将完整结果用于工程交付。',
      'Use the individual input schedules to specify antenna aperture, transmit power, frequencies and MODCOD, then verify budgets under the same propagation conditions. Recalculate after equipment or site changes. Resolve failed or unavailable calculations before using the complete results for engineering delivery.') })
    routes = links.map((l) => ({
      no: '#' + l.no, route: [l.txName, l.rxName].map(text).join(' → '),
      carrier: unique((l.carrier && l.carrier.stds) || []).join(' / ') || '—',
      margin: !l.error && l.data && numeric(l.data[marginKey]) !== null ? Number(l.data[marginKey]).toFixed(2) : '—',
      error: l.error || (!l.data ? L('无计算结果', 'No calculation result') : '')
    }))
    scopeNote = L('报告对应本次导出的软件计算快照。余量仅为数值读数；未填写的业务要求、验收门限及采购承诺不作推定。',
      'This report represents the calculation snapshot exported from the software. Margins are numeric readings. Unspecified service requirements, acceptance limits and procurement commitments are not assumed.')
  }
  return {
    eyebrow: kind === 'sla' ? L('服务等级方案', 'SERVICE LEVEL PLAN') : kind === 'cap' ? L('容量规划', 'CAPACITY PLAN') : L('卫星通信解决方案', 'SATELLITE COMMUNICATIONS SOLUTION'),
    title, intro, cards, facts, sections, scopeNote, routes, metricTable,
    routeHead: [L('链路', 'Link'), L('通信路径', 'Communications path'), L('载波标准', 'Carrier standard'), L('余量 dB', 'Margin dB')],
    routeTitle: L('方案配置清单', 'Solution configuration schedule'),
    provenance: [doc.appVersion ? `${L('软件版本', 'Software version')} ${doc.appVersion}` : '', doc.generatedAt ? `${L('生成时间 UTC', 'Generated UTC')} ${String(doc.generatedAt).replace('T', ' ').replace('Z', '')}` : ''].filter(Boolean).join(' · ')
  }
}

module.exports = { buildReportPresentation }
