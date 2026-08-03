// 转发器频率计划 → 微信小程序（渲染端 ESM）。
//
// ★ 不在小程序重算版式。
//   layout() 依赖 resolveAll() 一整套口径：LO 推算与 cross-strap 解耦、波束占段的 tile|stack|full
//   三路、pickLane 分层、断口折叠、频带外不出片…… 这套口径 2026-07~08 连改三轮。在小程序照抄
//   一份 = 第二份真相，必漂（这份代码在「单位=整份计划的刻度」上已经吃过一次同样的亏）。
//   故平台在发送那一刻把 layout() 的几何连同 planBody 的落笔一起【摊平成一串绘制指令】，
//   小程序只做三件事：按指令画、按命中矩形认点击、按解析结果显示明细。零算法、零单位换算。
//   代价是诚实的：小程序看到的是【导入那一刻】的版式，平台后续改了计划要重发。
//
// ★★ 同样不送原始模型。送过去的是 resolveAll() 之后的【解析结果】——上下行频率已按 LO 推算
//   或按 cross-strap 显式值定好、带宽已按「波束组继承」解好、占段已按四路排好。原始模型里
//   剩下的都是录入期的簿记（beamSeg 的空壳、bandAuto、satFolder 这类本机指针），小程序既读
//   不懂也不该读。「只读」的定位下，解析结果就是全部信息。
//
// ★★★ 单位：整份计划一把刻度（同平台工具栏那个下拉）。小程序侧【不给单位切换】——刻度是整份
//   计划的属性，再给一个下拉就是第二个真相源（平台已为此清过一次账）。故这里把「怎么把 MHz
//   写成人读的数」也一并算好送过去：u = { label, f, dec }，小程序照 (mhz/f).toFixed(dec) 写。
//
// 包里一件 = 五样，各按同一条分工（版式与口径在这边算完，小程序只落笔）：
//   draw  绘制指令（频率计划图）        · chs/beams/los 解析结果（明细与详情卡）
//   alloc 频率分配表：核算 + 【频带条几何】（百分比，小程序按 % 落 view，见 ③b）
//   xlsx  Excel 数据表的表模型（列/行/数字格式，小程序交云函数刷格子，见 fpXlsxModel）

import {
  layout, DEFAULT_STYLE, loArrowGeom, markGeom, blockNoFs,
  loNoteText, beaconNoteText, fmtFreq
} from './freqPlanRender.js'
import {
  resolveAll, beamLabel, unitLabel, unitFactorMHz, fmtFreqNum,
  beamSegs, beamBw, beamSynthText, planSummary, KIND_LABEL
} from './freqPlanModel.js'
import { buildAllocation } from './freqPlanCapacity.js'
import { buildDataXlsx } from './fpXlsxModel.js'

// 亮色主题的墨色。★ 与 freqPlanRender 的 THEMES.light 同值（那份没有对外导出）——
// 小程序侧只有亮色（这张图对标的是印在纸上的标准计划图），故不镜像暗色那一套。
const T = { paper: '#ffffff', ink: '#1a1a1a', dim: '#666', line: '#333', blockStroke: '#8a6d1f', suspect: '#c62828', guide: '#888' }
const DEFAULT_BLOCK_COLOR = '#5B8FD4'

const n2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
// ★ 空值必须先挡掉再 Number()：Number(null) 与 Number('') 都是 0，而 0 是有限数 —— 不挡的话
//   整包的「留空」全成 0 发过去，小程序侧一律按 `== null` 判空显示「—」，兜底被 0 击穿：
//   没填的 SFD 写成「0 dBW/m²」、没定频的载波写成「0 ~ 0」，看着都像实打实的工程值
//   （同 fpXlsxModel 的 nz、freqPlanModel 的 num()、freqPlanCapacity 的 numOrNull）。
const nz = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// 「M x,y L x,y L x,y Z」→ [x,y,x,y,x,y]。箭头头部由 loArrowGeom / markGeom 自绘成三角
// （不用 <marker>，见 freqPlanRender 文件头），这里只把那条路径拆回顶点给 canvas 用。
function triPts(d) {
  const m = String(d || '').match(/-?\d+(?:\.\d+)?/g)
  return m && m.length >= 6 ? m.slice(0, 6).map(Number) : null
}

