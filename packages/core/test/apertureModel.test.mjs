// 口径照射解析天线模型（E-01）自测。运行：node packages/core/test/apertureModel.test.mjs
//
// 锁的口径（公式与出处见 src/viz/grd/apertureModel.js 头注）：
//   a. Bessel 核 Λ₁,₂,₃：幂级数 / Hankel 渐近两段与独立积分式 Jₙ(x) = (1/π)∫₀^π cos(nτ − x sinτ)dτ 对拍；
//   b. 闭式远场 F(u) = (2pΛ₁ + qΛ₂)/(2p + q) 与【数值口径辐射积分】（二维直接求和，不经 Bessel）对比：−40 dB 以内误差 ≤ 0.01 dB
//      （任务书门槛），p = 1 / 0.5 / 0.316 / 0.178 / 0.1；均匀口径首旁瓣 −17.57 dB；半功率点与 synth.solveReflector 同一个 u_h；
//   c. 交叉极化核：FT[y·E] 数值积分 = u·G₂(u)（Chu–Turrin 闭式的数学核）；重叠核 Qn = FT[E²]/∫E²（自相关定理）；
//      Ruze 散射总功率 = η_spill·(1 − e^{−δ²})；ITU 包络下界 = S.672-4 rec.1 / S.1528 §1.2（与 pfdmask/s1528.js 逐段对拍）；
//      扫描损失（Maréchal）与有像差口径的直接数值峰值增益对拍；
//   d. 渲染端 ESM ↔ 主进程 CJS 逐位一致、函数体逐字相同；
//   e. 通用解析记录 model:'aperture'：buildApertureRecord → 渲染端物化 / coverage.sampleBeamAt ↔ 主进程 .grdbin（buildBin → loadBin）
//      / grdSampler.sampleBeamAt 同值（1e-9 dB），物化窗口之外照样有值（不截窗）、旁瓣在；峰值 = g0；共极化槽位；交叉极化与 AR；
//      圆极化斜视；色号 fc 进 .grdbin 表头；导出 GRD（toGrdText）两分量往返；
//   f. 旧高斯档逐位不变：多馈源 buildGaussGrd 与赋形 buildShapedGrd（高斯成分波束）的生成文本 = 改动前（HEAD）md5；
//   g. 波束合成组合层：新建多馈源 / 赋形组缺省口径照射；读不到 beamModel 的旧组按高斯（产合成 GRD）；口径照射档产解析记录
//      （p / kD / θ3 与 solveReflector 同源、色号 fc 写进记录）；赋形口径照射档产两分量 GRD（交叉极化在分量 2）。
import * as A from '../../../src/viz/grd/apertureModel.js'
import * as G from '../../../src/viz/grd/gaussStk.js'
import { antennaBasisAzEl, sampleBeamAt as covSample, refinedPeakDb, gridDir, axialRatioDb } from '../../../src/viz/grd/coverage.js'
import { parseGrd } from '../../../src/viz/grd/parse.js'
import { solveReflector, reflApertureOf, scanLossDb, apertureTheta3db, buildGaussGrd, buildShapedGrd, shapedTheta3db, shapedApertureEff } from '../../../src/viz/grd/synth.js'
import { createRequire } from 'module'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ref, nextTick } from 'vue'

const require = createRequire(import.meta.url)
const AC = require('../utils/apertureModel.js')
const S = require('../utils/grdSampler.js')
const S1528 = require('../utils/pfdmask/s1528.js')

let pass = 0, fail = 0
const ok = (m, c, extra = '') => { if (c) { pass++; console.log('PASS  ' + m + (extra ? '  ' + extra : '')) } else { fail++; console.log('FAIL  ' + m + (extra ? '  ' + extra : '')) } }
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol
const D2R = Math.PI / 180
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const md5 = (t) => crypto.createHash('md5').update(t).digest('hex')

// ─────────────── a. Bessel 核 ───────────────
{
  const Jint = (n, x) => { const N = 4000, h = Math.PI / N; let s = 0; for (let i = 0; i <= N; i++) { const t = i * h, w = (i === 0 || i === N) ? 1 : (i % 2 ? 4 : 2); s += w * Math.cos(n * t - x * Math.sin(t)) } return s * h / 3 / Math.PI }
  const L = new Float64Array(3)
  let worst = 0
  for (const x of [0.3, 1, 2.5, 3.8317, 6, 9.7, 12.5, 12.99, 13, 13.01, 17, 25, 48.3, 120, 333.3]) {
    A.lambdas(x, L)
    const want = [2 * Jint(1, x) / x, 8 * Jint(2, x) / (x * x), 48 * Jint(3, x) / (x * x * x)]
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(L[k] - want[k]))
  }
  ok('a. Λ₁,₂,₃（级数 u<13 / 渐近 u≥13）= 积分式 Jₙ，绝对误差 < 1e-9', worst < 1e-9, worst.toExponential(2))
  A.lambdas(0, L)
  ok('a. Λₙ(0) = 1；Λₙ 偶函数', L[0] === 1 && L[1] === 1 && L[2] === 1 && A.apF(-3.3, 0.4) === A.apF(3.3, 0.4))
}

