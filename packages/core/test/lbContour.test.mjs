// 规则网格等值线（marching squares）与色标的几何/色彩自测。运行：npm test
// 被测文件是渲染端 ESM（src/shared/*.js），故本测试自身也是 .mjs。
//
// 关键不变式：
//   ① 线性场的等值线必须是一条精确的直线（插值一旦写错，线会在格边处成锯齿）；
//   ② 圆形场的等值线必须闭合且半径处处相等；
//   ③ 鞍点格按双线性面的鞍点值消歧（渐近判别）——连错时两条线会在鞍点交叉成 ✕，可行域边界跟着断掉；
//   ④ 含 NaN 的格整格跳过，绝不跨着无解区插出一条不存在的边界；
//   ⑤ 有临界值时，临界线必须恰好落在临界值上（0 dB 余量线差一点点就不是可行边界了）；
//   ⑥ 双三次细化必须穿过每一个真算过的格点、不越出原场的取值范围（细化只补走势，不造数）；
//   ⑦ 去量化对任一格点的改动不得超过半个量化步，且只在场真被取整压成台阶时才动手；
//   ⑧ 抽稀（DP）与原折线的偏离不得超过给定容差。
import {
  contourSegments, stitchSegments, contourLevels, bilinear, fieldExtent, refineField, smoothPathD, labelAnchors,
  detectQuantum, terraceFrac, dequantize, buildBlocks, simplifyDP
} from '../../../src/shared/lbContour.js'
import { buildColorScale, buildStretch, rgbToOklab } from '../../../src/shared/lbColorScale.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const build = (nx, ny, f) => {
  const z = new Float64Array(nx * ny)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = f(i, j)
  return z
}

console.log('=== 设计空间图：等值线与色标测试 ===\n')

// ① 线性场：z = i → level 2.5 的等值线是 x ≡ 2.5 的竖直线
{
  const nx = 9, ny = 7
  const z = build(nx, ny, (i) => i)
  const segs = contourSegments(z, nx, ny, 2.5)
  ok('线性场出等值线', segs.length === ny - 1, `${segs.length} 段`)
  let worst = 0
  for (const s of segs) worst = Math.max(worst, Math.abs(s[0] - 2.5), Math.abs(s[2] - 2.5))
  ok('等值线精确落在 x=2.5', worst < 1e-12, `最大偏差 ${worst.toExponential(1)}`)
  const lines = stitchSegments(segs)
  ok('拼成一条整线', lines.length === 1 && lines[0].length === ny, `${lines.length} 条 / ${lines[0].length} 点`)
}

// ② 圆形场：z = −((i−c)²+(j−c)²) → 等值线是圆
{
  const n = 41, c = 20
  const z = build(n, n, (i, j) => -((i - c) ** 2 + (j - c) ** 2))
  const R = 12.5     // 半径取半整数：圆不过格点，是非退化的常态情形
  const segs = contourSegments(z, n, n, -(R * R))
  let rMin = Infinity, rMax = 0
  for (const s of segs) {
    for (const [x, y] of [[s[0], s[1]], [s[2], s[3]]]) {
      const r = Math.hypot(x - c, y - c)
      rMin = Math.min(rMin, r); rMax = Math.max(rMax, r)
    }
  }
  // 线性插值出来的圆半径有二阶误差，41 格网格上应在 0.5% 以内
  ok('圆形场半径处处相等', (rMax - rMin) / R < 0.005, `r ∈ [${rMin.toFixed(3)}, ${rMax.toFixed(3)}]，标称 ${R}`)
  const lines = stitchSegments(segs)
  const L = lines[0]
  const closed = lines.length === 1 && Math.hypot(L[0][0] - L[L.length - 1][0], L[0][1] - L[L.length - 1][1]) < 1e-9
  ok('等值线闭合成一个环', closed, `${lines.length} 条 / ${L.length} 点`)

  // 退化情形：半径取整 → 圆正穿四个格点，等值线在那里汇聚（端点重数 6）。
  // 分成几条折线是几何歧义的合理结果，要守住的不变式是「每条都闭合、无断头」。
  const dz = contourSegments(z, n, n, -144)
  const dl = stitchSegments(dz)
  const allClosed = dl.every((l) => Math.hypot(l[0][0] - l[l.length - 1][0], l[0][1] - l[l.length - 1][1]) < 1e-9)
  ok('等值线穿格点时各段仍各自闭合', allClosed, `${dl.length} 条：${dl.map((l) => l.length).join('/')} 点`)
}

// ③ 鞍点：z = (i−c)(j−c)，零集是一个十字。取 c 落在格心（半格偏移）——零集穿过
//    格内部而非格点，考的才是鞍点消歧本身，不是格点退化。
{
  const n = 12, c = 5.5
  const z = build(n, n, (i, j) => (i - c) * (j - c))
  const segs = contourSegments(z, n, n, 0)
  // 每段两端必须都落在 i=c 或 j=c 上（真正的零集），落到别处即为连错
  let offCross = 0
  for (const s of segs) {
    const onA = Math.abs(s[0] - c) < 1e-9 || Math.abs(s[1] - c) < 1e-9
    const onB = Math.abs(s[2] - c) < 1e-9 || Math.abs(s[3] - c) < 1e-9
    if (!onA || !onB) offCross++
  }
  ok('鞍点场等值线全落在零集上', offCross === 0, `${segs.length} 段，越界 ${offCross}`)
  // 鞍点格（四角符号 +−+−）内，十字的两支只能用两条斜线段近似——这是 marching squares
  // 的固有近似，不是连错；要守的是「两条线各围一个角、互不相交」。
  const mid = segs.filter((s) => [s[0], s[2]].every((v) => v > c - 1 && v < c + 1) && [s[1], s[3]].every((v) => v > c - 1 && v < c + 1))
  ok('鞍点格出两条线', mid.length === 2, `${mid.length} 段`)
  const cross = (a, b) => {
    const d = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    const [a0, a1] = [[a[0], a[1]], [a[2], a[3]]], [b0, b1] = [[b[0], b[1]], [b[2], b[3]]]
    return d(a0, a1, b0) * d(a0, a1, b1) < 0 && d(b0, b1, a0) * d(b0, b1, a1) < 0
  }
  ok('鞍点两段互不相交（未连成 ✕）', mid.length === 2 && !cross(mid[0], mid[1]))
}