// ============================================================================
// ① 绘制指令：layout() 的几何 + planBody() 的落笔，摊平成一串 op
// ============================================================================
// op 的键刻意压到一个字符：94 波束的 HTS 计划有上千条 op，键名长一个字符就多几 KB，
// 而云函数的返回上限是 1 MB（见 miniPack 的 SIZE_MAX）。
//   { k:'r', x,y,w,h, f?填色, s?描边, sw?线宽, d?虚线[a,b] }
//   { k:'l', a:[x1,y1,x2,y2], s, sw }
//   { k:'c', x,y,r, f }
//   { k:'g', p:[x,y,…], f }                       多边形（箭头头部）
//   { k:'t', x,y, v:文字, fs, f, m?:'middle'|'end', b?:1 粗体 }

export function drawOps(plan, styleIn = {}) {
  const st = { ...DEFAULT_STYLE, ...styleIn, theme: 'light' }
  const L = layout(plan, st)
  const fs = st.fontSize
  const sw = 1
  const ops = []
  const hits = []
  const legend = []
  const rect = (x, y, w, h, o) => ops.push({ k: 'r', x: n2(x), y: n2(y), w: n2(w), h: n2(h), ...o })
  const line = (x1, y1, x2, y2, s, w) => ops.push({ k: 'l', a: [n2(x1), n2(y1), n2(x2), n2(y2)], s, sw: n2(w) })
  const text = (x, y, v, size, fill, o) => { if (v !== '' && v != null) ops.push({ k: 't', x: n2(x), y: n2(y), v: String(v), fs: n2(size), f: fill, ...o }) }
  const tri = (d, f) => { const p = triPts(d); if (p) ops.push({ k: 'g', p: p.map(n2), f }) }

  if (L.empty) {
    text(L.width / 2, L.height / 2, 'Frequency plan is empty — no transponders', fs, T.dim, { m: 'middle' })
    return { w: L.width, h: L.height, ops, hits, legend }
  }

  for (const band of L.bands) {
    text(st.padX - st.titleIndent, band.titleY + fs, band.title, fs * 1.15, T.ink, { b: 1 })
    if (st.showGuides) {
      for (const gx of [band.axisX0, band.axisX1]) line(gx, band.guideY0, gx, band.guideY1, T.guide, sw * 2.2)
      if (band.endLabelsFit) {
        text(band.axisX0, band.endLabelY, fmtFreq(band.guideExt.dataMin, st.unit), fs * 0.86, T.dim, { m: 'middle' })
        text(band.axisX1, band.endLabelY, fmtFreq(band.guideExt.dataMax, st.unit), fs * 0.86, T.dim, { m: 'middle' })
      }
    }
    for (const [x0, x1] of band.baseSegs) line(x0, band.baselineY, x1, band.baselineY, T.line, sw * 1.6)
    for (const br of band.breaks) for (const cx of br.dots) ops.push({ k: 'c', x: n2(cx), y: n2(br.y), r: n2(br.dotR), f: T.line })
    band.pols.forEach((p, i) => text(st.padX - st.polIndent, band.rowMidY[i] + fs * 0.36, p, fs * 1.05, T.ink, { m: 'end' }))
  }

  for (const b of L.blocks) {
    if (b.mark) {
      // 标记类载波（信标 / 遥控 / 遥测）：一根从频率轴上立起来的谱线，不是色块
      const g = b.markG || markGeom(b, st)
      const ink = b.suspect ? T.suspect : T.ink
      line(g.x, g.y0, g.x, g.lineY1, ink, sw * 1.5)
      tri(g.head, ink)
    } else {
      // 先无描边地铺色片，再在整块上压一圈描边——逐片带描边的话片与片之间会多出两道横线
      for (const sp of b.stripes) rect(sp.x, sp.y, sp.w, sp.h + 0.3, { f: sp.color || DEFAULT_BLOCK_COLOR })
      rect(b.x, b.y, b.w, b.h, {
        s: b.suspect ? T.suspect : T.blockStroke,
        sw: n2(b.suspect ? sw * 2 : sw * 1.4),
        ...(b.derived ? { d: [n2(sw * 3), n2(sw * 2)] } : {})
      })
      const maxFs = blockNoFs(b, fs)
      // ink 为 null = 编号压在那截未分配的留白上（频分占用时的常态）→ 取纸面的墨色
      if (maxFs) text(b.x + b.w / 2, b.y + b.h / 2 + maxFs * 0.35, b.no, maxFs, b.ink || T.ink, { m: 'middle' })
    }
    if (st.showFreqLabels && Number.isFinite(b.fc)) {
      const ty = b.labelSide === 'above' ? b.labelY + fs * 0.9 : b.labelY + fs * 0.95
      text(b.x + b.w / 2, ty, fmtFreq(b.fc, st.unit), fs * 0.86, T.dim, { m: 'middle' })
    }
    // 命中区：色块就是它自己那一格；标记类取 markGeom 那个比箭头宽出几像素的框——
    // 箭头本身只有几个像素宽，照 b.w 发过去在手机上根本点不中
    const hb = b.mark ? (b.markG || markGeom(b, st)).hit : b
    hits.push({ id: b.channelId, side: b.side, x: n2(hb.x), y: n2(hb.y), w: n2(hb.w), h: n2(hb.h), mark: b.mark ? 1 : 0 })
  }

  // LO 变频箭头（上行带底 → 下行带顶）
  const arrow = st.showLo && plan.los?.length ? loArrowGeom(L, st) : null
  if (arrow) {
    line(arrow.x, arrow.y0, arrow.x, arrow.lineY1, T.line, sw * 1.6)
    tri(arrow.head, T.line)
    text(arrow.textX, arrow.textY, loNoteText(plan, st.unit), fs * 0.95, T.ink)
  }

  // 波束/带宽 图例（点它高亮那个波束的块，故连 beamId 一并留下命中矩形）
  if (L.legend) {
    for (const it of L.legend.items) {
      rect(it.x, it.y, it.sq * 1.6, it.sq, { f: it.color || DEFAULT_BLOCK_COLOR, s: T.blockStroke, sw })
      text(it.textX, it.y + it.sq * 0.82, it.label, fs * 0.92, T.ink)
      legend.push({ beamId: it.id, x: n2(it.x), y: n2(it.y - it.sq * 0.2), w: n2(it.sq * 1.6 + it.label.length * fs * 0.6), h: n2(it.sq * 1.4) })
    }
  }

  // 信标 / 遥测 一行注记
  if (L.loY != null) text(st.padX, L.loY + fs, beaconNoteText(plan, st.unit), fs * 0.9, T.dim)

  return { w: L.width, h: Math.ceil(L.height), ops, hits, legend, paper: T.paper }
}

