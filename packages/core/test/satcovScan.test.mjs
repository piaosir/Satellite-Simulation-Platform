// 对星覆盖时段扫描核自测（src/viz/grd/satcovScan.js + coverage.js 的两个纯指向函数）。运行：npm test
// 被测文件是渲染端 ESM，故本测试自身也是 .mjs。
//
// 这个核回答的是「什么时候这根波束照得到那颗星」。它跟可见性分析那套 ACCESS 扫描最大的不同：
// 目标不是几十度宽的地平锥，而是零点几度的波束 —— 固定步长必漏。故本测试的重点全在【会不会漏窗】：
//   ① 解析可算的穿越：起止时刻/峰值时刻要对得上（二分与黄金分割的精度）；
//   ② 24 h 时窗里一个 60 s 的穿越必须被抓住，而且取值次数要远小于「1 s 定步长」；
//   ③ 窗口比允许角位移还窄时是【会漏】的 —— 这是设计边界，不是 bug，故这里钉死「细到多少能抓住」；
//   ④ 星历断档 / 预算耗尽 / 全程在窗内 / 全程不在窗内 四个退化分支不崩、标志位如实。
import { scanWindows, summarize, offAxisOf } from '../../../src/viz/grd/satcovScan.js'
import { beamBasisFrom, boreSettingsAtPos, antennaBasis, antennaBasisAzEl, azElGround } from '../../../src/viz/grd/coverage.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const D2R = Math.PI / 180, R2D = 180 / Math.PI
const near = (a, b, eps) => Math.abs(a - b) <= eps

// ==================== 解析算例：目标沿小圆匀速绕 boresight 转 ====================
// d(t) = [sinφ·cosβ, sinβ, cosφ·cosβ]，φ = Ω·(t−tc)：单位矢量，离轴角 off = acos(cosφ·cosβ)，
// 最近点 off=β 恰在 t=tc，沿路的大圆角速度恒为 Ω·cosβ（可解析核对步长控制是否真的按角位移走）。
// 波束：Dir = PK − 4·(off/HB)²（抛物线 dB），门限 THR → 穿越角 off_thr 解析可解 → 起止时刻解析可解。
const PK = 40, HB = 0.5, THR = 37
const DOMAIN = 8                      // 方向图域角半径：出了域取不到值（val=null）
const offThr = HB * Math.sqrt((PK - THR) / 4)          // Dir=THR 处的离轴角
const dirAt = (phiDeg, betaDeg) => {
  const p = phiDeg * D2R, b = betaDeg * D2R
  return [Math.sin(p) * Math.cos(b), Math.sin(b), Math.cos(p) * Math.cos(b)]
}
// 解析穿越半角（φ 的半宽）：cos(off_thr) = cosφ·cosβ
const phiCross = (betaDeg) => {
  const c = Math.cos(offThr * D2R) / Math.cos(betaDeg * D2R)
  return c >= 1 ? 0 : Math.acos(c) * R2D
}
// 造一个 evalAt：t0 起算，角速度 omegaPhi（φ 的度/秒），最近点在 tcMs
function mkEval(betaDeg, omegaPhi, tcMs, { blockedIn = null, nullIn = null } = {}) {
  let calls = 0
  const fn = (tMs) => {
    calls++
    if (nullIn && tMs >= nullIn[0] && tMs <= nullIn[1]) return null      // 星历断档
    const phi = ((omegaPhi * (tMs - tcMs)) / 1000)
    const d = dirAt(phi, betaDeg)
    const off = offAxisOf(d)
    const val = off <= DOMAIN ? PK - 4 * (off / HB) * (off / HB) : null   // 域外无值
    const blocked = !!(blockedIn && tMs >= blockedIn[0] && tMs <= blockedIn[1])
    return { d, on: val != null && val >= THR && !blocked, val }
  }
  fn.calls = () => calls
  return fn
}

