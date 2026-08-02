// 转发器频率计划 → Excel（渲染端 ESM，只产出「纯数据模型」）。
//
// 分工照 fpMiniExport 那条线：**版式与口径在渲染端算完，主进程只负责往格子里刷**。
//   · 频率的解析（LO 推算 / cross-strap 解耦 / 带宽从波束组继承）、载波的上下行换算、装填核算、
//     校验条目 —— 全部走 freqPlanModel / freqPlanCapacity 那一套现成口径，这里一个数都不另算；
//   · 主进程（electron/services/freqPlanXlsx.js）拿到的是「第几行第几列写什么、什么色、并到哪」，
//     不认识转发器也不认识波束。两处各写一遍口径必漂（这份代码在单位刻度上已吃过一次亏）。
//
// ★ 出去的必须是【纯数据】：Vue 的响应式 Proxy 过不了 structuredClone，塞进 ipcRenderer.invoke
//   会当场抛且没人 catch（见 ipc-no-reactive-proxy）。故这里逐字段取原始值重造对象，
//   绝不把 plan / beam / carrier 本身挂上去。
//
// 两种版式：
//   ① 'styled' —— 照《中星6D卫星C频段转发器频率分配表》那份的体例：
//        「总表」= 频率轴上的转发器排布（按极化分行、按波束着色、色块并成频率比例的格子区间），
//        「C-1A、2A、3A」这样每 3 条一张的分配表 = 逐转发器的载波占用条 + 使用情况总结 + 冲突明细。
//        频率 → 列的映射是等比的（同示例：一条 36 MHz 转发器占固定几列），故色块宽度即带宽。
//   ② 'data'   —— 纯数据表（十张分表：转发器 / 载波 / 波束 / 波束频段 / 波束占段 / 本振 /
//        核算 / 波束汇总 / 校验 / 概览）。一行一条记录、一列一个字段，供再加工与入库。
//
// 单位：整份计划一把刻度（同工具栏那个下拉）。频率与带宽一律按该刻度写成【数值】而不是字符串
//   —— 落进 Excel 还能求和排序；单位写在列头与标题上。

import {
  resolveAll, planExtent, beamLabel, beamBw, beamSynthText,
  fmtFreqNum, unitLabel, unitFactorMHz, KIND_LABEL, POL_LABEL, kindTag, isMarkKind,
  planSummary, validatePlan
} from './freqPlanModel.js'
import { buildAllocation } from './freqPlanCapacity.js'

const EPS = 1e-6

// ---- 单位 ----
// 小数位随刻度走，与屏上 fmtFreqNum 同一条规则（MHz 两位、往大刻度补一位、往小刻度取整）。
function unitOf(unit) {
  const f = unitFactorMHz(unit)
  const dec = Math.min(9, Math.max(0, Math.round(Math.log10(f)) + 2))
  return {
    label: unitLabel(unit),
    factor: f,
    dec,
    numFmt: dec ? '0.' + '0'.repeat(dec) : '0'
  }
}
// MHz → 该刻度下的数值。收到小数位上：Excel 里 3719.9999999999995 会原样显示。
const uv = (u, mhz) => (Number.isFinite(mhz) ? Number((mhz / u.factor).toFixed(u.dec)) : null)
// ★ 空值必须先挡掉再 Number()：Number(null) 与 Number('') 都是 0，而 0 是有限数 —— 不挡的话
//   「没填 SFD」「没填速率」会被导成一格实打实的 0，读表的人再也分不出「没录」与「录了 0」
//   （同 freqPlanModel 的 num()、freqPlanCapacity 的 numOrNull，这个坑在本模块吃过一次）。
const nz = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const s = (v) => (v == null ? '' : String(v))
// 标记类载波（信标 / 遥控 / 遥测）没有带宽：resolveChannel 给的 f1/f2 是 fc ∓ slot/2，
// 没给「间隔带宽」时两端就等于中心本身。那不是一段频带，故留空 —— 写两个一样的数只会
// 让人以为它占着一段零宽的频谱。
const spanEdge = (x, k) => (x && (Number.isFinite(x.bw) || Number.isFinite(x.slot)) ? x[k] : null)

// ---- 颜色 ----
// ★ 底色一律【原色】：色块是哪个波束的，纸上与屏上（FpAlloc 的 colorOf / 频率计划图的 stripes）
//   必须是同一个色。曾兑过白（BLOCK_TINT 0.5 / CARR_TINT 0.66）好让黑字压得住，代价是整本表
//   比软件里淡一大截、两个相近的波束色兑完更分不出来 —— 压字的事交给墨色翻转，不改色本身。
function hex2rgb(hex) {
  const h = String(hex || '').replace('#', '').trim()
  if (h.length === 3) return [0, 2, 4].map((i) => parseInt(h[i / 2] + h[i / 2], 16))
  if (h.length !== 6) return null
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)))
const rgb2argb = (r, g, b) => 'FF' + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('').toUpperCase()

/** 原色 → ARGB（主进程的 fill 只认 ARGB 八位串） */
export function argbOf(hex, fallback = '#5B8FD4') {
  const c = hex2rgb(hex) || hex2rgb(fallback) || [91, 143, 212]
  return rgb2argb(c[0], c[1], c[2])
}
// 相对亮度（同 FpAlloc 的 inkOf：白字压不住浅色，按亮度翻墨色）
function lum(hex) {
  const c = hex2rgb(hex)
  if (!c) return 1
  const lin = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}
// 墨色翻转的门限【照抄屏上那一个】(FpAlloc 的 inkOf = 0.42)：底色既然与软件同色，翻墨色的
// 那条线也必须同值，否则同一个波束在屏上是白字、在纸上是黑字。
// （曾因兑白而取过 0.25 —— 兑白后的红 #F09E98 亮度 0.447 压在 0.42 上，只在那个口径下成立。）
const inkFor = (argb) => (lum('#' + String(argb).slice(2)) > 0.42 ? 'FF17181A' : 'FFFFFFFF')

