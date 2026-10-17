// 波束地图显示 —— 覆盖库（内置 + 文件管理导入的 GXT / KML / JSON / 脚本导入）的波束，按 GRD 同一种层格式上图。
//
// 模型（与旧「GXT/KML 显示」同一棵树，存档向下兼容）：
//   卫星（items[]：folder / 类型 EIRP|GT / 频段）→ 批次（batches[]：一组波束共用一套样式）→ 波束（beams[]：行 id = 频段|波束名）。
// 批次的样式对齐 GRD「天线设置」：
//   电平表   levels{ 档键 → { on, color 填充色, lineColor 线色, name 自定义名, dash, width, fillAlpha } }（稀疏：缺的键 = 默认显示、自动配色）
//   配色     scheme：auto 自动（有数值档 → jet；全是无数值的环（覆盖边界）→ 按波束）| jet / turbo / viridis / inferno / gray（按档值升序取色，同 GRD）
//            | solid 纯色 | beam 按波束（每束一色）
//   填充     fill / fillAlpha（Fill Contours 分带填充）；等值线 line / lineAlpha / width / lineStyle
// 全局显示选项 disp 对齐 GRD「显示选项」：标签粗体 / 卫星名 / 波束名 / 波束中心 / 中心电平 / 视轴 / 数值标签（单个 | 沿线间隔、值 + 名称）。
// 几何与画法见 layers.js；渲染走 3D scene.setBeamMapField 与 2D flat.setBeamMapField（独立通道，不与 GRD 抢槽位）。
import { ref, reactive, computed } from 'vue'
import { buildBeamLayers, beamRay, levelKey, levelVal, levelCmp, fmtLevel, NONE, rgbHex } from './layers.js'
import { schemeColorsRGB, rgbCss } from '../grd/colormap.js'

export const BM_SCHEMES = ['jet', 'turbo', 'viridis', 'inferno', 'gray']
const SOLID_COLORS = ['#ff5a5a', '#5ad1ff', '#ffd24a', '#7cff8a', '#c78bff', '#ff9a5a', '#66ddff', '#ff6fae']
// 按波束着色：黄金角转色相（相邻两束色相差 137.5°，几十上百束也不撞色），亮度饱和度取深 / 浅底图上都醒目的一档
export function beamColor(i) {
  const h = (i * 137.508) % 360, s = 0.72, l = 0.58, a = s * Math.min(l, 1 - l)
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
  return rgbHex([Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)])
}

// 发送到小程序（3D 页 buildMiniappSnapshot）：无数值档的环（g = null，覆盖边界之类）写成 g = 0 并标 none: true。
// g = 0 与 GXT 写出口径一致（serializeGxt 把 null 档写成 gain=0）；不认 none 的老版本小程序拿到的也是个数
//（原先直接送 null，等值线标注印成「null」）。认 none 的小程序不出电平标注、按「—」一档勾选，与真 0 dB 档分开。
export function miniContours(contours) {
  return (contours || []).map((c) => (c && c.g == null ? { ...c, g: 0, none: true } : c))
}

export const DISP_DEF = Object.freeze({
  fontBold: false, showSatName: true,
  showName: true, nameSize: 16, nameColor: '#ffffff',
  showBore: true, boreSize: 0.5, boreColor: '#ffffff',
  showPeak: false, peakSize: 5, peakColor: '#cfd6df',
  showRay: false, rayColor: '#ffb14a', rayWidth: 1.2, rayOpacity: 0.75,
  showVal: false, valSize: 12, valColor: '#ffffff', labelMode: 'single', labelGap: 35, labelWithName: false
})
const DISP_KEYS = Object.keys(DISP_DEF)
const BATCH_DEF = { scheme: 'auto', fill: false, fillAlpha: 0.78, line: true, lineAlpha: 1, width: 1.6, lineStyle: 'solid' }
const LINE_STYLES = new Set(['solid', 'dash', 'dot', 'dashdot'])
const parseNums = (s) => String(s || '').split(/[,，\s]+/).map((x) => parseFloat(x)).filter((x) => Number.isFinite(x))
const num = (v, d) => (Number.isFinite(+v) && v !== '' && v != null ? +v : d)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
// 提取波束名里的第一个整数作为波束号（CS26 "1 拉萨"→1、"Beam No.10"→10；无号→Infinity）
const beamNum = (s) => { const m = String(s).match(/\d+/); return m ? parseInt(m[0], 10) : Infinity }

