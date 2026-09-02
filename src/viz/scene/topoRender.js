// 应用场景仿真 · 拓扑图渲染（canvas，屏上 / PNG / SVG 三处共用一支画笔）。
//
// 与地理视图是同一份 scene 的两个投影：这里只管「怎么画」，位置由 topoLayout 算、
// 走线由 topoRoute 算，数据与结果直接读 sceneStore。
//
// ============ ★ 连线的颜色语言 = 三档判据 ============
// 拓扑图上一眼要看出的第一件事，是「这一段的数是怎么来的」：
//   卫星段    机位色实线、最粗          —— 走 linkChain 正向递推
//   功率预算档 墨色实线                 —— 与射频同构的 dB 账（光纤 / 视距无线）
//   约束校验档 墨色实线 + 端头短横       —— 只有「实际 vs 上限」，没有 dB 余量
//   契约档    告警色虚线                —— 承诺值，不是算出来的
//   供电边    极淡点线                  —— 不进 dB 账，走能量账
// 备份边一律再叠一层虚线（主备并联，可用度走「至少一条在」而非连乘）。
// 越界的约束项与负余量按平台惯例【只给数值着色】，不写「不可行」这类文字判定。
//
// ============ 二期的视觉层重做 ============
// 一期：四条带只是一行淡字 + 虚线；连线跨带一律中点折一次、同带跨层贝塞尔绕行（穿卡片、
// 互相重叠、没有避障）；边标一律画在中点互相压；节点卡 132×56 一种；只能出 PNG。
// 二期：真泳道（左侧带名栏 + 带间交替底色 + 分隔实线）、正交路由（topoRoute）、
// 站点容器、边标按最长水平段落位并贪心消重叠、PNG 与 SVG 两条出图路都走这支画笔。

import { drawSymbol } from './sceneSymbols.js'
import { bandOf, NODE_H } from './topoLayout.js'
import { routeAll, polyDist, labelAnchor, placeLabels } from './topoRoute.js'

const css = (n, fb) => {
  try { const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v || fb } catch { return fb }
}
export function palette() {
  return {
    bg: css('--bg', '#fff'), surface: css('--surface', '#eee'), surface2: css('--surface-2', '#e4e3de'),
    text: css('--text', '#1a1a1a'), muted: css('--text-muted', '#6b6b66'), faint: css('--text-faint', '#86867f'),
    border: css('--border', '#d3d2cc'), borderS: css('--border-strong', '#adaca4'),
    accent: css('--accent-ui', '#2f5d8a'), ok: css('--ok', '#1d7a52'), warn: css('--warn', '#9a6a00'), danger: css('--danger', '#a32d2d')
  }
}

const SYM = 30

/** 一条边的画法档位 */
export function edgeStyle(tier, role, P) {
  const back = role === 'backup'
  if (tier === 'satellite') return { color: P.accent, w: 2.6, dash: back ? [7, 5] : null, cap: false }
  if (tier === 'contract') return { color: P.warn, w: 1.8, dash: [6, 4], cap: false }
  if (tier === 'constraint') return { color: P.text, w: 1.6, dash: back ? [7, 5] : null, cap: true }
  if (tier === 'supply') return { color: P.faint, w: 1.2, dash: [2, 4], cap: false }
  return { color: P.text, w: 1.8, dash: back ? [7, 5] : null, cap: false }   // power
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath()
}

// 文本裁切（超宽加省略号）
function clipText(ctx, s, max) {
  s = String(s == null ? '' : s)
  if (ctx.measureText(s).width <= max) return s
  let lo = 0, hi = s.length
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, mid) + '…').width <= max) lo = mid; else hi = mid - 1 }
  return s.slice(0, lo) + '…'
}

// ═══════════════════════════════════════════════════════════════════════════
// 走线 + 边标落位（纯计算，屏上与出图共用同一份结果）
// ═══════════════════════════════════════════════════════════════════════════
/**
 * @param lay    topoLayout.layout() 的结果
 * @param model  { links, mediaOf, tierOf, readings, measure(text, px) }
 * @param opt    { fontPx }
 * @returns { routes: Map<linkId, pts>, jumps, labels: [{ id, x, y, w, h, t, c, hide }], ms }
 */
