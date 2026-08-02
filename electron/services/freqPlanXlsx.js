// 转发器频率计划 → .xlsx（主进程，Node）。
//
// ★ 这一份【不认识频率计划】：它拿到的是渲染端 src/shared/fpXlsxModel.js 算好的纯数据模型
//   （第几行第几列写什么、什么底色、并到哪一格），只负责往 exceljs 的格子里刷。频率解析、
//   上下行换算、装填核算、校验条目一概不在这里 —— 那套口径只有一份，在渲染端（见该文件头）。
//
// 两种版式：
//   'styled' 照《中星6D卫星C频段转发器频率分配表》的体例：一张「总表」（频率轴上的转发器排布）
//            ＋ 每 3 条转发器一张的分配表（载波占用条 + 使用情况总结 + 冲突明细）。
//            列宽写死 —— 那张表的色块宽度就是带宽，让 autofit 去「把装不下的列放宽」会把比例尺
//            改掉，一条 36 MHz 的转发器画得比 72 MHz 的还宽。
//   'data'   纯数据表：一行一条记录、一列一个字段，走三线表 + 冻结窗格 + autofit（同交付级报告）。
//
// 字体：与报表同一套（西文/数字 Times New Roman，中文靠字体链接回落宋体）——见 report.js 的 FNT。

const ExcelJS = require('exceljs')
const { autofitBook } = require('./reportAutofit')

const FNT = 'Times New Roman'
const INK = 'FF17181A'
const DIM = 'FF6B7078'
const RULE = 'FF3A3F45'

const MED = { style: 'medium', color: { argb: RULE } }
const THIN = { style: 'thin', color: { argb: RULE } }
const HAIR = { style: 'hair', color: { argb: 'FFB9BEC5' } }
const HEAD_FILL = 'FFEDEFF2'      // 表头那一条淡灰
const TITLE_FILL = 'FFFFFFCC'     // 分配表标题条：照示例那一条浅黄（indexed 26 = #FFFFCC）

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const txt = (v) => (v == null ? '' : String(v))

// 样式版的频率与带宽【不定小数位】：模型出手前已按刻度收过小数（uv 的 toFixed），再套 '0.00'
// 只会让 3720 写成 3720.00 —— 那张表是给人读频率轴的，满屏的 .00 是噪声（手上那份示例里
// 也是 3702 / 3738 / 36）。纯数据表反过来要定死小数位：一列数上下对齐才扫得动。
const GEN = null

// ---- 单元格三件套（值 / 字 / 框），各表共用 ----
function put(ws, r, c, value, o = {}) {
  const cell = ws.getRow(r).getCell(c)
  cell.value = value === '' || value === undefined ? null : value
  cell.font = {
    name: FNT,
    size: o.size || 10,
    bold: !!o.bold,
    color: { argb: o.ink || INK }
  }
  if (o.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } }
  cell.alignment = {
    horizontal: o.align || 'left',
    vertical: o.valign || 'middle',
    wrapText: !!o.wrap,
    shrinkToFit: !!o.shrink,
    indent: o.indent || 0
  }
  if (o.fmt) cell.numFmt = o.fmt
  if (o.border) cell.border = o.border
  return cell
}

// 合并区：exceljs 只给左上格上样式，其余格默认无边框 —— 一并刷一遍，
// 否则合并块的右半截没有框线（示例那张表的色块是有完整外框的）。
function span(ws, r, c0, c1, value, o = {}) {
  const a = Math.min(c0, c1)
  const b = Math.max(c0, c1)
  for (let c = a; c <= b; c++) put(ws, r, c, c === a ? value : null, o)
  if (b > a) ws.mergeCells(r, a, r, b)
  return ws.getRow(r).getCell(a)
}

const box = (o = {}) => ({ top: o.t || THIN, left: o.l || THIN, bottom: o.b || THIN, right: o.r || THIN })

