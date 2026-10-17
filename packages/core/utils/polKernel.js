// 极化内核（E-03）—— 主进程 CommonJS 镜像。渲染端原件：src/viz/grd/polKernel.js（Vite 不转本地 CJS，故两份；
// 函数体逐字相同，packages/core/test/polKernel.test.mjs 逐位对拍）。口径说明全在原件头注，这里不重复；改动必须两处同改。
'use strict'

const POL_MAX_DB = 400
const D2R = Math.PI / 180

// 四种场分量极化基才有极化信息
function isPolBasis(icomp) { return icomp === 1 || icomp === 2 || icomp === 3 || icomp === 4 }

// 圆极化幅度 [|E_R|, |E_L|] → out（长度 ≥2）。不是场分量基返回 false。
function circAmps(icomp, re1, im1, re2, im2, out) {
  if (icomp === 2) { out[0] = Math.hypot(re1, im1); out[1] = Math.hypot(re2, im2); return true }
  if (!isPolBasis(icomp)) return false
  // 线基（1/3/4）：E_R = (E1 + jE2)/√2，E_L = (E1 − jE2)/√2；jE2 = −im2 + j·re2
  out[0] = Math.hypot(re1 - im2, im1 + re2) * Math.SQRT1_2
  out[1] = Math.hypot(re1 + im2, im1 - re2) * Math.SQRT1_2
  return true
}

// 轴比（dB，[0, 400]）。两分量全 0 / 非场分量基 → null。
const _ca = new Float64Array(2)
function axialRatioDb(icomp, re1, im1, re2, im2) {
  if (!circAmps(icomp, re1, im1, re2, im2, _ca)) return null
  const a = _ca[0], b = _ca[1], s = a + b
  if (!(s > 0)) return null
  const d = Math.abs(a - b)
  if (!(d > s * 1e-20)) return POL_MAX_DB
  return Math.min(POL_MAX_DB, 20 * Math.log10(s / d))
}

// 线基下极化椭圆的倾角（rad，(−π/2, π/2]，自 ê1 轴量起，转向 ê2 为正）：tan2ψ = S2/S1，
// S1 = |E1|² − |E2|²，S2 = 2·Re(E1·E2*)。
function tiltRad(re1, im1, re2, im2) {
  const s1 = re1 * re1 + im1 * im1 - re2 * re2 - im2 * im2
  const s2 = 2 * (re1 * re2 + im1 * im2)
  return 0.5 * Math.atan2(s2, s1)
}

// 极化基互换：(re1,im1,re2,im2)@from → out4 @to。phi = 该方向在天线系里的方位角（rad，atan2(v,u)），
// θφ ↔ Ludwig-3 / 圆极化 ↔ 线基 需要它。icomp 4 → 1/3 须给椭圆长轴在 Ludwig-3 基里的朝向 tilt（rad），
// 文件不带朝向，缺省（null/undefined）即不支持（返回 false）。to = 4 时输出长轴 / 短轴分量（相位以长轴为参考）。
const _cv = new Float64Array(4)
function convertBasis(from, to, re1, im1, re2, im2, phi, out, tilt) {
  if (!isPolBasis(from) || !isPolBasis(to)) return false
  if (from === to) { out[0] = re1; out[1] = im1; out[2] = re2; out[3] = im2; return true }
  // 先统一到 Ludwig-3（co, cx）
  let a = re1, b = im1, c = re2, d = im2
  const cp = Math.cos(phi || 0), sp = Math.sin(phi || 0)
  if (from === 1) {                                // θφ → L3：转 φ
    a = re1 * cp - re2 * sp; b = im1 * cp - im2 * sp
    c = re1 * sp + re2 * cp; d = im1 * sp + im2 * cp
  } else if (from === 2) {                         // R/L → θφ → L3：Eθ = (R+L)/√2，Eφ = −j(R−L)/√2
    const tr = (re1 + re2) * Math.SQRT1_2, ti = (im1 + im2) * Math.SQRT1_2
    const pr = (im1 - im2) * Math.SQRT1_2, pi = -(re1 - re2) * Math.SQRT1_2
    a = tr * cp - pr * sp; b = ti * cp - pi * sp
    c = tr * sp + pr * cp; d = ti * sp + pi * cp
  } else if (from === 4) {                         // 长短轴 → L3：需要长轴朝向
    if (tilt == null || !Number.isFinite(tilt)) return false
    const ct = Math.cos(tilt), st = Math.sin(tilt)
    a = re1 * ct - re2 * st; b = im1 * ct - im2 * st
    c = re1 * st + re2 * ct; d = im1 * st + im2 * ct
  }
  if (to === 3) { out[0] = a; out[1] = b; out[2] = c; out[3] = d; return true }
  if (to === 1) {                                  // L3 → θφ：反转 φ
    out[0] = a * cp + c * sp; out[1] = b * cp + d * sp
    out[2] = -a * sp + c * cp; out[3] = -b * sp + d * cp
    return true
  }
  if (to === 2) {                                  // L3 → θφ → R/L
    const tr = a * cp + c * sp, ti = b * cp + d * sp
    const pr = -a * sp + c * cp, pi = -b * sp + d * cp
    out[0] = (tr - pi) * Math.SQRT1_2; out[1] = (ti + pr) * Math.SQRT1_2
    out[2] = (tr + pi) * Math.SQRT1_2; out[3] = (ti - pr) * Math.SQRT1_2
    return true
  }
  // to === 4：L3 → 长短轴。长轴朝向 ψ（倾角），旋到椭圆主轴；再统一相位：长轴分量取实正（E_min 与之正交 ±90°）
  const psi = tiltRad(a, b, c, d), cs = Math.cos(psi), ss = Math.sin(psi)
  const mr = a * cs + c * ss, mi = b * cs + d * ss          // 长轴分量
  const nr = -a * ss + c * cs, ni = -b * ss + d * cs        // 短轴分量
  const am = Math.hypot(mr, mi)
  if (am > 0) {
    const ur = mr / am, ui = -mi / am                       // 乘 e^{−j·arg(E_maj)}
    out[0] = am; out[1] = 0
    out[2] = nr * ur - ni * ui; out[3] = nr * ui + ni * ur
  } else { out[0] = 0; out[1] = 0; out[2] = nr; out[3] = ni }
  return true
}