const GAP_FILL = 'FFF2F3F5'   // 载波之间的空当：不着色，但要与「没画到」区分得开
const NOBEAM_FILL = 'FFDDE3EA' // 没归波束的块：灰底（图上是留白，纸上留白与「没画到」分不开）

// 一格的两件套（底色 / 墨色）——主进程照抄，不再判断
const paint = (color, fallback = '#5B8FD4') => {
  const fill = argbOf(color || fallback)
  return { fill, ink: inkFor(fill) }
}

// 重叠的往下错一层（同频叠放的几个波束各占一层），语义同渲染端的 pickLane。
// ★ 判重叠看的是【频率】不是列：四舍五入到整数列之后，频分排布的两段会撞在同一格上（HTS 一条
//   转发器上十几个波束时必然如此），照列判就成了「它们同频」—— 一排能错出十几层来。
//   挨着不算叠着：相邻两段共一条边（f2 === 下一段的 f1）是常态。
function laneOf(lanes, a, b) {
  for (let k = 0; k < lanes.length; k++) {
    if (lanes[k].every(([p, q]) => a >= q - EPS || b <= p + EPS)) { lanes[k].push([a, b]); return k }
  }
  lanes.push([[a, b]])
  return lanes.length - 1
}

/**
 * 一条转发器的色块被它的【波束占段】切成哪几格。
 * 频分排布（HTS）→ 各段按频率占块的一截；同频叠加 → 每段都是满宽（由 packLanes 错层）。
 * ★ 按【块占的列数】等比例切，不回头去查整幅那把尺子：块的列区间被 used 游标让过位（窄转发器
 *   互相挤在同一格时往右让），两处各算各的会让段探出块外、压到隔壁转发器身上。
 */
function beamCells(c0, c1, band, segs, u) {
  const n = c1 - c0 + 1
  const span = Number.isFinite(band?.bw) && band.bw > 0 ? band.bw : null
  const out = []
  for (const g of (segs || [])) {
    if (!g || !g.beam) continue
    let a = c0, b = c1
    let m1 = Number.isFinite(band?.f1) ? band.f1 : 0
    let m2 = span ? m1 + span : m1 + 1
    if (span && !g.full && Number.isFinite(g.f1) && Number.isFinite(g.f2)) {
      const t0 = Math.min(1, Math.max(0, (g.f1 - band.f1) / span))
      const t1 = Math.min(1, Math.max(0, (g.f2 - band.f1) / span))
      if (t1 - t0 <= 1e-9) continue                 // 整段落在频带【外】—— 钳完是零宽，画不出东西
      // ★ 起列必须钳在块内：贴着上边沿的那一段（t0 → 1）四舍五入会算出 c1 + 1，落到块外去，
      //   packLanes 再怎么翻层也放不下它（那正是一个死循环）
      a = Math.min(c1, c0 + Math.round(t0 * n))
      b = Math.max(a, Math.min(c1, c0 + Math.round(t1 * n) - 1))
      m1 = band.f1 + t0 * span
      m2 = band.f1 + t1 * span
    }
    const p = paint(g.beam.color)
    out.push({
      c0: a, c1: b, hi: c1, m1, m2,
      name: s(g.beam.name), beamId: s(g.beam.id),
      f1: uv(u, g.f1), f2: uv(u, g.f2), bw: uv(u, g.bw),
      full: !!g.full, fill: p.fill, ink: p.ink
    })
  }
  return out
}

// 一排最多错几层：再多就不是一张表了（同频叠着几十个波束的转发器，图上也只是几十条发丝）。
// 超出的并进邻格，格上写「+n」——【不写就是悄悄少画】，见 no silent caps。
const LANE_MAX = 6

/**
 * 一排波束格 → 一层层的行。两步：
 *   ① 按【频率】分层 —— 层数 = 同频叠了多深（这是计划自己的事实，不是画法）；
 *   ② 层内按【列】排 —— 游标往右让，让不下的【并进左邻那一格】并计数（格上写「+n」）。
 *
 * ★ 让不下的【不另起一层】：另起一层就是把「频分排布」画成「同频叠放」—— 一条 20 MHz 上排
 *   40 个波束（每个分不到一列）能错出十几层，读起来像这些波束全在同一段频率上，而实情正相反。
 * ★ 也不能丢（那个波束在纸上凭空消失）、不能叠（合并区一相交 exceljs 当场抛，界面上只剩
 *   「导出失败」四个字）。故：放得下就放，放不下就并给邻格，画不下这件事写在格上。
 */
function packLanes(cells) {
  const lanes = []
  for (const it of cells) it.lane = Math.min(LANE_MAX - 1, laneOf(lanes, it.m1, it.m2))
  const rows = []
  const cursor = []
  const lastOf = []                               // 每层最后落下的那一格（并的时候并给它）
  for (const it of cells) {
    const k = it.lane
    it.c0 = Math.min(it.c0, it.hi)
    const cur = cursor[k]
    const a = cur == null ? it.c0 : Math.max(it.c0, cur + 1)
    if (a > it.hi) {                              // 这一格已经排到块的右边沿之外 —— 并给左邻
      const host = lastOf[k] || lastOf.filter(Boolean).pop()
      if (host) host.more = (host.more || 0) + 1
      continue
    }
    it.c0 = a
    it.c1 = Math.max(a, Math.min(it.hi, it.c1))
    cursor[k] = it.c1
    lastOf[k] = it
    if (!rows[k]) rows[k] = []
    rows[k].push(it)
  }
  const out = rows.map((r) => r || [])
  for (const lane of out) for (const c of lane) c.label = c.more ? `${c.name} +${c.more}` : c.name
  return out
}

