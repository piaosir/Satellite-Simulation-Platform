// 可见性分析（复刻 STK Access / Coverage）—— 组合式逻辑层（仿 useBeamSynth）。
// 职责：面板状态 + 目标点归约 + 单时刻可见性计算（recompute）+ 地图叠加 spec（overlaySpec）+ KPI 摘要 + 结果排序。
// 卫星集统一取「当前显示的星」(renderEntries)——筛选在星座页搜索里做（搜索即筛选显示），本面板不再自持临时组。
// 纯几何在 visibility.js；本层只做编排与宿主接线，宿主能力全经参数注入。
//
// 交付节奏：P1 = 瞬时可见（本文件）。P2 时段表 / P3 覆盖热力图 复用同一「选目标 → 算仰角」地基。
import { ref, shallowRef, computed, watch } from 'vue'
import sat from '../constellation/satellite.js'
import { computeVisibility, accessWindows, orbitCanReach, ringCentroid } from './visibility.js'
import { makeCoverageGrid, createCoverageRun, buildCoverageFillBands, estimateCoverageWork, fomMeta, COVERAGE_FOMS } from './coverageGrid.js'
import { schemeColorsRGB } from '../grd/colormap.js'

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
  calcAt, ccTimeAt, isCustomEntry, refresh, drawCov, setCovAlpha
}) {
  const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
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
  // ==================== 覆盖分析（Coverage / FOM）——「覆盖」模式（复刻 STK Coverage，与 access 同级）====================
  const covRegionKind = ref('global')   // 区域：'global' 全球 | 'bounds' 自定义边界 | 'poly' Polygon 区域
  const covLatMin = ref(-60), covLatMax = ref(60), covLonMin = ref(-180), covLonMax = ref(180)
  const covPolyId = ref('')             // poly 区域选中的 Polygon id
  const covStep = ref(5)                // 网格步长（度）
  const covHorizonH = ref(6)            // 分析时窗（小时）——覆盖计算重，默认比 access 短
  const covSample = ref(60)             // 时间采样步长（秒）
  const covFom = ref('percent')         // 当前显示的 FOM
  const covScheme = ref('turbo')        // 配色方案
  const covAlpha = ref(0.82)            // 热力图透明度
  const covBands = ref(12)              // 分带档数
  const covBusy = ref(false)
  const covMsg = ref('')
  const covData = shallowRef(null)      // 结果：{ N, cells, step, T, sampleSec, minElevDeg, satActive, fom:{...} }（重数据，整体替换、不深度响应）

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
    if (mode.value === 'coverage') { results.value = []; return }   // 覆盖模式只看热力图，不算/不画逐星可见标记
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
    if (!open.value || mode.value === 'coverage') return null   // 覆盖模式：只留热力图，不画目标点/可见星标记
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
  function setMode(m) { mode.value = (m === 'access' || m === 'coverage') ? m : 'now'; recompute(); drawCovNow(); refresh(); persist() }

  // ---- 覆盖分析（Coverage / FOM）：撒网格 → 对每胞元跑资产集可见性 → 汇成 FOM → 分帧异步（进度+取消）→ 热力图 ----
  const COV_MAX_WORK = 2.5e8   // 散射法计算量上限（≈传播×10 + 扫描）：超过请缩小（防冻结）。~对应上千万次传播、几十秒封顶
  let _covToken = 0
  function covRegionValue() {
    const kind = covRegionKind.value
    if (kind === 'bounds') return { kind: 'bounds', latMin: Number(covLatMin.value), latMax: Number(covLatMax.value), lonMin: Number(covLonMin.value), lonMax: Number(covLonMax.value) }
    if (kind === 'poly') {
      const pg = (getPolys() || []).find((x) => x.id === covPolyId.value)
      const pts = pg && Array.isArray(pg.pts) ? pg.pts.map((q) => (Array.isArray(q) ? [q[0], q[1]] : [q.lon, q.lat])).filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])) : null
      return pts && pts.length >= 3 ? { kind: 'poly', poly: pts } : { kind: 'global' }
    }
    return { kind: 'global' }
  }
  const covDomain = (d, meta) => (meta.fixedDomain ? meta.fixedDomain : null)
  const covBandsFor = (meta) => (meta.binary ? 2 : (Number(covBands.value) || 12))
  function covLayer() {
    const d = covData.value
    if (!d) return null
    const meta = fomMeta(covFom.value), values = d.fom[covFom.value]
    if (!values) return null
    const { fillBands, lo, hi } = buildCoverageFillBands({ cells: d.cells, step: d.step }, values, { scheme: covScheme.value, bands: covBandsFor(meta), domain: covDomain(d, meta), zeroTransparent: meta.zeroTransparent })
    return { id: 'covfom', name: 'Coverage', fillBands, alpha: Number(covAlpha.value) || 0.82, lo, hi, unit: meta.unit }
  }
  // 依当前模式/数据把热力图画上（或清掉）——统一出口，随算随画、切模式即显隐
  function drawCovNow() {
    if (!drawCov) return
    drawCov((open.value && mode.value === 'coverage' && covData.value) ? covLayer() : null)
  }
  function computeCoverage() {
    const region = covRegionValue()
    const grid = makeCoverageGrid(region, Number(covStep.value) || 5)
    if (!grid.cells.length) { covData.value = null; covMsg.value = '该区域没有网格胞元（检查边界 / Polygon）'; drawCovNow(); return }
    const srcAll = getRenderEntries() || []
    if (!srcAll.length) { covData.value = null; covMsg.value = '卫星集为空（在「星座」视图搜索显示卫星）'; drawCovNow(); return }
    const me = Number(minElev.value) || 0
    const horizonSec = clampN(Number(covHorizonH.value) || 6, 0.1, 168) * 3600
    const sampleSec = clampN(Number(covSample.value) || 60, 5, 600)
    const T0 = Math.floor(horizonSec / sampleSec) + 1
    if (estimateCoverageWork(grid.cells.length, srcAll.length, horizonSec, sampleSec) > COV_MAX_WORK) {
      covData.value = null
      covMsg.value = `计算量过大（${grid.cells.length.toLocaleString()} 格 × ${srcAll.length.toLocaleString()} 星 × ${T0.toLocaleString()} 采样）——请增大网格步长 / 缩短时窗 / 增大采样步长，或在「星座」筛选卫星`
      drawCovNow(); return
    }
    covBusy.value = true; covData.value = null; covMsg.value = `覆盖计算… 0 / ${T0}`; drawCovNow()
    const token = ++_covToken
    const now = calcAt(), ccNow = ccTimeAt(now)
    const ents = srcAll.map((e) => ({ rec: e.rec, name: e.name, noradId: e.noradId, group: e.group, _cc: !!isCustomEntry(e) }))
    let run
    try { run = createCoverageRun(ents, grid, { now, ccNow }, { horizonSec, minElevDeg: me, sampleSec }) } catch (e) { covBusy.value = false; covMsg.value = '计算失败：' + ((e && e.message) || e); return }
    const T = run.T, perSample = Math.max(1, grid.cells.length * Math.max(1, run.activeCount))
    const BATCH = clampN(Math.round(3e6 / perSample), 1, 60)
    const stepFn = () => {
      if (token !== _covToken) return   // 已被新一次计算 / 取消作废
      let done
      try { done = run.stepBatch(BATCH) } catch (e) { covBusy.value = false; covMsg.value = '计算失败：' + ((e && e.message) || e); return }
      if (done < T) { covMsg.value = `覆盖计算… ${done} / ${T}`; setTimeout(stepFn, 0) }
      else {
        covData.value = run.finalize(); covBusy.value = false
        covMsg.value = covData.value.satActive ? '' : '卫星集里没有轨道能覆盖该区域的星'
        drawCovNow()
      }
    }
    setTimeout(stepFn, 20)
  }
  function cancelCoverage() { _covToken++; covBusy.value = false; covMsg.value = '' }
  // 图例 / KPI（随 FOM/配色/数据变，不触发重算）
  const covLegend = computed(() => {
    const d = covData.value
    if (!d) return null
    const meta = fomMeta(covFom.value), values = d.fom[covFom.value], dom = covDomain(d, meta)
    let lo, hi
    if (dom) { lo = dom[0]; hi = dom[1] } else {
      lo = Infinity; hi = -Infinity
      for (let i = 0; i < d.N; i++) { const v = values[i]; if (v !== v) continue; if (meta.zeroTransparent && v <= 1e-9) continue; if (v < lo) lo = v; if (v > hi) hi = v }
      if (!(lo <= hi)) { lo = 0; hi = 1 }
    }
    if (hi <= lo) hi = lo + 1
    const bands = covBandsFor(meta)
    return { lo, hi, bands, colors: schemeColorsRGB(covScheme.value, bands), unit: meta.unit, label: meta.label, time: !!meta.time }
  })
  const covKpi = computed(() => {
    const d = covData.value
    if (!d) return null
    const meta = fomMeta(covFom.value), values = d.fom[covFom.value], simple = d.fom.simple, cells = d.cells
    let wCov = 0, wTot = 0, mn = Infinity, mx = -Infinity, sum = 0, cnt = 0
    for (let i = 0; i < d.N; i++) {
      const w = Math.cos(cells[i].lat * Math.PI / 180)
      wTot += w; if (simple[i] > 0) wCov += w
      const v = values[i]; if (v !== v) continue
      if (meta.zeroTransparent && v <= 1e-9) continue
      if (v < mn) mn = v; if (v > mx) mx = v; sum += v; cnt++
    }
    return { coverPct: wTot > 0 ? wCov / wTot * 100 : 0, min: cnt ? mn : 0, max: cnt ? mx : 0, mean: cnt ? sum / cnt : 0, cells: d.N, unit: meta.unit, label: meta.label }
  })

  // ---- 生命周期 ----
  function openPanel() { open.value = true; load(); recompute(); refresh(); drawCovNow() }
  function close() { open.value = false; hoveredId.value = ''; _covToken++; covBusy.value = false; if (drawCov) drawCov(null); refresh() }

  watch([minElev, targetKind, targetId], () => { recompute(); refresh(); persist() })
  watch([iconSize, showName, nameSize, iconColor], () => { refresh(); persist() })   // 星下点样式变：只重绘（不重算）+ 存
  watch([covFom, covScheme, covBands], () => { drawCovNow(); persist() })            // 换指标/配色/档数：只重建热力图（不重算）
  watch(covAlpha, () => { if (setCovAlpha) setCovAlpha(Number(covAlpha.value) || 0.82); persist() })
  watch([covRegionKind, covLatMin, covLatMax, covLonMin, covLonMax, covPolyId, covStep, covHorizonH, covSample], () => persist())   // 区域/参数变：仅存（需手动点「计算」）

  // ---- 持久化（目标选择 + 门限 + 排序 + 覆盖分析参数）----
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
        if (['now', 'access', 'coverage'].includes(d.mode)) mode.value = d.mode   // 记住上次模式（别每次都回瞬时可见）
        const c = d.cov
        if (c && typeof c === 'object') {
          if (['global', 'bounds', 'poly'].includes(c.regionKind)) covRegionKind.value = c.regionKind
          if (Number.isFinite(c.latMin)) covLatMin.value = c.latMin
          if (Number.isFinite(c.latMax)) covLatMax.value = c.latMax
          if (Number.isFinite(c.lonMin)) covLonMin.value = c.lonMin
          if (Number.isFinite(c.lonMax)) covLonMax.value = c.lonMax
          if (typeof c.polyId === 'string') covPolyId.value = c.polyId
          if (Number.isFinite(c.step)) covStep.value = c.step
          if (Number.isFinite(c.horizonH)) covHorizonH.value = c.horizonH
          if (Number.isFinite(c.sample)) covSample.value = c.sample
          if (COVERAGE_FOMS.some((f) => f.key === c.fom)) covFom.value = c.fom
          if (typeof c.scheme === 'string') covScheme.value = c.scheme
          if (Number.isFinite(c.alpha)) covAlpha.value = c.alpha
          if (Number.isFinite(c.bands)) covBands.value = c.bands
        }
      }
    } catch { /* ignore */ }
  }
  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        minElev: Number(minElev.value) || 0, targetKind: targetKind.value, targetId: targetId.value, sortKey: sortKey.value, mode: mode.value,
        iconSize: Number(iconSize.value) || 12, showName: !!showName.value, nameSize: Number(nameSize.value) || 10, iconColor: iconColor.value,
        cov: {
          regionKind: covRegionKind.value, latMin: Number(covLatMin.value), latMax: Number(covLatMax.value), lonMin: Number(covLonMin.value), lonMax: Number(covLonMax.value),
          polyId: covPolyId.value, step: Number(covStep.value) || 5, horizonH: Number(covHorizonH.value) || 6, sample: Number(covSample.value) || 60,
          fom: covFom.value, scheme: covScheme.value, alpha: Number(covAlpha.value) || 0.82, bands: Number(covBands.value) || 12
        }
      }))
    } catch { /* ignore */ }
  }

  return {
    open, minElev, targetKind, targetId, results, sortedResults, hoveredId, sortKey,
    hasTarget, satCount, kpi, skyPoints, skyThrR,
    mode, horizonH, accessResults, accessBusy, accessMsg, computeAccess, setMode,
    iconSize, showName, nameSize, iconColor,
    // 覆盖分析（Coverage）
    covRegionKind, covLatMin, covLatMax, covLonMin, covLonMax, covPolyId, covStep, covHorizonH, covSample,
    covFom, covScheme, covAlpha, covBands, covBusy, covMsg, covData, covLegend, covKpi,
    computeCoverage, cancelCoverage, covFoms: COVERAGE_FOMS,
    targetPoints, recompute, overlaySpec, setHover, setTarget, setSort, openPanel, close
  }
}
