// MODCOD 表的「内置 + 用户改写」合并层（纯 JS，平台无关）。
//
// 由来：六张 MODCOD 预设表原先写死在 constants.js 里，用户既加不了自家体制、也改不了某一档门限
// （各家调制解调器的实测门限与标准仿真值差一两个 dB 是常态）。现在改成两层：
//   ① 内置层 —— 仍在 constants.js，跟着软件版本走，出处与复核记录都在那里；
//   ② 改写层 —— 用户在「文件管理 · 调制编码」里的增删改，存 userData/data/modcod.json。
//
// ★ 改写层【只存差异】，不存整份快照：没被动过的标准照旧吃内置表，于是软件升级时新版的门限/
//   新增 MODCOD 能直接生效。若存整份快照，用户只改过 DVB-S2 的一条，其余五张表就永远冻结在
//   他第一次打开这个页面的那个版本上 —— 这是同类「可编辑预设」最常见的坑。
//
// 存储形状：
//   { version: 1,
//     overrides: { '<内置 key>': { label?, rows } },   // 只有被改过的内置标准在这里
//     custom:    [ { key: 'usr:xxxx', label, rows, phy?, meta? } ] }  // 用户自建标准
// phy —— 自建标准选的体制骨架（'nr' / 'nbiot' / 无），决定这张表的门限按 SNR 口径怎么用；
// meta —— 门限那一列的条件（BLER 目标 / 信道 / 码块规模 / 出处），厂家给表时一起录进来，只进 title。
//
// 一条 MODCOD 的字段与 BasebandPanel「套用 MODCOD」时写进载波表单的字段一一对应：
//   label 名称 / modulation 调制方式 / fec FEC 码率 / rsCode 帧效率 / bandwidthFactor 滚降系数(1+α)
//   / noiseRatioMode 门限口径('ebno'|'esno'|'snr') / threshold 门限(dB) / idx 体制内索引(可空)
//   / m 扩频增益（只对 esno 行有意义，见下）
// 引擎本身不认识「标准」这个概念：选一条 MODCOD 只是把这九个值整套填进表单，故本模块不参与任何计算。
// idx 是 3GPP 各表的 MCS 序号 / I_TBS：载波面板据它写 phy.mcs、phy.iTbs，不再从 label 里拿正则抠。
//
// ★ 名称：空串 = 自动名 =「调制方式 + FEC 码率」（'QPSK 3/4'），显示与出库时由 labelOf() 现拼；
//   用户填了别的字才是自定义名。与自动名恰好相同的字串按自动名收（改调制/码率后名字跟着走），
//   故存档与内置表里凡等于自动名的 label 一律归一成 ''。消费方（载波面板下拉 / SLA / 报表）
//   拿到的是 modcodMap() 填好名字的行，不必自己兜底。
//
// ★ 扩频增益 m 只随 esno 行走：门限 Es/N₀ 是【扩频之后每个传输符号】的能量比，
//   Es/N₀ = Eb/N₀ + 10·lg(FEC×帧效率×调制因子 ÷ m)，同一套调制编码换一个扩频因子，Es/N₀ 门限就差
//   10·lg(m) —— 表里给 Es/N₀ 而不给它对应的 m，这一行就没有定义（DVB-S2X VL-SNR 的扩频档正是
//   这样成对给的）。Eb/N₀ 口径下门限与扩频无关（AWGN 下理想解扩不改变每比特能量比），扩频是
//   载波自己的参数，留在载波面板上；snr 行（3GPP）不走这条换算链，重复次数另有 phy.nRep。
//   故 ebno / snr 行的 m 一律归一成 1（不参与任何计算，存 1 只为签名稳定）。
//
// ★ hl —— 硬限幅（非线性）信道的理想门限 Csat/(N0·Rs)，dB，资料性。只有 EN 302 307-2 表 20a 给了这一列
//   （DVB-S2X 正常帧里的 S2X 档），其余行 null。不参与链路计算（留给载荷非线性 / 最佳回退），只随表存取、导出。
//
// ★ 存档版本 2（2026-10-17）：DVB-S2 / S2X 内置表改由 ETSI 原表生成（门限订正 + 补 13 个 -L 档，其中 6 个原先
//   丢了 -L 后缀混在表里）。改写层存的是被改过的那张表的【整表】，若原样沿用，改过一格的用户就永远吃不到订正。
//   故 v1 存档里这两张表按「三方合并」迁移（migrateOverrideV1）：以 v1 内置表（LEGACY_V1，冻结的历史快照）为底，
//   逐行逐字段比用户的改写 —— 与底相同的字段取新版内置值，用户改过的字段保留用户值；旧名经 RENAMED_V2 认到
//   新名（'64APSK 32/45' → '64APSK 32/45-L'）；用户删掉的档不复活，新版新增的档补进来。改写一格不丢，没动过的格吃到订正。
//   载波配置里早先套用进去的门限同理（migrateCarrierForm，主进程读资源库时就地迁移）。
//
// ★ 逐行 ETSI 出处（表号 / 帧长 / QEF 判据）不进改写层（它是标准属性，不是用户偏好）：modcodMap() 出给消费方的
//   DVB 行按身份（规范名，认不出再按调制 + 码率）现查 data/etsiDvbS2.json 附上 qef / qefExp / frameBits / etsiTable，
//   SLA 的丢包率据此取 QEF 判据与帧长（见 shared/lbSla.js）。

