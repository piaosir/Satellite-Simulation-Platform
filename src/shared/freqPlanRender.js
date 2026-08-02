// 转发器频率计划 · 渲染（渲染端 ESM）。
//
// 一套几何两处用：屏上编辑器直接吃 layout() 的结果做命中测试与拖拽，导出 PNG/PDF 吃同一份
// layout 生成 SVG —— 所见即所得不是靠对齐两套代码，而是压根只有一套。
//
// 版式对齐标准频率计划图（中星/亚太/前向计划那一族）：
//   每个频带 = 频率标注（上）· 极化行1 · 基线 · 极化行2 · 频率标注（下）
//   上行带在上、下行带在下，中间留 LO 变频箭头的走道；底部是波束图例与 LO/信标注记。
//   带内相距过远的两簇（双 LO 的下行是常态）中间折成一个「…」断口，不把那片空白照比例画出来。
//   同一排（同频带 · 同极化）里频率重叠的块【错开分层】而不是原地叠着画 —— 一条宽带转发器压在几条
//   窄带上时，叠着画等于把底下那几条整个抹掉（图上看不见，屏上连点都点不着）。见 pickLane。
//
// 字体：跟平台报表统一的 TNR + 宋体衬线栈，且写死进 SVG —— 导出的 SVG 离开页面后没有祖先可继承，
// 不写死就会在 PDF 里掉回默认字体（这个坑踩过，见 lb-export-png-resolution）。
//
// ★ 图上文字一律英文（UPLINK/DOWNLINK · 段头 · 空态 · 图例分隔符…）：这张图是对外交付的成品，
//   对标的那一族标准计划图（Intelsat / Eutelsat / 亚太）都是英文版式。界面是中文、图是英文，
//   两者不是一回事 —— 往这里加中文文案前先想清楚它是「图的一部分」还是「界面的一部分」。
//   图上唯一的中文来源是人自己录进去的名字（计划名 / 波束名 / LO 名 / 转发器编号），照原样画。

import { resolveAll, planExtent, toGHz, beamLabel, unitLabel, fmtFreqNum, MARK_KINDS } from './freqPlanModel.js'

export const SERIF_STACK = "'Times New Roman', 'Nimbus Roman', 'Liberation Serif', '宋体', SimSun, serif"

export const DEFAULT_STYLE = {
  width: 1280,
  fontSize: 12,
  blockH: 26,             // 色块高度
  rowGap: 2,              // 同带内两个极化行的间距（基线厚度居中）
  laneGap: 4,             // 同一排内错开的两层之间的间距（见 pickLane）
  labelGap: 4,            // 色块与频率标注的间距
  bandGap: 96,            // 上下行带之间的走道（放 LO 箭头）
  padX: 64,               // 左侧极化标签区
  padRight: 24,           // 右侧留白（这一侧不放标签，故窄得多）
  padTop: 34,
  padBottom: 16,
  // 下面这几个「小挑头」曾是散在 layout/planBody 里的字面量。★ 字面量不随导出倍率放大，
  // 于是 4× 图上的右留白只剩 6px（末端那个频率数字被裁掉半个）、界标贴着首末块——
  // 凡是长度都必须住在 style 里，才会被 scaleStyle 按倍率一起重画。
  guidePad: 8,            // 界标竖线相对数据端点的外挑
  titleIndent: 8,         // 频带标题 / 段头 / 段间分隔线相对 padX 的左挑
  polIndent: 20,          // 极化字母（右对齐）相对 padX 的左挑
  arrowW: 13,             // LO 箭头头部的宽（长度同宽）
  loNoteGap: 10,          // LO 注记与箭头的横向间距
  markW: 6,               // 标记类载波（信标 / 遥控 / 遥测）那根箭头的头宽（头长同宽）。★ 瘦下来的是【头】：
                          // 9px 的头贴着界标时两者糊成一处，而这几类本就是不载业务的小信号
  markH: 26,              // 那根箭头的全长（含头）—— 细而长才像一根谱线。上限是一整格块高（markGeom 会钳）：
                          // 再长就顶进自己那个频率标注的字身里，而那一行的数是与整排对齐的、不能给它单独抬高
  markClear: 4,           // 界标竖线与那根箭头之间至少留的空当（见 layout 里的外挑钳制）
  endPad: 6,              // 端头留白在「最外那个标注的半宽」之外再加的余量
  minBlockW: 16,          // 无带宽的通道（带宽还没录的那种）画多宽 —— 没带宽可对应，只求看得见
  minBwBlockW: 3,         // 有带宽的块只保底到「不消失」，再窄也不抬 —— 抬了就成了不同带宽同宽度
  showFreqLabels: true,
  showLegend: true,
  showLo: true,
  showGuides: true,       // 两端的边界竖线
  stagger: true,          // 同排频率重叠的块错开分层（见 pickLane）；关掉则回到原地叠着画
  breakGaps: true,        // 带内大空隙折叠成「…」断口（见 findBreakGaps）
  breakMinRatio: 0.12,    // 空隙 ≥ 该带跨度的这个比例才折叠 —— 比例，不随导出倍率缩放
  breakPx: 36,            // 断口宽度（随倍率缩放）
  maxBreaks: 3,           // 最多折叠几处 —— 计数，不随导出倍率缩放
  unit: 'MHz',            // Hz|kHz|MHz|GHz|THz —— 频率标注与图例带宽共用的刻度，不影响几何
  theme: 'light',
  // 合成图（layoutMulti / toSvgMulti）专用，单份出图时无效：
  title: '',              // 全图总标题（居中在最上方）；空串 = 不画
  showSectionTitles: true, // 每段的段头（计划名 · 频段）
  sharedScale: false      // 各段统一比例尺（同带宽跨频段同宽）；关 = 各段各自铺满画布
}

// 按倍率重画时不该乘 scale 的键：比例与计数乘了就改判据（0.12 × 4 = 0.48 → 4× 图与 1× 图断的地方都不一样）
const NO_SCALE = new Set(['unit', 'theme', 'breakMinRatio', 'maxBreaks', 'title', 'showSectionTitles', 'sharedScale'])

// 按倍率把所有长度量放大（几何重画，不是给 SVG 加 viewBox 缩放）。
// ★ 导出成品 = 屏上那张图整体放大 scale 倍，一个像素都不许自己走样 —— 故凡是长度都得经过这里，
//   任何写死在 layout/planBody 里的像素数都是一处「4× 图上只有 1× 大小」的漂移（导出了才看得见），
//   故一并对外：core 自测据此逐点比对 1× 与 4× 的几何，再漏一个字面量就当场红。
export const scaleStyle = (st0, scale) => (scale === 1 ? st0 : Object.fromEntries(Object.entries(st0).map(([k, v]) => [
  k, (typeof v === 'number' && !NO_SCALE.has(k)) ? v * scale : v
])))

/** 导出倍率下的完整版式参数（= DEFAULT_STYLE ← 调用方的样式，再整体乘倍率），toSvg 与自测共用 */
export const exportStyle = (styleIn = {}, scale = 1) => scaleStyle({ ...DEFAULT_STYLE, ...styleIn }, scale)

