// 覆盖图（GRD）逻辑 —— SATSOFT 模型：卫星 → 天线（命名覆盖）。支持多选卫星/天线。
// 选中的天线各成一层渲染到星座3D 的 scene/flat（独立图层）：所有选中天线画等值线；
// 当前聚焦(active)天线额外画分带填充。计算核心 src/viz/grd/{parse,coverage,colormap}.js。
import { ref, reactive, watch } from 'vue'
import { parseGrd } from './parse.js'
import { antennaBasis, antennaBasisAzEl, dirToAzEl, azElGround, surfaceAzEl, projectGrid, fieldDb, bandGeometry, stitchLoops } from './coverage.js'
import { schemeColorsRGB, rgbCss, cssRgb } from './colormap.js'
import { RS_GEO, A, geodeticToEcef, isoElevationContourAt } from '../wgs84.js'
import { effective as displayQuality } from '../../stores/displayQuality.js'
import { appAlert } from '../../stores/alert.js'   // 应用内提示，替代会夺焦点的原生 alert

const H = RS_GEO - A
const GEO_ALT = 35786              // GEO 轨道高度 km（预置星默认）：NASA 标称值（22,236 mi）
// 仰角线配色调色板（卫星属性）：新建/预置星按序分配，可逐星改色
const SAT_PALETTE = ['#66ddff', '#ffd24a', '#7cff8a', '#ff6fae', '#c78bff', '#ff9a5a', '#5ad1ff', '#ff5a5a']