// ─────────────── b. 闭式远场 vs 数值口径辐射积分 ───────────────
function numFT(u, wfun, Nr = 600, Nf = 160) {          // ∫∫ w(ρ) e^{juρcosφ} ρdρdφ / ∫∫ w ρdρdφ（二维直接求和，不经 Bessel）
  let num = 0, den = 0
  const hr = 1 / Nr
  for (let i = 0; i <= Nr; i++) {
    const r = i * hr, sw = (i === 0 || i === Nr) ? 1 : (i % 2 ? 4 : 2), w = wfun(r)
    let s = 0
    for (let k = 0; k < Nf; k++) s += Math.cos(u * r * Math.cos(2 * Math.PI * (k + 0.5) / Nf))
    num += sw * w * r * s / Nf; den += sw * w * r
  }
  return num / den
}
{
  for (const p of [1, 0.5, 0.316, 0.178, 0.1]) {
    const q = 1 - p
    let worst = 0, n = 0
    for (let u = 0; u <= 40; u += 0.1) {
      const fc = A.apF(u, p)
      if (fc * fc < 1e-4) continue                          // −40 dB 以内
      const fn = numFT(u, (r) => p + q * (1 - r * r))
      worst = Math.max(worst, Math.abs(20 * Math.log10(Math.abs(fn) / Math.abs(fc))))
      n++
    }
    ok(`b. p = ${p}：闭式 F(u) vs 数值口径积分，−40 dB 以内最大误差 ≤ 0.01 dB`, worst <= 0.01, `${n} 点 · ${worst.toExponential(2)} dB`)
  }
  // 均匀口径首旁瓣 −17.57 dB（Silver / Balanis）
  let prev = 1, fallen = false, sl = 0
  for (let u = 0.01; u < 10; u += 0.001) { const f = A.apF(u, 1) ** 2; if (f > prev) fallen = true; if (fallen) { if (f > sl) sl = f; else if (sl > 0 && f < prev) break } prev = f }
  ok('b. 均匀口径首旁瓣 −17.57 dB', near(10 * Math.log10(sl), -17.57, 0.01), (10 * Math.log10(sl)).toFixed(3))
  // 半功率点：θ3 与 solveReflector 同源（k = 2u_h/π，同一个 p）
  const r = solveReflector({ apDriver: 'aperture', apertureM: 2.4, fdDriver: 'focal', focalM: 2.4, offsetClr: 0.2, fDesignGHz: 20 })
  const ap = reflApertureOf(r, 0.2)
  const th3 = 2 * Math.asin(A.apUh(ap.p) / ap.kD) / D2R
  ok('b. 口径照射 θ3（u_h / kD）= solveReflector.th3Sim（同一个边缘照射 p）', near(th3, r.th3Sim, 2e-5 * r.th3Sim), `${th3.toFixed(6)}° vs ${r.th3Sim.toFixed(6)}°`)
  ok('b. η_taper 与 solveReflector 效率分解自洽（η_spill ∈ (0,1]）', ap.etaS > 0 && ap.etaS <= 1 && near(ap.etaT * ap.etaS * 100, r.effPct, 1e-9))
}

