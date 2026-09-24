// 解析高斯天线（STK Gaussian，*.gauss.json）自测。运行：node packages/core/test/gaussStk.test.mjs
//
// 锁六件事：
//   a. STK 官方读数（调研 §6.2 #1–#8）：三驱动求解、离轴增益、−L dB 半角、GEO 天底 −3 dB 足迹（锥 ∩ WGS-84）；
//   b. 渲染端 ESM（src/viz/grd/gaussStk.js）与主进程 CJS 镜像（packages/core/utils/gaussStk.js）逐位一致；
//   c. 记录 → 存盘文本（纯 ASCII）→ 记录，中文名 / 四字节字符原样往返；
//   d. 主进程 .grdbin 路径（buildBin → loadBin → sampleBeamAt / sampleMax）= 独立算出的闭式增益（1e-9 dB），三种指向 + LEO + 多波束；
//   e. peakDb 取精确 g0、窗口外 null、pol 'P2' null、XPD / 共极化判定与合成高斯 GRD 同口径；
//   f. coverage 服务：save 保留 .gauss.json + 去重、overwrite 只许 saveDir 里已有的 .gauss.json（防穿越）、exportSrc 标记。
import * as E from '../../../src/viz/grd/gaussStk.js'
import { antennaBasis, antennaBasisAzEl, invGridDir, gridDir } from '../../../src/viz/grd/coverage.js'
import { geodeticToEcef, ecefToGeodetic, geodeticUp, rayEllipsoid, A as WGS_A, RS_GEO } from '../../../src/viz/wgs84.js'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'

const require = createRequire(import.meta.url)
const C = require('../utils/gaussStk.js')
const S = require('../utils/grdSampler.js')
const createCoverage = require('../../../electron/services/coverage.js')
const createGrd = require('../../../electron/services/grd.js')

let pass = 0, fail = 0
const ok = (m, c, extra = '') => { if (c) { pass++; console.log('PASS  ' + m + (extra ? '  ' + extra : '')) } else { fail++; console.log('FAIL  ' + m + (extra ? '  ' + extra : '')) } }
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol
const D2R = Math.PI / 180
const H = RS_GEO - WGS_A
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l] }
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const bytesEq = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength))

