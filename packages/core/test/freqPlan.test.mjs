// 转发器频率计划：模型 / LO 推算 / 校验 / 容量 / 版式出图 的自测。运行：npm test
// 被测文件是渲染端 ESM（src/shared/freqPlan*.js），故本测试自身也是 .mjs。
//
// 关键不变式：
//   ① 下行 = 上行 − LO；显式填了 dn.fcMHz 就以填的为准（cross-strap 不能被 LO 覆盖掉）；
//   ①b 那条等式双向可用：LO 定了改哪一侧另一侧都跟着变，且联动态只存上行这一个数（见 ⑰）；
//   ② 同侧同极化重叠必报，正交极化重叠不报（那是合法的极化复用，报了就是狼来了）；
//   ③ 序列生成的频率严格等差，交替极化严格正交；
//   ④ 容量的两条约束各自独立累计，正交极化不合并；
//   ⑤ 引用出去的链路字段单位正确（频率 GHz、带宽 MHz）—— 单位错会静默算错整条链路。
import {
  newPlan, newChannel, newLo, newBeam, normalizePlan, downlinkFc, resolveChannel, resolveAll,
  validatePlan, errorCount, genSeries, channelToLinkFields, channelByNo,
  channelAtFreq, planExtent, toMHz, POL_ORTHO, planSummary, guessBand, guessLinkBand,
  beamLabel, bwToMHz, bwFromMHz, freqToMHz, freqFromMHz, fmtFreqNum, fmtFreqU,
  setChannelFc, setDnDecoupled, isDnLinked, loValueOf, dnFromUp, upFromDn, cleanFreq,
  channelEdges, setChannelEdge, setChannelSpan, setChannelBw, uplinkBw, downlinkBw
} from '../../../src/shared/freqPlanModel.js'
// 波束占段（HTS 频分占用 / 常规同频共用共用同一套结构，见 freqPlanModel 的「波束占段」那一段）
import { beamSegs, setBeamSegBw, setBeamSegFc, setBeamSegEdge } from '../../../src/shared/freqPlanModel.js'
// 波束只剩「叫什么、多宽」（频率是转发器的事，见上一行的占段）
import { beamBw, setBeamBw, segOffOf, segBwOf, beamLayoutOf, BEAM_LAYOUTS } from '../../../src/shared/freqPlanModel.js'
// 从波束合成导入：同色合并成一条，名字 = 它覆盖的波束代号、备注 = 频率复用色号 F#
import { fcLabel, fmtBeamNos, beamSynthText } from '../../../src/shared/freqPlanModel.js'
// 标记类载波（信标 / 遥控 / 遥测）：只有频率与极化、只在一侧、图上画成一根箭头
import { MARK_KINDS, isMark, markSide, foldMark, setChannelKind } from '../../../src/shared/freqPlanModel.js'
import { loadSynthGroups } from '../../../src/shared/freqPlanBeamSynth.js'
import { fcCss } from '../../../src/shared/freqReuseColors.js'
import { computeLoading, autoPlace, newCarrier } from '../../../src/shared/freqPlanCapacity.js'
// 频率分配表：逐转发器成组的行模型 + 载波频带两端的录入
import { buildAllocation, setCarrierEdge } from '../../../src/shared/freqPlanCapacity.js'
import { layout, toSvg, fmtFreq, loNoteText, beaconNoteText, layoutMulti, toSvgMulti, exportStyle, markGeom } from '../../../src/shared/freqPlanRender.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  console.error('  ✗ ' + name + (extra != null ? '  → ' + extra : ''))
}
const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol

console.log('freqPlan 自测')

/* ---------- ① 单位归一 ---------- */
ok('toMHz: 12.77 当 GHz', near(toMHz(12.77), 12770))
ok('toMHz: 14022 当 MHz', near(toMHz(14022), 14022))
ok('toMHz: 999 当 GHz（边界）', near(toMHz(999), 999000))
ok('toMHz: 1000 当 MHz（边界）', near(toMHz(1000), 1000))

/* ---------- ② LO 推算：对着四张标准图的真实数 ---------- */
{
  const lo1 = newLo({ name: 'LO1', valueMHz: 1750 })
  const lo2 = newLo({ name: 'LO2', valueMHz: 2802 })
  const plan = newPlan({ los: [lo1, lo2] })
  // 中星 Ku：14022 − 1750 = 12272（C1）
  const c1 = newChannel({ no: 'C1', loId: lo1.id, up: { fcMHz: 14022, bwMHz: 41.5, pol: 'H' } })
  // 中星 Ku 可动点波束：13783.5 − 2802 = 10981.5（S1）
  const s1 = newChannel({ no: 'S1', loId: lo2.id, up: { fcMHz: 13783.5, bwMHz: 41.5, pol: 'H' } })
  plan.channels.push(c1, s1)
  ok('LO 推算 C1 → 12272', near(downlinkFc(plan, c1), 12272))
  ok('LO 推算 S1 → 10981.5', near(downlinkFc(plan, s1), 10981.5))

  // C 段：5950 − 2320 = 3630；东部转发器 6315 − 2225 = 4090
  const loC = newLo({ name: 'LO2', valueMHz: 2320 })
  const loE = newLo({ name: 'LO1', valueMHz: 2225 })
  const cp = newPlan({ los: [loC, loE] })
  const t3 = newChannel({ no: '3', loId: loC.id, up: { fcMHz: 5950, bwMHz: 36, pol: 'L' } })
  const t19 = newChannel({ no: '19', loId: loE.id, up: { fcMHz: 6315, bwMHz: 36, pol: 'L' } })
  cp.channels.push(t3, t19)
  ok('C 段 3 号 → 3630', near(downlinkFc(cp, t3), 3630))
  ok('C 段 19 号 → 4090', near(downlinkFc(cp, t19), 4090))

  // Ku 非洲波束：14270 − 3300 = 10970（K1）
  const loK = newLo({ name: 'LO2', valueMHz: 3300 })
  const kp = newPlan({ los: [loK] })
  const k1 = newChannel({ no: 'K1', loId: loK.id, up: { fcMHz: 14270, bwMHz: 36, pol: 'H' } })
  kp.channels.push(k1)
  ok('Ku K1 → 10970', near(downlinkFc(kp, k1), 10970))
}

/* ---------- ③ cross-strap：显式下行必须压过 LO 推算 ---------- */
{
  const lo = newLo({ name: 'LO3', valueMHz: 1800 })
  const plan = newPlan({ los: [lo] })
  // Ku 图的 P1：上行 12780(V)，若走 LO3 应是 10980，但图上下行标 11230（cross-strap 到别的 LO）
  const p1 = newChannel({ no: 'P1', loId: lo.id, up: { fcMHz: 12780, bwMHz: 54, pol: 'V' }, dn: { fcMHz: 11230, pol: 'H' } })
  plan.channels.push(p1)
  ok('cross-strap 显式下行优先', near(downlinkFc(plan, p1), 11230))
  const r = resolveChannel(plan, p1)
  ok('cross-strap 标记 dnDerived=false', r.dnDerived === false)
  // 显式值与 LO 推算不符 → 报 info（可能是 cross-strap，也可能是录错，交人判断），但不算 error
  const iss = validatePlan(plan)
  ok('cross-strap 报 info 不报 error', iss.some((i) => i.code === 'loMismatch' && i.severity === 'info') && errorCount(iss) === 0)

  // 下行留空则回到推算，且 dnDerived=true
  const p2 = newChannel({ no: 'P2', loId: lo.id, up: { fcMHz: 12840, bwMHz: 54, pol: 'V' } })
  plan.channels.push(p2)
  ok('留空 → LO 推算', near(downlinkFc(plan, p2), 11040))
  ok('留空 → dnDerived=true', resolveChannel(plan, p2).dnDerived === true)
}

/* ---------- ④ 校验：同极化重叠报、正交极化重叠不报 ---------- */
{
  const plan = newPlan()
  plan.channels.push(
    newChannel({ no: 'A', up: { fcMHz: 14000, bwMHz: 40, pol: 'H' } }),
    newChannel({ no: 'B', up: { fcMHz: 14020, bwMHz: 40, pol: 'H' } })   // 与 A 重叠 20 MHz，同极化
  )
  let iss = validatePlan(plan)
  const ov = iss.find((i) => i.code === 'overlap')
  ok('同极化重叠报 error', !!ov && ov.severity === 'error')
  ok('重叠量算对（20 MHz）', ov && near(ov.nums.overlapMHz, 20, 1e-9))

  const plan2 = newPlan()
  plan2.channels.push(
    newChannel({ no: 'A', up: { fcMHz: 14000, bwMHz: 40, pol: 'H' } }),
    newChannel({ no: 'B', up: { fcMHz: 14020, bwMHz: 40, pol: 'V' } })   // 正交极化 → 合法复用
  )
  ok('正交极化重叠不报', !validatePlan(plan2).some((i) => i.code === 'overlap'))

  // 编号重复
  const plan3 = newPlan()
  plan3.channels.push(newChannel({ no: 'C1', up: { fcMHz: 14000, bwMHz: 36 } }), newChannel({ no: 'C1', up: { fcMHz: 14100, bwMHz: 36, pol: 'V' } }))
  ok('编号重复报 warn', validatePlan(plan3).some((i) => i.code === 'dupNo'))
}

/* ---------- ⑤ 序列生成 ---------- */
{
  // 中星 Ku C1~C6：14022 起，步进 41.5
  const chs = genSeries({ count: 6, startFcMHz: 14022, stepMHz: 41.5, bwMHz: 36, pol: 'H', noPattern: 'C{n}', noStart: 1 })
  ok('生成数量', chs.length === 6)
  ok('首频', near(chs[0].up.fcMHz, 14022))
  ok('末频 14229.5', near(chs[5].up.fcMHz, 14229.5, 1e-9))
  ok('编号 C1..C6', chs.map((c) => c.no).join(',') === 'C1,C2,C3,C4,C5,C6')
  ok('等差严格', chs.every((c, i) => i === 0 || near(c.up.fcMHz - chs[i - 1].up.fcMHz, 41.5, 1e-9)))
  ok('下行默认极化正交于上行', chs.every((c) => c.dn.pol === POL_ORTHO[c.up.pol]))

  // 一排全同极化（唯一的排法）：C 段那种 LHCP 一排、RHCP 另起一排，各批分开生成
  const cl = genSeries({ count: 4, startFcMHz: 5950, stepMHz: 40, bwMHz: 36, pol: 'L', noStart: 3, noStep: 1 })
  ok('一排全同极化 L,L,L,L', cl.map((c) => c.up.pol).join(',') === 'L,L,L,L')
  ok('编号从 3 起', cl.map((c) => c.no).join(',') === '3,4,5,6')

  // 下行极化：给字母 = 一排全按它（同极化转发的星），非法值退回正交
  const same = genSeries({ count: 3, startFcMHz: 14022, stepMHz: 41.5, bwMHz: 36, pol: 'H', dnPol: 'H' })
  ok('下行同极化', same.every((c) => c.up.pol === 'H' && c.dn.pol === 'H'))
  ok('下行极化非法值退回正交', genSeries({ count: 1, pol: 'H', dnPol: 'same' })[0].dn.pol === 'V')
}

/* ---------- ⑥ 容量：两条约束独立累计 ---------- */
{
  const plan = newPlan()
  plan.channels.push(
    newChannel({ no: 'C1', up: { fcMHz: 14022, bwMHz: 36, pol: 'H' } }),
    newChannel({ no: 'C2', up: { fcMHz: 14063.5, bwMHz: 36, pol: 'H' } })
  )
  const carriers = [
    newCarrier({ name: 'a', channelNo: 'C1', occBwMHz: 10, pwrBwMHz: 14, infoRateKbps: 20000 }),
    newCarrier({ name: 'b', channelNo: 'C1', occBwMHz: 12, pwrBwMHz: 8, infoRateKbps: 24000 }),
    newCarrier({ name: 'c', channelNo: 'C2', occBwMHz: 40, pwrBwMHz: 5, infoRateKbps: 60000 })   // 超带宽
  ]
  const r = computeLoading(plan, carriers)
  const t1 = r.transponders.find((t) => t.no === 'C1')
  const t2 = r.transponders.find((t) => t.no === 'C2')
  ok('C1 占用带宽 22', near(t1.occSum, 22))
  ok('C1 功率带宽 22', near(t1.pwrSum, 22))
  ok('C1 带宽占用率 22/36', near(t1.bwUtil, 22 / 36, 1e-9))
  ok('C1 剩余取两约束更紧者', near(t1.freeMHz, 14))
  ok('C2 超带宽被标出', t2.issues.some((i) => i.code === 'bwOver'))
  ok('整星总带宽 72', near(r.summary.totalBwMHz, 72))
  ok('整星占用 62', near(r.summary.occupiedBwMHz, 62))
  ok('整星功率带宽 27', near(r.summary.powerBwMHz, 27))
  ok('总速率 104 Mbps', near(r.summary.totalRateMbps, 104))
  // 频谱效率按已占用带宽算（空转发器不该拉低读数）
  ok('频谱效率 = 104e6/62e6', near(r.summary.avgEffBpsHz, (104000 * 1000) / (62 * 1e6), 1e-9))

  // 未归属载波不计入任何转发器，但要单列
  const r2 = computeLoading(plan, [...carriers, newCarrier({ name: 'x', occBwMHz: 5 })])
  ok('未归属载波单列', r2.unassigned.length === 1 && r2.summary.unassignedCount === 1)
}

/* ---------- ⑦ 自动排布 ---------- */
{
  const plan = newPlan()
  plan.channels.push(newChannel({ no: 'C1', up: { fcMHz: 14022, bwMHz: 36, pol: 'H' } }))
  const carriers = [
    newCarrier({ name: 'a', channelNo: 'C1', occBwMHz: 10 }),
    newCarrier({ name: 'b', channelNo: 'C1', occBwMHz: 10 }),
    newCarrier({ name: 'c', channelNo: 'C1', occBwMHz: 10 })
  ]
  const placed = autoPlace(plan, carriers, { guardMHz: 1 })
  const f1 = 14022 - 18
  ok('首个载波居左对齐', near(placed[0].fcMHz, f1 + 5, 1e-6), '得到 ' + placed[0].fcMHz)
  ok('第二个含保护带', near(placed[1].fcMHz, f1 + 10 + 1 + 5, 1e-6), '得到 ' + placed[1].fcMHz)
  ok('排布不改原数组', carriers[0].fcMHz == null)
  const chk = computeLoading(plan, placed, { guardMHz: 1 })
  ok('排布后无重叠告警', !chk.transponders[0].issues.some((i) => i.code === 'carrierOverlap'))

  // 装不下的那条明确留 null，不硬塞
  const many = Array.from({ length: 5 }, (_, i) => newCarrier({ name: 'x' + i, channelNo: 'C1', occBwMHz: 10 }))
  const p2 = autoPlace(plan, many, { guardMHz: 1 })
  ok('装不下的留 null', p2.some((c) => c.fcMHz == null))

  // 已定频的载波是一段【区间】不是一个点：新载波不能从它身上横穿过去，眼前这截空隙装不下就该
  // 跳到它后面那段空着的（频带 14004~14040、已定频 14016~14024、保护带 1 → 空隙 11 与 15）
  const mixed = [
    newCarrier({ name: 'fix', channelNo: 'C1', fcMHz: 14020, occBwMHz: 8 }),
    newCarrier({ name: 'w14', channelNo: 'C1', occBwMHz: 14 }),
    newCarrier({ name: 'n10', channelNo: 'C1', occBwMHz: 10 })
  ]
  const mp = autoPlace(plan, mixed, { guardMHz: 1 })
  ok('前段空隙装不下 → 跳到已定频载波之后', near(mp[1].fcMHz, 14032, 1e-6), '得到 ' + mp[1].fcMHz)
  ok('后来的小载波仍首次适配落回前段空隙', near(mp[2].fcMHz, 14009, 1e-6), '得到 ' + mp[2].fcMHz)
  const mchk = computeLoading(plan, mp, { guardMHz: 1 })
  ok('排布结果不压在已定频载波上、保护带也够', !mchk.transponders[0].issues.length,
    JSON.stringify(mchk.transponders[0].issues.map((i) => i.code)))
}

/* ---------- ⑧ 引用出去的链路字段（单位！）---------- */
{
  const lo = newLo({ name: 'LO', valueMHz: 1750 })
  const plan = newPlan({ los: [lo] })
  const ch = newChannel({ no: 'C5', loId: lo.id, up: { fcMHz: 14188, bwMHz: 41.5, pol: 'H' }, dn: { pol: 'V' }, sfdDbwm2: -84, gtDbK: 2 })
  plan.channels.push(ch)
  const f = channelToLinkFields(plan, ch)
  ok('上行频率转 GHz', near(f.centerFrequency, 14.188, 1e-9), '得到 ' + f.centerFrequency)
  ok('下行频率转 GHz', near(f.rxCenterFrequency, 12.438, 1e-9), '得到 ' + f.rxCenterFrequency)
  ok('转发器带宽留 MHz', near(f.transponderBandwidth, 41.5))
  ok('上行极化', f.uplinkPolarization === 'H')
  ok('下行极化', f.downlinkPolarization === 'V')
  ok('SFD 带出', near(f.sfdRef, -84))
  ok('G/T 带出', near(f.sfdGtRef, 2))
  // 工作频段跟着一起走：引擎按它给收信站噪温分档，停在旧值就会静默算错 T_sys
  ok('工作频段带出', f.frequencyBand === 'Ku', '得到 ' + f.frequencyBand)
  // 未填的转发器属性不得出现在结果里（出现了就会把卫星配置里手填的值冲成 null）
  ok('未填项不带出', !('BOi' in f) && !('xpdrIntermodFactor' in f))

  ok('按编号取通道', channelByNo(plan, 'C5') === ch)
  ok('按频率定位通道（上行）', channelAtFreq(plan, 14190, 'up')?.no === 'C5')
  ok('按频率定位通道（带外返回 null）', channelAtFreq(plan, 15000, 'up') === null)
}

/* ---------- ⑨ 规范化：悬挂引用必须清掉 ---------- */
{
  const lo = newLo({ name: 'LO', valueMHz: 1750 })
  const beam = newBeam({ name: 'CHN' })
  const raw = {
    los: [lo], beams: [beam],
    channels: [newChannel({ no: 'X', loId: 'ghost-lo', beamUpId: 'ghost-beam', switchableBeamIds: ['ghost-beam', beam.id], up: { fcMHz: 14000, bwMHz: 36 } })]
  }
  const p = normalizePlan(raw)
  ok('悬挂 LO 引用被清', p.channels[0].loId === '')
  // 老字段 beamUpId / switchableBeamIds 并进 beamUpIds（波束归属只此一处），悬挂的那些被清掉
  ok('波束集合里只留有效的', p.channels[0].beamUpIds.length === 1 && p.channels[0].beamUpIds[0] === beam.id)
  ok('老单值/可切换字段不再写回', p.channels[0].beamUpId === undefined && p.channels[0].switchableBeamIds === undefined)
  ok('normalizePlan 容忍 null', normalizePlan(null).channels.length === 0)

  // 下行集合两侧各清各的悬挂 id；清完与上行一样 → 收回「随上行」态（同一件事存两遍会在改上行时漂开）
  const b2 = newBeam({ name: 'SEA' })
  const q = normalizePlan({
    beams: [beam, b2],
    channels: [
      newChannel({ no: 'Y', beamUpIds: [beam.id], beamDnIds: [beam.id, 'ghost-beam'], up: { fcMHz: 14000 } }),
      newChannel({ no: 'Z', beamUpIds: [beam.id], beamDnIds: [b2.id], up: { fcMHz: 14100 } })
    ]
  })
  ok('下行悬挂 id 也被清', !q.channels[0].beamDnIds.includes('ghost-beam'))
  ok('下行与上行一样 → 收回随上行', q.channels[0].beamDnIds.length === 0)
  ok('下行确实不同的原样留着', q.channels[1].beamDnIds.length === 1 && q.channels[1].beamDnIds[0] === b2.id)
}

/* ---------- ⑩ 版式与出图 ---------- */
{
  const lo = newLo({ name: 'LO', valueMHz: 1750 })
  const beam = newBeam({ name: 'CHN', color: '#4472C4' })
  const plan = newPlan({ los: [lo], beams: [beam] })
  plan.channels.push(...genSeries({ count: 6, startFcMHz: 14022, stepMHz: 41.5, bwMHz: 36, pol: 'H', noPattern: 'C{n}', loId: lo.id, beamUpId: beam.id }))
  const L = layout(plan, { width: 1200 })
  ok('版式出两个频带（上下行）', L.bands.length === 2)
  ok('版式出 12 个块（6 上行 + 6 下行）', L.blocks.length === 12)
  ok('块不越出画布', L.blocks.every((b) => b.x >= 0 && b.x + b.w <= L.width + 1))
  ok('块按频率单调排（上行）', L.blocks.filter((b) => b.side === 'up').every((b, i, a) => i === 0 || b.x >= a[i - 1].x))
  ok('下行块标记为推算', L.blocks.filter((b) => b.side === 'dn').every((b) => b.derived))

  // ★ 频带标题（UPLINK/DOWNLINK）与量程端点标注都起于 axisX0 附近，垂直必须让开：
  //   端点标注原先钉在 rowY[0] − 1.6 字高上，正好压在标题上；关掉频率标注时叠得更死。
  for (const showFreqLabels of [true, false]) {
    const LB = layout(plan, { width: 1200, showFreqLabels })
    for (const band of LB.bands) {
      const titleBase = band.titleY + LB.style.fontSize                    // 标题基线
      const labelTop = band.endLabelY - LB.style.fontSize * 0.86 * 0.75    // 端点标注字顶
      ok(`标题与量程标注不叠（频率标注=${showFreqLabels}·${band.side}）`, labelTop > titleBase, `${labelTop.toFixed(1)} vs ${titleBase.toFixed(1)}`)
    }
  }

  const ext = planExtent(plan, 'up', 0)
  ok('上行量程下界 = 首频 − 半带宽', near(ext.dataMin, 14022 - 18, 1e-9))

  const svg = toSvg(plan, { width: 1200 })
  ok('SVG 生成', svg.startsWith('<svg') && svg.endsWith('</svg>'))
  ok('SVG 写死字体（离开页面无祖先可继承）', /font-family="[^"]*Times New Roman/.test(svg))
  ok('SVG 含全部 12 块', (svg.match(/<rect /g) || []).length >= 12)
  // ★ 倍率靠重画几何，不是加 viewBox 缩放
  const svg4 = toSvg(plan, { width: 1200 }, 4)
  ok('4× 无 viewBox', !/viewBox/.test(svg4))
  const w1 = Number(/width="(\d+(?:\.\d+)?)"/.exec(svg)[1])
  const w4 = Number(/width="(\d+(?:\.\d+)?)"/.exec(svg4)[1])
  ok('4× 画布宽为 4 倍', near(w4, w1 * 4, 1e-6), `${w1} → ${w4}`)
  ok('4× 字号同步放大', /font-size="4[0-9.]+"/.test(svg4) || /font-size="[45][0-9.]+"/.test(svg4))

  ok('摘要含转发器数', /6 转发器/.test(planSummary(plan)))
}

