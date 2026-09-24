// 星侧太阳侵入 IPC + 模型工作台二期主进程通道自测（electron/ipc/register.js 的 sunoutage:satIntrusion、models:saveMask/getMask/exportTable）。
// 运行：node packages/core/test/modelSatIntrusionIpc.test.mjs（不联网：SWPC 离线 + 临时数据目录；GRD 用合成文件走真 grd 服务）
//
// 照 sunOutageIpc.test 的写法：假 electron 把 register.js 原样装起来，直接调 handler。钉死：
//   ① 四条通道都注册、都在门禁里（未激活 → {locked:true}）；入参校验（N×10、非数值、频率、波束宽、越界时刻）。
//   ② GEO 全球波束对地（θB 17.4°）、春分子夜太阳在地球背后：dT 全 0、逐拍记 blocked——不判地球遮挡会凭空十几 K（顺手断言这一点）。
//   ③ 春分日正午视轴对日：dT / ΔG/T 与 sunNoiseTemp 直接调用一致（Float32 精度）；F10.7 按样本所在 UT 日取（无数据 120 / 夹具预测值；
//      跨两天两个值）；显式 f107 不被覆盖；半影（日心压在地球边缘）按可见比例缩放。
//   ④ 预筛：偏轴 > θd/2 + 6θB 直接 0 且计数；worst = dT 最大的第一拍。
//   ⑤ GRD 档（合成椭圆 + 偏心高斯，uv 网格，走真 electron/services/grd.js）：
//      · 天线系方向映射：太阳落在 +x / −x / +y 三处，dT 与细网格积分的解析期望差 < 1%（x/y 对调、符号反了都差一倍以上）；
//      · 网格外整拍回退高斯主瓣（θB 由峰值增益按理想高斯束等效，= √(θx·θy)），与高斯档逐位相同；
//      · peakDbi 平移：dT 按 10^(Δ/10) 精确缩放；
//      · 三遍回放的组对齐：遮挡拍 / 网格外拍 / 跨网格边缘拍 / 跨 UT 日混排，整批结果与逐拍单独调用逐位相同；
//      · 文件不存在 → ok:false、code:'grd-missing'，报错里不带绝对路径。
//   ⑤b 天线键与天线设置：pattern.ant（preload 解析的 {found, file, cfg}）= 直接给文件；找不到 / 没有文件 / 没附 ant 的 folder|name → code:'grd-unresolved'；
//      cfg.yaw（3D 页「旋转 Rot」）与 coverage.basisFromAxes 在「姿态 + 挂点」档的转法逐字相同（按它的基底对解析方向图积分对拍）。
//   ⑤c 电平核对：网格内 (1/4π)∫G dΩ 与细网格数值积分一致；EIRP 件（+50 dB）/ 峰值归一件（0 dB）按「网格内功率 = 4π」重定标后 ΔT 与 dBi 件一致；
//      增益偏置 −1 dB 仍信文件（ΔT × 10^−0.1）；θφ 网格（igrid 7）负 θ 镜像重复不重复计、az/el 网格（igrid 6）雅可比对。
//   ⑤d 多波束 / 极化：缺省存活波束取最大包络；beamIndex = cfg.keptSets；越界 → grd-bad；极化恒取两分量功率和（3D 页的 P1/P2 比值档被忽略）、pol:'P1' 只取共极化。
//   ⑤e up 退化（零 / 与视轴平行）按 basisFromAxes 的退化口径补、计 counts.upDefault，与显式给那组 up 逐位相同；调用方数组不改。
//   ⑧ 取消：同窗同 jobKey 新请求顶掉旧的（code:'canceled'）；不同 jobKey 互不干扰；satIntrusionCancel；发起窗口销毁即停。
//      一个月 60 s GRD 宽网格：计算期间事件循环最长停顿有上限。
//   ⑨ 真 preload：folder|name 从 localStorage('globe3d/settings').grd 解析（cfg 取 yaw / gainOffset / keptSets）；超 262 144 拍自动分段
//      （拼接结果与一次算完逐位相同、onProgress 逐段报）；同键新请求在段间顶掉旧的；cancelSatIntrusion；exportTable 大表按列打包、写出的格子逐位相同。
//   ⑥ 结果过 structuredClone（IPC 纯数据）。
//   ⑦ models:saveMask / getMask / exportTable 经 handler 走通（细节用例在 modelsService.test）。
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const Module = require('module')

process.env.SATSIM_SWPC_OFFLINE = '1'
process.env.SATSIM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'satsun-'))
delete process.env.SATSIM_SWPC_BUNDLE_DIR
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'satsun-w-'))
process.env.SATSIM_MODELS_DIR = path.join(TMP, 'ud', 'models')
process.env.SATSIM_MODELS_BUNDLE_DIR = path.join(TMP, 'bundle')
process.env.SATSIM_MODELS_OFFLINE = '1'
fs.mkdirSync(process.env.SATSIM_MODELS_BUNDLE_DIR, { recursive: true })

