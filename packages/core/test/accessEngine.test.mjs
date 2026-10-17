// 唯一访问引擎（packages/core/utils/access/accessCore.mjs，差距分析 B-01）自测。运行：node packages/core/test/accessEngine.test.mjs
//
// 钉死的事：
//   ① CJS 镜像（主进程 ngsoGeometry 用）与 ESM 源逐字一致：scripts/gen-access-cjs.mjs 现生成 = 仓库里的 accessCore.js；各导出函数 String(fn) 相同。
//   ② 解析真值：单星圆轨道 × 不转的球形地球，过境时长 = 2·acos(cos λ / cos β) / n（β = 站离轨道面的地心角，λ = acos(R/r·cos ε) − ε），
//      峰值仰角 = atan((cos β − R/r)/sin β)；贴着可见边缘的掠过（时长 0.3–3 s）也要抓到。
//   ③ 暴力扫描对拍（真 SGP4）：随机 LEO / MEO / HEO / 近 GEO × 随机站 × 门限 5–60°：1 s 暴力（24 h）与 0.1 s 暴力（6 h），
//      断言 0 漏检、边界差 < 0.1 s（实得 ≤ 1 ms 量级）；引擎多出来的窗只许是比暴力步长还短的过境（逐个用 1 ms 细扫核实）。
//   ④ 差距分析 B 路量级复现：Walker 550 km / 53° 6×22 = 132 颗、北京、72 h：门限 25° / 40° 过境 1202 / 712，
//      与 1 s 暴力逐窗对上；时间覆盖与最长中断一致到 0.001 pp / 0.01 min（旧版 90 s 粗扫：漏 1.75% / 6.04%，最长中断 11.81 vs 3.44 min）。
//   ⑤ 多点目标（任一点可见即算）= 各点暴力窗口的并；移动目标（250 m/s 航迹）= 1 s 暴力。
//   ⑥ 主进程 solveAccessWindows（CJS 镜像）与渲染端 accessWindows 同一颗星同一个站逐窗对上；GEO 常驻一窗。
import { createRequire } from 'node:module'
import fs from 'node:fs'
import sat from '../../../src/viz/constellation/satellite.js'
import { posAtMs } from '../../../src/viz/constellation/satPos.js'
import * as E from '../utils/access/accessCore.mjs'
import { accessWindows, timeCoverage, accessMinDetectMs } from '../../../src/viz/vis/visibility.js'
import { buildCjs, SRC, DST } from '../../../scripts/gen-access-cjs.mjs'

const require = createRequire(import.meta.url)
let pass = 0, fail = 0
const ok = (name, cond, info) => {
  if (cond) { pass++; console.log('PASS  ' + name + (info != null ? '  (' + info + ')' : '')) } else { fail++; console.log('FAIL  ' + name + (info != null ? '  (' + info + ')' : '')) }
}
const D2R = Math.PI / 180, MU = 398600.4418, RE = 6378.137
const epoch = new Date(Date.UTC(2026, 9, 17, 0, 0, 0))

// ══════════════ ① CJS 镜像逐字一致 ══════════════
{
  const want = buildCjs(fs.readFileSync(SRC, 'utf8'))
  const have = fs.readFileSync(DST, 'utf8').replace(/\r\n/g, '\n')
  ok('① accessCore.js = gen-access-cjs.mjs 现生成（改了 .mjs 没重生成就红）', have === want, have === want ? null : '先跑 node scripts/gen-access-cjs.mjs')
  const C = require('../utils/access/accessCore.js')
  const names = Object.keys(E)
  ok('① 导出名单一致', names.slice().sort().join(',') === Object.keys(C).sort().join(','), names.length + ' 个')
  const diff = names.filter((k) => (typeof E[k] === 'function' ? String(E[k]) !== String(C[k]) : JSON.stringify(E[k]) !== JSON.stringify(C[k])))
  ok('① 各导出函数 String(fn) 逐字相同、常量逐值相同', diff.length === 0, diff.join(','))
}

