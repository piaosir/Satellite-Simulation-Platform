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

// ---- 航迹表格「时间」列只敲时分：航点排不出时刻、航迹也没起始时，日期取时间轴那一天（nowMs），不取系统当天（2026-10-08 #35）----
{
  const { ref } = await import('vue')
  const { useMarkerTable } = await import('../../../src/viz/markers/useMarkerTable.js')
  const { parseTzText } = await import('../../../src/shared/tzText.js')
  const NOW = Date.UTC(2031, 4, 17, 9, 0, 0)   // 时间轴游标：离系统当天很远的一天
  const mkTraj = () => ref([{ id: 't1', name: '航行1', kind: 'sea', pts: [{ id: 'a', lat: 30, lon: 120 }, { id: 'b', lat: 31, lon: 121 }] }])
  const mkTable = (trajectories, nowMs) => useMarkerTable({
    points: ref([]), stations: ref([]), trajectories, newId: newId, sync: () => {},
    parseTime: (s, r) => parseTzText(s, 'utc', r), nowMs
  })
  {
    const tr = mkTraj(), mk = mkTable(tr, () => NOW)
    mk.wpUpdate('t1', 'b', { tMs: '10:30' })
    ok('改格：第二航点只敲时分 → 落在时间轴那天', tr.value[0].pts[1].tMs === Date.UTC(2031, 4, 17, 10, 30), new Date(tr.value[0].pts[1].tMs).toISOString())
  }
  {
    const tr = mkTraj(), mk = mkTable(tr, () => NOW)
    mk.wpUpdate('t1', 'a', { tMs: '08:15' })
    ok('改格：首航点只敲时分 → 起始落在时间轴那天', tr.value[0].t0Ms === Date.UTC(2031, 4, 17, 8, 15), String(tr.value[0].t0Ms))
  }
  {
    const tr = ref([{ id: 't1', name: '航行1', kind: 'sea', pts: [] }]), mk = mkTable(tr, () => NOW)
    const n = mk.wpPasteAppend('t1', '经度\t纬度\t时间\n122\t32\t11:15\n123\t33\t13:45')
    const t = tr.value[0]
    ok('粘贴：首行只写时分 → 起始落在时间轴那天，下一行沿用同一天', n === 2 && t.t0Ms === Date.UTC(2031, 4, 17, 11, 15) && t.pts[1].tMs === Date.UTC(2031, 4, 17, 13, 45), JSON.stringify({ n, t0: t.t0Ms, p1: t.pts[1] && t.pts[1].tMs }))
  }
  {
    const tr = mkTraj()
    tr.value[0].t0Ms = Date.UTC(2030, 0, 2, 6, 0)
    const mk = mkTable(tr, () => NOW)
    mk.wpUpdate('t1', 'b', { tMs: '07:00' })
    ok('航迹有起始时仍以排程 / 起始那天为准（不被时间轴顶掉）', new Date(tr.value[0].pts[1].tMs).toISOString().slice(0, 10) === '2030-01-02', new Date(tr.value[0].pts[1].tMs).toISOString())
  }
}

// ---- 标记表格自己的撤销栈：表格之外改过标记（地图上拖动 / 侧栏改名 / 场景撤销）之后，表格 Ctrl+Z 不回放旧快照（2026-10-16 体检 #5 同类）----
{
  const { ref } = await import('vue')
  const { useMarkerTable } = await import('../../../src/viz/markers/useMarkerTable.js')
  const points = ref([]), stations = ref([]), trajectories = ref([])
  let syncs = 0
  const mk = useMarkerTable({ points, stations, trajectories, newId: newId, sync: () => { syncs++ } })
  const tick = () => new Promise((r) => setTimeout(r, 0))
  // 表格里加一行（pushUndo → 改 → 同步任务收尾补拍「操作后」）
  mk.pushUndo(); mk.ptLayer.pasteAppend('116.4, 39.9')
  await tick()
  ok('表格撤销：照常撤回', mk.undo() === true && points.value.length === 0)
  ok('表格重做：照常重做', mk.redo() === true && points.value.length === 1)
  // 显隐不算改动：点一下眼睛之后照样撤得回，且保留此刻的显隐
  mk.pushUndo(); mk.ptLayer.pasteAppend('121.5, 31.2')
  await tick()
  points.value[0].show = false
  ok('显隐变化不让表格撤销失效', mk.undo() === true && points.value.length === 1 && points.value[0].show === false)
  mk.redo()
  // 表格之外加了一个点（没进表格的栈）：撤销不回放、那个点还在、表格的记录作废
  points.value.push({ id: 'ext', lat: 1, lon: 2 })
  const n0 = points.value.length, s0 = syncs
  ok('表格之外改过：undo 返回 stale、不回放', mk.undo() === 'stale' && points.value.length === n0 && points.value.some((p) => p.id === 'ext') && syncs === s0)
  ok('表格的撤销记录整个作废', !mk.canUndo.value && !mk.canRedo.value)
  // 同一同步任务里紧接着撤（微任务还没轮到补拍）：此刻就是操作后，照常撤
  mk.pushUndo(); mk.ptLayer.pasteAppend('100, 10')
  ok('同步紧接着撤：照常撤回', mk.undo() === true && points.value.length === n0)
}

