// 频率计划截图 · 自适应识图（渲染端 ESM）。
//
// 输入一张标准频率计划图的位图，输出【频率计划草稿 + 检测叠加层】，供校对界面逐项确认。
// 明确不承诺「导入即用」，承诺「导入后改几个数」——所以每一步都留下可视化痕迹与置信度。
//
// 流程：
//   ① 像素分类（彩色填充 / 黑色墨迹 / 纸白）→ ② 色块连通域（每个转发器一个矩形）
//   ③ 行聚类（同一极化排）→ ④ 频带分区（上行区 / 下行区，按 y 大间隙切）
//   ⑤ 文本连通域 → OCR（框内=编号，框外=频率标注，最左=极化字母）
//   ⑥ ★ 用「已识别频率 ↔ 色块中心 x」最小二乘拟合出 px→MHz 标度
//   ⑦ 标度回代：补全所有漏识的频率、由色块宽度算出带宽
//   ⑧ LO 反推（上下行同编号频率差取众数）+ 等差校验 → 存疑项标红
//
// ★ 第 ⑥ 步是全篇的支点：它把 OCR 从「必须全对」降级成「对几个就行」。一行里只要有两个数字
//   识别正确，整行的频率与带宽都能由几何算出，剩下的 OCR 结果反过来变成校验用的冗余。

import { newPlan, newChannel, newLo, newBeam, genId, POL_ORTHO, DEFAULT_BEAM_COLORS, inferArithmetic } from './freqPlanModel.js'
import { recognizeLine, textToNumber, textToChannelNo } from './freqPlanOcr.js'

// ---- 像素分类 ----

function classify(data, w, h) {
  const n = w * h
  const fill = new Float32Array(n)     // 彩色填充（色块）
  const ink = new Float32Array(n)      // 黑色墨迹（文字与线条）
  const rgb = new Uint8Array(n * 3)
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3]
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b
    if (a < 32) continue                                    // 透明背景当纸白
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    const sat = mx > 0 ? (mx - mn) / mx : 0
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    // 彩色填充：有明显饱和度且不太暗。阈值放宽到 0.16 以容纳浅黄/浅绿等淡色块。
    if (sat > 0.16 && lum > 45) fill[i] = Math.min(1, (sat - 0.16) / 0.25)
    // 墨迹：暗且不饱和（黑字/黑线）。深色填充块（如深蓝）靠 sat 排除，不会被当墨迹。
    // ★ 上界放到 160、分母放到 120（原为 118/80）：小字号文字本就带抗锯齿，笔画中心的
    //   灰度未必低到 90 以下；放大重采样后边缘进一步变灰。阈值卡太紧会把细笔画切断，
    //   一个「3」碎成两三个连通域，切串与识别跟着全盘皆输（实测就是这么废掉的）。
    if (lum < 160 && sat < 0.42) ink[i] = Math.min(1, (160 - lum) / 120)
  }
  return { fill, ink, rgb }
}

// 通用连通域（8 邻域），返回 bbox + 面积 + 像素索引采样
function components(mask, w, h, thr, minArea) {
  const seen = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  const out = []
  for (let i = 0; i < mask.length; i++) {
    if (seen[i] || mask[i] <= thr) continue
    let sp = 0
    stack[sp++] = i; seen[i] = 1
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0
    const sample = []
    while (sp > 0) {
      const p = stack[--sp]
      const x = p % w, y = (p / w) | 0
      area++
      if (area % 7 === 0 && sample.length < 400) sample.push(p)
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (y < y0) y0 = y; if (y > y1) y1 = y
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const q = ny * w + nx
          if (seen[q] || mask[q] <= thr) continue
          seen[q] = 1; stack[sp++] = q
        }
      }
    }
    if (area >= minArea) out.push({ x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area, sample })
    else out.push(null)
  }
  return out.filter(Boolean)
}

const median = (xs) => {
  if (!xs.length) return 0
  const s = xs.slice().sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// 双线性放大（纯数组，不依赖 Canvas）。
// ★ 为什么必须有：模板匹配要把字符归一化到 20×28 的网格，源字符只有 10 px 高时，
//   归一化等于把信息量凭空「拉」上去——笔画粘连、小数点糊进邻字，识别率断崖。
//   等价于「先把图放大看清楚再读」。按【字符实际高度】决定倍率，而不是按图的绝对宽度：
//   同样 1500 px 宽的图，字可能是 12 px 也可能是 20 px，只有前者需要放大。
function upscaleRGBA(data, w, h, s) {
  const nw = Math.round(w * s), nh = Math.round(h * s)
  const out = new Uint8ClampedArray(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, y / s)
    const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, x / s)
      const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0
      const i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4, i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4
      const o = (y * nw + x) * 4
      for (let c = 0; c < 4; c++) {
        out[o + c] = (data[i00 + c] * (1 - fx) + data[i01 + c] * fx) * (1 - fy)
                   + (data[i10 + c] * (1 - fx) + data[i11 + c] * fx) * fy
      }
    }
  }
  return { data: out, width: nw, height: nh }
}

