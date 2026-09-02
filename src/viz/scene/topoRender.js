// 应用场景仿真 · 拓扑图渲染（canvas，2D 与出图共用一支画笔）。
//
// 与地理视图是同一份 scene 的两个投影：这里只管「怎么画」，位置由 topoLayout 算，
// 数据与结果直接读 sceneStore。
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

import { drawSymbol } from './sceneSymbols.js'
import { bandOf } from './topoLayout.js'

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

const NODE_W = 132, NODE_H = 56, SYM = 30

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

/**
 * 画整张拓扑图。
 * @param ctx      canvas 2D 上下文（已按 dpr 缩放）
 * @param lay      topoLayout.layout() 的结果
 * @param model    { links, flows, result, sel, mediaOf, tierOf, labels }
 * @param view     { ox, oy, k }  平移与缩放
 * @param W,H      逻辑像素尺寸
 * @param fontPx   基准字号
 */
export function drawTopology(ctx, lay, model, view, W, H, fontPx) {
  const P = palette()
  const F = fontPx || 12
  const fam = css('--ui-font-stack', 'system-ui, sans-serif')
  ctx.save()
  ctx.fillStyle = P.bg; ctx.fillRect(0, 0, W, H)
  ctx.translate(view.ox, view.oy); ctx.scale(view.k, view.k)
  ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineCap = 'round'

  const pos = new Map(lay.nodes.map((n) => [n.id, n]))

  // ── ① 带底纹与带名 ──
  for (const b of lay.bands) {
    ctx.fillStyle = b.key === 'orbit' ? P.surface : P.bg
    if (b.key === 'orbit') ctx.fillRect(0, b.y0 - 14, lay.w, (b.y1 - b.y0) + 28)
    ctx.strokeStyle = P.border; ctx.lineWidth = 1; ctx.setLineDash([3, 5])
    ctx.beginPath(); ctx.moveTo(0, b.y1 + 14); ctx.lineTo(lay.w, b.y1 + 14); ctx.stroke()
    ctx.setLineDash([])
    ctx.font = `${F - 1}px ${fam}`; ctx.fillStyle = P.faint; ctx.textAlign = 'left'
    ctx.fillText(b.zh, 10, b.y0 - 2)
  }

  // ── ② 连线（先画，压在节点下）──
  for (const lk of model.links || []) {
    const a = pos.get(lk.a.modId), b = pos.get(lk.b.modId)
    if (!a || !b) continue
    const tier = model.tierOf(lk.medium)
    const st = edgeStyle(tier, lk.role, P)
    const sel = model.sel && model.sel.type === 'link' && model.sel.id === lk.id
    // 端点落在卡片边缘上（不从中心出发，避免线钻进卡片里）
    const [x1, y1, x2, y2] = anchorPair(a, b)
    ctx.strokeStyle = sel ? P.accent : st.color
    ctx.lineWidth = sel ? st.w + 1.4 : st.w
    ctx.setLineDash(st.dash || [])
    ctx.beginPath()
    // ★ 三种走线，按两端的相对位置挑：
    //   ① 跨带 —— 正交折线（读起来像网络图）
    //   ② 同带相邻层 —— 直连
    //   ③ 同带跨 ≥2 层 —— 【绕行】：直连必然从中间那些卡片身上压过去（备份链路最常见这种，
    //      主路一跳一跳走、备份一根线直通到底）。绕行幅度随跨度增大，绕在带下方。
    const detour = (a.band === b.band && Math.abs(a.rank - b.rank) >= 2)
    if (a.band !== b.band) {
      const mx = (x1 + x2) / 2
      ctx.moveTo(x1, y1); ctx.lineTo(mx, y1); ctx.lineTo(mx, y2); ctx.lineTo(x2, y2)
    } else if (detour) {
      const dy = NODE_H * 0.62 + Math.min(3, Math.abs(a.rank - b.rank) - 1) * 12
      const ax = a.x, bx = b.x, yb = Math.max(a.y, b.y) + dy
      ctx.moveTo(ax, a.y + NODE_H / 2)
      ctx.bezierCurveTo(ax, yb, bx, yb, bx, b.y + NODE_H / 2)
    } else { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2) }
    ctx.stroke()
    ctx.setLineDash([])
    // 约束档：两端各画一道短横，示意「这是过不过线，不是余量」
    if (st.cap) {
      const t = 4
      ctx.lineWidth = 1.6
      for (const [px, py, qx, qy] of [[x1, y1, x2, y2], [x2, y2, x1, y1]]) {
        const d = Math.hypot(qx - px, qy - py) || 1
        const nx = -(qy - py) / d * t, ny = (qx - px) / d * t
        const ax = px + (qx - px) / d * 9, ay = py + (qy - py) / d * 9
        ctx.beginPath(); ctx.moveTo(ax - nx, ay - ny); ctx.lineTo(ax + nx, ay + ny); ctx.stroke()
      }
    }
    // 边标：介质 + 读数
    const lbl = edgeLabel(lk, model)
    if (lbl) {
      const detourY = Math.max(a.y, b.y) + NODE_H * 0.62 + Math.min(3, Math.abs(a.rank - b.rank) - 1) * 12
      const mx = detour ? (a.x + b.x) / 2 : (x1 + x2) / 2
      const my = detour ? (Math.max(a.y, b.y) + NODE_H / 2 + detourY) / 2 + 2
        : (y1 + y2) / 2 + (a.band !== b.band ? 0 : -9)
      ctx.font = `${F - 2}px ${fam}`
      // 相邻两卡之间那点空档常常塞不下整条标签 —— 裁到可用宽度，别压到卡片上
      const gap = (a.band === b.band && !detour)
        ? Math.max(40, Math.abs(a.x - b.x) - NODE_W - 6)
        : Math.max(60, Math.abs(x2 - x1) + 40)
      const txt = clipText(ctx, lbl.t, gap)
      const w = ctx.measureText(txt).width + 8
      ctx.fillStyle = P.bg; ctx.globalAlpha = 0.92
      ctx.fillRect(mx - w / 2, my - (F - 2) / 2 - 3, w, F + 2)
      ctx.globalAlpha = 1
      ctx.fillStyle = lbl.c || P.muted; ctx.textAlign = 'center'
      ctx.fillText(txt, mx, my)
    }
  }

  // ── ③ 节点 ──
  for (const n of lay.nodes) {
    const m = n.mod
    const sel = model.sel && model.sel.type === 'module' && model.sel.id === n.id
    const x = n.x - NODE_W / 2, y = n.y - NODE_H / 2
    ctx.fillStyle = P.bg
    roundRect(ctx, x, y, NODE_W, NODE_H, 5); ctx.fill()
    ctx.strokeStyle = sel ? P.accent : P.borderS
    ctx.lineWidth = sel ? 2 : 1
    roundRect(ctx, x, y, NODE_W, NODE_H, 5); ctx.stroke()
    // 类别色条（无彩，只用明度分档 —— 平台既定：颜色留给状态）
    ctx.fillStyle = m.cat === 'A' ? P.accent : (m.cat === 'H' ? P.text : P.borderS)
    ctx.fillRect(x, y + 1, 3, NODE_H - 2)
    drawSymbol(ctx, m.symbol, x + 8 + SYM / 2, n.y, SYM, P.text, 0, P.bg)
    ctx.textAlign = 'left'
    ctx.font = `600 ${F}px ${fam}`; ctx.fillStyle = P.text
    ctx.fillText(clipText(ctx, m.name, NODE_W - SYM - 22), x + SYM + 16, n.y - 8)
    ctx.font = `${F - 2}px ${fam}`; ctx.fillStyle = P.faint
    ctx.fillText(clipText(ctx, nodeSub(m, model), NODE_W - SYM - 22), x + SYM + 16, n.y + 9)
  }
  ctx.restore()
}

