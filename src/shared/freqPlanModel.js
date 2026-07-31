// 转发器频率计划 · 数据模型（渲染端 ESM，编辑器窗口 / 链路预算窗口 / 文件区共用）。
//
// ★ 这类图的骨架是 LO，不是图形。四张标准频率计划图（C/Ku/Ka，中星·亚太·前向计划）无一例外满足
//     f_下行 = f_上行 − LO
//   （5950−2320=3630 · 14022−1750=12272 · 14.27−3.3=10.97 …）。于是本模型只存
//   【上行频率 + LO 归属 + 带宽 + 上下行极化 + 波束/带宽组】，下行是算出来的：
//     · 录入从「填 44 个数字」降为「填起始频率/频率间隔/数量」（见 genSeries）；
//     · cross-strap（Ku 图 P5~P8→K2/K4/K6/K8 那种上下行不同 LO 的重排）是显式例外——
//       dn.fcMHz 填了值就以填的为准，null 才走 LO 推算。这一个字段同时吃掉两个问题。
//
// ★★ 但那条等式是【双向】的，不是「从上行算下行」的单向管道：LO 一旦确定，上下行互为函数，
//   改哪一边另一边都该跟着走（f_上 = f_下 + LO 与 f_下 = f_上 − LO 是同一条式子）。看图的人
//   手上拿到的可能是下行表（下行是接收站测得的那一侧），照样该能直接录。故录入只有一个收口
//   setChannelFc(side, v)：
//     · 联动态（挂了有效 LO 且未显式解耦）—— 只存上行这一个数，下行永远由等式给出；从下行录入
//       时先反解回上行再存。两个数出自同一个源，就不可能自相矛盾（也不必去同步第二份存储）。
//     · 解耦态（cross-strap）—— dn.fcMHz 显式存值，两侧各改各的。进出解耦态由 setDnDecoupled
//       显式切换（界面上是一个开关），不靠「填了没填」去猜人的意图。
//
// 单位：内部一律 MHz（图上 GHz/MHz 混排，入口 toMHz 归一）。极化 H/V（线）与 L/R（圆）并存，
// 且上下行可以不同体制（Ka 前向计划就是上行 R/L、下行 H/V）。

import { toHalf } from './num.js'

// ---- 单位与基础工具 ----

// 图上频率有 12.77（GHz）与 14022（MHz）两种写法。以 1000 为界判定：卫星通信频率
// 低于 1000 时不可能是 MHz（L 频段最低也在 1500 MHz 上下），故 <1000 一律当 GHz。
export function toMHz(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.abs(n) < 1000 ? n * 1000 : n
}
export const toGHz = (mhz) => (Number.isFinite(Number(mhz)) ? Number(mhz) / 1000 : null)

// 显示单位：整张图（频率标注 + 图例带宽 + 带宽录入）共用一个刻度，由工具栏那一个下拉定。
// 图上一排转发器的标称带宽有 36 MHz（常规）、250 kHz（窄带/信道化）、1 GHz（宽带 Ka）三种量级，
// 故单位可选。内部仍一律 MHz —— 单位只是「录入与显示用哪个刻度」，换单位不改物理量。
// ★ 曾经波束那行自带一个单位下拉，与工具栏那个并存：同一张图两处单位互不相干，图例写 kHz、
//   轴上写 MHz，读者得自己换算。单位只留一处。
export const FREQ_UNITS = ['Hz', 'kHz', 'MHz', 'GHz', 'THz']
// 新建「波束/带宽」组与批量生成的兜底带宽：36 MHz 是标准转发器带宽（四张标准图里最常见的一档），
// 空着让人现敲一个人人都知道的数没意义；填错也只是改个数，比留空更接近多数计划的起点。
export const DEFAULT_BW_MHZ = 36
const UNIT_MHZ = { Hz: 1e-6, kHz: 1e-3, MHz: 1, GHz: 1e3, THz: 1e6 }
export const unitFactorMHz = (unit) => UNIT_MHZ[unit] ?? 1
export const unitLabel = (unit) => (FREQ_UNITS.includes(unit) ? unit : 'MHz')
// 往返换算都收到 12 位有效数字：不收的话 0.1 GHz → 100.00000000000001 MHz → 回显 0.10000000000000002，
// 输入框会被这串噪声刷掉正在敲的字（见 oneway-value-binding-wipes-input 那类坑）。
// ★ 按有效位收、不按绝对位收（原先是 1e-6）：THz 刻度下 250 kHz 是 2.5e-7，绝对位会把它抹成 0。
// 单位换算与上下行互算（f ± LO，同样是一次浮点加减）共用这一个收敛口。
export const cleanFreq = (v) => (Number.isFinite(v) ? Number(v.toPrecision(12)) : null)
export function bwToMHz(v, unit = 'MHz') {
  const n = num(v)
  return n == null ? null : cleanFreq(n * unitFactorMHz(unit))
}
export function bwFromMHz(mhz, unit = 'MHz') {
  return Number.isFinite(mhz) ? cleanFreq(mhz / unitFactorMHz(unit)) : null
}
// 带宽 → 显示文字，跟随图上当前单位（不自动换挡：选了 kHz 就写 kHz，图例才对得上录入）
export function fmtBw(mhz, unit = 'MHz') {
  const v = bwFromMHz(mhz, unit)
  return v == null ? '' : `${v} ${unitLabel(unit)}`
}