// ---- 通用小工具 ----
// 极化行的次序：H/L 在上、V/R 在下（同 freqPlanRender 的 layout，屏上与纸上不该两个次序）。
// 表里没见过的极化排在末尾，不是排到 −1 那一头去。
const POL_ORDER = ['H', 'L', 'V', 'R']
const polRank = (p) => { const i = POL_ORDER.indexOf(p); return i < 0 ? POL_ORDER.length : i }
const polList = (items, pick) =>
  [...new Set(items.map(pick).filter(Boolean))].sort((a, b) => polRank(a) - polRank(b))
const beamNames = (list) => (list || []).map((b) => b.name).filter(Boolean).join(' + ')

/** 该条转发器在某一侧的波束色（多波束取第一个 —— 色块只有一格，写不下几个色） */
const firstColor = (list) => (list && list.length ? (list[0].color || '') : '')

// ============================================================================
// ① 样式版：总表
// ============================================================================
//
// 频率 → 列：整幅一把等比的尺子（col = 起列 + round((f − fmin)/span × (N−1))）。
// 列数按「最窄的那条转发器至少占两列」定（见 buildStyledXlsx），夹在 [96, 400] 之间：
// 少了窄转发器挤成一格看不出宽度，多了整幅拉到几屏宽。
//
// ★ 一个极化 = 【编号行 + 波束行】两截（波束叠着放的再往下加层，见 laneRows）：
//   编号行只认转发器（不着色、粗框），色全部落在波束行上 —— 这正是软件里那张图的读法
//   （频率计划图的色块就是按波束占段切的，见 freqPlanRender 的 layoutStripes）。
//   从前整块刷第一个波束的色：一条 54 MHz 上摆着两个 27 MHz 的波束时，纸上只看得见其中一个。
function overviewBand(plan, rs, side, u, cols) {
  const items = rs.filter((r) => (side === 'dn' ? r.dn : r.up))
  if (!items.length) return null
  const ext = planExtent(plan, side, 0)
  if (!ext) return null
  const span = Math.max(ext.dataMax - ext.dataMin, EPS)
  // 频率 → 【列边界】（1 基，相对本网格；主进程再加上标签列的偏移）。给的是「这个频率落在哪两列
  // 之间」，故上边沿是 cols + 1 而不是 cols —— 钳到 cols 的话末尾那一列谁也占不着，整幅右边
  // 永远空着一条（色块宽度即带宽，那一条空白读起来就像最后一条转发器窄了一格）。
  const col = (f) => Math.max(1, Math.min(cols + 1, 1 + Math.round(((f - ext.dataMin) / span) * cols)))

  const wide = items.filter((r) => !r.mark)
  const marks = items.filter((r) => r.mark)
  const pols = polList(wide.map((r) => (side === 'dn' ? r.dn : r.up)), (x) => x.pol)

  const rows = pols.map((pol) => {
    const list = wide
      .map((r) => ({ r, x: side === 'dn' ? r.dn : r.up }))
      .filter((it) => it.x.pol === pol && Number.isFinite(it.x.f1))
      .sort((a, b) => a.x.f1 - b.x.f1)
    const blocks = []
    const cells = []                              // 这一排所有转发器的波束格，分层前先摊平
    let used = 0                                  // 上一块占到的列 —— 窄转发器互相挤在同一格时往右让
    for (const { r, x } of list) {
      const beams = side === 'dn' ? r.beamsDn : r.beamsUp
      let c0 = Math.max(col(x.f1), used + 1)
      let c1 = Math.max(c0, col(x.f2) - 1)
      if (c0 > cols) continue                     // 让到网格外 —— 只可能是几十条零宽转发器叠在一处
      c1 = Math.min(c1, cols)
      used = c1
      const blk = {
        c0, c1, label: s(r.no),
        f1: uv(u, x.f1), f2: uv(u, x.f2), fc: uv(u, x.fc), bw: uv(u, x.bw),
        beam: beamNames(beams), beamCount: beams.length
      }
      blocks.push(blk)
      const segs = side === 'dn' ? r.segsDn : r.segsUp
      const bc = beamCells(c0, c1, x, segs, u)
      // 整条只归一个色时，编号格自己也刷上它 —— 这一条就是软件里那张图上的样子（色块中间写编号）。
      // 一条上摆着几个波束的不刷：刷谁都是错的（挑第一个正是从前那个「其余几个看不见」的毛病）。
      const one = bc.length && bc.every((c) => c.fill === bc[0].fill) ? bc[0] : null
      if (one) { blk.fill = one.fill; blk.ink = one.ink }
      // 一个波束都没归的转发器：波束行上留一格灰的（图上是留白 —— 纸上留白与「这一格没画到」
      // 分不开），写「—」而不是空着
      if (!bc.length) {
        cells.push({
          c0, c1, hi: c1, m1: x.f1, m2: x.f2,
          name: '—', beamId: '', fill: NOBEAM_FILL, ink: 'FF6B7078', none: true
        })
      } else cells.push(...bc)
    }
    return { pol, polLabel: POL_LABEL[pol] || pol, blocks, lanes: packLanes(cells) }
  })

  // 信标 / 遥控 / 遥测：一根箭头，只有频率与极化，不归波束也没有带宽（见模型 CHANNEL_KINDS）。
  // 单画一行，不混进色块行 —— 混进去就成了「宽度为零的转发器」。
  const markRow = marks
    .map((r) => ({ r, x: side === 'dn' ? r.dn : r.up }))
    .filter((it) => it.x && Number.isFinite(it.x.fc))
    .sort((a, b) => a.x.fc - b.x.fc)
    .map(({ r, x }) => ({
      c: Math.min(cols, col(x.fc)),               // 箭头是【一格】，落在上边沿的那根不能排到网格外
      tag: kindTag(r.kind) || KIND_LABEL[r.kind] || '',
      no: s(r.no), pol: s(x.pol), f: uv(u, x.fc),
      arrow: side === 'dn' ? '↓' : '↑'
    }))

  return {
    side,
    title: `${side === 'up' ? '上行 UPLINK' : '下行 DOWNLINK'} · ${fmtFreqNum(ext.dataMin, u.label)}~${fmtFreqNum(ext.dataMax, u.label)} ${u.label}`,
    f1: uv(u, ext.dataMin), f2: uv(u, ext.dataMax),
    rows, marks: markRow
  }
}

