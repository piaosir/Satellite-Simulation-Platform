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
  channelAtFreq, planExtent, toMHz, POL_ORTHO, planSummary, guessBand,
  beamLabel, bwToMHz, bwFromMHz,
  setChannelFc, setDnDecoupled, isDnLinked, loValueOf, dnFromUp, upFromDn, cleanFreq,
  channelEdges, setChannelEdge, setChannelBw, uplinkBw, downlinkBw
} from '../../../src/shared/freqPlanModel.js'
import { computeLoading, autoPlace, newCarrier } from '../../../src/shared/freqPlanCapacity.js'
import { layout, toSvg, fmtFreq, loNoteText, beaconNoteText, layoutMulti, toSvgMulti, exportStyle } from '../../../src/shared/freqPlanRender.js'

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
  plan.channels.push(newChannel({ no: 'BCN', kind: 'beacon', loId: lo.id, up: { fcMHz: 14500, pol: 'H' } }))

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
  ok('信标注记进图', toSvg(plan, { width: 1240 }).includes('BCN: 14500 MHz'))
  ok('信标注记文字同源', beaconNoteText(plan, 'MHz').startsWith('BCN: 14500 MHz'))
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
  ok('自填与组标称不一致报 info', validatePlan(plan).some((i) => i.code === 'beamBwMismatch' && i.severity === 'info'))
  ok('不一致只是 info，不算错误', errorCount(validatePlan(plan)) === 0)
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

  // 编号取黑或白：按「字压在哪几片上」加权，不看整块平均
  const dark = newChannel({ no: '3A', loId: lo.id, beamUpIds: [navy.id, navy.id], up: { fcMHz: 14200, bwMHz: 54, pol: 'H' } })
  plan.channels.push(dark)
  const L2 = layout(plan, { width: 1000 })
  ok('浅色片配黑字', L2.blocks.find((b) => b.no === '1A' && b.side === 'up').ink === '#111')
  ok('深色片配白字', L2.blocks.find((b) => b.no === '3A' && b.side === 'up').ink === '#fff')
  ok('同一波束填两遍只算一次', newChannel({ beamUpIds: [navy.id, navy.id] }).beamUpIds.length === 1)

  // 出图：两色都落进 SVG，且描边只压一圈（逐片描边会把一个转发器切成看似两个块）
  const svg = toSvg(plan, { width: 1000 })
  ok('两种波束色都进 SVG', svg.includes('#F2C200') && svg.includes('#4BB3C4'))
  ok('描边层不带填充', svg.includes('fill="none" stroke='))

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
  p.channels.push(newChannel({ no: 'BCN', kind: 'beacon', loId: lo.id, up: { fcMHz: 14500, pol: 'H' } }))

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

console.log(`  ${pass} 通过, ${fail} 失败`)
if (fail) process.exit(1)
