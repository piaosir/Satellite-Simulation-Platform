// 自定义星座（仿 STK Walker 生成器）状态层：管理星座列表、按参数生成合成 satrec、本地持久化。
// 只负责“产出可渲染的 entries”，渲染/点选/选中几何全部复用星座3D 页现成的点云管线
//   （entries → scene.setSatellites → renderEntries[index] 命中 → selectSat 画轨道/星下点/足迹）。
// 每颗星是一组经典平根数，经 elementsToSatrec（复用 omm2satrec）转真实 SGP4 satrec；
// 整座星座共享同一场景历元 scenarioEpoch（可设/持久化）→ 相对相位/相对 RAAN 精确保持；历元默认锚在当天 08:00（每天更新）。
import { ref } from 'vue'
import sat from './satellite.js'
import { generateConstellation } from './walker.js'

const RE = 6378.137
const MU = 398600.4418
const STORE_KEY = 'constellation3d/customConsts'
// 场景历元（STK Scenario Epoch 口径）：全部自定义星座共用的参考历元。默认=电脑「当天 08:00」，每天自动更新；
// 若当天曾人为修改，则当天以人为值为准（次日再回到该日 08:00）。取当天固定值（而非每次渲染都 new Date()）→
// 星座在地球上的定向本会话内稳定，不随“打开软件的时刻”秒级漂移；跨天则统一锚在当天 08:00，便于按日复现。
// RAAN 仍是真惯性升交点赤经（相对春分点/TEME），与真实 TLE/星历同一参考、可直接对应；
// 渲染时在此历元上叠加时间轴偏移即可向后推演预测（见页面 ccTimeAt）。
// 本地日期串 YYYY-MM-DD（判定「人为修改是否发生在今天」）
const localDayStr = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
// 电脑「当天 08:00」的 ISO（本地时区）
const today8am = () => { const d = new Date(); d.setHours(8, 0, 0, 0); return d.toISOString() }
const defaultEpoch = () => today8am()
// 从持久化 blob 解析「本次应生效」的场景历元（每天更新规则）：默认=当天 08:00；
// 若 blob.manualDay===今天 → 用 blob.epoch（当天的人为值）。纯函数，供 3D 页与 NGSO 窗口同规则读取 → 跨窗口一致。
export function resolveScenarioEpoch(blob) {
  if (blob && blob.manualDay === localDayStr(new Date()) && blob.epoch && !isNaN(Date.parse(blob.epoch))) return new Date(blob.epoch).toISOString()
  return today8am()
}
// 合成 NORAD 号段：从 900000 起，每座星座占一段（明显区别于真实目录星，避免撞号）
const NORAD_BASE = 900000
const NORAD_STEP = 10000
// 按轨道面配色调色板（10 色循环）
const PLANE_PALETTE = ['#ff6b6b', '#ffd166', '#06d6a0', '#4dabf7', '#b197fc', '#ff9f1c', '#38d9a9', '#f783ac', '#74c0fc', '#e599f7']

