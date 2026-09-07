// 「SLA 建议」的单一真值源（GSO / NGSO / 再生式 / 端到端 四窗共用）。
//
// 纯逻辑、零框架依赖（同 lbCustomCols.js 的做法）：packages/core 的 Node 测试直接 import 得动，
// 四个工作台与三个报告渲染器都从这里取数，于是「屏幕上看到的建议值」与「报告里印出来的」
// 必然是同一份。
//
// 口径（务必与界面/报告保持一致）：
//   ① 建议值只从【本行真正送进引擎的那份入参】与【引擎出参】推导（sweepParamsByRow[rowId] +
//      links[i].data），绝不读表单当前值 —— 用户算完又改了表单时，建议必须对应算出这组结果的
//      那些数（与报告输入清单同一原则）。
//   ② 建议值不写回三库、不改链路行的可用度输入：SLA 是「这组场景的结论」，改设计由工程师
//      自己去改表；采用值只存 row.sla。
//   ③ 纯数字：本模块不产出任何「达标 / 合格 / 受限」一类的文字判定。依据列写【算式】——
//      数字、单位、运算符，外加算式里必要的【操作数名】（可用度连乘那一条：五个 99.99 % 并排
//      摆着，不写名字读者分不出哪个是卫星、哪个是基带）。操作数名一律走 L(zh, en)：
//      呈现层按整个 <span> 精确查表翻译（故每个名字自成一片、不与数字拼在一起），报告那条路
//      由 basisText(parts, en) 取 textEn —— 两条路都不会在英文里漏出中文。
//   ③' 每条依据都要【算得平】：写出来的算式代入自己给的数，结果必须等于建议值（取档另写
//      「→ 档位」一步）。算不平的（NGSO 带 ISL 跳而分段时延对不上总时延那类）宁可留「—」，
//      不摆一个凑不出结果的式子。
//   ④ 容差 / 隔离度 / 响应 / 恢复只是可改缺省，不为它们引任何建议书编号背书。
//
// 诚实边界：
//   · 档位扫描钉的是设计点解出来的工作点（与地理场图同口径），回答的是「这套硬件在档 X 还剩
//     多少余量」，不替用户重解功放；
//   · MIR 假定 ACM 在同一符号率内切档、且保留同样的系统余量，门限取自用户当前那张（可编辑的）
//     MODCOD 表；
//   · 丢包是门限工况下的上界，不是预测；时延不含地面段与排队；
//   · 可用度构成里【传播之外】的那几项（发信射频 / 收信射频 / 卫星与载荷 / 基带骨干网）是 SLA 参数，不是算出来的：
//     引擎只算雨衰统计。连乘假定各环节独立，两类中断的性质也不同（雨衰＝多次短中断，设备
//     故障＝少次长中断），后者由「故障响应 / 恢复」两条条款单独约束。

import { modFactorOf, parseFrac } from './carrierRate.js'
// 3GPP NTN：门限已是占用带宽内的 C/N，速率由 PRB 数 + MCS 的 TBS 定，两者都不走 DVB 那条链
import { normalizePhy, effectiveThresholdDb, infoRateKbps, nbSingleToneMcs, MU_OF, NB_SF_COUNT, nbRuMs } from './ntnPhy.js'
// ★ 只取 fmtScaled 这一个纯函数（≤4 位小数、去尾零）：换档判定由调用方注入的 fmt 负责，
//   本模块不碰 lbUnitMode（那边读 localStorage，Node 测试里不存在）。
import { fmtScaled } from './adaptUnits.js'

// ============ 常量 ============

// 可用度标准档（%）。建议值向下取档 —— 承诺只能报到「肯定守得住」的那一档。
// 低两档 98 / 98.5 是 2026-09-06 补的：Ka 波段小站与「按月考核」口径下综合可用度很容易掉到
// 99 以下，够不着最低档时建议值只能留空 —— 条款表与报告里就是一格空白。
export const AVAIL_TIERS = [98, 98.5, 99, 99.5, 99.7, 99.8, 99.9, 99.95, 99.99]
// 丢包率档（%）。向上取档 —— 上界只能报到「肯定不会超」的那一档。
export const LOSS_TIERS = [0.001, 0.01, 0.05, 0.1, 0.5, 1]

// 场景级 SLA 参数（进场景存档与指纹，见各窗 serializeState）。都只是缺省值。
// ★ 值一律是数，不放布尔：normSlaParams 逐键走 num()，塞个 true 进来会被当成非法值丢掉，
//   于是「含地面段」的开关状态存不进场景（groundOn 用 0/1）。
export const DEFAULT_SLA_PARAMS = {
  pktBytes: 1500,      // IP 包长 B（丢包率换算用）
  // 帧差错率 10⁻ⁿ：DVB 家族（S2/S2X/RCS2）的门限按 QEF 定义（ETSI EN 302 307-1 §4.1，约合 PER < 10⁻⁷），
  // LDPC+BCH 译码后的错误是【帧级】的，不是比特级独立随机误码。3GPP NTN 不吃这一项：那套 MCS 表的门限是
  // 首传 BLER 目标（缺省 10 %，TS 38.214），不是 QEF，平台也没建 HARQ 重传模型 → 不出丢包率建议（见 deriveSla）。
  ferExp: 7,
  jitterMs: 30,        // 时延抖动 ms（纯合同参数，无计算依据；IP 业务惯用 ≤ 30–50 ms）
  procMsPerEnd: 20,    // 处理时延预留 ms/单程（发端调制 + 收端解调）
  eirpTolDb: 1,        // EIRP / PSD 容差 dB
  xpdMinDb: 30,        // 极化隔离度下限 dB
  respondMin: 30,      // 故障响应时间 min
  restoreH: 4,         // 故障恢复时间 h
  // 可用度构成：引擎算的是【传播可用度】（雨衰统计），设备/空间段/地面段这几项它不管。
  // 填 100 即该项不计入（依据列里也不出现这个因子）。
  esTxAvail: 99.99,    // 发信射频可用度 %（发端地球站的功放 / 上变频 / 天线一路）
  esRxAvail: 99.99,    // 收信射频可用度 %（收端地球站的 LNB / 下变频 / 天线一路）
  spaceAvail: 99.99,   // 卫星与载荷可用度 %，链上逐颗计入
  groundOn: 0,         // 是否计入基带/骨干网（0 / 1）：只卖空间段就不勾，卖网络服务才勾
  groundAvail: 99.99,  // 基带/骨干网可用度 %（调制解调 / 回传 / 骨干）
  // 考核周期（0 = 年平均 / 1 = 最坏月）。引擎那份可用度是 P.618 的【年均】统计，合同 SLA 几乎
  // 都按月考核按月赔付：年 99.9 % 折成最坏月只有 99.62 %，承诺 99.9 % 在雨季那个月必然违约。
  monthly: 0,
  // 同站回环（0 / 1）：发信站与收信站是同一个站址（回环 / 自环测试）时上下行是同一场雨，传播可用度取
  // min 而不是乘积。要用户明确勾选 —— 只按坐标判的话 GSO 新建行（发收站缺省同址）一开窗就换了模型。
  loopback: 0
}

export const SLA_GROUPS = [
  { key: 'avail', label: '可用度', labelEn: 'Availability' },
  { key: 'bw', label: '带宽与速率', labelEn: 'Bandwidth & Rate' },
  { key: 'delay', label: '时延与差错', labelEn: 'Delay & Errors' },
  { key: 'ops', label: '故障响应与恢复', labelEn: 'Fault Response & Restoration' },
  { key: 'tx', label: '发射合规', labelEn: 'Transmit Compliance' },
  { key: 'excl', label: '免责事件', labelEn: 'Excluded Events' }
]

