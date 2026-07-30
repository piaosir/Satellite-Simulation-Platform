// 转发器频率计划：模型 / LO 推算 / 校验 / 容量 / 识图几何核 的自测。运行：npm test
// 被测文件是渲染端 ESM（src/shared/freqPlan*.js），故本测试自身也是 .mjs。
//
// 关键不变式：
//   ① 下行 = 上行 − LO；显式填了 dn.fcMHz 就以填的为准（cross-strap 不能被 LO 覆盖掉）；
//   ② 同侧同极化重叠必报，正交极化重叠不报（那是合法的极化复用，报了就是狼来了）；
//   ③ 序列生成的频率严格等差，交替极化严格正交；
//   ④ inferArithmetic 对含离群点的序列仍取出正确步进（中位差，不是均值）；
//   ⑤ 频率标度最小二乘能剔除离群点后复原真实标度 —— 这是识图「OCR 只要对几个就行」的支点；
//   ⑥ 容量的两条约束各自独立累计，正交极化不合并；
//   ⑦ 引用出去的链路字段单位正确（频率 GHz、带宽 MHz）—— 单位错会静默算错整条链路。
import {
  newPlan, newChannel, newLo, newBeam, normalizePlan, downlinkFc, resolveChannel, resolveAll,
  validatePlan, errorCount, genSeries, inferArithmetic, channelToLinkFields, channelByNo,
  channelAtFreq, planExtent, toMHz, POL_ORTHO, planSummary
} from '../../../src/shared/freqPlanModel.js'
import { computeLoading, autoPlace, newCarrier } from '../../../src/shared/freqPlanCapacity.js'
import { layout, toSvg } from '../../../src/shared/freqPlanRender.js'
import { guessBand, analyzeImage } from '../../../src/shared/freqPlanVision.js'

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

  // 交替极化：C 段那种 LHCP/RHCP 奇偶交错
  const alt = genSeries({ count: 4, startFcMHz: 5950, stepMHz: 40, bwMHz: 36, pol: 'L', polMode: 'alternate', noStart: 3, noStep: 1 })
  ok('交替极化 L,R,L,R', alt.map((c) => c.up.pol).join(',') === 'L,R,L,R')
  ok('交替编号从 3 起', alt.map((c) => c.no).join(',') === '3,4,5,6')
}

/* ---------- ⑥ 等差推断（含离群点） ---------- */
{
  const clean = inferArithmetic([14022, 14063.5, 14105, 14146.5, 14188])
  ok('等差推断步进 41.5', near(clean.step, 41.5, 1e-9))
  ok('干净序列 ok=true', clean.ok === true)

  // 中间一个被 OCR 读错（14105 → 14705）：中位差仍应给出 41.5，并标出离群
  const dirty = inferArithmetic([14022, 14063.5, 14705, 14146.5, 14188])
  ok('含离群仍取到 41.5', near(dirty.step, 41.5, 1e-9), '得到 ' + dirty.step)
  ok('含离群 ok=false', dirty.ok === false)
  ok('离群位置被标出', dirty.outliers.length > 0)
}

/* ---------- ⑦ 频率标度最小二乘（识图的支点）---------- */
{
  // 复刻 fitScale 的调用路径：analyzeImage 内部私有，这里用同一算法验证「离群剔除后复原真标度」。
  // 真标度 f = 0.5·x + 13900，5 个点里第 3 个被污染
  const truth = (x) => 0.5 * x + 13900
  const pts = [50, 100, 150, 200, 250].map((x, i) => ({ x, f: i === 2 ? truth(x) + 400 : truth(x) }))
  // 与 freqPlanVision.fitScale 等价的实现（该函数未导出，此处内联同式验证）
  const fit = (ps) => {
    const n = ps.length
    let sx = 0, sf = 0, sxx = 0, sxf = 0
    for (const p of ps) { sx += p.x; sf += p.f; sxx += p.x * p.x; sxf += p.x * p.f }
    const den = n * sxx - sx * sx
    const a = (n * sxf - sx * sf) / den
    return { a, b: (sf - a * sx) / n }
  }
  let s = fit(pts)
  const resid = pts.map((p) => ({ p, r: Math.abs(s.a * p.x + s.b - p.f) })).sort((u, v) => u.r - v.r)
  s = fit(resid.slice(0, Math.max(2, Math.floor(pts.length * 0.8))).map((u) => u.p))
  ok('标度斜率复原 0.5', near(s.a, 0.5, 1e-9), '得到 ' + s.a)
  ok('标度截距复原 13900', near(s.b, 13900, 1e-6), '得到 ' + s.b)
  // 关键含义：被污染的那一点用几何回代后能被纠回真值
  ok('污染点由几何纠回', near(s.a * 150 + s.b, truth(150), 1e-6))
}

/* ---------- ⑧ 容量：两条约束独立累计 ---------- */
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

/* ---------- ⑨ 自动排布 ---------- */
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

/* ---------- ⑩ 引用出去的链路字段（单位！）---------- */
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

