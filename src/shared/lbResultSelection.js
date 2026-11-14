// Preserve table order for both contiguous ranges and Ctrl-selected rows.
export function resultRowIndices(rows, ids, fallbackId) {
  const selected = new Set(ids || [])
  const indices = []
  rows.forEach((row, i) => { if (selected.has(row._id)) indices.push(i) })
  if (indices.length) return indices
  const i = rows.findIndex((row) => row._id === fallbackId)
  return i < 0 ? [] : [i]
}