/* ---------- ⑩b 块宽只由带宽决定（同带宽必同宽，跨上下行也是） ---------- */
{
  // ★ 上下行两带原先各自定量程，同一个 36 MHz 在上行画 119px、在下行画 71px —— 双 LO / 只有单侧的
  //   信标 都会让两带跨度不等。两带必须共用一把尺子（同一个 MHz/px），否则这张图的宽度读不得。
  const lo1 = newLo({ name: 'LO1', valueMHz: 1750 })
  const lo2 = newLo({ name: 'LO2', valueMHz: 2300 })
  const plan = newPlan({ los: [lo1, lo2] })
  plan.channels.push(...genSeries({ count: 4, startFcMHz: 14022, stepMHz: 41.5, bwMHz: 36, loId: lo1.id, noPattern: 'P{n}' }))
  plan.channels.push(...genSeries({ count: 4, startFcMHz: 14188, stepMHz: 41.5, bwMHz: 36, loId: lo2.id, noStart: 5, noPattern: 'P{n}' }))
  plan.channels.push(newChannel({ no: 'W', loId: lo1.id, up: { fcMHz: 14400, bwMHz: 72, pol: 'H' } }))
  const L = layout(plan, { width: 1200 })

  // 共用比例尺 = 任一带内、任意 10 MHz 都画成同样多的像素（断轴后跨度不再相等，尺子仍只有一把）
  for (const band of L.bands) {
    const f0 = band.ext.dataMin
    ok(`同一把尺子（${band.side}）`, near(L.x2f(band, f0 + 10) - L.x2f(band, f0), 10 / L.mhzPerPx, 1e-9))
  }
  const w36 = [...new Set(L.blocks.filter((b) => b.bw === 36).map((b) => Math.round(b.w * 1e6)))]
  ok('同带宽同宽度（含跨上下行）', w36.length === 1, `${w36.length} 种宽度`)
  const b36 = L.blocks.find((b) => b.bw === 36), b72 = L.blocks.find((b) => b.bw === 72)
  ok('72 MHz 恰是 36 MHz 的两倍宽', near(b72.w, b36.w * 2), `${b36.w.toFixed(2)} → ${b72.w.toFixed(2)}`)
  ok('块宽 = 带宽 ÷ (MHz/px)', near(b36.w, 36 / L.mhzPerPx))
  // 界标钉在真实数据端点上（共用尺子后窄带不占满画布，钉纸边会与线上标的数对不上）
  for (const band of L.bands) {
    ok(`界标对准数据端点（${band.side}）`, near(band.axisX0 + 8, L.x2f(band, band.ext.dataMin)) && near(band.axisX1 - 8, L.x2f(band, band.ext.dataMax)))
  }

  // 窄块原先一律抬到 minBlockW=16px → 1 MHz 与 4 MHz 画得一样宽，宽度与带宽脱钩
  const nb = newPlan({ los: [lo1] })
  for (const [no, fc, bw] of [['A', 14000, 36], ['B', 14100, 1], ['C', 14150, 4]]) {
    nb.channels.push(newChannel({ no, loId: lo1.id, up: { fcMHz: fc, bwMHz: bw, pol: 'H' } }))
  }
  const wOf = (no) => layout(nb, { width: 1200 }).blocks.find((b) => b.no === no && b.side === 'up').w
  ok('1 MHz 与 4 MHz 不再同宽', wOf('B') < wOf('C'), `${wOf('B').toFixed(2)} vs ${wOf('C').toFixed(2)}`)
  ok('窄块宽度同样按比例', near(wOf('C') / wOf('A'), 4 / 36), (wOf('C') / wOf('A')).toFixed(5))
}

/* ---------- ⑩c 断轴：带内大空隙折成「…」断口 ---------- */
{
  // 中星 Ku 那张图：同一批上行 C1~C6 经两个 LO 落到相距 300+ MHz 的两簇下行，
  // 中间那片空白按真实比例画出来就吃掉近一半画布。
  const lo1 = newLo({ name: 'LO1', valueMHz: 1750 })
  const lo2 = newLo({ name: 'LO2', valueMHz: 2300 })
  const plan = newPlan({ los: [lo1, lo2] })
  plan.channels.push(...genSeries({ count: 6, startFcMHz: 14022, stepMHz: 41.5, bwMHz: 36, pol: 'H', loId: lo1.id, noPattern: 'C{n}' }))
  plan.channels.push(...genSeries({ count: 6, startFcMHz: 14022, stepMHz: 41.5, bwMHz: 36, pol: 'V', loId: lo2.id, noPattern: 'D{n}' }))
  const L = layout(plan, { width: 1200 })
  const up = L.bands.find((b) => b.side === 'up'), dn = L.bands.find((b) => b.side === 'dn')

  ok('上行连成一片 → 不断', up.breaks.length === 0)
  ok('下行两簇之间断一处', dn.breaks.length === 1, `${dn.breaks.length} 处`)
  ok('断口正对那片空隙', near(dn.breaks[0].f0, 11947.5, 1e-6) && near(dn.breaks[0].f1, 12254, 1e-6),
    `${dn.breaks[0].f0} ~ ${dn.breaks[0].f1}`)
  ok('断口宽度固定（≪ 空隙的真实像素）', dn.breaks[0].x1 - dn.breaks[0].x0 <= 40)
  ok('基线在断口处断开成两段', dn.baseSegs.length === 2)
  ok('三个点居中于断口', dn.breaks[0].dots.length === 3 && near(dn.breaks[0].dots[1], dn.breaks[0].xMid, 1e-9))
  ok('点画在基线高度上', near(dn.breaks[0].y, dn.baselineY, 1e-9))

  // 断口里不许有块，两侧的块也不许探进去
  const brk = dn.breaks[0]
  const dnBlocks = L.blocks.filter((b) => b.side === 'dn')
  ok('块不落进断口', dnBlocks.every((b) => b.x + b.w <= brk.x0 + 1e-6 || b.x >= brk.x1 - 1e-6))
  ok('块不越出画布', L.blocks.every((b) => b.x >= 0 && b.x + b.w <= L.width + 1))
  ok('下行块按频率单调排', dnBlocks.slice().sort((a, b) => a.fc - b.fc).every((b, i, a) => i === 0 || b.x >= a[i - 1].x))

  // ★ 折叠省下的像素让给了块：同一批数据关掉断轴后块必然更窄
  const L0 = layout(plan, { width: 1200, breakGaps: false })
  ok('关掉断轴 → 无断口', L0.bands.every((b) => b.breaks.length === 0))
  ok('断轴让块变宽', L.mhzPerPx < L0.mhzPerPx && L.blocks[0].w > L0.blocks[0].w,
    `${L0.blocks[0].w.toFixed(1)} → ${L.blocks[0].w.toFixed(1)} px`)
  // 断轴不碰「同带宽同宽度」：段内还是那把唯一的尺子
  ok('断轴后同带宽仍同宽', [...new Set(L.blocks.map((b) => Math.round(b.w * 1e6)))].length === 1)

  // 空隙不够大就不折（否则每一处步进间隙都成断口）
  const tight = newPlan({ los: [lo1] })
  tight.channels.push(...genSeries({ count: 4, startFcMHz: 14022, stepMHz: 60, bwMHz: 36, loId: lo1.id, noPattern: 'T{n}' }))
  ok('小空隙不折', layout(tight, { width: 1200 }).bands.every((b) => b.breaks.length === 0))

  const svg = toSvg(plan, { width: 1200 })
  ok('断口的三个点进 SVG', (svg.match(/<circle /g) || []).length === 3)
  // ★ 比例判据不许跟着导出倍率走：0.12 × 4 = 0.48 的话，4× 图与 1× 图断的地方会不一样
  const svg4 = toSvg(plan, { width: 1200 }, 4)
  ok('4× 断的地方一样', (svg4.match(/<circle /g) || []).length === 3)
}

/* ---------- ⑩d 导出倍率 = 屏上那张图整体放大（一个像素都不许自己走样） ---------- */
{
  // ★ 这一组是「导出的 PNG 与屏上预览对不上」那一类问题的总闸：曾经 innerW 的右留白、界标的外挑、
  //   极化字母的左挑、基线那 2px、箭头的 <marker> 尺寸全是写死的字面量 —— 屏上（1×）没事，
  //   4× 导出时它们原地不动，于是右侧的频率数字被裁掉、界标贴着首末块、箭头大成一只盖住半张图的
  //   黑三角。逐点比对 1× 与 k× 的几何，再漏一个字面量就在这里当场红。
  const lo = newLo({ name: 'LO1', valueMHz: 1750 })
  const lo2 = newLo({ name: 'LO2', valueMHz: 2300 })
  const beam = newBeam({ name: 'CHN', color: '#4472C4', bwMHz: 36 })
  const plan = newPlan({ los: [lo, lo2], beams: [beam] })
  plan.channels.push(...genSeries({ count: 6, startFcMHz: 14022, stepMHz: 41.5, bwMHz: 36, pol: 'H', noPattern: 'C{n}', loId: lo.id, beamUpId: beam.id }))
  plan.channels.push(...genSeries({ count: 4, startFcMHz: 14022, stepMHz: 41.5, bwMHz: 36, pol: 'V', noPattern: 'D{n}', loId: lo2.id }))
  // 信标只有下行（星上发的），故录在下行那一侧；图上它是一根箭头，不占带宽
  plan.channels.push(newChannel({ no: 'BCN', kind: 'beacon', dn: { fcMHz: 12500, pol: 'H' } }))

  for (const k of [2, 4, 6]) {
    const L1 = layout(plan, { width: 1240 })
    const Lk = layout(plan, exportStyle({ width: 1240 }, k))
    let bad = ''
    const chk = (label, a, b, tol = 1e-6 * k) => { if (!near(a, b * k, tol) && !bad) bad = `${label}: ${a} ≠ ${k} × ${b}` }
    chk('画布宽', Lk.width, L1.width)
    chk('画布高', Lk.height, L1.height, k)     // 高度各自向上取整过，故只到「不差一个 1× 像素」为止
    chk('内容区宽', Lk.innerW, L1.innerW)
    chk('比例尺', L1.mhzPerPx, Lk.mhzPerPx)                       // MHz/px：倍率下该【除】不该乘
    ok(`${k}× 画布与尺子整体放大`, !bad, bad)

    bad = ''
    Lk.bands.forEach((b, i) => {
      const b1 = L1.bands[i]
      chk(`带${i} 标题Y`, b.titleY, b1.titleY)
      chk(`带${i} 端点标注Y`, b.endLabelY, b1.endLabelY)
      chk(`带${i} 基线Y`, b.baselineY, b1.baselineY)
      chk(`带${i} 界标左`, b.axisX0, b1.axisX0)     // ← 写死的 ±8 就漏在这里
      chk(`带${i} 界标右`, b.axisX1, b1.axisX1)
      chk(`带${i} 轴线左`, b.lineX0, b1.lineX0)     // 轴线越过信标的那一小截同样得随倍率走
      chk(`带${i} 轴线右`, b.lineX1, b1.lineX1)
      chk(`带${i} 带底Y`, b.y1, b1.y1)
      b.rowY.forEach((v, j) => chk(`带${i} 行${j}Y`, v, b1.rowY[j]))
      b.breaks.forEach((br, j) => { chk(`带${i} 断口${j}中`, br.xMid, b1.breaks[j].xMid); chk(`带${i} 断口${j}点径`, br.dotR, b1.breaks[j].dotR) })
    })
    ok(`${k}× 频带几何整体放大`, !bad, bad)

    bad = ''
    Lk.blocks.forEach((b, i) => {
      const b1 = L1.blocks[i]
      chk(`块${i} x`, b.x, b1.x); chk(`块${i} y`, b.y, b1.y)
      chk(`块${i} 宽`, b.w, b1.w); chk(`块${i} 高`, b.h, b1.h)
      chk(`块${i} 标注Y`, b.labelY, b1.labelY)
    })
    ok(`${k}× 色块整体放大`, !bad, bad)

    bad = ''
    Lk.legend.items.forEach((it, i) => { chk(`图例${i} x`, it.x, L1.legend.items[i].x); chk(`图例${i} y`, it.y, L1.legend.items[i].y) })
    chk('信标注记Y', Lk.loY, L1.loY)
    ok(`${k}× 图例与注记整体放大`, !bad, bad)

    // 右侧留白同样要放大 —— 不放大的话末端那个频率数字（居中在 axisX1 上）会被画布裁掉半个
    const rightPad = Lk.width - Math.max(...Lk.bands.map((b) => b.axisX1))
    ok(`${k}× 末端标注不出画布`, rightPad > Lk.style.fontSize * 2, `右留白 ${rightPad.toFixed(1)}px`)
  }

  // 箭头：自绘三角，头随倍率线性放大（marker 那条路是 scale² —— 4× 图上大 16 倍）
  const headOf = (svg) => {
    const m = /<path d="M([-\d.]+),[-\d.]+ L([-\d.]+),/.exec(svg)
    return m ? Number(m[2]) - Number(m[1]) : NaN
  }
  const h1 = headOf(toSvg(plan, { width: 1240 })), h4 = headOf(toSvg(plan, { width: 1240 }, 4))
  ok('箭头头部随倍率线性放大', near(h4, h1 * 4, 1e-6), `${h1} → ${h4}`)
  ok('箭头不再走 marker（避开 markerUnits 那一次连乘）', !/<marker\b/.test(toSvg(plan, { width: 1240 }, 4)))

  // 信标那行注记：屏上与导出同一份文字，且没有信标时不占那一行
  ok('信标注记进图', toSvg(plan, { width: 1240 }).includes('BEACON: BCN 12500 MHz'))
  ok('信标注记文字同源', beaconNoteText(plan, 'MHz').startsWith('BEACON: BCN 12500 MHz'))
  const noBcn = newPlan({ los: [lo] })
  noBcn.channels.push(...genSeries({ count: 3, startFcMHz: 14022, stepMHz: 41.5, bwMHz: 36, loId: lo.id, noPattern: 'C{n}' }))
  ok('没有信标就不留那一行', layout(noBcn, { width: 1240 }).loY === null)
}

/* ---------- ⑩e 导出字体：西文一律 Times New Roman，只有含汉字的那几条才换中文面 ---------- */
{
  // ★ PDF 的字体按「资源」整体选用、不像浏览器逐字形回落：族名串写成 "cjk, tnr, times" 且中文面在前，
  //   svg2pdf 就把整张图（连 UPLINK 与频率数字）都画成黑体。故两个面分开给，逐条文本按有无汉字挑。
  const lo = newLo({ name: 'LO1', valueMHz: 1750 })
  const beam = newBeam({ name: '中星波束', color: '#4472C4', bwMHz: 36 })
  const plan = newPlan({ los: [lo], beams: [beam] })
  plan.channels.push(...genSeries({ count: 3, startFcMHz: 14022, stepMHz: 41.5, bwMHz: 36, pol: 'H', noPattern: 'C{n}', loId: lo.id, beamUpId: beam.id }))

  // 屏上 / PNG：一个衬线栈交给浏览器逐字形回落，TNR 打头
  const png = toSvg(plan, { width: 1200 }, 4)
  ok('PNG 走平台衬线栈（TNR 打头）', /<svg[^>]*font-family="'Times New Roman'/.test(png))
  ok('PNG 不逐条写字体（浏览器自己回落）', !/<text[^>]*font-family=/.test(png))

  // PDF：两个已注册的族名分开给
  const pdf = toSvg(plan, { width: 1200 }, 1, { latin: 'fptnr, times', cjk: 'fpcjk' })
  ok('PDF 根字体 = 嵌入的 TNR', /<svg[^>]*font-family="fptnr, times"/.test(pdf))
  ok('UPLINK 用西文面', /<text[^>]*>UPLINK</.test(pdf) && !/font-family="fpcjk"[^>]*>UPLINK</.test(pdf))
  ok('频率数字用西文面', !/font-family="fpcjk"[^>]*>14022</.test(pdf))
  ok('汉字（波束名）才换中文面', /font-family="fpcjk"[^>]*>中星波束/.test(pdf))
  ok('纯西文的编号不换面', !/font-family="fpcjk"[^>]*>C1</.test(pdf))
  // 拿不到系统中文字体时不写中文面（写了也没注册，反而让 svg2pdf 落到默认字体）
  ok('无中文面时不写 font-family', !/<text[^>]*font-family=/.test(toSvg(plan, { width: 1200 }, 1, { latin: 'times', cjk: '' })))

  // 合成图的总标题 / 段头同样按有无汉字挑面
  const multi = toSvgMulti([plan], { width: 1200, title: '亚太6D 频率计划' }, 1, { latin: 'fptnr, times', cjk: 'fpcjk' })
  ok('合成总标题含汉字 → 中文面', /font-family="fpcjk"[^>]*>亚太6D 频率计划</.test(multi))
}

/* ---------- ⑩f 同排重叠 → 错开分层（叠着画等于把底下那条抹掉）---------- */
{
  // 一条 188 MHz 的宽带转发器压在 C1~C3 上（真实计划里就是这么录的）：原地叠着画的话底下那几条
  // 整个看不见，屏上连点都点不着，读者也数不出到底有几条转发器。
  const lo = newLo({ name: 'LO1', valueMHz: 1750 })
  const mkSix = () => genSeries({ count: 6, startFcMHz: 14022, stepMHz: 41.5, bwMHz: 36, pol: 'H', noPattern: 'C{n}', loId: lo.id })
  const plan = newPlan({ los: [lo] })
  plan.channels.push(...mkSix(), newChannel({ no: 'W', loId: lo.id, up: { fcMHz: 14022, bwMHz: 188, pol: 'H' } }))
  const L = layout(plan, { width: 1200 })
  const up = L.blocks.filter((b) => b.side === 'up')
  const blk = (no) => up.find((b) => b.no === no)

  ok('重叠的那条错到下一层', blk('W').lane === 1)
  ok('表序说了算：先录的留在主排', up.filter((b) => b.no !== 'W').every((b) => b.lane === 0))
  ok('错开后不再压着（整块让开）', blk('W').y >= blk('C1').y + blk('C1').h)
  // 两两不许既横着叠又竖着叠——这才是「每一条都看得见」的完整口径
  const covers = (a, b) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6
  ok('同排两两不相压', up.every((a, i) => up.every((b, j) => j <= i || !covers(a, b))))
  ok('下行同样错开（LO 只是整体平移，不改重叠关系）', L.blocks.find((b) => b.side === 'dn' && b.no === 'W').lane === 1)
  // 每层各给一行频率标注：不分开的话两个同频的数正正糊在一起
  ok('两层的频率标注各占一行', blk('W').labelY !== blk('C1').labelY)
  ok('极化字母居中在整排（不是居中在第一层）',
    near(L.bands[0].rowMidY[0], (blk('C1').y + blk('W').y + blk('W').h) / 2))
  ok('界标画到末层的块底', near(L.bands[0].blocksY1, blk('W').y + blk('W').h))

  const L0 = layout(plan, { width: 1200, stagger: false })
  ok('关掉分层 → 回到原地叠着画', L0.blocks.every((b) => b.lane === 0) && near(L0.blocks[0].y, L0.blocks[6].y))
  ok('分层撑高了图（多出来的那一层要有地方放）', L.height > L0.height)

  // 不重叠的计划一个像素都不许动——分层只在真叠上时才出手
  const plain = newPlan({ los: [lo] })
  plain.channels.push(...mkSix())
  const LP = layout(plain, { width: 1200 }), LP0 = layout(plain, { width: 1200, stagger: false })
  ok('不重叠 → 每排只有一层', LP.bands.every((b) => b.laneCount.every((n) => n === 1)))
  ok('不重叠 → 版式与从前逐点相同',
    LP.height === LP0.height && LP.blocks.every((b, i) => near(b.y, LP0.blocks[i].y) && near(b.labelY, LP0.blocks[i].labelY)))
  // 相邻转发器共一条边不算重叠（算了的话整排一条一条往下错成阶梯）
  const touch = newPlan({ los: [lo] })
  touch.channels.push(...genSeries({ count: 4, startFcMHz: 14022, stepMHz: 36, bwMHz: 36, pol: 'H', loId: lo.id, noPattern: 'T{n}' }))
  ok('共边不算叠', layout(touch, { width: 1200 }).blocks.every((b) => b.lane === 0))

  // 正交极化同频是合法复用：本就分属两排，不该被当成「叠着」再错一层
  const reuse = newPlan({ los: [lo] })
  reuse.channels.push(
    newChannel({ no: 'H1', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'H' } }),
    newChannel({ no: 'V1', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'V' } })
  )
  ok('正交极化各占一排、都不用错层', layout(reuse, { width: 1200 }).blocks.every((b) => b.lane === 0))

  // ★ 层数不许跟着导出倍率走：重叠容差写成死像素的话，4× 图会分出与 1× 不一样的层数 —— 那就不是同一张图了
  for (const k of [2, 4]) {
    const Lk = layout(plan, exportStyle({ width: 1200 }, k))
    let bad = ''
    Lk.blocks.forEach((b, i) => {
      const b1 = L.blocks[i]
      if (!bad && b.lane !== b1.lane) bad = `块${i} 第 ${b.lane} 层 ≠ ${b1.lane}`
      if (!bad && !near(b.y, b1.y * k, 1e-6 * k)) bad = `块${i} y ${b.y} ≠ ${k} × ${b1.y}`
      if (!bad && !near(b.labelY, b1.labelY * k, 1e-6 * k)) bad = `块${i} 标注Y ${b.labelY} ≠ ${k} × ${b1.labelY}`
    })
    ok(`${k}× 分层一样、几何整体放大`, !bad, bad)
  }

  ok('分层后每一条都落笔', ['C1', 'C6', 'W'].every((no) => toSvg(plan, { width: 1200 }).includes(`>${no}<`)))
}

