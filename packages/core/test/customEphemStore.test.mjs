// 自定义星历库对「星历点序列」（ephem）组的存取回归网：
//   electron/services/customSats.js（分组 / 元数据 / 导入分派 / 显隐配色 / 导出）
// + electron/services/ephemStore.js（采样表分文件存、LRU、删组删文件）
// 走 SATSIM_DATA_DIR 绕开 Electron userData，纯 Node 可跑。

import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const DATA = path.join(os.tmpdir(), 'satsim-ephemstore-test')
fs.rmSync(DATA, { recursive: true, force: true })
process.env.SATSIM_DATA_DIR = DATA

const core = require('../index.js')
const customSats = require('../../../electron/services/customSats.js')(() => core)
const ephemStore = require('../../../electron/services/ephemStore.js')
const ephF = require('../utils/ephemFormats.js')
const ephI = require('../utils/ephemInterp.js')
const OP = require('../utils/orbitPos.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（差 ' + Math.abs(a - b) + '，容差 ' + tol + '）')
const section = (t) => console.log('\n— ' + t)

const MU = 398600.4418, T0 = Date.UTC(2026, 8, 21)
function makeE(frame, R, incl, count, step) {
  const n = Math.sqrt(MU / (R * R * R)), ci = Math.cos(incl * Math.PI / 180), si = Math.sin(incl * Math.PI / 180)
  const L = ['stk.v.12.0', 'BEGIN Ephemeris', 'ScenarioEpoch 21 Sep 2026 00:00:00.000',
    'CoordinateSystem ' + frame, 'DistanceUnit Kilometers', 'InterpolationMethod Lagrange',
    'InterpolationSamplesM1 5', 'CentralBody Earth', 'EphemerisTimePosVel']
  for (let i = 0; i < count; i++) {
    const s = i * step, u = n * s
    L.push([s.toFixed(6), (R * Math.cos(u)).toFixed(9), (R * Math.sin(u) * ci).toFixed(9), (R * Math.sin(u) * si).toFixed(9),
      (-R * n * Math.sin(u)).toFixed(9), (R * n * Math.cos(u) * ci).toFixed(9), (R * n * Math.cos(u) * si).toFixed(9)].join(' '))
  }
  L.push('END Ephemeris', '')
  return L.join('\n')
}
const SAMPLE_TLE = '0 ISS (ZARYA)\n' +
  '1 25544U 98067A   26230.54791667  .00016717  00000-0  10270-3 0  9004\n' +
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391 56354\n'

/* ===== ① 导入分派：内容嗅探，不看扩展名 ===== */
section('导入分派')
const eText = makeE('J2000', 6878.137, 51.6, 61, 60)
const rE = customSats.importFile('轨道A', eText)
ok(rE.ok && rE.kind === 'ephem', '.e 走 ephem 分支', JSON.stringify(rE.error || ''))
ok(rE.group.format === 'stk-e' && rE.group.count === 1, '格式 stk-e、1 颗星', rE.group.format + '/' + rE.group.count)
const rG = customSats.importFile('ISS组', SAMPLE_TLE)
ok(rG.ok && rG.kind !== 'ephem', 'TLE 仍走 gp 分支（原通路一个字没变）')
ok(rG.group.count === 1 && rG.group.format === '3le', 'gp 组格式 3le', rG.group.format)

/* ===== ② 组清单：kind / visible / color / 时段 ===== */
section('组清单')
let L = customSats.list()
ok(L.groups.length === 2, '两个组', String(L.groups.length))
const gE = L.groups.find((g) => g.name === '轨道A'), gG = L.groups.find((g) => g.name === 'ISS组')
ok(gE.kind === 'ephem' && gG.kind === 'gp', 'kind 分得清', gE.kind + '/' + gG.kind)
ok(gE.visible === true && gE.color === '', '新组缺省可见、无配色')
ok(gE.t0 === T0 && gE.t1 === T0 + 3600000, 'ephem 组带出时段')
ok(gE.sats[0].n === 61 && gE.sats[0].frame === 'J2000', '星概览：61 点、原帧 J2000', gE.sats[0].n + '/' + gE.sats[0].frame)
ok(gE.sats[0].stepS === 60, '步长 60 s', String(gE.sats[0].stepS))
ok(gE.sats[0].interp.samples === 6, '插值 6 点')
ok(String(gE.sats[0].noradId) === '800000', '合成 NORAD 从 800000 起', String(gE.sats[0].noradId))
ok(gG.t0 === null, 'gp 组不给时段')