const THEMES = {
  light: { paper: '#ffffff', ink: '#1a1a1a', dim: '#666', line: '#333', axis: '#555', blockStroke: '#8a6d1f', suspect: '#c62828', guide: '#888' },
  dark: { paper: '#141618', ink: '#e8e8e8', dim: '#9aa0a6', line: '#c8c8c8', axis: '#a0a0a0', blockStroke: '#d4af37', suspect: '#ff6b6b', guide: '#777' }
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n2 = (v) => (Number.isFinite(v) ? (Math.round(v * 100) / 100) : null)

// 频率 → 标注文字。口径（小数位随单位走、尾零剪掉）在 freqPlanModel 的 fmtFreqNum 上，
// 图上、屏上表格与校验条目共用那一个；这里只留一个转发名，导出与屏上的老调用方不必改。
export const fmtFreq = (mhz, unit) => fmtFreqNum(mhz, unit)

// LO 注记文字（「LO1: 1750 MHz   LO2: 2300 MHz」），同样屏上与导出共用一份
export function loNoteText(plan, unit) {
  return (plan?.los || [])
    .map((l) => `${l.name}: ${Number.isFinite(l.valueMHz) ? `${fmtFreq(l.valueMHz, unit)} ${unitLabel(unit)}` : '—'}`)
    .join('   ')
}

/**
 * 图底那行标记类载波的注记：
 *   「BEACON: B1 12498 MHz H, B2 12501 MHz V · TC: CMD 13998 MHz H · TM: TLM 12200 MHz H」
 * 图上那几根箭头只标频率（箭头旁再堆一串名字会把密排处糊死），「哪根是信标、哪根是遥测」由这一行
 * 认领，故按类型分组、每组冠一个英文前缀（图上文字一律英文，见文件头；前缀取自 CHANNEL_KINDS 的 tag）。
 * ★ 分组靠标点不靠空格：SVG 的 <text> 默认折叠连续空白，拿几个空格拉开的组界在图上会糊成一句
 *   （屏上、PNG、PDF 三处都糊）。
 * 空串 = 这份计划没有这类通道，那一行连带它的行高一并不要（见 layout 里的 loY）。
 */
export function beaconNoteText(plan, unit) {
  const rs = resolveAll(plan).filter((r) => r.mark)
  if (!rs.length) return ''
  const out = []
  for (const k of MARK_KINDS) {
    const list = rs.filter((r) => r.kind === k.key)
    if (!list.length) continue
    const items = list.map((r) => {
      const s = r.up || r.dn
      const f = s ? `${fmtFreq(s.fc, unit)} ${unitLabel(unit)}${s.pol ? ' ' + s.pol : ''}` : '—'
      return r.no ? `${r.no} ${f}` : f
    })
    out.push(`${k.tag}: ${items.join(', ')}`)
  }
  return out.join(' · ')
}

/**
 * LO 变频箭头的几何（竖线 + 实心三角头 + 注记文字的落点），屏上与导出共用这一份。
 *
 * ★ 头自己画成三角，不用 <marker>：marker 默认 markerUnits="strokeWidth"，而「按倍率重画」时
 *   线宽本身已经带了倍率，头的尺寸再乘一次 —— 4× 导出图上的箭头就是 16 倍大（那只盖住半张图、
 *   把 LO 注记压在底下的黑三角正是这么来的）。何况 svg2pdf 压根不认 markerUnits，PDF 里的头
 *   又比屏上小一圈：同一个箭头三处三个大小。三角自己画，屏上/PNG/PDF 才是同一个头。
 */
export function loArrowGeom(L, st) {
  const bands = L?.bands || []
  if (bands.length !== 2) return null
  const fs = st.fontSize
  const x = st.padX + L.innerW * 0.5
  const y0 = bands[0].y1 + fs * 0.6            // 上行带底
  const y1 = bands[1].y0 - fs * 0.4            // 下行带顶（箭尖落在这里）
  const w = st.arrowW
  const yb = y1 - w                            // 三角底边
  const n = (v) => Number(v.toFixed(2))
  return {
    x: n(x), y0: n(y0), y1: n(y1),
    lineY1: n(yb + w * 0.1),                   // 竖线探进三角一点点，免得抗锯齿时露出一道缝
    head: `M${n(x - w / 2)},${n(yb)} L${n(x + w / 2)},${n(yb)} L${n(x)},${n(y1)} Z`,
    textX: n(x + st.loNoteGap),
    textY: n((y0 + y1) / 2 + fs * 0.35)
  }
}

/**
 * 标记类载波（信标 / 遥控 / 遥测）那根箭头的几何 —— 屏上与导出共用这一份（同 loArrowGeom：
 * 两处各摆一遍必漂，而漂出来的箭头只有导出后才看得见）。
 *
 * 这三类是不载业务的等幅波，在频率上没有宽度，故不画色块而画【一根从频率轴上立起来的谱线】——
 * 各家频率计划图给 TM/TC/信标 的就是这根箭头。箭头【背对基线】：基线在上排之下、下排之上，
 * 于是上排朝上、下排朝下，箭尖正指着自己那一行频率标注（标注同样是上排在上、下排在下）。
 *
 * ★ 全长按 markH 走，比色块矮一截（原先是满块高、9px 的头）：这几类本就是不载业务的小信号，
 *   画得与转发器一样壮时，一根紧挨着末端转发器的信标会与界标、端点标注挤成一团。箭尾仍钉在基线上，
 *   只是不再顶到块顶 —— 频率标注那一行不动（整排的数还是对齐的）。
 *
 * 头自绘三角，不用 <marker>——理由同 loArrowGeom（markerUnits 会让 4× 导出时的头大 16 倍）。
 *
 * hit：屏上/小程序的命中区（箭头本身只有 1.5px 宽，点不中）。几何同样只算这一处。
 */
export function markGeom(b, st) {
  const w = st.markW
  const len = Math.min(b.h, Number.isFinite(st.markH) && st.markH > 0 ? st.markH : b.h)
  const up = b.labelSide !== 'below'          // 上排（基线在这一排下方）→ 朝上
  const cx = b.x + b.w / 2
  const yBase = up ? b.y + b.h : b.y          // 贴基线那一端（箭尾）
  const yTip = yBase + (up ? -len : len)
  const yb = yTip + (up ? w : -w)             // 三角底边
  const n = (v) => Number(v.toFixed(2))
  const hitW = Math.max(w * 2, st.fontSize * 1.2)
  return {
    x: n(cx),
    y0: n(yBase),
    y1: n(yTip),
    lineY1: n(yb + (up ? -1 : 1) * w * 0.1),  // 竖线探进三角一点点，免得抗锯齿时露出一道缝
    head: `M${n(cx - w / 2)},${n(yb)} L${n(cx + w / 2)},${n(yb)} L${n(cx)},${n(yTip)} Z`,
    hit: { x: n(cx - hitW / 2), y: n(Math.min(yBase, yTip)), w: n(hitW), h: n(len) }
  }
}

/**
 * 带内的「大空隙」→ 折叠成断口。
 *
 * 双 LO 的下行是典型：同一批上行经 LO1/LO2 落到相距几百 MHz 的两簇，按真实比例画出来中间就是一大片
 * 空白 —— 这片空白吃掉的画布正是块本该变宽的那部分，图被拉散、编号挤成一团。折叠后那一段只占固定
 * 宽度、中间点三个点（「…」），剩下的频率量去分画布。
 *
 * 判据只看几何（空隙占该带跨度的比例），不看 LO：同一个 LO 内的大留白同样该折，而两个 LO 的簇本就
 * 首尾相接时不该折 —— 「不同 LO」是这类空隙最常见的成因，不是它的定义。
 */
function findBreakGaps(band, st) {
  if (!st.breakGaps) return []
  const iv = []
  for (const r of band.items) {
    const s = band.side === 'up' ? r.up : r.dn
    if (!s) continue
    const hasBw = Number.isFinite(s.bw) && s.bw > 0
    iv.push(hasBw ? [s.f1, s.f2] : [s.fc, s.fc])   // 无带宽的通道是个点（画宽靠 minBlockW，不占频率）
  }
  if (iv.length < 2) return []
  iv.sort((a, b) => a[0] - b[0])
  const merged = [iv[0].slice()]
  for (let i = 1; i < iv.length; i++) {
    const last = merged[merged.length - 1]
    if (iv[i][0] <= last[1]) last[1] = Math.max(last[1], iv[i][1])
    else merged.push(iv[i].slice())
  }
  const total = band.ext.dataMax - band.ext.dataMin
  const minGap = total * Math.max(0, st.breakMinRatio)
  let gaps = []
  for (let i = 1; i < merged.length; i++) {
    const f0 = merged[i - 1][1], f1 = merged[i][0]
    if (f1 - f0 >= minGap && f1 > f0) gaps.push({ f0, f1, w: f1 - f0 })
  }
  // 断口多了图就碎了（每折一处都在骗读者一次）：只折最宽的那几处，其余照真实比例画
  const cap = Math.max(1, Math.floor(st.maxBreaks))
  if (gaps.length > cap) gaps = gaps.slice().sort((a, b) => b.w - a.w).slice(0, cap).sort((a, b) => a.f0 - b.f0)
  return gaps
}

/**
 * 同排里「谁跟谁叠着」→ 往下错开一层。返回该块该落在第几层，并把它占掉的横向区间记进那一层。
 *
 * 一排 = 同频带 · 同极化。同一段频率被两条通道同时占（一条宽带转发器压在几条窄带上，或干脆录重了）
 * 时，叠着画的那条等于不存在：图上被完全盖住，屏上连点都点不着，读者也数不出到底有几条。故重叠的
 * 往下错开一层各画各的 —— 图上多占一行高度，换回「每一条都看得见」。
 *
 * 分层按【表序】first-fit：表里靠前的那条留在主排（第 0 层），后来的才往下错。于是「谁在上面」由人
 * 在表里的排序说了算，而且往表尾追加一条不会把已经画好的整排掀翻（乱序分层的通病）。
 *
 * 判据用画出来的像素区间而不是频率区间：要避的是「看不见」，而零带宽的通道（信标那类）在频率上根本
 * 没有区间，宽度是撑到 minBlockW 才有的。容差取自字号（跟着导出倍率一起放大）—— 用写死的像素数的话
 * 4× 图上分出来的层数会与 1× 不一样，那就不是同一张图了。
 */
// 界标该划在哪两端：数【转发器】，外加【给了「间隔带宽」的标记类】——
//   · 没给间隔带宽的信标不算：它在频率上没有宽度，算进来只会把界标钉到它那个频率上，
//     端点标注于是与信标自己那个标注写同一个数（一个频率写两遍）。
//   · 给了间隔带宽 n 的算：那正是「在轴上给它留一格」的意思，界标落在 fc ± n/2 上
//     （12750 的信标、n=6 → 端点 12753），信标因此站在坐标轴之内而不是被排在轴外。
// 一格都没有（整条带只有没给间隔的信标）→ null，由调用方回落到全带两端。
function guideExtent(band) {
  let lo = Infinity, hi = -Infinity
  for (const r of band.items) {
    const s = band.side === 'up' ? r.up : r.dn
    if (!s) continue
    if (r.mark && !(Number.isFinite(s.slot) && s.slot > 0)) continue
    const wide = (Number.isFinite(s.bw) && s.bw > 0) || (Number.isFinite(s.slot) && s.slot > 0)
    lo = Math.min(lo, wide ? s.f1 : s.fc)
    hi = Math.max(hi, wide ? s.f2 : s.fc)
  }
  return lo <= hi ? { dataMin: lo, dataMax: hi } : null
}

function pickLane(lanes, x0, x1, tol) {
  for (let k = 0; k < lanes.length; k++) {
    // 挨着不算叠着：相邻转发器共一条边（f2 === 下一条的 f1）是常态，容差之内一律当没重叠
    if (lanes[k].every((p) => x0 >= p[1] - tol || x1 <= p[0] + tol)) { lanes[k].push([x0, x1]); return k }
  }
  lanes.push([[x0, x1]])
  return lanes.length - 1
}

/**
 * 计算版式几何。返回的每个 block 带 channelId，编辑器据此做命中测试。
 */
export function layout(plan, styleIn = {}) {
  const st = { ...DEFAULT_STYLE, ...styleIn }
  const rs = resolveAll(plan)
  const innerW = st.width - st.padX - st.padRight

  // 两个频带各自独立的频率轴（上下行量程完全不同，共用一根轴会把其中一边压成一条线），
  // 但★两根轴必须同一把尺子（同一个 MHz/px），见下面的比例尺与断口。
  const bands = []
  for (const side of ['up', 'dn']) {
    const items = rs.filter((r) => (side === 'up' ? r.up : r.dn))
    if (!items.length) continue
    // 量程 = 数据本身，两头不再各撑 1.5%：端头该留多少由「最外那个标注有多宽」定（见 endRoomOf）
    const ext = planExtent(plan, side, 0)
    if (!ext) continue
    // 极化行：按该带内实际出现的极化归行，保持 H/L 在上、V/R 在下的惯例
    const pols = [...new Set(items.map((r) => (side === 'up' ? r.up : r.dn).pol))]
    pols.sort((a, b) => (['H', 'L', 'V', 'R'].indexOf(a) - ['H', 'L', 'V', 'R'].indexOf(b)))
    bands.push({ side, ext, pols, items })
  }
  if (!bands.length) return { style: st, bands: [], blocks: [], width: st.width, height: 160, empty: true }

  // ★ 一把尺子：两带各自量程独立时，同一个 36 MHz 在上行画 119px、在下行画 71px —— 同带宽不同宽度。
  //   而这张图的全部意义在于「上下行是同一批转发器，只差一个 LO」，比例尺只能有一把（mhzPerPx 全局唯一）。
  //   带内的大空隙先折成固定宽度的断口，剩下的频率量才去分画布：省下的像素让给真正有块的地方，
  //   块更宽、图更紧，而「同带宽同宽度」不受影响（断口是块之间的事，不改段内的尺子）。
  //   每带都要塞进 innerW：eff/mhzPerPx + n·brW ≤ innerW，故取各带所需的最大 MHz/px；
  //   窄的那一带按自身宽度居中放置（频率位置不动，只是两侧多出留白）。
  // 端头留白：最外那一项的频率标注有一半探在它那个频率之外 —— 零宽的标记类（信标那几根箭头）更是
  // 整个标注都挂在自己那个频率上，而它们又总排在最外头（那正是它们该在的地方）。这半个标注得留在纸内。
  // ★ 原先靠 planExtent 往两头各撑跨度的 1.5%（换算下来恒是画布的 1.5% ≈ 18px）—— 那是个与标注
  //   宽度无关的估值：单位换成 kHz、频率带上小数、字号调大，标注一变长就探到纸外面去。按标注实际
  //   宽度算，量程/单位/字号怎么换都跟得上。
  const halfLblW = (f) => (st.showFreqLabels && Number.isFinite(f) ? textW(fmtFreq(f, st.unit), st.fontSize * 0.86) / 2 : 0)
  const endRoomOf = (band, atMin) => {
    const bound = atMin ? band.ext.dataMin : band.ext.dataMax
    let room = 0
    for (const r of band.items) {
      const s = band.side === 'up' ? r.up : r.dn
      const wide = (Number.isFinite(s.bw) && s.bw > 0) || (Number.isFinite(s.slot) && s.slot > 0)
      const edge = atMin ? (wide ? s.f1 : s.fc) : (wide ? s.f2 : s.fc)
      if (Math.abs(edge - bound) > 1e-6) continue      // 不在这一头的管不着
      // 零宽块（信标那根箭头 / 还没录带宽的）画出来的那点宽度同样有一半探在它的频率之外；
      // 标记类还要算上轴线越过它的那一小截（见 lineX0/lineX1）
      const glyph = wide ? 0 : (r.mark ? st.markW / 2 + st.guidePad : st.minBlockW / 2)
      room = Math.max(room, halfLblW(s.fc), glyph)
    }
    // 端点标注居中在界标上（界标 = 数据端点再外挑 guidePad），这一头的界标就落在量程端点上时
    // 那半个数同样要留在纸内 —— 给了「间隔带宽」的信标正是这种情形（界标 = 信标 fc + n/2）
    const gExt = band.guideExt || (band.guideExt = guideExtent(band) || band.ext)
    const gBound = atMin ? gExt.dataMin : gExt.dataMax
    if (Math.abs(gBound - bound) <= 1e-6) room = Math.max(room, halfLblW(gBound) + st.guidePad)
    return room + st.endPad
  }

  const brW = Math.max(st.breakPx, st.fontSize * 2.2)
  for (const b of bands) {
    b.gaps = findBreakGaps(b, st)
    b.roomL = endRoomOf(b, true)
    b.roomR = endRoomOf(b, false)
    b.availW = Math.max(innerW * 0.5, innerW - b.roomL - b.roomR)   // 留白再大也不许把画布吃掉一半
  }
  const effSpanOf = (b) => (b.ext.max - b.ext.min) - b.gaps.reduce((s, g) => s + g.w, 0)
  const needPerPx = Math.max(...bands.map((b) => effSpanOf(b) / Math.max(b.availW * 0.35, b.availW - b.gaps.length * brW)))
  // forceMhzPerPx：合成图「各段统一比例尺」时由 layoutMulti 灌进来的内部字段（故不在 DEFAULT_STYLE 里
  // ——它是 MHz/px，导出倍率下该除不该乘，混进「按倍率重画」那张表会被乘反）。取 max 兜底：
  // 灌进来的值比本份计划所需还细时按本份所需走，宁可这一段不统一也不让它画到纸外面去。
  const mhzPerPx = Number.isFinite(st.forceMhzPerPx) && st.forceMhzPerPx > 0
    ? Math.max(st.forceMhzPerPx, needPerPx) : needPerPx
  for (const b of bands) {
    const drawW = effSpanOf(b) / mhzPerPx + b.gaps.length * brW
    let x = st.padX + b.roomL + (b.availW - drawW) / 2
    let f = b.ext.min
    b.segs = []; b.breaks = []
    for (const g of b.gaps) {
      b.segs.push({ f0: f, f1: g.f0, x0: x })
      x += (g.f0 - f) / mhzPerPx
      b.breaks.push({ x0: x, x1: x + brW, xMid: x + brW / 2, f0: g.f0, f1: g.f1 })
      x += brW
      f = g.f1
    }
    b.segs.push({ f0: f, f1: b.ext.max, x0: x })
  }

  // 频率 → 像素。分段线性：段内是唯一那把尺子，落进断口里的频率钉在断口中点（那里本就不该有块）。
  const x2f = (band, f) => {
    const segs = band.segs
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      if (f > s.f1 && i < segs.length - 1) continue
      if (i > 0 && f < s.f0) return band.breaks[i - 1].xMid
      return s.x0 + (f - s.f0) / mhzPerPx     // 首/末段之外照原尺子外推，不钳位
    }
    return st.padX
  }
  const blocks = []
  let y = st.padTop

  for (const band of bands) {
    // ── 横向几何先行：块的 x / 宽与纵向无关，而「同排重叠 → 错开分层」要改每排的高度，
    //    故先把层分好，下面排纵向时才知道每排要留几层。
    const geos = []
    const rowLanes = band.pols.map(() => [])
    const ovlTol = st.fontSize * 0.04       // 见 pickLane：取自字号故随倍率同步，不能写死像素
    for (const r of band.items) {
      const s = band.side === 'up' ? r.up : r.dn
      const rowIdx = Math.max(0, band.pols.indexOf(s.pol))
      const hasBw = Number.isFinite(s.bw) && s.bw > 0
      // 标记类载波（信标那几根箭头）的横向占位只有箭头那么宽 —— 按 minBlockW 占 16px 的话，
      // 一根紧挨着转发器的信标会把那条转发器判成「叠着」而错开一层（见 pickLane），凭空多出一行。
      const zeroW = r.mark ? st.markW : st.minBlockW
      const x0 = hasBw ? x2f(band, s.f1) : x2f(band, s.fc) - zeroW / 2
      const x1 = hasBw ? x2f(band, s.f2) : x2f(band, s.fc) + zeroW / 2
      const wRaw = x1 - x0
      // 有带宽的块只保底到「不消失」：原先一律抬到 minBlockW=16px，于是 250 kHz 与 1 MHz 画得一样宽，
      // 宽度与带宽脱钩。无带宽的块没有可对应的量，仍按上面那个宽度当位置标记画。
      const w = Math.max(hasBw ? st.minBwBlockW : zeroW, wRaw)
      const x = x0 - (w - wRaw) / 2
      geos.push({ r, s, rowIdx, x, w, lane: st.stagger ? pickLane(rowLanes[rowIdx], x, x + w, ovlTol) : 0 })
    }
    band.laneCount = band.pols.map((_, i) => Math.max(1, rowLanes[i].length))

    // ── 界标（量程两端那两根竖线）的横向位置：与纵向无关，故与横向几何一起先算 —— 下面排纵向时
    //    要按「端点标注有没有与第一排的标注撞上」决定这一行给不给加高。
    // 界标钉在该带真实的数据两端，而不是纸的两端 —— 共用尺子后窄带不再占满画布，
    // 钉在纸边的话竖线会跑到离首末块很远的地方，而线上标的还是 dataMin/dataMax，图就自相矛盾。
    // ★ 两端只按【转发器】算，不含信标那几根箭头：界标划的是转发器占的那段频带，而信标与遥测遥控
    //   本就常排在这段之外（那正是它们该在的地方）。把它们算进来的话，界标会被拽到信标身上，
    //   端点标注还与信标自己那个频率标注挤在同一处（一个频率写两遍）。一根都没有时仍按全带算。
    band.guideExt = guideExtent(band) || band.ext
    const gx0 = x2f(band, band.guideExt.dataMin)
    const gx1 = x2f(band, band.guideExt.dataMax)
    // 外挑不许挑到标记那根箭头【连同它那个频率标注】身上：信标常就落在末端转发器外面几 MHz 处
    // （图上不过十来个像素），8px 的外挑正好顶上去 —— 界标与箭头糊成一处，那根竖线还从标注的数字上
    // 穿过去（竖线本就要往上探出块顶一截，正好探进标注那一行）。外挑到「离它还有 markClear」为止，
    // 挤不下就不挑（外挑收到 0 = 界标贴着末端转发器的边，那本来就是它标的那个频率）。
    let gpL = st.guidePad, gpR = st.guidePad
    for (const g of geos) {
      if (!g.r.mark) continue
      const h = halfLblW(g.s.fc), cx = g.x + g.w / 2
      const ink0 = Math.min(g.x, cx - h), ink1 = Math.max(g.x + g.w, cx + h)   // 箭头 ∪ 它的标注
      // 在哪一头看【箭头】（标注比箭头宽得多，按标注判的话一根在带内的信标也会把外挑收掉）
      if (g.x + g.w <= gx0) gpL = Math.min(gpL, Math.max(0, gx0 - ink1 - st.markClear))
      if (g.x >= gx1) gpR = Math.min(gpR, Math.max(0, ink0 - gx1 - st.markClear))
    }
    band.axisX0 = gx0 - gpL
    band.axisX1 = gx1 + gpR
    // ★ 轴线（基线）画到「所有画出来的东西」为止，界标只是钉在转发器那段两端的两根竖线：
    //   信标与遥测遥控常排在转发器那段之外，轴线止于界标的话它们就悬在轴外没有立足处。轴线往外
    //   延到箭头之外 guidePad（与界标相对数据端点的外挑同一个量），信标才是站在轴上而不是被轴排除。
    //   端点标注仍只标转发器那段的两端 —— 那两个数说的是转发器占的频带，不该被信标拽走。
    band.lineX0 = band.axisX0
    band.lineX1 = band.axisX1
    for (const g of geos) {
      if (!g.r.mark) continue
      band.lineX0 = Math.min(band.lineX0, g.x - st.guidePad)
      band.lineX1 = Math.max(band.lineX1, g.x + g.w + st.guidePad)
    }
    // 该带在共用尺子下窄到两端标注要叠在一起时（只剩一条零带宽通道那种），干脆不标——
    // 两个数糊成一团比不标更糟。
    band.endLabelsFit = band.axisX1 - band.axisX0 > st.fontSize * 4.5
    // 端点标注与第一排的频率标注只隔一行，两个数横向撞在一起时上下两行几乎糊成一团（末端转发器
    // 外面几 MHz 处的那根信标必撞）。撞上了就把端点标注那一行加高 —— 轴自己让开这点空间，
    // 两个数才各归各位；没撞的（绝大多数计划）版式一点不变。
    const endBoxes = st.showGuides && band.endLabelsFit
      ? [[band.axisX0, band.guideExt.dataMin], [band.axisX1, band.guideExt.dataMax]]
        .map(([cx, f]) => [cx - halfLblW(f), cx + halfLblW(f)])
      : []
    const endClash = endBoxes.some(([a, b]) => geos.some((g) => {
      if (g.rowIdx !== 0) return false            // 端点标注那一行只与第一排的标注（标在块之上）为邻
      const c = g.x + g.w / 2, h = halfLblW(g.s.fc)
      return h > 0 && c - h < b && a < c + h
    }))
    // 界标竖线两头都要探出块外一截（标准图就是这个样子），而第一排的频率标注标在块之上、末排的标在
    // 块之下 —— 正落在那两截里。竖线的 x 上恰好压着某个数时（信标贴在末端转发器外面那种），线会从
    // 数字当中穿过去。这时把那一头收到块边：数归数、线归线。没压着的（绝大多数计划）版式一点不变。
    const barStrike = (row) => st.showGuides && geos.some((g) => {
      if (g.rowIdx !== row) return false
      const c = g.x + g.w / 2, h = halfLblW(g.s.fc)
      return h > 0 && [band.axisX0, band.axisX1].some((gx) => gx > c - h - st.markClear && gx < c + h + st.markClear)
    })
    const lastRow = band.pols.length - 1
    const guideStrike = barStrike(0)
    // 只有一排时那一排的标注标在【块之上】（labelSide），下端没有数可压 —— 故末排要与第一排不同排才算
    const guideStrikeDn = lastRow > 0 && barStrike(lastRow)

    band.title = band.side === 'up' ? 'UPLINK' : 'DOWNLINK'
    band.titleY = y
    y += st.fontSize * 1.7
    // 量程端点标注（左右两端那两个数）自己占一行。原先它钉在 rowY[0] − 1.6 字高处，
    // 而左端标注就居中在 axisX0 上（当时 axisX0 = padX − 8），与同样起于 padX − 8 的频带标题撞成一团；
    // 关掉「频率标注」时两者更是叠死。给它一行专属高度，标题与它才各归各位。
    band.endLabelY = y + st.fontSize * 0.9
    y += st.showGuides ? st.fontSize * (endClash ? 1.7 : 1.15) : 0
    // 每排 = 一层或几层（重叠才分层，见 pickLane），每层自带一行频率标注：上排标在块之上、
    // 下排标在块之下，与从前「第一排的标注在最上、第二排的在最下」是同一条规矩，只是按层各给一行——
    // 不给的话两层的标注全钉在同一个 y 上，重叠的块本就同频，那两个数会正正糊在一起。
    // 不重叠时每排只有一层，版式与从前逐点相同。
    const lblAbove = st.showFreqLabels ? st.fontSize * 1.25 : 0
    const lblBelow = st.showFreqLabels ? st.fontSize * 1.3 : 0
    band.rowY = []; band.rowMidY = []; band.laneY = []; band.laneLabelY = []
    for (let i = 0; i < band.pols.length; i++) {
      const above = i === 0
      const ys = [], lys = []
      for (let k = 0; k < band.laneCount[i]; k++) {
        if (k) y += st.laneGap
        if (above) { lys.push(y); y += lblAbove }
        ys.push(y)
        y += st.blockH
        if (!above) { lys.push(y + st.fontSize * 0.2); y += lblBelow }
      }
      band.rowY.push(ys[0])                                   // 该排第一层的块顶（界标、旧口径都按它）
      band.rowMidY.push((ys[0] + ys[ys.length - 1] + st.blockH) / 2)   // 极化字母居中在整排上，不是居中在第一层
      band.laneY.push(ys); band.laneLabelY.push(lys)
      y += st.rowGap
      // 第一行之后画基线（标准图的那条贯穿粗线在两排之间）。只有一排时它就是这一排的底线——
      // 与从前那句单独的 pols.length===1 分支同值，故不再重写一遍（重写还会漏掉分层后的层高）。
      if (i === 0) { band.baselineY = y - st.rowGap / 2; y += st.rowGap }
    }
    const lastLanes = band.laneY[band.laneY.length - 1]
    band.blocksY1 = lastLanes[lastLanes.length - 1] + st.blockH   // 末排末层的块底：界标画到这里为止
    band.y0 = band.titleY
    band.y1 = y
    // 界标竖线的上下端（三处渲染共用这一份 —— 各摆一遍必漂）。上端收不收见 guideStrike，
    // 但收就整张图一起收（下面那一趟）：一带收一带不收，两带的界标看着就不是一套。
    band.guideStrike = guideStrike
    band.guideStrikeDn = guideStrikeDn
    band.guideY0 = band.rowY[0] - st.fontSize * 1.2
    band.guideY1 = band.blocksY1 + st.fontSize * 0.6

    // 断口的落笔：基线在此断开、中间点三个点（「…」）。三点用圆而不是「…」字符——
    // 导出 PDF 走嵌入字体，标点的字形与基线位置各字体不一，圆点的位置是自己说了算的。
    const dotDx = st.fontSize * 0.46
    for (const br of band.breaks) {
      br.y = band.baselineY
      br.dotR = st.fontSize * 0.12          // 不设像素下限：下限不随倍率走，4× 图上的点就会比例失真
      br.dots = [br.xMid - dotDx, br.xMid, br.xMid + dotDx]
    }
    band.baseSegs = []
    let bx = band.lineX0
    for (const br of band.breaks) { band.baseSegs.push([bx, br.x0]); bx = br.x1 }
    band.baseSegs.push([bx, band.lineX1])
    band.baseSegs = band.baseSegs.filter(([a, b]) => b - a > 0.5)

    for (const g of geos) {
      const { r, s, rowIdx, lane, x, w } = g
      const yTop = band.laneY[rowIdx][lane]
      const bms = band.side === 'up' ? r.beamsUp : r.beamsDn
      const stripes = layoutStripes(band.side === 'up' ? r.segsUp : r.segsDn, s, x, yTop, w, st.blockH)
      const blk = {
        channelId: r.id, no: r.no, side: band.side, kind: r.kind,
        // 标记类载波：图上不是色块而是一根箭头（几何见 markGeom，屏上与导出共用）
        mark: !!r.mark,
        x, y: yTop, w, h: st.blockH, lane,
        pol: s.pol, fc: s.fc, bw: s.bw,
        // 多波束 = 多色片（横向切条，每条满宽）。切条不切宽度：宽度是带宽的如实映射，
        // 竖着切会读成「这段频率的前一半给 A、后一半给 B」，而实际是整段被两个波束同时用。
        stripes,
        // 单色块与图例仍认这一个（多色时取第一条）。★ 空片是合法结果：这条转发器挂的几个波束
        // 钉的段全落在它的频带【外】（一按「指定频段」就可能出现，见 layoutStripes 末尾），此时块
        // 只剩外框。原先这里直接取 stripes[0].color，那一下抛 TypeError —— 整个 layout() 断在
        // 半路，Vue 渲染失败后停在上一帧，症状是「改了参数图却一动不动」（不是没生效，是画不出来了）。
        color: stripes[0]?.color || DEFAULT_BLOCK_COLOR,
        ink: textInk(stripes, x, yTop, w, st.blockH),
        beam: bms.map((b) => beamLabel(b, st.unit)).join(' + '),
        bwFromBeam: !!r.bwFromBeam,
        derived: band.side === 'dn' && r.dnDerived,
        suspect: !!r.raw?._suspect,
        // 标注交替上下，避免密排时首尾相撞（标准图正是这么排的）；错开分层时每层各有一行（见上）
        labelSide: rowIdx === 0 ? 'above' : 'below',
        labelY: band.laneLabelY[rowIdx][lane]
      }
      if (blk.mark) blk.markG = markGeom(blk, st)
      blocks.push(blk)
    }
    y += st.bandGap
  }
  y -= st.bandGap
  // 竖线收头是整张图一起的事（见 guideStrike）：两带的界标必须是同一套
  if (bands.some((b) => b.guideStrike)) for (const b of bands) b.guideY0 = b.rowY[0] - st.fontSize * 0.15
  if (bands.some((b) => b.guideStrikeDn)) for (const b of bands) b.guideY1 = b.blocksY1 + st.fontSize * 0.15

  // 图例 + 信标注记
  let legend = null, loY = null
  if (st.showLegend && plan.beams?.length) {
    y += st.fontSize * 1.8
    legend = layoutLegend(plan, st, y, innerW)
    y = legend.y1
  }
  // 这一行画的是信标/遥测通道（见 beaconNoteText），原先却按「有没有 LO」预留 ——
  // 于是绝大多数计划（有 LO、没信标）的图底白白空出一行，屏上与导出一起空。按画的东西预留。
  if (st.showLo && beaconNoteText(plan, st.unit)) { y += st.fontSize * 0.9; loY = y; y += st.fontSize * 1.3 }
  y += st.padBottom

  return { style: st, bands, blocks, legend, loY, width: st.width, height: Math.ceil(y), x2f, innerW, mhzPerPx }
}

