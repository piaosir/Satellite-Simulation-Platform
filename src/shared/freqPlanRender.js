// 转发器频率计划 · 渲染（渲染端 ESM）。
//
// 一套几何两处用：屏上编辑器直接吃 layout() 的结果做命中测试与拖拽，导出 PNG/PDF 吃同一份
// layout 生成 SVG —— 所见即所得不是靠对齐两套代码，而是压根只有一套。
//
// 版式对齐标准频率计划图（中星/亚太/前向计划那一族）：
//   每个频带 = 频率标注（上）· 极化行1 · 基线 · 极化行2 · 频率标注（下）
//   上行带在上、下行带在下，中间留 LO 变频箭头的走道；底部是波束图例与 LO/信标注记。
//
// 字体：跟平台报表统一的 TNR + 宋体衬线栈，且写死进 SVG —— 导出的 SVG 离开页面后没有祖先可继承，
// 不写死就会在 PDF 里掉回默认字体（这个坑踩过，见 lb-export-png-resolution）。

import { resolveAll, planExtent, toGHz } from './freqPlanModel.js'

export const SERIF_STACK = "'Times New Roman', 'Nimbus Roman', 'Liberation Serif', '宋体', SimSun, serif"

export const DEFAULT_STYLE = {
  width: 1280,
  fontSize: 12,
  blockH: 26,             // 色块高度
  rowGap: 2,              // 同带内两个极化行的间距（基线厚度居中）
  labelGap: 4,            // 色块与频率标注的间距
  bandGap: 96,            // 上下行带之间的走道（放 LO 箭头）
  padX: 64,               // 左侧极化标签区
  padTop: 34,
  padBottom: 16,
  minBlockW: 16,          // 太窄的块也要保证编号看得见
  showFreqLabels: true,
  showLegend: true,
  showLo: true,
  showGuides: true,       // 两端的边界竖线
  unit: 'MHz',            // 'MHz' | 'GHz' —— 只影响标注文字，不影响几何
  theme: 'light'
}

