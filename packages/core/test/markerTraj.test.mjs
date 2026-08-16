// 航迹 ⇄ Excel 的按工作表批量导入导出（src/viz/markers/useMarkerTable.js 的 trajsFromSheets）。
//
// 【真落一次盘再读回来】：导出模型 → 主进程刷工作簿 → 读回 → 还原成航迹，逐点比对。
// 光测解析函数看不见的坑全在这条往返上：航迹类型（航行/飞行）不是航点属性、写不进「首行表头 + 纯数据」
// 的数据表，只能记在 note（主进程单开的「说明」表）—— 说明表要是被当成一张数据表读回来，
// 界面上就会平白多出一条叫「说明」的航迹。
//
// 关键不变式：
//   ① 一张工作表 = 一条航迹，表名即航迹名；
//   ② 「说明」表不算航迹，且它记的航行/飞行要还原回去；
//   ③ 没有说明表（手搓的工作簿）退回按表名认，仍认不出算航行 —— 绝不因为认不出就丢表；
//   ④ 无表头的表退回位置约定（末两列 = 经纬度），与剪贴板粘贴同一条解析；
//   ⑤ 一个航点都读不到的表整张丢掉（工作簿里常混着无关的表），但不能连带丢掉别的表；
//   ⑥ 负经纬度（西经/南纬）原样往返 —— 这条是老坑，空格被当成 0 就是静默算错。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { sheetModel } from '../../../src/shared/gridXlsx.js'
import { trajsFromSheets, trajKindOf, TRAJ_SHEET_COLS } from '../../../src/viz/markers/useMarkerTable.js'

const require = createRequire(import.meta.url)
const { buildGridWorkbook, readGridWorkbook } = require('../../../electron/services/gridXlsx.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
}

let seq = 0
const newId = () => 'wp' + (++seq)

// ---- 往返：两条航迹（一航行一飞行，含西经/南纬）导出 → 落盘 → 读回 → 还原 ----
const TRAJS = [
  { name: '南海航线', kind: 'sea', pts: [{ lat: 22.3, lon: 114.2 }, { lat: 10.5, lon: 109.0 }, { lat: -6.2, lon: 106.8 }] },
  { name: '跨太平洋', kind: 'flight', pts: [{ lat: 35.6, lon: 139.8 }, { lat: 40.7, lon: -122.4 }] }
]
const sheets = TRAJS.map((t) => sheetModel({
  name: t.name, cols: [{ key: 'lon', label: '经度' }, { key: 'lat', label: '纬度' }],
  rows: t.pts, value: (r, c) => r[c.key], note: t.kind === 'flight' ? '飞行' : '航行'
}))
const tmp = path.join(os.tmpdir(), 'satsim-traj-test-' + process.pid + '.xlsx')
fs.writeFileSync(tmp, Buffer.from(await buildGridWorkbook({ sheets })))
const back = await readGridWorkbook(tmp)
ok('工作簿含两张数据表 + 一张说明表', back.sheets.length === 3, back.sheets.map((s) => s.name).join('|'))

const got = trajsFromSheets(back.sheets, { newId })
ok('还原出两条航迹（说明表不算一条）', got.length === 2, JSON.stringify(got.map((t) => t.name)))
ok('表名即航迹名', got[0].name === '南海航线' && got[1].name === '跨太平洋', got.map((t) => t.name).join('|'))
ok('航迹类型从说明表还原', got[0].kind === 'sea' && got[1].kind === 'flight', got.map((t) => t.kind).join('|'))
ok('航点数不变', got[0].pts.length === 3 && got[1].pts.length === 2, got.map((t) => t.pts.length).join('|'))
ok('南纬原样往返', Math.abs(got[0].pts[2].lat - (-6.2)) < 1e-9, String(got[0].pts[2].lat))
ok('西经原样往返', Math.abs(got[1].pts[1].lon - (-122.4)) < 1e-9, String(got[1].pts[1].lon))
ok('航点都带 id（网格定位用）', got.every((t) => t.pts.every((p) => !!p.id)))
try { fs.unlinkSync(tmp) } catch { /* 清理失败不影响判定 */ }

