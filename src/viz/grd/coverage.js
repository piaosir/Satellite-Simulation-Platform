// GRD 覆盖计算核心：投影(L0) · 场标量(L1) · 等值线(L2b)。
// 几何全程 WGS84，复用 src/viz/wgs84.js。填充面着色(L2a) 在渲染层做。
// 见 docs/GRD导入与覆盖可视化设计.md（性能分层 §4、面+线 §5）。

import { geodeticToEcef, geocentricToEcef, ecefToGeodetic, geodeticUp, rayEllipsoid, rayEllipsoidMargin, A, B, E2, RS_GEO } from '../wgs84.js'

const D2R = Math.PI / 180, H = RS_GEO - A
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sc = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const nrm = (a) => sc(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1))
const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// 网格坐标 → 天线系单位矢量（第3轴=boresight）。权威 igrid 公式（GRD说明 §5）。
export function gridDir(igrid, X, Y) {
  if (igrid === 1) { const u = X, v = Y; return [u, v, Math.sqrt(Math.max(0, 1 - u * u - v * v))] }
  if (igrid === 7) { const ph = X * D2R, th = Y * D2R; return [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)] }
  const az = X * D2R, el = Y * D2R, ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el)
  switch (igrid) {
    case 4: return [-sa * ce, se, ca * ce]
    case 6: return [-sa, ca * se, ca * ce]
    case 9: return [sa * ce, se, ca * ce]
    case 10: return [sa, ca * se, ca * ce]
    case 5: { const th = Math.hypot(az, el), ph = Math.atan2(el, -az); return [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)] }
    default: throw new Error('未支持的 igrid=' + igrid)
  }
}

// gridDir 的逆：天线系单位矢量 (a,b,c)（c=boresight 分量）→ 网格坐标 [X, Y]。
// 供「在站点方向上反查方向图值」用（性能指标表）。c<=0（boresight 背面）返回 null。
export function invGridDir(igrid, a, b, c) {
  if (!(c > 0)) return null
  if (igrid === 1) return (a * a + b * b <= 1) ? [a, b] : null   // u=X, v=Y
  if (igrid === 7) { const th = Math.acos(Math.max(-1, Math.min(1, c))), ph = Math.atan2(b, a); return [ph / D2R, th / D2R] }
  if (igrid === 5) {   // th=hypot(az,el)(rad), ph=atan2(el,-az) → az=-th cosφ, el=th sinφ
    const th = Math.acos(Math.max(-1, Math.min(1, c))), ph = Math.atan2(b, a)
    return [(-th * Math.cos(ph)) / D2R, (th * Math.sin(ph)) / D2R]
  }
  let az, el
  switch (igrid) {
    case 4: el = Math.asin(Math.max(-1, Math.min(1, b))); az = Math.atan2(-a, c); break          // [-sa ce, se, ca ce]
    case 9: el = Math.asin(Math.max(-1, Math.min(1, b))); az = Math.atan2(a, c); break            // [ sa ce, se, ca ce]
    case 6: el = Math.atan2(b, c); az = Math.atan2(-a, Math.hypot(b, c)); break                   // [-sa, ca se, ca ce]
    case 10: el = Math.atan2(b, c); az = Math.atan2(a, Math.hypot(b, c)); break                   // [ sa, ca se, ca ce]
    default: return null
  }
  return [az / D2R, el / D2R]
}

// 把姿态基底的 boresight(z) 倾斜一个小角 epsDeg（方位 phiDeg 在 x-y 面内）→ 新基底。
// 供性能指标表「指向误差扫描」(Min/Max Pointing)：在容差圆周上重采样方向图取最差/最好值。
// eps=0 原样返回。x/y 按与 antennaBasis 一致的约定重建（x=东向参考、y=z×x）。
export function tiltBasis(basis, epsDeg, phiDeg = 0) {
  if (!epsDeg) return basis
  const e = epsDeg * D2R, ph = phiDeg * D2R, { S, x, y, z } = basis
  const axis = add(sc(x, Math.cos(ph)), sc(y, Math.sin(ph)))     // 倾斜方向（x-y 面内）
  const z2 = nrm(add(sc(z, Math.cos(e)), sc(axis, Math.sin(e))))
  let x2 = crs([0, 0, 1], z2)
  x2 = (Math.hypot(x2[0], x2[1], x2[2]) > 1e-9) ? nrm(x2) : nrm(crs(y, z2))   // z2 近垂直时退用旧 y 定参考
  return { S, x: x2, y: crs(z2, x2), z: z2 }
}

// 卫星刚体姿态去指向（严格按 TICRA SATSOFT 口径：de-pointing 由卫星 roll/pitch/yaw 指定，波束随卫星刚体转动）。
// 误差 (Az,El,Yaw) 绕【卫星体轴】施加：Yaw 绕天底轴(z_sc=指向地心)、El 绕东向轴(x_sc)、Az 绕北向轴(y_sc)；
// 同一旋转作用到该波束 basis 的 x/y/z（绕过卫星位置 S 的轴，S 不变）。对天底波束 ≈ 绕波束自身扰动；
// 对偏轴波束，Yaw 让波束沿弧平移（boresight 真位移 ~离轴角×yaw），绕波束自转无此效果——这是与旧实现的关键差异。
// 顺序 Yaw→El→Az（小角近似可交换）。Rodrigues 旋转保持正交归一。
export function perturbSpacecraft(basis, azDeg = 0, elDeg = 0, yawDeg = 0) {
  if (!azDeg && !elDeg && !yawDeg) return basis
  const { S } = basis
  const zsc = nrm(sc(S, -1))                                   // 天底：卫星指向地心
  let xsc = crs([0, 0, 1], zsc)
  xsc = (Math.hypot(xsc[0], xsc[1], xsc[2]) > 1e-9) ? nrm(xsc) : [1, 0, 0]   // 极区退化保护
  const ysc = crs(zsc, xsc)
  const rod = (v, k, ang) => { const c = Math.cos(ang), s = Math.sin(ang), kv = crs(k, v); return add(add(sc(v, c), sc(kv, s)), sc(k, dt(k, v) * (1 - c))) }
  const rot = (v) => { let r = v; if (yawDeg) r = rod(r, zsc, yawDeg * D2R); if (elDeg) r = rod(r, xsc, elDeg * D2R); if (azDeg) r = rod(r, ysc, azDeg * D2R); return r }
  return { S, x: rot(basis.x), y: rot(basis.y), z: rot(basis.z) }
}

// 天线姿态基底：默认 boresight=星下点(satLon,boreLat)；可设 boreLon/boreLat/yaw（WGS84）。
// satLat/altKm = 卫星真实纬度/轨道高度（默认 GEO 赤道）：足迹大小随高度变，LEO 远小于 GEO。
export function antennaBasis(satLon, boreLon = satLon, boreLat = 0, yawDeg = 0, satLat = 0, altKm = H) {
  const S = geodeticToEcef(satLon, satLat, altKm)
  const T = geodeticToEcef(boreLon, boreLat, 0)
  const z = nrm(sub(T, S))
  let x = nrm(crs([0, 0, 1], z)), y = crs(z, x)
  if (yawDeg) {
    const c = Math.cos(yawDeg * D2R), sn = Math.sin(yawDeg * D2R)
    const x2 = add(sc(x, c), sc(y, sn)), y2 = add(sc(y, c), sc(x, -sn)); x = x2; y = y2
  }
  return { S, x, y, z }
}

// 对星指向：boresight 直指空间中的一点 T（ECEF km）——星间链路的基元。
// 与 antennaBasis 的区别只在 T 不必在地表：低轨打 GSO 时 T 在卫星【上方】，z 指向反天底侧，
// 这是「对地」那两套基底（地表目标点 / 相对天底的 az-el 偏置）都表达不了的方向。
// x/y 的参考约定与 antennaBasis 完全一致（x=ẑ_ECEF×z，y=z×x），故方向图的取向口径两者可比。
export function antennaBasisEcef(S, T, yawDeg = 0) {
  const z = nrm(sub(T, S))
  let x = crs([0, 0, 1], z)
  // z 近乎平行于地轴（极区正上方对星）时 ẑ×z 退化 → 退用 x 轴做参考，保证基底始终正交归一
  x = (Math.hypot(x[0], x[1], x[2]) > 1e-9) ? nrm(x) : nrm(crs([1, 0, 0], z))
  let y = crs(z, x)
  if (yawDeg) {
    const c = Math.cos(yawDeg * D2R), sn = Math.sin(yawDeg * D2R)
    const x2 = add(sc(x, c), sc(y, sn)), y2 = add(sc(y, c), sc(x, -sn)); x = x2; y = y2
  }
  return { S, x, y, z }
}

// 方向式天线姿态：boresight 由「相对星下天底的 az/el 方向」直接给定（igrid6 约定），
// 不经过地表目标点 → boresight 可指向任意方向，包括越过地平的深空（El 超出地球张角即指深空）。
// 这是物理正确的指向基元：方向图照常逐点投影，命中地球的点出覆盖、越地平的点自然滚降（vis<0）。
export function antennaBasisAzEl(satLon, satLat = 0, altKm = H, azDeg = 0, elDeg = 0, yawDeg = 0) {
  const nb = antennaBasis(satLon, satLon, satLat, 0, satLat, altKm)   // 星下天底基底（z=天底, x=东, y=北）
  const dir = gridDir(6, azDeg, elDeg)                                // boresight 方向（天底系，az/el 偏置）
  const z = nrm([
    nb.x[0] * dir[0] + nb.y[0] * dir[1] + nb.z[0] * dir[2],
    nb.x[1] * dir[0] + nb.y[1] * dir[1] + nb.z[1] * dir[2],
    nb.x[2] * dir[0] + nb.y[2] * dir[1] + nb.z[2] * dir[2]
  ])
  let x = nrm(crs([0, 0, 1], z)), y = crs(z, x)                        // 与 geo 模式同一参考约定
  if (yawDeg) {
    const c = Math.cos(yawDeg * D2R), sn = Math.sin(yawDeg * D2R)
    const x2 = add(sc(x, c), sc(y, sn)), y2 = add(sc(y, c), sc(x, -sn)); x = x2; y = y2
  }
  return { S: nb.S, x, y, z }
}
// 在给定参考基底上再加一层 az/el 偏置的姿态（igrid6 约定，与 antennaBasisAzEl 同一套 az/el 口径，
// 只是参考轴从「星下天底」换成任意 nb.z）。「对星跟踪 + 偏置」＝ nb 取对星跟踪基底后套这一层：
// 偏置为 0 时严格退化回 nb 的指向（数值上 gridDir(6,0,0)=[0,0,1]），故切模式不跳变。
export function antennaBasisAbout(nb, azDeg = 0, elDeg = 0, yawDeg = 0) {
  const dir = gridDir(6, azDeg, elDeg)
  const z = nrm([
    nb.x[0] * dir[0] + nb.y[0] * dir[1] + nb.z[0] * dir[2],
    nb.x[1] * dir[0] + nb.y[1] * dir[1] + nb.z[1] * dir[2],
    nb.x[2] * dir[0] + nb.y[2] * dir[1] + nb.z[2] * dir[2]
  ])
  let x = crs([0, 0, 1], z)
  x = (Math.hypot(x[0], x[1], x[2]) > 1e-9) ? nrm(x) : nrm(crs([1, 0, 0], z))   // 极区正上方退化保护，同 antennaBasisEcef
  let y = crs(z, x)
  if (yawDeg) {
    const c = Math.cos(yawDeg * D2R), sn = Math.sin(yawDeg * D2R)
    const x2 = add(sc(x, c), sc(y, sn)), y2 = add(sc(y, c), sc(x, -sn)); x = x2; y = y2
  }
  return { S: nb.S, x, y, z }
}
// 某方向 w（ECEF 单位矢量）在参考基底 nb 里的 az/el（antennaBasisAbout 的逆；拖拽反解偏置量用）
export function dirAzElAbout(nb, w) {
  const dx = dt(w, nb.x), dy = dt(w, nb.y), dz = dt(w, nb.z)
  return { az: Math.atan2(-dx, Math.hypot(dy, dz)) * R2D, el: Math.atan2(dy, dz) * R2D }
}

// 地表点(lon,lat) → 该点相对星下天底的 az/el（geo↔azel 模式互换用）。任意地表点皆有定义（含地平内）。
export function dirToAzEl(satLon, satLat, altKm, lon, lat) {
  const nb = antennaBasis(satLon, satLon, satLat || 0, 0, satLat || 0, altKm)
  const w = nrm(sub(geodeticToEcef(lon, lat, 0), nb.S))
  const dx = dt(w, nb.x), dy = dt(w, nb.y), dz = dt(w, nb.z)
  return { az: Math.atan2(-dx, Math.hypot(dy, dz)) * R2D, el: Math.atan2(dy, dz) * R2D }
}
// 地表点(lon,lat) 相对某颗星的一整套视角读数 —— 光标读数用，一次算齐免得逐项各建一次基底。
//   az / el  天线系（boresight = 星下天底），与 dirToAzEl 同一条公式（igrid 6 的口径）
//   u / v    同一个基底的方向余弦（igrid 1 的那一对）：u = e·x，v = e·y，w = e·z
//   gamma    地心角：地心到卫星、地心到该点两条矢量的夹角
//   range    斜距（km）；vis  该点在不在卫星的地平线内
// ★ u/v 与 az/el 不是两套几何，是同一个方向的两种写法 —— 换算只在天线系里做，别各算各的
//   （gridDir(6, az, el) 回代必须等于 (u,v,w)，satLook.test.mjs 段②钉的就是这条）。
// ★ u 与 az 【反号】：天线系的 x 轴＝crs(地轴, boresight)，对赤道上的 GEO 星那是【西】向，
//   而 igrid 6 定义 az = atan2(−u, …) 让东为正。所以星下点以东的点 az>0 而 u<0，不是写反了。
// ★ gamma 在【大地】星下点上不是精确的 0，差着椭球扁率那一点（45°N 处约 0.021°）：
//   大地坐标 (lon,lat,h) 的地心方向随 h 变（z 分量加 h，x/y 分量加 N+h）。要的是「图上到圆心
//   的角距离」时这点差可忽略；要严格的物理地心角时它才是对的那个。
export function satLookAt(satLon, satLat, altKm, lon, lat) {
  const nb = antennaBasis(satLon, satLon, satLat || 0, 0, satLat || 0, altKm)
  const P = geodeticToEcef(lon, lat, 0)
  const d = sub(P, nb.S), rng = Math.hypot(d[0], d[1], d[2])
  const e = sc(d, 1 / (rng || 1))
  const dx = dt(e, nb.x), dy = dt(e, nb.y), dz = dt(e, nb.z)
  // 地心角：地心到星下点、地心到该点两条矢量的夹角。用 ECEF 归一化（与全平台的椭球口径一致）
  const Sn = nrm(nb.S), Pn = nrm(P)
  return {
    az: Math.atan2(-dx, Math.hypot(dy, dz)) * R2D,
    el: Math.atan2(dy, dz) * R2D,
    u: dx, v: dy, w: dz,
    gamma: Math.acos(Math.max(-1, Math.min(1, dt(Sn, Pn)))) * R2D,
    range: rng,
    vis: dt(e, geodeticUp(lon, lat)) < 0        // e 是星→点；与该点天顶同向即卫星在其地平线下
  }
}
// 地球站(lon,lat) 看卫星的当地地平坐标：方位角 az（自正北顺时针 0–360°）、仰角 el（当地水平面以上，度）。
// 用地球站当地 ENU 系（geodeticUp=大地天顶）；与 dirToAzEl（卫星看地面点）互为对偶。
// el<0 表示卫星在该站地平线以下（不可见）；GEO 时 satAlt 传轨道高度，与本文件其它几何同口径。
export function groundLookAngles(satLon, satLat, altKm, lon, lat) {
  const G = geodeticToEcef(lon, lat, 0)                                  // 地球站 ECEF
  const S = geodeticToEcef(satLon, satLat || 0, altKm)                   // 卫星 ECEF
  const up = geodeticUp(lon, lat)                                        // 当地天顶（大地法线，单位矢量）
  const east = [-Math.sin(lon * D2R), Math.cos(lon * D2R), 0]            // 当地正东（单位矢量）
  const north = crs(up, east)                                           // 右手 ENU：E×N=U ⇒ N=U×E
  const d = sub(S, G), dl = Math.hypot(d[0], d[1], d[2]) || 1            // 站→星 视线矢量
  const de = dt(d, east), dn = dt(d, north), du = dt(d, up)
  let az = Math.atan2(de, dn) * R2D; if (az < 0) az += 360               // 自正北顺时针
  const el = Math.asin(Math.max(-1, Math.min(1, du / dl))) * R2D         // 仰角（<0=地平线下）
  return { az, el }
}
// 地表点(lon,lat) → 朝它的 boresight az/el，但把方向夹在可见圆盘内（越地平的点夹到地平切向）。
// 拖拽用：地表经纬度在地平附近映射非单调（过地平会回折），改用"夹到地平的方向"后单调，可一路拖到地平线。
export function surfaceAzEl(satLon, satLat, altKm, lon, lat) {
  const nb = antennaBasis(satLon, satLon, satLat || 0, 0, satLat || 0, altKm)
  const S = nb.S
  let w = nrm(sub(geodeticToEcef(lon, lat, 0), S))
  const wn = dt(w, nb.z)                                       // cos(与天底夹角)
  const aL = Math.asin(Math.min(1, A / Math.hypot(S[0], S[1], S[2])))   // 地平角半径(≈8.7° @GEO)
  if (Math.acos(Math.max(-1, Math.min(1, wn))) > aL) {        // 越地平 → 夹到地平切向(保留方位)
    const perp = nrm(sub(w, sc(nb.z, wn)))
    w = nrm(add(sc(nb.z, Math.cos(aL)), sc(perp, Math.sin(aL))))
  }
  const dx = dt(w, nb.x), dy = dt(w, nb.y), dz = dt(w, nb.z)
  return { az: Math.atan2(-dx, Math.hypot(dy, dz)) * R2D, el: Math.atan2(dy, dz) * R2D }
}
// boresight(az/el 方向) 在地表的落点；指向深空(越地平,不命中)时返回 null（供 tip 显示/模式互换）。
export function azElGround(satLon, satLat, altKm, azDeg, elDeg) {
  const basis = antennaBasisAzEl(satLon, satLat, altKm, azDeg, elDeg, 0)
  const P = rayEllipsoid(basis.S, basis.z)
  if (!P) return null
  const g = ecefToGeodetic(P[0], P[1], P[2])
  return { lon: g.lon, lat: g.lat }
}

