// 总报告「逐参数对照」头两行（标准 / 调制编码）的口径（electron/services/report.js 的 enrichReportModel）：
//   标准     = 各窗从载波表单带来的 link.carrier.stds（端到端逐段一份），引擎不认识「标准」；
//   调制编码 = 引擎回显 modulationResult / fecResult（与详细预算「载波」段同源），3GPP 行前缀
//              MCS 序号（NR）/ I_TBS（NB-IoT），NB-IoT 用引擎现算的有效码率；
//   端到端逐段并列（同则写一次、缺段写「—」）；再生式激光整个不出这两行；单位自适应不碰文本行。
// 渲染端那半（shared/lbReport.js 的 carrierStdLabel / carrierIdentity）一并对拍。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ★ 路径走 fileURLToPath：项目目录名是中文，import.meta.url 里是 percent-encoded 的
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..').split(path.sep).join('/')
const require = createRequire(ROOT + '/package.json')
const report = require(ROOT + '/electron/services/report.js')
const { buildReportModel, labelBundle, carrierStdLabel, carrierIdentity } = await import('file:///' + ROOT + '/src/shared/lbReport.js')

function metricsOf(orbitType, regenMode, links, lang = 'zh', extra = {}) {
  const model = buildReportModel(Object.assign({ lang, orbitType, regenMode, links }, extra))
  model.t = labelBundle(lang)
  report.enrichReportModel(model)
  return model.summary.metrics
}
const L = (no, data, carrier) => ({ no, rowId: 'r' + no, txName: 'T' + no, rxName: 'R' + no, ok: !!data, error: data ? '' : 'x', data, carrier })

