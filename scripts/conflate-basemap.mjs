// 底图精度档的「贴合」—— 把争议叠加面 / 自带线里【几乎】与既有边界重合、却不共享弧的段落，改成真正共享弧。
//
// 为什么要这一步：粗档的三份来源在几何上互不严丝合缝 ——
//   · NE 50m 的争议面图层（breakaway_disputed_areas）与 map_units 是各自抽稀的：藏南 / 阿克赛钦 / 克什米尔 /
//     戈兰 / 西撒 …… 的叠加面边界与宿主的国界差 0.001°–0.005°，拓扑上是两条弧。屏上就是一根根发丝般的
//     「透镜」：两侧都要画国界时（中国视角下藏南东端的 IN-ARP|IND 与 IND|CHN 那三对）就成了小眼睛、碎线头；
//   · backfill 从 10m 搬进来的单元（中不争议区 / 埃塞奎博 / 哈拉伊卜 / 卡拉帕尼 …）是 10m 精度的几何，
//     外侧边与 50m 的国界差 0.01°–0.17°，而且首尾不接在 50m 的弧网上 —— 国界旁边多一条平行线、两头悬空；
//   · NE 50m 的 boundary_lines_land 里麦克马洪线有四段与 map_units 的边界差到 0.06°–0.12°，构建期的 ε 缓冲
//     （0.05°）够不着，被当成「自带几何」留下来 —— 中立视角下沿国界多出一条勾勾。
//
// 做法（拓扑级，不做面的布尔运算）：
//   A. 叠加面 D 的【独占弧】（只有 D 引用的弧）里，凡是整条都落在「别的单元的弧」TOL 邻域内的，把两端
//      吸附到那张弧网上：端点若已是弧网节点则直接用，否则投影到最近的弧段、在投影点把那条弧拆成两段
//      （所有引用它的几何一并改写），再把 D 这一端的节点挪到投影点；
//   B. 然后在弧网上找两端之间的最短路（Dijkstra，只走 TOL 邻域内的弧，基础单元的弧权重更低），路径与
//      原弧的双向 Hausdorff 距离都 ≤ TOL、长度不离谱、且路径上没有 D 已经引用的弧（否则环会折返退化），
//      就用这条路径顶替原弧 —— D 从此与宿主 / 邻国真正共享边界。★ 每个叠加面至少留一条独占弧（它的内侧边），
//      否则休达 / 梅利利亚这类窄条会整块贴到海岸线上消失；
//   C. 自带线（未定界 / 停火线）里只被线引用的弧同样处理（目标网络 = 全部单元的弧），贴上去之后就成了
//      「与派生弧精确共享」的段落 —— 按构建脚本同一口径转成 lineCls 分类标注、不再画第二遍。
//   最后按构建脚本的规则重算受影响弧的 adj，清掉无人引用的弧并压实序号。
//
// ★ 不幂等（与 backfill 同）：跑过一次 meta.conflated 在场即拒绝；重跑先 git checkout 那个 json。
// ★ 顺序：build-basemap → backfill-basemap → conflate-basemap。10m 不需要（无回填、自带线已精确共享）。
//
// 用法：node scripts/conflate-basemap.mjs [50m|110m …] [--dry]（缺省 50m）。纯离线。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { geoArea } from 'd3-geo'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'src', 'viz', 'globe3d', 'data')

// 叠加面弧 / 自带线弧到目标弧网的容差（°）。50m 实测：原生透镜 ≤0.005，回填单元外侧边 ≤0.17，
// 麦克马洪线四段 ≤0.12。真正的内侧边（叠加面自己的那条边）离宿主边界都在 0.19° 以上。
const TOL = { '50m': 0.18, '110m': 0.3 }
const TOL_LINE = { '50m': 0.15, '110m': 0.3 }
// 投影点离既有顶点 / 节点近于此 → 在该顶点处拆弧 / 直接用该节点，不造新点。实际取值在 conflate() 里按该档的
// 量化格边长放大：两个点相距不到一格，量化之后就是同一个点 —— 若各自当成不同节点，环上就会冒出重复顶点（8 字形）
const NODE_EPS_MIN = 2e-4
const CELL = 0.5               // 空间格网格边长（°）
const RANK = { indefinite: 1, loc: 2 }
const DRY = process.argv.includes('--dry')

const key = (p) => p[0].toFixed(5) + ',' + p[1].toFixed(5)
const hyp = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const polyLen = (a) => { let s = 0; for (let i = 1; i < a.length; i++) s += hyp(a[i], a[i - 1]); return s }
// 点到线段的最近点参数与距离
function segNearest(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const L2 = dx * dx + dy * dy
  let t = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0
  t = Math.max(0, Math.min(1, t))
  const q = [a[0] + t * dx, a[1] + t * dy]
  return { t, q, d: hyp(p, q) }
}
function distToPoly(p, poly) {
  let m = Infinity
  for (let i = 1; i < poly.length; i++) { const d = segNearest(p, poly[i - 1], poly[i]).d; if (d < m) m = d }
  return poly.length === 1 ? hyp(p, poly[0]) : m
}
const hausdorff = (A, B) => { let m = 0; for (const p of A) m = Math.max(m, distToPoly(p, B)); return m }
const bboxOf = (poly) => { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const p of poly) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1] } return [x0, y0, x1, y1] }