// ③a 鞍点消歧本身：同一个鞍点格，电平落在鞍点值两侧时连法必须相反
{
  // 单格：左下 +1、右下 −1、右上 +1、左上 −1 → 鞍点值 (1·1−(−1)(−1))/4 = 0（此格与四角均值同值）
  const z = Float64Array.from([1, -1, -1, 1])   // 行主序：(0,0)=+1 (1,0)=−1 | (0,1)=−1 (1,1)=+1
  const edgesOf = (level) => contourSegments(z, 2, 2, level).map((s) => {
    const side = (x, y) => (Math.abs(x) < 1e-9 ? 'l' : Math.abs(x - 1) < 1e-9 ? 'r' : Math.abs(y) < 1e-9 ? 'b' : 't')
    return [side(s[0], s[1]), side(s[2], s[3])].sort().join('')
  }).sort().join(' ')
  // 电平低于鞍点值 → 中间算「内部」，两条正对角连通，等值线绕开另两个角
  ok('电平低于鞍点值：绕开左上与右下', edgesOf(-0.5) === 'br lt', edgesOf(-0.5))
  // 电平高于鞍点值 → 中间算「外部」，两个正角各自孤立，连法翻转
  ok('电平高于鞍点值：连法翻转', edgesOf(0.5) === 'bl rt', edgesOf(0.5))
}

// ③b 退化：电平恰好等于一批格点值（可行裕度算出正正好好的 0 并不罕见）
{
  const n = 9
  const z = build(n, n, (i, j) => (i - 4) + (j - 4))   // 零集是一条对角线，穿过大量格点
  const segs = contourSegments(z, n, n, 0)
  ok('电平压在格点上仍出线', segs.length > 0, `${segs.length} 段`)
  let clean = true
  for (const s of segs) if (![s[0], s[1], s[2], s[3]].every(Number.isFinite)) clean = false
  ok('退化情形不产生无效坐标', clean)
  // 拼接不得炸成一地碎段（退化未处理时每格各自为战）
  const lines = stitchSegments(segs)
  ok('退化情形仍拼成少数几条线', lines.length <= 2, `${lines.length} 条`)
}

// ④ NaN 格整格跳过
{
  const nx = 7, ny = 7
  const z = build(nx, ny, (i) => i)
  z[3 * nx + 2] = NaN      // 打掉一个正落在 level 2.5 附近的角
  const segs = contourSegments(z, nx, ny, 2.5)
  ok('含 NaN 的格被跳过', segs.length === ny - 1 - 2, `${segs.length} 段（应比满场少 2）`)
  let clean = true
  for (const s of segs) if (!Number.isFinite(s[0]) || !Number.isFinite(s[1])) clean = false
  ok('输出不含 NaN 坐标', clean)
}

// ⑤ 电平表：临界值必须精确入表
{
  const a = contourLevels(-6.3, 11.8, 0, 8)
  ok('临界值 0 精确入表', a.levels.some((v) => v === 0), `step=${a.step}，levels=[${a.levels.join(', ')}]`)
  const b = contourLevels(20, 180, 100, 8)
  ok('临界值 100 精确入表', b.levels.some((v) => v === 100), `step=${b.step}`)
  const c = contourLevels(3.1, 9.7, null, 6)
  ok('无临界值时按 0 对齐取整', c.levels.every((v) => Math.abs(v / c.step - Math.round(v / c.step)) < 1e-9), `levels=[${c.levels.join(', ')}]`)
}

// ⑥ 双线性取值与极值
{
  const z = build(3, 3, (i, j) => i + 10 * j)
  ok('双线性：格点处取原值', bilinear(z, 3, 3, 1, 2) === 21)
  ok('双线性：格心处取均值', Math.abs(bilinear(z, 3, 3, 0.5, 0.5) - (0 + 1 + 10 + 11) / 4) < 1e-12)
  const zn = build(4, 4, (i, j) => (i === 3 && j === 3 ? NaN : i * j))
  ok('极值跳过 NaN', String(fieldExtent(zn)) === '0,6', String(fieldExtent(zn)))
}