export function routeTopology(lay, model, opt) {
  const o = opt || {}
  const fontPx = o.fontPx || 12
  const measure = o.measure || ((t) => String(t).length * fontPx * 0.6)
  // 障碍 = 节点卡；站点容器不再单独当障碍（它把成员整个框住，再当障碍会把成员之间的通道也堵死）
  const obstacles = lay.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }))
  const edges = (model.links || [])
    .filter((l) => obstacles.some((n) => n.id === l.a.modId) && obstacles.some((n) => n.id === l.b.modId))
    .map((l) => ({ id: l.id, a: l.a.modId, b: l.b.modId, role: l.role }))
  const r = routeAll(obstacles, edges, { bounds: { x0: lay.laneW || 0, y0: 0, x1: lay.w, y1: lay.h } })

  // 边标：放在最长水平段中点，贪心消重叠；放不下就降级（省介质名只留读数）
  const boxes = []
  for (const l of model.links || []) {
    const pts = r.routes.get(l.id)
    if (!pts) continue
    const lb = edgeLabel(l, model)
    if (!lb) continue
    const an = labelAnchor(pts)
    const w = measure(lb.t, fontPx - 2) + 10
    boxes.push({ id: l.id, x: an.x, y: an.y, w, h: fontPx + 4, t: lb.t, c: lb.c, room: an.room, full: lb.t, short: lb.s || lb.t })
  }
  const placed = placeLabels(boxes, fontPx + 4, 5)
  // 通道太窄放不下整条标签的，降级成只显读数
  for (const b of placed) {
    if (b.hide) continue
    if (b.room > 0 && b.w > b.room + 24 && b.short !== b.full) {
      b.t = b.short
      b.w = measure(b.t, fontPx - 2) + 10
    }
  }
  return { routes: r.routes, jumps: r.jumps, labels: placed, ms: r.ms }
}

// ═══════════════════════════════════════════════════════════════════════════
// 画
// ═══════════════════════════════════════════════════════════════════════════
/**
 * @param ctx      canvas 2D 上下文（已按 dpr 缩放）
 * @param lay      布局结果
 * @param model    { links, flows, result, sel, hover, mediaOf, tierOf, readings, catLabel, lint }
 * @param routed   routeTopology() 的结果
 * @param view     { ox, oy, k }
 * @param W,H      逻辑像素尺寸
 * @param fontPx   基准字号
 * @param opt      { frame: {title, meta} 出图时画图框；屏上不画 }
 */
