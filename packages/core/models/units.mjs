// 单位推断与已知尺寸反算（任务书 §5.3；设计契约 T7）。
//
// 为什么需要：模型文件的「1 个单位」是多少米没有统一答案——Maya 默认厘米、3ds Max 默认英寸（通用单位）、
// Blender 与 glTF 导出器是米、STEP 多为毫米；NASA 的美术模型更是各不相同（例：SSL-1300 夹具最长边 268.33 单位，
// 按已知翼展约 24 m 反算是 0.089 m/单位，不是任何标准单位——任务书说它是英尺，实测不成立，见 modelUnits 单测）。
// 单位错了，挂点、质量特性、跟随视图里的真实比例全错，所以每个模型都要带 unitGuess + 可信度，
// sizeVerified 只在有出处时为 true（由调用方根据出处决定，这里只给推断）。
//
// 优先级（任务书 §5.3 原文）：STEP 头 > extras.satsim.units > 已知尺寸反算 > 包围盒量级。
// 另两条导出器线索（Maya OBJ 首行写 centimeters；3ds Max 英寸；FBX 的 UnitScaleFactor）排在「已知尺寸」之后、
// 「包围盒量级」之前：它们说的是软件设置，不是这颗星的真实尺寸。
//
// 导出：
//   UNIT_SCALE, UNIT_LIST
//   INFER_SNAP
//   scaleFromKnownDim({measuredModelUnits, knownMeters, snapTolerance}) → {ok, scaleToMeters, rawScale, unitGuess, snapped, relErr, nearest} | {ok:false, error}
//   guessUnits({bboxSpanModelUnits, sourceFormat, headerHints}) → {unitGuess, scaleToMeters, confidence, rule, notes}
//   objHeaderUnit(text), stepLengthUnit(text)

/** 每种单位 → 米。 */
export const UNIT_SCALE = Object.freeze({ m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 })
export const UNIT_LIST = Object.freeze(['m', 'cm', 'mm', 'in', 'ft'])

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// 自动推断（guessUnits 的「已知尺寸」一档）的吸附窗口：比值离某个标准单位不到 10% 就当作者用的就是那个单位。
// 只用在「尺寸是粗略公开值、要猜作者单位」的场合；几个标准单位彼此相距都在 2.5 倍以上（in↔cm 2.54 倍最近），
// 10% 的窗口不会同时落进两个。
export const INFER_SNAP = 0.1
// 比值与标准单位只差浮点尾数时仍认作该单位（24.5 / 80.38… 这种算出来的 0.30480000000000002）
const EXACT_REL = 1e-9

/**
 * 已知尺寸反算：用户说「翼展 26 m」，工具量出模型对应长度 80 单位 → scaleToMeters = 26 / 80。
 * ★ 缺省**不吸附**（snapTolerance = 0）：这是工作台「反算」按钮的口径——用户给的是带出处的尺寸，结果必须照它，
 *   吸附到英尺会把 26 m 变成 24.38 m（−6.2%），sizeVerified 为 true 时「已核定尺寸」就和出处对不上了。
 *   要按标准单位吸附（离线管线 / 自动推断）显式传 snapTolerance（如 INFER_SNAP）。
 * 返回：
 *   scaleToMeters  吸附了是标准单位的值，否则 = rawScale；
 *   unitGuess      scaleToMeters 取的是某个标准单位时为该单位，否则 'unknown'；
 *   snapped        scaleToMeters 是否取了标准单位的值（= unitGuess !== 'unknown'；比值本就精确等于标准单位时也为 true，
 *                  与离线管线 build.mjs snapScale 的同名字段同义）；
 *   relErr         原比值离最近标准单位的相对误差（> 0 且 snapped 时，结果与用户给的尺寸差这么多）；
 *   nearest        {unitGuess, scaleToMeters, relErr}：最近的标准单位——界面可以把「按 ft 吸附（差 6.2%）」作为选项给用户挑。
 */
