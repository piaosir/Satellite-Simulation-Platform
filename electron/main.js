const { app, BrowserWindow, protocol, net, ipcMain, Menu, dialog } = require('electron')
const { join } = require('path')
// 窗口底色 / 主窗三键区按当前外观取（深色外观开窗不白闪）。
// ★ 按 app 根目录运行时加载（同下面 core() 与各服务）：静态 require('./services/winTheme') 不会被打进 out/main/main.js，
//   构建产物里原样留着这一句，运行时按 out/main/services/ 找 → 找不到，启动即崩。
const winTheme = require(join(app.getAppPath(), 'electron/services/winTheme'))

// 影像瓦片协议：resources/imagery 下的离线金字塔（见 scripts/build-imagery-tiles.mjs）以
// imagery://tiles/<集>/<z>/<行>/<列>.jpg 供渲染端直接 <img src> 取用。
// ★ 为什么不走 IPC：一屏最多几十片同时在飞，逐片走 IPC 就是几十次结构化克隆 + 手工造 blob URL
//   还得自己管回收；协议方式让 Chromium 自己做磁盘/内存缓存，pan 回头看过的地方是零成本。
// ★ registerSchemesAsPrivileged 必须在 app ready 之前调用，晚一步就静默不生效（不报错）。
//   standard: <img> 需要它才按常规 URL 解析；supportFetchAPI 留给将来预热/探测用。
// ★ 整个进程只能调这一次（第二次调用会静默盖掉 / 失效）：新协议一律并进下面这个数组。
// models://blobs|user|builtin|thumbs/<sha256>.<glb|webp|png> → 卫星 3D 模型与缩略图（services/models.js）。
//   GLTFLoader 用 fetch() 取 glb，页面来源（dev 的 http://localhost、打包的 file://）对它都算跨域 →
//   corsEnabled + 响应带 ACAO；stream 让 90 MB 级的 lod0 能流式回，不必整块读进主进程内存。
protocol.registerSchemesAsPrivileged([
  { scheme: 'imagery', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
  { scheme: 'models', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true, stream: true } }
])

// 强制启用硬件加速：部分老旧集显（常见于国企办公机）落在 Electron 的 GPU 黑名单内，会静默
// 回退到 SwiftShader 软件渲染——WebGL 改由 CPU 模拟，慢几十倍，是这类机器卡顿的元凶之一。
// 忽略黑名单使其走真实 GPU。必须在 app ready 之前调用（命令行开关只在启动期生效）。
app.commandLine.appendSwitch('ignore-gpu-blocklist')

// 单实例：两个进程共用同一个 userData，而 library.json / configs.json 都是「整份读-改-写」，
// 原子写只保证单进程内不撕文件、不做跨进程合并——两边交错落盘时后写的一方整份冲掉先写的一方
// （Chromium 的 Local Storage 也是同一把锁）。拿不到锁就退出，把焦点还给已在跑的那个实例。
let _mainWin = null
let _booted = false       // whenReady 里主窗口已建（之前到的 second-instance 不重建主窗：启动流程马上会建）
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()
else {
  app.on('second-instance', () => {
    if (_quitting) return
    // 主窗口不在（崩溃后被关掉等）：重建主窗口 —— 关主窗即退出（见 requestQuit），正常不会走到这里，
    // 走到了就给用户一个入口，否则第二次双击像是没启动
    if ((!_mainWin || _mainWin.isDestroyed()) && _booted && !_quitJob && app.isReady()) { createWindow(); return }
    // 兜底聚焦：只找看得见的窗口（报告打印用的 show:false 隐藏窗不算）
    const win = (_mainWin && !_mainWin.isDestroyed()) ? _mainWin
      : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
    if (!win) return
    showWin(win)
  })
}
const showWin = (w) => {
  if (!w || w.isDestroyed()) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

// ---- 主进程兜底（交互调研 A6）：未捕获异常 / 未处理的 Promise 拒绝只记日志，不弹框、不退出 ----
// 挂上监听后 Electron 不再弹「A JavaScript error occurred in the main process」框；日志落 <userData>/main.log
// （services/fileLog.js，与 updater.log / models.log 同一种格式与截断口径）。
let _mainLog = null
function mainLog() {
  if (_mainLog) return _mainLog
  try { _mainLog = require(join(app.getAppPath(), 'electron/services/fileLog')).createFileLogger(join(app.getPath('userData'), 'main.log')) }
  catch { _mainLog = { error: (...a) => console.error(...a) } }
  return _mainLog
}
const errOf = (x) => {
  if (x instanceof Error) return x
  try { return typeof x === 'string' ? x : JSON.stringify(x) } catch { return String(x) }
}
process.on('uncaughtException', (err) => { try { mainLog().error('[uncaughtException]', errOf(err)) } catch { /* 日志也写不了 */ } })
process.on('unhandledRejection', (reason) => { try { mainLog().error('[unhandledRejection]', errOf(reason)) } catch { /* 日志也写不了 */ } })

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
// 应用菜单置空（交互调研 F1）后 Electron 缺省菜单里的 Ctrl+Shift+I 也没了，开发期在这里补上。
function bindDevTools(win) {
  if (app.isPackaged) return
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const ctrlShiftI = (input.control || input.meta) && input.shift && !input.alt && String(input.key || '').toLowerCase() === 'i'
    if (input.key === 'F12' || ctrlShiftI) { win.webContents.toggleDevTools(); e.preventDefault() }
  })
}

