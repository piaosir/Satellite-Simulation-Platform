// 应用场景仿真 · 拓扑图的正交连接器路由（纯函数，可单测）。
//
// ============ 为什么自研，不引 ELK ============
// 一期的连线是「跨带中点折一次、同带跨层贝塞尔绕行」—— 会穿过节点、互相重叠、没有避障、
// 没有并行线错开、没有交叉处理。这不是调参能救的，缺的是路由本身。
// 现成方案里 elkjs 是 5.5 MB、EPL-2.0/GPL 双许可，且它的分层方向与本图「横向信号流 ×
// 纵向物理层带」的泳道语义正交 —— 硬套要把图拆成层级复合图，代价高于自研这三百行。
//
// ============ 做法：Wybrow et al. 2009《Orthogonal Connector Routing》三步 ============
//   ① 正交可见性图：把所有障碍（节点卡 + 站点容器，外扩一圈）的边界线延长成候选轨道，
//      交点为图顶点，相邻顶点之间不穿过障碍即连边；
//   ② A* 找最少折弯的最短路：代价 = 长度 + 折弯罚（一个弯 ≈ 40 px 当量）——
//      只按长度找会得出「锯齿状但更短」的路，读图上远不如多走一点、少拐两个弯；
//   ③ nudging：共享同一条通道的平行段按固定间距错开，避免两条线叠成一条。
//      ★ 错开顺序按【边 id】稳定排序，不按遍历顺序 —— 否则同一份数据两次布局线会互换位置，
//        拖一下面板整张图就跳。
//
// 另外两件 Visio / draw.io 的成图惯例：
//   · 跳线（line jump）：正交交叉处画一段小弧，让「交叉」与「相连」在图上分得开；
//   · 总线合并：多个末端进同一台汇聚设备时，靠近汇聚端共用一段主干、分叉处画实心点。

const PAD = 12          // 障碍外扩（连线离卡片留的呼吸）
const BEND = 40         // 一个折弯的长度当量
const NUDGE = 8         // 平行段错开间距
const GRID = 8          // 折点吸附网格

// ── 小工具 ──
const uniqSorted = (arr, eps) => {
  const a = arr.slice().sort((x, y) => x - y)
  const out = []
  for (const v of a) if (!out.length || Math.abs(v - out[out.length - 1]) > (eps || 0.5)) out.push(v)
  return out
}
const rectOf = (n, pad) => ({
  x0: n.x - n.w / 2 - pad, x1: n.x + n.w / 2 + pad,
  y0: n.y - n.h / 2 - pad, y1: n.y + n.h / 2 + pad
})
/** 点在矩形【内部】（边界不算，端口点就落在边界上） */
const inside = (r, x, y) => x > r.x0 + 1e-6 && x < r.x1 - 1e-6 && y > r.y0 + 1e-6 && y < r.y1 - 1e-6

/** 二叉堆（A* 的开放集）。JS 里 shift() 是 O(n)，20 节点的图上一条边要探上千个点，用得起堆 */
class Heap {
  constructor() { this.a = [] }
  get size() { return this.a.length }
  push(v, k) {
    const a = this.a
    a.push({ v, k })
    let i = a.length - 1
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].k <= a[i].k) break; const t = a[p]; a[p] = a[i]; a[i] = t; i = p }
  }
  pop() {
    const a = this.a
    const top = a[0]
    const last = a.pop()
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let m = i
        if (l < a.length && a[l].k < a[m].k) m = l
        if (r < a.length && a[r].k < a[m].k) m = r
        if (m === i) break
        const t = a[m]; a[m] = a[i]; a[i] = t; i = m
      }
    }
    return top && top.v
  }
}

/**
 * 建正交可见性图。
 * @param nodes [{ id, x, y, w, h }] 障碍（节点卡与站点容器）
 * @param extraX / extraY 额外要留的轨道坐标（端口点所在的那几条）
 * @param bounds { x0, y0, x1, y1 } 画布范围（轨道不超出）
 */
