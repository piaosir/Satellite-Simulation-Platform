// 星历取数链路的操作日志：主进程 → 渲染进程底部「日志」窗格。
// 打包后的客户端里主进程 console 用户看不见，而星历取哪来、为什么走兜底、回传成没成功，
// 恰恰是现场最需要能自证的一段。故每条明细都：① 打进主进程 console（开发/终端）；
// ② 广播到所有窗口的日志窗格（src/App.vue 订阅 omm:log → logStore）。
const CONSOLE = { info: 'log', warn: 'warn', error: 'error' }

// 统一格式化：日志里所有数据量/耗时/时间戳都用同一套写法，便于横向比对。
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB')
const fmtSec = (ms) => (ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's')
const p2 = (n) => String(n).padStart(2, '0')
// 时间一律转本地时区显示到分钟（用户看的是自己机器的钟）
function fmtTime(t) {
  if (!t) return '未知'
  const d = t instanceof Date ? t : new Date(t)
  if (isNaN(d.getTime())) return '未知'
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

function emit(text, level = 'info') {
  const fn = console[CONSOLE[level] || 'log']
  try { fn('[omm] ' + text) } catch {}
  try {
    const { BrowserWindow } = require('electron')
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('omm:log', { text, level })
    }
  } catch { /* 无 Electron（脚本 / 测试环境）：只走 console */ }
}

module.exports = { emit, fmtBytes, fmtSec, fmtTime }
