// 卫星页（DESIGN2 §3）的纯逻辑：绑定工作副本的归一、挂点表格的行 ⇄ mount 换算、从 attach point / 预览点选 / 模板新增、
// 复制 / 删除 / JSON 进出、天线引用的选项与方向图宽度。无 three / vue / DOM —— node 单测直接 import（modelWbMounts.test.mjs）。
//
// 口径（改前先看 packages/core/models/schema.mjs 的 mount 注释，那边是唯一定义）：
//   · 本体系：+X 速度、+Y 补全、+Z 天底。posBody 米；boresightBody / upBody 单位向量。
//   · 表格里的视轴写成 az / el（D2 掩模角：az = atan2(y, x) ∈ [0, 360)、el = asin(z)，+90° = 天底）——与掩模图、报告挂点表同一套角；
//     up 写成「滚转」= 上向量相对 D1 缺省上向量（bodyFrame.defaultUpBody）绕视轴的右手角（°），与 lbBodyLayout 报告表同一口径。
//     改 az / el 时滚转不变（上向量跟着视轴转），改滚转只动上向量。
//   · 天线引用 antennaRef：{kind:'grd', id:'folder|name'}（GRD 树天线）| {kind:'lbAntenna', id:'<ns>:<条目 id>'}（链路预算卫星库）|
//     {kind:'param', spec:{diameterM, freqGHz, efficiency, gainDbi, hpbwDeg, pattern}}（参数化口径）| null。
//   · 视场锥半角（预览）与 −3 dB 全宽（星侧太阳侵入）：fovDeg 优先；否则按参数化口径 hpbwDeg → 70λ/D（20.98547 / (f·D)，与日凌核同式）
//     → 增益 G 反推 θ ≈ √(41253 / G)（高斯主瓣 Ω ≈ θ²，全向 0 dBi 这类给不出锥）。
// ★ 引 packages/core 一律走相对路径（单测是裸 node，认不得 vite 的 @core 别名）。
import { normalizeMount, normalizeAttitude, defaultMount, isValidModelId, ATTITUDE_LAWS } from '../../packages/core/models/schema.mjs'
import { defaultUpBody, isUpDegenerate } from '../../packages/core/models/bodyFrame.mjs'
import { applyMountTemplate, listMountTemplates } from '../../packages/core/models/mountTemplates.mjs'
import { maskSignature } from '../../packages/core/models/mask.mjs'
import { BAND_FREQ } from '../linkbudget/satPresets.js'

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum)
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (v) => { const n = Math.hypot(v[0], v[1], v[2]); return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : null }
const z0 = (v) => (Math.abs(v) < 1e-15 ? 0 : v)
const r6 = (v) => Math.round(v * 1e6) / 1e6

// ───────────────────────────── 绑定工作副本 ─────────────────────────────

/** 空绑定（卫星页新建）：模型自动匹配、没有挂点、姿态律 nadir */
export function emptyBinding() {
  return { model: { id: 'auto' }, mounts: [], attitude: { law: 'nadir', params: {} } }
}

/**
 * 一颗星的绑定 → 可直接编辑 / 落盘的工作副本（纯数据）。口径同 schema.validateBindings 的单条归一：
 * 模型 id 非法按 auto、mount 逐条 normalizeMount（坏条丢弃）、id 本星内唯一、姿态律 normalizeAttitude；massProps 原样留着（本页不改它）。
 * @returns {{binding:object, errors:string[]}}
 */
export function normalizeBinding(b) {
  const errors = []
  const src = isObj(b) ? plain(b) : {}
  const out = emptyBinding()
  const m = isObj(src.model) ? src.model : {}
  const id = m.id === undefined ? 'auto' : m.id
  out.model = { ...m, id: id === 'auto' || id === null || isValidModelId(id) ? id : 'auto' }
  if (out.model.id !== id) errors.push('model.id：非法，按自动')
  if (src.massProps !== undefined) out.massProps = src.massProps
  const ids = new Set()
  for (const [i, mm] of (Array.isArray(src.mounts) ? src.mounts : []).entries()) {
    const r = normalizeMount(mm, { path: `mounts[${i}]`, errors, fallbackId: nextMountId(ids) })
    if (!r.mount) continue
    if (ids.has(r.mount.id)) r.mount.id = uniqueMountId(r.mount.id, ids)
    ids.add(r.mount.id)
    out.mounts.push(r.mount)
  }
  out.attitude = normalizeAttitude(src.attitude, { path: 'attitude', errors }).attitude
  return { binding: out, errors }
}
/** 姿态律还是缺省（nadir、除 0 偏航外没有参数）：模板 / JSON 导入带来的姿态律只在这种时候采用，用户改过的不覆盖 */
export function isDefaultAttitude(att) {
  if (!isObj(att)) return true
  if (att.law && att.law !== 'nadir') return false
  const p = isObj(att.params) ? att.params : {}
  return !Object.keys(p).some((k) => p[k] != null && !(k === 'yawBiasDeg' && p[k] === 0))
}
/** 绑定是不是「什么都没写」（模型自动、无挂点、nadir 无参数、没有质量覆盖）：落盘时写 null 删掉这条，绑定表不留空壳 */
export function isEmptyBinding(b) {
  if (!isObj(b)) return true
  const mid = b.model ? b.model.id : 'auto'
  const extraModel = b.model && (b.model.iconPx != null || b.model.frameOverride != null)
  return mid === 'auto' && !extraModel && !(Array.isArray(b.mounts) && b.mounts.length) && isDefaultAttitude(b.attitude) && b.massProps == null
}

