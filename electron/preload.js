const { contextBridge, ipcRenderer } = require('electron')

// 安全桥：渲染进程通过 window.api.* 调用主进程能力，不直接暴露 Node。
contextBridge.exposeInMainWorld('api', {
  computeLink: (s, l) => ipcRenderer.invoke('link:compute', s, l),
  computeLinkNGSO: (s, l) => ipcRenderer.invoke('link:computeNGSO', s, l),
  satelliteAngle: (lat, lon, satLon) => ipcRenderer.invoke('link:angle', lat, lon, satLon),
  store: {
    listHistory: () => ipcRenderer.invoke('store:history:list'),
    addHistory: (r) => ipcRenderer.invoke('store:history:add', r),
    deleteHistory: (id) => ipcRenderer.invoke('store:history:delete', id),
    clearHistory: () => ipcRenderer.invoke('store:history:clear'),
    listConfigs: () => ipcRenderer.invoke('store:config:list'),
    saveConfig: (c) => ipcRenderer.invoke('store:config:save', c),
    deleteConfig: (id) => ipcRenderer.invoke('store:config:delete', id),
    getSettings: () => ipcRenderer.invoke('store:settings:get'),
    setSettings: (s) => ipcRenderer.invoke('store:settings:set', s)
  },
  report: {
    export: (payload) => ipcRenderer.invoke('report:export', payload)
  },
  omm: {
    load: (group, online) => ipcRenderer.invoke('omm:load', group, online),
    positions: (group, iso) => ipcRenderer.invoke('omm:positions', group, iso),
    csv: (group) => ipcRenderer.invoke('omm:csv', group)
  },
  coverage: {
    index: () => ipcRenderer.invoke('coverage:index'),
    get: (file) => ipcRenderer.invoke('coverage:get', file)
  },
  coverageGrd: {
    index: () => ipcRenderer.invoke('coverageGrd:index'),
    get: (file) => ipcRenderer.invoke('coverageGrd:get', file),
    open: () => ipcRenderer.invoke('coverageGrd:open')
  },
  platform: process.platform
})