// 条款清单。
//   unit  引擎/建议值的基准单位（qty:true 的走 fmtQty 自适应换档）
//   kind  'num' = NumBox 数字格；'text' = 普通文本格（极化这类）；'ro' = 只读读数（无采用值格）
//   dec   固定小数位（qty 项不用）
//   cmp   采用值比建议更激进的方向：'gt' = 采用 > 参照即着色；'lt' = 采用 < 参照即着色
//   tip   悬停口径说明（界面上唯一允许的说明文字去处）
export const SLA_ITEMS = [
  { key: 'propAvail', group: 'avail', label: '传播可用度', labelEn: 'Propagation availability', unit: '%', kind: 'ro', dec: 3, cmp: null, tip: '引擎算的那一份：上下行设计可用度之积，只管雨衰不管设备；同站回环时取两侧较小者' },
  { key: 'visAvail', group: 'avail', label: '互视可用度', labelEn: 'Visibility availability', unit: '%', kind: 'ro', dec: 3, cmp: null, tip: '星间链路的几何互视时间占比（微波与激光同口径），不是雨衰统计' },
  { key: 'sysAvail', group: 'avail', label: '系统可用度', labelEn: 'System availability', labelMonthly: '系统可用度（月）', labelMonthlyEn: 'System availability (monthly)', unit: '%', kind: 'num', dec: 3, cmp: 'gt', tip: '传播可用度 × 发信射频 × 收信射频 × 卫星与载荷（× 基带/骨干网），不是单侧输入列；建议值向下取标准档' },
  { key: 'outageMin', group: 'avail', label: '年中断时长上限', labelEn: 'Annual outage (max)', labelMonthly: '月中断时长上限', labelMonthlyEn: 'Monthly outage (max)', unit: 'min', kind: 'num', dec: 0, cmp: null, tip: '(100 − 采用可用度)/100 × 一个考核周期的分钟数（年 525960 / 月 43830）；随采用可用度变' },
  { key: 'settledBw', group: 'bw', label: '结算带宽', labelEn: 'Settled bandwidth', unit: 'kHz', kind: 'num', qty: true, cmp: 'lt', tip: '转发器带宽承诺＝max(载波带宽, 功率带宽)' },
  { key: 'cir', group: 'bw', label: '承诺信息速率 CIR', labelEn: 'Committed information rate (CIR)', unit: 'kbps', kind: 'num', qty: true, cmp: 'gt', tip: '设计可用度下、余量 ≥ 0 时的信息速率' },
  { key: 'mir', group: 'bw', label: '峰值信息速率 MIR', labelEn: 'Maximum information rate (MIR)', unit: 'kbps', kind: 'num', qty: true, cmp: 'gt', tip: 'ACM 在同一符号率内切到晴空可支撑的最高效率档；保留同样的系统余量。未选 MODCOD 标准时＝CIR' },
  { key: 'owd', group: 'delay', label: '单程时延', labelEn: 'One-way delay', unit: 'ms', kind: 'num', dec: 1, cmp: null, tip: '引擎单程链路时延；不含地面段与排队' },
  { key: 'rtt', group: 'delay', label: '往返时延上限', labelEn: 'Round-trip delay (max)', unit: 'ms', kind: 'num', dec: 0, cmp: 'lt', tip: '⌈2 × (单程 + 处理时延预留) / 10⌉ × 10；处理时延预留是单程口径（发端调制 + 收端解调）' },
  { key: 'jitter', group: 'delay', label: '时延抖动', labelEn: 'Delay jitter', unit: 'ms', kind: 'num', dec: 0, cmp: 'lt', tip: '按运营商入网要求填；IP 业务惯用 ≤ 30–50 ms' },
  { key: 'berTarget', group: 'delay', label: '设计误码率', labelEn: 'Design BER', unit: '', kind: 'text', ro: true, cmp: null, tip: '载波配置里的设计误码率，原样带出；不是算出来的量' },
  // 3GPP 那一侧与 berTarget 对应的只读读数：MCS 表门限按【首传 BLER 目标】定义（缺省 10 %），引擎经 phyBlerResult 回显
  { key: 'blerTarget', group: 'delay', label: '目标 BLER（首传）', labelEn: 'Target BLER (first transmission)', unit: '%', kind: 'text', ro: true, cmp: null, tip: '3GPP 载波配置里的目标块差错率，MCS 表的解调门限按它定义（TS 38.214，首传、不含 HARQ 重传）；原样带出，不是算出来的量' },
  { key: 'loss', group: 'delay', label: '丢包率上限', labelEn: 'Packet loss (max)', unit: '%', kind: 'num', dec: 3, cmp: 'lt', tip: 'DVB 家族按帧差错：1 − (1 − 10⁻ⁿ)^N_f，n 取帧差错率、N_f = ⌈8L / K⌉；未选标准时按比特独立随机误码 1 − (1 − 10⁻ⁿ)^(8L)；3GPP NTN 载波不出本项（门限是首传 BLER 目标，未建 HARQ 重传模型）。只在可用时间内考核，中断时段不计入丢包统计' },
  { key: 'respond', group: 'ops', label: '故障响应时间', labelEn: 'Response time', unit: 'min', kind: 'num', dec: 0, cmp: null, tip: '合同条款，无计算依据；按运营商入网要求填' },
  { key: 'restore', group: 'ops', label: '故障恢复时间', labelEn: 'Restoration time', unit: 'h', kind: 'num', dec: 1, cmp: null, tip: '合同条款，无计算依据；按运营商入网要求填' },
  { key: 'txFreq', group: 'tx', label: '上行中心频率', labelEn: 'Uplink centre frequency', unit: 'MHz', kind: 'num', dec: 4, cmp: null, tip: '引擎上行中心频率；依据列给 fc ± B/2，引用了频率计划时再附该转发器的频带' },
  { key: 'txBw', group: 'tx', label: '载波占用带宽', labelEn: 'Occupied bandwidth', unit: 'kHz', kind: 'num', qty: true, cmp: null, tip: '引擎载波分配带宽 = 符号率 × 带宽系数；3GPP NTN 报的是标准栅格上的信道带宽，依据列只给它至少要装下的占用带宽' },
  { key: 'txEirp', group: 'tx', label: '最大 EIRP', labelEn: 'Maximum EIRP', unit: 'dBW', kind: 'num', dec: 2, cmp: 'gt', tip: '发信站晴空 EIRP + UPC 余量 + 容差；容差按运营商入网要求填' },
  { key: 'txPsd', group: 'tx', label: '最大功率谱密度', labelEn: 'Maximum PSD', unit: 'dBW/4kHz', kind: 'num', dec: 2, cmp: 'gt', tip: '发信站晴空 PSD + UPC 余量 + 容差，参考带宽 4 kHz；PSD 按分配带宽算；容差按运营商入网要求填' },
  { key: 'txPol', group: 'tx', label: '上行极化', labelEn: 'Uplink polarisation', unit: '', kind: 'text', cmp: null, tip: '引擎上行极化；与所引频率计划不一致时依据列给计划极化' },
  { key: 'txXpd', group: 'tx', label: '极化隔离度下限', labelEn: 'Polarisation isolation (min)', unit: 'dB', kind: 'num', dec: 1, cmp: null, tip: '按运营商入网要求填' },
  { key: 'sunOutage', group: 'excl', label: '日凌预计中断', labelEn: 'Sun outage (predicted)', unit: 'min', kind: 'ro', dec: 1, cmp: null, tip: '春秋分两季合计，判据为收信站 C/N 恶化 ≥ 1 dB（收信站口径与下行频率定窗口）；不参与可用度连乘、不进中断预算' }
]

const ITEM_BY_KEY = Object.fromEntries(SLA_ITEMS.map((it) => [it.key, it]))
const GROUP_BY_KEY = Object.fromEntries(SLA_GROUPS.map((g) => [g.key, g]))

export const MIN_PER_YEAR = 365.25 * 24 * 60
export const MIN_PER_MONTH = MIN_PER_YEAR / 12

/**
 * ITU-R P.841 全球模型：年平均时间百分比 → 最坏月时间百分比 p_w = (p / 0.30)^(1/1.15)。
 * 与雨衰页 rainAttenuation.js 的换算逐字同一条式子。
 * 年 99.8 % → 最坏月 99.297 %；年 99.9 % → 99.615 %；年 99.99 % → 99.948 %。
 * @returns 最坏月可用度 %（入参非法返回 null）
 */
export function worstMonthAvail(availPct) {
  const a = num(availPct)
  if (a === null) return null
  const p = 100 - a
  if (!(p > 0)) return a
  return 100 - Math.min(100, Math.pow(p / 0.30, 1 / 1.15))
}
// 10·lg(4000)：dBW/Hz → dBW/4 kHz（运营商与 ITU 惯用的参考带宽）
const PSD_4K_DB = 36.02

// ============ 小工具 ============

export function num(v) {
  if (v === undefined || v === null || v === '') return null
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}

// 固定小数位（不做单位换档）。null → 空串。
export function fixed(v, dec) {
  const n = num(v)
  return n === null ? '' : n.toFixed(dec === undefined || dec === null ? 2 : dec)
}

/** 向下取档：返回 ≤ v 的最大档；一个都够不着返回 null。 */
export function snapDown(tiers, v) {
  const n = num(v)
  if (n === null) return null
  let out = null
  for (const t of tiers) if (n >= t - 1e-9 && (out === null || t > out)) out = t
  return out
}

/** 向上取档：返回 ≥ v 的最小档；超出全部档位时返回原值（不编一个更大的档出来）。 */
export function snapUp(tiers, v) {
  const n = num(v)
  if (n === null) return null
  let out = null
  for (const t of tiers) if (n <= t + 1e-12 && (out === null || t < out)) out = t
  return out === null ? n : out
}

/**
 * 把上下行不可用度按比例同步缩放，使系统可用度恰为 S。
 *   a = (100 − up)/100，b = (100 − dn)/100，s = S/100
 *   解 (1 − a·k)(1 − b·k) = s 的小根：k = [(a+b) − √((a+b)² − 4ab(1−s))] / (2ab)
 *   ab = 0 时退化为 k = (1 − s)/(a + b)
 * 这样保住工程师配的上下行分配（关口站带 UPC 给高、远端给低）。
 * @returns { up, dn, k } | null（两侧都已 100% 而 S < 100，或入参不成立）
 */
export function splitUnavailability(up, dn, S) {
  const u = num(up), d = num(dn), s0 = num(S)
  if (u === null || d === null || s0 === null) return null
  const a = (100 - u) / 100, b = (100 - d) / 100, s = s0 / 100
  if (!(a >= 0) || !(b >= 0)) return null
  const ab = a * b, sum = a + b
  let k
  if (sum <= 0) return s >= 1 ? { up: 100, dn: 100, k: 0 } : null   // 两侧都 100%：缩放不出 S<100
  if (ab <= 0) k = (1 - s) / sum
  else {
    const disc = sum * sum - 4 * ab * (1 - s)
    k = (sum - Math.sqrt(Math.max(0, disc))) / (2 * ab)
  }
  if (!Number.isFinite(k) || k < 0) return null
  const up2 = 100 - 100 * a * k, dn2 = 100 - 100 * b * k
  if (!(up2 > 0) || !(dn2 > 0) || up2 > 100 + 1e-9 || dn2 > 100 + 1e-9) return null
  return { up: up2, dn: dn2, k }
}

/**
 * 端到端：链上全部地球站节点的不可用度按同一 k 缩放，使 Π(1 − aᵢ·k) = S/100。
 * 节点数不定（一条链可以有三四个落地站），没有闭式解 → 二分。f(k) 在 [0, 1/max aᵢ) 上单调递减，
 * f(0) = 1 − s ≥ 0、k → 1/max aᵢ 时 f → −s < 0，故必有唯一根、二分必收敛。
 * @returns k | null（入参不成立）
 */
export function solveChainK(avails, S) {
  const a = []
  for (const v of (avails || [])) { const n = num(v); if (n !== null && n <= 100) a.push((100 - n) / 100) }
  const s0 = num(S)
  if (!a.length || s0 === null) return null
  const s = s0 / 100
  if (s > 1) return null
  const amax = Math.max.apply(null, a)
  if (!(amax > 0)) return s >= 1 ? 0 : null      // 全部 100%：缩放不出 S < 100
  const f = (k) => a.reduce((p, ai) => p * (1 - ai * k), 1) - s
  let lo = 0, hi = (1 / amax) * (1 - 1e-12)
  if (f(lo) < 0) return null
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m }
  return (lo + hi) / 2
}

/**
 * 三窗的档位扫描样本：逐标准档解出该档对应的上下行设计可用度，末尾附一个晴空样本（只喂 MIR）。
 * @param o { up, dn, single: 'up'|'dn'|'' }  single = 再生式上行/下行这类单侧体制
 */
export function slaSamplesFor(o) {
  o = o || {}
  const up = num(o.up), dn = num(o.dn)
  const single = o.single === 'up' || o.single === 'dn' ? o.single : ''
  const out = []
  for (const S of AVAIL_TIERS) {
    if (single === 'up') { out.push({ tag: String(S), tier: S, up: S, dn }) ; continue }
    if (single === 'dn') { out.push({ tag: String(S), tier: S, up, dn: S }); continue }
    // 同站回环：A = min(上行, 下行)，要恰为该档就是两侧同取 S（与建议值同一模型；乘积模型解出的
    // up = dn = √S 在 min 口径下是更高一档，档位表与着色参照就都对不上建议值）
    if (o.sameSite) { out.push({ tag: String(S), tier: S, up: S, dn: S }); continue }
    const k = splitUnavailability(up, dn, S)
    if (k) out.push({ tag: String(S), tier: S, up: k.up, dn: k.dn })
  }
  if (!out.length) return out
  // 晴空样本：两侧 100%（引擎 p = 0 即晴天）。ACM 峰值档要的正是这一份的 Es/N₀。
  out.push({ tag: 'clear', tier: null, up: 100, dn: 100 })
  return out
}

/** 端到端的档位扫描样本：逐档给一个缩放系数 k（对链上全部地球站节点同用一个） */
export function slaChainSamplesFor(avails) {
  const out = []
  for (const S of AVAIL_TIERS) {
    const k = solveChainK(avails, S)
    if (k !== null) out.push({ tag: String(S), tier: S, k })
  }
  return out
}

