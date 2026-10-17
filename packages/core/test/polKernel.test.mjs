// 极化内核（E-03）自测。运行：node packages/core/test/polKernel.test.mjs
//
// 锁六件事：
//   a. 四种 icomp（1 θφ / 2 RHC·LHC / 3 Ludwig-3 / 4 长短轴）下已知极化椭圆（长轴 a、短轴 b、倾角 ψ、旋向）的闭式向量：
//      AR = 20·lg(a/b)、L3 倾角 = ψ、四基两两互换往返不变；纯线极化 400 dB、纯圆极化 0 dB、标量件（icomp 3、分量 2 ≡ 0）400 dB；
//   b. XPD：圆极化 = 20·lg|E_co/E_cx|（共极化按峰值，可钉死）；线极化 τ 自动 = 峰值倾角 → 峰值处 XPD = AR（SATSOFT §3.4.5 原话），
//      τ 指定 = 相对共极化轴；共极化 / 交叉极化取向（波束内为正）；
//   c. 回归旧 bug：coverage.axialRatioDb 不再把 icomp 3 当圆极化基、icomp 2 走线极化支路（E-03 实测：EIRP_OK1 显示 60 dB、真值 0.098）；
//   d. 真实文件口径（用户库 coverage-grd-imported，有才跑，否则合成场兜底）：EIRP_OK1（icomp 2）峰值 AR ≈ 0.098 dB、
//      300_X02G（icomp 3）峰值 AR ≈ 59.75 dB；共极化全在分量 2；性能表 Xpol 由 −44.98 / −59.75 变正；
//   e. 渲染端 ESM（src/viz/grd/polKernel.js）与主进程 CJS 镜像（packages/core/utils/polKernel.js）逐位一致、函数体逐字相同；
//      主进程 grdSampler.coPolIndexOf = 内核同一判据（与旧实现逐位同判）。
//   f. 性能表 Xpol 包装（usePerfTable.perfXpolDb）：无相位预置天线退回功率比、单分量报 400。
import * as E from '../../../src/viz/grd/polKernel.js'
import { axialRatioDb as covAR } from '../../../src/viz/grd/coverage.js'
import { perfXpolDb } from '../../../src/viz/grd/usePerfTable.js'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const C = require('../utils/polKernel.js')
const S = require('../utils/grdSampler.js')

let pass = 0, fail = 0
const ok = (m, c, extra = '') => { if (c) { pass++; console.log('PASS  ' + m + (extra ? '  ' + extra : '')) } else { fail++; console.log('FAIL  ' + m + (extra ? '  ' + extra : '')) } }
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol
const D2R = Math.PI / 180
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

// 椭圆（长 a、短 b、倾角 psi，sense = +1 右旋 / −1 左旋，IEEE e^{jωt}）在 L3 基的分量：E = a·m̂ − j·s·b·n̂，m̂ = (cosψ, sinψ)，n̂ = (−sinψ, cosψ)
function ellipseL3(a, b, psi, s) {
  const c = Math.cos(psi), sn = Math.sin(psi)
  return { re1: a * c, im1: s * b * sn, re2: a * sn, im2: -s * b * c }
}
const out4 = new Float64Array(4)
const toBasis = (to, l3, phi) => { E.convertBasis(3, to, l3.re1, l3.im1, l3.re2, l3.im2, phi, out4); return { re1: out4[0], im1: out4[1], re2: out4[2], im2: out4[3] } }
const ar = (icomp, c) => E.axialRatioDb(icomp, c.re1, c.im1, c.re2, c.im2)