// ==================== 指向设置 → 天线基底（纯函数，与时刻无关）====================
// useGrdCoverage.beamBasis 的纯函数版：把「对星指向的目标星 ECEF」提成显式入参 T，不碰任何 hooks/状态。
// 时段扫描要在【时窗内任意时刻】重建基底（源星与目标星两头都在动），必须有一个可反复调用的纯口径；
// useGrdCoverage 那份改为调用本函数 —— 实时路与扫描路只此一份公式，不会漂。
//   meta — 该时刻源星的 {satLon, satLat, satAlt}
//   st   — 天线设置（boreType / boreLon,boreLat / boreAz,boreEl / yaw / boreOff* / borePt*）
//   T    — sat/satoff 模式的目标星 ECEF（km）；解析不到给 null → 退回天底（不让覆盖凭空消失）
export function beamBasisFrom(meta, st, T = null) {
  if (st.boreType === 'sat' || st.boreType === 'satoff') {
    if (T) {
      const nb = antennaBasisEcef(geodeticToEcef(meta.satLon, meta.satLat || 0, meta.satAlt), T, st.yaw || 0)
      return st.boreType === 'satoff' ? antennaBasisAbout(nb, st.boreOffAz || 0, st.boreOffEl || 0, 0) : nb
    }
    return antennaBasisAzEl(meta.satLon, meta.satLat || 0, meta.satAlt, 0, 0, st.yaw || 0)
  }
  if (st.boreType === 'point') {
    const S = geodeticToEcef(meta.satLon, meta.satLat || 0, meta.satAlt)
    const P = geocentricToEcef(st.borePtLon == null ? meta.satLon : st.borePtLon, st.borePtLat || 0, st.borePtAlt || 0)
    return antennaBasisEcef(S, P, st.yaw || 0)
  }
  if (st.boreType === 'azel') return antennaBasisAzEl(meta.satLon, meta.satLat || 0, meta.satAlt, st.boreAz || 0, st.boreEl || 0, st.yaw || 0)
  return antennaBasis(meta.satLon, st.boreLon == null ? meta.satLon : st.boreLon, st.boreLat || 0, st.yaw || 0, meta.satLat || 0, meta.satAlt)
}

// 「源星从 meta0 走到 pos 之后，指向字段该变成什么」—— useGrdCoverage.moveCoverage 的纯函数版。
// 三条口径与实时路逐字一致：
//   · 锁定（boreLock ≠ false）：geo 原地不动（basis 按新星位重算 ＝ 天线重新指向同一地面点）；
//     azel 若有地面落点则钉成 geo（默认天底 azel(0,0) 就此锁定在【时窗起点】的星下点）；越地平的深空指向保持 azel。
//   · 不锁定 + geo：boresight 随星下点平移，保留相对经纬偏置。
//   · 对星三型（sat/satoff/point）：一律不动 —— 目标星自带星历，空间点是钉死的定点。
// ★ 与实时路唯一的差别：实时是逐帧增量累加，这里是相对【起点 meta0】的一次性总量。geo 平移量
//   telescoping 相等 ⇒ 两者等价；只有纬度撞上 ±89.9 夹紧时会分叉（极区退化的边角）。
export function boreSettingsAtPos(st, meta0, pos) {
  const locked = st.boreLock !== false
  if (st.boreType === 'sat' || st.boreType === 'satoff' || st.boreType === 'point') return st
  if (locked) {
    if (st.boreType !== 'azel') return st
    const g = azElGround(meta0.satLon, meta0.satLat || 0, meta0.satAlt, st.boreAz || 0, st.boreEl || 0)
    return g ? { ...st, boreType: 'geo', boreLon: g.lon, boreLat: g.lat } : st
  }
  if (st.boreType !== 'geo') return st                        // azel 相对天底，星动自动跟随
  let dLon = pos.lon - meta0.satLon
  while (dLon > 180) dLon -= 360
  while (dLon < -180) dLon += 360
  const bl = (st.boreLon == null ? meta0.satLon : st.boreLon) + dLon
  return {
    ...st,
    boreLon: ((bl % 360) + 540) % 360 - 180,
    boreLat: Math.max(-89.9, Math.min(89.9, (st.boreLat || 0) + (pos.lat || 0) - (meta0.satLat || 0)))
  }
}

// 天线系 r̂ → 大地经纬度（射线交 WGS84 椭球）；off-limb 返回 null。
export function project(dir, basis) {
  const { S, x, y, z } = basis
  const d = nrm(add(add(sc(x, dir[0]), sc(y, dir[1])), sc(z, dir[2])))
  const P = rayEllipsoid(S, d)
  if (!P) return null
  const g = ecefToGeodetic(P[0], P[1], P[2])
  return { lon: g.lon, lat: g.lat, ecef: P }
}

// 天线系 r̂ 的「地平裕度」m（=rayEllipsoidMargin 的判别式）：>0 命中地球、=0 恰切地平（0°仰角线）、<0 越地平。
// 只求交、不反算经纬（比 projectLimb 便宜一个数量级），给「二分逼近地平」的场合用。
// 判据走 WGS84 判别式本身，不用球近似的地平角半径 asin(A/r)——椭球的地平角随方位差 0.03°（≈3 km）。
export function limbMargin(dir, basis) {
  const { S, x, y, z } = basis
  const d = nrm(add(add(sc(x, dir[0]), sc(y, dir[1])), sc(z, dir[2])))
  return rayEllipsoidMargin(S, d).m
}

// 「地平线上的点」解析式：取 dir 所在的方位半平面与地球可见地平（0°仰角线）的交点。
// 归一坐标 (x/A, y/A, z/B) 下椭球即单位球、卫星在 |S′|=ρ 处，切点集合 = 圆 { |P′|=1, P′·Ŝ′=1/ρ }；
// 该方位上的那一点 P′ = Ŝ′/ρ + √(1−1/ρ²)·û（û = dir 垂直于 Ŝ′ 的分量），再线性映回 ECEF ——
// 线性映射保持「相切」，故 P 恰在椭球地平线上（仰角严格 0），椭球扁率带来的地平非正圆自动含在内。
// ★ 必须走解析式，不能「二分逼近相切射线再求交」：相切处地面位置 ∝ √(角度亏欠)，二分 20 步（角度
//   已收敛到 3e-5°）地面上仍差 ~6 km、仰角残留 0.05° —— 画出来的地平弧带着可见的抖动。
export function limbPoint(dir, basis) {
  const { S, x, y, z } = basis
  const d = add(add(sc(x, dir[0]), sc(y, dir[1])), sc(z, dir[2]))
  const Sn = [S[0] / A, S[1] / A, S[2] / B], dn = [d[0] / A, d[1] / A, d[2] / B]
  const rho = Math.hypot(Sn[0], Sn[1], Sn[2]), sh = sc(Sn, 1 / rho)
  const u = sub(dn, sc(sh, dt(dn, sh))), un = Math.hypot(u[0], u[1], u[2])
  if (!(un > 0)) return null                                   // 正对天底：不可能在地平外
  const k = Math.sqrt(Math.max(0, 1 - 1 / (rho * rho))) / un
  const P = [(sh[0] / rho + u[0] * k) * A, (sh[1] / rho + u[1] * k) * A, (sh[2] / rho + u[2] * k) * B]
  const g = ecefToGeodetic(P[0], P[1], P[2])
  return { lon: g.lon, lat: g.lat, ecef: P }
}

// project 的连续版：越过地平不返回 null，而是落到地平上的趋近点（与 projectGrid 的 vis 口径同源），
// 由 vis 区分（>=0 命中椭球、<0 在地平外）。给「需要一条不断裂的曲线」的场合用——环形轮廓一旦
// 在地平处丢点就闭不上，填充多边形随之整块消失。
export function projectLimb(dir, basis) {
  const { S, x, y, z } = basis
  const d = nrm(add(add(sc(x, dir[0]), sc(y, dir[1])), sc(z, dir[2])))
  const r = rayEllipsoidMargin(S, d)
  const g = ecefToGeodetic(r.p[0], r.p[1], r.p[2])
  return { lon: g.lon, lat: g.lat, ecef: r.p, vis: r.m }
}

// 每点的【网格参数坐标】(X,Y) 展平成两条 Float32Array。只随网格几何变，记忆化到 set 上。
// 用途：对星覆盖分析把等值线/分带填充切在【天线网格域】里（见 shellProj.js 的口径说明），
// bandGeometry 的 lon/lat 两条数组直接换成这里的 gx/gy 即可复用，一行不用改。
export function gridXY(set) {
  if (set._gxy) return set._gxy
  const { XS, YS, XE, YE, NX, NY } = set
  const dx = (XE - XS) / (NX - 1), dy = (YE - YS) / (NY - 1)
  const N = NX * NY, gx = new Float32Array(N), gy = new Float32Array(N)
  for (let row = 0; row < NY; row++) {
    const y = YS + dy * row, base = row * NX
    for (let col = 0; col < NX; col++) { gx[base + col] = XS + dx * col; gy[base + col] = y }
  }
  set._gxy = { gx, gy }
  return set._gxy
}

// 每点天线系单位矢量（gridDir 结果展平成 Float32Array[N*3]）。只随网格几何/igrid 变，与指向(basis)无关，
// 故记忆化到 set 上——拖拽时 basis 每帧变但这张表不变，省掉逐点 sin/cos。
export function gridDirs(set, igrid) {
  if (set._dirs && set._dirsIgrid === igrid) return set._dirs
  const { XS, YS, XE, YE, NX, NY } = set
  const dx = (XE - XS) / (NX - 1), dy = (YE - YS) / (NY - 1)
  const N = NX * NY, dirs = new Float32Array(N * 3)
  for (let row = 0; row < NY; row++) {
    for (let col = 0; col < NX; col++) {
      const d = gridDir(igrid, XS + dx * col, YS + dy * row), o = (row * NX + col) * 3
      dirs[o] = d[0]; dirs[o + 1] = d[1]; dirs[o + 2] = d[2]
    }
  }
  set._dirs = dirs; set._dirsIgrid = igrid
  return dirs
}

// L0：把整张网格逐点投影成 lon/lat（+ 斜距，供路径损耗 + 地平裕度 vis）。仅指向变化时重算。
// vis>0 在地球可见面内、=0 恰在 0°仰角线、<0 越过地平。越过地平的点不再返回 NaN，而是落到
// 地平上的趋近点（位置连续），由 vis 符号区分——渲染层据此把覆盖精确切在 0°仰角线，无网格锯齿。
// 热路径（拖拽每帧）：复用缓存的天线系 dir 表，逐点只做 basis 旋转 + 射线求交，无 trig、无中间数组分配。
const R2D = 180 / Math.PI
// box（可选）= { r0,r1,c0,c1 }（含端点的行列范围）：只投影该子矩形（HTS 点波束的覆盖热区），其余点不算。
//   场 dB 与指向无关，故覆盖热区可在拖拽前算出（见 useGrdCoverage.beamBox），拖拽每帧只投影热区 → 大幅提速。
// out（可选）= 上一帧的 {lon,lat,slant,vis}：尺寸相同则原地复用，免去每帧 4×Float32Array(N) 分配（94 波束省大量 GC）。
// limbOutside（可选）：越地平点(vis<0)取未投影的最近趋近点（停在地平【外】），使覆盖填充能延伸到地平外、
//   再由 bandGeometry 用平滑地平弧裁剪，消除地平附近的月牙缝/锯齿。默认 false（旧行为：折叠到地平圆上）。
export function projectGrid(set, igrid, basis, box = null, out = null, limbOutside = false) {
  const { NX, NY } = set
  const N = NX * NY, { S, x, y, z } = basis
  const dirs = gridDirs(set, igrid)
  const x0 = x[0], x1 = x[1], x2 = x[2], y0 = y[0], y1 = y[1], y2 = y[2], z0 = z[0], z1 = z[1], z2 = z[2]
  const S0 = S[0], S1 = S[1], S2 = S[2]
  const reuse = out && out.lon && out.lon.length === N
  const lon = reuse ? out.lon : new Float32Array(N)
  const lat = reuse ? out.lat : new Float32Array(N)
  const slant = reuse ? out.slant : new Float32Array(N)
  const vis = reuse ? out.vis : new Float32Array(N)
  const d = [0, 0, 0]
  const r0 = box ? box.r0 : 0, r1 = box ? box.r1 : NY - 1, c0 = box ? box.c0 : 0, c1 = box ? box.c1 : NX - 1
  for (let row = r0; row <= r1; row++) {
    const rowBase = row * NX
    for (let col = c0; col <= c1; col++) {
      const k = rowBase + col
      const o = k * 3, a = dirs[o], b = dirs[o + 1], cz = dirs[o + 2]
      let ex = x0 * a + y0 * b + z0 * cz, ey = x1 * a + y1 * b + z1 * cz, ez = x2 * a + y2 * b + z2 * cz
      const inv = 1 / (Math.hypot(ex, ey, ez) || 1)
      d[0] = ex * inv; d[1] = ey * inv; d[2] = ez * inv
      const r = rayEllipsoidMargin(S, d), P = (limbOutside && r.m < 0) ? r.pRaw : r.p, px = P[0], py = P[1], pz = P[2]
      // 内联大地纬度反算（4 次定点迭代，地表点早收敛——替代共享版 20 次，拖拽热路径省 80% 三角运算）
      const Rxy = Math.hypot(px, py)
      let glat = Math.atan2(pz, Rxy)
      for (let it = 0; it < 4; it++) { const sgl = Math.sin(glat); glat = Math.atan2(pz + A * E2 * sgl / Math.sqrt(1 - E2 * sgl * sgl), Rxy) }
      lon[k] = Math.atan2(py, px) * R2D; lat[k] = glat * R2D; vis[k] = r.m
      slant[k] = Math.hypot(px - S0, py - S1, pz - S2)
    }
  }
  return { lon, lat, slant, vis, NX, NY, box }
}

// L1：极化取值 + 增益偏置 + 路径损耗 → dB 网格。pol: P1|P2|RSS|P1/P2|P2/P1。
// pathLoss: 'none' | 'relative'(h/Rs)² | 'absolute' 1/(4πRs²)；hNadir=星地最近距离(=H 近似)。
export function fieldDb(set, proj, { pol = 'P1', gainOffset = 0, pathLoss = 'none', hNadir = H } = {}) {
  const { P1, P2, NX, NY } = set, N = NX * NY, db = new Float32Array(N)
  let max = -Infinity, maxIdx = 0
  for (let k = 0; k < N; k++) {
    const p1 = P1[k], p2 = P2[k]
    let P
    if (pol === 'P1') P = p1
    else if (pol === 'P2') P = p2
    else if (pol === 'RSS') P = p1 + p2
    else if (pol === 'P1/P2') P = p2 > 0 ? p1 / p2 : 0
    else if (pol === 'P2/P1') P = p1 > 0 ? p2 / p1 : 0
    else P = p1
    if (!(P > 0)) { db[k] = NaN; continue }
    let v = 10 * Math.log10(P) + gainOffset
    if (pathLoss !== 'none' && proj) {
      const Rs = proj.slant[k]
      if (Rs > 0) v += pathLoss === 'relative' ? 20 * Math.log10(hNadir / Rs) : -10 * Math.log10(4 * Math.PI * Rs * Rs)
    }
    db[k] = v
    if (v > max) { max = v; maxIdx = k }
  }
  return { db, max, maxIdx, NX, NY }
}

