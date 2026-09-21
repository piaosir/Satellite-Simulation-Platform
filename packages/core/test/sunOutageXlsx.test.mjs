// 日凌预报 → Excel（运行版《日凌时间表》版式）自测：electron/services/report.js buildSunOutageExcel。
// 与 visAccessXlsx 同法【真建一次工作簿再读回来逐格断言】——这条管线过 IPC，模型对而工作簿写不出
// （合并区打架 / numFmt 非法 / 富文本切分崩）在界面上只剩「导出失败」四个字。运行：npm test
//
// ★ 本文件的数字全部写死用户给的运行原件《CH12_C_全球_1.8m.xls》逐格量出来的口径，不读那份文件：
//   一季一张 sheet；R1 页首标题 A1:I1 合并 华文楷体 24 磅粗 行高 34.5；R2 副标题 16 磅粗 行高 22.5；
//   R3 表头 12 磅粗 行高 16.5；R4+ 数据 等线 11 磅 行高 14，站信息列 A–E 按站纵向合并；
//   全表每格四边细实线、无底纹、不冻结、不筛选；九列，列宽 8.45×4 / 10 / 12 / 9 / 9 / 10；
//   日期真日期值、开始/结束是带秒的时间序列值（hh:mm 只显示到分）、持续时间是 round(真实秒/60) 的整数分。
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs')
const { buildSunOutageExcel } = require('../../../electron/services/report.js')
const { calculateSunOutageSeasons } = require('../utils/sunOutageCalculator.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const rt = (v) => (v && v.richText ? v.richText.map((t) => t.text).join('') : (v == null ? '' : String(v)))

// ---- 样例：真引擎（定轨档、2026、两站两季）----
const SAT_LON = 130.5
const SEASONS = ['vernal', 'autumnal']
const STATIONS = [
  { name: '北京', lat: 39.9042, lon: 116.4074, band: 'Ku', freq: 12.5, diameter: 2.4, sysTemp: 150 },
  { name: '乌鲁木齐', lat: 43.8256, lon: 87.6168, band: 'C', freq: 3.95, diameter: 4.5, sysTemp: 65 }
]
const stations = STATIONS.map((st) => {
  const r = calculateSunOutageSeasons({
    lat: st.lat, lon: st.lon, satLon: SAT_LON, diameter: st.diameter,
    band: st.band, customFreq: st.freq, sysTemp: st.sysTemp,
    year: 2026, degThreshold: 1, seasons: SEASONS
  })
  const any = r.vernal || r.autumnal
  const out = Object.assign({}, st, {
    satAz: any.satAz, satEl: any.satEl, beamWidth: any.beamWidth, thresholdAngle: any.thresholdAngle
  })
  for (const s of SEASONS) {
    const q = r[s]
    out[s] = {
      days: q.totalDays,
      maxMin: Math.round(q.maxDurationSec / 6) / 10,
      equinoxDate: q.equinoxDate,
      rows: q.dailyResults.map((d) => {
        const sec = (x) => { const [h, m, s2] = x.split(':').map(Number); return h * 3600 + m * 60 + s2 }
        return {
          date: d.date,
          startSec: sec(d.startTimeUTC), peakSec: sec(d.peakTimeUTC), endSec: sec(d.endTimeUTC),
          durSec: d.durationSec, durMin: Math.round(d.durationSec / 6) / 10,
          peakDb: d.peakCNdeg, sep: d.peakSeparation, isPeak: !!d.isPeak
        }
      })
    }
  }
  return out
})
const payload = {
  defaultName: '日凌预报_CHINASAT 6C_2026.xlsx',
  sat: { name: 'ZHONGXING-6C', slotText: '130.5°E', slotLon: SAT_LON, source: 'slot', noradId: null },
  year: 2026, seasons: SEASONS, tzLabel: 'UTC+8',
  criterion: { mode: 'degradation', degDb: '1' },
  stations
}
const daysOf = (s) => stations.reduce((a, st) => a + st[s].rows.length, 0)
const nEvents = SEASONS.reduce((a, s) => a + daysOf(s), 0)

// ---- IPC 纯数据 ----
{
  let cloneOk = true
  try { structuredClone(payload) } catch { cloneOk = false }
  ok('payload 过 structuredClone', cloneOk)
}
ok('样例两季都有事件可写', daysOf('vernal') > 0 && daysOf('autumnal') > 0, `${daysOf('vernal')} + ${daysOf('autumnal')} 天`)

const buf = await buildSunOutageExcel(payload)
const wb = new ExcelJS.Workbook()
await wb.xlsx.load(buf)

// ---- ① 一季一张 sheet ----
const names = wb.worksheets.map((w) => w.name)
ok('① 两季两张 sheet', wb.worksheets.length === 2, names.join(' / '))
ok('① sheet 名 = {年}年{春季|秋季}', names[0] === '2026年春季' && names[1] === '2026年秋季', names.join(' / '))

const NCOL = 9
const wsV = wb.getWorksheet('2026年春季')
const wsA = wb.getWorksheet('2026年秋季')

for (const [ws, season, cn] of [[wsV, 'vernal', '春季'], [wsA, 'autumnal', '秋季']]) {
  const nDay = daysOf(season)
  const LAST = 3 + nDay

  // ---- ② 页首标题：A1:I1 合并、华文楷体 24 磅粗、居中、行高 34.5 ----
  const t = ws.getCell(1, 1)
  ok(`② ${cn} 标题文字`, rt(t.value) === `ZHONGXING-6C  2026年${cn}日凌时间表`, rt(t.value))
  ok(`② ${cn} 标题 A1:I1 合并`, (ws.model.merges || []).map(String).includes('A1:I1'))
  ok(`② ${cn} 标题 华文楷体 24 磅粗`, t.font && t.font.name === '华文楷体' && t.font.size === 24 && t.font.bold === true, JSON.stringify(t.font))
  ok(`② ${cn} 标题居中`, t.alignment && t.alignment.horizontal === 'center' && t.alignment.vertical === 'middle')
  ok(`② ${cn} 标题行高 34.5`, ws.getRow(1).height === 34.5, String(ws.getRow(1).height))

  // ---- ③ 副标题：A2:I2 合并、16 磅粗、行高 22.5、「卫星名称:… 东经…度」----
  const st = ws.getCell(2, 1)
  ok(`③ ${cn} 副标题文字`, rt(st.value) === '卫星名称:ZHONGXING-6C    东经130.5度', rt(st.value))
  ok(`③ ${cn} 副标题 A2:I2 合并`, (ws.model.merges || []).map(String).includes('A2:I2'))
  ok(`③ ${cn} 副标题 16 磅粗`, st.font && st.font.size === 16 && st.font.bold === true && st.font.name === '华文楷体')
  ok(`③ ${cn} 副标题行高 22.5`, ws.getRow(2).height === 22.5, String(ws.getRow(2).height))

  // ---- ④ 表头：九列、12 磅粗、行高 16.5 ----
  const head = []
  for (let c = 1; c <= NCOL; c++) head.push(rt(ws.getCell(3, c).value))
  ok(`④ ${cn} 表头逐列`, head.join('|') === '序号|地点|经度|纬度|天线尺寸（米）|日期|开始时间|结束时间|持续时间（分）', head.join('|'))
  ok(`④ ${cn} 表头 12 磅粗`, [1, 5, 9].every((c) => { const f = ws.getCell(3, c).font; return f && f.size === 12 && f.bold === true && f.name === '华文楷体' }))
  ok(`④ ${cn} 表头行高 16.5`, ws.getRow(3).height === 16.5, String(ws.getRow(3).height))
  ok(`④ ${cn} 恰九列`, ws.actualColumnCount === NCOL, String(ws.actualColumnCount))

  // ---- ⑤ 行数 = 3 + Σ该季事件天数；数据行 等线 11 磅、行高 14 ----
  ok(`⑤ ${cn} 行数 = 标题 2 + 表头 1 + 事件 ${nDay}`, ws.actualRowCount === LAST, `${ws.actualRowCount} vs ${LAST}`)
  let bodyOk = true, hOk = true
  for (let r = 4; r <= LAST; r++) {
    if (ws.getRow(r).height !== 14) hOk = false
    const f = ws.getCell(r, 6).font
    if (!(f && f.name === '等线' && f.size === 11 && !f.bold)) bodyOk = false
  }
  ok(`⑤ ${cn} 数据行 等线 11 磅不加粗`, bodyOk)
  ok(`⑤ ${cn} 数据行高 14`, hOk)
  // ★ 行高能不能落到 Excel 里，取决于 <sheetViews> 这个元素在不在（见 report.js 那处注释）。
  //   exceljs 读回来看不出差别，只有真用 Excel 打开才发现整表被缩成 2/3，故这里把它钉死。
  ok(`⑤ ${cn} 写了 sheetViews（不写的话 Excel 会把行高缩成 2/3）`, Array.isArray(ws.views) && ws.views.length > 0, JSON.stringify(ws.views))

  // ---- ⑥ 站信息列 A–E 按站纵向合并（一站一块）----
  const merges = (ws.model.merges || []).map(String)
  let top = 4, blockOk = true, mergeOk = true, noOk = true, idx = 0
  for (const s of stations) {
    const n = s[season].rows.length
    if (!n) continue
    idx++
    if (n > 1) {
      for (const col of ['A', 'B', 'C', 'D', 'E']) {
        if (!merges.includes(`${col}${top}:${col}${top + n - 1}`)) { mergeOk = false; blockOk = false }
      }
    }
    if (ws.getCell(top, 1).value !== idx) noOk = false
    if (rt(ws.getCell(top, 2).value) !== s.name) blockOk = false
    top += n
  }
  ok(`⑥ ${cn} 站信息列 A–E 按站纵向合并`, mergeOk)
  ok(`⑥ ${cn} 每块首行是该站的序号 / 站名`, blockOk && noOk)
  ok(`⑥ ${cn} 块高之和 = 事件天数`, top - 4 === nDay, `${top - 4} vs ${nDay}`)

  // ---- ⑦ 全表每格四边细实线、无底纹 ----
  let borderBad = '', fillBad = ''
  for (let r = 1; r <= LAST; r++) {
    for (let c = 1; c <= NCOL; c++) {
      const cell = ws.getCell(r, c)
      const b = cell.border || {}
      for (const side of ['top', 'left', 'bottom', 'right']) {
        if (!(b[side] && b[side].style === 'thin')) borderBad ||= `R${r}C${c}.${side}`
      }
      const fl = cell.fill
      if (fl && fl.type && fl.pattern !== 'none') fillBad ||= `R${r}C${c}`
    }
  }
  ok(`⑦ ${cn} 全表四边细实线`, !borderBad, borderBad)
  ok(`⑦ ${cn} 无底纹`, !fillBad, fillBad)

  // ---- ⑧ 末行之后一个字都没有（无表注、无空行尾巴）----
  let after = ''
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= LAST) return
    row.eachCell({ includeEmpty: false }, (cell, cn2) => { if (rt(cell.value) !== '') after ||= `R${rn}C${cn2}` })
  })
  ok(`⑧ ${cn} 末行之后一个字都没有`, !after, after)

  // ---- ⑨ 不冻结、无筛选、列宽照原件 ----
  const v = (ws.views && ws.views[0]) || {}
  ok(`⑨ ${cn} 不冻结`, v.state !== 'frozen', String(v.state))
  ok(`⑨ ${cn} 无筛选器`, !ws.autoFilter)
  const W = [8.45, 8.45, 8.45, 10, 12, 9, 9, 10]   // 第 2 列（地点）允许只增不减，单列
  // ★ exceljs 把宽度 9 当成自己的默认列宽：等于 9 的列它【不写 <col>】，读回来是 undefined。
  //   而 Excel 自己的默认列宽是 8.43 —— 不补一句 defaultColWidth，原件里宽 9 的「开始时间 /
  //   结束时间」两列打开后就按 8.43 渲染，与原件差 0.57 字符。故写出 <sheetFormatPr
  //   defaultColWidth="9">，读回来是 ws.properties.defaultColWidth，下面单独断言。
  const gotW = [1, 3, 4, 5, 6, 7, 8, 9].map((c) => { const w = ws.getColumn(c).width; return w == null ? 9 : w })
  ok(`⑨ ${cn} 列宽照原件（地点列除外）`, gotW.join(',') === W.join(','), gotW.join(','))
  ok(`⑨ ${cn} defaultColWidth = 9（宽度 9 的列不写 <col>，靠它渲染成 9 而不是 8.43）`,
    ws.properties.defaultColWidth === 9, String(ws.properties.defaultColWidth))
  ok(`⑨ ${cn} 地点列只增不减`, ws.getColumn(2).width >= 8.45, String(ws.getColumn(2).width))
}

