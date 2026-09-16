const { app, BrowserWindow, protocol, net } = require('electron')
const { join } = require('path')

// 影像瓦片协议：resources/imagery 下的离线金字塔（见 scripts/build-imagery-tiles.mjs）以
// imagery://tiles/<集>/<z>/<行>/<列>.jpg 供渲染端直接 <img src> 取用。
// ★ 为什么不走 IPC：一屏最多几十片同时在飞，逐片走 IPC 就是几十次结构化克隆 + 手工造 blob URL
//   还得自己管回收；协议方式让 Chromium 自己做磁盘/内存缓存，pan 回头看过的地方是零成本。
// ★ registerSchemesAsPrivileged 必须在 app ready 之前调用，晚一步就静默不生效（不报错）。
//   standard: <img> 需要它才按常规 URL 解析；supportFetchAPI 留给将来预热/探测用。
protocol.registerSchemesAsPrivileged([
  { scheme: 'imagery', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } }
])

// 强制启用硬件加速：部分老旧集显（常见于国企办公机）落在 Electron 的 GPU 黑名单内，会静默
// 回退到 SwiftShader 软件渲染——WebGL 改由 CPU 模拟，慢几十倍，是这类机器卡顿的元凶之一。
// 忽略黑名单使其走真实 GPU。必须在 app ready 之前调用（命令行开关只在启动期生效）。
app.commandLine.appendSwitch('ignore-gpu-blocklist')

// 单实例：两个进程共用同一个 userData，而 library.json / configs.json 都是「整份读-改-写」，
// 原子写只保证单进程内不撕文件、不做跨进程合并——两边交错落盘时后写的一方整份冲掉先写的一方
// （Chromium 的 Local Storage 也是同一把锁）。拿不到锁就退出，把焦点还给已在跑的那个实例。
let _mainWin = null
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()
else {
  app.on('second-instance', () => {
    // 主窗口关掉、只剩某个子窗口时（Windows 下要全关才退出）也得给个响应，否则第二次双击像是没启动
    const win = (_mainWin && !_mainWin.isDestroyed()) ? _mainWin : BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

// 引擎与各服务都以磁盘上的 CommonJS 形式按 app 根目录动态加载，
// 绕开 electron-vite 对相对依赖的外部化（其会把 ./services/* 解析到 out/main 下而找不到）。
let _core = null
function core() {
  if (!_core) _core = require(join(app.getAppPath(), 'packages/core'))
  return _core
}

// ---- 开发者工具：只在开发期开放（2026-08-11 授权审计）----
// 原先九个窗口一律无条件绑 F12。打包版里这一条等于把整套授权体系交出去：
//   · ActivationLock 是 CSS 遮罩，控制台一行 document.querySelector('.al-mask').remove() 就没了；
//   · 主窗口按产品决定本来就不上遮罩（未激活也留着地球/星座可看），于是未激活用户
//     连遮罩都不用碰，直接 window.api.report.exportReport(...) 就能出交付级报告。
// 主进程侧的配套补丁见 ipc/register.js 的 gatedIpc（默认全拦、白名单放行），两条一起才闭环：
// 这里挡住「拿到控制台」，那里挡住「就算拿到控制台也调不动值钱的 IPC」。
// app.isPackaged 为假（npm run dev / electron . 直跑）时照常绑，开发体验不受影响。
function bindDevTools(win) {
  if (app.isPackaged) return
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault() }
  })
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
    // 自定义标题栏（VS Code 范式）：隐藏原生标题栏，仅保留 Windows 右上角原生窗口控制按钮（覆盖式）。
    // 应用把品牌名 + 菜单栏画进这条同一行 → 消除「原生标题栏 + 菜单栏」两行冗余（同名两次）。
    // 配色初值 = 浅色主题 --surface/--text；主题切换时渲染进程经 window:setOverlay 实时更新。
    titleBarStyle: 'hidden',
    // height 比菜单栏矮 1px：菜单栏 32px(border-box) 的底边框落在最后一行 y=31，
    // 覆盖式窗口控制区若也高 32 会盖住该行 → 菜单/工具栏之间的分隔线右段被三键区吃掉。
    // 缩到 31 只覆盖 y=0..30，底边框整行外露，分隔线贯通到右边缘（三键仅矮 1px，无感）。
    titleBarOverlay: { color: '#f7f7f5', symbolColor: '#1a1a1a', height: 31 },
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      // 打包版彻底关闭 DevTools（2026-08-11 复审补）：只摘 F12 绑定不够——autoHideMenuBar
      // 仅隐藏菜单栏，Electron 默认菜单里 toggleDevTools 的 Ctrl+Shift+I 加速键仍然生效，
      // 打包版照样能开控制台。devTools:false 连 openDevTools() 一起封死，与任何加速键无关。
      devTools: !app.isPackaged
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    // 不再自动打开 DevTools；需要时按 F12 切换
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  bindDevTools(win)
  win.on('closed', () => {
    if (_mainWin === win) _mainWin = null
    // 性能指标表窗口的数据全靠主窗口推，主窗口没了它们就是一堆停在旧数上的空壳 → 一并关掉
    for (const [, p] of _perfWins) { try { if (!p.win.isDestroyed()) p.win.close() } catch { /* 正在关 */ } }
  })
  _mainWin = win

  return win
}

