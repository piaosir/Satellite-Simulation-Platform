// 聚焦星几何的两个缓存：轨道圈（惯性系里那条闭合曲线）与星下点轨迹（环形缓冲）。
//
// 逐拍把这两样重推一遍是「聚焦一整个星座」的主要开销（3000 颗 × 24 采样点 ≈ 150 ms/拍 的 SGP4）。
// 而它们各自都有一条不必逐拍重算的性质：
//
//  · 轨道圈画的是【惯性系】里那条闭合椭圆，逐拍变的只是地球转角。把 ECI 环按某个参考 gmst 换算成
//    经纬高存下来，之后每拍只给整组线设一次「绕极轴 −ΔGMST」的旋转即可 —— 逐顶点计算归零。
//    ★ 这是精确变换不是近似：绕极轴旋转下大地纬度与大地高严格不变，变的只有经度、且是刚性的
//      −ΔGMST；渲染端 llaToVec 又恰好把经度映成绕 Y 轴（极轴）的转角。两头对得上，故整组转即可。
//    残差只来自 ECI 环自身随时间的漂移（J2 升交点进动为主），按 RING_TTL_MS 定期重建吸收（见下）。
//
//  · 星下点算过一次就【钉在地球上不动了】。时间窗从 [t, t+T] 滑到 [t+Δ, t+T+Δ]，只是前端丢几个点、
//    后端补几个点 —— 1 s 步长对 95 min 周期，每拍平均补不到 0.005 个采样点。
//    ★ 窗口两端取【精确时刻】的点，不量化到网格：头点＝当前星下点（调用方本就要算，白送），
//      尾点每拍一次 SGP4。否则尾巴会「不动一阵、猛跳一段」，窗长在一个节拍内来回抖。
//
// 本模块纯计算、不碰 DOM，可原样搬进 Worker（每个 Worker 各持一份缓存，卫星按索引固定分片，
// 同一颗星恒落在同一个 Worker 上，缓存才立得住）。
import sat from './satellite.js'
import { propAt, refineInto, sampleOrbitAdaptive } from './adaptiveSample.js'

// 轨道圈缓存的有效期。定它的不是「误差随时间累积到多大」，而是【重建那一瞬会换掉多长一段环】：
//
// 轨道圈画的是一个周期的轨迹，而一个周期里升交点已经进动了零点几度 —— 它压根不是闭合曲线，首尾之间
// 恒有一道「一个周期的进动位移」那么宽的收口缝（Starlink 约 28 km、GEO 约 0.1 km）。不缓存时这道缝
// 每拍连续地绕环滑动；缓存后它每 TTL 挪一次，挪动量 = TTL/周期 那么长的一段环。
// ★ 卫星本体永远落在环上（采样窗 [T_ref, T_ref+周期] 恒包住当前时刻），这一条与 TTL 无关，恒成立。
// 所以判据取「被换掉的环长 ≤ 5% 周期」，另设 30 min 绝对上限管住 GEO 这类长周期轨道。
// 实测（.focusharness/cache.mjs）：整组旋转与逐点重算逐点相同（0.000 mm），本体离环 0 m。
const RING_TTL_FRAC = 0.05
const RING_TTL_CAP_MS = 30 * 60 * 1000
export const ringTtlMs = (periodMs) => Math.min(RING_TTL_CAP_MS, Math.max(1000, periodMs * RING_TTL_FRAC))

// 轨道圈的分段数由【弦垂】定，不再按颗数摊薄 —— 缓存之后逐拍成本为零，只有重建那一拍按段数走，
// 于是没有理由再为省逐拍开销把环画成 24 段的粗多边形。
// ★ 顺带治掉缓存引入的一处回归：不缓存时环的采样从当前时刻起步，首个顶点恰好就是「在轨点」，
//   星本体严丝合缝落在环上；缓存后星位落在某条弦的中段，离环最远正是这个弦垂
//   （24 段时 LEO 59 km、GEO 361 km —— 后者在整球视图上是二十来个像素，看得见）。
//   把弦垂压到 1 px 以下，这一项与「环本身画得糙不糙」就一起没了。
// 弦垂 ≈ ρ·(1−cos(π/N)) ≈ ρπ²/(2N²)，ρ = 远地点地心距 / RE（scene 单位，球半径 = 1）。
const SAG_MAX = 0.003            // scene 单位；整球视图约 350 px/单位 → 约 1 px
export function ringSegments(rec, lodSamples) {
  const rho = 1 + (rec.alta > 0 ? rec.alta : 0)                  // rec.alta = 远地点高度（地球半径为单位）
  const need = Math.ceil(Math.PI * Math.sqrt(rho / (2 * SAG_MAX)))
  return Math.max(24, Math.min(240, Math.max(lodSamples > 0 ? lodSamples : 0, need)))
}