// ============================================================================
// ② 样式版：逐转发器的载波占用条
// ============================================================================
//
// 一条转发器 = 一段频带被切成若干「段」：定频载波按自己的起~止落位，其间的空当补成空段。
// ★ 视域取【频带 ∪ 载波】（同 FpAlloc 的 stripOf）—— 越界的载波必须看得见，画到条外面去
//   等于把问题藏起来；越界与重叠仍由核算给出条目（见 issues），这里只如实画。
const STRIP_COLS = 20

function stripBlock(g, u) {
  const hasBand = Number.isFinite(g.f1) && Number.isFinite(g.f2) && g.f2 > g.f1
  const placed = (g.rows || [])
    .filter((r) => r.placed && Number.isFinite(r.f.f1) && Number.isFinite(r.f.f2) && r.f.f2 > r.f.f1)
    .slice().sort((a, b) => a.f.f1 - b.f.f1)
  if (!hasBand) return { segs: [], beamLanes: [], d0: null, d1: null }
  const multiBeam = (g.beams || []).length > 1
  let d0 = g.f1, d1 = g.f2
  for (const r of placed) { if (r.f.f1 < d0) d0 = r.f.f1; if (r.f.f2 > d1) d1 = r.f.f2 }
  const span = Math.max(d1 - d0, EPS)
  // 同总表：给的是列边界，上边沿落在 STRIP_COLS + 1 上（钳到 STRIP_COLS 的话条尾永远空一列）
  const col = (f) => Math.max(1, Math.min(STRIP_COLS + 1, 1 + Math.round(((f - d0) / span) * STRIP_COLS)))

  // 段序列：空当 → 载波 → 空当…（重叠的载波按已铺到的位置往右接，标注仍写它自己的真起止）
  const raw = []
  let cur = d0
  for (const r of placed) {
    if (r.f.f1 > cur + EPS) raw.push({ gap: true, a: cur, b: r.f.f1 })
    raw.push({ gap: false, r, a: Math.max(r.f.f1, cur), b: Math.max(r.f.f2, cur) })
    cur = Math.max(cur, r.f.f2)
  }
  if (cur < d1 - EPS) raw.push({ gap: true, a: cur, b: d1 })

  const segs = []
  let used = 0
  for (const it of raw) {
    let c0 = Math.max(col(it.a) , used + 1)
    let c1 = Math.max(c0, col(it.b) - 1)
    if (c0 > STRIP_COLS) continue
    c1 = Math.min(c1, STRIP_COLS)
    used = c1
    if (it.gap) {
      // 太窄的空当不单独成段（一列都占不满的间隙写上「空」反而喧宾夺主）
      if (it.b - it.a < span / 200) { used = c0 - 1; continue }
      segs.push({
        gap: true, c0, c1, name: '空',
        f1: uv(u, it.a), f2: uv(u, it.b), bw: uv(u, it.b - it.a),
        fill: GAP_FILL, ink: 'FF8A8F98'
      })
      continue
    }
    const r = it.r
    const color = r.beam?.color || ''
    const p = paint(color)
    const rate = nz(r.c.infoRateKbps)
    segs.push({
      gap: false, c0, c1,
      name: s(r.c.name),
      f1: uv(u, r.f.f1), f2: uv(u, r.f.f2), fc: uv(u, r.f.fc),
      bw: uv(u, r.occ), pwr: uv(u, r.pwr),
      beam: s(r.beam?.name), pol: s(r.pol), modcod: s(r.c.modcod),
      rate,
      // 副行排在载波名下面：波束在最前 —— 载波【是谁的】是分配表要回答的第一件事。
      // ★ 只挂着一个波束的转发器不写：上面那条波束带已经写了一遍，逐条再写一遍是同一个名字
      //   刷满整条（多波束的才有得分辨，那时每条载波归谁才是要看的东西）
      sub: [multiBeam ? s(r.beam?.name) : '', s(r.c.modcod), rate != null ? `${rate} kbps` : ''].filter(Boolean).join(' · '),
      note: s(r.c.note),
      out: Number.isFinite(g.f1) && (r.f.f1 < g.f1 - EPS || r.f.f2 > g.f2 + EPS),
      fill: p.fill, ink: p.ink
    })
  }

  // 波束占段带：这条转发器的频带被哪几个波束分了，占哪一截（同总表的波束行，也同软件里
  // 那张图的色块切法）。★ 落在【视域】的列上而不是频带的列上 —— 视域含越界的那一截，
  // 两处各算各的会让色带与它上面的频率行错开一格。
  const b0 = Math.min(STRIP_COLS, col(g.f1))
  const b1 = Math.max(b0, Math.min(STRIP_COLS, col(g.f2) - 1))
  const beamLanes = packLanes(beamCells(b0, b1, { f1: g.f1, bw: g.f2 - g.f1 }, g.segs, u))
  return { segs, beamLanes, d0: uv(u, d0), d1: uv(u, d1) }
}