// ============================================================================
// ② 解析结果：转发器清单 / 波束 / LO —— 小程序的明细与详情卡都读这一份
// ============================================================================

const sideOf = (s) => (s ? { fc: nz(s.fc), bw: nz(s.bw), f1: nz(s.f1), f2: nz(s.f2), pol: s.pol || '' } : null)
const beamRef = (b) => ({ id: b.id, name: b.name || '', color: b.color || DEFAULT_BLOCK_COLOR })
const segRef = (g) => ({ beamId: g.beam?.id || '', beam: g.beam?.name || '', f1: nz(g.f1), f2: nz(g.f2), bw: nz(g.bw), full: !!g.full, from: g.from || '' })

export function resolvedChannels(plan, unit = 'MHz') {
  return resolveAll(plan).map((r) => ({
    id: r.id,
    no: r.no || '',
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind] || r.kind,
    mark: !!r.mark,
    markSide: r.side || '',
    up: sideOf(r.up),
    dn: sideOf(r.dn),
    // 下行是推算出来的还是显式填的（cross-strap）；带宽是自填的还是从波束组继承的
    dnDerived: !!r.dnDerived,
    bwFromBeam: !!r.bwFromBeam,
    lo: r.lo ? { id: r.lo.id, name: r.lo.name || '', value: nz(r.lo.valueMHz) } : null,
    beamsUp: (r.beamsUp || []).map(beamRef),
    beamsDn: (r.beamsDn || []).map(beamRef),
    segsUp: (r.segsUp || []).map(segRef),
    segsDn: (r.segsDn || []).map(segRef),
    // 接链路预算用的五项（留空 = 链路预算仍用卫星配置里手填的那份）
    sfd: nz(r.raw?.sfdDbwm2),
    gt: nz(r.raw?.gtDbK),
    boi: nz(r.raw?.boiDb),
    boo: nz(r.raw?.booDb),
    cim: nz(r.raw?.cimDb),
    note: r.raw?.note || '',
    label: beamLabelOf(r, unit)
  }))
}

