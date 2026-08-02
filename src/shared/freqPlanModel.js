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

// 显示单位：整份计划（图上的频率标注与图例、转发器表的频率/带宽两列、检查器、批量条、批量生成、
// LO、频率分配表、校验条目）共用一个刻度，由工具栏那一个下拉定。图上一排转发器的标称带宽有 36 MHz
// （常规）、250 kHz（窄带/信道化）、1 GHz（宽带 Ka）三种量级，故单位可选。
// 内部仍一律 MHz —— 单位只是「录入与显示用哪个刻度」，换单位不改物理量：14000 MHz 切到 kHz
// 就写成 14000000 kHz，那条转发器还在原处。
// ★ 曾经波束那行自带一个单位下拉，与工具栏那个并存：同一张图两处单位互不相干，图例写 kHz、
//   轴上写 MHz，读者得自己换算。单位只留一处。
// ★★ 也曾只有【图 + 波束带宽录入】跟着这个下拉走，表与检查器里的那些格恒写 MHz：选了 kHz 之后
//   图例写 36000、表里写 36，同一个量在同一屏上两个数。刻度是整份计划的属性，不是某个控件的。
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
// 频率与带宽在同一把刻度上，换算就是同一次乘除，故共用上面那一对函数；另起两个名字只为读代码时
// 看得出换的是哪个量（录入口一律走这两个：显示 = freqFromMHz，落值 = freqToMHz）。
export const freqToMHz = bwToMHz
export const freqFromMHz = bwFromMHz

// 频率 → 读数文字。小数位随单位走：这类图的分辨率是 0.01 MHz，故 MHz 给 2 位，往大刻度换
// 一档就补 3 位（GHz 5 位——Ku 上行 14.0225 GHz 这种少一位就丢信息；THz 8 位），往小刻度换
// 直接取整（Hz/kHz 再带小数是噪声）。尾零一律剪掉，14.0000 GHz 写成 14。
// ★ 图上（freqPlanRender 的 fmtFreq）、屏上表格与校验条目共用这一个，各写一遍必漂。
// ★ 只用于「写给人看的读数」，不用于输入框的 :value —— 定小数位会把正在敲的字改掉（见
//   FreqPlanApp 的 numDraft），录入那一路走 freqFromMHz 拿原数。
export function fmtFreqNum(mhz, unit = 'MHz') {
  if (!Number.isFinite(mhz)) return ''
  const f = unitFactorMHz(unit)
  const dec = Math.min(9, Math.max(0, Math.round(Math.log10(f)) + 2))
  const s = (mhz / f).toFixed(dec)
  // 只在有小数点时剪尾零 —— 整数串上剪会把 14000 剪成 14
  return dec ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}