// 数值归一：null / undefined / 空串 / 非数 一律成 null。
// ★ 不能图省事写 Number.isFinite(Number(v))：Number(null) 和 Number('') 都等于 0，
//   于是「下行留空 = 由 LO 推算」会被存成 0 MHz，推算路径被静默旁路、下行全变 0。
//   留空是这套模型最常走的路径，这个坑必须在入口堵死。
function num(v) {
  if (v === null || v === undefined) return null
  // 全角先归一：中文输入法下的全角减号「－」(U+FF0D) 让 Number('－75') = NaN，负值（上变频的 LO
  // 就填负数）会被静默吞成 null，症状是「正数填得进、负数填不进」（见 fullwidth-number-parsing）
  const s = typeof v === 'string' ? toHalf(v).trim() : v
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

let _seq = 0
export function genId(prefix = 'x') {
  _seq = (_seq + 1) % 1e6
  return `${prefix}${Date.now().toString(36)}${_seq.toString(36)}`
}

export const POLS = ['H', 'V', 'L', 'R']
export const POL_LABEL = { H: 'H（水平）', V: 'V（垂直）', L: 'LHCP（左旋）', R: 'RHCP（右旋）' }
// 正交极化对——同频复用的判定依据：同频且正交 = 合法复用，同频且同极化 = 冲突。
export const POL_ORTHO = { H: 'V', V: 'H', L: 'R', R: 'L' }

export const CHANNEL_KINDS = [
  { key: 'transponder', label: '转发器' },
  { key: 'beacon', label: '信标' },
  { key: 'tc', label: '遥控 TC' },
  { key: 'tm', label: '遥测 TM' },
  { key: 'reserved', label: '保留/其他' }
]
export const KIND_LABEL = Object.fromEntries(CHANNEL_KINDS.map((k) => [k.key, k.label]))

// 波束默认配色：取自标准计划图的惯用色（红=区域、黄=全球、绿=东部、蓝=点波束）。
export const DEFAULT_BEAM_COLORS = ['#4472C4', '#E03C31', '#F2C200', '#2E9E5B', '#8E5BC4', '#E07B39', '#4BB3C4', '#C4547E']

// ---- 建模 ----

// 「波束/带宽」组。标准计划图的图例条目是【颜色 + 波束 + 带宽】（■ 中国波束：36 MHz）——
// 一种颜色标的既是覆盖也是这一组转发器的标称带宽，所以带宽是这里的属性，不只是转发器的属性。
// bwMHz 内部一律 MHz；用哪个刻度写不是波束的属性（老计划里的 bwUnit 读进来直接丢弃），
// 整张图跟工具栏那一个单位走。
// ★ 曾有过一个 code（图例前缀「A：」），与波束名是同一件事的两种写法，图例上并排写成
//   「A：中国波束 36 MHz」更像编号没删干净，已去掉——认波束靠名字与颜色。
export function newBeam(patch = {}) {
  return {
    id: patch.id || genId('b'),
    // 老计划只填了代号没填名字的，代号顶上来当名字，别让条目变成一行空白。
    // 兜底名走英文：波束名直接进图例，系统给的默认值不该在一张英文图上写中文（人改成中文名当然照画）
    name: patch.name || patch.code || 'Beam',
    color: patch.color || DEFAULT_BEAM_COLORS[0],
    bwMHz: num(patch.bwMHz)
  }
}

// 图例 / 下拉 / 表格三处共用的一行标签，口径只在这里定义：「波束名: 带宽」。
// unit = 图上当前单位，三处都把它传进来，标签与轴上的数才是同一把刻度。
// ★ 分隔符是半角冒号：这行标签会原样画进导出的图，而图上系统给的那部分一律走西文
//   （见 freqPlanRender 文件头）——全角「：」在一张英文版式的图上是唯一的中文标点。
export function beamLabel(bm, unit = 'MHz') {
  if (!bm) return ''
  const name = bm.name || ''
  const bw = fmtBw(bm.bwMHz, unit)
  return bw ? `${name}: ${bw}` : name
}

export function newLo(patch = {}) {
  return {
    id: patch.id || genId('l'),
    name: patch.name || 'LO',
    // 下变频（转发器常态）：f_dn = f_up − valueMHz，故 valueMHz > 0。上变频场景填负值即可，
    // 推算公式不分支——少一条分支就少一处口径分歧。
    valueMHz: num(patch.valueMHz),
    note: patch.note || ''
  }
}

// 波束归属是一个集合：同一段频率被几个波束同时用（同频复用）是常态，图上画成多色片。
// ★ 兼容老计划：单值 beamUpId / beamDnId 与「可切换波束」switchableBeamIds 都并进这个集合——
//   三者在图上、在录入界面本就是同一件事（这条转发器牵涉哪几个波束），分成三个字段只会让人
//   在「该填哪个」上犹豫，而画法与计算从未区分过它们。只读老字段、不再写回。
function beamIdList(...srcs) {
  const out = []
  for (const s of srcs) {
    for (const id of Array.isArray(s) ? s : [s]) {
      if (id && !out.includes(id)) out.push(String(id))
    }
  }
  return out
}

export function newChannel(patch = {}) {
  const up = patch.up || {}
  const dn = patch.dn || {}
  return {
    id: patch.id || genId('c'),
    no: patch.no != null ? String(patch.no) : '',
    kind: patch.kind || 'transponder',
    up: {
      fcMHz: num(up.fcMHz),
      bwMHz: num(up.bwMHz),
      pol: POLS.includes(up.pol) ? up.pol : 'H'
    },
    loId: patch.loId || '',
    // 全 null = 由 LO 推算；填任意一项即以填的为准（cross-strap / 下行重排 / 收发带宽不等）
    dn: {
      fcMHz: num(dn.fcMHz),
      bwMHz: num(dn.bwMHz),
      pol: POLS.includes(dn.pol) ? dn.pol : (POL_ORTHO[up.pol] || 'V')
    },
    // 上行波束集合（≥2 个 → 图上该块画成多色片）。下行留空 = 跟上行同一组波束。
    beamUpIds: beamIdList(patch.beamUpIds, patch.beamUpId, patch.switchableBeamIds),
    beamDnIds: beamIdList(patch.beamDnIds, patch.beamDnId),
    // 接链路预算用的转发器属性（可留空——留空则链路预算仍用卫星配置里手填的那份）。
    // 这五项与链路预算卫星栏一一对应：SFDref / G/Tref / IBO / OBO / C/IM，见 channelToLinkFields。
    // 曾有过一个 eirpDbw：链路预算的卫星 EIRP 由 SFD+OBO 或 GRD 天线回填决定，转发器行给不了它，
    // 那个字段只写不读，已去掉——留着只会让人以为填了就能生效。
    sfdDbwm2: num(patch.sfdDbwm2),
    gtDbK: num(patch.gtDbK),
    boiDb: num(patch.boiDb),
    booDb: num(patch.booDb),
    cimDb: num(patch.cimDb),
    note: patch.note || ''
  }
}

export function newPlan(patch = {}) {
  const p = {
    id: patch.id || genId('fp'),
    // 计划名会当段头画进图里，故默认名同样走英文（人改成中文名照画中文，见 freqPlanRender 文件头）
    name: patch.name || 'Frequency Plan',
    satFolder: patch.satFolder || '',     // 卫星树节点 key（与 GRD 天线同源，见 useGrdCoverage 的 folder）
    satName: patch.satName || '',
    band: patch.band || 'Ku',
    // 频段取值方式：true（默认）= 按图上的频率自动判定（见 guessBand），false = 界面上手选钉死。
    // 老计划没有这个字段，一律按自动读——它们的 band 本就是当年猜出来的。
    bandAuto: patch.bandAuto !== false,
    note: patch.note || '',
    los: (patch.los || []).map(newLo),
    beams: (patch.beams || []).map(newBeam),
    channels: (patch.channels || []).map(newChannel),
    updatedAt: patch.updatedAt || new Date().toISOString()
  }
  return p
}

// 反序列化兜底：老版本 / 手改过的 JSON 都从这里进，缺字段补默认、类型归一。
export function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return newPlan()
  const p = newPlan(raw)
  // 通道引用的 LO/波束若已被删，清成空引用而不是留悬挂 id（悬挂 id 会让下行推算静默失败）
  const loIds = new Set(p.los.map((l) => l.id))
  const beamIds = new Set(p.beams.map((b) => b.id))
  for (const ch of p.channels) {
    if (ch.loId && !loIds.has(ch.loId)) ch.loId = ''
    ch.beamUpIds = ch.beamUpIds.filter((id) => beamIds.has(id))
    ch.beamDnIds = ch.beamDnIds.filter((id) => beamIds.has(id))
    // 下行集合与上行一模一样 → 收回「随上行」态。与下面那条下行频率的处理同一个道理：同一件事存两遍，
    // 下次改上行波束时下行不会跟着改，就悄悄漂成两组。真的两侧不同（几收一发 / 一收几发）才留着。
    if (ch.beamDnIds.length === ch.beamUpIds.length
      && ch.beamDnIds.every((id, i) => id === ch.beamUpIds[i])) ch.beamDnIds = []
    // 显式下行恰好等于 LO 推算值 → 收回联动态。同一个量存两遍没有意义，只会在下次改上行或改 LO
    // 时漂开；而两边都填满的老计划/外来 JSON 正是靠这一步，进来之后「改一边另一边跟着变」才成立。
    // 差得超过浮点噪声的才是真 cross-strap，原样留着。
    const loV = loValueOf(p, ch)
    if (loV != null && Number.isFinite(ch.dn.fcMHz) && Number.isFinite(ch.up.fcMHz)
      && Math.abs(ch.dn.fcMHz - dnFromUp(ch.up.fcMHz, loV)) < 1e-9) ch.dn.fcMHz = null
  }
  return p
}