// Excel 的表名限制：≤31 字符、不含 : \ / ? * [ ]、不重名、不为空
function sheetName(raw, used) {
  let n = txt(raw).replace(/[:\\/?*[\]]/g, '·').trim() || '表'
  if (n.length > 31) n = n.slice(0, 30) + '…'
  let out = n
  for (let i = 2; used.has(out); i++) {
    const tail = `(${i})`
    out = (n.length + tail.length > 31 ? n.slice(0, 31 - tail.length) : n) + tail
  }
  used.add(out)
  return out
}

// ============================================================================
// 样式版
// ============================================================================

// 总表网格：列数由模型按「最窄的转发器至少 24 格」定（见 fpXlsxModel），列宽在这里按列数反推 ——
// 整幅纸面钉在 GRID_SPAN 个列宽单位上，列多了就细、列少了就粗，横向总宽不随计划的疏密乱跑。
const GRID_SPAN = 230
const gridW = (cols) => Math.max(0.5, Math.min(2.0, GRID_SPAN / Math.max(1, cols)))
const STRIP_W = 3.4       // 分配表载波条的一列
const LBL_W = 10.5

// 纸张与页边距照手上那份示例（A4 横放、上下 1 吋、左右 0.75 吋）—— 一摞表打出来要能装订在一起
const PAGE = {
  orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
  margins: { left: 0.75, right: 0.75, top: 1, bottom: 1, header: 0.5, footer: 0.5 }
}