// 「数 + 单位」一体的读数（校验条目、提示语、批量条的回执共用），免得每处各拼一遍
export const fmtFreqU = (mhz, unit = 'MHz') => {
  const s = fmtFreqNum(mhz, unit)
  return s === '' ? '—' : `${s} ${unitLabel(unit)}`
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

// 通道类型。★ 信标 / 遥控 / 遥测【不是窄一点的转发器】—— 它们是不载业务的等幅波：没有带宽可画、
// 不经转发器变频、也不归波束，一条上只有【频率 + 极化】两项。国际上通行的画法因此不是色块而是
// 【频率轴上的一根箭头】（各家频率计划图与卫星系统附图里标 TM/TC 的都是这根箭头），故这两类在
// 模型里分开记，两个属性就够：
//   mark = 画成箭头（无带宽 · 无波束 · 无 LO）
//   side = 它在哪一侧 —— 信标与遥测是星上发的（下行），遥控是地面发的（上行）。转发器两侧都有，
//          故没有这个字段；「保留/其他」是一段真占着的频率（仍是色块），同样没有。
//   tag  = 图上那行注记的前缀（图上文字一律英文，见 freqPlanRender 文件头）
export const CHANNEL_KINDS = [
  { key: 'transponder', label: '转发器' },
  { key: 'beacon', label: '信标', mark: true, side: 'dn', tag: 'BEACON' },
  { key: 'tc', label: '遥控 TC', mark: true, side: 'up', tag: 'TC' },
  { key: 'tm', label: '遥测 TM', mark: true, side: 'dn', tag: 'TM' },
  { key: 'reserved', label: '保留/其他' }
]
export const KIND_LABEL = Object.fromEntries(CHANNEL_KINDS.map((k) => [k.key, k.label]))
const KIND_OF = Object.fromEntries(CHANNEL_KINDS.map((k) => [k.key, k]))
/** 标记类载波（信标 / 遥控 / 遥测）：图上一根箭头，只有频率与极化 */
export const MARK_KINDS = CHANNEL_KINDS.filter((k) => k.mark)
export const isMarkKind = (kind) => !!KIND_OF[kind]?.mark
export const isMark = (ch) => isMarkKind(ch?.kind)
/** 该类型落在哪一侧（'up' | 'dn'）；转发器 / 保留两侧都有 → '' */
export const markSide = (kind) => KIND_OF[kind]?.side || ''
export const kindTag = (kind) => KIND_OF[kind]?.tag || ''

// 波束默认配色：取自标准计划图的惯用色（红=区域、黄=全球、绿=东部、蓝=点波束）。
export const DEFAULT_BEAM_COLORS = ['#4472C4', '#E03C31', '#F2C200', '#2E9E5B', '#8E5BC4', '#E07B39', '#4BB3C4', '#C4547E']

// ---- 建模 ----

// 「波束/带宽」组。标准计划图的图例条目是【颜色 + 波束 + 带宽】（■ 中国波束：36 MHz）——
// 一种颜色标的既是覆盖也是这一组转发器的标称带宽，所以带宽是这里的属性，不只是转发器的属性。
// bwMHz 内部一律 MHz；用哪个刻度写不是波束的属性（老计划里的 bwUnit 读进来直接丢弃），
// 整张图跟工具栏那一个单位走。
// ★ 曾有过一个 code（图例前缀「A：」），与波束名是同一件事的两种写法，图例上并排写成
//   「A：中国波束 36 MHz」更像编号没删干净，已去掉——认波束靠名字与颜色。
//
// ★★ 这里【不设频率】（2026-08-02 用户拍板）：波束只管「叫什么、多宽」，具体占哪一段频率是
//   【单条转发器】的事（见「波束占段」：ch.beamSeg 逐波束录起止，排布档 ch.beamLayout 定同频叠加
//   还是频分排布）。判据是编排的现场——人一次编排一条转发器，「这条 36 MHz 分给哪几个波束、各占
//   哪一截」在那条转发器上一眼看得全；摊到波束身上则要在几十条转发器之间来回对。
//   曾有过一版把起止上提到波束自己身上（f1MHz/mode/bands + 下行那一套），已整体撤回，老计划里
//   存过的那些段在 normalizePlan 里【迁移成各转发器的占段】（migrateBeamBands），画出来的图不变。
//
// ★★★ 带宽只有一个数（2026-08-02 用户拍板）：曾有过上下行两格（dnBwMHz 留空 = 同上行），
//   收发不等宽的波束（18 上 / 36 下）才填 —— 那是【某条转发器上那一段】的事，占段表里两侧
//   本就各录各的（beamSeg 的 dnBwMHz），标称带宽再分两格就是同一件事记两处。
//   同期删掉的还有【备注】：图上不画，色号那类身份说明留在 synth 里（beamSynthText 读得出）。
export function newBeam(patch = {}) {
  return {
    id: patch.id || genId('b'),
    // 老计划只填了代号没填名字的，代号顶上来当名字，别让条目变成一行空白。
    // 兜底名走英文：波束名直接进图例，系统给的默认值不该在一张英文图上写中文（人改成中文名当然照画）
    name: patch.name || patch.code || 'Beam',
    color: patch.color || DEFAULT_BEAM_COLORS[0],
    bwMHz: num(patch.bwMHz),
    synth: normSynth(patch.synth)
  }
}

// 波束合成来源（可选）：这一条是从波束合成的某个组导来的。
// { groupId, group, fc, beamId, nos } —— nos = 这一条覆盖的【波束代号】（整星连续编号，
// 同时也是导进来时的名字），fc = 频率复用色号（0 基，界面写 F(fc+1)）。
// ★ **同色的波束合并成一条**：同色 = 同频同极化，频率上本就是一件事，一个色分几条会让同一段
//   频率在表里出现几遍。故一条 = 一个色（nos 有几个就是几个波束共用它），配对键是 fc；
//   未配色的波束没法按色合并，逐个成条，配对键是 beamId。
// ★ 存的只是这一条的【身份】：几何（在哪、多宽）留在波束合成那边，频率（占哪一段、多宽）留在
//   这边，两处各存各的一半。老计划没有这个字段，读进来是 null，行为与从前逐字节相同。
function normSynth(raw) {
  if (!raw || typeof raw !== 'object') return null
  const fc = Number(raw.fc)
  const nos = (Array.isArray(raw.nos) ? raw.nos : [])
    .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
  const groupId = raw.groupId ? String(raw.groupId) : ''
  const beamId = raw.beamId ? String(raw.beamId) : ''
  // 全空 = 不是导入来的（空壳会让界面画出一个没有来源的来源标记）
  if (!groupId && !beamId && !nos.length && !Number.isInteger(fc)) return null
  return {
    groupId,
    group: raw.group ? String(raw.group) : '',
    fc: Number.isInteger(fc) && fc >= 0 ? fc : null,
    beamId,
    nos
  }
}

/** 频率复用色号的写法：0 基存、界面写 F1 起（与波束合成那边的图例、色片同一套） */
export const fcLabel = (fc) => (Number.isInteger(fc) && fc >= 0 ? `F${fc + 1}` : '')

/**
 * 波束代号串的紧凑写法：连号收成区间，[1,2,3,7,9,10] → '1-3,7,9,10'
 * （三个起才收 —— 两个连号写成 '9-10' 与 '9,10' 一样长，收了反而多一层读法）。
 * 这就是从波束合成导进来的那一条的【名字】：一个色覆盖哪几个波束，名字直接写出来。
 */
export function fmtBeamNos(nos) {
  const list = (Array.isArray(nos) ? nos : []).filter((n) => Number.isInteger(n)).sort((a, b) => a - b)
  const out = []
  for (let i = 0; i < list.length;) {
    let j = i
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++
    out.push(j > i + 1 ? `${list[i]}-${list[j]}` : list.slice(i, j + 1).join(','))
    i = j + 1
  }
  return out.join(',')
}

/** 这一条的来源读数：「波束合成「组名」· F3 · 9 个波束：1-3,7,9,10」；不是导入来的 → 空串 */
export function beamSynthText(bm) {
  const s = bm && bm.synth
  if (!s) return ''
  const parts = [s.group ? `波束合成「${s.group}」` : '波束合成']
  if (s.fc != null) parts.push(fcLabel(s.fc))
  if (s.nos.length) parts.push(`${s.nos.length} 个波束：${fmtBeamNos(s.nos)}`)
  return parts.join(' · ')
}

// 标称带宽：上下行一个数。收发不等宽是【某条转发器上那一段】的事（占段表两侧各录各的），
// 不在波束身上分两格 —— 同一个量不记两处。
export function beamBw(bm) {
  return Number.isFinite(bm?.bwMHz) ? bm.bwMHz : null
}
// 带宽录入。位置不在这里 —— 段位是转发器的事（见「波束占段」），波束只管「多宽」。
export function setBeamBw(bm, v) {
  if (!bm) return
  bm.bwMHz = num(v)
}

// 图例 / 下拉 / 表格三处共用的一行标签，口径只在这里定义：「波束名: 带宽」。
// unit = 图上当前单位，三处都把它传进来，标签与轴上的数才是同一把刻度。
// ★ 分隔符是半角冒号：这行标签会原样画进导出的图，而图上系统给的那部分一律走西文
//   （见 freqPlanRender 文件头）——全角「：」在一张英文版式的图上是唯一的中文标点。
export function beamLabel(bm, unit = 'MHz') {
  if (!bm) return ''
  const name = bm.name || ''
  const bw = beamBw(bm)
  return bw != null ? `${name}: ${fmtFreqNum(bw, unit)} ${unitLabel(unit)}` : name
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

// 占段表归一：只留四个数值字段，全空的条目直接丢掉（空条目会让「有没有人显式设过」判成有）。
// 下行两项留空 = 随上行（段内格局不变、整段随 LO 平移），老计划没有它们，读进来逐字节相同。
function normSeg(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, v] of Object.entries(raw)) {
    if (!id || !v || typeof v !== 'object') continue
    const off = num(v.offMHz), bw = num(v.bwMHz)
    const dnOff = num(v.dnOffMHz), dnBw = num(v.dnBwMHz)
    if (off == null && bw == null && dnOff == null && dnBw == null) continue
    out[id] = { offMHz: off, bwMHz: bw, dnOffMHz: dnOff, dnBwMHz: dnBw }
  }
  return out
}

