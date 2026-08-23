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

  console.log(`\n=== ${pass} passed, ${fail} failed ===`)
  process.exit(fail ? 1 : 0)
})()
