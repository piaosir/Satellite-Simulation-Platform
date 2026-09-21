// 滚轮缩放的口径：一格滚轮 = 底部状态栏那条缩放读数走 p 个百分点。3D / 2D 各设一档（出厂都是 3）。
//
// 为什么钉在「状态栏读数」上：两张图的缩放本来各走各的指数（3D 是相机距离、2D 是像素/度），
// 一格的「距离倍率」互不可比，用户也看不见；而进度读数 t∈[0,1.2] 是他们【看得见】的同一把尺子，
// 与 ± 按钮的 0.01 步进同刻度。于是「3%」= 一格走 3 个百分点，两张图一个说法，设置里改了立刻能对上。
//
// 不依赖 DOM（只读 WheelEvent 的两个数），故可直接单测（见 packages/core/test/wheelStep.test.mjs）。

// 滚轮事件 → 「格数」。Windows 标准鼠标一格是 deltaY ±100（deltaMode 0，像素）；
// 有的浏览器/驱动给行（deltaMode 1，一格 3 行）或页（deltaMode 2，一格 1 页）。
// 精密触控板 / 平滑滚动把一格拆成若干小事件时按比例累加，攒满 100 像素仍恰好是一格。
export function wheelNotches(e) {
  const dy = Number(e && e.deltaY)
  if (!Number.isFinite(dy) || dy === 0) return 0
  const mode = Number(e && e.deltaMode) || 0
  if (mode === 1) return dy / 3
  if (mode === 2) return dy
  return dy / 100
}

// 按格数推进缩放进度 t。方向不变：滚轮向下（deltaY > 0 → notches > 0）= 缩小 = t 减小。
export function stepZoomT(t, notches, pct, tmax) {
  const t0 = Number(t) || 0
  const n = Number(notches) || 0
  const p = Number.isFinite(Number(pct)) ? Number(pct) : 3
  const hi = Number.isFinite(Number(tmax)) ? Number(tmax) : 1.2
  return Math.max(0, Math.min(hi, t0 - n * p / 100))
}