const handlers = new Map()
// preload 也原样装（⑨）：contextBridge 收下 api，ipcRenderer.invoke 直通 register.js 的 handler（发起窗口 id 7）
const PRELOAD_SENDER = { id: 7 }
let preloadApi = null
const fakeElectron = {
  contextBridge: { exposeInMainWorld: (k, v) => { if (k === 'api') preloadApi = v } },
  ipcRenderer: {
    invoke: async (ch, ...a) => { const h = handlers.get(ch); if (!h) throw new Error('no handler ' + ch); return h({ sender: PRELOAD_SENDER }, ...a) },
    on: () => {}, send: () => {}, removeListener: () => {}
  },
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  app: { getPath: () => '.', isPackaged: false },
  shell: { openExternal: async () => {}, openPath: async () => {}, showItemInFolder: () => {} },
  nativeTheme: { on: () => {} }
}
const orig = Module._load
Module._load = function (req, ...rest) {
  if (req === 'electron') return fakeElectron
  return orig.call(this, req, ...rest)
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..').split(path.sep).join('/')
const core = require(ROOT + '/packages/core/index.js')
const report = require(ROOT + '/electron/services/report.js')
const solarFlux = require(ROOT + '/electron/services/solarFlux.js')
const createGrd = require(ROOT + '/electron/services/grd.js')
const createCoverage = require(ROOT + '/electron/services/coverage.js')
const createModels = require(ROOT + '/electron/services/models.js')
const { register } = require(ROOT + '/electron/ipc/register.js')

let pass = 0
const ok = (cond, msg) => { assert.ok(cond, msg); pass++ }
const near = (a, b, rel, msg) => { const d = Math.abs(a - b) / Math.max(Math.abs(b), 1e-300); assert.ok(d <= rel, `${msg}：${a} vs ${b}（相对差 ${d.toExponential(2)}）`); pass++; if (process.env.SATSUN_VERBOSE) console.log(`  ${msg}：相对差 ${d.toExponential(2)}`) }

// ───────── 合成 GRD：uv 网格（igrid 1），椭圆 + 偏心高斯（θx 2°、θy 3°，峰在 +x 方向 u0 = 0.02） ─────────
const D2R = Math.PI / 180
const TX = 2 * D2R, TY = 3 * D2R
const U0 = 0.02, AX0 = Math.atan2(U0, Math.sqrt(1 - U0 * U0))
const G0 = 16 * Math.LN2 / (TX * TY)                                 // ∫G dΩ ≈ 4π（小角近似下的理想高斯束）
const patG = (d) => G0 * Math.exp(-4 * Math.LN2 * (((Math.atan2(d[0], d[2]) - AX0) / TX) ** 2 + (Math.atan2(d[1], d[2]) / TY) ** 2))
const GRD_DIR = path.join(TMP, 'grd')
fs.mkdirSync(path.join(GRD_DIR, 'test'), { recursive: true })
{
  const NX = 97, XS = -0.12, XE = 0.12, st = (XE - XS) / (NX - 1)
  const L = ['synthetic test grid (satIntrusion IPC)', '++++', '1', '1 3 2 1', '0 0', `${XS} ${XS} ${XE} ${XE}`, `${NX} ${NX} 0`]
  for (let r = 0; r < NX; r++) {
    for (let c = 0; c < NX; c++) {
      const u = XS + c * st, v = XS + r * st
      const g = patG([u, v, Math.sqrt(1 - u * u - v * v)])
      L.push(`${Math.sqrt(g).toExponential(12)} 0 0 0`)
    }
  }
  fs.writeFileSync(path.join(GRD_DIR, 'test', 'ell.grd'), L.join('\n') + '\n')
}
const grd = createGrd(GRD_DIR)

// ───────── 模型服务（掩模 / 表格经 handler 走一遍） ─────────
const saveTo = { path: null }
const models = createModels({
  appRoot: ROOT, log: { info() {}, warn() {}, error() {} },
  electron: { dialog: { showSaveDialog: async () => (saveTo.path ? { canceled: false, filePath: saveTo.path } : { canceled: true }) } }
})

let active = true
register({
  core: () => core, storage: {}, report,
  coverage: {}, coverageGrd: createCoverage(null, GRD_DIR), coverageGxt: {}, share: {}, grd,
  activation: { current: () => ({ active }), start: () => {} },
  perfWin: {}, freqPlan: {}, weather: {}, gfs: {}, updater: {},
  models, openModel: () => null
})
const call = (ch, ...a) => handlers.get(ch)({ sender: {} }, ...a)

// ───────── 几何小工具 ─────────
const AU = 1.495978707e8
const RGEO = 42164.17
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l] }
const add = (a, b, k = 1) => [a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2]]
const sc = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
const sunAt = (t) => core.sunEcefAt(t)
// 卫星处看太阳的单位矢量（与日凌核同式：地心太阳 × 当日日地距离 − 卫星位置）
const sunFrom = (t, r) => nrm(add(sc(sunAt(t), core.sunDistAuAt(t) * AU), r, -1))
const perp = (v) => nrm(cross(Math.abs(v[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], v))
// 让太阳落在天线系方向 dA 上：返回 {bore, up}（ECEF）。R = T·Q：T 的第三列 = 太阳方向，Q 的第三行 = dA
function aimSunAt(v, dA) {
  const q3 = nrm(dA), q1 = perp(q3), q2 = cross(q3, q1)
  const t3 = v, t1 = perp(t3), t2 = cross(t3, t1)
  const col = (j) => add(add(sc(t1, q1[j]), t2, q2[j]), t3, q3[j])   // 天线轴 j 在 ECEF 的像
  return { bore: col(2), up: col(1), x: col(0) }
}
const dirFromAngles = (ax, ay) => nrm([Math.tan(ax), Math.tan(ay), 1])   // atan2(x,z) = ax、atan2(y,z) = ay
const pack = (list) => {
  const S = new Float64Array(list.length * 10)
  list.forEach((s, i) => { S.set([s.t, ...s.r, ...s.bore, ...s.up], i * 10) })
  return S
}
const EQX = Date.UTC(2026, 2, 20, 0, 0, 0)          // 2026 春分日（UT）
const midnightSat = (t) => { const s = sunAt(t); return sc(nrm([-s[0], -s[1], 0]), RGEO) }   // 赤道上、正背对太阳（地方子夜）
const noonSat = (t) => { const s = sunAt(t); return sc(nrm([s[0], s[1], 0]), RGEO) }         // 赤道上、正对太阳（地方正午）

// ① 注册与门禁
for (const ch of ['sunoutage:satIntrusion', 'sunoutage:satIntrusionCancel', 'models:saveMask', 'models:getMask', 'models:exportTable']) ok(handlers.has(ch), `注册了 ${ch}`)
{
  active = false
  for (const ch of ['sunoutage:satIntrusion', 'sunoutage:satIntrusionCancel', 'models:saveMask', 'models:getMask', 'models:exportTable']) {
    const r = await call(ch, {})
    ok(r && r.locked === true, `未激活 ${ch} 被门禁挡住`)
  }
  active = true
}
{
  const t = EQX + 12 * 3600e3, r = noonSat(t), v = sunFrom(t, r), up = perp(v)
  const good = { t, r, bore: v, up }
  const base = { freqGHz: 14, sysTempK: 500, pattern: { kind: 'gauss', thetaB3dB: 2 } }
  const bad = async (o, re, msg) => { const x = await call('sunoutage:satIntrusion', o); ok(x.ok === false && re.test(x.error), `${msg}（${x.error}）`) }
  await bad({ ...base, samples: new Float64Array(9) }, /N×10/, '入参：长度不是 10 的倍数')
  await bad({ ...base, samples: pack([{ ...good, t: NaN }]) }, /非数值/, '入参：非数值')
  await bad({ ...base, samples: pack([{ ...good, t: Date.UTC(2300, 0, 1) }]) }, /越界/, '入参：时刻越界')
  await bad({ ...base, samples: pack([{ ...good, r: [100, 0, 0] }]) }, /地球外/, '入参：卫星在地球里')
  await bad({ ...base, samples: pack([{ ...good, bore: [0, 0, 0] }]) }, /零向量/, '入参：视轴零向量')
  await bad({ ...base, freqGHz: 0, samples: pack([good]) }, /频率/, '入参：缺频率')
  await bad({ ...base, pattern: { kind: 'gauss' }, samples: pack([good]) }, /波束宽/, '入参：缺 3 dB 波束宽')
  await bad({ ...base, pattern: { kind: 'diameter' }, samples: pack([good]) }, /口径/, '入参：缺口径')
  const arr = await call('sunoutage:satIntrusion', { ...base, samples: Array.from(pack([good])) })
  ok(arr.ok === true && arr.n === 1, '普通数组也收（转成 Float64Array）')
}

// ② GEO 全球波束对地、春分子夜太阳在地球背后 → 0
{
  const list = []
  for (let m = -20; m <= 20; m += 5) {
    const t = EQX + m * 60e3
    const r = midnightSat(t)
    list.push({ t, r, bore: nrm(sc(r, -1)), up: perp(nrm(sc(r, -1))) })
  }
  const res = await call('sunoutage:satIntrusion', { samples: pack(list), freqGHz: 6, sysTempK: 500, pattern: { kind: 'gauss', thetaB3dB: 17.4 } })
  ok(res.ok === true && res.n === list.length, '② 算得出')
  ok(Array.from(res.dT).every((x) => x === 0) && Array.from(res.gtLossDb).every((x) => x === 0), '② 太阳在地球背后：dT / ΔG/T 全 0')
  ok(res.counts.blocked === list.length && Array.from(res.visibleFrac).every((x) => x === 0), '② 逐拍记作全遮挡（可见比例 0）')
  const i0 = 4, t = list[i0].t
  const naive = core.sunNoiseTemp({ freqGHz: 6, offAxisDeg: res.offAxisDeg[i0], thetaB3dBDeg: 17.4, sunDiamDeg: core.sunDiamDegAt(t) })
  // 全球波束增益只有 ~21 dBi，C 频段宁静太阳 ~2.6 万 K：不判遮挡是十几 K（T_sys 500 K 下 ≈ 0.15 dB 的假损失）
  ok(res.offAxisDeg[i0] < 1 && naive.dT > 10, `② 不判地球遮挡会凭空 ${naive.dT.toFixed(1)} K（偏轴 ${res.offAxisDeg[i0].toFixed(3)}°）`)
  ok(res.worst && res.worst.i === 0 && res.worst.dT === 0, '② 全 0 时 worst 取第一拍')
}

// ③ 春分日正午视轴对日：与 sunNoiseTemp 直接调用一致；F10.7 按日取
const noonCase = (t) => { const r = noonSat(t), v = sunFrom(t, r); return { t, r, bore: v, up: perp(v) } }
{
  solarFlux._reset()
  const s = noonCase(EQX + 12 * 3600e3)
  const res = await call('sunoutage:satIntrusion', { samples: pack([s]), freqGHz: 12.5, sysTempK: 450, pattern: { kind: 'gauss', thetaB3dB: 1.2 } })
  const f = solarFlux.f107For('2026-03-20').f107
  const ref = core.sunNoiseTemp({ freqGHz: 12.5, offAxisDeg: res.offAxisDeg[0], thetaB3dBDeg: 1.2, sunDiamDeg: core.sunDiamDegAt(s.t), f107: f, sysTempK: 450 })
  ok(res.offAxisDeg[0] < 1e-5, `③ 视轴对日（偏轴 ${res.offAxisDeg[0].toExponential(1)}°）`)
  ok(f === 120 && res.f107.length === 1 && res.f107[0].date === '2026-03-20' && res.f107[0].source === 'default', '③ 无 F10.7 数据 → 当日 120 / default')
  near(res.dT[0], Math.fround(ref.dT), 1e-7, '③ dT = sunNoiseTemp（无数据档）')
  near(res.gtLossDb[0], Math.fround(ref.gtLossDb), 1e-6, '③ ΔG/T = 10·lg(1 + ΔT/T_sys)')
  ok(res.visibleFrac[0] === 1 && res.counts.gauss === 1, '③ 正午不被遮挡、走高斯档')
  near(res.worst.dT, ref.dT, 1e-12, '③ worst.dT 是 Float64 原值')

  // 夹具（观测月均 + 太阳周预测）：按样本所在 UT 日取；跨两天两个值
  process.env.SATSIM_SWPC_BUNDLE_DIR = ROOT + '/packages/core/test/fixtures/swpc'
  solarFlux._reset()
  const s2 = noonCase(EQX + (24 + 12) * 3600e3)
  const r2 = await call('sunoutage:satIntrusion', { samples: pack([s, s2]), freqGHz: 12.5, sysTempK: 450, pattern: { kind: 'gauss', thetaB3dB: 1.2 } })
  const fa = solarFlux.f107For('2026-03-20'), fb = solarFlux.f107For('2026-03-21')
  ok(fa.source !== 'default' && fa.f107 !== 120, `③ 夹具下 F10.7 取到真数（${fa.f107.toFixed(1)} / ${fa.source}）`)
  ok(r2.f107.length === 2 && r2.f107[0].date === '2026-03-20' && r2.f107[1].date === '2026-03-21' && r2.f107[0].f107 === fa.f107 && r2.f107[1].f107 === fb.f107, '③ 两天各取各的 F10.7 并回显')
  for (const [k, ss, ff] of [[0, s, fa.f107], [1, s2, fb.f107]]) {
    const q = core.sunNoiseTemp({ freqGHz: 12.5, offAxisDeg: r2.offAxisDeg[k], thetaB3dBDeg: 1.2, sunDiamDeg: core.sunDiamDegAt(ss.t), f107: ff, sysTempK: 450 })
    near(r2.dT[k], Math.fround(q.dT), 1e-7, `③ 第 ${k + 1} 天 dT = sunNoiseTemp（该日 F10.7）`)
  }
  ok(r2.dT[0] !== res.dT[0], '③ F10.7 真进了算式')
  const fx = await call('sunoutage:satIntrusion', { samples: pack([s]), freqGHz: 12.5, sysTempK: 450, f107: 200, pattern: { kind: 'gauss', thetaB3dB: 1.2 } })
  const q200 = core.sunNoiseTemp({ freqGHz: 12.5, offAxisDeg: fx.offAxisDeg[0], thetaB3dBDeg: 1.2, sunDiamDeg: core.sunDiamDegAt(s.t), f107: 200, sysTempK: 450 })
  ok(fx.f107.length === 1 && fx.f107[0].source === 'manual' && fx.f107[0].f107 === 200, '③ 显式 f107 不被自动取覆盖')
  near(fx.dT[0], Math.fround(q200.dT), 1e-7, '③ 显式 f107 进了算式')
  const lg = await call('sunoutage:satIntrusion', { samples: pack([s]), freqGHz: 12.5, sysTempK: 450, solarModel: 'legacy', pattern: { kind: 'diameter', diameterM: 1.4 } })
  const qlg = core.sunNoiseTemp({ freqGHz: 12.5, offAxisDeg: lg.offAxisDeg[0], diameterM: 1.4, sunDiamDeg: core.sunDiamDegAt(s.t), f107: fa.f107, solarModel: 'legacy', sysTempK: 450 })
  near(lg.dT[0], Math.fround(qlg.dT), 1e-7, '③ 口径档 + legacy 亮温')
  ok(Math.abs(lg.thetaB3dB - 20.98547 / (12.5 * 1.4)) < 1e-12, '③ 口径档回显 θB = 70λ/D')

  // 半影：日心恰压在地球边缘（从星上看地心与太阳夹角 = 地球角半径）→ 约一半被挡，ΔT 按可见比例缩放
  const t = EQX + 6 * 3600e3, sDir = sunAt(t), w = perp(sDir), b = Math.asin(6371 / RGEO)
  const r = sc(add(sc(sDir, -Math.cos(b)), w, Math.sin(b)), RGEO)
  const v = sunFrom(t, r)
  const pen = await call('sunoutage:satIntrusion', { samples: pack([{ t, r, bore: v, up: perp(v) }]), freqGHz: 12.5, sysTempK: 450, pattern: { kind: 'gauss', thetaB3dB: 1.2 } })
  const vis = 1 - core.earthBlockFraction(r, sDir, core.sunDiamDegAt(t), { sunDistKm: core.sunDistAuAt(t) * AU })
  const qp = core.sunNoiseTemp({ freqGHz: 12.5, offAxisDeg: pen.offAxisDeg[0], thetaB3dBDeg: 1.2, sunDiamDeg: core.sunDiamDegAt(t), f107: solarFlux.f107For('2026-03-20').f107, sysTempK: 450, visibleFrac: vis })
  ok(vis > 0.3 && vis < 0.7 && Math.abs(pen.visibleFrac[0] - vis) < 1e-6, `③ 半影可见比例 ${vis.toFixed(3)}`)
  near(pen.dT[0], Math.fround(qp.dT), 1e-7, '③ 半影 dT 按弓形面积比缩放')
  delete process.env.SATSIM_SWPC_BUNDLE_DIR
  solarFlux._reset()
}

// ④ 预筛与 worst
{
  const t0 = EQX + 12 * 3600e3
  const list = []
  for (const [k, deg] of [[0, 10], [1, 0.3], [2, 0], [3, 0.3], [4, 10]]) {
    const t = t0 + k * 60e3, r = noonSat(t), v = sunFrom(t, r)
    const a = aimSunAt(v, dirFromAngles(deg * D2R, 0))
    list.push({ t, r, bore: a.bore, up: a.up })
  }
  const res = await call('sunoutage:satIntrusion', { samples: pack(list), freqGHz: 12.5, sysTempK: 450, pattern: { kind: 'gauss', thetaB3dB: 0.5 } })
  ok(res.dT[0] === 0 && res.dT[4] === 0 && res.gtLossDb[0] === 0 && res.counts.prescreened === 2, '④ 偏轴 10° > θd/2 + 6θB（3.27°）：直接 0、计 2 拍')
  ok(res.dT[2] > res.dT[1] && res.dT[1] > 0 && Math.abs(res.dT[1] - res.dT[3]) / res.dT[1] < 1e-3, '④ 轴上最大、两侧对称')
  ok(res.worst.i === 2 && res.worst.tMs === list[2].t && res.worst.offAxisDeg < 1e-4, '④ worst = 视轴对日那一拍')
  let cloneOk = true
  try { structuredClone(res) } catch { cloneOk = false }
  ok(cloneOk && res.dT instanceof Float32Array && res.gtLossDb instanceof Float32Array, '⑥ 结果过 structuredClone、dT / ΔG/T 是 Float32Array')
}

// ⑤ GRD 档
{
  const t0 = EQX + 12 * 3600e3
  const PAT = { kind: 'grd', key: 'test/ell.grd' }
  const Tsys = 450, F = 12.5
  // 细网格积分的解析期望：日面（半径 θd/2）上均匀平均 patG → sunNoiseTemp 的 gain 档
  const expectAt = (t, dA) => {
    const rho = core.sunDiamDegAt(t) / 2 * D2R, c = nrm(dA), e1 = perp(c), e2 = cross(c, e1)
    let s = 0, wsum = 0
    const NR = 60, NP = 120
    for (let i = 0; i < NR; i++) {
      const rr = (i + 0.5) / NR * rho
      for (let j = 0; j < NP; j++) {
        const ph = (j + 0.5) / NP * 2 * Math.PI
        const d = add(sc(c, Math.cos(rr)), add(sc(e1, Math.cos(ph)), e2, Math.sin(ph)), Math.sin(rr))
        s += patG(d) * rr; wsum += rr
      }
    }
    return core.sunNoiseTemp({ freqGHz: F, offAxisDeg: 0, gainLin: s / wsum, sunDiamDeg: core.sunDiamDegAt(t), sysTempK: Tsys }).dT
  }
  const cases = [['+x 1.5°', dirFromAngles(1.5 * D2R, 0)], ['−x 1.5°', dirFromAngles(-1.5 * D2R, 0)], ['+y 1.5°', dirFromAngles(0, 1.5 * D2R)], ['峰值方向', [U0, 0, Math.sqrt(1 - U0 * U0)]]]
  const list = cases.map(([, dA], k) => { const t = t0 + k * 60e3, r = noonSat(t), v = sunFrom(t, r), a = aimSunAt(v, dA); return { t, r, bore: a.bore, up: a.up, dA } })
  const res = await call('sunoutage:satIntrusion', { samples: pack(list), freqGHz: F, sysTempK: Tsys, pattern: PAT })
  ok(res.ok === true && res.counts.gain === list.length, `⑤ GRD 档算得出、${list.length} 拍全走实测方向图（${res.error || ''}）`)
  near(res.grd.peakDbi, 10 * Math.log10(G0), 2e-4, '⑤ 网格峰值 = G₀')
  list.forEach((s, k) => near(res.dT[k], expectAt(s.t, s.dA), 0.01, `⑤ 太阳在天线系 ${cases[k][0]}：dT 与解析期望差 < 1%`))
  ok(res.dT[0] > 3 * res.dT[1] && res.dT[2] > 1.5 * res.dT[1], '⑤ 方向映射：+x 近峰、−x 远峰、+y 走宽的那一轴（x/y 对调或符号反都会翻过来）')

  // 网格外（偏 10°）整拍回退高斯主瓣：θB = √(θx·θy)，与高斯档逐位相同
  const far = [0, 1, 2].map((k) => { const t = t0 + k * 60e3, r = noonSat(t), v = sunFrom(t, r), a = aimSunAt(v, dirFromAngles(0, (4 + 3 * k) * D2R)); return { t, r, bore: a.bore, up: a.up } })
  const rf = await call('sunoutage:satIntrusion', { samples: pack(far), freqGHz: F, sysTempK: Tsys, pattern: PAT })
  near(rf.grd.fallbackThetaB3dB, Math.sqrt(2 * 3), 1e-4, '⑤ 回退 θB 由峰值增益等效 = √(θx·θy)')
  ok(rf.counts.gain === 1 && rf.counts.gauss === 2, '⑤ 偏 4° 在网格内、7° / 10° 在网格外（回退高斯）')
  const rg = await call('sunoutage:satIntrusion', { samples: pack(far.slice(1)), freqGHz: F, sysTempK: Tsys, pattern: { kind: 'gauss', thetaB3dB: rf.grd.fallbackThetaB3dB } })
  ok(rf.dT[1] === rg.dT[0] && rf.dT[2] === rg.dT[1], '⑤ 网格外那两拍与高斯档逐位相同')
  const rt = await call('sunoutage:satIntrusion', { samples: pack(far.slice(1)), freqGHz: F, sysTempK: Tsys, pattern: { ...PAT, thetaB3dB: 5 } })
  ok(rt.grd.fallbackThetaB3dB === 5 && rt.dT[0] > rg.dT[0], '⑤ 显式给回退 θB 就用给的')

  // peakDbi 平移：整体 −3 dB → dT × 10^(−0.3)
  const rp = await call('sunoutage:satIntrusion', { samples: pack(list), freqGHz: F, sysTempK: Tsys, pattern: { ...PAT, peakDbi: res.grd.peakDbi - 3 } })
  near(rp.grd.offsetDb, -3, 1e-12, '⑤ peakDbi → 平移 −3 dB')
  list.forEach((s, k) => near(rp.dT[k], res.dT[k] * Math.pow(10, -0.3), 2e-6, `⑤ peakDbi 平移后 dT 按 10^(Δ/10) 缩放（第 ${k + 1} 拍）`))

  // 三遍回放的组对齐：遮挡 / 网格内 / 网格外 / 跨网格边缘 / 跨 UT 日混排，整批 = 逐拍单独调
  const mix = []
  const edge = Math.asin(0.12)                          // 网格 u 边缘
  const angs = [[0.5, 0], null, [9, 0], [-1, 2], null, [edge / D2R, 0], [0, -3], [12, 12], [2, 0.5]]
  angs.forEach((a, k) => {
    const t = EQX + 23.9 * 3600e3 + k * 120e3         // 23:54 起每 2 分钟一拍，跨 UT 日
    if (!a) { const r = midnightSat(t); mix.push({ t, r, bore: nrm(sc(r, -1)), up: perp(nrm(sc(r, -1))) }); return }
    const r = noonSat(t), v = sunFrom(t, r), q = aimSunAt(v, dirFromAngles(a[0] * D2R, a[1] * D2R))
    mix.push({ t, r, bore: q.bore, up: q.up })
  })
  const rb = await call('sunoutage:satIntrusion', { samples: pack(mix), freqGHz: F, sysTempK: Tsys, pattern: PAT })
  ok(rb.ok === true && rb.f107.length === 2, '⑤ 混排一批跨两个 UT 日')
  ok(rb.counts.blocked === 2 && rb.counts.gain >= 3 && rb.counts.gauss >= 3, `⑤ 混排里遮挡 / 实测 / 回退都有（${JSON.stringify(rb.counts)}）`)
  let same = true
  for (let k = 0; k < mix.length; k++) {
    const one = await call('sunoutage:satIntrusion', { samples: pack([mix[k]]), freqGHz: F, sysTempK: Tsys, pattern: PAT })
    if (one.dT[0] !== rb.dT[k] || one.gtLossDb[0] !== rb.gtLossDb[k]) { same = false; console.error(`  第 ${k + 1} 拍：整批 ${rb.dT[k]} vs 单独 ${one.dT[0]}`) }
  }
  ok(same, '⑤ 整批与逐拍单独调用逐位相同（回放组对齐）')

  const miss = await call('sunoutage:satIntrusion', { samples: pack(list.slice(0, 1)), freqGHz: F, sysTempK: Tsys, pattern: { kind: 'grd', key: 'test/none.grd' } })
  ok(miss.ok === false && miss.code === 'grd-missing' && /方向图/.test(miss.error) && !miss.error.includes(TMP) && !miss.error.includes(path.sep + 'test' + path.sep), `⑤ 文件不存在 → ok:false、grd-missing、不带绝对路径（${miss.error}）`)
  const noKey = await call('sunoutage:satIntrusion', { samples: pack(list.slice(0, 1)), freqGHz: F, sysTempK: Tsys, pattern: { kind: 'grd' } })
  ok(noKey.ok === false && /缺少方向图/.test(noKey.error), '⑤ 没给文件 → ok:false')
}

// ───────── ⑤b–⑤e、⑧、⑨ 共用：GRASP 文本网格写出器、按任意天线基底的解析期望 ─────────
// sets = [{XS, YS, XE, YE, NX, NY, field(X, Y) → [|E₁|, |E₂|]}]（实数场，虚部 0）
function writeGrd(rel, igrid, sets) {
  const L = ['synthetic test grid (satIntrusion IPC)', '++++', '1', `${sets.length} 3 2 ${igrid}`]
  for (let i = 0; i < sets.length; i++) L.push('0 0')
  for (const s of sets) {
    L.push(`${s.XS} ${s.YS} ${s.XE} ${s.YE}`, `${s.NX} ${s.NY} 0`)
    const sx = (s.XE - s.XS) / (s.NX - 1), sy = (s.YE - s.YS) / (s.NY - 1)
    for (let r = 0; r < s.NY; r++) {
      for (let c = 0; c < s.NX; c++) {
        const [a, b] = s.field(s.XS + c * sx, s.YS + r * sy)
        L.push(`${a.toExponential(12)} 0 ${b.toExponential(12)} 0`)
      }
    }
  }
  fs.writeFileSync(path.join(GRD_DIR, rel), L.join('\n') + '\n')
}
const UV = { XS: -0.12, YS: -0.12, XE: 0.12, YE: 0.12, NX: 97, NY: 97 }
const ellAmp = (u, v) => Math.sqrt(patG([u, v, Math.sqrt(1 - u * u - v * v)]))
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
// 日面上对 gainFn（天线系方向 → 线性增益）按天线三轴 B（ECEF）均匀平均 → sunNoiseTemp 的 gain 档
function expectFrame(t, r, B, gainFn, F, Tsys) {
  const rho = core.sunDiamDegAt(t) / 2 * D2R, c = sunFrom(t, r), e1 = perp(c), e2 = cross(c, e1)
  let s = 0, wsum = 0
  const NR = 60, NP = 120
  for (let i = 0; i < NR; i++) {
    const rr = (i + 0.5) / NR * rho
    for (let j = 0; j < NP; j++) {
      const ph = (j + 0.5) / NP * 2 * Math.PI
      const d = add(sc(c, Math.cos(rr)), add(sc(e1, Math.cos(ph)), e2, Math.sin(ph)), Math.sin(rr))
      s += gainFn([dot(d, B.x), dot(d, B.y), dot(d, B.z)]) * rr; wsum += rr
    }
  }
  return core.sunNoiseTemp({ freqGHz: F, offAxisDeg: 0, gainLin: s / wsum, sunDiamDeg: core.sunDiamDegAt(t), sysTempK: Tsys }).dT
}
const sameArr = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
const { basisFromAxes } = await import(pathToFileURL(ROOT + '/src/viz/grd/coverage.js').href)
const T5 = EQX + 12 * 3600e3, F5 = 12.5, TS5 = 450
const aim5 = (dA, k) => { const t = T5 + k * 60e3, r = noonSat(t), v = sunFrom(t, r), a = aimSunAt(v, dA); return { t, r, bore: a.bore, up: a.up } }
const L5 = [dirFromAngles(1.5 * D2R, 0), dirFromAngles(0, 1.5 * D2R), dirFromAngles(-1 * D2R, 0.8 * D2R), dirFromAngles(0.6 * D2R, -1.2 * D2R)].map(aim5)
const YAW = 35
const run5 = (pattern, list = L5) => call('sunoutage:satIntrusion', { samples: pack(list), freqGHz: F5, sysTempK: TS5, pattern })

// ⑤b 天线键与天线设置
{
  const byFile = await run5({ kind: 'grd', key: 'test/ell.grd' })
  const byAnt = await run5({ kind: 'grd', key: 'sat1|ell', ant: { found: true, file: 'test/ell.grd', cfg: {} } })
  const byFile2 = await run5({ kind: 'grd', file: 'test/ell.grd' })
  ok(byAnt.ok && sameArr(byAnt.dT, byFile.dT) && sameArr(byFile2.dT, byFile.dT) && byAnt.grd.file === 'test/ell.grd', '⑤b pattern.ant / pattern.file / 不带 | 的 key 三种给法逐位相同')
  const u1 = await run5({ kind: 'grd', key: 'sat1|none', ant: { found: false } })
  const u2 = await run5({ kind: 'grd', key: 'sat1|preset', ant: { found: true, file: null } })
  const u3 = await run5({ kind: 'grd', key: 'sat1|ell' })
  ok(u1.code === 'grd-unresolved' && /sat1\|none/.test(u1.error) && /不在卫星树/.test(u1.error), `⑤b 树里没有这根天线 → grd-unresolved（${u1.error}）`)
  ok(u2.code === 'grd-unresolved' && /没有方向图文件/.test(u2.error), `⑤b 天线没有方向图文件 → grd-unresolved（${u2.error}）`)
  ok(u3.code === 'grd-unresolved' && !/ENOENT/.test(u3.error), `⑤b folder|name 没附 ant → grd-unresolved、不是 ENOENT（${u3.error}）`)
  // 旋转 Rot：与 coverage.basisFromAxes（「姿态 + 挂点」档）同一套转法
  const ry = await run5({ kind: 'grd', key: 'sat1|ell', ant: { found: true, file: 'test/ell.grd', cfg: { yaw: YAW } } })
  ok(ry.ok && ry.counts.gain === L5.length, '⑤b 带 Rot 算得出、全走实测方向图')
  L5.forEach((s, k) => near(ry.dT[k], expectFrame(s.t, s.r, basisFromAxes(s.r, s.bore, s.up, YAW), patG, F5, TS5), 0.01, `⑤b Rot ${YAW}°：第 ${k + 1} 拍与 basisFromAxes 基底上的解析积分差 < 1%`))
  ok(L5.every((_, k) => Math.abs(ry.dT[k] / byFile.dT[k] - 1) > 0.05), '⑤b Rot 真进了算式（每拍都差 > 5%）')
  L5.forEach((s, k) => near(byFile.dT[k], expectFrame(s.t, s.r, basisFromAxes(s.r, s.bore, s.up, 0), patG, F5, TS5), 0.01, `⑤b Rot 0：第 ${k + 1} 拍与 basisFromAxes(0) 一致`))
}

// ⑤c 电平核对
{
  writeGrd('test/eirp.grd', 1, [{ ...UV, field: (u, v) => [ellAmp(u, v) * Math.pow(10, 50 / 20), 0] }])
  writeGrd('test/rel.grd', 1, [{ ...UV, field: (u, v) => [ellAmp(u, v) / Math.sqrt(G0), 0] }])
  // 细网格数值积分：(1/4π)∫∫ patG du dv / w（uv 方格 ±0.12）
  let I = 0
  const M = 1200, h = 0.24 / M
  for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) { const u = -0.12 + (i + 0.5) * h, v = -0.12 + (j + 0.5) * h, w = Math.sqrt(1 - u * u - v * v); I += patG([u, v, w]) / w }
  I *= h * h / (4 * Math.PI)
  const rf = await run5({ kind: 'grd', key: 'test/ell.grd' })
  near(rf.grd.powerFrac, I, 5e-3, `⑤c 网格内 (1/4π)∫G dΩ = ${I.toFixed(4)}（梯形求积 vs 细网格）`)
  ok(rf.grd.level === 'file' && rf.grd.offsetDb === 0, '⑤c dBi 件（功率比落在 [0.2, 1.1]）信文件电平')
  const re = await run5({ kind: 'grd', key: 'test/eirp.grd' })
  ok(re.grd.level === 'power' && Math.abs(re.grd.offsetDb + 50 + 10 * Math.log10(rf.grd.powerFrac)) < 1e-6, `⑤c EIRP 件（+50 dB）按网格内功率重定标（offset ${re.grd.offsetDb.toFixed(4)} dB）`)
  L5.forEach((_, k) => near(re.dT[k], rf.dT[k] / rf.grd.powerFrac, 2e-3, `⑤c EIRP 件第 ${k + 1} 拍 ΔT = dBi 件 / 功率比`))
  const rr = await run5({ kind: 'grd', key: 'test/rel.grd' })
  ok(rr.grd.level === 'power' && rr.grd.powerFrac < 0.2, `⑤c 峰值归一件（功率比 ${rr.grd.powerFrac.toExponential(2)}）按网格内功率重定标`)
  L5.forEach((_, k) => near(rr.dT[k], rf.dT[k] / rf.grd.powerFrac, 2e-3, `⑤c 峰值归一件第 ${k + 1} 拍 ΔT = dBi 件 / 功率比`))
  const ro = await run5({ kind: 'grd', key: 's|ell', ant: { found: true, file: 'test/ell.grd', cfg: { gainOffset: -1 } } })
  ok(ro.grd.level === 'file' && Math.abs(ro.grd.powerFrac / rf.grd.powerFrac - Math.pow(10, -0.1)) < 1e-9, '⑤c 增益偏置 −1 dB：功率比 × 10^−0.1、仍信文件')
  L5.forEach((_, k) => near(ro.dT[k], rf.dT[k] * Math.pow(10, -0.1), 2e-3, `⑤c 增益偏置 −1 dB 第 ${k + 1} 拍 ΔT × 10^−0.1`))
  const rpk = await run5({ kind: 'grd', key: 'test/eirp.grd', peakDbi: rf.grd.peakDbi })
  ok(rpk.grd.level === 'peak' && Math.abs(rpk.grd.offsetDb + 50) < 0.02, '⑤c 显式 peakDbi 优先于功率核对')
  // θφ 网格（igrid 7）：φ 0–360°、θ −20–20°（负 θ 半边与正 θ 半边是同一组方向）；圆高斯 3°
  const TB = 3 * D2R, GC = 16 * Math.LN2 / (TB * TB), circ = (th) => Math.sqrt(GC * Math.exp(-4 * Math.LN2 * (th / TB) ** 2))
  writeGrd('test/tp7.grd', 7, [{ XS: 0, YS: -20, XE: 360, YE: 20, NX: 73, NY: 161, field: (ph, th) => [circ(Math.abs(th) * D2R), 0] }])
  writeGrd('test/ae6.grd', 6, [{ XS: -10, YS: -10, XE: 10, YE: 10, NX: 161, NY: 161, field: (az, el) => [circ(Math.acos(Math.cos(az * D2R) * Math.cos(el * D2R))), 0] }])
  const r7 = await run5({ kind: 'grd', key: 'test/tp7.grd' })
  const r6 = await run5({ kind: 'grd', key: 'test/ae6.grd' })
  near(r7.grd.powerFrac, 1, 0.01, '⑤c θφ 网格：负 θ 镜像不重复计（重复计会是 2）')
  near(r6.grd.powerFrac, 1, 0.01, '⑤c az/el 网格（igrid 6）：雅可比 |cos az|')
  ok(r7.grd.level === 'file' && r6.grd.level === 'file', '⑤c 两种网格都信文件电平')
}

