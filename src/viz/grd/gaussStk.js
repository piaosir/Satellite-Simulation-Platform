// 解析高斯天线（STK Gaussian 天线模型）：参数化方向图 —— 存参数、不存网格文本。
//
// 模型（AGI STK Comm「Gaussian」，help.agi.com/stk/Content/comm/GaussianAntenna.htm，已用 STK 官方读数逐位核实）：
//   g(θ) = η·(πD/λ)² · exp(−k·(θ/θ3)²)，θ = 偏离视轴的真实锥角（rad，不是 sinθ），θ3 = 3 dB 全宽
//   θ3 = λ/(D·√η)（rad）→ 恒等式 G0·θ3² ≡ π²，与效率无关
//   k = 2.76（STK 原式；θ3/2 处 −2.99663 dB）｜ 4ln2（严格半功率，θ3/2 处 −3.0103 dB，SATSOFT 同款）
//   背瓣：θ > 90° 取常数 back（dBi，绝对值）；θ ≤ 90° 纯高斯、无地板
//   三驱动：口径 D｜波束宽 θ3｜峰值增益 G，另两项由上式算出（STK InputType 同款）
//
// 与旧「多馈源组」高斯（synth.buildGaussGrd）的差别：那边在【天底 az/el 网格坐标】里算 (Δaz, Δel)，
// el 向真实角宽被压成 θ·cos(az0)（GEO 地平边缘 −1.2%，LEO 偏轴 40° −23%）；这里按【各波束自身视轴】
// 的真实离轴角算，任何指向都没有这项模型误差。
//
// 存盘 = 一份小 JSON（*.gauss.json，每波束百来字节）。渲染端与主进程各自按参数现场铺网格（给填充 / 等值线
// 三角化 / 主进程 .grdbin 的数组消费者用），取值走闭式精确式（coverage.samplePowAt 与 grdSampler.sampleBeamAt
// 的解析分支）。主进程 CommonJS 镜像：packages/core/utils/gaussStk.js（改这里的求值 / 铺网格要两处对照，
// packages/core/test/gaussStk.test.mjs 逐位对拍）。
import { A, B, rayEllipsoidMargin, ecefToGeodetic } from '../wgs84.js'

export const C0 = 299792458                       // 光速 m/s（STK 读数用 299 792 458 才对得上，3e8 对不上）
export const K_STK = 2.76
export const K_4LN2 = 4 * Math.LN2
export const AN_FORMAT = 'satsim-analytic-antenna'
export const AN_FILE_EXT = '.gauss.json'
export const AN_WIN = 2.0                          // 网格窗口半宽 = 2θ3（STK 系数下窗边 ≈ −47.9 dB）；也是取值域
const D2R = Math.PI / 180

export const kOf = (kind) => (kind === '4ln2' ? K_4LN2 : K_STK)
export const kDbOf = (kind) => 10 * Math.LOG10E * kOf(kind)      // 相对电平 = −kDb·(θ/θ3)²（dB）

// 单个方向图模型的出厂值 = STK Gaussian 默认（14.5 GHz / 1 m / 55% / 背瓣 −30 dBi）
export const STK_MODEL_DEFAULT = Object.freeze({ fGHz: 14.5, drv: 'D', D: 1, bw3: 1.59732757, G: 41.03757033, eff: 55, back: -30, k: 'stk' })
export const freshModel = (over = {}) => ({ ...STK_MODEL_DEFAULT, ...over })

// STK 三驱动求解。返回 { ok, lamM, Dm, th3Rad, th3Deg, g0Lin, g0Dbi, effPct }；非法输入 { ok:false, err }。
//   D（口径）：G = η(πD/λ)²，θ3 = λ/(D√η)
//   bw（波束宽）：D = λ/(θ3√η)，G = π²/θ3²（效率被约掉）
//   G（峰值增益）：θ3 = π/√G，D = (λ/π)·√(G/η)
export function solveStk(m) {
  const f = +m.fGHz, e = +m.eff / 100
  if (!(f > 0)) return { ok: false, err: 'freq' }
  if (!(e > 0 && e <= 1)) return { ok: false, err: 'eff' }
  const lam = C0 / (f * 1e9)
  let Dm, th, g
  if (m.drv === 'bw') {
    th = +m.bw3 * D2R
    if (!(th > 0 && th < Math.PI)) return { ok: false, err: 'bw3' }
    Dm = lam / (th * Math.sqrt(e)); g = (Math.PI / th) ** 2
  } else if (m.drv === 'G') {
    g = Math.pow(10, +m.G / 10)
    if (!(g > 1)) return { ok: false, err: 'G' }
    th = Math.PI / Math.sqrt(g); Dm = (lam / Math.PI) * Math.sqrt(g / e)
  } else {
    Dm = +m.D
    if (!(Dm > 0)) return { ok: false, err: 'D' }
    g = e * (Math.PI * Dm / lam) ** 2; th = lam / (Dm * Math.sqrt(e))
    if (!(th < Math.PI)) return { ok: false, err: 'D' }
  }
  return { ok: true, lamM: lam, Dm, th3Rad: th, th3Deg: th / D2R, g0Lin: g, g0Dbi: 10 * Math.log10(g), effPct: e * 100 }
}