/** 卡片边缘上的连接点：取两卡中心连线与卡片矩形的交点 */
function anchorPair(a, b) {
  const clip = (n, tx, ty) => {
    const dx = tx - n.x, dy = ty - n.y
    if (!dx && !dy) return [n.x, n.y]
    const sx = dx ? (NODE_W / 2) / Math.abs(dx) : Infinity
    const sy = dy ? (NODE_H / 2) / Math.abs(dy) : Infinity
    const s = Math.min(sx, sy)
    return [n.x + dx * s, n.y + dy * s]
  }
  const [x1, y1] = clip(a, b.x, b.y)
  const [x2, y2] = clip(b, a.x, a.y)
  return [x1, y1, x2, y2]
}

/** 节点副标题：卫星报轨位、地面站报口径、其余报类别 */
function nodeSub(m, model) {
  if (m.cat === 'A') {
    const s = m.sat || {}
    if (s.orbitClass === 'GSO' && s.orbitLongitude != null) return `${Math.abs(+s.orbitLongitude).toFixed(1)}°${+s.orbitLongitude < 0 ? 'W' : 'E'} · ${s.frequencyBand || ''}`
    return `${s.orbitAltitude || '—'} km / ${s.orbitInclination || '—'}° · ${s.frequencyBand || ''}`
  }
  if (m.rf && m.rf.antennaDiameter > 0) return `Φ${m.rf.antennaDiameter} m · ${m.rf.opPowerW || '—'} W`
  if (m.rf && m.rf.gainTxDbi != null) return `${m.rf.gainTxDbi} dBi · ${m.rf.opPowerW || '—'} W`
  return model.catLabel ? model.catLabel(m.cat) : ''
}

