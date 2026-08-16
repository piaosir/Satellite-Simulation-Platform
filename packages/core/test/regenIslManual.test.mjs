// 再生式星间链路「手动几何」口径自测 —— 不选卫星 + 直接给星间链路距离。
// 运行：node packages/core/test/regenIslManual.test.mjs
//
// 为什么要它：手动几何下不解算轨道，就没有互视统计。而 ISL 的链路预算是借 NGSO 弯管引擎跑的，
// 上/下行那一堆占位入参会顺带算出一个雨衰可用度（实测 99.8%）——它与这条星间链路毫无关系，
// 一旦漏进结果列就是凭空捏造的可用度。激光侧的坑镜像存在：visPct 缺省会当成 100%。
// 本测试钉死三件事：① 手动距离算得出余量且 FSL 与闭式一致；② 没给可见度就一个可用度字段都不许有；
// ③ 给了可见度仍照旧回填（不许把自动最差那条路一起改坏）。
import { createRequire } from 'node:module'
import path from 'node:path'
import url from 'node:url'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(import.meta.url)
const { computeRegenIslMode, computeRegenLaserIslMode } = require(path.join(ROOT, 'packages/core/utils/linkCalculatorRegen.js'))
const { buildRegenIslParams, buildRegenLaserParams, defaultsFor, ISL_FIELDS, LASER_FIELDS, CARRIER_FIELDS } =
  await import(url.pathToFileURL(path.join(ROOT, 'src/regen/regenParams.js')).href)

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const AVAIL_KEYS = ['systemAvailabilityResult', 'uplinkAvailabilityResult', 'downlinkAvailabilityResult', 'interruptionMinutes', 'interruptionHours']
const blank = (d) => AVAIL_KEYS.every((k) => d[k] === '' || d[k] === undefined || d[k] === null)

console.log('=== 再生式星间（微波）：手动几何 ===\n')

const DIST = 2000
const carrier = defaultsFor(CARRIER_FIELDS)
const link = { ...defaultsFor(ISL_FIELDS), islRangeKm: String(DIST) }
// txSatForm 传 null：手动几何不选卫星，链路表上根本没有那两列
const { satParams, linkParams } = buildRegenIslParams(null, carrier, link)
satParams.islHopDistance = DIST
const r = computeRegenIslMode(satParams, linkParams, { visibilityPct: null })
ok('不选卫星也算得出（txSatForm 为空不炸）', r && r.success === true, (r && r.message) || '')
const d = r.data || {}

// FSL 闭式对账：20lg(d_km) + 20lg(f_GHz) + 92.44778
const fGHz = parseFloat(link.islFreq)
const fslRef = 20 * Math.log10(DIST) + 20 * Math.log10(fGHz) + 20 * Math.log10(4 * Math.PI * 1e9 / 299792458 * 1000)
ok('自由空间损耗与闭式一致', Math.abs(parseFloat(d.islRfFslResult) - fslRef) < 0.01,
  `${d.islRfFslResult} vs ${fslRef.toFixed(2)}`)
ok('星间距离照用户给的那个数', Math.abs(parseFloat(d.islRfDistResult) - DIST) < 1e-9, d.islRfDistResult)
ok('合计 C/N = 星间单跳 C/N', d.carrierTotalCN === d.islPerHopCNResult, `${d.carrierTotalCN} / ${d.islPerHopCNResult}`)
ok('余量 = 单跳 C/N − 门限',
  Math.abs(parseFloat(d.linkmargin) - (parseFloat(d.islPerHopCNResult) - parseFloat(d.thresholdCN))) < 0.011,
  `${d.linkmargin} = ${d.islPerHopCNResult} − ${d.thresholdCN}`)
ok('★ 没给互视可见度 → 可用度字段一律留空（不许漏出占位入参的雨衰可用度）', blank(d),
  AVAIL_KEYS.map((k) => `${k}=${JSON.stringify(d[k])}`).join(' '))

// 自动最差那条路不受影响：给了可见度照旧回填
const r2 = computeRegenIslMode(satParams, linkParams, { visibilityPct: 87.5 })
const d2 = r2.data || {}
ok('给了可见度仍照旧回填可用度', Math.abs(parseFloat(d2.systemAvailabilityResult) - 87.5) < 1e-6, d2.systemAvailabilityResult)
ok('年中断随可用度算出', parseFloat(d2.interruptionMinutes) > 0, d2.interruptionMinutes)
ok('两次调用的余量相同（可用度不参与预算）', d2.linkmargin === d.linkmargin, `${d2.linkmargin} / ${d.linkmargin}`)

console.log('\n=== 再生式星间（激光）：手动几何 ===\n')

const lLink = { ...defaultsFor(LASER_FIELDS), islRangeKm: String(DIST) }
const lp = buildRegenLaserParams(null, lLink)
lp.islHopDistance = DIST
const rl = computeRegenLaserIslMode(lp, { visibilityPct: null, rangeRateKmS: null })
ok('不选卫星也算得出', rl && rl.success === true, (rl && rl.message) || '')
const dl = rl.data || {}
ok('星间距离照用户给的那个数', Math.abs(parseFloat(dl.laserDistResult) - DIST) < 1e-9, dl.laserDistResult)
ok('余量 = P_rx − P_req',
  Math.abs(parseFloat(dl.linkmargin) - (parseFloat(dl.laserPrxResult) - parseFloat(dl.laserPreqResult))) < 0.011,
  `${dl.linkmargin} = ${dl.laserPrxResult} − ${dl.laserPreqResult}`)
ok('★ 没给互视可见度 → 可用度字段一律留空（不许缺省成 100%）', blank(dl),
  AVAIL_KEYS.map((k) => `${k}=${JSON.stringify(dl[k])}`).join(' '))
ok('互视占比字段也留空', dl.laserVisibleFracResult === '')
ok('多普勒没有距离变化率就留空', dl.laserDopplerResult === '')

const rl2 = computeRegenLaserIslMode(lp, { visibilityPct: 62.5, rangeRateKmS: 3.2 })
const dl2 = rl2.data || {}
ok('给了可见度仍照旧回填可用度', Math.abs(parseFloat(dl2.systemAvailabilityResult) - 62.5) < 1e-6, dl2.systemAvailabilityResult)
ok('两次调用的余量相同（可用度不参与预算）', dl2.linkmargin === dl.linkmargin, `${dl2.linkmargin} / ${dl.linkmargin}`)

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
