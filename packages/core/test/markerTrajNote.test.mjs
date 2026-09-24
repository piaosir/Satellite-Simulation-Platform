// 航迹 Excel 说明行透传航迹级字段（P4 契约 §1.3 / §4.4；src/viz/markers/useMarkerTable.js 的 trajsFromSheets）。
//
// 说明行从「飞行 / 航行」扩成「类型; 巡航高度=… m; 速度=… km/h; 起始=ISO; 模型=id; 图标=px」，第一段仍是类型词。
// 关键不变式：
//   ① 新字段（cruiseAltM / speedKmh / t0Ms / model）经真落盘往返（buildGridWorkbook → readGridWorkbook）逐位回来，说明文本原样回来；
//   ② 老说明行（只有类型词）与没有说明表（按表名认类型）的输出与改前逐项深相等 —— 对象上不凭空多出字段；
//   ③ 非法值（负速度、越界图标、坏模型 id、不存在的日期）静默丢掉，不连累合法项、不连累类型；
//   ④ 键别名 / 单位换算 / 全角 / 无时区按 UTC 走 core 的 parseTrajNote（这里只核透传，不重复 core 的解析单测）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { sheetModel } from '../../../src/shared/gridXlsx.js'
import { trajsFromSheets, trajKindOf, TRAJ_NOTE_FIELDS, TRAJ_SHEET_COLS } from '../../../src/viz/markers/useMarkerTable.js'
import { trajNoteOf } from '../models/entityRuntime.mjs'

const require = createRequire(import.meta.url)
const { buildGridWorkbook, readGridWorkbook } = require('../../../electron/services/gridXlsx.js')

let pass = 0, fail = 0
function ok(name, fn) {
  try { fn(); pass++ } catch (e) { fail++; console.error(`  ✗ ${name} — ${e && e.message ? e.message : e}`) }
}
let seq = 0
const newId = () => 'wp' + (++seq)
const COLS = [{ key: 'lon', label: '经度' }, { key: 'lat', label: '纬度' }]
const H = ['经度', '纬度']
// 改前的 trajsFromSheets 口径（对照组）：{name, kind: trajKindOf(说明 ?? 表名), pts}
const legacyKind = (notes, nm) => trajKindOf(notes.has(nm) ? notes.get(nm) : nm)

// ---- ① 真落盘往返：两条带全部新字段的航迹 + 一条老样子的航迹 ----
const T0 = Date.UTC(2026, 8, 24, 8, 0, 0)
const TRAJS = [
  { name: 'FRA-JFK', kind: 'flight', pts: [{ lat: 50.03, lon: 8.57 }, { lat: 40.64, lon: -73.78 }], cruiseAltM: 11277.6, speedKmh: 850, t0Ms: T0, model: { id: 'ent:a320neo', px: 48 } },
  { name: '印度洋航线', kind: 'sea', pts: [{ lat: 1.26, lon: 103.8 }, { lat: 6.9, lon: 79.85 }, { lat: 25.2, lon: 55.27 }], speedKmh: 37.04, t0Ms: T0 - 6 * 3600e3 + 123, model: { id: 'ent:ulcs-24k' } },
  { name: '老航迹', kind: 'flight', pts: [{ lat: 35.6, lon: 139.8 }, { lat: 40.7, lon: -122.4 }] }
]
const notesOut = TRAJS.map((t) => trajNoteOf(t))
const sheets = TRAJS.map((t, i) => sheetModel({ name: t.name, cols: COLS, rows: t.pts, value: (r, c) => r[c.key], note: notesOut[i] }))
const tmp = path.join(os.tmpdir(), 'satsim-trajnote-test-' + process.pid + '.xlsx')
fs.writeFileSync(tmp, Buffer.from(await buildGridWorkbook({ sheets })))
const back = await readGridWorkbook(tmp)
try { fs.unlinkSync(tmp) } catch { /* 清理失败不影响判定 */ }

ok('工作簿 = 三张数据表 + 一张说明表', () => assert.equal(back.sheets.length, 4, back.sheets.map((s) => s.name).join('|')))
ok('说明文本原样回来', () => {
  const ns = back.sheets.find((s) => s.name === '说明')
  assert.ok(ns, '没有说明表')
  const m = new Map(ns.rows.filter((r) => r && r[0] != null).map((r) => [String(r[0]).trim(), String(r[1] == null ? '' : r[1])]))
  TRAJS.forEach((t, i) => assert.equal(m.get(t.name), notesOut[i], t.name))
})
ok('老航迹的说明行仍只有类型词', () => assert.equal(notesOut[2], '飞行'))
const got = trajsFromSheets(back.sheets, { newId })
ok('还原出三条航迹', () => assert.equal(got.length, 3))
ok('新字段逐位透传（cruiseAltM / speedKmh / t0Ms / model）', () => {
  for (let i = 0; i < 2; i++) {
    const a = TRAJS[i], b = got[i]
    assert.equal(b.kind, a.kind, a.name + ' kind')
    for (const k of ['cruiseAltM', 'speedKmh', 't0Ms']) assert.ok(Object.is(b[k], a[k]), `${a.name}.${k}: ${b[k]} ≠ ${a[k]}`)
    assert.deepEqual(b.model, a.model, a.name + '.model')
  }
})
ok('航行航迹不写巡航高度', () => assert.ok(!('cruiseAltM' in got[1])))
ok('老航迹不多出任何字段', () => assert.deepEqual(Object.keys(got[2]).sort(), ['kind', 'name', 'pts']))
ok('航点照旧（逐位 + 带 id）', () => {
  TRAJS.forEach((t, i) => {
    assert.equal(got[i].pts.length, t.pts.length)
    t.pts.forEach((p, j) => { assert.ok(Object.is(got[i].pts[j].lat, p.lat) && Object.is(got[i].pts[j].lon, p.lon)); assert.ok(got[i].pts[j].id) })
  })
})
ok('TRAJ_NOTE_FIELDS 恰是四个航迹级字段', () => assert.deepEqual([...TRAJ_NOTE_FIELDS], ['cruiseAltM', 'speedKmh', 't0Ms', 'model']))
ok('表格列不变（经度、纬度）', () => assert.equal(TRAJ_SHEET_COLS.map((c) => c.key).join(','), 'lon,lat'))

