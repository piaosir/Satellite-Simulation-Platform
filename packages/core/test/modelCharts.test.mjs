// 二期图表件（src/viz/models/timelineChart.js、maskChart.js）里不依赖 DOM 的部分：
//   时间刻度（按显示时区对齐整点 / 整日、日界标记、阶梯）、刻度标签格式、纵轴整齐刻度、最近样本二分、
//   像素折线抽稀（断线 / 方位回绕 / 缺测间隔 / 极值保留）、净空色阶、视场圆锥折线（跨 0/360 断开）；
//   外加两张图的 drawTo 用记录型假 ctx 跑一遍（布局与位图像素映射），真画面在 .modelharness/p2v 截图里看。
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz/models') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const TL = await import(SRC + 'timelineChart.js')
const MC = await import(SRC + 'maskChart.js')
const M = await import(CORE + 'models/mask.mjs')
const { tzParts } = await import(pathToFileURL(path.resolve(HERE, '../../../src/shared/tz.js')).href)

let n = 0
const t = (name, fn) => { try { fn() } catch (e) { e.message = name + '：' + e.message; throw e } n++ }
const H = 3600000, D = 86400000
const T0 = Date.UTC(2026, 8, 23, 3, 17, 42)

// ───────── 时间刻度 ─────────
t('24 h / 600 px / UTC：4 h 阶梯、整点对齐、日界标记', () => {
  const r = TL.timeTicks(T0, T0 + D, 600, 'utc')
  assert.equal(r.step, 14400)
  assert.ok(r.major.length >= 5 && r.major.length <= 7)
  for (const m of r.major) {
    const q = tzParts(m.ms, 'utc')
    assert.ok(q.h % 4 === 0 && q.mi === 0 && q.s === 0)
    assert.equal(m.day, q.h === 0)
    assert.ok(m.ms >= T0 && m.ms <= T0 + D)
  }
  assert.equal(r.major.filter((m) => m.day).length, 1)
  assert.ok(r.sub > 0 && r.minor.every((ms) => ms % (r.step * 1000) !== 0))
})
t('固定偏移档（UTC+8、UTC−5:30）：刻度对齐该档墙钟整点，不是 UTC 整点', () => {
  for (const tz of [480, -330]) {
    const r = TL.timeTicks(T0, T0 + D, 600, tz)
    for (const m of r.major) { const q = tzParts(m.ms, tz); assert.ok(q.mi === 0 && q.s === 0 && q.h % 4 === 0, tz + ' ' + JSON.stringify(q)) }
    const day = r.major.find((m) => m.day)
    assert.ok(day && tzParts(day.ms, tz).h === 0)
  }
  // −330：UTC 整点必不是该档整点
  const r = TL.timeTicks(T0, T0 + D, 600, -330)
  assert.ok(r.major.every((m) => (m.ms / 60000) % 60 === 30))
})
t('本机档按该时刻的实际偏移对齐', () => {
  const r = TL.timeTicks(T0, T0 + 6 * H, 600, 'local')
  for (const m of r.major) { const q = tzParts(m.ms, 'local'); assert.ok(q.s === 0 && q.mi % (r.step / 60) === 0 || r.step >= 3600) }
  const off = -new Date(T0).getTimezoneOffset()
  const r2 = TL.timeTicks(T0, T0 + 6 * H, 600, off)
  assert.deepEqual(r.major.map((m) => m.ms), r2.major.map((m) => m.ms))
})
t('阶梯随跨度：2 min → 秒级、7 天 → 整日；每约 80 px 一个主刻度', () => {
  const a = TL.timeTicks(T0, T0 + 120000, 600, 'utc')
  assert.ok(a.step <= 30 && a.major.length >= 4)
  const b = TL.timeTicks(T0, T0 + 7 * D, 600, 'utc')
  assert.ok(b.step >= 86400 && b.major.every((m) => m.day))
  for (const px of [300, 600, 1200]) {
    const r = TL.timeTicks(T0, T0 + D, px, 'utc')
    assert.ok(px / r.major.length >= 60, px + ' px ' + r.major.length)
  }
  assert.ok(TL.NICE_STEPS_S.includes(a.step) && TL.NICE_STEPS_S.includes(b.step))
})
t('刻度标签：> 4 天只显日期；2 h – 4 天整日显日期、其余 HH:MM；≤ 2 h 显秒', () => {
  const mid = Date.UTC(2026, 8, 24, 0, 0, 0), ten = Date.UTC(2026, 8, 24, 10, 5, 7)
  assert.equal(TL.fmtTimeTick(mid, 5 * D, 'utc'), '09-24')     // > 4 天：主刻度全落日界（见下一条），标签只显日期
  assert.equal(TL.fmtTimeTick(mid, D, 'utc'), '09-24')
  assert.equal(TL.fmtTimeTick(ten, D, 'utc'), '10:05')
  assert.equal(TL.fmtTimeTick(ten, H, 'utc'), '10:05:07')
  assert.equal(TL.fmtTimeTick(ten, D, 480), '18:05')
  assert.equal(TL.fmtTimeFull(ten, 480), '2026-09-24 18:05:07 UTC+8')
  assert.equal(TL.fmtTimeFull(ten, 'utc'), '2026-09-24 10:05:07 UTC')
})