// 1. GSO / DVB：头两行在最前，原来的第一行退到第三
{
  const m = metricsOf('GEO', 'uplink', [
    L(1, { modulationResult: 'QPSK', fecResult: '3/4', linkmargin: '2.49' }, { stds: ['DVB-S2X'] }),
    L(2, { modulationResult: '8PSK', fecResult: '2/3' }, { stds: ['自定义'] })
  ])
  assert.equal(m[0].label, '标准'); assert.deepEqual(m[0].values, ['DVB-S2X', '自定义'])
  assert.equal(m[1].label, '调制编码'); assert.deepEqual(m[1].values, ['QPSK 3/4', '8PSK 2/3'])
  assert.equal(m[2].label, '功放建议 (W)')
}
// 2. 英文标签；NGSO 同列
{
  const m = metricsOf('NGSO', 'uplink', [L(1, { modulationResult: '16APSK', fecResult: '5/6' }, { stds: ['DVB-S2X'] })], 'en')
  assert.equal(m[0].label, 'Standard'); assert.equal(m[1].label, 'MODCOD')
  assert.deepEqual(m[1].values, ['16APSK 5/6'])
}
// 3. 3GPP NR：只留 MCS 序号（表名已在「标准」行）+ 表里的 R；英文取 phyMcsEnResult
{
  const d = { phyKindResult: 'nr', modulationResult: 'QPSK', fecResult: '379/1024', phyMcsResult: '表1 · MCS 7', phyMcsEnResult: 'T1 · MCS 7', phyCodeRateResult: '' }
  assert.deepEqual(metricsOf('GEO', 'uplink', [L(1, d, { stds: ['3GPP NR-NTN · MCS 表 1（64QAM）'] })])[1].values, ['MCS 7 · QPSK 379/1024'])
  assert.deepEqual(metricsOf('GEO', 'uplink', [L(1, d, { stds: ['3GPP NR-NTN'] })], 'en')[1].values, ['MCS 7 · QPSK 379/1024'])
}
// 4. NB-IoT：I_TBS 前缀 + 引擎现算的有效码率（不是表里 I_SF/I_RU = 0 那一格）
{
  const d = { phyKindResult: 'nbiot', modulationResult: 'QPSK', fecResult: '40/304', phyMcsResult: '4', phyMcsEnResult: '4', phyCodeRateResult: '0.3421' }
  assert.deepEqual(metricsOf('GEO', 'uplink', [L(1, d, { stds: ['3GPP NB-IoT NTN · NPDSCH'] })])[1].values, ['I_TBS 4 · QPSK 0.3421'])
}
// 5. 算失败 / 没带载波身份：两格都是「—」；只缺调制回显也是「—」
{
  const m = metricsOf('GEO', 'uplink', [L(1, null, null), L(2, { linkmargin: '1.00' }, { stds: [] })])
  assert.deepEqual(m[0].values, ['—', '—']); assert.deepEqual(m[1].values, ['—', '—'])
}
// 6. 端到端逐段：不同按段序并列、相同写一次、没回显的段写「—」
{
  const m = metricsOf('E2E', 'uplink', [
    L(1, { carriers: [{ modulationResult: 'QPSK', fecResult: '3/4' }, { modulationResult: '8PSK', fecResult: '2/3' }] }, { stds: ['DVB-S2', 'DVB-S2X'] }),
    L(2, { carriers: [{ modulationResult: 'QPSK', fecResult: '3/4' }, { modulationResult: 'QPSK', fecResult: '3/4' }] }, { stds: ['DVB-S2', 'DVB-S2'] }),
    L(3, { carriers: [{ modulationResult: 'QPSK', fecResult: '3/4' }, {}] }, { stds: ['DVB-S2'] })
  ])
  assert.equal(m[0].label, '标准'); assert.deepEqual(m[0].values, ['DVB-S2 / DVB-S2X', 'DVB-S2', 'DVB-S2'])
  assert.deepEqual(m[1].values, ['QPSK 3/4 / 8PSK 2/3', 'QPSK 3/4', 'QPSK 3/4 / —'])
  assert.equal(m[2].label, '节点数')
}
// 7. 再生式：上行 / 下行 / 星间微波有这两行，星间激光没有
{
  for (const mode of ['uplink', 'downlink', 'isl']) {
    const m = metricsOf('REGEN', mode, [L(1, { modulationResult: 'QPSK', fecResult: '1/2' }, { stds: ['DVB-S2'] })])
    assert.equal(m[0].label, '标准', mode); assert.deepEqual(m[1].values, ['QPSK 1/2'], mode)
  }
  const m = metricsOf('REGEN', 'laser', [L(1, { laserDistResult: '4000' }, { stds: ['DVB-S2'] })])
  assert.ok(!m.some((r) => r.label === '标准' || r.label === '调制编码'))
  assert.equal(m[0].label, '星间距离 (km)')
}
// 8. 单位自适应开着也不碰文本行（adaptSummaryUnits 只认带「(单位)」尾巴的数值行）
{
  const m = metricsOf('GEO', 'uplink', [L(1, { modulationResult: 'QPSK', fecResult: '3/4', allocBandwidthResult: '36000' }, { stds: ['DVB-S2X'] })], 'zh', { adaptUnits: true })
  assert.deepEqual(m[0].values, ['DVB-S2X']); assert.deepEqual(m[1].values, ['QPSK 3/4'])
  assert.equal(m[0].label, '标准'); assert.equal(m[1].label, '调制编码')
}
// 9. 渲染端：标准名解析（内置键 / 中文注名 / 自建标准按库里的名 / 悬空键原样 / 没套标准报「自定义」）
{
  const opts = { dvbStandards: [
    { value: 'custom', label: '自定义' }, { value: 'DVB-S2X', label: 'DVB-S2X' },
    { value: '3GPP NR-NTN', label: '3GPP NR-NTN · MCS 表 1（64QAM）' }, { value: 'usr:3', label: '厂家 X 表' }
  ] }
  assert.equal(carrierStdLabel({ dvbStandard: 'custom' }, opts, 'zh'), '自定义')
  assert.equal(carrierStdLabel({ dvbStandard: 'custom' }, opts, 'en'), 'Custom')
  assert.equal(carrierStdLabel({}, null, 'zh'), '自定义')
  assert.equal(carrierStdLabel(null, opts, 'zh'), '自定义')
  assert.equal(carrierStdLabel({ dvbStandard: 'DVB-S2X' }, opts, 'zh'), 'DVB-S2X')
  assert.equal(carrierStdLabel({ dvbStandard: '3GPP NR-NTN' }, opts, 'zh'), '3GPP NR-NTN · MCS 表 1（64QAM）')
  assert.equal(carrierStdLabel({ dvbStandard: '3GPP NR-NTN' }, opts, 'en'), '3GPP NR-NTN')
  assert.equal(carrierStdLabel({ dvbStandard: 'usr:3' }, opts, 'en'), '厂家 X 表')
  assert.equal(carrierStdLabel({ dvbStandard: 'usr:9' }, opts, 'zh'), 'usr:9')
  assert.equal(carrierStdLabel({ dvbStandard: 'DVB-S' }, {}, 'zh'), 'DVB-S')
  assert.deepEqual(carrierIdentity(null, opts, 'zh'), { stds: [] })
  assert.deepEqual(carrierIdentity({ dvbStandard: 'DVB-S2X' }, opts, 'zh'), { stds: ['DVB-S2X'] })
  assert.deepEqual(carrierIdentity([{ dvbStandard: 'DVB-S2X' }, { dvbStandard: 'custom' }], opts, 'zh'), { stds: ['DVB-S2X', '自定义'] })
}
console.log('lbReportSummary: all passed')
