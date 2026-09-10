// 自动更新服务（electron-updater + 腾讯云 COS 静态源），全程静默，不弹任何对话框
//
//   1. 启动 3 s 后静默向 COS 源请求 latest.yml 比对版本；之后每 4 h 例行重查，出错 10 min 后重试，
//      笔记本从睡眠唤醒 30 s 后再查一次——离线启动、之后才联网的会话也能拿到更新
//   2. 发现新版 → 后台静默下载（.blockmap 差量），完成后落 <userData>/pending-update.json 标记
//   3. 用户正常关闭程序 → electron-updater 挂在 quit 上的钩子静默装（--updated /S，装完不重开）
//   4. 直接关机 / 崩溃 / 强杀让 3 没跑 → 下次启动 applyPendingUpdate() 校验标记后拉起安装器
//      （--updated /S --force-run，装完自动重开）并退出。决策逻辑在 updaterPending.js
//
// 更新源地址在 package.json 的 build.publish 中配置（generic provider），打包时生成 app-update.yml。
// 日志：<userData>/updater.log。打包后 console 不可见，静默流程出问题只能靠它。

const { app, powerMonitor } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const P = require('./updaterPending')

const FIRST_CHECK_MS = 3 * 1000
const RECHECK_OK_MS = 4 * 60 * 60 * 1000
const RECHECK_ERR_MS = 10 * 60 * 1000
const RESUME_DELAY_MS = 30 * 1000
const LOG_MAX_BYTES = 512 * 1024

let started = false
let logger = null

// 追加写、超上限砍掉前一半。同步写：量小（每次检查几行、下载每 10% 一行），不值得上队列
function createFileLogger(file) {
  const write = (level, args) => {
    const line = `${new Date().toISOString()} [${level}] ${args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ')}\r\n`
    try {
      let size = 0
      try { size = fs.statSync(file).size } catch {}
      if (size > LOG_MAX_BYTES) {
        const buf = fs.readFileSync(file)
        fs.writeFileSync(file, buf.subarray(buf.length >> 1))
      }
      fs.appendFileSync(file, line)
    } catch {}
    if (level === 'error' || level === 'warn') console.warn(line.trim())
    else console.log(line.trim())
  }
  return {
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    debug: () => {}
  }
}

function getLogger() {
  if (!logger) logger = createFileLogger(path.join(app.getPath('userData'), 'updater.log'))
  return logger
}

const markerFile = () => P.markerPath(app.getPath('userData'))

// signal 0 只探测进程是否存在；EPERM = 在但没权限碰（提权后的安装器），也算活着
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return !!e && e.code === 'EPERM' }
}

function spawnOnce(cmd, args) {
  return new Promise((resolve, reject) => {
    let p
    try { p = spawn(cmd, args, { detached: true, stdio: 'ignore' }) } catch (e) { return reject(e) }
    p.once('error', reject)
    p.once('spawn', () => { p.unref(); resolve(p.pid) })
  })
}

// 与 electron-updater NsisUpdater.doInstall 同一套：需要管理员就走 resources/elevate.exe，
// 直接拉起遇 EACCES / UNKNOWN 也改走 elevate。注意走 elevate 时拿到的是 elevate.exe 的 pid，
// 它把安装器提权拉起后很快就退出，「安装进行中」的判定会提前失效——仅影响装给所有用户的机器
async function spawnInstaller(file, adminRequired, log) {
  const elevate = path.join(process.resourcesPath, 'elevate.exe')
  const viaElevate = () => spawnOnce(elevate, [file, ...P.INSTALLER_ARGS])
  try {
    if (adminRequired) return await viaElevate()
    return await spawnOnce(file, P.INSTALLER_ARGS)
  } catch (e) {
    log.warn(`[pending] 拉起安装器失败：${e && e.code ? e.code : ''} ${e && e.message ? e.message : e}`)
    if (e && (e.code === 'EACCES' || e.code === 'UNKNOWN')) {
      try { return await viaElevate() } catch (e2) {
        log.warn(`[pending] 提权拉起也失败：${e2 && e2.message ? e2.message : e2}`)
      }
    }
    return null
  }
}

