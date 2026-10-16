// 可编程波束地图 · 数据模型：脚本里的全局 `data`（BeamMap）。
//
// 输入是 3D 页按「所见即所得」采集的原始件（见 ConstellationMap3D.vue 的 collectBeamMapRaw）：
//   library     覆盖库来源的波束（GXT / KML 导入或内置），等值线带【屏上那一档的颜色】
//   antenna     天线方向图（GRD）来源的波束（useGrdCoverage.exportContours，与屏上同一份等值线）
//   polygons    显示中的 Polygon（协调区多边形）
//   points / stations / trajectories   标记层（点标记 / 地球站 / 航迹）
//   meta        { app, version, simTime(ms), lang, scope?, title? }
// 另一来源是文件管理「GXT/KML 管理」页：库里的波束不经绘制直接给（见 coverageLib.js），只有 library，scope = 'library'。
// 输出是稳定、文档化、可结构化克隆的纯数据。★ 字段名就是公开 API（类型声明见 dts.js）：改名 = 打断用户脚本，
// 只增不改；要改先升 MODEL_VERSION 并在 dts.js 里标注。
//
// 口径：
//   · 经纬度一律 WGS-84 十进制度，[lon, lat]；轨道位置东经为正（西经为负）。
//   · 等值线点列原样给出（不补也不删闭合点），是否首尾相接看 closed。
//   · 数值：覆盖库 EIRP → dBW、G/T → dB/K；天线方向图绝对档且无增益偏置 / 路损 → dBi，其余 → dB。

export const MODEL_VERSION = 1

const num = (v) => { const n = typeof v === 'number' ? v : (v == null || String(v).trim() === '' ? NaN : Number(v)); return Number.isFinite(n) ? n : null }
const str = (v) => (v == null ? '' : String(v))
// 颜色归一成 #rrggbb：覆盖库 / Polygon 是 #hex，天线方向图档位色是 rgb(r,g,b)（grd/colormap.js 的 rgbCss）
function hex6(c, fb) {
  const s = str(c).trim()
  let m = /^#?([0-9a-fA-F]{6})$/.exec(s)
  if (m) return '#' + m[1].toLowerCase()
  m = /^#([0-9a-fA-F]{3})$/.exec(s)
  if (m) return '#' + m[1].split('').map((x) => x + x).join('').toLowerCase()
  m = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)/i.exec(s)
  if (m) return '#' + [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(+v))).toString(16).padStart(2, '0')).join('')
  return fb
}
// 点列拷成纯数组（入参常是 Vue 响应式 Proxy；结构化克隆过不了 Proxy）。剔掉坐标非有限的点
function ptsOf(p) {
  const out = []
  for (const q of (p || [])) {
    const lon = Array.isArray(q) ? q[0] : (q && q.lon), lat = Array.isArray(q) ? q[1] : (q && q.lat)
    if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat])
  }
  return out
}
const isClosed = (pts) => pts.length >= 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]
const UNIT_OF_TYPE = { EIRP: 'dBW', GT: 'dB/K' }
// meta.title 是给输出文件 / 文档起名用的（模板 `${data.meta.title}.gxt`）：Windows 文件名禁用字符与控制字符折成「-」
const titleOf = (v) => str(v).replace(/\s*[\\/:*?"<>|\u0000-\u001f][\s\\/:*?"<>|\u0000-\u001f]*/g, '-').replace(/\s+/g, ' ').trim().replace(/^[.\s-]+|[.\s-]+$/g, '')

function contoursOf(list, fbColor) {
  const out = []
  for (const c of (list || [])) {
    const level = num(c && c.g)
    const points = ptsOf(c && c.p)
    if (level == null || points.length < 2) continue
    const o = { level, points, closed: isClosed(points), color: hex6(c.color, fbColor) }
    if (c.name) o.name = str(c.name)
    out.push(o)
  }
  return out
}
// 波束中心：[lon, lat] 或带电平的 [lon, lat, gain]（gxt/parse.js、gxt/json.js 读出的口径）→ { lon, lat, value? }
function peaksOf(bore) {
  const out = []
  for (const q of (bore || [])) {
    const lon = Array.isArray(q) ? q[0] : (q && q.lon), lat = Array.isArray(q) ? q[1] : (q && q.lat)
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    const v = Array.isArray(q) ? q[2] : (q.value != null ? q.value : q.gain)
    const o = { lon, lat }
    if (Number.isFinite(v)) o.value = v
    out.push(o)
  }
  return out
}

