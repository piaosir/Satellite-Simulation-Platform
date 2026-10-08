// 地图设置 · 宇宙空间（星空 / 大气辉光 / 太阳 / 月球 / 地球影像 / 晨昏效果 / 晨昏线）自测。运行：node packages/core/test/modelSpaceEnv.test.mjs
//
// 渲染本身在 Electron 验证台里逐像素看（.modelharness/w18）；这里钉住的是不看画面也能错的几件事：
//   ① 晨昏效果的过渡带曲线（3D 着色器与平面图栅格共用 nightRamp / NIGHT_RAMP_GLSL）：h ≥ 0 不压、h ≤ −18° 压满、单调、中点对；
//      以及平面图栅格的「行项 × 列项」可分离写法与独立球面公式逐点一致；
//   ② 星表与底图：BSC5 逐颗对上星位 / 星等 / B−V（自行已推到历元）、星色亮度归一且随 B−V 单调变红、底图 uv 与天球网格同一套映射；
//   ③ 惯性系 → 场景轴的转动：GMST 时刻赤经 = GMST 的赤道点正好落在格林尼治子午线（场景 +X），且是正交阵；
//      星空实际走 ICRF → 场景（岁差 + 章动 + GAST）：岁差矩阵复现 Meeus 例 21.b、真天极的偏移量与方向对；
//      GMST 就是卫星星位用的那个 sat.gstime（IAU-82，逐位相同），星空转动 ≡ 卫星链路的 eciToEcf；
//      太阳方向与模型层的 sunDirScene 同一口径（星空 / 大气 / 晨昏同一个太阳）；
//   ④ 大气可见标高与临边环带：跟随低轨星退回真实标高、全球视角按像素兜底；环带内外径把临边夹在中间；
//      大气画在地球那一趟的不透明队列（数据层叠在它上面）、深度壳高于底图、编排器挂 / 摘地球场景；
//   ⑤ 太阳被地球挡住的系数：正对太阳 1、太阳在地球正背后 0、跨临边平滑；
//   ⑥ 设置口径：出厂值（总开关另存、晨昏线以外都勾、月球放大与日面同口径）、新存档逐字段合并 + 夹范围、
//      老存档迁移（termOn=true → 晨昏线 + 夜区阴影；影像底图开 → 地球影像；别的一概不勾，月球也不勾）。
//   （月球的星历 / 姿态 / 地影 / 贴图取向另在 lunar.test.mjs）
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const T = await import(SRC + 'terminator.js')
const FX = await import(SRC + 'globe3d/spaceFx.js')
const L = await import(SRC + 'lunar.js')
const { llaToVec } = await import(SRC + 'globe3d/focusLanes.js')
const AT = await import(CORE + 'models/attitude.mjs')
const sat = (await import(SRC + 'constellation/satellite.js')).default
const THREE = await import('three')

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }
const RAD = Math.PI / 180
const near = (a, b, e, msg) => assert.ok(Math.abs(a - b) <= e, `${msg || ''} ${a} vs ${b}（容差 ${e}）`)

// 独立写的太阳高度角（不复用被测中间量）：sin h = sinφ·sinφs + cosφ·cosφs·cos(λ−λs)
const sinElev = (lat, lon, sub) => Math.sin(lat * RAD) * Math.sin(sub.lat * RAD) + Math.cos(lat * RAD) * Math.cos(sub.lat * RAD) * Math.cos((lon - sub.lon) * RAD)