// ⑤d 多波束 / 极化
{
  // 两波束：0 号 = 椭圆件；1 号 = 左右镜像、−3 dB。交叉极化件：第二分量 = 共极化 −10 dB
  writeGrd('test/two.grd', 1, [{ ...UV, field: (u, v) => [ellAmp(u, v), 0] }, { ...UV, field: (u, v) => [ellAmp(-u, v) * Math.SQRT1_2, 0] }])
  writeGrd('test/xp.grd', 1, [{ ...UV, field: (u, v) => [ellAmp(u, v), ellAmp(u, v) * Math.sqrt(0.1)] }])
  const r1 = await run5({ kind: 'grd', key: 'test/ell.grd' })
  const rAll = await run5({ kind: 'grd', key: 'test/two.grd' })
  ok(rAll.grd.beams === 2 && rAll.dT[0] === r1.dT[0] && rAll.dT[2] > 1.2 * r1.dT[2], '⑤d 缺省两波束取最大包络（+x 侧 = 单波束件逐位相同；−x 侧 1 号波束抬上来）')
  const rb1 = await run5({ kind: 'grd', key: 'test/two.grd', beamIndex: 1 })
  const rk1 = await run5({ kind: 'grd', key: 's|two', ant: { found: true, file: 'test/two.grd', cfg: { keptSets: [1] } } })
  ok(rb1.grd.beams === 1 && sameArr(rb1.dT, rk1.dT), '⑤d beamIndex 1 = 3D 页存活波束 keptSets [1]')
  const mir = (d) => 0.5 * patG([-d[0], d[1], d[2]])
  L5.forEach((s, k) => near(rb1.dT[k], expectFrame(s.t, s.r, basisFromAxes(s.r, s.bore, s.up, 0), mir, F5, TS5), 0.01, `⑤d 只取 1 号波束（镜像 −3 dB）第 ${k + 1} 拍与解析积分一致`))
  const rbx = await run5({ kind: 'grd', key: 'test/two.grd', beamIndex: 2 })
  ok(rbx.code === 'grd-bad' && /越界/.test(rbx.error), '⑤d 波束序号越界 → grd-bad')
  const xr = await run5({ kind: 'grd', key: 's|xp', ant: { found: true, file: 'test/xp.grd', cfg: { pol: 'P1/P2' } } })
  const x1 = await run5({ kind: 'grd', key: 'test/xp.grd', pol: 'P1' })
  ok(sameArr(x1.dT, r1.dT), "⑤d pol:'P1' 只取第一分量（= 单极化件逐位相同）")
  L5.forEach((_, k) => near(xr.dT[k] / x1.dT[k], 1.1, 1e-3, `⑤d 缺省两分量功率和（3D 页的 P1/P2 比值档不用）：第 ${k + 1} 拍 ΔT × 1.1`))
}

