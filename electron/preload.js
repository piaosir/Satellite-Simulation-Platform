const { contextBridge, ipcRenderer } = require('electron')

// 安全桥：渲染进程通过 window.api.* 调用主进程能力，不直接暴露 Node。
contextBridge.exposeInMainWorld('api', {
  computeLink: (s, l) => ipcRenderer.invoke('link:compute', s, l),
  computeLinkNGSO: (s, l) => ipcRenderer.invoke('link:computeNGSO', s, l),
  satelliteAngle: (lat, lon, satLon) => ipcRenderer.invoke('link:angle', lat, lon, satLon),
  linkBudget: {
    open: () => ipcRenderer.invoke('linkbudget:open'),
    compute: (s, l) => ipcRenderer.invoke('link:compute', s, l),
    computeMode: (s, l, opt) => ipcRenderer.invoke('link:computeMode', s, l, opt),
    geoFill: (lat, lon) => ipcRenderer.invoke('link:geoFill', lat, lon),
    grdSample: (req) => ipcRenderer.invoke('link:grdSample', req),
    cities: () => ipcRenderer.invoke('link:cities'),
    searchCities: (kw) => ipcRenderer.invoke('link:searchCities', kw),
    baseband: () => ipcRenderer.invoke('link:baseband'),
    waterfall: (ctx) => ipcRenderer.invoke('link:waterfall', ctx),
    exportExcel: (payload) => ipcRenderer.invoke('linkbudget:exportExcel', payload),
    openConfig: () => ipcRenderer.invoke('linkbudget:openConfig'),
    // 关窗守卫：主进程拦截原生关闭动作后转发此事件；渲染进程问完用户再调 confirmClose() 才真正关闭
    onCloseRequested: (cb) => ipcRenderer.on('linkbudget:closeRequested', cb),
    confirmClose: () => ipcRenderer.invoke('linkbudget:confirmClose')
  },
  sunOutage: {
    open: () => ipcRenderer.invoke('suntool:open'),
    compute: (p) => ipcRenderer.invoke('sunoutage:compute', p),
    exportWord: (payload) => ipcRenderer.invoke('sunoutage:exportWord', payload),
    exportIcs: (payload) => ipcRenderer.invoke('sunoutage:exportIcs', payload)
  },
  app: {
    deviceId: () => ipcRenderer.invoke('app:deviceId'),
    version: () => ipcRenderer.invoke('app:version')
  },
  share: {
    configured: () => ipcRenderer.invoke('share:configured'),
    send: (recipientId, payload) => ipcRenderer.invoke('share:send', recipientId, payload),
    inbox: (myId) => ipcRenderer.invoke('share:inbox', myId),
    remove: (myId, id) => ipcRenderer.invoke('share:delete', myId, id)
  },
  store: {
    listHistory: () => ipcRenderer.invoke('store:history:list'),
    addHistory: (r) => ipcRenderer.invoke('store:history:add', r),
    deleteHistory: (id) => ipcRenderer.invoke('store:history:delete', id),
    clearHistory: () => ipcRenderer.invoke('store:history:clear'),
    listConfigs: () => ipcRenderer.invoke('store:config:list'),
    saveConfig: (c) => ipcRenderer.invoke('store:config:save', c),
    deleteConfig: (id) => ipcRenderer.invoke('store:config:delete', id),
    reorderConfigs: (ids) => ipcRenderer.invoke('store:config:reorder', ids),
    getSettings: () => ipcRenderer.invoke('store:settings:get'),
    setSettings: (s) => ipcRenderer.invoke('store:settings:set', s)
  },
  report: {
    export: (payload) => ipcRenderer.invoke('report:export', payload)
  },
  // 覆盖图导出：保存二进制（PNG/PDF）到用户选定路径 / 读取系统中文字体（PDF 嵌入用）
  exportFile: (payload) => ipcRenderer.invoke('file:save', payload),
  cjkFont: () => ipcRenderer.invoke('font:cjk'),
  omm: {
    load: (group, online) => ipcRenderer.invoke('omm:load', group, online),
    positions: (group, iso) => ipcRenderer.invoke('omm:positions', group, iso),
    csv: (group, opts) => ipcRenderer.invoke('omm:csv', group, opts),
    list: () => ipcRenderer.invoke('omm:list'),
    import: (key) => ipcRenderer.invoke('omm:import', key),
    export: (key) => ipcRenderer.invoke('omm:export', key)
  },
  coverage: {
    index: () => ipcRenderer.invoke('coverage:index'),
    get: (file) => ipcRenderer.invoke('coverage:get', file)
  },
  coverageGrd: {
    index: () => ipcRenderer.invoke('coverageGrd:index'),
    get: (file) => ipcRenderer.invoke('coverageGrd:get', file),
    open: () => ipcRenderer.invoke('coverageGrd:open'),
    save: (name, text) => ipcRenderer.invoke('coverageGrd:save', name, text),
    raw: (file) => ipcRenderer.invoke('coverageGrd:raw', file),
    remove: (file) => ipcRenderer.invoke('coverageGrd:remove', file)
  },
  coverageGxt: {
    index: () => ipcRenderer.invoke('coverageGxt:index'),
    get: (file) => ipcRenderer.invoke('coverageGxt:get', file),
    raw: (file) => ipcRenderer.invoke('coverageGxt:raw', file),
    open: () => ipcRenderer.invoke('coverageGxt:open'),
    addSat: (name, lon) => ipcRenderer.invoke('coverageGxt:addSat', name, lon),
    renameSat: (satId, name) => ipcRenderer.invoke('coverageGxt:renameSat', satId, name),
    removeSat: (satId) => ipcRenderer.invoke('coverageGxt:removeSat', satId),
    ensureSat: (name, lon) => ipcRenderer.invoke('coverageGxt:ensureSat', name, lon),
    hidePreset: (kind, key) => ipcRenderer.invoke('coverageGxt:hidePreset', kind, key),
    unhidePreset: (kind, key) => ipcRenderer.invoke('coverageGxt:unhidePreset', kind, key),
    addBeam: (satId, name, type, band) => ipcRenderer.invoke('coverageGxt:addBeam', satId, name, type, band),
    renameBeam: (satId, beamId, name) => ipcRenderer.invoke('coverageGxt:renameBeam', satId, beamId, name),
    removeBeam: (satId, beamId) => ipcRenderer.invoke('coverageGxt:removeBeam', satId, beamId),
    attach: (satId, beamId, payload) => ipcRenderer.invoke('coverageGxt:attach', satId, beamId, payload),
    importBatch: (items) => ipcRenderer.invoke('coverageGxt:importBatch', items)
  },
  platform: process.platform
})