// ─────────────── c. 交叉极化核 / 重叠核 / Ruze / ITU 包络 / 扫描损失 ───────────────
{
  // FT[y·E] 在 φ = 90°：Im = ∫∫ ρsinφ′·E·sin(uρsinφ′) / ∫∫E = u·G₂(u)
  const numXY = (u, p, Nr = 500, Nf = 160) => {
    const q = 1 - p, hr = 1 / Nr; let num = 0, den = 0
    for (let i = 0; i <= Nr; i++) {
      const r = i * hr, sw = (i === 0 || i === Nr) ? 1 : (i % 2 ? 4 : 2), E = p + q * (1 - r * r)
      let s = 0
      for (let k = 0; k < Nf; k++) { const sf = Math.sin(2 * Math.PI * (k + 0.5) / Nf); s += r * sf * Math.sin(u * r * sf) }
      num += sw * E * r * s / Nf; den += sw * E * r
    }
    return num / den
  }
  let wx = 0
  for (const p of [0.3, 0.8]) for (const u of [0.5, 1.5, 2.5, 4, 7, 11]) wx = Math.max(wx, Math.abs(numXY(u, p) - u * A.apG2(u, p)))
  ok('c. 交叉极化核：FT[y·E] = u·G₂(u)（F′ = −u·G₂）', wx < 1e-7, wx.toExponential(2))
  const dF = (u, p) => (A.apF(u + 1e-5, p) - A.apF(u - 1e-5, p)) / 2e-5
  ok('c. 解析导数 F′(u) = −u·G₂(u)', [0.7, 2.2, 5.1, 9.3, 16].every((u) => near(dF(u, 0.4), -u * A.apG2(u, 0.4), 1e-8)))
  // 重叠核：Qn(u) = FT[E²]/∫E²
  let wq = 0
  for (const p of [0.2, 0.6]) for (const u of [0, 1, 3, 6, 10]) wq = Math.max(wq, Math.abs(numFT(u, (r) => (p + (1 - p) * (1 - r * r)) ** 2) - A.apQn(u, p)))
  ok('c. 重叠核 Qn = FT[E²]/∫E²（赋形 Q 矩阵闭式）', wq < 1e-8, wq.toExponential(2))
  // Ruze 散射：总功率 = η_spill·(1 − e^{−δ²})·4π（数值积分 2π∫G_sc s ds）
  const lam = 0.015, c = 0.25, d2 = (4 * Math.PI * 0.0003 / lam) ** 2, etaS = 0.9
  const rz = { a: etaS * (2 * Math.PI * c / lam) ** 2 * Math.exp(-d2), b: (Math.PI * c / lam) ** 2, d2 }
  let I = 0; const ds = 1e-5
  for (let s = ds / 2; s < 0.5; s += ds) I += A.rzScatter(rz, s) * 2 * Math.PI * s * ds
  ok('c. Ruze 散射总功率 = 4π·η_spill·(1 − e^{−δ²})', near(I / (4 * Math.PI), etaS * (1 - Math.exp(-d2)), 1e-6), `${(I / 4 / Math.PI).toExponential(4)} vs ${(etaS * (1 - Math.exp(-d2))).toExponential(4)}`)
  // ITU 包络下界：主瓣段（ψ ≤ 2.58ψb）不设下界；之外与 S.1528 §1.2（pfdmask/s1528.js，z = 1）逐段同值；LB 背瓣
  let we = 0
  for (const [gm, ln, pb] of [[45, -20, 0.3], [38, -25, 1.1], [52, -25, 0.15]]) {
    for (const psi of [1, 2, 2.6, 3, 4, 6, 6.4, 8, 15, 30, 60, 89]) {
      const v = A.envFloorDbi({ t: 's1528', ln, gm, pb }, psi * pb > 90 ? 89 : psi * pb)
      const ps = psi * pb > 90 ? 89 : psi * pb
      if (ps <= 2.58 * pb) { if (v !== -Infinity) we = Infinity; continue }
      const ref = S1528.gainDbS1528_12(ps, { peakGainDbi: gm, psibDeg: pb, Ln: ln })
      we = Math.max(we, Math.abs(v - ref))
    }
    if (A.envFloorDbi({ t: 's672', ln, gm, pb }, 120) !== Math.max(15 + ln + 0.25 * gm, 0)) we = Infinity
  }
  ok('c. ITU 包络下界 = S.1528 §1.2 / S.672-4 rec.1（z = 1，主瓣段之外逐段同值；背瓣 LB）', we < 1e-9, String(we))
  // 扫描损失（Maréchal）vs 有像差口径的直接数值峰值增益：等效对称抛物面上 Δ = d·h(ρ)·cosφ，找主瓣峰
  const r = solveReflector({ apDriver: 'aperture', apertureM: 2.4, fdDriver: 'focal', focalM: 2.0, offsetClr: 0.2, fDesignGHz: 20 })
  const ap = reflApertureOf(r, 0.2)
  const k = 2 * Math.PI / ap.lam, a = ap.Dm / 2, m = ap.Dm / (4 * ap.Fe), p = ap.p, q = 1 - p
  const numLoss = (thS) => {
    const d = thS * ap.Fe / ap.bdf
    const field = (t) => {                                          // 沿 x 方向的远场（t = 方向正弦）
      let re = 0, im = 0, den = 0
      const Nr = 160, Nf = 128, hr = 1 / Nr
      for (let i = 0; i <= Nr; i++) {
        const rr = i * hr, sw = (i === 0 || i === Nr) ? 1 : (i % 2 ? 4 : 2), E = p + q * (1 - rr * rr), h = 2 * m * rr / (1 + m * m * rr * rr)
        for (let j = 0; j < Nf; j++) {
          const cf = Math.cos(2 * Math.PI * (j + 0.5) / Nf), ph = k * d * h * cf - k * a * rr * cf * t
          re += sw * E * rr * Math.cos(ph); im += sw * E * rr * Math.sin(ph)
        }
        den += sw * E * rr * Nf
      }
      return (re * re + im * im) / (den * den)
    }
    let lo = 0, hi = 2 * d / ap.Fe, best = 0                         // 黄金分割找峰（单峰）
    for (let it = 0; it < 60; it++) { const m1 = lo + (hi - lo) * 0.382, m2 = lo + (hi - lo) * 0.618; if (field(m1) > field(m2)) hi = m2; else lo = m1 }
    best = field((lo + hi) / 2)
    return -10 * Math.log10(best)
  }
  const th3r = ap.th3 * D2R
  const rows = [5, 10, 15].map((nb) => { const a1 = scanLossDb(ap, nb * th3r), a2 = numLoss(nb * th3r); return [nb, a1, a2] })
  ok('c. 扫描损失（Maréchal 闭式）vs 有像差口径数值峰值增益：相对差 < 10%', rows.every(([, x, y]) => y > 0.005 && Math.abs(x - y) / y < 0.1),
    rows.map(([nb, x, y]) => `${nb}θ3 ${x.toFixed(3)}/${y.toFixed(3)} dB`).join(' · '))
  ok('c. 正馈（offsetClr −0.5）：θ₀ = 0 → 无交叉极化、无斜视', (() => { const a0 = reflApertureOf(solveReflector({ apDriver: 'aperture', apertureM: 2, fdDriver: 'focal', focalM: 1, offsetClr: -0.5, fDesignGHz: 12 }), -0.5); return a0 && a0.xp === 0 && a0.sq === 0 })())
  ok('c. Adatia–Rudge 斜视 ψs = asin(λ·sinθ₀/(4πF))（偏置 2.4 m、F 2 m、20 GHz）', near(ap.sq, Math.asin(ap.lam * Math.sin(ap.th0) / (4 * Math.PI * ap.focM)), 1e-15) && ap.sq > 0, `${(ap.sq / D2R * 1000).toFixed(2)} m° · θ₀ ${(ap.th0 / D2R).toFixed(2)}°`)
}