// ---- ② 老工作簿：输出与改前逐项深相等 ----
{
  const oldSheets = [
    { name: '说明', rows: [['南海航线', '航行'], ['跨太平洋', '飞行'], ['Flight A', ''], ['进港', 'Flight']] },
    { name: '南海航线', rows: [H, [114.2, 22.3], [109.0, 10.5]] },
    { name: '跨太平洋', rows: [H, [139.8, 35.6], [-122.4, 40.7]] },
    { name: 'Flight A', rows: [H, [122, 32]] },
    { name: '进港', rows: [H, [123, 33]] },
    { name: '飞行3', rows: [H, [120, 30]] },          // 说明表里没有它 → 按表名
    { name: '航段', rows: [['P1', 116.4, 39.9]] }      // 无表头
  ]
  const notes = new Map(oldSheets[0].rows.map((r) => [String(r[0]).trim(), String(r[1] == null ? '' : r[1])]))
  seq = 0
  const a = trajsFromSheets(oldSheets, { newId })
  seq = 0
  const b = a.map((t) => ({ name: t.name, kind: legacyKind(notes, t.name), pts: t.pts.map((p) => ({ id: newId(), lat: p.lat, lon: p.lon })) }))
  ok('老说明行 / 表名兜底：与改前深相等', () => assert.deepEqual(a, b))
  ok('老说明行的类型', () => assert.deepEqual(a.map((t) => t.kind), ['sea', 'flight', 'sea', 'flight', 'flight', 'sea']))
}

// ---- ③ 非法值静默丢掉，合法项留下 ----
{
  const s = [
    { name: '说明', rows: [['A', '飞行; 速度=-5 km/h; 模型=bad id; 图标=300 px; 起始=2026-02-30 08:00'], ['B', '航行; 速度=20 kn; 图标=64 px'], ['C', '飞行; 巡航高度=40000 m; 模型=ent:a320neo; 图标=4 px']] },
    { name: 'A', rows: [H, [1, 2], [3, 4]] },
    { name: 'B', rows: [H, [5, 6], [7, 8]] },
    { name: 'C', rows: [H, [9, 10], [11, 12]] }
  ]
  const r = trajsFromSheets(s, { newId })
  ok('全非法：只剩类型', () => assert.deepEqual(Object.keys(r[0]).sort(), ['kind', 'name', 'pts']) || assert.equal(r[0].kind, 'flight'))
  ok('图标没有模型可挂 → 丢掉；速度按节换算', () => { assert.equal(r[1].kind, 'sea'); assert.equal(r[1].speedKmh, 37.04); assert.ok(!('model' in r[1])) })
  ok('巡航高度越界丢掉、越界图标不并进模型', () => { assert.ok(!('cruiseAltM' in r[2])); assert.deepEqual(r[2].model, { id: 'ent:a320neo' }) })
}

// ---- ④ 变体（透传层面）：键别名 / FL / 全角 / 无时区 = UTC ----
{
  const s = [
    { name: '说明', rows: [['X', 'Flight; cruise=FL350; speed=450 kn; start=2026-09-24 08:00'], ['Y', '飞行；巡航高度＝１０６６８ｍ；速度：８５０']] },
    { name: 'X', rows: [H, [1, 2], [3, 4]] },
    { name: 'Y', rows: [H, [5, 6], [7, 8]] }
  ]
  const r = trajsFromSheets(s, { newId })
  ok('FL350 → 10668 m、450 kn → 833.4 km/h、无时区按 UTC', () => { assert.equal(r[0].kind, 'flight'); assert.equal(r[0].cruiseAltM, 10668); assert.equal(r[0].speedKmh, 833.4); assert.equal(r[0].t0Ms, T0) })
  ok('全角说明行照认', () => { assert.equal(r[1].kind, 'flight'); assert.equal(r[1].cruiseAltM, 10668); assert.equal(r[1].speedKmh, 850) })
}

console.log(`markerTrajNote: ${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
if (fail) process.exit(1)
