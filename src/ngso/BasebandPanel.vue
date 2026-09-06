<script setup>
import { computed, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import { checkNtnBandwidth } from '../shared/ntnLimits.js'
import { modFactorOf, parseFrac, rateChain, rateDisplays, infoRateFrom, anchorOf } from '../shared/carrierRate.js'
// 3GPP NTN：载波按物理层参数描述（PRB 数 / 子载波间隔 / MCS / 重复），占用带宽与信息速率由此算
import { normalizePhy, occupiedBwKHz, channelBwKHz, infoRateKbps, tbsOf, nrBwSteps, NTN_BANDS, nbSingleToneMcs, nbMaxSfIdx, NB_SF_COUNT, resolve as resolvePhy } from '../shared/ntnPhy.js'

// 载波信号参数面板 —— 严格照搬小程序载波信号卡片：DVB/MODCOD 快选、Eb/N₀⇄Es/N₀ 切换（带换算）、
// 频谱效率⇄帧效率切换、速率换算链（信息速率/码片速率/符号率/载波带宽，编辑任一个反算其余）。
const props = defineProps({
  form: { type: Object, required: true },   // 共享载波信号参数（含 noiseRatioMode / rsCodeMode / dvbStandard / modcodIndex）
  options: { type: Object, default: () => ({}) },
  // 本窗支持的计算方式 [{ key, label }]（各窗按自身引擎能力给：弯管四种、再生式两种）；空数组＝不出该栏
  calcModes: { type: Array, default: () => [] },
  // 速率锁定（端到端窗口的下游段用）：这一段的信息速率由链首那份定、全程守恒，此处只读；
  // 四个速率视角照常按当前 MODCOD 实时算出来给读数，只是不接受编辑、也不参与锚点。
  rateLocked: { type: Boolean, default: false }
})

// 调制因子/分数解析/换算链都在 shared/carrierRate.js（面板与资源库自动命名共用一份口径）
const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n }

const modFactor = computed(() => modFactorOf(props.form.modulation) || 2)
const fecV = computed(() => parseFrac(props.form.fec, 0.75))
const rsV = computed(() => parseFrac(props.form.rsCode, 188 / 204))
const mV = computed(() => num(props.form.m, 1))
const bwV = computed(() => num(props.form.bandwidthFactor, 1.2))
// 组合效率 k = fec·rsCode·调制因子 / 扩频增益（Es/N₀ = Eb/N₀ + 10·lg k）
const kComb = computed(() => (fecV.value * rsV.value * modFactor.value) / mV.value)
// 频谱效率 η = 调制因子·fec·rsCode / (滚降·扩频)
const spectralEff = computed(() => modFactor.value * fecV.value * rsV.value / (bwV.value * mV.value))

// 调制方式下拉：内置那批 + 【当前这份配置正用着的那个】。
// MODCOD 表如今可以按「制式族 + 星座阶数 M」现造出内置表里没有的档（如 1024QAM），套用它之后
// 若下拉里没有这一项，select 会显示成空白 —— 值还在、算得也对，但看上去像没选调制方式。
const modOptions = computed(() => {
  const base = props.options.modulation || [{ value: 'QPSK', label: 'QPSK' }]
  const cur = props.form.modulation
  if (!cur || base.some((o) => o.value === cur)) return base
  return modFactorOf(cur) != null ? base.concat([{ value: cur, label: cur }]) : base
})
const dvbStandards = computed(() => props.options.dvbStandards || [{ value: 'custom', label: '自定义' }])
// 标准下拉按体制分组（DVB / 3GPP NR-NTN / 3GPP NB-IoT NTN / 自建）：12 个标准平铺成一串时，
// 「NPDSCH」「PUSCH 变换预编码表 1」这些名字看不出各属哪个体制 —— NR 是 38.xxx 家族、
// NB-IoT 是 36.xxx 家族，分组是这里唯一能把这件事说清楚的地方。
// 没有分组的（恒在最前的「自定义」）不进 optgroup，直接平铺。
const stdGroups = computed(() => {
  const out = [], seen = new Map()
  for (const o of dvbStandards.value) {
    const g = o.group || ''
    if (!seen.has(g)) { const it = { group: g, items: [] }; seen.set(g, it); out.push(it) }
    seen.get(g).items.push(o)
  }
  return out
})
// 组内不重复报组名：'3GPP NR-NTN · MCS 表 1（64QAM）' 在 NR 组里显示成 'MCS 表 1（64QAM）'。
// 完整名留给拿不到组名的那三处（MODCOD 编辑页页签 / Excel 表名 / 报表），见 constants.js 的说明。
const shortStd = (o) => (o.group && o.label.indexOf(o.group + ' · ') === 0 ? o.label.slice(o.group.length + 3) : o.label)
const modcodList = computed(() => (props.options.modcod && props.options.modcod[props.form.dvbStandard]) || [])

// —— 门限 Eb/N₀ ⇄ Es/N₀（带数值换算）——
function toggleEbno() {
  const cur = parseFloat(props.form.ebno)
  const newMode = props.form.noiseRatioMode === 'ebno' ? 'esno' : 'ebno'
  if (!isNaN(cur) && props.form.modulation) {
    const conv = newMode === 'esno' ? cur + 10 * Math.log10(kComb.value) : cur - 10 * Math.log10(kComb.value)
    props.form.ebno = String(parseFloat(conv.toFixed(4)))
  }
  props.form.noiseRatioMode = newMode
}

// —— 频谱效率 ⇄ 帧效率 ——
// 这一格里真正的存储字段只有帧效率 rsCode；频谱效率是它的一个视角（η = 调制因子·fec·rs /(滚降·扩频)），
// 用户编辑 η 即反解回 rsCode。两件事：
//   ① 反解不能跟着每一次按键做。η 的显示值是定长 toFixed(4)，边打边反解、边把算回来的值写回输入框，
//      「1.38」在打完「1」的一瞬就被回写成「1.0000」，后面的「.38」全被吞掉（实测落到 1.0001），
//      码片速率/符号率/载波带宽整条链跟着算错。故输入期间只记原文，失焦或回车（change）才提交。
//   ② η 不设上限。理论上帧效率 ≤ 1，于是 η ≤ η_max = 调制因子·fec /(滚降·扩频)（rs = 1，无外码开销）；
//      但「不想逐项去配调制/FEC/外码，直接把总的频谱效率填进来」是常用的省事口径，此时反解出的
//      rs > 1 只是个等效开销因子。故越过 η_max 只灰字提醒（并点明报告照此输出），不夹紧、不阻断。
const rsEditing = ref(null)     // 频谱效率模式下正在输入的原文；null = 不在编辑
const spectralEffMax = computed(() => modFactor.value * fecV.value / (bwV.value * mV.value))
// 人读文案：滚降系数或扩频增益填 0 时 η 与上限都发散，不印 Infinity
const qty = (v) => (isFinite(v) ? v.toFixed(4) + ' bps/Hz' : '无解（滚降系数或扩频增益为 0）')
const capText = computed(() => qty(spectralEffMax.value))