// ───────────────────────────── id / 名字 ─────────────────────────────

export function nextMountId(taken) {
  let k = 1
  while (taken.has(`mount_${k}`)) k++
  return `mount_${k}`
}
/** base 在本星已用 id 里撞了就加 _2、_3…（≤ 64 字：截掉尾巴再加后缀） */
export function uniqueMountId(base, taken) {
  const b = String(base || 'mount').trim().replace(/\s+/g, '_').slice(0, 60) || 'mount'
  if (!taken.has(b)) return b
  let k = 2
  while (taken.has(`${b}_${k}`)) k++
  return `${b}_${k}`
}

// ───────────────────────────── 视轴 az / el、滚转 ─────────────────────────────

/** 本体系方向 → D2 掩模角 {az ∈ [0, 360), el ∈ [−90, 90]}（度） */
export function azElOf(d) {
  const u = unit(d) || [0, 0, 1]
  const el = Math.atan2(u[2], Math.hypot(u[0], u[1])) * R2D
  let az = Math.atan2(u[1], u[0]) * R2D
  if (az < 0) az += 360
  if (az >= 360 || Math.abs(Math.hypot(u[0], u[1])) < 1e-12) az = 0
  return { az: z0(az), el: z0(el) }
}
/** D2 掩模角 → 本体系单位方向 */
export function dirOfAzEl(azDeg, elDeg) {
  const a = azDeg * D2R, e = elDeg * D2R, ce = Math.cos(e)
  return [z0(ce * Math.cos(a)), z0(ce * Math.sin(a)), z0(Math.sin(e))]
}
/** v 绕单位轴 k 右手转 deg（Rodrigues） */
function rot(v, k, deg) {
  const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R), kv = dot(k, v), kx = cross(k, v)
  return [v[0] * c + kx[0] * s + k[0] * kv * (1 - c), v[1] * c + kx[1] * s + k[1] * kv * (1 - c), v[2] * c + kx[2] * s + k[2] * kv * (1 - c)]
}
/** 滚转（°，(−180, 180]）：upBody 相对 D1 缺省上向量绕视轴的右手角 */
export function rollOf(bore, up) {
  const d = unit(bore) || [0, 0, 1]
  const u0 = defaultUpBody(d)
  if (!isVec3(up) || isUpDegenerate(d, up)) return 0
  const k = dot(up, d)
  const u = unit([up[0] - k * d[0], up[1] - k * d[1], up[2] - k * d[2]])
  if (!u) return 0
  const r = Math.atan2(dot(cross(u0, u), d), dot(u0, u)) * R2D
  return r <= -180 ? 180 : z0(r)
}
/** 视轴 + 滚转 → 上向量（D1 缺省上向量绕视轴转 roll） */
export function upOfRoll(bore, rollDeg) {
  const d = unit(bore) || [0, 0, 1]
  const u0 = defaultUpBody(d)
  if (!rollDeg) return u0.slice()
  const u = unit(rot(u0, d, rollDeg))
  return u ? u.map(z0) : u0.slice()
}

// ───────────────────────────── 天线引用 ─────────────────────────────

/**
 * 天线引用下拉的选项：GRD 树天线（folder|name）+ 链路预算卫星库条目（EIRP / G·T 标量）+ 「参数化口径」+ 「无」。
 * value 是编码后的字符串（下拉用）：'' 无 · 'param' 参数化 · 'grd:<folder|name>' · 'lb:<ns>:<id>'。
 * @param {{grdSats?:{folder, satName, antennas?:{name}[]}[], lbSats?:{ns, id, name, summary?}[]}} src
 */
export function antennaOptions(src = {}) {
  const out = [{ value: '', label: '无', group: '' }, { value: 'param', label: '参数化口径', group: '' }]
  for (const s of Array.isArray(src.grdSats) ? src.grdSats : []) {
    for (const a of Array.isArray(s.antennas) ? s.antennas : []) {
      if (!a || !a.name) continue
      out.push({ value: `grd:${s.folder}|${a.name}`, label: `${s.satName || s.folder} · ${a.name}`, group: 'GRD' })
    }
  }
  for (const e of Array.isArray(src.lbSats) ? src.lbSats : []) {
    if (!e || !e.id || !e.ns) continue
    out.push({ value: `lb:${e.ns}:${e.id}`, label: e.name + (e.summary ? ' · ' + e.summary : ''), group: LB_NS_LABEL[e.ns] || e.ns })
  }
  return out
}
export const LB_NS_LABEL = { geo: 'GEO 链路预算', ngso: 'NGSO 链路预算', regen: '再生式链路预算', e2e: '端到端链路' }
/** antennaRef → 下拉 value */
export function antennaValue(ref) {
  if (!isObj(ref)) return ''
  if (ref.kind === 'param') return 'param'
  if (ref.kind === 'grd' && ref.id) return 'grd:' + ref.id
  if (ref.kind === 'lbAntenna' && ref.id) return 'lb:' + ref.id
  return ''
}
/** 下拉 value → antennaRef（'param' 保留原参数化口径 spec，没有就空口径） */
export function antennaFromValue(v, prev) {
  const s = String(v || '')
  if (!s) return null
  if (s === 'param') return { kind: 'param', spec: isObj(prev) && prev.kind === 'param' && isObj(prev.spec) ? plain(prev.spec) : {} }
  if (s.startsWith('grd:')) return { kind: 'grd', id: s.slice(4) }
  if (s.startsWith('lb:')) return { kind: 'lbAntenna', id: s.slice(3) }
  return null
}
/**
 * 表格「天线」格写进来的文本 → antennaRef。下拉选的是编码值（'' / 'param' / 'grd:…' / 'lb:…'），粘贴 / 填充柄 / Excel 导入进来的
 * 是格子上显示的名字（cellRaw = 显示名），两路都认：
 *   编码值 → antennaFromValue；'param:{…}' → 带整份口径的参数化；选项名 → 该选项；本表某一行天线格的显示名 → 照搬那一行的引用
 *   （参数化连同整份口径：显示名只列口径 / 频率 / 波束宽 / 增益，效率与方向图类型要从源行拿）；「无」/ 空 → null。
 * 认不出返回 undefined（调用方不写 —— 不能把引用悄悄清空）。
 * @param {{antOptions?:{value,label}[], mounts?:object[], antennaValueMap?:(v)=>object|null|undefined}} [ctx]
 */
