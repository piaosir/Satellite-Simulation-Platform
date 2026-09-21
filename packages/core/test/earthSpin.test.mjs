// 地球自转增量与距离感知旋转灵敏度自测（src/viz/globe3d/earthSpin.js）。运行：npm test
//
// 这两个函数各钉死一条口径：
//   ① spinDelta —— 自转角速度【不是参数】，就是两拍 GMST 之差。恒星日 360.9856°/日 是算出来的，
//      所以这里只用得着一个判据：给一小时的 GMST 增量，必须得到 15.041°，不多不少。
//      跨 2π 与跳时刻要回绕：跳 3 天不许转三圈（多转的整圈画面上不可区分，硬转只是把相机甩一遍）。
//   ② rotateSpeedFor —— 「抓住的地面点跟着指针走」那条解析式，四个距离档对上就算对。
import { wrapToPi, spinDelta, rotateSpeedFor } from '../../../src/viz/globe3d/earthSpin.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const DEG = 180 / Math.PI
const near = (a, b, eps) => Math.abs(a - b) <= eps

// GMST 的角速度：恒星日 86164.0905 s 转一整圈
const OMEGA = 2 * Math.PI / 86164.0905     // rad/s
const gmstAfter = (g0, sec) => g0 + OMEGA * sec

// ==================== ① wrapToPi ====================
{
  ok('① 0 不动', wrapToPi(0) === 0)
  ok('① π 保持', near(wrapToPi(Math.PI), Math.PI, 1e-12))
  ok('① −π 归到 +π', near(wrapToPi(-Math.PI), Math.PI, 1e-12), `${wrapToPi(-Math.PI)}`)
  ok('① 3π → π', near(wrapToPi(3 * Math.PI), Math.PI, 1e-9))
  ok('① 2π + 0.1 → 0.1', near(wrapToPi(2 * Math.PI + 0.1), 0.1, 1e-9))
  ok('① −2π − 0.1 → −0.1', near(wrapToPi(-2 * Math.PI - 0.1), -0.1, 1e-9))
  ok('① 非数 → 0', wrapToPi(NaN) === 0 && wrapToPi(undefined) === 0)
}

// ==================== ② 一小时 = 15.041° ====================
{
  const g0 = 1.2345
  const d = spinDelta(g0, gmstAfter(g0, 3600)) * DEG
  ok('② 1 h → 15.041°', near(d, 15.04106864, 1e-6), `${d.toFixed(8)}°`)

  const d1 = spinDelta(g0, gmstAfter(g0, 1)) * DEG
  ok('② 实时档 1 拍（1 s）→ 0.00418°', near(d1, 15.04106864 / 3600, 1e-9), `${d1.toFixed(8)}°`)

  const d60 = spinDelta(g0, gmstAfter(g0, 60)) * DEG
  ok('② 播放档 1 拍（步长 60 s）→ 0.2507°', near(d60, 15.04106864 / 60, 1e-9), `${d60.toFixed(6)}°`)

  // 一恒星日整：回绕后是 0，不是 360°
  const dDay = spinDelta(g0, gmstAfter(g0, 86164.0905)) * DEG
  ok('② 整一恒星日 → 0°（不是 360°）', Math.abs(dDay) < 1e-6, `${dDay.toExponential(2)}°`)
}

// ==================== ③ 跨 2π 不翻 ====================
{
  // 上一拍 GMST 落在 2π 前一点点，本拍绕过 0：原始差是 −2π+ε，回绕后必须是 +ε
  const prev = 2 * Math.PI - 1e-3
  const now = 1e-3                          // 已经绕回来（gstime 返回 [0,2π)）
  const d = spinDelta(prev, now)
  ok('③ 跨 2π 接缝不反向', d > 0 && near(d, 2e-3, 1e-12), `${d.toExponential(3)} rad`)
}

// ==================== ④ 跳时刻：+3 天不转三圈 ====================
{
  const g0 = 0.7
  const sec = 3 * 86400
  const raw = OMEGA * sec                                      // ≈ 3.008 圈
  const d = spinDelta(g0, gmstAfter(g0, sec))
  ok('④ 跳 +3 天：原始增量确实超过 3 圈', raw > 3 * 2 * Math.PI, `${(raw / (2 * Math.PI)).toFixed(4)} 圈`)
  ok('④ 回绕后落在 (−π, π]', d > -Math.PI && d <= Math.PI, `${(d * DEG).toFixed(4)}°`)
  ok('④ 回绕后 = 原始增量的小数圈部分', near(d, wrapToPi(raw), 1e-9), `${(d * DEG).toFixed(4)}° vs ${(wrapToPi(raw) * DEG).toFixed(4)}°`)
  // 反向跳回去，增量取反
  const back = spinDelta(gmstAfter(g0, sec), g0)
  ok('④ 跳回来是等大反号', near(back, -d, 1e-9), `${(back * DEG).toFixed(4)}°`)
}

// ==================== ⑤ 非数与首拍 ====================
{
  ok('⑤ 首拍（prev 非数）不转', spinDelta(null, 1.0) === 0 && spinDelta(NaN, 1.0) === 0)
  ok('⑤ 本拍非数不转', spinDelta(1.0, NaN) === 0)
}

// ==================== ⑥ 距离感知的旋转灵敏度 ====================
{
  const fov = 42
  const s3 = rotateSpeedFor(3, fov)
  ok('⑥ d=3（默认距离）→ 0.244', near(s3, 0.244, 5e-4), `${s3.toFixed(6)}`)
  // 满屏高拖一次 = 2π·rotateSpeed 弧度
  const fullDeg = 2 * Math.PI * s3 * DEG
  ok('⑥ d=3 满屏拖一次 ≈ 88°', near(fullDeg, 88, 0.5), `${fullDeg.toFixed(2)}°`)

  const s115 = rotateSpeedFor(1.15, fov)
  ok('⑥ d=1.15（贴地）→ 0.018', near(s115, 0.018, 5e-4), `${s115.toFixed(6)}`)

  ok('⑥ d=50（拉到底）封顶 0.5', rotateSpeedFor(50, fov) === 0.5)
  ok('⑥ d=5.1 起即封顶', rotateSpeedFor(5.1, fov) === 0.5, `${rotateSpeedFor(5.1, fov)}`)
  ok('⑥ d=5.0 尚未封顶', rotateSpeedFor(5.0, fov) < 0.5, `${rotateSpeedFor(5, fov).toFixed(6)}`)
  ok('⑥ d=1.001（几乎贴面）下限 0.005', rotateSpeedFor(1.001, fov) === 0.005)
  ok('⑥ d=1（球面上）也不为 0', rotateSpeedFor(1, fov) === 0.005)

  // 单调不减
  let mono = true
  for (let d = 1.02; d < 6; d += 0.02) if (rotateSpeedFor(d, fov) < rotateSpeedFor(d - 0.02, fov) - 1e-12) mono = false
  ok('⑥ 随距离单调不减', mono)

  ok('⑥ 非数回落 0.5（不至于把球锁死）', rotateSpeedFor(NaN, fov) === 0.5 && rotateSpeedFor(3, NaN) === 0.5)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