export function drawTopology(ctx, lay, model, routed, view, W, H, fontPx, opt) {
  const P = palette()
  const F = fontPx || 12
  const o = opt || {}
  const fam = o.fontStack || css('--ui-font-stack', 'system-ui, sans-serif')
  ctx.save()
  ctx.fillStyle = P.bg; ctx.fillRect(0, 0, W, H)
  ctx.translate(view.ox, view.oy); ctx.scale(view.k, view.k)
  ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineCap = 'round'

  const laneW = lay.laneW || 0

  // ── ① 泳道：带间交替底色 + 分隔实线 + 左侧固定宽带名栏 ──
  lay.bands.forEach((b, i) => {
    const y0 = b.y0 - 12, y1 = b.y1 + 12
    ctx.fillStyle = i % 2 ? P.bg : P.surface
    ctx.fillRect(0, y0, lay.w, y1 - y0)
    ctx.strokeStyle = P.border; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(lay.w, y1); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(lay.w, y0); ctx.stroke()
  })
  if (laneW) {
    ctx.fillStyle = P.surface2
    ctx.fillRect(0, (lay.bands[0] ? lay.bands[0].y0 : 0) - 12, laneW, lay.h)
    ctx.strokeStyle = P.borderS; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(laneW, (lay.bands[0] ? lay.bands[0].y0 : 0) - 12); ctx.lineTo(laneW, lay.h); ctx.stroke()
    ctx.font = `600 ${F - 1}px ${fam}`; ctx.fillStyle = P.muted; ctx.textAlign = 'center'
    for (const b of lay.bands) ctx.fillText(b.zh, laneW / 2, (b.y0 + b.y1) / 2)
  }

  // ── ② 站点容器（在连线之下、节点之下）──
  for (const s of lay.sites || []) {
    const x = s.x - s.w / 2, y = s.y - s.h / 2
    ctx.strokeStyle = P.borderS; ctx.lineWidth = 1; ctx.setLineDash([4, 4])
    roundRect(ctx, x, y, s.w, s.h, 6); ctx.stroke()
    ctx.setLineDash([])
    if (s.name) {
      ctx.font = `${F - 2}px ${fam}`; ctx.fillStyle = P.faint; ctx.textAlign = 'left'
      ctx.fillText(clipText(ctx, s.name, s.w - 16), x + 8, y + 11)
    }
  }

  // ── ③ 连线 ──
  const selFlowPath = flowPathSet(model)
  for (const lk of model.links || []) {
    const pts = routed.routes.get(lk.id)
    if (!pts || pts.length < 2) continue
    const tier = model.tierOf(lk.medium)
    const st = edgeStyle(tier, lk.role, P)
    const sel = model.sel && model.sel.type === 'link' && model.sel.id === lk.id
    const onFlow = selFlowPath && selFlowPath.has(lk.id)
    // 选中业务流：整条路径先铺一层机位色光晕
    if (onFlow) {
      ctx.strokeStyle = P.accent; ctx.globalAlpha = 0.22; ctx.lineWidth = st.w + 7
      strokePoly(ctx, pts, routed.jumps, lk.id)
      ctx.globalAlpha = 1
    }
    ctx.strokeStyle = sel ? P.accent : st.color
    ctx.lineWidth = sel ? st.w + 1.2 : st.w
    ctx.setLineDash(st.dash || [])
    strokePoly(ctx, pts, routed.jumps, lk.id)
    ctx.setLineDash([])
    // 约束档：两端各画一道短横，示意「这是过不过线，不是余量」
    if (st.cap) {
      ctx.lineWidth = 1.6
      for (const [a, b] of [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]]) {
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
        const nx = -(b[1] - a[1]) / d * 4, ny = (b[0] - a[0]) / d * 4
        const cx = a[0] + (b[0] - a[0]) / d * 9, cy = a[1] + (b[1] - a[1]) / d * 9
        ctx.beginPath(); ctx.moveTo(cx - nx, cy - ny); ctx.lineTo(cx + nx, cy + ny); ctx.stroke()
      }
    }
  }

  // ── ④ 边标 ──
  ctx.font = `${F - 2}px ${fam}`
  for (const b of routed.labels || []) {
    if (b.hide) continue
    ctx.fillStyle = P.bg; ctx.globalAlpha = 0.94
    ctx.fillRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h)
    ctx.globalAlpha = 1
    ctx.fillStyle = b.c || P.muted; ctx.textAlign = 'center'
    ctx.fillText(b.t, b.x, b.y)
  }

  // ── ⑤ 节点 ──
  for (const n of lay.nodes) {
    const m = n.mod
    const sel = model.sel && model.sel.type === 'module' && model.sel.id === n.id
    const hov = model.hover && model.hover.type === 'module' && model.hover.id === n.id
    const x = n.x - n.w / 2, y = n.y - n.h / 2
    ctx.fillStyle = P.bg
    roundRect(ctx, x, y, n.w, n.h, 5); ctx.fill()
    ctx.strokeStyle = sel ? P.accent : (hov ? P.borderS : P.borderS)
    ctx.lineWidth = sel ? 2 : 1
    roundRect(ctx, x, y, n.w, n.h, 5); ctx.stroke()
    // 类别色条（无彩，只用明度分档 —— 平台既定：颜色留给状态）
    ctx.fillStyle = m.cat === 'A' ? P.accent : (m.cat === 'H' ? P.text : P.borderS)
    ctx.fillRect(x, y + 1, 3, n.h - 2)
    drawSymbol(ctx, m, x + 10 + SYM / 2, n.y, SYM, P.text, 0, P.bg)
    ctx.textAlign = 'left'
    const tw = n.w - SYM - 26
    ctx.font = `600 ${F}px ${fam}`; ctx.fillStyle = P.text
    ctx.fillText(clipText(ctx, m.name, tw), x + SYM + 18, n.y - 8)
    ctx.font = `${F - 2}px ${fam}`; ctx.fillStyle = P.faint
    ctx.fillText(clipText(ctx, nodeSub(m, model), tw), x + SYM + 18, n.y + 9)
    // 缺参数：右上角一个红点（只是点，不写字）
    if (model.lint && model.lint.has && model.lint.has(n.id)) {
      ctx.fillStyle = P.danger
      ctx.beginPath(); ctx.arc(x + n.w - 7, y + 7, 3.2, 0, Math.PI * 2); ctx.fill()
    }
    // 悬停：四向连接柄（从柄拖出去即连线）
    if (hov) {
      ctx.fillStyle = P.accent
      for (const [hx, hy] of handlePoints(n)) { ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fill() }
    }
  }

  // ── ⑥ 出图图框（屏上不画）──
  if (o.frame) drawFrame(ctx, lay, o.frame, P, F, fam)

  ctx.restore()
}

