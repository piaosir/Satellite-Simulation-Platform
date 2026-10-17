// 重力场与地球自转（packages/core/utils/prop/forces/gravity.js、earthRotation.js）。
//
// 【外部真值】
//   ① NGA 原件 EGM2008_to2190_TideFree 的逐字行（下面 NGA_LINES，2026-10-17 从官方压缩包抄出）—— 打包数据逐项核对；
//   ② 加速度对「独立实现的位函数」求数值梯度：测试里另写一份用三角函数 + 归一化勒让德列推的位函数（与 gravity.js 的
//      Cunningham V/W 递推不同路），70×70 也核到 1e-9（相对非球形部分）；
//   ③ J2 长期率对一阶解析式：Ω̇ = −(3/2) n J2 (R/p)² cos i，ω̇ = (3/4) n J2 (R/p)² (5cos²i − 1)
//      （Vallado 4th ed. 式 9-41 / 9-42），差值应在二阶项 O(J2²) 以内；
//   ④ 地固系：与 frames.js 的 J2000→FIXED 链、satellite.js 的 gstime 逐点对拍；与 Orekit 的 EME2000→GTOD
//      （IERS 1996，无 EOP）对拍 —— 只差 frames.js 有意省略的 1997 起时差方程两小项。

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
const require = createRequire(import.meta.url)
const G = require('../utils/prop/forces/gravity.js')
const DATA = require('../utils/prop/data/egm2008_70.js')
const ER = require('../utils/prop/earthRotation.js')
const NP = require('../utils/prop/numProp.js')
const EL = require('../utils/prop/elements.js')
const FM = require('../utils/prop/forceModel.js')
const F = require('../utils/frames.js')
const T = require('../utils/timeSystems.js')
const sat = require('../vendor/satellite.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（差 ' + Math.abs(a - b) + '，容差 ' + tol + '）')
const section = (t) => console.log('\n— ' + t)
const loadFx = (name) => JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/prop/' + name + '.json.gz', import.meta.url))).toString('utf8'))

/* ===== ① 打包数据 ===== */
section('EGM2008 打包数据')
const egm = G.loadEgm2008()
ok(egm.C.length === 2556 && egm.S.length === 2556 && egm.nmax === 70, '2556 项（n ≤ 70）')
const packed = Buffer.concat([Buffer.from(egm.C.buffer), Buffer.from(egm.S.buffer)])
ok(createHash('sha256').update(packed).digest('hex') === DATA.packedSha256, '解码后字节的 SHA-256 与数据文件记录一致')
ok(DATA.zipSha256 === '65a9072f337f156e8cbd76ffd773f536e6fb0de18697ea6726ecdb790fac0fbd', '原件 zip 的 SHA-256 记录')
ok(egm.gm === 398600.4415 && egm.ae === 6378.1363 && egm.tideSystem === 'tide-free', 'GM / a_e / 潮汐体系（README_WGS84_2.pdf）')
ok(egm.C[0] === 1 && egm.C[1] === 0 && egm.C[2] === 0 && egm.S[2] === 0, 'C̄00 = 1，n = 1 三项为 0')
const NGA_LINES = [
  '    2    0   -0.484165143790815D-03    0.000000000000000D+00',
  '    2    1   -0.206615509074176D-09    0.138441389137979D-08',
  '    2    2    0.243938357328313D-05   -0.140027370385934D-05',
  '    3    1    0.203046201047864D-05    0.248200415856872D-06',
  '    8    8   -0.124022771917136D-06    0.120551889384997D-06',
  '   21   21    0.845910170806602D-08   -0.365321656984787D-08',
  '   36   17    0.542996891432844D-08   -0.878398133277499D-08',
  '   70    0   -0.586830047313794D-09    0.000000000000000D+00',
  '   70   70    0.298214665798648D-09   -0.140484139457899D-09'
]
for (const ln of NGA_LINES) {
  const t = ln.trim().split(/\s+/)
  const n = +t[0], m = +t[1], k = n * (n + 1) / 2 + m
  const c = Number(t[2].replace('D', 'e')), s = Number(t[3].replace('D', 'e'))
  ok(egm.C[k] === c && egm.S[k] === s, '原件逐字行 (' + n + ', ' + m + ') 逐位一致')
}
// 零潮汐折算：IERS 2010 式 (6.13)
const fZ = G.createGravityField({ degree: 2, order: 2 }), fT = G.createGravityField({ degree: 2, order: 2, tideSystem: 'tide-free' })
near(fZ.C[3] - fT.C[3], 4.4228e-8 * -0.31460 * 0.30190, 1e-18, '缺省 zero-tide：C̄20 = C̄20(tide-free) + A0·H0·k20')
near(fZ.C[3], -0.48416934e-3, 1e-11, 'zero-tide C̄20 ≈ −0.48416934e-3（IERS 2010 表 6.2 同量级）')
ok(G.defaultDegree([42164, 0, 0]) === 8 && G.defaultDegree([6878, 0, 0]) === 21, '缺省阶次：GEO 8×8，LEO 21×21')
let threw = false
try { G.createGravityField({ degree: 71 }) } catch (e) { threw = true }
ok(threw, '超过 70 阶报错')