export function buildVisGraph(nodes, extraX, extraY, bounds, opt) {
  const pad = (opt && opt.pad != null) ? opt.pad : PAD
  const obs = nodes.map((n) => rectOf(n, pad))
  const xs = [], ys = []
  for (const r of obs) { xs.push(r.x0, r.x1, (r.x0 + r.x1) / 2); ys.push(r.y0, r.y1, (r.y0 + r.y1) / 2) }
  for (const v of extraX || []) xs.push(v)
  for (const v of extraY || []) ys.push(v)
  if (bounds) { xs.push(bounds.x0, bounds.x1); ys.push(bounds.y0, bounds.y1) }
  const X = uniqSorted(xs), Y = uniqSorted(ys)
  const nx = X.length, ny = Y.length
  const ix = new Map(), iy = new Map()
  X.forEach((v, i) => ix.set(v, i)); Y.forEach((v, i) => iy.set(v, i))

  // 顶点可用性：落在任一障碍【内部】的点不可用（边界上可用 —— 那正是贴着卡片走的通道）
  const ok = new Uint8Array(nx * ny).fill(1)
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x = X[i], y = Y[j]
      for (const r of obs) if (inside(r, x, y)) { ok[i * ny + j] = 0; break }
    }
  }
  // 相邻顶点之间的段是否可走：段的中点不在任何障碍内部即可（顶点已按障碍边界取，中点判够用）
  const passH = new Uint8Array(nx * ny)   // (i,j) → (i+1,j)
  const passV = new Uint8Array(nx * ny)   // (i,j) → (i,j+1)
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const k = i * ny + j
      if (!ok[k]) continue
      if (i + 1 < nx && ok[(i + 1) * ny + j]) {
        const mx = (X[i] + X[i + 1]) / 2, my = Y[j]
        let blocked = false
        for (const r of obs) if (inside(r, mx, my)) { blocked = true; break }
        if (!blocked) passH[k] = 1
      }
      if (j + 1 < ny && ok[i * ny + j + 1]) {
        const mx = X[i], my = (Y[j] + Y[j + 1]) / 2
        let blocked = false
        for (const r of obs) if (inside(r, mx, my)) { blocked = true; break }
        if (!blocked) passV[k] = 1
      }
    }
  }
  return { X, Y, nx, ny, ok, passH, passV, ix, iy, obs }
}

/** 最近的轨道下标（端口点未必正好落在某条轨道上时） */
const nearestIdx = (arr, v) => {
  let best = 0, bd = Infinity
  for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - v); if (d < bd) { bd = d; best = i } }
  return best
}

/**
 * A*：在可见性图上从 (sx,sy) 走到 (tx,ty)，代价 = 长度 + 折弯罚。
 * 出参是格点折线（含起终点），已合并共线段。走不通返回 null（调用方退回直连）。
 */
export function routeOne(G, s, t, opt) {
  const bend = (opt && opt.bend != null) ? opt.bend : BEND
  const { X, Y, ny, ok, passH, passV } = G
  const si = nearestIdx(X, s.x), sj = nearestIdx(Y, s.y)
  const ti = nearestIdx(X, t.x), tj = nearestIdx(Y, t.y)
  if (!ok[si * ny + sj] || !ok[ti * ny + tj]) return null
  // 状态 = 格点 × 进入方向（0 横 1 竖）—— 折弯罚要知道「上一步是横着来的还是竖着来的」
  const N = X.length * Y.length
  const best = new Float64Array(N * 2).fill(Infinity)
  const prev = new Int32Array(N * 2).fill(-1)
  const h = (i, j) => Math.abs(X[i] - X[ti]) + Math.abs(Y[j] - Y[tj])
  const heap = new Heap()
  for (const d of [0, 1]) { best[(si * ny + sj) * 2 + d] = 0; heap.push((si * ny + sj) * 2 + d, h(si, sj)) }
  let hit = -1
  let guard = 0
  while (heap.size && guard++ < 400000) {
    const cur = heap.pop()
    const k = cur >> 1, dir = cur & 1
    const i = (k / ny) | 0, j = k % ny
    if (i === ti && j === tj) { hit = cur; break }
    const g = best[cur]
    const step = (ni, nj, nd, len) => {
      const nk = ni * ny + nj
      if (!ok[nk]) return
      const cost = g + len + (nd === dir ? 0 : bend)
      const idx = nk * 2 + nd
      if (cost < best[idx] - 1e-9) { best[idx] = cost; prev[idx] = cur; heap.push(idx, cost + h(ni, nj)) }
    }
    if (i + 1 < X.length && passH[k]) step(i + 1, j, 0, X[i + 1] - X[i])
    if (i > 0 && passH[(i - 1) * ny + j]) step(i - 1, j, 0, X[i] - X[i - 1])
    if (j + 1 < Y.length && passV[k]) step(i, j + 1, 1, Y[j + 1] - Y[j])
    if (j > 0 && passV[i * ny + j - 1]) step(i, j - 1, 1, Y[j] - Y[j - 1])
  }
  if (hit < 0) return null
  const pts = []
  for (let c = hit; c >= 0; c = prev[c]) {
    const k = c >> 1
    const i = (k / ny) | 0, j = k % ny
    pts.push([X[i], Y[j]])
    if (c === prev[c]) break
  }
  pts.reverse()
  return simplify(pts)
}