// ⑦ 双三次细化：等值线之所以能画顺，全靠这一步既补密又不篡改真算过的格点
{
  const nx = 9, ny = 7, f = 4
  // 插值样条的定义性质：细化网格上每 f 个点回到一个原格点，值必须逐位相同
  {
    const z = build(nx, ny, (i, j) => Math.sin(i * 0.7) * Math.cos(j * 0.5) * 3)
    const R = refineField(z, nx, ny, f)
    ok('细化后网格尺寸正确', R.nx === (nx - 1) * f + 1 && R.ny === (ny - 1) * f + 1, `${R.nx}×${R.ny}`)
    let worst = 0
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      worst = Math.max(worst, Math.abs(R.z[(j * f) * R.nx + i * f] - z[j * nx + i]))
    }
    ok('细化严格穿过每一个原格点', worst < 1e-12, `最大偏差 ${worst.toExponential(1)}`)
  }
  // 线性场必须细化成同一个线性场——含四条边。钳成端点自身（而非线性外推）时边缘那一格
  // 的切向会减半，平场四周浮出一圈镶边，这条就会挂。
  {
    const z = build(nx, ny, (i, j) => 2 * i - 3 * j + 5)
    const R = refineField(z, nx, ny, f)
    let worst = 0
    for (let j = 0; j < R.ny; j++) for (let i = 0; i < R.nx; i++) {
      worst = Math.max(worst, Math.abs(R.z[j * R.nx + i] - (2 * i / f - 3 * j / f + 5)))
    }
    ok('线性场细化后仍精确线性（含四边）', worst < 1e-12, `最大偏差 ${worst.toExponential(1)}`)
    // 细化后再提线，直线仍是直线（等值线平滑的地基）
    const segs = contourSegments(R.z, R.nx, R.ny, 5 + 2 * 3.5)   // 2x−3y=7 那条
    let off = 0
    for (const s of segs) off = Math.max(off, Math.abs(2 * s[0] / f - 3 * s[1] / f - 7), Math.abs(2 * s[2] / f - 3 * s[3] / f - 7))
    ok('细化网格上等值线仍精确落在直线上', segs.length > 0 && off < 1e-9, `${segs.length} 段，最大偏差 ${off.toExponential(1)}`)
  }
  // 不越界：三次样条在陡变处会过冲，夹不住就会凭空冒出比任何一格都极端的值
  {
    const z = build(nx, ny, (i, j) => (i > 4 ? 10 : 0) + (j > 3 ? 5 : 0))   // 台阶场，过冲最凶
    const R = refineField(z, nx, ny, f)
    const e0 = fieldExtent(z), e1 = fieldExtent(R.z)
    ok('细化不越出原场取值范围', e1[0] >= e0[0] - 1e-12 && e1[1] <= e0[1] + 1e-12, `原 [${e0}] → 细化 [${e1}]`)
  }
  // NaN：无解区只按「端点无解则整段无解」外扩，不产生假值
  {
    const z = build(nx, ny, (i, j) => i + j)
    z[3 * nx + 4] = NaN
    const R = refineField(z, nx, ny, f)
    let nan = 0, bad = 0
    for (let t = 0; t < R.z.length; t++) { if (R.z[t] !== R.z[t]) nan++; else if (!Number.isFinite(R.z[t])) bad++ }
    ok('单格无解 → 细化后成一片空洞', nan > 0 && nan < R.z.length * 0.2, `${nan} / ${R.z.length} 格无解`)
    ok('细化不产生 ±Infinity', bad === 0)
    ok('细化后的格点原值处仍是 NaN', R.z[(3 * f) * R.nx + 4 * f] !== R.z[(3 * f) * R.nx + 4 * f])
  }
  ok('factor≤1 原样返回', refineField(new Float64Array(4), 2, 2, 1).nx === 2)
}

// ⑧ 平滑路径：折线转三次贝塞尔，起点不动、闭环收口
{
  const map = (x, y) => [x * 10, y * 10]
  const open = [[[0, 0], [1, 1], [2, 0], [3, 1]]]
  const d = smoothPathD(open, map, 0)
  ok('开口线：M 起头 + 逐段 C', /^M0,0(\s?C[-\d., ]+)+$/.test(d), d)
  ok('开口线不收口（无 Z）', !/Z/.test(d))
  ok('曲线起点就是折线起点', d.startsWith('M0,0'))
  ok('末点落在折线末点上', d.trim().endsWith('30,10'), d.slice(-24))
  // 闭合环：首尾同点 → 去重收口，且缝合处的邻点绕回来取（不留尖角）
  const ring = [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]
  const dr = smoothPathD(ring, map, 0)
  ok('闭合环以 Z 收口', /Z$/.test(dr), dr)
  ok('闭合环段数 = 点数（缝合处也出一段）', (dr.match(/C/g) || []).length === 4, `${(dr.match(/C/g) || []).length} 段`)
  ok('无坐标为 NaN', !/NaN/.test(d + dr))
  // 抽稀：两像素内的点抽掉，但末点必须留住
  const dense = [Array.from({ length: 40 }, (_, k) => [k * 0.02, 0])]
  const ds = smoothPathD(dense, map, 2)
  ok('抽稀后点数明显减少', (ds.match(/C/g) || []).length <= 5, `${(ds.match(/C/g) || []).length} 段（原 39）`)
  ok('抽稀后末点仍在', ds.trim().endsWith('7.8,0'), ds.slice(-20))
  ok('点数不足不出路径', smoothPathD([[[0, 0]]], map, 0) === '')
}

