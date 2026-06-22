import { defineStore } from 'pinia'

export const useNavStore = defineStore('nav', {
  state: () => ({
    current: 'globe3d',
    pages: [
      { key: 'link', label: '链路预算', mark: '▦' },
      { key: 'constellation', label: '星座地图', mark: '◍' },
      { key: 'globe3d', label: '星座3D', mark: '◐' },
      { key: 'isl', label: '星间链路', mark: '⟁' },
      { key: 'configs', label: '配置管理', mark: '▥' },
      { key: 'history', label: '历史记录', mark: '☷' },
      { key: 'settings', label: '设置', mark: '⚙' }
    ]
  }),
  actions: {
    setCurrent(key) {
      this.current = key
    }
  }
})
