// 场景状态写盘（localStorage）失败的上报闸：写失败多半是配额满了，而这些写入随每次改动触发，
// 不能每次都报 —— 同一个键失败只报一次，直到它再次写成功（之后再失败会重新报）。
import { reportError } from './reportError.js'

const _failed = new Set()
export function persistOk(key) { _failed.delete(key) }
export function persistFailed(key, label, e) {
  if (_failed.has(key)) return
  _failed.add(key)
  reportError((label || key) + '未能写盘', e)
}
/** 包一层：fn() 抛错即按 key 上报一次 */
export function guardedPersist(key, label, fn) {
  try { fn(); persistOk(key) } catch (e) { persistFailed(key, label, e) }
}
