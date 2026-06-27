// 自动更新服务（electron-updater + 腾讯云 COS 静态源）
//
// 工作流程（全自动）：
//   1. App 启动后静默向 COS 源请求 latest.yml，比对版本
//   2. 发现新版 → 后台静默下载（支持 .blockmap 差量，省流量），不打扰用户
//   3. 下载完成 → 弹原生对话框，用户选「立即重启」即装新版
//
// 更新源地址在 package.json 的 build.publish 中配置（generic provider）。
// 本模块只负责行为逻辑，源地址由打包时生成的 app-update.yml 决定。

const { app, dialog } = require('electron')

let started = false

function initAutoUpdate(win) {
  // 开发模式不检查更新（没有 app-update.yml，且会报错刷屏）
  if (!app.isPackaged) return
  if (started) return
  started = true

  // 延迟 require：仅在打包环境加载，避免 dev 下找不到模块
  const { autoUpdater } = require('electron-updater')

  // 不自动下载由我们控制时机；这里设为 true 表示发现即后台下载（符合「全自动」体验）
  autoUpdater.autoDownload = true
  // 退出时自动安装已下载的更新（用户若不点重启，下次退出也会装上）
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    // 离线 / 源不可达等情况静默忽略，不打扰用户
    console.warn('[updater] 检查更新失败：', err && err.message ? err.message : err)
  })

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] 发现新版本：', info && info.version)
  })

  autoUpdater.on('download-progress', (p) => {
    console.log(`[updater] 下载中 ${p.percent != null ? p.percent.toFixed(1) : '?'}%`)
  })

  autoUpdater.on('update-downloaded', async (info) => {
    console.log('[updater] 新版本已下载完成：', info && info.version)
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['立即重启更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '发现新版本',
      message: `新版本 ${info && info.version ? info.version : ''} 已下载完成`,
      detail: '点击「立即重启更新」完成安装，或选择「稍后」（下次关闭程序时会自动更新）。'
    })
    if (response === 0) {
      // 退出并安装；isSilent=false 显示安装进度，isForceRunAfter=true 装完自动重开
      autoUpdater.quitAndInstall(false, true)
    }
  })

  // 启动后稍等再检查，避开窗口初始化高峰
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 3000)
}

module.exports = { initAutoUpdate }