// 探测「图上文字大概多高」：取暗色小连通域的高度中位数。用于决定放大倍率。
function probeGlyphHeight(data, w, h) {
  const ink = new Float32Array(w * h)
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2]
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    const sat = mx > 0 ? (mx - mn) / mx : 0
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    if (lum < 118 && sat < 0.42) ink[i] = 1
  }
  const comps = components(ink, w, h, 0.5, 3).filter((c) => c.h < h * 0.08 && c.w < w * 0.05)
  return comps.length ? median(comps.map((c) => c.h)) : 0
}

// 色块主色：取采样像素的中位 RGB（比均值抗边框/文字污染）
function blockColor(rgb, sample) {
  if (!sample.length) return [128, 128, 128]
  const rs = [], gs = [], bs = []
  for (const p of sample) { rs.push(rgb[p * 3]); gs.push(rgb[p * 3 + 1]); bs.push(rgb[p * 3 + 2]) }
  return [median(rs), median(gs), median(bs)]
}

const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
const colorDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// ---- 一维聚类：把散点按间隙切成组 ----
function cluster1d(items, keyFn, gapThreshold) {
  const sorted = items.slice().sort((a, b) => keyFn(a) - keyFn(b))
  const groups = []
  let cur = []
  for (const it of sorted) {
    if (!cur.length) { cur.push(it); continue }
    if (keyFn(it) - keyFn(cur[cur.length - 1]) > gapThreshold) { groups.push(cur); cur = [it] }
    else cur.push(it)
  }
  if (cur.length) groups.push(cur)
  return groups
}

// ---- 主入口 ----

/**
 * @param {ImageData} imageData 原图
 * @param {object} opts { minBlockArea, expectBandCount }
 * @returns {object} { plan, overlay, stats, warnings }
 */
