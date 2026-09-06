// 影像重投影的三角网规划器（src/viz/geo/rasterMesh.js）。运行：npm test
//
// 这一份是 CPU 路（warpTri，导出与无 WebGL2 时走它）与 GPU 路（glRaster）【共用】的几何来源。
// 两条路逐字同一份网格是「GPU 出图与 CPU 出图能对得上」的全部依据，故这里钉的是网格本身的
// 不变量，而不是画出来的像素（像素比对在 .imgharness 的 pxdiff 上做）。
//
// 判据一律是能算的量：覆盖、取向、UV 与经纬的对应、跨接缝的补画、以及各档的规模量级。
import { makeProjection } from '../../../src/viz/geo/projection.js'
import { planRasterMesh, COARSE, RP_TOL } from '../../../src/viz/geo/rasterMesh.js'

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}
const LON0 = -30
const WORLD = { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }
const KINDS = ['mercator', 'equalEarth', 'robinson', 'albers', 'azeq']
const whole = (PJ, res) => planRasterMesh(PJ, { bx0: 0, bx1: PJ.W, by0: 0, by1: PJ.H, res, S: WORLD })

// ---------- ① 出参形状 ----------
{
  const PJ = makeProjection('robinson', LON0)
  const M = whole(PJ, 4)
  ok('① 三个数组长度一致且 = 三角形数 × 6', M.n > 0 && M.xy.length === M.n * 6 && M.uv.length === M.n * 6, M.n + ' △')
  let finite = true
  for (let i = 0; i < M.xy.length; i++) if (!Number.isFinite(M.xy[i]) || !Number.isFinite(M.uv[i])) { finite = false; break }
  ok('① 没有 NaN / Infinity（有一个就够把整幅图拉成一条带）', finite)
  ok('① 平面坐标落在图幅内（含一点点格间叠量）', (() => {
    for (let i = 0; i < M.xy.length; i += 2) {
      if (M.xy[i] < -1 || M.xy[i] > PJ.W + 1 || M.xy[i + 1] < -1 || M.xy[i + 1] > PJ.H + 1) return false
    }
    return true
  })())
  ok('① v 落在 [0,1]（纬度不循环，越界就是把源图上下拉花）', (() => {
    for (let i = 1; i < M.uv.length; i += 2) if (M.uv[i] < -1e-9 || M.uv[i] > 1 + 1e-9) return false
    return true
  })())
}

// ---------- ② 取向：u/v 与经纬的对应 ----------
// 源图左边缘 = 180°W（u=0）、上边缘 = 90°N（v=0）。贴反了的症状是「北京画到埃及上空」，
// 一眼看不出错在哪，故这里拿【已知点】反查：取平面上离某经纬最近的那个顶点，比它的 uv。
{
  for (const kind of KINDS) {
    const PJ = makeProjection(kind, LON0)
    const M = whole(PJ, 4)
    let worst = 0
    for (const [lon, lat] of [[0, 0], [116.4, 39.9], [-58.4, -34.6], [139.7, 35.7], [18.4, -33.9]]) {
      const p = PJ.fwd(lon, lat, [0, 0])
      if (!Number.isFinite(p[0])) continue
      let bi = -1, bd = Infinity
      for (let i = 0; i < M.xy.length; i += 2) {
        const d = (M.xy[i] - p[0]) ** 2 + (M.xy[i + 1] - p[1]) ** 2
        if (d < bd) { bd = d; bi = i }
      }
      if (bi < 0) continue
      // 该顶点的 uv 应当就是这个经纬的 uv（就近取点，故允许一格的误差）
      const u = M.uv[bi], v = M.uv[bi + 1]
      const uWant = ((lon + 180) % 360 + 360) % 360 / 360, vWant = (90 - lat) / 180
      let du = Math.abs(u - uWant); du = Math.min(du, Math.abs(du - 1))   // u 可越界一个周期
      worst = Math.max(worst, du * 360, Math.abs(v - vWant) * 180)
    }
    ok('② ' + kind + ' 的 uv 与经纬对得上（就近顶点，误差 < 一个粗块）', worst < COARSE, '最差 ' + worst.toFixed(2) + '°')
  }
}