const constants = require('./constants.js')
const ETSI_DVB = require('../data/etsiDvbS2.json')
const { parseModulation, composeModulation } = require('./modulation.js')

// 「自定义」不是一个标准，是「不套用任何标准、逐项自己填」的档位，恒在最前且不可编辑
const NONE_KEY = 'custom'
// 用户自建标准的 key 前缀。key 与显示名分家：改名不会让已存配置里的 dvbStandard 指空
const USER_PREFIX = 'usr:'

// 内置标准：key（＝载波表单里存的 dvbStandard 值）→ 表。顺序即下拉顺序。
const BUILTIN = [
  { key: 'DVB-S', table: 'DVBS_MODCOD_TABLE' },
  { key: 'DVB-S2', table: 'DVBS2_MODCOD_TABLE' },
  { key: 'DVB-RCS2', table: 'DVB_RCS2_MODCOD_TABLE' },
  { key: 'DVB-S2X', table: 'DVBS2X_MODCOD_TABLE' },
  { key: 'DVB-S2X Short', table: 'DVBS2X_SHORT_MODCOD_TABLE' },
  { key: 'DVB-S2X VL-SNR Medium', table: 'DVBS2X_MEDIUM_MODCOD_TABLE' },
  { key: '3GPP NR-NTN', table: 'NR_NTN_MODCOD_TABLE' },
  { key: '3GPP NR-NTN T2', table: 'NR_NTN_T2_MODCOD_TABLE' },
  { key: '3GPP NR-NTN T3', table: 'NR_NTN_T3_MODCOD_TABLE' },
  { key: '3GPP NR-NTN TP1', table: 'NR_NTN_TP1_MODCOD_TABLE' },
  { key: '3GPP NR-NTN TP2', table: 'NR_NTN_TP2_MODCOD_TABLE' },
  { key: '3GPP NB-IoT NTN', table: 'NB_IOT_NTN_MODCOD_TABLE' },
  { key: '3GPP NB-IoT NTN NPUSCH MT', table: 'NB_IOT_NTN_MT_MODCOD_TABLE' },
  { key: '3GPP NB-IoT NTN NPUSCH ST', table: 'NB_IOT_NTN_ST_MODCOD_TABLE' }
]

// 内置标准 → 该体制的物理层描述子缺省值（选中这个标准时载波面板铺的初值，见 utils/ntnPhy.js）。
// band = NTN 频段，缺省 n256（S 频段，TR 38.821 的基线频段）：它决定该子载波间隔可选的信道带宽档
//   （TS 38.101-5 Table 5.3.5-1）。★ 只有新选一次 MODCOD 才铺上，老配置的 phy 没有这个字段，
//   归一化记空串 = 不指定，照旧算得通。
// opMode = NB-IoT 部署模式，缺省独立部署（NTN 的典型形态）。
// 缺省取「最常见的那一档」：NR 下行 = 5 MHz@15 kHz 整载波（25 PRB），NR 上行 = 一个 UE 的 1 PRB 分配；
// NB-IoT 下行 = 整个 180 kHz 载波，上行多音 = 满 12 音、单音 = 1 音。重复次数一律从 1 起。
// 符号数按 §11-3：下行留 2 个符号给 PDCCH（12 个），上行 14 个；DMRS 都按 12 RE。
// ★ 内置标准的 phy 不可改（它是标准属性，不是用户偏好）；自建标准的 phy 存在 custom[].phy 里。
const PHY_OF = {
  '3GPP NR-NTN': { kind: 'nr', dir: 'dl', band: 'n256', mcsTable: 't1', scs: 15, chBwMHz: 5, nRb: 25, nSymb: 12, nDmrs: 12, nOh: 0, rateModel: 'tbs', layers: 1, nRep: 1, combLossDb: 0 },
  '3GPP NR-NTN T2': { kind: 'nr', dir: 'dl', band: 'n256', mcsTable: 't2', scs: 15, chBwMHz: 5, nRb: 25, nSymb: 12, nDmrs: 12, nOh: 0, rateModel: 'tbs', layers: 1, nRep: 1, combLossDb: 0 },
  '3GPP NR-NTN T3': { kind: 'nr', dir: 'dl', band: 'n256', mcsTable: 't3', scs: 15, chBwMHz: 5, nRb: 25, nSymb: 12, nDmrs: 12, nOh: 0, rateModel: 'tbs', layers: 1, nRep: 1, combLossDb: 0 },
  '3GPP NR-NTN TP1': { kind: 'nr', dir: 'ul', band: 'n256', mcsTable: 'tp1', scs: 15, chBwMHz: null, nRb: 1, nSymb: 14, nDmrs: 12, nOh: 0, rateModel: 'tbs', layers: 1, q: 2, nRep: 1, combLossDb: 0 },
  '3GPP NR-NTN TP2': { kind: 'nr', dir: 'ul', band: 'n256', mcsTable: 'tp2', scs: 15, chBwMHz: null, nRb: 1, nSymb: 14, nDmrs: 12, nOh: 0, rateModel: 'tbs', layers: 1, q: 2, nRep: 1, combLossDb: 0 },
  // ★ st = 这张表的行号口径与子载波数是不是被标准锁死的（见 utils/ntnPhy.js 的 normalizePhy）：
  //   NPDSCH 没有单音/多音之分记 null；NPUSCH 多音表 false（3/6/12 子载波、恒 15 kHz、行号 = I_TBS）；
  //   单音表 true（恒 1 子载波、行号 = I_MCS，要经 Table 16.5.1.2-1 映射）。
  //   不锁的话，选了单音表再把子载波数改成 12，门限还是单音那一列（高 1.6~3.8 dB），
  //   而 I_MCS 又被当 I_TBS 直读 —— 配出来的是标准里没有的组合。
  '3GPP NB-IoT NTN': { kind: 'nbiot', dir: 'dl', st: null, opMode: 'standalone', scs: 15, nTones: 12, iTbs: 0, iSf: 0, nRep: 1, combLossDb: 0 },
  '3GPP NB-IoT NTN NPUSCH MT': { kind: 'nbiot', dir: 'ul', st: false, opMode: 'standalone', scs: 15, nTones: 12, iTbs: 0, iRu: 0, nRep: 1, combLossDb: 0 },
  '3GPP NB-IoT NTN NPUSCH ST': { kind: 'nbiot', dir: 'ul', st: true, opMode: 'standalone', scs: 15, nTones: 1, iTbs: 0, iRu: 0, nRep: 1, combLossDb: 0 }
}
// 自建标准只让选个体制（其余物理层参数在载波面板上填），故这里只留两个骨架
const PHY_KINDS = [
  { value: '', label: '无' },
  { value: 'nr', label: 'NR' },
  { value: 'nbiot', label: 'NB-IoT' }
]
const BUILTIN_KEYS = BUILTIN.map((b) => b.key)
const isUserKey = (k) => String(k == null ? '' : k).startsWith(USER_PREFIX)