const THEMES = {
  light: { paper: '#ffffff', ink: '#1a1a1a', dim: '#666', line: '#333', axis: '#555', blockStroke: '#8a6d1f', suspect: '#c62828', guide: '#888' },
  dark: { paper: '#141618', ink: '#e8e8e8', dim: '#9aa0a6', line: '#c8c8c8', axis: '#a0a0a0', blockStroke: '#d4af37', suspect: '#ff6b6b', guide: '#777' }
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n2 = (v) => (Number.isFinite(v) ? (Math.round(v * 100) / 100) : null)

// 频率 → 标注文字。GHz 模式下按量程给足小数位（Ku 上行 14.0225 GHz 这种要 4 位才不丢信息）
function fmtFreq(mhz, unit) {
  if (!Number.isFinite(mhz)) return ''
  if (unit === 'GHz') {
    const g = mhz / 1000
    const s = g.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
    return s
  }
  const s = (Math.round(mhz * 100) / 100).toString()
  return s
}

/**
 * 计算版式几何。返回的每个 block 带 channelId，编辑器据此做命中测试。
 */
export function layout(plan, styleIn = {}) {
  const st = { ...DEFAULT_STYLE, ...styleIn }
  const rs = resolveAll(plan)
  const innerW = st.width - st.padX - 24

  // 两个频带各自独立的频率轴（上下行量程完全不同，共用一根轴会把其中一边压成一条线）
  const bands = []
  for (const side of ['up', 'dn']) {
    const items = rs.filter((r) => (side === 'up' ? r.up : r.dn))
    if (!items.length) continue
    const ext = planExtent(plan, side, 0.015)
    if (!ext) continue
    // 极化行：按该带内实际出现的极化归行，保持 H/L 在上、V/R 在下的惯例
    const pols = [...new Set(items.map((r) => (side === 'up' ? r.up : r.dn).pol))]
    pols.sort((a, b) => (['H', 'L', 'V', 'R'].indexOf(a) - ['H', 'L', 'V', 'R'].indexOf(b)))
    bands.push({ side, ext, pols, items })
  }
  if (!bands.length) return { style: st, bands: [], blocks: [], width: st.width, height: 160, empty: true }

  const x2f = (band, f) => st.padX + ((f - band.ext.min) / (band.ext.max - band.ext.min)) * innerW
  const blocks = []
  let y = st.padTop

  for (const band of bands) {
    band.title = band.side === 'up' ? 'UPLINK' : 'DOWNLINK'
    band.titleY = y
    y += st.fontSize * 1.6
    band.labelTopY = y
    y += st.showFreqLabels ? st.fontSize * 1.25 : 0
    band.rowY = []
    for (let i = 0; i < band.pols.length; i++) {
      band.rowY.push(y)
      y += st.blockH + st.rowGap
      // 第一行之后画基线（标准图的那条贯穿粗线在两排之间）
      if (i === 0) { band.baselineY = y - st.rowGap / 2; y += 2 }
    }
    if (band.pols.length === 1) band.baselineY = band.rowY[0] + st.blockH + 1
    band.labelBottomY = y + st.fontSize * 0.2
    y += st.showFreqLabels ? st.fontSize * 1.3 : 0
    band.y0 = band.titleY
    band.y1 = y
    band.axisX0 = st.padX - 8
    band.axisX1 = st.padX + innerW + 8

    for (const r of band.items) {
      const s = band.side === 'up' ? r.up : r.dn
      const rowIdx = Math.max(0, band.pols.indexOf(s.pol))
      const hasBw = Number.isFinite(s.bw) && s.bw > 0
      const x0 = hasBw ? x2f(band, s.f1) : x2f(band, s.fc) - st.minBlockW / 2
      const x1 = hasBw ? x2f(band, s.f2) : x2f(band, s.fc) + st.minBlockW / 2
      const wRaw = x1 - x0
      const w = Math.max(st.minBlockW, wRaw)
      blocks.push({
        channelId: r.id, no: r.no, side: band.side, kind: r.kind,
        x: x0 - (w - wRaw) / 2, y: band.rowY[rowIdx], w, h: st.blockH,
        pol: s.pol, fc: s.fc, bw: s.bw,
        color: (band.side === 'up' ? r.beamUp : r.beamDn)?.color || null,
        derived: band.side === 'dn' && r.dnDerived,
        suspect: !!r.raw?._suspect,
        // 标注交替上下，避免密排时首尾相撞（标准图正是这么排的）
        labelSide: rowIdx === 0 ? 'above' : 'below',
        labelY: rowIdx === 0 ? band.labelTopY : band.labelBottomY
      })
    }
    y += st.bandGap
  }
  y -= st.bandGap

  // 图例 + LO 注记
  let legendY = null, loY = null
  if (st.showLegend && plan.beams?.length) { y += st.fontSize * 1.8; legendY = y; y += st.fontSize * 1.4 }
  if (st.showLo && plan.los?.length) { y += st.fontSize * 0.9; loY = y; y += st.fontSize * 1.3 }
  y += st.padBottom

  return { style: st, bands, blocks, legendY, loY, width: st.width, height: Math.ceil(y), x2f, innerW }
}

/**
 * 生成 SVG 字符串。scale 用于导出倍率——★ 按倍率重画（放大所有几何与字号），
 * 而不是给 SVG 加 viewBox 缩放：后者会让 non-scaling-stroke 把线钉成发丝。
 */
export function toSvg(plan, styleIn = {}, scale = 1, fontFamily = null) {
  const st0 = { ...DEFAULT_STYLE, ...styleIn }
  // 按倍率把所有长度量放大后重新排版
  const st = scale === 1 ? st0 : Object.fromEntries(Object.entries(st0).map(([k, v]) => [
    k, (typeof v === 'number' && k !== 'unit') ? v * scale : v
  ]))
  const L = layout(plan, st)
  const T = THEMES[st0.theme] || THEMES.light
  const fs = st.fontSize
  const out = []
  const sw = Math.max(1, 1 * scale)     // 基础线宽随倍率走
  // 矢量 PDF 导出时传入 jsPDF 里注册的族名（中文要靠嵌入字体才不掉字），其余场合用平台衬线栈
  const ff = fontFamily || SERIF_STACK

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" font-family="${ff}">`)
  out.push(`<rect x="0" y="0" width="${L.width}" height="${L.height}" fill="${T.paper}"/>`)

  if (L.empty) {
    out.push(`<text x="${L.width / 2}" y="${L.height / 2}" font-size="${fs}" fill="${T.dim}" text-anchor="middle">频率计划为空 — 请添加转发器</text></svg>`)
    return out.join('')
  }

  for (const band of L.bands) {
    // 频带标题
    out.push(`<text x="${st.padX - 8}" y="${band.titleY + fs}" font-size="${fs * 1.15}" font-weight="bold" fill="${T.ink}">${band.title}</text>`)
    // 两端边界竖线（标准图的量程界标）
    if (st.showGuides) {
      for (const gx of [band.axisX0, band.axisX1]) {
        out.push(`<line x1="${gx}" y1="${band.rowY[0] - fs * 1.2}" x2="${gx}" y2="${band.rowY[band.rowY.length - 1] + st.blockH + fs * 0.6}" stroke="${T.guide}" stroke-width="${sw * 2.2}"/>`)
      }
      out.push(`<text x="${band.axisX0}" y="${band.rowY[0] - fs * 1.6}" font-size="${fs * 0.86}" fill="${T.dim}" text-anchor="middle">${fmtFreq(band.ext.dataMin, st.unit)}</text>`)
      out.push(`<text x="${band.axisX1}" y="${band.rowY[0] - fs * 1.6}" font-size="${fs * 0.86}" fill="${T.dim}" text-anchor="middle">${fmtFreq(band.ext.dataMax, st.unit)}</text>`)
    }
    // 基线
    out.push(`<line x1="${band.axisX0}" y1="${band.baselineY}" x2="${band.axisX1}" y2="${band.baselineY}" stroke="${T.line}" stroke-width="${sw * 1.6}"/>`)
    // 极化标签
    band.pols.forEach((p, i) => {
      out.push(`<text x="${st.padX - 20}" y="${band.rowY[i] + st.blockH / 2 + fs * 0.36}" font-size="${fs * 1.05}" fill="${T.ink}" text-anchor="end">${esc(p)}</text>`)
    })
  }

  // 色块 + 编号 + 频率标注
  for (const b of L.blocks) {
    const fillC = b.color || '#5B8FD4'
    const stroke = b.suspect ? T.suspect : T.blockStroke
    const dash = b.derived ? ` stroke-dasharray="${sw * 3} ${sw * 2}"` : ''
    out.push(`<rect x="${b.x.toFixed(2)}" y="${b.y.toFixed(2)}" width="${b.w.toFixed(2)}" height="${b.h.toFixed(2)}" fill="${fillC}" stroke="${stroke}" stroke-width="${(b.suspect ? sw * 2 : sw * 1.4).toFixed(2)}"${dash}/>`)
    if (b.no) {
      // 编号字号随块宽收敛，窄块也不溢出
      const maxFs = Math.min(fs * 1.05, b.w / Math.max(1.6, String(b.no).length * 0.62))
      out.push(`<text x="${(b.x + b.w / 2).toFixed(2)}" y="${(b.y + b.h / 2 + maxFs * 0.35).toFixed(2)}" font-size="${maxFs.toFixed(2)}" fill="${pickTextColor(fillC)}" text-anchor="middle">${esc(b.no)}</text>`)
    }
    if (st.showFreqLabels && Number.isFinite(b.fc)) {
      const ty = b.labelSide === 'above' ? b.labelY + fs * 0.9 : b.labelY + fs * 0.95
      out.push(`<text x="${(b.x + b.w / 2).toFixed(2)}" y="${ty.toFixed(2)}" font-size="${(fs * 0.86).toFixed(2)}" fill="${T.dim}" text-anchor="middle">${fmtFreq(b.fc, st.unit)}</text>`)
    }
  }

  // LO 变频箭头：从上行带底部指向下行带顶部
  if (st.showLo && L.bands.length === 2 && plan.los?.length) {
    const up = L.bands[0], dn = L.bands[1]
    const ax = st.padX + L.innerW * 0.5
    const y0 = up.y1 + fs * 0.6, y1 = dn.y0 - fs * 0.4
    out.push(`<defs><marker id="fparrow" markerWidth="${8 * scale}" markerHeight="${8 * scale}" refX="${6 * scale}" refY="${4 * scale}" orient="auto"><path d="M0,0 L${8 * scale},${4 * scale} L0,${8 * scale} Z" fill="${T.line}"/></marker></defs>`)
    out.push(`<line x1="${ax}" y1="${y0}" x2="${ax}" y2="${y1}" stroke="${T.line}" stroke-width="${sw * 1.6}" marker-end="url(#fparrow)"/>`)
    const txt = plan.los.map((l) => `${l.name}: ${Number.isFinite(l.valueMHz) ? (st.unit === 'GHz' ? (l.valueMHz / 1000).toFixed(3) + ' GHz' : l.valueMHz + ' MHz') : '—'}`).join('   ')
    out.push(`<text x="${ax + 10 * scale}" y="${((y0 + y1) / 2 + fs * 0.35).toFixed(2)}" font-size="${(fs * 0.95).toFixed(2)}" fill="${T.ink}">${esc(txt)}</text>`)
  }

  // 波束图例
  if (L.legendY != null && plan.beams?.length) {
    let lx = st.padX
    const sq = fs * 1.05
    for (const bm of plan.beams) {
      out.push(`<rect x="${lx}" y="${L.legendY}" width="${sq * 1.6}" height="${sq}" fill="${bm.color}" stroke="${T.blockStroke}" stroke-width="${sw}"/>`)
      const label = `${bm.code ? bm.code + '：' : ''}${bm.name}`
      out.push(`<text x="${lx + sq * 1.6 + 6 * scale}" y="${L.legendY + sq * 0.82}" font-size="${(fs * 0.92).toFixed(2)}" fill="${T.ink}">${esc(label)}</text>`)
      lx += sq * 1.6 + 10 * scale + label.length * fs * 0.56
    }
  }

  // LO / 信标 一行注记
  if (L.loY != null) {
    const beacons = (plan.channels || []).filter((c) => c.kind === 'beacon' || c.kind === 'tc' || c.kind === 'tm')
    if (beacons.length) {
      const s = beacons.map((c) => `${c.no || '—'}: ${fmtFreq(c.up.fcMHz ?? c.dn.fcMHz, st.unit)} ${st.unit}${c.dn.pol ? ' ' + c.dn.pol : ''}`).join('    ')
      out.push(`<text x="${st.padX}" y="${L.loY + fs}" font-size="${(fs * 0.9).toFixed(2)}" fill="${T.dim}">${esc(s)}</text>`)
    }
  }

  out.push('</svg>')
  return out.join('')
}

// 块底色 → 编号文字取黑或白（保证对比度；标准图上深蓝块配白字、黄块配黑字）
function pickTextColor(hexColor) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hexColor || ''))
  if (!m) return '#fff'
  const v = parseInt(m[1], 16)
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111' : '#fff'
}

// 命中测试：屏上点击 (x,y) → 落在哪个块（编辑器选中用）
export function hitTest(layoutRes, x, y) {
  for (const b of layoutRes.blocks) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b
  }
  return null
}

// SVG → PNG DataURL（导出用，倍率已在 toSvg 里按几何重画，这里只负责栅格化）
export function svgToPngDataUrl(svgText, width, height) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      try {
        const cv = document.createElement('canvas')
        cv.width = width; cv.height = height
        const g = cv.getContext('2d')
        g.fillStyle = '#fff'; g.fillRect(0, 0, width, height)
        g.drawImage(img, 0, 0, width, height)
        URL.revokeObjectURL(url)
        resolve(cv.toDataURL('image/png'))
      } catch (e) { URL.revokeObjectURL(url); reject(e) }
    }
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error('SVG 栅格化失败')) }
    img.src = url
  })
}