// ⑧b 等值线数值标注的锚点：顺着线走、长线多标、避开工作点与图框边
{
  const map = (x, y) => [x, y]                       // 网格坐标即像素，便于直接验角度
  // 一条横穿的直线：角度应为 0（水平）
  const horiz = [[[0, 100], [600, 100]]]
  const a = labelAnchors(horiz, map, { minLen: 40, gap: 250, max: 4, tan: 12, w: 700, h: 400 })
  ok('长直线上按 gap 布多个标注', a.length === 3, `${a.length} 个`)
  ok('水平线上标注不转角', a.every((p) => Math.abs(p.a) < 1e-9), a.map((p) => p.a.toFixed(1)).join(' '))
  ok('落点按弧长等分、不落端点', Math.abs(a[0].x - 100) < 1e-6 && Math.abs(a[2].x - 500) < 1e-6,
    a.map((p) => p.x.toFixed(0)).join(' '))
  // 45° 斜线：字要跟着转 45°
  const diag = [Array.from({ length: 60 }, (_, k) => [k * 5, k * 5])]
  const d2 = labelAnchors(diag, map, { minLen: 40, gap: 1e9, max: 1, tan: 12, w: 700, h: 700 })
  ok('斜线上标注顺着线转', d2.length === 1 && Math.abs(d2[0].a - 45) < 1e-6, `${d2[0] && d2[0].a.toFixed(2)}°`)
  // 竖线：角度归化到 ±90° 内，字永远不倒过来
  const vert = [[[100, 0], [100, 600]]]
  const v = labelAnchors(vert, map, { minLen: 40, gap: 1e9, max: 1, tan: 12, w: 700, h: 700 })
  ok('竖线角度归化在 ±90° 内', v.length === 1 && Math.abs(v[0].a) <= 90, `${v[0] && v[0].a.toFixed(1)}°`)
  const back = [[[600, 100], [0, 100]]]              // 反向的同一条水平线
  const b = labelAnchors(back, map, { minLen: 40, gap: 1e9, max: 1, tan: 12, w: 700, h: 700 })
  ok('反向线不把字倒过来', b.length === 1 && Math.abs(b[0].a) < 1e-9, `${b[0] && b[0].a.toFixed(1)}°`)
  // 短线不标：图面全是数字比没有数字更难读
  ok('短线不标', labelAnchors([[[0, 0], [10, 0]]], map, { minLen: 40 }).length === 0)
  // 避让工作点：数字压在十字上，两样都读不清
  const av = labelAnchors(horiz, map, { minLen: 40, gap: 1e9, max: 1, w: 700, h: 400, avoid: [300, 100, 40] })
  ok('落点撞上工作点时该处不标', av.length === 0, `${av.length} 个`)
  // 贴边不标：半个数字比没有数字更糟
  const edge = labelAnchors([[[0, 4], [600, 4]]], map, { minLen: 40, gap: 1e9, max: 1, pad: 18, w: 700, h: 400 })
  ok('贴着图框边不标', edge.length === 0, `${edge.length} 个`)
  // 名额有限时给贯穿全图的主线，而不是角落里的碎线
  const mixed = [[[0, 300], [60, 300]], [[0, 50], [600, 50]]]
  const m2 = labelAnchors(mixed, map, { minLen: 40, gap: 1e9, max: 1, w: 700, h: 400 })
  ok('名额优先给长线', m2.length === 1 && Math.abs(m2[0].y - 50) < 1e-6, `y=${m2[0] && m2[0].y}`)
  ok('无线时返回空', labelAnchors([], map, {}).length === 0)
}

// ⑧c 块极值裁剪：只是提速手段，出的线必须与不裁剪时逐位相同
{
  const n = 33, c = 16
  const z = build(n, n, (i, j) => Math.sin(i * 0.31) * Math.cos(j * 0.27) * 4 - ((i - c) ** 2 + (j - c) ** 2) * 0.01)
  const blk = buildBlocks(z, n, n)
  let same = true, tot = 0
  for (const lv of [-3, -1.5, 0, 1.2, 2.8]) {
    const a = contourSegments(z, n, n, lv)
    const b = contourSegments(z, n, n, lv, blk)
    tot += a.length
    if (a.length !== b.length) { same = false; continue }
    // 块序遍历与逐行遍历的出段**顺序**不同，故按坐标排序后比对
    const key = (s) => s.slice(0, 4).map((v) => v.toFixed(12)).join()
    const A = a.map(key).sort().join('|'), B = b.map(key).sort().join('|')
    if (A !== B) same = false
  }
  ok('块裁剪不改变结果', same, `${tot} 段`)
  ok('块裁剪后仍能拼成线', stitchSegments(contourSegments(z, n, n, 0, blk)).length > 0)
  // 空块（全 NaN）不能把整条线吞掉
  const zn = build(n, n, (i, j) => (i < 8 && j < 8 ? NaN : i + j))
  const bn = buildBlocks(zn, n, n)
  ok('全无解的块被跳过而不报错', contourSegments(zn, n, n, 30, bn).length === contourSegments(zn, n, n, 30).length)
}

