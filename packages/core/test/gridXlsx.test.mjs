// 通用表格 ⇄ Excel 的自测：渲染端模型（src/shared/gridXlsx.js）与刷格/读格（electron/services/gridXlsx.js）
// 各测一遍，并【真的落一次盘再读回来】—— 这条管线过 IPC，模型建得对而工作簿写不出来（表名越界、
// numFmt 非法、值是 Vue 的 Proxy）在界面上只表现为「导出失败」四个字，光测模型看不见。
//
// 关键不变式：
//   ① 模型必须是【纯数据】——过一趟 structuredClone 不抛（见 ipc-no-reactive-proxy：invoke 当场抛且没人 catch）；
//   ② 数字列落进 Excel 是【数值】不是字符串（导出的整个意义在于还能在 Excel 里求和排序）；
//   ③ 表头 = 界面列标签（带单位），回导时按标签匹配 → 用户在 Excel 里【调换列序 / 删掉不用的列】都认得；
//   ④ 认不出表头时不许瞎猜：sheetToRecords 回 records=null，由调用方退回「末两列=经纬度」的位置约定；
//   ⑤ 空单元格必须还原成空，不能变成 0 —— 经纬度列一旦被写成 0 就是静默算错（西经/南纬那条老坑）；
//   ⑥ 同名列（链路表发 / 收两侧的「经度」等）：导出表头带侧别「收信站·经度 (°E)」，导回按侧别对；
//      不带侧别的老文件按出现次序依次对到发、收两侧 —— 收信站那一组不许整组丢掉（体检 #8）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { sheetModel, colLabel, findHeader, sheetToRecords, sheetToTsv, pickSheet, safeFileName, sameNameKeys } from '../../../src/shared/gridXlsx.js'

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

// ---- 英文表头：导出首行查 uiDict EXACT（整串查不到按「标签 (单位)」拆开查），导回中英两套都认 ----
{
  const { setHeaderDict, headerEn } = await import('../../../src/shared/gridXlsx.js')
  const { EXACT } = await import('../../../src/shared/i18n/uiDict.data.js')
  const D = { '国家': EXACT['国家'] || 'Country', '城市': EXACT['城市'] || 'City', '经度': EXACT['经度'] || 'Longitude', '纬度': EXACT['纬度'] || 'Latitude' }
  setHeaderDict(D)
  ok('英文表头：带单位拆开查', headerEn('经度 (°E)') === D['经度'] + ' (°E)', headerEn('经度 (°E)'))
  ok('英文表头：查不到回 null', headerEn('代号') === null)
  const enHead = COLS.map((c) => headerEn(colLabel(c)) || colLabel(c))
  const hEn = findHeader([enHead], COLS)
  ok('导回认英文表头', hEn && hEn.keys.join() === 'country,city,desig,lon,lat', hEn && hEn.keys.join())
  const hZh = findHeader([COLS.map((c) => colLabel(c))], COLS)
  ok('装了词典后中文表头照认', hZh && hZh.keys.join() === 'country,city,desig,lon,lat', hZh && hZh.keys.join())
  const recEn = sheetToRecords({ rows: [enHead, ['中国', '北京', 'BJ', 116.4, 39.9]] }, COLS)
  ok('英文表头往返取值', recEn.records && recEn.records[0].lon === '116.4' && recEn.records[0].lat === '39.9', JSON.stringify(recEn.records))
  setHeaderDict(null)
}

