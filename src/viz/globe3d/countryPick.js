// 经纬度 → 国家（右键地图「设置此国大地颜色」用）。
// 射线判定与经度解缠已挪进主权解算层（src/viz/geo/povResolver.js 的 ownerAt）—— 底图画成什么样、
// 点到的就是什么国，两边不再各写一份判定，也不会因视角/用户覆写而对不上。
import { ownerAt, resolvedFeatures, labelSet } from '../geo/povResolver.js'
import { landColors } from '../landPalette.js'

// 返回 { id, zh }（id = 归属 ISO3，台湾/港澳恒为 'CHN'）；不在任何单元内返回 null。
export function countryAt(lon, lat) {
  const r = ownerAt(lon, lat)
  return r ? { id: r.owner, zh: r.zh || r.en || r.owner } : null
}

// 归属 → 建图取色序号：与 resolvedFeatures 给出的 idx 同源，故取色器预填与地图上的颜色一致。
// 视角/覆写改动后 resolvedFeatures 会重算，这里的缓存跟着按解算结果的长度失效（够用且零耦合）。
let idxOf = null, idxN = -1
function ensureIdx() {
  const feats = resolvedFeatures()
  if (idxOf && idxN === feats.length) return idxOf
  idxOf = new Map()
  for (const f of feats) if (!idxOf.has(f.id)) idxOf.set(f.id, f.idx != null ? f.idx : 0)
  idxN = feats.length
  return idxOf
}

// 国家当前实际底色（设置面板取色器预填用）
export function currentLandColor(id) {
  const m = ensureIdx()
  return landColors(id, m.has(id) ? m.get(id) : 0).base
}

// 可搜索国家清单（逐国设色的下拉）：口径与地图上的国名标注完全一致 ——
// 有中文名、且当前视角下确实作为一个国家画出来的那些。台湾/港澳并入中国，不单列。
export function countryList() {
  return labelSet('zh').map((l) => ({ id: l.owner, zh: l.zh, en: l.en }))
    .sort((a, b) => a.zh.localeCompare(b.zh, 'zh-Hans-CN'))
}