function toggleRsCode() {
  props.form.rsCodeMode = props.form.rsCodeMode === 'spectral' ? 'fraction' : 'spectral'
  rsEditing.value = null
}
// rsCode 字段显示值：帧效率模式=真实 rsCode 原文（分数照写）；频谱效率模式=编辑中的原文，否则实时 η
const rsCodeDisplay = computed(() => {
  if (props.form.rsCodeMode !== 'spectral') return props.form.rsCode
  if (rsEditing.value != null) return rsEditing.value
  return isFinite(spectralEff.value) ? spectralEff.value.toFixed(4) : ''
})
function onRsInput(e) {
  if (props.form.rsCodeMode === 'spectral') rsEditing.value = e.target.value
  else props.form.rsCode = e.target.value   // 帧效率是文本字段（'188/204'），实时写入不经格式化，不会被吞
}
function onRsChange(e) {
  if (props.form.rsCodeMode !== 'spectral') return
  const se = parseFloat(e.target.value)
  rsEditing.value = null
  if (!isFinite(se) || se <= 0 || !modFactor.value || !fecV.value) return  // 非法输入：丢弃，显示回落到实时 η
  props.form.rsCode = String(parseFloat((se * bwV.value * mV.value / (modFactor.value * fecV.value)).toFixed(6)))
}
// 提示行：值无效才拦（红字），越过理论上限只说明（灰字）。
// 覆盖三条来路：频谱效率模式下的直接指定、帧效率模式下的手输、历史配置里已经存下的值
const rsAlert = computed(() => {
  const rs = rsV.value
  if (!isFinite(rs) || rs <= 0) return { level: 'over', text: '帧效率须为正数，当前值无效——带宽与容量结果不可用' }
  if (rs > 1) {
    const rsTxt = parseFloat(rs.toFixed(6))
    return {
      level: 'note',
      // 措辞跟着当前口径走：在频谱效率格里填的，说频谱效率；在帧效率格里填的，说帧效率
      text: props.form.rsCodeMode === 'spectral'
        ? `已按直接指定的频谱效率计算：${qty(spectralEff.value)} 超过当前调制/FEC/滚降的理论上限 ${capText.value}，等效帧效率 ${rsTxt} > 1，报告照此输出`
        : `帧效率 ${rsTxt} > 1 超出理论上限（等效频谱效率 ${qty(spectralEff.value)}），按此口径计算并输出`
    }
  }
  return null
})

// —— DVB / MODCOD ——
// MODCOD 表如今是用户可编辑的库（文件管理 · MODCOD 表：可增删条目、可新建整个标准），下标不再稳定：
// 光存 modcodIndex 的话，用户在表里插一行，所有旧配置的下拉就整体指到隔壁那条去了。故【同时记名字】，
// 回显以名字为准、老配置（没有名字）退回下标；名字在表里找不到（被删/改名）就回到「请选择」。
// 注意这只影响下拉的回显：选中那一刻七个值已整套落进表单各字段，算出来的数与本变更无关。
const modcodSel = computed(() => {
  const list = modcodList.value
  const nm = props.form.modcodLabel
  const i = parseInt(props.form.modcodIndex)
  const byIdx = (i >= 0 && i < list.length) ? i : -1
  if (!nm) return rowAgrees(list[byIdx]) ? byIdx : -1
  const hit = list.findIndex((m) => m.label === nm)
  if (hit >= 0) return hit
  // ★ 名字对不上时退回行号（内置表改过名的行，如 NB-IoT 三张表把假分数从标签里拿掉），但行号只在
  //   那一行与表单里实际生效的参数【对得上】时才认：内置表并不是只增不改序（NB-IoT NTN 表 8 行 → 14 行），
  //   盲信行号会让下拉显示成另一档，而计算用的仍是表单里的旧值。三项都对不上就回「请选择」。
  return rowAgrees(list[byIdx]) ? byIdx : -1
})
// MODCOD 表的一行与表单里此刻生效的参数是不是同一档：调制 / 码率 / 门限三项（门限按 0.005 dB 容差）
function rowAgrees(mc) {
  if (!mc) return false
  const same = (a, b) => String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim()
  const thr = Number(mc.threshold), fthr = Number(props.form.ebno)
  return same(mc.modulation, props.form.modulation) && same(mc.fec, props.form.fec)
    && Number.isFinite(thr) && Number.isFinite(fthr) && Math.abs(thr - fthr) < 0.006
}
function onDvbChange(e) {
  props.form.dvbStandard = e.target.value
  props.form.modcodIndex = -1
  props.form.modcodLabel = ''
  // 3GPP 体制：把该标准的物理层骨架铺上（下行 5 MHz@15 kHz 整载波 / 上行 1 PRB 一类的缺省）。
  // ★ 门限口径此刻【不动】——按 §5.5 的迁移口径，老配置只在用户重新选一次 MODCOD 时才切到 snr，
  //   而引擎只在 noiseRatioMode === 'snr' 时才看 phy，故这里铺上也不会改变任何已有算法。
  const def = (props.options.phy || {})[e.target.value]
  props.form.phy = def ? { ...def } : null
}
function applyModcod(e) {
  const i = parseInt(e.target.value)
  const mc = modcodList.value[i]; if (!mc) return
  props.form.modcodIndex = i
  props.form.modcodLabel = mc.label
  props.form.modulation = mc.modulation
  props.form.fec = mc.fec
  props.form.rsCode = mc.rsCode
  props.form.bandwidthFactor = String(mc.bandwidthFactor)
  props.form.ebno = Number(mc.threshold).toFixed(2)
  props.form.noiseRatioMode = mc.noiseRatioMode
  rsEditing.value = null   // MODCOD 整套覆写了 rsCode，编辑中的原文作废
  // 3GPP 行：把该行的体制内索引写进 phy（NR 的 MCS 序号 / NB-IoT 的 I_TBS 或单音 I_MCS）。
  // ★ idx 是 MODCOD 表里的一列，不再从 label 里拿正则抠。
  if (mc.noiseRatioMode === 'snr') {
    const base = (props.form.phy && typeof props.form.phy === 'object')
      ? props.form.phy : ((props.options.phy || {})[props.form.dvbStandard] || null)
    if (base) {
      const p = { ...base }
      // 标准属性（不是用户偏好）在这里对齐到本版内置表：st 决定这张表的行号是 I_MCS 还是 I_TBS、
      // 子载波数锁不锁死。★ 只在用户重新选一次 MODCOD 时切换，不静默改已存行 —— 与门限同一个口径。
      const std = (props.options.phy || {})[props.form.dvbStandard] || null
      if (std && std.st !== undefined) p.st = std.st
      if (mc.idx != null) {
        if (p.kind === 'nbiot') {
          // 单音表的行号是 I_MCS，要经 TS 36.213 Table 16.5.1.2-1 映射成 I_TBS（1↔2 是反的）。
          // ★ 判据是【这张表是不是单音表】（st），不是「当前填了几个子载波」——后者在用户改过
          //   子载波数之后会把整条映射错位（I_MCS 1 本该是 I_TBS 2，直读成 I_TBS 1）。
          //   自建标准没有 st，行号口径只有填表的人知道，仍按当前子载波数判。
          const single = p.st === true || (p.st == null && p.nTones === 1)
          const st = single ? nbSingleToneMcs(mc.idx) : null
          p.iTbs = st ? st.iTbs : mc.idx
          // 换档后原来的子帧数 / RU 数可能越过这一行的上限（Cat-NB1 的 TBS 封顶，I_TBS 越高行越短），
          // 就地钳到最大合法档 —— 留着越界值，配出来的是标准表里根本没有的组合，引擎当场报错。
          const mx = nbMaxSfIdx(p)
          const sfKey = p.dir === 'ul' ? 'iRu' : 'iSf'
          if (mx >= 0 && p[sfKey] > mx) p[sfKey] = mx
        } else {
          p.mcs = mc.idx
          // 变换预编码表的 q 档拆成两行，靠调制方式认回是哪一行（π/2-BPSK 记作 BPSK）
          if (p.mcsTable === 'tp1' || p.mcsTable === 'tp2') p.q = mc.modulation === 'BPSK' ? 1 : 2
        }
      }
      props.form.phy = p
    }
  }
}

