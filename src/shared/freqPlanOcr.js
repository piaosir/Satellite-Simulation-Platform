// 频率计划截图 · 轻量 OCR（渲染端 ESM，零外部依赖）。
//
// 为什么不上 tesseract：这类图的字符集极小（0-9 · 小数点 · 大写字母），字形是 PPT/Visio 导出的
// 标准无衬线印刷体，白底黑字无噪声，且同一张图内字体统一。通用 OCR 的版面分析在这种「一堆孤立
// 短数字串」上反而容易乱切，还要背 11MB 语言包。改用模板匹配：用 canvas 现渲染字模，按归一化
// 位图相关度取最优——同图字体统一时准确率高，且完全离线、无包体代价。
//
// 兜底才是关键：识别结果从不直接采信，而是交给 freqPlanVision 的等差推断与 LO 交叉校验去核，
// 对不上的标存疑、交人校对。所以这里宁可给出低置信度也不硬猜。

// 归一化网格：字符 bbox 按高度缩放到 GH，宽按原比例，居中放入 GW×GH。
// 宽度不拉满是刻意的——「1」和「0」的宽窄差异是重要判别特征，拉伸会把它抹平。
const GW = 20, GH = 28

// 候选字体：PPT/Visio 图最常见的几种无衬线。多字体模板取最优，覆盖不同来源的图。
const FONTS = ['Arial', 'Calibri', 'Helvetica', 'Tahoma', 'Segoe UI', 'sans-serif']
const CHARSET = '0123456789.ABCDEFGHIJKLMNOPQRSTUVWXYZ'

let _templates = null   // [{ ch, font, bold, grid: Float32Array(GW*GH), aspect }]

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  return c
}

// 把一块二值 mask（1=墨迹）按 bbox 归一化进 GW×GH 网格，返回 [0,1] 灰度（做了面积平均，抗锯齿）
function normalizeMask(mask, mw, mh, box) {
  const { x0, y0, x1, y1 } = box
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1
  const grid = new Float32Array(GW * GH)
  if (bw <= 0 || bh <= 0) return { grid, aspect: 1 }
  // 按高度定缩放，宽度同比；宽超出 GW 时再按宽压（极宽字符如「—」）
  let scale = GH / bh
  if (bw * scale > GW) scale = GW / bw
  const tw = Math.max(1, Math.round(bw * scale)), th = Math.max(1, Math.round(bh * scale))
  const ox = Math.floor((GW - tw) / 2), oy = Math.floor((GH - th) / 2)
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      // 目标像素 → 源区域面积平均
      const sx0 = x0 + Math.floor(tx * bw / tw), sx1 = x0 + Math.max(Math.floor((tx + 1) * bw / tw), Math.floor(tx * bw / tw) + 1)
      const sy0 = y0 + Math.floor(ty * bh / th), sy1 = y0 + Math.max(Math.floor((ty + 1) * bh / th), Math.floor(ty * bh / th) + 1)
      let sum = 0, cnt = 0
      for (let sy = sy0; sy < sy1 && sy <= y1; sy++) {
        for (let sx = sx0; sx < sx1 && sx <= x1; sx++) { sum += mask[sy * mw + sx]; cnt++ }
      }
      grid[(ty + oy) * GW + (tx + ox)] = cnt ? sum / cnt : 0
    }
  }
  // ★ 归一化后二值化（模板与待识字符走同一条路）。
  //   待识字符来自「小图放大 + 抗锯齿」，笔画是软边、灰度铺得宽；模板是 64 px 清晰渲染，
  //   笔画锐而实。不二值化的话，余弦相似度比的是【灰度分布】而不是【字形】，糊字符会一律
  //   偏向笔画粗的模板（实测「1」被判成「.」）。硬边之后比的才是形状本身。
  for (let i = 0; i < grid.length; i++) grid[i] = grid[i] > 0.42 ? 1 : 0
  return { grid, aspect: bw / bh }
}