// 链路预算工作台：独立 BrowserWindow（原生最大化/最小化/缩放），单例复用。
let _lbWin = null
let _lbAllowClose = false   // 关窗守卫放行标志：默认 false→拦截 close 转问渲染进程；渲染进程确认后置 true 才真正关
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
    title: 'GSO 透明转发链路预算',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      // 打包版彻底关闭 DevTools（2026-08-11 复审补）：只摘 F12 绑定不够——autoHideMenuBar
      // 仅隐藏菜单栏，Electron 默认菜单里 toggleDevTools 的 Ctrl+Shift+I 加速键仍然生效，
      // 打包版照样能开控制台。devTools:false 连 openDevTools() 一起封死，与任何加速键无关。
      devTools: !app.isPackaged
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/linkbudget.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/linkbudget.html'))
  }
  bindDevTools(win)
  // 关窗前先拦一次，转问渲染进程「配置存了没」：渲染进程用与内部切换配置同一套「取消/不保存/保存」
  // 弹窗（见 LinkBudgetApp.vue 的 guardedLeave）问过用户、按需存盘后，回调 confirmCloseLinkBudget()
  // 才真正关闭；没有未保存改动时渲染进程会立即回调，观感上仍是秒关。
  _lbAllowClose = false
  win.on('close', (e) => {
    if (_lbAllowClose) return
    e.preventDefault()
    win.webContents.send('linkbudget:closeRequested')
  })
  win.on('closed', () => { _lbWin = null })
  _lbWin = win
  return win
}
function confirmCloseLinkBudget() {
  _lbAllowClose = true
  if (_lbWin && !_lbWin.isDestroyed()) _lbWin.close()
}

// NGSO 链路预算工作台：独立 BrowserWindow，单例复用（与 GEO 链路预算同模式）。
let _ngsoWin = null
let _ngsoAllowClose = false
function createNgsoWindow() {
  if (_ngsoWin && !_ngsoWin.isDestroyed()) {
    if (_ngsoWin.isMinimized()) _ngsoWin.restore()
    _ngsoWin.focus()
    return _ngsoWin
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'NGSO 透明转发链路预算',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      // 打包版彻底关闭 DevTools（2026-08-11 复审补）：只摘 F12 绑定不够——autoHideMenuBar
      // 仅隐藏菜单栏，Electron 默认菜单里 toggleDevTools 的 Ctrl+Shift+I 加速键仍然生效，
      // 打包版照样能开控制台。devTools:false 连 openDevTools() 一起封死，与任何加速键无关。
      devTools: !app.isPackaged
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/ngso.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/ngso.html'))
  }
  bindDevTools(win)
  _ngsoAllowClose = false
  win.on('close', (e) => {
    if (_ngsoAllowClose) return
    e.preventDefault()
    win.webContents.send('ngso:closeRequested')
  })
  win.on('closed', () => { _ngsoWin = null })
  _ngsoWin = win
  return win
}
function confirmCloseNgso() {
  _ngsoAllowClose = true
  if (_ngsoWin && !_ngsoWin.isDestroyed()) _ngsoWin.close()
}