/* ===================== 3GPP NTN 物理层参数 ===================== */
// phy 非空且门限口径是 snr 时，这条载波【不走 DVB 换算链】：帧效率 / 滚降 / 扩频 / 码片率 / 符号率
// 五项对它都没有意义（3GPP 没有外码与滚降滤波器，OFDM 的符号率也不是噪声带宽）。改由
// PRB 数 × 12 × 子载波间隔定占用带宽，由 MCS 的 TBS 定信息速率 —— 口径与出处见 shared/ntnPhy.js。
const phy = computed(() => (props.form.noiseRatioMode === 'snr' ? normalizePhy(props.form.phy) : null))
const phyOn = computed(() => !!phy.value)
const phyIsNr = computed(() => !!phy.value && phy.value.kind === 'nr')
// 当前 I_TBS 行允许的最大子帧数 / RU 数下标，越过它的档在下拉里灰掉。
// −1 = 这一行压根不在标准表里（I_TBS>12 的 Rel-14 扩展），此时不灰任何档，交给下面那行报错说明。
const nbSfMax = computed(() => (phy.value && phy.value.kind === 'nbiot' ? nbMaxSfIdx(phy.value) : -1))
const phyMeta = computed(() => (props.options.meta || {})[props.form.dvbStandard] || null)
// 写回：phy 是整体替换而不是就地改字段——配置里存的可能是从存档读出来的普通对象，
// 就地改属性在部分路径上不触发依赖收集，读数不跟着动。
function setPhy(patch) {
  const cur = (props.form.phy && typeof props.form.phy === 'object') ? props.form.phy : {}
  props.form.phy = { ...cur, ...patch }
}
const numAttr = (e, d) => { const n = Number(e.target.value); return isFinite(n) ? n : d }
// 变换预编码表只用于 PUSCH（TS 38.214 §6.1.4.1）：选了它，方向就不再是用户能改的东西
const phyDirLocked = computed(() => !!phy.value && phy.value.kind === 'nr' &&
  (phy.value.mcsTable === 'tp1' || phy.value.mcsTable === 'tp2'))