// ══════════════ ② 解析真值：圆轨道 × 不转的球形地球 ══════════════
{
  const R = 6371
  // 轨道面 = 赤道面；站在纬度 β 的经度 0 处（观测者基直接按球面造：o = R·û）
  const mkObs = (betaDeg) => { const b = betaDeg * D2R; return { ox: R * Math.cos(b), oy: 0, oz: R * Math.sin(b), ux: Math.cos(b), uy: 0, uz: Math.sin(b), vx: 0, vy: 0, vz: 0 } }
  let nWin = 0, worstDur = 0, worstPk = 0, worstPkT = 0, worstZen = 0, missed = 0, graze = 0
  const H = 6 * 3600e3
  for (const altKm of [550, 1200, 8000, 20000]) {
    const r = R + altKm, n = Math.sqrt(MU / (r * r * r))   // rad/s
    const P = 2 * Math.PI / n / 60
    for (const thr of [5, 10, 30, 60]) {
      const lam = Math.acos(R / r * Math.cos(thr * D2R)) - thr * D2R
      if (!(lam > 0)) continue
      // β 从 0 到 λ 的 99.99%（最后一档是掠过：只有零点几秒）
      for (const f of [0, 0.3, 0.7, 0.95, 0.9999, 0.999999]) {
        const beta = lam * f
        const ob = mkObs(beta / D2R)
        const phi0 = -Math.PI / 2   // t=0 时卫星在 −90° 经度（离站最远附近），首个过境正中在 t = (π/2)/n
        const stateAt = (tMs, s) => { const a = phi0 + n * tMs / 1000; s.x = r * Math.cos(a); s.y = r * Math.sin(a); s.z = 0; s.vx = -r * n * Math.sin(a); s.vy = r * n * Math.cos(a); s.vz = 0; return true }
        const res = E.elevWindows({ stateAt, obs: [ob], thrDeg: thr, t0: 0, t1: H, periodMin: P, vSat: r * n * 1.001 })
        const ratio = Math.cos(lam) / Math.cos(beta)
        const durTrue = ratio <= 1 ? 2 * Math.acos(ratio) / n * 1000 : 0   // ms
        const pkTrue = beta > 0 ? Math.atan2(Math.cos(beta) - R / r, Math.sin(beta)) / D2R : 90
        const expectN = Math.floor((H / 1000 * n - Math.PI / 2) / (2 * Math.PI)) + 1   // 过境正中时刻 (π/2 + 2πk)/n ≤ H
        const full = res.windows.filter((w) => !w.truncStart && !w.truncEnd)
        if (durTrue < 2 * E.minDetectMs()) continue
        nWin += full.length
        if (full.length < expectN - 1) missed++
        if (durTrue < 5000) graze += full.length
        for (const w of full) {
          worstDur = Math.max(worstDur, Math.abs((w.endMs - w.startMs) - durTrue))
          const k = Math.round((n * w.peakMs / 1000 - Math.PI / 2) / (2 * Math.PI)), tPk = (Math.PI / 2 + 2 * Math.PI * k) / n * 1000
          worstPkT = Math.max(worstPkT, Math.abs(w.peakMs - tPk))
          // 天顶过境（β = 0）的仰角在峰值处是尖点：峰值时刻差 0.1 s 对应的仰角差是一阶的（≤ 角速率 × 0.1 s）；其余光滑峰是二阶小量
          if (f === 0) worstZen = Math.max(worstZen, Math.abs(w.peakEl - pkTrue) / ((r * n / altKm) / D2R * 0.1))
          else worstPk = Math.max(worstPk, Math.abs(w.peakEl - pkTrue))
        }
      }
    }
  }
  ok('② 解析过境：各高度 × 门限 × β 的窗口一个不少', missed === 0 && nWin > 100, `${nWin} 窗（其中掠过 < 5 s 的 ${graze} 窗）`)
  ok('② 解析过境时长误差 ≤ 2 ms（AOS / LOS 各 1 ms）', worstDur <= 2, worstDur.toFixed(3) + ' ms')
  ok('② 解析峰值时刻误差 ≤ 0.1 s', worstPkT <= 100, worstPkT.toFixed(2) + ' ms')
  ok('② 解析峰值仰角误差 ≤ 1e-4°（非天顶过境）；天顶尖点 ≤ 角速率 × 0.1 s', worstPk <= 1e-4 && worstZen <= 1, worstPk.toExponential(2) + '° · 天顶 ' + worstZen.toFixed(3) + ' 倍界')
  ok('② 最短可检出过境时长 = 2 × 峰值精度 = 0.2 s', E.minDetectMs() === 200 && accessMinDetectMs() === 200)
}

