// 航迹运动学（DESIGN3 §0 E8、§1 P2）：给定时刻求航迹载具的位置、高度、航向、俯仰。纯 ESM、零依赖、node 可测。
//
// ── 口径 ──
//   位置   航点之间走【球面大圆】。航点 (大地纬, 经) 按 focusLanes.llaToVec 的球面口径（大地纬直接当球面纬）换成单位矢量，
//          段内 P(θ) = A·cosθ + T·sinθ（A = 段起点，T = A 处指向 B 的单位切向，θ ∈ [0, Ω]）——与 scene.js 航迹线的
//          slerp 是同一条大圆，载具恒在画出来的线上。单位矢量写在标准 ECEF 轴（Z 极轴）；场景轴 = (X, Z, −Y)。
//   距离   运动学里程 s 用 WGS-84 测地线段长（Vincenty 反算）：speedKmh 是真实地速，读数里的航程与「到达时刻」和运动一致。
//          段内按弧长比例换 θ：θ = Ω·(s − s_k) / len_k。球面弧与椭球测地线之比沿段缓变，段内瞬时速度相对名义地速有约 ±0.5 %
//          的起伏（南北向跨纬度的长段最大，实测最坏 0.53 %）；段端时刻准确。
//   航向   段内大圆切向在当地 N / E 上的方位（度，[0, 360)，正北起顺时针）。
//   高度   航行（kind ≠ 'flight'）altM 恒 0、俯仰恒 0。
//          飞行 + 有时刻与速度（运动档）：起降点 0 m（首 / 末航点带 altM 就用它）→ 按爬升率升到 cruiseAltM → 平飞 →
//            按下滑角（缺省 3°）降到末点；短航段到不了巡航高度时两条斜线相交成三角剖面。中间航点带 altM = 在该点钉住高度，
//            相邻两钉点之间各自按同一规则爬 / 平 / 降（段顶 = max(巡航, 两端钉点)）。钉点之间按爬升率 / 下滑角到不了时，
//            该段退成两钉点直线连接（坡度超限，照走，保证高度连续）。爬升梯度 = 爬升率 / 地速。
//          飞行 + 无时刻或速度（静止档）：各航点高度 = altM ?? cruiseAltM，段内按里程线性；航迹头 = 末航点高度。
//   俯仰   = 航迹角 atan(dh/ds)（度），夹在 ±PITCH_LIMIT_DEG（显示保护，只对离谱的钉点坡度起作用）。
//   无 t0Ms / speedKmh（或速度 ≤ 0、有效航点 < 2、全程零长）：钉在航迹头（末航点），航向取末段大圆切向——
//          切向矢量 tan 与 scene.setTrajectories 载具的 spr._tan 逐位一致（sceneHeadTangent 按同一串浮点运算复写，单测用
//          three 的 Vector3 与 focusLanes.llaToVec 对拍）。
//
// ── 航迹对象（与 ConstellationMap3D 的 trajectories 同形；E7 的新字段全部可选）──
//   { id?, kind: 'flight'|'sea', pts: [{lat, lon, altM?}], cruiseAltM?, t0Ms?, speedKmh?, climbRateMs?, glideDeg? }
//   坐标非有限的航点跳过（与页面 markerTrs 的 finLL 过滤同口径）；数值一律按 Number.isFinite 判，不做字符串转换。
//
// ── 热路径 ──
//   trajStateAt(traj, tMs, out)：out 复用即无显式分配。航迹的几何（单位矢量、段长、钉点）缓存在「计划」里：按 traj.id（没有就按对象）
//   取缓存，每次调用 O(n) 逐点核对原下标 / lat / lon / altM（只比数、不算三角函数），变了才重建——页面每拍传进新拷贝、原地改航点、
//   表格里挪空行都对。里程 / 地速这类 double 经 out 的字段在内部函数间递、不当实参传（未内联的调用边界会装箱）；采样堆分析：
//   模块内 ≈ 0 B / 次，航迹对象形状杂到取数变 megamorphic 时每个 double 字段装箱 16 B（单测 ⑨ 报数、宽判据）。
//
// ── ★ 调用方门控（DESIGN3 §2 红线：新开关全关时球面、平面图逐像素不变）──
//   航迹线的剖面抬高（trajStateAtS 取 altM）与大圆加密（densifyGreatCircle / greatCircleInterp；入口 entityRuntime.trajLinePts）
//   只对运动档航迹启用，判据 = Number.isFinite(trajEndMs(traj))
//   （与 trajStateAt 的 moving 同一条件：t0Ms 有限、speedKmh > 0、全程非零长）。静止档航迹维持现有画法：3D 线 r = 1.002、2D 经纬直连——
//   静止档飞行按口径全程是巡航高度（缺省 10668 m ≈ r 1.00167），拿它去抬线或加密都会让老航迹的画面变样。
//
// 导出：trajStateAt / trajStateAtS / makeTrajState / trajPlan / trajLengthM / trajEndMs / sceneHeadTangent /
//       greatCircleInterp / greatCircleDistanceM / wgs84DistanceM / clearTrajPlanCache / trajPlanStats / 常量 /
//       GC_STEP_DEG / densifyGreatCircle（航迹线大圆加密，P4）

const D2R = Math.PI / 180, R2D = 180 / Math.PI

