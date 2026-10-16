// 地图对象选中 / 拖放落点高亮：四角括号（Cesium SelectionIndicator 口径），2D 平面图与 3D 球体同一副画法
// （2D 直接画在实时层，3D 烘进精灵贴图）。2026-10-16 用户在八档对比台里选定「四角括号 · 白」：
// 不遮符号、不像又一枚地图符号（圆环会和站点 / 覆盖圈混读），白线 + 暗套边在影像与浅色矢量底上都立得住。
// ★ 不加光晕 / 渐变（图上发光类效果已被判不专业），颜色不跟界面机位色（低彩度蓝落在影像上读不出）。
// ★ 框贴符号【实际画出来的外接框】（宽高各算，不取包围圆直径）：用户嫌按直径取方框空隙太大 —— 扁长的车 / 船
//   上下会空出一大截。两端调用方各自给出宽高（2D：模型俯视图的裁边外廓 / 剪影转角后的外接框 / 站符号外廓；
//   3D：模型包围盒八角投影 / 精灵剪影外接框）。
export const SEL_MARK_COLOR = '#ffffff'
const CASE = 'rgba(6,11,18,0.7)'
const CASE_W = 3.6, LINE_W = 1.6
const GAP = 3        // 括号离符号外廓的空隙（CSS px）
const MIN_HALF = 7   // 符号再小，括号框也不小于 14 px 见方的那一圈
// 括号框半边长（CSS px）：符号这一向的外廓长度 len → 半边 + 空隙
export const selHalf = (len) => Math.max((Number(len) || 0) / 2, MIN_HALF) + GAP
// 套边外扩量（CSS px）：3D 贴图按此留边（方头线帽 + 套边半宽）
export const SEL_MARK_PAD = 4

export function strokeSelBrackets(ctx, x, y, hw, hh, color) {
  const len = Math.max(4, Math.min(10, Math.round(Math.min(hw, hh) * 0.6)))
  ctx.save()
  ctx.lineCap = 'square'; ctx.lineJoin = 'miter'
  for (const [w, c] of [[CASE_W, CASE], [LINE_W, color || SEL_MARK_COLOR]]) {
    ctx.lineWidth = w; ctx.strokeStyle = c
    ctx.beginPath()
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.moveTo(x + sx * hw, y + sy * (hh - len))
      ctx.lineTo(x + sx * hw, y + sy * hh)
      ctx.lineTo(x + sx * (hw - len), y + sy * hh)
    }
    ctx.stroke()
  }
  ctx.restore()
}