// ══════════════ 共用：真 SGP4 取位 + 同式仰角的暴力扫描 ══════════════
const mkState = (rec) => (tMs, s) => { const jd = tMs / 864e5 + 2440587.5; const pv = posAtMs(rec, tMs, jd); if (!pv) return false; E.temeToEcef(pv.position, pv.velocity, sat.gstime(jd), s); return true }
const elevFn = (rec, ob) => { const st = mkState(rec), s = {}; return (tMs) => { if (!st(tMs, s)) return -999; const rx = s.x - ob.ox, ry = s.y - ob.oy, rz = s.z - ob.oz; return Math.asin((rx * ob.ux + ry * ob.uy + rz * ob.uz) / Math.hypot(rx, ry, rz)) / D2R } }
// 固定步长暴力：f(t) ≥ thr 的区间，翻转处二分到 0.01 ms
function brute(f, thr, t0, t1, stepMs) {
  const out = []
  const bis = (a, b, aIn) => { for (let i = 0; i < 80 && b - a > 0.01; i++) { const m = (a + b) / 2; if ((f(m) >= thr) === aIn) a = m; else b = m } return aIn ? a : b }
  let prevT = t0, prevIn = f(t0) >= thr, start = prevIn ? t0 : null
  for (let t = t0 + stepMs; ; t += stepMs) {
    if (t > t1) t = t1
    const inn = f(t) >= thr
    if (inn && !prevIn) start = bis(prevT, t, false)
    else if (!inn && prevIn) { out.push([start, bis(prevT, t, true)]); start = null }
    prevT = t; prevIn = inn
    if (t >= t1) break
  }
  if (prevIn) out.push([start, t1])
  return out
}
// 引擎窗 vs 暴力窗：漏检（暴力有、引擎没有）、多检（引擎有、暴力没有；短于暴力步长的用 1 ms 细扫核实）、边界差
function compare(eng, br, f, thr, stepMs) {
  let miss = 0, extraBad = 0, extraShort = 0, maxD = 0
  const hit = (a, b) => (x) => x[0] < b + 1 && x[1] > a - 1
  for (const [a, b] of br) {
    const w = eng.find((x) => x.startMs < b + 1 && x.endMs > a - 1)
    if (!w) { miss++; continue }
    maxD = Math.max(maxD, Math.abs(w.startMs - a), Math.abs(w.endMs - b))
  }
  for (const w of eng) {
    if (br.find(hit(w.startMs, w.endMs))) continue
    const fine = brute(f, thr, w.startMs - 2000, w.endMs + 2000, 1)
    if (w.endMs - w.startMs < stepMs && fine.length === 1 && Math.abs(fine[0][0] - w.startMs) < 2 && Math.abs(fine[0][1] - w.endMs) < 2) extraShort++
    else extraBad++
  }
  return { miss, extraBad, extraShort, maxD }
}
let seed = 20261017
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
function randRec(kind, i) {
  let a, ecc = 0.0001 + rnd() * 0.002, incl = rnd() * 180
  if (kind === 'leo') a = RE + 300 + rnd() * 1700
  else if (kind === 'meo') a = RE + 8000 + rnd() * 15000
  else if (kind === 'heo') { a = 26554; ecc = 0.6 + rnd() * 0.12; incl = 63.4 }
  else { a = RE + 35786; ecc = rnd() * 0.001; incl = rnd() * 6 }
  const n = 86400 * Math.sqrt(MU / a ** 3) / (2 * Math.PI)
  return sat.omm2satrec({ noradId: 910000 + i, epoch: epoch.toISOString(), meanMotion: n, ecc, incl, raan: rnd() * 360, argp: rnd() * 360, ma: rnd() * 360, bstar: 0, mdot: 0, mddot: 0 })
}