// ---- 窗口外壳（交互调研 C1 / C2）：关窗守卫兜底、崩溃 / 无响应原生框、计算窗几何记忆 ----
// 实现在 services/windowGuard.js（按 app 根目录运行时加载，同 core()）。守卫通道 guard:ready / ack / cancel 由它在这里一次性挂上。
let _quitting = false     // before-quit 已发 / 系统注销：一切关窗守卫放行
let _quitJob = null       // 「退出」进行中（逐个关计算窗，见 requestQuit）
let _quitAsking = null    // 「退出」此刻在等的那扇计算窗
let _mainBroken = false   // 主窗口崩溃 / 卡死后选了「关闭」：退出时直接 destroy（等不来它的 beforeunload）
let _uiLang = 'zh'        // 渲染端报来的界面语言（原生兜底框的文案语言）
let _winShell = null
function winShell() {
  if (_winShell) return _winShell
  const root = app.getAppPath()
  const W = require(join(root, 'electron/services/windowGuard'))
  const store = require(join(root, 'electron/services/jsonStore'))
  const ud = app.getPath('userData')
  const toolBounds = W.createBoundsStore(join(ud, 'window-bounds.json'), store)
  // 性能指标表沿用原来的文件与键（按表的种类各记一份）
  const perfBounds = W.createBoundsStore(join(ud, 'perfwin-bounds.json'), store)
  const areas = () => {
    try {
      const { screen } = require('electron')
      const p = screen.getPrimaryDisplay()
      return [p.workArea, ...screen.getAllDisplays().filter((d) => d.id !== p.id).map((d) => d.workArea)]
    } catch { return [] }
  }
  const kit = W.createWindowKit({
    dialog, ipcMain,
    isQuitting: () => _quitting,
    lang: uiLang,
    onLang: (l) => { _uiLang = l },
    onSessionEnd: () => { _quitting = true }
  })
  _winShell = {
    kit,
    geometry: (key, def) => W.clampBounds(toolBounds.get(key), def, areas()),
    remember: (win, key) => W.rememberBounds(win, toolBounds, key),
    perfGeometry: (kind, def) => W.clampBounds(perfBounds.get(kind), def, areas()),
    perfRemember: (win, kind) => W.rememberBounds(win, perfBounds, kind)
  }
  return _winShell
}
// 界面语言：主窗口活着就现读它的 localStorage（ui-lang，src/shared/i18n/lang.js 同键），读不到用渲染端最近报的
async function uiLang() {
  const w = _mainWin
  if (w && !w.isDestroyed()) {
    try {
      const wc = w.webContents
      if (!wc.isCrashed()) {
        const v = await Promise.race([
          wc.executeJavaScript("(function(){try{return localStorage.getItem('ui-lang')||''}catch(e){return ''}})()"),
          new Promise((r) => setTimeout(() => r(null), 250))
        ])
        if (typeof v === 'string') _uiLang = v === 'en' ? 'en' : 'zh'
      }
    } catch { /* 用缓存的 */ }
  }
  return _uiLang
}

// 页面载入：dev 走 vite 服务，打包走 out/renderer 下的文件。q = '?a=b' 形式的查询串
function loadPage(win, page, q) {
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/' + page + (q || ''))
  else win.loadFile(join(__dirname, '../renderer/' + page), q ? { search: q } : undefined)
}