// ⑨ 去量化：引擎 toFixed(2) 把跨度小的场压成台阶，等值线只能沿格边走出直角阶梯。
//    要守的不变式是「改动量不超过半个量化步」——那正是取整已经丢掉的信息，不多不少。
{
  // 量化步检测
  const q1 = detectQuantum(Float64Array.from([23.82, 23.83, 23.9, 24]))
  ok('检出量化步 0.01', q1 && q1.q === 0.01, q1 && String(q1.q))
  const q2 = detectQuantum(Float64Array.from([1.5, 2, 3.5, 4]))
  ok('检出量化步 0.1（更粗的场）', q2 && q2.q === 0.1, q2 && String(q2.q))
  const q3 = detectQuantum(Float64Array.from([1.2345678, 2.7182818, 3.1415927]))
  ok('未取整的场检不出量化步（或极细）', !q3 || q3.q <= 1e-6, q3 && String(q3.q))
  ok('全场同值 → 无量化步可言', detectQuantum(Float64Array.from([5, 5, 5])) === null)

  // 台阶度量
  const nx = 21, ny = 21
  const cont = (i, j) => 24 - 0.0004 * ((i - 10) ** 2 + (j - 10) ** 2)      // 跨度 0.08 dB
  const zc = build(nx, ny, cont)
  const zq = build(nx, ny, (i, j) => Math.round(cont(i, j) * 100) / 100)
  ok('连续场无台阶', terraceFrac(zc, nx, ny) < 1e-9, terraceFrac(zc, nx, ny).toFixed(3))
  const tf = terraceFrac(zq, nx, ny)
  ok('量化场大面积同值', tf > 0.3, `${(tf * 100).toFixed(0)}%`)

  const D = dequantize(zq, nx, ny)
  ok('量化场触发去量化', D.applied && D.q === 0.01)
  let worst = 0
  for (let t = 0; t < zq.length; t++) worst = Math.max(worst, Math.abs(D.z[t] - zq[t]))
  ok('改动量不超过半个量化步', worst <= 0.005 + 1e-12, `最大 ${worst.toFixed(6)}（半步 0.005）`)
  ok('台阶被抹平', terraceFrac(D.z, nx, ny) < tf * 0.4, `${(tf * 100).toFixed(0)}% → ${(terraceFrac(D.z, nx, ny) * 100).toFixed(0)}%`)
  // 去量化后离真值更近才算数（否则只是把线画好看了）
  const err = (a) => { let s = 0; for (let t = 0; t < a.length; t++) s += Math.abs(a[t] - zc[t]); return s / a.length }
  ok('去量化后离未取整的真值更近', err(D.z) < err(zq), `${(err(zq) * 1000).toFixed(2)} → ${(err(D.z) * 1000).toFixed(2)} mdB`)
  // 等值线不再沿格边走：直角段（两端只差一个坐标）的占比
  const axial = (z2) => {
    let ax = 0, n2 = 0
    const R = refineField(z2, nx, ny, 5)
    for (const lv of contourLevels(23.92, 24, null, 8).levels) {
      for (const s of contourSegments(R.z, R.nx, R.ny, lv)) {
        n2++
        if (Math.abs(s[2] - s[0]) < 1e-9 || Math.abs(s[3] - s[1]) < 1e-9) ax++
      }
    }
    return n2 ? ax / n2 : 0
  }
  const a0 = axial(zq), a1 = axial(D.z)
  ok('沿格边的直角段大幅减少', a1 < a0 * 0.25, `${(a0 * 100).toFixed(1)}% → ${(a1 * 100).toFixed(1)}%`)

  // 不该动手的三种情形
  ok('连续场不触发', !dequantize(zc, nx, ny).applied)
  const zBig = build(nx, ny, (i, j) => Math.round((24 + 0.4 * i - 0.3 * j) * 100) / 100)   // 跨度 12 dB
  ok('跨度远大于量化步时不触发', !dequantize(zBig, nx, ny).applied, `台阶 ${(terraceFrac(zBig, nx, ny) * 100).toFixed(0)}%`)
  const zInt = build(nx, ny, (i, j) => (i > 10 ? 3 : 2))                                   // 整数量、跨度 1 步
  ok('整数量（跨度不足两步）不触发', !dequantize(zInt, nx, ny).applied)
  // 无解区：不得被填上值，也不得把有解区搅坏
  const zNaN = build(nx, ny, (i, j) => (i < 3 && j < 3 ? NaN : Math.round(cont(i, j) * 100) / 100))
  const DN = dequantize(zNaN, nx, ny)
  let nanKept = true
  for (let t = 0; t < zNaN.length; t++) if ((zNaN[t] !== zNaN[t]) !== (DN.z[t] !== DN.z[t])) nanKept = false
  ok('无解格保持无解、不外溢', nanKept && DN.applied)
}

// ⑩ 抽稀：DP 的偏离有硬上界；闭环不被抽成退化图形
{
  // 有起伏的线：转弯处的点留下、直路上的冗余点抽掉
  const line = Array.from({ length: 60 }, (_, k) => [k, 3 * Math.sin(k / 12)])
  const s1 = simplifyDP(line, 0.35)
  ok('DP 抽掉直路冗余点、留住转弯', s1.length >= 6 && s1.length < 24, `60 → ${s1.length} 点`)
  // 整条线都在容差之内 → 只剩两个端点（该抽就抽干净）
  ok('起伏小于容差时抽到只剩两端', simplifyDP(line.map(([x, y]) => [x, y * 0.05]), 0.35).length === 2)
  ok('DP 保留首末点', s1[0] === line[0] && s1[s1.length - 1] === line[line.length - 1])
  // 偏离上界：每个被丢掉的点到简化折线的垂距 ≤ tol
  const dev = (pts, simp) => {
    let w = 0
    for (const p of pts) {
      let best = Infinity
      for (let k = 1; k < simp.length; k++) {
        const ax = simp[k - 1][0], ay = simp[k - 1][1]
        const dx = simp[k][0] - ax, dy = simp[k][1] - ay
        const L2 = dx * dx + dy * dy
        let t = L2 > 0 ? ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2 : 0
        t = t < 0 ? 0 : t > 1 ? 1 : t
        best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)))
      }
      w = Math.max(w, best)
    }
    return w
  }
  ok('DP 偏离不超过容差', dev(line, s1) <= 0.35 + 1e-9, `最大 ${dev(line, s1).toFixed(4)}（容差 0.35）`)
  ok('容差 0 不抽稀', simplifyDP(line, 0).length === line.length)
  // 亚像素小环：抽没了宁可原样画——那是场里真有的局部极值
  const tiny = [[0, 0], [0.3, 0.1], [0.5, 0.4], [0.2, 0.5], [-0.1, 0.2]]
  const dTiny = smoothPathD([tiny.concat([tiny[0]])], (x, y) => [x, y], 0.35)
  ok('亚像素小环不被抽成退化图形', /Z$/.test(dTiny) && (dTiny.match(/C/g) || []).length >= 3, `${(dTiny.match(/C/g) || []).length} 段`)
}