// ══════════════ ③ 随机星 × 随机站 × 门限 5–60°：1 s / 0.1 s 暴力对拍 ══════════════
for (const [label, stepMs, hours, nPairs, kinds, thrSpan] of [
  ['1 s 暴力 · 24 h', 1000, 24, 100, ['leo', 'leo', 'leo', 'leo', 'meo', 'heo', 'geo'], 55],
  ['0.1 s 暴力 · 6 h', 100, 6, 36, ['leo'], 25]
]) {
  let nB = 0, nE = 0, miss = 0, extraBad = 0, extraShort = 0, maxD = 0, shortest = Infinity, evals = 0
  for (let i = 0; i < nPairs; i++) {
    const rec = randRec(kinds[i % kinds.length], i)
    if (rec.error) continue
    const lat = -60 + rnd() * 120, lon = -180 + rnd() * 360, thr = 5 + rnd() * thrSpan
    const ob = E.observerOf(lat, lon, rnd() * 2)
    const t0 = epoch.getTime() + Math.floor(rnd() * 86400e3), t1 = t0 + hours * 3600e3
    const f = elevFn(rec, ob)
    const res = E.elevWindows({ stateAt: mkState(rec), obs: [ob], thrDeg: thr, t0, t1, periodMin: 2 * Math.PI / rec.no, vSat: E.satSpeedBound(rec) })
    evals += res.evals
    const br = brute(f, thr, t0, t1, stepMs)
    nB += br.length; nE += res.windows.length
    for (const [a, b] of br) if (b - a < shortest) shortest = b - a
    const c = compare(res.windows, br, f, thr, stepMs)
    miss += c.miss; extraBad += c.extraBad; extraShort += c.extraShort; maxD = Math.max(maxD, c.maxD)
  }
  ok(`③ ${label}：0 漏检`, miss === 0 && nB > 0, `暴力 ${nB} 窗 / 引擎 ${nE} 窗 · 暴力最短 ${(shortest / 1000).toFixed(2)} s · 引擎平均 ${(evals / nPairs).toFixed(0)} 次取值/对`)
  ok(`③ ${label}：边界差 < 0.1 s`, maxD < 100, maxD.toFixed(3) + ' ms')
  ok(`③ ${label}：引擎多出的窗都是暴力步长漏掉的真过境`, extraBad === 0, `短于步长、细扫核实 ${extraShort} 窗`)
}

// ══════════════ ③ 掠过：门限贴着峰值 → 零点几秒到几秒的过境 ══════════════
{
  let found = 0, total = 0, worst = 0
  for (let i = 0; i < 24; i++) {
    const rec = randRec('leo', 500 + i)
    const ob = E.observerOf(-50 + rnd() * 100, rnd() * 360 - 180, 0)
    const t0 = epoch.getTime(), t1 = t0 + 12 * 3600e3
    const f = elevFn(rec, ob)
    const base = E.elevWindows({ stateAt: mkState(rec), obs: [ob], thrDeg: 0, t0, t1, periodMin: 2 * Math.PI / rec.no, vSat: E.satSpeedBound(rec) })
    const w = base.windows.find((x) => !x.truncStart && !x.truncEnd && x.peakEl > 3)
    if (!w) continue
    for (const dEl of [1e-5, 1e-4, 1e-3]) {   // 门限 = 峰值 − dEl：过境时长约零点几秒到几秒
      const thr = w.peakEl - dEl
      const fine = brute(f, thr, w.peakMs - 120e3, w.peakMs + 120e3, 2)
      if (!fine.length) continue
      const durTrue = fine[0][1] - fine[0][0]
      if (durTrue < E.minDetectMs()) continue
      total++
      const r = E.elevWindows({ stateAt: mkState(rec), obs: [ob], thrDeg: thr, t0, t1, periodMin: 2 * Math.PI / rec.no, vSat: E.satSpeedBound(rec) })
      const m = r.windows.find((x) => x.startMs < fine[0][1] + 5 && x.endMs > fine[0][0] - 5)
      if (m) { found++; worst = Math.max(worst, Math.abs(m.startMs - fine[0][0]), Math.abs(m.endMs - fine[0][1])) }
    }
  }
  ok('③ 掠过（门限 = 峰值 − 1e-5…1e-3°，时长 0.2–几秒）一个不漏、边界差 ≤ 5 ms', found === total && total >= 30, `${found} / ${total}，最大边界差 ${worst.toFixed(2)} ms`)
}