// 再生式链路预算工作台：独立 BrowserWindow，单例复用（与 NGSO 链路预算同模式）。
let _regenWin = null
let _regenAllowClose = false
function createRegenWindow() {
  if (_regenWin && !_regenWin.isDestroyed()) {
    if (_regenWin.isMinimized()) _regenWin.restore()
    _regenWin.focus()
    return _regenWin
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: '再生处理（OBP）链路预算',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      // 打包版彻底关闭 DevTools（2026-08-11 复审补）：只摘 F12 绑定不够——autoHideMenuBar
      // 仅隐藏菜单栏，Electron 默认菜单里 toggleDevTools 的 Ctrl+Shift+I 加速键仍然生效，
      // 打包版照样能开控制台。devTools:false 连 openDevTools() 一起封死，与任何加速键无关。
      devTools: !app.isPackaged
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/regen.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/regen.html'))
  }
  bindDevTools(win)
  _regenAllowClose = false
  win.on('close', (e) => {
    if (_regenAllowClose) return
    e.preventDefault()
    win.webContents.send('regen:closeRequested')
  })
  win.on('closed', () => { _regenWin = null })
  _regenWin = win
  return win
}
function confirmCloseRegen() {
  _regenAllowClose = true
  if (_regenWin && !_regenWin.isDestroyed()) _regenWin.close()
}

// 端到端链路预算工作台（多跳 / 混合转发）：独立 BrowserWindow，单例复用（与前三窗同模式）。
let _e2eWin = null
let _e2eAllowClose = false
function createE2eWindow() {
  if (_e2eWin && !_e2eWin.isDestroyed()) {
    if (_e2eWin.isMinimized()) _e2eWin.restore()
    _e2eWin.focus()
    return _e2eWin
  }
  const win = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1180,
    minHeight: 740,
    title: '端到端链路预算（多跳 / 混合转发）',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      // 打包版彻底关闭 DevTools（同前三窗，见 createWindow 注释）
      devTools: !app.isPackaged
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/e2e.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/e2e.html'))
  }
  bindDevTools(win)
  _e2eAllowClose = false
  win.on('close', (e) => {
    if (_e2eAllowClose) return
    e.preventDefault()
    win.webContents.send('e2e:closeRequested')
  })
  win.on('closed', () => { _e2eWin = null })
  _e2eWin = win
  return win
}
function confirmCloseE2e() {
  _e2eAllowClose = true
  if (_e2eWin && !_e2eWin.isDestroyed()) _e2eWin.close()
}

// 日凌预报：独立 BrowserWindow，单例复用（与链路预算工作台同模式）。
let _soWin = null
function createSunOutageWindow() {
  if (_soWin && !_soWin.isDestroyed()) {
    if (_soWin.isMinimized()) _soWin.restore()
    _soWin.focus()
    return _soWin
  }
  const win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    title: '日凌预报 · GSO',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      // 打包版彻底关闭 DevTools（2026-08-11 复审补）：只摘 F12 绑定不够——autoHideMenuBar
      // 仅隐藏菜单栏，Electron 默认菜单里 toggleDevTools 的 Ctrl+Shift+I 加速键仍然生效，
      // 打包版照样能开控制台。devTools:false 连 openDevTools() 一起封死，与任何加速键无关。
      devTools: !app.isPackaged
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/suntool.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/suntool.html'))
  }
  bindDevTools(win)
  win.on('closed', () => { _soWin = null })
  _soWin = win
  return win
}