/**
 * 可用度构成里【传播之外】的那几格，按体制决定用到哪几项、各计入几次（只看体制，不看值）。
 *
 * 引擎的 systemAvailabilityResult 只是雨衰统计（上下行设计可用度之积），它默认设备永不故障、
 * 卫星永不倒换、地面回传永不断。合同里的可用度是这几件事同时成立的概率，故连乘：
 *   A_总 = A_传播 × A_发信射频 × A_收信射频 × A_卫星与载荷 × (A_基带/骨干网)
 * 填 100 的项不进这张表（也就不出现在依据列里）—— 「不计入」与「计入一个 100 %」在数值上
 * 一样，但依据列里多一个 100.000 % 是噪音。
 *
 * 各体制计入哪几项，判据是【这一段链路上真有哪些实体】：
 *   GEO / NGSO      发信射频 · 收信射频 · 卫星与载荷
 *   再生式 上行     发信射频 · 卫星与载荷（对端是卫星，没有收信地球站）
 *   再生式 下行     收信射频 · 卫星与载荷
 *   再生式 星间     卫星与载荷 × 2（两颗星都得在；微波与激光同口径）
 *   端到端          除末站外每站计一次发信射频、除首站外每站计一次收信射频、卫星逐颗计载荷
 *                   —— 中间转接站在链上既收又发，两条射频链都可能坏，故各计一次
 * 基带/骨干网独立于体制，勾了就乘一次。
 *
 * @param o { orbitType, regenMode, slaParams, esCount, satCount }
 * @returns number[]（%）
 */
export function equipSlots(o) {
  o = o || {}
  const ot = o.orbitType || 'GEO'
  const rm = ot === 'REGEN' ? (o.regenMode || 'uplink') : ''
  const out = []
  const add = (key, n) => { if (n > 0) out.push({ key, count: n }) }
  if (ot === 'E2E') {
    const nEs = Math.max(0, Math.round(num(o.esCount) === null ? 2 : num(o.esCount)))
    const nSat = Math.max(0, Math.round(num(o.satCount) === null ? 1 : num(o.satCount)))
    // 中间转接站既收又发：发信射频除末站外每站一次、收信射频除首站外每站一次。
    // 两站链（收发各一）与旧口径逐位相同；三站链才多乘一次。
    add('esTxAvail', Math.max(0, nEs - 1))
    add('esRxAvail', Math.max(0, nEs - 1))
    add('spaceAvail', nSat)
  } else if (rm === 'uplink') { add('esTxAvail', 1); add('spaceAvail', 1) }
  else if (rm === 'downlink') { add('esRxAvail', 1); add('spaceAvail', 1) }
  else if (rm === 'isl' || rm === 'laser') { add('spaceAvail', 2) }
  else { add('esTxAvail', 1); add('esRxAvail', 1); add('spaceAvail', 1) }
  add('groundAvail', 1)                         // 基带/骨干网恒占一格；勾没勾由 groundOn 决定计不计入
  return out
}

/**
 * 上面那几格按【当前填的值】展开成真正参与连乘的因子。
 * 填 100（或留空、非法）即不计入 —— 「不计入」与「计入一个 100 %」数值上一样，但依据列里
 * 多一个 100.000 % 是噪音；基带/骨干网另外还要看 groundOn 那道闸。
 * @returns [{ key, pct }]
 */
export function equipAvails(o) {
  o = o || {}
  const sp = Object.assign({}, DEFAULT_SLA_PARAMS, o.slaParams || null)
  const on = !!num(sp.groundOn)
  const out = []
  for (const s of equipSlots(o)) {
    if (s.key === 'groundAvail' && !on) continue
    const v = num(sp[s.key])
    if (v === null || !(v > 0) || v >= 100 - 1e-9) continue
    for (let i = 0; i < s.count; i++) out.push({ key: s.key, pct: v })
  }
  return out
}

/** 因子列表 → 连乘系数（≤ 1）。空列表返回 1；元素给数字或 { pct } 都认。 */
export function equipFactor(list) {
  return (list || []).reduce((p, v) => {
    const n = num(v && typeof v === 'object' ? v.pct : v)
    return p * (n === null ? 1 : n / 100)
  }, 1)
}

/**
 * 丢包率上界（%）：1 − (1 − 10⁻ⁿ)^(8L)。
 * @param n     设计误码率的指数（载波 ber 字段，10⁻ⁿ 的 n）
 * @param bytes IP 包长（B）
 */
export function packetLossPct(n, bytes) {
  const e = num(n), L = num(bytes)
  if (e === null || L === null || !(L > 0)) return null
  const p = Math.pow(10, -Math.abs(e))
  if (!(p > 0) || p >= 1) return null
  // 用 expm1/log1p 保精度：1 − (1−p)^N 在 p ~ 1e-9 时直接算会被浮点吃掉
  return -Math.expm1(8 * L * Math.log1p(-p)) * 100
}

/**
 * 帧差错模型的丢包率上界（%）：1 − (1 − 10⁻ⁿ)^N_f。
 * DVB-S2/S2X/RCS2 与 3GPP NTN 的门限都按 QEF 定义（ETSI EN 302 307-1 §4.1，约合 PER < 10⁻⁷），
 * LDPC+BCH 译码后的错误是【整帧】丢掉，不是比特级独立随机误码 —— 一个 IP 包落在几个帧里，
 * 就有几次被丢掉的机会。
 * @param n       帧差错率的指数（10⁻ⁿ 的 n）
 * @param frames  一个 IP 包跨的帧数 N_f
 */
export function frameLossPct(n, frames) {
  const e = num(n), N = num(frames)
  if (e === null || N === null || !(N > 0)) return null
  const p = Math.pow(10, -Math.abs(e))
  if (!(p > 0) || p >= 1) return null
  return -Math.expm1(N * Math.log1p(-p)) * 100
}

/**
 * 一个 IP 包跨几个 FEC 帧：N_f = ⌈8L / K⌉，K = 一帧净荷 bit。
 *   DVB 家族  K = 64800 × FEC 码率（正常 FECFRAME；表里没有 K_bch，这条近似的误差 < 0.5 %）
 *   3GPP NTN  K = 传输块大小 TBS
 * L ≤ 6 kB 时 DVB 支恒为 1 帧，于是 p_loss ≈ FER 本身。
 * @returns N_f | null（K 取不出来就不摆这条式子）
 */
export const DVB_FECFRAME_BITS = 64800
export function framesPerPacket(bytes, kBits) {
  const L = num(bytes), K = num(kBits)
  if (L === null || !(L > 0) || K === null || !(K > 0)) return null
  return Math.max(1, Math.ceil(8 * L / K))
}

/** 端到端 BER 串（'1×10⁻⁷' 或 '1.2e-7'）→ 等效指数 n（正数）。取不出返回 null。 */
export function berExpOf(s) {
  if (s === undefined || s === null || s === '') return null
  const str = String(s).trim()
  // 上标形式：'1×10⁻⁷' / '2.3×10⁻¹²'
  const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹'
  const m = /^([\d.]+)\s*[×x*]\s*10\s*(⁻?)([⁰¹²³⁴⁵⁶⁷⁸⁹]+)$/.exec(str)
  if (m) {
    const mant = parseFloat(m[1])
    let exp = 0
    for (const ch of m[3]) exp = exp * 10 + SUP.indexOf(ch)
    if (!Number.isFinite(mant) || !(mant > 0)) return null
    const val = mant * Math.pow(10, m[2] ? -exp : exp)
    return val > 0 ? -Math.log10(val) : null
  }
  const v = parseFloat(str)
  return Number.isFinite(v) && v > 0 ? -Math.log10(v) : null
}

// ============ MIR（ACM 峰值）============

// 一条 MODCOD 表行 → { label, k, esnoTh }。k = fec·rs·log2M/m（引擎的「组合效率」，
// 见 linkCalculator.js：esno = ebno + 10lg(k)，且 infoRate = symbolRate × k）。
function modcodSpec(row, m) {
  if (!row) return null
  const mf = modFactorOf(row.modulation)
  if (!mf) return null
  const fec = parseFrac(row.fec, NaN)
  const rs = parseFrac(row.rsCode, 1)
  if (!Number.isFinite(fec) || !(fec > 0) || !Number.isFinite(rs) || !(rs > 0)) return null
  const mm = num(m) || 1
  const k = fec * rs * mf / (mm > 0 ? mm : 1)
  if (!(k > 0)) return null
  const th = num(row.threshold)
  if (th === null) return null
  // 表行门限若是 Eb/N₀，用引擎同一式换算到 Es/N₀。
  // ★ snr 行落在 else 支：每 RE SNR ≡ 占用带宽内的 C/N ≡ Es/N₀，本来就不用换算（乘 k 会把它抬错一截）。
  const esnoTh = String(row.noiseRatioMode || 'esno').toLowerCase() === 'ebno' ? th + 10 * Math.log10(k) : th
  return { label: row.label || '', k, esnoTh }
}

// 3GPP NTN 的 ACM 峰值档：DVB 那套「MIR = 符号率 × 组合效率」用不了 —— snr 行根本没有符号率
// （引擎不出这一列），带宽是 PRB 数定的、速率是 TBS 定的。故改成：把 phy 的 PRB 数 / 子载波间隔 /
// 重复次数【钉住不动】，只把 MCS 换成表里的每一档，逐档算它的有效门限与信息速率，取晴空扛得住的
// 那档里速率最高的一条。这与 DVB 那支是同一个判据（占用带宽不变、只切调制编码），只是量换成了物理层的。
function pickMirPhy(rows, rawPhy, form, esno, margin, cir) {
  const base = normalizePhy(rawPhy)
  if (!base) return null
  let best = null
  for (const r of rows) {
    const mf = modFactorOf(r.modulation)
    const fec = parseFrac(r.fec, NaN)
    const th = num(r.threshold)
    if (!mf || !Number.isFinite(fec) || !(fec > 0) || th === null) continue
    if (String(r.noiseRatioMode || '').toLowerCase() !== 'snr') continue   // 混着老式行就跳过那几条
    const p = Object.assign({}, base)
    if (r.idx != null) {
      if (p.kind === 'nbiot') {
        // 行号是 I_MCS 还是 I_TBS，由【这张表是不是单音表】定（st，标准属性），不由当前子载波数定；
        // 自建标准没有 st，仍按子载波数判（与载波面板 applyModcod 同一把尺）
        const single = p.st === true || (p.st == null && p.nTones === 1)
        const st = single ? nbSingleToneMcs(r.idx) : null
        p.iTbs = st ? st.iTbs : r.idx
      } else p.mcs = r.idx
    }
    const thEff = effectiveThresholdDb(th, p)
    if (thEff === null || thEff + margin > esno + 1e-9) continue           // 晴空也支撑不起这一档
    const rate = infoRateKbps(normalizePhy(p), mf, fec)
    if (rate === null || !(rate > 0)) continue
    if (!best || rate > best.rate) best = { rate, label: r.label || '' }
  }
  if (!best) return null
  if (cir !== null && !(best.rate > cir + 1e-9)) return null               // 选不出比当前更高的档
  return { mir: best.rate, label: best.label }
}

/**
 * ACM 峰值档选择。
 * @param o { modcodRows, dvbStandard, form, phy, esnoClear, marginDb, symbolRateKsps, cirKbps }
 * @returns { mir, label, esnoClear } —— 选不出更高档 / 未选标准 / 晴空缺失时 mir = cirKbps、label = ''
 */