// 该条转发器在图例上对应的那行标签（多波束写成「A + B」，与图上的块内读法一致）
const beamLabelOf = (r, unit) => (r.beamsUp || []).map((b) => beamLabel(b, unit)).join(' + ')

// 这个波束在整份计划里实际占到的那几段频率：逐条转发器的占段汇总，压在一起的并成一段。
// ★ 段位是转发器的属性（波束只有标称带宽），故这里是【算出来的】而不是波束身上存的 ——
//   小程序侧的字段没变（up.bands / dn.bands），读法与从前一致。
function beamBandsOf(plan, beamId, side) {
  const spans = []
  for (const ch of plan.channels || []) {
    for (const g of beamSegs(plan, ch, side)) {
      if (g.beam.id !== beamId || g.f1 == null || g.f2 == null) continue
      spans.push([g.f1, g.f2])
    }
  }
  spans.sort((a, b) => a[0] - b[0])
  const out = []
  for (const [f1, f2] of spans) {
    const last = out[out.length - 1]
    if (last && f1 <= last[1] + 1e-6) last[1] = Math.max(last[1], f2)
    else out.push([f1, f2])
  }
  return out.map(([f1, f2]) => ({ f1: nz(f1), f2: nz(f2), bw: nz(f2 - f1) }))
}

export function resolvedBeams(plan, unit = 'MHz') {
  return (plan.beams || []).map((b) => ({
    id: b.id,
    name: b.name || '',
    color: b.color || DEFAULT_BLOCK_COLOR,
    label: beamLabel(b, unit),
    synth: beamSynthText(b) || '',
    // 带宽是一个数（收发不等宽在占段那边表达），两侧仍各给各的 bands —— 一个波束在两侧占的段不同
    bw: nz(beamBw(b)),
    up: { bands: beamBandsOf(plan, b.id, 'up') },
    dn: { bands: beamBandsOf(plan, b.id, 'dn') }
  }))
}

// ============================================================================
// ③ 频率分配表：这份计划里每条转发器上摆了哪些载波
// ============================================================================
// 核算一个数都不在这里另算——全部来自 buildAllocation（平台屏上那张表吃的同一份）。
// 读法一律带兜底：这个模块正在演进（组头新增过工作侧/波束归属两档），字段名变了也不该让
// 「发送到小程序」整条路断掉。
//
// ★ 侧：side='dn'，与平台屏上那一页【同侧】。分配表只写下行是现场口径（频谱仪摆在接收站那
//   一侧，卖出去的也是下行那一段，见 FpAlloc 文件头）；从前这里送的是 side='up'，于是同一份
//   计划在平台上与在小程序上写的是两组数 —— 收发不等宽的转发器（18 上 / 36 下）连带宽都对不上。
//   两侧的读数仍各给各的（row.up / row.dn、group.up / group.dn），只有几何与核算落在下行。

function allocRow(r) {
  const u = r.up || {}
  const d = r.dn || {}
  return {
    id: r.c?.id || '',
    idx: r.idx,
    name: r.c?.name || '',
    up: { fc: nz(u.fc), f1: nz(u.f1), f2: nz(u.f2) },
    dn: { fc: nz(d.fc), f1: nz(d.f1), f2: nz(d.f2) },
    occ: nz(r.occ),
    pwr: nz(r.pwr),
    rate: nz(r.c?.infoRateKbps),
    modcod: r.c?.modcod || '',
    pol: r.pol || '',
    polInherited: !!r.polInherited,
    beam: r.beam?.name || '',
    beamColor: r.beam?.color || '',
    placed: r.placed !== false,
    note: r.c?.note || ''
  }
}