// 波束自己没设色时的回落色（图例上没有它，只是「这条波束还没挑颜色」）。
// 注意：它不是「未归波束的块」的底色 —— 没归波束的块一片都不铺，见 layoutStripes。
export const DEFAULT_BLOCK_COLOR = '#5B8FD4'

/**
 * 块内各波束占的那一片（stripes）的几何。两类星画出来是两个样子，而这里只有一条路径：
 *   · 同频共用（常规转发器）—— 每个波束占满整条频带，几片横向完全重叠 → 各错开一层
 *     （块高等分），画出来就是从前那几条满宽色片，逐点不变；
 *   · 频分占用（HTS）—— 各波束按自己的带宽占一段（模型的 beamSegs 已算好频率），
 *     宽度 = 该段占频带的比例，互不重叠故都在第 0 层、满高；余下没分出去的那截【不铺色】，
 *     露出纸面 = 未分配（外框仍是整条转发器，故一眼看得出「120 里只分了 36」）。
 * 分层判据与整排那套重叠错层同源（pickLane）：重叠的往下错一层，不叠的留在原层。
 *
 * segs 为空（这条转发器没归任何波束）→ 不铺色，只剩外框。原先这里铺一片默认蓝当占位，读起来
 * 与「归了某个恰好是蓝色的波束」一模一样 —— 图上分不出「已分配」与「还没分」。空就画成空。
 */