// NB-IoT 子载波数与子载波间隔的可选项：单音表恒 1；多音表 3/6/12 且没有 3.75 kHz；自建表不锁
const nbToneOptions = computed(() => {
  const p = phy.value
  if (!p || p.kind !== 'nbiot') return []
  return p.st === true ? [1] : (p.st === false ? [3, 6, 12] : [1, 3, 6, 12])
})
const nbScsOptions = computed(() => {
  const p = phy.value
  return (p && p.kind === 'nbiot' && p.st === false) ? [15] : [15, 3.75]
})
// 换方向 = 换分配对象：下行一条载波就是整个 NR 载波，上行是一个终端本次的分配。原样留着
// 25 PRB / 5 MHz 切到上行，等于把一个终端的分配报成整载波（转发器占用比虚高 27 倍）。
function onDir(e) {
  const dir = e.target.value === 'ul' ? 'ul' : 'dl'
  const p = phy.value
  if (!p || p.kind !== 'nr' || p.dir === dir) { setPhy({ dir }); return }
  if (dir === 'ul') { setPhy({ dir, chBwMHz: null, nRb: 1, nSymb: 14 }); return }
  // ★ 缺省档跳过「本版可选」的档（optional：Rel-19 新加的 3 MHz 之类）—— 挑到一个可选的档等于替用户做了
  //   一个部署决定，与 ntnPhy 里信道带宽反查的口径一致
  const steps = nrBwSteps({ ...p, dir })
  const first = steps.find((s) => !s.optional) || steps[0] || null
  setPhy(first ? { dir, chBwMHz: first.mhz, nRb: first.nRb, nSymb: 12 } : { dir, nSymb: 12 })
}
// 该【频段 + 子载波间隔】下有哪些信道带宽档（TS 38.101-5 Table 5.3.5-1/-2）。
// ★ 不能只看 N_RB 表（5.3.2-1）：那张表只说「这个带宽在这个 SCS 下是多少 PRB」，哪个频段允许
//   哪几档是另一张表。只看前者，5 MHz@30 kHz、n254 的 20 MHz、任何频段的 30 MHz 都配得出来。
//   上行把「只用于下行」的档滤掉。
const chBwSteps = computed(() => {
  const p = phy.value
  if (!p || p.kind !== 'nr') return []
  return nrBwSteps(p).filter((s) => !(s.dlOnly && p.dir === 'ul'))
})
const chBwOptions = computed(() => chBwSteps.value.map((s) => s.mhz))
// 频段下拉：按 FR 分两组，顺序照 NTN_BANDS 的书写序（与 TS 38.101-5 的表序一致）
const bandOptions = computed(() => Object.keys(NTN_BANDS).map((k) => ({
  value: k, fr: NTN_BANDS[k].fr,
  label: k + '（' + (NTN_BANDS[k].fr === 1 ? 'FR1' : 'FR2') + '）'
})))
// 换频段：原来那一档信道带宽在新频段可能根本没有（n256 的 20 MHz 到 n254 就没了），
// 就地落到新频段的最小档 —— 留着不动配出来的是标准里没有的载波，当场红字。
function onBand(e) {
  const band = e.target.value
  const p = phy.value
  if (!p) { setPhy({ band }); return }
  const next = nrBwSteps({ ...p, band }).filter((s) => !(s.dlOnly && p.dir === 'ul'))
  if (p.chBwMHz == null) { setPhy({ band }); return }
  const keep = next.find((s) => s.mhz === p.chBwMHz)
  const pick = keep || next.find((s) => !s.optional) || next[0] || null
  setPhy(pick ? { band, chBwMHz: pick.mhz, nRb: pick.nRb } : { band })
}
// 下行按「信道带宽 + 子载波间隔」查表自动填 PRB 数；上行是一个 UE 的分配，PRB 数直填
function onScs(e) {
  const scs = numAttr(e, 15)
  const p = phy.value
  const patch = { scs }
  if (p && p.chBwMHz != null) {
    // 换子载波间隔 = 换一张档位表：同一个 10 MHz 在 15/30/60 kHz 下的 PRB 数不同，且未必都有这一档
    const next = nrBwSteps({ ...p, scs }).filter((s) => !(s.dlOnly && p.dir === 'ul'))
    const pick = next.find((s) => s.mhz === p.chBwMHz) || next.find((s) => !s.optional) || next[0] || null
    if (pick) { patch.chBwMHz = pick.mhz; patch.nRb = pick.nRb }
  }
  setPhy(patch)
}
function onChBw(e) {
  const v = e.target.value
  if (v === '') { setPhy({ chBwMHz: null }); return }
  const mhz = Number(v)
  const hit = chBwSteps.value.find((s) => s.mhz === mhz)
  setPhy({ chBwMHz: mhz, nRb: hit ? hit.nRb : (phy.value ? phy.value.nRb : 25) })
}
// 只读读数：占用带宽 / 信道带宽 / 信息速率 / TBS / 频谱效率（按占用带宽，即门限换 Eb/N₀ 用的那个 k）
const phyOut = computed(() => {
  const p = phy.value
  if (!p) return null
  const rv = resolvePhy(props.form.phy, modFactor.value, fecV.value)
  const bOcc = occupiedBwKHz(p), bCh = channelBwKHz(p)
  const rate = infoRateKbps(p, modFactor.value, fecV.value)
  return {
    bOcc, bCh, rate, tbs: tbsOf(p, modFactor.value, fecV.value),
    // ★ 与引擎出参 spectralEfficiencyResult 同口径（按信道带宽）。曾按占用带宽算，于是面板与
    //   详细计算结果同名两个数（NB-IoT 下行 0.311 vs 0.280），工程师无从判断该信哪个。
    se: (rate != null && bCh > 0) ? rate / bCh : null,
    error: (rv && rv.error) || ''
  }
})
const fmtRo = (v) => (v == null || !isFinite(v) ? '' : String(Math.round(v * 1000) / 1000))
// 信息速率是全平台的存储字段（资源库自动命名、链路表、报表都读它）：phy 行由物理层参数算出来，
// 这里同步写回，免得「面板上写着 928 kbps、链路表里还是上一次的 2048」。
watch([phyOut], () => {
  const o = phyOut.value
  if (!o || o.rate == null) return
  const v = String(Math.round(o.rate * 1000) / 1000)
  if (props.form.infoRate !== v) props.form.infoRate = v
}, { immediate: true })
// 门限那格的悬停口径：把「按什么算的、在什么条件下成立」全说清楚，版面上一个字不写
const thrTip = computed(() => {
  if (!phyOn.value) return ''
  const p = phy.value, o = phyOut.value, m = phyMeta.value
  const bw = p.kind === 'nr'
    ? `${p.nRb} PRB × 12 × ${p.scs} kHz = ${fmtRo(o && o.bOcc)} kHz`
    : `${p.nTones} 子载波 × ${p.scs} kHz = ${fmtRo(o && o.bOcc)} kHz`
  const rep = p.nRep > 1 ? `；重复 ×${p.nRep} 后有效门限 ${(Number(props.form.ebno) - 10 * Math.log10(p.nRep) + p.combLossDb).toFixed(2)} dB` : ''
  const cond = m ? `；表值条件：BLER ${(m.bler * 100).toFixed(0)}%、${m.channel}、码块 ${m.block}、N_rep ${m.rep}；来源 ${m.source}` : ''
  const small = p.kind === 'nr' && p.nRb <= 2 ? '；小分配（码块 ≤ 500 bit）实测约再高 0.3~2.2 dB，本表未自动折算' : ''
  return `每资源元素 SNR ≡ 占用带宽内的 C/N，噪声带宽 = ${bw}${rep}${cond}${small}`
})

// —— 速率换算链：信息速率 / 码片速率 / 符号率 / 载波带宽（四者并列，编辑任一个反算其余）——
// 换算链与引擎 linkCalculator.js 完全一致：
// infoRate → carrierRate(÷fec÷rs) → chipRate(×m，码片速率) → symbolRate(÷调制因子) → carrierBW(×滚降)
const chain = computed(() => rateChain(props.form))
const carrierBW = computed(() => chain.value.bw)          // NTN 带宽合规提示按真实链算，不取显示值
const disp = computed(() => rateDisplays(props.form))     // 三个派生框的显示值（锚点那项照用户原值）