// 内置标准的显示名：取 DVB_STANDARD_OPTIONS 里的 label（当前与 key 同字，留着这一层是因为
// 将来内置标准若要带中文注名，只需改那张表）
function builtinLabel(key) {
  const o = (constants.DVB_STANDARD_OPTIONS || []).find((x) => x.value === key)
  return (o && o.label) || key
}

const num = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d }
const str = (v) => String(v == null ? '' : v).trim()
// 体制内索引（NR 的 MCS 序号 / NB-IoT 的 I_TBS 或单音 I_MCS）。留空是常态（DVB 各表根本没有这个概念），
// 故认不出一律 null 而不是 0 —— 0 是一个合法的 MCS 序号，用它兜底会把「没填」和「第 0 档」混成一件事。
const idxOf = (v) => {
  if (v === '' || v == null) return null
  const n = Math.round(Number(v))
  return isFinite(n) && n >= 0 ? n : null
}

// 门限口径：对内一律 'ebno' / 'esno' / 'snr'。人读写法（Eb/N₀、Es/N0、EbNo、SNR(dB)、SINR、信噪比…）
// 与内部写法都认，认不出按 Es/N₀ ——DVB 各体制里除 DVB-S 外全是 Es/N₀ 口径。
//
// ★ 第三档 'snr' 是 3GPP NTN 的口径：门限 = 每资源元素 RE 的信噪比 = 【占用带宽 N_RB×12×SCS 内的 C/N】
//   （NB-IoT 上行 = 音数×SCS）。它与 Es/N₀ 在物理上是同一个量，区别只在噪声带宽怎么取：
//   esno 行的噪声带宽是由信息速率÷帧效率÷FEC÷调制因子反推出来的符号率，snr 行的是按 PRB 数算出来的
//   占用带宽。详见 utils/ntnPhy.js 的文件头。
function normMode(v) {
  const s = str(v).toLowerCase().replace(/[\s/₀0]/g, '')
  if (s === 'ebn' || s === 'ebno' || s.indexOf('ebn') === 0) return 'ebno'
  if (s.indexOf('snr') === 0 || s.indexOf('sinr') === 0 || s === '信噪比') return 'snr'
  return 'esno'
}

// 调制方式规范化：认得出吐规范写法（'qpsk' → 'QPSK'），认不出吐空串
function canonModulation(v) {
  const p = parseModulation(v)
  return p ? composeModulation(p.family, p.order) : ''
}

// 自动名 =「调制方式 + FEC 码率」；两项都空时为空串
const autoLabel = (r) => [str(r && r.modulation), str(r && r.fec)].filter(Boolean).join(' ')
// 显示名：自定义名优先，否则自动名，两者都拼不出来时兜底 'MODCOD'
const labelOf = (r) => str(r && r.label) || autoLabel(r) || 'MODCOD'
// 硬限幅信道门限 Csat/(N0·Rs)：留空 / 认不出 = null（绝大多数行没有这一列，见文件头），0 是合法值
const hlOf = (v) => {
  if (v === '' || v == null) return null
  const n = parseFloat(v)
  return isFinite(n) ? n : null
}
// 扩频增益的归一：只有 esno 行有意义；≥ 1（处理增益 = 码片率 ÷ 载波速率，按定义不小于 1）
function normSpread(v, mode) {
  if (mode !== 'esno') return 1
  const n = num(v, 1)
  return isFinite(n) && n >= 1 ? n : 1
}

