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

// ⑤b 电平表按数据密度局部加密：等间距下，主瓣那片占地五成却只分到一两条线
{
  // 余量图的形状：八成格点挤在 5~13 dB，覆盖边缘一路掉到 −35
  const S = []
  for (let i = 0; i < 1400; i++) S.push(5 + 8 * (i % 350) / 349)
  for (let i = 0; i < 350; i++) S.push(5 - 40 * i / 349)
  S.sort((a, b) => a - b)
  const dom = [S[Math.round(0.02 * (S.length - 1))], S[Math.round(0.98 * (S.length - 1))]]
  const flat0 = contourLevels(dom[0], dom[1], null, 8)
  const adp = contourLevels(dom[0], dom[1], null, 8, S)
  // 「最挤的一带占了多少地」——治的就是这个数
  const worst = (lv) => {
    const e = [dom[0], ...lv.filter((v) => v > dom[0] && v < dom[1]), dom[1]]
    let m = 0
    for (let i = 0; i < e.length - 1; i++) m = Math.max(m, S.filter((v) => v >= e[i] && v < e[i + 1]).length / S.length)
    return m
  }
  const w0 = worst(flat0.levels), w1 = worst(adp.levels)
  ok('最挤的一带被切开', w1 < w0 * 0.6, `${(w0 * 100).toFixed(1)}% → ${(w1 * 100).toFixed(1)}%`)
  ok('骨架一条不少（等间距那套仍在表里）', flat0.levels.every((v) => adp.levels.includes(v)))
  ok('加密线都是 base 的整数分之一', adp.minor.every((v) => {
    const k = v / (adp.base / Math.round(adp.base / adp.step))
    return Math.abs(k - Math.round(k)) < 1e-9
  }), `base=${adp.base} 最细=${adp.step} minor=[${adp.minor.join(', ')}]`)
  ok('加密线不与骨架重合', adp.minor.every((v) => !flat0.levels.includes(v)))
  ok('电平表升序无重复', adp.levels.every((v, i) => i === 0 || v > adp.levels[i - 1]))
  ok('总数封顶', adp.levels.length <= 2 * 8 + 4, `${adp.levels.length} 条`)
  // 加密只发生在数据密的那几带：外围长尾（−35~0）本就没什么可读，不该跟着变密
  ok('长尾一侧不加密', adp.minor.every((v) => v > 0), `minor=[${adp.minor.join(', ')}]`)
  // 不给样本 = 原样等间距（既有调用与出图不受影响）
  ok('不给样本时行为不变', String(contourLevels(dom[0], dom[1], null, 8).levels) === String(flat0.levels) && flat0.minor.length === 0)
  ok('样本太少时回落等间距', contourLevels(dom[0], dom[1], null, 8, S.slice(0, 40)).minor.length === 0)
  // 临界值仍是电平表的对齐基准，加密线跟着同一根锚
  const cr = contourLevels(-6.3, 11.8, 0, 8, S)
  ok('加密后临界值仍精确入表', cr.levels.some((v) => v === 0))
  ok('加密线与临界值同锚', cr.minor.every((v) => Math.abs(v / cr.step - Math.round(v / cr.step)) < 1e-9))
}

// ⑤c 窄带：主瓣顶端那一段常常比一整格还窄（合计 C/N 图上域是 [−23, +1.6]、base=5），
// 而它正是读者唯一要比较的地方——档位必须细到真的插得进线去
{
  const S = []
  for (let i = 0; i < 300; i++) S.push(0.05 + 1.5 * (i % 150) / 149)      // 主瓣：0~1.6 dB，占 15%
  for (let i = 0; i < 1700; i++) S.push(-0.5 - 23 * Math.pow(i / 1699, 0.7))
  S.sort((a, b) => a - b)
  const dom = [S[Math.round(0.02 * (S.length - 1))], S[Math.round(0.98 * (S.length - 1))]]
  const L = contourLevels(dom[0], dom[1], null, 8, S)
  const pos = L.levels.filter((v) => v > 0)
  ok('比一整格还窄的顶端带也插得出线', pos.length >= 2, `base=${L.base}，正值区电平 [${pos.join(', ')}]`)
  ok('细到能落进带内（步长小于带宽）', L.step < dom[1] - 0, `最细 ${L.step}，带宽 ${(dom[1] - 0).toFixed(2)}`)
  ok('总数仍在封顶内', L.levels.length <= 2 * 8 + 4, `${L.levels.length} 条`)
  // 封顶靠「逐档降」而不是「整带抹掉」：窄而关键的那一带面积本就不大，
  // 旧法一封顶就专挑它下手
  ok('封顶不会把窄带整个抹掉', L.levels.filter((v) => v > 0).length > 0)
}