// 信息速率是唯一真实存储字段，码片速率/符号率/载波带宽都是按当前调制/FEC/扩频/滚降反推的视角。
// 问题：若只在编辑那一刻反算一次 infoRate，后续再改调制方式等参数，infoRate 不变但乘数变了，
// 三个派生量会一起跟着漂移——包括用户刚刚手动定下来的那个值，体验上像是“白改了”。
// 改法：记下用户最近编辑的是哪一个字段（锚点）和它当时的目标值；调制/FEC/扩频/滚降任何一个变化时，
// 都按锚点的目标值反解 infoRate，使锚点字段保持不变，其余字段顺着联动——而不是死守 infoRate 不变。
// 锚点与其目标值随配置入库（form.rateAnchor / rateAnchorValue，不再是面板局部态）：切走再回来、
// 重开软件，用户按的还是自己那个口径；条目自动命名也据此报（改带宽就报带宽，见 lbAutoName）。
const rateAnchor = computed(() => anchorOf(props.form))
function setAnchor(which, raw) {
  const v = parseFloat(raw); if (isNaN(v)) return
  props.form.rateAnchor = which
  props.form.rateAnchorValue = v
  const ir = infoRateFrom(props.form, which, v)
  if (ir != null && !isNaN(ir)) props.form.infoRate = String(Math.round(ir * 1000) / 1000)
}
watch([modFactor, fecV, rsV, mV, bwV], () => {
  if (phyOn.value) return          // phy 行的速率由物理层参数定，不参与锚点反解
  const anch = rateAnchor.value
  const av = props.form.rateAnchorValue
  if (anch === 'info' || av == null || av === '') return
  const ir = infoRateFrom(props.form, anch, parseFloat(av))
  if (ir != null && !isNaN(ir)) props.form.infoRate = String(Math.round(ir * 1000) / 1000)
})
// —— 3GPP NTN 载波带宽合规提示 ——
// 选了 3GPP 体制（NB-IoT NTN / NR-NTN）时，标准把「信道带宽」枚举死了几档：超出上限红字告警，
// 未超则灰字说明当前载波需占用哪一档信道带宽。DVB 各体制不判（其带宽按转发器切片自由定）。
// 限值与出处见 shared/ntnLimits.js。
// ★ snr 口径的行恒不出这条提示：它的信道带宽本来就是从档位表查出来的，判不出「超限」这件事。
const ntnBw = computed(() => checkNtnBandwidth(props.form.dvbStandard, carrierBW.value, props.form.noiseRatioMode))

// 用户直接改信息速率：信息速率重新成为锚点（它自己就是存储字段，无需另记目标值）
function onInfoInput() { props.form.rateAnchor = 'info'; props.form.rateAnchorValue = null }
function onChipInput(e) { setAnchor('chip', e.target.value) }
function onSymbolInput(e) { setAnchor('symbol', e.target.value) }
function onBwInput(e) { setAnchor('bw', e.target.value) }
</script>