// 把模型的三个驱动量按求解结果回写（非驱动项 = 算出值），供 UI 双向显示。返回新对象，不改入参。
export function syncModel(m) {
  const r = solveStk(m); if (!r.ok) return { ...m }
  return { ...m, D: m.drv === 'D' ? +m.D : r.Dm, bw3: m.drv === 'bw' ? +m.bw3 : r.th3Deg, G: m.drv === 'G' ? +m.G : r.g0Dbi }
}

// 三驱动量在界面上的小数位（非驱动项按此显示算出值；GaussModelFields 与 promoteDrv 共用这一份，别各写各的）
export const DRV_DIGITS = Object.freeze({ D: 4, bw: 4, G: 2 })
// 切输入量（驱动项）：先按当前驱动把三项拉齐，再把【新驱动项】圆到它刚才显示的位数 —— 从此它是给定值、原样显示，
// 不圆就成了 1.5973275724744727 这种 17 位浮点（存盘也带着）。另两项随圆过的驱动重算，只在最后一位显示位之后动。
// 圆完不再合法（极小值圆成 0）→ 保留原值。返回新对象，不改入参。
export function promoteDrv(m, d) {
  const drv = d === 'bw' || d === 'G' ? d : 'D'
  const s = syncModel(m)
  const key = drv === 'bw' ? 'bw3' : drv
  const v = +s[key]
  if (Number.isFinite(v)) {
    const q = +v.toFixed(DRV_DIGITS[drv])
    const t = { ...s, drv, [key]: q }
    if (solveStk(t).ok) return syncModel(t)
  }
  return syncModel({ ...s, drv })
}

// igrid 6（Az over El）网格坐标 → 天线系单位矢量（与 coverage.gridDir(6,…) 逐字同式；此处自带一份免循环依赖）
function dir6(Xdeg, Ydeg) {
  const az = Xdeg * D2R, el = Ydeg * D2R, ca = Math.cos(az)
  return [-Math.sin(az), ca * Math.sin(el), ca * Math.cos(el)]
}

// ---------------- 记录（*.gauss.json） ----------------
// {
//   format:'satsim-analytic-antenna', v:1, model:'gaussian', win:2,
//   sat:{ name, lon, lat, altKm }          生成时刻的星位（只作记录；取值只看 beams）
//   owner:null | { kind:'beamsynth', groupId }   波束合成组的产物 → 覆盖分析侧只读
//   models:[{ id, name, fGHz, drv, D, bw3, G, eff, back, k }]   输入参数（界面编辑的就是这份）
//   beams:[{ name, az, el, model, th3, g0, k, back }]           逐波束已解析量（求值只认这几项）
// }
// beams[].az/el = 视轴在天线系 igrid-6 网格里的坐标（°）；th3 = 3 dB 全宽（°）；g0 = 峰值增益（dBi）；
// k = 'stk' | '4ln2'；back = 背瓣增益（dBi）。
export function buildRecord({ sat = null, models, beams, owner = null, win = AN_WIN }) {
  const mm = new Map()
  for (const m of models || []) {
    const r = solveStk(m)
    if (!r.ok) throw new Error(`方向图参数无效（${m.name || m.id || ''}）`)
    mm.set(m.id, { m, r })
  }
  const out = []
  for (const b of beams || []) {
    const hit = mm.get(b.model) || (mm.size === 1 ? mm.values().next().value : null)
    if (!hit) throw new Error('波束引用的方向图模型不存在')
    const az = +b.az, el = +b.el
    if (!Number.isFinite(az) || !Number.isFinite(el)) throw new Error('波束视轴坐标无效')
    out.push({ name: b.name || '', az, el, model: hit.m.id, th3: hit.r.th3Deg, g0: hit.r.g0Dbi, k: hit.m.k === '4ln2' ? '4ln2' : 'stk', back: Number.isFinite(+hit.m.back) ? +hit.m.back : -30 })
  }
  if (!out.length) throw new Error('尚无波束')
  return {
    format: AN_FORMAT, v: 1, model: 'gaussian', win: +win > 0 ? +win : AN_WIN,
    sat: sat ? { name: String(sat.name || ''), lon: +sat.lon, lat: +(sat.lat || 0), altKm: +sat.altKm } : null,
    owner: owner ? { ...owner } : null,
    models: (models || []).map((m) => ({ id: m.id, name: m.name || '', fGHz: +m.fGHz, drv: m.drv === 'bw' || m.drv === 'G' ? m.drv : 'D', D: +m.D, bw3: +m.bw3, G: +m.G, eff: +m.eff, back: +m.back, k: m.k === '4ln2' ? '4ln2' : 'stk' })),
    beams: out
  }
}