function allocBlock(g, u) {
  const strip = stripBlock(g, u)
  const fq = (mhz) => fmtFreqNum(mhz, u.label)
  const title = Number.isFinite(g.f1)
    ? `${g.no || '—'}（${fq(g.f1)} · ${fq((g.f1 + g.f2) / 2)} · ${fq(g.f2)} ${u.label}）`
    : `${g.no || '—'}（无下行频带）`
  // 使用情况总结：只出数值，不写「达标 / 受限」这类文字判定（平台既定口径）
  const pct = (v) => (Number.isFinite(v) ? Number((v * 100).toFixed(1)) : null)
  const summary = [
    [`转发器带宽 (${u.label})`, uv(u, g.bwMHz), null],
    [`已占用带宽 (${u.label})`, uv(u, g.occSum), pct(g.bwUtil)],
    [`功率占用带宽 (${u.label})`, uv(u, g.pwrSum), pct(g.pwrUtil)],
    [`剩余可用带宽 (${u.label})`, g.freeMHz == null ? null : uv(u, g.freeMHz), null],
    ['载波数', g.count || 0, null],
    ['信息速率合计 (kbps)', g.rateSum ? Number(g.rateSum.toFixed(0)) : 0, null]
  ]
  // 波束占段：色带上画的那几截，这里给出数。★ 上限八条 —— HTS 一条转发器上挂着几十个波束时
  // 逐条列会把小结撑成一整页（色带已经把格局画出来了，数由「波束」表逐条给）
  const segList = (g.segs || []).filter((x) => x && x.beam)
  if (segList.length) {
    summary.push([`波束数`, segList.length, null])
    if (segList.length <= 8) {
      for (const x of segList) {
        summary.push([
          `波束 · ${s(x.beam.name)} (${u.label})`,
          uv(u, x.bw),
          Number.isFinite(x.bw) && Number.isFinite(g.bwMHz) && g.bwMHz > 0 ? pct(x.bw / g.bwMHz) : null
        ])
      }
    }
  }
  // 冲突明细：照示例右侧那张「非法载波及合同超用详细情况」的四列（编号 / 频率范围 / 占用带宽 / 说明）
  const byId = new Map((g.rows || []).map((r) => [r.c.id, r]))
  const issues = (g.issues || []).map((is) => {
    const r = is.carrierId ? byId.get(is.carrierId) : null
    return {
      no: r ? s(r.c.name) : '',
      range: r && r.f.f1 != null ? `${fq(r.f.f1)}~${fq(r.f.f2)}` : '',
      bw: r ? uv(u, r.occ) : null,
      msg: s(is.msg)
    }
  })
  // 标题右边那一行：极化 + 上行频带（下行是标题里那三个数，两侧凑齐才对得上频谱仪）。
  // 波束不写在这里 —— 它有自己的一整条色带（见 beamLanes），名字写两遍只会互相打架
  const tail = [
    POL_LABEL[g.pol] || s(g.pol),
    Number.isFinite(g.upF1) ? `上行 ${fq(g.upF1)}~${fq(g.upF2)} ${u.label}` : ''
  ].filter(Boolean).join(' · ')
  return {
    channelId: s(g.channelId),
    no: s(g.no),
    title,
    tail,
    pol: s(g.pol),
    polLabel: POL_LABEL[g.pol] || s(g.pol),
    beam: beamNames(g.beams),
    beamColor: firstColor(g.beams),
    f1: uv(u, g.f1), f2: uv(u, g.f2), bw: uv(u, g.bwMHz),
    upF1: uv(u, g.upF1), upF2: uv(u, g.upF2),
    stripCols: STRIP_COLS,
    d0: strip.d0, d1: strip.d1,
    segs: strip.segs,
    beamLanes: strip.beamLanes,
    summary,
    issues
  }
}

// ============================================================================
// ③ 样式版：波束表
// ============================================================================
//
// 总表的图例只写「这个色是谁、多宽」，一个波束【落在哪几条转发器上、各占多少】写不进那一行。
// 那恰恰是这份计划里波束的全部事实，故单成一张表：一行一个波束，逐条列出它占的转发器与段。
function styledBeamSheet(plan, rs, u) {
  const rows = (plan.beams || []).map((b, i) => {
    const hit = []                                 // 这个波束在哪几条转发器的哪一侧占了段
    let sum = 0
    for (const r of rs) {
      if (r.mark) continue
      for (const side of ['up', 'dn']) {
        for (const g of (side === 'dn' ? r.segsDn : r.segsUp) || []) {
          if (!g.beam || g.beam.id !== b.id) continue
          if (side === 'dn') { hit.push(s(r.no)); if (Number.isFinite(g.bw)) sum += g.bw }
        }
      }
    }
    // 上下行各占一段是同一件事的两侧，合计只按【下行】算 —— 两侧都加等于把带宽记两遍
    const tps = [...new Set(hit.filter(Boolean))]
    return {
      no: i + 1,
      name: s(b.name),
      color: argbOf(b.color),
      hex: s(b.color).toUpperCase(),
      bw: uv(u, beamBw(b)),
      tpCount: tps.length,
      occ: sum > 0 ? uv(u, sum) : null,
      tps: tps.join('、'),
      note: beamSynthText(b)
    }
  })
  return rows
}

// ============================================================================
// 样式版总装
// ============================================================================

/**
 * 照《中星6D卫星C频段转发器频率分配表》的体例出一本工作簿。
 * @param {object} plan 频率计划   @param {Array} carriers 载波
 * @param {object} opts { unit, perSheet } —— perSheet = 每张分配表放几条转发器（示例是 3）
 * @returns 纯数据模型（可直接过 IPC）
 */
