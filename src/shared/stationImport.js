import { pointFallbackName, stationFallbackName } from './markerNames.js'
import { byLang } from './i18n/lang.js'
import { trajWaypointInfo } from '../../packages/core/models/trajKinematics.mjs'
import { MARK_STYLE_DEF, restoreMarkerStyle, pointLegend, trackLegend } from '../viz/markers/markerLegend.js'

const list = value => Array.isArray(value) ? value : []
const present = value => value != null && String(value).trim() !== ''
const validLL = (lon, lat) => present(lon) && present(lat) && Math.abs(Number(lon)) <= 180 && Math.abs(Number(lat)) <= 90

export function stationSources(markers, polygons, settings) {
  const style = { ...MARK_STYLE_DEF }
  restoreMarkerStyle(style, settings || {})
  function sites(rows, station) {
    return list(rows).flatMap((row, i) => {
      if (!row || !validLL(row.lon, row.lat)) return []
      const fallback = station ? stationFallbackName(i) : pointFallbackName(i)
      const legend = station ? { type: 'station' } : pointLegend(style, row, i)
      return [{ ...row, id: row.id ?? i, seq: i + 1, name: String(row.name || '').trim() || fallback, ll: row.lon + '°, ' + row.lat + '°', legend }]
    })
  }
  function paths(rows, isPolygon) {
    return list(rows).flatMap((row, i) => {
      const pts = list(row?.pts)
      const n = pts.filter(p => isPolygon ? validLL(p?.[0], p?.[1]) : validLL(p?.lon, p?.lat)).length
      if (!n) return []
      const fallback = isPolygon ? 'Polygon' : byLang('航迹', 'Track')
      const legend = isPolygon ? { type: 'icon', icon: 'polygon', color: row.color } : trackLegend(style, row)
      return [{ ...row, id: row.id ?? i, name: String(row.name || '').trim() || fallback, n, legend }]
    })
  }
  return {
    pts: sites(markers?.points, false),
    sts: sites(markers?.stations, true),
    trajs: paths(markers?.trajectories, false),
    polygons: paths(Array.isArray(polygons) ? polygons : polygons?.polys, true)
  }
}

export function selectedSites(sources, selection) {
  const out = []
  for (const key of ['pts', 'sts', 'trajs', 'polygons']) {
    const ids = new Set(selection[key])
    for (const item of sources[key]) {
      if (!ids.has(item.id)) continue
      if (key === 'pts' || key === 'sts') { out.push(item); continue }
      const polygon = key === 'polygons'
      const heights = !polygon && item.kind === 'flight' ? trajWaypointInfo(item) : []
      item.pts.forEach((point, i) => {
        const lon = polygon ? point?.[0] : point?.lon
        const lat = polygon ? point?.[1] : point?.lat
        if (validLL(lon, lat)) out.push({ name: item.name + '#' + (i + 1), lon, lat, altM: heights[i]?.altM, legend: item.legend })
      })
    }
  }
  return out
}

// 预览与提交共用同一份行计划。仅当所有待写端都为空时才自动补行。
export function stationImportPlan(groups, stations, picks, mode, start) {
  const active = groups.filter(g => picks[g.kind]?.length)
  const count = Math.max(0, ...active.map(g => picks[g.kind].length))
  const mismatch = active.some(g => picks[g.kind].length > 1 && picks[g.kind].length !== count)
  const empty = []
  if (count && mode === 'fill') {
    stations.forEach((row, i) => {
      if (active.every(g => [g.name, g.lon, g.lat].every(key => !present(row[key])))) empty.push(i)
    })
  }
  const first = Math.max(0, Math.min(start ?? 0, Math.max(0, stations.length - 1)))
  const rows = Array.from({ length: count }, (_, i) => {
    const index = mode === 'current' ? first + i : (empty[i] ?? stations.length + i - empty.length)
    const sites = {}
    for (const g of active) {
      const side = picks[g.kind]
      sites[g.kind] = side[side.length === 1 ? 0 : i]
    }
    return { index, sites }
  })
  return { rows, mismatch }
}

export function editedSite(picked, patch, formatCoordinate, replacedByCity = false) {
  const site = { ...picked, ...patch }
  if ('name' in patch) delete site.en
  if (picked && (replacedByCity || ['lon', 'lat'].some(key => key in patch && formatCoordinate(patch[key]) !== formatCoordinate(picked[key])))) {
    const { name, en, lon, lat } = site
    return { name, en, lon, lat }
  }
  return site
}