export function analyzeImage(imageData, opts = {}) {
  const warnings = []
  // ⓪ 自适应放大：字太小就先放大再识别（倍率按实测字高定，见 probeGlyphHeight 的说明）。
  //    upScale 记进结果，供调用方把检测框换算回原图坐标画叠加层。
  const TARGET_GLYPH_H = 22
  let src = imageData
  let upScale = 1
  if (opts.autoUpscale !== false) {
    const gh = probeGlyphHeight(imageData.data, imageData.width, imageData.height)
    if (gh > 0 && gh < TARGET_GLYPH_H) {
      // 上限 4×：再高收益递减，而像素量按平方涨
      upScale = Math.min(4, Math.round((TARGET_GLYPH_H / gh) * 10) / 10)
      if (upScale > 1.05) {
        src = upscaleRGBA(imageData.data, imageData.width, imageData.height, upScale)
        warnings.push(`原图文字偏小（约 ${Math.round(gh)} px），已放大 ${upScale}× 后识别`)
      } else upScale = 1
    }
  }
  const w = src.width, h = src.height
  const { fill, ink, rgb } = classify(src.data, w, h)

  // ① 色块：矩形度过滤。图上的转发器块是实心矩形；块内的黑色编号会在 fill 里形成空洞，
  //    故填充率阈值放到 0.58——真矩形即便挖掉文字也远高于此，而斜线/箭头/图例文字远低于此。
  const minArea = opts.minBlockArea || Math.max(60, (w * h) / 22000)
  const rawBlocks = components(fill, w, h, 0.3, minArea)
  let blocks = rawBlocks
    .map((c) => ({ ...c, fillRatio: c.area / (c.w * c.h), color: blockColor(rgb, c.sample) }))
    .filter((c) => c.fillRatio > 0.58 && c.w > 6 && c.h > 5)
  if (!blocks.length) {
    return { plan: newPlan(), upScale, overlay: { blocks: [], texts: [], rows: [], bands: [] }, stats: { blocks: 0, upScale }, warnings: [...warnings, '未在图中检出任何色块 — 请确认这是一张标准频率计划图，或改用手工录入'] }
  }

  // 高度中位数作为全图尺度基准（行高、字高、间隙阈值都以它为单位）
  const medH = median(blocks.map((b) => b.h))
  // 图例色块（如「■ 全球波束」那种）通常孤立在底部且与主轴不成排 —— 先不剔除，
  // 留到行聚类后按「行内块数 < 2 且远离主群」判定，避免误伤只有一个转发器的行。

  // ② 行聚类：按块中心 y
  const withCy = blocks.map((b) => ({ ...b, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 }))
  const rowGroups = cluster1d(withCy, (b) => b.cy, medH * 0.7)
  let rows = rowGroups.map((g, i) => ({
    index: i,
    blocks: g.sort((a, b) => a.cx - b.cx),
    y0: Math.min(...g.map((b) => b.y0)),
    y1: Math.max(...g.map((b) => b.y1)),
    cy: median(g.map((b) => b.cy))
  }))

  // ③ 频带分区：行按 y 间隙切（上行区 / 下行区）。标准图上两区之间总有大段空白 + 标题文字。
  const rowGap = medH * 2.2
  const bandGroups = cluster1d(rows, (r) => r.cy, rowGap)
  let bands = bandGroups.map((g, i) => ({
    index: i,
    rows: g.sort((a, b) => a.cy - b.cy),
    y0: Math.min(...g.map((r) => r.y0)),
    y1: Math.max(...g.map((r) => r.y1))
  }))
  // 图例区剔除。「跨度小」一条判不住——图例那几个色块可以横排得很开（跨度接近主带），
  // 真正把图例和频带分开的是【块数】与【块尺寸】：图例只有寥寥几块，且块比转发器块矮小。
  const bandStat = (b) => {
    const blks = b.rows.flatMap((r) => r.blocks)
    return {
      cnt: blks.length,
      span: Math.max(...blks.map((k) => k.x1)) - Math.min(...blks.map((k) => k.x0)),
      medH: median(blks.map((k) => k.h)),
      medW: median(blks.map((k) => k.w))
    }
  }
  const stats0 = bands.map(bandStat)
  const mainCnt = Math.max(...stats0.map((s) => s.cnt))
  const mainSpan = Math.max(...stats0.map((s) => s.span))
  const mainMedH = median(stats0.flatMap((s) => Array(s.cnt).fill(s.medH)))
  bands = bands.filter((b, i) => {
    const s = stats0[i]
    const tooFew = s.cnt < Math.max(2, mainCnt * 0.25)          // 块数远少于主带
    const tooSmall = s.medH < mainMedH * 0.62                    // 块明显比转发器块矮
    const tooNarrow = s.span < mainSpan * 0.25                   // 挤在一角
    const drop = tooFew || tooSmall || tooNarrow
    if (drop) warnings.push(`忽略疑似图例区（y≈${Math.round(b.y0)}，${s.cnt} 块）`)
    return !drop
  })
  if (!bands.length) return { plan: newPlan(), upScale, overlay: { blocks: withCy, texts: [], rows, bands: [] }, stats: { blocks: blocks.length, upScale }, warnings: [...warnings, '色块未能聚成有效频带'] }

  // ④ 文本：墨迹连通域先按「行」聚，再把同一行内水平邻近的字符聚成串
  const inkComps = components(ink, w, h, 0.12, 3)
    .filter((c) => c.h < medH * 1.8 && c.w < w * 0.35 && c.h > 2)     // 排除长横线/竖线
  const textLines = []
  for (const g of cluster1d(inkComps, (c) => (c.y0 + c.y1) / 2, medH * 0.42)) {
    const sorted = g.sort((a, b) => a.x0 - b.x0)
    // ★ 断串阈值用【字高】而不是字宽：同一行的数字等高，但宽度天差地别——小数点 2 px、
    //   「1」比「0」窄一半，宽度中位数会被它们拉到 2~5 px，于是「13783.5」被切成
    //   「6」「83」「5」三段，整条标注就废了（实测过）。字高稳定，0.62 倍字高恰好落在
    //   「同一个数内的字距」与「两条标注之间的空当」之间。
    // 字高取【大字符的中位高】：小数点、断裂碎片的高度只有正常字的零头，直接取全体中位数
    // 会把 glyphH 拉到 3~5 px，gapLimit 随之塌成 3 px，于是处处误断。
    const maxH = Math.max(...sorted.map((c) => c.h))
    const tall = sorted.filter((c) => c.h >= maxH * 0.45)
    const glyphH = (tall.length ? median(tall.map((c) => c.h)) : maxH) || 8
    const gapLimit = Math.max(3, glyphH * 0.62)
    let cur = []
    const flush = () => {
      if (!cur.length) return
      textLines.push({
        x0: Math.min(...cur.map((c) => c.x0)), x1: Math.max(...cur.map((c) => c.x1)),
        y0: Math.min(...cur.map((c) => c.y0)), y1: Math.max(...cur.map((c) => c.y1))
      })
      cur = []
    }
    for (const c of sorted) {
      // 与「已收进本串的最右边界」比，不与上一个连通域比：字符可能有包含关系（如带点的字），
      // 只看上一个会在包含处误断
      const right = cur.length ? Math.max(...cur.map((k) => k.x1)) : -Infinity
      if (cur.length && c.x0 - right > gapLimit) flush()
      cur.push(c)
    }
    flush()
  }

  // ⑤ OCR：逐串识别（对每串裁一块 ink 子图送 OCR）
  const texts = []
  for (const t of textLines) {
    const pad = 1
    const bx0 = Math.max(0, t.x0 - pad), by0 = Math.max(0, t.y0 - pad)
    const bx1 = Math.min(w - 1, t.x1 + pad), by1 = Math.min(h - 1, t.y1 + pad)
    const sw = bx1 - bx0 + 1, sh = by1 - by0 + 1
    if (sw < 2 || sh < 3) continue
    const sub = new Float32Array(sw * sh)
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) sub[y * sw + x] = ink[(by0 + y) * w + (bx0 + x)]
    const r = recognizeLine(sub, sw, sh)
    if (!r.text) continue
    texts.push({ ...t, cx: (t.x0 + t.x1) / 2, cy: (t.y0 + t.y1) / 2, text: r.text, conf: r.conf, glyphs: r.glyphs })
  }

  // ⑤b ★ 块内编号：单独走一遍局部二值化，不吃全局 ink mask。
  //    真实图上编号常常是【白字画在深色块上】（中星 Ku 蓝块白字），全局 ink 只认暗像素，
  //    整批编号会凭空消失。改为在块内按「与块主色的色差」取字：白字黑字一视同仁。
  for (const blk of withCy) {
    const inset = Math.max(2, Math.round(Math.min(blk.w, blk.h) * 0.12))   // 内缩避开描边
    const bx0 = blk.x0 + inset, bx1 = blk.x1 - inset
    const by0 = blk.y0 + inset, by1 = blk.y1 - inset
    const sw = bx1 - bx0 + 1, sh = by1 - by0 + 1
    if (sw < 6 || sh < 6) continue
    const sub = new Float32Array(sw * sh)
    let ink2 = 0
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const p = (by0 + y) * w + (bx0 + x)
        const d = colorDist([rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]], blk.color) / 160
        const v = d > 0.55 ? Math.min(1, (d - 0.55) / 0.45) : 0
        sub[y * sw + x] = v
        if (v > 0.4) ink2++
      }
    }
    // 墨迹占比过高 = 块内不是文字而是渐变/花纹，别硬认
    if (ink2 < 4 || ink2 > sw * sh * 0.55) continue
    const r = recognizeLine(sub, sw, sh)
    if (r.text) { blk.labelText = r.text; blk.labelConf = r.conf }
  }

  // ⑥ 文本归属。三类：块内编号（已在 ⑤b 单独处理）· 频率标注 · 自由文本（标题/极化/图例注记）。
  //    ★ 归属必须收紧：早先「x 重叠允许负容差 + 不校验能否解析成数字」会把 UPLINK / DOWNLINK /
  //      极化字母一并认成频率标注，识别出的 "II"（V 的误读）还会被 textToNumber 变成 11 污染标度。
  const blkMinX = Math.min(...withCy.map((b) => b.x0))
  const blkMaxX = Math.max(...withCy.map((b) => b.x1))
  for (const t of texts) {
    // 落在色块群水平范围之外 → 一定不是频率标注（极化字母、频带标题都在左侧）
    if (t.x1 < blkMinX || t.x0 > blkMaxX) { t.role = 'free'; continue }
    const v = textToNumber(t.text)
    if (v == null) { t.role = 'free'; continue }        // 解析不出数就不是频率标注
    let best = null, bestScore = Infinity
    for (const b of withCy) {
      const ovl = Math.min(t.x1, b.x1) - Math.max(t.x0, b.x0)
      if (ovl <= 0) continue                            // 真重叠才算（标注在图上恒与其块居中对齐）
      const dy = t.cy < b.cy ? b.y0 - t.y1 : t.y0 - b.y1
      if (dy < 0 || dy > medH * 2.5) continue
      const s = dy - ovl * 0.35                         // 越近、重叠越多越优
      if (s < bestScore) { bestScore = s; best = b }
    }
    if (best) {
      t.role = 'freq'; t.blockId = best; t.side = t.cy < best.cy ? 'above' : 'below'; t.value = v
      if (best.freqText == null || t.conf > (best.freqConf || 0)) { best.freqText = t.text; best.freqValue = v; best.freqConf = t.conf }
    } else t.role = 'free'
  }

  // 极化字母：每个 row 左侧、主色块群之外的短文本（H/V/L/R 或 LHCP/RHCP）。
  // OCR 对孤立单字母常有形近误读（V→II/Y、H→FI），故按「含哪个字母」宽松匹配，取首个命中。
  for (const band of bands) {
    for (const row of band.rows) {
      const s = texts.filter((t) => t.role === 'free' && t.x1 < blkMinX && Math.abs(t.cy - row.cy) < medH * 1.1)
        .sort((a, b) => a.x0 - b.x0).map((t) => t.text.toUpperCase()).join('')
      if (!s) continue
      if (/LHCP/.test(s)) row.pol = 'L'
      else if (/RHCP/.test(s)) row.pol = 'R'
      else if (/^H/.test(s)) row.pol = 'H'
      else if (/^V/.test(s)) row.pol = 'V'
      else if (/^L/.test(s)) row.pol = 'L'
      else if (/^R/.test(s)) row.pol = 'R'
    }
  }

  // ⑦ ★ px → MHz 标度：每个频带独立拟合（上下行是两条不同的轴）
  //    用该带内所有「块中心 x ↔ 已识别频率」做最小二乘。识别错的点靠残差剔除后重拟合。
  for (const band of bands) {
    const pts = []
    for (const row of band.rows) for (const b of row.blocks) {
      if (Number.isFinite(b.freqValue)) pts.push({ x: b.cx, f: b.freqValue, b })
    }
    const blkW = median(band.rows.flatMap((r) => r.blocks.map((b) => b.w)))
    band.scale = fitScale(pts, blkW)
    if (!band.scale) warnings.push(`频带 #${band.index + 1} 未能拟合频率标度（有效标注 ${pts.length} 个，其中彼此一致的不足 3 个）— 该带频率需手工录入`)
    else if (band.scale.inliers != null && band.scale.inliers < band.scale.total) {
      warnings.push(`频带 #${band.index + 1} 频率标度由 ${band.scale.inliers}/${band.scale.total} 个一致的标注定出，其余按几何回代（已逐条标注来源）`)
    }
  }

  // 单位归一：图上 GHz/MHz 混排（12.77 与 14022 并存）。以拟合出的量程判断——
  // 若整带跨度 < 100 则必是 GHz（真实转发器带宽以 MHz 计，跨度不可能只有几十 MHz 却排下十几个转发器）
  for (const band of bands) {
    if (!band.scale) continue
    const span = Math.abs(band.scale.a) * (Math.max(...band.rows.flatMap((r) => r.blocks.map((b) => b.cx))) - Math.min(...band.rows.flatMap((r) => r.blocks.map((b) => b.cx))))
    band.unitMul = span > 0 && span < 100 ? 1000 : 1
  }

  // ⑦b ★ 分段标度：真实频率计划图里，一排常分成频率相距很远的两段（可动点波束 13.78 GHz
  //    那一簇 与 固定波束 14.02 GHz 那一簇；C 段的非洲波束段 与 东部波束段），图上两段之间
  //    的空当【不按频率比例画】——中间那 1 GHz 的空当被压缩成了一指宽。整带强行套一条线性标度，
  //    次要那一段必然被判成离群、几何回代给出错值。故：按 x 方向的大空当把带切成段，
  //    点数够的段各自拟合自己的标度；点数不够的段仍用整带标度（并因残差大而被标存疑，交人核对）。
  for (const band of bands) {
    const blks = band.rows.flatMap((r) => r.blocks).sort((p, q) => p.cx - q.cx)
    const medW = median(blks.map((b) => b.w)) || 20
    const segs = []
    for (const b of blks) {
      const last = segs[segs.length - 1]
      // 空当超过 2.5 个块宽 = 图上刻意留的分段间隔（相邻转发器之间只隔几个像素）
      if (last && b.x0 - last.maxX1 <= medW * 2.5) { last.blocks.push(b); last.maxX1 = Math.max(last.maxX1, b.x1) }
      else segs.push({ blocks: [b], maxX1: b.x1 })
    }
    band.segs = segs
    if (segs.length < 2) continue
    for (const seg of segs) {
      const pts = seg.blocks.filter((b) => Number.isFinite(b.freqValue)).map((b) => ({ x: b.cx, f: b.freqValue, b }))
      const s = pts.length >= 3 ? fitScale(pts, medW) : null
      if (s) {
        seg.scale = s
        for (const b of seg.blocks) b.segScale = s
      }
    }
    const segFitted = segs.filter((s) => s.scale).length
    if (segFitted > 0 && segFitted < segs.length) {
      warnings.push(`频带 #${band.index + 1} 分 ${segs.length} 段，其中 ${segFitted} 段各自定出了标度，其余段沿用整带标度 — 请重点核对`)
    } else if (segFitted === segs.length) {
      warnings.push(`频带 #${band.index + 1} 按 ${segs.length} 段分别拟合频率标度（图上分段处不按频率比例留空，整带套一条标度会算错）`)
    }
  }

  // ⑧ 标度回代：补全频率 + 由块宽算带宽（有段标度就用段的，否则用整带的）
  for (const band of bands) {
    if (!band.scale && !(band.segs || []).some((s) => s.scale)) continue
    for (const row of band.rows) {
      for (const blk of row.blocks) {
        const sc = blk.segScale || band.scale
        if (!sc) continue
        const { a, b: b0 } = sc
        const fGeom = (a * blk.cx + b0) * band.unitMul
        blk.freqGeom = fGeom
        blk.bwGeom = Math.abs(a) * blk.w * band.unitMul
        if (Number.isFinite(blk.freqValue)) {
          const fOcr = blk.freqValue * band.unitMul
          blk.freqDelta = fOcr - fGeom
          // 几何与 OCR 差得离谱 → OCR 那个数不可信，以几何为准并标存疑
          blk.freqSuspect = Math.abs(blk.freqDelta) > Math.max(blk.bwGeom * 0.75, 2)
          blk.freqFinal = blk.freqSuspect ? fGeom : fOcr
        } else {
          blk.freqFinal = fGeom
          blk.freqFromGeom = true
        }
      }
    }
  }

  // ⑨ 组装草稿
  const plan = assemblePlan(bands, texts, warnings)
  plan.source = { imageW: w, imageH: h, detectedAt: new Date().toISOString() }

  return {
    plan,
    // upScale：内部放大的倍率。叠加层要把这些坐标除以它才对得上原图（调用方据此换算）。
    upScale,
    overlay: { blocks: withCy, texts, rows, bands: bands.map((b) => ({ index: b.index, y0: b.y0, y1: b.y1, scale: b.scale, unitMul: b.unitMul, rows: b.rows.map((r) => ({ cy: r.cy, pol: r.pol, count: r.blocks.length })) })) },
    stats: {
      upScale,
      blocks: blocks.length, texts: texts.length, bands: bands.length,
      rows: bands.reduce((s, b) => s + b.rows.length, 0),
      ocrFreq: withCy.filter((b) => Number.isFinite(b.freqValue)).length,
      geomFilled: withCy.filter((b) => b.freqFromGeom).length,
      suspect: withCy.filter((b) => b.freqSuspect).length
    },
    warnings
  }
}