/** 场景球半径（km）：与 focusLanes.RE、attitude.EARTH_RADIUS_KM 同值。 */
export const SCENE_RE_KM = 6371
/** 飞行缺省巡航高度（m）：FL350 = 35000 ft = 10668 m（DESIGN3 E7）。 */
export const CRUISE_ALT_M_DEFAULT = 10668
/**
 * 缺省爬升率（m/s）= 2000 ft/min。★ illustrative（示意值，没有核到出处）：只用来给起飞段一个可见的斜坡；
 * 航迹对象可用 climbRateMs 覆盖。地速 830 km/h 时爬升梯度约 2.5°，升到 FL350 约走 242 km。
 */
export const CLIMB_RATE_MS_DEFAULT = 10.16
/** 缺省下滑角（度）：3°，DESIGN3 E8 定死；ICAO Doc 8168 PANS-OPS 仪表着陆下滑道的最佳角即 3.0°。 */
export const GLIDE_DEG_DEFAULT = 3
/** 俯仰显示保护（度）：illustrative，只防离谱钉点坡度把模型竖起来。 */
export const PITCH_LIMIT_DEG = 25

// WGS-84：与 src/viz/wgs84.js 的 A / B、vendor satellite.js 的 geodeticToEcf 同一对常数（km → m）
const WGS_A_M = 6378137, WGS_B_M = 6356752.3142
const WGS_F = (WGS_A_M - WGS_B_M) / WGS_A_M

const PHASE_STATIC = 'static', PHASE_PRE = 'pre', PHASE_CLIMB = 'climb', PHASE_CRUISE = 'cruise', PHASE_DESCENT = 'descent', PHASE_DONE = 'done'

const fin = Number.isFinite
const norm2 = (x, y) => Math.sqrt(x * x + y * y)
const norm3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z)
// [0, 360)：负的微小值 +360 会舍入成 360，折回 0；−0 → 0
const wrap360 = (deg) => { const d = deg % 360, r = d < 0 ? d + 360 : d; return r >= 360 || r === 0 ? 0 : r }
const clampPitch = (deg) => (deg > PITCH_LIMIT_DEG ? PITCH_LIMIT_DEG : (deg < -PITCH_LIMIT_DEG ? -PITCH_LIMIT_DEG : deg))

// ─────────────────────────────── 距离 ───────────────────────────────

/** 场景球（R = 6371 km）上两点的大圆距离（m）。 */
export function greatCircleDistanceM(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R
  const c1 = Math.cos(p1), s1 = Math.sin(p1), c2 = Math.cos(p2), s2 = Math.sin(p2), cl = Math.cos(dl), sl = Math.sin(dl)
  const x = c2 * sl, y = c1 * s2 - s1 * c2 * cl
  return Math.atan2(norm2(x, y), s1 * s2 + c1 * c2 * cl) * SCENE_RE_KM * 1000
}

/**
 * WGS-84 测地线距离（m），Vincenty（1975）反算。读数口径：航程、段长。
 * 近对跖点（Vincenty 不收敛，经差接近 180° 的少数情形）退化为「沿球面大圆路径」在椭球面上的弧长（数值积分 + Richardson 外推）：
 * 那条路径也在椭球面上，长度 ≥ 测地线，是上界；赤道对跖两点时恰好就是过极点的子午线（= 测地线）。
 */
export function wgs84DistanceM(lat1, lon1, lat2, lon2) {
  if (!(fin(lat1) && fin(lon1) && fin(lat2) && fin(lon2))) return NaN
  const f = WGS_F, a = WGS_A_M, b = WGS_B_M
  let L = (lon2 - lon1) * D2R
  L -= 2 * Math.PI * Math.round(L / (2 * Math.PI))                       // (−π, π]
  const U1 = Math.atan((1 - f) * Math.tan(lat1 * D2R)), U2 = Math.atan((1 - f) * Math.tan(lat2 * D2R))
  const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2)
  let lam = L, prev = 0, it = 0
  let sinS = 0, cosS = 0, sig = 0, cos2a = 0, c2sm = 0
  do {
    const sl = Math.sin(lam), cl = Math.cos(lam)
    const t1 = cU2 * sl, t2 = cU1 * sU2 - sU1 * cU2 * cl
    sinS = norm2(t1, t2)
    cosS = sU1 * sU2 + cU1 * cU2 * cl
    if (sinS === 0) { if (cosS > 0) return 0; it = 1000; break }           // 重合 → 0；恰好对跖 → 退化
    sig = Math.atan2(sinS, cosS)
    const sinA = cU1 * cU2 * sl / sinS
    cos2a = 1 - sinA * sinA
    c2sm = cos2a !== 0 ? cosS - 2 * sU1 * sU2 / cos2a : 0                  // 赤道线：cos²α = 0
    const C = f / 16 * cos2a * (4 + f * (4 - 3 * cos2a))
    prev = lam
    lam = L + (1 - C) * f * sinA * (sig + C * sinS * (c2sm + C * cosS * (-1 + 2 * c2sm * c2sm)))
    if (Math.abs(lam) > Math.PI) { it = 1000; break }                      // 反常：对跖附近 λ 越界
  } while (Math.abs(lam - prev) > 1e-12 && ++it < 200)
  if (it >= 200) return pathLengthOnEllipsoidM(lat1, lon1, lat2, lon2)
  const u2 = cos2a * (a * a - b * b) / (b * b)
  const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)))
  const B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)))
  const dS = B * sinS * (c2sm + B / 4 * (cosS * (-1 + 2 * c2sm * c2sm) - B / 6 * c2sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * c2sm * c2sm)))
  return b * A * (sig - dS)
}