// ---- LO 推算与解析 ----

export const findLo = (plan, loId) => (plan.los || []).find((l) => l.id === loId) || null
export const findBeam = (plan, beamId) => (plan.beams || []).find((b) => b.id === beamId) || null

// 该通道某一侧涉及的波束（按录入顺序，色片自上而下就按这个顺序画）。
// 下行留空 = 跟上行走：转发器绝大多数是「同一波束收、同一波束发」，让人两边各填一遍只会填漏。
export function channelBeams(plan, ch, side = 'up') {
  const ids = (side === 'dn' ? ch?.beamDnIds : ch?.beamUpIds) || []
  const list = ids.map((id) => findBeam(plan, id)).filter(Boolean)
  if (side === 'dn' && !list.length) return channelBeams(plan, ch, 'up')
  return list
}

// ---- 上下行联动：一条等式，两个方向 ----
//
// 「改一边另一边跟着变」的全部实现都在这一段：界面三处（转发器表 / 检查器 / 批量生成）与容量规划的
// 载波中心频率一律调这里，等式不在别处再写第二遍。

// 该通道当前的 LO 值。没挂 / 挂的 LO 没填值 / 挂的 LO 已被删 → null，即「LO 未确定」，
// 此时上下行无从互算，两侧各自独立。
export function loValueOf(plan, ch) {
  const lo = findLo(plan, ch?.loId)
  return lo && Number.isFinite(lo.valueMHz) ? lo.valueMHz : null
}
// 等式的两个方向。都过 cleanFreq：一次加减就足以带出 12272.150000000001 这样的尾巴，
// 直接回显会把输入框里正在敲的字刷掉，也会让「往返一趟」变成改值。
export const dnFromUp = (upFc, loMHz) => (Number.isFinite(upFc) && Number.isFinite(loMHz) ? cleanFreq(upFc - loMHz) : null)
export const upFromDn = (dnFc, loMHz) => (Number.isFinite(dnFc) && Number.isFinite(loMHz) ? cleanFreq(dnFc + loMHz) : null)