// Keys 立方卷积核（a=-0.5，标准 bicubic）：对带限/平滑数据精度高于双线性。
const keysW = (s) => { s = Math.abs(s); const a = -0.5; return s <= 1 ? ((a + 2) * s - (a + 3)) * s * s + 1 : (s < 2 ? ((a * s - 5 * a) * s + 8 * a) * s - 4 * a : 0) }
const clampI = (v, n) => (v < 0 ? 0 : (v > n - 1 ? n - 1 : v))
// 双三次插值（4×4 邻域，边界复制）。立方卷积在零点/陡坡附近可能轻微过冲（产生负功率）→ 由调用方回退双线性。
function bicubicAt(arr, NX, NY, fc, fr) {
  const c0 = Math.floor(fc), r0 = Math.floor(fr), tx = fc - c0, ty = fr - r0
  const wx = [keysW(1 + tx), keysW(tx), keysW(1 - tx), keysW(2 - tx)]
  const wy = [keysW(1 + ty), keysW(ty), keysW(1 - ty), keysW(2 - ty)]
  let acc = 0
  for (let j = 0; j < 4; j++) {
    const rr = clampI(r0 - 1 + j, NY) * NX
    let row = 0
    for (let i = 0; i < 4; i++) row += wx[i] * arr[rr + clampI(c0 - 1 + i, NX)]
    acc += wy[j] * row
  }
  return acc
}
function bilinearAt(arr, NX, NY, fc, fr) {
  const c0 = Math.floor(fc), r0 = Math.floor(fr), c1 = Math.min(c0 + 1, NX - 1), r1 = Math.min(r0 + 1, NY - 1), tx = fc - c0, ty = fr - r0
  return arr[r0 * NX + c0] * (1 - tx) * (1 - ty) + arr[r0 * NX + c1] * tx * (1 - ty) + arr[r1 * NX + c0] * (1 - tx) * ty + arr[r1 * NX + c1] * tx * ty
}
// 复场四分量共用一套权重的 bicubic。逐分量的累加顺序与 bicubicAt 逐字相同 → 与「4 次 bicubicAt」逐位一致，
// 只是权重只算一遍、四条数组同一趟扫（性能指标表逐站取值与等值线交点求根都走这里）。
const _kw = new Float64Array(8)
function bicubic4At(re1, im1, re2, im2, NX, NY, fc, fr, out) {
  const c0 = Math.floor(fc), r0 = Math.floor(fr), tx = fc - c0, ty = fr - r0
  const w = _kw
  w[0] = keysW(1 + tx); w[1] = keysW(tx); w[2] = keysW(1 - tx); w[3] = keysW(2 - tx)
  w[4] = keysW(1 + ty); w[5] = keysW(ty); w[6] = keysW(1 - ty); w[7] = keysW(2 - ty)
  let a1 = 0, b1 = 0, a2 = 0, b2 = 0
  for (let j = 0; j < 4; j++) {
    const rr = clampI(r0 - 1 + j, NY) * NX, wy = w[4 + j]
    let s1 = 0, t1 = 0, s2 = 0, t2 = 0
    for (let i = 0; i < 4; i++) {
      const k = rr + clampI(c0 - 1 + i, NX), wx = w[i]
      s1 += wx * re1[k]; t1 += wx * im1[k]; s2 += wx * re2[k]; t2 += wx * im2[k]
    }
    a1 += wy * s1; b1 += wy * t1; a2 += wy * s2; b2 += wy * t2
  }
  out[0] = a1; out[1] = b1; out[2] = a2; out[3] = b2
}
// 网格坐标 (fc, fr) 处的两分量功率：有复场 → Re/Im 各 bicubic 再平方（p=re²+im²≥0，无零点负过冲）；
// 无复场（预置烘焙）→ 对功率 P1/P2 做 bicubic，过冲致非正时回退双线性。
// 结果写入 _sp = [p1, p2, re1, im1, re2, im2]（零分配），返回是否有复场。
// ★ 性能指标表（sampleBeamAtParam）与等值线交点细化（buildEdgeRefine）共用这一个内核 → 表与线同一份数。
const _sp = new Float64Array(6), _c4 = new Float64Array(4)
function samplePowAt(beam, fc, fr) {
  const g = beam.grid, NX = g.NX, NY = g.NY
  if (beam.c1re) {
    bicubic4At(beam.c1re, beam.c1im, beam.c2re, beam.c2im, NX, NY, fc, fr, _c4)
    const re1 = _c4[0], im1 = _c4[1], re2 = _c4[2], im2 = _c4[3]
    _sp[0] = re1 * re1 + im1 * im1; _sp[1] = re2 * re2 + im2 * im2
    _sp[2] = re1; _sp[3] = im1; _sp[4] = re2; _sp[5] = im2
    return true
  }
  let v = bicubicAt(beam.P1, NX, NY, fc, fr); _sp[0] = v > 0 ? v : bilinearAt(beam.P1, NX, NY, fc, fr)
  v = bicubicAt(beam.P2, NX, NY, fc, fr); _sp[1] = v > 0 ? v : bilinearAt(beam.P2, NX, NY, fc, fr)
  return false
}
// 极化口径 → 功率（与 fieldDb 同一张表：P1 | P2 | RSS | P1/P2 | P2/P1）
function polPow(pol, p1, p2) {
  if (pol === 'P1') return p1
  if (pol === 'P2') return p2
  if (pol === 'RSS') return p1 + p2
  if (pol === 'P1/P2') return p2 > 0 ? p1 / p2 : 0
  if (pol === 'P2/P1') return p1 > 0 ? p2 / p1 : 0
  return p1
}

// 轴比 AR(dB)：由两分量复振幅 comp={re1,im1,re2,im2} + icomp 决定的极化基算。
// icomp=3（圆极化基 R/L）：AR=(√P1+√P2)/|√P1−√P2|；icomp=1/2（线极化正交对 θ/φ 或 co/cx）：由 Stokes S3 求椭率角。
// 上限截断 60dB（近线极化 AR→∞）。comp 缺失（预置烘焙天线无相位）返回 null。
export function axialRatioDb(comp, icomp) {
  if (!comp) return null
  const { re1, im1, re2, im2 } = comp
  const p1 = re1 * re1 + im1 * im1, p2 = re2 * re2 + im2 * im2
  if (icomp === 3) {
    const a = Math.sqrt(p1), b = Math.sqrt(p2), den = Math.abs(a - b)
    return den < 1e-12 ? 60 : Math.min(60, 20 * Math.log10((a + b) / den))
  }
  const S0 = p1 + p2; if (!(S0 > 0)) return null
  const S3 = 2 * (re1 * im2 - im1 * re2)                       // 2·Im(E1*·E2)
  const chi = 0.5 * Math.asin(Math.max(-1, Math.min(1, S3 / S0)))   // 椭率角 ∈[-45°,45°]
  const t = Math.abs(Math.tan(chi))
  return t < 1e-6 ? 60 : Math.min(60, -20 * Math.log10(t))    // AR=1/|tanχ|
}

// 在地表站点(lon,lat)处反查单个波束的方向图值（性能指标表逐站取值内核）。
// 链路：站点 ECEF → 减卫星位置得视线方向 → 投到天线系 basis（转置）→ invGridDir 反解网格坐标 →
//   插值 → 极化/增益/路损 → dB。站点落在方向图域外/背面返回 null。
// 【插值域 = 复场（物理最准）】带限量是复电场 E（按口径采样到 Nyquist），功率 |E|² 带宽翻倍、
//   直接插功率相对网格欠采样 → 误差。故有复场(c1re..)时对 Re/Im 各做 bicubic 再平方得功率
//   （p=re²+im²≥0，无零点处的负过冲问题）；comp 也由此一并得到（AR 用，免重复插值）。
//   预置烘焙天线无复场 → 回退【对功率 P1/P2 做 bicubic】（过冲致非正时回退双线性）。
// beam: { P1,P2,[c1re,c1im,c2re,c2im], grid:{...} }；basis: { S,x,y,z }。
export function sampleBeamAt(beam, igrid, basis, lon, lat, opts = {}) {
  const { S } = basis
  const P = geodeticToEcef(lon, lat, 0)
  const ex = P[0] - S[0], ey = P[1] - S[1], ez = P[2] - S[2]
  const rs = Math.hypot(ex, ey, ez); if (!(rs > 0)) return null
  // 地平遮挡（全轨道物理可见性）：卫星须在测站地方水平面之上（仰角≥0），否则视线被地球挡住 → 无效。
  // up=测站测地外法线，e 由卫星指向测站 → e·up>0 表示卫星在测站地平线【以下】（地球背面/对趾整片皆被排除）。
  // 必须独立判此：invGridDir 的 c>0 只能分前/后半球，无法区分「前方可见」与「前方穿过地球到背面对趾」(两者 e 同向)。
  // ★ 此判据【只对地面目标成立】（依赖测站测地法线），故留在本包装里，不下沉到 sampleBeamAtEcef——
  //   对星取值的遮挡是「视线与地球椭球求交」，完全另一回事（见 shellProj.losBlocked）。
  const clat = Math.cos(lat * D2R), up = [clat * Math.cos(lon * D2R), clat * Math.sin(lon * D2R), Math.sin(lat * D2R)]
  if ((ex * up[0] + ey * up[1] + ez * up[2]) / rs > 0) return null
  return sampleBeamAtEcef(beam, igrid, basis, P, opts)
}

// sampleBeamAt 的通用内核：目标点直接给 ECEF（km），不含任何「地面站」专属判据。
// 对地（sampleBeamAt）与对星（性能指标表逐星取值）共用此内核，取值口径逐位一致。
export function sampleBeamAtEcef(beam, igrid, basis, P, opts = {}) {
  const { S, x, y, z } = basis
  const ex = P[0] - S[0], ey = P[1] - S[1], ez = P[2] - S[2]
  const rs = Math.hypot(ex, ey, ez); if (!(rs > 0)) return null
  const e = [ex / rs, ey / rs, ez / rs]
  const a = dt(e, x), b = dt(e, y), c = dt(e, z)   // basis 正交 → 转置即逆，天线系分量
  const xy = invGridDir(igrid, a, b, c); if (!xy) return null
  const r = sampleBeamAtParam(beam, xy, rs, opts)
  return r ? { db: r.db, u: a, v: b, slant: rs, comp: r.comp } : null
}

// 上者的后半段：方向【已经】折算成网格坐标 xy 之后的插值+口径换算。
// 单独抽出来是为了时段扫描的热路径——一个时刻要问 N 个波束同一个方向，方向→网格坐标的那段
// （单位化 + 三次点积 + invGridDir）逐波束重算纯属浪费；多波束 GRD 还能先用各波束的网格盒剪枝，
// 只对「盒子套得住这个方向」的波束插值（盒外本来就返回 null，剪枝不改结果）。
export function sampleBeamAtParam(beam, xy, rs, { pol = 'RSS', gainOffset = 0, pathLoss = 'none', hNadir = H, wantComp = false } = {}) {
  const g = beam.grid, NX = g.NX, NY = g.NY
  const fc = (xy[0] - g.XS) / ((g.XE - g.XS) / (NX - 1))
  const fr = (xy[1] - g.YS) / ((g.YE - g.YS) / (NY - 1))
  if (fc < 0 || fc > NX - 1 || fr < 0 || fr > NY - 1) return null   // 站点在方向图网格域外
  const cplx = samplePowAt(beam, fc, fr)                             // 复场域插值（物理最准）；无复场回退功率域
  const Pw = polPow(pol, _sp[0], _sp[1])
  if (!(Pw > 0)) return null
  let v = 10 * Math.log10(Pw) + gainOffset
  if (pathLoss !== 'none') v += pathLoss === 'relative' ? 20 * Math.log10(hNadir / rs) : -10 * Math.log10(4 * Math.PI * rs * rs)
  return { db: v, comp: (cplx && wantComp) ? { re1: _sp[2], im1: _sp[3], re2: _sp[4], im2: _sp[5] } : null }
}

// L2b：marching-squares 在 dB 网格上按电平取等值线段，端点经投影网格映射到 lon/lat。
// levels: 绝对 dB 数组（相对峰值时由调用方 = max + rel 传入）。返回 [{g, segs:[[[lon,lat],[lon,lat]]...]}]。
export function contourLines(field, proj, levels) {
  const { db, NX, NY } = field
  const vis = proj.vis
  const out = []
  const ll = (ia, ib, t) => [proj.lon[ia] + (proj.lon[ib] - proj.lon[ia]) * t, proj.lat[ia] + (proj.lat[ib] - proj.lat[ia]) * t]
  for (const g of levels) {
    const segs = []
    for (let row = 0; row < NY - 1; row++) {
      for (let col = 0; col < NX - 1; col++) {
        const i00 = row * NX + col, i10 = i00 + 1, i01 = i00 + NX, i11 = i01 + 1
        const v0 = db[i00], v1 = db[i10], v2 = db[i11], v3 = db[i01]   // BL,BR,TR,TL
        if (v0 !== v0 || v1 !== v1 || v2 !== v2 || v3 !== v3) continue  // 任一 NaN 跳过（增益无效）
        // 四角全部越过地平 → 该格在可见地球外，跳过；含可见角的格保留，使填充环能沿 0°仰角线闭合
        if (vis && vis[i00] < 0 && vis[i10] < 0 && vis[i11] < 0 && vis[i01] < 0) continue
        const pts = []
        if ((v0 < g) !== (v1 < g)) pts.push(ll(i00, i10, (g - v0) / (v1 - v0)))   // bottom
        if ((v1 < g) !== (v2 < g)) pts.push(ll(i10, i11, (g - v1) / (v2 - v1)))   // right
        if ((v2 < g) !== (v3 < g)) pts.push(ll(i11, i01, (g - v2) / (v3 - v2)))   // top
        if ((v3 < g) !== (v0 < g)) pts.push(ll(i01, i00, (g - v3) / (v0 - v3)))   // left
        if (pts.length === 2) segs.push([pts[0], pts[1]])
        else if (pts.length === 4) { segs.push([pts[0], pts[1]]); segs.push([pts[2], pts[3]]) }
      }
    }
    out.push({ g, segs })
  }
  return out
}

