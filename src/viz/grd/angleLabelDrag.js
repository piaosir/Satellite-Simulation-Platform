// Project the contour at its label's rendered altitude. Ground picking would
// put shell labels on a different ring or miss them outside the Earth's limb.
export function startAngleLabelDrag(event, targets, onClick) {
  let hit = null, distance = Infinity
  for (const target of targets) {
    const p = target.project(target.anchor.point)
    if (!p) continue
    const dx = Math.abs(p.x - event.clientX), dy = Math.abs(p.y - event.clientY)
    // Match the footprint of the displayed text, with a small grab area for tiny labels.
    if (dx > Math.max(12, target.width / 2 + 3) || dy > Math.max(12, target.height / 2 + 3)) continue
    const d = dx * dx + dy * dy
    if (d <= distance) { distance = d; hit = target }
  }
  if (!hit) return

  const { path, base, group } = hit.anchor
  const members = targets.filter(t => t.anchor.group === group)
  const pixels = path.points.map(hit.project)
  const origin = hit.project(hit.anchor.point)
  const stage = event.currentTarget, id = event.pointerId
  let current = group.offset
  let dragged = false
  function preview(offset) {
    current = offset
    for (const { anchor, preview } of members) preview(anchor.path.pointAt(anchor.base + current))
  }
  function move(e) {
    if (e.pointerId !== id) return
    e.stopPropagation()
    if (onClick && !dragged) {
      if (Math.abs(e.clientX - event.clientX) + Math.abs(e.clientY - event.clientY) <= 6) return
      dragged = true
    }
    const x = origin.x + e.clientX - event.clientX, y = origin.y + e.clientY - event.clientY
    if (x === origin.x && y === origin.y) { if (current !== group.offset) preview(group.offset); return }
    let best = Infinity, nearest = base + current
    for (let i = 1; i < pixels.length; i++) {
      const a = pixels[i - 1], b = pixels[i]
      if (!a && !b) continue
      let f
      if (!a) f = 1
      else if (!b) f = 0
      else {
        const dx = b.x - a.x, dy = b.y - a.y
        f = Math.max(0, Math.min(1, ((x-a.x)*dx + (y-a.y)*dy) / (dx*dx + dy*dy || 1)))
      }
      const p = f === 0 ? a : f === 1 ? b : { x: a.x + (b.x-a.x)*f, y: a.y + (b.y-a.y)*f }
      if ((p.x-x)**2 + (p.y-y)**2 >= best) continue
      const t = path.fractions[i-1] + (path.fractions[i] - path.fractions[i-1])*f
      // Reproject interpolated points so a map seam cannot create a draggable chord across the map.
      const actual = f === 0 || f === 1 ? p : hit.project(path.pointAt(t))
      if (!actual) continue
      const d = (actual.x-x)**2 + (actual.y-y)**2
      if (d < best) { best = d; nearest = t }
    }
    let offset = nearest - base
    if (path.closed) offset += Math.round(current - offset)
    offset = group.limit(offset)
    if (offset !== current) preview(offset)
  }
  function finish(e) {
    if (e.pointerId !== id) return
    e.stopPropagation()
    if (e.type === 'pointerup') {
      move(e)
      if (current !== group.offset) group.save(current)
    } else if (current !== group.offset) preview(group.offset)
    stage.removeEventListener('pointermove', move, { capture: true })
    for (const type of endEvents) stage.removeEventListener(type, finish, { capture: true })
    if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id)
    if (e.type === 'pointerup' && !dragged && onClick) onClick(e)
  }
  const endEvents = ['pointerup', 'pointercancel', 'lostpointercapture']
  event.preventDefault()
  event.stopPropagation()
  stage.setPointerCapture(id)
  stage.addEventListener('pointermove', move, true)
  for (const type of endEvents) stage.addEventListener(type, finish, true)
}
