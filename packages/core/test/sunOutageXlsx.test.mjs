// 日凌预报 → Excel（《三线表模板_TimesNewRoman_11pt》版式）自测：electron/services/report.js buildSunOutageExcel。
// 与 visAccessXlsx 同法【真建一次工作簿再读回来逐格断言】——这条管线过 IPC，模型对而工作簿写不出
// （合并区打架 / numFmt 非法 / 富文本切分崩）在界面上只剩「导出失败」四个字。运行：npm test
//
// ★ 本文件的数字全部写死《三线表模板》的口径（任务书附录 A），不读桌面上的模板文件：
//   行高 25.5 / 21.75 / 19.5；顶线 medium、栏目线 thin、底线 medium；无竖线、无底纹、无外框；
//   表题「表 N  标题」在表上方合并居中加粗 11 磅；首列左对齐缩进 1、其余居中。
//   ★ 与模板一模一样 = 整本只有两张表、各自从 A1 起、末行之后一个字都没有
//     （无页首标题、无空行、无表注、无筛选器、不冻结）。
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
  { name: '喀什', lat: 39.4704, lon: 75.9898, band: 'C', freq: 3.95, diameter: 4.5, sysTemp: 65 }
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
      rows: q.dailyResults.map((d) => {
        const [h, m, x] = d.startTimeUTC.split(':').map(Number)
        const [h2, m2, x2] = d.peakTimeUTC.split(':').map(Number)
        const [h3, m3, x3] = d.endTimeUTC.split(':').map(Number)
        return {
          date: d.date,
          startSec: h * 3600 + m * 60 + x, peakSec: h2 * 3600 + m2 * 60 + x2, endSec: h3 * 3600 + m3 * 60 + x3,
          durMin: Math.round(d.durationSec / 6) / 10, peakDb: d.peakCNdeg, sep: d.peakSeparation
        }
      })
    }
  }
  return out
})
const payload = {
  defaultName: '日凌预报_CHINASAT 6C_2026.xlsx',
  sat: { name: 'ZHONGXING-6C', slotText: '130.5°E', source: 'slot', noradId: null },
  year: 2026, seasons: SEASONS, tzLabel: 'UTC+8',
  criterion: { mode: 'degradation', degDb: '1' },
  stations
}
const nEvents = stations.reduce((a, st) => a + SEASONS.reduce((b, s) => b + st[s].rows.length, 0), 0)

// ---- IPC 纯数据 ----
{
  let cloneOk = true
  try { structuredClone(payload) } catch { cloneOk = false }
  ok('payload 过 structuredClone', cloneOk)
}
ok('样例有事件可写', nEvents > 0, nEvents + ' 条')

const buf = await buildSunOutageExcel(payload)
const wb = new ExcelJS.Workbook()
await wb.xlsx.load(buf)

// ---- ① 恰两张表、名字对 ----
const names = wb.worksheets.map((w) => w.name)
ok('① 整本恰两张表', wb.worksheets.length === 2, names.join(' / '))
ok('① 表名：地球站 / 日凌窗口', names[0] === '地球站' && names[1] === '日凌窗口')

const NCOL1 = 11 + SEASONS.length * 2      // 固定 11 列 + 每季 2 列
const NCOL2 = 9
const ws1 = wb.getWorksheet('地球站')
const ws2 = wb.getWorksheet('日凌窗口')

// ---- ② 表题：A1 合并跨全部列、「表 N  」、加粗 11 磅居中、行高 25.5 ----
for (const [ws, no, ncol] of [[ws1, 1, NCOL1], [ws2, 2, NCOL2]]) {
  const c = ws.getCell(1, 1)
  const txt = rt(c.value)
  ok(`② 表 ${no} 表题从 A1 起且以「表 ${no}  」开头`, new RegExp(`^表 ${no}  \\S`).test(txt), txt.slice(0, 40))
  const mr = (ws.model.merges || []).map(String)
  const want = `A1:${ws.getColumn(ncol).letter}1`
  ok(`② 表 ${no} 表题合并跨全部 ${ncol} 列`, mr.includes(want), mr.join(',') || '（无合并）')
  const fonts = c.value && c.value.richText ? c.value.richText.map((t) => t.font) : [c.font]
  ok(`② 表 ${no} 表题加粗 11 磅`, fonts.every((f) => f && f.bold === true && f.size === 11))
  ok(`② 表 ${no} 表题居中`, c.alignment && c.alignment.horizontal === 'center' && c.alignment.vertical === 'middle')
  ok(`② 表 ${no} 表题行高 25.5`, ws.getRow(1).height === 25.5, String(ws.getRow(1).height))
}

