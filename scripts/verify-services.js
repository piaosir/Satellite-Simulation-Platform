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
  storage.saveConfig({ name: 'GEO Ku 模板', params: { frequencyBand: 'Ku' } })
  ok('配置：已保存', storage.listConfigs().length === 1)
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

  console.log(`\n=== ${pass} passed, ${fail} failed ===`)
  process.exit(fail ? 1 : 0)
})()
