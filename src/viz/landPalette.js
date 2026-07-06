// 陆地配色单一来源（3D 球体 globe3d/scene.js 与 2D 平面图 flatmap/flatCoverage.js 共用，替代原双份硬编码）。
// 两层取值：基调方案（'morandi' 杂色循环 / '#rrggbb' 统一单色）+ 用户逐国覆盖（优先级最高）。
// 状态为模块级单例：设置一次后，两渲染器建图（buildLandMesh / buildBaseGeo）时自然读到同一份。
import { CHINA_IDS } from './globe3d/cnClaims.js'

// 莫兰迪 12 色循环板（'morandi' 基调的默认杂色）
export const LAND = ['#8fa89b', '#b0a98f', '#9fb0c0', '#c0a99f', '#a9b08f', '#9f9fb0', '#b8a0a0', '#90b0a8', '#b0b090', '#a0a8b8', '#bca890', '#98a0a8']
// 定向覆盖（按 ISO 数字码）：'morandi' 基调下指定国家固定取色板内某成员（美国偏蓝、尼日利亚偏绿）
export const LAND_OVERRIDE = { '840': '#9fb0c0', '566': '#8fa89b' }
export const CHINA = '#b85a52'   // 中国底色：降低饱和度的砖红（仅 'morandi' 基调；统一单色基调下随基调色）
export const ICE = '#edf2f6'     // 极地冰盖：白色填充（格陵兰 304、南极 010）
export const ICE_IDS = new Set(['304', '010'])
// 北极岛屿冰盖：质心纬度 ≥ ARCTIC_ISLAND_LAT 的「整块多边形」染冰白（加拿大北极群岛/俄罗斯北极诸岛/斯瓦尔巴等）；
// 各大陆与阿拉斯加/冰岛（质心 <65°）保持普通陆地色。
export const ARCTIC_ISLAND_LAT = 70

// 统一单色基调预设（地图设置「大地颜色」色块顺序即此）：首个为 SATSOFT 米绿，其余为纸图系浅色
export const LAND_UNIFORMS = ['#e4eccf', '#e8e0c9', '#dcd6c0', '#ccd6c0', '#d6cfc4', '#ccd2d8', '#f0ead9']
// 默认基调：统一米黄（LAND_UNIFORMS[1]）。改默认时须与 ConstellationMap3D 的 landScheme 初值联动（同一常量）
export const LAND_DEFAULT = '#e8e0c9'

const HEX6 = /^#[0-9a-fA-F]{6}$/
let scheme = LAND_DEFAULT   // 'morandi' 或 '#rrggbb'（统一单色）
let overrides = {}       // 逐国覆盖：ISO 数字码 → '#rrggbb'（台湾并入中国，键统一为 '156'）

export function setLandPalette(s) {
  scheme = (s && (s.scheme === 'morandi' || HEX6.test(s.scheme))) ? s.scheme : LAND_DEFAULT
  overrides = {}
  if (s && s.overrides && typeof s.overrides === 'object') {
    for (const [id, c] of Object.entries(s.overrides)) if (HEX6.test(c)) overrides[id] = c
  }
}
export function getLandPalette() { return { scheme, overrides: { ...overrides } } }

const ovKey = (id) => (CHINA_IDS.has(id) ? '156' : id)

// 国家用色：{ base: 常规多边形填色, arctic: 高纬(≥ARCTIC_ISLAND_LAT)多边形填色 }。
// 用户逐国覆盖 → 整国（含高纬岛屿）用同一用户色，行为可预期；
// 'morandi' 基调：中国=砖红、冰盖国/高纬岛屿=冰白、其余按定向覆盖/循环板；
// 统一单色基调：全部陆地（含中国、格陵兰/南极冰盖、北极高纬岛屿）一律取基调色（对齐 SATSOFT 整图一色）。
export function landColors(id, idx) {
  const user = overrides[ovKey(id)]
  if (user) return { base: user, arctic: user }
  if (scheme !== 'morandi') return { base: scheme, arctic: scheme }
  const base = ICE_IDS.has(id) ? ICE : CHINA_IDS.has(id) ? CHINA : (LAND_OVERRIDE[id] || LAND[idx % LAND.length])
  return { base, arctic: ICE }
}