// ─────────────── a. STK 官方读数 ───────────────
{
  const m1 = E.solveStk({ fGHz: 14.5, drv: 'D', D: 1, eff: 55 })
  ok('#1 14.5 GHz / 1 m / 55%：G = 12698.63479991', m1.ok && near(m1.g0Lin, 12698.63479991, 1e-8), `${m1.g0Lin}`)
  ok('#1 G = 41.03757033 dBi', near(m1.g0Dbi, 41.03757033, 1e-8), `${m1.g0Dbi}`)
  ok('#1 θ3 = 0.0278786254 rad = 1.59732757°', near(m1.th3Rad, 0.0278786254, 1e-10) && near(m1.th3Deg, 1.59732757, 1e-8), `${m1.th3Rad} / ${m1.th3Deg}`)
  ok('#1 恒等式 G0·θ3² = π²', near(m1.g0Lin * m1.th3Rad ** 2, Math.PI ** 2, 1e-12))
  const an1 = E.anBeamOf({ az: 0, el: 0, th3: m1.th3Deg, g0: m1.g0Dbi, k: 'stk', back: -30 })
  const offAxis = (an, deg) => E.anGainDbi(an, Math.sin(deg * D2R), 0, Math.cos(deg * D2R))
  const v2 = [[1, 36.33965250], [2, 22.24589900], [3, -1.24369016], [25, -2895.16107527]]
  for (const [d, want] of v2) { const g = offAxis(an1, d); ok(`#2 离轴 ${d}° = ${want} dBi`, near(g, want, 1e-8), `${g}`) }
  ok('#2 背瓣：θ > 90° 取常数 −30 dBi，θ = 90° 仍是高斯', offAxis(an1, 90.001) === -30 && offAxis(an1, 179) === -30 && offAxis(an1, 89.999) < -30)
  ok('anGainDbiXY = anGainDbi(dir6)', [[0.4, -0.3], [1.1, 0.9], [-2, 0.2]].every(([X, Y]) => { const d = gridDir(6, X, Y); return E.anGainDbiXY(an1, X, Y) === E.anGainDbi(an1, d[0], d[1], d[2]) }))

  const m3 = E.solveStk({ fGHz: 12, drv: 'D', D: 1, eff: 55 })
  ok('#3 12 GHz：λ = 0.0249827048 m', near(m3.lamM, 0.0249827048, 1e-10), `${m3.lamM}`)
  ok('#3 G = 8697.28138496（39.39383521 dBi）', near(m3.g0Lin, 8697.28138496, 1e-8) && near(m3.g0Dbi, 39.39383521, 1e-8), `${m3.g0Lin} / ${m3.g0Dbi}`)
  ok('#3 θ3 = 0.0336866723 rad = 1.93010415°', near(m3.th3Rad, 0.0336866723, 1e-10) && near(m3.th3Deg, 1.93010415, 1e-8), `${m3.th3Rad} / ${m3.th3Deg}`)
  const an3 = E.anBeamOf({ az: 0, el: 0, th3: m3.th3Deg, g0: m3.g0Dbi, k: 'stk', back: -30 })
  const v4 = [[m3.th3Deg / 2, 36.39720329], [m3.th3Deg, 27.40730751], [0.5, 38.58943549], [1, 36.17623631], [2, 26.52343963]]
  for (const [d, want] of v4) { const g = offAxis(an3, d); ok(`#4 离轴 ${d.toFixed(6)}° = ${want} dBi`, near(g, want, 1e-8), `${g}`) }
  ok('#4 θ3/2 处降 2.99663 dB（STK 系数 2.76，不是 3.0103）', near(m3.g0Dbi - offAxis(an3, m3.th3Deg / 2), 2.996632, 1e-6))
  const v5 = [[3, 0.96559426], [6, 1.36555650], [10, 1.76292586]]
  for (const [L, want] of v5) {
    const h = m3.th3Deg * Math.sqrt(L / E.kDbOf('stk'))
    ok(`#5 −${L} dB 半角 = ${want}°，该角上增益恰降 ${L} dB`, near(h, want, 1e-8) && near(m3.g0Dbi - offAxis(an3, h), L, 1e-9), `${h}`)
  }
  const h4 = m3.th3Deg * Math.sqrt(3 / E.kDbOf('4ln2'))
  const an3b = E.anBeamOf({ az: 0, el: 0, th3: m3.th3Deg, g0: m3.g0Dbi, k: '4ln2', back: -30 })
  ok('#5 4ln2 下 −3 dB 半角 = 0.96339966°', near(h4, 0.96339966, 1e-8) && near(m3.g0Dbi - offAxis(an3b, h4), 3, 1e-9), `${h4}`)

  const m6 = E.solveStk({ fGHz: 12, drv: 'bw', bw3: 2, eff: 55 }), m6b = E.solveStk({ fGHz: 12, drv: 'bw', bw3: 2, eff: 72 })
  ok('#6 波束宽驱动 2°：G = 8100（39.08485019 dBi），D = 0.96505208 m', near(m6.g0Lin, 8100, 1e-8) && near(m6.g0Dbi, 39.08485019, 1e-8) && near(m6.Dm, 0.96505208, 1e-8), `${m6.g0Lin} / ${m6.Dm}`)
  ok('#6 G 与效率无关', m6b.g0Lin === m6.g0Lin)
  const m7 = E.solveStk({ fGHz: 12, drv: 'G', G: 40, eff: 55 })
  ok('#7 增益驱动 40 dBi：θ3 = π/100 rad = 1.8°，D = 1.07228008 m', near(m7.th3Rad, Math.PI / 100, 1e-15) && near(m7.th3Deg, 1.8, 1e-12) && near(m7.Dm, 1.07228008, 1e-8), `${m7.th3Deg} / ${m7.Dm}`)
  const sy = E.syncModel({ fGHz: 12, drv: 'G', G: 40, eff: 55, D: 9, bw3: 9 })
  ok('syncModel：驱动项原样，非驱动项 = 算出值', sy.G === 40 && sy.D === m7.Dm && sy.bw3 === m7.th3Deg)
  // promoteDrv（GaussModelFields 切输入量）：新驱动项圆到它刚才显示的位数（DRV_DIGITS），不再冒出 17 位浮点；另两项随之重算
  {
    const m0 = E.freshModel()
    const shown = (m, d) => { const r = E.solveStk(m); return d === 'D' ? +r.Dm.toFixed(E.DRV_DIGITS.D) : d === 'bw' ? +r.th3Deg.toFixed(E.DRV_DIGITS.bw) : +r.g0Dbi.toFixed(E.DRV_DIGITS.G) }
    const pb = E.promoteDrv(m0, 'bw')
    ok('promoteDrv D→bw：bw3 = 刚才显示的 1.5973（不是 1.5973275724744727）', pb.drv === 'bw' && pb.bw3 === 1.5973 && String(pb.bw3) === '1.5973' && pb.bw3 === shown(m0, 'bw'), `${pb.bw3}`)
    ok('promoteDrv D→bw：另两项随圆过的 θ3 重算，显示位上不动（D 仍显示 1、G 仍 41.04）', +pb.D.toFixed(4) === 1 && +pb.G.toFixed(2) === 41.04 && E.solveStk(pb).ok && pb.D === E.solveStk(pb).Dm, `D ${pb.D}`)
    const pg = E.promoteDrv(m0, 'G')
    ok('promoteDrv D→G：G = 41.04（2 位）', pg.drv === 'G' && pg.G === 41.04 && String(pg.G) === '41.04', `${pg.G}`)
    const pd = E.promoteDrv(pb, 'D')
    ok('promoteDrv bw→D：D 圆到 4 位 = 1', pd.drv === 'D' && pd.D === 1 && pd.bw3 === E.solveStk(pd).th3Deg, `${pd.D}`)
    ok('promoteDrv 不改入参', m0.drv === 'D' && m0.bw3 === E.STK_MODEL_DEFAULT.bw3 && pb.drv === 'bw')
    const huge = { ...m0, D: 1e5 }                                              // θ3 ≈ 1.6e-5°，圆到 4 位就成 0（非法）
    const ph = E.promoteDrv(huge, 'bw')
    ok('promoteDrv：圆完不再合法（极小 θ3 → 0）→ 保留原值', ph.drv === 'bw' && ph.bw3 > 0 && E.solveStk(ph).ok && ph.bw3 === E.solveStk(huge).th3Deg, `${ph.bw3}`)
    const bad = E.promoteDrv({ ...m0, eff: 0 }, 'G')
    ok('promoteDrv：模型本身非法（效率 0）→ 只换驱动、不抛', bad.drv === 'G' && bad.G === m0.G)
  }
  ok('非法输入报错不抛', !E.solveStk({ fGHz: 0, drv: 'D', D: 1, eff: 55 }).ok && !E.solveStk({ fGHz: 12, drv: 'D', D: 1, eff: 0 }).ok && !E.solveStk({ fGHz: 12, drv: 'G', G: 0, eff: 55 }).ok && !E.solveStk({ fGHz: 12, drv: 'bw', bw3: 180, eff: 55 }).ok)

  // #8 GEO 0°E（r = 42164.1696 km）天底，#1 天线的 −3 dB 圈 = 半角 0.79911249° 的锥 ∩ WGS-84
  const alpha = m1.th3Rad * Math.sqrt(3 / E.kDbOf('stk'))
  ok('#8 −3 dB 半角 = 0.79911249°', near(alpha / D2R, 0.79911249, 1e-8), `${alpha / D2R}`)
  const fp = E.coneFootprint([42164.1696, 0, 0], [-1, 0, 0], alpha)
  let north = -Infinity, east = -Infinity
  for (const [lon, lat] of fp.ring) { if (lat > north) north = lat; if (lon > east) east = lon }
  ok('#8 北点 4.521201461°N', near(north, 4.521201461, 1e-7), `${north.toFixed(10)}`)
  ok('#8 东点 4.490949444°E', near(east, 4.490949444, 1e-7), `${east.toFixed(10)}`)
  ok('#8 全部射线命中椭球、环闭合', fp.hits === fp.n && fp.ring[0][0] === fp.ring[fp.ring.length - 1][0] && fp.ring[0][1] === fp.ring[fp.ring.length - 1][1])
  // 环上每点的离轴角都恰是 α（锥面上），且确实落在地表
  let worstA = 0, worstH = 0
  for (const [lon, lat] of fp.ring) {
    const P = geodeticToEcef(lon, lat, 0), r = sub(P, [42164.1696, 0, 0])
    worstA = Math.max(worstA, Math.abs(Math.atan2(Math.hypot(...crs(r, [-1, 0, 0])), dot(r, [-1, 0, 0])) - alpha))
    worstH = Math.max(worstH, Math.abs(ecefToGeodetic(...P).h))
  }
  ok('#8 环上各点离轴角 = α（< 1e-12 rad）、落在椭球面上（|h| < 1e-6 km）', worstA < 1e-12 && worstH < 1e-6, `${worstA.toExponential(2)} rad / ${worstH.toExponential(2)} km`)
}

