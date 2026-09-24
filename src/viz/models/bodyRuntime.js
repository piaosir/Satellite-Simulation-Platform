// 卫星本体运行时（DESIGN2 §4 各接入点共用的一份取数口）：绑定缓存 → 某颗星某一时刻的本体姿态 / 挂点视轴 / 本体遮挡查表。
//
// 谁在用：3D 页的球面图标与跟随（姿态律 / 挂点 HUD）、GRD「姿态 + 挂点」指向（getAttAxes / attEquiv）、对星时段扫描（attAt）。
// 本体遮挡掩模（maskFor / maskSync / blockedAt）是给建模 / 标定工具取数用的：用户 2026-09-24 叫停了遮挡接入分析模块
// （可见性 / 对星性能表 / 星间链路），平台页面现在不查掩模，故掩模【不随绑定预取】（createBodyRuntime({prefetchMasks:true}) 才预取）。
// 姿态 / 挂点 / 掩模的数学全在 packages/core/models：attitude.mjs（五律、挂点系）与 mask.mjs（D2 角坐标、查表、编解码），
// 本文件只做「按 satKey 取绑定 + 拼上下文 + 缓存」。
//
// ── 口径（与 attitude.mjs 同一套，别在调用方各抄一遍）──
//   · 位置 / 速度：ctx.pv = satellite.js / satPos.posAt 的 TEME（km、km/s）+ ctx.gmstRad（该星口径的 GMST）；
//     r、v 只做绕极轴的转动到 ECEF 轴向（与 eciToEcf 同式）——速度是【惯性速度】的 ECEF 分量，不减 ω×r（GEO 的地固速度≈0，
//     定不了沿迹）。没有星历的固定星直接给 ctx.rEcef（km），速度缺省时 attitude.mjs 按 ω⊕ × r（顺行赤道）合成。
//   · 太阳：attitude.sunEcefApprox(ctx.tMs)（与画面晨昏线同一套 Meeus 解，D12）；ctx.sunEcef 给了就用它。
//     ★ 太阳按 ctx.tMs 自己算 GMST，不借 ctx.gmstRad —— 两者只在「星历时刻 ≠ 场景时刻」时才不同，那时太阳该跟场景时刻走。
//   · target 律的目标（params.target）：station → WGS-84 大地坐标转 ECEF；ecef → 原样；sat → 调用方注入的
//     resolveTargetEcef(satKey, tMs)（星历与目录都在页面里，本文件不碰 SGP4 / 目录）。解不到 → attitude.mjs 退回 nadir（fallback）。
//   · 挂点：mountFrame（z = 视轴、y = up 在视轴法平面的投影、x = y × z，D1「up ↔ 天线 +y」）→ mountBasisEcef。
//     mountId 为 '' 时取【缺省挂点】（视轴本体 +Z、up 本体 −Y）——「姿态律 nadir + 缺省挂点」与手动天底逐位相等（D1）。
//   · 掩模（D2 / D18）：mount.maskSig → models.getMask(sig) → decodeMask，按 sig 缓存（一份 .bin 可被多个挂点共用）。
//     查表端走同步的 maskSync / blockedAt（取不到按「不参与」null，并在后台开始取）；要首轮就齐的先 await ensureMasks。
//     对日扫描（D3）的落盘格式在工作台定稿前按 mount.maskSun = {sigs:[12], axisBody:[3], pointingBody:[3]} 认：
//     按当时太阳在本体系里的方向求单轴对日转角（articulationSunAngle）→ sunScanBin → 取那一档；缺哪一档退回 maskSig。
//   · 遮挡判据（D4 / D6）：blockedAt(satKey, mountId, ctx, losEcef) —— 视线（星 → 目标，ECEF 方向）转本体系查表；
//     mountId = '' 表示「全部挂点，任一通视即可」：有掩模的挂点全被挡才算挡；一个有掩模的挂点都没有 → null（不参与）。
//
// 返回值一律是新建的纯数组 / 纯对象（调用方可以缓存、可以过 IPC）；逐拍热路径（图标 / 跟随）传 out 复用。
import { attitudeBasisEcef, makeBasis, sunEcefApprox, gmstRadAt, mountFrame, mountBasisEcef, losToBody, basisToQuatScene, quatMul, articulationSunAngle } from '@core/models/attitude.mjs'
import { decodeMask, maskLookup, sunScanBin, SUN_SCAN_BINS } from '@core/models/mask.mjs'
import { geodeticToEcef } from '../wgs84.js'
import { antennaBasis, dirAzElAbout } from '../grd/coverage.js'