// 干扰分析（C/I）：独立 BrowserWindow，单例复用。
// 不设关窗守卫——本窗口是纯只读计算器（读三库与 GRD、不写回），面板状态自动落 localStorage，
// 关窗不会丢任何用户数据，弹确认框只是徒增一步。
let _ciWin = null
let _pfdWin = null
function createPfdWindow() {
  if (_pfdWin && !_pfdWin.isDestroyed()) {
    if (_pfdWin.isMinimized()) _pfdWin.restore()
    _pfdWin.focus()
    return _pfdWin
  }
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1160,
    minHeight: 720,
    title: 'PFD EIRP Mask 生成器（ITU-R S.1503）',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      // 打包版彻底关闭 DevTools（2026-08-11 复审补）：只摘 F12 绑定不够——autoHideMenuBar
      // 仅隐藏菜单栏，Electron 默认菜单里 toggleDevTools 的 Ctrl+Shift+I 加速键仍然生效，
      // 打包版照样能开控制台。devTools:false 连 openDevTools() 一起封死，与任何加速键无关。
      devTools: !app.isPackaged
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/pfd.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/pfd.html'))
  }
  win.on('closed', () => { _pfdWin = null })
  bindDevTools(win)
  _pfdWin = win
  return win
}

// 空间态势报告：独立 BrowserWindow，单例复用。
// 设关窗守卫（与三个链路预算窗口、雨衰窗口同套）——报告的「配置」是一整套攒到最后才存的输入
// （范围 / 章节开关 / Top N 一类），不是频率计划那种改一下即落盘的文件，关窗有可丢之物。
let _ssaWin = null
let _ssaAllowClose = false
function createSsaWindow() {
  if (_ssaWin && !_ssaWin.isDestroyed()) {
    if (_ssaWin.isMinimized()) _ssaWin.restore()
    _ssaWin.focus()
    return _ssaWin
  }
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1160,
    minHeight: 720,
    title: '空间态势报告',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      devTools: !app.isPackaged
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/ssa.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/ssa.html'))
  }
  bindDevTools(win)
  _ssaAllowClose = false
  win.on('close', (e) => {
    if (_ssaAllowClose) return
    e.preventDefault()
    win.webContents.send('ssa:closeRequested')
  })
  win.on('closed', () => { _ssaWin = null })
  _ssaWin = win
  return win
}

// 转发器频率计划：独立 BrowserWindow，单例复用。
// 不设关窗守卫——编辑器每次改动即存盘（频率计划是「文件」不是「会话」，与三个链路预算窗口
// 那种「一整套输入攒到最后才存」的形态不同），关窗无可丢之物。
let _freqPlanWin = null
function createFreqPlanWindow() {
  if (_freqPlanWin && !_freqPlanWin.isDestroyed()) {
    if (_freqPlanWin.isMinimized()) _freqPlanWin.restore()
    _freqPlanWin.focus()
    return _freqPlanWin
  }
  const win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1180,
    minHeight: 720,
    title: '转发器频率计划',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      // 打包版彻底关闭 DevTools（2026-08-11 复审补）：只摘 F12 绑定不够——autoHideMenuBar
      // 仅隐藏菜单栏，Electron 默认菜单里 toggleDevTools 的 Ctrl+Shift+I 加速键仍然生效，
      // 打包版照样能开控制台。devTools:false 连 openDevTools() 一起封死，与任何加速键无关。
      devTools: !app.isPackaged
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/freqplan.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/freqplan.html'))
  }
  win.on('closed', () => { _freqPlanWin = null })
  bindDevTools(win)
  _freqPlanWin = win
  return win
}
// 定向广播给频率计划编辑窗。文件区删/改名后不通知它，它手里还是删除前那一份，
// 600ms 后的自动存盘会把计划连文件带索引整份写回来（见 FreqPlanApp 的 doSave）。
function notifyFreqPlan(channel, ...args) {
  if (!_freqPlanWin || _freqPlanWin.isDestroyed()) return
  try { _freqPlanWin.webContents.send(channel, ...args) } catch { /* 窗口正在关 */ }
}

