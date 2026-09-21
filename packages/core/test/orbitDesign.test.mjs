// 轨道向导求解器的回归网（src/viz/constellation/orbitDesign.js）。
//
// 【判据分两层】
//   ① 任务书附录 E 的全部测试向量（太阳同步 h→i 七档、地球同步半长轴与星下点、Molniya、
//      临界倾角太阳同步、Landsat-8 回归比、LTAN 反解）——外部可查的定值；
//   ② 闭环：design → params → generateConstellation → SGP4 传播，
//      由相邻两次升交点反推的节点进动率与公式值差 <= 5%（两边的 J2 处理不同，见 orbitDesign 头注）。

import { createRequire } from 'node:module'
import D from '../../../src/viz/constellation/orbitDesign.js'
import { generateConstellation, validateWalker, walkerCode } from '../../../src/viz/constellation/walker.js'
const require = createRequire(import.meta.url)
const sat = require('../vendor/satellite.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（实得 ' + (Number.isFinite(a) ? a.toFixed(6) : a) + '，期望 ' + b + ' ± ' + tol + '）')
const section = (t) => console.log('\n— ' + t)

const RE = 6378.137, MU = 398600.4418
const T0 = Date.UTC(2026, 8, 21)
const GMST0 = sat.gstime(new Date(T0))
const CTX = { gmst: GMST0 }
const solve = (type, inp, t0) => D.solveDesign(type, inp, t0 === undefined ? T0 : t0, { gmst: sat.gstime(new Date(t0 === undefined ? T0 : t0)) })

/* ===== ① 太阳同步：高度 -> 倾角（附录 E 七档，±0.05°） ===== */
section('太阳同步 h -> i')
const SS = [[400, 97.03], [500, 97.40], [600, 97.79], [700, 98.19], [800, 98.60], [900, 99.03], [1000, 99.48]]
for (const [h, i] of SS) {
  near(D.sunSyncInclination(RE + h, 0), i, 0.05, 'h=' + h + ' km -> i')
  const r = solve('sunSync', { driver: 'alt', altKm: h, localTime: '10:30', localMode: 'ltan' })
  ok(r.ok, 'h=' + h + ' 求解成功', JSON.stringify(r.errs))
  if (r.ok) near(r.seed.inclDeg, i, 0.05, 'h=' + h + ' 走 solveDesign 也是 i')
}
// 反向：给 i 解 a
for (const [h, i] of SS) near(D.sunSyncSma(i, 0) - RE, h, 12, 'i=' + i + '° -> h ≈ ' + h + ' km')
// 上限
const hMax = D.sunSyncMaxAltKm()
near(hMax, 5974, 60, '太阳同步高度上限 ≈ 5974 km')
ok(!Number.isFinite(D.sunSyncInclination(RE + 6000, 0)), 'h=6000 km 无解')
const rNo = solve('sunSync', { driver: 'alt', altKm: 6000, localTime: '10:30', localMode: 'ltan' })
ok(!rNo.ok && rNo.errs.some((e) => /无解|上限/.test(e.msg)), 'h=6000 报「无解 / 超上限」', JSON.stringify(rNo.errs))
ok(rNo.errs.some((e) => e.field === 'altKm'), '错误挂在高度这一项上（界面据此标红框）')