const R2D = 180 / Math.PI
// 验证台注入口（_putMask）只在 vite dev 下挂；打包件与 Node 单测里都没有（单测走假 api.getMask）
const DEV = !!(import.meta.env && import.meta.env.DEV)
const MASK_PREFETCH_MAX = 96         // 一次预取的掩模上限（每张 ~325 KB；真实星十几副天线，这个数远够）
const MASK_CONCURRENCY = 3
const LAWS = ['nadir', 'yawSteer', 'sun', 'inertial', 'target']
/** 缺省挂点（D1）：视轴本体 +Z（天底）、up 本体 −Y（GEO 顺行即正北）——与手动天底档逐位相等的那一副 */
export const DEFAULT_MOUNT = Object.freeze({ id: '', name: '', posBody: Object.freeze([0, 0, 0]), boresightBody: Object.freeze([0, 0, 1]), upBody: Object.freeze([0, -1, 0]) })
const NADIR_ATT = Object.freeze({ law: 'nadir', params: Object.freeze({}) })

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])
const getX = (v) => (v.x !== undefined ? v.x : v[0]), getY = (v) => (v.y !== undefined ? v.y : v[1]), getZ = (v) => (v.z !== undefined ? v.z : v[2])

/**
 * 位置 / 速度上下文 → ECEF 轴向（写进 o.r / o.v；o.hasV 标速度有没有）。
 * ctx：{pv:{position, velocity}（TEME）, gmstRad} 或 {rEcef:[3], vInertialEcef?:[3]}。拿不到位置返回 false。
 */
function stateInto(ctx, o) {
  if (!ctx) return false
  if (ctx.rEcef) {
    const r = ctx.rEcef
    o.r[0] = getX(r); o.r[1] = getY(r); o.r[2] = getZ(r)
    const v = ctx.vInertialEcef
    o.hasV = !!(v && Number.isFinite(getX(v)) && Number.isFinite(getY(v)) && Number.isFinite(getZ(v)))
    if (o.hasV) { o.v[0] = getX(v); o.v[1] = getY(v); o.v[2] = getZ(v) }
  } else if (ctx.pv && ctx.pv.position) {
    const g = Number.isFinite(ctx.gmstRad) ? ctx.gmstRad : gmstRadAt(ctx.tMs)
    if (!Number.isFinite(g)) return false
    const c = Math.cos(g), s = Math.sin(g), p = ctx.pv.position, v = ctx.pv.velocity
    const px = getX(p), py = getY(p), pz = getZ(p)
    o.r[0] = px * c + py * s; o.r[1] = -px * s + py * c; o.r[2] = pz                       // 与 satellite.js eciToEcf 同式
    o.hasV = !!(v && Number.isFinite(getX(v)) && Number.isFinite(getY(v)) && Number.isFinite(getZ(v)))
    if (o.hasV) { const vx = getX(v), vy = getY(v); o.v[0] = vx * c + vy * s; o.v[1] = -vx * s + vy * c; o.v[2] = getZ(v) }
  } else return false
  return Number.isFinite(o.r[0]) && Number.isFinite(o.r[1]) && Number.isFinite(o.r[2]) && (o.r[0] !== 0 || o.r[1] !== 0 || o.r[2] !== 0)
}

/**
 * 本体基底 → 本体到 L 系的四元数（modelLayer 的 qB2L）：qB2L = qS2L ⊗ qB2S，qB2S = basisToQuatScene(basis)。
 * nadir 律下与常量 Q_BODY2L_NADIR 相差 1e-16 量级（单测）。
 */
