// SLA 可用度档位扫描（core/utils/linkSweep.js 的 scanSlaTiers）自测。运行：npm test
//
// 关键不变式：
//   ① 工作点恒定钉在当前链路上（与地理场图同口径）：pin.powerW = 设计点解出的功放瓦数，逐档不变；
//   ② 余量随档位单调不增（可用度越高 → 要扛的雨衰越大 → 余量越小），晴空档余量最大；
//   ③ 每个样本的上下行之积 = 该档（比例缩放守住工程师配的上下行分配）；
//   ④ 单侧体制只写该侧那一个键（regen-up 不碰下行入参，否则口径悄悄变成另一件事）；
//   ⑤ 端到端按 k 缩放地球站节点可用度后，系统可用度恰为该档；
//   ⑥ 算不出的样本 ok:false 且整批不抛（负仰角、参数缺失都不许把整次扫描带崩）；
//   ⑦ 晴空样本不进 rows（它只喂 MIR），单独走 clear；
//   ⑧ link:slaScanBatch 逐条 try/catch 隔离（源码级不变式，同 flatExportCompat 的做法）。

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..')
const { scanSlaTiers } = require('../utils/linkSweep.js')
const modeSolver = require('../utils/modeSolver.js')
const geoEngine = require('../utils/linkCalculator.js')
const { AVAIL_TIERS, slaSamplesFor, slaChainSamplesFor, splitUnavailability, solveChainK } =
  await import('../../../src/shared/lbSla.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps) => Math.abs(a - b) <= eps

console.log('=== SLA 档位扫描 ===\n')

// —— ①②③⑦ GSO 算例 ——
// 用有雨的一组入参：出厂默认降雨率为 0，各档雨衰恒 0、余量恒等，单调性那几条会退化成空转。
// 可用度显式给 99.9（2026-09-16 起引擎缺省改 100%＝晴天：两侧 100% 时 splitUnavailability 无解、slaSamplesFor 出 0 样本）
const GEO_LP = { rainRate: '40', rxRainRate: '60', uplinkAvailability: '99.9', rxDownlinkAvailability: '99.9' }
const base = modeSolver.computeLinkMode({}, GEO_LP, { mode: 'margin' })
ok('GSO 算例可算', !!(base && base.success))
const up0 = parseFloat(base.data.uplinkAvailabilityResult), dn0 = parseFloat(base.data.downlinkAvailabilityResult)
const samples = slaSamplesFor({ up: up0, dn: dn0 })
ok('样本 = 9 档 + 晴空', samples.length === AVAIL_TIERS.length + 1, String(samples.length))

const t0 = Date.now()
const scan = scanSlaTiers({ engine: 'geo', satParams: {}, linkParams: GEO_LP, opt: { mode: 'margin' }, samples })
const ms = Date.now() - t0
ok('10 个样本 < 200 ms', ms < 200, ms + ' ms')
ok('晴空样本不进 rows、单独走 clear', scan.rows.length === AVAIL_TIERS.length && !!scan.clear && scan.clear.tag === 'clear')
ok('全部样本算得出', scan.rows.every((r) => r.ok) && scan.clear.ok)

// ① 钉住工作点：pin.powerW = 设计点解出的功放瓦数。
// ★ 对拍的设计点必须【也开着出参小数位增量】：_pinnedOpt 是在 _precise 里解的（见其头注——
//   功放瓦数按 toFixed(3) 出，取整后再喂回去会把基准格的余量带偏零点几 dB），
//   拿屏幕上那个三位小数的显示值去比，永远差在第四位上。
const paDesign = (() => {
  const prev = geoEngine.setOutputPrecisionBoost(4)
  try { return parseFloat(modeSolver.computeLinkMode({}, GEO_LP, { mode: 'margin' }).data.paRecommendation) }
  finally { geoEngine.setOutputPrecisionBoost(prev) }
})()
ok('pin.kind = pa（发信站功放是自由变量）', scan.pin && scan.pin.kind === 'pa', scan.pin && scan.pin.kind)
ok('pin.powerW = 设计点 paRecommendation（±1e-6 W）',
  near(scan.pin.powerW, paDesign, 1e-6), `${scan.pin.powerW} vs ${paDesign}`)
ok('增量只在扫描期内生效，用完复位（屏上仍是三位小数）',
  modeSolver.computeLinkMode({}, GEO_LP, { mode: 'margin' }).data.paRecommendation.split('.')[1].length === 3)
// 扫描期开了出参小数位增量，故逐档解出的功放与钉住那台一致（在显示精度内）
ok('逐档功放不变（工作点真被钉住了）',
  scan.rows.every((r) => near(r.data.paRecommendation, scan.pin.powerW, 1e-3)),
  scan.rows.map((r) => r.data.paRecommendation).join(' / '))

// ③ 每个样本的上下行之积 = 该档
const prodBad = scan.rows.filter((r) => !near(r.up * r.dn / 100, r.tier, 1e-6))
ok('每样本 up·dn/100 = 档位（±1e-6）', prodBad.length === 0,
  prodBad.map((r) => `${r.tier}: ${(r.up * r.dn / 100).toFixed(8)}`).join('；'))
// 比例守恒：两侧不可用度之比在各档一致
const ratio0 = (100 - scan.rows[0].up) / (100 - scan.rows[0].dn)
ok('各档上下行不可用度之比守恒（工程师配的分配没被抹平）',
  scan.rows.every((r) => near((100 - r.up) / (100 - r.dn), ratio0, 1e-9)))

// ② 余量单调不增 + 雨衰单调不减
let mono = true, rainMono = true
for (let i = 1; i < scan.rows.length; i++) {
  if (scan.rows[i].data.linkmargin > scan.rows[i - 1].data.linkmargin + 1e-9) mono = false
  if (scan.rows[i].data.uplinkRainAttenuation < scan.rows[i - 1].data.uplinkRainAttenuation - 1e-9) rainMono = false
}
ok('余量随档位单调不增', mono, scan.rows.map((r) => r.data.linkmargin.toFixed(2)).join(' / '))
ok('上行雨衰随档位单调不减', rainMono, scan.rows.map((r) => r.data.uplinkRainAttenuation.toFixed(2)).join(' / '))
const designRow = scan.rows.find((r) => r.tier === 99.8)
ok('晴空余量 ≥ 设计点余量', scan.clear.data.linkmargin >= designRow.data.linkmargin,
  `${scan.clear.data.linkmargin.toFixed(2)} ≥ ${designRow.data.linkmargin.toFixed(2)}`)
ok('晴空样本雨衰为 0（引擎 p = 0 即晴天）', near(scan.clear.data.uplinkRainAttenuation, 0, 1e-9))
ok('晴空 Es/N₀（实际）取得到 —— MIR 就靠它', Number.isFinite(scan.clear.data.esnoActualResult),
  String(scan.clear.data.esnoActualResult))
ok('面板要的列都在（余量/功率占用/带宽占用/年中断/雨衰）',
  ['linkmargin', 'powerUsageRatio', 'bandwidthUsageRatio', 'interruptionMinutes',
    'uplinkRainAttenuation', 'downlinkRainAttenuationResult', 'systemAvailabilityResult']
    .every((k) => k in scan.rows[0].data))
ok('引擎回显的系统可用度 = 该档', scan.rows.every((r) => near(r.data.systemAvailabilityResult, r.tier, 1e-4)))

// —— ④ 单侧体制：regen-up 只写上行键 ——
const REGEN_LP = {
  distanceMode: 'slantRange', slantRange: '1500', minElevation: '25',
  rxDistanceMode: 'slantRange', rxSlantRange: '1500', rxMinElevation: '25',
  uplinkAvailability: '99.9', rxDownlinkAvailability: '99.5',
  infoRate: '2048', modulation: 'QPSK', fec: '3/4', ebno: '5.50', ber: '7',
  m: '1.00', bandwidthFactor: '1.20', rsCode: '188/204', noiseRatioMode: 'ebno',
  centerFrequency: '14.25', uplinkPolarization: 'V', rxCenterFrequency: '12.5', downlinkPolarization: 'H',
  longitude: '116.4', latitude: '39.9', altitude: '50', rainRate: '40',
  rxLongitude: '116.4', rxLatitude: '39.9', rxAltitude: '50', rxRainRate: '40',
  antennaDiameter: '3.7', antennaEfficiency: '65', feederLoss: '3', margin: '3'
}
const upSamples = slaSamplesFor({ up: 99.9, dn: 99.5, single: 'up' })
ok('单侧体制的样本不动另一侧', upSamples.every((s) => s.tag === 'clear' || s.dn === 99.5))
const rScan = scanSlaTiers({
  engine: 'regen-up', satParams: { satelliteName: 'X', G_Ts: '2' },
  linkParams: REGEN_LP, opt: { mode: 'margin' }, samples: upSamples
})
ok('regen-up 扫得出', rScan.rows.length === AVAIL_TIERS.length && rScan.rows.every((r) => r.ok), rScan.message)
ok('regen-up 的档位 = 上行可用度（系统可用度就是上行那一个）',
  rScan.rows.every((r) => near(r.data.uplinkAvailabilityResult, r.tier, 1e-4)))
ok('regen-up 不碰下行入参（下行可用度恒 99.5）',
  rScan.rows.every((r) => near(r.data.downlinkAvailabilityResult, 99.5, 1e-4)),
  rScan.rows.map((r) => r.data.downlinkAvailabilityResult).join('/'))
ok('regen-up 余量随档位单调不增', (() => {
  for (let i = 1; i < rScan.rows.length; i++) if (rScan.rows[i].data.linkmargin > rScan.rows[i - 1].data.linkmargin + 1e-9) return false
  return true
})(), rScan.rows.map((r) => r.data.linkmargin.toFixed(2)).join(' / '))
ok('原 linkParams 未被就地改写（逐样本复制，不污染留底入参）',
  REGEN_LP.uplinkAvailability === '99.9' && REGEN_LP.rxDownlinkAvailability === '99.5')

// —— ⑤ 端到端：k 缩放地球站节点 ——
const CARRIER = { infoRate: '2048', modulation: 'QPSK', fec: '3/4', ebno: '5.50', ber: '7', m: '1.00', bandwidthFactor: '1.20', rsCode: '188/204', noiseRatioMode: 'ebno' }
const INTF = { aciUplinkFactor: '30', adjUplinkFactor: '25', xpolUplinkFactor: '26', hpaIntermodFactor: '24', aciDownlinkFactor: '30', adjDownlinkFactor: '25', xpolDownlinkFactor: '26', xpdrIntermodFactor: '21' }
const XPDR = { sfdRef: '-84', sfdGtRef: '0', transponderBandwidth: '36', BOi: '6', BOo: '3' }
const CHAIN = {
  nodes: [
    { kind: 'es', name: '北京关口站', longitude: '116.4074', latitude: '39.9042', altitude: '50', rainRate: '30', availability: '99.90', antennaDiameter: '9.0', antennaEfficiency: '65', feederLoss: '3.5', paBackoff: '0', uplinkPowerControl: '否', upcValue: '0', powerW: '120', rxAntennaEfficiency: '65', rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: '35', rxReceiverNoiseTemp: '75', rxFeederLoss: '0.2' },
    Object.assign({ kind: 'txp', name: '透明星-1', gt: '2', eirpSat: '46' }, XPDR, INTF),
    { kind: 'es', name: '三亚站', longitude: '109.5', latitude: '18.25', altitude: '10', rainRate: '60', availability: '99.70', antennaDiameter: '4.5', antennaEfficiency: '65', feederLoss: '3.0', paBackoff: '0', uplinkPowerControl: '否', upcValue: '0', powerW: '20', rxAntennaEfficiency: '68', rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: '35', rxReceiverNoiseTemp: '75', rxFeederLoss: '0.2' }
  ],
  hops: [
    { frequency: '14.25', polarization: 'V', slantRange: '39500', elevation: '25', miscLoss: '0.3' },
    { frequency: '12.50', polarization: 'H', slantRange: '38800', elevation: '32', miscLoss: '0.3' }
  ],
  carrier: CARRIER
}
const cSamples = slaChainSamplesFor(['99.90', '99.70'])
ok('端到端样本 = 9 档（无晴空档：MIR 不做 ACM 外推）', cSamples.length === AVAIL_TIERS.length, String(cSamples.length))
ok('solveChainK 解得住：Π(1 − aᵢ·k) 恰为该档',
  cSamples.every((s) => near((1 - 0.001 * s.k) * (1 - 0.003 * s.k) * 100, s.tier, 1e-9)))
const cScan = scanSlaTiers({ engine: 'chain', chain: CHAIN, samples: cSamples })
ok('端到端扫得出', cScan.rows.length === AVAIL_TIERS.length && cScan.rows.every((r) => r.ok), cScan.message)
ok('端到端缩放后 systemAvailabilityResult = 档位（±1e-5）',
  cScan.rows.every((r) => near(r.data.systemAvailabilityResult, r.tier, 1e-5)),
  cScan.rows.map((r) => r.data.systemAvailabilityResult).join(' / '))
ok('端到端不钉工作点（正向电平递推本无自由变量）', cScan.pin === null)
ok('端到端余量随档位单调不增', (() => {
  for (let i = 1; i < cScan.rows.length; i++) if (cScan.rows[i].data.linkmargin > cScan.rows[i - 1].data.linkmargin + 1e-9) return false
  return true
})(), cScan.rows.map((r) => r.data.linkmargin.toFixed(2)).join(' / '))
ok('原 chain 未被就地改写（逐样本深拷）', CHAIN.nodes[0].availability === '99.90' && CHAIN.nodes[2].availability === '99.70')

// —— ⑥ 算不出的样本不把整批带崩 ——
// 负仰角（卫星在地平线下）：GEO 引擎照样算得完，但那是穿过地球的弦长 → 与链路表同口径拦下
const invisible = scanSlaTiers({
  engine: 'geo', satParams: { orbitPosition: '110.5' },
  linkParams: { latitude: '85', longitude: '0', rxLatitude: '85', rxLongitude: '0' },
  opt: { mode: 'margin' }, samples
})
ok('负仰角样本 ok:false 且整批不抛', invisible.rows.length === AVAIL_TIERS.length && invisible.rows.every((r) => !r.ok && r.data === null),
  invisible.rows[0] && invisible.rows[0].message)
ok('参数全空也不抛', (() => {
  try { const r = scanSlaTiers({ engine: 'geo', satParams: null, linkParams: null, opt: null, samples }); return Array.isArray(r.rows) } catch (e) { return false }
})())
ok('没有样本 → 空结果，不跑引擎', (() => { const r = scanSlaTiers({ engine: 'geo', samples: [] }); return r.rows.length === 0 && r.clear === null })())
ok('未知体制 → 明确报错、不抛', (() => { const r = scanSlaTiers({ engine: 'regen-laser', samples }); return r.rows.length === 0 && !!r.message })())
ok('端到端链描述子非法 → 逐样本 ok:false，不抛', (() => {
  const r = scanSlaTiers({ engine: 'chain', chain: { nodes: [], hops: [] }, samples: cSamples })
  return r.rows.length === cSamples.length && r.rows.every((x) => !x.ok)
})())

// —— splitUnavailability 与扫描口径一致 ——
ok('scanSlaTiers 的样本就是 splitUnavailability 解出来的那一对', (() => {
  const s = splitUnavailability(up0, dn0, 99.9)
  const row = scan.rows.find((r) => r.tier === 99.9)
  return near(row.up, s.up, 1e-9) && near(row.dn, s.dn, 1e-9)
})())
ok('solveChainK 两节点时与 splitUnavailability 同解', (() => {
  const a = solveChainK(['99.90', '99.70'], 99.5)
  const b = splitUnavailability(99.9, 99.7, 99.5)
  return near(100 - 100 * 0.001 * a, b.up, 1e-6) && near(100 - 100 * 0.003 * a, b.dn, 1e-6)
})())

// —— ⑧ IPC 批量入口：逐条 try/catch 隔离（源码级不变式）——
{
  const src = fs.readFileSync(path.join(ROOT, 'electron/ipc/register.js'), 'utf8')
  const seg = src.slice(src.indexOf("ipcMain.handle('link:slaScanBatch'"), src.indexOf("ipcMain.handle('link:outputDefs'"))
  ok('link:slaScanBatch 存在', seg.length > 0)
  ok('批量入口逐条 try/catch（一条抛错不连累其余）', /for \(const spec of arr\)/.test(seg) && /try \{/.test(seg) && /catch \(err\)/.test(seg))
  // 2026-09-07 深审 #3：整表同步 map 会把别的窗口的 IPC 全排在后面，改成逐行 await setImmediate 让出事件循环
  ok('批量入口行间让出事件循环（async + setImmediate）', /async \(_e, list\)/.test(seg) && /setImmediate/.test(seg))
  ok('单条入口也兜住异常', /ipcMain\.handle\('link:slaScan',[\s\S]{0,300}?catch \(err\)/.test(src))
  const pre = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8')
  ok('preload 透出 slaScan / slaScanBatch', /slaScan:/.test(pre) && /slaScanBatch:/.test(pre))
  const idx = fs.readFileSync(path.join(ROOT, 'packages/core/index.js'), 'utf8')
  ok('core 出口透出 scanSlaTiers', /scanSlaTiers/.test(idx))
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