function layoutStripes(segs, band, x, y, w, h) {
  const list = (segs || []).filter((g) => g?.beam)
  if (!list.length) return []
  // 频带宽度是把段的频率换算成像素的尺子；块宽 w 可能被 minBwBlockW 抬过（极窄块），
  // 故按【块的像素宽】等比例分，而不是回头去查 x2f —— 抬宽之后两者会差一点，段就贴不住块边。
  const span = Number.isFinite(band?.bw) && band.bw > 0 ? band.bw : null
  const cells = list.map((g) => {
    if (!span || g.full || g.f1 == null) return { g, x0: x, x1: x + w }
    // 探出频带的那一截钳回块内（越界由校验的 segOut 报出来）：画到别的转发器身上更难读
    const x0 = Math.min(x + w, Math.max(x, x + ((g.f1 - band.f1) / span) * w))
    const x1 = Math.min(x + w, Math.max(x, x + ((g.f2 - band.f1) / span) * w))
    // ★ 整段落在频带【外】的（波束钉的那段频率根本不在这条转发器里）不出片：钳完本就是零宽画不出
    //   东西，却照样占掉一层，把真正在里面的那几片压成半高 —— 看上去像「两个波束同频共用」，
    //   而实情是有一个不在这儿。校验的 segOut 会把它指出来，图上不必再画一条零宽的缝。
    const off = Number.isFinite(band.f2) && (g.f2 <= band.f1 + 1e-6 || g.f1 >= band.f2 - 1e-6)
    return { g, x0, x1: Math.max(x1, x0), off }
  }).filter((c) => !c.off)
  if (!cells.length) return []            // 几个波束全在别处 → 空框（外框仍是整条转发器）
  const lanes = []
  for (const c of cells) c.lane = pickLane(lanes, c.x0, c.x1, 0.01)
  const n = Math.max(1, lanes.length)
  return cells.map((c) => {
    // 逐层按累计边界取分界，避免 h/n 除不尽时末层与块底差半像素、露出一条缝
    const y0 = y + (h * c.lane) / n
    const y1 = y + (h * (c.lane + 1)) / n
    return {
      x: c.x0, y: y0, w: c.x1 - c.x0, h: y1 - y0,
      color: c.g.beam.color || DEFAULT_BLOCK_COLOR, beamId: c.g.beam.id, name: c.g.beam.name || ''
    }
  })
}