/* ---------- ⑪ 规范化：悬挂引用必须清掉 ---------- */
{
  const lo = newLo({ name: 'LO', valueMHz: 1750 })
  const beam = newBeam({ name: 'CHN' })
  const raw = {
    los: [lo], beams: [beam],
    channels: [newChannel({ no: 'X', loId: 'ghost-lo', beamUpId: 'ghost-beam', switchableBeamIds: ['ghost-beam', beam.id], up: { fcMHz: 14000, bwMHz: 36 } })]
  }
  const p = normalizePlan(raw)
  ok('悬挂 LO 引用被清', p.channels[0].loId === '')
  ok('悬挂波束引用被清', p.channels[0].beamUpId === '')
  ok('可切换波束里只留有效的', p.channels[0].switchableBeamIds.length === 1 && p.channels[0].switchableBeamIds[0] === beam.id)
  ok('normalizePlan 容忍 null', normalizePlan(null).channels.length === 0)
}

/* ---------- ⑫ 版式与出图 ---------- */
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

/* ---------- ⑬ 频段猜测 ---------- */
{
  ok('C 段上行', guessBand(5950) === 'C')
  ok('C 段下行', guessBand(3630) === 'C')
  ok('Ku 上行', guessBand(14022) === 'Ku')
  ok('Ku 下行', guessBand(12272) === 'Ku')
  ok('Ka 上行', guessBand(27750) === 'Ka')
  ok('L 段', guessBand(1600) === 'L')
}

/* ---------- ⑭ 空计划与边界 ---------- */
{
  const empty = newPlan()
  ok('空计划版式不炸', layout(empty).empty === true)
  ok('空计划出图不炸', toSvg(empty).includes('频率计划为空'))
  ok('空计划校验为空', validatePlan(empty).length === 0)
  ok('空计划容量为零', computeLoading(empty, []).summary.tpTotal === 0)

  // 无 LO 且无显式下行 → 提示，且不产生错误的下行值
  const noLo = newPlan()
  noLo.channels.push(newChannel({ no: 'X', up: { fcMHz: 14000, bwMHz: 36 } }))
  ok('无 LO 无下行 → null', downlinkFc(noLo, noLo.channels[0]) === null)
  ok('无 LO 报 warn', validatePlan(noLo).some((i) => i.code === 'nolo'))
}

/* ---------- ⑮ 识图 CV 管线（合成图）----------
   OCR 那一半要 Canvas（Node 里 makeCanvas 返回 null → 识别结果为空），但几何这一半是识图的主干：
   色块检出 / 行聚类 / 频带分区 / 图例剔除。用一张合成的标准版式图验证它们。
   analyzeImage 只用到 imageData 的 width/height/data，故此处传裸对象即可。 */
{
  const W = 900, H = 520
  const data = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) { data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255 }
  const fillRect = (x0, y0, w, h, [r, g, b]) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        const i = (y * W + x) * 4
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
      }
    }
  }
  const BLUE = [68, 114, 196], RED = [224, 60, 49]
  // 上行区：两排各 6 块（模拟 H / V 双极化），块宽 60、间隔 10
  for (let i = 0; i < 6; i++) fillRect(80 + i * 70, 90, 60, 26, BLUE)
  for (let i = 0; i < 6; i++) fillRect(115 + i * 70, 126, 60, 26, RED)
  // 下行区：同样两排（y 相距足够远，须被切成另一个频带）
  for (let i = 0; i < 6; i++) fillRect(80 + i * 70, 330, 60, 26, BLUE)
  for (let i = 0; i < 6; i++) fillRect(115 + i * 70, 366, 60, 26, RED)
  // 图例：底部两个孤立小块，应被当图例剔除（不进频带）
  fillRect(80, 470, 26, 14, BLUE)
  fillRect(220, 470, 26, 14, RED)

  const r = analyzeImage({ width: W, height: H, data })
  ok('CV：检出 26 个色块（24 转发器 + 2 图例）', r.stats.blocks === 26, '得到 ' + r.stats.blocks)
  ok('CV：切成 2 个频带（上行 / 下行）', r.stats.bands === 2, '得到 ' + r.stats.bands)
  ok('CV：共 4 排（每带双极化）', r.stats.rows === 4, '得到 ' + r.stats.rows)
  ok('CV：图例区被剔除', r.warnings.some((w) => /图例/.test(w)))
  ok('CV：两排极化互为正交', (() => {
    const b0 = r.overlay.bands[0]
    return b0 && b0.rows.length === 2 && POL_ORTHO[b0.rows[0].pol] === b0.rows[1].pol
  })())
  // 无 OCR → 没有频率标注可拟合，标度必然失败，但绝不能因此崩掉或造出假频率
  ok('CV：无 OCR 时不造假频率', r.plan.channels.every((c) => c.up.fcMHz == null || Number.isFinite(c.up.fcMHz)))
  ok('CV：无 OCR 时给出标度失败告警', r.warnings.some((w) => /标度/.test(w)))

  // 纯白图：不应崩，且明确报「未检出色块」
  const blank = new Uint8ClampedArray(200 * 100 * 4).fill(255)
  const rb = analyzeImage({ width: 200, height: 100, data: blank })
  ok('CV：纯白图不崩', rb.stats.blocks === 0 && rb.warnings.length > 0)
}

console.log(`  ${pass} 通过, ${fail} 失败`)
if (fail) process.exit(1)