// ───────────── ① 晨昏效果过渡带 ─────────────
t('过渡带端点：h ≥ 0 不压、h = −18° 起压满', () => {
  for (const hDeg of [0, 0.01, 5, 45, 90]) assert.equal(T.nightRamp(Math.sin(hDeg * RAD)), 0, 'h=' + hDeg)
  for (const hDeg of [-18, -18.01, -30, -90]) near(T.nightRamp(Math.sin(hDeg * RAD)), 1, 1e-12, 'h=' + hDeg)
  near(T.TWILIGHT_SIN, Math.sin(18 * RAD), 1e-15)
})
t('过渡带单调不减、中点（sin h = −½·sin18°）= 0.5', () => {
  let prev = -1
  for (let h = 2; h >= -25; h -= 0.05) { const v = T.nightRamp(Math.sin(h * RAD)); assert.ok(v >= prev - 1e-15, 'h=' + h); prev = v }
  near(T.nightRamp(-0.5 * T.TWILIGHT_SIN), 0.5, 1e-12)
  // 民用 / 航海曙暮光处已经明显压下去（不是一条在 −18° 附近才起跳的窄边）
  assert.ok(T.nightRamp(Math.sin(-6 * RAD)) > 0.2 && T.nightRamp(Math.sin(-12 * RAD)) > 0.65)
})
t('GLSL 版与 JS 版同一个常量（写进源码，不另抄）', () => {
  const m = /clamp\(-sinH \/ ([0-9.]+), 0\.0, 1\.0\)/.exec(T.NIGHT_RAMP_GLSL)
  assert.ok(m, T.NIGHT_RAMP_GLSL)
  near(Number(m[1]), T.TWILIGHT_SIN, 5e-10)
  assert.match(T.NIGHT_RAMP_GLSL, /t \* t \* \(3\.0 - 2\.0 \* t\)/)
})
t('平面图栅格的可分离写法（行项 + 行项 × 列项）与独立球面公式逐点一致（四季 × 全球 2° 网格）', () => {
  const dates = [Date.UTC(2026, 2, 20, 14, 1), Date.UTC(2026, 5, 21, 3, 30), Date.UTC(2026, 8, 23, 18, 5), Date.UTC(2026, 11, 21, 9, 3)]
  let worst = 0
  for (const ms of dates) {
    const sub = T.solarGeometry(new Date(ms)).sub
    const sps = Math.sin(sub.lat * RAD), cps = Math.cos(sub.lat * RAD)
    for (let lat = -89; lat <= 89; lat += 2) {
      const a = Math.sin(lat * RAD) * sps, b = Math.cos(lat * RAD) * cps
      for (let lon = -179; lon <= 179; lon += 2) {
        const sep = T.nightRamp(a + b * Math.cos((lon - sub.lon) * RAD))
        const ref = T.nightRamp(sinElev(lat, lon, sub))
        worst = Math.max(worst, Math.abs(sep - ref))
      }
    }
  }
  assert.ok(worst < 1e-12, 'worst=' + worst)
})
t('3D 夜区壳的局部口径：壳 +Y = 反日方向 ⇒ sin h = −ŷ·p̂（与球面公式逐点一致）', () => {
  const sub = T.solarGeometry(new Date(Date.UTC(2026, 5, 21, 3, 30))).sub, anti = T.solarGeometry(new Date(Date.UTC(2026, 5, 21, 3, 30))).anti
  const A = llaToVec(anti.lat, anti.lon, 0).normalize()
  let worst = 0
  for (let lat = -80; lat <= 80; lat += 10) for (let lon = -170; lon <= 170; lon += 20) {
    const p = llaToVec(lat, lon, 0).normalize()
    worst = Math.max(worst, Math.abs(-(p.x * A.x + p.y * A.y + p.z * A.z) - sinElev(lat, lon, sub)))
  }
  assert.ok(worst < 1e-5, 'worst=' + worst)   // 日下点经纬本身是 double，llaToVec 是 THREE.Vector3（double）；1e-5 只为吸收 solarGeometry 的归一化
})

