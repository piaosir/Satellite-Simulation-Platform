// 模型工作台 X / Y / Z 轴色：全库唯一一处取值（10-14 前端审查：SecFrame / QuickMesh / viewport 原先各写一套）。
// 界面字（步进钮上的 X / Y / Z）走 CSS 变量 --axis-x / -y / -z，由 stores/theme.js 换肤时从这里写到 <html>；
// 三维视口（viewport.js）直接取数值 —— 视口在「太阳」模式下恒为暗底，与界面外观不一定同档，故按视口自己的明暗取。
// 对比度：浅色一档对面板 / 面板头 / 白 ≥ 4.5:1；深色一档对面板 / 面板头 / 抬起钮 ≥ 4.6:1。
export const AXIS_COLORS = {
  light: { x: '#c2433d', y: '#207e4a', z: '#3d5fc4' },
  dark: { x: '#e5736d', y: '#5fbf86', z: '#7f9cf0' }
}

export function axisHex(k, dark) {
  return parseInt(AXIS_COLORS[dark ? 'dark' : 'light'][k].slice(1), 16)
}

export function applyAxisVars(el, dark) {
  const c = AXIS_COLORS[dark ? 'dark' : 'light']
  for (const k of ['x', 'y', 'z']) el.style.setProperty('--axis-' + k, c[k])
}
