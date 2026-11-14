import { ref, watch } from 'vue'

// 地图级显隐覆盖：同一颗星来自多个卫星集或聚焦层时，隐藏一次即可，不移除目录或组成员。
const KEY = 'map-hidden-satellites-v1'
let saved = []
try { const value = JSON.parse(localStorage.getItem(KEY) || '[]'); if (Array.isArray(value)) saved = value.filter((id) => typeof id === 'string' && id) } catch { /* 默认全部可见 */ }
export const hiddenMapSatellites = ref([...new Set(saved)])
let hiddenSet = new Set(hiddenMapSatellites.value)
export const mapSatelliteHidden = (id) => {
  const list = hiddenMapSatellites.value
  return list.length > 0 && hiddenSet.has(id)
}
export function setMapSatelliteHidden(id, hide) {
  if (!id) return
  const next = new Set(hiddenMapSatellites.value)
  if (hide) next.add(id); else next.delete(id)
  hiddenSet = next
  hiddenMapSatellites.value = [...next]
}
export function showHiddenMapSatellites() {
  hiddenSet = new Set()
  hiddenMapSatellites.value = []
}
watch(hiddenMapSatellites, (ids) => {
  hiddenSet = new Set(ids)
  try { localStorage.setItem(KEY, JSON.stringify(ids)) } catch { /* 本次使用仍有效 */ }
}, { flush: 'sync' })