// ─────────────── d. 镜像逐位 ───────────────
{
  const r = rng(11)
  let same = true, n = 0
  const o1 = new Float64Array(4), o2 = new Float64Array(4), L1 = new Float64Array(3), L2 = new Float64Array(3)
  for (let i = 0; i < 300; i++) {
    const b = { az: r() * 16 - 8, el: r() * 16 - 8, th3: 0.2 + r() * 3, g0: 30 + r() * 20, kD: 50 + r() * 900, p: r(), pol: ['linX', 'linY', 'rhcp', 'lhcp'][i % 4], basis: i % 3 ? 'l3' : 'circ', xp: r() * 0.08, sq: r() * 1e-3, sym: i % 2 ? 'ns' : 'ew',
      rz: i % 5 ? null : { a: 1e3 * r(), b: 1e4 * r(), d2: 0.05 * r() }, env: i % 7 ? null : { t: 's672', ln: -25, gm: 45, pb: 0.4 }, back: -30 }
    const e1 = A.apBeamOf(b, 2.5), e2 = AC.apBeamOf(b, 2.5)
    if (JSON.stringify(e1) !== JSON.stringify(e2)) same = false
    for (let j = 0; j < 40; j++) {
      const t = r() * 0.4, f = r() * 6.3, ux = Math.sin(t) * Math.cos(f) + e1.bx, uy = Math.sin(t) * Math.sin(f) + e1.by, uz = Math.cos(t) * e1.bz + (j % 9 === 0 ? -2 : 0)
      const l = Math.hypot(ux, uy, uz)
      A.apEval(e1, ux / l, uy / l, uz / l, o1); AC.apEval(e2, ux / l, uy / l, uz / l, o2)
      for (let k = 0; k < 4; k++) if (!Object.is(o1[k], o2[k])) same = false
      const u = r() * 600; A.lambdas(u, L1); AC.lambdas(u, L2)
      for (let k = 0; k < 3; k++) if (!Object.is(L1[k], L2[k])) same = false
      n++
    }
  }
  ok('d. ESM ↔ CJS 逐位一致（描述子 / 四分量求值 / Λ 核）', same, `${n} 次求值`)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const esm = fs.readFileSync(path.join(here, '../../../src/viz/grd/apertureModel.js'), 'utf8')
  const cjs = fs.readFileSync(path.join(here, '../utils/apertureModel.js'), 'utf8')
  const bodyOf = (t, marker) => t.slice(t.indexOf(marker)).replace(/^export /gm, '').replace(/\nmodule\.exports[\s\S]*$/, '').trim()
  ok('d. 函数体逐字相同（去掉 export / module.exports 后）', bodyOf(esm, 'export const AP_WIN') === bodyOf(cjs, 'const AP_WIN'))
}

