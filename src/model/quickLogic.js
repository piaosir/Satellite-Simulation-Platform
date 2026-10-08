// 设计页「快速设置」的纯逻辑（2026-10 统一设计）：卫星驱动装配件的驱动参数（paramBus 整星 spec）在快速设置面板上的读写、
// 读数与出处。无 vue / three / DOM —— node 单测直接 import（packages/core/test/modelQuick.test.mjs）。
//
// 口径：
//   · 快速设置只摆「先定这几项、整星就出来了」的驱动量：平台尺寸 / 整星质量 / 热控多层、太阳翼构型 / 基板数与尺寸 / 连接架 / 转角、
//     反射面天线（位置 / 口径 / 焦距 / 网状）、平台细节开关；其余驱动量收进「更多参数」，组件级细节在右栏属性面板。
//   · 改动一律返回新 spec（不改入参），调用方交给会话 driveSet（三方合并 → 编辑器整文档替换）。
//   · 两翼「转角」按整星 SADA 转角定义：两翼电池面同向对日（+Y 翼 = θ、−Y 翼 = −θ，见 paramBus 两翼各绕自身外伸轴的定义），
//     不再让用户自己去配一正一负（同填 30° 会张成 V 形）。
//   · 反射面几何读数（偏置抛物面，母抛物面 y² = 4fz，焦点看轴外 y 处的张角 θ：tan(θ/2) = y / 2f）：
//     下缘 y_L = d_c − D/2（净空），上缘 y_U = d_c + D/2；θ0 = (θ_U + θ_L)/2 为馈源倾角（指向平分角），θ* = (θ_U − θ_L)/2 为半张角。
// ★ 界面零说明文字：这里拼的 title 串只给悬停用。

import { normalizeSpec } from '../../packages/core/models/paramBus.mjs'
import { DETAIL_PRESETS, templateSpec, resolveTemplateId } from '../../packages/core/models/paramTemplates.mjs'
import { specPathGet, specPathSet } from '../../packages/core/models/drive.mjs'

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const R2D = 180 / Math.PI

/** 布局族的显示名 */
export const LAYOUT_LABELS = Object.freeze({ geo: 'GEO 通信平台', 'leo-flat': 'LEO 平板', cubesat: '立方星' })

/** 反射面安装位置（paramBus 槽位）；GEO 下 +X ≈ 东、+Y ≈ 南 */
export const REFL_SLOTS = Object.freeze([
  { key: '+X', label: '东 +X' }, { key: '-X', label: '西 −X' },
  { key: '+X2', label: '东 +X（外）' }, { key: '-X2', label: '西 −X（外）' },
  { key: 'deck+Y', label: '对地板 南 +Y' }, { key: 'deck-Y', label: '对地板 北 −Y' }
])
export const slotLabel = (k) => (REFL_SLOTS.find((s) => s.key === k) || { label: String(k || '') }).label

/** 平台体热控多层（MLI）：'none' = 不包覆 */
export const MLI_CHOICES = Object.freeze([
  { key: 'mli_gold', label: '金色' }, { key: 'mli_silver', label: '银色' }, { key: 'mli_black', label: '黑色' }, { key: 'none', label: '无' }
])
export function mliOf(spec) {
  const d = spec && spec.detail
  if (d && d.mli === false) return 'none'
  const m = spec && spec.bus && spec.bus.mli
  return typeof m === 'string' && m ? m : 'none'
}
export function setMli(spec, v) {
  const s = clone(spec)
  if (!isObj(s.detail)) s.detail = {}
  if (v === 'none') s.detail.mli = false
  else { s.bus = { ...(s.bus || {}), mli: v }; s.detail.mli = true }
  return s
}

// ───────────────────────────── 太阳翼 ─────────────────────────────