export function pickMir(o) {
  o = o || {}
  const cir = num(o.cirKbps)
  const out = { mir: cir, label: '', esnoClear: num(o.esnoClear) }
  const std = String(o.dvbStandard || 'custom')
  const rows = Array.isArray(o.modcodRows) ? o.modcodRows : []
  const esno = num(o.esnoClear)
  const sr = num(o.symbolRateKsps)
  const margin = num(o.marginDb)
  if (std === 'custom' || !rows.length || esno === null || margin === null) return out
  // 3GPP NTN 走另一支：它没有符号率这一列（见 pickMirPhy），故 sr 缺失不是退出条件
  if (o.phy && String((o.form && o.form.noiseRatioMode) || '') === 'snr') {
    const r = pickMirPhy(rows, o.phy, o.form, esno, margin, cir)
    if (r) { out.mir = r.mir; out.label = r.label }
    return out
  }
  if (sr === null) return out
  const m = (o.form && o.form.m) || 1
  let best = null
  for (const r of rows) {
    const sp = modcodSpec(r, m)
    if (!sp) continue
    if (sp.esnoTh + margin > esno + 1e-9) continue      // 晴空也支撑不起这一档
    if (!best || sp.k > best.k) best = sp
  }
  if (!best) return out
  const mir = sr * best.k
  if (cir !== null && !(mir > cir + 1e-9)) return out   // 选不出比当前更高的档 → MIR = CIR
  out.mir = mir
  out.label = best.label
  return out
}

// ============ 依据列 ============

// 依据由若干「片」拼成，每片可单独标红（链路不成立时的余量/占用）。
//   P(数字/单位/运算符)     —— 语言无关，textEn 留空
//   L(操作数名, 英文名)     —— 算式里那几个必须署名的量（可用度连乘的各环节）。名字【自成一片】：
//                              呈现层按整个文本节点精确查表，与数字拼在一起就查不到了。
const P = (text, bad, en) => ({ text: String(text), bad: !!bad, textEn: en === undefined || en === null ? null : String(en) })
const L = (zh, en) => P(zh, false, en)
// 「粘住右邻」的片：括号这类不该与后一片分开写的符号（min( 上行 …）。片与片默认按一个空格拼，
// 呈现层也按 span + span 加一档间距 —— 左括号后面多一个空格读起来像两个式子。
const PG = (text) => Object.assign(P(text), { glue: true })
export const basisText = (parts, en) => {
  const list = parts || []
  let out = ''
  for (let i = 0; i < list.length; i++) {
    const t = (en && list[i].textEn) ? list[i].textEn : list[i].text
    out += (i && !list[i - 1].glue ? ' ' : '') + t
  }
  return out
}

// 可用度连乘里各环节的署名。五个 99.99 % 并排摆着，不写名字读者分不出哪个是卫星、哪个是基带。
// 名字与 SLA_PARAM_LABELS / 参数轨同源，只是去掉「可用度」三个字（整行说的就是可用度）。
const AV_LABEL = {
  prop: L('传播', 'Propagation'),
  vis: L('互视', 'Visibility'),
  up: L('上行', 'Uplink'),
  dn: L('下行', 'Downlink'),
  esTxAvail: L('发信射频', 'Tx RF'),
  esRxAvail: L('收信射频', 'Rx RF'),
  spaceAvail: L('卫星与载荷', 'Satellite & payload'),
  groundAvail: L('基带/骨干网', 'Baseband / backbone')
}

// 日凌两季的署名（一年两段，分开摆才看得出量级）
const SO_LABEL = { vernal: L('春分', 'Vernal'), autumnal: L('秋分', 'Autumnal') }

// 时延算式里的操作数署名。「处理」在端到端里是两个不同的量：链上再生节点的【星上处理】
// （引擎出参）与两端调制解调的【地面处理】预留（SLA 参数），并排摆着不写名字分不出。
const DL_LABEL = {
  prop: AV_LABEL.prop,
  onboard: L('星上处理', 'On-board processing'),
  ground: L('地面处理', 'Ground processing')
}

// 光速（km/s）：单程时延那条式子与三个引擎里的写法逐字同一个数
const C_KM_S = 299792.458

/**
 * 可用度取档：向下取标准档；够不着最低档时取到 0.1 %（Ka 小站 / 月口径很容易掉到 99 以下，
 * 留一格空白的条款表交不出去）。
 */
function availTierOf(comp) {
  const v = num(comp)
  if (v === null) return null
  const t = snapDown(AVAIL_TIERS, v)
  return t === null ? Math.floor(v * 10) / 10 : t
}

/**
 * 发信站与收信站是不是同一个坐标（回环测试 / 自环）。是的话上下行雨衰完全相关，
 * 传播可用度取 min 而不是乘积。坐标优先取引擎回显（这次真正算的那一份），退到留底入参。
 */
export function sameSite(data, params) {
  const lp = (params && params.linkParams) || null
  const pick = (echo, key) => {
    const v = num(data && data[echo])
    return v !== null ? v : num(lp && lp[key])
  }
  const la = pick('earthLatitudeResult', 'latitude'), lo = pick('earthLongitudeResult', 'longitude')
  const lb = pick('rxLatitudeResult', 'rxLatitude'), lc = pick('rxLongitudeResult', 'rxLongitude')
  if (la === null || lo === null || lb === null || lc === null) return false
  return Math.abs(la - lb) < 1e-6 && Math.abs(lo - lc) < 1e-6
}
/**
 * 这条链路按不按「同站回环」模型算（传播可用度取 min 而不是乘积）。
 * ★ 两个条件都要：场景参数里勾了「同站回环」，且发收站坐标真的相同。只看坐标不行 —— GSO 新建行的
 *   发信站与收信站缺省都是北京那对经纬度，一开窗就会被判成回环，SLA 面板与链路表的可用度当场对不上账。
 */
export function slaLoopback(slaParams, data, params) {
  const sp = slaParams || {}
  return !!num(sp.loopback) && sameSite(data, params)
}

/**
 * 着色参照：扫描给的「最高可行档」是【传播域 · 年口径】的，采用值是综合域（且可能是月口径），
 * 两者得换到同一个域才可比。
 */
function refTier(tier, toWm, factor) {
  const t = num(tier)
  if (t === null) return null
  const v = toWm ? worstMonthAvail(t) : t
  return v === null ? null : v * (factor === null || factor === undefined ? 1 : factor)
}

/** 算式自检：写出来的式子代入自己给的数，结果得等于建议值。差得过大就不摆这个式子。 */
function bal(got, want, tol) {
  const a = num(got), b = num(want)
  if (a === null || b === null) return false
  return Math.abs(a - b) <= (tol === undefined ? Math.max(1e-6, Math.abs(b) * 1e-4) : tol)
}

/** 依据列里的百分数：小到 0.001 % 以下改科学计数，免得写成一串 0.0000 */
function pctText(v) {
  const n = num(v)
  if (n === null) return ''
  return Math.abs(n) >= 1e-3 ? n.toFixed(4) : n.toExponential(2)
}

/**
 * 3GPP NTN 一个传输时间间隔的时长（ms）。与 ntnPhy 的速率式逐项对应：
 *   NR      每 ms 有 2^μ 个时隙，TBS 是「每时隙」的 → TTI = 1/2^μ ms
 *   NB 下行  TBS 是「N_SF 个子帧」的，一个子帧 1 ms → TTI = N_SF ms
 *   NB 上行  TBS 是「N_RU 个 RU」的，RU 时长由子载波数/间隔定 → TTI = N_RU × T_RU
 * 于是信息速率 = TBS / (TTI × N_rep)，依据列照这条式子写。
 */
function ntnTtiMs(rawPhy) {
  const p = normalizePhy(rawPhy)
  if (!p) return null
  if (p.kind === 'nr') {
    const mu = MU_OF[p.scs]
    return mu === undefined ? null : 1 / Math.pow(2, mu)
  }
  const n = NB_SF_COUNT[p.dir === 'ul' ? p.iRu : p.iSf]
  if (!(n > 0)) return null
  const t = p.dir === 'ul' ? n * nbRuMs(p) : n
  return t > 0 ? t : null
}

// ============ 建议值推导 ============

// 取可用度：优先引擎回显（它就是这次计算真正用的那份），退到留底入参
function availOf(data, params, key, echo) {
  const v = num(data && data[echo])
  if (v !== null) return v
  return num(params && params.linkParams && params.linkParams[key])
}

// 端到端：链上各星地跳的站址可用度。
// ★ 取【跳】不取【节点】：系统可用度是各星地跳之积（见 linkChain 的 availPct），地面转接站
//   在两跳里各算一次；按节点列表去解缩放系数会少乘一次，档位就对不上了。
export function chainHopAvails(data) { return chainAvails(data) }
function chainAvails(data) {
  const hops = (data && Array.isArray(data.hops)) ? data.hops : []
  return hops.filter((h) => h && (h.type === 'up' || h.type === 'down')).map((h) => num(h.availabilityResult)).filter((v) => v !== null)
}

/**
 * 建议值推导。
 * @param ctx {
 *   orbitType 'GEO'|'NGSO'|'REGEN'|'E2E'，regenMode 'uplink'|'downlink'|'isl'|'laser'
 *   data      引擎出参（links[i].data / 端到端链结果）
 *   ok, error, resolvedMargin
 *   params    { satParams, linkParams, opt }（端到端为 null）
 *   carrierForm  载波表单（dvbStandard / ber / m …）
 *   modcodRows   该标准的 MODCOD 表行
 *   scan      档位扫描结果 { pin, rows, clear, message }（P2；缺则 MIR = CIR、可用度无参照档）
 *   fp        频率计划核对结果（checkAgainstChannel 返回的数组）
 *   slaParams 场景级 SLA 参数
 *   esCount, satCount  端到端专用：链上地球站数与卫星数（可用度构成逐个计入，见 equipAvails）
 * }
 * @returns { items: {…}, order: [key…], groups: [key…], scanRows, scanPin, scanMessage, feasibleTier,
 *            eqSlots（参数轨该显示哪几格）, eqParts（真正参与连乘的因子）, eqFactor }
 */