export function buildBeamMap(raw = {}) {
  const beams = []
  let i = 0
  for (const b of (raw.library || [])) {
    const type = str(b.type || 'EIRP')
    const contours = contoursOf(b.contours, '#3b82f6')
    if (!contours.length && !(b.bore && b.bore.length)) continue
    beams.push({
      id: 'b' + (++i), source: 'library',
      satellite: str(b.satName), orbitLon: num(b.lon), name: str(b.beam != null ? b.beam : b.name),
      band: str(b.band), type, unit: UNIT_OF_TYPE[type] || '',
      peaks: peaksOf(b.bore), contours
    })
  }
  for (const b of (raw.antenna || [])) {
    const contours = contoursOf(b.contours, '#3b82f6')
    if (!contours.length) continue
    const ctype = str(b.ctype || 'abs')
    const plain = ctype === 'abs' && !(num(b.gainOffset)) && (!b.pathLoss || b.pathLoss === 'none')
    // 峰值点电平按等值线类型折成与 level 同一口径：绝对档 = 峰值 dB，相对峰值 = 0，相对输入值 = 峰值 − 参考
    const peaks = peaksOf(b.bore)
    const pk = num(b.peak)
    if (pk != null) {
      const v = ctype === 'rel' ? 0 : ctype === 'relInput' ? (num(b.refDb) != null ? +(pk - num(b.refDb)).toFixed(2) : null) : pk
      if (v != null) for (const p of peaks) if (p.value == null) p.value = v
    }
    beams.push({
      id: 'b' + (++i), source: 'antenna',
      satellite: str(b.satName), orbitLon: num(b.lon), name: str(b.name),
      band: '', type: '', unit: plain ? 'dBi' : 'dB',
      peaks, contours,
      antenna: {
        name: str(b.antName), contourType: ctype, refLevel: num(b.refDb), peak: num(b.peak),
        polarization: str(b.pol), gainOffset: num(b.gainOffset) || 0, pathLoss: str(b.pathLoss || 'none')
      }
    })
  }

  const polygons = []
  let k = 0
  for (const pg of (raw.polygons || [])) {
    const points = ptsOf(pg.pts)
    if (points.length < 3) continue
    // 内部点列不含闭合重复点（导出时才补）；万一带了就去掉，保证口径一致
    if (isClosed(points)) points.pop()
    const color = hex6(pg.color, '#3b82f6')
    polygons.push({
      id: 'p' + (++k), name: str(pg.name), value: str(pg.value).trim(), level: num(pg.value),
      color, width: num(pg.width) || 2,
      fill: { on: pg.fillOn !== false, color: hex6(pg.fillColor, color), opacity: num(pg.fillOp) != null ? num(pg.fillOp) : 0.18 },
      satellite: str(pg.satName).trim(), orbitLon: num(pg.satLon), points
    })
  }

  const markOf = (m, j, pre) => {
    const lon = num(m && m.lon), lat = num(m && m.lat)
    if (lon == null || lat == null) return null
    const o = { id: pre + (j + 1), name: str(m.name).trim(), lon, lat }
    if (num(m.alt) != null) o.alt = num(m.alt)
    if (m.color) o.color = hex6(m.color, null)
    return o
  }
  const points = (raw.points || []).map((m, j) => markOf(m, j, 'm')).filter(Boolean)
  const stations = (raw.stations || []).map((m, j) => markOf(m, j, 's')).filter(Boolean)
  const trajectories = []
  for (const [j, t] of (raw.trajectories || []).entries()) {
    const pts = []
    for (const p of (t.pts || [])) {
      const lon = num(p && p.lon), lat = num(p && p.lat)
      if (lon == null || lat == null) continue
      const o = { lon, lat }
      if (num(p.alt) != null) o.alt = num(p.alt)
      if (num(p.tMs) != null) o.time = new Date(num(p.tMs)).toISOString()
      pts.push(o)
    }
    if (pts.length) trajectories.push({ id: 't' + (j + 1), name: str(t.name), kind: str(t.kind), points: pts })
  }

  const m = raw.meta || {}
  const simMs = num(m.simTime)
  const lang = m.lang === 'en' ? 'en' : 'zh'
  return {
    version: MODEL_VERSION,
    beams, polygons, points, stations, trajectories,
    meta: {
      app: str(m.app || '卫星仿真平台'), appVersion: str(m.version),
      simTime: simMs != null ? new Date(simMs).toISOString() : null,
      createdAt: new Date(num(m.createdAt) != null ? num(m.createdAt) : Date.now()).toISOString(),
      lang, datum: 'WGS-84',
      scope: m.scope === 'library' ? 'library' : 'drawing',
      title: titleOf(m.title) || (lang === 'en' ? 'Current drawing' : '当前绘制')
    }
  }
}

/** 读数行用：「N 个波束 · N 条等值线 · N 个 Polygon · N 个标记」 */
export function beamMapStats(map) {
  const beams = (map && map.beams) || []
  let contours = 0, pts = 0
  for (const b of beams) { contours += b.contours.length; for (const c of b.contours) pts += c.points.length }
  return {
    beams: beams.length, contours, vertices: pts,
    polygons: ((map && map.polygons) || []).length,
    markers: ((map && map.points) || []).length + ((map && map.stations) || []).length,
    trajectories: ((map && map.trajectories) || []).length
  }
}
