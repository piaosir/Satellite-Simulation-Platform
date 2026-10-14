import { reactive } from 'vue'
import { applyAxisVars } from '../shared/axisColors.js'

// 外观主题：'system' 跟随系统 | 'studio-light' 专业浅色 | 'dark' 专业深色，localStorage 持久化，默认跟随系统。
// 解析结果写到 <html data-theme="light|dark">，global.css 据此切换配色；另恒写 data-skin="studio"
// （面板块 + 缝 + 焦点面板 + 蓝色选中这套结构，见 App.vue / 3D 页样式末尾与 global.css）。
// ★ 2026-10-14：原暖灰深色由专业深色替换（键仍是 'dark'），原「浅色」档删除 —— 旧存档 'light'（用户亲手选过浅色）读作专业浅色，
//   试用键 'studio' 读作 'dark'；没存过 / 认不出的一律跟随系统。:root 里那套暖灰值只剩报表打印页（report.html 钉 data-theme="light"、不带 skin）在用。
// ★ 各窗口 html 里的主题预置脚本（CSS / JS 加载前先写属性，防启动闪色）是本文件的手工副本，改口径须同步那 13 处。
// 各窗口入口都要 import 本模块；窗口间经 storage 事件联动。
const KEY = 'ui-theme'
const MODES = ['system', 'studio-light', 'dark']
const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

function read() {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'studio') return 'dark'          // 10-14 试用版的「专业深色」键
    if (v === 'light') return 'studio-light'   // 已删的「浅色」：用户亲手选过浅色，落到专业浅色
    return MODES.includes(v) ? v : 'system'    // 首次运行 / 认不出 → 跟随系统
  } catch { return 'system' }
}

export const theme = reactive({ mode: read(), resolved: 'light', skin: 'studio' })

// 新开窗口在页面画出第一帧之前露的是 BrowserWindow 的 backgroundColor：把当前外观报给主进程
// （electron/services/winTheme.js 记住并落盘），之后开的窗口直接用对应底色 —— 深色外观下不再先白闪一下。
function pushWinBg() {
  const set = window.api?.win?.setTheme
  if (!set) return
  // 第二参是 nativeTheme.themeSource：工具窗 / 性能表的原生标题栏跟应用外观走，「跟随系统」交还系统
  const source = theme.mode === 'system' ? 'system' : theme.mode === 'dark' ? 'dark' : 'light'
  set(theme.resolved === 'dark' ? 'dark' : 'studio-light', source).catch(() => { /* 主进程不在（浏览器直跑） */ })
}

// 换肤那一帧打 .theme-swap（controls.css 里停掉全部过渡），两帧后撤：否则带 80~120ms 颜色过渡的
// 按钮 / 复选框 / 拨杆会比面板晚翻一拍，整窗分两段变色。只在主题真的变了时才打 ——
// .theme-swap * 会让整棵树重算样式，系统主题变了但用户选的是固定档、storage 回声这类空触发不许打。
function apply() {
  const dark = theme.mode === 'dark' || (theme.mode === 'system' && mq && mq.matches)
  const next = dark ? 'dark' : 'light'
  const skin = 'studio'
  theme.resolved = next
  theme.skin = skin
  const r = document.documentElement
  applyAxisVars(r, dark)
  // html 预置脚本在深色时给 <html> 写了行内 #111111 底（防启动白闪）；运行中切回浅色要撤掉，否则窗口边缘 / 过度滚动露深底
  if (!dark) r.style.removeProperty('background')
  if (r.dataset.theme === next && (r.dataset.skin || '') === skin) return
  r.classList.add('theme-swap')
  r.dataset.theme = next
  if (skin) r.dataset.skin = skin
  else delete r.dataset.skin
  requestAnimationFrame(() => requestAnimationFrame(() => r.classList.remove('theme-swap')))
  pushWinBg()
}

export function setTheme(mode) {
  theme.mode = MODES.includes(mode) ? mode : 'system'
  try { localStorage.setItem(KEY, theme.mode) } catch { /* ignore */ }
  apply()
  pushWinBg()   // 解析结果没变（系统深色下从「跟随系统」改选「专业深色」）apply 会早退，themeSource 仍要报
}

if (mq) mq.addEventListener('change', () => { if (theme.mode === 'system') apply() })
// 多窗口联动：任一窗口改主题，其余窗口经 storage 事件跟随
window.addEventListener('storage', (e) => { if (e.key === KEY) { theme.mode = read(); apply() } })
apply()