function writeOverview(wb, model, used) {
  const ws = wb.addWorksheet(sheetName('总表', used), {
    views: [{ showGridLines: false }],
    pageSetup: { ...PAGE }
  })
  const O = model.overview
  const u = model.unit
  const C0 = 2                                   // 网格起列（A 留给极化/行名）
  const last = C0 + O.cols - 1
  const GW = gridW(O.cols)
  // 图例那几栏跨多少格由「想要多宽」反推 —— 网格列宽随计划疏密变，写死跨几格会时宽时窄
  const cw = (units) => Math.max(1, Math.round(units / GW))

  ws.getColumn(1).width = LBL_W
  for (let c = C0; c <= last; c++) ws.getColumn(c).width = GW

  let r = 1
  const title = [model.meta.satName, model.meta.planName].filter(Boolean).join(' · ')
  span(ws, r, 1, last, `${title} —— 转发器频率计划`, { size: 15, bold: true, align: 'center' })
  ws.getRow(r).height = 26
  r++
  span(ws, r, 1, last, model.meta.summary, { size: 9, ink: DIM, align: 'center' })
  r += 2

  for (const band of O.bands) {
    span(ws, r, 1, last, band.title, { size: 11, bold: true, border: { bottom: MED } })
    ws.getRow(r).height = 19
    r++

    const ruler = (row) => {
      for (const b of row.blocks) {
        span(ws, r, C0 + b.c0 - 1, C0 + b.c1 - 1, isNum(b.fc) ? b.fc : null,
          { size: 8, ink: DIM, align: 'center', fmt: GEN, shrink: true })
      }
      ws.getRow(r).height = 13
      r++
    }

    // ★ 一侧可能【只有】信标 / 遥控 / 遥测（它们不归极化行 —— 没有带宽画不成色块），此时
    //   极化行一行都没有，直接取 rows[0] 会当场 TypeError（症状是导出停在「导出失败」上）。
    if (band.rows.length) ruler(band.rows[0])
    band.rows.forEach((row, i) => {
      // ① 编号行：整条只归一个色的就刷那个色（软件里那张图上的样子）；挂着几个波束的留白，
      //    色落在下面那一行上 —— 整块刷第一个波束的色等于把其余几个藏了
      put(ws, r, 1, row.pol, { size: 10, bold: true, align: 'center', border: box() })
      for (const b of row.blocks) {
        span(ws, r, C0 + b.c0 - 1, C0 + b.c1 - 1, b.label, {
          size: 9, bold: true, align: 'center', fill: b.fill, ink: b.ink,
          border: box({ t: MED, l: MED, b: MED, r: MED }), shrink: true
        })
      }
      ws.getRow(r).height = 18
      r++
      // ② 波束行：按波束占段切格、刷【原色】（与屏上、出图同一个色）。同频叠放的各占一层，
      //    故一排可能不止一行（同软件那张图的分层，见模型 laneRows）
      for (const [k, lane] of (row.lanes || []).entries()) {
        if (!k) put(ws, r, 1, '波束', { size: 8, ink: DIM, align: 'center' })
        for (const c of lane) {
          span(ws, r, C0 + c.c0 - 1, C0 + c.c1 - 1, c.label,
            { size: 8, align: 'center', fill: c.fill, ink: c.ink, border: box(), shrink: true })
        }
        ws.getRow(r).height = 15
        r++
      }
      if (i === band.rows.length - 1 && band.rows.length > 1) ruler(row)
    })

    // 信标 / 遥控 / 遥测：一根箭头，不是色块（只有频率与极化，见模型 CHANNEL_KINDS）
    if (band.marks.length) {
      put(ws, r, 1, '信标/TM/TC', { size: 8, ink: DIM, align: 'center' })
      for (const m of band.marks) {
        put(ws, r, C0 + m.c - 1, m.arrow, { size: 9, bold: true, align: 'center', ink: RULE })
      }
      ws.getRow(r).height = 14
      r++
      for (const m of band.marks) {
        put(ws, r, C0 + m.c - 1, `${m.tag} ${m.f} ${u.label} ${m.pol}`.trim(), { size: 8, ink: DIM })
      }
      ws.getRow(r).height = 12
      r++
    }
    r++
  }

  // 图例：色片用【原色】—— 那是「这个色号长什么样」的样本，兑白就与屏上、出图的色片对不上了
  if (O.legend.length || O.los.length) {
    const c1 = C0, c2 = c1 + cw(30) - 1          // 名称 + 带宽
    const c3 = c2 + 1, c4 = c3 + cw(34) - 1      // 占的频段
    const c5 = c4 + 1, c6 = Math.min(last, c5 + cw(40) - 1)
    span(ws, r, 1, Math.min(last, c6), '图例', { size: 11, bold: true, border: { bottom: MED } })
    r++
    for (const g of O.legend) {
      put(ws, r, 1, null, { fill: g.color, border: box() })
      span(ws, r, c1, c2, g.text || g.name, { size: 10 })
      span(ws, r, c3, c4, g.band, { size: 9, ink: DIM })
      span(ws, r, c5, c6, g.note, { size: 9, ink: DIM })
      r++
    }
    for (const l of O.los) {
      put(ws, r, 1, 'LO', { size: 9, ink: DIM, align: 'center' })
      span(ws, r, c1, c2, l.name, { size: 10 })
      span(ws, r, c3, c4, `${l.value} ${u.label}`, { size: 9, ink: DIM })
      span(ws, r, c5, c6, l.note, { size: 9, ink: DIM })
      r++
    }
  }
  return ws
}