// ───────────── ② 星表与银河底图 ─────────────
const STARS = FX.decodeStarData(await import(SRC + 'globe3d/starfield.data.js'))
const starByHr = (hr) => { const k = STARS.hr.indexOf(hr); assert.ok(k >= 0, 'HR ' + hr); return { ra: STARS.ra[k] / RAD, dec: STARS.dec[k] / RAD, v: STARS.mag[k], bv: STARS.bv[k] } }
t('亮星表：BSC5 9096 颗；天狼星 / 老人星 / 北极星 / 织女星 / 参宿四逐颗对上星位、星等、B−V（星位已按自行推到 2026.0）', () => {
  assert.equal(STARS.n, 9096)
  for (let k = 0; k < STARS.n; k++) {
    assert.ok(STARS.ra[k] >= 0 && STARS.ra[k] < 2 * Math.PI && Math.abs(STARS.dec[k]) <= Math.PI / 2, '#' + k)
    assert.ok(STARS.mag[k] >= -1.5 && STARS.mag[k] < 8.1 && Number.isFinite(STARS.bv[k]), '#' + k)
  }
  // 天狼星：J2000 α 101.2875°、δ −16.7161°，自行 (−0.546″, −1.223″)/年 × 26 年 → α −0.0041°、δ −0.0088°
  const si = starByHr(2491)
  near(si.ra, 101.2834, 0.0005); near(si.dec, -16.7249, 0.0005); near(si.v, -1.46, 1e-6); near(si.bv, 0, 1e-6)
  near(starByHr(2326).v, -0.72, 1e-6)                                     // 老人星
  assert.ok(starByHr(424).dec > 89.2 && Math.abs(starByHr(424).v - 2.02) < 1e-6)   // 北极星
  near(starByHr(7001).ra, 279.2365, 0.002); near(starByHr(7001).v, 0.03, 1e-6)    // 织女星
  near(starByHr(2061).bv, 1.85, 1e-6)                                     // 参宿四
  // 亮于 2 等的约 50 颗、亮于 6 等的约 5000 颗（全天星等计数）
  const cnt = (m) => STARS.mag.filter((v) => v < m).length
  assert.ok(cnt(2) >= 45 && cnt(2) <= 55 && cnt(6) >= 4800 && cnt(6) <= 5200, cnt(2) + ' / ' + cnt(6))
})
t('星色：亮度归一（Y = 1）；B−V 越大越红（R/B 单调升）；织女星型偏蓝、太阳型近白微暖、参宿四型橙；饱和度 0 = 纯白', () => {
  let prev = 0
  for (let bv = -0.4; bv <= 2.4 + 1e-9; bv += 0.05) {
    const c = FX.starColorBV(bv, 1)
    near(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], 1, 1e-9, 'bv=' + bv)
    assert.ok(c[0] / c[2] > prev, 'bv=' + bv); prev = c[0] / c[2]
  }
  const vega = FX.starColorBV(0, 1), sun = FX.starColorBV(0.65, 1), betel = FX.starColorBV(1.85, 1)
  assert.ok(vega[2] > 1.3 * vega[0], String(vega))
  assert.ok(sun[0] > sun[2] && sun[0] / sun[2] < 1.35, String(sun))
  assert.ok(betel[0] / betel[2] > 3.5, String(betel))
  for (const x of FX.starColorBV(1.2, 0)) near(x, 1, 1e-12)
})
t('底图映射：赤经 0h 在图中线、赤经向左增大、上边 = +90°；天球网格每个顶点的 uv 与 starMapUv 一致（接缝两列各存一份）', () => {
  const uv = (raDeg, decDeg) => FX.starMapUv(raDeg * RAD, decDeg * RAD)
  near(uv(0, 0)[0], 0.5, 1e-12); near(uv(90, 0)[0], 0.25, 1e-12); near(uv(270, 0)[0], 0.75, 1e-12)
  near(uv(0, 90)[1], 1, 1e-12); near(uv(0, -90)[1], 0, 1e-12); near(uv(0, 30)[1], 2 / 3, 1e-12)
  const A = FX.skySphereArrays(24, 12)
  assert.equal(A.pos.length / 3, 25 * 13); assert.equal(A.idx.length, 24 * 12 * 6)
  for (let k = 0; k < A.pos.length / 3; k++) {
    const x = A.pos[k * 3], y = A.pos[k * 3 + 1], z = A.pos[k * 3 + 2]
    near(Math.hypot(x, y, z), 1, 1e-6)
    const dec = Math.asin(Math.max(-1, Math.min(1, z)))
    near(FX.starMapUv(0, dec)[1], A.uv[k * 2 + 1], 1e-6, 'v#' + k)
    if (Math.abs(z) > 0.999999) continue                                   // 极点：赤经无定义
    const u = FX.starMapUv(Math.atan2(y, x), dec)[0], d = Math.abs(u - A.uv[k * 2])
    near(Math.min(d, 1 - d), 0, 1e-6, 'u#' + k)
  }
})

