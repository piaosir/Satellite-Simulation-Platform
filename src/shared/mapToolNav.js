// 地图工具态的左键分工（2D 平面图 / 3D 球体共用一套口径）。
//
// 工具态＝页面上任一地图工具开着：建链 / 绘制 Polygon·航迹 / 标记调整位置 / Polygon 调顶点·整体拖动 /
// 波束合成放置·调中心·删除 / 站点栅 / 拖拽波束 / 拖动标签 / 拖动调整投影中心 / 卫星点选。横幅里那枚 Shift 键帽说的就是这条：
//   · 左键归工具：按中目标做工具的事；按在空白处地图也不动。过去「别处拖动照常导航」各态口径不一
//     （拖波束按哪都接管、调顶点差两像素没抓中画面就跑、投影中心 / 站点框选干脆没法平移），现在一律收到 Shift 上；
//   · 按住 Shift + 左键拖动＝操作地图（2D 平移 / 3D 转地球），这一下工具不接、抬起也不算点击；
//   · 滚轮缩放、2D 中键平移任何时候照旧。
// 工具态外：左键拖动照常操作地图，带修饰键也一样（Shift / Ctrl 单击仍是加选）。
//
// 不依赖 DOM（只读事件上的几个修饰键），故可直接单测（见 packages/core/test/mapToolNav.test.mjs）。

/** 这一下左键按压归地图（2D 平移 / 3D 转地球）吗。toolOn＝此刻在工具态，e＝PointerEvent（只读修饰键） */
export function leftPressNavigates(toolOn, e) {
  return toolOn ? !!(e && e.shiftKey) : true
}

/**
 * OrbitControls（three r184）左键怎么分派由 mouseButtons.LEFT 定：= ROTATE 时「不带修饰键转、带 Ctrl/⌘/Shift 走平移」，
 * = PAN 时恰好反过来；本项目 enablePan 关着，「走平移」就是什么也不做。按下那一刻按上面的口径挑一档，转不转就由它定。
 * 返回 'rotate' | 'pan'（调用方映射到 THREE.MOUSE.ROTATE / PAN），须在 OrbitControls 自己的 pointerdown 之前设好。
 */
export function orbitLeftMode(toolOn, e) {
  const mod = !!(e && (e.ctrlKey || e.metaKey || e.shiftKey))
  return leftPressNavigates(toolOn, e) === mod ? 'pan' : 'rotate'
}
