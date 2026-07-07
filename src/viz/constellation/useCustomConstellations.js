// 自定义星座（仿 STK Walker 生成器）状态层：管理星座列表、按参数生成合成 satrec、本地持久化。
// 只负责“产出可渲染的 entries”，渲染/点选/选中几何全部复用星座3D 页现成的点云管线
//   （entries → scene.setSatellites → renderEntries[index] 命中 → selectSat 画轨道/星下点/足迹）。
// 每颗星是一组经典平根数，经 elementsToSatrec（复用 omm2satrec）转真实 SGP4 satrec；
// 整座星座共享同一历元 SIM_EPOCH → 相对相位/相对 RAAN 精确保持（与页面轨道根数模拟星同理）。
import { ref } from 'vue'
import sat from './satellite.js'
import { generateConstellation } from './walker.js'

const RE = 6378.137
const MU = 398600.4418
const STORE_KEY = 'constellation3d/customConsts'
// 共享历元锚点：本会话固定一个，整座星座刚性同步旋转（绝对值无所谓，见页面 SIM_EPOCH 说明）
const SIM_EPOCH = new Date().toISOString()
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

// 经典轨道根数 → satrec（复用 omm2satrec；历元取共享锚点）。altKm=近地点高度，e=0 即圆轨道高度。
function elementsToSatrec(el) {
  const ecc = Math.max(0, Math.min(0.999, Number(el.ecc) || 0))
  const a = (RE + (Number(el.altKm) || 0)) / (1 - ecc)          // a=(RE+hp)/(1−e)
  const n = Math.sqrt(MU / (a * a * a))                          // 平均运动 rad/s
  const meanMotion = 86400 * n / (2 * Math.PI)                   // rev/day（omm2satrec 所需）
  return sat.omm2satrec({
    noradId: 'SIM', epoch: SIM_EPOCH, meanMotion, ecc,
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
      try { rec = elementsToSatrec(s.elements) } catch { rec = null }
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

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        top: _top,
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

  return { list, add, update, remove, toggle, showOnly, setPreview, count, entriesForRender, load, PLANE_PALETTE }
}