// ───────────── ③ 惯性系 → 场景 ─────────────
t('惯性 → 场景：赤经 = GMST 的赤道点落在格林尼治子午线（场景 +X）；正交阵', () => {
  for (const g of [0, 0.7, 2.1, 4.4, 6.1]) {
    const m = FX.inertialToSceneRows(g)
    const v = [Math.cos(g), Math.sin(g), 0]
    const r = [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
    const G = llaToVec(0, 0, 0).normalize()
    near(r[0], G.x, 1e-12); near(r[1], G.y, 1e-12); near(r[2], G.z, 1e-12)
    // 天极 → 场景 +Y（北极）
    near(m[5], 1, 0); near(m[2], 0, 0); near(m[8], 0, 0)
    // 正交：行两两正交、各行单位长
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const d = m[i * 3] * m[j * 3] + m[i * 3 + 1] * m[j * 3 + 1] + m[i * 3 + 2] * m[j * 3 + 2]
      near(d, i === j ? 1 : 0, 1e-12)
    }
  }
})
t('太阳方向与模型层同一口径：llaToVec(日下点) ≡ attitude.sunDirScene(日下点)', () => {
  for (const ms of [Date.UTC(2026, 0, 3, 5), Date.UTC(2026, 3, 11, 22, 17), Date.UTC(2026, 7, 29, 13, 40)]) {
    const sub = T.solarGeometry(new Date(ms)).sub
    const a = llaToVec(sub.lat, sub.lon, 0).normalize(), b = AT.sunDirScene(sub.lat, sub.lon)
    near(a.x, b[0], 1e-12); near(a.y, b[1], 1e-12); near(a.z, b[2], 1e-12)
  }
})
t('GMST 与卫星星位同一个 gstime：gmstOf ≡ sat.gstime（逐位）；星空的惯性 → 场景转动 ≡ 卫星链路的 eciToEcf 再换场景轴；且是 IAU-82 平恒星时（无章动项）', () => {
  const dates = [Date.UTC(2000, 0, 1, 12), Date.UTC(2026, 8, 24, 0, 0), Date.UTC(2026, 8, 24, 4, 0, 0, 500), Date.UTC(2031, 5, 30, 23, 59, 59), Date.UTC(1999, 11, 31, 6, 7, 8)]
  const R = (() => { let a = 12345; return () => ((a = (a * 1103515245 + 12345) >>> 0) / 4294967296) })()
  for (const ms of dates) {
    const d = new Date(ms), g = T.gmstOf(d)
    assert.equal(g, sat.gstime(d), d.toISOString())
    // 独立写的 IAU-82：θ = 67310.54841 + (876600·3600 + 8640184.812866)·T + 0.093104·T² − 6.2e−6·T³ 秒，T = 自 J2000 的儒略世纪（UT1≈UTC）
    const Tc = (ms / 86400000 + 2440587.5 - 2451545) / 36525
    const sec = 67310.54841 + (876600 * 3600 + 8640184.812866) * Tc + 0.093104 * Tc * Tc - 6.2e-6 * Tc * Tc * Tc
    const ref = (((sec % 86400) / 86400 * 2 * Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
    const dg = Math.abs(g - ref)
    near(Math.min(dg, 2 * Math.PI - dg), 0, 1e-9, 'IAU-82 ' + d.toISOString())
    // 恒星方向走 inertialToSceneRows(gmst)，卫星走 sat.eciToEcf(·, gmst) 再 (X,Y,Z) → (X, Z, −Y)：同一个转动
    const m = FX.inertialToSceneRows(g)
    for (let k = 0; k < 8; k++) {
      const z = 2 * R() - 1, ph = 2 * Math.PI * R(), rr = Math.sqrt(1 - z * z)
      const v = { x: rr * Math.cos(ph), y: rr * Math.sin(ph), z }
      const e = sat.eciToEcf(v, g)
      const s3 = [m[0] * v.x + m[1] * v.y + m[2] * v.z, m[3] * v.x + m[4] * v.y + m[5] * v.z, m[6] * v.x + m[7] * v.y + m[8] * v.z]
      near(s3[0], e.x, 1e-12); near(s3[1], e.z, 1e-12); near(s3[2], -e.y, 1e-12)
    }
  }
})

t('岁差：IAU 1976 岁差矩阵复现 Meeus 例 21.b（英仙 θ，J2000 → 2028-11-13.19 TD，含自行）：α 2h46m11.331s、δ +49°20′54.54″', () => {
  const a0 = (2 + 44 / 60 + 11.986 / 3600) * 15, d0 = 49 + 13 / 60 + 42.48 / 3600
  const Tc = (2462088.69 - 2451545.0) / 36525, yrs = Tc * 100
  const a1 = (a0 + 0.03425 * 15 / 3600 * yrs) * RAD, d1 = (d0 - 0.0895 / 3600 * yrs) * RAD
  const v = [Math.cos(d1) * Math.cos(a1), Math.cos(d1) * Math.sin(a1), Math.sin(d1)]
  const P = L.precessionMatrix(Tc)
  const w = [0, 1, 2].map((r) => P[r * 3] * v[0] + P[r * 3 + 1] * v[1] + P[r * 3 + 2] * v[2])
  near((Math.atan2(w[1], w[0]) / RAD) / 15 * 3600, 2 * 3600 + 46 * 60 + 11.331, 0.002)   // 时秒
  near(Math.asin(w[2]) / RAD * 3600, 49 * 3600 + 20 * 60 + 54.54, 0.02)                  // 角秒
})
t('ICRF → 场景：J2000.0 时刻与「只转 GMST」只差章动（< 25″）；2026-10-07 真天极离 J2000 天极 θ_A ≈ 537″（±10″ 章动），朝赤经 0h；正交阵', () => {
  const ang = (m1, m2) => {   // 两个转动之差的转角：acos((tr(m1·m2ᵀ) − 1) / 2)
    let tr = 0
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += m1[i * 3 + k] * m2[i * 3 + k]
    return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) / RAD * 3600
  }
  const j2000 = new Date(Date.UTC(2000, 0, 1, 11, 58, 55, 816))
  const g0 = T.gmstOf(j2000)
  assert.ok(ang(FX.icrfToSceneRows(j2000, g0), FX.inertialToSceneRows(g0)) < 25)
  const d = new Date(Date.UTC(2026, 9, 7)), R = L.icrfToEcef(d)
  const pole = [R[6], R[7], R[8]]                                          // 地固 z（真天极）在 ICRF 里的方向 = R 的第三行
  const Tc = (d.getTime() / 86400000 + 2440587.5 + 69.184 / 86400 - 2451545) / 36525
  near((90 - Math.asin(pole[2]) / RAD) * 3600, 2004.3109 * Tc, 10)
  near(Math.atan2(pole[1], pole[0]) / RAD, 0, 2)
  const m = FX.icrfToSceneRows(d, T.gmstOf(d))
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const s = m[i * 3] * m[j * 3] + m[i * 3 + 1] * m[j * 3 + 1] + m[i * 3 + 2] * m[j * 3 + 2]
    near(s, i === j ? 1 : 0, 1e-12)
  }
  // 换轴：场景行 = 地固 (x, z, −y) 行
  for (let k = 0; k < 3; k++) { near(m[k], R[k], 0); near(m[3 + k], R[6 + k], 0); near(m[6 + k], -R[3 + k], 0) }
})

