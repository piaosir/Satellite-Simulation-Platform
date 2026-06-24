// 覆盖图（GRD）逻辑 —— SATSOFT 模型：卫星 → 天线（命名覆盖）。支持多选卫星/天线。
// 选中的天线各成一层渲染到星座3D 的 scene/flat（独立图层）：所有选中天线画等值线；
// 当前聚焦(active)天线额外画分带填充。计算核心 src/viz/grd/{parse,coverage,colormap}.js。
import { ref, reactive, watch } from 'vue'
import { parseGrd } from './parse.js'
import { antennaBasis, projectGrid, fieldDb, contourLines, gridDir, project } from './coverage.js'
import { schemeColorsRGB, rgbCss, cssRgb } from './colormap.js'
import { geodeticToEcef, elevationDeg, RS_GEO, A } from '../wgs84.js'

const H = RS_GEO - A
const GEO_ALT = 35786              // GEO 轨道高度 km（预置星默认）
// 仰角线配色调色板（卫星属性）：新建/预置星按序分配，可逐星改色
const SAT_PALETTE = ['#66ddff', '#ffd24a', '#7cff8a', '#ff6fae', '#c78bff', '#ff9a5a', '#5ad1ff', '#ff5a5a']

export function useGrdCoverage(getScene, getFlat) {
  // 卫星树（唯一真相）：预置星(index) / 自定义星 / 星座关联星 共用同一数组。
  // 每个节点 = { folder, satName, kind:'preset'|'custom'|'linked', lon, lat, altKm, noradId,
  //   els, elevColor, elevShow,  antennas:[...] }。仰角线是卫星属性，天线挂在卫星下。
  const sats = ref([])              // 卫星节点数组
  const expanded = ref({})          // folder → 是否展开
  const selected = ref([])          // 已选天线 key 列表（folder|name）
  const active = ref('')            // 聚焦天线 key（设置/填充对象）
  const loading = ref(false)
  let loaded = false
  const cache = new Map()           // key → { meta, P1, P2, proj }

  const STEP = 1   // 电平间隔（固定 1 dB，用户不可见）
  // 默认 5 档相对峰值 −1..−5；jet 配色按值自动分配（填充色与线色默认同色，可分别改）
  function defaultLevels() { const lv = [-1, -2, -3, -4, -5].map((v) => ({ v, color: '', lineColor: '' })); recolorList(lv); return lv }
  // 按值升序分配 jet 色（外圈冷、内圈热），填充色 + 线色一并重置
  function recolorList(lv) {
    const n = lv.length; if (!n) return
    const cols = schemeColorsRGB('jet', n)
    lv.map((_, i) => i).sort((a, b) => lv[a].v - lv[b].v).forEach((idx, rank) => { const css = rgbCss(cols[rank]); lv[idx].color = css; lv[idx].lineColor = css })
  }

  const s = reactive({
    fill: false, alpha: 0.78, line: true, lineWidth: 1.6,   // 默认不填充（多天线/多星叠加时按需逐个开启）
    ctype: 'rel', levels: defaultLevels(),
    pol: 'RSS', gainOffset: 0, pathLoss: 'none',
    boreType: 'geo', boreLon: null, boreLat: 0, boreAz: 0, boreEl: 0, yaw: 0
  })
  // 方位/俯仰(相对星下点) → boresight 目标经纬度（igrid6 约定，与天线网格一致）
  function azelToLonLat(satLon, az, el) { return project(gridDir(6, az, el), antennaBasis(satLon, satLon, 0, 0)) }

  // 加一档：沿现有方向延伸 1 dB，再整体 jet 重新配色
  function addLevel() {
    const lv = s.levels
    const dir = lv.length >= 2 ? (Math.sign(lv[lv.length - 1].v - lv[lv.length - 2].v) || (s.ctype === 'rel' ? -1 : 1)) : (s.ctype === 'rel' ? -1 : 1)
    const base = lv.length ? lv[lv.length - 1].v : (s.ctype === 'rel' ? 0 : 50)
    lv.push({ v: +(base + dir * STEP).toFixed(2), color: '', lineColor: '' })
    recolorList(lv)
  }
  function removeLevel(i) { s.levels.splice(i, 1); recolorList(s.levels) }

  // 每个天线的独立设置（数据库）：除等仰角线(全局参考线)外的全部绘制设置都按天线保存，
  // 切换聚焦时载入该天线设置、编辑时回存，只有用户改动才变。bore 指向同样并入。
  const PA = ['ctype', 'pol', 'gainOffset', 'pathLoss', 'fill', 'line', 'lineWidth', 'alpha', 'boreType', 'boreLon', 'boreLat', 'boreAz', 'boreEl', 'yaw']
  const copyLevels = (lv) => lv.map((L) => ({ v: L.v, color: L.color, lineColor: L.lineColor }))
  function defaultSettings(satLon) {
    return { ctype: 'rel', pol: 'RSS', gainOffset: 0, pathLoss: 'none', fill: false, line: true, lineWidth: 1.6, alpha: 0.78,
      boreType: 'geo', boreLon: satLon == null ? null : satLon, boreLat: 0, boreAz: 0, boreEl: 0, yaw: 0, levels: defaultLevels() }
  }
  function applySettings(cfg) { if (!cfg) return; for (const k of PA) s[k] = cfg[k]; s.levels = copyLevels(cfg.levels || defaultLevels()) }
  let _muteSync = false
  function persistActive() {     // 把当前面板设置回存到聚焦天线
    if (_muteSync) return
    const c = cache.get(active.value); if (!c || !c.settings) return
    for (const k of PA) c.settings[k] = s[k]
    c.settings.levels = copyLevels(s.levels)
  }

  const keyOf = (folder, name) => `${folder}|${name}`
  const findAnt = (key) => { const [f, n] = key.split('|'); const sat = sats.value.find((x) => x.folder === f); return sat && sat.antennas.find((a) => a.name === n) ? { sat, a: sat.antennas.find((a) => a.name === n) } : null }
  const isSelected = (folder, name) => selected.value.includes(keyOf(folder, name))
  const isActive = (folder, name) => active.value === keyOf(folder, name)
  const antMeta = () => { const c = cache.get(active.value); return c && c.meta }
  const activeName = () => active.value ? active.value.split('|')[1] : ''
  const beamsCount = () => { const m = antMeta(); return m ? m.beams : 0 }
  const toF32 = (a) => Float32Array.from(a, (v) => (v == null ? NaN : v))

  // ===== 卫星节点：增/删/改 + 仰角线属性 =====
  let _colorSeq = 0
  const nextElevColor = () => SAT_PALETTE[_colorSeq++ % SAT_PALETTE.length]
  // 预置星（index）补齐统一节点字段：GEO 定点(lon,0,GEO_ALT)、缺省仰角线（关闭）
  const normPreset = (s) => ({ ...s, kind: 'preset', lat: 0, altKm: GEO_ALT, noradId: null, els: '5,10', elevColor: nextElevColor(), elevShow: false, iconSize: 30, labelSize: 14 })
  // 同名加点号去重，作为节点唯一 key（folder）
  function genFolder(name) {
    const base = (name || '卫星').trim() || '卫星'
    let f = base, i = 1
    while (sats.value.some((x) => x.folder === f)) f = `${base}·${++i}`
    return f
  }
  // 往树里加一颗卫星：noradId 非空=星座关联星（位置随星历，由页面解算）；否则自定义星（固定 lon/lat/alt）
  function addSatellite(draft) {
    const folder = genFolder(draft.name)
    const node = {
      folder, satName: (draft.name || '卫星').trim() || '卫星',
      kind: draft.noradId ? 'linked' : 'custom',
      lon: Number(draft.lon) || 0, lat: Number(draft.lat) || 0, altKm: Number(draft.altKm) || GEO_ALT,
      noradId: draft.noradId || null,
      els: draft.els != null ? draft.els : '5,10',
      elevColor: draft.color || nextElevColor(), elevShow: true,
      iconSize: Number(draft.iconSize) || 30, labelSize: Number(draft.labelSize) || 14,
      antennas: []
    }
    sats.value = [...sats.value, node]
    expanded.value = { ...expanded.value, [folder]: true }
    return node
  }
  function updateSatellite(folder, patch) { const n = sats.value.find((x) => x.folder === folder); if (n) Object.assign(n, patch) }
  const setElev = (folder, patch) => updateSatellite(folder, patch)   // 仅改仰角线属性（els/elevColor/elevShow）
  // 删卫星：连带清掉其天线的选中/缓存（预置星也可删——仅本会话，重载后随 index 复现）
  function removeSatellite(folder) {
    const n = sats.value.find((x) => x.folder === folder); if (!n) return
    for (const a of n.antennas) {
      const k = keyOf(folder, a.name)
      cache.delete(k)
      selected.value = selected.value.filter((x) => x !== k)
      if (active.value === k) active.value = ''
    }
    sats.value = sats.value.filter((x) => x.folder !== folder)
    if (!active.value) { active.value = selected.value[0] || ''; loadActive() }
    recompute()
  }
  // 删天线：从该星移除，并清掉其选中/聚焦/缓存
  function removeAntenna(folder, name) {
    const sat = sats.value.find((x) => x.folder === folder); if (!sat) return
    const key = keyOf(folder, name)
    sat.antennas = sat.antennas.filter((a) => a.name !== name)
    cache.delete(key)
    selected.value = selected.value.filter((k) => k !== key)
    if (active.value === key) { active.value = selected.value[0] || ''; loadActive() }
    recompute()
  }

  async function loadIndex(autoSelect = true) {
    if (loaded) return
    try {
      const idx = await window.api.coverageGrd.index()
      sats.value = (((idx && idx.satellites) || [])).map(normPreset)
      loaded = true
      if (autoSelect && sats.value.length) {
        expanded.value[sats.value[0].folder] = true
        const a0 = sats.value[0].antennas[0]
        if (a0) await setActive(sats.value[0], a0)
      }
    } catch (e) { console.error('coverageGrd index 失败', e) }
  }

  async function ensureLoaded(folder, a) {
    const key = keyOf(folder, a.name)
    if (cache.has(key)) return key
    const raw = await window.api.coverageGrd.get(a.file)
    const settings = defaultSettings(raw.meta.satLon)
    settings.boreLon = raw.meta.antenna.boreLon; settings.boreLat = raw.meta.antenna.boreLat
    // 用本地 projectGrid 重投影（而非后端烘焙的 lon/lat），得到地平裕度 vis + 越地平点落到地平，
    // 这样预置天线也能精确切在 0°仰角线（后端数据无 vis、越地平点为 NaN，会留网格锯齿）。
    const basis = antennaBasis(raw.meta.satLon, settings.boreLon == null ? raw.meta.satLon : settings.boreLon, settings.boreLat, settings.yaw)
    const proj = projectGrid(raw.meta.grid, raw.meta.igrid, basis)
    cache.set(key, { meta: raw.meta, P1: toF32(raw.P1), P2: toF32(raw.P2), proj, settings })   // 每天线各存全部设置（含指向），数据库式
    return key
  }

  // 点击天线名 → 设为聚焦（并确保选中）
  async function setActive(sat, a) {
    loading.value = true
    try {
      const key = await ensureLoaded(sat.folder, a)
      if (!selected.value.includes(key)) selected.value = [...selected.value, key]
      active.value = key
      const c = cache.get(key)
      _muteSync = true; applySettings(c.settings); _muteSync = false   // 载入该天线已存的全部设置（含指向）
      recompute()
      const sc = getScene(); if (sc && c.meta.peak) sc.faceLonLat(c.meta.peak[0], c.meta.peak[1])
    } finally { loading.value = false }
  }

  // 聚焦项切换后，把该天线已存设置载入面板（_muteSync 防止载入即回存）
  function loadActive() { const c = cache.get(active.value); if (c && c.settings) { _muteSync = true; applySettings(c.settings); _muteSync = false } }

  // 勾选框 → 加入/移出选中集
  async function toggleAnt(sat, a) {
    const key = keyOf(sat.folder, a.name)
    if (selected.value.includes(key)) {
      selected.value = selected.value.filter((k) => k !== key)
      if (active.value === key) { active.value = selected.value[0] || ''; loadActive() }
      recompute()
    } else {
      await ensureLoaded(sat.folder, a)
      selected.value = [...selected.value, key]
      if (!active.value) { active.value = key; loadActive() }
      recompute()
    }
  }

  // 卫星行勾选 → 该星全部天线 全选/全不选
  async function toggleSatAll(sat) {
    const keys = sat.antennas.map((a) => keyOf(sat.folder, a.name))
    const allOn = keys.every((k) => selected.value.includes(k))
    if (allOn) {
      selected.value = selected.value.filter((k) => !keys.includes(k))
      if (!selected.value.includes(active.value)) { active.value = selected.value[0] || ''; loadActive() }
    } else {
      for (const a of sat.antennas) await ensureLoaded(sat.folder, a)
      const add = keys.filter((k) => !selected.value.includes(k))
      selected.value = [...selected.value, ...add]
      if (!active.value) { active.value = keys[0]; loadActive() }
    }
    recompute()
  }
  function satState(sat) {
    const keys = sat.antennas.map((a) => keyOf(sat.folder, a.name))
    const on = keys.filter((k) => selected.value.includes(k)).length
    return on === 0 ? 'none' : on === keys.length ? 'all' : 'some'
  }
  function toggleExpand(folder) { expanded.value = { ...expanded.value, [folder]: !expanded.value[folder] } }
  const isExpanded = (folder) => !!expanded.value[folder]

  function reproject() {
    const c = cache.get(active.value); if (!c) return
    const m = c.meta
    persistActive()   // 回存该天线全部设置（含指向）
    const basis = antennaBasis(m.satLon, s.boreLon == null ? m.satLon : s.boreLon, s.boreLat, s.yaw)
    c.proj = projectGrid(m.grid, m.igrid, basis)
  }

  function absLevels(peak, cfg) { return cfg.levels.map((L) => ({ abs: cfg.ctype === 'rel' ? peak + L.v : L.v, color: L.color, lineColor: L.lineColor })) }

  // 显示用等值线裁到可见地球内（仰角≥0）：两端点都在地平内才保留，避免 dB 线画过 0°仰角线。
  function clipSegsVisible(segs, satEcef) {
    const out = []
    for (const sg of segs) {
      if (elevationDeg(sg[0][0], sg[0][1], satEcef) >= 0 && elevationDeg(sg[1][0], sg[1][1], satEcef) >= 0) out.push(sg)
    }
    return out
  }
  // 每个选中天线 → 一层；所有选中画线，每个【开启填充】的天线各自分带填充（多天线/多星可叠加）。
  // 2D 与 3D 同源同一份场数据 { field(投影网格+dB+vis), bands(电平→色), segGroups(等值线) }：
  //   填充 = 按 bands 给场着色（3D 逐顶点 / 2D 栅格化成位图），不再走 stitchLoops 拼环 —— 这是
  //   2D「没填充 / 跨东经180° 出错」的根因（拼环遇开放/跨缝即失败）。地平裁剪统一靠 field.vis。
  function buildLayer(key) {
    const c = cache.get(key); if (!c) return null
    const cfg = c.settings   // 每层用自身保存的设置（聚焦层的实时编辑已由 watcher 回存到此）
    const satEcef = geodeticToEcef(c.meta.satLon, 0, H)
    const field = fieldDb({ P1: c.P1, P2: c.P2, NX: c.proj.NX, NY: c.proj.NY }, c.proj, { pol: cfg.pol, gainOffset: cfg.gainOffset, pathLoss: cfg.pathLoss })
    const lv = absLevels(field.max, cfg)
    const segGroups = cfg.line
      ? lv.map((L) => { const segs = []; for (const cc of contourLines(field, c.proj, [L.abs])) for (const sg of cc.segs) segs.push(sg); return { segs: clipSegsVisible(segs, satEcef), color: L.lineColor, width: cfg.lineWidth } }).filter((x) => x.segs.length)
      : []
    const asc = [...lv].sort((a, b) => a.abs - b.abs)
    const bands = { levels: asc.map((x) => x.abs), colors: asc.map((x) => cssRgb(x.color)) }
    const fieldP = cfg.fill ? { lon: c.proj.lon, lat: c.proj.lat, vis: c.proj.vis, NX: c.proj.NX, NY: c.proj.NY, db: field.db } : null
    return { field: fieldP, bands, segGroups }
  }

  function recompute() {
    const sc = getScene(), fl = getFlat()
    // 聚焦（编辑中）天线排到最后 → 填充叠加时位于最上层，最醒目（其余按选中顺序在下）
    const ks = [...selected.value].sort((a, b) => (a === active.value ? 1 : 0) - (b === active.value ? 1 : 0))
    const layers = ks.map(buildLayer).filter(Boolean)   // 2D/3D 共用同一份（省一半重算）
    if (sc) sc.setCoverageField(layers, { alpha: s.alpha })
    if (fl) fl.setField(layers, { alpha: s.alpha })
  }

  // 导入 GRD：原生文件框 → 解析 → 在目标卫星下新建一个天线（名取自文件名，可后续改）
  const targetSat = () => { if (active.value) { const f = active.value.split('|')[0]; const s = sats.value.find((x) => x.folder === f); if (s) return s } return sats.value[0] }
  async function importGrd(target) {
    const sat = target || targetSat()
    if (!sat) { alert('请先选择一颗卫星'); return }
    loading.value = true
    try {
      const res = await window.api.coverageGrd.open()
      if (!res || res.canceled) return
      if (res.error || !res.text) { alert('读取失败：' + (res.error || '空文件')); return }
      let g
      try { g = parseGrd(res.text) } catch (e) { alert('解析失败：' + e.message); return }
      const set = g.sets[0]
      const proj = projectGrid(set, g.igrid, antennaBasis(sat.lon))
      const field = fieldDb({ P1: set.P1, P2: set.P2, NX: set.NX, NY: set.NY }, proj, { pol: 'RSS' })
      const peak = [+proj.lon[field.maxIdx].toFixed(4), +proj.lat[field.maxIdx].toFixed(4)]
      let name = (res.base || 'GRD').replace(/\.(grd|pat)$/i, '')
      while (sat.antennas.some((a) => a.name === name)) name += '·'   // 重名加后缀
      const meta = {
        sat: sat.satName, folder: sat.folder, name, type: '', band: '', satLon: sat.lon,
        igrid: g.igrid, icomp: g.icomp, ncomp: g.ncomp, beams: g.nset,
        grid: { XS: set.XS, YS: set.YS, XE: set.XE, YE: set.YE, NX: set.NX, NY: set.NY },
        antenna: { satLon: sat.lon, boreLon: sat.lon, boreLat: 0, yaw: 0 },
        peakDb: +field.max.toFixed(3), peak
      }
      const key = keyOf(sat.folder, name)
      cache.set(key, { meta, P1: set.P1, P2: set.P2, proj, settings: defaultSettings(sat.lon) })
      sat.antennas.push({ name, type: '', band: '', beams: g.nset, peakDb: meta.peakDb, peak, file: null, imported: true })
      expanded.value = { ...expanded.value, [sat.folder]: true }
      selected.value = [...selected.value, key]
      active.value = key
      _muteSync = true; applySettings(cache.get(key).settings); _muteSync = false
      recompute()
      const sc = getScene(); if (sc) sc.faceLonLat(peak[0], peak[1])
    } finally { loading.value = false }
  }

  // 拖拽波束：在地图上拖动，按光标位移平移当前天线的 boresight 中心（相对拖动，手感最佳）
  const dragBore = ref(false)
  function setDragBore(v) { dragBore.value = !!v; const sc = getScene(), fl = getFlat(); if (sc) sc.setBeamDragMode(dragBore.value); if (fl) fl.setBeamDragMode(dragBore.value) }
  let _drag = null, _dragRaf = 0, _dragLL = null
  function beamDrag(ll, phase) {
    if (!active.value || !ll) return
    if (phase === 'start') { _drag = { ll, lon: s.boreLon == null ? antMeta().satLon : s.boreLon, lat: s.boreLat || 0 }; return }
    if (!_drag) return
    _dragLL = ll
    if (_dragRaf) return                       // rAF 节流：每帧最多重投影一次，拖动顺滑不卡
    _dragRaf = requestAnimationFrame(() => {
      _dragRaf = 0
      s.boreType = 'geo'
      s.boreLon = +(_drag.lon + (_dragLL.lon - _drag.ll.lon)).toFixed(4)
      s.boreLat = +(_drag.lat + (_dragLL.lat - _drag.ll.lat)).toFixed(4)
    })
  }

  // 缓存：导出/恢复 GRD 面板状态（选中天线 / 聚焦 / 各天线全部设置 / 全局等仰角线）
  function getState() {
    persistActive()
    const cfgs = {}
    for (const key of selected.value) { const c = cache.get(key); if (c && c.settings) cfgs[key] = { ...c.settings, levels: copyLevels(c.settings.levels) } }
    // 卫星树：自定义/星座星完整定义 + 全部星的仰角线属性（预置星仅存仰角线，节点本身随 index 复现）
    const satsState = sats.value.map((s) => ({
      folder: s.folder, kind: s.kind, satName: s.satName,
      lon: s.lon, lat: s.lat, altKm: s.altKm, noradId: s.noradId,
      els: s.els, elevColor: s.elevColor, elevShow: s.elevShow, iconSize: s.iconSize, labelSize: s.labelSize
    }))
    return { selected: selected.value.slice(), active: active.value, cfgs, sats: satsState }
  }
  async function restoreState(st) {
    if (!st) return
    // 先恢复卫星：自定义/星座关联星补建到树；所有星（含预置）叠加用户编辑（名称/位置/关联/仰角线）。
    // 预置星节点本身由 index 复现，这里仅叠加用户改过的字段；预置星 kind 始终保持 'preset'。
    if (Array.isArray(st.sats)) {
      for (const ss of st.sats) {
        let node = sats.value.find((x) => x.folder === ss.folder)
        if (!node) {
          if (!ss.kind || ss.kind === 'preset') continue   // 预置星已不在 index（如已删/改版）→ 跳过
          node = { folder: ss.folder, satName: ss.satName || '卫星', kind: ss.kind, antennas: [],
            lon: ss.lon, lat: ss.lat, altKm: ss.altKm, noradId: ss.noradId || null,
            els: '5,10', elevColor: nextElevColor(), elevShow: false, iconSize: 30, labelSize: 14 }
          sats.value = [...sats.value, node]
        }
        if (ss.satName) node.satName = ss.satName
        if (Number.isFinite(ss.iconSize)) node.iconSize = ss.iconSize
        if (Number.isFinite(ss.labelSize)) node.labelSize = ss.labelSize
        if (Number.isFinite(ss.lon)) node.lon = ss.lon
        if (Number.isFinite(ss.lat)) node.lat = ss.lat
        if (Number.isFinite(ss.altKm)) node.altKm = ss.altKm
        node.noradId = ss.noradId || null
        if (ss.els != null) node.els = ss.els
        if (ss.elevColor) node.elevColor = ss.elevColor
        if (typeof ss.elevShow === 'boolean') node.elevShow = ss.elevShow
        if (ss.kind && ss.kind !== 'preset' && node.kind !== 'preset') node.kind = ss.kind
      }
    }
    if (!Array.isArray(st.selected)) { recompute(); return }
    // 旧格式（全局设置 + bores）兜底：拼出该天线的 cfg
    const legacy = (key) => st.cfgs ? null : {
      ctype: st.ctype, pol: st.pol, gainOffset: st.gainOffset, pathLoss: st.pathLoss, fill: st.fill, line: st.line, lineWidth: st.lineWidth, alpha: st.alpha,
      ...(st.bores && st.bores[key] ? { boreType: st.bores[key].type, boreLon: st.bores[key].lon, boreLat: st.bores[key].lat, boreAz: st.bores[key].az, boreEl: st.bores[key].el, yaw: st.bores[key].yaw } : {}),
      levels: Array.isArray(st.levels) ? st.levels.map((L) => ({ v: L.v, color: L.color, lineColor: L.lineColor || L.color })) : null
    }
    const keys = []
    for (const key of st.selected) {
      const info = findAnt(key); if (!info) continue                      // 索引中已不存在（如内存导入的）跳过
      await ensureLoaded(info.sat.folder, info.a)
      const c = cache.get(key); if (!c) continue
      const cfg = (st.cfgs && st.cfgs[key]) || legacy(key)
      if (cfg) { c.settings = { ...defaultSettings(c.meta.satLon), ...cfg, levels: cfg.levels ? copyLevels(cfg.levels) : defaultLevels() } }
      const b = c.settings
      c.proj = projectGrid(c.meta.grid, c.meta.igrid, antennaBasis(c.meta.satLon, b.boreLon == null ? c.meta.satLon : b.boreLon, b.boreLat, b.yaw))
      expanded.value = { ...expanded.value, [info.sat.folder]: true }
      keys.push(key)
    }
    selected.value = keys
    active.value = (st.active && keys.includes(st.active)) ? st.active : (keys[0] || '')
    if (active.value) { _muteSync = true; applySettings(cache.get(active.value).settings); _muteSync = false }
    recompute()
  }

  function clearAll() { selected.value = []; active.value = ''; const sc = getScene(), fl = getFlat(); if (sc) sc.setCoverageField([], {}); if (fl) fl.setField([], {}) }
  // 一键清除绘图：抹掉地图上的填充/线，但保留各天线设置（数据库）与聚焦项 → 再次勾选天线即按原设置重绘。
  function clearDrawing() { selected.value = []; const sc = getScene(), fl = getFlat(); if (sc) sc.setCoverageField([], {}); if (fl) fl.setField([], {}) }

  watch(() => [s.fill, s.line, s.lineWidth, s.ctype, s.pol, s.gainOffset, s.pathLoss], () => { persistActive(); recompute() }, { deep: true })
  watch(() => s.levels, () => { persistActive(); recompute() }, { deep: true })
  watch(() => s.alpha, (a) => { persistActive(); const sc = getScene(), fl = getFlat(); if (sc) sc.setCoverageFieldAlpha(a); if (fl) fl.setFieldAlpha(a) })
  watch(() => [s.boreLon, s.boreLat, s.yaw], () => { reproject(); recompute() })
  // 方位/俯仰模式：az/el 变 → 换算到 boresight 经纬度（再由上面的 watch 触发重投影）
  watch(() => [s.boreAz, s.boreEl, s.boreType], () => {
    if (s.boreType !== 'azel') return
    const m = antMeta(); if (!m) return
    const g = azelToLonLat(m.satLon, s.boreAz, s.boreEl)
    if (g) { s.boreLon = +g.lon.toFixed(4); s.boreLat = +g.lat.toFixed(4) }
  })

  return {
    sats, expanded, selected, active, loading, s,
    keyOf, isSelected, isActive, isExpanded, antMeta, activeName, beamsCount, satState, dragBore,
    loadIndex, setActive, toggleAnt, toggleSatAll, toggleExpand, addLevel, removeLevel, importGrd,
    addSatellite, updateSatellite, removeSatellite, removeAntenna, setElev,
    setDragBore, beamDrag, getState, restoreState, recompute, clearAll, clearDrawing
  }
}