// 压在色片上的转发器编号一律黑字（与波束色无关）
const BLOCK_NO_INK = '#111'

/**
 * 编号那行字压没压在色片上 —— 只看字带（块中央那一小块）与各片有没有交叠，两种切法都管：
 * 同频共用是横着切（各片满宽）、频分是竖着切（各段满高）。
 *
 * 压在片上 → 黑字。返回 null = 字带下面压根没有色片（频分时那截未分配的留白正在中间）——
 * 此时字画在纸上，该取纸面的墨色（暗色主题下纸是深的，写死黑就没了），由调用方按主题给
 * （见 planBody / FpChart）。
 */
function textInk(stripes, x, y, w, h) {
  const t0 = y + h * 0.18, t1 = y + h * 0.82
  const l0 = x + w * 0.35, l1 = x + w * 0.65
  for (const s of stripes) {
    const dy = Math.min(t1, s.y + s.h) - Math.max(t0, s.y)
    const dx = Math.min(l1, s.x + s.w) - Math.max(l0, s.x)
    if (dy > 0 && dx > 0) return BLOCK_NO_INK
  }
  return null
}

// 块内编号的字号：随块宽收敛，窄块也不溢出；收敛到看不清就返回 null（不画）——
// 宽度既然要如实对应带宽，窄块就一定存在，画个 2px 的字只是噪点。屏上与导出共用这一个判据。
export function blockNoFs(b, fs) {
  if (!b?.no) return null
  const v = Math.min(fs * 1.05, b.w / Math.max(1.6, String(b.no).length * 0.62))
  return v >= fs * 0.45 ? v : null
}

