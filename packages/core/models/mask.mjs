// 本体遮挡掩模（二期契约 D2 / D3 / D18；任务书 §6.4）——角坐标、查表、编解码、统计、签名的【唯一】实现。
// 生成端（src/viz/models/bodyMask.worker.js，three-mesh-bvh）与所有查表端（可见性 / 对星表 / ISL / 报告 / 画图 / 主进程）共用。
// 纯 ESM、无依赖；热路径（maskIndex / maskLookup）不分配。
//
// ── 角坐标（D2，定死，改之前想清楚所有调用方与已落盘的 .bin）──
//   方向一律在【本体系】（+X 速度、+Y 补全、+Z 天底），原点 = 挂点 posBody（射线起点再沿视轴偏 1 cm，MASK_RAY_OFFSET_M）。
//     az = atan2(d_y, d_x)（度，[0, 360)，自 +X 转向 +Y）
//     el = asin(d_z)      （度，[−90, 90]，+90 = 本体 +Z = 天底）
//   网格 360 × 181，整度格心：azIdx = round(az) % 360，elIdx = round(el + 90)，index = elIdx·360 + azIdx。
//   两个极点行（elIdx 0 / 180）只对应一个方向（±Z），整行同值——maskDir 在极点行返回精确的 [0,0,∓1]，生成端整行射同一条线。
//   格的立体角：el 行覆盖 [el−0.5°, el+0.5°] ∩ [−90°, 90°]，ΔΩ = Δaz·(sin el_hi − sin el_lo)，全表之和恰为 4π。
//
// ── 数据（D18）──
//   mask = { w: 360, h: 181, blocked: Uint8Array(65160)（1 = 遮挡）, clearance: Float32Array(65160)（最近命中距离 m；通畅格 = +Infinity） }
//   .bin = 头 16 B（'SMSK'、ver u32 = 1、w u32 = 360、h u32 = 181，小端）+ Uint8 blocked + Float32 clearance（小端），共 325 816 B。
//   掩模按「生成时的关节值」算（D3），签名含关节值；随时间转的太阳翼走「对日扫描」：按关节转角量化 12 档各算一张（SUN_SCAN_BINS）。
//
// 导出：
//   MASK_W / MASK_H / MASK_N / MASK_VERSION / MASK_MAGIC / MASK_HEADER_BYTES / MASK_BYTES / MASK_RAY_OFFSET_M / SUN_SCAN_BINS
//   maskIndex(dirBody) → index | −1      maskAzEl(dirBody, out) → {az, el}      maskCell(index, out) → {azIdx, elIdx, az, el}
//   maskDir(azIdx, elIdx, out) → 单位方向    cellSolidAngle(elIdx) → sr
//   createMask() / maskLookup(mask, dirBody) → 0|1 / maskClearance(mask, dirBody) → m
//   encodeMask(mask) → Uint8Array / decodeMask(bytes) → mask | null
//   maskStats(mask) → {blockedFrac, blockedSr, blockedCells, cellFrac, minClearanceM}
//   maskSignature({modelSha, lod, frame, articulations, mountPos, mountBoresight, excludeNodes, noObscurationNodes, scaleToMeters, sunBin}) → 16 位十六进制
//     （位置与视轴合成射线起点进签名，见函数头注）
//   maskRayOrigin(posBody, boresightBody, out) / buildMask(castFn) / rayAabb(o, d, min, max) / boxMask(boxes, origin)（解析真值，给 Worker 对拍）
//   sunScanBin(angleDeg) / sunScanAngleDeg(bin)
//   maskToCsv(mask) → 'az,el,blocked,clearanceM' 文本

export const MASK_W = 360
export const MASK_H = 181
export const MASK_N = MASK_W * MASK_H                       // 65160
export const MASK_VERSION = 1
export const MASK_MAGIC = 'SMSK'
export const MASK_HEADER_BYTES = 16
export const MASK_BYTES = MASK_HEADER_BYTES + MASK_N + MASK_N * 4   // 325816（16 + 65160 = 65176 恰是 4 的倍数，Float32 段天然对齐）
export const MASK_RAY_OFFSET_M = 0.01                      // 射线起点沿视轴偏 1 cm（任务书 §6.4）：别让起点落在挂点所在的面上自交
export const SUN_SCAN_BINS = 12                            // 对日扫描：关节转角 30° 一档（D3）

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const gx = (v) => (v.x !== undefined ? v.x : v[0]), gy = (v) => (v.y !== undefined ? v.y : v[1]), gz = (v) => (v.z !== undefined ? v.z : v[2])
// |(x,y)|：常规量级走 sqrt，越出 (1e-290, 1e290) 才退回 Math.hypot（V8 的 Math.hypot 每次调用都分配暂存数组，查表热路径避开）
const norm2 = (x, y) => { const s = x * x + y * y; return s > 1e-290 && s < 1e290 ? Math.sqrt(s) : Math.hypot(x, y) }

