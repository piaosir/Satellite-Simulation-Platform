// 主窗口状态栏左侧的「状态句」：导出回执、删除后的撤销、失败告警都落在这里。
// 状态栏原来只有悬停提示（平时恒为「就绪」），操作结果要么弹模态、要么只进收起的日志——用户看不见。
//
//   showStatus(text, { level, file, action, ms })
//     level  'info' | 'warn' | 'error'（error 着红色）
//     file   导出写成的文件路径 → 状态栏附「打开 · 在文件夹中显示」（主进程白名单只认本会话写过的文件）
//     action { label, run } → 状态栏附一个操作链接（例如「撤销」）；actions [{label, run}, …] → 多个
//     ms     停留时长；默认 info 5 s，带 file / action 8 s，error 12 s
//
// 悬停提示（App.vue 的 hint）优先显示；鼠标移开即回到状态句。文案只陈述状态本身（CLAUDE.md）。
import { reactive } from 'vue'

export const statusMsg = reactive({ text: '', level: 'info', file: '', actions: [], seq: 0 })
let _t = null

export function clearStatus(seq) {
  if (seq != null && seq !== statusMsg.seq) return
  clearTimeout(_t); statusMsg.text = ''; statusMsg.level = 'info'; statusMsg.file = ''; statusMsg.actions = []
}

export function showStatus(text, opts = {}) {
  const level = opts.level || 'info'
  clearTimeout(_t)
  statusMsg.text = String(text == null ? '' : text)
  statusMsg.level = level
  statusMsg.file = opts.file || ''
  const acts = [].concat(opts.action || [], opts.actions || []).filter((a) => a && typeof a.run === 'function')
  statusMsg.actions = acts.map((a) => ({ label: a.label, run: a.run }))
  const seq = ++statusMsg.seq
  const ms = opts.ms != null ? opts.ms : (level === 'error' ? 12000 : (statusMsg.file || statusMsg.actions.length ? 8000 : 5000))
  if (ms > 0) _t = setTimeout(() => clearStatus(seq), ms)
  return seq
}

/** 只在当前状态句还是 text 时清掉（「正在导出…」这类过程态：成功/失败已被回执覆盖时不误清） */
export function clearStatusIf(text) { if (statusMsg.text === text) clearStatus() }

/** 导出完成回执：「已导出 文件名」+ 打开 / 在文件夹中显示 */
export function showExported(file, label) {
  const name = String(file || '').split(/[\\/]/).pop()
  return showStatus((label || '已导出') + '：' + name, { file })
}

/** 删除类操作的撤销回执：「已删除 Polygon「A」」+ 撤销 */
export function showUndoable(text, undo) {
  return showStatus(text, { action: { label: '撤销', run: undo } })
}

/** 执行状态句上的第 i 个操作链接（执行后清掉这条） */
export function runStatusAction(i = 0) {
  const a = statusMsg.actions[i]
  clearStatus()
  if (a) { try { a.run() } catch (e) { console.error(e) } }
}
