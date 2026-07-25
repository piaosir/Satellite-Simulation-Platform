// 链路预算工作台数据区字号（--lb-fs）：GSO / NGSO / 再生式三窗共享。
// CSS 默认值在 styles/lbworkbench.css 的 :root（11px）；此处仅当用户调过时在 <html> 写行内变量覆盖，
// localStorage 持久化 + storage 事件跨窗即时同步（三窗同源，与 globe3d/settings.grd 共享机制相同）。
const KEY = 'lb/fontSize'
export const LB_FONT_DEFAULT = 11
export const LB_FONT_MIN = 8
export const LB_FONT_MAX = 20

const clamp = (n) => Math.min(LB_FONT_MAX, Math.max(LB_FONT_MIN, Math.round(n)))

export function getLbFontSize() {
  try {
    const n = parseFloat(localStorage.getItem(KEY))
    return isFinite(n) ? clamp(n) : LB_FONT_DEFAULT
  } catch (e) { return LB_FONT_DEFAULT }
}

function apply(px) {
  document.documentElement.style.setProperty('--lb-fs', px + 'px')
}

export function setLbFontSize(px) {
  const v = clamp(px)
  try { localStorage.setItem(KEY, String(v)) } catch (e) { /* ignore */ }
  apply(v)
  return v
}

// 窗口启动时套用已存字号，并监听其它链路预算窗口的改动（storage 事件只在别的窗口触发）
export function initLbFontSize(onChange) {
  apply(getLbFontSize())
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    const v = getLbFontSize()
    apply(v)
    if (onChange) onChange(v)
  })
}
