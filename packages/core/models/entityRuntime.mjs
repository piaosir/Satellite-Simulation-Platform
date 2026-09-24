// 实体运行时（P4「实体上球」：DESIGN3 E7–E11、§1 P4；A3 SPEC §1.8 / §11-7 / §12；三路契约 §1 / §2.2）。
// 纯 ESM、零 three、node 可测。给 3D 页 / 侧栏 / entityLayer / flatCoverage 共用的纯逻辑：
//
//   ① 键与字段：实体键 'st:' / 'pt:' / 'tr:' + id（与链路预算 CityPicker、可见性的前缀同族）；标记对象上的内联字段
//      s.model = {id, px?}、s.track = {kind:'sat', satKey}（缺字段 = focus）、p.model、t.model / cruiseAltM / speedKmh / t0Ms。
//      ★ 缺省值一律不写进对象（normTrajMotion 删等于 10668 的 cruiseAltM）；sanitizeMarkers 只删非法字段、从不补字段、不动其它字段
//        （老存档过它后与原对象深相等）。绑定不进 models.bindings.json（那张表的键只认 norad/ephem/cc/lbsat/grdsat/name）。
//   ② 航迹：trajMoving = 运动档（t0Ms + speedKmh，或航点时刻钉点排得出程；且全程非零长 —— 与 trajKinematics.trajEndMs 同一判据）；
//      航点级 tMs / altM 由 sanitizeMarkers 只删非法值；运动档航迹线 = 大圆 0.5° 加密
//      （densifyGreatCircle，与载具运动同一条大圆）；静止档返回 null → 渲染端走现有画线（逐像素不变，契约 §7-1）。
//   ③ Excel 航迹说明行：「飞行; 巡航高度=10668 m; 速度=850 km/h; 起始=2026-09-24T08:00:00Z; 模型=ent:a320neo; 图标=48 px」。
//      第一段仍是类型词（老导入器照样认类型）；解析容全角 / 单位 / 键别名；非法值静默丢弃（Excel 是用户手改的文件）。
//      只有识别出「键=值」段时，类型才按其余自由文本判；一个都没识别出时按整串判——与 useMarkerTable.trajKindOf 逐字同式，老说明行结果不变。
//   ④ 模型锚点（A3 SPEC §11-7）：有 `<根id>_datum` 挂点用它（船 = 水线 ∩ 船中 ∩ 中线；飞机 = 机身轴线半长处；车 = 地面 ∩ 两轴中点）；
//      没有 datum：挂到飞机上 → 包围盒中心，其余 → 包围盒底（x / y 取 boresight 挂点 = 方位轴，没有取盒心）。
//      飞机的离地保护 liftM = 盒底到锚点的距离（本体 +Z 向下）：渲染端有效高度 = max(altM, liftM)，起降点机腹落地而不是埋进地里。
//   ⑤ 可指向天线（A3 SPEC §1.8：boresight 挂点 + azimuth / elevation 两级关节，或 X-Y 座 xAxis / yAxis）：挂点系 = attitude.mountFrame
//      （z = 视轴零位、y = 方位轴 up、x = y × z）；本体视线投到挂点系 → gimbal 主解 → 限位内离上一次最近的一组（主解 / 翻转解 + 360° 整数倍，
//      与 gimbal.pickSolution 逐位同式）；keyhole（视线 ∥ 方位轴）方位沿用上一次；az-el 座目标俯仰低于下限 → 预指向（方位对准、俯仰夹到下限，
//      真实 ACU 的等待姿态，编排者裁定 §8-4）；其余无解保持上一次（held）。
//      ★ 物理口径：az-el 座正过顶（仰角上限 ≤ 90°）必须在天顶两侧转 180° 方位——这是 keyhole 本身，不是算法跳变；X-Y 座过顶连续。
//   ⑥ 地球站跟踪目标：候选里挑 WGS-84 仰角最高的（滞回 0.5°；上一次的目标已落地平而别的星可见时不滞回）；读数 = stationTrackAzEl（WGS-84），
//      画面 = stationAimScene（星场景锚点 − 站场景锚点，站锚点 r = 1 + altM / 6371 km）——两者差 ≤ 0.2°（entityPose 头注实测）。
//   ⑦ 载具：vehicleStateAt = trajStateAt 薄包装；aheadPoint 给 2D 运动档载具的屏幕朝向；shadeOf = 当地太阳高度角压暗系数（与 modelLayer
//      晨昏口径同：sunLit 关 = 全亮 1；开 = 0.5 + 0.5·smoothstep(−6°, +0.8°, 太阳高度角)）。
//
// ── 热路径（每拍 / 每帧）──
//   pickTrackTarget / solveAim / parkAim / jointValuesOf / aheadPoint / shadeOf / vehicleStateAt：复用 out 即无显式分配。
//   写法同 entityPose / trajKinematics：double 不当实参往未内联的内部函数传（调用边界会装箱），暂存放模块级数组；gimbal 的
//   solveAzEl / solveXY（主解）与 pickSolution（限位内选解）在这里逐字复写成读暂存的 primaryInto / pickInto（结果逐位相同，单测对拍）——
//   gimbal.mjs 是口径的唯一出处，改那边的式子要同步改这里。
//
// 导出：
//   常量 ENT_PX_MIN / ENT_PX_MAX / ENT_KINDS / TRACK_HYST_DEG / ENT_FADE_S / SUN_ELEV_DARK_DEG / SUN_ELEV_LIT_DEG / SHADE_FLOOR /
//        CRUISE_ALT_M_MAX / SPEED_KMH_MAX / T0_MS_MIN / T0_MS_MAX（另转出 trajKinematics 的 CRUISE_ALT_M_DEFAULT / GC_STEP_DEG / makeTrajState）
//   键与字段 entityKey / parseEntityKey / normEntityModel / resolveEntityPx / normTrack / normTrajMotion / sanitizeMarkers /
//        trajMoving / trajEntityKind / trajLinePts
//   Excel / 时间 trajNoteOf / parseTrajNote / parseDateTimeText / partsToUtcMs / formatUtcIso
//   锚点 makeAnchor / anchorBodyOf
//   天线 aimRigOf / makeAimState / solveAim / parkAim / jointValuesOf
//   跟踪 makeTrackState / pickTrackTarget
//   载具 / 光照 vehicleStateAt / aheadPoint / shadeOf

