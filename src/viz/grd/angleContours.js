import { A, B, rayEllipsoid } from '../wgs84.js'
import { losBlocked, projectDir } from './shellProj.js'
import { stitchLoops } from './coverage.js'
import { labelGroup, labelPath } from './contourLabels.js'

const RAD = Math.PI / 180
const geometryCache = new WeakMap()

// Keep the last geometry for each line and shell branch. Style changes reuse
// the same segments, while moving satellites replace the previous time step.
export function contourSegmentsFor(line, surface, branch, params, build) {
  let surfaces = geometryCache.get(line)
  if (!surfaces) geometryCache.set(line, surfaces = new WeakMap())
  let branches = surfaces.get(surface)
  if (!branches) surfaces.set(surface, branches = new Map())
  const last = branches.get(branch)
  if (last && params.length === last.params.length && params.every((v, i) => v === last.params[i])) return last.segments
  const segments = build()
  branches.set(branch, { params, segments })
  return segments
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = a => { const r = Math.hypot(...a); return a.map(v => v / r) }
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
const direction = (s, p) => unit(p.map((v, i) => v - s[i]))
const lonLat = (p, ground = false) => [Math.atan2(p[1], p[0]) / RAD,
  Math.atan2(p[2] * (ground ? A*A/(B*B) : 1), Math.hypot(p[0], p[1])) / RAD]

function circle(axis, axial, radial, toward) {
  // Start at the meridian facing the other cone. For a spherical shell the
  // closest points on both rims then occur at t=0, even for a sub-sample arc.
  const lateral = toward && cross(axis, toward)
  const x = lateral && Math.hypot(...lateral) > 1e-12
    ? unit(cross(lateral, axis))
    : unit(cross(Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], axis))
  const y = cross(axis, x)
  return t => {
    const c = radial * Math.cos(t), s = radial * Math.sin(t)
    return axis.map((z, i) => axial*z + c*x[i] + s*y[i])
  }
}

// On the scaled unit sphere the tangent points satisfy Q·S = 1.
function limb(S, a, b, toward) {
  const scaled = [S[0]/a, S[1]/a, S[2]/b]
  const h = 1 / Math.hypot(...scaled)
  if (h >= 1) return null
  const at = circle(unit(scaled), h, Math.sqrt(1 - h*h), toward)
  return t => { const [x, y, z] = at(t); return [x*a, y*a, z*b] }
}

// Clip each parametric arc before converting to segments. Refine at visibility
// crossings and where the projection stretches near tangency.
function trace(out, sample, radius) {
  function at(t) {
    const ll = sample(t)
    if (!ll) return null
    const lon = ll[0]*RAD, lat = ll[1]*RAD, c = Math.cos(lat)
    return { ll, xyz: [c*Math.cos(lon), c*Math.sin(lon), Math.sin(lat)] }
  }
  function edge(t, p, u, q, depth) {
    const mid = (t+u)/2, m = at(mid)
    if (!p && !q && !m) return
    // Measure midpoint error in km in the rendered sphere, including longitude seams and poles.
    const error = p && q && m ? radius * Math.hypot(...m.xyz.map((v,i) => v-(p.xyz[i]+q.xyz[i])/2)) : Infinity
    if (depth < 26 && error > 0.02) {
      edge(t, p, mid, m, depth+1)
      edge(mid, m, u, q, depth+1)
    } else if (p && q && m) out.push([p.ll, q.ll])
  }
  const first = at(0)
  let prev = first
  for (let i = 1; i <= 360; i++) {
    const next = i === 360 ? first : at(i*RAD)
    edge((i-1)*RAD, prev, i*RAD, next, 0)
    prev = next
  }
}

function groundHit(S, d) {
  const hit = rayEllipsoid(S, d)
  return hit && lonLat(hit, true)
}

function visibleHit(g, d, branch, hEx) {
  const hit = projectDir(g, d, branch)
  return hit && !losBlocked(g.S, hit.ecef, hEx) ? [hit.lon, hit.lat] : null
}

export function beamContour(basis, fullAngle, g = null, branch = 'near', hEx = 0) {
  const out = []
  if (!(fullAngle > 0 && fullAngle <= 180)) return out
  const { S, z } = basis, half = fullAngle*RAD/2, limit = Math.cos(half)
  const externalShell = g && !g.inside
  const rim = circle(z, limit, Math.sin(half), externalShell && unit(S).map(v => -v))
  const radius = g ? g.R : A
  trace(out, t => g ? visibleHit(g, rim(t), branch, hEx) : groundHit(S, rim(t)), radius)

  // Complete the footprint with the illuminated part of the apparent limb.
  // A wide cone can contain the entire disk even when none of its rim hits.
  const surfaceLimb = limb(S, g ? g.R : A, g ? g.R : B, externalShell && z)
  if (surfaceLimb) trace(out, t => {
    const p = surfaceLimb(t)
    if (dot(direction(S,p), z) < limit || (g && losBlocked(S,p,hEx))) return null
    return lonLat(p, !g)
  }, radius)
  if (g && (g.inside || branch === 'far')) {
    const shadow = limb(S, A+hEx, B+hEx)
    if (shadow) trace(out, t => {
      const tangent = shadow(t), d = direction(S, tangent)
      if (dot(d, z) < limit) return null
      const hit = projectDir(g, d, branch)
      if (!hit || hit.t < Math.hypot(...tangent.map((v,i) => v-S[i]))) return null
      return [hit.lon, hit.lat]
    }, radius)
  }
  return out
}