// 大地 (lat, lon, 0) → WGS-84 ECEF（m），写进 o
function geoEcefM(latDeg, lonDeg, o) {
  const p = latDeg * D2R, l = lonDeg * D2R, sp = Math.sin(p), cp = Math.cos(p)
  const e2 = 2 * WGS_F - WGS_F * WGS_F
  const N = WGS_A_M / Math.sqrt(1 - e2 * sp * sp)
  o[0] = N * cp * Math.cos(l); o[1] = N * cp * Math.sin(l); o[2] = N * (1 - e2) * sp
  return o
}
const _gP = [0, 0, 0], _gQ = [0, 0, 0], _gi = { lat: 0, lon: 0 }
function polyLen(lat1, lon1, lat2, lon2, N) {
  geoEcefM(lat1, lon1, _gP)
  let sum = 0
  for (let i = 1; i <= N; i++) {
    greatCircleInterp(lat1, lon1, lat2, lon2, i / N, _gi)
    geoEcefM(_gi.lat, _gi.lon, _gQ)
    sum += norm3(_gQ[0] - _gP[0], _gQ[1] - _gP[1], _gQ[2] - _gP[2])
    _gP[0] = _gQ[0]; _gP[1] = _gQ[1]; _gP[2] = _gQ[2]
  }
  return sum
}
function pathLengthOnEllipsoidM(lat1, lon1, lat2, lon2) {
  const l1 = polyLen(lat1, lon1, lat2, lon2, 512), l2 = polyLen(lat1, lon1, lat2, lon2, 1024)
  return (4 * l2 - l1) / 3                                                 // 折线弦长误差 ∝ h²，外推一阶
}

// ─────────────────────────────── 球面大圆 ───────────────────────────────

// 大地 (lat, lon) → 球面口径单位矢量（标准 ECEF 轴），写进 o[off..off+2]
function unitInto(latDeg, lonDeg, o, off) {
  const p = latDeg * D2R, l = lonDeg * D2R, cp = Math.cos(p)
  o[off] = cp * Math.cos(l); o[off + 1] = cp * Math.sin(l); o[off + 2] = Math.sin(p)
}
// A 处指向 B 的单位切向写进 T[off..]（Ω 由调用方给）；A、B 近对跖时 T 取 A 处正北（绕极走），A 在极点再退到 ECEF +X 去径向分量
function tangentInto(ax, ay, az, bx, by, bz, T, off) {
  const d = ax * bx + ay * by + az * bz
  let tx = bx - d * ax, ty = by - d * ay, tz = bz - d * az
  let l = norm3(tx, ty, tz)
  if (!(l > 1e-15)) {
    const cp = norm2(ax, ay)
    if (cp > 1e-12) { tx = -az * ax / cp; ty = -az * ay / cp; tz = cp }     // 当地正北
    else { tx = 1 - ax * ax; ty = -ax * ay; tz = -ax * az }
    l = norm3(tx, ty, tz)
  }
  T[off] = tx / l; T[off + 1] = ty / l; T[off + 2] = tz / l
}
const _ia = [0, 0, 0], _ib = [0, 0, 0], _it = [0, 0, 0]
/**
 * 球面大圆上的插值点（与载具运动同一条大圆）：f = 0 → A、f = 1 → B。给 2D 航迹线大圆加密用（只对运动档航迹，见文件头「调用方门控」）。
 * @returns {{lat:number, lon:number}} out（lon ∈ (−180, 180]）
 */
export function greatCircleInterp(latA, lonA, latB, lonB, f, out = { lat: 0, lon: 0 }) {
  unitInto(latA, lonA, _ia, 0); unitInto(latB, lonB, _ib, 0)
  const cx = _ia[1] * _ib[2] - _ia[2] * _ib[1], cy = _ia[2] * _ib[0] - _ia[0] * _ib[2], cz = _ia[0] * _ib[1] - _ia[1] * _ib[0]
  const om = Math.atan2(norm3(cx, cy, cz), _ia[0] * _ib[0] + _ia[1] * _ib[1] + _ia[2] * _ib[2])
  tangentInto(_ia[0], _ia[1], _ia[2], _ib[0], _ib[1], _ib[2], _it, 0)
  const th = f * om, c = Math.cos(th), s = Math.sin(th)
  const px = _ia[0] * c + _it[0] * s, py = _ia[1] * c + _it[1] * s, pz = _ia[2] * c + _it[2] * s
  out.lat = Math.atan2(pz, norm2(px, py)) * R2D
  out.lon = Math.atan2(py, px) * R2D
  return out
}

// 单位点 P（ECEF）处方向 D 的方位角（度，[0, 360)）。N / E 按 P 的经度 atan2(py, px) 取，与 state.lon 同一经度：
// 航点恰填 lat = ±90 时 cos(90°) = 6.1e-17 ≠ 0，px / cp、py / cp 仍精确给出 cos / sin(航点经度)，所以阈值只能是 > 0；
// 只有 px = py = 0（atan2 也给 0）才按经度 0 取。
function headingAt(px, py, pz, dx, dy, dz) {
  const cp = norm2(px, py)
  let cl = 1, sl = 0
  if (cp > 0) { cl = px / cp; sl = py / cp }
  const dE = -sl * dx + cl * dy
  const dN = -pz * (cl * dx + sl * dy) + cp * dz
  return wrap360(Math.atan2(dE, dN) * R2D)
}