/** 太阳翼构型：both = 南北双翼（±Y 各一）/ '+Y' / '-Y' 单翼 / none；不合常规的（同面两副…）报 'custom' */
export const WING_CONFIGS = Object.freeze([
  { key: 'both', label: '双翼' }, { key: '+Y', label: '+Y 单翼' }, { key: '-Y', label: '−Y 单翼' }, { key: 'none', label: '无' }
])
export function wingConfig(spec) {
  const w = Array.isArray(spec && spec.wings) ? spec.wings : []
  const sides = w.map((x) => x && x.side)
  if (!w.length) return 'none'
  if (w.length === 1 && (sides[0] === '+Y' || sides[0] === '-Y')) return sides[0]
  if (w.length === 2 && sides.includes('+Y') && sides.includes('-Y')) return 'both'
  return 'custom'
}
const WING_COPY = ['panels', 'panelHM', 'panelWM', 'sidePanels', 'sidePanelAt', 'yokeLenM', 'gapM', 'efficiency', 'axis']
/**
 * 换太阳翼构型：保留现有翼的参数（新增的那一侧照抄另一侧；一副都没有时用模板的条目缺省 itemDefault），
 * 转角按整星 SADA 角口径（−Y 翼取反）。
 */
export function setWingConfig(spec, cfg, itemDefault = null) {
  const s = clone(spec)
  const cur = Array.isArray(s.wings) ? s.wings : []
  const proto = cur.find((w) => w && w.side === '+Y') || cur.find((w) => w && w.side === '-Y') || cur[0] || itemDefault || { panels: 2, panelHM: 2, panelWM: 1.5, sidePanels: 0, yokeLenM: 0.5, gapM: 0.03, tiltDeg: 0, axis: 'y' }
  const theta = isNum(proto.tiltDeg) ? (proto.side === '-Y' ? -proto.tiltDeg : proto.tiltDeg) : 0
  const mk = (side) => {
    const have = cur.find((w) => w && w.side === side)
    if (have) return clone(have)
    const o = { side }
    for (const k of WING_COPY) if (proto[k] !== undefined) o[k] = clone(proto[k])
    o.tiltDeg = side === '-Y' ? (theta === 0 ? 0 : -theta) : theta
    return o
  }
  if (cfg === 'both') s.wings = [mk('+Y'), mk('-Y')]
  else if (cfg === '+Y' || cfg === '-Y') s.wings = [mk(cfg)]
  else if (cfg === 'none') s.wings = []
  return s
}
/** 太阳翼某字段的快速设置读数：取 +Y 翼（没有就取第一副）；两翼不同 → mixed（悬停给出两值）。tiltDeg 按 SADA 角口径换算 */
export function wingValue(spec, key) {
  const w = Array.isArray(spec && spec.wings) ? spec.wings.filter(Boolean) : []
  if (!w.length) return { value: null, mixed: false, values: [] }
  const val = (x) => (key === 'tiltDeg' ? (isNum(x.tiltDeg) ? (x.side === '-Y' ? (x.tiltDeg === 0 ? 0 : -x.tiltDeg) : x.tiltDeg) : 0) : x[key])
  const p = w.find((x) => x.side === '+Y') || w[0]
  const values = w.map(val)
  return { value: val(p), mixed: values.some((v) => v !== values[0]), values }
}
/** 太阳翼某字段一并写到每一副翼上（tiltDeg 按 SADA 角：−Y 翼取反） */
export function setWingValue(spec, key, v) {
  const s = clone(spec)
  if (!Array.isArray(s.wings)) return s
  for (const w of s.wings) {
    if (!w) continue
    if (key === 'tiltDeg') w.tiltDeg = w.side === '-Y' ? (v === 0 ? 0 : -v) : v
    else w[key] = v
    // 板数减少：显式写过的侧板位置跟着收进新板数（否则 validateSpec 拒收，整星生成不出来）
    if (key === 'panels' && Number.isInteger(v) && Number.isInteger(w.sidePanelAt) && w.sidePanelAt > v) w.sidePanelAt = Math.max(1, v)
  }
  return s
}
/** 单翼长度（SADA 外端到翼尖，不含 SADA）：连接架 + 基板串 + 板缝 */
export function wingLengthM(w) {
  if (!w || !isNum(w.panels) || !isNum(w.panelHM)) return null
  return (isNum(w.yokeLenM) ? w.yokeLenM : 0) + w.panels * w.panelHM + Math.max(0, w.panels - 1) * (isNum(w.gapM) ? w.gapM : 0)
}
/** 基板面积（全部翼，含侧板，不扣布片边距） */
export function arrayAreaM2(spec) {
  let a = 0
  for (const w of Array.isArray(spec && spec.wings) ? spec.wings : []) {
    if (!w || !isNum(w.panels) || !isNum(w.panelHM) || !isNum(w.panelWM)) continue
    a += (w.panels + (w.sidePanels === 2 ? 2 : 0)) * w.panelHM * w.panelWM
  }
  return a
}