<template>
  <div class="bb">
    <!-- MODCOD 快速选择 -->
    <div class="bb-modcod">
      <label class="bb-f"><span class="bb-l">标准</span>
        <select :value="form.dvbStandard" class="bb-i" @change="onDvbChange">
          <template v-for="g in stdGroups" :key="g.group || '#none'">
            <optgroup v-if="g.group" :label="g.group">
              <option v-for="o in g.items" :key="o.value" :value="o.value">{{ shortStd(o) }}</option>
            </optgroup>
            <template v-else>
              <option v-for="o in g.items" :key="o.value" :value="o.value">{{ o.label }}</option>
            </template>
          </template>
        </select>
      </label>
      <label v-if="form.dvbStandard !== 'custom'" class="bb-f bb-wide"><span class="bb-l">MODCOD</span>
        <select :value="modcodSel" class="bb-i" @change="applyModcod">
          <option :value="-1" disabled>请选择</option>
          <option v-for="(mc, i) in modcodList" :key="i" :value="i">{{ mc.label }}</option>
        </select>
      </label>
    </div>

    <!-- 调制编码与门限（速率不在此处，见下方换算链）——
         两列排布时左右自然成对：调制⇄FEC、门限⇄误码率、滚降⇄帧效率 -->
    <div class="bb-grid">
      <label class="bb-f"><span class="bb-l">调制方式</span>
        <select v-model="form.modulation" class="bb-i">
          <option v-for="o in modOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>
      <label class="bb-f"><span class="bb-l">FEC 码率</span>
        <input v-model="form.fec" class="bb-i mono" placeholder="3/4" />
      </label>
      <!-- 带口径钮的行用 div 而非 label：label 会把行内任意位置的点击转发给它的第一个可关联控件，
           而那正是这枚 button（button 也是 labelable）——点标签文字、单位括注甚至行内空白都会误切口径。 -->
      <div class="bb-f bb-f-tg"><span class="bb-l">
          <span v-if="phyOn" class="bb-tg bb-tg-fix">SNR</span>
          <button v-else type="button" class="bb-tg" :title="`当前 ${form.noiseRatioMode === 'ebno' ? 'Eb/N₀' : 'Es/N₀'} 口径，点击换算为 ${form.noiseRatioMode === 'ebno' ? 'Es/N₀' : 'Eb/N₀'}（门限值同步换算）`"
                  @click.prevent="toggleEbno">{{ form.noiseRatioMode === 'ebno' ? 'Eb/N₀' : 'Es/N₀' }}<Icon name="arrow-left-right" :size="12" /></button><i>(dB)</i>
        </span>
        <input v-model="form.ebno" class="bb-i mono" :title="thrTip" placeholder="5.50" />
      </div>
      <label class="bb-f"><span class="bb-l">误码率 <i>(1×10⁻ⁿ)</i></span>
        <input v-model="form.ber" class="bb-i mono" placeholder="7" />
      </label>
      <label v-if="!phyOn" class="bb-f"><span class="bb-l">滚降系数 <i>(1+α)</i></span>
        <input v-model="form.bandwidthFactor" class="bb-i mono" placeholder="1.20" />
      </label>
      <div v-if="!phyOn" class="bb-f bb-f-tg"><span class="bb-l">
          <button type="button" class="bb-tg" :title="`当前按${form.rsCodeMode === 'spectral' ? '频谱效率' : '帧效率'}填，点击切换为${form.rsCodeMode === 'spectral' ? '帧效率' : '频谱效率'}`"
                  @click.prevent="toggleRsCode">{{ form.rsCodeMode === 'spectral' ? '频谱效率' : '帧效率' }}<Icon name="arrow-left-right" :size="12" /></button><i v-if="form.rsCodeMode === 'spectral'">(bps/Hz)</i>
        </span>
        <input :value="rsCodeDisplay" class="bb-i mono" :class="{ 'bb-over': rsAlert && rsAlert.level === 'over' }"
               :placeholder="form.rsCodeMode === 'spectral' ? '1.1520' : '188/204'" @input="onRsInput" @change="onRsChange" />
      </div>
      <label v-if="!phyOn" class="bb-f"><span class="bb-l">扩频增益</span>
        <input v-model="form.m" class="bb-i mono" placeholder="1.00" />
      </label>
    </div>

    <!-- 帧效率越界告警 / 频谱效率夹到上限的说明（频谱效率只是帧效率的一个视角，见 script） -->
    <p v-if="rsAlert && !phyOn" class="bb-ntn bb-rs" :class="{ over: rsAlert.level === 'over' }">
      <Icon v-if="rsAlert.level === 'over'" name="alert-triangle" :size="12" />
      <span>{{ rsAlert.text }}</span>
    </p>


    <!-- 3GPP NTN 物理层参数（选了 3GPP 体制、门限按 SNR 时才出）：
         占用带宽 = PRB 数 × 12 × 子载波间隔（NB-IoT 上行 = 子载波数 × 子载波间隔），它就是 SNR 的噪声带宽。
         口径说明一律进 title，版面上不写字（见仓库 CLAUDE.md）。 -->
    <div v-if="phyOn" class="bb-grid bb-phy">
      <label class="bb-f" :title="!phyIsNr ? 'NB-IoT 的方向由信道决定：NPDSCH 只在下行、NPUSCH 只在上行，随所选标准走，不单独改' : (phyDirLocked ? '变换预编码表只用于 PUSCH（TS 38.214 §6.1.4.1），PDSCH 没有这两张表' : '下行 = 一条载波就是整个 NR 载波；上行 = 一个终端本次的分配。NR 的 MCS 表 1/2/3 收发共用。切换方向会按该方向的缺省重铺信道带宽 / PRB 数 / 符号数')"><span class="bb-l">方向</span>
        <select :value="phy.dir" class="bb-i" :disabled="!phyIsNr || phyDirLocked" @change="onDir">
          <option value="dl">下行</option>
          <option value="ul">上行</option>
        </select>
      </label>
      <label v-if="phyIsNr" class="bb-f" title="NTN 频段——它决定该子载波间隔可选的信道带宽档（TS 38.101-5 V19.5.0 Table 5.3.5-1 / 5.3.5-2），也决定按 FR1 还是 FR2 取 N_RB 表与开销系数。留「不指定」＝按该 FR 所有频段的并集放行（老配置的缺省）"><span class="bb-l">NTN 频段</span>
        <select :value="phy.band || ''" class="bb-i" @change="onBand">
          <option value="">不指定</option>
          <option v-for="b in bandOptions" :key="b.value" :value="b.value">{{ b.label }}</option>
        </select>
      </label>
      <label v-if="phyIsNr || phy.dir === 'ul'" class="bb-f" :title="phyIsNr ? '' : 'NPUSCH 的子载波间隔；3.75 kHz 只有单子载波一种配置（TS 36.211 §10.1.2）'"><span class="bb-l">子载波间隔 <i>(kHz)</i></span>
        <select v-if="phyIsNr" :value="String(phy.scs)" class="bb-i" @change="onScs">
          <option v-for="s in [15, 30, 60, 120]" :key="s" :value="String(s)">{{ s }}</option>
        </select>
        <select v-else :value="String(phy.scs)" class="bb-i" :disabled="nbScsOptions.length < 2"
                @change="setPhy({ scs: Number($event.target.value) })">
          <option v-for="s in nbScsOptions" :key="s" :value="String(s)">{{ s }}</option>
        </select>
      </label>
      <label v-if="phyIsNr" class="bb-f" title="该频段在这个子载波间隔下允许的信道带宽档（TS 38.101-5 V19.5.0 Table 5.3.5-1 / 5.3.5-2）；下拉里列的就是全部合法档，选定即查表填 PRB 数。选「按 PRB 数」则直接填 PRB 数"><span class="bb-l">信道带宽 <i>(MHz)</i></span>
        <select :value="phy.chBwMHz == null ? '' : String(phy.chBwMHz)" class="bb-i" @change="onChBw">
          <option value="">按 PRB 数</option>
          <option v-for="b in chBwOptions" :key="b" :value="String(b)">{{ b }}</option>
        </select>
      </label>
      <label v-if="phyIsNr" class="bb-f" title="本次分配的资源块数；占用带宽 = N_RB × 12 × 子载波间隔"><span class="bb-l">PRB 数</span>
        <input :value="phy.nRb" class="bb-i mono" @change="setPhy({ nRb: Number($event.target.value) })" />
      </label>
      <label v-if="!phyIsNr && phy.dir === 'ul'" class="bb-f" :title="phy.st === true ? 'NPUSCH 每资源单元的子载波数 N_sc^RU；单音表锁死 1 个子载波——门限那一列是按单音给的，表里的行号也是 I_MCS（TS 36.213 Table 16.5.1.2-1）。占用带宽 = 子载波数 × 子载波间隔，单子载波 15 kHz 比 12 子载波低 10.8 dB、3.75 kHz 低 16.8 dB' : (phy.st === false ? 'NPUSCH 每资源单元的子载波数 N_sc^RU；多音表只有 3 / 6 / 12——TS 36.213 §16.5.1.2 规定 N_sc^RU > 1 时恒 QPSK，且门限比单音低 1.6~3.8 dB。占用带宽 = 子载波数 × 子载波间隔' : 'NPUSCH 每资源单元的子载波数 N_sc^RU（TS 36.211 §10.1.2 的 single-tone / multi-tone）；自建标准不锁死——表里的行号按 I_MCS 还是 I_TBS 读，随当前子载波数判。占用带宽 = 子载波数 × 子载波间隔')"><span class="bb-l">子载波数</span>
        <select :value="String(phy.nTones)" class="bb-i" :disabled="nbToneOptions.length < 2"
                @change="setPhy({ nTones: Number($event.target.value) })">
          <option v-for="t in nbToneOptions" :key="t" :value="String(t)">{{ t }}</option>
        </select>
      </label>
      <label v-if="!phyIsNr" class="bb-f" title="NB-IoT 载波怎么落在频谱上（TS 36.102 §5.4B）：独立部署走 200 kHz 栅格、保护带落在 LTE 载波的保护带内、带内部署嵌在 LTE 载波里。只影响下行 NPDSCH——带内部署前 3 个符号让给 LTE 控制区并被 CRS 打孔，每传输块编码比特数由 304 掉到 208、I_TBS 只到 10（TS 36.213 §16.4.1.4 / §16.4.1.5.1）。NPUSCH 不受影响"><span class="bb-l">部署模式</span>
        <select :value="phy.opMode || 'standalone'" class="bb-i" @change="setPhy({ opMode: $event.target.value })">
          <option value="standalone">独立</option>
          <option value="guardband">保护带</option>
          <option value="inband">带内</option>
        </select>
      </label>
      <label v-if="!phyIsNr" class="bb-f" :title="phy.dir === 'ul' ? '一个传输块占几个资源单元（TS 36.213 Table 16.5.1.2-2 的 I_RU 列）' : '一个传输块占几个子帧（TS 36.213 Table 16.4.1.5.1-1 的 I_SF 列）'">
        <span class="bb-l">{{ phy.dir === 'ul' ? 'RU 数' : '子帧数' }}</span>
        <select :value="String(phy.dir === 'ul' ? phy.iRu : phy.iSf)" class="bb-i"
                @change="setPhy(phy.dir === 'ul' ? { iRu: Number($event.target.value) } : { iSf: Number($event.target.value) })">
          <option v-for="(n, i) in NB_SF_COUNT" :key="i" :value="String(i)" :disabled="nbSfMax >= 0 && i > nbSfMax">{{ n }}</option>
        </select>
      </label>
      <label class="bb-f" title="重复次数 N_rep：有效门限 = 表值 − 10·lg(N_rep) + 合并损失，信息速率同时除以 N_rep"><span class="bb-l">重复次数</span>
        <input :value="phy.nRep" class="bb-i mono" @change="setPhy({ nRep: Number($event.target.value) })" />
      </label>
      <label class="bb-f" title="非理想信道估计下的合并损失，理想合并为 0；实测通常 0.5~1.5 dB"><span class="bb-l">合并损失 <i>(dB)</i></span>
        <input :value="phy.combLossDb" class="bb-i mono" @change="setPhy({ combLossDb: Number($event.target.value) })" />
      </label>
      <label v-if="phyIsNr" class="bb-f" title="TBS = 按 TS 38.214 §5.1.3.2 算每时隙传输块（厂家口径）；TS 38.306 = §4.1.2 的近似式，含 PDCCH/SSB/CSI-RS 的平均系统开销"><span class="bb-l">速率模型</span>
        <select :value="phy.rateModel" class="bb-i" @change="setPhy({ rateModel: $event.target.value })">
          <option value="tbs">TBS</option>
          <option value="oh38306">TS 38.306</option>
        </select>
      </label>
      <template v-if="phyIsNr && phy.rateModel === 'tbs'">
        <label class="bb-f" title="一个时隙里分给这条载波的 OFDM 符号数（下行留 2 个给 PDCCH 即填 12）"><span class="bb-l">符号数</span>
          <input :value="phy.nSymb" class="bb-i mono" @change="setPhy({ nSymb: Number($event.target.value) })" />
        </label>
        <label class="bb-f" title="每 PRB 被 DMRS 占掉的资源元素数"><span class="bb-l">DMRS <i>(RE/PRB)</i></span>
          <input :value="phy.nDmrs" class="bb-i mono" @change="setPhy({ nDmrs: Number($event.target.value) })" />
        </label>
        <label class="bb-f" title="TS 38.214 的 xOverhead：0 / 6 / 12 / 18"><span class="bb-l">xOverhead</span>
          <input :value="phy.nOh" class="bb-i mono" @change="setPhy({ nOh: Number($event.target.value) })" />
        </label>
      </template>
      <label v-if="phyIsNr && phy.rateModel === 'oh38306'" class="bb-f" title="TS 38.306 的开销系数；留空按方向取缺省（FR1 下行 0.14 / 上行 0.08，FR2 下行 0.18 / 上行 0.10）"><span class="bb-l">开销 OH</span>
        <input :value="phy.oh == null ? '' : phy.oh" class="bb-i mono" placeholder="缺省"
               @change="setPhy({ oh: $event.target.value === '' ? null : Number($event.target.value) })" />
      </label>
      <label v-if="phyIsNr" class="bb-f" title="MIMO 层数 ν"><span class="bb-l">层数</span>
        <input :value="phy.layers" class="bb-i mono" @change="setPhy({ layers: Number($event.target.value) })" />
      </label>
    </div>

    <!-- 物理层读数（只读）：占用带宽就是噪声带宽，频谱效率按占用带宽算（＝门限换 Eb/N₀ 用的那个 k） -->
    <div v-if="phyOn && phyOut" class="bb-rt bb-ro">
      <label class="bb-f" title="B_occ = N_RB × 12 × 子载波间隔（NB-IoT 上行 = 子载波数 × 子载波间隔）——SNR 的噪声带宽"><span class="bb-l">占用带宽 <i>(kHz)</i></span>
        <input :value="fmtRo(phyOut.bOcc)" class="bb-i mono" readonly />
      </label>
      <label class="bb-f" title="含保护带的信道带宽；只用于档位核对与转发器占用比，不当噪声带宽"><span class="bb-l">信道带宽 <i>(kHz)</i></span>
        <input :value="fmtRo(phyOut.bCh)" class="bb-i mono" readonly />
      </label>
      <label class="bb-f" title="由 TBS 与时隙/RU 时长算出，已除以重复次数"><span class="bb-l">信息速率 <i>(kbps)</i></span>
        <input :value="fmtRo(phyOut.rate)" class="bb-i mono" readonly />
      </label>
      <label class="bb-f" :title="phyIsNr ? '每时隙传输块大小（TS 38.214 §5.1.3.2）' : '每传输块大小（TS 36.213）'"><span class="bb-l">TBS <i>(bit)</i></span>
        <input :value="phyOut.tbs == null ? '' : String(phyOut.tbs)" class="bb-i mono" :class="{ 'bb-over': phyOut.tbs == null }" readonly />
      </label>
      <label class="bb-f" title="信息速率 ÷ 信道带宽——与计算结果里的「频谱效率」同口径。门限换 Eb/N₀ 用的是信息速率 ÷ 占用带宽，那是另一个数，由引擎内部算"><span class="bb-l">频谱效率 <i>(bps/Hz)</i></span>
        <input :value="phyOut.se == null ? '' : phyOut.se.toFixed(4)" class="bb-i mono" readonly />
      </label>
    </div>
    <p v-if="phyOut && phyOut.error" class="bb-ntn over">
      <Icon name="alert-triangle" :size="12" />
      <span>{{ phyOut.error }}</span>
    </p>

    <!-- 速率换算链（信息速率 → 码片速率 → 符号率 → 载波带宽）：四者同一条链上的不同视角，编辑任一个
         即把它设为锚点、其余三个跟着算；正常色的那个＝当前锚点，退一档的＝由它算出来的。
         系统余量不在此处：它是批量计算的目标值，不随载波信号配置走，在 LinkBudgetApp 底部「计算方式」栏统一设置 -->
    <div v-if="!phyOn" class="bb-rt">
      <label class="bb-f"><span class="bb-l">信息速率 <i>(kbps)</i></span>
        <input v-model="form.infoRate" class="bb-i mono" :class="{ 'bb-anch': rateAnchor === 'info' && !rateLocked }" :readonly="rateLocked" placeholder="2048" @input="onInfoInput" />
      </label>
      <label class="bb-f"><span class="bb-l">码片速率 <i>(kcps)</i></span>
        <input :value="disp.chip" class="bb-i mono" :class="{ 'bb-anch': rateAnchor === 'chip' && !rateLocked }" :readonly="rateLocked" @change="onChipInput" />
      </label>
      <label class="bb-f"><span class="bb-l">符号率 <i>(ksps)</i></span>
        <input :value="disp.symbol" class="bb-i mono" :class="{ 'bb-anch': rateAnchor === 'symbol' && !rateLocked }" :readonly="rateLocked" @change="onSymbolInput" />
      </label>
      <label class="bb-f"><span class="bb-l">载波带宽 <i>(kHz)</i></span>
        <input :value="disp.bw" class="bb-i mono" :class="{ 'bb-anch': rateAnchor === 'bw' && !rateLocked, 'bb-over': ntnBw && ntnBw.level === 'over' }" :readonly="rateLocked" @change="onBwInput" />
      </label>
    </div>

    <!-- 3GPP NTN 信道带宽合规提示（仅 3GPP 体制出现） -->
    <p v-if="ntnBw" class="bb-ntn" :class="{ over: ntnBw.level === 'over' }">
      <Icon v-if="ntnBw.level === 'over'" name="alert-triangle" :size="12" />
      <span>{{ ntnBw.text }}</span>
    </p>

    <!-- 计算方式：本载波的求解策略。链路表逐行按所选载波取用（功放功率取各行发端地球站配置的 paPowerW），
         故同一批次里不同载波可各按各的方式求解。系统余量只在「设置余量」下为输入，其余方式下是解出的结果。 -->
    <div v-if="calcModes.length" class="bb-cm">
      <label class="bb-f"><span class="bb-l">计算方式</span>
        <select v-model="form.calcMode" class="bb-i">
          <option v-for="m in calcModes" :key="m.key" :value="m.key">{{ m.label }}</option>
        </select>
      </label>
      <label v-if="form.calcMode === 'margin'" class="bb-f"><span class="bb-l">系统余量 <i>(dB)</i></span>
        <input v-model="form.margin" class="bb-i mono" placeholder="3.00" />
      </label>
      <label v-else-if="form.calcMode === 'overbalance'" class="bb-f"><span class="bb-l">超发量 <i>(dB)</i></span>
        <input v-model="form.overDb" class="bb-i mono" placeholder="0.00" />
      </label>
    </div>
  </div>