// ---- 没有说明表：退回按表名认类型 ----
const H = ['经度', '纬度']
const byName = trajsFromSheets([
  { name: '飞行3', rows: [H, [120, 30]] },
  { name: '航行1', rows: [H, [121, 31]] },
  { name: 'Flight A', rows: [H, [122, 32]] },
  { name: '进港路线', rows: [H, [123, 33]] }        // 认不出 → 航行
], { newId })
ok('按表名认出飞行', byName[0].kind === 'flight' && byName[2].kind === 'flight', byName.map((t) => t.kind).join('|'))
ok('认不出的算航行、不丢表', byName.length === 4 && byName[1].kind === 'sea' && byName[3].kind === 'sea', byName.map((t) => t.kind).join('|'))
ok('trajKindOf 空值算航行', trajKindOf(null) === 'sea' && trajKindOf('') === 'sea')

// ---- 表头：列序打乱 / 带单位 / 中文全角括号都得认得（与通用表头匹配同一条口径）----
const shuffled = trajsFromSheets([{ name: 'A', rows: [['纬度（°N）', '经度 (°E)'], [39.9, 116.4], [31.2, 121.5]] }], { newId })
ok('乱序表头按标签取列（不按位置）', shuffled[0].pts[0].lat === 39.9 && shuffled[0].pts[0].lon === 116.4, JSON.stringify(shuffled[0].pts[0]))
ok('TRAJ_SHEET_COLS 是 经度、纬度 两列', TRAJ_SHEET_COLS.map((c) => c.key).join(',') === 'lon,lat')

// ---- 无表头：退回位置约定（末两列 = 经度、纬度），前面的列忽略 ----
const headless = trajsFromSheets([{ name: '航段', rows: [['P1', 116.4, 39.9], ['P2', -77.04, 38.9]] }], { newId })
ok('无表头退回末两列作经纬度', headless.length === 1 && headless[0].pts.length === 2 && headless[0].pts[1].lon === -77.04, JSON.stringify(headless))

// ---- 读不到航点的表整张丢掉，但不连累别的表 ----
const mixed = trajsFromSheets([
  { name: '说明', rows: [['航段', '飞行']] },
  { name: '封面', rows: [['本册说明']] },                       // 一列，凑不出坐标
  { name: '空表', rows: [H] },                                  // 只有表头
  { name: '航段', rows: [H, [10, 20], ['', 21], [11, null]] }    // 缺一半坐标的行不算航点
], { newId })
ok('无坐标的表被丢掉', mixed.length === 1 && mixed[0].name === '航段', JSON.stringify(mixed.map((t) => t.name)))
ok('残缺坐标的行不算航点', mixed[0].pts.length === 1 && mixed[0].pts[0].lon === 10, JSON.stringify(mixed[0].pts))
ok('说明表的类型对上了名字', mixed[0].kind === 'flight', mixed[0].kind)

// ---- 重名去重：与现有航迹重名、工作簿内部重名，都要加序号 ----
const dup = trajsFromSheets([
  { name: '航行1', rows: [H, [1, 2]] },
  { name: '航行1', rows: [H, [3, 4]] }
], { newId, taken: ['航行1'] })
ok('与现有航迹重名 → 加序号', dup[0].name === '航行1 (2)', dup[0].name)
ok('工作簿内部再重名 → 继续加', dup[1].name === '航行1 (3)', dup[1].name)
const noname = trajsFromSheets([{ name: '  ', rows: [H, [1, 2]] }], { newId, fallbackName: 'Track' })
ok('表名为空用兜底名', noname[0].name === 'Track', noname[0].name)

// ---- 空输入不炸 ----
ok('空工作簿返回空数组', trajsFromSheets([], { newId }).length === 0 && trajsFromSheets(null, { newId }).length === 0)
ok('只有说明表 → 一条航迹都不建', trajsFromSheets([{ name: '说明', rows: [['A', '飞行']] }], { newId }).length === 0)

console.log(`markerTraj: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