const T0 = Date.UTC(2026, 7, 13, 0, 0, 0)
const H24 = 24 * 3600 * 1000

// ---- ① 解析穿越：起止/峰值时刻 ----
{
  const beta = 0.2, om = 0.012, tc = T0 + 3600 * 1000          // 1 h 处最近点，GEO 看 LEO 的典型角速度
  const ev = mkEval(beta, om, tc)
  const r = scanWindows(ev, T0, T0 + H24, { domRadDeg: DOMAIN, angStepDeg: 0.1, stepMaxSec: 600 })
  const half = phiCross(beta) / om * 1000
  const w = r.windows.find((x) => Math.abs(x.peakMs - tc) < 60000)
  ok('① 抓到解析穿越窗口', !!w, `共 ${r.windows.length} 窗 · 取值 ${r.samples} 次`)
  if (w) {
    ok('① AOS 对得上解析值（<50 ms）', near(w.startMs, tc - half, 50), `Δ=${(w.startMs - (tc - half)).toFixed(1)} ms`)
    ok('① LOS 对得上解析值（<50 ms）', near(w.endMs, tc + half, 50), `Δ=${(w.endMs - (tc + half)).toFixed(1)} ms`)
    ok('① 峰值时刻 = 最近点（<0.5 s）', near(w.peakMs, tc, 500), `Δ=${((w.peakMs - tc) / 1000).toFixed(3)} s`)
    ok('① 峰值 Dir = 最近点方向性', near(w.peakVal, PK - 4 * (beta / HB) ** 2, 0.01), `${w.peakVal.toFixed(3)} dB`)
    ok('① 最小离轴角 ≈ β', near(w.minOff, beta, 0.03), `${w.minOff.toFixed(4)}°`)
    ok('① 窗内均值在门限与峰值之间', w.meanVal > THR && w.meanVal < w.peakVal, `${w.meanVal.toFixed(2)} dB`)
    ok('① 两端都不是截断', !w.truncStart && !w.truncEnd)
    ok('① 时长 = 2×解析半宽', near(w.durMin, 2 * half / 60000, 1e-3), `${(w.durMin * 60).toFixed(2)} s`)
  }
  // 一天 1036.8° → 2.88 圈，每圈一次穿越
  ok('① 24 h 内窗口数 = 转过的圈数', r.windows.length === 3, `${r.windows.length} 窗`)
  ok('① 取值次数远少于 1 s 定步长（86400 次）', r.samples < 6000, `${r.samples} 次`)
  ok('① 没撞预算/步长下限', !r.budgetHit && !r.minStepHit)
}

// ---- ② 相位扫掠：固定 90 s 粗扫会按相位随机漏掉 64 s 的穿越，自适应步长一次不漏 ----
// 单点算例说明不了问题（粗扫碰巧落进窗里就"没漏"），故把最近点在一个粗扫格内均匀铺 90 个相位统计。
{
  const beta = 0.2, om = 0.012, durSecTheo = 2 * phiCross(beta) / om
  let miss90 = 0, missAdaptive = 0
  for (let i = 0; i < 90; i++) {
    const tc = T0 + 6 * 3600 * 1000 + i * 1000            // 相位在一个 90 s 粗扫格内均匀铺开
    const ev = mkEval(beta, om, tc)
    let hit = false
    for (let t = T0; t <= T0 + 12 * 3600 * 1000; t += 90000) if (ev(t).on) { hit = true; break }
    if (!hit) miss90++
    const r = scanWindows(mkEval(beta, om, tc), T0, T0 + 12 * 3600 * 1000, { domRadDeg: DOMAIN, angStepDeg: 0.1 })
    if (!r.windows.some((w) => Math.abs(w.peakMs - tc) < 60000 && Math.abs(w.durMin * 60 - durSecTheo) < 1)) missAdaptive++
  }
  // 理论漏检率 = 1 − 窗宽/步长 = 1 − 64/90 ≈ 29%
  ok('② 固定 90 s 粗扫按相位漏掉约 1/4 的穿越', miss90 > 15 && miss90 < 40, `90 个相位漏 ${miss90} 个（理论 ≈29%）`)
  ok('② 自适应步长 90 个相位一次不漏', missAdaptive === 0, `窗宽 ${durSecTheo.toFixed(1)} s`)
}