export function scaleFromKnownDim({ measuredModelUnits, knownMeters, snapTolerance = 0 } = {}) {
  if (!isNum(measuredModelUnits) || measuredModelUnits <= 0) return { ok: false, error: '模型量得的长度须为正数' }
  if (!isNum(knownMeters) || knownMeters <= 0) return { ok: false, error: '已知尺寸须为正数（米）' }
  const raw = knownMeters / measuredModelUnits
  if (!(Number.isFinite(raw) && raw > 0)) return { ok: false, error: '比值超出数值范围' }
  let best = null
  for (const u of UNIT_LIST) {
    const rel = Math.abs(raw / UNIT_SCALE[u] - 1)
    if (!best || rel < best.rel) best = { u, rel }
  }
  const nearest = { unitGuess: best.u, scaleToMeters: UNIT_SCALE[best.u], relErr: best.rel }
  const tol = isNum(snapTolerance) && snapTolerance >= 0 ? Math.max(snapTolerance, EXACT_REL) : EXACT_REL
  if (best.rel <= tol) return { ok: true, scaleToMeters: UNIT_SCALE[best.u], rawScale: raw, unitGuess: best.u, snapped: true, relErr: best.rel, nearest }
  return { ok: true, scaleToMeters: raw, rawScale: raw, unitGuess: 'unknown', snapped: false, relErr: best.rel, nearest }
}

/**
 * OBJ 文件头注释里的单位线索（只看前 20 行注释）。
 *   Maya：「# This file uses centimeters as units for non-parametric coordinates.」→ cm
 *   3ds Max：「# 3ds Max Wavefront OBJ Exporter …」→ in（Max 出厂的系统单位是英寸）
 *   其余写明 meters / millimeters / inches / feet 的照写。找不到返回 null。
 */
export function objHeaderUnit(text) {
  if (typeof text !== 'string') return null
  const lines = text.slice(0, 4096).split(/\r?\n/).slice(0, 20).filter((l) => /^\s*#/.test(l))
  for (const l of lines) {
    const s = l.toLowerCase()
    const m = /uses\s+(centimeters|millimeters|meters|inches|feet|foot|inch)\b/.exec(s) || /units?\s*[:=]\s*(centimeters?|millimeters?|meters?|inches|inch|feet|foot|cm|mm|m|in|ft)\b/.exec(s)
    if (m) return wordToUnit(m[1])
  }
  for (const l of lines) if (/3ds\s*max/i.test(l)) return 'in'
  return null
}

function wordToUnit(w) {
  const s = String(w).toLowerCase()
  if (/^(centimeters?|cm)$/.test(s)) return 'cm'
  if (/^(millimeters?|mm)$/.test(s)) return 'mm'
  if (/^(meters?|m)$/.test(s)) return 'm'
  if (/^(inches|inch|in)$/.test(s)) return 'in'
  if (/^(feet|foot|ft)$/.test(s)) return 'ft'
  return null
}

/**
 * STEP 文件的长度单位（给界面显示「文件单位」用；几何本身由 OCCT 按 linearUnit:'meter' 换好，见 T7）。
 * 认 SI_UNIT(.MILLI.,.METRE.) / SI_UNIT(.CENTI.,.METRE.) / SI_UNIT($,.METRE.) 与 CONVERSION_BASED_UNIT('INCH'|'FOOT',…)。
 * 只扫前 2 MB 文本（单位实体在 DATA 段靠前）；找不到返回 null。
 */
export function stepLengthUnit(text) {
  if (typeof text !== 'string') return null
  const s = text.slice(0, 2 * 1024 * 1024).toUpperCase()
  // 英制文件的写法是 CONVERSION_BASED_UNIT('INCH', #n)，而 #n 的换算基准里还会出现一条 SI_UNIT(.MILLI.,.METRE.)——
  // 所以先认换算单位，再认 SI；否则英寸文件会被误判成毫米
  const c = /CONVERSION_BASED_UNIT\s*\(\s*'(INCH|INCHES|FOOT|FEET)'/.exec(s)
  if (c) return c[1].startsWith('INCH') ? 'in' : 'ft'
  // .METRE. 只会出现在长度单位上（面积 / 体积是导出单位，另有写法），不用担心被角度单位带偏
  const m = /SI_UNIT\s*\(\s*(\.[A-Z]+\.|\$)\s*,\s*\.METRE\.\s*\)/.exec(s)
  if (!m) return null
  if (m[1] === '$') return 'm'
  if (m[1] === '.MILLI.') return 'mm'
  if (m[1] === '.CENTI.') return 'cm'
  return null // 千米 / 微米等不在单位表里，交给包围盒规则
}

/**
 * 按包围盒最大边的量级猜（任务书 §5.3 末档）：
 *   0.3–300 → 米；300–3000 → 厘米（得 3–30 m，GEO 通信星的量级）；3000–300000 → 毫米（得 3–300 m）；
 *   < 0.3 或 > 300000 → unknown（不缩放，留给人判断——0.1 m 的 1U 立方星按米也说得通，别擅自放大）。
 * 300–3000 为何选厘米不选毫米：两种都可能，但厘米给出的 3–30 m 正是卫星最常见的尺寸，毫米给出 0.3–3 m；
 * 本来就是 low 可信度，选更常见的那个。
 */
function bboxRule(span) {
  if (!isNum(span) || span <= 0) return { unitGuess: 'unknown', scaleToMeters: 1, confidence: 'low', rule: 'none', notes: ['没有可用的包围盒'] }
  if (span >= 0.3 && span <= 300) return { unitGuess: 'm', scaleToMeters: 1, confidence: 'low', rule: 'bbox', notes: [`最大边 ${fmt(span)} 单位，按米`] }
  if (span > 300 && span < 3000) return { unitGuess: 'cm', scaleToMeters: 0.01, confidence: 'low', rule: 'bbox', notes: [`最大边 ${fmt(span)} 单位，按厘米`] }
  if (span >= 3000 && span <= 300000) return { unitGuess: 'mm', scaleToMeters: 0.001, confidence: 'low', rule: 'bbox', notes: [`最大边 ${fmt(span)} 单位，按毫米`] }
  return { unitGuess: 'unknown', scaleToMeters: 1, confidence: 'low', rule: 'bbox', notes: [`最大边 ${fmt(span)} 单位，量级不在任何常见单位的卫星尺寸范围内`] }
}
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toPrecision(3)).toString())