// ══════════════ ④ 差距分析 B 路量级复现（132 颗 × 北京 × 72 h）══════════════
function walker({ altKm, incl, P, S, F = 1 }) {
  const a = RE + altKm, n = 86400 * Math.sqrt(MU / a ** 3) / (2 * Math.PI), out = []
  for (let p = 0; p < P; p++) for (let s = 0; s < S; s++) out.push({ rec: sat.omm2satrec({ noradId: 900000 + p * 100 + s, epoch: epoch.toISOString(), meanMotion: n, ecc: 0.0001, incl, raan: 360 * p / P, argp: 0, ma: (360 * s / S + 360 * F * p / (P * S)) % 360, bstar: 0, mdot: 0, mddot: 0 }), name: 'W' + p + '-' + s, noradId: 900000 + p * 100 + s, group: 'w', _cc: false })
  return out
}
{
  const ents = walker({ altKm: 550, incl: 53, P: 6, S: 22 })
  const BJ = { lat: 39.9042, lon: 116.4074 }, ob = E.observerOf(BJ.lat, BJ.lon, 0)
  const H = 72 * 3600, t0 = epoch.getTime(), t1 = t0 + H * 1000
  // 1 s 暴力（同一仰角式）：全 132 颗 × 72 h 要 3400 万次取值、太慢进不了 npm test —— 逐窗暴力只抽每 4 颗取 1 颗（33 颗），
  // 总过境数 / 时间覆盖 / 最长中断对的是全星 1 s 暴力的结果（2026-10-17 一次性全量跑出，与差距分析 B 路 access_miss.mjs 的真值一致）：
  //   25°：1202 窗 · 85.4014 % · 最长中断 3.441 min；40°：712 窗 · 36.7561 % · 76.679 min
  const TRUTH = { 25: { n: 1202, pct: 85.4014, gap: 3.441 }, 40: { n: 712, pct: 36.7561, gap: 76.679 } }
  const sub = ents.filter((_, i) => i % 4 === 0)
  const series = sub.map((e) => { const f = elevFn(e.rec, ob), a = new Float64Array(H + 1); for (let k = 0; k <= H; k++) a[k] = f(t0 + k * 1000); return { e, f, a } })
  const bruteSeries = ({ f, a }, thr) => {
    const out = [], bis = (x, y, xIn) => { for (let i = 0; i < 80 && y - x > 0.01; i++) { const m = (x + y) / 2; if ((f(m) >= thr) === xIn) x = m; else y = m } return xIn ? x : y }
    let start = a[0] >= thr ? t0 : null
    for (let k = 1; k <= H; k++) {
      const pin = a[k - 1] >= thr, inn = a[k] >= thr
      if (inn && !pin) start = bis(t0 + (k - 1) * 1000, t0 + k * 1000, false)
      else if (!inn && pin) { out.push([start, bis(t0 + (k - 1) * 1000, t0 + k * 1000, true)]); start = null }
    }
    if (start != null) out.push([start, t1])
    return out
  }
  for (const thr of [25, 40]) {
    const T = TRUTH[thr]
    const tA = performance.now()
    const res = accessWindows(ents, [BJ], { now: epoch, ccNow: epoch }, H, thr)
    const ms = performance.now() - tA
    let nE = 0; for (const s of res) nE += s.windows.length
    let nB = 0, nEs = 0, miss = 0, extra = 0, maxD = 0
    for (const sr of series) {
      const br = bruteSeries(sr, thr)
      const mine = (res.find((s) => s.noradId === sr.e.noradId) || { windows: [] }).windows
      nB += br.length; nEs += mine.length
      for (const [a, b] of br) {
        const w = mine.find((x) => x.startMs < b + 1 && x.endMs > a - 1)
        if (!w) miss++; else maxD = Math.max(maxD, Math.abs(w.startMs - a), Math.abs(w.endMs - b))
      }
      for (const w of mine) if (!br.find(([a, b]) => w.startMs < b + 1 && w.endMs > a - 1)) extra++
    }
    const tc = timeCoverage(res, H / 60)
    ok(`④ 门限 ${thr}°：全星过境 ${T.n} / ${T.n}（= 全星 1 s 暴力）`, nE === T.n, `引擎 ${nE} · ${ms.toFixed(0)} ms`)
    ok(`④ 门限 ${thr}°：抽查 33 颗与 1 s 暴力逐窗对上（0 漏检、0 多检、边界差 < 0.1 s）`, miss === 0 && extra === 0 && nB === nEs && maxD < 100, `${nB} 窗 · 边界差 ${maxD.toFixed(2)} ms`)
    ok(`④ 门限 ${thr}°：时间覆盖差 < 0.001 pp、最长中断差 < 0.01 min`, Math.abs(tc.pct - T.pct) < 0.001 && Math.abs(tc.maxGapMin - T.gap) < 0.01,
      `覆盖 ${tc.pct.toFixed(4)}% vs ${T.pct}% · 最长中断 ${tc.maxGapMin.toFixed(3)} vs ${T.gap} min`)
  }
}

