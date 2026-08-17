// 时段过境 → Excel（《三线表模板_TimesNewRoman_11pt》版式）自测：electron/services/report.js buildVisAccessExcel。
// 与 fpXlsx 同法【真建一次工作簿再读回来】——这条管线过 IPC，模型对而工作簿写不出（合并区打架 /
// numFmt 非法 / 富文本切分崩）在界面上只剩「导出失败」四个字。运行：npm test
//
// 关键不变式：
//   ① payload 过 structuredClone 不抛（IPC 纯数据约定，见 ipc-no-reactive-proxy）；
//   ② 三线：表头上沿 medium、表头下 thin、末行下沿 medium；两级表头的组头下有辅助线（thin）；
//   ③ 双时区：本地列 − UTC 列 ≡ tzOffsetMin（xlsx 日期无时区，本地墙钟靠平移伪装，差值必须严格相等）；
//   ④ 时刻是【真日期值】、时长/仰角是【真数值】（还能排序求和才叫数据表）；
//   ⑤ 中西混排格写盘后拆成富文本（宋体 + Times New Roman 两种 run）；
//   ⑥ 表号全簿连号（摘要=表 1、明细=表 2、汇总=表 3）；
//   ⑦ 引擎 accessWindows 的 peakMs 与相对分钟同轴（peakMs = base + peakMin·60000）。
import { createRequire } from 'node:module'
import sat from '../../../src/viz/constellation/satellite.js'
import { accessWindows } from '../../../src/viz/vis/visibility.js'

