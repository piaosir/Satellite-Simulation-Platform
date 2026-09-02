// 应用场景仿真：介质 / 地面段物理层 / 能量账 / 模块库 / 图→链归约 自测。运行：npm test
//
// 锁定的是这套东西存在的理由与最容易破的那几处：
//   ① 传播模型对得上文献值（FSPL / 视距 / 菲涅尔 / P.530 多径与雨衰 / 同轴厂商曲线 / 太阳几何）；
//   ② ★三档判据的出参形状泾渭分明：功率档有 marginDb，约束档【没有】marginDb 只有 checks，
//      契约档 quoted=true —— 把三者折算成一个「总余量」就是编数，这条一破整个功能就不可信；
//   ③ 模块库改写层只存差异：一条没动的场景下 overrides 必须是空的；
//   ④ ★一条业务流是双向的：两个方向各自成链、各有瓶颈，绝不共用一份结果；
//   ⑤ ★主备并联可用度走「至少 k 条在」，绝不连乘（连乘算的是「都在」，方向正好反）；
//   ⑥ 端口类型系统挡得住画得出算不了的图（连接器族 / 方向 / 频段三重）；
//   ⑦ 卫星段可承载速率是从【本段热噪与干扰】反解的，不是拿产品标称速率充数。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const MED = require('../utils/sceneMedia.js')
const TER = require('../utils/sceneTerrestrial.js')
const ENG = require('../utils/sceneEnergy.js')
const LIB = require('../utils/sceneLibrary.js')
const RED = require('../utils/sceneReduce.js')
const linkChain = require('../utils/linkChain.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol

/* ═══════ ① 传播模型对文献 ═══════ */
ok('P.525 自由空间 20 km @7 GHz = 135.4 dB', near(TER.fspl(20, 7), 135.36, 0.05), TER.fspl(20, 7).toFixed(2))
ok('P.310 无线电视距 40/40 m = 52.1 km', near(TER.radioHorizonKm(40, 40), 52.14, 0.05), TER.radioHorizonKm(40, 40).toFixed(2))
ok('P.526 第一菲涅尔区 20 km @7 GHz 中点 = 14.6 m', near(TER.fresnelRadiusM(1, 10, 10, 7), 14.64, 0.05))
// 双射线：切换点必须取【渐近线交点】4π·h_t·h_r/λ，否则断点上凭空掉 9.97 dB 且偏乐观
{
  const dc = TER.twoRayCrossoverM(5, 5, 5.5)
  ok('双射线交点 = 4π·h_t·h_r/λ', near(dc, 4 * Math.PI * 25 / (299792458 / 5.5e9), 1e-6), dc.toFixed(0) + ' m')
  ok('双射线交点内退回自由空间', near(TER.twoRayLossDb(dc * 0.5, 5, 5, 5.5), TER.fspl(dc * 0.5 / 1000, 5.5), 1e-9))
  ok('★ 两段在交点处连续（不许有台阶）',
    near(TER.twoRayLossDb(dc * 1.0001, 5, 5, 5.5), TER.fspl(dc / 1000, 5.5), 0.01),
    `${TER.twoRayLossDb(dc * 1.0001, 5, 5, 5.5).toFixed(3)} vs ${TER.fspl(dc / 1000, 5.5).toFixed(3)} dB`)
  const far = TER.twoRayLossDb(dc * 4, 5, 5, 5.5)
  ok('交点外按 40·lg d 走（比自由空间陡 2 倍斜率）',
    near(far - TER.fspl(dc / 1000, 5.5), 40 * Math.log10(4), 0.01), `+${(far - TER.fspl(dc / 1000, 5.5)).toFixed(2)} dB / 二倍程`)
}
// P.530-18 多径：K=10^(−4.6−0.0027·dN1)，20 km / 7 GHz / p=0.01% ⇒ ≈36.5 dB
{
  const m = TER.p530MultipathMarginDb(20, 7, 0, 0.01, -300)
  ok('P.530 多径衰落余量 20 km @7 GHz p=0.01% ≈ 36.5 dB', near(m.marginDb, 36.46, 0.1), m.marginDb.toFixed(2))
  ok('P.530 多径 K 系数（快速法）= 10^(−4.6−0.0027·dN1)', near(m.K, Math.pow(10, -4.6 + 0.81), 1e-9))
  const shorter = TER.p530MultipathMarginDb(5, 7, 0, 0.01, -300).marginDb
  ok('多径余量随距离单调增（d^3.6）', shorter < m.marginDb, `5 km ${shorter.toFixed(1)} < 20 km ${m.marginDb.toFixed(1)}`)
}
// P.530-18 §2.4 雨衰：距离因子 r ≤ 2.5，A 随 p 减小而增大
{
  const a01 = TER.p530RainMarginDb(20, 7, 42, 'V', 0.01)
  const a1 = TER.p530RainMarginDb(20, 7, 42, 'V', 1)
  ok('P.530 雨衰距离因子 r ≤ 2.5', a01.r <= 2.5 && a01.r > 0, a01.r.toFixed(3))
  ok('P.530 雨衰 A(0.01%) > A(1%)', a01.attenDb > a1.attenDb, `${a01.attenDb.toFixed(2)} > ${a1.attenDb.toFixed(2)} dB`)
  ok('P.838 系数走 linkCalculator 那一份（γ_R = k·R^α）', near(a01.gammaR, a01.k * Math.pow(42, a01.alpha), 1e-9))
}
// 同轴：Times Microwave 的 k1·√f + k2·f，LMR-400 @1000 MHz ≈ 4.1 dB/100 ft = 13.5 dB/100 m
ok('LMR-400 @1000 MHz = 13.5 dB/100 m（厂商曲线）', near(TER.coaxAttnDbPer100m('LMR-400', 1000).db100m, 13.54, 0.1))
ok('同轴衰减随频率单调增', TER.coaxAttnDbPer100m('LMR-400', 2150).db100m > TER.coaxAttnDbPer100m('LMR-400', 950).db100m)
// Hata 适用域外要报 warn 而不是静默外推
ok('Hata 超适用域如实报 warn', TER.hataLossDb(50, 3000, 5, 20, 'urban').warn.length >= 2)

/* ═══════ ② 三档判据出参形状 ═══════ */
{
  const fib = TER.computeSegment({ medium: 'smf_1550', params: { lengthKm: 20, txDbm: 0, rxSensDbm: -28 } })
  ok('光纤=功率档：有 marginDb、有台账、无 checks 越界', fib.tier === 'power' && fib.marginDb != null && fib.budget.length > 0, `余量 ${fib.marginDb.toFixed(2)} dB`)
  // 0 − (0.22×20 + 2×0.35 + 4×0.08) − (−28) − 3 = 0 − 5.32 + 28 − 3 = 19.68
  ok('光纤余量逐项闭合', near(fib.marginDb, 0 - (0.22 * 20 + 2 * 0.35 + 4 * 0.08) + 28 - 3, 1e-9), fib.marginDb.toFixed(4))

  const cop = TER.computeSegment({ medium: 'cat6', params: { lengthM: 80, ratePreset: '10GBASE-T' } })
  ok('铜缆=约束档：★没有 marginDb，只有实际 vs 上限', cop.tier === 'constraint' && cop.marginDb === null && cop.checks.length > 0)
  ok('Cat6 上 10GBASE-T 的 55 m 上限生效', cop.checks[0].limit === 55 && cop.checks[0].over === true, `${cop.checks[0].actual} m vs ${cop.checks[0].limit} m`)
  const cop2 = TER.computeSegment({ medium: 'cat6a', params: { lengthM: 80, ratePreset: '10GBASE-T' } })
  ok('Cat6A 上同样 80 m 不越界（100 m）', cop2.checks[0].over === false)

  const lease = TER.computeSegment({ medium: 'leased_mstp', params: { rateBps: 20e6, latencyMs: 12, availPct: 99.9 } })
  ok('专线=契约档：quoted=true 且数字原样转录', lease.tier === 'contract' && lease.quoted === true && lease.availPct === 99.9 && lease.marginDb === null)
  const cell = TER.computeSegment({ medium: 'cellular_5g', params: { covered: false } })
  ok('公网无覆盖是用户断言，不做覆盖预测', cell.ok === false && /覆盖/.test(cell.errors.join('')))
  const hf = TER.computeSegment({ medium: 'hf_ssb', params: { availPct: 70 } })
  ok('短波归契约档（需 P.533，本平台不算）', hf.tier === 'contract' && /P\.533/.test(hf.notes.join('')))
}
// PoE 压降：802.3af 在 100 m / AWG24 上回路 8.42 Ω，PD 端电压须仍 ≥ 37 V
{
  const poe = TER.computeSegment({ medium: 'cat5e', params: { lengthM: 100, awg: 24, ratePreset: '1000BASE-T', poe: '802.3af', poeLoadW: 12.95 } })
  const rc = poe.checks.find((c) => c.k === 'poeR'), vc = poe.checks.find((c) => c.k === 'poeV')
  ok('PoE 回路电阻 = L·R_cond（2 对供电）', near(rc.actual, 100 * 0.0842, 1e-9), `${rc.actual.toFixed(2)} Ω`)
  ok('PoE PD 端电压有解且高于 37 V 门限', vc.actual > vc.limit, `${vc.actual.toFixed(1)} V ≥ ${vc.limit} V`)
  const poeLong = TER.computeSegment({ medium: 'cat5e', params: { lengthM: 100, awg: 26, ratePreset: '1000BASE-T', poe: '802.3af', poeLoadW: 12.95 } })
  ok('细线规 AWG26 同样长度回路电阻更大', poeLong.checks.find((c) => c.k === 'poeR').actual > rc.actual)
}
// IFL：中频衰减按 950–2150 的高端算 + BUC 供电压降
{
  const ifl = TER.computeSegment({ medium: 'ifl_l', params: { lengthM: 100, cable: 'RG-6', bucVdc: 24, bucAmps: 3, ifMaxLossDb: 25 } })
  const l = ifl.checks.find((c) => c.k === 'ifloss'), v = ifl.checks.find((c) => c.k === 'bucv')
  ok('IFL 衰减按频段高端 2150 MHz 校验', l != null && /2150/.test(l.label))
  ok('IFL 100 m RG-6 中频衰减越 25 dB 上限', l.over === true, `${l.actual.toFixed(1)} dB`)
  ok('BUC 端电压 = V − I·R_loop', near(v.actual, 24 - 3 * 2.95, 1e-9), `${v.actual.toFixed(2)} V`)
  const ifl2 = TER.computeSegment({ medium: 'ifl_l', params: { lengthM: 30, cable: 'LMR-400', bucVdc: 24, bucAmps: 3, ifMaxLossDb: 25 } })
  ok('换 LMR-400 / 30 m 后两项都过', ifl2.checks.every((c) => !c.over))
}
// LoRa：SF12 灵敏度 −137 dBm，速率按 Semtech AN1200.22
{
  const lo = TER.computeSegment({ medium: 'lora', params: { sf: 12, bwKHz: 125, distM: 5000 } })
  ok('LoRa SF12@125k 灵敏度 −137 dBm', /−137|-137/.test(lo.notes.join('')) || /137/.test(lo.notes.join('')))
  ok('LoRa 速率 = SF·BW/2^SF·CR', near(MED.loraBitrate(12, 125, 5), 12 * 125000 / 4096 * 0.8, 1e-6), MED.loraBitrate(12, 125, 5).toFixed(1) + ' bps')
  const lo7 = TER.computeSegment({ medium: 'lora', params: { sf: 7, bwKHz: 125, distM: 5000 } })
  ok('SF7 余量低于 SF12（灵敏度差 14 dB）', lo7.marginDb < lo.marginDb, `${lo7.marginDb.toFixed(1)} < ${lo.marginDb.toFixed(1)} dB`)
}
// Mesh 多跳吞吐折减
{
  ok('同频 3 跳吞吐 = 单跳/3', near(TER.meshDerate(300e6, 3, true), 100e6, 1))
  ok('异频多跳不折减', TER.meshDerate(300e6, 3, false) === 300e6)
  const m = TER.computeSegment({ medium: 'wifi_mesh', params: { distM: 400, hops: 4, sameChannel: true, mcs: 4, bwMHz: 40 } })
  ok('Mesh 段出参带跳数折减后的吞吐', m.rateBps != null && /4 跳同频/.test(m.notes.join('')), (m.rateBps / 1e6).toFixed(1) + ' Mbps')
}
// 超视距要如实告警（不静默按视距算）
{
  const w = TER.computeSegment({ medium: 'microwave_ptp', params: { distKm: 80, hTxM: 40, hRxM: 40 } })
  ok('超视距如实告警且指出缺 P.526 地形剖面', w.warn.some((x) => /超视距/.test(x)))
}

/* ═══════ ③ 能量账（太阳几何对文献） ═══════ */
ok('赤纬夏至 = +23.45°', near(ENG.declinationDeg(172), 23.45, 0.01))
ok('H0 北京夏至 ≈ 41.5–42 MJ/m²·d', near(ENG.h0Horizontal(39.9, 172), 41.7, 0.5), ENG.h0Horizontal(39.9, 172).toFixed(2))
ok('H0 北京冬至 ≈ 13.6 MJ/m²·d', near(ENG.h0Horizontal(39.9, 355), 13.6, 0.3), ENG.h0Horizontal(39.9, 355).toFixed(2))
ok('H0 赤道春分 ≈ 37 MJ/m²·d', near(ENG.h0Horizontal(0, 80), 37.5, 1.0), ENG.h0Horizontal(0, 80).toFixed(2))
ok('极夜（北纬 80° 冬至）H0 = 0', ENG.h0Horizontal(80, 355) === 0)
{
  const m = ENG.monthlyIrradiation(39.9, 0.52, 45, 0.2)
  ok('倾斜面逐月出 12 个月且最差月在冬季', m.months.length === 12 && [11, 12, 1].includes(m.worst.m), m.worst.zh)
  ok('定容按最差月不按年均', m.worst.psh < m.meanPsh)
  // 天启终端负载：24 次上报，发射 9.6 W / 6 s，睡眠 36 mW
  const e = ENG.computeEnergy({
    load: { reportsPerDay: 24, txSecPerReport: 6, rxSecPerReport: 20, txW: 9.6, rxW: 0.1, sleepW: 0.036 },
    supply: { kind: 'solar', wp: 20, latDeg: 39.9, kt: 0.52, etaSys: 0.75, autonomyDays: 7, battery: { chem: 'agm', vdc: 12, ah: 20, tempC: -10 } }
  })
  const wh = 24 * 6 * 9.6 / 3600 + 24 * 20 * 0.1 / 3600 + (86400 - 24 * 26) * 0.036 / 3600
  ok('日能耗 = Σ(状态功率 × 时长)，余下时间按睡眠补', near(e.load.whPerDay, wh, 1e-9), e.load.whPerDay.toFixed(3) + ' Wh/d')
  ok('光伏出参标为估算（Kt 是用户给的气候量）', e.supply.estimated === true)
  ok('反解出所需组件功率与蓄电池容量', e.supply.needWp > 0 && e.supply.needAh > 0, `${e.supply.needWp.toFixed(1)} Wp / ${e.supply.needAh.toFixed(0)} Ah`)
  // 低温修正：铅酸 −10 ℃ 相对 25 ℃ 掉约 28%
  const warm = ENG.supplyBudget({ kind: 'solar', wp: 20, latDeg: 39.9, kt: 0.52, battery: { chem: 'agm', vdc: 12, ah: 20, tempC: 25 } }, e.load.whPerDay)
  ok('蓄电池容量按温度修正（−10 ℃ 比 25 ℃ 少）', e.supply.usableWh < warm.usableWh, `${e.supply.usableWh.toFixed(1)} < ${warm.usableWh.toFixed(1)} Wh`)
}

/* ═══════ ④ 模块库改写层 ═══════ */
ok('内置模块库装载且全库自检干净', LIB.BUILTIN.length > 120 && LIB.validateAll(null).length === 0, `${LIB.BUILTIN.length} 条`)
{
  const list = LIB.listModules(null)
  const s0 = LIB.storeFromList(list)
  ok('★ 一条没动 → 改写层是空的（只存差异的根本判据）',
    Object.keys(s0.overrides).length === 0 && s0.custom.length === 0 && s0.hidden.length === 0)
  const l2 = LIB.listModules(null)
  l2.find((m) => m.id === 'es.ka.fixed.098').rf.antennaDiameter = 1.05
  const s1 = LIB.storeFromList(l2)
  ok('改一条 → 只记这一条的差异', Object.keys(s1.overrides).length === 1 && JSON.stringify(s1.overrides['es.ka.fixed.098']) === '{"rf":{"antennaDiameter":1.05}}')
  ok('没动过的条目仍跟内置走', LIB.moduleOf(s1, 'es.ka.unattended.045').rf.antennaDiameter === 0.45)
  const back = LIB.listModules(s1)
  back.find((m) => m.id === 'es.ka.fixed.098').rf.antennaDiameter = 0.98
  ok('改回原样后差异清空（一轮往返不留残渣）', Object.keys(LIB.storeFromList(back).overrides).length === 0)
  ok('自建 id 带 usr: 前缀，与内置分家', LIB.blankModule('D', 'x').id.startsWith('usr:'))
  ok('八类都有条目', LIB.libraryTree(null).length === 8)
}

/* ═══════ ⑤ 可用度合成：串联 vs 并联 ═══════ */
ok('串联 = 连乘', near(RED.seriesAvail([99, 99]), 98.01, 1e-9))
ok('★ 主备并联 = 至少 1 条在，不是连乘', near(RED.atLeastK([99, 99], 1), 99.99, 1e-9))
ok('并联结果必然优于任一单条', RED.atLeastK([99, 95], 1) > 99)
ok('串联结果必然劣于任一单条', RED.seriesAvail([99, 95]) < 95)
ok('N+P：3 条里至少 2 条', near(RED.atLeastK([90, 90, 90], 2), 3 * 0.9 * 0.9 * 0.1 * 100 + 0.9 ** 3 * 100, 1e-9))
ok('k=n 时退化为连乘', near(RED.atLeastK([99, 95], 2), RED.seriesAvail([99, 95]), 1e-9))

/* ═══════ ⑥ 端口类型系统 ═══════ */
{
  const c = (a, b) => MED.portsCompatible(a, b)
  ok('RJ45 插不进光口', c({ medium: 'cat6', dir: 'trx' }, { medium: 'smf_1310', dir: 'trx' }).reason === 'connector-mismatch')
  ok('同为 RJ45 可连', c({ medium: 'cat6', dir: 'trx' }, { medium: 'cat6a', dir: 'trx' }).ok === true)
  ok('两个只发的口连不上', c({ medium: 'cat6', dir: 'tx' }, { medium: 'cat6', dir: 'tx' }).reason === 'direction-mismatch')
  ok('UHF 终端接不上 Ka 空口（频段不符）', c({ medium: 'sat_uhf', dir: 'trx' }, { medium: 'sat_ka', dir: 'trx' }).reason === 'band-mismatch')
  ok('同频段卫星空口可连', c({ medium: 'sat_ka', dir: 'tx' }, { medium: 'sat_ka', dir: 'rx' }).ok === true)
}

/* ═══════ ⑦ 几何闭式 ═══════ */
{
  const g = RED.geoStationary(39.9, 116.4, 130, 0)
  // 北京对 130°E：Δlon 13.6°，仰角 41.7° ⇒ 斜距 37650 km（仰角越高斜距越短，
  // 36000+ 那个直觉数是星下点值 35786，低仰角站才接近 41000）
  ok('GSO 几何：北京对 130°E 斜距 ≈ 37650 km', near(g.slantRange, 37650, 30), g.slantRange.toFixed(0) + ' km')
  ok('GSO 斜距随仰角降低而增大', RED.geoStationary(39.9, 40, 130, 0).slantRange > g.slantRange)
  ok('GSO 几何：仰角 35–45°', g.elevation > 30 && g.elevation < 50, g.elevation.toFixed(1) + '°')
  const sub = RED.geoStationary(0, 130, 130, 0)
  ok('星下点仰角 90°、斜距 = 42164 − Re', near(sub.elevation, 90, 0.01) && near(sub.slantRange, 42164.17 - 6378.137, 0.1))
  const c = RED.circularWorst(900, 10, 0)
  ok('900 km 圆轨道 10° 仰角斜距 ≈ 2570 km', near(c.slantRange, 2570, 20), c.slantRange.toFixed(0) + ' km')
  ok('仰角越低斜距越大', RED.circularWorst(900, 5, 0).slantRange > c.slantRange)
  ok('90° 仰角斜距 = 轨道高度', near(RED.circularWorst(900, 90, 0).slantRange, 900, 0.1))
}

/* ═══════ ⑧ ★ 图 → 链归约：一条双向业务流跑通真引擎 ═══════ */
const engines = { chain: (c) => linkChain.computeLinkChain(c) }
const CARRIER = { modulation: 'QPSK', fec: '3/4', ebno: '5.50', ber: '7', m: '1.00', bandwidthFactor: '1.20', rsCode: '188/204', noiseRatioMode: 'ebno' }

// 场景：电表集中器 —RJ45→ C 频段固定站 —Ku/C 卫星→ 中星 6C —→ 信关站 —专线→ 数据中心
const scene = {
  modules: [
    { id: 'm1', libId: 'sens.meter.concentrator', name: '台区集中器', place: { mode: 'fixed', lat: 43.8, lon: 87.6, altM: 900 } },
    { id: 'm2', libId: 'es.c.iot.015', name: '村口 C 频段站', place: { mode: 'fixed', lat: 43.8, lon: 87.6, altM: 900, rainRate: 18, availPct: 99.5 } },
    // ★ 波束 EIRP / G_T 是【工程师经对地覆盖分析后手填】的（平台既定口径，库里只给占位）。
    //   这里用实例级 ov 填入，同时也验证了 ov 覆盖库条目这条路。
    { id: 'm3', libId: 'sat.cs6c', name: '中星 6C', ov: { sat: { gt: 2.5, eirpSat: 44 } } },
    { id: 'm4', libId: 'es.hub.c.11m', name: '北京信关站', place: { mode: 'fixed', lat: 39.9, lon: 116.4, altM: 50, rainRate: 42, availPct: 99.9 } },
    { id: 'm5', libId: 'ctr.dc', name: '省公司数据中心', place: { mode: 'fixed', lat: 39.9, lon: 116.4, altM: 50 } }
  ],
  links: [
    { id: 'L1', a: { modId: 'm1', portKey: 'lan1' }, b: { modId: 'm2', portKey: 'lan1' }, medium: 'cat6', params: { lengthM: 40, ratePreset: '1000BASE-T' } },
    { id: 'L2', a: { modId: 'm2', portKey: 'rf' }, b: { modId: 'm3', portKey: 'rf' }, medium: 'sat_c', params: { freqUpGHz: 6.0, freqDnGHz: 4.0, pol: 'V' } },
    { id: 'L3', a: { modId: 'm3', portKey: 'rf' }, b: { modId: 'm4', portKey: 'rf' }, medium: 'sat_c', params: { freqUpGHz: 6.0, freqDnGHz: 4.0, pol: 'V' } },
    { id: 'L4', a: { modId: 'm4', portKey: 'wan' }, b: { modId: 'm5', portKey: 'wan1' }, medium: 'leased_mstp', params: { rateBps: 100e6, latencyMs: 8, availPct: 99.95 } }
  ],
  flows: [
    { id: 'F1', name: '用电信息采集', aId: 'm1', bId: 'm5', dir: 'bidir', rateAbBps: 32000, rateBaBps: 128000, availReqPct: 99.0 }
  ]
}
// L3 是下行（卫星 → 站），把接收站那一侧的口径显式给到 m4
const r = RED.computeScene(scene, null, engines, { carrier: CARRIER })
const f = r.flows[0]
ok('场景解析无错', r.errors.length === 0, r.errors.join('；'))
ok('★ 双向流出两条独立的链', f.dirs.length === 2 && f.dirs[0].dir === 'ab' && f.dirs[1].dir === 'ba')
for (const d of f.dirs) {
  ok(`方向 ${d.dir} 计算成功`, d.ok, d.errors.join('；'))
  ok(`方向 ${d.dir} 切出 3 段（铜缆 + 卫星 + 专线）`, d.segments.length === 3, d.segments.map((s) => s.kind + ':' + (s.medium || 'chain')).join(' '))
  const sat = d.segments.find((s) => s.kind === 'sat')
  ok(`方向 ${d.dir} 卫星段两跳一段（上+下并成一段送 linkChain）`, sat && sat.names.length === 3, sat && sat.names.join('→'))
}
{
  const ab = f.dirs[0], ba = f.dirs[1]
  ok('★ 两向速率各是各的（32 k 上 / 128 k 下）', ab.rateBps === 32000 && ba.rateBps === 128000)
  ok('★ 两向余量不共用一份结果', ab.marginDb !== ba.marginDb, `${ab.marginDb} vs ${ba.marginDb} dB`)
  ok('汇总取两向里更不利的那个余量', near(f.summary.marginDb, Math.min(ab.marginDb, ba.marginDb), 1e-9))
  ok('双向流给出往返时延（一去一回）', near(f.summary.rttMs, ab.latencyMs + ba.latencyMs, 1e-9), String(f.summary.rttMs))
  ok('可用度串联相乘（含卫星段与专线段）', ab.availPct != null && ab.availPct < 99.95, String(ab.availPct))
  ok('★ 契约段被单独点名（专线的数不是算出来的）', ab.quotedSegs.length === 1 && /数据中心/.test(ab.quotedSegs[0]))
  ok('★ 卫星段可承载速率是反解的不是标称的', sat0(ab).capacityMethod === 'exact' && sat0(ab).capacityBps > 0,
    `${(sat0(ab).capacityBps / 1000).toFixed(1)} kbps @${sat0(ab).marginDb} dB 余量`)
  ok('瓶颈段被点名', !!ab.bottleneckLabel, ab.bottleneckLabel)
}
function sat0(d) { return d.segments.find((s) => s.kind === 'sat') }
{
  // ★ 同一条星地边，地→星取 6 GHz、星→地取 4 GHz；返向走同一条边时不许把上下行对调
  const hAb = sat0(f.dirs[0]).hops, hBa = sat0(f.dirs[1]).hops
  ok('★ 上行频率恒 6 GHz、下行恒 4 GHz（不随遍历方向对调）',
    Math.abs(+hAb[0].frequencyResult - 6) < 1e-6 && Math.abs(+hAb[1].frequencyResult - 4) < 1e-6 &&
    Math.abs(+hBa[0].frequencyResult - 6) < 1e-6 && Math.abs(+hBa[1].frequencyResult - 4) < 1e-6,
    `ab ${hAb.map((h) => h.frequencyResult).join('/')}  ba ${hBa.map((h) => h.frequencyResult).join('/')}`)
}

// 单向（广播）：只出一条链
{
  const s2 = JSON.parse(JSON.stringify(scene))
  s2.flows = [{ id: 'F2', name: '应急广播下发', aId: 'm5', bId: 'm1', dir: 'ab', rateAbBps: 64000 }]
  const r2 = RED.computeScene(s2, null, engines, { carrier: CARRIER })
  ok('★ 单向流只出一条链（广播场景）', r2.flows[0].dirs.length === 1 && r2.flows[0].dirs[0].dir === 'ab')
  ok('单向流没有往返时延', r2.flows[0].summary.rttMs === null)
}

// 主备双链路：可用度必须走「至少一条在」
{
  const s3 = JSON.parse(JSON.stringify(scene))
  s3.modules.push({ id: 'm6', libId: 'net.5gcpe', name: '5G 备份', place: { mode: 'fixed', lat: 43.8, lon: 87.6, altM: 900 } })
  const a = RED.atLeastK([99.5, 99.0], 1), b = RED.seriesAvail([99.5, 99.0])
  ok('★ 主备并联 99.5% + 99.0% → 99.995%，绝不是 98.505%', near(a, 99.995, 1e-6) && near(b, 98.505, 1e-6), `并联 ${a.toFixed(4)}% / 串联 ${b.toFixed(4)}%`)
}

// 图不通 / 端口不匹配要如实报错，不静默兜底
{
  const s4 = JSON.parse(JSON.stringify(scene))
  s4.links = s4.links.filter((l) => l.id !== 'L2')
  const r4 = RED.computeScene(s4, null, engines, { carrier: CARRIER })
  ok('断链如实报「没有连通路径」', r4.flows[0].dirs.every((d) => /没有连通路径/.test(d.errors.join(''))))
  const s5 = JSON.parse(JSON.stringify(scene))
  s5.modules[2].libId = 'sat.cs26'          // 换成 Ka 星，C 站接不上
  const r5 = RED.computeScene(s5, null, engines, { carrier: CARRIER })
  ok('频段不符的连线被端口系统挡下', r5.errors.some((e) => /方向不相容|端口|介质/.test(e)) || r5.flows[0].dirs.some((d) => d.errors.length > 0))
}

/* === (9) 主进程接线：IPC handler 里的 core 是【函数】不是模块 === */
// 这一类 bug 只在运行时才现形（写成 core.xxx 拿到 undefined，表现为「模块库 0 条 +
// catalog 报 MEDIA of undefined」），单测跑不进 handler 体内，故直接对源码断言。
{
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../../../electron/ipc/register.js', import.meta.url), 'utf8')
  const bad = src.split(/\r?\n/).map((l, i2) => [i2 + 1, l])
    .filter(([, l]) => !/^\s*(\/\/|\*)/.test(l))
    .filter(([, l]) => /\bcore\.[A-Za-z_]/.test(l))
  ok('★ register.js 里没有 core.xxx 写法（core 是惰性解析函数，必须写 core()）',
    bad.length === 0, bad.map(([n, l]) => n + ': ' + l.trim().slice(0, 60)).join(' | '))
  for (const ch of ['scene:catalog', 'scene:libList', 'scene:libTree', 'scene:templates', 'scene:template', 'scene:compute', 'scene:segment', 'scene:energy']) {
    ok('IPC 通道 ' + ch + ' 已注册', src.includes("'" + ch + "'"))
  }
  const pre = fs.readFileSync(new URL('../../../electron/preload.js', import.meta.url), 'utf8')
  ok('★ preload 暴露的全局名是 api（渲染端读 window.api，不是 electronAPI）', /exposeInMainWorld\('api'/.test(pre))
  const blk = pre.slice(pre.indexOf('scene: {'), pre.indexOf('scene: {') + 900)
  for (const m of ['libList', 'libTree', 'catalog', 'templates', 'template', 'compute', 'segment', 'energy']) {
    ok('preload 暴露 scene.' + m, blk.includes(m + ':'))
  }
  for (const f of ['../../../src/viz/scene/sceneStore.js', '../../../src/components/ScenePanel.vue', '../../../src/components/SceneLibEditor.vue']) {
    const t = fs.readFileSync(new URL(f, import.meta.url), 'utf8')
    ok('渲染端 ' + f.split('/').pop() + ' 不用 electronAPI', !/window\.electronAPI/.test(t))
  }
}

/* ═══════ ⑨ 模块符号（二期：成品矢量素材 + 逐条映射）═══════ */
// 锁定的是「图上这一层信息还在不在」：
//   · 160 个内置模块【逐条】有图标 —— 一期是 160 个模块共用 72 个符号，光 `sensor` 一件
//     就被 7 类量纲不同的传感器共用，那等于这一层没画；
//   · 映射表里没有孤儿（指向已删模块的条目，改库时最容易留下的垃圾）；
//   · 每个用到的图标在生成的数据文件里都有，且【命令数组回放不抛】——
//     符号是 2D 出图 / 3D 精灵 / 拓扑三处共用的那支画笔，回放崩一处就三处一起崩。
{
  const { SYMBOL_MAP, SYMBOL_ICONS, LEGACY_ALIAS, FALLBACK_ICON, symbolSpec } =
    await import('../../../src/viz/scene/sceneSymbolMap.js')
  const { SYMBOL_DATA, SYM_STROKE_W } = await import('../../../src/viz/scene/sceneSymbolData.js')
  const { drawSymbol, iconOf } = await import('../../../src/viz/scene/sceneSymbols.js')

  const ids = LIB.BUILTIN.map((m) => m.id)
  const unmapped = ids.filter((i) => !SYMBOL_MAP[i])
  ok('★ 每个内置模块都有自己的一条符号映射', unmapped.length === 0, unmapped.slice(0, 6).join(' ') || `${ids.length} 条`)
  const orphan = Object.keys(SYMBOL_MAP).filter((k) => !ids.includes(k))
  ok('★ 映射表里没有孤儿（指向已删模块的条目）', orphan.length === 0, orphan.slice(0, 6).join(' '))

  const missIcon = [...SYMBOL_ICONS].filter((k) => !SYMBOL_DATA[k])
  ok('★ 映射用到的每个图标都在生成的数据文件里（缺一个＝图上一个空白）', missIcon.length === 0, missIcon.join(' ') || `${SYMBOL_ICONS.size} 个`)
  const unusedIcon = Object.keys(SYMBOL_DATA).filter((k) => !SYMBOL_ICONS.has(k))
  ok('数据文件里没有多余图标（构建脚本只抽映射表用到的）', unusedIcon.length === 0, unusedIcon.join(' '))
  ok('图标名一律带来源前缀（tabler / tabler-filled / lucide）',
    Object.keys(SYMBOL_DATA).every((k) => /^(tabler|tabler-filled|lucide):/.test(k)))

  // 一期那七类共用 `sensor` 的传感器现在各是各的
  const seven = ['sens.line.temp', 'sens.line.galloping', 'sens.pipe.das', 'sens.dam.seepage',
    'sens.geo.gnss', 'sens.geo.crack', 'sens.air.micro']
  const sevenIcons = new Set(seven.map((i) => SYMBOL_MAP[i].icon))
  ok('★ 一期共用一个 sensor 的七类传感器现在按量纲分开了', sevenIcons.size >= 6, [...sevenIcons].join(' '))
  const distinct = new Set(Object.values(SYMBOL_MAP).map((v) => v.icon))
  ok('内置模块的主图标种类比一期多（一期 72 种）', distinct.size > 72, `${distinct.size} 种`)

  // 老手绘符号 id 的别名：一期存下来的自建条目不能退化成兜底件
  const legacyMiss = Object.entries(LEGACY_ALIAS).filter(([, v]) => !SYMBOL_DATA[v]).map(([k]) => k)
  ok('★ 老符号别名表逐条指向存在的图标（一期存档的自建模块不掉图）', legacyMiss.length === 0, legacyMiss.join(' '))
  ok('老符号 id 走别名解析（不落兜底件）', symbolSpec({ id: 'usr:x', symbol: 'sensor' }).icon !== FALLBACK_ICON)
  ok('自建条目显式给的新式图标名压过映射表（改写层口径：换图标也是一条差异）',
    symbolSpec({ id: 'sat.cs6c', symbol: 'tabler:cpu' }).icon === 'tabler:cpu')
  ok('认不出的模块落兜底件（不伪装成某种设备）', symbolSpec({ id: 'usr:zzz' }).icon === FALLBACK_ICON)

  // 回放：记账用的假 2D 上下文（与 markSymbols.test.mjs 同一套做法）
  const mkCtx = () => ({
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 0, lineJoin: '', lineCap: '',
    _pts: [], _fills: 0, _strokes: 0, _w: [],
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, closePath() {},
    moveTo(x, y) { this._pts.push([x, y]) }, lineTo(x, y) { this._pts.push([x, y]) },
    rect(x, y, w, h) { this._pts.push([x, y], [x + w, y + h]) },
    arc(x, y, r) { this._pts.push([x - r, y - r], [x + r, y + r]) },
    ellipse(x, y, rx, ry) { this._pts.push([x - rx, y - ry], [x + rx, y + ry]) },
    quadraticCurveTo(cx, cy, x, y) { this._pts.push([cx, cy], [x, y]) },
    bezierCurveTo(a, b, c, d, x, y) { this._pts.push([a, b], [c, d], [x, y]) },
    fill() { this._fills++ }, stroke() { this._strokes++; this._w.push(this.lineWidth) }
  })
  let threw = ''
  const empty = [], outOfBox = []
  for (const m of LIB.BUILTIN) {
    const ctx = mkCtx()
    try { drawSymbol(ctx, m, 64, 64, 128, '#000', 0, '#fff') }
    catch (e) { threw = m.id + '：' + e.message; break }
    if (!ctx._pts.length) empty.push(m.id)
    // 形体连同描边整个塞进 128 视框（3D 那边是把这张贴图整体上屏的，超出就是被裁掉）
    const mg = SYM_STROKE_W / 2 + 6
    if (ctx._pts.some(([x, y]) => x < -mg || y < -mg || x > 128 + mg || y > 128 + mg)) outOfBox.push(m.id)
  }
  ok('★ 160 个模块的符号回放全不抛异常', !threw, threw)
  ok('每个符号都真画出了笔画', empty.length === 0, empty.slice(0, 6).join(' '))
  ok('★ 形体连同描边落在 128 视框内（3D 贴图整体上屏，超框即被裁）', outOfBox.length === 0, outOfBox.slice(0, 6).join(' '))

  // 徽标：复合模块画两套图形，笔画数必须比只画主图标时多
  {
    const a = mkCtx(); drawSymbol(a, 'net.smartpole', 64, 64, 128, '#000', 0, '#fff')       // 杆 + 卫星回传
    const b = mkCtx(); drawSymbol(b, 'tabler:tower', 64, 64, 128, '#000', 0, '#fff')        // 只有杆
    ok('★ 复合模块的右下角徽标真画出来了', a._pts.length > b._pts.length, `${a._pts.length} vs ${b._pts.length}`)
  }
  // 套边：先用套色把整个图形描粗一圈再画本体。★ 一期的符号是实心件、靠面积压住底图，
  // 二期换成描边件之后没有这一趟，符号线与地图底纹同粗同色就糊在一起了。
  {
    const a = mkCtx(); drawSymbol(a, 'tabler:satellite', 64, 64, 128, '#000', 0, '#fff')
    const n = SYMBOL_DATA['tabler:satellite'].length          // 这枚图标全是描边件
    ok('★ 套边是独立一趟（每个图元描两遍：套色粗的 + 本体）', a._strokes === n * 2, `${a._strokes} 笔 / ${n} 图元`)
    ok('★ 套边比本体粗（不粗就压不住底纹）', Math.max(...a._w) > SYM_STROKE_W, `最粗 ${Math.max(...a._w).toFixed(1)} vs 本体 ${SYM_STROKE_W}`)
  }
  // 空中判据换成按图标判之后，会飞的还得是会飞的
  ok('无人机 / 固定翼 / 直升机 / 浮空器解析出的图标都在「会飞」那一组',
    ['veh.uav.multi', 'veh.uav.fixed', 'veh.uav.heli', 'veh.balloon']
      .every((i) => /drone|plane|helicopter|balloon/.test(iconOf(LIB.BUILTIN.find((m) => m.id === i)))))
}


console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