export function antennaFromText(v, prev, ctx = {}) {
  if (typeof ctx.antennaValueMap === 'function') { const r = ctx.antennaValueMap(v); if (r !== undefined) return r }
  const s = String(v == null ? '' : v).trim()
  if (!s || s === '无') return null
  if (s === 'param' || /^(grd|lb):./.test(s)) return antennaFromValue(s, prev)
  const pj = /^param\s*:\s*(\{[\s\S]*\})$/.exec(s)
  if (pj) { try { const spec = JSON.parse(pj[1]); return isObj(spec) ? { kind: 'param', spec } : undefined } catch { return undefined } }
  const opts = Array.isArray(ctx.antOptions) ? ctx.antOptions : []
  const o = opts.find((x) => x && x.value && x.label === s)
  if (o) return antennaFromValue(o.value, prev)
  for (const m of Array.isArray(ctx.mounts) ? ctx.mounts : []) {
    if (m && isObj(m.antennaRef) && antennaLabel(m.antennaRef, opts) === s) return plain(m.antennaRef)
  }
  return undefined
}

/**
 * 链路预算卫星库条目（satSources.lbLibrarySats 的一项）→ 天线引用 lbAntenna 用得上的标量：
 *   freqGHz 星上接收频率 = 上行中心频率（表单没填按工作频段的出厂上行频率，同 satPresets.BAND_FREQ）；
 *   gtDbK 卫星 G/T（GEO / NGSO 表单的「G/Tref」、端到端的「G/T」）；eirpDbw 卫星 EIRP（端到端表单的卫星 EIRP；GEO 的 EIRP 是站表配对量，库里没有）；
 *   grdKey 条目挂的 G/T 方向图（GRD 树天线 folder|name；接收天线的方向图，星侧太阳侵入按它取增益）。没有的项为 null / ''。
 */
export function lbAntennaInfo(e) {
  const f = isObj(e) && isObj(e.form) ? e.form : {}
  const n = (v) => (v === '' || v == null ? null : (isNum(Number(v)) ? Number(v) : null))
  let freq = n(f.centerFrequency)
  if (!(freq > 0)) { const b = BAND_FREQ[f.frequencyBand]; freq = b ? b.up : null }
  const gt = e && e.ns === 'e2e' ? n(f.gt) : n(f.sfdGtRef)
  const eirp = e && e.ns === 'e2e' ? n(f.eirpSat) : null
  const g = isObj(e) && isObj(e.grd) ? e.grd : {}
  return { freqGHz: freq > 0 ? freq : null, gtDbK: gt, eirpDbw: eirp, grdKey: typeof g.gtKey === 'string' && g.gtKey.includes('|') ? g.gtKey : '' }
}
/** 链路预算库条目在天线下拉里的短标签（频段 · 上 / 下行频率 · G/T · EIRP · GEO 轨位） */
export function lbAntennaSummary(e) {
  const f = isObj(e) && isObj(e.form) ? e.form : {}
  const info = lbAntennaInfo(e)
  const bits = []
  if (f.frequencyBand) bits.push(String(f.frequencyBand))
  if (f.centerFrequency || f.rxCenterFrequency) bits.push(`${f.centerFrequency || '—'}/${f.rxCenterFrequency || '—'} GHz`)
  if (info.gtDbK != null) bits.push(`G/T ${info.gtDbK} dB/K`)
  if (info.eirpDbw != null) bits.push(`EIRP ${info.eirpDbw} dBW`)
  if (e && e.ns === 'geo' && f.orbitPosition !== undefined && f.orbitPosition !== '') bits.push(f.orbitPosition + '°')
  return bits.join(' · ')
}
/**
 * G/T 反推的高斯主瓣 −3 dB 全宽（°）：G = G/T + 10·lg T_sys，θ ≈ √(41253 / G)；G ≤ 3 dBi（给不出主瓣）返回 null。
 * 只作链路预算库条目（没有口径 / 方向图）的缺省估计，分析页可手改。
 */