// 一条 MODCOD 的归一化。返回 null = 这一行不该落库，调用方丢弃。两种情形：
//   ① 整行空白；
//   ② 调制方式填了、却不是平台认得的调制方式 —— ★ 这是最后一道闸。调制因子是符号率与载波带宽
//      整条换算链的乘数，放一个查不到的名字进去，引擎会静默按 2 bit/符号算，账面上一切正常。
//      界面那两条路（枚举下拉、setCell）本就挡住了，这里挡的是绕过界面直接改 modcod.json 的情形。
// ★ 门限缺失不丢行：用户在表里先铺出调制/码率、门限待测是常见做法，此时按 0 dB 落库并照常显示。
// ★ label 落库只留自定义名：等于自动名（按归一化后的调制/码率拼）或留空的一律收成 ''（见文件头）。
function normalizeRow(r) {
  if (!r) return null
  const rawMod = str(r.modulation)
  const modulation = canonModulation(rawMod)
  if (rawMod && !modulation) return null
  const fec = str(r.fec)
  const rawLabel = str(r.label)
  if (!rawLabel && !modulation && !fec) return null
  const out = {
    label: '',
    modulation: modulation || 'QPSK',
    fec: fec || '1/2',
    rsCode: str(r.rsCode) || '1',
    bandwidthFactor: num(r.bandwidthFactor, 1.2),
    noiseRatioMode: normMode(r.noiseRatioMode),
    threshold: num(r.threshold, 0),
    idx: idxOf(r.idx),
    m: 1,
    hl: hlOf(r.hl)
  }
  out.m = normSpread(r.m, out.noiseRatioMode)
  // 与自动名比要用【归一化后】的调制/码率：'qpsk 3/4' 的行调制被收成 'QPSK'，名字也该跟着算自动
  if (rawLabel && rawLabel !== autoLabel(out)) out.label = rawLabel
  return out
}
const normalizeRows = (rows) => (Array.isArray(rows) ? rows : []).map(normalizeRow).filter(Boolean)
// 消费方用的行：名字填好（自动名现拼），其余字段原样
const withLabels = (rows) => rows.map((r) => Object.assign({}, r, { label: labelOf(r) }))

// 内置表的一份归一化拷贝（内置常量恒不可变，故每次现造，绝不把用户改动写回去）
function builtinRows(key) {
  const def = BUILTIN.find((b) => b.key === key)
  return def ? normalizeRows(constants[def.table]) : []
}

// 逐值比较两张表：判「这个内置标准被改过没有」。键序固定，故直接比 JSON。
const ROW_KEYS = ['label', 'modulation', 'fec', 'rsCode', 'bandwidthFactor', 'noiseRatioMode', 'threshold', 'idx', 'm', 'hl']
const rowSig = (r) => ROW_KEYS.map((k) => String(r[k])).join('')
const tableSig = (rows) => rows.map(rowSig).join('')

/* ===================== 存档 v1 → v2 迁移（2026-10-17 DVB 门限订正）===================== */

const STORE_VERSION = 2