t('跨度 > 4 天：主刻度全落日界、标签不重复（5 天 / 1200 px 不再出 12 h 步长）；≤ 4 天不钳', () => {
  const Tm = Date.UTC(2026, 8, 23, 0, 0, 0)
  for (const [days, px, tz] of [[5, 1200, 480], [5, 800, 480], [7, 1500, 480], [4.5, 1000, 'utc'], [9, 1600, -330], [5, 1200, 'local']]) {
    const t1 = Tm + days * D
    const r = TL.timeTicks(Tm, t1, px, tz)
    assert.ok(r.step >= 86400, days + 'd/' + px + 'px step=' + r.step)
    assert.ok(r.major.every((m) => m.day), days + 'd 主刻度不全在日界')
    const labels = r.major.map((m) => TL.fmtTimeTick(m.ms, t1 - Tm, tz))
    assert.equal(new Set(labels).size, labels.length, labels.join(' | '))
    assert.ok(r.minor.length > 0)                               // 12 h / 6 h 退为次刻度
  }
  const r3 = TL.timeTicks(Tm, Tm + 3 * D, 600, 480)            // 3 天：仍可 12 h，标签日界 / HH:MM 交替
  assert.equal(r3.step, 43200)
  const l3 = r3.major.map((m) => TL.fmtTimeTick(m.ms, 3 * D, 480))
  assert.ok(l3.includes('12:00') && l3.filter((s) => /^\d\d-\d\d$/.test(s)).length === r3.major.filter((m) => m.day).length)
})

// ───────── 纵轴刻度 ─────────
t('niceScale：1/2/2.5/5 阶梯、端点外扩到整刻度、小数位按步长', () => {
  const a = TL.niceScale(0, 9230, 4)
  assert.equal(a.step, 2500); assert.equal(a.lo, 0); assert.equal(a.hi, 10000); assert.equal(a.dec, 0)
  assert.deepEqual(a.ticks, [0, 2500, 5000, 7500, 10000])
  const b = TL.niceScale(0, 0.37, 4)
  assert.equal(b.step, 0.1); assert.equal(b.dec, 1); assert.deepEqual(b.ticks, [0, 0.1, 0.2, 0.3, 0.4])
  const c = TL.niceScale(-0.013, 0.021, 5)
  assert.ok(c.lo <= -0.013 && c.hi >= 0.021 && c.dec >= 2)
  assert.ok(c.ticks.includes(0))
  const d = TL.niceScale(5, 5, 4)
  assert.ok(d.lo < 5 && d.hi > 5)
  const e = TL.niceScale(NaN, 3, 4)
  assert.ok(Number.isFinite(e.lo) && Number.isFinite(e.hi))
})
t('niceScale 角度档：15/30/45/90° 阶梯', () => {
  const a = TL.niceScale(-170, 175, 4, { angle: true })
  assert.equal(a.step, 90); assert.deepEqual(a.ticks, [-180, -90, 0, 90, 180])
  const b = TL.niceScale(31, 148, 4, { angle: true })
  assert.equal(b.step, 30); assert.equal(b.lo, 30); assert.equal(b.hi, 150)
  const c = TL.niceScale(0, 0.8, 4, { angle: true })
  assert.ok(c.step < 1)    // 小于 1° 退回十进阶梯
})

