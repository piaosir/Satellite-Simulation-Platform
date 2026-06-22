import { reactive } from 'vue'

// 地图视图模式：flat=false 为 3D 球体，flat=true 为 2D 平面图。
// 顶栏「视图」按钮与 3D 页面共用此状态。
export const view = reactive({ flat: false })