// v1 内置表的冻结快照（2026-06 起到 2026-10-17 一字未变）：迁移的「底」。只用于迁移，别拿它算任何东西。
// 两张表的帧效率 / 滚降 / 门限口径恒为 '0.9' / 1.05 / esno、名字恒为自动名，故只记 [名字, 门限]。
const LEGACY_V1 = {
  'DVB-S2': [
    ['QPSK 1/4', -1.20], ['QPSK 1/3', -0.70], ['QPSK 2/5', 0.00], ['QPSK 1/2', 1.00], ['QPSK 3/5', 2.23], ['QPSK 2/3', 3.10],
    ['QPSK 3/4', 4.03], ['QPSK 4/5', 4.68], ['QPSK 5/6', 5.18], ['QPSK 8/9', 6.20], ['QPSK 9/10', 6.42], ['8PSK 3/5', 5.50],
    ['8PSK 2/3', 6.62], ['8PSK 3/4', 7.91], ['8PSK 5/6', 9.35], ['8PSK 8/9', 10.69], ['8PSK 9/10', 10.98], ['16APSK 2/3', 8.97],
    ['16APSK 3/4', 10.21], ['16APSK 4/5', 11.03], ['16APSK 5/6', 11.61], ['16APSK 8/9', 12.89], ['16APSK 9/10', 13.13], ['32APSK 3/4', 12.73],
    ['32APSK 4/5', 13.64], ['32APSK 5/6', 14.28], ['32APSK 8/9', 15.69], ['32APSK 9/10', 16.05]
  ],
  'DVB-S2X': [
    ['QPSK 2/9', -2.85], ['QPSK 13/45', -2.03], ['QPSK 1/4', -1.20], ['QPSK 1/3', -0.70], ['QPSK 2/5', 0.00], ['QPSK 9/20', 0.69],
    ['QPSK 1/2', 1.00], ['QPSK 11/20', 1.58], ['QPSK 3/5', 2.23], ['QPSK 2/3', 3.10], ['QPSK 3/4', 4.03], ['QPSK 4/5', 4.68],
    ['QPSK 5/6', 5.18], ['QPSK 8/9', 6.20], ['QPSK 9/10', 6.42], ['8PSK 3/5', 5.50], ['8PSK 23/36', 6.12], ['8PSK 2/3', 6.62],
    ['8PSK 25/36', 7.05], ['8PSK 13/18', 7.49], ['8PSK 3/4', 7.91], ['8PSK 5/6', 9.35], ['8PSK 8/9', 10.69], ['8PSK 9/10', 10.98],
    ['16APSK 26/45', 7.80], ['16APSK 3/5', 8.38], ['16APSK 28/45', 8.56], ['16APSK 23/36', 8.77], ['16APSK 2/3', 8.97], ['16APSK 25/36', 9.49],
    ['16APSK 3/4', 10.21], ['16APSK 13/18', 9.90], ['16APSK 7/9', 10.69], ['16APSK 4/5', 11.03], ['16APSK 5/6', 11.61], ['16APSK 77/90', 12.09],
    ['16APSK 8/9', 12.89], ['16APSK 9/10', 13.13], ['32APSK 2/3', 11.75], ['32APSK 32/45', 12.14], ['32APSK 11/15', 12.49], ['32APSK 3/4', 12.73],
    ['32APSK 7/9', 13.24], ['32APSK 4/5', 13.64], ['32APSK 5/6', 14.28], ['32APSK 8/9', 15.69], ['32APSK 9/10', 16.05], ['64APSK 32/45', 13.98],
    ['64APSK 11/15', 14.81], ['64APSK 7/9', 15.52], ['64APSK 4/5', 16.20], ['64APSK 5/6', 16.55], ['128APSK 3/4', 17.73], ['128APSK 7/9', 18.53],
    ['256APSK 29/45', 16.98], ['256APSK 2/3', 17.24], ['256APSK 31/45', 18.10], ['256APSK 32/45', 18.59], ['256APSK 11/15', 18.84], ['256APSK 3/4', 19.57]
  ]
}
// v1 里丢了 -L 后缀的 6 档（EN 302 307-2 表 20a 里这几个码率只有 -L 星座，没有同名的常规星座）
const RENAMED_V2 = {
  'DVB-S2X': {
    '32APSK 2/3': '32APSK 2/3-L', '64APSK 32/45': '64APSK 32/45-L',
    '256APSK 29/45': '256APSK 29/45-L', '256APSK 2/3': '256APSK 2/3-L', '256APSK 31/45': '256APSK 31/45-L', '256APSK 11/15': '256APSK 11/15-L'
  }
}
function legacyRowsV1(key) {
  return (LEGACY_V1[key] || []).map(([name, th]) => {
    const sp = name.indexOf(' ')
    return normalizeRow({ label: '', modulation: name.slice(0, sp), fec: name.slice(sp + 1), rsCode: '0.9', bandwidthFactor: 1.05, noiseRatioMode: 'esno', threshold: th })
  })
}
const sameField = (a, b) => String(a) === String(b)   // 与 rowSig 同一把尺（null ⇄ 'null'）

/**
 * v1 存档里一张内置表的改写 → v2：三方合并（底 = LEGACY_V1，他方 = 本版内置表，我方 = 用户改写）。
 *   ① 用户行按「调制 + 码率」认回 v1 底的某一行（v1 两张表里调制 + 码率恰好唯一；同一档重复出现的第二行算用户新增）；
 *   ② 认得出的行逐字段合并：与底相同取本版内置值，否则留用户值；名字为自动名时随本版走（于是丢了 -L 的 6 档换上规范名）；
 *   ③ 用户删掉的档不复活；本版新增、v1 底里没有的档补进来；
 *   ④ 行序：用户没调过序（认回的行在底里的次序递增）就按本版内置表排，用户新增的行跟在它原先的前一行后面；
 *      调过序就保留用户次序，新增档插在本版里它前一档的后面（前一档不在就排到末尾）。
 * 整张表若合并后与本版内置表逐值相同，listStandards 自然判为「未改写」，下次存档时差异自动清空。
 */