const hexToRgb = (hex) => {
  const h = String(hex || '#4dabf7').replace('#', '')
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(s, 16) || 0
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// 经典轨道根数 → satrec（复用 omm2satrec；历元取共享场景历元 epoch）。altKm=近地点高度，e=0 即圆轨道高度。
function elementsToSatrec(el, epoch) {
  const ecc = Math.max(0, Math.min(0.999, Number(el.ecc) || 0))
  const a = (RE + (Number(el.altKm) || 0)) / (1 - ecc)          // a=(RE+hp)/(1−e)
  const n = Math.sqrt(MU / (a * a * a))                          // 平均运动 rad/s
  const meanMotion = 86400 * n / (2 * Math.PI)                   // rev/day（omm2satrec 所需）
  return sat.omm2satrec({
    noradId: 'SIM', epoch: epoch || defaultEpoch(), meanMotion, ecc,
    incl: Number(el.incl) || 0, raan: Number(el.raan) || 0,
    argp: Number(el.argp) || 0, ma: Number(el.ma) || 0, bstar: 0, mdot: 0, mddot: 0
  })
}

let _seq = 0
const genId = () => 'cc' + Date.now().toString(36) + (_seq++).toString(36)

// 规范化一条星座配置，补齐缺省字段
function normalize(c) {
  return {
    id: c.id || genId(),
    name: (c.name || '自定义星座').trim() || '自定义星座',
    params: { ...c.params },
    color: c.color || '#4dabf7',
    colorByPlane: c.colorByPlane !== false,
    visible: c.visible !== false,
    noradBase: Number.isFinite(c.noradBase) ? c.noradBase : NORAD_BASE
  }
}

// onChange：任何增删改/显隐后回调页面重建渲染集（rebuildRenderSet）
export function useCustomConstellations(onChange) {
  const list = ref([])              // [{ id, name, params, color, colorByPlane, visible, noradBase }]
  const scenarioEpoch = ref(defaultEpoch())   // 场景历元（全自定义星座共用，持久化）；默认=电脑当天 08:00，可在面板设定
  const built = new Map()           // id → { sig, entries }
  let _top = NORAD_BASE             // 下一座星座的 NORAD 号段基址
  let manualDay = null              // 最近一次人为设定发生的本地日 YYYY-MM-DD；等于今天 → 当天以人为值为准，不被「当天 08:00」覆盖
  const preview = ref(null)         // 实时预览 { editId, cfg }（不持久化）：编辑器打开时随参数刷新
  const PREVIEW_BASE = NORAD_BASE + 90 * NORAD_STEP   // 预览专用 NORAD 号段，避开已建星座

  const sigOf = (cfg) => JSON.stringify({ p: cfg.params, cb: cfg.colorByPlane, c: cfg.color })
  const notify = () => { if (typeof onChange === 'function') onChange() }

  // 生成该星座的渲染 entries（签名不变则复用缓存）。entry 形如 {rec,name,noradId,group,groupLabel,color,plane}
  function build(cfg) {
    const sig = sigOf(cfg)
    const hit = built.get(cfg.id)
    if (hit && hit.sig === sig) return hit.entries
    const sats = generateConstellation(cfg.params)
    const cRgb = hexToRgb(cfg.color)
    const base = Number.isFinite(cfg.noradBase) ? cfg.noradBase : NORAD_BASE
    const entries = []
    for (let i = 0; i < sats.length; i++) {
      const s = sats[i]
      let rec
      try { rec = elementsToSatrec(s.elements, scenarioEpoch.value) } catch { rec = null }
      if (!rec || rec.error) continue
      const rgb = cfg.colorByPlane ? hexToRgb(PLANE_PALETTE[s.plane % PLANE_PALETTE.length]) : cRgb
      entries.push({ rec, name: s.name, noradId: String(base + i), group: 'cc_' + cfg.id, groupLabel: cfg.name, color: rgb, plane: s.plane })
    }
    built.set(cfg.id, { sig, entries })
    return entries
  }

  // 全部可见星座的渲染 entries（供页面拼进 renderEntries）；编辑器打开时含实时预览
  function entriesForRender() {
    const out = []
    const pv = preview.value
    for (const cfg of list.value) {
      if (cfg.visible === false) continue
      if (pv && pv.editId === cfg.id) continue   // 编辑中：用实时预览替代已提交版本，避免重叠
      for (const e of build(cfg)) out.push(e)
    }
    if (pv) for (const e of build(pv.cfg)) out.push(e)   // 预览星（编辑器打开时随参数刷新）
    return out
  }

  // 某座星座的卫星数（向导/列表显示用）
  function count(cfg) { return build(cfg).length }

  // 全部星座（含隐藏）的合成星，供「搜索 / 关联解算」用——与显隐无关、不含实时预览星。
  // 复用 build 的签名缓存：命中即拼接现成 entries，不重新生成。
  function catalog() {
    const out = []
    for (const cfg of list.value) for (const e of build(cfg)) out.push(e)
    return out
  }
  // 按 NORAD 号在全部星座（含隐藏）里找合成星；供关联卫星按号实时解算位置（关联不因显隐中断）。
  function findByNorad(noradId) {
    const id = String(noradId)
    for (const cfg of list.value) for (const e of build(cfg)) if (String(e.noradId) === id) return e
    return null
  }

  // 设定共享场景历元（面板手动改 / 点「当前」时调用）：作废全部合成 satrec → 重建 → 持久化 → 通知页面重渲染
  function setScenarioEpoch(iso) {
    const v = iso && !isNaN(Date.parse(iso)) ? new Date(iso).toISOString() : defaultEpoch()
    manualDay = localDayStr(new Date())   // 标记「今天人为设定过」→ 当天以此为准，不被「当天 08:00」默认覆盖
    if (v !== scenarioEpoch.value) {
      scenarioEpoch.value = v
      built.clear()   // 历元变 → 全部合成 satrec 作废，下次 build 按新历元重建（sig 不含历元，故须显式清）
      notify()
    }
    persist()   // 值变或不变都落盘（至少记下今天的 manualDay）
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        top: _top,
        epoch: scenarioEpoch.value,
        manualDay,   // 人为设定日（YYYY-MM-DD）：resolveScenarioEpoch 据此判定「当天以人为值为准」
        items: list.value.map((c) => ({ id: c.id, name: c.name, params: c.params, color: c.color, colorByPlane: c.colorByPlane, visible: c.visible, noradBase: c.noradBase }))
      }))
    } catch { /* 存储失败不影响功能 */ }
  }

  // 从本地恢复（只存参数，此处按参数重建 satrec）。不触发 onChange —— 由页面 loadGroup→rebuildRenderSet 统一渲染。
  function load() {
    try {
      const blob = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
      if (blob && Array.isArray(blob.items)) {
        list.value = blob.items.map(normalize)
        _top = Number.isFinite(blob.top) ? blob.top : (NORAD_BASE + list.value.length * NORAD_STEP)
        // 场景历元「每天更新」：默认=电脑当天 08:00；当天曾人为修改(manualDay===今天)则沿用持久化人为值。
        // 非人为日（含旧数据/跨天）→ 回写当天 08:00 历元并清掉过期 manualDay，使 3D 页与 NGSO 窗口按日一致。
        manualDay = (blob.manualDay === localDayStr(new Date())) ? blob.manualDay : null
        scenarioEpoch.value = resolveScenarioEpoch(blob)
        if (!manualDay) persist()
      }
    } catch { /* 读失败按空处理 */ }
  }

  // 新增一座星座
  function add(draft) {
    const cfg = normalize({ ...draft, id: genId(), noradBase: _top, visible: true })
    _top += NORAD_STEP
    list.value = [...list.value, cfg]
    build(cfg); persist(); notify()
    return cfg
  }
  // 更新一座星座（参数变则重建 satrec，历元仍取共享锚点，相位不跳变）
  function update(id, draft) {
    const i = list.value.findIndex((c) => c.id === id)
    if (i < 0) return
    const cfg = normalize({ ...list.value[i], ...draft, id, noradBase: list.value[i].noradBase })
    const arr = list.value.slice(); arr[i] = cfg; list.value = arr
    built.delete(id); build(cfg); persist(); notify()
  }
  function remove(id) {
    list.value = list.value.filter((c) => c.id !== id)
    built.delete(id); persist(); notify()
  }
  function toggle(id) {
    const c = list.value.find((x) => x.id === id)
    if (!c) return
    c.visible = c.visible === false
    list.value = [...list.value]
    persist(); notify()
  }
  // 仅显示指定星座（其余隐藏）——供「点击行单独显示」用
  function showOnly(id) {
    for (const c of list.value) c.visible = (c.id === id)
    list.value = [...list.value]
    persist(); notify()
  }
  // 实时预览（编辑器打开时随参数刷新，不持久化）。draft=null 撤销预览。页面负责随后 rebuild。
  function setPreview(draft) {
    if (!draft) { preview.value = null; built.delete('__preview__'); return }
    preview.value = { editId: draft.id || null, cfg: normalize({ ...draft, id: '__preview__', noradBase: PREVIEW_BASE }) }
  }

  return { list, scenarioEpoch, setScenarioEpoch, add, update, remove, toggle, showOnly, setPreview, count, entriesForRender, catalog, findByNorad, load, PLANE_PALETTE }
}

