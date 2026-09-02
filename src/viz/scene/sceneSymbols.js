// 应用场景仿真 · 模块符号：2D 平面图 / 3D 球体 / 拓扑图 三处共用的单一真值源。
//
// ★ 与 vehicleSymbol.js / markSymbols.js 同一套做法，理由也一样（那两处的坑都踩过）：
//   ① 形状存成【命令数组】、两边都走 canvas 回放，不建 Path2D ——
//      2D 导出走 svgcanvas，它忽略 Path2D 入参，只能逐段回放；
//   ② 3D 侧的精灵贴图【同步】画在 canvas 上，不走「SVG → Image → Texture」——
//      异步贴图在只渲有限几帧的出图/离屏路径里会整个不出现。
//
// ============ 数据来源（二期换成品素材）============
// 一期这里是 75 个手写几何符号（矩形 + 圆 + 折线）；二期整份删除，改成 Tabler（MIT）与
// Lucide（ISC）的成品矢量，由 scripts/build-scene-symbols.mjs 在构建期转译成同样的命令数组
// （见 sceneSymbolData.js）。★ 换的是数据来源，不是画法 —— 上面两条约束一个字没动。
// 模块 → 图标的逐条映射在 sceneSymbolMap.js。
//
// ============ 图元语言 ============
// 一个图元 = { d: 命令, s: 'fill'|'stroke' }，d 第一位是类型：
//   ['r', x,y,w,h,rx?]        矩形（rx 圆角）
//   ['c', cx,cy,r]            圆
//   ['e', cx,cy,rx,ry,rot?]   椭圆
//   ['p', x1,y1, x2,y2, …]    多边形（闭合）
//   ['l', x1,y1, x2,y2, …]    折线（不闭合）
//   ['path', ['M',…],['L',…]] 复杂路径（M/L/C/Q/Z）
// 一律画在 128×128 视框里、锚点＝视框中心 (64,64)，线宽按 128 视框写、随 size 一起缩。

import { SYMBOL_DATA, SYM_STROKE_W } from './sceneSymbolData.js'
import { symbolSpec, FALLBACK_ICON } from './sceneSymbolMap.js'

export const SYM_VB = 128
export const SYM_CASE = 'rgba(6,11,18,0.82)'   // 套色描边：与地球站符号、载具符号同一套
export const SYM_CASE_W = 5.0

// ★ 描边符号在地图上必须自带套边：一期的实心符号靠形状本身压住底图，描边件没有面积，
//   落在等值线或影像底图上时线与底纹同粗同色就糊了。做法与地图注记套边同源 ——
//   先用套色把整个图形描粗一圈，再画本体。套色＝调用方给的 caseColor（面板上就是底色，
//   画出来看不见；地图上是那层深色 halo）。
const HALO_W = 6.0

// ── 图元回放 ──
function tracePrim(ctx, d) {
  const k = d[0]
  ctx.beginPath()
  if (k === 'r') {
    const [, x, y, w, h, rx] = d
    const r = Math.min(rx || 0, w / 2, h / 2)
    if (!r) { ctx.rect(x, y, w, h); return }
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r)
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath()
  } else if (k === 'c') {
    ctx.arc(d[1], d[2], d[3], 0, Math.PI * 2)
  } else if (k === 'e') {
    ctx.ellipse(d[1], d[2], d[3], d[4], (d[5] || 0) * Math.PI / 180, 0, Math.PI * 2)
  } else if (k === 'p' || k === 'l') {
    for (let i = 1; i < d.length; i += 2) (i === 1 ? ctx.moveTo : ctx.lineTo).call(ctx, d[i], d[i + 1])
    if (k === 'p') ctx.closePath()
  } else if (k === 'a') {
    ctx.arc(d[1], d[2], d[3], d[4] * Math.PI / 180, d[5] * Math.PI / 180)
  } else if (k === 'path') {
    for (let i = 1; i < d.length; i++) {
      const c = d[i]
      if (c[0] === 'M') ctx.moveTo(c[1], c[2])
      else if (c[0] === 'L') ctx.lineTo(c[1], c[2])
      else if (c[0] === 'C') ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6])
      else if (c[0] === 'Q') ctx.quadraticCurveTo(c[1], c[2], c[3], c[4])
      else if (c[0] === 'Z') ctx.closePath()
    }
  }
}

