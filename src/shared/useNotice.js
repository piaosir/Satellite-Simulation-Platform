// 计算窗口的通知条（原先各窗口各抄一份 toast(msg) + 4 s 定时器）。
//   toast(msg)              普通状态，4 s 后消失
//   toastFile(msg, path)    导出完成：带「打开 · 在文件夹中显示」，8 s 后消失
//   toastError(msg)         失败：常驻，直到下一条通知或用户点 ×
// 渲染用 components/NoticeLine.vue；同时把本窗口登记为 reportError 的出口。
import { ref } from 'vue'
import { setErrorSink } from './reportError.js'

export function useNotice(opts = {}) {
  const ms = opts.ms || 4000
  const notice = ref(''), noticeFile = ref(''), noticeLevel = ref('info')
  let _t = null
  function clearNotice() { clearTimeout(_t); notice.value = ''; noticeFile.value = ''; noticeLevel.value = 'info' }
  function show(msg, { file = '', level = 'info', sticky = false } = {}) {
    clearTimeout(_t)
    notice.value = String(msg == null ? '' : msg); noticeFile.value = file || ''; noticeLevel.value = level
    if (!sticky) _t = setTimeout(clearNotice, file ? 8000 : ms)
  }
  const toast = (msg) => show(msg)
  const toastFile = (msg, file) => show(msg, { file })
  const toastError = (msg) => show(msg, { level: 'error', sticky: true })
  const n = { notice, noticeFile, noticeLevel, toast, toastFile, toastError, clearNotice }
  if (opts.errorSink !== false) setErrorSink((msg) => toastError(msg))
  return n
}