function allocGroup(g) {
  return {
    channelId: g.channelId || '',
    no: g.no || '',
    orphan: !!g.orphan,
    bw: nz(g.bwMHz),
    // 工作侧（下行）的频带 = 条上画的那一段；两侧的读数并排给，组头两行都写得出
    up: { fc: nz(g.upFc), f1: nz(g.upF1), f2: nz(g.upF2), pol: g.upPol || '' },
    dn: { fc: nz(g.dnFc ?? g.fc), f1: nz(g.dnF1 ?? g.f1), f2: nz(g.dnF2 ?? g.f2), pol: g.dnPol || g.pol || '' },
    beam: g.beamText || g.beam || '',
    beams: (g.beams || []).map(beamRef),
    count: g.count || (g.rows || []).length,
    occSum: nz(g.occSum),
    pwrSum: nz(g.pwrSum),
    rateSum: nz(g.rateSum),
    bwUtil: nz(g.bwUtil),
    pwrUtil: nz(g.pwrUtil),
    freeMHz: nz(g.freeMHz),
    // 核算条目只出数值与定位，不下「达标/受限」这类文字判定（平台既定口径）。
    // carrierId 一并送：条上把出问题的那一块描红要靠它认（同 FpAlloc 的 bads）
    issues: (g.issues || []).map((i) => ({ code: i.code || '', msg: i.msg || '', carrierId: i.carrierId || '' })),
    rows: (g.rows || []).map(allocRow),
    strip: stripGeom(g),
    mini: miniGeom(g)
  }
}

// ---------------------------------------------------------------------------
// ③b 频带条几何：把 FpAlloc 屏上那条条摊平成百分比
// ---------------------------------------------------------------------------
// 与「① 绘制指令」同一条思路 —— 版式在平台算完，小程序只按百分比落 view，零算法。
// 口径逐条照抄 FpAlloc（barsOf / segsOf / paintOf / gradOf / miniOf / inkOf）：小程序上看到的
// 必须与平台屏上是同一条条，不是另画一张。
//   · 视域 = 频带 ∪ 所有载波块，两端各留 5% —— 越界的载波必须看得见，不能画到条外面去；
//   · 载波块按【所属波束】着色，跨切点的按段分色（渐变停靠点直接写成 CSS，小程序认同一串）；
//   · 波束占段画成条顶的色带，同频叠放的各错开一层（只画最后一个等于把别的藏了）；
//   · 保护带不送：它是录入期的吸附靶（默认 0），只读页上没有它管的事。

const pcx = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null)
// ★ 条上那几个频率读数收到 kHz（不是 n2 的 0.01 MHz）：刻度切到 kHz 时小数位是 0，
//   拿 0.01 MHz 收过的数写出来会差十个 kHz —— 与表里同一条载波的读数对不上。
const nf = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null)

// 白字压不住浅色（黄、浅青），按亮度翻墨色 —— 门限 0.42 与 FpAlloc 的 inkOf 同值，
// 同一个波束在两处不该一处白字一处黑字
function lum(hex) {
  const h = String(hex || '').replace('#', '')
  if (h.length !== 6) return 0
  const ch = (i) => parseInt(h.slice(i, i + 2), 16) / 255
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4))
}
const inkOf = (hex) => (lum(hex) > 0.42 ? '#17181a' : '#ffffff')

// 定频的按自己的【起~止】落位，未定频的顺次铺在频带起点之后（小程序侧画成斜纹）
function barsOf(g) {
  const out = []
  let cursor = Number.isFinite(g.f1) ? g.f1 : null
  for (const r of g.rows || []) {
    if (r.occ == null) continue
    if (r.placed) out.push({ r, a: r.f.f1, b: r.f.f2, placed: true })
    else if (cursor != null) { out.push({ r, a: cursor, b: cursor + r.occ, placed: false }); cursor += r.occ }
  }
  return out
}

// 波束占段 → 条顶的色带。挨着不算叠着（频分排布的相邻两段共一条边），叠着的各错一层。
function laneSegs(g) {
  const band = Number.isFinite(g.f1) && Number.isFinite(g.f2) && g.f2 > g.f1
  const list = (g.segs || []).filter((s) => s?.beam && Number.isFinite(s.f1) && Number.isFinite(s.f2)
    && s.f2 > s.f1 && (!band || (s.f1 < g.f2 - 1e-6 && s.f2 > g.f1 + 1e-6)))
  if (!list.length || (list.length === 1 && list[0].full)) return { lanes: 0, segs: [] }
  const lanes = []
  const laneOf = (a, b) => {
    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k].every((p) => a >= p[1] - 1e-6 || b <= p[0] + 1e-6)) { lanes[k].push([a, b]); return k }
    }
    lanes.push([[a, b]])
    return lanes.length - 1
  }
  const segs = list.map((s) => ({ s, lane: laneOf(s.f1, s.f2) }))
  return { lanes: Math.max(1, lanes.length), segs }
}

