// 「检查更新」的状态快照（纯逻辑，不依赖 electron，供 updater.js 与 packages/core/test/updaterState.test.mjs 共用）
//
// electron-updater 的事件是零散的（checking-for-update / update-available / download-progress /
// update-downloaded / update-not-available / error），对话框要的是一份能直接渲染的快照。这里把
// 事件折进快照：phase 是唯一的分支依据，其余字段随 phase 填。
//
// phase：
//   idle        还没检查过（启动后首查之前）
//   disabled    未打包（开发模式），不检查
//   checking    正在向源请求 latest.yml
//   downloading 发现新版，后台下载中（percent 随 download-progress 走）
//   downloaded  已下载完成，可立即重启安装。也可能来自上个会话：启动首查命中缓存包时
//               electron-updater 不重下，直接再发一次 update-downloaded
//   latest      已是最新
//   error       检查或下载出错。此前已下载完成的不降级（包还在、仍可装），错误文字只记在 error 字段
//
// 两条防抖：已在下载 / 已下载时再检查（手动点「检查更新」）不许把进度打回 checking → 0%；
// 同一版本再次 update-available（每次检查命中缓存都会再发）也原样保持。
'use strict'

function initial(current) {
  return { phase: 'idle', current: String(current || ''), latest: '', percent: 0, transferred: 0, total: 0, error: '', checkedAt: 0 }
}

const clampPct = (p) => { const n = Number(p); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0 }
const bytes = (b) => { const n = Number(b); return Number.isFinite(n) && n > 0 ? n : 0 }

// 错误文字：网络类 / 校验类归成一句，其余取首行。原文进日志（updater.log），界面只要一句能懂的
const NET_RE = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK|ERR_TIMED_OUT|ERR_PROXY|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|net::/i
function friendlyError(raw) {
  const m = raw == null ? '' : (typeof raw === 'string' ? raw : (raw.message || String(raw)))
  if (!m.trim()) return '未知错误'
  if (NET_RE.test(m)) return '无法连接更新服务器'
  if (/sha512|checksum/i.test(m)) return '安装包校验失败'
  if (/ERR_UPDATER_INVALID_VERSION/.test(m)) return '更新源的版本号无效'
  if (/\b404\b/.test(m)) return '更新源上没有版本描述文件'
  if (/cancel/i.test(m)) return '下载已取消'
  const line = m.split(/\r?\n/)[0].trim()
  return line.length > 160 ? line.slice(0, 159) + '…' : line
}

function reduce(s, ev, now = Date.now()) {
  const t = ev && ev.type
  const keepPkg = s.phase === 'downloading' || s.phase === 'downloaded'
  switch (t) {
    case 'disabled':
      return { ...s, phase: 'disabled', error: '' }
    case 'checking':
      if (keepPkg) return s.error ? { ...s, error: '' } : s
      return { ...s, phase: 'checking', error: '' }
    case 'available': {
      const v = typeof ev.version === 'string' && ev.version ? ev.version : s.latest
      if (keepPkg && s.latest === v) return { ...s, error: '', checkedAt: now }
      return { ...s, phase: 'downloading', latest: v, percent: 0, transferred: 0, total: 0, error: '', checkedAt: now }
    }
    case 'progress':
      if (s.phase === 'downloaded') return s
      return { ...s, phase: 'downloading', percent: clampPct(ev.percent), transferred: bytes(ev.transferred), total: bytes(ev.total) }
    case 'downloaded': {
      const v = typeof ev.version === 'string' && ev.version ? ev.version : s.latest
      return { ...s, phase: 'downloaded', latest: v, percent: 100, error: '', checkedAt: now }
    }
    case 'not-available': {
      const v = typeof ev.version === 'string' && ev.version ? ev.version : s.current
      return { ...s, phase: 'latest', latest: v, percent: 0, transferred: 0, total: 0, error: '', checkedAt: now }
    }
    case 'error': {
      const msg = friendlyError(ev.message)
      if (s.phase === 'downloaded') return { ...s, error: msg }
      return { ...s, phase: 'error', error: msg }
    }
    default:
      return s
  }
}

module.exports = { initial, reduce, friendlyError }