// ─────────────── b. ESM ↔ CJS 逐位一致 ───────────────
{
  const R = rng(20260924)
  const fields = ['igrid', 'az', 'el', 'th3', 'g0', 'back', 'k', 'bx', 'by', 'bz', 'inv', 'kdb', 'win']
  let badBeam = 0, badGain = 0, nGain = 0, badWin = 0, badMat = 0, nMat = 0
  const wins = [undefined, null, 2, 2.5, 1.2, 0]
  for (let t = 0; t < 60; t++) {
    const b = { az: (R() - 0.5) * 40, el: (R() - 0.5) * 40, th3: 0.05 + R() * 6, g0: 20 + R() * 30, k: R() < 0.5 ? 'stk' : '4ln2', back: -40 + R() * 20 }
    if (t % 7 === 0) { b.az = String(b.az); b.th3 = String(b.th3) }            // 记录里是数字串也得一样
    const w = wins[t % wins.length]
    const ae = E.anBeamOf(b, w), ac = C.anBeamOf(b, w)
    if (!fields.every((f) => Object.is(ae[f], ac[f]))) badBeam++
    const we = E.anWindow(ae), wc = C.anWindow(ac)
    if (!['XS', 'YS', 'XE', 'YE'].every((f) => Object.is(we[f], wc[f]))) badWin++
    for (let i = 0; i < 40; i++) {
      // 离轴角跨 1e-9 rad 到 180°：近轴 atan2 精度、主瓣、背瓣都走到
      const th = i === 0 ? 0 : i < 5 ? Math.pow(10, -9 + i) : R() * Math.PI, ph = R() * 2 * Math.PI
      const e1 = nrm(crs([ae.bx, ae.by, ae.bz], [0.3, 0.5, 0.8])), e2 = crs([ae.bx, ae.by, ae.bz], e1)
      const u = [0, 1, 2].map((k) => Math.cos(th) * [ae.bx, ae.by, ae.bz][k] + Math.sin(th) * (Math.cos(ph) * e1[k] + Math.sin(ph) * e2[k]))
      const sc = 0.5 + R()                                                    // 非单位长的入参也照算
      nGain++
      if (!Object.is(E.anGainDbi(ae, u[0] * sc, u[1] * sc, u[2] * sc), C.anGainDbi(ac, u[0] * sc, u[1] * sc, u[2] * sc))) badGain++
    }
    if (t < 12) {
      const res = [101, 61, 23][t % 3]
      const me = E.materializeBeam(ae, res), mc = C.materializeBeam(ac, res)
      nMat++
      if (!(bytesEq(me.c1re, mc.c1re) && ['XS', 'YS', 'XE', 'YE', 'NX', 'NY'].every((f) => Object.is(me[f], mc[f])) && mc.c1im.every((v) => v === 0) && mc.c2re.every((v) => v === 0) && mc.c2im.every((v) => v === 0))) badMat++
    }
  }
  ok('anBeamOf 各字段逐位一致（60 组，含数字串 / 各种 win）', badBeam === 0, `不一致 ${badBeam}`)
  ok(`anGainDbi 逐位一致（${nGain} 个方向，含近轴 / 背瓣 / 非单位长）`, badGain === 0 && nGain >= 2000, `不一致 ${badGain}`)
  ok('anWindow 逐位一致', badWin === 0, `不一致 ${badWin}`)
  ok(`materializeBeam 网格与 c1re 逐位一致（${nMat} 个波束，复场其余三条恒 0）`, badMat === 0, `不一致 ${badMat}`)
  let badRes = 0
  for (let n = 0; n <= 3000; n++) if (E.resFor(n) !== C.resFor(n)) badRes++
  ok('resFor 逐档一致（0–3000 波束）', badRes === 0)
  ok('kDbOf 一致', E.kDbOf('stk') === C.kDbOf('stk') && E.kDbOf('4ln2') === C.kDbOf('4ln2') && E.kDbOf(undefined) === C.kDbOf(undefined))
  ok('AN_FORMAT / AN_WIN 一致', E.AN_FORMAT === C.AN_FORMAT && E.AN_WIN === C.AN_WIN)

  // 窗口必须罩住半径 win·θ3 的整个锥（取值域 = 这个窗口；罩不住就会把锥内的点判成域外）
  let miss = 0, tried = 0
  for (let t = 0; t < 400; t++) {
    const an = E.anBeamOf({ az: (R() - 0.5) * 60, el: (R() - 0.5) * 60, th3: 0.05 + R() * 8, g0: 30, back: -30 })
    const w = E.anWindow(an), Rr = an.win * an.th3 * D2R * (1 - 1e-9)
    const b = [an.bx, an.by, an.bz], e1 = nrm(crs(b, [0.2, 0.7, 0.1])), e2 = crs(b, e1)
    for (let i = 0; i < 64; i++) {
      const ph = i / 64 * 2 * Math.PI
      const u = [0, 1, 2].map((k) => Math.cos(Rr) * b[k] + Math.sin(Rr) * (Math.cos(ph) * e1[k] + Math.sin(ph) * e2[k]))
      const xy = invGridDir(6, u[0], u[1], u[2]); if (!xy) continue          // 天线背面：采样器本就 null
      tried++
      if (xy[0] < w.XS || xy[0] > w.XE || xy[1] < w.YS || xy[1] > w.YE) miss++
    }
  }
  ok(`anWindow 罩住 win·θ3 锥（${tried} 个锥边方向）`, miss === 0 && tried > 20000, `漏 ${miss}`)

  // 整份记录：ESM materialize ↔ CJS materializeText
  const rec = E.buildRecord({
    sat: { name: 'T', lon: 100, lat: 0, altKm: 35786 },
    models: [{ id: 'a', fGHz: 14.5, drv: 'D', D: 1, eff: 55, back: -30, k: 'stk' }, { id: 'b', fGHz: 20, drv: 'bw', bw3: 0.6, eff: 60, back: -25, k: '4ln2' }],
    beams: Array.from({ length: 7 }, (_, i) => ({ name: 'B' + i, az: -2 + i * 0.6, el: 1 - i * 0.3, model: i % 2 ? 'b' : 'a' }))
  })
  const ge = E.materialize(rec), gc = C.materializeText(E.recordToText(rec))
  ok('整份记录铺网格：ESM materialize ≡ CJS materializeText（分辨率 / 窗口 / 节点值）',
    ge.nset === gc.nset && gc.igrid === 6 && gc.icomp === 3 && gc.ncomp === 2 && ge.sets.every((s, i) => bytesEq(s.c1re, gc.sets[i].c1re) && s.NX === gc.sets[i].NX && s.XS === gc.sets[i].XS && s.YE === gc.sets[i].YE))
  ok('isAnalyticText 两边一致', [E.recordToText(rec), '  \r\n' + E.recordToText(rec), 'x\r\n++++\r\n1', '{"a":1}', '', null].every((t) => E.isAnalyticText(t) === C.isAnalyticText(t)))
}

