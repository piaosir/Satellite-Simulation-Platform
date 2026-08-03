const { ipcMain, dialog, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const createOmm = require('../services/omm')
const createCustomSats = require('../services/customSats')
const createInterference = require('../services/interference')

// 注册所有 IPC 处理器。core 为返回引擎实例的函数（延迟解析）。
function register({ core, storage, report, coverage, coverageGrd, coverageGxt, share, openLinkBudget, openSunOutage, grd, confirmCloseLinkBudget, openNgso, confirmCloseNgso, openRegen, confirmCloseRegen, openRain, confirmCloseRain, openCi, openPfd, freqPlan, openFreqPlan, notifyFreqPlan }) {
  const omm = createOmm(core)
  const customSats = createCustomSats(core)
  // grd 传进去是给 NGSO 时变的「卫星发射方向图取 GRD 实测图」用的（见 resolveSatPattern）
  const interference = createInterference(omm, customSats, core, grd)

  // 主窗口自定义标题栏：主题切换时把原生窗口控制按钮（Windows 覆盖式）的配色跟到当前主题。
  // 非覆盖式窗口（如各链路预算独立窗口）无 setTitleBarOverlay，静默忽略。
  ipcMain.handle('window:setOverlay', (e, opt) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || typeof win.setTitleBarOverlay !== 'function') return false
    try { win.setTitleBarOverlay(opt); return true } catch { return false }
  })
  ipcMain.handle('omm:load', (_e, group, online) => omm.load(group, online))
  ipcMain.handle('omm:positions', (_e, group, iso) => omm.positions(group, iso))
  ipcMain.handle('omm:csv', (_e, group, opts) => omm.fetchCsv(group, opts))

  // ---- 文件管理：OMM 星座组缓存的列举 / 导入替换 / 导出 ----
  ipcMain.handle('omm:list', () => omm.listCsv())
  // 导入并替换某组 OMM：原生选 .csv → 校验 → 覆盖缓存。返回 { ok, key, mtime, count } 或 { canceled }/{ ok:false, error }
  ipcMain.handle('omm:import', async (e, key) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: `导入 OMM 文件（替换「${key}」）`, properties: ['openFile'],
      filters: [{ name: 'CelesTrak OMM (*.csv)', extensions: ['csv'] }, { name: '所有文件', extensions: ['*'] }]
    })
    if (canceled || !filePaths || !filePaths.length) return { canceled: true }
    try {
      const text = fs.readFileSync(filePaths[0], 'utf8')
      return omm.writeCsvRaw(key, text)
    } catch (err) { return { ok: false, error: err.message || String(err) } }
  })
  // 导出某组缓存 OMM 到用户选定路径
  ipcMain.handle('omm:export', async (e, key) => {
    const r = omm.readCsvRaw(key)
    if (!r) return { ok: false, error: '该组暂无本地缓存，请先联网刷新或导入' }
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${key}_OMM.csv`, filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try { fs.writeFileSync(filePath, r.text); return { ok: true, filePath } }
    catch (err) { return { ok: false, error: err.message || String(err) } }
  })

  // ---- 文件管理：自定义卫星星历库（逐条配置：每个导入文件一组，各自导出/删除）----
  ipcMain.handle('omm:customList', () => customSats.list())
  // 3D 地图分组 / 搜索池加载用：全部组扁平化为一份 OMM CSV（{text, fetchedAt} 或 null，绝不联网）
  ipcMain.handle('omm:customCsv', () => customSats.raw())
  // 删除 / 改名某个导入组
  ipcMain.handle('omm:customRemove', (_e, groupId) => customSats.removeGroup(groupId))
  ipcMain.handle('omm:customRename', (_e, groupId, name) => customSats.renameGroup(groupId, name))
  // 导入星历（可多选）：每个文件 = 一个命名组（同名替换），自动识别 OMM CSV / TLE。
  ipcMain.handle('omm:customImport', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '导入星历（OMM CSV / TLE，可多选，每文件一组）', properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'OMM / TLE 星历 (*.csv, *.tle, *.txt)', extensions: ['csv', 'tle', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePaths || !filePaths.length) return { canceled: true }
    const path = require('path')
    const acc = { ok: true, groups: 0, sats: 0, replaced: 0, invalid: 0, errors: [], warnings: [] }
    for (const fp of filePaths) {
      const base = path.basename(fp).replace(/\.(csv|tle|txt)$/i, '')
      let text
      try { text = fs.readFileSync(fp, 'utf8') } catch (err) { acc.errors.push(path.basename(fp) + '：读取失败 ' + (err.message || err)); continue }
      const r = customSats.importFile(base, text)
      if (!r.ok) { acc.errors.push(path.basename(fp) + '：' + (r.error || '导入失败')); continue }
      acc.groups += 1; acc.sats += r.group.count; acc.replaced += r.replaced ? 1 : 0; acc.invalid += r.invalid || 0
      if (r.errors && r.errors.length) acc.errors.push(...r.errors)
      if (r.warnings && r.warnings.length) acc.warnings.push(...r.warnings)
    }
    return acc
  })
  // 导出某个导入组为 OMM CSV（文件历元）
  ipcMain.handle('omm:customExportGroup', async (e, groupId, defaultName) => {
    const text = customSats.recordsCsv(customSats.groupRecords(groupId))
    if (!text) return { ok: false, error: '该组无卫星可导出' }
    return saveCsv(e, (defaultName || '导入组') + '_OMM.csv', text)
  })
  // 导出任意 OMM 记录为 CSV（自建星座展开记录由渲染进程传入，场景历元）
  ipcMain.handle('omm:exportOmmCsv', async (e, records, defaultName) => {
    const text = customSats.recordsCsv(records)
    if (!text) return { ok: false, error: '无可导出的星历记录' }
    return saveCsv(e, (defaultName || '自定义星历') + '_OMM.csv', text)
  })
  async function saveCsv(e, defaultName, text) {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: defaultName, filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try { fs.writeFileSync(filePath, text); return { ok: true, filePath } }
    catch (err) { return { ok: false, error: err.message || String(err) } }
  }

  // ---- 文件管理：用户 GXT 覆盖库（卫星 → 波束 → GXT）----
  if (coverageGxt) {
    ipcMain.handle('coverageGxt:index', () => coverageGxt.index())
    ipcMain.handle('coverageGxt:get', (_e, file) => coverageGxt.get(file))
    ipcMain.handle('coverageGxt:raw', (_e, file) => coverageGxt.raw(file))
    ipcMain.handle('coverageGxt:addSat', (_e, name, lon) => coverageGxt.addSat(name, lon))
    ipcMain.handle('coverageGxt:renameSat', (_e, satId, name) => coverageGxt.renameSat(satId, name))
    ipcMain.handle('coverageGxt:removeSat', (_e, satId) => coverageGxt.removeSat(satId))
    ipcMain.handle('coverageGxt:ensureSat', (_e, name, lon) => coverageGxt.ensureSat(name, lon))
    ipcMain.handle('coverageGxt:hidePreset', (_e, kind, key) => coverageGxt.hidePreset(kind, key))
    ipcMain.handle('coverageGxt:unhidePreset', (_e, kind, key) => coverageGxt.unhidePreset(kind, key))
    ipcMain.handle('coverageGxt:addBeam', (_e, satId, name, type, band) => coverageGxt.addBeam(satId, name, type, band))
    ipcMain.handle('coverageGxt:renameBeam', (_e, satId, beamId, name) => coverageGxt.renameBeam(satId, beamId, name))
    ipcMain.handle('coverageGxt:removeBeam', (_e, satId, beamId) => coverageGxt.removeBeam(satId, beamId))
    ipcMain.handle('coverageGxt:attach', (_e, satId, beamId, payload) => coverageGxt.attach(satId, beamId, payload))
    ipcMain.handle('coverageGxt:importBatch', (_e, items) => coverageGxt.importBatch(items))
    // 用户导入：原生框选 .gxt（多选）→ 逐个读原文返回渲染进程解析（parse.js）
    ipcMain.handle('coverageGxt:open', async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: '导入 GXT 文件（可多选）', properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'GXT 等值线 (*.gxt)', extensions: ['gxt'] }, { name: '所有文件', extensions: ['*'] }]
      })
      if (canceled || !filePaths || !filePaths.length) return { canceled: true }
      const path = require('path')
      const files = filePaths.map((fp) => {
        try { return { base: path.basename(fp), text: fs.readFileSync(fp, 'latin1') } }
        catch (err) { return { base: path.basename(fp), error: err.message } }
      })
      return { canceled: false, files }
    })
  }

  // ---- GEO 卫星覆盖数据 ----
  if (coverage) {
    ipcMain.handle('coverage:index', () => coverage.index())
    ipcMain.handle('coverage:get', (_e, file) => coverage.get(file))
  }
  // ---- GRD 覆盖图（原始场，实时重算）----
  if (coverageGrd) {
    ipcMain.handle('coverageGrd:index', () => coverageGrd.index())
    ipcMain.handle('coverageGrd:get', (_e, file) => coverageGrd.get(file))
    // 导入的原始 GRD 持久化：存盘 / 读回 / 删除（供天线重载与清理）
    ipcMain.handle('coverageGrd:save', (_e, name, text) => coverageGrd.save(name, text))
    ipcMain.handle('coverageGrd:raw', (_e, file) => coverageGrd.raw(file))
    ipcMain.handle('coverageGrd:remove', (_e, file) => coverageGrd.remove(file))
    // 用户导入：原生文件框选 .grd/.pat（支持多选，一次导入多个天线）→ 逐个读文本返回渲染进程解析
    ipcMain.handle('coverageGrd:open', async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: '导入 GRD / PAT 文件（可多选）', properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'GRASP 网格 (*.grd, *.pat)', extensions: ['grd', 'pat'] }, { name: '所有文件', extensions: ['*'] }]
      })
      if (canceled || !filePaths || !filePaths.length) return { canceled: true }
      const path = require('path')
      const files = filePaths.map((fp) => {
        try { return { base: path.basename(fp), text: fs.readFileSync(fp, 'latin1') } }
        catch (err) { return { base: path.basename(fp), error: err.message } }
      })
      return { canceled: false, files }
    })
    // 链路预算侧导入：同一个文件框，但选完直接在主进程按字节拷进 saveDir，只把文件名回给渲染端。
    // （链路预算只需主进程按文件采样，不解析原文；避免把上百 MB 文本搬过一趟 IPC）
    ipcMain.handle('coverageGrd:import', async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: '导入 GRD / PAT 方向图（可多选）', properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'GRASP 网格 (*.grd, *.pat)', extensions: ['grd', 'pat'] }, { name: '所有文件', extensions: ['*'] }]
      })
      if (canceled || !filePaths || !filePaths.length) return { canceled: true }
      const path = require('path')
      const files = filePaths.map((fp) => {
        const base = path.basename(fp)
        try { return { base, file: coverageGrd.copyIn(fp).file } }
        catch (err) { return { base, error: err.message } }
      })
      return { canceled: false, files }
    })
  }

  // ---- 链路计算 ----
  ipcMain.handle('link:compute', (_e, s, l) => core().calculateLinkBudget(s || {}, l || {}))
  ipcMain.handle('link:computeNGSO', (_e, s, l) =>
    core().calculateLinkBudgetNGSO
      ? core().calculateLinkBudgetNGSO(s || {}, l || {})
      : { success: false, message: 'NGSO 引擎未加载' })
  ipcMain.handle('link:angle', (_e, lat, lon, satLon) => core().calculateSatelliteAngle(lat, lon, satLon))
  // 链路瀑布表分段数据（结果区渲染 / 专业版导出共用同一口径）
  ipcMain.handle('link:waterfall', (_e, ctx) => core().buildWaterfallSegments(ctx || {}))
  // 计算方式求解（在主进程内迭代求解功带平衡 / 反推余量，避免大量 IPC 往返）
  ipcMain.handle('link:computeMode', (_e, s, l, opt) => core().computeLinkMode(s || {}, l || {}, opt || {}))
  // 批量：整表各行一次算完再返回（逐行口径与 link:computeMode 完全一致，只省 IPC 往返）。
  // 每行可带自己的 satParams / opt（不同卫星、不同功放功率），故传的是 [{ sat, link, opt }] 列表。
  ipcMain.handle('link:computeModeBatch', (_e, list) => {
    const arr = Array.isArray(list) ? list : []
    return arr.map((it) => {
      try { return core().computeLinkMode((it && it.sat) || {}, (it && it.link) || {}, (it && it.opt) || {}) }
      catch (err) { return { success: false, message: err.message || String(err) } }
    })
  })
  // 参数扫描（可视化「直角坐标系」的算力层）：整段区间在主进程一次跑完，
  // 一次往返带回全部可绘输出量，前端换纵轴变量无需重算（同 rain:sweep 的思路）
  ipcMain.handle('link:sweep', (_e, spec) => {
    try { return core().sweepLink(spec || {}) }
    catch (err) { return { xs: [], series: {}, ok: 0, fail: 0, message: err.message || String(err) } }
  })
  // 二维参数扫描（设计空间图）：x×y 网格逐格重跑，回全部可绘输出量的场 + 连续可行裕度场。
  // 场是 Float64Array，走结构化克隆原样过来（切勿在两端 JSON 化：那会把定型数组变成
  // {"0":…,"1":…} 的键值对象，体积涨十几倍还得在渲染端再转回来）。
  // 地理场还带「覆盖门 + 方向图联动」（spec.geo）：逐格重采卫星天线增益要读 .grdbin，
  // 而核心层不碰 fs → 在这里把 GRD 取值服务注入进去（一次批量采完整张网格，不逐格往返）
  ipcMain.handle('link:sweep2D', (_e, spec) => {
    const hooks = {
      samplePattern: (pat, points) => (grd
        ? grd.sample({ file: pat.file, sat: pat.sat, cfg: pat.cfg, points })
        : points.map(() => null))
    }
    try { return core().sweepLink2D(spec || {}, hooks) }
    catch (err) { return { xs: [], ys: [], nx: 0, ny: 0, series: {}, feas: new Float64Array(0), ok: 0, fail: 0, masked: 0, message: err.message || String(err) } }
  })
  // 可绘输出量清单（扫描器的因变量池，按物理意义分组）
  ipcMain.handle('link:outputDefs', () => core().lbOutputDefs.OUTPUT_GROUPS)
  // NGSO 计算方式求解（同四种方式，切 NGSO 引擎，强制 ISL 跳数=0）
  ipcMain.handle('link:computeModeNGSO', (_e, s, l, opt) =>
    core().computeLinkModeNGSO
      ? core().computeLinkModeNGSO(s || {}, l || {}, opt || {})
      : { success: false, message: 'NGSO 引擎未加载' })
  // 再生式上行计算方式求解（设置余量 / 设置功放；合计 C/N = 上行 C/(N+I)；复用 NGSO 几何）
  ipcMain.handle('link:computeRegenUplink', (_e, s, l, opt) =>
    core().computeRegenUplinkMode
      ? core().computeRegenUplinkMode(s || {}, l || {}, opt || {})
      : { success: false, message: '再生式引擎未加载' })
  // 再生式下行计算方式求解（给定工作点 G/T / 目标余量；合计 C/N = 下行 C/(N+I)；复用 NGSO 几何）
  ipcMain.handle('link:computeRegenDownlink', (_e, s, l, opt) =>
    core().computeRegenDownlinkMode
      ? core().computeRegenDownlinkMode(s || {}, l || {}, opt || {})
      : { success: false, message: '再生式引擎未加载' })
  // 再生式星间计算（发射卫星 EIRP / 接收卫星 G/T；合计 C/N = 星间单跳 C/N）
  ipcMain.handle('link:computeRegenIsl', (_e, s, l, opt) =>
    core().computeRegenIslMode
      ? core().computeRegenIslMode(s || {}, l || {}, opt || {})
      : { success: false, message: '再生式引擎未加载' })
  // 再生式星间激光计算（MathWorks 简化功率链 P_rx=P_tx+OE+G−LP−L_PS；余量=P_rx−P_req）
  ipcMain.handle('link:computeRegenLaser', (_e, p, opt) =>
    core().computeRegenLaserIslMode
      ? core().computeRegenLaserIslMode(p || {}, opt || {})
      : { success: false, message: '再生式引擎未加载' })
  // 星间链路(ISL)两星几何求解（双 SGP4 + 地球临边遮挡 → 最差星间距离 + 互视可见度 + 访问窗口）
  ipcMain.handle('link:islGeometry', (_e, opt) =>
    core().solveIslWorstCase
      ? core().solveIslWorstCase(opt || {})
      : { feasible: false, reason: '星间几何求解器未加载' })
  // NGSO 站星几何求解（选星=SGP4/SDP4 单一典型时刻 t* 几何；手动=闭式球面最差 + 轨道根数）
  ipcMain.handle('link:ngsoGeometry', (_e, opt) =>
    core().solveNgsoMutualWorstCase
      ? core().solveNgsoMutualWorstCase(opt || {})
      : { feasible: false, reason: 'NGSO 几何求解器未加载' })
  // 批量几何：一次带回整表各链路的几何。同一颗星、同一 t0/时窗下，SGP4 粗扫的传播部分与站址无关，
  // 主进程内各站对共享一份采样（结果与逐条调用逐位一致），顺带把 N 次 IPC 往返压成 1 次。
  ipcMain.handle('link:ngsoGeometryBatch', (_e, opt) =>
    core().solveNgsoMutualWorstCaseBatch
      ? core().solveNgsoMutualWorstCaseBatch(opt || {})
      : (((opt && opt.pairs) || []).map(() => ({ feasible: false, reason: 'NGSO 几何求解器未加载' }))))
  // 批量计算方式求解：一组 linkParams 在主进程内连算完再一次返回（候选几何逐个跑引擎时用），
  // 逐条口径与 link:computeModeNGSO 完全相同，只省 IPC 往返
  ipcMain.handle('link:computeModeNGSOBatch', (_e, s, list, opt) => {
    const fn = core().computeLinkModeNGSO
    const arr = Array.isArray(list) ? list : []
    if (!fn) return arr.map(() => ({ success: false, message: 'NGSO 引擎未加载' }))
    return arr.map((l) => {
      try { return fn(s || {}, l || {}, opt || {}) }
      catch (err) { return { success: false, message: err.message || String(err) } }
    })
  })
  // 单站访问窗口（再生式几何：时窗内满足最低仰角及以上的全部过境）
  ipcMain.handle('link:accessWindows', (_e, opt) =>
    core().solveAccessWindows
      ? core().solveAccessWindows(opt || {})
      : { feasible: false, reason: '访问窗口求解器未加载', windows: [] })
  // 经纬度 → 降雨率/海拔自动填值（与小程序口径一致）
  ipcMain.handle('link:geoFill', (_e, lat, lon) => core().geoAutoFill(parseFloat(lat), parseFloat(lon)))
  // GRD 天线逐站取值（多波束最大 Parameter）：解析+采样在主进程，渲染端只收发 dB 数字
  ipcMain.handle('link:grdSample', (_e, req) => (grd ? grd.sample(req || {}) : ((req && req.points) || []).map(() => null)))
  // GRD 天线概要（波束数/网格）：链路预算导入方向图后填「N 波束」，顺带预编译 .grdbin
  ipcMain.handle('link:grdMeta', (_e, file) => (grd ? grd.meta(file) : { ok: false, error: 'GRD 服务未加载' }))
  // 干扰分析：逐波束采样（少量站点）与 C/CCI 合成（整张场图，主进程内折成标量再回传）
  ipcMain.handle('link:grdSampleBeams', (_e, req) => (grd ? grd.sampleBeams(req || {}) : { beamIdx: [], values: ((req && req.points) || []).map(() => []) }))
  ipcMain.handle('link:grdSampleXpd', (_e, req) => (grd ? grd.sampleXpd(req || {}) : { ok: false, error: 'GRD 服务未加载', values: ((req && req.points) || []).map(() => null) }))
  ipcMain.handle('link:grdSampleCci', (_e, req) => (grd ? grd.sampleCci(req || {}) : { ok: false, error: 'GRD 服务未加载', cci: ((req && req.points) || []).map(() => null) }))
  // 城市列表（选址用）
  ipcMain.handle('link:cities', () => core().listCities())
  ipcMain.handle('link:searchCities', (_e, kw) => core().searchCities(String(kw == null ? '' : kw), {}))
  // 载波信号选项（调制/FEC/DVB/MODCOD）
  ipcMain.handle('link:baseband', () => core().basebandOptions())

  // 打开「GEO 链路预算」独立工作台窗口（单例，由 main 注入创建函数）
  ipcMain.handle('linkbudget:open', () => { if (openLinkBudget) openLinkBudget(); return true })
  // 关窗守卫：渲染进程问过用户「配置存了没」（取消/不保存/保存）并按需存盘后，调这个才真正关闭窗口
  ipcMain.handle('linkbudget:confirmClose', () => { if (confirmCloseLinkBudget) confirmCloseLinkBudget(); return true })

  // 打开「NGSO 链路预算」独立工作台窗口（单例，由 main 注入创建函数）
  ipcMain.handle('ngso:open', () => { if (openNgso) openNgso(); return true })
  ipcMain.handle('ngso:confirmClose', () => { if (confirmCloseNgso) confirmCloseNgso(); return true })

  // 打开「再生式链路预算」独立工作台窗口（单例，由 main 注入创建函数）
  ipcMain.handle('regen:open', () => { if (openRegen) openRegen(); return true })
  ipcMain.handle('regen:confirmClose', () => { if (confirmCloseRegen) confirmCloseRegen(); return true })

  // ---- 雨衰计算（独立窗口 · 通用于各类卫星 · 批量/单算例/曲线计算 + Excel 导出）----
  ipcMain.handle('rain:open', () => { if (openRain) openRain(); return true })
  // 干扰分析（C/I）独立窗口：只读消费者——读三库与 GRD，不写回任何库
  ipcMain.handle('ci:open', () => { if (openCi) openCi(); return true })
  ipcMain.handle('pfd:open', () => { if (openPfd) openPfd() })

  // ---- 转发器频率计划 ----
  ipcMain.handle('freqPlan:open', (_e, planId) => {
    if (!openFreqPlan) return false
    const win = openFreqPlan()
    // 带 planId 打开 = 从文件区双击某份计划进来，等页面就绪后再送（新开窗口时 DOM 还没挂载）
    if (win && planId) {
      const send = () => { try { win.webContents.send('freqPlan:openPlan', planId) } catch { /* 窗口已关 */ } }
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
      else send()
    }
    return true
  })
  if (freqPlan) {
    ipcMain.handle('freqPlan:list', () => freqPlan.list())
    ipcMain.handle('freqPlan:get', (_e, id) => freqPlan.get(id))
    ipcMain.handle('freqPlan:save', (_e, plan, opts) => freqPlan.save(plan, opts))
    // 删/改名后告诉编辑窗（它可能正开着这一份）：不通知它就会被它的自动存盘整份写回来
    ipcMain.handle('freqPlan:remove', (_e, id) => {
      const r = freqPlan.remove(id)
      if (r && r.ok && notifyFreqPlan) notifyFreqPlan('freqPlan:planRemoved', String(id || ''))
      return r
    })
    ipcMain.handle('freqPlan:rename', (_e, id, name) => {
      const r = freqPlan.rename(id, name)
      if (r && r.ok && notifyFreqPlan) notifyFreqPlan('freqPlan:planRenamed', String(id || ''), r.entry ? r.entry.name : String(name || ''))
      return r
    })
    ipcMain.handle('freqPlan:reassignSat', (_e, folder, patch) => freqPlan.reassignSat(folder, patch))

    // 导出：PNG / PDF / SVG / JSON / XLSX，统一走原生保存框
    ipcMain.handle('freqPlan:export', async (e, kind, payload, defaultName) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const ext = kind === 'pdf' ? 'pdf' : kind === 'json' ? 'json' : kind === 'svg' ? 'svg'
        : kind === 'xlsx' ? 'xlsx' : 'png'
      const nameMap = { pdf: 'PDF 文档', json: 'JSON 数据', svg: 'SVG 矢量图', png: 'PNG 图片', xlsx: 'Excel 工作簿' }
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: '导出频率计划',
        defaultPath: (defaultName || '频率计划') + '.' + ext,
        filters: [{ name: nameMap[ext], extensions: [ext] }]
      })
      if (canceled || !filePath) return { canceled: true }
      try {
        if (kind === 'xlsx') {
          // payload 是渲染端算好的纯数据模型（版式与口径都在 src/shared/fpXlsxModel.js），
          // 这里只把它刷成工作簿 —— 见 electron/services/freqPlanXlsx.js 文件头
          const { buildFreqPlanWorkbook } = require('../services/freqPlanXlsx')
          fs.writeFileSync(filePath, Buffer.from(await buildFreqPlanWorkbook(payload)))
        } else if (kind === 'json' || kind === 'svg') fs.writeFileSync(filePath, String(payload || ''), 'utf8')
        else {
          // PNG / PDF 都由渲染端生成后以 dataURL 送来（PDF 走 jspdf + svg2pdf，与报表同一条管线）。
          // ★ MIME 与 base64 之间允许夹参数：jsPDF 的 datauristring 就带着 ;filename=xxx.pdf 那一节，
          //   原先那条 [^;]+ 的正则一口咬死「类型后面必须紧跟 base64」，把每一份 PDF 都判成格式不正确。
          const m = /^data:[^,]*;base64,(.+)$/.exec(String(payload || ''))
          if (!m) throw new Error('导出数据格式不正确')
          fs.writeFileSync(filePath, Buffer.from(m[1], 'base64'))
        }
        return { ok: true, filePath }
      } catch (err) { return { ok: false, error: err.message } }
    })

    // 导入 JSON（整份计划交换）
    ipcMain.handle('freqPlan:importJson', async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: '导入频率计划（JSON）', properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'JSON (*.json)', extensions: ['json'] }]
      })
      if (canceled || !filePaths || !filePaths.length) return { canceled: true }
      const plans = []
      const errors = []
      for (const fp of filePaths) {
        try {
          const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
          if (Array.isArray(j)) plans.push(...j)
          else if (j && typeof j === 'object') plans.push(j)
        } catch (err) { errors.push(`${path.basename(fp)}：${err.message}`) }
      }
      const r = freqPlan.importMany(plans, { mode: 'merge' })
      return { canceled: false, ...r, errors }
    })
  }
  ipcMain.handle('ci:asi', (_e, req) => interference.asi(req))
  ipcMain.handle('ci:xpi', (_e, req) => interference.xpi(req))
  ipcMain.handle('ci:xpiTerm', (_e, req) => interference.xpiTerm(req))
  ipcMain.handle('ci:cciPoint', (_e, req) => interference.cciPoint(req))
  ipcMain.handle('ci:ngsoEstimate', (_e, req) => interference.ngsoEstimate(req))
  // NGSO 扫描是长任务：这里只启动，进度经 ci:ngsoProgress、结果经 ci:ngsoDone 推回发起窗口
  ipcMain.handle('ci:ngsoStart', (e, req) => interference.ngsoStart(e.sender, req))
  ipcMain.handle('ci:ngsoCancel', () => interference.ngsoCancel())
  // 星历接入：邻星搜索（GEO 按星下点经度排）+ 星座组列表/载入（NGSO 选真实星座）
  ipcMain.handle('ci:groups', () => interference.groups())
  ipcMain.handle('ci:loadGroup', (_e, g, online, satIds, sats) => interference.loadGroup(g, online, satIds, sats))
  ipcMain.handle('ci:geoNeighbors', (_e, req) => interference.geoNeighbors(req))
  ipcMain.handle('rain:confirmClose', () => { if (confirmCloseRain) confirmCloseRain(); return true })
  // 单算例（详情面板/兜底）
  ipcMain.handle('rain:compute', (_e, p) => {
    try { return core().calculateRainAttenuation(p || {}) }
    catch (err) { return { error: true, message: err.message || String(err) } }
  })
  // 批量（一次 IPC 算完整表，避免逐行往返）
  ipcMain.handle('rain:computeBatch', (_e, cases) => {
    try { return (Array.isArray(cases) ? cases : []).map((c) => core().calculateRainAttenuation(c || {})) }
    catch (err) { return { error: true, message: err.message || String(err) } }
  })
  // 曲线扫描（雨衰 vs 可用度/频率/降雨率），供交互式坐标系绘制
  ipcMain.handle('rain:sweep', (_e, p, axis, range) => {
    try { return core().sweepRainAttenuation(p || {}, axis, range || {}) }
    catch (err) { return { axis, points: [], error: true, message: err.message || String(err) } }
  })
  // 批量结果 Excel 导出（批量结果 sheet + 每算例详情 sheet）
  ipcMain.handle('rain:exportExcel', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: (payload && payload.defaultName) || '雨衰计算结果.xlsx',
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      const buf = await report.buildRainAttenuationExcel(payload || {})
      fs.writeFileSync(filePath, Buffer.from(buf))
      return { ok: true, filePath }
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Excel），请关闭后重试' : (err.message || String(err)) }
    }
  })

  // ---- 环境场图层（主窗口「环境场」视图）----
  // 全精度 ITU 数据只在主进程（启动时注入内核），故整张等经纬栅格在这里生成后一次性回传；
  // 逐点走 IPC 做整张图要百万次往返，不可行。Float32Array 走结构化克隆，无需序列化成数组。
  ipcMain.handle('env:defs', () => {
    try { return core().envFieldDefs() }
    catch (err) { return { error: true, message: err.message || String(err) } }
  })
  ipcMain.handle('env:field', (_e, key, opt) => {
    try { return core().sampleEnvField(key, opt || {}) }
    catch (err) { return { error: true, message: err.message || String(err) } }
  })

  // ---- 日凌预报（独立窗口 + 计算 + Word/ICS 导出）----
  ipcMain.handle('suntool:open', () => { if (openSunOutage) openSunOutage(); return true })
  ipcMain.handle('sunoutage:compute', (_e, p) => {
    try { return core().calculateSunOutage(p || {}) }
    catch (err) { return { error: true, message: err.message || String(err) } }
  })
  // Word 报告：payload = { result, station:{name,lat,lon}, satellite:{name,lon}, tz:'bjt'|'utc' }
  ipcMain.handle('sunoutage:exportWord', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: (payload && payload.defaultName) || '日凌预报报告.docx',
      filters: [{ name: 'Word 文档', extensions: ['docx'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      const buf = await report.buildSunOutageWord(payload || {})
      fs.writeFileSync(filePath, Buffer.from(buf))
      return { ok: true, filePath }
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Word），请关闭后重试' : (err.message || String(err)) }
    }
  })
  // ICS 日历：事件时刻恒用 UTC（导入方自动换算本地时区）；SUMMARY 附本地峰值便于值班速读。
  ipcMain.handle('sunoutage:exportIcs', async (e, payload) => {
    const { result, station = {}, satellite = {} } = payload || {}
    const days = (result && result.dailyResults) || []
    if (!days.length) return { ok: false, error: '无日凌事件可导出' }
    const satName = satellite.name || `${satellite.lon}°E`
    const stnName = station.name || '地球站'
    const yearStr = String(result.equinoxDate || '').slice(0, 4)
    // 本地时刻：按地球站经度推算整点时区 round(经度/15)h，据 UTC 瞬间平移
    const p2 = (n) => String(n).padStart(2, '0')
    const staOffMin = (() => { const l = Number(station.lon); return isFinite(l) ? Math.round(l / 15) * 60 : 0 })()
    const locTime = (dateUTC, hms) => { const dt = new Date(`${dateUTC}T${hms}Z`); if (isNaN(dt.getTime())) return hms; dt.setTime(dt.getTime() + staOffMin * 60000); return `${p2(dt.getUTCHours())}:${p2(dt.getUTCMinutes())}:${p2(dt.getUTCSeconds())}` }
    const offH = staOffMin / 60
    const tzLbl = offH === 0 ? 'UTC' : 'UTC' + (offH > 0 ? '+' : '−') + Math.abs(offH)
    const events = days.map((d) => ({
      // UID 含 星-站-日期：同一事件重复导入时日历自动更新而非重复
      uid: `so-${satellite.lon}E-${Number(station.lat).toFixed(2)}N-${Number(station.lon).toFixed(2)}E-${d.date}@satsim-platform`,
      date: d.date, start: d.startTimeUTC, end: d.endTimeUTC,
      summary: `日凌 ${satName} @ ${stnName} · 峰值${locTime(d.date, d.peakTimeUTC)}(本地) · -${d.peakCNdeg}dB`,
      description: [
        `卫星: ${satName}（${satellite.lon}°E）`,
        `地球站: ${stnName}（${station.lat}, ${station.lon}）· 方位 ${result.satAz}° 仰角 ${result.satEl}°`,
        `窗口(UTC): ${d.startTimeUTC} ~ ${d.endTimeUTC}（峰值 ${d.peakTimeUTC}）`,
        `窗口(本地 ${tzLbl}): ${locTime(d.date, d.startTimeUTC)} ~ ${locTime(d.date, d.endTimeUTC)}（峰值 ${locTime(d.date, d.peakTimeUTC)}）`,
        `时长: ${d.durationStr} · 峰值 C/N 恶化: ${d.peakCNdeg} dB · 强度: ${d.intensity}`,
        `判据: C/N 恶化 ≥ ${result.model ? result.model.degThreshold : '—'} dB · 频率 ${result.frequency} GHz · 口径 ${result.model ? result.model.diameter : '—'} m`,
        `由 卫星仿真平台 生成`
      ].join('\n'),
      location: stnName,
      categories: ['日凌', 'SUN OUTAGE'],
      alarms: [
        { minutesBefore: 1440, description: `明日日凌：${satName} @ ${stnName}` },
        { minutesBefore: 30, description: `30 分钟后日凌开始：${satName} @ ${stnName}` }
      ]
    }))
    const ics = core().buildIcs({ name: `日凌预报 ${satName} @ ${stnName} · ${result.seasonName}${yearStr}`, events })
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: (payload && payload.defaultName) || `日凌预报_${satName}_${stnName}_${yearStr}${result.seasonName}.ics`,
      filters: [{ name: 'iCalendar 日历', extensions: ['ics'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(filePath, ics, 'utf8')
      return { ok: true, filePath, count: events.length }
    } catch (err) {
      return { ok: false, error: err.message || String(err) }
    }
  })

  // ---- 本地存储 ----
  ipcMain.handle('store:history:list', () => storage.listHistory())
  ipcMain.handle('store:history:add', (_e, r) => storage.addHistory(r))
  ipcMain.handle('store:history:delete', (_e, id) => storage.deleteHistory(id))
  ipcMain.handle('store:history:clear', () => storage.clearHistory())
  ipcMain.handle('store:config:list', () => storage.listConfigs())
  ipcMain.handle('store:config:save', (_e, c) => storage.saveConfig(c))
  ipcMain.handle('store:config:delete', (_e, id) => storage.deleteConfig(id))
  ipcMain.handle('store:config:reorder', (_e, ids) => storage.reorderConfigs(ids))
  ipcMain.handle('store:config:move', (_e, { id, parentId, anchorId, position }) => storage.moveItem(id, parentId, anchorId, position))
  ipcMain.handle('store:config:deleteFolder', (_e, id) => storage.deleteFolder(id))
  ipcMain.handle('store:settings:get', () => storage.getSettings())
  ipcMain.handle('store:settings:set', (_e, s) => storage.setSettings(s))
  ipcMain.handle('store:library:get', (_e, ns) => storage.getLibrary(ns))
  ipcMain.handle('store:library:save', (_e, { ns, data }) => storage.saveLibrary(ns, data))

  // ---- 通用二进制导出（原生保存对话框 → 写盘）：覆盖图 PNG / 矢量 PDF 等 ----
  // payload: { defaultName, data:ArrayBuffer|Uint8Array, filters:[{name,extensions}] }
  ipcMain.handle('file:save', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: payload.defaultName || 'export.bin',
      filters: payload.filters || [{ name: '所有文件', extensions: ['*'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(filePath, Buffer.from(payload.data))
      return { ok: true, filePath }
    } catch (err) {
      // 目标文件被其他程序占用（PDF/图片查看器打开着）→ EBUSY/EPERM。返回友好错误，不抛出。
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 PDF 查看器），请关闭后重试' : (err.message || String(err)) }
    }
  })

  // ---- PFD Mask 生成（ITU-R S.1503）：参数 → 引擎 → XSD 校验 → 返回 XML 文本 ----
  // 放主进程有两个理由：① 引擎是 CommonJS 纯核，渲染端无 import 先例；
  // ② 60×60×23 网格约 1.4 s，放渲染端会卡住整个 3D 页的渲染循环。
  // 只回传字符串与统计，落盘仍走通用 file:save（复用其占用/权限的友好报错）。
  // 入参两种形态都收：
  //   单 job（旧）：直接是一份 params
  //   多 job（掩模表）：{ satName, ntcId, specVersion, jobs: [params, ...] } → 合并成一份文档
  ipcMain.handle('pfd:generate', async (_e, req) => {
    try {
      const eng = require('../../packages/core/utils/pfdmask/maskEngine.js')
      const io = require('../../packages/core/utils/pfdmask/maskIO.js')
      const t0 = Date.now()
      const jobs = Array.isArray(req && req.jobs) ? req.jobs : [req]

      const doc = {
        ntcId: Number(req && req.ntcId !== undefined ? req.ntcId : jobs[0].ntcId),
        satName: String((req && req.satName) || jobs[0].satName || '').slice(0, 20),
        pfdMasks: [], eirpMaskEs: [], eirpMaskSs: []
      }
      const metas = []
      const jobErrors = []
      const discretion = []

      for (const j of jobs) {
        try {
          const r = eng.generateMasks(j)
          // 合并：mask_id 的跨类唯一性由下面的 validateMaskDoc 统一把关
          doc.pfdMasks.push(...r.doc.pfdMasks)
          doc.eirpMaskEs.push(...r.doc.eirpMaskEs)
          doc.eirpMaskSs.push(...r.doc.eirpMaskSs)
          metas.push(r.meta)
          jobErrors.push(null)
          for (const d of (r.meta.discretion || [])) {
            if (!discretion.some((x) => x.field === d.field && String(x.value) === String(d.value))) discretion.push(d)
          }
        } catch (e) {
          metas.push(null)
          jobErrors.push((e && e.message) || String(e))
        }
      }

      const hard = jobErrors.filter(Boolean)
      if (!doc.pfdMasks.length && !doc.eirpMaskEs.length && !doc.eirpMaskSs.length) {
        return { ok: false, error: hard[0] || '没有生成任何 mask', jobErrors, metas }
      }

      const v = io.validateMaskDoc(doc)
      if (!v.ok) {
        return {
          ok: false,
          error: `未通过 ITU 官方 XSD 校验，共 ${v.errors.length} 处`,
          errors: v.errors.slice(0, 20), jobErrors, metas
        }
      }
      const header = [
        'Generated by 卫星仿真平台 · PFD EIRP Mask Generator',
        'Schema: ITU masks schema v.4.0.0.0 (Rec. ITU-R S.1503-2)',
        `Modelled per ${(req && req.specVersion) || 'S.1503-4'}; exported against XSD v4.0.0.0`,
        'DISCRETIONARY SETTINGS (not specified by Rec. ITU-R S.1503):',
        ...discretion.map((d) => `  [${d.evidence}] ${d.field} = ${d.value} — ${d.why}`)
      ]
      // 三种切分粒度都算出来，由渲染端按用户选择取用（成本只是字符串拼接）
      const files = {
        single: io.buildMaskFiles(doc, { mode: 'single', header }),
        'per-kind': io.buildMaskFiles(doc, { mode: 'per-kind', header }),
        'per-mask': io.buildMaskFiles(doc, { mode: 'per-mask', header })
      }
      const xml = files.single[0].xml

      // 第四份交付物：运行参数（规避角/终端密度/跟踪约束，都不进 mask XML）。
      // 按 S.1503-4 §B3.3 生成，旁挂独立文件——绝不塞进 mask 文件（Mask-schema.xsd 不含此元素）。
      const opFiles = []
      const opProblems = []
      if (req && req.operatingParams) {
        try {
          const opm = require('../../packages/core/utils/pfdmask/operatingParams.js')
          const chk = opm.validateOperatingParams(req.operatingParams)
          opProblems.push(...chk.errors, ...chk.warnings)
          if (chk.ok) {
            opFiles.push({
              filename: `Mask_param_id_${req.operatingParams.paramId}_OP.xml`,
              xml: opm.buildOperatingParamsXml(doc, req.operatingParams, {
                validate: false,
                header: [
                  'Generated by 卫星仿真平台 · PFD EIRP Mask Generator',
                  'Schema basis: Rec. ITU-R S.1503-4 §B3.3 (ITU has not published an XSD for this element)'
                ]
              })
            })
          }
        } catch (e) { opProblems.push((e && e.message) || String(e)) }
      }

      return {
        ok: true, xml, files, metas, jobErrors, discretion, opFiles, opProblems,
        counts: v.counts,
        warnings: v.warnings.slice(0, 20),
        elapsedMs: Date.now() - t0,
        bytes: Buffer.byteLength(xml, 'utf8')
      }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  // ---- 批量落盘到一个目录：mask 分文件导出 + §E3 的参数存档一起出 ----
  // payload: { dirLabel?, files:[{filename, text}] }
  ipcMain.handle('file:saveMany', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: payload.dirLabel || '选择输出目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true }
    const dir = filePaths[0]
    const written = []
    try {
      for (const f of (payload.files || [])) {
        // 放行【一层】子目录（出包要 Masks/ 这一层），其余非法字符照旧替换。
        // 白名单式而非黑名单式：分段清洗 + 段数上限 + 显式拒绝 ..，避免路径穿越。
        const rel = String(f.filename).split('/').filter(Boolean)
          .map((s) => s.replace(/[\\:*?"<>|]/g, '_'))
        if (!rel.length || rel.length > 2 || rel.some((s) => s === '..' || s === '.')) {
          throw new RangeError(`非法输出路径：${f.filename}`)
        }
        const p = path.join(dir, ...rel)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, f.text, 'utf8')
        written.push(p)
      }
      return { ok: true, dir, written }
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return {
        ok: false, dir, written,
        error: busy ? '目标文件可能正被其他程序打开，请关闭后重试' : (err.message || String(err))
      }
    }
  })

  // ---- 协调区 Polygon 导入（原生框选 .gxt / .kml，多选）→ 逐个读原文返回渲染进程解析 ----
  // KML 含中文名/描述按 UTF-8 读；GXT 为 ASCII/latin1（sat_name 可能含 latin1 高位字符）按 latin1 读。
  ipcMain.handle('poly:open', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '导入协调区多边形（GXT / KML，可多选）', properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '多边形 (*.gxt, *.kml)', extensions: ['gxt', 'kml'] },
        { name: 'GXT 等值线 (*.gxt)', extensions: ['gxt'] },
        { name: 'KML (*.kml)', extensions: ['kml'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePaths || !filePaths.length) return { canceled: true }
    const path = require('path')
    const files = filePaths.map((fp) => {
      const ext = path.extname(fp).slice(1).toLowerCase()
      try { return { base: path.basename(fp), ext, text: fs.readFileSync(fp, ext === 'kml' ? 'utf8' : 'latin1') } }
      catch (err) { return { base: path.basename(fp), ext, error: err.message } }
    })
    return { canceled: false, files }
  })

  // ---- 读取系统字体（供矢量 PDF 嵌入；jsPDF 仅支持单面 TTF，不支持 TTC，且按用到的字形子集化，体积可忽略）----
  // latin：Times New Roman 三面（常规/粗/斜），西文与数字用——与软件界面同字体；
  // cjk  ：候选里首个存在的单面中文 TTF，中文字形用（TNR 无汉字，PDF 的字体是按「字体资源」而非按字形回落的，
  //        故必须分两套注册，由导出端逐条文本按有无汉字选面）。
  // 任一项缺失即为 null：latin 缺则退到 PDF 内建 times（基础 14 字体，观感等同），cjk 缺则中文可能缺字。
  ipcMain.handle('font:pdf', () => {
    if (process.platform !== 'win32') return { ok: false }
    const path = require('path')
    const dir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')
    const b64 = (f) => {
      try { const p = path.join(dir, f); return fs.existsSync(p) ? fs.readFileSync(p).toString('base64') : null }
      catch { return null }
    }
    let cjk = null, cjkName = null
    for (const f of ['simhei.ttf', 'simkai.ttf', 'simfang.ttf', 'Deng.ttf', 'msyh.ttf', 'simsunb.ttf']) {
      const d = b64(f)
      if (d) { cjk = d; cjkName = f; break }
    }
    return { ok: true, cjk, cjkName, latin: b64('times.ttf'), latinBold: b64('timesbd.ttf'), latinItalic: b64('timesi.ttf') }
  })

  // ---- 报告导出（原生保存对话框 → 写盘）----
  ipcMain.handle('report:export', async (e, payload) => {
    const fmt = payload.format === 'excel' ? 'excel' : 'word'
    const ext = fmt === 'excel' ? 'xlsx' : 'docx'
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `链路预算报告.${ext}`,
      filters: [{ name: fmt === 'excel' ? 'Excel 工作簿' : 'Word 文档', extensions: [ext] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    // 与本文件其余导出口同一口径：目标文件被 Word/Excel 打开时 writeFileSync 抛 EBUSY/EPERM，
    // 不接住就变成 invoke 的 rejection —— 调用端没 catch 就是「点了导出，没文件也没提示」。
    try {
      const buf = fmt === 'excel' ? await report.buildExcel(payload) : await report.buildWord(payload)
      fs.writeFileSync(filePath, Buffer.from(buf))
      return { ok: true, filePath }
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Word / Excel），请关闭后重试' : (err.message || String(err)) }
    }
  })

  // ---- 交付级链路预算报告（.xlsx / .pdf，同名同目录）----
  // 模型由渲染进程按 src/shared/lbReport.js 组装（元信息 / 逐链路结果 / 输入清单 / 图件）；
  // 瀑布段在此按需补齐（与屏幕「详细预算」同一个 buildWaterfallSegments，且只走一次 IPC）；
  // 随后补 summary，两种文件共吃同一份模型：Excel 走 exceljs，PDF 走隐藏窗 + printToPDF。
  ipcMain.handle('report:exportReport', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const model = (payload && payload.model) || {}
    const ORDER = ['xlsx', 'docx', 'pdf']
    const formats = ORDER.filter((f) => ((payload && payload.formats) || ['xlsx']).indexOf(f) > -1)
    if (!formats.length) return { ok: false, error: '未选择任何输出格式' }
    const EXT = { xlsx: { name: 'Excel 工作簿', extensions: ['xlsx'] }, docx: { name: 'Word 文档', extensions: ['docx'] }, pdf: { name: 'PDF 文档', extensions: ['pdf'] } }
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: formats.length > 1 ? '保存报告（同名生成 ' + formats.map((f) => '.' + f).join(' / ') + '）' : '保存报告',
      defaultPath: ((payload && payload.defaultName) || '链路预算报告') + '.' + formats[0],
      filters: formats.map((f) => EXT[f])
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    const stem = filePath.replace(/\.(xlsx|docx|pdf)$/i, '')
    try {
      const lang = model.lang === 'en' ? 'en' : 'zh'
      const orbitType = (model.scheme && model.scheme.orbitType) || 'GEO'
      for (const l of (model.links || [])) {
        if (l && l.data && !(l.segments && l.segments.length)) {
          try { l.segments = core().buildWaterfallSegments({ results: l.data, lang, orbitType, txLocation: String(l.txName || ''), rxLocation: String(l.rxName || '') }) }
          catch (err) { l.segments = [] }
        }
      }
      report.enrichReportModel(model)
      const files = []
      if (formats.indexOf('xlsx') > -1) {
        const buf = await report.buildReportWorkbook(model)
        fs.writeFileSync(stem + '.xlsx', Buffer.from(buf))
        files.push(stem + '.xlsx')
      }
      if (formats.indexOf('docx') > -1) {
        const buf = await require('../services/reportDocx').buildReportDocx(model)
        fs.writeFileSync(stem + '.docx', Buffer.from(buf))
        files.push(stem + '.docx')
      }
      if (formats.indexOf('pdf') > -1) {
        const buf = await require('../services/reportPdf').buildReportPdf(model)
        fs.writeFileSync(stem + '.pdf', Buffer.from(buf))
        files.push(stem + '.pdf')
      }
      return { ok: true, files, filePath: files[0] }
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Excel / PDF 阅读器），请关闭后重试' : (err.message || String(err)) }
    }
  })
  // ---- 应用版本（帮助 → 关于 对话框显示）----
  ipcMain.handle('app:version', () => require('electron').app.getVersion())

  // ---- 设备 ID（按本机 MAC 派生的稳定短码，作为「用户 ID」用于配置分享）----
  // 取所有非内网物理网卡 MAC 排序后 sha256，取前 10 位 hex 大写；落盘 settings 保证跨网卡变化也稳定。
  // 管理员身份硬编码（不开放修改，避免他人冒充）：派生ID → 固定标识。
  // 加 master2/master3：在那台机器上跑一次、看软件左下「我的ID」显示的派生ID，填进此表再发版即可。
  const ADMIN_IDS = {
    '2E314A3754': 'master1',     // 开发者笔记本（MAC 84:9e:56:77:52:9d）
    '731D97DD7B': 'master2'      // 开发者台式机（MAC 50:eb:f6:eb:83:02）
    // '<机器3派生ID>': 'master3'
  }
  ipcMain.handle('app:deviceId', () => {
    const s = storage.getSettings()
    let base = s && s.deviceId
    if (!base) {
      const os = require('os'); const crypto = require('crypto')
      const ifaces = os.networkInterfaces(); const macs = []
      for (const name of Object.keys(ifaces)) for (const i of (ifaces[name] || [])) {
        if (i.mac && i.mac !== '00:00:00:00:00:00' && !i.internal) macs.push(i.mac.toLowerCase())
      }
      macs.sort()
      const seed = macs.join(',') || os.hostname() || String(Date.now())
      base = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10).toUpperCase()
      storage.setSettings({ deviceId: base })
    }
    return ADMIN_IDS[base] || base
  })

  // ---- 配置文件导入（线下分享：选 .lbcfg/.json 读回文本）----
  ipcMain.handle('linkbudget:openConfig', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: '链路预算配置', extensions: ['lbcfg', 'json'] }]
    })
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true }
    try { return { ok: true, text: fs.readFileSync(filePaths[0], 'utf8') } }
    catch (err) { return { ok: false, error: err.message || String(err) } }
  })

  // ---- 在线分享信箱（COS）：按用户ID收发配置；未配置密钥时 configured=false ----
  if (share) {
    ipcMain.handle('share:configured', () => share.configured())
    ipcMain.handle('share:send', async (_e, recipientId, payload) => {
      try { return await share.send(recipientId, payload) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
    ipcMain.handle('share:inbox', async (_e, myId) => {
      try { return await share.inbox(myId) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
    ipcMain.handle('share:delete', async (_e, myId, id) => {
      try { return await share.remove(myId, id) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
    // 发送到小程序：上传当前绘制状态快照到 COS gxt/<key>.json，返回 { ok, key }
    ipcMain.handle('share:gxtSnapshot', async (_e, payload) => {
      try { return await share.putSnapshot(payload) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
    // 绑定投递：往小程序端的 12 位认证码信箱直投（见 share.js「绑定投递」段）
    ipcMain.handle('share:boxSend', async (_e, ch, o) => {
      try { return await share.boxSend(ch, o) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
    ipcMain.handle('share:boxPeek', async (_e, ch, pid) => {
      try { return await share.boxPeek(ch, pid) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
    ipcMain.handle('share:boxRevoke', async (_e, ch, pid, mid) => {
      try { return await share.boxRevoke(ch, pid, mid) } catch (err) { return { ok: false, error: err.message || String(err) } }
    })
  }
}

module.exports = { register }