/* ===================== 只读读取（供「文件管理 · 星历」镜像展示 / 导出，无需实例化 composable） ===================== */
// 读本地自定义星座库 → 每座概览 [{ id, name, incl, count, color }]（count=按参数生成的卫星数）。
export function readCustomConstellationSummary() {
  try {
    const blob = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    if (!blob || !Array.isArray(blob.items)) return []
    return blob.items.map((c) => {
      let count = 0
      try { count = generateConstellation(c.params || {}).length } catch { count = 0 }
      return { id: c.id, name: (c.name || '自定义星座').trim() || '自定义星座', incl: Number(c.params && c.params.incl) || 0, count, color: c.color || '#4dabf7' }
    })
  } catch { return [] }
}

// 改名（回退用：3D 页未挂载、拿不到活实例时，直接改 localStorage；下次进图 load() 读到新名）。
// 3D 页已挂载时应优先走活实例 customConst.update(id,{name})（会失效 build 缓存 + 重渲染），见 fileBridge.customConst。
export function renameCustomConstellation(id, name) {
  try {
    const blob = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    if (!blob || !Array.isArray(blob.items)) return false
    const it = blob.items.find((c) => c.id === id)
    if (!it) return false
    it.name = (name || '自定义星座').trim() || '自定义星座'
    localStorage.setItem(STORE_KEY, JSON.stringify(blob))
    return true
  } catch { return false }
}