// ---------- ③ 覆盖：图幅内的点都落在某个三角形里 ----------
// 漏一格的症状是图上一块块矩形空白 / 亮度阶（换成区块拼图那次踩过）。
{
  const inTri = (px, py, ax, ay, bx, by, cx, cy) => {
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (!d) return false
    const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d
    const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d
    return a >= -1e-9 && b >= -1e-9 && a + b <= 1 + 1e-9
  }
  for (const kind of KINDS) {
    const PJ = makeProjection(kind, LON0)
    const M = whole(PJ, 4)
    let tested = 0, miss = 0
    // 采样点取【经纬那一侧】再正算：这样每个点必在图幅内（平面上撒点会撒到图幅之外）
    for (let lon = -170; lon <= 170; lon += 17) {
      for (let lat = -80; lat <= 80; lat += 13) {
        const p = PJ.fwd(lon, lat, [0, 0])
        if (!Number.isFinite(p[0])) continue
        tested++
        let hit = false
        for (let i = 0; i < M.xy.length && !hit; i += 6) {
          hit = inTri(p[0], p[1], M.xy[i], M.xy[i + 1], M.xy[i + 2], M.xy[i + 3], M.xy[i + 4], M.xy[i + 5])
        }
        if (!hit) miss++
      }
    }
    ok('③ ' + kind + ' 图幅内无漏格', miss === 0, tested + ' 个采样点，漏 ' + miss)
  }
}

// ---------- ④ 跨源图接缝的格【画两遍】（反向网格档专有）----------
// 骑在 ±180 上的那一格源矩形有一半落在源图外，一遍画不全，症状是沿接缝一条锯齿白带。
// 两遍的 u 恰好差一个整周期（1.0），GPU 侧靠 REPEAT 取到同一批纹素，CPU 侧各画得出一半。
{
  const PJ = makeProjection('azeq', LON0)
  ok('④ 方位等距走反向网格', PJ.invGrid === true)
  const M = whole(PJ, 4)
  let dup = 0
  const key = new Map()
  for (let t = 0; t < M.n; t++) {
    const i = t * 6
    const k = M.xy[i].toFixed(6) + ',' + M.xy[i + 1].toFixed(6) + ',' + M.xy[i + 2].toFixed(6) + ',' + M.xy[i + 3].toFixed(6)
    const prev = key.get(k)
    if (prev != null && Math.abs(Math.abs(M.uv[prev] - M.uv[i]) - 1) < 1e-9) dup++
    key.set(k, i)
  }
  ok('④ 接缝上确有「同一片三角、u 差整一个周期」的补画', dup > 0, dup + ' 对')
}

// ---------- ⑤ 细分随分辨率走，且各档规模在量级上说得通 ----------
{
  for (const kind of KINDS) {
    const PJ = makeProjection(kind, LON0)
    const a = whole(PJ, 2).n, b = whole(PJ, 8).n
    ok('⑤ ' + kind + ' 分辨率高一档就细一档', b > a, `res2 ${a} △ → res8 ${b} △`)
  }
  // 反向网格档的格子数比正向档高一个量级 —— srcThumb 那一整套降档就是为它存在的
  const inv = whole(makeProjection('azeq', LON0), 4).n
  const fwd = whole(makeProjection('robinson', LON0), 4).n
  ok('⑤ 反向网格档的三角形数高一个量级（srcThumb 的存在理由）', inv > fwd * 5, `方位等距 ${inv} △ vs 罗宾逊 ${fwd} △`)
}

// ---------- ⑥ 取一块比取整幅便宜，且取的那块被完整覆盖 ----------
// GPU 路按【可见框 + RP_PAD】取网格，靠这条保证「放大之后规划成本不涨」。
{
  const PJ = makeProjection('azeq', LON0)
  const all = whole(PJ, 4).n
  const part = planRasterMesh(PJ, { bx0: 120, bx1: 240, by0: 120, by1: 240, res: 4, S: WORLD }).n
  ok('⑥ 取一块远比取整幅少', part * 3 < all, `整幅 ${all} △ · 中间那块 ${part} △`)
  ok('⑥ 空框返回空网格（不是抛错）', planRasterMesh(PJ, { bx0: 10, bx1: 10, by0: 0, by1: 1, res: 4, S: WORLD }).n === 0)
  ok('⑥ res 非法返回空网格', planRasterMesh(PJ, { bx0: 0, bx1: PJ.W, by0: 0, by1: PJ.H, res: 0, S: WORLD }).n === 0)
}

// ---------- ⑦ 常数没被顺手改掉 ----------
{
  ok('⑦ 粗块 15°、弓高 0.6 个目标像素（改这两个数＝改全部投影档的影像密度）', COARSE === 15 && RP_TOL === 0.6)
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
