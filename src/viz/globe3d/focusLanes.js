// 聚焦星几何的「顶点级」原语：经纬高 → 场景坐标、虚线切段、覆盖圈填充三角化、覆盖锥锥面三角化。
//
// ★ 从 scene.js 抽出来单独成模块，为的是让【主线程渲染器】与【Worker】跑的是同一份代码 ——
//   两边各写一遍迟早对不上，而这类差异恰恰最难在画面上看出来（几公里的三角形错位谁也发现不了）。
//   .focusharness 的体检脚本也从这里导入，不再靠切 scene.js 的源码文本取函数。
// 纯计算、不碰 DOM/renderer/贴图，可原样在 Worker 里跑（只用到 three 的 Vector3）。
import * as THREE from 'three'

export const RE = 6371
export const LIFT = 12  // 轨迹/足迹抬离地表 ~12km，避免与球面 z-fighting

// 经纬高 → 场景坐标。★ Y 是极轴（不是 Z）：地球自转/轨道圈整组旋转都绕它。
export function llaToVec(latDeg, lonDeg, altKm) {
  const r = (RE + altKm) / RE
  const phi = (90 - latDeg) * Math.PI / 180
  const theta = (lonDeg + 180) * Math.PI / 180
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  )
}

// 顶点收集器：底层是 Float32Array，装不下就翻倍。
// ★ 别用普通数组收顶点：JS 数组元素是 double，聚焦 7000 颗时光覆盖圈填充就有两千五百万个数 ——
//   两百 MB 的临时垃圾。实测填充耗时从 3000 颗的 90 ms 涨到 7000 颗的 420 ms（4.6×，而颗数才 2.3×），
//   涨的那部分全是 GC。换成 Float32Array 之后既省一半内存，又能直接当 transferable 从 Worker 传回来。
// push3/push6 分开写而不用变参：这两个方法一拍要被调几百万次，rest 参数每次都要新建一个数组。
export function createSink(cap = 1024) {
  return {
    a: new Float32Array(cap),
    n: 0,
    grow(need) {
      if (this.n + need <= this.a.length) return
      let c = this.a.length || 1024
      while (c < this.n + need) c *= 2
      const b = new Float32Array(c); b.set(this.a.subarray(0, this.n)); this.a = b
    },
    reserve(n) { if (n > this.a.length) { const b = new Float32Array(n); b.set(this.a.subarray(0, this.n)); this.a = b } },
    push3(x, y, z) { this.grow(3); const a = this.a; let n = this.n; a[n++] = x; a[n++] = y; a[n++] = z; this.n = n },
    push6(x, y, z, u, v, w) { this.grow(6); const a = this.a; let n = this.n; a[n++] = x; a[n++] = y; a[n++] = z; a[n++] = u; a[n++] = v; a[n++] = w; this.n = n },
    view() { return this.a.subarray(0, this.n) },          // 就地视图（喂 three 的 BufferAttribute）
    take() { const b = this.a.buffer.byteLength === this.n * 4 ? this.a : this.a.slice(0, this.n); this.a = new Float32Array(0); this.n = 0; return b }   // 交出所有权（Worker 回传用）
  }
}