// ─────────────── e. 通用解析记录 model:'aperture' ───────────────
const GEO = { lon: 110.5, lat: 0, altKm: 35786 }
function apRecord(pols = ['linX', 'linY'], over = {}) {
  const r = solveReflector({ apDriver: 'aperture', apertureM: 2.4, fdDriver: 'focal', focalM: 2.4, offsetClr: 0.2, fDesignGHz: 19.7 })
  const ap = reflApertureOf(r, 0.2)
  const beams = pols.map((pol, i) => ({ name: String(i + 1), az: -1.2 + 2.0 * i, el: 0.8 - 1.1 * i, model: 's1', th3: ap.th3, g0: r.dirDbi, kD: ap.kD, p: ap.p, pol, xp: ap.xp, sq: ap.sq, sym: 'ew', rz: null, env: null, back: -30, fc: i, ...over }))
  return { rec: G.buildApertureRecord({ sat: { name: 'T', ...GEO }, models: [], beams, owner: null }), r, ap }
}
{
  const { rec, r, ap } = apRecord()
  ok('e. 记录：model aperture、icomp 3（线极化）、全圆极化 → icomp 2', rec.model === 'aperture' && rec.icomp === 3 && G.buildApertureRecord({ beams: [{ az: 0, el: 0, th3: 1, g0: 40, kD: 100, p: 0.3, pol: 'rhcp' }] }).icomp === 2)
  const txt = G.recordToText(rec), back = G.parseRecord(txt)
  ok('e. 存盘文本纯 ASCII、往返不变、色号 fc 在', /^[\x00-\x7f]*$/.test(txt) && JSON.stringify(back) === JSON.stringify(rec) && back.beams[1].fc === 1)
  // 渲染端物化 ↔ 主进程物化：节点逐位相同
  const gR = G.materialize(rec)
  const S2 = require('../utils/gaussStk.js')
  const gM = S2.materializeText(txt)
  let nodesEq = gR.icomp === gM.icomp && gR.sets.length === gM.sets.length
  for (let i = 0; nodesEq && i < gR.sets.length; i++) for (const k of ['c1re', 'c1im', 'c2re', 'c2im']) if (!Buffer.from(gR.sets[i][k].buffer).equals(Buffer.from(gM.sets[i][k].buffer))) nodesEq = false
  ok('e. 物化网格：渲染端 = 主进程（四分量逐位）', nodesEq)
  // 主进程 .grdbin 往返 + 两端取值对拍（含窗外）
  const L = S.loadBin(S.buildBin(txt))
  ok('e. .grdbin：表头带口径照射参数 + fc，loadBin 还原同一描述子', L.beams.length === 2 && L.beams[0].an.kind === 'aperture' && L.beams[0].an.nowin && L.beams[1].fc === 1 &&
    JSON.stringify(L.beams[0].an) === JSON.stringify(G.anBeams(rec)[0]))
  const basisR = antennaBasisAzEl(GEO.lon, GEO.lat, GEO.altKm, 0, 0, 0)
  const cfg = { boreType: 'azel', boreAz: 0, boreEl: 0, yaw: 0, pol: 'RSS' }
  const ctx = S.makeSampleCtx(L, { lon: GEO.lon, lat: GEO.lat, alt: GEO.altKm }, cfg)
  const beamsR = gR.sets.map((set) => ({ ...set, grid: { XS: set.XS, YS: set.YS, XE: set.XE, YE: set.YE, NX: set.NX, NY: set.NY }, an: set.an }))
  let worst = 0, outside = 0, outsideVal = 0
  const r2 = rng(3)
  for (let i = 0; i < 400; i++) {
    const lon = 95 + r2() * 30, lat = -10 + r2() * 45
    for (let bi = 0; bi < 2; bi++) {
      const a = covSample(beamsR[bi], 6, basisR, lon, lat, { pol: 'RSS' })
      const b = S.sampleBeamAt(ctx.beams[bi], 6, ctx.basis, lon, lat, { pol: 'RSS' })
      if (a && b != null) worst = Math.max(worst, Math.abs(a.db - b))
      const an = beamsR[bi].an, g = beamsR[bi].grid
      const P = basisR, e = (() => { const d = [0, 0, 0]; return d })()
      if (a) { const xy = [Math.atan2(-a.u, Math.hypot(a.v, Math.sqrt(1 - a.u * a.u - a.v * a.v))) / D2R, Math.atan2(a.v, Math.sqrt(1 - a.u * a.u - a.v * a.v)) / D2R]; if (xy[0] < g.XS || xy[0] > g.XE || xy[1] < g.YS || xy[1] > g.YE) { outside++; if (a.db > an.g0 - 80 && b != null) outsideVal++ } }
      void P; void e
    }
  }
  ok('e. 渲染端 coverage.sampleBeamAt = 主进程 grdSampler.sampleBeamAt（1e-9 dB）', worst < 1e-9, worst.toExponential(2))
  ok('e. 物化窗口之外照样有值（不截窗，两端都有）', outside > 100 && outsideVal === outside, `${outsideVal}/${outside} 点在窗外`)
  // 峰值、共极化槽位、交叉极化
  ok('e. 峰值 = g0（渲染端 refinedPeakDb RSS / 共极化分量；主进程 peakDb）', near(refinedPeakDb(beamsR[0], 'RSS'), r.dirDbi, 1e-12) && near(refinedPeakDb(beamsR[1], 'P2'), r.dirDbi, 1e-12) && near(S.peakDb(L, { pol: 'RSS' }), r.dirDbi, 1e-12))
  ok('e. 共极化槽位：linX → 1、linY → 2', S.coPolIndexOf(L.beams[0]) === 1 && S.coPolIndexOf(L.beams[1]) === 2)
  const an0 = G.anBeams(rec)[0], o = new Float64Array(4)
  // 视轴：交叉极化 0 → AR 400；在 ê⊥ 方向（对称面 ew → 天线系 y）θ ≈ 0.5θ3 处：Chu–Turrin 交叉极化 −(20..40) dB、与共极化正交
  const at = (dx, dy) => { const u = [an0.bx + dx, an0.by + dy, an0.bz], l = Math.hypot(...u); A.apEval(an0, u[0] / l, u[1] / l, u[2] / l, o); return { re1: o[0], im1: o[1], re2: o[2], im2: o[3] } }
  const c0 = at(0, 0), cP = at(0, 0.5 * ap.th3 * D2R), cS = at(0.5 * ap.th3 * D2R, 0)
  const xp = 20 * Math.log10(Math.hypot(cP.re2, cP.im2) / Math.hypot(cP.re1, cP.im1))
  ok('e. 视轴：交叉极化 0 → AR = 400 dB', c0.re2 === 0 && c0.im2 === 0 && axialRatioDb(c0, 3) === 400)
  ok('e. Chu–Turrin：垂直对称面方向有交叉极化（−20…−40 dB），对称面内为 0', xp < -20 && xp > -40 && Math.abs(cS.im2) < 1e-12 * Math.abs(cS.re1), `${xp.toFixed(2)} dB`)
  ok('e. 交叉极化与共极化相位正交（re2 = 0）→ AR 有限 = |co|/|cx|', cP.re2 === 0 && near(axialRatioDb(cP, 3), -xp, 1e-9), `${axialRatioDb(cP, 3).toFixed(3)} dB`)
  // 旁瓣：第一零点后、远场按 Bessel 闭式（真实离轴角）
  const thN = Math.asin(4.2 / ap.kD), s1 = A.apGainDbi(an0, an0.bx + Math.sin(thN * 1.3), an0.by, Math.sqrt(1 - (an0.bx + Math.sin(thN * 1.3)) ** 2 - an0.by ** 2))
  ok('e. 主瓣外有旁瓣（第一零点外 1.3 倍处 > g0 − 40 dB）', s1 > r.dirDbi - 40 && s1 < r.dirDbi - 15, `${(s1 - r.dirDbi).toFixed(2)} dB`)
  // 圆极化：icomp 2、共极化槽位、斜视方向相反
  const { rec: recC } = apRecord(['rhcp', 'lhcp'], { az: 0, el: 0 })
  const anR = G.anBeams(recC)
  ok('e. 圆极化：右旋 / 左旋视轴沿 ±ê⊥ 斜视（Adatia–Rudge），交叉极化 0（AR 0 dB）', recC.icomp === 2 && anR[0].coSlot === 1 && anR[1].coSlot === 2 &&
    near(anR[0].el, -anR[1].el, 1e-12) && anR[0].el !== 0 && near(Math.abs(anR[0].el) * D2R, ap.sq, 1e-9) &&
    (() => { A.apEval(anR[0], anR[0].bx, anR[0].by + 0.004, anR[0].bz, o); return axialRatioDb({ re1: o[0], im1: o[1], re2: o[2], im2: o[3] }, 2) === 0 })(), `ψs ${(ap.sq / D2R * 1000).toFixed(2)} m°`)
  // Ruze + 包络：视轴总增益 = g0；远旁瓣被托住
  const { rec: recZ } = apRecord(['linX'], { rz: { a: 0.9 * (2 * Math.PI * 0.25 / 0.0152) ** 2 * Math.exp(-0.05), b: (Math.PI * 0.25 / 0.0152) ** 2, d2: 0.05 }, env: { t: 's672', ln: -25, gm: 50, pb: 0.2 } })
  const anZ = G.anBeams(recZ)[0]
  ok('e. Ruze：视轴总增益仍 = g0（相干 + 散射）', near(A.apGainDbi(anZ, anZ.bx, anZ.by, anZ.bz), recZ.beams[0].g0, 1e-9))
  // 偏离视轴恰 deg 的方向：û = cos·b̂ + sin·ê（ê = 描述子里与视轴正交的 ê⊥）
  const far = (an, deg) => { const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R); return A.apGainDbi(an, c * an.bx + s * an.sx, c * an.by + s * an.sy, c * an.bz + s * an.sz) }
  const { rec: recP } = apRecord(['linX'])
  const anP = G.anBeams(recP)[0]
  ok('e. 远旁瓣地板：散射 + 包络把 3° 处托到 ≥ 包络值', far(anZ, 3) >= A.envFloorDbi(anZ.env, 3) - 1e-9 && far(anZ, 3) > far(anP, 3))
  // 导出 GRD（toGrdText）：两分量 + icomp 3 + SYNTHMETA kind aperture、fc；parseGrd 往返
  const gt = G.toGrdText(rec), pg = parseGrd(gt)
  ok('e. 导出 GRASP 文本：icomp 3、两分量、SYNTHMETA kind aperture + fc；回读节点 = 物化值', pg.icomp === 3 && /"kind":"aperture"/.test(gt) && /"fc":\[0,1\]/.test(gt) &&
    Math.abs(pg.sets[1].c1im[100] - gR.sets[1].c1im[100]) <= 1e-9 * Math.max(1, Math.abs(gR.sets[1].c1im[100])) && /^[\x00-\x7f]*$/.test(gt.slice(0, 2000)))
}

