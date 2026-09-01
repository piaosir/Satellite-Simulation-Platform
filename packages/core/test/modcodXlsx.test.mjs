// MODCOD 表 ⇄ Excel 往返 + 三线表版式自测。运行：npm test
//
// 锁定两件事：
//   ① 版式与链路预算报告里的表【同款】—— 顶线 1.5pt / 栏目线 0.75pt / 底线 1.5pt、无竖线、
//      无底纹、表头不加粗且中文黑体、表内中文宋体、西文与数字 Times New Roman、无筛选器。
//      这一档是「导出即交付件」的凭据，任何一项漂了都要在这里立刻现形。
//   ② 换了版式仍导得回来：写盘 → 读回 → 解析，逐值等于导出前那份。
//      三线表档若哪天加了标题条/合并格，「首行 = 表头」就破功，本测试会失败。
import { createRequire } from 'module'
import { modcodSheets, modcodSheetNames, standardsFromSheets, MODCOD_COLS, modcodGridCols, setCell, canonModulation, rejectedModulations } from '../../../src/shared/modcodTable.js'
import { safeSheetName as sheetNameUi } from '../../../src/shared/gridXlsx.js'
import fs from 'fs'
import os from 'os'
import path from 'path'
const require = createRequire(import.meta.url)
const { buildGridWorkbook, readGridWorkbook, safeSheetName: sheetNameMain } = require('../../../electron/services/gridXlsx.js')
const M = require('../utils/modcodTables.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

const STDS = M.listStandards(null).slice(0, 3).concat([
  // 中西混排的标准名与 MODCOD 名：富文本拆分那一支必须走到
  { key: 'usr:1', label: '中星 6E 上行', builtin: false, rows: [
    { label: '低速率档 QPSK 1/2', modulation: 'QPSK', fec: '1/2', rsCode: '0.9', bandwidthFactor: 1.2, noiseRatioMode: 'ebno', threshold: 3.75 },
    { label: '高速率档 16APSK 3/4', modulation: '16APSK', fec: '3/4', rsCode: '0.9', bandwidthFactor: 1.2, noiseRatioMode: 'esno', threshold: 10.21 }
  ] }
])

const buf = await buildGridWorkbook({ style: 'report', sheets: modcodSheets(STDS) })
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcx-')), 'modcod.xlsx')
fs.writeFileSync(tmp, Buffer.from(buf))

/* ---- ① 版式 ---- */
const ExcelJS = require('exceljs')
const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(tmp)
const ws = wb.getWorksheet(1)
const NC = MODCOD_COLS.length
const hcell = (c) => ws.getCell(1, c)
const bcell = (c) => ws.getCell(2, c)

ok('每个标准一张工作表，表名即标准名',
  STDS.every((s, i) => wb.getWorksheet(i + 1).name === s.label), wb.worksheets.map((w) => w.name).join(' | '))
// 中西混排的格已被 applyBookFont 拆成富文本，取字要把段拼回来（readGridWorkbook 那边同理）
const txt = (v) => (v && Array.isArray(v.richText) ? v.richText.map((t) => t.text).join('') : String(v == null ? '' : v))
ok('表头 = 界面列标签（带括号单位）',
  txt(hcell(1).value) === 'MODCOD' && txt(hcell(5).value) === '滚降系数 (1+α)' && txt(hcell(7).value) === '门限 (dB)',
  [1, 5, 7].map((c) => txt(hcell(c).value)).join(' | '))
ok('表头顶线 1.5pt（medium 纯黑）',
  Array.from({ length: NC }, (_, i) => hcell(i + 1)).every((c) => c.border.top && c.border.top.style === 'medium' && c.border.top.color.argb === 'FF000000'))
ok('表头下是 0.75pt 栏目线（thin），不是粗线',
  Array.from({ length: NC }, (_, i) => hcell(i + 1)).every((c) => c.border.bottom && c.border.bottom.style === 'thin'))
ok('三线表无竖线', Array.from({ length: NC }, (_, i) => hcell(i + 1)).every((c) => !c.border.left && !c.border.right) &&
  Array.from({ length: NC }, (_, i) => bcell(i + 1)).every((c) => !c.border.left && !c.border.right))
ok('三线表无底纹', Array.from({ length: NC }, (_, i) => hcell(i + 1)).every((c) => !c.fill || c.fill.type !== 'pattern' || c.fill.pattern === 'none'))
ok('表头中文黑体、不加粗、居中',
  hcell(2).font.name === '黑体' && !hcell(2).font.bold && hcell(2).alignment.horizontal === 'center')
ok('表内数字 Times New Roman 且右对齐',
  bcell(7).font.name === 'Times New Roman' && bcell(7).alignment.horizontal === 'right' && typeof bcell(7).value === 'number')
ok('表内纯中文格走宋体', (() => {
  const c = wb.getWorksheet(4).getCell(2, 6)   // 门限口径列写的是 Es/N₀ —— 纯西文，换看名称列
  const nm = wb.getWorksheet(4).getCell(2, 1)
  return nm.value && Array.isArray(nm.value.richText)
    ? nm.value.richText.some((t) => t.font.name === '宋体') && nm.value.richText.some((t) => t.font.name === 'Times New Roman')
    : nm.font.name === '宋体' && c
})(), '中西混排格拆成富文本、两段各挂各的字体')
ok('末行下沿收 1.5pt 底线', (() => {
  const n = STDS[0].rows.length + 1
  return Array.from({ length: NC }, (_, i) => ws.getCell(n, i + 1)).every((c) => c.border.bottom && c.border.bottom.style === 'medium')
})())
ok('三线表不挂筛选器（下拉箭头是画在表头上的可见装饰）', !ws.autoFilter)
ok('工作簿主题字体已换成 TNR + 宋体（用户导出后新键入的内容跟着走）',
  /Times New Roman/.test(String(wb._themes && wb._themes.theme1)) && /宋体/.test(String(wb._themes && wb._themes.theme1)))

/* ---- 朴素档仍是原来那副样子（既有三张表的导出不受本次改动影响）---- */
const buf2 = await buildGridWorkbook({ sheets: modcodSheets(STDS.slice(0, 1)) })
const tmp2 = path.join(path.dirname(tmp), 'plain.xlsx')
fs.writeFileSync(tmp2, Buffer.from(buf2))
const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.readFile(tmp2)
const ws2 = wb2.getWorksheet(1)
ok('朴素档：表头仍加粗 + 灰底 + 筛选器 + 细竖线',
  ws2.getCell(1, 1).font.bold === true && ws2.getCell(1, 1).fill.type === 'pattern' && !!ws2.autoFilter && !!ws2.getCell(2, 1).border.left)

/* ---- ② 往返 ---- */
const read = await readGridWorkbook(tmp)
const backSheets = standardsFromSheets(read.sheets)
ok('读回的标准数与表名一致',
  backSheets.length === STDS.length && backSheets.every((b, i) => b.name === STDS[i].label),
  backSheets.map((b) => b.name).join(' | '))
const sig = (rows) => JSON.stringify(M.normalizeRows(rows).map((r) => [r.label, r.modulation, r.fec, r.rsCode, r.bandwidthFactor, r.noiseRatioMode, r.threshold]))
ok('逐值往返不漂（含 Eb/N₀ ⇄ Es/N₀ 口径列）',
  backSheets.every((b, i) => sig(b.rows) === sig(STDS[i].rows)),
  backSheets.map((b, i) => (sig(b.rows) === sig(STDS[i].rows) ? '' : b.name)).filter(Boolean).join(',') || '全部一致')

/* ---- 调过列序 / 删掉几列的手改表也认 ---- */
ok('列序调换 + 删列 后仍按表头认得出来', (() => {
  const sheet = { name: '手改表', rows: [['门限 (dB)', 'MODCOD', 'FEC 码率'], [4.03, 'QPSK 3/4', '3/4']] }
  const r = standardsFromSheets([sheet])
  return r.length === 1 && r[0].rows[0].label === 'QPSK 3/4' && String(r[0].rows[0].threshold) === '4.03' && r[0].rows[0].fec === '3/4'
})())
ok('没有表头的手搓表按列序位置认', (() => {
  const sheet = { name: '无表头', rows: [['QPSK 1/2', 'QPSK', '1/2', '0.9', 1.05, 'Es/N₀', 1.0]] }
  const r = standardsFromSheets([sheet])
  return r.length === 1 && r[0].rows[0].modulation === 'QPSK' && r[0].rows[0].noiseRatioMode === 'esno'
})())
ok('说明表与空表不会造出空标准', standardsFromSheets([{ name: '说明', rows: [['a', 'b']] }, { name: '空', rows: [] }]).length === 0)

/* ---- ③ 两个枚举列：只收得进存在的值 ---- */
// 界面上下拉挡的是键盘那条路；粘贴 / 填充柄 / Excel 导入走的是 setCell —— 两条都必须挡
ok('setCell：调制方式大小写归一', (() => {
  const r = { modulation: 'QPSK' }; setCell(r, 'modulation', ' 16apsk '); return r.modulation === '16APSK'
})())
ok('★ setCell：认不出的调制方式一律不写（保留原值，绝不落成默认让引擎按 2 bit/符号算）', (() => {
  const r = { modulation: 'QPSK' }
  for (const bad of ['乱写', '6PSK', '8APSK', '2QAM', '', '  ', 'QAM']) { setCell(r, 'modulation', bad); if (r.modulation !== 'QPSK') return false }
  return true
})())
ok('setCell：门限口径只落 ebno/esno 两值', (() => {
  const r = {}
  setCell(r, 'noiseRatioMode', 'Eb/N₀'); if (r.noiseRatioMode !== 'ebno') return false
  setCell(r, 'noiseRatioMode', 'Es/N₀'); if (r.noiseRatioMode !== 'esno') return false
  setCell(r, 'noiseRatioMode', '随便写'); return r.noiseRatioMode === 'esno'
})())
ok('canonModulation：自定义阶数收得进来、非 2 的幂挡在外面',
  canonModulation('1024qam') === '1024QAM' && canonModulation('6PSK') === '' && canonModulation('512APSK') === '512APSK')

const gcols = modcodGridCols(() => ['1024QAM'])
ok('网格列：只有调制方式与门限口径是枚举列',
  gcols.filter((c) => c.options).map((c) => c.key).join(',') === 'modulation,noiseRatioMode')
ok('调制方式候选 = 内置 11 项 + 本表已用到的自定义档', (() => {
  const v = gcols.find((c) => c.key === 'modulation').options().map((o) => o.value)
  return v.length === 12 && v[0] === 'BPSK' && v[11] === '1024QAM'
})())
ok('候选项带调制因子读数（bit/符号）',
  gcols.find((c) => c.key === 'modulation').options().find((o) => o.value === '256APSK').note === '8 bit')
ok('门限口径候选恰是两项', gcols.find((c) => c.key === 'noiseRatioMode').options().map((o) => o.value).join(',') === 'Es/N₀,Eb/N₀')
ok('Excel 那份列定义刻意不带 options（两种用途分开）', MODCOD_COLS.every((c) => !c.options))

ok('★ Excel 导入：调制方式认不出的行整行不收，并把原值报回去', (() => {
  const H = MODCOD_COLS.map((c) => c.label + (c.unit ? ' (' + c.unit + ')' : ''))
  const r = standardsFromSheets([{ name: 'T', rows: [H,
    ['a', 'qpsk', '1/2', '0.9', 1.05, 'Es/N₀', 1.0],
    ['b', '乱写', '3/4', '0.9', 1.05, 'Es/N₀', 4.0],
    ['c', '1024QAM', '5/6', '0.9', 1.05, 'Eb/N₀', 20]] }])
  return r.length === 1 && r[0].rows.length === 2 &&
    r[0].rows[0].modulation === 'QPSK' && r[0].rows[1].modulation === '1024QAM' &&
    rejectedModulations(r).join(',') === '乱写'
})())

/* ---- ④ 表名往返：Excel 会改写表名，改写后仍要认得回原标准 ---- */
// 往返是按【表名＝标准名】对号入座的，而 Excel 的表名不许超 31 字符、不许带 `: \ / ? * [ ]`。
// 只比字面量的话，长名 / 带这些字符的自定义标准「导出→原样导回」会凭空新建一个重名标准而不是覆盖。
const TRICKY = [
  '中星 6E / Ku 上行',                                   // 含 /
  'DVB-S2X 自建门限表 用于验证 Excel 表名三十一字符上限的截断行为',   // 39 字符，超 31 上限
  'A:B*C?D[E]F\\G',                                      // 全部非法字符
  ''                                                     // 空名 → 'Sheet'
]
ok('★ 表名合法化：渲染端镜像与主进程逐字一致', TRICKY.every((n) => sheetNameUi(n) === sheetNameMain(n)))
ok('表名合法化：非法字符换成 · 且截到 31 字符',
  sheetNameUi('A:B*C?D[E]F\\G') === 'A·B·C·D·E·F·G' && sheetNameUi('x'.repeat(40)).length === 31)
ok('表名合法化：重名消歧的 (2)(3) 两端同款', (() => {
  const a = new Set(), b = new Set()
  const ua = ['同名', '同名', '同名'].map((n) => sheetNameUi(n, a))
  const ub = ['同名', '同名', '同名'].map((n) => sheetNameMain(n, b))
  return ua.join('|') === ub.join('|') && ua.join('|') === '同名|同名(2)|同名(3)'
})())

const RT = [
  { key: 'usr:9', label: TRICKY[0], builtin: false, rows: [{ label: 'QPSK 1/2', modulation: 'QPSK', fec: '1/2', rsCode: '0.9', bandwidthFactor: 1.2, noiseRatioMode: 'esno', threshold: 1.0 }] },
  { key: 'usr:8', label: TRICKY[1], builtin: false, rows: [{ label: '16APSK 3/4', modulation: '16APSK', fec: '3/4', rsCode: '0.9', bandwidthFactor: 1.2, noiseRatioMode: 'esno', threshold: 10.2 }] }
]
ok('★ 导出→导回：被改写过表名的自定义标准仍认回原标准（不再多出重名副本）', (() => {
  const names = modcodSheets(RT).map((s) => s.name)
  const back = modcodSheetNames(RT)
  // 导出用的表名 = 预演出来的那把尺子的键，且逐个反查得到同一个标准对象
  return names.length === 2 && names.every((n) => back.get(n)) &&
    back.get(names[0]) === RT[0] && back.get(names[1]) === RT[1] &&
    names[0] !== RT[0].label && names[1] !== RT[1].label   // 确实被改写过，否则这条测试是空转
})())
ok('导出的表名已是最终名：主进程再过一遍 safeSheetName 不再变（不会二次改写）',
  modcodSheets(RT).every((s) => sheetNameMain(s.name) === s.name))

try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }) } catch { /* 清不掉无妨 */ }
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
