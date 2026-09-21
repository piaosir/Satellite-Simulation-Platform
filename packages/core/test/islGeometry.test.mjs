// 星间几何（solveIslWorstCase）自测 —— 重点在「最大工作距离」这一约束。
// 运行：node packages/core/test/islGeometry.test.mjs
//
// 为什么要它：不设约束时最差工况必然落在擦着地球临边的那一瞬（掠地高度 ≈ 大气余量）——那是几何
// 可达的极限，真系统在到那之前早就切换链路了，拿它做预算既过保守、可用度也被那段没人用的窗口撑着。
// 给了最大工作距离后：最差 = 「互视 且 距离 ≤ 上限」里距离最大者，可用度/访问窗口按同一条件重算。
//
// 后半段测「星间距离时间序列」（sampleIslRangeSeries）—— 手动几何下「星间链路距离」工具的数据源。
// 关键不变式：它与 solveIslWorstCase 是同一套几何，只是逐拍出参 ⇒ 同一步长下两者的最大互视距离必须逐位相等。
import { createRequire } from 'node:module'
const { solveIslWorstCase, sampleIslRangeSeries } = createRequire(import.meta.url)('../utils/ngsoGeometry.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

console.log('=== 星间几何：最大工作距离约束 ===\n')

// 两颗同高、升交点/相位拉开的圆轨道星：互视时星间距离在一个较宽区间内变化。
// ★ epoch 必须显式给：buildSatrec 缺省会回退到 new Date()，两次调用的结果就不可比了（本测试全靠逐位复现）。
const EPOCH = '2026-08-15T00:00:00.000Z'
const BASE = {
  orbitA: { type: 'elements', altKm: 1200, ecc: 0, incl: 53, raan: 0, argp: 0, ma: 0, epoch: EPOCH },
  orbitB: { type: 'elements', altKm: 1200, ecc: 0, incl: 53, raan: 40, argp: 0, ma: 25, epoch: EPOCH },
  t0ISO: EPOCH, horizonHours: 6, freqGHz: 23, atmMarginKm: 100
}

const free = solveIslWorstCase({ ...BASE })
ok('不设上限时可行', free.feasible === true, free.reason || '')
ok('不设上限时 maxRangeKm 记为 0（＝不限）', free.search.maxRangeKm === 0)
const rFree = free.worst.rangeKm, rMin = free.worst.minRangeKm
console.log(`     不设上限：最近 ${rMin.toFixed(0)} · 最差 ${rFree.toFixed(0)} km · 掠地 ${free.worst.grazAltKm.toFixed(0)} km · 可见 ${(free.visibility.visibleFrac * 100).toFixed(1)}%`)

// 上限取「最近~最差」的中点：落在实际距离区间内，约束才真正起作用
const CAP = Math.round((rMin + rFree) / 2)
const capped = solveIslWorstCase({ ...BASE, maxRangeKm: CAP })
ok('设上限后仍可行', capped.feasible === true, capped.reason || '')
ok('最差距离被压到上限之内', capped.worst.rangeKm <= CAP + 1e-6, `${capped.worst.rangeKm.toFixed(1)} ≤ ${CAP}`)
ok('最差距离确实变小了', capped.worst.rangeKm < rFree - 1e-6, `${capped.worst.rangeKm.toFixed(0)} < ${rFree.toFixed(0)}`)
ok('可用度不增（约束只会砍掉样本，不会凭空多出可用时间）',
  capped.visibility.visibleFrac <= free.visibility.visibleFrac + 1e-12,
  `${(capped.visibility.visibleFrac * 100).toFixed(1)}% ≤ ${(free.visibility.visibleFrac * 100).toFixed(1)}%`)
ok('上限如实回传', capped.search.maxRangeKm === CAP)
ok('掠地高度随之抬高（不再擦临边）', capped.worst.grazAltKm > free.worst.grazAltKm,
  `${capped.worst.grazAltKm.toFixed(0)} > ${free.worst.grazAltKm.toFixed(0)} km`)
// 访问窗口按同一条件重算：每个窗口里的最大距离也不许越界
ok('访问窗口内的最大距离也不越界',
  (capped.visibility.windows || []).every((w) => w.maxRangeKm == null || w.maxRangeKm <= CAP + 1e-6))

// 上限大到不起作用 → 与不设限逐位一致
const loose = solveIslWorstCase({ ...BASE, maxRangeKm: rFree * 10 })
ok('上限足够大时与不设限同结果', Math.abs(loose.worst.rangeKm - rFree) < 1e-9 &&
  Math.abs(loose.visibility.visibleFrac - free.visibility.visibleFrac) < 1e-12)

// 上限小于任何互视样本 → 不可行，且要报「超出工作距离」而不是「从不互视」
const tiny = solveIslWorstCase({ ...BASE, maxRangeKm: 1 })
ok('上限小于最近距离 → 不可行', tiny.feasible === false)
ok('不可行原因说的是「超过最大工作距离」而不是「从不互视」',
  /最大工作距离/.test(tiny.reason || '') && !/从不互视/.test(tiny.reason || ''), tiny.reason)
ok('并报出窗口内最近能到多少', /最近\s*\d+\s*km/.test(tiny.reason || ''), tiny.reason)

// 负数/非数 上限 = 不限（不许把它当成 0 距离约束把链路判死）
for (const bad of [-100, 0, NaN, null, undefined, '']) {
  const r = solveIslWorstCase({ ...BASE, maxRangeKm: bad })
  if (!(r.feasible === true && Math.abs(r.worst.rangeKm - rFree) < 1e-9)) { ok(`无效上限 ${String(bad)} 退化为不限`, false); break }
}
ok('无效上限（负数/0/NaN/空）一律退化为不限', true)

console.log('\n=== 星间距离时间序列（距离工具的数据源）===\n')

// 上限足够大 ⇒ 步长与 solveIslWorstCase 同为 min(周期/200, 30s)，两者踩同一批时刻
const ser = sampleIslRangeSeries({ ...BASE, maxSamples: 4000 })
ok('可解', ser.ok === true, ser.reason || '')
ok('样本按时间严格递增', ser.samples.every((s, i) => i === 0 || s.tMs > ser.samples[i - 1].tMs), `${ser.samples.length} 拍`)
ok('步长与最差工况求解器一致', Math.abs(ser.search.stepSec - free.search.stepSec) < 1e-9,
  `${ser.search.stepSec} vs ${free.search.stepSec}`)
ok('最大互视距离与 solveIslWorstCase 逐位相同',
  Math.abs(ser.stats.maxVisibleRangeKm - rFree) < 1e-9, `${ser.stats.maxVisibleRangeKm} vs ${rFree}`)
ok('最近互视距离与 solveIslWorstCase 逐位相同',
  Math.abs(ser.stats.minVisibleRangeKm - rMin) < 1e-9, `${ser.stats.minVisibleRangeKm} vs ${rMin}`)
ok('互视占比与 solveIslWorstCase 一致',
  Math.abs(ser.stats.visibleFrac - free.visibility.visibleFrac) < 1e-12,
  `${(ser.stats.visibleFrac * 100).toFixed(2)}%`)
ok('统计量与样本自洽',
  Math.abs(Math.max(...ser.samples.map((s) => s.rangeKm)) - ser.stats.maxRangeKm) < 1e-9 &&
  Math.abs(Math.min(...ser.samples.map((s) => s.rangeKm)) - ser.stats.minRangeKm) < 1e-9 &&
  ser.stats.count === ser.samples.length)
ok('互视标记 = 掠地高度 ≥ 0（大气余量已计入遮挡半径）',
  ser.samples.every((s) => s.visible === (s.grazAltKm >= BASE.atmMarginKm - 1e-9)))

// 样本上限：曲线要画得动、IPC 一次传得完 —— 步长自动放粗，样本数不越界
const cap = sampleIslRangeSeries({ ...BASE, horizonHours: 72, maxSamples: 200 })
ok('样本数封顶（步长自动放粗）', cap.ok === true && cap.samples.length <= 201, `${cap.samples.length} 拍`)
ok('封顶后仍覆盖整段时窗',
  Math.abs((cap.samples[cap.samples.length - 1].tMs - cap.samples[0].tMs) / 3600000 - 72) < 0.02)

// 起点显式给定即可复现（同参两次调用逐位一致）
const again = sampleIslRangeSeries({ ...BASE, maxSamples: 4000 })
ok('同参两次调用逐位复现',
  again.samples.length === ser.samples.length &&
  again.samples.every((s, i) => s.tMs === ser.samples[i].tMs && s.rangeKm === ser.samples[i].rangeKm))

// 轨道给不全 → 不可解且如实报因（不许拿 0 距离糊弄过去）
const bad = sampleIslRangeSeries({ ...BASE, orbitB: { type: 'circular', altKm: 0 } })
ok('轨道无效 → 不可解并报因', bad.ok === false && /轨道高度/.test(bad.reason || ''), bad.reason)

/* ===================== 星历点序列两端 ===================== */
// 站-星两条路早就用 anchorDate + ephemSpanClip 处理星历表了，星间这两条路没跟上：
//   · epochOf 直接读 satrec.jdsatepoch —— 星历表没有这个字段，得到 new Date(NaN)。
//     Invalid Date 是【对象】，`epochOf(A) || epochOf(B) || new Date()` 这条兜底链拦不住它，
//     于是 startS/endS 全是 NaN、扫描一拍都不进，最后在 t0.toISOString() 上抛 RangeError。
//   · 时窗与表的采样时段不相交时（再生 / 端到端窗口拿墙钟做 t0ISO，而导入的星历多半不含「现在」），
//     逐拍取位全 null，最后误报「搜索时窗内两星从不互视」——把「表里没有这段时间」说成了物理结论。
console.log('\n=== 星间几何：星历点序列两端 ===\n')
const EI2 = createRequire(import.meta.url)('../utils/ephemInterp.js')
const G2 = createRequire(import.meta.url)('../utils/ngsoGeometry.js')
const TAB_T0 = Date.UTC(2026, 8, 21)
// 两颗同高、相位拉开的圆轨道星，直接按 TEME 圆轨道造采样表（6 h / 30 s，含两次以上升交点）
function ephSpec(phase, raanDeg, hours) {
  const R = RE_ALT(1200), n = Math.sqrt(398600.4418 / (R * R * R))
  const inc = 53 * Math.PI / 180, ci = Math.cos(inc), si = Math.sin(inc)
  const O = raanDeg * Math.PI / 180, cO = Math.cos(O), sO = Math.sin(O)
  const step = 30, cnt = Math.round((hours * 3600) / step) + 1
  const t = new Float64Array(cnt), p = new Float64Array(3 * cnt), v = new Float64Array(3 * cnt)
  for (let i = 0; i < cnt; i++) {
    const s = i * step, u = n * s + phase
    const xo = R * Math.cos(u), yo = R * Math.sin(u)
    t[i] = TAB_T0 + s * 1000
    p[3 * i] = xo * cO - yo * ci * sO; p[3 * i + 1] = xo * sO + yo * ci * cO; p[3 * i + 2] = yo * si
    const vxo = -R * n * Math.sin(u), vyo = R * n * Math.cos(u)
    v[3 * i] = vxo * cO - vyo * ci * sO; v[3 * i + 1] = vxo * sO + vyo * ci * cO; v[3 * i + 2] = vyo * si
  }
  return { type: 'ephem', samples: { t, p, v, frame: 'TEME', interp: { method: 'lagrange', samples: 6 } } }
}
function RE_ALT(alt) { return 6378.137 + alt }
const EA = ephSpec(0, 0, 6), EB = ephSpec(0.44, 40, 6)

// ① 不带 t0ISO：不许抛，要锚到表的采样起点
let threw = ''
let r1 = null
try { r1 = solveIslWorstCase({ orbitA: EA, orbitB: EB, horizonHours: 6, freqGHz: 23, atmMarginKm: 100 }) } catch (e) { threw = String(e && e.message || e) }
ok('★ 两端都是星历表、不带 t0ISO → 不抛', !threw, threw)
ok('★ 锚到采样表起点（而不是 Invalid Date）', !!r1 && r1.search && r1.search.t0ISO === new Date(TAB_T0).toISOString(),
  r1 && r1.search ? r1.search.t0ISO : '(无 search)')
ok('★ 锚对了就能真的解出互视', !!r1 && r1.feasible === true, r1 && r1.reason)

let threwS = ''
let s1 = null
try { s1 = sampleIslRangeSeries({ orbitA: EA, orbitB: EB, horizonHours: 6 }) } catch (e) { threwS = String(e && e.message || e) }
ok('★ 距离序列不带 t0ISO → 不抛', !threwS, threwS)
ok('★ 距离序列锚到采样表起点、能出样本', !!s1 && s1.ok === true && s1.samples.length > 10, s1 && (s1.reason || s1.samples.length))

// ② t0ISO 落在采样时段之外 → 要报「不重叠」，不许说「从不互视」
const OUT = '2026-10-01T00:00:00.000Z'
const r2 = solveIslWorstCase({ orbitA: EA, orbitB: EB, t0ISO: OUT, horizonHours: 6, freqGHz: 23, atmMarginKm: 100 })
ok('★ 时段外 → 不可行', r2.feasible === false, String(r2.feasible))
ok('★ 时段外的 reason 说「不重叠」而不是「从不互视」', /不重叠/.test(r2.reason || '') && !/从不互视/.test(r2.reason || ''), r2.reason)
ok('不可行分支仍带出 search（调用方读 search.stepSec 不会拿到 undefined）', !!(r2.search && r2.search.stepSec > 0), JSON.stringify(r2.search || null))
const s2 = sampleIslRangeSeries({ orbitA: EA, orbitB: EB, t0ISO: OUT, horizonHours: 6 })
ok('★ 距离序列时段外也说「不重叠」', s2.ok === false && /不重叠/.test(s2.reason || ''), s2.reason)

// ③ 混合端（A 是根数、B 是星历表）：时段相交只由星历那一端决定
const r3 = solveIslWorstCase({ orbitA: BASE.orbitA, orbitB: EB, t0ISO: OUT, horizonHours: 6, freqGHz: 23, atmMarginKm: 100 })
ok('★ 混合端时段外也说「不重叠」', r3.feasible === false && /不重叠/.test(r3.reason || ''), r3.reason)
const r3b = solveIslWorstCase({ orbitA: BASE.orbitA, orbitB: EB, horizonHours: 6, freqGHz: 23, atmMarginKm: 100 })
ok('★ 混合端不带 t0ISO → 锚到星历表起点，不抛也不误报', r3b.search.t0ISO === new Date(TAB_T0).toISOString(), r3b.search.t0ISO)

// ④ 时窗被表收窄时，可用度的分母按实际分析时段算（不能拿请求的 24 h 当分母）
const r4 = solveIslWorstCase({ orbitA: EA, orbitB: EB, t0ISO: new Date(TAB_T0).toISOString(), horizonHours: 24, freqGHz: 23, atmMarginKm: 100 })
ok('★ 请求 24 h、表只有 6 h → 分母是 6 h 不是 24 h',
  Math.abs(r4.visibility.windowMinutes - 360) < 1, String(r4.visibility.windowMinutes))
ok('可见时长不超过分析时段', r4.visibility.visibleMinutes <= r4.visibility.windowMinutes + 1e-9,
  r4.visibility.visibleMinutes + ' / ' + r4.visibility.windowMinutes)

/* ===================== 第 16 条：周期估不出就留空 ===================== */
console.log('\n=== 星历静态量：周期估不出不拿整段时长冒充 ===\n')
{
  // 30 min 的短表：LEO 真周期 109 min，表内根本凑不出两次升交点
  const short = ephSpec(0, 0, 0.5)
  const tab = EI2.buildTable(Object.assign({}, short.samples, { interp: short.samples.interp }))
  ok('短表估不出周期', EI2.estimatePeriodMin(tab) === null, String(EI2.estimatePeriodMin(tab)))
  const el = G2.ephemElements(tab)
  ok('★ 估不出时 periodMin 留 null（原来拿整段 30 min 冒充）', el.periodMin === null, String(el.periodMin))
  ok('★ meanMotionRevDay 一并留 null（原来是 48 圈/天）', el.meanMotionRevDay === null, String(el.meanMotionRevDay))
  ok('★ 带出 periodEstimated: false', el.periodEstimated === false, String(el.periodEstimated))
  // 长表能估出来，照常给数
  const longTab = EI2.buildTable(Object.assign({}, EA.samples, { interp: EA.samples.interp }))
  const el2 = G2.ephemElements(longTab)
  ok('长表估得出周期、periodEstimated: true', el2.periodEstimated === true && el2.periodMin > 100 && el2.periodMin < 120,
    String(el2.periodMin))
  ok('长表的 meanMotionRevDay 照常给数', Math.abs(el2.meanMotionRevDay - 1440 / el2.periodMin) < 1e-9, String(el2.meanMotionRevDay))
  // 周期为 null 时扫描步长要走缺省，不能被压到硬下限（1 s / 2 s / 5 s 的盲扫）
  const rShort = solveIslWorstCase({ orbitA: short, orbitB: ephSpec(0.44, 40, 0.5), horizonHours: 1, freqGHz: 23, atmMarginKm: 100 })
  ok('★ 周期估不出时步长走缺省（绕地最小周期 84.49 min → 25.3 s），不是 2 s 盲扫',
    Math.abs(rShort.search.stepSec - 84.48906331469738 * 60 / 200) < 1e-6, String(rShort.search.stepSec))
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
