// Engineering workbook presentation. All readings come from the report snapshot;
// this module lays them out without recalculating or borrowing reference values.
const { FNT, SONG, HEI } = require('./xlsxFont')

const INK = 'FF0000FF', PURPLE = 'FF000080', RULE = 'FF000000'
// Primary visual reference: the supplied 1.xlsm / Link_result sheet. Keep its
// compact label-unit-link matrix, blue 22pt title and underlined section labels;
// external company examples inform content structure, not a replacement theme.
const MATRIX_WIDTHS = { parameter: 32.25, unit: 8.875, link: 9.125 }
const REF_FONT = '宋体', REF_HEADING = '仿宋_GB2312', REF_ROW_HEIGHT = 12.95
const THIN = { style: 'thin', color: { argb: RULE } }
const plain = (v) => v && v.richText ? v.richText.map((r) => r.text).join('') : String(v == null ? '' : v)
const NUMBER = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

// Retain display precision while leaving readings usable for sorting/formulas.
// Fractions, IDs with leading zeroes, unavailable markers and mixed text stay text.
function numericReading(cell, display, raw) {
  const text = display == null ? '' : String(display)
  const explicit = typeof raw === 'number' && Number.isFinite(raw)
  if (explicit || NUMBER.test(text.trim())) {
    const n = explicit ? raw : Number(text)
    if (Number.isFinite(n)) {
      cell.value = n
      const match = /^[-+]?\d+(?:\.(\d+))?([eE][-+]?\d+)?$/.exec(text.trim())
      if (match) {
        const places = Math.min(12, (match[1] || '').length)
        cell.numFmt = '0' + (places ? '.' + '0'.repeat(places) : '') + (match[2] ? 'E+00' : '')
      }
      return cell
    }
  }
  cell.value = text || '—'
  return cell
}

function reportSections(model) {
  if (Array.isArray(model.sections) && model.sections.length > 1) {
    return model.sections.map((s, i) => ({ ...s, links: (model.links || []).filter((l) => l.sec === i) }))
  }
  return [{ title: '', short: '', links: model.links || [] }]
}

// A row identity contains its block, hierarchy, occurrence and unit. Repeated
// hop labels and unlike operating conditions therefore cannot overwrite a row.
function matrixBlocks(links, lang, inputPrefix) {
  const en = lang === 'en'
  const blocks = new Map()
  const block = (key, title) => {
    if (!blocks.has(key)) blocks.set(key, { title, rows: [], byKey: new Map() })
    return blocks.get(key)
  }
  links.forEach((link, li) => {
    const inputSeen = new Map(), segmentSeen = new Map()
    const standards = (link.carrier && link.carrier.stds) || []
    if (standards.length) {
      const out = block('input:carrier:0', (inputPrefix || (en ? 'Inputs · ' : '输入参数 · ')) + (en ? 'Carrier and modulation' : '载波与调制'))
      add(out, '$carrier-standard', en ? 'Standard' : '标准', '', li, standards.join(' / '), null)
    }
    for (const b of link.inputs || []) {
      const base = b.key || b.title || 'input'
      const occ = inputSeen.get(base) || 0; inputSeen.set(base, occ + 1)
      const out = block('input:' + base + ':' + occ, (inputPrefix || (en ? 'Inputs · ' : '输入参数 · ')) + (b.title || ''))
      const seen = new Map()
      for (const row of b.rows || []) {
        const baseKey = JSON.stringify([row.label, row.unit || ''])
        const index = seen.get(baseKey) || 0; seen.set(baseKey, index + 1)
        add(out, baseKey + ':' + index, row.label, row.unit, li, row.value, null)
      }
    }
    for (const seg of link.segments || []) {
      const base = seg.key || JSON.stringify([seg.no || '', seg.title || ''])
      const occ = segmentSeen.get(base) || 0; segmentSeen.set(base, occ + 1)
      const out = block('result:' + base + ':' + occ, (en ? 'Results · ' : '计算结果 · ') + (seg.no ? '§' + seg.no + '  ' : '') + (seg.title || ''))
      const cols = seg.cols || 1
      const heads = Array.isArray(seg.heads) && seg.heads.length === cols ? seg.heads
        : cols >= 3 ? (en ? ['Uplink', 'Downlink', 'Total'] : ['上行', '下行', '合计'])
          : cols === 2 ? (en ? ['Uplink', 'Downlink'] : ['上行', '下行']) : ['']
      let parent = '', child = ''
      const seen = new Map()
      for (const row of seg.rows || []) {
        if (row.kind === 'head') { parent = row.label || ''; child = ''; continue }
        if (row.kind === 'shead') { child = row.label || ''; continue }
        const label = [parent, child, (row.sign ? row.sign + ' ' : '') + (row.label || '')].filter(Boolean).join(' / ')
        const values = [row.up, row.down, row.total], nums = [row.num, row.numDown, row.numTotal]
        heads.forEach((head, vi) => {
          const title = cols > 1 ? label + ' · ' + head : label
          const baseKey = JSON.stringify([parent, child, row.label, row.sign || '', head, row.unit || ''])
          const index = seen.get(baseKey) || 0; seen.set(baseKey, index + 1)
          add(out, baseKey + ':' + index, title, row.unit, li, values[vi], nums[vi], ['base', 'sub', 'chk', 'kpi', 'margin'].includes(row.kind))
        })
      }
    }
  })
  function add(out, key, label, unit, li, display, raw, strong) {
    if (!out.byKey.has(key)) {
      const row = { label, unit: unit || '', values: Array(links.length).fill(null), strong: !!strong }
      out.byKey.set(key, row); out.rows.push(row)
    }
    out.byKey.get(key).values[li] = { display, raw }
  }
  return [...blocks.values()].map(({ title, rows }) => ({ title, rows: rows.filter((row) => row.values.some((v) => v && (
    (v.display != null && String(v.display) !== '') || (typeof v.raw === 'number' && Number.isFinite(v.raw))
  ))) })).filter((b) => b.rows.length)
}

