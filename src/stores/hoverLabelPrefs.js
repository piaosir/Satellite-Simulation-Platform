import { reactive, watch } from 'vue'
import { HOVER_LABEL_DEFAULTS, HOVER_LABEL_MODES, normalizeHoverLabelPrefs } from '../shared/hoverLabel.js'

const KEY = 'map-object-hover-label-v1'
let saved
try { saved = JSON.parse(localStorage.getItem(KEY) || 'null') } catch { /* 使用默认值 */ }
export const hoverLabelPrefs = reactive(normalizeHoverLabelPrefs(saved))
watch(hoverLabelPrefs, () => {
  try { localStorage.setItem(KEY, JSON.stringify(hoverLabelPrefs)) } catch { /* 存储不可用时仍可在本次使用 */ }
}, { flush: 'sync' })

export function setHoverLabelMode(mode) {
  if (HOVER_LABEL_MODES.includes(mode)) hoverLabelPrefs.mode = mode
}
export function setHoverLabelSeconds(raw) {
  const seconds = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() ? Number(raw) : NaN)
  const value = normalizeHoverLabelPrefs({ mode: hoverLabelPrefs.mode, seconds })
  if (value.seconds !== seconds) return false
  hoverLabelPrefs.seconds = seconds
  return true
}
export function resetHoverLabelPrefs() { Object.assign(hoverLabelPrefs, HOVER_LABEL_DEFAULTS) }

if (typeof window !== 'undefined') window.addEventListener('storage', (e) => {
  if (e.key !== KEY && e.key !== null) return
  try { Object.assign(hoverLabelPrefs, normalizeHoverLabelPrefs(e.newValue ? JSON.parse(e.newValue) : null)) } catch { /* 忽略损坏的数据 */ }
})