/** 四向连接柄的位置（悬停显示；拖出即连线） */
export function handlePoints(n) {
  return [[n.x, n.y - n.h / 2], [n.x + n.w / 2, n.y], [n.x, n.y + n.h / 2], [n.x - n.w / 2, n.y]]
}

/** 画折线；经过跳线点时抬一段小弧（Visio 的 line jump） */
function strokePoly(ctx, pts, jumps, id) {
  const mine = (jumps || []).filter((j) => j.id === id)
  ctx.beginPath()
  ctx.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const horiz = Math.abs(a[1] - b[1]) < 1e-6
    // 只在水平段上做跳线：竖段让路会与泳道线混在一起
    const on = horiz ? mine.filter((j) => Math.abs(j.y - a[1]) < 1e-6 && j.x > Math.min(a[0], b[0]) + 3 && j.x < Math.max(a[0], b[0]) - 3)
      .sort((p, q) => (b[0] > a[0] ? p.x - q.x : q.x - p.x)) : []
    for (const j of on) {
      const dir = b[0] > a[0] ? 1 : -1
      ctx.lineTo(j.x - dir * 4, a[1])
      ctx.arc(j.x, a[1], 4, dir > 0 ? Math.PI : 0, dir > 0 ? 0 : Math.PI, dir > 0)
      ctx.moveTo(j.x + dir * 4, a[1])
    }
    ctx.lineTo(b[0], b[1])
  }
  ctx.stroke()
}

/** 选中业务流的路径边集合（整条高亮用） */
function flowPathSet(model) {
  const s = model.sel
  if (!s || s.type !== 'flow' || !model.result) return null
  const f = (model.result.flows || []).find((x) => x.id === s.id)
  if (!f) return null
  const out = new Set()
  for (const d of f.dirs || []) for (const l of d.path || []) out.add(l)
  return out
}

/** 节点副标题：卫星报轨位、地面站报口径、其余报类别 */
export function nodeSub(m, model) {
  if (!m) return ''
  if (m.cat === 'A') {
    const s = m.sat || {}
    if (s.orbitClass === 'GSO' && s.orbitLongitude != null) return `${Math.abs(+s.orbitLongitude).toFixed(1)}°${+s.orbitLongitude < 0 ? 'W' : 'E'} · ${s.frequencyBand || ''}`
    return `${s.orbitAltitude || '—'} km / ${s.orbitInclination || '—'}° · ${s.frequencyBand || ''}`
  }
  if (m.rf && m.rf.antennaDiameter > 0) return `Φ${m.rf.antennaDiameter} m · ${m.rf.opPowerW || '—'} W`
  if (m.rf && m.rf.gainTxDbi != null) return `${m.rf.gainTxDbi} dBi · ${m.rf.opPowerW || '—'} W`
  return model && model.catLabel ? model.catLabel(m.cat) : ''
}

