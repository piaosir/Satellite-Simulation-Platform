// 标记符号（点标记 / 地球站的几何符号）：2D 平面图（flatmap/flatCoverage.js）与 3D 球体
// （globe3d/scene.js）共用的单一真值源 —— 与 numBadge.js / vehicleSymbol.js / stationSymbol.js 同一条约定：
// 形状只在这里画一次，2D 直接画在主画布上、3D 画进精灵贴图，两个视图的观感严格一致。
//
// ★ 尺寸口径：一律以【视觉直径 d】为准，形状连同描边整个塞进 d×d 的方框里。
//   2D 按屏幕像素直接给 d；3D 先画进 TEX 见方的贴图（形状占 MARK_TEX_FILL），再把精灵的
//   _px 放大回 d / MARK_TEX_FILL —— 与序号徽标 BADGE_TEX_FILL 同一套换算。
// ★ 锚点：除图钉外一律【形心 = 该点位置】；图钉是【针尖 = 该点位置】，形体整个在锚点上方
//   （地图符号惯例：针尖指的那个像素才是站址）。两个视图都按 symbolAnchorY 取同一个锚点，
//   2D 按它偏移画笔、3D 按它设 sprite.center，站址才落在同一个像素上。
// ★ 描边宽是【直径的比例】不是绝对像素：3D 那边符号是一张贴图整体缩放的，绝对像素的描边
//   在贴图里根本无从表达（同一张贴图会被缩到各种大小），只有比例才能两视图一致。

// 形状表（下拉里的顺序即此序）。zh/en 由界面按语言取用；'noto'/'antenna' 是地球站专有的天线符号，
// 不在这张表里（它们走 stationSymbol.js 的 SVG，形状固定）。
export const MARK_SHAPES = [
  { k: 'circle', zh: '圆点', en: 'Circle' },
  { k: 'ring', zh: '空心圈', en: 'Ring' },
  { k: 'square', zh: '方块', en: 'Square' },
  { k: 'diamond', zh: '菱形', en: 'Diamond' },
  { k: 'triangle', zh: '三角', en: 'Triangle' },
  { k: 'star', zh: '五角星', en: 'Star' },
  { k: 'cross', zh: '十字', en: 'Cross' },
  { k: 'x', zh: '叉', en: 'X' },
  { k: 'pin', zh: '图钉', en: 'Pin' }
]
export const MARK_SHAPE_KEYS = MARK_SHAPES.map((s) => s.k)
export const isMarkShape = (k) => MARK_SHAPE_KEYS.includes(k)

// 3D 贴图里形状占的比例（其余是留白：描边、星角、抗锯齿都要地方）
export const MARK_TEX_FILL = 0.78

// 锚点在 d×d 方框里的纵向位置（0=框底、1=框顶；横向恒 0.5）。
// 图钉的针尖在框底 → 0；其余形状形心在框心 → 0.5。
export function symbolAnchorY(shape) { return shape === 'pin' ? 0 : 0.5 }

// 十字/叉的臂宽、空心圈的环宽（均为 d 的比例）
const ARM_W = 0.26, RING_W = 0.22

// 形状路径（不含描边）。cx,cy = 方框中心；d = 方框边长。
// 十字/叉不走填充路径（它们是两根线），单独处理。
function shapePath(ctx, shape, cx, cy, d, inset) {
  const r = d / 2 - inset
  ctx.beginPath()
  if (shape === 'square') { ctx.rect(cx - r, cy - r, r * 2, r * 2); return }
  if (shape === 'diamond') {
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath(); return
  }
  if (shape === 'triangle') {
    // 等边三角形，形心在方框心（不是外接圆心）：三顶点到形心等距 r
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + i * 2 * Math.PI / 3
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a)
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
    }
    ctx.closePath(); return
  }
  if (shape === 'star') {
    const ri = r * 0.42
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? ri : r
      const x = cx + rr * Math.cos(a), y = cy + rr * Math.sin(a)
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
    }
    ctx.closePath(); return
  }
  if (shape === 'ring') {   // 环：外圈顺时针 + 内圈逆时针，非零环绕规则自然挖空（不必用 evenodd，出图垫片也认）
    const ri = Math.max(0.5, r - d * RING_W)
    ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, Math.PI * 2, false)
    ctx.moveTo(cx + ri, cy); ctx.arc(cx, cy, ri, 0, Math.PI * 2, true)
    return
  }
  if (shape === 'pin') {
    // 针尖在方框底边中点，头部圆在上方。总高 ≈ 0.98d、宽 0.6d，整体塞进方框。
    const R = (d / 2 - inset) * 0.6, tipY = cy + d / 2 - inset, hy = tipY - (d - inset * 2) * 0.68
    ctx.moveTo(cx, tipY)
    ctx.quadraticCurveTo(cx - R * 1.15, hy + R * 0.85, cx - R, hy)
    ctx.arc(cx, hy, R, Math.PI, 0, false)
    ctx.quadraticCurveTo(cx + R * 1.15, hy + R * 0.85, cx, tipY)
    ctx.closePath(); return
  }
  ctx.arc(cx, cy, r, 0, Math.PI * 2)   // circle（兜底）
}

