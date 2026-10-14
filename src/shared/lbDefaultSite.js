// 链路预算 · 默认站址的降雨率 / 海拔（GSO / NGSO / 再生式三窗共用，纯函数，不碰 Vue）。
//
// 由来：站址经纬度两格都留空时，引擎按默认站址（packages/core/utils/defaultSite.js 的 DEFAULT_SITE，北京）
// 算几何与传播，但 R0.01% / 海拔留空时引擎按 0 算——几何在北京、降雨率却是 0，把可用度改成 < 100 雨衰仍是 0。
// 降雨率 / 海拔原本只在选址或改经纬度时由 fillGeoRow → geoFill 自动补，留空站址从不触发。
//
// 口径（与雨衰页「灰字 = 留空时实际入算的值」同一条，见 src/rain/rainParams.js 的 DEFAULTS / pick / effectiveRow）：
//   · 某一侧（发 / 收）经纬度两格都留空、且该侧 R0.01% / 海拔格也留空 → 按默认站址的 ITU 取值入算，表内灰字照显这个值；
//   · 其余一律不动：用户填过的格（含手填 0）原样入算；站址填了的行，R0.01% / 海拔留空仍按引擎原口径（0）——
//     这些行的入参与计算结果逐位不变（withDefaultSite 原样返回同一个对象）。
//   · 取值 geo 来自 IPC link:defaultSiteGeo（core.defaultSiteGeo）：查询点就是引擎的回退经纬度本身，二者同源。
//     取不到（未激活 / 数据未就绪 / 老 preload）时为 null，一切照旧。
//   · 出厂行（新建配置自带的那一行 / 新装模块的首行）站址本就写着默认站址：seedDefaultSite 把它的 R0.01% / 海拔
//     按同一组取值写进去（相当于替用户选了一次北京）；isDefaultSiteSeed 让「没动过的出厂行」判据认得这两个值。
// 不新增存档字段：留空就是留空，入算值在组参时现补。

// 站址组：发 / 收两侧各一组（键名三窗一致；再生式发信站表只有发侧、收信站表只有收侧，调用方按表传 sides）
export const TX_SITE = Object.freeze({ lon: 'longitude', lat: 'latitude', rain: 'rainRate', alt: 'altitude' })
export const RX_SITE = Object.freeze({ lon: 'rxLongitude', lat: 'rxLatitude', rain: 'rxRainRate', alt: 'rxAltitude' })
export const BOTH_SITES = Object.freeze([TX_SITE, RX_SITE])

const blank = (v) => v == null || String(v).trim() === ''
const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

// 默认站址的取值 → 存值字符串（与 fillGeoRow 写格的写法一致：String(数值)）；取不到为 null
function geoStr(geo, which) {
  const v = geo ? num(geo[which]) : null
  return v == null ? null : String(v)
}
const sideOfKey = (key, sides) => (sides || BOTH_SITES).find((s) => s.rain === key || s.alt === key) || null
const whichOf = (s, key) => (key === s.rain ? 'rainRate' : 'altitude')

// 这一侧是否按默认站址入算：经纬度两格都留空（引擎此时两项都取 DEFAULT_SITE）
export function siteDefaulted(row, side) {
  return !!row && blank(row[side.lon]) && blank(row[side.lat])
}

// 某格留空时实际入算的值：仅「该侧经纬度都留空 + 该格留空」时返回默认站址的 ITU 取值（字符串），其余 null（= 原口径）。
// 表格灰字占位与组参补值共用这一处。
export function defaultSiteValue(row, key, geo, sides) {
  const s = sideOfKey(key, sides)
  if (!s || !row || !blank(row[key]) || !siteDefaulted(row, s)) return null
  return geoStr(geo, whichOf(s, key))
}

// 行 → 入算行：补上默认站址的 R0.01% / 海拔后的浅拷贝；没有可补的格就原样返回同一个对象（入参逐位不变）
export function withDefaultSite(row, geo, sides) {
  if (!row || !geo) return row
  let out = null
  for (const s of (sides || BOTH_SITES)) {
    for (const key of [s.rain, s.alt]) {
      const v = defaultSiteValue(row, key, geo, [s])
      if (v == null) continue
      if (!out) out = { ...row }
      out[key] = v
    }
  }
  return out || row
}

// 出厂行：站址写着默认站址的经纬度时，把 R0.01% / 海拔按默认站址的取值写进去（取不到的那项保持原值）。就地改、返回同一行。
export function seedDefaultSite(row, geo, sides) {
  if (!row || !geo) return row
  const at = (v, d) => num(v) != null && num(v) === num(d)
  for (const s of (sides || BOTH_SITES)) {
    if (!(s.lat in row) && !(s.lon in row)) continue
    if (!at(row[s.lat], geo.lat) || !at(row[s.lon], geo.lon)) continue
    const r = geoStr(geo, 'rainRate'), a = geoStr(geo, 'altitude')
    if (r != null) row[s.rain] = r
    if (a != null) row[s.alt] = a
  }
  return row
}

// 「没动过的出厂行」判据用：v 是否正是 seedDefaultSite 给 key 写进去的那个值
export function isDefaultSiteSeed(key, v, geo, sides) {
  const s = sideOfKey(key, sides)
  if (!s) return false
  const g = geoStr(geo, whichOf(s, key))
  return g != null && String(v == null ? '' : v).trim() === g
}

// IPC 取值 → geo（{ lat, lon, rainRate, altitude }）；取不到 / 未激活（{ locked:true }）一律 null
export async function loadDefaultSiteGeo(api) {
  try {
    const lb = api && api.linkBudget
    if (!lb || typeof lb.defaultSiteGeo !== 'function') return null
    const g = await lb.defaultSiteGeo()
    if (!g || g.locked || num(g.lat) == null || num(g.lon) == null) return null
    return { lat: num(g.lat), lon: num(g.lon), rainRate: num(g.rainRate), altitude: num(g.altitude) }
  } catch (e) {
    return null
  }
}