// ---- 计算窗（单例）的公共外壳 ----
// spec = { key（几何记忆的键）, page, title, w, h, minW, minH, guard?（关窗请求通道）, autoReleaseMs?, removeMenu? }
// hooks = { allowed() / setAllowed(v)：读写该窗自己的 _*AllowClose（before-quit 放行表与 updaterPending.test ⑤ 按这些变量对账），onClosed() }
// 已开 = 还原并聚焦后原样返回；新开 = 按记忆的几何开窗（钳进屏内、记住最大化）、挂守卫与崩溃兜底。
const _toolWins = new Set()   // 现存的计算窗（「退出」逐个关；不含主窗、性能表与隐藏的报告打印窗）
function openTool(cur, spec, hooks) {
  if (cur && !cur.isDestroyed()) {
    if (cur.isMinimized()) cur.restore()
    cur.focus()
    return cur
  }
  const S = winShell()
  const geo = S.geometry(spec.key, { width: spec.w, height: spec.h, minWidth: spec.minW, minHeight: spec.minH })
  const win = new BrowserWindow({
    ...geo.opt,
    minWidth: spec.minW,
    minHeight: spec.minH,
    show: !geo.maximized,   // 记着最大化：先不显示，maximize() 后再 show()，不闪一帧还原尺寸
    title: spec.title,
    backgroundColor: winTheme.winBg(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      // 打包版彻底关闭 DevTools（2026-08-11 复审补）：devTools:false 连 openDevTools() 一起封死，与任何加速键无关
      devTools: !app.isPackaged
    }
  })
  if (geo.maximized) { win.maximize(); win.show() }
  if (spec.removeMenu) win.removeMenu()
  loadPage(win, spec.page)
  bindDevTools(win)
  S.remember(win, spec.key)
  S.kit.watch(win)
  if (spec.guard) {
    hooks.setAllowed(false)
    S.kit.guard(win, { channel: spec.guard, allowed: hooks.allowed, release: () => hooks.setAllowed(true), autoReleaseMs: spec.autoReleaseMs })
  }
  _toolWins.add(win)
  win.on('closed', () => { _toolWins.delete(win); if (hooks.onClosed) hooks.onClosed() })
  return win
}

// ---- 退出（交互调研 C1）：关主窗 = 退出程序（STK / MATLAB 口径）----
// 主窗口的 X 与菜单「退出」（app:quit）都走这里：逐个关闭计算窗（各走各的关窗守卫：冲刷写盘 / 问用户），
// 全部关完再 app.quit()（before-quit → 主窗、性能表、隐藏窗一并关掉，自动更新的「退出时安装」照常接手）。
// 任一扇窗的守卫被用户取消（guard:cancel）→ 整个退出中止，那扇窗留在前面。
function requestQuit(opt) {
  if (opt && opt.mainBroken) _mainBroken = true
  if (_quitting) return
  if (_quitJob) {
    // 退出已在进行（多半卡在某扇窗的确认上）：把它提到前面；那扇窗的关窗请求若已作废（「等待」过）就重新转问
    const w = _quitAsking
    if (w && !w.isDestroyed()) {
      showWin(w)
      if (!winShell().kit.isAsking(w)) { try { w.close() } catch { /* 正在关 */ } }
    }
    return
  }
  _quitJob = runQuit().catch((err) => { try { mainLog().error('[quit]', errOf(err)) } catch { /* 无 */ } return false })
    .finally(() => { _quitJob = null; _quitAsking = null })
}
async function runQuit() {
  // 关的过程中又开了新的计算窗（主窗口还在、可以点）：多轮扫到空为止
  for (let round = 0; round < 8; round++) {
    const list = [..._toolWins].filter((w) => !w.isDestroyed())
    if (!list.length) break
    for (const w of list) {
      _quitAsking = w
      if (!(await closeForQuit(w))) return false
    }
  }
  _quitAsking = null
  _quitting = true
  if (_mainBroken && _mainWin && !_mainWin.isDestroyed()) _mainWin.destroy()
  app.quit()
  return true
}
// ---- 计算窗 → 主窗口的反向通道（交互调研 C3，scene:cmd）----
// c = { cmd, payload }，已在 ipc/register.js 按白名单清洗过（services/sceneCmd.js）。转给主窗口并把它提到前面；主窗口不在 → false
function sceneRelay(c) {
  const w = _mainWin
  if (!c || !w || w.isDestroyed()) return false
  try { w.webContents.send('scene:cmd', c) } catch { return false }
  showWin(w)
  return true
}