// ───────────────────────────── 反射面 ─────────────────────────────

/** 反射面列表（快速设置的行）：下标 i 对应 spec.reflectors[i] */
export function reflRows(spec) {
  return (Array.isArray(spec && spec.reflectors) ? spec.reflectors : []).map((r, i) => ({
    i, uid: r && Number.isInteger(r.uid) ? r.uid : null, slot: r ? r.slot : '', diameterM: r ? r.diameterM : null, focalM: r ? r.focalM : null,
    offsetHM: r ? r.offsetHM : null, mesh: !!(r && r.mesh), feedType: (r && r.feedType) || 'horn', shaped: !!(r && r.shaped), fixed: !!(r && r.posBody)
  }))
}
/** 还空着的安装位置（给「添加」与本行下拉用；本行自己占的那个照列） */
export function slotChoices(spec, i = -1) {
  const used = new Set((Array.isArray(spec && spec.reflectors) ? spec.reflectors : []).filter((r, k) => r && !r.posBody && k !== i).map((r) => r.slot))
  return REFL_SLOTS.filter((s) => !used.has(s.key))
}
/**
 * 添加一副反射面：占第一个空闲位置；口径缺省按细节档的示意口径（对地板 / 侧壁各一档），没有就按平台尺寸量级给。
 * @returns {{spec:object, path:string}|null} path = 新条目的口径路径（调用方记成示意值）；位置占满 → null
 */
export function addReflector(spec, itemDefault = null) {
  const free = slotChoices(spec)
  if (!free.length) return null
  const s = clone(spec)
  if (!Array.isArray(s.reflectors)) s.reflectors = []
  const slot = free[0].key, deck = slot.startsWith('deck')
  const D = DETAIL_PRESETS[normalizeSpec(s).detailPreset] || {}
  let dm = deck ? D.illustrativeDeckReflectorDM : D.illustrativeReflectorDM
  if (!isNum(dm)) { const b = s.bus || {}; dm = +(Math.max(0.05, Math.min(b.xM || 1, b.yM || 1) * 0.8)).toFixed(3) }
  const base = itemDefault ? clone(itemDefault) : {}
  delete base.mount
  const r = { focalM: null, offsetHM: null, posBody: null, boresightBody: [0, 0, 1], feedType: 'horn', mesh: false, shaped: false, ...base, slot, diameterM: isNum(base.diameterM) ? base.diameterM : dm }
  s.reflectors.push(r)
  return { spec: s, path: `reflectors[${s.reflectors.length - 1}].diameterM` }
}
export function removeReflector(spec, i) {
  const s = clone(spec)
  if (Array.isArray(s.reflectors) && i >= 0 && i < s.reflectors.length) s.reflectors.splice(i, 1)
  return s
}
export function setReflValue(spec, i, key, v) {
  const s = clone(spec)
  const r = Array.isArray(s.reflectors) ? s.reflectors[i] : null
  if (!r) return s
  r[key] = v
  return s
}
/** 生成器实际用的焦距（spec 留空时按细节档焦径比：网状 / 对地板实面 / 东西侧挂实面各一档，与 paramBus.focalOf 同式） */
export function effFocalM(spec, r) {
  if (!r) return null
  if (isNum(r.focalM)) return r.focalM
  const D = DETAIL_PRESETS[normalizeSpec(spec).detailPreset] || {}
  const mesh = r.mesh === true || (isNum(r.diameterM) && r.diameterM > D.meshAboveDM)
  const deck = typeof r.slot === 'string' && r.slot ? r.slot.startsWith('deck') : r.mount === 'deck'
  const fd = mesh ? D.fdMesh : deck ? D.fdSolid : D.fdSide
  return isNum(fd) && isNum(r.diameterM) ? fd * r.diameterM : null
}
/**
 * 偏置抛物面几何读数：D 口径、f 焦距、dc 口径中心偏置高度（离母轴）。
 * @returns {{fD:number, clearanceM:number, theta0Deg:number, thetaStarDeg:number}|null}
 */
