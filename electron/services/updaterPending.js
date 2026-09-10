// 启动时补装的纯逻辑（不依赖 electron，供 updater.js 与 packages/core/test/updaterPending.test.mjs 共用）
//
// 背景：Windows 关机 / 重启 / 注销时 Electron 不发 before-quit / will-quit / quit（官方文档明示），
// electron-updater 挂在 quit 上的「退出时安装」在直接关机场景根本不跑；就算跑了，NSIS 静默安装器
// 也会被系统一并杀掉。所以下载完成时落一个标记文件，下次启动先看标记：比自己新且 sha512 校验通过
// 就直接拉起安装器并退出，由安装器装完重开程序（--force-run）。
//
// 标记文件 <userData>/pending-update.json：
//   version / file / sha512 / isAdminRightsRequired / downloadedAt   ← 来自 update-downloaded 事件
//   attempts            启动时补装已尝试次数；到 MAX_ATTEMPTS 不再在启动时装，留给退出时安装
//                       （典型场景：装给「所有用户」的机器每次都弹 UAC、用户每次都取消 → 不能无限循环）
//   installing / installStartedAt / installerPid
//                       安装进行中：其间用户再双击图标启动的实例必须直接退出，别开窗——此时安装目录
//                       正被卸载器删、被 7z 覆盖，开窗只会让 NSIS 静默跳过占用中的文件、装出个残缺版
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const MARKER_NAME = 'pending-update.json'
const MAX_ATTEMPTS = 2
// 安装进行中的判定窗口：超过它即使 pid 还活着也不当回事（pid 被别的进程复用的概率随时间上升）
const INSTALL_GRACE_MS = 10 * 60 * 1000
// 与 electron-updater NsisUpdater.doInstall 同一套参数：--updated 走更新模式（保留快捷方式、跳过页面），
// /S 静默，--force-run 装完拉起程序（NSIS 只在静默模式下认这个开关）
const INSTALLER_ARGS = ['--updated', '/S', '--force-run']

// 数字点分版本比较：1.4.10 > 1.4.8；预发布后缀（-beta）忽略。返回 -1 / 0 / 1
function cmpVersion(a, b) {
  const num = (v) => String(v == null ? '' : v).split(/[.+-]/).map((s) => parseInt(s, 10)).filter(Number.isFinite)
  const pa = num(a), pb = num(b)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function readMarker(file) {
  let txt
  try { txt = fs.readFileSync(file, 'utf8') } catch { return null }
  try {
    const o = JSON.parse(txt)
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch { return null }
}

// 先写临时文件再改名：半截标记比没有标记更糟（会被当成残缺清掉，等于白下了一次）
function writeMarker(file, obj) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, file)
}

function removeMarker(file) {
  try { fs.unlinkSync(file) } catch {}
}

// update-downloaded 事件载荷 = latest.yml 的 updateInfo + downloadedFile（electron-updater executeDownload）。
// 同一个包（sha512 相同）重复触发（每次启动 checkForUpdates 命中缓存都会再发一次）时保留 attempts，
// 否则「尝试两次就放弃」的闸每个会话都会被复位。
function markerFromDownloaded(info, existing, now = Date.now()) {
  if (!info || typeof info.version !== 'string' || typeof info.downloadedFile !== 'string') return null
  const f0 = Array.isArray(info.files) && info.files[0] ? info.files[0] : null
  const sha512 = typeof info.sha512 === 'string' ? info.sha512 : (f0 && typeof f0.sha512 === 'string' ? f0.sha512 : null)
  if (!sha512) return null
  const same = !!existing && existing.sha512 === sha512
  return {
    version: info.version,
    file: info.downloadedFile,
    sha512,
    isAdminRightsRequired: info.isAdminRightsRequired === true || !!(f0 && f0.isAdminRightsRequired === true),
    downloadedAt: new Date(now).toISOString(),
    attempts: same ? (existing.attempts || 0) : 0,
    installing: false
  }
}

// 启动时的决策。返回 { action, reason }：
//   none     没有标记，照常启动
//   clear    标记作废（装完了 / 残缺 / 包不在了）→ 删标记，照常启动
//   skip     尝试次数用尽 → 留着标记，照常启动，交给退出时安装
//   exit     安装正在进行 → 本进程静默退出，不开窗
//   install  拉起安装器并退出
function decide({ marker, currentVersion, argv = [], now = Date.now(), pidAlive = () => false, fileExists = () => false }) {
  if (!marker) return { action: 'none', reason: '无标记' }
  // 安装器装完用 --updated 重开程序：不管版本对不对都清标记（版本不对说明装坏了，交给 electron-updater 重来）
  if (argv.includes('--updated')) return { action: 'clear', reason: '安装器重开（--updated）' }
  if (marker.installing && marker.installerPid
    && now - (Number(marker.installStartedAt) || 0) < INSTALL_GRACE_MS
    && pidAlive(marker.installerPid)) {
    return { action: 'exit', reason: `安装进行中（pid ${marker.installerPid}）` }
  }
  if (typeof marker.version !== 'string' || typeof marker.file !== 'string' || typeof marker.sha512 !== 'string') {
    return { action: 'clear', reason: '标记残缺' }
  }
  if (cmpVersion(marker.version, currentVersion) <= 0) return { action: 'clear', reason: `当前已是 ${currentVersion}` }
  if (!fileExists(marker.file)) return { action: 'clear', reason: '安装包不在了' }
  const attempts = Number(marker.attempts) || 0
  if (attempts >= MAX_ATTEMPTS) return { action: 'skip', reason: `已尝试 ${attempts} 次，留给退出时安装` }
  return { action: 'install', reason: `${currentVersion} → ${marker.version}` }
}

// 与 latest.yml / update-info.json 同口径：sha512 + base64
function hashFileSha512(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512')
    fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('base64')))
  })
}

module.exports = {
  MARKER_NAME, MAX_ATTEMPTS, INSTALL_GRACE_MS, INSTALLER_ARGS,
  cmpVersion, readMarker, writeMarker, removeMarker, markerFromDownloaded, decide, hashFileSha512,
  markerPath: (userData) => path.join(userData, MARKER_NAME)
}
