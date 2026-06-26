import { reactive } from 'vue'

// 基础视图偏好（设置弹窗 ↔ 3D 页 的桥）：自转开关 / 自转速度。
// 持久化由 3D 页负责（并入 globe3d/settings 快照），此 store 仅作运行时单一真相。
// 3D 页用 toRef(viewPrefs,'autoRotate') 直接读写，并 watch 本 store 把变化套到 scene。
export const viewPrefs = reactive({
  autoRotate: true,
  autoRotateSpeed: 0.5
})