function migrateOverrideV1(key, mine) {
  const base = legacyRowsV1(key)
  if (!base.length) return mine
  const theirs = builtinRows(key)
  const theirIdx = new Map(theirs.map((r, i) => [labelOf(r), i]))
  const rename = RENAMED_V2[key] || {}
  const list = Array.isArray(mine) ? mine : []
  // 两轮认行：先认自动名的行（v1 底里的档恒是自动名），再让起了别名的行去认剩下的底 ——
  // 否则用户在真档前面插了一条同调制同码率的自建档（「厂家 QPSK 1/2」），它会先把底占掉，真档反被当成新增
  const biOf = list.map(() => -1)
  const used = new Set()
  for (const autoOnly of [true, false]) {
    list.forEach((r, j) => {
      if (biOf[j] >= 0 || (autoOnly && r.label)) return
      const bi = base.findIndex((b, i) => !used.has(i) && b.modulation === r.modulation && b.fec === r.fec)
      if (bi >= 0) { used.add(bi); biOf[j] = bi }
    })
  }
  const items = list.map((r, j) => {
    const bi = biOf[j]
    if (bi < 0) return { row: r, ti: null, bi: null }
    const legacyName = labelOf(base[bi])
    const ti = theirIdx.get(rename[legacyName] || legacyName)
    if (ti == null) return { row: r, ti: null, bi }
    const b = base[bi], t = theirs[ti], out = {}
    for (const k of ROW_KEYS) out[k] = sameField(r[k], b[k]) ? t[k] : r[k]
    return { row: out, ti, bi }
  })
  const legacyNew = new Set(base.map((b) => { const n = labelOf(b); return rename[n] || n }))
  // 本版新增、v1 底里根本没有的档（13 个 -L 档里那 7 个）。用户删掉的旧档（底里有、用户表里没有）不补。
  const added = theirs.map((r, i) => ({ row: Object.assign({}, r), ti: i, bi: null }))
    .filter((x) => !legacyNew.has(labelOf(x.row)))
  const seq = items.filter((x) => x.bi != null).map((x) => x.bi)
  const reordered = seq.some((v, i) => i && v < seq[i - 1])
  if (!reordered) {
    // 按本版次序排认回的行与新增档；用户新增的行挂在它原先的前一行（认回的那行）后面
    const anchored = new Map()   // ti → [用户新增行]
    const head = []
    let prevTi = null
    for (const x of items) {
      if (x.ti != null) { prevTi = x.ti; continue }
      if (prevTi == null) head.push(x.row)
      else { if (!anchored.has(prevTi)) anchored.set(prevTi, []); anchored.get(prevTi).push(x.row) }
    }
    const spine = items.filter((x) => x.ti != null).concat(added).sort((a, b) => a.ti - b.ti)
    const out = head.slice()
    for (const x of spine) { out.push(x.row); if (anchored.has(x.ti)) out.push(...anchored.get(x.ti)) }
    return out
  }
  const out = items.map((x) => x.row)
  for (const a of added) {
    // 插在本版里它前一档（已在结果里的）后面
    let at = out.length
    for (let i = a.ti - 1; i >= 0; i--) {
      const nm = labelOf(theirs[i])
      const j = out.findIndex((r) => labelOf(r) === nm)
      if (j >= 0) { at = j + 1; break }
    }
    out.splice(at, 0, a.row)
  }
  return out
}

/* ===================== ETSI 逐行出处（只读，不进改写层）===================== */

// 一行 MODCOD 在 ETSI 原表里是哪一行。先按规范名（自定义名 / 自动名）认，认不出再按调制 + 码率 + 扩频认
// （名字带 -L 的优先认 -L 星座）。返回 { id, table, qef, frame, row } 或 null（非 DVB-S2/S2X 内置标准、或表里没有这一档）。
function etsiRowOf(key, r) {
  const ids = (ETSI_DVB.standards && ETSI_DVB.standards[key]) || null
  if (!ids || !r) return null
  const name = labelOf(r)
  const hit = (pred) => {
    for (const id of ids) {
      const t = ETSI_DVB.tables[id]
      const e = t.rows.find(pred)
      if (e) return { id, table: t.table, doc: ETSI_DVB.sources[t.source].doc, qef: t.qef, frame: e.frame || t.frame, row: e }
    }
    return null
  }
  const byName = hit((e) => e.name === name)
  if (byName) return byName
  const wantL = /-L\b/.test(name)
  const m = Number(r.m) >= 1 ? Number(r.m) : 1
  const same = (e) => e.mod === r.modulation && e.fec === str(r.fec) && (e.spread || 1) === m
  return hit((e) => same(e) && !!e.L === wantL) || hit(same)
}
// 内置 DVB 标准在原表里查不到这一档时的缺省判据（DVB-S2X 正常帧取表 20a 的 FER 10⁻⁵）
function etsiStdDefault(key) {
  const ids = (ETSI_DVB.standards && ETSI_DVB.standards[key]) || null
  if (!ids || !ids.length) return null
  const t = ETSI_DVB.tables[ids[0]]
  return { id: ids[0], table: t.table, doc: ETSI_DVB.sources[t.source].doc, qef: t.qef, frame: t.frame }
}
// 出给消费方的行附上出处：qef（'PER' | 'FER'）/ qefExp（10⁻ⁿ 的 n）/ frameBits / etsiTable（'EN 302 307-2 V1.4.1 表 20a'）
function withEtsi(key, r) {
  const e = etsiRowOf(key, r) || etsiStdDefault(key)
  if (!e) return r
  return Object.assign({}, r, { qef: e.qef.kind, qefExp: e.qef.exp, frameBits: e.frame, etsiTable: e.doc.replace(/ \(\d{4}-\d{2}\)$/, '') + ' 表 ' + e.table })
}