// 联动态：LO 确定 且 下行未显式解耦 —— 此时下行不存值，永远由等式给出。
export const isDnLinked = (plan, ch) => loValueOf(plan, ch) != null && !Number.isFinite(ch?.dn?.fcMHz)

// 下行中心频率：显式值优先，否则 f_up − LO。两者都无 → null（渲染时该通道下行为空位）。
export function downlinkFc(plan, ch) {
  if (Number.isFinite(ch?.dn?.fcMHz)) return ch.dn.fcMHz
  return dnFromUp(ch?.up?.fcMHz, loValueOf(plan, ch))
}

// 频率录入的唯一收口（side = 'up' | 'dn'，v 可以是输入框里的原始字符串）。
// ★ 联动态下从下行录入的，反解成上行后【只存上行】—— 不去同步两份存储：同一个量存两遍，
//   迟早有一遍没跟上（改 LO、改上行、导入老计划都是机会）。
// ★ 清空任一侧 = 清空这条转发器的频率：联动态下两个框显示的本就是同一个量，只清一半会自相矛盾。
export function setChannelFc(plan, ch, side, v) {
  if (!ch) return
  const x = num(v)
  if (side !== 'dn') { ch.up.fcMHz = x; return }
  if (isDnLinked(plan, ch)) {
    ch.up.fcMHz = x == null ? null : upFromDn(x, loValueOf(plan, ch))
    ch.dn.fcMHz = null          // 仍留在联动态：进出解耦只由 setDnDecoupled 一处发生
    return
  }
  ch.dn.fcMHz = x
}

// 解耦 / 复联 —— cross-strap 的那个开关。是「填了没填」之外的一个显式意图：
// 填了值不等于想解耦（多半只是想从下行这一侧录），故不再拿它当判据。
// 解耦时把当前推算值落成显式值：不落的话一勾开关下行就空了，人得照着刚才的读数再敲一遍。
export function setDnDecoupled(plan, ch, off) {
  if (!ch) return
  if (off) { if (!Number.isFinite(ch.dn.fcMHz)) ch.dn.fcMHz = downlinkFc(plan, ch) }
  else ch.dn.fcMHz = null
}
// 上行带宽：通道自填优先，留空则取所属「波束/带宽」组的标称带宽。
// 与下行频率「留空 = 推算 / 填值 = 显式」同一个口径 —— 一排同组转发器的带宽只在波束上填一次，
// 个别不等宽的转发器再在自己那行覆盖。
export function uplinkBw(plan, ch) {
  if (Number.isFinite(ch?.up?.bwMHz)) return ch.up.bwMHz
  // 多波束时取第一个给了标称带宽的波束。带宽是「这条转发器多宽」的物理量，同一条转发器落在
  // 几个波束里也只有一个宽度；几个波束的标称值不一致时由 beamBwMismatch 提示，这里不做静默平均。
  for (const bm of channelBeams(plan, ch, 'up')) if (Number.isFinite(bm.bwMHz)) return bm.bwMHz
  return null
}
// 下行带宽默认跟上行（转发器收发带宽一致是常态；不一致时 dn.bwMHz 显式填）
export function downlinkBw(plan, ch) {
  if (Number.isFinite(ch?.dn?.bwMHz)) return ch.dn.bwMHz
  return uplinkBw(plan, ch)
}

