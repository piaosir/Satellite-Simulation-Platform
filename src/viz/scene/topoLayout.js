// 应用场景仿真 · 拓扑图的自动分层布局（纯逻辑，可单测）。
//
// 拓扑图与地理视图是【同一个场景的两个投影】，共用一份 scene store，不存第二份数据。
// 本模块只做一件事：给每个模块算一个 (x, y) 与一个卡片尺寸。
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
// 拓扑关系本来就是图的属性。允许手动微调并持久化（nudge），但不要求用户先排一遍才能看。
//
// ============ 二期加的三件 ============
//   ① 站点容器：同一站址、同一层的模块聚成一个复合节点（一期是散成 N 张卡）；
//   ② 带内重心排序：同一格里的节点按邻居平均位置排，把交叉压下去（两遍迭代即收敛）；
//   ③ 列宽 / 行高按【实测文字宽度】算，不再写死 232×92 —— 名字长的模板一期会互相压。

import { iconOf } from './sceneSymbols.js'

// ── 带归属 ──
// 依据：模块类别 + 放置方式。挂载件跟宿主同带（由调用方在 resolve 后传入 hostBand）。
export const BANDS = [
  { key: 'orbit', zh: '轨道层', en: 'Orbit' },
  { key: 'air', zh: '临空层', en: 'Air' },
  { key: 'ground', zh: '地面层', en: 'Ground' },
  { key: 'edge', zh: '末端层', en: 'Field' }
]

// 会飞的：按【解析后的图标】判，不按库条目上的 symbol 字段 —— 后者在二期只剩自建模块的兜底档，
// 内置模块的图标由 sceneSymbolMap 逐条给定（见 sceneSymbols.iconOf）。
const AIR_ICONS = new Set(['tabler:drone', 'tabler:plane', 'tabler:plane-tilt', 'tabler:helicopter', 'tabler:air-balloon'])

export function bandOf(mod) {
  if (!mod) return 2
  if (mod.cat === 'A') return 0
  if (mod.cat === 'H') return 2
  if (mod.cat === 'D' || mod.cat === 'F' || mod.cat === 'G') return 3
  // C 类里会飞的进临空层，其余（车 / 船 / 机器人 / 动中通）留地面层
  if (mod.cat === 'C' && (AIR_ICONS.has(iconOf(mod)) || (mod.place && mod.place.altM > 1000))) return 1
  return 2
}

// ── 卡片尺寸 ──
// 出参带 w/h：路由器要拿它当障碍，渲染器要拿它画卡。两处必须是同一个数。
export const NODE_H = 56
export const NODE_W_MIN = 120
export const NODE_W_MAX = 240
const SYM_W = 30, PAD_X = 14, GAP = 10

/** 缺省的文字测量（没有 canvas 的环境，如单测）：中日韩字按 1 个字宽、西文按 0.55 */
export function fallbackMeasure(text, px) {
  let w = 0
  for (const ch of String(text == null ? '' : text)) w += /[⺀-鿿＀-￯]/.test(ch) ? 1 : 0.55
  return w * px
}

/** 一张卡的宽度：图标 + 名字 / 副标里较宽的那一行 + 内边距，钳在 [120, 240] */
export function cardWidth(name, sub, fontPx, measure) {
  const m = measure || fallbackMeasure
  const w = Math.max(m(name, fontPx), m(sub, fontPx - 2))
  return Math.max(NODE_W_MIN, Math.min(NODE_W_MAX, Math.round(SYM_W + GAP + w + PAD_X * 2)))
}

/**
 * 站点归属：同一站址的模块归一个站。
 *   · 显式 siteId 优先；
 *   · 挂载件跟宿主（多级，最多 8 层，与 resolveScene 的防环同口径）；
 *   · 其余按坐标（保留 4 位小数 ≈ 11 m，同一座站里的设备本来就填同一个坐标）。
 * 没有坐标也没有宿主的（卫星、还没落点的模块）各自成站 —— 不能把所有「没坐标」的并成一堆。
 */
export function siteKeyOf(mods, id) {
  let m = mods.get(id), depth = 0
  while (m && m.place && m.place.mode === 'mounted' && m.place.hostId && depth++ < 8) {
    const h = mods.get(m.place.hostId)
    if (!h || h === m) break
    m = h
  }
  if (!m) return 'i:' + id
  if (m.place && m.place.siteId) return 's:' + m.place.siteId
  const p = m.place || {}
  if (p.lat != null && p.lon != null) return 'g:' + (+p.lat).toFixed(4) + ',' + (+p.lon).toFixed(4)
  return 'i:' + (m.instId || id)
}

