// 通用表格 ⇄ Excel 的自测：渲染端模型（src/shared/gridXlsx.js）与刷格/读格（electron/services/gridXlsx.js）
// 各测一遍，并【真的落一次盘再读回来】—— 这条管线过 IPC，模型建得对而工作簿写不出来（表名越界、
// numFmt 非法、值是 Vue 的 Proxy）在界面上只表现为「导出失败」四个字，光测模型看不见。
//
// 关键不变式：
//   ① 模型必须是【纯数据】——过一趟 structuredClone 不抛（见 ipc-no-reactive-proxy：invoke 当场抛且没人 catch）；
//   ② 数字列落进 Excel 是【数值】不是字符串（导出的整个意义在于还能在 Excel 里求和排序）；
//   ③ 表头 = 界面列标签（带单位），回导时按标签匹配 → 用户在 Excel 里【调换列序 / 删掉不用的列】都认得；
//   ④ 认不出表头时不许瞎猜：sheetToRecords 回 records=null，由调用方退回「末两列=经纬度」的位置约定；
//   ⑤ 空单元格必须还原成空，不能变成 0 —— 经纬度列一旦被写成 0 就是静默算错（西经/南纬那条老坑）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { sheetModel, colLabel, findHeader, sheetToRecords, sheetToTsv, pickSheet, safeFileName } from '../../../src/shared/gridXlsx.js'

const require = createRequire(import.meta.url)
const { buildGridWorkbook, readGridWorkbook } = require('../../../electron/services/gridXlsx.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
}

// 样例：性能表的「城市输入」那五列，含负经纬度与空行
const COLS = [
  { key: 'country', label: '国家' },
  { key: 'city', label: '城市' },
  { key: 'desig', label: '代号' },
  { key: 'lon', label: '经度', num: true, unit: '°E', fix: 2 },
  { key: 'lat', label: '纬度', num: true, unit: '°N', fix: 2 }
]
const ROWS = [
  { id: 's1', country: '中国', city: '北京', desig: 'BJ', lon: 116.4, lat: 39.9 },
  { id: 's2', country: '美国', city: 'Washington, DC', desig: 'DC', lon: -77.04, lat: 38.9 },
  { id: 's3', country: '', city: '', desig: '', lon: null, lat: null }
]

// ---- ① 模型是纯数据 + 表头带单位 ----
const sm = sheetModel({ name: '城市输入', cols: COLS, rows: ROWS, note: '卫星 中星6D · 天线 C-Global' })
try { structuredClone(sm); ok('模型可结构化克隆（纯数据，能过 IPC）', true) }
catch (e) { ok('模型可结构化克隆（纯数据，能过 IPC）', false, e.message) }
ok('表头 = 列标签 + 括号单位', sm.header.join('|') === '国家|城市|代号|经度 (°E)|纬度 (°N)', sm.header.join('|'))
ok('colLabel 无单位时不加括号', colLabel({ key: 'city', label: '城市' }) === '城市')

// ---- ② 数字列出数值、空格出 null ----
ok('数字列在模型里是 number', typeof sm.rows[0][3] === 'number' && sm.rows[0][3] === 116.4)
ok('负经度不被吞', sm.rows[1][3] === -77.04)
ok('空单元格是 null（不是 0/空串）', sm.rows[2][3] === null && sm.rows[2][4] === null)
ok('含逗号的文本原样保留', sm.rows[1][1] === 'Washington, DC')

// ---- 真落盘 → 读回来 ----
const tmp = path.join(os.tmpdir(), 'satsim-gridxlsx-test-' + process.pid + '.xlsx')
const buf = await buildGridWorkbook({ sheets: [sm, sheetModel({ name: '第二张', cols: [{ key: 'a', label: 'A' }], rows: [{ id: 'x', a: 'hello' }] })] })
fs.writeFileSync(tmp, Buffer.from(buf))
ok('工作簿写盘成功且非空', fs.statSync(tmp).size > 2000)

const back = await readGridWorkbook(tmp)
// 两张数据表 + 一张「说明」表（上下文另开一张，绝不写在数据表下方 —— 空行不是可靠分隔符，
// 那行字会被当成一条数据读回来）
ok('读回三张工作表（含说明表）', back.sheets.length === 3, String(back.sheets.length))
ok('说明单开一张表', back.sheets[2].name === '说明' && String(back.sheets[2].rows[0][1]).includes('中星6D'), JSON.stringify(back.sheets[2].rows))
const s0 = back.sheets[0]
ok('工作表名保留', s0.name === '城市输入', s0.name)
ok('数据表只有表头 + 数据行', s0.rows.length === 3, String(s0.rows.length))
ok('首行是表头', String(s0.rows[0][0]) === '国家' && String(s0.rows[0][3]) === '经度 (°E)', JSON.stringify(s0.rows[0]))
ok('数字列读回来仍是 number', typeof s0.rows[1][3] === 'number' && Math.abs(s0.rows[1][3] - 116.4) < 1e-9)
ok('负数往返不变', Math.abs(s0.rows[2][3] - (-77.04)) < 1e-9)

