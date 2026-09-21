// 日凌预报 —— 扁平字段 schema + 全局量的默认 / 规范化 / 引擎入参组装（纯逻辑，不碰 DOM）。
// 站表供通用表格组件 StationGrid 驱动，字段键与其消费口径一致：
//   { key, label, unit?, type, options?, city?, def?, ro?, group? }
//   city:true → 名称列自带「导入站址」CityPicker
//   ro:true   → 计算列：值走 extraValues 映射，不写回行、不进撤销与存档
//
// 全局量（一份配置一颗星、一个年份、一套判据）不进表，由窗口持有：
//   卫星（定轨轨位 / 星历根数）· 年份 · 分点多选 · 判据（恶化门限 dB / 纯几何）· T_sun 覆盖
// 引擎入参在 buildSpec 里组装 —— 出 IPC 的一律是纯数据（Vue Proxy 过不了结构化克隆）。

import { halfStr } from '../shared/num.js'

// 频段默认（freq = 典型下行频率 GHz，日凌影响接收链路；sysTemp = 典型系统噪温 K，仅作未填时的兜底）。
// ★ 这是引擎 BAND_PARAMS 的 ESM 镜像，两处改动须同步 —— packages/core/test/sunParams.test.mjs
//   用 createRequire 读引擎那张表逐键比对，漏同步立刻红。
// 引擎表里还有 ExtKu（与 Ku 只差 5 K），本表不列：两档并存只是徒增一列选项，引擎侧保留不动。
export const BAND_DEFAULTS = {
  C: { freq: 3.95, sysTemp: 65 },
  Ku: { freq: 12.50, sysTemp: 150 },
  Ka: { freq: 19.45, sysTemp: 270 },
  Q: { freq: 40.00, sysTemp: 450 }
}
export const BAND_KEYS = ['C', 'Ku', 'Ka', 'Q']
export const bandOf = (k) => BAND_DEFAULTS[k] || BAND_DEFAULTS.Ku

export const SEASONS = ['vernal', 'autumnal']
export const SEASON_CN = { vernal: '春分', autumnal: '秋分' }
// 取星来源标签（Word 参数表 / Excel 表题 / 读数行共用；第三档留给将来的外部星历文件）
export const SAT_SOURCE_LABEL = { slot: '定轨', ephemeris: '星历', ephemFile: '星历文件' }

// 分点多选归一：保持 春分 → 秋分 的固定顺序，非法值剔除。
// ★ 空数组被拒（回落两季）：一个分点都不选算不出任何东西，界面上也点不到那一步（最后一枚不响应）。
export function normSeasons(v) {
  const want = Array.isArray(v) ? v : []
  const out = SEASONS.filter((s) => want.includes(s))
  return out.length ? out : SEASONS.slice()
}

// ── 站表字段字典 ──────────────────────────────────────────────────────────
const F = {
  stationName: { key: 'stationName', label: '地球站', type: 'text', def: '北京', city: true, group: 'site' },
  longitude: { key: 'longitude', label: '经度', unit: '°E', type: 'num', def: '116.4074', group: 'site' },
  latitude: { key: 'latitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042', group: 'site' },
  band: { key: 'band', label: '频段', type: 'select', options: BAND_KEYS, def: 'Ku', group: 'ant' },
  frequency: {
    key: 'frequency', label: '频率', unit: 'GHz', type: 'num', def: '', group: 'ant',
    title: '接收频率（日凌影响接收链路）。留空按频段典型下行值：C 3.95 / Ku 12.5 / Ka 19.45 / Q 40 GHz'
  },
  diameter: { key: 'diameter', label: '口径', unit: 'm', type: 'num', def: '2.4', group: 'ant' },
  sysTemp: {
    key: 'sysTemp', label: 'T_sys', unit: 'K', type: 'num', def: '', group: 'rx',
    title: '系统噪声温度（晴空）：天线噪温 + LNA/LNB 噪温，折算到 LNA 输入端，即 G/T 中的 T，决定日凌恶化深度。留空按频段典型值：C 65 / Ku 150 / Ka 270 / Q 450 K'
  }
}