// ---- ⑩ 值的口径：日期真日期值、时刻带秒且 hh:mm、持续时间是 round(真实秒/60) ----
// ★ exceljs 读回时会把「带日期/时间格式的序列值」还原成 Date，故断言换算回序列值再比。
const XL_EPOCH = Date.UTC(1899, 11, 30)
const serialOf = (v) => (v instanceof Date ? (v.getTime() - XL_EPOCH) / 86400000 : v)
{
  const first = stations.find((s) => s.vernal.rows.length).vernal.rows[0]
  const d = wsV.getCell(4, 6), s1 = wsV.getCell(4, 7), e1 = wsV.getCell(4, 8), du = wsV.getCell(4, 9)
  ok('⑩ 日期是真日期值且 yyyy-mm-dd', d.value instanceof Date && d.numFmt === 'yyyy-mm-dd', String(d.numFmt))
  ok('⑩ 日期回读 = payload', new Date(XL_EPOCH + serialOf(d.value) * 86400000).toISOString().slice(0, 10) === first.date)
  ok('⑩ 开始 / 结束 numFmt = hh:mm', s1.numFmt === 'hh:mm' && e1.numFmt === 'hh:mm')
  ok('⑩ 时刻是 0~1 的时间序列值（不带日期部分）', [s1, e1].every((c) => { const x = serialOf(c.value); return x >= 0 && x < 1 }))
  ok('⑩ ★ 时刻保留了秒（不是取整到分）', Math.round(serialOf(s1.value) * 86400) === first.startSec, `${Math.round(serialOf(s1.value) * 86400)} vs ${first.startSec}`)
  ok('⑩ 持续时间 = round(真实秒/60) 的整数', du.value === Math.round(first.durSec / 60) && Number.isInteger(du.value), `${du.value} vs ${Math.round(first.durSec / 60)}`)
  // ★ 原件那条口径：持续时间取真实时长，不是两个显示时刻相减 —— 举例证明两者确实会差 1 分钟
  const diffCase = stations.flatMap((s) => s.vernal.rows).find((r) => {
    const shown = Math.floor(r.endSec / 60) - Math.floor(r.startSec / 60)
    return shown !== Math.round(r.durSec / 60)
  })
  ok('⑩ 存在「显示相减 ≠ 真实时长取整」的天（证明这条口径不是空话）', !!diffCase,
    diffCase ? `${diffCase.date}: 显示相减 ${Math.floor(diffCase.endSec / 60) - Math.floor(diffCase.startSec / 60)} vs 真实 ${Math.round(diffCase.durSec / 60)}` : '本样例里恰好没有')
  ok('⑩ 经纬度 numFmt 0.00', wsV.getCell(4, 3).numFmt === '0.00' && wsV.getCell(4, 4).numFmt === '0.00')
  // ★ 列序按表头来：第 3 列是【经度】、第 4 列是【纬度】（写反过一次，是开 Excel 并排看才发现的）
  ok('⑩ 第 3 列是经度、第 4 列是纬度', wsV.getCell(4, 3).value === stations[0].lon && wsV.getCell(4, 4).value === stations[0].lat, `${wsV.getCell(4, 3).value} / ${wsV.getCell(4, 4).value}`)
  ok('⑩ 经纬度写的是原值（不是四舍五入后的数）', wsV.getCell(4, 3).value === 116.4074, String(wsV.getCell(4, 3).value))
}

