// 地球站库旧配置迁移（GEO / NGSO / 再生式链路预算共用）。
// 地球站库上线前，站表逐行携带射频参数（天线口径/效率、功放回退、馈线、UPC、噪温、干扰项…）；
// 上线后这些字段移入「地球站配置」，站表只留站址列 + 配置选择列(stationId)。
//
// 一份配置 = 一座站 = 一面天线：口径等「公共字段」(esCommonFields，含 rxKey 映射) 收发共用。
// 迁移规则：发/收两侧各自对射频值组合去重；发侧组合依次与「公共字段（口径）相同」的收侧组合
// 并成一份配置，配不上的各自成份（缺的一侧补字段默认值）。行上写回 stationId 引用、剥离旧射频键——
// 每一侧的数值逐行原样保留（含显式空值 = 引擎默认回退语义），不丢不改。
// 常见旧配置全表同参：收发口径相同（如再生式 2.4/2.4）迁出一份「默认」；不同（如 GEO 发 6.2/收 3.7）
// 迁出「站型1(发)+站型2(收)」两份，与「一份配置一面天线」的新模型自洽。
import { stableStringify } from './configDirty.js'

// 入参：txRows/rxRows = 待迁移的原始站行数组（可空）；esTxFields/esRxFields/esCommonFields = 该模块
// 地球站库的发/收/公共字段声明（params.js 的 ES_TX_FIELDS / ES_RX_FIELDS / ES_COMMON_FIELDS，
// 公共字段带 rxKey = 旧收侧行键名，如 antennaDiameter↔rxAntennaDiameter）；makeId = 配置 id 工厂
// （调用方须保证确定性——同一份内容反复迁移得同一批 id，见各 App applyState）。
// 返回 null = 行内无任何旧射频键（已是新结构或空表，无需迁移）；否则返回
// { esConfigs: [{id,name,form}], txRows, rxRows }（行为剥离射频键 + 挂 stationId 后的新数组）。
export function migrateLegacyEs({ txRows, rxRows, esTxFields, esRxFields, esCommonFields = [], makeId }) {
  const txKeys = new Set([...esTxFields.map((f) => f.key), ...esCommonFields.map((f) => f.key)])
  const rxKeys = new Set([...esRxFields.map((f) => f.key), ...esCommonFields.map((f) => f.rxKey || f.key)])
  const hasLegacy = (rows, keys) => (rows || []).some((r) => r && [...keys].some((k) => r[k] !== undefined))
  if (!hasLegacy(txRows, txKeys) && !hasLegacy(rxRows, rxKeys)) return null

  // 一侧的射频值组合去重：行缺某字段（更老版本保存）按字段默认值对待——与 applyState 的
  // { ...defaultsFor(FIELDS), ...row } 补默认口径一致，迁移前后取值语义不变。
  // 公共字段的取值键按侧映射（发侧 f.key / 收侧 f.rxKey），组合内统一存于规范键 f.key。
  const comboVal = (r, key, def) => ((r && r[key] !== undefined) ? r[key] : def)
  const sideCombos = (rows, fields, commonKeyOf) => {
    const list = []
    const idxByFp = new Map()
    const assign = []
    for (const r of rows || []) {
      const o = {}
      for (const f of esCommonFields) o[f.key] = comboVal(r, commonKeyOf(f), f.def)
      for (const f of fields) o[f.key] = comboVal(r, f.key, f.def)
      const fp = stableStringify(o)
      let i = idxByFp.get(fp)
      if (i === undefined) { i = list.length; idxByFp.set(fp, i); list.push(o) }
      assign.push(i)
    }
    return { list, assign }
  }
  const defaultsOf = (fields) => { const o = {}; for (const f of fields) o[f.key] = f.def; return o }

  const t = sideCombos(txRows, esTxFields, (f) => f.key)
  const x = sideCombos(rxRows, esRxFields, (f) => f.rxKey || f.key)
  const commonEq = (a, b) => esCommonFields.every((f) => String(a[f.key]) === String(b[f.key]))

  // 配对：发侧组合按序找首个未占用且公共字段相同的收侧组合（确定性——顺序遍历、先到先得）
  const pairOfTx = new Array(t.list.length).fill(-1)
  const usedRx = new Array(x.list.length).fill(false)
  for (let i = 0; i < t.list.length; i++) {
    for (let j = 0; j < x.list.length; j++) {
      if (!usedRx[j] && commonEq(t.list[i], x.list[j])) { pairOfTx[i] = j; usedRx[j] = true; break }
    }
  }
  const baseForm = () => ({ ...defaultsOf(esCommonFields), ...defaultsOf(esTxFields), ...defaultsOf(esRxFields) })
  const esConfigs = []
  const txCfg = new Array(t.list.length)   // 发侧组合 → 配置下标
  const rxCfg = new Array(x.list.length)   // 收侧组合 → 配置下标
  for (let i = 0; i < t.list.length; i++) {
    const j = pairOfTx[i]
    txCfg[i] = esConfigs.length
    if (j >= 0) rxCfg[j] = esConfigs.length
    esConfigs.push({ id: makeId(), form: { ...baseForm(), ...t.list[i], ...(j >= 0 ? x.list[j] : null) } })
  }
  for (let j = 0; j < x.list.length; j++) {
    if (usedRx[j]) continue
    rxCfg[j] = esConfigs.length
    esConfigs.push({ id: makeId(), form: { ...baseForm(), ...x.list[j] } })
  }
  if (!esConfigs.length) esConfigs.push({ id: makeId(), form: baseForm() })
  esConfigs.forEach((c, i) => { c.name = esConfigs.length === 1 ? '默认' : ('站型' + (i + 1)) })

  // 行剥离旧射频键并挂配置引用
  const strip = (rows, keys, assign, cfgIdx) => (rows || []).map((r, ri) => {
    const o = {}
    for (const k of Object.keys(r || {})) if (!keys.has(k)) o[k] = r[k]
    const c = esConfigs[cfgIdx[assign[ri]]]
    o.stationId = (c && c.id) || ''
    return o
  })
  return { esConfigs, txRows: strip(txRows, txKeys, t.assign, txCfg), rxRows: strip(rxRows, rxKeys, x.assign, rxCfg) }
}
