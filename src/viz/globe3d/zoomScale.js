// 3D 球上符号「随缩放联动」的尺子（单一真值源）：相机离地心 ZOOM_REF_DIST（地球半径）时，符号 = 它设定的像素大小；
// 拉近变大、拉远变小 —— 屏幕像素 = 设定像素 × ZOOM_REF_DIST / 相机距离，与国家名 / 省名这类世界尺寸的地名同步缩放。
// 这个距离就是出厂开场机位（scene.js：camera 在 3.0 倍地球半径处），所以「设定像素」＝默认视角下看到的大小。
//
// 两档系数，按「顶替的是哪一种符号」取，模型图标与它交叉淡化的那枚符号、让位的那行文字在任何缩放下都同一把尺：
//   · markerZoomK：标记精灵 / 地名 / 标记文字（scene.rescaleMarkers）—— 不夹；实体模型图标（entityLayer，顶替站 / 点 / 载具精灵）跟它走。
//   · pointZoomK：聚焦星点 / 在轨点这类贴图点层（scene.rescalePointLayers）—— 夹在 0.35 … 6（拉到很远星也还认得出）；
//     卫星模型图标（modelLayer，顶替的正是这层点）跟它走；终点星画着模型图标时链路箭头让图标（scene uIconK）也跟它走。
// 相机靶心恒为地心（scene.js enablePan = false），「相机距离」= |camera.position|。
// 跟随卫星时相机贴着主星（离地心 1.0x 个地球半径），照原式算等于放大 3 倍：跟随期间一律按基准距离的 1 / FOLLOW_ZOOM_K 算
// （scene.zoomDist 的星点 / 在轨点 / 标记、其他聚焦星的模型图标、链路箭头让位同一把尺）。
export const ZOOM_REF_DIST = 3.0
export const FOLLOW_ZOOM_K = 0.55
const POINT_K_MIN = 0.35, POINT_K_MAX = 6

/** 标记精灵 / 文字 / 实体模型图标的联动系数（不夹） */
export function markerZoomK(dist) {
  return ZOOM_REF_DIST / Math.max(1e-6, dist)
}
/** 贴图点层 / 卫星模型图标的联动系数（夹在 0.35 … 6） */
export function pointZoomK(dist) {
  const k = ZOOM_REF_DIST / Math.max(1e-6, dist)
  return k < POINT_K_MIN ? POINT_K_MIN : (k > POINT_K_MAX ? POINT_K_MAX : k)
}
/** 跟随卫星期间「缩放联动」用的相机距离（scene.zoomDist 跟随档） */
export const FOLLOW_ZOOM_DIST = ZOOM_REF_DIST / FOLLOW_ZOOM_K
/** 跟随卫星期间贴图点层的联动系数（= pointZoomK(FOLLOW_ZOOM_DIST)）：点云 / 在轨点退成近景的背景细点 */
export const FOLLOW_POINT_K = pointZoomK(FOLLOW_ZOOM_DIST)
/**
 * 跟随卫星期间别的聚焦星的模型图标（及链路箭头让它的那一圈）的联动系数：取 1 ＝「图标大小」设定值本身（默认视角下的样子）。
 * 不跟点层一起退成 0.55：聚焦星是用户点名要看的前景对象，按 0.55 画出来只有十几像素、比高亮环还小一圈，一网星只剩一道横杠
 */
export const FOLLOW_ICON_K = 1