// px → MHz 标度 f = a·x + b。
//
// ★ 必须用 RANSAC，不能用「最小二乘 + 剔掉残差最大的 20%」：小字号图上 OCR 的错误率轻松过半
//   （小数点丢失把 14229.5 读成 142295、首位误读把 13846 读成 .3846），坏点是【多数】而非少数，
//   残差剔除在多数带错时会被坏点主导，拟出一条毫无意义的线（实测斜率几乎为 0，全图频率同一个值）。
//   RANSAC 反过来做：枚举点对定直线、数谁的支持者最多——只要有两个数读对，那条真线就会胜出。
//   这正是「OCR 只要对几个就行」这句承诺的兑现处。
function fitScale(pts, blockW) {
  if (pts.length < 2) return null
  const lsq = (ps) => {
    const n = ps.length
    let sx = 0, sf = 0, sxx = 0, sxf = 0
    for (const p of ps) { sx += p.x; sf += p.f; sxx += p.x * p.x; sxf += p.x * p.f }
    const den = n * sxx - sx * sx
    if (Math.abs(den) < 1e-9) return null
    const a = (n * sxf - sx * sf) / den
    return { a, b: (sf - a * sx) / n }
  }
  if (pts.length === 2) return lsq(pts)

  // 容差自洽：内点残差不得超过「半个色块宽对应的频率跨度」——比这更大就不是同一条标度上的点。
  // blockW 未给时退到相邻块的中位间距。
  const xs = pts.map((p) => p.x).sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 1) gaps.push(xs[i] - xs[i - 1])
  const wRef = blockW || (gaps.length ? median(gaps) : 20)

  // ★ 物理先验：光靠「内点最多」判不出真假——坏点也会碰巧三三两两共线（实测选中过一条
  //   由 4 个错值凑出的假线）。真标度必须同时满足三条硬约束，任一不过直接弃：
  //     ① 频率随 x 递增（图上频率永远从左往右增大）；
  //     ② 回代到整带 x 范围的频率全部落在卫星频段内（1~60 GHz）；
  //     ③ 中位块宽 × 斜率 = 转发器带宽，必须落在工程合理区间（0.5~500 MHz）。
  //   ③ 尤其致命：假线给出的「带宽」动辄几千 MHz 或零点几 MHz，一眼就露馅。
  const xMin = Math.min(...pts.map((p) => p.x)), xMax = Math.max(...pts.map((p) => p.x))
  const plausible = (a, b) => {
    if (!(a > 0)) return false
    const f1 = a * xMin + b, f2 = a * xMax + b
    if (f1 < 1000 || f2 > 60000) return false
    const bw = a * wRef
    return bw >= 0.5 && bw <= 500
  }

  let best = null
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x
      if (Math.abs(dx) < 1e-6) continue
      const a = (pts[j].f - pts[i].f) / dx
      if (!(Math.abs(a) > 1e-9)) continue          // 斜率为 0 的线（两点读到同一个数）无意义
      const b = pts[i].f - a * pts[i].x
      if (!plausible(a, b)) continue
      const tol = Math.abs(a) * wRef * 0.5
      const inl = pts.filter((p) => Math.abs(a * p.x + b - p.f) <= tol)
      const err = inl.reduce((s, p) => s + Math.abs(a * p.x + b - p.f), 0)
      // 支持者更多者胜；并列时取残差和更小的
      if (!best || inl.length > best.inl.length || (inl.length === best.inl.length && err < best.err)) {
        best = { a, b, inl, err }
      }
    }
  }
  // 两个一致的点就够定线（这正是「OCR 只要对几个就行」的下限）；一个都凑不出就判失败，
  // 宁可让人工补，也不给一条假标度——假标度会把整带频率静默改错，比空着危险得多。
  if (!best || best.inl.length < 2) return null
  const refined = lsq(best.inl) || { a: best.a, b: best.b }
  return { ...refined, inliers: best.inl.length, total: pts.length }
}

