// 规则网格的等值线提取（marching squares）、双三次细化与双线性取值 —— 设计空间图的几何层。
//
// 主流程：去量化 → 双三次细化 → 提线 → 抽稀 → 转贝塞尔。
//   去量化  引擎出参是按 toFixed(2) 定的**字符串**，故场值一律落在 0.01 的格子上。
//           跨度大的场（10 dB）无所谓，跨度小的场（上行 C/N 常只有 0.3 dB）就被取整压成了
//           台阶：相邻格点大面积同值，等值线只能沿格边走，画出来是一片直角阶梯，一条线还
//           被打散成上百段。那种阶梯不是物理，是取整。故先在「引擎已经丢掉的那半个取整步」
//           之内把台阶还原成最平滑的场，见 dequantize——改动量有硬上界 ±半步，不造新信息。
//           **2026-07-25 起这一步在新数据上已不再触发**：三个引擎加了「出参小数位增量」，
//           扫描期间由 packages/core/utils/linkSweep.js 临时多给 4 位（见各引擎文件头的 FX），
//           场直接落在 10⁻⁶ 的格子上，台阶比归零。dequantize 保留下来兜旧数据与别处的场。
//   细化    粗网格（21~41 格，每格一次完整引擎调用，密不起来）上 marching squares 只认格点
//           间的线性关系，拐点全落在格边上；双三次补到 ~121 格再提线，线自然就顺了。
//   抽稀    Douglas–Peucker（垂距容差，亚像素）。细化网格上的点密到直路上十几个点一条直线，
//           逐点写进贝塞尔既长又抖；抽稀留下的是转弯处的点，控制点少了曲线反而更稳。
//   贝塞尔  向心 Catmull-Rom（α=½）。向心参数化可证不出自交与尖点，急转处不甩鼓包。
//
// 无 DOM 无 Vue，纯数学，便于单测。坐标一律用「连续网格索引」：
// [i, j] 中 i∈[0,nx−1] 沿 x、j∈[0,ny−1] 沿 y，i=2.4 表示落在第 2、3 列之间。
// 渲染层再把它线性映射到像素——因为轴是等距取样的，映射就是一次乘加；把像素
// 坐标混进算法里，缩放和导出时就得改两处。
//
// 与 viz/grd/coverage.js 的覆盖等值线是两套：那份耦合了地理投影、地平可见性掩码
// 与分带填充的零分配缓冲，为拖拽热路径优化过；这里的场只有几千格、每帧重算毫无压力，
// 复用只会把地理那套约束拖进链路预算。共同点只有 marching squares 的 case 逻辑本身。
//
// 鞍点（一条对角在内、另一条在外）按**双线性面的鞍点值**消歧（渐近判别，Nielson & Hamann
// 1991），而不是四角均值：要画的既然是双线性插值出来的那张面，判据就该取自那张面本身，
// 四角均值只是它的近似。不消歧就得在两种连法里硬选一种，选错时等值线会在鞍点处交叉成
// ✕ 形，可行域边界跟着断在那里。
//
// 诚实边界（务必与界面说法一致）：这一层能把「取整造出来的阶梯」抹平，但抹不掉取整本身的
// 误差。实测 21×21、0.12 dB 跨度那张场：未取整的数进管线，等值线落点误差 0.01 mdB（管线
// 自身几乎无损）；取整到 0.01 dB 后误差涨到 2 mdB，去量化只能收到 1.8 mdB——余下的要靠
// 引擎给未取整的数才能拿掉。0.12 dB 跨度下 2 mdB 折成图上约 7 px 的线位偏移。
// 这条路已经走通（2026-07-25）：引擎在扫描期间多给 4 位，量化步从 0.01 降到 10⁻⁶，
// 上面那 2 mdB 随之降到 mdB 的万分之几——已在管线自身的噪声之下。见 linkSweep._precise
// 与 packages/core/test/linkSweepPrecision.test.mjs。

// 双线性取值：连续网格坐标 (fi, fj) 处的场值；任一参与角为 NaN 则返回 NaN
export function bilinear(z, nx, ny, fi, fj) {
  if (!(nx > 1) || !(ny > 1)) return NaN
  const ci = Math.max(0, Math.min(nx - 1, fi))
  const cj = Math.max(0, Math.min(ny - 1, fj))
  // 落在最后一行/列时退到前一格、权重取满：直接 floor 会让 i+1 越界，
  // 而把 clamp 上限设成 nx−1−ε 又会使边缘取不到格点原值（差一个 ε 的插值）
  const i = Math.min(nx - 2, Math.floor(ci)), j = Math.min(ny - 2, Math.floor(cj))
  const u = ci - i, v = cj - j
  const a = z[j * nx + i], b = z[j * nx + i + 1], c = z[(j + 1) * nx + i], d = z[(j + 1) * nx + i + 1]
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
}

/**
 * 分块极值索引：把网格切成 8×8 的块，记下每块的 min/max。
 *
 * 提线时一条电平只穿过场里很小一部分格；有了块极值就能整块跳过（min>电平 或 max<电平 的块
 * 里不可能有线）。一张 101×101 的场画 8~10 条电平，逐格试探是 8 万次的平方级重复劳动，
 * 块裁剪把它压到一成上下——实测提线一段从 0.6 ms 降到 0.1 ms。
 * 建一次给所有电平共用（场不变则索引不变），故由调用方持有；不传也能工作，只是不裁剪。
 */
