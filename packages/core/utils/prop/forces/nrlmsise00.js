// NRLMSISE-00 经验大气模型（0–1000 km 中性大气温度与密度）的 JavaScript 移植（纯 CommonJS）。
//
// 【来源】Dominik Brodowski 的 C 版（git 仓库 https://git.linta.de/~brodo/nrlmsise-00.git，最新提交 bc9a2fe，
//   2019-07-09「gtd7: fix output at 32.5 km」），nrlmsise-00.c 的 SHA-256
//   a20d6523420188241963f095ad0b65df44ac0a6fa6db52d2e1df823c366f0285。C 版据 NRL 官方 Fortran
//   （Official Beta Release 2.0，NRLMSISE-00.DIST17.TXT）转写。本文件逐函数对照 C 版移植，函数名、变量名、
//   下标、调用次序与 C 版一致；C 版的全局量（gsurf、re、plg、apdf、apt、meso_* 等）收进每次调用私有的 ctx，
//   结果与 C 版相同但可重入。系数表在 ../data/nrlmsise00Data.js。
//   模型作者：Picone, J.M., Hedin, A.E., Drob, D.P., Aikin, A.C. (2002), NRLMSISE-00 empirical model of the
//   atmosphere: Statistical comparisons and scientific issues, J. Geophys. Res., 107(A12), 1468。
//
// 【许可核实（2026-10-17）】
//   1) NRL 原始 Fortran 发行包的声明（原文）：
//      "The source code is in the public domain and not licensed or under copyright. The information and software
//       may be used freely by the public. As required by 17 U.S.C. 403, third parties producing copyrighted works
//       consisting predominantly of the material produced by U.S. government agencies must provide notice with
//       such work(s) identifying the U.S. Government material incorporated and stating that such material is not
//       subject to copyright protection. Derived works shall not identify themselves in a manner that implies an
//       endorsement by or an affiliation with the Naval Research Laboratory. RECIPIENT BEARS ALL RISK RELATING TO
//       QUALITY AND PERFORMANCE OF THE SOFTWARE AND ANY RELATED MATERIALS, AND AGREES TO INDEMNIFY THE NAVAL
//       RESEARCH LABORATORY FOR ALL THIRD-PARTY CLAIMS RESULTING FROM THE ACTIONS OF RECIPIENT IN THE USE OF THE
//       SOFTWARE."
//   2) C 版作者 Dominik Brodowski 的声明（原文）："I am placing my NRLMSISE-00 C code into the public domain
//      contingent on the original Fortran code not being subject to US copyright." —— 前提成立（见 1）。
//      C 仓库本身没有 LICENSE 文件，DOCUMENTATION 第 1 节只有免责声明（"WITHOUT ANY WARRANTY"）。
//      上述两段原文转引自 pynrlmsise00 仓库的 COPYING.NRLMSISE-00（该 Python 包本身是 GPL-2.0，本文件只引其
//      声明文字作为许可证据，没有使用其任何代码）。Python 包 nrlmsise00 为 GPL，未使用。
//   3) 17 U.S.C. §403 声明：本文件（及 ../data/nrlmsise00Data.js）包含美国政府作品 —— 美国海军研究实验室（NRL）
//      的 NRLMSISE-00 模型算法与系数，该部分不受版权保护。本移植与 NRL 无隶属或背书关系。
//   4) 无担保：按原样提供，使用风险自负。
//
// 【接口】
//   gtd7(input, switches) / gtd7d(input, switches) → { d: [9], t: [2] }（C 版同义：d 为数密度 cm⁻³、d[5] 为总质量
//     密度 g/cm³；switches[0] = 1 时为 m⁻³ 与 kg/m³）。gtd7d 的 d[5] 含异常氧（「拖曳用有效总质量密度」）。
//   input = { doy, sec, alt(km), g_lat(°，大地纬度), g_long(°), lst(h), f107A, f107, ap, ap_a: [7] }
//     （ap_a 仅在 switches[9] = −1 时使用：日 Ap、当前 3 h ap、−3 h、−6 h、−9 h、−12…−33 h 均值、−36…−57 h 均值）
//   switches 缺省：[0] = 0，其余全 1（C 版 / NRL 的标准设置）。
//   density(input, switches) → kg/m³（gtd7d 的 d[5]，单位已换算）

'use strict'

const D = require('../data/nrlmsise00Data.js')
const { pt, pd, ps, pdl, ptm, pdm, ptl, pma, pavgm } = D

const DEFAULT_SWITCHES = [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]

/* ------------------------------ TSELEC ----------------------------- */
function tselec(switches) {
  const s = switches || DEFAULT_SWITCHES
  const sw = new Float64Array(24), swc = new Float64Array(24)
  for (let i = 0; i < 24; i++) {
    const v = s[i] == null ? DEFAULT_SWITCHES[i] : s[i]
    if (i !== 9) {
      sw[i] = v === 1 ? 1 : 0
      swc[i] = v > 0 ? 1 : 0
    } else {
      sw[i] = v
      swc[i] = v
    }
  }
  return { sw, swc }
}

function newCtx(flags) {
  return {
    sw: flags.sw, swc: flags.swc,
    gsurf: 0, re: 0,                       // PARMB
    dd: 0,                                 // GTS3C
    dm04: 0, dm16: 0, dm28: 0, dm32: 0, dm40: 0, dm01: 0, dm14: 0,   // DMIX
    meso_tn1: new Float64Array(5), meso_tn2: new Float64Array(4), meso_tn3: new Float64Array(5),
    meso_tgn1: new Float64Array(2), meso_tgn2: new Float64Array(2), meso_tgn3: new Float64Array(2),
    dfa: 0,                                // LPOLY
    plg: [new Float64Array(9), new Float64Array(9), new Float64Array(9), new Float64Array(9)],
    ctloc: 0, stloc: 0, c2tloc: 0, s2tloc: 0, s3tloc: 0, c3tloc: 0,
    apdf: 0, apt: new Float64Array(4)
  }
}

/* ------------------------------ GLATF ------------------------------ */
function glatf(ctx, lat) {
  const dgtr = 1.74533E-2
  const c2 = Math.cos(2.0 * dgtr * lat)
  ctx.gsurf = 980.616 * (1.0 - 0.0026373 * c2)
  ctx.re = 2.0 * ctx.gsurf / (3.085462E-6 + 2.27E-9 * c2) * 1.0E-5
}

/* ------------------------------ CCOR ------------------------------- */
// 化学 / 离解修正
function ccor(alt, r, h1, zh) {
  let e = (alt - zh) / h1
  if (e > 70) return Math.exp(0)
  if (e < -70) return Math.exp(r)
  const ex = Math.exp(e)
  e = r / (1.0 + ex)
  return Math.exp(e)
}
function ccor2(alt, r, h1, zh, h2) {
  const e1 = (alt - zh) / h1
  const e2 = (alt - zh) / h2
  if ((e1 > 70) || (e2 > 70)) return Math.exp(0)
  if ((e1 < -70) && (e2 < -70)) return Math.exp(r)
  const ex1 = Math.exp(e1), ex2 = Math.exp(e2)
  const ccor2v = r / (1.0 + 0.5 * (ex1 + ex2))
  return Math.exp(ccor2v)
}

/* ------------------------------- SCALH ----------------------------- */
function scalh(ctx, alt, xm, temp) {
  const rgas = 831.4
  let g = ctx.gsurf / Math.pow((1.0 + alt / ctx.re), 2.0)
  g = rgas * temp / (g * xm)
  return g
}