import { trajStateAt, trajEndMs, densifyGreatCircle, makeTrajState, CRUISE_ALT_M_DEFAULT, GC_STEP_DEG } from './trajKinematics.mjs'
import { makeStationLook, stationTrackAzEl, stationAimScene } from './entityPose.mjs'
import { mountFrame } from './attitude.mjs'
import { parseModelId, isValidSatKey } from './schema.mjs'

export { makeTrajState, CRUISE_ALT_M_DEFAULT, GC_STEP_DEG }

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const fin = Number.isFinite
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isVec3 = (v) => v != null && (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length >= 3 && fin(v[0]) && fin(v[1]) && fin(v[2])

// ─────────────────────────────── 常量 ───────────────────────────────

/** 实体模型图标像素（屏幕恒定，= 模型包围半径的屏幕像素 × 2）的取值范围，与卫星模型「图标大小」滑杆同。 */
export const ENT_PX_MIN = 8, ENT_PX_MAX = 256
/** 挂载目标类别（锚点口径按它，不按模型类别）。航迹载具 = trajEntityKind(t)。 */
export const ENT_KINDS = Object.freeze(['station', 'point', 'aircraft', 'ship', 'vehicle'])
/** 地球站跟踪目标的换星滞回（度）。 */
export const TRACK_HYST_DEG = 0.5
/** 实体模型出现 / 消失 / 换模型的淡化时长（s）：与 modelLayer FADE_S 同值（渲染端用）。 */
export const ENT_FADE_S = 0.3
/** 当地太阳高度角压暗过渡带（度）：−6°（民用晨昏蒙影下限）起亮，+0.8°（日面上缘出地平一带）全亮。 */
export const SUN_ELEV_DARK_DEG = -6, SUN_ELEV_LIT_DEG = 0.8
/** 夜侧压暗下限：= modelLayer ICON_ECL_FLOOR（暗面不能黑到看不清）。 */
export const SHADE_FLOOR = 0.5
/** 航迹巡航高度 / 地速的合法上限（m、km/h）。 */
export const CRUISE_ALT_M_MAX = 30000, SPEED_KMH_MAX = 5000
/** 起始时刻合法范围（UTC ms）：0000-01-01T00:00:00Z … 9999-12-31T23:59:59.999Z（Excel 说明行的四位年能往返）。 */
export const T0_MS_MIN = -62167219200000, T0_MS_MAX = 253402300799999

// ─────────────────────────────── 键与字段 ───────────────────────────────

const KEY_PREFIX = new Map([['station', 'st:'], ['point', 'pt:'], ['traj', 'tr:'], ['aircraft', 'tr:'], ['ship', 'tr:'], ['vehicle', 'tr:']])
const KEY_KIND = new Map([['st', 'station'], ['pt', 'point'], ['tr', 'traj']])
const KEY_RE = /^(st|pt|tr):([\s\S]+)$/

/**
 * 实体键：'station' → 'st:'、'point' → 'pt:'、'traj'（及载具类别 aircraft / ship / vehicle）→ 'tr:'，后接 id。
 * @returns {string|null} 类别未知或 id 为空时 null
 */
export function entityKey(kind, id) {
  const p = KEY_PREFIX.get(kind)
  if (!p || id === null || id === undefined || id === '') return null
  return p + String(id)
}
/** 'st:<id>' / 'pt:<id>' / 'tr:<id>' → {kind:'station'|'point'|'traj', id}；其它 null。 */
export function parseEntityKey(key) {
  if (typeof key !== 'string') return null
  const m = KEY_RE.exec(key)
  return m ? { kind: KEY_KIND.get(m[1]), id: m[2] } : null
}

const okPx = (v) => typeof v === 'number' && Number.isInteger(v) && v >= ENT_PX_MIN && v <= ENT_PX_MAX
const okModelId = (id) => typeof id === 'string' && parseModelId(id) !== null
const okCruise = (v) => typeof v === 'number' && fin(v) && v >= 0 && v <= CRUISE_ALT_M_MAX
const okSpeed = (v) => typeof v === 'number' && fin(v) && v > 0 && v <= SPEED_KMH_MAX
const okT0 = (v) => typeof v === 'number' && fin(v) && v >= T0_MS_MIN && v <= T0_MS_MAX
const clampPx = (r) => (r < ENT_PX_MIN ? ENT_PX_MIN : (r > ENT_PX_MAX ? ENT_PX_MAX : r))

/**
 * 模型字段归一：→ {id} | {id, px} | null。id 须过 schema.parseModelId（param / ent / asm / user / nasa / stk / community 前缀都认）；
 * px 为有限数时取整并夹到 8–256，不是数就丢掉。也收裸 id 字符串。
 */
export function normEntityModel(v) {
  if (typeof v === 'string') return okModelId(v) ? { id: v } : null
  if (!isObj(v) || !okModelId(v.id)) return null
  const px = v.px
  return typeof px === 'number' && fin(px) ? { id: v.id, px: clampPx(Math.round(px)) } : { id: v.id }
}
/** 实体图标像素：model.px（合法时）优先，否则全局 defPx（卫星「图标大小」滑杆），夹 8–256 取整；都不是数时 28（出厂缺省）。 */
export function resolveEntityPx(model, defPx) {
  const p = model && typeof model.px === 'number' && fin(model.px) ? model.px : (typeof defPx === 'number' && fin(defPx) ? defPx : 28)
  return clampPx(Math.round(p))
}
/**
 * 跟踪字段归一：{kind:'sat', satKey（过 schema.isValidSatKey）, el?} → 新对象；其余（含 {kind:'focus'}）→ null（= focus，不写进对象）。
 * el = true：站标签的仰角改读这颗星（缺省 = 旧口径，聚焦集最高仰角）；非 true 不写。
 */
export function normTrack(v) {
  if (!isObj(v) || v.kind !== 'sat' || !isValidSatKey(v.satKey)) return null
  const o = { kind: 'sat', satKey: v.satKey }
  if (v.el === true) o.el = true
  if (v.az === true) o.az = true
  return o
}

// 删掉非法的航迹运动字段（不删合法的缺省值）
function dropBadMotion(t) {
  if (has(t, 'cruiseAltM') && !okCruise(t.cruiseAltM)) delete t.cruiseAltM
  if (has(t, 'speedKmh') && !okSpeed(t.speedKmh)) delete t.speedKmh
  if (has(t, 't0Ms') && !okT0(t.t0Ms)) delete t.t0Ms
}
/**
 * 就地删掉航迹 t 上非法的 cruiseAltM（非有限 / < 0 / > 30000）、speedKmh（非有限 / ≤ 0 / > 5000）、t0Ms（非有限 / 超出四位年），
 * 以及等于缺省 10668 的 cruiseAltM（缺省值不写进对象）。航行航迹上的 cruiseAltM 不删（被忽略；切回飞行还在）。返回 t。
 */
export function normTrajMotion(t) {
  if (!isObj(t)) return t
  dropBadMotion(t)
  if (has(t, 'cruiseAltM') && t.cruiseAltM === CRUISE_ALT_M_DEFAULT) delete t.cruiseAltM
  return t
}
// 删掉非法的 model（坏 id / 不是对象）与越界 / 非整数的 model.px；model 里别的键不动
function dropBadModel(o) {
  if (!has(o, 'model')) return
  const m = o.model
  if (!isObj(m) || !okModelId(m.id)) { delete o.model; return }
  if (has(m, 'px') && !okPx(m.px)) delete m.px
}
/**
 * loadMarkers 用：就地清 {points, stations, trajectories} 三类对象上的非法新字段（坏 model / px 越界 / 坏 track / 非法运动字段），
 * 从不补字段、不动其它字段（合法的 cruiseAltM = 10668 也留着）；老存档（无新字段）过它后与原对象深相等。返回 d。
 */
export function sanitizeMarkers(d) {
  if (!isObj(d)) return d
  const { points, stations, trajectories } = d
  if (Array.isArray(points)) for (const p of points) if (isObj(p)) dropBadModel(p)
  if (Array.isArray(stations)) {
    for (const s of stations) {
      if (!isObj(s)) continue
      dropBadModel(s)
      if (has(s, 'track') && !normTrack(s.track)) delete s.track
    }
  }
  if (Array.isArray(trajectories)) for (const t of trajectories) if (isObj(t)) { dropBadModel(t); dropBadMotion(t); dropBadWaypoints(t) }
  return d
}
/** 航点高度钉点的合法范围（m）：−1000（低于海平面的机场 / 死海）… 30000（与巡航高度同上限）。 */
export const WP_ALT_M_MIN = -1000
const okWpAlt = (v) => typeof v === 'number' && fin(v) && v >= WP_ALT_M_MIN && v <= CRUISE_ALT_M_MAX
// 航点级字段（2026-09-24 航迹表格）：时刻钉点 tMs（同 t0Ms 的四位年范围）、高度钉点 altM；非法值删掉，其余字段不动
function dropBadWaypoints(t) {
  if (!Array.isArray(t.pts)) return
  for (const p of t.pts) {
    if (!isObj(p)) continue
    if (has(p, 'tMs') && !okT0(p.tMs)) delete p.tMs
    if (has(p, 'altM') && !okWpAlt(p.altM)) delete p.altM
  }
}

/**
 * 运动档：= Number.isFinite(trajEndMs(t))，与 trajStateAt 的 moving 同一条件 —— t0Ms 有限 + speedKmh > 0，
 * 或航点带时刻钉点且排程成立（trajKinematics 文件头「时刻钉点」）；且全程非零长。
 */
export function trajMoving(t) { return fin(trajEndMs(t)) }
/** 航迹载具的挂载类别：飞行 → 'aircraft'，其余 → 'ship'。 */
export function trajEntityKind(t) { return t && t.kind === 'flight' ? 'aircraft' : 'ship' }
/** 运动档航迹线：大圆 0.5° 加密的新点列；静止档 null（渲染端走现有画线，逐像素不变）。 */
export function trajLinePts(t) { return trajMoving(t) ? densifyGreatCircle(t.pts) : null }

// ─────────────────────────────── Excel 说明行 / 时间文本 ───────────────────────────────

const TYPE_RE = /飞行|flight/i                                                 // 与 useMarkerTable.trajKindOf 同式
const DASH_RE = /[−–—―﹣]/g
const SEG_RE = /^\s*([^=:]+?)\s*[=:]\s*(.*?)\s*$/
const NUM = '\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?'
const ALT_RE = new RegExp(`^([+-]?${NUM})\\s*(m|米|km|千米|公里|ft|feet|英尺)?$`, 'i')
const FL_RE = /^fl\s*(\d{1,3})$/i
const SPD_RE = new RegExp(`^(${NUM})\\s*(km/h|kmh|kph|公里/小时|千米/小时|kn|kt|kts|knot|knots|节|m/s|米/秒|mph)?$`, 'i')
const PX_RE = /^(\d{1,3})\s*(px)?$/i
const DT_RE = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?\s*(z|utc|gmt|[+-]\d{2}(?::?\d{2})?)?\s*$/i
const FT_M = 0.3048, KN_KMH = 1.852, MS_KMH = 3.6, MPH_KMH = 1.609344
// 单位换算后的值抹掉浮点尾数（µm / µ(km/h) 级）：FL350 → 10668、450 kn → 833.4
const round6 = (v) => Math.round(v * 1e6) / 1e6

const FIELD_OF = new Map()
for (const k of ['巡航高度', '巡航', '高度', 'cruise', 'cruisealt', 'cruisealtitude', 'alt', 'altitude']) FIELD_OF.set(k, 'cruiseAltM')
for (const k of ['速度', '航速', '地速', 'speed', 'groundspeed', 'gs']) FIELD_OF.set(k, 'speedKmh')
for (const k of ['起始', '起始时刻', '出发', '出发时刻', '起飞', '起飞时刻', '开始', 'start', 't0', 'departure']) FIELD_OF.set(k, 't0Ms')
for (const k of ['模型', 'model']) FIELD_OF.set(k, 'model')
for (const k of ['图标', '图标大小', 'icon', 'iconpx']) FIELD_OF.set(k, 'px')

// 归一：NFKC（全角数字 / ＝ / ： / ； / ／ 变半角）+ 各种横线 → '-' + 中文句号 → '.'
const normText = (s) => String(s ?? '').normalize('NFKC').replace(DASH_RE, '-').replace(/。/g, '.')

function altOf(v) {
  let m = ALT_RE.exec(v)
  if (m) {
    const x = Number(m[1]), u = (m[2] || 'm').toLowerCase()
    const r = u === 'm' || u === '米' ? x : (u === 'km' || u === '千米' || u === '公里' ? round6(x * 1000) : round6(x * FT_M))
    return okCruise(r) ? r : null
  }
  m = FL_RE.exec(v)
  if (m) { const r = round6(Number(m[1]) * 100 * FT_M); return okCruise(r) ? r : null }
  return null
}
function speedOf(v) {
  const m = SPD_RE.exec(v)
  if (!m) return null
  const x = Number(m[1]), u = (m[2] || 'km/h').toLowerCase()
  let r
  if (u === 'km/h' || u === 'kmh' || u === 'kph' || u === '公里/小时' || u === '千米/小时') r = x
  else if (u === 'm/s' || u === '米/秒') r = round6(x * MS_KMH)
  else if (u === 'mph') r = round6(x * MPH_KMH)
  else r = round6(x * KN_KMH)                                                   // kn / kt / kts / knot / knots / 节
  return okSpeed(r) ? r : null
}

/**
 * 日期时间文本 → 分量（不换算时区）：YYYY-MM-DD[ T]HH:mm[:ss[.sss]] 加可选时区（Z / UTC / GMT / ±hh[:mm]），日期分隔也认 / 与 .；
 * 先做全角归一。月 1–12、日须真实存在（含闰年）、时 0–23、分秒 0–59；时区时 ≤ 23、分 ≤ 59。
 * @returns {{Y, Mo, D, h, mi, s, ms, offMin:number|null}|null} offMin = 时区偏移（分，东正）；没写时区为 null（调用方定：说明行按 UTC、侧栏按显示时区）
 */
export function parseDateTimeText(s) {
  const m = DT_RE.exec(normText(s))
  if (!m) return null
  const Y = Number(m[1]), Mo = Number(m[2]), D = Number(m[3])
  const h = m[4] !== undefined ? Number(m[4]) : 0, mi = m[5] !== undefined ? Number(m[5]) : 0, sec = m[6] !== undefined ? Number(m[6]) : 0
  const ms = m[7] !== undefined ? Number((m[7] + '00').slice(0, 3)) : 0
  if (Mo < 1 || Mo > 12 || D < 1 || D > 31 || h > 23 || mi > 59 || sec > 59) return null
  const d = new Date(0)
  d.setUTCFullYear(Y, Mo - 1, D)                                               // 四位年直设（Date.UTC 会把 0–99 年当成 19xx）
  if (d.getUTCFullYear() !== Y || d.getUTCMonth() !== Mo - 1 || d.getUTCDate() !== D) return null   // 2026-02-30 之类
  let offMin = null
  if (m[8] !== undefined) {
    const z = m[8].toLowerCase()
    if (z === 'z' || z === 'utc' || z === 'gmt') offMin = 0
    else {
      const sg = z[0] === '-' ? -1 : 1, hh = Number(z.slice(1, 3)), mm = z.length > 3 ? Number(z.slice(-2)) : 0
      if (hh > 23 || mm > 59) return null
      offMin = sg * (hh * 60 + mm)
    }
  }
  return { Y, Mo, D, h, mi, s: sec, ms, offMin }
}
/**
 * parseDateTimeText 的分量 → UTC ms：ms = 分量当 UTC 读 − 偏移（p.offMin 为 null 时用 defaultOffMin，缺省 0 = UTC）。
 * 年份 0–99 也照原值（不走 Date.UTC 的 19xx 映射）。p 为 null → NaN。
 */
export function partsToUtcMs(p, defaultOffMin = 0) {
  if (!p) return NaN
  const off = p.offMin === null || p.offMin === undefined ? (fin(defaultOffMin) ? defaultOffMin : 0) : p.offMin
  const d = new Date(0)
  d.setUTCFullYear(p.Y, p.Mo - 1, p.D)
  d.setUTCHours(p.h, p.mi, p.s, p.ms)
  return d.getTime() - off * 60000
}
/** UTC ms → ISO 串：整秒 'YYYY-MM-DDTHH:mm:ssZ'，有毫秒 'YYYY-MM-DDTHH:mm:ss.sssZ'；超出四位年 / 非有限 → ''。 */
export function formatUtcIso(ms) {
  if (!okT0(ms)) return ''
  const s = new Date(ms).toISOString()
  return s.endsWith('.000Z') ? s.slice(0, -5) + 'Z' : s
}

/**
 * 航迹说明行（Excel 导出的「说明」表）：第一段 '飞行' | '航行'，随后按 巡航高度（仅飞行）/ 速度 / 起始 / 模型 / 图标 的顺序、
 * 字段存在且合法才写，'; ' 连接；数值用 String(v)（往返逐位相同）。没有新字段的航迹 = '飞行' / '航行'（与现状同）。
 */
export function trajNoteOf(t) {
  const o = isObj(t) ? t : {}
  const flight = o.kind === 'flight'
  const segs = [flight ? '飞行' : '航行']
  if (flight && has(o, 'cruiseAltM') && okCruise(o.cruiseAltM)) segs.push(`巡航高度=${String(o.cruiseAltM)} m`)
  if (has(o, 'speedKmh') && okSpeed(o.speedKmh)) segs.push(`速度=${String(o.speedKmh)} km/h`)
  if (has(o, 't0Ms') && okT0(o.t0Ms)) segs.push(`起始=${formatUtcIso(o.t0Ms)}`)
  const m = o.model
  if (isObj(m) && okModelId(m.id)) {
    segs.push(`模型=${m.id}`)
    if (okPx(m.px)) segs.push(`图标=${String(m.px)} px`)
  }
  return segs.join('; ')
}

/**
 * 解析航迹说明行（导入）：→ {kind, cruiseAltM?, speedKmh?, t0Ms?, model?}，只含合法项（非法值静默丢弃）。
 *   归一：NFKC + 横线 / 句号；分段 ';'，每段 '键 = 值' 或 '键: 值'（键去空白、小写后查别名表）。
 *   巡航高度：m（缺省）/ km / ft / FLnnn，0–30000 m；速度：km/h（缺省）/ kn / m/s / mph，(0, 5000]；起始：parseDateTimeText，没写时区按 UTC；
 *   模型：parseModelId 合法；图标：8–256 整数像素，只在模型也有效时并进 model.px。
 *   类型：识别出任一「键=值」段时按其余段落判（模型 id 里的字样不误判）；一段都没识别出时按整串原文判（= trajKindOf，老说明行不变）。
 */
export function parseTrajNote(s) {
  const raw = String(s ?? '')
  const txt = normText(raw)
  let recognized = false
  const free = []
  let cruise = null, speed = null, t0 = null, modelId = null, px = null
  for (const seg of txt.split(';')) {
    const m = SEG_RE.exec(seg)
    const f = m ? FIELD_OF.get(m[1].toLowerCase().replace(/\s+/g, '')) : undefined
    if (!f) { free.push(seg); continue }
    recognized = true
    const v = m[2]
    if (f === 'cruiseAltM') { const r = altOf(v); if (r !== null) cruise = r }
    else if (f === 'speedKmh') { const r = speedOf(v); if (r !== null) speed = r }
    else if (f === 't0Ms') { const p = parseDateTimeText(v); const r = p ? partsToUtcMs(p, 0) : NaN; if (okT0(r)) t0 = r }
    else if (f === 'model') { if (okModelId(v)) modelId = v }
    else { const pm = PX_RE.exec(v); if (pm) { const r = Number(pm[1]); if (r >= ENT_PX_MIN && r <= ENT_PX_MAX) px = r } }
  }
  const out = { kind: (recognized ? TYPE_RE.test(free.join(';')) : TYPE_RE.test(raw)) ? 'flight' : 'sea' }
  if (cruise !== null) out.cruiseAltM = cruise
  if (speed !== null) out.speedKmh = speed
  if (t0 !== null) out.t0Ms = t0
  if (modelId !== null) out.model = px !== null ? { id: modelId, px } : { id: modelId }
  return out
}

// ─────────────────────────────── 模型锚点 ───────────────────────────────

const DATUM_RE = /(^|_)datum$/, BORE_RE = /(^|_)boresight$/
function findAp(aps, re) {
  if (!Array.isArray(aps)) return null
  for (const a of aps) if (a && typeof a.name === 'string' && re.test(a.name) && isVec3(a.posBody)) return a
  return null
}
/** anchorBodyOf 的空容器。 */
export function makeAnchor() { return { pos: [0, 0, 0], src: 'bottom', liftM: 0 } }

/**
 * 模型本体系里「要落在场景锚点上」的那一点（A3 SPEC §1.8 / §11-7）。
 *   1. 有 datum 挂点（名字匹配 /(^|_)datum$/，取第一个——A3 只在根件发）→ 它的 posBody，src 'datum'；
 *   2. 没有 datum、挂到飞机上 → 包围盒中心，src 'center'；
 *   3. 其余 → 盒底 [x0, y0, box.max[2]]（本体 +Z 向下），x0 / y0 = boresight 挂点的 x / y（方位轴，ground.mjs 口径），没有取盒心，src 'bottom'。
 *   liftM（m）：kind === 'aircraft'（或 info.modelKind === 'aircraft'：飞机模型挂到站 / 点上）时 = max(0, box.max[2] − pos[2])，其余 0。
 * @param {{attachPoints?:Array<{name, posBody}>, box:{min:number[3], max:number[3]}, modelKind?:string}} info
 *        box = 本体系（米）的可见几何包围盒（渲染端按关节静止位姿实测）
 * @param {string} kind  挂载目标类别（ENT_KINDS 之一）
 * @param {{pos:number[3], src:string, liftM:number}} [out]
 */
export function anchorBodyOf(info, kind, out) {
  const o = out || makeAnchor()
  const aps = info ? info.attachPoints : null, box = info ? info.box : null
  const bOk = !!(box && isVec3(box.min) && isVec3(box.max))
  const cx = bOk ? (box.min[0] + box.max[0]) / 2 : 0, cy = bOk ? (box.min[1] + box.max[1]) / 2 : 0, cz = bOk ? (box.min[2] + box.max[2]) / 2 : 0
  const P = o.pos
  const datum = findAp(aps, DATUM_RE)
  if (datum) { P[0] = datum.posBody[0]; P[1] = datum.posBody[1]; P[2] = datum.posBody[2]; o.src = 'datum' }
  else if (kind === 'aircraft') { P[0] = cx; P[1] = cy; P[2] = cz; o.src = 'center' }
  else {
    const b = findAp(aps, BORE_RE)
    P[0] = b ? b.posBody[0] : cx; P[1] = b ? b.posBody[1] : cy; P[2] = bOk ? box.max[2] : cz; o.src = 'bottom'
  }
  const air = kind === 'aircraft' || !!(info && info.modelKind === 'aircraft')
  const lift = air && bOk ? box.max[2] - P[2] : 0
  o.liftM = lift > 0 ? lift : 0
  return o
}

// ─────────────────────────────── 可指向天线 ───────────────────────────────

const S_AZ = 'azimuth', S_EL = 'elevation', S_X = 'xAxis', S_Y = 'yAxis'
const stagesOf = (a) => (a && Array.isArray(a.stages) ? a.stages : [])
const stNum = (v, d) => (typeof v === 'number' && fin(v) ? v : d)
const prefixOf = (name) => { const i = typeof name === 'string' ? name.indexOf('_') : -1; return i > 0 ? name.slice(0, i) : '' }

/**
 * 可指向天线的驱动描述（生成期一次，结果只读复用）。
 *   type  'azel'（有 azimuth / elevation stage，优先）| 'xy'（有 xAxis / yAxis stage）；都没有 → null（渲染端退回整体转方位）
 *   frame 挂点系（本体系三轴）：attitude.mountFrame({dirBody, upBody}) 取 boresight 挂点——优先与「同时含 s1、s2 的第一条关节」同前缀的那个，
 *         再退第一个 boresight；没有 boresight 按站挂点缺省（dir +X、up −Z）
 *   lim   所有含该 stage 的关节的限位交集（没有 s2 的关节不约束 a2）；交集为空时退主关节自己的限位；没有任何限位按全行程 ±180 / ±90
 *   init  第一条含该 stage 的关节的 initialValue（夹进 lim）
 *   arts  含 s1 或 s2 的关节名（驱动值按 jointValuesOf 写同一组）
 * @param {{attachPoints?, articulations?}} meta
 */
export function aimRigOf(meta) {
  const arts = meta && Array.isArray(meta.articulations) ? meta.articulations : []
  let type = null
  for (const a of arts) for (const s of stagesOf(a)) if (s && (s.name === S_AZ || s.name === S_EL)) type = 'azel'
  if (!type) for (const a of arts) for (const s of stagesOf(a)) if (s && (s.name === S_X || s.name === S_Y)) type = 'xy'
  if (!type) return null
  const s1 = type === 'xy' ? S_X : S_AZ, s2 = type === 'xy' ? S_Y : S_EL
  let l1 = -Infinity, h1 = Infinity, l2 = -Infinity, h2 = Infinity, i1 = NaN, i2 = NaN
  let p1 = null, p2 = null, primary = null
  const names = []
  const range = (s, dLo, dHi) => { let lo = stNum(s.minimumValue, dLo), hi = stNum(s.maximumValue, dHi); if (lo > hi) { const t = lo; lo = hi; hi = t } return [lo, hi] }
  for (const a of arts) {
    let st1 = null, st2 = null
    for (const s of stagesOf(a)) { if (s && s.name === s1 && !st1) st1 = s; else if (s && s.name === s2 && !st2) st2 = s }
    if (!st1 && !st2) continue
    names.push(String(a.name))
    if (st1) { const [lo, hi] = range(st1, -180, 180); if (lo > l1) l1 = lo; if (hi < h1) h1 = hi; if (!fin(i1)) i1 = stNum(st1.initialValue, 0); if (!p1) p1 = [lo, hi] }
    if (st2) { const [lo, hi] = range(st2, -90, 90); if (lo > l2) l2 = lo; if (hi < h2) h2 = hi; if (!fin(i2)) i2 = stNum(st2.initialValue, 0); if (!p2) p2 = [lo, hi] }
    if (st1 && st2 && !primary) primary = a
  }
  if (!(l1 <= h1)) [l1, h1] = p1 || [-180, 180]
  if (!(l2 <= h2)) [l2, h2] = p2 || [-90, 90]
  if (!fin(l1)) l1 = -180
  if (!fin(h1)) h1 = 180
  if (!fin(l2)) l2 = -90
  if (!fin(h2)) h2 = 90
  if (!fin(i1)) i1 = 0
  if (!fin(i2)) i2 = 0
  i1 = i1 < l1 ? l1 : (i1 > h1 ? h1 : i1)
  i2 = i2 < l2 ? l2 : (i2 > h2 ? h2 : i2)
  // boresight 挂点：与主关节同前缀的优先
  const aps = meta && Array.isArray(meta.attachPoints) ? meta.attachPoints : []
  const bores = aps.filter((a) => a && typeof a.name === 'string' && BORE_RE.test(a.name) && isVec3(a.dirBody))
  const pre = primary ? prefixOf(primary.name) : (names.length ? prefixOf(names[0]) : '')
  const bore = (pre && bores.find((a) => prefixOf(a.name) === pre)) || bores[0] || null
  const frame = mountFrame(bore ? { dirBody: bore.dirBody, upBody: bore.upBody } : { dirBody: [1, 0, 0], upBody: [0, 0, -1] })
  return {
    type, frame, s1, s2,
    lim: { a1Min: l1, a1Max: h1, a2Min: l2, a2Max: h2 },
    init: { a1: i1, a2: i2 },
    arts: names,
    boresight: bore ? bore.name : null
  }
}

/**
 * solveAim / parkAim 的状态容器：a1 / a2 = 当前驱动值（度，NaN = 还没解过）；ok = 本次有解；held = 本次无解、保持上一次；
 * pre = 预指向（az-el 座：目标俯仰低于该座俯仰下限 → 方位对准目标、俯仰夹到下限，真实 ACU 的等待姿态；ok / held 都为假）。
 */
export function makeAimState() { return { a1: NaN, a2: NaN, ok: false, held: false, pre: false } }

// 暂存：_pk = [p1, p2, ref1, ref2, out1, out2]；_dm = 挂点系视线
const _pk = new Float64Array(6), _dm = new Float64Array(3), _zen = [0, 0, -1]
const EPS_LIM = 1e-9, SING = 1e-12                                              // = gimbal.mjs EPS_LIM / SING

// gimbal.pickSolution(p1, p2, lim, ref1, ref2, out) 的逐字复写（nearestCongruent 就地展开）：入参取 _pk[0..3]、结果写 _pk[4..5]。
// double 不当实参跨调用边界传（未内联时会装箱）；结果与原函数逐位相同（单测对拍）。
function pickInto(lim) {
  const p1 = _pk[0], p2 = _pk[1], r1 = _pk[2], r2 = _pk[3]
  const lo1 = lim.a1Min, hi1 = lim.a1Max, lo2 = lim.a2Min, hi2 = lim.a2Max
  let ok = false, bc = Infinity
  for (let br = 0; br < 2; br++) {
    const b1 = br === 0 ? p1 : p1 + 180, b2 = br === 0 ? p2 : 180 - p2
    let a1 = NaN, bd = Infinity
    const k1 = Math.round((r1 - b1) / 360)
    for (let k = k1 - 2; k <= k1 + 2; k++) {
      const v = b1 + 360 * k
      if (v < lo1 - EPS_LIM || v > hi1 + EPS_LIM) continue
      const d = Math.abs(v - r1)
      if (d < bd) { bd = d; a1 = v }
    }
    if (!fin(a1)) continue
    let a2 = NaN
    bd = Infinity
    const k2 = Math.round((r2 - b2) / 360)
    for (let k = k2 - 2; k <= k2 + 2; k++) {
      const v = b2 + 360 * k
      if (v < lo2 - EPS_LIM || v > hi2 + EPS_LIM) continue
      const d = Math.abs(v - r2)
      if (d < bd) { bd = d; a2 = v }
    }
    if (!fin(a2)) continue
    const c = Math.abs(a1 - r1) + Math.abs(a2 - r2)
    if (c < bc) { bc = c; _pk[4] = a1; _pk[5] = a2; ok = true }
  }
  return ok
}

// gimbal.solveAzEl / solveXY 的逐字复写（主解；norm2 的大小量级分支照搬）：读 _dm、写 _pk[0..1]，奇异返回 true。
// 原函数经 gx / gy / gz / norm2 这些返回 double 的小函数取数，没内联时每个装箱 16 B；这里全在一个函数里算（单测与原函数逐位对拍）。
function primaryInto(xy) {
  const x = _dm[0], y = _dm[1], z = _dm[2]
  const u = xy ? y : x, v = xy ? x : y                                        // azel：h = |(x, z)|、仰 = atan2(y, h)；xy：h = |(y, z)|、Y = atan2(x, h)
  const s = u * u + z * z
  const h = s > 1e-290 && s < 1e290 ? Math.sqrt(s) : Math.hypot(u, z)
  _pk[1] = Math.atan2(v, h) * R2D
  const av = Math.abs(v)
  const singular = !(h > SING * (av > 1 ? av : 1))
  if (!singular) _pk[0] = Math.atan2(u, z) * R2D
  return singular
}

// _dm（挂点系视线）已写好：主解 → 限位内离参考最近 → 写 st
// 无解时：az-el 座且目标俯仰低于俯仰下限（如 VSAT 1.2 m 的 7°）→ 预指向：方位按主解、俯仰夹到下限再选解（编排者裁定 §8-4；
// 地平以下由调用方按 park 走 parkAim，不进这里）；方位也够不着（13 m 站 90–270 行程外）或其余无解 → 保持上一次（held）
function aimFromMount(rig, st) {
  const init = rig.init, prev = fin(st.a1) && fin(st.a2)
  _pk[2] = prev ? st.a1 : init.a1; _pk[3] = prev ? st.a2 : init.a2
  const sing = primaryInto(rig.type === 'xy')
  if (sing) _pk[0] = _pk[2]                                                   // keyhole：方位沿用上一次（= solveGimbal(type, dm, prevA1)）
  st.pre = false
  if (fin(_pk[0]) && fin(_pk[1]) && pickInto(rig.lim)) {
    st.a1 = _pk[4]; st.a2 = _pk[5]; st.ok = true; st.held = false
  } else if (rig.type !== 'xy' && !sing && fin(_pk[0]) && _pk[1] < rig.lim.a2Min && ((_pk[1] = rig.lim.a2Min), pickInto(rig.lim))) {
    st.a1 = _pk[4]; st.a2 = _pk[5]; st.ok = false; st.held = false; st.pre = true
  } else {
    if (!prev) { st.a1 = init.a1; st.a2 = init.a2 }
    st.ok = false; st.held = true
  }
  return st.ok
}

/**
 * 本体系单位视线 → 驱动值：投到 rig.frame 挂点系 → gimbal 主解（solveAzEl / solveXY）→ 限位内、离上一次 (st.a1, st.a2) 最近的一组
 * （上一次为 NaN 时参考 rig.init）。keyhole（视线 ∥ 方位轴）方位沿用上一次。az-el 座目标俯仰低于下限：预指向（st.pre，返回 false）；
 * 其余无解：保持上一次（st.held = true；首次无解取 init）。
 * 零分配。@returns {boolean} st.ok
 * @param {number[]|{x,y,z}} dirBody
 */
export function solveAim(rig, dirBody, st) {
  const f = rig.frame, fx = f.x, fy = f.y, fz = f.z
  let d0, d1, d2
  const dx = dirBody.x
  if (dx !== undefined) { d0 = dx; d1 = dirBody.y; d2 = dirBody.z } else { d0 = dirBody[0]; d1 = dirBody[1]; d2 = dirBody[2] }
  _dm[0] = d0 * fx[0] + d1 * fx[1] + d2 * fx[2]
  _dm[1] = d0 * fy[0] + d1 * fy[1] + d2 * fy[2]
  _dm[2] = d0 * fz[0] + d1 * fz[1] + d2 * fz[2]
  return aimFromMount(rig, st)
}
/**
 * 停放姿态：azel → 方位保持（NaN 取 init）、俯仰 = clamp(90, a2Min, a2Max)（朝天顶收起）；xy → 解「本体天顶 [0, 0, −1]」
 * （X-Y 座零位即天顶 → (0, 0)；无解保持）。零分配。@returns {boolean} st.ok
 */
export function parkAim(rig, st) {
  if (rig.type === 'xy') return solveAim(rig, _zen, st)
  const L = rig.lim
  if (!fin(st.a1)) st.a1 = rig.init.a1
  st.a2 = 90 < L.a2Min ? L.a2Min : (90 > L.a2Max ? L.a2Max : 90)
  st.ok = true; st.held = false; st.pre = false
  return true
}
/**
 * 驱动值 → {关节名: {stage 名: 值}}（与 components/ground.gimbalValues 同形：azel 写 {azimuth, elevation}、xy 写 {xAxis, yAxis}）。
 * out 复用（关节表不变时键不增删）即零分配。
 */
export function jointValuesOf(rig, a1, a2, out) {
  const o = out || {}
  const arts = rig.arts, xy = rig.type === 'xy'
  for (let i = 0; i < arts.length; i++) {
    const k = arts[i]
    let v = o[k]
    if (!v || typeof v !== 'object') { v = xy ? { xAxis: 0, yAxis: 0 } : { azimuth: 0, elevation: 0 }; o[k] = v }
    if (xy) { v.xAxis = a1; v.yAxis = a2 } else { v.azimuth = a1; v.elevation = a2 }
  }
  return o
}

// ─────────────────────────────── 地球站跟踪目标 ───────────────────────────────

/**
 * pickTrackTarget 的状态容器：key = 选中星的键（'' = 无）、idx = 候选下标（−1 = 无）、park = 停放（无候选 / 最高仰角 < 0）、
 * look = WGS-84 读数（entityPose.makeStationLook）、aim = 画面口径（dir 为场景轴单位视线）、_best = 本拍最高仰角（度）。
 */
export function makeTrackState() { return { key: '', idx: -1, park: true, look: makeStationLook(), aim: makeStationLook(), _best: 0 } }

const _tl = makeStationLook()
const ecefOk = (e) => { if (!e) return false; const x = e.x; return x !== undefined ? fin(x) && fin(e.y) && fin(e.z) : fin(e[0]) && fin(e[1]) && fin(e[2]) }

/**
 * 候选里挑 WGS-84 仰角最高的星（stationTrackAzEl）。滞回：上一次的 st.key 仍在候选里、且仰角 ≥ 新最高 − TRACK_HYST_DEG 就不换
 * （上一次的已落到地平以下而最高的在地平以上时照换）。选中后 st.look = WGS-84 读数、st.aim = stationAimScene（画面口径，站锚点
 * r = 1 + altM / 6371 km）；st.park = !(st.look.elDeg ≥ 0)；没有有效候选也 park（key 清空）。零分配（cands 由调用方复用）。
 * @param {{lat:number, lon:number, altM?:number}} stLla
 * @param {Array<{key:string, ecef:number[3]|{x,y,z}}>} cands  只读前 n 个；ecef（km）非有限的跳过
 * @param {number} n
 * @returns {number} 选中下标或 −1
 */
export function pickTrackTarget(stLla, cands, n, st) {
  const len = cands ? cands.length : 0
  const m = typeof n === 'number' && n >= 0 && n < len ? n : len
  let best = -1, bestEl = -Infinity, prevI = -1, prevEl = -Infinity
  const pk = st.key
  for (let i = 0; i < m; i++) {
    const c = cands[i]
    if (!c || !ecefOk(c.ecef)) continue
    stationTrackAzEl(stLla, c.ecef, _tl)
    const el = _tl.elDeg
    if (!fin(el)) continue
    if (best < 0 || el > bestEl) { best = i; bestEl = el }
    if (prevI < 0 && pk !== '' && c.key === pk) { prevI = i; prevEl = el }
  }
  let pick = best
  if (prevI >= 0 && prevI !== best && prevEl >= bestEl - TRACK_HYST_DEG && (prevEl >= 0 || bestEl < 0)) pick = prevI
  if (pick < 0) { st.key = ''; st.idx = -1; st.park = true; return -1 }
  const c = cands[pick]
  st.key = typeof c.key === 'string' ? c.key : ''
  st.idx = pick
  stationTrackAzEl(stLla, c.ecef, st.look)
  stationAimScene(stLla, c.ecef, st.aim)
  st.park = !(st.look.elDeg >= 0)
  st._best = bestEl
  return pick
}

// ─────────────────────────────── 载具 / 光照 ───────────────────────────────

/** 航迹载具在 tMs 的状态：trajKinematics.trajStateAt 的薄包装（out = makeTrajState()，复用即零分配）。 */
export function vehicleStateAt(t, tMs, out) { return trajStateAt(t, tMs, out || makeTrajState()) }

/**
 * 大圆上从 (lat, lon) 沿航向 headingDeg（正北起顺时针）走球心角 dDeg 到的点：P = U·cos d + (cosψ·N + sinψ·E)·sin d
 * （与 trajKinematics 段内 P(θ) = A·cosθ + T·sinθ 同式；极点处 N / E 按经度公式照给）。2D 运动档载具的屏幕朝向用。零分配。
 * @param {{lat:number, lon:number}} [out]  lon ∈ (−180, 180]
 */
export function aheadPoint(lat, lon, headingDeg, dDeg, out) {
  const o = out || { lat: 0, lon: 0 }
  const p = lat * D2R, l = lon * D2R, sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l)
  const h = headingDeg * D2R, ch = Math.cos(h), sh = Math.sin(h), d = dDeg * D2R, cd = Math.cos(d), sd = Math.sin(d)
  const tx = ch * (-sp * cl) + sh * (-sl), ty = ch * (-sp * sl) + sh * cl, tz = ch * cp
  const px = cp * cl * cd + tx * sd, py = cp * sl * cd + ty * sd, pz = sp * cd + tz * sd
  o.lat = Math.atan2(pz, Math.sqrt(px * px + py * py)) * R2D
  let x = Math.atan2(py, px) * R2D
  if (x <= -180) x += 360
  o.lon = x
  return o
}