const BLK = 8
export function buildBlocks(z, nx, ny) {
  if (!(nx > 1) || !(ny > 1)) return null
  const bx = Math.ceil((nx - 1) / BLK), by = Math.ceil((ny - 1) / BLK)
  const mn = new Float64Array(bx * by).fill(Infinity)
  const mx = new Float64Array(bx * by).fill(-Infinity)
  for (let bj = 0; bj < by; bj++) {
    for (let bi = 0; bi < bx; bi++) {
      const b = bj * bx + bi
      // 块含 BLK 个格 → BLK+1 个格点，且与邻块共享边界那一行/列
      const j1 = Math.min(ny - 1, bj * BLK + BLK), i1 = Math.min(nx - 1, bi * BLK + BLK)
      let lo = Infinity, hi = -Infinity
      for (let j = bj * BLK; j <= j1; j++) {
        const ro = j * nx
        for (let i = bi * BLK; i <= i1; i++) {
          const v = z[ro + i]
          if (v !== v) continue
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }
      mn[b] = lo; mx[b] = hi
    }
  }
  return { bx, by, mn, mx }
}

/**
 * 某一电平的等值线段。
 * @param blocks 可选：buildBlocks 的产物（多条电平共用一份，用于整块跳过）
 * @returns Array<[x0,y0,x1,y1,e0,e1]>（连续网格坐标 + 两端所在的**格边号**）
 *
 * 端点带边号是为了拼接：任一内部格边恰属两个格，故「同一个交点」在两个格里算出的边号
 * 必然相同，配对是整数比对，既不必量化坐标、也不会在等值线正穿格点时出现重数 6 的端点。
 * 边号 = 水平边(i,j) → (j*nx+i)*2、竖直边(i,j) → (j*nx+i)*2+1。
 */
export function contourSegments(z, nx, ny, level0, blocks) {
  const out = []
  if (!(nx > 1) || !(ny > 1) || !Number.isFinite(level0)) return out
  // 退化处理：格点值恰好等于电平时（可行裕度算出正正好好的 0 并不罕见），该格的两个交点会
  // 一起塌到那个格点上，生成零长度的线段。把**电平**抬高一丝即可避开，全场同一个偏移，
  // 相邻格的判据仍完全一致。（早先是逐格把等于电平的角抬高，每格四次函数调用，做的是同一件事。）
  // 只在真踩到格点时才偏——无条件偏移会让每一条线都平移一丝，
  // 「线性场的等值线精确落在原位」这条不变式就守不住了。整场一趟原生扫描，几微秒。
  const level = (typeof z.includes === 'function' ? z.includes(level0) : Array.prototype.includes.call(z, level0))
    ? level0 + (Math.abs(level0) + 1) * 1e-12
    : level0
  const B = blocks || null
  const bx = B ? B.bx : 1, by = B ? B.by : 1
  for (let bj = 0; bj < by; bj++) {
    for (let bi = 0; bi < bx; bi++) {
      let j0 = 0, j1 = ny - 1, i0 = 0, i1 = nx - 1
      if (B) {
        const bIdx = bj * bx + bi
        if (!(B.mn[bIdx] <= level && B.mx[bIdx] >= level)) continue
        j0 = bj * BLK; j1 = Math.min(ny - 1, j0 + BLK)
        i0 = bi * BLK; i1 = Math.min(nx - 1, i0 + BLK)
      }
      for (let j = j0; j < j1; j++) {
        for (let i = i0; i < i1; i++) {
          const i00 = j * nx + i, i10 = i00 + 1, i01 = i00 + nx, i11 = i01 + 1
          const v0 = z[i00], v1 = z[i10], v2 = z[i11], v3 = z[i01]   // 左下 右下 右上 左上
          // 任一角算不出就整格跳过：跨着无解区插值等于凭空造一条不存在的边界
          if (v0 !== v0 || v1 !== v1 || v2 !== v2 || v3 !== v3) continue

          const idx = (v0 >= level ? 1 : 0) | (v1 >= level ? 2 : 0) | (v2 >= level ? 4 : 0) | (v3 >= level ? 8 : 0)
          if (idx === 0 || idx === 15) continue

          // 四条边上的交点（线性插值）+ 该边的边号
          const eh = i00 * 2, ev = i00 * 2 + 1
          const b = [i + (level - v0) / (v1 - v0), j, eh]                    // 下边
          const r = [i + 1, j + (level - v1) / (v2 - v1), i10 * 2 + 1]       // 右边
          const t = [i + (level - v3) / (v2 - v3), j + 1, i01 * 2]           // 上边
          const l = [i, j + (level - v0) / (v3 - v0), ev]                    // 左边
          const seg = (p, q) => out.push([p[0], p[1], q[0], q[1], p[2], q[2]])

          switch (idx) {
            case 1: case 14: seg(l, b); break
            case 2: case 13: seg(b, r); break
            case 3: case 12: seg(l, r); break
            case 4: case 11: seg(r, t); break
            case 6: case 9: seg(b, t); break
            case 7: case 8: seg(l, t); break
            // 鞍点：双线性面自己的鞍点值决定「中间是内还是外」，两条线段跟着走。
            // 该值 = (v0·v2 − v1·v3)/(v0+v2−v1−v3)：把双线性式的两个偏导置零解出来的驻点值。
            // 分母为 0 是退化情形（此格双线性退化成平面，无鞍点），回落到四角均值。
            case 5: case 10: {
              const den = v0 + v2 - v1 - v3
              const sv = Math.abs(den) > 1e-300 ? (v0 * v2 - v1 * v3) / den : (v0 + v1 + v2 + v3) / 4
              const inMid = sv >= level
              if (idx === 5) { if (inMid) { seg(l, t); seg(b, r) } else { seg(l, b); seg(r, t) } }
              else { if (inMid) { seg(l, b); seg(r, t) } else { seg(l, t); seg(b, r) } }
              break
            }
          }
        }
      }
    }
  }
  return out
}

/**
 * 把线段拼成折线（按格边号配对）。画路径少下几百条 M 指令，也便于沿线找标注位置。
 *
 * 边号配对是「一条边最多两个格」这条拓扑事实的直接兑现：每个交点恰属两段（在场的边界上
 * 属一段，那就是线的端头），串起来即得整条线，不会因坐标凑巧相同而误接、也不会因浮点
 * 尾数不同而漏接。段若没带边号（外部手搓的折线）则回落到坐标量化匹配。
 * @returns Array<Array<[x,y]>>
 */
export function stitchSegments(segs) {
  if (!segs || !segs.length) return []
  const byEdge = segs[0].length >= 6
  const Q = 1e6
  const key = (s, end) => (byEdge
    ? s[end ? 5 : 4]
    : Math.round(s[end ? 2 : 0] * Q) + ',' + Math.round(s[end ? 3 : 1] * Q))
  // 端点（边号或量化坐标）→ 关联的线段序号
  const ends = new Map()
  const push = (k, idx) => { const a = ends.get(k); if (a) a.push(idx); else ends.set(k, [idx]) }
  for (let i = 0; i < segs.length; i++) { push(key(segs[i], 0), i); push(key(segs[i], 1), i) }

  const used = new Uint8Array(segs.length)
  const out = []
  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue
    used[start] = 1
    const s = segs[start]
    const line = [[s[0], s[1]], [s[2], s[3]]]
    // 向两端各自延伸到接不上为止（从中间一段起头也无妨，两头都会走到底）
    for (const dir of [1, 0]) {
      let k = key(s, dir)
      for (;;) {
        const cand = ends.get(k)
        if (!cand) break
        let nxt = -1
        for (const c of cand) if (!used[c]) { nxt = c; break }
        if (nxt < 0) break
        used[nxt] = 1
        const q = segs[nxt]
        // 接上的是另一端点
        const same = key(q, 0) === k
        const pt = same ? [q[2], q[3]] : [q[0], q[1]]
        k = key(q, same ? 1 : 0)
        if (dir) line.push(pt); else line.unshift(pt)
      }
    }
    out.push(line)
  }
  return out
}