// ⑤e up 退化
{
  const s = L5[0]
  const z = nrm(s.bore)
  const x = nrm(cross([0, 0, 1], z)), yDef = cross(z, x)
  const bf = basisFromAxes(s.r, s.bore, [0, 0, 0], 0)
  ok(Math.hypot(...add(bf.y, yDef, -1)) < 1e-12, '⑤e 补的 up = basisFromAxes 退化口径的 y')
  const rDef = await run5({ kind: 'grd', key: 'test/ell.grd' }, [{ ...s, up: yDef }])
  const arrZ = pack([{ ...s, up: [0, 0, 0] }])
  const rZ = await call('sunoutage:satIntrusion', { samples: arrZ, freqGHz: F5, sysTempK: TS5, pattern: { kind: 'grd', key: 'test/ell.grd' } })
  const rP = await run5({ kind: 'grd', key: 'test/ell.grd' }, [{ ...s, up: sc(s.bore, -3) }])
  ok(rZ.counts.upDefault === 1 && rP.counts.upDefault === 1 && rDef.counts.upDefault === 0, '⑤e 零向量 / 与视轴平行的 up 各补一次，正常的不补')
  ok(rZ.dT[0] === rP.dT[0], '⑤e 零向量与平行两种退化补出来逐位相同')
  near(rZ.dT[0], rDef.dT[0], 1e-12, '⑤e 与显式给那组 up 一致')
  ok(arrZ[7] === 0 && arrZ[8] === 0 && arrZ[9] === 0, '⑤e 调用方的样本数组不改')
  const gz = await call('sunoutage:satIntrusion', { samples: pack([{ ...s, up: [0, 0, 0] }]), freqGHz: F5, sysTempK: TS5, pattern: { kind: 'gauss', thetaB3dB: 2 } })
  ok(gz.ok && gz.counts.upDefault === 1, '⑤e 高斯档照样收退化 up（不用它，也不拒）')
}