/* -------------------------------- DNET ----------------------------- */
// 湍流层顶修正：扩散密度 dd 与完全混合密度 dm 的合成
function dnet(dd, dm, zhm, xmm, xm) {
  let a = zhm / (xmm - xm)
  if (!((dm > 0) && (dd > 0))) {
    if ((dd === 0) && (dm === 0)) dd = 1
    if (dm === 0) return dd
    if (dd === 0) return dm
  }
  const ylog = a * Math.log(dm / dd)
  if (ylog < -10) return dd
  if (ylog > 10) return dm
  a = dd * Math.pow((1.0 + Math.exp(ylog)), (1.0 / a))
  return a
}

/* ------------------------------- SPLINI ---------------------------- */
// 三次样条从 xa[0] 积分到 x
function splini(xa, ya, y2a, n, x) {
  let yi = 0
  let klo = 0, khi = 1
  while ((x > xa[klo]) && (khi < n)) {
    let xx = x
    if (khi < (n - 1)) {
      if (x < xa[khi]) xx = x
      else xx = xa[khi]
    }
    const h = xa[khi] - xa[klo]
    const a = (xa[khi] - xx) / h
    const b = (xx - xa[klo]) / h
    const a2 = a * a, b2 = b * b
    yi += ((1.0 - a2) * ya[klo] / 2.0 + b2 * ya[khi] / 2.0 + ((-(1.0 + a2 * a2) / 4.0 + a2 / 2.0) * y2a[klo] + (b2 * b2 / 4.0 - b2 / 2.0) * y2a[khi]) * h * h / 6.0) * h
    klo++
    khi++
  }
  return yi
}

/* ------------------------------- SPLINT ---------------------------- */
// 三次样条插值（Numerical Recipes）
function splint(xa, ya, y2a, n, x) {
  let klo = 0, khi = n - 1
  while ((khi - klo) > 1) {
    const k = Math.floor((khi + klo) / 2)
    if (xa[k] > x) khi = k
    else klo = k
  }
  const h = xa[khi] - xa[klo]
  const a = (xa[khi] - x) / h
  const b = (x - xa[klo]) / h
  return a * ya[klo] + b * ya[khi] + ((a * a * a - a) * y2a[klo] + (b * b * b - b) * y2a[khi]) * h * h / 6.0
}

/* ------------------------------- SPLINE ---------------------------- */
// 三次样条二阶导（Numerical Recipes）；yp1 / ypn ≥ 1e30 表示自然边界
function spline(x, y, n, yp1, ypn, y2) {
  const u = new Float64Array(n)
  if (yp1 > 0.99E30) {
    y2[0] = 0; u[0] = 0
  } else {
    y2[0] = -0.5
    u[0] = (3.0 / (x[1] - x[0])) * ((y[1] - y[0]) / (x[1] - x[0]) - yp1)
  }
  for (let i = 1; i < (n - 1); i++) {
    const sig = (x[i] - x[i - 1]) / (x[i + 1] - x[i - 1])
    const p = sig * y2[i - 1] + 2.0
    y2[i] = (sig - 1.0) / p
    u[i] = (6.0 * ((y[i + 1] - y[i]) / (x[i + 1] - x[i]) - (y[i] - y[i - 1]) / (x[i] - x[i - 1])) / (x[i + 1] - x[i - 1]) - sig * u[i - 1]) / p
  }
  let qn, un
  if (ypn > 0.99E30) {
    qn = 0; un = 0
  } else {
    qn = 0.5
    un = (3.0 / (x[n - 1] - x[n - 2])) * (ypn - (y[n - 1] - y[n - 2]) / (x[n - 1] - x[n - 2]))
  }
  y2[n - 1] = (un - qn * u[n - 2]) / (qn * y2[n - 2] + 1.0)
  for (let k = n - 2; k >= 0; k--) y2[k] = y2[k] * y2[k + 1] + u[k]
}

/* ------------------------------- DENSM ----------------------------- */
function zeta(ctx, zz, zl) {
  return ((zz - zl) * (ctx.re + zl) / (ctx.re + zz))
}

// 低层大气（< 72.5 km）温度与密度廓线。tz 为输出持有者 { v }
function densm(ctx, alt, d0, xm, tz, mn3, zn3, tn3, tgn3, mn2, zn2, tn2, tgn2) {
  const xs = new Float64Array(10), ys = new Float64Array(10), y2out = new Float64Array(10)
  const rgas = 831.4
  let z, z1, z2, t1, t2, zg, zgdif
  let yd1, yd2, x, y, yi, expl, gamm, glb
  let mn
  let densmTmp = d0
  if (alt > zn2[0]) {
    if (xm === 0.0) return tz.v
    else return d0
  }

  /* STRATOSPHERE/MESOSPHERE TEMPERATURE */
  if (alt > zn2[mn2 - 1]) z = alt
  else z = zn2[mn2 - 1]
  mn = mn2
  z1 = zn2[0]
  z2 = zn2[mn - 1]
  t1 = tn2[0]
  t2 = tn2[mn - 1]
  zg = zeta(ctx, z, z1)
  zgdif = zeta(ctx, z2, z1)

  /* set up spline nodes */
  for (let k = 0; k < mn; k++) {
    xs[k] = zeta(ctx, zn2[k], z1) / zgdif
    ys[k] = 1.0 / tn2[k]
  }
  yd1 = -tgn2[0] / (t1 * t1) * zgdif
  yd2 = -tgn2[1] / (t2 * t2) * zgdif * (Math.pow(((ctx.re + z2) / (ctx.re + z1)), 2.0))

  /* calculate spline coefficients */
  spline(xs, ys, mn, yd1, yd2, y2out)
  x = zg / zgdif
  y = splint(xs, ys, y2out, mn, x)

  /* temperature at altitude */
  tz.v = 1.0 / y
  if (xm !== 0.0) {
    /* calaculate stratosphere / mesospehere density */
    glb = ctx.gsurf / (Math.pow((1.0 + z1 / ctx.re), 2.0))
    gamm = xm * glb * zgdif / rgas

    /* Integrate temperature profile */
    yi = splini(xs, ys, y2out, mn, x)
    expl = gamm * yi
    if (expl > 50.0) expl = 50.0

    /* Density at altitude */
    densmTmp = densmTmp * (t1 / tz.v) * Math.exp(-expl)
  }

  if (alt > zn3[0]) {
    if (xm === 0.0) return tz.v
    else return densmTmp
  }

  /* troposhere / stratosphere temperature */
  z = alt
  mn = mn3
  z1 = zn3[0]
  z2 = zn3[mn - 1]
  t1 = tn3[0]
  t2 = tn3[mn - 1]
  zg = zeta(ctx, z, z1)
  zgdif = zeta(ctx, z2, z1)

  /* set up spline nodes */
  for (let k = 0; k < mn; k++) {
    xs[k] = zeta(ctx, zn3[k], z1) / zgdif
    ys[k] = 1.0 / tn3[k]
  }
  yd1 = -tgn3[0] / (t1 * t1) * zgdif
  yd2 = -tgn3[1] / (t2 * t2) * zgdif * (Math.pow(((ctx.re + z2) / (ctx.re + z1)), 2.0))

  /* calculate spline coefficients */
  spline(xs, ys, mn, yd1, yd2, y2out)
  x = zg / zgdif
  y = splint(xs, ys, y2out, mn, x)

  /* temperature at altitude */
  tz.v = 1.0 / y
  if (xm !== 0.0) {
    /* calaculate tropospheric / stratosphere density */
    glb = ctx.gsurf / (Math.pow((1.0 + z1 / ctx.re), 2.0))
    gamm = xm * glb * zgdif / rgas

    /* Integrate temperature profile */
    yi = splini(xs, ys, y2out, mn, x)
    expl = gamm * yi
    if (expl > 50.0) expl = 50.0

    /* Density at altitude */
    densmTmp = densmTmp * (t1 / tz.v) * Math.exp(-expl)
  }
  if (xm === 0.0) return tz.v
  else return densmTmp
}

