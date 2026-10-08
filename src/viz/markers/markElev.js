// 地球站 / 点标记上的「聚焦卫星仰角」标注 —— 取数与读数串（纯函数，node 可测：packages/core/test/markElev.test.mjs）。
//
// 口径与站天线「跟踪」读数同一个函数（entityPose.stationTrackAzEl：WGS-84 站址 → 星 ECEF 视线 → 站址大地 ENU）：
//   · 聚焦一颗：读它；聚焦多颗：读此刻仰角最高的那颗（「最佳仰角」—— 换星时数值连续，不跳）。地平线以下照出负值 = 不可见。
//   · 先在聚焦集快照上扫一遍 sin(仰角) 挑出最高的那颗，再对它调 stationTrackAzEl 出读数：与侧栏「跟踪」读数同一个函数，
//     同一颗星时逐位相同。快照里位置非有限的星跳过（原来一颗坏星排在第一个，整站读数就成了「仰角 NaN°」）。
//   · 取数量级：聚焦集一次推送只解算一遍（调用方给 ECEF 快照），每个标记 n 次点积 + 一次读数。
//     原来每个标记都把聚焦集整个重推一遍 SGP4：聚焦整个 Starlink（11107 颗）、图上 30 个标记 → 一拍 33 万次 SGP4、183 ms
//     （100 个标记 602 ms）；现在扫描 0.8 ms / 2.6 ms，与原结果最大差 9e-13°（node 实测）。
//
// 站标签读跟踪星（站挂了模型、「跟踪」指定了某颗星、勾了「仰角」或「方位角」）：
//   · 勾了方位角 → 方位 / 仰角成对读跟踪星：一个标签里的两个角永远属于同一颗星。原来只勾方位角时仰角仍读聚焦集最高那颗，
//     「方位 138.6° 仰角 36.7°」读起来是一对，实际是两颗星。只勾仰角 → 仰角读跟踪星；都没勾 → 同点标记。
//   · 跟踪星解不出 → 空串（不拿聚焦集里别的星顶替）。
//   · 「跟踪」那一行只在站挂了模型时出现：卸下模型后 s.track 留着（再挂回来还在），但标签不再认它 ——
//     否则读数跟着一颗界面上已经看不见设置的星走。
//
// 读数串生成时就按界面语言出字：画进 canvas 的串由 i18n 运行时整串查表翻译，拼出来的「方位 … 仰角 …」查不到整串，
// 英文界面下会被译成「Azimuth 138.6° 仰角 36.7°」。

import { makeStationLook, stationTrackAzEl } from '../../../packages/core/models/entityPose.mjs'
import { A as WGS_A, E2 as WGS_E2 } from '../wgs84.js'
import { byLang } from '../../shared/i18n/lang.js'

export { makeStationLook }

const D2R = Math.PI / 180
const fin = Number.isFinite

/**
 * 快照里此刻对站址仰角最高的那颗的下标（−1 = 没有有效位置）。比的是 sin(仰角) = 视线·大地天顶 / |视线|（与仰角同序，省掉 asin）；
 * 站址 ECEF 与 wgs84.geodeticToEcef 同式。
 * @param {number} latDeg 大地纬（度）
 * @param {number} lonDeg 经度（度）
 * @param {number} hKm    海拔（km）
 * @param {Float64Array|number[]} xyz 星 ECEF（km）紧排 [x0, y0, z0, x1, …]
 * @param {number} n      颗数
 */
