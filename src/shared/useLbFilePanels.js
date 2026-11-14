import { ref, watch } from 'vue'

// 文件区的两个侧栏独立开关；首次升级沿用旧的单栏显示状态。
export function useLbFilePanels(ns) {
  const legacy = localStorage.getItem(`${ns}/sideView`)
  const configsDefault = legacy === 'configs' || (legacy !== 'library' && legacy !== '' && localStorage.getItem(`${ns}/configsCollapsed`) !== '1')
  const readVisible = (name, fallback) => {
    const saved = localStorage.getItem(`${ns}/${name}Visible`)
    return saved === '1' ? true : saved === '0' ? false : fallback
  }
  const showConfigs = ref(readVisible('configs', configsDefault))
  const showLibrary = ref(readVisible('library', legacy === 'library'))
  for (const [name, visible] of [['configs', showConfigs], ['library', showLibrary]]) {
    watch(visible, (value) => {
      try { localStorage.setItem(`${ns}/${name}Visible`, value ? '1' : '0') } catch { /* ignore */ }
    }, { flush: 'sync' })
  }
  function toggleSide(name) {
    const visible = name === 'library' ? showLibrary : showConfigs
    visible.value = !visible.value
  }
  return { showConfigs, showLibrary, toggleSide }
}