/* ------------------------------- DENSU ----------------------------- */
// 热层温度（Bates 廓线 + 下层样条）与密度。tz 为输出持有者 { v }；tn1[0] / tgn1[0] 会被改写（C 版同）。
function densu(ctx, alt, dlb, tinf, tlb, xm, alpha, tz, zlb, s2, mn1, zn1, tn1, tgn1) {
  let yd2, yd1, x = 0, y
  const rgas = 831.4
  let densuTemp = 1.0
  let za, z, zg2, tt, ta
  let dta, z1 = 0, z2, t1 = 0, t2, zg, zgdif = 0
  let mn = 0
  let glb, expl, yi, densa, gamma, gamm
  const xs = new Float64Array(5), ys = new Float64Array(5), y2out = new Float64Array(5)
  /* joining altitudes of Bates and spline */
  za = zn1[0]
  if (alt > za) z = alt
  else z = za

  /* geopotential altitude difference from ZLB */
  zg2 = zeta(ctx, z, zlb)

  /* Bates temperature */
  tt = tinf - (tinf - tlb) * Math.exp(-s2 * zg2)
  ta = tt
  tz.v = tt
  densuTemp = tz.v

  if (alt < za) {
    /* calculate temperature below ZA
     * temperature gradient at ZA from Bates profile */
    dta = (tinf - ta) * s2 * Math.pow(((ctx.re + zlb) / (ctx.re + za)), 2.0)
    tgn1[0] = dta
    tn1[0] = ta
    if (alt > zn1[mn1 - 1]) z = alt
    else z = zn1[mn1 - 1]
    mn = mn1
    z1 = zn1[0]
    z2 = zn1[mn - 1]
    t1 = tn1[0]
    t2 = tn1[mn - 1]
    /* geopotental difference from z1 */
    zg = zeta(ctx, z, z1)
    zgdif = zeta(ctx, z2, z1)
    /* set up spline nodes */
    for (let k = 0; k < mn; k++) {
      xs[k] = zeta(ctx, zn1[k], z1) / zgdif
      ys[k] = 1.0 / tn1[k]
    }
    /* end node derivatives */
    yd1 = -tgn1[0] / (t1 * t1) * zgdif
    yd2 = -tgn1[1] / (t2 * t2) * zgdif * Math.pow(((ctx.re + z2) / (ctx.re + z1)), 2.0)
    /* calculate spline coefficients */
    spline(xs, ys, mn, yd1, yd2, y2out)
    x = zg / zgdif
    y = splint(xs, ys, y2out, mn, x)
    /* temperature at altitude */
    tz.v = 1.0 / y
    densuTemp = tz.v
  }
  if (xm === 0) return densuTemp

  /* calculate density above za */
  glb = ctx.gsurf / Math.pow((1.0 + zlb / ctx.re), 2.0)
  gamma = xm * glb / (s2 * rgas * tinf)
  expl = Math.exp(-s2 * gamma * zg2)
  if (expl > 50.0) expl = 50.0
  if (tt <= 0) expl = 50.0

  /* density at altitude */
  densa = dlb * Math.pow((tlb / tt), ((1.0 + alpha + gamma))) * expl
  densuTemp = densa
  if (alt >= za) return densuTemp

  /* calculate density below za */
  glb = ctx.gsurf / Math.pow((1.0 + z1 / ctx.re), 2.0)
  gamm = xm * glb * zgdif / rgas

  /* integrate spline temperatures */
  yi = splini(xs, ys, y2out, mn, x)
  expl = gamm * yi
  if (expl > 50.0) expl = 50.0
  if (tz.v <= 0) expl = 50.0

  /* density at altitude */
  densuTemp = densuTemp * Math.pow((t1 / tz.v), (1.0 + alpha)) * Math.exp(-expl)
  return densuTemp
}

/* ------------------------------- GLOBE7 ---------------------------- */
/*    3hr Magnetic activity functions */
// C 版在 sw[9] = −1 时把 p[24] 下限钳到 1e-4（改写系数表）；这里不改表，在用到处取钳后的值，结果相同。
const p24c = (p) => (p[24] < 1.0E-4 ? 1.0E-4 : p[24])
/*    Eq. A24d */
function g0(a, p) {
  const q = p24c(p)
  return (a - 4.0 + (p[25] - 1.0) * (a - 4.0 + (Math.exp(-Math.sqrt(q * q) * (a - 4.0)) - 1.0) / Math.sqrt(q * q)))
}
/*    Eq. A24c */
function sumex(ex) {
  return (1.0 + (1.0 - Math.pow(ex, 19.0)) / (1.0 - ex) * Math.pow(ex, 0.5))
}
/*    Eq. A24a */
function sg0(ex, p, ap) {
  return (g0(ap[1], p) + (g0(ap[2], p) * ex + g0(ap[3], p) * ex * ex +
    g0(ap[4], p) * Math.pow(ex, 3.0) + (g0(ap[5], p) * Math.pow(ex, 4.0) +
    g0(ap[6], p) * Math.pow(ex, 12.0)) * (1.0 - Math.pow(ex, 8.0)) / (1.0 - ex))) / sumex(ex)
}