// 一条转发器的频带在几个波束之间怎么摆（没有逐个录过占段的那些）。三档，见 beamSegs：
//   'auto'  自适应 —— 人人有带宽且装得下就频分排布，装不下就同频叠加（老口径，默认）
//   'tile'  频分排布 —— 自频带下边沿依次紧排（HTS）；装不下也照排，探出的由校验 segOut 指出来
//   'stack' 同频叠加 —— 各自贴频带下边沿、各占各的带宽（常规多波束转发器 / 频率复用）
const LAYOUTS = ['auto', 'tile', 'stack']
export const BEAM_LAYOUTS = [
  { key: 'auto', label: '自适应' },
  { key: 'tile', label: '频分排布' },
  { key: 'stack', label: '同频叠加' }
]
export const beamLayoutOf = (ch) => (LAYOUTS.includes(ch?.beamLayout) ? ch.beamLayout : 'auto')

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
      // 标记类载波（信标 / 遥控 / 遥测）在轴上占的那一格（「间隔带宽」，见 resolveChannel）。
      // 与 bwMHz 分开存：转发器的带宽与信标占的那一格是两回事，共用一格会互相污染
      // （类型改来改去时，一条 36 MHz 转发器会变成占 36 MHz 的信标）。
      slotMHz: num(up.slotMHz),
      pol: POLS.includes(up.pol) ? up.pol : 'H'
    },
    loId: patch.loId || '',
    // 全 null = 由 LO 推算；填任意一项即以填的为准（cross-strap / 下行重排 / 收发带宽不等）
    dn: {
      fcMHz: num(dn.fcMHz),
      bwMHz: num(dn.bwMHz),
      slotMHz: num(dn.slotMHz),
      pol: POLS.includes(dn.pol) ? dn.pol : (POL_ORTHO[up.pol] || 'V')
    },
    // 上行波束集合（≥2 个 → 图上该块画成多色片）。下行留空 = 跟上行同一组波束。
    beamUpIds: beamIdList(patch.beamUpIds, patch.beamUpId, patch.switchableBeamIds),
    beamDnIds: beamIdList(patch.beamDnIds, patch.beamDnId),
    // 波束在本转发器频带内的占段（见下面「波束占段」那一段）：
    // { 波束id: { offMHz, bwMHz, dnOffMHz, dnBwMHz } }，各项都可留空（留空 = 自动 / 随上行）。
    // ★ 这是【界面上唯一的频率录入口】：波束只有名字与标称带宽，占哪一段是逐条转发器的事。
    beamSeg: normSeg(patch.beamSeg),
    // 没逐个录过占段的那些波束怎么摆（自适应 / 频分排布 / 同频叠加，见 beamSegs）
    beamLayout: LAYOUTS.includes(patch.beamLayout) ? patch.beamLayout : 'auto',
    // 这条转发器的载波默认归哪个波束。★ 只在几个波束【同频叠放】（各占整条频带）时说了算：
    // 那种转发器频率上分不出谁是谁，只能指定一个（图上画成上下分色的块）。频带被切开的
    // （图上左右分色）按频率认领，不看这一项。留空 = 第一个波束；逐条载波仍可另行钉死。
    carrierBeamId: patch.carrierBeamId || '',
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
    // 占段表里指向「已不在本通道」的波束的条目一并清掉：留着不显形却会被 hasExplicitSeg 认成
    // 「有人显式设过」，于是这条转发器再也回不到同频共用的画法（症状是删掉一个波束后图突然变了）
    for (const id of Object.keys(ch.beamSeg)) {
      if (!ch.beamUpIds.includes(id) && !ch.beamDnIds.includes(id)) delete ch.beamSeg[id]
    }
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
    // 信标 / 遥控 / 遥测折到它那一侧（老计划把它们录在上行那一格是常事，见 foldMark）
    foldMark(p, ch)
  }
  migrateBeamBands(p, raw)
  return p
}

