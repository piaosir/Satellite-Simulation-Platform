import { reactive, watch } from 'vue'

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