/** 合并共线的连续点（A* 出来的折线每格一个点，画出来的是同一条线但点数是几十倍） */
export function simplify(pts) {
  const out = []
  for (const p of pts) {
    const n = out.length
    if (n >= 2) {
      const a = out[n - 2], b = out[n - 1]
      if ((Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(b[0] - p[0]) < 1e-6) ||
          (Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(b[1] - p[1]) < 1e-6)) { out[n - 1] = p; continue }
    }
    if (n && Math.abs(out[n - 1][0] - p[0]) < 1e-6 && Math.abs(out[n - 1][1] - p[1]) < 1e-6) continue
    out.push(p)
  }
  return out
}

/**
 * 端口点：按两端相对位置挑出边 / 入边落在卡片的哪一条边上。
 *   · 同带（|Δy| 小）—— 出右入左，这是信号流的读图方向；
 *   · 跨带 —— 出上/下入下/上，卫星在上、末端在下，线走竖直通道；
 *   · 备份边（role==='backup'）—— 优先走外侧（往下让一档），与主路分开。
 */
export function portPoint(from, to, opt) {
  const o = opt || {}
  const dx = to.x - from.x, dy = to.y - from.y
  const horiz = Math.abs(dx) >= Math.abs(dy) * 1.1
  if (horiz) {
    const side = dx >= 0 ? 1 : -1
    return { x: from.x + side * (from.w / 2), y: from.y + (o.slot || 0), side: side > 0 ? 'r' : 'l' }
  }
  const side = dy >= 0 ? 1 : -1
  return { x: from.x + (o.slot || 0), y: from.y + side * (from.h / 2), side: side > 0 ? 'b' : 't' }
}

/**
 * 整图路由。
 * @param nodes  [{ id, x, y, w, h }]
 * @param edges  [{ id, a, b, role }]（a/b 是 node id）
 * @param opt    { pad, bend, nudge, bounds }
 * @returns { routes: Map<edgeId, [[x,y],…]>, jumps: [{x,y,dir}] , ms }
 */
