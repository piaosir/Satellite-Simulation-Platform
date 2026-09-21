// 3D 球体拖拽的「粘滞跟随」—— 仪器手感。纯数学，不依赖 three / DOM，故可直接单测
//（见 packages/core/test/dragFollow.test.mjs）；scene.js 只负责每帧把 dampingFor 喂给 OrbitControls。
//
// 手感模型：相机的球坐标以一阶粘滞跟随指针的【命令】姿态 —— x' = (x* − x) / τ。
//   · 拖动起步时速度从 0 平滑爬到指针速度，停手时平滑落到 0（阻尼铰链 / 液压云台那种「有分量」）；
//   · 相机【永远不会滑过】指针命令：跟随只会逼近、不会越过，松手后也只是把欠着的那一小段补完
//     —— 没有自由滑行，这是它与「惯性滑行」（Google Earth 那种松手继续转）的本质区别；
//   · 与帧率无关：每帧施加的比例按【真实经过时间】取 1 − e^{−dt/τ}，是 x' = (x* − x)/τ 的精确离散化，
//     30 / 60 / 不限三档跑出的轨迹逐点相同（单测钉到 1e−9）。
//
// 载体是 OrbitControls 自己的 damping 递推（update()：spherical += delta·f；delta *= 1 − f）——
// 它本来就是一阶跟随，病只在 f 是「每次 update 一个常数」（时间常数随帧率变，且默认 0.05 / 早先 0.08
// 换算到 60 fps 是 200~330 ms，拖动中地面落后指针一大截，被用户判为「滑溜」）。这里改成每帧按 dt 现算 f，
// τ 只由「拖拽阻尼」百分比定。
//
// 「拖拽阻尼」百分比 → τ（阻尼铰链的语义：越大越粘、越重、停得越柔；0 = 直连）：
//   τ(p) = TAU_MAX × (p/100)^1.5     p=0 → 0（1:1 直连，无任何滤波）
//                                    p=50（出厂）→ 42 ms：以 90°/s 拖动时地面落后指针 3.8°，停手后 ≈150 ms 停稳
//                                    p=100 → 120 ms：最重的一档（仍远小于早先那 208 ms 的滑溜档）
export const TAU_MAX_MS = 120
export const TAU_CURVE = 1.5

// 滚轮缩放缓动的时间常数：改造前是「每帧向目标逼近 18%」，只在 60 fps 下是这个手感（30 fps 慢一倍、144 Hz
// 快一倍）。1 − e^{−(1/60)/τ} = 0.18 ⇒ τ = 84 ms，60 fps 下逐帧与改造前一致，其它帧率下手感与之相同。
export const ZOOM_TAU_MS = 84

// 阻尼百分比 → 时间常数（秒）。非数按出厂 50 算。
export function tauFor(p) {
  const q = Number(p)
  const v = Number.isFinite(q) ? Math.max(0, Math.min(100, q)) : 50
  return TAU_MAX_MS / 1000 * Math.pow(v / 100, TAU_CURVE)
}

// 一帧该施加「剩余命令」的比例 f = 1 − e^{−dt/τ}。τ ≤ 0 即直连（全额施加）；dt ≤ 0 这一帧什么都不施加。
// 喂给 OrbitControls.dampingFactor：update() 里 spherical += delta·f、delta *= (1 − f)，
// 于是剩余命令按 e^{−t/τ} 精确衰减，与 dt 怎么切无关。
export function dampingFor(dtSec, tauSec) {
  if (!(tauSec > 0)) return 1
  const h = Number(dtSec)
  if (!(h > 0)) return 0
  return 1 - Math.exp(-h / tauSec)
}

// 稳态滞后：以角速度 ω 匀速拖动时，地面落后指针的角度 = ω·τ（连续时间；离散采样下略小，见单测）。
export function lagFor(omega, tauSec) { return (Number(omega) || 0) * Math.max(0, Number(tauSec) || 0) }

// 停手后「剩余角度掉一半」的时间 = τ·ln2（与起手速度无关，是量「帧率无关」最干净的一把尺子）。
export function halfLifeMs(tauSec) { return Math.max(0, Number(tauSec) || 0) * Math.LN2 * 1000 }

// 与 OrbitControls.update() 同一条递推的纯函数版：state = { applied, rem }。每帧先把新命令 inject 加进
// rem，再按 f 施加。单测与验证台拿它当【参考实现】对拍；产品代码里跑的是 OrbitControls 自己那份。
export function stepFollow(state, dtSec, tauSec, inject = 0) {
  const s = state || { applied: 0, rem: 0 }
  s.rem += Number(inject) || 0
  const f = dampingFor(dtSec, tauSec)
  const d = s.rem * f
  s.applied += d
  s.rem -= d
  return s
}