function addEngineeringMatrices(wb, model, options = {}) {
  const en = model.lang === 'en', doc = model.doc || {}, maxLinks = 8
  const sections = reportSections(model)
  const names = new Set(wb.worksheets.map((ws) => ws.name.toLowerCase()))
  let count = 0
  for (const section of sections) {
    for (let start = 0; start < section.links.length; start += maxLinks) {
      const links = section.links.slice(start, start + maxLinks)
      const suffix = sections.length > 1 ? ' ' + (section.short || section.title || ++count) : ''
      const batch = section.links.length > maxLinks ? ' ' + (Math.floor(start / maxLinks) + 1) : ''
      let name = ((options.name || 'Link_result') + suffix + batch).replace(/[\\/?*[\]:']/g, ' ').slice(0, 31)
      const baseName = name
      for (let n = 2; names.has(name.toLowerCase()); n++) name = baseName.slice(0, 27) + '~' + n
      names.add(name.toLowerCase())
      const ws = wb.addWorksheet(name, { views: [{ showGridLines: false, state: 'frozen', ySplit: 6, topLeftCell: 'A7' }] })
      ws.properties.tabColor = { argb: INK }
      ws.columns = [{ width: MATRIX_WIDTHS.parameter }, { width: MATRIX_WIDTHS.unit }, ...Array.from({ length: 8 }, () => ({ width: MATRIX_WIDTHS.link }))]
      const end = 10
      const cell = (r, c, value, opts = {}) => {
        const at = ws.getCell(r, c); at.value = value == null || value === '' ? null : value
        at.font = { name: opts.head ? REF_HEADING : REF_FONT, size: opts.size || 10, bold: !!opts.bold, color: { argb: opts.color || RULE } }
        at.alignment = { horizontal: c > 2 ? 'right' : 'left', vertical: 'middle', wrapText: false }
        return at
      }
      cell(3, 1, options.title || doc.title || (en ? 'Link Budget Results' : '链路预算计算结果'), { head: true, size: 22, bold: true, color: INK }); ws.getRow(3).height = 37.5
      cell(4, 1, [doc.org, doc.docNo, doc.date, section.title].filter(Boolean).join('    '), { head: true, size: 14, bold: true }); ws.getRow(4).height = 28.5
      cell(5, 1, en ? 'Transmitter' : '发射端', { head: true })
      cell(6, 1, en ? 'Receiver' : '接收端', { head: true })
      links.forEach((l, i) => {
        cell(5, i + 3, '#' + l.no + ' ' + (l.txName || '—')); cell(6, i + 3, l.rxName || '—')
        for (const r of [5, 6]) ws.getCell(r, i + 3).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
      })
      for (let c = 3; c <= end; c++) {
        ws.getCell(5, c).border = { left: THIN, ...(c < end ? { right: THIN } : {}) }
        ws.getCell(6, c).border = { left: THIN, ...(c < end ? { right: THIN } : {}), bottom: THIN }
      }
      ws.getRow(5).height = REF_ROW_HEIGHT; ws.getRow(6).height = REF_ROW_HEIGHT
      let r = 7
      ws._engineeringKeep = []
      ws._referenceHeadings = new Set()
      if (links.some((l) => l.error)) {
        cell(r, 1, en ? 'Calculation error' : '计算错误', { head: true, color: 'FFB00020' })
        links.forEach((l, i) => cell(r, i + 3, l.error || '—', { color: l.error ? 'FFB00020' : RULE })); ws.getRow(r++).height = 26
      }
      const opticalOnly = model.scheme?.orbitType === 'REGEN' && (section.regenMode || model.scheme?.regenMode) === 'laser'
      const blocks = matrixBlocks(opticalOnly ? links.map((l) => ({ ...l, carrier: null })) : links, model.lang, options.inputPrefix)
      // Match the reference's progression from satellite configuration to
      // signals, propagation and stations, then the complete budget results.
      const rank = (b) => /卫星与转发器|Satellite.*Transponder/i.test(b.title) && /^(?:输入参数|Inputs)/.test(b.title) ? 0
        : /载波与调制|Carrier.*Modulation/i.test(b.title) && /^(?:输入参数|Inputs)/.test(b.title) ? 1 : /^(?:输入参数|Inputs)/.test(b.title) ? 2 : 3
      blocks.sort((a, b) => rank(a) - rank(b))
      for (const b of blocks) {
        const bandRow = r
        ws._referenceHeadings.add(r)
        const heading = cell(r, 1, b.title.replace(/^(?:输入参数|计算结果|Inputs|Results)\s*[·:]\s*/, ''), { head: true, bold: true, size: 12, color: PURPLE })
        heading.font = { ...heading.font, underline: true }
        // The original repeats units in column B at the opening, not at every
        // group. Later headings can flow naturally over the empty header cells.
        if (bandRow === 7) cell(r, 2, en ? 'Unit' : '单位', { head: true, bold: true, size: 12, color: PURPLE }).font.underline = true
        for (let c = 1; c <= end; c++) ws.getCell(r, c).border = { bottom: THIN }
        ws.getRow(r++).height = 17.25
        for (const row of b.rows) {
          cell(r, 1, row.label); cell(r, 2, row.unit && !/^\(.*\)$/.test(row.unit) ? '(' + row.unit + ')' : row.unit)
          row.values.forEach((v, i) => {
            const at = cell(r, i + 3, '')
            numericReading(at, v && v.display, v && v.raw)
          })
          for (let c = 3; c <= end; c++) ws.getCell(r, c).border = { left: THIN, ...(c < end ? { right: THIN } : {}) }
          ws.getRow(r++).height = REF_ROW_HEIGHT
        }
        for (let c = 1; c <= end; c++) ws.getCell(r - 1, c).border = { ...ws.getCell(r - 1, c).border, bottom: THIN }
        ws._engineeringKeep.push([bandRow, bandRow + Math.min(2, b.rows.length)])
      }
      if (model.hasSla) {
        const slim = require('./reportCompact').buildCompactReport({ ...model, kind: 'sla', links })
        for (const table of slim.tables) r = appendReferenceTable(ws, r, table, end)
      }
      if (section === sections[0] && start === 0 && (model.capacity || []).length) {
        for (const table of model.capacity) {
          // Capacity entries keep section indexes; optical or excluded links have no table.
          if (!table) continue
          r = appendReferenceTable(ws, r, { title: model.t?.capacity || (en ? 'Capacity' : '容量汇总'), head: table.head, rows: table.rows }, end)
        }
      }
      if (r > 10) ws._engineeringKeep.push([Math.max(7, r - 3), r - 1])
      ws._engineeringMatrix = true
      ws._referenceFrame = true
      ws._referenceLast = end
    }
  }
}

// Excel ignores manual row breaks while "fit to pages" is enabled. On sheets
// needing keep-together groups, use an equivalent width-derived print scale and
// paginate the actual row heights. This changes printing only, never cell data.
function paginateEngineeringSheet(ws, options = {}) {
  const setup = ws.pageSetup
  const landscapeA3 = setup.paperSize === 8
  const widthPt = landscapeA3 ? 1190.55 : 841.89
  const heightPt = landscapeA3 ? 841.89 : 595.28
  const margins = setup.margins
  const availableWidth = widthPt - 72 * (margins.left + margins.right)
  const columnCount = Math.max(1, ws.actualColumnCount || ws.columnCount || 1)
  let contentWidth = 0
  for (let col = 1; col <= columnCount; col++) contentWidth += ((ws.getColumn(col).width || 8.43) * 7 + 5) * 0.75
  const scale = Math.max(10, Math.min(options.maxScale || 100, Math.floor(availableWidth / Math.max(1, contentWidth) * 100)))
  setup.fitToPage = false
  setup.scale = scale
  const capacity = (heightPt - 72 * (margins.top + margins.bottom) - 16) / (scale / 100)
  const headerEnd = setup.printTitlesRow ? Number(String(setup.printTitlesRow).split(':').pop()) || 0 : 0
  const height = (r) => ws.getRow(r).height || ws.properties.defaultRowHeight || 15
  const sum = (start, end) => { let total = 0; for (let row = start; row <= end; row++) total += height(row); return total }
  const headerHeight = sum(1, headerEnd)
  const keep = (ws._engineeringKeep || []).filter(([start, end]) => start > headerEnd && end >= start)
    .map((range) => [...range]).sort((a, b) => a[0] - b[0])
  const merged = []
  for (const range of keep) {
    const previous = merged[merged.length - 1]
    if (previous && previous[1] >= range[0]) previous[1] = Math.max(previous[1], range[1])
    else merged.push(range)
  }
  const byStart = new Map(merged.map(([start, end]) => [start, end]))
  let used = headerHeight
  for (let row = headerEnd + 1; row <= ws.rowCount;) {
    let end = byStart.get(row) || row
    // Very long custom tables can exceed one page. Keep their first rows and
    // allow the remainder to flow rather than forcing an impossible page.
    if (sum(row, end) > capacity - headerHeight) end = Math.min(end, row + 2)
    const groupHeight = sum(row, end)
    if (used + groupHeight > capacity && used > headerHeight) {
      ws.getRow(row - 1).addPageBreak()
      used = headerHeight
    }
    used += groupHeight
    row = end + 1
  }
}

function addSlaEngineeringMatrices(wb, model) {
  const en = model.lang === 'en'
  const links = (model.links || []).map((link) => {
    const blocks = new Map()
    for (const row of (link.sla && link.sla.rows) || []) {
      const group = row.group || row.groupLabel || 'SLA'
      if (!blocks.has(group)) blocks.set(group, { key: group, title: row.groupLabel || group, rows: [] })
      const label = row.label + (row.sub ? ' ' + row.sub : '')
      const rows = blocks.get(group).rows
      rows.push({ label: label + (en ? ' · Calculation basis' : ' · 计算依据'), unit: row.unit, value: row.basis })
      rows.push({ label: label + (en ? ' · Suggested' : ' · 建议值'), unit: row.unit, value: row.suggest })
      rows.push({ label: label + (en ? ' · Adopted' : ' · 采用值'), unit: row.unit, value: row.adopt })
    }
    return { ...link, inputs: [...blocks.values()], segments: [] }
  })
  // Formula/basis cells can be several lines high even in a short SLA group.
  // Keep its heading with the first readings, allowing the rest to flow.
  addEngineeringMatrices(wb, { ...model, links }, { name: 'SLA_result', title: en ? 'SLA Engineering Results' : 'SLA 工程指标结果', inputPrefix: 'SLA · ', keepCompact: false })
}

// Three-line engineering tables already carry their structural rules. Preserve
// their captions/first readings, and keep compact tables on one printed page.
// This also covers older detail writers without changing their data or cells.
function engineeringPrintGroups(ws, headerEnd) {
  const groups = []
  const populated = (row) => ws.getRow(row).values.some((v) => plain(v).trim())
  for (let row = headerEnd + 1; row <= ws.rowCount; row++) {
    const cell = ws.getCell(row, 1), border = cell.border || {}
    if (cell.isMerged && cell.font?.underline && cell.font?.size >= 12 && plain(cell.value).trim()) {
      let end = row, following = 0
      while (end < ws.rowCount && following < 2) { end++; if (populated(end)) following++ }
      groups.push([row, end])
    }
    if (border.top?.style !== 'medium' || border.bottom?.style !== 'thin') continue
    let end = row
    while (end < ws.rowCount && ws.getCell(end, 1).border?.bottom?.style !== 'medium') {
      if (end > row && ws.getCell(end, 1).border?.top?.style === 'medium') { end--; break }
      end++
    }
    let start = row
    // At most three merged preceding rows: section, caption and optional note.
    for (let n = 0; n < 3 && start > headerEnd + 1; n++) {
      const previous = ws.getCell(start - 1, 1)
      if (!previous.isMerged || !plain(previous.value).trim()) break
      start--
    }
    groups.push([start, end - row <= 10 ? end : Math.min(end, row + 2)])
    if (end - row > 10) groups.push([Math.max(row + 1, end - 2), end])
  }
  return groups
}

// The reference has no banner fills or enlarged body rows. Only a cell whose
// actual text cannot fit its column receives wrapping and the needed height.
function fitReferenceRows(ws) {
  ws.eachRow((row) => {
    if (row.number < 5) return
    if (ws._referenceHeadings?.has(row.number)) {
      row.eachCell((cell) => { cell.alignment = { ...cell.alignment, wrapText: false } })
      return
    }
    let lines = 1
    let neededHeight = row.height || REF_ROW_HEIGHT
    row.eachCell((cell) => {
      if (cell.type === 1 || cell.value == null) return
      if (typeof cell.value === 'number') {
        // Decimal precision is retained even when a long value needs a modest
        // per-cell size adjustment inside the fixed 9.125-wide link column.
        cell.alignment = { ...cell.alignment, shrinkToFit: true, wrapText: false }
        return
      }
      const value = plain(cell.value)
      const width = cell.isMerged ? ws._referenceLast * 12 : ws.getColumn(cell.col).width || 9.125
      const size = cell.font?.size || 10
      const capacity = Math.max(4, (width * 7 - 3) / (size * 0.66))
      let count = Math.max(...value.split('\n').map((part) => Math.ceil([...part].reduce((n, c) => n + (/[\u2e80-\uffff]/.test(c) ? 2 : 1), 0) / capacity)))
      if (value.includes('\n')) count = value.split('\n').reduce((total, part) => total + Math.max(1, Math.ceil([...part].reduce((n, c) => n + (/[\u2e80-\uffff]/.test(c) ? 2 : 1), 0) / capacity)), 0)
      if (count > 1 || value.includes('\n')) {
        cell.alignment = { ...cell.alignment, wrapText: true }
        // Bold route/table heads use the native Excel line box, which is a
        // little taller/wider than a plain numeric reading in the source grid.
        if (ws._referenceTableHeads?.has(row.number)) count++
        lines = Math.max(lines, count)
        neededHeight = Math.max(neededHeight, count * Math.max(REF_ROW_HEIGHT, size * 1.3))
      }
    })
    row.height = Math.max(neededHeight, lines * REF_ROW_HEIGHT)
  })
}

function fitReferenceOpening(ws, last) {
  const widthPx = Array.from({ length: last }, (_, i) => (ws.getColumn(i + 1).width || 9.125) * 7 + 5).reduce((a, b) => a + b, 0)
  for (const r of [3, 4]) {
    const cell = ws.getCell(r, 1), value = plain(cell.value), size = cell.font?.size || 10
    if (!value) continue
    const units = [...value].reduce((n, c) => n + (/[\u2e80-\uffff]/.test(c) ? 2 : 1), 0)
    // Full-width title/meta wrapping is an exception for long project names;
    // normal rows and the reference's default A:J widths remain untouched.
    const count = Math.max(1, Math.ceil(units / Math.max(1, (widthPx - 12) / (size * .72))))
    if (count > 1) {
      if (!cell.isMerged) ws.mergeCells(r, 1, r, last)
      cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true }
      ws.getRow(r).height = Math.max(ws.getRow(r).height || 0, count * size * 1.3 + 4)
    }
  }
}

function appendReferenceTable(ws, start, table, last) {
  if (!table.head?.length || !table.rows?.length) return start
  const put = (r, c, value, head = false) => {
    const cell = ws.getCell(r, c)
    if (value === null || value === undefined || value === '') cell.value = null
    else numericReading(cell, value)
    cell.font = { name: head ? REF_HEADING : REF_FONT, size: head ? 12 : 10, bold: !!head, color: { argb: head ? PURPLE : RULE }, ...(head ? { underline: true } : {}) }
    cell.alignment = { horizontal: c === 1 || table.align?.[c - 1] === 'left' ? 'left' : 'right', vertical: 'middle', wrapText: false }
    return cell
  }
  let r = start
  ws._referenceHeadings ||= new Set(); ws._referenceTableHeads ||= new Set()
  ws._referenceHeadings.add(r)
  put(r, 1, table.title || '', true); ws.getRow(r++).height = 17.25
  const header = r
  ws._referenceTableHeads.add(r)
  table.head.forEach((label, i) => {
    const cell = put(r, i + 1, label)
    cell.font = { name: REF_FONT, size: 10, bold: true, color: { argb: RULE } }
    cell.alignment = { ...cell.alignment, horizontal: 'center', wrapText: true }
    cell.border = { top: THIN, bottom: THIN, ...(i ? { left: THIN } : {}) }
  })
  ws.getRow(r++).height = REF_ROW_HEIGHT
  table.rows.forEach((values, ri) => {
    const group = !!table.groupRows?.[ri]
    if (group) {
      const next = table.groupRows.findIndex((flag, index) => index > ri && flag)
      const count = (next < 0 ? table.rows.length : next) - ri
      ws._engineeringKeep = [...(ws._engineeringKeep || []), [r, r + (count <= 10 ? count - 1 : 2)]]
    }
    values.forEach((value, ci) => {
      const cell = put(r, ci + 1, value)
      if (group) cell.font = { name: REF_HEADING, size: 10, bold: true, underline: true, color: { argb: RULE } }
      cell.border = ci ? { left: THIN, ...(ci < table.head.length - 1 ? { right: THIN } : {}) } : {}
    })
    ws.getRow(r++).height = REF_ROW_HEIGHT
  })
  for (let c = 1; c <= Math.min(last, table.head.length); c++) ws.getCell(r - 1, c).border = { ...ws.getCell(r - 1, c).border, bottom: THIN }
  ws._engineeringKeep = [...(ws._engineeringKeep || []), [start, table.rows.length <= 10 ? r - 1 : Math.min(r - 1, header + 2)]]
  return r
}

function addCompactReferenceSheet(wb, model) {
  const compact = require('./reportCompact').buildCompactReport(model)
  const en = model.lang === 'en', sla = model.kind === 'sla'
  const ncol = sla ? 10 : Math.max(3, ...compact.tables.map((table) => table.head.length))
  const ws = wb.addWorksheet(sla ? 'SLA_result' : 'Capacity_result', { views: [{ showGridLines: false }] })
  ws.columns = sla ? [{ width: MATRIX_WIDTHS.parameter }, { width: MATRIX_WIDTHS.unit }, ...Array.from({ length: 8 }, () => ({ width: MATRIX_WIDTHS.link }))]
    : [{ width: MATRIX_WIDTHS.parameter }, ...Array.from({ length: ncol - 1 }, () => ({ width: 20 }))]
  ws._referenceFrame = true; ws._referenceLast = ncol; ws._compactReport = true
  ws.getCell(3, 1).value = compact.title
  ws.getCell(3, 1).font = { name: REF_HEADING, size: 22, bold: true, color: { argb: INK } }
  ws.getCell(3, 1).alignment = { horizontal: 'left', vertical: 'middle' }
  ws.getRow(3).height = 37.5
  // A single context line replaces covers, duplicated scope tables and notes.
  ws.getCell(4, 1).value = compact.meta.map((m) => m.label + ': ' + m.value).join('    ')
  ws.getCell(4, 1).font = { name: REF_HEADING, size: 10, color: { argb: RULE } }
  ws.getRow(4).height = 20
  if (!sla) {
    // The title and identifiers can span unused header cells; only a genuinely
    // long heading is merged so it remains inside the compact print area.
    ws.mergeCells(3, 1, 3, ncol); ws.mergeCells(4, 1, 4, ncol)
    ws.getCell(3, 1).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true }
    ws.getCell(4, 1).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true }
    const titleUnits = [...String(compact.title)].reduce((n, c) => n + (/[\u2e80-\uffff]/.test(c) ? 2 : 1), 0)
    if (titleUnits > 56) ws.getRow(3).height = 52
    if (String(ws.getCell(4, 1).value).length > 120) ws.getRow(4).height = 28
  }
  let r = 5
  for (const table of compact.tables) r = appendReferenceTable(ws, r, table, ncol)
  for (const note of compact.notes || []) {
    ws.mergeCells(r, 1, r, ncol); ws.getCell(r, 1).value = note
    ws.getCell(r, 1).font = { name: REF_FONT, size: 10, color: { argb: RULE } }
    ws.getCell(r, 1).alignment = { vertical: 'middle', wrapText: true }; ws.getRow(r++).height = REF_ROW_HEIGHT
  }
  return ws
}

