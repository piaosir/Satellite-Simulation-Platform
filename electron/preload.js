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
    // 批量版：[{ sat, link, opt }] → 各行结果数组（口径同单条，只把 N 次往返压成 1 次）
    computeModeBatch: (list) => ipcRenderer.invoke('link:computeModeBatch', list),
    // 参数扫描（可视化直角坐标系）：一次 IPC 跑完整段区间，回全部可绘输出量
    sweep: (spec) => ipcRenderer.invoke('link:sweep', spec),
    // 二维参数扫描（设计空间图）：x×y 网格一次跑完，回各输出量的场与可行裕度场
    sweep2D: (spec) => ipcRenderer.invoke('link:sweep2D', spec),
    outputDefs: () => ipcRenderer.invoke('link:outputDefs'),
    // NGSO：计算方式求解（切 NGSO 引擎、强制 ISL=0）+ 站星互视最差几何求解
    computeModeNGSO: (s, l, opt) => ipcRenderer.invoke('link:computeModeNGSO', s, l, opt),
    // 批量版（整表几何一次求 / 一组候选一次算）：口径与单条完全一致，只把 N 次往返压成 1 次
    computeModeNGSOBatch: (s, list, opt) => ipcRenderer.invoke('link:computeModeNGSOBatch', s, list, opt),
    // 再生式上行：计算方式求解（合计 C/N = 上行 C/(N+I)）+ 复用 NGSO 站星几何
    computeRegenUplink: (s, l, opt) => ipcRenderer.invoke('link:computeRegenUplink', s, l, opt),
    // 再生式下行：计算方式求解（合计 C/N = 下行 C/(N+I)；工作点 = 收信站 G/T）+ 复用 NGSO 站星几何
    computeRegenDownlink: (s, l, opt) => ipcRenderer.invoke('link:computeRegenDownlink', s, l, opt),
    // 再生式星间：计算（合计 C/N = 星间单跳 C/N；发射卫星 EIRP + 接收卫星 G/T）+ 两星几何求解
    computeRegenIsl: (s, l, opt) => ipcRenderer.invoke('link:computeRegenIsl', s, l, opt),
    // 再生式星间激光：第一性原理光学预算（P_rx 链 + 光子/bit 灵敏度）；几何复用 islGeometry（传光频算相干多普勒）
    computeRegenLaser: (p, opt) => ipcRenderer.invoke('link:computeRegenLaser', p, opt),
    // 端到端链路（多跳 / 混合转发）：整条链一次算完（分段 + 段内级联 + 端到端汇总）
    chainCompute: (chain) => ipcRenderer.invoke('link:chainCompute', chain),
    islGeometry: (opt) => ipcRenderer.invoke('link:islGeometry', opt),
    // 星间距离时间序列（时间轴上逐拍的星间距离/掠地高度/互视）：手动几何下「星间链路距离」工具用
    islRangeSeries: (opt) => ipcRenderer.invoke('link:islRangeSeries', opt),
    ngsoGeometry: (opt) => ipcRenderer.invoke('link:ngsoGeometry', opt),
    ngsoGeometryBatch: (opt) => ipcRenderer.invoke('link:ngsoGeometryBatch', opt),
    accessWindows: (opt) => ipcRenderer.invoke('link:accessWindows', opt),
    geoFill: (lat, lon) => ipcRenderer.invoke('link:geoFill', lat, lon),
    grdSample: (req) => ipcRenderer.invoke('link:grdSample', req),
    // 干扰分析用：逐波束值（少量站点）/ C/CCI 合成（整张场图，主进程内折成标量）
    grdSampleBeams: (req) => ipcRenderer.invoke('link:grdSampleBeams', req),
    grdSampleXpd: (req) => ipcRenderer.invoke('link:grdSampleXpd', req),
    grdSampleCci: (req) => ipcRenderer.invoke('link:grdSampleCci', req),
    // 导入方向图后取其波束数（并预编译 .grdbin）
    grdMeta: (file) => ipcRenderer.invoke('link:grdMeta', file),
    cities: () => ipcRenderer.invoke('link:cities'),
    searchCities: (kw) => ipcRenderer.invoke('link:searchCities', kw),
    baseband: () => ipcRenderer.invoke('link:baseband'),
    waterfall: (ctx) => ipcRenderer.invoke('link:waterfall', ctx),
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
  // 端到端链路预算独立窗口的开窗/关窗守卫（计算走 linkBudget.chainCompute，几何全部手填）
  e2e: {
    open: () => ipcRenderer.invoke('e2e:open'),
    onCloseRequested: (cb) => ipcRenderer.on('e2e:closeRequested', cb),
    confirmClose: () => ipcRenderer.invoke('e2e:confirmClose')
  },
  sunOutage: {
    open: () => ipcRenderer.invoke('suntool:open'),
    compute: (p) => ipcRenderer.invoke('sunoutage:compute', p),
    exportWord: (payload) => ipcRenderer.invoke('sunoutage:exportWord', payload),
    exportIcs: (payload) => ipcRenderer.invoke('sunoutage:exportIcs', payload)
  },
  // 干扰分析（C/I）独立窗口：C/ASI 邻星 · C/XPI 交叉极化 · C/CCI 同频复用 · NGSO 时变 CDF。
  // 纯只读——读三库（store.getLibrary）与 GRD（linkBudget.grd*），不写回任何库。
  // 站址联动 / 城市选址复用链路预算的 link:* 通道；出图走通用 exportFile。
  interference: {
    open: () => ipcRenderer.invoke('ci:open'),
    asi: (req) => ipcRenderer.invoke('ci:asi', req),
    xpi: (req) => ipcRenderer.invoke('ci:xpi', req),
    xpiTerm: (req) => ipcRenderer.invoke('ci:xpiTerm', req),
    cciPoint: (req) => ipcRenderer.invoke('ci:cciPoint', req),
    // NGSO 时变扫描：start 只负责启动，进度/结果经下面两个订阅推回（长任务不阻塞窗口）
    ngsoEstimate: (req) => ipcRenderer.invoke('ci:ngsoEstimate', req),
    ngsoStart: (req) => ipcRenderer.invoke('ci:ngsoStart', req),
    ngsoCancel: () => ipcRenderer.invoke('ci:ngsoCancel'),
    onNgsoProgress: (cb) => ipcRenderer.on('ci:ngsoProgress', (_e, p) => cb(p)),
    onNgsoDone: (cb) => ipcRenderer.on('ci:ngsoDone', (_e, p) => cb(p)),
    // 星历接入：复用平台既有星座数据，邻星轨位与 NGSO 星座都不必手抄
    groups: () => ipcRenderer.invoke('ci:groups'),
    // satIds 仅「我的卫星组」（sg:）需要、sats 仅「自定义星座」（cc:）需要：这两类都存在渲染端
    // localStorage，主进程看不到，成员 NORAD / 逐颗六根数一律由调用方带上
    loadGroup: (g, online, satIds, sats) => ipcRenderer.invoke('ci:loadGroup', g, online, satIds, sats),
    geoNeighbors: (req) => ipcRenderer.invoke('ci:geoNeighbors', req)
  },
  // 雨衰计算独立窗口（通用于各类卫星）：批量/单算例/曲线计算 + Excel 导出；
  // 经纬度自动填(降雨率/海拔)与城市选址复用链路预算的 link:* 通道；PNG 导出走通用 exportFile。
  rainAttenuation: {
    open: () => ipcRenderer.invoke('rain:open'),
    compute: (p) => ipcRenderer.invoke('rain:compute', p),
    computeBatch: (cases) => ipcRenderer.invoke('rain:computeBatch', cases),
    solveMultiSite: (cases, opt) => ipcRenderer.invoke('rain:solveMultiSite', cases, opt),
    sweep: (p, axis, range) => ipcRenderer.invoke('rain:sweep', p, axis, range),
    exportExcel: (payload) => ipcRenderer.invoke('rain:exportExcel', payload),
    geoFill: (lat, lon) => ipcRenderer.invoke('link:geoFill', lat, lon),
    cities: () => ipcRenderer.invoke('link:cities'),
    searchCities: (kw) => ipcRenderer.invoke('link:searchCities', kw),
    onCloseRequested: (cb) => ipcRenderer.on('rain:closeRequested', cb),
    confirmClose: () => ipcRenderer.invoke('rain:confirmClose')
  },
  // 环境场图层（主窗口「环境场」视图）：ITU 环境数据整张等经纬栅格一次取回（Float32Array 直传）
  env: {
    defs: () => ipcRenderer.invoke('env:defs'),
    field: (key, opt) => ipcRenderer.invoke('env:field', key, opt)
  },
  app: {
    deviceId: () => ipcRenderer.invoke('app:deviceId'),
    version: () => ipcRenderer.invoke('app:version')
  },
  // 激活状态（终端设备侧）：status 读本地缓存（快，不碰网络）；refresh 立即心跳 + 拉最新激活书；
  // onChanged 订阅主进程定时心跳发现的状态变化（管理端激活/撤销最迟一跳自动生效）
  activation: {
    status: () => ipcRenderer.invoke('activation:status'),
    refresh: () => ipcRenderer.invoke('activation:refresh'),
    onChanged: (cb) => ipcRenderer.on('activation:changed', (_e, st) => cb(st))
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
    gxtSnapshot: (payload) => ipcRenderer.invoke('share:gxtSnapshot', payload),
    // 同一条通道的通名（putSnapshot 本就与内容语义无关，只是 PUT 一份 JSON）：
    // 覆盖快照 kind='gxt-snapshot'、链路配置/频率计划 kind='satsim-pack'（见 shared/miniPack.js）。
    // 主进程处理器不必改，故这里只是别名；老名保留，3D 页那条路一个字不动。
    putPack: (payload) => ipcRenderer.invoke('share:gxtSnapshot', payload),
    // 绑定投递（免密钥）：往小程序端的认证码信箱直投。密钥模式照旧并存 —— 绑定给常用的人，
    // 密钥给客户/临时协作。o = { pid, label, app, sync, name, payload }
    boxSend: (ch, o) => ipcRenderer.invoke('share:boxSend', ch, o),
    boxPeek: (ch, pid) => ipcRenderer.invoke('share:boxPeek', ch, pid),
    boxRevoke: (ch, pid, mid) => ipcRenderer.invoke('share:boxRevoke', ch, pid, mid)
  },
  store: {
    listHistory: () => ipcRenderer.invoke('store:history:list'),
    addHistory: (r) => ipcRenderer.invoke('store:history:add', r),
    deleteHistory: (id) => ipcRenderer.invoke('store:history:delete', id),
    clearHistory: () => ipcRenderer.invoke('store:history:clear'),
    // 配置库：首参一律是工作台命名空间 ns（geo/ngso/regen/e2e/rain），各窗只读写自己那份
    listConfigs: (ns) => ipcRenderer.invoke('store:config:list', ns),
    listAllConfigs: () => ipcRenderer.invoke('store:config:listAll'),
    saveConfig: (ns, cfg) => ipcRenderer.invoke('store:config:save', { ns, cfg }),
    deleteConfig: (ns, id) => ipcRenderer.invoke('store:config:delete', { ns, id }),
    reorderConfigs: (ns, ids) => ipcRenderer.invoke('store:config:reorder', { ns, ids }),
    // 展开 payload 而不是嵌一层：它常常是渲染端的响应式对象，展开后进 IPC 的是纯数据（结构化克隆过不了 Proxy）
    moveItem: (ns, payload) => ipcRenderer.invoke('store:config:move', { ns, ...payload }),
    deleteFolder: (ns, id) => ipcRenderer.invoke('store:config:deleteFolder', { ns, id }),
    getSettings: () => ipcRenderer.invoke('store:settings:get'),
    setSettings: (s) => ipcRenderer.invoke('store:settings:set', s),
    // 链路预算全局资源库（地球站/卫星/载波），按体制命名空间 geo/ngso/regen 整读整写
    getLibrary: (ns) => ipcRenderer.invoke('store:library:get', ns),
    saveLibrary: (ns, data) => ipcRenderer.invoke('store:library:save', { ns, data })
  },
  report: {
    export: (payload) => ipcRenderer.invoke('report:export', payload),
    // 交付级链路预算报告：一次调用出 .xlsx / .pdf（同名同目录），模型见 src/shared/lbReport.js
    exportReport: (payload) => ipcRenderer.invoke('report:exportReport', payload)
  },
  // 报告打印页（src/report.html，隐藏窗口）专用：取模型 + 回告排版完成
  reportPrint: {
    model: () => ipcRenderer.invoke('report:print:model'),
    ready: () => ipcRenderer.send('report:print:ready')
  },
  // 通用表格 ⇄ Excel：模型进、工作簿出；导入回 { sheets:[{ name, rows }] }，列匹配在渲染端
  gridXlsx: {
    export: (payload) => ipcRenderer.invoke('grid:exportXlsx', payload),
    import: (opt) => ipcRenderer.invoke('grid:importXlsx', opt)
  },
  // 覆盖图导出：保存二进制（PNG/PDF）到用户选定路径 / 读取系统字体（PDF 嵌入用：TNR 西文 + 中文面）
  exportFile: (payload) => ipcRenderer.invoke('file:save', payload),
  // PFD Mask 生成（ITU-R S.1503）：参数进、XML 文本与统计出；落盘走 exportFile / exportFiles
  pfdMask: { open: () => ipcRenderer.invoke('pfd:open') },
  pfdGenerate: (params) => ipcRenderer.invoke('pfd:generate', params),
  // 批量落盘到一个目录（mask 分文件 + 参数存档）
  exportFiles: (payload) => ipcRenderer.invoke('file:saveMany', payload),
  pdfFonts: () => ipcRenderer.invoke('font:pdf'),
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
    customGroupRecords: (groupId) => ipcRenderer.invoke('omm:customGroupRecords', groupId),
    customImport: () => ipcRenderer.invoke('omm:customImport'),
    customRemove: (groupId) => ipcRenderer.invoke('omm:customRemove', groupId),
    customRename: (groupId, name) => ipcRenderer.invoke('omm:customRename', groupId, name),
    customExportGroup: (groupId, defaultName) => ipcRenderer.invoke('omm:customExportGroup', groupId, defaultName),
    exportOmmCsv: (records, defaultName) => ipcRenderer.invoke('omm:exportOmmCsv', records, defaultName),
    // 星历取数链路的操作明细（主进程广播）→ 底部「日志」窗格；{ text, level }
    onLog: (cb) => ipcRenderer.on('omm:log', (_e, p) => cb(p))
  },
  // 转发器频率计划：挂在卫星下、与 GRD 天线平级的一类「文件」。
  // 主进程只负责存取与原生对话框，模型/校验/容量/出图全在渲染端 src/shared/freqPlan*.js。
  freqPlan: {
    open: (planId) => ipcRenderer.invoke('freqPlan:open', planId),
    list: () => ipcRenderer.invoke('freqPlan:list'),
    get: (id) => ipcRenderer.invoke('freqPlan:get', id),
    // opts.updateOnly：只更新索引里已有的计划，不许新建（编辑窗的自动存盘用）
    save: (plan, opts) => ipcRenderer.invoke('freqPlan:save', plan, opts),
    remove: (id) => ipcRenderer.invoke('freqPlan:remove', id),
    rename: (id, name) => ipcRenderer.invoke('freqPlan:rename', id, name),
    reassignSat: (folder, patch) => ipcRenderer.invoke('freqPlan:reassignSat', folder, patch),
    exportFile: (kind, payload, defaultName) => ipcRenderer.invoke('freqPlan:export', kind, payload, defaultName),
    importJson: () => ipcRenderer.invoke('freqPlan:importJson'),
    onOpenPlan: (cb) => ipcRenderer.on('freqPlan:openPlan', (_e, id) => cb(id)),
    // 文件区删/改名的广播（编辑窗手里那份可能就是它）
    onPlanRemoved: (cb) => ipcRenderer.on('freqPlan:planRemoved', (_e, id) => cb(id)),
    onPlanRenamed: (cb) => ipcRenderer.on('freqPlan:planRenamed', (_e, id, name) => cb(id, name))
  },
  coverage: {
    index: () => ipcRenderer.invoke('coverage:index'),
    get: (file) => ipcRenderer.invoke('coverage:get', file)
  },
  coverageGrd: {
    index: () => ipcRenderer.invoke('coverageGrd:index'),
    get: (file) => ipcRenderer.invoke('coverageGrd:get', file),
    open: () => ipcRenderer.invoke('coverageGrd:open'),
    // 链路预算侧导入：主进程直接拷贝文件，只回 { base, file }（不搬文本）
    import: () => ipcRenderer.invoke('coverageGrd:import'),
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