/* ===== ③ 采样表分文件存 ===== */
section('采样分文件')
const store = JSON.parse(fs.readFileSync(path.join(DATA, 'omm', 'custom.json'), 'utf8'))
const raw = JSON.stringify(store)
ok(raw.length < 4000, 'custom.json 只存元数据，没把采样塞进去（' + raw.length + ' 字节）')
ok(!/6878\.13700/.test(raw), 'custom.json 里找不到采样坐标')
ok(fs.existsSync(path.join(DATA, 'ephem', gE.id + '.json')), '采样另存 ephem/<组id>.json')
const file = JSON.parse(fs.readFileSync(path.join(DATA, 'ephem', gE.id + '.json'), 'utf8'))
ok(file.sats.length === 1 && file.sats[0].t.length === 61, '采样文件里 61 点', String(file.sats[0].t.length))
ok(file.sats[0].p.length === 183, '位置 3n 个数')

/* ===== ④ 取回：采样是 TEME，取位与解析真值一致 ===== */
section('取表与取位')
const tbl = customSats.ephemTable(gE.id)
ok(tbl && tbl.sats.length === 1, 'ephemTable 取回 1 颗')
ok(tbl.sats[0].t instanceof Float64Array && tbl.sats[0].p instanceof Float64Array, 'typed array 原样返回（供结构化克隆）')
ok(tbl.sats[0].frame === 'TEME' && tbl.sats[0].srcFrame === 'J2000', '表是 TEME，原帧记在 srcFrame')
const lk = customSats.ephemLookup(gE.id)
ok(lk && lk.__ephem, 'ephemLookup 给出可直接喂 orbitPos 的表')
const pv = OP.positionAt(lk, T0 + 1800000)
near(Math.hypot(pv.position.x, pv.position.y, pv.position.z), 6878.137, 1e-3, '取位落在轨道半径上')
ok(OP.positionAt(lk, T0 - 5000) === null, '时段外 null')
ok(customSats.ephemTable(gG.id) === null, 'gp 组没有采样表')
ok(customSats.ephemLookup('nope') === null, '不存在的组返回 null')

/* ===== ⑤ raw / rawVisible：只吐 gp 组 ===== */
section('扁平并集')
const r0 = customSats.raw()
ok(r0 && /25544/.test(r0.text), 'raw 里有 gp 组的星')
ok(!/800000/.test(r0.text), '★ raw 不吐 ephem 组（塞进 OMM CSV 只会得到 NaN）')
const rv = customSats.rawVisible()
ok(rv.groups.length === 1 && rv.groups[0].id === gG.id, 'rawVisible 只列 gp 组')
ok(rv.groupOf['25544'] === 'ci:' + gG.id, '归属表 NORAD -> ci:<组id>', rv.groupOf['25544'])
customSats.updateGroup(gG.id, { visible: false })
ok(customSats.rawVisible().text === '', '组隐藏后并集为空')
ok(customSats.raw() !== null, '隐藏不影响 raw（搜索池照旧看得到）')
customSats.updateGroup(gG.id, { visible: true, color: '#3b82f6' })
L = customSats.list()
ok(L.groups.find((g) => g.id === gG.id).color === '#3b82f6', '配色落库')
ok(L.groups.find((g) => g.id === gG.id).visible === true, '显隐落库')
ok(customSats.updateGroup('nope', { visible: true }).ok === false, '改不存在的组报错')