/* ===== ② LTAN / 平太阳 ===== */
section('地方时')
near(D.meanSunLongitudeDeg(Date.UTC(2000, 0, 1, 12)), 280.46646, 1e-4, 'J2000.0 的太阳平黄经 L0')
near(D.ltanToRaan(10.5, Date.UTC(2000, 0, 1, 12)), 257.966, 0.01, 'LTAN 10:30 -> RAAN')
near(D.ltdnToRaan(10.5, Date.UTC(2000, 0, 1, 12)), 77.966, 0.01, 'LTDN 10:30 -> RAAN（多半圈）')
for (const h of [0, 6, 10.5, 13.75, 23.99]) near(D.raanToLtan(D.ltanToRaan(h, T0), T0), h, 1e-6, 'LTAN ' + h + ' 回环')
ok(D.parseHm('10:30') === 10.5 && D.parseHm('00:00') === 0 && D.parseHm('23:59') === 23 + 59 / 60, 'hh:mm 解析')
ok(!Number.isFinite(D.parseHm('25:00')) && !Number.isFinite(D.parseHm('10:70')) && !Number.isFinite(D.parseHm('x')), '坏地方时返回 NaN')
ok(D.formatHm(10.5) === '10:30' && D.formatHm(0) === '00:00', 'hh:mm 格式化', D.formatHm(10.5))
ok(D.formatHm(23.999) === '00:00', '四舍五入到 24:00 要回绕成 00:00', D.formatHm(23.999))

/* ===== ③ 地球同步 ===== */
section('地球同步')
near(D.geosyncSma(), 42164.17, 0.05, '地球同步半长轴')
const geo = solve('geosync', { subLonDeg: 110.5, inclDeg: 0 })
ok(geo.ok, '地球同步求解成功', JSON.stringify(geo.errs))
near(geo.seed.aKm, 42164.17, 0.05, '解出的 a')
near(geo.seed.e, 0, 1e-12, 'e = 0')
near(geo.derived.periodMin, 1436.07, 0.1, '周期 ≈ 一个恒星日')
// ★ 通过 SGP4 传播验星下点经度
{
  const p = D.seedToParams(geo.seed, { pattern: 'single' }, 'GEO')
  const g = generateConstellation(p)[0].elements
  const a = RE + g.altKm
  const rec = sat.omm2satrec({
    noradId: '900001', epoch: new Date(T0).toISOString(), ecc: g.ecc,
    meanMotion: 86400 * Math.sqrt(MU / (a * a * a)) / (2 * Math.PI),
    incl: g.incl, raan: g.raan, argp: g.argp, ma: g.ma, bstar: 0, mdot: 0, mddot: 0
  })
  // ① 先验【设计本身】：解出来的 RAAN 按二体放置，星下点必须正正好好落在 110.5°E。
  //    圆赤道轨道上 ECI 赤经 = RAAN + argp + M0，星下点经度 = 赤经 − GMST(t0)，故这一条是严格恒等式。
  near(D.raanToLon(geo.seed.raanDeg + geo.seed.argpDeg + geo.seed.m0Deg, GMST0), 110.5, 1e-9, '★ 二体放置：星下点经度严格 = 110.5°E')
  near(geo.derived.subLonDeg, 110.5, 1e-9, '读数里的星下点经度也是 110.5')
  // ② 再验【SGP4 传播后】：SGP4 在 t0 会叠上 J2 短周期项，对 GEO 是沿迹 −8.9 km = −0.0121°，
  //    这是传播模型自带的量（二体那一条已经证明设计没错），故容差给 0.02°。
  const pv = sat.propagate(rec, new Date(T0))
  const gd = sat.eciToGeodetic(pv.position, sat.gstime(new Date(T0)))
  near(sat.degreesLong(gd.longitude), 110.5, 0.02, '★ SGP4 传播后 t0 星下点经度 = 110.5°E（含 J2 短周期）')
  near(gd.height, 35786, 30, '高度 ≈ 35786 km')
}