// ══════════════ ⑤ 多点目标 = 各点窗口的并；移动目标 = 暴力 ══════════════
{
  const ents = walker({ altKm: 780, incl: 86.4, P: 6, S: 11 })
  const pts = [{ lat: 30, lon: 100 }, { lat: 33, lon: 110 }, { lat: 27, lon: 120 }]
  const H = 12 * 3600, t0 = epoch.getTime(), t1 = t0 + H * 1000, thr = 20
  const res = accessWindows(ents, pts, { now: epoch, ccNow: epoch }, H, thr)
  const obs = pts.map((p) => E.observerOf(p.lat, p.lon, 0))
  let miss = 0, extra = 0, maxD = 0, nB = 0
  for (const e of ents) {
    const fs3 = obs.map((ob) => elevFn(e.rec, ob))
    const fmax = (t) => Math.max(fs3[0](t), fs3[1](t), fs3[2](t))
    const br = brute(fmax, thr, t0, t1, 1000)
    nB += br.length
    const mine = (res.find((s) => s.noradId === e.noradId) || { windows: [] }).windows
    for (const [a, b] of br) { const w = mine.find((x) => x.startMs < b + 1 && x.endMs > a - 1); if (!w) miss++; else maxD = Math.max(maxD, Math.abs(w.startMs - a), Math.abs(w.endMs - b)) }
    for (const w of mine) if (!br.find(([a, b]) => w.startMs < b + 1 && w.endMs > a - 1)) extra++
  }
  ok('⑤ 多点目标（三点任一可见）：与「各点最大仰角」的 1 s 暴力逐窗对上', miss === 0 && extra === 0 && maxD < 100 && nB > 0, `${nB} 窗 · 边界差 ${maxD.toFixed(2)} ms`)

  // 移动目标：从 (20N, 110E) 起以 250 m/s、航向 45° 走大圆
  const v = 0.25, hdg = 45 * D2R, lat0 = 20 * D2R, lon0 = 110 * D2R, Rm = 6371.0088
  const at = (tMs) => {
    const d = v * (tMs - t0) / 1000 / Rm
    const la = Math.asin(Math.sin(lat0) * Math.cos(d) + Math.cos(lat0) * Math.sin(d) * Math.cos(hdg))
    const lo = lon0 + Math.atan2(Math.sin(hdg) * Math.sin(d) * Math.cos(lat0), Math.cos(d) - Math.sin(lat0) * Math.sin(la))
    return [{ lat: la / D2R, lon: lo / D2R, altKm: 10 }]
  }
  const Hm = 12 * 3600, t1m = t0 + Hm * 1000
  const rm = accessWindows(ents, [], { now: epoch, ccNow: epoch }, Hm, thr, { targetsAt: at })
  let missM = 0, extraM = 0, maxDM = 0, nBM = 0
  for (const e of ents) {
    const st = mkState(e.rec), s = {}
    const f = (tMs) => { if (!st(tMs, s)) return -999; const q = at(tMs)[0], ob = E.observerOf(q.lat, q.lon, q.altKm); const rx = s.x - ob.ox, ry = s.y - ob.oy, rz = s.z - ob.oz; return Math.asin((rx * ob.ux + ry * ob.uy + rz * ob.uz) / Math.hypot(rx, ry, rz)) / D2R }
    const br = brute(f, thr, t0, t1m, 1000)
    nBM += br.length
    const mine = (rm.find((x) => x.noradId === e.noradId) || { windows: [] }).windows
    for (const [a, b] of br) { const w = mine.find((x) => x.startMs < b + 1 && x.endMs > a - 1); if (!w) missM++; else maxDM = Math.max(maxDM, Math.abs(w.startMs - a), Math.abs(w.endMs - b)) }
    for (const w of mine) if (!br.find(([a, b]) => w.startMs < b + 1 && w.endMs > a - 1)) extraM++
  }
  ok('⑤ 移动目标（250 m/s 大圆航迹，步长 ≤ 60 s）：与 1 s 暴力逐窗对上', missM === 0 && extraM === 0 && maxDM < 100 && nBM > 0, `${nBM} 窗 · 边界差 ${maxDM.toFixed(2)} ms`)
}

