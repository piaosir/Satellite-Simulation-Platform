// MODCOD 表的渲染端口径：列定义、单元格读写、Excel 出表模型与回表解析。
//
// 与 shared/gridXlsx.js 的分工照旧 —— 那份只管「工作表 ⇄ 格子」，「哪一列是门限」在这里。
// 一张工作表 = 一个标准，表名即标准名（与航迹批量表格同一约定），故导入一份工作簿即可
// 【一次改多个标准 + 一次新建多个自定义标准】。
//
// 数值的归一（门限口径写法、缺省值、空行丢弃）不在这里做：主进程存盘前一律过
// packages/core/utils/modcodTables.js 的 normalizeRows，那是唯一一份口径。本模块只把
// 用户在格子里/Excel 里敲的原文原样递过去。

import { sheetModel, findHeader, sheetToRecords, safeFileName, safeSheetName } from './gridXlsx.js'
import { modulationOptions, modFactorOf, parseModulation, composeModulation } from './carrierRate.js'

// 门限口径的人读写法 ⇄ 内部值。Excel 里存人读写法（导出的表要能直接给人看），
// 回表时两种写法都认（用户手搓的表常写 EsNo / Es/N0）。
export const MODE_LABEL = { ebno: 'Eb/N₀', esno: 'Es/N₀' }
export const MODE_OPTIONS = [{ value: 'esno', label: 'Es/N₀' }, { value: 'ebno', label: 'Eb/N₀' }]
export function parseMode(v) {
  const s = String(v == null ? '' : v).toLowerCase().replace(/[\s/₀0]/g, '')
  return s.indexOf('ebn') === 0 ? 'ebno' : 'esno'
}

// 调制方式规范化：认得出就吐规范写法（'qpsk' → 'QPSK'），认不出吐空串。
// ★ 空串＝「这不是一个调制方式」，调用方一律【不写】而不是写个空值 —— 调制因子是符号率/带宽
//   整条换算链的乘数，写进一个查不到的名字，引擎会静默按 2 bit/符号算，账面上一切正常。
export function canonModulation(v) {
  const p = parseModulation(v)
  return p ? composeModulation(p.family, p.order) : ''
}
export const modBits = (v) => modFactorOf(v)

// 网格列。顺序 = 导出列序 = 「无表头时按位置认」的兜底列序，改这里三处一起变。
// num 决定右对齐与「按数字存进 Excel」；fix 是 Excel 数字格式的小数位。
export const MODCOD_COLS = [
  { key: 'label', label: 'MODCOD', w: 180, align: 'left', tip: '这一档在载波信号面板 MODCOD 下拉里显示的名字' },
  { key: 'modulation', label: '调制方式', w: 108, tip: '只能从列表里选，或按制式族 + 星座阶数 M 现造一个；调制因子＝log₂M' },
  { key: 'fec', label: 'FEC 码率', w: 96, tip: '内码码率，写分数（3/4、120/1024）或小数' },
  { key: 'rsCode', label: '帧效率', w: 96, tip: '外码/帧开销效率，写分数（188/204）或小数（0.9）' },
  { key: 'bandwidthFactor', label: '滚降系数', unit: '1+α', w: 96, num: true, fix: 2, tip: '占用带宽 / 符号率；3GPP 各档此列是「占用带宽→信道带宽」的换算而非滚降' },
  { key: 'noiseRatioMode', label: '门限口径', w: 100, tip: 'Eb/N₀ 或 Es/N₀ —— 决定右侧门限值按哪种口径解读' },
  { key: 'threshold', label: '门限', unit: 'dB', w: 96, num: true, fix: 2, tip: '解调门限，口径由左侧那一列决定' }
]

/**
 * 网格用的列 —— 在上面那份之上，给调制方式与门限口径挂 options（枚举列，见 useGridSelect）。
 * ★ Excel 那一份（MODCOD_COLS）刻意不挂：出表/回表只用得上列标签与列序，挂了反而让「一份列定义
 *   同时服务两种用途」这件事变糊涂。
 * used：() => 当前表里已用到的调制方式名（自定义档不能从它自己那格的下拉里消失）。
 */
export function modcodGridCols(used) {
  return MODCOD_COLS.map((c) => {
    if (c.key === 'modulation') {
      return { ...c, options: () => modulationOptions(used ? used() : []).map((o) => ({ value: o.value, label: o.label, note: o.factor + ' bit' })) }
    }
    if (c.key === 'noiseRatioMode') return { ...c, options: () => MODE_OPTIONS.map((o) => ({ value: o.label, label: o.label })) }
    return c
  })
}

// 格子显示文本（网格与剪贴板同一口径）
export function cellText(row, col) {
  const v = row[col.key]
  if (col.key === 'noiseRatioMode') return MODE_LABEL[v] || MODE_LABEL.esno
  return v == null ? '' : String(v)
}
// 单元格悬停读数：调制方式那格报它的调制因子（符号率 = 载波速率 ÷ 它，值得随手看得见）
export function cellTip(row, col) {
  if (col.key !== 'modulation') return ''
  const f = modFactorOf(row.modulation)
  return f == null ? '' : `${row.modulation} · ${f} bit/符号`
}

