// 统一的失败上报：任何「出错了但用户应该知道」的地方调 reportError(where, e)。
//
// 为什么要它：过去大量 catch 只写 console.warn（打包版里看不见），GRD 持久化失败、导出缺内容、
// 带上下文开窗失败都悄无声息。现在每扇窗口登记一个「出口」（sink）：
//   · 主窗口 → 日志窗格（'error' 级）+ 状态栏告警标记（App.vue 里登记）
//   · 计算窗口 → 本窗的通知条（useNotice 的 toastError）
// 没登记出口的窗口退回 console.error，不会更糟。
//
// 文案口径（CLAUDE.md）：只陈述状态本身 ——「GRD 存盘失败：原因」，不加教学式从句。
import { errText } from './errText.js'

let _sink = null
export function setErrorSink(fn) { _sink = typeof fn === 'function' ? fn : null }

/**
 * @param {string} where  出错的环节（中文短语，例如「GRD 存盘」「导出 GXT」）
 * @param {*} e           错误对象 / 文本；可为空（只报 where）
 * @param {{ level?: 'error'|'warn' }} [opts]
 * @returns {string} 拼好的状态文本（调用方可另作他用）
 */
export function reportError(where, e, opts = {}) {
  const why = e == null ? '' : errText(e)
  const msg = where ? (why ? where + '：' + why : where) : (why || '未知错误')
  try { console.error('[' + (where || 'error') + ']', e) } catch { /* ignore */ }
  if (_sink) { try { _sink(msg, { level: opts.level || 'error', where, error: e }) } catch { /* 出口自己坏了也别再抛 */ } }
  return msg
}

/** 「n 成功 / m 失败」的部分成功汇报：failed = [{ name, error }] */
export function reportPartial(where, okCount, failed) {
  if (!failed || !failed.length) return ''
  const list = failed.slice(0, 5).map((f) => (f.name ? f.name + '（' + errText(f.error) + '）' : errText(f.error))).join('；')
  const more = failed.length > 5 ? ' 等 ' + failed.length + ' 项' : ''
  return reportError(where, okCount + ' 成功 / ' + failed.length + ' 失败：' + list + more, { level: okCount ? 'warn' : 'error' })
}

// 全局兜底：Vue 组件里没接住的错误、没人 catch 的 Promise 拒绝。
// 同一句话 10 s 内只报一次（一个坏 watcher 每帧抛错时不至于刷屏）；已知无害的噪声直接忽略。
const IGNORE = [/ResizeObserver loop/i, /AbortError/i, /The user aborted/i, /cancel(l)?ed/i]
let _lastMsg = '', _lastAt = 0
function globalReport(where, e) {
  const t = errText(e)
  if (!t || IGNORE.some((re) => re.test(t))) { try { console.error(e) } catch { /* ignore */ } return }
  const now = Date.now()
  if (t === _lastMsg && now - _lastAt < 10000) return
  _lastMsg = t; _lastAt = now
  reportError(where, e)
}

export function installGlobalErrors(app) {
  if (app && app.config) {
    app.config.errorHandler = (err, _inst, info) => globalReport('界面异常' + (info ? '（' + info + '）' : ''), err)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('unhandledrejection', (ev) => globalReport('未处理的异常', ev && ev.reason))
  }
}