export function bestElevIdx(latDeg, lonDeg, hKm, xyz, n) {
  if (!(n > 0) || !fin(latDeg) || !fin(lonDeg)) return -1
  const p = latDeg * D2R, l = lonDeg * D2R, sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l)
  const h = fin(hKm) ? hKm : 0
  const N = WGS_A / Math.sqrt(1 - WGS_E2 * sp * sp)
  const ox = (N + h) * cp * cl, oy = (N + h) * cp * sl, oz = (N * (1 - WGS_E2) + h) * sp
  const ux = cp * cl, uy = cp * sl, uz = sp
  let best = -1, bs = -Infinity
  for (let i = 0, k = 0; i < n; i++, k += 3) {
    const dx = xyz[k] - ox, dy = xyz[k + 1] - oy, dz = xyz[k + 2] - oz
    const s = (dx * ux + dy * uy + dz * uz) / Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (s > bs) { bs = s; best = i }   // 位置非有限 / 零距离 → s 为 NaN，比较恒假，自然跳过
  }
  return best
}

/**
 * 对一颗星（ECEF km）的 WGS-84 读数写进 out（makeStationLook() 的容器）。
 * 天顶奇异（keyhole）时方位取 0：stationTrackAzEl 奇异时沿用 out 里上一次的方位，而 out 是逐个标记复用的，不能把别的站的方位带过来。
 * @param {{lat:number, lon:number, altM?:number}} lla
 */
export function lookAt(lla, ecef, out) {
  out.a1Deg = NaN
  return stationTrackAzEl(lla, ecef, out)
}

const _tgt = [0, 0, 0]
/**
 * 聚焦集里此刻对站址仰角最高那颗的读数写进 out；返回它在快照里的下标（−1 = 没有，out 不动）。
 * @param {{lat:number, lon:number, altM?:number}} lla
 */
export function bestLook(lla, xyz, n, out) {
  const i = bestElevIdx(lla.lat, lla.lon, fin(lla.altM) ? lla.altM / 1000 : 0, xyz, n)
  if (i < 0) return -1
  _tgt[0] = xyz[3 * i]; _tgt[1] = xyz[3 * i + 1]; _tgt[2] = xyz[3 * i + 2]
  lookAt(lla, _tgt, out)
  return i
}

/** 角度 0.1° 一档（与 toFixed(1) 同一舍入）；「-0.0」归「0.0」（星正贴地平线时不出负零） */
export function fmtDeg1(v) {
  const s = v.toFixed(1)
  return s === '-0.0' ? '0.0' : s
}
/** 方位折到 [0, 360) 后 0.1° 一档；舍入到「360.0」的折回「0.0」 */
export function fmtAz1(v) {
  const s = (((v % 360) + 360) % 360).toFixed(1)
  return s === '360.0' || s === '-0.0' ? '0.0' : s
}
export const elevText = (el) => byLang(`仰角 ${fmtDeg1(el)}°`, `Elevation ${fmtDeg1(el)}°`)
export const azElText = (az, el) => byLang(`方位 ${fmtAz1(az)}° 仰角 ${fmtDeg1(el)}°`, `Azimuth ${fmtAz1(az)}° Elevation ${fmtDeg1(el)}°`)

/**
 * 站标签要读的跟踪设置：挂了模型、指定了某颗星、勾了仰角或方位角 → s.track；否则 null（读聚焦集最高仰角）。点标记没有跟踪，恒 null。
 * @param {object} s 地球站对象（{model?, track?: {kind:'sat', satKey, el?, az?}}）
 */
export function labelTrackOf(s) {
  const t = s && s.model ? s.track : null
  return t && t.satKey && (t.el || t.az) ? t : null
}

/**
 * 标签读数串。
 * @param {object|null} trk  labelTrackOf(…) 的结果
 * @param {object|null} trkLook 对跟踪星的读数（解不出为 null）
 * @param {object|null} best 对聚焦集最高那颗的读数（没有聚焦 / 全部解不出为 null）
 */
export function markLabelText(trk, trkLook, best) {
  if (trk) {
    if (!trkLook || !fin(trkLook.elDeg)) return ''
    return trk.az && fin(trkLook.azDeg) ? azElText(trkLook.azDeg, trkLook.elDeg) : elevText(trkLook.elDeg)
  }
  return best && fin(best.elDeg) ? elevText(best.elDeg) : ''
}