// 记录 → 存盘文本。非 ASCII 一律转 \uXXXX：存盘管线按 latin1 逐字节写 / 读（coverage.save / raw），
// 纯 ASCII 才能原样往返，主进程读到的星名 / 模型名也不乱码。
export function recordToText(rec) {
  const s = JSON.stringify(rec)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out += c < 0x7f ? s[i] : '\\u' + c.toString(16).padStart(4, '0')   // 代理对逐个 UTF-16 单元转义，JSON 合法
  }
  return out
}

export function isAnalyticText(text) {
  if (typeof text !== 'string') return false
  const t = text.trimStart()
  return t.charAt(0) === '{' && t.indexOf(AN_FORMAT) >= 0
}
// 文本 → 记录（校验）。非本格式或损坏抛错。
export function parseRecord(text) {
  const r = JSON.parse(text)
  if (!r || r.format !== AN_FORMAT || !Array.isArray(r.beams) || !r.beams.length) throw new Error('不是解析天线记录')
  for (const b of r.beams) {
    if (![b.az, b.el, b.th3, b.g0, b.back].every((v) => Number.isFinite(+v)) || !(+b.th3 > 0)) throw new Error('解析天线记录损坏')
  }
  return r
}

// ---------------- 求值 ----------------
// 逐波束求值描述子（记录 → 预算量）：视轴单位矢量 + 1/θ3² + dB 系数。igrid 恒 6。
export function anBeamOf(b, win = AN_WIN) {
  const ax = dir6(+b.az, +b.el), th = +b.th3 * D2R
  return { igrid: 6, az: +b.az, el: +b.el, th3: +b.th3, g0: +b.g0, back: +b.back, k: b.k === '4ln2' ? '4ln2' : 'stk',
    bx: ax[0], by: ax[1], bz: ax[2], inv: 1 / (th * th), kdb: kDbOf(b.k), win: +win > 0 ? +win : AN_WIN }
}
export const anBeams = (rec) => rec.beams.map((b) => anBeamOf(b, rec.win))

// 天线系单位矢量 (ux,uy,uz) 方向的增益（dBi）。θ 用 atan2(|u×b|, u·b)：小角度处比 acos 精确。
export function anGainDbi(an, ux, uy, uz) {
  const c = ux * an.bx + uy * an.by + uz * an.bz
  const cx = uy * an.bz - uz * an.by, cy = uz * an.bx - ux * an.bz, cz = ux * an.by - uy * an.bx
  const th = Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), c)
  if (th > Math.PI / 2) return an.back
  return an.g0 - an.kdb * th * th * an.inv
}
// igrid-6 网格坐标 (X,Y)（°）处的增益（dBi）
export function anGainDbiXY(an, X, Y) {
  const az = X * D2R, el = Y * D2R, ca = Math.cos(az)
  return anGainDbi(an, -Math.sin(az), ca * Math.sin(el), ca * Math.cos(el))
}

// ---------------- 铺网格（给数组消费者） ----------------
// 分辨率随波束数降档（与 buildGaussGrd 同表：总点数 n·res² 控制在 ~2M 内）
export const resFor = (n) => (n <= 4 ? 101 : n <= 16 ? 81 : n <= 48 ? 61 : n <= 120 ? 49 : n <= 400 ? 37 : n <= 1200 ? 29 : 23)

// 波束窗口（igrid-6 坐标，°）：必须罩住以视轴为心、真实角半径 R = win·θ3 的整个锥。
//   X（=az）是「纬度型」坐标：|ΔX| ≤ 真实角距 → X ∈ [az0−R, az0+R]
//   Y（=el）的度量被 cos(X) 压缩：|ΔY| ≤ R / cos(|az0|+R) → 取这个保守半宽；越过 ±89.9° 钳住
export function anWindow(an) {
  const R = an.win * an.th3
  const XS = Math.max(-89.9, an.az - R), XE = Math.min(89.9, an.az + R)
  const xm = Math.min(89.9, Math.abs(an.az) + R)
  const hy = R / Math.cos(xm * D2R)
  const YS = Math.max(-179.9, an.el - hy), YE = Math.min(179.9, an.el + hy)
  return { XS, YS, XE, YE }
}

