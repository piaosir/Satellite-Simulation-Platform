// Node metadata for report schedules. No topology image is generated here.
const S = (v) => v === null || v === undefined ? '' : String(v)
const numText = (v) => S(v).trim() && Number.isFinite(Number(v)) && Number(v) > 0 ? S(v) : ''
const kindOf = (kind) => kind === 'es' ? 'ground' : kind === 'regen' ? 'regen' : kind === 'txp' ? 'transparent' : kind
const spaceKind = (kind) => ['regen', 'transparent', 'satellite'].includes(kindOf(kind))
const nodeMetadata = (node, index, count) => {
  const kind = kindOf(node.kind) || 'satellite'
  const relay = kind === 'ground' && index > 0 && index < count - 1
  return { kind, name: S(node.name), ...(kind === 'ground' ? { role: relay ? 'relay' : index === 0 ? 'tx' : 'rx' } : {}),
    processing: kind === 'regen' || relay }
}

// A ground/space hop can retain an unused optical field after its endpoint is
// changed. Only the effective hop type decides which quantity is shown.
export function topologyEdgeFrequency(type, hop = {}) {
  const v = numText(type === 'laser' ? (hop.laser?.wavelengthNm ?? hop.wavelengthNm) : hop.frequency)
  return v ? v + (type === 'laser' ? ' nm' : ' GHz') : ''
}

// The result's segment boundaries identify regenerative nodes. Without a complete
// segmentation record the hop echo only proves that a node is a satellite.
function topologyFromHops(data) {
  const hops = Array.isArray(data?.hops) ? data.hops : []
  if (!hops.length) return null
  const segments = Array.isArray(data.segments) ? data.segments : []
  const indexes = segments.flatMap((segment) => Array.isArray(segment.hopIndexes) ? segment.hopIndexes : [])
  const segmented = indexes.length === hops.length && indexes.every((value, i) => value === i)
  const cuts = new Set(segmented ? segments.slice(1).map((segment) => segment.hopIndexes[0]) : [])
  const fromKind = (type) => type === 'up' || type === 'ground' ? 'ground' : 'satellite'
  const toKind = (type) => type === 'down' || type === 'ground' ? 'ground' : 'satellite'
  const raw = [{ kind: fromKind(hops[0].type), name: hops[0].fromName },
    ...hops.map((hop) => ({ kind: toKind(hop.type), name: hop.toName }))]
  const nodes = raw.map((node, i) => nodeMetadata({ ...node,
    kind: node.kind === 'ground' ? 'ground' : segmented ? (i === 0 || i === raw.length - 1 || cuts.has(i) ? 'regen' : 'transparent') : 'satellite'
  }, i, raw.length))
  const edges = hops.map((hop, i) => ({ type: hop.type || 'unknown',
    frequency: hop.type === 'laser' ? '' : numText(hop.frequencyResult) ? S(hop.frequencyResult) + ' GHz' : '',
    ...(!hop.type || hop.type === 'ground' || (hop.index != null && hop.index !== i) ? { invalid: true } : {}) }))
  return { nodes, edges }
}

// A successful report uses the chain that was actually submitted, including
// resolved library names and normalized numeric fields. Failed chains can show
// the configured route, explicitly marked as having no validated budget.
export function e2eReportTopology(row, snapshot, data, resolveSat = () => null) {
  const fromResult = data && !snapshot ? topologyFromHops(data) : null
  if (fromResult) return { topologyNodes: fromResult.nodes, topologyEdges: fromResult.edges, topologyConfiguredOnly: false }
  const actual = !!(data && snapshot)
  const source = actual ? snapshot : row || {}
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : []
  const topologyNodes = rawNodes.map((node, i) => {
    const entry = !actual && kindOf(node.kind) !== 'ground' ? resolveSat(node.satId) || {} : {}
    const name = node.name || entry.name || node.ov?.satelliteName || entry.form?.satelliteName || node.satelliteName || ''
    // The engine treats endpoint satellites as payload sources / demodulators.
    const kind = actual && (i === 0 || i === rawNodes.length - 1) && spaceKind(node.kind) ? 'regen' : node.kind
    return nodeMetadata({ kind, name }, i, rawNodes.length)
  })
  const topologyEdges = topologyNodes.slice(1).map((node, i) => {
    const hop = source.hops?.[i], a = topologyNodes[i]
    if (!hop) return { type: 'unknown', frequency: '', missing: true, invalid: true }
    const type = a.kind === 'ground' && node.kind === 'ground' ? 'ground'
      : a.kind === 'ground' && spaceKind(node.kind) ? 'up'
        : spaceKind(a.kind) && node.kind === 'ground' ? 'down'
          : spaceKind(a.kind) && spaceKind(node.kind) ? (hop.link === 'laser' ? 'laser' : 'isl') : 'unknown'
    const echo = actual ? data.hops?.[i] : null
    const frequency = type !== 'laser' && numText(echo?.frequencyResult)
      ? S(echo.frequencyResult) + ' GHz' : topologyEdgeFrequency(type, hop)
    return { type, frequency, ...(type === 'ground' || type === 'unknown' ? { invalid: true } : {}) }
  })
  return { topologyNodes, topologyEdges, topologyConfiguredOnly: !actual }
}