// ─────────────── a. 四种 icomp 的闭式向量 ───────────────
{
  const cases = [[1, 0.3, 20, 1], [1, 0.05, -35, -1], [1, 0.7, 60, 1], [2, 1, 10, -1], [1, 1e-3, 80, 1], [3, 2, -70, -1]]
  let worst = 0, worstTilt = 0, worstRt = 0
  for (const [a, b, psiDeg, s] of cases) {
    const want = 20 * Math.log10(a / b)
    const l3 = ellipseL3(a, b, psiDeg * D2R, s)
    for (const phi of [0, 0.7, -2.1, Math.PI / 2]) {
      for (const ic of [1, 2, 3, 4]) {
        const c = toBasis(ic, l3, phi)
        worst = Math.max(worst, Math.abs(ar(ic, c) - want))
        // 互换往返：ic → 3 → ic（4 → 3 须给长轴朝向）
        const tilt = ic === 4 ? psiDeg * D2R : null
        const ok3 = E.convertBasis(ic, 3, c.re1, c.im1, c.re2, c.im2, phi, out4, tilt)
        if (ok3) {
          // 4 基的长轴分量相位以长轴为参考（丢了整体相位）→ 比功率与倾角，其余比分量
          const back = { re1: out4[0], im1: out4[1], re2: out4[2], im2: out4[3] }
          const pw = (q) => q.re1 ** 2 + q.im1 ** 2 + q.re2 ** 2 + q.im2 ** 2
          worstRt = Math.max(worstRt, Math.abs(pw(back) - pw(l3)) / pw(l3))
          let dt = Math.abs(E.tiltRad(back.re1, back.im1, back.re2, back.im2) - psiDeg * D2R)
          dt = Math.min(dt, Math.abs(dt - Math.PI))
          worstTilt = Math.max(worstTilt, dt)
        } else worstRt = Infinity
      }
    }
  }
  ok('a. 四种 icomp × 四个方位角：AR = 20·lg(a/b)', worst < 1e-9, `最大偏差 ${worst.toExponential(2)} dB`)
  ok('a. 四基 → Ludwig-3 往返：功率守恒、倾角 = ψ', worstRt < 1e-12 && worstTilt < 1e-9, `功率 ${worstRt.toExponential(2)} · 倾角 ${worstTilt.toExponential(2)} rad`)
  // θφ ↔ L3 是绕视轴转 φ：φ = 0 时两基重合
  const l3 = ellipseL3(1, 0.4, 0.3, 1), t = toBasis(1, l3, 0)
  ok('a. φ = 0 时 θφ 基 = Ludwig-3 基', near(t.re1, l3.re1, 1e-15) && near(t.im2, l3.im2, 1e-15))
  // L3 → 长短轴：长轴分量实正、模 = a；短轴模 = b、与长轴正交（±90°）
  const m4 = toBasis(4, ellipseL3(2, 0.5, 0.9, -1), 0)
  ok('a. L3 → 长短轴：|E_maj| = a、|E_min| = b、相位差 ±90°', near(m4.re1, 2, 1e-12) && near(m4.im1, 0, 1e-15) && near(Math.hypot(m4.re2, m4.im2), 0.5, 1e-12) && near(m4.re2, 0, 1e-12))
  ok('a. 纯线极化（icomp 3：只有 co）→ 400 dB', ar(3, { re1: 1, im1: 0, re2: 0, im2: 0 }) === 400)
  ok('a. 标量件（合成高斯 GRD：icomp 3、分量 2 ≡ 0）→ 400 dB（SATSOFT：标量模型报 400）', E.axialRatioDb(3, 12.3, -4.5, 0, 0) === 400)
  ok('a. 任意倾角的纯线极化（同相两分量）→ 400 dB', E.axialRatioDb(3, 0.6, 0.2, 0.3, 0.1) === 400 && E.axialRatioDb(1, 1, 0, 1, 0) === 400)
  ok('a. 纯圆极化（icomp 2：只有 R）→ 0 dB；L3 下 (1, −j)/√2 → 0 dB', ar(2, { re1: 1, im1: 0, re2: 0, im2: 0 }) === 0 && near(ar(3, { re1: Math.SQRT1_2, im1: 0, re2: 0, im2: -Math.SQRT1_2 }), 0, 1e-12))
  ok('a. 线基下 R/L 幅度：E = x̂ − jŷ 是右旋（|R| = √2，|L| = 0）', (() => { const o = new Float64Array(2); E.circAmps(3, 1, 0, 0, -1, o); return near(o[0], Math.SQRT2, 1e-15) && near(o[1], 0, 1e-15) })())
  ok('a. 非场分量基（icomp 5–9）/ 全零 → null', E.axialRatioDb(6, 1, 0, 1, 0) === null && E.axialRatioDb(9, 1, 0, 1, 0) === null && E.axialRatioDb(3, 0, 0, 0, 0) === null)
}