// ─────────────── f. 旧高斯档逐位不变（改动前 HEAD 的生成文本 md5）───────────────
{
  const china = [[73.5, 39.5], [80, 45], [87, 49], [97, 42.8], [111, 43], [120, 50], [127, 50], [135, 48], [131, 43], [125, 40], [122, 37], [121, 31], [119, 25], [110, 20], [106, 22], [100, 21.5], [97.5, 24], [98, 28], [92, 28], [85, 28], [79, 30], [73.5, 39.5]]
  const want = { '2.4,12.5,-12': '2e8a603bdd5cc53b4132938e7d8a2961', '1.2,20,-15': 'a328e9ebe6fb526bd4f154bfe9cfe4bc', '3,14.25,-18': '014212ac622439ee203acc8a7331c1cf' }
  for (const [D, f, T] of [[2.4, 12.5, -12], [1.2, 20, -15], [3.0, 14.25, -18]]) {
    const t = buildShapedGrd({ satName: 'T', satLon: 110.5, satLat: 0, altKm: 35786, polysPts: [china], mode: 'physical', value: null, apDm: D, fSimGHz: f, pol: 'linX', effPct: shapedApertureEff(T).effPct, theta3: shapedTheta3db(f, D, T) }).text
    ok(`f. 赋形高斯档（${D} m / ${f} GHz / ${T} dB）生成文本 = 改动前 md5`, md5(t) === want[`${D},${f},${T}`], md5(t))
  }
  const beams = []
  for (let i = 0; i < 30; i++) beams.push({ az: -3 + (i % 6) * 0.7, el: -2 + Math.floor(i / 6) * 0.6, thX: 0.6, thY: 0.6, rot: 0, peakDbi: 45 })
  const t1 = buildGaussGrd({ satName: 'T', satLon: 110.5, satLat: 0, altKm: 35786, effPct: 55, beams })
  ok('f. 多馈源高斯档 buildGaussGrd（无色号）= 改动前 md5', md5(t1) === '3a90c62638e5cf2dcdad41b281a20426', md5(t1))
  const t2 = buildGaussGrd({ satName: 'T', satLon: 110.5, satLat: 0, altKm: 35786, effPct: 55, beams: beams.map((b, i) => ({ ...b, fc: i % 4 })) })
  const meta = JSON.parse(/^SYNTHMETA\s+(\{.*\})\s*$/m.exec(t2)[1])
  ok('f. 有色号时只多 SYNTHMETA.fc，场值逐字相同', meta.fc.length === 30 && meta.fc[5] === 1 && t2.slice(t2.indexOf('++++')) === t1.slice(t1.indexOf('++++')))
  // 高斯解析记录（STK 高斯组）：不带 fc 的记录逐字不变；带 fc 只多该字段
  const m = G.freshModel({ id: 'm1' })
  const r0 = G.buildRecord({ models: [m], beams: [{ name: '1', az: 1, el: 2, model: 'm1' }] })
  const r1 = G.buildRecord({ models: [m], beams: [{ name: '1', az: 1, el: 2, model: 'm1', fc: 3 }] })
  ok('f. 高斯组记录：无色号逐字不变、有色号只多 fc', !('fc' in r0.beams[0]) && r1.beams[0].fc === 3 && JSON.stringify({ ...r1.beams[0], fc: undefined }) === JSON.stringify(r0.beams[0]))
}