// L2 统一几何：在同一套三角化 + 逐三角形线性插值上，既切出「分带填充多边形」又取「分带边界(等值线)」。
// 填充与线由同一组顶点插值生成 → 二者逐三角形精确重合；无位图、无对角线/鞍点/接缝分歧（旧 field 着色法
// 的根因）。地平裁剪：先按 vis≥0 裁三角；接缝：每格三个外角相对首角解缠，不再整格丢弃 → 跨 ±180° 无缺口。
// field={lon,lat,vis,db,NX,NY}；levelsAsc 升序绝对电平。返回 { fills:[band0,...], lines:[lvl0Segs,...] }：
//   fills[k] = 该档 [Lk,Lk+1) 环带的扁平几何 { verts:Float64Array[x0,y0,x1,y1,...], counts:Int32Array(各多边形顶点数) }
//             （多边形顺序拼接进 verts，counts[j] 给出第 j 个多边形的顶点数；与 shader band=k 同义）；
//   lines[k] = Lk 等值线段列表（[[lon,lat],[lon,lat]]，= fills 相邻档的公共边）。
// wantFills=false（只画等值线、不填充）时跳过逐档填充裁剪，只算线 → 关填充的大波束拖拽省一半工作量。
// 性能（拖拽热路径）：顶点存成扁平缓冲 [x,y,d,m,...]，clip 在复用的 ping-pong 缓冲间裁剪，全程零临时
//   对象分配（旧版每格每档 new 一堆 {x,y,d,m} → 13万点网格每帧几十万对象，GC 周期性卡顿的根因）。
// 单凸多边形最大顶点数：不细化时三角形经 vis+各档半平面裁剪后始终很小（16 足够）；交点细化会把各档交点
// 插成顶点（≤ 3·档数），按需翻倍扩容（_bgEnsure），扩过就不再缩。
let _BG_CAP = 16
let _bgBase = new Float64Array(_BG_CAP * 6)   // 三角形 / vis 裁剪后的基底
let _bgVis = new Float64Array(_BG_CAP * 6)
let _bgP = new Float64Array(_BG_CAP * 6)      // 逐档填充裁剪 ping-pong
let _bgQ = new Float64Array(_BG_CAP * 6)
const _bgTri = new Float64Array(18)            // 三角形三个角的 [x,y,d,m,u,v]（细化插点时各边的两端；u,v=格坐标）
let _bgN = new Float64Array(_BG_CAP * 6)      // 带弦中点凹口的填充多边形
let _bgA = new Float64Array(_BG_CAP * 6)      // 地平边换成 hull 弧点后的填充多边形
const _cc = new Float64Array(4)                // 当前格子四角的格坐标 [col, row, c2, r2]（loadTri 取 u,v 用）
function _bgEnsure(cap) {
  if (cap <= _BG_CAP) return
  while (_BG_CAP < cap) _BG_CAP *= 2
  _bgBase = new Float64Array(_BG_CAP * 6); _bgVis = new Float64Array(_BG_CAP * 6)
  _bgP = new Float64Array(_BG_CAP * 6); _bgQ = new Float64Array(_BG_CAP * 6); _bgN = new Float64Array(_BG_CAP * 6); _bgA = new Float64Array(_BG_CAP * 6)
}
// 分带填充输出零分配：各档顶点累加进复用的模块级 scratch（扁平 [x,y,...]），档内每个多边形的顶点数记入 _fillCnt。
// bandGeometry 末尾各档一次性 slice 成定长返回缓冲 → 每帧仅 ~2·nb 次分配，替代旧版逐多边形 new Array+[x,y]
// （大波束几十万小数组 → GC 周期性卡顿的根因；线/投影早已零分配，唯填充这条路漏网）。
const _EMPTY_F64 = new Float64Array(0), _EMPTY_I32 = new Int32Array(0)
const _fillBuf = [], _fillBufN = [], _fillCnt = [], _fillCntN = []
function _fillReset(nb) {
  for (let k = 0; k < nb; k++) {
    if (!_fillBuf[k]) { _fillBuf[k] = new Float64Array(2048); _fillCnt[k] = new Int32Array(128) }
    _fillBufN[k] = 0; _fillCntN[k] = 0
  }
}
function _fillGrowBuf(k, need) {
  const b = _fillBuf[k]
  if (need <= b.length) return b
  let cap = b.length * 2; while (cap < need) cap *= 2
  const nb = new Float64Array(cap); nb.set(b.subarray(0, _fillBufN[k])); return (_fillBuf[k] = nb)
}
function _fillPushCount(k, len) {
  let c = _fillCnt[k]
  if (_fillCntN[k] >= c.length) { const nc = new Int32Array(c.length * 2); nc.set(c); c = _fillCnt[k] = nc }
  c[_fillCntN[k]++] = len
}
function _fillPushFlat(k, src, len) {       // 从扁平 [x,y,d,m,u,v,...]（stride 6）追加 len 个顶点的 x,y
  const buf = _fillGrowBuf(k, _fillBufN[k] + len * 2); let o = _fillBufN[k]
  for (let i = 0; i < len; i++) { buf[o++] = src[i * 6]; buf[o++] = src[i * 6 + 1] }
  _fillBufN[k] = o; _fillPushCount(k, len)
}
function _fillPushFlatRot(k, src, len, start) {   // 同上，但从 start 号顶点起环绕写（凹口顶点做 0 号 → 3D 扇形三角化以它为扇心）
  const buf = _fillGrowBuf(k, _fillBufN[k] + len * 2); let o = _fillBufN[k]
  for (let i = 0; i < len; i++) { const j = ((start + i) % len) * 6; buf[o++] = src[j]; buf[o++] = src[j + 1] }
  _fillBufN[k] = o; _fillPushCount(k, len)
}
function _fillPush3(k, x0, y0, x1, y1, x2, y2) {   // 弦与弧之间的薄片三角形
  const buf = _fillGrowBuf(k, _fillBufN[k] + 6); let o = _fillBufN[k]
  buf[o++] = x0; buf[o++] = y0; buf[o++] = x1; buf[o++] = y1; buf[o++] = x2; buf[o++] = y2
  _fillBufN[k] = o; _fillPushCount(k, 3)
}
const wrap180 = (x) => ((x % 360) + 540) % 360 - 180
// 升序数组 arr[0..nb) 中首个 > v 的下标（upper_bound，二分）。供按三角形 dB 跨度快速定位相交档区间。
const upperBound = (arr, nb, v) => { let lo = 0, hi = nb; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid + 1; else hi = mid } return lo }

// ===== 波束峰值（表与线同一基准）=====
// 真峰值在网格点之间，离散最大值低估。在所选极化的功率网格上找离散最大，再沿行/列各做抛物线顶点细化
//（可分离二次近似）后转 dB。按 beam×pol 记忆化（峰值与指向无关）。性能指标表「相对峰值」以它为 0 dB；
// 覆盖的相对档、热区盒最低档与峰值读数（pathLoss='none' 时）也以它为基准 → 「−3 dB」线与表的相对列同一参照
//（0.1° HTS 网格上节点峰值低估中位 0.024 / p95 0.076 / max 0.11 dB）。
export function refinedPeakDb(beam, pol) {
  const k = '_pk_' + pol
  if (beam[k] !== undefined) return beam[k]
  const { P1, P2, grid } = beam, NX = grid.NX, NY = grid.NY, N = NX * NY
  const pw = (i) => polPow(pol, P1[i], P2 ? P2[i] : 0)
  let mi = 0, mv = -Infinity
  for (let i = 0; i < N; i++) { const v = pw(i); if (v > mv) { mv = v; mi = i } }
  if (!(mv > 0)) { beam[k] = null; return null }
  const r = (mi / NX) | 0, c = mi % NX
  const inc = (fm, f0, fp) => { const den = 2 * f0 - fm - fp; return den > 0 ? (fp - fm) * (fp - fm) / (8 * den) : 0 }   // 抛物线顶点相对 f0 的增量（concave 才有效）
  let peak = mv
  if (c > 0 && c < NX - 1) peak += inc(pw(mi - 1), mv, pw(mi + 1))
  if (r > 0 && r < NY - 1) peak += inc(pw(mi - NX), mv, pw(mi + NX))
  const db = peak > 0 ? 10 * Math.log10(peak) : null
  beam[k] = db
  return db
}
// 覆盖用的峰值基准：无路损 → 细化峰值 + 增益偏置（与表同一份数）；有路损 → 场的节点最大值（路损随斜距变，不细化）。
export function peakRefDb(beam, field, pol, gainOffset = 0, pathLoss = 'none') {
  if (!field) return NaN
  if (pathLoss !== 'none' || !beam || !beam.grid) return field.max
  const pk = refinedPeakDb(beam, pol)
  return pk == null ? field.max : pk + gainOffset
}

