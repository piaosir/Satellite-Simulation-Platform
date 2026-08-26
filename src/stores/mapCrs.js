// 星座地图页的「坐标系」档位：大地基准 / 坐标格式 / 参考系 / 地图切口经度。
//
// ★ 铁律：这四项只作用于【显示与输入】。平台内部一律 WGS-84 十进制度、地固系；
//   换基准、换格式、换参考系、换切口，导出的 KML / Excel / GXT / GRD / ITU 报告 / 小程序通信
//   必须与切换前字节一致。本文件不参与任何计算，只提供「往外出」和「往里填」两端的换算。
//
// 单独成 store 是因为光标经纬度读数在 App.vue 的状态栏（与 stores/cursor 同一条路），
// 而档位由星座地图页的侧栏设置 —— 两处要读同一份。
import { reactive } from 'vue'
import { toDisplay, fromDisplay, isDatum, datumZh } from '../viz/geo/datum.js'
import { formatLonLat, parseLonLat, isFormat } from '../viz/geo/coordFormat.js'

export const mapCrs = reactive({
  datum: 'wgs84',     // wgs84 | cgcs2000 | gcj02
  fmt: 'deg',         // deg | dms | utm | mgrs | gk3 | gk6
  frame: 'ecef',      // ecef 地固 | eci 惯性(J2000)
  lon0: -30           // 2D 平面图的切口（左边缘）经度
})
export const MAP_CRS_DEF = { datum: 'wgs84', fmt: 'deg', frame: 'ecef', lon0: -30 }

export function setMapCrs(patch) {
  if (!patch) return
  if (isDatum(patch.datum)) mapCrs.datum = patch.datum
  if (isFormat(patch.fmt)) mapCrs.fmt = patch.fmt
  if (patch.frame === 'ecef' || patch.frame === 'eci') mapCrs.frame = patch.frame
  if (Number.isFinite(patch.lon0)) mapCrs.lon0 = ((patch.lon0 + 180) % 360 + 360) % 360 - 180
}

// 内部 WGS-84 十进制度 → 显示串（先换基准、再换格式）
export function fmtLL(lon, lat, digits = 2) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return ''
  const [x, y] = toDisplay(lon, lat, mapCrs.datum)
  return formatLonLat(x, y, mapCrs.fmt, digits)
}
// 用户输入串 → 内部 WGS-84 十进制度（先按格式解析、再把基准换回来）
export function parseLL(str) {
  const r = parseLonLat(str, mapCrs.fmt)
  if (!r) return null
  const [x, y] = fromDisplay(r[0], r[1], mapCrs.datum)
  return { lon: x, lat: y }
}
// 读数行里的基准标注：非 WGS-84 时才出（含运行时档位，不是说明文字）
export const datumTag = () => (mapCrs.datum === 'wgs84' ? '' : datumZh(mapCrs.datum))