/* ===== ④ Molniya ===== */
section('Molniya')
const mol = solve('molniya', { apogeeLonDeg: 100, perigeeKm: 500, argpDeg: 270 })
ok(mol.ok, 'Molniya 求解成功', JSON.stringify(mol.errs))
near(mol.seed.aKm, 26561.8, 1, '半长轴 ≈ 26561.8 km（附录 E 的开普勒口径）')
near(mol.seed.e, 0.741, 0.001, '偏心率 ≈ 0.741')
near(mol.derived.apogeeKm, 39870, 40, '远地点高度 ≈ 39870 km')
near(mol.seed.inclDeg, 63.4349, 1e-9, '倾角 = 临界倾角')
near(mol.derived.periodMin, 717.8, 1.5, '周期 ≈ 半个恒星日')
// ★ 传播到远地点时刻（t0 就在远地点，M0=180°）验星下点经度
{
  const p = D.seedToParams(mol.seed, { pattern: 'single' }, 'MOL')
  const g = generateConstellation(p)[0].elements
  const a = RE + g.altKm / (1 - g.ecc) * (1 - g.ecc)   // altKm 是近地点高度
  const aa = (RE + g.altKm) / (1 - g.ecc)
  const rec = sat.omm2satrec({
    noradId: '900002', epoch: new Date(T0).toISOString(), ecc: g.ecc,
    meanMotion: 86400 * Math.sqrt(MU / (aa * aa * aa)) / (2 * Math.PI),
    incl: g.incl, raan: g.raan, argp: g.argp, ma: g.ma, bstar: 0, mdot: 0, mddot: 0
  })
  const pv = sat.propagate(rec, new Date(T0))
  const gd = sat.eciToGeodetic(pv.position, sat.gstime(new Date(T0)))
  near(sat.degreesLong(gd.longitude), 100, 0.5, '★ 远地点时刻星下点经度 = 100°E')
  ok(gd.height > 39000, '此刻确实在远地点附近（高度 ' + gd.height.toFixed(0) + ' km）')
}

/* ===== ⑤ 临界倾角 / 临界倾角·太阳同步 ===== */
section('临界倾角')
const cri = solve('critical', { direction: 'pro', apogeeKm: 39870, perigeeKm: 500, anLonDeg: 0, argpDeg: 270 })
ok(cri.ok, '临界倾角求解成功', JSON.stringify(cri.errs))
near(cri.seed.inclDeg, 63.4349, 1e-9, '顺行临界倾角 63.4349°')
near(Math.abs(cri.derived.argpRateDegDay), 0, 0.01, '★ 临界倾角上近地点幅角不漂（ω̇ ≈ 0）')
const criR = solve('critical', { direction: 'retro', apogeeKm: 39870, perigeeKm: 500, anLonDeg: 0, argpDeg: 270 })
near(criR.seed.inclDeg, 116.5651, 1e-9, '逆行临界倾角 116.5651°')
near(Math.abs(criR.derived.argpRateDegDay), 0, 0.01, '逆行临界倾角上 ω̇ 也 ≈ 0')
near(cri.derived.perigeeKm, 500, 1e-6, '近地点高度回读')
near(cri.derived.apogeeKm, 39870, 1e-6, '远地点高度回读')

const css = solve('criticalSunSync', { perigeeKm: 500, anLonDeg: 0, argpDeg: 270 })
ok(css.ok, '临界倾角·太阳同步求解成功', JSON.stringify(css.errs))
near(css.seed.inclDeg, 116.5651, 1e-9, '强制逆行临界倾角')
near(css.seed.e, 0.35, 0.02, '偏心率 ≈ 0.35')
near(css.derived.raanRateDegDay, 0.9856473, 1e-4, '★ 节点进动率 = 太阳同步的 0.9856473 °/d')
near(css.derived.perigeeKm, 500, 1e-6, '近地点高度守住')

