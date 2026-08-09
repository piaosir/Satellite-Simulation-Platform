// 雨衰计算 —— 扁平字段 schema（每行一个完整算例，通用于各类卫星）。
// 供通用表格组件 StationGrid 驱动，字段键与其消费口径一致：{ key, label, unit?, type, options?, city?, def?, auto? }
//   city:true   → 冻结的名称列（并启用 城市名→经纬度 选址）
//   auto:'rain' → 经纬度变更时自动填 R0.01；auto:'elev' → 自动填海拔
//
// 几何输入是**全局参数**（一颗星/一个星座对全表地球站），在工具栏填写、不进表（RainApp 持有）：
//   GEO  → 全局 GEO 轨位 → 各站仰角由引擎自动换算
//   NGSO → 全局 轨道高度 + 倾角 + 最低仰角，按 ITU-R P.618-14 §8 反解各站「等效仰角」
//          §8 = 仰角分箱 × 可见时间占比加权。直接填一个最低仰角是「最坏几何 × 最坏气象」的双重
//          最坏叠加，低纬多雨站可高估十几 dB —— 详见 packages/core/utils/ngsoElevStats.js
//
// 表内只留**雨衰**一列结果（本工具的主角），且只读、计算后回填。仰角 / G/T衰减 / 雨致XPD /
// 合计衰减 等派生量不再占列——它们在右侧「单算例分析」详情与 Excel 导出里都在，表格保持窄。

import { halfStr } from '../shared/num.js'

// 字段字典（group：两层表头的列组，与链路表同一套分区语言 —— 见 GRID_GROUPS）
const F = {
  stationName: { key: 'stationName', label: '地球站', type: 'text', def: '北京', city: true, group: 'site' },
  longitude: { key: 'longitude', label: '经度', unit: '°E', type: 'num', def: '116.4074', group: 'site' },
  latitude: { key: 'latitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042', group: 'site' },
  altitude: { key: 'altitude', label: '海拔', unit: 'm', type: 'num', def: '0', auto: 'elev', group: 'site' },
  frequency: { key: 'frequency', label: '频率', unit: 'GHz', type: 'num', def: '12.5', group: 'rf' },
  polarization: { key: 'polarization', label: '极化', type: 'select', options: ['V', 'H', 'RHCP', 'LHCP'], def: 'RHCP', group: 'rf' },
  antennaDiameter: { key: 'antennaDiameter', label: '天线口径', unit: 'm', type: 'num', def: '3.7', group: 'rf' },
  antennaEfficiency: { key: 'antennaEfficiency', label: '天线效率', unit: '%', type: 'num', def: '60', group: 'rf' },
  availability: { key: 'availability', label: '可用度', unit: '%', type: 'num', def: '99.9', group: 'met' },
  rainRate: { key: 'rainRate', label: 'R0.01%', unit: 'mm/h', type: 'num', def: '0', auto: 'rain', group: 'met' },
  systemNoiseTemp: { key: 'systemNoiseTemp', label: '系统噪温', unit: 'K', type: 'num', def: '120', group: 'rx' },
  // 天空噪声须经馈线衰减才到接收机参考点 → 降雨噪声 ÷ 馈线线性损耗（与晴空噪温折算自洽）。填 0 = 不折算（SatMaster 口径）
  feederLoss: { key: 'feederLoss', label: '馈线损耗', unit: 'dB', type: 'num', def: '0.2', group: 'rx' },

  // —— 多站总可用度专属列（只在「多站汇总」页签下入表，单算例模式下表不变宽）——
  attenBudget: {
    key: 'attenBudget', label: '可承受衰减', unit: 'dB', type: 'num', def: '', group: 'div',
    title: '该站链路能承受的衰减上限（反解可用度的门限，逐站可不同，取自你的链路预算结果）。它对标哪一项 —— 单独雨衰 / 气体+云+雨 / 下行总劣化 —— 在底栏「可承受衰减」下拉里选，三档差值可达 4 dB'
  }
}