// ─────────────── b. XPD ───────────────
{
  // 圆极化：右旋共极化、左旋 −30 dB
  const c = { re1: 1, im1: 0, re2: 0.0316227766, im2: 0 }
  ok('b. 圆极化（icomp 2）XPD = 20·lg|R/L| = 30 dB（共极化 = 分量 1）', near(E.xpdAt(2, c, 0, { co: 1, tilt: 0 }, {}), 30, 1e-6))
  ok('b. 共极化在分量 2 → 仍报正 30 dB；钉死 P1 → −30 dB', near(E.xpdAt(2, { re1: c.re2, im1: 0, re2: 1, im2: 0 }, 0, { co: 2, tilt: 0 }, {}), 30, 1e-6) && near(E.xpdAt(2, { re1: c.re2, im1: 0, re2: 1, im2: 0 }, 0, { co: 2, tilt: 0 }, { coPol: 'P1' }), -30, 1e-6))
  // 线极化：倾角 25° 的椭圆（AR 40 dB）。τ 自动 = 峰值倾角 → 峰值处 XPD = AR；τ 指定 0 → 只取 P1/P2
  const a = 1, b = 0.01, psi = 25 * D2R
  const l3 = ellipseL3(a, b, psi, 1)
  const ref = { co: 1, tilt: E.tiltRad(l3.re1, l3.im1, l3.re2, l3.im2) }
  ok('b. 线极化 τ 自动：峰值处 XPD = AR（SATSOFT §3.4.5「AR 与第 1 波束峰值处 Xpol 相等」）', near(E.xpdAt(3, l3, 0, ref, {}), 40, 1e-9), `${E.xpdAt(3, l3, 0, ref, {}).toFixed(6)} dB`)
  const t0 = E.xpdAt(3, l3, 0, ref, { polAuto: false, polTauDeg: 0 })
  ok('b. τ 指定 0°：E1 = P1、E2 = P2（SATSOFT Angle = 0，与交叉极化等值线一致）', near(t0, 20 * Math.log10(Math.hypot(l3.re1, l3.im1) / Math.hypot(l3.re2, l3.im2)), 1e-9), `${t0.toFixed(4)} dB`)
  ok('b. τ 指定 25°（= 倾角）→ = AR', near(E.xpdAt(3, l3, 0, ref, { polAuto: false, polTauDeg: 25 }), 40, 1e-9))
  // 共极化在分量 2 的线极化（倾角 ~90°，300_X02G 同款）：自动 → 正值；SATSOFT 绝对角 τ = 0 会报负值，这里 τ 指定按相对共极化轴
  const l3v = ellipseL3(1, 0.001, 89.3 * D2R, 1)
  const refv = { co: 2, tilt: E.tiltRad(l3v.re1, l3v.im1, l3v.re2, l3v.im2) }
  ok('b. 共极化在分量 2（倾角 89.3°）：τ 自动 → +60 dB', near(E.xpdAt(3, l3v, 0, refv, {}), 60, 1e-9))
  ok('b. … τ 指定 −0.7°（相对共极化轴）→ +60 dB', near(E.xpdAt(3, l3v, 0, refv, { polAuto: false, polTauDeg: -0.7 }), 60, 1e-9))
  ok('b. … 钉死 P1 → 负值（用户断言 P1 为共极化）', E.xpdAt(3, l3v, 0, refv, { coPol: 'P1' }) < -50)
  // θφ 基（icomp 1）：先按 φ 换到 Ludwig-3 再旋转，与直接在 L3 算一致
  const phi = 1.1, th = toBasis(1, l3, phi)
  ok('b. icomp 1（θφ）按 φ 换 L3 后 XPD 与 L3 逐位同口径', near(E.xpdAt(1, th, phi, ref, {}), E.xpdAt(3, l3, 0, ref, {}), 1e-9))
  ok('b. 交叉极化恰为 0 → 400 dB；夹到 ±400', E.xpdAt(3, { re1: 1, im1: 0, re2: 0, im2: 0 }, 0, { co: 1, tilt: 0 }, {}) === 400 && E.ratioDb(0, 1) === -400)
  ok('b. tauForCo：共极化 1 → (−45°, 45°]，共极化 2 → (45°, 135°]', near(E.tauForCo(80 * D2R, 1), -10 * D2R, 1e-12) && near(E.tauForCo(-10 * D2R, 2), 80 * D2R, 1e-12) && near(E.tauForCo(100 * D2R, 2), 100 * D2R, 1e-12))
}