/* ===== ⑥ 回归轨道 ===== */
section('回归轨道')
const rep = solve('repeat', { inclDeg: 98.2, k: 233, m: 16, anLonDeg: 0 })
ok(rep.ok, 'Landsat-8 回归比求解成功', JSON.stringify(rep.errs))
near(rep.derived.perigeeKm, 705, 10, '★ 233/16 · i=98.2° -> h ≈ 705 km')
ok(rep.derived.repeat && rep.derived.repeat.k === 233 && rep.derived.repeat.m === 16, '回归比带进 derived')
// 回归判据自洽：k 个交点周期 = m 个节点日
{
  const a = rep.seed.aKm, i = rep.seed.inclDeg
  const lhs = 233 * D.nodalPeriodSec(a, 0, i)
  const rhs = 16 * 2 * Math.PI / (D.CONST.OMEGA_E - D.raanRate(a, 0, i))
  near(lhs / rhs, 1, 1e-6, 'k·T_Ω = m·节点日（回归条件本身）')
}
const repSS = solve('repeatSunSync', { k: 233, m: 16, anLonDeg: 0, localTime: '10:00', localMode: 'ltdn' })
ok(repSS.ok, '回归·太阳同步求解成功', JSON.stringify(repSS.errs))
near(repSS.seed.inclDeg, 98.2, 0.1, '★ 233/16 太阳同步 -> i ≈ 98.2°')
near(repSS.derived.perigeeKm, 705, 10, '★ 233/16 太阳同步 -> h ≈ 705 km')
near(repSS.derived.nodalPeriodMin, 16 * 1440 / 233, 1e-6, '交点周期 = m·86400/k')
near(repSS.derived.ltdnHours, 10, 1e-6, 'LTDN 回读 10:00')
near(repSS.derived.raanRateDegDay, 0.9856473, 1e-4, '节点进动率 = 太阳同步')
// 非互质要告警
const repNc = solve('repeat', { inclDeg: 98.2, k: 234, m: 16, anLonDeg: 0 })
ok(repNc.warns.some((w) => /互质/.test(w)), 'k 与 m 不互质给 warning', JSON.stringify(repNc.warns))

/* ===== ⑦ 圆轨道与自定义根数 ===== */
section('圆轨道与自定义根数')
const cir = solve('circular', { inclDeg: 53, altKm: 550, raanDeg: 30 })
ok(cir.ok && cir.seed.e === 0 && cir.seed.argpDeg === 0 && cir.seed.m0Deg === 0, '圆轨道：e=ω=M₀=0')
near(cir.seed.aKm - RE, 550, 1e-9, '高度回读')
near(cir.seed.raanDeg, 30, 1e-9, 'RAAN 原样')
near(cir.derived.periodMin, 95.65, 0.05, '550 km 圆轨道周期 ≈ 95.65 min')
const cus = solve('custom', { shape: 'ellip', perigeeKm: 600, apogeeKm: 39700, inclDeg: 63.4, argpDeg: 270, raanDeg: 12, m0Deg: 34 })
ok(cus.ok, '自定义根数求解成功')
near(cus.derived.perigeeKm, 600, 1e-6, '近地点原样')
near(cus.derived.apogeeKm, 39700, 1e-6, '远地点原样')
near(cus.seed.argpDeg, 270, 1e-9, 'ω 原样')
near(cus.seed.m0Deg, 34, 1e-9, 'M₀ 原样')

