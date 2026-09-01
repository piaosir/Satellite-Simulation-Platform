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
//     custom:    [ { key: 'usr:xxxx', label, rows } ] }  // 用户自建标准
//
// 一条 MODCOD 的字段与 BasebandPanel「套用 MODCOD」时写进载波表单的字段一一对应：
//   label 名称 / modulation 调制方式 / fec FEC 码率 / rsCode 帧效率 / bandwidthFactor 滚降系数(1+α)
//   / noiseRatioMode 门限口径('ebno'|'esno') / threshold 门限(dB)
// 引擎本身不认识「标准」这个概念：选一条 MODCOD 只是把这七个值整套填进表单，故本模块不参与任何计算。

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
  { key: '3GPP NB-IoT NTN', table: 'NB_IOT_NTN_MODCOD_TABLE' }
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

// 门限口径：对内一律 'ebno' / 'esno'。人读写法（Eb/N₀、Es/N0、EbNo…）与内部写法都认，
// 认不出按 Es/N₀ ——现行体制里除 DVB-S 外全是 Es/N₀ 口径。
function normMode(v) {
  const s = str(v).toLowerCase().replace(/[\s/₀0]/g, '')
  if (s === 'ebn' || s === 'ebno' || s.indexOf('ebn') === 0) return 'ebno'
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
    threshold: num(r.threshold, 0)
  }
}
const normalizeRows = (rows) => (Array.isArray(rows) ? rows : []).map(normalizeRow).filter(Boolean)

// 内置表的一份归一化拷贝（内置常量恒不可变，故每次现造，绝不把用户改动写回去）
function builtinRows(key) {
  const def = BUILTIN.find((b) => b.key === key)
  return def ? normalizeRows(constants[def.table]) : []
}

// 逐值比较两张表：判「这个内置标准被改过没有」。键序固定，故直接比 JSON。
const ROW_KEYS = ['label', 'modulation', 'fec', 'rsCode', 'bandwidthFactor', 'noiseRatioMode', 'threshold']
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
    custom.push({ key, label: str(c.label) || key.slice(USER_PREFIX.length), rows: normalizeRows(c.rows) })
  }
  return { version: 1, overrides, custom }
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
      builtin: true,
      modified: !!ov && (tableSig(rows) !== tableSig(base) || ((ov.label || builtinLabel(key)) !== builtinLabel(key))),
      rows
    })
  }
  for (const c of s.custom) out.push({ key: c.key, label: c.label, builtin: false, modified: false, rows: c.rows })
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
      custom.push({ key: k, label: str(it.label) || k.slice(USER_PREFIX.length), rows })
    }
  }
  return { version: 1, overrides, custom }
}

/**
 * 载波信号面板要的两样：标准下拉 + 各标准的 MODCOD 表。
 * 与 core.basebandOptions() 的 dvbStandards / modcod 两个字段同形，故合并层可原样替换旧的常量取法。
 */
function standardOptions(store) {
  const opts = [{ value: NONE_KEY, label: '自定义' }]
  for (const s of listStandards(store)) opts.push({ value: s.key, label: s.label })
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
  listStandards, storeFromList, standardOptions, modcodMap
}