/** 边标文字 + 颜色（有结果就报读数，没有就报介质名）。s = 通道窄时的降级文本 */
export function edgeLabel(lk, model) {
  const P = palette()
  const med = model.mediaOf(lk.medium)
  const name = med ? med.zh : lk.medium
  const tier = model.tierOf(lk.medium)
  const r = model.readings ? model.readings(lk.id) : []
  const hit = r.find((x) => x.seg)
  if (hit && hit.seg) {
    const s = hit.seg
    if (tier === 'power' && s.marginDb != null) {
      const v = `${(+s.marginDb).toFixed(1)} dB`
      return { t: `${name} · ${v}`, s: v, c: s.marginDb < 0 ? P.danger : P.muted }
    }
    if (tier === 'constraint') {
      const over = (s.checks || []).filter((c) => c.over)
      if (over.length) {
        const c = over[0]
        const v = `${fmt(c.actual)}${c.unit} / 限 ${fmt(c.limit)}${c.unit}`
        return { t: `${name} · ${v}`, s: v, c: P.danger }
      }
      const c0 = (s.checks || [])[0]
      return c0 ? { t: `${name} · ${fmt(c0.actual)}${c0.unit}`, s: `${fmt(c0.actual)}${c0.unit}`, c: P.muted } : { t: name, s: name, c: P.muted }
    }
    if (tier === 'contract') return { t: `${name} · ${fmtRate(s.rateBps)}`, s: fmtRate(s.rateBps), c: P.warn }
  }
  return { t: name, s: name, c: P.faint }
}
const fmt = (v) => (v == null || !isFinite(v) ? '—' : (Math.abs(v) >= 100 ? Math.round(v) : (+v).toFixed(1)))
export function fmtRate(b) {
  if (b == null || !isFinite(b)) return '—'
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' Gbps'
  if (b >= 1e6) return (b / 1e6).toFixed(2) + ' Mbps'
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' kbps'
  return Math.round(b) + ' bps'
}

/**
 * 出图图框：标题 + 日期 + 图例 + 统计。★ 只在导出时画 —— 屏上有工具条与图例组件，
 * 再画一遍就是两份；而交付出去的那张图没有界面兜着，必须自带这些。
 */
function drawFrame(ctx, lay, frame, P, F, fam) {
  const pad = 14
  const y = lay.h - 34
  ctx.strokeStyle = P.borderS; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(lay.w - pad, y); ctx.stroke()
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  ctx.font = `600 ${F + 1}px ${fam}`; ctx.fillStyle = P.text
  ctx.fillText(frame.title || '', pad, y + 17)
  ctx.font = `${F - 2}px ${fam}`; ctx.fillStyle = P.faint
  ctx.textAlign = 'right'
  ctx.fillText(frame.meta || '', lay.w - pad, y + 17)
  // 图例：四档判据的线（与屏上那条图例同一套颜色语言）
  const legend = [['卫星段', P.accent, 2.6, null], ['功率预算', P.text, 1.8, null], ['约束校验', P.text, 1.6, null], ['契约', P.warn, 1.8, [6, 4]]]
  let lx = pad + ctx.measureText(frame.title || '').width + 40
  ctx.textAlign = 'left'
  for (const [t, c, w, d] of legend) {
    ctx.strokeStyle = c; ctx.lineWidth = w; ctx.setLineDash(d || [])
    ctx.beginPath(); ctx.moveTo(lx, y + 17); ctx.lineTo(lx + 18, y + 17); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = P.muted
    ctx.fillText(t, lx + 23, y + 17)
    lx += 23 + ctx.measureText(t).width + 16
  }
}

/** 命中测试：屏幕坐标 → 节点 / 连接柄 / 连线 */
export function hitTest(lay, model, routed, view, sx, sy) {
  const x = (sx - view.ox) / view.k, y = (sy - view.oy) / view.k
  // 连接柄优先（它画在卡片边上，落在卡片命中区里）
  for (const n of lay.nodes) {
    handlePoints(n).forEach(([hx, hy], i) => { /* 顺序：上 右 下 左 */ void i; void hx; void hy })
    const hp = handlePoints(n)
    for (let i = 0; i < hp.length; i++) {
      if (Math.hypot(x - hp[i][0], y - hp[i][1]) <= 7 / view.k) return { type: 'handle', id: n.id, side: ['t', 'r', 'b', 'l'][i], node: n }
    }
  }
  for (const n of lay.nodes) {
    if (Math.abs(x - n.x) <= n.w / 2 && Math.abs(y - n.y) <= n.h / 2) return { type: 'module', id: n.id, node: n }
  }
  let best = null
  for (const lk of model.links || []) {
    const pts = routed.routes.get(lk.id)
    if (!pts) continue
    const d = polyDist(pts, x, y)
    if (d < 8 / view.k && (!best || d < best.d)) best = { type: 'link', id: lk.id, d }
  }
  if (best) return best
  for (const s of lay.sites || []) {
    if (Math.abs(x - s.x) <= s.w / 2 && Math.abs(y - s.y) <= s.h / 2) return { type: 'site', id: s.id, site: s }
  }
  return null
}

export { NODE_H }