// ---- ③ 设计边界：窗口的角展宽小于允许角位移时【会】漏，加细角步进即可抓住 ----
// 这条钉死本核的诚实边界。角展宽 = 2·φ_cross·cosβ（沿路走过的大圆弧长），与角速度无关，故可直接与角步进比。
// ★ 这里换角速度铺相位、不换最近点时刻：自适应步长的采样格是【跟着几何走】的（步长在 off 掉到域边界
//   附近时才收细，那个位置由轨迹自己定），整条轨迹平移一点，采样格跟着平移同样多 —— 相对相位纹丝不动，
//   拿平移最近点来「铺相位」等于没铺。换角速度才真的把采样格与窗口的相对位置铺开。
{
  const beta = 0.4329                                       // 擦着门限过：角展宽 ~0.03°，只有默认角步进的三成
  const spanDeg = 2 * phiCross(beta) * Math.cos(beta * D2R)
  const oms = Array.from({ length: 20 }, (_, i) => 0.008 + i * 0.0006)
  const catchAt = (angStepDeg) => oms.filter((om) => {
    const tc = T0 + 1800 * 1000
    const r = scanWindows(mkEval(beta, om, tc), T0, T0 + 3600 * 1000, { domRadDeg: DOMAIN, angStepDeg })
    return r.windows.some((w) => Math.abs(w.peakMs - tc) < 30000)
  }).length
  ok('③ 角展宽确实远窄于默认角步进', spanDeg < 0.04, `角展宽 ${spanDeg.toFixed(4)}° vs 默认 0.1°`)
  const coarse = catchAt(0.1), fine = catchAt(0.005)
  ok('③ 默认 0.1° 角步进会漏掉这种擦边窗', coarse < 20, `20 组角速度抓到 ${coarse} 组`)
  ok('③ 角步进加细到 0.005° 后一组不漏', fine === 20, `${fine}/20`)
}

// ---- ④ 全程在窗内 / 全程不在窗内 / 遮挡切窗 ----
{
  const still = () => ({ d: dirAt(0, 0.1), on: true, val: 39 })          // 静止在波束里（GEO 打 GEO）
  const r1 = scanWindows(still, T0, T0 + 3600 * 1000, { domRadDeg: DOMAIN, angStepDeg: 0.1 })
  ok('④ 全程在窗内 → 1 个窗、两端都标截断', r1.windows.length === 1 && r1.windows[0].truncStart && r1.windows[0].truncEnd)
  ok('④ 全程在窗内的时长 = 整个时窗', near(r1.windows[0].durMin, 60, 1e-6), `${r1.windows[0].durMin} min`)
  const r2 = scanWindows(mkEval(6, 0.012, T0 + 3600 * 1000), T0, T0 + 2 * 3600 * 1000, { domRadDeg: DOMAIN, angStepDeg: 0.1 })
  ok('④ 从不达门限 → 0 个窗', r2.windows.length === 0)
  // 遮挡把一次穿越劈成两段（视线判据与门限判据都进 on，任一翻转都是边界）
  const tc3 = T0 + 3600 * 1000
  const r3 = scanWindows(mkEval(0.05, 0.012, tc3, { blockedIn: [tc3 - 5000, tc3 + 5000] }), T0, T0 + 2 * 3600 * 1000,
    { domRadDeg: DOMAIN, angStepDeg: 0.1 })
  ok('④ 中途遮挡把一次穿越劈成两段', r3.windows.length === 2, `${r3.windows.length} 窗`)
}

