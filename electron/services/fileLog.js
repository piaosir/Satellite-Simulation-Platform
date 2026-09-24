'use strict'
// 主进程的文件日志（updater.log / models.log 共用一份实现）。
// 从 updater.js 原样抽出来的：打包后 console 不可见，静默运行的后台流程（自动更新、模型下载与缓存）
// 出了问题只能靠日志文件回溯，两处要同一种格式、同一种截断口径，就别各抄一份。
const fs = require('fs')

const LOG_MAX_BYTES = 512 * 1024

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

module.exports = { createFileLogger, LOG_MAX_BYTES }