/** 一组图元画在当前变换下（已是 128 视框坐标）。wk = 线宽系数（徽标要略粗才认得出） */
function paintParts(ctx, parts, color, caseColor, wk) {
  const w = SYM_STROKE_W * (wk || 1)
  // 第一趟：套边
  if (caseColor) {
    ctx.strokeStyle = caseColor
    ctx.lineWidth = w + HALO_W
    for (const p of parts) { tracePrim(ctx, p.d); ctx.stroke() }
  }
  // 第二趟：本体
  for (const p of parts) {
    tracePrim(ctx, p.d)
    if (p.s === 'fill') { ctx.fillStyle = color; ctx.fill() }
    else { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke() }
  }
}

const dataOf = (icon) => SYMBOL_DATA[icon] || SYMBOL_DATA[FALLBACK_ICON] || []

export const symbolIds = () => Object.keys(SYMBOL_DATA)
export const hasSymbol = (key) => {
  const sp = symbolSpec(key)
  return !!(sp && SYMBOL_DATA[sp.icon])
}
/** 模块（或图标名）→ 主图标名。给需要「这两个模块是不是同一个符号」的地方用 */
export const iconOf = (key) => symbolSpec(key).icon

/**
 * 2D / 拓扑图：把符号画在 (x, y)，边长 size。
 * @param key       模块 libId（走 sceneSymbolMap 的逐条映射）或直接给图标名 'tabler:xxx'
 * @param color     主色
 * @param rot       弧度，缺省 0（本套符号一律正立，只有载具类会被调用方转向）
 * @param caseColor 套色（底色 / halo）。给了就先描一圈，让符号在任何底图上都立得住
 */
export function drawSymbol(ctx, key, x, y, size, color, rot, caseColor) {
  const spec = symbolSpec(key)
  const s = size / SYM_VB
  const kc = caseColor || SYM_CASE
  const ink = color || '#fff'
  ctx.save()
  ctx.translate(x, y)
  if (rot) ctx.rotate(rot)
  ctx.scale(s, s)
  ctx.translate(-SYM_VB / 2, -SYM_VB / 2)
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'
  paintParts(ctx, dataOf(spec.icon), ink, kc, 1)
  // 徽标：右下角。先垫一枚套色实心圆把主图标挖开，否则两套线叠在一起谁也认不出。
  if (spec.badge) {
    const BX = 98, BY = 98, BR = 27, BOX = 44
    ctx.beginPath(); ctx.arc(BX, BY, BR, 0, Math.PI * 2)
    ctx.fillStyle = kc; ctx.fill()
    ctx.strokeStyle = ink; ctx.lineWidth = SYM_STROKE_W * 0.42; ctx.stroke()
    ctx.save()
    ctx.translate(BX, BY); ctx.scale(BOX / SYM_VB, BOX / SYM_VB); ctx.translate(-SYM_VB / 2, -SYM_VB / 2)
    // 徽标只有主图标 0.34 的边长，线宽按比例缩下去就细得看不见了 —— 回补一半（不回补满：
    // 徽标是从属信息，笔画比主图标略细才不抢主图标的位）
    paintParts(ctx, dataOf(spec.badge), ink, null, 1.7)
    ctx.restore()
  }
  ctx.globalAlpha = 1
  ctx.restore()
}

/**
 * 3D：现画一张 size×size 的 canvas 供 CanvasTexture 用。
 * ★ 同步返回，绝不走「SVG → Image」那条异步路 —— 出图只渲有限几帧，异步贴图会整个不出现。
 */
export function symbolCanvas(key, px, color, caseColor) {
  const n = Math.max(16, Math.round(px || 64))
  const cv = document.createElement('canvas')
  cv.width = n; cv.height = n
  const ctx = cv.getContext('2d')
  // 套色底：3D 上没有地图底色兜着，先铺一层半透明深色让符号在亮底上也立得住
  drawSymbol(ctx, key, n / 2, n / 2, n * 0.90, color, 0, caseColor)
  return cv
}

export default { drawSymbol, symbolCanvas, symbolIds, hasSymbol, iconOf, SYM_VB, SYM_CASE }