// ---- ③ 表头匹配：调换列序 + 删列 + 改写单位写法，都得认得 ----
const shuffled = {
  name: 'x',
  rows: [
    ['纬度（°N）', '城市', '经度'],       // 全角括号 / 去掉单位 / 只留三列且顺序打乱
    [39.9, '北京', 116.4],
    [-33.87, '悉尼', 151.2]
  ]
}
const h = findHeader(shuffled.rows, COLS)
ok('乱序表头能定位', h && h.row === 0, JSON.stringify(h))
ok('乱序表头对上 key', h && h.keys.join(',') === 'lat,city,lon', h && h.keys.join(','))
const rec = sheetToRecords(shuffled, COLS)
ok('按表头取值（列序无关）', rec.records.length === 2 && rec.records[0].city === '北京' && rec.records[0].lon === '116.4' && rec.records[1].lat === '-33.87',
  JSON.stringify(rec.records))
ok('未出现在表头里的列留空', rec.records[0].country === undefined || rec.records[0].country === '')

// ---- ④ 认不出表头 → records=null（交回位置约定），且 TSV 兜底可用 ----
const headless = { name: 'y', rows: [['中国', '北京', 'BJ', 116.4, 39.9], ['美国', '华盛顿', 'DC', -77.04, 38.9]] }
const rec2 = sheetToRecords(headless, COLS)
ok('无表头时不瞎猜（records=null）', rec2.records === null)
const tsv = sheetToTsv(headless)
ok('TSV 兜底按制表符切、含负数', tsv.split('\n')[1] === '美国\t华盛顿\tDC\t-77.04\t38.9', JSON.stringify(tsv.split('\n')[1]))

// ---- ⑤ 多表工作簿：挑表头对得最多的那张 ----
const picked = pickSheet(back.sheets, COLS)
ok('多表时挑中匹配最多的那张', picked && picked.name === '城市输入', picked && picked.name)
ok('一张都对不上时退回首张有数据的表', pickSheet([{ name: 'z', rows: [['a', 'b'], [1, 2]] }], COLS).name === 'z')
// 命中数打平 → 比「命中占该表列数的比例」：宽表（结果表恰好也含这几列）不该抢走窄表
const TGT = [{ key: 'name', label: '目标卫星' }, { key: 'noradId', label: 'NORAD' }, { key: 'group', label: '分组' }]
const wide = { name: '性能结果', rows: [['No.', '源卫星', '目标卫星', 'NORAD', '分组', '斜距', 'Dir'], [1, 'A', 'S1', 111, 'G', 500, 40]] }
const narrow = { name: '目标星', rows: [['目标卫星', 'NORAD', '分组'], ['S1', 111, 'G']] }
ok('打平时挑「整张表就是这个」的窄表', pickSheet([wide, narrow], TGT).name === '目标星', pickSheet([wide, narrow], TGT).name)

// ---- 往返闭环：导出 → 读回 → 按表头还原，值逐一对得上 ----
const rt = sheetToRecords(s0, COLS)
ok('往返后行数不变（空行不进记录，说明行被丢掉）', rt.records.length === 2, String(rt.records.length))
ok('往返后经纬度不变', rt.records[0].lon === '116.4' && rt.records[1].lon === '-77.04', JSON.stringify(rt.records))
ok('往返后含逗号文本不变', rt.records[1].city === 'Washington, DC', rt.records[1].city)

// ---- 文件名清洗 ----
ok('文件名去掉 Windows 非法字符', safeFileName('中星6D/C:全球*波束') === '中星6D_C_全球_波束', safeFileName('中星6D/C:全球*波束'))
ok('空名给兜底', safeFileName('   ', '表格') === '表格')

// 表名越界/非法字符：Excel 上限 31 字、禁 : \ / ? * [ ]
const longName = '这是一个非常非常非常非常长的工作表名字超过三十一个字符了' + '尾巴尾巴尾巴'
const buf2 = await buildGridWorkbook({ sheets: [sheetModel({ name: longName, cols: [{ key: 'a', label: 'A' }], rows: [] }), sheetModel({ name: 'a/b:c', cols: [{ key: 'a', label: 'A' }], rows: [] })] })
ok('超长/非法表名不炸', buf2 && buf2.byteLength > 0)

try { fs.unlinkSync(tmp) } catch { /* 清理失败不影响判定 */ }

console.log(`gridXlsx: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