// 一张分配表（默认 3 条转发器）——照示例的块式排版
function writeAllocSheet(wb, sheet, model, used) {
  const u = model.unit
  const ws = wb.addWorksheet(sheetName(sheet.name, used), {
    views: [{ showGridLines: false }],
    pageSetup: { ...PAGE }
  })
  const S0 = 2                                   // 条的起列（A 放起始频率与小结标签）
  const SN = (sheet.blocks[0] && sheet.blocks[0].stripCols) || 20
  const SEnd = S0 + SN - 1                       // 条的末列
  const IC = SEnd + 2                            // 冲突明细起列

  ws.getColumn(1).width = LBL_W
  for (let c = S0; c <= SEnd; c++) ws.getColumn(c).width = STRIP_W
  ws.getColumn(SEnd + 1).width = 2
  const ICW = [14, 20, 12, 36]
  ICW.forEach((w, i) => { ws.getColumn(IC + i).width = w })

  // 小结的三栏（标签 / 数值 / 占比）都落在条的列上，与示例同一版式
  const LB0 = 1, LB1 = S0 + 4
  const VB0 = S0 + 5, VB1 = S0 + 8
  const PB0 = S0 + 9, PB1 = S0 + 12

  let r = 1
  for (const b of sheet.blocks) {
    // 标题条：照示例那一条浅黄的横杠（转发器编号 + 起·中·止），右端补极化与上行频带
    const TB = { size: 14, bold: true, fill: TITLE_FILL, border: { top: MED, bottom: { style: 'double', color: { argb: RULE } } } }
    const tCut = Math.max(S0, SEnd - 7)
    span(ws, r, 1, tCut - 1, b.title, { ...TB, align: 'left' })
    span(ws, r, tCut, SEnd, b.tail || null, { ...TB, size: 9, bold: false, ink: DIM, align: 'right' })
    ws.getRow(r).height = 24
    r++

    if (b.segs.length) {
      // ① 频率行：A 写频带（或视域）下边沿，每一段写它自己的上边沿 —— 逐段读下来就是整条频带的刻度
      put(ws, r, 1, b.d0, { size: 9, align: 'right', fmt: GEN, border: { top: THIN, left: MED, bottom: THIN, right: THIN } })
      for (const g of b.segs) {
        span(ws, r, S0 + g.c0 - 1, S0 + g.c1 - 1, g.f2, { size: 9, align: 'right', fmt: GEN, border: box(), shrink: true })
      }
      ws.getRow(r).height = 15
      r++
      // ② 波束占段带：这条频带被哪几个波束分了（示例里色带那一行的位置）。原色，同频叠放的分层
      for (const [k, lane] of (b.beamLanes || []).entries()) {
        if (!k) put(ws, r, 1, '波束', { size: 8, ink: DIM, align: 'right' })
        for (const c of lane) {
          span(ws, r, S0 + c.c0 - 1, S0 + c.c1 - 1, c.label,
            { size: 8, align: 'center', fill: c.fill, ink: c.ink, border: box(), shrink: true })
        }
        ws.getRow(r).height = 14
        r++
      }
      // ③ 带宽行
      put(ws, r, 1, `带宽 ${u.label}`, { size: 8, ink: DIM, align: 'right' })
      for (const g of b.segs) {
        span(ws, r, S0 + g.c0 - 1, S0 + g.c1 - 1, g.bw, { size: 9, align: 'center', fmt: GEN, border: box(), shrink: true })
      }
      ws.getRow(r).height = 15
      r++
      // ④ 载波行：底色 = 该载波所属波束的【原色】（与屏上、出图同一个色）
      for (const g of b.segs) {
        span(ws, r, S0 + g.c0 - 1, S0 + g.c1 - 1, g.name, {
          size: 10, bold: !g.gap, align: 'center', wrap: true,
          fill: g.fill, ink: g.ink,
          border: g.out ? box({ t: MED, l: MED, b: MED, r: MED }) : box()
        })
      }
      ws.getRow(r).height = 24
      r++
      // ⑤ 波束 · 调制 · 速率
      if (b.segs.some((g) => g.sub)) {
        for (const g of b.segs) {
          span(ws, r, S0 + g.c0 - 1, S0 + g.c1 - 1, g.sub || null,
            { size: 8, ink: DIM, align: 'center', border: box({ t: HAIR, l: HAIR, b: HAIR, r: HAIR }), shrink: true })
        }
        ws.getRow(r).height = 13
        r++
      }
    } else {
      // 没有载波的转发器仍有一个「空」段（整条频带），故段表为空只可能是【没有下行频带】——
      // 未挂 LO 又没显式填下行的那种，排不出条
      span(ws, r, 1, SEnd, '该转发器没有下行频带。', { size: 9, ink: DIM })
      r++
    }
    r++

    // 使用情况总结 ‖ 冲突与越界明细（并排两栏，同示例）
    const r0 = r
    span(ws, r, LB0, PB1, '使用情况总结', { size: 10, bold: true, border: { bottom: THIN } })
    for (const [i, row] of b.summary.entries()) {
      const rr = r + 1 + i
      span(ws, rr, LB0, LB1, row[0], { size: 9, border: { bottom: HAIR } })
      span(ws, rr, VB0, VB1, row[1], { size: 9, align: 'right', fmt: GEN, border: { bottom: HAIR } })
      span(ws, rr, PB0, PB1, row[2] == null ? null : row[2] / 100,
        { size: 9, align: 'right', fmt: '0.0%', ink: DIM, border: { bottom: HAIR } })
    }

    span(ws, r, IC, IC + 3, '冲突与越界明细', { size: 10, bold: true, border: { bottom: THIN } })
    const ih = ['载波', '频率范围', `占用带宽 (${u.label})`, '说明']
    ih.forEach((h, i) => put(ws, r + 1, IC + i, h, { size: 9, bold: true, align: 'center', fill: HEAD_FILL, border: box({ t: THIN, b: THIN }) }))
    if (b.issues.length) {
      b.issues.forEach((is, i) => {
        const rr = r + 2 + i
        put(ws, rr, IC, is.no, { size: 9, border: { bottom: HAIR } })
        put(ws, rr, IC + 1, is.range, { size: 9, align: 'center', border: { bottom: HAIR } })
        put(ws, rr, IC + 2, is.bw, { size: 9, align: 'right', fmt: GEN, border: { bottom: HAIR } })
        put(ws, rr, IC + 3, is.msg, { size: 9, wrap: true, border: { bottom: HAIR } })
      })
    } else {
      span(ws, r + 2, IC, IC + 3, '无。', { size: 9, ink: DIM, border: { bottom: HAIR } })
    }

    r = r0 + Math.max(b.summary.length, b.issues.length + 1) + 2
    r++
  }
  return ws
}