export function reflGeom(D, f, dc) {
  if (!(isNum(D) && D > 0 && isNum(f) && f > 0 && isNum(dc))) return null
  const yL = dc - D / 2, yU = dc + D / 2
  const tL = 2 * Math.atan(yL / (2 * f)), tU = 2 * Math.atan(yU / (2 * f))
  return { fD: f / D, clearanceM: yL, theta0Deg: ((tU + tL) / 2) * R2D, thetaStarDeg: ((tU - tL) / 2) * R2D }
}

// ───────────────────────────── 出处 / 示意值 ─────────────────────────────

const TPL = new Map()
function tplOf(templateId) {
  const id = resolveTemplateId(templateId)
  if (!id) return null
  if (!TPL.has(id)) {
    const t = templateSpec(id)
    TPL.set(id, t && t.spec ? { spec: t.spec, ill: new Set(t.illustrative || []), src: t.specSources || {} } : null)
  }
  return TPL.get(id)
}
/** 路径里的列表下标按条目的「身份」对回模板：反射面按槽位、太阳翼按装在哪一面；对不上 → null */
function tplPathFor(t, spec, path) {
  const m = /^(reflectors|wings)\[(\d+)\](.*)$/.exec(path)
  if (!m) return path
  const item = Array.isArray(spec[m[1]]) ? spec[m[1]][Number(m[2])] : null
  const list = Array.isArray(t.spec[m[1]]) ? t.spec[m[1]] : []
  const key = m[1] === 'reflectors' ? 'slot' : 'side'
  const j = item ? list.findIndex((x) => x && x[key] === item[key]) : -1
  return j < 0 ? null : `${m[1]}[${j}]${m[3]}`
}
const sameVal = (a, b) => (isNum(a) && isNum(b) ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)) : JSON.stringify(a) === JSON.stringify(b))
/**
 * 某驱动参数的出处：值仍是模板给的 → 'source'（有文献出处）/ 'derived'（推算）/ 'illustrative'（示意值，界面红色标示）；
 * 用户改过或没有模板 → 'user'。title = 悬停用的出处 / 依据串。
 * @returns {{kind:'source'|'derived'|'illustrative'|'user', title:string}}
 */
export function provOf(templateId, spec, path) {
  const t = templateId ? tplOf(templateId) : null
  if (!t || !spec) return { kind: 'user', title: '' }
  const tp = tplPathFor(t, spec, path)
  if (!tp || !sameVal(specPathGet(spec, path), specPathGet(t.spec, tp))) return { kind: 'user', title: '' }
  const wild = tp.replace(/\[\d+\]/g, '[*]')
  const e = t.src[tp] || t.src[wild]
  if (t.ill.has(tp) || (e && e.kind === 'illustrative')) return { kind: 'illustrative', title: '示意值' + (e && e.note ? '\n' + e.note : '') }
  if (e) return { kind: e.kind === 'derived' ? 'derived' : 'source', title: [e.source, e.note].filter(Boolean).join('\n') }
  return { kind: 'user', title: '' }
}

/** 写一个驱动参数（路径式；值为 null 时删掉可选覆盖键 tower.* / density.*，回生成器缺省） */
export function setSpecValue(spec, path, v) {
  const s = clone(spec)
  if (v == null && /^(density\.[A-Za-z]+|tower\.(hM|wM))$/.test(path)) {
    const [o, k] = path.split('.')
    if (isObj(s[o])) { delete s[o][k]; if (!Object.keys(s[o]).length) delete s[o] }
    return s
  }
  specPathSet(s, path, v)
  return s
}