// ─────────────────────────────── 角坐标 ───────────────────────────────

/**
 * 本体系方向 → 掩模格下标（不必单位长）。零长 / 非有限返回 −1（查表端按「通畅」处理）。
 * 用 atan2(z, hypot(x, y)) 而不是 asin(z/|d|)：近极点时不丢精度，也不要求调用方先归一。
 */
export function maskIndex(dirBody) {
  const x = gx(dirBody), y = gy(dirBody), z = gz(dirBody)
  const h = norm2(x, y)
  if (!(h > 0 || z !== 0) || !Number.isFinite(h) || !Number.isFinite(z)) return -1
  const elIdx = Math.round(Math.atan2(z, h) * R2D + 90)
  let az = Math.atan2(y, x) * R2D
  if (az < 0) az += 360
  return elIdx * MASK_W + (Math.round(az) % MASK_W)
}
/** 本体系方向 → {az ∈ [0,360), el ∈ [−90,90]}（度，D2 口径）。 */
export function maskAzEl(dirBody, out) {
  const o = out || { az: 0, el: 0 }
  const x = gx(dirBody), y = gy(dirBody), z = gz(dirBody)
  o.el = Math.atan2(z, norm2(x, y)) * R2D
  let az = Math.atan2(y, x) * R2D
  if (az < 0) az += 360
  o.az = az >= 360 ? 0 : az
  return o
}
/** 下标 → 格心 {azIdx, elIdx, az, el}（度）。 */
export function maskCell(index, out) {
  const o = out || { azIdx: 0, elIdx: 0, az: 0, el: 0 }
  o.elIdx = Math.floor(index / MASK_W); o.azIdx = index - o.elIdx * MASK_W
  o.az = o.azIdx; o.el = o.elIdx - 90
  return o
}
/** 格心方向（本体系单位矢量）。极点行返回精确的 [0, 0, ∓1]（整行同一条射线）。 */
export function maskDir(azIdx, elIdx, out = [0, 0, 0]) {
  if (elIdx <= 0) { out[0] = 0; out[1] = 0; out[2] = -1; return out }
  if (elIdx >= MASK_H - 1) { out[0] = 0; out[1] = 0; out[2] = 1; return out }
  const el = (elIdx - 90) * D2R, az = azIdx * D2R, ce = Math.cos(el)
  out[0] = ce * Math.cos(az); out[1] = ce * Math.sin(az); out[2] = Math.sin(el)
  return out
}

const ROW_SR = (() => {
  const a = new Float64Array(MASK_H)
  for (let e = 0; e < MASK_H; e++) {
    const lo = Math.max(-90, e - 90 - 0.5), hi = Math.min(90, e - 90 + 0.5)
    a[e] = D2R * (Math.sin(hi * D2R) - Math.sin(lo * D2R))
  }
  return a
})()
/** 一个格的立体角（sr）。 */
export function cellSolidAngle(elIdx) { return ROW_SR[elIdx] || 0 }

// ─────────────────────────────── 数据 / 查表 ───────────────────────────────

export function createMask() {
  return { w: MASK_W, h: MASK_H, blocked: new Uint8Array(MASK_N), clearance: new Float32Array(MASK_N).fill(Infinity) }
}
/** 查表：1 = 该方向被本体挡住，0 = 通畅（掩模缺失 / 方向非法也按 0）。 */
export function maskLookup(mask, dirBody) {
  if (!mask || !mask.blocked) return 0
  const i = maskIndex(dirBody)
  return i < 0 ? 0 : mask.blocked[i]
}
/** 该方向最近命中距离（m）；通畅 = +Infinity。 */
export function maskClearance(mask, dirBody) {
  if (!mask || !mask.clearance) return Infinity
  const i = maskIndex(dirBody)
  return i < 0 ? Infinity : mask.clearance[i]
}