/* ---------- ⑪ 频段猜测 ---------- */
{
  ok('C 段上行', guessBand(5950) === 'C')
  ok('C 段下行', guessBand(3630) === 'C')
  ok('Ku 上行', guessBand(14022) === 'Ku')
  ok('Ku 下行', guessBand(12272) === 'Ku')
  ok('Ka 上行', guessBand(27750) === 'Ka')
  ok('L 段', guessBand(1600) === 'L')
}

/* ---------- ⑪b 链路预算侧的频段判定（11 档，含扩展C/扩展Ku/Ku-BSS）---------- */
{
  // 主判上行：扩展档与标准档的分界只有上行看得出来
  ok('Ku 上行', guessLinkBand(14250, 12500) === 'Ku')
  ok('扩展Ku 上行', guessLinkBand(13850, 11550) === 'ExtKu')
  ok('C 上行', guessLinkBand(6150, 3950) === 'C')
  ok('扩展C 上行', guessLinkBand(6545, 3540) === 'ExtC')
  ok('Ku-BSS 上行', guessLinkBand(17500, 11900) === 'Ku-BSS')
  ok('Ka 上行', guessLinkBand(29500, 19450) === 'Ka')
  // 下行同为 Ku 段，判定必须以上行为准，否则扩展Ku 会被读成 Ku
  ok('上行优先于下行', guessLinkBand(13850, 12500) === 'ExtKu')
  // 只有下行（单向计划）
  ok('无上行退下行 · Ku', guessLinkBand(null, 12500) === 'Ku')
  ok('无上行退下行 · 扩展C', guessLinkBand(undefined, 3540) === 'ExtC')
  // 落在业务频段之间的空隙 → 退回 8 档粗分，不硬塞进最近的一档
  ok('空隙退回粗分', guessLinkBand(22000, null) === 'Ka')
  ok('两侧皆空退回兜底', guessLinkBand(null, null) === 'Ku')

  // 自洽：判出来的档必须是卫星表单「工作频段」下拉的合法值，否则 select 会显示空白
  const BANDS_LB = ['L', 'S', 'X', 'ExtC', 'C', 'ExtKu', 'Ku', 'Ku-BSS', 'Ka', 'Q', 'V']
  const probes = [1600, 2100, 3540, 3950, 6150, 6545, 7250, 8000, 11550, 12500, 13850, 14250, 17500, 19450, 22000, 29500, 42500, 52000]
  ok('输出恒在下拉取值域内', probes.every((f) => BANDS_LB.includes(guessLinkBand(f, null)) && BANDS_LB.includes(guessLinkBand(null, f))))
  // 已知例外：BAND_FREQ 的 Q 档预设是 up=30/dn=42.5（上下行写反了，Q 段实为 37.5~42.5 下行、
  // V 段 47.2~50.2 上行）。按 30 GHz 上行判必得 Ka —— 那是预设表的问题，不在判定表这一侧修。
  ok('Q 档预设按上行判成 Ka（已知例外）', guessLinkBand(30000, 42500) === 'Ka')
}

/* ---------- ⑫ 空计划与边界 ---------- */
{
  const empty = newPlan()
  ok('空计划版式不炸', layout(empty).empty === true)
  ok('空计划出图不炸', toSvg(empty).includes('Frequency plan is empty'))
  ok('空计划校验为空', validatePlan(empty).length === 0)
  ok('空计划容量为零', computeLoading(empty, []).summary.tpTotal === 0)

  // 无 LO 且无显式下行 → 提示，且不产生错误的下行值
  const noLo = newPlan()
  noLo.channels.push(newChannel({ no: 'X', up: { fcMHz: 14000, bwMHz: 36 } }))
  ok('无 LO 无下行 → null', downlinkFc(noLo, noLo.channels[0]) === null)
  ok('无 LO 报 warn', validatePlan(noLo).some((i) => i.code === 'nolo'))
}

/* ---------- ⑬ 波束/带宽组：单位换算 · 带宽继承 · 图例 ---------- */
{
  ok('kHz → MHz', near(bwToMHz(36000, 'kHz'), 36))
  ok('GHz → MHz', near(bwToMHz(1.2, 'GHz'), 1200))
  ok('MHz 原样', near(bwToMHz(36, 'MHz'), 36))
  ok('Hz → MHz', near(bwToMHz(36e6, 'Hz'), 36))
  ok('THz → MHz', near(bwToMHz(0.000036, 'THz'), 36))
  ok('留空 → null', bwToMHz('', 'MHz') === null && bwToMHz(null, 'GHz') === null)
  // ★ 往返不许留浮点噪声：0.1 GHz 若回显成 0.10000000000000002，输入框会被这串数刷掉正在敲的字
  ok('往返 0.1 GHz 无噪声', bwFromMHz(bwToMHz(0.1, 'GHz'), 'GHz') === 0.1)
  ok('往返 250 kHz 无噪声', bwFromMHz(bwToMHz(250, 'kHz'), 'kHz') === 250)
  ok('换单位只换刻度', near(bwFromMHz(bwToMHz(36, 'MHz'), 'kHz'), 36000))
  // ★ 收噪声按有效位、不按绝对位：绝对收到 1e-6 的话，THz 刻度下的 250 kHz（2.5e-7）会被抹成 0
  ok('THz 刻度不把窄带抹成 0', bwFromMHz(0.25, 'THz') === 2.5e-7, String(bwFromMHz(0.25, 'THz')))

  // ★ 图例条目 =「波束名: 带宽」。曾有过一个 code（前缀「A：」），与波束名是同一件事的两种写法，
  //   图例上并排写成「A：中国波束 36 MHz」像是编号没删干净，已去掉。
  //   分隔符是半角冒号：这行标签原样进导出的图，图上系统给的那部分一律西文。
  const g36 = newBeam({ code: 'A', name: '中国波束', bwMHz: 36 })
  ok('图例标签 = 波束名: 带宽', beamLabel(g36) === '中国波束: 36 MHz', beamLabel(g36))
  ok('代号字段已去掉', g36.code === undefined)
  ok('老计划只填了代号 → 代号顶上来当名字', newBeam({ code: 'A', bwMHz: 36 }).name === 'A')
  // ★ 单位是整张图的属性，不是波束的：波束那行原先各带一个单位下拉，与工具栏那个并存，
  //   于是图例能写 kHz 而轴上写 MHz。现在只剩工具栏一处，标签跟着它走。
  ok('图例标签跟随图上单位', beamLabel(newBeam({ name: '信道', bwMHz: 0.25 }), 'kHz') === '信道: 250 kHz')
  ok('波束不再自带单位', newBeam({ bwUnit: 'kHz' }).bwUnit === undefined)
  ok('非法单位归一为 MHz', beamLabel(g36, 'PHz') === '中国波束: 36 MHz')
  ok('老计划无带宽 → 标签退回纯波束名', newBeam({ name: 'X' }).bwMHz === null && beamLabel(newBeam({ name: 'X' })) === 'X')
  // ★ 带宽只有一个数（2026-08-02 拍板）：曾有过上下行两格（dnBwMHz 留空 = 同上行），收发不等宽的
  //   波束在图例上写成「18 / 36 MHz」。收发不等宽是【某条转发器上那一段】的事（占段表两侧各录
  //   各的），标称带宽不在波束身上分两格 —— 同一个量不记两处。
  const gUneq = newBeam({ name: '不等宽', bwMHz: 18, dnBwMHz: 36 })
  ok('下行标称带宽那一格已删', gUneq.dnBwMHz === undefined)
  ok('图例只写一个带宽', beamLabel(gUneq) === '不等宽: 18 MHz', beamLabel(gUneq))
  ok('老计划里的下行标称读进来即丢弃',
    normalizePlan({ beams: [{ id: 'b9', name: 'B', bwMHz: 18, dnBwMHz: 36 }] }).beams[0].dnBwMHz === undefined)

  const lo = newLo({ name: 'LO', valueMHz: 1750 })
  const plan = newPlan({ los: [lo], beams: [g36] })
  const inherit = newChannel({ no: 'C1', loId: lo.id, beamUpId: g36.id, up: { fcMHz: 14022, pol: 'H' } })
  const own = newChannel({ no: 'C2', loId: lo.id, beamUpId: g36.id, up: { fcMHz: 14200, bwMHz: 72, pol: 'H' } })
  plan.channels.push(inherit, own)
  const r1 = resolveChannel(plan, inherit), r2 = resolveChannel(plan, own)
  ok('通道留空 → 取本组标称带宽', near(r1.up.bw, 36))
  ok('继承的带宽同样传到下行', near(r1.dn.bw, 36))
  ok('继承的带宽撑出块宽', near(r1.up.f2 - r1.up.f1, 36))
  ok('继承标记置位', r1.bwFromBeam === true && r2.bwFromBeam === false)
  ok('通道自填压过组标称值', near(r2.up.bw, 72))
  ok('引用出去的转发器带宽含继承值', near(channelToLinkFields(plan, inherit).transponderBandwidth, 36))
  ok('继承后不再报「未给带宽」', !validatePlan(plan).some((i) => i.code === 'nobw'))
  // 自填 72 而波束只占 36 → 不再是「带宽对不上」，而是【这条转发器还有 36 MHz 没分出去】
  // （见「波束占段」：波束带宽就是它在转发器里占的那一段，图上余量画成留白）
  ok('余量报 info', validatePlan(plan).some((i) => i.code === 'segFree' && i.severity === 'info'))
  ok('余量条目写清三个数', /72 MHz，波束占 36 MHz，余 36 MHz/.test(validatePlan(plan).find((i) => i.code === 'segFree').msg),
    validatePlan(plan).find((i) => i.code === 'segFree').msg)
  ok('正好分完不报余量', !validatePlan(plan).some((i) => i.code === 'segFree' && i.refs.includes(inherit.id)))
  ok('余量只是 info，不算错误', errorCount(validatePlan(plan)) === 0)
  ok('摘要认继承带宽', /36~72 MHz/.test(planSummary(plan)), planSummary(plan))

  // 既无组也无自填 → 「未给带宽」照报（继承不能把这条提示吃掉）
  const bare = newPlan()
  bare.channels.push(newChannel({ no: 'X', up: { fcMHz: 14000, pol: 'H' } }))
  ok('无组无自填仍报 nobw', validatePlan(bare).some((i) => i.code === 'nobw'))

  // 图例：条目带上带宽后会变长，一行排不下必须折行
  const many = newPlan({ beams: Array.from({ length: 12 }, (_, i) => newBeam({ name: '区域波束' + i, bwMHz: 36 })) })
  many.channels.push(newChannel({ no: 'A', up: { fcMHz: 14000, bwMHz: 36, pol: 'H' } }))
  const LM = layout(many, { width: 900 })
  ok('图例折行', LM.legend.items.some((it) => it.y > LM.legend.y0))
  ok('图例不越出画布', LM.legend.items.every((it) => it.x + it.sq * 1.6 <= LM.width))
  ok('画布高度含图例全部行', LM.height >= LM.legend.y1)
  ok('图例文字进 SVG', toSvg(many, { width: 900 }).includes('区域波束0: 36 MHz'))
}

/* ---------- ⑮ 单位：五档刻度一处定，频率标注 / 图例 / LO 注记同步 ---------- */
{
  // 小数位随单位走：MHz 2 位（这类图的分辨率是 0.01 MHz），往大刻度换一档补 3 位，往小刻度取整
  ok('MHz 标注留 2 位', fmtFreq(14022.5, 'MHz') === '14022.5', fmtFreq(14022.5, 'MHz'))
  ok('GHz 标注不丢信息', fmtFreq(14022.5, 'GHz') === '14.0225', fmtFreq(14022.5, 'GHz'))
  ok('THz 标注不丢信息', fmtFreq(14022, 'THz') === '0.014022', fmtFreq(14022, 'THz'))
  ok('尾零剪干净', fmtFreq(14000, 'GHz') === '14', fmtFreq(14000, 'GHz'))
  // ★ 剪尾零只在有小数点时剪：整数串上剪会把 14022000 kHz 剪成 14022
  ok('整数串不剪尾零', fmtFreq(14022, 'kHz') === '14022000', fmtFreq(14022, 'kHz'))
  ok('非有限值 → 空串', fmtFreq(null, 'MHz') === '' && fmtFreq(NaN, 'GHz') === '')

  const p = newPlan({ los: [newLo({ name: 'LO1', valueMHz: 1750 })] })
  ok('LO 注记跟随单位', loNoteText(p, 'GHz') === 'LO1: 1.75 GHz', loNoteText(p, 'GHz'))
  ok('LO 缺值写破折号', loNoteText(newPlan({ los: [newLo({ name: 'LO1' })] }), 'MHz') === 'LO1: —')

  // 全图一把刻度：换了单位，轴上的数与图例里的带宽一起换（图例写 kHz 而轴上写 MHz 是老毛病）
  const beam = newBeam({ name: '中国波束', bwMHz: 36 })
  const plan = newPlan({ beams: [beam] })
  plan.channels.push(newChannel({ no: 'A', beamUpId: beam.id, up: { fcMHz: 14022, pol: 'H' } }))
  const svgG = toSvg(plan, { width: 900, unit: 'GHz' })
  ok('轴上的数换到 GHz', svgG.includes('>14.022<'))
  ok('图例带宽同步换到 GHz', svgG.includes('中国波束: 0.036 GHz'))
  const svgK = toSvg(plan, { width: 900, unit: 'kHz' })
  ok('图例带宽同步换到 kHz', svgK.includes('中国波束: 36000 kHz'))
}

/* ---------- ⑮b 一把刻度管整份计划：表 / 检查器 / 批量 / 容量 / 校验 与图上同一个数 ---------- */
//
// ★ 曾经只有【图 + 波束带宽录入】跟工具栏那个下拉走，表与检查器里恒写 MHz：选了 kHz 之后图例写
//   36000、表里写 36，同一个量在同一屏上两个数。刻度是整份计划的属性，界面上每一个频率/带宽格
//   （转发器中心频率、带宽、起止、LO、批量、容量、校验条目）都按它写与读，内部仍只存 MHz。
{
  // 频率与带宽同一对换算函数（两个名字只为读代码时看得出换的是哪个量）
  ok('频率换算与带宽同一把尺', freqFromMHz(14000, 'kHz') === 14000000 && freqToMHz(14000000, 'kHz') === 14000)
  ok('14000 MHz 切到 kHz = 14000000', freqFromMHz(14000, 'kHz') === 14000000)
  ok('14022.5 MHz 切到 GHz 无噪声', freqFromMHz(14022.5, 'GHz') === 14.0225)
  // ★ 录入口往返必须逐位回到原值：回显一个带尾巴的数会把正在敲的字刷掉（见 FreqPlanApp 的草稿）
  for (const [u, v] of [['Hz', 14022500000], ['kHz', 14022500], ['MHz', 14022.5], ['GHz', 14.0225], ['THz', 0.0140225]]) {
    ok(`往返 ${u} 无噪声`, freqFromMHz(freqToMHz(v, u), u) === v, String(freqFromMHz(freqToMHz(v, u), u)))
  }
  ok('留空仍是 null（不是 0）', freqToMHz('', 'kHz') === null && freqToMHz(null, 'GHz') === null)

  // 读数文字：与图上同源（fmtFreq 现在就是它），带单位的那份供 title / 提示语用
  ok('读数与图上同源', fmtFreqNum(14022.5, 'GHz') === fmtFreq(14022.5, 'GHz'))
  ok('带单位读数', fmtFreqU(14022.5, 'kHz') === '14022500 kHz', fmtFreqU(14022.5, 'kHz'))
  ok('缺值读数写破折号', fmtFreqU(null, 'MHz') === '—')

  // 起止两格：录进去的是当前刻度的数（界面换算后交给模型），落到内部仍是 MHz
  const lo = newLo({ name: 'LO1', valueMHz: 1750 })
  const plan = newPlan({ los: [lo] })
  const ch = newChannel({ no: 'C1', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'H' } })
  plan.channels.push(ch)
  const e = channelEdges(plan, ch, 'up')
  ok('起止按刻度显示', freqFromMHz(e.f1, 'kHz') === 14004000 && freqFromMHz(e.f2, 'kHz') === 14040000)
  setChannelEdge(plan, ch, 'up', 'f2', freqToMHz(14041000, 'kHz'))     // 界面在 kHz 档下录「14041000」
  ok('kHz 档录终止 → 内部落 MHz', near(ch.up.bwMHz, 37) && near(ch.up.fcMHz, 14022.5))
  ok('下行跟着走（等式不受刻度影响）', near(downlinkFc(plan, ch), 12272.5))

  // 校验条目：数与单位跟着刻度走（口径不变，只换写法）
  const bad = newPlan({ los: [newLo({ name: 'LO', valueMHz: 1750 })] })
  const b1 = newChannel({ no: 'A', loId: bad.los[0].id, up: { fcMHz: 14000, bwMHz: 36, pol: 'H' } })
  const b2 = newChannel({ no: 'B', loId: bad.los[0].id, up: { fcMHz: 14010, bwMHz: 36, pol: 'H' } })
  bad.channels.push(b1, b2)
  const ovM = validatePlan(bad).find((i) => i.code === 'overlap')
  const ovK = validatePlan(bad, 'kHz').find((i) => i.code === 'overlap')
  ok('校验默认写 MHz', /重叠 26 MHz/.test(ovM.msg), ovM.msg)
  ok('校验跟随刻度', /重叠 26000 kHz/.test(ovK.msg), ovK.msg)
  ok('校验的机器数仍是 MHz', near(ovK.nums.overlapMHz, 26))

  // 摘要：带宽与频带跨度都跟着刻度（跨度原先恒写 GHz —— 一行摘要两个单位，读的人得心算一次）
  ok('摘要默认 MHz', /36 MHz/.test(planSummary(bad)) && /↑13982~14028 MHz/.test(planSummary(bad)), planSummary(bad))
  ok('摘要跟随刻度', /36000 kHz/.test(planSummary(bad, 'kHz')) && /↑13982000~14028000 kHz/.test(planSummary(bad, 'kHz')), planSummary(bad, 'kHz'))

  // 容量规划的提示语同理（数与单位一起换，内部累加仍是 MHz）
  const cap = newPlan()
  cap.channels.push(newChannel({ no: 'T1', up: { fcMHz: 14000, bwMHz: 36, pol: 'H' } }))
  const carriers = [newCarrier({ name: 'CW', channelNo: 'T1', occBwMHz: 40, pwrBwMHz: 10 })]
  const capK = computeLoading(cap, carriers, { unit: 'kHz' })
  const capM = computeLoading(cap, carriers)
  ok('容量提示默认 MHz', /超转发器带宽 36 MHz/.test(capM.transponders[0].issues[0].msg), capM.transponders[0].issues[0].msg)
  ok('容量提示跟随刻度', /超转发器带宽 36000 kHz/.test(capK.transponders[0].issues[0].msg), capK.transponders[0].issues[0].msg)
  ok('容量的数仍是 MHz', near(capK.summary.occupiedBwMHz, 40) && near(capK.summary.totalBwMHz, 36))
}