/**
 * Douglas–Peucker 抽稀：递归保留「离弦最远」的点，直到所有被丢掉的点都在容差之内。
 *
 * 与「按间距逐点丢」的贪心抽稀差别正在这里：后者只看点间距，直路上留一堆冗余点、
 * 转弯处又可能连丢两个，留下的点疏密无章，切向跟着乱抖；DP 是按**几何偏差**取舍，
 * 直路上两点足矣、转弯处一个不丢，且整条线与原折线的偏离有硬上界 = tol。
 * @returns 保留下来的点（含首末两点）
 */
export function simplifyDP(p, tol) {
  const n = p.length
  if (n < 3 || !(tol > 0)) return p.slice()
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const t2 = tol * tol
  const stack = [0, n - 1]
  while (stack.length) {
    const b = stack.pop(), a = stack.pop()
    if (b - a < 2) continue
    const ax = p[a][0], ay = p[a][1]
    const dx = p[b][0] - ax, dy = p[b][1] - ay
    const L2 = dx * dx + dy * dy
    let best = -1, bd = -1
    for (let k = a + 1; k < b; k++) {
      const px = p[k][0] - ax, py = p[k][1] - ay
      let d2
      if (L2 > 0) {
        let t = (px * dx + py * dy) / L2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const ex = px - t * dx, ey = py - t * dy
        d2 = ex * ex + ey * ey
      } else d2 = px * px + py * py
      if (d2 > bd) { bd = d2; best = k }
    }
    if (bd > t2) { keep[best] = 1; stack.push(a, best, best, b) }
  }
  const out = []
  for (let k = 0; k < n; k++) if (keep[k]) out.push(p[k])
  return out
}

// 闭环的 DP：环没有天然端点，故先取离质心最远的点与其对径点作两个锚，两段弧各自 DP。
// 直接把环当开口线做会把接缝那一带钉死（首末两点必留），环上凭空多两个不该留的点。
function simplifyRing(p, tol) {
  const n = p.length
  let cx = 0, cy = 0
  for (const q of p) { cx += q[0]; cy += q[1] }
  cx /= n; cy /= n
  let a = 0, far = -1
  for (let k = 0; k < n; k++) {
    const d = (p[k][0] - cx) ** 2 + (p[k][1] - cy) ** 2
    if (d > far) { far = d; a = k }
  }
  const b = (a + (n >> 1)) % n
  const arc = (s, e) => { const r = []; for (let k = s; ; k = (k + 1) % n) { r.push(p[k]); if (k === e) break } return r }
  const A = simplifyDP(arc(a, b), tol), B = simplifyDP(arc(b, a), tol)
  const out = A.concat(B.slice(1, B.length - 1))
  // 抽到 3 点以下就不是环了（亚像素小环会被整个抽没）：宁可原样画出来，也不把一个
  // 真实的局部极值抹掉——它虽小，却是场里确实有的东西
  return out.length >= 3 ? out : p
}