export function hpbwFromGt(gtDbK, sysTempK) {
  if (!isNum(gtDbK)) return null
  const T = isNum(sysTempK) && sysTempK > 0 ? sysTempK : 500
  const g = gtDbK + 10 * Math.log10(T)
  return g > 3 ? Math.sqrt(41253 / Math.pow(10, g / 10)) : null
}
/** 天线引用的显示名（表格格子）：选项里有就用选项名，没有（树 / 库里删掉了）显示原 id */
export function antennaLabel(ref, options) {
  const v = antennaValue(ref)
  if (!v) return ''
  if (v === 'param') {
    const sp = (ref && ref.spec) || {}
    const bits = []
    if (isNum(sp.diameterM)) bits.push(sp.diameterM + ' m')
    if (isNum(sp.freqGHz)) bits.push(sp.freqGHz + ' GHz')
    if (isNum(sp.hpbwDeg)) bits.push(sp.hpbwDeg + '°')
    if (isNum(sp.gainDbi)) bits.push(sp.gainDbi + ' dBi')
    return '参数化' + (bits.length ? ' · ' + bits.join(' ') : '')
  }
  const o = (options || []).find((x) => x.value === v)
  return o ? o.label : v.replace(/^(grd|lb):/, '')
}

/**
 * 方向图 −3 dB 全宽（°）：参数化口径 hpbwDeg → 70λ/D → 增益反推；给不出返回 null。
 * freqGHz 可外给（分析页用户填的频率优先于口径里的）。
 */
export function hpbwOf(ref, freqGHz) {
  if (!isObj(ref) || ref.kind !== 'param' || !isObj(ref.spec)) return null
  const sp = ref.spec
  if (isNum(sp.hpbwDeg) && sp.hpbwDeg > 0) return sp.hpbwDeg
  const f = isNum(freqGHz) && freqGHz > 0 ? freqGHz : sp.freqGHz
  if (isNum(sp.diameterM) && sp.diameterM > 0 && isNum(f) && f > 0) return 20.98547 / (f * sp.diameterM)
  if (isNum(sp.gainDbi) && sp.gainDbi > 3) return Math.sqrt(41253 / Math.pow(10, sp.gainDbi / 10))
  return null
}
/** 视场锥半角（°，预览画锥用）：fovDeg/2 优先，否则 −3 dB 半宽；都没有返回 null（不画锥） */
export function coneHalfOf(m) {
  if (!m) return null
  if (isNum(m.fovDeg) && m.fovDeg > 0) return Math.min(180, m.fovDeg) / 2
  const h = hpbwOf(m.antennaRef)
  return h ? h / 2 : null
}
/** 全向天线（参数化口径 pattern = 'omni'，或只给了 ≤ 3 dBi 的增益、没有口径 / 波束宽）：视场按全空间 */
export function isOmni(ref) {
  if (!isObj(ref) || ref.kind !== 'param' || !isObj(ref.spec)) return false
  const sp = ref.spec
  if (sp.pattern === 'omni') return true
  return isNum(sp.gainDbi) && sp.gainDbi <= 3 && !(isNum(sp.hpbwDeg) && sp.hpbwDeg > 0) && !(isNum(sp.diameterM) && sp.diameterM > 0)
}
/**
 * 视场全锥角（°；万向节「固定天线」判可跟踪用）：挂点 fovDeg → 方向图 −3 dB 全宽（与表格「视场」列留空的口径、预览里画的锥同一个）→
 * 全向天线 360°；都给不出返回 null（gimbal.trackSeries 退回跟踪容差）。
 */
export function fovFullOf(m) {
  if (!m) return null
  if (isNum(m.fovDeg) && m.fovDeg > 0) return Math.min(360, m.fovDeg)
  const h = hpbwOf(m.antennaRef)
  if (h) return Math.min(360, h)
  return isOmni(m.antennaRef) ? 360 : null
}
/** 天线接收频率（GHz）：参数化口径里的；没有返回 null */
export function freqOf(ref) { return isObj(ref) && ref.kind === 'param' && isObj(ref.spec) && isNum(ref.spec.freqGHz) ? ref.spec.freqGHz : null }

// ───────────────────────────── 表格：行 ⇄ mount ─────────────────────────────