// 两层表头的列组（对齐链路表「发信站 / 收信站 / 计算结果」的分区口径）：
// 分区不填底色，靠组末列的加深格线（--lb-rule）区分 —— 见 lbworkbench.css 里的说明
export const GRID_GROUPS = [
  { key: 'site', label: '站址' },
  { key: 'rf', label: '射频' },
  { key: 'met', label: '气象' },
  { key: 'rx', label: '接收' },
  { key: 'div', label: '多站' },
  { key: 'res', label: '计算结果' }
]

// 计算结果字段（入表尾）。ro:true = StationGrid 的「计算列」：值不存行数据、显示/复制一律取
// extraValues 映射（{行_id: {列key: 值}}）。这样结果不进撤销快照、不惊动存档/脏检/过期 watcher，
// 也不会因插行/删行/上下移动而与算例串位（与链路预算结果列同口径）。result:true 供序列化剥离旧存档。
// digits：结果列的小数位。★ 不能一刀切 2 位——可用度列 99.99% 与 99.999% 会显示成同一个数，
// 年停时 0.876 h 与 0.088 h 也压不住。缺省仍是 2 位。
const RESULT_FIELDS = [
  { key: 'rainAtten', label: '雨衰', unit: 'dB', type: 'num', def: '', result: true, ro: true, group: 'res' }
]
// 多站页签才入表的结果列（由「可承受衰减」反解而来，与上面那列不是一回事）
const DIVERSITY_RESULT_FIELDS = [
  {
    key: 'availSolved', label: '反解可用度', unit: '%', type: 'num', def: '', result: true, ro: true, group: 'res', digits: 5,
    title: '由「可承受衰减」经 ITU-R P.618-14 §2.2.3 标度式反解；定义域 0.001%~5%，域外钳端点并标色'
  },
  {
    key: 'downtimeH', label: '年停时', unit: 'h', type: 'num', def: '', result: true, ro: true, group: 'res', digits: 3,
    title: '该站单站年不可用时长（8766 h 基准）'
  }
]
export const RESULT_KEYS = RESULT_FIELDS.concat(DIVERSITY_RESULT_FIELDS).map((f) => f.key)
// 结果列的小数位查表（RainApp 回填时按 key 取；缺省 2 位）
export const RESULT_DIGITS = Object.fromEntries(
  RESULT_FIELDS.concat(DIVERSITY_RESULT_FIELDS).map((f) => [f.key, f.digits == null ? 2 : f.digits])
)

// 曾经进过表、现已移除的键——载入旧存档时清除，防其被序列化回新存档。
// （几何列上提为全局参数；仰角与三项派生结果收进详情/导出；
//   rainProb 随多站相关档移除、role 三档随之删除 —— 多站汇总为纯概率论口径，2026-08-10）
export const LEGACY_KEYS = [
  'satLon', 'orbitAltitude', 'orbitInclination', 'minElevation',
  'elevation', 'gtDegradation', 'rainXPD', 'totalAtten', 'rainProb', 'role'
]

// 极化中文名（详情/导出用）
export const POL_LABEL = { V: '垂直 (V)', H: '水平 (H)', RHCP: '右旋圆极化 (RHCP)', LHCP: '左旋圆极化 (LHCP)', C: '圆极化 (C)' }

// 字段集：几何已上提为全局（工具栏），派生结果收进详情 → 表内与轨道类型无关，两种模式同一套列。
// opt.diversity=true 时追加「多站」那一整块（可承受衰减 + 两个反解结果列）——
// 整块出现整块消失，不打散到各分区里，单算例模式下表不变宽。
export function rainFields(opt) {
  const base = [
    F.stationName, F.longitude, F.latitude, F.altitude,
    F.frequency, F.polarization, F.antennaDiameter, F.antennaEfficiency,
    F.availability, F.rainRate, F.systemNoiseTemp, F.feederLoss
  ]
  if (opt && opt.diversity) {
    // 「直接给可用度」时不出「可承受衰减」列：输入改由既有的『可用度』列承担（同一个物理量，
    // 不另立一列）；「反解可用度」结果列同样没意义——它就等于输入本身。需要的时候才出现。
    const byAvail = !!opt.byAvail
    const inCols = byAvail ? [] : [F.attenBudget]
    const resCols = byAvail
      ? DIVERSITY_RESULT_FIELDS.filter((f) => f.key !== 'availSolved')
      : DIVERSITY_RESULT_FIELDS
    return base.concat(inCols, RESULT_FIELDS, resCols)
  }
  return base.concat(RESULT_FIELDS)
}