function writeOrphan(wb, model, used) {
  const u = model.unit
  const ws = wb.addWorksheet(sheetName('未归属载波', used), {
    views: [{ showGridLines: false }], pageSetup: { ...PAGE }
  })
  const cols = ['载波', `中心频率 (${u.label})`, `占用带宽 (${u.label})`, `功率带宽 (${u.label})`, '调制 · 编码', '信息速率 (kbps)', '备注']
  const w = [22, 16, 16, 16, 16, 16, 30]
  w.forEach((x, i) => { ws.getColumn(i + 1).width = x })
  span(ws, 1, 1, cols.length, '未归属转发器的载波（上行域）', { size: 12, bold: true })
  cols.forEach((h, i) => put(ws, 3, i + 1, h, { size: 10, bold: true, align: 'center', border: { top: MED, bottom: THIN } }))
  model.orphan.forEach((o, i) => {
    const rr = 4 + i
    const b = i === model.orphan.length - 1 ? { bottom: MED } : { bottom: HAIR }
    put(ws, rr, 1, o.name, { size: 10, border: b })
    put(ws, rr, 2, o.fc, { size: 10, align: 'right', fmt: GEN, border: b })
    put(ws, rr, 3, o.bw, { size: 10, align: 'right', fmt: GEN, border: b })
    put(ws, rr, 4, o.pwr, { size: 10, align: 'right', fmt: GEN, border: b })
    put(ws, rr, 5, o.modcod, { size: 10, border: b })
    put(ws, rr, 6, o.rate, { size: 10, align: 'right', fmt: '0', border: b })
    put(ws, rr, 7, o.note, { size: 10, border: b })
  })
  return ws
}