// 老计划迁移：频段曾经录在【波束】身上（f1MHz/mode/bands + dnF1MHz/dnMode/dnBands，2026-07-31 至
// 2026-08-02），现在录在【转发器】的占段上。这里把那些绝对频段换算成各转发器的偏移落进 beamSeg ——
// 画出来的图不变，人接着在转发器那边改。
// ★ 只处理【与该转发器频带真的搭界】的那一段：波束钉的段可能横跨几条转发器（老口径下别的段在
//   别的转发器里），落到这一条上的就是沾得着的那一段。一段都不沾的仍落第一段 —— 老口径下它照样
//   出现在这条转发器上（画不出片、由校验的 segOut 指出来），迁移不该把这个错悄悄抹掉。
// ★★ 一个波束在同一条转发器里被切成两块（老口径能表达、新结构一个波束一段）—— 取沾得着的第一段，
//   另几块由 segFree 报成「还有多少没分出去」。这是这次结构简化的诚实边界。
// 迁移是幂等的：存盘之后波束上不再有那些字段，下次读进来直接跳过。
function migrateBeamBands(p, raw) {
  const legacy = new Map()
  for (const b of (raw.beams || [])) {
    if (!b || !b.id) continue
    // 老计划的波束曾有过下行标称带宽（dnBwMHz，已删）：迁移时仍认它，那些段当年就是按它画的
    const nom = (side) => {
      const v = side === 'dn' && Number.isFinite(num(b.dnBwMHz)) ? num(b.dnBwMHz) : num(b.bwMHz)
      return Number.isFinite(v) ? v : null
    }
    const bandsOf = (side) => {
      const fixed = side === 'dn' ? b.dnMode === 'fixed' : b.mode === 'fixed'
      if (!fixed) return []
      const out = []
      const w = nom(side)
      const f1 = num(side === 'dn' ? b.dnF1MHz : b.f1MHz)
      if (Number.isFinite(f1) && w != null) out.push({ f1, bw: w })
      for (const s of (Array.isArray(side === 'dn' ? b.dnBands : b.bands) ? (side === 'dn' ? b.dnBands : b.bands) : [])) {
        const sf1 = num(s?.f1MHz)
        const sbw = Number.isFinite(num(s?.bwMHz)) ? num(s.bwMHz) : w
        if (Number.isFinite(sf1) && sbw != null) out.push({ f1: sf1, bw: sbw })
      }
      return out
    }
    const up = bandsOf('up'), dn = bandsOf('dn')
    if (up.length || dn.length) legacy.set(b.id, { up, dn, dnNom: nom('dn') })
  }
  if (!legacy.size) return
  for (const ch of p.channels) {
    if (markSide(ch.kind)) continue                   // 信标那几条没有波束也没有频带
    for (const side of ['up', 'dn']) {
      const { f1: bandF1, bw: bandBw } = channelEdges(p, ch, side)
      if (!Number.isFinite(bandF1) || !Number.isFinite(bandBw)) continue
      for (const b of channelBeams(p, ch, side)) {
        const L = legacy.get(b.id)
        // 下行没单独钉过段的沿用上行那一份（老口径：整段随本转发器的 LO 平移，故偏移相同）
        const useUp = !!L && side === 'dn' && !L.dn.length
        const list = L ? (useUp ? L.up : (side === 'dn' ? L.dn : L.up)) : []
        if (!list.length) continue
        // ★ 沿用上行那一份时，【挑段与换算都在上行域】：那些段是上行的绝对频率，
        //   拿下行频带去筛必然一段都不沾（差着一个 LO），挑出来的会是别的转发器里那一段。
        const ref = useUp ? channelEdges(p, ch, 'up') : { f1: bandF1, bw: bandBw }
        if (!Number.isFinite(ref.f1) || !Number.isFinite(ref.bw)) continue
        const near = list.filter((s) => s.f1 - ref.f1 < ref.bw - 1e-6 && s.f1 + s.bw - ref.f1 > 1e-6)
        const seg = (near[0] || list[0])
        const off = cleanFreq(seg.f1 - ref.f1)
        // 宽度：下行侧按该波束【当年那份】下行标称解析（收发不等宽的波束在下行画的是它自己那个宽度）
        const bw = useUp ? L.dnNom : seg.bw
        if (side === 'dn') {
          // 与上行算出来的完全一样就不写（留空 = 随上行，同一个量不存两遍）
          const upOff = segOffOf(ch, b.id, 'up')
          const upBw = segBwOf(ch, b.id, 'up')
          if (upOff != null && Math.abs(upOff - off) < 1e-9
            && (bw == null || (upBw != null && Math.abs(upBw - bw) < 1e-9))) continue
          putSeg(ch, b.id, { offMHz: off, bwMHz: Number.isFinite(bw) ? cleanFreq(bw) : null }, 'dn')
        } else {
          putSeg(ch, b.id, { offMHz: off, bwMHz: Number.isFinite(bw) ? cleanFreq(bw) : null }, 'up')
        }
      }
    }
  }
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
// 「改一边另一边跟着变」的全部实现都在这一段：界面三处（转发器表 / 检查器 / 批量生成）与频率分配表的
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

// ---- 标记类载波：信标 / 遥控 / 遥测 ----
//
// 带宽、波束、LO 三项对这三类没有意义，解析（resolveChannel）与界面上一律不认，故存储里残留的
// 老值不显形 —— 类型改回转发器时它们还在，一次误点不会把一条转发器的带宽与波束抹掉。
// 唯一必须落实的是【频率在哪一侧】：那决定它画在哪条频带上，两侧各存一份就会自相矛盾。故这里收口。
//
// ★ 老计划（与手上的外来 JSON）多半把信标录在上行那一格 —— 那时两侧同画，填哪边都看得见。
//   搬到它该在的那一侧时把极化一并带过来：数在哪一侧，那一侧的极化才是人填的那个（另一侧那个
//   是 newChannel 按正交给的默认值，照搬过去等于悄悄把信标的极化翻了个面）。
export function foldMark(plan, ch) {
  const side = markSide(ch?.kind)
  if (!side) return false
  const other = side === 'up' ? 'dn' : 'up'
  const lo = loValueOf(plan, ch)
  const up = Number.isFinite(ch.up?.fcMHz) ? ch.up.fcMHz : null
  const dn = Number.isFinite(ch.dn?.fcMHz) ? ch.dn.fcMHz : null
  // 这一侧当前的读数（含 LO 推算值 —— 老信标挂着 LO 时，图上那时画的下行就是这个数）
  let f = side === 'up' ? up : (dn != null ? dn : dnFromUp(up, lo))
  let pol = ch[side].pol
  if (f == null) {                                    // 这一侧没有数 → 把另一侧那个搬过来
    const g = side === 'up' ? (dn != null ? (upFromDn(dn, lo) ?? dn) : null) : up
    if (g != null) { f = g; pol = ch[other].pol }
  }
  ch[side].fcMHz = f
  if (POLS.includes(pol)) ch[side].pol = pol
  ch[other].fcMHz = null
  // 「间隔带宽」跟着频率走（数搬到哪一侧，那一格就在哪一侧）—— 与 pol 同一个理由，
  // 且它是标记类专有的量，另一侧留着只会在下次折叠时又被搬回来
  if (!Number.isFinite(ch[side].slotMHz) && Number.isFinite(ch[other]?.slotMHz)) ch[side].slotMHz = ch[other].slotMHz
  if (ch[other]) ch[other].slotMHz = null
  ch.loId = ''                                        // 不经转发器变频：留着 LO 会把这个数再推算一次
  return true
}

/** 类型录入的收口：改完即把标记类载波折到它那一侧（界面三处 —— 表、检查器、批量条 —— 都走这里） */
export function setChannelKind(plan, ch, kind) {
  if (!ch) return
  ch.kind = KIND_OF[kind] ? kind : 'transponder'
  foldMark(plan, ch)
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
//
// anchor = 改宽度时【钉住哪一端】：
//   'f1' 起始钉住、终止随之走（终止 = 起始 + 带宽）—— 界面上那几个带宽格走这一档。频率计划表的
//        口径本就是「起始 + 带宽」（14004 起、36 宽），且 HTS 里一条转发器的带宽 = Σ 各波束带宽、
//        转发器彼此紧排，往中心两侧对称张缩会顶到前一条上去。占段那格（setBeamSegEdge）从来就是
//        这一档，两处这才是同一个手感。
//   'fc'  中心钉住、两端对称张缩 —— 内部换算走这一档（setChannelEdge 的 put 里中心是另算的，
//        再钉一次起始就成了连着算两遍）。
// ★ 清空（v == null = 回到随波束/带宽组）不钉：那一下改的是「随不随组」，不该顺手把频带挪个位置。
export function setChannelBw(plan, ch, side, v, anchor = 'fc') {
  if (!ch) return
  const x = num(v)
  // 起始要在落宽度【之前】读：落完再读拿到的是新宽度算出来的那个起始，等于没钉
  const f1 = anchor === 'f1' && x != null ? channelEdges(plan, ch, side).f1 : null
  if (side === 'dn' && Number.isFinite(ch.dn?.bwMHz)) ch.dn.bwMHz = x
  else ch.up.bwMHz = x
  if (f1 != null) setChannelFc(plan, ch, side, cleanFreq(f1 + x / 2))
}

// ---- 频带两端：起止频率 ----
//
// 「中心 + 带宽」与「起始 + 终止」是同一段频带的两种写法 —— 四个数、两个自由度：
//     f1 = fc − bw/2 ·  f2 = fc + bw/2    ⇄    fc = (f1 + f2)/2 ·  bw = f2 − f1
// 手上的频率计划表两种口径都有（「13932~14112」与「中心 14022 / 180 MHz」），故两套都能直接录，
// 不必让人先自己做一次加减（同批量生成那个「起始频率」的道理，见 genSeries）。内部仍只存中心 + 带宽。
//
// 联动口径：
//   · 改中心 → 带宽不动、两端一起挪；
//   · 改带宽 → 【起始钉住】、终止随之走（setChannelBw 的 anchor='f1'，界面上那几个带宽格走这一档）；
//   · 改一端 → 【另一端钉住】，中心与带宽一并重算 —— 这才是「起止」区别于「中心」的地方：
//     照着一张起止频率表逐格录进去，两格填完这条转发器就正好落在那段频带上。
//   · 两端一起给（新条目、中心与带宽都还没有）→ setChannelSpan，见下。
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

/**
 * 两端一起给定 —— 「起 · 止」两格都是刚敲进来的那种，直接定出这一段。
 *
 * setChannelEdge 是【一端一端】录的：改一端要靠另一端（或中心、或带宽）钉住，中心与带宽都还没有
 * 的那条转发器（从波束合成导进来的、批量生成里带宽留空的）因此一端也录不进去 —— 两格填什么都被
 * 那条 `fc == null && bw == null` 分支挡回来，人得先绕去填中心或带宽才解锁。照着一张起止频率表
 * 录入时这是死路，故两端齐了就走这里。
 * 顺序录反（先敲终止后敲起始）也认：小的那个当起始。返回是否落值。
 */
export function setChannelSpan(plan, ch, side, f1, f2) {
  if (!ch) return false
  const a = num(f1), b = num(f2)
  if (a == null || b == null || !(Math.abs(b - a) > 0)) return false
  const lo = Math.min(a, b), hi = Math.max(a, b)
  setChannelFc(plan, ch, side, cleanFreq((lo + hi) / 2))
  setChannelBw(plan, ch, side, cleanFreq(hi - lo))
  return true
}

// ---- 波束占段：一条转发器的频带怎么分给它的几个波束 ----
//
// 同一条「一个转发器 + 几个波束」，在两类星上是两件不同的事：
//   · 常规转发器 —— 【同频叠加】：整条 36 MHz 同时落到几个波束（多波束覆盖 / switchable），
//     每个波束占的都是整段，图上叠成几条满宽色片。
//   · HTS —— 【频分排布】：一条宽转发器按频率切给几个波束。中星26 前向 880 MHz = 波束2(440) +
//     波束5(440)，854 = 440 + 207 + 207 —— 转发器带宽 = Σ 各波束带宽。
// 两者用同一个结构表达：每个波束在本转发器频带内占一段 [off, off+bw]，位置（off）的来源分三种，
// 记在 from 上：
//   'seg'  ch.beamSeg[波束id] = { offMHz, bwMHz, dnOffMHz, dnBwMHz } —— 【界面上唯一的频率录入口】：
//      在这条转发器里逐波束录起止。判据是编排的现场：人一次编排一条转发器，「这条 36 MHz 分给哪几个
//      波束、各占哪一截」在那条转发器上一眼看得全；摊到波束身上则要在几十条转发器之间来回对。
//      ★ 下行两项留空 = 随上行（段内格局不变、整段随 LO 平移，常态），填了则下行另有落点
//      （cross-strap / 下行重排 / 收发不等宽）。
//   'tile' 自动【频分排布】：按波束顺序自频带下边沿依次排 —— HTS 那一路。
//   'stack' 自动【同频叠加】：各自贴频带下边沿、各占各的带宽 —— 几个波束共用同一段频率，
//      那正是常规转发器（多波束覆盖 / switchable）与 HTS 频率复用的常态。
//   · bw 留空 → 取该波束该侧的标称带宽；波束也没标称值 → 占满整条频带。
//
// ★ 自动那两档由【本转发器的排布档】ch.beamLayout 定（见 BEAM_LAYOUTS）：
//   'auto'（默认）= 人人有带宽、且接着已录过的那几段仍装得下就 tile，装不下就 stack —— 老口径；
//   'tile' / 'stack' = 人明说要哪一种。装不下也照排，探出频带的由校验的 segOut 指出来（不钳制）。
//   逐个录过占段的那些波束一律按录的画，排布档只管【没录过的那些】。
//
// ★★ 从前 stack 那一档是「装不下就一律【占满整条】」：一个 18 MHz 的波束与一个 36 MHz 的波束同挂
//   在 36 MHz 的转发器上，图上两条都画成 36 宽，那个 18 就成了假的。【同频】与【没占满】本是两件
//   互不排斥的事 —— 同频靠错开分层表达（几条各在一层），没占满靠宽度表达（色片短一截、露出纸面）。
//   故这一档是「各占各的带宽、都从下边沿起」。带宽已到（或超过）整条频带的仍收成 full，故常规
//   计划（一条 36 MHz 落到两个标称 36 MHz 的波束上）画出来与从前逐点相同。
//
// ★★★ off 存的是【相对频带下边沿的偏移】，不是绝对频率：上下行只差一个 LO，整条频带平移而段内
//   格局不变，故一个偏移同时管两侧。存绝对频率的话，改一次 LO / 挪一次转发器就得把每个波束的占段
//   再挪一遍（迟早漏一处，且上下行会各漂各的）。下行单独录过的那一份（dnOffMHz）同样是偏移，只是
//   相对下行频带的下边沿 —— 收发不等宽的转发器（18 上 / 36 下）两侧频带不是简单平移，故留一份。

const segOf = (ch, beamId) => (ch?.beamSeg && ch.beamSeg[beamId]) || null
/** 该波束在这一侧录过的偏移（下行留空 = 随上行）；没录过 → null */
export function segOffOf(ch, beamId, side = 'up') {
  const s = segOf(ch, beamId)
  if (!s) return null
  const v = side === 'dn' && Number.isFinite(s.dnOffMHz) ? s.dnOffMHz : s.offMHz
  return Number.isFinite(v) ? v : null
}
/** 该波束在这一侧录过的宽度（下行留空 = 随上行那一份）；没录过 → null */
export function segBwOf(ch, beamId, side = 'up') {
  const s = segOf(ch, beamId)
  if (!s) return null
  const v = side === 'dn' && Number.isFinite(s.dnBwMHz) ? s.dnBwMHz : s.bwMHz
  return Number.isFinite(v) ? v : null
}
// 该侧有没有人显式设过占段（设过就一律按段画，不再走排布档那条自动路）
function hasExplicitSeg(ch, beams, side = 'up') {
  return beams.some((b) => segOffOf(ch, b.id, side) != null || segBwOf(ch, b.id, side) != null)
}

/**
 * 该侧各波束的占段，按 channelBeams 次序排（一个波束一条）：
 *   { beam, off, bw, f1, f2, fc, full, from, autoOff, autoBw }
 * full = 这一段就是整条频带（同频叠加那一片，或该波束没有可用带宽）；from = 位置的来源
 * （'seg' | 'tile' | 'stack'，见上一段）；autoOff/autoBw = 该项是算出来的
 * （界面据此把值显示成灰字占位，同「转发器带宽留空 = 灰字继承」）。
 * 频带未定（无中心或无带宽）时 f1/f2/fc 为 null，几何交给渲染端按整块处理。
 */
export function beamSegs(plan, ch, side = 'up') {
  const beams = channelBeams(plan, ch, side)
  if (!beams.length) return []
  const { bw: bandBw, f1: bandF1 } = channelEdges(plan, ch, side)
  const hasBand = Number.isFinite(bandBw) && bandBw > 0
  // 录过占段的转发器一律按录的画，不走排布档那条自动路：那是有人一格一格设成这样的。
  const explicit = hasExplicitSeg(ch, beams, side)
  const items = beams.map((b) => {
    const off = segOffOf(ch, b.id, side)
    const bw = segBwOf(ch, b.id, side)
    return { beam: b, off, bw: bw != null ? bw : beamBw(b), from: off != null ? 'seg' : null }
  })
  // 没录过的波束自动排时，从【录过的那几段之后】起排：不然波束表里的先后次序就会决定它压不压在
  // 录死的那一段上（同一份计划把两个波束换个次序，图上就不一样了）。一个都没录过 → cursor 仍是 0。
  let cursor = 0
  for (const it of items) {
    if (it.from === 'seg' && Number.isFinite(it.bw)) cursor = Math.max(cursor, it.off + it.bw)
  }
  // 自动那几个怎么摆：排布档说了算，'auto' 才现判「装不装得下」（人人有带宽 + 接着录过的那几段仍够）
  const auto = items.filter((it) => it.from == null)
  const autoSum = auto.reduce((a, it) => a + (Number.isFinite(it.bw) ? it.bw : 0), 0)
  const layout = beamLayoutOf(ch)
  const tile = layout === 'tile' ? true
    : layout === 'stack' ? false
      : (explicit || (hasBand && auto.every((it) => Number.isFinite(it.bw)) && cursor + autoSum <= bandBw + 1e-6))
  const out = []
  for (const it of items) {
    const b = it.beam
    let src = it.from
    let bw = it.bw
    let off = it.off
    if (off == null) {
      src = tile ? 'tile' : 'stack'
      off = tile ? cursor : 0            // 同频叠加：都贴频带下边沿，各占各的带宽
    }
    // 这一段就是整条频带（= 同频叠加那一片，图上仍画成满宽色片，校验也不拿几片满宽的去互报重叠）：
    //   · 该波束没有可用带宽 —— 「多宽」无从谈起，只能占满；
    //   · 自动排出来的段贴着下边沿、宽度已到整条频带 —— 再宽也不可能宽过转发器，收成满宽。
    // ★ 逐个录过占段的（explicit）不收：收回同频叠加态会把「录过就一律按段画」那条规矩推翻。
    let full = !hasBand || !Number.isFinite(bw)
    if (!full && !explicit && src !== 'seg' && Math.abs(off) < 1e-6) full = bw >= bandBw - 1e-6
    if (full) { off = 0; bw = hasBand ? bandBw : null }
    if (!full) cursor = Math.max(cursor, off + bw)
    const has = Number.isFinite(bandF1) && Number.isFinite(bw)
    out.push({
      beam: b,
      off,
      bw: Number.isFinite(bw) ? bw : null,
      f1: has ? cleanFreq(bandF1 + off) : null,
      f2: has ? cleanFreq(bandF1 + off + bw) : null,
      fc: has ? cleanFreq(bandF1 + off + bw / 2) : null,
      full,
      from: src,
      // 位置 / 宽度是算出来的（紧排 / 叠放 / 随标称带宽）才叫 auto —— 录过的那些是「设过的」
      autoOff: it.from == null,
      autoBw: segBwOf(ch, b.id, side) == null
    })
  }
  return out
}

// 写占段的唯一收口：四项都为 null 时把整条删掉（回到全自动，别留空壳——空壳会被 hasExplicitSeg
// 当成「设过」，于是「清空」之后仍不回退到自动排布）。side='dn' 落在下行那两项上（留空 = 随上行）。
function putSeg(ch, beamId, patch, side = 'up') {
  if (!ch || !beamId) return
  if (!ch.beamSeg || typeof ch.beamSeg !== 'object') ch.beamSeg = {}
  const cur = ch.beamSeg[beamId] || {}
  const key = (k) => (side === 'dn' ? (k === 'offMHz' ? 'dnOffMHz' : 'dnBwMHz') : k)
  const next = {
    offMHz: num(cur.offMHz), bwMHz: num(cur.bwMHz),
    dnOffMHz: num(cur.dnOffMHz), dnBwMHz: num(cur.dnBwMHz)
  }
  for (const [k, v] of Object.entries(patch)) next[key(k)] = v
  if (!Number.isFinite(next.offMHz) && !Number.isFinite(next.bwMHz)
    && !Number.isFinite(next.dnOffMHz) && !Number.isFinite(next.dnBwMHz)) delete ch.beamSeg[beamId]
  else {
    ch.beamSeg[beamId] = {
      offMHz: num(next.offMHz), bwMHz: num(next.bwMHz),
      dnOffMHz: num(next.dnOffMHz), dnBwMHz: num(next.dnBwMHz)
    }
  }
}

/** 占段带宽录入（留空 = 回到该波束的标称带宽；下行留空 = 随上行那一份） */
export function setBeamSegBw(plan, ch, beamId, v, side = 'up') { putSeg(ch, beamId, { bwMHz: num(v) }, side) }

/** 占段中心频率录入（绝对频率 → 偏移；留空 = 回到自动排布） */
export function setBeamSegFc(plan, ch, side, beamId, v) {
  const x = num(v)
  if (x == null) { putSeg(ch, beamId, { offMHz: null }, side); return }
  const { f1 } = channelEdges(plan, ch, side)
  const g = beamSegs(plan, ch, side).find((s) => s.beam.id === beamId)
  if (f1 == null || !g || !Number.isFinite(g.bw)) return
  putSeg(ch, beamId, { offMHz: cleanFreq(x - g.bw / 2 - f1) }, side)
}

/**
 * 占段的一端录入（which = 'f1' | 'f2'）。口径同转发器自己的起止（见「频带两端」那一段）：
 *   · 改起始 → 终止钉住，带宽随之变；改终止 → 起始钉住。
 *   · 越过另一端 → 不生成负宽段，改按「带宽不变、整段平移到这一端」处理（返回 'shift'）。
 *   · 起始清空 → 这个波束在本转发器（这一侧）回到自动排布（返回 'clear'）；终止清空不落值。
 *   · 还没有宽度（该波束这一侧连标称带宽都没有）→ 由两端定出整段（'set' / 'span'）。
 * 返回 'resize' | 'shift' | 'set' | 'span' | 'clear' | null（没落值）。
 */
export function setBeamSegEdge(plan, ch, side, beamId, which, v) {
  const x = num(v)
  const lo = which !== 'f2'
  const { f1: bandF1 } = channelEdges(plan, ch, side)
  const g = beamSegs(plan, ch, side).find((s) => s.beam.id === beamId)
  if (x == null) {
    if (!lo) return null
    putSeg(ch, beamId, { offMHz: null }, side)
    return 'clear'
  }
  if (bandF1 == null || !g) return null
  if (!Number.isFinite(g.bw)) {                       // 没有宽度 → 起始先落位，另一端定出宽度
    if (lo) { putSeg(ch, beamId, { offMHz: cleanFreq(x - bandF1) }, side); return 'set' }
    if (g.f1 == null) return null
    const nbw = x - g.f1
    if (!(nbw > 0)) return null
    putSeg(ch, beamId, { bwMHz: cleanFreq(nbw) }, side)
    return 'span'
  }
  if (g.f1 == null) {                                 // 有宽度没位置（频带未定）→ 填哪一端都定得出
    putSeg(ch, beamId, { offMHz: cleanFreq((lo ? x : x - g.bw) - bandF1) }, side)
    return 'set'
  }
  const other = lo ? g.f2 : g.f1
  const nbw = lo ? other - x : x - other
  if (nbw > 0) {
    putSeg(ch, beamId, { offMHz: cleanFreq((lo ? x : other) - bandF1), bwMHz: cleanFreq(nbw) }, side)
    return 'resize'
  }
  putSeg(ch, beamId, { offMHz: cleanFreq((lo ? x : x - g.bw) - bandF1) }, side)   // 越过另一端 → 整段平移
  return 'shift'
}

// 通道 → 画图与校验都吃的这一份解析结果。f1/f2 为频段两端（含边界），null 表示该侧未定义。
// ★ 标记类载波（信标 / 遥控 / 遥测）在这里收成【一侧一个点】：带宽 null、不归波束、不认 LO ——
//   渲染端据 mark 画成一根箭头，校验端据它跳过带宽那几条。
// ★ 但它可以【占一格】：slotMHz =「间隔带宽」，即在频率轴上给它留的那一格宽度（信标本身是等幅波
//   没有带宽，留的是它与相邻转发器之间的那段间隔）。填了就 f1/f2 = fc ∓ n/2 —— 频带两端因此
//   算到 fc ± n/2 上（12750 的信标、n=6 → 端点标注 12753），信标就不再被排在坐标轴之外。
//   留空 = 不占频带，界标仍只圈转发器（见渲染端 guideExtent）。bw 一律 null：占一格不等于有带宽，
//   画出来还是那根箭头，校验的「未给带宽」也仍然不该报到它头上。
export function resolveChannel(plan, ch) {
  const mk = markSide(ch?.kind)
  if (mk) {
    const raw = mk === 'dn' ? downlinkFc(plan, ch) : ch?.up?.fcMHz
    const fc = Number.isFinite(raw) ? raw : null
    const slotRaw = num(ch?.[mk]?.slotMHz)
    const slot = Number.isFinite(slotRaw) && slotRaw > 0 ? slotRaw : null
    const half = slot ? slot / 2 : 0
    const s = fc == null ? null : { fc, bw: null, slot, f1: fc - half, f2: fc + half, pol: ch[mk].pol }
    return {
      id: ch.id, no: ch.no, kind: ch.kind, mark: true, side: mk,
      up: mk === 'up' ? s : null,
      dn: mk === 'dn' ? s : null,
      dnDerived: false, bwFromBeam: false, lo: null,
      beamsUp: [], beamsDn: [], segsUp: [], segsDn: [],
      raw: ch
    }
  }
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
    mark: false,
    side: '',
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
    // 各波束在本转发器频带内占的那些段（见「波束占段」）。渲染端据此切块；按波束次序排，
    // 但一个波束钉了几段就出几条，故不与 beamsUp/beamsDn 一一对应。
    segsUp: beamSegs(plan, ch, 'up'),
    segsDn: beamSegs(plan, ch, 'dn'),
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

// 链路预算侧的频段档位（卫星表单「工作频段」下拉那 11 档，见 linkbudget/satPresets.js 的 BAND_FREQ）。
// 与上面的 BANDS / guessBand 是两套，各管各的：BANDS 是计划自己的汇总行用的粗分（8 档），
// 这一套要落进链路预算表单，多出「扩展C / 扩展Ku / Ku-BSS」三档——而这三档与 C / Ku 的分界
// 只在上行看得出来（下行频段互相重叠：Ku-BSS 下行 11.7~12.75 与 Ku 下行是同一段），
// 故判定顺序是【上行 → 下行 → guessBand 兜底】。
// 区间按卫星固定业务的实际划分取，段与段之间刻意留空隙：落在空隙里就说明这不是标准业务频段，
// 与其硬塞进最近的一档，不如退回粗分。
const LINK_BAND_UP = [
  [0, 2000, 'L'], [2000, 3000, 'S'],
  [5850, 6425, 'C'],            // 标准 C 上行 5.925~6.425
  [6425, 7100, 'ExtC'],         // 扩展 C 上行 6.425~6.725
  [7900, 8400, 'X'],
  [12750, 14000, 'ExtKu'],      // 扩展 Ku 上行 13.75~14.0
  [14000, 14800, 'Ku'],
  [17300, 18400, 'Ku-BSS'],     // BSS 馈电上行
  [27000, 31000, 'Ka'],
  [42500, 51400, 'Q'], [51400, Infinity, 'V']
]
const LINK_BAND_DN = [
  [0, 2000, 'L'], [2000, 3000, 'S'],
  [3400, 3700, 'ExtC'], [3700, 4200, 'C'],
  [7200, 7800, 'X'],
  [10700, 11700, 'ExtKu'], [11700, 12750, 'Ku'],
  [17700, 21200, 'Ka'],
  [37500, 42500, 'Q'], [47200, 50200, 'V']
]
// ★ 空值必须先挡掉再 Number()：Number(null) 和 Number('') 都是 0，而 0 是有限数，
//   会一路落进 L 段那一档 —— 单向计划（只有上行或只有下行）就会被判成 L。
const finMHz = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v))
const inBands = (table, fMHz) => {
  const f = finMHz(fMHz)
  if (!Number.isFinite(f)) return ''
  for (const [lo, hi, band] of table) if (f >= lo && f < hi) return band
  return ''
}

/**
 * 转发器上/下行频率 → 链路预算的「工作频段」。任一为空即跳过该级判定。
 * 都判不出来时退回 guessBand（其 8 档输出全是链路预算下拉的合法值）。
 */
export function guessLinkBand(upMHz, dnMHz) {
  const u = finMHz(upMHz), d = finMHz(dnMHz)
  return inBands(LINK_BAND_UP, u) || inBands(LINK_BAND_DN, d) || guessBand(Number.isFinite(u) ? u : d)
}

// ---- 校验 ----
// 只出数值与定位，不下文字结论（遵循平台「结果输出纯数字」口径）：每条 issue 给出
// 严重度 + 涉及通道 + 两个可比对的数，判断留给人。

const OVERLAP_EPS = 1e-6

// 若干区间【并起来】有多长（先裁进 [lo, hi] 再合并）。重叠的部分只算一次 —— 「频带里有多少被波束
// 覆盖」在同频叠放与频分紧排两种态下是同一个问题，逐段相加只在后者成立。
function unionLen(spans, lo, hi) {
  const iv = spans
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)])
    .filter(([a, b]) => b - a > 0)
    .sort((p, q) => p[0] - q[0])
  let sum = 0, end = -Infinity
  for (const [a, b] of iv) {
    if (a > end) { sum += b - a; end = b } else if (b > end) { sum += b - end; end = b }
  }
  return sum
}

