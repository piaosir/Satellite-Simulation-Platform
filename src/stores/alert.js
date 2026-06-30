import { ref } from 'vue'

// 全局应用内提示：替代 Electron 原生 alert。
// 原生 alert/confirm 关闭后会夺走渲染进程焦点，导致之后输入框点击无法聚焦（需最小化再恢复才正常）。
// 统一改用此响应式消息 + 页面内弹窗渲染（见 ConstellationMap3D.vue 的提示弹窗），彻底规避。
// 注意：仅在「渲染该弹窗的页面已挂载」的窗口内有效；跨独立 Electron 窗口的 store 实例互不共享。
export const alertMsg = ref('')
export function appAlert(m) { alertMsg.value = String(m == null ? '' : m) }
export function closeAlert() { alertMsg.value = '' }