// dB 比值夹到 ±400：分母恰为 0 → +400，分子恰为 0 → −400
function ratioDb(num, den) {
  if (!(den > 0)) return num > 0 ? POL_MAX_DB : null
  if (!(num > 0)) return -POL_MAX_DB
  return Math.max(-POL_MAX_DB, Math.min(POL_MAX_DB, 20 * Math.log10(num / den)))
}

// 线极化 Xpol（SATSOFT eq 3.1/3.2）：L3 分量按绝对角 τs（rad，自 P1 轴量起）旋转后 20·lg|E1/E2|
function xpdLinearDb(re1, im1, re2, im2, tauS) {
  const c = Math.cos(tauS), s = Math.sin(tauS)
  const e1r = re1 * c + re2 * s, e1i = im1 * c + im2 * s
  const e2r = re2 * c - re1 * s, e2i = im2 * c - im1 * s
  return ratioDb(Math.hypot(e1r, e1i), Math.hypot(e2r, e2i))
}

// ── 波束峰值处的极化参照（共极化分量 + 线极化倾角）──
// 峰值节点 = 两分量功率和最大者（与 grdSampler.coPolIndexOf 同一扫描、同一并列取先口径）
function peakIndexOf(c1re, c1im, c2re, c2im, n) {
  let best = -1, bi = 0
  for (let i = 0; i < n; i++) {
    const p1 = c1re[i] * c1re[i] + c1im[i] * c1im[i]
    const p2 = c2re[i] * c2re[i] + c2im[i] * c2im[i]
    const t = p1 + p2
    if (t > best) { best = t; bi = i }
  }
  return bi
}
// 共极化分量号（1|2）：峰值处 p2 > p1 → 2，否则 1（与 grdSampler 旧实现逐字同判据）
function coPolIndexOf(beam) {
  if (beam._coPol === 1 || beam._coPol === 2) return beam._coPol
  // 解析天线：共极化槽位由记录的设计极化定（高斯档只有分量 1；口径照射档 linY / lhcp 落在分量 2），不扫网格
  if (beam.an) return beam.an.coSlot === 2 ? 2 : 1
  let co
  if (beam.c1re) {
    const n = beam.grid.NX * beam.grid.NY
    const bi = peakIndexOf(beam.c1re, beam.c1im, beam.c2re, beam.c2im, n)
    const p1 = beam.c1re[bi] * beam.c1re[bi] + beam.c1im[bi] * beam.c1im[bi]
    const p2 = beam.c2re[bi] * beam.c2re[bi] + beam.c2im[bi] * beam.c2im[bi]
    co = p2 > p1 ? 2 : 1
  } else if (beam.P1 && beam.P2) {                 // 预置烘焙天线（只有功率）：同一判据落在功率上
    const n = beam.grid.NX * beam.grid.NY
    let best = -1, bi = 0
    for (let i = 0; i < n; i++) { const t = beam.P1[i] + beam.P2[i]; if (t > best) { best = t; bi = i } }
    co = beam.P2[bi] > beam.P1[bi] ? 2 : 1
  } else co = 1
  try { Object.defineProperty(beam, '_coPol', { value: co, writable: true, enumerable: false }) }
  catch (e) { /* 冻结对象：不缓存也能用，只是每次重算 */ }
  return co
}

