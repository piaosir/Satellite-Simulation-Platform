// 环境场贴图球的几何参数（3D 侧）。单拎出来是为了能离屏单测——
// 「贴图偏 90°／上下颠倒」这类错误在代码里看不出来，只有把球建出来逐点比对才发现得了。
//
// 定向推导（依 globe3d/scene.js 的 llaToVec，勿照搬别处的球）：
//   llaToVec：x = −r·sinΦ·cosθ, y = r·cosΦ, z = r·sinΦ·sinθ，其中 Φ=(90−lat)、θ=(lon+180)（弧度）
//   THREE.SphereGeometry：x = −r·cos(φ)·sin(θ₃), y = r·cos(θ₃), z = r·sin(φ)·sin(θ₃)
//                         φ = phiStart + u·phiLength（沿贴图 u）、θ₃ = thetaStart + v·thetaLength（沿贴图 v，v=0 在顶）
//   两式逐项对齐 ⇒ θ₃ ≡ Φ、φ ≡ θ。于是
//     phiStart   = (lonMin + 180)·π/180   —— lonMin = −180 时为 0，无需再偏 90°
//     thetaStart = (90 − latMax)·π/180    —— v=0 在北，与栅格「行 0 = 北」对齐，不必翻转
//
// 半径挑在【陆地网格(1.0) 与 岸线/国界(1.0004/1.0005) 之间】：场压住海陆填色，
// 岸线国界仍压在场之上——与 2D 侧「地物线在场之上」的制图口径一致。
export const ENV_R = 1.00035

const D2R = Math.PI / 180

/** bbox → SphereGeometry 的构造参数（radius, widthSeg, heightSeg, phiStart, phiLength, thetaStart, thetaLength） */
export function envSphereParams(bbox, seg) {
  const b = bbox || { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }
  const wSeg = (seg && seg.w) || 192, hSeg = (seg && seg.h) || 96
  return {
    radius: ENV_R,
    widthSeg: wSeg,
    heightSeg: hSeg,
    phiStart: (b.lonMin + 180) * D2R,
    phiLength: (b.lonMax - b.lonMin) * D2R,
    thetaStart: (90 - b.latMax) * D2R,
    thetaLength: (b.latMax - b.latMin) * D2R
  }
}

/** 贴图坐标 (u, v) → 该处应当对应的经纬度（v=0 在顶=北） */
export function uvToLonLat(bbox, u, v) {
  const b = bbox || { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }
  return {
    lon: b.lonMin + u * (b.lonMax - b.lonMin),
    lat: b.latMax - v * (b.latMax - b.latMin)
  }
}