/**
 * 分层布局。
 * @param {object} g  { mods: Map<id, resolvedModule>, links: [...], flows: [{dirs:[{path:[linkId]}]}] }
 * @param {object} opt { fontPx, measure, nudge, colGap, rowGap, bandGap, padX, padY, laneW, sites:false }
 * @returns { nodes, sites, bands, w, h, maxRank, rank }
 */
export function layout(g, opt) {
  const o = Object.assign({
    fontPx: 12, colGap: 96, rowGap: 22, bandGap: 30, padX: 24, padY: 46, laneW: 78, sites: true
  }, opt || {})
  const mods = g.mods, links = g.links || []
  const measure = o.measure || fallbackMeasure

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
  const dag = new Map()
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
  // 没进过任何流路径的模块（传感器挂在汇聚设备上、天线挂在站上…）：取邻居 rank 的最小值
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

  // ── ③ 带归属（挂载件跟宿主）──
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

  // ── ④ 分格 + 站点聚合 ──
  // 一格 = (band, rank)。格内按站址再分组：同站同层的多个模块合成一个复合节点，
  // 一期是散成 N 张卡（一座水库的水位 / 雨量 / 渗压三件各占一行，图上完全看不出它们同址）。
  const cells = new Map()
  for (const id of mods.keys()) {
    const key = bandFor(id) + ':' + (rank.get(id) || 0)
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(id)
  }
  const groupsOf = (ids) => {
    if (!o.sites) return ids.map((id) => [id])
    const by = new Map()
    for (const id of ids) {
      const k = siteKeyOf(mods, id)
      if (!by.has(k)) by.set(k, [])
      by.get(k).push(id)
    }
    return [...by.values()]
  }

  // ── ⑤ 卡片尺寸 + 格内堆叠 ──
  const subOf = o.sub || (() => '')
  const sizeOf = new Map()
  for (const [id, m] of mods) {
    sizeOf.set(id, { w: cardWidth(m.name || '', subOf(m), o.fontPx, measure), h: NODE_H })
  }

  // 每格的分组（保持稳定序：先按组内首个模块名，重心排序会在下一步覆盖）
  const cellGroups = new Map()
  for (const [key, ids] of cells) {
    ids.sort((p, q2) => String((mods.get(p) || {}).name || p).localeCompare(String((mods.get(q2) || {}).name || q2), 'zh'))
    cellGroups.set(key, groupsOf(ids))
  }

  // ── ⑥ 带内重心排序（两遍）──
  // 同一格里谁上谁下，取决于它的邻居在相邻列的什么位置 —— 这是压交叉最省事的一招（barycenter）。
  const orderIdx = new Map()   // id → 该格内的序号
  const reindex = () => {
    for (const [, groups] of cellGroups) groups.forEach((grp, i) => grp.forEach((id) => orderIdx.set(id, i)))
  }
  reindex()
  for (let pass = 0; pass < 2; pass++) {
    for (const [key, groups] of cellGroups) {
      if (groups.length < 2) continue
      const bary = new Map()
      for (const grp of groups) {
        let s = 0, n = 0
        for (const id of grp) for (const e of adj.get(id) || []) { const oi = orderIdx.get(e.to); if (oi != null) { s += oi; n++ } }
        bary.set(grp, n ? s / n : orderIdx.get(grp[0]) || 0)
      }
      groups.sort((a, b) => (bary.get(a) - bary.get(b)) ||
        String((mods.get(a[0]) || {}).name || a[0]).localeCompare(String((mods.get(b[0]) || {}).name || b[0]), 'zh'))
      cellGroups.set(key, groups)
    }
    reindex()
  }

  // ── ⑦ 列宽（按该列最宽的卡）与带高（按该带最高的那一格）──
  const colW = []
  for (let r = 0; r <= maxR; r++) colW[r] = NODE_W_MIN
  const cellH = new Map()
  for (const [key, groups] of cellGroups) {
    const r = +key.split(':')[1]
    let h = 0
    for (const grp of groups) {
      let gw = 0, gh = 0
      for (const id of grp) { const s = sizeOf.get(id); gw = Math.max(gw, s.w); gh += s.h }
      if (grp.length > 1) { gw += 16; gh += 14 * (grp.length - 1) + 22 }   // 容器内边距 + 标题
      colW[r] = Math.max(colW[r], gw)
      h += gh + o.rowGap
    }
    cellH.set(key, Math.max(0, h - o.rowGap))
  }
  const bandH = [0, 0, 0, 0]
  for (const [key, ] of cellGroups) {
    const b = +key.split(':')[0]
    bandH[b] = Math.max(bandH[b], cellH.get(key) || 0)
  }

  // ── ⑧ 落点 ──
  const colX = []
  let x = o.padX + o.laneW
  for (let r = 0; r <= maxR; r++) { colX[r] = x + colW[r] / 2; x += colW[r] + o.colGap }
  const totalW = x - o.colGap + o.padX

  const bandY = []
  let y = o.padY
  for (let b = 0; b < 4; b++) {
    bandY.push({ y0: y, h: bandH[b] })
    y += bandH[b] ? bandH[b] + o.bandGap : 0
  }
  const totalH = y - (bandH[3] ? o.bandGap : 0) + o.padY

  const nodes = [], sites = []
  for (const [key, groups] of cellGroups) {
    const [bs, rs] = key.split(':')
    const b = +bs, r = +rs
    const cw = colW[r], cx = colX[r]
    let cy = bandY[b].y0 + (bandH[b] - (cellH.get(key) || 0)) / 2
    for (const grp of groups) {
      const multi = grp.length > 1
      let gh = 0
      for (const id of grp) gh += sizeOf.get(id).h
      if (multi) gh += 14 * (grp.length - 1) + 22
      let iy = cy + (multi ? 22 : 0)
      const memberIds = []
      for (const id of grp) {
        const s = sizeOf.get(id)
        const nd = (o.nudge || {})[id] || {}
        nodes.push({
          id, band: b, rank: r, mod: mods.get(id),
          w: s.w, h: s.h,
          x: cx + (nd.dx || 0),
          y: iy + s.h / 2 + (nd.dy || 0),
          siteId: multi ? key + '#' + grp[0] : ''
        })
        memberIds.push(id)
        iy += s.h + 14
      }
      if (multi) {
        // 站名的取法，按「哪个才是这座站本身」排序：
        //   ① 组里的【宿主】—— 挂载件的站址是跟着它来的，它就是这座站 / 这个载体；
        //   ② 同址模块名的公共前缀（「北京信关站 天线」「北京信关站 功放」→「北京信关站」）；
        //   ③ 首个射频模块名（一座站通常以它的天线命名）。
        const host = grp.map((id) => mods.get(id)).find((m) => m && (!m.place || m.place.mode !== 'mounted'))
        const rf = grp.map((id) => mods.get(id)).find((m) => m && (m.cat === 'B' || m.rf))
        const hosted = grp.some((id) => { const m = mods.get(id); return m && m.place && m.place.mode === 'mounted' })
        // ★ 三条都取不到就【不给名字】：拿组里第一个成员的名字当站名是在编 ——
        //   三个同址的传感器里挑一个叫「坝前水位计」，图上就成了「这三件属于坝前水位计」。
        //   框本身已经说明「这几件同址」，没名字比错名字好。
        const name = (hosted && host ? host.name : '') ||
          commonPrefix(grp.map((id) => (mods.get(id) || {}).name || '')) ||
          (rf ? rf.name : '')
        sites.push({
          id: key + '#' + grp[0], name, band: b, rank: r, members: memberIds,
          x: cx, y: cy + gh / 2, w: cw, h: gh
        })
      }
      cy += gh + o.rowGap
    }
  }
  nodes.sort((a, b) => (a.band - b.band) || (a.rank - b.rank) || (a.y - b.y) || String(a.id).localeCompare(String(b.id)))

  const bands = BANDS.map((bd, i) => ({ ...bd, y0: bandY[i].y0, y1: bandY[i].y0 + bandY[i].h, h: bandY[i].h }))
    .filter((bd) => bd.h > 0)
  return { nodes, sites, bands, w: totalW, h: totalH, maxRank: maxR, rank, laneW: o.laneW, colX, colW }
}

/** 公共前缀（到最后一个非字母数字的分隔处截断，避免切出半个词） */
export function commonPrefix(names) {
  const list = names.filter(Boolean)
  if (list.length < 2) return ''
  let p = list[0]
  for (const n of list) {
    let i = 0
    while (i < p.length && i < n.length && p[i] === n[i]) i++
    p = p.slice(0, i)
    if (!p) return ''
  }
  p = p.replace(/[\s·—\-_/]+$/, '')
  return p.length >= 2 ? p : ''
}

/** 布局结果 → 按 id 取点 */
export const posMap = (lay) => new Map(lay.nodes.map((n) => [n.id, n]))