/* ---------- ⑯ 多波束 = 多色片 ---------- */
{
  const yellow = newBeam({ name: '国土波束', color: '#F2C200', bwMHz: 54 })
  const cyan = newBeam({ name: '南海波束', color: '#4BB3C4' })
  const navy = newBeam({ name: '东部波束', color: '#26215C' })
  const lo = newLo({ name: 'LO', valueMHz: 1750 })
  const plan = newPlan({ los: [lo], beams: [yellow, cyan, navy] })
  const one = newChannel({ no: '1A', loId: lo.id, beamUpIds: [yellow.id], up: { fcMHz: 14022, bwMHz: 54, pol: 'H' } })
  const two = newChannel({ no: '2A', loId: lo.id, beamUpIds: [yellow.id, cyan.id], up: { fcMHz: 14100, bwMHz: 54, pol: 'H' } })
  plan.channels.push(one, two)

  // 集合与「主波束」并存：画图吃集合，按组归类的地方（容量、带宽继承）吃第一个
  const r2 = resolveChannel(plan, two)
  ok('多波束解析成集合', r2.beamsUp.length === 2 && r2.beamsUp[1].id === cyan.id)
  ok('集合按录入顺序（色片自上而下就是这个序）', r2.beamsUp[0].id === yellow.id)
  ok('不再有单值「主波束」口', r2.beamUp === undefined && r2.beamDn === undefined)
  ok('下行留空 → 跟上行同一组', r2.beamsDn.length === 2 && r2.beamsDn[0].id === yellow.id)

  const L = layout(plan, { width: 1000 })
  const b1 = L.blocks.find((b) => b.no === '1A' && b.side === 'up')
  const b2 = L.blocks.find((b) => b.no === '2A' && b.side === 'up')
  ok('单波束 = 一条满高色片', b1.stripes.length === 1 && near(b1.stripes[0].h, b1.h))
  ok('双波束 = 两条色片', b2.stripes.length === 2)
  ok('色片按波束表顺序', b2.stripes[0].color === '#F2C200' && b2.stripes[1].color === '#4BB3C4')
  // ★ 横切不竖切：宽度是带宽的如实映射，竖着切会读成「前半段给 A、后半段给 B」
  ok('色片满宽（切的是高不是宽）', b2.stripes.every((s) => near(s.w, b2.w) && near(s.x, b2.x)))
  ok('色片高度合起来等于块高', near(b2.stripes.reduce((a, s) => a + s.h, 0), b2.h))
  ok('色片首尾贴齐块的上下沿', near(b2.stripes[0].y, b2.y) && near(b2.stripes[1].y + b2.stripes[1].h, b2.y + b2.h))
  ok('提示文字列出全部波束', b2.beam === '国土波束: 54 MHz + 南海波束', b2.beam)

  // 编号一律黑字：只判「字压没压在色片上」，不看片色深浅
  const dark = newChannel({ no: '3A', loId: lo.id, beamUpIds: [navy.id, navy.id], up: { fcMHz: 14200, bwMHz: 54, pol: 'H' } })
  plan.channels.push(dark)
  const L2 = layout(plan, { width: 1000 })
  ok('浅色片配黑字', L2.blocks.find((b) => b.no === '1A' && b.side === 'up').ink === '#111')
  ok('深色片同样黑字', L2.blocks.find((b) => b.no === '3A' && b.side === 'up').ink === '#111')
  ok('同一波束填两遍只算一次', newChannel({ beamUpIds: [navy.id, navy.id] }).beamUpIds.length === 1)

  // 出图：两色都落进 SVG，且描边只压一圈（逐片描边会把一个转发器切成看似两个块）
  const svg = toSvg(plan, { width: 1000 })
  ok('两种波束色都进 SVG', svg.includes('#F2C200') && svg.includes('#4BB3C4'))
  ok('描边层不带填充', svg.includes('fill="none" stroke='))
  // 导出这条路是把 fill 直接写进 <text>（屏上那条被 .fpc-no 的 CSS 接管），编号得是黑的
  const noFills = [...svg.matchAll(/<text[^>]*fill="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
    .filter((m) => /^[123]A$/.test(m[2])).map((m) => m[1])
  ok('编号在导出 SVG 里是黑字', noFills.length >= 3 && noFills.every((c) => c === '#111'), noFills.join(','))

  // 老计划升级：单值 + 可切换 → 合并成一个集合，顺序去重
  const legacy = newChannel({ beamUpId: yellow.id, switchableBeamIds: [cyan.id, yellow.id] })
  ok('老字段合并且去重', legacy.beamUpIds.length === 2 && legacy.beamUpIds[0] === yellow.id && legacy.beamUpIds[1] === cyan.id)

  // 批量生成一次给一组波束
  const gen = genSeries({ count: 3, startFcMHz: 14000, stepMHz: 40, bwMHz: 36, beamUpIds: [yellow.id, cyan.id] })
  ok('批量生成带上整组波束', gen.every((c) => c.beamUpIds.length === 2))

  // 带宽继承：取第一个给了标称值的波束（cyan 没填，yellow 填了 54）
  const inh = newChannel({ no: '4A', loId: lo.id, beamUpIds: [cyan.id, yellow.id], up: { fcMHz: 14300, pol: 'H' } })
  plan.channels.push(inh)
  ok('带宽取第一个有标称值的波束', near(resolveChannel(plan, inh).up.bw, 54))

  // 容量汇总按【波束集合】分组：A+B 的转发器不能并进 A 那一组，否则复用出去的容量被重复计入
  const cap = computeLoading(plan, [])
  const keys = new Set(cap.byBeam.map((g) => g.beamId))
  ok('波束集合各自成组', keys.has(yellow.id) && keys.has(`${yellow.id}|${cyan.id}`))
  ok('多波束的行尾标签写全', cap.transponders.find((t) => t.no === '2A').beam === '国土波束 + 南海波束',
    cap.transponders.find((t) => t.no === '2A').beam)

  // ★ 多选是【分方向】的：几个波束收、一个波束发（反过来即下行广播）都是常态，两侧勾的个数本就可以不一样。
  //   两侧共用一个集合的话，只有「都单选」和「都多选」两种图，画不出下面这两条真实存在的转发器。
  const upMulti = newChannel({ no: '5A', loId: lo.id, beamUpIds: [yellow.id, cyan.id], beamDnIds: [navy.id], up: { fcMHz: 14400, bwMHz: 54, pol: 'H' } })
  const dnMulti = newChannel({ no: '6A', loId: lo.id, beamUpIds: [navy.id], beamDnIds: [yellow.id, cyan.id], up: { fcMHz: 14500, bwMHz: 54, pol: 'H' } })
  plan.channels.push(upMulti, dnMulti)
  const r5 = resolveChannel(plan, upMulti)
  ok('上行多、下行单：两侧各自成集合', r5.beamsUp.length === 2 && r5.beamsDn.length === 1 && r5.beamsDn[0].id === navy.id)
  const L3 = layout(plan, { width: 1000 })
  const blk = (no, side) => L3.blocks.find((b) => b.no === no && b.side === side)
  ok('几收一发：上行两片、下行一片', blk('5A', 'up').stripes.length === 2 && blk('5A', 'dn').stripes.length === 1)
  ok('下行那一片取下行波束的色', blk('5A', 'dn').stripes[0].color === '#26215C')
  ok('一收几发：上行一片、下行两片', blk('6A', 'up').stripes.length === 1 && blk('6A', 'dn').stripes.length === 2)
  ok('两侧的提示文字各写各的', blk('6A', 'dn').beam === '国土波束: 54 MHz + 南海波束' && blk('6A', 'up').beam === '东部波束',
    blk('6A', 'dn').beam)
  // 都不多选（收发各一个波束）仍是最常见的一条，且两侧不必是同一个（cross-strap）
  const cross = newChannel({ no: '7A', loId: lo.id, beamUpIds: [yellow.id], beamDnIds: [navy.id], up: { fcMHz: 14600, bwMHz: 54, pol: 'H' } })
  plan.channels.push(cross)
  const L4 = layout(plan, { width: 1000 })
  const c7u = L4.blocks.find((b) => b.no === '7A' && b.side === 'up')
  const c7d = L4.blocks.find((b) => b.no === '7A' && b.side === 'dn')
  ok('收发各一个波束：两侧各一片、各是各的色', c7u.stripes.length === 1 && c7d.stripes.length === 1
    && c7u.stripes[0].color === '#F2C200' && c7d.stripes[0].color === '#26215C')

  // 批量生成两侧各带各的（一排网关波束上行、用户波束下行的转发器是一次铺出来的）
  const gen2 = genSeries({ count: 3, startFcMHz: 14000, stepMHz: 40, bwMHz: 36, beamUpIds: [yellow.id, cyan.id], beamDnIds: [navy.id] })
  ok('批量生成两侧各带各的', gen2.every((c) => c.beamUpIds.length === 2 && c.beamDnIds.length === 1))
}

/* ---------- ⑰ 合成：多份计划（C / Ku / Ka 各一份）叠成一张完整的频率计划 ---------- */
{
  // 合的是【版式】不是【数据】：每份计划各占一段、各带各的上下行频带与图例。
  // 并进一份计划的话，C 的 6 GHz 与 Ka 的 30 GHz 会被同一根轴拉平，块挤成线。
  const mk = (band, startFc, loVal, bw) => {
    const lo = newLo({ name: 'LO', valueMHz: loVal })
    const beam = newBeam({ name: band + '波束', bwMHz: bw })
    const p = newPlan({ name: `${band} 频段计划`, band, los: [lo], beams: [beam] })
    p.channels.push(...genSeries({
      count: 4, startFcMHz: startFc, stepMHz: bw + 4, bwMHz: bw,
      loId: lo.id, beamUpIds: [beam.id], noPattern: band + '{n}'
    }))
    return p
  }
  const c = mk('C', 5950, 2225, 36)
  const ku = mk('Ku', 14022, 1750, 72)
  const ka = mk('Ka', 29500, 9800, 250)

  const M = layoutMulti([c, ku, ka], { width: 1200 })
  ok('每份计划各占一段', M.sections.length === 3)
  ok('段序 = 入参序', M.sections.map((s) => s.plan.band).join() === 'C,Ku,Ka')
  ok('段与段不重叠', M.sections.every((s, i) => !i || s.dy >= M.sections[i - 1].dy + M.sections[i - 1].L.height))
  ok('总高含末段', M.height >= M.sections[2].dy + M.sections[2].L.height)
  // ★ 段内几何原封不动取自单份 layout —— 合成只是把整段平移，不是另排一套版
  ok('段内几何 = 单份出图的几何', M.sections[0].L.height === layout(c, { width: 1200 }).height)
  ok('默认各段各自的尺子（各自铺满画布）', M.sections[0].L.mhzPerPx !== M.sections[1].L.mhzPerPx)

  // 统一比例尺：同带宽跨频段同宽（取最粗的那把尺，否则量程最宽的一段画到纸外面去）
  const S = layoutMulti([c, ku, ka], { width: 1200, sharedScale: true })
  ok('统一比例尺 → 一把尺子', S.sections.every((s) => near(s.L.mhzPerPx, S.sections[0].L.mhzPerPx)))
  const blkW = (L, no) => L.blocks.find((b) => b.no === no && b.side === 'up').w
  ok('统一后 72 MHz 恰是 36 MHz 的两倍宽', near(blkW(S.sections[1].L, 'Ku1') / blkW(S.sections[0].L, 'C1'), 2, 1e-9))
  ok('统一后仍塞得进画布', S.sections.every((s) => s.L.blocks.every((b) => b.x >= 0 && b.x + b.w <= S.width + 1e-6)))

  const svg = toSvgMulti([c, ku, ka], { width: 1200, title: '亚太6D 频率计划' })
  ok('总标题进 SVG', svg.includes('亚太6D 频率计划'))
  ok('段头写计划名', svg.includes('C 频段计划') && svg.includes('Ka 频段计划'))
  ok('三段的转发器都在', svg.includes('>C1<') && svg.includes('>Ku1<') && svg.includes('>Ka1<'))
  ok('三段的图例都在', svg.includes('C波束: 36 MHz') && svg.includes('Ka波束: 250 MHz'))
  ok('每段整体平移一次', (svg.match(/<g transform="translate\(0,/g) || []).length === 3)
  // ★ 每段各有一只箭头，且头是自绘三角不是 <marker>：marker 的尺寸要再乘一遍线宽，
  //   4× 导出图上就是 16 倍大的黑三角；svg2pdf 又反过来不认 markerUnits，PDF 里的头小一圈。
  ok('各段各有一只箭头（自绘三角）', (svg.match(/<path d="M[-\d.]+,[-\d.]+ L[^"]*Z"/g) || []).length === 3)
  ok('不再用 marker 画箭头', !/<marker\b/.test(svg))
  ok('段头可关', !toSvgMulti([c, ku], { width: 1200, showSectionTitles: false }).includes('Ku 频段计划'))
  ok('标题留空 = 不画标题行', layoutMulti([c], { width: 1200 }).titleY === null)

  // 倍率仍是「按几何重画」，合成图同样不靠 viewBox 缩放（那条路会把线钉成发丝）
  const big = toSvgMulti([c, ku], { width: 1200 }, 4)
  ok('倍率按几何重画', /<svg[^>]*width="4800"/.test(big))
  ok('合成图 4× 无 viewBox', !/viewBox/.test(big))
  const headFs = Number((/font-size="([\d.]+)"[^>]*>C 频段计划</.exec(big) || [])[1])
  ok('段头字号也随倍率（12 × 4 × 1.2）', near(headFs, 12 * 4 * 1.2, 1e-6), headFs)

  // 边界：没选 / 只选一份 / 选到空计划
  ok('空选 → 空态图', toSvgMulti([], { width: 800 }).includes('No frequency plan selected'))
  ok('只选一份也能合成（标题与段头是合成才有的）', toSvgMulti([c], { width: 1200, title: '独一份' }).includes('独一份'))
  const bare = newPlan({ name: '空计划', band: 'X' })
  const MB = layoutMulti([c, bare], { width: 1200 })
  ok('空计划占一段而不是消失', MB.sections.length === 2 && MB.sections[1].L.empty === true)
  ok('空计划段照样有段头', toSvgMulti([c, bare], { width: 1200 }).includes('空计划'))
  ok('空计划不带坏统一比例尺', layoutMulti([c, bare], { width: 1200, sharedScale: true }).sections[0].L.blocks.length === 8)
}

/* ---------- ⑰ 上下行双向联动：LO 定了，改哪一侧另一侧都跟着变 ---------- */
{
  const lo = newLo({ name: 'LO1', valueMHz: 1750 })
  const plan = newPlan({ los: [lo] })
  const ch = newChannel({ no: 'C1', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'H' } })
  plan.channels.push(ch)
  ok('挂了有效 LO → 联动态', isDnLinked(plan, ch) === true)
  ok('取得到 LO 值', near(loValueOf(plan, ch), 1750))

  // 正向（老口径，不许退化）
  setChannelFc(plan, ch, 'up', 14063.5)
  ok('改上行 → 下行跟着变', near(downlinkFc(plan, ch), 12313.5))

  // ★ 反向：改下行 → 上行反解跟着变，且下行【不落值】（仍由等式给出，不存第二份）
  setChannelFc(plan, ch, 'dn', 12272)
  ok('改下行 → 上行反解跟着变', near(ch.up.fcMHz, 14022), '得到 ' + ch.up.fcMHz)
  ok('下行不单独存值', ch.dn.fcMHz === null)
  ok('下行读数就是刚填进去的那个', near(downlinkFc(plan, ch), 12272))
  ok('反向录入不改变联动态', isDnLinked(plan, ch) === true)

  // 中文输入法的全角数字照样落值（不归一的话 Number('１２…') = NaN，整条被吞成 null）
  setChannelFc(plan, ch, 'dn', '１２３１３．５')
  ok('全角数字照样落值', near(ch.up.fcMHz, 14063.5), '得到 ' + ch.up.fcMHz)

  // 清空任一侧 = 这条转发器没有频率（联动态下两个框显示的本就是同一个量）
  setChannelFc(plan, ch, 'dn', '')
  ok('清下行 → 上行同时清空', ch.up.fcMHz === null && downlinkFc(plan, ch) === null)

  // 改 LO 的值：联动态下所有下行整体平移（下行没存值，自然跟着走）
  const p3 = newPlan({ los: [newLo({ id: 'lA', name: 'LO', valueMHz: 1750 })] })
  p3.channels.push(newChannel({ no: 'A', loId: 'lA', up: { fcMHz: 14022 } }))
  p3.los[0].valueMHz = 2300
  ok('改 LO → 下行整体跟着变', near(downlinkFc(p3, p3.channels[0]), 11722))

  // LO 未确定（没挂 / 挂的没填值）→ 两侧各自独立，改下行不去动上行
  const p4 = newPlan()
  const c4 = newChannel({ no: 'B', up: { fcMHz: 14000 } })
  p4.channels.push(c4)
  ok('无 LO → 非联动态', isDnLinked(p4, c4) === false && loValueOf(p4, c4) === null)
  setChannelFc(p4, c4, 'dn', 11000)
  ok('无 LO 时下行独立落值', near(c4.dn.fcMHz, 11000) && near(c4.up.fcMHz, 14000))
  const p5 = newPlan({ los: [newLo({ id: 'lB', name: 'LO' })] })            // LO 建了但没填值
  const c5 = newChannel({ no: 'C', loId: 'lB', up: { fcMHz: 14000 } })
  p5.channels.push(c5)
  ok('LO 没填值 = LO 未确定', isDnLinked(p5, c5) === false)
}

/* ---------- ⑰b cross-strap：解耦是显式开关，不是「填了没填」 ---------- */
{
  const lo = newLo({ name: 'LO3', valueMHz: 1800 })
  const plan = newPlan({ los: [lo] })
  const p1 = newChannel({ no: 'P1', loId: lo.id, up: { fcMHz: 12780, bwMHz: 54, pol: 'V' } })
  plan.channels.push(p1)

  setDnDecoupled(plan, p1, true)
  ok('解耦时把推算值落成显式值（不落的话人得照读数重敲一遍）', near(p1.dn.fcMHz, 10980))
  ok('解耦后不再是联动态', isDnLinked(plan, p1) === false)

  setChannelFc(plan, p1, 'dn', 11230)
  ok('解耦后改下行不动上行', near(p1.dn.fcMHz, 11230) && near(p1.up.fcMHz, 12780))
  setChannelFc(plan, p1, 'up', 12840)
  ok('解耦后改上行不动下行', near(p1.dn.fcMHz, 11230) && near(p1.up.fcMHz, 12840))
  ok('cross-strap 仍报 info 不报 error',
    validatePlan(plan).some((i) => i.code === 'loMismatch' && i.severity === 'info') && errorCount(validatePlan(plan)) === 0)

  setDnDecoupled(plan, p1, false)
  ok('复联 → 清掉显式值回到等式', p1.dn.fcMHz === null && near(downlinkFc(plan, p1), 11040))
}

/* ---------- ⑰c 规范化：两边都填满的老计划 / 外来 JSON 收回联动态 ---------- */
{
  const raw = {
    los: [newLo({ id: 'lo1', name: 'LO', valueMHz: 1750 })],
    channels: [
      newChannel({ no: 'A', loId: 'lo1', up: { fcMHz: 14022 }, dn: { fcMHz: 12272 } }),   // 冗余：= 上行 − LO
      newChannel({ no: 'B', loId: 'lo1', up: { fcMHz: 14022 }, dn: { fcMHz: 12522 } }),   // 真 cross-strap，差 250
      newChannel({ no: 'C', up: { fcMHz: 14022 }, dn: { fcMHz: 12000 } })                 // 没挂 LO，无从判断
    ]
  }
  const p = normalizePlan(raw)
  ok('冗余下行收回联动态', p.channels[0].dn.fcMHz === null && isDnLinked(p, p.channels[0]) === true)
  ok('收回后读数不变', near(downlinkFc(p, p.channels[0]), 12272))
  setChannelFc(p, p.channels[0], 'up', 14063.5)
  ok('收回之后改上行下行才跟着动', near(downlinkFc(p, p.channels[0]), 12313.5))
  ok('真 cross-strap 不被收', near(p.channels[1].dn.fcMHz, 12522))
  ok('无 LO 的显式下行不被收', near(p.channels[2].dn.fcMHz, 12000))
}

/* ---------- ⑰d 等式本身：两个方向 + 浮点噪声 ---------- */
{
  ok('f下 = f上 − LO', near(dnFromUp(14022, 1750), 12272))
  ok('f上 = f下 + LO', near(upFromDn(12272, 1750), 14022))
  ok('缺一个数 → null（不猜）', dnFromUp(14022, null) === null && upFromDn(null, 1750) === null && dnFromUp(null, null) === null)
  // ★ 噪声必须当场收掉：回显一串 12.00500000000011 会把输入框里正在敲的字刷掉，
  //   往返一趟还会把 4090.25 变成 4090.2499999999995（等于悄悄改了值）
  ok('减法噪声收干净', dnFromUp(1762.005, 1750) === 12.005, String(1762.005 - 1750))
  ok('C 段实数减法收干净', dnFromUp(4090.7, 2225) === 1865.7, String(4090.7 - 2225))
  ok('往返一趟回到原数', dnFromUp(upFromDn(4090.25, 2225.15), 2225.15) === 4090.25,
    String(4090.25 + 2225.15 - 2225.15))
  ok('cleanFreq 不动正常值', cleanFreq(12272.15) === 12272.15 && cleanFreq(null) === null)
  // 上变频（LO 填负值）不分支，同一条式子照用
  ok('LO 为负 = 上变频', near(dnFromUp(2200, -3800), 6000) && near(upFromDn(6000, -3800), 2200))
}

/* ---------- ⑰e 起止频率：与「中心 + 带宽」是同一段频带的两种写法 ---------- */
{
  const lo = newLo({ name: 'LO2', valueMHz: 2300 })
  const beam = newBeam({ name: 'B1', bwMHz: 36 })
  const plan = newPlan({ los: [lo], beams: [beam] })
  const w = newChannel({ no: 'W1A', loId: lo.id, up: { fcMHz: 14022, bwMHz: 180, pol: 'H' } })
  plan.channels.push(w)

  // 读数：两端 = 中心 ± 半带宽（上下行各按各自的中心，带宽同宽）
  ok('上行两端 = 中心 ± 半带宽', near(channelEdges(plan, w, 'up').f1, 13932) && near(channelEdges(plan, w, 'up').f2, 14112))
  ok('下行两端跟着 LO 走', near(channelEdges(plan, w, 'dn').f1, 11632) && near(channelEdges(plan, w, 'dn').f2, 11812))

  // 常态：改一端 → 另一端钉住，中心与带宽一并重算（照着一张起止频率表两格填完即落定）
  ok('改起始 → resize', setChannelEdge(plan, w, 'up', 'f1', 14004) === 'resize')
  ok('改起始：终止钉住', near(channelEdges(plan, w, 'up').f2, 14112) && near(w.up.fcMHz, 14058) && near(w.up.bwMHz, 108))
  ok('改终止 → resize', setChannelEdge(plan, w, 'up', 'f2', 14040) === 'resize')
  ok('两格填完落在 14004~14040', near(w.up.fcMHz, 14022) && near(w.up.bwMHz, 36))
  ok('下行随等式跟着走', near(downlinkFc(plan, w), 11722) && near(channelEdges(plan, w, 'dn').f1, 11704))

  // 越过另一端 → 不生成负宽频带，改按「带宽不变、整条频带平移」处理（把一条转发器整段挪走）
  ok('起始越过终止 → shift', setChannelEdge(plan, w, 'up', 'f1', 14100) === 'shift')
  ok('平移后带宽不变、起点即所填', near(w.up.bwMHz, 36) && near(channelEdges(plan, w, 'up').f1, 14100) && near(w.up.fcMHz, 14118))
  ok('终止越过起始 → shift 且同样带宽不变',
    setChannelEdge(plan, w, 'up', 'f2', 14040) === 'shift' && near(w.up.bwMHz, 36) && near(channelEdges(plan, w, 'up').f2, 14040))

  // 空值不落：清一条转发器的频率是中心那一格的事（那里两侧同清），起止两格不吃空值
  const before = { fc: w.up.fcMHz, bw: w.up.bwMHz }
  ok('起止不吃空值', setChannelEdge(plan, w, 'up', 'f1', '') === null && near(w.up.fcMHz, before.fc) && near(w.up.bwMHz, before.bw))

  // 带宽未定（自填与波束组继承都没有）→ 两端无从谈起；此时改一端 = 中心钉住、定出带宽
  const b = newChannel({ no: 'BCN', loId: lo.id, up: { fcMHz: 14500, pol: 'H' } })
  plan.channels.push(b)
  ok('带宽未定 → 两端为 null（不拿中心当零宽频带的两端）',
    channelEdges(plan, b, 'up').f1 === null && channelEdges(plan, b, 'up').f2 === null && channelEdges(plan, b, 'up').fc === 14500)
  ok('带宽未定改一端 → span', setChannelEdge(plan, b, 'up', 'f2', 14500.125) === 'span')
  ok('中心钉住、由这一端定出带宽', near(b.up.fcMHz, 14500) && near(b.up.bwMHz, 0.25))

  // 中心未定 + 带宽已知 → 由这一端落定整条频带
  const c = newChannel({ no: 'N1', loId: lo.id, up: { bwMHz: 40, pol: 'H' } })
  plan.channels.push(c)
  ok('中心未定改起始 → set', setChannelEdge(plan, c, 'up', 'f1', 14000) === 'set')
  ok('由起始 + 带宽落定', near(c.up.fcMHz, 14020) && near(c.up.bwMHz, 40))
  const d = newChannel({ no: 'N2', up: { pol: 'H' } })
  plan.channels.push(d)
  ok('中心与带宽都没有 → 不落值（一端定不出一段频带）',
    setChannelEdge(plan, d, 'up', 'f1', 14000) === null && d.up.fcMHz === null && d.up.bwMHz === null)

  // 从波束/带宽组继承带宽的转发器：改起止会把带宽落成本条自填值，但不许反过来改动波束组
  const g = newChannel({ no: 'G1', loId: lo.id, beamUpIds: [beam.id], up: { fcMHz: 14022, pol: 'H' } })
  plan.channels.push(g)
  ok('继承带宽也算两端', near(uplinkBw(plan, g), 36) && near(channelEdges(plan, g, 'up').f1, 14004))
  setChannelEdge(plan, g, 'up', 'f2', 14058)
  ok('改起止 → 带宽落成本条自填值', near(g.up.bwMHz, 54) && near(g.up.fcMHz, 14031))
  ok('波束组的标称带宽不被改写', near(beam.bwMHz, 36))

  // 下行侧：联动态下改下行起止 = 改这条转发器（上行随等式反解），带宽两侧同宽故落在上行
  const k = newChannel({ no: 'K1', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'H' } })
  plan.channels.push(k)
  ok('改下行起始 → resize', setChannelEdge(plan, k, 'dn', 'f1', 11700) === 'resize')
  ok('下行两端即所填与钉住的那端', near(channelEdges(plan, k, 'dn').f1, 11700) && near(channelEdges(plan, k, 'dn').f2, 11740))
  ok('上行随等式反解（仍只存上行这一个数）', k.dn.fcMHz === null && near(k.up.fcMHz, 14020) && near(k.up.bwMHz, 40))
  ok('上行两端同步跟着走', near(channelEdges(plan, k, 'up').f1, 14000) && near(channelEdges(plan, k, 'up').f2, 14040))

  // 带宽已显式解耦（收发不等宽）→ 改下行起止只动下行那一份带宽
  const m = newChannel({ no: 'M1', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'H' }, dn: { bwMHz: 27 } })
  plan.channels.push(m)
  ok('下行带宽显式 → 两端按下行自己的宽', near(downlinkBw(plan, m), 27) && near(channelEdges(plan, m, 'dn').f1, 11708.5))
  setChannelEdge(plan, m, 'dn', 'f1', 11704)
  ok('只动下行那一份带宽', near(m.dn.bwMHz, 31.5) && near(m.up.bwMHz, 36))
  setChannelBw(plan, m, 'dn', null)
  ok('清掉下行带宽 → 回到跟上行同宽', m.dn.bwMHz === null && near(downlinkBw(plan, m), 36))

  // 浮点：起止一样要当场收噪声（否则往返一趟就把 14004 变成 14003.999999999998）
  const f = newChannel({ no: 'F1', up: { fcMHz: 14022.15, bwMHz: 36.3, pol: 'H' } })
  plan.channels.push(f)
  const e0 = channelEdges(plan, f, 'up')
  ok('两端读数无浮点尾巴', e0.f1 === 14004 && e0.f2 === 14040.3, `${e0.f1} / ${e0.f2}`)
  setChannelEdge(plan, f, 'up', 'f1', e0.f1)
  ok('原值回填不改值', near(f.up.fcMHz, 14022.15) && near(f.up.bwMHz, 36.3))
}

/* ---------- ⑰-2 改带宽钉住起始 · 两端一起给 ---------- */
//
// 界面上那几个带宽格走 anchor='f1'：起始钉住、终止随之走（终止 = 起始 + 带宽）。频率计划表的口径
// 本就是「起始 + 带宽」，且 HTS 里转发器彼此紧排、带宽 = Σ 各波束带宽 —— 往中心两侧对称张缩会顶
// 到前一条上去。波束段那格（setBeamBw）从来就是这一档，两处这才是同一个手感。
{
  const lo = newLo({ name: 'LO2', valueMHz: 2300 })
  const beam = newBeam({ name: 'B1', bwMHz: 36 })
  const plan = newPlan({ los: [lo], beams: [beam] })

  const a = newChannel({ no: 'A1', up: { fcMHz: 14022, bwMHz: 36, pol: 'H' } })
  plan.channels.push(a)
  setChannelBw(plan, a, 'up', 54, 'f1')
  ok('改带宽：起始钉住', near(channelEdges(plan, a, 'up').f1, 14004) && near(a.up.bwMHz, 54) && near(a.up.fcMHz, 14031))
  ok('改带宽：终止随之走', near(channelEdges(plan, a, 'up').f2, 14058))
  setChannelBw(plan, a, 'up', 36)                    // 不给 anchor = 老口径（内部换算走这一档）
  ok('默认仍是中心钉住', near(a.up.fcMHz, 14031) && near(channelEdges(plan, a, 'up').f1, 14013))

  // 继承带宽的那种：起始按【继承来的宽度】算，改完落成本条自填值、不回写波束组
  const g = newChannel({ no: 'G2', beamUpIds: [beam.id], up: { fcMHz: 14022, pol: 'H' } })
  plan.channels.push(g)
  setChannelBw(plan, g, 'up', 72, 'f1')
  ok('继承态改带宽也钉起始', near(channelEdges(plan, g, 'up').f1, 14004) && near(g.up.fcMHz, 14040) && near(g.up.bwMHz, 72))
  ok('波束组的标称带宽不被改写', near(beam.bwMHz, 36))

  // 清空 = 回到随波束/带宽组。那一下改的是「随不随组」，不该顺手把频带挪个位置，故不钉
  setChannelBw(plan, g, 'up', null, 'f1')
  ok('清空带宽不挪频带', g.up.bwMHz === null && near(g.up.fcMHz, 14040) && near(uplinkBw(plan, g), 36))

  // 下行侧：联动态下带宽仍只存一份（落在上行），起始钉的是下行那一端、上行随等式反解
  const k = newChannel({ no: 'K2', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'H' } })
  plan.channels.push(k)
  setChannelBw(plan, k, 'dn', 54, 'f1')
  ok('下行改带宽：下行起始钉住', near(channelEdges(plan, k, 'dn').f1, 11704) && near(channelEdges(plan, k, 'dn').f2, 11758))
  ok('仍只存上行那一份', k.dn.fcMHz === null && k.dn.bwMHz === null && near(k.up.bwMHz, 54) && near(k.up.fcMHz, 14031))

  // 两端一起给：中心与带宽都还没有的条目（波束合成导进来的那种），一端一端录是死路，两端齐了即落定
  const d = newChannel({ no: 'N3', up: { pol: 'H' } })
  plan.channels.push(d)
  ok('一端仍定不出一段频带', setChannelEdge(plan, d, 'up', 'f1', 13932) === null && d.up.fcMHz === null)
  ok('两端一起给 → 落定', setChannelSpan(plan, d, 'up', 13932, 14112) === true)
  ok('落成中心 + 带宽', near(d.up.fcMHz, 14022) && near(d.up.bwMHz, 180))
  const d2 = newChannel({ no: 'N4', up: { pol: 'H' } })
  plan.channels.push(d2)
  ok('顺序录反也认（小的当起始）', setChannelSpan(plan, d2, 'up', 14112, 13932) === true
    && near(d2.up.fcMHz, 14022) && near(d2.up.bwMHz, 180))
  const d3 = newChannel({ no: 'N5', up: { pol: 'H' } })
  plan.channels.push(d3)
  ok('零宽 / 缺一端不落', setChannelSpan(plan, d3, 'up', 14000, 14000) === false
    && setChannelSpan(plan, d3, 'up', 14000, null) === false && d3.up.fcMHz === null)

  // 联动态下两端一起给：落在下行那一侧，上行随等式反解（同 setChannelEdge 的下行分支）
  const s = newChannel({ no: 'S1', loId: lo.id, up: { pol: 'H' } })
  plan.channels.push(s)
  setChannelSpan(plan, s, 'dn', 11632, 11812)
  ok('下行两端一起给 → 上行反解', s.dn.fcMHz === null && near(s.up.fcMHz, 14022) && near(s.up.bwMHz, 180)
    && near(channelEdges(plan, s, 'dn').f1, 11632))
}

/* ---------- ⑱ 图上文字：系统给的那部分一律西文，人录的原样画 ---------- */
{
  // 只看真正落笔的字（<text> 里的内容）：SVG 根标签的 font-family 里带着 '宋体'，
  // 拿整串 SVG 去查中文会永远命中那一处，而它不是图上的字。
  const drawn = (svg) => (svg.match(/<text[^>]*>[^<]*<\/text>/g) || []).map((s) => s.replace(/<[^>]*>/g, '')).join('\n')
  const cjk = /[⺀-鿿＀-￯　-〿]/     // 中日韩字符 + 全角标点（「：」「，」这类）
  const firstCjk = (s) => (cjk.exec(s) || [])[0]

  const lo = newLo({ name: 'LO1', valueMHz: 1750 })
  const beam = newBeam({ name: 'CHINA', bwMHz: 36 })
  const p = newPlan({ name: 'Main Plan', band: 'Ku', los: [lo], beams: [beam] })
  p.channels.push(...genSeries({
    count: 3, startFcMHz: 14022, stepMHz: 40, bwMHz: 36, loId: lo.id, beamUpIds: [beam.id], noPattern: 'K{n}'
  }))
  p.channels.push(newChannel({ no: 'BCN', kind: 'beacon', dn: { fcMHz: 12500, pol: 'H' } }))

  const one = drawn(toSvg(p, { width: 1000 }))
  ok('单份出图不落中文', !cjk.test(one), firstCjk(one))
  const multi = drawn(toSvgMulti([p], { width: 1000, title: 'APSTAR-6D Frequency Plan' }))
  ok('合成出图不落中文', !cjk.test(multi), firstCjk(multi))
  ok('段头的频段前缀是英文', multi.includes('Ku-Band · Main Plan'), multi.split('\n')[0])
  ok('图例分隔符是半角冒号', one.includes('CHINA: 36 MHz'))

  // 空态两处（单份 / 合成）同样是图上的字
  const e1 = drawn(toSvg(newPlan({ name: 'Empty' }), { width: 800 }))
  const e2 = drawn(toSvgMulti([], { width: 800 }))
  ok('单份空态不落中文', !cjk.test(e1), firstCjk(e1))
  ok('合成空态不落中文', !cjk.test(e2), firstCjk(e2))

  // 系统给的默认名同样进图（新建的计划 / 波束不改名就直接出图），故默认值也得是西文
  ok('计划默认名是英文', newPlan().name === 'Frequency Plan')
  ok('波束默认名是英文', newBeam().name === 'Beam')
  ok('默认名的图不落中文', !cjk.test(drawn(toSvgMulti([newPlan({ beams: [newBeam()] })], { width: 800 }))))

  // ★ 反过来：人自己录的中文一个字都不许动（这才是「除非人录的中文」的那一半）
  const zh = newPlan({ name: '中星6B Ku 频率计划', band: 'Ku', los: [newLo({ name: '本振1', valueMHz: 1750 })], beams: [newBeam({ name: '中国波束', bwMHz: 36 })] })
  zh.channels.push(newChannel({ no: '中1', loId: zh.los[0].id, beamUpIds: [zh.beams[0].id], up: { fcMHz: 14022, pol: 'H' } }))
  const zhSvg = drawn(toSvgMulti([zh], { width: 1000, title: '中星6B 频率计划' }))
  ok('人录的计划名照画', zhSvg.includes('中星6B Ku 频率计划'))
  ok('人录的总标题照画', zhSvg.includes('中星6B 频率计划'))
  ok('人录的波束名照画', zhSvg.includes('中国波束: 36 MHz'))
  ok('人录的 LO 名与编号照画', zhSvg.includes('本振1: 1750 MHz') && zhSvg.includes('中1'))
}

/* ---------- ㉑ 波束占段：HTS 频分占用 ⇄ 常规同频共用 ---------- */
{
  // 中星26 的真实关系：一条前向转发器 880 MHz = 波束2(440) + 波束5(440)；854 = 440 + 207 + 207。
  // 转发器带宽 = Σ 各波束带宽 —— 波束的带宽就是它在这条转发器里占的那一段。
  const b440a = newBeam({ name: 'B2', color: '#4472C4', bwMHz: 440 })
  const b440b = newBeam({ name: 'B5', color: '#E03C31', bwMHz: 440 })
  const b207a = newBeam({ name: 'B61', color: '#F2C200', bwMHz: 207 })
  const b207b = newBeam({ name: 'B14', color: '#2E9E5B', bwMHz: 207 })
  const plan = newPlan({ beams: [b440a, b440b, b207a, b207b] })
  const t1 = newChannel({ no: 'T1', beamUpIds: [b440a.id, b440b.id], up: { fcMHz: 19980, bwMHz: 880, pol: 'R' } })
  const t11 = newChannel({ no: 'T11', beamUpIds: [b440a.id, b207a.id, b207b.id], up: { fcMHz: 19980, bwMHz: 854, pol: 'L' } })
  plan.channels.push(t1, t11)

  const s1 = beamSegs(plan, t1, 'up')
  ok('880 = 440 + 440：两段', s1.length === 2)
  ok('第一段贴频带下边沿', near(s1[0].f1, 19540) && near(s1[0].f2, 19980), `${s1[0].f1}~${s1[0].f2}`)
  ok('第二段紧接第一段', near(s1[1].f1, 19980) && near(s1[1].f2, 20420))
  ok('自动紧排（两项都是算出来的）', s1.every((g) => g.autoOff && g.autoBw && !g.full))
  const s11 = beamSegs(plan, t11, 'up')
  ok('854 = 440 + 207 + 207：三段依次紧排',
    s11.length === 3 && near(s11[0].bw, 440) && near(s11[1].f1, s11[0].f2) && near(s11[2].f1, s11[1].f2))
  ok('三段正好铺满频带', near(s11[2].f2 - s11[0].f1, 854))
  ok('分完了不报余量', !validatePlan(plan).some((i) => i.code === 'segFree'))

  // ★ 用户截图里的那条：转发器 120、波束只有 36 —— 波束就画 36，余下 84 是留白（未分配）
  const b36 = newBeam({ name: 'Beam 1', color: '#4472C4', bwMHz: 36 })
  const lo = newLo({ name: 'LO1', valueMHz: 1750 })
  const p2 = newPlan({ los: [lo], beams: [b36] })
  const c1 = newChannel({ no: '1', loId: lo.id, beamUpIds: [b36.id], up: { fcMHz: 14250, bwMHz: 120, pol: 'H' } })
  p2.channels.push(c1)
  const g1 = beamSegs(p2, c1, 'up')[0]
  ok('波束只占自己的 36 MHz', near(g1.bw, 36) && near(g1.f1, 14190) && near(g1.f2, 14226), `${g1.f1}~${g1.f2}`)
  const L1 = layout(p2, { width: 1000 })
  const blkU = L1.blocks.find((b) => b.no === '1' && b.side === 'up')
  ok('色片宽 = 块宽 × 36/120', near(blkU.stripes[0].w, blkU.w * 36 / 120, 0.01), `${blkU.stripes[0].w} / ${blkU.w}`)
  ok('色片贴块的左沿且满高', near(blkU.stripes[0].x, blkU.x) && near(blkU.stripes[0].h, blkU.h))
  ok('余下 84 MHz 不铺色（外框仍是整条转发器）', blkU.stripes.length === 1 && blkU.w > blkU.stripes[0].w)
  // 编号压在那截留白上 → ink 交回纸面墨色（写死一个波束色会在浅色纸上看不见）
  ok('留白上的编号取纸面墨色', blkU.ink === null, String(blkU.ink))
  ok('出图里编号用纸面墨色', /fill="#1a1a1a"[^>]*>1</.test(toSvg(p2, { width: 1000 })))
  // 下行侧同一段（整条频带只差一个 LO，段内格局不变）
  const gd = beamSegs(p2, c1, 'dn')[0]
  ok('下行段随 LO 平移', near(gd.f1, 12440) && near(gd.bw, 36), `${gd.f1}`)
  ok('未分配余量报 info', validatePlan(p2).some((i) => i.code === 'segFree'))

  // 装不下 → 整条退回同频共用：老计划（一条 36 落到两个标称 36 的波束上）画出来与从前逐点相同
  const b36b = newBeam({ name: 'Beam 2', color: '#E03C31', bwMHz: 36 })
  p2.beams.push(b36b)
  const c2 = newChannel({ no: '2', loId: lo.id, beamUpIds: [b36.id, b36b.id], up: { fcMHz: 14400, bwMHz: 36, pol: 'H' } })
  p2.channels.push(c2)
  const s2 = beamSegs(p2, c2, 'up')
  ok('装不下 → 两个波束都占满整条', s2.every((g) => g.full && near(g.bw, 36) && near(g.f1, 14382)))
  const L2 = layout(p2, { width: 1000 })
  const blk2 = L2.blocks.find((b) => b.no === '2' && b.side === 'up')
  ok('同频共用仍是横切的满宽色片', blk2.stripes.length === 2
    && blk2.stripes.every((sp) => near(sp.w, blk2.w) && near(sp.x, blk2.x)))
  ok('两片高度合起来是块高', near(blk2.stripes.reduce((a, sp) => a + sp.h, 0), blk2.h))
  ok('同频共用不报余量/重叠', !validatePlan(p2).some((i) => i.refs.includes(c2.id) && (i.code === 'segFree' || i.code === 'segOverlap')))

  // 显式录入：带宽 / 中心 / 起止三种写法，落到同一个偏移上
  setBeamSegBw(p2, c1, b36.id, 50)
  ok('占段带宽可自填', near(beamSegs(p2, c1, 'up')[0].bw, 50))
  setBeamSegFc(p2, c1, 'up', b36.id, 14280)
  const g2 = beamSegs(p2, c1, 'up')[0]
  ok('按中心频率落段', near(g2.fc, 14280) && near(g2.f1, 14255) && near(g2.f2, 14305))
  ok('偏移存的是相对量', near(c1.beamSeg[b36.id].offMHz, 65), String(c1.beamSeg[b36.id].offMHz))
  // 整条转发器挪 100 MHz：段跟着走（偏移不变）——存绝对频率的话这里就散了
  setChannelFc(p2, c1, 'up', 14350)
  ok('转发器一挪，段跟着走', near(beamSegs(p2, c1, 'up')[0].fc, 14380))
  setChannelFc(p2, c1, 'up', 14250)
  // 下行那一侧有自己的一份（留空 = 随上行）：从下行录入只动下行，上行钉着不动
  setBeamSegFc(p2, c1, 'dn', b36.id, 12500)
  ok('从下行录入只动下行那一份', near(beamSegs(p2, c1, 'up')[0].fc, 14280) && near(beamSegs(p2, c1, 'dn')[0].fc, 12500))
  ok('清下行 = 回到随上行（整段随 LO 平移）',
    setBeamSegEdge(p2, c1, 'dn', b36.id, 'f1', null) === 'clear' && near(beamSegs(p2, c1, 'dn')[0].fc, 12530))
  ok('改一端 → 另一端钉住', setBeamSegEdge(p2, c1, 'up', b36.id, 'f1', 14230) === 'resize'
    && near(beamSegs(p2, c1, 'up')[0].f1, 14230) && near(beamSegs(p2, c1, 'up')[0].f2, 14305))
  ok('越过另一端 → 整段平移', setBeamSegEdge(p2, c1, 'up', b36.id, 'f1', 14320) === 'shift'
    && near(beamSegs(p2, c1, 'up')[0].bw, 75) && near(beamSegs(p2, c1, 'up')[0].f1, 14320))
  // 探出频带 / 与别人重叠都要出声（图上被钳在块内，不报就看不出来）
  ok('探出频带报 segOut', validatePlan(p2).some((i) => i.code === 'segOut'))
  setBeamSegBw(p2, c1, b36.id, null)
  setBeamSegFc(p2, c1, 'up', b36.id, null)
  ok('两项都清空 → 占段表里不留空壳', c1.beamSeg[b36.id] === undefined)
  ok('清空后回到自动紧排', beamSegs(p2, c1, 'up')[0].autoOff && near(beamSegs(p2, c1, 'up')[0].bw, 36))

  // 显式设过就一律按段画（哪怕装不下）：同频共用是「没人设过」时的回退，不是压过显式设置的规则
  setBeamSegFc(p2, c2, 'up', b36b.id, 14400)
  ok('没录过的接在录过的之后排', near(beamSegs(p2, c2, 'up').find((g) => g.beam.id === b36.id).f1, 14418),
    String(beamSegs(p2, c2, 'up').find((g) => g.beam.id === b36.id).f1))
  setBeamSegFc(p2, c2, 'up', b36.id, 14400)          // 两个都录在同一段上 = 真的压在一起
  const s2b = beamSegs(p2, c2, 'up')
  ok('设过之后不再回退满宽', s2b.every((g) => !g.full))
  ok('两段压在一起 → 报重叠', validatePlan(p2).some((i) => i.code === 'segOverlap' && i.refs.includes(c2.id)))
  const L3 = layout(p2, { width: 1000 })
  const blk2b = L3.blocks.find((b) => b.no === '2' && b.side === 'up')
  ok('重叠的两段仍错开分层（叠着画等于抹掉一个）', blk2b.stripes.length === 2
    && !near(blk2b.stripes[0].y, blk2b.stripes[1].y))

  // 归一化：波束从通道上摘掉后，占段表里的那条一并清掉（留着会让这条转发器再也回不到同频共用）
  const raw = JSON.parse(JSON.stringify(p2))
  raw.channels[1].beamUpIds = [b36.id]
  const norm = normalizePlan(raw)
  ok('摘掉波束后占段条目清掉', norm.channels[1].beamSeg[b36b.id] === undefined)

  // 波束没给标称带宽 → 占满整条（老计划的常态，画法逐点不变）
  const bare = newBeam({ name: 'X' })
  const p3 = newPlan({ beams: [bare] })
  const c3 = newChannel({ no: 'A', beamUpIds: [bare.id], up: { fcMHz: 14000, bwMHz: 36, pol: 'H' } })
  p3.channels.push(c3)
  ok('无标称带宽 → 占满', beamSegs(p3, c3, 'up')[0].full === true)
  ok('无标称带宽不报余量', !validatePlan(p3).some((i) => i.code === 'segFree'))
}

/* ---------- ㉒ 转发器占段：起止在【这条转发器】上逐波束录 ---------- */
{
  // 段位是转发器的属性，不是波束的：人一次编排一条转发器，「这条 36 分给谁、各占哪一截」
  // 在那条转发器上一眼看得全。三格恒自洽：只存 偏移 + 带宽，终止是算出来的。
  const lo = newLo({ name: 'LO1', valueMHz: 1750 })
  const bA = newBeam({ name: 'A', color: '#4472C4', bwMHz: 36 })
  const bB = newBeam({ name: 'B', color: '#E03C31', bwMHz: 84 })
  const p = newPlan({ los: [lo], beams: [bA, bB] })
  const c = newChannel({ no: '1', loId: lo.id, beamUpIds: [bA.id, bB.id], up: { fcMHz: 14250, bwMHz: 120, pol: 'H' } })
  p.channels.push(c)                                     // 上行 14190~14310
  const seg = (side, id) => beamSegs(p, c, side).find((g) => g.beam.id === id)

  ok('没录过 → 自动排布（人人有带宽且装得下 = 频分）', seg('up', bA.id).from === 'tile'
    && near(seg('up', bA.id).f1, 14190) && near(seg('up', bB.id).f1, 14226))
  ok('自动排出来的算「算出来的」', seg('up', bA.id).autoOff === true && seg('up', bA.id).autoBw === true)

  // 四条分支：改起始 / 改终止 / 越过另一端 / 清空
  ok('改起始 → 终止钉住、带宽随之变', setBeamSegEdge(p, c, 'up', bA.id, 'f1', 14200) === 'resize'
    && near(seg('up', bA.id).f1, 14200) && near(seg('up', bA.id).f2, 14226) && near(seg('up', bA.id).bw, 26))
  ok('改终止 → 起始钉住、带宽随之变', setBeamSegEdge(p, c, 'up', bA.id, 'f2', 14250) === 'resize'
    && near(seg('up', bA.id).f1, 14200) && near(seg('up', bA.id).bw, 50))
  ok('带宽恒 = 终止 − 起始', near(seg('up', bA.id).f2 - seg('up', bA.id).f1, seg('up', bA.id).bw))
  ok('越过另一端 → 带宽不变、整段平移', setBeamSegEdge(p, c, 'up', bA.id, 'f1', 14260) === 'shift'
    && near(seg('up', bA.id).f1, 14260) && near(seg('up', bA.id).bw, 50))
  ok('录过的不再算「自动」', seg('up', bA.id).from === 'seg' && seg('up', bA.id).autoOff === false)
  ok('存的是相对频带下边沿的偏移', near(segOffOf(c, bA.id, 'up'), 70), String(segOffOf(c, bA.id, 'up')))
  ok('清起始 = 回到自动排布', setBeamSegEdge(p, c, 'up', bA.id, 'f1', null) === 'clear'
    && seg('up', bA.id).from === 'tile' && segOffOf(c, bA.id, 'up') === null)
  // 带宽单录：留空 = 回到该波束的标称带宽
  setBeamSegBw(p, c, bA.id, 20)
  ok('占段带宽压过波束标称', near(seg('up', bA.id).bw, 20) && seg('up', bA.id).autoBw === false)
  setBeamSegBw(p, c, bA.id, null)
  ok('清空 = 回到标称带宽', near(seg('up', bA.id).bw, 36) && segBwOf(c, bA.id, 'up') === null)

  // 转发器整条挪走：段是【偏移】，故跟着走（这正是它与「绝对频段」的区别）
  setBeamSegEdge(p, c, 'up', bA.id, 'f1', 14200)
  setChannelFc(p, c, 'up', 14290)                        // 频带整体 +40
  ok('转发器挪走 → 占段跟着走', near(seg('up', bA.id).f1, 14240), String(seg('up', bA.id).f1))
  setChannelFc(p, c, 'up', 14250)

  // 下行：留空 = 随上行（整段随本转发器的 LO 平移）
  ok('下行随上行', near(seg('dn', bA.id).f1, dnFromUp(14200, 1750)) && seg('dn', bA.id).from === 'seg')
  // 下行单独录（cross-strap / 下行重排 / 收发不等宽）：两侧各改各的
  ok('下行单独录 → 落在下行那一份上', setBeamSegEdge(p, c, 'dn', bA.id, 'f1', 12480) === 'shift'
    && near(seg('dn', bA.id).f1, 12480) && near(segOffOf(c, bA.id, 'dn'), 40))
  ok('上行不受下行影响', near(seg('up', bA.id).f1, 14200))
  ok('下行清空 = 回到随上行', setBeamSegEdge(p, c, 'dn', bA.id, 'f1', null) === 'clear'
    && near(seg('dn', bA.id).f1, dnFromUp(14200, 1750)))
  setBeamSegBw(p, c, bA.id, 18, 'dn')
  ok('下行宽度单独录', near(seg('dn', bA.id).bw, 18) && near(seg('up', bA.id).bw, 26))
  setBeamSegBw(p, c, bA.id, null, 'dn')

  // 越界与余量：不钳制，由校验出声
  setBeamSegEdge(p, c, 'up', bA.id, 'f1', 14300)         // 14300~14336，探出 14310
  ok('探出频带 → 报 segOut', validatePlan(p).some((i) => i.code === 'segOut' && i.refs.includes(c.id)))
  setBeamSegBw(p, c, bA.id, null)
  setBeamSegEdge(p, c, 'up', bA.id, 'f1', null)          // 全清 → 回到自动排布
  ok('清干净就回到自动排布', beamSegs(p, c, 'up').every((g) => g.autoOff))
  ok('两段铺满不报余量', !validatePlan(p).some((i) => i.code === 'segFree' && i.refs.includes(c.id)))

  // 存盘往返：四项都存得住；老计划（只有 offMHz/bwMHz）读进来行为不变
  setBeamSegEdge(p, c, 'up', bA.id, 'f1', 14200)
  const back = normalizePlan(JSON.parse(JSON.stringify(p)))
  ok('占段存得住', near(segOffOf(back.channels[0], bA.id, 'up'), 10), String(segOffOf(back.channels[0], bA.id, 'up')))
  const old = normalizePlan({ beams: [{ id: 'b1', name: 'X', bwMHz: 36 }],
    channels: [{ id: 'c1', no: '1', beamUpIds: ['b1'], up: { fcMHz: 14022, bwMHz: 72 }, beamSeg: { b1: { offMHz: 18 } } }] })
  ok('老占段（无下行两项）照读', near(beamSegs(old, old.channels[0], 'up')[0].f1, 14004)
    && old.channels[0].beamSeg.b1.dnOffMHz === null)
}

/* ---------- ㉓ 同频 ≠ 占满：装不下时各占各的带宽，不再一律画成满宽 ---------- */
{
  // 用户截图那条：C1A 36 MHz，挂 Beam 1(18 MHz) + Beam 2(36 MHz)。18 + 36 = 54 装不下 →
  // 从前整条退回「都占满 36」，那个 18 就被画成了假的。现在改成同频叠放：各自贴下边沿、各占各的宽。
  const lo = newLo({ name: 'LO1', valueMHz: 1750 })
  const b18 = newBeam({ name: 'Beam 1', color: '#4472C4', bwMHz: 18 })
  const b36 = newBeam({ name: 'Beam 2', color: '#E03C31', bwMHz: 36 })
  const p = newPlan({ los: [lo], beams: [b18, b36] })
  const c = newChannel({ no: 'C1A', loId: lo.id, beamUpIds: [b18.id, b36.id], up: { fcMHz: 14268, bwMHz: 36, pol: 'R' } })
  p.channels.push(c)
  const sg = beamSegs(p, c, 'up')
  ok('窄的那个只占自己的 18 MHz', near(sg[0].bw, 18) && near(sg[0].f1, 14250) && near(sg[0].f2, 14268),
    `${sg[0].f1}~${sg[0].f2}`)
  ok('窄的那个不算「占满」', sg[0].full === false && sg[0].from === 'stack')
  ok('宽的那个铺满整条 → 仍是同频共用那一片', sg[1].full === true && near(sg[1].bw, 36))
  ok('两段都贴频带下边沿（同频，不是一前一后）', near(sg[0].f1, sg[1].f1))
  const L = layout(p, { width: 1000 })
  const blk = L.blocks.find((x) => x.no === 'C1A' && x.side === 'up')
  ok('图上窄的那片就是半宽', near(blk.stripes[0].w, blk.w / 2, 0.01), `${blk.stripes[0].w} / ${blk.w}`)
  ok('宽的那片满宽', near(blk.stripes[1].w, blk.w, 0.01))
  ok('两片错开分层（叠着画等于抹掉一个）', !near(blk.stripes[0].y, blk.stripes[1].y)
    && near(blk.stripes[0].h + blk.stripes[1].h, blk.h))
  // 同频叠放本就重叠、且合起来铺满了整条 —— 既不该报重叠，也不该报余量
  ok('同频叠放不报重叠', !validatePlan(p).some((i) => i.code === 'segOverlap'))
  ok('铺满了不报余量', !validatePlan(p).some((i) => i.code === 'segFree'))
  // 余量走【并集】：三个 18 全叠在一起 → 36 里只覆盖了 18，那 18 是真留白（相加会算成 54，永远报不出来）
  const b18b = newBeam({ name: 'Beam 3', color: '#F2C200', bwMHz: 18 })
  p.beams.push(b18b)
  const c2 = newChannel({ no: 'C2A', loId: lo.id, beamUpIds: [b18.id, b18b.id], up: { fcMHz: 14308, bwMHz: 36, pol: 'R' } })
  const c3 = newChannel({ no: 'C3A', loId: lo.id, beamUpIds: [b18.id, b18b.id, b36.id], up: { fcMHz: 14348, bwMHz: 36, pol: 'R' } })
  p.channels.push(c2, c3)
  ok('两个 18 装得下 → 紧排（HTS 频分那一路照旧）',
    beamSegs(p, c2, 'up').every((g) => g.from === 'tile') && near(beamSegs(p, c2, 'up')[1].f1, 14308))
  const s3 = beamSegs(p, c3, 'up')
  ok('装不下 → 三个都退回叠放', s3.every((g) => g.from === 'stack'))
  const free3 = validatePlan(p).find((i) => i.code === 'segFree' && i.refs.includes(c3.id))
  ok('并集算余量：18+18+36 叠在一起仍是 36，不报余量', !free3, free3?.msg)
  const c4 = newChannel({ no: 'C4A', loId: lo.id, beamUpIds: [b18.id, b18b.id], up: { fcMHz: 14388, bwMHz: 54, pol: 'L' } })
  p.channels.push(c4)
  const free4 = validatePlan(p).find((i) => i.code === 'segFree' && i.refs.includes(c4.id))
  ok('54 的转发器里两个 18 紧排 → 余 18', free4 && near(free4.nums.freeMHz, 18), free4?.msg)
  // 波束没有标称带宽的那个仍占满（「多宽」无从谈起），另一个照自己的宽度画
  const bare = newBeam({ name: 'X', color: '#2E9E5B' })
  p.beams.push(bare)
  const c5 = newChannel({ no: 'C5A', loId: lo.id, beamUpIds: [b18.id, bare.id], up: { fcMHz: 14428, bwMHz: 36, pol: 'L' } })
  p.channels.push(c5)
  const s5 = beamSegs(p, c5, 'up')
  ok('没标称带宽的占满、有的按自己的宽', s5[0].full === false && near(s5[0].bw, 18) && s5[1].full === true)

  // ★ 一条转发器挂的波束【全部】钉在它的频带外 → 一片都不出，块只剩外框。原先 layout() 在这里
  //   直接取 stripes[0].color 抛 TypeError，整张图断在半路：屏上停在上一帧，看着像「改了没生效」。
  const bFar = newBeam({ name: 'FAR', color: '#8E5BC4', bwMHz: 18 })
  p.beams.push(bFar)
  const c6 = newChannel({ no: 'C6A', loId: lo.id, beamUpIds: [bFar.id], up: { fcMHz: 14468, bwMHz: 36, pol: 'L' } })
  p.channels.push(c6)
  setBeamSegFc(p, c6, 'up', bFar.id, 14259)             // 整段录在频带（14450~14486）之外
  let L6 = null
  try { L6 = layout(p, { width: 1000 }) } catch (e) { L6 = e }
  ok('全在频带外也画得出（不抛）', L6 && !(L6 instanceof Error), String(L6?.message))
  const blk6 = L6?.blocks?.find?.((x) => x.no === 'C6A' && x.side === 'up')
  ok('只剩外框：一片都没有', blk6 && blk6.stripes.length === 0)
  ok('块色回落到占位色（图例不认它）', blk6 && blk6.color === '#5B8FD4' && blk6.ink === null)
  ok('出图同样画得出', /C6A/.test(toSvg(p, { width: 1000 })))
  ok('全在频带外仍报 segOut', validatePlan(p).some((i) => i.code === 'segOut' && i.refs.includes(c6.id)))

  // ★ 一个波束都没归的转发器同样不铺色。原先铺一片默认蓝当占位，与「归了某个恰好是蓝色的波束」
  //   长得一模一样 —— 图上分不出「已分配」与「还没分」。空就画成空（外框仍是整条转发器）。
  const c7 = newChannel({ no: 'C7A', loId: lo.id, up: { fcMHz: 14508, bwMHz: 36, pol: 'L' } })
  p.channels.push(c7)
  const L7 = layout(p, { width: 1000 })
  const blk7u = L7.blocks.find((x) => x.no === 'C7A' && x.side === 'up')
  const blk7d = L7.blocks.find((x) => x.no === 'C7A' && x.side === 'dn')
  ok('没归波束：上行一片都不铺', blk7u && blk7u.stripes.length === 0)
  ok('没归波束：下行同样不铺（下行继承的也是空）', blk7d && blk7d.stripes.length === 0)
  ok('空块编号落到纸面墨色', blk7u && blk7u.ink === null)
  ok('出图里空块只有外框、没有色片', !new RegExp(`fill="#5B8FD4"`).test(toSvg(newPlan({ los: [lo], channels: [c7] }), { width: 1000 })))
}

/* ---------- ㉔ 排布档：自适应 / 频分排布 / 同频叠加 ---------- */
{
  // 「没逐个录过起止的那些波束怎么摆」是【这条转发器】的一个显式档位。自适应 = 老口径。
  const lo = newLo({ name: 'LO1', valueMHz: 1750 })
  const b1 = newBeam({ name: 'A', color: '#4472C4', bwMHz: 18 })
  const b2 = newBeam({ name: 'B', color: '#E03C31', bwMHz: 18 })
  const p = newPlan({ los: [lo], beams: [b1, b2] })
  const c = newChannel({ no: '1', loId: lo.id, beamUpIds: [b1.id, b2.id], up: { fcMHz: 14268, bwMHz: 36, pol: 'H' } })
  p.channels.push(c)                                     // 14250~14286
  const segs = () => beamSegs(p, c, 'up')

  ok('默认是自适应', beamLayoutOf(c) === 'auto' && newChannel({}).beamLayout === 'auto')
  ok('自适应 + 装得下 → 频分排布', segs().every((g) => g.from === 'tile')
    && near(segs()[0].f1, 14250) && near(segs()[1].f1, 14268))
  c.beamLayout = 'stack'
  ok('同频叠加：都贴频带下边沿、各占各的宽', segs().every((g) => g.from === 'stack' && near(g.f1, 14250) && near(g.bw, 18)))
  ok('同频叠加不报重叠（那是它的定义）', !validatePlan(p).some((i) => i.code === 'segOverlap' && i.refs.includes(c.id)))
  const free = validatePlan(p).find((i) => i.code === 'segFree' && i.refs.includes(c.id))
  ok('叠加时余量按并集：36 里只覆盖 18', free && near(free.nums.freeMHz, 18), free?.msg)
  c.beamLayout = 'tile'
  ok('频分排布：依次紧排', segs().every((g) => g.from === 'tile') && near(segs()[1].f1, 14268))
  // 装不下时：自适应退回叠加，频分档照排（探出的由 segOut 出声，不钳制）
  const b3 = newBeam({ name: 'C', color: '#F2C200', bwMHz: 18 })
  p.beams.push(b3)
  c.beamUpIds = [b1.id, b2.id, b3.id]
  ok('频分档装不下也照排', near(segs()[2].f1, 14286) && segs()[2].from === 'tile')
  ok('照排探出频带 → 报 segOut', validatePlan(p).some((i) => i.code === 'segOut' && i.refs.includes(c.id)))
  c.beamLayout = 'auto'
  ok('自适应装不下 → 退回同频叠加', segs().every((g) => g.from === 'stack' && near(g.f1, 14250)))
  ok('退回叠加就不越界了', !validatePlan(p).some((i) => i.code === 'segOut' && i.refs.includes(c.id)))
  // 录过起止的那些一律按录的画，排布档只管没录过的
  setBeamSegEdge(p, c, 'up', b3.id, 'f1', 14268)
  ok('录过的按录的画', segs().find((g) => g.beam.id === b3.id).from === 'seg')
  ok('没录过的接在录过的之后排', segs().find((g) => g.beam.id === b1.id).from === 'tile'
    && near(segs().find((g) => g.beam.id === b1.id).f1, 14286), String(segs().find((g) => g.beam.id === b1.id).f1))
  // 档位存得住 + 挡掉乱值
  const back = normalizePlan(JSON.parse(JSON.stringify(p)))
  ok('档位存得住', beamLayoutOf(back.channels[0]) === 'auto')
  ok('乱值回落到自适应', beamLayoutOf(newChannel({ beamLayout: 'zzz' })) === 'auto')
  ok('三档都有中文名', BEAM_LAYOUTS.length === 3 && BEAM_LAYOUTS.every((L) => L.key && L.label))
}

/* ---------- ㉕ 老计划迁移：波束身上的频段 → 各转发器的占段 ---------- */
{
  // 2026-07-31 至 08-02 那一版把起止录在波束身上（f1MHz/mode/bands + 下行那一套）。
  // 现在录在转发器上，读老计划时一次性换算成偏移落进 beamSeg —— 画出来的图不变。
  const raw = {
    los: [{ id: 'l1', name: 'LO1', valueMHz: 1750 }],
    beams: [
      { id: 'b1', name: 'A', bwMHz: 36, f1MHz: 14000, mode: 'fixed', bands: [{ id: 's1', f1MHz: 14100, bwMHz: null }] },
      { id: 'b2', name: 'B', bwMHz: 18, f1MHz: 14036, mode: 'fixed' },
      { id: 'b3', name: 'C', bwMHz: 36 }                                  // 「随转发器」档 —— 不迁移
    ],
    channels: [
      { id: 'c1', no: '1', loId: 'l1', beamUpIds: ['b1', 'b2'], up: { fcMHz: 14027, bwMHz: 72, pol: 'H' } },   // 13991~14063
      { id: 'c2', no: '2', loId: 'l1', beamUpIds: ['b1'], up: { fcMHz: 14118, bwMHz: 36, pol: 'H' } },   // 14100~14136
      { id: 'c3', no: '3', loId: 'l1', beamUpIds: ['b3'], up: { fcMHz: 14200, bwMHz: 36, pol: 'H' } }
    ]
  }
  const p = normalizePlan(raw)
  ok('波束身上不再有频段字段', p.beams[0].f1MHz === undefined && p.beams[0].mode === undefined
    && p.beams[0].bands === undefined && p.beams[0].dnMode === undefined)
  ok('标称带宽留着', near(p.beams[0].bwMHz, 36) && near(p.beams[1].bwMHz, 18))
  const c1 = p.channels[0], c2 = p.channels[1]
  ok('第 1 段落到它所在的那条转发器上', near(beamSegs(p, c1, 'up')[0].f1, 14000))
  ok('B 的段一并落位', near(beamSegs(p, c1, 'up')[1].f1, 14036))
  ok('第 2 段落到另一条转发器上（按交叠挑）', near(beamSegs(p, c2, 'up')[0].f1, 14100),
    String(beamSegs(p, c2, 'up')[0].f1))
  ok('「随转发器」档的波束不迁移', segOffOf(p.channels[2], 'b3', 'up') === null
    && beamSegs(p, p.channels[2], 'up')[0].autoOff === true)
  ok('下行仍随上行平移', near(beamSegs(p, c1, 'dn')[0].f1, dnFromUp(14000, 1750)))
  ok('迁移完不报越界', !validatePlan(p).some((i) => i.code === 'segOut'))
  // 迁移是幂等的：存盘之后波束上没有那些字段，第二遍读进来一个字都不动
  const again = normalizePlan(JSON.parse(JSON.stringify(p)))
  ok('再读一遍不变', near(segOffOf(again.channels[0], 'b1', 'up'), segOffOf(c1, 'b1', 'up')))

  // 下行单独钉过段的（cross-strap）迁移到下行那一份上
  const raw2 = {
    los: [{ id: 'l1', name: 'LO1', valueMHz: 1750 }],
    beams: [{ id: 'b1', name: 'A', bwMHz: 36, f1MHz: 14000, mode: 'fixed', dnF1MHz: 12300, dnMode: 'fixed' }],
    channels: [{ id: 'c1', no: '1', loId: 'l1', beamUpIds: ['b1'], up: { fcMHz: 14100, bwMHz: 300, pol: 'H' },
      dn: { fcMHz: 12400, bwMHz: 300 } }]
  }
  const q = normalizePlan(raw2)
  ok('下行钉过的落到下行那一份', near(beamSegs(q, q.channels[0], 'dn')[0].f1, 12300),
    String(beamSegs(q, q.channels[0], 'dn')[0].f1))
  ok('上行照旧', near(beamSegs(q, q.channels[0], 'up')[0].f1, 14000))
}

/* ---------- 频率分配表：逐转发器成组 · 起止录入 · 下行按 Δ 换算 ---------- */
{
  const lo = newLo({ name: 'LO', valueMHz: 1750 })
  const plan = newPlan({ los: [lo] })
  const t1 = newChannel({ no: 'C1', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'H' }, dn: { pol: 'V' } })
  // cross-strap：下行显式填、与 LO 无关 —— 载波的下行频率必须按【实测搬移量 Δ】换算，不能拿 LO 顶上
  const t2 = newChannel({ no: 'C2', loId: lo.id, up: { fcMHz: 14100, bwMHz: 36, pol: 'H' }, dn: { fcMHz: 12000, pol: 'V' } })
  plan.channels.push(t1, t2)
  const cs = [
    newCarrier({ name: 'b', channelNo: 'C1', fcMHz: 14020, occBwMHz: 4, pwrBwMHz: 4 }),
    newCarrier({ name: 'a', channelNo: 'C1', fcMHz: 14010, occBwMHz: 6, pwrBwMHz: 3 }),
    newCarrier({ name: 'z', channelNo: 'C1', occBwMHz: 2 }),                  // 未定频
    newCarrier({ name: 'x', channelNo: 'C2', fcMHz: 14090, occBwMHz: 10 }),
    newCarrier({ name: 'u', occBwMHz: 3 })                                    // 未归属转发器
  ]
  const al = buildAllocation(plan, cs)
  const g1 = al.groups.find((g) => g.no === 'C1')
  const g2 = al.groups.find((g) => g.no === 'C2')
  ok('组内按起始频率升序、未定频殿后', g1.rows.map((r) => r.c.name).join() === 'a,b,z', g1.rows.map((r) => r.c.name).join())
  ok('组内序号从 1 起', g1.rows.map((r) => r.idx).join() === '1,2,3')
  ok('起止由中心与占用带宽算出', near(g1.rows[0].up.f1, 14007) && near(g1.rows[0].up.f2, 14013))
  ok('未定频的两端为空', g1.rows[2].up.f1 === null && g1.rows[2].placed === false)
  ok('下行按 LO 换算', near(g1.rows[0].dn.fc, 12260), '得到 ' + g1.rows[0].dn.fc)
  ok('cross-strap 的 Δ 取实测差', near(g2.xlateMHz, 2100) && near(g2.rows[0].dn.fc, 11990), '得到 ' + g2.rows[0].dn.fc)
  ok('占比按转发器带宽', near(g1.rows[0].pctBw, 6 / 36, 1e-9))
  ok('极化留空 = 随转发器', g1.rows[0].pol === 'H' && g1.rows[0].polInherited === true)
  ok('未归属的单成一组挂表末', al.unassigned.length === 1 && al.unassigned[0].c.name === 'u')
  ok('小计仍来自 computeLoading', near(g1.occSum, 12) && near(g1.freeMHz, 24))
  ok('合计与整星汇总同源', near(al.summary.occupiedBwMHz, 22) && al.summary.unassignedCount === 1)

  // 起止录入：四条分支与转发器那两格同名同义（见 freqPlanModel 的 setChannelEdge）
  const c = newCarrier({ name: 'e', fcMHz: 14010, occBwMHz: 6 })
  const r1 = setCarrierEdge(c, 'f1', 14009)            // 终止 14013 钉住 → 中心 14011、带宽 4
  ok('改起始：另一端钉住', r1.mode === 'resize' && near(r1.fcMHz, 14011) && near(r1.occBwMHz, 4))
  const r2 = setCarrierEdge(c, 'f1', 14020)            // 越过终止 → 带宽不变、整条载波平移
  ok('起始越过终止 → 平移', r2.mode === 'shift' && near(r2.fcMHz, 14023) && near(r2.occBwMHz, 6))
  const r3 = setCarrierEdge(newCarrier({ fcMHz: 14010 }), 'f1', 14007)
  ok('带宽未定 → 中心钉住、定出带宽', r3.mode === 'span' && near(r3.fcMHz, 14010) && near(r3.occBwMHz, 6))
  const r4 = setCarrierEdge(newCarrier({ occBwMHz: 6 }), 'f2', 14013)
  ok('中心未定 → 由这一端 + 带宽落定', r4.mode === 'set' && near(r4.fcMHz, 14010) && near(r4.occBwMHz, 6))
  ok('录入不改原载波', near(c.fcMHz, 14010) && near(c.occBwMHz, 6))
  // ★ Number('') 是 0：清空这一格若被当成填了 0，整条载波会被搬到零频去
  ok('空值不落', setCarrierEdge(c, 'f1', '') === null && setCarrierEdge(c, 'f1', null) === null)
  ok('中心与带宽都没有 → 一端定不出一段频带', setCarrierEdge(newCarrier({}), 'f1', 14000) === null)
}

/* ---------- 频率分配表：按 id 归属 · 下行域 · 载波认领波束 ---------- */
//
// 不变式：① 载波挂在【转发器 id】上 —— 编号可以重（一份计划里两条 C1 是常事），按编号归属时
//           第二条永远抢不到自己的载波；老载波只存过编号，退回按编号认第一条同号的；
//        ② 存的恒是【上行】中心频率，side='dn' 只换几何与读数的落脚域（载波身份是它打在哪个
//           频点上，下行随 LO 走）—— 收发不等宽时下行频带不是上行频带的平移，故必须真取下行；
//        ③ 载波认领波束三档：钉死 > 频带被切开的按频率落在哪个占段里 > 同频叠放的取该转发器
//           指定的那一个（carrierBeamId，留空 = 第一个）。★ 没有全局开关：切没切开是转发器
//           自己的事实，同一份计划里两种转发器并存是常态。
{
  const lo = newLo({ name: 'LO', valueMHz: 1750 })
  const plan = newPlan({ los: [lo] })
  // ① 同号两条：编号都叫 C1，靠 id 分开
  const a = newChannel({ no: 'C1', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'H' }, dn: { pol: 'V' } })
  const b = newChannel({ no: 'C1', loId: lo.id, up: { fcMHz: 14063.5, bwMHz: 36, pol: 'V' }, dn: { pol: 'H' } })
  plan.channels.push(a, b)
  const cs = [
    newCarrier({ name: 'x', channelId: a.id, channelNo: 'C1', occBwMHz: 10 }),
    newCarrier({ name: 'y', channelId: b.id, channelNo: 'C1', occBwMHz: 12 }),
    newCarrier({ name: 'old', channelNo: 'C1', occBwMHz: 4 })            // 老载波：只有编号
  ]
  const r = computeLoading(plan, cs)
  const ta = r.transponders.find((t) => t.channelId === a.id)
  const tb = r.transponders.find((t) => t.channelId === b.id)
  ok('同号转发器按 id 各拿各的载波', ta.carriers.length === 2 && tb.carriers.length === 1,
    `${ta.carriers.length} / ${tb.carriers.length}`)
  ok('只存过编号的老载波落在第一条同号的上', ta.carriers.some((c) => c.name === 'old'))
  ok('按 id 归属的没被编号抢走', tb.carriers[0].name === 'y')

  // ② 下行域：频带取下行，越界按下行判，自动排布落在下行域、存回上行
  const p2 = newPlan({ los: [lo] })
  const t1 = newChannel({ no: 'D1', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'H' }, dn: { pol: 'V' } })
  p2.channels.push(t1)
  const dnUp = computeLoading(p2, [], { side: 'dn' }).transponders[0]
  ok('工作侧频带取下行', near(dnUp.f1, 12254) && near(dnUp.f2, 12290), `${dnUp.f1}~${dnUp.f2}`)
  ok('工作侧极化取下行', dnUp.pol === 'V')
  // 上行域看在带内、下行域一样在带内（等宽时两侧只差 Δ）
  const inBand = [newCarrier({ name: 'p', channelId: t1.id, fcMHz: 14010, occBwMHz: 6 })]
  ok('等宽时两侧同判', !computeLoading(p2, inBand, { side: 'dn' }).transponders[0].issues.length)
  const al2 = buildAllocation(p2, inBand, { side: 'dn' })
  ok('工作侧起止写下行', near(al2.groups[0].rows[0].f.f1, 12257) && near(al2.groups[0].rows[0].f.fc, 12260),
    al2.groups[0].rows[0].f.fc)
  ok('上行那一份仍在（导出/回溯要用）', near(al2.groups[0].rows[0].up.fc, 14010))
  const ap = autoPlace(p2, [newCarrier({ name: 'q', channelId: t1.id, occBwMHz: 10 })], { side: 'dn' })
  ok('下行域排布后存回上行', near(ap[0].fcMHz, 14009), '得到 ' + ap[0].fcMHz)

  // 收发不等宽：下行 36、上行 18 —— 下行频带不是上行频带减个 Δ
  const t2 = newChannel({ no: 'D2', loId: lo.id, up: { fcMHz: 14100, bwMHz: 18, pol: 'H' }, dn: { bwMHz: 36, pol: 'V' } })
  p2.channels.push(t2)
  const w = computeLoading(p2, [], { side: 'dn' }).transponders.find((t) => t.no === 'D2')
  ok('收发不等宽时下行频带取下行自己的宽度', near(w.f1, 12332) && near(w.f2, 12368), `${w.f1}~${w.f2}`)
  // 上行域里越界（14100±9 = 14091~14109，载波 14088~14094 探出下边沿）、下行域里没越界
  const wide = [newCarrier({ name: 'w', channelId: t2.id, fcMHz: 14091, occBwMHz: 6 })]
  ok('上行域判越界', computeLoading(p2, wide).transponders.find((t) => t.no === 'D2').issues.some((i) => i.code === 'outOfBand'))
  ok('下行域不判越界', !computeLoading(p2, wide, { side: 'dn' }).transponders.find((t) => t.no === 'D2').issues.some((i) => i.code === 'outOfBand'))

  // 没有下行的转发器：这一侧排不了，核算给出条目而不是静默算错
  const p3 = newPlan()
  const t3 = newChannel({ no: 'N1', up: { fcMHz: 14022, bwMHz: 36, pol: 'H' } })
  p3.channels.push(t3)
  const n = computeLoading(p3, [newCarrier({ name: 'n', channelId: t3.id, occBwMHz: 6 })], { side: 'dn' }).transponders[0]
  ok('没有下行 → 这一侧无频带可核', n.bwMHz === null && n.issues.some((i) => i.code === 'nobw'))
  ok('没有下行 → 自动排布不动它', autoPlace(p3, [newCarrier({ name: 'n', channelId: t3.id, occBwMHz: 6 })], { side: 'dn' })[0].fcMHz === null)

  // ③ 认领波束：一条转发器上两个波束各占一半（DTP 常态）
  const p4 = newPlan({ los: [lo] })
  const A = newBeam({ name: 'A', bwMHz: 18, f1MHz: 14004, mode: 'fixed', color: '#111111' })
  const B = newBeam({ name: 'B', bwMHz: 18, f1MHz: 14022, mode: 'fixed', color: '#222222' })
  p4.beams.push(A, B)
  const t4 = newChannel({ no: 'M1', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'H' }, dn: { pol: 'V' }, beamUpIds: [A.id, B.id] })
  p4.channels.push(t4)
  const cs4 = [
    newCarrier({ name: 'lo1', channelId: t4.id, fcMHz: 14010, occBwMHz: 4 }),   // 下行 12260 → A 那一段
    newCarrier({ name: 'hi1', channelId: t4.id, fcMHz: 14030, occBwMHz: 4 })    // 下行 12280 → B 那一段
  ]
  const segsDn = beamSegs(p4, t4, 'dn')
  ok('两个波束在下行各占一段', segsDn.length === 2 && near(segsDn[0].f1, 12254) && near(segsDn[1].f1, 12272),
    segsDn.map((s) => s.f1).join())
  const fq = buildAllocation(p4, cs4, { side: 'dn' }).groups[0]
  ok('频带切开 → 按频率认领，各归各的那一段（不需要开关）',
    fq.rows[0].beam.id === A.id && fq.rows[1].beam.id === B.id && fq.rows.every((x) => !x.beamPinned),
    fq.rows.map((x) => x.beam.name).join())
  ok('切开的那几段报给界面（条顶色带 = 切点）', fq.splitSegs.length === 2 && near(fq.splitSegs[0].f1, 12254))
  const pinned = buildAllocation(p4, [{ ...cs4[0], beamId: B.id }, cs4[1]], { side: 'dn' }).groups[0]
  ok('钉死压过按频率', pinned.rows[0].beam.id === B.id && pinned.rows[0].beamPinned === true)
  ok('没有波束的转发器认领为空', buildAllocation(p2, inBand, { side: 'dn' }).groups[0].rows[0].beam === null)

  // ③′ 同频叠放（两个波束各占整条频带）：频率上分不出谁是谁 —— 二选一，取该转发器指定的那个
  const p5 = newPlan({ los: [lo] })
  const X = newBeam({ name: 'X', bwMHz: 36, color: '#333333' })
  const Y = newBeam({ name: 'Y', bwMHz: 36, color: '#444444' })
  p5.beams.push(X, Y)
  const t5 = newChannel({ no: 'S1', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'H' }, dn: { pol: 'V' }, beamUpIds: [X.id, Y.id] })
  p5.channels.push(t5)
  const cs5 = [newCarrier({ name: 's1', channelId: t5.id, fcMHz: 14010, occBwMHz: 4 })]
  const st5 = buildAllocation(p5, cs5, { side: 'dn' }).groups[0]
  ok('同频叠放 → 没有可按频率认的段', st5.splitSegs.length === 0 && beamSegs(p5, t5, 'dn').every((s) => s.full))
  ok('同频叠放 → 默认取第一个波束', st5.rows[0].beam.id === X.id && st5.pickBeamId === X.id)
  const st5b = buildAllocation(p5, cs5, { side: 'dn' }).groups[0]
  ok('指定前后一致（纯读取，不改计划）', st5b.rows[0].beam.id === X.id)
  t5.carrierBeamId = Y.id
  const st5c = buildAllocation(p5, cs5, { side: 'dn' }).groups[0]
  ok('指定了另一个 → 整条转发器跟着它', st5c.rows[0].beam.id === Y.id && st5c.pickBeamId === Y.id)
  ok('钉死仍压过转发器指定',
    buildAllocation(p5, [{ ...cs5[0], beamId: X.id }], { side: 'dn' }).groups[0].rows[0].beam.id === X.id)
  t5.carrierBeamId = 'gone'
  ok('指到已删的波束 → 退回第一个', buildAllocation(p5, cs5, { side: 'dn' }).groups[0].rows[0].beam.id === X.id)
  t5.carrierBeamId = ''
  ok('newChannel 带上这个字段（默认留空）', newChannel({}).carrierBeamId === '')

  // ③″ 一个波束钉着【整条】频带：逐格设过占段的转发器不收回同频共用态（full 标志不打），
  //     但铺满整条频带的段照样分不出谁是谁 —— 不能拿它认领，否则另一个波束连选都选不出来
  const p6 = newPlan({ los: [lo] })
  const P = newBeam({ name: 'P', bwMHz: 36, f1MHz: 14004, mode: 'fixed', color: '#555555' })
  const Q = newBeam({ name: 'Q', bwMHz: 36, color: '#666666' })
  p6.beams.push(P, Q)
  const t6 = newChannel({ no: 'W1', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'H' }, dn: { pol: 'V' }, beamUpIds: [P.id, Q.id] })
  p6.channels.push(t6)
  const cs6 = [newCarrier({ name: 'w1', channelId: t6.id, fcMHz: 14010, occBwMHz: 4 })]
  const g6 = buildAllocation(p6, cs6, { side: 'dn' }).groups[0]
  ok('铺满整条频带的段不算「切开」', g6.splitSegs.length === 0, String(beamSegs(p6, t6, 'dn').map((x) => `${x.from}:${x.full}`)))
  ok('于是退回二选一（默认第一个）', g6.rows[0].beam.id === P.id && g6.pickBeamId === P.id)
  t6.carrierBeamId = Q.id
  ok('二选一照样选得动', buildAllocation(p6, cs6, { side: 'dn' }).groups[0].rows[0].beam.id === Q.id)

  // ★ Number(null) 是 0：整条载波复制粘贴时显式传 null 的字段不能落成 0
  const blank = newCarrier({ name: 'z', fcMHz: null, occBwMHz: null, pwrBwMHz: null, infoRateKbps: null })
  ok('显式 null 不落成 0', blank.fcMHz === null && blank.occBwMHz === null && blank.pwrBwMHz === null && blank.infoRateKbps === null)
}

