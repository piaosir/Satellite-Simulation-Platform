import { reactive } from 'vue'

// 基础视图偏好（设置弹窗 ↔ 3D 页 的桥）：参考系 / 拖拽阻尼 / 两张图的滚轮缩放比例。
// 持久化由 3D 页负责（并入 globe3d/settings 快照），此 store 仅作运行时单一真相。
// 3D 页 watch 本 store 把变化套到 scene / flat。
export const viewPrefs = reactive({
  // 相机所在的参考系。'inertial' 惯性视角（相机固定在惯性空间，地球随仿真时钟东转 —— 出厂默认）
  // | 'fixed' 相机跟随（地固 ECEF：地面不动，卫星相对地面走，逐位等于 v1.4.11 的画面）。
  // ★ 没有「自转速度」：转过的角度恒等于两拍 GMST 之差，见 viz/globe3d/earthSpin.js。
  frame: 'inertial',
  dragDamping: 50,   // 3D 拖拽阻尼 %（粘滞感）：0 = 直连，越大越重、停得越柔；→ τ 见 viz/globe3d/dragFollow.js
  wheelStep3d: 3,    // 一格滚轮 = 底部状态栏缩放读数走几个百分点（3D）
  wheelStep2d: 3     // 同上（2D 平面图）
})

// 各档的取值范围（设置窗滑块与存档恢复共用同一份，免得两处各写一遍钳法）
export const FRAME_MODES = ['fixed', 'inertial']
// 出厂参考系改过一次就 +1。存档里的 viewRev 小于它 → 里面那个 frame 不认（是旧出厂值顺手存下来的，
// 不是用户挑的），按新出厂值入场；存过一次之后 viewRev 齐平，用户的选择照旧跟着存档走。
export const VIEW_PREFS_REV = 1
export const VIEW_PREF_RANGE = {
  dragDamping: { min: 0, max: 100, step: 5 },
  wheelStep3d: { min: 1, max: 20, step: 1 },
  wheelStep2d: { min: 1, max: 20, step: 1 }
}
