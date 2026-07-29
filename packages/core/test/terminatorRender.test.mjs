// 晨昏线【渲染层】自测：几何对不等于画对。这一份验的是两个渲染器各自的「夜区判定」，
// 即「屏幕上被压暗的那片，是不是恰好等于太阳仰角 < 0 的那片」。运行：npm test
//
// 为什么不做像素比对：两个渲染器都要真实 DOM/WebGL，离屏跑不起来；而真正会出错的
// 不是画笔而是【判定】——夜区画反了侧、2D 多边形被地图接缝(LON0=−30)撕开、封口封到了亮极、
// 3D 球冠错扣在日下点而不是反日下点。这四种错都能在 Node 里用点判定逐点抓出来，
// 判据一律取独立写的球面公式 sin h = sinφ·sinφs + cosφ·cosφs·cos(λ−λs)，不复用被测中间量。
import * as THREE from 'three'
import { solarGeometry, terminatorFlat } from '../../../src/viz/terminator.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

const RAD = Math.PI / 180, DEG = 180 / Math.PI
const U = (y, mo, d, h = 0, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, 0))
const LON0 = -30   // flatCoverage.js 的地图接缝（西经 30° 为左边缘）

function sunElev(latD, lonD, sub) {
  const s = Math.sin(latD * RAD) * Math.sin(sub.lat * RAD)
    + Math.cos(latD * RAD) * Math.cos(sub.lat * RAD) * Math.cos((lonD - sub.lon) * RAD)
  return Math.asin(Math.max(-1, Math.min(1, s))) * DEG
}

// 射线法点在多边形内（多边形为世界坐标 [x, y] 点列，隐式闭合）
function inPoly(x, y, poly) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

// scene.js 的 llaToVec 原样复刻（半径 1）。全场景（陆地网/国界/卫星/夜区）共用这一套约定，
// 故整体若有常数旋转也会一起转、互相仍对齐 —— 这里验的是夜区相对日下点的【相对】朝向。
function llaToVec(latDeg, lonDeg) {
  const phi = (90 - latDeg) * Math.PI / 180
  const theta = (lonDeg + 180) * Math.PI / 180
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta)
  )
}

const DATES = [
  U(2026, 6, 21, 12, 0),   // 夏至正午：南极极夜，夜区封在 −90
  U(2026, 12, 21, 12, 0),  // 冬至正午：北极极夜，夜区封在 +90
  U(2026, 6, 21, 0, 0),    // 夏至子夜：夜区整体西移半圈（接缝处正好在夜区中段）
  U(2026, 9, 23, 1, 0),    // 秋分：晨昏线近乎经线，2D 单值形式最陡、最容易撕
  U(2026, 3, 20, 15, 0),   // 春分另一侧
  U(2026, 11, 3, 6, 7)     // 均时差年最大那天
]

// ---- A. 2D 夜区多边形：覆盖域必须恰好等于 h<0 ----
{
  const EXCL = 0.6   // 晨昏线两侧 ±0.6° 内不判（多边形按 1440 段折线逼近曲线，边界必有离散噪声）
  let bad = 0, tested = 0, excluded = 0, worstCase = null
  for (const d of DATES) {
    const { sub } = solarGeometry(d)
    const { night } = terminatorFlat(d, { steps: 1440, lon0: LON0 })
    const poly = night.map(([lon, lat]) => [lon - LON0, 90 - lat])   // 世界坐标，与 drawTerminator 逐字一致
    for (let lat = -88; lat <= 88; lat += 2) {
      for (let lon = LON0 + 0.7; lon < LON0 + 360; lon += 2) {
        const h = sunElev(lat, lon, sub)
        if (Math.abs(h) < EXCL) { excluded++; continue }
        tested++
        const painted = inPoly(lon - LON0, 90 - lat, poly)
        if (painted !== (h < 0)) { bad++; if (!worstCase) worstCase = `${d.toISOString()} @ ${lat}°,${lon.toFixed(1)}° h=${h.toFixed(2)}° 画成${painted ? '夜' : '昼'}` }
      }
    }
  }
  ok('2D 夜区覆盖域 = 太阳仰角<0 的域', bad === 0, `判 ${tested} 点（排除边界 ${excluded} 点）错 ${bad}${worstCase ? ' 首例 ' + worstCase : ''}`)
}

