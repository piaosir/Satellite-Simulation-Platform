// 可见性分析（复刻 STK Access / Coverage）—— 组合式逻辑层（仿 useBeamSynth）。
// 职责：面板状态 + 目标点归约 + 单时刻可见性计算（recompute）+ 地图叠加 spec（overlaySpec）+ KPI 摘要 + 结果排序。
// 卫星集统一取「当前显示的星」(renderEntries)——筛选在星座页搜索里做（搜索即筛选显示），本面板不再自持临时组。
// 纯几何在 visibility.js；本层只做编排与宿主接线，宿主能力全经参数注入。
//
// 交付节奏：P1 = 瞬时可见（本文件）。P2 时段表 / P3 覆盖热力图 复用同一「选目标 → 算仰角」地基。
import { ref, computed, watch } from 'vue'
import sat from '../constellation/satellite.js'
import { computeVisibility, accessWindows, orbitCanReach, ringCentroid } from './visibility.js'

const KEY = 'globe3d/visibility'

// 叠加层配色：目标=冷 cyan（观测者/参考，避开告警暖黄，不与 --warn 打架）、可见星=绿(--ok)、悬停=亮白(--accent)
const TARGET_HEX = 0x35c7e0
const TARGET_PX = 5              // 目标点圆点半径（屏幕 px）：观测参考点，收敛到与拖拽手柄同档，不喧宾夺主盖过可见星
const VIS_HEX = 0x4caf82
const VIS_CSS = '#4caf82'
const HL_HEX = 0xefeae0

// 轨道类别（按轨道高度粗分）：供 KPI 分布与结果表标签
export const orbitClass = (altKm) => (!Number.isFinite(altKm) ? '—' : altKm < 2000 ? 'LEO' : altKm < 34000 ? 'MEO' : altKm < 37000 ? 'GEO' : 'HEO')