/**
 * 折线 → 平滑曲线的 SVG path d（向心 Catmull-Rom 转三次贝塞尔）。
 *
 * 等值线上的棱角是采样与 marching squares 的产物，不是场里真有的折点，用直线段画出来
 * 读者会以为那里真有拐点。故先按 DP 抽稀到亚像素容差，再把点与点之间换成弧。
 * 曲线严格穿过抽稀后留下的每一个点，与原折线的偏离不超过 tol + 贝塞尔自身的弧高。
 *
 * 切向权重用**向心**参数化（α=½，即弦长开平方）而不是弦长本身：向心 Catmull-Rom 可证
 * 不产生自交与尖点（Yuksel 等 2011），急转弯处不会甩出鼓包；纯弦长参数化在长短段相接
 * 处仍会过冲，而抽稀之后段长本就参差。
 *
 * @param lines 折线数组（连续网格坐标）
 * @param map   (gi, gj) => [px, py]
 * @param tol   DP 抽稀容差（像素，默认 0.35）。0 = 不抽稀，逐点成弧。
 *              细化网格上的点可密到几像素一个，直路上十几个点写成十几段贝塞尔，
 *              既把 path 写长几倍，控制点一多曲线自己还抖。
 */
export function smoothPathD(lines, map, tol) {
  const eps = Number.isFinite(tol) ? tol : 0.35
  const f1 = (v) => (Math.round(v * 10) / 10)
  let out = ''
  for (const ln of lines) {
    if (!ln || ln.length < 2) continue
    // 映射到像素
    let p = []
    for (let k = 0; k < ln.length; k++) {
      const q = map(ln[k][0], ln[k][1])
      if (Number.isFinite(q[0]) && Number.isFinite(q[1])) p.push(q)
    }
    if (p.length < 2) continue
    // 闭合环：去掉重复的收尾点，接缝处的邻点靠取模绕回来取——否则首尾会留一个尖角
    const closed = Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 0.01
    if (closed) p.pop()
    if (eps > 0 && p.length > 2) p = closed ? simplifyRing(p, eps) : simplifyDP(p, eps)
    const n = p.length
    if (n < 2) continue
    const at = (k) => (closed ? p[((k % n) + n) % n] : p[k < 0 ? 0 : k > n - 1 ? n - 1 : k])
    out += 'M' + f1(p[0][0]) + ',' + f1(p[0][1])
    const segs = closed ? n : n - 1
    for (let k = 0; k < segs; k++) {
      const p0 = at(k - 1), p1 = at(k), p2 = at(k + 1), p3 = at(k + 2)
      const d0 = Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]))
      const d1 = Math.sqrt(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]))
      const d2 = Math.sqrt(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]))
      // 开口线两端 p0/p3 退化成端点自身（d0 或 d2 = 0），权重自然落到 1/3，
      // 即「切向对准下一点」的自然端条件，无需另写分支
      const w1 = (d0 + d1) > 0 ? d1 / (3 * (d0 + d1)) : 0
      const w2 = (d1 + d2) > 0 ? d1 / (3 * (d1 + d2)) : 0
      out += 'C' + f1(p1[0] + (p2[0] - p0[0]) * w1) + ',' + f1(p1[1] + (p2[1] - p0[1]) * w1) +
        ' ' + f1(p2[0] - (p3[0] - p1[0]) * w2) + ',' + f1(p2[1] - (p3[1] - p1[1]) * w2) +
        ' ' + f1(p2[0]) + ',' + f1(p2[1])
    }
    if (closed) out += 'Z'
  }
  return out
}

/**
 * 沿等值线布标注锚点：位置 + 该处的切向角。
 *
 * 等值线的数值标注是这张图的读数入口——有它，读者不必拿颜色去比对色标条。
 * 五条讲究，都来自纸质等值线图（气象天气图、GMT、MATLAB clabel）的成法：
 *   ① 顺着线走。横平的数字压在一条斜线上，读者得先判断它属于哪条线；顺着线摆，
 *      归属不言自明。角度归化到 ±90° 内，字永远不倒过来；
 *   ② 长线多标几个。一条横贯全图的线只在中间标一次，读者的视线走到两端就断了线索；
 *   ③ 均分而非取中点。落点按弧长等分（(k+½)/n），几条线的标注错开分布，
 *      不会在图心堆成一坨；
 *   ④ **名额轮着分给每一条线**，不是「一条线吃到饱再轮下一条」。一条电平在图上往往是
 *      十几条互不相连的线（同一条 0 dB 线可以同时出现在华南、台湾以东与南海各处）。
 *      旧版按长度排序后从最长的那条起、一条线先把 max 个名额占满——于是同电平其余的线
 *      一个数字也没有，读者面前就是一片「有线无数」的曲线：实测一张地理余量图上
 *      **62% 的可见等值线不带数字**（其中 level 10 的 3 个名额全落在同一条长线上，
 *      另外 3 条线全空）。改成轮次分配：每条线各拿到第一个数字之后，才回头给长线补第二个；
 *   ⑤ 落点被否（贴边 / 撞上别的数字）时**沿线另找一处**，而不是这条线就此作罢。
 *      旧版一条线只试一个点，撞上就整条线没有数字了——而「不压在工作点上」要的是
 *      挪开，不是放弃。
 *
 * 标注处的线要断开让位（由渲染层用 mask 做），故这里同时给出角度：断口也得顺着线转。
 *
 * @param lines  折线数组（连续网格坐标，stitchSegments 的结果）
 * @param map    (gi, gj) => [px, py]
 * @param opt    { minLen 线短于此不标 | gap 同线上两标注的最小弧长 | max 本电平最多几个
 *                 tan 求切向的半窗 | pad 离图框的最小距离 | w,h 图框尺寸
 *                 avoid [x, y, r] 避让区（工作点标记 / 已放下的别的数值）
 *                 r 本电平自己这些标注的互相避让半径（0 = 不自避让）}
 * @returns Array<{ x, y, a }>  a = 角度（度）
 */