t('自动曝光：远眺（地球只占一小点）≈ 满曝光；贴近昼半球（地球占满屏）压到 1/3 上下；夜半球按夜区压暗程度回升；晨昏效果关（夜区不压）= 与昼半球同', () => {
  const sun = new THREE.Vector3(1, 0, 0)
  const cam = (pos) => { const c = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 120); c.position.set(...pos); c.lookAt(0, 0, 0); c.updateMatrixWorld(); return c }
  const far = FX.adaptFactor(cam([50, 0, 0]), sun, 0.72)
  assert.ok(far > 0.995, 'far=' + far)
  const day = FX.adaptFactor(cam([1.25, 0, 0]), sun, 0.72)
  assert.ok(day > 0.3 && day < 0.4, 'day=' + day)
  const night = FX.adaptFactor(cam([-1.25, 0, 0]), sun, 0.72)
  assert.ok(night > 0.55 && night < 0.75, 'night=' + night)
  near(FX.adaptFactor(cam([-1.25, 0, 0]), sun, 0), day, 1e-12)
  // 拉远单调回升（地球占满屏的几档相等）
  let prev = 0
  for (const D of [1.25, 1.6, 2.2, 3, 5, 10, 25]) { const a = FX.adaptFactor(cam([D, 0, 0]), sun, 0.72); assert.ok(a >= prev - 1e-12, 'D=' + D); prev = a }
  assert.ok(prev > 0.95 && FX.adaptFactor(cam([3, 0, 0]), sun, 0.72) > day + 0.1)
})
t('星的曝光：亮度滑块线性、太阳压暗最多到 40%、适应系数直接相乘；缺省适应 = 1', () => {
  near(FX.starExposure(1, 0), FX.STAR_E0, 1e-12)
  near(FX.starExposure(2, 0, 1), 2 * FX.STAR_E0, 1e-12)
  near(FX.starExposure(1, 1, 1), 0.4 * FX.STAR_E0, 1e-12)
  near(FX.starExposure(1, 0, 0.35), 0.35 * FX.STAR_E0, 1e-12)
  near(FX.starExposure(1, 7, 3), 0.4 * FX.STAR_E0, 1e-12)   // 越界的 dim / adapt 夹回 [0, 1]
})

