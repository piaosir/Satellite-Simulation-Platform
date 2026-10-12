// 3D 坐标轴图层（src/viz/globe3d/refAxes.js）的纯函数部分：
//   ① 赤道面同心环的半径档（间距随外缘取 0.5 / 1 / 2 R⊕，不画地表那一环、不贴外缘）
//   ② 轴端字标排位（沿轴的屏幕方向排在锥尖外侧，近边离锥尖 gap）与避让（相撞沿自己的轴外推到刚好不撞）
//   ③ 实体箭头几何：顶点 / 索引数，三角形绕向一律「从外面看逆时针」（材质是 FrontSide，绕反了那片面就不画）
//      —— 顶点着色器把像素折成世界长度后的摆位，这里按「各点同一个像素尺度」照式摆一遍，量每片面的几何法向朝不朝外

import * as THREE from 'three'
import { eqRingRadii, labelOffset, clearAlong, arrowGeometry, REF_LEN_RANGE, REF_AXES_DEF } from '../../../src/viz/globe3d/refAxes.js'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const section = (t) => console.log('\n— ' + t)
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol

section('轴长范围与出厂值')
ok(REF_LEN_RANGE[0] === 1.1 && REF_LEN_RANGE[1] === 10, '轴长范围 = [1.1, 10] R⊕', JSON.stringify(REF_LEN_RANGE))
ok(REF_AXES_DEF.len >= REF_LEN_RANGE[0] && REF_AXES_DEF.len <= REF_LEN_RANGE[1], '出厂轴长落在范围内')
ok(/^#[0-9a-f]{6}$/.test(REF_AXES_DEF.ecefColor) && /^#[0-9a-f]{6}$/.test(REF_AXES_DEF.j2000Color) && REF_AXES_DEF.ecefColor !== REF_AXES_DEF.j2000Color, '两套坐标系出厂颜色合法且不同')

section('赤道面同心环')
const eqCases = [[1.1, []], [1.5, []], [2, [1.5]], [2.5, [1.5, 2]], [3, [2]], [6, [2, 3, 4, 5]], [6.5, [2, 4]], [10, [2, 4, 6, 8]]]
for (const [L, want] of eqCases) {
  const got = eqRingRadii(L)
  ok(JSON.stringify(got) === JSON.stringify(want), `L = ${L}：环 ${JSON.stringify(want)}`, JSON.stringify(got))
}
for (let L = REF_LEN_RANGE[0]; L <= REF_LEN_RANGE[1] + 1e-9; L += 0.1) {
  const rs = eqRingRadii(L)
  ok(rs.every((r) => r > 1 && r < L), `L = ${L.toFixed(1)}：环全在 (1, L) 内`, JSON.stringify(rs))
  ok(rs.length <= 5, `L = ${L.toFixed(1)}：环数 ≤ 5（不糊成一片）`, String(rs.length))
}

section('字标排位')
{
  let [x, y] = labelOffset(1, 0, 40, 12, 5)
  ok(near(x, 25) && near(y, 0), '朝右：近边离锚点 gap（框心 = gap + 半宽）', `${x}, ${y}`)
  ;[x, y] = labelOffset(0, 1, 40, 12, 5)
  ok(near(x, 0) && near(y, 11), '朝上：框心 = gap + 半高', `${x}, ${y}`)
  ;[x, y] = labelOffset(-0.6, -0.8, 40, 12, 5)
  ok(near(x, -7.5) && near(y, -10), '斜向：按先碰到的那条边算（这里是上下边：6 / 0.8 = 7.5）', `${x}, ${y}`)
  // 轴线（自锚点沿方向延长）恰在 gap 处进框：gap 之前在框外（杆与锥尖不进字面），gap 之后在框内
  for (const [ux, uy] of [[0.8, 0.6], [Math.SQRT1_2, -Math.SQRT1_2], [-0.28, 0.96], [-1, 0]]) {
    const w = 30, h = 14, g = 5
    ;[x, y] = labelOffset(ux, uy, w, h, g)
    const inBox = (s) => Math.abs(ux * s - x) <= w / 2 && Math.abs(uy * s - y) <= h / 2
    ok(!inBox(g - 0.01) && inBox(g + 0.01), `方向 (${ux.toFixed(2)}, ${uy.toFixed(2)})：轴线在 gap 处进框`)
  }
}

section('字标避让')
{
  const rects = [{ x: 0, y: 0, w: 40, h: 12 }]
  let [cx, cy] = clearAlong(0, 0, 0, 1, 40, 12, rects)
  ok(near(cx, 0) && cy > 13 - 1e-6 && cy < 13.1, '完全重合、朝上：推到刚好不撞（高 12 + 间隙 1）', `${cx}, ${cy}`)
  ;[cx, cy] = clearAlong(0, 0, 1, 0, 40, 12, rects)
  ok(cx > 41 - 1e-6 && cx < 41.1 && near(cy, 0), '完全重合、朝右：推一个框宽', `${cx}, ${cy}`)
  ;[cx, cy] = clearAlong(100, 0, 0, 1, 40, 12, rects)
  ok(near(cx, 100) && near(cy, 0), '不相撞：原地不动', `${cx}, ${cy}`)
  // 斜向：只要在 x 或 y 任一向上错开即可，取先到的那个
  ;[cx, cy] = clearAlong(0, 0, Math.SQRT1_2, Math.SQRT1_2, 40, 12, rects)
  ok(near(cy, cx) && cy > 13 - 1e-6 && cy < 13.1, '斜 45°：y 向先错开（13 < 41）', `${cx}, ${cy}`)
  // 两套 Z 轴：三枚字标沿同一方向依次堆叠，互不相撞
  const placed = []
  for (let i = 0; i < 3; i++) {
    const [px, py] = clearAlong(0, 20, 0, 1, 50, 14, placed)
    placed.push({ x: px, y: py, w: 50, h: 14 })
  }
  const clash = placed.some((a, i) => placed.some((b, j) => i < j && Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2))
  ok(!clash && placed[2].y > placed[1].y && placed[1].y > placed[0].y, '同方向三枚：依次外推、互不相撞', JSON.stringify(placed.map((p) => +p.y.toFixed(2))))
}

section('实体箭头几何')
{
  const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0.3, 0.9, 0.2).normalize()]
  const g = arrowGeometry(dirs.map((d) => ({ tip: d.clone().multiplyScalar(2.5), color: new THREE.Color('#f0a43c') })))
  const nV = g.getAttribute('position').count, nI = g.getIndex().count
  const SEG = (nV / dirs.length - 1) / 5
  ok(Number.isInteger(SEG) && SEG >= 12, '每根箭头 5 圈 × SEG + 封盖中心 1 个顶点', `nV = ${nV}`)
  ok(nI === dirs.length * SEG * 12, '每段：杆 2 片 + 锥面 1 片 + 封盖 1 片', `nI = ${nI}`)
  const col = g.getAttribute('aCol')
  const c0 = new THREE.Color('#f0a43c')
  ok(near(col.getX(0), c0.r, 1e-6) && near(col.getY(0), c0.g, 1e-6) && near(col.getZ(0), c0.b, 1e-6), '顶点色 = 线性空间的箭头色（出帧时 colorspace_fragment 转回 sRGB）')
  // 照顶点着色器的式子摆位（各点同一像素尺度 w，世界 = 视空间）：杆半径 / 锥长 / 锥底半径 = 1.25 / 15 / 5.2 px
  const pos = g.getAttribute('position'), rad = g.getAttribute('aRad'), kind = g.getAttribute('aKind'), idx = g.getIndex()
  const w = 0.004, S = [1.25, 15, 5.2]
  const P = [], K = [], D = []
  for (let i = 0; i < nV; i++) {
    const T = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))
    const dir = T.clone().normalize(), r = new THREE.Vector3(rad.getX(i), rad.getY(i), rad.getZ(i))
    const hl = S[1] * w, hr = S[2] * w, B = T.clone().addScaledVector(dir, -hl), k = kind.getX(i)
    let p
    if (k < 0.5) p = r.clone().multiplyScalar(S[0] * w)
    else if (k < 1.5) p = B.clone().addScaledVector(r, S[0] * w)
    else if (k < 2.5) p = B.clone().addScaledVector(r, hr)
    else if (k < 3.5) p = T.clone()
    else if (k < 4.5) p = B.clone().addScaledVector(r, hr)
    else p = B.clone()
    P.push(p); K.push(k); D.push(dir)
    ok(Math.abs(r.dot(dir)) < 1e-6, `顶点 ${i}：径向垂直于轴`)
  }
  let bad = 0
  for (let t = 0; t < nI; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2)
    const n = P[b].clone().sub(P[a]).cross(P[c].clone().sub(P[a]))
    const dir = D[a], ctr = P[a].clone().add(P[b]).add(P[c]).multiplyScalar(1 / 3)
    const isCap = K[a] > 3.5 && K[b] > 3.5 && K[c] > 3.5
    const out = isCap ? dir.clone().negate() : ctr.clone().addScaledVector(dir, -ctr.dot(dir))   // 封盖朝后；其余离轴朝外
    if (!(n.dot(out) > 0)) bad++
  }
  ok(bad === 0, '全部三角形从外面看逆时针（FrontSide 下不缺面）', `${bad} 片绕反`)
}

console.log(`\nrefAxes：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