// ─────────────── c. 记录 ↔ 存盘文本 ───────────────
const MODELS2 = [
  { id: 'm1', name: 'Ku 下行（STK 默认）', fGHz: 14.5, drv: 'D', D: 1, eff: 55, back: -30, k: 'stk' },
  { id: 'm2', name: '点波束 🛰 窄', fGHz: 12, drv: 'bw', bw3: 0.9, eff: 60, back: -25, k: '4ln2' }
]
const BEAMS3 = [
  { name: '华北', az: 0.3, el: 0.8, model: 'm1' },
  { name: '华南', az: -0.5, el: -0.6, model: 'm2' },
  { name: '东海', az: 1.1, el: -0.2, model: 'm2' }
]
{
  const rec = E.buildRecord({ sat: { name: '中星26号', lon: 125, lat: 0, altKm: 35786 }, models: MODELS2, beams: BEAMS3, owner: { kind: 'beamsynth', groupId: '组-甲' } })
  const text = E.recordToText(rec)
  ok('存盘文本纯 ASCII（可见字符）', /^[\x20-\x7e]*$/.test(text))
  ok('latin1 逐字节往返不变', Buffer.from(text, 'latin1').toString('latin1') === text)
  const back = E.parseRecord(Buffer.from(text, 'latin1').toString('latin1'))
  ok('parseRecord 还原记录（中文 / 四字节字符原样）', JSON.stringify(back) === JSON.stringify(rec) && back.sat.name === '中星26号' && back.models[1].name === '点波束 🛰 窄' && back.owner.groupId === '组-甲' && back.beams[0].name === '华北')
  ok('CJS parseRecord 同结果', JSON.stringify(C.parseRecord(text)) === JSON.stringify(rec))
  ok('isAnalyticText：记录真、GRD 文本假', E.isAnalyticText(text) && C.isAnalyticText(text) && !C.isAnalyticText(E.toGrdText(rec)))
  const bad = [
    '{"format":"other","beams":[{}]}',
    JSON.stringify({ format: E.AN_FORMAT, beams: [] }),
    JSON.stringify({ format: E.AN_FORMAT, beams: [{ az: 0, el: 0, th3: 0, g0: 30, back: -30 }] }),
    JSON.stringify({ format: E.AN_FORMAT, beams: [{ az: 0, el: 'x', th3: 1, g0: 30, back: -30 }] })
  ]
  ok('坏记录两边都抛错', bad.every((t) => { let a = false, b = false; try { E.parseRecord(t) } catch { a = true } try { C.parseRecord(t) } catch { b = true } return a && b }))
  ok('buildRecord：逐波束已解析量 = solveStk', rec.beams[0].th3 === E.solveStk(MODELS2[0]).th3Deg && rec.beams[1].g0 === E.solveStk(MODELS2[1]).g0Dbi && rec.beams[1].k === '4ln2' && rec.beams[2].back === -25)
}