// ===== 等值线交点细化（线 = 表）=====
// bandGeometry 沿格边按节点 dB【线性】取交点（= SATSOFT 密度 1 的线）；性能指标表逐站走复场 bicubic。
// 节点处二者相等、格内不等（0.1° 粗网格 −3 dB 档中位差 0.08 dB / p95 0.2 dB，位置差 ~0.05 格）。
// 这里只对「两端节点跨档」的格边（水平 / 竖直 / a–c 对角，与三角化同一套边）在 samplePowAt 上沿边求根，
// 得交点参数 s*∈(0,1)；bandGeometry 把这些点作为顶点（d 精确 = 档值）插进三角形边上再走原有裁剪与取线 →
// 填充与线仍由构造重合，且线上每个格边交点在表的插值下恰等于档值（|Δ| ≤ 1e-4 dB）。
// 成本随【等值线长度】走（有跨档的边占格子数 1%~10%），与网格面积无关；结果只随 (场, 档) 变、
// 与指向 / 投影无关 → edgeRefineFor 按波束缓存，拖拽每帧零求根。
// 只在 pathLoss='none' 与 stride=1 下使用（路损项随斜距逐帧变；stride≥2 时一格 ≤2px，细化看不见）。
// 输出 CSR：off[N+1] 按【边的起点节点】分组；et 边型（0 水平 i→i+1、1 竖直 i→i+NX、2 对角 i→i+NX+1）；
// ek 档号；es 参数 s*。同一节点同一边型的记录连续、按档升序，且 s* 沿边单调（钳制）→ 插点时不必排序。
export function buildEdgeRefine(beam, field, levelsAsc, { pol = 'RSS', gainOffset = 0 } = {}) {
  const { db, NX, NY } = field, N = NX * NY, nb = levelsAsc.length
  const off = new Int32Array(N + 1)
  let cap = 4096, et = new Uint8Array(cap), ek = new Uint16Array(cap), es = new Float32Array(cap), en = new Int32Array(cap), n = 0
  if (!nb || !N || !beam || !beam.grid) return { NX, NY, nb, n: 0, off, et: et.subarray(0, 0), ek: ek.subarray(0, 0), es: es.subarray(0, 0), en: en.subarray(0, 0), cells: new Int32Array(0), nm: 0, moff: new Int32Array(1), mt: new Uint8Array(0), mk: new Uint16Array(0), mu: new Float32Array(0), mv: new Float32Array(0), ms: new Uint8Array(0), dbAt: null }
  const L0 = levelsAsc[0], Ltop = levelsAsc[nb - 1]
  const grow = () => {
    cap *= 2
    const a = new Uint8Array(cap); a.set(et); et = a
    const b = new Uint16Array(cap); b.set(ek); ek = b
    const c = new Float32Array(cap); c.set(es); es = c
    const d = new Int32Array(cap); d.set(en); en = d
  }
  // 沿边 dB：表同一份插值 + 同一极化 / 增益口径；功率非正 → NaN（该点不细化）
  const dbAt = (fc, fr) => { samplePowAt(beam, fc, fr); const P = polPow(pol, _sp[0], _sp[1]); return P > 0 ? 10 * Math.log10(P) + gainOffset : NaN }
  const S_MIN = 1e-6, S_MAX = 1 - 1e-6
  // 一条边：起点 (c0,r0)、方向 (dc,dr)、两端节点 dB v0→v1。跨过的档 = (min, max] 内的档（与取线的 (v0<L)!==(v1<L) 同一判据）。
  const edge = (type, c0, r0, dc, dr, v0, v1) => {
    const lo = v0 < v1 ? v0 : v1, hi = v0 < v1 ? v1 : v0
    if (!(hi >= L0) || lo >= Ltop) return
    const kA = upperBound(levelsAsc, nb, lo), kB = upperBound(levelsAsc, nb, hi) - 1
    if (kA > kB) return
    const up = v0 < v1                                   // 档升 ⇔ s 升
    let prev = up ? -Infinity : Infinity
    for (let k = kA; k <= kB; k++) {
      const L = levelsAsc[k]
      // Illinois 试位：初值取线性交点（采样充分的网格一两次即收敛），目标 |Δ| < 1e-5 dB，记住最好的一次
      let a = 0, b = 1, fa = v0 - L, fb = v1 - L, side = 0, x = (L - v0) / (v1 - v0), bestX = NaN, bestF = Infinity
      for (let it = 0; it < 20; it++) {
        const fx = dbAt(c0 + dc * x, r0 + dr * x) - L
        if (fx !== fx) break
        const af = fx < 0 ? -fx : fx
        if (af < bestF) { bestF = af; bestX = x }
        if (af < 1e-5) break
        if ((fx < 0) === (fb < 0)) { b = x; fb = fx; if (side === -1) fa *= 0.5; side = -1 }
        else { a = x; fa = fx; if (side === 1) fb *= 0.5; side = 1 }
        if (fb === fa || b - a < 1e-9) break
        x = (a * fb - b * fa) / (fb - fa)
        if (!(x > a && x < b)) x = 0.5 * (a + b)
      }
      x = bestX
      if (x !== x) continue
      if (x < S_MIN) x = S_MIN; else if (x > S_MAX) x = S_MAX
      if (up) { if (x <= prev) x = prev + 1e-6 } else if (x >= prev) x = prev - 1e-6     // 沿边单调（各档交点不交叉）
      prev = x
      if (n >= cap) grow()
      et[n] = type; ek[n] = k; es[n] = x; en[n] = r0 * NX + c0; n++
    }
  }
  for (let r = 0; r < NY; r++) {
    const rb = r * NX, lastRow = r === NY - 1
    for (let c = 0; c < NX; c++) {
      const i = rb + c, v0 = db[i]
      off[i] = n
      if (v0 !== v0) continue
      const lastCol = c === NX - 1
      if (!lastCol) { const v1 = db[i + 1]; if (v1 === v1) edge(0, c, r, 1, 0, v0, v1) }
      if (!lastRow) { const v1 = db[i + NX]; if (v1 === v1) edge(1, c, r, 0, 1, v0, v1) }
      if (!lastCol && !lastRow) { const v1 = db[i + NX + 1]; if (v1 === v1) edge(2, c, r, 1, 1, v0, v1) }
    }
  }
  off[N] = n
  // cells：五条边上有记录的格子（按 i00 = r·NX+c 升序）。h@i 记录属格 (r,c) 的底边与 (r−1,c) 的顶边；v@i 属 (r,c) 的
  // 左边与 (r,c−1) 的右边；d@i 只属 (r,c)。三角化循环按行主序走格子，拿一个指针顺着这张表就能 O(1) 判「这格要不要插点」，
  // 不必每格读 6 次 off（94 波束 × 3 万格每帧就是 2000 万次读，实测 25 ms 纯属模式开销）。
  const flag = new Uint8Array(N)
  let nc = 0
  for (let p = 0; p < n; p++) {
    const i = en[p], t = et[p], c = i % NX, r = (i / NX) | 0
    if (t === 0) { if (r < NY - 1 && !flag[i]) { flag[i] = 1; nc++ } if (r > 0 && !flag[i - NX]) { flag[i - NX] = 1; nc++ } }
    else if (t === 1) { if (c < NX - 1 && !flag[i]) { flag[i] = 1; nc++ } if (c > 0 && !flag[i - 1]) { flag[i - 1] = 1; nc++ } }
    else if (!flag[i]) { flag[i] = 1; nc++ }
  }
  const cells = new Int32Array(nc)
  for (let i = 0, q = 0; i < N; i++) if (flag[i]) cells[q++] = i

  // ---- 弧点（每个跨档三角形 × 每档一串「真实等值面上的点」，按曲率自适应）----
  // 三角形内某档的两个交点 P、Q 在表的插值下恰为档值，但它们之间是直弦，真实等值面在格内是弯的。
  // 每条弦递归二分：中点沿法线在同一插值上求根得 M；若 ∠(P,M,Q) > 3° 或矢高 > 0.005 格就对 P–M、M–Q 继续，
  // 深度 ≤ 3（最多 7 点 / 弦）。够直的弦一个点都不插 —— 曲率大的地方（小波束、峰附近、副瓣）自动加密。
  // bandGeometry 把 P–Q 画成 P–a₁–…–a_k–Q，填充按弧所在侧把弦与弧之间的薄片划给正确的档（凹口 / 薄片）。
  // 记录按 cells 分组（moff[ci]..moff[ci+1]）：mt 三角形（0=A(i00,i10,i11) 1=B(i00,i11,i01)）、mk 档、
  // mu/mv 格内局部坐标、ms=1 表示弧在「≥档值」一侧（弧鼓向上档 → 上档开凹口、下档得薄片）。
  // 同一 (三角形, 档) 的弧点【连续存放且按 P→Q 有序】—— 下游 midRange 取区间、按弦上投影定序。
  // 守门（任一不满足就丢掉该点，弦上其余点照留）：根在 ±0.5 格内且 |Δ| ≤ 1e-4 dB、∠(P,M,Q) ≤ 60°（尖刺：根跳到了
  // 等值线另一支）、在三角形内、与首点同侧、沿弦投影单调（不回折）、折线转向一致（弦与弧围出的区域是凸的 →
  // 薄片以 P 为扇心、凹口以最深点为扇心都合法）、相对本三角形其它各档的弦在正确一侧（薄档不许交叉）。
  const moff = new Int32Array(nc + 1)
  let mcap = 1024, mt = new Uint8Array(mcap), mk = new Uint16Array(mcap), mu = new Float32Array(mcap), mv = new Float32Array(mcap), ms = new Uint8Array(mcap), nm = 0
  const mgrow = () => {
    mcap *= 2
    const a = new Uint8Array(mcap); a.set(mt); mt = a
    const b = new Uint16Array(mcap); b.set(mk); mk = b
    const c = new Float32Array(mcap); c.set(mu); mu = c
    const d = new Float32Array(mcap); d.set(mv); mv = d
    const e = new Uint8Array(mcap); e.set(ms); ms = e
  }
  const recOn = (node, type, k) => { for (let p = off[node], pe = off[node + 1]; p < pe; p++) if (et[p] === type && ek[p] === k) return es[p]; return NaN }
  // 三角形某档的交点（格内局部坐标 u,v）→ cu/cv[0..]，返回个数。边序与 bandGeometry.augment 同：
  //   A：底边 h@i00 (s,0)、右边 v@i10 (1,s)、对角 d@i00 (s,s)；B：对角 d@i00 (s,s)、顶边 h@i01 (s,1)、左边 v@i00 (0,s)
  const cu = new Float64Array(3), cv = new Float64Array(3)
  const chordOf = (tri, i00, i10, i01, k) => {
    let n2 = 0, s
    if (tri === 0) {
      s = recOn(i00, 0, k); if (s === s) { cu[n2] = s; cv[n2] = 0; n2++ }
      s = recOn(i10, 1, k); if (s === s) { cu[n2] = 1; cv[n2] = s; n2++ }
      s = recOn(i00, 2, k); if (s === s) { cu[n2] = s; cv[n2] = s; n2++ }
    } else {
      s = recOn(i00, 2, k); if (s === s) { cu[n2] = s; cv[n2] = s; n2++ }
      s = recOn(i01, 0, k); if (s === s) { cu[n2] = s; cv[n2] = 1; n2++ }
      s = recOn(i00, 1, k); if (s === s) { cu[n2] = 0; cv[n2] = s; n2++ }
    }
    return n2
  }
  const cross2 = (ax, ay, bx, by) => ax * by - ay * bx
  // 从弦 a–b 的中点沿法线把 dB 压回档值 L（牛顿一步 + 割线）：命中写 _rt=[u, v, 矢高] 返回 true；
  // 中点已在档上 / 不收敛 / 跑出 ±0.5 格 / 残差 > 1e-4 dB 一律 false（该段保持直线）。
  const _rt = new Float64Array(4)                             // [u, v, 矢高, 法向梯度 |d(dB)/d法向|]
  const arcRoot = (c, r, au, av, bu, bv, L, gdHint) => {
    const eu = bu - au, ev = bv - av, el = Math.hypot(eu, ev)
    if (!(el > 1e-9)) return false
    const nu = -ev / el, nv = eu / el, cmu = 0.5 * (au + bu), cmv = 0.5 * (av + bv)
    const f = (t) => dbAt(c + cmu + nu * t, r + cmv + nv * t) - L
    const e0 = f(0); if (e0 !== e0 || Math.abs(e0) < 1e-5) return false
    // 预筛：拿父弦的法向梯度把「中点偏离档值」折成矢高，明显够直就不解（省五次取值）。
    // 判据与下面的接收条件同一口径：矢高 > ε 或转角 > θmax，后者等价于矢高 > tan(θmax/4)·弦长 ≈ 0.0131·弦长。留 2 倍余量。
    if (gdHint > 0 && Math.abs(e0) / gdHint < 0.5 * Math.min(ARC_SAG, 0.0131 * el)) return false
    const h = Math.min(0.02, 0.25 * el)                       // 中心差分步长：整条弦上仍是 0.02（与 09-16 逐位同），子弦按长度收窄
    const fp = f(h), fm = f(-h); if (fp !== fp || fm !== fm) return false
    const gd = (fp - fm) / (2 * h); if (!(Math.abs(gd) > 1e-9)) return false
    let ta = 0, fa = e0, tb = -e0 / gd
    if (!(Math.abs(tb) <= 0.5)) return false
    let fb = f(tb); if (fb !== fb) return false
    for (let it = 0; it < 5 && Math.abs(fb) > 1e-5 && fb !== fa; it++) {
      const tn = tb - fb * (tb - ta) / (fb - fa)
      if (!(Math.abs(tn) <= 0.5)) break
      const fn = f(tn); if (fn !== fn) break
      ta = tb; fa = fb; tb = tn; fb = fn
    }
    if (!(Math.abs(fb) <= 1e-4)) return false
    _rt[0] = cmu + nu * tb; _rt[1] = cmv + nv * tb; _rt[2] = Math.abs(tb); _rt[3] = Math.abs(gd)
    return true
  }
  const angDeg = (ax, ay, bx, by, cx2, cy2) => {
    const ux = bx - ax, uy = by - ay, vx = cx2 - bx, vy = cy2 - by
    const n1 = Math.hypot(ux, uy), n2 = Math.hypot(vx, vy)
    if (!(n1 > 0 && n2 > 0)) return 0
    let t = (ux * vx + uy * vy) / (n1 * n2); if (t > 1) t = 1; else if (t < -1) t = -1
    return Math.acos(t) * 180 / Math.PI
  }
  const ARC_CAP = 7, ARC_DEPTH = 3, ARC_THETA = 3, ARC_SAG = 0.005, ARC_TURN_MAX = 60
  const arcU = new Float64Array(ARC_CAP), arcV = new Float64Array(ARC_CAP)
  let na = 0
  // force：整条弦的中点照旧无条件插（= 09-16 起的弦中点，本改动只在它之上加密）；
  // 子弦按自己的矢高 / 转角决定要不要再分 —— 曲率大的地方自动加密，平直段一个点都不多。
  const arcRec = (c, r, au, av, bu, bv, L, depth, force, gdHint) => {
    if (depth >= ARC_DEPTH || na >= ARC_CAP) return
    if (!arcRoot(c, r, au, av, bu, bv, L, force ? 0 : gdHint)) return
    const mu2 = _rt[0], mv2 = _rt[1], sag = _rt[2], gd2 = _rt[3]   // _rt 是共享暂存：递归前先存下来
    const ang = angDeg(au, av, mu2, mv2, bu, bv)
    if (ang > ARC_TURN_MAX) return                            // 尖刺：根跳到了等值线的另一支
    if (!force && !(sag > ARC_SAG || ang > ARC_THETA)) return // 这一段够直，不插点
    arcRec(c, r, au, av, mu2, mv2, L, depth + 1, false, gd2)
    if (na < ARC_CAP) { arcU[na] = mu2; arcV[na] = mv2; na++ }
    arcRec(c, r, mu2, mv2, bu, bv, L, depth + 1, false, gd2)
  }
  const _oc = new Float64Array(5 * nb)                        // 其它各档在本三角形的弦：[c0u, c0v, ju, jv, sV]
  for (let ci = 0; ci < nc; ci++) {
    moff[ci] = nm
    const i00 = cells[ci], c = i00 % NX, r = (i00 / NX) | 0
    if (c >= NX - 1 || r >= NY - 1) continue
    const i10 = i00 + 1, i01 = i00 + NX, i11 = i01 + 1
    for (let tri = 0; tri < 2; tri++) {
      const iB = tri ? i11 : i10, iC = tri ? i01 : i11
      const dA = db[i00], dB = db[iB], dC = db[iC]
      if (dA !== dA || dB !== dB || dC !== dC) continue
      const uB = 1, vB = tri ? 1 : 0, uC = tri ? 0 : 1, vC = 1        // 顶点局部坐标：A=(0,0),(1,0),(1,1)  B=(0,0),(1,1),(0,1)
      const dmin = Math.min(dA, dB, dC), dmax = Math.max(dA, dB, dC)
      const kLo = upperBound(levelsAsc, nb, dmin), kHi = upperBound(levelsAsc, nb, dmax) - 1   // 严格跨越：dmin < L ≤ dmax
      if (kLo > kHi) continue
      const aMax = dA >= dB && dA >= dC, bMax = !aMax && dB >= dC
      const uMax = aMax ? 0 : (bMax ? uB : uC), vMax = aMax ? 0 : (bMax ? vB : vC)
      const aMin = dA <= dB && dA <= dC, bMin = !aMin && dB <= dC
      const uMin = aMin ? 0 : (bMin ? uB : uC), vMin = aMin ? 0 : (bMin ? vB : vC)
      for (let k = kLo; k <= kHi; k++) {
        if (chordOf(tri, i00, i10, i01, k) !== 2) continue
        const L = levelsAsc[k]
        const pu = cu[0], pv = cv[0], qu = cu[1], qv = cv[1]
        const eu = qu - pu, ev = qv - pv, el2 = eu * eu + ev * ev; if (!(el2 > 1e-18)) continue
        na = 0
        arcRec(c, r, pu, pv, qu, qv, L, 0, true, 0)
        if (!na) continue
        // 其它各档在本三角形的弦先取好（chordOf 会覆写 cu/cv，逐点再取要多跑一遍）
        let noc = 0
        for (let j = kLo; j <= kHi; j++) {
          if (j === k || chordOf(tri, i00, i10, i01, j) !== 2) continue
          const w = noc * 5, ju = cu[1] - cu[0], jv = cv[1] - cv[0]
          _oc[w] = cu[0]; _oc[w + 1] = cv[0]; _oc[w + 2] = ju; _oc[w + 3] = jv
          _oc[w + 4] = j > k ? cross2(ju, jv, uMin - cu[0], vMin - cv[0]) : cross2(ju, jv, uMax - cu[0], vMax - cv[0])
          noc++
        }
        const base = nm
        let side0 = 0, lastProj = 0, turnSgn = 0, prevU = pu, prevV = pv, pprevU = NaN, pprevV = 0
        for (let a2 = 0; a2 < na; a2++) {
          const muv = arcU[a2], mvv = arcV[a2]
          const lA = tri ? 1 - mvv : 1 - muv, lB = tri ? muv : muv - mvv, lC = tri ? mvv - muv : mvv
          if (lA < -1e-9 || lB < -1e-9 || lC < -1e-9) continue                  // 在三角形内
          const sg = cross2(eu, ev, muv - pu, mvv - pv); if (sg === 0) continue
          const sgn = sg > 0 ? 1 : -1
          if (!side0) side0 = sgn; else if (sgn !== side0) continue             // 与首点同侧
          const proj = (muv - pu) * eu + (mvv - pv) * ev
          if (!(proj > lastProj) || !(proj < el2)) continue                     // 沿弦投影单调、不越出 P–Q
          // 折线转向一致（弦与弧围出的区域是凸的）：与前两点比一次
          if (pprevU === pprevU) {
            const t2 = cross2(prevU - pprevU, prevV - pprevV, muv - prevU, mvv - prevV)
            if (t2 !== 0) { const ts = t2 > 0 ? 1 : -1; if (!turnSgn) turnSgn = ts; else if (ts !== turnSgn) continue }
          }
          let okSide = true
          for (let j = 0; j < noc && okSide; j++) {
            const w = j * 5
            if (!(cross2(_oc[w + 2], _oc[w + 3], muv - _oc[w], mvv - _oc[w + 1]) * _oc[w + 4] > 0)) okSide = false
          }
          if (!okSide) continue
          if (nm >= mcap) mgrow()
          mt[nm] = tri; mk[nm] = k; mu[nm] = muv; mv[nm] = mvv; ms[nm] = 0; nm++
          lastProj = proj; pprevU = prevU; pprevV = prevV; prevU = muv; prevV = mvv
        }
        if (nm === base) continue
        // 收尾：Q 也要满足同一转向（否则弧与弦围出的区域不凸，扇形三角化会重叠）—— 不合就砍掉最后一个点
        while (nm > base && pprevU === pprevU) {
          const t2 = cross2(prevU - pprevU, prevV - pprevV, qu - prevU, qv - prevV)
          if (t2 === 0 || !turnSgn || (t2 > 0 ? 1 : -1) === turnSgn) break
          nm--
          if (nm === base) break
          prevU = mu[nm - 1]; prevV = mv[nm - 1]
          pprevU = nm - 1 > base ? mu[nm - 2] : pu; pprevV = nm - 1 > base ? mv[nm - 2] : pv
        }
        if (nm === base) continue
        const side = side0 * cross2(eu, ev, uMax - pu, vMax - pv) > 0 ? 1 : 0
        for (let p2 = base; p2 < nm; p2++) ms[p2] = side
      }
    }
  }
  moff[nc] = nm
  // dbAt(fc, fr)：表同一份插值的 dB（本极化 / 增益口径），供 bandGeometry 把等值线的地平端点拉到真实地平线上
  return { NX, NY, nb, n, off, et: et.subarray(0, n), ek: ek.subarray(0, n), es: es.subarray(0, n), en: en.subarray(0, n), cells, nm, moff, mt: mt.subarray(0, nm), mk: mk.subarray(0, nm), mu: mu.subarray(0, nm), mv: mv.subarray(0, nm), ms: ms.subarray(0, nm), dbAt }
}
// 按波束缓存的细化表：键 = (极化, 增益偏置, 档表, 网格尺寸)。方向图与档一样 → 表一样，对地 / 对星覆盖、
// 导出等值线共用一份；拖拽 / 播放不改这些键 → 每帧零求根。
const sameArr = (a, b) => { if (!a || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true }
export function edgeRefineFor(beam, field, levelsAsc, pol, gainOffset) {
  const cc = beam._ref
  if (cc && cc.pol === pol && cc.gain === gainOffset && cc.NX === field.NX && cc.NY === field.NY && sameArr(cc.levels, levelsAsc)) return cc.ref
  const ref = buildEdgeRefine(beam, field, levelsAsc, { pol, gainOffset })
  beam._ref = { pol, gain: gainOffset, NX: field.NX, NY: field.NY, levels: Float64Array.from(levelsAsc), ref }
  return ref
}

// ===== 细化顶点的地表位置（掠地格子逐点射线求交）=====
// bandGeometry 里插进三角形的顶点（格边交点、弦中点）默认按两端 / 三个角的投影经纬度线性（重心）插值——
// 30° 仰角以上误差 <0.005 dB，但 10° 以下经纬度随天线角变化极快，线性插会把点放错 0.3~0.9 dB。
// 这里对「所在格子任一角仰角 < 30°」的顶点按 projectGrid 同一套几何逐点求交（方向 → 天线系 → 射线与椭球 →
// 大地纬度 4 次定点迭代；越地平取 pRaw，与 limbOutside 一致），其余留 NaN 由 bandGeometry 回退到插值。
// 随投影每帧重算，只碰热区盒内的记录。rayEllipsoidMargin 的 m = 4·sin²(仰角)/A²（球近似）→ 30° 处 m = 1/A²。
export const REFINE_EXACT_M = 1 / (A * A)
export const LIMB_M_TOL = 4 * Math.sin(0.01 * D2R) ** 2 / (A * A)     // 地平交点求根容差：仰角 0.01°
export function projectRefine(rf, grid, igrid, basis, proj, out = null) {
  const n = rf.n, nm = rf.nm || 0, NX = rf.NX, NY = rf.NY
  const reuse = out && out.lon && out.lon.length === n && out.mlon && out.mlon.length === nm
  const o = reuse ? out : { lon: new Float32Array(n), lat: new Float32Array(n), vis: new Float32Array(n), mlon: new Float32Array(nm), mlat: new Float32Array(nm), mvis: new Float32Array(nm), exact: 0 }
  o.lon.fill(NaN); o.lat.fill(NaN); o.vis.fill(NaN); o.mlon.fill(NaN); o.mlat.fill(NaN); o.mvis.fill(NaN); o.exact = 0
  if (!n || !proj || !proj.vis || !grid) return o
  const vis = proj.vis, bx = proj.box
  const r0 = bx ? bx.r0 : 0, r1 = bx ? bx.r1 : NY - 1, c0 = bx ? bx.c0 : 0, c1 = bx ? bx.c1 : NX - 1
  const graze = (i) => { const rr = (i / NX) | 0, cc = i % NX; return rr >= r0 && rr <= r1 && cc >= c0 && cc <= c1 && vis[i] < REFINE_EXACT_M }
  const { S, x, y, z } = basis
  const x0 = x[0], x1 = x[1], x2 = x[2], y0 = y[0], y1 = y[1], y2 = y[2], z0 = z[0], z1 = z[1], z2 = z[2]
  const dx = (grid.XE - grid.XS) / (NX - 1), dy = (grid.YE - grid.YS) / (NY - 1)
  const d = [0, 0, 0]
  const _sv = new Float64Array(3)
  const solveTo = (fc, fr) => {
    const g = gridDir(igrid, grid.XS + fc * dx, grid.YS + fr * dy), a = g[0], b = g[1], cz = g[2]
    const ex = x0 * a + y0 * b + z0 * cz, ey = x1 * a + y1 * b + z1 * cz, ez = x2 * a + y2 * b + z2 * cz
    const inv = 1 / (Math.hypot(ex, ey, ez) || 1)
    d[0] = ex * inv; d[1] = ey * inv; d[2] = ez * inv
    const rr = rayEllipsoidMargin(S, d), P = rr.m < 0 ? rr.pRaw : rr.p, px = P[0], py = P[1], pz = P[2]
    const Rxy = Math.hypot(px, py)
    let glat = Math.atan2(pz, Rxy)
    for (let it = 0; it < 4; it++) { const sgl = Math.sin(glat); glat = Math.atan2(pz + A * E2 * sgl / Math.sqrt(1 - E2 * sgl * sgl), Rxy) }
    _sv[0] = Math.atan2(py, px) * R2D; _sv[1] = glat * R2D; _sv[2] = rr.m
    return _sv
  }
  const solve = (fc, fr, aLon, aLat, aVis, q) => { solveTo(fc, fr); aLon[q] = _sv[0]; aLat[q] = _sv[1]; aVis[q] = _sv[2]; o.exact++ }
  o.solve = solveTo                                                    // 供 bandGeometry 对地平裁剪出的顶点逐点求交（返回共享暂存 [lon,lat,m]）
  const { en, et, es } = rf
  for (let p = 0; p < n; p++) {
    const i = en[p], t = et[p], f = t === 0 ? i + 1 : (t === 1 ? i + NX : i + NX + 1)
    if (f >= NX * NY || !(graze(i) || graze(f))) continue
    const c = i % NX, r = (i / NX) | 0, s = es[p]
    solve(t === 1 ? c : c + s, t === 0 ? r : r + s, o.lon, o.lat, o.vis, p)
  }
  if (nm) {
    const { cells, moff, mu, mv } = rf
    for (let ci = 0; ci < cells.length; ci++) {
      const a = moff[ci], b = moff[ci + 1]; if (a === b) continue
      const i00 = cells[ci], i10 = i00 + 1, i01 = i00 + NX, i11 = i01 + 1
      if (i11 >= NX * NY || !(graze(i00) || graze(i10) || graze(i01) || graze(i11))) continue
      const c = i00 % NX, r = (i00 / NX) | 0
      for (let q = a; q < b; q++) solve(c + mu[q], r + mv[q], o.mlon, o.mlat, o.mvis, q)
    }
  }
  return o
}

// box（可选，与 projectGrid 同一个）：只遍历覆盖热区的格子，跳过大片无覆盖区（HTS 提速）。
// hull（可选）：该卫星的平滑地平弧凸包 { ring:[[u,lat]...] CCW, satLon }（见 useGrdCoverage.satHull）。
//   提供时跨地平三角形的填充沿此弧裁剪（边缘平滑、无锯齿）；缺省则回退到逐三角形 0°仰角线半平面裁剪。
// stride：三角化降采样步长（1=全分辨率；2/4=每 N 格取一三角，等值线/填充变粗但场/峰值数值不变）。
// refine（可选）：buildEdgeRefine 的交点细化表——各档在格边上的交点不再按节点 dB 线性取，而是插成顶点落在
//   性能指标表同一份插值的求根位置（线 = 表）；填充与线仍同源重合。stride≥2 或表尺寸不符时忽略。
// pos（可选，projectRefine 的输出）：细化顶点在本帧投影下的精确位置（掠地格子），NaN 处回退到插值。
export function bandGeometry(field, levelsAsc, wantFills = true, box = null, hull = null, stride = 1, refine = null, pos = null) {
  const { lon, lat, vis, db, NX, NY } = field
  const nb = levelsAsc.length
  const lines = Array.from({ length: nb }, () => [])
  if (!nb || !NX || !NY) return { fills: Array.from({ length: nb }, () => ({ verts: _EMPTY_F64, counts: _EMPTY_I32 })), lines }
  const st = Math.max(1, stride | 0)
  const rf = (refine && refine.n && st === 1 && refine.NX === NX && refine.NY === NY) ? refine : null
  const ps = (rf && pos && pos.lon && pos.lon.length === rf.n && pos.mlon && pos.mlon.length === (rf.nm || 0)) ? pos : null
  const limbSolve = (ps && ps.solve) ? ps.solve : null                  // 格坐标 → [lon, lat, m]（掠地几何逐点求交）
  _bgEnsure((rf ? 3 * nb + 10 : 16) + 32)   // +32：地平边的 hull 弧点、两条弦各最多 7 个弧点
  _fillReset(nb)
  const L0 = levelsAsc[0]
  // Sutherland-Hodgman：凸多边形(src 扁平缓冲, len 顶点数)按分量 ci(2=d,3=m) 与阈值 t 半平面裁剪写入 dst，返回新顶点数。
  // keepGE: 留分量≥t，否则留≤t。顶点 4 分量 [x,y,d,m] 全程线性插值（与旧 {x,y,d,m} 版逐位等价）。
  const clip = (src, len, ci, t, keepGE, dst, uv) => {
    let out = 0
    for (let i = 0; i < len; i++) {
      const ai = i * 6, bi = ((i + 1) % len) * 6
      const va = src[ai + ci], vb = src[bi + ci]
      const ina = keepGE ? va >= t : va <= t, inb = keepGE ? vb >= t : vb <= t
      // 逐档裁剪（ci=2）不带 u,v：格坐标只有地平裁剪（ci=3）后面才用到（等值线地平端点），省 1/3 的搬运
      if (ina) { const o = out * 6; dst[o] = src[ai]; dst[o + 1] = src[ai + 1]; dst[o + 2] = src[ai + 2]; dst[o + 3] = src[ai + 3]; if (ci === 3 || uv) { dst[o + 4] = src[ai + 4]; dst[o + 5] = src[ai + 5] } out++ }
      // 边界恰穿过顶点（细化插入的顶点 d 精确等于档值）时交点就是该顶点本身，不再重复吐一次
      if (ina !== inb && va !== t && vb !== t) {
        let s = (t - va) / (vb - va)
        const o = out * 6
        let done = false
        if (ci === 3 && limbSolve) {
          // 地平交点：格坐标沿边按线性 m 取（m 在地平附近随天线角近似线性），经纬度按该格坐标逐点求交一次——
          // 不在这里迭代到 m=0：等值线的地平端点由 limbEnd 另做二维求根，填充的地平边在应用里走平滑地平弧（hull）。
          const r = limbSolve(src[ai + 4] + (src[bi + 4] - src[ai + 4]) * s, src[ai + 5] + (src[bi + 5] - src[ai + 5]) * s)
          if (r[0] === r[0] && r[1] === r[1]) {
            dst[o + 2] = src[ai + 2] + (src[bi + 2] - src[ai + 2]) * s
            dst[o + 4] = src[ai + 4] + (src[bi + 4] - src[ai + 4]) * s
            dst[o + 5] = src[ai + 5] + (src[bi + 5] - src[ai + 5]) * s
            let l = r[0]; const ax = src[0]; while (l - ax > 180) l -= 360; while (l - ax < -180) l += 360
            dst[o] = l; dst[o + 1] = r[1]; dst[o + 3] = 0
            done = true
          }
        }
        if (!done && ci === 2 && limbSolve && dbAtR && src[ai + 3] === 0 && src[bi + 3] === 0) {
          // 地平边（两端 m=0）上的档交点：与等值线的地平端点走同一个 limbEnd —— 同一份 (u, v, 边向, L) 进去，
          // 出来逐位同一点，填充边与线由构造重合（不然线走二维求根、填充走沿边线性，两者差 16~39 km）。
          const ua = src[ai + 4], wa = src[ai + 5]
          const eu = src[bi + 4] - ua, ev = src[bi + 5] - wa
          const cu = ua + eu * s, cv = wa + ev * s
          const r = limbEnd(cu, cv, eu, ev, t)
          if (r[0] === r[0] && r[1] === r[1]) {
            const ax = src[0]; let l = r[0]; while (l - ax > 180) l -= 360; while (l - ax < -180) l += 360
            dst[o] = l; dst[o + 1] = r[1]; dst[o + 2] = t; dst[o + 3] = 0; dst[o + 4] = cu; dst[o + 5] = cv
            done = true
          }
        }
        if (!done) {
          dst[o] = src[ai] + (src[bi] - src[ai]) * s
          dst[o + 1] = src[ai + 1] + (src[bi + 1] - src[ai + 1]) * s
          dst[o + 2] = src[ai + 2] + (src[bi + 2] - src[ai + 2]) * s
          dst[o + 3] = src[ai + 3] + (src[bi + 3] - src[ai + 3]) * s
          if (ci === 3 || uv) { dst[o + 4] = src[ai + 4] + (src[bi + 4] - src[ai + 4]) * s; dst[o + 5] = src[ai + 5] + (src[bi + 5] - src[ai + 5]) * s }
          dst[o + ci] = t                                              // 被裁分量精确取阈值（地平交点 m=0 / 档交点 d=L）
        }
        out++
      }
    }
    return out
  }
  // 把三角形载入 _bgBase（外两角相对首角 ax 解缠经度），返回 false 表示该三角整体可跳过
  const loadTri = (i0, i1, i2, isB) => {
    const d0 = db[i0], d1 = db[i1], d2 = db[i2]
    if (d0 !== d0 || d1 !== d1 || d2 !== d2) return false              // 任一角增益无效
    const m0 = vis ? vis[i0] : 1, m1 = vis ? vis[i1] : 1, m2 = vis ? vis[i2] : 1
    if (m0 < 0 && m1 < 0 && m2 < 0) return false                       // 整三角越地平
    if (!(Math.max(d0, d1, d2) >= L0)) return false                   // 全部低于最低档 → 无覆盖
    const ax = lon[i0]
    let l1 = lon[i1]; while (l1 - ax > 180) l1 -= 360; while (l1 - ax < -180) l1 += 360
    let l2 = lon[i2]; while (l2 - ax > 180) l2 -= 360; while (l2 - ax < -180) l2 += 360
    // u,v = 格坐标，从格子循环留在 _cc 里的四角取（A=(col,row),(c2,row),(c2,r2)；B=(col,row),(c2,r2),(col,r2)），
    // 不做取模 / 整除——每三角 6 次整数运算在 76 万三角上就是 25 ms
    _bgBase[0] = ax; _bgBase[1] = lat[i0]; _bgBase[2] = d0; _bgBase[3] = m0; _bgBase[4] = _cc[0]; _bgBase[5] = _cc[1]
    _bgBase[6] = l1; _bgBase[7] = lat[i1]; _bgBase[8] = d1; _bgBase[9] = m1; _bgBase[10] = _cc[2]; _bgBase[11] = isB ? _cc[3] : _cc[1]
    _bgBase[12] = l2; _bgBase[13] = lat[i2]; _bgBase[14] = d2; _bgBase[15] = m2; _bgBase[16] = isB ? _cc[0] : _cc[2]; _bgBase[17] = _cc[3]
    return true
  }
  // ---- 交点细化：把表里落在三角形三条边上的交点插成顶点（d 精确 = 档值，x/y/m 沿边线性）----
  // 三角形边 (va→vb) 对应表里起点节点 node 的 type 型边；fwd=false 表示三角形边走向与表里相反（s = 1−s*）。
  // 表内同边记录按档升序、s* 沿边单调 → 要沿 va→vb 得 s 升序只看 d 沿边升还是降：升取表序、降取倒序（与 fwd 无关）。
  const rOff = rf ? rf.off : null, rEt = rf ? rf.et : null, rEk = rf ? rf.ek : null, rEs = rf ? rf.es : null
  const putV = (o, v) => { const w = o * 6, a = v * 6; _bgBase[w] = _bgTri[a]; _bgBase[w + 1] = _bgTri[a + 1]; _bgBase[w + 2] = _bgTri[a + 2]; _bgBase[w + 3] = _bgTri[a + 3]; _bgBase[w + 4] = _bgTri[a + 4]; _bgBase[w + 5] = _bgTri[a + 5]; return o + 1 }
  const insEdge = (o, va, vb, node, type, fwd) => {
    let p = rOff[node]; const pe = rOff[node + 1]
    while (p < pe && rEt[p] !== type) p++
    if (p === pe) return o
    let q = p + 1; while (q < pe && rEt[q] === type) q++
    const a = va * 6, b = vb * 6
    const xa = _bgTri[a], ya = _bgTri[a + 1], ma = _bgTri[a + 3], ua = _bgTri[a + 4], wa = _bgTri[a + 5]
    const dx = _bgTri[b] - xa, dy = _bgTri[b + 1] - ya, dm = _bgTri[b + 3] - ma, du = _bgTri[b + 4] - ua, dw = _bgTri[b + 5] - wa
    // 位置：pos 里有精确解（掠地格子逐点求交）就用它（经度按本边起点解缠），否则沿边线性插
    if (_bgTri[a + 2] < _bgTri[b + 2]) {
      for (let i = p; i < q; i++) {
        const w = o * 6, s = fwd ? rEs[i] : 1 - rEs[i]
        if (ps && ps.lon[i] === ps.lon[i]) { let l = ps.lon[i]; while (l - xa > 180) l -= 360; while (l - xa < -180) l += 360; _bgBase[w] = l; _bgBase[w + 1] = ps.lat[i]; _bgBase[w + 3] = ps.vis[i] }
        else { _bgBase[w] = xa + dx * s; _bgBase[w + 1] = ya + dy * s; _bgBase[w + 3] = ma + dm * s }
        _bgBase[w + 2] = levelsAsc[rEk[i]]; _bgBase[w + 4] = ua + du * s; _bgBase[w + 5] = wa + dw * s; o++
      }
    } else {
      for (let i = q - 1; i >= p; i--) {
        const w = o * 6, s = fwd ? rEs[i] : 1 - rEs[i]
        if (ps && ps.lon[i] === ps.lon[i]) { let l = ps.lon[i]; while (l - xa > 180) l -= 360; while (l - xa < -180) l += 360; _bgBase[w] = l; _bgBase[w + 1] = ps.lat[i]; _bgBase[w + 3] = ps.vis[i] }
        else { _bgBase[w] = xa + dx * s; _bgBase[w + 1] = ya + dy * s; _bgBase[w + 3] = ma + dm * s }
        _bgBase[w + 2] = levelsAsc[rEk[i]]; _bgBase[w + 4] = ua + du * s; _bgBase[w + 5] = wa + dw * s; o++
      }
    }
    return o
  }
  // 一格两个三角形三条边在表里的定位（起点节点, 边型, 走向是否与表一致）：
  //   A=(i00,i10,i11)：底边 h@i00 顺、右边 v@i10 顺、对角 d@i00 逆；B=(i00,i11,i01)：对角 d@i00 顺、顶边 h@i01 逆、左边 v@i00 逆
  const augment = (i0, i1, i2, isB) => {
    for (let i = 0; i < 18; i++) _bgTri[i] = _bgBase[i]
    let o = putV(0, 0)
    o = isB ? insEdge(o, 0, 1, i0, 2, true) : insEdge(o, 0, 1, i0, 0, true); o = putV(o, 1)
    o = isB ? insEdge(o, 1, 2, i2, 0, false) : insEdge(o, 1, 2, i1, 1, true); o = putV(o, 2)
    o = isB ? insEdge(o, 2, 0, i0, 1, false) : insEdge(o, 2, 0, i0, 2, false)
    return o
  }
  // ---- 弦中点（refine.m*）：本格记录 [m0,m1)；mPos 取其本帧位置 → _mp=[x,y,m]（掠地格子用 pos 的精确解，否则三角形重心插值）----
  const rMt = rf ? rf.mt : null, rMk = rf ? rf.mk : null, rMu = rf ? rf.mu : null, rMv = rf ? rf.mv : null, rMs = rf ? rf.ms : null
  const rMoff = (rf && rf.moff && rf.nm) ? rf.moff : null
  const _mp = new Float64Array(5)     // [x, y, m, u, v]
  const mPos = (q, isB) => {
    const ax = _bgTri[0], u = rMu[q], v = rMv[q]
    _mp[3] = _bgTri[4] + u; _mp[4] = _bgTri[5] + v                   // 格坐标 = i00 的列/行 + 格内局部坐标
    if (ps && ps.mlon[q] === ps.mlon[q]) {
      let l = ps.mlon[q]; while (l - ax > 180) l -= 360; while (l - ax < -180) l += 360
      _mp[0] = l; _mp[1] = ps.mlat[q]; _mp[2] = ps.mvis[q]; return
    }
    const lA = isB ? 1 - v : 1 - u, lB = isB ? u : u - v, lC = isB ? v - u : v   // 重心坐标（A=(0,0),(1,0),(1,1)  B=(0,0),(1,1),(0,1)）
    _mp[0] = lA * _bgTri[0] + lB * _bgTri[6] + lC * _bgTri[12]
    _mp[1] = lA * _bgTri[1] + lB * _bgTri[7] + lC * _bgTri[13]
    _mp[2] = lA * _bgTri[3] + lB * _bgTri[9] + lC * _bgTri[15]
  }
  // 本三角形本档的弧点区间 [_mr0, _mr1)（同一 (三角形, 档) 的记录连续、按 P→Q 有序）
  let _mr0 = 0, _mr1 = 0
  const midRange = (m0, m1, isB, k) => {
    const t = isB ? 1 : 0
    let p = m0
    while (p < m1 && !(rMt[p] === t && rMk[p] === k)) p++
    if (p >= m1) { _mr0 = _mr1 = 0; return 0 }
    let q = p + 1
    while (q < m1 && rMt[q] === t && rMk[q] === k) q++
    _mr0 = p; _mr1 = q; return q - p
  }
  const ARC_CAP = 7
  const _arcP = new Float64Array(5 * ARC_CAP)     // 逐弧点 [x, y, m, u, v]
  // 算好 [_mr0, _mr0+cnt) 这几个弧点的本帧位置；任一点越地平就整条退回直弦（线与填充同一判据，两者才始终重合）
  const arcPos = (cnt, isB) => {
    for (let i = 0; i < cnt; i++) {
      mPos(_mr0 + i, isB)
      if (!(_mp[2] >= 0)) return false
      const w = i * 5
      _arcP[w] = _mp[0]; _arcP[w + 1] = _mp[1]; _arcP[w + 2] = _mp[2]; _arcP[w + 3] = _mp[3]; _arcP[w + 4] = _mp[4]
    }
    return true
  }
  // 区间 + 位置一步到位（等值线那一路用）
  const arcOf = (m0, m1, isB, k) => {
    const cnt = midRange(m0, m1, isB, k)
    if (!cnt || cnt > ARC_CAP) return 0
    return arcPos(cnt, isB) ? cnt : 0
  }
  // 弧点按 P→Q 存，而弦在多边形 / 线上的走向可能相反：按在弦上的投影定序
  const arcRev = (ax, ay, bx, by, cnt) => {
    if (cnt < 2) return false
    const ex = bx - ax, ey = by - ay, w = (cnt - 1) * 5
    return (_arcP[0] - ax) * ex + (_arcP[1] - ay) * ey > (_arcP[w] - ax) * ex + (_arcP[w + 1] - ay) * ey
  }
  // 等值线的地平端点：线性交点 Z 落在两地平顶点的弦上，弦离真实地平差一个矢高——天线角 0.002° 的矢高在地平处就是
  // 仰角 1°（仰角 ∝ √Δθ）。交替求根：沿弦法线把 m 压到 0（Illinois），再沿弦方向把 d 拉回 L（割线，rf.dbAt），两轮收敛。
  const dbAtR = (rf && rf.dbAt) ? rf.dbAt : null
  const _le = new Float64Array(2)
  const limbEnd = (u, v, eu, ev, L) => {
    const el = Math.hypot(eu, ev) || 1, tu = eu / el, tv = ev / el, nu = -tv, nv = tu
    let r = limbSolve(u, v)
    for (let round = 0; round < 2 && dbAtR && r[2] === r[2]; round++) {
      if (Math.abs(r[2]) > LIMB_M_TOL) {                                // (a) 沿法线到 m=0：先找 m<0 的一侧并夹住
        // ★ r 是 limbSolve 的共享暂存（每次调用都覆盖）：起点的 m 必须在探测之前存下来。原先探测完再读 r[2]，读到的是
        //   最后一次探测的值 —— 探到 dir=−1 时 fa===fb，试位除零、端点 NaN（09-16 审查：合成 GEO 场 8164 个线顶点里 14 个）。
        //   b 也要取【探到 m<0 的那一档】距离，不是循环退出后又翻了一倍的 h。
        const m0 = r[2]
        let h = 0.01, hp = 0, dir = 0, mh = NaN
        for (let k = 0; k < 6 && dir === 0; k++) {
          const mp = limbSolve(u + nu * h, v + nv * h)[2], mm = limbSolve(u - nu * h, v - nv * h)[2]
          if (mp < 0) { dir = 1; mh = mp; hp = h } else if (mm < 0) { dir = -1; mh = mm; hp = h } else h *= 2
        }
        if (dir === 0) break
        let a = 0, fa = m0, b = dir * hp, fb = mh, x = 0, side = 0
        for (let it = 0; it < 8; it++) {
          x = (a * fb - b * fa) / (fb - fa)
          const fx = limbSolve(u + nu * x, v + nv * x)[2]
          if (!(fx === fx) || Math.abs(fx) <= LIMB_M_TOL) break
          if ((fx < 0) === (fb < 0)) { b = x; fb = fx; if (side === -1) fa *= 0.5; side = -1 }
          else { a = x; fa = fx; if (side === 1) fb *= 0.5; side = 1 }
        }
        u += nu * x; v += nv * x; r = limbSolve(u, v)
      }
      const g0 = dbAtR(u, v) - L                                        // (b) 沿切向到 d=L
      if (!(g0 === g0) || Math.abs(g0) < 1e-4) continue
      const gd = (dbAtR(u + tu * 0.01, v + tv * 0.01) - L - g0) / 0.01
      if (!(Math.abs(gd) > 1e-9)) break
      const t = -g0 / gd
      if (!(Math.abs(t) <= 0.5)) break
      u += tu * t; v += tv * t; r = limbSolve(u, v)
    }
    _le[0] = r[0]; _le[1] = r[1]; return _le
  }
  // 多边形 src(len) 上第 L 档的弦：两个 d===L 且环上相邻的顶点，返回前一个的下标（弦 = ia→ia+1），无则 -1
  const chordAt = (src, len, L) => {
    for (let i = 0; i < len; i++) { const j = (i + 1) % len; if (src[i * 6 + 2] === L && src[j * 6 + 2] === L) return i }
    return -1
  }
  // 以 start 号顶点为扇心的扇形三角化是否合法：全部三角形同向 ⇔ 该顶点在多边形的核内
  const fanOk = (b, n2, start) => {
    let sgn = 0
    const o = start * 6
    for (let i = 1; i < n2 - 1; i++) {
      const a = ((start + i) % n2) * 6, c2 = ((start + i + 1) % n2) * 6
      const t = (b[a] - b[o]) * (b[c2 + 1] - b[o + 1]) - (b[a + 1] - b[o + 1]) * (b[c2] - b[o])
      if (t === 0) continue
      const u = t > 0 ? 1 : -1
      if (!sgn) sgn = u; else if (u !== sgn) return false
    }
    return true
  }
  // 耳切兜底（两条弦都开凹口时扇心校验会不过）：O(n²)，n ≤ 3 + 档数 + 弧点数，逐个吐三角形
  const _ear = new Int32Array(96)
  const _inTri = (b, p, i0, i1, i2) => {
    const px = b[p * 6], py = b[p * 6 + 1]
    const ax = b[i0 * 6], ay = b[i0 * 6 + 1], bx = b[i1 * 6], by = b[i1 * 6 + 1], cx2 = b[i2 * 6], cy2 = b[i2 * 6 + 1]
    const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    const d2 = (cx2 - bx) * (py - by) - (cy2 - by) * (px - bx)
    const d3 = (ax - cx2) * (py - cy2) - (ay - cy2) * (px - cx2)
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
  }
  const earClip = (k, b, n2) => {
    if (n2 > _ear.length) { _fillPushFlat(k, b, n2); return }
    for (let i = 0; i < n2; i++) _ear[i] = i
    let m = n2, area2 = 0
    for (let i = 0; i < n2; i++) { const a = i * 6, c2 = ((i + 1) % n2) * 6; area2 += b[a] * b[c2 + 1] - b[c2] * b[a + 1] }
    const ccw = area2 > 0
    while (m > 3) {
      let cut = -1
      for (let i = 0; i < m && cut < 0; i++) {
        const i0 = _ear[(i + m - 1) % m], i1 = _ear[i], i2 = _ear[(i + 1) % m]
        const a = i0 * 6, b2 = i1 * 6, c2 = i2 * 6
        const cr = (b[b2] - b[a]) * (b[c2 + 1] - b[a + 1]) - (b[b2 + 1] - b[a + 1]) * (b[c2] - b[a])
        if (ccw ? !(cr > 0) : !(cr < 0)) continue
        let ok2 = true
        for (let j = 0; j < m && ok2; j++) { const p = _ear[j]; if (p !== i0 && p !== i1 && p !== i2 && _inTri(b, p, i0, i1, i2)) ok2 = false }
        if (!ok2) continue
        cut = i
        _fillPush3(k, b[a], b[a + 1], b[b2], b[b2 + 1], b[c2], b[c2 + 1])
        for (let j = i; j < m - 1; j++) _ear[j] = _ear[j + 1]
        m--
      }
      if (cut < 0) break
    }
    const o = _ear[0] * 6
    for (let i = 1; i < m - 1; i++) { const a = _ear[i] * 6, c2 = _ear[i + 1] * 6; _fillPush3(k, b[o], b[o + 1], b[a], b[a + 1], b[c2], b[c2 + 1]) }
  }
  // 把带弧点的填充多边形推进第 k 档：下弦（档 k）与上弦（档 k+1）各看一次——弧鼓进本档 → 在弦上按序插入全部弧点
  // 开凹口（扇心取离弦最远的那个弧点并转到 0 号：3D 扇形三角化以 0 号为扇心；校验不过走耳切）；
  // 弧鼓向邻档 → 弦与弧之间的薄片，以 P 为扇心的三角带归本档。相邻两档对同一条弦一个开凹口一个得薄片 →
  // 仍是无重叠的划分，边界 = P–a₁–…–Q = 等值线。
  const pushBand = (k, src, len, isB, m0, m1) => {
    let buf = src, n = len, notch = -1, notches = 0, arcs1 = false
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1 && k >= nb - 1) continue
      const kk = pass === 0 ? k : k + 1
      const cnt = midRange(m0, m1, isB, kk); if (!cnt || cnt > ARC_CAP) continue
      const q = _mr0, L = levelsAsc[kk]
      const ia = chordAt(buf, n, L); if (ia < 0) continue      // 先看本多边形有没有这条弦，再算弧点位置（掠地格子逐点求交不便宜）
      if (!arcPos(cnt, isB)) continue
      const ib = (ia + 1) % n
      const rev = arcRev(buf[ia * 6], buf[ia * 6 + 1], buf[ib * 6], buf[ib * 6 + 1], cnt)
      if (pass === 0 ? rMs[q] === 1 : rMs[q] === 0) {                 // 弧鼓进本档 → 在 ia 之后按序插入弧点
        const ax0 = buf[ia * 6], ay0 = buf[ia * 6 + 1], ex = buf[ib * 6] - ax0, ey = buf[ib * 6 + 1] - ay0   // 弦向：插点前先取（插点会把 Q 往后挪）
        if (buf === src) { for (let i = 0; i < n * 6; i++) _bgN[i] = src[i]; buf = _bgN }
        for (let i = n * 6 - 1; i >= (ia + 1) * 6; i--) _bgN[i + cnt * 6] = _bgN[i]
        for (let j = 0; j < cnt; j++) {
          const w = (ia + 1 + j) * 6, a2 = (rev ? cnt - 1 - j : j) * 5
          _bgN[w] = _arcP[a2]; _bgN[w + 1] = _arcP[a2 + 1]; _bgN[w + 2] = L; _bgN[w + 3] = _arcP[a2 + 2]; _bgN[w + 4] = _arcP[a2 + 3]; _bgN[w + 5] = _arcP[a2 + 4]
        }
        n += cnt
        notches++
        // 扇心：只有一个弧点时就取它（凸多边形挖一个凹角，以凹角为扇心恒合法，与 09-16 起的做法逐位相同）；
        // 弧点 ≥ 2 时不行 —— 弧点彼此相邻且都凹向多边形内侧，以其中任何一个为扇心，最后一个扇形三角形
        //（扇心, 前一个弧点的前驱, 前一个弧点）会翻到弧外，3D 会画出多边形外的一块。改取【离弦最远的顶点】。
        if (cnt === 1 && notches === 1) { notch = ia + 1; arcs1 = true }
        else {
          let far = -1, farD = -1
          for (let i = 0; i < n; i++) {
            const d2 = Math.abs((buf[i * 6] - ax0) * ey - (buf[i * 6 + 1] - ay0) * ex)
            if (d2 > farD) { farD = d2; far = i }
          }
          notch = far
        }
      } else {                                                        // 薄片：以 P 为扇心的三角带
        let px = buf[ia * 6], py = buf[ia * 6 + 1]
        for (let j = 0; j < cnt; j++) {
          const a2 = (rev ? cnt - 1 - j : j) * 5
          if (j > 0) _fillPush3(k, buf[ia * 6], buf[ia * 6 + 1], px, py, _arcP[a2], _arcP[a2 + 1])
          px = _arcP[a2]; py = _arcP[a2 + 1]
        }
        _fillPush3(k, buf[ia * 6], buf[ia * 6 + 1], px, py, buf[ib * 6], buf[ib * 6 + 1])
      }
    }
    if (notch < 0) { _fillPushFlat(k, buf, n); return }
    // 同向 ⇔ 扇形三角形面积和 = 多边形面积 ⇔ 不重叠且恰好铺满；不过就换个顶点试，全不行才耳切
    if (!(notches === 1 && arcs1) && !fanOk(buf, n, notch)) { notch = -1; for (let i = 0; i < n && notch < 0; i++) if (fanOk(buf, n, i)) notch = i }
    if (notch >= 0) _fillPushFlatRot(k, buf, n, notch)
    else earClip(k, buf, n)
  }
  const useHull = !!(hull && hull.ring && hull.ring.length >= 3)
  // 带多边形上的地平边（两端 m === 0；凸多边形被 m ≥ 0 半平面裁只会切出一条）换成 hull 环上落在两端之间的弧点：
  // 外缘仍是密采样的平滑地平弧，而带边界与等值线由构造重合。旧路把整三角形裁到 hull，弦的方向来自延伸到地平外的
  // 「垂足」假坐标，且跳过弦中点 —— 线顶点到填充边中位 34 km / p95 354 km。
  // 取弧点按「绕星下点的极角」：hull 是包住星下点的凸环，极角沿环单调，两端极角之间的那些顶点就是这段弧。
  // 环上按极角取点：a = 绕星下点的极角 → 该射线与环边的交点 [u, lat]（环凸且包住原点 → 恰一个交点），写 _rs
  const _rs = new Float64Array(2)
  const ringAt = (ring, ang, nh, a) => {
    for (let i = 0; i < nh; i++) {
      const j = (i + 1) % nh
      let w = ang[j] - ang[i]; while (w <= 0) w += 2 * Math.PI
      let t = a - ang[i]; while (t < 0) t += 2 * Math.PI; while (t >= 2 * Math.PI) t -= 2 * Math.PI
      if (t <= w) {
        const A = ring[i], B = ring[j], dx = Math.cos(a), dy = Math.sin(a)
        const den = (B[0] - A[0]) * dy - (B[1] - A[1]) * dx
        const f = den !== 0 ? -(A[0] * dy - A[1] * dx) / den : 0
        _rs[0] = A[0] + (B[0] - A[0]) * f; _rs[1] = A[1] + (B[1] - A[1]) * f
        return true
      }
    }
    return false
  }
  const _arcI = [], _arcT = []
  const limbArc = (src, len, dst) => {
    let ia = -1
    for (let i = 0; i < len; i++) { const j = (i + 1) % len; if (src[i * 6 + 3] === 0 && src[j * 6 + 3] === 0) { ia = i; break } }
    if (ia < 0) return 0
    const ring = hull.ring, nh = ring.length, ref = hull.satLon
    let ang = hull._ang
    if (!ang || ang.length !== nh) { ang = hull._ang = new Float64Array(nh); for (let i = 0; i < nh; i++) ang[i] = Math.atan2(ring[i][1], ring[i][0]) }
    const ib = (ia + 1) % len
    const a0 = Math.atan2(src[ia * 6 + 1], wrap180(src[ia * 6] - ref))
    const a1 = Math.atan2(src[ib * 6 + 1], wrap180(src[ib * 6] - ref))
    let o = 0
    for (let i = 0; i < len; i++, o++) for (let c = 0; c < 6; c++) dst[o * 6 + c] = src[i * 6 + c]
    // ★ 地平边的两个端点先【贴到环上】：半平面裁剪出的地平交点按线性 m 取，位置落在真地平里侧（实测仰角
    //   0.1~0.46°），而环上弧点在地平上 —— 不贴就是一排锯齿（2026-09-22 用户「填充还不如之前」的根因）。
    //   贴法＝沿该点的极角射线取环边交点，只动 x,y（d / m / u / v 不变）。等值线的地平端点仍走 limbEnd
    //  （真地平，离环 ≤ 0.11°），线端与填充角的差回到 09-16 之前那一档。
    const xa = src[ia * 6]
    const snap = (idx, a) => {
      if (!ringAt(ring, ang, nh, a)) return
      let l = _rs[0] + ref; while (l - xa > 180) l -= 360; while (l - xa < -180) l += 360
      dst[idx * 6] = l; dst[idx * 6 + 1] = _rs[1]
    }
    snap(ia, a0); snap(ib, a1)
    let dA = a1 - a0; while (dA > Math.PI) dA -= 2 * Math.PI; while (dA <= -Math.PI) dA += 2 * Math.PI
    const span = Math.abs(dA); if (!(span > 1e-9)) return o
    const dir = dA > 0 ? 1 : -1
    _arcI.length = 0; _arcT.length = 0
    for (let i = 0; i < nh; i++) {
      let t = (ang[i] - a0) * dir; while (t < 0) t += 2 * Math.PI; while (t >= 2 * Math.PI) t -= 2 * Math.PI
      if (t > 1e-9 && t < span - 1e-9) { _arcI.push(i); _arcT.push(t / span) }
    }
    const na = _arcI.length
    if (!na) return o
    if (len + na > _BG_CAP) return 0
    for (let i = 1; i < na; i++) { const t = _arcT[i], v = _arcI[i]; let j = i - 1; while (j >= 0 && _arcT[j] > t) { _arcT[j + 1] = _arcT[j]; _arcI[j + 1] = _arcI[j]; j-- } _arcT[j + 1] = t; _arcI[j + 1] = v }
    // 弧点插在 ia 之后：ib > 0 时把 [ib, len) 后移 na 位；ib === 0（地平边是末顶点→首顶点）直接追加在末尾
    if (ib > 0) for (let i = len - 1; i >= ib; i--) for (let c = 0; c < 6; c++) dst[(i + na) * 6 + c] = dst[i * 6 + c]
    const da = src[ia * 6 + 2], dbb = src[ib * 6 + 2], ua = src[ia * 6 + 4], wa = src[ia * 6 + 5]
    const du = src[ib * 6 + 4] - ua, dw = src[ib * 6 + 5] - wa
    for (let i = 0; i < na; i++) {
      const p = ring[_arcI[i]], f = _arcT[i], w = (ia + 1 + i) * 6
      let l = p[0] + ref; while (l - xa > 180) l -= 360; while (l - xa < -180) l += 360
      dst[w] = l; dst[w + 1] = p[1]; dst[w + 2] = da + (dbb - da) * f; dst[w + 3] = 0; dst[w + 4] = ua + du * f; dst[w + 5] = wa + dw * f
    }
    return len + na
  }
  // aug=这格在细化表的 cells 里（三角化循环用指针顺着表判，O(1)）；isB=格内第二个三角形（见 augment）；
  // [m0,m1)=本格的弦中点记录
  const emitTri = (i0, i1, i2, aug, isB, m0, m1) => {
    if (!loadTri(i0, i1, i2, isB)) return
    const crossLimb = _bgBase[3] < 0 || _bgBase[9] < 0 || _bgBase[15] < 0
    // 该三角形 dB∈[dmin,dmax] 只可能与 [kLo,kHi] 档相交（其余档裁空/裁满，纯属浪费）→ 二分定位后只遍历这几档。
    // 电平多时这是关键提速：把每三角形的 O(nb) 裁剪降到 O(相交档数)（通常 1~3 档）。kLo/kHi 同时用于填充与等值线。
    const dmin = Math.min(_bgBase[2], _bgBase[8], _bgBase[14]), dmax = Math.max(_bgBase[2], _bgBase[8], _bgBase[14])
    const kHi = upperBound(levelsAsc, nb, dmax) - 1                       // 最高一档 Lk ≤ dmax（loadTri 已保证 dmax ≥ L0 → kHi ≥ 0）
    const kLo = Math.max(0, upperBound(levelsAsc, nb, dmin) - 1)         // 最低相交档：低于此的档上边界 Lk+1 ≤ dmin，整体在三角形外
    // 交点细化：各档在三条边上的交点插成顶点（凸性不变；dmin/dmax/crossLimb 已按三个角取好）
    const len = aug ? augment(i0, i1, i2, isB) : 3
    const hasM = aug && m1 > m0
    // 线基底：跨地平时沿 0°仰角线半平面裁（等值线不溢出地平）；线不依赖 hull。
    let lineBase = _bgBase, lineLen = len
    if (crossLimb) { lineLen = clip(_bgBase, len, 3, 0, true, _bgVis); lineBase = _bgVis }
    if (wantFills) {
      // 填充基底：跨地平时与等值线同一份「按 m ≥ 0 精确裁」的基底（lineBase），逐档裁 + 弦中点照常；
      // 有平滑地平弧(hull) 时最后把带多边形的地平边换成环上弧点 → 外缘仍是平滑地平弧，带边界与线由构造重合。
      const fb = crossLimb ? lineBase : _bgBase
      const fbLen = crossLimb ? lineLen : len
      const wantArc = crossLimb && useHull
      if (fbLen >= 3) for (let k = kLo; k <= kHi; k++) {
        let bl = clip(fb, fbLen, 2, levelsAsc[k], true, _bgP, crossLimb)          // d ≥ Lk
        let cur = _bgP
        if (k < nb - 1 && bl) { bl = clip(_bgP, bl, 2, levelsAsc[k + 1], false, _bgQ, crossLimb); cur = _bgQ }  // 且 d ≤ Lk+1（顶档不封顶）
        if (bl < 3) continue
        if (wantArc) { const na = limbArc(cur, bl, _bgA); if (na >= 3) { cur = _bgA; bl = na } }
        if (hasM) pushBand(k, cur, bl, isB, m0, m1)
        else if (!wantArc || fanOk(cur, bl, 0)) _fillPushFlat(k, cur, bl)   // 端点贴环后可能微凹：扇形不合法就耳切
        else earClip(k, cur, bl)
      }
    }
    if (lineLen >= 3) for (let k = kLo; k <= kHi; k++) {              // 各档等值线 = lineBase 上 d==Lk 的穿越段（仅相交档）
      const L = levelsAsc[k]
      let cnt = 0, x0 = 0, y0 = 0, x1 = 0, y1 = 0, exact = 0
      for (let i = 0; i < lineLen; i++) {
        const ai = i * 6, bi = ((i + 1) % lineLen) * 6
        const da = lineBase[ai + 2], dbb = lineBase[bi + 2]
        if ((da < L) !== (dbb < L)) {
          let x, y
          if (dbb === L) { x = lineBase[bi]; y = lineBase[bi + 1]; exact++ }   // 交点就是细化顶点本身 → 取同一坐标（逐位）
          else if (da === L) { x = lineBase[ai]; y = lineBase[ai + 1]; exact++ }
          else {
            const s = (L - da) / (dbb - da)
            if (limbSolve && lineBase[ai + 3] === 0 && lineBase[bi + 3] === 0) {   // 档线的地平端点：拉到真实地平线与等值面的交点
              const eu = lineBase[bi + 4] - lineBase[ai + 4], ev = lineBase[bi + 5] - lineBase[ai + 5]
              const r = limbEnd(lineBase[ai + 4] + eu * s, lineBase[ai + 5] + ev * s, eu, ev, L)
              const ax = _bgBase[0]; let l = r[0], yy = r[1]
              // 有 hull（3D / 导出）时端点再贴到环上：填充的地平角点在 limbArc 里同样贴环 → 线端与填充角逐位同一点
              if (useHull) { const rg = hull.ring, ref = hull.satLon; let ang = hull._ang; if (!ang || ang.length !== rg.length) { ang = hull._ang = new Float64Array(rg.length); for (let i2 = 0; i2 < rg.length; i2++) ang[i2] = Math.atan2(rg[i2][1], rg[i2][0]) } if (ringAt(rg, ang, rg.length, Math.atan2(yy, wrap180(l - ref)))) { l = _rs[0] + ref; yy = _rs[1] } }
              while (l - ax > 180) l -= 360; while (l - ax < -180) l += 360
              x = l; y = yy
            } else { x = lineBase[ai] + (lineBase[bi] - lineBase[ai]) * s; y = lineBase[ai + 1] + (lineBase[bi + 1] - lineBase[ai + 1]) * s }
          }
          if (cnt === 0) { x0 = x; y0 = y } else { x1 = x; y1 = y }
          cnt++
        }
      }
      if (cnt === 2) {                                                  // 凸多边形上恰 0 或 2 个穿越
        // 两端都是细化顶点且本三角形本档有弦中点（且未越地平）→ 画 P–M–Q，与填充的凹口 / 薄片边界同一批点
        if (hasM && exact === 2) {
          const cnt = arcOf(m0, m1, isB, k)
          if (cnt) {
            const rev = arcRev(x0, y0, x1, y1, cnt)
            let px = x0, py = y0
            for (let j = 0; j < cnt; j++) {
              const a2 = (rev ? cnt - 1 - j : j) * 5
              lines[k].push([[px, py], [_arcP[a2], _arcP[a2 + 1]]])
              px = _arcP[a2]; py = _arcP[a2 + 1]
            }
            lines[k].push([[px, py], [x1, y1]])
            continue
          }
        }
        lines[k].push([[x0, y0], [x1, y1]])
      }
    }
  }
  // 格子范围：box 给定则限于热区（点投影也只在此区，索引一致）；否则全网格。
  const rA = box ? box.r0 : 0, rB = box ? Math.min(box.r1, NY - 1) : NY - 1
  const cA = box ? box.c0 : 0, cB = box ? Math.min(box.c1, NX - 1) : NX - 1
  // 降采样：以 st 为步长跨格三角化，末格夹到边界以铺满整个区域（场值在四角间线性插值 → 等值线更粗但连续）。
  // 细化：格子按行主序、i00 单调递增，指针 rp 顺着 rf.cells（升序）走，每格 O(1) 判要不要插点。
  const rCells = rf ? rf.cells : null, nrc = rf ? rf.cells.length : 0
  let rp = 0
  for (let row = rA; row < rB; row += st) {
    const r2 = Math.min(row + st, rB)
    for (let col = cA; col < cB; col += st) {
      const c2 = Math.min(col + st, cB)
      const i00 = row * NX + col, i10 = row * NX + c2, i01 = r2 * NX + col, i11 = r2 * NX + c2
      _cc[0] = col; _cc[1] = row; _cc[2] = c2; _cc[3] = r2
      let aug = false, m0 = 0, m1 = 0
      if (rf) { while (rp < nrc && rCells[rp] < i00) rp++; aug = rp < nrc && rCells[rp] === i00; if (aug && rMoff) { m0 = rMoff[rp]; m1 = rMoff[rp + 1] } }
      emitTri(i00, i10, i11, aug, false, m0, m1); emitTri(i00, i11, i01, aug, true, m0, m1)   // 沿 a–c 对角线三角化（填充/线同源）
    }
  }
  // 各档 scratch 一次性拷成定长返回缓冲（每帧仅 ~2·nb 次分配）。空档返回共享空数组，免分配。
  const fills = new Array(nb)
  for (let k = 0; k < nb; k++) {
    const n = _fillBufN[k] || 0, m = _fillCntN[k] || 0
    fills[k] = { verts: n ? _fillBuf[k].slice(0, n) : _EMPTY_F64, counts: m ? _fillCnt[k].slice(0, m) : _EMPTY_I32 }
  }
  return { fills, lines }
}

