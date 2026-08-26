// 行政边界数据包（resources/adm/{ISO3}-adm{1,2}.json，由 scripts/build-adm.mjs 生成）的读盘服务。
// 两百多个逐国文件不进渲染端打包（rollup 会为每个文件生成一个 chunk，实测默认堆 OOM），
// 改成随安装包分发、由主进程按需读、渲染端经 IPC 取。路径口径与内置 OMM 快照一致（app.getAppPath）。
const fs = require('fs')
const path = require('path')

let dir = null
function baseDir() {
  if (dir) return dir
  try { dir = path.join(require('electron').app.getAppPath(), 'resources', 'adm') } catch { dir = path.join(__dirname, '..', '..', 'resources', 'adm') }
  return dir
}

// lvl: 1|2；iso: ISO3。返回解析后的包对象；文件不存在返回 null（界面按「该国无包」处理）。
function pack(lvl, iso) {
  if (!/^[A-Z]{3}$/.test(String(iso || '')) || (lvl !== 1 && lvl !== 2)) return null
  const f = path.join(baseDir(), iso + '-adm' + lvl + '.json')
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null }
}

module.exports = { pack }