// focusLanes.llaToVec 同式（逐字照抄求值次序），写进 o
function llaSceneInto(latDeg, lonDeg, altKm, o) {
  const r = (SCENE_RE_KM + altKm) / SCENE_RE_KM
  const phi = (90 - latDeg) * Math.PI / 180
  const theta = (lonDeg + 180) * Math.PI / 180
  o[0] = -r * Math.sin(phi) * Math.cos(theta)
  o[1] = r * Math.cos(phi)
  o[2] = r * Math.sin(phi) * Math.sin(theta)
  return o
}
const _sh = [0, 0, 0], _sp = [0, 0, 0]
/**
 * 航迹头载具的切向（场景轴）——scene.setTrajectories 里 spr._tan 的逐位复写（three 的 Vector3 运算按原次序展开）：
 *   pos = llaToVec(头, 0)·1.0025；hn = pos 归一；pv = llaToVec(前一点, 0) 归一；
 *   tan = −(pv − (hn·pv)·hn)；|tan|² > 1e-12 才归一并采用。
 * @param {number[]} out  写进场景轴单位切向
 * @returns {boolean} 有无切向（false = 原代码不设 _tan，out 不动）
 */
export function sceneHeadTangent(prevLat, prevLon, headLat, headLon, out) {
  llaSceneInto(headLat, headLon, 0, _sh)
  const px = _sh[0] * 1.0025, py = _sh[1] * 1.0025, pz = _sh[2] * 1.0025
  const hl = Math.sqrt(px * px + py * py + pz * pz) || 1, hi = 1 / hl
  const hx = px * hi, hy = py * hi, hz = pz * hi
  llaSceneInto(prevLat, prevLon, 0, _sp)
  const vl = Math.sqrt(_sp[0] * _sp[0] + _sp[1] * _sp[1] + _sp[2] * _sp[2]) || 1, vi = 1 / vl
  const vx = _sp[0] * vi, vy = _sp[1] * vi, vz = _sp[2] * vi
  const s = -(hx * vx + hy * vy + hz * vz)
  let tx = vx + hx * s, ty = vy + hy * s, tz = vz + hz * s
  tx *= -1; ty *= -1; tz *= -1
  if (!(tx * tx + ty * ty + tz * tz > 1e-12)) return false
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1, ti = 1 / tl
  out[0] = tx * ti; out[1] = ty * ti; out[2] = tz * ti
  return true
}

// ─────────────────────────────── 计划（航迹几何缓存） ───────────────────────────────

const PLAN_TAG = '__trajPlan'
let _builds = 0
const CACHE_MAX = 2048
const _cacheById = new Map()
let _cacheByObj = new WeakMap()

function newPlan() {
  return {
    [PLAN_TAG]: true, n: 0, m: 0, cap: 0,
    lat: new Float64Array(0), lon: new Float64Array(0), alt: new Float64Array(0), idx: new Int32Array(0),
    u: new Float64Array(0), T: new Float64Array(0), om: new Float64Array(0), len: new Float64Array(0), cum: new Float64Array(0),
    L: 0, kFirst: -1, kLast: -1,
    kS: new Float64Array(0), kH: new Float64Array(0), K: 0,                 // 运动档飞行剖面的钉点（里程 m、高度 m）
    hasTanHead: false, tanHead: new Float64Array(3), headHeadingDeg: 0
  }
}
const altOf = (p) => (fin(p.altM) ? p.altM : NaN)
const sameNum = (a, b) => a === b || (a !== a && b !== b)                // NaN 视作相等

// 核对缓存的计划与当前航点：原长、每个有效航点的原下标（leg 取它，无效行挪位置也要重建）、lat / lon / altM
function planMatches(plan, pts) {
  const n = pts ? pts.length : 0
  if (n !== plan.n) return false
  let j = 0
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    if (!p || !fin(p.lat) || !fin(p.lon)) continue
    if (j >= plan.m || plan.idx[j] !== i || plan.lat[j] !== p.lat || plan.lon[j] !== p.lon || !sameNum(plan.alt[j], altOf(p))) return false
    j++
  }
  return j === plan.m
}

