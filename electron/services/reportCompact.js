// Customer-facing SLA and capacity briefs. This is a projection of the report
// snapshot, not a second calculation or a source of service promises.
const has = (v) => v !== null && v !== undefined && String(v).trim() !== ''
const S = (v) => has(v) ? String(v) : '—'
const list = (v) => Array.isArray(v) ? v : []

function effectiveSlaValue(row) {
  // value is already resolved by slaReportBlock. Old saved snapshots may only
  // contain adopt/suggest; a real zero is an explicit value in every format.
  return S(has(row.value) ? row.value : has(row.adopt) ? row.adopt : row.suggest)
}

function slaTables(model) {
  const en = model.lang === 'en', links = list(model.links), tables = []
  const records = [], byKey = new Map()
  links.forEach((link, li) => {
    const occurrences = new Map()
    for (const row of list(link.sla && link.sla.rows)) {
      const base = JSON.stringify([row.key || row.label || '', row.unit || ''])
      const occurrence = occurrences.get(base) || 0
      occurrences.set(base, occurrence + 1)
      const key = base + ':' + occurrence
      let record = byKey.get(key)
      if (!record) {
        record = { label: S(row.label), sub: row.sub || '', unit: row.unit || '', group: row.groupLabel || '', values: Array(links.length).fill('—') }
        byKey.set(key, record); records.push(record)
      } else if (record.sub !== (row.sub || '')) record.sub = ''
      record.values[li] = effectiveSlaValue(row)
    }
  })
  const batchSize = 6
  for (let from = 0; from < links.length; from += batchSize) {
    const batch = links.slice(from, from + batchSize), rows = [], groupRows = []
    let group = ''
    for (const r of records) {
      if (r.group && r.group !== group) {
        group = r.group; rows.push([group, '', ...batch.map(() => '')]); groupRows.push(true)
      }
      rows.push([r.label + (r.sub ? ' · ' + r.sub : ''), r.unit, ...r.values.slice(from, from + batch.length)])
      groupRows.push(false)
    }
    if (!rows.length) continue
    tables.push({
      title: en ? 'SLA commitments' : 'SLA 承诺指标',
      head: [en ? 'Metric' : '指标', en ? 'Unit' : '单位', ...batch.map((l) => '#' + S(l.no) + ' ' + [l.txName, l.rxName].map(S).join(' → '))],
      rows, groupRows,
      widths: [34, 14, ...batch.map(() => 52 / batch.length)],
      align: ['left', 'left', ...batch.map(() => 'right')]
    })
  }
  return tables
}

function capacityTables(model) {
  const en = model.lang === 'en', tables = [], assignmentRows = []
  const sections = list(model.sections)
  for (const section of sections) {
    const matrix = section.matrix || {}, head = list(matrix.head)
    // A matrix can have many resource columns; continuation blocks repeat the
    // parameter column without changing the original group/total ordering.
    for (let from = 1; from < head.length; from += 6) {
      const headers = [head[0], ...head.slice(from, from + 6)]
      tables.push({
        title: [en ? 'Resource summary' : '资源汇总', model.multi ? section.title : ''].filter(has).join(' · '),
        head: headers, rows: list(matrix.rows).map((row) => [row[0], ...row.slice(from, from + 6)]),
        widths: [34, ...headers.slice(1).map(() => 66 / (headers.length - 1))],
        align: ['left', ...headers.slice(1).map(() => 'right')], groupRows: []
      })
    }
    // The resource matrix already contains the numeric totals. The compact
    // detail is only the link-to-resource allocation, without duplicate totals,
    // per-link formulas or another set of identical one-link group readings.
    for (const group of list(section.detail)) {
      list(group.rows).forEach((row, i) => {
        if (list(group.keyRows)[i] || (!has(row[0]) && /^(?:小计|Subtotal)$/i.test(String(row[1] || '')))) return
        assignmentRows.push([
          [row[0], row[1]].filter(has).join(' '),
          [model.multi ? section.title : '', group.name].filter(has).join(' · '),
          S(row[3])
        ])
      })
    }
  }
  if (assignmentRows.length) tables.push({
    title: en ? 'Link resource allocation' : '链路资源分配',
    head: [en ? 'Link' : '链路', en ? 'Resource group' : '资源组', en ? 'Carriers' : '载波数'],
    rows: assignmentRows, widths: [48, 36, 16], align: ['left', 'left', 'right'], groupRows: []
  })
  return tables
}

function buildCompactReport(model = {}) {
  const en = model.lang === 'en', sla = model.kind === 'sla', doc = model.doc || {}, calc = model.calc || {}
  const L = (zh, eng) => en ? eng : zh
  const t = model.t || {}, meta = [], notes = []
  const add = (label, value) => { if (has(value)) meta.push({ label, value: String(value) }) }
  add(t.docNo || L('编号', 'Document No.'), doc.docNo)
  add(t.org || L('单位', 'Organisation'), doc.org)
  add(t.date || L('日期', 'Date'), doc.date)
  add(t.satellite || L('卫星', 'Satellite'), calc.satelliteName)
  add(t.band || L('频段', 'Band'), calc.frequencyBand)
  if (sla) {
    add(t.period || L('考核周期', 'Assessment period'), model.monthly ? (t.periodMonth || L('最坏月', 'Worst month')) : (t.periodYear || L('年平均', 'Annual mean')))
    const missing = list(model.links).filter((l) => !list(l.sla && l.sla.rows).length).map((l) => '#' + S(l.no))
    if (missing.length) notes.push(L('未提供承诺指标的链路：', 'Links without SLA commitments: ') + missing.join(', '))
  } else {
    for (const row of list(model.scope)) {
      if (['列入链路', 'Links included'].includes(row[0])) add(row[0], row[1])
      if (['未列入链路', 'Links not included', '计算失败链路', 'Links failed'].includes(row[0]) && has(row[1])) notes.push(row[0] + ': ' + row[1])
    }
  }
  const tables = sla ? slaTables(model) : capacityTables(model)
  return {
    title: doc.title || (sla ? L('服务等级承诺指标', 'SLA commitments') : L('容量汇总', 'Capacity summary')),
    meta, tables, notes,
    landscape: tables.some((table) => table.head.length > 6)
  }
}

module.exports = { buildCompactReport, effectiveSlaValue }