/**
 * deps:
 *   getScene() / getFlat()      渲染器（可能为空）
 *   apiOk                       桌面 API 在不在（浏览器直跑时为 false）
 *   displaySatName(name)        卫星显示名（内置星按界面语言折算）
 *   focusLon(lon)               「定位」：把轨位转到视野里
 *   onError(msg, e)             报错落日志
 */
export function useBeamMapDisplay(deps = {}) {
  const sats = ref([])          // 合并后的索引：[{ folder, displayName, satName, lon, beams:[{ band, beam, type, gains, file, user, lon, props }] }]
  const items = ref([])         // 已添加卫星
  const disp = reactive({ ...DISP_DEF })
  const cleared = ref(false)    // 「清除绘制」后置位：保留设置但不上图，切视图 / 重开面板的被动重绘不复现（显式改动才解除）
  const status = ref('')
  const addSel = ref('')
  const cache = {}              // file → 归一化数据（{ lon, bore, contours }）
  const beamObjs = {}           // file → 图层构建用的稳定对象（layers.js 按对象身份缓存几何）
  let presetSats = []
  let loaded = false
  let seq = 0
  const newId = () => 'c' + (++seq)
  let solidCursor = 0
  const trash = {}              // folder → 移除时的设置，再加回来时恢复

  /* ---------------- 索引 ---------------- */
  async function ensureIndex() {
    if (loaded || !deps.apiOk) return
    loaded = true
    try {
      const idx = await window.api.coverage.index()
      presetSats = ((idx && idx.satellites) || []).map((s) => ({ ...s, displayName: deps.displaySatName ? deps.displaySatName(s.displayName) : s.displayName }))
    } catch (e) { status.value = '覆盖索引加载失败' }
    await mergeUser()
  }
  // 用户库（文件管理导入）并入：套用软隐藏（hidden）过滤内置星 / 波束；用户卫星【按名并入同名内置卫星】（同文件管理口径）
  async function mergeUser() {
    let ui = null
    try { if (window.api && window.api.coverageGxt) ui = await window.api.coverageGxt.index() } catch { /* 无库：仅用预置 */ }
    const hidden = (ui && ui.hidden) || {}
    const hiddenSats = new Set(hidden.sats || []), hiddenBeams = new Set(hidden.beams || [])
    const byName = new Map(), merged = []
    for (const s of presetSats) {
      if (hiddenSats.has(s.folder)) continue
      const node = { ...s, beams: (s.beams || []).filter((b) => !hiddenBeams.has(b.key)) }
      merged.push(node); byName.set(String(s.displayName || '').toLowerCase(), node)
    }
    for (const s of ((ui && ui.satellites) || [])) {
      const ubeams = (s.beams || []).filter((b) => b.file).map((b) => ({ band: b.band || '', beam: b.name, type: b.type || 'EIRP', gains: b.gains || [], file: b.file, user: true, lon: b.lon, props: b.props || null, src: b.sourceFormat || '' }))
      if (!ubeams.length) continue
      const key = String(s.name || '').toLowerCase()
      const host = byName.get(key)
      if (host) host.beams = [...host.beams, ...ubeams]
      else { const node = { folder: 'gxt:' + s.id, displayName: s.name, satName: s.name, lon: s.lon, beams: ubeams }; merged.push(node); byName.set(key, node) }
    }
    sats.value = merged
    // 文件可能被重导（同一路径换了内容）：作废已缓存的数据与几何
    for (const k of Object.keys(cache)) delete cache[k]
    for (const k of Object.keys(beamObjs)) delete beamObjs[k]
  }
  const reload = async () => { if (loaded) { await mergeUser(); if (items.value.length && !cleared.value) redraw() } }

  /* ---------------- 查询辅助 ---------------- */
  const idxOf = (folder) => sats.value.find((x) => x.folder === folder)
  function itemBands(it) { const s = idxOf(it.folder); if (!s) return []; return [...new Set(s.beams.filter((b) => b.type === it.type).map((b) => b.band))] }
  // 某卫星在其 type/band 过滤下的波束行（按波束号升序，无号者保持原序置后，并标 1-based 序号 seq）
  function buildRows(it) {
    const s = idxOf(it.folder); if (!s) return []
    const map = new Map()
    for (const b of s.beams) {
      if (b.type !== it.type) continue
      if (it.band !== 'all' && b.band !== it.band) continue
      const id = b.band + '|' + b.beam
      if (!map.has(id)) map.set(id, { id, band: b.band, beam: b.beam, label: b.band ? `${b.band}·${b.beam}` : String(b.beam), file: b.file, gains: b.gains || [], user: !!b.user, props: b.props || null, tip: propsTip(b.props) })
    }
    const rows = [...map.values()]
    rows.sort((a, b) => beamNum(a.beam) - beamNum(b.beam))
    rows.forEach((r, i) => { r.seq = i + 1 })
    return rows
  }
  const rowsMemo = computed(() => { const m = new Map(); for (const it of items.value) m.set(it.id + '|' + it.type + '|' + it.band, buildRows(it)); return m })
  const beamRowsOf = (it) => rowsMemo.value.get(it.id + '|' + it.type + '|' + it.band) || buildRows(it)
  // 波束附带的元信息（脚本导入时给的 props，如载波参数）→ 悬停文本
  function propsTip(p) {
    if (!p || typeof p !== 'object') return ''
    const lines = []
    for (const [k, v] of Object.entries(p)) {
      if (v == null || v === '') continue
      if (Array.isArray(v)) { for (const x of v.slice(0, 12)) lines.push(k + ': ' + (x && typeof x === 'object' ? Object.entries(x).map(([a, b]) => a + '=' + b).join(', ') : String(x))) }
      else if (typeof v === 'object') lines.push(k + ': ' + Object.entries(v).map(([a, b]) => a + '=' + b).join(', '))
      else lines.push(k + ': ' + v)
    }
    return lines.join('\n')
  }
  // 搜索词若是纯序号语法（如 "1-62"、"1,3,5"、"1-10,20-30"）则返回序号集合，否则 null
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
  function filteredRows(it, ba) {
    const q = (ba.q || '').trim()
    const rows = beamRowsOf(it)
    if (!q) return rows
    const seqSet = parseSeqSet(q)
    if (seqSet) return rows.filter((r) => seqSet.has(r.seq))
    const ql = q.toLowerCase()
    return rows.filter((r) => r.label.toLowerCase().includes(ql) || String(r.beam).toLowerCase().includes(ql) || (r.tip && r.tip.toLowerCase().includes(ql)))
  }
  const allFilteredOn = (it, ba) => { const rows = filteredRows(it, ba); return rows.length > 0 && rows.every((r) => ba.beams.includes(r.id)) }

  /* ---------------- 电平表 ---------------- */
  // 批次已选波束出现过的档（升序；无数值档垫底）
  function batchKeys(it, ba) {
    const sel = new Set(ba.beams), m = new Map()
    for (const r of beamRowsOf(it)) if (sel.has(r.id)) for (const g of r.gains) { const k = levelKey(g); if (!m.has(k)) m.set(k, levelVal(k)) }
    return [...m.entries()].sort((a, b) => levelCmp(a[1], b[1])).map((e) => e[0])
  }
  // 实际生效的方案：auto 看批次里有没有数值档 —— 有就按档值渐变（jet），全是无数值的环（覆盖边界，按档着色只剩一色）就按波束
  function effScheme(ba, keysAsc) {
    if (ba.scheme !== 'auto') return ba.scheme
    return keysAsc.some((k) => k !== NONE) ? 'jet' : 'beam'
  }
  const isBeamScheme = (it, ba) => effScheme(ba, batchKeys(it, ba)) === 'beam'
  // 自动配色：按档值升序在配色方案上均匀取色（同 GRD recolorList）；纯色 = 一色
  function autoColors(ba, keysAsc) {
    const out = new Map()
    const sc = effScheme(ba, keysAsc)
    if (sc === 'solid' || sc === 'beam') { for (const k of keysAsc) out.set(k, ba.solid); return out }
    const cols = schemeColorsRGB(BM_SCHEMES.includes(sc) ? sc : 'jet', keysAsc.length)
    keysAsc.forEach((k, i) => out.set(k, rgbHex(cols[i])))
    return out
  }
  /** 电平表的行（高 → 低，与图例阅读顺序一致）：{ key, v, text, on, color, lineColor, name, dash, width, fillAlpha, custom } */
  function levelRows(it, ba) {
    const keys = batchKeys(it, ba)
    const auto = autoColors(ba, keys)
    return keys.map((k) => {
      const L = (ba.levels && ba.levels[k]) || {}
      const color = L.color || auto.get(k)
      return {
        key: k, v: levelVal(k), text: k === NONE ? '—' : fmtLevel(levelVal(k)),
        on: L.on !== false, color, lineColor: L.lineColor || color, name: L.name || '',
        dash: L.dash || null, width: L.width == null ? null : +L.width, fillAlpha: L.fillAlpha == null ? null : +L.fillAlpha,
        custom: !!(L.color || L.lineColor)
      }
    }).reverse()
  }
  const lvEntry = (ba, k) => { if (!ba.levels) ba.levels = {}; return ba.levels[k] || (ba.levels[k] = {}) }
  function setLevel(ba, k, patch) {
    const e = lvEntry(ba, k)
    for (const [f, v] of Object.entries(patch)) { if (v == null || v === '') delete e[f]; else e[f] = v }
    if (!Object.keys(e).length) delete ba.levels[k]
    ba.levels = { ...ba.levels }
    redrawSoon()
  }
  function setLevelOn(ba, k, on) { setLevel(ba, k, { on: on ? null : false }) }
  function setAllLevels(it, ba, on) {
    const lv = { ...(ba.levels || {}) }
    for (const k of batchKeys(it, ba)) { const e = { ...(lv[k] || {}) }; if (on) delete e.on; else e.on = false; if (Object.keys(e).length) lv[k] = e; else delete lv[k] }
    ba.levels = lv
    redrawSoon()
  }
  // 填充色改了而线色没单独设过：线色跟着走（GRD 同口径：线色默认与填充同色，单独改过才分开 —— 见 levelRows 的 lineColor 回退）
  function setLevelColor(ba, k, css) { setLevel(ba, k, { color: css }) }
  function setLevelLine(ba, k, css) { setLevel(ba, k, { lineColor: css }) }
  // 自定义颜色全部清掉，回到配色方案
  function resetLevelColors(ba) {
    const lv = {}
    for (const [k, e] of Object.entries(ba.levels || {})) { const x = { ...e }; delete x.color; delete x.lineColor; if (Object.keys(x).length) lv[k] = x }
    ba.levels = lv
    if (ba.beamColors) ba.beamColors = {}
    redrawSoon()
  }
  const levelsOnCount = (it, ba) => levelRows(it, ba).filter((r) => r.on).length

  /* ---------------- 增删改 ---------------- */
  function newBatch() {
    return { id: newId(), name: '', q: '', beams: [], levels: {}, beamColors: {}, solid: SOLID_COLORS[solidCursor++ % SOLID_COLORS.length], ...BATCH_DEF }
  }
  function addSat(folder) {
    const f = folder || addSel.value
    addSel.value = ''
    if (!f || items.value.find((i) => i.folder === f)) return
    if (!idxOf(f)) return
    const saved = trash[f]; delete trash[f]
    items.value.push(saved ? { id: newId(), folder: f, type: saved.type, band: saved.band, batches: saved.batches } : { id: newId(), folder: f, type: 'EIRP', band: 'all', batches: [newBatch()] })
    redraw()
  }
  function removeSat(it) {
    trash[it.folder] = { type: it.type, band: it.band, batches: it.batches }
    const i = items.value.indexOf(it); if (i >= 0) items.value.splice(i, 1)
    redraw()
  }
  function setType(it, t) { if (it.type === t) return; it.type = t; it.band = 'all'; for (const ba of it.batches) ba.beams = []; redraw() }
  function setBand(it, band) {
    it.band = band
    const ids = new Set(buildRows(it).map((r) => r.id))
    for (const ba of it.batches) ba.beams = ba.beams.filter((id) => ids.has(id))
    redraw()
  }
  function addBatch(it) { it.batches.push(newBatch()); redraw() }
  function removeBatch(it, ba) { const i = it.batches.indexOf(ba); if (i >= 0) it.batches.splice(i, 1); redraw() }
  function toggleBeam(it, ba, id) { const i = ba.beams.indexOf(id); if (i >= 0) ba.beams.splice(i, 1); else ba.beams.push(id); redraw() }
  function allBeams(it, ba, on) {
    const rows = filteredRows(it, ba)
    if (on) { const s = new Set(ba.beams); for (const r of rows) s.add(r.id); ba.beams = [...s] }
    else { const rem = new Set(rows.map((r) => r.id)); ba.beams = ba.beams.filter((id) => !rem.has(id)) }
    redraw()
  }
  function invertBeams(it, ba) {
    const sel = new Set(ba.beams)
    for (const r of filteredRows(it, ba)) { if (sel.has(r.id)) sel.delete(r.id); else sel.add(r.id) }
    ba.beams = [...sel]
    redraw()
  }
  function setBatch(ba, patch) { Object.assign(ba, patch); redrawSoon() }
  function setBeamColor(ba, id, css) { ba.beamColors = { ...(ba.beamColors || {}), [id]: css }; redrawSoon() }
  // 按波束着色时某束的颜色：单独改过的优先，否则按它在本批次里的次序取（换了选择也不至于整批变色：次序按全部行算）
  function beamColorOf(it, ba, id) {
    const c = ba.beamColors && ba.beamColors[id]
    if (c) return c
    const rows = beamRowsOf(it)
    const i = rows.findIndex((r) => r.id === id)
    return beamColor(i < 0 ? 0 : i)
  }
  function setDisp(patch) { Object.assign(disp, patch); redrawSoon() }
  function focus(it) { const s = idxOf(it.folder); if (s && s.lon != null && deps.focusLon) deps.focusLon(s.lon) }

  /* ---------------- 数据 ---------------- */
  async function load(r) {
    if (!cache[r.file]) cache[r.file] = await (r.user ? window.api.coverageGxt.get(r.file) : window.api.coverage.get(r.file))
    return cache[r.file]
  }
  function beamObj(r, d, satLon) {
    let o = beamObjs[r.file]
    if (!o || o.contours !== d.contours) o = beamObjs[r.file] = { contours: d.contours || [], bore: d.bore || [], satLon: Number.isFinite(satLon) ? satLon : (Number.isFinite(d.lon) ? d.lon : null), name: '' }
    o.name = r.beam
    return o
  }
  // 一个批次的渲染样式（按束套用；按波束着色时每束替换颜色）
  function batchStyle(it, ba) {
    const rows = levelRows(it, ba).filter((r) => r.on)
    return {
      byBeam: isBeamScheme(it, ba),
      levels: rows, fill: !!ba.fill, fillAlpha: clamp(num(ba.fillAlpha, 0.78), 0, 1), line: ba.line !== false,
      lineAlpha: clamp(num(ba.lineAlpha, 1), 0, 1), lineWidth: clamp(num(ba.width, 1.6), 0.1, 8), lineStyle: LINE_STYLES.has(ba.lineStyle) ? ba.lineStyle : 'solid'
    }
  }
  const styleForBeam = (st, it, ba, id) => (st.byBeam ? { ...st, levels: st.levels.map((L) => { const c = beamColorOf(it, ba, id); return { ...L, color: c, lineColor: c } }) } : st)

  /* ---------------- 上图 ---------------- */
  // 滑杆 / 取色框的 input 高频连发：一帧最多重建一次（几何按可见档缓存，这里重建的是线段 / 标签 / 渲染器那一侧）
  let _raf = 0
  function redrawSoon() {
    if (_raf) return
    const go = () => { _raf = 0; redraw() }
    _raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(go) : setTimeout(go, 16)
  }
  let redrawSeq = 0
  let last = { layers: [], opts: {}, sats: [] }
  const chanOpts = (rays) => ({
    alpha: 0.78, fontBold: disp.fontBold,
    showName: disp.showName, nameSize: disp.nameSize, nameColor: disp.nameColor,
    showBore: disp.showBore, boreSize: disp.boreSize, boreColor: disp.boreColor,
    showPeak: disp.showPeak, peakSize: disp.peakSize, peakColor: disp.peakColor,
    showVal: disp.showVal, valSize: disp.valSize, valColor: disp.valColor, rays
  })
  function push() {
    const sc = deps.getScene && deps.getScene(), fl = deps.getFlat && deps.getFlat()
    if (sc) { sc.setBeamMapField(last.layers, last.opts); sc.setCoverage(last.sats.length ? { sats: last.sats } : null) }
    if (fl) fl.setBeamMapField(last.layers, last.opts)
  }
  async function redraw() {
    if (!deps.getScene || !deps.getScene()) return
    cleared.value = false
    const my = ++redrawSeq
    const layers = [], rays = [], satLabels = []
    let loading = false
    const lab = { show: !!disp.showVal, mode: disp.labelMode === 'interval' ? 'interval' : 'single', gap: clamp(num(disp.labelGap, 35), 2, 200), size: num(disp.valSize, 12), withName: !!disp.labelWithName }
    const rayStyle = { color: disp.rayColor, width: disp.rayWidth, opacity: disp.rayOpacity }
    for (const it of items.value) {
      const idx = idxOf(it.folder); if (!idx) continue
      if (disp.showSatName && idx.lon != null) satLabels.push({ lon: idx.lon, name: idx.displayName, bold: !!disp.fontBold })
      const rowById = new Map(beamRowsOf(it).map((r) => [r.id, r]))
      for (const ba of it.batches) {
        if (!ba.beams.length) continue
        const st = batchStyle(it, ba)
        for (const id of ba.beams) {
          const r = rowById.get(id); if (!r) continue
          let d
          try {
            if (!cache[r.file]) { loading = true; status.value = '加载覆盖…' }
            d = await load(r)
          } catch (e) { if (deps.onError) deps.onError('波束数据读取失败：' + r.label, e); continue }
          if (my !== redrawSeq) return
          const beam = beamObj(r, d, idx.lon)
          for (const L of buildBeamLayers(beam, styleForBeam(st, it, ba, id), lab, `bm:${it.id}:${ba.id}:${id}`)) layers.push(L)
          if (disp.showRay && st.levels.length) for (const b of (beam.bore || []).slice(0, 1)) { const ry = beamRay(idx.lon != null ? idx.lon : beam.satLon, b, rayStyle); if (ry) rays.push(ry) }
        }
      }
    }
    if (my !== redrawSeq) return
    last = { layers, opts: chanOpts(rays), sats: satLabels }
    push()
    if (loading) status.value = ''
  }
  function clearDrawing() {
    cleared.value = true
    last = { layers: [], opts: chanOpts([]), sats: [] }
    const sc = deps.getScene && deps.getScene(), fl = deps.getFlat && deps.getFlat()
    if (sc) { sc.clearBeamMapField(); sc.setCoverage(null) }
    if (fl) fl.clearBeamMapField()
    status.value = ''
  }
  // 平面图懒创建：建好后把最近一次的图层补喂一份（不重算）
  function feedFlat(fl) { if (fl && fl.setBeamMapField) fl.setBeamMapField(last.layers, last.opts) }
  // 被动重绘入口（切视图 / 重开面板 / 导出前）：清除过就不复现
  async function refresh() { await ensureIndex(); if (!cleared.value && items.value.length) await redraw() }

  /* ---------------- 采集（导出 / 小程序 / 可编程导出共用） ---------------- */
  // 当前绘制的覆盖库波束：只收显示中的档；每条等值线带屏上那一档的线色。数据未载入的束跳过（与旧口径同）。
  // opts.mini：发小程序的形态 —— 无数值档写成 g = 0 + none（见 miniContours）；导出 / 可编程导出仍是 g = null。
  function collect(opts = {}) {
    const out = []
    if (cleared.value) return out
    for (const it of items.value) {
      const idx = idxOf(it.folder); if (!idx) continue
      const rowById = new Map(beamRowsOf(it).map((r) => [r.id, r]))
      for (const ba of it.batches) {
        const st = batchStyle(it, ba)
        for (const id of ba.beams) {
          const r = rowById.get(id); if (!r) continue
          const d = cache[r.file]; if (!d) continue
          const s2 = styleForBeam(st, it, ba, id)
          const byKey = new Map(s2.levels.map((L) => [L.key, L]))
          const contours = []
          for (const c of (d.contours || [])) { const L = byKey.get(levelKey(c.g)); if (L) contours.push({ g: c.g == null ? null : c.g, p: c.p, color: rgbHex(L.lineColor || L.color) }) }
          if (!contours.length) continue
          out.push({ satName: idx.displayName, lon: idx.lon, band: r.band || '', beam: r.beam || '', type: it.type || 'EIRP', bore: d.bore || [], contours: opts.mini ? miniContours(contours) : contours })
        }
      }
    }
    return out
  }

  /* ---------------- 存档 ---------------- */
  function serialize() {
    return {
      v: 2,
      items: items.value.map((it) => ({
        id: it.id, folder: it.folder, type: it.type, band: it.band,
        batches: it.batches.map((ba) => ({
          id: ba.id, name: ba.name, beams: ba.beams.slice(), levels: JSON.parse(JSON.stringify(ba.levels || {})), beamColors: { ...(ba.beamColors || {}) },
          scheme: ba.scheme, solid: ba.solid, fill: !!ba.fill, fillAlpha: ba.fillAlpha, line: ba.line !== false, lineAlpha: ba.lineAlpha, width: ba.width, lineStyle: ba.lineStyle
        }))
      })),
      cleared: cleared.value,
      disp: { ...disp }
    }
  }
  // 旧版批次（每波束一条记录，gains / custom / mode / solid / gainColors / width）→ 新版电平表：
  // 选中档 = gains ∪ 自定义；逐档色（perGain）落成该档的自定义色；纯色 → solid；渐变 → jet。旧版没有填充，迁过来也不开。
  function migrateBatch(ba, rows) {
    const bms = ba.beams || [], f = bms[0] || {}
    const beams = bms.map((b) => (typeof b === 'string' ? b : b.id))
    const on = new Set([...(Array.isArray(f.gains) ? f.gains : []), ...parseNums(f.custom)].map(levelKey))
    const levels = {}
    const sel = new Set(beams)
    for (const r of rows) if (sel.has(r.id)) for (const g of r.gains) { const k = levelKey(g); if (!on.has(k)) levels[k] = { on: false } }
    if (f.mode === 'perGain') for (const [g, c] of Object.entries(f.gainColors || {})) { const k = levelKey(Number(g)); levels[k] = { ...(levels[k] || {}), color: c } }
    return {
      ...newBatch(), id: ba.id, name: ba.name || '', beams, levels,
      scheme: f.mode === 'solid' ? 'solid' : 'jet', solid: f.solid || '#ff5a5a', width: Number.isFinite(f.width) ? f.width : 1.6, fill: false
    }
  }
  function normBatch(ba) {
    return {
      id: ba.id || newId(), name: ba.name || '', q: '', beams: Array.isArray(ba.beams) ? ba.beams.filter((x) => typeof x === 'string') : [],
      levels: (ba.levels && typeof ba.levels === 'object') ? ba.levels : {}, beamColors: (ba.beamColors && typeof ba.beamColors === 'object') ? ba.beamColors : {},
      scheme: (BM_SCHEMES.includes(ba.scheme) || ba.scheme === 'solid' || ba.scheme === 'beam' || ba.scheme === 'auto') ? ba.scheme : 'auto',
      solid: ba.solid || '#ff5a5a', fill: !!ba.fill, fillAlpha: clamp(num(ba.fillAlpha, 0.78), 0, 1), line: ba.line !== false,
      lineAlpha: clamp(num(ba.lineAlpha, 1), 0, 1), width: clamp(num(ba.width, 1.6), 0.1, 8), lineStyle: LINE_STYLES.has(ba.lineStyle) ? ba.lineStyle : 'solid'
    }
  }
  /**
   * 恢复存档（新版 v2，或旧版「GXT/KML 显示」的 cov 段：items + beamLabels / beamFont / bore / contourLabels …）。
   * 只恢复索引里仍存在的卫星；返回是否需要重绘。
   */
  async function restore(c) {
    if (!c) return false
    const list = Array.isArray(c.items) ? c.items : []
    if (list.length) await ensureIndex()   // 没存卫星就不必在启动时拉覆盖索引（显示选项照样恢复）
    const out = []
    for (const it of list) {
      if (!it || !idxOf(it.folder)) continue
      const base = { id: it.id || newId(), folder: it.folder, type: it.type || 'EIRP', band: it.band || 'all', batches: [] }
      const rows = buildRows(base)
      base.batches = (it.batches || []).map((ba) => (c.v === 2 ? normBatch(ba) : migrateBatch(ba, rows)))
      out.push(base)
    }
    for (const it of out) {
      for (const x of [it.id, ...it.batches.map((b) => b.id)]) { const n = parseInt(String(x).replace(/\D/g, ''), 10); if (Number.isFinite(n) && n > seq) seq = n }
    }
    items.value = out
    if (c.v === 2 && c.disp) { for (const k of DISP_KEYS) if (c.disp[k] !== undefined) disp[k] = c.disp[k] }
    else if (c.v !== 2) {
      // 旧版全局项：波束名 / 字号 / 粗体、波束中心 / 大小（1–12 → 十字 0.1–1.2）、数值标签 / 字号 / 粗体；旧版波束中心开着时画过卫星连线 → 视轴照开
      disp.showName = c.beamLabels !== false
      if (Number.isFinite(c.beamFont)) disp.nameSize = c.beamFont
      disp.showBore = c.bore !== false
      if (Number.isFinite(c.boreSize)) disp.boreSize = clamp(c.boreSize / 10, 0.1, 3)
      disp.showVal = !!c.contourLabels
      if (Number.isFinite(c.contourSize)) disp.valSize = c.contourSize
      disp.fontBold = c.beamBold === true || c.contourBold === true
      if (out.length && disp.showBore) { disp.showRay = true; disp.rayWidth = 1; disp.rayOpacity = 0.3 }
    }
    cleared.value = !!c.cleared
    return out.length > 0 && !cleared.value
  }

  return {
    sats, items, disp, cleared, status, addSel,
    ensureIndex, mergeUser, reload, idxOf, itemBands, beamRowsOf, filteredRows, allFilteredOn,
    levelRows, levelsOnCount, isBeamScheme, setLevel, setLevelOn, setAllLevels, setLevelColor, setLevelLine, resetLevelColors,
    addSat, removeSat, setType, setBand, addBatch, removeBatch, toggleBeam, allBeams, invertBeams, setBatch, setBeamColor, beamColorOf, setDisp, focus,
    redraw, refresh, clearDrawing, feedFlat, collect, serialize, restore,
    loaded: () => loaded
  }
}
