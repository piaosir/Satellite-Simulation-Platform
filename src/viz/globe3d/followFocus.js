// 跟随卫星时【主星】自己的聚焦几何（轨道线 / 覆盖锥）：以主星锚点为原点的相对坐标（RTC，场景单位）。
// 全程 double，减完锚点才落 float32 —— 离主星几十米的近景里，相对坐标的 float32 精度是微米级。
//
// 为什么要单独一份（2026-09-25 用户实拍：跟随后轨道线是一条不穿过卫星的偏移竖线，覆盖锥整只不见）：
//   ① 跟随时相机离主星只有几十米，地球那一趟的近裁剪面却在 25–450 km（见 modelLayer 的 driver.apply）——
//      主星附近那一截（轨道线穿星而过的那段、覆盖锥锥顶那段）整段落在近裁剪面以内被裁掉；剩下远处那截按透视
//      落在轨道面的消失线上，相机不在轨道面里就偏在卫星一侧。覆盖锥剩下的那截从锥顶旁边看是「母线朝着自己」，缩成锥底一圈。
//   ② 就算不裁，场景顶点是 float32 绝对坐标：GEO 半径 6.6 处一个 ulp ≈ 3 m，GPU 里 MV 变换再放大，几十米的近景里是十几度的角误差。
//   ③ 缓存的轨道圈（focusGeomCache.ringSegments）按弦垂 ≤ 0.003 个地球半径（19 km）分段 —— 整球视图里不到 1 px，
//      从主星自己身上看却是几十像素的折角，而且主星不在折线上（它落在某条弦的中段）。
// 画法（两段，同一份顶点）：远于地球相机近裁剪面的那截在地球那一趟画（scene.setFollowOrbit：RTC 物体，受地球遮挡；
// 轨道线顶替环组里主选那条 orbP，覆盖锥远端照旧由聚焦几何 Worker 画）；近的那截在模型层局部那一趟画（米制 L 系，
// 与模型同一深度缓冲，按同一张近裁剪平面切开，见 modelLayer 的 follow(state.near) / setNear）。接缝处两边是同一批顶点、同一张平面。
import * as THREE from 'three'
import sat from '../constellation/satellite.js'
import { posAt, periodMinOf, validSpan } from '../constellation/satPos.js'
import { footprintRing } from '../constellation/focusFootprint.js'
import { llaToVec, pushDashed, emitCone, createSink, LIFT } from './focusLanes.js'

// 轨道线采样：时间偏移按 ±(k/K)²·半窗取。圆轨道角速度恒定，从主星看第 k 段弦偏离真轨道的角度 ≈ Δθ²/(8θ) = π/(2K²)，
// 与 k 无关 —— 离主星越近越密，远处的弦再长，从主星看也一样平。每段再取中点实推一次：中点留作顶点（白算不扔），
// 中点离弦的角度（从主星看）超过门限的段继续二分 —— 大偏心轨道（Molniya / GTO）近地点段角速度快，靠这一步补密。
// 圆轨道：2K 个初始点 + 2K 个中点，角误差 π/(2·(2K)²) ≈ 1e-4 rad（42° 视场、745 px 高约 0.1 px），每拍约 0.5 ms。
export const ORB_K = 64
export const ORB_EPS = 2.5e-4
const ORB_DEPTH = 10

