// 频率计划 → 微信小程序 的自测（src/shared/fpMiniExport.js）。
//
// 这条管线的特殊之处：小程序侧【零算法】—— 图按绘制指令画、分配表的频带条按百分比落 view、
// Excel 按表模型刷格子。故凡是这边算错的，那边一定照错画出来，且在这边看不出任何异常。
// 手上又没有小程序的运行环境，能守住的只有这一层的不变式：
//   ① 分配表在【下行域】—— 组的频带 = 下行频带（收发不等宽的转发器上，上行那一份是另一个数）；
//   ② 百分比落在 [0,100] 且视域包住所有载波：越界的载波必须【看得见】，不能被裁掉（藏起来
//      等于把问题藏起来），故它的块允许探出频带，但仍在视域内；
//   ③ 波束占段的分层 = 同频叠了多深：频分排布的相邻两段同层（挨着不算叠着），同频叠放的分层；
//   ④ 跨切点的载波按段分色，渐变停靠点【单调不回头】—— 回头的停靠点会被浏览器钳成前一个色，
//      整条载波涂成头一个波束的色（它明明归后一个）；
//   ⑤ 墨色随底色亮度翻转，门限与 FpAlloc 的 inkOf 同值（同一个波束不该一处白字一处黑字）；
//   ⑥ 出去的必须是【纯数据】：结构化克隆过得去（云函数与 IPC 两头都要过序列化）；
//   ⑦ Excel 表模型随包同行，两张表齐备。
import { newPlan, newChannel, newLo, newBeam, normalizePlan, setBeamSegFc, setBeamSegBw } from '../../../src/shared/freqPlanModel.js'
import { newCarrier } from '../../../src/shared/freqPlanCapacity.js'
import { fpMiniItem, allocationOf, drawOps } from '../../../src/shared/fpMiniExport.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
}
const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol
const inPct = (v) => Number.isFinite(v) && v >= -1e-9 && v <= 100 + 1e-9

console.log('频率计划 → 小程序')

// ---------------------------------------------------------------------------
// 一份带两个波束（频分切开）的 C 段计划：收发不等宽，故上下行不是同一段频带
// ---------------------------------------------------------------------------
const lo = newLo({ name: 'LO1', valueMHz: 2225 })
const bA = newBeam({ name: '中国波束', color: '#4472C4', bwMHz: 18 })
const bB = newBeam({ name: '东南亚', color: '#F0C419', bwMHz: 18 })   // 浅色：墨色该翻成黑
const plan0 = newPlan({ name: 'C 频段', satName: 'TEST-1', los: [lo], beams: [bA, bB] })
const c1 = newChannel({ no: 'C1', loId: lo.id, up: { fcMHz: 6100, bwMHz: 36, pol: 'H' }, beamUpIds: [bA.id, bB.id] })
// 收发不等宽：上行 36、下行 54 —— 下行频带不是上行频带的平移
const c2 = newChannel({ no: 'C2', loId: lo.id, up: { fcMHz: 6200, bwMHz: 36, pol: 'V' }, dn: { bwMHz: 54 }, beamUpIds: [bA.id] })
plan0.channels.push(c1, c2)
const plan = normalizePlan(plan0)
plan.carriers = [
  newCarrier({ name: 'A', channelId: c1.id, fcMHz: 6090, occBwMHz: 10, pwrBwMHz: 12, infoRateKbps: 20000, modcod: '8PSK 3/4' }),
  newCarrier({ name: '跨段', channelId: c1.id, fcMHz: 6106, occBwMHz: 14, pwrBwMHz: 9, infoRateKbps: 30000 }),
  newCarrier({ name: '未定频', channelId: c1.id, occBwMHz: 4 }),
  newCarrier({ name: '越界', channelId: c2.id, fcMHz: 6230, occBwMHz: 30, pwrBwMHz: 30 }),
  newCarrier({ name: '没归属', occBwMHz: 3 })
]

const item = fpMiniItem(plan, { unit: 'MHz' })
const a = item.alloc
const g1 = a.groups.find((g) => g.no === 'C1')
const g2 = a.groups.find((g) => g.no === 'C2')

// ① 下行域
ok('分配表标着下行域', a.side === 'dn')
ok('组的频带取【下行】（收发不等宽的那条上尤其）', near(g2.dn.f2 - g2.dn.f1, 54) && near(g2.up.f2 - g2.up.f1, 36),
  `dn ${g2.dn.f1}~${g2.dn.f2} · up ${g2.up.f1}~${g2.up.f2}`)