// ══════════════ ⑥ 主进程 solveAccessWindows（CJS 镜像）══════════════
{
  const G = require('../utils/ngsoGeometry.js')
  const omm = { type: 'omm', noradId: '25544', epoch: '2026-10-16T00:00:00.000Z', meanMotion: 15.5, ecc: 0.0005, incl: 51.6, raan: 120, argp: 90, ma: 10, bstar: 0, mdot: 0, mddot: 0 }
  const station = { lonDeg: 116.4074, latDeg: 39.9042, altKm: 0.044, minElevDeg: 10, freqGHz: 14.25 }
  const q = { t0ISO: '2026-10-16T06:00:00.000Z', horizonHours: 24 }
  const acc = G.solveAccessWindows({ orbit: omm, station, ...q })
  const rec = sat.omm2satrec({ noradId: omm.noradId, epoch: omm.epoch, meanMotion: omm.meanMotion, ecc: omm.ecc, incl: omm.incl, raan: omm.raan, argp: omm.argp, ma: omm.ma, bstar: 0, mdot: 0, mddot: 0 })
  const t0 = Date.parse(q.t0ISO)
  const rr = accessWindows([{ rec, name: 'X', noradId: 1, group: 'g' }], [{ lat: station.latDeg, lon: station.lonDeg, altKm: station.altKm }], { now: new Date(t0), ccNow: new Date(t0) }, 24 * 3600, 10)
  const ws = rr.length ? rr[0].windows : []
  let maxD = 0
  for (let i = 0; i < Math.min(ws.length, acc.windows.length); i++) maxD = Math.max(maxD, Math.abs(Date.parse(acc.windows[i].startISO) - ws[i].startMs), Math.abs(Date.parse(acc.windows[i].endISO) - ws[i].endMs))
  ok('⑥ 主进程 solveAccessWindows 与渲染端 accessWindows 同星同站：窗数相同、起止差 ≤ 2 ms（ISO 串到毫秒）', acc.feasible && acc.totalWindows === ws.length && ws.length > 0 && maxD <= 2, `${acc.totalWindows} 窗 · ${maxD.toFixed(2)} ms`)
  const f = elevFn(rec, E.observerOf(station.latDeg, station.lonDeg, station.altKm))
  const br = brute(f, 10, t0, t0 + 24 * 3600e3, 1000)
  ok('⑥ solveAccessWindows 与 1 s 暴力逐窗对上', br.length === acc.totalWindows && br.every(([a, b], i) => Math.abs(Date.parse(acc.windows[i].startISO) - a) < 3 && Math.abs(Date.parse(acc.windows[i].endISO) - b) < 3), `${br.length} 窗`)
  ok('⑥ 窗口字段口径不变（durationMin / peakElevDeg / peakISO / maxSlantKm / clipped）', acc.windows.every((w) => w.durationMin > 0 && w.peakElevDeg >= 10 && Date.parse(w.peakISO) >= Date.parse(w.startISO) && Date.parse(w.peakISO) <= Date.parse(w.endISO) && w.maxSlantKm > 0 && typeof w.clipped === 'boolean'))
  const geo = G.solveAccessWindows({ orbit: { type: 'omm', noradId: '41838', epoch: '2026-10-16T00:00:00.000Z', meanMotion: 1.00271, ecc: 0.0002, incl: 0.03, raan: 80, argp: 200, ma: 190, bstar: 0, mdot: 0, mddot: 0 }, station, ...q })
  ok('⑥ GEO：常驻一窗（两端截断），时长 = 时窗', geo.feasible && geo.totalWindows === 1 && geo.windows[0].clipped && Math.abs(geo.windows[0].durationMin - 24 * 60) < 1e-6, geo.totalWindows + ' 窗')
}

