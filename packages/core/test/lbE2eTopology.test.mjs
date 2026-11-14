import assert from 'node:assert/strict'
import { e2eReportTopology, linkTopologyOf, topologyEdgeFrequency } from '../../../src/shared/lbReportTopology.js'

const freeze = (x) => { if (x && typeof x === 'object') { Object.freeze(x); Object.values(x).forEach(freeze) } return x }
const snapshot = freeze({
  nodes: [
    { kind: 'es', name: 'TX at computation' },
    { kind: 'txp', name: 'Transparent satellite' },
    { kind: 'regen', name: 'Regenerative satellite' },
    { kind: 'es', name: 'Ground relay' },
    { kind: 'regen', name: 'Optical transmitter' },
    { kind: 'regen', name: 'Optical receiver' },
    { kind: 'es', name: 'RX at computation' }
  ],
  hops: [
    { frequency: '14.25' }, { frequency: '23' }, { frequency: '12.5' },
    { frequency: '30' }, { link: 'laser', laser: { wavelengthNm: '1064' }, frequency: 'STORED_UNUSED_RF' },
    { frequency: '20' }
  ]
})
const types = ['up', 'isl', 'down', 'up', 'laser', 'down']
const data = freeze({ hops: types.map((type, i) => ({ index: i, type, fromName: snapshot.nodes[i].name,
  toName: snapshot.nodes[i + 1].name, frequencyResult: type === 'laser' ? '' : snapshot.hops[i].frequency })),
  segments: [[0, 1], [2], [3], [4], [5]].map((hopIndexes) => ({ hopIndexes })) })
const row = { nodes: [{ kind: 'es', name: 'EDITED TX' }, { kind: 'regen', name: 'EDITED SAT' }], hops: [{ frequency: '99' }] }
const before = JSON.stringify({ snapshot, data, row })
const metadata = e2eReportTopology(row, snapshot, data, () => { throw new Error('Live library must not be read for a successful snapshot') })
assert.equal(metadata.topologyConfiguredOnly, false)
assert.deepEqual(metadata.topologyNodes.map((node) => node.name), snapshot.nodes.map((node) => node.name))
assert.deepEqual(metadata.topologyEdges.map((edge) => edge.type), types)
assert.equal(metadata.topologyEdges[4].frequency, '1064 nm')
assert.equal(metadata.topologyNodes[3].role, 'relay')
assert.equal(metadata.topologyNodes[3].processing, true)
assert.equal(metadata.topologyNodes[1].processing, false)
const topology = linkTopologyOf({ ...metadata, data }, 'E2E', '', null, 'en')
assert.equal(topology.configuredOnly, false)
assert.deepEqual(topology.nodes.map((node) => node.kind), ['ground', 'transparent', 'regen', 'ground', 'regen', 'regen', 'ground'])
assert.equal(topology.nodes[3].role, 'relay')
assert.equal(topology.edges[4].frequency, '1064 nm')
assert.equal(JSON.stringify({ snapshot, data, row }), before, 'Metadata extraction cannot change snapshots or result values')

// Older results without an input snapshot still carry exact hop order and segment boundaries.
const legacy = e2eReportTopology(row, null, data)
assert.equal(legacy.topologyConfiguredOnly, false)
assert.deepEqual(legacy.topologyNodes.map((node) => node.kind), topology.nodes.map((node) => node.kind))
assert.deepEqual(legacy.topologyNodes.map((node) => node.name), snapshot.nodes.map((node) => node.name))
assert.equal(legacy.topologyEdges[4].frequency, '', 'A missing optical wavelength is not invented from another hop')
const noSegments = linkTopologyOf({ data: { hops: data.hops } }, 'E2E')
assert.equal(noSegments.nodes[1].kind, 'satellite', 'Missing segmentation does not justify guessing a transparent or regenerative payload')
assert.equal(noSegments.nodes[2].kind, 'satellite')

const failedRow = freeze({ nodes: [{ kind: 'es', name: 'Configured TX' }, { kind: 'regen', name: '' }, { kind: 'es', name: 'Configured RX' }],
  hops: [{ frequency: '14.25' }] })
const failed = e2eReportTopology(failedRow, snapshot, null, () => ({ name: 'Configured satellite' }))
assert.equal(failed.topologyConfiguredOnly, true)
assert.equal(failed.topologyNodes[1].name, 'Configured satellite')
assert.deepEqual(failed.topologyEdges[1], { type: 'unknown', frequency: '', missing: true, invalid: true })
const failedTopology = linkTopologyOf({ ...failed, data: null, error: 'Missing downlink hop' }, 'E2E')
assert.equal(failedTopology.configuredOnly, true)
assert.equal(failedTopology.edges[1].missing, true)
const missingEdges = linkTopologyOf({ topologyNodes: failed.topologyNodes, data: null }, 'E2E')
assert.ok(missingEdges.edges.every((edge) => edge.type === 'unknown' && edge.missing), 'Missing hops cannot become valid inferred links')
const invalid = e2eReportTopology({ nodes: [{ kind: 'es', name: 'A' }, { kind: 'es', name: 'B' }], hops: [{}] }, null, null)
assert.equal(invalid.topologyEdges[0].invalid, true)

const length = 27
const longSnapshot = { nodes: Array.from({ length }, (_, i) => ({ kind: i === 0 || i === length - 1 ? 'es' : i % 2 ? 'txp' : 'regen', name: 'Node ' + (i + 1) })),
  hops: Array.from({ length: length - 1 }, () => ({ frequency: '23' })) }
const long = e2eReportTopology(row, longSnapshot, { hops: [] })
assert.equal(long.topologyNodes.length, length)
assert.equal(long.topologyEdges.length, length - 1)
assert.equal(long.topologyNodes.at(-1).name, 'Node 27')
assert.equal(topologyEdgeFrequency('laser', { laser: { wavelengthNm: '1550' }, frequency: '23' }), '1550 nm')
assert.equal(topologyEdgeFrequency('up', { laser: { wavelengthNm: '1550' }, frequency: '14.25' }), '14.25 GHz')
console.log('PASS E2E report topology: calculation snapshots, mixed hop types, regenerative boundaries, relay roles, long chains, and explicit failed/missing links')