// ---- ⑤ 星历断档 / 预算耗尽 ----
{
  const tc = T0 + 3600 * 1000
  const r = scanWindows(mkEval(0.05, 0.012, tc, { nullIn: [tc - 5000, tc + 5000] }), T0, T0 + 2 * 3600 * 1000,
    { domRadDeg: DOMAIN, angStepDeg: 0.1 })
  ok('⑤ 星历断档不崩，断档处合窗并标截断', r.windows.length >= 1 && r.windows.some((w) => w.truncEnd || w.truncStart),
    `${r.windows.length} 窗`)
  const rb = scanWindows(mkEval(0.2, 0.012, T0 + 3600 * 1000), T0, T0 + H24, { domRadDeg: DOMAIN, angStepDeg: 0.1, maxSamples: 200 })
  ok('⑤ 预算耗尽如实上报 budgetHit', rb.budgetHit && rb.samples <= 260, `${rb.samples} 次`)
}

// ---- ⑥ 汇总统计：空档含首尾 ----
{
  const t1 = T0 + 60 * 60000
  const ws = [{ startMs: T0 + 10 * 60000, endMs: T0 + 20 * 60000, peakVal: 38, peakMs: T0 + 15 * 60000 },
    { startMs: T0 + 40 * 60000, endMs: T0 + 45 * 60000, peakVal: 39, peakMs: T0 + 42 * 60000 }]
  const s = summarize(ws, T0, t1)
  ok('⑥ 总时长 / 占比', near(s.totMin, 15, 1e-9) && near(s.pct, 25, 1e-9), `${s.totMin} min · ${s.pct}%`)
  ok('⑥ 最长空档含时窗首尾（末尾 15 min）', near(s.maxGapMin, 20, 1e-9) && s.gapCount === 3, `${s.maxGapMin} min · ${s.gapCount} 段`)
  ok('⑥ 最长/最短/平均窗', near(s.maxWinMin, 10, 1e-9) && near(s.minWinMin, 5, 1e-9) && near(s.avgWinMin, 7.5, 1e-9))
  ok('⑥ 全窗峰值取各窗最大', s.peakVal === 39 && s.peakMs === T0 + 42 * 60000)
  const s0 = summarize([], T0, t1)
  ok('⑥ 无窗口时空档 = 整个时窗', s0.nWin === 0 && near(s0.maxGapMin, 60, 1e-9) && s0.pct === 0)
  // 时窗外/跨界的窗口按落在窗内的那一段计
  const s2 = summarize([{ startMs: T0 - 30 * 60000, endMs: T0 + 5 * 60000, peakVal: 1, peakMs: T0 }], T0, t1)
  ok('⑥ 跨时窗起点的窗口只计窗内那段', near(s2.totMin, 5, 1e-9), `${s2.totMin} min`)
}