// ---- ③ 表头行：top medium / bottom thin、行高 21.75、首格左对齐 indent 1、其余居中 ----
for (const [ws, no, ncol] of [[ws1, 1, NCOL1], [ws2, 2, NCOL2]]) {
  let bordersOk = true
  for (let c = 1; c <= ncol; c++) {
    const b = ws.getCell(2, c).border || {}
    if (!(b.top && b.top.style === 'medium' && b.bottom && b.bottom.style === 'thin' && !b.left && !b.right)) bordersOk = false
  }
  ok(`③ 表 ${no} 表头 顶线 medium + 栏目线 thin、无竖线`, bordersOk)
  ok(`③ 表 ${no} 表头行高 21.75`, ws.getRow(2).height === 21.75, String(ws.getRow(2).height))
  const a0 = ws.getCell(2, 1).alignment || {}
  ok(`③ 表 ${no} 表头首格左对齐缩进 1`, a0.horizontal === 'left' && a0.indent === 1)
  let restOk = true
  for (let c = 2; c <= ncol; c++) { const a = ws.getCell(2, c).alignment || {}; if (a.horizontal !== 'center') restOk = false }
  ok(`③ 表 ${no} 表头其余列居中`, restOk)
}

// ---- ⑨ 表 1 行数 = 站数；表 2 行数 = Σ 事件天数 ----
const LAST1 = 2 + stations.length
const LAST2 = 2 + nEvents
ok('⑨ 表 1 数据行数 = 站数', ws1.actualRowCount === LAST1, `${ws1.actualRowCount} vs ${LAST1}`)
ok('⑨ 表 2 数据行数 = Σ 事件天数', ws2.actualRowCount === LAST2, `${ws2.actualRowCount} vs ${LAST2}`)

// ---- ④ 末行底线 medium；数据行高 19.5 ----
for (const [ws, no, ncol, last] of [[ws1, 1, NCOL1, LAST1], [ws2, 2, NCOL2, LAST2]]) {
  let botOk = true
  for (let c = 1; c <= ncol; c++) { const b = ws.getCell(last, c).border || {}; if (!(b.bottom && b.bottom.style === 'medium')) botOk = false }
  ok(`④ 表 ${no} 末行底线 medium`, botOk)
  let hOk = true
  for (let r = 3; r <= last; r++) if (ws.getRow(r).height !== 19.5) hOk = false
  ok(`④ 表 ${no} 数据行高 19.5`, hOk)
}

// ---- ⑤ 除表头两条线与末行底线外，任何格没有 border、没有 fill ----
for (const [ws, no, ncol, last] of [[ws1, 1, NCOL1, LAST1], [ws2, 2, NCOL2, LAST2]]) {
  let strayBorder = '', strayFill = ''
  ws.eachRow({ includeEmpty: true }, (row, rn) => {
    row.eachCell({ includeEmpty: true }, (cell, cn) => {
      const b = cell.border || {}
      const allowTop = rn === 2, allowBottom = rn === 2 || rn === last
      if (b.left || b.right) strayBorder ||= `R${rn}C${cn} 竖线`
      if (b.top && !allowTop) strayBorder ||= `R${rn}C${cn} 顶线`
      if (b.bottom && !allowBottom) strayBorder ||= `R${rn}C${cn} 底线`
      const fl = cell.fill
      if (fl && fl.type && fl.pattern !== 'none') strayFill ||= `R${rn}C${cn} ${fl.pattern}`
    })
  })
  ok(`⑤ 表 ${no} 无多余边框`, !strayBorder, strayBorder)
  ok(`⑤ 表 ${no} 无底纹`, !strayFill, strayFill)
  // 数据行内部不许有横线（三线表：表体内一条线都没有）
  let innerRule = ''
  for (let r = 3; r < last; r++) for (let c = 1; c <= ncol; c++) { const b = ws.getCell(r, c).border || {}; if (b.bottom) innerRule ||= `R${r}C${c}` }
  ok(`⑤ 表 ${no} 表体内部无横线`, !innerRule, innerRule)
}