// unit = 屏上当前刻度：条目里的那几个数与表上、图上是同一把尺子（默认 MHz，与内部存储一致）。
export function validatePlan(plan, unit = 'MHz') {
  const issues = []
  const rs = resolveAll(plan)
  const fq = (mhz) => fmtFreqU(mhz, unit)
  const add = (severity, code, msg, refs, nums) => issues.push({ severity, code, msg, refs: refs || [], nums: nums || null })

  for (const r of rs) {
    // 标记类载波（信标 / 遥控 / 遥测）只有频率与极化：带宽与 LO 那两条对它们不成立，报了就是噪声
    if (r.mark) {
      if (!r.up && !r.dn) add('warn', 'empty', `${KIND_LABEL[r.kind] || '通道'} ${r.no || r.id} 未给频率`, [r.id])
      continue
    }
    if (!r.up && !r.dn) add('warn', 'empty', `通道 ${r.no || r.id} 上下行皆无频率`, [r.id])
    if (r.up && !Number.isFinite(r.up.bw)) add('warn', 'nobw', `通道 ${r.no} 未给带宽`, [r.id])
    if (r.up && !r.lo && !Number.isFinite(r.raw.dn.fcMHz)) {
      add('warn', 'nolo', `通道 ${r.no} 未指定 LO 且未显式给下行频率 — 下行无法定位`, [r.id])
    }
    // 下行落到负频率/异常低频 = LO 填错的典型症状
    if (r.dn && r.dn.fc <= 0) add('error', 'badlo', `通道 ${r.no} 下行频率 ${fq(r.dn.fc)} ≤ 0`, [r.id], { dn: r.dn.fc })
  }

  // 标记类载波落进某条转发器的通带里（且同极化）：信标与遥测遥控本该排在转发器之外的空当上，
  // 落进通带内就与那条转发器上的业务载波挤在同一段频率。只给位置与两端，判断留给人。
  for (const r of rs) {
    if (!r.mark) continue
    const s = r.up || r.dn
    if (!s) continue
    for (const t of rs) {
      if (t.mark || t.id === r.id) continue
      const b = r.side === 'up' ? t.up : t.dn
      if (!b || !Number.isFinite(b.bw) || b.pol !== s.pol) continue
      if (s.fc > b.f1 + OVERLAP_EPS && s.fc < b.f2 - OVERLAP_EPS) {
        add('info', 'markInBand',
          `${KIND_LABEL[r.kind] || ''} ${r.no || ''} ${fq(s.fc)} ${s.pol} 落在通道 ${t.no} 频带 ${fq(b.f1)}~${fq(b.f2)} 内`,
          [r.id, t.id], { fc: s.fc, f1: b.f1, f2: b.f2 })
      }
    }
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
            `${side === 'up' ? '上行' : '下行'} ${segs[i].r.no} 与 ${segs[j].r.no} 同极化 ${segs[i].s.pol} 重叠 ${fq(ov)}`,
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
        `通道 ${r.no} 显式下行 ${fq(r.raw.dn.fcMHz)} 与 LO 推算 ${fq(derived)} 差 ${fq(d)}`,
        [r.id], { explicit: r.raw.dn.fcMHz, derived, deltaMHz: d })
    }
  }

  // 波束占段与转发器带宽对不上（见「波束占段」）。三种情形，都只给数不下结论：
  //   · 余量：频带里没有任何波束覆盖的那部分 —— HTS 里就是「这条转发器还有多少没分出去」，
  //     图上是那截留白。★ 取【并集】而不是逐段相加：同频叠放时几个波束共用同一段频率，相加会
  //     算出比频带还宽的「已占」，那条转发器就永远报不出真正的留白（也就永远看不出算错没）。
  //   · 越界：某一段探出频带 —— 钉死的段遇上转发器挪过位才会出现，图上被钳在块内故不报就看不出来；
  //   · 段间重叠：两个波束压在同一段频率上。只查【两边都是钉死的段】的那种 —— 自动同频叠放与占满
  //     整条的同频共用本就重叠（那是它们的定义），拿去报警只会满屏噪声。
  for (const r of rs) {
    for (const side of ['up', 'dn']) {
      const s = side === 'dn' ? r.dn : r.up
      const segs = (side === 'dn' ? r.segsDn : r.segsUp) || []
      if (!s || !Number.isFinite(s.bw) || !segs.length) continue
      const side1 = side === 'up' ? '上行' : '下行'
      const used = unionLen(segs.map((g) => [g.f1, g.f2]), s.f1, s.f2)
      if (s.bw - used > 1e-6) {
        add('info', 'segFree',
          `通道 ${r.no} ${side1}带宽 ${fq(s.bw)}，波束占 ${fq(used)}，余 ${fq(s.bw - used)} 未分配`,
          [r.id], { bwMHz: s.bw, usedMHz: used, freeMHz: s.bw - used })
      }
      for (const g of segs) {
        if (g.f1 == null) continue
        if (g.f1 < s.f1 - 1e-6 || g.f2 > s.f2 + 1e-6) {
          add('warn', 'segOut',
            `通道 ${r.no} ${side1}波束「${g.beam.name}」占段 ${fq(g.f1)}~${fq(g.f2)} 探出频带 ${fq(s.f1)}~${fq(s.f2)}`,
            [r.id], { f1: g.f1, f2: g.f2, bandF1: s.f1, bandF2: s.f2 })
        }
      }
      const pinned = (g) => !g.full && g.from !== 'stack' && g.f1 != null
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          if (!pinned(segs[i]) || !pinned(segs[j])) continue
          const ov = Math.min(segs[i].f2, segs[j].f2) - Math.max(segs[i].f1, segs[j].f1)
          if (ov > 1e-6) {
            add('info', 'segOverlap',
              `通道 ${r.no} ${side1}波束「${segs[i].beam.name}」与「${segs[j].beam.name}」占段重叠 ${fq(ov)}`,
              [r.id], { overlapMHz: ov })
          }
        }
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

// 频率计划 → 链路预算卫星字段。这是「引用」的口径咽喉：链路预算只认这六项 + 可选的转发器属性。
// ★「工作频段」按转发器的实际上/下行频率判定（guessLinkBand），不取 plan.band——后者只有 8 档，
//   扩展C / 扩展Ku / Ku-BSS 会被降级；而频段不只是标签：引擎按它给收信站噪声温度分档
//   （linkCalculator 的 antennaNoiseTemp / receiverNoiseTemp，C 与 ExtC 一档、其余一档），
//   站表那两格留空时判错档就直接算错 T_sys。
export function channelToLinkFields(plan, ch) {
  const r = resolveChannel(plan, ch)
  const out = {}
  const band = guessLinkBand(r.up?.fc, r.dn?.fc)
  if (band) out.frequencyBand = band
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

// 摘要（文件区列表与库条目一行速览）。unit 同 validatePlan：跟屏上那把尺子走。
// ★ 频带跨度那一段原先恒写 GHz（不管当前刻度）—— 一行摘要里两个单位，读者得在心里换一次算。
export function planSummary(plan, unit = 'MHz') {
  const chs = plan.channels || []
  const tp = chs.filter((c) => c.kind === 'transponder')
  // 走解析后的带宽——自填的和从波束组继承的都要算进来，否则「只在波束上填了带宽」的计划摘要空一截
  const bws = tp.map((c) => uplinkBw(plan, c)).filter(Number.isFinite)
  const ext = planExtent(plan, 'up', 0)
  const U = unitLabel(unit)
  const fn = (mhz) => fmtFreqNum(mhz, unit)
  const parts = [`${plan.band || '—'} 频段`, `${tp.length} 转发器`]
  if (bws.length) {
    const uniq = [...new Set(bws.map((b) => Math.round(b * 100) / 100))]
    parts.push(uniq.length === 1 ? `${fn(uniq[0])} ${U}` : `${fn(Math.min(...bws))}~${fn(Math.max(...bws))} ${U}`)
  }
  if (ext) parts.push(`↑${fn(ext.dataMin)}~${fn(ext.dataMax)} ${U}`)
  if (plan.beams?.length) parts.push(`${plan.beams.length} 波束`)
  return parts.join(' · ')
}
