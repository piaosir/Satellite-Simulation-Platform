// 总报告「逐参数对照」头两行（标准 / 调制编码）的口径（electron/services/report.js 的 enrichReportModel）：
//   标准     = 各窗从载波表单带来的 link.carrier.stds（端到端逐段一份），引擎不认识「标准」；
//   调制编码 = 引擎回显 modulationResult / fecResult（与详细预算「载波」段同源），3GPP 行前缀
//              MCS 序号（NR）/ I_TBS（NB-IoT），NB-IoT 用引擎现算的有效码率；
//   端到端逐段并列（同则写一次、缺段写「—」）；再生式激光整个不出这两行；单位自适应不碰文本行。
// 渲染端那半（shared/lbReport.js 的 carrierStdLabel / carrierIdentity）一并对拍。
// 另两段同在 lbReport.js 的报告口径（体检 #12 / #13）：
//   10. 输入清单 buildInputDigest：功放功率预设（GSO paPowerW / 再生式 opPowerW）进清单；对象字段不进；
//       门限模式与中文下拉值出显示名、英文版按 LB_REPORT_EN 翻；任意字段组都不出「[object Object]」与代码值；
//   11. 报告名称钉住 resolveReportTitle / pinReportTitle：只在当时那个自动名名下沿用，换了卫星就回到自动名。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ★ 路径走 fileURLToPath：项目目录名是中文，import.meta.url 里是 percent-encoded 的
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..').split(path.sep).join('/')
const require = createRequire(ROOT + '/package.json')
const report = require(ROOT + '/electron/services/report.js')
const { buildReportModel, labelBundle, carrierStdLabel, carrierIdentity, buildInputDigest, resolveReportTitle, pinReportTitle } = await import('file:///' + ROOT + '/src/shared/lbReport.js')

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
  // keys（2026-10-17）：同序的 dvbStandard 键，不随语言变 —— 方法学参考文献据它判用到了哪几份体制标准
  assert.deepEqual(carrierIdentity(null, opts, 'zh'), { stds: [], keys: [] })
  assert.deepEqual(carrierIdentity({ dvbStandard: 'DVB-S2X' }, opts, 'zh'), { stds: ['DVB-S2X'], keys: ['DVB-S2X'] })
  assert.deepEqual(carrierIdentity([{ dvbStandard: 'DVB-S2X' }, { dvbStandard: 'custom' }], opts, 'zh'), { stds: ['DVB-S2X', '自定义'], keys: ['DVB-S2X', 'custom'] })
}
// 10. 输入清单：显示名、对象字段、功放功率预设
{
  const G = await import('file:///' + ROOT + '/src/linkbudget/params.js')
  const RG = await import('file:///' + ROOT + '/src/regen/regenParams.js')
  const flat = (blocks) => blocks.flatMap((b) => b.rows.map((r) => Object.assign({ block: b.key }, r)))
  const row = (rows, label, block) => rows.find((r) => r.label === label && (!block || r.block === block))
  const params = {
    satParams: { satelliteName: 'CS10R', frequencyBand: 'Ku' },
    linkParams: {
      infoRate: '2048', modulation: 'QPSK', noiseRatioMode: 'snr', phy: { kind: 'nbiot', units: 12, nRep: 1 },
      uplinkPowerControl: '否', rxAntennaNoiseTempMode: '自动', antennaDiameter: '2.4', rxAntennaDiameter: '1.2', longitude: '116.4'
    },
    opt: { mode: 'power', powerW: 40 }
  }
  const zh = flat(buildInputDigest(G.FIELD_GROUPS, params, 'zh'))
  assert.ok(!zh.some((r) => /\[object /.test(r.value)), '不出「[object Object]」：' + JSON.stringify(zh.filter((r) => /object/.test(r.value))))
  assert.ok(!row(zh, '物理层参数'), '对象字段（3GPP 物理层描述子）不进清单')
  assert.equal(row(zh, '门限模式').value, 'SNR')
  assert.equal(row(zh, '功放功率预设', 'uplink').value, '40')
  assert.equal(row(zh, 'UPC', 'uplink').value, '否')
  assert.equal(row(zh, '天线口径', 'uplink').value, '2.4'); assert.equal(row(zh, '天线口径', 'downlink').value, '1.2')
  const en = flat(buildInputDigest(G.FIELD_GROUPS, params, 'en'))
  assert.equal(row(en, 'Threshold Mode').value, 'SNR')
  assert.equal(row(en, 'HPA Power (preset)', 'uplink').value, '40')
  assert.equal(row(en, 'UPC', 'uplink').value, 'No')
  assert.equal(row(en, 'Antenna Noise Temp. Mode', 'downlink').value, 'Auto')
  assert.equal(row(en, 'Frequency Band').value, 'Ku')
  // 门限模式另两档
  for (const [code, name] of [['ebno', 'Eb/N₀'], ['esno', 'Es/N₀']]) {
    const d = flat(buildInputDigest(G.FIELD_GROUPS, { linkParams: { noiseRatioMode: code } }, 'zh'))
    assert.equal(row(d, '门限模式').value, name, code)
  }
  // 再生式：功放功率预设叫 opPowerW；设置工作点（opt.powerW）才出，设置余量时功放是反解的，不出
  const ups = RG.FIELD_GROUPS.filter((g) => ['carrier', 'sat', 'station', 'uplink'].includes(g.key))
  const rg = flat(buildInputDigest(ups, { satParams: {}, linkParams: { noiseRatioMode: 'ebno' }, opt: { mode: 'power', powerW: 0.2 } }, 'zh'))
  assert.equal(row(rg, '功放功率预设', 'uplink').value, '0.2')
  assert.equal(row(rg, '门限模式').value, 'Eb/N₀')
  const rgM = flat(buildInputDigest(ups, { satParams: {}, linkParams: {}, opt: { mode: 'margin' } }, 'zh'))
  assert.ok(!row(rgM, '功放功率预设'), '设置余量：没有功放功率预设那一行')
  // 任意字段组：缺标题 / 缺字段表、混进 null 字段、布尔值、{ value, label } 选项、数组值
  const odd = buildInputDigest([
    { key: 'x', fields: [null, { key: 'flag', label: '开关' }, { key: 'pick', label: '档', type: 'select', options: [{ value: 'a', label: '自动' }] }, { key: 'arr', label: '列表' }] },
    { key: 'y' }
  ], { linkParams: { flag: true, pick: 'a', arr: [1, 2] } }, 'en')
  assert.equal(odd.length, 1); assert.equal(odd[0].title, '')
  assert.deepEqual(odd[0].rows.map((r) => r.value), ['Yes', 'Auto'], JSON.stringify(odd[0].rows))
}
// 11. 报告名称钉住
{
  // 老存档只有一对 { title, titleDefault }：自动名没变才沿用，变了就回到新的自动名
  assert.equal(resolveReportTitle({ title: 'A 项目报告', titleDefault: 'A 卫星链路预算报告' }, 'A 卫星链路预算报告'), 'A 项目报告')
  assert.equal(resolveReportTitle({ title: 'A 项目报告', titleDefault: 'A 卫星链路预算报告' }, 'B 卫星链路预算报告'), 'B 卫星链路预算报告')
  assert.equal(resolveReportTitle({ title: 'A 卫星链路预算报告', titleDefault: 'A 卫星链路预算报告' }, 'B 卫星链路预算报告'), 'B 卫星链路预算报告')
  assert.equal(resolveReportTitle({ title: 'A 项目报告' }, 'B 卫星链路预算报告'), 'B 卫星链路预算报告')
  assert.equal(resolveReportTitle(null, 'X'), 'X')
  // A 星钉过名，切到 B 星（没钉）再切回来：A 的名字还在，B 用自动名
  let st = pinReportTitle(null, 'A', 'A 项目')
  st = pinReportTitle(st, 'B', 'B')
  assert.equal(resolveReportTitle(st, 'B'), 'B')
  assert.equal(resolveReportTitle(JSON.parse(JSON.stringify(st)), 'A'), 'A 项目')
  // 改回自动名 / 清空 = 取消钉住
  assert.equal(resolveReportTitle(pinReportTitle(st, 'A', 'A'), 'A'), 'A')
  assert.equal(resolveReportTitle(pinReportTitle(st, 'A', '   '), 'A'), 'A')
  // title / titleDefault 两键照写（老版本读得懂）
  const s2 = pinReportTitle(null, 'A', 'A 项目')
  assert.equal(s2.title, 'A 项目'); assert.equal(s2.titleDefault, 'A')
  // 封顶 32 条，留最近的
  let big = null
  for (let i = 0; i < 40; i++) big = pinReportTitle(big, 'D' + i, 'T' + i)
  assert.equal(Object.keys(big.pins).length, 32)
  assert.equal(resolveReportTitle(big, 'D39'), 'T39'); assert.equal(resolveReportTitle(big, 'D0'), 'D0')
}
console.log('lbReportSummary: all passed')