// 跨两个波束的载波按切点分色：切点从它身上穿过时，只涂一个色等于把它整条判给了其中一个。
// ★ 只吃 splitSegs（两两不重叠）—— 同频叠放的那种排出来的停靠点会「回头」，整条被钳成头一个色。
function gradOf(g, a, b, base) {
  const segs = g.splitSegs || []
  const w = b - a
  if (!(w > 0) || segs.length < 2) return ''
  const parts = []
  for (const s of segs) {
    const x1 = Math.max(a, s.f1), x2 = Math.min(b, s.f2)
    if (x2 - x1 > w * 1e-6) parts.push({ c: s.beam?.color || base, a: (x1 - a) / w, b: (x2 - a) / w })
  }
  if (parts.length < 2) return ''
  parts.sort((x, y) => x.a - y.a)
  const st = []
  let cur = 0
  const at = (t) => (Math.round(t * 1000) / 10) + '%'
  for (const p of parts) {
    if (p.a > cur) st.push(`${base} ${at(cur)}`, `${base} ${at(p.a)}`)
    st.push(`${p.c} ${at(p.a)}`, `${p.c} ${at(p.b)}`)
    cur = p.b
  }
  if (cur < 1) st.push(`${base} ${at(cur)}`, `${base} 100%`)
  return `linear-gradient(to right, ${st.join(',')})`
}

function stripGeom(g) {
  if (g.orphan) return null
  const f1 = nz(g.f1), f2 = nz(g.f2)
  if (f1 == null || f2 == null || !(f2 > f1)) return null      // 没有下行频带 —— 条画不出来
  const bars = barsOf(g)
  let a = f1, b = f2
  for (const bb of bars) { if (bb.a < a) a = bb.a; if (bb.b > b) b = bb.b }
  const pad = (b - a) * 0.05 || 1
  const d0 = a - pad, d1 = b + pad
  const span = d1 - d0
  const pc = (m) => pcx(((m - d0) / span) * 100)
  const wpc = (w) => pcx((w / span) * 100)
  const bad = new Set((g.issues || []).map((i) => i.carrierId).filter(Boolean))
  const L = laneSegs(g)
  return {
    d0: nf(d0), d1: nf(d1),
    band: { left: pc(f1), width: wpc(f2 - f1) },
    lanes: L.lanes,
    segs: L.segs.map(({ s, lane }) => ({
      left: pc(s.f1), width: wpc(s.f2 - s.f1), lane,
      color: s.beam.color || DEFAULT_BLOCK_COLOR, name: s.beam.name || ''
    })),
    bars: bars.map((bb) => {
      const color = bb.r.beam?.color || DEFAULT_BLOCK_COLOR
      const bg = bb.placed ? gradOf(g, bb.a, bb.b, color) : ''
      return {
        id: bb.r.c.id, name: bb.r.c.name || '',
        left: pc(bb.a), width: wpc(bb.b - bb.a),
        color, bg, ink: inkOf(color), placed: !!bb.placed,
        bad: bad.has(bb.r.c.id),
        // 功率带宽作底衬：从块的左沿起画，与占用带宽同轴比对，超出块宽即功率限
        pwr: bb.r.pwr ? wpc(bb.r.pwr) : null,
        f1: nf(bb.a), f2: nf(bb.b), occ: nz(bb.r.occ)
      }
    }),
    // 轴：起 · 中 · 止（照运营装载表的写法，转发器身份就写这三个数）
    axis: [f1, (f1 + f2) / 2, f2].map((v) => ({ left: pc(v), v: nf(v) }))
  }
}

// 收起行里那条缩略占用条：只在频带内看位置，越界的裁掉（那一行本就只给一眼的量）
function miniGeom(g) {
  const f1 = nz(g.f1), f2 = nz(g.f2)
  if (g.orphan || f1 == null || f2 == null || !(f2 > f1)) return null
  const bw = f2 - f1
  return {
    segs: barsOf(g).map((bb) => ({
      left: pcx(Math.max(0, ((bb.a - f1) / bw) * 100)),
      width: pcx(Math.min(100, ((bb.b - bb.a) / bw) * 100)),
      color: bb.r.beam?.color || DEFAULT_BLOCK_COLOR,
      bg: bb.placed ? gradOf(g, bb.a, bb.b, bb.r.beam?.color || DEFAULT_BLOCK_COLOR) : '',
      placed: !!bb.placed
    })),
    pwr: pcx(Math.min(100, ((g.pwrSum || 0) / bw) * 100))
  }
}