/* ===== ⑧ 每种类型：可行 / 不可行各一例 ===== */
section('九种类型各一例')
const CASES = {
  circular: [{ inclDeg: 53, altKm: 550, raanDeg: 0 }, { inclDeg: 53, altKm: -10, raanDeg: 0 }],
  critical: [{ direction: 'pro', apogeeKm: 39870, perigeeKm: 500, anLonDeg: 0, argpDeg: 270 }, { direction: 'pro', apogeeKm: 100, perigeeKm: 500, anLonDeg: 0, argpDeg: 270 }],
  criticalSunSync: [{ perigeeKm: 500, anLonDeg: 0, argpDeg: 270 }, { perigeeKm: -5, anLonDeg: 0, argpDeg: 270 }],
  geosync: [{ subLonDeg: 110.5, inclDeg: 0 }, { subLonDeg: 110.5, inclDeg: 200 }],
  molniya: [{ apogeeLonDeg: 100, perigeeKm: 500, argpDeg: 270 }, { apogeeLonDeg: 100, perigeeKm: -1, argpDeg: 270 }],
  repeat: [{ inclDeg: 98.2, k: 233, m: 16, anLonDeg: 0 }, { inclDeg: 98.2, k: 0, m: 16, anLonDeg: 0 }],
  repeatSunSync: [{ k: 233, m: 16, anLonDeg: 0, localTime: '10:00', localMode: 'ltdn' }, { k: 233, m: 16, anLonDeg: 0, localTime: '99:99', localMode: 'ltdn' }],
  sunSync: [{ driver: 'alt', altKm: 800, localTime: '10:30', localMode: 'ltan' }, { driver: 'alt', altKm: 9000, localTime: '10:30', localMode: 'ltan' }],
  custom: [{ shape: 'circ', perigeeKm: 550, inclDeg: 53, argpDeg: 0, raanDeg: 0, m0Deg: 0 }, { shape: 'ellip', perigeeKm: 600, apogeeKm: 100, inclDeg: 63, argpDeg: 0, raanDeg: 0, m0Deg: 0 }]
}
ok(D.ORBIT_TYPE_KEYS.length === 9, '九种类型', String(D.ORBIT_TYPE_KEYS.length))
ok(D.ORBIT_TYPES.every((t) => t.zh && t.en), '每种都有中英名')
for (const key of D.ORBIT_TYPE_KEYS) {
  const [good, bad] = CASES[key]
  const g = solve(key, good)
  ok(g.ok && g.seed && g.derived, key + '：可行例求解成功', JSON.stringify(g.errs))
  const b = solve(key, bad)
  ok(!b.ok && b.errs.length > 0, key + '：不可行例被拦住并给出原因', JSON.stringify(b.errs))
  ok(b.errs.every((e) => typeof e.msg === 'string' && e.msg), key + '：错误都有可读文案')
  // 缺省输入必须是可行的（界面一打开就不能是红的）
  if (key !== 'custom') {
    const d = solve(key, D.defaultInputs(key))
    ok(d.ok, key + '：缺省输入开箱可行', JSON.stringify(d.errs))
  }
}

/* ===== ⑨ 闭环：design -> params -> generateConstellation -> SGP4 ===== */
section('闭环：解出的根数真能传播')
function propNodeRate(seed, nRev) {
  // 由相邻两次升交点（z 由负转正）估节点进动率（°/d）
  const p = D.seedToParams(seed, { pattern: 'single' }, 'X')
  const el = generateConstellation(p)[0].elements
  const a = (RE + el.altKm) / (1 - el.ecc)
  const rec = sat.omm2satrec({
    noradId: '900003', epoch: new Date(T0).toISOString(), ecc: el.ecc,
    meanMotion: 86400 * Math.sqrt(MU / (a * a * a)) / (2 * Math.PI),
    incl: el.incl, raan: el.raan, argp: el.argp, ma: el.ma, bstar: 0, mdot: 0, mddot: 0
  })
  const periodS = 2 * Math.PI * Math.sqrt(a * a * a / MU)
  const step = periodS / 400
  const nodes = []
  let prev = null
  for (let t = 0; t <= nRev * periodS * 1.2 && nodes.length < 3; t += step) {
    const ms = T0 + t * 1000
    const pv = sat.propagate(rec, new Date(ms))
    if (!pv || !pv.position) { prev = null; continue }
    // 惯性系升交点赤经：z 由负转正的那一刻的 atan2(y,x)
    if (prev && prev.z < 0 && pv.position.z >= 0) {
      const f = pv.position.z === prev.z ? 0 : -prev.z / (pv.position.z - prev.z)
      const x = prev.x + f * (pv.position.x - prev.x), y = prev.y + f * (pv.position.y - prev.y)
      nodes.push({ t: t - step + f * step, ra: Math.atan2(y, x) * 180 / Math.PI })
    }
    prev = { x: pv.position.x, y: pv.position.y, z: pv.position.z }
  }
  if (nodes.length < 2) return null
  let d = nodes[1].ra - nodes[0].ra
  while (d > 180) d -= 360
  while (d < -180) d += 360
  const dt = (nodes[1].t - nodes[0].t) / 86400
  return { rateDegDay: d / dt, nodalMin: (nodes[1].t - nodes[0].t) / 60 }
}
for (const [key, inp] of [['circular', CASES.circular[0]], ['sunSync', CASES.sunSync[0]], ['repeat', CASES.repeat[0]], ['repeatSunSync', CASES.repeatSunSync[0]]]) {
  const r = solve(key, inp)
  ok(r.ok, key + '：先解出来')
  if (!r.ok) continue
  const m = propNodeRate(r.seed, 2)
  ok(!!m, key + '：SGP4 传播里找得到两次升交点')
  if (!m) continue
  const rel = Math.abs((m.rateDegDay - r.derived.raanRateDegDay) / (r.derived.raanRateDegDay || 1))
  ok(rel <= 0.05, key + '：SGP4 反推的 Ω̇ 与公式差 <= 5%（实得 ' + (rel * 100).toFixed(2) + '%，' +
    m.rateDegDay.toFixed(4) + ' vs ' + r.derived.raanRateDegDay.toFixed(4) + ' °/d）')
  const relT = Math.abs((m.nodalMin - r.derived.nodalPeriodMin) / r.derived.nodalPeriodMin)
  ok(relT <= 0.02, key + '：交点周期差 <= 2%（实得 ' + (relT * 100).toFixed(3) + '%）')
}