export function pushStripSegs(out, pts) {
  for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1]; out.push6(a.x, a.y, a.z, b.x, b.y, b.z) }
}
// 虚线/点线：沿折线按【世界弧长】切段（球半径 1 ≈ 6371 km），与采样密度无关。
// ★ 别退回「隔段取一画一」：那招只在足迹这种固定 72 段等分采样上成立，星下点轨迹走自适应采样
//   （近地点段自动加密），隔段取一会变成长短乱跳的碎线。
export const DASH_SPEC = { dash: [0.018, 0.012], dot: [0.0025, 0.009] }
const _dpA = new THREE.Vector3(), _dpB = new THREE.Vector3()
export function pushDashed(out, pts, kind) {
  const d = DASH_SPEC[kind]
  if (!d) { pushStripSegs(out, pts); return }
  const dl = d[0], gl = d[1]
  let on = true, rem = dl
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1]
    const L = a.distanceTo(b)
    if (!(L > 1e-9)) continue
    let t = 0
    while (t < L - 1e-12) {
      const step = Math.min(rem, L - t)
      if (on) {
        _dpA.copy(a).lerp(b, t / L); _dpB.copy(a).lerp(b, (t + step) / L)
        out.push6(_dpA.x, _dpA.y, _dpA.z, _dpB.x, _dpB.y, _dpB.z)
      }
      t += step; rem -= step
      if (rem <= 1e-12) { on = !on; rem = on ? dl : gl }
    }
  }
}
// 贴地折线的大圆补密：把每段按【大圆】切碎，直到弦垂吃不进地球为止。返回补密后的点列。
// ★ 为什么必须：顶点是三维的，两点之间画的是【直弦】—— 弦垂 = R(1−cos(arc/2))，而贴地那层只抬了
//   LIFT(12 km)＝0.0019 个地球半径，单段弧长一超过 ~6.2° 中部就沉到球面以下，被不透明地球挡掉，
//   整条线碎成一截截短划。触发条件是【聚焦颗数多】：focusLod 把轨迹节拍从 120 采样点降到 24，
//   LEO 相邻星下点差到 14.5°，实测（node .focusharness/sag.mjs）弦最低处沉到地下 39 km、整条线只有
//   24% 露在外面；覆盖圈线同理（fpSeg 摊到 18 段时 GEO 全视场沉 84 km）。
//   2D 平面图画的是经纬度折线，没有这一问题 —— 故这个错只有 3D 看得见。
//   覆盖圈填充与覆盖锥底边早各自补过密（见下面 footprintFill / coneFace 里的同款 ceil(弧/格)），
//   只有【线】这一路一直漏着。覆盖锥母线是真的直线，不走这里。
// ★ 顶点对象复用（与 _dpA/_dpB 同一条理由）：聚焦上千颗时这里每拍要出几十万个点，逐点 new Vector3
//   是几十 MB 的临时垃圾。故返回的数组【下次调用即失效】，调用方必须当场用掉（现有三处都是直接喂 pushDashed）。
export const ARC_CELL = 0.08   // 单段弧长上限(弧度, 4.6°)：弦垂 0.0008 < LIFT，中部仍高出球面 6.9 km（写深度的陆地面 1.0004 之上 4.4 km）
const _dnA = new THREE.Vector3(), _dnB = new THREE.Vector3()
const _dnPool = [], _dnOut = []
export function densifyArc(pts, cell = ARC_CELL) {
  if (!pts || pts.length < 2) return pts
  const out = _dnOut; out.length = 0
  let np = 0
  out.push(pts[0])
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1]
    const ra = a.length() || 1, rb = b.length() || 1
    _dnA.copy(a).divideScalar(ra); _dnB.copy(b).divideScalar(rb)
    const th = Math.acos(Math.max(-1, Math.min(1, _dnA.dot(_dnB))))
    // 上界 π−1e-3：两点近对跖时大圆本就不唯一，slerp 的权重是 0/0 型（相消到只剩噪声），
    // 这种段退回直弦 —— 它穿过地心、本来就整段看不见，比画出一条方向乱掉的线好。
    if (th > cell && th < Math.PI - 1e-3) {
      const k = Math.min(256, Math.ceil(th / cell)), s = Math.sin(th)   // 这一档下 s 不会退化
      for (let j = 1; j < k; j++) {
        const t = j / k, w0 = Math.sin((1 - t) * th) / s, w1 = Math.sin(t * th) / s
        const v = _dnPool[np] || (_dnPool[np] = new THREE.Vector3()); np++
        out.push(v.set(_dnA.x * w0 + _dnB.x * w1, _dnA.y * w0 + _dnB.y * w1, _dnA.z * w0 + _dnB.z * w1)
          .multiplyScalar(ra + (rb - ra) * t))                          // 两端半径不同时线性过渡（贴地线两端等半径，t 项恒为 0）
      }
    }
    out.push(b)
  }
  return out
}
// 覆盖圈填充：以星下点为极点的【极坐标网格】—— 环向沿足迹边、径向由中心到边等分，逐格两个三角形。
// ★ 直接在三维里做，不走经纬度域 earcut：足迹可以跨 ±180°、也可以整个套住极点，这两种在经纬度
//   平面上都会被撕开（陆地/Polygon 那套只对不跨极的多边形成立）。
// ★ 也别用「中心→环」的扇形 + 最长边二分：GEO 那种近半球的足迹，初始三角形是两条 1.3 长边的细长
//   楔子，二分到 0.06 需要十几层，深度封顶时还剩 0.09 的长边 —— 平面塌到 0.97 被地球整片吃掉
//   （实测：16560 个三角形，最深半径 0.970）。极坐标网格的格子尺寸是算出来的，不靠递归收敛。
export const FILL_R = 1.0026     // 填充壳层半径：高于写深度的陆地面(1.0004)，并留足平面格子的下垂量
export const FILL_CELL = 0.08    // 网格边长上限(弧度)：格对角 ≤0.12 → 平面最深 ≈1.0008，仍高于陆地面 ~2.5km
// ★ 不设「只画前 N 颗」的配额：聚焦一整个星座时那会画面上一半的圈有底色一半没有，看着像 BUG。
//   所有填充/锥面按「层序|色|透明度」合批进一个几何体（见 fillBucket）—— 逐颗一个 Mesh 才是扛不住的
//   那一头（几百个对象 + 几百次 draw call/帧），合批后成本只随三角形总数走，颗数本身由 FOCUS_GEOM_MAX 管。
const angBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.dot(b))))
export function slerpUnit(a, b, t) {
  const th = angBetween(a, b)
  if (th < 1e-6) return a.clone().lerp(b, t).normalize()
  const s = Math.sin(th)
  return a.clone().multiplyScalar(Math.sin((1 - t) * th) / s).addScaledVector(b, Math.sin(t * th) / s)
}
// 把一颗星的覆盖圈填充三角形追加进 out（顶点流）；无从下笔时原样返回。
export function footprintFill(ring, satPos, out) {
  if (!ring || ring.length < 3) return
  const c = new THREE.Vector3()
  // 中心取星下点；缺它时用环顶点均值（足迹环按方位等分生成，均值必落在锥轴上）
  if (satPos && Number.isFinite(satPos.lat) && Number.isFinite(satPos.lon)) c.copy(llaToVec(satPos.lat, satPos.lon, 0))
  else for (const v of ring) c.add(v)
  if (c.lengthSq() < 1e-12) return
  c.normalize()
  const src = ring.map((v) => v.clone().normalize())
  if (src.length > 1 && src[0].distanceToSquared(src[src.length - 1]) < 1e-14) src.pop()   // 去掉自闭的重复末点
  const n0 = src.length
  if (n0 < 3) return
  // 环向按格边长补密：多选降采样时足迹只有 18 段，直接连会切进球里被地表吃掉
  const R = []
  for (let i = 0; i < n0; i++) {
    const a = src[i], b = src[(i + 1) % n0]
    R.push(a)
    const k = Math.ceil(angBetween(a, b) / FILL_CELL)
    for (let j = 1; j < k; j++) R.push(slerpUnit(a, b, j / k))
  }
  const n = R.length
  let maxAng = 0
  for (const v of R) maxAng = Math.max(maxAng, angBetween(c, v))
  const M = Math.max(1, Math.min(64, Math.ceil(maxAng / FILL_CELL)))   // 径向层数
  const push = (v) => { out.push3(v.x * FILL_R, v.y * FILL_R, v.z * FILL_R) }
  let prev = new Array(n).fill(c)
  for (let j = 1; j <= M; j++) {
    const t = j / M
    const cur = new Array(n)
    for (let i = 0; i < n; i++) cur[i] = slerpUnit(c, R[i], t)
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n
      if (j === 1) { push(c); push(cur[i]); push(cur[i2]) }   // 最内圈退化成扇形
      else { push(prev[i]); push(cur[i]); push(cur[i2]); push(prev[i]); push(cur[i2]); push(prev[i2]) }
    }
    prev = cur
  }
}
// 覆盖锥锥面：锥顶（卫星本体）→ 覆盖圈边界的三角扇。母线是直的、锥面本就是直纹面，不需要贴球细分；
// 只把底边（覆盖圈那一圈）按弦长补密 —— 多选降采样时足迹只剩 18 段，底边弦会切进地球被地表吃掉。
export function coneFace(apex, ring, out) {
  if (!ring || ring.length < 2) return
  const push = (v) => { out.push3(v.x, v.y, v.z) }
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i], b = ring[i + 1]
    const ra = a.length(), rb = b.length()
    const ua = a.clone().divideScalar(ra || 1), ub = b.clone().divideScalar(rb || 1)
    const k = Math.max(1, Math.min(16, Math.ceil(angBetween(ua, ub) / FILL_CELL)))
    let prev = a
    for (let j = 1; j <= k; j++) {
      const t = j / k
      const cur = j === k ? b : slerpUnit(ua, ub, t).multiplyScalar(ra + (rb - ra) * t)
      push(apex); push(prev); push(cur)
      prev = cur
    }
  }
}