/** 边标文字 + 颜色（有结果就报读数，没有就报介质名） */
function edgeLabel(lk, model) {
  const P = palette()
  const med = model.mediaOf(lk.medium)
  const name = med ? med.zh : lk.medium
  const tier = model.tierOf(lk.medium)
  const r = model.readings ? model.readings(lk.id) : []
  const hit = r.find((x) => x.seg)
  if (hit && hit.seg) {
    const s = hit.seg
    if (tier === 'power' && s.marginDb != null) return { t: `${name} · ${(+s.marginDb).toFixed(1)} dB`, c: s.marginDb < 0 ? P.danger : P.muted }
    if (tier === 'constraint') {
      const over = (s.checks || []).filter((c) => c.over)
      if (over.length) { const c = over[0]; return { t: `${name} · ${fmt(c.actual)}${c.unit} / 限 ${fmt(c.limit)}${c.unit}`, c: P.danger } }
      const c0 = (s.checks || [])[0]
      return { t: c0 ? `${name} · ${fmt(c0.actual)}${c0.unit}` : name, c: P.muted }
    }
    if (tier === 'contract') return { t: `${name} · ${fmtRate(s.rateBps)}（契约）`, c: P.warn }
  }
  return { t: name, c: P.faint }
}
const fmt = (v) => (v == null || !isFinite(v) ? '—' : (Math.abs(v) >= 100 ? Math.round(v) : (+v).toFixed(1)))
export function fmtRate(b) {
  if (b == null || !isFinite(b)) return '—'
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' Gbps'
  if (b >= 1e6) return (b / 1e6).toFixed(2) + ' Mbps'
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' kbps'
  return Math.round(b) + ' bps'
}

/** 命中测试：屏幕坐标 → 节点 / 连线 */
export function hitTest(lay, model, view, sx, sy) {
  const x = (sx - view.ox) / view.k, y = (sy - view.oy) / view.k
  for (const n of lay.nodes) {
    if (Math.abs(x - n.x) <= NODE_W / 2 && Math.abs(y - n.y) <= NODE_H / 2) return { type: 'module', id: n.id, node: n }
  }
  const pos = new Map(lay.nodes.map((n) => [n.id, n]))
  let best = null
  for (const lk of model.links || []) {
    const a = pos.get(lk.a.modId), b = pos.get(lk.b.modId)
    if (!a || !b) continue
    let d
    if (a.band === b.band && Math.abs(a.rank - b.rank) >= 2) {
      // 绕行弧：按弧上若干采样点取最近距离（画法见 drawTopology 的 detour 分支）
      const dy = NODE_H * 0.62 + Math.min(3, Math.abs(a.rank - b.rank) - 1) * 12
      const yb = Math.max(a.y, b.y) + dy
      const p0 = [a.x, a.y + NODE_H / 2], p3 = [b.x, b.y + NODE_H / 2]
      d = Infinity
      let px = p0[0], py = p0[1]
      for (let t = 0.05; t <= 1.0001; t += 0.05) {
        const u = 1 - t
        const qx = u * u * u * p0[0] + 3 * u * u * t * a.x + 3 * u * t * t * b.x + t * t * t * p3[0]
        const qy = u * u * u * p0[1] + 3 * u * u * t * yb + 3 * u * t * t * yb + t * t * t * p3[1]
        d = Math.min(d, segDist(x, y, px, py, qx, qy)); px = qx; py = qy
      }
    } else {
      const [x1, y1, x2, y2] = anchorPair(a, b)
      d = segDist(x, y, x1, y1, x2, y2)
    }
    if (d < 8 / view.k && (!best || d < best.d)) best = { type: 'link', id: lk.id, d }
  }
  return best
}
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const l2 = dx * dx + dy * dy
  if (!l2) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

export { NODE_W, NODE_H }
