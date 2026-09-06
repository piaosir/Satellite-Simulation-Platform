// 独立《服务等级指标（SLA）》报告模型的不变式。运行：npm test
//
// 被测文件是渲染端 ESM（src/shared/lbSlaReport.js），故本测试也是 .mjs。
//
// 关键不变式：
//   ① kind:'sla' + hasSla 门控：一条条款都没勾 → hasSla 为假（主进程据此拒绝导出）；
//   ② definitions 只含【真出现过】的条款，且中英成对、无文字判定；
//   ③ refs 只列真用到的：月口径才有 P.841、有 DVB 链路才有 EN 302 307、有 NTN 才有 3GPP；
//   ④ scan.rows 带 comp（且月口径按 P.841 折算过）；
//   ⑤ sunOutage 只在给了的那条链路上出；
//   ⑥ 英文模型全文无汉字（渲染器不各带字典，翻不好这里就漏到文件里）。

const {
  buildSlaReportModel, slaReportTitle, slaDefinitions, slaRefs, slaExclusions
} = await import('../../../src/shared/lbSlaReport.js')
const {
  deriveSla, slaReportBlock, slaScanReportRows, DEFAULT_SLA_PARAMS, slaParamRows, worstMonthAvail
} = await import('../../../src/shared/lbSla.js')