// 检测结果 → FrequencyPlan 草稿
function assemblePlan(bands, texts, warnings) {
  const plan = newPlan({ name: '导入的频率计划' })

  // 波束：按块主色聚类（同色 = 同波束）。图例文字暂不自动绑定——图例位置与写法太随意，
  // 留给校对界面让人一键改名，比猜错了再让人找出来强。
  const allBlocks = bands.flatMap((b) => b.rows.flatMap((r) => r.blocks))
  const palettes = []
  for (const blk of allBlocks) {
    let hit = palettes.find((p) => colorDist(p.color, blk.color) < 42)
    if (!hit) { hit = { color: blk.color.slice(), count: 0 }; palettes.push(hit) }
    hit.count++
    blk.paletteRef = hit
  }
  palettes.sort((a, b) => b.count - a.count)
  palettes.forEach((p, i) => {
    p.beam = newBeam({ name: `波束 ${i + 1}`, color: hex(p.color), code: String.fromCharCode(65 + i) })
    plan.beams.push(p.beam)
  })
  // 只有一种颜色时不建波束（整星单波束的图，建一个空壳反而碍事）
  if (plan.beams.length === 1) plan.beams = []

  // 上行带 = y 最小的那个带（标准图恒为 Uplink 在上）
  const upBand = bands[0]
  const dnBand = bands.length > 1 ? bands[1] : null
  if (bands.length > 2) warnings.push(`检出 ${bands.length} 个频带，仅前两个按上行/下行处理，其余需手工归并`)

  // 极化：行上没识别出字母时，按「同带内两行互为正交」补
  const fixPols = (band) => {
    if (!band) return
    const rs = band.rows
    if (rs.length === 2) {
      if (rs[0].pol && !rs[1].pol) rs[1].pol = POL_ORTHO[rs[0].pol] || 'V'
      else if (!rs[0].pol && rs[1].pol) rs[0].pol = POL_ORTHO[rs[1].pol] || 'H'
      else if (!rs[0].pol && !rs[1].pol) { rs[0].pol = 'H'; rs[1].pol = 'V' }
    } else for (const r of rs) if (!r.pol) r.pol = 'H'
  }
  fixPols(upBand); fixPols(dnBand)

  // 上行块 → 通道
  const chByNo = new Map()
  for (const row of upBand.rows) {
    for (const blk of row.blocks) {
      const noInfo = textToChannelNo(blk.labelText || '')
      const no = noInfo ? noInfo.no : ''
      const ch = newChannel({
        no,
        up: { fcMHz: round2(blk.freqFinal), bwMHz: round2(blk.bwGeom), pol: row.pol || 'H' },
        dn: { fcMHz: null, bwMHz: null, pol: POL_ORTHO[row.pol || 'H'] || 'V' },
        beamUpId: blk.paletteRef?.beam?.id && plan.beams.length ? blk.paletteRef.beam.id : ''
      })
      ch._px = { x0: blk.x0, x1: blk.x1, cy: blk.cy }
      ch._suspect = !!blk.freqSuspect
      ch._geom = !!blk.freqFromGeom
      ch._labelConf = blk.labelConf ?? 0
      plan.channels.push(ch)
      if (no) chByNo.set(no, ch)
    }
  }

  // 下行块 → 与上行按编号配对，反推 LO
  const loSamples = []
  const dnUnmatched = []
  if (dnBand) {
    for (const row of dnBand.rows) {
      for (const blk of row.blocks) {
        const noInfo = textToChannelNo(blk.labelText || '')
        const no = noInfo ? noInfo.no : ''
        const ch = no ? chByNo.get(no) : null
        if (ch && Number.isFinite(ch.up.fcMHz) && Number.isFinite(blk.freqFinal)) {
          ch.dn.pol = row.pol || ch.dn.pol
          loSamples.push({ ch, delta: ch.up.fcMHz - blk.freqFinal, dnFc: blk.freqFinal })
        } else if (Number.isFinite(blk.freqFinal)) {
          dnUnmatched.push({ blk, no, pol: row.pol })
        }
      }
    }
  }

  // LO 反推：把 delta 聚类，每一簇 = 一个 LO（标准图上一张图常有 2~3 个 LO 分组）
  if (loSamples.length) {
    const clusters = []
    for (const s of loSamples.sort((a, b) => a.delta - b.delta)) {
      const last = clusters[clusters.length - 1]
      // 同一 LO 的 delta 只差在识别误差内。容差不能卡到 1 MHz：几何回代的频率带着像素量化
      // 误差（一个像素就是几 MHz），实测同一个 1750 会散成 1750/1758 两簇，被当成两个 LO。
      // 取 1% 或 10 MHz 的较大者——真实图上不同 LO 之间相差数百 MHz，绝无并错之虞。
      if (last && Math.abs(s.delta - last.mean) < Math.max(10, Math.abs(last.mean) * 0.01)) {
        last.items.push(s)
        last.mean = last.items.reduce((t, x) => t + x.delta, 0) / last.items.length
      } else clusters.push({ mean: s.delta, items: [s] })
    }
    clusters.sort((a, b) => b.items.length - a.items.length)
    clusters.forEach((c, i) => {
      // LO 值取簇内中位数并圆整到 0.5 MHz——真实 LO 都是整齐数（1750/2225/2320/3300…），
      // 圆整能把识别误差的零头抹掉，避免出现 2319.87 这种假精度
      const v = Math.round(median(c.items.map((x) => x.delta)) * 2) / 2
      const lo = newLo({ name: clusters.length > 1 ? `LO${i + 1}` : 'LO', valueMHz: v })
      plan.los.push(lo)
      for (const it of c.items) it.ch.loId = lo.id
    })
    // ★ LO 继承：只要有一个转发器的下行块没配上（编号识别失败是常事），它就拿不到 loId，
    //   下行也就推不出来。而同一段内相邻的转发器几乎必然共用一个 LO（LO 是按频段分组的，
    //   不会挨着两个转发器就换一个）。故给空 loId 的通道补上频率最近邻的那个 loId。
    const known = plan.channels.filter((c) => c.loId && Number.isFinite(c.up.fcMHz))
    if (known.length) {
      let inherited = 0
      for (const c of plan.channels) {
        if (c.loId || !Number.isFinite(c.up.fcMHz)) continue
        let best = null, bd = Infinity
        for (const k of known) {
          const d = Math.abs(k.up.fcMHz - c.up.fcMHz)
          if (d < bd) { bd = d; best = k }
        }
        // 只在「确实挨着」时继承：隔了半个 GHz 那多半是另一段、另一个 LO，宁可留空让人填
        if (best && bd < 600) { c.loId = best.loId; inherited++ }
      }
      if (inherited) warnings.push(`${inherited} 个转发器的下行未配上，其 LO 按频率最近邻继承（推算出的下行请核对）`)
    }
  } else if (dnBand) {
    warnings.push('下行块未能与上行按编号配对 — LO 需手工填写')
  }

  // 下行有、上行没配上的块：作为显式下行（cross-strap 或编号识别失败）附到最近的空位通道，
  // 拿不准就单独建一条只有下行的通道，绝不硬塞给某个上行通道。
  for (const u of dnUnmatched) {
    plan.channels.push(newChannel({
      no: u.no || '',
      kind: 'transponder',
      up: { fcMHz: null, bwMHz: round2(u.blk.bwGeom), pol: 'H' },
      dn: { fcMHz: round2(u.blk.freqFinal), bwMHz: round2(u.blk.bwGeom), pol: u.pol || 'V' },
      note: '仅识别到下行 — 上行待补'
    }))
  }
  if (dnUnmatched.length) warnings.push(`${dnUnmatched.length} 个下行块未配上上行（已单列为只有下行的通道）`)

  // 等差校验：★ 按【排 × 段】做，不能按整排做。
  //   一排里分几段是常态（可动点波束 S1~S4 步进 62.5，固定波束 C1~C6 步进 41.5，两段还隔着空当），
  //   整排一起看必然「不成等差」——那是版式使然，不是识别错，每张图都报一次就成了狼来了。
  //   段内才是真正应当等差的单元。
  for (const row of upBand.rows) {
    const bySeg = new Map()
    for (const b of row.blocks) {
      if (!Number.isFinite(b.freqFinal)) continue
      const segIdx = (upBand.segs || []).findIndex((s) => s.blocks.includes(b))
      const k = segIdx < 0 ? 0 : segIdx
      if (!bySeg.has(k)) bySeg.set(k, [])
      bySeg.get(k).push(b.freqFinal)
    }
    for (const [k, fs] of bySeg) {
      if (fs.length < 4) continue
      const ar = inferArithmetic(fs)
      const conform = (fs.length - 1 - ar.outliers.length) / (fs.length - 1)
      if (!ar.ok && conform < 0.7) {
        // 措辞保持中性：一段里连排两种带宽的转发器（54 MHz 的点波束接 36 MHz 的固定波束）
        // 是正常版式，此时这条提示只是「这里有两组，顺带看一眼」，不是在断言识别错了。
        warnings.push(`第 ${row.index + 1} 排第 ${k + 1} 段频率间距不一致（主步进约 ${ar.step != null ? ar.step.toFixed(2) : '—'} MHz，占 ${Math.round(conform * 100)}%）— 若该段本就含多种带宽属正常，否则请核对`)
      }
    }
  }

  plan.channels.sort((a, b) => (a.up.fcMHz ?? a.dn.fcMHz ?? 0) - (b.up.fcMHz ?? b.dn.fcMHz ?? 0))
  // 频段名按上行频率猜（只是个默认值，界面上可改）
  const f0 = plan.channels.find((c) => Number.isFinite(c.up.fcMHz))?.up.fcMHz
  if (Number.isFinite(f0)) plan.band = guessBand(f0)
  return plan
}

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)

// 频段猜测：按卫星固定业务的实际划分，不按「S 段是 2~4 GHz」这种泛频段定义——
// 3.4~4.2 GHz 是 C 段下行而非 S 段，边界卡在 3 GHz 上。只是个默认值，界面上可改。
export function guessBand(fMHz) {
  const f = Number(fMHz)
  if (!Number.isFinite(f)) return 'Ku'
  if (f < 2000) return 'L'
  if (f < 3000) return 'S'          // S 段：上行 2.025~2.11、下行 2.2~2.29 GHz
  if (f < 5000) return 'C'          // C 段下行 3.4~4.2 GHz
  if (f < 7100) return 'C'          // C 段上行 5.85~6.725 GHz
  if (f < 9000) return 'X'
  if (f < 15500) return 'Ku'        // Ku 下行 10.7~12.75 / 上行 12.75~14.5 GHz
  if (f < 40000) return 'Ka'        // Ka 下行 17.7~21.2 / 上行 27.5~31 GHz
  if (f < 50000) return 'Q'
  return 'V'
}

// 供校对界面：把某个通道的像素位置映回原图，用来高亮「这一条对应图上哪个框」
export const channelPixelBox = (ch) => ch?._px || null