// 相对峰值电平 → 绝对电平（rel 一般为负，如 [-1,-2,-3,-4,-5]）
export const relLevels = (max, rels) => rels.map((r) => max + r)

// 把某电平的 marching-squares 线段拼成连通链（端点量化匹配）。用于「分带填充多边形」与
// 数值标签 / 导出，使填充边界与等值线由同一组线段构成 → 填充与线精确重合、无网格毛刺。
// 双向拼链：起始段先从 s[1] 向前走到断头或闭合；未闭合再从 s[0] 向后走，反转后前插。
// 只向前走的老做法会把开口链（被地平 / 热区盒切断的等值线）剥成十几段（起始段取「行主序第一条未用段」，
// 通常落在链的中段），下游“一环一标签”于是一档印十几遍。闭合环输出与老实现逐位相同（先走的那一圈完全一致）。
export function stitchLoops(segs) {
  if (!segs || !segs.length) return []
  const key = (p) => Math.round(p[0] * 20000) + ',' + Math.round(p[1] * 20000)
  const ends = new Map()
  segs.forEach((s, i) => { for (const p of s) { const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i) } })
  const used = new Uint8Array(segs.length), loops = []
  // 从端点 k0 顺未用段一直走，逐点推进 acc；踩到 stopK 返回 true（闭合），走到断头返回 false。
  const walk = (k0, stopK, acc) => {
    let k = k0
    for (let g = 0; g < segs.length; g++) {
      let nj = -1
      for (const j of (ends.get(k) || [])) { if (!used[j]) { nj = j; break } }
      if (nj < 0) return false
      used[nj] = 1
      const s = segs[nj], next = key(s[0]) === k ? s[1] : s[0]
      acc.push(next); k = key(next)
      if (k === stopK) return true
    }
    return false
  }
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = 1
    const fwd = [segs[i][0], segs[i][1]]
    if (walk(key(segs[i][1]), key(segs[i][0]), fwd)) { loops.push(fwd); continue }
    const back = []
    walk(key(segs[i][0]), '', back)      // '' 永不匹配任何量化键 → 走到断头为止
    loops.push(back.reverse().concat(fwd))
  }
  return loops
}