/* ===== ② 加速度 vs 独立位函数的数值梯度 ===== */
section('加速度 vs 独立位函数的梯度')
// 独立实现：U = GM/r Σ (a/r)^n Σ (C̄ cos mλ + S̄ sin mλ) P̄nm(sin φ)，P̄nm 用标准列推（Holmes & Featherstone 2002 式 11、13）
function potentialRef(C, S, N, gm, ae, r) {
  const rr = Math.hypot(r[0], r[1], r[2]), sphi = r[2] / rr, cphi = Math.hypot(r[0], r[1]) / rr, lam = Math.atan2(r[1], r[0])
  const P = []
  for (let n = 0; n <= N; n++) P.push(new Float64Array(n + 1))
  P[0][0] = 1
  for (let m = 1; m <= N; m++) P[m][m] = (m === 1 ? Math.sqrt(3) : Math.sqrt((2 * m + 1) / (2 * m))) * cphi * P[m - 1][m - 1]
  for (let m = 0; m <= N; m++) {
    if (m + 1 <= N) P[m + 1][m] = Math.sqrt(2 * m + 3) * sphi * P[m][m]
    for (let n = m + 2; n <= N; n++) {
      P[n][m] = Math.sqrt((2 * n - 1) * (2 * n + 1) / ((n - m) * (n + m))) * sphi * P[n - 1][m] -
        Math.sqrt((2 * n + 1) * (n + m - 1) * (n - m - 1) / ((n - m) * (n + m) * (2 * n - 3))) * P[n - 2][m]
    }
  }
  let s = 0
  for (let n = 2; n <= N; n++) {
    let sn = 0
    for (let m = 0; m <= n; m++) { const k = n * (n + 1) / 2 + m; sn += (C[k] * Math.cos(m * lam) + S[k] * Math.sin(m * lam)) * P[n][m] }
    s += Math.pow(ae / rr, n) * sn
  }
  return gm / rr * s       // 只要非球形部分（n ≥ 2），免得中心项在差分里吃掉精度
}
const PTS = [[6578, 100, 50], [-3000, 5000, 4000], [-1200, -6600, -2000], [10, 20, 6700], [0.01, 0.02, -6800], [42164, 0, 10]]
for (const N of [8, 21, 70]) {
  const fld = G.createGravityField({ degree: N, order: N, tideSystem: 'tide-free' })
  let worst = 0
  for (const p of PTS) {
    const a = fld.accelerationFixed(p)
    const rr = Math.hypot(...p)
    const ans = [0, 1, 2].map((i) => a[i] + fld.gm * p[i] / rr ** 3)       // 去掉中心项
    const h = 1.0
    const g = [0, 1, 2].map((i) => {
      const q = (d) => { const x = p.slice(); x[i] += d; return x }
      const U = (x) => potentialRef(fld.C, fld.S, N, fld.gm, fld.ae, x)
      return (-U(q(2 * h)) + 8 * U(q(h)) - 8 * U(q(-h)) + U(q(-2 * h))) / (12 * h)
    })
    worst = Math.max(worst, Math.hypot(ans[0] - g[0], ans[1] - g[1], ans[2] - g[2]) / Math.hypot(...ans))
  }
  console.log('  ' + N + '×' + N + '：非球形加速度对独立位函数梯度的最大相对差 ' + worst.toExponential(2) + '（含近极点）')
  ok(worst < 1e-9, N + '×' + N + ' 加速度 = ∇U（相对 < 1e-9，四阶差分 h = 1 km 的截断 / 舍入水平）', String(worst))
}
{
  const f0 = G.createGravityField({ degree: 0 })
  const p = [7000, -1234, 3333], a = f0.accelerationFixed(p), rr = Math.hypot(...p)
  ok([0, 1, 2].every((i) => Math.abs(a[i] + f0.gm * p[i] / rr ** 3) <= 1e-15 * f0.gm / rr ** 2), '0 阶 = 点质量 −GM·r/r³')
  const f2 = G.createGravityField({ degree: 2, order: 0, includeCentral: false, tideSystem: 'tide-free' })
  const J2 = -Math.sqrt(5) * f2.C[3]
  // J2 的 z 向闭式：a_z = −(3/2) J2 GM R²/r⁵ · z (3 − 5 z²/r²)
  const az = -1.5 * J2 * f2.gm * f2.ae ** 2 / rr ** 5 * p[2] * (3 - 5 * p[2] ** 2 / rr ** 2)
  near(f2.accelerationFixed(p)[2] / az, 1, 1e-13, 'J2 项与闭式一致（a_z）')
}

