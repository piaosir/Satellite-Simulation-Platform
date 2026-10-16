// 空间态势报告的图表渲染：spec → SVG 字符串（八型：bar / hbar / stack / line / hist / strip / heat / scatter）。
//
// 纯函数、零 DOM：屏上（SsaChart 把串挂进 DOM）与导出（chartSvg → svgToPngDataUrl → Word）走的是
// 同一份 spec、同一个函数 —— 报告里的图与屏上看到的必然是同一张。不读 document、不取当前时间、
// 不掷随机数：同一份入参两次渲染必须逐字节相同（单测钉死这一条）。
//
// ★ 不写 viewBox。这套图的缩放靠「按 width 重排几何」，加了 viewBox 就给了「改 width 让它自己缩」
//   这条路，而那条路会把 non-scaling-stroke 的线钉成发丝（memory「两张图出图分辨率与字体」，
//   与 freqPlanRender.svgOpen 同一条口径）。要小图就用小 width 再调一次。
//
// ★ 颜色与字体分两档：
//   print  —— 写死浅色底（#fff 底 / #222 墨 / #bbb 网格）与十六进制色；字体逐条 <text> 写死。
//             导出的 SVG 离开页面后没有祖先可继承，不写死就掉回栅格化器的默认字体（这个坑踩过）。
//   screen —— 颜色一律 var(--…)。但本模块读不到 document（纯函数），拿不到「此刻是亮是暗」，
//             故把自家色槽连同暗色覆写一并塞进 SVG 内联 <style>：选择器钉在 svg.ssa-fig 上，
//             同页开 N 张图也只是 N 份一模一样的规则，不带 id、不外溢到别的元素。
//             底不铺色（透明），跟着所在面板的底走。
//
// ★ 色板不是凭感觉挑的（dataviz 校验器逐项跑过）：
//   分类三槽直接复用 lbPlotTheme 那份（曲线与「普通/强调」两色都在它的相邻档里过线：
//   亮 worst adjacent CVD ΔE 19.7、暗 21.0）。三槽同时上图时槽①与槽③在红绿色盲下 ΔE 仅 1.9，
//   故曲线额外带一道线型编码（实线 / 长划 / 点划），不靠颜色单独承载身份。
//   堆叠四档明度与密度格的单色阶另跑 ordinal / sequential 档：
//     堆叠 亮 #0f4571…#7fb2e0 最浅端 2.25:1、暗 #1f5687…#a2caea 最暗端 2.23:1，均过 2:1；
//     密度格是 sequential（最浅一档表示「接近零」，按 dataviz 的口径允许退向底色，
//     故它只守单调 / 步距 / 单色相三项，不守 2:1）。改色务必重跑校验器。
//
// 文字一律穿墨色（--text / --text-muted），不穿数据色：淡色相当文字在底色上读不出来。
// 图上没有任何解释性小字 —— 判据与口径在报告正文的「口径与判据」一节里（仓库 CLAUDE.md）。

import { niceScale } from './lbPlotScale.js'
import { SERIES_LIGHT, SERIES_DARK } from './lbPlotTheme.js'

// —— 色板 ——

// 堆叠段：同一色相四档明度（dataviz ordinal 档全过）
const RAMP4_LIGHT = ['#0f4571', '#15619b', '#3f87c2', '#7fb2e0']
const RAMP4_DARK = ['#1f5687', '#3d82ba', '#6aa6da', '#a2caea']

// 密度格：单色相七档顺序色阶，低→高。亮档 浅→深，暗档 深→浅（两边都是「越远离底色 = 越大」）
const SEQ_LIGHT = ['#dce9f9', '#b9d3f2', '#93b9e8', '#6b9ddb', '#4680c6', '#2a63a8', '#12447e']
const SEQ_DARK = ['#153454', '#1c4a77', '#25619b', '#3179bd', '#4c94d2', '#74b0e0', '#a5cdec']

const PRINT_FONTS = { latin: 'Times New Roman', cjkBody: '宋体' }

// —— 纸面档（theme: 'paper'，样式规范 2026-10-15 §F）——
// 屏上纸面与导出 Word 用【同一张图】：同一 spec、同一函数、同一物理尺寸（mm），只差栅格倍率。
// 图内文字一律 8 pt Arial + 等线（不随导出对话框的报告字体，§F.2）；线宽按 pt 给（轴 0.5 pt、数据线 1.25 pt）；
// 不画背景网格、柱方端（§F.2 / R5 / R11）。
// 对象类型四色全篇固定、跟类型码走不跟段序（§F.4，dataviz 校验器两两全过：最差色盲 ΔE 14.9）：
export const TYPE_COLOR = { PAY: '#15619B', 'R/B': '#D8960E', DEB: '#B8333D', UNK: '#B7B7B7' }
// 不属任何一类的单序列（发射次数、在轨对象数）穿石板墨：颜色跟实体走，混合量不借任何一类的色
const SLATE = '#4A5560'
// 热图顺序色带：ColorBrewer YlGnBu-9 的第 3–9 级（ESA 报告实测同一条色带；第 1–2 级对白不足 1.3:1 舍去）
const SEQ_PAPER = ['#C7E9B4', '#7FCDBB', '#41B6C4', '#1D91C0', '#225EA8', '#253494', '#081D58']
// 热图分级界：1-2-5 序列的整数界（每级上界），末级开口（§F2.5）
const HEAT_BREAKS = [1, 5, 20, 50, 200, 500, Infinity]
const PAPER_FONT = "Arial, DengXian, '等线', sans-serif"
const PT = 96 / 72          // 1 pt = 4/3 px（96 dpi）
const MM = 96 / 25.4        // 1 mm ≈ 3.78 px

// 屏上色槽定义。放进 SVG 内联 <style>：本模块拿不到当前主题，只能把两套值都写进去让 CSS 去挑。
// 选择器只认 svg.ssa-fig，重复 N 份也无副作用；:root[data-theme="dark"] 与 global.css 同型。
const SCREEN_STYLE = (() => {
  const vars = (ser, r4, sq) => [
    ser.map((c, i) => `--ssa-s${i + 1}:${c}`).join(';'),
    r4.map((c, i) => `--ssa-r${i + 1}:${c}`).join(';'),
    sq.map((c, i) => `--ssa-q${i + 1}:${c}`).join(';')
  ].join(';')
  return '<style>svg.ssa-fig{' + vars(SERIES_LIGHT, RAMP4_LIGHT, SEQ_LIGHT) + '}'
    + ':root[data-theme="dark"] svg.ssa-fig{' + vars(SERIES_DARK, RAMP4_DARK, SEQ_DARK) + '}</style>'
})()

