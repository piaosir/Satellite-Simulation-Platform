// 展示分类与存储类型分开；用途汇总目录按需取数，不改变具体星座的归属。
export const REFERENCE_GROUPS = [
  { key: 'gnss', label: 'GNSS 导航卫星' },
  { key: 'weather', label: '气象卫星' },
  { key: 'earth-resources', label: '地球资源观测卫星' },
  { key: 'sar', label: '合成孔径雷达（SAR）' },
  { key: 'science', label: '空间与地球科学卫星' },
  { key: 'amateur', label: '业余无线电卫星' }
]
const REFERENCE_KEYS = new Set(REFERENCE_GROUPS.map((g) => g.key))
export const SET_SECTIONS = [
  { id: 'custom', title: '自建星座', icon: 'orbit', tip: '轨道向导生成的星座；可编辑轨道参数', add: 'wizard' },
  { id: 'group', title: '卫星分组', icon: 'layers', tip: '按成员收藏的卫星集合；可包含来自不同星座的卫星', add: 'group' },
  { id: 'import', title: '导入星历', icon: 'file-import', tip: '从文件导入的轨道根数或位置序列', add: 'import' },
  { id: 'builtin', title: '内置星座', icon: 'satellite', tip: '按星座划分的 CelesTrak 星历' },
  { id: 'tree', title: '场景卫星', icon: 'earth', tip: '卫星天线树中的卫星；成员在天线树中管理' },
  { id: 'catalog', title: '目录参考', icon: 'globe', tip: '按轨道或对象类型汇总的目录；与上方星座可能包含同一颗卫星' }
]
const CATALOG_IDS = new Set(['g:all', 'g:geo', 'g:other', 'g:stations', ...REFERENCE_GROUPS.map((g) => 'g:' + g.key)])
export const builtinSetLabel = (key, fallback) => ({ all: '全量卫星目录', geo: '地球静止轨道（GEO）', other: '其他星座（内置大型星座以外）' }[key] || fallback)
// 全量池沿用基础星座 + GEO + 空间站 + active；新增用途分类不参与开机全量下载及互斥归类。
export const isUniverseGroup = (key) => !['all', 'other', 'none', 'custom'].includes(key) && !REFERENCE_KEYS.has(key)
export const isNamedConstellation = (key) => isUniverseGroup(key) && !['geo', 'stations'].includes(key)
export const sectionOf = (row) => CATALOG_IDS.has(row.id) ? 'catalog' : row.kind
export function sectionsOf(rows) {
  return SET_SECTIONS.map((section) => ({ ...section, rows: rows.filter((row) => sectionOf(row) === section.id) })).filter((section) => section.rows.length)
}