// 带宽录入的收口（side = 'up' | 'dn'）。上行直落；下行分两种：
//   · 已显式解耦带宽（dn.bwMHz 有值 —— 收发不等宽的那种）→ 落在下行自己身上；
//   · 未解耦（常态：下行带宽跟着上行）→ 落到上行。「改下行带宽 = 改这条转发器的带宽」，与联动态下
//     「改下行频率其实是在改上行」是同一套读法：同一个物理量只存一份，不在两侧各存一遍。
export function setChannelBw(plan, ch, side, v) {
  if (!ch) return
  const x = num(v)
  if (side === 'dn' && Number.isFinite(ch.dn?.bwMHz)) { ch.dn.bwMHz = x; return }
  ch.up.bwMHz = x
}

// ---- 频带两端：起止频率 ----
//
// 「中心 + 带宽」与「起始 + 终止」是同一段频带的两种写法 —— 四个数、两个自由度：
//     f1 = fc − bw/2 ·  f2 = fc + bw/2    ⇄    fc = (f1 + f2)/2 ·  bw = f2 − f1
// 手上的频率计划表两种口径都有（「13932~14112」与「中心 14022 / 180 MHz」），故两套都能直接录，
// 不必让人先自己做一次加减（同批量生成那个「起始频率」的道理，见 genSeries）。内部仍只存中心 + 带宽。
//
// 联动口径照搬频谱仪的 Start/Stop：
//   · 改中心 → 带宽不动、两端一起挪；改带宽 → 中心不动、两端对称张缩（这两条本就是既有行为）；
//   · 改一端 → 【另一端钉住】，中心与带宽一并重算 —— 这才是「起止」区别于「中心」的地方：
//     照着一张起止频率表逐格录进去，两格填完这条转发器就正好落在那段频带上。
// 另有两条例外，都是「另一端无从钉住」时唯一可做之事，故不算分歧：
//   · 带宽未定（自填与波束组继承都没有）→ 中心钉住，由这一端到中心的距离定出半带宽；
//   · 填的这一端越过了另一端 → 不生成负宽频带，改按「带宽不变、整条频带平移到这一端」处理
//     （把一条转发器整段挪到新起点，本就是照着起止录时的另一种常见意图）。界面在这一下要说明一句。

// 某一侧当前的频带两端。带宽未定 → 两端为 null 而不是 fc 本身：拿零宽频带的两端顶上来，
// 界面上会显示两个看着像真的边沿（resolveChannel 里那个 half=0 是给画图用的，不是录入口径）。
export function channelEdges(plan, ch, side = 'up') {
  const fcRaw = side === 'dn' ? downlinkFc(plan, ch) : ch?.up?.fcMHz
  const bwRaw = side === 'dn' ? downlinkBw(plan, ch) : uplinkBw(plan, ch)
  const fc = Number.isFinite(fcRaw) ? fcRaw : null
  const bw = Number.isFinite(bwRaw) ? bwRaw : null
  const both = fc != null && bw != null
  return {
    fc,
    bw,
    f1: both ? cleanFreq(fc - bw / 2) : null,
    f2: both ? cleanFreq(fc + bw / 2) : null
  }
}

// 录入一端。which = 'f1'（起始/低端）| 'f2'（终止/高端）。返回这一次走的是哪条分支：
//   'resize' 另一端钉住、带宽随之变（常态）   · 'shift' 越过另一端 → 带宽不变、整条频带平移
//   'span'   带宽未定 → 中心钉住、定出带宽   · 'set'   中心未定 → 由这一端 + 带宽落定整条频带
//   null     没落值（空值 / 数值不成立）
// 界面据 'shift' 说明一句：那一下的结果与「另一端钉住」不同，不讲人会以为自己填错了。
export function setChannelEdge(plan, ch, side, which, v) {
  if (!ch) return null
  const x = num(v)
  // 起止两格不吃空值：清空一条转发器的频率去清中心频率那一格（那里两侧同清，见 setChannelFc）
  if (x == null) return null
  const lo = which !== 'f2'
  const { fc, bw, f1, f2 } = channelEdges(plan, ch, side)
  const put = (nfc, nbw) => {
    setChannelFc(plan, ch, side, cleanFreq(nfc))      // 上下行联动仍走唯一收口
    if (nbw != null) setChannelBw(plan, ch, side, cleanFreq(nbw))
  }
  if (fc == null) {
    if (bw == null) return null                       // 中心与带宽都还没有 —— 一端定不出一段频带
    put(lo ? x + bw / 2 : x - bw / 2, null)
    return 'set'
  }
  if (bw == null) {
    const nbw = (lo ? fc - x : x - fc) * 2
    if (!(nbw > 0)) return null                       // 起始填到中心之上（或反之）→ 负宽，不落
    put(fc, nbw)
    return 'span'
  }
  const other = lo ? f2 : f1
  const nbw = lo ? other - x : x - other
  if (nbw > 0) { put((x + other) / 2, nbw); return 'resize' }
  put(lo ? x + bw / 2 : x - bw / 2, null)
  return 'shift'
}