// 关一扇计算窗：关掉了 → true；它的守卫被用户取消 → false
function closeForQuit(w) {
  return new Promise((resolve) => {
    if (w.isDestroyed()) return resolve(true)
    let t = null, off = null
    const done = (v) => { clearTimeout(t); w.removeListener('closed', onClosed); if (off) off(); resolve(v) }
    const onClosed = () => done(true)
    w.once('closed', onClosed)
    off = winShell().kit.onCancel(w, () => { showWin(w); done(false) })
    // 渲染端在问用户（写盘失败的确认框）时这扇窗多半压在主窗后面：一会儿还没关掉就提到前面
    t = setTimeout(() => showWin(w), 800)
    try { w.close() } catch { done(true) }
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    show: false,   // 先不显示：下面立即 maximize() → show()，没有「先闪 1280×820 再放大」那一帧
    title: '卫星仿真平台',
    backgroundColor: winTheme.winBg(),
    autoHideMenuBar: true,
    // 自定义标题栏（VS Code 范式）：隐藏原生标题栏，仅保留 Windows 右上角原生窗口控制按钮（覆盖式）。
    // 应用把品牌名 + 菜单栏画进这条同一行 → 消除「原生标题栏 + 菜单栏」两行冗余（同名两次）。
    // 配色初值 = 上次记住的外观的 --surface/--text（services/winTheme.js）；主题切换时渲染进程经 window:setOverlay 实时更新。
    titleBarStyle: 'hidden',
    // height 比菜单栏矮 1px：菜单栏 32px(border-box) 的底边框落在最后一行 y=31，
    // 覆盖式窗口控制区若也高 32 会盖住该行 → 菜单/工具栏之间的分隔线右段被三键区吃掉。
    // 缩到 31 只覆盖 y=0..30，底边框整行外露，分隔线贯通到右边缘（三键仅矮 1px，无感）。
    titleBarOverlay: winTheme.winOverlay(),
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

  // 默认最大化启动（Windows 意义上的「全屏」= 最大化：保留任务栏与右上角三键；不用 setFullScreen ——
  // hidden 标题栏 + overlay 下三键会消失、又没绑 F11，用户退不出来）。立即 maximize() → show()，不等 ready-to-show：
  // 慢机上迟迟不出窗会被当成没启动而再双击。还原尺寸仍是上面的 1280×820 居中。
  // 验证台不最大化：直接 require out/main/main.js 的台子（.modelharness/w11 等）要在屏外定尺寸、窗口 2% 透明，
  // 最大化会铺满用户主屏并吃鼠标。它们一律设了 SATSIM_DATA_DIR（隔离数据目录，正式运行从不设），据此自动跳过；
  // 另留 SATSIM_NO_MAXIMIZE 显式开关。
  if (!process.env.SATSIM_NO_MAXIMIZE && !process.env.SATSIM_DATA_DIR) win.maximize()
  win.show()

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    // 不再自动打开 DevTools；需要时按 F12 切换
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  bindDevTools(win)
  // 主窗口的 X = 退出程序（先逐个关计算窗，见 requestQuit）；退出流程走到 app.quit() 后放行
  win.on('close', (e) => {
    if (_quitting) return
    e.preventDefault()
    requestQuit()
  })
  // 主窗口崩溃 / 卡死选「关闭」= 退出（主窗口没了其余窗口无从回到场景）
  winShell().kit.watch(win, { onCrashClose: () => requestQuit({ mainBroken: true }), onHungClose: () => requestQuit({ mainBroken: true }) })
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
// 关窗前先拦一次，转问渲染进程「配置存了没」：渲染进程冲刷自动保存、按需问过用户后回调 confirmCloseLinkBudget()
// 才真正关闭；没有未保存改动时渲染进程会立即回调，观感上仍是秒关。渲染端接不住（没加载完 / 崩溃 / 卡死）的兜底见 windowGuard.js。
function createLinkBudgetWindow() {
  _lbWin = openTool(_lbWin, { key: 'linkbudget', page: 'linkbudget.html', title: 'GSO 透明转发链路预算', w: 1440, h: 900, minW: 1100, minH: 720, guard: 'linkbudget:closeRequested' },
    { allowed: () => _lbAllowClose, setAllowed: (v) => { _lbAllowClose = v }, onClosed: () => { _lbWin = null } })
  return _lbWin
}
function confirmCloseLinkBudget() {
  _lbAllowClose = true
  if (_lbWin && !_lbWin.isDestroyed()) _lbWin.close()
}

// NGSO 链路预算工作台：独立 BrowserWindow，单例复用（与 GEO 链路预算同模式）。
let _ngsoWin = null
let _ngsoAllowClose = false
function createNgsoWindow() {
  _ngsoWin = openTool(_ngsoWin, { key: 'ngso', page: 'ngso.html', title: 'NGSO 透明转发链路预算', w: 1440, h: 900, minW: 1100, minH: 720, guard: 'ngso:closeRequested' },
    { allowed: () => _ngsoAllowClose, setAllowed: (v) => { _ngsoAllowClose = v }, onClosed: () => { _ngsoWin = null } })
  return _ngsoWin
}
function confirmCloseNgso() {
  _ngsoAllowClose = true
  if (_ngsoWin && !_ngsoWin.isDestroyed()) _ngsoWin.close()
}

// 再生式链路预算工作台：独立 BrowserWindow，单例复用（与 NGSO 链路预算同模式）。
let _regenWin = null
let _regenAllowClose = false
function createRegenWindow() {
  _regenWin = openTool(_regenWin, { key: 'regen', page: 'regen.html', title: '再生处理（OBP）链路预算', w: 1440, h: 900, minW: 1100, minH: 720, guard: 'regen:closeRequested' },
    { allowed: () => _regenAllowClose, setAllowed: (v) => { _regenAllowClose = v }, onClosed: () => { _regenWin = null } })
  return _regenWin
}
function confirmCloseRegen() {
  _regenAllowClose = true
  if (_regenWin && !_regenWin.isDestroyed()) _regenWin.close()
}

// 端到端链路预算工作台（多跳 / 混合转发）：独立 BrowserWindow，单例复用（与前三窗同模式）。
let _e2eWin = null
let _e2eAllowClose = false
function createE2eWindow() {
  _e2eWin = openTool(_e2eWin, { key: 'e2e', page: 'e2e.html', title: '端到端链路预算（多跳 / 混合转发）', w: 1520, h: 940, minW: 1180, minH: 740, guard: 'e2e:closeRequested' },
    { allowed: () => _e2eAllowClose, setAllowed: (v) => { _e2eAllowClose = v }, onClosed: () => { _e2eWin = null } })
  return _e2eWin
}
function confirmCloseE2e() {
  _e2eAllowClose = true
  if (_e2eWin && !_e2eWin.isDestroyed()) _e2eWin.close()
}

// 日凌预报：独立 BrowserWindow，单例复用（与链路预算工作台同模式，带关窗守卫）。
let _soWin = null
let _soAllowClose = false
function createSunOutageWindow() {
  _soWin = openTool(_soWin, { key: 'suntool', page: 'suntool.html', title: '日凌预报 · GSO', w: 1500, h: 900, minW: 1160, minH: 700, guard: 'suntool:closeRequested' },
    { allowed: () => _soAllowClose, setAllowed: (v) => { _soAllowClose = v }, onClosed: () => { _soWin = null } })
  return _soWin
}
function confirmCloseSunOutage() {
  _soAllowClose = true
  if (_soWin && !_soWin.isDestroyed()) _soWin.close()
}

// 干扰分析（C/I）：独立 BrowserWindow，单例复用。
// 不设关窗守卫——本窗口是纯只读计算器（读三库与 GRD、不写回），面板状态自动落 localStorage，
// 关窗不会丢任何用户数据，弹确认框只是徒增一步。
let _ciWin = null
let _pfdWin = null
function createPfdWindow() {
  _pfdWin = openTool(_pfdWin, { key: 'pfd', page: 'pfd.html', title: 'PFD EIRP Mask 生成器（ITU-R S.1503）', w: 1500, h: 950, minW: 1160, minH: 720 },
    { onClosed: () => { _pfdWin = null } })
  return _pfdWin
}

// 空间态势报告：独立 BrowserWindow，单例复用。
// 设关窗守卫（与三个链路预算窗口、雨衰窗口同套）——报告的「配置」是一整套攒到最后才存的输入
// （范围 / 章节开关 / Top N 一类），不是频率计划那种改一下即落盘的文件，关窗有可丢之物。
let _ssaWin = null
let _ssaAllowClose = false
function createSsaWindow() {
  _ssaWin = openTool(_ssaWin, { key: 'ssa', page: 'ssa.html', title: '空间态势报告', w: 1500, h: 950, minW: 1160, minH: 720, guard: 'ssa:closeRequested' },
    { allowed: () => _ssaAllowClose, setAllowed: (v) => { _ssaAllowClose = v }, onClosed: () => { _ssaWin = null } })
  return _ssaWin
}

// 转发器频率计划：独立 BrowserWindow，单例复用。
// 不设关窗守卫——编辑器每次改动即存盘（频率计划是「文件」不是「会话」，与三个链路预算窗口
// 那种「一整套输入攒到最后才存」的形态不同），关窗无可丢之物。
let _freqPlanWin = null
function createFreqPlanWindow() {
  _freqPlanWin = openTool(_freqPlanWin, { key: 'freqplan', page: 'freqplan.html', title: '转发器频率计划', w: 1560, h: 980, minW: 1180, minH: 720 },
    { onClosed: () => { _freqPlanWin = null } })
  return _freqPlanWin
}
// 定向广播给频率计划编辑窗。文件区删/改名后不通知它，它手里还是删除前那一份，
// 600ms 后的自动存盘会把计划连文件带索引整份写回来（见 FreqPlanApp 的 doSave）。
function notifyFreqPlan(channel, ...args) {
  if (!_freqPlanWin || _freqPlanWin.isDestroyed()) return
  try { _freqPlanWin.webContents.send(channel, ...args) } catch { /* 窗口正在关 */ }
}

function createCiWindow() {
  _ciWin = openTool(_ciWin, { key: 'ci', page: 'ci.html', title: '干扰分析', w: 1560, h: 940, minW: 1180, minH: 740 },
    { onClosed: () => { _ciWin = null } })
  return _ciWin
}

// 卫星模型工作台：独立 BrowserWindow，单例复用。
// 设关窗守卫（2026-10-06 设计页文档标签条，任务书 §3.4）——元数据改动虽即时落盘，但装配签的提交是「停手 1.5 s 自动入库」，
// 多个签各有排着的草稿 / 入库作业，关窗有可丢之物。与链路预算窗口的「转问用户」不同，这里不弹框：close 时转给渲染端
// （modelwb:closeRequested），渲染端同步写全部签草稿、等待存的入库作业跑完后回 modelwb:confirmClose 才真关；
// 渲染端卡住 / 没挂监听，3 s 后主进程自己放行（autoReleaseMs；草稿已在渲染端同步段写上，下次开窗按草稿恢复）。
// _modelAllowClose 已登记进 before-quit 放行表（updaterPending.test.mjs ⑤ 源码级对账）。
// 菜单：2026-10-14 起全平台 Menu.setApplicationMenu(null)，缺省菜单的 Ctrl+W / Ctrl+R / Alt 都没了绑定
// （Ctrl+W / Ctrl+Tab 由渲染端按文档签处理）；removeMenu() 留着无妨。
let _modelWin = null
let _modelAllowClose = false
function createModelWindow() {
  _modelWin = openTool(_modelWin, { key: 'model', page: 'model.html', title: '模型工作台', w: 1560, h: 960, minW: 1180, minH: 720, guard: 'modelwb:closeRequested', autoReleaseMs: 3000, removeMenu: true },
    { allowed: () => _modelAllowClose, setAllowed: (v) => { _modelAllowClose = v }, onClosed: () => { _modelWin = null } })
  return _modelWin
}
function confirmCloseModel() {
  _modelAllowClose = true
  if (_modelWin && !_modelWin.isDestroyed()) _modelWin.close()
}

// 雨衰计算：独立 BrowserWindow，单例复用（通用于各类卫星；与链路预算工作台同模式，带关窗守卫）。
let _rainWin = null
let _rainAllowClose = false
function createRainWindow() {
  _rainWin = openTool(_rainWin, { key: 'rain', page: 'rain.html', title: '雨衰计算', w: 1440, h: 900, minW: 1100, minH: 720, guard: 'rain:closeRequested' },
    { allowed: () => _rainAllowClose, setAllowed: (v) => { _rainAllowClose = v }, onClosed: () => { _rainWin = null } })
  return _rainWin
}
// ---- 性能指标表窗口（对地 / 对星 / 气象）：一根天线一窗、可多开；主进程只当【中继】----
// 表的数据与取值全在主窗口（3D 页）：它算好行推给弹窗（perfwin:push → perfwin:msg），弹窗上的每个
// 操作发回主窗口（perfwin:act），主窗口改了状态再推回来。窗口本身只有一份 perf.html，按
// ?kind=ground|shell|met 决定装哪张表。同一 (kind,key) 只开一个，再开＝前置。
const _perfWins = new Map()   // id → { win, kind, key }
let _perfSeq = 1
// 几何记忆：按表的种类各记一份（尺寸 / 位置 / 是否最大化），落 <userData>/perfwin-bounds.json，下次开同类表原样回来。
// 位置只在仍落在某块屏幕的工作区内时才用（外接屏拔掉后别把窗口开到屏外）；同类多扇窗以最后动过的那扇为准。
// 存取与钳屏与计算窗同一套（services/windowGuard.js 的 clampBounds / rememberBounds），文件与键不变。
const PW_DEFAULT = { ground: [980, 660], shell: [1040, 660], met: [980, 660] }
function perfWinGeometry(kind) {
  const [w0, h0] = PW_DEFAULT[kind] || PW_DEFAULT.ground
  return winShell().perfGeometry(kind, { width: w0, height: h0, minWidth: 640, minHeight: 420 })
}
function perfWinRemember(win, kind) { winShell().perfRemember(win, kind) }
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
  // 挂成主窗口的从属窗口：点主窗口（拖时间轴、调参数）时表仍浮在它上面，不被压到后面；
  // 主窗口最小化 / 还原时一起走。只压主窗口，不压别的程序（不用 alwaysOnTop）。
  const owner = _mainWin && !_mainWin.isDestroyed() ? _mainWin : undefined
  const win = new BrowserWindow({
    ...geo.opt,
    ...(owner ? { parent: owner } : {}),
    minWidth: 640,
    minHeight: 420,
    show: !geo.maximized,   // 记着最大化：maximize() 后再 show()，不闪一帧还原尺寸
    title: String(title || '性能指标表'),
    backgroundColor: winTheme.winBg(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      devTools: !app.isPackaged
    }
  })
  const q = `?id=${encodeURIComponent(id)}&kind=${encodeURIComponent(k)}&key=${encodeURIComponent(kk)}`
  loadPage(win, 'perf.html', q)
  bindDevTools(win)
  if (geo.maximized) { win.maximize(); win.show() }
  perfWinRemember(win, k)
  winShell().kit.watch(win)
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
  // 应用菜单置空（交互调研 F1）：Electron 缺省菜单（各窗 autoHideMenuBar 只是藏起来）带着 Ctrl+R 重载（绕过关窗守卫、
  // 丢掉撤销栈）、Ctrl+W 关窗、Ctrl+= / Ctrl+- / Ctrl+0 整页缩放、Ctrl+M 最小化 —— 在链路表里按 Ctrl+- 整页缩小就是它。
  // Windows 下输入框的 Ctrl+C / V / X / A / Z 由 Chromium 自己处理，不靠菜单；开发期 F12 / Ctrl+Shift+I 见 bindDevTools。
  // Ctrl+滚轮：Electron 不自动缩放（只发 zoom-changed，本平台不接）；触控板捏合的视觉缩放 Electron 缺省关着。
  Menu.setApplicationMenu(null)
  winTheme.initSource()   // 原生标题栏 / prefers-color-scheme 跟上次记住的应用外观（services/winTheme.js）
  winShell()   // 守卫通道（guard:ready / ack / cancel）在任何窗口报到之前挂上

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
  // 卫星 3D 模型：清单 / 下载缓存 / 导入 / 绑定表（services/models.js）。内置模型走 extraResources
  // （同 imagery：打包后在 asar 外的 resources/models，开发期读仓库 resources/models）。
  // 服务顶层不碰 electron，net / dialog / shell 从这里注入（它因此能在裸 node 里单测）。
  // models:// 的路径白名单、host 分派、>4 MB 流式、ACAO 头都在 models.handleProtocol 里。
  const { dialog, shell } = require('electron')
  const models = require(join(root, 'electron/services/models'))({
    appRoot: root,
    userDataDir: app.getPath('userData'),
    bundleDir: app.isPackaged ? join(process.resourcesPath, 'models') : join(root, 'resources', 'models'),
    electron: { net, dialog, shell }
  })
  protocol.handle('models', (req) => models.handleProtocol(req))
  const storage = require(join(root, 'electron/services/storage'))
  // 报表服务（顶层 require 了 exceljs + docx，同步约 200 ms）：第一次导出时才真正加载，不再压在建窗之前。
  // register 里只以 report.xxx(...) 取用，代理在第一次取成员时 require
  let _report = null
  const report = new Proxy({}, { get: (_t, k) => (_report || (_report = require(join(root, 'electron/services/report'))))[k] })
  const coverage = require(join(root, 'electron/services/coverage'))(join(root, 'resources/coverage'))
  const coverageGrd = require(join(root, 'electron/services/coverage'))(join(root, 'resources/coverage-grd'), join(app.getPath('userData'), 'coverage-grd-imported'))
  // 删用户导入的文件一律先进系统回收站（shell.trashItem），进不去再直接删（交互调研 A1）
  const trash = (p) => shell.trashItem(p)
  const coverageGxt = require(join(root, 'electron/services/coverageGxt'))(() => join(app.getPath('userData'), 'gxt-imported'), { trash })
  const share = require(join(root, 'electron/services/share'))()
  // GRD 取值服务（与 coverageGrd 共享导入目录）：链路预算逐站取值在主进程完成
  const grd = require(join(root, 'electron/services/grd'))(join(app.getPath('userData'), 'coverage-grd-imported'))
  // 转发器频率计划：挂在卫星下、与 GRD 天线平级的一类「文件」
  const freqPlan = require(join(root, 'electron/services/freqPlan'))(join(app.getPath('userData'), 'freq-plans'), { trash })
  // 和风天气 provider（实时/预报环境场的数据源）。凭据在 electron/services/weatherConfig.js（不进仓库）；
  // 未配置时 configured() 会如实报错，界面据此提示，不影响其余功能。
  const weather = require(join(root, 'electron/services/weather'))(app.getPath('userData'))
  // 气象栅格 provider（实时/预报**场**的数据源）：NCEP GFS，走 NOMADS 子集服务。
  // 公共领域数据、无需凭据、可商用 —— 与和风那条按量计费的线互不相干。
  const gfs = require(join(root, 'electron/services/gfs'))(app.getPath('userData'))
  // 激活与设备管理：终端心跳上报 + 激活书拉取验签（对端为独立的「卫星仿真平台管理」软件）
  const activation = require(join(root, 'electron/services/activation'))(share, storage)
  const { register } = require(join(root, 'electron/ipc/register'))
  register({ core, storage, report, coverage, coverageGrd, coverageGxt, share, openLinkBudget: createLinkBudgetWindow, openSunOutage: createSunOutageWindow, confirmCloseSunOutage, grd, confirmCloseLinkBudget, openNgso: createNgsoWindow, confirmCloseNgso, openRegen: createRegenWindow, confirmCloseRegen, openE2e: createE2eWindow, confirmCloseE2e, openRain: createRainWindow, confirmCloseRain, openCi: createCiWindow, openPfd: createPfdWindow, openSsa: createSsaWindow, confirmCloseSsa, freqPlan, openFreqPlan: createFreqPlanWindow, notifyFreqPlan, activation, weather, gfs, updater,
    perfWin: { open: createPerfWindow, push: perfWinPush, act: perfWinAct, close: perfWinClose, setTitle: perfWinSetTitle, list: perfWinList, self: perfWinSelf },
    models, openModel: createModelWindow, confirmCloseModel,
    quitApp: () => requestQuit(), sceneRelay })
  // 模型服务的变化（远端清单 / 下载进度 / 导入 / 元数据 / 绑定 / 缓存）广播到所有窗口：3D 页、侧栏、工作台各自取需要的
  models.onChange((ev) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('models:changed', ev) } catch { /* 窗口正在关 */ }
    }
  })
  // 远端清单：启动 30 s 后刷一次、之后每 24 h（失败静默写 models.log）
  models.start()
  app.on('will-quit', () => { try { models.stop() } catch { /* 退出中 */ } })
  // 定时心跳；激活状态变化（管理端激活/撤销被拉到）广播到所有窗口，各窗口就地上锁/解锁
  activation.start((st) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('activation:changed', st) } catch { /* 窗口正在关 */ }
    }
  })

  const win = createWindow()
  _booted = true

  // 加载 ITU 全精度数据（降雨率 P.837 / 海拔 P.1511 / 水汽 P.836 / 云 P.840）→ 注入计算内核，
  // 与小程序口径完全一致（小程序为云端下载，桌面端从本地 resources/itu 同步加载）。
  // ★ 放在建窗【之后】、同一个任务里同步做完：窗口的渲染进程先拉起来并行加载，而任何 IPC 都要等这段跑完才处理得到，
  //   计算内核拿到的仍是注入后的数据（与原来建窗前注入逐位同一状态）
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
//   这张表与全部 `let _*AllowClose = false` 声明由 packages/core/test/updaterPending.test.mjs
//   第 ⑤ 节源码级逐个对账，漏一个单测就红。
// 守卫（_*AllowClose=false → close 时 preventDefault 转问渲染进程）是为「用户点窗口 X」设计的，
// 但它对 close 事件一视同仁，因此会把整个退出流程也一并拦下：
//   · Windows 注销 / 关机：退出被 preventDefault 挡住 → 系统等超时后强杀，本来防丢数据反而丢；
//   · 自动更新的「退出时安装」挂在 app 'quit' 上：退出被挡住 → 更新装不上且无任何提示。
// 正常路径不受影响：主动退出走 requestQuit（主窗口 X / 菜单「退出」），计算窗早已逐个关过、各自弹过「配置存了没」，
// 走到这里只剩主窗、性能表与隐藏窗 → 本处是纯兜底。_quitting 让 windowGuard 的守卫与主窗口的 close 拦截一并放行。
app.on('before-quit', () => {
  _quitting = true
  _lbAllowClose = true
  _ngsoAllowClose = true
  _regenAllowClose = true
  _e2eAllowClose = true
  _soAllowClose = true
  _rainAllowClose = true
  _ssaAllowClose = true
  _modelAllowClose = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