// ⑤d γ：密集段拿到的色带要**超过**它的面积份额（γ=1 时两者相等）
{
  const S = []
  for (let i = 0; i < 400; i++) S.push(0.05 + 1.5 * (i % 200) / 199)
  for (let i = 0; i < 1600; i++) S.push(-0.5 - 23 * Math.pow(i / 1599, 0.7))
  S.sort((a, b) => a - b)
  const min = S[Math.round(0.02 * (S.length - 1))], max = S[Math.round(0.98 * (S.length - 1))]
  const stG = buildStretch(S, min, max)                    // 默认 γ
  const st1 = buildStretch(S, min, max, { gamma: 1 })      // 纯按面积
  const w = (st) => st(max) - st(0)
  ok('γ>1 把色带从「反正很差」的一大片挪给主瓣', w(stG) > w(st1) + 0.01,
    `γ=1 时 ${(w(st1) * 100).toFixed(1)}% → 默认 ${(w(stG) * 100).toFixed(1)}%`)
  ok('挪归挪，仍受上下界约束（不塌成一色）', st1(min) === 0 && Math.abs(stG(max) - 1) < 1e-9 &&
    (stG(-10) - stG(min)) > 0.05, `低端一段仍占 ${((stG(-10) - stG(min)) * 100).toFixed(1)}%`)
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
  // 避让工作点：数字压在十字上两样都读不清，故**沿线挪开**——不是整条线就此不标
  const av = labelAnchors(horiz, map, { minLen: 40, gap: 1e9, max: 1, w: 700, h: 400, avoid: [300, 100, 40] })
  ok('落点撞上工作点时沿线挪开，仍标得出',
    av.length === 1 && Math.hypot(av[0].x - 300, av[0].y - 100) >= 40,
    av.length ? `(${av[0].x.toFixed(0)}, ${av[0].y.toFixed(0)})` : '0 个')
  // 贴边不标：半个数字比没有数字更糟（整条线都贴着边，挪到哪儿都不行）
  const edge = labelAnchors([[[0, 4], [600, 4]]], map, { minLen: 40, gap: 1e9, max: 1, pad: 18, w: 700, h: 400 })
  ok('贴着图框边不标', edge.length === 0, `${edge.length} 个`)
  // 名额有限时给贯穿全图的主线，而不是角落里的碎线
  const mixed = [[[0, 300], [60, 300]], [[0, 50], [600, 50]]]
  const m2 = labelAnchors(mixed, map, { minLen: 40, gap: 1e9, max: 1, w: 700, h: 400 })
  ok('名额优先给长线', m2.length === 1 && Math.abs(m2[0].y - 50) < 1e-6, `y=${m2[0] && m2[0].y}`)
  ok('无线时返回空', labelAnchors([], map, {}).length === 0)

  // ★ 名额轮着分：一条电平在图上是好几条互不相连的线时，每条都该拿到数字。
  // 旧版从最长的那条起「一条吃到饱」，长线独占 3 个名额，其余的线一个数字也没有——
  // 图上于是一片「有线无数」的曲线（实测一张地理余量图 62% 的可见线不带数字）。
  const many = [
    [[0, 40], [600, 40]],       // 长线：够重复标 3 个
    [[0, 120], [600, 120]],
    [[0, 200], [600, 200]],
    [[0, 280], [600, 280]]
  ]
  const rr = labelAnchors(many, map, { minLen: 40, gap: 250, max: 4, w: 700, h: 400 })
  const ys = new Set(rr.map((p) => Math.round(p.y)))
  ok('名额轮着分给每条线（不被最长的那条吃光）', rr.length === 4 && ys.size === 4,
    `${rr.length} 个，落在 ${ys.size} 条线上：${[...ys].join('/')}`)
  // 名额富余时，每条线各拿一个之后才回头补重复
  const rr2 = labelAnchors(many, map, { minLen: 40, gap: 250, max: 8, w: 700, h: 400 })
  const per = [40, 120, 200, 280].map((y) => rr2.filter((p) => Math.abs(p.y - y) < 1).length)
  ok('先人手一个，再给长线补重复', per.every((c) => c >= 1) && rr2.length === 8, `每条线 ${per.join('/')} 个`)
  // 自避让：同一电平自己的几个数字也不能叠在一起
  const cross = [[[0, 100], [600, 100]], [[300, 0], [300, 400]]]
  const cr = labelAnchors(cross, map, { minLen: 40, gap: 1e9, max: 4, r: 30, w: 700, h: 400 })
  let closest = Infinity
  for (let i = 0; i < cr.length; i++) for (let k = i + 1; k < cr.length; k++) {
    closest = Math.min(closest, Math.hypot(cr[i].x - cr[k].x, cr[i].y - cr[k].y))
  }
  ok('同电平的数字互相让开', cr.length === 2 && closest >= 30, `最近两个相距 ${closest.toFixed(0)}px`)
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
  // 锚点看**软化前**那一层（lutInk）：填充另外还要削彩度、朝纸面收明度（见 SOFT），
  // 拿它去比 Turbo 的原色永远不等——软化正是要让它不等
  const inkAt = (v) => { const i = t.idxOf(v); return [t.lutInk[i * 3], t.lutInk[i * 3 + 1], t.lutInk[i * 3 + 2]] }
  ok('软化前低端 = Turbo 深紫', inkAt(0).join(',') === '48,18,59', inkAt(0).join(','))
  ok('软化前高端 = Turbo 暗红', inkAt(120).join(',') === '148,24,17', inkAt(120).join(','))
  ok('turbo 的填充被软化过', t.softened === true)
  // 软化只准朝「淡」走：彩度只减不增，明度朝纸面（亮底）走
  const chr = (c) => { const l = rgbToOklab(...c); return Math.hypot(l[1], l[2]) }
  const lum = (c) => rgbToOklab(...c)[0]
  const pts = [0, 15, 30, 45, 60, 75, 90, 105, 120]
  ok('填充逐档比软化前淡（彩度只减不增）', pts.every((v) => chr(t.rgbAt(v)) < chr(inkAt(v)) - 1e-6),
    pts.map((v) => `${chr(t.rgbAt(v)).toFixed(3)}<${chr(inkAt(v)).toFixed(3)}`).join(' '))
  ok('亮底填充逐档朝纸面提亮', pts.every((v) => lum(t.rgbAt(v)) > lum(inkAt(v)) - 1e-6))
  // 彩虹型色标的本钱是「层次多」：等距取样两两之间必须都拉得开。
  // 软化把整层收窄了，故填充这一层的门槛跟着放到 0.04（实测 0.047）——**恰恰因为**填充淡了，
  // 「分出十几档」这件事才更靠等值线与它的数值标注，而线取的是软化前那一层，原样 0.06 以上。
  const minGap = (get) => {
    const seq = pts.map(get)
    let m = Infinity
    for (let i = 1; i < seq.length; i++) {
      const a = rgbToOklab(...seq[i - 1]), b = rgbToOklab(...seq[i])
      m = Math.min(m, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
    }
    return m
  }
  const minD = minGap((v) => t.rgbAt(v)), minInk = minGap(inkAt)
  ok('填充相邻档仍拉得开（OKLab 距离 > 0.04）', minD > 0.04, `最小 ${minD.toFixed(3)}`)
  ok('软化前那一层原样拉得开（> 0.06，等值线取色靠它）', minInk > 0.06, `最小 ${minInk.toFixed(3)}`)
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

  // 单调色标（turbo）才展布。色标条的轴 = t（= 颜色的轴），刻度按 tAt 落位：
  // 于是「条上某处的色」与「刻度指的那个值的色」必须处处是同一个（刻度不等距，颜色均匀）
  const s = buildColorScale({ min: lo, max: hi, dark: false, palette: 'turbo', samples: vals })
  ok('turbo 接受展布', s.adaptive === true)
  const sameAxis = (sc, a, b) => {
    const st = sc.stops(256)                       // 与 LUT 同长，取样即精确
    const at = (t) => st[Math.round(Math.max(0, Math.min(1, t)) * (st.length - 1))].css
    for (let k = 0; k <= 40; k++) {
      const v = a + (b - a) * k / 40
      if (at(sc.tAt(v)) !== sc.cssAt(v)) return false
    }
    return true
  }
  ok('色标条上刻度落位与颜色同源（条的轴 = t）', sameAxis(s, lo, hi))
  const barFrac = s.tAt(q(0.8)) - s.tAt(q(0.2)), valFrac = (q(0.8) - q(0.2)) / (hi - lo)
  ok('主区在条上占的长度 = 它分到的色带（远大于它的值域宽度）', barFrac > valFrac * 3,
    `20–80 分位占条 ${(barFrac * 100).toFixed(1)}%，值域只占 ${(valFrac * 100).toFixed(1)}%`)
  // 发散色标不展布，条上仍是等距刻度；且轴归一到实际用到的那一段
  // （两臂不等长时低端只到 t=0.25，不归一的话条的下面四分之一会空着）
  const ds = buildColorScale({ min: -6, max: 12, crit: 0, good: 'above', dark: false })
  ok('发散色标的条仍是线性轴', sameAxis(ds, -6, 12) &&
    Math.abs(ds.tAt(3) - 0.5) < 0.01 && ds.tAt(-6) === 0 && ds.tAt(12) === 1,
    `tAt(-6)=${ds.tAt(-6).toFixed(3)} tAt(3)=${ds.tAt(3).toFixed(3)} tAt(12)=${ds.tAt(12).toFixed(3)}`)
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
  // 主次分配作用在**软化之前**那一层（软化是整层等价的一道，调不动档与档的轻重），
  // 故这一节一律拿 lutInk 对比：拿软化后的填充去比「收拢到 FOCUS.midLight」这类绝对量，
  // 量到的是两道叠加的结果，测不出主次分配本身有没有生效。
  const inkOf = (sc) => (v) => { const i = sc.idxOf(v); return [sc.lutInk[i * 3], sc.lutInk[i * 3 + 1], sc.lutInk[i * 3 + 2]] }
  // 不分主次时的原始 Turbo 查找表（同一 t 上的色，用来量「削掉了多少」）
  const raw = buildColorScale({ min: 0, max: 1, dark: false, palette: 'turbo' })
  const rawAt = (i) => [raw.lutInk[i * 3], raw.lutInk[i * 3 + 1], raw.lutInk[i * 3 + 2]]

  // ① 主体贴着低端 + 长尾甩向高端（功放建议功率图的形状）：热点须落在**高**端
  const up = []
  for (let i = 0; i < 1600; i++) up.push(15 + 2 * (i % 400) / 399)     // 八成格点挤在 15~17 W
  for (let i = 0; i < 400; i++) up.push(17 + 13 * i / 399)             // 长尾一路到 30 W
  up.sort((a, b) => a - b)
  const lo = q(up, 0.02), hi = q(up, 0.98), med = q(up, 0.5)
  const s = buildColorScale({ min: lo, max: hi, dark: false, palette: 'turbo', samples: up })
  const sInk = inkOf(s)
  ok('turbo + 样本 → 分主次', s.focused === true)
  ok('热点端（稀疏长尾那头）一分不削', chroma(sInk(hi)) >= chroma(rawAt(s.idxOf(hi))) - 1e-9,
    `${chroma(sInk(hi)).toFixed(3)} vs ${chroma(rawAt(s.idxOf(hi))).toFixed(3)}`)
  // 主体段收到 FOCUS.floorS 而不是收到 0：削三成上下，留住段内的层次（见 buildFocus）
  const cMed = chroma(sInk(med)), cMedRaw = chroma(rawAt(s.idxOf(med)))
  ok('主区彩度明显削掉', cMed < cMedRaw * 0.75, `${cMed.toFixed(3)} vs 原 ${cMedRaw.toFixed(3)}`)
  ok('但没削到看不出差别（主体段仍留着层次）', cMed > cMedRaw * 0.3, `${(cMed / cMedRaw * 100).toFixed(0)}% 保留`)
  ok('主区明度朝中性档收拢', Math.abs(L(sInk(med)) - 0.74) < Math.abs(L(rawAt(s.idxOf(med))) - 0.74),
    `${L(sInk(med)).toFixed(3)} ← ${L(rawAt(s.idxOf(med))).toFixed(3)}`)
  // 短的那条尾同样是「离主体远」的一端，一样保持满浓度（FOCUS.floorW=1）。
  // 早先按尾长比给权重，短尾几乎抬不起头——而一张余量图上的短尾正是主瓣里那片高余量区，
  // 读者最想看的那块反倒被淡成灰褐（用户 2026-07-26 的反馈）。尾长只说明值域上谁伸得远。
  ok('短尾那头也保持满浓度', chroma(sInk(lo)) >= chroma(rawAt(s.idxOf(lo))) - 1e-9,
    `${chroma(sInk(lo)).toFixed(3)} vs 原 ${chroma(rawAt(s.idxOf(lo))).toFixed(3)}`)
  // 主次分配是**相对**的轻重，软化过的填充上必须照样立得住（否则「整层淡下去」
  // 就等于把主次一起抹平）
  ok('填充上主次仍在（主区比热点端淡）', chroma(s.rgbAt(med)) < chroma(s.rgbAt(hi)) * 0.75,
    `${chroma(s.rgbAt(med)).toFixed(3)} vs ${chroma(s.rgbAt(hi)).toFixed(3)}`)

  // ② 主体在高端 + 长尾掉向低端（C/N、余量图的形状）：两端都浓，淡的是主体那一段
  const dn = up.map((v) => -v)
  dn.sort((a, b) => a - b)
  const dLo = q(dn, 0.02), dHi = q(dn, 0.98), dMed = q(dn, 0.5)
  const d = buildColorScale({ min: dLo, max: dHi, dark: false, palette: 'turbo', samples: dn })
  const dInk = inkOf(d)
  ok('长尾（低端）一分不削', chroma(dInk(dLo)) >= chroma(rawAt(d.idxOf(dLo))) - 1e-9)
  ok('主瓣那头（高端）同样不削', chroma(dInk(dHi)) >= chroma(rawAt(d.idxOf(dHi))) - 1e-9)
  ok('淡下去的是主体附近', chroma(dInk(dMed)) < chroma(rawAt(d.idxOf(dMed))) * 0.75,
    `${chroma(dInk(dMed)).toFixed(3)} vs 原 ${chroma(rawAt(d.idxOf(dMed))).toFixed(3)}`)

  // ③ 对称分布没有单一的「重点」：两端同权，都保持满浓度
  const sym = []
  for (let i = 0; i < 2000; i++) sym.push(Math.cos(Math.PI * i / 1999))   // 中间密、两头稀且对称
  sym.sort((a, b) => a - b)
  const yLo = q(sym, 0.02), yHi = q(sym, 0.98)
  const y = buildColorScale({ min: yLo, max: yHi, dark: false, palette: 'turbo', samples: sym })
  const yInk = inkOf(y)
  ok('对称分布两端同权', chroma(yInk(yLo)) >= chroma(rawAt(y.idxOf(yLo))) - 1e-9 &&
    chroma(yInk(yHi)) >= chroma(rawAt(y.idxOf(yHi))) - 1e-9)

  // ④ 门槛与适用面
  ok('样本太少 → 不分主次', buildColorScale({ min: 0, max: 1, dark: false, palette: 'turbo', samples: [0, 0.5, 1] }).focused === false)
  ok('无样本 → 不分主次（色标条与两端锚点原样）', raw.focused === false)
  ok('发散色标不分主次（两臂对称不容动）',
    buildColorScale({ min: -6, max: 12, crit: 0, good: 'above', dark: false, samples: up }).focused === false)
  // 暗底的「安静」是暗下去：主区明度朝暗档收，不是朝纸白提
  const dk = buildColorScale({ min: lo, max: hi, dark: true, palette: 'turbo', samples: up })
  const dkInk = inkOf(dk)
  ok('暗底主区朝暗档收拢', L(dkInk(med)) < L(sInk(med)), `${L(dkInk(med)).toFixed(3)} < ${L(sInk(med)).toFixed(3)}`)
}

// ⑯ 软化（场是地图上的一层淡彩，压在它上面的国界岸线才读得出，见 lbColorScale 的 SOFT）
{
  const L = (c) => rgbToOklab(...c)[0]
  const chroma = (c) => { const l = rgbToOklab(...c); return Math.hypot(l[1], l[2]) }
  const parse = (css) => css.match(/\d+/g).map(Number)
  // 半透明的线压在场上，上屏色是「线色与底色按 α 插的值」——故要按 α 合成之后再量落差，
  // 直接拿线色去比会高估一大截（这正是「中段灰折中」那一代看不见的算法根源）
  const mix = (hex, a, f) => {
    const ln = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    return [0, 1, 2].map((c) => ln[c] * a + f[c] * (1 - a))
  }
  const gap = (sc, hex, a) => {
    let worst = 9
    for (let i = 0; i < 256; i++) {
      const f = [sc.lut[i * 3], sc.lut[i * 3 + 1], sc.lut[i * 3 + 2]]
      worst = Math.min(worst, Math.abs(L(mix(hex, a, f)) - L(f)))
    }
    return worst
  }
  const smp = []
  for (let i = 0; i < 1600; i++) smp.push(9 + 4 * (i % 400) / 399)      // 主体挤在 9~13 dB
  for (let i = 0; i < 400; i++) smp.push(9 - 29 * i / 399)              // 长尾掉到 −20
  smp.sort((a, b) => a - b)
  const lt = buildColorScale({ min: -20, max: 13, dark: false, palette: 'turbo', samples: smp })
  const dk = buildColorScale({ min: -20, max: 13, dark: true, palette: 'turbo', samples: smp })
  const range = (sc) => { const v = []; for (let i = 0; i < 256; i++) v.push(L([sc.lut[i * 3], sc.lut[i * 3 + 1], sc.lut[i * 3 + 2]])); return [Math.min(...v), Math.max(...v)] }
  const [lMin, lMax] = range(lt), [dMin, dMax] = range(dk)
  // 亮底的「淡」是朝纸面提亮，暗底的「淡」是沉下去——同 FOCUS.midLight / midDark 的走向
  ok('亮底场整层提亮（明度下限抬离深色端）', lMin > 0.45, `L ${lMin.toFixed(3)}~${lMax.toFixed(3)}`)
  ok('暗底场整层压暗（明度上限压下来）', dMax < 0.65, `L ${dMin.toFixed(3)}~${dMax.toFixed(3)}`)
  // 地物线是这次软化的目的：亮底配深墨、暗底配白，两处都要立得住（口径见 lbBasemap 的 ①）
  ok('亮底深墨地物线处处压得住场', gap(lt, '#262c33', 0.62) > 0.12, `国界 α.62 落差下限 ${gap(lt, '#262c33', 0.62).toFixed(3)}`)
  ok('亮底岸线（更实一档）更清楚', gap(lt, '#262c33', 0.80) > gap(lt, '#262c33', 0.62))
  ok('亮底白线已经压不住了（故换深墨）', gap(lt, '#ffffff', 0.88) < 0.12, `白 α.88 只剩 ${gap(lt, '#ffffff', 0.88).toFixed(3)}`)
  ok('暗底仍是白线最好', gap(dk, '#ffffff', 0.72) > 0.25, `白 α.72 落差 ${gap(dk, '#ffffff', 0.72).toFixed(3)}`)
  // 等值线的明度落差要从**上屏的填充**推开（软化后的那一层）才算得对；色相彩度取软化前，
  // 否则底一淡线也跟着淡成灰，「带颜色的是数据」这条分野就没了
  let worstIso = 9, minChr = 9
  for (const sc of [lt, dk]) {
    for (let v = -20; v <= 13; v += 0.5) {
      const f = sc.rgbAt(v), ln = parse(sc.lineCssAt(v))
      worstIso = Math.min(worstIso, Math.abs(L(ln) - L(f)))
      minChr = Math.min(minChr, chroma(ln))
    }
  }
  ok('等值线在软化后的场上处处拉得开', worstIso > 0.2, `最小明度差 ${worstIso.toFixed(3)}`)
  ok('等值线仍带色（不随场一起淡成灰）', minChr > 0.04, `最小彩度 ${minChr.toFixed(3)}`)
  // 恒定场那一色是纸面灰（不代表数值），软化与它无关
  ok('恒定场仍退出色标取纸面灰', chroma(lt.flatRgb) < 0.02 && chroma(dk.flatRgb) < 0.02)
  // 顺序 / 发散色标不软化：它们的「退后」写在色板里（浅端贴纸面、中点无彩），再淡一道会压平
  ok('顺序色标不软化', buildColorScale({ min: 0, max: 100, dark: false }).softened === false)
  ok('发散色标不软化', buildColorScale({ min: -6, max: 12, crit: 0, good: 'above', dark: false }).softened === false)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