// 计算 G(L)：上热层参数
function globe7(ctx, p, input) {
  const sw = ctx.sw, swc = ctx.swc, plg = ctx.plg
  const t = new Float64Array(15)
  const sr = 7.2722E-5
  const dgtr = 1.74533E-2
  const dr = 1.72142E-2
  const hr = 0.2618
  const tloc = input.lst

  /* calculate legendre polynomials */
  const c = Math.sin(input.g_lat * dgtr)
  const s = Math.cos(input.g_lat * dgtr)
  const c2 = c * c
  const c4 = c2 * c2
  const s2 = s * s

  plg[0][1] = c
  plg[0][2] = 0.5 * (3.0 * c2 - 1.0)
  plg[0][3] = 0.5 * (5.0 * c * c2 - 3.0 * c)
  plg[0][4] = (35.0 * c4 - 30.0 * c2 + 3.0) / 8.0
  plg[0][5] = (63.0 * c2 * c2 * c - 70.0 * c2 * c + 15.0 * c) / 8.0
  plg[0][6] = (11.0 * c * plg[0][5] - 5.0 * plg[0][4]) / 6.0
  plg[1][1] = s
  plg[1][2] = 3.0 * c * s
  plg[1][3] = 1.5 * (5.0 * c2 - 1.0) * s
  plg[1][4] = 2.5 * (7.0 * c2 * c - 3.0 * c) * s
  plg[1][5] = 1.875 * (21.0 * c4 - 14.0 * c2 + 1.0) * s
  plg[1][6] = (11.0 * c * plg[1][5] - 6.0 * plg[1][4]) / 5.0
  plg[2][2] = 3.0 * s2
  plg[2][3] = 15.0 * s2 * c
  plg[2][4] = 7.5 * (7.0 * c2 - 1.0) * s2
  plg[2][5] = 3.0 * c * plg[2][4] - 2.0 * plg[2][3]
  plg[2][6] = (11.0 * c * plg[2][5] - 7.0 * plg[2][4]) / 4.0
  plg[2][7] = (13.0 * c * plg[2][6] - 8.0 * plg[2][5]) / 5.0
  plg[3][3] = 15.0 * s2 * s
  plg[3][4] = 105.0 * s2 * s * c
  plg[3][5] = (9.0 * c * plg[3][4] - 7. * plg[3][3]) / 2.0
  plg[3][6] = (11.0 * c * plg[3][5] - 8. * plg[3][4]) / 3.0

  if (!(((sw[7] === 0) && (sw[8] === 0)) && (sw[14] === 0))) {
    ctx.stloc = Math.sin(hr * tloc)
    ctx.ctloc = Math.cos(hr * tloc)
    ctx.s2tloc = Math.sin(2.0 * hr * tloc)
    ctx.c2tloc = Math.cos(2.0 * hr * tloc)
    ctx.s3tloc = Math.sin(3.0 * hr * tloc)
    ctx.c3tloc = Math.cos(3.0 * hr * tloc)
  }
  const ctloc = ctx.ctloc, stloc = ctx.stloc, c2tloc = ctx.c2tloc, s2tloc = ctx.s2tloc, c3tloc = ctx.c3tloc, s3tloc = ctx.s3tloc

  const cd32 = Math.cos(dr * (input.doy - p[31]))
  const cd18 = Math.cos(2.0 * dr * (input.doy - p[17]))
  const cd14 = Math.cos(dr * (input.doy - p[13]))
  const cd39 = Math.cos(2.0 * dr * (input.doy - p[38]))

  /* F10.7 EFFECT */
  const df = input.f107 - input.f107A
  ctx.dfa = input.f107A - 150.0
  const dfa = ctx.dfa
  t[0] = p[19] * df * (1.0 + p[59] * dfa) + p[20] * df * df + p[21] * dfa + p[29] * Math.pow(dfa, 2.0)
  const f1 = 1.0 + (p[47] * dfa + p[19] * df + p[20] * df * df) * swc[1]
  const f2 = 1.0 + (p[49] * dfa + p[19] * df + p[20] * df * df) * swc[1]

  /*  TIME INDEPENDENT */
  t[1] = (p[1] * plg[0][2] + p[2] * plg[0][4] + p[22] * plg[0][6]) +
    (p[14] * plg[0][2]) * dfa * swc[1] + p[26] * plg[0][1]

  /*  SYMMETRICAL ANNUAL */
  t[2] = p[18] * cd32

  /*  SYMMETRICAL SEMIANNUAL */
  t[3] = (p[15] + p[16] * plg[0][2]) * cd18

  /*  ASYMMETRICAL ANNUAL */
  t[4] = f1 * (p[9] * plg[0][1] + p[10] * plg[0][3]) * cd14

  /*  ASYMMETRICAL SEMIANNUAL */
  t[5] = p[37] * plg[0][1] * cd39

  /* DIURNAL */
  if (sw[7]) {
    const t71 = (p[11] * plg[1][2]) * cd14 * swc[5]
    const t72 = (p[12] * plg[1][2]) * cd14 * swc[5]
    t[6] = f2 * ((p[3] * plg[1][1] + p[4] * plg[1][3] + p[27] * plg[1][5] + t71) *
      ctloc + (p[6] * plg[1][1] + p[7] * plg[1][3] + p[28] * plg[1][5] +
      t72) * stloc)
  }

  /* SEMIDIURNAL */
  if (sw[8]) {
    const t81 = (p[23] * plg[2][3] + p[35] * plg[2][5]) * cd14 * swc[5]
    const t82 = (p[33] * plg[2][3] + p[36] * plg[2][5]) * cd14 * swc[5]
    t[7] = f2 * ((p[5] * plg[2][2] + p[41] * plg[2][4] + t81) * c2tloc + (p[8] * plg[2][2] + p[42] * plg[2][4] + t82) * s2tloc)
  }

  /* TERDIURNAL */
  if (sw[14]) {
    t[13] = f2 * ((p[39] * plg[3][3] + (p[93] * plg[3][4] + p[46] * plg[3][6]) * cd14 * swc[5]) * s3tloc + (p[40] * plg[3][3] + (p[94] * plg[3][4] + p[48] * plg[3][6]) * cd14 * swc[5]) * c3tloc)
  }

  /* magnetic activity based on daily ap */
  if (sw[9] === -1) {
    const ap = input.ap_a
    if (p[51] !== 0) {
      let exp1 = Math.exp(-10800.0 * Math.sqrt(p[51] * p[51]) / (1.0 + p[138] * (45.0 - Math.sqrt(input.g_lat * input.g_lat))))
      if (exp1 > 0.99999) exp1 = 0.99999
      ctx.apt[0] = sg0(exp1, p, ap)
      if (sw[9]) {
        t[8] = ctx.apt[0] * (p[50] + p[96] * plg[0][2] + p[54] * plg[0][4] +
          (p[125] * plg[0][1] + p[126] * plg[0][3] + p[127] * plg[0][5]) * cd14 * swc[5] +
          (p[128] * plg[1][1] + p[129] * plg[1][3] + p[130] * plg[1][5]) * swc[7] *
          Math.cos(hr * (tloc - p[131])))
      }
    }
  } else {
    const apd = input.ap - 4.0
    let p44 = p[43]
    const p45 = p[44]
    if (p44 < 0) p44 = 1.0E-5
    ctx.apdf = apd + (p45 - 1.0) * (apd + (Math.exp(-p44 * apd) - 1.0) / p44)
    if (sw[9]) {
      t[8] = ctx.apdf * (p[32] + p[45] * plg[0][2] + p[34] * plg[0][4] +
        (p[100] * plg[0][1] + p[101] * plg[0][3] + p[102] * plg[0][5]) * cd14 * swc[5] +
        (p[121] * plg[1][1] + p[122] * plg[1][3] + p[123] * plg[1][5]) * swc[7] *
        Math.cos(hr * (tloc - p[124])))
    }
  }

  if ((sw[10]) && (input.g_long > -1000.0)) {

    /* longitudinal */
    if (sw[11]) {
      t[10] = (1.0 + p[80] * dfa * swc[1]) *
        ((p[64] * plg[1][2] + p[65] * plg[1][4] + p[66] * plg[1][6] +
          p[103] * plg[1][1] + p[104] * plg[1][3] + p[105] * plg[1][5] +
          swc[5] * (p[109] * plg[1][1] + p[110] * plg[1][3] + p[111] * plg[1][5]) * cd14) *
          Math.cos(dgtr * input.g_long) +
          (p[90] * plg[1][2] + p[91] * plg[1][4] + p[92] * plg[1][6] +
            p[106] * plg[1][1] + p[107] * plg[1][3] + p[108] * plg[1][5] +
            swc[5] * (p[112] * plg[1][1] + p[113] * plg[1][3] + p[114] * plg[1][5]) * cd14) *
          Math.sin(dgtr * input.g_long))
    }

    /* ut and mixed ut, longitude */
    if (sw[12]) {
      t[11] = (1.0 + p[95] * plg[0][1]) * (1.0 + p[81] * dfa * swc[1]) *
        (1.0 + p[119] * plg[0][1] * swc[5] * cd14) *
        ((p[68] * plg[0][1] + p[69] * plg[0][3] + p[70] * plg[0][5]) *
          Math.cos(sr * (input.sec - p[71])))
      t[11] += swc[11] *
        (p[76] * plg[2][3] + p[77] * plg[2][5] + p[78] * plg[2][7]) *
        Math.cos(sr * (input.sec - p[79]) + 2.0 * dgtr * input.g_long) * (1.0 + p[137] * dfa * swc[1])
    }

    /* ut, longitude magnetic activity */
    if (sw[13]) {
      if (sw[9] === -1) {
        if (p[51]) {
          const apt0 = ctx.apt[0]
          t[12] = apt0 * swc[11] * (1. + p[132] * plg[0][1]) *
            ((p[52] * plg[1][2] + p[98] * plg[1][4] + p[67] * plg[1][6]) *
              Math.cos(dgtr * (input.g_long - p[97]))) +
            apt0 * swc[11] * swc[5] *
            (p[133] * plg[1][1] + p[134] * plg[1][3] + p[135] * plg[1][5]) *
            cd14 * Math.cos(dgtr * (input.g_long - p[136])) +
            apt0 * swc[12] *
            (p[55] * plg[0][1] + p[56] * plg[0][3] + p[57] * plg[0][5]) *
            Math.cos(sr * (input.sec - p[58]))
        }
      } else {
        const apdf = ctx.apdf
        t[12] = apdf * swc[11] * (1.0 + p[120] * plg[0][1]) *
          ((p[60] * plg[1][2] + p[61] * plg[1][4] + p[62] * plg[1][6]) *
            Math.cos(dgtr * (input.g_long - p[63]))) +
          apdf * swc[11] * swc[5] *
          (p[115] * plg[1][1] + p[116] * plg[1][3] + p[117] * plg[1][5]) *
          cd14 * Math.cos(dgtr * (input.g_long - p[118])) +
          apdf * swc[12] *
          (p[83] * plg[0][1] + p[84] * plg[0][3] + p[85] * plg[0][5]) *
          Math.cos(sr * (input.sec - p[75]))
      }
    }
  }

  /* parms not used: 82, 89, 99, 139-149 */
  let tinf = p[30]
  for (let i = 0; i < 14; i++) tinf = tinf + Math.abs(sw[i + 1]) * t[i]
  return tinf
}