// 波束表：总表的图例只写「这个色是谁、多宽」，一个波束落在哪几条转发器上写不进那一行 ——
// 那恰是这份计划里波束的全部事实，故单成一张（同示例末尾那几张分色说明的位置）
function writeBeams(wb, model, used) {
  const u = model.unit
  const ws = wb.addWorksheet(sheetName('波束', used), {
    views: [{ showGridLines: false }], pageSetup: { ...PAGE }
  })
  const beams = model.beams || []
  const cols = ['', '#', '波束', '色值', `标称带宽 (${u.label})`, '转发器数', `占用带宽 (${u.label})`, '转发器', '来源']
  const w = [3.2, 5, 24, 11, 15, 10, 15, 44, 34]
  w.forEach((x, i) => { ws.getColumn(i + 1).width = x })
  span(ws, 1, 1, cols.length, '波束 / 带宽组', { size: 13, bold: true })
  ws.getRow(1).height = 22
  span(ws, 2, 1, cols.length, `${model.meta.satName ? model.meta.satName + ' · ' : ''}${model.meta.planName} · 占用带宽按【下行】占段合计`,
    { size: 9, ink: DIM })
  cols.forEach((h, i) => put(ws, 4, i + 1, h, {
    size: 9, bold: true, align: 'center', wrap: true, fill: HEAD_FILL, border: { top: MED, bottom: THIN }
  }))
  ws.getRow(4).height = 24
  if (!beams.length) {
    span(ws, 5, 1, cols.length, '这份计划还没有波束。', { size: 10, ink: DIM, align: 'center', border: { bottom: MED } })
    return ws
  }
  beams.forEach((b, i) => {
    const rr = 5 + i
    const bd = { bottom: i === beams.length - 1 ? MED : HAIR }
    // 色片用【原色】—— 那是「这个色号长什么样」的样本
    put(ws, rr, 1, null, { fill: b.color, border: box() })
    put(ws, rr, 2, b.no, { size: 9, align: 'center', border: bd })
    put(ws, rr, 3, b.name, { size: 10, border: bd })
    put(ws, rr, 4, b.hex, { size: 9, align: 'center', ink: DIM, border: bd })
    put(ws, rr, 5, b.bw, { size: 9, align: 'right', fmt: GEN, border: bd })
    put(ws, rr, 6, b.tpCount, { size: 9, align: 'right', fmt: '0', border: bd })
    put(ws, rr, 7, b.occ, { size: 9, align: 'right', fmt: GEN, border: bd })
    put(ws, rr, 8, b.tps, { size: 9, border: bd })
    put(ws, rr, 9, b.note, { size: 9, ink: DIM, border: bd })
    ws.getRow(rr).height = 16
  })
  return ws
}

function buildStyled(wb, model) {
  const used = new Set()
  writeOverview(wb, model, used)
  writeBeams(wb, model, used)
  for (const sheet of model.sheets) writeAllocSheet(wb, sheet, model, used)
  if (model.orphan && model.orphan.length) writeOrphan(wb, model, used)
}

// ============================================================================
// 纯数据版：三线表 + 冻结窗格
// ============================================================================

