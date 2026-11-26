// 真实天线沿用覆盖树顺序。只有生成记录能把草稿合到天线行，用户起的同名不表示关联。
export function synthTree(satellites, groups) {
  const byFolder = new Map()
  for (const group of groups) {
    if (!byFolder.has(group.satFolder)) byFolder.set(group.satFolder, [])
    byFolder.get(group.satFolder).push(group)
  }
  return satellites.filter(sat => sat.kind !== 'elevline').map(sat => {
    const designs = byFolder.get(sat.folder) || []
    const generated = new Map(designs.filter(g => g._genName).map(g => [g._genName, g]))
    const linked = new Set()
    const rows = sat.antennas.map(antenna => {
      const group = antenna.synth && generated.get(antenna.name) || null
      if (group) linked.add(group.id)
      return { antenna, group, key: group ? 'g:' + group.id : 'a:' + antenna.name }
    })
    for (const group of designs) {
      if (!linked.has(group.id)) rows.push({ antenna: null, group, key: 'g:' + group.id })
    }
    return { sat, rows }
  })
}