// ─────────────────────────────── 编解码（D18） ───────────────────────────────

/** mask → .bin 字节（小端）。 */
export function encodeMask(mask) {
  const out = new Uint8Array(MASK_BYTES)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < 4; i++) out[i] = MASK_MAGIC.charCodeAt(i)
  dv.setUint32(4, MASK_VERSION, true)
  dv.setUint32(8, MASK_W, true)
  dv.setUint32(12, MASK_H, true)
  out.set(mask.blocked.subarray(0, MASK_N), MASK_HEADER_BYTES)
  const base = MASK_HEADER_BYTES + MASK_N, c = mask.clearance
  for (let i = 0; i < MASK_N; i++) dv.setFloat32(base + i * 4, c[i], true)
  return out
}
/** .bin 字节 → mask；魔数 / 版本 / 尺寸 / 长度不对返回 null（不抛）。接受 Uint8Array / ArrayBuffer / Node Buffer。 */
export function decodeMask(bytes) {
  let u8 = null
  if (bytes instanceof Uint8Array) u8 = bytes
  else if (bytes instanceof ArrayBuffer) u8 = new Uint8Array(bytes)
  else if (ArrayBuffer.isView(bytes)) u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (!u8 || u8.byteLength !== MASK_BYTES) return null
  for (let i = 0; i < 4; i++) if (u8[i] !== MASK_MAGIC.charCodeAt(i)) return null
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  if (dv.getUint32(4, true) !== MASK_VERSION || dv.getUint32(8, true) !== MASK_W || dv.getUint32(12, true) !== MASK_H) return null
  const m = { w: MASK_W, h: MASK_H, blocked: new Uint8Array(MASK_N), clearance: new Float32Array(MASK_N) }
  m.blocked.set(u8.subarray(MASK_HEADER_BYTES, MASK_HEADER_BYTES + MASK_N))
  const base = MASK_HEADER_BYTES + MASK_N
  for (let i = 0; i < MASK_N; i++) m.clearance[i] = dv.getFloat32(base + i * 4, true)
  return m
}

// ─────────────────────────────── 统计 ───────────────────────────────

/**
 * 读数（结果区只出数字）：
 *   blockedFrac   遮挡立体角比例 = Σ遮挡格立体角 / 4π（按立体角加权，极区小格不会被高估）
 *   blockedSr     遮挡立体角（sr）
 *   blockedCells / cellFrac   遮挡格数与格数比例（不加权，给对拍用）
 *   minClearanceM 遮挡格里最近的命中距离（m）= 挂点到本体最近处；没有遮挡为 null
 */
export function maskStats(mask) {
  let sr = 0, cells = 0, minC = Infinity
  const b = mask.blocked, c = mask.clearance
  for (let e = 0, i = 0; e < MASK_H; e++) {
    let rowCells = 0
    for (let a = 0; a < MASK_W; a++, i++) {
      if (!b[i]) continue
      rowCells++
      const v = c ? c[i] : Infinity
      if (v < minC) minC = v
    }
    cells += rowCells; sr += rowCells * ROW_SR[e]           // 按行计数再乘格立体角：少 6 万次累加的舍入
  }
  return { blockedFrac: sr / (4 * Math.PI), blockedSr: sr, blockedCells: cells, cellFrac: cells / MASK_N, minClearanceM: Number.isFinite(minC) ? minC : null }
}

// ─────────────────────────────── 签名 ───────────────────────────────

const r6 = (x) => { const v = Math.round(x * 1e6) / 1e6; return v === 0 ? 0 : v }
const r9 = (x) => { const v = Math.round(x * 1e9) / 1e9; return v === 0 ? 0 : v }
function canonNum(v, r) {
  if (typeof v === 'number') return Number.isFinite(v) ? r(v) : null
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v, (x) => canonNum(x, r))
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = canonNum(v[k], r)
    return o
  }
  return v === undefined ? null : v
}
function canonJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonJson).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonJson(v[k])).join(',') + '}'
  return JSON.stringify(v === undefined ? null : v)
}
function fnv64(str) {
  const bytes = new TextEncoder().encode(str)
  let h = 0xcbf29ce484222325n
  const P = 0x100000001b3n, MASK = 0xffffffffffffffffn
  for (let i = 0; i < bytes.length; i++) { h ^= BigInt(bytes[i]); h = (h * P) & MASK }
  return h.toString(16).padStart(16, '0')
}

