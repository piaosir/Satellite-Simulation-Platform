// 自定义星座（仿 STK Walker 生成器）状态层：管理星座列表、按参数生成合成 satrec、本地持久化。
// 只负责“产出可渲染的 entries”，渲染/点选/选中几何全部复用星座3D 页现成的点云管线
//   （entries → scene.setSatellites → renderEntries[index] 命中 → selectSat 画轨道/星下点/足迹）。
// 每颗星是一组经典平根数，经 elementsToSatrec（复用 omm2satrec）转真实 SGP4 satrec；
// 整座星座共享同一场景历元 scenarioEpoch（可设/持久化）→ 相对相位/相对 RAAN 精确保持、定向跨会话稳定。
import { ref } from 'vue'
import sat from './satellite.js'
import { generateConstellation } from './walker.js'

const RE = 6378.137
const MU = 398600.4418
const STORE_KEY = 'constellation3d/customConsts'
// 场景历元（STK Scenario Epoch 口径）：全部自定义星座共用的固定参考历元。默认取“当前时刻”并持久化，可在面板设定。
// 取固定值（而非每次渲染都 new Date()）→ 星座在地球上的定向跨会话稳定，不随“打开软件的时刻”漂移
// （旧实现每次 new Date()：同一 Ω₀ 每次开软件按 Ω₀−GMST(当次开机时刻) 落地，落在不同经度，看着像“赤经不对”）。
// RAAN 仍是真惯性升交点赤经（相对春分点/TEME），与真实 TLE/星历同一参考、可直接对应；
// 渲染时在此历元上叠加时间轴偏移即可向后推演预测（见页面 ccTimeAt）。默认取“当前时刻”→ 贴近真实星历便于同历元比对。
const defaultEpoch = () => new Date().toISOString()
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
  const scenarioEpoch = ref(defaultEpoch())   // 场景历元（全自定义星座共用，持久化）；首次=当前时刻，可在面板设定
  const built = new Map()           // id → { sig, entries }
  let _top = NORAD_BASE             // 下一座星座的 NORAD 号段基址
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

  // 设定共享场景历元：作废全部合成 satrec（历元变→根数历元变）→ 重建 → 持久化 → 通知页面重渲染
  function setScenarioEpoch(iso) {
    const v = iso && !isNaN(Date.parse(iso)) ? new Date(iso).toISOString() : defaultEpoch()
    if (v === scenarioEpoch.value) return
    scenarioEpoch.value = v
    built.clear()   // 历元变 → 全部合成 satrec 作废，下次 build 按新历元重建（sig 不含历元，故须显式清）
    persist(); notify()
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        top: _top,
        epoch: scenarioEpoch.value,
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
        // 场景历元：有则用持久化值；旧数据无此字段 → 冻结“当前时刻”为历元并回写（一次性迁移，此后稳定）
        if (blob.epoch && !isNaN(Date.parse(blob.epoch))) scenarioEpoch.value = new Date(blob.epoch).toISOString()
        else { scenarioEpoch.value = defaultEpoch(); persist() }
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