// ---- ⑥ 末行之后没有任何格有值（无表注、无空行尾巴）----
for (const [ws, no, last] of [[ws1, 1, LAST1], [ws2, 2, LAST2]]) {
  let after = ''
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= last) return
    row.eachCell({ includeEmpty: false }, (cell, cn) => { if (rt(cell.value) !== '') after ||= `R${rn}C${cn}=${rt(cell.value)}` })
  })
  ok(`⑥ 表 ${no} 末行之后一个字都没有`, !after, after)
  ok(`⑥ 表 ${no} 行数恰好 = 表题 + 表头 + 数据`, ws.rowCount === last, `${ws.rowCount} vs ${last}`)
}

// ---- ⑦ 日期是 Date、时刻是 0~1 的时间序列值且 numFmt hh:mm:ss、时长 / 恶化是数 ----
// ★ exceljs 读回时会把「带日期/时间格式的序列值」还原成 Date（写进去的是数，读出来是 Date），
//   故断言换算回序列值再比：XL_EPOCH = 1899-12-30 UTC，恰是 86400000 的整倍数，取模即当天秒。
const XL_EPOCH = Date.UTC(1899, 11, 30)
const serialOf = (v) => (v instanceof Date ? (v.getTime() - XL_EPOCH) / 86400000 : v)
{
  const c3 = ws2.getCell(3, 3)
  ok('⑦ 日期格是真日期值', c3.value instanceof Date, String(c3.value))
  ok('⑦ 日期格式 yyyy-mm-dd', c3.numFmt === 'yyyy-mm-dd', c3.numFmt)
  ok('⑦ 日期是整日序列值（0 时 0 分）', Number.isInteger(serialOf(c3.value)), String(serialOf(c3.value)))
  let timeOk = true, fmtOk = true, bad = ''
  for (const cn of [4, 5, 6]) {
    const c = ws2.getCell(3, cn)
    const s = serialOf(c.value)
    if (!(typeof s === 'number' && s >= 0 && s < 1)) { timeOk = false; bad ||= `C${cn}=${s}` }
    if (c.numFmt !== 'hh:mm:ss') fmtOk = false
  }
  ok('⑦ 三个时刻是 0~1 的时间序列值（不带日期部分）', timeOk, bad)
  ok('⑦ 时刻格式 hh:mm:ss', fmtOk)
  ok('⑦ 时长 / 恶化 / 夹角是真数值', [7, 8, 9].every((cn) => typeof ws2.getCell(3, cn).value === 'number'))
  // 时刻与 payload 严格一致（主进程只写不算）
  const first = stations.find((s) => s[SEASONS[0]].rows.length)[SEASONS[0]].rows[0]
  const back = Math.round(serialOf(ws2.getCell(3, 5).value) * 86400)
  ok('⑦ 峰值时刻回读 = payload 的秒', back === first.peakSec, `${back} vs ${first.peakSec}`)
  const dBack = new Date(XL_EPOCH + serialOf(ws2.getCell(3, 3).value) * 86400000)
  ok('⑦ 日期回读 = payload 的日期', dBack.toISOString().slice(0, 10) === first.date, `${dBack.toISOString().slice(0, 10)} vs ${first.date}`)
}

// ---- ⑧ 中西混排格写盘后是富文本（宋体 + Times New Roman）----
{
  const c = ws1.getCell(1, 1)
  const runs = c.value && c.value.richText ? c.value.richText : []
  const fonts = new Set(runs.map((r) => r.font && r.font.name))
  ok('⑧ 表题是富文本', runs.length >= 2, runs.length + ' 段')
  ok('⑧ 表题中西分家（宋体 + Times New Roman）', fonts.has('宋体') && fonts.has('Times New Roman'), [...fonts].join('+'))
  // 数字格一律 TNR
  ok('⑧ 数字格是 Times New Roman', ws1.getCell(3, 2).font && ws1.getCell(3, 2).font.name === 'Times New Roman')
}