// 文字宽度粗估：全角（中日韩标点与汉字）按 1 em、其余按 0.52 em。只用于图例的折行与项距，
// 不需要精确——SVG 里没有可测量的文本盒，宁可估宽一点也不要让条目叠在一起。
function textW(s, fs) {
  let w = 0
  for (const ch of String(s || '')) w += /[⺀-￯]/.test(ch) ? 1 : 0.52
  return w * fs
}

/**
 * 「波束/带宽」图例的几何。条目 = 颜色块 +「波束名：带宽」，带宽进标签后条目明显变长，
 * 故按可用宽度折行——排不下就换一行，而不是一路画到纸外面去。
 */
function layoutLegend(plan, st, y0, innerW) {
  const fs = st.fontSize
  const sq = fs * 1.05
  const lineH = fs * 1.6
  const gap = fs * 1.4          // 条目之间的留白
  const textGap = fs * 0.5      // 色块与文字之间
  const items = []
  let lx = st.padX, row = 0
  for (const bm of plan.beams) {
    const label = beamLabel(bm, st.unit)
    const w = sq * 1.6 + textGap + textW(label, fs * 0.92) + gap
    // 行首条目再宽也不换行（换了也放不下），末项的项距不计入越界判断
    if (lx > st.padX && lx + w - gap > st.padX + innerW) { row++; lx = st.padX }
    items.push({ id: bm.id, color: bm.color, label, x: lx, y: y0 + row * lineH, sq, textX: lx + sq * 1.6 + textGap })
    lx += w
  }
  return { items, y0, y1: y0 + (row + 1) * lineH, lineH, sq }
}

/**
 * 生成 SVG 字符串。scale 用于导出倍率——★ 按倍率重画（放大所有几何与字号），
 * 而不是给 SVG 加 viewBox 缩放：后者会让 non-scaling-stroke 把线钉成发丝。
 * viewBox 仍照 1:1 写上（identity，不改任何渲染），只为让导出的 SVG 到别处能整体缩放。
 */