export function routeAll(nodes, edges, opt) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const o = opt || {}
  const pad = o.pad != null ? o.pad : PAD
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // 端口点先算出来（它们的坐标要进可见性图的轨道集合，否则接不上）
  const ends = []
  for (const e of edges) {
    const a = byId.get(e.a), b = byId.get(e.b)
    if (!a || !b) { ends.push(null); continue }
    // 备份边往外侧让一档：主备两条线连着同一对节点时，不让就完全重叠
    const slot = e.role === 'backup' ? Math.min(a.h, b.h) * 0.28 : 0
    ends.push({ p: portPoint(a, b, { slot }), q: portPoint(b, a, { slot }) })
  }
  // ★ 四个侧面都要备着：首选那一侧的出口可能正好被隔壁那张卡（外扩一圈之后）堵死 ——
  //   同一格里堆叠的两张卡只隔十几像素，外扩后就贴上了。一期没有这一步，走不通就退回
  //   L 形直角连，而那条线正好从中间那张卡身上压过去（「零边穿节点」这条判据就是这么破的）。
  const SIDES = ['r', 'l', 't', 'b']
  const sidePoint = (n, side, slot) => ({
    x: n.x + (side === 'r' ? n.w / 2 : side === 'l' ? -n.w / 2 : (slot || 0)),
    y: n.y + (side === 'b' ? n.h / 2 : side === 't' ? -n.h / 2 : (slot || 0)),
    side
  })
  const ex = [], ey = []
  for (let i = 0; i < ends.length; i++) {
    const en = ends[i]
    if (!en) continue
    const a = byId.get(edges[i].a), b = byId.get(edges[i].b)
    const slot = edges[i].role === 'backup' ? Math.min(a.h, b.h) * 0.28 : 0
    // 端口点要能从卡片边界走到外扩边界上，故把「外扩一圈」的那条轨道也加进去；
    // 四个侧面全部登记 —— 备选侧要用得上，它的轨道就得在图里
    for (const nd of [a, b]) {
      for (const sd of SIDES) {
        const p = sidePoint(nd, sd, slot)
        ex.push(p.x); ey.push(p.y)
        if (sd === 'r') ex.push(p.x + pad); else if (sd === 'l') ex.push(p.x - pad)
        else if (sd === 'b') ey.push(p.y + pad); else ey.push(p.y - pad)
      }
    }
  }
  const G = buildVisGraph(nodes, ex, ey, o.bounds, { pad })

  const routes = new Map()
  // ★ 逐边路由的顺序按 edge id 排：A* 本身是确定的，但 nudging 的错开次序依赖遍历顺序，
  //   不定序就会「同一份数据两次布局线互换位置」。
  const order = edges.map((e, i) => ({ e, i })).sort((a, b) => String(a.e.id).localeCompare(String(b.e.id)))
  for (const { e, i } of order) {
    const en = ends[i]
    const a = byId.get(e.a), b = byId.get(e.b)
    if (!en || !a || !b) continue
    const slot = e.role === 'backup' ? Math.min(a.h, b.h) * 0.28 : 0
    // 侧面组合按「首选在前」排：自然侧 → 其余。首选走得通就不会换，图形与不加这一步时一致。
    const pref = (list, first) => [first, ...list.filter((x) => x !== first)]
    let done = null
    for (const sa of pref(SIDES, en.p.side)) {
      for (const sb of pref(SIDES, en.q.side)) {
        const P = sidePoint(a, sa, slot), Q = sidePoint(b, sb, slot)
        const s = stub(P, pad), t = stub(Q, pad)
        const path = routeOne(G, s, t, { bend: o.bend })
        if (path) { done = simplify([[P.x, P.y], ...path, [Q.x, Q.y]]); break }
      }
      if (done) break
    }
    if (!done) {
      // 四×四都走不通（图被围死）：退回一次折弯的直角连。这条线可能压到别的卡上，
      // 但比不画线好 —— 且测试里这条路径不该被走到，走到了就是可见性图有洞。
      const s = stub(en.p, pad), t = stub(en.q, pad)
      done = simplify([[en.p.x, en.p.y], [s.x, s.y], [s.x, t.y], [t.x, t.y], [en.q.x, en.q.y]])
    }
    routes.set(e.id, done)
  }
  nudgeAll(routes, o.nudge != null ? o.nudge : NUDGE)
  const jumps = findJumps(routes)
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
  return { routes, jumps, ms }
}

const stub = (p, pad) => ({
  x: p.x + (p.side === 'r' ? pad : p.side === 'l' ? -pad : 0),
  y: p.y + (p.side === 'b' ? pad : p.side === 't' ? -pad : 0)
})

/**
 * nudging：共享同一条通道（同 x 的竖段 / 同 y 的横段，且跨度有重叠）的平行段按固定间距错开。
 * ★ 只动【中间段】：首末段连着端口点，动了线就从卡片外面接进来。
 */
export function nudgeAll(routes, gap) {
  const chans = new Map()   // 'v|x' / 'h|y' → [{ id, si, lo, hi }]
  for (const [id, pts] of routes) {
    for (let i = 1; i < pts.length - 2; i++) {
      const p = pts[i], q = pts[i + 1]
      const vert = Math.abs(p[0] - q[0]) < 1e-6
      const key = (vert ? 'v|' : 'h|') + Math.round((vert ? p[0] : p[1]) / 2) * 2
      if (!chans.has(key)) chans.set(key, [])
      chans.get(key).push({
        id, si: i, vert,
        lo: Math.min(vert ? p[1] : p[0], vert ? q[1] : q[0]),
        hi: Math.max(vert ? p[1] : p[0], vert ? q[1] : q[0])
      })
    }
  }
  for (const [, list] of chans) {
    if (list.length < 2) continue
    // 有重叠跨度的才算「挤在一条通道上」；不重叠的两段共线并不互相遮挡
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)) || a.si - b.si)
    const groups = []
    for (const seg of list) {
      let g = groups.find((gr) => gr.some((x) => seg.lo < x.hi - 1 && seg.hi > x.lo + 1))
      if (!g) { g = []; groups.push(g) }
      g.push(seg)
    }
    for (const g of groups) {
      if (g.length < 2) continue
      const mid = (g.length - 1) / 2
      g.forEach((seg, k) => {
        const d = (k - mid) * gap
        if (!d) return
        const pts = routes.get(seg.id)
        if (!pts) return
        if (seg.vert) { pts[seg.si][0] += d; pts[seg.si + 1][0] += d }
        else { pts[seg.si][1] += d; pts[seg.si + 1][1] += d }
      })
    }
  }
  // 错开之后相邻段可能不再正交（端点没跟着动）：把相邻段的公共端补回去
  for (const [, pts] of routes) {
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1]
      if (Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6) continue
      // a→b 既不水平也不竖直：把 b 拉回与 a 对齐的那一维
      if (Math.abs(b[0] - c[0]) < 1e-6) b[1] = a[1]; else b[0] = a[0]
    }
  }
}

