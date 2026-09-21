// 验证主进程服务（存储 + 报告）在 Node 下可用。运行： node scripts/verify-services.js
// storage 通过 SATSIM_DATA_DIR 环境变量绕开 Electron userData，可纯 Node 验证。
const path = require('path')
const os = require('os')
const fs = require('fs')

process.env.SATSIM_DATA_DIR = path.join(os.tmpdir(), 'satsim-verify')
fs.rmSync(process.env.SATSIM_DATA_DIR, { recursive: true, force: true })

const storage = require('../electron/services/storage')
const report = require('../electron/services/report')
const core = require('../packages/core')

let pass = 0, fail = 0
const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); c ? pass++ : fail++ }

;(async () => {
  console.log('=== 主进程服务验证 ===\n')

  // 存储
  const rec = storage.addHistory({ name: '测试记录', frequencyBand: 'Ku' })
  ok('历史：新增带 id', !!rec.id)
  ok('历史：列表长度 1', storage.listHistory().length === 1)
  storage.saveConfig('geo', { name: 'GEO Ku 模板', params: { frequencyBand: 'Ku' } })
  ok('配置：已保存', storage.listConfigs('geo').length === 1)
  const s = storage.setSettings({ amapKey: 'demo-key' })
  ok('设置：持久化', s.amapKey === 'demo-key' && storage.getSettings().amapKey === 'demo-key')

  // 报告（基于真实计算结果）
  const data = core.calculateLinkBudget({ frequencyBand: 'Ku', satelliteName: 'DEMO' }, {}).data
  const payload = { results: data, params: { satelliteName: 'DEMO', frequencyBand: 'Ku' }, meta: { title: '链路预算报告(测试)' } }
  const w = await report.buildWord(payload)
  ok('Word：生成 Buffer > 2KB', w.length > 2048)
  const x = await report.buildExcel(payload)
  ok('Excel：生成 Buffer > 2KB', x.length > 2048)

  fs.writeFileSync(path.join(process.env.SATSIM_DATA_DIR, 'report.docx'), Buffer.from(w))
  fs.writeFileSync(path.join(process.env.SATSIM_DATA_DIR, 'report.xlsx'), Buffer.from(x))
  console.log('\n样例文档已写入：', process.env.SATSIM_DATA_DIR)

  /* ---- 自定义星历库：六格式导入 → 分组持久化 → 导出（同格式吐原文 / 跨格式规范重建）---- */
  console.log('\n--- 星历库（六种官方格式） ---')
  const eph = require('../packages/core/utils/ommFormats.js')
  const customSats = require('../electron/services/customSats')(() => core)
  const SAMPLE_TLE = '0 ISS (ZARYA)\n' +
    '1 25544U 98067A   26230.54791667  .00016717  00000-0  10270-3 0  9004\n' +
    '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391 56354\n'
  const srcOf = (fmt) => fmt === 'tle' ? SAMPLE_TLE.split('\n').slice(1).join('\n')
    : fmt === '3le' ? SAMPLE_TLE
      : eph.serializeEphemeris(eph.parseEphemeris(SAMPLE_TLE).records, fmt)

  // (1) 六种格式各导入一组，都要落库且格式识别正确
  const groupIds = {}
  for (const fmt of eph.FORMATS) {
    const r = customSats.importFile('组_' + fmt, srcOf(fmt))
    ok(`导入 ${fmt}：落库（${r.ok ? r.group.count + ' 颗' : r.error}）`, !!(r.ok && r.group.count === 1))
    if (r.ok) { groupIds[fmt] = r.group.id; ok(`导入 ${fmt}：格式识别为 ${r.group.format}`, r.group.format === fmt) }
  }

  // (2) 同格式导出 = 逐字节吐回导入原文（“与官方一致”的字节级那一档）
  for (const fmt of eph.FORMATS) {
    if (!groupIds[fmt]) continue
    ok(`导出 ${fmt}（同格式）：与导入原文逐字节相同`, customSats.groupText(groupIds[fmt], fmt) === srcOf(fmt))
  }

  // (3) 跨格式导出：一组转成其余五种，根数逐条一致（规范级那一档）
  const srcId = groupIds['omm-csv']
  if (srcId) {
    const ref = core.sgp4.omm2satrec(customSats.groupRecords(srcId)[0])
    const K = ['no', 'ecco', 'inclo', 'nodeo', 'argpo', 'mo', 'bstar', 'ndot', 'nddot']
    for (const fmt of eph.FORMATS) {
      if (fmt === 'omm-csv') continue
      const back = eph.parseEphemeris(customSats.groupText(srcId, fmt))
      const got = back.records.length ? core.sgp4.omm2satrec(back.records[0]) : null
      ok(`跨格式 omm-csv → ${fmt}：根数一致`,
        !!(got && K.every((k) => Math.abs(got[k] - ref[k]) <= Math.abs(ref[k]) * 1e-9 + 1e-15)))
    }
  }

  // (4) 官方快照整份走一遍（内置 stations 组）
  const zlib = require('zlib')
  const gzPath = path.join(__dirname, '../resources/omm/csv_stations.csv.gz')
  if (fs.existsSync(gzPath)) {
    const csvSnap = zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf8')
    const r2 = customSats.importFile('内置快照', csvSnap)
    ok(`导入官方 stations 快照（${r2.ok ? r2.group.count + ' 颗' : r2.error}）`, !!(r2.ok && r2.group.count > 5))
    ok('官方快照同格式导出：逐字节等同原文', customSats.groupText(r2.group.id, 'omm-csv') === csvSnap)
  }

  // (5) 组列表：format 归一到六格式 id，exact 标志如实反映“能否原样吐回”
  const listed = customSats.list().groups
  ok('组列表的 format 全部落在六格式内', listed.length > 0 && listed.every((g) => eph.FORMATS.includes(g.format)))
  ok('组列表带 exact 标志', listed.some((g) => g.exact === true))
  ok('gp 组的 kind 一律 gp', listed.every((g) => g.kind === 'gp'))

  /* ---- 星历点序列（ephem）：经主进程 importFile 落库 → list 含 kind → ephemTable 取回 → 导出再导入 ---- */
  console.log('\n--- 星历点序列（STK .e / CCSDS OEM） ---')
  const ephF = require('../packages/core/utils/ephemFormats.js')
  const ephI = require('../packages/core/utils/ephemInterp.js')
  const OP = require('../packages/core/utils/orbitPos.js')
  const MU = 398600.4418, T0 = Date.UTC(2026, 8, 21)
  const mkE = (frame, R, incl, count, step) => {
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
  const eSrc = mkE('J2000', 6878.137, 51.6, 61, 60)
  // 六种新格式：.e 与 OEM 的 KVN/XML 直接建件；SP3 / 年历在 §7 §8 接入后由各自测试覆盖
  const newFmts = []
  const e0 = ephF.parseEphemeris(eSrc)
  newFmts.push(['stk-e', eSrc])
  newFmts.push(['ccsds-oem-kvn', ephF.serializeEphemeris(e0.sats, 'ccsds-oem-kvn', { createdMs: T0 })])
  newFmts.push(['ccsds-oem-xml', ephF.serializeEphemeris(e0.sats, 'ccsds-oem-xml', { createdMs: T0 })])
  const ephIds = {}
  for (const [fmt, text] of newFmts) {
    const r = customSats.importFile('点序列_' + fmt, text)
    ok(`导入 ${fmt}：落库（${r.ok ? r.group.count + ' 颗' : r.error}）`, !!(r.ok && r.group.count === 1))
    if (!r.ok) continue
    ephIds[fmt] = r.group.id
    ok(`导入 ${fmt}：kind 为 ephem`, r.group.kind === 'ephem')
    ok(`导入 ${fmt}：格式识别为 ${r.group.format}`, r.group.format === fmt)
  }
  const ephListed = customSats.list().groups.filter((g) => g.kind === 'ephem')
  ok('组列表里三个点序列组各带起止时刻与点数', ephListed.length === 3 && ephListed.every((g) => g.t0 === T0 && g.sats[0].n === 61))
  ok('点序列组的合成 NORAD 都在 800000 段', ephListed.every((g) => Number(g.sats[0].noradId) >= 800000))
  ok('点序列组的 groupRecords 返 null（不冒充 OMM 记录）', ephListed.every((g) => customSats.groupRecords(g.id) === null))
  ok('raw() 不吐点序列组', !/80000\d/.test((customSats.raw() || { text: '' }).text))

  // ephemTable 取回 + 取位
  const tb = customSats.ephemTable(ephIds['stk-e'])
  ok('ephemTable 取回 typed array', !!(tb && tb.sats[0].t instanceof Float64Array && tb.sats[0].t.length === 61))
  const look = customSats.ephemLookup(ephIds['stk-e'])
  const pv = OP.positionAt(look, T0 + 1800000)
  ok('取位落在轨道半径上', !!pv && Math.abs(Math.hypot(pv.position.x, pv.position.y, pv.position.z) - 6878.137) < 1e-3)
  ok('时段外取位返 null（不外推）', OP.positionAt(look, T0 - 5000) === null)

  // 导出 → 再导入 → 与原件逐位一致
  for (const fmt of ['stk-e', 'ccsds-oem-kvn', 'ccsds-oem-xml']) {
    if (!ephIds[fmt]) continue
    const out = customSats.groupText(ephIds[fmt], fmt)
    const back = ephF.parseEphemeris(out)
    let dp = 0, dt = 0
    for (let i = 0; i < 61; i++) {
      dt = Math.max(dt, Math.abs(back.sats[0].t[i] - e0.sats[0].t[i]))
      for (let c = 0; c < 3; c++) dp = Math.max(dp, Math.abs(back.sats[0].p[3 * i + c] - e0.sats[0].p[3 * i + c]))
    }
    ok(`导出 ${fmt} → 再导入：时间到 μs、位置到 1e-9 km（dt=${dt} ms, dp=${dp} km）`, dt <= 0.001 && dp <= 1e-9)
    const r2 = customSats.importFile('回环_' + fmt, out)
    ok(`导出件能被主进程重新导入（${fmt}）`, !!(r2.ok && r2.group.count === 1 && r2.group.kind === 'ephem'))
  }

  // gp 组导出成 .e / OEM（SGP4 采样）
  if (srcId) {
    const gpE = customSats.groupText(srcId, 'stk-e', { stepS: 60 })
    ok('gp 组导出成 .e（SGP4 采样，缺省历元 ±1 天 / 60 s / TEME）', ephF.detectFormat(gpE) === 'stk-e' && /TEMEOfDate/.test(gpE))
    const gpBack = ephF.parseEphemeris(gpE)
    const ref = core.sgp4.omm2satrec(customSats.groupRecords(srcId)[0])
    const gpTab = ephI.buildTable(Object.assign({}, gpBack.sats[0], { interp: gpBack.sats[0].interp }))
    let worst = 0
    for (let k = 5; k < 2800; k += 211) {
      const ms = gpBack.sats[0].t[k] + 23000
      const a = core.sgp4.propagate(ref, new Date(ms)), b = ephI.evalTable(gpTab, ms)
      if (a && a.position && b) worst = Math.max(worst, Math.hypot(a.position.x - b.x, a.position.y - b.y, a.position.z - b.z) * 1000)
    }
    ok(`gp 组导出的采样回读后与 SGP4 差 ${worst.toFixed(2)} m（< 10 m）`, worst < 10)
  }

  // 显隐 / 配色落库；删组连采样文件一起删
  const anyEph = ephListed[0]
  customSats.updateGroup(anyEph.id, { visible: false, color: '#3b82f6' })
  const after = customSats.list().groups.find((g) => g.id === anyEph.id)
  ok('显隐 / 配色落库', after.visible === false && after.color === '#3b82f6')
  const ephemStore = require('../electron/services/ephemStore')
  ok('删组前采样文件在', fs.existsSync(ephemStore.fileOf(anyEph.id)))
  customSats.removeGroup(anyEph.id)
  ok('删组后采样文件也没了（不留孤儿）', !fs.existsSync(ephemStore.fileOf(anyEph.id)))

  console.log(`\n=== ${pass} passed, ${fail} failed ===`)
  process.exit(fail ? 1 : 0)
})()