const wrap180 = (x) => ((x % 360) + 540) % 360 - 180
// 凸包（Andrew monotone chain），输入 [[x,y]...]，返回 CCW 顶点环（<3 点原样返回）。
function convexHullCCW(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const crs = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo = []
  for (const q of p) { while (lo.length >= 2 && crs(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q) }
  const up = []
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && crs(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q) }
  lo.pop(); up.pop()
  return lo.concat(up)   // CCW
}
// 卫星可见地平弧（0°仰角线）的凸包，u=lon−satLon 解缠空间、CCW，供 bandGeometry 沿地平平滑裁剪覆盖填充。
// 只随卫星位置变 → 缓存到缓存条目 c（拖拽指向不动卫星位置，命中缓存）。失败返回 null（bandGeometry 回退半平面裁）。
function satHull(c) {
  const lon = c.meta.satLon, lat = c.meta.satLat || 0, alt = c.meta.satAlt
  const key = lon + ',' + lat + ',' + alt
  if (c._hull && c._hull.key === key) return c._hull.hull
  let hull = null
  const arc = isoElevationContourAt(geodeticToEcef(lon, lat, alt), 0, 120)
  if (arc && arc.length >= 3) {
    const ring = convexHullCCW(arc.map((p) => [wrap180(p[0] - lon), p[1]]))
    if (ring.length >= 3) hull = { ring, satLon: lon }
  }
  c._hull = { key, hull }
  return hull
}

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
  // 已存档但尚未加载到 cache 的天线设置（key → cfg）：恢复时从存档灌入，天线一经 ensureLoaded 即套用并移出。
  // 作用：清除绘图(selected 清空)/未绘制的天线，其设置依旧随 getState 回存到本地，不丢失（后续改数据库的过渡形态）。
  const pendingCfgs = new Map()

  const STEP = 1   // 电平间隔（固定 1 dB，用户不可见）
  // 默认 5 档：相对峰值 −1..−5；绝对模式（默认）下换算为 peakDb + (−1..−5) 的绝对值（无 peak 时退回相对数值）。
  // jet 配色按值自动分配（填充色与线色默认同色，可分别改）。
  function defaultLevels(peakDb) {
    const abs = Number.isFinite(peakDb)
    const lv = [-1, -2, -3, -4, -5].map((v) => ({ v: abs ? +(peakDb + v).toFixed(2) : v, color: '', lineColor: '', locked: false, lineSet: false }))
    recolorList(lv); return lv
  }
  // 按值升序分配 jet 色（外圈冷、内圈热）。locked 标记「用户手动配过色」的档：整档锁定，填充与线色
  // 都不再被 jet 重配（记忆到用户下次再改，增删档不抹手动色）。lineSet 表示线色已单独设定（改填充时不跟随）。
  function recolorList(lv) {
    const n = lv.length; if (!n) return
    const cols = schemeColorsRGB('jet', n)
    lv.map((_, i) => i).sort((a, b) => lv[a].v - lv[b].v).forEach((idx, rank) => {
      if (lv[idx].locked) return
      const css = rgbCss(cols[rank]); lv[idx].color = css; lv[idx].lineColor = css
    })
  }

  const s = reactive({
    fill: false, alpha: 0.78, line: true, lineWidth: 1.6,   // 默认不填充（多天线/多星叠加时按需逐个开启）
    ctype: 'abs', levels: defaultLevels(),
    pol: 'RSS', gainOffset: 0, pathLoss: 'none',
    boreType: 'azel', boreLon: null, boreLat: 0, boreAz: 0, boreEl: 0, yaw: 0,
    beamsToPlot: [0],   // 多波束 GRD：要绘制的波束序号（SATSOFT「Beams To Plot」多选；共用本天线同一套电平/极化设置）
    beamNames: {},      // 波束序号 → 自定义波束名（空=用默认「波束 N」）。地图标注与选波束列表均用此名，不再用天线名+波束名
    // 全局显示选项（与 GXT 一致；不随聚焦天线切换，对所有选中天线生效）：天线名 / 波束中心 / 波束中心峰值 / 数值标签
    showName: true, nameSize: 16, showBore: true, boreSize: 5, showPeak: false, peakSize: 12, showVal: false, valSize: 12
  })
  // 天线姿态基底：azel 模式用方向基准（boresight 由 az/el 方向给定，可指深空）；geo 模式用地表目标点。
  function beamBasis(meta, st) {
    if (st.boreType === 'azel') return antennaBasisAzEl(meta.satLon, meta.satLat || 0, meta.satAlt, st.boreAz || 0, st.boreEl || 0, st.yaw || 0)
    return antennaBasis(meta.satLon, st.boreLon == null ? meta.satLon : st.boreLon, st.boreLat || 0, st.yaw || 0, meta.satLat || 0, meta.satAlt)
  }
  // 当前聚焦天线 boresight 的地表落点（深空则 null）：供 tip 显示与 geo↔azel 互换
  function boreGround() {
    const m = antMeta(); if (!m) return null
    if (s.boreType === 'azel') return azElGround(m.satLon, m.satLat || 0, m.satAlt, s.boreAz || 0, s.boreEl || 0)
    return { lon: s.boreLon == null ? m.satLon : s.boreLon, lat: s.boreLat || 0 }
  }

  // 加一档（电平值一律取整数）：
  //  · 无档时——绝对模式从「峰值减1向下取整」起，相对模式从 −1 起（相对峰值）；
  //  · 只有一档时——取「上一档减1向下取整」；
  //  · 多档时——沿最后两档趋势方向再走 1 dB（其余同旧逻辑），结果取整。
  // 之后整体 jet 重新配色（locked 手动配色档不受影响）。
  function addLevel() {
    const lv = s.levels
    const m = antMeta(), peak = m ? m.peakDb : NaN
    let v
    if (!lv.length) v = s.ctype === 'rel' ? -1 : (Number.isFinite(peak) ? Math.floor(peak) - 1 : 50)
    else if (lv.length === 1) v = Math.floor(lv[0].v) - 1
    else { const dir = Math.sign(lv[lv.length - 1].v - lv[lv.length - 2].v) || (s.ctype === 'rel' ? -1 : 1); v = Math.floor(lv[lv.length - 1].v) + dir * STEP }
    lv.push({ v, color: '', lineColor: '', locked: false, lineSet: false })
    recolorList(lv)
  }
  function removeLevel(i) { s.levels.splice(i, 1); recolorList(s.levels) }

  // 每个天线的独立设置（数据库）：除等仰角线(全局参考线)外的全部绘制设置都按天线保存，
  // 切换聚焦时载入该天线设置、编辑时回存，只有用户改动才变。bore 指向同样并入。
  const PA = ['ctype', 'pol', 'gainOffset', 'pathLoss', 'fill', 'line', 'lineWidth', 'alpha', 'boreType', 'boreLon', 'boreLat', 'boreAz', 'boreEl', 'yaw']
  const copyLevels = (lv) => lv.map((L) => ({ v: L.v, color: L.color, lineColor: L.lineColor, locked: !!L.locked, lineSet: !!L.lineSet }))
  function defaultSettings(satLon, satLat = 0, peakDb) {
    return { ctype: 'abs', pol: 'RSS', gainOffset: 0, pathLoss: 'none', fill: false, line: true, lineWidth: 1.6, alpha: 0.78,
      boreType: 'azel', boreLon: satLon == null ? null : satLon, boreLat: satLat || 0, boreAz: 0, boreEl: 0, yaw: 0, beamsToPlot: [0], beamNames: {}, levels: defaultLevels(peakDb) }
  }
  function applySettings(cfg) { if (!cfg) return; for (const k of PA) s[k] = cfg[k]; s.levels = copyLevels(cfg.levels || defaultLevels()); s.beamsToPlot = (cfg.beamsToPlot || []).slice(); s.beamNames = { ...(cfg.beamNames || {}) } }
  // 设置序列化（深拷贝 levels/beamsToPlot/beamNames），供 getState 回存每个天线
  function serializeCfg(st) { return { ...st, levels: copyLevels(st.levels || []), beamsToPlot: (st.beamsToPlot || [0]).slice(), beamNames: { ...(st.beamNames || {}) } } }
  // 把存档 cfg 合到该天线一份完整 settings（缺省字段以 meta 默认补齐）
  function mergeCfg(meta, cfg) {
    return { ...defaultSettings(meta.satLon, meta.satLat || 0, meta.peakDb), ...cfg,
      levels: cfg.levels ? copyLevels(cfg.levels) : defaultLevels(meta.peakDb),
      beamsToPlot: (cfg.beamsToPlot || []).slice(), beamNames: { ...(cfg.beamNames || {}) } }
  }
  // 天线一经加载即套用其待恢复设置（若有），并移出 pending（此后由 cache 接管、getState 从 cache 取最新）
  function applyPendingCfg(key) {
    const cfg = pendingCfgs.get(key); if (!cfg) return
    const c = cache.get(key); if (!c || !c.meta) return
    c.settings = mergeCfg(c.meta, cfg)
    const nb = (c.beams || []).length
    c.settings.beamsToPlot = (c.settings.beamsToPlot || []).filter((i) => i < nb)   // 波束数变化越界保护
    pendingCfgs.delete(key)
  }
  let _muteSync = false
  function persistActive() {     // 把当前面板设置回存到聚焦天线
    if (_muteSync) return
    const c = cache.get(active.value); if (!c || !c.settings) return
    for (const k of PA) c.settings[k] = s[k]
    c.settings.levels = copyLevels(s.levels)
    c.settings.beamsToPlot = s.beamsToPlot.slice()
    c.settings.beamNames = { ...s.beamNames }
  }

  const keyOf = (folder, name) => `${folder}|${name}`
  const findAnt = (key) => { const [f, n] = key.split('|'); const sat = sats.value.find((x) => x.folder === f); return sat && sat.antennas.find((a) => a.name === n) ? { sat, a: sat.antennas.find((a) => a.name === n) } : null }
  const isSelected = (folder, name) => selected.value.includes(keyOf(folder, name))
  const isActive = (folder, name) => active.value === keyOf(folder, name)
  const antMeta = () => { const c = cache.get(active.value); return c && c.meta }
  const activeName = () => active.value ? active.value.split('|')[1] : ''
  const beamsCount = () => { const m = antMeta(); return m ? m.beams : 0 }
  const toF32 = (a) => Float32Array.from(a, (v) => (v == null ? NaN : v))

  // 波束名：自定义优先，否则默认「波束 N」（单波束天线退回天线名）。地图标注与选波束列表共用。
  const defBeamName = (c, bi) => (c.beams.length > 1 ? `波束 ${bi + 1}` : (c.meta && c.meta.name) || `波束 ${bi + 1}`)
  const beamName = (c, bi) => { const o = c.settings && c.settings.beamNames; return (o && o[bi]) || defBeamName(c, bi) }
  // 重命名聚焦天线的第 i 个波束：写入响应式 s.beamNames（空/同默认=清除回退默认），回存并重绘。
  function renameBeam(i, name) {
    const c = cache.get(active.value); if (!c) return
    const nm = String(name == null ? '' : name).trim()
    const m = { ...s.beamNames }
    if (!nm || nm === defBeamName(c, i)) delete m[i]; else m[i] = nm
    s.beamNames = m
    persistActive(); recompute()
  }

  // ===== Beams To Plot（SATSOFT 多选波束）：作用于聚焦天线，共用其同一套电平/极化设置 =====
  // 聚焦天线已载入的波束列表（{ i, label, peakDb }）；单波束天线返回 1 项。label 用波束名（可编辑）。
  const activeBeams = () => {
    const c = cache.get(active.value); if (!c || !c.beams) return []
    return c.beams.map((b, i) => ({ i, label: (s.beamNames && s.beamNames[i]) || defBeamName(c, i), peakDb: b.peakDb }))
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

  // ===== 部分批量多选：按序号/名称筛选 + 对筛选结果 全选/取消/反选（如 94 波束里一次选 1-62）=====
  const beamQuery = ref('')
  const setBeamQuery = (q) => { beamQuery.value = (q == null ? '' : String(q)) }
  // 纯序号语法（"1-62"、"1,3,5"、"1-10,20-30"）→ 1-based 序号集合，否则 null（当作波束名文字搜索）
  function parseSeqSet(q) {
    const set = new Set()
    for (const part of q.split(/[,，\s]+/)) {
      if (!part) continue
      const m = part.match(/^(\d+)\s*[-~]\s*(\d+)$/)
      if (m) { const a = +m[1], b = +m[2]; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i) }
      else if (/^\d+$/.test(part)) set.add(+part)
      else return null
    }
    return set.size ? set : null
  }
  // 按查询过滤聚焦天线波束：序号语法按 1-based 序号(i+1)，否则按波束名文字（大小写不敏感）。空查询=全部。
  function filteredBeams() {
    const all = activeBeams()
    const q = beamQuery.value.trim()
    if (!q) return all
    const seq = parseSeqSet(q)
    if (seq) return all.filter((b) => seq.has(b.i + 1))
    const ql = q.toLowerCase()
    return all.filter((b) => String(b.label).toLowerCase().includes(ql))
  }
  // Excel 「(全选)」三态：筛选结果全部已选 / 部分已选(半选 indeterminate) / 全未选。
  const filteredAllOn = () => { const f = filteredBeams(); return f.length > 0 && f.every((b) => s.beamsToPlot.includes(b.i)) }
  const filteredAnyOn = () => filteredBeams().some((b) => s.beamsToPlot.includes(b.i))
  // 勾选「(全选)/(全选搜索结果)」：作用于当前筛选结果（无查询=全部），累加进已选 → Excel 式批量选。
  function selectFiltered(on) {
    const ids = filteredBeams().map((b) => b.i)
    const set = new Set(s.beamsToPlot)
    if (on) ids.forEach((i) => set.add(i)); else ids.forEach((i) => set.delete(i))
    s.beamsToPlot = [...set].sort((a, b) => a - b)
  }

  // ===== 卫星节点：增/删/改 + 仰角线属性 =====
  // 轮转取色：卫星颜色默认已改为白色，下列暂保留备用（当前未调用）；如需恢复彩色，把 normPreset/addSatellite 的 '#ffffff' 改回 nextElevColor() 即可
  let _colorSeq = 0
  const nextElevColor = () => SAT_PALETTE[_colorSeq++ % SAT_PALETTE.length]
  // 预置星（index）补齐统一节点字段：GEO 定点(lon,0,GEO_ALT)、仰角线默认关、卫星名默认开、颜色默认白
  const normPreset = (s) => ({ ...s, kind: 'preset', lat: 0, altKm: GEO_ALT, noradId: null, els: '5,10', elevColor: '#ffffff', elevShow: false, elevWidth: 1.3, elevLabelSize: 18, iconSize: 30, labelSize: 9, iconShow: true, labelShow: true })
  // 同名加点号去重，作为节点唯一 key（folder）
  function genFolder(name) {
    const base = (name || '卫星').trim() || '卫星'
    let f = base, i = 1
    while (sats.value.some((x) => x.folder === f)) f = `${base}·${++i}`
    return f
  }
  // 往树里加一颗卫星：noradId 非空=星座关联星（位置随星历，由页面解算）；
  // 否则 elements 非空=轨道根数模拟星（位置由页面 SGP4 自行解算，随时间动）；都没有=固定 lon/lat/alt 自定义星。
  function addSatellite(draft) {
    const folder = genFolder(draft.name)
    const node = {
      folder, satName: (draft.name || '卫星').trim() || '卫星',
      kind: draft.noradId ? 'linked' : (draft.elements ? 'orbit' : 'custom'),
      lon: Number(draft.lon) || 0, lat: Number(draft.lat) || 0, altKm: Number(draft.altKm) || GEO_ALT,
      noradId: draft.noradId || null,
      elements: draft.elements || null,
      els: draft.els != null ? draft.els : '5,10',
      elevColor: draft.color || '#ffffff', elevShow: false, elevWidth: Number(draft.elevWidth) || 1.3,
      elevLabelSize: Number(draft.elevLabelSize) || 18,
      iconSize: Number(draft.iconSize) || 30, labelSize: Number(draft.labelSize) || 9, iconShow: draft.iconShow !== false, labelShow: true,
      antennas: []
    }
    sats.value = [...sats.value, node]
    expanded.value = { ...expanded.value, [folder]: true }
    return node
  }
  function updateSatellite(folder, patch) {
    const n = sats.value.find((x) => x.folder === folder); if (!n) return
    // 位置（经纬度/高度 或 轨道根数）变化 → 编辑后让该星天线覆盖图跟随重投影（仰角线由页面 redrawSats 处理）
    const moved = ('lon' in patch && Number(patch.lon) !== n.lon) || ('lat' in patch && Number(patch.lat) !== n.lat) || ('altKm' in patch && Number(patch.altKm) !== n.altKm) || ('elements' in patch)
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
      cache.delete(k); pendingCfgs.delete(k)
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
    cache.delete(key); pendingCfgs.delete(key)
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
    if (pendingCfgs.has(oldKey)) { pendingCfgs.set(newKey, pendingCfgs.get(oldKey)); pendingCfgs.delete(oldKey) }   // 迁移未加载天线的存档设置
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
        if (a0) {
          const key = await ensureLoaded(sats.value[0].folder, a0)   // 初次打开默认显示第一颗天线（此后编辑不再顺带改显示）
          if (!selected.value.includes(key)) selected.value = [...selected.value, key]
          await setActive(sats.value[0], a0)
        }
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
        applyPendingCfg(key)   // 套用存档设置（若有）
      } catch (e) { console.warn('导入 GRD 重载失败', a.file, e) }
      return key
    }
    const raw = await window.api.coverageGrd.get(a.file)
    const settings = defaultSettings(raw.meta.satLon, raw.meta.satLat || 0, raw.meta.peakDb)
    // 预置天线自带经纬度 boresight：用经纬度模式载入以原样保留（避免 azel 默认按 az/el=0 归零到星下点）
    settings.boreType = 'geo'; settings.boreLon = raw.meta.antenna.boreLon; settings.boreLat = raw.meta.antenna.boreLat
    // 用本地 projectGrid 重投影（而非后端烘焙的 lon/lat），得到地平裕度 vis + 越地平点落到地平，
    // 这样预置天线也能精确切在 0°仰角线（后端数据无 vis、越地平点为 NaN，会留网格锯齿）。
    const basis = beamBasis({ satLon: raw.meta.satLon, satLat: raw.meta.satLat || 0, satAlt: raw.meta.satAlt }, settings)
    const proj = projectGrid(raw.meta.grid, raw.meta.igrid, basis, null, null, true)
    // 预置天线（后端烘焙）只含单波束 set0，包成统一的 beams[1] 结构
    const beam0 = { P1: toF32(raw.P1), P2: toF32(raw.P2), grid: raw.meta.grid, proj, peakDb: raw.meta.peakDb, peak: raw.meta.peak }
    cache.set(key, { meta: { ...raw.meta, beams: 1 }, beams: [beam0], settings })   // 每天线各存全部设置（含指向），数据库式
    applyPendingCfg(key)   // 套用存档设置（若有），并据此重投影
    if (cache.get(key).settings !== settings) {   // pending 已套用 → 用恢复后的指向重算投影
      const c = cache.get(key), basis2 = beamBasis({ satLon: raw.meta.satLon, satLat: raw.meta.satLat || 0, satAlt: raw.meta.satAlt }, c.settings)
      c.beams[0].proj = projectGrid(raw.meta.grid, raw.meta.igrid, basis2, null, null, true)
    }
    return key
  }

  // 点击天线名 → 仅设为聚焦/编辑对象，不改变其显示状态（显示与否只由勾选框 toggleAnt 控制，两者解耦）
  async function setActive(sat, a) {
    loading.value = true
    try {
      const key = await ensureLoaded(sat.folder, a)
      active.value = key
      const c = cache.get(key)
      // beamsToPlot 越界保护（如旧存档波束数变化）：过滤掉不存在的波束。空保持空（= 不绘制任何波束）。
      const nb = (c.beams || []).length
      c.settings.beamsToPlot = (c.settings.beamsToPlot || []).filter((i) => i < nb)
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

  // 指向(basis)签名：投影只随它变。azel 模式按 az/el，geo 模式按 lon/lat。
  const basisKeyOf = (c) => {
    const m = c.meta, b = c.settings
    const p = b.boreType === 'azel' ? ('A' + (b.boreAz || 0) + ',' + (b.boreEl || 0)) : ('G' + (b.boreLon == null ? m.satLon : b.boreLon) + ',' + (b.boreLat || 0))
    return p + ',' + (b.yaw || 0) + ',' + m.satLon + ',' + (m.satLat || 0) + ',' + (m.satAlt || 0)
  }
  // 最低绝对档（相对模式 = 峰值 + 最低相对值）：低于它的点无覆盖、不参与绘制。
  const lowestAbs = (max, cfg) => { let lo = Infinity; for (const L of cfg.levels) { const a = cfg.ctype === 'rel' ? max + L.v : L.v; if (a < lo) lo = a }; return lo }
  // 覆盖热区子矩形：db ≥ L0 的点的包围盒，各向外扩 1（含边界格的 <L0 角，等值线插值需要）。
  // db 与指向无关（pathLoss='none'），故拖拽中此盒不变 → 缓存。其余区域不投影/不三角化。
  function computeBox(db, NX, NY, L0) {
    let r0 = NY, r1 = -1, c0 = NX, c1 = -1
    for (let r = 0; r < NY; r++) { const rb = r * NX; for (let c = 0; c < NX; c++) { if (db[rb + c] >= L0) { if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c } } }
    if (r1 < 0) return { r0: 0, r1: -1, c0: 0, c1: -1 }   // 无覆盖：空盒（投影/三角化都不跑）
    return { r0: Math.max(0, r0 - 1), r1: Math.min(NY - 1, r1 + 1), c0: Math.max(0, c0 - 1), c1: Math.min(NX - 1, c1 + 1) }
  }
  // 取该波束在给定场/电平下的热区盒（按 field 引用 + L0 缓存）。pathLoss≠none 时 db 随指向变 → 不裁剪（返回 null）。
  function beamBox(beam, cfg, field) {
    if (cfg.pathLoss !== 'none' || !field) return null
    const L0 = lowestAbs(field.max, cfg)
    if (beam._box && beam._box.field === field && beam._box.L0 === L0) return beam._box.box
    const box = computeBox(field.db, field.NX, field.NY, L0)
    beam._box = { field, L0, box }
    return box
  }
  // 投影同步：当 (指向 + 热区盒) 变化时才重投影该波束，并原地复用其 proj 数组。
  // 只对「绘制中(beamsToPlot)」的波束调用 → HTS 只画 1/N 省 N 倍；热区盒进一步把每个波束的投影量降到覆盖区。
  function syncBeamProj(c, beam, cfg, field) {
    const box = beamBox(beam, cfg, field)
    const bkey = basisKeyOf(c) + '|' + (box ? `${box.r0}_${box.r1}_${box.c0}_${box.c1}` : 'F')
    if (beam._projKey === bkey) return
    const basis = beamBasis(c.meta, cfg)
    beam.proj = projectGrid(beam.grid, c.meta.igrid, basis, box, beam.proj, true)   // limbOutside：越地平点延伸到地平外，供地平弧裁剪
    beam._projKey = bkey
  }
  function reproject() {
    const c = cache.get(active.value); if (!c) return
    persistActive()   // 回存该天线全部设置（含指向）
    const plot = (s.beamsToPlot || [])
    // 预投影绘制中的波束（拖拽每帧核心）：用已缓存的场算热区盒（拖拽中 pol/gain 不变 → 场稳定）
    for (const bi of plot) { const beam = c.beams[bi]; if (beam) syncBeamProj(c, beam, c.settings, (c.settings.pathLoss === 'none' && beam._fld) ? beam._fld.field : null) }
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
  // 方向图 dB 只随 极化/增益 变，与指向(投影)无关 → pathLoss='none' 时按 (pol,gain) 缓存到波束上，
  // 拖拽时直接复用，免去每帧整张网格的 log10 重算。pathLoss 依赖斜距(随指向变)，此时照常重算不缓存。
  function beamField(beam, cfg) {
    const arg = { P1: beam.P1, P2: beam.P2, NX: beam.proj.NX, NY: beam.proj.NY }
    if (cfg.pathLoss !== 'none') return fieldDb(arg, beam.proj, { pol: cfg.pol, gainOffset: cfg.gainOffset, pathLoss: cfg.pathLoss })
    const cc = beam._fld
    if (cc && cc.pol === cfg.pol && cc.gain === cfg.gainOffset) return cc.field
    const field = fieldDb(arg, beam.proj, { pol: cfg.pol, gainOffset: cfg.gainOffset, pathLoss: 'none' })
    beam._fld = { pol: cfg.pol, gain: cfg.gainOffset, field }
    return field
  }
  function buildBeamLayer(c, cfg, beam, name, withLabels) {
    const field = beamField(beam, cfg)
    const lv = absLevels(field.max, cfg)
    const asc = [...lv].sort((a, b) => a.abs - b.abs)   // 升序档：外圈冷、内圈热（与 jet 配色一致）
    // 用新场算热区盒并确保投影覆盖它（权威同步：处理电平/极化变化导致盒变大、未过 reproject 的情形）
    const box = beamBox(beam, cfg, field)
    syncBeamProj(c, beam, cfg, field)
    const need = cfg.fill || cfg.line
    // wantFills=cfg.fill：只画等值线时跳过逐档填充裁剪（关填充的大波束拖拽省一半三角化）；box：只三角化覆盖热区
    const geo = need ? bandGeometry({ lon: beam.proj.lon, lat: beam.proj.lat, vis: beam.proj.vis, db: field.db, NX: beam.proj.NX, NY: beam.proj.NY }, asc.map((x) => x.abs), cfg.fill, box, cfg.fill ? satHull(c) : null, displayQuality.value.gridStride) : null
    // 分带填充：每档一个颜色 + 该档环带多边形（升序，逐层从外到内绘制，非嵌套→无重叠透明叠加）
    const fillBands = cfg.fill && geo ? asc.map((x, i) => ({ color: cssRgb(x.color), verts: geo.fills[i].verts, counts: geo.fills[i].counts })).filter((b) => b.counts.length) : null
    // 等值线：每档一组线段（= 填充相邻档公共边）；数值标签按拼环后每条取最上端点。
    // 标签仅在「显示数值」开启时才拼环求锚点——关闭时跳过 stitchLoops，拖拽时省一笔。
    const segGroups = cfg.line && geo
      ? asc.map((x, i) => {
        const segs = geo.lines[i]
        const labels = []
        if (withLabels) for (const loop of stitchLoops(segs)) { if (loop.length >= 4) labels.push(loopTop(loop)) }
        // txt 与「电平」输入框原值（x.v = L.v）完全一致，不做小数位裁剪——绝对模式下 x.abs 恒等于 x.v，
        // 之前用 toFixed(1) 会把用户输入的更高精度电平（如 42.567）显示成 42.6，与输入框对不上。
        return { segs, color: x.lineColor, width: cfg.lineWidth, txt: String(x.v), labels }
      }).filter((g) => g.segs.length)
      : []
    // 波束中心 = 当前场的峰值点（随指向/拖拽实时变化）；波束名标签贴在此处，并向所属卫星连线
    const pk = (Number.isFinite(beam.proj.lon[field.maxIdx]) && Number.isFinite(beam.proj.lat[field.maxIdx])) ? [beam.proj.lon[field.maxIdx], beam.proj.lat[field.maxIdx]] : (beam.peak || c.meta.peak || [c.meta.satLon, 0])
    // peak = 波束中心峰值 dB（当前场峰值；显示用，随极化/增益/路损变）
    const bore = { lon: pk[0], lat: pk[1], satLon: c.meta.satLon, satLat: c.meta.satLat || 0, satAlt: c.meta.satAlt || H, peak: Number.isFinite(field.max) ? field.max : null }
    return { fillBands, segGroups, bore, name }
  }
  // 每个选中天线 → N 个子图层（按 Beams To Plot 选中的波束逐个出层）；所有子层共用该天线同一套设置。
  // 所有选中画线，每个【开启填充】的天线各自分带填充（多天线/多波束/多星可叠加）。
  // 2D 与 3D 同源同一份几何 { fillBands(各档环带多边形+色), segGroups(等值线段) }，均由 bandGeometry
  //   逐三角形线性插值生成 → 填充与线精确重合；地平/接缝裁剪在 bandGeometry 内完成（不再依赖位图/着色器取档）。
  function buildLayer(key, withLabels) {
    const c = cache.get(key); if (!c || !c.beams) return []
    const cfg = c.settings   // 每层用自身保存的设置（聚焦层的实时编辑已由 watcher 回存到此）
    // satShown = 该天线所属卫星的「卫星名」是否显示：3D 连线(卫星↔波束中心)需 showBore 且 satShown 同时为真
    const node = sats.value.find((x) => x.folder === key.split('|')[0])
    const satShown = !node || node.labelShow !== false
    const plot = (cfg.beamsToPlot || []).filter((i) => i < c.beams.length)   // 全未选 → 不绘制任何波束
    return plot.map((bi) => {
      // 投影同步在 buildBeamLayer 内用新场完成（覆盖 reproject 未触及/新勾选的波束，且按热区盒裁剪）
      // 标注一律用波束名（自定义或默认「波束 N」）—— 不再用「天线名+波束名」形式
      const L = buildBeamLayer(c, cfg, c.beams[bi], beamName(c, bi), withLabels)
      L.id = `${key}#${bi}`   // 稳定层 id（天线键|波束序号）：渲染层据此做拖拽增量更新（只重建聚焦天线层）
      if (L.bore) L.bore.satShown = satShown
      return L
    })
  }

  const fieldOpts = () => ({ alpha: s.alpha, showBore: s.showBore, boreSize: s.boreSize, showName: s.showName, nameSize: s.nameSize, showPeak: s.showPeak, peakSize: s.peakSize, showVal: s.showVal, valSize: s.valSize })
  function recompute() {
    const sc = getScene(), fl = getFlat()
    // 聚焦（编辑中）天线排到最后 → 填充叠加时位于最上层，最醒目（其余按选中顺序在下）
    const ks = [...selected.value].sort((a, b) => (a === active.value ? 1 : 0) - (b === active.value ? 1 : 0))
    const layers = ks.flatMap((k) => buildLayer(k, s.showVal))   // 每天线展开成 N 个波束子层；2D/3D 共用同一份（省一半重算）
    const opts = fieldOpts()
    if (sc) sc.setCoverageField(layers, opts)
    if (fl) fl.setField(layers, opts)
  }
  // 拖拽热路径：只重算【聚焦天线】这一层，并只补丁【当前可见视图】（2D 或 3D，由 isFlat 决定）。
  // 其余天线层不变（拖拽不改它们的投影），另一视图在拖拽结束时由 recompute 一次性补齐 → 每帧工作量大幅下降。
  function recomputeActive() {
    if (!active.value || !selected.value.includes(active.value)) return   // 未勾选显示的天线，编辑/拖拽时也不上图
    const layers = buildLayer(active.value, s.showVal)
    const opts = fieldOpts()
    if (isFlat()) { const fl = getFlat(); if (fl) fl.patchField(layers, opts) }
    else { const sc = getScene(); if (sc) sc.patchCoverageLayers(layers, opts) }
  }
  // rAF 合帧的聚焦层重算（与拖拽同策略）：<input type=color> 的 @input 在挑色时高频连发，
  // 逐事件同步 recomputeActive 会把主线程打满 → 卡。合帧后一帧最多重算一次，挑色与拖拽同样顺滑。
  let _activeRaf = 0
  function scheduleRecomputeActive() {
    if (_activeRaf) return
    _activeRaf = requestAnimationFrame(() => { _activeRaf = 0; recomputeActive() })
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
    const b = c.settings
    // geo 模式：指向随星下点平移（保留地面目标的相对偏置）。azel 模式：az/el 相对天底，星动时自动跟随，无需平移。
    if (b.boreType !== 'azel') {
      let dLon = p.lon - oLon; while (dLon > 180) dLon -= 360; while (dLon < -180) dLon += 360
      const bl = (b.boreLon == null ? oLon : b.boreLon) + dLon
      b.boreLon = +(((bl % 360) + 540) % 360 - 180).toFixed(4)
      b.boreLat = +Math.max(-89.9, Math.min(89.9, (b.boreLat || 0) + (p.lat || 0) - oLat)).toFixed(4)
    }
    c.meta.satLon = p.lon; c.meta.satLat = p.lat || 0; c.meta.satAlt = p.altKm
    for (const bm of c.beams) bm._projKey = null   // 标记投影过期 → 下次按热区盒重投影（只重算绘制中的波束）
    if (key === active.value && b.boreType !== 'azel') { _muteSync = true; s.boreLon = b.boreLon; s.boreLat = b.boreLat; _muteSync = false }
    return true
  }
  // 实时跟踪：linked 星随星历/时间轴移动 → 平移各选中天线的覆盖投影。
  // 由页面在 refreshPositions（1s 实时 / 时间轴拖动）调用。
  // extraKey：性能指标表当前打开的天线 key。即使其覆盖未绘制（不在 selected），也需随星移动其 meta，
  // 否则 getPerfContext 取到陈旧星位、表值不随时间轴波动。perfMoved 单独返回，供页面只在该表星动时重算。
  function tickLive(extraKey = null) {
    const keys = new Set(selected.value)
    if (extraKey) keys.add(extraKey)
    if (!keys.size) return { changed: false, perfMoved: false }
    let changed = false, perfMoved = false
    for (const key of keys) {
      const c = cache.get(key); if (!c || !c.meta) continue
      const node = sats.value.find((x) => x.folder === c.meta.folder)
      if (!node || (!node.noradId && !node.elements)) continue   // 仅星座关联星 / 轨道根数模拟星跟踪（固定星不动）
      if (moveCoverage(c, key, liveOf(node))) { if (selected.value.includes(key)) changed = true; if (key === extraKey) perfMoved = true }
    }
    if (changed) recompute()   // 仅绘制中的覆盖层变了才重绘；未绘制的性能表天线只需 meta 已更新
    return { changed, perfMoved }
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
      const proj = projectGrid(set, g.igrid, basis, null, null, true)
      const field = fieldDb({ P1: set.P1, P2: set.P2, NX: set.NX, NY: set.NY }, proj, { pol: 'RSS' })
      const peak = [+proj.lon[field.maxIdx].toFixed(4), +proj.lat[field.maxIdx].toFixed(4)]
      return { P1: set.P1, P2: set.P2, c1re: set.c1re, c1im: set.c1im, c2re: set.c2re, c2im: set.c2im, grid: { XS: set.XS, YS: set.YS, XE: set.XE, YE: set.YE, NX: set.NX, NY: set.NY }, proj, peakDb: +field.max.toFixed(3), peak }
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
    if (!sat) { appAlert('请先选择一颗卫星'); return }
    loading.value = true
    try {
      const res = await window.api.coverageGrd.open()
      if (!res || res.canceled) return
      // 多选：每个文件 = 一个天线。兼容旧返回（单文件 {base,text}）。
      const files = res.files || (res.text ? [{ base: res.base, text: res.text }] : [])
      if (!files.length) { appAlert('读取失败：' + (res.error || '空文件')); return }
      const errs = []
      let lastKey = null, lastPeak = null
      for (const f of files) {
        if (f.error || !f.text) { errs.push((f.base || '文件') + '：' + (f.error || '空文件')); continue }
        let g
        try { g = parseGrd(f.text) } catch (e) { errs.push((f.base || '文件') + '：解析失败 ' + e.message); continue }
        let name = (f.base || 'GRD').replace(/\.(grd|pat)$/i, '')
        while (sat.antennas.some((a) => a.name === name)) name += '·'   // 重名加后缀
        const ent = importedCacheEntry(sat, g, name)
        const m = ent.meta
        // 原始 GRD 存盘（userData/coverage-grd-imported）；失败则仅本会话内有效，不阻断导入
        let file = null
        try { const r = await window.api.coverageGrd.save(f.base || name, f.text); file = r && r.file } catch (e) { console.warn('GRD 持久化失败，仅本会话内有效', e) }
        const key = keyOf(sat.folder, name)
        // 多波束默认只画第 1 个波束（与 SATSOFT 一致：Beams To Plot 由用户按需多选/全选）。
        // 切勿默认全选——HTS 动辄 20+ 波束，一次性建几十个网格/提几十遍等值线会瞬时压垮 GPU（见 command_buffer 崩溃）。
        const settings = defaultSettings(m.satLon, m.satLat, m.peakDb)
        cache.set(key, { meta: m, beams: ent.beams, settings })
        sat.antennas.push({ name, type: '', band: '', beams: m.beams, peakDb: ent.peakDb, peak: ent.peak, file, imported: true, satLon: m.satLon, satLat: m.satLat, satAlt: m.satAlt })
        selected.value = [...selected.value, key]
        lastKey = key; lastPeak = ent.peak
      }
      if (lastKey) {
        expanded.value = { ...expanded.value, [sat.folder]: true }
        active.value = lastKey                 // 聚焦最后导入的天线
        _muteSync = true; applySettings(cache.get(lastKey).settings); _muteSync = false
        recompute()
        const sc = getScene(); if (sc && lastPeak) sc.faceLonLat(lastPeak[0], lastPeak[1])
      }
      if (errs.length) appAlert('部分文件导入失败：\n' + errs.join('\n'))
    } finally { loading.value = false }
  }

  // 拖拽波束：在方向(az/el)空间相对拖动。地表经纬度在地平附近非单调（过地平会回折，导致"拖不到地平线"），
  // 故改用「光标方向(夹到地平)的 az/el」做增量 → 单调、可一路拖到地平线；落在可见地表时松手转回 geo 便于精调。
  const dragBore = ref(false)
  function setDragBore(v) { dragBore.value = !!v; const sc = getScene(), fl = getFlat(); if (sc) sc.setBeamDragMode(dragBore.value); if (fl) fl.setBeamDragMode(dragBore.value) }
  let _drag = null, _dragRaf = 0, _dragLL = null, _dragging = false
  const curAzEl = (m, lon, lat) => surfaceAzEl(m.satLon, m.satLat || 0, m.satAlt, lon, lat)
  function beamDrag(ll, phase) {
    if (phase === 'end') {   // 松手：退出拖拽态；boresight 落在可见地表则转回 geo（面板便于精调），地平外保持 azel
      if (_dragRaf) { cancelAnimationFrame(_dragRaf); _dragRaf = 0 }
      _drag = null; _dragging = false
      if (s.boreType === 'azel') { const g = boreGround(); if (g) { s.boreType = 'geo'; s.boreLon = +g.lon.toFixed(4); s.boreLat = +g.lat.toFixed(4) } }
      recompute(); return
    }
    if (!active.value || !ll) return
    const m = antMeta(); if (!m) return
    if (phase === 'start') {
      _dragging = true
      // 锚点：当前 boresight 的 az/el（geo 模式由其落点换算）+ 起拖光标的 az/el
      const base = s.boreType === 'azel' ? { az: s.boreAz || 0, el: s.boreEl || 0 } : dirToAzEl(m.satLon, m.satLat || 0, m.satAlt, s.boreLon == null ? m.satLon : s.boreLon, s.boreLat || 0)
      _drag = { base, cur0: curAzEl(m, ll.lon, ll.lat) }
      return
    }
    if (!_drag) return
    _dragLL = ll
    if (_dragRaf) return                       // rAF 节流：每帧最多重投影一次
    _dragRaf = requestAnimationFrame(() => {
      _dragRaf = 0
      const c = curAzEl(m, _dragLL.lon, _dragLL.lat)
      s.boreType = 'azel'
      s.boreAz = +(_drag.base.az + (c.az - _drag.cur0.az)).toFixed(3)
      s.boreEl = +(_drag.base.el + (c.el - _drag.cur0.el)).toFixed(3)
    })
  }

  // 缓存：导出/恢复 GRD 面板状态（选中天线 / 聚焦 / 各天线全部设置 / 全局等仰角线）
  function getState() {
    persistActive()
    // 回存【所有已配置天线】的设置（不止当前绘制的）：未加载的沿用 pending 存档，已加载的取 cache 最新。
    // 这样「清除绘图」后 selected 为空，各天线设置仍完整保存到本地，重载即原样恢复。
    const cfgs = {}
    for (const [key, cfg] of pendingCfgs) cfgs[key] = cfg
    for (const [key, c] of cache) { if (c && c.settings) cfgs[key] = serializeCfg(c.settings) }
    // 卫星树：自定义/星座星完整定义 + 全部星的仰角线属性（预置星仅存仰角线，节点本身随 index 复现）
    // 导入天线（已存盘的原始 GRD）随卫星一并保存：重载时据 file 从盘上重建（预置天线由 index 复现，不存）
    const satsState = sats.value.map((s) => ({
      folder: s.folder, kind: s.kind, satName: s.satName,
      lon: s.lon, lat: s.lat, altKm: s.altKm, noradId: s.noradId, elements: s.elements || null,
      els: s.els, elevColor: s.elevColor, elevShow: s.elevShow, elevWidth: s.elevWidth, elevLabelSize: s.elevLabelSize, iconSize: s.iconSize, labelSize: s.labelSize, labelShow: s.labelShow !== false, iconShow: s.iconShow !== false,
      antennas: s.antennas.filter((a) => a.imported && a.file).map((a) => ({
        name: a.name, file: a.file, type: a.type || '', band: a.band || '', beams: a.beams, peakDb: a.peakDb, peak: a.peak,
        satLon: a.satLon, satLat: a.satLat, satAlt: a.satAlt, imported: true
      }))
    }))
    const disp = { showName: s.showName, nameSize: s.nameSize, showBore: s.showBore, boreSize: s.boreSize, showPeak: s.showPeak, peakSize: s.peakSize, showVal: s.showVal, valSize: s.valSize }
    return { selected: selected.value.slice(), active: active.value, cfgs, sats: satsState, disp }
  }
  async function restoreState(st) {
    if (!st) return
    // 全局显示选项（天线名/波束中心/数值标签）：先恢复，后续 recompute 即按此绘制
    if (st.disp) for (const k of ['showName', 'nameSize', 'showBore', 'boreSize', 'showPeak', 'peakSize', 'showVal', 'valSize']) if (st.disp[k] != null) s[k] = st.disp[k]
    // 先恢复卫星：自定义/星座关联星补建到树；所有星（含预置）叠加用户编辑（名称/位置/关联/仰角线）。
    // 预置星节点本身由 index 复现，这里仅叠加用户改过的字段；预置星 kind 始终保持 'preset'。
    if (Array.isArray(st.sats)) {
      for (const ss of st.sats) {
        let node = sats.value.find((x) => x.folder === ss.folder)
        if (!node) {
          if (!ss.kind || ss.kind === 'preset') continue   // 预置星已不在 index（如已删/改版）→ 跳过
          node = { folder: ss.folder, satName: ss.satName || '卫星', kind: ss.kind, antennas: [],
            lon: ss.lon, lat: ss.lat, altKm: ss.altKm, noradId: ss.noradId || null, elements: ss.elements || null,
            els: '5,10', elevColor: '#ffffff', elevShow: false, elevWidth: 1.3, elevLabelSize: 18, iconSize: 10, labelSize: 4, labelShow: true, iconShow: true }
          sats.value = [...sats.value, node]
        }
        if (ss.satName) node.satName = ss.satName
        if (Number.isFinite(ss.elevWidth)) node.elevWidth = ss.elevWidth
        if (Number.isFinite(ss.elevLabelSize)) node.elevLabelSize = ss.elevLabelSize
        if (Number.isFinite(ss.iconSize)) node.iconSize = ss.iconSize
        if (Number.isFinite(ss.labelSize)) node.labelSize = ss.labelSize
        if (typeof ss.labelShow === 'boolean') node.labelShow = ss.labelShow
        if (typeof ss.iconShow === 'boolean') node.iconShow = ss.iconShow
        if (Number.isFinite(ss.lon)) node.lon = ss.lon
        if (Number.isFinite(ss.lat)) node.lat = ss.lat
        if (Number.isFinite(ss.altKm)) node.altKm = ss.altKm
        node.noradId = ss.noradId || null
        if ('elements' in ss) node.elements = ss.elements || null
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
    // 灌入【所有】已存档天线设置到 pending（含未绘制/清除绘图的）：天线一经加载即套用；getState 时一并回存 → 不丢失。
    pendingCfgs.clear()
    if (st.cfgs) for (const key in st.cfgs) pendingCfgs.set(key, st.cfgs[key])
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
      await ensureLoaded(info.sat.folder, info.a)                          // 内部 applyPendingCfg 已套用 st.cfgs[key]
      const c = cache.get(key); if (!c) continue
      const lc = legacy(key); if (lc) c.settings = mergeCfg(c.meta, lc)    // 旧格式：pending 为空，在此套用兜底 cfg
      const b = c.settings
      const basis = beamBasis(c.meta, b)
      for (const bm of c.beams) { bm.proj = projectGrid(bm.grid, c.meta.igrid, basis, null, null, true); bm._projKey = null }
      expanded.value = { ...expanded.value, [info.sat.folder]: true }
      keys.push(key)
    }
    selected.value = keys
    active.value = (st.active && keys.includes(st.active)) ? st.active : (keys[0] || '')
    if (active.value) { _muteSync = true; applySettings(cache.get(active.value).settings); _muteSync = false }
    recompute()
  }

  // 性能指标表取值上下文：某天线(key)的名义指向 basis + 当前「Beams To Plot」选中的波束（含数据/名/序号）
  // + 计算设置。供 usePerfTable 逐站调用 sampleBeamAt。该天线未加载缓存时返回 null。
  function getPerfContext(key) {
    const c = cache.get(key); if (!c || !c.beams) return null
    const basis = beamBasis(c.meta, c.settings)
    const folder = key.split('|')[0]
    const satIdx = sats.value.findIndex((x) => x.folder === folder)
    const node = satIdx >= 0 ? sats.value[satIdx] : null
    const antIdx = node ? node.antennas.findIndex((a) => a.name === key.split('|')[1]) : -1
    return {
      key, igrid: c.meta.igrid, icomp: c.meta.icomp, basis, meta: c.meta, settings: c.settings,
      satNo: satIdx + 1, antNo: antIdx + 1,
      satName: (node && node.satName) || c.meta.sat || '', antName: key.split('|')[1],
      // 性能表列【整张 GRD 的全部波束】（所有 set），不受「Beams To Plot」绘制选择影响；
      // 取值口径/指向仍跟随天线设置。覆盖该城市的波束由 filterOn(minDir) 过滤后显示（SATSOFT 口径）。
      beams: c.beams.map((bm, bi) => ({ bi, name: beamName(c, bi), peakDb: bm.peakDb, beam: bm }))
    }
  }

  // 确保某天线已载入缓存（性能表对【非聚焦】天线取值前调用），返回是否就绪。
  async function ensureAntLoaded(key) {
    if (cache.has(key)) return true
    const info = findAnt(key); if (!info) return false
    await ensureLoaded(info.sat.folder, info.a)
    return cache.has(key)
  }

  // 导出当前【选中且绘制中】天线波束的等值线为 GXT 用数据（闭合环 + 增益）。供文件管理器「导出当前画面覆盖为 GXT」。
  // 复用绘制同款 bandGeometry，按各档拼成闭合环（stitchLoops）；相对模式记档值，绝对模式记绝对 dB。
  function exportContours() {
    const out = []
    for (const key of selected.value) {
      const c = cache.get(key); if (!c || !c.beams) continue
      const cfg = c.settings
      const node = sats.value.find((x) => x.folder === key.split('|')[0])
      const plot = (cfg.beamsToPlot || []).filter((i) => i < c.beams.length)
      for (const bi of plot) {
        const beam = c.beams[bi]
        const field = beamField(beam, cfg)
        const asc = [...absLevels(field.max, cfg)].sort((a, b) => a.abs - b.abs)
        const box = beamBox(beam, cfg, field)
        syncBeamProj(c, beam, cfg, field)
        const geo = bandGeometry({ lon: beam.proj.lon, lat: beam.proj.lat, vis: beam.proj.vis, db: field.db, NX: beam.proj.NX, NY: beam.proj.NY }, asc.map((x) => x.abs), false, box, null, displayQuality.value.gridStride)
        const contours = []
        asc.forEach((x, i) => {
          for (const loop of stitchLoops(geo.lines[i])) {
            if (loop.length >= 4) contours.push({ g: cfg.ctype === 'rel' ? x.v : +x.abs.toFixed(2), p: loop.map((p) => [+p[0].toFixed(3), +p[1].toFixed(3)]) })
          }
        })
        if (contours.length) out.push({ name: beamName(c, bi), satName: (node && node.satName) || c.meta.sat || '', lon: c.meta.satLon, bore: c.meta.peak ? [c.meta.peak] : [], contours })
      }
    }
    return out
  }

  function clearAll() { selected.value = []; active.value = ''; const sc = getScene(), fl = getFlat(); if (sc) sc.setCoverageField([], {}); if (fl) fl.setField([], {}) }
  // 一键清除绘图：抹掉地图上的填充/线，但保留各天线设置（数据库）与聚焦项 → 再次勾选天线即按原设置重绘。
  function clearDrawing() { selected.value = []; const sc = getScene(), fl = getFlat(); if (sc) sc.setCoverageField([], {}); if (fl) fl.setField([], {}) }

  watch(() => [s.fill, s.line, s.lineWidth, s.ctype, s.pol, s.gainOffset, s.pathLoss], () => { persistActive(); recompute() }, { deep: true })
  // 电平改动只影响聚焦天线这一层（persistActive 仅写 active）→ 走单层快路径 recomputeActive，只 patch 当前可见视图。
  // 另一视图（2D/3D）在切换时由 applyFlat 的 recompute 一次性补齐（与拖拽波束同策略，避免每次编辑全量重算所有选中层）。
  watch(() => s.levels, () => { persistActive(); scheduleRecomputeActive() }, { deep: true })   // 合帧：挑色高频连发不再卡（persistActive 同步保证状态最新，重算合到下一帧）
  watch(() => s.beamsToPlot, () => { persistActive(); recompute() }, { deep: true })   // Beams To Plot 多选变更 → 回存 + 重绘
  watch(active, () => { beamQuery.value = '' })   // 切换聚焦天线：清空波束筛选词（波束数/含义随天线变）
  watch(() => s.alpha, (a) => { persistActive(); const sc = getScene(), fl = getFlat(); if (sc) sc.setCoverageFieldAlpha(a); if (fl) fl.setFieldAlpha(a) })
  // 切换 boresight 类型：把当前指向无缝换算到另一种表示，避免跳变（geo→azel 取该地表点的 az/el；azel→geo 取落地点）
  watch(() => s.boreType, (nt, ot) => {
    if (_muteSync || _dragging || nt === ot) return   // 拖拽自行管理指向，不在此换算
    const m = antMeta(); if (!m) return
    if (nt === 'azel') { const ae = dirToAzEl(m.satLon, m.satLat || 0, m.satAlt, s.boreLon == null ? m.satLon : s.boreLon, s.boreLat || 0); _muteSync = true; s.boreAz = +ae.az.toFixed(3); s.boreEl = +ae.el.toFixed(3); _muteSync = false }
    else { const g = azElGround(m.satLon, m.satLat || 0, m.satAlt, s.boreAz || 0, s.boreEl || 0); if (g) { _muteSync = true; s.boreLon = +g.lon.toFixed(4); s.boreLat = +g.lat.toFixed(4); _muteSync = false } }
  })
  // 指向变化（geo 的 lon/lat 或 azel 的 az/el，含 yaw/类型）：reproject 只重投影聚焦天线；拖拽中走单层+单视图快路径，否则全量。
  watch(() => [s.boreLon, s.boreLat, s.boreAz, s.boreEl, s.yaw, s.boreType], () => {
    reproject(); _dragging ? recomputeActive() : recompute()
  })
  // 全局显示选项（天线名/波束中心/数值标签开关与字号）：仅影响标注层，重绘即可（不回存到天线设置）
  watch(() => [s.showName, s.nameSize, s.showBore, s.boreSize, s.showPeak, s.peakSize, s.showVal, s.valSize], () => recompute())

  return {
    sats, expanded, selected, active, loading, s,
    keyOf, isSelected, isActive, isExpanded, antMeta, activeName, beamsCount, satState, dragBore, boreGround,
    activeBeams, isBeamOn, toggleBeam, setAllBeams, allBeamsOn, renameBeam,
    beamQuery, setBeamQuery, filteredBeams, filteredAllOn, filteredAnyOn, selectFiltered,
    loadIndex, setActive, toggleAnt, toggleSatAll, toggleExpand, addLevel, removeLevel, importGrd,
    addSatellite, updateSatellite, removeSatellite, removeAntenna, renameAntenna, setElev,
    setDragBore, beamDrag, getState, restoreState, recompute, clearAll, clearDrawing,
    setLivePos, tickLive, getPerfContext, ensureAntLoaded, exportContours
  }
}