/**
 * 交叉跳线：两条【不同边】的横段与竖段真交叉的位置。
 * Visio 的 line jump 惯例 —— 让「交叉」与「相连」在图上一眼分得开。
 */
export function findJumps(routes) {
  const H = [], V = []
  for (const [id, pts] of routes) {
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1]
      if (Math.abs(p[1] - q[1]) < 1e-6) H.push({ id, y: p[1], x0: Math.min(p[0], q[0]), x1: Math.max(p[0], q[0]) })
      else if (Math.abs(p[0] - q[0]) < 1e-6) V.push({ id, x: p[0], y0: Math.min(p[1], q[1]), y1: Math.max(p[1], q[1]) })
    }
  }
  const out = []
  for (const h of H) {
    for (const v of V) {
      if (h.id === v.id) continue
      if (v.x > h.x0 + 2 && v.x < h.x1 - 2 && h.y > v.y0 + 2 && h.y < v.y1 - 2) out.push({ x: v.x, y: h.y, id: h.id })
    }
  }
  return out
}

/** 折线上最靠近 (px,py) 的距离（命中测试；一期那段贝塞尔采样已删） */
export function polyDist(pts, px, py) {
  let d = Infinity
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]))
  return d
}
export function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const l2 = dx * dx + dy * dy
  if (!l2) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/** 折线最长的水平段中点 —— 边标放这里（竖着放标签在正交图里读不了） */
export function labelAnchor(pts) {
  let best = null, bl = -1
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1]
    if (Math.abs(p[1] - q[1]) > 1e-6) continue
    const l = Math.abs(q[0] - p[0])
    if (l > bl) { bl = l; best = [(p[0] + q[0]) / 2, p[1]] }
  }
  if (best) return { x: best[0], y: best[1], room: bl }
  // 没有水平段（纯竖直连）：取中点，可用宽度按 0 记，调用方据此降级成只显读数
  const m = pts[Math.floor(pts.length / 2)] || [0, 0]
  return { x: m[0], y: m[1], room: 0 }
}

/**
 * 标签消重叠：贪心平移。矩形按面积序（大的先占位），后来的沿 y 找最近的空档。
 * 找不到空档就标记 hide，由调用方降级（省介质名只留读数）。
 */
export function placeLabels(boxes, step, tries) {
  const st = step || 14, tr = tries || 6
  const done = []
  const hit = (r) => done.some((d) => !(r.x1 <= d.x0 || r.x0 >= d.x1 || r.y1 <= d.y0 || r.y0 >= d.y1))
  const out = []
  for (const b of boxes.slice().sort((a, c) => (c.w * c.h) - (a.w * a.h))) {
    let placed = null
    for (let k = 0; k <= tr && !placed; k++) {
      for (const s of (k === 0 ? [0] : [-k * st, k * st])) {
        const r = { x0: b.x - b.w / 2, x1: b.x + b.w / 2, y0: b.y + s - b.h / 2, y1: b.y + s + b.h / 2 }
        if (!hit(r)) { placed = { ...b, y: b.y + s, hide: false }; done.push(r); break }
      }
    }
    out.push(placed || { ...b, hide: true })
  }
  // 还原成入参顺序（调用方按边序取）
  const byId = new Map(out.map((r) => [r.id, r]))
  return boxes.map((b) => byId.get(b.id) || { ...b, hide: true })
}

export { PAD, BEND, NUDGE, GRID }
export default { buildVisGraph, routeOne, routeAll, findJumps, polyDist, labelAnchor, placeLabels, simplify }