// ─────────────── c. 回归旧 bug（coverage.axialRatioDb）───────────────
{
  // 近圆极化（icomp 2，R 远大于 L）：旧实现走「线极化 Stokes」支路报 60 dB
  const cp = { re1: 1, im1: 0, re2: 0.0057, im2: 0.0011 }
  ok('c. icomp 2 近圆极化：AR ≈ 0.1 dB（旧实现报 60 dB）', covAR(cp, 2) < 0.2, `${covAR(cp, 2).toFixed(4)} dB`)
  // 近线极化（icomp 3）：旧实现当圆极化基算出 ~0.2 dB
  const lp = { re1: 0.0284, im1: 0.0013, re2: 1, im2: 0.0021 }
  ok('c. icomp 3 近线极化：AR 大（旧实现报 ~0.5 dB）', covAR(lp, 3) > 40, `${covAR(lp, 3).toFixed(2)} dB`)
  ok('c. 合成件（icomp 3、分量 2 ≡ 0）：AR = 400（旧实现报 0 dB）', covAR({ re1: 3, im1: 0, re2: 0, im2: 0 }, 3) === 400)
}

// ─────────────── d. 真实文件（用户库）───────────────
{
  const dir = path.join(process.env.APPDATA || '', 'satellite-sim-platform', 'coverage-grd-imported')
  const load = (f) => { try { return S.loadBin(fs.readFileSync(path.join(dir, f))) } catch { return null } }
  const peakComp = (b) => { const k = E.peakIndexOf(b.c1re, b.c1im, b.c2re, b.c2im, b.grid.NX * b.grid.NY); return { re1: b.c1re[k], im1: b.c1im[k], re2: b.c2re[k], im2: b.c2im[k] } }
  const ok1 = load('EIRP_OK1.grd.grdbin'), x02 = load('300_X02G_EIRP.grd.grdbin')
  if (ok1) {
    const b = ok1.beams[0], c = peakComp(b)
    const v = E.axialRatioDb(ok1.icomp, c.re1, c.im1, c.re2, c.im2)
    ok('d. EIRP_OK1（icomp 2，Ka 圆极化）第 1 波束峰值 AR ≈ 0.098 dB', ok1.icomp === 2 && near(v, 0.098, 0.0015), `${v.toFixed(4)} dB`)
    const co = ok1.beams.map((x) => E.coPolIndexOf(x))
    ok('d. EIRP_OK1 共极化全在分量 2（94 波束）', co.length === 94 && co.every((v) => v === 2))
    const xp = E.xpdAt(ok1.icomp, c, 0, { co: 2, tilt: 0 }, {})
    ok('d. EIRP_OK1 峰值处 Xpol 由 −44.98 变 +44.98 dB', near(xp, 44.98, 0.01), `${xp.toFixed(3)} dB`)
  } else ok('d. EIRP_OK1 不在本机库（跳过真实文件，下面的合成场兜底）', true)
  if (x02) {
    const b = x02.beams[0], c = peakComp(b)
    const v = E.axialRatioDb(x02.icomp, c.re1, c.im1, c.re2, c.im2)
    ok('d. 300_X02G（icomp 3，Ku 线极化）第 1 波束峰值 AR ≈ 59.75 dB', x02.icomp === 3 && near(v, 59.75, 0.01), `${v.toFixed(4)} dB`)
    const ref = { co: E.coPolIndexOf(b), tilt: E.peakTiltRad(b, 3, null) }
    const xp = E.xpdAt(3, c, 0, ref, {})
    ok('d. 300_X02G 峰值处 Xpol（τ 自动）= AR（SATSOFT 原话），共极化 = 分量 2', ref.co === 2 && near(xp, v, 1e-6), `${xp.toFixed(4)} dB · τ ${(ref.tilt / D2R).toFixed(3)}°`)
    const old = 10 * Math.log10((c.re1 ** 2 + c.im1 ** 2) / (c.re2 ** 2 + c.im2 ** 2))
    ok('d. … 旧口径 P1 − P2 在同一点是负数', old < -30, `${old.toFixed(2)} dB`)
  } else ok('d. 300_X02G 不在本机库（跳过）', true)
  // 合成场兜底：两分量网格（共极化在分量 2）
  const n = 25, beam = { grid: { NX: 5, NY: 5, XS: -1, YS: -1, XE: 1, YE: 1 }, c1re: new Float32Array(n), c1im: new Float32Array(n), c2re: new Float32Array(n), c2im: new Float32Array(n) }
  for (let i = 0; i < n; i++) { const w = Math.exp(-((i % 5 - 2) ** 2 + (((i / 5) | 0) - 2) ** 2)); beam.c2re[i] = w; beam.c1re[i] = 0.01 * w; beam.c1im[i] = 0.002 * w }
  ok('d. 合成场：峰值处分量 2 占优 → 共极化 = 2（内核与主进程 grdSampler 同判）', E.coPolIndexOf(beam) === 2 && S.coPolIndexOf({ ...beam }) === 2)
}