function buildPlan(pts, reuse) {
  _builds++
  const plan = reuse || newPlan()
  const n = pts && typeof pts.length === 'number' ? pts.length : 0
  let m = 0
  for (let i = 0; i < n; i++) { const p = pts[i]; if (p && fin(p.lat) && fin(p.lon)) m++ }
  if (m > plan.cap) {
    const c = Math.max(4, m)
    plan.lat = new Float64Array(c); plan.lon = new Float64Array(c); plan.alt = new Float64Array(c); plan.idx = new Int32Array(c)
    plan.u = new Float64Array(3 * c); plan.T = new Float64Array(3 * c); plan.om = new Float64Array(c); plan.len = new Float64Array(c); plan.cum = new Float64Array(c)
    plan.kS = new Float64Array(c); plan.kH = new Float64Array(c)
    plan.cap = c
  }
  plan.n = n; plan.m = m
  let j = 0
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    if (!p || !fin(p.lat) || !fin(p.lon)) continue
    plan.lat[j] = p.lat; plan.lon[j] = p.lon; plan.alt[j] = altOf(p); plan.idx[j] = i
    unitInto(p.lat, p.lon, plan.u, 3 * j)
    j++
  }
  // 段：Ω（球面角）、切向 T、WGS-84 段长、累计里程
  const u = plan.u, T = plan.T
  plan.kFirst = -1; plan.kLast = -1
  let cum = 0
  if (m) plan.cum[0] = 0
  for (let k = 0; k + 1 < m; k++) {
    const a = 3 * k, b = a + 3
    const cx = u[a + 1] * u[b + 2] - u[a + 2] * u[b + 1], cy = u[a + 2] * u[b] - u[a] * u[b + 2], cz = u[a] * u[b + 1] - u[a + 1] * u[b]
    const om = Math.atan2(norm3(cx, cy, cz), u[a] * u[b] + u[a + 1] * u[b + 1] + u[a + 2] * u[b + 2])
    let len = om > 0 ? wgs84DistanceM(plan.lat[k], plan.lon[k], plan.lat[k + 1], plan.lon[k + 1]) : 0
    if (!(len > 0)) len = 0
    plan.om[k] = len > 0 ? om : 0
    plan.len[k] = len
    if (len > 0) {
      tangentInto(u[a], u[a + 1], u[a + 2], u[b], u[b + 1], u[b + 2], T, a)
      if (plan.kFirst < 0) plan.kFirst = k
      plan.kLast = k
    } else { T[a] = 0; T[a + 1] = 0; T[a + 2] = 0 }
    cum += len
    plan.cum[k + 1] = cum
  }
  plan.L = cum
  // 运动档飞行剖面钉点：起点（altM ?? 0）、中间带 altM 的航点、终点（altM ?? 0）
  let K = 0
  if (m) {
    plan.kS[K] = 0; plan.kH[K] = fin(plan.alt[0]) ? plan.alt[0] : 0; K++
    for (let k = 1; k + 1 < m; k++) if (fin(plan.alt[k])) { plan.kS[K] = plan.cum[k]; plan.kH[K] = plan.alt[k]; K++ }
    if (m > 1) { plan.kS[K] = cum; plan.kH[K] = fin(plan.alt[m - 1]) ? plan.alt[m - 1] : 0; K++ }
  }
  plan.K = K
  // 航迹头：scene 口径切向 + 航向
  plan.hasTanHead = m > 1 && sceneHeadTangent(plan.lat[m - 2], plan.lon[m - 2], plan.lat[m - 1], plan.lon[m - 1], plan.tanHead)
  if (plan.hasTanHead) {
    const t = plan.tanHead, h = 3 * (m - 1)
    plan.headHeadingDeg = headingAt(u[h], u[h + 1], u[h + 2], t[0], -t[2], t[1])          // 场景轴 → ECEF：(x, −z, y)
  } else if (plan.kLast >= 0) {
    plan.headHeadingDeg = arrivalHeading(plan, plan.kLast, 3 * (m - 1))
  } else plan.headHeadingDeg = 0
  return plan
}

// 段 k 终点处的前进方向在点 u[h..] 的方位（到达航向）
function arrivalHeading(plan, k, h) {
  const u = plan.u, T = plan.T, a = 3 * k, om = plan.om[k], s = Math.sin(om), c = Math.cos(om)
  return headingAt(u[h], u[h + 1], u[h + 2], -u[a] * s + T[a] * c, -u[a + 1] * s + T[a + 1] * c, -u[a + 2] * s + T[a + 2] * c)
}

/**
 * 航迹的几何计划（缓存命中即返回同一个对象）。trajStateAt 也接受它（跳过核对）；一般直接传航迹对象即可。
 * @param {object} traj
 */
export function trajPlan(traj) {
  if (traj && traj[PLAN_TAG] === true) return traj
  if (!traj || typeof traj !== 'object') return buildPlan(null, null)
  const id = traj.id
  const byId = typeof id === 'string' || typeof id === 'number'
  let plan = byId ? _cacheById.get(id) : _cacheByObj.get(traj)
  if (plan && planMatches(plan, traj.pts)) return plan
  plan = buildPlan(traj.pts, plan)
  if (byId) {
    if (!_cacheById.has(id) && _cacheById.size >= CACHE_MAX) _cacheById.clear()
    _cacheById.set(id, plan)
  } else _cacheByObj.set(traj, plan)
  return plan
}
/** 清空计划缓存（测试 / 页面卸载用）。 */
export function clearTrajPlanCache() { _cacheById.clear(); _cacheByObj = new WeakMap() }
/** 计划重建次数（测试核对缓存命中用）。 */
export function trajPlanStats() { return { builds: _builds, cachedById: _cacheById.size } }

// ─────────────────────────────── 状态 ───────────────────────────────

/**
 * 空状态（out 容器）。
 *   ok         有无有效航点（false 时其余字段为 NaN）
 *   lat / lon  大地纬经（度）；静止档与起止两端 = 航点原值，运动中 lon ∈ (−180, 180]
 *   altM       高度（m，相对起降点 / 海面）
 *   headingDeg 航向（度，[0, 360)，正北起顺时针）
 *   pitchDeg   航迹角（度，抬头为正）
 *   leg        所在段起点航点在 traj.pts 里的原下标
 *   s / sTotal 已走里程 / 全程（m，WGS-84 测地线段长之和）
 *   done       运动档已到达终点
 *   moving     true = 运动档（有 t0Ms + speedKmh）；false = 静止档（钉在航迹头）
 *   phase      'static' | 'pre'（未出发）| 'climb' | 'cruise' | 'descent' | 'done'
 *   tan        场景轴单位切向（静止档 = scene 的 spr._tan 逐位同值）；hasTan = false 时无意义
 */