// 通道 → 画图与校验都吃的这一份解析结果。f1/f2 为频段两端（含边界），null 表示该侧未定义。
export function resolveChannel(plan, ch) {
  const upFc = Number.isFinite(ch?.up?.fcMHz) ? ch.up.fcMHz : null
  const upBw = uplinkBw(plan, ch)
  const dnFc = downlinkFc(plan, ch)
  const dnBw = downlinkBw(plan, ch)
  const beamsUp = channelBeams(plan, ch, 'up')
  const beamsDn = channelBeams(plan, ch, 'dn')
  const half = (bw) => (Number.isFinite(bw) ? bw / 2 : 0)
  return {
    id: ch.id,
    no: ch.no,
    kind: ch.kind,
    up: upFc == null ? null : { fc: upFc, bw: upBw, f1: upFc - half(upBw), f2: upFc + half(upBw), pol: ch.up.pol },
    dn: dnFc == null ? null : { fc: dnFc, bw: dnBw, f1: dnFc - half(dnBw), f2: dnFc + half(dnBw), pol: ch.dn.pol },
    // 下行是推算出来的还是显式填的——渲染端据此给 cross-strap 通道加标记
    dnDerived: !Number.isFinite(ch?.dn?.fcMHz) && dnFc != null,
    // 带宽是自填的还是从「波束/带宽」组继承的——界面据此把继承值显示成灰底占位
    bwFromBeam: !Number.isFinite(ch?.up?.bwMHz) && upBw != null,
    lo: findLo(plan, ch.loId),
    // 波束一律以集合示人。曾并存一个单值 beamUp/beamDn（= 集合第一个）当兼容口，
    // 改完之后无人再读，只会让下一个人以为「主波束」是个模型概念——已去掉。
    // 确实要「第一个」的地方（带宽继承）自己取 [0]，取的是哪一个当场看得见。
    beamsUp,
    beamsDn,
    raw: ch
  }
}

export const resolveAll = (plan) => (plan.channels || []).map((ch) => resolveChannel(plan, ch))

// 频段跨度：给渲染器定坐标轴。side='up'|'dn'，留 padRatio 的边距。
export function planExtent(plan, side, padRatio = 0.02) {
  const vals = []
  for (const r of resolveAll(plan)) {
    const s = side === 'dn' ? r.dn : r.up
    if (!s) continue
    vals.push(s.f1, s.f2)
  }
  if (!vals.length) return null
  let lo = Math.min(...vals), hi = Math.max(...vals)
  if (hi - lo < 1e-6) { lo -= 1; hi += 1 }
  const pad = (hi - lo) * padRatio
  return { min: lo - pad, max: hi + pad, dataMin: lo, dataMax: hi }
}

// ---- 序列生成（录入的主入口）----

// 图上一排转发器几乎总是等差的（C 段 40MHz 间隔、Ku 段 41.5MHz 间隔…）。
// 给「首个中心频率 + 频率间隔 + 数量」即可批量建通道，编号与极化按规则铺开。
//   ★ startFcMHz 是第一个转发器的【中心频率】—— 与模型内部一致。界面上人填的是频带下边沿
//     （「起始频率」），边沿 → 中心的换算在录入口做（见 FreqPlanApp 的 runGen），不在这里。
//   pol: 一排全同。★ 不设「逐个交替 H,V,H,V」这类模式——真实计划里换极化的那一排，编号与起始频率
//     本就另起一套，分两批生成比在这儿塞个交替开关直白，也不会生出「交替出来的那半排编号怎么排」的歧义。
//   dnPol: 下行极化。留空 = 取上行的正交极化（转发器翻极化的常见接法）；给字母 = 一排全按它。
//   noPattern: 'C{n}' 之类的模板，{n} 替换为序号；也可给数组逐个指定
export function genSeries(spec = {}) {
  const {
    count = 1, startFcMHz = 0, stepMHz = 0, bwMHz = 36,
    pol = 'H', dnPol = null,
    loId = '', beamUpIds = null, beamDnIds = null, beamUpId = '', beamDnId = '', kind = 'transponder',
    noStart = 1, noPattern = '{n}', noList = null, noStep = 1
  } = spec
  // 批量生成的一排转发器共用同一组波束（多选即多色片）。老调用方传单值 beamUpId 的照收。
  const upIds = beamIdList(beamUpIds, beamUpId)
  const dnIds = beamIdList(beamDnIds, beamDnId)
  const out = []
  const n = Math.max(0, Math.min(512, Math.floor(count)))
  const dp = POLS.includes(dnPol) ? dnPol : (POL_ORTHO[pol] || 'V')
  for (let i = 0; i < n; i++) {
    const no = Array.isArray(noList) && noList[i] != null
      ? String(noList[i])
      : String(noPattern).replace(/\{n\}/g, String(noStart + i * noStep))
    out.push(newChannel({
      no, kind, loId, beamUpIds: upIds, beamDnIds: dnIds,
      up: { fcMHz: startFcMHz + i * stepMHz, bwMHz, pol },
      dn: { fcMHz: null, bwMHz: null, pol: dp }
    }))
  }
  return out
}