export function buildStyledXlsx(plan, carriers = [], opts = {}) {
  const u = unitOf(opts.unit || 'MHz')
  const perSheet = Math.max(1, Math.min(12, Number(opts.perSheet) || 3))
  const rs = resolveAll(plan)
  const alloc = buildAllocation(plan, carriers, { unit: opts.unit || 'MHz', side: 'dn', beamMode: 'freq' })

  // 网格列数：色块宽度就是带宽，故分辨率不够时同样宽的两条转发器会一条 7 格、一条 8 格
  // （量化抖动 = 1/每条所占格数）。按「最窄的那条至少 24 格」定，抖动压到 4% 以内即看不出来；
  // 夹在 [120, 360] 之间 —— 少了抖动露头，多了整幅拉出好几屏（列宽由主进程按列数反推）。
  const spans = []
  for (const r of rs) for (const x of [r.up, r.dn]) if (x && Number.isFinite(x.bw) && x.bw > EPS) spans.push(x.bw)
  const ext = planExtent(plan, 'up', 0) || planExtent(plan, 'dn', 0)
  const total = ext ? Math.max(ext.dataMax - ext.dataMin, EPS) : 1
  const need = spans.length ? Math.ceil((24 * total) / Math.min(...spans)) : 120
  const cols = Math.max(120, Math.min(360, need))

  const bands = ['up', 'dn'].map((side) => overviewBand(plan, rs, side, u, cols)).filter(Boolean)

  // 图例：波束（原色样本 + 标签），后接本振
  const legend = (plan.beams || []).map((b) => ({
    name: s(b.name),
    color: argbOf(b.color),
    text: beamLabel(b, u.label),
    // 频段不写在图例里：一个波束在各转发器里各占各的段（见「波束占段」表），
    // 图例上只写它是谁、多宽 —— 标准计划图的写法。
    band: '',
    note: beamSynthText(b)
  }))
  const los = (plan.los || []).filter((l) => Number.isFinite(l.valueMHz)).map((l) => ({
    name: s(l.name), value: uv(u, l.valueMHz), note: s(l.note)
  }))

  // 分配表：只排真转发器（信标那几条没有频带，排不出条）
  const blocks = alloc.groups.map((g) => allocBlock(g, u))
  const sheets = []
  for (let i = 0; i < blocks.length; i += perSheet) {
    const part = blocks.slice(i, i + perSheet)
    sheets.push({ name: part.map((b) => b.no || '—').join('、'), blocks: part })
  }
  // 未归属转发器的载波：单成一张表，藏起来只会让人以为它们没录进去
  const orphan = (alloc.unassigned || []).map((r) => ({
    name: s(r.c.name),
    bw: uv(u, r.occ), pwr: uv(u, r.pwr),
    fc: uv(u, r.up.fc),
    modcod: s(r.c.modcod), rate: nz(r.c.infoRateKbps), note: s(r.c.note)
  }))

  return {
    kind: 'styled',
    meta: metaOf(plan, carriers, u, alloc),
    overview: { cols, bands, legend, los },
    beams: styledBeamSheet(plan, rs, u),
    sheets,
    orphan,
    unit: u
  }
}

// ============================================================================
// ③ 纯数据版
// ============================================================================
//
// 一行一条记录、一列一个字段。频率与带宽写成数值（按整份计划那把刻度），单位写进列头 ——
// 落进 Excel 还能直接求和、排序、透视，这是「纯数据」相对「样式版」的全部意义。

const COL = (header, o = {}) => ({
  key: o.key || header, header, width: o.w || null, fmt: o.fmt || null, align: o.a || null, keep: !!o.keep
})

