import { shallowReactive } from 'vue'

// 文件管理器 ↔ 星座地图 3D 页的桥。3D 页挂载时把活的 GRD 树与「当前画面覆盖导出器」注册进来，
// 卸载时清空。文件管理器据此镜像 GRD 卫星/天线树、并把当前绘制的覆盖导出为 GXT。
//  - grd：useGrdCoverage 的活实例（卫星/天线树、导入/导出/删除）。null=当前不在 3D 页。
//  - collectGxt()：返回 [{ name, lon, satName, bore, contours:[{g,p}] }]，当前画面（GXT+GRD 来源）可导出的覆盖。
//  - libraryTick：用户 GXT 库变更后自增，提示 3D 页刷新可选卫星下拉。
// shallowReactive：只让顶层 grd/collectGxt/libraryTick 槽位响应式，不深度代理 grd 对象——
// 否则 reactive 会自动解包 grd 内部的 sats 等 ref（grd.sats 变成裸数组，.value 丢失）。
export const fileBridge = shallowReactive({
  grd: null,
  collectGxt: null,
  // 3D 页注入的宿主动作：{ redraw, openAddSat(), openEditSat(folder), livePos(folder) }。
  // 文件管理器据此复用覆盖分析「原版」卫星弹窗（含星座关联/地图点选），改星后重绘场景。
  grdActions: null,
  libraryTick: 0,
  liveTick: 0   // 3D 页实时刷新关联星位置时自增，驱动文件管理器 GRD 树行经度跟随实时
})

export function setGrdBridge(grdApi, collectGxt, actions) { fileBridge.grd = grdApi; fileBridge.collectGxt = collectGxt || null; fileBridge.grdActions = actions || null }
export function clearGrdBridge() { fileBridge.grd = null; fileBridge.collectGxt = null; fileBridge.grdActions = null }
export function bumpLibrary() { fileBridge.libraryTick++ }