/**
 * 掩模签名（D3 / D18：签名不变不重算；文件名 userData/models/masks/<sig>.bin）。
 * 进签名的：掩模格式版本、网格、射线偏移、模型 sha、LOD、frame（q 取 w ≥ 0 规范形、9 位小数；t 6 位）、scaleToMeters、
 *   关节值（{关节名: 数 | 数组 | {stage: 数}}，6 位小数）、【射线起点】（m，6 位）、排除节点与不遮挡节点（去重排序）、对日扫描档。
 *   射线起点 = maskRayOrigin(mountPos, 视轴) = 挂点位置 + 1 cm·视轴单位矢量（与 Worker 的 maskOrigin 同一口径）：
 *   掩模只随起点变，所以视轴也进签名——视轴翻个面，起点可能从盒外挪进盒内（整张掩模翻成全遮挡），签名必须跟着变。
 *   视轴认 mountBoresight / boresightBody / dirBody（挂点口径三种写法）；缺省 / 非法 / 零长按不外推（起点 = 位置，
 *   与 Worker 对非法视轴的处理一致），此时签名与只给位置时相同。位置缺省 / 非法：给了视轴就按原点外推，否则起点键为 null。
 *   两组（位置, 视轴）只要起点在 1e-6 m 上相同，掩模就逐格相同，签名也相同（同一个 .bin 共用，是对的）。
 * 不进签名的：挂点 up（掩模在本体系，只看起点）、天线、万向节。
 * @returns {string} 16 位小写十六进制（FNV-1a 64，与 paramBus.specHash 同一算法）
 */
export function maskSignature(o = {}) {
  let q = null
  const f = o.frame || {}
  const qq = f.q_model2body || f.q
  if (Array.isArray(qq) && qq.length === 4) {
    const l = Math.hypot(qq[0], qq[1], qq[2], qq[3]) || 1
    let s = qq[3] < 0 || (qq[3] === 0 && (qq[0] < 0 || (qq[0] === 0 && (qq[1] < 0 || (qq[1] === 0 && qq[2] < 0))))) ? -1 : 1
    q = qq.map((x) => r9(s * x / l))
  }
  const names = (a) => Array.from(new Set((Array.isArray(a) ? a : []).filter((x) => typeof x === 'string'))).sort()
  const vec3 = (v) => (v != null && typeof v === 'object' && Number.isFinite(gx(v)) && Number.isFinite(gy(v)) && Number.isFinite(gz(v)) ? v : null)
  const pos = vec3(o.mountPos)
  const bore = vec3(o.mountBoresight) || vec3(o.boresightBody) || vec3(o.dirBody)
  const origin = pos || bore ? canonNum(maskRayOrigin(pos || [0, 0, 0], bore || [0, 0, 0]), r6) : null
  const key = {
    v: MASK_VERSION, g: `${MASK_W}x${MASK_H}`, off: MASK_RAY_OFFSET_M,
    sha: typeof o.modelSha === 'string' ? o.modelSha : (o.modelSha == null ? null : String(o.modelSha)),
    lod: o.lod == null ? null : String(o.lod),
    q, t: canonNum(f.t_model2body || f.t || null, r6),
    s: Number.isFinite(o.scaleToMeters) ? r9(o.scaleToMeters) : null,
    art: canonNum(o.articulations || null, r6),
    pos: origin,
    ex: names(o.excludeNodes), no: names(o.noObscurationNodes),
    sun: Number.isInteger(o.sunBin) ? o.sunBin : null
  }
  return fnv64(canonJson(key))
}

// ─────────────────────────────── 生成（通用 + 解析真值） ───────────────────────────────

/** 射线起点：posBody + MASK_RAY_OFFSET_M·视轴（视轴不必单位长）。 */
export function maskRayOrigin(posBody, boresightBody, out = [0, 0, 0]) {
  const bx = gx(boresightBody), by = gy(boresightBody), bz = gz(boresightBody), l = Math.hypot(bx, by, bz) || 1
  out[0] = gx(posBody) + MASK_RAY_OFFSET_M * bx / l
  out[1] = gy(posBody) + MASK_RAY_OFFSET_M * by / l
  out[2] = gz(posBody) + MASK_RAY_OFFSET_M * bz / l
  return out
}

