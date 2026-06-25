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
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const root = app.getAppPath()
  const storage = require(join(root, 'electron/services/storage'))
  const report = require(join(root, 'electron/services/report'))
  const coverage = require(join(root, 'electron/services/coverage'))(join(root, 'resources/coverage'))
  const coverageGrd = require(join(root, 'electron/services/coverage'))(join(root, 'resources/coverage-grd'), join(app.getPath('userData'), 'coverage-grd-imported'))
  const { register } = require(join(root, 'electron/ipc/register'))
  register({ core, storage, report, coverage, coverageGrd })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