/* ===== ⑩ 单星布局：T=P=1、名字不加后缀 ===== */
section('单星布局')
const single = D.seedToParams(cir.seed, { pattern: 'single' }, 'MYSAT')
ok(single.pattern === 'single' && single.T === 1 && single.P === 1 && single.F === 0, '单星 params 形状')
const sg = generateConstellation(single)
ok(sg.length === 1, '单星只生成 1 颗', String(sg.length))
ok(sg[0].name === 'MYSAT', '★ 单星名字不加 -P01-S01 后缀', sg[0].name)
ok(validateWalker(single).ok, '单星过校验')
ok(walkerCode(single) === '53° · 单星', '单星的 Walker 码', walkerCode(single))
// Walker 那一路一个字没变
const walker = D.seedToParams(cir.seed, { pattern: 'delta', T: 24, P: 6, F: 1 }, 'W')
const wg = generateConstellation(walker)
ok(wg.length === 24, 'Delta 24/6/1 仍生成 24 颗', String(wg.length))
ok(wg[0].name === 'W-P01-S01', 'Walker 名字照旧带后缀', wg[0].name)
ok(new Set(wg.map((x) => x.elements.raan)).size === 6, '仍是 6 个轨道面')
ok(walkerCode(walker) === '53°: 24/6/1', 'Walker 码照旧', walkerCode(walker))
// 椭圆种子 -> shape=ellip
const ep = D.seedToParams(mol.seed, { pattern: 'single' }, 'M')
ok(ep.shape === 'ellip', '椭圆种子给 shape=ellip')
near(ep.perigeeKm, mol.derived.perigeeKm, 1e-9, '近地点透传')
near(ep.apogeeKm, mol.derived.apogeeKm, 1e-9, '远地点透传')

/* ===== ⑪ 读数口径：纯数字，不出判定词 ===== */
section('读数口径')
for (const key of D.ORBIT_TYPE_KEYS) {
  const r = solve(key, CASES[key][0])
  if (!r.ok) continue
  const d = r.derived
  ok(Number.isFinite(d.periodMin) && Number.isFinite(d.nodalPeriodMin), key + '：两个周期都是数')
  ok(Number.isFinite(d.raanRateDegDay) && Number.isFinite(d.argpRateDegDay), key + '：两个进动率都是数')
  ok(Number.isFinite(d.ltanHours) && d.ltanHours >= 0 && d.ltanHours < 24, key + '：LTAN 在 0…24 h')
  ok(Number.isFinite(d.subLonDeg) && d.subLonDeg >= -180 && d.subLonDeg <= 180, key + '：星下点经度在 ±180°')
  ok(Number.isFinite(d.apogeeKm) && Number.isFinite(d.perigeeKm), key + '：近远地点都是数')
}

console.log('\norbitDesign: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
