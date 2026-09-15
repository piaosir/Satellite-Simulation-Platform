// 城市指向误差框（SATSOFT §4.2.2 Cities · Marker）—— 性能指标表里每座城市在地图上的标记。
//
// 两型对应 SATSOFT 的 Type = rectangular / elliptical, transformable（手册 §4.2.2 原话：矩形「适合只需要一个简单
// 标记来标注城市位置」、边长在透视坐标系里就是 Az / El 度数；「要在任何投影下都看到指向误差的真实轨迹，选椭圆可变形」）：
//   · 椭圆（可变形）＝指向误差的【真实地面轨迹】：把指向该城市的那条射线，按卫星本体的 Az / El 误差扰动一圈
//     （perturbSpacecraft：Yaw 绕天底轴、El 绕东向轴、Az 绕北向轴），射线打到椭球上的落点连起来。与 Min/Max Pointing
//     列走同一套扰动，故表里报的极值正是沿这个轨迹采出来的。在卫星视角里是椭圆，投到地面自然变形（越远越扁、越斜越长）。
//   · 矩形＝【刚性标记】＝★ 屏幕矩形：2D 任何投影档、3D 球面上都画成一个正对屏幕、四边水平竖直的矩形，以城市的屏幕位置
//     为中心。尺寸以等距圆柱为标准：半宽 / 半高＝Az / El 误差按【星下点尺度】折成的地心角（nadirGroundDeg：GEO 0.1° →
//     0.56°）× 当前视图的「像素/度」—— 2D 全部投影档的平面都归一到 W=360，k() 恒为像素/度（flatCoverage.drawCityBoxes）；
//     3D 取星下点处的像素/度、四角每帧按相机重算（scene.rescaleMarkers）。于是同一设置下所有城市同一像素尺寸、任何视图 /
//     投影下同一形状；星下点处矩形与椭圆轨迹恰好同大，离星下点越远真实轨迹越大、矩形不跟（它是标记，不是轨迹）。
//     本模块只给半宽 / 半高（度），不出环。
//     （09-15 第一版取真实轨迹的经纬向包络，尺寸随城市位置变；09-16 第二版是沿经纬线的地理矩形，在 3D 与 Mercator /
//       Robinson / 方位档下弯曲变形 —— 用户以「不同视图 / 投影形状不一致」两次否决，09-16 定为屏幕矩形。）
//   · 半幅 = 输入/2：与 usePerfTable.pointMinMax 一致（输入按全幅误差解释，0.1° → ±0.05°）。
//   · Yaw：手册原话「增大框的尺寸，离天底越远放得越大；框不会显得旋转」——绕天底轴转 ψ，离天底 θ 的方向
//     位移 ≈ θ·ψ，SATSOFT 把它按 RSS 并进两个半轴（各向同性外扩），这里照做；有 yaw 时矩形也随之逐城市放大。
//   · 城市在卫星地平线以外（背面）没有框；椭圆轨迹的某一段越过地平时 projectLimb 落到地平上，不断线。
import { perturbSpacecraft, projectLimb } from './coverage.js'
import { geodeticToEcef, A as RE_EQ } from '../wgs84.js'

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const nrm = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n] }
const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

export const CITY_BOX_ELLIPSE_N = 24     // 椭圆边界采样点数（与 pointMinMax 的 PT_N 同）

// 星下点尺度：卫星（地心距 r）处偏离天底 δ 的射线打到球面，落点离星下点的地心角 γ。三角形（地心 O、卫星 S、落点 P）
// 正弦定理 sin∠P / r = sin δ / R，近侧交点 ∠P 为钝角 → γ = asin(r·sin δ / R) − δ（小角近似 γ ≈ δ·(r−R)/R）。
// R 取赤道半径（矩形只是标记，扁率 0.3% 不值得再走椭球射线）；δ 越过地平（δ > asin(R/r)）钳在切点。
export function nadirGroundDeg(rKm, deltaDeg) {
  if (!(rKm > RE_EQ) || !(deltaDeg > 0)) return 0
  const dl = Math.asin(RE_EQ / rKm)
  const d = Math.min(deltaDeg * D2R, dl)
  return (Math.asin(Math.min(1, rKm * Math.sin(d) / RE_EQ)) - d) * R2D
}

