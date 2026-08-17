// GEO 卫星「轨道位置」（定点经度）标注 —— 全平台单一真值源（星座列表 / 搜索结果 / 信息卡 /
// 可见性分析 / 对星覆盖等处共用，勿在各页各写一份判定与格式化）。
//
// 判定走 shared/orbitClass.js 的严谨区制（classifyOrbit === 'GEO'：近圆 + 同步周期 + 近赤道）。
// 经度取【星历历元】处 SGP4 传播一拍的星下点经度（ECI→ECEF）：受控 GEO 的经度摆动 < 0.1°，
// 历元值即定点位置，且不随仿真时钟漂移 —— 列表/徽标是静态标注，不能一拍一个值。
// 结果缓存在数据对象上（satrec/OMM 记录建好后根数不变），同一条数据终生只算一次；
// 全量目录数万条须先用根数粗判 GEO 再建 satrec 精算，别逐条传播。
//
// 口径：东经为正、西经为负，格式 `110.5°E` / `61.0°W`（°E/°W 为国际通式，不随界面语言翻译）。

import sat from '../viz/constellation/satellite.js'
import { classifyOrbit, fmtGeoSlot } from './orbitClass.js'

const DEG = Math.PI / 180

// °E/°W 格式化本体在 orbitClass.js（零依赖，轻量窗口可单独引）；此处再导出，判定+格式化一站取齐
export { fmtGeoSlot }

// satrec → 是否 GEO（严谨区制；rec.no 为 rad/min）
export function isGeoSatrec(rec) {
  if (!rec || !(rec.no > 0)) return false
  return classifyOrbit({ e: rec.ecco, inclDeg: rec.inclo / DEG, periodMin: (2 * Math.PI) / rec.no }) === 'GEO'
}

// satrec → 历元处星下点经度（°，西经为负）；解算失败 NaN
export function geoLonAtEpoch(rec) {
  try {
    const pv = sat.sgp4(rec, 0)   // tsince=0 即历元，免建 Date
    if (!pv || !pv.position) return NaN
    const gd = sat.eciToGeodetic(pv.position, sat.gstime(rec.jdsatepoch))
    return sat.degreesLong(gd.longitude)
  } catch { return NaN }
}

// satrec → GEO 定点标注（非 GEO / 解算失败返回 ''）
export function geoSlotOfSatrec(rec) {
  if (!rec) return ''
  if (rec._geoSlot !== undefined) return rec._geoSlot
  return (rec._geoSlot = isGeoSatrec(rec) ? fmtGeoSlot(geoLonAtEpoch(rec)) : '')
}

// OMM 记录（parseOMMCsv 产物，字段为字符串）→ GEO 定点标注。
// 粗判只做根数换算（不建 satrec），GEO 候选才建 satrec 精算。
export function geoSlotOfOmm(s) {
  if (!s) return ''
  if (s._geoSlot !== undefined) return s._geoSlot
  const mm = Number(s.meanMotion)
  const geo = classifyOrbit({ e: Number(s.ecc) || 0, inclDeg: Number(s.incl) || 0, periodMin: mm > 0 ? 1440 / mm : NaN }) === 'GEO'
  if (!geo) return (s._geoSlot = '')
  try {
    const rec = sat.omm2satrec(s)
    return (s._geoSlot = rec && !rec.error ? fmtGeoSlot(geoLonAtEpoch(rec)) : '')
  } catch { return (s._geoSlot = '') }
}
