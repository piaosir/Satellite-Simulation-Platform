// 航迹载具符号（船舶 / 飞机）自测：运行 npm test
//
// 两件事在 Node 里验得动，且错了在图上不容易一眼看穿：
//   ① flatHeading 的【正负号与零位】。0＝正北、顺时针为正，是 2D 画布 ctx.rotate 的口径；
//      符号一反，船首就朝着来路；差 90° 则整条航迹上的图标全部横着走。跨 ±180° 接缝那条
//      更隐蔽 —— 不归化到 (−180,180] 时，从 179°E 走到 179°W 会被算成「向西掉头 358°」。
//   ② 形状的画布边界与左右对称。符号连同套色描边必须整个落在 0..128 视框里（3D 那张贴图按
//      视框铺满一张正方画布，出框就被切掉一块），飞机还必须严格对称于 x=64 —— 不对称的话
//      转起来会像偏舵，而肉眼在 20 px 上看不出来。
import { drawVehicle, flatHeading, VEHICLE_VB, VEHICLE_CASE_W } from '../../../src/viz/vehicleSymbol.js'

let pass = 0, fail = 0
const ok = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const DEG = 180 / Math.PI

// ── ① 朝向 ────────────────────────────────────────────────────────────────
const hdg = (a, b) => flatHeading(a, b) * DEG
const P = (lat, lon) => ({ lat, lon })
ok('正北 = 0°', near(hdg(P(0, 0), P(10, 0)), 0))
ok('正东 = +90°', near(hdg(P(0, 0), P(0, 10)), 90))
ok('正南 = 180°', near(Math.abs(hdg(P(0, 0), P(-10, 0))), 180))
ok('正西 = −90°', near(hdg(P(0, 0), P(0, -10)), -90))
ok('东北 = +45°', near(hdg(P(0, 0), P(10, 10)), 45))
ok('西南 = −135°', near(hdg(P(0, 0), P(-10, -10)), -135))
// 图上走向不是大圆真方位：高纬度同样的 Δ经Δ纬 仍出 45°（2D 的航迹线就是按经纬直连画的，图标要贴着它）
ok('高纬仍按图上走向（不折 cosφ）', near(hdg(P(70, 0), P(80, 10)), 45), '真方位约 62°')
// 跨 ±180° 接缝：179°E → 179°W 是继续向东 1°，不是掉头向西 359°
ok('跨接缝向东', near(hdg(P(0, 179), P(0, -179)), 90))
ok('跨接缝向西', near(hdg(P(0, -179), P(0, 179)), -90))
ok('单点航迹（无前一点）→ 0', flatHeading(undefined, P(10, 20)) === 0)
ok('重合两点 → 0', flatHeading(P(10, 20), P(10, 20)) === 0)

// ── ② 形状 ───────────────────────────────────────────────────────────────
// 桩 ctx：只记坐标。drawVehicle 传进来的是「视框坐标 × 缩放矩阵」，这里把缩放/平移设成恒等
// （size = VEHICLE_VB、rot = 0、落点 = 视框中心），于是记到的就是视框里的原坐标。
function traceOf(kind) {
  const pts = []
  const push = (...xy) => { for (let i = 0; i < xy.length; i += 2) pts.push([xy[i], xy[i + 1]]) }
  let filled = 0, stroked = 0
  const ctx = {
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, closePath() {},
    moveTo: push, lineTo: push,
    bezierCurveTo: push, quadraticCurveTo: push,
    fill() { filled++ }, stroke() { stroked++ }
  }
  drawVehicle(ctx, kind, VEHICLE_VB / 2, VEHICLE_VB / 2, VEHICLE_VB, 0, '#ff6a4a')
  return { pts, filled, stroked }
}
const M = VEHICLE_CASE_W / 2   // 描边向外胀出半个线宽
for (const kind of ['sea', 'flight']) {
  const { pts, filled, stroked } = traceOf(kind)
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  ok(kind + '：有路径', pts.length > 6, pts.length + ' 点')
  ok(kind + '：填了色并描了边', filled >= 1 && stroked === 1, `fill×${filled} stroke×${stroked}`)
  ok(kind + '：连描边整个在视框内', x0 - M >= 0 && y0 - M >= 0 && x1 + M <= VEHICLE_VB && y1 + M <= VEHICLE_VB,
    `x ${x0}~${x1} y ${y0}~${y1}`)
  // 首尾要占住视框的大半，否则同样的 size 下看着比地球站图标小一圈
  ok(kind + '：纵向占比 ≥ 80%', (y1 - y0) / VEHICLE_VB >= 0.8, ((y1 - y0) / VEHICLE_VB * 100).toFixed(0) + '%')
  // 左右对称于 x=64：逐点找镜像点（贝塞尔控制点也在内，故按集合比对）
  const key = (p) => p[0].toFixed(3) + ',' + p[1].toFixed(3)
  const set = new Set(pts.map(key))
  const asym = pts.filter((p) => !set.has(key([VEHICLE_VB - p[0], p[1]])))
  ok(kind + '：左右对称于中轴', asym.length === 0, asym.length ? JSON.stringify(asym[0]) : '')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