/**
 * 单位推断。
 * @param {object} p
 * @param {number} [p.bboxSpanModelUnits]  包围盒最大边（模型单位）
 * @param {string} [p.sourceFormat]        'step'|'iges'|'brep'|'obj'|'stl'|'fbx'|'glb'|'param'
 * @param {object} [p.headerHints]
 *   stepUnit            STEP 头里的长度单位（stepLengthUnit 的结果）
 *   convertedToMeters   几何已由 OCCT 换成米（缺省 true：T7 规定 linearUnit:'meter'）
 *   satsimUnits         glb extras.satsim.units（{scaleToMeters, unitGuess, sizeVerified?}）
 *   knownDim            {measuredModelUnits, knownMeters, source?, snapTolerance?}：已知尺寸（吸附窗口缺省 INFER_SNAP）
 *   objHeader           OBJ 文件前几行原文（或直接给 objUnit）
 *   objUnit             已解析的 OBJ 单位
 *   fbxUnitScaleFactor  FBX GlobalSettings.UnitScaleFactor（每单位多少厘米）
 *   generator           glTF asset.generator（含「3ds Max」时按英寸作线索）
 * @returns {{unitGuess:string, scaleToMeters:number, confidence:'high'|'medium'|'low', rule:string, notes:string[]}}
 *   rule ∈ 'step-header' | 'satsim' | 'known-dim' | 'exporter' | 'bbox' | 'none'
 */
