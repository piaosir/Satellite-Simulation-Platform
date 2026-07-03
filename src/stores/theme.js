import { reactive } from 'vue'

// 外观主题：'system' 跟随系统 | 'light' 浅色 | 'dark' 深色，localStorage 持久化，默认浅色。
// 解析结果写到 <html data-theme="light|dark">，global.css 据此切换变量。
// 三个窗口入口（main/linkbudget/suntool）都要 import 本模块；窗口间经 storage 事件联动。
const KEY = 'ui-theme'
const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

function read() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'light'
  } catch { return 'light' }
}

export const theme = reactive({ mode: read(), resolved: 'light' })

function apply() {
  const dark = theme.mode === 'dark' || (theme.mode === 'system' && mq && mq.matches)
  theme.resolved = dark ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme.resolved
}

export function setTheme(mode) {
  theme.mode = mode
  try { localStorage.setItem(KEY, mode) } catch { /* ignore */ }
  apply()
}

if (mq) mq.addEventListener('change', () => { if (theme.mode === 'system') apply() })
// 多窗口联动：任一窗口改主题，其余窗口经 storage 事件跟随
window.addEventListener('storage', (e) => { if (e.key === KEY) { theme.mode = read(); apply() } })
apply()