// ---- 结合总表：一行一条载波，转发器的字段随它的每一条载波重复一遍 ----
//
// ★ 空列不出：整列都没值的一并去掉（没挂本振的计划不该有两列空「本振」，没录 SFD 的不该有
//   五列空的射频参数）。列少一半，读表的人才找得着自己要的那一列。
// ★ 没有载波的转发器仍占一行（载波那半截留空）：藏起来等于把没卖出去的转发器说成不存在；
//   未归属的载波也留行，转发器那一格写「（未归属）」；信标 / 遥测遥控各一行（它们没有带宽，
//   起止留空只写中心 —— 见 spanEdge）。
function dataSheetAll(plan, rs, alloc, u) {
  const F = { fmt: u.numFmt, a: 'right' }
  const cols = [
    COL('#', { key: 'i', w: 5, a: 'center', keep: true }),
    COL('转发器', { key: 'no', w: 11, keep: true }),
    COL('类型', { key: 'kind', w: 9, a: 'center' }),
    COL(`上行起始 (${u.label})`, { key: 'upF1', ...F }),
    COL(`上行终止 (${u.label})`, { key: 'upF2', ...F }),
    COL(`上行带宽 (${u.label})`, { key: 'upBw', ...F }),
    COL('上行极化', { key: 'upPol', w: 9, a: 'center' }),
    COL('上行波束', { key: 'upBeam', w: 16 }),
    COL('本振', { key: 'lo', w: 9 }),
    COL(`本振值 (${u.label})`, { key: 'loV', ...F }),
    COL(`下行起始 (${u.label})`, { key: 'dnF1', ...F }),
    COL(`下行终止 (${u.label})`, { key: 'dnF2', ...F }),
    COL(`下行带宽 (${u.label})`, { key: 'dnBw', ...F }),
    COL('下行极化', { key: 'dnPol', w: 9, a: 'center' }),
    COL('下行波束', { key: 'dnBeam', w: 16 }),
    COL('载波', { key: 'cName', w: 18, keep: true }),
    COL(`载波下行中心 (${u.label})`, { key: 'cDn', ...F }),
    COL(`载波上行中心 (${u.label})`, { key: 'cUp', ...F }),
    COL(`占用带宽 (${u.label})`, { key: 'occ', ...F }),
    COL(`功率带宽 (${u.label})`, { key: 'pwr', ...F }),
    COL('载波波束', { key: 'cBeam', w: 16 }),
    COL('调制 · 编码', { key: 'modcod', w: 14 }),
    COL('信息速率 (kbps)', { key: 'rate', fmt: '0', a: 'right' }),
    COL('备注', { key: 'note', w: 22 }),
    COL('SFD (dBW/m²)', { key: 'sfd', fmt: '0.0', a: 'right' }),
    COL('G/T (dB/K)', { key: 'gt', fmt: '0.0', a: 'right' }),
    COL('IBO (dB)', { key: 'ibo', fmt: '0.0', a: 'right' }),
    COL('OBO (dB)', { key: 'obo', fmt: '0.0', a: 'right' }),
    COL('C/IM (dB)', { key: 'cim', fmt: '0.0', a: 'right' })
  ]

  const hasMark = rs.some((r) => r.mark)
  // 载波的起止 = 中心 ∓ 占用带宽 / 2（见 setCarrierEdge），故只写中心那一个数：
  // 同一件事写三列，正是「太多」的来处
  const carrierOf = (r) => ({
    cName: s(r.c.name),
    cDn: uv(u, r.dn?.fc), cUp: uv(u, r.up?.fc),
    occ: uv(u, r.occ), pwr: uv(u, r.pwr),
    cBeam: s(r.beam?.name),
    modcod: s(r.c.modcod), rate: nz(r.c.infoRateKbps),
    note: s(r.c.note)
  })
  const tpOf = (r) => {
    const ch = r.raw
    return {
      no: s(r.no),
      kind: hasMark ? (KIND_LABEL[r.kind] || s(r.kind)) : '',
      upF1: uv(u, spanEdge(r.up, 'f1')), upF2: uv(u, spanEdge(r.up, 'f2')), upBw: uv(u, r.up?.bw),
      upPol: s(r.up?.pol), upBeam: beamNames(r.beamsUp),
      lo: s(r.lo?.name), loV: uv(u, r.lo?.valueMHz),
      dnF1: uv(u, spanEdge(r.dn, 'f1')), dnF2: uv(u, spanEdge(r.dn, 'f2')), dnBw: uv(u, r.dn?.bw),
      dnPol: s(r.dn?.pol), dnBeam: beamNames(r.beamsDn),
      sfd: nz(ch.sfdDbwm2), gt: nz(ch.gtDbK), ibo: nz(ch.boiDb), obo: nz(ch.booDb), cim: nz(ch.cimDb),
      // 转发器自己的备注只在它没有载波那一行写：有载波的行上「备注」那一格归载波，
      // 一格里塞两个来源的备注，读表人分不出是谁的
      note: ''
    }
  }

  const byCh = new Map(alloc.groups.map((g) => [g.channelId, g]))
  const items = []
  for (const r of rs) {
    const t = tpOf(r)
    const g = byCh.get(r.id)
    const list = (g ? g.rows : []).slice()
      .sort((a, b) => (a.f.f1 ?? Infinity) - (b.f.f1 ?? Infinity))
    if (!list.length) { items.push({ ...t, note: s(r.raw.note) }); continue }
    for (const cr of list) items.push({ ...t, ...carrierOf(cr) })
  }
  for (const cr of (alloc.unassigned || [])) items.push({ no: '（未归属）', ...carrierOf(cr) })
  items.forEach((it, i) => { it.i = i + 1 })

  // 两列写着同一件事就并成一列：绝大多数计划两侧挂的是同一组波束（下行没单独指定就随上行，
  // 见 channelBeams），并排两列「上行波束 / 下行波束」逐行一模一样；载波的波束也一样 ——
  // 一条转发器只挂一个波束时，它的每条载波都只能是那一个。
  const colOf = (k) => cols.find((c) => c.key === k)
  if (items.every((it) => (it.upBeam || '') === (it.dnBeam || ''))) {
    for (const it of items) it.dnBeam = ''
    colOf('upBeam').header = '波束'
  }
  if (items.every((it) => !it.cBeam || it.cBeam === (it.dnBeam || it.upBeam))) {
    for (const it of items) it.cBeam = ''
  }

  const has = (c) => c.keep || items.some((it) => it[c.key] != null && it[c.key] !== '')
  const columns = cols.filter(has)
  const rows = items.map((it) => columns.map((c) => (it[c.key] === undefined || it[c.key] === '' ? null : it[c.key])))
  return { name: '转发器 · 载波', title: '转发器与载波总表', columns, rows, freeze: 3 }
}

// ---- 概览（键值表）----
function metaOf(plan, carriers, u, alloc) {
  const S = alloc.summary
  return {
    planName: s(plan.name) || '频率计划',
    satName: s(plan.satName),
    band: s(plan.band),
    note: s(plan.note),
    summary: planSummary(plan, u.label),
    unit: u.label,
    updatedAt: s(plan.updatedAt),
    carrierCount: S.carrierCount,
    tpTotal: S.tpTotal
  }
}

