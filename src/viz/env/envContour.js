// 环境场等值线 —— 在已取回的栅格上直接提线（marching squares），输出经纬折线。
//
// 复用 shared/lbContour.js 那套（链路预算设计空间图用的同一份）：块裁剪提线 → 按格边号拼接 →
// Douglas–Peucker 抽稀。不做双三次细化：环境场的栅格本来就有 1440×720 这个量级，
// 细化只会让点数翻四倍而线形不变；链路预算那边要细化是因为它的场只有 21×21 格。
//
// 坐标约定与栅格一致：行 0 = 北。故网格 j 轴朝南，映射 j → lat = latMax − (j+0.5)·dLat
// 天然把上下翻回来，不必额外翻转。
//
// 无 DOM 无 Vue，纯几何，便于单测。

import { buildBlocks, contourSegments, stitchSegments, simplifyDP, contourLevels } from '../../shared/lbContour.js'

const MAX_LEVELS = 24   // 再多就糊成一片，读不出线

/** 定级：给了 step 就按 step 的整数倍，否则按 count 自动挑「好看的整数级差」 */
export function levelsFor(min, max, step, count) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return []
  if (Number.isFinite(step) && step > 0) {
    const k0 = Math.ceil(min / step), k1 = Math.floor(max / step)
    const out = []
    for (let k = k0; k <= k1 && out.length < MAX_LEVELS; k++) out.push(Math.round(k * step * 1e9) / 1e9)
    return out
  }
  return contourLevels(min, max, 0, count || 8).levels.slice(0, MAX_LEVELS)
}

/**
 * 提取等值线。
 * @param {object} field  sampleEnvField 的产物（values/nx/ny/bbox）
 * @param {object} o      { step 级差 | count 自动定级条数 | lo,hi 只在此区间内定级（跟随当前值域）
 *                          | tol 抽稀容差（格） }
 * @returns {Array<{ level:number, lines:Array<Array<[lon,lat]>> }>}
 */
export function buildContours(field, o) {
  const opt = o || {}
  if (!field || !field.values || !(field.nx > 1) || !(field.ny > 1)) return []
  const z = field.values, nx = field.nx, ny = field.ny
  const st = field.stats
  const lo = Number.isFinite(opt.lo) ? opt.lo : (st ? st.min : NaN)
  const hi = Number.isFinite(opt.hi) ? opt.hi : (st ? st.max : NaN)
  const levels = levelsFor(lo, hi, opt.step, opt.count)
  if (!levels.length) return []

  const bb = field.bbox
  const dLon = (bb.lonMax - bb.lonMin) / nx, dLat = (bb.latMax - bb.latMin) / ny
  const toLL = (gi, gj) => [bb.lonMin + (gi + 0.5) * dLon, bb.latMax - (gj + 0.5) * dLat]
  const tol = Number.isFinite(opt.tol) ? opt.tol : 0.35   // 格为单位：亚格抽稀，线形不变、点数掉一大半

  const blocks = buildBlocks(z, nx, ny)
  const out = []
  for (const level of levels) {
    const segs = contourSegments(z, nx, ny, level, blocks)
    if (!segs.length) continue
    const lines = []
    for (const ln of stitchSegments(segs)) {
      const s = tol > 0 ? simplifyDP(ln, tol) : ln
      if (s.length < 2) continue
      const pts = new Array(s.length)
      for (let i = 0; i < s.length; i++) pts[i] = toLL(s[i][0], s[i][1])
      lines.push(pts)
    }
    if (lines.length) out.push({ level, lines })
  }
  return out
}

/**
 * 沿线找标注点（经纬空间做弧长均分，故 gap/minLen 的单位是度）。
 * 返回 [{ lon, lat, a }]，a = 线的方位角（度，屏幕坐标系下的倾角），渲染层据此转字。
 */
export function labelPoints(lines, opt) {
  const o = opt || {}
  const minLen = o.minLen > 0 ? o.minLen : 25      // 短于 25° 的碎线不标
  const gap = o.gap > 0 ? o.gap : 70               // 同一条线上两个标注至少隔 70°
  const maxN = o.max > 0 ? o.max : 3
  const prep = []
  for (const ln of (lines || [])) {
    if (!ln || ln.length < 2) continue
    let L = 0
    const cum = new Float64Array(ln.length)
    for (let i = 1; i < ln.length; i++) {
      const dx = ln[i][0] - ln[i - 1][0], dy = ln[i][1] - ln[i - 1][1]
      if (Math.abs(dx) > 180) { cum[i] = cum[i - 1]; continue }   // 跨接缝的一步不计长
      L += Math.hypot(dx, dy); cum[i] = L
    }
    if (L >= minLen) prep.push({ p: ln, cum, L })
  }
  prep.sort((a, b) => b.L - a.L)   // 长线优先：名额有限时给贯穿全图的主线
  const out = []
  for (const s of prep) {
    if (out.length >= maxN) break
    const n = Math.max(1, Math.min(3, Math.floor(s.L / gap) + 1))
    for (let k = 0; k < n && out.length < maxN; k++) {
      const t = s.L * (k + 0.5) / n
      let i = 1
      while (i < s.cum.length - 1 && s.cum[i] < t) i++
      const seg = s.cum[i] - s.cum[i - 1]
      const f = seg > 1e-9 ? (t - s.cum[i - 1]) / seg : 0
      const a0 = s.p[i - 1], a1 = s.p[i]
      if (Math.abs(a1[0] - a0[0]) > 180) continue
      const lon = a0[0] + (a1[0] - a0[0]) * f, lat = a0[1] + (a1[1] - a0[1]) * f
      // 切向取前后各一段弦（相邻两点常常只隔亚格，用它定角会被采样抖动带得乱转）
      const j0 = Math.max(0, i - 4), j1 = Math.min(s.p.length - 1, i + 3)
      const dx = s.p[j1][0] - s.p[j0][0], dy = s.p[j0][1] - s.p[j1][1]   // 屏幕 y 向下 → 纬度取反
      let a = Math.abs(dx) > 180 ? 0 : Math.atan2(dy, dx) * 180 / Math.PI
      if (a > 90) a -= 180; else if (a < -90) a += 180                    // 字不倒着写
      out.push({ lon, lat, a })
    }
  }
  return out
}