// 渲染一个字符 → 归一化网格（建模板用）
function renderTemplate(ch, font, bold) {
  const S = 64
  const cv = makeCanvas(S * 2, S * 2)
  if (!cv) return null
  const g = cv.getContext('2d', { willReadFrequently: true })
  if (!g) return null
  g.fillStyle = '#fff'; g.fillRect(0, 0, S * 2, S * 2)
  g.fillStyle = '#000'
  g.font = `${bold ? 'bold ' : ''}${S}px ${font}`
  g.textBaseline = 'middle'; g.textAlign = 'center'
  g.fillText(ch, S, S)
  const img = g.getImageData(0, 0, S * 2, S * 2)
  const mw = S * 2, mh = S * 2
  const mask = new Float32Array(mw * mh)
  let x0 = mw, y0 = mh, x1 = -1, y1 = -1
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const v = 1 - img.data[p] / 255       // 白底黑字 → 墨迹强度
    mask[i] = v
    if (v > INK_THR) {
      const x = i % mw, y = (i / mw) | 0
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (y < y0) y0 = y; if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return null
  const { grid, aspect } = normalizeMask(mask, mw, mh, { x0, y0, x1, y1 })
  return { ch, font, bold, grid, aspect }
}

export function buildTemplates(force = false) {
  if (_templates && !force) return _templates
  const out = []
  for (const font of FONTS) {
    for (const bold of [false, true]) {
      for (const ch of CHARSET) {
        const t = renderTemplate(ch, font, bold)
        if (t) out.push(t)
      }
    }
  }
  _templates = out
  return out
}

// 相关度：网格逐点乘积归一（余弦相似），再按宽高比差异做一点惩罚。
// 用余弦而非汉明——抗锯齿的灰边在余弦下是软过渡，硬阈值会把细笔画切没。
function score(a, aAspect, b, bAspect) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (na <= 0 || nb <= 0) return 0
  const cos = dot / Math.sqrt(na * nb)
  const ar = Math.abs(Math.log((aAspect || 1) / (bAspect || 1)))
  return cos - Math.min(0.25, ar * 0.18)     // 宽高比差一倍 ≈ 扣 0.12
}

// 识别单个字符块 → { ch, conf, alts:[{ch,conf}] }
export function recognizeGlyph(mask, mw, mh, box) {
  const tpl = buildTemplates()
  if (!tpl.length) return { ch: '', conf: 0, alts: [] }
  const { grid, aspect } = normalizeMask(mask, mw, mh, box)
  // 每个字符只保留其最优字体的分（同一字符在多字体下重复计分会挤掉真正的次优字符）
  const best = new Map()
  for (const t of tpl) {
    const s = score(grid, aspect, t.grid, t.aspect)
    if (!best.has(t.ch) || s > best.get(t.ch)) best.set(t.ch, s)
  }
  const ranked = [...best.entries()].map(([ch, s]) => ({ ch, conf: s })).sort((a, b) => b.conf - a.conf)
  const top = ranked[0] || { ch: '', conf: 0 }
  // 置信度取「与次优的差距」加权——两个字形分不开时（如 8/B、0/O）应当报低置信，交人校对
  const gap = ranked[1] ? top.conf - ranked[1].conf : 0.3
  return { ch: top.ch, conf: Math.max(0, Math.min(1, top.conf * (0.7 + Math.min(0.3, gap * 2)))), alts: ranked.slice(0, 3) }
}

// ---- 字符切分 ----
// 用连通域而非垂直投影：投影法遇到「14.5」的小数点会与相邻数字并进同一列区间，
// 也扛不住轻微倾斜；连通域天然按笔画分组。小数点（矮、贴底、面积小）单独识别，不进模板匹配。

// 墨迹阈值。★ 必须与 freqPlanVision 的 ink 归一化口径相称：ink = (160 − lum)/120，
// 小字号抗锯齿的笔画中心 lum 常在 100~120，对应 ink 只有 0.33~0.5。阈值卡在 0.4 会把
// 笔画从中间切断——一个「3」裂成「J」+「I」，字符数凭空多出来，整串就废了。
const INK_THR = 0.18

function connectedGlyphs(mask, mw, mh, thr = INK_THR) {
  const seen = new Uint8Array(mw * mh)
  const out = []
  const stack = new Int32Array(mw * mh)
  for (let i = 0; i < mask.length; i++) {
    if (seen[i] || mask[i] <= thr) continue
    let sp = 0
    stack[sp++] = i; seen[i] = 1
    let x0 = mw, y0 = mh, x1 = -1, y1 = -1, area = 0
    while (sp > 0) {
      const p = stack[--sp]
      const x = p % mw, y = (p / mw) | 0
      area++
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (y < y0) y0 = y; if (y > y1) y1 = y
      // 8 邻域：数字笔画在抗锯齿下常只有对角相连
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue
          const q = ny * mw + nx
          if (seen[q] || mask[q] <= thr) continue
          seen[q] = 1; stack[sp++] = q
        }
      }
    }
    out.push({ x0, y0, x1, y1, area })
  }
  return out
}