// 峰值处的线极化倾角（rad，Ludwig-3 基，(−π/2, π/2]）。icomp 1 要该节点的方位角：dirAt(idx) → 天线系单位矢量 [u,v,w]。
// 只对线基（1/3）有意义；圆极化 / 长短轴 / 无相位的预置天线返回 0。按 beam 记忆化（与指向无关）。
const _pk = new Float64Array(4)
function peakTiltRad(beam, icomp, dirAt) {
  if (Number.isFinite(beam._polTilt)) return beam._polTilt
  let t = 0
  if (beam.an) t = beam.an.coSlot === 2 && icomp === 3 ? Math.PI / 2 : 0
  else if ((icomp === 1 || icomp === 3) && beam.c1re) {
    const n = beam.grid.NX * beam.grid.NY
    const bi = peakIndexOf(beam.c1re, beam.c1im, beam.c2re, beam.c2im, n)
    let phi = 0
    if (icomp === 1 && typeof dirAt === 'function') { const d = dirAt(bi); if (d) phi = Math.atan2(d[1], d[0]) }
    if (convertBasis(icomp, 3, beam.c1re[bi], beam.c1im[bi], beam.c2re[bi], beam.c2im[bi], phi, _pk)) t = tiltRad(_pk[0], _pk[1], _pk[2], _pk[3])
  }
  try { Object.defineProperty(beam, '_polTilt', { value: t, writable: true, enumerable: false }) }
  catch (e) { /* 冻结对象：不缓存 */ }
  return t
}

// 线基倾角按共极化轴归位：co = 1 → 落到 (−45°, 45°]；co = 2 → 落到 (45°, 135°]（E1 恒为共极化方向）
function tauForCo(tilt, co) {
  let t = tilt
  if (co === 2) { while (t <= Math.PI / 4) t += Math.PI / 2; while (t > 3 * Math.PI / 4) t -= Math.PI / 2 }
  else { while (t <= -Math.PI / 4) t += Math.PI / 2; while (t > Math.PI / 4) t -= Math.PI / 2 }
  return t
}

// 单点 XPD（dB）。comp = {re1,im1,re2,im2}（文件 icomp 基下该点复场）；phi = 该点天线系方位角（rad，仅 icomp 1 用）；
// ref = { co, tilt }（波束峰值处：共极化分量号 + L3 倾角，见 coPolIndexOf / peakTiltRad）；
// o = { coPol: 'auto'|'P1'|'P2', polAuto: true|false, polTauDeg }（性能表选项）。
// 无相位（comp 为 null）的调用方自行按功率比算（τ 只能取 0）。
function xpdAt(icomp, comp, phi, ref, o) {
  if (!comp || !isPolBasis(icomp)) return null
  const oo = o || {}
  const co = oo.coPol === 'P1' ? 1 : oo.coPol === 'P2' ? 2 : (ref && ref.co === 2 ? 2 : 1)
  const { re1, im1, re2, im2 } = comp
  if (icomp === 2 || icomp === 4) {
    const a1 = Math.hypot(re1, im1), a2 = Math.hypot(re2, im2)
    return co === 2 ? ratioDb(a2, a1) : ratioDb(a1, a2)
  }
  if (!convertBasis(icomp, 3, re1, im1, re2, im2, phi, _cv)) return null
  let tauS
  if (oo.polAuto === false) tauS = (Number(oo.polTauDeg) || 0) * D2R + (co === 2 ? Math.PI / 2 : 0)
  else tauS = tauForCo(ref && Number.isFinite(ref.tilt) ? ref.tilt : 0, co)
  return xpdLinearDb(_cv[0], _cv[1], _cv[2], _cv[3], tauS)
}

module.exports = { POL_MAX_DB, isPolBasis, circAmps, axialRatioDb, tiltRad, convertBasis, ratioDb, xpdLinearDb, peakIndexOf, coPolIndexOf, peakTiltRad, tauForCo, xpdAt }