// ─────────────── d. 主进程 .grdbin 路径 = 独立闭式 ───────────────
// 独立算法：ESM WGS-84 + ESM 天线基底 + 方向进天线系 + ESM anGainDbi；域 = 各波束窗口（与渲染端 sampleBeamAtParam 同一判据）
function exactAt(rec, basis, lon, lat, hT = 0) {
  const P = geodeticToEcef(lon, lat, hT), r = sub(P, basis.S), rs = Math.hypot(...r), e = [r[0] / rs, r[1] / rs, r[2] / rs]
  if (!hT && dot(e, geodeticUp(lon, lat)) > 0) return { vis: false, per: rec.beams.map(() => null), max: null, edge: false }
  const a = dot(e, basis.x), b = dot(e, basis.y), c = dot(e, basis.z)
  const xy = invGridDir(6, a, b, c)
  let max = null, edge = false
  const per = rec.beams.map((bm) => {
    if (!xy) return null
    const an = E.anBeamOf(bm, rec.win), w = E.anWindow(an)
    const m = Math.min(xy[0] - w.XS, w.XE - xy[0], xy[1] - w.YS, w.YE - xy[1])
    if (Math.abs(m) < 1e-7) edge = true                                      // 贴窗边的点不拿来比（判据两边舍入可能不同）
    if (m < 0) return null
    const g = E.anGainDbi(an, a, b, c)
    if (max === null || g > max) max = g
    return g
  })
  return { vis: true, per, max, edge, rs }
}
// 在第 i 个波束视轴周围按离轴 ρ·θ3、方位 φ 打射线落地 → [lon, lat, ρ]
function ringPoints(rec, basis, i, rhos, nphi = 8) {
  const an = E.anBeamOf(rec.beams[i], rec.win), th = an.th3 * D2R
  const ax = nrm([0, 1, 2].map((k) => basis.x[k] * an.bx + basis.y[k] * an.by + basis.z[k] * an.bz))
  const e1 = nrm(crs(ax, [0, 0, 1])), e2 = crs(ax, e1)
  const out = []
  for (const rho of rhos) {
    for (let j = 0; j < (rho ? nphi : 1); j++) {
      const ph = 0.3 + j * 2 * Math.PI / nphi, a = rho * th
      const u = [0, 1, 2].map((k) => Math.cos(a) * ax[k] + Math.sin(a) * (Math.cos(ph) * e1[k] + Math.sin(ph) * e2[k]))
      const hit = rayEllipsoid(basis.S, u); if (!hit) continue
      const g = ecefToGeodetic(...hit)
      out.push([g.lon, g.lat, rho])
    }
  }
  return out
}
function checkSampler(label, rec, sat, cfg, basis, pts, closedForm) {
  const loaded = S.loadBin(S.buildBin(E.recordToText(rec)))
  const ctx = S.makeSampleCtx(loaded, sat, cfg)
  let worst = 0, worstMax = 0, worstCf = 0, nCmp = 0, badNull = 0, badRound = 0, badAll = 0
  for (const [lon, lat, rho] of pts) {
    const ex = exactAt(rec, basis, lon, lat)
    if (ex.edge) continue
    const per = ctx.beams.map((bm) => S.sampleBeamAt(bm, ctx.igrid, ctx.basis, lon, lat, ctx.par))
    for (let i = 0; i < per.length; i++) {
      if ((per[i] == null) !== (ex.per[i] == null)) { badNull++; continue }
      if (per[i] != null) { worst = Math.max(worst, Math.abs(per[i] - ex.per[i])); nCmp++ }
    }
    const mx = per.reduce((m, v) => (v == null ? m : m == null || v > m ? v : m), null)
    if ((mx == null) !== (ex.max == null)) badNull++
    else if (mx != null) worstMax = Math.max(worstMax, Math.abs(mx - ex.max))
    const sm = S.sampleMax(loaded, sat, cfg, lon, lat)
    if ((sm == null) !== (ex.max == null) || (sm != null && !(Math.abs(sm - ex.max) <= 0.005 + 1e-9))) badRound++
    const sa = S.sampleAll(loaded, sat, cfg, lon, lat)
    if (sa.values.some((v, i) => (v == null) !== (ex.per[i] == null) || (v != null && !(Math.abs(v - ex.per[i]) <= 0.005 + 1e-9)))) badAll++
    if (closedForm && rho != null && ex.max != null) {
      const an = E.anBeamOf(rec.beams[0], rec.win)
      worstCf = Math.max(worstCf, Math.abs(per[0] - (an.g0 - an.kdb * rho * rho)))
    }
  }
  ok(`${label}：sampleBeamAt = 独立闭式（${nCmp} 个值，1e-9 dB）`, badNull === 0 && worst <= 1e-9 && nCmp > 20, `最大差 ${worst.toExponential(2)} dB，域判不一致 ${badNull}`)
  ok(`${label}：多波束取最大 = 独立 max（1e-9 dB）`, worstMax <= 1e-9, `${worstMax.toExponential(2)}`)
  ok(`${label}：sampleMax / sampleAll 取整到 0.01 dB 后与闭式一致`, badRound === 0 && badAll === 0, `sampleMax 不一致 ${badRound}，sampleAll 不一致 ${badAll}`)
  if (closedForm) ok(`${label}：射线在 ρ·θ3 离轴处落地 → 采样 = g0 − kdb·ρ²（1e-9 dB）`, worstCf <= 1e-9, `${worstCf.toExponential(2)}`)
  return loaded
}
{
  const satLon = 110.5, sat = { lon: satLon, lat: 0, alt: H }
  const model = E.freshModel({ id: 'm' })
  const one = (az, el, extra = {}) => E.buildRecord({ sat: { name: 'G', lon: satLon, lat: 0, altKm: H }, models: [model], beams: [{ name: 'b', az, el, model: 'm' }], ...extra })
  const rhos = [0, 0.1, 0.35, 0.5, 0.9, 1.3, 1.8]
  // ① azel 天底
  {
    const rec = one(0, 0), cfg = { boreType: 'azel', boreAz: 0, boreEl: 0, yaw: 0 }
    const basis = antennaBasisAzEl(satLon, 0, H, 0, 0, 0)
    const loaded = checkSampler('azel 天底', rec, sat, cfg, basis, ringPoints(rec, basis, 0, rhos), true)
    const g = E.materialize(rec).sets[0]
    ok('.grdbin 数组 ≡ 渲染端铺的网格（c1re 逐位、窗口逐位）', bytesEq(loaded.beams[0].c1re, g.c1re) && ['XS', 'YS', 'XE', 'YE', 'NX', 'NY'].every((f) => loaded.beams[0].grid[f] === g[f]))
    ok('loadBin 还原 an（字段逐位 = anBeamOf(记录)）', Object.keys(E.anBeamOf(rec.beams[0], rec.win)).every((f) => Object.is(loaded.beams[0].an[f], E.anBeamOf(rec.beams[0], rec.win)[f])) && loaded.igrid === 6 && loaded.icomp === 3 && loaded.ncomp === 2)
  }
  // ② azel 偏置（boreAz 1.2 / boreEl −0.7 / yaw 20），波束本身也偏在天线系里
  {
    const rec = one(0.6, -0.4), cfg = { boreType: 'azel', boreAz: 1.2, boreEl: -0.7, yaw: 20 }
    const basis = antennaBasisAzEl(satLon, 0, H, 1.2, -0.7, 20)
    checkSampler('azel 偏置 + yaw', rec, sat, cfg, basis, ringPoints(rec, basis, 0, rhos), true)
  }
  // ③ geo 目标点（boresight 对准 115°E / 30°N，yaw −15）
  {
    const rec = one(-0.3, 0.5), cfg = { boreType: 'geo', boreLon: 115, boreLat: 30, yaw: -15 }
    const basis = antennaBasis(satLon, 115, 30, -15, 0, H)
    checkSampler('geo 目标点', rec, sat, cfg, basis, ringPoints(rec, basis, 0, rhos), true)
  }
  // ④ LEO 大偏轴宽波束（旧「天底 az/el 网格里算 Δ」的模型误差在这里最大；闭式按波束自身视轴，照样精确）
  {
    const lsat = { lon: 30, lat: 20, alt: 550 }
    const rec = E.buildRecord({ sat: { name: 'L', lon: 30, lat: 20, altKm: 550 }, models: [{ id: 'w', fGHz: 12, drv: 'bw', bw3: 5, eff: 55, back: -20, k: 'stk' }], beams: [{ name: 'w', az: 15, el: -10, model: 'w' }] })
    const cfg = { boreType: 'azel', boreAz: 5, boreEl: 3, yaw: 40 }
    const basis = antennaBasisAzEl(30, 20, 550, 5, 3, 40)
    checkSampler('LEO 550 km 偏轴 15°/−10° 宽波束', rec, lsat, cfg, basis, ringPoints(rec, basis, 0, rhos, 12), true)
  }
  // ⑤ STK #9：GEO 0°E 视轴对准 (30°N, 10°E)，取 (32°N, 12°E) → 离轴 0.37000727°、斜距 37038.3596 km、G = 40.39440013 dBi
  {
    const s9 = { lon: 0, lat: 0, alt: 42164.1696 - WGS_A }
    const rec = E.buildRecord({ sat: null, models: [E.freshModel({ id: 'm' })], beams: [{ name: '9', az: 0, el: 0, model: 'm' }] })
    const cfg = { boreType: 'geo', boreLon: 10, boreLat: 30 }
    const loaded = S.loadBin(S.buildBin(E.recordToText(rec)))
    const ctx = S.makeSampleCtx(loaded, s9, cfg)
    const v = S.sampleBeamAt(ctx.beams[0], ctx.igrid, ctx.basis, 12, 32, ctx.par)
    const basis = antennaBasis(0, 10, 30, 0, 0, s9.alt), r = sub(geodeticToEcef(12, 32, 0), basis.S)
    const off = Math.atan2(Math.hypot(...crs(r, basis.z)), dot(r, basis.z)) / D2R
    ok('STK #9 离轴 0.37000727°、斜距 37038.3596 km', near(off, 0.37000727, 1e-8) && near(Math.hypot(...r), 37038.3596, 1e-4), `${off} / ${Math.hypot(...r)}`)
    ok('STK #9 主进程采样 = 40.39440013 dBi', near(v, 40.39440013, 1e-8), `${v}`)
    ok('STK #9 sampleMax 取整 = 40.39', S.sampleMax(loaded, s9, cfg, 12, 32) === 40.39)
  }
  // ⑥ 多波束：3 个波束 / 2 个模型（一个 4ln2），sampleMax = 各波束取最大
  {
    const rec = E.buildRecord({ sat: { name: 'M', lon: satLon, lat: 0, altKm: H }, models: MODELS2, beams: BEAMS3 })
    const cfg = { boreType: 'azel', boreAz: 0.4, boreEl: 0.2, yaw: 7 }
    const basis = antennaBasisAzEl(satLon, 0, H, 0.4, 0.2, 7)
    const pts = [...ringPoints(rec, basis, 0, [0, 0.4, 0.9, 1.5]), ...ringPoints(rec, basis, 1, [0, 0.5, 1.2, 1.9]), ...ringPoints(rec, basis, 2, [0, 0.7, 1.6])]
    for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) pts.push([satLon - 6 + i * 0.3, -8 + j * 0.4, null])   // 再铺一张覆盖区网格（含多波束交叠 / 全在域外）
    const loaded = checkSampler('多波束（3 波束 / 2 模型，含 4ln2）', rec, sat, cfg, basis, pts, false)
    ok('多波束 loadBin：每个波束各带 an、k 与记录一致', loaded.beams.length === 3 && loaded.beams.every((b, i) => b.an && b.an.k === rec.beams[i].k && b.an.g0 === rec.beams[i].g0))
    const sa = S.sampleAll(loaded, sat, { ...cfg, keptSets: [0, 2] }, ...ringPoints(rec, basis, 2, [0])[0].slice(0, 2))
    ok('keptSets 裁波束：beamIdx = [0, 2]', JSON.stringify(sa.beamIdx) === '[0,2]' && sa.values.length === 2)

    // e. 峰值 / 域外 / 极化
    const g0max = Math.max(...rec.beams.map((b) => b.g0))
    ok('peakDb = 各波束 g0 的最大值（精确相等，不取节点）', S.peakDb(loaded, {}) === g0max, `${S.peakDb(loaded, {})} vs ${g0max}`)
    ok('peakDb 认 keptSets', S.peakDb(loaded, { keptSets: [1] }) === rec.beams[1].g0 && S.peakDb(loaded, { keptSets: [0, 2] }) === Math.max(rec.beams[0].g0, rec.beams[2].g0))
    ok('peakDb 叠 gainOffset', S.peakDb(loaded, { gainOffset: 1.5 }) === g0max + 1.5)
    ok('peakDb：pol P1 有值，P2 / P1/P2 / P2/P1 取不到（交叉极化恒 0，与合成高斯 GRD 同口径）',
      S.peakDb(loaded, { pol: 'P1' }) === g0max && [ 'P2', 'P1/P2', 'P2/P1' ].every((p) => S.peakDb(loaded, { pol: p }) === null))
    const hot = ringPoints(rec, basis, 0, [0])[0]
    ok('sampleMax：pol P2 → null，P1 = RSS', S.sampleMax(loaded, sat, { ...cfg, pol: 'P2' }, hot[0], hot[1]) === null
      && S.sampleMax(loaded, sat, { ...cfg, pol: 'P1' }, hot[0], hot[1]) === S.sampleMax(loaded, sat, cfg, hot[0], hot[1]))
    ok('sampleMax 在视轴上 = g0 取整', S.sampleMax(loaded, sat, cfg, hot[0], hot[1]) === +rec.beams[0].g0.toFixed(2))
    ok('sampleXpd → null（交叉极化 0），coPolIndexOf = 1', S.sampleXpd(loaded, sat, cfg, hot[0], hot[1]) === null && loaded.beams.every((b) => S.coPolIndexOf(b) === 1))
  }
  // e. 窗口外 → null（单波束，沿网格 X 轴走出窗口边）
  {
    const rec = one(0.2, -0.3), cfg = { boreType: 'azel', boreAz: 0, boreEl: 0, yaw: 0 }
    const basis = antennaBasisAzEl(satLon, 0, H, 0, 0, 0)
    const loaded = S.loadBin(S.buildBin(E.recordToText(rec)))
    const an = loaded.beams[0].an, w = E.anWindow(an)
    const at = (X, Y) => {
      const d = gridDir(6, X, Y)
      const u = [0, 1, 2].map((k) => basis.x[k] * d[0] + basis.y[k] * d[1] + basis.z[k] * d[2])
      const g = ecefToGeodetic(...rayEllipsoid(basis.S, u))
      return S.sampleMax(loaded, sat, cfg, g.lon, g.lat)
    }
    const inside = at(w.XE - 0.005, an.el), out = at(w.XE + 0.005, an.el), outY = at(an.az, w.YS - 0.005)
    ok('窗口内侧有值（≈ g0 − kdb·win²）、X 向 / Y 向出窗口 → null', inside != null && Math.abs(inside - (an.g0 - an.kdb * 4)) < 0.2 && out === null && outY === null, `${inside} / ${out} / ${outY}`)
    // win 非缺省：窗口随之放大，loadBin 还原的 an.win 跟记录走
    const rec25 = one(0.2, -0.3, { win: 2.5 }), l25 = S.loadBin(S.buildBin(E.recordToText(rec25)))
    ok('win = 2.5：anWin 进表头、窗口放大', l25.beams[0].an.win === 2.5 && l25.beams[0].grid.XE - l25.beams[0].grid.XS > loaded.beams[0].grid.XE - loaded.beams[0].grid.XS)
  }
  // 旧 .grdbin（无 an）照旧载入、走 bicubic；同一记录导出的 GRASP 文本与闭式只差网格插值误差
  {
    const rec = one(0, 0), cfg = { boreType: 'azel' }
    const lg = S.loadBin(S.buildBin(E.toGrdText(rec))), la = S.loadBin(S.buildBin(E.recordToText(rec)))
    const basis = antennaBasisAzEl(satLon, 0, H, 0, 0, 0)
    let worst = 0
    for (const [lon, lat] of ringPoints(rec, basis, 0, [0, 0.3, 0.6, 1, 1.3])) {
      const a = S.sampleBeamAt(la.beams[0], 6, S.makeSampleCtx(la, sat, cfg).basis, lon, lat, { pol: 'RSS' })
      const b = S.sampleBeamAt(lg.beams[0], 6, S.makeSampleCtx(lg, sat, cfg).basis, lon, lat, { pol: 'RSS' })
      worst = Math.max(worst, Math.abs(a - b))
    }
    ok('无 an 的 .grdbin 照旧载入（没有 an 字段）', lg.beams.length === 1 && lg.beams[0].an === undefined && lg.igrid === 6)
    ok('toGrdText 导出件（bicubic）与闭式差 < 2e-3 dB（1.3θ3 内，res 101）', worst < 2e-3, `${worst.toExponential(2)} dB`)
    ok('无 an 的 peakDb 仍取节点最大值（≈ g0）', Math.abs(S.peakDb(lg, {}) - rec.beams[0].g0) < 1e-5)
  }
}

