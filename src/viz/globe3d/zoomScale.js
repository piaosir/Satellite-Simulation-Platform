// 3D 球上符号「随缩放联动」的尺子（单一真值源）：相机离地心 ZOOM_REF_DIST（地球半径）时，符号 = 它设定的像素大小；
// 拉近变大、拉远变小 —— 屏幕像素 = 设定像素 × ZOOM_REF_DIST / 相机距离，与国家名 / 省名这类世界尺寸的地名同步缩放。
// 这个距离就是出厂开场机位（scene.js：camera 在 3.0 倍地球半径处），所以「设定像素」＝默认视角下看到的大小。
//
// 两档系数，按「顶替的是哪一种符号」取，模型图标与它交叉淡化的那枚符号、让位的那行文字在任何缩放下都同一把尺：
//   · markerZoomK：标记精灵 / 地名 / 标记文字（scene.rescaleMarkers）—— 不夹；实体模型图标（entityLayer，顶替站 / 点 / 载具精灵）跟它走。
//   · pointZoomK：聚焦星点 / 在轨点这类贴图点层（scene.rescalePointLayers）—— 夹在 0.35 … 6（拉到很远星也还认得出）；
//     卫星模型图标（modelLayer，顶替的正是这层点）跟它走。
// 相机靶心恒为地心（scene.js enablePan = false），「相机距离」= |camera.position|；跟随卫星时模型图标不画，不涉及。
export const ZOOM_REF_DIST = 3.0
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
