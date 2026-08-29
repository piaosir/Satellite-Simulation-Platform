// 航迹载具符号：船舶 / 飞机的俯视矢量剪影，2D 平面图（flatmap/flatCoverage.js）与 3D 球体
// （globe3d/scene.js）共用的单一真值源 —— 同 stationSymbol.js 的用意，几何只写一处。
//
// 与地球站符号的两点不同：
//   ① 单色件。船/机要跟着航迹线的颜色走（航行 #ff6a4a / 飞行 #5ad1ff），故形状与颜色分开，
//      填充色由调用方给；地球站那枚是 Noto 的固定六色插画，改不了颜色。
//   ② 要转向。图形一律「船首 / 机头朝正上（北）」画在 128 视框里、锚点＝视框中心 (64,64)，
//      由调用方按航迹末段的走向旋转（2D 转画布、3D 转 sprite.material.rotation）。
//
// ★ 形状存成命令数组、两边都走 canvas 回放（3D 那张贴图也是现画在 canvas 上的），有两条理由：
//   ① 2D 侧不能用 Path2D —— 导出 PDF 走 svgcanvas 回放，它忽略 Path2D 入参（见 flatCoverage.js
//      的 compat 注释），只能逐段 moveTo/lineTo/曲线重放；
//   ② 3D 侧若走「SVG → Image → Texture」，贴图是【异步】就位的：图片没回来那一帧上传的是空图，
//      要靠后面的帧补传。地球站图标能这么干是因为主窗口逐帧渲染，而出图/离屏只渲有限几帧，
//      图标就会整个不出现。canvas 现画现有，同步。

export const VEHICLE_VB = 128                        // 符号画布边长（正方形，两处都按 s×s 铺）
export const VEHICLE_CASE = 'rgba(6,11,18,0.82)'     // 套色描边：与 drawText 的文字描边、地球站符号同一套
export const VEHICLE_CASE_W = 4.5                    // 描边宽（128 视框下）≈ 28px 档的 1.0 px

// 船舶（俯视）：尖首 + 平行舯体 + 收进去的方尾（艉封板），长宽比 ≈ 2.3:1 —— 船形靠这一收一放
// 认出来：只画个圆头长条就成了子弹。尾部那块深色是上层建筑（驾驶室），缩到 20 px 上下时它是
// 唯一还分得清首尾的细节，故保留。
const SHIP_BODY = [
  ['M', 64, 8], ['C', 73, 25, 88, 47, 88, 63], ['L', 88, 99], ['L', 81, 115], ['Q', 80, 119, 76, 119],
  ['L', 52, 119], ['Q', 48, 119, 47, 115], ['L', 40, 99], ['L', 40, 63], ['C', 40, 47, 55, 25, 64, 8], ['Z']
]
const SHIP_DECK = [['M', 53, 74], ['L', 75, 74], ['L', 75, 99], ['L', 53, 99], ['Z']]

// 飞机（俯视）：机头 + 后掠翼 + 平尾，民航客机平面形。整体左右对称于 x=64（成对的
// 72/56、122/6、84/44 都以 64 为中），纵向 7~121 也居中于 64 —— 锚点即视框中心。
const PLANE_BODY = [
  ['M', 64, 7], ['C', 68.4, 7, 72, 13.3, 72, 21],
  ['L', 72, 51], ['L', 122, 83], ['L', 122, 94], ['L', 72, 79],
  ['L', 72, 103], ['L', 84, 112], ['L', 84, 121], ['L', 64, 115],
  ['L', 44, 121], ['L', 44, 112], ['L', 56, 103], ['L', 56, 79],
  ['L', 6, 94], ['L', 6, 83], ['L', 56, 51], ['L', 56, 21],
  ['C', 56, 13.3, 59.6, 7, 64, 7], ['Z']
]

// kind 归一：航迹只有「飞行 / 航行」两种，非 flight 一律按船（与 trajKindOf 同口径）
const shapeOf = (kind) => (kind === 'flight'
  ? { body: PLANE_BODY, details: [] }
  : { body: SHIP_BODY, details: [SHIP_DECK] })

// 命令数组 → canvas 子路径回放（不建 Path2D，导出兼容模式下同样成立）
function trace(ctx, cmds) {
  ctx.beginPath()
  for (const c of cmds) {
    if (c[0] === 'M') ctx.moveTo(c[1], c[2])
    else if (c[0] === 'L') ctx.lineTo(c[1], c[2])
    else if (c[0] === 'C') ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6])
    else if (c[0] === 'Q') ctx.quadraticCurveTo(c[1], c[2], c[3], c[4])
    else if (c[0] === 'Z') ctx.closePath()
  }
}

/**
 * 2D：把符号画在 (x, y)，边长 size、顺时针旋转 rot 弧度（rot=0 即船首/机头朝屏幕正上方）。
 * 描边宽写在 128 视框里，随 size 一起缩 —— 图标小的时候描边跟着细，不会糊成一团黑。
 */
export function drawVehicle(ctx, kind, x, y, size, rot, color) {
  const { body, details } = shapeOf(kind)
  const s = size / VEHICLE_VB
  ctx.save()
  ctx.translate(x, y); ctx.rotate(rot || 0); ctx.scale(s, s); ctx.translate(-VEHICLE_VB / 2, -VEHICLE_VB / 2)
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'
  ctx.fillStyle = color || '#ffffff'; ctx.strokeStyle = VEHICLE_CASE; ctx.lineWidth = VEHICLE_CASE_W
  trace(ctx, body); ctx.fill(); ctx.stroke()
  ctx.fillStyle = VEHICLE_CASE
  for (const d of details) { trace(ctx, d); ctx.fill() }
  ctx.restore()
}

/**
 * 3D：同一枚符号画进一张正方形离屏画布，供 sprite 当贴图用（同步返回，无需等图片加载）。
 * px 是贴图边长：sprite 上屏一般 20~40 px，出图最多再放大 6 倍，256 够用且只占 256 KB。
 */
export function vehicleCanvas(kind, ink, px) {
  const n = px || 256
  const cv = document.createElement('canvas'); cv.width = cv.height = n
  drawVehicle(cv.getContext('2d'), kind, n / 2, n / 2, n, 0, ink)
  return cv
}

/**
 * 航迹末段在【等经纬平面】上的走向（弧度，0＝正北，顺时针为正），供 2D 旋转图标用。
 * 刻意不取大圆真方位：2D 的航迹折线就是按经纬度直连画的，图标要与画出来的那条线贴合；
 * 高纬度上真方位与图上走向能差出几十度，按真方位摆图标会明显歪出线外。3D 那边线是大圆，
 * 故 3D 走球面切向（见 scene.js setTrajectories），两视图各自与自己的线对齐。
 */
export function flatHeading(a, b) {
  if (!a || !b) return 0
  const dLon = ((b.lon - a.lon + 540) % 360) - 180   // 跨 ±180° 接缝时不整圈翻过去
  const dLat = b.lat - a.lat
  if (Math.abs(dLon) < 1e-9 && Math.abs(dLat) < 1e-9) return 0
  return Math.atan2(dLon, dLat)
}