const _zeros = new Map()     // 同尺寸共用一条只读零数组（复场第 2 分量 / 虚部恒 0）
function zeros(n) { let z = _zeros.get(n); if (!z) { z = new Float32Array(n); _zeros.set(n, z) } return z }

// 单个波束 → parseGrd 同形的 set（节点值 = 闭式精确值）+ an 描述子
export function materializeBeam(an, res) {
  const { XS, YS, XE, YE } = anWindow(an)
  const NX = res, NY = res, N = NX * NY
  const dx = (XE - XS) / (NX - 1), dy = (YE - YS) / (NY - 1)
  const P1 = new Float32Array(N), c1re = new Float32Array(N)
  let peakLin = -Infinity, peakIdx = 0
  for (let row = 0; row < NY; row++) {
    const el = (YS + dy * row) * D2R, se = Math.sin(el), ce = Math.cos(el)
    for (let col = 0; col < NX; col++) {
      const az = (XS + dx * col) * D2R, ca = Math.cos(az)
      const p = Math.pow(10, anGainDbi(an, -Math.sin(az), ca * se, ca * ce) / 10)
      const i = row * NX + col
      P1[i] = p; c1re[i] = Math.sqrt(p)
      if (p > peakLin) { peakLin = p; peakIdx = i }
    }
  }
  const z = zeros(N)
  return { XS, YS, XE, YE, NX, NY, P1, P2: z, c1re, c1im: z, c2re: z, c2im: z, peakLin, peakIdx, an }
}

// 记录 → parseGrd 同形对象（ktype/icomp/ncomp/igrid 与合成 GRD 一致：icomp=3 co/cx、ncomp=2、igrid=6）
export function materialize(rec, opts = {}) {
  const ans = anBeams(rec)
  const res = opts.res || resFor(ans.length)
  return { ktype: 1, nset: ans.length, icomp: 3, ncomp: 2, igrid: 6, sets: ans.map((an) => materializeBeam(an, res)) }
}

// ---------------- 导出：GRASP ASCII 文本 ----------------
// 与 buildGaussGrd 同形（逐波束各自窗口 + SYNTHMETA kind:'gauss'），文件管理的 GRD / STK / ACP4 导出与
// SATSOFT 公共网格重打包照原路走。表头只许 ASCII。
function fexp(v, digits = 10) {
  if (!Number.isFinite(v)) v = 0
  if (v === 0) return '0.' + '0'.repeat(digits) + 'E+00'
  const neg = v < 0, a = Math.abs(v)
  let e = Math.floor(Math.log10(a)) + 1
  let ms = (a / Math.pow(10, e)).toFixed(digits)
  if (ms.charAt(0) !== '0') { e += 1; ms = (a / Math.pow(10, e)).toFixed(digits) }
  else if (parseFloat(ms) < 0.1) { e -= 1; ms = (a / Math.pow(10, e)).toFixed(digits) }
  return (neg ? '-' : '') + ms + 'E' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0')
}
const asciiSafe = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim()
export function toGrdText(rec, opts = {}) {
  const g = materialize(rec, opts)
  const s = rec.sat || {}
  const sn = asciiSafe(s.name)
  let th3Min = Infinity
  for (const b of rec.beams) if (+b.th3 > 0 && +b.th3 < th3Min) th3Min = +b.th3
  const head = [
    `SatSim analytic pattern (STK Gaussian antenna model)${sn ? ' - ' + sn : ''}${Number.isFinite(s.lon) ? `. Sat. lon=${(+s.lon).toFixed(2)}, lat=${(+(s.lat || 0)).toFixed(2)}, height=${Math.round(+s.altKm || 0)} km` : ''}, beams=${g.nset}`,
    `SYNTHMETA ${JSON.stringify({ kind: 'gauss', model: 'stk', ...(Number.isFinite(s.lon) ? { satLon: +(+s.lon).toFixed(4), satLat: +(+(s.lat || 0)).toFixed(4), altKm: Math.round(+s.altKm || 0) } : {}), ...(Number.isFinite(th3Min) ? { theta3: +th3Min.toFixed(4) } : {}), win: rec.win || AN_WIN, nBeams: g.nset })}`,
    '++++', '1', ` ${g.nset} 3 2 6`
  ]
  for (let i = 0; i < g.nset; i++) head.push('  0  0')
  const parts = [head.join('\r\n')]
  const z = fexp(0)
  for (const st of g.sets) {
    const L = new Array(st.NX * st.NY + 2)
    L[0] = ` ${fexp(st.XS)} ${fexp(st.YS)} ${fexp(st.XE)} ${fexp(st.YE)}`
    L[1] = ` ${st.NX} ${st.NY} 0`
    for (let i = 0; i < st.NX * st.NY; i++) L[i + 2] = ` ${fexp(st.c1re[i])} ${z} ${z} ${z}`
    parts.push(L.join('\r\n'))
  }
  return parts.join('\r\n') + '\r\n'
}