/* ------------------------------- GLOB7S ---------------------------- */
// 低层大气版的 G(L)（10/26/99）。用的是最近一次 globe7 留下的 plg / dfa / 地方时三角 / apdf / apt。
function glob7s(ctx, p, input) {
  const sw = ctx.sw, swc = ctx.swc, plg = ctx.plg
  const pset = 2.0
  const t = new Float64Array(14)
  const dr = 1.72142E-2
  const dgtr = 1.74533E-2
  /* confirm parameter set（C 版 p[99] 为 0 时就地补成 2） */
  const p99 = p[99] === 0 ? pset : p[99]
  if (p99 !== pset) return -1
  const cd32 = Math.cos(dr * (input.doy - p[31]))
  const cd18 = Math.cos(2.0 * dr * (input.doy - p[17]))
  const cd14 = Math.cos(dr * (input.doy - p[13]))
  const cd39 = Math.cos(2.0 * dr * (input.doy - p[38]))

  /* F10.7 */
  t[0] = p[21] * ctx.dfa

  /* time independent */
  t[1] = p[1] * plg[0][2] + p[2] * plg[0][4] + p[22] * plg[0][6] + p[26] * plg[0][1] + p[14] * plg[0][3] + p[59] * plg[0][5]

  /* SYMMETRICAL ANNUAL */
  t[2] = (p[18] + p[47] * plg[0][2] + p[29] * plg[0][4]) * cd32

  /* SYMMETRICAL SEMIANNUAL */
  t[3] = (p[15] + p[16] * plg[0][2] + p[30] * plg[0][4]) * cd18

  /* ASYMMETRICAL ANNUAL */
  t[4] = (p[9] * plg[0][1] + p[10] * plg[0][3] + p[20] * plg[0][5]) * cd14

  /* ASYMMETRICAL SEMIANNUAL */
  t[5] = (p[37] * plg[0][1]) * cd39

  /* DIURNAL */
  if (sw[7]) {
    const t71 = p[11] * plg[1][2] * cd14 * swc[5]
    const t72 = p[12] * plg[1][2] * cd14 * swc[5]
    t[6] = ((p[3] * plg[1][1] + p[4] * plg[1][3] + t71) * ctx.ctloc + (p[6] * plg[1][1] + p[7] * plg[1][3] + t72) * ctx.stloc)
  }

  /* SEMIDIURNAL */
  if (sw[8]) {
    const t81 = (p[23] * plg[2][3] + p[35] * plg[2][5]) * cd14 * swc[5]
    const t82 = (p[33] * plg[2][3] + p[36] * plg[2][5]) * cd14 * swc[5]
    t[7] = ((p[5] * plg[2][2] + p[41] * plg[2][4] + t81) * ctx.c2tloc + (p[8] * plg[2][2] + p[42] * plg[2][4] + t82) * ctx.s2tloc)
  }

  /* TERDIURNAL */
  if (sw[14]) {
    t[13] = p[39] * plg[3][3] * ctx.s3tloc + p[40] * plg[3][3] * ctx.c3tloc
  }

  /* MAGNETIC ACTIVITY */
  if (sw[9]) {
    if (sw[9] === 1) t[8] = ctx.apdf * (p[32] + p[45] * plg[0][2] * swc[2])
    if (sw[9] === -1) t[8] = (p[50] * ctx.apt[0] + p[96] * plg[0][2] * ctx.apt[0] * swc[2])
  }

  /* LONGITUDINAL */
  if (!((sw[10] === 0) || (sw[11] === 0) || (input.g_long <= -1000.0))) {
    t[10] = (1.0 + plg[0][1] * (p[80] * swc[5] * Math.cos(dr * (input.doy - p[81])) +
      p[85] * swc[6] * Math.cos(2.0 * dr * (input.doy - p[86]))) +
      p[83] * swc[3] * Math.cos(dr * (input.doy - p[84])) +
      p[87] * swc[4] * Math.cos(2.0 * dr * (input.doy - p[88]))) *
      ((p[64] * plg[1][2] + p[65] * plg[1][4] + p[66] * plg[1][6] +
        p[74] * plg[1][1] + p[75] * plg[1][3] + p[76] * plg[1][5]
      ) * Math.cos(dgtr * input.g_long) +
        (p[90] * plg[1][2] + p[91] * plg[1][4] + p[92] * plg[1][6] +
          p[77] * plg[1][1] + p[78] * plg[1][3] + p[79] * plg[1][5]
        ) * Math.sin(dgtr * input.g_long))
  }
  let tt = 0
  for (let i = 0; i < 14; i++) tt += Math.abs(sw[i + 1]) * t[i]
  return tt
}

