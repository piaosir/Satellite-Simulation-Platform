import { reactive } from 'vue'

// 覆盖图入口（顶栏「视图」按钮右侧）：由 3D 球体页在挂载时注册可用性与切换回调、卸载时复位。
// 顶栏据 avail 显隐按钮、据 *Open 高亮，点击调用对应 toggle 回调切换 3D 页内的覆盖面板。
//  - grdAvail/covAvail：当前在 3D 页且对应 API 可用
//  - grdOpen/covOpen：面板开关（3D 页用 toRef 直接读写，顶栏据此高亮）
//  - toggleGrd/toggleCov：切换回调（由 3D 页注入；含懒加载等逻辑）
export const covNav = reactive({
  grdAvail: false, covAvail: false, polyAvail: false,
  grdOpen: false, covOpen: false, polyOpen: false,
  toggleGrd: null, toggleCov: null, togglePoly: null,
  // 导出入口（顶栏「导出图」）：在 3D 页注册 exportMap('png2'|'png4'|'png6'|'pdf')，离开页面复位
  exportAvail: false, exportMap: null,
  // 发送到小程序入口（顶栏「导出」菜单）：3D 页注册 sendMiniapp()（构建快照→上传COS→弹密钥），离开页面复位
  sendMiniapp: null,
  // 导入 TLE 入口（「文件」菜单）：3D 页注册 importTle() 打开本地 CSV 选择器（原「加载」弹窗移除后的离线兜底），离开页面复位
  importTle: null
})
