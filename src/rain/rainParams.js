// 雨衰计算 —— 扁平字段 schema（每行一个完整算例，通用于各类卫星）。
// 供通用表格组件 StationGrid 驱动，字段键与其消费口径一致：{ key, label, unit?, type, options?, city?, def?, auto? }
//   city:true   → 冻结的名称列（并启用 城市名→经纬度 选址）
//   auto:'rain' → 经纬度变更时自动填 R0.01；auto:'elev' → 自动填海拔
//
// 几何按轨道类型二选一（RainApp 的 orbitMode 决定）：
//   GEO  → 输入 GEO 轨位(satLon)，自动换算仰角(elevation 只读)
//   NGSO → 直接输入仰角(elevation)（任意非静止轨道通用）
// 计算结果（雨衰/G/T衰减/雨致XPD/合计衰减）作为**只读字段**并入表尾：可选中/复制、不可编辑，计算后回填。

import { halfStr } from '../shared/num.js'

// 字段字典
const F = {
  stationName: { key: 'stationName', label: '地球站', type: 'text', def: '北京', city: true },
  longitude: { key: 'longitude', label: '经度', unit: '°E', type: 'num', def: '116.4074' },
  latitude: { key: 'latitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042' },
  altitude: { key: 'altitude', label: '海拔', unit: 'm', type: 'num', def: '0', auto: 'elev' },
  satLon: { key: 'satLon', label: 'GEO轨位', unit: '°E', type: 'num', def: '130.5' },
  elevation: { key: 'elevation', label: '仰角', unit: '°', type: 'num', def: '' },
  frequency: { key: 'frequency', label: '频率', unit: 'GHz', type: 'num', def: '12.5' },
  polarization: { key: 'polarization', label: '极化', type: 'select', options: ['V', 'H', 'RHCP', 'LHCP'], def: 'RHCP' },
  antennaDiameter: { key: 'antennaDiameter', label: '天线口径', unit: 'm', type: 'num', def: '3.7' },
  antennaEfficiency: { key: 'antennaEfficiency', label: '天线效率', unit: '%', type: 'num', def: '60' },
  availability: { key: 'availability', label: '可用度', unit: '%', type: 'num', def: '99.9' },
  rainRate: { key: 'rainRate', label: 'R0.01%', unit: 'mm/h', type: 'num', def: '0', auto: 'rain' },
  systemNoiseTemp: { key: 'systemNoiseTemp', label: '系统噪温', unit: 'K', type: 'num', def: '120' },
  // 天空噪声须经馈线衰减才到接收机参考点 → 降雨噪声 ÷ 馈线线性损耗（与晴空噪温折算自洽）。填 0 = 不折算（SatMaster 口径）
  feederLoss: { key: 'feederLoss', label: '馈线损耗', unit: 'dB', type: 'num', def: '0.2' }
}

// 计算结果字段（只读并入表尾；result:true 供样式/序列化剥离；dl:true 仅下行有效）
const RESULT_FIELDS = [
  { key: 'rainAtten', label: '雨衰', unit: 'dB', type: 'num', def: '', result: true },
  { key: 'gtDegradation', label: 'G/T衰减', unit: 'dB', type: 'num', def: '', result: true, dl: true },
  { key: 'rainXPD', label: '雨致XPD', unit: 'dB', type: 'num', def: '', result: true },
  { key: 'totalAtten', label: '合计衰减', unit: 'dB', type: 'num', def: '', result: true }
]
export const RESULT_KEYS = RESULT_FIELDS.map((f) => f.key)

// 极化中文名（详情/导出用）
export const POL_LABEL = { V: '垂直 (V)', H: '水平 (H)', RHCP: '右旋圆极化 (RHCP)', LHCP: '左旋圆极化 (LHCP)', C: '圆极化 (C)' }

// 按轨道类型组装字段集：GEO=[轨位,仰角]，NGSO=[仰角]
export function rainFields(orbitMode) {
  const geom = orbitMode === 'ngso' ? [F.elevation] : [F.satLon, F.elevation]
  return [
    F.stationName, F.longitude, F.latitude, F.altitude,
    ...geom,
    F.frequency, F.polarization, F.antennaDiameter, F.antennaEfficiency,
    F.availability, F.rainRate, F.systemNoiseTemp, F.feederLoss,
    ...RESULT_FIELDS
  ]
}

// 全部字段键（含两种几何 + 结果）——默认行 / 序列化用
const ALL_KEYS = [...new Set([...rainFields('geo').map((f) => f.key)])]

// 默认行对象（含所有可能键）
export function defaultRow() {
  const o = {}
  for (const f of rainFields('geo')) o[f.key] = f.def
  return o
}

// 行对象 → core.calculateRainAttenuation 入参。数值字段先经 halfStr 归一（防全角减号吞负数）。
// opts.direction：'up'|'down'；opts.orbitMode：'geo'|'ngso'（NGSO 不传 satLon，仰角为唯一几何）。
export function buildRainCase(row, opts) {
  opts = opts || {}
  const n = (v) => { const x = parseFloat(halfStr(v)); return Number.isFinite(x) ? x : undefined }
  const polRaw = String(row.polarization || 'RHCP').toUpperCase()
  const pol = (polRaw === 'RHCP' || polRaw === 'LHCP' || polRaw === 'C') ? 'C' : polRaw   // 圆极化统一按 C 送引擎
  let satLon
  if (opts.orbitMode !== 'ngso') {
    const raw = row.satLon
    satLon = (raw === '' || raw === null || raw === undefined) ? undefined : n(raw)
  }
  return {
    stationName: row.stationName,
    lat: n(row.latitude),
    lon: n(row.longitude),
    altitude: n(row.altitude),
    elevation: n(row.elevation),
    satLon,
    freq: n(row.frequency),
    pol,
    polDisplay: polRaw,
    diameter: n(row.antennaDiameter),
    efficiency: n(row.antennaEfficiency),
    availability: n(row.availability),
    rainRate: n(row.rainRate),
    systemNoiseTemp: n(row.systemNoiseTemp),
    feederLoss: n(row.feederLoss),
    direction: opts.direction === 'up' ? 'up' : 'down'
  }
}

export { ALL_KEYS }