// 频段名单：按频率自低到高，与 guessBand 的输出一一对应（界面那个下拉就取这一份）。
export const BANDS = ['L', 'S', 'C', 'X', 'Ku', 'Ka', 'Q', 'V']

// 频段猜测：按卫星固定业务的实际划分，不按「S 段是 2~4 GHz」这种泛频段定义——
// 3.4~4.2 GHz 是 C 段下行而非 S 段，边界卡在 3 GHz 上。这是频段的【默认】取值（plan.bandAuto），
// 人也可以在界面上手选钉死；两种情形下 band 都只进汇总行与计划列表的那一行说明，
// 不参与任何几何或校验，故手选不会与图上的频率打架。
export function guessBand(fMHz) {
  const f = Number(fMHz)
  if (!Number.isFinite(f)) return 'Ku'
  if (f < 2000) return 'L'
  if (f < 3000) return 'S'          // S 段：上行 2.025~2.11、下行 2.2~2.29 GHz
  if (f < 5000) return 'C'          // C 段下行 3.4~4.2 GHz
  if (f < 7100) return 'C'          // C 段上行 5.85~6.725 GHz
  if (f < 9000) return 'X'
  if (f < 15500) return 'Ku'        // Ku 下行 10.7~12.75 / 上行 12.75~14.5 GHz
  if (f < 40000) return 'Ka'        // Ka 下行 17.7~21.2 / 上行 27.5~31 GHz
  if (f < 50000) return 'Q'
  return 'V'
}

// ---- 校验 ----
// 只出数值与定位，不下文字结论（遵循平台「结果输出纯数字」口径）：每条 issue 给出
// 严重度 + 涉及通道 + 两个可比对的数，判断留给人。

const OVERLAP_EPS = 1e-6

export function validatePlan(plan) {
  const issues = []
  const rs = resolveAll(plan)
  const add = (severity, code, msg, refs, nums) => issues.push({ severity, code, msg, refs: refs || [], nums: nums || null })

  for (const r of rs) {
    if (!r.up && !r.dn) add('warn', 'empty', `通道 ${r.no || r.id} 上下行皆无频率`, [r.id])
    if (r.up && !Number.isFinite(r.up.bw)) add('warn', 'nobw', `通道 ${r.no} 未给带宽`, [r.id])
    if (r.up && !r.lo && !Number.isFinite(r.raw.dn.fcMHz)) {
      add('warn', 'nolo', `通道 ${r.no} 未指定 LO 且未显式给下行频率 — 下行无法定位`, [r.id])
    }
    // 下行落到负频率/异常低频 = LO 填错的典型症状
    if (r.dn && r.dn.fc <= 0) add('error', 'badlo', `通道 ${r.no} 下行频率 ${r.dn.fc.toFixed(2)} MHz ≤ 0`, [r.id], { dn: r.dn.fc })
  }

  // 同侧同极化的频段重叠（正交极化重叠 = 合法的极化复用，不报）
  for (const side of ['up', 'dn']) {
    const segs = rs.map((r) => ({ r, s: side === 'up' ? r.up : r.dn })).filter((x) => x.s && Number.isFinite(x.s.bw))
    segs.sort((a, b) => a.s.f1 - b.s.f1)
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (segs[j].s.f1 >= segs[i].s.f2 - OVERLAP_EPS) break   // 已排序，后面的更不会重叠
        if (segs[i].s.pol !== segs[j].s.pol) continue           // 正交/异极化 → 复用，放行
        const ov = Math.min(segs[i].s.f2, segs[j].s.f2) - Math.max(segs[i].s.f1, segs[j].s.f1)
        if (ov > OVERLAP_EPS) {
          add('error', 'overlap',
            `${side === 'up' ? '上行' : '下行'} ${segs[i].r.no} 与 ${segs[j].r.no} 同极化 ${segs[i].s.pol} 重叠 ${ov.toFixed(2)} MHz`,
            [segs[i].r.id, segs[j].r.id], { overlapMHz: ov })
        }
      }
    }
  }

  // LO 一致性：显式填了下行频率的通道，若同时也挂了 LO，两者对不上就提示（cross-strap 属正常，
  // 故只报 info，由人判断是「真 cross-strap」还是「数字录错」）
  for (const r of rs) {
    if (!Number.isFinite(r.raw.dn.fcMHz) || !r.lo || !Number.isFinite(r.lo.valueMHz) || !r.up) continue
    const derived = r.up.fc - r.lo.valueMHz
    const d = Math.abs(derived - r.raw.dn.fcMHz)
    if (d > 0.05) {
      add('info', 'loMismatch',
        `通道 ${r.no} 显式下行 ${r.raw.dn.fcMHz} MHz 与 LO 推算 ${derived.toFixed(2)} MHz 差 ${d.toFixed(2)} MHz`,
        [r.id], { explicit: r.raw.dn.fcMHz, derived, deltaMHz: d })
    }
  }

  // 自填带宽与所属「波束/带宽」组的标称值不一致。图例上写的是组带宽、块宽画的是自填带宽，
  // 两者不等时图会自相矛盾——但个别转发器确实可以不等宽，故只报 info 由人判断。
  // 多波束时逐个波束比：一条转发器落在几个波束里，任何一个波束的标称值对不上都该提示，
  // 只比第一个会让「后面那个波束填错了」永远不出声。
  for (const r of rs) {
    if (!Number.isFinite(r.raw?.up?.bwMHz)) continue
    for (const g of r.beamsUp) {
      if (!Number.isFinite(g.bwMHz)) continue
      const d = Math.abs(r.raw.up.bwMHz - g.bwMHz)
      if (d > 1e-6) {
        add('info', 'beamBwMismatch',
          `通道 ${r.no} 带宽 ${r.raw.up.bwMHz} MHz 与「${beamLabel(g)}」标称 ${g.bwMHz} MHz 差 ${d.toFixed(2)} MHz`,
          [r.id], { channelBwMHz: r.raw.up.bwMHz, beamBwMHz: g.bwMHz, deltaMHz: d })
      }
    }
  }

  // 编号重复（图上编号是人读图的唯一锚点，重了必是录入笔误）
  const byNo = new Map()
  for (const r of rs) {
    if (!r.no) continue
    if (byNo.has(r.no)) add('warn', 'dupNo', `编号 ${r.no} 重复`, [byNo.get(r.no), r.id])
    else byNo.set(r.no, r.id)
  }
  return issues
}