t('极小步长：stepDecimals 按相对容差、刻度改科学计数且两两可分（不再全标「0」）', () => {
  const a = TL.niceScale(1e-9, 3e-9, 4)
  assert.equal(a.step, 5e-10); assert.equal(a.dec, 10)
  const labels = a.ticks.map((v) => TL.fmtValue(v, a.dec))
  assert.equal(new Set(labels).size, labels.length, labels.join(' | '))
  assert.ok(labels.every((s) => s === '0' || /e−\d+$/.test(s)), labels.join(' | '))
  assert.equal(TL.fmtValue(1.5e-9, 10), '1.5e−9'); assert.equal(TL.fmtValue(-2.5e-7, 8), '−2.5e−7'); assert.equal(TL.fmtValue(0, 10), '0')
  const z = TL.niceScale(0, 3.2e-7, 4)                           // ΔG/T 远旁瓣：zero 下限 + 1e−7 dB 量级
  const lz = z.ticks.map((v) => TL.fmtValue(v, z.dec))
  assert.equal(new Set(lz).size, lz.length, lz.join(' | '))
  for (const [st, d] of [[2500, 0], [2.5, 1], [0.25, 2], [0.05, 2], [0.1, 1], [1e-4, 4], [5e-10, 10], [2e-13, 13]]) assert.equal(TL.stepDecimals(st), d, String(st))
  assert.equal(TL.fmtValue(-0.25, 2), '−0.25'); assert.equal(TL.fmtValue(12, 0), '12'); assert.equal(TL.fmtValue(NaN, 2), '—')
})
t('纵轴按时窗定尺度：窗外的峰不撑大纵轴；边界线性插值；回绕 / 断线处不插值；fitAll 按全部样本', () => {
  const tt = [0, 10, 20, 30, 40, 50, 60].map((v) => T0 + v * 60000)
  const y = [175, 120, 146, 90, 60, 170, 20]
  assert.deepEqual(TL.seriesRange(tt, y, tt[1], tt[4]), [60, 146])
  const [lo, hi] = TL.seriesRange(tt, y, tt[1] - 5 * 60000, tt[4] + 5 * 60000)   // 两端各半格：插值 147.5 / 115
  assert.ok(Math.abs(hi - 147.5) < 1e-9 && lo === 60, lo + ' ' + hi)
  const between = TL.seriesRange(tt, y, tt[2] + 60000, tt[2] + 120000)             // 窗内一个样本都没有：两端插值 140.4 / 134.8
  assert.ok(Math.abs(between[0] - 134.8) < 1e-9 && Math.abs(between[1] - 140.4) < 1e-9, between.join(','))
  const w = TL.seriesRange(tt, [170, 178, -178, -170, 0, 0, 0], tt[1] + 60000, tt[2] - 60000, { wrap: 360 })   // 窗内无样本、两端跨回绕：不插值
  assert.deepEqual(w, [Infinity, -Infinity])
  const g = TL.seriesRange(tt, [1, 2, NaN, 4, 5, 6, 7], tt[2] + 1, tt[3] - 1)
  assert.deepEqual(g, [Infinity, -Infinity])
  // 画出来：万向节式窗口（窗内 ≤ 146°，窗外 175°）→ 30° 阶梯上限 150 而不是 180；fitAll 回到 180
  const c = new TL.TimelineChart({ tz: 'utc' })
  const mk = (fitAll) => ({ t0: tt[1], t1: tt[4], t: tt, panels: [{ title: '轴角 (°)', angle: true, fitAll, series: [{ name: 'a', y }] }] })
  c.data = mk(false)
  let lay = c.drawTo(fakeCtx().ctx, 880, 300, true)
  assert.equal(lay.panels[0].sc.hi, 150); assert.equal(lay.panels[0].sc.lo, 60)
  c.data = mk(true)
  lay = c.drawTo(fakeCtx().ctx, 880, 300, true)
  assert.equal(lay.panels[0].sc.hi, 180)
})
t('读数框落在压线最少的一侧 / 一格；同分偏右上；上一帧位置有粘滞', () => {
  assert.equal(TL.inkInRect({ x: 0, y: 0, w: 10, h: 10 }, [[[-5, 5], [15, 5]]]), 10)
  assert.ok(Math.abs(TL.inkInRect({ x: 0, y: 0, w: 10, h: 10 }, [[[-5, -5], [15, 15]]]) - Math.hypot(10, 10)) < 1e-9)
  assert.equal(TL.inkInRect({ x: 0, y: 0, w: 10, h: 10 }, [[[20, 20], [30, 30]], [[5, 5]]]), 2)
  const base = { x: 400, tw: 150, th: 60, W: 880, H: 420, top: 30, bottom: 380, panels: [{ top: 30, h: 150 }, { top: 210, h: 150 }] }
  // 光标右边一整条横穿上部的线（右侧顶部挡线）→ 挑右下或左侧
  const right = [[[400, 40], [880, 40], [880, 60]], [[400, 100], [880, 100]]]
  const a = TL.placeTip({ ...base, ink: right })
  assert.ok(a.x < 400 || a.y > 180, JSON.stringify(a))
  assert.equal(a.cost < 1, true)
  // 没有线：右上
  const b = TL.placeTip({ ...base, ink: [] })
  assert.equal(b.key, 'RT'); assert.equal(b.x, 414); assert.equal(b.y, 34)
  // 右边放不下：只剩左侧
  const c = TL.placeTip({ ...base, x: 800, ink: [] })
  assert.equal(c.key[0], 'L'); assert.ok(c.x + 150 <= 800 - 14 + 1e-9)
  // 粘滞：上次在左上，左上只多压 5 px 线仍留在左上
  const d = TL.placeTip({ ...base, ink: [[[330, 50], [335, 50]]], prev: 'LT' })
  assert.equal(d.key, 'LT')
})