ok('核算按下行带宽（54 而不是 36）', near(g2.bw, 54), String(g2.bw))
ok('条画在下行频带上', near(g2.strip.axis[0].v, g2.dn.f1) && near(g2.strip.axis[2].v, g2.dn.f2),
  JSON.stringify(g2.strip.axis))
ok('两侧的读数都还在（上行没被丢掉）', g1.up.f1 != null && g1.dn.f1 != null && g1.rows[0].up.fc != null && g1.rows[0].dn.fc != null)

// ② 百分比 / 视域
const allPct = (s) => [s.band.left, s.band.width, ...s.segs.flatMap((x) => [x.left, x.width]),
  ...s.bars.flatMap((x) => [x.left, x.width]), ...s.axis.map((x) => x.left)]
ok('C1 的几何全部落在 [0,100]', allPct(g1.strip).every(inPct), JSON.stringify(allPct(g1.strip)))
ok('C2 的几何全部落在 [0,100]', allPct(g2.strip).every(inPct), JSON.stringify(allPct(g2.strip)))
ok('频带两端留了余量（越界的载波才有地方画）', g1.strip.band.left > 0 && g1.strip.band.left + g1.strip.band.width < 100)
const over = g2.strip.bars.find((b) => b.name === '越界')
ok('越界的载波仍在条上（没被裁掉）', !!over && inPct(over.left) && inPct(over.width))
ok('越界的载波确实探出了频带', !!over && over.left + over.width > g2.strip.band.left + g2.strip.band.width - 1e-9,
  over ? `块右沿 ${over.left + over.width} vs 频带右沿 ${g2.strip.band.left + g2.strip.band.width}` : '')
ok('越界被标成待处理（核算给了条目 → 条上描红）', over && over.bad === true && g2.issues.some((i) => i.code === 'outOfBand'))
const floatBar = g1.strip.bars.find((b) => b.name === '未定频')
ok('未定频的照画（顺次铺在频带起点之后）', !!floatBar && floatBar.placed === false && near(floatBar.f1, g1.dn.f1))
ok('功率带宽给的是宽度，不是频率', g1.strip.bars[0].pwr > 0 && inPct(g1.strip.bars[0].pwr))

// ③ 分层：频分切开的两段【同层】（挨着不算叠着）
ok('频分排布的两段同层', g1.strip.lanes === 1 && g1.strip.segs.length === 2 && g1.strip.segs.every((s) => s.lane === 0),
  JSON.stringify(g1.strip.segs.map((s) => s.lane)))
// 同频叠放：两个波束都贴着频带下边沿各占 18（stack），应错开成两层
const st0 = newPlan({ name: '同频叠放', los: [lo], beams: [bA, bB] })
const sc = newChannel({ no: 'S1', loId: lo.id, up: { fcMHz: 6100, bwMHz: 36, pol: 'H' }, beamUpIds: [bA.id, bB.id], beamLayout: 'stack' })
st0.channels.push(sc)
const st = normalizePlan(st0)
st.carriers = [newCarrier({ name: 'x', channelId: sc.id, fcMHz: 6090, occBwMHz: 10 })]
const sg = allocationOf(st, 'MHz').groups[0]
ok('同频叠放的两段各错一层', sg.strip.lanes === 2 && new Set(sg.strip.segs.map((s) => s.lane)).size === 2,
  JSON.stringify(sg.strip.segs.map((s) => [s.name, s.lane])))
ok('同频叠放不出渐变（频率上分不出谁是谁，该是一整个实色）', sg.strip.bars.every((b) => !b.bg),
  JSON.stringify(sg.strip.bars.map((b) => b.bg)))

// ④ 跨切点的分色
const cross = g1.strip.bars.find((b) => b.name === '跨段')
ok('跨切点的载波出渐变', !!cross && /linear-gradient/.test(cross.bg), cross ? cross.bg : '')
ok('不跨切点的不出渐变', g1.strip.bars.filter((b) => b.name === 'A').every((b) => !b.bg))
if (cross && cross.bg) {
  const stops = [...cross.bg.matchAll(/([\d.]+)%/g)].map((m) => Number(m[1]))
  ok('渐变停靠点单调不回头', stops.every((v, i) => i === 0 || v >= stops[i - 1] - 1e-9), JSON.stringify(stops))
  ok('渐变两端封口（0% 起、100% 止）', near(stops[0], 0, 1e-6) && near(stops[stops.length - 1], 100, 1e-6), JSON.stringify(stops))
  ok('渐变里出现两个波束的色', /4472C4/i.test(cross.bg) && /F0C419/i.test(cross.bg))
}