// ─────────────── g. 波束合成组合层 ───────────────
{
  let store = {}
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v) }, removeItem: (k) => { delete store[k] } }
  const { useBeamSynth } = await import('../../../src/viz/grd/useBeamSynth.js')
  const settle = async (ms = 0) => { await nextTick(); await nextTick(); if (ms) await new Promise((r) => setTimeout(r, ms)); await nextTick() }
  const clone = (o) => JSON.parse(JSON.stringify(o))
  const makeEnv = (polys = []) => {
    const calls = { create: [], update: [], synth: [] }
    const recs = new Map()
    const sats = ref([{ folder: 'sat1', satName: 'TESTSAT', kind: 'preset', lon: 110.5, lat: 0, altKm: 35786, antennas: [] }])
    const satOf = (f) => sats.value.find((x) => x.folder === f)
    const grd = {
      sats, selected: ref([]), active: ref(''), keyOf: (f, n) => `${f}|${n}`, isSelected: () => false,
      importSynthGrd: async (folder, name, text) => { const s = satOf(folder); s.antennas = s.antennas.filter((a) => a.name !== name); s.antennas.push({ name, imported: true, synth: true }); calls.synth.push({ name, text }); return `${folder}|${name}` },
      ensureAntLoaded: async () => true, analyticRecordOf: (k) => (recs.has(k) ? clone(recs.get(k)) : null),
      createAnalyticAntenna: async (folder, { name, record }) => { const s = satOf(folder); s.antennas.push({ name, imported: true, analytic: true, synth: !!record.owner }); recs.set(`${folder}|${name}`, clone(record)); calls.create.push({ name, record: clone(record) }); return `${folder}|${name}` },
      updateAnalyticAntenna: (key, record) => { calls.update.push({ key, record: clone(record) }); if (!recs.has(key)) return false; recs.set(key, clone(record)); return true },
      removeAntenna: (f, n) => { const s = satOf(f); s.antennas = s.antennas.filter((a) => a.name !== n); recs.delete(`${f}|${n}`) },
      renameAntenna: () => false, onTreeKeys: () => {}
    }
    const bs = useBeamSynth({ grd, getPolys: () => polys, livePos: () => GEO, appAlert: (m) => { throw new Error('alert: ' + m) }, refresh: () => {} })
    return { bs, calls, grd }
  }
  // 新建：多馈源 / 赋形缺省口径照射，高斯组 / 相控阵不带此档
  const e1 = makeEnv()
  e1.bs.addGroup('gauss')
  ok('g. 新建多馈源组缺省口径照射', e1.bs.p.beamModel === 'aperture')
  e1.bs.addGroup('shaped')
  ok('g. 新建赋形组缺省口径照射', e1.bs.p.beamModel === 'aperture')
  // 多馈源口径照射档：放 4 个波束 → 频率配色 → 生成 = 解析记录
  const e2 = makeEnv()
  e2.bs.addGroup('gauss'); e2.bs.p.snapTangent = false
  const s0 = e2.bs.curSetting.value
  Object.assign(s0, { fGHz: 19.7, antD: 2.4, foc: 2.4, offsetClr: 0.2, pol: 'rhcp' })
  await settle()
  for (const [lon, lat] of [[113, 23], [114, 23], [113.5, 23.9], [116, 30]]) e2.bs.placeAt({ lon, lat })
  e2.bs.p.fcN = 4
  e2.bs.assignFreqPlan()
  await e2.bs.generate(); await settle(10)
  const rec = e2.calls.create.length ? e2.calls.create[0].record : null
  const refl = e2.bs.refl.value
  ok('g. 口径照射档生成 → createAnalyticAntenna 一次、记录 model aperture、圆极化 icomp 2', !!rec && e2.calls.synth.length === 0 && rec.model === 'aperture' && rec.icomp === 2)
  ok('g. 记录逐波束 p / θ3 = 本设置 solveReflector，kD = πD/λ', !!rec && rec.beams.every((b) => near(b.p, refl.p, 1e-12) && near(b.th3, refl.th3Sim, 1e-12) && near(b.kD, Math.PI * refl.Dm / (refl.lamSimCm / 100), 1e-9)))
  ok('g. 色号 fc（自动分配）写进记录', !!rec && rec.beams.every((b, i) => b.fc === e2.bs.beams.value[i].fc && Number.isInteger(b.fc)))
  ok('g. 峰值 = 方向性 − 扫描损失（簇心近轴波束损失小、外侧 116°E 波束更大）', !!rec && rec.beams.every((b) => near(b.g0, refl.dirDbi - b.scanDb, 1e-9)) && rec.beams[3].scanDb > rec.beams[0].scanDb && rec.beams[3].scanDb < 0.5,
    rec ? rec.beams.map((b) => b.scanDb.toFixed(4)).join('/') + ' dB' : '')
  ok('g. 生成签名记下（输入未变不报过期）', e2.bs.curGroup.value._genSig && !e2.bs.genStale.value)
  // 旧组（存档里没有 beamModel）→ 按高斯，产合成 GRD；签名与旧版逐字同口径（新键不进签名）
  store = { 'globe3d/beamSynth': JSON.stringify({ v: 2, activeGroupId: 'g1', groups: [{ id: 'g1', satFolder: 'sat1', mode: 'gauss', name: 'Old', p: { fGHz: 14.25, antD: 2.4 }, settings: [], activeSettingId: null, beams: [{ id: 'b1', lon: 112, lat: 25, thX: 0.6, thY: 0.6, rot: 0 }] }] }) }
  const e3 = makeEnv()
  ok('g. 旧组读不到 beamModel → 按高斯', e3.bs.p.beamModel === 'gauss')
  await e3.bs.generate(); await settle(10)
  ok('g. 旧组生成走合成 GRD（不产解析记录）', e3.calls.synth.length === 1 && e3.calls.create.length === 0 && /Gaussian beam model/.test(e3.calls.synth[0].text))
  // 赋形口径照射档：两分量 GRD（线极化交叉极化在分量 2），SYNTHMETA bm:aperture
  const poly = [[100, 25], [112, 24], [118, 30], [110, 38], [100, 34], [100, 25]]
  const e4 = makeEnv([{ id: 'P1', name: 'P', pts: poly }])
  store = {}
  e4.bs.addGroup('shaped')
  Object.assign(e4.bs.p, { antD: 1.6, foc: 1.6, fGHz: 12.5, taper: -12, pol: 'linX', offsetClr: 0.2 })
  e4.bs.togglePoly('P1')
  await e4.bs.generate(); await settle(10)
  const gtx = e4.calls.synth.length ? e4.calls.synth[0].text : ''
  const pg = gtx ? parseGrd(gtx) : null
  let mx1 = 0, mx2 = 0
  if (pg) for (let i = 0; i < pg.sets[0].NX * pg.sets[0].NY; i++) { mx1 = Math.max(mx1, pg.sets[0].P1[i]); mx2 = Math.max(mx2, pg.sets[0].P2[i]) }
  ok('g. 赋形口径照射档：GRD 两分量（交叉极化在分量 2，峰值相对 −20…−45 dB）、SYNTHMETA bm aperture', !!pg && /"bm":"aperture"/.test(gtx) && mx2 > 0 && 10 * Math.log10(mx2 / mx1) < -20 && 10 * Math.log10(mx2 / mx1) > -45, pg ? `${(10 * Math.log10(mx2 / mx1)).toFixed(2)} dB` : '')
  ok('g. 赋形口径照射档成分波束宽 = 抛物面加台阶半功率点（与 shapedTheta3 读数同源）', near(e4.bs.shapedTheta3.value, apertureTheta3db(12.5, 1.6, -12), 1e-12))
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
if (fail) process.exit(1)