// 两层表头的列组（与雨衰页 / 链路表同一套分区语言）
export const GRID_GROUPS = [
  { key: 'site', label: '站址' },
  { key: 'ant', label: '天线' },
  { key: 'rx', label: '接收' },
  { key: 'res', label: '计算结果' }
]

const INPUT_FIELDS = [F.stationName, F.longitude, F.latitude, F.band, F.frequency, F.diameter, F.sysTemp]

// 计算结果列（ro:true）。季列只在该季被选时出现 —— 故字段集是随 seasons 变的 computed。
const RES_COMMON = [
  { key: 'satAz', label: '方位', unit: '°', type: 'num', def: '', result: true, ro: true, group: 'res', digits: 2 },
  { key: 'satEl', label: '仰角', unit: '°', type: 'num', def: '', result: true, ro: true, group: 'res', digits: 2 },
  { key: 'thresholdAngle', label: '门限角', unit: '°', type: 'num', def: '', result: true, ro: true, group: 'res', digits: 3 }
]
const RES_SEASON = {
  vernal: [
    { key: 'vDays', label: '春分·天数', type: 'num', def: '', result: true, ro: true, group: 'res', digits: 0 },
    { key: 'vMax', label: '春分·单日最长', unit: 'min', type: 'num', def: '', result: true, ro: true, group: 'res', digits: 1 }
  ],
  autumnal: [
    { key: 'aDays', label: '秋分·天数', type: 'num', def: '', result: true, ro: true, group: 'res', digits: 0 },
    { key: 'aMax', label: '秋分·单日最长', unit: 'min', type: 'num', def: '', result: true, ro: true, group: 'res', digits: 1 }
  ]
}

export function sunFields(seasons) {
  const res = RES_COMMON.slice()
  for (const s of normSeasons(seasons)) res.push(...RES_SEASON[s])
  return INPUT_FIELDS.concat(res)
}

// 全部结果列键与小数位（回填时按 key 取）
const ALL_RES = RES_COMMON.concat(RES_SEASON.vernal, RES_SEASON.autumnal)
export const RESULT_KEYS = ALL_RES.map((f) => f.key)
export const RESULT_DIGITS = Object.fromEntries(ALL_RES.map((f) => [f.key, f.digits == null ? 2 : f.digits]))
// 站表存档只留输入列
export const INPUT_KEYS = INPUT_FIELDS.map((f) => f.key)

// 默认行（结果列是计算列，不进行数据）
export function defaultRow() {
  const o = {}
  for (const f of INPUT_FIELDS) o[f.key] = f.def
  return o
}

const isBlank = (v) => v == null || String(v).trim() === ''
const DEFAULTS = Object.fromEntries(INPUT_FIELDS.map((f) => [f.key, f.def]))

/**
 * 行对象 → 实际入算的行：留空列按该列 def 回退；频率 / T_sys 留空按【该行频段】的典型值回退。
 * 表里灰着显示的那个值，就是留空时真正拿去计算的值（雨衰页口径）；频率与 T_sys 的默认随频段走，
 * 故灰字占位给不出来，改由列 title 写明，Excel 导出与 Word 参数表则照实写回退后的值。
 */
export function effectiveRow(row) {
  const o = { ...(row || {}) }
  for (const k of INPUT_KEYS) if (isBlank(o[k])) o[k] = DEFAULTS[k]
  const bd = bandOf(o.band)
  if (isBlank(row && row.frequency)) o.frequency = String(bd.freq)
  if (isBlank(row && row.sysTemp)) o.sysTemp = String(bd.sysTemp)
  return o
}

/**
 * 行 + 全局量 → 引擎入参（纯数据，structuredClone 安全）。
 * globals：{ satSource:'slot'|'ephemeris', slotLon, orbit, year, seasons, criterion:{mode,degDb,solarTemp} }
 * ★ 给了 orbit 就走星历档、satLon 让位；两者都不给由引擎报错，不在这里编数。
 */
