const { ipcMain, dialog, BrowserWindow } = require('electron')
const fs = require('fs')
const createOmm = require('../services/omm')

// 注册所有 IPC 处理器。core 为返回引擎实例的函数（延迟解析）。
function register({ core, storage, report, coverage, coverageGrd, coverageGxt, share, openLinkBudget, grd }) {
  const omm = createOmm(core)
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
  // 经纬度 → 降雨率/海拔自动填值（与小程序口径一致）
  ipcMain.handle('link:geoFill', (_e, lat, lon) => core().geoAutoFill(parseFloat(lat), parseFloat(lon)))
  // GRD 天线逐站取值（多波束最大 Parameter）：解析+采样在主进程，渲染端只收发 dB 数字
  ipcMain.handle('link:grdSample', (_e, req) => (grd ? grd.sample(req || {}) : ((req && req.points) || []).map(() => null)))
  // 城市列表（选址用）
  ipcMain.handle('link:cities', () => core().listCities())
  ipcMain.handle('link:searchCities', (_e, kw) => core().searchCities(String(kw == null ? '' : kw), {}))
  // 基带选项（调制/FEC/DVB/MODCOD）
  ipcMain.handle('link:baseband', () => core().basebandOptions())

  // 打开「GEO 链路预算」独立工作台窗口（单例，由 main 注入创建函数）
  ipcMain.handle('linkbudget:open', () => { if (openLinkBudget) openLinkBudget(); return true })

  // ---- 本地存储 ----
  ipcMain.handle('store:history:list', () => storage.listHistory())
  ipcMain.handle('store:history:add', (_e, r) => storage.addHistory(r))
  ipcMain.handle('store:history:delete', (_e, id) => storage.deleteHistory(id))
  ipcMain.handle('store:history:clear', () => storage.clearHistory())
  ipcMain.handle('store:config:list', () => storage.listConfigs())
  ipcMain.handle('store:config:save', (_e, c) => storage.saveConfig(c))
  ipcMain.handle('store:config:delete', (_e, id) => storage.deleteConfig(id))
  ipcMain.handle('store:config:reorder', (_e, ids) => storage.reorderConfigs(ids))
  ipcMain.handle('store:settings:get', () => storage.getSettings())
  ipcMain.handle('store:settings:set', (_e, s) => storage.setSettings(s))

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

  // ---- 读取系统中文字体（供矢量 PDF 嵌入；jsPDF 仅支持单面 TTF，不支持 TTC）----
  // 按候选顺序返回首个存在的单面 TTF 的 base64；找不到返回 ok:false（PDF 则退化为无中文字体）。
  ipcMain.handle('font:cjk', () => {
    if (process.platform !== 'win32') return { ok: false }
    const path = require('path')
    const dir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')
    const cands = ['simhei.ttf', 'simkai.ttf', 'simfang.ttf', 'Deng.ttf', 'msyh.ttf', 'simsunb.ttf']
    for (const f of cands) {
      const p = path.join(dir, f)
      try { if (fs.existsSync(p)) return { ok: true, name: f, base64: fs.readFileSync(p).toString('base64') } } catch { /* try next */ }
    }
    return { ok: false }
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
    const buf = fmt === 'excel' ? await report.buildExcel(payload) : await report.buildWord(payload)
    fs.writeFileSync(filePath, Buffer.from(buf))
    return { ok: true, filePath }
  })

  // ---- 工作台 m×n 链路矩阵 Excel 导出（Phase 5）----
  ipcMain.handle('linkbudget:exportExcel', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: (payload && payload.defaultName) || 'GEO链路预算结果.xlsx',
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      // 为每条链路构建七段瀑布（与 UI 瀑布同源 buildWaterfallSegments）→「详细计算结果」分表
      const links = (payload && payload.links) || []
      for (const l of links) {
        if (l && l.data) {
          try { l.segments = core().buildWaterfallSegments({ results: l.data, lang: 'zh', orbitType: 'GEO', txLocation: String(l.txName || ''), rxLocation: String(l.rxName || '') }) }
          catch (e) { l.segments = [] }
        }
      }
      const buf = await report.buildLinkBudgetExcel(payload || {})
      fs.writeFileSync(filePath, Buffer.from(buf))
      return { ok: true, filePath }
    } catch (err) {
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')
      return { ok: false, error: busy ? '文件可能正被其他程序打开（如 Excel），请关闭后重试' : (err.message || String(err)) }
    }
  })

  // ---- 设备 ID（按本机 MAC 派生的稳定短码，作为「用户 ID」用于配置分享）----
  // 取所有非内网物理网卡 MAC 排序后 sha256，取前 10 位 hex 大写；落盘 settings 保证跨网卡变化也稳定。
  // 管理员身份硬编码（不开放修改，避免他人冒充）：派生ID → 固定标识。
  // 加 master2/master3：在那台机器上跑一次、看软件左下「我的ID」显示的派生ID，填进此表再发版即可。
  const ADMIN_IDS = {
    '2E314A3754': 'master1'      // 开发者本机（MAC 84:9e:56:77:52:9d）
    // '<机器2派生ID>': 'master2',
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
  }
}

module.exports = { register }
