import { reactive, watch, nextTick } from 'vue'
import { shellUi, requestSide } from './shellUi'

// 侧栏各视图「内部分区」的展开/收起状态（本地记忆）。
// key = 分区唯一标识（如 'geo-ocean'）；value = true 展开 / false 收起。
// 无记录时按各分区传入的默认值（大多默认展开，纯「显示选项」类默认收起）。
// 单独成 store：跨视图共享 + localStorage 持久化，切页/重启后保留用户的展开偏好。
const KEY = 'panel-sections-v1'
const state = reactive({})
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null')
  if (saved && typeof saved === 'object') {
    for (const k in saved) if (typeof saved[k] === 'boolean') state[k] = saved[k]
  }
} catch { /* ignore */ }
watch(state, () => { try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* ignore */ } }, { deep: true })

// 分区是否展开：未记录时取 def（默认展开）
export function isSecOpen(key, def = true) {
  const v = state[key]
  return v === undefined ? def : v
}
// 切换展开/收起（首次点击基于 def 取反）
export function toggleSec(key, def = true) {
  state[key] = !isSecOpen(key, def)
}
// 显式置为展开 / 收起（顶部搜索框「定位到分区」用：先展开再滚到它，不是切换）
export function setSecOpen(key, open = true) {
  state[key] = !!open
}

// 定位到侧栏 / 设置窗的某个分区（顶部搜索框「定位」用）：切到所在视图（view 为空不切，如设置窗由调用方先打开）
// → 展开 → 滚到它并闪一下。keys 可给多个：同一分区在不同模式下用不同 key（波束合成的「覆盖区域」bs-cov / bs-pcov），
// 谁在 DOM 里就滚谁。分区标题元素靠 data-sec="<key>" 找（3D 页 / SatCovPanel / SettingsModal 的分区标题都打了）。
// 返回标题元素（找不到返回 null，但视图已切、展开态已置）。
export async function revealSection(view, keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean)
  if (view && !requestSide(view)) return null   // 未激活：受锁视图不切（requestSide 已请出锁窗）
  for (const k of list) setSecOpen(k, true)
  await settle()
  const el = findHeading(list)
  if (!el) return null
  // 动效只认应用内开关（--dur-* 置 0 = 关动效），不跟系统 prefers-reduced-motion（用户机 Windows 动画关 → 恒报 reduce）
  el.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
  flash(el)
  return el
}

// 应用内动效开关：--dur-2 为 0 → 瞬跳；否则平滑滚动
export function scrollBehavior() {
  try { const v = getComputedStyle(document.documentElement).getPropertyValue('--dur-2').trim(); return /^0(?:\.0+)?(?:ms|s)?$/.test(v) ? 'auto' : 'smooth' } catch { return 'smooth' }
}

// 定位到侧栏里的某个具体元素（地图上点中的站 / 点 / Polygon / 航迹 → 列表里那一行）：
// 先切视图 + 展开分区（同 revealSection），再在 #side-view 里按选择器找到它滚到中间闪一下。找不到就停在分区。
export async function revealEl(view, keys, selector) {
  const head = await revealSection(view, keys)
  if (view && shellUi.side !== view) return null
  const el = selector ? document.querySelector('#side-view ' + selector) : null
  if (!el) return head
  el.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
  flash(el)
  return el
}

// 定位到分区里的某一行（参数行 / 复选项 / 设置项）：先定位分区，再在分区内容里按标签文本找到那一行滚过去闪一下。
// "<view>-top" 这类没有标题元素的 key = 视图里第一个分区之前的内容，范围取当前可见的那块 .sview。
// 行只在某个展开态 / 模式下才渲染（v-if）的，找不到就停在分区，不报错。英文界面下 DOM 文本是译文，两种都认。
export async function revealRow(view, keys, label) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean)
  const head = await revealSection(view, list)
  if (view && shellUi.side !== view) return false
  let scope = []
  if (head) { for (let e = head.nextElementSibling; e && !isHeading(e); e = e.nextElementSibling) scope.push(e) }
  else {
    const c = [...document.querySelectorAll('#side-view .sview')].find((x) => getComputedStyle(x).display !== 'none')
    if (c) scope = [c]
  }
  if (!scope.length) return false
  const { t } = await import('../shared/i18n/runtime')
  const want = new Set([label, t(label)])
  const text = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim()
  const SEL = 'label, .plgl, .swrow > span, .chk2 > span, .fn'
  let hit = null
  for (const e of scope) {
    const cands = e.matches(SEL) ? [e] : [...e.querySelectorAll(SEL)]
    hit = cands.find((c) => want.has(text(c)))
    if (hit) break
  }
  if (!hit) return false
  const row = hit.closest('.srow, .swrow, .chk2, .frow, .cef, .cefv') || hit
  row.scrollIntoView({ block: 'center' })
  flash(row)
  return true
}

const isHeading = (e) => e.classList.contains('sect') || e.classList.contains('shd') || e.hasAttribute('data-sec')
function findHeading(list) {
  for (const k of list) { const el = document.querySelector('[data-sec="' + k + '"]'); if (el) return el }
  return null
}
// Teleport 随 side 挂载、分区随展开态渲染：等一次 tick + 两帧再找元素
function settle() { return nextTick().then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))) }
function flash(el) {
  try { el.animate([{ backgroundColor: 'var(--accent-ui-weak)' }, { backgroundColor: 'transparent' }], { duration: 1500, easing: 'ease-out' }) } catch { /* 无 WAAPI 就只滚不闪 */ }
}
