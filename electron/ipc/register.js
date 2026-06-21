const { ipcMain, dialog, BrowserWindow } = require('electron')
const fs = require('fs')
const createOmm = require('../services/omm')

// 注册所有 IPC 处理器。core 为返回引擎实例的函数（延迟解析）。
function register({ core, storage, report, coverage }) {
  const omm = createOmm(core)
  ipcMain.handle('omm:load', (_e, group, online) => omm.load(group, online))
  ipcMain.handle('omm:positions', (_e, group, iso) => omm.positions(group, iso))
  ipcMain.handle('omm:csv', (_e, group) => omm.fetchCsv(group))

  // ---- GEO 卫星覆盖数据 ----
  if (coverage) {
    ipcMain.handle('coverage:index', () => coverage.index())
    ipcMain.handle('coverage:get', (_e, file) => coverage.get(file))
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