export function guessUnits(p = {}) {
  const o = isObj(p) ? p : {}
  const h = isObj(o.headerHints) ? o.headerHints : {}
  const fmtIn = typeof o.sourceFormat === 'string' ? o.sourceFormat.toLowerCase() : ''
  const span = o.bboxSpanModelUnits

  // ① STEP / IGES / BREP 头
  if (['step', 'stp', 'iges', 'igs', 'brep'].includes(fmtIn)) {
    const fileUnit = UNIT_LIST.includes(h.stepUnit) ? h.stepUnit : null
    if (h.convertedToMeters !== false) {
      // OCCT 已按文件头换成米：几何就是米，文件单位只作说明
      return { unitGuess: 'm', scaleToMeters: 1, confidence: 'high', rule: 'step-header', notes: [fileUnit ? `文件单位 ${fileUnit}，已由 OCCT 换算为米` : '已由 OCCT 换算为米'] }
    }
    if (fileUnit) return { unitGuess: fileUnit, scaleToMeters: UNIT_SCALE[fileUnit], confidence: 'high', rule: 'step-header', notes: [`STEP 头声明 ${fileUnit}`] }
  }

  // ② extras.satsim.units（本平台导出过的模型：上次标定的结果）
  const su = h.satsimUnits
  if (isObj(su) && isNum(su.scaleToMeters) && su.scaleToMeters > 0) {
    const ug = UNIT_LIST.includes(su.unitGuess) ? su.unitGuess : 'unknown'
    return { unitGuess: ug, scaleToMeters: su.scaleToMeters, confidence: su.sizeVerified === true ? 'high' : 'medium', rule: 'satsim', notes: ['沿用 extras.satsim.units'] }
  }

  // ③ 已知尺寸反算。这一档是「自动推断作者单位」，公开尺寸本身常是约数（「超过 24 m」），所以缺省按 INFER_SNAP 吸附；
  //    调用方要照尺寸原值（工作台用户手填的带出处尺寸）就在 knownDim 里给 snapTolerance: 0，或直接调 scaleFromKnownDim。
  if (isObj(h.knownDim)) {
    const kd = h.knownDim
    const r = scaleFromKnownDim({
      measuredModelUnits: kd.measuredModelUnits,
      knownMeters: kd.knownMeters,
      snapTolerance: isNum(kd.snapTolerance) && kd.snapTolerance >= 0 ? kd.snapTolerance : INFER_SNAP
    })
    if (r.ok) {
      const src = typeof h.knownDim.source === 'string' && h.knownDim.source.trim()
      const notes = [`已知 ${fmt(h.knownDim.knownMeters)} m ↔ 模型 ${fmt(h.knownDim.measuredModelUnits)} 单位，比值 ${r.rawScale.toPrecision(4)}` + (r.snapped ? `，取 ${r.unitGuess}（偏差 ${(r.relErr * 100).toFixed(1)}%）` : '')]
      // 可信度：有出处 + 吸附到标准单位 → high；缺一个 → medium
      return { unitGuess: r.unitGuess, scaleToMeters: r.scaleToMeters, confidence: src && r.snapped ? 'high' : 'medium', rule: 'known-dim', notes }
    }
  }

  // ④ 导出器线索
  let exp = null
  if (fmtIn === 'obj') {
    const u = UNIT_LIST.includes(h.objUnit) ? h.objUnit : objHeaderUnit(h.objHeader)
    if (u) exp = { u, why: `OBJ 文件头指向 ${u}` }
  }
  if (!exp && fmtIn === 'fbx' && isNum(h.fbxUnitScaleFactor) && h.fbxUnitScaleFactor > 0) {
    const s = h.fbxUnitScaleFactor * 0.01
    const near = UNIT_LIST.find((u) => Math.abs(s / UNIT_SCALE[u] - 1) < 1e-6)
    exp = { u: near || 'unknown', scale: s, why: `FBX UnitScaleFactor = ${h.fbxUnitScaleFactor}` }
  }
  if (!exp && typeof h.generator === 'string' && /3ds\s*max/i.test(h.generator)) exp = { u: 'in', why: 'generator 为 3ds Max' }
  if (exp) {
    const scale = exp.scale ?? UNIT_SCALE[exp.u]
    // 导出器说的是软件设置；若换算后尺寸明显不像航天器（< 5 cm 或 > 500 m），降为 low
    const meters = isNum(span) && span > 0 ? span * scale : null
    const plausible = meters === null || (meters >= 0.05 && meters <= 500)
    return { unitGuess: exp.u, scaleToMeters: scale, confidence: plausible ? 'medium' : 'low', rule: 'exporter', notes: [exp.why + (meters !== null ? `，最大边 ${fmt(meters)} m` : '')] }
  }

  // ⑤ 包围盒量级
  return bboxRule(span)
}