export function makeTrajState() {
  return { ok: false, lat: NaN, lon: NaN, altM: NaN, headingDeg: NaN, pitchDeg: NaN, leg: 0, s: 0, sTotal: 0, done: false, moving: false, phase: PHASE_STATIC, tan: [0, 0, 0], hasTan: false }
}

const isFlight = (traj) => traj.kind === 'flight'
const cruiseOf = (traj) => (fin(traj.cruiseAltM) && traj.cruiseAltM >= 0 ? traj.cruiseAltM : CRUISE_ALT_M_DEFAULT)
const speedMsOf = (traj) => (fin(traj.speedKmh) && traj.speedKmh > 0 ? traj.speedKmh / 3.6 : NaN)
// 热路径只问「有没有地速」（布尔不装箱）；要数值时就地 speedKmh / 3.6——speedMsOf 这种返回 double 的小函数没内联时每次装箱 16 B
const hasSpeed = (traj) => fin(traj.speedKmh) && traj.speedKmh > 0
const staticAlt = (plan, j, cruise) => (fin(plan.alt[j]) ? plan.alt[j] : cruise)

function setInvalid(o) {
  o.ok = false; o.lat = NaN; o.lon = NaN; o.altM = NaN; o.headingDeg = NaN; o.pitchDeg = NaN
  o.leg = 0; o.s = 0; o.sTotal = 0; o.done = false; o.moving = false; o.phase = PHASE_STATIC; o.hasTan = false
  return o
}
function setTanFromEcef(o, dx, dy, dz) { const t = o.tan; t[0] = dx; t[1] = dz; t[2] = -dy; o.hasTan = true }

// 静止档：航迹头
function staticInto(plan, traj, o) {
  const m = plan.m, h = m - 1
  o.ok = true; o.moving = false; o.done = false; o.phase = PHASE_STATIC
  o.lat = plan.lat[h]; o.lon = plan.lon[h]
  o.s = plan.L; o.sTotal = plan.L
  o.leg = m > 1 ? plan.idx[m - 2] : plan.idx[0]
  o.headingDeg = plan.headHeadingDeg
  if (plan.hasTanHead) { const t = o.tan; t[0] = plan.tanHead[0]; t[1] = plan.tanHead[1]; t[2] = plan.tanHead[2]; o.hasTan = true } else o.hasTan = false
  if (isFlight(traj)) {
    const cr = cruiseOf(traj)
    o.altM = staticAlt(plan, h, cr)
    o.pitchDeg = m > 1 && plan.len[m - 2] > 0 ? clampPitch(Math.atan2(o.altM - staticAlt(plan, m - 2, cr), plan.len[m - 2]) * R2D) : 0
  } else { o.altM = 0; o.pitchDeg = 0 }
  return o
}

// 位置与航向：里程取 o.s（∈ [0, L]，L > 0，调用方先写好）；返回所在段 k。
// ★ 里程 / 地速这类 double 不当实参传（未内联的调用边界会把它装箱成 HeapNumber，每拍 16 B / 个），经 out 的 double 字段递过去。
function positionInto(plan, o) {
  const m = plan.m, cum = plan.cum, s = o.s
  let k
  if (s <= 0) k = plan.kFirst
  else if (s >= plan.L) k = plan.kLast
  else {
    let lo = 0, hi = m - 2                                                  // 最大的 k ≤ m−2 使 cum[k] ≤ s → 必为非零长段
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid - 1 }
    k = lo
  }
  const u = plan.u, T = plan.T, a = 3 * k
  let f = (s - cum[k]) / plan.len[k]
  f = f < 0 ? 0 : (f > 1 ? 1 : f)
  const th = f * plan.om[k], c = Math.cos(th), sn = Math.sin(th)
  const px = u[a] * c + T[a] * sn, py = u[a + 1] * c + T[a + 1] * sn, pz = u[a + 2] * c + T[a + 2] * sn
  const dx = -u[a] * sn + T[a] * c, dy = -u[a + 1] * sn + T[a + 1] * c, dz = -u[a + 2] * sn + T[a + 2] * c
  o.lat = Math.atan2(pz, norm2(px, py)) * R2D
  o.lon = Math.atan2(py, px) * R2D
  o.headingDeg = headingAt(px, py, pz, dx, dy, dz)
  setTanFromEcef(o, dx, dy, dz)
  o.leg = plan.idx[k]
  return k
}

// 飞行高度剖面（运动档，调用方已确认 hasSpeed）：钉点段内 min(段顶, 爬升线, 下滑线)；到不了就直线。里程取 o.s、地速就地取。
// 写 o.altM / o.pitchDeg / o.phase
function profileMovingInto(plan, traj, o) {
  const kS = plan.kS, kH = plan.kH, K = plan.K, s = o.s, speedMs = traj.speedKmh / 3.6
  let j = 0
  { let lo = 0, hi = K - 2; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (kS[mid] <= s) lo = mid; else hi = mid - 1 } j = lo }
  const sA = kS[j], sB = kS[j + 1], hA = kH[j], hB = kH[j + 1], d = sB - sA
  let h, slope
  if (!(d > 0)) { h = hB; slope = 0 }
  else {
    const cr = cruiseOf(traj)
    const rate = fin(traj.climbRateMs) && traj.climbRateMs > 0 ? traj.climbRateMs : CLIMB_RATE_MS_DEFAULT
    const gd = fin(traj.glideDeg) && traj.glideDeg > 0 && traj.glideDeg < 90 ? traj.glideDeg : GLIDE_DEG_DEFAULT
    const tc = rate / speedMs, td = Math.tan(gd * D2R)
    const feasible = hB >= hA ? hB - hA <= d * tc : hA - hB <= d * td
    if (!feasible) { slope = (hB - hA) / d; h = hA + slope * (s - sA) }
    else {
      const cap = Math.max(cr, hA, hB)
      const u1 = hA + (s - sA) * tc, u2 = hB + (sB - s) * td
      if (cap <= u1 && cap <= u2) { h = cap; slope = 0 }
      else if (u1 <= u2) { h = u1; slope = tc }
      else { h = u2; slope = -td }
    }
  }
  o.altM = h
  o.pitchDeg = clampPitch(Math.atan(slope) * R2D)
  o.phase = slope > 0 ? PHASE_CLIMB : (slope < 0 ? PHASE_DESCENT : PHASE_CRUISE)
}

