import { reactive, watch } from 'vue'

// 地图视图模式：flat=false 为 3D 球体，flat=true 为 2D 平面图。
// 顶栏「视图」按钮与 3D 页面共用此状态。
// 持久化：记住上次退出时的 2D/3D 选择，下次启动恢复（顶栏标签也随之即时正确）。
const KEY = 'globe3d/viewMode'
function loadFlat() {
  try { return localStorage.getItem(KEY) === '2d' } catch { return false }
}
export const view = reactive({ flat: loadFlat() })
watch(() => view.flat, (v) => { try { localStorage.setItem(KEY, v ? '2d' : '3d') } catch { /* ignore */ } })