// Params are the per-link input snapshot, not a later live resource edit.
export function linkTopologyOf(link, orbitType, regenMode, params, lang = 'zh') {
  const en = lang === 'en', L = (zh, eng) => en ? eng : zh
  const p = params || {}, lp = p.linkParams || {}, sp = p.satParams || {}
  const label = (value, fallback) => S(value).trim() || fallback
  const ground = (name, role) => ({ kind: 'ground', name: label(name, L('地球站', 'Earth station')), role })
  const sat = (name, kind = 'satellite') => ({ kind, name: label(name, L('卫星', 'Satellite')) })
  let nodes = [], edges = []
  if (orbitType === 'E2E') {
    if (Array.isArray(link.topologyNodes) && link.topologyNodes.length > 1) {
      nodes = link.topologyNodes.map((n, i) => ({ ...nodeMetadata(n, i, link.topologyNodes.length),
        name: label(n.name, kindOf(n.kind) === 'ground' ? L('地球站', 'Earth station') : L('卫星', 'Satellite')) }))
      edges = nodes.slice(1).map((n, i) => {
        const edge = (link.topologyEdges || [])[i]
        return edge?.type ? { ...edge, frequency: edge.frequency || '' }
          : { type: 'unknown', frequency: '', missing: true, invalid: true }
      })
    } else {
      const topology = topologyFromHops(link.data)
      if (!topology) return null // Do not invent missing intermediate nodes.
      nodes = topology.nodes.map((n, i) => ({ ...n, name: label(n.name, i ? L('节点', 'Node') : L('起点', 'Source')) }))
      edges = topology.edges
    }
    return { nodes, edges, configuredOnly: link.topologyConfiguredOnly === true || !!link.error || !link.data }
  } else if (orbitType === 'REGEN') {
    const mode = regenMode || 'uplink'
    if (mode === 'uplink') nodes = [ground(link.txName, 'tx'), sat(link.rxName, 'regen')]
    else if (mode === 'downlink') nodes = [sat(link.txName, 'regen'), ground(link.rxName, 'rx')]
    else nodes = [sat(link.txName, 'regen'), sat(link.rxName, 'regen')]
    const d = link.data || {}
    const freq = mode === 'downlink' ? lp.rxCenterFrequency : mode === 'isl' ? (sp.islFreq || d.islRfFreqResult || link.topologyRfGHz) : lp.centerFrequency
    const wave = numText(d.laserWavelengthResult) || numText(link.topologyWaveNm) || numText(p.wavelengthNm)
    edges = [{ type: mode === 'laser' ? 'laser' : mode === 'isl' ? 'isl' : mode === 'downlink' ? 'down' : 'up', frequency: mode === 'laser' ? (wave ? wave + ' nm' : '') : numText(freq) ? S(freq) + ' GHz' : '' }]
  } else {
    nodes = [ground(link.txName, 'tx'), sat(link.satName || sp.satelliteName || (link.data || {}).satelliteNameResult, 'transparent'), ground(link.rxName, 'rx')]
    edges = [
      { type: 'up', frequency: numText(lp.centerFrequency) ? S(lp.centerFrequency) + ' GHz' : '' },
      { type: 'down', frequency: numText(lp.rxCenterFrequency) ? S(lp.rxCenterFrequency) + ' GHz' : '' }
    ]
  }
  return { nodes, edges }
}