// ─────────────── e. 镜像逐位 + 主进程同判据 ───────────────
{
  const r = rng(7)
  let same = true, n = 0
  const o1 = new Float64Array(4), o2 = new Float64Array(4)
  for (let i = 0; i < 4000; i++) {
    const v = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1, r() * 2 - 1], phi = r() * 6.3 - 3.15, ic = 1 + (i % 4)
    const tilt = ic === 4 ? r() * 3 - 1.5 : null
    if (E.axialRatioDb(ic, ...v) !== C.axialRatioDb(ic, ...v)) same = false
    if (E.tiltRad(...v) !== C.tiltRad(...v)) same = false
    for (const to of [1, 2, 3, 4]) {
      E.convertBasis(ic, to, ...v, phi, o1, tilt); C.convertBasis(ic, to, ...v, phi, o2, tilt)
      for (let k = 0; k < 4; k++) if (!Object.is(o1[k], o2[k])) same = false
    }
    const comp = { re1: v[0], im1: v[1], re2: v[2], im2: v[3] }, ref = { co: 1 + (i & 1), tilt: r() - 0.5 }
    const opt = i % 3 === 0 ? {} : i % 3 === 1 ? { coPol: 'P2' } : { polAuto: false, polTauDeg: r() * 90 }
    if (!Object.is(E.xpdAt(ic, comp, phi, ref, opt), C.xpdAt(ic, comp, phi, ref, opt))) same = false
    n++
  }
  ok('e. ESM ↔ CJS 逐位一致（AR / 倾角 / 四基互换 / XPD）', same, `${n} 组随机输入`)
  // 函数体逐字相同（镜像由同一份正文生成）
  const here = path.dirname(fileURLToPath(import.meta.url))
  const esm = fs.readFileSync(path.join(here, '../../../src/viz/grd/polKernel.js'), 'utf8')
  const cjs = fs.readFileSync(path.join(here, '../utils/polKernel.js'), 'utf8')
  const bodyOf = (t, marker) => t.slice(t.indexOf(marker)).replace(/^export /gm, '').replace(/\nmodule\.exports[\s\S]*$/, '').trim()
  ok('e. 函数体逐字相同（去掉 export / module.exports 后）', bodyOf(esm, 'export const POL_MAX_DB') === bodyOf(cjs, 'const POL_MAX_DB'))
  // 旧 grdSampler.coPolIndexOf 的判据（峰值 = p1 + p2 最大的节点，p2 > p1 → 2）在内核里逐字保留：随机场上两者同判
  const old = (beam) => {
    const n = beam.grid.NX * beam.grid.NY; let best = -1, bi = 0
    for (let i = 0; i < n; i++) { const p1 = beam.c1re[i] * beam.c1re[i] + beam.c1im[i] * beam.c1im[i]; const p2 = beam.c2re[i] * beam.c2re[i] + beam.c2im[i] * beam.c2im[i]; const t = p1 + p2; if (t > best) { best = t; bi = i } }
    const p1 = beam.c1re[bi] * beam.c1re[bi] + beam.c1im[bi] * beam.c1im[bi], p2 = beam.c2re[bi] * beam.c2re[bi] + beam.c2im[bi] * beam.c2im[bi]
    return p2 > p1 ? 2 : 1
  }
  let agree = true
  for (let t = 0; t < 300; t++) {
    const n = 49, b = { grid: { NX: 7, NY: 7 }, c1re: new Float32Array(n), c1im: new Float32Array(n), c2re: new Float32Array(n), c2im: new Float32Array(n) }
    for (let i = 0; i < n; i++) { b.c1re[i] = r() - 0.5; b.c1im[i] = r() - 0.5; b.c2re[i] = r() - 0.5; b.c2im[i] = r() - 0.5 }
    if (S.coPolIndexOf({ ...b }) !== old(b) || E.coPolIndexOf({ ...b }) !== old(b)) agree = false
  }
  ok('e. 主进程 coPolIndexOf（现走内核）= 旧实现判据（300 个随机场）', agree)
  ok('e. 解析波束：高斯档 → 1；口径照射 linY / lhcp → 2', S.coPolIndexOf({ an: { kind: 'aperture', coSlot: 2 } }) === 2 && S.coPolIndexOf({ an: { k: 'stk' } }) === 1)
}

// ─────────────── f. 性能表 Xpol 包装 ───────────────
{
  const beam = { grid: { NX: 2, NY: 2, XS: 0, YS: 0, XE: 1, YE: 1 }, P1: new Float32Array([1, 2, 3, 4]), P2: new Float32Array([0, 0, 0, 0]) }
  ok('f. 无相位预置天线：只有 P1 → 400', perfXpolDb(beam, 6, 3, null, [30, null], {}) === 400)
  const beam2 = { grid: { NX: 2, NY: 2, XS: 0, YS: 0, XE: 1, YE: 1 }, P1: new Float32Array([1, 1, 1, 1]), P2: new Float32Array([5, 5, 50, 5]) }
  ok('f. 无相位预置天线：共极化按峰值（P2）→ P2 − P1', near(perfXpolDb(beam2, 6, 3, null, [10, 37], {}), 27, 1e-12))
  ok('f. … 钉死 P1 → P1 − P2', near(perfXpolDb(beam2, 6, 3, null, [10, 37], { coPol: 'P1' }), -27, 1e-12))
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
if (fail) process.exit(1)
