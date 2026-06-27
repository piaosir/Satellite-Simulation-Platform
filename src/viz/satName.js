// 内置卫星显示名映射：中星→CS、亚太→APSTAR（仅改列表/下拉的显示名，不动 folder 路径键与导出用的 satName）。
//   中星10R → CS10R，中星6E → CS6E，亚太6C → APSTAR6C，亚太7 → APSTAR7
export function displaySatName(name) {
  if (!name) return name
  return String(name)
    .replace(/^中星\s*/, 'CS')
    .replace(/^亚太\s*/, 'APSTAR')
}