/**
 * 当地太阳高度角压暗系数：sunLit 为假 → 1（全亮）；否则 SHADE_FLOOR + (1 − SHADE_FLOOR)·smoothstep(−6°, +0.8°, elev)，
 * elev = asin(Û·Ŝ)（两者先归一；场景轴或 ECEF 都行，只要同一套轴）。任一矢量无效 → 1。
 * @param {number[]|{x,y,z}} upScene  锚点（或当地天顶）
 * @param {number[]|{x,y,z}} sunScene 太阳方向
 */
export function shadeOf(upScene, sunScene, sunLit) {
  if (!sunLit || !upScene || !sunScene) return 1
  let ux, uy, uz, sx, sy, sz
  const u0 = upScene.x, s0 = sunScene.x
  if (u0 !== undefined) { ux = u0; uy = upScene.y; uz = upScene.z } else { ux = upScene[0]; uy = upScene[1]; uz = upScene[2] }
  if (s0 !== undefined) { sx = s0; sy = sunScene.y; sz = sunScene.z } else { sx = sunScene[0]; sy = sunScene[1]; sz = sunScene[2] }
  const lu = Math.sqrt(ux * ux + uy * uy + uz * uz), ls = Math.sqrt(sx * sx + sy * sy + sz * sz)
  if (!(lu > 0 && ls > 0 && fin(lu) && fin(ls))) return 1
  let c = (ux * sx + uy * sy + uz * sz) / (lu * ls)
  c = c > 1 ? 1 : (c < -1 ? -1 : c)
  const e = Math.asin(c) * R2D
  let t = (e - SUN_ELEV_DARK_DEG) / (SUN_ELEV_LIT_DEG - SUN_ELEV_DARK_DEG)
  t = t < 0 ? 0 : (t > 1 ? 1 : t)
  return SHADE_FLOOR + (1 - SHADE_FLOOR) * (t * t * (3 - 2 * t))
}
