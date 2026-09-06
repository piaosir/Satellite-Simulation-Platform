// 星座地图页的「坐标系」档位：大地基准 / 坐标格式 / 2D 画面中心经度。
//
// ★ 铁律：这三项只作用于【显示与输入】。平台内部一律 WGS-84 十进制度、地固系；
//   换基准、换格式、换画面中心，导出的 KML / Excel / GXT / GRD / ITU 报告 / 小程序通信
//   必须与切换前字节一致。本文件不参与任何计算，只提供「往外出」和「往里填」两端的换算。
//
// 单独成 store 是因为光标经纬度读数在 App.vue 的状态栏（与 stores/cursor 同一条路），
// 而档位由星座地图页的侧栏设置 —— 两处要读同一份。
import { reactive } from 'vue'
import { toDisplay, fromDisplay, isDatum, datumZh } from '../viz/geo/datum.js'
import { formatLonLat, parseLonLat, isFormat } from '../viz/geo/coordFormat.js'
import { isProjection, DEFAULT_PROJECTION, ALBERS_PARALLELS } from '../viz/geo/projection.js'

export const mapCrs = reactive({
  datum: 'wgs84',     // wgs84 | cgcs2000 | gcj02
  fmt: 'deg',         // deg | dms | utm | mgrs | gk3 | gk6
  lon0: -30,          // 2D 平面图的切口（左边缘）经度 = 画面中心经度 − 180；UI 只出画面中心
  // 2D 投影档（见 viz/geo/projection.js）。与 lon0 同一族：只改平面图怎么画，不进任何计算 ——
  // 覆盖场的数值、链路预算、导出的 KML/Excel/GXT 都与换档前字节一致。
  proj: DEFAULT_PROJECTION,
  // 逐投影的可调参数（PROJ_PARAMS 说明了哪档认哪个）。与 proj / lon0 同族，同样不进计算。
  lat0: 0,                        // 投影中心纬度：方位等距的圆心（配上 lon0+180 那个经度）
  par1: ALBERS_PARALLELS[0],      // 圆锥的两条标准纬线
  par2: ALBERS_PARALLELS[1],
  // ── 星下点 ────────────────────────────────────────────────────────────────
  // 图上画一个标记，光标的 az/el·u/v 读数按它算，方位等距的圆心也钉在它上面。三种来源：
  //   manual  直接给一对经纬度，定住不动
  //   sat     目录里的真实卫星（搜索选的），位置每拍按时钟解算
  //   tree    覆盖图卫星树里的节点，位置走 satLivePos（关联星同样跟时钟走）
  // ★ sat / tree 【只存身份】，位置绝不存快照 —— 存了的话时间轴一走，标记和读数就都是错的。
  subPt: null,                    // { src:'manual', lon, lat } | { src:'sat', id, name } | { src:'tree', folder, name }
  // 跟随：星下点动的时候，画面（投影中心）要不要跟着走。手动拖画面即自动关掉 —— 否则下一拍就被拉回去。
  subFollow: true,
  // 光标额外读数档：off 只有经纬度 ｜ azel 天线系方位/仰角 ｜ uv 同一方向的方向余弦
  lookMode: 'off'
})
export const MAP_CRS_DEF = {
  datum: 'wgs84', fmt: 'deg', lon0: -30, proj: DEFAULT_PROJECTION,
  lat0: 0, par1: ALBERS_PARALLELS[0], par2: ALBERS_PARALLELS[1],
  subPt: null, subFollow: true, lookMode: 'off'
}
export const LOOK_MODES = [
  { k: 'off', zh: '关', en: 'Off' },
  { k: 'azel', zh: 'az/el', en: 'az/el' },
  { k: 'uv', zh: 'u/v', en: 'u/v' }
]
export const isLookMode = (k) => LOOK_MODES.some((m) => m.k === k)

// 切口 ⇄ 画面中心（差 180°，各自折回 ±180）
const wrap180 = (v) => ((v + 180) % 360 + 360) % 360 - 180
export const centerToLon0 = (c) => wrap180(Number(c) - 180)
export const lon0ToCenter = (l) => wrap180(Number(l) + 180)

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
export const GEO_ALT_KM = 35786   // 手动星下点的缺省高度（GEO），与平台其它几何同口径

export function setMapCrs(patch) {
  if (!patch) return
  if (isDatum(patch.datum)) mapCrs.datum = patch.datum
  if (isFormat(patch.fmt)) mapCrs.fmt = patch.fmt
  if (Number.isFinite(patch.lon0)) mapCrs.lon0 = wrap180(patch.lon0)
  if (isProjection(patch.proj)) mapCrs.proj = patch.proj
  // ★ 这三项一律「给了才写」：换档之前存的档案里没有它们，读回来就得保持出厂值，
  //   不能因为 patch 里是 undefined 就把中心纬度冲成 NaN。
  if (Number.isFinite(patch.lat0)) mapCrs.lat0 = clamp(patch.lat0, -90, 90)
  if (Number.isFinite(patch.par1)) mapCrs.par1 = clamp(patch.par1, -89.5, 89.5)
  if (Number.isFinite(patch.par2)) mapCrs.par2 = clamp(patch.par2, -89.5, 89.5)
  // subPt 允许显式置 null（取消星下点），故判的是「这个键在不在 patch 里」
  if ('subPt' in patch) mapCrs.subPt = normSubPt(patch.subPt)
  if (typeof patch.subFollow === 'boolean') mapCrs.subFollow = patch.subFollow
  if (isLookMode(patch.lookMode)) mapCrs.lookMode = patch.lookMode
}
// 星下点入库前规整：认不出来源就当没设，免得存档里一个半拉子对象让读数逻辑到处判空
function normSubPt(v) {
  if (!v || typeof v !== 'object') return null
  if (v.src === 'manual') {
    const lon = Number(v.lon), lat = Number(v.lat), alt = Number(v.alt)
    // ★ 高度不是可有可无的：az/el·u/v 是【从卫星看】的角，只给经纬度算不出来。缺省按 GEO。
    return (Number.isFinite(lon) && Number.isFinite(lat))
      ? { src: 'manual', lon: wrap180(lon), lat: clamp(lat, -90, 90), alt: Number.isFinite(alt) && alt > 0 ? alt : GEO_ALT_KM } : null
  }
  if (v.src === 'sat' && v.id != null) return { src: 'sat', id: String(v.id), name: String(v.name || '') }
  if (v.src === 'tree' && v.folder != null) return { src: 'tree', folder: String(v.folder), name: String(v.name || '') }
  return null
}
// 投影参数打包（喂给 makeProjection / flatCoverage）
export const projOpts = () => ({ lat0: mapCrs.lat0, par1: mapCrs.par1, par2: mapCrs.par2 })

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