export function deriveSla(ctx) {
  ctx = ctx || {}
  const data = ctx.data || null
  const ok = ctx.ok !== false
  const params = ctx.params || null
  const form = ctx.carrierForm || {}
  const sp = Object.assign({}, DEFAULT_SLA_PARAMS, ctx.slaParams || null)
  const ot = ctx.orbitType || 'GEO'
  const rm = ot === 'REGEN' ? (ctx.regenMode || 'uplink') : ''
  const e2e = ot === 'E2E'
  const scan = ctx.scan || null
  // 考核周期：0 = 年平均（引擎那份统计的口径），1 = 最坏月（P.841 折算）
  const monthly = !!num(sp.monthly)

  const items = {}
  const order = []
  const put = (key, def) => {
    const base = ITEM_BY_KEY[def && def.baseKey ? def.baseKey : key] || {}
    const it = Object.assign({}, base, def, { key })
    if (!ok) { it.suggest = null; it.bad = true }
    items[key] = it
    order.push(key)
  }

  const out = {
    items, order, groups: [],
    monthly,
    scanRows: (scan && Array.isArray(scan.rows)) ? scan.rows : [],
    scanPin: (scan && scan.pin) || null,
    scanMessage: (scan && scan.message) || '',
    feasibleTier: null,
    // 可用度构成里传播之外的那几项：档位扫描表用 eqFactor 把「传播档」折算成「综合可用度」，
    // 参数轨用 eqSlots 决定显示哪几格（本体制用不到的环节不该出现在参数里）
    eqSlots: [], eqParts: [], eqFactor: 1
  }
  if (!data) return out

  // 扫描里余量 ≥ 0 的最高档（可用度采用值的参照）
  for (const r of out.scanRows) {
    const m = num(r && r.data && r.data.linkmargin)
    const tier = num(r && r.tier)
    if (m !== null && m >= 0 && tier !== null && (out.feasibleTier === null || tier > out.feasibleTier)) out.feasibleTier = tier
  }

  // 链路不成立时依据列要照给的诊断数（余量 / 占用），标红
  const failParts = []
  if (!ok) {
    const mode = (params && params.opt && params.opt.mode) || ''
    if (mode === 'margin') {
      const p = num(data.powerUsageRatio), b = num(data.bandwidthUsageRatio)
      if (p !== null) failParts.push(P(p.toFixed(2) + ' %', true))
      if (b !== null) failParts.push(P(b.toFixed(2) + ' %', true))
    }
    if (!failParts.length) {
      const m = num(data.linkmargin)
      if (m !== null) failParts.push(P(m.toFixed(2) + ' dB', true))
    }
  }

  // ---- 可用度 ----
  // 星间（微波 / 激光）：引擎那份 systemAvailabilityResult 是【几何互视时间占比】，与雨衰统计
  // 完全是两回事，故换个名字（互视可用度）出，但同样连乘卫星与载荷、同样向下取档 —— 同一个
  // 物理量不该因为载体是射频还是光就两种待遇。手动几何时引擎给空串，整组照旧不出。
  {
    const isVis = rm === 'isl' || rm === 'laser'
    const avKey = isVis ? 'visAvail' : 'propAvail'
    const avHead = isVis ? AV_LABEL.vis : AV_LABEL.prop
    // ★ 最坏月折算只对【传播】那一份做：P.841 是降雨时间百分比的经验式，星间互视是几何量、
    //   设备可用度本就是长期平均，两者都不折算。
    const toWm = monthly && !isVis
    let sys = num(data.systemAvailabilityResult)
    if (sys !== null) {
      // 传播可用度（引擎那一份）的依据：上下行两侧怎么乘出来的
      const propBasis = []
      if (e2e) {
        const av = chainAvails(data)
        if (av.length > 1) {
          av.forEach((v, i) => { if (i) propBasis.push(P('×')); propBasis.push(P(v.toFixed(3) + ' %')) })
          propBasis.push(P('='), P(sys.toFixed(3) + ' %'))
        } else propBasis.push(P(sys.toFixed(3) + ' %'))
      } else if (rm === 'uplink' || rm === 'downlink' || isVis) {
        propBasis.push(P(sys.toFixed(3) + ' %'))
      } else {
        const up = availOf(data, params, 'uplinkAvailability', 'uplinkAvailabilityResult')
        const dn = availOf(data, params, 'rxDownlinkAvailability', 'downlinkAvailabilityResult')
        if (up !== null && dn !== null) {
          // 同站回环（场景参数勾了「同站回环」且发收站同一坐标）：两侧的雨衰是【同一场雨】，不是两件独立的事，
          // 相乘会把可用度压低一倍不可用度。此时 A = min(上行, 下行)；档位扫描的样本同一模型（两侧同取该档）。
          if (slaLoopback(sp, data, params)) {
            sys = Math.min(up, dn)
            propBasis.push(PG('min('), AV_LABEL.up, P(up.toFixed(3) + ' %,'), AV_LABEL.dn, P(dn.toFixed(3) + ' %)'),
              P('='), P(sys.toFixed(3) + ' %'))
          } else {
            propBasis.push(AV_LABEL.up, P(up.toFixed(3) + ' %'), P('×'), AV_LABEL.dn, P(dn.toFixed(3) + ' %'),
              P('='), P(sys.toFixed(3) + ' %'))
          }
        } else propBasis.push(P(sys.toFixed(3) + ' %'))
      }
      // 最坏月：把上面算出的年口径整体折一次（端到端也是先把各星地跳乘完再折——P.841 是对
      // 单站降雨统计的经验式，逐跳折算再相乘会把保守叠两次；这一步是近似）。
      if (toWm) {
        const wm = worstMonthAvail(sys)
        if (wm !== null) {
          // 依据列换成折算那一步：年口径那个数就摆在式子里（档位表的「档位」列仍是它）
          propBasis.length = 0
          propBasis.push(P('100 − ((100 − ' + sys.toFixed(3) + ') / 0.30)^(1/1.15)'), P('='), P(wm.toFixed(3) + ' %'))
          sys = wm
        }
      }
      // 传播之外的因子（设备 / 空间段 / 地面段）。一项都没有时不出「传播可用度」那一行 ——
      // 它会与「系统可用度」逐字相同，一张表里同一个数写两遍。
      const eqArgs = { orbitType: ot, regenMode: rm, slaParams: sp, esCount: ctx.esCount, satCount: ctx.satCount }
      out.eqSlots = equipSlots(eqArgs).map((x) => x.key)
      out.eqParts = equipAvails(eqArgs)
      out.eqFactor = equipFactor(out.eqParts)
      const comp = sys * out.eqFactor
      // 取标准档这一步也写进依据：算出来 99.770 %、建议值却给 99.700 %，不写「→」两个数对不上账。
      // ★ 够不着最低标准档时不留空：向下取到 0.1 % —— 空一格的条款表交不出去。
      const tier = availTierOf(comp)
      const snapStep = (v) => (tier !== null && tier.toFixed(3) !== v.toFixed(3) ? [P('→'), P(tier.toFixed(3) + ' %')] : [])
      if (out.eqParts.length) {
        put(avKey, { basis: propBasis.concat(failParts), suggest: sys })
        const cb = [avHead, P(sys.toFixed(3) + ' %')]
        for (const f of out.eqParts) {
          cb.push(P('×'))
          if (AV_LABEL[f.key]) cb.push(AV_LABEL[f.key])
          cb.push(P(f.pct.toFixed(3) + ' %'))
        }
        cb.push(P('='), P(comp.toFixed(3) + ' %'))
        put('sysAvail', { basis: cb.concat(snapStep(comp), failParts), suggest: tier, ref: refTier(out.feasibleTier, toWm, out.eqFactor) })
      } else {
        put('sysAvail', { basis: propBasis.concat(snapStep(comp), failParts), suggest: tier, ref: refTier(out.feasibleTier, toWm, 1) })
      }
      // 依据列在 slaRows 里按【采用可用度】现拼：这一行的值就是从那个数算出来的，
      // 依据写着算出来的系统可用度、值却按取档后的那一档给，两个数对不上账
      put('outageMin', { basis: [], suggest: null, derived: 'outage' })
    }
  }

  // ---- 带宽与速率 ----
  // 结算带宽 = max(载波带宽, 功率等效带宽)，后者 = 功率占用比 × 转发器带宽（引擎 PowerBW 就是这么来的）。
  // 依据列把这一乘也摆出来：只写一个 199.803 kHz，读者无从知道它是占了转发器多大一块功率折出来的。
  const settledParts = (cbw, pr, tbw, pbw) => {
    const cand = [cbw, pbw].filter((v) => v !== null)
    if (!cand.length) return null
    const best = Math.max.apply(null, cand)
    // 占用比是引擎按三位小数回显的（链路表上就是这个数），拿它乘回去会差一个末位 ——
    // 容差就按那一位的舍入界给：±0.0005 % × 转发器带宽(kHz)。差得比这还多说明不是同一本账，
    // 那就不展开，照写功率等效带宽本身。
    const pw = (pr !== null && tbw !== null && bal(pr / 100 * tbw * 1000, pbw, Math.max(1e-3, tbw * 0.005)))
      ? pr.toFixed(3) + ' % × ' + (tbw * 1000).toFixed(3)
      : (pbw === null ? null : pbw.toFixed(3))
    const parts = (cbw !== null && pw !== null)
      ? [P('max(' + cbw.toFixed(3) + ', ' + pw + ')')]
      : [P(cand[0].toFixed(3))]
    parts.push(P('='), P(best.toFixed(3) + ' kHz'))
    return { parts, best }
  }
  if (e2e) {
    // 逐透明星一行，不合成链级数（「链级占比」是编出来的指标）
    const txp = Array.isArray(data.transponders) ? data.transponders : []
    txp.forEach((t, i) => {
      const cbw = num(t.carrierBandwidthResult)
      const pr = num(t.powerRatioResult), tbw = num(t.transponderBandwidthResult)
      const pbw = (pr !== null && tbw !== null) ? pr / 100 * tbw * 1000 : null
      const r = settledParts(cbw, pr, tbw, pbw)
      if (r) put('settledBw:' + i, { baseKey: 'settledBw', sub: t.name || '', basis: r.parts, suggest: r.best })
    })
  } else if (ot === 'GEO' || ot === 'NGSO') {
    // ★ 只对弯管体制出：再生式星上解调再调制，没有转发器，引擎那份 PowerBWResult / 转发器带宽
    //   是占位参数（36 MHz / BOi 6 / BOo 3）算出的弯管量，星间 / 激光更无从谈起 —— 不能写进合同条款。
    const r = settledParts(num(data.allocBandwidthResult), num(data.powerUsageRatio),
      num(data.transponderBandwidthResult), num(data.PowerBWResult))
    if (r) put('settledBw', { basis: r.parts, suggest: r.best })
  }

  const cir = num(data.infoRateResult)
  const symRate = num(data.symbolRateResult)
  if (cir !== null) {
    // DVB：信息速率 = 符号率 × 组合效率 k（k = fec·rs·log2M/m，引擎同一个数）。
    // 3GPP NTN 没有符号率这一列（见 ntnPhy 头注），速率由 TBS / (TTI × N_rep) 定 —— 两条式子都算得平才写。
    const basis = []
    const tbs = num(data.phyTbsResult)
    const tti = ntnTtiMs(form.phy)
    const rep = Math.max(1, Math.round(num(data.phyRepResult) || 1))
    if (symRate !== null && symRate > 0) {
      basis.push(P(symRate.toFixed(2) + ' ksps'), P('×'), P((cir / symRate).toFixed(4)), P('='), P(cir.toFixed(3) + ' kbps'))
    } else if (tbs !== null && tti !== null && bal(tbs / (tti * rep), cir)) {
      basis.push(P(tbs + ' bit'), P('/'),
        P(rep > 1 ? '(' + fmtScaled(tti) + ' ms × ' + rep + ')' : fmtScaled(tti) + ' ms'),
        P('='), P(cir.toFixed(3) + ' kbps'))
    }
    put('cir', { basis, suggest: cir })

    // MIR：端到端不做 ACM 外推（逐段体制可不同）；其余体制在选了 MODCOD 标准时按晴空样本切档。
    // 系统余量优先取求解器回传的全精度值；再生式那三条子链路的 out 里没有它，退到引擎回显的 marginResult
    //（引擎按显示精度截过两位，够用——MIR 是切档判据，不是逐位复算的量）。
    const clear = scan && scan.clear ? scan.clear : null
    const sysMargin = num(ctx.resolvedMargin) !== null ? num(ctx.resolvedMargin) : num(data.marginResult)
    const mr = e2e ? { mir: cir, label: '', esnoClear: null } : pickMir({
      modcodRows: ctx.modcodRows,
      dvbStandard: form.dvbStandard,
      form,
      phy: form.phy || null,      // 3GPP NTN：切档时 PRB 数 / 子载波间隔 / 重复次数钉住不动，只换 MCS
      esnoClear: clear && clear.data ? clear.data.esnoActualResult : null,
      marginDb: sysMargin,
      symbolRateKsps: symRate,
      cirKbps: cir
    })
    // 依据 = 晴空 Es/N₀ 扣掉系统余量（这就是 pickMir 逐档比的那个门限预算）→ 切到哪一档 → 该档速率。
    // 只写一个晴空 Es/N₀ 说明不了「凭什么能切档」。
    const mb = []
    const esnoC = num(mr.esnoClear)
    if (esnoC !== null) {
      if (sysMargin !== null) mb.push(P(esnoC.toFixed(2)), P('−'), P(sysMargin.toFixed(2)), P('='), P((esnoC - sysMargin).toFixed(2) + ' dB'))
      else mb.push(P(esnoC.toFixed(2) + ' dB'))
    }
    if (mr.label && form.modcodLabel) mb.push(P(form.modcodLabel), P('→'), P(mr.label))
    else if (mr.label) mb.push(P('→'), P(mr.label))
    // 切得出档就用「=」收尾（前面那截已经把档换过了）；切不出档时门限预算与速率之间不是等号，
    // 用「→」——「11.02 dB = 2048.000 kbps」是把 dB 和 kbps 划了等号
    if (mb.length && num(mr.mir) !== null) mb.push(P(mr.label ? '=' : '→'), P(num(mr.mir).toFixed(3) + ' kbps'))
    put('mir', { basis: mb, suggest: mr.mir })
  }

  // ---- 时延与丢包 ----
  const owd = num(data.e2eDelayResult) !== null ? num(data.e2eDelayResult)
    : (rm === 'isl' || rm === 'laser') ? num(data.islDelayResult)
      : num(data.linkDelayResult)
  if (owd !== null) {
    const ob = []
    if (e2e) {
      const prop = num(data.propDelayResult), proc = num(data.procDelayResult)
      if (prop !== null && proc !== null && bal(prop + proc, owd, 0.002)) {
        ob.push(DL_LABEL.prop, P(prop.toFixed(3)), P('+'), DL_LABEL.onboard, P(proc.toFixed(3)),
          P('='), P(owd.toFixed(3) + ' ms'))
      }
    } else {
      // 单程时延 = 路径总距离 / 光速（三个引擎逐字同一条式子）。距离取引擎回填的斜距 / 星间距离
      //（GEO 不出分段时延这一列，只有斜距）。算不平就退到分段时延，再算不平留「—」。
      const legs = []
      const push = (v) => { const n = num(v); if (n !== null && n > 0) legs.push(n) }
      if (rm === 'isl' || rm === 'laser') push(data.islRfDistResult)
      else {
        if (rm !== 'downlink') push(data.slantRangeResult)
        push(data.islDistanceResult)
        if (rm !== 'uplink') push(data.rxSlantRangeResult)
      }
      const tot = legs.reduce((a, b) => a + b, 0)
      const u = num(data.linkDelayUpResult), d = num(data.linkDelayDownResult)
      if (legs.length && bal(tot / C_KM_S * 1000, owd, 0.06)) {
        ob.push(P((legs.length > 1 ? '(' + legs.map((v) => v.toFixed(2)).join(' + ') + ')' : legs[0].toFixed(2)) + ' km'),
          P('/'), P(C_KM_S + ' km/s'), P('='), P(owd.toFixed(1) + ' ms'))
      } else if (u !== null && d !== null && bal(u + d, owd, 0.06)) {
        ob.push(P(u.toFixed(1)), P('+'), P(d.toFixed(1)), P('='), P(owd.toFixed(1) + ' ms'))
      }
    }
    // 拆不出路径 / 两段时依据列留「—」：把建议值原样抄一遍不是依据
    put('owd', { basis: ob, suggest: owd })
    // 再生式上行/下行只出「本段单程时延」：RTT 由工程师按整条业务链填
    if (rm !== 'uplink' && rm !== 'downlink' && rm !== 'isl' && rm !== 'laser') {
      // ★ 处理时延预留是【单程】口径（发端调制 + 收端解调合计），一次往返穿两趟 → 整体 × 2。
      //   数值与「× 2 的每端口径」恒等，改的是口径不是数。
      const proc = num(sp.procMsPerEnd) || 0
      const rtt = Math.ceil((2 * (owd + proc)) / 10) * 10
      put('rtt', {
        basis: [PG('⌈2 × ('), P(owd.toFixed(1) + ' +'), DL_LABEL.ground, P(fmtScaled(proc) + ') / 10⌉ × 10'),
          P('='), P(rtt + ' ms')],
        suggest: rtt
      })
    }
  }

  // 设计误码率：载波配置里的那个数原样带出（不是算出来的量，依据列留「—」）
  const berShown = e2e ? String(data.e2eBerResult || '') : String(data.berResult || '')
  if (berShown) put('berTarget', { basis: [P('—')], suggest: berShown, text: true })
  // 3GPP NTN 载波：差错性能那一格是【首传 BLER 目标】（TS 38.214，缺省 10 %），引擎经 phyBlerResult 回显 ——
  // 它是 berTarget 在 3GPP 这一侧的对应物，同样原样带出。判 NTN 的三个信号任一成立即算：引擎回显了 BLER 或
  // 传输块（走了 snr 链），或载波表单本身就是 snr 口径（MODCOD 库里带体制的自建标准也在此列）。
  const blerShown = String(data.phyBlerResult || '')
  const ntn = blerShown !== '' || num(data.phyTbsResult) !== null
    || (String(form.noiseRatioMode || '') === 'snr' && String(form.dvbStandard || 'custom') !== 'custom')
  if (blerShown) put('blerTarget', { basis: [P('—')], suggest: blerShown, text: true })

  // 丢包率上界。分两支：
  //   DVB 家族（S2/S2X/RCS2）门限按 QEF 定义，译码后的错误是【整帧】丢掉 ——
  //     p = 1 − (1 − FER)^N_f，N_f = ⌈8L / K⌉，K = 一帧净荷 bit；
  //   未选标准（custom）＝无编码/比特独立随机误码，保留原式 1 − (1 − BER)^(8L)。
  // 两支差三四个数量级：把随机误码模型算出的 0.5 % 写进合同是不可交付的承诺（TCP 吞吐随 1/√p 崩）。
  // ★ 3GPP NTN 不出这一条（2026-09-07 深审 #4）：那套 MCS 表的门限是【首传 BLER 目标】（缺省 10 %），既不是 QEF，
  //   平台也没建 HARQ 重传模型 —— 拿 10⁻⁷ 套传输块算出 0.001 % 是把 DVB 的口径硬安到 3GPP 上；拿 10 % 首传 BLER
  //   直接算又是几十个百分点这种没有 HARQ 的数。两个都不能写进合同，差错性能那一格由上面的 blerTarget 给。
  const pkt = num(sp.pktBytes)
  if (pkt !== null && !ntn) {
    const coded = String(form.dvbStandard || 'custom') !== 'custom'
    let raw = null, head = null
    if (coded) {
      const fer = num(sp.ferExp)
      const fecStr = (params && params.linkParams && params.linkParams.fec !== undefined && params.linkParams.fec !== null && params.linkParams.fec !== '')
        ? params.linkParams.fec : form.fec
      const fec = parseFrac(fecStr, NaN)
      // DVB 家族一帧取正常 FECFRAME 64800 bit × FEC 码率
      //（表里没有 K_bch，这条近似的误差 < 0.5 %，故依据列只写 N_f 不写 K）
      const kBits = Number.isFinite(fec) && fec > 0 ? DVB_FECFRAME_BITS * fec : null
      const nf = framesPerPacket(pkt, kBits)
      if (fer !== null && nf !== null) {
        raw = frameLossPct(fer, nf)
        head = '1 − (1 − ' + expText(fer) + ')^' + nf
      }
    } else {
      const nExp = e2e ? berExpOf(data.e2eBerResult)
        : (berExpOf(data.berResult) !== null ? berExpOf(data.berResult)
          : num(params && params.linkParams ? params.linkParams.ber : form.ber))
      if (nExp !== null) {
        raw = packetLossPct(nExp, pkt)
        head = '1 − (1 − ' + expText(nExp) + ')^' + Math.round(8 * pkt)
      }
    }
    if (raw !== null) {
      const snapped = snapUp(LOSS_TIERS, raw)
      const lb = [P(head), P('='), P(pctText(raw) + ' %')]
      // 向上取档也写进依据：算出来 0.0178 %、建议值给 0.050 %，不写「→」两个数对不上账
      if (snapped !== null && fixed(snapped, 3) !== fixed(raw, 3)) lb.push(P('→'), P(fixed(snapped, 3) + ' %'))
      put('loss', { basis: lb, suggest: snapped, raw })
    }
  }

  // 时延抖动：纯合同条款，无计算依据（同响应/恢复那两条）
  if (owd !== null) put('jitter', { basis: [P('—')], suggest: num(sp.jitterMs) })

  // ---- 故障响应与恢复（纯合同条款，无计算依据）----
  put('respond', { basis: [P('—')], suggest: num(sp.respondMin) })
  put('restore', { basis: [P('—')], suggest: num(sp.restoreH) })

  // ---- 发射合规（只在有客户发射端的体制/模式出）----
  const hasTx = ot === 'GEO' || ot === 'NGSO' || rm === 'uplink' || e2e
  if (hasTx) {
    const hop0 = e2e ? ((Array.isArray(data.hops) ? data.hops : []).find((h) => h && h.type === 'up') || null) : null
    if (!e2e || hop0) {
      const fpNums = fpNumbers(ctx.fp)
      // 频率：引擎出 GHz，界面按 MHz 四位小数
      const fGhz = e2e ? num(hop0.frequencyResult) : num(data.uplinkFrequencyResult)
      const bwKHz = num(data.allocBandwidthResult)
      if (fGhz !== null) {
        // 中心频率报备时看的是它占住的那一段：fc ± B/2。引用了频率计划的再附该转发器的频带 ——
        // fpNumbers 只在越界时给得出这两个数，故连同「⊄」一起标红。
        const fb = []
        if (bwKHz !== null) fb.push(P((fGhz * 1000).toFixed(4)), P('±'), P((bwKHz / 2000).toFixed(4) + ' MHz'))
        if (fpNums.f1 !== null && fpNums.f2 !== null) {
          if (fb.length) fb.push(P('⊄', true))
          fb.push(P(fpNums.f1.toFixed(4) + ' ~ ' + fpNums.f2.toFixed(4) + ' MHz', true))
        }
        put('txFreq', { basis: fb, suggest: fGhz * 1000 })
      }
      if (bwKHz !== null) {
        // DVB：分配带宽 = 符号率 × 带宽系数（滚降），照这条式子写。
        // 3GPP NTN 走 snr 链，这一格报的是【信道带宽】—— 标准栅格上的一档，没有这一乘；
        // 能写的只有「它至少要装下多宽的占用带宽」（引擎的 noiseBw 就是 B_occ）。两者相等时
        // 不写，那等于把建议值抄一遍。
        const bb = []
        const sr = num(data.symbolRateResult)
        const occ = num(data.noiseBwResult)
        if (sr !== null && sr > 0) {
          bb.push(P(sr.toFixed(2) + ' ksps'), P('×'), P((bwKHz / sr).toFixed(3)), P('='), P(bwKHz.toFixed(3) + ' kHz'))
        } else if (occ !== null && occ > 0 && occ < bwKHz - 1e-6) {
          bb.push(P('≥'), P(occ.toFixed(3) + ' kHz'))
        }
        if (fpNums.bwOverMHz !== null) bb.push(P('+' + fpNums.bwOverMHz.toFixed(3) + ' MHz', true))
        put('txBw', { basis: bb, suggest: bwKHz })
      }
      const tol = num(sp.eirpTolDb) || 0
      // ★ 引擎的 stationEIRP / stationPSD 是【设计可用度下、穿过上行雨衰打到星上】所需的发射电平
      //   （UPPOWER 含 +上行雨衰，实测 rain 0 → 46 mm/h 时 stationEIRP 恰随雨衰 1:1 上抬），本身就是雨天峰值；
      //   UPC 只是「晴天少发、下雨补回」的运行方式，不能再往上加 —— 加了就是把同一段雨衰算两遍。
      //   引擎之外的额外发射能力只有一种：UPC 余量【大于】上行雨衰的那部分（自定义 UPC 档给了更大的抬升空间）。
      //   「设置功放功率」方式下 EIRP 由功放定死、不随雨衰变，这一项恒为 0。取不到或为 0 时依据列不摆 + 0.00。
      const upcRaw = e2e ? num(hop0.upcMarginResult) : num(data.UPCmarginResult)
      const rainUp = e2e ? num(hop0.rainResult) : num(data.uplinkRainAttenuation)
      const modePa = !e2e && !!(params && params.opt && params.opt.mode === 'power')
      const rainRef = rainUp === null ? 0 : Math.max(0, rainUp)
      const upc = (!modePa && upcRaw !== null && upcRaw > rainRef + 1e-9) ? upcRaw - rainRef : 0
      const eirp = e2e ? num(hop0.stationEirpResult) : num(data.stationEIRPResult)
      if (eirp !== null) {
        const eb = [P(eirp.toFixed(2))]
        if (upc) eb.push(P('+'), P(upc.toFixed(2)))
        eb.push(P('+'), P(tol.toFixed(1)), P('='), P((eirp + upc + tol).toFixed(2) + ' dBW'))
        put('txEirp', { basis: eb, suggest: eirp + upc + tol })
      }
      const psd = e2e ? num(hop0.stationPsdResult) : num(data.stationPSDResult)
      if (psd !== null) {
        const pb = [P(psd.toFixed(2) + ' dBW/Hz'), P('+'), P(String(PSD_4K_DB))]
        if (upc) pb.push(P('+'), P(upc.toFixed(2)))
        pb.push(P('+'), P(tol.toFixed(1)), P('='), P((psd + PSD_4K_DB + upc + tol).toFixed(2) + ' dBW/4kHz'))
        put('txPsd', { basis: pb, suggest: psd + PSD_4K_DB + upc + tol })
      }
      const pol = e2e ? (hop0.polarizationResult || '') : (data.uplinkPolarizationResult || '')
      if (pol) put('txPol', { basis: fpNums.pol ? [P(fpNums.pol, true)] : [P('—')], suggest: String(pol), text: true })
      put('txXpd', { basis: [P('—')], suggest: num(sp.xpdMinDb) })
    }
  }

  // ---- 免责事件（只对 GEO 出）----
  // 日凌每年春秋分各一段，必然发生、无法规避，量级与 99.99 % 的年预算同级（Ku 2.4 m 站
  // 约 30 min/年，99.99 % 一年才 52.6 min）。专业 SLA 要么把它列为免责事件并给出预计窗口，
  // 要么计入可用度 —— 这里取前者：单列一行，不参与连乘、不进中断预算。
  // NGSO 跟踪运动星、再生式与端到端各段几何各异，都不出这一条。
  if (ot === 'GEO' && ctx.sunOutage) {
    const v = num(ctx.sunOutage.vernal && ctx.sunOutage.vernal.minutes)
    const a = num(ctx.sunOutage.autumnal && ctx.sunOutage.autumnal.minutes)
    if (v !== null || a !== null) {
      const tot = (v === null ? 0 : v) + (a === null ? 0 : a)
      const sb = (v !== null && a !== null)
        ? [SO_LABEL.vernal, P(v.toFixed(1)), P('+'), SO_LABEL.autumnal, P(a.toFixed(1)), P('='), P(tot.toFixed(1) + ' min')]
        : [v !== null ? SO_LABEL.vernal : SO_LABEL.autumnal, P(tot.toFixed(1) + ' min')]
      put('sunOutage', { basis: sb, suggest: tot })
    }
  }

  out.groups = SLA_GROUPS.map((g) => g.key).filter((gk) => order.some((k) => items[k].group === gk))
  return out
}

