import { computed, ref } from 'vue'
import { byLang } from '../../shared/i18n/lang.js'

export function usePerfTableCatalog() {
  // The original table keeps its antenna key so existing settings and open windows still resolve.
  const entries = ref([])
  const index = computed(() => new Map(entries.value.map(t => [t.kind + ':' + t.id, t])))
  const baseName = kind => kind === 'shell' ? byLang('对星性能指标表', 'Sat-to-Sat Performance Table') : byLang('性能指标表', 'Performance Table')
  const entry = (kind, id) => index.value.get(kind + ':' + id)
  const nameOf = (kind, id) => entry(kind, id)?.name || baseName(kind)
  const parents = computed(() => new Map(entries.value.filter(t => t.id !== t.antenna).map(t => [t.id, t.antenna])))
  const antennaOf = id => parents.value.get(id) || id
  // Old snapshots have no entry for the default table. Only an explicit deletion hides it.
  const has = (kind, id) => {
    const t = entry(kind, id)
    return t ? !t.deleted : typeof id === 'string' && id.includes('|')
  }

  function list(kind, antenna) {
    const first = entry(kind, antenna) || { id: antenna, kind, antenna, name: baseName(kind) }
    const children = entries.value.filter(t => t.kind === kind && t.antenna === antenna && t.id !== antenna)
    return first.deleted ? children : [first, ...children]
  }
  function add(kind, antenna) {
    const siblings = list(kind, antenna)
    const names = new Set(siblings.map(t => t.name))
    let n = siblings.length + 1
    while (names.has(baseName(kind) + ' ' + n)) n++
    const id = crypto.randomUUID()
    entries.value.push({ kind, antenna, id, name: siblings.length ? baseName(kind) + ' ' + n : baseName(kind) })
    return id
  }
  function rename(kind, id, value) {
    const name = value.trim()
    if (!name || !has(kind, id)) return
    const t = entry(kind, id)
    if (t) t.name = name
    else entries.value.push({ kind, antenna: id, id, name })
  }
  function remove(kind, id) {
    if (!has(kind, id)) return false
    const antenna = antennaOf(id)
    entries.value = entries.value.filter(t => t.kind !== kind || t.id !== id)
    if (id === antenna) entries.value.push({ kind, antenna, id, name: '', deleted: true })
    return true
  }
  function moveAntenna(from, to) {
    for (const t of entries.value) if (t.antenna === from) {
      t.antenna = to
      if (t.id === from) t.id = to
    }
  }
  function removeAntenna(key) { entries.value = entries.value.filter(t => t.antenna !== key) }
  function restore(data) {
    entries.value = (Array.isArray(data) ? data : []).filter(t => t && ['ground', 'shell'].includes(t.kind)
      && typeof t.antenna === 'string' && typeof t.id === 'string' && typeof t.name === 'string').map(t => ({ ...t }))
  }
  return { entries, list, has, add, rename, remove, nameOf, antennaOf, moveAntenna, removeAntenna, restore }
}
