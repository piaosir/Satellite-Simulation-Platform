// 地球自转（惯性视角）与拖拽灵敏度的纯数学。不依赖 three / DOM，故可直接单测（见
// packages/core/test/earthSpin.test.mjs）；scene.js 只负责把结果施加到相机上。
//
// ★ 自转角速度不是参数。两拍之间地球转过的角度【恒等于】两拍 GMST 之差，由 satellite.js 的
//   sat.gstime 算出 —— 与星位、晨昏线同一个函数、同一个相位。于是恒星日 86164.0905 s、
//   360.9856°/日、15.041°/h 是算出来的，不是填出来的：界面上没有速度旋钮，这里也没有可调系数。
//   快慢只随时间轴的步长 / 倍速 / 跳转走（实时档 1 Hz 每拍 0.0042°，播放 ×600 步长 60 s 每拍 0.25°）。

const TAU = Math.PI * 2

// 角度回绕到 (−π, π]
export function wrapToPi(a) {
  if (!Number.isFinite(a)) return 0
  let x = a % TAU
  if (x > Math.PI) x -= TAU
  else if (x <= -Math.PI) x += TAU
  return x
}

// 一拍的地球自转增量（弧度，东转为正）= wrapToPi(GMST 本拍 − GMST 上一拍)。
// ★ 必须回绕：拖游标 / 「跳到时刻」可以一步跨 3 天，而「地球该朝哪」只由回绕后的那个小角决定 ——
//   多转的整圈在画面上不可区分，硬转三圈只是把相机甩晕一遍再回到同一个位置。
export function spinDelta(prevGmst, gmst) {
  if (!Number.isFinite(prevGmst) || !Number.isFinite(gmst)) return 0
  return wrapToPi(gmst - prevGmst)
}

// 距离感知的旋转灵敏度（喂给 OrbitControls.rotateSpeed）：让「抓住的地面点跟着指针走」。
//
// 推导：屏幕中心处地面离相机 d−1（地球半径 = 1），每像素的世界位移是
//   2(d−1)·tan(fov/2) / H，除以半径 1 即所需的地心角（弧度/像素）；
// 而 OrbitControls 每像素转 2π·rotateSpeed / H 弧度。两者相等即得下式（H 约掉，与分辨率无关）。
//
// d=3（默认距离）→ 0.244，满屏高拖一次转 88°，地面恰好跟指针走；d=1.15（贴地）→ 0.018；
// d ≥ 5.1 → 封顶 0.5（拉远后与改造前逐位一致，不至于一拖就翻过去）。
export function rotateSpeedFor(d, fovDeg) {
  const dist = Number(d), fov = Number(fovDeg)
  if (!Number.isFinite(dist) || !Number.isFinite(fov)) return 0.5
  const v = Math.max(0, dist - 1) * Math.tan(fov * Math.PI / 360) / Math.PI
  return Math.max(0.005, Math.min(0.5, v))
}