// 一格写入。数字列留原文（用户正打到「-」「1.」这类中间态时不能当场吃掉），
// 落库前由主进程的 normalizeRows 统一转数字。
// ★ 两个枚举列在这里【也要】把关：下拉挡住的是键盘那条路，粘贴 / 填充柄 / Excel 导入走的是本函数。
//   认不出的调制方式一律不写（保留原值），而不是写进去等引擎按 2 bit/符号静默算错。
export function setCell(row, key, val) {
  if (key === 'noiseRatioMode') { row.noiseRatioMode = parseMode(val); return }
  if (key === 'modulation') { const v = canonModulation(val); if (v) row.modulation = v; return }
  row[key] = String(val == null ? '' : val)
}

// 新建一行：延用上一行的调制体制口径（帧效率/滚降/门限口径三项跟着走），
// 逐条重填这三格是纯体力活，而同一个标准里它们几乎恒定。
export function emptyRow(prev, id) {
  return {
    id,
    label: '',
    modulation: (prev && prev.modulation) || 'QPSK',
    fec: '',
    rsCode: (prev && prev.rsCode) || '0.9',
    bandwidthFactor: (prev && prev.bandwidthFactor) != null ? prev.bandwidthFactor : 1.05,
    noiseRatioMode: (prev && prev.noiseRatioMode) || 'esno',
    threshold: ''
  }
}

/* ===================== Excel 出表 ===================== */

/**
 * 一个标准 = 一张工作表，表名即标准名。
 * ★ 表名在【这里】就合法化好（safeSheetName，与主进程同一支），不再让主进程去改：
 *   往返是按表名对号入座的，名字若在导出那一刻被悄悄改写（超 31 字符截断 / `:\/?*[]` 换成 ·），
 *   再把同一个文件导回来就找不到原标准，会凭空新建一个重名的自定义标准。预先算好就没有这个错位，
 *   导入侧也能用 modcodSheetNames 拿同一把尺子反查。
 */
export function modcodSheets(standards) {
  const used = new Set()
  return (standards || []).map((s) => sheetModel({
    name: safeSheetName(s.label || s.key, used),
    cols: MODCOD_COLS,
    rows: s.rows || [],
    value: (r, c) => (c.key === 'noiseRatioMode' ? (MODE_LABEL[r.noiseRatioMode] || MODE_LABEL.esno) : r[c.key])
  }))
}

// 预演一次导出的表名 → 该标准。导入时用它把「被合法化改写过的表名」认回原标准（见 modcodSheets）。
// 必须与 modcodSheets 同序同算法遍历：重名消歧的 (2)(3) 后缀依赖顺序。
export function modcodSheetNames(standards) {
  const used = new Set(), map = new Map()
  for (const s of standards || []) map.set(safeSheetName(s.label || s.key, used), s)
  return map
}

export const modcodFileName = (n) => safeFileName('MODCOD 表' + (n ? '_' + n : ''), 'MODCOD 表') + '.xlsx'

/* ===================== Excel 回表 ===================== */

// 无表头的兜底：按位置认列（列序 = MODCOD_COLS）。手搓的表常常只有数据没有表头。
function recordsByPosition(rows) {
  const out = []
  for (const cells of rows || []) {
    if (!cells || !cells.length) continue
    const rec = {}
    MODCOD_COLS.forEach((c, i) => { rec[c.key] = cells[i] == null ? '' : String(cells[i]) })
    // 一行里连「名字 / 调制 / 码率」都全空的当空行丢掉（合计行、注释行常长这样）
    if (!rec.label && !rec.modulation && !rec.fec) continue
    out.push(rec)
  }
  return out
}

/**
 * 一份工作簿 → 待应用的标准清单 [{ name, rows }]。
 *   有表头按表头取列（调过列序、删掉不用的列都认），认不出退回按位置认；
 *   一条 MODCOD 都读不到的表整张丢掉 —— 工作簿里常混着说明表/无关表，不能每张都造一个空标准。
 * 说明表（主进程给带 note 的表单开的那张）按表名跳过。
 */
export function standardsFromSheets(sheets) {
  const out = []
  for (const s of sheets || []) {
    if (!s || !s.rows || !s.rows.length) continue
    const nm = String(s.name || '').trim()
    if (nm === '说明') continue
    const head = findHeader(s.rows, MODCOD_COLS)
    let recs
    if (head) {
      const r = sheetToRecords(s, MODCOD_COLS)
      recs = (r.records || []).filter((x) => x.label || x.modulation || x.fec)
    } else {
      recs = recordsByPosition(s.rows)
    }
    if (!recs.length) continue
    // ★ 调制方式认不出的行【整行不收】，并把原值报回去 —— 收进来只能落成默认的 QPSK，
    //   那就是「导进来了，数悄悄按 2 bit/符号算」。宁可少收几行并当场说清楚。
    const rows = [], bad = []
    for (const r of recs) {
      const mod = canonModulation(r.modulation)
      if (r.modulation && !mod) { bad.push(String(r.modulation).trim()); continue }
      rows.push({
        label: r.label || '',
        modulation: mod,
        fec: r.fec || '',
        rsCode: r.rsCode || '',
        bandwidthFactor: r.bandwidthFactor || '',
        noiseRatioMode: parseMode(r.noiseRatioMode),
        threshold: r.threshold || ''
      })
    }
    if (!rows.length && !bad.length) continue
    out.push({ name: nm, rows, bad })
  }
  return out
}

// 导入结果里被挡下的调制方式（去重，按出现次序），供反馈文案逐条点名
export function rejectedModulations(list) {
  const seen = new Set()
  for (const s of list || []) for (const v of (s.bad || [])) if (v && !seen.has(v)) seen.add(v)
  return [...seen]
}
