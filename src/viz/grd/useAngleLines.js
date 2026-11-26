import { computed, ref } from 'vue'
import { newAngleLine } from './angleContours.js'

// One collection per coverage view. A line shares its antenna's pointing,
// but has its own lifetime and visibility, like a performance-table child.
export function useAngleLines(selected, onTreeKeys, ensureLoaded, satellites, view) {
  const rows = ref([]), editing = ref('')
  const byAntenna = computed(() => {
    const byKey = new Map()
    for (const row of rows.value) {
      if (!byKey.has(row.key)) byKey.set(row.key, [])
      byKey.get(row.key).push(row)
    }
    return byKey
  })
  const list = (key, kind = 'beam') => (byAntenna.value.get(key) || []).filter(row => row.kind === kind)
  const elevations = computed(() => rows.value.filter(row => row.kind === 'elevation' && row.show))
  const elevationSources = computed(() => new Map(elevations.value.map(row =>
    [row.key, satellites.value.find(s => s.folder === row.key)])))
  const movingElevation = computed(() => [...elevationSources.value.values()].some(s => s?.noradId || s?.elements))
  const drawnKeys = computed(() => [...new Set([...selected.value, ...rows.value.filter(row => row.show && row.kind === 'beam').map(row => row.key)])])
  function add(key, kind = 'beam', settings = {}) {
    const row = { ...newAngleLine(list(key, kind), kind, view), ...settings, id: crypto.randomUUID(), key, kind }
    rows.value.push(row)
    editing.value = row.id
  }
  function remove(id) {
    rows.value = rows.value.filter(row => row.id !== id)
    if (editing.value === id) editing.value = ''
  }
  function clearDrawing() { for (const row of rows.value) row.show = false }
  async function toggle(row) {
    if (row.show) { row.show = false; return }
    if (row.kind === 'elevation' || await ensureLoaded(row.key)) row.show = true
  }
  // Older scenes already store the full beam angle, regardless of the display convention.
  const copy = ({ angleMode, ...row }) => ({ ...newAngleLine([], row.kind, view), ...row, shellIds: row.shellIds?.slice() ?? null,
    ...(row.position && { position: { ...row.position } }),
    ...(row.labelPositions && { labelPositions: Object.fromEntries(Object.entries(row.labelPositions).map(([id, slots]) => [id, { ...slots }])) }) })
  function getState() { return rows.value.map(copy) }
  async function restore(saved) {
    editing.value = ''
    const next = Array.isArray(saved) ? saved.filter(row => row?.id && (row.key || row.position)).map(copy) : []
    for (const key of new Set(next.filter(row => row.show && row.kind === 'beam').map(row => row.key))) await ensureLoaded(key)
    rows.value = next
  }
  onTreeKeys(event => {
    if (event.type === 'rename') {
      for (const row of list(event.from)) row.key = event.to
    } else if (event.type === 'remove') {
      const gone = new Set(event.keys)
      rows.value = rows.value.filter(row => row.kind === 'elevation' ? row.key !== event.folder : !gone.has(row.key))
      if (editing.value && !rows.value.some(row => row.id === editing.value)) editing.value = ''
    }
  })
  return { rows, drawnKeys, elevations, elevationSources, movingElevation, editing, list, add, remove, toggle, clearDrawing, getState, restore }
}