// ---- 从波束合成导入：同色合并成一条（名字 = 它覆盖的波束代号 · 色号 F# 落在来源里）----
//
// 不变式：① 波束代号 = 整星连续编号（同一颗星下各组首尾相接），赋形组不占号；
//        ② **同色合并成一条**（同色 = 同频同极化，频率上是一件事），未配色的逐个成条；
//        ③ 色号不当名字，落在 synth 上（备注那一格已删）；④ 导入来源随计划存盘，重开不丢
//        （老计划没有这个字段 → synth null，行为不变）。
{
  ok('色号 0 基存、F1 起写', fcLabel(0) === 'F1' && fcLabel(15) === 'F16' && fcLabel(null) === '' && fcLabel(-1) === '')
  // 三个起才收成区间：两个连号写成「9-10」与「9,10」一样长，收了反而多一层读法
  ok('代号串连号收成区间', fmtBeamNos([3, 1, 2, 7, 9, 10]) === '1-3,7,9,10', fmtBeamNos([3, 1, 2, 7, 9, 10]))
  ok('两个连号不收', fmtBeamNos([1, 2, 5]) === '1,2,5', fmtBeamNos([1, 2, 5]))
  ok('空表 → 空串', fmtBeamNos(null) === '')

  const b = newBeam({ name: '1,5', synth: { groupId: 'g1', group: '用户波束', fc: 0, nos: [5, 1] } })
  ok('名字 = 覆盖的波束代号', b.name === '1,5')
  ok('代号入库即排序', b.synth.nos.join() === '1,5', b.synth.nos.join())
  ok('来源读数（色号在这里，不另占一格）', beamSynthText(b) === '波束合成「用户波束」 · F1 · 2 个波束：1,5', beamSynthText(b))
  ok('没导入过的波束没有来源', newBeam({ name: 'X' }).synth === null && beamSynthText(newBeam({ name: 'X' })) === '')
  ok('备注那一格已删', newBeam({ name: 'X', note: 'F1' }).note === undefined)
  ok('空壳不算来源', newBeam({ synth: {} }).synth === null)
  ok('脏数据只留能用的', (() => {
    const s = newBeam({ synth: { groupId: 'g', fc: -1, nos: [1, 'x', 0, 2.5, 3] } }).synth
    return s.fc === null && s.nos.join() === '1,3'
  })())

  // 存盘 → 读回（normalizePlan 是外来 JSON 的唯一入口）
  const p = normalizePlan(JSON.parse(JSON.stringify(newPlan({ beams: [b] }))))
  ok('来源随计划存盘', p.beams[0].synth.groupId === 'g1' && p.beams[0].synth.fc === 0
    && p.beams[0].synth.nos.join() === '1,5')
  // 老计划：一个字段都没有 → 读进来行为不变
  const old = normalizePlan({ beams: [{ id: 'b1', name: 'Beam 1', bwMHz: 36 }] }).beams[0]
  ok('老计划无来源字段', old.synth === null)
}