// ───────────── ④ 大气 ─────────────
t('大气可见标高：跟随低轨星退回真实标高 7.6 km（离地 200 km 恰为下限、400 km 在 5% 内）；全球视角按「临边 4 px」兜底；拉远单调变厚、有上限', () => {
  near(FX.atmoScaleHeight(1 + 200 / 6371, 42, 900), FX.ATMO_H_MIN, 1e-15)
  const h400 = FX.atmoScaleHeight(1 + 400 / 6371, 42, 900)
  assert.ok(h400 >= FX.ATMO_H_MIN && h400 <= 1.05 * FX.ATMO_H_MIN, 'h400=' + h400)
  const hG = FX.atmoScaleHeight(3, 42, 900)
  const px = 2 * Math.tan(21 * RAD) / 900
  near(hG, FX.ATMO_PX * px * Math.sqrt(8), 1e-12)
  let prev = 0
  for (let D = 1.05; D < 60; D *= 1.2) { const h = FX.atmoScaleHeight(D, 42, 900); assert.ok(h >= prev - 1e-15 && h <= FX.ATMO_H_MAX); prev = h }
})
t('临边环带把地球临边夹在中间：内径张角 = 撞击参数 0.8、外径到大气外沿；贴进大气层时改走全屏', () => {
  for (const D of [1.07, 1.5, 3, 8, 30]) {
    const H = FX.atmoScaleHeight(D, 42, 900), R = FX.atmoRingRadii(D, H)
    assert.equal(R.inside, false, 'D=' + D)
    // 过地心平面上半径 ρ 的点对相机张角 atan(ρ/D)；临边张角 asin(1/D)
    const limb = Math.asin(1 / D), aIn = Math.atan(R.rin / D), aOut = Math.atan(R.rout / D)
    assert.ok(aIn < limb && limb < aOut, `D=${D}`)
    near(Math.sin(aIn) * D, FX.ATMO_P_IN, 1e-9)
    near(Math.sin(aOut) * D, Math.min(FX.atmoOuterR(H), 0.9995 * D), 1e-9)
  }
  assert.equal(FX.atmoRingRadii(1.005, FX.ATMO_H_MIN).inside, true)
})
t('大气画在地球那一趟：进地球场景的不透明队列（底图 0 之后、最低的透明数据层 4 之前），加法、测深度不写深度、片元深度解析地写；第二趟里没有它', () => {
  const A = FX.createAtmosphere()
  try {
    const { ring, fs } = A.meshes
    assert.deepEqual(A.earthObjects, [ring, fs]); assert.deepEqual(A.objects, [])
    assert.ok(FX.ATMO_EARTH_ORDER > 0 && FX.ATMO_EARTH_ORDER < 4)
    for (const x of [ring, fs]) {
      const m = x.material
      assert.equal(x.renderOrder, FX.ATMO_EARTH_ORDER)
      assert.equal(m.transparent, false); assert.equal(m.blending, THREE.AdditiveBlending)
      assert.equal(m.depthTest, true); assert.equal(m.depthWrite, false)
      assert.ok(m.fragmentShader.includes('gl_FragDepth = z;') && m.fragmentShader.includes('atmoFrag('))
      // 深度壳半径写进着色器的是它的平方（源码里同一个常量，不另抄）
      const k = /const float RB2 = ([0-9.]+);/.exec(m.fragmentShader)
      assert.ok(k, 'RB2'); near(Number(k[1]), FX.ATMO_DEPTH_R * FX.ATMO_DEPTH_R, 1e-8)
    }
    // 撞地式 τ = H / (μ + √(H/2π))，μ → 0（p → 1）时 → √(2πH)；擦边式 τ = √(2π p H)·e^(−(p−1)/H)，p = 1 时 = √(2πH)：一个连续函数
    const src = ring.material.fragmentShader
    assert.ok(src.includes('uH / (mu + sqrt(uH * 0.5 / 3.14159265))') && src.includes('sqrt(6.28318531 * pc * uH) * exp(-(pc - 1.0) / uH)'))
    for (const H of [FX.ATMO_H_MIN, 0.004, 0.02]) near(H / Math.sqrt(H * 0.5 / 3.14159265), Math.sqrt(6.28318531 * H), 1e-8)
  } finally { A.dispose() }
})
t('深度壳：高于底图最高的一层（陆地面 / 岸线国界 ≤ 1.0005）—— 撞地视线取壳上交点，恒比底图近（独立射线求交，六个机位）', () => {
  const Rb = FX.ATMO_DEPTH_R
  assert.ok(Rb > 1.0005 && Rb <= 1.001, String(Rb))
  // 相机 (0,0,D)，撞击参数 p 的视线：到半径 r 的球的近交点距离
  const hitT = (D, p, r) => { const a = Math.asin(p / D), b = -D * Math.cos(a), c = D * D - r * r, q = b * b - c; return q < 0 ? null : -b - Math.sqrt(q) }
  for (const D of [1.02, 1.07, 1.5, 3, 8, 50]) {
    for (let p = FX.ATMO_P_IN; p < 1.0005; p += 0.0005) {
      const ts = hitT(D, p, Rb), tl = hitT(D, p, 1.0005)
      assert.ok(ts != null, `D=${D} p=${p}`)
      if (tl != null) assert.ok(ts < tl, `D=${D} p=${p}`)
    }
  }
})
t('编排器：开大气 = 两块网格挂进地球场景，关掉 / 整个放掉 = 摘走；第二趟只剩星空 / 太阳时才画', () => {
  const earth = new THREE.Scene()
  const fx = FX.createSpaceFx({ getContext() { throw new Error('no gl') } }, earth)   // 假 renderer：只用来探软件光栅，探不到按硬件算
  fx.setAtmosphere({ gain: 1 })
  const M = fx._atmoMeshes()
  assert.deepEqual(earth.children, [M.ring, M.fs])
  let drew = 0
  fx.renderMain({ autoClear: true, render() { drew++ } }, new THREE.PerspectiveCamera(), 100, 100)
  assert.equal(drew, 0)   // 只开大气：第二趟不空跑一次 render
  fx.setAtmosphere(null)
  assert.equal(earth.children.length, 0)
  fx.setAtmosphere({ gain: 1 }); fx.dispose()
  assert.equal(earth.children.length, 0)
})