export function qB2LFromBasis(basis, qL2S, out = [0, 0, 0, 0]) {
  const qB2S = basisToQuatScene(basis, [0, 0, 0, 0])
  const qS2L = [-qL2S[0], -qL2S[1], -qL2S[2], qL2S[3]]
  quatMul(qS2L, qB2S, out)
  if (out[3] < 0) { out[0] = -out[0]; out[1] = -out[1]; out[2] = -out[2]; out[3] = -out[3] }
  return out
}

/**
 * 「姿态 + 挂点」基底的等效手动指向（D9）：给出 (boreAz, boreEl, yaw) 使 coverage.antennaBasisAzEl(satLon, satLat, satAlt, boreAz, boreEl, yaw)
 * 与 W12 的 basisFromAxes(S, z, up, yawBiasDeg) 同一基底 —— 主进程 sampler / 链路预算 / C·CI 这些不认姿态的消费者照 azel 档吃。
 *   az / el：视轴在星下天底基底里的 igrid 6 方位 / 俯仰（dirAzElAbout，antennaBasisAbout 的逆）
 *   yaw   ：挂点 x 轴（= up 投影 × 视轴）相对 azel 档参考轴 x_ref = nrm(ẑ_ECEF × z) 的钟向角，再加天线自己的附加偏置 yawBiasDeg
 * 视轴平行地轴（x_ref 无定义）时 yaw 只取偏置。返回 null = 入参坏。
 */
export function attEquivOf(z, up, satLon, satLat, satAlt, yawBiasDeg = 0) {
  if (!isVec3(z) || !isVec3(up) || !Number.isFinite(satLon) || !Number.isFinite(satAlt)) return null
  const nb = antennaBasis(satLon, satLon, satLat || 0, 0, satLat || 0, satAlt)
  const zl = Math.hypot(z[0], z[1], z[2])
  if (!(zl > 0)) return null
  const zu = [z[0] / zl, z[1] / zl, z[2] / zl]
  const ae = dirAzElAbout(nb, zu)
  // 挂点系 y = up 在视轴法平面的投影、x = y × z（与 attitude.mountFrame / W12 basisFromAxes 同式）
  const k = up[0] * zu[0] + up[1] * zu[1] + up[2] * zu[2]
  let yx = up[0] - k * zu[0], yy = up[1] - k * zu[1], yz = up[2] - k * zu[2]
  const yl = Math.hypot(yx, yy, yz)
  let psi = 0
  if (yl > 1e-9) {
    yx /= yl; yy /= yl; yz /= yl
    const xx = yy * zu[2] - yz * zu[1], xy = yz * zu[0] - yx * zu[2], xz = yx * zu[1] - yy * zu[0]
    // azel 档的参考：x_ref = nrm(ẑ × z)、y_ref = z × x_ref
    let rx = -zu[1], ry = zu[0]
    const rl = Math.hypot(rx, ry)
    if (rl > 1e-12) {
      rx /= rl; ry /= rl
      const sx = zu[1] * 0 - zu[2] * ry, sy = zu[2] * rx - zu[0] * 0, sz = zu[0] * ry - zu[1] * rx   // y_ref = z × x_ref（x_ref.z = 0）
      psi = Math.atan2(xx * sx + xy * sy + xz * sz, xx * rx + xy * ry) * R2D
    }
  }
  let yaw = psi + (Number(yawBiasDeg) || 0)
  yaw = ((yaw % 360) + 540) % 360 - 180
  if (yaw === -180) yaw = 180
  return { boreAz: ae.az, boreEl: ae.el, yaw }
}

/**
 * @param {{api?:object, resolveTargetEcef?:(satKey:string, tMs:number)=>number[]|null, prefetchMasks?:boolean}} [o]
 *   api：window.api（用 api.models.bindingsGet / onChanged / getMask）；缺省时只能 setBindings 喂数据（单测 / 验证台）
 *   prefetchMasks：绑定一到就后台预取全部掩模签名（缺省否 —— 每张 ~325 KB 过 IPC，没有查表端时白取）
 */