// ─────────────── f. coverage 服务：存盘 / 改写 / 导出 ───────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gaussStk-'))
  const saveDir = path.join(root, 'coverage-grd-imported')
  const cov = createCoverage(root, saveDir)
  const grd = createGrd(saveDir)
  try {
    const mk = (g) => E.recordToText(E.buildRecord({ sat: { name: '星', lon: 110.5, lat: 0, altKm: H }, models: [E.freshModel({ id: 'm', name: '模型', drv: 'G', G: g })], beams: [{ name: '波束', az: 0, el: 0, model: 'm' }] }))
    const t1 = mk(40), t2 = mk(43)
    const f1 = cov.save('Ku beams.gauss.json', t1).file, f2 = cov.save('Ku beams.gauss.json', t1).file, f3 = cov.save('Ku beams.gauss.json', t1).file
    ok('save 保留 .gauss.json、基名同样清洗、同名去重 _2 / _3', f1 === 'Ku_beams.gauss.json' && f2 === 'Ku_beams_2.gauss.json' && f3 === 'Ku_beams_3.gauss.json', `${f1} ${f2} ${f3}`)
    ok('save：大写后缀归一、首尾的点削掉（不拼出 x..gauss.json）', cov.save('A.GAUSS.JSON', t1).file === 'A.gauss.json' && cov.save('x..gauss.json', t1).file === 'x.gauss.json' && cov.save('.gauss.json', t1).file === 'imported.gauss.json')
    ok('save：.grd 行为不变', cov.save('foo.grd', E.toGrdText(E.parseRecord(t1))).file === 'foo.grd')
    let threw = false; try { cov.save('bad.gauss.json', 'not json') } catch { threw = true }
    ok('save：坏记录抛错、不落盘', threw && !fs.existsSync(path.join(saveDir, 'bad.gauss.json')))
    const utfRec = E.parseRecord(t1); utfRec.models[0].name = '模型 🛰 α'
    const utf = JSON.stringify(utfRec)                                     // 带中文 / 四字节字符的非 ASCII 文本
    const fu = cov.save('utf.gauss.json', utf).file
    const onDisk = fs.readFileSync(path.join(saveDir, fu))
    const rb = E.parseRecord(cov.raw(fu).text)
    ok('save：非 ASCII 转 \\uXXXX 落盘，读回中文 / 四字节字符不乱码', onDisk.every((b) => b < 0x80) && rb.sat.name === '星' && rb.models[0].name === '模型 🛰 α' && JSON.stringify(rb) === utf)
    ok('save 的转义与渲染端 recordToText 逐字相同', fs.readFileSync(path.join(saveDir, fu), 'latin1') === E.recordToText(utfRec))
    ok('raw 读回 = 原文', cov.raw(f1).text === t1)

    // 主进程取值：ensureBin → buildBin（解析分支）→ 闭式
    const sat = { lon: 110.5, lat: 0 }, cfg = { boreType: 'azel' }
    const basis = antennaBasisAzEl(110.5, 0, H, 0, 0, 0)
    const rec1 = E.parseRecord(t1), pts = ringPoints(rec1, basis, 0, [0, 0.5, 1]).map(([lon, lat]) => ({ lon, lat }))
    const want = (rec) => pts.map((p) => +exactAt(rec, basis, p.lon, p.lat).max.toFixed(2))
    ok('grd.sample 走 .grdbin 解析分支 = 闭式取整', JSON.stringify(grd.sample({ file: f1, sat, cfg, points: pts })) === JSON.stringify(want(rec1)))
    ok('.grdbin 已生成', fs.existsSync(path.join(saveDir, f1 + '.grdbin')))
    const nm = grd.ngsoSampler(f1, cfg, 0)
    ok('ngsoSampler 峰值 = g0（精确）', nm.peakDbi === rec1.beams[0].g0)
    const mt = grd.meta(f1)
    ok('grd.meta：1 波束、igrid 6', mt.ok && mt.beams === 1 && mt.igrid === 6)

    // overwrite：原地改参数 → 旧 .grdbin 当场删掉 → 下次取值按新参数
    const r = cov.overwrite(f1, t2)
    ok('overwrite 成功、内容已换、不留 .tmp、旧 .grdbin 已删', r.file === f1 && cov.raw(f1).text === t2 && !fs.existsSync(path.join(saveDir, f1 + '.tmp')) && !fs.existsSync(path.join(saveDir, f1 + '.grdbin')))
    ok('overwrite 后 grd.sample 反映新参数', JSON.stringify(grd.sample({ file: f1, sat, cfg, points: pts })) === JSON.stringify(want(E.parseRecord(t2))))
    const outside = path.join(root, 'outside.gauss.json'); fs.writeFileSync(outside, t1, 'latin1')
    fs.mkdirSync(path.join(saveDir, 'sub'), { recursive: true }); fs.writeFileSync(path.join(saveDir, 'sub', 'x.gauss.json'), t1, 'latin1')
    const rejects = (f, t = t2) => { try { cov.overwrite(f, t); return false } catch { return true } }
    ok('overwrite 拒：不存在的文件', rejects('nope.gauss.json'))
    ok('overwrite 拒：非 .gauss.json（.grd）', rejects('foo.grd') && cov.raw('foo.grd').text.includes('++++'))
    ok('overwrite 拒：../ 穿越、绝对路径、子目录', rejects('../outside.gauss.json') && rejects(outside) && rejects(outside.replace(/\\/g, '/')) && rejects('sub/x.gauss.json') && rejects('..\\outside.gauss.json'))
    ok('overwrite 拒：坏记录，原文件不动', rejects(f2, '{"format":"x"}') && cov.raw(f2).text === t1)
    ok('被拒的改写一个字节都没动到 saveDir 外 / 子目录', fs.readFileSync(outside, 'latin1') === t1 && fs.readFileSync(path.join(saveDir, 'sub', 'x.gauss.json'), 'latin1') === t1)

    const ex = cov.exportSrc(f1), eg = cov.exportSrc('foo.grd')
    ok('exportSrc：.gauss.json → { synth:true, analytic:true }；.grd 合成件 → synth 无 analytic', ex.synth === true && ex.analytic === true && ex.path === path.join(saveDir, f1) && eg.synth === true && !eg.analytic)
    let gone = false; try { cov.exportSrc('missing.gauss.json') } catch (e) { gone = e.code === 'ENOENT' }
    ok('exportSrc：文件不在照旧抛 ENOENT', gone)
    const src = path.join(root, 'picked.gauss.json'); fs.writeFileSync(src, t1, 'latin1')
    ok('copyIn：.gauss.json 保留后缀', cov.copyIn(src).file === 'picked.gauss.json')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