// ⑪ 色标：发散色标以临界值为中性中点，两侧异色且冷色在「好」的一侧
{
  const s = buildColorScale({ min: -6, max: 12, crit: 0, good: 'above', dark: false })
  ok('有临界值 → 发散色标', s.kind === 'div')
  const C = (v) => { const c = s.rgbAt(v); const lab = rgbToOklab(...c); return Math.hypot(lab[1], lab[2]) }
  ok('临界处近乎无彩', C(0) < 0.01, `C=${C(0).toFixed(4)}`)
  const good = s.rgbAt(10), bad = s.rgbAt(-5)
  ok('好的一侧偏冷（蓝多于红）', good[2] > good[0], `rgb(${good.join(',')})`)
  ok('坏的一侧偏暖（红多于蓝）', bad[0] > bad[2], `rgb(${bad.join(',')})`)
  // 两臂同一距离 → 同一明度（半幅归一，冷暖深浅可直接互比）
  const l1 = rgbToOklab(...s.rgbAt(4))[0], l2 = rgbToOklab(...s.rgbAt(-4))[0]
  ok('等距两侧明度相当', Math.abs(l1 - l2) < 0.02, `L ${l1.toFixed(3)} / ${l2.toFixed(3)}`)
  ok('场值非有限 → 不给颜色', s.rgbAt(NaN) === null)
  // 明度必须从中点单调走到两端（两模式各自方向相反）。不单调就会在临界值附近
  // 横出一条异色带——暗色模式初版正是「深灰中点→极亮→再变深」，图上像有块污渍。
  const armMono = (sc, dark) => {
    const L = (v) => rgbToOklab(...sc.rgbAt(v))[0]
    const up = [0, 1.5, 3, 4.5, 6].map((d) => L(sc.crit + d))     // 中点 → 高端
    const dn = [0, 1.5, 3, 4.5, 6].map((d) => L(sc.crit - d))     // 中点 → 低端
    const mono = (a) => a.every((v, i) => i === 0 || (dark ? v > a[i - 1] : v < a[i - 1]))
    return mono(up) && mono(dn)
  }
  ok('亮底：中点最亮，向两端逐级加深', armMono(s, false))
  const sd = buildColorScale({ min: -6, max: 12, crit: 0, good: 'above', dark: true })
  ok('暗底：中点最暗，向两端逐级提亮', armMono(sd, true))
  // 「越小越好」的量（占用率）：冷色须翻到临界值以下那一侧
  const t = buildColorScale({ min: 20, max: 180, crit: 100, good: 'below', dark: false })
  const low = t.rgbAt(40)
  ok('good=below 时冷色在下侧', low[2] > low[0], `rgb(${low.join(',')})`)
  // 无临界值 → 顺序色标，明度随值单调
  const q = buildColorScale({ min: 0, max: 100, dark: false })
  ok('无临界值 → 顺序色标', q.kind === 'seq' && q.midT === null)
  const ls = [0, 25, 50, 75, 100].map((v) => rgbToOklab(...q.rgbAt(v))[0])
  ok('顺序色标明度单调', ls.every((v, i) => i === 0 || v < ls[i - 1]), ls.map((v) => v.toFixed(2)).join(' '))
}