const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const modeSolver = require('../utils/modeSolver.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps)
const HAN = /[一-鿿]/

console.log('=== SLA 报告模型 ===\n')

const RX_SH = { rxLatitude: 31.2304, rxLongitude: 121.4737 }
const geo = modeSolver.computeLinkMode({}, RX_SH, { mode: 'margin' })
const ctxOf = (sp) => ({
  orbitType: 'GEO', data: geo.data, ok: true, resolvedMargin: geo.resolvedMargin,
  params: { satParams: {}, linkParams: Object.assign({}, RX_SH), opt: { mode: 'margin' } },
  carrierForm: { dvbStandard: 'DVB-S2', fec: '3/4', ber: '7', m: '1' }, modcodRows: [],
  slaParams: sp
})
const TIERS = [98, 98.5, 99, 99.5, 99.7, 99.8, 99.9, 99.95, 99.99]
const fakeScan = {
  pin: { kind: 'pa', powerW: 2.476 },
  rows: TIERS.map((t, i) => ({
    tag: String(t), tier: t, up: t, dn: 100, ok: true,
    data: {
      linkmargin: 7 - i, powerUsageRatio: 12 + i, bandwidthUsageRatio: 4.9,
      uplinkRainAttenuation: 1 + i, downlinkRainAttenuationResult: 0.5 + i
    }
  })),
  clear: null, message: ''
}

const SUN = { vernal: { minutes: 29.98, days: 5, rows: [{ date: '2026-03-03', dateBJT: '2026-03-03', startUTC: '04:49:56', endUTC: '04:56:09', startBJT: '12:49:56', endBJT: '12:56:09', durationSec: 373, peakCNdeg: 12.3 }] }, autumnal: null }

function model(o) {
  o = o || {}
  const sp = Object.assign({}, DEFAULT_SLA_PARAMS, o.params || null)
  const d = deriveSla(Object.assign(ctxOf(sp), { scan: o.scan === undefined ? fakeScan : o.scan, sunOutage: o.sun || null }))
  return buildSlaReportModel({
    lang: o.lang || 'zh', adaptUnits: false, doc: o.doc || {}, appVersion: '1.4.3',
    orbitType: 'GEO', calc: { satelliteName: '中星 6D', frequencyBand: 'Ku' },
    slaParams: slaParamRows(sp, o.lang || 'zh'),
    monthly: sp.monthly,
    links: [{
      no: 1, rowId: 'r1', txName: '北京', rxName: '上海', ok: true, error: '',
      data: geo.data,
      carrierStd: o.std === undefined ? 'DVB-S2' : o.std,
      modcod: 'QPSK 3/4',
      sla: slaReportBlock(d, o.rowSla || {}, sp, o.lang || 'zh'),
      scan: slaScanReportRows(d),
      sunOutage: o.sun || null
    }]
  })
}

// —— ① 形状与门控 ——
const m = model()
ok('kind = sla、v = 1', m.kind === 'sla' && m.v === 1)
ok('hasSla 为真（有勾选的条款）', m.hasSla === true)
ok('标题走 slaReportTitle（不是链路预算报告那个名字）',
  m.doc.title === '中星 6D 卫星 Ku 频段服务等级指标（SLA）', m.doc.title)
ok('doc 带软件版本与生成时间', m.doc.appVersion === '1.4.3' && !!m.doc.generatedAt)
ok('用户填的标题不被默认名盖掉', model({ doc: { title: '甲方专用' } }).doc.title === '甲方专用')
{
  const d = deriveSla(ctxOf(DEFAULT_SLA_PARAMS))
  const none = { include: Object.fromEntries(d.order.map((k) => [k, false])) }
  ok('一条条款都没勾 → hasSla 为假（主进程据此拒绝导出）', model({ rowSla: none }).hasSla === false)
}
ok('标签束随模型带走（渲染器不各带字典）', m.t.slaDefs === '指标定义与考核口径' && m.t.slaMatrix === '服务等级指标总表')

// —— ② 条款定义 ——
const defKeys = m.definitions.map((d) => d.key)
const slaKeys = new Set(m.links[0].sla.rows.map((r) => String(r.key).split(':')[0]))
ok('definitions 只列真出现过的条款', defKeys.every((k) => slaKeys.has(k)), defKeys.join(','))
ok('每条定义都齐五栏（术语 / 定义 / 计算式 / 周期 / 依据）',
  m.definitions.every((d) => d.term && d.definition && d.formula && d.period && d.basis))
ok('术语名取条款表里那一个（同一个名字，不另起一套）',
  m.definitions.find((d) => d.key === 'sysAvail').term === '系统可用度')
ok('定义里没有文字判定', !/达标|合格|受限|满足|不满足|资源判定/.test(JSON.stringify(m.definitions)))
ok('可用度类的考核周期 = 年平均（缺省档）',
  m.definitions.find((d) => d.key === 'sysAvail').period === '年平均'
  && m.definitions.find((d) => d.key === 'outageMin').period === '年平均')
ok('丢包的考核口径是「可用时间内」（中断时段不计入）',
  m.definitions.find((d) => d.key === 'loss').period === '可用时间内')
const mMon = model({ params: { monthly: 1 } })
ok('月口径 → 定义里的周期改「最坏月」',
  mMon.definitions.find((d) => d.key === 'sysAvail').period === '最坏月' && mMon.monthly === true)
ok('免责事件的三条合同惯例条款只列名（不编数）',
  slaExclusions('zh').length === 3 && slaExclusions('zh')[0] === '经双方确认的计划维护'
  && !/\d/.test(slaExclusions('zh').join('')), slaExclusions('zh').join(' / '))

// —— ③ 引用标准 ——
const ids = (mm) => mm.refs.map((r) => r.id)
ok('传播那几项恒有', ['ITU-R P.618-14', 'ITU-R P.837-7', 'ITU-R P.838-3'].every((x) => ids(m).indexOf(x) > -1))
ok('可用度与差错性能的口径基准恒有（S.579 / S.1062）',
  ids(m).some((x) => /S\.579/.test(x)) && ids(m).some((x) => /S\.1062/.test(x)))
ok('月口径才列 P.841',
  ids(m).every((x) => !/P\.841/.test(x)) && ids(mMon).some((x) => /P\.841/.test(x)), ids(mMon).join(' | '))
ok('有 DVB 链路才列 EN 302 307',
  ids(m).some((x) => /EN 302 307/.test(x))
  && ids(model({ std: 'custom' })).every((x) => !/EN 302 307/.test(x)))
ok('有 NTN 链路才列 3GPP',
  ids(m).every((x) => !/3GPP/.test(x)) && ids(model({ std: '3GPP NTN NR' })).some((x) => /3GPP/.test(x)))
ok('每条引用都有编号 / 名称 / 用途三栏', m.refs.every((r) => r.id && r.title && r.use))

// —— ④ 档位表 ——
const sc = m.links[0].scan
ok('档位表带综合列（= 档位 × 设备因子）',
  sc && sc.rows.length === TIERS.length && near(sc.rows[0].comp, 98 * Math.pow(0.9999, 3), 1e-9),
  String(sc.rows[0].comp))
ok('档位表带中断列（年 525960 min）', near(sc.rows[0].outage, (100 - sc.rows[0].comp) / 100 * 525960, 1e-6))
ok('月口径：综合列先按 P.841 折算再乘设备因子',
  near(mMon.links[0].scan.rows[0].comp, worstMonthAvail(98) * Math.pow(0.9999, 3), 1e-9),
  String(mMon.links[0].scan.rows[0].comp))
ok('月口径：中断列按 43830 min',
  near(mMon.links[0].scan.rows[0].outage, (100 - mMon.links[0].scan.rows[0].comp) / 100 * 43830, 1e-6))
ok('档位表的数都是【数】（小数位由渲染器定）',
  sc.rows.every((r) => typeof r.tier === 'number' && typeof r.margin === 'number'))
ok('晴空样本不进档位表', sc.rows.every((r) => r.tier !== null))
ok('没扫过就没有档位表（没有就是没有）', model({ scan: null }).links[0].scan === null)
ok('工作点随表带走（渲染器的表头注）', sc.pin && sc.pin.kind === 'pa')

// —— ⑤ 日凌 ——
ok('没给日凌就没有那一段', m.links[0].sunOutage === null)
const mSun = model({ sun: SUN })
ok('给了日凌就带逐日窗口（UTC 与北京时两套）',
  mSun.links[0].sunOutage.vernal.rows[0].startUTC === '04:49:56'
  && mSun.links[0].sunOutage.vernal.rows[0].startBJT === '12:49:56')

// —— 逐链路摘要 ——
const sum = m.links[0].summary
ok('摘要带卫星 / 频段（缺省取 calc）', sum.satellite === '中星 6D' && sum.band === 'Ku')
ok('摘要带载波（速率 / MODCOD / 符号率 / 带宽）',
  near(sum.carrier.infoRate, parseFloat(geo.data.infoRateResult), 1e-9) && sum.carrier.modcod === 'QPSK 3/4'
  && sum.carrier.symbolRate > 0 && sum.carrier.bandwidth > 0)
ok('摘要带几何（仰角 / 斜距）', sum.geometry.elev > 0 && sum.geometry.slant > 0,
  `${sum.geometry.elev} / ${sum.geometry.slant}`)
ok('SLA 参数行已翻好随模型走',
  Array.isArray(m.slaParams) && m.slaParams.some((r) => r.label === '考核周期' && r.value === '年平均'))

// —— ⑥ 英文模型全文无汉字 ——
{
  const en = model({ lang: 'en', sun: SUN, params: { monthly: 1 } })
  const han = []
  const walk = (v, path) => {
    if (typeof v === 'string') { if (HAN.test(v)) han.push(path + '=' + v) ; return }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')) ; return }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], path + '.' + k) }
  }
  // 站名 / 卫星名是用户自命名的数据，不翻（同平台既定口径），故排除这几项
  // scheme 是描述子（label 恒中文，渲染器取 schemeText）；calc / doc 里是用户自命名的数据
  const skip = new Set(['calc', 'doc', 'scheme'])
  for (const k of Object.keys(en)) if (!skip.has(k)) walk(en[k], k)
  const bad = han.filter((s) => !/^links\[\d+\]\.(txName|rxName|summary\.satellite)/.test(s))
  ok('英文模型（定义 / 引用 / 标签 / 免责）全无汉字', bad.length === 0, bad.slice(0, 3).join(' | '))
  ok('英文标题', en.doc.title === '中星 6D Satellite Ku-Band Service Level Metrics (SLA)', en.doc.title)
  ok('英文定义与周期',
    en.definitions.find((d) => d.key === 'sysAvail').period === 'Worst month'
    && en.definitions.find((d) => d.key === 'loss').period === 'Within available time')
  ok('英文免责事件三条', slaExclusions('en').length === 3 && !HAN.test(slaExclusions('en').join('')))
  ok('体制名按 lang 翻好随模型走（scheme.label 恒中文，渲染器取 schemeText）',
    !HAN.test(en.schemeText) && HAN.test(m.schemeText), en.schemeText + ' | ' + m.schemeText)
}

// —— 报告名 ——
ok('端到端的报告名另走一句', slaReportTitle('', '', 'zh', 'E2E') === '端到端链路服务等级指标（SLA）')
ok('卫星名与频段都空时仍是一句完整的名字', slaReportTitle('', '', 'zh', 'GEO') === '卫星服务等级指标（SLA）',
  slaReportTitle('', '', 'zh', 'GEO'))

// —— 定义表按给定顺序、认不出的 key 直接跳过（不编一条定义出来）——
ok('认不出的条款 key 不编定义', slaDefinitions(['沒有這條'], {}, 'zh', 0).length === 0)
ok('slaRefs 不重复列同一份标准',
  (() => { const l = slaRefs('zh', { monthly: 1, hasDvb: true, hasNtn: true }).map((r) => r.id); return new Set(l).size === l.length })())

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