t('月球：挂进地球场景的不透明队列（底图 0 之后、大气 0.5 之前）、写深度；按月心就位、显示半径 = 真实半径 × 大小；关掉 / 放掉 = 摘走', () => {
  const earth = new THREE.Scene()
  const fx = FX.createSpaceFx({ getContext() { throw new Error('no gl') } }, earth)
  assert.ok(FX.MOON_EARTH_ORDER > 0 && FX.MOON_EARTH_ORDER < FX.ATMO_EARTH_ORDER)
  const d = new Date('2026-10-06T00:00:00Z'), p = L.moonPosition(d)
  const st = FX.moonSceneState(p, L.moonBodyToEcef(d, p), L.sunDistanceKm(d))
  fx.setTime([1, 0, 0], 0, st)            // 月球没开时先到的状态：开了以后照样就位
  fx.setMoon({ scale: 3 })
  const m = fx._moonMesh()
  assert.deepEqual(earth.children, [m])
  assert.equal(m.renderOrder, FX.MOON_EARTH_ORDER)
  assert.equal(m.material.transparent, false); assert.equal(m.material.depthWrite, true); assert.equal(m.material.depthTest, true)
  assert.deepEqual(m.position.toArray(), st.center)
  near(m.scale.x, 1737.4 / 6371 * 3, 1e-12)
  fx.setMoon({ scale: 99 }); near(m.scale.x, 1737.4 / 6371 * 10, 1e-12)   // 夹到 10×
  assert.equal(m.visible, false)          // 贴图没到手（单测里没有 DOM）：不画，不闪一个灰球
  fx.setMoon(null); assert.equal(earth.children.length, 0)
  fx.setMoon({ scale: 1 }); fx.dispose(); assert.equal(earth.children.length, 0)
})
t('日面被（显示大小的）月盘挡住的系数：月心正对日心时 = 1 −（月盘/日面）²，月盘盖满日面 = 0，错开 = 1', () => {
  const mf = FX.createMoonFx({})
  const c = [60, 0, 0], cam = new THREE.PerspectiveCamera()
  mf.setState({ center: c, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1] })
  mf.mesh.visible = true
  const sunR = 0.008, dir = new THREE.Vector3(1, 0, 0)
  for (const s of [1, 1.7]) {
    mf.setStyle({ scale: s })
    const rho = Math.asin(1737.4 / 6371 * s / 60)
    near(mf.sunVisibility(cam, dir, sunR), 1 - (rho / sunR) ** 2, 1e-9, '倍数 ' + s)
  }
  mf.setStyle({ scale: 4 }); near(mf.sunVisibility(cam, dir, sunR), 0, 1e-12)
  near(mf.sunVisibility(cam, new THREE.Vector3(Math.cos(0.1), Math.sin(0.1), 0), sunR), 1, 1e-12)
  mf.mesh.visible = false; assert.equal(mf.sunVisibility(cam, dir, sunR), 1)   // 没画出来就不挡
  mf.dispose()
})

// ───────────── ⑤ 太阳被地球挡 ─────────────
t('太阳被地球挡住的系数：正对太阳 1、太阳在地球正背后 0、跨临边单调且平滑', () => {
  const sun = { x: 1, y: 0, z: 0 }
  assert.equal(FX.sunEarthVisibility({ x: 3, y: 0, z: 0 }, sun), 1)
  assert.equal(FX.sunEarthVisibility({ x: -3, y: 0, z: 0 }, sun), 0)
  // 相机在反日侧、沿 +Y 挪开：太阳从地球背后露出来
  let prev = 0, jumps = 0
  for (let a = 0; a <= 30; a += 0.05) {
    const r = 3, c = { x: -r * Math.cos(a * RAD), y: r * Math.sin(a * RAD), z: 0 }
    const v = FX.sunEarthVisibility(c, sun)
    assert.ok(v >= prev - 1e-12); if (v - prev > 0.2) jumps++
    prev = v
  }
  assert.equal(prev, 1); assert.equal(jumps, 0)
  assert.ok(FX.OCCLUDER_R < 0.998 && FX.OCCLUDER_R > 0.99)   // 遮挡球恒在海洋球 / 陆地之下：地球已写的深度它必然测试不过
})