// ⑧ 取消 / 顶替 / 时间片
const geoSeries = (t0, n, stepMs, bore = null) => {
  const L = 125 * D2R, r = [RGEO * Math.cos(L), RGEO * Math.sin(L), 0], b = bore || [-Math.cos(L), -Math.sin(L), 0]
  const S = new Float64Array(n * 10)
  for (let i = 0; i < n; i++) { const k = i * 10; S[k] = t0 + i * stepMs; S[k + 1] = r[0]; S[k + 2] = r[1]; S[k + 3] = r[2]; S[k + 4] = b[0]; S[k + 5] = b[1]; S[k + 6] = b[2]; S[k + 9] = 1 }
  return S
}
{
  const BIG = geoSeries(Date.UTC(2026, 0, 1), 200000, 60e3), SMALL = geoSeries(Date.UTC(2026, 3, 14), 1441, 60e3)
  const gp = { kind: 'gauss', thetaB3dB: 17.4 }
  const h = handlers.get('sunoutage:satIntrusion')
  const p1 = h({ sender: { id: 3 } }, { samples: BIG, freqGHz: 6, pattern: gp })
  const p2 = h({ sender: { id: 3 } }, { samples: SMALL, freqGHz: 6, pattern: gp })
  const [r1, r2] = await Promise.all([p1, p2])
  ok(r1.ok === false && r1.code === 'canceled' && r1.canceled === true && r2.ok === true, `⑧ 同窗同键（缺省 default）新请求顶掉旧的（${r1.error}）`)
  const p3 = h({ sender: { id: 3 } }, { samples: SMALL, freqGHz: 6, pattern: gp, jobKey: 'a' })
  const p4 = h({ sender: { id: 3 } }, { samples: SMALL, freqGHz: 6, pattern: gp, jobKey: 'b' })
  const p5 = h({ sender: { id: 4 } }, { samples: SMALL, freqGHz: 6, pattern: gp, jobKey: 'a' })
  const rr = await Promise.all([p3, p4, p5])
  ok(rr.every((x) => x.ok === true) && sameArr(rr[0].dT, rr[1].dT) && sameArr(rr[0].dT, rr[2].dT), '⑧ 不同键 / 不同窗口互不顶替')
  const cancelH = handlers.get('sunoutage:satIntrusionCancel')
  const p6 = h({ sender: { id: 3 } }, { samples: BIG, freqGHz: 6, pattern: gp, jobKey: 'x' })
  const c0 = await cancelH({ sender: { id: 3 } }, 'x')
  const r6 = await p6
  ok(r6.code === 'canceled' && c0 === true, '⑧ sunoutage:satIntrusionCancel 取消在算的任务')
  ok((await cancelH({ sender: { id: 3 } }, 'x')) === false && (await cancelH({ sender: { id: 4 } }, 'nope')) === false, '⑧ 取消完再取消 / 没有这个任务 → false')
  const { EventEmitter } = await import('node:events')
  const wc = new EventEmitter(); wc.id = 9
  const p7 = h({ sender: wc }, { samples: BIG, freqGHz: 6, pattern: gp })
  setImmediate(() => wc.emit('destroyed'))
  const r7 = await p7
  ok(r7.code === 'canceled' && wc.listenerCount('destroyed') === 0, '⑧ 发起窗口销毁 → 停算、监听摘干净')
  const r8 = await h({ sender: wc }, { samples: SMALL, freqGHz: 6, pattern: gp })
  ok(r8.ok === true && wc.listenerCount('destroyed') === 0, '⑧ 正常算完也不留监听')

  // 时间片：一个月 60 s、GEO 天底全球波束 GRD（uv ±0.99 宽网格，太阳大半时间在网格内）
  const TBG = 17.4 * D2R, GG = 16 * Math.LN2 / (TBG * TBG)
  writeGrd('test/wide.grd', 1, [{ XS: -0.99, YS: -0.99, XE: 0.99, YE: 0.99, NX: 121, NY: 121, field: (u, v) => { const w2 = 1 - u * u - v * v; return [w2 > 0 ? Math.sqrt(GG * Math.exp(-4 * Math.LN2 * (Math.acos(Math.sqrt(w2)) / TBG) ** 2)) : 0, 0] } }])
  const MON = geoSeries(Date.UTC(2026, 2, 1), 30 * 1440 + 1, 60e3)
  let gap = 0, last = performance.now()
  const mon = setInterval(() => { const t = performance.now(); gap = Math.max(gap, t - last); last = t }, 2)
  const t0 = performance.now()
  const rw = await call('sunoutage:satIntrusion', { samples: MON, freqGHz: 6, sysTempK: 500, pattern: { kind: 'grd', key: 'test/wide.grd' } })
  const ms = performance.now() - t0
  clearInterval(mon)
  ok(rw.ok === true && rw.counts.gain > 10000, `⑧ 一个月 GRD 宽网格算得出（${rw.counts.gain} 拍走实测方向图，${ms.toFixed(0)} ms）`)
  ok(gap < 150, `⑧ 计算期间事件循环最长停顿 ${gap.toFixed(0)} ms（< 150）`)
  if (process.env.SATSUN_VERBOSE) console.log(`  一个月 GRD 宽网格：${ms.toFixed(0)} ms，最长停顿 ${gap.toFixed(1)} ms，counts ${JSON.stringify(rw.counts)}`)
}