export function createFocusGeomCache() {
  const store = new Map()
  const ent = (key) => { let e = store.get(key); if (!e) { e = { ring: null, trk: null }; store.set(key, e) } return e }

  // ---- ① 轨道圈：返回该星在【参考 gmst】下的经纬高环。命中缓存时直接返回上次那份（调用方靠整组旋转对齐当前时刻）。
  // rebuild=true 由调用方按 TTL/选中集/LOD 统一给（全体同一个参考 gmst，才能只用一个四元数）。
  function ring(key, rec, tMs, gmst, N, stepDeg, rebuild) {
    const e = ent(key)
    const c = e.ring
    if (!rebuild && c && c.rec === rec && c.N === N && c.stepDeg === stepDeg) return c.lla
    const periodMin = (2 * Math.PI) / rec.no
    const lla = []
    for (const s of sampleOrbitAdaptive(rec, new Date(tMs), periodMin, N, stepDeg)) {
      const gd = sat.eciToGeodetic(s.pv.position, gmst)
      lla.push({ lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), altKm: gd.height })
    }
    // 轨道本就是闭曲线（惯性系里首尾同一点），补个首点收口
    if (lla.length > 1) lla.push(lla[0])
    e.ring = { rec, N, stepDeg, lla }
    return lla
  }

  // ---- ② 星下点轨迹：环形缓冲。head 是调用方在 tMs 已经算好的当前星下点（{lat,lon}），不再重推一次。
  // 返回 [{lat,lon}...]，首点恒为 head、末点恒为 tMs+spanMs 时刻的精确星下点，中间是固定节拍的网格点。
  function track(key, rec, tMs, spanMs, dtMs, stepDeg, head) {
    if (!(spanMs > 0) || !(dtMs > 0) || !head) return head ? [head] : []
    const e = ent(key)
    let b = e.trk
    const endMs = tMs + spanMs
    const stale = !b || b.rec !== rec || b.dtMs !== dtMs || b.spanMs !== spanMs || b.stepDeg !== stepDeg
      || !b.nodes.length || tMs >= b.nodes[b.nodes.length - 1].tMs || endMs <= b.nodes[0].tMs
    if (stale) b = e.trk = build(rec, tMs, endMs, dtMs, spanMs, stepDeg)
    else slide(b, tMs, endMs)
    return emit(b, tMs, endMs, stepDeg, head)
  }

  // 网格锚在建表时刻上，逐点按【整数序号】定时刻（t0 + i·dt 四舍五入），不靠浮点累加 ——
  // 累加会让节拍慢慢漂，末点还会正好落在窗口右端跟精确尾点撞成重复点。
  const gridT = (b, i) => Math.round(b.t0 + i * b.dtMs)
  // 建一条覆盖开区间 (tMs, endMs) 的节拍网格：两端点由调用侧的精确 head/tail 补，网格只管中间
  function build(rec, tMs, endMs, dtMs, spanMs, stepDeg) {
    const b = { rec, dtMs, spanMs, stepDeg, t0: Math.round(tMs), nodes: [] }
    let prev = null
    for (let i = 1; ; i++) {
      const t = gridT(b, i)
      if (t >= endMs) break
      const s = node(rec, t, i)
      if (!s) continue
      s.pre = prev ? between(rec, prev, s, stepDeg) : []
      b.nodes.push(s); prev = s
    }
    return b
  }
  // 窗口滑动：前端丢过期的、后端补新的（负向播放则反过来）。改动的点数正比于窗口真移动了多少。
  function slide(b, tMs, endMs) {
    const nd = b.nodes
    while (nd.length && nd[0].tMs <= tMs) nd.shift()
    while (nd.length && nd[nd.length - 1].tMs >= endMs) nd.pop()
    if (!nd.length) { const s = seed(b, tMs, endMs); if (!s) return }
    // 负向播放：窗口往回走，往前端补
    for (;;) {
      const i = nd[0].idx - 1, t = gridT(b, i)
      if (t <= tMs) break
      const s = node(b.rec, t, i)
      if (!s) break
      nd[0].pre = between(b.rec, s, nd[0], b.stepDeg)   // 原首点现在有前驱了，补上这一段的细分
      s.pre = []                                        // 它自己的 pre 等再往前补时才算得出（首点的 pre 从不被用到）
      nd.unshift(s)
    }
    // 正向播放：往后端补
    for (;;) {
      const last = nd[nd.length - 1], i = last.idx + 1, t = gridT(b, i)
      if (t >= endMs) break
      const s = node(b.rec, t, i)
      if (!s) break
      s.pre = between(b.rec, last, s, b.stepDeg)
      nd.push(s)
    }
  }
  // 网格被滑空了（窗口移动量正好把点全甩出去）：在窗内重新落一个点当锚，序号仍按原网格算
  function seed(b, tMs, endMs) {
    const i = Math.floor((tMs - b.t0) / b.dtMs) + 1
    const t = gridT(b, i)
    if (t <= tMs || t >= endMs) return null
    const s = node(b.rec, t, i)
    if (!s) return null
    s.pre = []; b.nodes.push(s)
    return s
  }
  // 吐出这一拍要画的点列：head（精确）→ 各网格点（连同它们各自的细分点）→ tail（精确）。
  // 网格点对象【原样复用】、不逐拍新建 —— 调用方只读 lat/lon。
  function emit(b, tMs, endMs, stepDeg, head) {
    const out = [head]
    let prev = head
    for (let i = 0; i < b.nodes.length; i++) {
      const n = b.nodes[i]
      if (n.tMs <= tMs || n.tMs >= endMs) continue
      // 首个入窗的点：它的 pre 是相对上一个网格点算的，这里前驱换成了 head，就地重算一次。
      // （这一段比整节拍还短，跳变只会更小，近圆轨道下恒不触发细分，代价为零。）
      const mid = prev === head ? between(b.rec, head, n, stepDeg) : n.pre
      for (let j = 0; j < mid.length; j++) out.push(mid[j])
      out.push(n); prev = n
    }
    const tail = node(b.rec, endMs, 0)
    if (tail) { const mid = between(b.rec, prev, tail, stepDeg); for (let j = 0; j < mid.length; j++) out.push(mid[j]); out.push(tail) }
    return out
  }
  // 一个网格点：只留星下点经纬与时刻（不留 pv/gd，几千颗星每拍挂着是白占内存）
  function node(rec, tMs, idx) {
    const s = propAt(rec, new Date(tMs))
    return s ? { tMs, idx, t: s.t, lat: s.lat, lon: s.lon } : null
  }

  // (a,b) 之间的细分点（不含两端）：复用 adaptiveSample 的同一套判据与深度上限
  function between(rec, a, b, stepDeg) {
    const tmp = []
    refineInto(rec, a, b, stepDeg > 0 ? stepDeg : 4, tmp)
    tmp.pop()                                    // refineInto 末尾会带上 b 本身，这里只要中间那些
    if (!tmp.length) return tmp
    for (const p of tmp) { p.tMs = p.t.getTime(); p.pv = null; p.gd = null }
    return tmp
  }

  // 选中集变了就把不在里面的条目丢掉（不然聚焦过的星会一直挂在表上）
  function retain(keys) {
    if (store.size <= keys.size) { let all = true; for (const k of store.keys()) if (!keys.has(k)) { all = false; break }; if (all) return }
    for (const k of [...store.keys()]) if (!keys.has(k)) store.delete(k)
  }
  function clear() { store.clear() }
  return { ring, track, retain, clear, get size() { return store.size } }
}
