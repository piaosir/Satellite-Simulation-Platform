// 点标记序号徽标：白套圈 + 琥珀盘 + 圈心数字（「圈1、圈2」那种记号），盘心就是该点的位置。
// 2D 平面图直接画在主画布上、3D 画进精灵贴图 —— 同一支画笔，两个视图的观感严格一致
// （圈/盘/字的比例、笔画粗细、套边、透明度全在这里定，改这里两边一起变）。
//
// ★ 盘是【半透】的：图上这一层要与底下的国界/岸线/等值线/覆盖填充共存，实心盘会把它标的那一小块
//   整个盖掉（与峰值点标记弃用实心圆点、改画细十字是同一条理由）。半透之后记号还是这个记号，
//   底图透得出来 —— 比换成空心圈更保得住「一枚记号」的观感。
// ★ 白圈与套边不跟着透：两者加起来只占直径的 14%，压满也几乎不吃面积，透了反而使轮廓发虚。
//   真正吃面积的是盘，透明度只需要花在它身上。
// ★ 数字不透：它是这枚记号唯一的信息，半透的字在杂底上先垮。深墨压半透琥珀，实测在深海 / 亮陆 /
//   Turbo 覆盖场的红橙蓝各档上对比度都在 5:1 以上。
// ★ 圈的大小只跟用户设的档位走、与位数无关：一串编号在图上大小齐一才读得出是同一层的记号，
//   位数多了是让字自己缩进圈里，不是把圈撑大（撑大之后 1 和 128 成了两种符号）。
// ★ 全部尺寸按直径 d 成比例、不设像素下限：一旦给下限，2D（按屏幕像素作画）与 3D（贴图整体缩放）
//   在小尺寸下就对不齐了，而两视图一致比小档位下那一根线更要紧。
// ★ 序号与「点标记表格」的行号同源（数组下标 +1），坐标留空的行照样占号 —— 图上第 7 号就是表里第 7 行。

export const BADGE_FILL = 'rgba(255,210,74,0.62)'    // 琥珀盘（半透，与点标记圆点同色）
export const BADGE_RING = 'rgba(255,255,255,0.90)'   // 白套圈：与 dot(ring) 同一条套边
export const BADGE_CASE = 'rgba(6,11,18,0.66)'       // 外沿深色套边：亮底上给盘切出轮廓
export const BADGE_INK = '#1b1205'                   // 圈心数字：深墨，不透

const RING_W = 0.09      // 白圈线宽 / d
const CASE_W = 0.05      // 套边比白圈各外扩的总量 / d（两侧各 CASE_W/2）
// 连套边在内的视觉外半径 / d：标注让位、3D 贴图留白都按它算，不按 0.5
export const BADGE_R = 0.5 + (RING_W + CASE_W) / 2 + CASE_W / 2
// 总直径 / d = 2×BADGE_R = 1.19；3D 贴图里盘占画布的比例须留够这份余量
export const BADGE_TEX_FILL = 0.82

/**
 * 标注让位：文字字心到锚点的距离。
 * 带徽标时＝盘外沿 + 半个字高 + 0.2 字高的余白；与圆点那档 base 取大 —— 圈调得比圆点还小时不必外推。
 * @param base 没有徽标时的距离（圆点那档的原口径）
 * @param d    徽标直径，0 = 没有徽标
 * @param fh   字高（2D 的 pf / 3D 的 ptFont×MK_FONT_K，两者同值）
 */
export function badgeLabelUp(base, d, fh) {
  return Math.max(base, d * BADGE_R + fh * 0.7)
}

/**
 * 画一枚序号徽标（白圈 + 半透琥珀盘 + 圈心数字）。
 * @param ctx   2D 上下文（2D 是主画布，3D 是贴图用的离屏画布）
 * @param x,y   盘心
 * @param d     琥珀盘的直径（与 ctx 当前单位一致；连套边的视觉直径是它的 1.19 倍）
 * @param text  编号文字
 * @param font  字体族（2D 传当前出图字体族，3D 传 UI_FONT —— 出 PDF 时字体族名要跟着换）
 */
export function paintNumBadge(ctx, x, y, d, text, font) {
  const s = String(text == null ? '' : text)
  const r = d / 2
  ctx.save()
  ctx.lineJoin = 'round'; ctx.miterLimit = 2
  // 半透的盘不能与白圈叠着画：白圈是压在盘沿【上】的，圆环内半区会白×琥珀叠成一层更亮的边。
  // 故盘只填到白圈内沿（r − RING_W/2 × d），盘与圈各占各的，透出来的底色也不会被叠加两次。
  ctx.beginPath(); ctx.arc(x, y, r - d * RING_W / 2, 0, Math.PI * 2)
  ctx.fillStyle = BADGE_FILL; ctx.fill()
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.lineWidth = d * RING_W; ctx.strokeStyle = BADGE_RING; ctx.stroke()
  ctx.beginPath(); ctx.arc(x, y, r + d * (RING_W + CASE_W) / 2, 0, Math.PI * 2)
  ctx.lineWidth = d * CASE_W; ctx.strokeStyle = BADGE_CASE; ctx.stroke()
  if (s) {
    // 字要落在【白圈内】：内净直径 = d×(1−RING_W)=0.91d，字高取 0.60d、宽度上限 0.74d，
    // 多位数按量出来的宽度等比缩
    const base = d * 0.60, room = d * 0.74
    ctx.font = `bold ${base}px ${font}`
    const w = ctx.measureText(s).width || 1
    const fs = w > room ? base * room / w : base
    ctx.font = `bold ${fs}px ${font}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    // 数字的视觉中心＝字形包围盒的中心，不是基线、也不是 textBaseline='middle'（那走的是 em 框，
    // 纯数字整体偏低半档）。逐串量 ascent/descent 摆正，1 和 10 才落在同一条线上。
    // measureText 只给 width 的实现（出图用的画布垫片）退回按字号估。
    const m = ctx.measureText(s)
    const asc = m.actualBoundingBoxAscent, dsc = m.actualBoundingBoxDescent
    const dy = (Number.isFinite(asc) && Number.isFinite(dsc)) ? (asc - dsc) / 2 : fs * 0.34
    ctx.fillStyle = BADGE_INK; ctx.fillText(s, x, y + dy)
  }
  ctx.restore()
}