/** 表格列（ExcelGrid col：key / label / unit / num / w / tip；枚举列 options 由页面按当前数据现给） */
export const MOUNT_COLS = [
  { key: 'name', label: '名称', w: 120, tip: '挂点名（本星内可重名，id 唯一）' },
  { key: 'attachPoint', label: 'attach point', w: 108, tip: '引用的模型挂点（几何来源）；空 = 自由挂点' },
  { key: 'px', label: 'X', unit: 'm', num: true, w: 58, tip: '位置（本体系，米；+X 速度）' },
  { key: 'py', label: 'Y', unit: 'm', num: true, w: 58, tip: '位置（本体系，米）' },
  { key: 'pz', label: 'Z', unit: 'm', num: true, w: 58, tip: '位置（本体系，米；+Z 天底）' },
  { key: 'az', label: '视轴 az', unit: '°', num: true, w: 60, tip: '视轴方位（本体系，自 +X 向 +Y，0–360°；与掩模图同一口径 D2）' },
  { key: 'el', label: '视轴 el', unit: '°', num: true, w: 60, tip: '视轴俯仰（本体系，+90° = 本体 +Z 天底、−90° = 天顶）' },
  { key: 'roll', label: '滚转', unit: '°', num: true, w: 54, tip: '上向（天线 +y）相对缺省上向（本体 −Y 在视轴法平面的投影）绕视轴的右手角' },
  { key: 'fov', label: '视场', unit: '°', num: true, w: 54, tip: '视场全锥角；留空 = 按方向图 −3 dB' },
  { key: 'gimbal', label: '万向节', w: 64, tip: '无 / 方位-俯仰（az-el）/ X-Y 两轴（轴向定义见 gimbal.mjs：az-el 方位轴 = up；X-Y 的 a1 绕挂点 x、a2 绕转过后的 y）' },
  { key: 'a1Min', label: 'a1 下限', unit: '°', num: true, w: 58, tip: '外轴限位下限（az-el：方位；X-Y：X 轴）' },
  { key: 'a1Max', label: 'a1 上限', unit: '°', num: true, w: 58, tip: '外轴限位上限' },
  { key: 'a2Min', label: 'a2 下限', unit: '°', num: true, w: 58, tip: '内轴限位下限（az-el：俯仰；X-Y：Y 轴）' },
  { key: 'a2Max', label: 'a2 上限', unit: '°', num: true, w: 58, tip: '内轴限位上限' },
  { key: 'rate', label: '角速率上限', unit: '°/s', num: true, w: 74, tip: '两轴角速率上限；留空 = 不限速' },
  { key: 'antenna', label: '天线', w: 150, tip: '天线引用：GRD 树天线（folder|name）/ 链路预算卫星库条目 / 参数化口径（不另设天线概念）' },
  { key: 'sysTempK', label: 'T_sys', unit: 'K', num: true, w: 58, tip: '星上接收系统噪声温度（星侧太阳侵入 ΔG/T = 10·lg(1 + ΔT / T_sys)）' },
  { key: 'exclude', label: '排除节点', w: 120, tip: '算本体遮挡时不当遮挡体的节点（逗号分隔；连同子孙；模型标了「不遮挡」的节点另外自动排除）' }
]
export const GIMBAL_LABEL = { none: '无', azel: 'az-el', xy: 'X-Y' }

const f4 = (v) => (isNum(v) ? String(Number(v.toPrecision(6))) : '')
/** mount → 表格行（显示用的数都在这里算好；id 是行键） */
export function mountRow(m, antOptions) {
  const bore = isVec3(m.boresightBody) ? m.boresightBody : [0, 0, 1]
  const ae = azElOf(bore)
  const g = m.gimbal || {}, L = g.limits || {}
  return {
    id: m.id, name: m.name || m.id, attachPoint: m.attachPoint || '',
    px: m.posBody[0], py: m.posBody[1], pz: m.posBody[2],
    az: ae.az, el: ae.el, roll: rollOf(bore, m.upBody),
    fov: isNum(m.fovDeg) ? m.fovDeg : null,
    gimbal: g.type || 'none', a1Min: L.a1Min, a1Max: L.a1Max, a2Min: L.a2Min, a2Max: L.a2Max,
    rate: isNum(g.rateDegS) ? g.rateDegS : null,
    antenna: antennaLabel(m.antennaRef, antOptions), antennaValue: antennaValue(m.antennaRef),
    sysTempK: isNum(m.sysTempK) ? m.sysTempK : null,
    exclude: formatNameList(m.excludeNodes)
  }
}