/**
 * 日凌合计：把 calculateSunOutage 的两季结果收成 deriveSla 认的形状。
 * 每季 { minutes, days, rows }：rows 逐日给日期 / 起止 / 时长（UTC 与北京时两套），
 * 报告的「日凌预计窗口」表直接照抄。
 * @param res { vernal, autumnal } —— 各是 calculateSunOutage 的返回值（error:true 的那季丢掉）
 */
export function sunOutageSummary(res) {
  const one = (r) => {
    if (!r || r.error || !Array.isArray(r.dailyResults) || !r.dailyResults.length) return null
    const rows = r.dailyResults.map((d) => ({
      date: d.date, dateBJT: d.dateBJT,
      startUTC: d.startTimeUTC, endUTC: d.endTimeUTC,
      startBJT: d.startTimeBJT, endBJT: d.endTimeBJT,
      durationSec: d.durationSec, peakCNdeg: d.peakCNdeg
    }))
    return { minutes: rows.reduce((n, d) => n + (num(d.durationSec) || 0), 0) / 60, days: rows.length, rows }
  }
  const v = one(res && res.vernal), a = one(res && res.autumnal)
  return (v || a) ? { vernal: v, autumnal: a } : null
}

// 依据列里的误码率：整数指数写成 10⁻ⁿ，端到端那种各段之和（非整幂）照实写科学计数
function expText(n) {
  const v = num(n)
  if (v === null) return ''
  const r = Math.round(v)
  if (Math.abs(v - r) < 1e-6) {
    const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹'
    return '10⁻' + String(Math.abs(r)).split('').map((c) => SUP[Number(c)] || c).join('')
  }
  return Math.pow(10, -Math.abs(v)).toExponential(2)
}