const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs')
const { buildVisAccessExcel } = require('../../../electron/services/report.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const rt = (v) => (v && v.richText ? v.richText.map((t) => t.text).join('') : (v == null ? '' : String(v)))

// ---- 样例：北京站 24h 时窗，两颗星三窗（含跨日截断窗），本地=UTC+8 ----
const base = Date.UTC(2026, 7, 17, 14, 38, 5)
const payload = {
  defaultName: '过境窗口_北京站',
  target: { name: '北京站', kind: 'station', lat: 39.9042, lon: 116.4074 },
  satSet: '星座 · TIANQI', scanned: 30, minElevDeg: 5,
  baseMs: base, horizonMin: 1440, tzOffsetMin: 480, tzTag: 'UTC+8',
  kpi: { pct: 48.21, coveredMin: 694.2, maxGapMin: 39.4, gapCount: 41, sats: 2, passes: 3 },
  sats: [
    { name: 'TIANQI-17', noradId: '44718', slot: '', windows: [
      { startMin: 136.2, endMin: 143.4, durMin: 7.2, peakMin: 139.9, peakEl: 24.3, truncated: false },
      { startMin: 802.5, endMin: 812.6, durMin: 10.1, peakMin: 807.4, peakEl: 77.2, truncated: false }
    ] },
    { name: 'TIANQI-23', noradId: '46838', slot: '', windows: [
      { startMin: 1432.0, endMin: 1440, durMin: 8.0, peakMin: 1437.1, peakEl: 39.0, truncated: true }
    ] }
  ]
}

// ---- ① IPC 纯数据 ----
{
  let cloneOk = true
  try { structuredClone(payload) } catch { cloneOk = false }
  ok('payload 过 structuredClone', cloneOk)
}

const buf = await buildVisAccessExcel(payload)
const wb = new ExcelJS.Workbook()
await wb.xlsx.load(buf)

// ---- 三张工作表 ----
ok('工作表：摘要/过境明细/逐星汇总', wb.worksheets.map((w) => w.name).join('/') === '摘要/过境明细/逐星汇总', wb.worksheets.map((w) => w.name).join('/'))

// ---- 摘要 ----
{
  const ws = wb.getWorksheet('摘要')
  ok('摘要隐藏网格线', ws.views[0].showGridLines === false)
  ok('摘要表题（表 1）', rt(ws.getCell(3, 1).value) === '表 1  过境分析摘要', rt(ws.getCell(3, 1).value))
  ok('摘要表头顶线 medium', ws.getCell(4, 1).border.top && ws.getCell(4, 1).border.top.style === 'medium')
  let utcRow = 0, locRow = 0
  ws.eachRow((row, rn) => {
    const t = rt(row.getCell(1).value)
    if (t === '时窗起点 (UTC)') utcRow = rn
    if (t === '时窗起点 (UTC+8)') locRow = rn
  })
  ok('UTC 与本地两行时窗起点都在', utcRow > 0 && locRow > 0, utcRow + ',' + locRow)
  const dU = ws.getCell(utcRow, 2).value, dL = ws.getCell(locRow, 2).value
  ok('时窗起点是真日期值', dU instanceof Date && dL instanceof Date)
  ok('本地 − UTC ≡ +480min', dL.getTime() - dU.getTime() === 480 * 60000, (dL - dU) / 60000 + 'min')
  ok('UTC 起点墙钟 14:38:05', dU.getUTCHours() === 14 && dU.getUTCMinutes() === 38 && dU.getUTCSeconds() === 5, dU.toISOString())
  ok('日期格式 yyyy-mm-dd hh:mm:ss', ws.getCell(utcRow, 2).numFmt === 'yyyy-mm-dd hh:mm:ss', ws.getCell(utcRow, 2).numFmt)
}

// ---- 过境明细（两级表头 · 含辅助线）----
{
  const ws = wb.getWorksheet('过境明细')
  ok('明细横版 + 冻结 3 行', ws.pageSetup.orientation === 'landscape' && ws.views[0].ySplit === 3)
  ok('明细表题（表 2 连号 + 目标名）', rt(ws.getCell(1, 1).value) === '表 2  北京站 过境窗口明细', rt(ws.getCell(1, 1).value))
  ok('明细 12 列（无轨位 + 有备注）', ws.columnCount === 12, ws.columnCount)
  ok('UTC 组头 / 本地组头', rt(ws.getCell(2, 4).value) === 'UTC' && rt(ws.getCell(2, 7).value) === '本地时间 (UTC+8)', rt(ws.getCell(2, 7).value))
  ok('tier2 三列名', rt(ws.getCell(3, 4).value) === '开始时间' && rt(ws.getCell(3, 5).value) === '结束时间' && rt(ws.getCell(3, 6).value) === '峰值时刻')
  ok('表头顶线 medium', ws.getCell(2, 1).border.top && ws.getCell(2, 1).border.top.style === 'medium')
  ok('组头下辅助线 thin', ws.getCell(2, 4).border.bottom && ws.getCell(2, 4).border.bottom.style === 'thin')
  ok('tier2 下栏目线 thin', ws.getCell(3, 5).border.bottom && ws.getCell(3, 5).border.bottom.style === 'thin')
  ok('行序按 AOS 混排（首行 44718）', rt(ws.getCell(4, 3).value) === '44718', rt(ws.getCell(4, 3).value))
  const aosU = ws.getCell(4, 4).value, aosL = ws.getCell(4, 7).value
  ok('首行 AOS(UTC) 真日期 16:54', aosU instanceof Date && aosU.getUTCHours() === 16 && aosU.getUTCMinutes() === 54, aosU && aosU.toISOString())
  ok('首行 本地 − UTC ≡ +480min', aosL instanceof Date && aosL.getTime() - aosU.getTime() === 480 * 60000)
  ok('时长/仰角真数值 + 0.0 格式', typeof ws.getCell(4, 10).value === 'number' && ws.getCell(4, 10).numFmt === '0.0' && typeof ws.getCell(4, 11).value === 'number')
  ok('截断窗备注', rt(ws.getCell(6, 12).value) === '截至时窗末', rt(ws.getCell(6, 12).value))
  ok('末行底线 medium', ws.getCell(6, 1).border.bottom && ws.getCell(6, 1).border.bottom.style === 'medium')
  const note = ws.getCell(7, 1).value
  ok('表注以「注：」起首', rt(note).startsWith('注：'), rt(note).slice(0, 10))
  const fonts = note && note.richText ? new Set(note.richText.map((t) => t.font && t.font.name)) : new Set()
  ok('富文本中西分家（宋体 + TNR）', fonts.has('宋体') && fonts.has('Times New Roman'), [...fonts].join(','))
}

// ---- 逐星汇总 ----
{
  const ws = wb.getWorksheet('逐星汇总')
  ok('汇总表题连号（表 3）', rt(ws.getCell(1, 1).value) === '表 3  逐星过境汇总', rt(ws.getCell(1, 1).value))
  ok('汇总过境次数 = 2', ws.getCell(3, 4).value === 2, ws.getCell(3, 4).value)
  ok('汇总合计可视 = 17.3', Math.abs(ws.getCell(3, 5).value - 17.3) < 1e-9, ws.getCell(3, 5).value)
  const fa = ws.getCell(3, 8).value
  ok('汇总首次 AOS 真日期（UTC 16 时）', fa instanceof Date && fa.getUTCHours() === 16, fa && fa.toISOString())
  ok('汇总末行底线 medium', ws.getCell(4, 1).border.bottom && ws.getCell(4, 1).border.bottom.style === 'medium')
}

// ---- ⑦ 引擎 peakMs 与相对轴同源（真传播：ISS 对北京 24h）----
{
  const rec = sat.twoline2satrec(
    '1 25544U 98067A   26047.50000000  .00016717  00000-0  30264-3 0  9990',
    '2 25544  51.6400 208.9163 0006703  69.9862  25.2906 15.50377579 32519'
  )
  const now = new Date(Date.UTC(2026, 1, 16, 12, 0, 0))   // 与历元同期，传播误差不影响「同轴」断言
  const out = accessWindows([{ rec, name: 'ISS', noradId: 25544, group: 't' }], [{ lat: 39.9042, lon: 116.4074 }], { now, ccNow: now }, 24 * 3600, 5, { coarseSec: 60 })
  const wins = out.length ? out[0].windows : []
  ok('ISS 24h 有过境窗', wins.length > 0, wins.length + ' 窗')
  const coherent = wins.every((w) => Number.isFinite(w.peakMs)
    && Math.abs(w.peakMs - (now.getTime() + w.peakMin * 60000)) < 1
    && Math.abs(w.startMs - (now.getTime() + w.startMin * 60000)) < 1
    && w.startMs <= w.peakMs && w.peakMs <= w.endMs)
  ok('peakMs/startMs 与相对分钟同轴且 AOS≤峰值≤LOS', coherent)
}

console.log(`\n${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