/* ===== ⑥ groupRecords 对 ephem 组返回 null ===== */
section('ephem 组不冒充 OMM 记录')
ok(customSats.groupRecords(gE.id) === null, '★ ephem 组的 groupRecords 返 null（小程序打包据此跳过）')
ok(Array.isArray(customSats.groupRecords(gG.id)), 'gp 组照常返记录数组')

/* ===== ⑦ 导出：重序列化原样本，回到原帧 ===== */
section('导出')
const outE = customSats.groupText(gE.id, 'stk-e')
ok(/CoordinateSystem\s+J2000/.test(outE), '★ 导出回到原帧 J2000（采样按 TEME 存，导出时换回来）')
const backE = ephF.parseEphemeris(outE)
const srcE = ephF.parseEphemeris(eText)
let dp = 0, dt = 0
for (let i = 0; i < 61; i++) {
  dt = Math.max(dt, Math.abs(backE.sats[0].t[i] - srcE.sats[0].t[i]))
  for (let c = 0; c < 3; c++) dp = Math.max(dp, Math.abs(backE.sats[0].p[3 * i + c] - srcE.sats[0].p[3 * i + c]))
}
ok(dt <= 0.001, '存取一轮后时间仍到 μs（差 ' + dt + ' ms）')
ok(dp <= 1e-9, '★ 存取一轮（换到 TEME 再换回来）位置仍到 1e-9 km（差 ' + dp + '）')
for (const fmt of ['ccsds-oem-kvn', 'ccsds-oem-xml']) {
  const txt = customSats.groupText(gE.id, fmt)
  ok(ephF.detectFormat(txt) === fmt, 'ephem 组导出 ' + fmt)
}
let threw = ''
try { customSats.groupText(gE.id, 'omm-csv') } catch (e) { threw = e.message }
ok(/只能导出成/.test(threw), 'ephem 组不许导出成 OMM/TLE（点名拒绝）', threw)
// gp 组导出成点序列：按 SGP4 采样
const gpE = customSats.groupText(gG.id, 'stk-e', { stepS: 300 })
ok(ephF.detectFormat(gpE) === 'stk-e', 'gp 组能导出成 .e')
const gpBack = ephF.parseEphemeris(gpE)
ok(gpBack.sats[0].t.length === 577, '缺省历元 ±1 天 / 300 s -> 577 点', String(gpBack.sats[0].t.length))
ok(/CoordinateSystem\s+TEMEOfDate/.test(gpE), '缺省帧 TEME')
const gpFixed = customSats.groupText(gG.id, 'stk-e', { stepS: 3600, frame: 'FIXED' })
ok(/CoordinateSystem\s+Fixed/.test(gpFixed), 'opts.frame 生效')
// 采样出来的点要与 SGP4 一致 —— 用【缺省 60 s】步长测。
// 300 s 对 ISS 这种 92 min 周期的星是 h·n = 0.34 rad，已过附录 C 的 0.3 rad 判据，
// 插值误差几十米是方法本身的量（建表时也确实给了「过粗」告警），不是导出链路有错。
const gpFine = ephF.parseEphemeris(customSats.groupText(gG.id, 'stk-e'))
const gpTab = ephI.buildTable(Object.assign({}, gpFine.sats[0], { interp: gpFine.sats[0].interp }))
ok(!gpTab.warnings.some((w) => /过粗/.test(w)), '60 s 步长不触发「过粗」告警')
const satrec = core.sgp4.omm2satrec(customSats.groupRecords(gG.id)[0])
let worst = 0
for (let k = 5; k < 2800; k += 137) {
  const ms = gpFine.sats[0].t[k] + 23000
  const a = core.sgp4.propagate(satrec, new Date(ms)), b = ephI.evalTable(gpTab, ms)
  if (a && a.position && b) worst = Math.max(worst, Math.hypot(a.position.x - b.x, a.position.y - b.y, a.position.z - b.z) * 1000)
}
ok(worst < 10, '导出采样 -> 回读插值 与 SGP4 差 < 10 m（实得 ' + worst.toFixed(3) + ' m）')
// 反过来：300 s 的粗采样必须自己报出来，别闷声给个坏表
const gpCoarse = ephI.buildTable(Object.assign({}, gpBack.sats[0], { interp: gpBack.sats[0].interp }))
ok(gpCoarse.warnings.some((w) => /过粗/.test(w)), '300 s 步长的 LEO 表带「过粗」告警', JSON.stringify(gpCoarse.warnings))

