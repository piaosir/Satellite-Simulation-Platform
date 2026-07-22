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
    // NGSO：计算方式求解（切 NGSO 引擎、强制 ISL=0）+ 站星互视最差几何求解
    computeModeNGSO: (s, l, opt) => ipcRenderer.invoke('link:computeModeNGSO', s, l, opt),
    // 再生式上行：计算方式求解（合计 C/N = 上行 C/(N+I)）+ 复用 NGSO 站星几何
    computeRegenUplink: (s, l, opt) => ipcRenderer.invoke('link:computeRegenUplink', s, l, opt),
    // 再生式下行：计算方式求解（合计 C/N = 下行 C/(N+I)；工作点 = 收信站 G/T）+ 复用 NGSO 站星几何
    computeRegenDownlink: (s, l, opt) => ipcRenderer.invoke('link:computeRegenDownlink', s, l, opt),
    // 再生式星间：计算（合计 C/N = 星间单跳 C/N；发射卫星 EIRP + 接收卫星 G/T）+ 两星几何求解
    computeRegenIsl: (s, l, opt) => ipcRenderer.invoke('link:computeRegenIsl', s, l, opt),
    // 再生式星间激光：第一性原理光学预算（P_rx 链 + 光子/bit 灵敏度）；几何复用 islGeometry（传光频算相干多普勒）
    computeRegenLaser: (p, opt) => ipcRenderer.invoke('link:computeRegenLaser', p, opt),
    islGeometry: (opt) => ipcRenderer.invoke('link:islGeometry', opt),
    ngsoGeometry: (opt) => ipcRenderer.invoke('link:ngsoGeometry', opt),
    accessWindows: (opt) => ipcRenderer.invoke('link:accessWindows', opt),
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
  // NGSO 链路预算独立窗口的开窗/关窗守卫（计算/几何/导出/城市等能力复用上面的 linkBudget.*）
  ngso: {
    open: () => ipcRenderer.invoke('ngso:open'),
    onCloseRequested: (cb) => ipcRenderer.on('ngso:closeRequested', cb),
    confirmClose: () => ipcRenderer.invoke('ngso:confirmClose')
  },
  // 再生式链路预算独立窗口的开窗/关窗守卫（计算复用 linkBudget.computeRegenUplink / 几何复用 ngsoGeometry）
  regen: {
    open: () => ipcRenderer.invoke('regen:open'),
    onCloseRequested: (cb) => ipcRenderer.on('regen:closeRequested', cb),
    confirmClose: () => ipcRenderer.invoke('regen:confirmClose')
  },
  sunOutage: {
    open: () => ipcRenderer.invoke('suntool:open'),
    compute: (p) => ipcRenderer.invoke('sunoutage:compute', p),
    exportWord: (payload) => ipcRenderer.invoke('sunoutage:exportWord', payload),
    exportIcs: (payload) => ipcRenderer.invoke('sunoutage:exportIcs', payload)
  },
  // 雨衰计算独立窗口（通用于各类卫星）：批量/单算例/曲线计算 + Excel 导出；
  // 经纬度自动填(降雨率/海拔)与城市选址复用链路预算的 link:* 通道；PNG 导出走通用 exportFile。
  rainAttenuation: {
    open: () => ipcRenderer.invoke('rain:open'),
    compute: (p) => ipcRenderer.invoke('rain:compute', p),
    computeBatch: (cases) => ipcRenderer.invoke('rain:computeBatch', cases),
    sweep: (p, axis, range) => ipcRenderer.invoke('rain:sweep', p, axis, range),
    exportExcel: (payload) => ipcRenderer.invoke('rain:exportExcel', payload),
    geoFill: (lat, lon) => ipcRenderer.invoke('link:geoFill', lat, lon),
    cities: () => ipcRenderer.invoke('link:cities'),
    searchCities: (kw) => ipcRenderer.invoke('link:searchCities', kw),
    onCloseRequested: (cb) => ipcRenderer.on('rain:closeRequested', cb),
    confirmClose: () => ipcRenderer.invoke('rain:confirmClose')
  },
  app: {
    deviceId: () => ipcRenderer.invoke('app:deviceId'),
    version: () => ipcRenderer.invoke('app:version')
  },
  // 主窗口自定义标题栏：把原生窗口控制按钮（Windows 覆盖式）的配色更新为当前主题色
  win: {
    setOverlay: (opt) => ipcRenderer.invoke('window:setOverlay', opt)
  },
  share: {
    configured: () => ipcRenderer.invoke('share:configured'),
    send: (recipientId, payload) => ipcRenderer.invoke('share:send', recipientId, payload),
    inbox: (myId) => ipcRenderer.invoke('share:inbox', myId),
    remove: (myId, id) => ipcRenderer.invoke('share:delete', myId, id),
    // 发送到小程序：把当前绘制状态快照上传 COS，返回可在小程序输入的短密钥
    gxtSnapshot: (payload) => ipcRenderer.invoke('share:gxtSnapshot', payload)
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
    moveItem: (payload) => ipcRenderer.invoke('store:config:move', payload),
    deleteFolder: (id) => ipcRenderer.invoke('store:config:deleteFolder', id),
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
    export: (key) => ipcRenderer.invoke('omm:export', key),
    // 自定义卫星库（导入 OMM CSV / TLE，合并去重后持久化为一份 OMM CSV，贯通 3D 分组与搜索池）
    customList: () => ipcRenderer.invoke('omm:customList'),
    customCsv: () => ipcRenderer.invoke('omm:customCsv'),
    customImport: () => ipcRenderer.invoke('omm:customImport'),
    customRemove: (groupId) => ipcRenderer.invoke('omm:customRemove', groupId),
    customRename: (groupId, name) => ipcRenderer.invoke('omm:customRename', groupId, name),
    customExportGroup: (groupId, defaultName) => ipcRenderer.invoke('omm:customExportGroup', groupId, defaultName),
    exportOmmCsv: (records, defaultName) => ipcRenderer.invoke('omm:exportOmmCsv', records, defaultName)
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
  // 协调区 Polygon：原生框选 .gxt / .kml → 读原文交渲染进程解析导入
  poly: {
    open: () => ipcRenderer.invoke('poly:open')
  },
  platform: process.platform
})