export function buildSpec(row, globals) {
  const g = globals || {}
  const e = effectiveRow(row)
  const n = (v) => { const x = parseFloat(halfStr(v)); return Number.isFinite(x) ? x : undefined }
  const c = g.criterion || {}
  const spec = {
    lat: n(e.latitude),
    lon: n(e.longitude),
    diameter: n(e.diameter),
    band: e.band,
    customFreq: n(e.frequency),
    sysTemp: n(e.sysTemp),
    year: parseInt(String(halfStr(g.year)), 10),
    seasons: normSeasons(g.seasons),
    criterion: c.mode === 'geometric' ? 'geometric' : 'degradation',
    degThreshold: n(c.degDb) > 0 ? n(c.degDb) : 1
  }
  const ts = n(c.solarTemp)
  if (ts > 0) spec.solarTemp = ts
  if (g.satSource === 'ephemeris' && g.orbit) spec.orbit = JSON.parse(JSON.stringify(g.orbit))
  else spec.satLon = n(g.slotLon)
  return spec
}

/**
 * 分点时刻的近似（Meeus Ch.27 的 JDE0 均值式，不含 Table 27.C 的周期修正 —— 误差 < 0.02 天）。
 * 只给读数行的「距分点 n 天」用；真正定窗的分点由引擎按完整式算，两者不共用。
 */
export function equinoxApproxMs(year, season) {
  const Y = (Number(year) - 2000) / 1000
  if (!Number.isFinite(Y)) return NaN
  const jde = season === 'vernal'
    ? 2451623.80984 + 365242.37404 * Y + 0.05169 * Y * Y - 0.00411 * Y * Y * Y - 0.00057 * Y * Y * Y * Y
    : 2451810.21715 + 365242.01767 * Y - 0.11575 * Y * Y + 0.00337 * Y * Y * Y + 0.00078 * Y * Y * Y * Y
  return (jde - 2440587.5) * 86400e3
}

// ── 卫星别名 ──────────────────────────────────────────────────────────────
// CelesTrak 把中星编目成 ZHONGXING-6C / ZHONGXING-10R（少数叫 CHINASAT 9B / CHINASAT 16 (SJ-13)），
// 而 satPresets 里全是 CHINASAT n。搜「中星 6C」「CHINASAT 6C」「ZHONGXING-6C」都要命中同一条，
// 预设与池记录规范化名相同也要合并（池记录优先）—— 靠下面这张表与两个规范化函数。
export const SAT_ALIASES = [
  { zh: '中星', en: ['CHINASAT', 'ZHONGXING'] },
  { zh: '亚太', en: ['APSTAR'] },
  { zh: '亚洲卫星', en: ['ASIASAT'] },
  { zh: '天通', en: ['TIANTONG'] }
]

/** 规范化名：大写、去括注、ZHONGXING- → CHINASAT、折叠分隔符为单空格 */
export function normSatName(s) {
  let t = String(s == null ? '' : s).toUpperCase()
  t = t.replace(/[（(][^）)]*[）)]/g, ' ')            // 去括注：CHINASAT 16 (SJ-13) → CHINASAT 16
  t = t.replace(/ZHONGXING[-\s_]*/g, 'CHINASAT ')
  t = t.replace(/[\s\-_]+/g, ' ').trim()
  return t
}
/** 紧凑名（连空格也去掉）：用于「中星6C」这类不带空格的查询 */
export const tightName = (s) => normSatName(s).replace(/\s+/g, '')

/** 查询词扩展：中英互通（中星/CHINASAT/ZHONGXING 等价，亚太/APSTAR 同理） */
export function expandQuery(q) {
  const raw = String(q == null ? '' : q).trim()
  if (!raw) return []
  const up = raw.toUpperCase()
  const out = new Set([up])
  for (const a of SAT_ALIASES) {
    const all = [a.zh, ...a.en]
    for (const k of all) {
      const K = k.toUpperCase()
      if (up.includes(K)) for (const t of all) out.add(up.split(K).join(t.toUpperCase()))
    }
  }
  return [...out]
}