// ══════════════ ⑦ 多约束接口（allOf：余量取最小）+ 通用 scanWindows：解析函数对 1 ms 暴力 ══════════════
{
  // 两条解析「约束」：m1 = sin(a·t)、m2 = cos(b·t + φ)，|m'| ≤ a / b ⇒ 不变号时长 = |m| / 速率上界；窗口 = 两者都 ≥ 0 的交集
  const a = 2 * Math.PI / 5400e3, b = 2 * Math.PI / 1300e3, phi = 0.7
  const ms = new Float64Array(2), mds = new Float64Array(2), sfs = new Float64Array(2)
  const evalAt = (t, s, k) => {
    ms[0] = Math.sin(a * t); mds[0] = a * Math.cos(a * t); sfs[0] = Math.abs(ms[0]) / a
    ms[1] = Math.cos(b * t + phi); mds[1] = -b * Math.sin(b * t + phi); sfs[1] = Math.abs(ms[1]) / b
    E.allOf(ms, mds, sfs, 2, s, 0)
    return true
  }
  const T1 = 48 * 3600e3
  const r = E.scanWindows(evalAt, 0, T1, { stepMinMs: 300000, stepMaxMs: 1800000 })
  const f = (t) => Math.min(Math.sin(a * t), Math.cos(b * t + phi))
  const br = brute(f, 0, 0, T1, 1000)
  let maxD = 0, miss = 0
  for (const [x, y] of br) { const w = r.windows.find((q) => q.start < y + 1 && q.end > x - 1); if (!w) miss++; else maxD = Math.max(maxD, Math.abs(w.start - x), Math.abs(w.end - y)) }
  ok('⑦ 两约束（余量取最小）：窗口 = 交集，与 1 s 暴力逐窗对上、边界差 ≤ 1 ms', miss === 0 && r.windows.length === br.length && maxD <= 1, `${br.length} 窗 · ${maxD.toFixed(3)} ms · ${r.evals} 次取值`)
}

console.log(`\naccessEngine: ${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