// 频率计划核对结果 → 纯数值（不写「越界」二字，只给超出量与计划极化）
function fpNumbers(fp) {
  const out = { f1: null, f2: null, bwOverMHz: null, pol: '' }
  if (!Array.isArray(fp)) return out
  for (const c of fp) {
    if (!c) continue
    const n = c.nums || {}
    if (c.code === 'outOfBand') { out.f1 = num(n.f1); out.f2 = num(n.f2) }
    else if (c.code === 'bwOver') { const o = num(n.occBwMHz), b = num(n.bw); if (o !== null && b !== null) out.bwOverMHz = o - b }
    else if (c.code === 'polUp') out.pol = String(n.pol || '')
  }
  return out
}

// ============ 面板行 / 报告块 ============

const includeOf = (rowSla, key) => !(rowSla && rowSla.include && rowSla.include[key] === false)
const adoptOf = (rowSla, key) => {
  const v = rowSla && rowSla.adopt ? rowSla.adopt[key] : undefined
  return (v === undefined || v === null || String(v).trim() === '') ? null : v
}

/**
 * 面板行（组头 + 条款行交织）。
 * @param fmt 可选 (value, unit) => { text, unit, factor }（见 adaptUnits.fmtQtyParts）：
 *        速率/带宽这几项按功能区「单位」档换档显示。★ 单位落在【单独一列】、并回传换档倍率 ——
 *        采用值那格是可编辑的，用户按屏上的单位输入，回存前必须除回基准单位。
 *        不给 fmt 即一律留在基准单位（出厂锁定档就是这一路）。
 * @param en  true = 依据列取英文（报告那条路；界面那条路由呈现层逐片查表翻译，不传这个参数）
 */
export function slaRows(derived, rowSla, params, fmt, en) {
  const d = derived || { items: {}, order: [], groups: [] }
  const rows = []
  const partsOf = (it) => {
    if (it.qty && typeof fmt === 'function' && it.suggest !== null && it.suggest !== undefined) {
      const p = fmt(it.suggest, it.unit)
      return { unit: p.unit || it.unit || '', factor: p.factor || 1 }
    }
    return { unit: it.unit || '', factor: 1 }
  }
  const show = (it, v, factor) => {
    if (v === null || v === undefined || v === '') return ''
    if (it.kind === 'text') return String(v)
    if (it.qty) return fmtScaled(v * (factor || 1))
    return fixed(v, it.dec)
  }
  // 考核周期：年 / 最坏月。条款名与中断上限的分母都跟着它走。
  const monthly = !!(d.monthly)
  const periodMin = monthly ? MIN_PER_MONTH : MIN_PER_YEAR
  // 中断上限跟着「采用可用度」走
  const availKey = 'sysAvail'
  const availIt = d.items[availKey]
  const availEff = availIt ? (num(adoptOf(rowSla, availKey)) !== null ? num(adoptOf(rowSla, availKey)) : availIt.suggest) : null

  for (const gk of d.groups) {
    const g = GROUP_BY_KEY[gk]
    const keys = d.order.filter((k) => d.items[k].group === gk)
    if (!keys.length) continue
    rows.push({ kind: 'group', key: gk, label: (g && g.label) || gk, labelEn: (g && g.labelEn) || gk })
    for (const key of keys) {
      const it = d.items[key]
      // 中断上限＝(100 − 采用可用度)/100 × 一个考核周期的分钟数：采用值改了要跟着变
      const suggest = it.derived === 'outage'
        ? ((availEff === null || it.bad) ? null : (100 - availEff) / 100 * periodMin)
        : it.suggest
      // 只读读数（传播 / 互视可用度、设计误码率）没有采用值格：即便存量场景里留着一个 adopt，
      // 也一律按建议值走，否则屏幕上没处改、报告里却印着一个改过的数。
      // ro:true 是给「文本型只读」用的（kind 仍是 text，值要原样印不走数字格式化）。
      const readonly = it.kind === 'ro' || !!it.ro
      const adoptRaw = readonly ? null : adoptOf(rowSla, key)
      const adopt = adoptRaw === null ? null : (it.kind === 'text' ? String(adoptRaw) : num(adoptRaw))
      const eff = adopt === null ? suggest : adopt
      // 采用值比建议更激进 → 该格着色（纯数值辅助，不出判定文字）。
      // 参照优先取 it.ref（可用度那一条＝扫描里余量 ≥ 0 的最高档：链路还能拉到哪一档，只有扫过才知道）；
      // 没扫过就退到建议值——那是保守代理（建议 = 当前设计点算出来的可用度向下取档），
      // 只会把「明明超出当前设计」的采用值标出来，不会漏标。
      let bad = false
      if (adopt !== null && it.cmp && it.kind !== 'text') {
        const ref = (it.ref !== undefined && it.ref !== null) ? it.ref : suggest
        if (ref !== null && ref !== undefined) bad = it.cmp === 'gt' ? adopt > ref + 1e-9 : adopt < ref - 1e-9
      }
      const { unit, factor } = partsOf(Object.assign({}, it, { suggest }))
      let basis = it.basis || []
      if (it.derived === 'outage' && availEff !== null && !it.bad) {
        basis = [P('(100 − ' + availEff.toFixed(3) + ') / 100 × ' + Math.round(periodMin)),
          P('='), P(fixed(suggest, 0) + ' min')]
      }
      if (!basis.length) basis = [P('—')]
      rows.push({
        kind: 'item', key, group: gk,
        label: (monthly && it.labelMonthly) || it.label,
        labelEn: (monthly && it.labelMonthlyEn) || it.labelEn,
        sub: it.sub || '', tip: it.tip || '',
        unit, factor, type: it.kind || 'num', ro: readonly, dec: it.dec, qty: !!it.qty,
        basis, basisText: basisText(basis, en),
        suggest, suggestText: show(it, suggest, factor),
        // adopt 存的是【基准单位】的原值；adoptShown 是按当前显示档换过档的那个数（NumBox 用）
        adopt: adoptRaw === null ? '' : adoptRaw,
        adoptShown: adopt === null ? null : (it.kind === 'text' ? adopt : adopt * factor),
        effective: eff, effectiveText: show(it, eff, factor),
        include: includeOf(rowSla, key),
        bad
      })
    }
  }
  void params   // 场景级参数已在 deriveSla 里落进各条款的建议值，此处只保留签名对称
  return rows
}