// 落点被否时沿线退让的档位（占本段弧长的比例）：先段心，再朝两侧逐级挪开
const LAB_RETRY = [0, 1 / 6, -1 / 6, 1 / 3, -1 / 3, 5 / 12, -5 / 12]
export function labelAnchors(lines, map, opt) {
  const o = opt || {}
  const minLen = o.minLen > 0 ? o.minLen : 60
  const gap = o.gap > 0 ? o.gap : 220
  const maxN = o.max > 0 ? o.max : 4
  const tan = o.tan > 0 ? o.tan : 8
  const pad = o.pad > 0 ? o.pad : 0
  const selfR = o.r > 0 ? o.r : 0
  const W = Number.isFinite(o.w) ? o.w : Infinity
  const H = Number.isFinite(o.h) ? o.h : Infinity
  // 避让区：一个圆 [x,y,r]，或一串圆 [[x,y,r], …]（加密之后同一处会挤上好几条线的数值，
  // 调用方把已经放下的标注一路喂进来，后面的线就绕开它们）。
  // 复制一份：本电平自己新放下的也要接着往里加（见 selfR），不能改到调用方的数组上去。
  const av = o.avoid && o.avoid.length ? (Array.isArray(o.avoid[0]) ? o.avoid.slice() : [o.avoid]) : []
  const out = []
  if (!lines || !lines.length) return out

  // 映射到像素并预积分弧长（长度按像素算而不是点数：细化之后点数与线长不再成比例，
  // 一条挤在角落的碎线也能有几十个点）
  const prep = []
  for (const ln of lines) {
    if (!ln || ln.length < 2) continue
    const p = []
    for (const q of ln) {
      const m = map(q[0], q[1])
      if (Number.isFinite(m[0]) && Number.isFinite(m[1])) p.push(m)
    }
    if (p.length < 2) continue
    const cum = new Float64Array(p.length)
    for (let i = 1; i < p.length; i++) cum[i] = cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
    const L = cum[p.length - 1]
    // want = 这条线自己想要几个数字（够长才重复），落点仍按弧长等分成 want 段、各取段心
    if (L >= minLen) prep.push({ p, cum, L, want: Math.max(1, Math.min(3, Math.floor(L / gap) + 1)), got: 0 })
  }
  // 长线优先：名额有限时该先给贯穿全图的主线，而不是角落里的碎线
  prep.sort((a, b) => b.L - a.L)

  const usable = (c) => {
    if (!c) return false
    // 贴边的标注会被图框裁掉半个字，半个数字比没有数字更糟
    if (c[0] < pad || c[1] < pad || c[0] > W - pad || c[1] > H - pad) return false
    return !av.some((z) => Math.hypot(c[0] - z[0], c[1] - z[1]) < z[2])
  }
  // 在第 k 段（共 want 段）里找一个放得下的落点
  const anchorIn = (s, k) => {
    const seg = s.L / s.want
    const t0 = seg * (k + 0.5)
    for (const f of LAB_RETRY) {
      const t = t0 + f * seg
      if (t < 0 || t > s.L) continue
      const c = ptAtArc(s, t)
      if (!usable(c)) continue
      // 切向取前后各一段弦（而非相邻两点）：细化网格上相邻点只隔亚像素，
      // 用它定角度会被采样抖动带得乱转
      const a1 = ptAtArc(s, Math.max(0, t - tan))
      const a2 = ptAtArc(s, Math.min(s.L, t + tan))
      let a = 0
      if (a1 && a2) {
        a = Math.atan2(a2[1] - a1[1], a2[0] - a1[0]) * 180 / Math.PI
        if (a > 90) a -= 180
        else if (a < -90) a += 180
      }
      return { x: c[0], y: c[1], a }
    }
    return null
  }

  // 轮次分配（见 ④）：第 r 轮只给「已放下 r 个、且还想要更多」的线各补一个
  for (let r = 0; r < 3 && out.length < maxN; r++) {
    for (const s of prep) {
      if (out.length >= maxN) break
      if (s.got !== r || s.want <= r) continue
      const a = anchorIn(s, r)
      s.got = r + 1                       // 这一段试过就算走完，下一轮换下一段找（不原地重试）
      if (!a) continue
      out.push(a)
      if (selfR > 0) av.push([a.x, a.y, selfR])
    }
  }
  return out
}

// 折线上弧长 t 处的点（二分定段 + 段内线性插值）
function ptAtArc(s, t) {
  const { p, cum } = s
  let hi = cum.length - 1
  if (!(t > 0)) return p[0]
  if (t >= cum[hi]) return p[hi]
  let lo = 0
  while (lo < hi - 1) {
    const m = (lo + hi) >> 1
    if (cum[m] <= t) lo = m; else hi = m
  }
  const d = cum[hi] - cum[lo]
  const u = d > 0 ? (t - cum[lo]) / d : 0
  return [p[lo][0] + (p[hi][0] - p[lo][0]) * u, p[lo][1] + (p[hi][1] - p[lo][1]) * u]
}

/**
 * 场的量化步：引擎出参一律 `toFixed(n)`，故场值必落在 10⁻ⁿ 的格子上。
 * 取「能整除全部格点值的最大者」；全场同值或找不到则返回 null。
 * @returns { q, range } | null
 */
const QUANTA = [1, 0.1, 0.01, 1e-3, 1e-4, 1e-5, 1e-6]
export function detectQuantum(z) {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < z.length; i++) { const v = z[i]; if (v !== v) continue; if (v < lo) lo = v; if (v > hi) hi = v }
  if (!(hi > lo)) return null
  for (const q of QUANTA) {
    let ok = true
    for (let i = 0; i < z.length; i++) {
      const v = z[i]; if (v !== v) continue
      const r = v / q
      // 容差按「量化步的百万分之一」给：toFixed 的十进制串转成双精度会差几个 ulp，
      // 而真正未取整的数（尾数是随机的）落不进这么窄的缝里
      if (Math.abs(r - Math.round(r)) > 1e-6) { ok = false; break }
    }
    if (ok) return { q, range: hi - lo }
  }
  return null
}