// 概览 = 这份计划的全部「不逐条」的事实：规模 / 跨度 / 装填合计，外加波束、本振、校验条目
// 三张原本各占一表的小表（各自只有几行，单开一表纯属把人支来支去）。
// 逐转发器 / 逐波束的核算不再单列：结合总表是摊平的，那几个数用透视表当场就能出。
function dataSheetOverview(plan, rs, alloc, u) {
  const S = alloc.summary
  const fq = (mhz) => (Number.isFinite(mhz) ? Number((mhz / u.factor).toFixed(u.dec)) : null)
  const extUp = planExtent(plan, 'up', 0)
  const extDn = planExtent(plan, 'dn', 0)
  const tp = rs.filter((r) => r.kind === 'transponder')
  const marks = rs.filter((r) => isMarkKind(r.kind))
  const rows = [
    ['—— 计划', null, null],
    ['计划名称', s(plan.name), ''],
    ['卫星', s(plan.satName), ''],
    ['频段', s(plan.band) + (plan.bandAuto === false ? '（手选）' : '（自动判定）'), ''],
    ['显示刻度', u.label, ''],
    ['更新时间', s(plan.updatedAt), ''],
    ['备注', s(plan.note), ''],
    ['—— 规模', null, null],
    ['转发器数', tp.length, '条'],
    ['信标 / 遥测遥控数', marks.length, '条'],
    ['波束 / 带宽组数', (plan.beams || []).length, '组'],
    ['本振数', (plan.los || []).length, '个'],
    ['载波数', S.carrierCount, '条'],
    ['未归属载波数', S.unassignedCount, '条'],
    ['—— 频率跨度', null, null],
    ['上行起始', extUp ? fq(extUp.dataMin) : null, u.label],
    ['上行终止', extUp ? fq(extUp.dataMax) : null, u.label],
    ['下行起始', extDn ? fq(extDn.dataMin) : null, u.label],
    ['下行终止', extDn ? fq(extDn.dataMax) : null, u.label],
    ['—— 装填（下行域）', null, null],
    ['转发器总带宽', fq(S.totalBwMHz), u.label],
    ['已占用带宽', fq(S.occupiedBwMHz), u.label],
    ['功率占用带宽', fq(S.powerBwMHz), u.label],
    ['剩余可用带宽', fq(S.freeBwMHz), u.label],
    ['带宽占用率', S.bwUtil == null ? null : Number((S.bwUtil * 100).toFixed(1)), '%'],
    ['功率占用率', S.pwrUtil == null ? null : Number((S.pwrUtil * 100).toFixed(1)), '%'],
    ['已装载转发器数', S.tpUsed, '条'],
    ['信息速率合计', S.totalRateKbps ? Number(S.totalRateKbps.toFixed(0)) : 0, 'kbps'],
    ['平均频谱效率', S.avgEffBpsHz == null ? null : Number(S.avgEffBpsHz.toFixed(2)), 'bps/Hz']
  ]
  // 波束：名字 + 标称带宽 + 挂在几条转发器上（占哪一段是样式版那本表的事，见 styledBeamSheet）
  if ((plan.beams || []).length) {
    rows.push(['—— 波束 / 带宽组', null, null])
    for (const b of plan.beams) {
      const n = rs.filter((r) => !r.mark
        && [...(r.beamsUp || []), ...(r.beamsDn || [])].some((x) => x.id === b.id)).length
      rows.push([s(b.name), uv(u, beamBw(b)), `${u.label} · ${n} 条转发器`])
    }
  }
  if ((plan.los || []).length) {
    rows.push(['—— 本振', null, null])
    for (const l of plan.los) {
      const n = rs.filter((r) => r.lo && r.lo.id === l.id).length
      rows.push([s(l.name), uv(u, l.valueMHz), `${u.label} · ${n} 条转发器`])
    }
  }
  // 校验：条数 + 逐条说明。★ 只报条数等于把问题藏进一个数字里
  const SEV = { error: '错误', warn: '警告', info: '提示' }
  const idNo = new Map((plan.channels || []).map((c) => [c.id, c.no]))
  const issues = []
  for (const is of validatePlan(plan, u.label)) {
    const refs = (is.refs || []).map((id) => idNo.get(id) || '').filter(Boolean).join('、')
    issues.push([`${SEV[is.severity] || s(is.severity)}${refs ? ' · ' + refs : ''}`, s(is.msg), ''])
  }
  for (const g of alloc.groups) {
    for (const is of g.issues || []) issues.push([`警告 · ${s(g.no)}`, s(is.msg), ''])
  }
  rows.push(['—— 校验', null, null])
  rows.push(['装填冲突条目', S.issueCount, '条'])
  rows.push(['计划校验条目', validatePlan(plan, u.label).length, '条'])
  rows.push(...issues)

  return {
    name: '计划概览',
    title: s(plan.name) || '频率计划',
    kv: true,
    columns: [COL('项', { w: 26 }), COL('值', { w: 40 }), COL('单位', { w: 18 })],
    rows,
    freeze: 0
  }
}

/**
 * 纯数据版：两张表 —— 概览（键值）+ 转发器与载波的结合总表（一行一条载波）。
 * 曾是九张分表（转发器 / 载波 / 波束 / 波束占段 / 本振 / 核算 / 波束汇总 / 校验 + 概览），
 * 2026-08-02 按用户「太乱太多」并成两张：一条载波在哪条转发器上、那条转发器多宽，从前要在
 * 三张表之间来回对；逐转发器 / 逐波束的核算摊平之后用透视表当场能出，不必各占一张。
 * @param {object} plan   @param {Array} carriers   @param {object} opts { unit }
 */
export function buildDataXlsx(plan, carriers = [], opts = {}) {
  const u = unitOf(opts.unit || 'MHz')
  const rs = resolveAll(plan)
  const alloc = buildAllocation(plan, carriers, { unit: opts.unit || 'MHz', side: 'dn', beamMode: 'freq' })
  return {
    kind: 'data',
    meta: metaOf(plan, carriers, u, alloc),
    unit: u,
    sheets: [
      dataSheetOverview(plan, rs, alloc, u),
      dataSheetAll(plan, rs, alloc, u)
    ]
  }
}

/** 两种版式共用的入口（界面按 kind 选一条） */
export function buildFreqPlanXlsx(kind, plan, carriers = [], opts = {}) {
  return kind === 'data' ? buildDataXlsx(plan, carriers, opts) : buildStyledXlsx(plan, carriers, opts)
}
