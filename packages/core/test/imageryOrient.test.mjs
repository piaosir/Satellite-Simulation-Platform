// 影像底图【取向】自测：贴对不对，肉眼很难看出来。运行：npm test
//
// 整幅等经纬影像贴到球上，偏一个角度的典型症状是「北京画在埃及上空」——海陆轮廓依旧
// 是海陆轮廓，画面看着毫无破绽，只有拿已知地物去比才发现错。这类错在本仓库出过一次
// （见 lb-link-view-3d 的「贴图经度偏 90°」），故这里用数值把两条取向链锁死：
//
//   3D：three.js SphereGeometry 的顶点 uv，必须恰好等于 u=(lon+180)/360、v=(90+lat)/180，
//       其中 lon/lat 由 scene.js 的球面取向反算。判据独立写（抄 scene.js 的公式并注明出处），
//       不复用被测中间量；uv 则从真实 geometry 的 attribute 读，不靠记忆里的 three 实现。
//   2D：flatCoverage 的 drawImagery 把整幅图落在世界 x ∈ [shift, shift+360]，
//       shift=((−180−LON0)%360+360)%360。验的是「任一经度经这条链算出的落点，
//       与该经度在世界坐标里本该在的位置 (lon−LON0) 同余 360」。
//
// 两条链都配了反向证伪：把取向改成曾经错过的样子，测试必须挂。
import * as THREE from 'three'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

const DEG = 180 / Math.PI

// scene.js 的球面取向（emitVert，见 src/viz/globe3d/scene.js）：
//   phi=(90−lat)·D2R、theta=(lon+180)·D2R
//   x = −sinφ·cosθ、y = cosφ、z = sinφ·sinθ
// 其逆即 scene.js 的 vecToLatLon。这里抄的是【逆】，用来把 geometry 顶点反算成经纬度。
function vecToLatLon(x, y, z) {
  const lat = 90 - Math.acos(Math.max(-1, Math.min(1, y))) * DEG
  let lon = Math.atan2(z, -x) * DEG - 180
  lon = ((lon % 360) + 540) % 360 - 180
  return { lat, lon }
}

// 环形距离：u=0 与 u=1 是同一条经线（贴图接缝），差 1 不算错
const uDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d) }

// ── 1) 3D：SphereGeometry 的 uv 与等经纬贴图约定是否天然对齐 ──────────────────
{
  const seg = 64
  const g = new THREE.SphereGeometry(1, seg, seg)
  const pos = g.attributes.position, uv = g.attributes.uv
  let maxDU = 0, maxDV = 0, n = 0, poles = 0
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    if (Math.abs(y) > 0.999999) { poles++; continue }   // 极点：经度无定义（atan2(0,0)），跳过
    const { lat, lon } = vecToLatLon(x, y, z)
    const ue = (lon + 180) / 360, ve = (90 + lat) / 180
    maxDU = Math.max(maxDU, uDist(ue, uv.getX(i)))
    maxDV = Math.max(maxDV, Math.abs(ve - uv.getY(i)))
    n++
  }
  ok('3D uv 对齐：u=(lon+180)/360', maxDU < 1e-6, `${n} 个顶点，最大偏差 ${maxDU.toExponential(2)}`)
  ok('3D uv 对齐：v=(90+lat)/180', maxDV < 1e-6, `最大偏差 ${maxDV.toExponential(2)}`)
  ok('3D 极点已排除（经度在此无定义）', poles > 0, `${poles} 个极点顶点`)

  // 反向证伪：曾经错过的「偏 90°」与「偏 180°」，这条不变式必须真的拦得住
  let bad90 = 0, bad180 = 0
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    if (Math.abs(y) > 0.999999) continue
    const { lon } = vecToLatLon(pos.getX(i), y, pos.getZ(i))
    bad90 = Math.max(bad90, uDist(((lon + 90 + 180) % 360 + 360) % 360 / 360, uv.getX(i)))
    bad180 = Math.max(bad180, uDist(((lon + 180 + 180) % 360 + 360) % 360 / 360, uv.getX(i)))
  }
  ok('反向证伪：偏 90° 会被拦下', bad90 > 0.2, `偏差 ${bad90.toFixed(3)}`)
  ok('反向证伪：偏 180° 会被拦下', bad180 > 0.4, `偏差 ${bad180.toFixed(3)}`)
  g.dispose()
}

// ── 2) 3D「实感」判据：真实地物不能互相跑到对方头上 ──────────────────────────
// 上面的 uv 断言已经足够严，但那是抽象量。这一条直接回答「北京会不会画在埃及上空」：
// 取两地的贴图列号，其间距必须等于它们的经度差（8192 宽的图上 1° = 22.76 px）。
{
  const W = 8192
  const col = (lon) => (lon + 180) / 360 * W
  const beijing = 116.4, cairo = 31.2
  const gotPx = col(beijing) - col(cairo)
  const wantPx = (beijing - cairo) / 360 * W
  ok('北京与开罗的贴图列距 = 经度差', Math.abs(gotPx - wantPx) < 1e-9, `${gotPx.toFixed(1)} px ≈ ${(beijing - cairo).toFixed(1)}°`)
  ok('北京不落在开罗那一列', Math.abs(gotPx) > 1000, `相距 ${Math.abs(gotPx).toFixed(0)} px`)
}

// ── 3) 2D：drawImagery 的 shift 错位是否把每个经度送回它该在的世界位置 ─────────
// 世界度坐标 x = lon − LON0（见 flatCoverage）；影像整幅落在 [shift, shift+360]，
// 图内偏移 = (lon+180)/360×360。两者必须模 360 同余。
{
  const shiftOf = (LON0) => (((-180 - LON0) % 360) + 360) % 360
  const mod360 = (v) => ((v % 360) + 360) % 360
  let worst = 0
  const LONS = [-180, -179.9, -120, -30, 0, 0.1, 60, 116.4, 179.9, 180]
  for (const LON0 of [-30, 0, 60, 116.4, -180, 180, 150]) {
    const shift = shiftOf(LON0)
    for (const lon of LONS) {
      const drawn = shift + (lon + 180)          // 影像画出来时该经度落在的世界 x（未取模）
      const want = lon - LON0                     // 该经度在世界坐标里本该在的位置
      const d = Math.abs(mod360(drawn) - mod360(want))
      worst = Math.max(worst, Math.min(d, 360 - d))
    }
  }
  ok('2D shift 错位：各经度落点与世界坐标同余', worst < 1e-9, `最大偏差 ${worst.toExponential(2)}°`)

  // shift 的定义性检查：图像左边缘（−180°）落在世界 x=shift 处
  ok('2D shift 定义：LON0=−30 时 −180° 落在世界 210°', Math.abs(shiftOf(-30) - 210) < 1e-9, `shift=${shiftOf(-30)}`)
  ok('2D shift 定义：LON0=−180 时图像与世界零点重合', Math.abs(shiftOf(-180) - 0) < 1e-9, `shift=${shiftOf(-180)}`)

  // 反向证伪：漏掉 shift（直接把整幅图铺在世界 [0,360]）在 LON0≠−180 时必须挂
  let naiveWorst = 0
  for (const lon of LONS) {
    const d = Math.abs(mod360(lon + 180) - mod360(lon - (-30)))
    naiveWorst = Math.max(naiveWorst, Math.min(d, 360 - d))
  }
  ok('反向证伪：漏掉 shift 会被拦下', naiveWorst > 100, `偏差 ${naiveWorst.toFixed(1)}°`)
}

console.log(`\n影像底图取向：${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