function createCiWindow() {
  if (_ciWin && !_ciWin.isDestroyed()) {
    if (_ciWin.isMinimized()) _ciWin.restore()
    _ciWin.focus()
    return _ciWin
  }
  const win = new BrowserWindow({
    width: 1560,
    height: 940,
    minWidth: 1180,
    minHeight: 740,
    title: '干扰分析',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      // 打包版彻底关闭 DevTools（2026-08-11 复审补）：只摘 F12 绑定不够——autoHideMenuBar
      // 仅隐藏菜单栏，Electron 默认菜单里 toggleDevTools 的 Ctrl+Shift+I 加速键仍然生效，
      // 打包版照样能开控制台。devTools:false 连 openDevTools() 一起封死，与任何加速键无关。
      devTools: !app.isPackaged
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/ci.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/ci.html'))
  }
  bindDevTools(win)
  win.on('closed', () => { _ciWin = null })
  _ciWin = win
  return win
}

// 雨衰计算：独立 BrowserWindow，单例复用（通用于各类卫星；与链路预算工作台同模式，带关窗守卫）。
let _rainWin = null
let _rainAllowClose = false
function createRainWindow() {
  if (_rainWin && !_rainWin.isDestroyed()) {
    if (_rainWin.isMinimized()) _rainWin.restore()
    _rainWin.focus()
    return _rainWin
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: '雨衰计算',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      // 打包版彻底关闭 DevTools（2026-08-11 复审补）：只摘 F12 绑定不够——autoHideMenuBar
      // 仅隐藏菜单栏，Electron 默认菜单里 toggleDevTools 的 Ctrl+Shift+I 加速键仍然生效，
      // 打包版照样能开控制台。devTools:false 连 openDevTools() 一起封死，与任何加速键无关。
      devTools: !app.isPackaged
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/rain.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/rain.html'))
  }
  bindDevTools(win)
  _rainAllowClose = false
  win.on('close', (e) => {
    if (_rainAllowClose) return
    e.preventDefault()
    win.webContents.send('rain:closeRequested')
  })
  win.on('closed', () => { _rainWin = null })
  _rainWin = win
  return win
}
// ---- 性能指标表窗口（对地 / 对星 / 气象）：一根天线一窗、可多开；主进程只当【中继】----
// 表的数据与取值全在主窗口（3D 页）：它算好行推给弹窗（perfwin:push → perfwin:msg），弹窗上的每个
// 操作发回主窗口（perfwin:act），主窗口改了状态再推回来。窗口本身只有一份 perf.html，按
// ?kind=ground|shell|met 决定装哪张表。同一 (kind,key) 只开一个，再开＝前置。
const _perfWins = new Map()   // id → { win, kind, key }
let _perfSeq = 1
// 几何记忆：按表的种类各记一份（尺寸 / 位置 / 是否最大化），落 <userData>/perfwin-bounds.json，下次开同类表原样回来。
// 位置只在仍落在某块屏幕的工作区内时才用（外接屏拔掉后别把窗口开到屏外）；同类多扇窗以最后动过的那扇为准。
const PW_DEFAULT = { ground: [980, 660], shell: [1040, 660], met: [980, 660] }
function pwStore() { return require(join(app.getAppPath(), 'electron/services/jsonStore')) }
function pwBoundsFile() { return join(app.getPath('userData'), 'perfwin-bounds.json') }
function pwBoundsAll() { try { const v = pwStore().readJsonSafe(pwBoundsFile(), {}).value; return v && typeof v === 'object' ? v : {} } catch { return {} } }
function perfWinGeometry(kind) {
  const [w0, h0] = PW_DEFAULT[kind] || PW_DEFAULT.ground
  const opt = { width: w0, height: h0 }
  const s = pwBoundsAll()[kind]
  if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return { opt, maximized: false }
  opt.width = Math.max(640, Math.round(s.width)); opt.height = Math.max(420, Math.round(s.height))
  if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
    try {
      const { screen } = require('electron')
      const a = screen.getDisplayMatching({ x: Math.round(s.x), y: Math.round(s.y), width: opt.width, height: opt.height }).workArea
      // 标题栏左上角一小段仍在工作区内才认这个位置
      if (s.x + 80 > a.x && s.x + 80 < a.x + a.width && s.y + 20 > a.y && s.y + 40 < a.y + a.height) { opt.x = Math.round(s.x); opt.y = Math.round(s.y) }
    } catch { /* 无屏信息：只用尺寸 */ }
  }
  return { opt, maximized: !!s.maximized }
}
function perfWinRemember(win, kind) {
  let t = 0
  const save = () => {
    if (win.isDestroyed() || win.isMinimized()) return
    const b = win.getNormalBounds()
    const all = pwBoundsAll(); all[kind] = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }
    try { pwStore().writeJsonAtomic(pwBoundsFile(), all, 0) } catch { /* 尽力而为 */ }
  }
  const later = () => { clearTimeout(t); t = setTimeout(save, 400) }
  win.on('resize', later); win.on('move', later)
  win.on('close', () => { clearTimeout(t); save() })
}
function perfWinOf(sender) { for (const [id, p] of _perfWins) if (p.win.webContents === sender) return { id, ...p }; return null }
function createPerfWindow({ kind, key, title }) {
  const k = String(kind || 'ground'), kk = String(key || '')
  for (const [id, p] of _perfWins) {
    if (p.kind === k && p.key === kk && !p.win.isDestroyed()) {
      if (p.win.isMinimized()) p.win.restore()
      p.win.focus()
      return { id, created: false }
    }
  }
  const id = 'pw' + (_perfSeq++)
  const geo = perfWinGeometry(k)
  const win = new BrowserWindow({
    ...geo.opt,
    minWidth: 640,
    minHeight: 420,
    title: String(title || '性能指标表'),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      devTools: !app.isPackaged
    }
  })
  const q = `?id=${encodeURIComponent(id)}&kind=${encodeURIComponent(k)}&key=${encodeURIComponent(kk)}`
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/perf.html' + q)
  else win.loadFile(join(__dirname, '../renderer/perf.html'), { search: q })
  bindDevTools(win)
  if (geo.maximized) win.maximize()
  perfWinRemember(win, k)
  // 标题由主窗口按「表 · 卫星 / 天线」定（开窗时给、改名后 setTitle 跟进），页面自己的 <title> 不许盖掉它
  win.on('page-title-updated', (e) => e.preventDefault())
  _perfWins.set(id, { win, kind: k, key: kk })
  win.on('closed', () => {
    _perfWins.delete(id)
    if (_mainWin && !_mainWin.isDestroyed()) { try { _mainWin.webContents.send('perfwin:closed', { id, kind: k, key: kk }) } catch { /* 主窗口正在关 */ } }
  })
  return { id, created: true }
}
// 主窗口 → 弹窗
function perfWinPush(id, msg) {
  const p = _perfWins.get(String(id)); if (!p || p.win.isDestroyed()) return false
  try { p.win.webContents.send('perfwin:msg', msg) } catch { return false }
  return true
}
// 弹窗 → 主窗口（带上是哪扇窗发来的）
function perfWinAct(sender, msg) {
  const p = perfWinOf(sender); if (!p) return false
  if (!_mainWin || _mainWin.isDestroyed()) return false
  try { _mainWin.webContents.send('perfwin:act', { id: p.id, kind: p.kind, key: p.key, ...(msg || {}) }) } catch { return false }
  return true
}
function perfWinClose(id) { const p = _perfWins.get(String(id)); if (p && !p.win.isDestroyed()) p.win.close(); return !!p }
function perfWinSetTitle(id, title) { const p = _perfWins.get(String(id)); if (p && !p.win.isDestroyed()) p.win.setTitle(String(title || '')); return !!p }
function perfWinList() { const out = []; for (const [id, p] of _perfWins) if (!p.win.isDestroyed()) out.push({ id, kind: p.kind, key: p.key }); return out }
function perfWinSelf(sender) { const p = perfWinOf(sender); return p ? { id: p.id, kind: p.kind, key: p.key } : null }