/* ===== ⑧ 同名替换与删组 ===== */
section('替换与删除')
const rE2 = customSats.importFile('轨道A', makeE('TEME', 7000, 45, 31, 120))
ok(rE2.ok && rE2.replaced === true, '同名替换')
L = customSats.list()
ok(L.groups.length === 2, '组数没变', String(L.groups.length))
const gE2 = L.groups.find((g) => g.name === '轨道A')
ok(gE2.id === gE.id && gE2.sats[0].n === 31, '同一个组 id、换了内容', gE2.id + '/' + gE2.sats[0].n)
ok(gE2.visible === true, '替换后保住显隐')
// ephem 组被同名的 gp 文件替换：采样文件要跟着删
const rSwap = customSats.importFile('轨道A', SAMPLE_TLE)
ok(rSwap.ok && rSwap.kind !== 'ephem', 'ephem 组被 gp 文件同名替换')
ok(!fs.existsSync(path.join(DATA, 'ephem', gE.id + '.json')), '★ 换种类后旧采样文件被删（不留孤儿）')
ok(customSats.list().groups.find((g) => g.name === '轨道A').kind === 'gp', '组种类改成 gp')
// 重新导入一个 ephem 组再删
const rE3 = customSats.importFile('轨道B', makeE('Fixed', 6900, 60, 41, 60))
const idB = rE3.group.id
ok(fs.existsSync(path.join(DATA, 'ephem', idB + '.json')), '新 ephem 组有采样文件')
customSats.removeGroup(idB)
ok(!fs.existsSync(path.join(DATA, 'ephem', idB + '.json')), '★ 删组连采样文件一起删')
ok(!customSats.list().groups.some((g) => g.id === idB), '组从清单里去掉')

/* ===== ⑨ 合成 NORAD 段位不重号 ===== */
section('合成 NORAD')
const a1 = customSats.importFile('段一', makeE('J2000', 7100, 30, 11, 60))
const a2 = customSats.importFile('段二', makeE('J2000', 7200, 30, 11, 60))
const gs = customSats.list().groups
const n1 = Number(gs.find((g) => g.name === '段一').sats[0].noradId)
const n2 = Number(gs.find((g) => g.name === '段二').sats[0].noradId)
ok(n1 >= 800000 && n2 >= 800000, '都在 800000 段', n1 + '/' + n2)
ok(Math.abs(n2 - n1) === 10000, '两组相隔一个 10000 的段位', String(n2 - n1))
ok(a1.ok && a2.ok, '两组都导入成功')

/* ===== ⑩ 坏件与校验 ===== */
section('坏件')
const badAll = customSats.importFile('坏的', 'stk.v.12.0\nBEGIN Ephemeris\nCoordinateSystem J2000\nEphemerisTimePosVel\n0 0 0 0 0 0 0\n60 0 0 0 0 0 0\nEND Ephemeris\n')
ok(!badAll.ok, '全是地心点 -> 整组无效，报错不落库', JSON.stringify(badAll))
const one = makeE('J2000', 6878.137, 51.6, 11, 60).split('\n')
one[12] = '300.000000 1.0 0.0 0.0 0.0 0.0 0.0'   // 一个掉进地心的点
const partial = customSats.importFile('部分坏', one.join('\n'))
ok(partial.ok && partial.dropped === 1, '单个坏样本剔除并计数', JSON.stringify(partial.dropped))
ok(customSats.list().groups.find((g) => g.name === '部分坏').sats[0].n === 10, '落库 10 点')
ok(!customSats.importFile('空的', '').ok, '空文件不落库')