/* ------------------------------- GTS7 ------------------------------ */
// 热层部分（alt > 72.5 km）。out = { d: Float64Array(9), t: Float64Array(2) }
function gts7(ctx, input, out) {
  const sw = ctx.sw
  const zn1 = [120.0, 110.0, 100.0, 90.0, 72.5]
  const mn1 = 5
  const dgtr = 1.74533E-2
  const dr = 1.72142E-2
  const alpha = [-0.38, 0.0, 0.0, 0.0, 0.17, 0.0, -0.38, 0.0, 0.0]
  const altl = [200.0, 300.0, 160.0, 250.0, 240.0, 450.0, 320.0, 450.0]
  const T1 = { v: out.t[1] }, TZ = { v: 0 }
  const mt1 = ctx.meso_tn1, mg1 = ctx.meso_tgn1
  let tinf, g0v, tlb, s, z, rl
  const za = pdl[1][15]
  zn1[0] = za
  for (let j = 0; j < 9; j++) out.d[j] = 0

  /* TINF VARIATIONS NOT IMPORTANT BELOW ZA OR ZN1(1) */
  if (input.alt > zn1[0]) tinf = ptm[0] * pt[0] * (1.0 + sw[16] * globe7(ctx, pt, input))
  else tinf = ptm[0] * pt[0]
  out.t[0] = tinf

  /*  GRADIENT VARIATIONS NOT IMPORTANT BELOW ZN1(5) */
  if (input.alt > zn1[4]) g0v = ptm[3] * ps[0] * (1.0 + sw[19] * globe7(ctx, ps, input))
  else g0v = ptm[3] * ps[0]
  tlb = ptm[1] * (1.0 + sw[17] * globe7(ctx, pd[3], input)) * pd[3][0]
  s = g0v / (tinf - tlb)

  /*      Lower thermosphere temp variations not significant for
   *       density above 300 km */
  if (input.alt < 300.0) {
    mt1[1] = ptm[6] * ptl[0][0] / (1.0 - sw[18] * glob7s(ctx, ptl[0], input))
    mt1[2] = ptm[2] * ptl[1][0] / (1.0 - sw[18] * glob7s(ctx, ptl[1], input))
    mt1[3] = ptm[7] * ptl[2][0] / (1.0 - sw[18] * glob7s(ctx, ptl[2], input))
    mt1[4] = ptm[4] * ptl[3][0] / (1.0 - sw[18] * sw[20] * glob7s(ctx, ptl[3], input))
    mg1[1] = ptm[8] * pma[8][0] * (1.0 + sw[18] * sw[20] * glob7s(ctx, pma[8], input)) * mt1[4] * mt1[4] / (Math.pow((ptm[4] * ptl[3][0]), 2.0))
  } else {
    mt1[1] = ptm[6] * ptl[0][0]
    mt1[2] = ptm[2] * ptl[1][0]
    mt1[3] = ptm[7] * ptl[2][0]
    mt1[4] = ptm[4] * ptl[3][0]
    mg1[1] = ptm[8] * pma[8][0] * mt1[4] * mt1[4] / (Math.pow((ptm[4] * ptl[3][0]), 2.0))
  }

  /* N2 variation factor at Zlb */
  const g28 = sw[21] * globe7(ctx, pd[2], input)

  /* VARIATION OF TURBOPAUSE HEIGHT */
  const zhf = pdl[1][24] * (1.0 + sw[5] * pdl[0][24] * Math.sin(dgtr * input.g_lat) * Math.cos(dr * (input.doy - pt[13])))
  out.t[0] = tinf
  const xmm = pdm[2][4]
  z = input.alt

  /**** N2 DENSITY ****/
  /* Diffusive density at Zlb */
  const db28 = pdm[2][0] * Math.exp(g28) * pd[2][0]
  /* Diffusive density at Alt */
  out.d[2] = densu(ctx, z, db28, tinf, tlb, 28.0, alpha[2], T1, ptm[5], s, mn1, zn1, mt1, mg1)
  /* Turbopause */
  const zh28 = pdm[2][2] * zhf
  const zhm28 = pdm[2][3] * pdl[1][5]
  const xmd = 28.0 - xmm
  /* Mixed density at Zlb */
  const b28 = densu(ctx, zh28, db28, tinf, tlb, xmd, (alpha[2] - 1.0), TZ, ptm[5], s, mn1, zn1, mt1, mg1)
  if ((sw[15]) && (z <= altl[2])) {
    /*  Mixed density at Alt */
    ctx.dm28 = densu(ctx, z, b28, tinf, tlb, xmm, alpha[2], TZ, ptm[5], s, mn1, zn1, mt1, mg1)
    /*  Net density at Alt */
    out.d[2] = dnet(out.d[2], ctx.dm28, zhm28, xmm, 28.0)
  }

  /**** HE DENSITY ****/
  /*   Density variation factor at Zlb */
  const g4 = sw[21] * globe7(ctx, pd[0], input)
  /*  Diffusive density at Zlb */
  const db04 = pdm[0][0] * Math.exp(g4) * pd[0][0]
  /*  Diffusive density at Alt */
  out.d[0] = densu(ctx, z, db04, tinf, tlb, 4., alpha[0], T1, ptm[5], s, mn1, zn1, mt1, mg1)
  if ((sw[15]) && (z < altl[0])) {
    /*  Turbopause */
    const zh04 = pdm[0][2]
    /*  Mixed density at Zlb */
    const b04 = densu(ctx, zh04, db04, tinf, tlb, 4. - xmm, alpha[0] - 1., T1, ptm[5], s, mn1, zn1, mt1, mg1)
    /*  Mixed density at Alt */
    ctx.dm04 = densu(ctx, z, b04, tinf, tlb, xmm, 0., T1, ptm[5], s, mn1, zn1, mt1, mg1)
    const zhm04 = zhm28
    /*  Net density at Alt */
    out.d[0] = dnet(out.d[0], ctx.dm04, zhm04, xmm, 4.)
    /*  Correction to specified mixing ratio at ground */
    rl = Math.log(b28 * pdm[0][1] / b04)
    const zc04 = pdm[0][4] * pdl[1][0]
    const hc04 = pdm[0][5] * pdl[1][1]
    /*  Net density corrected at Alt */
    out.d[0] = out.d[0] * ccor(z, rl, hc04, zc04)
  }

  /**** O DENSITY ****/
  /*  Density variation factor at Zlb */
  const g16 = sw[21] * globe7(ctx, pd[1], input)
  /*  Diffusive density at Zlb */
  const db16 = pdm[1][0] * Math.exp(g16) * pd[1][0]
  /*   Diffusive density at Alt */
  out.d[1] = densu(ctx, z, db16, tinf, tlb, 16., alpha[1], T1, ptm[5], s, mn1, zn1, mt1, mg1)
  if ((sw[15]) && (z <= altl[1])) {
    /*   Turbopause */
    const zh16 = pdm[1][2]
    /*  Mixed density at Zlb */
    const b16 = densu(ctx, zh16, db16, tinf, tlb, 16.0 - xmm, (alpha[1] - 1.0), T1, ptm[5], s, mn1, zn1, mt1, mg1)
    /*  Mixed density at Alt */
    ctx.dm16 = densu(ctx, z, b16, tinf, tlb, xmm, 0., T1, ptm[5], s, mn1, zn1, mt1, mg1)
    const zhm16 = zhm28
    /*  Net density at Alt */
    out.d[1] = dnet(out.d[1], ctx.dm16, zhm16, xmm, 16.)
    rl = pdm[1][1] * pdl[1][16] * (1.0 + sw[1] * pdl[0][23] * (input.f107A - 150.0))
    const hc16 = pdm[1][5] * pdl[1][3]
    const zc16 = pdm[1][4] * pdl[1][2]
    const hc216 = pdm[1][5] * pdl[1][4]
    out.d[1] = out.d[1] * ccor2(z, rl, hc16, zc16, hc216)
    /*   Chemistry correction */
    const hcc16 = pdm[1][7] * pdl[1][13]
    const zcc16 = pdm[1][6] * pdl[1][12]
    const rc16 = pdm[1][3] * pdl[1][14]
    /*  Net density corrected at Alt */
    out.d[1] = out.d[1] * ccor(z, rc16, hcc16, zcc16)
  }

  /**** O2 DENSITY ****/
  /*   Density variation factor at Zlb */
  const g32 = sw[21] * globe7(ctx, pd[4], input)
  /*  Diffusive density at Zlb */
  const db32 = pdm[3][0] * Math.exp(g32) * pd[4][0]
  /*   Diffusive density at Alt */
  out.d[3] = densu(ctx, z, db32, tinf, tlb, 32., alpha[3], T1, ptm[5], s, mn1, zn1, mt1, mg1)
  if (sw[15]) {
    if (z <= altl[3]) {
      /*   Turbopause */
      const zh32 = pdm[3][2]
      /*  Mixed density at Zlb */
      const b32 = densu(ctx, zh32, db32, tinf, tlb, 32. - xmm, alpha[3] - 1., T1, ptm[5], s, mn1, zn1, mt1, mg1)
      /*  Mixed density at Alt */
      ctx.dm32 = densu(ctx, z, b32, tinf, tlb, xmm, 0., T1, ptm[5], s, mn1, zn1, mt1, mg1)
      const zhm32 = zhm28
      /*  Net density at Alt */
      out.d[3] = dnet(out.d[3], ctx.dm32, zhm32, xmm, 32.)
      /*   Correction to specified mixing ratio at ground */
      rl = Math.log(b28 * pdm[3][1] / b32)
      const hc32 = pdm[3][5] * pdl[1][7]
      const zc32 = pdm[3][4] * pdl[1][6]
      out.d[3] = out.d[3] * ccor(z, rl, hc32, zc32)
    }
    /*  Correction for general departure from diffusive equilibrium above Zlb */
    const hcc32 = pdm[3][7] * pdl[1][22]
    const hcc232 = pdm[3][7] * pdl[0][22]
    const zcc32 = pdm[3][6] * pdl[1][21]
    const rc32 = pdm[3][3] * pdl[1][23] * (1. + sw[1] * pdl[0][23] * (input.f107A - 150.))
    /*  Net density corrected at Alt */
    out.d[3] = out.d[3] * ccor2(z, rc32, hcc32, zcc32, hcc232)
  }

  /**** AR DENSITY ****/
  /*   Density variation factor at Zlb */
  const g40 = sw[21] * globe7(ctx, pd[5], input)
  /*  Diffusive density at Zlb */
  const db40 = pdm[4][0] * Math.exp(g40) * pd[5][0]
  /*   Diffusive density at Alt */
  out.d[4] = densu(ctx, z, db40, tinf, tlb, 40., alpha[4], T1, ptm[5], s, mn1, zn1, mt1, mg1)
  if ((sw[15]) && (z <= altl[4])) {
    /*   Turbopause */
    const zh40 = pdm[4][2]
    /*  Mixed density at Zlb */
    const b40 = densu(ctx, zh40, db40, tinf, tlb, 40. - xmm, alpha[4] - 1., T1, ptm[5], s, mn1, zn1, mt1, mg1)
    /*  Mixed density at Alt */
    ctx.dm40 = densu(ctx, z, b40, tinf, tlb, xmm, 0., T1, ptm[5], s, mn1, zn1, mt1, mg1)
    const zhm40 = zhm28
    /*  Net density at Alt */
    out.d[4] = dnet(out.d[4], ctx.dm40, zhm40, xmm, 40.)
    /*   Correction to specified mixing ratio at ground */
    rl = Math.log(b28 * pdm[4][1] / b40)
    const hc40 = pdm[4][5] * pdl[1][9]
    const zc40 = pdm[4][4] * pdl[1][8]
    /*  Net density corrected at Alt */
    out.d[4] = out.d[4] * ccor(z, rl, hc40, zc40)
  }

  /**** HYDROGEN DENSITY ****/
  /*   Density variation factor at Zlb */
  const g1 = sw[21] * globe7(ctx, pd[6], input)
  /*  Diffusive density at Zlb */
  const db01 = pdm[5][0] * Math.exp(g1) * pd[6][0]
  /*   Diffusive density at Alt */
  out.d[6] = densu(ctx, z, db01, tinf, tlb, 1., alpha[6], T1, ptm[5], s, mn1, zn1, mt1, mg1)
  if ((sw[15]) && (z <= altl[6])) {
    /*   Turbopause */
    const zh01 = pdm[5][2]
    /*  Mixed density at Zlb */
    const b01 = densu(ctx, zh01, db01, tinf, tlb, 1. - xmm, alpha[6] - 1., T1, ptm[5], s, mn1, zn1, mt1, mg1)
    /*  Mixed density at Alt */
    ctx.dm01 = densu(ctx, z, b01, tinf, tlb, xmm, 0., T1, ptm[5], s, mn1, zn1, mt1, mg1)
    const zhm01 = zhm28
    /*  Net density at Alt */
    out.d[6] = dnet(out.d[6], ctx.dm01, zhm01, xmm, 1.)
    /*   Correction to specified mixing ratio at ground */
    rl = Math.log(b28 * pdm[5][1] * Math.sqrt(pdl[1][17] * pdl[1][17]) / b01)
    const hc01 = pdm[5][5] * pdl[1][11]
    const zc01 = pdm[5][4] * pdl[1][10]
    out.d[6] = out.d[6] * ccor(z, rl, hc01, zc01)
    /*   Chemistry correction */
    const hcc01 = pdm[5][7] * pdl[1][19]
    const zcc01 = pdm[5][6] * pdl[1][18]
    const rc01 = pdm[5][3] * pdl[1][20]
    /*  Net density corrected at Alt */
    out.d[6] = out.d[6] * ccor(z, rc01, hcc01, zcc01)
  }

  /**** ATOMIC NITROGEN DENSITY ****/
  /*   Density variation factor at Zlb */
  const g14 = sw[21] * globe7(ctx, pd[7], input)
  /*  Diffusive density at Zlb */
  const db14 = pdm[6][0] * Math.exp(g14) * pd[7][0]
  /*   Diffusive density at Alt */
  out.d[7] = densu(ctx, z, db14, tinf, tlb, 14., alpha[7], T1, ptm[5], s, mn1, zn1, mt1, mg1)
  if ((sw[15]) && (z <= altl[7])) {
    /*   Turbopause */
    const zh14 = pdm[6][2]
    /*  Mixed density at Zlb */
    const b14 = densu(ctx, zh14, db14, tinf, tlb, 14. - xmm, alpha[7] - 1., T1, ptm[5], s, mn1, zn1, mt1, mg1)
    /*  Mixed density at Alt */
    ctx.dm14 = densu(ctx, z, b14, tinf, tlb, xmm, 0., T1, ptm[5], s, mn1, zn1, mt1, mg1)
    const zhm14 = zhm28
    /*  Net density at Alt */
    out.d[7] = dnet(out.d[7], ctx.dm14, zhm14, xmm, 14.)
    /*   Correction to specified mixing ratio at ground */
    rl = Math.log(b28 * pdm[6][1] * Math.sqrt(pdl[0][2] * pdl[0][2]) / b14)
    const hc14 = pdm[6][5] * pdl[0][1]
    const zc14 = pdm[6][4] * pdl[0][0]
    out.d[7] = out.d[7] * ccor(z, rl, hc14, zc14)
    /*   Chemistry correction */
    const hcc14 = pdm[6][7] * pdl[0][4]
    const zcc14 = pdm[6][6] * pdl[0][3]
    const rc14 = pdm[6][3] * pdl[0][5]
    /*  Net density corrected at Alt */
    out.d[7] = out.d[7] * ccor(z, rc14, hcc14, zcc14)
  }

  /**** Anomalous OXYGEN DENSITY ****/
  const g16h = sw[21] * globe7(ctx, pd[8], input)
  const db16h = pdm[7][0] * Math.exp(g16h) * pd[8][0]
  const tho = pdm[7][9] * pdl[0][6]
  const dd = densu(ctx, z, db16h, tho, tho, 16., alpha[8], T1, ptm[5], s, mn1, zn1, mt1, mg1)
  const zsht = pdm[7][5]
  const zmho = pdm[7][4]
  const zsho = scalh(ctx, zmho, 16.0, tho)
  out.d[8] = dd * Math.exp(-zsht / zsho * (Math.exp(-(z - zmho) / zsht) - 1.))

  /* total mass density */
  out.d[5] = 1.66E-24 * (4.0 * out.d[0] + 16.0 * out.d[1] + 28.0 * out.d[2] + 32.0 * out.d[3] + 40.0 * out.d[4] + out.d[6] + 14.0 * out.d[7])

  /* temperature */
  z = Math.sqrt(input.alt * input.alt)
  densu(ctx, z, 1.0, tinf, tlb, 0.0, 0.0, T1, ptm[5], s, mn1, zn1, mt1, mg1)
  out.t[1] = T1.v
  if (sw[0]) {
    for (let i = 0; i < 9; i++) out.d[i] = out.d[i] * 1.0E6
    out.d[5] = out.d[5] / 1000
  }
}