// 飞行高度（静止档口径：各航点 altM ?? 巡航，段内线性）；里程取 o.s
function profileStaticInto(plan, traj, k, o) {
  const cr = cruiseOf(traj), s = o.s
  const hA = staticAlt(plan, k, cr), hB = staticAlt(plan, k + 1, cr), d = plan.len[k]
  let f = d > 0 ? (s - plan.cum[k]) / d : 1
  f = f < 0 ? 0 : (f > 1 ? 1 : f)
  const slope = d > 0 ? (hB - hA) / d : 0
  o.altM = hA + (hB - hA) * f
  o.pitchDeg = clampPitch(Math.atan(slope) * R2D)
  o.phase = slope > 0 ? PHASE_CLIMB : (slope < 0 ? PHASE_DESCENT : PHASE_CRUISE)
}

/**
 * 按里程求状态（不看时刻）：s 夹在 [0, 全程]。有 speedKmh 的飞行航迹按运动档剖面（起降 0 m、爬升、巡航、3° 下滑），
 * 没有速度按静止档口径（航点 altM ?? 巡航、段内线性）。给航迹线按剖面抬高度、读数面板用。有效航点 < 2 或全程零长时同静止档。
 * phase 恒不为 'pre' / 'done'（那是时刻口径），moving 恒 false。
 * ★ 拿它抬航迹线只对运动档航迹（Number.isFinite(trajEndMs(traj))）做，静止档航迹的线保持现状（见文件头「调用方门控」）。
 */
export function trajStateAtS(traj, sM, out) {
  const o = out || makeTrajState()
  if (!traj || typeof traj !== 'object') return setInvalid(o)
  const plan = trajPlan(traj)
  if (!plan.m) return setInvalid(o)
  if (plan.kFirst < 0) return staticInto(plan, traj, o)
  const L = plan.L
  const s = fin(sM) ? (sM < 0 ? 0 : (sM > L ? L : sM)) : 0
  o.ok = true; o.moving = false; o.done = false
  o.s = s; o.sTotal = L
  const k = positionInto(plan, o)
  const src = traj[PLAN_TAG] === true ? null : traj
  if (src && isFlight(src)) {
    if (hasSpeed(src)) profileMovingInto(plan, src, o); else profileStaticInto(plan, src, k, o)
  } else { o.altM = 0; o.pitchDeg = 0; o.phase = PHASE_CRUISE }
  return o
}

/**
 * 航迹载具在 tMs 的状态（DESIGN3 E8）。
 *   有 t0Ms（有限）+ speedKmh（> 0）且全程非零长 → 运动档：s = 地速 × (tMs − t0Ms)；s < 0 停在起点（phase 'pre'、地面高度），
 *     s ≥ 全程停在终点（done = true）；途中沿大圆、按剖面给高度与俯仰。
 *   否则 → 静止档：钉在航迹头（末航点），与 scene.setTrajectories 的载具位置、_tan 逐位一致；飞行高度 = 末航点 altM ?? 巡航高度。
 * @param {object} traj  航迹对象或 trajPlan 的结果（后者没有 kind / 速度，只能出静止档）
 * @param {number} tMs   UTC 毫秒（clock.tMs）
 * @param {object} [out] makeTrajState() 的容器，复用即零分配
 */
export function trajStateAt(traj, tMs, out) {
  const o = out || makeTrajState()
  if (!traj || typeof traj !== 'object') return setInvalid(o)
  const plan = trajPlan(traj)
  if (!plan.m) return setInvalid(o)
  const src = traj[PLAN_TAG] === true ? null : traj
  if (!src) return staticInto(plan, {}, o)
  const sk = src.speedKmh, t0 = src.t0Ms                                    // 各取一次（页面形状杂时每次取 double 都可能装箱）
  if (!(fin(sk) && sk > 0) || !fin(t0) || plan.kFirst < 0 || !fin(tMs)) return staticInto(plan, src, o)
  const v = sk / 3.6
  const L = plan.L
  const s = (tMs - t0) / 1000 * v
  const flight = isFlight(src)
  o.ok = true; o.moving = true; o.sTotal = L
  if (s <= 0 || s >= L) {
    // 两端：航点原值、到达 / 出发航向、地面（或钉点）高度、俯仰 0
    const end = s >= L, j = end ? plan.m - 1 : 0, k = end ? plan.kLast : plan.kFirst, h = 3 * j
    o.lat = plan.lat[j]; o.lon = plan.lon[j]
    const u = plan.u, T = plan.T, a = 3 * k
    if (end) {
      const om = plan.om[k], sn = Math.sin(om), c = Math.cos(om)
      const dx = -u[a] * sn + T[a] * c, dy = -u[a + 1] * sn + T[a + 1] * c, dz = -u[a + 2] * sn + T[a + 2] * c
      o.headingDeg = headingAt(u[h], u[h + 1], u[h + 2], dx, dy, dz); setTanFromEcef(o, dx, dy, dz)
    } else {
      o.headingDeg = headingAt(u[h], u[h + 1], u[h + 2], T[a], T[a + 1], T[a + 2]); setTanFromEcef(o, T[a], T[a + 1], T[a + 2])
    }
    o.leg = plan.idx[k]
    o.s = end ? L : 0
    o.done = end
    o.phase = end ? PHASE_DONE : PHASE_PRE
    o.altM = flight ? plan.kH[end ? plan.K - 1 : 0] : 0
    o.pitchDeg = 0
    return o
  }
  o.done = false
  o.s = s
  positionInto(plan, o)
  if (flight) profileMovingInto(plan, src, o)
  else { o.altM = 0; o.pitchDeg = 0; o.phase = PHASE_CRUISE }
  return o
}

