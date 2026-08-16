// NGSO / 再生式 —— 卫星树（纯轨道来源）。
//
// 树本身由主窗口「星座3D」页持久化到 localStorage('globe3d/settings').grd（同源共享，无需 IPC，
// 与 StationGrid 读 markers 同法）；实时关联星(linked/orbit)的当前位置另存于 globe3d/grdLive。
// 本模块只取【定轨所需】的字段：星名 / 星下点快照 / 轨道来源（NORAD 号、OMM、经典六根数）。
//
// ★ 为什么不再带天线（v1.4.5）：NGSO 与再生式曾按 GRD 方向图自动回填卫星 EIRP / G·T，三个链路预算
//   窗口各按各的口径取值——GEO 在站点位置直接取、NGSO 取「t* 星下点 → 站点」、再生式取「最低仰角
//   离轴角环上的最大值」，同一副方向图同一个站能读出三个不同的数。NGSO/再生式的方向图取值因此整体
//   删除：这两个体制的卫星 EIRP / G·T 改为链路表逐站手填（几何本身也分「手动仰角+斜距」与
//   「自动最差工况」两种模式，见各窗口的「几何」开关）。GEO 窗口的方向图取值不受影响（口径正确），
//   仍走 src/linkbudget/grdParam.js + src/shared/lbGrdImport.js。

const GEO_ALT = 35786   // GEO 标称高度（km），与 useGrdCoverage 预置星一致

/**
 * 读取主窗口持久化的卫星树，作 NGSO / 再生式的轨道来源。
 * 不按 antennas 过滤——选星是为了定轨道，有没有方向图与此无关。
 * @returns {{sats: Array<{folder,satName,lon,lat,altKm,live,noradId,kind,elements,omm}>}}
 */
export function loadSatTree() {
  let rawSettings = '', rawLive = ''
  try { rawSettings = localStorage.getItem('globe3d/settings') || '' } catch (e) { rawSettings = '' }
  try { rawLive = localStorage.getItem('globe3d/grdLive') || '' } catch (e) { rawLive = '' }
  let grd = null
  try { grd = JSON.parse(rawSettings || 'null')?.grd } catch (e) { grd = null }
  let live = {}
  try { live = JSON.parse(rawLive || 'null')?.pos || {} } catch (e) { live = {} }
  const sats = ((grd && grd.sats) || []).map((s) => {
    const lp = live[s.folder]   // 该星的实时位置（仅 linked/orbit 有）
    return {
      folder: s.folder, satName: s.satName || s.folder,
      lon: lp ? Number(lp.lon) : (Number(s.lon) || 0),
      lat: lp ? Number(lp.lat) : (Number(s.lat) || 0),
      altKm: lp ? Number(lp.altKm) : (Number(s.altKm) || GEO_ALT),
      live: !!lp,
      // 轨道来源（经典六根数 / OMM / NORAD 号）：供链路预算按真实轨道做 SGP4 互视最差几何；
      // 无轨道信息的星（如 GEO 预置）退化为按星下点高度作静止几何（见各窗口的 treeNodeOrbit）。
      noradId: s.noradId || null, kind: s.kind || '', elements: s.elements || null, omm: s.omm || null
    }
  })
  return { sats }
}