export function toSvg(plan, styleIn = {}, scale = 1, fonts = null) {
  const st0 = { ...DEFAULT_STYLE, ...styleIn }
  const st = scaleStyle(st0, scale)     // 按倍率把所有长度量放大后重新排版
  const L = layout(plan, st)
  const T = THEMES[st0.theme] || THEMES.light
  const F = normFonts(fonts)
  const out = [svgOpen(L.width, L.height, F.latin, T)]
  out.push(...planBody(plan, L, st, T, scale, F))
  out.push('</svg>')
  return out.join('')
}

/**
 * 字体面。屏上与 PNG 用平台衬线栈（Times New Roman 打头，浏览器逐字形回落，汉字自己落到宋体）；
 * 矢量 PDF 由 fpExport 传进来两个【已在 jsPDF 里注册】的族名 { latin, cjk }。
 *
 * ★ 必须分面：PDF 的字体是按「资源」整体选用的，不像浏览器逐字形回落 —— 一串 "cjk, tnr, times"
 *   里 svg2pdf 只认第一个注册过的族，于是整张图（连 UPLINK 与频率数字）都被画成黑体。
 *   故西文一律 Times New Roman，只有含汉字的那几条（人自己录进去的名字）才换中文面。
 */
const normFonts = (f) => (typeof f === 'string'
  ? { latin: f, cjk: '' }
  : { latin: f?.latin || SERIF_STACK, cjk: f?.cjk || '' })
const CJK_RE = /[⺀-￯]/      // 汉字与中日韩标点 / 全角形（与 textW 用的是同一把尺子）
// 逐条文本挑面：给 <text> 用的 font-family 属性片段（没有汉字、或没给中文面时不写，照根节点的西文面走）
const face = (s, F) => (F?.cjk && CJK_RE.test(String(s)) ? ` font-family="${F.cjk}"` : '')

// ★ 不写 viewBox：这套图的缩放一律靠「按倍率重画几何」（toSvg 的 scale），加了 viewBox 就给了
//   「改 width 让它自己缩」这条路，而那条路会把 non-scaling-stroke 的线钉成发丝（lb-export-png-resolution）。
//   屏上要把图缩进框里的地方（合成预览）按框宽重排一遍，不动这里。
const svgOpen = (w, h, ff, T) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" font-family="${ff}">` +
  `<rect x="0" y="0" width="${w}" height="${h}" fill="${T.paper}"/>`

/**
 * 一份计划的全部落笔（频带 · 色块 · LO 箭头 · 图例 · 注记），坐标即 layout 的坐标。
 * 合成图把它整段塞进 <g transform="translate(0,dy)"> 里平移 —— 于是「屏上 / 单份导出 / 合成导出」
 * 三处画的是同一份笔画，不会各漂各的。
 * （箭头改自绘三角后不再有 <marker id>，合成时也就不必再给每段发一个 id 后缀 —— 见 loArrowGeom。）
 * F：字体面 { latin, cjk }（见 normFonts）。只有可能含汉字的那几条文本（编号 / LO 名 / 波束名 /
 * 信标编号，都是人自己录进去的）才逐条挑面，其余照根节点的西文面走。
 */
function planBody(plan, L, st, T, scale, F = null) {
  const fs = st.fontSize
  const out = []
  const sw = Math.max(1, 1 * scale)     // 基础线宽随倍率走

  if (L.empty) {
    out.push(`<text x="${L.width / 2}" y="${L.height / 2}" font-size="${fs}" fill="${T.dim}" text-anchor="middle">Frequency plan is empty — no transponders</text>`)
    return out
  }

  for (const band of L.bands) {
    // 频带标题
    out.push(`<text x="${st.padX - st.titleIndent}" y="${band.titleY + fs}" font-size="${fs * 1.15}" font-weight="bold" fill="${T.ink}">${band.title}</text>`)
    // 两端边界竖线（标准图的量程界标）
    if (st.showGuides) {
      for (const gx of [band.axisX0, band.axisX1]) {
        out.push(`<line x1="${gx}" y1="${band.guideY0}" x2="${gx}" y2="${band.guideY1}" stroke="${T.guide}" stroke-width="${sw * 2.2}"/>`)
      }
      if (band.endLabelsFit) {
        out.push(`<text x="${band.axisX0}" y="${band.endLabelY}" font-size="${fs * 0.86}" fill="${T.dim}" text-anchor="middle">${fmtFreq(band.guideExt.dataMin, st.unit)}</text>`)
        out.push(`<text x="${band.axisX1}" y="${band.endLabelY}" font-size="${fs * 0.86}" fill="${T.dim}" text-anchor="middle">${fmtFreq(band.guideExt.dataMax, st.unit)}</text>`)
      }
    }
    // 基线（在断口处断开）与断口的「…」
    for (const [x0, x1] of band.baseSegs) {
      out.push(`<line x1="${x0.toFixed(2)}" y1="${band.baselineY}" x2="${x1.toFixed(2)}" y2="${band.baselineY}" stroke="${T.line}" stroke-width="${sw * 1.6}"/>`)
    }
    for (const br of band.breaks) {
      for (const cx of br.dots) out.push(`<circle cx="${cx.toFixed(2)}" cy="${br.y.toFixed(2)}" r="${br.dotR.toFixed(2)}" fill="${T.line}"/>`)
    }
    // 极化标签
    band.pols.forEach((p, i) => {
      out.push(`<text x="${st.padX - st.polIndent}" y="${band.rowMidY[i] + fs * 0.36}" font-size="${fs * 1.05}" fill="${T.ink}" text-anchor="end">${esc(p)}</text>`)
    })
  }

  // 色块 / 箭头 + 编号 + 频率标注
  for (const b of L.blocks) {
    if (b.mark) {
      // 标记类载波：一根从频率轴上立起来的谱线（见 markGeom）。编号不压在上面 —— 一根 9px 宽的
      // 箭头写不下，名字由图底那行注记认领（beaconNoteText）。
      const g = b.markG
      const ink = b.suspect ? T.suspect : T.ink
      out.push(`<line x1="${g.x}" y1="${g.y0}" x2="${g.x}" y2="${g.lineY1}" stroke="${ink}" stroke-width="${(sw * 1.5).toFixed(2)}"/>`)
      out.push(`<path d="${g.head}" fill="${ink}"/>`)
    } else {
      const stroke = b.suspect ? T.suspect : T.blockStroke
      const dash = b.derived ? ` stroke-dasharray="${sw * 3} ${sw * 2}"` : ''
      // 先无描边地铺色片，再在整块上压一圈描边 —— 逐片带描边的话片与片之间会多出两道横线，
      // 一个转发器被切成看似两个块。
      for (const sp of b.stripes) {
        out.push(`<rect x="${sp.x.toFixed(2)}" y="${sp.y.toFixed(2)}" width="${sp.w.toFixed(2)}" height="${(sp.h + 0.3).toFixed(2)}" fill="${sp.color}" stroke="none"/>`)
      }
      out.push(`<rect x="${b.x.toFixed(2)}" y="${b.y.toFixed(2)}" width="${b.w.toFixed(2)}" height="${b.h.toFixed(2)}" fill="none" stroke="${stroke}" stroke-width="${(b.suspect ? sw * 2 : sw * 1.4).toFixed(2)}"${dash}/>`)
      const maxFs = blockNoFs(b, fs)
      if (maxFs) {
        // ink 为 null = 字压在那截未分配的留白上（频分占用时的常态）→ 取纸面的墨色
        out.push(`<text x="${(b.x + b.w / 2).toFixed(2)}" y="${(b.y + b.h / 2 + maxFs * 0.35).toFixed(2)}" font-size="${maxFs.toFixed(2)}" fill="${b.ink || T.ink}" text-anchor="middle"${face(b.no, F)}>${esc(b.no)}</text>`)
      }
    }
    if (st.showFreqLabels && Number.isFinite(b.fc)) {
      const ty = b.labelSide === 'above' ? b.labelY + fs * 0.9 : b.labelY + fs * 0.95
      out.push(`<text x="${(b.x + b.w / 2).toFixed(2)}" y="${ty.toFixed(2)}" font-size="${(fs * 0.86).toFixed(2)}" fill="${T.dim}" text-anchor="middle">${fmtFreq(b.fc, st.unit)}</text>`)
    }
  }

  // LO 变频箭头：从上行带底部指向下行带顶部（几何取 loArrowGeom，与屏上同源）
  const arrow = st.showLo && plan.los?.length ? loArrowGeom(L, st) : null
  if (arrow) {
    out.push(`<line x1="${arrow.x}" y1="${arrow.y0}" x2="${arrow.x}" y2="${arrow.lineY1}" stroke="${T.line}" stroke-width="${sw * 1.6}"/>`)
    out.push(`<path d="${arrow.head}" fill="${T.line}"/>`)
    out.push(`<text x="${arrow.textX}" y="${arrow.textY}" font-size="${(fs * 0.95).toFixed(2)}" fill="${T.ink}"${face(loNoteText(plan, st.unit), F)}>${esc(loNoteText(plan, st.unit))}</text>`)
  }

  // 波束/带宽 图例（几何来自 layout，与屏上那份同源）
  if (L.legend) {
    for (const it of L.legend.items) {
      out.push(`<rect x="${it.x.toFixed(2)}" y="${it.y.toFixed(2)}" width="${(it.sq * 1.6).toFixed(2)}" height="${it.sq.toFixed(2)}" fill="${it.color || '#5B8FD4'}" stroke="${T.blockStroke}" stroke-width="${sw}"/>`)
      out.push(`<text x="${it.textX.toFixed(2)}" y="${(it.y + it.sq * 0.82).toFixed(2)}" font-size="${(fs * 0.92).toFixed(2)}" fill="${T.ink}"${face(it.label, F)}>${esc(it.label)}</text>`)
    }
  }

  // 信标 / 遥测 一行注记（行高在 layout 里按同一个 beaconNoteText 预留）
  if (L.loY != null) {
    const s = beaconNoteText(plan, st.unit)
    if (s) out.push(`<text x="${st.padX}" y="${L.loY + fs}" font-size="${(fs * 0.9).toFixed(2)}" fill="${T.dim}"${face(s, F)}>${esc(s)}</text>`)
  }

  return out
}