// ---- ⑥ 同名列：链路表发 / 收两侧（GSO 与 NGSO 的真字段表，照 StationGrid 的口径挂侧别）----
{
  const { setHeaderDict, headerEn } = await import('../../../src/shared/gridXlsx.js')
  const G = await import('../../../src/linkbudget/params.js')
  const N = await import('../../../src/ngso/ngsoParams.js')
  const GROUP = { tx: '发信站', rx: '收信站' }
  // 链路表的字段 = 发端组 + 收端组（配置级：不出「卫星」列）；NGSO 手动几何多出斜距列、仰角列改称「仰角」
  const linkFields = (P, manual) => [
    ...P.TX_FIELDS.filter((f) => f.key !== 'satelliteId').map((f) => ({ ...f, group: 'tx' })),
    ...P.RX_FIELDS.map((f) => ({ ...f, group: 'rx' }))
  ].filter((f) => !f.manualOnly || manual).map((f) => (manual && f.manualLabel ? { ...f, label: f.manualLabel } : f))
  // StationGrid 的口径：重名按全部字段算；导出只给同名列 groupLabel，导入给全
  const exportCols = (fields) => { const dup = sameNameKeys(fields); return fields.map((f) => ({ key: f.key, label: f.label, unit: f.unit, groupLabel: dup.has(f.key) ? GROUP[f.group] : '' })) }
  const importCols = (fields) => fields.map((f) => ({ key: f.key, label: f.label, unit: f.unit, alias: f.alias, groupLabel: GROUP[f.group] }))
  // 一行数据：发 / 收两侧的值刻意不同，导回来串了侧一眼就看得出
  const rowOf = (fields) => Object.fromEntries(fields.map((f, i) => [f.key, f.type === 'num' ? (f.group === 'rx' ? 200 + i : 100 + i) : (f.group === 'rx' ? '收' : '发') + f.key]))
  const roundTrip = async (fields, cols, label) => {
    const row = rowOf(fields)
    const sm2 = sheetModel({ name: '链路', cols, rows: [row] })
    const f2 = path.join(os.tmpdir(), 'satsim-gridxlsx-side-' + process.pid + '.xlsx')
    fs.writeFileSync(f2, Buffer.from(await buildGridWorkbook({ sheets: [sm2] })))
    const wb = await readGridWorkbook(f2)
    try { fs.unlinkSync(f2) } catch { /* ignore */ }
    const rec = sheetToRecords(pickSheet(wb.sheets, importCols(fields)), importCols(fields))
    const got = rec.records && rec.records[0]
    const want = cols.map((c) => c.key)
    const bad = want.filter((k) => !got || got[k] !== String(row[k]))
    ok(label, rec.records && rec.records.length === 1 && bad.length === 0, bad.length ? '对不上：' + bad.join(',') + ' ' + JSON.stringify(got) : '')
    return sm2
  }

  const gso = linkFields(G, false)
  const dup = sameNameKeys(gso)
  ok('同名列：发 / 收两侧七组同名（配置 / 位置 / 经纬度 / 海拔 / R0.01% / 可用度）',
    ['stationId', 'rxStationId', 'earthStationLocation', 'rxEarthStationLocation', 'longitude', 'rxLongitude', 'latitude', 'rxLatitude',
      'altitude', 'rxAltitude', 'rainRate', 'rxRainRate', 'uplinkAvailability', 'rxDownlinkAvailability'].every((k) => dup.has(k)), [...dup].join(','))
  ok('同名列：不重名的列不挂侧别（载波配置 / 卫星G/T / 卫星饱和 EIRP）', !dup.has('basebandId') && !dup.has('G_Ts') && !dup.has('rxEIRP'))
  ok('colLabel 带侧别', colLabel({ label: '经度', unit: '°E', groupLabel: '收信站' }) === '收信站·经度 (°E)', colLabel({ label: '经度', unit: '°E', groupLabel: '收信站' }))

  const smG = await roundTrip(gso, exportCols(gso), 'GSO 链路表导出 → 导入往返：发 / 收两侧每一列都对上（收信站一组不丢）')
  ok('导出表头：同名列带侧别、不重名的列原样',
    smG.header.includes('发信站·经度 (°E)') && smG.header.includes('收信站·经度 (°E)') && smG.header.includes('收信站·地球站配置')
    && smG.header.includes('载波配置') && smG.header.includes('卫星G/T (dB/K)') && !smG.header.includes('经度 (°E)'), smG.header.join('|'))

  // 藏掉发信站那一侧的经纬度，只导收信站：表头仍带侧别，导回来不会按次序落到发信站
  const onlyRx = exportCols(gso).filter((c) => c.key !== 'longitude' && c.key !== 'latitude')
  await roundTrip(gso, onlyRx, '只导出收信站一侧的经纬度（发信站经纬度列已隐藏）：导回仍落在收信站')
  // 列序被调过（收信站整组排到前面 —— 钉住的列提到最左也是这样）
  const exp = exportCols(gso)
  await roundTrip(gso, exp.filter((c) => /^rx/.test(c.key)).concat(exp.filter((c) => !/^rx/.test(c.key))), '收信站整组排在发信站前面：按侧别对，不按次序')

  // 老文件：表头没有侧别（改动前导出的就是这样）→ 按出现次序依次对到发、收两侧
  const plainCols = gso.map((f) => ({ key: f.key, label: f.label, unit: f.unit }))
  await roundTrip(gso, plainCols, '老文件（同名表头不带侧别）：按出现次序导回，收信站一组齐全')

  // 同一个侧别表头出现两次：只认第一格（后写的不许盖掉前面的值）
  const hd = findHeader([['收信站·经度 (°E)', '收信站·经度', '载波配置']], importCols(gso))
  ok('同一侧别表头重复两格：只认第一格', hd && hd.keys[0] === 'rxLongitude' && hd.keys[1] === null && hd.keys[2] === 'basebandId', hd && hd.keys.join(','))
  // 侧别写法与老写法混排：认得准的先占住，同名格再按次序落到还空着的那一侧
  const mix = findHeader([['经度', '发信站·经度', '纬度', '纬度']], importCols(gso))
  ok('侧别写法与老写法混排：不抢错', mix && mix.keys.join(',') === 'rxLongitude,longitude,latitude,rxLatitude', mix && mix.keys.join(','))
  // Excel 里间隔点被换成日文「・」也认得
  const kata = findHeader([['收信站・经度', '发信站・纬度']], importCols(gso))
  ok('日文间隔点「・」等同「·」', kata && kata.keys.join(',') === 'rxLongitude,latitude', kata && kata.keys.join(','))

  // NGSO：手动几何多出两侧的「斜距」、两侧的「仰角」，同样带侧别往返
  const ngso = linkFields(N, true)
  const dupN = sameNameKeys(ngso)
  ok('NGSO 手动几何：仰角 / 斜距也是同名列', ['minElevation', 'rxMinElevation', 'slantRange', 'rxSlantRange'].every((k) => dupN.has(k)), [...dupN].join(','))
  await roundTrip(ngso, exportCols(ngso), 'NGSO 链路表（手动几何）导出 → 导入往返：收信站最低仰角 / 斜距不丢')
  await roundTrip(linkFields(N, false), exportCols(linkFields(N, false)), 'NGSO 链路表（自动最差）导出 → 导入往返')

  // 别的表导来：链路表导出的文件导进再生式的发信站群 / 收信站群（各自只有一侧、列组是「地球站」）。
  // StationGrid 另把「表名·标签」登记成别名（tableAlias）——发信站表只收「发信站·…」那一侧，收信站表只收「收信站·…」
  {
    const R = await import('../../../src/regen/regenParams.js')
    const smX = sheetModel({ name: '链路', cols: exportCols(gso), rows: [rowOf(gso)] })
    const sideTable = (fields, tableLabel) => fields.map((f) => ({ key: f.key, label: f.label, unit: f.unit, groupLabel: '地球站',
      alias: [...(f.alias || []), colLabel({ label: f.label, groupLabel: tableLabel })] }))
    const txT = sideTable(R.TX_FIELDS, '发信站'), rxT = sideTable(R.RX_FIELDS, '收信站')
    const g = rowOf(gso)
    const recTx = sheetToRecords({ rows: [smX.header, ...smX.rows] }, txT).records[0]
    ok('链路表文件 → 再生式发信站群：收的是发信站那一侧', recTx && recTx.longitude === String(g.longitude) && recTx.latitude === String(g.latitude) && recTx.stationId === String(g.stationId),
      JSON.stringify(recTx))
    const recRx = sheetToRecords({ rows: [smX.header, ...smX.rows] }, rxT).records[0]
    ok('链路表文件 → 再生式收信站群：收的是收信站那一侧', recRx && recRx.rxLongitude === String(g.rxLongitude) && recRx.rxLatitude === String(g.rxLatitude) && recRx.stationId === String(g.rxStationId),
      JSON.stringify(recRx))
  }

  // 英文表头：侧别两段各查词典、用「 · 」拼回；导回中英两套都认（老的英文文件同名列按次序）
  setHeaderDict({ '发信站': 'Tx station', '收信站': 'Rx station', '经度': 'Longitude', '纬度': 'Latitude', '地球站配置': 'Earth Station Configuration', '可用度': 'Availability', '载波配置': 'Carrier Configuration' })
  ok('英文表头：侧别 + 标签 + 单位', headerEn('收信站·经度 (°E)') === 'Rx station · Longitude (°E)', headerEn('收信站·经度 (°E)'))
  ok('英文表头：标签不含汉字时原样', headerEn('收信站·R0.01% (mm/h)') === 'Rx station · R0.01% (mm/h)', headerEn('收信站·R0.01% (mm/h)'))
  ok('英文表头：前缀不是已知组名时整串查不到', headerEn('春分·天数') === null, String(headerEn('春分·天数')))
  const enRow = exportCols(gso).filter((c) => ['basebandId', 'stationId', 'longitude', 'rxStationId', 'rxLongitude', 'rxLatitude', 'rxDownlinkAvailability'].includes(c.key))
    .map((c) => headerEn(colLabel(c)) || colLabel(c))
  const hEn2 = findHeader([enRow], importCols(gso))
  ok('导回认英文侧别表头', hEn2 && hEn2.keys.join(',') === 'basebandId,stationId,longitude,rxStationId,rxLongitude,rxLatitude,rxDownlinkAvailability', enRow.join('|') + ' → ' + (hEn2 && hEn2.keys.join(',')))
  const hEnOld = findHeader([['Carrier Configuration', 'Longitude (°E)', 'Latitude (°N)', 'Longitude (°E)', 'Latitude (°N)']], importCols(gso))
  ok('老的英文文件（同名不带侧别）按次序', hEnOld && hEnOld.keys.join(',') === 'basebandId,longitude,latitude,rxLongitude,rxLatitude', hEnOld && hEnOld.keys.join(','))
  setHeaderDict(null)
}

try { fs.unlinkSync(tmp) } catch { /* 清理失败不影响判定 */ }

console.log(`gridXlsx: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