// ───────────── ⑥ 设置口径 ─────────────
t('出厂：总开关另存（缺省关）；晨昏线以外都勾；数值都在滑块范围内；月球放大倍数 = 日面的放大口径', () => {
  const d = FX.SPACE_DEF
  assert.deepEqual([d.stars, d.atmo, d.sun, d.moon, d.img, d.night, d.line], [true, true, true, true, true, true, false])
  assert.equal(d.planets, true)
  assert.equal(d.moonScale, FX.MOON_SCALE_DEF)
  near(d.moonScale, 0.008 / 0.00465, 0.05, '日面 SUN_R_VIS / SUN_R_TRUE')
  for (const [k, [lo, hi]] of Object.entries(FX.SPACE_RANGE)) assert.ok(d[k] >= lo && d[k] <= hi, k)
  assert.equal(FX.spaceFromSaved({}), null)
  assert.equal(FX.spaceFromSaved(null), null)
})
t('新存档：逐字段合并、类型不对的保留出厂值、数值夹进滑块范围、颜色只认 #rrggbb', () => {
  const r = FX.spaceFromSaved({ spaceOn: true, space: { stars: false, starGain: 9, nightOpacity: -1, nightColor: 'red', lineColor: '#ABCDEF', line: 'yes', img: false, moonScale: 99 } })
  assert.equal(r.on, true)
  assert.equal(r.space.stars, false); assert.equal(r.space.img, false)
  assert.equal(r.space.starGain, 2); assert.equal(r.space.nightOpacity, 0)
  assert.equal(r.space.nightColor, FX.SPACE_DEF.nightColor); assert.equal(r.space.lineColor, '#abcdef')
  assert.equal(r.space.line, false)   // 'yes' 不是布尔 → 出厂值
  assert.equal(r.space.moonScale, 10); assert.equal(r.space.moon, true)   // 放大倍数夹到 10×；月球项缺 → 出厂勾
  // 加月球之前的新存档（space 里没有 moon / moonScale）：打开总开关的老用户升级后月球按出厂值上屏
  const o = FX.spaceFromSaved({ spaceOn: true, space: { stars: true, atmo: true, sun: true, img: false, night: true, line: false } })
  assert.equal(o.space.moon, true); assert.equal(o.space.moonScale, FX.MOON_SCALE_DEF)
  assert.equal(FX.spaceFromSaved({ space: {} }).on, false)
})
t('老存档迁移：termOn=true → 总开关开、晨昏线（旧夜区遮罩 = 线的夜区阴影）、样式照搬；影像底图开 → 地球影像；都没开 → 总开关关、子项出厂值', () => {
  // 旧版只开夜区遮罩：晨昏线勾上、阴影照搬、线透明度 0（只剩阴影）；晨昏效果（柔和过渡带 + 卫星按日照明暗）不勾
  const a = FX.spaceFromSaved({ termOn: true, termNight: true, termLine: false, termStyle: { nightColor: '#0A1120', nightOpacity: 0.42, lineColor: '#ffd27a', lineWidth: 2, lineOpacity: 0.5 } })
  assert.equal(a.on, true)
  assert.deepEqual([a.space.stars, a.space.atmo, a.space.sun, a.space.moon, a.space.img, a.space.night, a.space.line], [false, false, false, false, false, false, true])
  assert.equal(a.space.planets, false)
  assert.equal(a.space.shadeColor, '#0a1120'); assert.equal(a.space.shadeOpacity, 0.42); assert.equal(a.space.lineWidth, 2); assert.equal(a.space.lineOpacity, 0)
  assert.equal(a.space.nightColor, FX.SPACE_DEF.nightColor); assert.equal(a.space.nightOpacity, FX.SPACE_DEF.nightOpacity)   // 晨昏效果的样式不受旧遮罩牵连
  // 老存档缺 termNight / termLine（老版本的缺省都是开）：线 + 阴影都在
  const b = FX.spaceFromSaved({ termOn: true })
  assert.deepEqual([b.space.night, b.space.line, b.space.stars, b.space.img], [false, true, false, false])
  assert.equal(b.space.shadeOpacity, FX.SPACE_DEF.shadeOpacity); assert.equal(b.space.lineOpacity, FX.SPACE_DEF.lineOpacity)
  // 旧版只开分界线：阴影强度 0（只剩线），越界的旧透明度夹进滑块范围
  const d = FX.spaceFromSaved({ termOn: true, termNight: false, termStyle: { nightOpacity: 3, lineOpacity: 0.6 } })
  assert.equal(d.space.shadeOpacity, 0); assert.equal(d.space.lineOpacity, 0.6)
  const c = FX.spaceFromSaved({ termOn: false, termNight: false, termStyle: { nightOpacity: 0.1 } })
  assert.equal(c.on, false); assert.deepEqual(c.space, { ...FX.SPACE_DEF })
  // 影像底图并进宇宙空间：旧 imagery.on=true → 总开关开、只勾地球影像（星空 / 大气 / 太阳 / 晨昏不上屏）
  const e = FX.spaceFromSaved({ imagery: { on: true, k: 'bm8k', bright: 0.8 } })
  assert.equal(e.on, true)
  assert.deepEqual([e.space.stars, e.space.atmo, e.space.sun, e.space.moon, e.space.img, e.space.night, e.space.line], [false, false, false, false, true, false, false])
  const f = FX.spaceFromSaved({ termOn: true, imagery: { on: true } })
  assert.deepEqual([f.on, f.space.img, f.space.line, f.space.night], [true, true, true, false])
  assert.equal(FX.spaceFromSaved({ imagery: { on: false } }).on, false)
  // 新旧都在：以新的为准（新存档里影像归 space.img，旧 imagery.on 不再参与）
  assert.equal(FX.spaceFromSaved({ termOn: true, spaceOn: false, space: { stars: true } }).on, false)
  assert.equal(FX.spaceFromSaved({ imagery: { on: true }, spaceOn: false, space: { img: true } }).on, false)
})

console.log(`modelSpaceEnv: ${n} 项通过`)