// ───────── 最近样本 / 抽稀 ─────────
t('nearestIndex 与穷举一致', () => {
  const arr = Float64Array.from({ length: 997 }, (_, i) => i * 10 + (i % 3))
  for (let x = -50; x < 10100; x += 3.7) {
    let best = 0
    for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - x) < Math.abs(arr[best] - x)) best = i
    const k = TL.nearestIndex(arr, x)
    assert.equal(Math.abs(arr[k] - x), Math.abs(arr[best] - x))
  }
  assert.equal(TL.nearestIndex([], 3), -1)
})
t('polylineSegments：NaN 断线、方位回绕断线、缺测间隔断线', () => {
  const tt = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((v) => v * 1000)
  const X = (v) => v / 10, Y = (v) => -v
  assert.equal(TL.polylineSegments(tt, [1, 2, NaN, 4, 5, 6, 7, 8, 9, 10], X, Y).length, 2)
  const az = [170, 175, 179, -179, -175, -170, -165, -160, -155, -150]
  assert.equal(TL.polylineSegments(tt, az, X, Y).length, 1)
  assert.equal(TL.polylineSegments(tt, az, X, Y, { wrap: 360 }).length, 2)
  const t2 = [0, 1000, 2000, 60000, 61000]
  assert.equal(TL.polylineSegments(t2, [1, 2, 3, 4, 5], X, Y, { gapMs: 5000 }).length, 2)
})
t('polylineSegments 抽稀：10 万点 → 每像素列 ≤ 4 点，峰谷保留', () => {
  const N = 100000
  const tt = new Float64Array(N), y = new Float64Array(N)
  for (let i = 0; i < N; i++) { tt[i] = i * 1000; y[i] = Math.sin(i / 50) + (i === 54321 ? 7 : 0) }
  const W = 500, X = (v) => (v / tt[N - 1]) * W, Y = (v) => 100 - v * 10
  const segs = TL.polylineSegments(tt, y, X, Y)
  const pts = segs.flat()
  assert.ok(pts.length <= (W + 1) * 4, String(pts.length))
  assert.ok(pts.some((p) => Math.abs(p[1] - Y(y[54321])) < 1e-9))                     // 尖峰
  assert.ok(pts.some((p) => Math.abs(p[1] - Y(-1)) < 1e-3) && pts.some((p) => Math.abs(p[1] - Y(1)) < 1e-3))
})