/**
 * 载波配置（资源库 carrier 条目的 form）里早先从 v1 内置表套用进来、之后没被手改过的门限 → 本版值。
 * 判据：标准是 DVB-S2 / S2X、Es/N₀ 口径、无扩频，且「调制 + 码率 + 门限（±0.005 dB）」恰是 v1 内置表的某一档 ——
 * 这样的值只可能是套用 MODCOD 时整套落进来的，手改过的（与 v1 表值不同）一律不动（求解不覆盖用户配置）。
 * 名字只在原本为空或等于 v1 自动名时才换成规范名（用户自己的改写表里给这一档起了别名的，不去碰它）。
 * @returns 要并进 form 的补丁 { ebno?, modcodLabel?, modcodIndex? }，无需改动返回 null
 */
function migrateCarrierForm(form) {
  if (!form || typeof form !== 'object') return null
  const key = String(form.dvbStandard || '')
  if (!LEGACY_V1[key]) return null
  if (normMode(form.noiseRatioMode || 'esno') !== 'esno') return null
  if (num(form.m, 1) !== 1) return null
  const mod = canonModulation(form.modulation)
  const fec = str(form.fec)
  const th = parseFloat(form.ebno)
  if (!mod || !fec || !isFinite(th)) return null
  const hit = LEGACY_V1[key].find(([n, t]) => n === mod + ' ' + fec && Math.abs(t - th) < 0.005)
  if (!hit) return null
  const newName = (RENAMED_V2[key] && RENAMED_V2[key][hit[0]]) || hit[0]
  const rows = builtinRows(key)
  const i = rows.findIndex((r) => labelOf(r) === newName)
  if (i < 0) return null
  const patch = {}
  if (Math.abs(rows[i].threshold - th) >= 0.005) patch.ebno = Number(rows[i].threshold).toFixed(2)
  const lbl = str(form.modcodLabel)
  if ((!lbl || lbl === hit[0]) && lbl !== newName) patch.modcodLabel = newName
  if ((!lbl || lbl === hit[0]) && Number(form.modcodIndex) !== i) patch.modcodIndex = i
  return Object.keys(patch).length ? patch : null
}

// 存档规整：老档/半截档/手改坏的档一律吃得下，读不出的部分按「没改过」处理
function normalizeStore(store) {
  const s = store && typeof store === 'object' ? store : {}
  const overrides = {}
  const src = s.overrides && typeof s.overrides === 'object' ? s.overrides : {}
  // v1（及没写版本号的手改档）：DVB-S2 / S2X 两张表的改写按三方合并迁到 v2 内置表（见文件头）
  const fromV1 = !(Number(s.version) >= STORE_VERSION)
  for (const key of BUILTIN_KEYS) {
    const o = src[key]
    if (!o || !Array.isArray(o.rows)) continue
    let rows = normalizeRows(o.rows)
    if (fromV1 && LEGACY_V1[key]) rows = migrateOverrideV1(key, rows)
    overrides[key] = { label: str(o.label) || undefined, rows }
  }
  const taken = new Set(BUILTIN_KEYS)
  const custom = []
  for (const c of (Array.isArray(s.custom) ? s.custom : [])) {
    if (!c) continue
    let key = str(c.key)
    if (!isUserKey(key) || taken.has(key)) key = newUserKey(taken)
    taken.add(key)
    custom.push({
      key, label: str(c.label) || key.slice(USER_PREFIX.length), rows: normalizeRows(c.rows),
      phy: normPhyKind(c.phy), meta: normMeta(c.meta)
    })
  }
  return { version: STORE_VERSION, overrides, custom }
}

// 自建标准的体制骨架：只认 'nr' / 'nbiot'，其余（含空）一律 null = 这张表不走 SNR 口径
function normPhyKind(v) {
  const k = str(v).toLowerCase()
  return (k === 'nr' || k === 'nbiot') ? k : null
}
// 门限条件元数据。全空返回 null（绝大多数自建表不会填），故存档里不留空壳。
function normMeta(m) {
  if (!m || typeof m !== 'object') return null
  const out = {}
  const bler = num(m.bler, null)
  if (bler != null && bler > 0 && bler < 1) out.bler = bler
  for (const k of ['channel', 'block', 'source']) { const v = str(m[k]); if (v) out[k] = v }
  const rep = num(m.rep, null)
  if (rep != null && rep >= 1) out.rep = Math.round(rep)
  return Object.keys(out).length ? out : null
}

// 新的自建标准 key。taken = 已占用的 key 集合。
function newUserKey(taken) {
  let n = 1
  while (taken && taken.has(USER_PREFIX + n)) n++
  return USER_PREFIX + n
}

/**
 * 合并后的标准清单（供编辑界面用）。
 * 返回 [{ key, label, builtin, modified, rows }]：内置在前（照 BUILTIN 顺序），自建在后。
 *   modified —— 仅内置标准有意义：true = 当前内容与本版内置表不同（界面据此给「恢复默认」）
 */