export function elevationContour(g, elevation, observer, branch, hEx = 0) {
  const out = []
  if (!(elevation > -90 && elevation < 90)) return out
  const e = elevation*RAD, up = unit(g.S)
  if (observer === 'satellite') {
    const rim = circle(up, Math.sin(e), Math.cos(e))
    trace(out, t => visibleHit(g, rim(t), branch, hEx), g.R)
    return out
  }
  // From a shell point, cos(central angle + elevation) = R cos(elevation) / |S|.
  // At negative elevations an outer shell can have two distinct rings.
  const k = g.R*Math.cos(e)/g.rS
  if (k > 1+1e-12 || (!g.inside && (branch === 'near' ? e < 0 : e > 0))) return out
  const root = Math.acos(Math.min(1, k))
  for (const rho of new Set([root-e, -root-e])) {
    if (rho <= 1e-12 || rho >= Math.PI) continue
    const ring = circle(up, g.R*Math.cos(rho), g.R*Math.sin(rho))
    trace(out, t => { const p = ring(t); return losBlocked(g.S,p,hEx) ? null : lonLat(p) }, g.R)
  }
  return out
}

export function newAngleLine(lines, kind, view = 'ground') {
  const elev = kind === 'elevation'
  return { angle: Math.min(elev ? 85 : 180, (elev ? 10 : 5)*(lines.length+1)), name: '', show: true,
    color: view === 'shell' ? '#ffffff' : '#000000', width: 0.7, dash: 'solid', opacity: 1,
    labels: true, labelMode: 'cardinal', labelSize: 14, labelColor: '#ffffff', labelBold: false,
    ...(elev ? { shellIds: null, observer: 'shell', branch: 'inherit' } : {}) }
}

// Work in the local tangent frame so that the east/west anchors remain on
// opposite sides even when the contour straddles the antimeridian.
export function angleLabelAnchors(segs, mode, positions, commit) {
  if (!segs.length) return []
  const points = segs.map(([start]) => start)
  const xyz = points.map(([lon, lat]) => {
    const c = Math.cos(lat * RAD)
    return [c * Math.cos(lon * RAD), c * Math.sin(lon * RAD), Math.sin(lat * RAD)]
  })
  const center = xyz.reduce((sum, p) => sum.map((v, i) => v + p[i]), [0, 0, 0])
  const lon = Math.hypot(center[0], center[1]) < 1e-10 ? 0 : Math.atan2(center[1], center[0])
  const lat = Math.atan2(center[2], Math.hypot(center[0], center[1]))
  const north = [-Math.sin(lat)*Math.cos(lon), -Math.sin(lat)*Math.sin(lon), Math.cos(lat)]
  const east = [-Math.sin(lon), Math.cos(lon), 0]
  const axes = mode === 'single' ? [['single', north, 1]] :
    [['north', north, 1], ['east', east, 1], ['south', north, -1], ['west', east, -1]]
  const used = new Set()
  // A clipped contour may contain several arcs. Keep each anchor on its own arc.
  const locations = new Map()
  const key = p => Math.round(p[0] * 20000) + ',' + Math.round(p[1] * 20000)
  for (const loop of stitchLoops(segs)) {
    const path = labelPath(loop)
    loop.forEach((p, i) => locations.set(key(p), { path, base: path.fractions[i] }))
  }
  const seeds = axes.slice(0, points.length).map(([slot, axis, sign]) => {
    let index = 0, best = -Infinity
    for (let i = 0; i < xyz.length; i++) {
      const score = sign * dot(axis, xyz[i])
      if (!used.has(i) && score > best) { best = score; index = i }
    }
    used.add(index)
    const t = positions?.[slot]
    if (Number.isFinite(t)) index = Math.round(Math.max(0, Math.min(1, t)) * (points.length - 1))
    return locations.get(key(points[index]))
  })
  const slot = mode === 'single' ? 'singleOffset' : 'cardinalOffset'
  return labelGroup(seeds, positions?.[slot], offset => commit(slot, offset))
}

export function angleLayer(id, line, segs, R) {
  const group = { segs, width: line.width, color: line.color, dash: line.dash }
  const layer = { id, R, angleContour: true, lineAlpha: line.opacity, segGroups: [group] }
  if (line.labels && segs.length) {
    group.txt = line.angle + '°'
    group.anchors = angleLabelAnchors(segs, line.labelMode, line.labelPositions?.[id], (slot, t) => {
      line.labelPositions = { ...line.labelPositions, [id]: { ...line.labelPositions?.[id], [slot]: t } }
    })
    group.labels = group.anchors.map(a => a.point)
    layer.angleLabel = { size: line.labelSize, bold: line.labelBold, color: line.labelColor }
  }
  return layer
}