/* ===== ⑪ 旧库补默认幂等 ===== */
section('旧库迁移')
const f = path.join(DATA, 'omm', 'custom.json')
const old = JSON.parse(fs.readFileSync(f, 'utf8'))
for (const g of old.groups) { delete g.kind; delete g.visible; delete g.color }
fs.writeFileSync(f, JSON.stringify(old))
const L1 = customSats.list()
ok(L1.groups.every((g) => g.kind === 'gp' && g.visible === true && g.color === ''), '旧组读回补默认值')
const beforeBytes = fs.readFileSync(f, 'utf8')
customSats.list(); customSats.list()
ok(fs.readFileSync(f, 'utf8') === beforeBytes, '★ 补默认是读时补，不写第二份（幂等）')

/* ===== ⑫ ephemStore 本身：LRU 与孤儿清理 ===== */
section('ephemStore')
ephemStore.clearCache()
const probe = 'probe' + Date.now().toString(36)
ephemStore.save(probe, [{ key: 'k1', t: [1, 2, 3], p: [1, 2, 3, 4, 5, 6, 7, 8, 9], v: null }])
ok(ephemStore.load(probe).sats[0].t.length === 3, '存了能取回')
ok(ephemStore.load(probe) === ephemStore.load(probe), '第二次取回走 LRU（同一个对象）')
ok(ephemStore.sat(probe, 'k1') !== null && ephemStore.sat(probe, 'nope') === null, '按 key 取星')
ok(ephemStore.sat(probe) !== null, '不给 key 取第一颗')
ok(ephemStore.remove(probe) === true, '删得掉')
ok(ephemStore.load(probe) === null, '删完取不到')
ok(ephemStore.remove(probe) === false, '删第二次返 false')
// 孤儿清理
ephemStore.save('orphan-x', [{ key: 'a', t: [1, 2], p: [1, 2, 3, 4, 5, 6], v: null }])
const keep = customSats.list().groups.filter((g) => g.kind === 'ephem').map((g) => g.id)
ok(ephemStore.sweep(keep) >= 1, 'sweep 清掉孤儿采样文件')
ok(ephemStore.listFiles().every((id) => keep.includes(id)), '剩下的都在组清单里')