// 字族名除非是干净的西文标识符，一律自己带引号：SVG 的 font-family 按 CSS 值解析，
// Times New Roman 不加引号会被当成三个族名、「宋体」这类非 ASCII 名在严格解析器下也不保险，
// 整串作废就掉回栅格化器的默认字体
const quoteFam = (s) => {
  const v = String(s == null ? '' : s).trim()
  if (!v) return ''
  if (/^['"]/.test(v) || /^[A-Za-z][A-Za-z0-9-]*$/.test(v)) return v
  return "'" + v.replace(/'/g, '') + "'"
}

function palette(theme, fonts, scale) {
  if (theme === 'paper') {
    const k = scale > 0 ? scale : 1
    return {
      print: true, paperTheme: true, ff: PAPER_FONT,
      paper: '#FFFFFF', ink: '#222222', dim: '#595959', grid: '#D9D9D9', axis: '#595959', band: '#ECECEC',
      series: [SLATE, TYPE_COLOR.PAY, TYPE_COLOR.DEB, TYPE_COLOR['R/B']],
      ramp4: [TYPE_COLOR.PAY, TYPE_COLOR['R/B'], TYPE_COLOR.DEB, TYPE_COLOR.UNK], seq: SEQ_PAPER.slice(),
      lw: 0.5 * PT * k, dataLw: 1.25 * PT * k, noGrid: true, square: true
    }
  }
  if (theme === 'print') {
    const f = fonts || {}
    const ff = [quoteFam(f.latin || PRINT_FONTS.latin), quoteFam(f.cjkBody || PRINT_FONTS.cjkBody)].filter(Boolean).join(', ')
    return {
      print: true, ff,
      paper: '#ffffff', ink: '#222222', dim: '#555555', grid: '#bbbbbb', axis: '#888888',
      band: '#eceff3', series: SERIES_LIGHT.slice(), ramp4: RAMP4_LIGHT.slice(), seq: SEQ_LIGHT.slice(), lw: 1
    }
  }
  return {
    print: false, ff: 'var(--font-ui)',
    paper: '', ink: 'var(--text)', dim: 'var(--text-muted)', grid: 'var(--border)', axis: 'var(--border-strong)',
    band: 'var(--surface-2)',
    series: ['var(--ssa-s1)', 'var(--ssa-s2)', 'var(--ssa-s3)'],
    ramp4: ['var(--ssa-r1)', 'var(--ssa-r2)', 'var(--ssa-r3)', 'var(--ssa-r4)'],
    seq: ['var(--ssa-q1)', 'var(--ssa-q2)', 'var(--ssa-q3)', 'var(--ssa-q4)', 'var(--ssa-q5)', 'var(--ssa-q6)', 'var(--ssa-q7)'], lw: 1
  }
}

// —— 基本件 ——

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// 坐标一律两位小数：再多的位数只是把 SVG 撑大，栅格化后看不出差别
const n2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0)
const num = (v) => (Number.isFinite(+v) ? +v : 0)
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
// 极值走循环不走 Math.min(...arr)：散点动辄上万个，展开成实参会顶爆调用栈
function minOf(arr, get) { let m = Infinity; for (const a of arr) { const v = get(a); if (v < m) m = v } return m === Infinity ? 0 : m }
function maxOf(arr, get) { let m = -Infinity; for (const a of arr) { const v = get(a); if (v > m) m = v } return m === -Infinity ? 1 : m }

// 千分位。不走 toLocaleString —— 那东西跟运行环境的区域设置走，同一份入参在两台机器上出两种串，
// 报告的字节复现就没了
// ★ 2026-10-15 起分组用 U+2009 细空（SI / GB 3101：不插逗号），负号用 U+2212（样式规范 §E.3）。
//   四位数习惯不分：|v| ≥ 10000 才分；force = 同一条轴上有 ≥ 10000 的刻度时，≥ 1000 的一并分（全轴一致）。
const THIN = '\u2009'
function grp(s, force) {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(String(s))
  if (!m) return String(s)
  const n = m[2].length
  const body = (n >= 5 || (force && n >= 4)) ? m[2].replace(/\B(?=(\d{3})+(?!\d))/g, THIN) : m[2]
  return (m[1] ? '\u2212' : '') + body + (m[3] || '')
}
function fmtStep(v, step) {
  if (!Number.isFinite(v)) return ''
  const s = Math.abs(step || 1)
  const dec = s >= 1 ? 0 : s >= 0.1 ? 1 : s >= 0.01 ? 2 : 3
  const t = v.toFixed(dec)
  return t === '-0' ? '0' : t
}
const fmtInt = (v) => grp(String(Math.round(num(v))))

// 汉字与全角形按一个字身宽算，西文按经验宽度 —— 这把尺只用来定边距与截断，不必精确，
// 但必须与「哪些标签放得下」的判断同源，否则量出来能放下、画出来压在一起
const CJK_RE = /[⺀-￯]/      // 与 freqPlanRender 的 CJK_RE 同一把尺子
function textW(s, fs) {
  let w = 0
  for (const ch of String(s == null ? '' : s)) {
    if (CJK_RE.test(ch)) w += 1
    else if (/[ .,:;'!|\-]/.test(ch)) w += 0.3
    else if (/[A-Z%]/.test(ch)) w += 0.66
    else w += 0.54
  }
  return w * fs
}
function ellipsize(s, fs, maxW) {
  const str = String(s == null ? '' : s)
  if (maxW <= 0) return { s: '', cut: !!str }
  if (textW(str, fs) <= maxW) return { s: str, cut: false }
  let out = ''
  for (const ch of str) {
    if (textW(out + ch + '…', fs) > maxW) break
    out += ch
  }
  return { s: out + '…', cut: true }
}

/**
 * 一条 <text>。print 档逐条写 font-family（离开页面没有祖先可继承），screen 档同样写上
 * var(--font-ui)：两档走同一条代码路径，少一个「只有导出才露馅」的分叉。
 * full 非空时挂一个 <title> 子元素（截断标签的全名；SVG 里的悬停提示就是它，不占版面）。
 */
function T(P, x, y, s, o) {
  const a = o || {}
  // 纸面档全图同一字号（样式规范 §F.2）：版面计算仍按各处的倍率留空，落笔一律 P.fsText
  let at = ` x="${n2(x)}" y="${n2(y)}" font-size="${n2(P.fsText || a.fs)}" fill="${a.fill || P.ink}" font-family="${P.ff}"`
  if (a.anchor) at += ` text-anchor="${a.anchor}"`
  if (a.weight) at += ` font-weight="${a.weight}"`
  if (a.rotate) at += ` transform="rotate(${n2(a.rotate)} ${n2(x)} ${n2(y)})"`
  if (a.opacity != null) at += ` opacity="${n2(a.opacity)}"`
  const body = esc(s) + (a.full ? `<title>${esc(a.full)}</title>` : '')
  return `<text${at}>${body}</text>`
}
const line = (x1, y1, x2, y2, stroke, w, dash) =>
  `<line x1="${n2(x1)}" y1="${n2(y1)}" x2="${n2(x2)}" y2="${n2(y2)}" stroke="${stroke}" stroke-width="${n2(w || 1)}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
const rect = (x, y, w, h, fill, extra) =>
  `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(Math.max(0, w))}" height="${n2(Math.max(0, h))}" fill="${fill}"${extra || ''}/>`

// 圆角数据端：条形只有远离基线的那一端收圆角，贴基线的一端是方的（dataviz 的条形规格）。
// dir: 'up' 竖条向上长 / 'right' 横条向右长。半径随字号走，条太短/太窄时自动退成方端。
function barPath(x, y, w, h, r, dir) {
  const W = Math.max(0, w), H = Math.max(0, h)
  if (W <= 0 || H <= 0) return ''
  if (dir === 'right') {
    const rr = Math.min(r, H / 2, W)
    if (rr <= 0.4) return `<path d="M${n2(x)},${n2(y)} h${n2(W)} v${n2(H)} h${n2(-W)} Z"`
    return `<path d="M${n2(x)},${n2(y)} h${n2(W - rr)} a${n2(rr)},${n2(rr)} 0 0 1 ${n2(rr)},${n2(rr)} v${n2(H - 2 * rr)} a${n2(rr)},${n2(rr)} 0 0 1 ${n2(-rr)},${n2(rr)} h${n2(-(W - rr))} Z"`
  }
  const rr = Math.min(r, W / 2, H)
  if (rr <= 0.4) return `<path d="M${n2(x)},${n2(y)} h${n2(W)} v${n2(H)} h${n2(-W)} Z"`
  return `<path d="M${n2(x)},${n2(y + H)} v${n2(-(H - rr))} a${n2(rr)},${n2(rr)} 0 0 1 ${n2(rr)},${n2(-rr)} h${n2(W - 2 * rr)} a${n2(rr)},${n2(rr)} 0 0 1 ${n2(rr)},${n2(rr)} v${n2(H - rr)} Z"`
}
const bar = (x, y, w, h, r, dir, fill) => {
  const d = barPath(x, y, w, h, r, dir)
  return d ? d + ` fill="${fill}"/>` : ''
}

// 系列色：纸面档跟实体走（series.key = 类型码 → TYPE_COLOR；无 key 的混合量 → 石板墨），其余两档按序号取槽
function serColor(P, se, i) {
  if (P.paperTheme) return (se && se.key && TYPE_COLOR[se.key]) || (i === 0 ? SLATE : P.series[i % P.series.length])
  return P.series[i % P.series.length]
}

// —— 坐标轴 ——

// 纵轴（计数轴）：水平网格线 + 左侧刻度数字 + 基线。网格是发丝实线，退到数据后面（不画虚线）。
function yAxisParts(P, fr, sc, fs, yLabel) {
  const out = []
  const map = (v) => fr.y1 - ((v - sc.min) / ((sc.max - sc.min) || 1)) * fr.h
  const force = sc.ticks.some((t) => Math.abs(t) >= 10000)
  for (const t of sc.ticks) {
    const y = map(t)
    if (P.noGrid) out.push(line(fr.x0 - fs * 0.25, y, fr.x0, y, P.axis, P.lw))   // 外向刻度 2 pt
    else out.push(line(fr.x0, y, fr.x1, y, P.grid, P.lw))
    out.push(T(P, fr.x0 - fs * 0.45, y + fs * 0.32, grp(fmtStep(t, sc.step), force), { fs: fs * 0.9, fill: P.dim, anchor: 'end' }))
  }
  if (P.noGrid) out.push(line(fr.x0, fr.y0, fr.x0, fr.y1, P.axis, P.lw))
  out.push(line(fr.x0, fr.y1, fr.x1, fr.y1, P.axis, P.lw))
  if (yLabel) {
    const x = fr.x0 - fs * 0.45 - sc.digitW - fs * 0.55
    out.push(T(P, x, (fr.y0 + fr.y1) / 2, yLabel, { fs, fill: P.dim, anchor: 'middle', rotate: -90 }))
  }
  return out
}
// 纵轴左边距：刻度数字最宽的那条 + 轴名
function yAxisMetrics(sc, fs, yLabel) {
  let w = 0
  const force = sc.ticks.some((t) => Math.abs(t) >= 10000)
  for (const t of sc.ticks) w = Math.max(w, textW(grp(fmtStep(t, sc.step), force), fs * 0.9))
  sc.digitW = w
  return fs * 0.6 + w + fs * 0.45 + (yLabel ? fs * 1.35 : 0)
}
// 整数刻度：计数轴上 1/2/5 取整在最大值很小时会给出 0.2 / 0.5 的步长，「颗数」轴上于是印着 0.5 颗
// （卫星组、GEO 筛选这类小样本报告必现）。步长不足 1 时改为逐个整数。
function intScale(lo, hi) {
  const a = Math.floor(lo), b = Math.max(a + 1, Math.ceil(hi))
  const ticks = []
  for (let v = a; v <= b; v++) ticks.push(v)
  return { min: a, max: b, step: 1, ticks }
}
// 计数轴恒从 0 起：条形的长度就是值本身，截断基线会把 3 倍差画成 10 倍差
function countScale(maxV, rows) {
  const hi = Math.max(0, num(maxV))
  let s = niceScale(0, hi > 0 ? hi : 1, rows)
  if (s.step < 1) s = intScale(0, hi)
  s.min = 0
  s.ticks = s.ticks.filter((t) => t >= 0)
  if (!s.ticks.length) s.ticks = [0]
  return s
}
// 数值轴（可为负、可不含 0）：line / hist / strip / scatter 的自变量轴与 line 的因变量轴。
// intOnly：数据全是整数（计数序列）时不出小数刻度。
// 全零 / 常数且要求含 0 的序列：从 0 往上撑开，不为了「居中」去印负刻度（逐年陨落在小范围筛选下全零）。
function valueScale(lo, hi, cnt, zeroBase, intOnly) {
  let a = num(lo), b = num(hi)
  if (!(b > a)) {
    if (zeroBase && a >= 0) { b = a > 0 ? a * 2 : 1; a = 0 } else { const d = Math.abs(a) > 1 ? Math.abs(a) * 0.05 : 0.5; a -= d; b += d }
  }
  if (zeroBase && a >= 0 && a < (b - a)) a = 0
  const s = niceScale(a, b, cnt)
  return (intOnly && s.step < 1) ? intScale(a, b) : s
}

// 图例：色块 + 标签（标签穿墨色，身份由旁边的色块承载）。返回 { parts, h }
function legendParts(P, items, x, y, maxW, fs) {
  const parts = []
  if (P.paperTheme) return legendPaper(P, items, x, y, maxW, fs)
  const sq = fs * 0.78
  const rowH = fs * 1.5
  let cx = x, cy = y + sq, row = 0
  for (const it of items) {
    const lab = ellipsize(it.label, fs * 0.92, maxW - sq * 1.6 - fs * 0.5)
    const w = sq * 1.6 + fs * 0.4 + textW(lab.s, fs * 0.92) + fs * 1.1
    if (cx > x && cx + w > x + maxW) { cx = x; row++; cy += rowH }
    if (it.dash !== undefined) {
      parts.push(line(cx, cy - sq * 0.4, cx + sq * 1.6, cy - sq * 0.4, it.color, Math.max(2, fs * 0.18), it.dash || ''))
    } else {
      parts.push(rect(cx, cy - sq, sq * 1.6, sq, it.color))
    }
    parts.push(T(P, cx + sq * 1.6 + fs * 0.4, cy - sq * 0.12, lab.s, { fs: fs * 0.92, fill: P.dim, full: lab.cut ? it.label : '' }))
    cx += w
  }
  return { parts, h: (row + 1) * rowH }
}
// 纸面档图例：一行左对齐（放不下才折行），色块 6 pt 见方 / 线段 12 pt，字 8 pt 次级墨
function legendPaper(P, items, x, y, maxW, fs) {
  const parts = []
  const sw = fs * 0.75, ln = fs * 1.5, rowH = fs * 1.5
  let cx = x, cy = y + fs, row = 0
  for (const it of items) {
    const key = it.dash !== undefined ? ln : sw
    const w = key + fs * 0.4 + textW(it.label, fs) + fs * 1.2
    if (cx > x && cx + w > x + maxW) { cx = x; row++; cy += rowH }
    if (it.dash !== undefined) parts.push(line(cx, cy - fs * 0.32, cx + ln, cy - fs * 0.32, it.color, P.dataLw || 2, it.dash || ''))
    else parts.push(rect(cx, cy - fs * 0.32 - sw / 2, sw, sw, it.color))
    parts.push(T(P, cx + key + fs * 0.4, cy, it.label, { fs, fill: P.dim }))
    cx += w
  }
  return { parts, h: (row + 1) * rowH }
}
function legendHeightPaper(items, maxW, fs) {
  const sw = fs * 0.75, ln = fs * 1.5
  let cx = 0, row = 0
  for (const it of items) {
    const w = (it.dash !== undefined ? ln : sw) + fs * 0.4 + textW(it.label, fs) + fs * 1.2
    if (cx > 0 && cx + w > maxW) { cx = 0; row++ }
    cx += w
  }
  return (row + 1) * fs * 1.5
}
function legendHeight(items, maxW, fs, P) {
  if (P && P.paperTheme) return legendHeightPaper(items, maxW, fs)
  const sq = fs * 0.78
  let cx = 0, row = 0
  for (const it of items) {
    const lab = ellipsize(it.label, fs * 0.92, maxW - sq * 1.6 - fs * 0.5)
    const w = sq * 1.6 + fs * 0.4 + textW(lab.s, fs * 0.92) + fs * 1.1
    if (cx > 0 && cx + w > maxW) { cx = 0; row++ }
    cx += w
  }
  return (row + 1) * fs * 1.5
}

// 轴名行：占 1.9 个字身高、基线离图底 0.55 个字身。给够这个数刻度数字与轴名之间才有一口气 ——
// 原先给 1.5 / 0.35，分类标签与轴名只隔半个字身，「GEO 静止」与「轨道区制」挤成一坨（实测）
const AXL_H = 1.9
const AXL_Y = 0.55
// 图例行的可用宽度（占整幅宽的几成）。量高度与真落笔必须用同一个数，见 drawBar
const LEG_W = 0.78

const EMPTY_TXT = { zh: '暂无数据。', en: 'No data.' }
const SAMPLED_TXT = { zh: '抽样', en: 'Sampled' }

// —— 八型 ——
// 每个 draw* 收 (spec, P, L)（L = { fs, width, height, lang }），回 { h, parts }。
// 画完再由 chartSvg 套壳 —— 壳里不含任何类型相关的东西。

// ① 分类竖条。多序列并排成组；分类标签放不下就斜排，还放不下就隔个显示
function drawBar(spec, P, L) {
  const fs = L.fs, W = L.width
  const cats = Array.isArray(spec.cats) ? spec.cats : []
  const series = (Array.isArray(spec.series) ? spec.series : []).filter((s) => s && Array.isArray(s.data))
  const nc = cats.length, ns = Math.max(1, series.length)
  let maxV = 0
  for (const s of series) for (const v of s.data) maxV = Math.max(maxV, num(v))

  const H = L.height || Math.round(W * 0.56)
  const parts = []
  const items = series.length > 1 ? series.map((s, i) => ({ label: s.name, color: P.series[i % P.series.length] })) : []
  // 图例的可用宽度必须与下面真画时给的是同一个数：量的时候按整幅宽、画的时候按绘图区宽，
  // 折行数就会对不上，顶上留的那块高度不是多出一条空档就是被图例压住
  const legW = W * LEG_W
  const legH = items.length ? legendHeight(items, legW, fs, P) : 0

  const sc = countScale(maxV, Math.max(3, Math.min(8, Math.floor((H - legH) / (fs * 3.2)))))
  const mL = yAxisMetrics(sc, fs, spec.yLabel)
  const mR = fs * 1.2
  const plotW = Math.max(30, W - mL - mR)

  // 分类标签：先试平排，放不下改 -35° 斜排；斜排仍挤就隔 k 个出一条
  const band = nc ? plotW / nc : plotW
  let maxLabW = 0
  for (const c of cats) maxLabW = Math.max(maxLabW, textW(c, fs * 0.9))
  const kFlat = Math.max(1, Math.ceil((maxLabW + fs * 0.45) / band))
  const rot = kFlat > 1
  // 斜排时相邻两条标签的净间距是 band·sin35°，要装下一个字身才不叠：band ≥ fs/sin35° ≈ fs·1.74。
  // 按 fs·1.2 卡（照横排的口径想当然）会放行一批实际压在一起的标签
  const k = rot ? Math.max(1, Math.ceil((fs * 1.74) / band)) : 1
  // 斜排标签以刻度为右端向左下伸出 labW·cos35°，最左那条不能伸出图外 —— 只按 7 个字身封顶
  // 的话窄图上第一条会被裁掉半个名字
  const rotMaxW = Math.min(fs * 7, Math.max(fs * 2, (mL + band * 0.5 - fs * 0.2) / 0.819))
  const labW = rot ? Math.min(maxLabW, rotMaxW) : 0
  const mB = fs * (0.5 + 1.05) + (rot ? labW * 0.574 : 0) + (spec.xLabel ? AXL_H * fs : 0)
  const mT = fs * 0.9 + legH
  const fr = { x0: mL, y0: mT, x1: mL + plotW, y1: H - mB, w: plotW, h: Math.max(20, H - mB - mT) }
  fr.y1 = fr.y0 + fr.h

  if (items.length) parts.push(...legendParts(P, items, mL, fs * 0.2, legW, fs).parts)
  parts.push(...yAxisParts(P, fr, sc, fs, spec.yLabel))

  // 条宽封顶 2.2 个字身（屏上 fs=11 时正好 24 px —— dataviz 的条形上限），组内留 2 px 底色缝，
  // 槽里剩下的是空气。封顶跟字号走而不是写死 24 px：报告里那份宽 1200，写死就成了发丝
  const gap = Math.max(2, fs * 0.18)
  const slot = band * 0.78
  const bw = nc ? Math.min(fs * 2.2, Math.max(1, (slot - gap * (ns - 1)) / ns)) : 0
  const groupW = bw * ns + gap * (ns - 1)
  const r = P.square ? 0 : fs * 0.36
  const mapY = (v) => fr.y1 - ((v - sc.min) / ((sc.max - sc.min) || 1)) * fr.h
  for (let ci = 0; ci < nc; ci++) {
    const cx = fr.x0 + band * (ci + 0.5)
    for (let si = 0; si < ns; si++) {
      const v = num(series[si] ? series[si].data[ci] : 0)
      const y = mapY(v)
      const x = cx - groupW / 2 + si * (bw + gap)
      const h = fr.y1 - y
      if (h > 0.2) parts.push(bar(x, y, bw, h, r, 'up', P.series[si % P.series.length]))
    }
    if (ci % k === 0) {
      const lab = ellipsize(cats[ci], fs * 0.9, rot ? rotMaxW : band - fs * 0.3)
      if (rot) {
        parts.push(T(P, cx, fr.y1 + fs * 1.0, lab.s, { fs: fs * 0.9, fill: P.dim, anchor: 'end', rotate: -35, full: lab.cut ? cats[ci] : '' }))
      } else {
        parts.push(T(P, cx, fr.y1 + fs * 1.15, lab.s, { fs: fs * 0.9, fill: P.dim, anchor: 'middle', full: lab.cut ? cats[ci] : '' }))
      }
    }
  }
  if (spec.xLabel) parts.push(T(P, fr.x0 + plotW / 2, H - AXL_Y * fs, spec.xLabel, { fs, fill: P.dim, anchor: 'middle' }))
  if (!nc || !series.length) parts.push(T(P, fr.x0 + plotW / 2, fr.y0 + fr.h / 2, EMPTY_TXT[L.lang] || EMPTY_TXT.zh, { fs, fill: P.dim, anchor: 'middle' }))
  return { h: H, parts }
}

// ② 排名横条。每条都直接标了值，故不画刻度与网格 —— 值在，坐标轴就是多余的墨
function drawHbar(spec, P, L) {
  const fs = L.fs, W = L.width
  const items = (Array.isArray(spec.items) ? spec.items : []).slice(0, 20)
  const n = items.length
  const rowH = fs * 2.1
  const mT = fs * 0.9
  const mB = fs * 0.6 + (spec.xLabel ? AXL_H * fs : 0)
  const H = L.height || Math.round(mT + Math.max(1, n) * rowH + mB)

  let maxV = 0
  for (const it of items) maxV = Math.max(maxV, num(it && it.value))
  // 标签列与数值列各自按最宽的那条量：数值一律放在条端外侧，不往条里塞
  //（塞进去要按填充色的明度挑字色，而屏上那套色是 var()，明度算不出来）
  let labW = 0, valW = 0
  for (const it of items) {
    labW = Math.max(labW, textW(it && it.label, fs))
    valW = Math.max(valW, textW(fmtInt(it && it.value), fs * 0.95))
  }
  const mL = Math.min(labW, W * 0.34) + fs * 0.7
  const mR = valW + fs * 1.2
  const plotW = Math.max(20, W - mL - mR)
  const parts = []
  const barH = rowH * 0.6      // 槽里留四成空气（条不填满行高，见 dataviz 的条形规格）
  const r = fs * 0.36
  for (let i = 0; i < n; i++) {
    const it = items[i] || {}
    const y = mT + i * rowH + (rowH - barH) / 2
    const v = num(it.value)
    const w = maxV > 0 ? (v / maxV) * plotW : 0
    const color = it.emphasis ? P.series[1] : P.series[0]
    const lab = ellipsize(it.label, fs, mL - fs * 0.7)
    parts.push(T(P, mL - fs * 0.7, y + barH * 0.5 + fs * 0.34, lab.s, { fs, fill: P.ink, anchor: 'end', full: lab.cut ? it.label : '' }))
    if (w > 0.2) parts.push(bar(mL, y, w, barH, r, 'right', color))
    parts.push(T(P, mL + w + fs * 0.45, y + barH * 0.5 + fs * 0.34, fmtInt(v), { fs: fs * 0.95, fill: P.dim }))
  }
  parts.push(line(mL, mT, mL, mT + Math.max(1, n) * rowH, P.axis, P.lw))
  if (spec.xLabel) parts.push(T(P, mL + plotW / 2, H - AXL_Y * fs, spec.xLabel, { fs, fill: P.dim, anchor: 'middle' }))
  if (!n) parts.push(T(P, mL + plotW / 2, mT + rowH / 2, EMPTY_TXT[L.lang] || EMPTY_TXT.zh, { fs, fill: P.dim, anchor: 'middle' }))
  return { h: H, parts }
}

// ③ 堆叠横条（单条，讲构成）。段与段之间留 2px 底色缝，不描边（描边是给不是数据的东西上墨）。
// 段名不往段里塞，全部落到下面的图例行 —— 图例里带各段的数与占比，是读数不是解释
function drawStack(spec, P, L) {
  const fs = L.fs, W = L.width
  const segs = (Array.isArray(spec.segs) ? spec.segs : []).filter((s) => s)
  let sum = 0
  for (const s of segs) sum += Math.max(0, num(s.value))
  const total = Number.isFinite(+spec.total) && +spec.total > 0 ? +spec.total : sum
  const mL = fs * 0.6, mR = fs * 0.6
  const plotW = Math.max(20, W - mL - mR)
  const barH = fs * 2.4
  const headH = fs * 1.6
  const en = L.lang === 'en'
  const items = segs.map((s, i) => ({
    label: String(s.label == null ? '' : s.label) + (en ? '  ' : '　') + fmtInt(s.value)
      + (total > 0 ? (en ? ' (' : '（') + ((Math.max(0, num(s.value)) / total) * 100).toFixed(1) + (en ? '%)' : '%）') : ''),
    color: P.ramp4[i % P.ramp4.length]
  }))
  const legH = items.length ? legendHeight(items, plotW, fs, P) : 0
  const H = L.height || Math.round(headH + barH + fs * 0.8 + legH + fs * 0.6)

  const parts = []
  if (total > 0) {
    const head = fmtInt(total) + (spec.unitLabel ? ' ' + spec.unitLabel : '')
    parts.push(T(P, mL + plotW, headH - fs * 0.5, head, { fs: fs * 1.05, fill: P.ink, anchor: 'end', weight: 600 }))
  }
  const gap = Math.max(2, fs * 0.18)
  const usable = Math.max(1, plotW - gap * Math.max(0, segs.length - 1))
  let x = mL
  for (let i = 0; i < segs.length; i++) {
    const v = Math.max(0, num(segs[i].value))
    const w = sum > 0 ? (v / sum) * usable : usable / segs.length
    parts.push(rect(x, headH, w, barH, P.ramp4[i % P.ramp4.length]))
    x += w + gap
  }
  if (!segs.length) {
    parts.push(rect(mL, headH, plotW, barH, P.grid, ' opacity="0.35"'))
    parts.push(T(P, mL + plotW / 2, headH + barH / 2 + fs * 0.35, EMPTY_TXT[L.lang] || EMPTY_TXT.zh, { fs, fill: P.dim, anchor: 'middle' }))
  } else {
    const lg = legendParts(P, items, mL, headH + barH + fs * 0.5, plotW, fs)
    parts.push(...lg.parts)
  }
  return { h: H, parts }
}

// ④ 折线（≤3 条）。线型是第二道身份编码：三槽同时上图时槽①与槽③在红绿色盲下几乎同色，
// 只靠颜色认不出是哪条。null 断开不连（缺测就是缺测，连过去等于造数据）
const DASHES = ['', '7 4', '2 3', '9 3 2 3']
function drawLine(spec, P, L) {
  const fs = L.fs, W = L.width
  const xs = (Array.isArray(spec.x) ? spec.x : []).map(num)
  const series = (Array.isArray(spec.series) ? spec.series : []).filter((s) => s && Array.isArray(s.data)).slice(0, 4)
  const H = L.height || Math.round(W * 0.5)
  const parts = []

  let lo = Infinity, hi = -Infinity, allInt = true
  for (const s of series) for (const v of s.data) {
    if (v === null || v === undefined || !Number.isFinite(+v)) continue
    lo = Math.min(lo, +v); hi = Math.max(hi, +v)
    if (!Number.isInteger(+v)) allInt = false
  }
  if (lo === Infinity) { lo = 0; hi = 1 }
  const items = series.length > 1 ? series.map((s, i) => ({ label: s.name, color: serColor(P, s, i), dash: DASHES[i % DASHES.length] })) : []
  const legW = W * LEG_W
  const legH = items.length ? legendHeight(items, legW, fs, P) : 0

  const ysc = valueScale(lo, hi, Math.max(3, Math.min(7, Math.floor((H - legH) / (fs * 3.2)))), lo >= 0, allInt)
  // 末点是不完整期（逐年序列的当年）：最后一段另画（淡一档）、末点空心 —— 整段实线读起来像「骤降」
  const partial = !!spec.partialLast && xs.length >= 2
  const mL = yAxisMetrics(ysc, fs, spec.yLabel)

  // 末端直接标注：线在右端分得开才标，挤在一起就只留图例（把标签上下错开会让它脱离自己的线）
  const ends = []
  for (let i = 0; i < series.length; i++) {
    const d = series[i].data
    for (let j = d.length - 1; j >= 0; j--) {
      if (d[j] === null || d[j] === undefined || !Number.isFinite(+d[j])) continue
      ends.push({ i, xi: j, v: +d[j], name: String(series[i].name == null ? '' : series[i].name) })
      break
    }
  }
  let endW = 0
  for (const e of ends) endW = Math.max(endW, textW(e.name, fs * 0.92))
  const wantEnd = ends.length > 0 && endW <= W * 0.26
  const mR = wantEnd ? endW + fs * 1.1 : fs * 1.2
  const plotW = Math.max(30, W - mL - mR)
  const mT = fs * 0.9 + legH
  const mB = fs * 1.65 + (spec.xLabel ? AXL_H * fs : 0)
  const fr = { x0: mL, y0: mT, x1: mL + plotW, y1: H - mB, w: plotW, h: Math.max(20, H - mB - mT) }
  fr.y1 = fr.y0 + fr.h

  if (items.length) parts.push(...legendParts(P, items, mL, fs * 0.2, legW, fs).parts)
  parts.push(...yAxisParts(P, fr, ysc, fs, spec.yLabel))

  // 横轴。xIsYear 档按整十年（退而求其次 5 / 2 / 1 年）出刻度，年份不带千分位
  const xlo = xs.length ? minOf(xs, (v) => v) : 0
  const xhi = xs.length ? maxOf(xs, (v) => v) : 1
  const wantN = Math.max(2, Math.min(10, Math.floor(plotW / (fs * 4.2))))
  let xticks, xstep
  if (spec.xIsYear) {
    const span = Math.max(1, xhi - xlo)
    xstep = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => span / s <= wantN) || 200
    // 年份轴优先落在整十年上：十年一档还能给出四个以上刻度时就用十年，跨度短到给不出
    // 四个刻度才退到 5 / 2 / 1 年。刻度恒为整年（锚在步长的整数倍上），不会出现 2018.4
    if (xstep < 10 && span / 10 >= 3.5) xstep = 10
    const first = Math.ceil(xlo / xstep) * xstep
    xticks = []
    for (let v = first; v <= xhi + 1e-9; v += xstep) xticks.push(v)
    // 跨度不足一个步长时上面那个循环一条都放不进去。兜底必须夹回数据域 ——
    // 原先的 Math.round(xlo) 可能落在 [xlo, xhi] 外面，mapX 会把刻度线连同标签一起画到画幅外，
    // 横轴上于是一个刻度都不剩（当前三张图的 x 都跨多年够不着，但改了 months 口径就立刻踩上）。
    if (!xticks.length) xticks = xhi > xlo ? [xlo, xhi] : [xlo]
  } else {
    const s = niceScale(xlo, xhi, wantN)
    xstep = s.step
    xticks = s.ticks.filter((t) => t >= xlo - 1e-9 && t <= xhi + 1e-9)
    if (!xticks.length) xticks = [xlo, xhi]
  }
  const mapX = (v) => fr.x0 + ((v - xlo) / ((xhi - xlo) || 1)) * fr.w
  const mapY = (v) => fr.y1 - ((v - ysc.min) / ((ysc.max - ysc.min) || 1)) * fr.h
  for (const t of xticks) {
    const x = mapX(t)
    parts.push(line(x, fr.y1, x, fr.y1 + fs * 0.32, P.axis, P.lw))
    parts.push(T(P, x, fr.y1 + fs * 1.3, spec.xIsYear ? String(Math.round(t)) : grp(fmtStep(t, xstep)), { fs: fs * 0.9, fill: P.dim, anchor: 'middle' }))
  }
  if (spec.xLabel) parts.push(T(P, fr.x0 + fr.w / 2, H - AXL_Y * fs, spec.xLabel, { fs, fill: P.dim, anchor: 'middle' }))

  const lw = P.dataLw || Math.max(2, fs * 0.18)
  for (let i = 0; i < series.length; i++) {
    const d = series[i].data
    const color = serColor(P, series[i], i)
    const dash = DASHES[i % DASHES.length]
    let run = []
    const flush = () => {
      if (run.length >= 2) parts.push(`<polyline points="${run.join(' ')}" fill="none" stroke="${color}" stroke-width="${n2(lw)}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`)
      else if (run.length === 1) { const p = run[0].split(','); parts.push(`<circle cx="${p[0]}" cy="${p[1]}" r="${n2(lw)}" fill="${color}"/>`) }
      run = []
    }
    const nMain = partial ? xs.length - 1 : xs.length
    const valid = (j) => d[j] !== null && d[j] !== undefined && Number.isFinite(+d[j])
    for (let j = 0; j < nMain; j++) {
      if (!valid(j)) { flush(); continue }
      run.push(n2(mapX(xs[j])) + ',' + n2(mapY(+d[j])))
    }
    flush()
    if (partial && valid(xs.length - 2) && valid(xs.length - 1)) {
      const a = xs.length - 2, b = xs.length - 1
      // 纸面档：末段 2 / 1.5 pt 虚线（§F.5）；其余两档淡一档
      const pd = P.paperTheme ? `${n2(fs / 4)} ${n2(fs * 0.1875)}` : dash
      parts.push(`<polyline data-partial="1" points="${n2(mapX(xs[a]))},${n2(mapY(+d[a]))} ${n2(mapX(xs[b]))},${n2(mapY(+d[b]))}" fill="none" stroke="${color}" stroke-width="${n2(lw)}"${P.paperTheme ? '' : ' opacity="0.45"'}${pd ? ` stroke-dasharray="${pd}"` : ''} stroke-linecap="round"/>`)
    }
  }
  // 末端圆点：带一圈底色环，压在别的线上也读得出（print 档底是白的，screen 档跟面板底走）
  const ringW = P.paperTheme ? fs * 0.094 : Math.max(2, fs * 0.18)
  const ring = P.print ? P.paper : 'var(--bg)'
  const okEnd = wantEnd && ends.every((a, ai) => ends.every((b, bi) => ai === bi || Math.abs(mapY(a.v) - mapY(b.v)) >= fs * 1.25))
  for (const e of ends) {
    if (!xs.length) break
    const x = mapX(xs[Math.min(e.xi, xs.length - 1)]), y = mapY(e.v)
    const col = serColor(P, series[e.i], e.i)
    // 不完整期的末点空心（底色填、系列色描边）
    if (partial && e.xi === xs.length - 1) parts.push(`<circle cx="${n2(x)}" cy="${n2(y)}" r="${n2(Math.max(4, fs * 0.28))}" fill="${ring}" stroke="${col}" stroke-width="${n2(ringW)}"/>`)
    else parts.push(`<circle cx="${n2(x)}" cy="${n2(y)}" r="${n2(Math.max(4, fs * 0.28))}" fill="${col}" stroke="${ring}" stroke-width="${n2(ringW)}"/>`)
    if (okEnd) parts.push(T(P, x + fs * 0.6, y + fs * 0.32, e.name, { fs: fs * 0.92, fill: P.dim }))
  }
  if (!series.length || !xs.length) parts.push(T(P, fr.x0 + fr.w / 2, fr.y0 + fr.h / 2, EMPTY_TXT[L.lang] || EMPTY_TXT.zh, { fs, fill: P.dim, anchor: 'middle' }))
  return { h: H, parts }
}

// ⑤ 分箱直方。刻度落在箱边界上（读图的人要的是「这一箱是 400–600 km」，不是轴上随便一个整数）
function drawHist(spec, P, L) {
  const fs = L.fs, W = L.width
  const bins = (Array.isArray(spec.bins) ? spec.bins : []).filter((b) => b && Number.isFinite(+b.x0) && Number.isFinite(+b.x1))
  const H = L.height || Math.round(W * 0.5)
  let maxV = 0, xlo = Infinity, xhi = -Infinity
  for (const b of bins) { maxV = Math.max(maxV, num(b.n)); xlo = Math.min(xlo, +b.x0); xhi = Math.max(xhi, +b.x1) }
  if (xlo === Infinity) { xlo = 0; xhi = 1 }
  const sc = countScale(maxV, Math.max(3, Math.min(8, Math.floor(H / (fs * 3.2)))))
  const mL = yAxisMetrics(sc, fs, spec.yLabel)
  const mR = fs * 1.2
  const plotW = Math.max(30, W - mL - mR)
  const mT = fs * 0.9
  const mB = fs * 1.65 + (spec.xLabel ? AXL_H * fs : 0)
  const fr = { x0: mL, y0: mT, x1: mL + plotW, y1: mT + Math.max(20, H - mB - mT), w: plotW, h: Math.max(20, H - mB - mT) }
  const parts = []
  parts.push(...yAxisParts(P, fr, sc, fs, spec.yLabel))

  const mapX = (v) => fr.x0 + ((v - xlo) / ((xhi - xlo) || 1)) * fr.w
  const mapY = (v) => fr.y1 - ((v - sc.min) / ((sc.max - sc.min) || 1)) * fr.h
  const gap = bins.length && (fr.w / bins.length) > fs * 0.6 ? Math.max(1, fs * 0.12) : 0
  const r = P.square ? 0 : fs * 0.3
  for (const b of bins) {
    const x = mapX(+b.x0), x2 = mapX(+b.x1)
    const v = num(b.n)
    const y = mapY(v)
    const h = fr.y1 - y
    if (h > 0.2) parts.push(bar(x + gap / 2, y, Math.max(0.6, x2 - x - gap), h, r, 'up', P.series[0]))
  }
  // 箱边界刻度：轴上的数必须落在箱边界上（读图的人要的是「这一箱是 400–600 km」，
  // 不是轴上随便一个整数）。放不下就隔 k 条出，首尾两条恒留 —— 末条若与前一条挨得比 k 还近，
  // 顶掉前一条而不是挤上去
  const edges = []
  for (const b of bins) { if (!edges.length || edges[edges.length - 1] !== +b.x0) edges.push(+b.x0) }
  if (bins.length) edges.push(+bins[bins.length - 1].x1)
  const step = (xhi - xlo) / Math.max(1, bins.length)
  let labW = 0
  for (const e of edges) labW = Math.max(labW, textW(grp(fmtStep(e, step)), fs * 0.9))
  const perEdge = edges.length > 1 ? fr.w / (edges.length - 1) : fr.w
  const k = Math.max(1, Math.ceil((labW + fs * 0.6) / Math.max(1, perEdge)))
  const show = []
  for (let i = 0; i < edges.length; i += k) show.push(i)
  const last = edges.length - 1
  if (last >= 0 && show[show.length - 1] !== last) {
    if (last - show[show.length - 1] < k) show.pop()
    show.push(last)
  }
  for (const i of show) {
    const x = mapX(edges[i])
    parts.push(line(x, fr.y1, x, fr.y1 + fs * 0.32, P.axis, P.lw))
    parts.push(T(P, x, fr.y1 + fs * 1.3, grp(fmtStep(edges[i], step)), { fs: fs * 0.9, fill: P.dim, anchor: 'middle' }))
  }
  if (spec.xLabel) parts.push(T(P, fr.x0 + fr.w / 2, H - AXL_Y * fs, spec.xLabel, { fs, fill: P.dim, anchor: 'middle' }))
  if (!bins.length) parts.push(T(P, fr.x0 + fr.w / 2, fr.y0 + fr.h / 2, EMPTY_TXT[L.lang] || EMPTY_TXT.zh, { fs, fill: P.dim, anchor: 'middle' }))
  return { h: H, parts }
}

// ⑥ GEO 经度占用条带。横轴恒为 −180…180（整幅弧都在图上，占用与空档一眼可比），
// bands 画底纹（重点弧段）、marks 画竖标（某颗星 / 某个位置）
function drawStrip(spec, P, L) {
  const fs = L.fs, W = L.width
  const bins = (Array.isArray(spec.bins) ? spec.bins : []).filter((b) => b && Number.isFinite(+b.lon))
  const bands = Array.isArray(spec.bands) ? spec.bands : []
  const marks = Array.isArray(spec.marks) ? spec.marks : []
  const H = L.height || Math.round(W * 0.34)
  let maxV = 0
  for (const b of bins) maxV = Math.max(maxV, num(b.n))
  const sc = countScale(maxV, Math.max(3, Math.min(6, Math.floor(H / (fs * 3.4)))))
  const mL = yAxisMetrics(sc, fs, spec.yLabel)
  const mR = fs * 1.2
  const plotW = Math.max(30, W - mL - mR)
  const pm = P.paperTheme && marks.length ? stripMarkLayout(marks, mL, plotW, fs) : null
  const markLabW = (!pm && marks.length) ? Math.min(fs * 6, maxOf(marks, (m) => textW(m && m.label, fs * 0.85))) : 0
  const markUp0 = pm ? fs * 1.3 : (marks.length ? markLabW * 0.574 + fs * 0.45 : 0)
  const mT = fs * 0.9 + (bands.some((b) => b && b.label) ? fs * 1.2 : 0) + markUp0
  const mB = fs * 1.65 + (spec.xLabel ? AXL_H * fs : 0) + (pm && !pm.fits ? pm.keyRows * fs * 1.4 : 0)
  const fr = { x0: mL, y0: mT, x1: mL + plotW, y1: mT + Math.max(20, H - mB - mT), w: plotW, h: Math.max(20, H - mB - mT) }
  const parts = []
  const mapX = (v) => fr.x0 + ((clamp(v, -180, 180) + 180) / 360) * fr.w
  const mapY = (v) => fr.y1 - ((v - sc.min) / ((sc.max - sc.min) || 1)) * fr.h

  // 底纹先铺（在数据之下），段名压在绘图区顶上。竖标的名字是斜排的、也在顶上，
  // 故段名再往上让出一行 —— 两者同一条基线会叠成一团（实测）
  const markUp = markUp0
  // ★ from > to 说的是【跨 ±180° 接缝】那一段（如 150°E → −150°，60° 宽的太平洋弧），
  //   与 ssaStats.inArc 同一口径。拿 min/max 去画会画成它的补集（300° 宽），正好反了 ——
  //   故跨缝时画成左右两截，段名挂在宽的那一截上。
  for (const bd of bands) {
    if (!bd || !Number.isFinite(+bd.from) || !Number.isFinite(+bd.to)) continue
    const from = +bd.from, to = +bd.to
    const segs = from <= to ? [[from, to]] : [[from, 180], [-180, to]]
    let wide = null
    for (const [lo, hi] of segs) {
      const a = mapX(lo), b = mapX(hi)
      parts.push(rect(a, fr.y0, b - a, fr.h, P.band))
      if (!wide || (b - a) > (wide[1] - wide[0])) wide = [a, b]
    }
    if (bd.label && wide) {
      const [a, b] = wide
      const lab = ellipsize(bd.label, fs * 0.85, Math.max(fs * 2, b - a))
      parts.push(T(P, (a + b) / 2, fr.y0 - fs * 0.35 - markUp, lab.s, { fs: fs * 0.85, fill: P.dim, anchor: 'middle', full: lab.cut ? bd.label : '' }))
    }
  }
  parts.push(...yAxisParts(P, fr, sc, fs, spec.yLabel))

  // 桶宽按相邻桶的最小间隔反推（spec 只给桶心 lon）：默认 1°，条以 lon 为中心画
  let bw = 1
  if (bins.length > 1) {
    const ls = bins.map((b) => +b.lon).sort((a, b) => a - b)
    let g = Infinity
    for (let i = 1; i < ls.length; i++) { const d = ls[i] - ls[i - 1]; if (d > 1e-6) g = Math.min(g, d) }
    if (g !== Infinity) bw = clamp(g, 0.25, 10)
  }
  const pxw = Math.max(1, (bw / 360) * fr.w)
  for (const b of bins) {
    const v = num(b.n)
    if (v <= 0) continue
    const x = mapX(+b.lon) - pxw / 2
    const y = mapY(v)
    parts.push(rect(x, y, pxw, fr.y1 - y, P.series[0]))
  }
  // 竖标压在最上层。纸面档：名字横排在绘图区上方；放不下就整组改编号引注（不再 −35° 斜排、不截断）
  if (pm) {
    pm.ms.forEach((m, i) => {
      parts.push(line(m.x, fr.y0, m.x, fr.y1, P.ink, P.lw))
      parts.push(T(P, m.x + (pm.fits ? fs * 0.2 : 0), fr.y0 - fs * 0.3, pm.fits ? m.label : m.tag, { fs, fill: P.ink, anchor: pm.fits ? 'start' : 'middle' }))
    })
    if (!pm.fits) {
      let cx = fr.x0, cy = fr.y1 + fs * 2.7
      for (const m of pm.ms) {
        const txt = m.tag + ' ' + m.label
        const w = textW(txt, fs) + fs * 1.2
        if (cx > fr.x0 && cx + w > fr.x1) { cx = fr.x0; cy += fs * 1.4 }
        parts.push(T(P, cx, cy, txt, { fs, fill: P.dim }))
        cx += w
      }
    }
  } else for (const m of marks) {
    if (!m || !Number.isFinite(+m.lon)) continue
    const x = mapX(+m.lon)
    parts.push(line(x, fr.y0, x, fr.y1, P.series[1], Math.max(1.5, fs * 0.14)))
    if (m.label) {
      // 斜排的名字以竖标为左端向右上伸出 labW·cos35°，贴着 180° 的那根不能把名字甩出图外
      const lab = ellipsize(m.label, fs * 0.85, Math.min(fs * 6, Math.max(fs * 2, (W - x - fs * 0.2) / 0.819)))
      parts.push(T(P, x, fr.y0 - fs * 0.3, lab.s, { fs: fs * 0.85, fill: P.ink, anchor: 'start', rotate: -35, full: lab.cut ? m.label : '' }))
    }
  }
  const xstep = fr.w / 360 * 30 >= fs * 2.6 ? 30 : 60
  for (let v = -180; v <= 180; v += xstep) {
    const x = mapX(v)
    parts.push(line(x, fr.y1, x, fr.y1 + fs * 0.32, P.axis, P.lw))
    const lab = P.paperTheme ? (v === 0 ? '0°' : v < 0 ? (-v) + '°W' : v + '°E') : String(v)
    parts.push(T(P, x, fr.y1 + fs * 1.3, lab, { fs: fs * 0.9, fill: P.dim, anchor: 'middle' }))
  }
  parts.push(line(fr.x0, fr.y0, fr.x0, fr.y1, P.axis, P.lw))
  parts.push(line(fr.x1, fr.y0, fr.x1, fr.y1, P.axis, P.lw))
  if (spec.xLabel) parts.push(T(P, fr.x0 + fr.w / 2, H - AXL_Y * fs, spec.xLabel, { fs, fill: P.dim, anchor: 'middle' }))
  if (!bins.length) parts.push(T(P, fr.x0 + fr.w / 2, fr.y0 + fr.h / 2, EMPTY_TXT[L.lang] || EMPTY_TXT.zh, { fs, fill: P.dim, anchor: 'middle' }))
  return { h: H, parts }
}

// 纸面档条带竖标的排版：按经度排序，逐个看名字横排能否在下一根竖标之前放下；放不下就整组编号，
// 并量出编号表（「① 名称　② 名称」）要几行。mapX 与 drawStrip 同一条
const CIRC = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
function stripMarkLayout(marks, x0, plotW, fs) {
  const mapX = (v) => x0 + ((clamp(v, -180, 180) + 180) / 360) * plotW
  const ms = marks.filter((m) => m && Number.isFinite(+m.lon))
    .map((m) => ({ x: mapX(+m.lon), label: String(m.label == null ? '' : m.label) }))
    .sort((a, b) => a.x - b.x)
  ms.forEach((m, i) => { m.tag = CIRC[i] || '(' + (i + 1) + ')' })
  let fits = true
  for (let i = 0; i < ms.length; i++) {
    const right = i < ms.length - 1 ? ms[i + 1].x : x0 + plotW
    if (ms[i].x + fs * 0.2 + textW(ms[i].label, fs) + fs * 0.4 > right) { fits = false; break }
  }
  let keyRows = 0
  if (!fits) {
    keyRows = 1
    let cx = 0
    for (const m of ms) {
      const w = textW(m.tag + ' ' + m.label, fs) + fs * 1.2
      if (cx > 0 && cx + w > plotW) { keyRows++; cx = 0 }
      cx += w
    }
  }
  return { ms, fits, keyRows }
}

// ⑦ 二维密度格。计数跨几个数量级（一格 1 颗到一格上千颗），线性色阶会把除最热的几格外
// 全部压成一个颜色，故按 log1p 分七档；空格（0）不落色，让底色自己说话。右侧带色标条
function drawHeat(spec, P, L) {
  const fs = L.fs, W = L.width
  const xB = (Array.isArray(spec.xBins) ? spec.xBins : []).filter((b) => b && Number.isFinite(+b.x0) && Number.isFinite(+b.x1))
  const yB = (Array.isArray(spec.yBins) ? spec.yBins : []).filter((b) => b && Number.isFinite(+b.y0) && Number.isFinite(+b.y1))
  const cells = Array.isArray(spec.cells) ? spec.cells : []
  const H = L.height || Math.round(W * 0.62)
  let vmax = 0
  for (const row of cells) { if (!Array.isArray(row)) continue; for (const v of row) vmax = Math.max(vmax, num(v)) }

  const xlo = xB.length ? minOf(xB, (b) => +b.x0) : 0
  const xhi = xB.length ? maxOf(xB, (b) => +b.x1) : 1
  const ylo = yB.length ? minOf(yB, (b) => +b.y0) : 0
  const yhi = yB.length ? maxOf(yB, (b) => +b.y1) : 1

  // yLog：纵轴（高度）按对数映射，刻度落在 1-2-5 序列上（与 ssaStats.heatGrid 的 logAlt 分层配套）
  const yLog = !!spec.yLog && ylo > 0 && yhi > ylo
  let ysc = niceScale(ylo, yhi, Math.max(3, Math.min(8, Math.floor(H / (fs * 3.2)))))
  if (yLog) {
    const ticks = []
    for (let e = Math.floor(Math.log10(ylo)); e <= Math.ceil(Math.log10(yhi)); e++) for (const m of [1, 2, 5]) { const v = m * Math.pow(10, e); if (v >= ylo - 1e-9 && v <= yhi + 1e-9) ticks.push(v) }
    ysc = { min: ylo, max: yhi, step: 1, ticks }
  }
  const mL = yAxisMetrics(ysc, fs, spec.yLabel)
  // 右边距 = 色标条 + 它的刻度数字 + 轴名
  const barW = fs * 1.15
  const lg = []
  const K = P.seq.length
  const lmax = Math.log1p(Math.max(1, vmax))
  // 纸面档：级界取 1-2-5 序列的整数（1 / 5 / 20 / 50 / 200 / 500 / > 500，§F2.5）—— 读者能把一格的颜色读回一个整数区间；
  // 其余两档仍按 log1p 七等分（逐字节不变）
  const lgText = []
  if (P.paperTheme) { for (let i = 0; i < K; i++) lgText.push(HEAT_BREAKS[i] === Infinity ? '>' + HEAT_BREAKS[i - 1] : String(HEAT_BREAKS[i])) }
  else for (let i = 1; i <= K; i++) { const v = Math.max(1, Math.round(Math.expm1((i / K) * lmax))); lg.push(v); lgText.push(fmtInt(v)) }
  let lgW = 0
  for (const v of lgText) lgW = Math.max(lgW, textW(v, fs * 0.85))
  const mR = fs * 0.7 + barW + fs * 0.35 + lgW + (spec.legendLabel ? fs * 1.35 : 0) + fs * 0.4
  const plotW = Math.max(30, W - mL - mR)
  const mT = fs * 0.9
  const mB = fs * 1.65 + (spec.xLabel ? AXL_H * fs : 0)
  const fr = { x0: mL, y0: mT, x1: mL + plotW, y1: mT + Math.max(20, H - mB - mT), w: plotW, h: Math.max(20, H - mB - mT) }
  const parts = []
  const mapX = (v) => fr.x0 + ((v - xlo) / ((xhi - xlo) || 1)) * fr.w
  const mapY = yLog
    ? (v) => fr.y1 - (Math.log(Math.max(v, ylo) / ylo) / Math.log(yhi / ylo)) * fr.h
    : (v) => fr.y1 - ((v - ylo) / ((yhi - ylo) || 1)) * fr.h

  for (let yi = 0; yi < yB.length; yi++) {
    const row = cells[yi]
    if (!Array.isArray(row)) continue
    const ya = mapY(+yB[yi].y1), yb = mapY(+yB[yi].y0)
    for (let xi = 0; xi < xB.length; xi++) {
      const v = num(row[xi])
      if (v <= 0) continue
      const t = lmax > 0 ? Math.log1p(v) / lmax : 1
      const idx = P.paperTheme ? HEAT_BREAKS.findIndex((b) => v <= b) : clamp(Math.floor(t * K - 1e-9), 0, K - 1)
      const xa = mapX(+xB[xi].x0), xb = mapX(+xB[xi].x1)
      // 相邻格补 0.5px 重叠：格与格之间留缝会把一张密度图画成网格纸
      parts.push(rect(xa, ya, xb - xa + 0.5, yb - ya + 0.5, P.seq[idx]))
    }
  }
  // 纵轴刻度（密度格自带框，故只出刻度不铺网格线：网格压在格子上就成了假边界）
  for (const t of ysc.ticks) {
    if (t < ylo - 1e-9 || t > yhi + 1e-9) continue
    const y = mapY(t)
    parts.push(line(fr.x0, y, fr.x0 - fs * 0.32, y, P.axis, P.lw))
    parts.push(T(P, fr.x0 - fs * 0.45, y + fs * 0.32, grp(fmtStep(t, ysc.step), ysc.ticks.some((u) => u >= 10000)), { fs: fs * 0.9, fill: P.dim, anchor: 'end' }))
  }
  if (spec.yLabel) parts.push(T(P, fr.x0 - fs * 0.45 - ysc.digitW - fs * 0.55, (fr.y0 + fr.y1) / 2, spec.yLabel, { fs, fill: P.dim, anchor: 'middle', rotate: -90 }))
  const xsc = niceScale(xlo, xhi, Math.max(2, Math.min(9, Math.floor(fr.w / (fs * 4.2)))))
  for (const t of xsc.ticks) {
    if (t < xlo - 1e-9 || t > xhi + 1e-9) continue
    const x = mapX(t)
    parts.push(line(x, fr.y1, x, fr.y1 + fs * 0.32, P.axis, P.lw))
    parts.push(T(P, x, fr.y1 + fs * 1.3, grp(fmtStep(t, xsc.step)), { fs: fs * 0.9, fill: P.dim, anchor: 'middle' }))
  }
  parts.push(`<rect x="${n2(fr.x0)}" y="${n2(fr.y0)}" width="${n2(fr.w)}" height="${n2(fr.h)}" fill="none" stroke="${P.axis}" stroke-width="${n2(P.lw)}"/>`)
  if (spec.xLabel) parts.push(T(P, fr.x0 + fr.w / 2, H - AXL_Y * fs, spec.xLabel, { fs, fill: P.dim, anchor: 'middle' }))

  // 色标条：七档分级，刻度写在每档的上边界上（对数分档，刻度自然不等距 —— 色标条的轴就是颜色的轴）
  const bx = fr.x1 + fs * 0.7
  const segH = fr.h / K
  for (let i = 0; i < K; i++) {
    parts.push(rect(bx, fr.y1 - (i + 1) * segH, barW, segH + 0.5, P.seq[i]))
    const y = fr.y1 - (i + 1) * segH
    parts.push(line(bx + barW, y, bx + barW + fs * 0.25, y, P.axis, P.lw))
    parts.push(T(P, bx + barW + fs * 0.35, y + fs * 0.3, lgText[i], { fs: fs * 0.85, fill: P.dim }))
  }
  parts.push(`<rect x="${n2(bx)}" y="${n2(fr.y0)}" width="${n2(barW)}" height="${n2(fr.h)}" fill="none" stroke="${P.axis}" stroke-width="${n2(P.lw)}"/>`)
  if (spec.legendLabel) parts.push(T(P, bx + barW + fs * 0.35 + lgW + fs * 0.9, (fr.y0 + fr.y1) / 2, spec.legendLabel, { fs, fill: P.dim, anchor: 'middle', rotate: -90 }))
  if (!xB.length || !yB.length) parts.push(T(P, fr.x0 + fr.w / 2, fr.y0 + fr.h / 2, EMPTY_TXT[L.lang] || EMPTY_TXT.zh, { fs, fill: P.dim, anchor: 'middle' }))
  return { h: H, parts }
}

// ⑧ 散点。上万个点必然叠在一起，故点小且半透明 —— 叠得越厚颜色越实，密度自己显出来。
// capped 给的是「画了几个 / 共几个」，照数写成读数行
function drawScatter(spec, P, L) {
  const fs = L.fs, W = L.width
  const pts = (Array.isArray(spec.pts) ? spec.pts : []).filter((p) => p && Number.isFinite(+p.x) && Number.isFinite(+p.y))
  const H = L.height || Math.round(W * 0.56)
  const xr = Array.isArray(spec.xRange) && spec.xRange.length === 2 ? spec.xRange.map(num) : null
  const yr = Array.isArray(spec.yRange) && spec.yRange.length === 2 ? spec.yRange.map(num) : null
  const xlo = xr ? Math.min(xr[0], xr[1]) : (pts.length ? minOf(pts, (p) => +p.x) : 0)
  const xhi = xr ? Math.max(xr[0], xr[1]) : (pts.length ? maxOf(pts, (p) => +p.x) : 1)
  const ylo = yr ? Math.min(yr[0], yr[1]) : (pts.length ? minOf(pts, (p) => +p.y) : 0)
  const yhi = yr ? Math.max(yr[0], yr[1]) : (pts.length ? maxOf(pts, (p) => +p.y) : 1)

  const capped = spec.capped && Number.isFinite(+spec.capped.shown) && Number.isFinite(+spec.capped.total) ? spec.capped : null
  const headH = capped ? fs * 1.4 : 0
  const ysc = valueScale(ylo, yhi, Math.max(3, Math.min(7, Math.floor((H - headH) / (fs * 3.2)))), false)
  const mL = yAxisMetrics(ysc, fs, spec.yLabel)
  const mR = fs * 1.2
  const plotW = Math.max(30, W - mL - mR)
  const mT = fs * 0.9 + headH
  const mB = fs * 1.65 + (spec.xLabel ? AXL_H * fs : 0)
  const fr = { x0: mL, y0: mT, x1: mL + plotW, y1: mT + Math.max(20, H - mB - mT), w: plotW, h: Math.max(20, H - mB - mT) }
  const parts = []
  if (capped) {
    const s = (SAMPLED_TXT[L.lang] || SAMPLED_TXT.zh) + ' ' + fmtInt(capped.shown) + ' / ' + fmtInt(capped.total)
    parts.push(T(P, W - mR, fs * 1.05, s, { fs: fs * 0.9, fill: P.dim, anchor: 'end' }))
  }
  parts.push(...yAxisParts(P, fr, ysc, fs, spec.yLabel))
  const xsc = valueScale(xlo, xhi, Math.max(2, Math.min(9, Math.floor(fr.w / (fs * 4.2)))), false)
  const mapX = (v) => fr.x0 + ((v - xsc.min) / ((xsc.max - xsc.min) || 1)) * fr.w
  const mapY = (v) => fr.y1 - ((v - ysc.min) / ((ysc.max - ysc.min) || 1)) * fr.h
  for (const t of xsc.ticks) {
    const x = mapX(t)
    parts.push(line(x, fr.y1, x, fr.y1 + fs * 0.32, P.axis, P.lw))
    parts.push(T(P, x, fr.y1 + fs * 1.3, grp(fmtStep(t, xsc.step)), { fs: fs * 0.9, fill: P.dim, anchor: 'middle' }))
  }
  const r = Math.max(1.3, fs * 0.16)
  const op = pts.length > 4000 ? 0.28 : pts.length > 1200 ? 0.42 : pts.length > 300 ? 0.62 : 0.85
  const dots = []
  for (const p of pts) dots.push(`<circle cx="${n2(mapX(+p.x))}" cy="${n2(mapY(+p.y))}" r="${n2(r)}"/>`)
  if (dots.length) parts.push(`<g fill="${P.series[0]}" fill-opacity="${op}">${dots.join('')}</g>`)
  if (spec.xLabel) parts.push(T(P, fr.x0 + fr.w / 2, H - AXL_Y * fs, spec.xLabel, { fs, fill: P.dim, anchor: 'middle' }))
  if (!pts.length) parts.push(T(P, fr.x0 + fr.w / 2, fr.y0 + fr.h / 2, EMPTY_TXT[L.lang] || EMPTY_TXT.zh, { fs, fill: P.dim, anchor: 'middle' }))
  return { h: H, parts }
}

// ⑨ 竖柱（逐年计数，可堆叠，样式规范 §F2.3）。spec = { x: 年份[], series: [{ key, name, data }], xIsYear, partialLast }。
// 计数用竖柱、存量用折线；多序列一律自下而上堆叠（同量纲才堆，不同量纲拆图，不做双轴）。
// 柱宽 ≤ 槽宽 70%，方端；段间 0.75 pt 白缝；末期不完整时末柱降为 40% 填色加同色描边（§F.5）。
function drawCol(spec, P, L) {
  const fs = L.fs, W = L.width
  const xs = (Array.isArray(spec.x) ? spec.x : []).map(num)
  const series = (Array.isArray(spec.series) ? spec.series : []).filter((se) => se && Array.isArray(se.data))
  const n = xs.length
  const H = L.height || Math.round(W * 0.5)
  let maxV = 0
  const tot = new Array(n).fill(0)
  for (let i = 0; i < n; i++) { for (const se of series) tot[i] += Math.max(0, num(se.data[i])); if (tot[i] > maxV) maxV = tot[i] }
  const items = series.length > 1 ? series.map((se, i) => ({ label: se.name, color: serColor(P, se, i) })) : []
  const legW = W * LEG_W
  const legH = items.length ? legendHeight(items, legW, fs, P) : 0
  const sc = countScale(maxV, Math.max(3, Math.min(7, Math.floor((H - legH) / (fs * 3.2)))))
  const mL = yAxisMetrics(sc, fs, spec.yLabel)
  const mR = fs * 1.2
  const plotW = Math.max(30, W - mL - mR)
  const mT = fs * 0.9 + legH
  const mB = fs * 1.65 + (spec.xLabel ? AXL_H * fs : 0)
  const fr = { x0: mL, y0: mT, x1: mL + plotW, y1: mT + Math.max(20, H - mB - mT), w: plotW, h: Math.max(20, H - mB - mT) }
  const parts = []
  if (items.length) parts.push(...legendParts(P, items, mL, fs * 0.2, legW, fs).parts)
  parts.push(...yAxisParts(P, fr, sc, fs, spec.yLabel))
  const mapY = (v) => fr.y1 - ((v - sc.min) / ((sc.max - sc.min) || 1)) * fr.h
  const slot = n ? fr.w / n : fr.w
  const bw = Math.max(0.6, slot * 0.7)
  const seam = P.paperTheme ? fs * 0.094 : Math.max(1, fs * 0.1)      // 0.75 pt 段间白缝
  const partial = !!spec.partialLast && n >= 1
  for (let i = 0; i < n; i++) {
    const cx = fr.x0 + slot * (i + 0.5)
    let acc = 0
    const last = partial && i === n - 1
    for (let si = 0; si < series.length; si++) {
      const v = Math.max(0, num(series[si].data[i]))
      if (v <= 0) continue
      const yTop = mapY(acc + v), yBot = mapY(acc)
      acc += v
      const top = si < series.length - 1 && acc < tot[i] ? seam : 0     // 上面还有段才留缝
      const h = yBot - yTop - Math.min(top, (yBot - yTop) / 2)
      if (h <= 0.1) continue
      const color = serColor(P, series[si], si)
      if (last) parts.push(rect(cx - bw / 2, yTop + (yBot - yTop - h), bw, h, color, ` fill-opacity="0.4" stroke="${color}" stroke-width="${n2(P.lw)}" data-partial="1"`))
      else parts.push(rect(cx - bw / 2, yTop + (yBot - yTop - h), bw, h, color))
    }
  }
  // 横轴：年份档每 10 年（跨度短退到 5 / 2 / 1），刻度落在柱心上；年份不分组
  if (n) {
    const span = Math.max(1, xs[n - 1] - xs[0])
    const wantN = Math.max(2, Math.min(12, Math.floor(fr.w / (fs * 4.2))))
    let step = [1, 2, 5, 10, 20, 25, 50].find((st) => span / st <= wantN) || 100
    if (spec.xIsYear && step < 10 && span / 10 >= 3.5) step = 10
    for (let i = 0; i < n; i++) {
      if (Math.round(xs[i]) % step !== 0) continue
      const x = fr.x0 + slot * (i + 0.5)
      parts.push(line(x, fr.y1, x, fr.y1 + fs * 0.25, P.axis, P.lw))
      parts.push(T(P, x, fr.y1 + fs * 1.3, spec.xIsYear ? String(Math.round(xs[i])) : grp(String(xs[i])), { fs: fs * 0.9, fill: P.dim, anchor: 'middle' }))
    }
  }
  if (spec.xLabel) parts.push(T(P, fr.x0 + fr.w / 2, H - AXL_Y * fs, spec.xLabel, { fs, fill: P.dim, anchor: 'middle' }))
  if (!n || !series.length) parts.push(T(P, fr.x0 + fr.w / 2, fr.y0 + fr.h / 2, EMPTY_TXT[L.lang] || EMPTY_TXT.zh, { fs, fill: P.dim, anchor: 'middle' }))
  return { h: H, parts }
}

// ⑩ 堆叠直方（相邻箱首尾相接，样式规范 §F2.1 的 LEO 密度剖面）。spec = { bins: [{ x0, x1 }], series: [{ key, name, data }] }。
// 自下而上按 series 顺序堆（载荷 / 火箭体 / 碎片 / 未知），段间 0.75 pt 白缝；量不必是整数（空间密度）。
function drawStackHist(spec, P, L) {
  const fs = L.fs, W = L.width
  const bins = (Array.isArray(spec.bins) ? spec.bins : []).filter((b) => b && Number.isFinite(+b.x0) && Number.isFinite(+b.x1))
  const series = (Array.isArray(spec.series) ? spec.series : []).filter((se) => se && Array.isArray(se.data))
  const n = bins.length
  const H = L.height || Math.round(W * 0.62)
  const tot = new Array(n).fill(0)
  let maxV = 0
  for (let i = 0; i < n; i++) { for (const se of series) tot[i] += Math.max(0, num(se.data[i])); if (tot[i] > maxV) maxV = tot[i] }
  const items = series.map((se, i) => ({ label: se.name, color: serColor(P, se, i) }))
  const legW = W * LEG_W
  const legH = items.length > 1 ? legendHeight(items, legW, fs, P) : 0
  const sc = valueScale(0, maxV > 0 ? maxV : 1, Math.max(3, Math.min(7, Math.floor((H - legH) / (fs * 3.2)))), true, false)
  sc.ticks = sc.ticks.filter((t) => t >= 0)
  sc.min = 0
  const mL = yAxisMetrics(sc, fs, spec.yLabel)
  const mR = fs * 1.2
  const plotW = Math.max(30, W - mL - mR)
  const mT = fs * 0.9 + legH
  const mB = fs * 1.65 + (spec.xLabel ? AXL_H * fs : 0)
  const fr = { x0: mL, y0: mT, x1: mL + plotW, y1: mT + Math.max(20, H - mB - mT), w: plotW, h: Math.max(20, H - mB - mT) }
  const parts = []
  if (items.length > 1) parts.push(...legendParts(P, items, mL, fs * 0.2, legW, fs).parts)
  parts.push(...yAxisParts(P, fr, sc, fs, spec.yLabel))
  const xlo = n ? +bins[0].x0 : 0, xhi = n ? +bins[n - 1].x1 : 1
  const mapX = (v) => fr.x0 + ((v - xlo) / ((xhi - xlo) || 1)) * fr.w
  const mapY = (v) => fr.y1 - ((v - sc.min) / ((sc.max - sc.min) || 1)) * fr.h
  const seam = P.paperTheme ? fs * 0.094 : Math.max(1, fs * 0.1)
  for (let i = 0; i < n; i++) {
    const xa = mapX(+bins[i].x0), xb = mapX(+bins[i].x1)
    let acc = 0
    for (let si = 0; si < series.length; si++) {
      const v = Math.max(0, num(series[si].data[i]))
      if (v <= 0) continue
      const yTop = mapY(acc + v), yBot = mapY(acc)
      acc += v
      const top = acc < tot[i] ? seam : 0
      const h = yBot - yTop - Math.min(top, (yBot - yTop) / 2)
      if (h <= 0.05) continue
      // 相邻箱补 0.5 px 重叠：首尾相接的直方，箱间留缝会被读成「这两层之间是空的」
      parts.push(rect(xa, yTop + (yBot - yTop - h), xb - xa + 0.5, h, serColor(P, series[si], si)))
    }
  }
  const xsc = niceScale(xlo, xhi, Math.max(2, Math.min(10, Math.floor(fr.w / (fs * 4.2)))))
  for (const t of xsc.ticks) {
    if (t < xlo - 1e-9 || t > xhi + 1e-9) continue
    const x = mapX(t)
    parts.push(line(x, fr.y1, x, fr.y1 + fs * 0.25, P.axis, P.lw))
    parts.push(T(P, x, fr.y1 + fs * 1.3, grp(fmtStep(t, xsc.step)), { fs: fs * 0.9, fill: P.dim, anchor: 'middle' }))
  }
  if (spec.xLabel) parts.push(T(P, fr.x0 + fr.w / 2, H - AXL_Y * fs, spec.xLabel, { fs, fill: P.dim, anchor: 'middle' }))
  if (!n || !series.length) parts.push(T(P, fr.x0 + fr.w / 2, fr.y0 + fr.h / 2, EMPTY_TXT[L.lang] || EMPTY_TXT.zh, { fs, fill: P.dim, anchor: 'middle' }))
  return { h: H, parts }
}

const DRAW = { bar: drawBar, hbar: drawHbar, stack: drawStack, line: drawLine, hist: drawHist, strip: drawStrip, heat: drawHeat, scatter: drawScatter, col: drawCol, stackhist: drawStackHist }

/**
 * spec → SVG 串。
 * o = { theme: 'screen' | 'print', width, height?, fonts?: { latin, cjkBody }, lang?: 'zh' | 'en' }
 * height 缺省按类型给：hbar 随条数长，其余落在 16:9 一带。
 * 入参怎么残缺都不抛错 —— 报告里少一张图可以，整份报告因为一个空数组出不来不行。
 */
export function chartSvg(spec, o) {
  const opt = o || {}
  const theme = opt.theme === 'print' ? 'print' : opt.theme === 'paper' ? 'paper' : 'screen'
  let width, fs, P, height
  if (theme === 'paper') {
    // 纸面档（样式规范 §F.1）：按物理尺寸（mm，96 dpi）画，scale 只给屏上纸面缩放用；图内字号恒为 8 pt。
    // 导出时 scale = 1、栅格倍率另给（600 dpi = 6.25 倍），放进 Word 按原物理尺寸、不缩放。
    const k = num(opt.scale) > 0 ? num(opt.scale) : 1
    const wMm = num(opt.widthMm) > 0 ? num(opt.widthMm) : 160
    const hMm = num(opt.heightMm) > 0 ? num(opt.heightMm) : 80
    width = Math.max(60, Math.round(wMm * MM * k))
    height = Math.max(30, Math.round(hMm * MM * k))
    fs = 8 * PT * k
    P = palette('paper', null, k)
    P.fsText = fs
  } else {
    width = Math.max(180, Math.round(num(opt.width) || 640))
    // 字号随图宽走：同一份 spec 屏上 700 px、报告里 1200 px，字号不跟着放大就成了蚂蚁
    fs = clamp(Math.round(width / 62), 10, 20)
    P = palette(theme, opt.fonts)
    height = Math.max(0, Math.round(num(opt.height))) || 0
  }
  const L = { fs, width, height, lang: opt.lang === 'en' ? 'en' : 'zh' }
  const s = spec && typeof spec === 'object' ? spec : {}
  const fn = DRAW[s.type] || null

  let body = [], H
  if (fn) {
    const r = fn(s, P, L)
    body = r.parts
    H = Math.max(40, Math.round(r.h))
  } else {
    // 认不出的 type：出一张空图而不是抛 —— 上层拿到的是一份模型，不该因为一个键写错整份炸掉
    H = L.height || Math.round(width * 0.5)
    body = [T(P, width / 2, H / 2, EMPTY_TXT[L.lang] || EMPTY_TXT.zh, { fs, fill: P.dim, anchor: 'middle' })]
  }
  const open = `<svg xmlns="http://www.w3.org/2000/svg" class="ssa-fig" width="${width}" height="${H}" font-family="${P.ff}">`
  const head = P.print ? rect(0, 0, width, H, P.paper) : SCREEN_STYLE
  return open + head + body.join('') + '</svg>'
}

/**
 * 从出串里读回它的像素尺寸。导出那条路要按「2 倍」栅格化（svgToPngDataUrl(svg, w*2, h*2)，
 * 与 useLbReport 的 FIG_SCALE 同口径），而高度是本模块按类型自己定的 —— 调用方拿不到就只能
 * 在外面再写一遍正则。契约里没有这一支，是纯附加的便利函数，不用也不影响。
 */
export function svgSizeOf(svgText) {
  const s = String(svgText == null ? '' : svgText)
  const w = /<svg[^>]*\swidth="(\d+(?:\.\d+)?)"/.exec(s)
  const h = /<svg[^>]*\sheight="(\d+(?:\.\d+)?)"/.exec(s)
  return { width: w ? +w[1] : 0, height: h ? +h[1] : 0 }
}

export default chartSvg