// 一块文本区域 → 字符串。假定为单行水平文本。
export function recognizeLine(mask, mw, mh) {
  let parts = connectedGlyphs(mask, mw, mh)
  if (!parts.length) return { text: '', conf: 0, glyphs: [] }
  // 噪点剔除：面积极小且不在底部的碎片
  const heights = parts.map((p) => p.y1 - p.y0 + 1).sort((a, b) => a - b)
  const medH = heights[Math.floor(heights.length / 2)] || 1
  const baseY = Math.max(...parts.map((p) => p.y1))
  parts = parts.filter((p) => {
    const h = p.y1 - p.y0 + 1
    if (p.area < 2) return false
    if (h < medH * 0.28 && p.y1 < baseY - medH * 0.35) return false   // 高处的小碎屑 = 噪点
    return true
  })
  if (!parts.length) return { text: '', conf: 0, glyphs: [] }
  parts.sort((a, b) => a.x0 - b.x0)

  // ★ 小数点必须【在合并之前】认出来。它又矮又窄又贴底，正好落进「笔画碎片」的特征里，
  //   若先合并再特判，它会被并进前一个数字：「13783.5」的「3.」并成一个 glyph 后整体误读，
  //   一个小数点丢掉就是 10 倍的频率误差（14229.5 读成 142295）。故先打标记，合并时跳过它们。
  const isDot = (p) => {
    const h = p.y1 - p.y0 + 1, w = p.x1 - p.x0 + 1
    return h <= medH * 0.42 && w <= medH * 0.55 && p.y1 >= baseY - medH * 0.28
  }
  for (const p of parts) p.dot = isDot(p)

  // 竖直方向重叠且水平接近的两块合并（被抗锯齿断开的笔画）。小数点不参与合并（两个方向都不）。
  const merged = []
  for (const p of parts) {
    const last = merged[merged.length - 1]
    if (last && !p.dot && !last.dot) {
      const gapX = p.x0 - last.x1
      const lastH = last.y1 - last.y0 + 1, pH = p.y1 - p.y0 + 1
      // 两块水平几乎叠着，且至少一块明显矮于中位高（笔画碎片而非独立字符）
      if (gapX < -medH * 0.15 || (gapX < medH * 0.08 && (lastH < medH * 0.75 || pH < medH * 0.75))) {
        last.x0 = Math.min(last.x0, p.x0); last.x1 = Math.max(last.x1, p.x1)
        last.y0 = Math.min(last.y0, p.y0); last.y1 = Math.max(last.y1, p.y1)
        last.area += p.area
        continue
      }
    }
    merged.push({ ...p })
  }

  const glyphs = []
  let sumConf = 0
  for (const p of merged) {
    // 小数点：模板匹配对这种 2×2 的点毫无区分力，按几何直接判定更稳
    if (p.dot) {
      glyphs.push({ ch: '.', conf: 0.9, box: p })
      sumConf += 0.9
      continue
    }
    const r = recognizeGlyph(mask, mw, mh, p)
    glyphs.push({ ch: r.ch, conf: r.conf, alts: r.alts, box: p })
    sumConf += r.conf
  }
  return {
    text: glyphs.map((g) => g.ch).join(''),
    conf: glyphs.length ? sumConf / glyphs.length : 0,
    glyphs
  }
}

// ---- 文本 → 数值 ----

// 识别串 → 频率数值。带常见混淆修正：字母 O/o→0、l/I→1、S→5、B→8（纯数字语境下）。
export function textToNumber(text) {
  let s = String(text || '').trim()
  if (!s) return null
  s = s.replace(/[Oo]/g, '0').replace(/[IlL]/g, '1').replace(/[Ss]/g, '5').replace(/[Bb]/g, '8').replace(/[Zz]/g, '2')
  s = s.replace(/[^0-9.]/g, '')
  // 多个小数点 = 切分或识别出错，取最后一个当真（"1 4 0 2 2" 这类误插点的典型形态）
  const dots = s.split('.').length - 1
  if (dots > 1) {
    const i = s.lastIndexOf('.')
    s = s.slice(0, i).replace(/\./g, '') + s.slice(i)
  }
  if (!s || s === '.') return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

// 识别串 → 通道编号。图上编号形如 C1 / M14 / S3 / K11 / P5 / 19 / TC1 / TM2。
export function textToChannelNo(text) {
  const s = String(text || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (!s) return null
  const m = s.match(/^([A-Z]{0,2})(\d{1,3})$/)
  if (!m) return null
  return { prefix: m[1] || '', num: Number(m[2]), no: s }
}