// ⑫ Turbo（地理图钉死用它）：有临界值也不改用发散色标，两端锚点须落在 Turbo 的深紫→暗红上
{
  const t = buildColorScale({ min: 0, max: 120, crit: 0, good: 'above', dark: false, palette: 'turbo' })
  ok('palette=turbo 压过「有临界值→发散」', t.kind === 'turbo')
  const lo = t.rgbAt(0), hi = t.rgbAt(120)
  ok('低端 = Turbo 深紫', lo.join(',') === '48,18,59', lo.join(','))
  ok('高端 = Turbo 暗红', hi.join(',') === '148,24,17', hi.join(','))
  // 彩虹型色标的本钱是「层次多」：等距取样两两之间必须都拉得开
  const seq = [0, 15, 30, 45, 60, 75, 90, 105, 120].map((v) => t.rgbAt(v))
  let minD = Infinity
  for (let i = 1; i < seq.length; i++) {
    const a = rgbToOklab(...seq[i - 1]), b = rgbToOklab(...seq[i])
    minD = Math.min(minD, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
  }
  ok('相邻档拉得开（OKLab 距离 > 0.06）', minD > 0.06, `最小 ${minD.toFixed(3)}`)
  // 与临界值无关：色标本身仍是从 min 线性铺到 max（临界值只在色标条上标一条线）
  ok('turbo 的中点仍按线性域算', Math.abs(t.midT - 0) < 1e-9, String(t.midT))
  // 恒定场不能拿 Turbo 上任何一档铺满（浓色铺满会被读成「这里真有个极值」）
  const [r, g, b] = t.flatRgb
  ok('恒定场退出色标另取纸面灰', Math.max(r, g, b) - Math.min(r, g, b) < 12 && r > 200, `rgb(${r},${g},${b})`)
}

// ⑬ 自适应展布：值→色按数据密度分配，但两头都有界（既不糊成一色，也不放大噪声）
{
  // 偏态场：八成样本挤在 [8,12]，其余是一路掉到 −60 的长尾——真实余量图的形状
  const vals = []
  for (let i = 0; i < 1600; i++) vals.push(8 + 4 * (i % 400) / 399)
  for (let i = 0; i < 400; i++) vals.push(8 - 68 * i / 399)
  vals.sort((a, b) => a - b)
  const lo = vals[Math.round(0.02 * (vals.length - 1))], hi = vals[Math.round(0.98 * (vals.length - 1))]
  const T = buildStretch(vals, lo, hi)
  ok('样本足够 → 建得出展布', typeof T === 'function')
  ok('端点固定 0/1', T(lo) === 0 && T(hi) === 1 && T(lo - 99) === 0 && T(hi + 99) === 1)
  let mono = true, prev = -1
  for (let k = 0; k <= 400; k++) { const v = T(lo + (hi - lo) * k / 400); if (v < prev - 1e-12) mono = false; prev = v }
  ok('单调不减（颜色与值的对应不能来回折）', mono)
  // 逐档增益 = 该档拿到的色带宽度 ÷ 线性应得。设计上界 [0.4, 3.4]（λ=0.8、夹在 0.25~4 档）
  const N = 64
  let gmin = Infinity, gmax = 0
  for (let i = 0; i < N; i++) {
    const g = (T(lo + (hi - lo) * (i + 1) / N) - T(lo + (hi - lo) * i / N)) * N
    gmin = Math.min(gmin, g); gmax = Math.max(gmax, g)
  }
  ok('增益有下界（稀疏段不塌成一色）', gmin >= 0.39, `min ${gmin.toFixed(2)}`)
  ok('增益有上界（尖峰不吃掉整条色标）', gmax <= 3.45, `max ${gmax.toFixed(2)}`)
  // 主区（20–80 分位）拿到的色带必须明显多于线性——这正是要治的病
  const q = (p) => vals[Math.round(p * (vals.length - 1))]
  const linW = (q(0.8) - q(0.2)) / (hi - lo), adaW = T(q(0.8)) - T(q(0.2))
  ok('主区分到的色带比线性多', adaW > linW * 1.3, `线性 ${(linW * 100).toFixed(1)}% → 自适应 ${(adaW * 100).toFixed(1)}%`)
  ok('样本太少 → 不展布（回落线性）', buildStretch([1, 2, 3], 0, 4) === null)
  ok('域退化 → 不展布', buildStretch(vals, 5, 5) === null)

  // 发散色标不展布：临界值必须仍在中性中点上，两臂等距等深
  const d = buildColorScale({ min: -6, max: 12, crit: 0, good: 'above', dark: false, samples: vals })
  ok('发散色标拒绝展布', d.adaptive === false)
  const C0 = rgbToOklab(...d.rgbAt(0))
  ok('展布后临界处仍近乎无彩', Math.hypot(C0[1], C0[2]) < 0.01)
  const a1 = rgbToOklab(...d.rgbAt(4))[0], a2 = rgbToOklab(...d.rgbAt(-4))[0]
  ok('展布后两臂仍等距等深', Math.abs(a1 - a2) < 0.02)

  // 单调色标（turbo）才展布，且色标条按**值**取样，读色比刻度处处对得上
  const s = buildColorScale({ min: lo, max: hi, dark: false, palette: 'turbo', samples: vals })
  ok('turbo 接受展布', s.adaptive === true)
  const st = s.stops(21)
  let barOk = true
  for (const p of st) {
    const want = s.cssAt(lo + (hi - lo) * p.t)
    if (want !== p.css) barOk = false
  }
  ok('色标条上任一位置的色 = 该位置那个值的色', barOk)
  // 发散色标两臂不等长时也得对得上（旧版按 t 等分取样，这里会整段错开）
  const ds = buildColorScale({ min: -6, max: 12, crit: 0, good: 'above', dark: false })
  ok('两臂不等长的发散色标同样对得上',
    ds.stops(9).every((p) => p.css === ds.cssAt(-6 + 18 * p.t)))
}

// ⑭ 压在场上的线色：取该电平自己那一档，明度朝有余量的一侧推开
{
  const s = buildColorScale({ min: 0, max: 100, dark: false, palette: 'turbo' })
  const parse = (css) => css.match(/\d+/g).map(Number)
  let worstLine = 9, worstLab = 9
  for (let v = 0; v <= 100; v += 2.5) {
    const fill = rgbToOklab(...s.rgbAt(v))[0]
    worstLine = Math.min(worstLine, Math.abs(rgbToOklab(...parse(s.lineCssAt(v)))[0] - fill))
    worstLab = Math.min(worstLab, Math.abs(rgbToOklab(...parse(s.labelCssAt(v)))[0] - fill))
  }
  // Turbo 从深紫走到亮黄绿再到暗红，任何**单一**颜色的线都会在某一段里读不出；
  // 逐档取色 + 明度推开则处处有对比，这才是敢去掉白衬底的前提
  ok('等值线在每一档上都与底色拉得开', worstLine > 0.2, `最小明度差 ${worstLine.toFixed(3)}`)
  ok('数值标注拉得更开（笔画细）', worstLab > worstLine + 0.1, `最小 ${worstLab.toFixed(3)}`)
  ok('线色仍带该档的色相（不是灰）', (() => {
    const [, a, b] = rgbToOklab(...parse(s.lineCssAt(85)))
    return Math.hypot(a, b) > 0.05
  })())
  ok('非有限值不给线色', s.lineCssAt(NaN) === 'transparent' && s.labelCssAt(NaN) === 'transparent')
}

// ⑮ 主次分配：主区降彩、热点区满浓度（focus + context）
{
  const chroma = (c) => { const l = rgbToOklab(...c); return Math.hypot(l[1], l[2]) }
  const L = (c) => rgbToOklab(...c)[0]
  const q = (a, p) => a[Math.round(p * (a.length - 1))]
  // 不分主次时的原始 Turbo 查找表（同一 t 上的色，用来量「削掉了多少」）
  const raw = buildColorScale({ min: 0, max: 1, dark: false, palette: 'turbo' })
  const rawAt = (i) => [raw.lut[i * 3], raw.lut[i * 3 + 1], raw.lut[i * 3 + 2]]

  // ① 主体贴着低端 + 长尾甩向高端（功放建议功率图的形状）：热点须落在**高**端
  const up = []
  for (let i = 0; i < 1600; i++) up.push(15 + 2 * (i % 400) / 399)     // 八成格点挤在 15~17 W
  for (let i = 0; i < 400; i++) up.push(17 + 13 * i / 399)             // 长尾一路到 30 W
  up.sort((a, b) => a - b)
  const lo = q(up, 0.02), hi = q(up, 0.98), med = q(up, 0.5)
  const s = buildColorScale({ min: lo, max: hi, dark: false, palette: 'turbo', samples: up })
  ok('turbo + 样本 → 分主次', s.focused === true)
  ok('热点端（稀疏长尾那头）一分不削', chroma(s.rgbAt(hi)) >= chroma(rawAt(s.idxOf(hi))) - 1e-9,
    `${chroma(s.rgbAt(hi)).toFixed(3)} vs ${chroma(rawAt(s.idxOf(hi))).toFixed(3)}`)
  const cMed = chroma(s.rgbAt(med)), cMedRaw = chroma(rawAt(s.idxOf(med)))
  ok('主区彩度削掉一大半', cMed < cMedRaw * 0.55, `${cMed.toFixed(3)} vs 原 ${cMedRaw.toFixed(3)}`)
  ok('主区明度朝中性档收拢', Math.abs(L(s.rgbAt(med)) - 0.74) < Math.abs(L(rawAt(s.idxOf(med))) - 0.74),
    `${L(s.rgbAt(med)).toFixed(3)} ← ${L(rawAt(s.idxOf(med))).toFixed(3)}`)
  // 短的那条尾抬不起头：低端也是主区的一部分，不能跟着热点一起浓
  ok('短尾那头不冒充热点', chroma(s.rgbAt(lo)) < chroma(rawAt(s.idxOf(lo))) * 0.6,
    `${chroma(s.rgbAt(lo)).toFixed(3)} vs 原 ${chroma(rawAt(s.idxOf(lo))).toFixed(3)}`)

  // ② 主体在高端 + 长尾掉向低端（C/N、余量图的形状）：热点须自动翻到**低**端
  const dn = up.map((v) => -v)
  dn.sort((a, b) => a - b)
  const dLo = q(dn, 0.02), dHi = q(dn, 0.98), dMed = q(dn, 0.5)
  const d = buildColorScale({ min: dLo, max: dHi, dark: false, palette: 'turbo', samples: dn })
  ok('长尾在低端时热点翻到低端', chroma(d.rgbAt(dLo)) >= chroma(rawAt(d.idxOf(dLo))) - 1e-9)
  ok('此时高端（主体）反被削彩', chroma(d.rgbAt(dHi)) < chroma(rawAt(d.idxOf(dHi))) * 0.6)
  void dMed

  // ③ 对称分布没有单一的「重点」：两端同权，都保持满浓度
  const sym = []
  for (let i = 0; i < 2000; i++) sym.push(Math.cos(Math.PI * i / 1999))   // 中间密、两头稀且对称
  sym.sort((a, b) => a - b)
  const yLo = q(sym, 0.02), yHi = q(sym, 0.98)
  const y = buildColorScale({ min: yLo, max: yHi, dark: false, palette: 'turbo', samples: sym })
  ok('对称分布两端同权', chroma(y.rgbAt(yLo)) >= chroma(rawAt(y.idxOf(yLo))) - 1e-9 &&
    chroma(y.rgbAt(yHi)) >= chroma(rawAt(y.idxOf(yHi))) - 1e-9)

  // ④ 门槛与适用面
  ok('样本太少 → 不分主次', buildColorScale({ min: 0, max: 1, dark: false, palette: 'turbo', samples: [0, 0.5, 1] }).focused === false)
  ok('无样本 → 不分主次（色标条与两端锚点原样）', raw.focused === false)
  ok('发散色标不分主次（两臂对称不容动）',
    buildColorScale({ min: -6, max: 12, crit: 0, good: 'above', dark: false, samples: up }).focused === false)
  // 暗底的「安静」是暗下去：主区明度朝暗档收，不是朝纸白提
  const dk = buildColorScale({ min: lo, max: hi, dark: true, palette: 'turbo', samples: up })
  ok('暗底主区朝暗档收拢', L(dk.rgbAt(med)) < L(s.rgbAt(med)), `${L(dk.rgbAt(med)).toFixed(3)} < ${L(s.rgbAt(med)).toFixed(3)}`)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