/* ------------------------------- GTD7 ------------------------------ */
function gtd7(input, switches) {
  const flags = tselec(switches)
  const ctx = newCtx(flags)
  const out = { d: new Float64Array(9), t: new Float64Array(2) }
  gtd7Core(ctx, input, out)
  return out
}

function gtd7Core(ctx, input, out) {
  const sw = ctx.sw
  const mn3 = 5
  const zn3 = [32.5, 20.0, 15.0, 10.0, 0.0]
  const mn2 = 4
  const zn2 = [72.5, 55.0, 45.0, 32.5]
  const zmix = 62.5
  const TZ = { v: 0 }

  /* Latitude variation of gravity (none for sw[2]=0) */
  let xlat = input.g_lat
  if (sw[2] === 0) xlat = 45.0
  glatf(ctx, xlat)

  const xmm = pdm[2][4]

  /* THERMOSPHERE / MESOSPHERE (above zn2[0]) */
  const altt = input.alt > zn2[0] ? input.alt : zn2[0]
  const soutput = { d: new Float64Array(9), t: new Float64Array(2) }
  gts7(ctx, Object.assign({}, input, { alt: altt }), soutput)
  let dm28m
  if (sw[0]) dm28m = ctx.dm28 * 1.0E6 /* metric adjustment */
  else dm28m = ctx.dm28
  out.t[0] = soutput.t[0]
  out.t[1] = soutput.t[1]
  if (input.alt >= zn2[0]) {
    for (let i = 0; i < 9; i++) out.d[i] = soutput.d[i]
    return
  }

  /*       LOWER MESOSPHERE/UPPER STRATOSPHERE (between zn3[0] and zn2[0])
   *         Temperature at nodes and gradients at end nodes
   *         Inverse temperature a linear function of spherical harmonics
   */
  const mt2 = ctx.meso_tn2, mg2 = ctx.meso_tgn2, mt3 = ctx.meso_tn3, mg3 = ctx.meso_tgn3
  mg2[0] = ctx.meso_tgn1[1]
  mt2[0] = ctx.meso_tn1[4]
  mt2[1] = pma[0][0] * pavgm[0] / (1.0 - sw[20] * glob7s(ctx, pma[0], input))
  mt2[2] = pma[1][0] * pavgm[1] / (1.0 - sw[20] * glob7s(ctx, pma[1], input))
  mt2[3] = pma[2][0] * pavgm[2] / (1.0 - sw[20] * sw[22] * glob7s(ctx, pma[2], input))
  mg2[1] = pavgm[8] * pma[9][0] * (1.0 + sw[20] * sw[22] * glob7s(ctx, pma[9], input)) * mt2[3] * mt2[3] / (Math.pow((pma[2][0] * pavgm[2]), 2.0))
  mt3[0] = mt2[3]

  if (input.alt <= zn3[0]) {
    /*       LOWER STRATOSPHERE AND TROPOSPHERE (below zn3[0])
     *         Temperature at nodes and gradients at end nodes
     *         Inverse temperature a linear function of spherical harmonics
     */
    mg3[0] = mg2[1]
    mt3[1] = pma[3][0] * pavgm[3] / (1.0 - sw[22] * glob7s(ctx, pma[3], input))
    mt3[2] = pma[4][0] * pavgm[4] / (1.0 - sw[22] * glob7s(ctx, pma[4], input))
    mt3[3] = pma[5][0] * pavgm[5] / (1.0 - sw[22] * glob7s(ctx, pma[5], input))
    mt3[4] = pma[6][0] * pavgm[6] / (1.0 - sw[22] * glob7s(ctx, pma[6], input))
    mg3[1] = pma[7][0] * pavgm[7] * (1.0 + sw[22] * glob7s(ctx, pma[7], input)) * mt3[4] * mt3[4] / (Math.pow((pma[6][0] * pavgm[6]), 2.0))
  }

  /* LINEAR TRANSITION TO FULL MIXING BELOW zn2[0] */
  let dmc = 0
  if (input.alt > zmix) dmc = 1.0 - (zn2[0] - input.alt) / (zn2[0] - zmix)
  const dz28 = soutput.d[2]

  /**** N2 density ****/
  let dmr = soutput.d[2] / dm28m - 1.0
  out.d[2] = densm(ctx, input.alt, dm28m, xmm, TZ, mn3, zn3, mt3, mg3, mn2, zn2, mt2, mg2)
  out.d[2] = out.d[2] * (1.0 + dmr * dmc)

  /**** HE density ****/
  dmr = soutput.d[0] / (dz28 * pdm[0][1]) - 1.0
  out.d[0] = out.d[2] * pdm[0][1] * (1.0 + dmr * dmc)

  /**** O density ****/
  out.d[1] = 0
  out.d[8] = 0

  /**** O2 density ****/
  dmr = soutput.d[3] / (dz28 * pdm[3][1]) - 1.0
  out.d[3] = out.d[2] * pdm[3][1] * (1.0 + dmr * dmc)

  /**** AR density ***/
  dmr = soutput.d[4] / (dz28 * pdm[4][1]) - 1.0
  out.d[4] = out.d[2] * pdm[4][1] * (1.0 + dmr * dmc)

  /**** Hydrogen density ****/
  out.d[6] = 0

  /**** Atomic nitrogen density ****/
  out.d[7] = 0

  /**** Total mass density */
  out.d[5] = 1.66E-24 * (4.0 * out.d[0] + 16.0 * out.d[1] + 28.0 * out.d[2] + 32.0 * out.d[3] + 40.0 * out.d[4] + out.d[6] + 14.0 * out.d[7])

  if (sw[0]) out.d[5] = out.d[5] / 1000

  /**** temperature at altitude ****/
  ctx.dd = densm(ctx, input.alt, 1.0, 0, TZ, mn3, zn3, mt3, mg3, mn2, zn2, mt2, mg2)
  out.t[1] = TZ.v
}

/* ------------------------------- GTD7D ----------------------------- */
// 同 gtd7，但 d[5] 为「拖曳用有效总质量密度」（含异常氧 d[8]）
function gtd7d(input, switches) {
  const flags = tselec(switches)
  const ctx = newCtx(flags)
  const out = { d: new Float64Array(9), t: new Float64Array(2) }
  gtd7Core(ctx, input, out)
  out.d[5] = 1.66E-24 * (4.0 * out.d[0] + 16.0 * out.d[1] + 28.0 * out.d[2] + 32.0 * out.d[3] + 40.0 * out.d[4] + out.d[6] + 14.0 * out.d[7] + 16.0 * out.d[8])
  if (ctx.sw[0]) out.d[5] = out.d[5] / 1000
  return out
}

// 拖曳用总质量密度（kg/m³）：按 C 版 / NRL 标准开关（switch 0 = 1 即 SI 输出）调 gtd7d
function density(input, switches) {
  const s = (switches || DEFAULT_SWITCHES).slice()
  s[0] = 1
  return gtd7d(input, s).d[5]
}

module.exports = { gtd7, gtd7d, density, DEFAULT_SWITCHES }