/**
 * 画一枚标记符号。
 * @param ctx    2D 上下文（2D 是主画布，3D 是贴图用的离屏画布）
 * @param x,y    锚点（图钉＝针尖，其余＝形心）
 * @param d      视觉直径（连描边一起塞进 d×d 方框）
 * @param o      { shape, fill, opacity, edge, edgeColor }
 *                 edge = 描边宽 / d（0＝不描）；opacity 作用于整枚符号（描边一起淡）
 */
export function paintMarkSymbol(ctx, x, y, d, o) {
  const s = o || {}
  const shape = s.shape || 'circle'
  const fill = s.fill || '#ffd24a'
  const ew = Math.max(0, Number(s.edge) || 0) * d
  const edgeColor = s.edgeColor || 'rgba(255,255,255,0.92)'
  const op = s.opacity != null ? Math.max(0, Math.min(1, s.opacity)) : 1
  if (!(d > 0) || op <= 0) return
  // 方框心：图钉的锚点在框底，其余在框心
  const cy = shape === 'pin' ? y - d / 2 : y
  const sa = ctx.globalAlpha
  ctx.save()
  ctx.globalAlpha = sa * op
  ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.lineCap = 'round'
  if (shape === 'cross' || shape === 'x') {
    // 两根线：先用描边色勾一圈更粗的垫底（套边），再铺本色 —— 与文字套边、地球站符号同一套做法
    const a = (d / 2) * (shape === 'x' ? 0.72 : 1) - ew / 2
    const rot = shape === 'x' ? Math.PI / 4 : 0
    const arm = Math.max(0.6, d * ARM_W - ew)
    ctx.translate(x, cy); if (rot) ctx.rotate(rot)
    ctx.beginPath()
    ctx.moveTo(-a, 0); ctx.lineTo(a, 0); ctx.moveTo(0, -a); ctx.lineTo(0, a)
    if (ew > 0) { ctx.lineWidth = arm + ew * 2; ctx.strokeStyle = edgeColor; ctx.stroke() }
    ctx.lineWidth = arm; ctx.strokeStyle = fill; ctx.stroke()
    ctx.restore(); ctx.globalAlpha = sa
    return
  }
  shapePath(ctx, shape, x, cy, d, ew / 2)
  ctx.fillStyle = fill; ctx.fill()
  if (ew > 0) { ctx.lineWidth = ew; ctx.strokeStyle = edgeColor; ctx.stroke() }
  ctx.restore(); ctx.globalAlpha = sa
}

/**
 * 3D 用：把一枚符号画进离屏画布（供 CanvasTexture）。形状占 MARK_TEX_FILL，其余留白。
 * @param tex 贴图边长（px）
 */
export function markSymbolCanvas(o, tex) {
  const T = tex || 128
  const c = document.createElement('canvas'); c.width = c.height = T
  const d = T * MARK_TEX_FILL
  const shape = (o && o.shape) || 'circle'
  // 锚点在贴图里的位置：形心 → 正中；针尖 → 形状方框的底边
  const y = shape === 'pin' ? T / 2 + d / 2 : T / 2
  paintMarkSymbol(c.getContext('2d'), T / 2, y, d, o)
  return c
}

// 3D 精灵的 center.y（three 的 sprite.center 自底算）：贴图里锚点的纵向位置换算过来。
// 形心 → 0.5；针尖 → 贴图中心下方 d/2 处 = 0.5 − MARK_TEX_FILL/2。
export function texCenterY(shape) { return shape === 'pin' ? 0.5 - MARK_TEX_FILL / 2 : 0.5 }

// 符号在锚点【上方 / 下方】各占多少（d 的比例）——标注让位用：
// 形心锚的形状上下各半；图钉整个在锚点上方，下方为 0。
export function symbolUp(shape) { return shape === 'pin' ? 1 : 0.5 }
export function symbolDown(shape) { return shape === 'pin' ? 0 : 0.5 }