// ===== 等值线环上的取点（数值标签锚点用；对地 useGrdCoverage 与对星 useShellCoverage 共用一份）=====
// 经度差（跨 ±180 取最短）：环点用经纬度平面近似度量（覆盖等值线是局部区域，够用）。
export const dLon = (a, b) => { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d }
// 一条等值线（点链）的最上端点（纬度最大）：数值标签【默认】锚点，与 GXT「每条等值线取 top 标一次」一致
export function loopTop(pts) {
  let best = pts[0]
  for (const p of pts) if (p[1] > best[1]) best = p
  return best
}
// 环总弧长（度，经纬度平面近似）
export function loopLen(loop) {
  let s = 0
  for (let i = 1; i < loop.length; i++) { const dx = dLon(loop[i][0], loop[i - 1][0]), dy = loop[i][1] - loop[i - 1][1]; s += Math.hypot(dx, dy) }
  return s
}
// 环上「弧长比例 t」处的点 [lon,lat]（越界 t 环绕；退化环回退 loopTop）
export function loopPointAtFraction(loop, t) {
  const total = loopLen(loop); if (!(total > 0) || loop.length < 2) return loopTop(loop)
  const target = (((t % 1) + 1) % 1) * total
  let acc = 0
  for (let i = 1; i < loop.length; i++) {
    const dx = dLon(loop[i][0], loop[i - 1][0]), dy = loop[i][1] - loop[i - 1][1], seg = Math.hypot(dx, dy)
    if (acc + seg >= target) { const f = seg > 0 ? (target - acc) / seg : 0; return [wrap180(loop[i - 1][0] + dx * f), loop[i - 1][1] + dy * f] }
    acc += seg
  }
  return loop[loop.length - 1]
}
// 沿线按间隔重复数值标签（SATSOFT Contour Labels 的 Interval，单位＝标签宽）。
// loop 折线点串；wDeg 一个标签在图面上的宽度（度）；k 间隔＝几个标签宽。返回锚点数组。
// 闭合环按 n 等分（首个落在半格处，接缝上不压字）；开口链首尾各让出半个余量，标签不贴到断头上。
// 线比一个间隔还短 → 只在中点标一个（一条线总得认得出是哪一档）。
export function loopLabelsAtInterval(loop, wDeg, k) {
  if (!loop || loop.length < 2) return []
  const total = loopLen(loop), step = Math.max(1e-9, (+wDeg || 0) * (+k || 0))
  if (!(total > 0)) return []
  // 上限 200：标签宽给 0（或间隔给 0）时 step 落到下限，不设上限会当场要几百亿个点
  const n = Math.min(200, Math.floor(total / step))
  if (n < 1) return [loopPointAtFraction(loop, 0.5)]
  const a = loop[0], b = loop[loop.length - 1]
  const closed = Math.abs(dLon(a[0], b[0])) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9
  const out = []
  if (closed) { for (let i = 0; i < n; i++) out.push(loopPointAtFraction(loop, (i + 0.5) / n)) }
  else { const pad = (total - (n - 1) * step) / 2; for (let i = 0; i < n; i++) out.push(loopPointAtFraction(loop, (pad + i * step) / total)) }
  return out
}
// 点 p={lon,lat} 到环的最近投影所对应的「弧长比例 t」（拖拽时把指针吸附到线上）
export function nearestFractionOnLoop(loop, p) {
  const total = loopLen(loop); if (!(total > 0) || loop.length < 2) return 0
  let best = Infinity, bestAcc = 0, acc = 0
  for (let i = 1; i < loop.length; i++) {
    const ax = loop[i - 1][0], ay = loop[i - 1][1], dx = dLon(loop[i][0], ax), dy = loop[i][1] - ay, seg2 = dx * dx + dy * dy
    let f = seg2 > 0 ? (dLon(p.lon, ax) * dx + (p.lat - ay) * dy) / seg2 : 0
    f = Math.max(0, Math.min(1, f))
    const ex = dLon(p.lon, ax + dx * f), ey = p.lat - (ay + dy * f), d2 = ex * ex + ey * ey
    if (d2 < best) { best = d2; bestAcc = acc + Math.hypot(dx, dy) * f }
    acc += Math.hypot(dx, dy)
  }
  // 夹到 <1：开口环（被地平/热区盒裁断）投影到末端时比例会恰为 1，而 loopPointAtFraction 对 t=1 取模回到环首 → 标签瞬移。
  return Math.min(bestAcc / total, 0.999999)
}
// 多档同心环的标签默认锚点：单档取环最上端点（顶部，旧行为不变）；多档按档序沿环错开 (i+0.5)/n，
// 避免各档标签都堆在顶端叠成一列（看着像「统一」、还分不开）——错开后各档天然散开、可分别就近抓取。
export function loopLabelAnchor(loop, i, n) {
  return n > 1 ? loopPointAtFraction(loop, (i + 0.5) / n) : loopTop(loop)
}