// ⑤ 墨色翻转
const onBlue = g1.strip.bars.find((b) => b.color.toUpperCase() === '#4472C4')
const onGold = g1.strip.bars.find((b) => b.color.toUpperCase() === '#F0C419')
ok('深底用白字', !!onBlue && onBlue.ink === '#ffffff', onBlue && onBlue.ink)
ok('浅底翻黑字', !!onGold && onGold.ink === '#17181a', onGold && onGold.ink)

// 缩略条：只在频带内看位置，越界的裁掉
ok('缩略条裁在 [0,100] 内', g2.mini.segs.every((s) => inPct(s.left) && inPct(s.width)) && inPct(g2.mini.pwr),
  JSON.stringify(g2.mini))

// 组头那排波束色片
ok('组头带着波束（名字 + 色）', g1.beams.length === 2 && g1.beams.every((b) => b.id && b.name && /^#/.test(b.color)))

// 没有下行频带的转发器：组头照出，条画不出来（不能瞎画一条）
const nd0 = newPlan({ name: '没下行', beams: [bA] })
const nc = newChannel({ no: 'N1', up: { fcMHz: 6100, bwMHz: 36, pol: 'H' }, beamUpIds: [bA.id] })
nd0.channels.push(nc)
const nd = normalizePlan(nd0)
nd.carriers = [newCarrier({ name: 'n', channelId: nc.id, occBwMHz: 5 })]
const ng = allocationOf(nd, 'MHz').groups[0]
ok('没下行频带的组仍出（藏起来等于说它不存在）', !!ng && ng.count === 1)
ok('没下行频带就不画条', ng.strip === null && ng.mini === null)

// ⑥ 纯数据（云函数 / IPC 两头都要过序列化）
let cloned = null
try { cloned = structuredClone(item) } catch (e) { cloned = null }
ok('整件过得了结构化克隆', !!cloned)
ok('JSON 往返后一模一样', JSON.stringify(JSON.parse(JSON.stringify(item))) === JSON.stringify(item))

// ⑦ Excel 表模型随包同行
ok('随包带着 Excel 表模型', item.xlsx && item.xlsx.kind === 'data' && item.xlsx.sheets.length === 2,
  item.xlsx && JSON.stringify(item.xlsx.sheets.map((s) => s.name)))
ok('数据表里的频率是【数值】（还能求和排序）', (() => {
  const sh = item.xlsx.sheets[1]
  const ci = sh.columns.findIndex((c) => /下行起始/.test(c.header))
  return ci >= 0 && sh.rows.every((r) => r[ci] === null || typeof r[ci] === 'number')
})())
ok('刻度参数随包（小程序照它写读数）', item.meta.u.label === 'MHz' && item.meta.u.f === 1 && item.meta.u.dec === 2)
// 包顶到上限时把数据表摘掉：图与分配表照送，且摘掉这件事写在包里（小程序据此说清楚原因，
// 不能让人以为是「导入的版本太老」而反复重发）
const slim = fpMiniItem(plan, { unit: 'MHz', xlsx: false })
ok('摘掉数据表后图与分配表还在', slim.draw.ops.length > 0 && slim.alloc.groups.length === a.groups.length)
ok('摘掉这件事写在包里', slim.xlsx.kind === 'omitted' && !slim.xlsx.sheets && /数据表/.test(slim.xlsx.reason))
ok('摘掉之后确实小了一截', JSON.stringify(slim).length < JSON.stringify(item).length)

// 没有载波的计划：分配表整块留空，不是造一张空表出来
const noCar = normalizePlan(newPlan({ name: '空', channels: [newChannel({ no: 'X', up: { fcMHz: 6000, bwMHz: 36, pol: 'H' } })] }))
ok('没有载波就没有分配表', allocationOf(noCar, 'MHz') === null)

// 绘制指令仍成形（导出 PNG 与屏上共用这一份）
const d = drawOps(plan, { unit: 'MHz' })
ok('绘制指令有尺寸有笔画', d.w > 0 && d.h > 0 && d.ops.length > 0 && d.hits.length > 0)
ok('命中矩形对得上转发器', d.hits.every((h) => plan.channels.some((c) => c.id === h.id)))

console.log(`  ${pass} 通过${fail ? ` · ${fail} 失败` : ''}`)
if (fail) process.exit(1)