// 启动时补装。返回 true = 调用方必须立刻 app.quit()，不建窗口、不注册 IPC：
// 要么安装器已拉起（装完它会自己重开程序），要么另一个安装正在进行。
// 返回 false = 照常启动（无标记 / 标记作废 / 尝试次数用尽 / 拉不起安装器）。
async function applyPendingUpdate() {
  if (!app.isPackaged) return false
  const log = getLogger()
  const file = markerFile()
  const marker = P.readMarker(file)
  const d = P.decide({
    marker, currentVersion: app.getVersion(), argv: process.argv, now: Date.now(),
    pidAlive, fileExists: (f) => { try { return fs.statSync(f).isFile() } catch { return false } }
  })
  if (d.action === 'none') return false
  log.info(`[pending] ${d.action}：${d.reason}`)
  if (d.action === 'clear') { P.removeMarker(file); return false }
  if (d.action === 'skip') return false
  if (d.action === 'exit') return true

  let sha = null
  try { sha = await P.hashFileSha512(marker.file) } catch (e) {
    log.warn(`[pending] 读安装包失败：${e && e.message ? e.message : e}`)
  }
  if (sha !== marker.sha512) {
    // 包坏了：删标记照常启动。electron-updater 下次检查时自己会发现 sha512 不符并重新下载
    log.warn('[pending] 安装包 sha512 不符，放弃本次补装')
    P.removeMarker(file)
    return false
  }
  // 先记一次尝试再拉起：拉起后本进程随即退出，没机会再补记
  const next = { ...marker, attempts: (Number(marker.attempts) || 0) + 1 }
  P.writeMarker(file, next)
  const pid = await spawnInstaller(marker.file, marker.isAdminRightsRequired === true, log)
  if (pid == null) return false
  P.writeMarker(file, { ...next, installing: true, installStartedAt: Date.now(), installerPid: pid })
  log.info(`[pending] 安装器已拉起（pid ${pid}）：${marker.file} ${P.INSTALLER_ARGS.join(' ')}`)
  return true
}

function initAutoUpdate() {
  // 开发模式不检查更新（没有 app-update.yml，且会报错刷屏）
  if (!app.isPackaged) return
  if (started) return
  started = true
  const log = getLogger()

  // 延迟 require：仅在打包环境加载，避免 dev 下找不到模块
  const { autoUpdater } = require('electron-updater')
  autoUpdater.logger = log
  // 发现即后台静默下载
  autoUpdater.autoDownload = true
  // 正常退出时静默装上已下载的更新（app 'quit' 事件；Windows 关机 / 注销不触发，由启动时补装兜底）
  autoUpdater.autoInstallOnAppQuit = true
  // 不用 web installer（分包下载），关掉省一条每次检查都打的警告
  autoUpdater.disableWebInstaller = true

  let timer = null
  const check = () => {
    autoUpdater.checkForUpdates().then(
      () => schedule(RECHECK_OK_MS, '例行'),
      () => schedule(RECHECK_ERR_MS, '检查失败')
    )
  }
  const schedule = (ms, why) => {
    clearTimeout(timer)
    timer = setTimeout(check, ms)
    log.info(`[updater] 下次检查 ${Math.round(ms / 60000)} min 后（${why}）`)
  }

  autoUpdater.on('error', (err) => {
    // 离线 / 源不可达 / 下载中断：记日志、稍后重试，不打扰用户。检查失败时 then 的拒绝分支也会排一次，
    // 两次 schedule 同一间隔，后者覆盖前者
    log.warn('[updater] ' + (err && err.message ? err.message : err))
    schedule(RECHECK_ERR_MS, '出错重试')
  })
  autoUpdater.on('update-available', (info) => log.info('[updater] 发现新版本：' + (info && info.version)))
  autoUpdater.on('update-not-available', (info) => log.info('[updater] 已是最新（源上 ' + (info && info.version) + '）'))
  let lastPct = -1
  autoUpdater.on('download-progress', (p) => {
    const pct = Math.floor((p && p.percent ? p.percent : 0) / 10) * 10
    if (pct !== lastPct) { lastPct = pct; log.info(`[updater] 下载 ${pct}%`) }
  })
  autoUpdater.on('update-downloaded', (info) => {
    const file = markerFile()
    const m = P.markerFromDownloaded(info, P.readMarker(file), Date.now())
    if (!m) { log.warn('[updater] 下载完成但事件缺版本 / 路径 / sha512，不落标记'); return }
    try { P.writeMarker(file, m) } catch (e) { log.warn('[updater] 写标记失败：' + (e && e.message ? e.message : e)); return }
    log.info(`[updater] 新版本 ${m.version} 已下载：${m.file}。正常关闭时安装；直接关机则下次启动补装（已尝试 ${m.attempts} 次）`)
  })

  // 睡眠唤醒：网络通常要几秒到几十秒才回来，等一会儿再查
  powerMonitor.on('resume', () => schedule(RESUME_DELAY_MS, '唤醒'))
  // 启动后稍等再查，避开窗口初始化高峰
  schedule(FIRST_CHECK_MS, '启动')
}

module.exports = { initAutoUpdate, applyPendingUpdate }
