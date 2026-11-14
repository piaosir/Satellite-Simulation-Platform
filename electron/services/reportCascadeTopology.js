// Actual end-to-end cascades, rendered from the same topology snapshot as the
// report schedule. No orbit, budget result or missing connection is inferred.
const { fontsOf } = require('./reportStyle')
const xml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
const WIDTH = 1560, BOX = 360, GAP = 180, PAD = 60, ROW_GAP = 126
const units = (c) => /[^\u0000-\u00ff]/.test(c) ? 2 : /[MW@%]/.test(c) ? 1.8 : /[ilI1.,'` ]/.test(c) ? 0.55 : 1.2
function wrap(text, max = 19) {
  const lines = []; let line = '', size = 0
  for (const c of String(text || '—')) {
    if (c === '\n' || (size + units(c) > max && line)) {
      lines.push(line); line = ''; size = 0
      if (c === '\n') continue
    }
    line += c; size += units(c)
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['—']
}
function nodeLabel(kind, index, count, en) {
  if (kind === 'ground' || kind === 'es') return index > 0 && index < count - 1
    ? (en ? 'Ground relay' : '地面转接站') : (en ? 'Earth station' : '地球站')
  if (kind === 'transparent' || kind === 'txp') return en ? 'Transparent satellite' : '透明卫星'
  if (kind === 'regen') return en ? 'Regenerative satellite' : '再生卫星'
  return en ? 'Satellite' : '卫星'
}
function edgeLabel(edge, en) {
  if (edge?.missing || edge?.invalid) return [en ? (edge.missing ? 'Missing link' : 'Invalid link') : (edge.missing ? '缺少链路' : '无效链路')]
  const labels = en ? { up: 'Uplink', down: 'Downlink', isl: 'RF ISL', laser: 'Optical ISL', ground: 'Ground link' }
    : { up: '上行链路', down: '下行链路', isl: '星间微波', laser: '星间激光', ground: '地面链路' }
  return [labels[edge?.type] || (en ? 'Link' : '链路'), String(edge?.frequency || '')].filter(Boolean)
}
function geometry(nodes, start, end) {
  const boxes = [], rows = []; let y = PAD
  for (let offset = 0; start + offset <= end; offset += 3) {
    const slice = nodes.slice(start + offset, Math.min(end + 1, start + offset + 3))
    const labels = slice.map((n) => wrap(n.name))
    const height = Math.max(156, 80 + Math.max(...labels.map((l) => l.length)) * 39)
    const row = rows.length
    slice.forEach((node, col) => boxes.push({ node, index: start + offset + col, lines: labels[col],
      x: PAD + (row % 2 ? 2 - col : col) * (BOX + GAP), y, h: height, row }))
    rows.push({ y, h: height }); y += height + ROW_GAP
  }
  return { boxes, h: y - ROW_GAP + PAD }
}
function diagram(link, nodes, edges, start, end, lang, style, font) {
  const en = lang === 'en', layout = geometry(nodes, start, end)
  const ink = style === 'pdf' ? '#000080' : '#111111', muted = style === 'pdf' ? '#526477' : '#333333'
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${layout.h}" viewBox="0 0 ${WIDTH} ${layout.h}" role="img">`,
    `<rect width="${WIDTH}" height="${layout.h}" fill="white"/>`,
    `<defs><marker id="arrow" markerWidth="12" markerHeight="10" refX="10" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10" fill="none" stroke="${ink}" stroke-width="3"/></marker></defs>`,
    `<g font-family="${xml(font)}" text-anchor="middle">`]
  for (let i = 0; i < layout.boxes.length - 1; i++) {
    const a = layout.boxes[i], b = layout.boxes[i + 1], labels = edgeLabel(edges[a.index], en)
    const edgeStyle = edges[a.index]?.invalid || edges[a.index]?.missing ? 'stroke-dasharray="8 8"' : 'marker-end="url(#arrow)"'
    let path, x, y, anchor = 'middle'
    if (a.row === b.row) {
      const right = b.x > a.x, x1 = right ? a.x + BOX : a.x, x2 = right ? b.x : b.x + BOX
      y = a.y + a.h / 2; x = (x1 + x2) / 2
      path = `M${x1},${y} L${x2},${y}`
      parts.push(`<path d="${path}" fill="none" stroke="${ink}" stroke-width="3" ${edgeStyle}/>`)
      labels.forEach((label, li) => parts.push(`<text x="${x}" y="${y + (li ? 38 : -24)}" font-size="28" fill="${muted}">${xml(label)}</text>`))
    } else {
      const cx = a.x + BOX / 2, bottom = a.y + a.h
      path = `M${cx},${bottom} L${cx},${b.y}`
      x = cx + (a.x > WIDTH / 2 ? -22 : 22); y = (bottom + b.y) / 2 - 12
      anchor = a.x > WIDTH / 2 ? 'end' : 'start'
      parts.push(`<path d="${path}" fill="none" stroke="${ink}" stroke-width="3" ${edgeStyle}/>`)
      labels.forEach((label, li) => parts.push(`<text x="${x}" y="${y + li * 34}" text-anchor="${anchor}" font-size="28" fill="${muted}">${xml(label)}</text>`))
    }
  }
  for (const b of layout.boxes) {
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${BOX}" height="${b.h}" fill="white" stroke="${ink}" stroke-width="3"/>`)
    parts.push(`<text x="${b.x + BOX / 2}" y="${b.y + 36}" font-size="28" fill="${muted}">${b.index + 1}  ${xml(nodeLabel(b.node.kind, b.index, nodes.length, en))}</text>`)
    b.lines.forEach((line, i) => parts.push(`<text x="${b.x + BOX / 2}" y="${b.y + 82 + i * 39}" font-size="34" fill="${ink}">${xml(line)}</text>`))
  }
  parts.push('</g></svg>')
  return { svg: parts.join(''), w: WIDTH, h: layout.h, start, end, linkNo: link.no }
}

function cascadeTopologyDiagrams(model, { style = 'word' } = {}) {
  if (['sla', 'cap'].includes(model.kind) || model.scheme?.orbitType !== 'E2E') return []
  const en = model.lang === 'en', font = fontsOf(model.doc)
  const family = style === 'pdf' ? (model.doc?.fonts?.cssBody || 'Verdana, Arial, Microsoft YaHei, SimSun, sans-serif')
    : `${font.latin}, ${font.cjkBody}, serif`, result = []
  for (const link of model.links || []) {
    const nodes = link.topology?.nodes, edges = link.topology?.edges
    // Incomplete configurations retain their error in the budget; never draw
    // missing hops as though they were verified connections.
    if (!Array.isArray(nodes) || nodes.length < 2 || !Array.isArray(edges) || edges.length !== nodes.length - 1) continue
    const figures = []; let start = 0
    while (start < nodes.length - 1) {
      let end = Math.min(nodes.length - 1, start + 8)
      while (end > start + 1 && geometry(nodes, start, end).h > 1100) end--
      figures.push(diagram(link, nodes, edges, start, end, model.lang, style, family)); start = end
    }
    figures.forEach((figure, index) => {
      const configured = link.topologyConfiguredOnly || link.topology.configuredOnly || link.error || !link.data
      const title = en ? `#${link.no} ${configured ? 'Configured cascade' : 'Actual cascade topology'}`
        : `#${link.no} ${configured ? '配置级联拓扑' : '实际级联拓扑'}`
      const continuation = figures.length > 1 ? (en ? ` (part ${index + 1}/${figures.length})` : `（续图 ${index + 1}/${figures.length}）`) : ''
      const caption = title + continuation + (en ? `. Nodes ${figure.start + 1}–${figure.end + 1}; arrows show signal direction.`
        : `。节点 ${figure.start + 1}–${figure.end + 1}，箭头表示信号传输方向。`)
        + (configured ? (en ? ' Configuration only; no successful budget result.' : '仅表示配置，尚无成功预算结果。') : '')
      result.push({ ...figure, title, caption, part: index + 1, parts: figures.length })
    })
  }
  return result
}

// Uses Chromium already shipped with the desktop application. No additional
// native raster library or network resource is needed in the packaged app.
async function rasterizeDiagram(svg, w, h) {
  const { BrowserWindow } = require('electron')
  const win = new BrowserWindow({ show: false, width: 800, height: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><body></body>'))
    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
      await img.decode(); await document.fonts.ready;
      const canvas = document.createElement('canvas'); canvas.width = ${w * 2}; canvas.height = ${h * 2};
      const ctx = canvas.getContext('2d'); ctx.scale(2, 2); ctx.drawImage(img, 0, 0, ${w}, ${h});
      return canvas.toDataURL('image/png');
    })()`)
    return Buffer.from(dataUrl.split(',')[1], 'base64')
  } finally { if (!win.isDestroyed()) win.destroy() }
}
async function cascadeTopologyFigures(model, options = {}) {
  const diagrams = cascadeTopologyDiagrams(model, options), raster = options.rasterize || rasterizeDiagram
  const figures = []
  for (const descriptor of diagrams) {
    const { svg, ...metadata } = descriptor
    figures.push({ ...metadata, data: await raster(svg, descriptor.w, descriptor.h) })
  }
  return figures
}
module.exports = { cascadeTopologyDiagrams, cascadeTopologyFigures }
