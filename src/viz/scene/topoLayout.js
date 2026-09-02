// 应用场景仿真 · 拓扑图的自动分层布局（纯逻辑，可单测）。
//
// 拓扑图与地理视图是【同一个场景的两个投影】，共用一份 scene store，不存第二份数据。
// 本模块只做一件事：给每个模块算一个 (x, y)。
//
// ============ 布局模型：纵向分带 × 横向分层 ============
//   纵轴＝物理层带（这是卫星通信拓扑图的通行画法，也是本领域读图的直觉）：
//     band 0 轨道层   —— 卫星、星间链路
//     band 1 临空层   —— 无人机 / eVTOL / 浮空器 / 机载
//     band 2 地面层   —— 地面站 / 车船 / 机器人 / 汇聚设备 / 中心
//     band 3 末端层   —— 传感器 / 表计 / 天线 / 供电（挂在地面层设备下面）
//   横轴＝沿信号流的拓扑序（Sugiyama 式最长路分层）：末端在左、中心在右。
//
// ★ 层与带是从数据【推】出来的（cat + place.mode + 流路径），不是用户排的 ——
//   拓扑关系本来就是图的属性。允许手动微调并持久化（nudge），但不要求用户先排一遍才能看。

// ── 带归属 ──
// 依据：模块类别 + 放置方式。挂载件跟宿主同带（由调用方在 resolve 后传入 hostBand）。
export const BANDS = [
  { key: 'orbit', zh: '轨道层', en: 'Orbit' },
  { key: 'air', zh: '临空层', en: 'Air' },
  { key: 'ground', zh: '地面层', en: 'Ground' },
  { key: 'edge', zh: '末端层', en: 'Field' }
]

const AIR_SYMBOLS = new Set(['drone-multi', 'drone-fixed', 'drone-vtol', 'drone-heli', 'evtol', 'drone-tether', 'balloon'])

export function bandOf(mod) {
  if (!mod) return 2
  if (mod.cat === 'A') return 0
  if (mod.cat === 'H') return 2
  if (mod.cat === 'D' || mod.cat === 'F' || mod.cat === 'G') return 3
  // C 类里会飞的进临空层，其余（车 / 船 / 机器人 / 动中通）留地面层
  if (mod.cat === 'C' && (AIR_SYMBOLS.has(mod.symbol) || (mod.place && mod.place.altM > 1000))) return 1
  return 2
}

/**
 * 分层布局。
 * @param {object} g  { mods: Map<id, resolvedModule>, links: [{id,a:{modId},b:{modId},medium,role}], flows: [{dirs:[{path:[linkId]}]}] }
 * @param {object} opt { colW, rowH, bandGap, nudge: { [modId]: {dx,dy} } }
 * @returns { nodes: [{id, x, y, band, rank, mod}], bands: [{key,zh,y0,y1}], w, h }
 */