// ---- ⑪ 单季：只出一张 sheet ----
{
  const wb2 = new ExcelJS.Workbook()
  await wb2.xlsx.load(await buildSunOutageExcel({ ...payload, seasons: ['autumnal'] }))
  ok('⑪ 单季只出一张 sheet', wb2.worksheets.length === 1 && wb2.worksheets[0].name === '2026年秋季', wb2.worksheets.map((w) => w.name).join('/'))
  ok('⑪ 单季标题写「秋季」', /2026年秋季日凌时间表$/.test(rt(wb2.worksheets[0].getCell(1, 1).value)))
}

// ---- ⑫ 该季无事件的站不出块；全无事件时只剩三行 ----
{
  const half = { ...payload, stations: [stations[0], { ...stations[1], vernal: { days: 0, maxMin: 0, rows: [] } }] }
  const wb3 = new ExcelJS.Workbook()
  await wb3.xlsx.load(await buildSunOutageExcel(half))
  const w = wb3.getWorksheet('2026年春季')
  ok('⑫ 该季无事件的站不出块', w.actualRowCount === 3 + stations[0].vernal.rows.length, String(w.actualRowCount))
  ok('⑫ 序号从 1 起连号', w.getCell(4, 1).value === 1)

  const none = { ...payload, stations: stations.map((s) => ({ ...s, vernal: { days: 0, maxMin: 0, rows: [] }, autumnal: { days: 0, maxMin: 0, rows: [] } })) }
  const wb4 = new ExcelJS.Workbook()
  await wb4.xlsx.load(await buildSunOutageExcel(none))
  ok('⑫ 全无事件：只剩标题两行 + 表头', wb4.getWorksheet('2026年春季').actualRowCount === 3)
}