// ⑦ models:saveMask / getMask / exportTable 经 handler
{
  const K = await import(pathToFileURL(ROOT + '/packages/core/models/mask.mjs').href)
  const m = K.boxMask({ min: [-1, -1, 0.5], max: [1, 1, 2] }, [0, 0, 0])
  const sig = K.maskSignature({ modelSha: 'ab'.repeat(32), lod: 'lod1', mountPos: [0, 0, 0], mountBoresight: [0, 0, 1] })
  const r = await call('models:saveMask', { sig, bytes: K.encodeMask(m) })
  ok(r.ok === true && r.sig === sig && r.bytes === K.MASK_BYTES, '⑦ saveMask 经 handler 落盘')
  const back = await call('models:getMask', sig)
  ok(back instanceof Uint8Array && K.decodeMask(back).blocked.every((v, i) => v === m.blocked[i]), '⑦ getMask 取回逐格相同')
  ok((await call('models:getMask', '../evil')) === null, '⑦ 非法签名 → null')
  saveTo.path = path.join(TMP, 'out.xlsx')
  const ex = await call('models:exportTable', { defaultName: '星侧太阳侵入', sheets: [{ name: '时间序列', cols: [{ key: 't', label: '时刻' }, { key: 'dT', label: 'ΔT', unit: 'K', num: true, fix: 2 }], rows: [{ t: '2026-03-20 12:00', dT: 12.345 }] }] })
  ok(ex.ok === true && fs.existsSync(saveTo.path) && fs.statSync(saveTo.path).size > 1000, '⑦ exportTable 经 handler 写出 xlsx')
}