// 一座城市的框。返回 { ring, rect, vis } 或 null（没有框）：
//   椭圆 → ring = [[lon,lat],…]（闭合，首尾同点）、rect = null、vis = 是否整框都在地平内；
//   矩形 → ring = null、rect = { w, h }（半宽 / 半高，度，星下点尺度）、vis = true。
//   basis — 天线基底 { S, x, y, z }（S 卫星 ECEF km）
//   o     — { type:'rect'|'ellipse', az, el, yaw }：三个误差量都是【全幅】(°)
export function cityBoxRing(basis, lon, lat, o) {
  const S = basis.S
  const C = geodeticToEcef(lon, lat, 0)
  const ex = C[0] - S[0], ey = C[1] - S[1], ez = C[2] - S[2]
  const rs = Math.hypot(ex, ey, ez); if (!(rs > 0)) return null
  // 地平判据（与 sampleBeamAt 同口径）：卫星须在测站地方水平面之上
  const clat = Math.cos(lat * D2R), up = [clat * Math.cos(lon * D2R), clat * Math.sin(lon * D2R), Math.sin(lat * D2R)]
  if ((ex * up[0] + ey * up[1] + ez * up[2]) / rs > 0) return null
  const d = [ex / rs, ey / rs, ez / rs]
  let ha = Math.abs(Number(o.az) || 0) / 2, he = Math.abs(Number(o.el) || 0) / 2
  const hy = Math.abs(Number(o.yaw) || 0) / 2
  if (hy > 0) {
    // 离天底角 θ（rad）× yaw 半幅（rad）→ 位移（rad）→ 转回度，RSS 并进两个半轴
    const nad = nrm([-S[0], -S[1], -S[2]])
    const th = Math.acos(Math.max(-1, Math.min(1, dt(d, nad))))
    const psi = th * (hy * D2R) * R2D
    ha = Math.hypot(ha, psi); he = Math.hypot(he, psi)
  }
  if (!(ha > 0) && !(he > 0)) return null
  if (o.type !== 'ellipse') {
    // 矩形：刚性屏幕标记，只给半宽 / 半高（度，星下点尺度），四角由渲染端按当前视图的像素/度现算
    const r = Math.hypot(S[0], S[1], S[2])
    return { ring: null, rect: { w: nadirGroundDeg(r, ha), h: nadirGroundDeg(r, he) }, vis: true }
  }
  // 椭圆：真实轨迹，逐扰动打地面
  const dir = [dt(d, basis.x), dt(d, basis.y), dt(d, basis.z)]   // 该方向在天线系里的方向余弦（扰动前后不变）
  const ring = []
  let vis = true
  for (let i = 0; i < CITY_BOX_ELLIPSE_N; i++) {
    const t = 2 * Math.PI * i / CITY_BOX_ELLIPSE_N, daz = ha * Math.cos(t), del = he * Math.sin(t)
    const b = (daz || del) ? perturbSpacecraft(basis, daz, del, 0) : basis
    const p = projectLimb(dir, b)
    if (!p) return null
    if (p.vis < 0) vis = false
    ring.push([p.lon, p.lat])
  }
  ring.push([ring[0][0], ring[0][1]])
  return { ring, rect: null, vis }
}

// 一根天线的整层：逐城市出框与标签。stations = [{ id, city, desig, lon, lat }]；opts = 该表的选项
// （cityMarkOn / cityMarkType / cityLabelOn / cityLabelType / pointAz / pointEl / pointYaw …）。
// 只出数据，不碰渲染器：2D / 3D 各自按 markOn / labelOn 决定画哪些；rect 与 ring 二选一（矩形只有 rect、椭圆只有 ring）。
export function cityBoxItems(basis, stations, opts, labelOf) {
  const out = []
  if (!basis || !Array.isArray(stations)) return out
  const o = opts || {}
  const spec = { type: o.cityMarkType === 'ellipse' ? 'ellipse' : 'rect', az: o.pointAz, el: o.pointEl, yaw: o.pointYaw }
  const wantRing = o.cityMarkOn !== false
  for (const s of stations) {
    if (!s || !Number.isFinite(s.lon) || !Number.isFinite(s.lat)) continue
    const r = wantRing ? cityBoxRing(basis, s.lon, s.lat, spec) : null
    const text = typeof labelOf === 'function' ? labelOf(s) : ''
    out.push({ id: s.id, lon: s.lon, lat: s.lat, ring: r ? r.ring : null, rect: r ? (r.rect || null) : null, vis: r ? r.vis : true, text: String(text || '') })
  }
  return out
}