// ---- ⑬ 西经的副标题写法 ----
{
  const wb5 = new ExcelJS.Workbook()
  await wb5.xlsx.load(await buildSunOutageExcel({ ...payload, seasons: ['vernal'], sat: { ...payload.sat, slotLon: -61.5 } }))
  ok('⑬ 西经写「西经61.5度」', /西经61\.5度$/.test(rt(wb5.worksheets[0].getCell(2, 1).value)), rt(wb5.worksheets[0].getCell(2, 1).value))
}

// ---- 同一份 payload 的另外两个出口：Word（多站多季）与 ICS（多站一份日历）----
// ★ 两处都不许再出现「强度 高/中/低」（文字判定，见仓库根 CLAUDE.md）。
{
  const { buildSunOutageWord, sunOutageIcsEvents } = require('../../../electron/services/report.js')
  const { buildIcs } = require('../utils/icsBuilder.js')
  // Word 的逐日行吃显示串，补上（Excel 吃的是秒，两者同一份 payload）
  const wp = JSON.parse(JSON.stringify(payload))
  const hms = (s) => [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':')
  for (const st of wp.stations) {
    for (const s of SEASONS) {
      if (!st[s]) continue
      for (const d of st[s].rows) {
        d.dateUTC = d.date; d.dateDisp = d.date
        d.startDisp = hms(d.startSec); d.peakDisp = hms(d.peakSec); d.endDisp = hms(d.endSec)
        d.startUtc = d.startDisp; d.peakUtc = d.peakDisp; d.endUtc = d.endDisp
        d.durStr = d.durMin + 'm'
      }
    }
  }
  const bufW = await buildSunOutageWord(wp)
  ok('Word 出得来', bufW && bufW.length > 4000, (bufW && bufW.length) + ' bytes')

  const ev = sunOutageIcsEvents(wp)
  ok('ICS 事件数 = Σ 事件天数（多站多季一份日历）', ev.length === nEvents, `${ev.length} vs ${nEvents}`)
  ok('ICS UID 两两不同（重导覆盖而非重复）', new Set(ev.map((e) => e.uid)).size === ev.length)
  ok('ICS UID 含 星-站-日期', /^so-.+-\d+\.\d{4}-\d+\.\d{4}-\d{4}-\d{2}-\d{2}@satsim-platform$/.test(ev[0].uid), ev[0].uid)
  ok('ICS 描述里没有「强度」', !ev.some((e) => /强度/.test(e.description)))
  ok('ICS 摘要 / 描述里没有文字判定', !ev.some((e) => /强度|达标|受限|合格/.test(e.summary + e.description)))
  ok('ICS 本地时刻用 payload 的 tzLabel', ev.every((e) => e.description.includes('(' + wp.tzLabel + ')')))
  ok('ICS 两条提醒不变', ev.every((e) => e.alarms.length === 2 && e.alarms[0].minutesBefore === 1440 && e.alarms[1].minutesBefore === 30))
  ok('ICS 覆盖到了每个站', new Set(ev.map((e) => e.location)).size === wp.stations.filter((s) => SEASONS.some((x) => s[x] && s[x].rows.length)).length)
  const text = buildIcs({ name: 'T', events: ev })
  ok('ICS 文本可生成且含 VEVENT', /BEGIN:VEVENT/.test(text) && text.split('BEGIN:VEVENT').length - 1 === ev.length)
  ok('ICS 文本里没有「强度」', !/强度/.test(text))
  ok('无事件时事件数为 0', sunOutageIcsEvents({ ...wp, stations: [] }).length === 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