/** 一条候选是否命中查询：名称 / 别名 / 预设名 / NORAD / 组标签，中英别名互通、紧凑名兜底 */
export function matchSat(rec, q) {
  const qs = expandQuery(q)
  if (!qs.length || !rec) return false
  const hay = [rec.name, rec.altName, rec.presetName, rec.noradId, rec.groupLabel]
    .filter((x) => x != null && x !== '').map(String)
  if (!hay.length) return false
  const tight = hay.map(tightName)
  for (const x of qs) {
    const xu = x.toUpperCase()
    if (hay.some((h) => h.toUpperCase().includes(xu))) return true
    const xt = tightName(x)
    if (xt && tight.some((h) => h.includes(xt))) return true
  }
  return false
}

// ── 配置 state ────────────────────────────────────────────────────────────
export const ORBIT_TYPE = 'SUN'
// 星历内嵌配置的字节上限：OMM / elements 都远小于此；超了只存引用（本期不会出现，见任务书 §12）
export const ORBIT_INLINE_MAX = 4096

export function blankState() {
  return {
    orbitType: ORBIT_TYPE,
    name: '',
    sat: { name: 'CHINASAT 6C', noradId: '', source: 'slot', slotLon: '130.5', orbit: null, epoch: '', inclDeg: null, groupLabel: '' },
    year: String(new Date().getFullYear()),
    seasons: SEASONS.slice(),
    criterion: { mode: 'degradation', degDb: '1', solarTemp: '' },
    stations: [defaultRow()]
  }
}

const str = (v, d = '') => (v == null ? d : String(v))

/**
 * 任意来源的 state → 规范化 state（幂等：normState(normState(x)) 与 normState(x) 逐键相同）。
 * 载入旧配置、恢复工作状态、存盘前都走它，于是「序列化 → 载入 → 再序列化」指纹必然相等。
 */
export function normState(st) {
  const s = (st && typeof st === 'object') ? st : {}
  const b = blankState()
  const sat = (s.sat && typeof s.sat === 'object') ? s.sat : {}
  const cr = (s.criterion && typeof s.criterion === 'object') ? s.criterion : {}
  // orbit 原样保留（含将来的 { type, ref } 引用形状，不解析）；只做纯数据化
  let orbit = null
  if (sat.orbit && typeof sat.orbit === 'object') {
    try { orbit = JSON.parse(JSON.stringify(sat.orbit)) } catch { orbit = null }
  }
  const source = (sat.source === 'ephemeris' && orbit) ? 'ephemeris' : 'slot'
  const rows = Array.isArray(s.stations) ? s.stations : []
  return {
    orbitType: ORBIT_TYPE,
    name: str(s.name),
    sat: {
      name: str(sat.name, b.sat.name),
      noradId: str(sat.noradId),
      source,
      slotLon: str(sat.slotLon, b.sat.slotLon),
      orbit,
      epoch: str(sat.epoch),
      inclDeg: Number.isFinite(Number(sat.inclDeg)) && sat.inclDeg !== null && sat.inclDeg !== '' ? Number(sat.inclDeg) : null,
      groupLabel: str(sat.groupLabel)
    },
    year: str(s.year, b.year),
    seasons: normSeasons(s.seasons),
    criterion: {
      mode: cr.mode === 'geometric' ? 'geometric' : 'degradation',
      degDb: str(cr.degDb, b.criterion.degDb),
      solarTemp: str(cr.solarTemp)
    },
    // 行里只留输入列（结果列是计算列、从不入档），缺的键一律空串 —— 空＝入算时按 effectiveRow 回退
    stations: (rows.length ? rows : [defaultRow()]).map((r) => {
      const o = {}
      for (const k of INPUT_KEYS) o[k] = str(r && r[k] != null ? r[k] : '')
      return o
    })
  }
}