// ==================== 指向纯函数（实时路与扫描路共用同一份公式）====================
{
  const meta0 = { satLon: 110.5, satLat: 0, satAlt: 35786 }
  // 对星三型不随源星移动而改
  for (const bt of ['sat', 'satoff', 'point']) {
    const st = { boreType: bt, boreLock: false, borePtLon: 30, borePtLat: 10, borePtAlt: 550 }
    ok(`指向 ${bt} 不随源星平移`, boreSettingsAtPos(st, meta0, { lon: 120, lat: 5 }) === st)
  }
  // 锁定 + azel(0,0) → 钉成时窗起点的星下点（之后源星怎么动都指同一个地面点）
  const stA = { boreType: 'azel', boreLock: true, boreAz: 0, boreEl: 0 }
  const p1 = boreSettingsAtPos(stA, meta0, { lon: 120, lat: 5 })
  const g0 = azElGround(meta0.satLon, meta0.satLat, meta0.satAlt, 0, 0)
  ok('锁定 azel → 钉成起点星下点的 geo', p1.boreType === 'geo' && near(p1.boreLon, g0.lon, 1e-6) && near(p1.boreLat, g0.lat, 1e-6),
    `${p1.boreLon.toFixed(3)}°E`)
  const p2 = boreSettingsAtPos(stA, meta0, { lon: 60, lat: -20 })
  ok('锁定 azel 的钉点与源星走到哪无关', near(p1.boreLon, p2.boreLon, 1e-9) && near(p1.boreLat, p2.boreLat, 1e-9))
  // 不锁定 + geo（星下点跟随）：一次性总量 == 实时路的逐帧增量累加（telescoping）
  const stG = { boreType: 'geo', boreLock: false, boreLon: 100, boreLat: 2 }
  const once = boreSettingsAtPos(stG, meta0, { lon: 130, lat: 8 })
  let step = stG, mv = meta0
  for (const p of [{ lon: 115, lat: 4 }, { lon: 122, lat: 6 }, { lon: 130, lat: 8 }]) {
    step = boreSettingsAtPos(step, mv, p); mv = { satLon: p.lon, satLat: p.lat, satAlt: meta0.satAlt }
  }
  ok('星下点跟随：一次性总量 = 逐帧增量累加', near(once.boreLon, step.boreLon, 1e-9) && near(once.boreLat, step.boreLat, 1e-9),
    `${once.boreLon.toFixed(4)} vs ${step.boreLon.toFixed(4)}`)
  // 平移量 = 源星走的量（110.5→130 即 +19.5°），不是 boresight 自己的绝对经度差
  ok('星下点跟随：平移量 = 源星位移，相对偏置守恒', near(once.boreLon - stG.boreLon, 19.5, 1e-9) && near(once.boreLat - stG.boreLat, 8, 1e-9),
    `Δlon=${(once.boreLon - stG.boreLon).toFixed(3)}`)
  // 跨 ±180° 接缝的平移量走短弧：源星 178→−178 是 +4°，boresight 175 → 179（不是绕回去 −356°）
  const seam = boreSettingsAtPos({ boreType: 'geo', boreLock: false, boreLon: 175, boreLat: 0 }, { satLon: 178, satLat: 0, satAlt: 550 }, { lon: -178, lat: 0 })
  ok('星下点跟随：跨 ±180° 接缝走短弧', near(seam.boreLon, 179, 1e-9), `${seam.boreLon}`)
  // beamBasisFrom 与各基底构造函数逐位一致
  const bg = beamBasisFrom(meta0, { boreType: 'geo', boreLon: 100, boreLat: 20, yaw: 0 })
  const bg0 = antennaBasis(meta0.satLon, 100, 20, 0, 0, meta0.satAlt)
  ok('beamBasisFrom(geo) = antennaBasis', bg.z.every((v, i) => near(v, bg0.z[i], 1e-12)))
  const ba = beamBasisFrom(meta0, { boreType: 'azel', boreAz: 2, boreEl: -1, yaw: 5 })
  const ba0 = antennaBasisAzEl(meta0.satLon, 0, meta0.satAlt, 2, -1, 5)
  ok('beamBasisFrom(azel) = antennaBasisAzEl', ba.z.every((v, i) => near(v, ba0.z[i], 1e-12)))
  const bs = beamBasisFrom(meta0, { boreType: 'sat', yaw: 0 }, null)
  ok('beamBasisFrom(sat) 目标解析不到 → 退回天底', bs.z.every((v, i) => near(v, antennaBasisAzEl(meta0.satLon, 0, meta0.satAlt, 0, 0, 0).z[i], 1e-12)))
  ok('偏置 0 的 satoff 严格退化回 sat', (() => {
    const T = [0, 0, 6378.137 + 550]
    const a = beamBasisFrom(meta0, { boreType: 'sat', yaw: 0 }, T)
    const b = beamBasisFrom(meta0, { boreType: 'satoff', boreOffAz: 0, boreOffEl: 0, yaw: 0 }, T)
    return a.z.every((v, i) => near(v, b.z[i], 1e-12))
  })())
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