// 相邻格点「值完全相同」的比例——场被取整压成台阶的直接度量。
// 未取整的连续场里这个数是 0；截图那张 0.12 dB 跨度的场是 64%。
export function terraceFrac(z, nx, ny) {
  let same = 0, tot = 0
  for (let j = 0; j < ny; j++) {
    const ro = j * nx
    for (let i = 0; i < nx - 1; i++) {
      const a = z[ro + i], b = z[ro + i + 1]
      if (a === a && b === b) { tot++; if (a === b) same++ }
    }
  }
  for (let j = 0; j < ny - 1; j++) {
    const ro = j * nx
    for (let i = 0; i < nx; i++) {
      const a = z[ro + i], b = z[ro + nx + i]
      if (a === a && b === b) { tot++; if (a === b) same++ }
    }
  }
  return tot ? same / tot : 0
}

/**
 * 去量化：在「±半个量化步」的箱约束内解出最平滑的场。
 *
 * 为什么需要：引擎把 C/N 之类按 `toFixed(2)` 定成字符串，扫描回来的场因此只有 0.01 dB 的
 * 分辨率。跨度 10 dB 的场无所谓（相邻格差着几十步），跨度 0.3 dB 的场就被压成了台阶——
 * 大片格点同值，等值线只能贴着台阶边走，画出来是一片直角阶梯，一条线还被打散成上百段。
 * 那些直角不是场里的东西，是取整留下的痕迹。
 *
 * 怎么做：引擎打印 z 意味着真值 v 落在 [z−q/2, z+q/2] 里，这是取整给出的**硬区间**。
 * 于是在这个区间内找最平滑的一张场（离散 Laplacian 能量最小），用投影 SOR 迭代解：
 * 每格朝四邻均值走一步，再夹回自己的区间。物理场本就是光滑的，故这一步是在「取整已经
 * 丢掉的那点信息」里挑最合理的一种填法，不是凭空造数——**任一格点的改动量硬上界 q/2**。
 *
 * 什么时候不做（宁可留着阶梯也不动手）：
 *   ① 检不出量化步（场本就是连续值）；
 *   ② 跨度不足两个量化步（这种场里除了取整噪声什么也没有，见调用方的 flat 判定）；
 *   ③ 台阶比低于 minTerrace（默认 10%）——量化相对场的起伏已经足够细，无须搅动。
 * 前两条与第三条一起挡住了「整数量」（最大载波数一类）被误抹平：那种场要么检不出小量化步、
 * 要么跨度不够，走不到这里。
 *
 * 现状（2026-07-25 起）：引擎在扫描期间已经多给 4 位小数（见 linkSweep._precise），新扫回来
 * 的场量化步是 10⁻⁶、台阶比 0，第 ③ 道门就把它挡在外面了——**本函数在新数据上不再生效**。
 * 保留它兜两处：一是快照里存着的旧扫描结果，二是别处送来的、仍按 toFixed 取整过的场。
 *
 * @returns { z, q, applied }  applied=false 时 z 就是入参本身（不复制）
 */
export function dequantize(z, nx, ny, opt) {
  const o = opt || {}
  if (!z || !(nx > 1) || !(ny > 1)) return { z, q: 0, applied: false }
  const det = detectQuantum(z)
  if (!det) return { z, q: 0, applied: false }
  const { q, range } = det
  const minT = Number.isFinite(o.minTerrace) ? o.minTerrace : 0.1
  if (!(range >= 2 * q) || terraceFrac(z, nx, ny) < minT) return { z, q, applied: false }

  const h = q / 2
  const f = Float64Array.from(z)
  const w = Number.isFinite(o.omega) ? o.omega : 1.7      // 超松弛因子：1.7 收敛快又不振荡
  const maxIt = Number.isFinite(o.iters) ? o.iters : 200
  const stop = q * 1e-3                                   // 再往下走已在「半步」的千分之一内
  for (let k = 0; k < maxIt; k++) {
    let worst = 0
    for (let j = 0; j < ny; j++) {
      const ro = j * nx
      for (let i = 0; i < nx; i++) {
        const t = ro + i
        const c = z[t]
        if (c !== c) continue                             // 无解格不参与，也不被填上值
        let s = 0, m = 0
        if (i > 0) { const v = f[t - 1]; if (v === v) { s += v; m++ } }
        if (i < nx - 1) { const v = f[t + 1]; if (v === v) { s += v; m++ } }
        if (j > 0) { const v = f[t - nx]; if (v === v) { s += v; m++ } }
        if (j < ny - 1) { const v = f[t + nx]; if (v === v) { s += v; m++ } }
        if (!m) continue                                  // 孤立格：邻居全无解，保持原值
        const old = f[t]
        let v = old + w * (s / m - old)
        if (v < c - h) v = c - h; else if (v > c + h) v = c + h
        f[t] = v
        const d = Math.abs(v - old)
        if (d > worst) worst = d
      }
    }
    if (worst < stop) break
  }
  return { z: f, q, applied: true }
}

/**
 * 场的双三次细化（Catmull-Rom）：把 41×41 的粗网格插成 121×121 的细网格。
 *
 * 为什么细化而不是多算几格：这张图逐格跑一次完整引擎，41×41 已是几秒的代价，再密算不动。
 * 但线不平滑缺的不是采样而是插值——marching squares 只认格点间的线性关系，粗网格上
 * 等值线就是一串折线，拐点全落在格边上。物理场本身是光滑的，用 Catmull-Rom 把格间补成
 * C¹ 曲面再提线，线自然就顺了，而且仍严格穿过每一个真算过的格点（Catmull-Rom 是插值
 * 样条，不是逼近样条）——细化没有编造出「某格算出来是多少」，只补了格与格之间的走势。
 *
 * NaN（算不出的格）按原样扩散：任一端点无解则整段无解，故空洞比原网格外扩一格——
 * 与原先逐像素双线性的表现一致（双线性同样是四角有一个 NaN 就整格留白）。
 *
 * @returns { z, nx, ny } factor ≤ 1 时原样返回入参（不复制）
 */