/**
 * 逐格射线 → 掩模。cast(dirBody) 返回最近命中距离（m），不命中返回 Infinity（或任何非有限正数）。
 * 极点行只射一次再整行填（D2「极点行整行同值」）。Worker 端（BVH）与解析真值（boxMask）都走它，格的遍历次序与方向完全相同。
 */
export function buildMask(cast, out) {
  const m = out && out.blocked && out.clearance ? out : createMask()
  const d = [0, 0, 0]
  for (let e = 0; e < MASK_H; e++) {
    const pole = e === 0 || e === MASK_H - 1
    let t0 = Infinity
    for (let a = 0; a < MASK_W; a++) {
      const i = e * MASK_W + a
      if (!pole || a === 0) { maskDir(a, e, d); t0 = cast(d) }
      const hit = Number.isFinite(t0) && t0 >= 0
      m.blocked[i] = hit ? 1 : 0
      m.clearance[i] = hit ? t0 : Infinity
    }
  }
  return m
}

/**
 * 射线与轴对齐长方体求交（slab 法）：返回首个交点距离 t ≥ 0；起点在盒内返回 0；不相交返回 Infinity。
 * 分量恰为 0 的方向单独判（避免 0/0 = NaN）。
 */
export function rayAabb(o, d, min, max) {
  let t0 = -Infinity, t1 = Infinity
  for (let k = 0; k < 3; k++) {
    const ok = k === 0 ? gx(o) : k === 1 ? gy(o) : gz(o), dk = k === 0 ? gx(d) : k === 1 ? gy(d) : gz(d)
    if (dk === 0) { if (ok < min[k] || ok > max[k]) return Infinity; continue }
    let a = (min[k] - ok) / dk, b = (max[k] - ok) / dk
    if (a > b) { const s = a; a = b; b = s }
    if (a > t0) t0 = a
    if (b < t1) t1 = b
    if (t1 < t0) return Infinity
  }
  if (t1 < 0) return Infinity
  return t0 >= 0 ? t0 : 0
}

/**
 * 解析真值：若干轴对齐长方体（本体系，m）挡住的掩模。boxes = {min, max} 或其数组；origin 通常 = maskRayOrigin(pos, 视轴)。
 * 用途：本模块单测的真值 + Worker（BVH 版）对拍用的参照（P2V）。
 */
export function boxMask(boxes, origin, out) {
  const list = Array.isArray(boxes) ? boxes : [boxes]
  return buildMask((d) => {
    let best = Infinity
    for (const b of list) { const t = rayAabb(origin, d, b.min, b.max); if (t < best) best = t }
    return best
  }, out)
}

// ─────────────────────────────── 对日扫描（D3） ───────────────────────────────

/** 关节转角（度）→ 最近的扫描档 0..11（档 k 的角度 = k·30°，折到 (−180, 180]）。 */
export function sunScanBin(angleDeg) {
  if (!Number.isFinite(angleDeg)) return 0
  const k = Math.round(angleDeg / (360 / SUN_SCAN_BINS))
  return ((k % SUN_SCAN_BINS) + SUN_SCAN_BINS) % SUN_SCAN_BINS
}
/** 扫描档 → 关节转角（度，(−180, 180]）。 */
export function sunScanAngleDeg(bin) {
  const a = (((bin % SUN_SCAN_BINS) + SUN_SCAN_BINS) % SUN_SCAN_BINS) * (360 / SUN_SCAN_BINS)
  return a > 180 ? a - 360 : a
}

// ─────────────────────────────── 导出 CSV ───────────────────────────────

/** 'az,el,blocked,clearanceM' 逐格（az 0..359、el −90..90，行主序同下标）；通畅格的 clearanceM 留空。 */
export function maskToCsv(mask) {
  const rows = ['az,el,blocked,clearanceM']
  for (let e = 0, i = 0; e < MASK_H; e++) {
    for (let a = 0; a < MASK_W; a++, i++) {
      const c = mask.clearance ? mask.clearance[i] : Infinity
      rows.push(`${a},${e - 90},${mask.blocked[i] ? 1 : 0},${Number.isFinite(c) ? +c.toFixed(4) : ''}`)
    }
  }
  return rows.join('\n') + '\n'
}
