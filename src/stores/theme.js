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

// 换肤那一帧打 .theme-swap（controls.css 里停掉全部过渡），两帧后撤：否则带 80~120ms 颜色过渡的
// 按钮 / 复选框 / 拨杆会比面板晚翻一拍，整窗分两段变色。只在主题真的变了时才打 ——
// .theme-swap * 会让整棵树重算样式，系统主题变了但用户选的是固定档、storage 回声这类空触发不许打。
function apply() {
  const dark = theme.mode === 'dark' || (theme.mode === 'system' && mq && mq.matches)
  const next = dark ? 'dark' : 'light'
  theme.resolved = next
  const r = document.documentElement
  if (r.dataset.theme === next) return
  r.classList.add('theme-swap')
  r.dataset.theme = next
  requestAnimationFrame(() => requestAnimationFrame(() => r.classList.remove('theme-swap')))
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