export function refineField(z, nx, ny, factor) {
  const f = Math.max(1, Math.round(factor || 1))
  if (f === 1 || !(nx > 1) || !(ny > 1)) return { z, nx, ny }
  const rnx = (nx - 1) * f + 1, rny = (ny - 1) * f + 1
  // 可分离：先沿 x 把每一行补密（ny × rnx），再沿 y 把每一列补密（rny × rnx）。
  // 二维一次性算是 16 个抽头，分两趟只要 4+4，结果完全一样。
  const tmp = new Float64Array(ny * rnx)
  for (let j = 0; j < ny; j++) {
    const ro = j * nx, to = j * rnx
    for (let i = 0; i < nx - 1; i++) {
      const p1 = z[ro + i], p2 = z[ro + i + 1]
      const p0 = i > 0 ? z[ro + i - 1] : 2 * p1 - p2
      const p3 = i + 2 < nx ? z[ro + i + 2] : 2 * p2 - p1
      for (let k = 0; k < f; k++) tmp[to + i * f + k] = catmull(p0, p1, p2, p3, k / f)
    }
    tmp[to + rnx - 1] = z[ro + nx - 1]
  }
  const out = new Float64Array(rny * rnx)
  for (let i = 0; i < rnx; i++) {
    for (let j = 0; j < ny - 1; j++) {
      const p1 = tmp[j * rnx + i], p2 = tmp[(j + 1) * rnx + i]
      const p0 = j > 0 ? tmp[(j - 1) * rnx + i] : 2 * p1 - p2
      const p3 = j + 2 < ny ? tmp[(j + 2) * rnx + i] : 2 * p2 - p1
      for (let k = 0; k < f; k++) out[(j * f + k) * rnx + i] = catmull(p0, p1, p2, p3, k / f)
    }
    out[(rny - 1) * rnx + i] = tmp[(ny - 1) * rnx + i]
  }
  return { z: out, nx: rnx, ny: rny }
}

// 一维 Catmull-Rom：t∈[0,1) 落在 p1→p2 之间。
// 端点任一无解 → 整段无解（绝不跨着无解区插值）；外侧邻点无解 → 退成端点自身，即该侧不弯。
// 结果夹到四个抽头的极值之间：三次样条在陡变处会甩出去一点（Runge 型过冲），不夹的话
// 场图上会凭空冒出比任何一格算出来的都极端的值，色标域跟着被撑开。
// 注意首末段的外侧抽头是线性外推出来的（见 refineField），故夹的范围在图的四边略宽一线——
// 换来的是「线性场细化后仍精确线性」：钳成端点自身会让边缘那一格的切向减半，
// 平场的四周会浮出一圈本不存在的镶边。
function catmull(p0, p1, p2, p3, t) {
  if (p1 !== p1 || p2 !== p2) return NaN
  if (t === 0) return p1
  if (p0 !== p0) p0 = p1
  if (p3 !== p3) p3 = p2
  const t2 = t * t, t3 = t2 * t
  const v = 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - 3 * p2 + p3 - p0) * t3)
  const lo = Math.min(p0, p1, p2, p3), hi = Math.max(p0, p1, p2, p3)
  return v < lo ? lo : v > hi ? hi : v
}

// —— 等值线电平：等间距只在场的取值大致均匀时才够用 ——
//
// 等间距电平把线按**值**均匀撒下去，于是每条线之间分到多少「地」，全看场的分布：
// 一张余量图上，主瓣里那一大片（图上占五成面积、也正是读者真要看的那块）只跨几个 dB，
// 等间距下拿到一两条线；而覆盖边缘掉下去的长尾跨着几十个 dB，反倒吃掉大半电平表。
// 读者看到的就是「档位都画在没什么可读的那一侧，最关心的那片里一条线也没有」。
// 这与色标的自适应展布（见 lbColorScale 的 buildStretch）是同一件事的两面：
// 视觉资源该按数据的疏密分，不按值域的长短分。
//
// 做法是**局部加密**，不是把电平表整个改成分位数：
//   ① 骨架仍是常规的 nice step（下称 base），全域等间距、临界值仍精确入表——
//      「线的疏密 = 场的陡缓」这条读图直觉靠它保住，出图与旧图也仍对得上账；
//   ② 逐带量它占了多少面积，只给超出均摊份额的那几带插入加密线；
//   ③ 加密线的间距一律是 base 的整数分之一（2/4/5/10），故它们仍是好读的数、
//      且与 base 线严格对齐——不会出现 11.37 这种电平，也不会出现两套错开的网格。
// 加密线在图上画得比骨架轻（见 LbSurfacePlot 的 .sf-iso-minor），读者一眼分得出
// 哪些是全域的骨架、哪些是局部补的细节。
const SUBDIV = {
  target: 2,     // 加密后的目标带数 = target × count（每带的均摊面积份额 = 1/(target·count)）
  maxDiv: 10,    // 单带最多细到 base/10
  cap: 4         // 电平总数上限 = 2·count + cap
}