function writeDataSheet(wb, sh, model, used) {
  const ws = wb.addWorksheet(sheetName(sh.name, used), {
    views: [{
      showGridLines: false,
      state: sh.freeze ? 'frozen' : 'normal',
      xSplit: sh.freeze ? Math.min(sh.freeze, 3) : 0,
      ySplit: sh.freeze ? 4 : 0
    }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  })
  const cols = sh.columns
  cols.forEach((c, i) => { if (c.width) ws.getColumn(i + 1).width = c.width })

  span(ws, 1, 1, cols.length, sh.title, { size: 13, bold: true })
  ws.getRow(1).height = 22
  span(ws, 2, 1, cols.length, `${model.meta.satName ? model.meta.satName + ' · ' : ''}${model.meta.planName} · 刻度 ${model.unit.label}`,
    { size: 9, ink: DIM })

  if (sh.kv) {
    // 概览是键值表：分节行加粗、其余细线分隔（不套三线表 —— 那是给矩阵用的）
    let r = 4
    let lastData = 0                     // 表末那条粗线画在最后一条【数据行】上，不画在分节行上
    for (const [k, v, unit] of sh.rows) {
      const sec = v === null && unit === null
      if (!sec) lastData = r
      if (sec) {
        span(ws, r, 1, 3, String(k).replace(/^——\s*/, ''), { size: 10, bold: true, border: { bottom: THIN } })
      } else {
        put(ws, r, 1, k, { size: 10, border: { bottom: HAIR } })
        // 概览是一列杂项（条数 / 频率 / 百分比混在一起），没有「同列对齐」可言，故不定小数位：
        // 定了就会在同一段里写出 5922 与 4199.50 两种笔法。数值在模型出手前已按刻度收过小数。
        // 数右文左：这一列里既有数也有整句（计划名、校验说明），一律右对齐会把句子推到列尾去
        put(ws, r, 2, v, { size: 10, align: isNum(v) ? 'right' : 'left', fmt: GEN, border: { bottom: HAIR } })
        put(ws, r, 3, unit, { size: 10, ink: DIM, border: { bottom: HAIR } })
      }
      r++
    }
    if (lastData) {
      for (let c = 1; c <= 3; c++) {
        const cell = ws.getRow(lastData).getCell(c)
        cell.border = Object.assign({}, cell.border, { bottom: MED })
      }
    }
    return ws
  }

  // 表头（三线表的上两条线）
  cols.forEach((c, i) => put(ws, 4, i + 1, c.header, {
    size: 9, bold: true, align: 'center', wrap: true,
    fill: HEAD_FILL, border: { top: MED, bottom: THIN }
  }))
  ws.getRow(4).height = 26

  if (!sh.rows.length) {
    span(ws, 5, 1, cols.length, '无记录。', { size: 10, ink: DIM, align: 'center', border: { bottom: MED } })
    return ws
  }
  sh.rows.forEach((row, ri) => {
    const rr = 5 + ri
    const bd = { bottom: ri === sh.rows.length - 1 ? MED : HAIR }
    cols.forEach((c, ci) => {
      const v = row[ci]
      put(ws, rr, ci + 1, v === undefined ? null : v, {
        size: 9,
        align: c.align || (isNum(v) ? 'right' : 'left'),
        fmt: isNum(v) ? c.fmt : null,
        border: bd
      })
    })
  })
  // 自动筛选：几百行的载波表靠它挑（表头恰在第 4 行）
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + sh.rows.length, column: cols.length } }
  return ws
}

function buildData(wb, model) {
  const used = new Set()
  for (const sh of model.sheets) writeDataSheet(wb, sh, model, used)
  // 只增不减地放宽装不下的列与行（版式不变，只是不再截断）。样式版不走这一步：
  // 那张表的色块宽度就是带宽，放宽某一列等于改了比例尺。
  autofitBook(wb, { maxWidth: 46, spreadSpan: 3 })
}

// ============================================================================

// 主题字体：exceljs 硬写 Calibri/Cambria，换掉之后空白格与用户后填的内容也是 TNR（同 report.js）
function applyBookFont(wb) {
  try {
    const theme1 = require('exceljs/lib/xlsx/xml/theme1.js')
    wb._themes = { theme1: String(theme1).replace(/<a:latin typeface="(Calibri|Cambria)"\/>/g, `<a:latin typeface="${FNT}"/>`) }
  } catch (e) { /* exceljs 内部结构变了就跳过，已写入的单元格字体不受影响 */ }
  return wb
}

/**
 * 模型 → .xlsx Buffer。
 * @param {object} model buildStyledXlsx / buildDataXlsx 的返回值（纯数据）
 */
async function buildFreqPlanWorkbook(model) {
  if (!model || typeof model !== 'object') throw new Error('导出数据为空')
  const wb = new ExcelJS.Workbook()
  wb.creator = '卫星仿真平台'
  wb.created = new Date()
  if (model.kind === 'data') buildData(wb, model)
  else buildStyled(wb, model)
  return applyBookFont(wb).xlsx.writeBuffer()
}

module.exports = { buildFreqPlanWorkbook }