/**
 * 报告用的档位扫描行：把「综合」与「中断」按当前考核周期与设备因子算好（与屏上那张表同一条
 * 式子，见 LbSlaPane 的 cellOf）。晴空样本不进这张表（它只喂 MIR）。
 * @returns { pin, rows } | null
 */
export function slaScanReportRows(derived) {
  const d = derived || {}
  const f = (typeof d.eqFactor === 'number' && isFinite(d.eqFactor) && d.eqFactor > 0) ? d.eqFactor : 1
  const per = d.monthly ? MIN_PER_MONTH : MIN_PER_YEAR
  const rows = ((d.scanRows || []).filter((r) => r && r.tag !== 'clear')).map((r) => {
    const t = num(r.tier)
    const base = t === null ? null : (d.monthly ? worstMonthAvail(t) : t)
    const comp = base === null ? null : base * f
    return Object.assign({}, r, { comp, outage: comp === null ? null : (100 - comp) / 100 * per })
  })
  return rows.length ? { pin: d.scanPin || null, rows } : null
}

/**
 * 报告块（纯数据；标签已按 lang 翻好，basis 是一行纯数字串）。
 * 没有任何入报告条款时返回 null。
 */
export function slaReportBlock(derived, rowSla, params, lang, fmt) {
  const en = lang === 'en'
  const rows = slaRows(derived, rowSla, params, fmt, en)
  const out = []
  let group = ''
  for (const r of rows) {
    if (r.kind === 'group') { group = en ? r.labelEn : r.label; continue }
    if (!r.include) continue
    // label 与 sub 分开带走：sub 是「这一行说的是哪颗透明星」（端到端逐星一行）。
    // 逐链路明细里两者拼起来；总报告矩阵是【多条链共用一行】，只有各链的 sub 一致时才敢拼——
    // 链 1 的 settledBw:0 是中星 6D、链 2 的是另一颗，拼上就是给一行数据挂了个错名字。
    out.push({
      key: r.key, group: r.group, groupLabel: group,
      label: en ? r.labelEn : r.label, sub: r.sub || '',
      basis: r.basisText,
      suggest: r.suggestText,
      adopt: r.adopt === '' ? '' : r.effectiveText,
      // 总报告矩阵用的那一格：采用值优先，留空即建议值
      value: r.effectiveText,
      unit: r.unit
    })
  }
  return out.length ? { rows: out } : null
}

// SLA 参数在报告 §4 末尾附成一行参数表。标签在这里按 lang 翻好后随模型走
//（两个渲染器都不认中文原文、也不各带一份字典）。
export const SLA_PARAM_LABELS = [
  { key: 'esTxAvail', label: '发信射频可用度', labelEn: 'Transmit RF availability', unit: '%' },
  { key: 'esRxAvail', label: '收信射频可用度', labelEn: 'Receive RF availability', unit: '%' },
  { key: 'spaceAvail', label: '卫星与载荷可用度', labelEn: 'Satellite & payload availability', unit: '%' },
  { key: 'groundAvail', label: '基带/骨干网可用度', labelEn: 'Baseband / backbone availability', unit: '%', gate: 'groundOn' },
  { key: 'pktBytes', label: 'IP 包长', labelEn: 'IP packet length', unit: 'B' },
  { key: 'ferExp', label: '帧差错率 10⁻ⁿ', labelEn: 'Frame error ratio 10⁻ⁿ', unit: 'n' },
  { key: 'jitterMs', label: '时延抖动', labelEn: 'Delay jitter', unit: 'ms' },
  { key: 'procMsPerEnd', label: '处理时延预留', labelEn: 'Processing delay allowance', unit: 'ms/单程', unitEn: 'ms/one-way' },
  { key: 'eirpTolDb', label: 'EIRP 容差', labelEn: 'EIRP tolerance', unit: 'dB' },
  { key: 'xpdMinDb', label: '极化隔离度', labelEn: 'Polarisation isolation', unit: 'dB' },
  // 考核周期不是数值参数，值走 enumOf 出字（报告里印「年」/「最坏月」而不是 0 / 1）
  { key: 'monthly', label: '考核周期', labelEn: 'Assessment period', unit: '', enumOf: [['年平均', 'Annual mean'], ['最坏月', 'Worst month']] },
  // 同站回环：勾了才印（gate 指向自身），没勾时报告里不该出现一个没参与的开关
  { key: 'loopback', label: '同站回环', labelEn: 'Same-site loopback', unit: '', gate: 'loopback', enumOf: [['否', 'No'], ['是', 'Yes']] }
]
/** 报告 §4 末尾那一行 SLA 参数表（纯数据，标签已按 lang 翻好） */
export function slaParamRows(params, lang) {
  const sp = normSlaParams(params)
  const en = lang === 'en'
  // 没勾「基带/骨干网」就不列那一格：报告里印一个没参与连乘的数会被当成计入了
  return SLA_PARAM_LABELS.filter((d) => !d.gate || num(sp[d.gate])).map((d) => ({
    label: en ? d.labelEn : d.label,
    value: d.enumOf ? (d.enumOf[num(sp[d.key]) ? 1 : 0][en ? 1 : 0]) : String(sp[d.key]),
    unit: en ? (d.unitEn || d.unit) : d.unit
  }))
}

/**
 * 可用度构成表（报告 §5「参数与假设」）：本体制计入哪几项、各几次、各取多少。
 * 与 equipSlots 同一份声明 —— 报告里印的构成必须就是连乘时用的那一份。
 * @param o { orbitType, regenMode, slaParams, esCount, satCount }
 */
export function slaComposition(o, lang) {
  const sp = normSlaParams(o && o.slaParams)
  const en = lang === 'en'
  const byKey = Object.fromEntries(SLA_PARAM_LABELS.map((d) => [d.key, d]))
  const on = !!num(sp.groundOn)
  return equipSlots(o)
    .filter((s) => !(s.key === 'groundAvail' && !on))
    .map((s) => {
      const d = byKey[s.key] || {}
      return { key: s.key, label: (en ? d.labelEn : d.label) || s.key, count: s.count, value: String(sp[s.key]) + ' %' }
    })
}

/** 场景存档里的 SLA 参数规整（旧场景缺省补齐） */
export function normSlaParams(v) {
  const out = Object.assign({}, DEFAULT_SLA_PARAMS)
  if (v && typeof v === 'object') {
    for (const k of Object.keys(DEFAULT_SLA_PARAMS)) {
      const n = num(v[k])
      if (n !== null) out[k] = n
    }
  }
  return out
}

/** 行级 SLA 规整（只留合法结构；深拷贝，避免两行共用同一个对象） */
export function normRowSla(v) {
  const out = {}
  if (v && typeof v === 'object') {
    if (v.adopt && typeof v.adopt === 'object') {
      const a = {}
      for (const k of Object.keys(v.adopt)) { const s = v.adopt[k]; if (s !== undefined && s !== null && String(s).trim() !== '') a[k] = String(s) }
      if (Object.keys(a).length) out.adopt = a
    }
    if (v.include && typeof v.include === 'object') {
      const inc = {}
      for (const k of Object.keys(v.include)) if (v.include[k] === false) inc[k] = false
      if (Object.keys(inc).length) out.include = inc
    }
  }
  return out
}

/**
 * 把规整后的 SLA 写回链路行：空对象一律删键。
 * 不留空壳是硬要求 —— serializeState 把「非 _ 键」全存，留个 sla:{} 会让所有存量场景的指纹
 * 变一次（打开即亮「未保存」灯），也会让分享包多出一堆无意义的空对象。
 */
export function applyRowSla(row, sla) {
  if (!row) return
  const s = normRowSla(sla)
  if (Object.keys(s).length) row.sla = s
  else if (row.sla !== undefined) delete row.sla
}

/** 节头动作「全部入报告 / 全不入」：返回新的 row.sla（不改入参） */
export function setAllInclude(rowSla, derived, on) {
  const out = normRowSla(rowSla)
  if (on) delete out.include
  else out.include = Object.fromEntries(((derived && derived.order) || []).map((k) => [k, false]))
  return out
}

/** 节头动作「清除采用值」：返回新的 row.sla（勾选保留） */
export function clearAdopt(rowSla) {
  const out = normRowSla(rowSla)
  delete out.adopt
  return out
}

/** 采用值写入：留空即删键（＝采用建议值） */
export function setAdopt(rowSla, key, value) {
  const out = normRowSla(rowSla)
  const s = (value === undefined || value === null) ? '' : String(value).trim()
  if (!s) { if (out.adopt) delete out.adopt[key]; if (out.adopt && !Object.keys(out.adopt).length) delete out.adopt }
  else { out.adopt = Object.assign({}, out.adopt); out.adopt[key] = s }
  return out
}

/** 入报告勾选写入：true 即删键（缺键 = 入报告） */
export function setInclude(rowSla, key, on) {
  const out = normRowSla(rowSla)
  if (on) { if (out.include) delete out.include[key]; if (out.include && !Object.keys(out.include).length) delete out.include }
  else { out.include = Object.assign({}, out.include); out.include[key] = false }
  return out
}

/** 有多少条款会进报告（导出对话框的开关据此置灰） */
export function slaIncludeCount(derived, rowSla) {
  const d = derived || { items: {}, order: [] }
  let n = 0
  for (const k of d.order) if (includeOf(rowSla, k)) n++
  return n
}