// ── 节点名单（排除节点列）的文本口径 ──
// 分隔符只认逗号 / 分号（中英文）与换行 —— 空格不是分隔符：导入件（STEP / FBX / SketchUp）的节点名常带空格（「Solar Array Left」），
// 按空白切会把名单拆碎、排除静默失效。名字里本身带分隔符或引号、首尾有空格的，显示时加双引号，读回时去掉。
const LIST_SEP = /[,，;；\r\n]/
const QUOTES = { '"': '"', '“': '”', "'": "'", '‘': '’', '「': '」' }
/** 文本 → 名字数组（去空、去重、保序；引号里的分隔符照留） */
export function parseNameList(text) {
  const s = String(text == null ? '' : text)
  const out = []
  let i = 0
  const push = (x) => { if (x && !out.includes(x)) out.push(x) }
  while (i < s.length) {
    while (i < s.length && (LIST_SEP.test(s[i]) || /\s/.test(s[i]))) i++
    if (i >= s.length) break
    const close = QUOTES[s[i]]
    if (close) {
      const j = s.indexOf(close, i + 1)
      if (j > i) {
        push(s.slice(i + 1, j))
        i = j + 1
        while (i < s.length && !LIST_SEP.test(s[i])) i++   // 引号后到下一个分隔符之间的杂字丢掉
        continue
      }
    }
    let j = i
    while (j < s.length && !LIST_SEP.test(s[j])) j++
    push(s.slice(i, j).trim())
    i = j
  }
  return out
}
/** 名字数组 → 表格文本（「, 」连接；含分隔符 / 引号 / 首尾空格的名字加双引号，parseNameList 读回原样） */
export function formatNameList(arr) {
  const q = (x) => (!x.includes('"') ? `"${x}"` : !x.includes('」') ? `「${x}」` : x)
  return (Array.isArray(arr) ? arr : []).filter((x) => typeof x === 'string' && x).map((x) => (LIST_SEP.test(x) || /^\s|\s$/.test(x) || /^["“'‘「]/.test(x) ? q(x) : x)).join(', ')
}
/** 表格格子文本 */
export function cellText(row, col) {
  const v = row[col.key]
  if (col.key === 'gimbal') return GIMBAL_LABEL[v] || v || ''
  if (col.num) return v == null ? '' : f4(v)
  return v == null ? '' : String(v)
}

/**
 * 表格改一格 → 新 mount（经 normalizeMount；不改入参）。value 已是数（数字列，空 = null）或字符串。
 * 数字列非法（非有限）时返回 null（调用方不写）。
 * @param {object} m 原 mount
 * @param {string} key 列键
 * @param {*} value
 * @param {{attachPoints?:object[], parts?:object[], antOptions?:object[], mounts?:object[], antennaValueMap?:(v:string)=>object|null|undefined}} [ctx]
 *        antOptions / mounts：天线列按显示名认选项、认本表别的行（antennaFromText）
 */
export function applyMountEdit(m, key, value, ctx = {}) {
  const n = plain(m)
  const num = (v) => (v === null || v === '' ? null : (isNum(v) ? v : (typeof v === 'string' && v.trim() !== '' && isNum(Number(v)) ? Number(v) : NaN)))
  const bore = isVec3(n.boresightBody) ? n.boresightBody : [0, 0, 1]
  const roll = rollOf(bore, n.upBody)
  switch (key) {
    case 'name': { const s = String(value || '').trim(); if (!s) return null; n.name = s.slice(0, 120); break }
    case 'attachPoint': {
      const s = String(value || '').trim()
      if (!s) { n.attachPoint = null; break }
      const ap = (ctx.attachPoints || []).find((a) => a && a.name === s)
      if (!ap) return null
      // 选了模型挂点：位置 / 视轴 / 上向取它（模型为准，与模板套用、「从 attach point 套用」同一口径）
      n.attachPoint = s
      if (isVec3(ap.posBody)) n.posBody = ap.posBody.slice()
      if (isVec3(ap.dirBody)) n.boresightBody = ap.dirBody.slice()
      n.upBody = isVec3(ap.upBody) && !isUpDegenerate(n.boresightBody, ap.upBody) ? ap.upBody.slice() : undefined
      if (!(Array.isArray(n.excludeNodes) && n.excludeNodes.length)) { const own = ownAntennaNodes(ctx.parts, s); if (own.length) n.excludeNodes = own }
      break
    }
    case 'px': case 'py': case 'pz': {
      const v = num(value); if (!isNum(v)) return null
      n.posBody = n.posBody.slice(); n.posBody['xyz'.indexOf(key[1])] = v
      break
    }
    case 'az': case 'el': {
      const v = num(value); if (!isNum(v)) return null
      const ae = azElOf(bore)
      const az = key === 'az' ? ((v % 360) + 360) % 360 : ae.az
      const el = key === 'el' ? Math.max(-90, Math.min(90, v)) : ae.el
      n.boresightBody = dirOfAzEl(az, el)
      n.upBody = upOfRoll(n.boresightBody, roll)
      break
    }
    case 'roll': { const v = num(value); if (!isNum(v)) return null; n.upBody = upOfRoll(bore, v); break }
    case 'fov': { const v = num(value); if (v === null) delete n.fovDeg; else if (isNum(v) && v > 0 && v <= 360) n.fovDeg = v; else return null; break }
    case 'gimbal': {
      const s = String(value)
      const t = Object.keys(GIMBAL_LABEL).find((k) => k === s || GIMBAL_LABEL[k] === s)
      if (!t) return null
      n.gimbal = { ...(n.gimbal || {}), type: t }
      break
    }
    case 'a1Min': case 'a1Max': case 'a2Min': case 'a2Max': {
      const v = num(value); if (!isNum(v) || Math.abs(v) > 360) return null
      n.gimbal = { ...(n.gimbal || { type: 'none' }), limits: { ...((n.gimbal && n.gimbal.limits) || {}), [key]: v } }
      break
    }
    case 'rate': {
      const v = num(value)
      const g = { ...(n.gimbal || { type: 'none' }) }
      if (v === null) delete g.rateDegS; else if (isNum(v) && v > 0) g.rateDegS = v; else return null
      n.gimbal = g
      break
    }
    case 'antenna': {
      // 下拉选的编码值、粘贴 / 填充进来的显示名都认（antennaFromText）；认不出不写，不能把原引用清空
      const ref = antennaFromText(value, n.antennaRef, ctx)
      if (ref === undefined) return null
      n.antennaRef = ref
      break
    }
    case 'sysTempK': { const v = num(value); if (v === null) delete n.sysTempK; else if (isNum(v) && v > 0) n.sysTempK = v; else return null; break }
    case 'exclude': n.excludeNodes = parseNameList(value); break
    default: return null
  }
  if (n.upBody === undefined) delete n.upBody
  // 换了位姿 / 视轴 / 排除名单 → 掩模签名作废（掩模要重算；对日扫描那一套同理）
  if (['attachPoint', 'px', 'py', 'pz', 'az', 'el', 'exclude'].includes(key)) { delete n.maskSig; delete n.maskSun }
  const r = normalizeMount(n, { path: 'mount' })
  return r.mount
}

// ───────────────────────────── 新增 / 复制 / 删除 ─────────────────────────────

/**
 * 反射面焦点挂点（参数化模型的 reflector_N_focus）自己那副天线的节点：反射面（含背壳 / 边环 / 网状桁架）、展开臂、同号馈源与馈源支架
 * （与 modelBodyMask 单测的「自身天线」名单同一套）。
 * 波束就是它们形成的，不算这个挂点的遮挡体；不排除的话，射线起点（焦点 + 1 cm·视轴）就在馈源喇叭口面上（口面中心 = 焦点），
 * 天底一侧整片判成遮挡、天线视角满屏是喇叭内壁。其它挂点名返回 []。
 * @param parts meta.parts（{id, nodes}[]）
 */
export function ownAntennaNodes(parts, apName) {
  const m = /^reflector_(\d+)_focus$/.exec(String(apName || ''))
  if (!m || !Array.isArray(parts)) return []
  const ids = new Set([`reflector_${m[1]}`, `reflector_${m[1]}_arm`, `feed_${m[1]}`, `feed_${m[1]}_support`])
  const out = []
  for (const p of parts) {
    if (!p || !ids.has(p.id) || !Array.isArray(p.nodes)) continue
    for (const nm of p.nodes) if (typeof nm === 'string' && nm && !out.includes(nm)) out.push(nm)
  }
  return out
}

/** 从模型 attach point 新增（位置 / 视轴 / 上向取挂点）；名字 = 挂点名；反射面焦点挂点带上自身天线的排除节点（ownAntennaNodes） */
export function mountFromAttachPoint(ap, takenIds, parts = null) {
  const taken = takenIds instanceof Set ? takenIds : new Set(takenIds || [])
  const base = String((ap && ap.name) || 'mount').replace(/_?attach_?point$/i, '') || 'mount'
  const own = ownAntennaNodes(parts, ap && ap.name)
  return defaultMount({
    ...(own.length ? { excludeNodes: own } : {}),
    id: uniqueMountId(base, taken), name: ap && ap.name ? ap.name : base, attachPoint: ap && ap.name ? ap.name : null,
    posBody: ap && isVec3(ap.posBody) ? ap.posBody.slice() : undefined,
    boresightBody: ap && isVec3(ap.dirBody) ? ap.dirBody.slice() : undefined,
    upBody: ap && isVec3(ap.upBody) && isVec3(ap.dirBody) && !isUpDegenerate(ap.dirBody, ap.upBody) ? ap.upBody.slice() : undefined
  })
}
/** 从预览点选新增：命中点为位置、面法向（朝外）为视轴、上向按 D1 缺省 */
export function mountFromHit(hit, takenIds) {
  const taken = takenIds instanceof Set ? takenIds : new Set(takenIds || [])
  const id = nextMountId(taken)
  const d = hit && isVec3(hit.normalBody) ? (unit(hit.normalBody) || [0, 0, 1]) : [0, 0, 1]
  return defaultMount({ id, name: id, attachPoint: null, posBody: hit && isVec3(hit.pointBody) ? hit.pointBody.map(r6) : undefined, boresightBody: d.map((v) => z0(r6(v))) })
}
/** 空白新增（原点、视轴天底） */
export function blankMount(takenIds) {
  const taken = takenIds instanceof Set ? takenIds : new Set(takenIds || [])
  const id = nextMountId(taken)
  return defaultMount({ id, name: id })
}
/** 复制所选（id 加 _copy 去重、名字加「 副本」；掩模签名不带过去：挂点位置一样但用户多半要改） */
export function duplicateMounts(mounts, ids) {
  const want = new Set(ids)
  const taken = new Set(mounts.map((m) => m.id))
  const out = mounts.slice()
  for (const m of mounts) {
    if (!want.has(m.id)) continue
    const c = plain(m)
    c.id = uniqueMountId(m.id + '_copy', taken); taken.add(c.id)
    c.name = (m.name || m.id) + ' 副本'
    delete c.maskSig; delete c.maskSun
    out.push(normalizeMount(c).mount)
  }
  return out
}

/** 模板目录（下拉）：{id, label, count} */
export function templateOptions() {
  return listMountTemplates().map((t) => ({ id: t.id, label: `${t.titleZh || t.title}（${t.count}）`, orbit: t.orbit, modelIds: t.modelIds }))
}
/**
 * 从模板套用：mode 'append' 追加（id 与已有的撞了自动加后缀）/ 'replace' 替换全部。返回 {mounts, attitude, matched, unmatched, errors} | null。
 * 模板挂点名在当前模型 attach point 里有同名的，位姿以模型为准（applyMountTemplate 的口径）。
 */
export function applyTemplate(id, cur, attachPoints, mode = 'append', parts = null) {
  const keep = mode === 'replace' ? [] : (Array.isArray(cur) ? cur : [])
  const r = applyMountTemplate(id, { attachPoints: attachPoints || [], existingIds: keep.map((m) => m.id) })
  if (!r) return null
  // 模板没写排除节点的反射面焦点挂点：补上自身天线（同「从 attach point 套用」）
  const added = r.mounts.map((m) => {
    if (Array.isArray(m.excludeNodes) && m.excludeNodes.length) return m
    const own = ownAntennaNodes(parts, m.attachPoint)
    return own.length ? { ...m, excludeNodes: own } : m
  })
  return { ...r, mounts: [...keep.map(plain), ...added] }
}

// ───────────────────────────── 掩模签名（D3 / D18） ─────────────────────────────
// 一张掩模属于「模型文件（lod）· 轴向 · 缩放 · 关节值 · 射线起点 · 排除名单 · 不遮挡节点」这一组输入（mask.maskSignature）。
// 分析页算完写进 mount.maskSig；之后读数 / 预览红色球面片 / 万向节查掩模一律拿【当前】这组输入重算期望签名，对得上才认 ——
// 换了绑定模型、模型页改了轴向 / 缩放 / 参数化口径、拖了关节、挪了挂点，签名对不上，旧掩模自动不认（不必逐处记得去删 maskSig）。
// ★ 与已落盘的 maskSig 逐字同式（modelSha 的 FNV-32 口径、lod 的取法都不能改），否则老掩模全部作废。

/** 模型文件指纹：该 lod 文件的 sha256 → 参数化口径 spec 的 FNV-32 → 模型 id */
export function maskModelSha(meta, lod, fallbackId = '') {
  const f = meta && meta.files && meta.files[lod]
  if (f && f.sha256) return f.sha256
  if (meta && meta.spec) { let h = 0x811c9dc5; const s = JSON.stringify(meta.spec); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return 'spec:' + h.toString(16) }
  return String((meta && meta.id) || fallbackId || '')
}
/** 掩模的 lod 口径：glb 件按载入的 lod（缺省 lod0）；参数化件（模板 / 已存参数化 / 生成页）恒 'param' */
export function maskLodOf(kind, lod) { return kind === 'glb' ? (lod || 'lod0') : 'param' }
/** 有 stage 的关节 → 完整关节值（没动过的取 initialValue，再没有取 0）；vals：关节名 → 各 stage 值 */
export function articulationStateOf(meta, vals) {
  const o = {}
  for (const a of meta && Array.isArray(meta.articulations) ? meta.articulations : []) {
    if (!a || !Array.isArray(a.stages) || !a.stages.length) continue
    const v = vals && Array.isArray(vals[a.name]) ? vals[a.name] : null
    o[a.name] = a.stages.map((s, i) => (v && isNum(v[i]) ? v[i] : (isNum(s.initialValue) ? s.initialValue : 0)))
  }
  return o
}
/**
 * 掩模签名：model = {meta, kind, lod, id}（工作台当前模型），mount 取 posBody / boresightBody / excludeNodes，art = articulationStateOf 的结果。
 * @param {number|null} [sunBin] 对日扫描档号（0…11）；主掩模 null
 */
export function maskSigFor(model, mount, art, sunBin = null) {
  const meta = (model && model.meta) || {}
  return maskSignature({
    modelSha: maskModelSha(meta, model && model.lod, model && model.id), lod: maskLodOf(model && model.kind, model && model.lod),
    frame: meta.frame, scaleToMeters: meta.units && meta.units.scaleToMeters,
    articulations: art, mountPos: mount.posBody, mountBoresight: mount.boresightBody, excludeNodes: mount.excludeNodes,
    noObscurationNodes: meta.noObscurationNodes, sunBin
  })
}

// ───────────────────────────── JSON 进出 ─────────────────────────────

/** 挂点表 → JSON 文本（纯 mounts 数组，带 schema 标记，别处读回也认） */
export function mountsToJson(mounts, extra = {}) {
  return JSON.stringify({ kind: 'satsim.mounts', version: 1, ...extra, mounts: plain(mounts || []) }, null, 2)
}
/**
 * JSON 文本 → mounts（认三种：{mounts:[…]}、裸数组、整条绑定 {model, mounts, attitude}）。逐条 normalizeMount、id 去重。
 * 返回 {mounts, attitude?, errors}；整份读不出返回 {mounts:null, errors:[原因]}。
 */
export function mountsFromJson(text, takenIds = []) {
  let j
  try { j = JSON.parse(String(text || '')) } catch (e) { return { mounts: null, errors: ['不是 JSON：' + ((e && e.message) || e)] } }
  const arr = Array.isArray(j) ? j : (isObj(j) && Array.isArray(j.mounts) ? j.mounts : null)
  if (!arr) return { mounts: null, errors: ['没有 mounts 数组'] }
  const errors = []
  const taken = new Set(takenIds)
  const out = []
  arr.forEach((m, i) => {
    const r = normalizeMount(m, { path: `mounts[${i}]`, errors, fallbackId: nextMountId(taken) })
    if (!r.mount) return
    if (taken.has(r.mount.id)) r.mount.id = uniqueMountId(r.mount.id, taken)
    taken.add(r.mount.id)
    out.push(r.mount)
  })
  const res = { mounts: out, errors }
  if (isObj(j) && isObj(j.attitude)) res.attitude = normalizeAttitude(j.attitude, { errors }).attitude
  return res
}

// ───────────────────────────── 姿态律表单 ─────────────────────────────

export const LAW_LABEL = { nadir: '对地（nadir）', yawSteer: '偏航导引（yaw steering）', sun: '对日（sun）', inertial: '惯性（inertial）', target: '指向目标（target）' }
export const LAWS = ATTITUDE_LAWS
export const AXIS_OPTIONS = [
  { key: '+X', v: [1, 0, 0] }, { key: '-X', v: [-1, 0, 0] }, { key: '+Y', v: [0, 1, 0] },
  { key: '-Y', v: [0, -1, 0] }, { key: '+Z', v: [0, 0, 1] }, { key: '-Z', v: [0, 0, -1] }
]
/** 本体轴向量 → '+X' … 的写法（非坐标轴返回 ''） */
export function axisKeyOf(v) {
  if (!isVec3(v)) return ''
  const o = AXIS_OPTIONS.find((a) => Math.abs(dot(a.v, v) - 1) < 1e-9)
  return o ? o.key : ''
}
export const SECONDARY_LABEL = { nadir: '对地', velocity: '速度', sun: '太阳', orbitNormal: '轨道法向' }
