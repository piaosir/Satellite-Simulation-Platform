import { reactive } from 'vue'

// 缩放进度条（底部状态栏）：当前活动地图把缩放能力注册到此，状态栏据 avail 显隐、据 value 显示进度。
// 进度 value ∈ [0, ZOOM_TMAX]：0 = 最远（缩小到底），ZOOM_TMAX = 最近（放大到底）。
// ★ 满格是 1.2（＝读数 120%）不是 1：0–100% 那一段与改之前逐格一致，100–120% 是新加出来的放大余量。
//   两端之间按对数映射，靠近地图时步进更细（精细化缩放）。
//  - avail：当前页有可缩放地图（由地图页挂载时置真、卸载时复位）
//  - value：当前缩放进度（地图滚轮缩放时回填，进度条随之走动）
//  - apply：(t)=>void 由地图注入——把缩放设到进度 t（进度条拖动/按钮步进时调用）
export const ZOOM_TMAX = 1.2

export const zoom = reactive({
  avail: false,
  value: 0,
  apply: null
})
