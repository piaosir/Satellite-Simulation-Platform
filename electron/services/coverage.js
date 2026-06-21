// GEO 卫星覆盖数据服务（主进程）：从 resources/coverage 读取索引与各波束等值线 JSON。
// 数据由 scripts/build-coverage.js 从 Satellitelinkbudget/CoverageCloudData 生成。
const fs = require('fs')
const path = require('path')

module.exports = function createCoverage(baseDir) {
  function index() {
    try { return JSON.parse(fs.readFileSync(path.join(baseDir, 'index.json'), 'utf8')) }
    catch (e) { return { satellites: [], error: e.message } }
  }
  // file 形如 "中星10R/CHINASAT 10R_Ku_中国波束_EIRP.json"；做基本的路径穿越防护
  function get(file) {
    const safe = String(file || '').replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '')
    const fp = path.join(baseDir, safe)
    if (!fp.startsWith(baseDir)) throw new Error('非法路径')
    return JSON.parse(fs.readFileSync(fp, 'utf8'))
  }
  return { index, get }
}
