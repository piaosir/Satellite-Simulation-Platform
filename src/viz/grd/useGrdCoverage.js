// 覆盖图（GRD）逻辑 —— SATSOFT 模型：卫星 → 天线（命名覆盖）。支持多选卫星/天线。
// 选中的天线各成一层渲染到星座3D 的 scene/flat（独立图层）：所有选中天线画等值线；
// 当前聚焦(active)天线额外画分带填充。计算核心 src/viz/grd/{parse,coverage,colormap}.js。
import { ref, reactive, watch } from 'vue'
import { parseGrd } from './parse.js'
import { antennaBasis, projectGrid, fieldDb, bandGeometry, stitchLoops, gridDir, project } from './coverage.js'
import { schemeColorsRGB, rgbCss, cssRgb } from './colormap.js'
import { RS_GEO, A } from '../wgs84.js'

const H = RS_GEO - A
const GEO_ALT = 35786              // GEO 轨道高度 km（预置星默认）
// 仰角线配色调色板（卫星属性）：新建/预置星按序分配，可逐星改色
const SAT_PALETTE = ['#66ddff', '#ffd24a', '#7cff8a', '#ff6fae', '#c78bff', '#ff9a5a', '#5ad1ff', '#ff5a5a']

export function useGrdCoverage(getScene, getFlat, isFlat = () => false) {
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
  // 默认 5 档：相对峰值 −1..−5；绝对模式（默认）下换算为 peakDb + (−1..−5) 的绝对值（无 peak 时退回相对数值）。
  // jet 配色按值自动分配（填充色与线色默认同色，可分别改）。
  function defaultLevels(peakDb) {
    const abs = Number.isFinite(peakDb)
    const lv = [-1, -2, -3, -4, -5].map((v) => ({ v: abs ? +(peakDb + v).toFixed(2) : v, color: '', lineColor: '' }))
    recolorList(lv); return lv
  }
  // 按值升序分配 jet 色（外圈冷、内圈热），填充色 + 线色一并重置
  function recolorList(lv) {
    const n = lv.length; if (!n) return
    const cols = schemeColorsRGB('jet', n)
    lv.map((_, i) => i).sort((a, b) => lv[a].v - lv[b].v).forEach((idx, rank) => { const css = rgbCss(cols[rank]); lv[idx].color = css; lv[idx].lineColor = css })
  }

  const s = reactive({
    fill: false, alpha: 0.78, line: true, lineWidth: 1.6,   // 默认不填充（多天线/多星叠加时按需逐个开启）
    ctype: 'abs', levels: defaultLevels(),
    pol: 'RSS', gainOffset: 0, pathLoss: 'none',
    boreType: 'azel', boreLon: null, boreLat: 0, boreAz: 0, boreEl: 0, yaw: 0,
    beamsToPlot: [0],   // 多波束 GRD：要绘制的波束序号（SATSOFT「Beams To Plot」多选；共用本天线同一套电平/极化设置）
    // 全局显示选项（与 GXT 一致；不随聚焦天线切换，对所有选中天线生效）：天线名 / 波束中心 / 数值标签
    showName: true, nameSize: 16, showBore: true, boreSize: 5, showVal: false, valSize: 12
  })
  // 方位/俯仰(相对星下点) → boresight 目标经纬度（igrid6 约定，与天线网格一致）
  function azelToLonLat(satLon, az, el, satLat = 0, altKm) { return project(gridDir(6, az, el), antennaBasis(satLon, satLon, satLat, 0, satLat, altKm)) }

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
  function defaultSettings(satLon, satLat = 0, peakDb) {
    return { ctype: 'abs', pol: 'RSS', gainOffset: 0, pathLoss: 'none', fill: false, line: true, lineWidth: 1.6, alpha: 0.78,
      boreType: 'azel', boreLon: satLon == null ? null : satLon, boreLat: satLat || 0, boreAz: 0, boreEl: 0, yaw: 0, beamsToPlot: [0], levels: defaultLevels(peakDb) }
  }
  function applySettings(cfg) { if (!cfg) return; for (const k of PA) s[k] = cfg[k]; s.levels = copyLevels(cfg.levels || defaultLevels()); s.beamsToPlot = (cfg.beamsToPlot && cfg.beamsToPlot.length ? cfg.beamsToPlot : [0]).slice() }
  let _muteSync = false
  function persistActive() {     // 把当前面板设置回存到聚焦天线
    if (_muteSync) return
    const c = cache.get(active.value); if (!c || !c.settings) return
    for (const k of PA) c.settings[k] = s[k]
    c.settings.levels = copyLevels(s.levels)
    c.settings.beamsToPlot = s.beamsToPlot.slice()
  }

  const keyOf = (folder, name) => `${folder}|${name}`
  const findAnt = (key) => { const [f, n] = key.split('|'); const sat = sats.value.find((x) => x.folder === f); return sat && sat.antennas.find((a) => a.name === n) ? { sat, a: sat.antennas.find((a) => a.name === n) } : null }
  const isSelected = (folder, name) => selected.value.includes(keyOf(folder, name))
  const isActive = (folder, name) => active.value === keyOf(folder, name)
  const antMeta = () => { const c = cache.get(active.value); return c && c.meta }
  const activeName = () => active.value ? active.value.split('|')[1] : ''
  const beamsCount = () => { const m = antMeta(); return m ? m.beams : 0 }
  const toF32 = (a) => Float32Array.from(a, (v) => (v == null ? NaN : v))

  // ===== Beams To Plot（SATSOFT 多选波束）：作用于聚焦天线，共用其同一套电平/极化设置 =====
  // 聚焦天线已载入的波束列表（{ i, label, peakDb }）；单波束天线返回 1 项。
  const activeBeams = () => {
    const c = cache.get(active.value); if (!c || !c.beams) return []
    return c.beams.map((b, i) => ({ i, label: c.beams.length > 1 ? `波束 ${i + 1}` : (c.meta.name || `波束 ${i + 1}`), peakDb: b.peakDb }))
  }
  const isBeamOn = (i) => s.beamsToPlot.includes(i)
  function toggleBeam(i) {
    const set = new Set(s.beamsToPlot)
    set.has(i) ? set.delete(i) : set.add(i)
    s.beamsToPlot = [...set].sort((a, b) => a - b)   // 触发 watcher → 回存 + 重绘
  }
  function setAllBeams(on) {
    const n = (cache.get(active.value)?.beams || []).length
    s.beamsToPlot = on ? Array.from({ length: n }, (_, i) => i) : []
  }
  const allBeamsOn = () => { const n = (cache.get(active.value)?.beams || []).length; return n > 0 && s.beamsToPlot.length === n }

  // ===== 卫星节点：增/删/改 + 仰角线属性 =====
  let _colorSeq = 0
  const nextElevColor = () => SAT_PALETTE[_colorSeq++ % SAT_PALETTE.length]
  // 预置星（index）补齐统一节点字段：GEO 定点(lon,0,GEO_ALT)、缺省仰角线（关闭）
  const normPreset = (s) => ({ ...s, kind: 'preset', lat: 0, altKm: GEO_ALT, noradId: null, els: '5,10', elevColor: nextElevColor(), elevShow: false, elevWidth: 1.3, iconSize: 30, labelSize: 14, labelShow: false })
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
      elevColor: draft.color || nextElevColor(), elevShow: true, elevWidth: Number(draft.elevWidth) || 1.3,
      iconSize: Number(draft.iconSize) || 30, labelSize: Number(draft.labelSize) || 14, labelShow: true,
      antennas: []
    }
    sats.value = [...sats.value, node]
    expanded.value = { ...expanded.value, [folder]: true }
    return node
  }
  function updateSatellite(folder, patch) {
    const n = sats.value.find((x) => x.folder === folder); if (!n) return
    // 位置（经纬度/高度）变化 → 编辑后让该星天线覆盖图跟随重投影（仰角线由页面 redrawSats 处理）
    const moved = ('lon' in patch && Number(patch.lon) !== n.lon) || ('lat' in patch && Number(patch.lat) !== n.lat) || ('altKm' in patch && Number(patch.altKm) !== n.altKm)
    Object.assign(n, patch)
    if (moved) reprojectSat(folder)
  }
  const setElev = (folder, patch) => updateSatellite(folder, patch)   // 仅改仰角线属性（els/elevColor/elevShow）
  // 删卫星：连带清掉其天线的选中/缓存（预置星也可删——仅本会话，重载后随 index 复现）
  function removeSatellite(folder) {
    const n = sats.value.find((x) => x.folder === folder); if (!n) return
    for (const a of n.antennas) {
      const k = keyOf(folder, a.name)
      if (a.imported && a.file) { try { window.api.coverageGrd.remove(a.file) } catch { /* ignore */ } }
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
    const tgt = sat.antennas.find((a) => a.name === name)
    if (tgt && tgt.imported && tgt.file) { try { window.api.coverageGrd.remove(tgt.file) } catch { /* ignore */ } }
    sat.antennas = sat.antennas.filter((a) => a.name !== name)
    cache.delete(key)
    selected.value = selected.value.filter((k) => k !== key)
    if (active.value === key) { active.value = selected.value[0] || ''; loadActive() }
    recompute()
  }
  // 重命名天线：改名同时迁移其缓存键/选中键/聚焦键（名称即天线唯一标识，导入天线的存盘 file 不受影响）。
  // 返回 false=空名或同星重名（调用方据此提示并回退输入）。
  function renameAntenna(folder, oldName, newName) {
    const sat = sats.value.find((x) => x.folder === folder); if (!sat) return false
    const nm = String(newName || '').trim()
    if (!nm) return false
    if (nm === oldName) return true
    if (sat.antennas.some((a) => a.name === nm)) return false   // 同星重名
    const a = sat.antennas.find((x) => x.name === oldName); if (!a) return false
    const oldKey = keyOf(folder, oldName), newKey = keyOf(folder, nm)
    a.name = nm
    const c = cache.get(oldKey); if (c) { if (c.meta) c.meta.name = nm; cache.delete(oldKey); cache.set(newKey, c) }
    selected.value = selected.value.map((k) => (k === oldKey ? newKey : k))
    if (active.value === oldKey) active.value = newKey
    sats.value = [...sats.value]   // 触发卫星树响应式刷新（antennas 内属性变更）
    recompute()
    return true
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
    // 导入天线：从存盘的原始 GRD 重建（解析与导入同源）。无 file（旧版仅内存导入）或读盘失败 → 不缓存，
    // 由调用方按 cache 缺失跳过（不抛出，避免中断整体恢复）。
    if (a.imported) {
      if (!a.file) return key
      try {
        const { text } = await window.api.coverageGrd.raw(a.file)
        const g = parseGrd(text)
        const sat = sats.value.find((x) => x.folder === folder) || { satName: a.sat || '', folder }
        const pos = Number.isFinite(a.satLon) ? { lon: a.satLon, lat: a.satLat || 0, altKm: a.satAlt } : null
        const ent = importedCacheEntry(sat, g, a.name, pos)   // 多波束：一并重建全部波束（按文件原始 set 顺序）
        cache.set(key, { meta: ent.meta, beams: ent.beams, settings: defaultSettings(ent.meta.satLon, ent.meta.satLat, ent.meta.peakDb) })
      } catch (e) { console.warn('导入 GRD 重载失败', a.file, e) }
      return key
    }
    const raw = await window.api.coverageGrd.get(a.file)
    const settings = defaultSettings(raw.meta.satLon, raw.meta.satLat || 0, raw.meta.peakDb)
    // 预置天线自带经纬度 boresight：用经纬度模式载入以原样保留（避免 azel 默认按 az/el=0 归零到星下点）
    settings.boreType = 'geo'; settings.boreLon = raw.meta.antenna.boreLon; settings.boreLat = raw.meta.antenna.boreLat
    // 用本地 projectGrid 重投影（而非后端烘焙的 lon/lat），得到地平裕度 vis + 越地平点落到地平，
    // 这样预置天线也能精确切在 0°仰角线（后端数据无 vis、越地平点为 NaN，会留网格锯齿）。
    const basis = antennaBasis(raw.meta.satLon, settings.boreLon == null ? raw.meta.satLon : settings.boreLon, settings.boreLat, settings.yaw, raw.meta.satLat || 0, raw.meta.satAlt)
    const proj = projectGrid(raw.meta.grid, raw.meta.igrid, basis)
    // 预置天线（后端烘焙）只含单波束 set0，包成统一的 beams[1] 结构
    const beam0 = { P1: toF32(raw.P1), P2: toF32(raw.P2), grid: raw.meta.grid, proj, peakDb: raw.meta.peakDb, peak: raw.meta.peak }
    cache.set(key, { meta: { ...raw.meta, beams: 1 }, beams: [beam0], settings })   // 每天线各存全部设置（含指向），数据库式
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
      // beamsToPlot 越界保护（如旧存档波束数变化）：过滤掉不存在的波束，空则回退到首波束
      const nb = (c.beams || []).length
      c.settings.beamsToPlot = (c.settings.beamsToPlot || []).filter((i) => i < nb)
      if (!c.settings.beamsToPlot.length) c.settings.beamsToPlot = [0]
      _muteSync = true; applySettings(c.settings); _muteSync = false   // 载入该天线已存的全部设置（含指向 / Beams To Plot）
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
    const basis = antennaBasis(m.satLon, s.boreLon == null ? m.satLon : s.boreLon, s.boreLat, s.yaw, m.satLat || 0, m.satAlt)
    for (const b of c.beams) b.proj = projectGrid(b.grid, m.igrid, basis)   // 全部波束共用同一指向，逐波束各自网格投影
  }

  function absLevels(peak, cfg) { return cfg.levels.map((L) => ({ abs: cfg.ctype === 'rel' ? peak + L.v : L.v, v: L.v, color: L.color, lineColor: L.lineColor })) }

  // 一条等值线（点链）的最上端点（纬度最大）：作数值标签锚点，与 GXT「每条等值线取 top 标一次」一致
  function loopTop(pts) {
    let best = pts[0]
    for (const p of pts) if (p[1] > best[1]) best = p
    return best
  }
  // 单个波束 → 一个子图层（分带填充 + 等值线 + 波束中心）。相对峰值模式按【该波束自身峰值】算电平
  // （HTS 多点波束各自的 −3dB 圈），绝对模式所有波束共用同一绝对 dB。
  // 填充与等值线由 bandGeometry 一次性同源生成（逐三角形线性插值）：填充 = 各档环带多边形，
  // 线 = 相邻档公共边 → 二者精确重合；地平/接缝裁剪在 bandGeometry 内完成（无需再 clipSegsVisible）。
  function buildBeamLayer(c, cfg, beam, name) {
    const field = fieldDb({ P1: beam.P1, P2: beam.P2, NX: beam.proj.NX, NY: beam.proj.NY }, beam.proj, { pol: cfg.pol, gainOffset: cfg.gainOffset, pathLoss: cfg.pathLoss })
    const lv = absLevels(field.max, cfg)
    const asc = [...lv].sort((a, b) => a.abs - b.abs)   // 升序档：外圈冷、内圈热（与 jet 配色一致）
    const need = cfg.fill || cfg.line
    const geo = need ? bandGeometry({ lon: beam.proj.lon, lat: beam.proj.lat, vis: beam.proj.vis, db: field.db, NX: beam.proj.NX, NY: beam.proj.NY }, asc.map((x) => x.abs)) : null
    // 分带填充：每档一个颜色 + 该档环带多边形（升序，逐层从外到内绘制，非嵌套→无重叠透明叠加）
    const fillBands = cfg.fill && geo ? asc.map((x, i) => ({ color: cssRgb(x.color), polys: geo.fills[i] })).filter((b) => b.polys.length) : null
    // 等值线：每档一组线段（= 填充相邻档公共边）；数值标签按拼环后每条取最上端点
    const segGroups = cfg.line && geo
      ? asc.map((x, i) => {
        const segs = geo.lines[i]
        const labels = []
        for (const loop of stitchLoops(segs)) { if (loop.length >= 4) labels.push(loopTop(loop)) }
        return { segs, color: x.lineColor, width: cfg.lineWidth, txt: cfg.ctype === 'rel' ? String(x.v) : x.abs.toFixed(1), labels }
      }).filter((g) => g.segs.length)
      : []
    // 波束中心 = 当前场的峰值点（随指向/拖拽实时变化）；天线名标签贴在此处，并向所属卫星连线
    const pk = (Number.isFinite(beam.proj.lon[field.maxIdx]) && Number.isFinite(beam.proj.lat[field.maxIdx])) ? [beam.proj.lon[field.maxIdx], beam.proj.lat[field.maxIdx]] : (beam.peak || c.meta.peak || [c.meta.satLon, 0])
    const bore = { lon: pk[0], lat: pk[1], satLon: c.meta.satLon, satLat: c.meta.satLat || 0, satAlt: c.meta.satAlt || H }
    return { fillBands, segGroups, bore, name }
  }
  // 每个选中天线 → N 个子图层（按 Beams To Plot 选中的波束逐个出层）；所有子层共用该天线同一套设置。
  // 所有选中画线，每个【开启填充】的天线各自分带填充（多天线/多波束/多星可叠加）。
  // 2D 与 3D 同源同一份几何 { fillBands(各档环带多边形+色), segGroups(等值线段) }，均由 bandGeometry
  //   逐三角形线性插值生成 → 填充与线精确重合；地平/接缝裁剪在 bandGeometry 内完成（不再依赖位图/着色器取档）。
  function buildLayer(key) {
    const c = cache.get(key); if (!c || !c.beams) return []
    const cfg = c.settings   // 每层用自身保存的设置（聚焦层的实时编辑已由 watcher 回存到此）
    const antName = key.split('|')[1]
    const multi = c.beams.length > 1
    const plot = (cfg.beamsToPlot && cfg.beamsToPlot.length ? cfg.beamsToPlot : [0]).filter((i) => i < c.beams.length)
    return plot.map((bi) => {
      const L = buildBeamLayer(c, cfg, c.beams[bi], multi ? `${antName}·B${bi + 1}` : antName)
      L.id = `${key}#${bi}`   // 稳定层 id（天线键|波束序号）：渲染层据此做拖拽增量更新（只重建聚焦天线层）
      return L
    })
  }

  const fieldOpts = () => ({ alpha: s.alpha, showBore: s.showBore, boreSize: s.boreSize, showName: s.showName, nameSize: s.nameSize, showVal: s.showVal, valSize: s.valSize })
  function recompute() {
    const sc = getScene(), fl = getFlat()
    // 聚焦（编辑中）天线排到最后 → 填充叠加时位于最上层，最醒目（其余按选中顺序在下）
    const ks = [...selected.value].sort((a, b) => (a === active.value ? 1 : 0) - (b === active.value ? 1 : 0))
    const layers = ks.flatMap(buildLayer)   // 每天线展开成 N 个波束子层；2D/3D 共用同一份（省一半重算）
    const opts = fieldOpts()
    if (sc) sc.setCoverageField(layers, opts)
    if (fl) fl.setField(layers, opts)
  }
  // 拖拽热路径：只重算【聚焦天线】这一层，并只补丁【当前可见视图】（2D 或 3D，由 isFlat 决定）。
  // 其余天线层不变（拖拽不改它们的投影），另一视图在拖拽结束时由 recompute 一次性补齐 → 每帧工作量大幅下降。
  function recomputeActive() {
    if (!active.value) return
    const layers = buildLayer(active.value)
    const opts = fieldOpts()
    if (isFlat()) { const fl = getFlat(); if (fl) fl.patchField(layers, opts) }
    else { const sc = getScene(); if (sc) sc.patchCoverageLayers(layers, opts) }
  }

  // 卫星实时位置解算器（由页面注入：星座关联星按星历/时间轴解算星下点+高度）。
  // 未注入或非关联星 → 回退到节点静态 lon/lat/altKm。
  let _livePosFn = null
  function setLivePos(fn) { _livePosFn = fn }
  function liveOf(sat) {
    const p = _livePosFn && _livePosFn(sat)
    return (p && Number.isFinite(p.lon)) ? p : { lon: sat.lon, lat: sat.lat || 0, altKm: sat.altKm }
  }
  // 把单个天线的覆盖投影平移到卫星新位置 p：指向随星下点平移（保留用户相对偏置），
  // 高度变化则足迹随之缩放。返回是否有变化。供实时跟踪与手改卫星信息共用。
  function moveCoverage(c, key, p) {
    const oLon = c.meta.satLon, oLat = c.meta.satLat || 0, oAlt = c.meta.satAlt || 0
    if (Math.abs(p.lon - oLon) < 1e-6 && Math.abs((p.lat || 0) - oLat) < 1e-6 && Math.abs((p.altKm || 0) - oAlt) < 1e-3) return false
    let dLon = p.lon - oLon; while (dLon > 180) dLon -= 360; while (dLon < -180) dLon += 360
    const b = c.settings
    const bl = (b.boreLon == null ? oLon : b.boreLon) + dLon
    b.boreLon = +(((bl % 360) + 540) % 360 - 180).toFixed(4)
    b.boreLat = +Math.max(-89.9, Math.min(89.9, (b.boreLat || 0) + (p.lat || 0) - oLat)).toFixed(4)
    c.meta.satLon = p.lon; c.meta.satLat = p.lat || 0; c.meta.satAlt = p.altKm
    const basis = antennaBasis(p.lon, b.boreLon, b.boreLat, b.yaw, p.lat || 0, p.altKm)
    for (const bm of c.beams) bm.proj = projectGrid(bm.grid, c.meta.igrid, basis)   // 全部波束随星位平移
    if (key === active.value) { _muteSync = true; s.boreLon = b.boreLon; s.boreLat = b.boreLat; _muteSync = false }
    return true
  }
  // 实时跟踪：linked 星随星历/时间轴移动 → 平移各选中天线的覆盖投影。
  // 由页面在 refreshPositions（1s 实时 / 时间轴拖动）调用。
  function tickLive() {
    if (!selected.value.length) return
    let changed = false
    for (const key of selected.value) {
      const c = cache.get(key); if (!c || !c.meta) continue
      const node = sats.value.find((x) => x.folder === c.meta.folder)
      if (!node || !node.noradId) continue                 // 仅星座关联星跟踪（固定星不动）
      if (moveCoverage(c, key, liveOf(node))) changed = true
    }
    if (changed) recompute()
  }
  // 手改卫星信息（经纬度/高度）后，该星全部天线的覆盖图随之平移/缩放（与仰角线一同变化）。
  // 已加载的天线即时重投影；导入天线同步存盘快照，未加载的下次按新位置重建。
  function reprojectSat(folder) {
    const node = sats.value.find((x) => x.folder === folder); if (!node) return
    const p = liveOf(node)
    let changed = false
    for (const a of node.antennas) {
      if (a.imported) { a.satLon = p.lon; a.satLat = p.lat || 0; a.satAlt = p.altKm }
      const c = cache.get(keyOf(folder, a.name)); if (!c || !c.meta) continue
      if (moveCoverage(c, keyOf(folder, a.name), p)) changed = true
    }
    if (changed) recompute()
  }

  // 导入 GRD：原生文件框 → 解析 → 在目标卫星下新建一个天线（名取自文件名，可后续改）
  const targetSat = () => { if (active.value) { const f = active.value.split('|')[0]; const s = sats.value.find((x) => x.folder === f); if (s) return s } return sats.value[0] }
  // 由解析结果 g 重建一个导入天线的缓存条目（含【全部波束】的投影/场/峰值 + 天线级 meta）。导入与
  // 重载（ensureLoaded）共用，保证两次结果一致。pos：卫星位置（导入时取实时星历；重载时取存盘位置）。
  // 一个 GRD（含 N 个 set）= 一个天线，N 个 set = N 个波束（SATSOFT 模型，由 Beams To Plot 多选绘制）。
  function importedCacheEntry(sat, g, name, pos) {
    const p0 = pos || liveOf(sat)
    const basis = antennaBasis(p0.lon, p0.lon, p0.lat || 0, 0, p0.lat || 0, p0.altKm)
    const beams = g.sets.map((set) => {
      const proj = projectGrid(set, g.igrid, basis)
      const field = fieldDb({ P1: set.P1, P2: set.P2, NX: set.NX, NY: set.NY }, proj, { pol: 'RSS' })
      const peak = [+proj.lon[field.maxIdx].toFixed(4), +proj.lat[field.maxIdx].toFixed(4)]
      return { P1: set.P1, P2: set.P2, grid: { XS: set.XS, YS: set.YS, XE: set.XE, YE: set.YE, NX: set.NX, NY: set.NY }, proj, peakDb: +field.max.toFixed(3), peak }
    })
    // 天线整体峰值 = 各波束峰值的最大者（电平表默认值/聚焦定位用）
    const best = beams.reduce((a, b) => (b.peakDb > a.peakDb ? b : a), beams[0])
    const meta = {
      sat: sat.satName, folder: sat.folder, name, type: '', band: '', satLon: p0.lon, satLat: p0.lat || 0, satAlt: p0.altKm,
      igrid: g.igrid, icomp: g.icomp, ncomp: g.ncomp, beams: g.nset,
      antenna: { satLon: p0.lon, boreLon: p0.lon, boreLat: p0.lat || 0, yaw: 0 },
      peakDb: best.peakDb, peak: best.peak
    }
    return { meta, beams, peak: best.peak, peakDb: best.peakDb }
  }
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
      let name = (res.base || 'GRD').replace(/\.(grd|pat)$/i, '')
      while (sat.antennas.some((a) => a.name === name)) name += '·'   // 重名加后缀
      const ent = importedCacheEntry(sat, g, name)
      const m = ent.meta
      // 原始 GRD 存盘（userData/coverage-grd-imported）；失败则仅本会话内有效，不阻断导入
      let file = null
      try { const r = await window.api.coverageGrd.save(res.base || name, res.text); file = r && r.file } catch (e) { console.warn('GRD 持久化失败，仅本会话内有效', e) }
      const key = keyOf(sat.folder, name)
      // 多波束默认只画第 1 个波束（与 SATSOFT 一致：Beams To Plot 由用户按需多选/全选）。
      // 切勿默认全选——HTS 动辄 20+ 波束，一次性建几十个网格/提几十遍等值线会瞬时压垮 GPU（见 command_buffer 崩溃）。
      const settings = defaultSettings(m.satLon, m.satLat, m.peakDb)
      cache.set(key, { meta: m, beams: ent.beams, settings })
      sat.antennas.push({ name, type: '', band: '', beams: m.beams, peakDb: ent.peakDb, peak: ent.peak, file, imported: true, satLon: m.satLon, satLat: m.satLat, satAlt: m.satAlt })
      expanded.value = { ...expanded.value, [sat.folder]: true }
      selected.value = [...selected.value, key]
      active.value = key
      _muteSync = true; applySettings(cache.get(key).settings); _muteSync = false
      recompute()
      const sc = getScene(); if (sc) sc.faceLonLat(ent.peak[0], ent.peak[1])
    } finally { loading.value = false }
  }

  // 拖拽波束：在地图上拖动，按光标位移平移当前天线的 boresight 中心（相对拖动，手感最佳）
  const dragBore = ref(false)
  function setDragBore(v) { dragBore.value = !!v; const sc = getScene(), fl = getFlat(); if (sc) sc.setBeamDragMode(dragBore.value); if (fl) fl.setBeamDragMode(dragBore.value) }
  let _drag = null, _dragRaf = 0, _dragLL = null, _dragging = false
  function beamDrag(ll, phase) {
    if (phase === 'end') {   // 松手：取消挂起帧、退出拖拽态，再做一次完整重算补齐被跳过的另一视图
      if (_dragRaf) { cancelAnimationFrame(_dragRaf); _dragRaf = 0 }
      _drag = null; _dragging = false; recompute(); return
    }
    if (!active.value || !ll) return
    if (phase === 'start') { _dragging = true; _drag = { ll, lon: s.boreLon == null ? antMeta().satLon : s.boreLon, lat: s.boreLat || 0 }; return }
    if (!_drag) return
    _dragLL = ll
    if (_dragRaf) return                       // rAF 节流：每帧最多重投影一次，拖动顺滑不卡
    _dragRaf = requestAnimationFrame(() => {
      _dragRaf = 0
      s.boreType = 'geo'
      // 经度增量按最短弧归一化到 [-180,180]：否则光标/起点分处 ±180 两侧时，增量被算成 ~±360°，
      // bore 会瞬间甩到地球另一侧（越地平消失，表现为"跨 180° 就乱/拉不动"）。纬度不绕，直接夹紧。
      let dLon = _dragLL.lon - _drag.ll.lon
      while (dLon > 180) dLon -= 360
      while (dLon < -180) dLon += 360
      let lon = _drag.lon + dLon
      lon = ((lon % 360) + 540) % 360 - 180   // 结果经度规整到 [-180,180]
      s.boreLon = +lon.toFixed(4)
      s.boreLat = +Math.max(-89.9, Math.min(89.9, _drag.lat + (_dragLL.lat - _drag.ll.lat))).toFixed(4)
    })
  }

  // 缓存：导出/恢复 GRD 面板状态（选中天线 / 聚焦 / 各天线全部设置 / 全局等仰角线）
  function getState() {
    persistActive()
    const cfgs = {}
    for (const key of selected.value) { const c = cache.get(key); if (c && c.settings) cfgs[key] = { ...c.settings, levels: copyLevels(c.settings.levels), beamsToPlot: (c.settings.beamsToPlot || [0]).slice() } }
    // 卫星树：自定义/星座星完整定义 + 全部星的仰角线属性（预置星仅存仰角线，节点本身随 index 复现）
    // 导入天线（已存盘的原始 GRD）随卫星一并保存：重载时据 file 从盘上重建（预置天线由 index 复现，不存）
    const satsState = sats.value.map((s) => ({
      folder: s.folder, kind: s.kind, satName: s.satName,
      lon: s.lon, lat: s.lat, altKm: s.altKm, noradId: s.noradId,
      els: s.els, elevColor: s.elevColor, elevShow: s.elevShow, elevWidth: s.elevWidth, iconSize: s.iconSize, labelSize: s.labelSize, labelShow: s.labelShow !== false,
      antennas: s.antennas.filter((a) => a.imported && a.file).map((a) => ({
        name: a.name, file: a.file, type: a.type || '', band: a.band || '', beams: a.beams, peakDb: a.peakDb, peak: a.peak,
        satLon: a.satLon, satLat: a.satLat, satAlt: a.satAlt, imported: true
      }))
    }))
    const disp = { showName: s.showName, nameSize: s.nameSize, showBore: s.showBore, boreSize: s.boreSize, showVal: s.showVal, valSize: s.valSize }
    return { selected: selected.value.slice(), active: active.value, cfgs, sats: satsState, disp }
  }
  async function restoreState(st) {
    if (!st) return
    // 全局显示选项（天线名/波束中心/数值标签）：先恢复，后续 recompute 即按此绘制
    if (st.disp) for (const k of ['showName', 'nameSize', 'showBore', 'boreSize', 'showVal', 'valSize']) if (st.disp[k] != null) s[k] = st.disp[k]
    // 先恢复卫星：自定义/星座关联星补建到树；所有星（含预置）叠加用户编辑（名称/位置/关联/仰角线）。
    // 预置星节点本身由 index 复现，这里仅叠加用户改过的字段；预置星 kind 始终保持 'preset'。
    if (Array.isArray(st.sats)) {
      for (const ss of st.sats) {
        let node = sats.value.find((x) => x.folder === ss.folder)
        if (!node) {
          if (!ss.kind || ss.kind === 'preset') continue   // 预置星已不在 index（如已删/改版）→ 跳过
          node = { folder: ss.folder, satName: ss.satName || '卫星', kind: ss.kind, antennas: [],
            lon: ss.lon, lat: ss.lat, altKm: ss.altKm, noradId: ss.noradId || null,
            els: '5,10', elevColor: nextElevColor(), elevShow: false, elevWidth: 1.3, iconSize: 30, labelSize: 14, labelShow: true }
          sats.value = [...sats.value, node]
        }
        if (ss.satName) node.satName = ss.satName
        if (Number.isFinite(ss.elevWidth)) node.elevWidth = ss.elevWidth
        if (Number.isFinite(ss.iconSize)) node.iconSize = ss.iconSize
        if (Number.isFinite(ss.labelSize)) node.labelSize = ss.labelSize
        if (typeof ss.labelShow === 'boolean') node.labelShow = ss.labelShow
        if (Number.isFinite(ss.lon)) node.lon = ss.lon
        if (Number.isFinite(ss.lat)) node.lat = ss.lat
        if (Number.isFinite(ss.altKm)) node.altKm = ss.altKm
        node.noradId = ss.noradId || null
        if (ss.els != null) node.els = ss.els
        if (ss.elevColor) node.elevColor = ss.elevColor
        if (typeof ss.elevShow === 'boolean') node.elevShow = ss.elevShow
        if (ss.kind && ss.kind !== 'preset' && node.kind !== 'preset') node.kind = ss.kind
        // 重建该星下已存盘的导入天线（数据从盘上的原始 GRD 在 ensureLoaded 时解析）
        if (Array.isArray(ss.antennas)) {
          for (const aa of ss.antennas) {
            if (!aa || !aa.imported || !aa.file || node.antennas.some((x) => x.name === aa.name)) continue
            node.antennas.push({ name: aa.name, type: aa.type || '', band: aa.band || '', beams: aa.beams, peakDb: aa.peakDb, peak: aa.peak,
              file: aa.file, imported: true, satLon: aa.satLon, satLat: aa.satLat, satAlt: aa.satAlt })
          }
        }
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
      if (cfg) { c.settings = { ...defaultSettings(c.meta.satLon, c.meta.satLat || 0, c.meta.peakDb), ...cfg, levels: cfg.levels ? copyLevels(cfg.levels) : defaultLevels(c.meta.peakDb), beamsToPlot: (cfg.beamsToPlot && cfg.beamsToPlot.length ? cfg.beamsToPlot : [0]).slice() } }
      const b = c.settings
      const basis = antennaBasis(c.meta.satLon, b.boreLon == null ? c.meta.satLon : b.boreLon, b.boreLat, b.yaw, c.meta.satLat || 0, c.meta.satAlt)
      for (const bm of c.beams) bm.proj = projectGrid(bm.grid, c.meta.igrid, basis)
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
  watch(() => s.beamsToPlot, () => { persistActive(); recompute() }, { deep: true })   // Beams To Plot 多选变更 → 回存 + 重绘
  watch(() => s.alpha, (a) => { persistActive(); const sc = getScene(), fl = getFlat(); if (sc) sc.setCoverageFieldAlpha(a); if (fl) fl.setFieldAlpha(a) })
  // 指向变化：reproject 只重投影聚焦天线（本就轻）；拖拽中走单层+单视图快路径，否则全量。
  watch(() => [s.boreLon, s.boreLat, s.yaw], () => { reproject(); _dragging ? recomputeActive() : recompute() })
  // 全局显示选项（天线名/波束中心/数值标签开关与字号）：仅影响标注层，重绘即可（不回存到天线设置）
  watch(() => [s.showName, s.nameSize, s.showBore, s.boreSize, s.showVal, s.valSize], () => recompute())
  // 方位/俯仰模式：az/el 变 → 换算到 boresight 经纬度（再由上面的 watch 触发重投影）
  watch(() => [s.boreAz, s.boreEl, s.boreType], () => {
    if (s.boreType !== 'azel') return
    const m = antMeta(); if (!m) return
    const g = azelToLonLat(m.satLon, s.boreAz, s.boreEl, m.satLat || 0, m.satAlt)
    if (g) { s.boreLon = +g.lon.toFixed(4); s.boreLat = +g.lat.toFixed(4) }
  })

  return {
    sats, expanded, selected, active, loading, s,
    keyOf, isSelected, isActive, isExpanded, antMeta, activeName, beamsCount, satState, dragBore,
    activeBeams, isBeamOn, toggleBeam, setAllBeams, allBeamsOn,
    loadIndex, setActive, toggleAnt, toggleSatAll, toggleExpand, addLevel, removeLevel, importGrd,
    addSatellite, updateSatellite, removeSatellite, removeAntenna, renameAntenna, setElev,
    setDragBore, beamDrag, getState, restoreState, recompute, clearAll, clearDrawing,
    setLivePos, tickLive
  }
}
