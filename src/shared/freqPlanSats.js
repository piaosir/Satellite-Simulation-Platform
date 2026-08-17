// 卫星树读取（频率计划窗口 / 文件区共用）。
//
// 频率计划挂在【卫星】下、与 GRD 天线平级，所以宿主必须是同一棵树——这里读的正是覆盖分析那棵：
//   · globe3d/settings 的 .grd.sats  —— 3D 页整体快照（含天线，预置星也在内）
//   · globe3d/grdSats               —— 用户在覆盖分析里自建的卫星（不含天线，天线走磁盘重建）
// 两者按 folder 去重合并（快照优先，它带天线）。同源 localStorage 直读，与 grdParam.js 同法，
// 不走 IPC——独立窗口与主窗口同 origin，读的就是同一份。

import { fmtGeoSlot } from './orbitClass.js'

const GEO_ALT = 35786

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null }
}

/** 返回 [{ folder, satName, lon, lat, altKm, kind, antennaCount }]，按卫星名排序 */
export function loadSatNodes() {
  const out = []
  const seen = new Set()
  const push = (s, kind, antennaCount) => {
    if (!s || !s.folder || seen.has(s.folder)) return
    seen.add(s.folder)
    out.push({
      folder: s.folder,
      satName: s.satName || s.folder,
      lon: Number(s.lon) || 0,
      lat: Number(s.lat) || 0,
      altKm: Number(s.altKm) || GEO_ALT,
      kind: kind || s.kind || 'custom',
      antennaCount: antennaCount || 0
    })
  }
  const snap = readJson('globe3d/settings')
  for (const s of (snap && snap.grd && snap.grd.sats) || []) push(s, s.kind, (s.antennas || []).length)
  for (const s of readJson('globe3d/grdSats') || []) push(s, s.kind, 0)
  out.sort((a, b) => String(a.satName).localeCompare(String(b.satName), 'zh-Hans-CN'))
  return out
}

export function findSatNode(folder) {
  return loadSatNodes().find((s) => s.folder === folder) || null
}

/** 卫星显示名（带轨位，GEO 星在列表里靠轨位区分同名星）。°E/°W 折算（西经不再写成负°E）；
 *  lon===0 视为未设置（Number(null)=0 陷阱），不标。 */
export function satLabel(node) {
  if (!node) return '（未归属卫星）'
  const lon = Number(node.lon)
  return Number.isFinite(lon) && lon !== 0 ? `${node.satName}（${fmtGeoSlot(lon)}）` : node.satName
}
