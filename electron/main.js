const { app, BrowserWindow } = require('electron')
const { join } = require('path')

// 引擎与各服务都以磁盘上的 CommonJS 形式按 app 根目录动态加载，
// 绕开 electron-vite 对相对依赖的外部化（其会把 ./services/* 解析到 out/main 下而找不到）。
let _core = null
function core() {
  if (!_core) _core = require(join(app.getAppPath(), 'packages/core'))
  return _core
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    title: '卫星仿真平台',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    // 不再自动打开 DevTools；需要时按 F12 切换
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  // F12 切换开发者工具（autoHideMenuBar 下默认快捷键可能失效，这里显式绑定）
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault() }
  })

  return win
}

// 链路预算工作台：独立 BrowserWindow（原生最大化/最小化/缩放），单例复用。
let _lbWin = null
function createLinkBudgetWindow() {
  if (_lbWin && !_lbWin.isDestroyed()) {
    if (_lbWin.isMinimized()) _lbWin.restore()
    _lbWin.focus()
    return _lbWin
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'GEO 链路预算',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/linkbudget.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/linkbudget.html'))
  }
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault() }
  })
  win.on('closed', () => { _lbWin = null })
  _lbWin = win
  return win
}

app.whenReady().then(() => {
  const root = app.getAppPath()
  const storage = require(join(root, 'electron/services/storage'))
  const report = require(join(root, 'electron/services/report'))
  const coverage = require(join(root, 'electron/services/coverage'))(join(root, 'resources/coverage'))
  const coverageGrd = require(join(root, 'electron/services/coverage'))(join(root, 'resources/coverage-grd'), join(app.getPath('userData'), 'coverage-grd-imported'))
  const coverageGxt = require(join(root, 'electron/services/coverageGxt'))(() => join(app.getPath('userData'), 'gxt-imported'))
  const share = require(join(root, 'electron/services/share'))()
  // GRD 取值服务（与 coverageGrd 共享导入目录）：链路预算逐站取值在主进程完成
  const grd = require(join(root, 'electron/services/grd'))(join(app.getPath('userData'), 'coverage-grd-imported'))
  const { register } = require(join(root, 'electron/ipc/register'))
  register({ core, storage, report, coverage, coverageGrd, coverageGxt, share, openLinkBudget: createLinkBudgetWindow, grd })

  // 加载 ITU 全精度数据（降雨率 P.837 / 海拔 P.1511 / 水汽 P.836 / 云 P.840）→ 注入计算内核，
  // 与小程序口径完全一致（小程序为云端下载，桌面端从本地 resources/itu 同步加载）。
  try {
    const fs = require('fs')
    const ituDir = join(root, 'resources/itu')
    const rd = (f) => { try { return fs.readFileSync(join(ituDir, f)) } catch (e) { return null } }
    const rep = core().loadFullPrecisionData({
      rain: rd('p837_r001_v2.bin'), elev: rd('topo_v1.bin'),
      vapor: rd('p836_rho_v1.bin'), cloud: rd('p840_logn_v1.bin')
    })
    console.log('[ITU] 全精度数据注入:', JSON.stringify(rep))
  } catch (e) {
    console.warn('[ITU] 全精度数据加载失败：', e.message)
  }

  const win = createWindow()

  // 自动更新（仅打包环境生效，dev 下自动跳过）
  require(join(root, 'electron/services/updater')).initAutoUpdate(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