// ---- 表名被 Excel 规矩改写过的往返（体检 2026-10-16 第二档）：重名 / 带「/」/ 超 31 字 / 航迹恰好叫「说明」----
// 主进程按 safeSheetName 改写表名（「/」换「·」、超长截断、重名加 (2)），「说明」表那一行记的却是原名 —— 按表名直接查就对不上：
// 飞行读成航行、速度 / 出发时刻 / 定时清单丢掉、同名两条串到对方头上。导回时按说明行次序重走同一把尺子对上实际表名。
// 与页面 mkExportTrajXlsx 同一套出表：表名 = 原名、note = trajNoteOf + pinNoteOf、「时间」列写实际值（推算的也写）。
{
  const { trajNoteOf } = await import('../models/entityRuntime.mjs')
  const { pinNoteOf } = await import('../../../src/viz/markers/useMarkerTable.js')
  const T0 = Date.UTC(2026, 9, 16, 8, 0, 0)
  const COLS = [{ key: 'lon', label: '经度' }, { key: 'lat', label: '纬度' }, { key: 'tMs', label: '时间' }]
  const LONG = '南海北部湾至琼州海峡夜间低空掠海巡逻航线第一编队训练科目甲'   // 32 字：超出 Excel 表名上限 31
  const exportBook = async (trajs) => {
    const sheets = trajs.map((t) => sheetModel({
      name: t.name, cols: COLS, rows: t.pts,
      value: (r, c) => (c.key === 'tMs' ? (Number.isFinite(r.tOut) ? new Date(r.tOut).toISOString() : null) : r[c.key]),
      note: trajNoteOf(t) + '; ' + pinNoteOf(t)
    }))
    const f = path.join(os.tmpdir(), 'satsim-traj-rename-' + process.pid + '-' + (++seq) + '.xlsx')
    fs.writeFileSync(f, Buffer.from(await buildGridWorkbook({ sheets })))
    const b = await readGridWorkbook(f)
    try { fs.unlinkSync(f) } catch { /* 清理失败不影响判定 */ }
    return b
  }
  const parseTime = (s) => Date.parse(String(s))
  const A = [
    { name: '巡逻', kind: 'flight', speedKmh: 480, t0Ms: T0, pts: [{ lat: 20, lon: 110, tOut: T0 }, { lat: 21, lon: 111, tOut: T0 + 1200e3 }] },
    { name: '巡逻', kind: 'sea', speedKmh: 25, pts: [{ lat: 18, lon: 109, tOut: T0 }, { lat: 18.5, lon: 109.5, tOut: T0 + 9000e3 }] },
    { name: 'CA981 北京/纽约', kind: 'flight', speedKmh: 900, pts: [{ lat: 40.08, lon: 116.58 }, { lat: 40.64, lon: -73.78 }] },
    { name: LONG, kind: 'sea', speedKmh: 30, pts: [{ lat: 21.5, lon: 109.1 }, { lat: 20.2, lon: 110.2 }] }
  ]
  const backA = await exportBook(A)
  const tabs = backA.sheets.map((s) => s.name)
  ok('改写：重名加 (2)、「/」换「·」、超长截断，说明表在最后', tabs.length === 5 && tabs[0] === '巡逻' && tabs[1] === '巡逻(2)' &&
    tabs[2] === 'CA981 北京·纽约' && tabs[3] === LONG.slice(0, 31) && tabs[4] === '说明', tabs.join('|'))
  const g = trajsFromSheets(backA.sheets, { newId, parseTime })
  ok('四条航迹都回来（说明表不算一条）', g.length === 4, JSON.stringify(g.map((t) => t.name)))
  ok('同名第一条：飞行 480 km/h + 出发时刻，没串成第二条的', g[0] && g[0].kind === 'flight' && g[0].speedKmh === 480 && g[0].t0Ms === T0,
    JSON.stringify(g[0] && { k: g[0].kind, v: g[0].speedKmh, t0: g[0].t0Ms }))
  ok('同名第二条（表名「巡逻(2)」）：航行 25 km/h、无出发时刻', g[1] && g[1].kind === 'sea' && g[1].speedKmh === 25 && !('t0Ms' in g[1]),
    JSON.stringify(g[1] && { k: g[1].kind, v: g[1].speedKmh, t0: g[1].t0Ms }))
  // 定时清单：第一条只钉首航点（= 出发时刻）、第二条一个都没钉 —— 说明行丢了的话清单为 null，「时间」列里的推算值会全被当成钉点
  ok('定时清单跟着说明行回来（推算出来的时刻不被钉成航点时刻）',
    g[0] && g[1] && g[0].pts.every((p) => !('tMs' in p)) && g[1].pts.every((p) => !('tMs' in p)),
    JSON.stringify(g.slice(0, 2).map((t) => t.pts.map((p) => p.tMs))))
  ok('带「/」的航迹：类型与速度对上、名字原样回来', g[2] && g[2].kind === 'flight' && g[2].speedKmh === 900 && g[2].name === 'CA981 北京/纽约',
    JSON.stringify(g[2] && { n: g[2].name, k: g[2].kind, v: g[2].speedKmh }))
  ok('超长名的航迹：说明对上、完整原名回来', g[3] && g[3].kind === 'sea' && g[3].speedKmh === 30 && g[3].name === LONG,
    JSON.stringify(g[3] && { n: g[3].name, k: g[3].kind, v: g[3].speedKmh }))
  ok('同名两条导回后仍分得开（第二条加序号）', g[0] && g[1] && g[0].name === '巡逻' && g[1].name === '巡逻 (2)', g.map((t) => t.name).join('|'))
  // 航迹恰好叫「说明」：那张数据表先占了名字，说明表被改写成「说明(2)」
  const backB = await exportBook([
    { name: '说明', kind: 'flight', speedKmh: 300, pts: [{ lat: 30, lon: 120 }, { lat: 31, lon: 121 }] },
    { name: '返航', kind: 'sea', speedKmh: 12, pts: [{ lat: 22, lon: 114 }, { lat: 23, lon: 115 }] }
  ])
  ok('航迹叫「说明」：说明表成了「说明(2)」', backB.sheets.map((s) => s.name).join('|') === '说明|返航|说明(2)', backB.sheets.map((s) => s.name).join('|'))
  const gb = trajsFromSheets(backB.sheets, { newId })
  ok('航迹叫「说明」：两条都回来、各自的说明都对上', gb.length === 2 && gb[0].name === '说明' && gb[0].kind === 'flight' && gb[0].speedKmh === 300 &&
    gb[1].name === '返航' && gb[1].kind === 'sea' && gb[1].speedKmh === 12, JSON.stringify(gb.map((t) => ({ n: t.name, k: t.kind, v: t.speedKmh }))))
  // 手搓工作簿最后一张表恰好叫「说明(2)」、却是航点表：照旧当航迹，不被当成说明表吞掉
  const handB = trajsFromSheets([{ name: '航段', rows: [H, [1, 2]] }, { name: '说明(2)', rows: [H, [3, 4], [5, 6]] }], { newId })
  ok('最后一张叫「说明(2)」的航点表照旧当航迹', handB.length === 2 && handB[1].name === '说明(2)' && handB[1].pts.length === 2, JSON.stringify(handB.map((t) => t.name)))
}

console.log(`markerTraj: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
