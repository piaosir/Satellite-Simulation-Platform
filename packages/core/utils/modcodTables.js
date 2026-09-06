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
// 引擎本身不认识「标准」这个概念：选一条 MODCOD 只是把这八个值整套填进表单，故本模块不参与任何计算。
// idx 是 3GPP 各表的 MCS 序号 / I_TBS：载波面板据它写 phy.mcs、phy.iTbs，不再从 label 里拿正则抠。

const constants = require('./constants.js')
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

// 一条 MODCOD 的归一化。返回 null = 这一行不该落库，调用方丢弃。两种情形：
//   ① 整行空白；
//   ② 调制方式填了、却不是平台认得的调制方式 —— ★ 这是最后一道闸。调制因子是符号率与载波带宽
//      整条换算链的乘数，放一个查不到的名字进去，引擎会静默按 2 bit/符号算，账面上一切正常。
//      界面那两条路（枚举下拉、setCell）本就挡住了，这里挡的是绕过界面直接改 modcod.json 的情形。
// ★ 门限缺失不丢行：用户在表里先铺出调制/码率、门限待测是常见做法，此时按 0 dB 落库并照常显示。
function normalizeRow(r) {
  if (!r) return null
  const rawMod = str(r.modulation)
  const modulation = canonModulation(rawMod)
  if (rawMod && !modulation) return null
  const fec = str(r.fec)
  const label = str(r.label) || (modulation && fec ? modulation + ' ' + fec : modulation || fec)
  if (!label && !modulation && !fec) return null
  return {
    label: label || 'MODCOD',
    modulation: modulation || 'QPSK',
    fec: fec || '1/2',
    rsCode: str(r.rsCode) || '1',
    bandwidthFactor: num(r.bandwidthFactor, 1.2),
    noiseRatioMode: normMode(r.noiseRatioMode),
    threshold: num(r.threshold, 0),
    idx: idxOf(r.idx)
  }
}
const normalizeRows = (rows) => (Array.isArray(rows) ? rows : []).map(normalizeRow).filter(Boolean)

// 内置表的一份归一化拷贝（内置常量恒不可变，故每次现造，绝不把用户改动写回去）
function builtinRows(key) {
  const def = BUILTIN.find((b) => b.key === key)
  return def ? normalizeRows(constants[def.table]) : []
}

// 逐值比较两张表：判「这个内置标准被改过没有」。键序固定，故直接比 JSON。
const ROW_KEYS = ['label', 'modulation', 'fec', 'rsCode', 'bandwidthFactor', 'noiseRatioMode', 'threshold', 'idx']
const rowSig = (r) => ROW_KEYS.map((k) => String(r[k])).join('')
const tableSig = (rows) => rows.map(rowSig).join('')

// 存档规整：老档/半截档/手改坏的档一律吃得下，读不出的部分按「没改过」处理
function normalizeStore(store) {
  const s = store && typeof store === 'object' ? store : {}
  const overrides = {}
  const src = s.overrides && typeof s.overrides === 'object' ? s.overrides : {}
  for (const key of BUILTIN_KEYS) {
    const o = src[key]
    if (!o || !Array.isArray(o.rows)) continue
    overrides[key] = { label: str(o.label) || undefined, rows: normalizeRows(o.rows) }
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
  return { version: 1, overrides, custom }
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
      meta: (constants.NTN_TABLE_META && constants.NTN_TABLE_META[key]) || null,
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
  return { version: 1, overrides, custom }
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
// 某个标准门限那一列的条件元数据（只进 title）
function metaOf(key, store) {
  const b = constants.NTN_TABLE_META && constants.NTN_TABLE_META[key]
  if (b) return b
  const c = normalizeStore(store).custom.find((x) => x.key === key)
  return (c && c.meta) || null
}

function standardOptions(store) {
  const opts = [{ value: NONE_KEY, label: '自定义' }]
  for (const s of listStandards(store)) opts.push({ value: s.key, label: s.label, group: s.group || '' })
  return opts
}
function modcodMap(store) {
  const map = {}
  for (const s of listStandards(store)) map[s.key] = s.rows
  return map
}

module.exports = {
  NONE_KEY, USER_PREFIX, BUILTIN_KEYS,
  isUserKey, newUserKey, builtinLabel, builtinRows,
  normalizeRow, normalizeRows, normalizeStore, normMode,
  PHY_OF, PHY_KINDS, phyOf, metaOf, builtinGroup,
  listStandards, storeFromList, standardOptions, modcodMap
}