export function allocationOf(plan, unit = 'MHz') {
  const carriers = Array.isArray(plan && plan.carriers) ? plan.carriers : []
  if (!carriers.length) return null
  let a
  try { a = buildAllocation(plan, carriers, { unit, side: 'dn' }) } catch (e) { return null }
  const un = (a.unassigned || []).map(allocRow)
  return {
    side: 'dn',
    groups: (a.groups || []).map(allocGroup).filter((g) => g.count > 0),
    unassigned: un,
    byBeam: (a.byBeam || []).map((b) => ({
      beam: b.beam || '', tpCount: b.tpCount || 0, bw: nz(b.bwMHz),
      occ: nz(b.occMHz), pwr: nz(b.pwrMHz), rate: nz(b.rateKbps), carriers: b.carriers || 0
    })),
    summary: a.summary || null
  }
}

// ============================================================================
// ④ 出口
// ============================================================================

/**
 * 一份计划 → 包内一件。
 * @param {object} plan  freqPlan.get(id) 的原样内容（含 carriers）
 * @param {object} opts  { unit, style, xlsx } —— xlsx:false 只在包顶到上限时用（见 buildMiniPack）
 */
export function fpMiniItem(plan, opts = {}) {
  const unit = opts.unit || 'MHz'
  const style = { ...(opts.style || {}), unit }
  const chs = resolvedChannels(plan, unit)
  const tp = chs.filter((c) => c.kind === 'transponder').length
  const f = unitFactorMHz(unit)
  return {
    type: 'freq-plan',
    name: plan.name || '频率计划',
    // ★ satFolder（卫星树节点 key）是【发送方机器上】的指针，一律剥掉——同 lbShare 的 sanitize 口径
    meta: {
      id: plan.id || '',
      name: plan.name || '频率计划',
      satName: plan.satName || '',
      band: plan.band || '',
      note: plan.note || '',
      updatedAt: plan.updatedAt || '',
      summary: planSummary(plan, unit),
      channels: chs.length,
      transponders: tp,
      beams: (plan.beams || []).length,
      // 单位：整份计划一把刻度。小程序照 (mhz/f).toFixed(dec) 写，尾零剪掉——
      // 与 freqPlanModel.fmtFreqNum 同一条式子，参数由平台算好送过去，不可能两边不一样。
      u: { label: unitLabel(unit), f, dec: Math.min(9, Math.max(0, Math.round(Math.log10(f)) + 2)) }
    },
    draw: drawOps(plan, style),
    chs,
    beams: resolvedBeams(plan, unit),
    los: (plan.los || []).map((l) => ({ id: l.id, name: l.name || '', value: nz(l.valueMHz), note: l.note || '' })),
    alloc: allocationOf(plan, unit),
    // ★ Excel 数据表：送的是【表模型】（第几列写什么、什么格式），不是原始数据 —— 同 fpXlsxModel
    //   文件头那条分工，小程序侧的云函数只负责往格子里刷。这样纸上那两张表与平台导出的一模一样，
    //   列的取舍（空列不出、两列同义并成一列）也不必在小程序再写一遍。
    //   代价是包会变大（一条载波一行、一行二十来格），故 fpMiniItem 的调用方仍受 miniPack 的
    //   SIZE_MAX 约束 —— 发送前那一次 estimateBytes 会把它算进去。顶到上限时由调用方传
    //   xlsx:false 把它摘掉：图与分配表照送，总不能为了捎一张表把整包卡死在发不出去上。
    xlsx: opts.xlsx === false
      ? { kind: 'omitted', reason: '这份计划的内容较大，数据表没能随包发送 —— 请在仿真平台上直接导出（文件 → 导出 → 数据表）。' }
      : buildDataXlsx(plan, Array.isArray(plan.carriers) ? plan.carriers : [], { unit })
  }
}

/** 摘要（发送前的清单行用） */
export const fpMiniSummary = (plan, unit = 'MHz') => planSummary(plan, unit)

// 屏上/表上共用的读数写法，导出前的预览也走它（与 fmtFreqNum 同源）
export const fpFmt = (mhz, unit) => fmtFreqNum(mhz, unit)