// 全部字段键——默认行 / 序列化用（含多站列，否则它们存不进配置）
const ALL_KEYS = rainFields({ diversity: true }).map((f) => f.key)

// 默认行对象（结果列是计算列、不存行数据 → 不进默认行）
export function defaultRow() {
  const o = {}
  for (const f of rainFields({ diversity: true })) if (!f.result) o[f.key] = f.def
  return o
}

// 留空列的回退值：与 StationGrid 灰字占位（f.def）严格同一口径 —— 表里灰着显示的那个值，
// 就是留空时真正拿去计算的值。缺了这层，新增的空行会因「引擎自己的另一套默认」算出别的数
// （频率/经纬度更是直接报错 ✕），而表里却灰字写着 12.5 GHz / 北京坐标，看着就怪。
const DEFAULTS = Object.fromEntries(rainFields({ diversity: true }).filter((f) => !f.result).map((f) => [f.key, f.def]))
const pick = (row, key) => { const v = row[key]; return (v == null || String(v).trim() === '') ? DEFAULTS[key] : v }

// 行对象 → 实际入算的行（留空列填上默认值）。导出 Excel 用：表里灰着显示、按之计算的值，
// 报表里也要照实写出来，否则「输入列空着、结果列却有数」自相矛盾。
export function effectiveRow(row) {
  const o = { ...row }
  for (const k in DEFAULTS) o[k] = pick(row, k)
  return o
}

// 行对象 → core.calculateRainAttenuation 入参。数值字段先经 halfStr 归一（防全角减号吞负数）；
// 留空的列按 f.def 回退（见 DEFAULTS/pick，与表内灰字占位同口径）。
// opts：{ direction:'up'|'down', orbitMode:'geo'|'ngso', satLon, orbitAltKm, inclDeg, minElevDeg, elevation? }
//   几何是全局参数（工具栏），从 opts 注入：GEO 传 satLon（引擎自动换算仰角）；NGSO 传 ngsoStat +
//   轨道三要素，引擎按 ITU-R P.618-14 §8 反解等效仰角。
//   opts.elevation 是可选回灌：曲线面板拿算完的仰角标「当前取值点」用，计算时会被上述两条覆盖。
export function buildRainCase(row, opts) {
  opts = opts || {}
  const n = (v) => { const x = parseFloat(halfStr(v)); return Number.isFinite(x) ? x : undefined }
  const p = (key) => n(pick(row, key))          // 数值列：留空 → 按该列默认值（同表内灰字占位）
  const polRaw = String(pick(row, 'polarization') || 'RHCP').toUpperCase()
  const pol = (polRaw === 'RHCP' || polRaw === 'LHCP' || polRaw === 'C') ? 'C' : polRaw   // 圆极化统一按 C 送引擎
  const ngso = opts.orbitMode === 'ngso'
  const satLon = ngso ? undefined : n(opts.satLon)
  return {
    ngsoStat: ngso,
    orbitAltKm: ngso ? n(opts.orbitAltKm) : undefined,
    inclDeg: ngso ? n(opts.inclDeg) : undefined,
    minElevDeg: ngso ? n(opts.minElevDeg) : undefined,
    stationName: pick(row, 'stationName'),
    lat: p('latitude'),
    lon: p('longitude'),
    altitude: p('altitude'),
    elevation: n(opts.elevation),
    satLon,
    freq: p('frequency'),
    pol,
    polDisplay: polRaw,
    diameter: p('antennaDiameter'),
    efficiency: p('antennaEfficiency'),
    availability: p('availability'),
    rainRate: p('rainRate'),
    systemNoiseTemp: p('systemNoiseTemp'),
    feederLoss: p('feederLoss'),
    direction: opts.direction === 'up' ? 'up' : 'down',
    // 多站总可用度专属（单算例路径读不到这个键，引擎忽略即可）
    attenBudgetDb: p('attenBudget')
  }
}

export { ALL_KEYS }