// ---------------- 精确足迹：锥 ∩ WGS-84 ----------------
// S：卫星 ECEF（km）；axis：视轴单位矢量（ECEF）；alpha：锥半角（rad）。
// 逐方位射线闭式求交；越过地平的方位落到该方位半平面与可见地平的交点（与 coverage.limbPoint 同一解析式），
// 故轮廓在地平处连续不断。相邻两点的弦中点离真实曲线超过 tolKm 就二分加密（临边拉伸处自动变密）。
// 返回 { ring:[[lon,lat],…] 闭合, hits: 命中椭球的点数, n: 总点数 }。
export function coneFootprint(S, axis, alpha, { n = 96, tolKm = 0.2, maxDepth = 8 } = {}) {
  const b = axis
  const ref = Math.abs(b[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  let e1 = [b[1] * ref[2] - b[2] * ref[1], b[2] * ref[0] - b[0] * ref[2], b[0] * ref[1] - b[1] * ref[0]]
  const l1 = Math.hypot(e1[0], e1[1], e1[2]); e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1]
  const e2 = [b[1] * e1[2] - b[2] * e1[1], b[2] * e1[0] - b[0] * e1[2], b[0] * e1[1] - b[1] * e1[0]]
  const ca = Math.cos(alpha), sa = Math.sin(alpha)
  const Sn = [S[0] / A, S[1] / A, S[2] / B], rho = Math.hypot(Sn[0], Sn[1], Sn[2]), sh = [Sn[0] / rho, Sn[1] / rho, Sn[2] / rho]
  const kLimb = Math.sqrt(Math.max(0, 1 - 1 / (rho * rho)))
  const at = (phi) => {
    const c = Math.cos(phi), s = Math.sin(phi)
    const d = [ca * b[0] + sa * (c * e1[0] + s * e2[0]), ca * b[1] + sa * (c * e1[1] + s * e2[1]), ca * b[2] + sa * (c * e1[2] + s * e2[2])]
    const r = rayEllipsoidMargin(S, d)
    if (r.m >= 0) return { p: r.p, hit: true }
    const dn = [d[0] / A, d[1] / A, d[2] / B], k0 = dn[0] * sh[0] + dn[1] * sh[1] + dn[2] * sh[2]
    const u = [dn[0] - sh[0] * k0, dn[1] - sh[1] * k0, dn[2] - sh[2] * k0], un = Math.hypot(u[0], u[1], u[2])
    if (!(un > 0)) return { p: r.p, hit: false }
    const k = kLimb / un
    return { p: [(sh[0] / rho + u[0] * k) * A, (sh[1] / rho + u[1] * k) * A, (sh[2] / rho + u[2] * k) * B], hit: false }
  }
  const pts = []
  let hits = 0
  const push = (q) => { pts.push(q); if (q.hit) hits++ }
  const refine = (p0, q0, p1, q1, depth) => {
    if (depth < maxDepth) {
      const pm = (p0 + p1) / 2, qm = at(pm)
      const mx = (q0.p[0] + q1.p[0]) / 2 - qm.p[0], my = (q0.p[1] + q1.p[1]) / 2 - qm.p[1], mz = (q0.p[2] + q1.p[2]) / 2 - qm.p[2]
      if (Math.hypot(mx, my, mz) > tolKm || q0.hit !== q1.hit) {
        refine(p0, q0, pm, qm, depth + 1); push(qm); refine(pm, qm, p1, q1, depth + 1)
      }
    }
  }
  const step = 2 * Math.PI / n
  let prev = at(0); push(prev)
  for (let i = 1; i <= n; i++) {
    const phi = i * step, cur = i === n ? pts[0] : at(phi)
    refine(phi - step, prev, phi, cur, 0)
    if (i < n) push(cur)
    prev = cur
  }
  const ring = pts.map((q) => { const g = ecefToGeodetic(q.p[0], q.p[1], q.p[2]); return [g.lon, g.lat] })
  ring.push(ring[0].slice())
  return { ring, hits, n: pts.length }
}