// ⑨ 真 preload（假 contextBridge 收下 api，invoke 直通 handler）
{
  const store = new Map()
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null) }
  require(ROOT + '/electron/preload.js')
  const api = preloadApi
  ok(api && typeof api.sunOutage.satIntrusion === 'function' && typeof api.sunOutage.cancelSatIntrusion === 'function', '⑨ preload 暴露 satIntrusion / cancelSatIntrusion')
  // folder|name → 3D 页卫星树（与 useGrdCoverage.getState 同形）；cfg 只取 yaw / gainOffset / keptSets，别的绘制项与 3D 页极化档不带
  store.set('globe3d/settings', JSON.stringify({ view: { any: 1 }, grd: {
    sats: [{ folder: 'sat1', satName: '甲', antennas: [{ name: 'ell', file: 'test/ell.grd', imported: true, beams: 1 }, { name: 'two', file: 'test/two.grd', imported: true, beams: 2 }, { name: 'nofile', imported: true }] }],
    cfgs: { 'sat1|ell': { yaw: YAW, gainOffset: 0, keptSets: null, pol: 'P1/P2', levels: [{ v: -3 }], boreType: 'att' }, 'sat1|two': { keptSets: [1], yaw: 0 } }
  } }))
  const req = (pattern, list = L5) => ({ samples: pack(list), freqGHz: F5, sysTempK: TS5, pattern })
  const ry = await run5({ kind: 'grd', key: 'x|ell', ant: { found: true, file: 'test/ell.grd', cfg: { yaw: YAW } } })
  const rp = await api.sunOutage.satIntrusion(req({ kind: 'grd', key: 'sat1|ell' }))
  ok(rp.ok && sameArr(rp.dT, ry.dT) && rp.grd.file === 'test/ell.grd', '⑨ folder|name 经 preload 解析 = 直接给文件 + Rot（3D 页该天线的设置）')
  const rk = await api.sunOutage.satIntrusion(req({ kind: 'grd', key: 'sat1|two' }))
  const rb1 = await run5({ kind: 'grd', key: 'test/two.grd', beamIndex: 1 })
  ok(rk.ok && rk.grd.beams === 1 && sameArr(rk.dT, rb1.dT), '⑨ 3D 页删过波束（keptSets [1]）照样带过去')
  const n1 = await api.sunOutage.satIntrusion(req({ kind: 'grd', key: 'sat1|none' }))
  const n2 = await api.sunOutage.satIntrusion(req({ kind: 'grd', key: 'sat1|nofile' }))
  store.delete('globe3d/settings')
  const n3 = await api.sunOutage.satIntrusion(req({ kind: 'grd', key: 'sat1|ell' }))
  ok([n1, n2, n3].every((x) => x.ok === false && x.code === 'grd-unresolved'), `⑨ 找不到 / 没文件 / 3D 页从没存过 → grd-unresolved（${n1.error} / ${n2.error}）`)

  // 分段：30 万拍（> 262 144）→ 两段拼回，与一次算完逐位相同
  const N = 300000
  const S = geoSeries(Date.UTC(2026, 0, 1), N, 60e3)
  const direct = await call('sunoutage:satIntrusion', { samples: S, freqGHz: 6, sysTempK: 500, pattern: { kind: 'gauss', thetaB3dB: 17.4 } })
  const prog = []
  const seg = await api.sunOutage.satIntrusion({ samples: S, freqGHz: 6, sysTempK: 500, pattern: { kind: 'gauss', thetaB3dB: 17.4 }, onProgress: (d, n) => prog.push([d, n]) })
  ok(direct.ok && seg.ok && seg.n === N, '⑨ 30 万拍：preload 分段算得出')
  ok(['dT', 'gtLossDb', 'offAxisDeg', 'visibleFrac'].every((k) => seg[k] instanceof Float32Array && sameArr(seg[k], direct[k])), '⑨ 分段拼回的四条序列与一次算完逐位相同')
  assert.deepEqual([seg.worst, seg.counts, seg.f107], [direct.worst, direct.counts, direct.f107]); pass++
  ok(JSON.stringify(prog) === JSON.stringify([[262144, N], [N, N]]), `⑨ onProgress 逐段报（${JSON.stringify(prog)}）`)
  // 段间顶替：同键新请求一来，旧的在下一段之前就停
  const q1 = api.sunOutage.satIntrusion({ samples: S, freqGHz: 6, pattern: { kind: 'gauss', thetaB3dB: 17.4 } })
  const q2 = api.sunOutage.satIntrusion({ samples: S.subarray(0, 14410), freqGHz: 6, pattern: { kind: 'gauss', thetaB3dB: 17.4 } })
  const [a1, a2] = await Promise.all([q1, q2])
  ok(a1.ok === false && a1.canceled === true && a2.ok === true && a2.n === 1441, '⑨ 同键新请求顶掉在算的旧请求（旧的回 canceled）')
  // 显式取消（分段中途）
  const q3 = api.sunOutage.satIntrusion({ samples: S, freqGHz: 6, pattern: { kind: 'gauss', thetaB3dB: 17.4 }, jobKey: 'k9', onProgress: () => { api.sunOutage.cancelSatIntrusion('k9') } })
  const a3 = await q3
  ok(a3.ok === false && a3.canceled === true, '⑨ cancelSatIntrusion：第一段报完进度就取消 → 第二段不再发')
  const a4 = await api.sunOutage.satIntrusion({ samples: S.subarray(0, 14410), freqGHz: 6, pattern: { kind: 'gauss', thetaB3dB: 17.4 }, jobKey: 'k9' })
  ok(a4.ok === true, '⑨ 取消过的键下一次照常算')

  // exportTable：大表按列打包，写出的格子与逐行传（旧口径 = JSON 深拷）逐位相同
  const ExcelJS = require('exceljs')
  const rows = Array.from({ length: 2600 }, (_, i) => ({ t: `2026-03-20 ${i}`, dT: i % 7 ? i / 3 : NaN, gl: i % 11 ? -i / 9 : (i % 2 ? -0 : Infinity), s: i % 3 ? String(i * 2) : null, m: i % 5 ? i : '中文' }))
  const cols = [{ key: 't', label: '时刻' }, { key: 'dT', label: 'ΔT', unit: 'K', num: true, fix: 2 }, { key: 'gl', label: 'ΔG/T', unit: 'dB', num: true }, { key: 's', label: '串数', num: true }, { key: 'm', label: '混合' }]
  const orig = handlers.get('models:exportTable')
  let seen = null
  handlers.set('models:exportTable', (e, o) => { seen = o; return orig(e, o) })
  saveTo.path = path.join(TMP, 'wire-b.xlsx')
  const wB = await api.models.exportTable({ defaultName: 'w', sheets: [{ name: '序列', cols, rows }, { name: '小表', cols, rows: rows.slice(0, 5) }] })
  handlers.set('models:exportTable', orig)
  const c0 = seen && seen.sheets[0].columns
  ok(wB.ok && seen.sheets[0].n === 2600 && !seen.sheets[0].rows && c0[1] instanceof Float64Array && c0[2] instanceof Float64Array && typeof c0[0].join === 'string' && typeof c0[3].join === 'string' && Array.isArray(c0[4]) && Array.isArray(seen.sheets[1].rows), '⑨ exportTable：> 2000 行的表按列打包（数列 Float64Array、串列连成一个长串、混合列普通数组），小表照旧')
  saveTo.path = path.join(TMP, 'wire-a.xlsx')
  const wA = await call('models:exportTable', JSON.parse(JSON.stringify({ defaultName: 'w', sheets: [{ name: '序列', cols, rows }, { name: '小表', cols, rows: rows.slice(0, 5) }] })))
  saveTo.path = null
  const [xa, xb] = [new ExcelJS.Workbook(), new ExcelJS.Workbook()]
  await xa.xlsx.readFile(path.join(TMP, 'wire-a.xlsx')); await xb.xlsx.readFile(path.join(TMP, 'wire-b.xlsx'))
  let diff = 0
  xa.worksheets.forEach((sa, si) => { const sb = xb.worksheets[si]; sa.eachRow({ includeEmpty: true }, (row, r) => { for (let c = 1; c <= 5; c++) if (JSON.stringify(row.getCell(c).value) !== JSON.stringify(sb.getRow(r).getCell(c).value)) diff++ }) })
  ok(wA.ok && diff === 0 && xa.worksheets[0].rowCount === 2601, `⑨ 按列打包与逐行传写出的格子逐位相同（不同 ${diff} 格）`)
  delete globalThis.localStorage
}

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* Windows 句柄晚放 */ }
console.log(`modelSatIntrusionIpc: ${pass} 项通过`)