// ---- 波束合成草图 → 导进去是哪几条（loadSynthGroups）----
{
  const store = {
    'globe3d/beamSynth': JSON.stringify({
      v: 2,
      groups: [
        // 同一颗星两组：第 2 组的波束号接着第 1 组往下数（整星连续编号，与 3D 页草图上画的那个数同一套）
        { id: 'g1', satFolder: 'satA', mode: 'gauss', name: '宽波束', beams: [{ id: 'a', fc: 0 }, { id: 'b', fc: 1 }, { id: 'c', fc: 0 }] },
        { id: 'g2', satFolder: 'satA', mode: 'gauss', name: '窄波束', beams: [{ id: 'd', fc: 3 }, { id: 'e' }] },
        // 赋形组没有离散波束：不出现在列表里，也不占号
        { id: 'g3', satFolder: 'satA', mode: 'shaped', name: '赋形', beams: [] },
        { id: 'g4', satFolder: 'satB', mode: 'gauss', name: '另一颗星', beams: [{ id: 'f', fc: 2 }] }
      ]
    })
  }
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null) }
  const gs = loadSynthGroups()
  ok('赋形组不进列表', gs.length === 3 && gs.map((g) => g.id).join() === 'g1,g2,g4', gs.map((g) => g.id).join())
  // g1 = 3 个波束、两个色（波束 1、3 同色）→ 合并成 2 条
  ok('同色合并成一条', gs[0].entries.length === 2, String(gs[0].entries.length))
  ok('一条覆盖多个波束代号', gs[0].entries[0].nos.join() === '1,3', gs[0].entries[0].nos.join())
  ok('条按色号升序、带色', gs[0].entries[1].fc === 1 && gs[0].entries[1].css === fcCss(1))
  ok('第 2 组接着上一组编号', gs[1].entries[0].nos.join() === '4', gs[1].entries[0].nos.join())
  // g2 = 1 个配色 + 1 个未配色 → 未配色的单独成条，排在按色那几条后面，带配对用的 beamId
  ok('未配色的逐个成条', gs[1].entries.length === 2 && gs[1].entries[1].fc === null
    && gs[1].entries[1].nos.join() === '5' && gs[1].entries[1].beamId === 'e' && gs[1].uncolored === 1)
  ok('按色那几条不带 beamId（配对键是色号）', gs[0].entries.every((e) => e.beamId === ''))
  ok('色片按色汇总（给列表用）', gs[0].colors.map((c) => `${c.fc}x${c.count}`).join() === '0x2,1x1')
  ok('另一颗星从 1 起编', gs[2].entries[0].nos.join() === '1')
  ok('赋形组不占号（satA 只数 5 个）', gs[1].beamCount === 2 && gs[0].beamCount === 3)

  store['globe3d/beamSynth'] = 'not json'
  ok('存档坏了 → 空表而不是抛错', loadSynthGroups().length === 0)
  delete globalThis.localStorage
}

