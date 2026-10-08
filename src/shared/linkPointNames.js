// 图上链路 · Polygon / 航迹代表点的叫法（星座 3D 主窗的取点编辑器 / 读数 与 四个计算窗「导入链路」对话框共用）。
// 候选点形状见 packages/core/models/mapLinkPoints.mjs（fam = 'c' | 'v' | 'd' | 'veh' | 'w'，i = 族内序号，sM = 沿迹里程 m）。
// 名字是数据（导入后成站名、写进配置），呈现层翻不到，故按当前平台语言现出字（同 shared/markerNames.js）。
//   短名（label）：取点编辑器的行、跳读数的最差点、支路名 —— 质心 · 顶点 3 · 边界 5 · 载具 · 航点 3 · 1,234 km
//   站名（name）：导入后的地球站名 —— 华东区·质心 · 华东区·顶点3 · 华东区·边界5 · 航行1·载具 · 航行1#3 · 航行1·1234 km
//     航点用「航迹名#序号」，与计算窗「导入站址」里航迹航点的叫法一致（序号 = 航迹表格行号）。
import { byLang } from './i18n/lang.js'

const km = (sM, sep) => {
  const v = Math.round((Number(sM) || 0) / 1000)
  return (sep ? v.toLocaleString('en-US') : String(v)) + ' km'
}

/** 代表点短名；kind = 'pg' | 'tj'（等分点两类叫法不同：Polygon 报序号、航迹报里程） */
export function linkPointLabel(kind, c) {
  if (!c) return ''
  switch (c.fam) {
    case 'c': return byLang('质心', 'Centroid')
    case 'v': return byLang(`顶点 ${c.i + 1}`, `Vertex ${c.i + 1}`)
    case 'veh': return byLang('载具', 'Vehicle')
    case 'w': return byLang(`航点 ${c.i + 1}`, `WP ${c.i + 1}`)
    case 'd': return kind === 'tj' ? km(c.sM, true) : byLang(`边界 ${c.i + 1}`, `Edge ${c.i + 1}`)
    default: return ''
  }
}
/** 代表点落成地面端时的站名：对象名 + 代表点（航点用「#序号」） */
export function linkPointName(objName, kind, c) {
  const o = String(objName == null ? '' : objName).trim() || (kind === 'pg' ? 'Polygon' : byLang('航迹', 'Track'))
  if (!c) return o
  if (c.fam === 'w') return `${o}#${c.i + 1}`
  const s = c.fam === 'd' && kind === 'tj' ? km(c.sM, false) : linkPointLabel(kind, c).replace(/ (?=\d)/g, byLang('', ' '))
  return `${o}·${s}`
}
/** 支路名里用的短名（紧凑：去掉序号前的空格） */
export function linkPointShort(kind, c) {
  if (!c) return ''
  if (c.fam === 'w') return '#' + (c.i + 1)
  if (c.fam === 'd' && kind === 'tj') return km(c.sM, false)
  return linkPointLabel(kind, c).replace(/ (?=\d)/g, byLang('', ' '))
}