// ---- 合成：多份计划（多半是同一颗星的 C / Ku / Ka 三份）→ 一张完整的频率计划图 ----
//
// 一颗星的频率计划本就是分频段做的（一份 C、一份 Ku、一份 Ka），而对外给的那张「完整频率计划」
// （Intelsat 20 那种）是把各频段自上而下叠在一张纸上。故合成不是把通道并进一份计划，而是
// 【每份计划各占一段，各带各的上下行两条频带与图例】——并进去的话，C 段的 6 GHz 与 Ka 的 30 GHz
// 会被同一根轴拉平，块挤成线、极化行也串了（C 的 H 与 Ka 的 H 不是一回事）。
//
// 比例尺：默认各段独立（各自铺满画布，与单份出图完全一致，一段一段读最清楚）；
// sharedScale 打开则全图一把尺子（同带宽跨频段同宽，用于横向比对各频段的转发器有多宽）。

// 段头文字：计划名为主，频段作前缀 —— 名字里已经写了频段的（多数计划就叫「XX Ku 频率计划」）不重复写。
// 「-Band」是图上文字（系统给的那部分一律英文，见文件头）；计划名照人录的原样，中文就是中文。
function sectionTitle(plan) {
  const name = plan?.name || 'Frequency Plan'
  const band = String(plan?.band || '').trim()
  return band && !name.includes(band) ? `${band}-Band · ${name}` : name
}

/**
 * 合成版式几何。sections[i].dy 是该段的平移量，段内坐标仍是各自 layout() 的坐标。
 */
export function layoutMulti(plans, styleIn = {}) {
  const st = { ...DEFAULT_STYLE, ...styleIn }
  const list = (plans || []).filter(Boolean)
  const fs = st.fontSize
  if (!list.length) return { style: st, sections: [], titleY: null, width: st.width, height: Math.ceil(fs * 8), empty: true }

  // 统一比例尺：先各自排一遍取【最粗】的那把尺，再按它重排 —— 取最大值，否则量程最宽的那一段画到纸外面去
  let force = null
  if (st.sharedScale) {
    const each = list.map((p) => layout(p, st).mhzPerPx).filter((v) => Number.isFinite(v) && v > 0)
    if (each.length) force = Math.max(...each)
  }

  const sections = []
  let y = 0
  let titleY = null
  if (st.title) { titleY = y + fs * 1.45; y += fs * 2.5 }
  for (let i = 0; i < list.length; i++) {
    const plan = list[i]
    const L = layout(plan, { ...st, forceMhzPerPx: force })
    // 段与段之间一条细分隔线（首段之前不画：那里是总标题或纸边）
    const ruleY = i ? y + fs * 0.25 : null
    const head = st.showSectionTitles ? { y: y + fs * 1.35, text: sectionTitle(plan) } : null
    if (head) y += fs * 1.9
    sections.push({ id: plan.id || `s${i}`, plan, L, dy: y, head, ruleY, title: sectionTitle(plan) })
    y += L.height
  }
  return { style: st, sections, titleY, width: st.width, height: Math.ceil(y), mhzPerPx: force, empty: false }
}

/**
 * 合成图 → SVG 字符串。参数与 toSvg 同（scale 为导出倍率，按倍率重画）。
 */
export function toSvgMulti(plans, styleIn = {}, scale = 1, fonts = null) {
  const st0 = { ...DEFAULT_STYLE, ...styleIn }
  const st = scaleStyle(st0, scale)
  const M = layoutMulti(plans, st)
  const T = THEMES[st0.theme] || THEMES.light
  const fs = st.fontSize
  const sw = Math.max(1, 1 * scale)
  const F = normFonts(fonts)
  const out = [svgOpen(M.width, M.height, F.latin, T)]

  if (M.empty) {
    out.push(`<text x="${M.width / 2}" y="${M.height / 2}" font-size="${fs}" fill="${T.dim}" text-anchor="middle">No frequency plan selected</text></svg>`)
    return out.join('')
  }

  if (M.titleY != null) {
    out.push(`<text x="${(M.width / 2).toFixed(2)}" y="${M.titleY.toFixed(2)}" font-size="${(fs * 1.5).toFixed(2)}" font-weight="bold" fill="${T.ink}" text-anchor="middle"${face(st.title, F)}>${esc(st.title)}</text>`)
  }
  for (const s of M.sections) {
    if (s.ruleY != null) {
      out.push(`<line x1="${(st.padX - st.titleIndent).toFixed(2)}" y1="${s.ruleY.toFixed(2)}" x2="${(M.width - st.padRight).toFixed(2)}" y2="${s.ruleY.toFixed(2)}" stroke="${T.guide}" stroke-width="${sw}"/>`)
    }
    if (s.head) {
      out.push(`<text x="${(st.padX - st.titleIndent).toFixed(2)}" y="${s.head.y.toFixed(2)}" font-size="${(fs * 1.2).toFixed(2)}" font-weight="bold" fill="${T.ink}"${face(s.head.text, F)}>${esc(s.head.text)}</text>`)
    }
    // 段内坐标不动，整段平移 —— 与单份导出画的是同一份笔画
    out.push(`<g transform="translate(0,${s.dy.toFixed(2)})">`)
    out.push(...planBody(s.plan, s.L, st, T, scale, F))
    out.push('</g>')
  }
  out.push('</svg>')
  return out.join('')
}

// 命中测试：屏上点击 (x,y) → 落在哪个块（编辑器选中用）
export function hitTest(layoutRes, x, y) {
  for (const b of layoutRes.blocks) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b
  }
  return null
}

// SVG → PNG DataURL（导出用，倍率已在 toSvg 里按几何重画，这里只负责栅格化）
export function svgToPngDataUrl(svgText, width, height) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      try {
        const cv = document.createElement('canvas')
        cv.width = width; cv.height = height
        const g = cv.getContext('2d')
        g.fillStyle = '#fff'; g.fillRect(0, 0, width, height)
        g.drawImage(img, 0, 0, width, height)
        URL.revokeObjectURL(url)
        resolve(cv.toDataURL('image/png'))
      } catch (e) { URL.revokeObjectURL(url); reject(e) }
    }
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error('SVG 栅格化失败')) }
    img.src = url
  })
}