// 自定义星座 → 展开为 OMM 记录（历元 = 场景历元，与渲染/搜索同口径）供「导出星历」。
// onlyId 给定时只导该座；否则全部。经典六根数 → OMM：meanMotion 由 a=(RE+近地点高度)/(1−e) 反算，
// 与 elementsToSatrec / satSearchPool.fromCustom 一致。
export function customConstellationsToOmmRecords(onlyId) {
  try {
    const blob = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    if (!blob || !Array.isArray(blob.items)) return []
    const epoch = resolveScenarioEpoch(blob)
    const out = []
    let base = NORAD_BASE
    for (const c of blob.items) {
      const b = Number.isFinite(c.noradBase) ? c.noradBase : base
      if (onlyId && c.id !== onlyId) { base += NORAD_STEP; continue }
      let gen = []
      try { gen = generateConstellation(c.params || {}) } catch { gen = [] }
      for (let i = 0; i < gen.length; i++) {
        const el = gen[i].elements || {}
        const ecc = Math.max(0, Math.min(0.999, Number(el.ecc) || 0))
        const a = (RE + (Number(el.altKm) || 0)) / (1 - ecc)
        const meanMotion = 86400 * Math.sqrt(MU / (a * a * a)) / (2 * Math.PI)
        out.push({
          name: gen[i].name, noradId: String(b + i), objectId: '', epoch,
          meanMotion: meanMotion.toFixed(8), ecc: String(ecc), incl: String(Number(el.incl) || 0),
          raan: String(Number(el.raan) || 0), argp: String(Number(el.argp) || 0), ma: String(Number(el.ma) || 0),
          bstar: '0', mdot: '0', mddot: '0'
        })
      }
      base += NORAD_STEP
    }
    return out
  } catch { return [] }
}
