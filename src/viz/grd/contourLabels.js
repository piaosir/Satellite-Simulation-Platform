import { dLon, intervalFractions, loopTop, stitchLoops } from './coverage.js'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export function labelPath(points) {
  const ends = [0]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    ends.push(ends[i - 1] + Math.hypot(dLon(b[0], a[0]), b[1] - a[1]))
  }
  const length = ends.at(-1)
  const first = points[0], last = points.at(-1)
  const closed = Math.hypot(dLon(first[0], last[0]), first[1] - last[1]) < 1e-5
  const fractions = ends.map(v => length ? v / length : 0)
  function pointAt(t) {
    if (closed && (t < 0 || t >= 1)) t -= Math.floor(t)
    if (t <= 0 || !length) return first
    if (t >= 1) return last
    let lo = 0, hi = points.length - 1
    while (hi - lo > 1) {
      const mid = (hi + lo) >>> 1
      if (fractions[mid] < t) lo = mid
      else hi = mid
    }
    const a = points[lo], b = points[hi]
    if (Math.abs(t - fractions[hi]) < 1e-12) return b
    if (Math.abs(t - fractions[lo]) < 1e-12) return a
    const f = (t - fractions[lo]) / (fractions[hi] - fractions[lo])
    const lon = a[0] + dLon(b[0], a[0]) * f
    return [lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon, a[1] + (b[1] - a[1]) * f]
  }
  return { points, fractions, length, closed, pointAt }
}

// One offset per group. On clipped contours the first/last label limits travel for everyone.
export function labelGroup(seeds, storedOffset, save) {
  let lo = -Infinity, hi = Infinity
  for (const { path, base } of seeds) if (!path.closed) {
    lo = Math.max(lo, -base)
    hi = Math.min(hi, 1 - base)
  }
  const limit = v => clamp(v, lo, hi)
  const offset = limit(Number.isFinite(storedOffset) ? storedOffset : 0)
  const group = { offset, limit, save }
  return seeds.map(({ path, base }) => ({ path, base, group, point: path.pointAt(base + offset) }))
}

export function numericLabelGroup(segs, options, level, order, count, projection, save) {
  const txt = options.labelWithName && level.name ? level.lab + ' ' + level.name : level.name || String(level.lab)
  const anchors = []
  if (options.showVal) {
    const interval = options.labelMode === 'interval'
    const width = ((+options.valSize || 12) / 533) * (180 / Math.PI) * 0.62 * txt.length
    for (const [i, loop] of stitchLoops(segs).entries()) {
      if (loop.length < 4) continue
      const path = labelPath(loop)
      if (!path.length) continue
      const key = projection + '/' + i + '/' + (interval ? 'interval' : 'single')
      let bases
      if (interval) bases = intervalFractions(path.length, path.closed, width, options.labelGap)
      else if (Number.isFinite(level.labelT)) bases = [level.labelT]
      else bases = [count > 1 ? (order + 0.5) / count : path.fractions[loop.indexOf(loopTop(loop))]]
      anchors.push(...labelGroup(bases.map(base => ({ path, base })), level.labelOffsets?.[key], v => save(key, v)))
    }
  }
  return { txt, anchors, labels: anchors.map(a => a.point) }
}