/** 全程（m，WGS-84 测地线段长之和；跳过坐标无效的航点）。 */
export function trajLengthM(traj) { return trajPlan(traj).L }
/** 运动档的到达时刻（ms）；不是运动档返回 NaN。 */
export function trajEndMs(traj) {
  if (!traj || typeof traj !== 'object' || traj[PLAN_TAG] === true) return NaN
  const v = speedMsOf(traj), plan = trajPlan(traj)
  return fin(v) && fin(traj.t0Ms) && plan.L > 0 ? traj.t0Ms + plan.L / v * 1000 : NaN
}

// ─────────────────────────────── 航迹线大圆加密（P4） ───────────────────────────────

/** 航迹线大圆加密的最大球心角步长（度）：0.5° ≈ 55.6 km，弦下陷 ≈ 61 m。 */
export const GC_STEP_DEG = 0.5

// 经度归一到 (−180, 180]：已在区间内的值原样返回（航点坐标逐位保留）；区间外按模折回，−180 记作 180
function normLonDeg(lon) {
  if (lon > -180 && lon <= 180) return lon
  let x = ((lon + 180) % 360 + 360) % 360 - 180
  if (x === -180) x = 180
  return x
}
const _dA = [0, 0, 0], _dB = [0, 0, 0]
// 零长段判据（rad）：≈ 6 µm。经差 360° 的同一点换算单位矢量后差几个 ulp（θ ≈ 1e-16），按零长处理，免得出重复点
const GC_ZERO_RAD = 1e-12
/**
 * 大圆加密（航迹线唯一几何定义；2D / 3D 航迹线与载具运动同一条大圆）。
 *   逐段按球心角 θ（与 buildPlan 同式：atan2(|a×b|, a·b)）取 n = ceil(θ / step)；θ ≤ 1e-12 rad 的段不出点（重复航点不重复出）。
 *   段内出 i = 1 … n−1 的 greatCircleInterp(A, B, i/n)（逐位同一函数，近对跖段同走 tangentInto 的「绕北」口径 = trajStateAt 的路），
 *   段尾直接出 B 的原值——航点坐标逐位保留；首点出 A 的原值；段与段之间不重复端点。
 *   经度归一到 (−180, 180]（区间内的值不动）；纬度原样。★ 不切 ±180° 接缝：切段交给渲染端（flat drawPolyline 按 |Δx| > 180 切；
 *   3D 用单位矢量，无接缝问题）。
 * @param {Array<{lat:number, lon:number}>} pts  航点（坐标非有限的跳过，与页面 finLL 同口径）
 * @param {number} [stepDeg=GC_STEP_DEG]         非有限 / ≤ 0 时按缺省
 * @returns {Array<{lat:number, lon:number}>}    新数组、新对象（有效点 < 2 时返回有效点的归一化副本）
 */
export function densifyGreatCircle(pts, stepDeg = GC_STEP_DEG) {
  const step = fin(stepDeg) && stepDeg > 0 ? stepDeg : GC_STEP_DEG
  const out = []
  const n = pts && typeof pts.length === 'number' ? pts.length : 0
  let prev = null
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    if (!p || !fin(p.lat) || !fin(p.lon)) continue
    if (!prev) { out.push({ lat: p.lat, lon: normLonDeg(p.lon) }); prev = p; continue }
    unitInto(prev.lat, prev.lon, _dA, 0); unitInto(p.lat, p.lon, _dB, 0)
    const cx = _dA[1] * _dB[2] - _dA[2] * _dB[1], cy = _dA[2] * _dB[0] - _dA[0] * _dB[2], cz = _dA[0] * _dB[1] - _dA[1] * _dB[0]
    const om = Math.atan2(norm3(cx, cy, cz), _dA[0] * _dB[0] + _dA[1] * _dB[1] + _dA[2] * _dB[2])
    if (!(om > GC_ZERO_RAD)) continue                                        // 重合（含经差 360° 的同一点）：不出点，也不换段起点
    const k = Math.ceil(om * R2D / step)
    for (let j = 1; j < k; j++) {
      const q = greatCircleInterp(prev.lat, prev.lon, p.lat, p.lon, j / k, { lat: 0, lon: 0 })
      q.lon = normLonDeg(q.lon)
      out.push(q)
    }
    out.push({ lat: p.lat, lon: normLonDeg(p.lon) })
    prev = p
  }
  return out
}