/* ---------- ㉚ 标记类载波：信标 / 遥控 / 遥测 ----------
   这三类是不载业务的等幅波：只有【频率 + 极化】、只在一侧（信标与遥测下行、遥控上行）、
   图上画成频率轴上的一根箭头而不是色块。带宽 / 波束 / LO 三项一律不认。 */
{
  ok('三类都是标记类，转发器不是',
    MARK_KINDS.map((k) => k.key).join() === 'beacon,tc,tm' && !isMark({ kind: 'transponder' }) && isMark({ kind: 'tm' }))
  ok('侧别：信标与遥测下行、遥控上行',
    markSide('beacon') === 'dn' && markSide('tm') === 'dn' && markSide('tc') === 'up' && markSide('transponder') === '')

  const lo = newLo({ name: 'LO1', valueMHz: 1750 })
  const beam = newBeam({ name: 'CHN', color: '#4472C4', bwMHz: 36 })
  const p = newPlan({ los: [lo], beams: [beam] })
  p.channels.push(...genSeries({ count: 3, startFcMHz: 14022, stepMHz: 41.5, bwMHz: 36, pol: 'H', noPattern: 'C{n}', loId: lo.id, beamUpIds: [beam.id] }))
  p.channels.push(newChannel({ no: 'B1', kind: 'beacon', dn: { fcMHz: 12500, pol: 'V' } }))
  p.channels.push(newChannel({ no: 'CMD', kind: 'tc', up: { fcMHz: 14498, pol: 'H' } }))

  // ---- 解析：一侧一个点 ----
  const rB = resolveChannel(p, p.channels[3])
  const rC = resolveChannel(p, p.channels[4])
  ok('信标只在下行', rB.mark && rB.up === null && rB.dn && rB.dn.fc === 12500 && rB.dn.pol === 'V')
  ok('遥控只在上行', rC.mark && rC.dn === null && rC.up && rC.up.fc === 14498)
  ok('无带宽 → f1 = f2 = fc（频率上没有宽度）', rB.dn.bw === null && rB.dn.f1 === 12500 && rB.dn.f2 === 12500)
  ok('不归波束、不认 LO', !rB.beamsUp.length && !rB.beamsDn.length && !rB.segsDn.length && rB.lo === null)

  // 带宽与波束填了也不显形（类型改回转发器时它们还在 —— 一次误点不该抹掉一条转发器的带宽）
  const keep = newChannel({ no: 'B2', kind: 'beacon', up: { bwMHz: 36 }, dn: { fcMHz: 12600, bwMHz: 36, pol: 'H' }, beamUpIds: [beam.id] })
  ok('带宽与波束不显形', resolveChannel(p, keep).dn.bw === null && !resolveChannel(p, keep).beamsDn.length)
  ok('但存储里还在', keep.dn.bwMHz === 36 && keep.beamUpIds.length === 1)

  // ---- foldMark：老计划把信标录在上行那一格（那时两侧同画），读进来搬到它该在的那一侧 ----
  const oldP = normalizePlan({
    los: [{ id: 'l1', name: 'LO1', valueMHz: 1750 }],
    channels: [
      { no: 'B', kind: 'beacon', loId: 'l1', up: { fcMHz: 14500, pol: 'H' } },           // 挂着 LO → 取当年画在下行的那个数
      { no: 'B2', kind: 'beacon', up: { fcMHz: 12750, pol: 'R' } },                       // 没挂 LO → 数与极化整个搬过来
      { no: 'CMD', kind: 'tc', dn: { fcMHz: 14498, pol: 'L' } }                           // 遥控录在下行 → 搬到上行
    ]
  })
  const [b1, b2, c1] = oldP.channels
  ok('挂 LO 的老信标按当年画的那个下行数落定', b1.dn.fcMHz === 12750 && b1.up.fcMHz === null && b1.loId === '')
  ok('没挂 LO 的老信标整个搬到下行', b2.dn.fcMHz === 12750 && b2.up.fcMHz === null)
  ok('极化跟着数走（不留另一侧那个默认正交值）', b2.dn.pol === 'R' && c1.up.pol === 'L')
  ok('遥控搬到上行', c1.up.fcMHz === 14498 && c1.dn.fcMHz === null)
  ok('折过一次再折不变（幂等）', foldMark(oldP, b2) && b2.dn.fcMHz === 12750 && b2.up.fcMHz === null)

  // ---- 改类型：频率跟着折到新类型那一侧 ----
  const t = newChannel({ no: 'X', loId: lo.id, up: { fcMHz: 14100, bwMHz: 36, pol: 'H' } })
  const p2 = newPlan({ los: [lo], channels: [t] })
  setChannelKind(p2, p2.channels[0], 'beacon')
  ok('转发器 → 信标：落在下行那个数上', p2.channels[0].dn.fcMHz === 12350 && p2.channels[0].up.fcMHz === null)
  ok('带宽没被抹掉（改回转发器还在）', p2.channels[0].up.bwMHz === 36)

  // ---- 版式：箭头而不是色块 ----
  const L = layout(p, { width: 1240 })
  const blkB = L.blocks.find((b) => b.no === 'B1')
  const blkC = L.blocks.find((b) => b.no === 'CMD')
  const blkT = L.blocks.find((b) => b.no === 'C1' && b.side === 'dn')
  ok('信标只出一个块（下行），遥控只出上行的那个',
    L.blocks.filter((b) => b.no === 'B1').length === 1 && blkB.side === 'dn'
    && L.blocks.filter((b) => b.no === 'CMD').length === 1 && blkC.side === 'up')
  ok('标记块带 mark 与箭头几何，转发器没有', blkB.mark && blkB.markG && !blkT.mark && !blkT.markG)
  ok('箭头横向只占 markW（不按 minBlockW 占 16px）', Math.abs(blkB.w - L.style.markW) < 1e-9, String(blkB.w))
  // 箭头背对基线：上排朝上、下排朝下，箭尖恒指着自己那一行频率标注；全长 = markH，比色块矮一截
  //（信标这类不载业务的小信号画得与转发器等高会读成「一条特别窄的转发器」，还会与界标挤成一团）
  const tipUp = blkB.labelSide === 'above'
  const mkLen = L.style.markH
  ok('箭尾钉在基线那一端', near(blkB.markG.y0, tipUp ? blkB.y + blkB.h : blkB.y, 0.01))
  ok('箭头背对基线、全长 = markH 且不超过一格块高（再长就顶进自己那个标注的字身）',
    near(blkB.markG.y1, tipUp ? blkB.y + blkB.h - mkLen : blkB.y + mkLen, 0.01) && mkLen <= blkB.h,
    `${mkLen} vs 块高 ${blkB.h}`)
  ok('markH 超过块高时钳到块高（不许探进标注行）',
    near(markGeom(blkB, { ...L.style, markH: L.style.blockH * 3 }).y1, tipUp ? blkB.y : blkB.y + blkB.h, 0.01))
  // 命中区跟着箭头走（箭头本身只有几个像素宽，屏上/小程序都点不中），比箭头宽、不高过它
  ok('命中区比箭头宽且与箭头同高', blkB.markG.hit.w > blkB.w && near(blkB.markG.hit.h, mkLen, 0.01)
    && near(blkB.markG.hit.x + blkB.markG.hit.w / 2, blkB.markG.x, 0.01))
  // 落笔坐标收到 2 位小数（同 loArrowGeom），故比到 0.01 为止
  ok('箭头居中在它那个频率上', Math.abs(blkB.markG.x - (blkB.x + blkB.w / 2)) <= 0.005)

  // 界标圈的是【转发器】占的那段频带：信标与遥测遥控本就常排在这段之外，算进来的话界标会被拽到
  // 信标身上，端点标注还与信标自己那个频率标注挤在同一处（同一个频率写两遍）
  const bandDn = L.bands.find((b) => b.side === 'dn')
  const bandUp = L.bands.find((b) => b.side === 'up')
  ok('界标两端只按转发器算', bandDn.guideExt.dataMin === 12254 && bandDn.guideExt.dataMax === 12373,
    `${bandDn.guideExt.dataMin}~${bandDn.guideExt.dataMax}`)
  ok('信标画在界标之外', blkB.x > bandDn.axisX1 && blkC.x > bandUp.axisX1)
  const onlyMk = layout(newPlan({ channels: [newChannel({ no: 'B', kind: 'beacon', dn: { fcMHz: 12500 } })] }), { width: 800 })
  ok('一条转发器都没有 → 界标回落到全带两端', onlyMk.bands[0].guideExt === onlyMk.bands[0].ext)

  // ---- 界标与端点标注给紧贴着的信标让空间（8px 的外挑原先正好顶到箭头上，两者糊成一处）----
  {
    const lo3 = newLo({ name: 'LO', valueMHz: 1750 })
    // 中星那张图的排法：9 条 54 MHz 转发器，下行末端落在 12744，信标就在它外面 6 MHz 处
    const tight = newPlan({ los: [lo3] })
    tight.channels.push(...genSeries({ count: 9, startFcMHz: 14019, stepMHz: 56, bwMHz: 54, pol: 'H', loId: lo3.id, noPattern: 'C{n}A' }))
    tight.channels.push(newChannel({ no: 'BCN', kind: 'beacon', dn: { fcMHz: 12750, pol: 'V' } }))
    const Lt = layout(tight, { width: 1280 })
    const dn = Lt.bands.find((b) => b.side === 'dn')
    const bcn = Lt.blocks.find((b) => b.no === 'BCN')
    ok('界标外挑不顶到箭头上', dn.axisX1 + Lt.style.markClear <= bcn.x + 1e-9,
      `界标 ${dn.axisX1.toFixed(1)} vs 箭头 ${bcn.x.toFixed(1)}`)
    ok('外挑只收不反向（界标不许缩进数据里）', dn.axisX1 >= Lt.x2f(dn, dn.guideExt.dataMax) - 1e-9)
    // ★ 轴线越过信标：界标止于转发器那段，轴线却要画到所有画出来的东西之外 —— 否则信标悬在轴外没有立足处
    const lastSeg = dn.baseSegs[dn.baseSegs.length - 1]
    ok('轴线越过信标（信标站在轴上）', dn.lineX1 >= bcn.x + bcn.w + 1e-9 && lastSeg[1] >= bcn.x + bcn.w,
      `轴线 ${dn.lineX1.toFixed(1)} vs 箭头右缘 ${(bcn.x + bcn.w).toFixed(1)}`)
    ok('轴线不出画布', dn.lineX1 <= Lt.width && dn.lineX0 >= 0, `${dn.lineX0.toFixed(1)} ~ ${dn.lineX1.toFixed(1)}`)
    ok('没有标记的那一带轴线就是界标那两端', near(Lt.bands.find((b) => b.side === 'up').lineX1,
      Lt.bands.find((b) => b.side === 'up').axisX1, 1e-9))
    // 界标竖线本要探出块顶一截，而信标那个数就写在那一截里 —— 压上了就收到块边（且整张图一起收）
    ok('竖线上端收到块顶（不从数字上穿过去）', Lt.bands.every((b) => b.guideY0 > b.rowY[0] - Lt.style.fontSize * 0.5),
      `${(dn.rowY[0] - dn.guideY0).toFixed(1)}px`)
    const bcnLblTop = bcn.labelY + Lt.style.fontSize * 0.9 - Lt.style.fontSize * 0.86 * 0.75
    ok('竖线不进信标那个数的字身', dn.guideY0 > bcnLblTop,
      `竖线顶 ${dn.guideY0.toFixed(1)} vs 字顶 ${bcnLblTop.toFixed(1)}`)
    // 端点标注（12744）与信标自己那个标注（12750）横向撞在一起 → 端点标注那一行加高，两个数才分得开
    const noBcn2 = newPlan({ los: [lo3] })
    noBcn2.channels.push(...genSeries({ count: 9, startFcMHz: 14019, stepMHz: 56, bwMHz: 54, pol: 'H', loId: lo3.id, noPattern: 'C{n}A' }))
    const Ln = layout(noBcn2, { width: 1280 })
    const gapOf = (LL, side) => {
      const b = LL.bands.find((x) => x.side === side)
      return LL.blocks.filter((x) => x.side === side)[0].labelY - b.endLabelY
    }
    ok('标注撞上 → 端点标注那一行加高', gapOf(Lt, 'dn') > gapOf(Ln, 'dn') + 1e-6,
      `${gapOf(Ln, 'dn').toFixed(2)} → ${gapOf(Lt, 'dn').toFixed(2)}`)
    ok('没撞上的那一带版式不变（上行没有信标）', near(gapOf(Lt, 'up'), gapOf(Ln, 'up'), 1e-9))
    ok('没压着数的计划竖线照旧探出一截',
      Ln.bands.every((b) => near(b.guideY0, b.rowY[0] - Ln.style.fontSize * 1.2, 1e-9)))
    // 端头留白按标注实际宽度算：末端那个数（居中在信标上）整个留在纸内，单位换成 kHz 也一样
    for (const unit of ['MHz', 'kHz']) {
      const Lu = layout(tight, { width: 1280, unit })
      const mk = Lu.blocks.find((b) => b.no === 'BCN')
      const half = String(fmtFreq(mk.fc, unit)).length * 0.52 * Lu.style.fontSize * 0.86 / 2
      ok(`末端标注整个留在纸内（${unit}）`, mk.x + mk.w / 2 + half <= Lu.width - 1e-6,
        `${(mk.x + mk.w / 2 + half).toFixed(1)} vs ${Lu.width}`)
    }

    // ---- 「间隔带宽」：给信标在轴上留一格 → 频带端点算到 fc ± n/2 上，信标站进坐标轴之内 ----
    const slotP = JSON.parse(JSON.stringify(tight))
    const bcnCh = slotP.channels.find((c) => c.no === 'BCN')
    bcnCh.dn.slotMHz = 6                                   // 12750 ± 3 → 端点 12753
    const rs = resolveChannel(normalizePlan(slotP), bcnCh)
    ok('解析出 slot，f1/f2 = fc ∓ n/2', rs.dn.slot === 6 && near(rs.dn.f1, 12747, 1e-9) && near(rs.dn.f2, 12753, 1e-9))
    ok('占一格 ≠ 有带宽（仍画箭头、仍不报未给带宽）', rs.dn.bw === null && rs.mark)
    const Ls = layout(slotP, { width: 1280 })
    const dnS = Ls.bands.find((b) => b.side === 'dn')
    const bcnS = Ls.blocks.find((b) => b.no === 'BCN')
    ok('端点标注 = 信标频率 + n/2', near(dnS.guideExt.dataMax, 12753, 1e-9), String(dnS.guideExt.dataMax))
    ok('信标落在界标之内（不再被排在轴外）', bcnS.x + bcnS.w / 2 < dnS.axisX1 - 1e-9 && bcnS.x > dnS.axisX0)
    ok('末端那个数（12753）整个留在纸内',
      dnS.axisX1 + String(fmtFreq(12753, 'MHz')).length * 0.52 * Ls.style.fontSize * 0.86 / 2 <= Ls.width - 1e-6,
      `${dnS.axisX1.toFixed(1)} + 半个数 vs ${Ls.width}`)
    ok('上行那一带不受影响（信标只在下行）', near(Ls.bands.find((b) => b.side === 'up').guideExt.dataMax, 14494, 1e-9))
    // 间隔带宽跟着频率折到它那一侧（老计划把信标录在上行那一格）
    const foldSlot = normalizePlan({ channels: [{ no: 'B', kind: 'beacon', up: { fcMHz: 12750, pol: 'V', slotMHz: 4 } }] })
    ok('折到下行时间隔带宽一并搬过去', foldSlot.channels[0].dn.slotMHz === 4 && foldSlot.channels[0].up.slotMHz === null)
  }

  const svg = toSvg(p, { width: 1240 })
  ok('图上不给标记块画色块外框',
    !new RegExp(`<rect x="${blkB.x.toFixed(2)}" y="${blkB.y.toFixed(2)}"`).test(svg))
  ok('图上画的是那根箭头', svg.includes(`<path d="${blkB.markG.head}"`))

  // 按倍率重画：箭头与色块一样逐点放大（写死的像素数会在这里当场红）
  for (const k of [2, 4]) {
    const Lk = layout(p, exportStyle({ width: 1240 }, k))
    const bk = Lk.blocks.find((b) => b.no === 'B1')
    ok(`${k}× 箭头整体放大`,
      near(bk.markG.x, blkB.markG.x * k, 0.01 * k) && near(bk.markG.y1, blkB.markG.y1 * k, 0.01 * k)
      && near(bk.w, blkB.w * k, 1e-6 * k), `${blkB.markG.x} → ${bk.markG.x}`)
  }
  // 几何只有一份：屏上与导出都取 markGeom，两处各摆一遍必漂
  ok('markGeom 与 layout 里那份同源', markGeom(blkB, L.style).head === blkB.markG.head)

  // ---- 注记那一行：按类型分组，图上那几根箭头只标频率，名字由这一行认领 ----
  const note = beaconNoteText(p, 'MHz')
  ok('注记按类型分组、各冠英文前缀', note.includes('BEACON: B1 12500 MHz V') && note.includes('TC: CMD 14498 MHz H'), note)
  ok('没有的那一类不出前缀', !note.includes('TM'), note)

  // ---- 校验：带宽与 LO 那两条对标记类不成立 ----
  const iss = validatePlan(p, 'MHz')
  ok('不报「未给带宽」', !iss.some((i) => i.code === 'nobw' && i.refs.includes(p.channels[3].id)))
  ok('不报「未指定 LO」', !iss.some((i) => i.code === 'nolo' && i.refs.includes(p.channels[4].id)))
  ok('没给频率的标记类照报', validatePlan(newPlan({ channels: [{ no: 'B', kind: 'beacon' }] }), 'MHz')
    .some((i) => i.code === 'empty'))
  // 落进某条转发器的通带里（同极化）→ 只给位置，判断留给人
  const inBand = newPlan({
    los: [lo],
    channels: [
      newChannel({ no: 'C1', loId: lo.id, up: { fcMHz: 14022, bwMHz: 36, pol: 'H' } }),   // 下行 12254~12290 V
      newChannel({ no: 'B', kind: 'beacon', dn: { fcMHz: 12270, pol: 'V' } }),
      newChannel({ no: 'B2', kind: 'beacon', dn: { fcMHz: 12270, pol: 'H' } })            // 异极化 → 不报
    ]
  })
  const m = validatePlan(inBand, 'MHz').filter((i) => i.code === 'markInBand')
  ok('信标落进同极化通带 → 一条 info', m.length === 1 && m[0].severity === 'info' && m[0].refs.length === 2, String(m.length))
}

console.log(`  ${pass} 通过, ${fail} 失败`)
if (fail) process.exit(1)
