// 地图设置 · 宇宙空间（星空 / 大气辉光 / 太阳 / 地球影像 / 晨昏效果 / 晨昏线）自测。运行：node packages/core/test/modelSpaceEnv.test.mjs
//
// 渲染本身在 Electron 验证台里逐像素看（.modelharness/w18）；这里钉住的是不看画面也能错的几件事：
//   ① 晨昏效果的过渡带曲线（3D 着色器与平面图栅格共用 nightRamp / NIGHT_RAMP_GLSL）：h ≥ 0 不压、h ≤ −18° 压满、单调、中点对；
//      以及平面图栅格的「行项 × 列项」可分离写法与独立球面公式逐点一致；
//   ② 星表：亮星逐颗落在真实赤经赤纬、暗星数与种子固定（每次打开一样、不闪）、暗星确实向银道面集中；
//   ③ 惯性系 → 场景轴的转动：GMST 时刻赤经 = GMST 的赤道点正好落在格林尼治子午线（场景 +X），且是正交阵；
//      GMST 就是卫星星位用的那个 sat.gstime（IAU-82，逐位相同），星空转动 ≡ 卫星链路的 eciToEcf；
//      太阳方向与模型层的 sunDirScene 同一口径（星空 / 大气 / 晨昏同一个太阳）；
//   ④ 大气可见标高与临边环带：跟随低轨星退回真实标高、全球视角按像素兜底；环带内外径把临边夹在中间；
//      大气画在地球那一趟的不透明队列（数据层叠在它上面）、深度壳高于底图、编排器挂 / 摘地球场景；
//   ⑤ 太阳被地球挡住的系数：正对太阳 1、太阳在地球正背后 0、跨临边平滑；
//   ⑥ 设置口径：出厂值（总开关另存、前五项勾、晨昏线不勾）、新存档逐字段合并 + 夹范围、
//      老存档迁移（termOn=true → 晨昏线 + 夜区阴影；影像底图开 → 地球影像；别的一概不勾）。
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

// ───────────── ② 星表 ─────────────
t('亮星逐颗：天狼星（α 6.752 h、δ −16.716°、−1.46 等）排第一、方向是单位矢量', () => {
  const S = FX.buildStarArrays()
  const a = 6.752 * 15 * RAD, d = -16.716 * RAD
  near(S.pos[0], Math.cos(d) * Math.cos(a), 1e-6); near(S.pos[1], Math.cos(d) * Math.sin(a), 1e-6); near(S.pos[2], Math.sin(d), 1e-6)
  near(S.mag[0], -1.46, 1e-6)
  for (let i = 0; i < S.pos.length / 3; i++) near(Math.hypot(S.pos[i * 3], S.pos[i * 3 + 1], S.pos[i * 3 + 2]), 1, 1e-5, '#' + i)
})
t('暗星数与种子固定：两次生成逐字节相同（不闪）；星等落在 [3, 6.8]', () => {
  const A = FX.buildStarArrays(), B = FX.buildStarArrays()
  assert.equal(A.pos.length / 3, A.nBright + FX.FAINT_N)
  assert.ok(A.nBright >= 110, String(A.nBright))
  assert.deepEqual(Buffer.from(A.pos.buffer), Buffer.from(B.pos.buffer))
  assert.deepEqual(Buffer.from(A.mag.buffer), Buffer.from(B.mag.buffer))
  for (let i = A.nBright; i < A.mag.length; i++) assert.ok(A.mag[i] >= 3 - 1e-6 && A.mag[i] <= 6.8 + 1e-6)
})
t('暗星向银道面集中：|b| < 20° 的比例明显高于均匀分布的 34.2%', () => {
  const S = FX.buildStarArrays(), NGP = [-0.86767, -0.19808, 0.45598]
  let k = 0
  for (let i = S.nBright; i < S.mag.length; i++) {
    const sb = S.pos[i * 3] * NGP[0] + S.pos[i * 3 + 1] * NGP[1] + S.pos[i * 3 + 2] * NGP[2]
    if (Math.abs(Math.asin(sb)) < 20 * RAD) k++
  }
  const f = k / FX.FAINT_N
  assert.ok(f > 0.45 && f < 0.75, 'f=' + f)
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
t('出厂：总开关另存（缺省关）；五项勾、晨昏线不勾；数值都在滑块范围内', () => {
  const d = FX.SPACE_DEF
  assert.deepEqual([d.stars, d.atmo, d.sun, d.img, d.night, d.line], [true, true, true, true, true, false])
  for (const [k, [lo, hi]] of Object.entries(FX.SPACE_RANGE)) assert.ok(d[k] >= lo && d[k] <= hi, k)
  assert.equal(FX.spaceFromSaved({}), null)
  assert.equal(FX.spaceFromSaved(null), null)
})
t('新存档：逐字段合并、类型不对的保留出厂值、数值夹进滑块范围、颜色只认 #rrggbb', () => {
  const r = FX.spaceFromSaved({ spaceOn: true, space: { stars: false, starGain: 9, nightOpacity: -1, nightColor: 'red', lineColor: '#ABCDEF', line: 'yes', img: false } })
  assert.equal(r.on, true)
  assert.equal(r.space.stars, false); assert.equal(r.space.img, false)
  assert.equal(r.space.starGain, 2); assert.equal(r.space.nightOpacity, 0)
  assert.equal(r.space.nightColor, FX.SPACE_DEF.nightColor); assert.equal(r.space.lineColor, '#abcdef')
  assert.equal(r.space.line, false)   // 'yes' 不是布尔 → 出厂值
  assert.equal(FX.spaceFromSaved({ space: {} }).on, false)
})
t('老存档迁移：termOn=true → 总开关开、晨昏线（旧夜区遮罩 = 线的夜区阴影）、样式照搬；影像底图开 → 地球影像；都没开 → 总开关关、子项出厂值', () => {
  // 旧版只开夜区遮罩：晨昏线勾上、阴影照搬、线透明度 0（只剩阴影）；晨昏效果（柔和过渡带 + 卫星按日照明暗）不勾
  const a = FX.spaceFromSaved({ termOn: true, termNight: true, termLine: false, termStyle: { nightColor: '#0A1120', nightOpacity: 0.42, lineColor: '#ffd27a', lineWidth: 2, lineOpacity: 0.5 } })
  assert.equal(a.on, true)
  assert.deepEqual([a.space.stars, a.space.atmo, a.space.sun, a.space.img, a.space.night, a.space.line], [false, false, false, false, false, true])
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
  assert.deepEqual([e.space.stars, e.space.atmo, e.space.sun, e.space.img, e.space.night, e.space.line], [false, false, false, true, false, false])
  const f = FX.spaceFromSaved({ termOn: true, imagery: { on: true } })
  assert.deepEqual([f.on, f.space.img, f.space.line, f.space.night], [true, true, true, false])
  assert.equal(FX.spaceFromSaved({ imagery: { on: false } }).on, false)
  // 新旧都在：以新的为准（新存档里影像归 space.img，旧 imagery.on 不再参与）
  assert.equal(FX.spaceFromSaved({ termOn: true, spaceOn: false, space: { stars: true } }).on, false)
  assert.equal(FX.spaceFromSaved({ imagery: { on: true }, spaceOn: false, space: { img: true } }).on, false)
})

console.log(`modelSpaceEnv: ${n} 项通过`)