function decodeArcs(topo) {
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate
  return topo.arcs.map((a) => { let x = 0, y = 0; return a.map((d) => { x += d[0]; y += d[1]; return [x * sx + tx, y * sy + ty] }) })
}
function encodeArc(pts, transform) {
  const [sx, sy] = transform.scale, [tx, ty] = transform.translate
  let px = 0, py = 0
  const out = []
  for (const p of pts) { const x = Math.round((p[0] - tx) / sx), y = Math.round((p[1] - ty) / sy); out.push([x - px, y - py]); px = x; py = y }
  return out
}
// 几何里的 arc 序号列表（带正负向）逐条访问 / 改写
function walkArcs(g, fn) {
  const w = (a) => (!a.length ? a : Array.isArray(a[0]) ? a.map(w) : fn(a))
  g.arcs = w(g.arcs)
}
function arcIdxSet(g, out = new Set()) { walkArcs(g, (list) => { for (const i of list) out.add(i < 0 ? ~i : i); return list }); return out }

function conflate(scale) {
  const f = path.join(DIR, 'basemap-' + scale + '.json')
  const T = JSON.parse(fs.readFileSync(f, 'utf8'))
  console.log('\n=== ' + scale + ' ===')
  if (T.meta && T.meta.conflated) {
    console.log('  已经贴合过（meta.conflated 在场）。要重跑请先 git checkout src/viz/globe3d/data/basemap-' + scale + '.json')
    return
  }
  const tol = TOL[scale], tolLine = TOL_LINE[scale]
  if (!tol) { console.log('  该档不需要贴合'); return }
  // ★ 吸附 / 拆弧用小阈值（试过放大到一个量化格：吸附会改吸到别的既有节点上，中不春丕河谷那块的处理顺序被打乱、
  //   内侧边先贴了上去）；「量化后会不会重合」交给 degenerate 用格键去判（qkey）。
  const nodeEps = NODE_EPS_MIN
  const [qsx, qsy] = T.transform.scale, [qtx, qty] = T.transform.translate
  const qkey = (p) => Math.round((p[0] - qtx) / qsx) + ',' + Math.round((p[1] - qty) / qsy)
  const arcs = decodeArcs(T)
  // 原始几何快照：贴合前后的「像不像」一律拿它比 —— 相邻弧先处理时会把公共节点挪到弧网上，
  // 当前几何的端点已经带着 ≤TOL 的位移，再拿它比 Hausdorff 就虚高（BT-CN-NW 东段就是这么被误拒的）
  const orig = arcs.map((a) => a.map((p) => [p[0], p[1]]))
  const units = T.objects.units.geometries, lines = T.objects.lines.geometries
  const props = new Map(units.map((g) => [g.properties.u, g.properties]))
  const geoms = [...units, ...lines]
  // 弧 → 引用它的单元 id 集合；弧 → 引用它的线要素序号集合
  const useU = new Map(), useL = new Map()
  const addUse = (m, a, v) => { let s = m.get(a); if (!s) m.set(a, s = new Set()); s.add(v) }
  units.forEach((g) => { for (const a of arcIdxSet(g)) addUse(useU, a, g.properties.u) })
  lines.forEach((g, i) => { for (const a of arcIdxSet(g)) addUse(useL, a, i) })
  const isBase = (u) => { const p = props.get(u); return !!p && !p.dispute }
  const usedByBase = (a) => { const s = useU.get(a); if (!s) return false; for (const u of s) if (isBase(u)) return true; return false }

  // ---- 空间格网：弧序号按其线段包围盒落格（只作候选筛选，距离一律按当前坐标现算）----
  const grid = new Map()
  const cellsOf = (b) => { const out = []; for (let cx = Math.floor(b[0] / CELL); cx <= Math.floor(b[2] / CELL); cx++) for (let cy = Math.floor(b[1] / CELL); cy <= Math.floor(b[3] / CELL); cy++) out.push(cx + ',' + cy); return out }
  const indexArc = (a) => { for (const c of cellsOf(bboxOf(arcs[a]))) { let s = grid.get(c); if (!s) grid.set(c, s = new Set()); s.add(a) } }
  arcs.forEach((_, a) => indexArc(a))
  const nearArcs = (b) => { const out = new Set(); for (const c of cellsOf(b)) { const s = grid.get(c); if (s) for (const a of s) out.add(a) } return out }

  // ---- 节点表：坐标键 → 以它为端点的弧集合 ----
  const nodes = new Map()
  const addNode = (a) => { const A = arcs[a]; for (const p of [A[0], A[A.length - 1]]) addUse(nodes, key(p), a) }
  const delNode = (a) => { const A = arcs[a]; for (const p of [A[0], A[A.length - 1]]) { const s = nodes.get(key(p)); if (s) { s.delete(a); if (!s.size) nodes.delete(key(p)) } } }
  arcs.forEach((_, a) => addNode(a))

  const stat = { split: 0, moved: 0, subst: 0, attached: 0, lineSubst: 0, lineArcsShared: 0, linesDropped: 0, skipped: [] }
  const log = (s) => console.log('  ' + s)

  // 把弧 x 在第 i 段的参数 t 处（或顶点 i 处，t=0）拆成两段；返回新节点坐标。所有引用 x 的几何改写为 [x, n]。
  function splitArc(x, i, q) {
    const A = arcs[x]
    // 落在既有顶点上 → 就在顶点处拆（不造新坐标）
    let cut = -1
    if (hyp(q, A[i]) <= nodeEps) cut = i
    else if (i + 1 < A.length && hyp(q, A[i + 1]) <= nodeEps) cut = i + 1
    if (cut === 0 || cut === A.length - 1) return cut === 0 ? A[0] : A[A.length - 1]   // 已是端点
    let first, second
    if (cut >= 0) { first = A.slice(0, cut + 1); second = A.slice(cut) }
    else { first = [...A.slice(0, i + 1), q]; second = [q, ...A.slice(i + 1)] }
    // 预判：新点 q 插进引用 x 的各个环之后，会不会与环上别的顶点落进同一个量化格（写盘之后就是重复顶点、8 字形）——
    // 北塞浦路斯 / 顿巴斯那几处边界来回折，投影点正好落回环上另一处顶点旁边。会的话这条弧不拆，吸附失败。
    if (cut < 0) {
      for (const g of units) {
        const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs
        for (const poly of polys) for (const ring of poly) {
          if (!ring.some((e) => e === x || e === ~x)) continue
          const before = pathPoly(ring)
          const after = []
          const split = [...first, ...second.slice(1)]
          for (const e of ring) { const seg = e === x ? split : e === ~x ? [...split].reverse() : (e < 0 ? [...arcs[~e]].reverse() : arcs[e]); for (let k = after.length ? 1 : 0; k < seg.length; k++) after.push(seg[k]) }
          if (degenerate(after) && !degenerate(before)) return null
        }
      }
    }
    delNode(x)
    const n = arcs.length
    arcs[x] = first; arcs.push(second)
    orig[x] = first.map((p) => [p[0], p[1]]); orig[n] = second.map((p) => [p[0], p[1]])
    T.arcs.push(null)                                // 占位，最后统一重编码
    if (T.adj[x]) T.adj[n] = [...T.adj[x]]
    if (T.lineCls && T.lineCls[x]) T.lineCls[n] = T.lineCls[x]
    if (useU.has(x)) useU.set(n, new Set(useU.get(x)))
    if (useL.has(x)) useL.set(n, new Set(useL.get(x)))
    for (const g of geoms) walkArcs(g, (list) => { const out = []; for (const e of list) { if (e === x) out.push(x, n); else if (e === ~x) out.push(~n, ~x); else out.push(e) } return out })
    addNode(x); addNode(n); indexArc(x); indexArc(n)
    stat.split++
    onSplit(x, n)
    return second[0]
  }
  // 被拆的弧若是某个叠加面的独占弧（待贴合的候选），后半段也要排进候选，否则它就留成一截偏离的孤线
  let onSplit = () => {}
  // 把节点 p（坐标键）挪到 q：所有以 p 为端点的弧一并改端点。
  // ★ 挪动记进 moveLog：吸附端点发生在「这条弧最终贴不贴」定下来之前，候选被否决时必须原样撤回 ——
  //   薄块地（多瑙河沿岸的两块）两条弧共端点，端点挪到了边界上、弧却没换成边界，环就被拧翻面了。
  //   拆弧不用撤：只是在既有弧上多了一个节点，几何一点没动。
  let moveLog = null
  function moveNode(p, q) {
    const k = key(p)
    if (k === key(q)) return
    const s = nodes.get(k); if (!s) return
    for (const a of [...s]) {
      delNode(a)
      const A = arcs[a]
      if (key(A[0]) === k) { if (moveLog) moveLog.push({ a, end: 0, from: A[0] }); A[0] = [q[0], q[1]] }
      if (key(A[A.length - 1]) === k) { if (moveLog) moveLog.push({ a, end: 1, from: A[A.length - 1] }); A[A.length - 1] = [q[0], q[1]] }
      addNode(a); indexArc(a)
    }
    stat.moved++
  }
  function undoMoves(logList) {
    for (let i = logList.length - 1; i >= 0; i--) {
      const { a, end, from } = logList[i]
      if (!arcs[a].length) continue
      delNode(a)
      const A = arcs[a]
      if (end === 0) A[0] = from; else A[A.length - 1] = from
      addNode(a); indexArc(a)
    }
    logList.length = 0
  }
  // 端点 p 吸附到目标弧网（netOk(a) 为真的弧）：返回节点坐标或 null
  function attach(p, netOk, tolerance) {
    if (nodes.has(key(p))) { for (const a of nodes.get(key(p))) if (netOk(a)) return p }   // 已是弧网节点
    let best = null
    for (const a of nearArcs([p[0] - tolerance, p[1] - tolerance, p[0] + tolerance, p[1] + tolerance])) {
      if (!netOk(a)) continue
      const A = arcs[a]
      for (let i = 1; i < A.length; i++) { const r = segNearest(p, A[i - 1], A[i]); if (r.d <= tolerance && (!best || r.d < best.d)) best = { a, i: i - 1, q: r.q, d: r.d } }
    }
    if (!best) return null
    // 投影点离弧网既有节点很近 → 直接用那个节点
    for (const a of nearArcs([best.q[0] - nodeEps, best.q[1] - nodeEps, best.q[0] + nodeEps, best.q[1] + nodeEps])) {
      if (!netOk(a)) continue
      const A = arcs[a]
      for (const e of [A[0], A[A.length - 1]]) if (hyp(e, best.q) <= nodeEps) { moveNode(p, e); return e }
    }
    const q = splitArc(best.a, best.i, best.q)
    if (!q) return null                               // 拆了会让环退化，这个端点接不上
    moveNode(p, q)
    return q
  }
  // 弧网上 q0→q1 的最短路（只走 netOk 且落在 ref 折线 2×tolerance 邻域内的弧；离 ref 越远权重越大、
  // 基础单元的弧权重更低）；像不像由调用方再按 Hausdorff 判。返回带正负向的弧序列或 null
  function shortestPath(q0, q1, ref, netOk, tolerance, exclude) {
    const b = bboxOf(ref)
    const cand = new Map()
    for (const a of nearArcs([b[0] - 2 * tolerance, b[1] - 2 * tolerance, b[2] + 2 * tolerance, b[3] + 2 * tolerance])) {
      if (!netOk(a) || (exclude && exclude.has(a))) continue
      const A = arcs[a]
      let far = 0
      for (const p of A) { const d = distToPoly(p, ref); if (d > far) far = d; if (far > 2 * tolerance) break }
      if (far <= 2 * tolerance) cand.set(a, far)
    }
    const adjn = new Map()
    for (const [a, far] of cand) {
      const A = arcs[a], k0 = key(A[0]), k1 = key(A[A.length - 1])
      const w = polyLen(A) * (usedByBase(a) ? 0.8 : 1) * (1 + 4 * far / tolerance)
      if (!adjn.has(k0)) adjn.set(k0, []); if (!adjn.has(k1)) adjn.set(k1, [])
      adjn.get(k0).push({ to: k1, a, w }); adjn.get(k1).push({ to: k0, a: ~a, w })
    }
    const s = key(q0), t = key(q1)
    if (!adjn.has(s) || !adjn.has(t)) return null
    const dist = new Map([[s, 0]]), prev = new Map(), done = new Set()
    while (true) {
      let u = null, du = Infinity
      for (const [k, d] of dist) if (!done.has(k) && d < du) { du = d; u = k }
      if (u === null) return null
      if (u === t) break
      done.add(u)
      for (const e of adjn.get(u) || []) { const nd = du + e.w; if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { from: u, a: e.a }) } }
    }
    const out = []
    for (let k = t; k !== s;) { const p = prev.get(k); out.unshift(p.a); k = p.from }
    return out
  }
  const pathPoly = (seq) => { const out = []; for (const e of seq) { const A = e < 0 ? [...arcs[~e]].reverse() : arcs[e]; for (let k = out.length ? 1 : 0; k < A.length; k++) out.push(A[k]) } return out }
  // 环的退化：重复顶点（闭合点除外）或线段自交。多瑙河沿岸那块 0.06° 的小地（NE-B95）就是这么坏的 ——
  // 端点吸到的边界顶点恰好也是它自己外侧边中间的一个顶点，环从中间穿过自己成了 8 字。
  function degenerate(xy) {
    // 重复顶点按【量化格】判：两个点相距不到一格，写盘量化后就是同一个点；相邻两点落同一格是零长线段（压实时去掉），不算
    const seen = new Set()
    for (let i = 0; i < xy.length - 1; i++) {
      const k = qkey(xy[i])
      if (i > 0 && k === qkey(xy[i - 1])) continue
      if (seen.has(k)) return '重复顶点 ' + key(xy[i]); seen.add(k)
    }
    if (xy.length > 3000) return false
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    const n = xy.length - 1
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      const a = xy[i], b = xy[i + 1], c = xy[j], d = xy[j + 1]
      if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) || Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) continue
      const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b)
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return `自交 段${i}(${key(a)}→${key(b)}) × 段${j}(${key(c)}→${key(d)})`
    }
    return false
  }
  // 引用弧 x 的各个环在「把 x 换成 seq」（seq=null 即现状）之后的状态：
  //   flip —— 球面绕向（面积 >2π；外环变成「整个球减去这块」，投影出来整幅图涂满 / 剪裁边框被描出来，
  //           mapProjection.test 的 ⑨ 抓的就是它）；洞环本来就是反向，所以后面比的是「有没有变」不是「是不是 >2π」
  //   bad  —— 退化（见 degenerate）
  function ringStates(x, seq) {
    const rev = seq ? [...seq].reverse().map((e) => ~e) : null
    const out = []
    for (const g of units) {
      const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs
      for (const poly of polys) for (const ring of poly) {
        if (!ring.some((e) => e === x || e === ~x)) continue
        let list = ring
        if (seq) { list = []; for (const e of ring) { if (e === x) list.push(...seq); else if (e === ~x) list.push(...rev); else list.push(e) } }
        const xy = list.length ? pathPoly(list) : []
        const why = xy.length < 4 ? '环太短' : degenerate(xy)
        out.push({ flip: xy.length > 3 && geoArea({ type: 'Polygon', coordinates: [xy] }) > 2 * Math.PI, bad: !!why, why })
      }
    }
    return out
  }
  // 贴合前（吸附端点之前）与贴合后对比：绕向变了、或原本好好的环退化了 → 这条不能贴。返回原因串或 null
  const breaks = (pre, post) => {
    if (pre.length !== post.length) return '环数变了'
    for (let i = 0; i < post.length; i++) {
      if (post[i].flip !== pre[i].flip) return '环翻面（路径绕到了另一侧）'
      if (post[i].bad && !pre[i].bad) return '环退化（' + post[i].why + '）'
    }
    return null
  }
  // 用弧序列 seq（正向 = 原弧方向）顶替所有几何里的弧 x
  function substitute(x, seq) {
    const rev = [...seq].reverse().map((e) => ~e)
    for (const g of geoms) walkArcs(g, (list) => { const out = []; for (const e of list) { if (e === x) out.push(...seq); else if (e === ~x) out.push(...rev); else out.push(e) } return out })
    for (const e of seq) { const a = e < 0 ? ~e : e; if (useU.has(x)) for (const u of useU.get(x)) addUse(useU, a, u); if (useL.has(x)) for (const i of useL.get(x)) addUse(useL, a, i) }
    if (T.lineCls && T.lineCls[x]) for (const e of seq) { const a = e < 0 ? ~e : e; if ((RANK[T.lineCls[x]] || 0) > (RANK[T.lineCls[a]] || 0)) T.lineCls[a] = T.lineCls[x] }
    useU.delete(x); useL.delete(x); delete T.adj[x]; if (T.lineCls) delete T.lineCls[x]
    delNode(x); arcs[x] = []
  }
  // 构建脚本同一口径的 adj（争议单元顶替宿主那一侧）。
  // ★ 宿主要追到【基础单元】：阿扎德克什米尔的宿主是吉尔吉特（也是叠加面），再往上才是巴基斯坦 ——
  //   按直接宿主排除会把 PAK 留在候选里、把印度那一侧写成巴基斯坦（控制线两侧都成了巴方）。
  const hostBase = (u) => { let c = u; for (let i = 0; i < 8; i++) { const p = props.get(c); if (!p || !p.host) return null; if (isBase(p.host)) return p.host; c = p.host } return null }
  function adjOf(a) {
    const b = [], d = []
    for (const u of useU.get(a) || []) (isBase(u) ? b : d).push(u)
    if (d.length >= 2) return [d[0], d[1]]
    if (d.length === 1) { const D = d[0], h = hostBase(D); const other = b.filter((x) => x !== h); return other.length ? [D, other[0]] : [D, b.length ? null : (props.get(D).host || null)] }
    return [b[0] ?? null, b.length > 1 ? b[1] : null]
  }

  // ---------- A+B：叠加面的弧（没有任何基础单元引用的那些：独占的，或只在几个叠加面之间共享的）----------
  // 候选按「顶点到弧网的平均距离」排序，不按最大距离：两条弧合成一个薄环（克罗地亚 / 塞尔维亚多瑙河沿岸
  // 的小块地）时，两条弧的最大距离都出在公共端点上、一样大，分不出哪条是贴着边界的外侧边 ——
  // 平均距离才分得出（外侧边的中间顶点都在边界上，内侧边的中间顶点隔着整块地的宽度）。
  // 内侧边先被贴上去的话，整块地会翻到边界另一侧去。
  const work = []
  for (const [a, s] of useU) {
    if (!arcs[a].length || useL.has(a) || usedByBase(a)) continue
    const A = arcs[a]
    if (A.length < 2 || key(A[0]) === key(A[A.length - 1])) continue          // 闭环（岛礁 / 湖）不碰
    const netOk = (x) => { const t = useU.get(x); if (!t || !arcs[x].length) return false; for (const u of t) if (!s.has(u)) return true; return false }
    let off = 0, sum = 0
    const near = nearArcs(((b) => [b[0] - tol, b[1] - tol, b[2] + tol, b[3] + tol])(bboxOf(A)))
    for (const q of A) { let m = Infinity; for (const x of near) if (netOk(x)) { const d = distToPoly(q, arcs[x]); if (d < m) m = d }; off = Math.max(off, m); sum += m; if (off > tol) break }
    if (off <= tol) work.push({ Ds: [...s], a, off, avg: sum / A.length })
  }
  work.sort((x, y) => x.avg - y.avg)
  const inWork = new Set(work.map((w) => w.a))
  onSplit = (x, n) => { const w = work.find((it) => it.a === x); if (w && !inWork.has(n)) { inWork.add(n); work.push({ Ds: w.Ds, a: n, off: w.off, avg: w.avg }) } }
  log('叠加面候选弧 ' + work.length + ' 条（无基础单元引用、整条落在别的单元弧 ' + tol + '° 邻域内）')
  for (const w of work) {                         // ★ for-of 会带上循环中 push 进来的后半段
    const { a } = w
    if (!arcs[a].length || !useU.has(a) || usedByBase(a)) continue         // 已被处理 / 已与基础单元共享
    const s = useU.get(a), D = [...s].join('+')
    const netOk = (x) => { const t = useU.get(x); if (!t || !arcs[x].length) return false; for (const u of t) if (!s.has(u)) return true; return false }
    const A = arcs[a]
    const ref = orig[a]
    const pre = ringStates(a, null)               // ★ 吸附端点之前的环状态
    moveLog = []
    // 否决时的退路：弧本身不换，但端点若已经接到了弧网上、且光这一步没把环弄坏，就保留这个接法 ——
    // 松脱的线头变成 T 形接头（中不争议区东段那个鼓包：50m 的国界从它南缘穿过，鼓包贴不上去，
    // 但至少两头接在国界上，屏上不再有悬空的线头）。接法本身弄坏了环才全部撤回。
    const bail = (msg) => {
      const whyKeep = moveLog.length ? breaks(pre, ringStates(a, null)) : '端点没动'
      if (!whyKeep) { stat.skipped.push(D + ' arc#' + a + ' ' + msg + '；端点已接上弧网、弧保留'); stat.attached++ }
      else { stat.skipped.push(D + ' arc#' + a + ' ' + msg + '；端点撤回（' + whyKeep + '）'); undoMoves(moveLog) }
    }
    const q0 = attach(A[0], netOk, tol), q1 = q0 && attach(arcs[a][arcs[a].length - 1], netOk, tol)
    if (!q0 || !q1) { bail('端点吸附不上'); continue }
    if (key(q0) === key(q1)) {
      // 两端投到弧网的同一点：这截弧只是贴着边界的一个小折返，前后两条弧在该节点已经相接 → 直接摘掉
      const why0 = breaks(pre, ringStates(a, []))
      if (why0) { bail('摘掉会让' + why0); continue }
      substitute(a, [])
      stat.subst++
      log(`摘除 ${D.padEnd(13)} arc#${String(a).padEnd(5)} 偏离 ${w.off.toFixed(4)}° 两端吸到同一节点 ${key(q0)}`)
      continue
    }
    // 这几个叠加面已经引用的弧不许进路径（否则环会折返退化）—— 作为图约束而不是事后否决：
    // 哈拉伊卜的海岸弧本来能贴到埃及海岸上，事后否决会因为最短路先走了南边界（已引用）而把它整个放弃。
    // 也正是它守住了「每个叠加面至少留一条内侧边」：内侧边两端之间避开外侧边就只剩绕宿主一整圈的路，长度过不了关。
    const mine = new Set()
    for (const g of units) if (s.has(g.properties.u)) arcIdxSet(g, mine)
    mine.delete(a)
    const seq = shortestPath(q0, q1, ref, netOk, tol, mine)
    if (!seq) { bail('弧网上无路（避开本面已引用的弧）'); continue }
    const P = pathPoly(seq)
    const h = Math.max(hausdorff(P, ref), hausdorff(ref, P))
    const L0 = polyLen(ref), L1 = polyLen(P)
    // 路径的双向 Hausdorff 放宽到 1.25×TOL：候选筛选用的是「弧到弧网」的单向距离，边界在两端之间
    // 往外拐一点时反向那一侧会略大（中不争议区东段 0.20° vs 候选偏离 0.17°）
    if (h > 1.25 * tol || L1 > 1.6 * L0 + 2 * tol) { bail(`路径不像（Hausdorff ${h.toFixed(3)}° 长度 ${L0.toFixed(2)}→${L1.toFixed(2)}）`); continue }
    const why = breaks(pre, ringStates(a, seq))
    if (why) { bail('贴上去会' + why); continue }
    moveLog = null
    substitute(a, seq)
    for (const e of seq) T.adj[e < 0 ? ~e : e] = adjOf(e < 0 ? ~e : e)
    stat.subst++
    log(`贴合 ${D.padEnd(13)} arc#${String(a).padEnd(5)} 偏离 ${w.off.toFixed(4)}° → ${seq.length} 段弧 [${seq.map((e) => (e < 0 ? '~' : '') + (e < 0 ? ~e : e)).join(' ')}] Hausdorff ${h.toFixed(4)}° adj→${JSON.stringify(seq.map((e) => T.adj[e < 0 ? ~e : e]))}`)
  }

  // ---------- C：自带线只被线引用的弧 ----------
  const netAny = (x) => useU.has(x) && arcs[x].length > 0
  lines.forEach((g, li) => {
    const cls = g.properties.cls
    if (!(cls in RANK)) return                                     // 主张线不贴
    for (const a of [...arcIdxSet(g)]) {
      if (useU.has(a) || !arcs[a].length) continue
      const A = arcs[a]
      if (A.length < 2 || key(A[0]) === key(A[A.length - 1])) continue
      const ref = orig[a]
      let off = 0
      const near = nearArcs(((b) => [b[0] - tolLine, b[1] - tolLine, b[2] + tolLine, b[3] + tolLine])(bboxOf(A)))
      for (const q of A) { let m = Infinity; for (const x of near) if (netAny(x)) { const d = distToPoly(q, arcs[x]); if (d < m) m = d }; off = Math.max(off, m); if (off > tolLine) break }
      if (off > tolLine) continue
      moveLog = []
      const bail = (msg) => { stat.skipped.push(`line#${li} arc#${a} ${msg}`); undoMoves(moveLog) }
      const q0 = attach(A[0], netAny, tolLine), q1 = q0 && attach(arcs[a][arcs[a].length - 1], netAny, tolLine)
      if (!q0 || !q1 || key(q0) === key(q1)) { bail('端点吸附不上'); continue }
      const seq = shortestPath(q0, q1, ref, netAny, tolLine, null)
      if (!seq) { bail('弧网上无路'); continue }
      const P = pathPoly(seq)
      const h = Math.max(hausdorff(P, ref), hausdorff(ref, P))
      const L0 = polyLen(ref), L1 = polyLen(P)
      if (h > 1.25 * tolLine || L1 > 1.6 * L0 + 2 * tolLine) { bail(`路径不像（Hausdorff ${h.toFixed(3)}°）`); continue }
      moveLog = null
      substitute(a, seq)
      stat.lineSubst++
      log(`自带线 ${cls} line#${li} arc#${a} 偏离 ${off.toFixed(4)}° → ${seq.length} 段弧 [${seq.map((e) => (e < 0 ? '~' : '') + (e < 0 ? ~e : e)).join(' ')}] Hausdorff ${h.toFixed(4)}°`)
    }
  })
  // 与单元弧精确共享的线段 → lineCls 标注并从线里摘掉（构建脚本第一路去重同一口径）
  const keptLines = []
  lines.forEach((g, li) => {
    const cls = g.properties.cls
    const lists = g.type === 'MultiLineString' ? g.arcs : [g.arcs]
    const runs = []
    for (const list of lists) {
      let cur = []
      for (const e of list) {
        const a = e < 0 ? ~e : e
        if (useU.has(a) && (cls in RANK)) {
          stat.lineArcsShared++
          if ((RANK[cls] || 0) > (RANK[T.lineCls[a]] || 0)) T.lineCls[a] = cls
          if (cur.length) runs.push(cur); cur = []
        } else cur.push(e)
      }
      if (cur.length) runs.push(cur)
    }
    if (!runs.length) { stat.linesDropped++; log(`自带线 line#${li} ${JSON.stringify(g.properties)} 已整条并入派生弧，删除`); return }
    g.type = runs.length === 1 ? 'LineString' : 'MultiLineString'
    g.arcs = runs.length === 1 ? runs[0] : runs
    keptLines.push(g)
  })
  T.objects.lines.geometries = keptLines

  // ---------- E：被叠加面整个盖住的基础弧，adj 里宿主那一侧换成叠加面 ----------
  // 中不争议区东段的鼓包：50m 的国界从鼓包里穿过（NE 两份数据打架，鼓包外侧边贴不上去，见 B 的否决理由），
  // 那截国界两头都接在鼓包的节点上、大半段落在鼓包里面。它的 adj 是 [CHN, BTN]，中国视角下就多画出一截
  // 穿过鼓包的线、一端悬空。按面的覆盖关系看，它南边那一侧其实是鼓包（叠加面）而不是宿主 ——
  // 改成 [CHN, BT-CN-NW]：中国视角两侧同属溶解，中立视角照旧是 BTN|CHN 国界。
  // 判据要严：基础弧（没有争议单元引用）、两端都是某个叠加面 D 环上的节点、adj 里含 D 的基础宿主、
  // 顶点多数落在 D 的面内。
  let covered = 0
  {
    const inRing = (xy, x, y) => { let inside = false; for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) { const yi = xy[i][1], yj = xy[j][1]; if ((yi > y) === (yj > y)) continue; if (xy[i][0] + (y - yi) / (yj - yi) * (xy[j][0] - xy[i][0]) > x) inside = !inside } return inside }
    for (const g of units) {
      const p = g.properties
      if (!p.dispute) continue
      const hb = hostBase(p.u)
      if (!hb) continue
      const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs
      for (const poly of polys) {
        const outer = pathPoly(poly[0])
        const nodesD = new Set()
        for (const e of poly[0]) { const A = arcs[e < 0 ? ~e : e]; nodesD.add(key(A[0])); nodesD.add(key(A[A.length - 1])) }
        for (const k in T.adj) {
          const pr = T.adj[k]
          if (!pr.includes(hb) || pr.includes(p.u) || !arcs[+k].length) continue
          if ((useU.get(+k) || new Set()).size && [...useU.get(+k)].some((u) => !isBase(u))) continue   // 已有争议单元引用的不碰
          const A = arcs[+k]
          if (!nodesD.has(key(A[0])) || !nodesD.has(key(A[A.length - 1]))) continue
          // 按长度沿弧每 0.005° 采样，算落在面内的长度占比（顶点数太少、分布又不均，按顶点数判会漂）。
          // 门限 0.3：这类弦的另一段往往贴着叠加面的内侧边走（里外摇摆），要的是「有相当一段确实在面里」。
          let inside = 0, total = 0
          for (let i = 1; i < A.length; i++) {
            const seg = Math.hypot(A[i][0] - A[i - 1][0], A[i][1] - A[i - 1][1]), n = Math.max(1, Math.ceil(seg / 0.005))
            for (let s = 0; s < n; s++) { const t = (s + 0.5) / n; const x = A[i - 1][0] + t * (A[i][0] - A[i - 1][0]), y = A[i - 1][1] + t * (A[i][1] - A[i - 1][1]); total += seg / n; if (inRing(outer, x, y)) inside += seg / n }
          }
          if (!(total > 0) || inside / total < 0.3) continue
          const side = pr.indexOf(hb)
          const np = [...pr]; np[side] = p.u
          T.adj[k] = np
          covered++
          log(`盖住 arc#${k} ${JSON.stringify(pr)} → ${JSON.stringify(np)}（${(100 * inside / total).toFixed(0)}% 的长度在 ${p.u} 面内，两端都在其环上）`)
        }
      }
    }
  }

  // ---------- D：同一对单元之间的边界，线型分类补齐 ----------
  // 麦克马洪线在 10m 里整条是 indefinite（NE 的自带线覆盖全程），50m 的自带线却在中间断了一段（NE 数据本身的缺口），
  // 那一段派生出来是 admin0 —— 中立视角下一条虚线中间夹一截实线。按「同一对单元之间」看：某一类线型占了这对边界
  // 一半以上的长度，剩下没分类的段落就补成同一类（只补、不改已有分类；只看至少一侧是争议单元的边界）。
  let filled = 0
  const byPair = new Map()
  for (const k in T.adj) {
    const pr = T.adj[k]
    if (!pr[0] || !pr[1] || !arcs[+k].length) continue
    if (!(props.get(pr[0]) || {}).dispute && !(props.get(pr[1]) || {}).dispute) continue
    const pk = [pr[0], pr[1]].sort().join('|')
    let g = byPair.get(pk); if (!g) byPair.set(pk, g = { arcs: [], len: 0, cls: {} })
    const L = polyLen(arcs[+k]); g.arcs.push(+k); g.len += L
    const c = T.lineCls[k]; if (c) g.cls[c] = (g.cls[c] || 0) + L
  }
  for (const [pk, g] of byPair) {
    const top = Object.entries(g.cls).sort((x, y) => y[1] - x[1])[0]
    if (!top || top[1] < 0.5 * g.len) continue
    const miss = g.arcs.filter((k) => !T.lineCls[k])
    if (!miss.length) continue
    for (const k of miss) T.lineCls[k] = top[0]
    filled += miss.length
    log(`线型补齐 ${pk.padEnd(20)} ${top[0]} 占 ${(100 * top[1] / g.len).toFixed(0)}% → 补 ${miss.length} 段（${miss.map((k) => '#' + k).join(' ')}）`)
  }

  // ---------- 压实：清掉无人引用的弧，重编码 ----------
  const used = new Set()
  for (const g of [...units, ...keptLines]) arcIdxSet(g, used)
  // ★ 量化之后相邻两点可能落进同一格（拆弧的投影点离既有顶点 < 一格 0.0036°）→ 零长线段，去掉；
  //   整条弧缩成一个点的（投影点离既有节点 < 一格）就是零长弧 —— 从所有几何里摘掉（两端本就是同一点，环仍连续）。
  //   否则环上就多出「重复顶点」，basemapConflation.test 的 ⑤b 会把它当成 8 字形环。
  const dedupe = (enc) => { const out = [enc[0]]; for (let i = 1; i < enc.length; i++) if (enc[i][0] || enc[i][1]) out.push(enc[i]); return out }
  const encoded = new Map(), collapsed = new Set()
  for (let i = 0; i < arcs.length; i++) if (used.has(i) && arcs[i].length) { const enc = dedupe(encodeArc(arcs[i], T.transform)); if (enc.length < 2) collapsed.add(i); else encoded.set(i, enc) }
  if (collapsed.size) {
    for (const g of [...units, ...keptLines]) walkArcs(g, (list) => list.filter((e) => !collapsed.has(e < 0 ? ~e : e)))
    for (const g of units) { if (g.type === 'Polygon') g.arcs = g.arcs.filter((r) => r.length); else g.arcs = g.arcs.map((poly) => poly.filter((r) => r.length)).filter((poly) => poly.length) }
    for (const g of keptLines) if (g.type === 'MultiLineString') g.arcs = g.arcs.filter((r) => r.length)
    for (const a of collapsed) { delete T.adj[a]; if (T.lineCls) delete T.lineCls[a] }
    log(`零长弧 ${collapsed.size} 条已摘除（量化后缩成一个点）`)
  }
  T.objects.lines.geometries = keptLines.filter((g) => g.arcs.length)
  const map = new Map()
  const arcs2 = []
  for (const [i, enc] of encoded) { map.set(i, arcs2.length); arcs2.push(enc) }
  for (const g of [...units, ...T.objects.lines.geometries]) walkArcs(g, (list) => list.map((e) => (e < 0 ? ~map.get(~e) : map.get(e))))
  const adj2 = {}, cls2 = {}
  for (const k in T.adj) if (map.has(+k)) adj2[map.get(+k)] = T.adj[k]
  for (const k in T.lineCls || {}) if (map.has(+k)) cls2[map.get(+k)] = T.lineCls[k]
  const orphan = arcs.length - arcs2.length
  T.arcs = arcs2; T.adj = adj2; T.lineCls = cls2
  T.meta.conflated = { tol, tolLine, subst: stat.subst, attached: stat.attached, split: stat.split, moved: stat.moved, lineSubst: stat.lineSubst, linesDropped: stat.linesDropped, lineClsFilled: filled, note: '见 scripts/conflate-basemap.mjs：叠加面 / 自带线里几乎与既有边界重合的段落已改为共享弧' }

  log(`合计：叠加面贴合 ${stat.subst} 条 · 只接端点 ${stat.attached} 条 · 拆弧 ${stat.split} 次 · 挪节点 ${stat.moved} 个 · 自带线贴合 ${stat.lineSubst} 条 · 线段转 lineCls ${stat.lineArcsShared} 段 · 删线 ${stat.linesDropped} 条 · 线型补齐 ${filled} 段 · 清孤弧 ${orphan} 条 → arcs ${arcs2.length}`)
  if (stat.skipped.length) { log('未贴合 ' + stat.skipped.length + ' 条：'); for (const s of stat.skipped) log('   · ' + s) }
  if (DRY) { log('--dry：不写文件'); return }
  const before = fs.statSync(f).size
  fs.writeFileSync(f, JSON.stringify(T))
  log(`写出 ${path.relative(ROOT, f)}：${(before / 1e6).toFixed(2)} → ${(fs.statSync(f).size / 1e6).toFixed(2)} MB`)
}

const want = process.argv.slice(2).filter((a) => /^(50m|110m)$/.test(a))
for (const s of (want.length ? want : ['50m'])) conflate(s)