/* ===== ⑬ 年历导入的 NORAD 反查（PRN → 内置 gps 组的编号） ===== */
// 年历里只有 PRN、没有 NORAD 编号。内置 gps 组的星名是 CelesTrak 体例「GPS BIIR-5  (PRN 22)」，
// 按名字里的 PRN 反查即可；查不到才给 9900xx 合成号。反查正则写错的话整批全落到合成号上 ——
// 合成号不参与计算，但这批星与编目、卫星组、SATCAT 全对不上号，用户看到的是「导进来的 GPS 星
// 都是陌生编号」。这里用随包的 gps 快照跑真反查。
section('年历 NORAD 反查')
{
  // 32 颗的 SEM 年历（PRN 1–32，真实体例：每颗 14 个数，三行各 3 个）
  const semAlmanacText = () => {
    const n = (v) => v.toExponential(14).toUpperCase()
    const L = ['32  CURRENT.ALM', ' 352 61440']
    for (let prn = 1; prn <= 32; prn++) {
      L.push('', String(prn), String(40 + prn), '0',
        [n(0.004 + prn * 1e-4), n((1 + (prn % 5) * 0.2) / 180), n(-2.5e-9)].join(' '),
        [n(5153.6 + prn * 0.01), n(((prn % 6) / 3) - 1), n(((prn % 7) / 3.5) - 1)].join(' '),
        [n(((prn % 11) / 5.5) - 1), n(0), n(0)].join(' '),
        '0', String(9 + (prn % 4)))
    }
    return L.join('\n') + '\n'
  }
  const zlib = require('node:zlib')
  const gpsCsv = zlib.gunzipSync(fs.readFileSync(path.join(import.meta.dirname, '../../../resources/omm/csv_gps.csv.gz'))).toString('utf8')
  fs.mkdirSync(path.join(DATA, 'omm'), { recursive: true })
  fs.writeFileSync(path.join(DATA, 'omm', 'csv_gps.csv'), gpsCsv)       // gpsPrnIndex 只读本机缓存
  const names = gpsCsv.split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(',')[0])
  ok(names.filter((n) => /PRN/.test(n)).length >= 30, '随包 gps 快照里带「(PRN nn)」的星 ≥ 30 颗', String(names.filter((n) => /PRN/.test(n)).length))

  const rAlm = customSats.importFile('GPS年历', semAlmanacText())
  ok(rAlm.ok && rAlm.group.count === 32, '年历导入 32 颗', JSON.stringify(rAlm.error || rAlm.group.count))
  const w = (rAlm.warnings || []).find((x) => /NORAD 反查/.test(x)) || ''
  const m = /NORAD 反查：(\d+) \/ (\d+)/.exec(w)
  ok(!!m, '带出反查命中读数', w)
  ok(m && Number(m[1]) >= 30, '★ 反查命中 ≥ 30 颗（正则丢了反斜杠的话是 0）', w)
  const almGroup = customSats.list().groups.find((g) => g.name === 'GPS年历')
  const synth = almGroup.sats.filter((s) => String(s.noradId).startsWith('99'))
  ok(synth.length <= 2, '落到 9900xx 合成号的不超过 2 颗', synth.map((s) => s.name + '=' + s.noradId).join(' '))
  const prn22 = almGroup.sats.find((s) => /PRN 22/.test(s.name))
  ok(prn22 && String(prn22.noradId) === '26407', 'PRN 22 反查到 NORAD 26407（随包快照里「GPS BIIR-5  (PRN 22)」那一行）',
    prn22 ? String(prn22.noradId) : '(没有 PRN 22)')
  customSats.removeGroup(almGroup.id)

  // 名字体例逐条：带「(PRN nn)」的命中、不带的（NAVSTAR 编号体例）不命中，也不能误伤
  const hdr = gpsCsv.split(/\r?\n/)[0]
  const row = (name, norad) => [name, '2000-040A', '2026-09-16T04:02:29.626080', '2.00558423', '.01181404',
    '54.8385', '211.5512', '303.8515', '151.4150', '0', 'U', String(norad), '999', '19177', '0', '.23E-6', '0'].join(',')
  fs.writeFileSync(path.join(DATA, 'omm', 'csv_gps.csv'),
    [hdr, row('GPS BIIR-2  (PRN 13)', 24876), row('NAVSTAR 43 (USA 132)', 20302)].join('\n') + '\n')
  const r2 = customSats.importFile('GPS年历2', semAlmanacText())
  ok(r2.ok, '第二次导入成功', JSON.stringify(r2.error || ''))
  const g2 = customSats.list().groups.find((g) => g.name === 'GPS年历2')
  const s13 = g2.sats.find((s) => /PRN 13/.test(s.name))
  ok(String(s13.noradId) === '24876', '「GPS BIIR-2  (PRN 13)」→ PRN 13 命中 24876（双空格也要认）', String(s13.noradId))
  ok(!g2.sats.some((s) => String(s.noradId) === '20302'), '「NAVSTAR 43 (USA 132)」不含 PRN，不参与反查（132 / 43 都不许被当成 PRN）',
    (g2.sats.find((s) => String(s.noradId) === '20302') || {}).name || '')
  ok(g2.sats.filter((s) => String(s.noradId).startsWith('99')).length === 31, '其余 31 颗落合成号',
    String(g2.sats.filter((s) => String(s.noradId).startsWith('99')).length))
  customSats.removeGroup(g2.id)
}

console.log('\ncustomEphemStore: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