// ---- A' 接缝连续性：接缝两侧相邻列的夜区高度不得突变 ----
// 多边形若被 LON0 撕开，接缝那一列的夜区高度会掉到 0 或跳满整幅。
{
  let worst = 0, worstAt = null
  for (const d of DATES) {
    const { night } = terminatorFlat(d, { steps: 1440, lon0: LON0 })
    const poly = night.map(([lon, lat]) => [lon - LON0, 90 - lat])
    // 逐列（世界 X）量夜区纵向覆盖高度
    const colH = (wx) => { let c = 0; for (let y = -89; y <= 89; y += 1) if (inPoly(wx, 90 - y, poly)) c++; return c }
    for (const wx of [0.05, 0.5, 1, 2, 358, 359, 359.5, 359.95]) {
      const a = colH(wx), b = colH(wx === 0.05 ? 0.5 : wx - 0.4)
      const j = Math.abs(a - b)
      if (j > worst) { worst = j; worstAt = `${d.toISOString()} wx=${wx}` }
    }
  }
  ok('接缝两侧无撕裂（相邻列高度突变 ≤ 3 行）', worst <= 3, `最大突变 ${worst} 行 @ ${worstAt}`)
}

// ---- A'' 封口封在暗极：暗极整圈涂黑、亮极整圈不涂 ----
// ★ 只在【真的存在极昼极夜】时才成立：分点前后太阳在赤道，各纬度都是约 12 小时白天，
// 两极都没有整圈全黑/全亮可言（纬度 89.5° 处也只差百分之几度）。故按 |赤纬| ≥ 1° 设闸，
// 分点那两个时刻交给 A（逐点比对，94k 点，本就覆盖极区）—— 不是放过，是换判据。
{
  let bad = 0, detail = [], checked = 0, gated = 0
  for (const d of DATES) {
    const { sub } = solarGeometry(d)
    const { night, darkPole } = terminatorFlat(d, { steps: 720, lon0: LON0 })
    const poly = night.map(([lon, lat]) => [lon - LON0, 90 - lat])
    // 暗极方向必须与日下点相反（这条与赤纬大小无关，恒成立）
    if (Math.sign(darkPole) === Math.sign(sub.lat)) { bad++; detail.push('暗极与日下点同侧') }
    if (Math.abs(sub.lat) < 1) { gated++; continue }
    const litPole = -darkPole
    for (let lon = LON0 + 5; lon < LON0 + 360; lon += 30) {
      checked++
      if (!inPoly(lon - LON0, 90 - darkPole * 0.9944, poly)) { bad++; detail.push('暗极漏涂') }   // 纬度 ±89.5°
      if (inPoly(lon - LON0, 90 - litPole * 0.9944, poly)) { bad++; detail.push('亮极误涂') }
    }
  }
  ok('夜区封口在暗极、亮极不被涂', bad === 0, bad ? [...new Set(detail)].join('/') : `${checked} 组极区探针全对（分点 ${gated} 个时刻按判据不适用已转交 A）`)
}

// ---- B. 3D 夜区球冠：thetaLength=90° 的半球壳扣在【反日下点】上 ----
// scene.js: cap.quaternion.setFromUnitVectors((0,1,0), llaToVec(anti).normalize())
// SphereGeometry 的 theta 自 +Y 起算 → 冠内方向 = 与旋转后 +Y（即反日下点方向）夹角 ≤ 90°。
{
  let bad = 0, tested = 0, excluded = 0, worstCase = null
  const EXCL = 1e-6
  for (const d of DATES) {
    const { sub, anti } = solarGeometry(d)
    const antiDir = llaToVec(anti.lat, anti.lon).normalize()
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), antiDir)
    const capAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(q)   // 旋转后的冠轴
    if (capAxis.distanceTo(antiDir) > 1e-9) { bad++; worstCase = '冠轴未落在反日下点方向' }
    for (let lat = -85; lat <= 85; lat += 5) {
      for (let lon = -175; lon < 180; lon += 5) {
        const h = sunElev(lat, lon, sub)
        if (Math.abs(h) < EXCL) { excluded++; continue }
        tested++
        const covered = llaToVec(lat, lon).normalize().dot(capAxis) >= 0   // 与冠轴夹角 ≤ 90° 即在冠内
        if (covered !== (h < 0)) { bad++; if (!worstCase) worstCase = `${d.toISOString()} @ ${lat}°,${lon}° h=${h.toFixed(3)}° 覆盖=${covered}` }
      }
    }
  }
  ok('3D 球冠覆盖域 = 太阳仰角<0 的域', bad === 0, `判 ${tested} 点错 ${bad}${worstCase ? ' 首例 ' + worstCase : ''}`)
}