// ───────── 掩模图纯函数 ─────────
t('clearanceScale：跨度 > 20 倍取对数，端点 0/1，刻度落在域内', () => {
  const c = new Float32Array([0.05, 0.4, 3, 18, Infinity]), b = new Uint8Array([1, 1, 1, 1, 0])
  const s = MC.clearanceScale(c, b)
  assert.ok(s.log); assert.ok(Math.abs(s.t(s.lo)) < 1e-12 && Math.abs(s.t(s.hi) - 1) < 1e-9)
  assert.ok(s.ticks.length >= 2 && s.ticks.every((v) => v >= s.lo * 0.999 && v <= s.hi * 1.001))
  const s2 = MC.clearanceScale(new Float32Array([1, 2, 3]), null)
  assert.ok(!s2.log && s2.ticks.length >= 3)
  assert.equal(MC.clearanceScale(new Float32Array([Infinity]), null), null)
})
t('coneOutline：每点离轴角 = 半角；跨 0/360 断开且无跳线；轴在 +Z 时即等俯仰线', () => {
  for (const [axis, half] of [[[0.3, -0.9, 0.2], 25], [[1, 0.02, 0], 40], [[-0.5, 0.1, -0.8], 12]]) {
    const L = Math.hypot(...axis), z = axis.map((v) => v / L)
    const segs = MC.coneOutline(axis, half, 360)
    for (const sg of segs) {
      for (let i = 0; i < sg.length; i++) {
        const d = MC.azElToDir(sg[i][0], sg[i][1])
        const ang = Math.acos(Math.max(-1, Math.min(1, d[0] * z[0] + d[1] * z[1] + d[2] * z[2]))) * 180 / Math.PI
        assert.ok(Math.abs(ang - half) < 0.05, ang + ' vs ' + half)
        if (i) assert.ok(Math.abs(sg[i][0] - sg[i - 1][0]) < 180)
      }
    }
  }
  const polar = MC.coneOutline([0, 0, 1], 8.7).flat()
  assert.ok(polar.every((p) => Math.abs(p[1] - 81.3) < 1e-6))
  assert.equal(MC.coneOutline([1, 0, 0], 20).length, 2)   // 以 +X 为轴的圆必跨 0/360 缝
})
t('dirToAzEl 与 maskIndex 同一口径（取整后同格）', () => {
  for (let k = 0; k < 2000; k++) {
    const d = [Math.sin(k * 1.3), Math.cos(k * 0.7), Math.sin(k * 0.37)]
    const [az, el] = MC.dirToAzEl(d)
    assert.ok(az >= 0 && az < 360 && el >= -90 && el <= 90)
    assert.equal(Math.round(el + 90) * 360 + (Math.round(az) % 360), M.maskIndex(d))
  }
})