function listStandards(store) {
  const s = normalizeStore(store)
  const out = []
  for (const key of BUILTIN_KEYS) {
    const base = builtinRows(key)
    const ov = s.overrides[key]
    const rows = ov ? ov.rows : base
    out.push({
      key,
      label: (ov && ov.label) || builtinLabel(key),
      group: builtinGroup(key),
      builtin: true,
      modified: !!ov && (tableSig(rows) !== tableSig(base) || ((ov.label || builtinLabel(key)) !== builtinLabel(key))),
      // 内置标准的 phy / meta 恒跟版本走：改写层只存门限那几列，不存体制属性
      phy: PHY_OF[key] ? Object.assign({}, PHY_OF[key]) : null,
      meta: builtinMeta(key),
      rows
    })
  }
  for (const c of s.custom) {
    out.push({
      key: c.key, label: c.label, group: '自建', builtin: false, modified: false, rows: c.rows,
      // 自建标准只选体制，其余物理层参数在载波面板上逐项填
      phy: c.phy ? { kind: c.phy } : null, meta: c.meta || null
    })
  }
  return out
}

/**
 * 编辑界面的清单 → 存档（只留差异）。
 * list = [{ key, label, rows }]；内置标准与本版内置表逐值相同的不落库，于是升级后照旧跟版本走。
 * 清单里缺席的内置标准按「没改过」处理（界面不提供删除内置标准，缺席只可能是调用方少传）。
 */
function storeFromList(list) {
  const overrides = {}
  const custom = []
  const taken = new Set(BUILTIN_KEYS)
  for (const it of (Array.isArray(list) ? list : [])) {
    if (!it) continue
    const key = str(it.key)
    const rows = normalizeRows(it.rows)
    if (BUILTIN_KEYS.indexOf(key) > -1) {
      const label = str(it.label) || builtinLabel(key)
      if (tableSig(rows) === tableSig(builtinRows(key)) && label === builtinLabel(key)) continue
      overrides[key] = { rows }
      if (label !== builtinLabel(key)) overrides[key].label = label
    } else {
      let k = isUserKey(key) && !taken.has(key) ? key : newUserKey(taken)
      taken.add(k)
      custom.push({
        key: k, label: str(it.label) || k.slice(USER_PREFIX.length), rows,
        phy: normPhyKind(it.phy && it.phy.kind !== undefined ? it.phy.kind : it.phy),
        meta: normMeta(it.meta)
      })
    }
  }
  return { version: STORE_VERSION, overrides, custom }
}

/**
 * 载波信号面板要的两样：标准下拉 + 各标准的 MODCOD 表。
 * 与 core.basebandOptions() 的 dvbStandards / modcod 两个字段同形，故合并层可原样替换旧的常量取法。
 */
// 内置标准的下拉分组（DVB / 3GPP NR-NTN / 3GPP NB-IoT NTN），取 DVB_STANDARD_OPTIONS 那一列
function builtinGroup(key) {
  const o = (constants.DVB_STANDARD_OPTIONS || []).find((x) => x.value === key)
  return (o && o.group) || ''
}

/**
 * 某个标准的物理层描述子缺省值（选中它时铺给载波面板的初值）。
 * 返回 null = 这个标准不是 3GPP 体制，载波照旧走 DVB 那条换算链。
 */
function phyOf(key, store) {
  if (PHY_OF[key]) return Object.assign({}, PHY_OF[key])
  const c = normalizeStore(store).custom.find((x) => x.key === key)
  return c && c.phy ? { kind: c.phy } : null
}
// 内置标准门限那一列的条件元数据：3GPP 各表（NTN_TABLE_META）与 DVB 各表（DVB_TABLE_META，含 QEF 判据与
// 只进 title 的 note），都跟着版本走
function builtinMeta(key) {
  return (constants.NTN_TABLE_META && constants.NTN_TABLE_META[key]) ||
    (constants.DVB_TABLE_META && constants.DVB_TABLE_META[key]) || null
}
// 某个标准门限那一列的条件元数据（只进 title）
function metaOf(key, store) {
  const b = builtinMeta(key)
  if (b) return b
  const c = normalizeStore(store).custom.find((x) => x.key === key)
  return (c && c.meta) || null
}

function standardOptions(store) {
  const opts = [{ value: NONE_KEY, label: '自定义' }]
  for (const s of listStandards(store)) opts.push({ value: s.key, label: s.label, group: s.group || '' })
  return opts
}
// ★ 出给载波面板 / SLA / 报表的行名字已填好（自动名现拼）；listStandards 给编辑页的仍是原样（'' = 自动名）
// DVB-S2 / S2X 各行另附 ETSI 出处（qef / qefExp / frameBits / etsiTable，见 withEtsi），SLA 丢包率按它取判据与帧长
function modcodMap(store) {
  const map = {}
  for (const s of listStandards(store)) map[s.key] = withLabels(s.rows).map((r) => withEtsi(s.key, r))
  return map
}

module.exports = {
  NONE_KEY, USER_PREFIX, BUILTIN_KEYS, STORE_VERSION,
  isUserKey, newUserKey, builtinLabel, builtinRows,
  normalizeRow, normalizeRows, normalizeStore, normMode, autoLabel, labelOf, withLabels,
  PHY_OF, PHY_KINDS, phyOf, metaOf, builtinGroup,
  listStandards, storeFromList, standardOptions, modcodMap,
  LEGACY_V1, RENAMED_V2, migrateOverrideV1, migrateCarrierForm, etsiRowOf
}
