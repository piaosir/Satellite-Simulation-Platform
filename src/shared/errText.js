// 错误 → 一句状态文本。
// Electron 的 ipcRenderer.invoke 会把主进程抛出的错误包成
//   "Error invoking remote method 'xxx:yyy': Error: 真正的原因"
// 这串英文前缀对用户没有意义（中文界面里尤其突兀），统一在这里剥掉，只留原因本身。
export function errText(e) {
  if (e == null) return ''
  let s = (typeof e === 'object' && e.message != null) ? String(e.message) : String(e)
  s = s.replace(/^Error invoking remote method '[^']*':\s*/, '')
  // 剥掉一到两层「Error: / TypeError: …」类名前缀（invoke 包装后常是两层）
  for (let i = 0; i < 2; i++) s = s.replace(/^(?:[A-Z][A-Za-z]*)?Error:\s*/, '')
  return s.trim()
}