/**
 * 等值线电平选取。
 * 有临界值时把它钉进电平表并以它为对齐基准（临界线必须恰好画在临界值上，
 * 差 0.2 dB 的一条线画在 0 附近，读者会当成可行边界）；否则常规取整。
 * @param samples 升序排好的场值样本；给了就按数据密度局部加密（见上），不给则纯等间距
 * @returns { levels:number[], step:number, base:number, minor:number[] }
 *   levels 含加密线（升序）；minor 只列加密出来的那些；step 是最细的间距（供格式化小数位）
 */
export function contourLevels(min, max, crit, count, samples) {
  const n = Math.max(2, count || 8)
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return { levels: [], step: 0, base: 0, minor: [] }
  const raw = (max - min) / n
  const exp = Math.floor(Math.log10(raw))
  const f = raw / Math.pow(10, exp)
  const base = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * Math.pow(10, exp)
  const anchor = Number.isFinite(crit) ? crit : 0
  const rnd = (v) => Math.round(v * 1e9) / 1e9
  const k0 = Math.ceil((min - anchor) / base)
  const k1 = Math.floor((max - anchor) / base)
  const levels = []
  for (let k = k0; k <= k1; k++) levels.push(rnd(anchor + k * base))
  const plain = { levels, step: base, base, minor: [] }
  if (!samples || samples.length < 64) return plain

  // 域内样本数为分母：域外的值（色标域取 2–98 分位，两头各裁掉一截）本就不画线，
  // 算进来只会把每带的占比一律稀释、加密判据整体偏松
  const lower = (v) => { let lo = 0, hi = samples.length; while (lo < hi) { const m = (lo + hi) >> 1; if (samples[m] < v) lo = m + 1; else hi = m } return lo }
  const tot = lower(max) - lower(min)
  if (tot < 64) return plain
  const edges = [min, ...levels.filter((v) => v > min + 1e-9 && v < max - 1e-9), max]
  if (edges.length < 3) return plain          // 域内一条骨架线都没有，无从谈局部

  // 细分梯度：分完仍要是「好读的数」。base 首位为 2 时不能用 /5（2→0.4），改用 /4
  const lead = Math.round(base / Math.pow(10, Math.floor(Math.log10(base) + 1e-9)))
  const DIV = lead === 2 ? [2, 4, 10] : [2, 5, 10]
  // 一带内 base/d 的倍数（与骨架重合的跳过）
  const subOf = (a, b, d) => {
    const out = []
    if (d <= 1) return out
    const s = base / d
    for (let k = Math.floor((a - anchor) / s); k <= Math.ceil((b - anchor) / s); k++) {
      if (((k % d) + d) % d === 0) continue
      const v = rnd(anchor + k * s)
      if (v > a + 1e-9 && v < b - 1e-9) out.push(v)
    }
    return out
  }
  const share = 1 / (SUBDIV.target * n)
  const w = [], div = []
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i], b = edges[i + 1]
    const wi = (lower(b) - lower(a)) / tot
    const need = Math.min(SUBDIV.maxDiv, Math.ceil(wi / share))     // 这一带该切成几份
    w.push(wi)
    // 档位取**比例上最接近** need 的那一档（不是「≥need 的最小档」——need=7 时那会取到
    // base/10，一带里塞 9 条线，比要的多出一半，还把总数顶到封顶去挤别的带）
    let d = need <= 1 ? 1 : DIV.reduce((best, c) =>
      Math.abs(Math.log(c / need)) < Math.abs(Math.log(best / need)) ? c : best, DIV[0])
    // 但档位必须真的插得出线：域两端那两带常常比一整格窄（正值区 [0, +1.6] 碰上
    // base/2=2.5 就一条也插不进去，读者看到的仍是「最想看的那片里没有线」），故往细里走。
    // 门限只要 60% —— 要求「一条不少地插满 need−1 条」的话，宽带会被顶到 base/10
    // 上去（一带塞 9 条），而宽带本就不缺线，缺线的是窄带
    if (d > 1) {
      const least = Math.max(1, Math.ceil((need - 1) * 0.6))
      for (const cand of DIV) {
        if (cand < d) continue
        d = cand
        if (subOf(a, b, cand).length >= least) break
      }
    }
    div.push(d)
  }
  // 总数封顶：**逐档降**，每次挑「每条加密线摊到的面积最少」的那一带降一级——
  // 那是最不划算的一处加密。早先是「面积最小的带整带取消」，可主瓣顶端那种又窄又关键的带
  // 面积本就不大，一封顶就被整带抹掉，等于专挑读者最想看的地方下手。
  const extra = () => div.reduce((s, d, i) => s + subOf(edges[i], edges[i + 1], d).length, 0)
  const maxN = 2 * n + SUBDIV.cap
  for (let guard = 0; guard < 64 && levels.length + extra() > maxN; guard++) {
    let pick = -1, worst = Infinity
    for (let i = 0; i < div.length; i++) {
      const c = subOf(edges[i], edges[i + 1], div[i]).length
      if (!c) continue
      const per = w[i] / c
      if (per < worst) { worst = per; pick = i }
    }
    if (pick < 0) break
    const k = DIV.indexOf(div[pick])
    div[pick] = k > 0 ? DIV[k - 1] : 1
  }
  const minor = []
  for (let i = 0; i < div.length; i++) minor.push(...subOf(edges[i], edges[i + 1], div[i]))
  if (!minor.length) return plain
  const fine = div.reduce((s, d) => Math.min(s, d > 1 ? base / d : s), base)
  return { levels: levels.concat(minor).sort((a, b) => a - b), step: fine, base, minor }
}

// 场的极值（跳过 NaN）；全空返回 null
export function fieldExtent(z) {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < z.length; i++) {
    const v = z[i]
    if (v !== v) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return lo === Infinity ? null : [lo, hi]
}