export function useVisibility({
  getStations, getPoints, getTrajectories, getPolys, getRenderEntries,
  calcAt, ccTimeAt, isCustomEntry, refresh
}) {
  const open = ref(false)
  const minElev = ref(5)             // 仰角门限（度）
  const targetKind = ref('')         // 'station' | 'point' | 'traj' | 'poly'
  const targetId = ref('')
  const results = ref([])            // 可见星清单（最近一次 recompute，已按仰角降序）
  const hoveredId = ref('')          // 悬停行 → 地图高亮该星（brush-and-link）
  const sortKey = ref('elev')        // 结果表排序：'elev' | 'range' | 'name' | 'class'
  const iconSize = ref(12)           // 星下点图标大小（星多时调小缓解重叠）
  const showName = ref(false)        // 显示卫星名（默认关——Starlink 等星多时名字会糊成一片）
  const nameSize = ref(10)           // 卫星名字号（显示名字时可调）
  const iconColor = ref('#4caf82')   // 星下点图标 / 名字颜色（可自定义；3D 与 2D 一致）
  // ACCESS 时段过境（P2）
  const mode = ref('now')            // 'now'=瞬时可见 | 'access'=时段过境
  const horizonH = ref(24)           // 时段时窗（小时）
  const accessResults = ref([])      // 过境窗口 [{noradId,name,group,windows}]
  const accessBusy = ref(false)
  const accessMsg = ref('')

  // ---- 目标点集归约（站/点=1 个；航迹=点串；Polygon=质心）----
  function targetPoints() {
    const kind = targetKind.value, id = targetId.value
    if (!kind || !id) return []
    if (kind === 'station') { const s = (getStations() || []).find((x) => x.id === id); return s && Number.isFinite(s.lat) && Number.isFinite(s.lon) ? [{ lat: s.lat, lon: s.lon }] : [] }
    if (kind === 'point') { const p = (getPoints() || []).find((x) => x.id === id); return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? [{ lat: p.lat, lon: p.lon }] : [] }
    if (kind === 'traj') { const t = (getTrajectories() || []).find((x) => x.id === id); return t && Array.isArray(t.pts) ? t.pts.filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.lon)).map((q) => ({ lat: q.lat, lon: q.lon })) : [] }
    if (kind === 'poly') { const pg = (getPolys() || []).find((x) => x.id === id); const c = pg && Array.isArray(pg.pts) ? ringCentroid(pg.pts) : null; return c ? [c] : [] }
    return []
  }
  const hasTarget = computed(() => !!(targetKind.value && targetId.value))

  // ---- 卫星集 = 当前显示的星 ----
  const satCount = ref(0)   // recompute 里实时更新（renderEntries 非响应式，computed 追踪不到其变化）

  // ---- 计算可见性（单时刻）----
  function recompute() {
    if (!open.value) { results.value = []; satCount.value = 0; return }
    const src = getRenderEntries() || []
    satCount.value = src.length
    const tp = targetPoints()
    if (!tp.length || !src.length) { results.value = []; return }
    const now = calcAt(), gmst = sat.gstime(now)
    const ccNow = ccTimeAt(now), ccGmst = sat.gstime(ccNow)
    const ents = src.map((e) => ({ rec: e.rec, name: e.name, noradId: e.noradId, group: e.group, _cc: !!isCustomEntry(e) }))
    results.value = computeVisibility(ents, tp, { now, gmst, ccNow, ccGmst }, Number(minElev.value) || 0)
  }

  // ---- 结果表排序视图（recompute 已按仰角降序；此处按用户选择重排展示，不改底层）----
  const sortedResults = computed(() => {
    const rs = results.value.slice(), k = sortKey.value
    if (k === 'range') rs.sort((a, b) => a.rangeKm - b.rangeKm)
    else if (k === 'name') rs.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    else if (k === 'class') rs.sort((a, b) => (b.altKm || 0) - (a.altKm || 0))
    return rs   // 'elev' 保持底层仰角降序
  })

  // ---- KPI 摘要（当前可见数、最高仰角星、轨道类别分布）----
  const kpi = computed(() => {
    const rs = results.value
    if (!rs.length) return { count: 0, top: null, classes: [] }
    const cm = {}
    for (const r of rs) { const c = orbitClass(r.altKm); cm[c] = (cm[c] || 0) + 1 }
    const classes = ['LEO', 'MEO', 'GEO', 'HEO'].filter((c) => cm[c]).map((c) => ({ c, n: cm[c] }))
    return { count: rs.length, top: rs[0], classes }
  })

  // ---- 极坐标 sky 图：方位=角向(自正北顺时针)、仰角=离心(天顶在圆心、地平在外圈)；viewBox 100×100、中心(50,50)、R=44 ----
  const skyPoints = computed(() => results.value.map((r) => {
    const rr = 44 * Math.max(0, 90 - r.elevDeg) / 90, a = r.azDeg * Math.PI / 180
    return { noradId: r.noradId, name: r.name, x: 50 + rr * Math.sin(a), y: 50 - rr * Math.cos(a), hi: r.elevDeg >= 45 }
  }))
  const skyThrR = computed(() => 44 * Math.max(0, 90 - (Number(minElev.value) || 0)) / 90)

  // 地图叠加：目标点（贴地青点）+ 可见星星下点（2D 平面图画卫星图标；3D 因 setSatLayer 不画图标 → 只在 hover 时出名字）。
  // 3D 的在轨立体点 + 目标→星视线斜线由宿主 computeVisibilityGeometry/commitGeometry 走 setSelectionSet 另画（setSatLayer 画不出在轨高度）。
  function overlaySpec() {
    if (!open.value) return null
    const dots = [], sats = []
    for (const t of targetPoints()) dots.push({ lon: t.lon, lat: t.lat, color: TARGET_HEX, px: TARGET_PX, r: TARGET_PX * 0.0018 })
    const hid = String(hoveredId.value || '')
    const m = /^#?([0-9a-f]{6})$/i.exec(String(iconColor.value || '')), iconHex = m ? parseInt(m[1], 16) : VIS_HEX
    for (const r of results.value) {
      if (!Number.isFinite(r.subLon) || !Number.isFinite(r.subLat)) continue
      const hot = hid && String(r.noradId) === hid
      sats.push({ lon: r.subLon, lat: r.subLat, altKm: r.altKm, name: (showName.value || hot) ? r.name : '', color: hot ? HL_HEX : iconHex, nameColor: hot ? '#efeae0' : (iconColor.value || VIS_CSS), iconSize: Number(iconSize.value) || 12, labelSize: Number(nameSize.value) || 10, labelShow: showName.value || hot, iconShow: true })
    }
    return (dots.length || sats.length) ? { dots, sats } : null
  }
  // 悬停某行 → 地图高亮该星（brush-and-link）
  function setHover(noradId) { const v = noradId == null ? '' : String(noradId); if (v !== hoveredId.value) { hoveredId.value = v; refresh() } }

  function setTarget(kind, id) { targetKind.value = kind || ''; targetId.value = id || '' }
  function setSort(k) { sortKey.value = k }

  // ---- ACCESS：几何粗筛（剔到不了目标纬度的星）→ 分帧扫描过境（不冻结 UI + 进度）。大星座（Starlink ~1 万）也能算。----
  const ACCESS_MAX_SATS = 20000   // 粗筛后仍超此数才拦（防极端）；分帧异步避免长扫描冻结页面
  let _accToken = 0               // 取消令牌：重复点击/参数变时作废上一次分帧扫描
  function computeAccess() {
    const tp = targetPoints()
    if (!tp.length) { accessMsg.value = '请先选一个分析目标'; accessResults.value = []; return }
    const srcAll = getRenderEntries() || []
    if (!srcAll.length) { accessMsg.value = '卫星集为空'; accessResults.value = []; return }
    const me = Number(minElev.value) || 0, tgtLat = tp[0].lat
    const src = srcAll.filter((e) => orbitCanReach(e.rec, tgtLat, me))   // 几何粗筛（不传播）
    if (!src.length) { accessResults.value = []; accessMsg.value = '卫星集里没有轨道能覆盖该目标纬度的星'; return }
    if (src.length > ACCESS_MAX_SATS) { accessResults.value = []; accessMsg.value = `候选 ${src.length} 颗过多——请缩短时窗或在「星座」筛选星座`; return }
    accessBusy.value = true; accessResults.value = []; accessMsg.value = `扫描过境… 0 / ${src.length}`
    const token = ++_accToken
    const now = calcAt(), ccNow = ccTimeAt(now)
    const H = Math.max(0.5, Math.min(168, Number(horizonH.value) || 24)) * 3600
    const ents = src.map((e) => ({ rec: e.rec, name: e.name, noradId: e.noradId, group: e.group, _cc: !!isCustomEntry(e) }))
    const BATCH = 400, out = []
    let i = 0
    const stepFn = () => {
      if (token !== _accToken) return   // 已被新的计算作废
      try {
        const part = accessWindows(ents.slice(i, i + BATCH), tp, { now, ccNow }, H, me, { coarseSec: 90 })
        for (const s of part) out.push(s)
      } catch (e) { accessMsg.value = '计算失败：' + ((e && e.message) || e); accessBusy.value = false; return }
      i += BATCH
      if (i < ents.length) { accessMsg.value = `扫描过境… ${i} / ${ents.length}`; setTimeout(stepFn, 0) }
      else {
        out.sort((a, b) => a.windows[0].startMs - b.windows[0].startMs)
        accessResults.value = out; accessBusy.value = false
        accessMsg.value = out.length ? '' : `未来 ${Math.round(H / 3600)}h 内没有过境（门限 ${me}°）`
      }
    }
    setTimeout(stepFn, 20)
  }
  function setMode(m) { mode.value = m === 'access' ? 'access' : 'now' }

  // ---- 生命周期 ----
  function openPanel() { open.value = true; load(); recompute(); refresh() }
  function close() { open.value = false; hoveredId.value = ''; refresh() }

  watch([minElev, targetKind, targetId], () => { recompute(); refresh(); persist() })
  watch([iconSize, showName, nameSize, iconColor], () => { refresh(); persist() })   // 星下点样式变：只重绘（不重算）+ 存

  // ---- 持久化（目标选择 + 门限 + 排序）----
  let _loaded = false
  function load() {
    if (_loaded) return
    _loaded = true
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || 'null')
      if (d && typeof d === 'object') {
        if (Number.isFinite(d.minElev)) minElev.value = d.minElev
        if (typeof d.targetKind === 'string') targetKind.value = d.targetKind
        if (typeof d.targetId === 'string') targetId.value = d.targetId
        if (typeof d.sortKey === 'string') sortKey.value = d.sortKey
        if (Number.isFinite(d.iconSize)) iconSize.value = d.iconSize
        if (typeof d.showName === 'boolean') showName.value = d.showName
        if (Number.isFinite(d.nameSize)) nameSize.value = d.nameSize
        if (typeof d.iconColor === 'string' && /^#[0-9a-f]{6}$/i.test(d.iconColor)) iconColor.value = d.iconColor
      }
    } catch { /* ignore */ }
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify({ minElev: Number(minElev.value) || 0, targetKind: targetKind.value, targetId: targetId.value, sortKey: sortKey.value, iconSize: Number(iconSize.value) || 12, showName: !!showName.value, nameSize: Number(nameSize.value) || 10, iconColor: iconColor.value })) } catch { /* ignore */ }
  }

  return {
    open, minElev, targetKind, targetId, results, sortedResults, hoveredId, sortKey,
    hasTarget, satCount, kpi, skyPoints, skyThrR,
    mode, horizonH, accessResults, accessBusy, accessMsg, computeAccess, setMode,
    iconSize, showName, nameSize, iconColor,
    targetPoints, recompute, overlaySpec, setHover, setTarget, setSort, openPanel, close
  }
}