// ───────── drawTo 冒烟（记录型假 ctx，node 下没有 canvas） ─────────
function fakeCtx() {
  const calls = { fillText: [], fillRect: 0, stroke: 0, drawImage: [] }
  const ctx = new Proxy({}, {
    get(o, k) {
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 })
      if (k === 'fillText') return (s, x, y) => calls.fillText.push([String(s), x, y])
      if (k === 'fillRect') return () => { calls.fillRect++ }
      if (k === 'stroke') return () => { calls.stroke++ }
      if (k === 'drawImage') return (...a) => calls.drawImage.push(a)
      if (k === 'createImageData') return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
      if (k in o) return o[k]
      return () => {}
    },
    set(o, k, v) { o[k] = v; return true }
  })
  return { ctx, calls }
}
t('TimelineChart.drawTo：两格 + 状态条 + 灰带 + 竖标，布局自上而下不重叠', () => {
  const c = new TL.TimelineChart({ tz: 480 })
  const tt = Array.from({ length: 1441 }, (_, i) => T0 + i * 60000)
  c.data = {
    t: tt,
    panels: [
      { title: '功率 (W)', unit: 'W', series: [{ name: 'A', y: tt.map((_, i) => 100 + i) }, { name: 'B', y: tt.map((_, i) => (i % 300 < 20 ? NaN : 50)) }] },
      { title: '角度 (°)', unit: '°', angle: true, series: [{ name: 'az', y: tt.map((_, i) => ((i * 3) % 360) - 180), wrap: 360 }], refLines: [{ y: 60, label: '60°' }] }
    ],
    bands: [{ t0: T0 + H, t1: T0 + 2 * H, kind: 'eclipse' }, { t0: T0 + 5 * H, t1: T0 + 6 * H, kind: 'blocked' }, { t0: T0 - D, t1: T0 - H, kind: 'limit' }],
    strips: [{ segs: [{ t0: T0, t1: T0 + 3 * H, style: 'ok' }, { t0: T0 + 3 * H, t1: T0 + 4 * H, style: 'badHatch' }] }],
    marks: [{ t: T0 + 10 * H, panel: 1, label: '0.37 °/s' }]
  }
  const { ctx, calls } = fakeCtx()
  const lay = c.drawTo(ctx, 880, 420, true, { title: '测试' })
  assert.equal(lay.panels.length, 2)
  assert.ok(lay.panels[0].top + lay.panels[0].h < lay.panels[1].top)
  assert.ok(lay.panels[1].top + lay.panels[1].h < lay.strips[0].top)
  assert.ok(lay.bottom <= 420)
  assert.ok(Math.abs(lay.X(T0) - lay.x0) < 1e-9 && Math.abs(lay.X(T0 + D) - lay.x1) < 1e-9)
  const texts = calls.fillText.map((x) => x[0])
  assert.ok(texts.includes('时刻 (UTC+8)') && texts.includes('测试') && texts.includes('0.37 °/s') && texts.includes('60°'))
  assert.ok(texts.some((s) => /^09-24$/.test(s)))           // 日界（UTC+8 的 09-24 00:00）
  assert.ok(!texts.some((s) => /达标|超限|遮挡|合格|可跟踪/.test(s)))   // 结果区不写判定字样
  // 悬停读数（不画，只取行）
  const rows = c._rowsAt(T0 + 30.2 * 60000)
  assert.equal(rows.length, 3); assert.equal(rows[0].value, 130); assert.equal(rows[1].value, 50)
})
t('MaskChart._image：格 → 位图像素（第 0 行 = el +90；多补的第 360 列 = 第 0 列）', () => {
  const blocked = new Uint8Array(M.MASK_N), clearance = new Float32Array(M.MASK_N).fill(Infinity)
  const k1 = M.maskIndex(MC.azElToDir(10, 30)), k0 = M.maskIndex(MC.azElToDir(0, -45))
  blocked[k1] = 1; clearance[k1] = 2.5; blocked[k0] = 1; clearance[k0] = 0.2
  let img = null
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h } getContext() { return { createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData: (d) => { img = d } } } }
  try {
    const c = new MC.MaskChart({ mode: 'clearance' })
    c.data = { blocked, clearance }
    const pal = { blocked: '#e4857d', ramp: ['#621b1a', '#fad6d2'] }
    const r = c._image(pal)
    assert.equal(img.width, 361); assert.equal(img.height, 181)
    const px = (col, row) => img.data[(row * 361 + col) * 4 + 3]
    assert.equal(px(10, 90 - 30), 255)
    assert.equal(px(0, 90 + 45), 255); assert.equal(px(360, 90 + 45), 255)
    assert.equal(px(11, 60), 0)
    let on = 0; for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) on++
    assert.equal(on, 3)
    // 净空档：近（0.2 m）比远（2.5 m）深
    const lum = (col, row) => { const o = (row * 361 + col) * 4; return img.data[o] + img.data[o + 1] + img.data[o + 2] }
    assert.ok(lum(0, 135) < lum(10, 60))
    assert.ok(r.scale && !r.scale.log && Math.abs(r.scale.lo - 0.2) < 1e-6 && Math.abs(r.scale.hi - 2.5) < 1e-6)   // 12.5 倍 < 20：线性
  } finally { delete globalThis.OffscreenCanvas }
})
t('MaskChart.drawTo：图框 2:1、刻度 0..360 / −90..90、极点视轴贴边', () => {
  const blocked = new Uint8Array(M.MASK_N)
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h } getContext() { return { createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} } } }
  try {
    const c = new MC.MaskChart()
    c.data = { blocked, clearance: new Float32Array(M.MASK_N).fill(Infinity) }
    c.overlays = { marks: [{ dirBody: [0, 0, 1], label: '馈源' }, { az: 90, el: 10, label: 'TT&C' }], polylines: [{ pts: [[0, 0], [90, 10]] }] }
    const { ctx, calls } = fakeCtx()
    const lay = c.drawTo(ctx, 880, 520, true)
    assert.ok(Math.abs(lay.pw - 2 * lay.ph) < 1e-9)
    assert.ok(Math.abs(lay.Y(90) - lay.y0) < 1e-9 && Math.abs(lay.Y(-90) - (lay.y0 + lay.ph)) < 1e-9)
    const texts = calls.fillText.map((x) => x[0])
    for (const s of ['0', '180', '360', '−90', '90', '+X', '−Y', '+Z', '−Z', '方位 az (°)', '俯仰 el (°)', '馈源', 'TT&C']) assert.ok(texts.includes(s), s)
    assert.equal(calls.drawImage.length, 1)
  } finally { delete globalThis.OffscreenCanvas }
})