</template>

<style scoped>
.bb { max-width: 560px; }
.bb-modcod, .bb-grid, .bb-rt, .bb-cm { display: grid; gap: 8px 10px; margin-bottom: 10px; }
.bb-modcod { grid-template-columns: 1fr 2fr; }
.bb-grid { grid-template-columns: repeat(4, 1fr); }
.bb-rt { grid-template-columns: repeat(4, 1fr); padding-top: 8px; border-top: 1px dashed var(--border); }
/* 计算方式：求解策略，与载波信号参数隔一条分隔线；方式名较长，首列给两倍宽 */
.bb-cm { grid-template-columns: 2fr 1fr 1fr; padding-top: 8px; border-top: 1px dashed var(--border); }
.bb-f { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.bb-l { display: flex; align-items: center; gap: 4px; font-size: var(--fs-3); color: var(--text-muted); white-space: nowrap; }
/* 单位括注：从属信息，比标签名收小半档——既压住视觉权重，也给最窄一列（~87px）匀出余量，
   「频谱效率 (bps/Hz)」这类长标签才不会把括号裁掉 */
.bb-l i { font-size: .95em; color: var(--text-faint); font-style: normal; }
.bb-i { font: inherit; font-size: var(--fs-3); padding: 4px 7px; width: 100%; background-color: var(--field-bg); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px); }
.bb-i:focus { outline: none; border-color: var(--accent-ui); }
.bb-i.mono { font-family: var(--font-mono); }
/* 速率链：非锚点＝由锚点算出来的，退一档；锚点＝用户钉住的那个，正常色 */
.bb-rt .bb-i { background-color: var(--surface); color: var(--text-muted); }
.bb-rt .bb-i.bb-anch { color: var(--text); }
/* 3GPP NTN 信道带宽提示 / 帧效率越界：正常灰字说明，超限转红并给输入框描红边 */
.bb-rt .bb-i.bb-over, .bb-grid .bb-i.bb-over { color: var(--danger); border-color: var(--danger); }
.bb-ntn { display: flex; align-items: flex-start; gap: 5px; margin: -4px 0 0; font-size: var(--fs-2); line-height: 1.55; color: var(--text-faint); }
.bb-ntn.bb-rs { margin: -6px 0 10px; }   /* 帧效率提示夹在两组之间，上下都要留白 */
.bb-ntn.over { color: var(--danger); }
.bb-ntn :deep(svg) { flex: none; margin-top: 2px; }
/* 口径切换：当前口径名 + 互换图标合成一枚有边框的标签钮（Eb/N₀ ⇄ Es/N₀、频谱效率 ⇄ 帧效率）——
   名字在钮内，一眼看清「现在按哪个口径填」，边框与图标表明它可点。
   钮把口径名包进去而不是另占一格：检查器式排版下标签区只有 ~87px（styles/lbworkbench.css 两列
   minmax(196px,1fr)），另加一枚 20px 的独立钮会被 .bb-l 的 overflow:hidden 裁成半个——旧版即此症。
   这两行的数值都短（门限 4.30、效率 1.3800），故 .bb-f-tg 把输入框收窄，把宽度让给标签。 */
.bb-tg { display: inline-flex; align-items: center; gap: 3px; flex: none; font: inherit; line-height: 1.35;
         padding: 0 3px; cursor: pointer; background: var(--surface-2); color: var(--text);
         border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.bb-tg :deep(svg) { flex: none; color: var(--text-faint); }
.bb-tg:hover { border-color: var(--accent); }
.bb-tg:hover :deep(svg) { color: var(--accent); }
.bb-tg:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
.bb-f.bb-f-tg .bb-i { width: 78px; }   /* 四级：压过 styles/lbworkbench.css 里 104px 的三级规则 */
/* 3GPP 行的门限口径不可切（每 RE SNR 是标准定的），故是一枚定死的标签而不是钮：没有 hover/焦点态 */
.bb-tg-fix { display: inline-flex; align-items: center; flex: none; line-height: 1.35; padding: 0 3px;
             background: var(--surface-2); color: var(--text-muted);
             border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
/* 物理层参数区与读数区各自成组：前者可编辑（沿用 .bb-grid），后者只读（沿用速率链那档退色） */
.bb-phy { padding-top: 8px; border-top: 1px dashed var(--border); }
.bb-ro .bb-i { cursor: default; }
</style>