// 点 m 到弦 ab 的距离
function devToChord(m, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z
  const L2 = abx * abx + aby * aby + abz * abz
  let u = L2 > 0 ? ((m.x - a.x) * abx + (m.y - a.y) * aby + (m.z - a.z) * abz) / L2 : 0
  u = Math.max(0, Math.min(1, u))
  const dx = m.x - (a.x + u * abx), dy = m.y - (a.y + u * aby), dz = m.z - (a.z + u * abz)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * 主星轨道的两支折线（自主星起，一支向后推、一支向前推），各一个 THREE.Vector3 数组（场景单位，绝对坐标，double）。
 * 整条轨道都按【本拍】的地球转角 gmst 换到地固 —— 即惯性系轨道冻结在本拍，与轨道圈缓存 + 整组旋转同一口径；
 * 映射与锚点同一份算式（llaToVec(大地纬经高)），故两支首点就是锚点本身。
 * @param x 主星（条目或传播体，satPos.propOf 两种都认）
 * @param tMs 主星本拍时刻（合成星为场景历元口径的那一刻 —— 与锚点同一时刻）
 * @param gmst 同一时刻的 GMST（rad）
 * @param anchor [x,y,z] 主星锚点（modelLayer.satStateAt 的 anchor）
 * @returns {[THREE.Vector3[], THREE.Vector3[]]|null} [向前, 向后]
 */
export function followOrbitBranches(x, tMs, gmst, anchor, K = ORB_K, eps = ORB_EPS) {
  if (!x || !Array.isArray(anchor) || !anchor.every(Number.isFinite)) return null
  const A = new THREE.Vector3(anchor[0], anchor[1], anchor[2])
  // 窗口：有周期 → 前后各半个周期（合起来恰一整圈，收口缝落在主星对面）；星历表估不出周期 → 表的整段；表另夹在有效时段内
  const pm = periodMinOf(x), sp = validSpan(x)
  let fwd = 0, back = 0
  if (pm > 0) fwd = back = pm * 30000
  else if (sp) { fwd = sp.t1 - tMs; back = tMs - sp.t0 }
  if (sp) { fwd = Math.min(fwd, sp.t1 - tMs); back = Math.min(back, tMs - sp.t0) }
  const at = (ms) => {
    const pv = posAt(x, new Date(ms))
    if (!pv || !pv.position) return null
    const gd = sat.eciToGeodetic(pv.position, gmst)
    const v = llaToVec(sat.degreesLat(gd.latitude), sat.degreesLong(gd.longitude), gd.height)
    return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) ? v : null
  }
  // (ta, a) → (tb, b) 之间：取中点实推；离弦（从主星看）超门限就两半各自再分。中点恒留作顶点
  const refine = (ta, a, tb, b, out, depth) => {
    if (depth >= ORB_DEPTH) return
    const tm = (ta + tb) / 2
    const m = at(tm)
    if (!m) return
    const bad = devToChord(m, a, b) > eps * Math.max(m.distanceTo(A), 1e-12)
    if (bad) refine(ta, a, tm, m, out, depth + 1)
    out.push(m)
    if (bad) refine(tm, m, tb, b, out, depth + 1)
  }
  const branch = (sign, span) => {
    const out = [A]
    if (!(span > 0)) return out
    let ta = tMs, a = A
    for (let k = 1; k <= K; k++) {
      const tb = tMs + sign * span * (k / K) * (k / K)
      const b = at(tb)
      if (!b) continue   // 这一刻推不出（星历表边缘 / 衰减）：跳过，下一点照连
      refine(ta, a, tb, b, out, 0)
      out.push(b); ta = tb; a = b
    }
    return out
  }
  return [branch(1, fwd), branch(-1, back)]
}

// 顶点收集器（push3 / push6 同 createSink）：进来的是绝对坐标（double），先减锚点再落 float32
export function relSink(A) {
  const s = createSink(4096)
  const ax = A.x, ay = A.y, az = A.z
  return {
    s,
    push3(x, y, z) { s.push3(x - ax, y - ay, z - az) },
    push6(x, y, z, u, v, w) { s.push6(x - ax, y - ay, z - az, u - ax, v - ay, w - az) },
    out() { return s.n ? s.a.slice(0, s.n) : null }
  }
}

/**
 * 主星一拍的聚焦几何（相对锚点，场景单位的 Float32Array；没有的项为 null）：
 *   orb  轨道线线段对（两支各自从主星起切虚线 —— 虚线相位钉在主星上，主星恒落在一段「画」上）
 *   gen  覆盖锥母线线段对；face 覆盖锥锥面三角形（与聚焦几何 Worker 同一份 emitCone、同一圈足迹 → 近远两截接得上）
 * @param x 主星；t 本拍时刻（Date，合成星给场景历元口径的那一刻）；g 同一时刻 GMST；anchor 锚点（同一时刻）
 * @param o { orbOn, orbDash, coneOn, faceOn, genCount, genDash, fp:{mode,beamDeg,elevDeg}, fpSeg }
 *          fp / fpSeg 必须与这一拍喂给聚焦几何 Worker 的相同（页面 fpOptNow() / focusLod(n).fpSeg）
 */
export function followFocusGeom(x, t, g, anchor, o) {
  if (!x || !(t instanceof Date) || !Number.isFinite(g) || !Array.isArray(anchor) || !anchor.every(Number.isFinite)) return null
  const A = new THREE.Vector3(anchor[0], anchor[1], anchor[2])
  const res = { orb: null, gen: null, face: null }
  if (o.orbOn) {
    const br = followOrbitBranches(x, t.getTime(), g, anchor)
    if (br) {
      const s = relSink(A)
      for (const pts of br) if (pts.length > 1) pushDashed(s, pts, o.orbDash)
      res.orb = s.out()
    }
  }
  if (o.coneOn && (o.faceOn || o.genCount > 0)) {
    const pv = posAt(x, t)
    if (pv && pv.position) {
      const gd = sat.eciToGeodetic(pv.position, g), h = gd.height
      const ecf = sat.eciToEcf(pv.position, g)
      const ring = h > 0 ? footprintRing([ecf.x, ecf.y, ecf.z], h, o.fpSeg, o.fp) : null
      if (ring && ring.length > 1) {
        const rv = ring.map((q) => llaToVec(q.lat, q.lon, LIFT))
        const face = relSink(A), gen = relSink(A)
        emitCone(A, rv, o, face, gen)   // 锥顶＝锚点本身（Worker 那边是同一式子算出的同一个数）
        res.face = face.out(); res.gen = gen.out()
      }
    }
  }
  return res
}