// Apply the measured Link_result defaults, without the older global autofit
// which raised every body row from 12.95pt to 18–30pt and changed the fonts.
function finishEngineeringWorkbook(wb, model) {
  const en = model.lang === 'en'
  wb.worksheets.forEach((ws) => {
    const last = ws._referenceLast || Math.max(1, ws.actualColumnCount || ws.columnCount || 1)
    ws.properties.defaultRowHeight = REF_ROW_HEIGHT
    ws.getRow(1).height = REF_ROW_HEIGHT; ws.getRow(2).height = REF_ROW_HEIGHT
    fitReferenceOpening(ws, last)
    fitReferenceRows(ws)
    ws.eachRow((row) => row.eachCell((cell) => { if (cell.type !== 1) cell.fill = { type: 'pattern', pattern: 'none' } }))
    const logo = require('./reportLogoImage').fitLogo((model.doc || {}).logo, 140, 46)
    if (logo) {
      ws.getRow(1).height = Math.max(REF_ROW_HEIGHT, logo.height * .75 + 4)
      ws.getRow(2).height = 4
    }
    ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      printArea: 'A1:' + ws.getColumn(last).letter + ws.rowCount,
      margins: { left: .748031496062992, right: .748031496062992, top: .669291338582677, bottom: .708661417322835, header: .511811023622047, footer: .511811023622047 } }
    // A brief normally fits one page, and uses a second only when required.
    // Full engineering matrices flow continuously instead of keeping every
    // short section as a page-sized block.
    ws.headerFooter = { oddFooter: '&R&P / &N' }
    let maxScale = 100
    if (ws._compactReport) {
      const totalHeight = Array.from({ length: ws.rowCount }, (_, i) => ws.getRow(i + 1).height || REF_ROW_HEIGHT).reduce((a, b) => a + b, 0)
      const usableHeight = 595.28 - 72 * (.669291338582677 + .708661417322835) - 16
      // A few wrapped English header words must not create a two-row second
      // page. A modest print-only fit preserves source fonts/columns/rows.
      if (totalHeight <= usableHeight / .9) maxScale = Math.min(100, Math.floor(usableHeight / Math.max(1, totalHeight) * 100))
    }
    paginateEngineeringSheet(ws, { maxScale })
    ws.properties.tabColor = ws.properties.tabColor || { argb: INK }
  })
  try {
    const theme = require('exceljs/lib/xlsx/xml/theme1.js')
    wb._themes = { theme1: String(theme).replace(/<a:latin typeface="(?:Calibri|Cambria)"\/>/g, '<a:latin typeface="宋体"/>').replace(/<a:ea typeface=""\/>/g, '<a:ea typeface="宋体"/>') }
  } catch (_) { /* Explicit reference fonts are already stored on every cell. */ }
}

module.exports = { numericReading, matrixBlocks, addEngineeringMatrices, addSlaEngineeringMatrices, addCompactReferenceSheet, finishEngineeringWorkbook, paginateEngineeringSheet, engineeringPrintGroups }