// ---- ⑩ 没有 autoFilter、不冻结、隐藏网格线 ----
for (const [ws, no] of [[ws1, 1], [ws2, 2]]) {
  ok(`⑩ 表 ${no} 无筛选器`, !ws.autoFilter, JSON.stringify(ws.autoFilter || null))
  const v = (ws.views && ws.views[0]) || {}
  ok(`⑩ 表 ${no} 不冻结`, v.state !== 'frozen', String(v.state))
  ok(`⑩ 表 ${no} 隐藏网格线`, v.showGridLines === false)
}

// ---- 纯几何档：表题括号内换口径 ----
{
  const buf2 = await buildSunOutageExcel(Object.assign({}, payload, { criterion: { mode: 'geometric', degDb: '1' } }))
  const wb2 = new ExcelJS.Workbook()
  await wb2.xlsx.load(buf2)
  const t = rt(wb2.getWorksheet('地球站').getCell(1, 1).value)
  ok('纯几何档表题', /判据：纯几何，θ_th = θ_3dB/.test(t), t.slice(-30))
}

// ---- 单季：未选的季不出列 ----
{
  const one = { ...payload, seasons: ['vernal'] }
  const buf3 = await buildSunOutageExcel(one)
  const wb3 = new ExcelJS.Workbook()
  await wb3.xlsx.load(buf3)
  const w = wb3.getWorksheet('地球站')
  const head = []
  for (let c = 1; c <= 13; c++) head.push(rt(w.getCell(2, c).value))
  ok('单季：表 1 恰 13 列、无秋分列', w.actualColumnCount === 13 && !head.some((h) => h.includes('秋分')), head.slice(11).join('/'))
  const rows = stations.reduce((a, st) => a + st.vernal.rows.length, 0)
  ok('单季：表 2 只出春分行', wb3.getWorksheet('日凌窗口').actualRowCount === 2 + rows)
}

// ---- 无事件：表 2 只剩表题 + 表头，且不画底线 ----
{
  const empty = { ...payload, stations: stations.map((st) => ({ ...st, vernal: { days: 0, maxMin: 0, rows: [] }, autumnal: { days: 0, maxMin: 0, rows: [] } })) }
  const buf4 = await buildSunOutageExcel(empty)
  const wb4 = new ExcelJS.Workbook()
  await wb4.xlsx.load(buf4)
  const w = wb4.getWorksheet('日凌窗口')
  ok('无事件：表 2 只剩表题 + 表头', w.actualRowCount === 2, String(w.actualRowCount))
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
  const buf = await buildSunOutageWord(wp)
  ok('Word 出得来', buf && buf.length > 4000, (buf && buf.length) + ' bytes')

  const ev = sunOutageIcsEvents(wp)
  ok('ICS 事件数 = Σ 事件天数（多站多季一份日历）', ev.length === nEvents, `${ev.length} vs ${nEvents}`)
  ok('ICS UID 两两不同（重导覆盖而非重复）', new Set(ev.map((e) => e.uid)).size === ev.length)
  ok('ICS UID 含 星-站-日期', /^so-.+-\d+\.\d{4}-\d+\.\d{4}-\d{4}-\d{2}-\d{2}@satsim-platform$/.test(ev[0].uid), ev[0].uid)
  ok('ICS 描述里没有「强度」', !ev.some((e) => /强度/.test(e.description)))
  ok('ICS 描述里没有「高」「中」「低」这类判定', !ev.some((e) => /强度|达标|受限|合格/.test(e.summary + e.description)))
  ok('ICS 本地时刻用 payload 的 tzLabel', ev.every((e) => e.description.includes('(' + wp.tzLabel + ')') || e.description.includes('窗口(' + wp.tzLabel + ')')))
  ok('ICS 两条提醒不变', ev.every((e) => e.alarms.length === 2 && e.alarms[0].minutesBefore === 1440 && e.alarms[1].minutesBefore === 30))
  ok('ICS 覆盖到了每个站', new Set(ev.map((e) => e.location)).size === wp.stations.filter((s) => SEASONS.some((x) => s[x] && s[x].rows.length)).length)
  const text = buildIcs({ name: 'T', events: ev })
  ok('ICS 文本可生成且含 VEVENT', /BEGIN:VEVENT/.test(text) && text.split('BEGIN:VEVENT').length - 1 === ev.length)
  ok('ICS 文本里没有「强度」', !/强度/.test(text))
  // 无事件：不出空日历
  ok('无事件时事件数为 0', sunOutageIcsEvents({ ...wp, stations: [] }).length === 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