export function createBodyRuntime(o = {}) {
  const models = o.api && o.api.models ? o.api.models : null
  const autoPrefetch = !!o.prefetchMasks
  const resolveTargetEcef = typeof o.resolveTargetEcef === 'function' ? o.resolveTargetEcef : null
  let binds = { prefs: null, bindings: {} }
  let loaded = false, ver = 0, disposed = false
  let loadSeq = 0, loadP = null
  const listeners = new Set()
  const frames = new WeakMap()          // mount 对象 → mountFrame（绑定重载即换新对象，自动失效）
  const yawPrev = new Map()             // satKey → 上一次的偏航角（yawSteer 奇点处保持连续）
  const maskCache = new Map()           // sig → mask | null
  const maskPending = new Map()         // sig → Promise<mask|null>
  // 逐拍暂存（零分配）
  const _st = { r: [0, 0, 0], v: [0, 0, 0], hasV: false }
  const _sun = [0, 0, 0], _tgt = [0, 0, 0], _dir = [0, 0, 0], _sb = [0, 0, 0]
  const _ctx = { rEcef: _st.r, vInertialEcef: null, sunEcef: _sun, targetEcef: null, gmstRad: NaN, tMs: 0, prevYawDeg: 0 }
  const _bTmp = makeBasis()
  // 同一拍的本体基底记一份（遮挡查表专用）：同一时刻按挂点逐个问 blockedAt、再问 basisMemoAt / losBodyAt ——
  // 星 / 时刻 / 位置速度 / 绑定版本都没变就不再解一遍姿态
  const _bm = { key: null, tMs: NaN, ver: -1, r: [NaN, NaN, NaN], v: [NaN, NaN, NaN], hasV: false, ok: false, b: makeBasis(), sun: [0, 0, 0] }

  function emit(e) { for (const fn of listeners) { try { fn(e) } catch (err) { console.warn('[bodyRuntime] onChange 订阅者抛错', err) } } }

  // ───────── 绑定 ─────────
  function setBindings(r) {
    const b = r && typeof r === 'object' && r.bindings && typeof r.bindings === 'object' ? r.bindings : {}
    binds = { prefs: (r && r.prefs) || null, bindings: b }
    loaded = true
    ver++
    yawPrev.clear()
    emit({ type: 'bindings', ver })
    pruneMasks()
    if (autoPrefetch) prefetchMasks()
  }
  async function reload() {
    if (!models || !models.bindingsGet) { loaded = true; return binds }
    const seq = ++loadSeq
    const p = (async () => {
      let r = null
      try { r = await models.bindingsGet() } catch { r = null }
      if (disposed || seq !== loadSeq) return binds
      if (r && !r.locked && r.bindings) setBindings(r)
      else if (!loaded) { loaded = true; ver++; emit({ type: 'bindings', ver }) }
      return binds
    })()
    loadP = p
    return p
  }
  const offChanged = models && models.onChanged ? models.onChanged((e) => { if (e && e.type === 'bindings') reload() }) : null
  if (models) reload()

  /** 本页刚写成功的绑定先落进缓存（主进程的 bindings 广播随后到，重载一次对齐） */
  function patchLocal(satKey, binding) {
    if (!satKey) return
    const next = { ...binds.bindings }
    if (binding) next[satKey] = binding; else delete next[satKey]
    setBindings({ prefs: binds.prefs, bindings: next })
  }
  const bindingFor = (satKey) => (satKey && binds.bindings && binds.bindings[satKey]) || null
  const mountsFor = (satKey) => { const b = bindingFor(satKey); return b && Array.isArray(b.mounts) ? b.mounts : [] }
  function attitudeFor(satKey) {
    const b = bindingFor(satKey)
    const a = b && b.attitude
    return a && LAWS.includes(a.law) ? { law: a.law, params: a.params && typeof a.params === 'object' ? a.params : {} } : NADIR_ATT
  }
  /** 是不是恒等于 nadir 常量（调用方可以直接用 Q_BODY2L_NADIR，省一次姿态解算） */
  function isPlainNadir(satKey) {
    const a = attitudeFor(satKey)
    return a.law === 'nadir' && !(Number(a.params.yawBiasDeg) || 0)
  }
  function mountFor(satKey, mountId) {
    if (!mountId) return null
    const ms = mountsFor(satKey)
    for (let i = 0; i < ms.length; i++) if (ms[i] && ms[i].id === mountId) return ms[i]
    return null
  }
  function frameOf(m) {
    let f = frames.get(m)
    if (!f) { f = mountFrame(m); frames.set(m, f) }
    return f
  }

  // ───────── 姿态 ─────────
  function targetInto(params, tMs, out) {
    const t = params && params.target
    if (!t || typeof t !== 'object') return null
    let p = null
    if (t.kind === 'station' && Number.isFinite(t.latDeg) && Number.isFinite(t.lonDeg)) p = geodeticToEcef(t.lonDeg, t.latDeg, (Number(t.altM) || 0) / 1000)
    else if (t.kind === 'ecef' && isVec3(t.ecefKm)) p = t.ecefKm
    else if (t.kind === 'sat' && t.satKey && resolveTargetEcef) { try { p = resolveTargetEcef(t.satKey, tMs) } catch { p = null } }
    if (!isVec3(p)) return null
    out[0] = p[0]; out[1] = p[1]; out[2] = p[2]
    return out
  }
  /**
   * 某颗星在 ctx 时刻的本体三轴（标准 ECEF 单位矢量，Z 极轴）。没有绑定 = nadir。拿不到位置返回 null。
   * @param {string} satKey
   * @param {{pv?:{position,velocity}, gmstRad?:number, rEcef?:number[], vInertialEcef?:number[], tMs:number, sunEcef?:number[]}} ctx
   * @param {object} [out] makeBasis() 容器（逐拍复用）；不给就新建
   * @returns {{X:number[], Y:number[], Z:number[], yawDeg:number, law:string, fallback:boolean}|null}
   */
  function attitudeBasisAt(satKey, ctx, out) {
    if (!stateInto(ctx, _st)) return null
    const att = attitudeFor(satKey)
    const tMs = Number.isFinite(ctx.tMs) ? ctx.tMs : Date.now()
    _ctx.vInertialEcef = _st.hasV ? _st.v : null
    _ctx.tMs = tMs
    _ctx.gmstRad = Number.isFinite(ctx.gmstRad) ? ctx.gmstRad : NaN
    if (ctx.sunEcef && Number.isFinite(getX(ctx.sunEcef))) { _sun[0] = getX(ctx.sunEcef); _sun[1] = getY(ctx.sunEcef); _sun[2] = getZ(ctx.sunEcef) } else sunEcefApprox(tMs, _sun)
    _ctx.targetEcef = att.law === 'target' ? targetInto(att.params, tMs, _tgt) : null
    const py = yawPrev.get(satKey)
    _ctx.prevYawDeg = Number.isFinite(py) ? py : 0
    const b = attitudeBasisEcef(att.law, att.params, _ctx, out || makeBasis())
    if (b && Number.isFinite(b.yawDeg) && satKey) yawPrev.set(satKey, b.yawDeg)
    return b
  }
  /**
   * 挂点（天线）三轴在 ECEF 下 + 星位：{x, y, z, up(= y), S(km), law, fallback}。mountId '' = 缺省挂点（D1）；
   * 给了 id 却找不到（挂点被删了）返回 null，由调用方决定退路。
   */
  function mountAxesAt(satKey, mountId, ctx) {
    const m = mountId ? mountFor(satKey, mountId) : DEFAULT_MOUNT
    if (!m) return null
    const b = attitudeBasisAt(satKey, ctx, _bTmp)
    if (!b) return null
    const mb = mountBasisEcef(b, frameOf(m))
    return {
      x: mb.x, y: mb.y, z: mb.z, up: mb.y.slice(), S: _st.r.slice(), law: b.law, fallback: !!b.fallback,
      mount: m.id || '', body: { X: b.X.slice(), Y: b.Y.slice(), Z: b.Z.slice() }
    }
  }
  /**
   * 「挂点 + 姿态律」绑定内容的签名（短串，FNV-1a 32 位）：只看决定视轴的那几项（挂点的位置 / 视轴 / up、姿态律与参数），
   * 与版本号无关 —— 重启、重载同一份绑定签名不变；工作台改了挂点方向或姿态律签名就变（链路预算回填指纹拼它）。
   * mountId '' = 缺省挂点。按绑定版本缓存。
   */
  const _sigCache = new Map()
  let _sigVer = -1
  function bindSigOf(satKey, mountId) {
    if (_sigVer !== ver) { _sigCache.clear(); _sigVer = ver }
    const ck = (satKey || '') + '\u0001' + (mountId || '')
    let s = _sigCache.get(ck)
    if (s !== undefined) return s
    const m = mountId ? mountFor(satKey, mountId) : DEFAULT_MOUNT
    const a = attitudeFor(satKey)
    const txt = JSON.stringify([m ? [m.id || '', m.posBody || null, m.boresightBody || null, m.upBody || null] : null, a.law, a.params])
    let h = 0x811c9dc5
    for (let i = 0; i < txt.length; i++) { h ^= txt.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    s = h.toString(16).padStart(8, '0')
    _sigCache.set(ck, s)
    return s
  }

  // ───────── 掩模 ─────────
  const sunSigsOf = (m) => (m && m.maskSun && Array.isArray(m.maskSun.sigs) && m.maskSun.sigs.length === SUN_SCAN_BINS ? m.maskSun.sigs : null)
  function sigsOfMount(m) {
    const out = []
    if (m && typeof m.maskSig === 'string' && m.maskSig) out.push(m.maskSig)
    const ss = sunSigsOf(m)
    if (ss) for (const s of ss) if (typeof s === 'string' && s && !out.includes(s)) out.push(s)
    return out
  }
  const hasMask = (m) => sigsOfMount(m).length > 0
  function loadMask(sig) {
    if (!sig) return Promise.resolve(null)
    if (maskCache.has(sig)) return Promise.resolve(maskCache.get(sig))
    let p = maskPending.get(sig)
    if (p) return p
    p = (async () => {
      let mk = null
      try {
        const bytes = models && models.getMask ? await models.getMask(sig) : null
        if (bytes && !bytes.locked) mk = decodeMask(bytes)
      } catch { mk = null }
      maskPending.delete(sig)
      if (disposed) return null
      maskCache.set(sig, mk)
      emit({ type: 'mask', sig, ok: !!mk })
      return mk
    })()
    maskPending.set(sig, p)
    return p
  }
  let prefetchP = Promise.resolve()
  // 绑定重载时的缓存整理（不取新的）：上次没取到的（文件还没落盘 / 通道不可用）丢掉，下次查表再取 —— 工作台先写签名后落文件的
  // 顺序也不会永久缺席；绑定里已不再引用的掩模丢掉（工作台重算后签名换了，旧的那份没人要了）
  function pruneMasks() {
    for (const [s, v] of [...maskCache]) if (v === null) maskCache.delete(s)
    const live = new Set()
    for (const b of Object.values(binds.bindings || {})) for (const m of (b && Array.isArray(b.mounts) ? b.mounts : [])) for (const s of sigsOfMount(m)) live.add(s)
    for (const s of [...maskCache.keys()]) if (!live.has(s)) maskCache.delete(s)
  }
  function prefetchMasks() {
    pruneMasks()
    const want = []
    for (const b of Object.values(binds.bindings || {})) {
      for (const m of (b && Array.isArray(b.mounts) ? b.mounts : [])) {
        for (const s of sigsOfMount(m)) if (!maskCache.has(s) && !maskPending.has(s) && !want.includes(s)) want.push(s)
      }
      if (want.length >= MASK_PREFETCH_MAX) break
    }
    if (!want.length || !models || !models.getMask) return prefetchP
    const q = want.slice(0, MASK_PREFETCH_MAX)
    const worker = async () => { while (q.length) { const s = q.shift(); await loadMask(s) } }
    prefetchP = Promise.all(Array.from({ length: Math.min(MASK_CONCURRENCY, q.length) }, worker)).then(() => {})
    return prefetchP
  }
  /** 太阳在本体系的方向（对日扫描选档用）；ctx 不足时返回 null */
  function sunBodyAt(satKey, ctx) {
    if (!ctx) return null
    const b = attitudeBasisAt(satKey, ctx, _bTmp)
    if (!b) return null
    return losToBody(_sun, b, _sb)
  }
  function sigAt(m, sunBody) {
    const ss = sunSigsOf(m)
    if (ss && sunBody && isVec3(m.maskSun.axisBody) && isVec3(m.maskSun.pointingBody)) {
      const s = ss[sunScanBin(articulationSunAngle(m.maskSun.pointingBody, m.maskSun.axisBody, sunBody))]
      if (s) return s
    }
    return typeof m.maskSig === 'string' && m.maskSig ? m.maskSig : (ss ? ss[0] : null)
  }
  /** 掩模（异步取；签名缓存）。ctx 只在对日扫描挂点上用来选档。 */
  function maskFor(satKey, mountId, ctx) {
    const m = mountFor(satKey, mountId)
    if (!m) return Promise.resolve(null)
    const needSun = !!sunSigsOf(m)
    return loadMask(sigAt(m, needSun ? sunBodyAt(satKey, ctx) : null))
  }
  /** 掩模（同步；已缓存才有，否则 null 并在后台开始取） */
  function maskSync(satKey, mountId, ctx) {
    const m = mountFor(satKey, mountId)
    if (!m) return null
    const needSun = !!sunSigsOf(m)
    return maskOfMount(m, needSun ? sunBodyAt(satKey, ctx) : null)
  }
  function maskOfMount(m, sunBody) {
    const sig = sigAt(m, sunBody)
    if (!sig) return null
    if (maskCache.has(sig)) return maskCache.get(sig)
    loadMask(sig)
    return null
  }
  /** 这颗星所有挂点的掩模都取到（或确认取不到）后 resolve —— 算过境 / 对星扫描前 await 一下，别让首轮静默缺席 */
  async function ensureMasks(satKey) {
    const ms = satKey ? mountsFor(satKey) : [].concat(...Object.values(binds.bindings || {}).map((b) => (b && Array.isArray(b.mounts) ? b.mounts : [])))
    const sigs = []
    for (const m of ms) for (const s of sigsOfMount(m)) if (!sigs.includes(s)) sigs.push(s)
    await Promise.all(sigs.map(loadMask))
  }

  // 遮挡查表用的本体基底（按「星 / 时刻 / 位置速度 / 绑定版本」记一拍）：返回 _bm.b（内部容器，调用方别留着引用）或 null；
  // _bm.sun = 该拍太阳方向（对日扫描选档用）。ctx 显式给了太阳的不记（少见，照常解）
  const _ms = { r: [0, 0, 0], v: [0, 0, 0], hasV: false }
  function basisMemo(satKey, ctx) {
    if (!ctx) return null
    if (ctx.sunEcef && Number.isFinite(getX(ctx.sunEcef))) {
      _bm.ok = false
      const b = attitudeBasisAt(satKey, ctx, _bm.b)
      if (b) { _bm.sun[0] = _sun[0]; _bm.sun[1] = _sun[1]; _bm.sun[2] = _sun[2] }
      return b
    }
    if (!stateInto(ctx, _ms)) return null
    const tMs = Number(ctx.tMs)
    const r = _ms.r, v = _ms.v, br = _bm.r, bv = _bm.v
    if (_bm.ok && _bm.key === satKey && _bm.ver === ver && _bm.tMs === tMs && br[0] === r[0] && br[1] === r[1] && br[2] === r[2] &&
      _bm.hasV === _ms.hasV && (!_ms.hasV || (bv[0] === v[0] && bv[1] === v[1] && bv[2] === v[2]))) return _bm.b
    const b = attitudeBasisAt(satKey, ctx, _bm.b)
    _bm.key = satKey; _bm.ver = ver; _bm.tMs = tMs; _bm.hasV = _ms.hasV; _bm.ok = !!b
    br[0] = r[0]; br[1] = r[1]; br[2] = r[2]; bv[0] = v[0]; bv[1] = v[1]; bv[2] = v[2]
    if (b) { _bm.sun[0] = _sun[0]; _bm.sun[1] = _sun[1]; _bm.sun[2] = _sun[2] }
    return b
  }
  /** 本体基底（新建纯对象，调用方可以留着）；与 blockedAt 同一拍共用一次姿态解算 */
  function basisMemoAt(satKey, ctx) {
    const b = basisMemo(satKey, ctx)
    return b ? { X: b.X.slice(), Y: b.Y.slice(), Z: b.Z.slice(), yawDeg: b.yawDeg, law: b.law, fallback: !!b.fallback } : null
  }
  /** 视线（ECEF 方向）在本体系里的分量（新建数组）；与 blockedAt 同一拍共用一次姿态解算。拿不到位置返回 null */
  function losBodyAt(satKey, ctx, losEcef) {
    if (!losEcef) return null
    const b = basisMemo(satKey, ctx)
    return b ? losToBody(losEcef, b, [0, 0, 0]) : null
  }

  /**
   * 本体遮挡判据（D2 / D4 / D6）：视线（星 → 目标，ECEF 方向，不必单位长）是否被本体挡住。
   * mountIdOrAll：挂点 id；'' / null = 全部挂点（任一通视即可）。返回 true / false；没有可用掩模 → null（不参与）。
   */
  function blockedAt(satKey, mountIdOrAll, ctx, losEcef) {
    if (!satKey || !losEcef) return null
    const ms = mountsFor(satKey)
    if (!ms.length) return null
    const b = basisMemo(satKey, ctx)
    if (!b) return null
    losToBody(losEcef, b, _dir)
    let sunB = null, sunDone = false
    let any = false
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]
      if (!m || (mountIdOrAll && m.id !== mountIdOrAll)) continue
      let sb = null
      if (sunSigsOf(m)) { if (!sunDone) { sunB = losToBody(_bm.sun, b, _sb); sunDone = true } sb = sunB }
      const mk = maskOfMount(m, sb)
      if (!mk) continue
      any = true
      if (!maskLookup(mk, _dir)) return false
    }
    return any ? true : null
  }

  /** 验证台用（只在 vite dev 下导出）：直接放一张掩模进签名缓存（bytes = .bin 字节或已解码的 mask）。正常路径是 models.getMask */
  function _putMask(sig, bytesOrMask) {
    if (!sig) return false
    const mk = bytesOrMask && bytesOrMask.blocked ? bytesOrMask : decodeMask(bytesOrMask)
    if (!mk) return false
    maskCache.set(sig, mk)
    emit({ type: 'mask', sig, ok: true })
    return true
  }
  function onChange(fn) { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn) }
  function dispose() {
    disposed = true
    if (offChanged) try { offChanged() } catch { /* ignore */ }
    listeners.clear(); maskCache.clear(); maskPending.clear(); yawPrev.clear()
  }
  const rt = {
    reload, ready: () => (loadP || Promise.resolve(binds)), isLoaded: () => loaded, version: () => ver,
    setBindings, patchLocal, bindingsAll: () => binds,
    bindingFor, mountsFor, mountFor, attitudeFor, isPlainNadir, hasMask,
    attitudeBasisAt, basisMemoAt, losBodyAt, mountAxesAt, bindSigOf, sunEcefLast: () => _sun.slice(),
    maskFor, maskSync, ensureMasks, prefetchMasks: () => { prefetchMasks(); return prefetchP },
    blockedAt, onChange, dispose
  }
  if (DEV) rt._putMask = _putMask
  return rt
}