export function layout(g, opt) {
  // colW 要给相邻两卡之间留出边标的位置（卡宽 132 + 标签 ~90）
  const o = Object.assign({ colW: 232, rowH: 92, bandGap: 34, padX: 100, padY: 60 }, opt || {})
  const mods = g.mods, links = g.links || []

  // ── ① 邻接（无向）──
  const adj = new Map()
  const push = (a, b, lk) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, lk }) }
  for (const lk of links) {
    const a = lk.a && lk.a.modId, b = lk.b && lk.b.modId
    if (!mods.has(a) || !mods.has(b)) continue
    push(a, b, lk); push(b, a, lk)
  }
  for (const id of mods.keys()) if (!adj.has(id)) adj.set(id, [])

  // ── ② 横向分层：优先按业务流路径定序（那是真正的信号流向）──
  // 把所有流路径上的边定向成「源 → 宿」，在这张 DAG 上做最长路分层。
  const dag = new Map()      // id → Set(下游 id)
  const indeg = new Map()
  const ensure = (id) => { if (!dag.has(id)) { dag.set(id, new Set()); indeg.set(id, 0) } }
  for (const id of mods.keys()) ensure(id)
  const linkById = new Map(links.map((l) => [l.id, l]))
  for (const f of (g.flows || [])) {
    for (const d of (f.dirs || [])) {
      if (!d || !Array.isArray(d.path)) continue
      // 只用 a→b 那一向定序：双向流两向路径相同，取一向即可，取两向会互相成环
      if (d.dir === 'ba') continue
      let cur = d.fromId
      for (const lid of d.path) {
        const lk = linkById.get(lid); if (!lk) break
        const nxt = (lk.a.modId === cur) ? lk.b.modId : lk.a.modId
        ensure(cur); ensure(nxt)
        if (cur !== nxt && !dag.get(cur).has(nxt)) { dag.get(cur).add(nxt); indeg.set(nxt, indeg.get(nxt) + 1) }
        cur = nxt
      }
    }
  }
  // 最长路分层（Kahn 拓扑序 + rank = max(前驱 rank)+1）
  const rank = new Map()
  const q = []
  for (const id of dag.keys()) { rank.set(id, 0); if (indeg.get(id) === 0) q.push(id) }
  const deg = new Map(indeg)
  let guard = 0
  while (q.length && guard++ < 10000) {
    const u = q.shift()
    for (const v of dag.get(u)) {
      rank.set(v, Math.max(rank.get(v), rank.get(u) + 1))
      deg.set(v, deg.get(v) - 1)
      if (deg.get(v) === 0) q.push(v)
    }
  }
  // 没进过任何流路径的模块（传感器挂在汇聚设备上、天线挂在站上…）：取邻居 rank 的众数
  const onPath = new Set()
  for (const [u, vs] of dag) { if (vs.size) { onPath.add(u); for (const v of vs) onPath.add(v) } }
  for (let pass = 0; pass < 4; pass++) {
    for (const id of mods.keys()) {
      if (onPath.has(id)) continue
      const ns = (adj.get(id) || []).map((e) => rank.get(e.to)).filter((r) => r != null)
      if (ns.length) rank.set(id, Math.min(...ns))
    }
  }
  // 中心（H 类）恒在最右：否则一条只连了一跳的中心会被排到中间
  let maxR = 0
  for (const r of rank.values()) maxR = Math.max(maxR, r)
  for (const [id, m] of mods) if (m.cat === 'H') rank.set(id, maxR)

  // ── ③ 带内堆叠 ──
  const cells = new Map()   // `${band}:${rank}` → [id]
  const nodes = []
  // 挂载件跟宿主同带：图传发射机挂在无人机上就该画在临空层，不该掉回地面层
  //（最多追 8 层，与 resolveScene 的防环同口径）
  const bandCache = new Map()
  const bandFor = (id) => {
    if (bandCache.has(id)) return bandCache.get(id)
    let m = mods.get(id), depth = 0
    while (m && m.place && m.place.mode === 'mounted' && m.place.hostId && depth++ < 8) {
      const h = mods.get(m.place.hostId)
      if (!h || h === m) break
      m = h
    }
    const b = bandOf(m)
    bandCache.set(id, b)
    return b
  }
  for (const [id, m] of mods) {
    const band = bandFor(id)
    const r = rank.get(id) || 0
    const key = band + ':' + r
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(id)
  }
  // 带高 = 该带最拥挤的那一格的行数
  const bandRows = [0, 0, 0, 0]
  for (const [key, ids] of cells) {
    const b = +key.split(':')[0]
    bandRows[b] = Math.max(bandRows[b], ids.length)
  }
  const bandY = []
  let y = o.padY
  for (let b = 0; b < 4; b++) {
    const h = Math.max(bandRows[b], bandRows[b] ? 1 : 0) * o.rowH
    bandY.push({ y0: y, h, rows: bandRows[b] })
    y += h ? h + o.bandGap : 0
  }
  const totalH = y + o.padY

  for (const [key, ids] of cells) {
    const [bs, rs] = key.split(':')
    const b = +bs, r = +rs
    // 同格内按名字定序，保证同一份数据每次布局结果一致（布局必须是纯函数）
    ids.sort((p, q2) => String((mods.get(p) || {}).name || p).localeCompare(String((mods.get(q2) || {}).name || q2), 'zh'))
    ids.forEach((id, i) => {
      const nd = (o.nudge || {})[id] || {}
      nodes.push({
        id, band: b, rank: r, mod: mods.get(id),
        x: o.padX + r * o.colW + (nd.dx || 0),
        y: bandY[b].y0 + i * o.rowH + o.rowH / 2 + (nd.dy || 0)
      })
    })
  }
  nodes.sort((a, b) => (a.band - b.band) || (a.rank - b.rank) || String(a.id).localeCompare(String(b.id)))

  const totalW = o.padX * 2 + (maxR + 1) * o.colW
  const bands = BANDS.map((bd, i) => ({ ...bd, y0: bandY[i].y0, y1: bandY[i].y0 + bandY[i].h, rows: bandY[i].rows }))
    .filter((bd) => bd.rows > 0)
  return { nodes, bands, w: totalW, h: totalH, maxRank: maxR, rank }
}

/** 布局结果 → 按 id 取点 */
export const posMap = (lay) => new Map(lay.nodes.map((n) => [n.id, n]))