// ───────── 视轴标签翻边 / 最右半格悬停 / 换容器保留数据 ─────────
const FakeOff = class { constructor(w, h) { this.width = w; this.height = h } getContext() { return { createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} } } }
t('MaskChart 视轴标签：右边放不下翻到左边右对齐、贴上边翻到下面，不被图框裁掉', () => {
  globalThis.OffscreenCanvas = FakeOff
  try {
    const c = new MC.MaskChart()
    c.data = { blocked: new Uint8Array(M.MASK_N) }
    c.overlays = { marks: [{ az: 350, el: 10, label: 'TT&C −Y' }, { az: 120, el: 88, label: '上沿' }, { az: 40, el: 10, label: '常规' }], polylines: [] }
    const { ctx, calls } = fakeCtx()
    const aligns = []
    const ctx2 = new Proxy(ctx, { get(o, k) { if (k === 'fillText') return (s2, x, y) => { aligns.push([s2, x, y, o.textAlign, o.textBaseline]); calls.fillText.push([s2, x, y]) }; return o[k] }, set(o, k, v) { o[k] = v; return true } })
    const lay = c.drawTo(ctx2, 880, 520, false)
    const f = (nm) => aligns.find((a) => a[0] === nm)
    const a = f('TT&C −Y'), b = f('上沿'), g = f('常规')
    assert.equal(a[3], 'right'); assert.ok(a[1] < lay.X(350))
    assert.ok(a[1] - 7 * 6 >= lay.x0)                                // 假 ctx 字宽 6 px/字：左侧整条放得下
    assert.equal(b[4], 'top'); assert.ok(b[2] > lay.Y(88))
    assert.equal(g[3], 'left'); assert.equal(g[4], 'bottom'); assert.ok(g[1] > lay.X(40))
  } finally { delete globalThis.OffscreenCanvas }
})
t('MaskChart 悬停最右半格（az ∈ [359.5, 360]）：下标仍是第 0 列，高亮 / 读数框画在右端不跳到左边', () => {
  globalThis.OffscreenCanvas = FakeOff
  try {
    const blocked = new Uint8Array(M.MASK_N), clearance = new Float32Array(M.MASK_N).fill(Infinity)
    const k = M.maskIndex(MC.azElToDir(0, 10)); blocked[k] = 1; clearance[k] = 1.25
    let info = null
    const c = new MC.MaskChart({ onHover: (i) => { info = i } })
    c.data = { blocked, clearance }
    const rects = []
    const { ctx } = fakeCtx()
    const ctx2 = new Proxy(ctx, { get(o, k2) { if (k2 === 'strokeRect') return (...a) => rects.push(a); return o[k2] }, set(o, k2, v) { o[k2] = v; return true } })
    c._cv = { getBoundingClientRect: () => ({ left: 0, top: 0 }), getContext: () => ctx2 }
    c._cssW = 880; c._cssH = 520
    c._layout = c.drawTo(ctx2, 880, 520, false)
    const lay = c._layout
    c._move({ clientX: lay.X(359.8), clientY: lay.Y(10) })
    assert.equal(c.hover.idx, k); assert.equal(c.hover.wrapRight, true)
    assert.deepEqual(info, { az: 0, el: 10, idx: k, blocked: 1, clearanceM: 1.25, node: null })   // 回调不带内部标志
    rects.length = 0
    c.drawTo(ctx2, 880, 520, false)
    const hl = rects.find((r) => Math.abs(r[0] - (lay.X(359.5) - 0.5)) < 1e-6)
    assert.ok(hl, '高亮框不在右端：' + JSON.stringify(rects.slice(-3)))
    // 同一格从左半格移过来要重画（idx 相同但位置不同）
    c._move({ clientX: lay.X(0.2), clientY: lay.Y(10) })
    assert.equal(c.hover.wrapRight, false)
  } finally { delete globalThis.OffscreenCanvas }
})
t('mount 换容器：数据 / 叠加保留、旧容器的画布摘掉；dispose 才清数据（两张图）', () => {
  const made = []
  const mkEl = () => ({ clientWidth: 880, clientHeight: 400, kids: [], appendChild(c2) { c2.parentNode = this; this.kids.push(c2) }, removeChild(c2) { this.kids = this.kids.filter((x) => x !== c2); c2.parentNode = null } })
  globalThis.document = {
    documentElement: { getAttribute: () => 'light' },
    createElement: () => { const f = fakeCtx(); const cv = { style: {}, width: 300, height: 150, parentNode: null, calls: f.calls, setAttribute() {}, addEventListener() {}, removeEventListener() {}, getContext: () => f.ctx, getBoundingClientRect: () => ({ left: 0, top: 0 }) }; made.push(cv); return cv }
  }
  globalThis.OffscreenCanvas = FakeOff
  try {
    const blocked = new Uint8Array(M.MASK_N); blocked[5000] = 1
    const data = { blocked, clearance: new Float32Array(M.MASK_N).fill(Infinity) }
    let cleared = 0
    const c = new MC.MaskChart({ onHover: (i) => { if (i === null) cleared++ } })
    const e1 = mkEl(), e2 = mkEl()
    c.mount(e1); c.setData(data); c.setOverlays({ marks: [{ az: 10, el: 10, label: 'x' }] })
    c.hover = { az: 1, el: 1, idx: 1 }
    c.mount(e2)
    assert.equal(c.data, data); assert.equal(c.overlays.marks.length, 1)
    assert.equal(e1.kids.length, 0); assert.equal(e2.kids.length, 1)
    assert.equal(cleared, 1); assert.equal(c.hover, null)
    assert.equal(e2.kids[0].calls.drawImage.length, 1)                    // 新画布上直接带数据画了一遍
    c.dispose()
    assert.equal(c.data, null); assert.equal(e2.kids.length, 0)
    const tl = new TL.TimelineChart({ tz: 'utc' })
    const tt = Array.from({ length: 61 }, (_, i) => T0 + i * 60000)
    const td = { t: tt, panels: [{ title: 'P (W)', series: [{ name: 'P', y: tt.map((_, i) => i) }] }] }
    tl.mount(e1); tl.setData(td); tl.mount(e2)
    assert.equal(tl.data, td); assert.equal(e1.kids.length, 0); assert.equal(e2.kids.length, 1)
    assert.ok(e2.kids[0].calls.fillText.some((x) => x[0] === 'P (W)'))
    tl.dispose(); assert.equal(tl.data, null)
  } finally { delete globalThis.document; delete globalThis.OffscreenCanvas }
})

console.log(`modelCharts: ${n} 项通过`)
