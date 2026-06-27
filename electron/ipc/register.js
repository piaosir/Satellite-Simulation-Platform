const { ipcMain, dialog, BrowserWindow } = require('electron')
const fs = require('fs')
const createOmm = require('../services/omm')

// 注册所有 IPC 处理器。core 为返回引擎实例的函数（延迟解析）。
function register({ core, storage, report, coverage, coverageGrd }) {
  const omm = createOmm(core)
  ipcMain.handle('omm:load', (_e, group, online) => omm.load(group, online))
  ipcMain.handle('omm:positions', (_e, group, iso) => omm.positions(group, iso))
  ipcMain.handle('omm:csv', (_e, group, opts) => omm.fetchCsv(group, opts))

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

  // ---- 本地存储 ----
  ipcMain.handle('store:history:list', () => storage.listHistory())
  ipcMain.handle('store:history:add', (_e, r) => storage.addHistory(r))
  ipcMain.handle('store:history:delete', (_e, id) => storage.deleteHistory(id))
  ipcMain.handle('store:history:clear', () => storage.clearHistory())
  ipcMain.handle('store:config:list', () => storage.listConfigs())
  ipcMain.handle('store:config:save', (_e, c) => storage.saveConfig(c))
  ipcMain.handle('store:config:delete', (_e, id) => storage.deleteConfig(id))
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
}

module.exports = { register }