/* ===== ③ J2 长期率对解析式 ===== */
section('J2 长期率')
{
  const mu = egm.gm, Re = egm.ae
  const J2 = -Math.sqrt(5) * G.createGravityField({ degree: 2, order: 0, tideSystem: 'tide-free' }).C[3]
  const fm = FM.createForceModel({ gravity: { degree: 2, order: 0, tideSystem: 'tide-free' }, thirdBody: false })
  const t0 = Date.UTC(2026, 0, 1)
  const unwrap = (arr) => { const o = [arr[0]]; for (let k = 1; k < arr.length; k++) { let d = arr[k] - arr[k - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; o.push(o[k - 1] + d) } return o }
  for (const [a, e, iDeg, days] of [[7000, 0.01, 50, 10], [7200, 0.05, 98, 10], [26560, 0.01, 55, 60]]) {
    const s = EL.coe2rv(mu, { a, e, i: iDeg * Math.PI / 180, raan: 0.4, argp: 1.0, nu: 0.2 })
    const Pd = 2 * Math.PI * Math.sqrt(a ** 3 / mu), per = 200
    const out = NP.propagate({ tMs: t0, r: s.r, v: s.v }, fm, { tEndMs: t0 + days * 86400e3, outStepSec: Pd / per, rtol: 1e-13, atolPos: 1e-10, atolVel: 1e-13 })
    const els = out.map((x) => EL.rv2coe(mu, x.r, x.v))
    const Om = unwrap(els.map((x) => x.raan)), w = unwrap(els.map((x) => x.argp))
    // 逐圈平均（近似平根数），再对时间线性拟合
    const avg = []
    for (let k = 0; k + per <= els.length - 1; k += per) {
      let sa = 0, se = 0, si = 0, sO = 0, sw = 0
      for (let j = k; j < k + per; j++) { sa += els[j].a; se += els[j].e; si += els[j].i; sO += Om[j]; sw += w[j] }
      avg.push({ t: (out[k].tMs + out[k + per].tMs) / 2000, a: sa / per, e: se / per, i: si / per, O: sO / per, w: sw / per })
    }
    const slope = (key) => { const n = avg.length; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (const q of avg) { sx += q.t; sy += q[key]; sxx += q.t * q.t; sxy += q.t * q[key] } return (n * sxy - sx * sy) / (n * sxx - sx * sx) }
    const mean = (key) => avg.reduce((x, q) => x + q[key], 0) / avg.length
    const am = mean('a'), em = mean('e'), im = mean('i')
    const n = Math.sqrt(mu / am ** 3), p = am * (1 - em * em)
    const scale = n * J2 * (Re / p) ** 2
    const Odot = -1.5 * scale * Math.cos(im), wdot = 0.75 * scale * (5 * Math.cos(im) ** 2 - 1)
    const dO = slope('O') - Odot, dw = slope('w') - wdot
    const deg = 86400 * 180 / Math.PI
    console.log(`  a=${a} km e=${e} i=${iDeg}°：Ω̇ ${(slope('O') * deg).toFixed(6)} vs ${(Odot * deg).toFixed(6)} °/d，ω̇ ${(slope('w') * deg).toFixed(6)} vs ${(wdot * deg).toFixed(6)} °/d（差 / (nJ2(R/p)²)：${(dO / scale).toExponential(1)}，${(dw / scale).toExponential(1)}）`)
    ok(Math.abs(dO) < 5e-3 * scale, `a=${a} i=${iDeg}° 节点长期率对解析式（二阶项以内）`, String(dO / scale))
    ok(Math.abs(dw) < 5e-3 * scale, `a=${a} i=${iDeg}° 近地点长期率对解析式（二阶项以内）`, String(dw / scale))
  }
}

/* ===== ④ 地固系 ===== */
section('地球自转矩阵')
{
  const er = ER.createEarthRotation()
  let wg = 0, wv = 0, wq = 0
  for (let k = 0; k < 1500; k++) {
    const t = Date.UTC(2000, 0, 1) + k * 1.111e9 + 0.123     // 2000–2052
    let dg = ER.gmst82(t) - sat.gstime(T.jdFromMs(t))
    dg -= 2 * Math.PI * Math.round(dg / (2 * Math.PI))
    wg = Math.max(wg, Math.abs(dg))
    const tc = T.julianCenturiesTT(t), nu = F.nutationAngles(tc), gm = sat.gstime(T.jdFromMs(t))
    const v = { x: 4000.123, y: -5555.5, z: 3210.9 }
    const ref = F.fromTeme(F.toTeme(v, 'J2000', tc, gm, nu), 'FIXED', tc, gm, nu)
    const ours = er.toFixed(t, [v.x, v.y, v.z])
    wv = Math.max(wv, Math.hypot(ours[0] - ref.x, ours[1] - ref.y, ours[2] - ref.z))
    const qe = ER.precNut(t), qc = er.q(t)
    for (let i = 0; i < 9; i++) wq = Math.max(wq, Math.abs(qe[i] - qc[i]))
  }
  console.log('  GMST 对 gstime ' + wg.toExponential(2) + ' rad；J2000→FIXED 对 frames.js 链 ' + (wv * 1e6).toFixed(3) + ' mm（7900 km 矢量）；缓存插值 ' + wq.toExponential(2))
  ok(wg < 3e-9, 'gmst82 与 satellite.js gstime 一致（< 3e-9 rad，gstime 的 JD 量化）', String(wg))
  ok(wv < 3e-5, 'J2000→FIXED 与 frames.js 的 J2000→MOD→TOD→TEME→FIXED 链一致（< 3 cm @ 7900 km）', String(wv))
  ok(wq < 1e-10, '岁差章动矩阵的 1 h 网格插值误差 < 1e-10', String(wq))
  const t = Date.UTC(2026, 9, 17, 6)
  const r = [1234.5, -6789.0, 4321.0]
  const back = er.toJ2000(t, er.toFixed(t, r))
  near(Math.hypot(back[0] - r[0], back[1] - r[1], back[2] - r[2]), 0, 1e-11, '地固来回（km）')
  const w = er.omegaJ2000(t)
  near(Math.hypot(...w), F.OMEGA_E, 1e-18, 'ω 矢量的模 = frames.js OMEGA_E')
  ok(w[2] > 0.9999 * F.OMEGA_E, 'ω 方向近 J2000 z 轴（差岁差章动的几十角秒）')
}
section('对 Orekit EME2000 → GTOD（IERS 1996，无 EOP）')
{
  const fx = loadFx('orekitFramesEphem')
  let wxy = 0, wz = 0, wz2 = 0
  for (const f of fx.frames) {
    const M = ER.matMul(ER.rotZ(ER.gmst82(f.tMs)), ER.precNut(f.tMs))
    const O = f.m, D = new Array(9).fill(0)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) D[3 * i + j] += M[3 * i + k] * O[3 * j + k]
    const ax = (D[5] - D[7]) / 2, ay = (D[6] - D[2]) / 2, az = (D[1] - D[3]) / 2
    // frames.js 省略的 1997 起时差方程两项（IAU 1994 C7）：0.00264″ sin Ω + 0.000063″ sin 2Ω
    const om = F.delaunay(T.julianCenturiesTT(f.tMs)).om
    const eqe97 = (0.00264 * Math.sin(om) + 0.000063 * Math.sin(2 * om)) * F.ARCSEC
    wxy = Math.max(wxy, Math.hypot(ax, ay)); wz = Math.max(wz, Math.abs(az)); wz2 = Math.max(wz2, Math.abs(az + eqe97))
  }
  const mas = 206264806.247
  console.log('  ' + fx.frames.length + ' 个时刻（2000–2033）：极轴方向差 ' + (wxy * mas).toFixed(3) + ' mas，绕极轴 ' + (wz * mas).toFixed(3) + ' mas，补上 1997 两项后 ' + (wz2 * mas).toFixed(3) + ' mas')
  ok(wxy * mas < 0.05, '极轴方向一致（< 0.05 mas）', String(wxy * mas))
  ok(wz * mas < 3, '绕极轴只差 frames.js 省略的时差方程两小项（< 3 mas）', String(wz * mas))
  ok(wz2 * mas < 0.05, '补上这两项后绕极轴也一致（< 0.05 mas）', String(wz2 * mas))
}

console.log('\npropGravity: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
