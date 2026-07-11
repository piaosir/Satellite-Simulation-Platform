// 链路预算 · GRD 天线取值（卫星树 + Parameter 逐站采样）。
// 卫星树与各天线设置（指向 / 增益偏置 / 极化）由主窗口「星座3D」页持久化到
// localStorage('globe3d/settings').grd（同源共享，无需 IPC——与 StationGrid 读 markers 同法）。
// 导入天线的原始 GRD 存于 userData，经 window.api.coverageGrd.raw(file) 取回文本后用
// parseGrd 解析。取值口径对齐性能指标表 usePerfTable 的「Parameter」列（sampleBeamAt + 天线
// 增益偏置/极化），但填站值恒取【绝对】口径（rel 显示不影响物理 EIRP/G-T）。
// 注：GRD 解析+采样已下沉到主进程（electron/services/grd.js + packages/core/utils/grdSampler.js）。
// 渲染端不再读取/解析 243MB 文本，只通过 IPC 批量收发「经纬度 → dB」。
const GEO_ALT = 35786   // GEO 标称高度（km），与 useGrdCoverage 预置星一致
const api = typeof window !== 'undefined' ? window.api : null

// 读取主窗口持久化的卫星树：NGSO 用星星既可作「天线来源」（导入 EIRP/GT）也可单独作「轨道来源」，
// 二者独立——因此**不按 antennas.length 过滤**（与 GEO 版 grdParam.js 的区别：GEO 面板只需要
// 带天线的星，NGSO 面板选星首先是为了定几何轨道，没导入天线的星也该能选，只是 EIRP/GT 匹配为空）。
// 返回 { sats:[{folder,satName,lon,lat,altKm,antennas:[{name,file,beams,satLon,satLat,satAlt}]}], cfgs:{key→设置} }。
// 实时关联星(linked/orbit)：用主窗口写的 globe3d/grdLive 当前位置覆盖静态快照，做到「导入时取新位置」。
// 不追求持续实时——读取那一刻取最近一次缓存值即可（覆盖分析在跑时每 3s 刷新一次）。
export function loadSatTree() {
  // 仅当 GRD 设置 / 实时星位真正变化时才清缓存重解析；刷新时若数据未变直接复用，省掉整张 GRD 重解析。
  let rawSettings = '', rawLive = ''
  try { rawSettings = localStorage.getItem('globe3d/settings') || '' } catch (e) { rawSettings = '' }
  try { rawLive = localStorage.getItem('globe3d/grdLive') || '' } catch (e) { rawLive = '' }
  let grd = null
  try { grd = JSON.parse(rawSettings || 'null')?.grd } catch (e) { grd = null }
  let live = {}
  try { live = JSON.parse(rawLive || 'null')?.pos || {} } catch (e) { live = {} }
  const sats = ((grd && grd.sats) || []).map((s) => {
    const lp = live[s.folder]   // 该星的实时位置（仅 linked/orbit 有）
    const lon = lp ? Number(lp.lon) : (Number(s.lon) || 0)
    const lat = lp ? Number(lp.lat) : (Number(s.lat) || 0)
    const altKm = lp ? Number(lp.altKm) : (Number(s.altKm) || GEO_ALT)
    return {
      folder: s.folder, satName: s.satName || s.folder, lon, lat, altKm, live: !!lp,
      // NGSO：透传轨道来源（经典六根数 / OMM / NORAD 号），供链路预算按真实轨道做 SGP4 互视最差几何；
      // 无轨道信息的星（如 GEO 预置）退化为按星下点高度作圆轨道近似（见 treeNodeOrbit）。
      noradId: s.noradId || null, kind: s.kind || '', elements: s.elements || null, omm: s.omm || null,
      antennas: ((s.antennas || []).filter((a) => a && a.imported && a.file)).map((a) => ({
        // 实时星：天线基底也用实时位置（覆盖天线记录里的快照 satLon/satLat/satAlt）
        name: a.name, file: a.file, beams: a.beams || 1,
        satLon: lp ? lon : a.satLon, satLat: lp ? lat : a.satLat, satAlt: lp ? altKm : a.satAlt
      }))
    }
  })
  return { sats, cfgs: (grd && grd.cfgs) || {} }
}

// 把天线的卫星几何整理成主进程采样所需的 sat 对象。
// satOverride（{lon,lat,alt}）非空时优先——链路预算传入「最差工况 t* 星下点」，令天线增益
// (EIRP/G·T) 与性能指标表取自同一物理瞬间；缺省才回退天线快照/实时星位（导入时那一刻的位置）。
function satOf(node, ant, satOverride) {
  const o = satOverride
  if (o && Number.isFinite(Number(o.lon))) {
    return { lon: Number(o.lon), lat: Number(o.lat) || 0, alt: Number.isFinite(Number(o.alt)) ? Number(o.alt) : (node.altKm || GEO_ALT) }
  }
  return {
    lon: Number.isFinite(ant.satLon) ? ant.satLon : node.lon,
    lat: Number.isFinite(ant.satLat) ? ant.satLat : (node.lat || 0),
    alt: Number.isFinite(ant.satAlt) ? ant.satAlt : (node.altKm || GEO_ALT)
  }
}

// 对外：取某天线在【一批】经纬度上的「多波束最大 Parameter」（绝对 dB）。
// 解析+采样在主进程完成，一次 IPC 处理所有站点；返回与 points 等长同序的 (number|null)[]。
// satOverride（{lon,lat,alt}）非空时以该卫星位置采样（最差工况 t* 星下点），否则用天线快照位置。
export async function sampleAntennaParams(node, ant, cfg, points, satOverride) {
  const pts = points || []
  if (!api || !node || !ant || !ant.file) return pts.map(() => null)
  try {
    // IPC 载荷必须是可结构化克隆的纯数据：cfg 可能是 Vue 响应式代理（如 regen 把天线设置放在 ref 里，
    // 读到的是 reactive proxy），直接过 IPC 会报「An object could not be cloned」，整次采样落空返 null。
    // 这里统一把 cfg / points 转成纯对象再发（sat 由 satOf 返回的字面量本就是纯数据）。
    const req = {
      file: String(ant.file),
      sat: satOf(node, ant, satOverride),
      cfg: cfg ? JSON.parse(JSON.stringify(cfg)) : {},
      points: pts.map((p) => ({ lon: Number(p.lon), lat: Number(p.lat) }))
    }
    const vals = await api.linkBudget.grdSample(req)
    return Array.isArray(vals) ? vals : pts.map(() => null)
  } catch (e) {
    console.warn('GRD 采样失败', ant.file, e)
    return pts.map(() => null)
  }
}

// 单点便捷封装（保留旧调用点兼容）。satOverride 透传给批量版。
export async function sampleAntennaParam(node, ant, cfg, lon, lat, satOverride) {
  const [v] = await sampleAntennaParams(node, ant, cfg, [{ lon, lat }], satOverride)
  return v == null ? null : v
}