export const errorCount = (issues) => issues.filter((i) => i.severity === 'error').length

// ---- 查询：给链路预算引用用 ----

// 按编号取通道（链路表里存的是编号，取用时解引用）
export const channelByNo = (plan, no) => (plan.channels || []).find((c) => String(c.no) === String(no)) || null

// 某频率落在哪个通道内（「这条载波落在哪个转发器」用它）
export function channelAtFreq(plan, fMHz, side = 'up', pol = null) {
  const f = Number(fMHz)
  if (!Number.isFinite(f)) return null
  for (const r of resolveAll(plan)) {
    const s = side === 'dn' ? r.dn : r.up
    if (!s || !Number.isFinite(s.bw)) continue
    if (pol && s.pol !== pol) continue
    if (f >= s.f1 - OVERLAP_EPS && f <= s.f2 + OVERLAP_EPS) return r
  }
  return null
}

// 频率计划 → 链路预算卫星字段。这是「引用」的口径咽喉：链路预算只认这五项 + 可选的转发器属性。
export function channelToLinkFields(plan, ch) {
  const r = resolveChannel(plan, ch)
  const out = {}
  if (r.up) {
    out.centerFrequency = toGHz(r.up.fc)      // 链路预算的频率字段单位是 GHz
    out.uplinkPolarization = r.up.pol
  }
  if (r.dn) {
    out.rxCenterFrequency = toGHz(r.dn.fc)
    out.downlinkPolarization = r.dn.pol
  }
  const bw = r.up?.bw ?? r.dn?.bw
  if (Number.isFinite(bw)) out.transponderBandwidth = bw   // 转发器带宽单位是 MHz
  if (Number.isFinite(ch.sfdDbwm2)) out.sfdRef = ch.sfdDbwm2
  if (Number.isFinite(ch.gtDbK)) out.sfdGtRef = ch.gtDbK
  if (Number.isFinite(ch.boiDb)) out.BOi = ch.boiDb
  if (Number.isFinite(ch.booDb)) out.BOo = ch.booDb
  if (Number.isFinite(ch.cimDb)) out.xpdrIntermodFactor = ch.cimDb
  return out
}

// 摘要（文件区列表与库条目一行速览）
export function planSummary(plan) {
  const chs = plan.channels || []
  const tp = chs.filter((c) => c.kind === 'transponder')
  // 走解析后的带宽——自填的和从波束组继承的都要算进来，否则「只在波束上填了带宽」的计划摘要空一截
  const bws = tp.map((c) => uplinkBw(plan, c)).filter(Number.isFinite)
  const ext = planExtent(plan, 'up', 0)
  const parts = [`${plan.band || '—'} 频段`, `${tp.length} 转发器`]
  if (bws.length) {
    const uniq = [...new Set(bws.map((b) => Math.round(b * 100) / 100))]
    parts.push(uniq.length === 1 ? `${uniq[0]} MHz` : `${Math.min(...bws)}~${Math.max(...bws)} MHz`)
  }
  if (ext) parts.push(`↑${(ext.dataMin / 1000).toFixed(2)}~${(ext.dataMax / 1000).toFixed(2)} GHz`)
  if (plan.beams?.length) parts.push(`${plan.beams.length} 波束`)
  return parts.join(' · ')
}