// ---- B' 扣错点的反向证伪：球冠若扣在日下点上，这个测试必须失败 ----
// （防止 B 因为某种对称性「怎么写都过」——把 anti 换成 sub，覆盖域应当整体反相）
{
  const d = DATES[0]
  const { sub } = solarGeometry(d)
  const subDir = llaToVec(sub.lat, sub.lon).normalize()
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), subDir)
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
  let agree = 0, total = 0
  for (let lat = -80; lat <= 80; lat += 10) {
    for (let lon = -170; lon < 180; lon += 10) {
      const h = sunElev(lat, lon, sub)
      if (Math.abs(h) < 1e-6) continue
      total++
      if ((llaToVec(lat, lon).normalize().dot(axis) >= 0) === (h < 0)) agree++
    }
  }
  ok('反向证伪：冠扣在日下点则完全相反', agree === 0, `扣错点时一致率 ${(100 * agree / total).toFixed(1)}%（应为 0%）`)
}

// ---- C. 3D 夜区球壳的深度不变式：壳的【最低点】必须高于陆地的【最高点】 ----
// v1.3.9 首版就是在这翻的：R=1.0002 + 96×48 → 壳最低 0.99953，比陆地顶点(1.0)还低 4.7e-4，
// 两套疏密不同的球面剖分互相穿插，整片夜区变成斜向摩尔纹条纹。
// 陆地网格（scene.js buildLandMesh）顶点严格在半径 1.0，三角形按 MAXSEG=3° 细分后是弦、面心下陷——
// 下陷只会让陆地更低，故「壳最低 > 1.0」是充分条件。此处按 scene.js 的常量复算，改任一参数都会被这条拦下。
{
  const R = 1.0008, W = 180, H = 45          // 须与 scene.js 的 TERM_CAP_R / TERM_CAP_W / TERM_CAP_H 同步
  const LINE_R = 1.0012, RING_STEPS = 720    // 须与 TERM_LINE_R 及 setTerminator 的默认 steps 同步
  const LAND_MAX = 1.0                       // 陆地网格顶点半径（llaToVec(lat, lon, 0) → r=1）；三角面只会更低

  // 真建一遍 SphereGeometry，逐三角形量【原点到三角面的距离】——深度缓冲看到的是插值后的三角面，
  // 不是顶点；面心下陷才是穿插的根源。用真几何量，避免解析式与 three.js 实际剖分方式对不上。
  function capFloor(r, w, h) {
    const geo = new THREE.SphereGeometry(r, w, h, 0, Math.PI * 2, 0, Math.PI / 2)
    const pos = geo.getAttribute('position'), idx = geo.getIndex()
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const plane = new THREE.Plane()
    let floor = Infinity
    for (let i = 0; i < idx.count; i += 3) {
      a.fromBufferAttribute(pos, idx.getX(i)); b.fromBufferAttribute(pos, idx.getX(i + 1)); c.fromBufferAttribute(pos, idx.getX(i + 2))
      if (a.distanceToSquared(b) < 1e-18 || b.distanceToSquared(c) < 1e-18 || c.distanceToSquared(a) < 1e-18) continue   // 极点处的退化三角形
      plane.setFromCoplanarPoints(a, b, c)
      const d = Math.abs(plane.constant)   // 原点到该三角面的距离 = 这片面最接近球心的半径
      if (d < floor) floor = d
    }
    geo.dispose()
    return floor
  }

  const capMin = capFloor(R, W, H)
  ok('夜区球壳最低点高于陆地顶点', capMin > LAND_MAX,
    `实测壳最低 ${capMin.toFixed(6)} vs 陆地 ${LAND_MAX}（余量 ${((capMin - LAND_MAX) * 1e6).toFixed(0)} ppm）`)
  // 视差闸：R 不能一味加大，1.0008 ≈ 5 km 高，地平处会看出夜区与地表错开
  ok('球壳抬高量不过分（≤ 20 km 等效）', (R - 1) * 6371 <= 20, `${((R - 1) * 6371).toFixed(1)} km`)
  // 分界线须压在球壳之上（壳最高即 R），且线自身弦切后仍高于陆地
  const lineMin = LINE_R * Math.cos((360 / RING_STEPS / 2) * RAD)
  ok('分界线高于球壳最高点', LINE_R > R, `${LINE_R} > ${R}`)
  ok('分界线最低点高于陆地顶点', lineMin > LAND_MAX, `线最低 ${lineMin.toFixed(6)}`)
  // 首版参数的反向证伪：这条不变式必须真的能拦住它，否则测试形同虚设
  const oldMin = capFloor(1.0002, 96, 48)
  ok('反向证伪：首版 R=1.0002+96×48 会被拦下', oldMin < LAND_MAX, `首版实测壳最低 ${oldMin.toFixed(6)} < ${LAND_MAX}`)
}

console.log(`\n晨昏线渲染判定：${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