function confirmCloseRain() {
  _rainAllowClose = true
  if (_rainWin && !_rainWin.isDestroyed()) _rainWin.close()
}

function confirmCloseSsa() {
  _ssaAllowClose = true
  if (_ssaWin && !_ssaWin.isDestroyed()) _ssaWin.close()
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return   // 第二个实例：已 app.quit()，但 ready 仍会到，别再建窗口/注册 IPC
  const root = app.getAppPath()

  // 启动时补装：上次直接关机 / 强杀让 electron-updater 的「退出时安装」没跑 → 已下载的新版在这里装
  // （services/updater.js applyPendingUpdate）。返回 true 表示安装器已拉起（装完它自己重开程序）或
  // 另一个安装正在进行，本进程必须立刻退出：不建窗口、不注册 IPC，否则安装器改到一半的目录会被占用。
  const updater = require(join(root, 'electron/services/updater'))
  if (await updater.applyPendingUpdate()) { app.quit(); return }

  // imagery://tiles/<集>/<z>/<行>/<列>.jpg → 影像瓦片离线包
  // ★ 瓦片走 extraResources 放在 app.asar【外面】：整包近 300 MB，塞进单个 asar 既让归档巨大，
  //   也正是 v1.4.0「装上去打不开」那类目录表错位问题的高风险区。故 build.files 里显式排除、
  //   由 build.extraResources 原样拷到 resources/imagery。
  // ★ 用 fs 读而不是 net.fetch('file://…')：本仓库路径含中文，拼 file:// URL 要自己做百分号编码，
  //   少编一次就是「开发机好好的、换台机器整片黑」。fs 收的是原生路径，没有这一层。
  const fsp = require('fs/promises')
  const IMAGERY_DIR = app.isPackaged ? join(process.resourcesPath, 'imagery') : join(root, 'resources', 'imagery')
  // 路径逐段白名单（集名只放行 [A-Za-z0-9_-]、z/行/列必须纯数字），故 .. 之类穿越在解析阶段就没了。
  protocol.handle('imagery', async (req) => {
    try {
      const u = new URL(req.url)
      if (u.hostname !== 'tiles') return new Response('bad host', { status: 400 })
      const seg = u.pathname.replace(/^\/+/, '').split('/')
      if (seg.length !== 4) return new Response('bad path', { status: 400 })
      const [set, z, row] = seg
      const col = seg[3].replace(/\.jpg$/i, '')
      if (!/^[A-Za-z0-9_-]+$/.test(set) || ![z, row, col].every((s) => /^\d+$/.test(s))) return new Response('bad seg', { status: 400 })
      // 缺片返回 404 而不是抛错：渲染端按「粗档兜底」处理 —— 没装离线包时只是回退到低分档，不崩、不黑屏。
      const buf = await fsp.readFile(join(IMAGERY_DIR, set, z, row, col + '.jpg')).catch(() => null)
      if (!buf) return new Response('no tile', { status: 404 })
      return new Response(buf, { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' } })
    } catch { return new Response('err', { status: 500 }) }
  })
  const storage = require(join(root, 'electron/services/storage'))
  const report = require(join(root, 'electron/services/report'))
  const coverage = require(join(root, 'electron/services/coverage'))(join(root, 'resources/coverage'))
  const coverageGrd = require(join(root, 'electron/services/coverage'))(join(root, 'resources/coverage-grd'), join(app.getPath('userData'), 'coverage-grd-imported'))
  const coverageGxt = require(join(root, 'electron/services/coverageGxt'))(() => join(app.getPath('userData'), 'gxt-imported'))
  const share = require(join(root, 'electron/services/share'))()
  // GRD 取值服务（与 coverageGrd 共享导入目录）：链路预算逐站取值在主进程完成
  const grd = require(join(root, 'electron/services/grd'))(join(app.getPath('userData'), 'coverage-grd-imported'))
  // 转发器频率计划：挂在卫星下、与 GRD 天线平级的一类「文件」
  const freqPlan = require(join(root, 'electron/services/freqPlan'))(join(app.getPath('userData'), 'freq-plans'))
  // 和风天气 provider（实时/预报环境场的数据源）。凭据在 electron/services/weatherConfig.js（不进仓库）；
  // 未配置时 configured() 会如实报错，界面据此提示，不影响其余功能。
  const weather = require(join(root, 'electron/services/weather'))(app.getPath('userData'))
  // 气象栅格 provider（实时/预报**场**的数据源）：NCEP GFS，走 NOMADS 子集服务。
  // 公共领域数据、无需凭据、可商用 —— 与和风那条按量计费的线互不相干。
  const gfs = require(join(root, 'electron/services/gfs'))(app.getPath('userData'))
  // 激活与设备管理：终端心跳上报 + 激活书拉取验签（对端为独立的「卫星仿真平台管理」软件）
  const activation = require(join(root, 'electron/services/activation'))(share, storage)
  const { register } = require(join(root, 'electron/ipc/register'))
  register({ core, storage, report, coverage, coverageGrd, coverageGxt, share, openLinkBudget: createLinkBudgetWindow, openSunOutage: createSunOutageWindow, grd, confirmCloseLinkBudget, openNgso: createNgsoWindow, confirmCloseNgso, openRegen: createRegenWindow, confirmCloseRegen, openE2e: createE2eWindow, confirmCloseE2e, openRain: createRainWindow, confirmCloseRain, openCi: createCiWindow, openPfd: createPfdWindow, openSsa: createSsaWindow, confirmCloseSsa, freqPlan, openFreqPlan: createFreqPlanWindow, notifyFreqPlan, activation, weather, gfs, updater,
    perfWin: { open: createPerfWindow, push: perfWinPush, act: perfWinAct, close: perfWinClose, setTitle: perfWinSetTitle, list: perfWinList, self: perfWinSelf } })
  // 定时心跳；激活状态变化（管理端激活/撤销被拉到）广播到所有窗口，各窗口就地上锁/解锁
  activation.start((st) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('activation:changed', st) } catch { /* 窗口正在关 */ }
    }
  })

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

  // 自动更新（仅打包环境生效，dev 下自动跳过）：静默检查 / 下载，正常退出时静默装。
  // 状态变化（检查 / 下载进度 / 下载完成）广播到所有窗口，「帮助 → 检查更新」对话框据此刷新
  updater.onChange((st) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('updater:changed', st) } catch { /* 窗口正在关 */ }
    }
  })
  updater.initAutoUpdate()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 退出前统一放行【全部】带关窗守卫的窗口。
// ★ 新加一扇带守卫的窗口就必须在下面补一行 —— 漏了的那扇会把整个退出流程顶回去，
//   而症状（关机卡住 / 更新装不上）离这里很远，极难回溯到是少写了一行。
// 守卫（_*AllowClose=false → close 时 preventDefault 转问渲染进程）是为「用户点窗口 X」设计的，
// 但它对 close 事件一视同仁，因此会把整个退出流程也一并拦下：
//   · Windows 注销 / 关机：退出被 preventDefault 挡住 → 系统等超时后强杀，本来防丢数据反而丢；
//   · 自动更新的「退出时安装」挂在 app 'quit' 上：退出被挡住 → 更新装不上且无任何提示。
// 正常路径不受影响：唯一的主动退出入口是 window-all-closed（见下），此时窗口早已逐个关过、
// 各自弹过「配置存了没」，走到这里已无窗口可放行 → 本处是纯兜底空转。
app.on('before-quit', () => {
  _lbAllowClose = true
  _ngsoAllowClose = true
  _regenAllowClose = true
  _e2eAllowClose = true
  _rainAllowClose = true
  _ssaAllowClose = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
