// GEO 卫星覆盖数据服务（主进程）：从 resources/coverage 读取索引与各波束等值线 JSON。
// 数据由 scripts/build-coverage.js 从 Satellitelinkbudget/CoverageCloudData 生成。
const fs = require('fs')
const path = require('path')

// baseDir：预置覆盖数据（只读）。saveDir：用户导入的原始 GRD 持久化目录（可写，通常在 userData），
// 仅 coverageGrd 实例传入；用户每次导入的 .grd 原文存盘，重载后据此重建天线。
module.exports = function createCoverage(baseDir, saveDir) {
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

  // ---- 用户导入的原始 GRD 持久化（仅 saveDir 配置时可用）----
  // 文件名从导入名清洗（仅留字母/数字/._-），同名加 _2、_3… 去重，原样字节（latin1）写盘。
  function save(name, text) {
    if (!saveDir) throw new Error('未配置导入存储目录')
    fs.mkdirSync(saveDir, { recursive: true })
    const cleaned = String(name || 'imported').replace(/\.(grd|pat|txt|ant|pattern)$/i, '').replace(/[^\w.\-]+/g, '_').replace(/\.+/g, '.') || 'imported'
    let fname = cleaned + '.grd', i = 1
    while (fs.existsSync(path.join(saveDir, fname))) fname = `${cleaned}_${++i}.grd`
    fs.writeFileSync(path.join(saveDir, fname), String(text == null ? '' : text), 'latin1')
    return { file: fname }
  }
  // 轻量嗅探（只读头 64KB）：判断是不是 GRASP 网格。判据与 src/viz/grd/patFormats.js 的
  // sniffPatternFormat 同源，但这里【只需要区分能不能按字节拷贝】，故不做完整解析，返回中文名或 'grasp'。
  function sniffHead(srcPath) {
    let buf
    try {
      const fd = fs.openSync(srcPath, 'r'); buf = Buffer.alloc(65536)
      const got = fs.readSync(fd, buf, 0, 65536, 0); fs.closeSync(fd)
      buf = buf.subarray(0, got)
    } catch { return null }
    const L = buf.toString('latin1').split(/\r\n|\n|\r/)
    if (/^#CAL1/.test(L[0] || '')) return 'ACP4 方向图'
    for (const l of L) {
      const t = l.trim()
      if (!/^\+{4}/.test(t)) continue
      const id = /^\+{4}(\d{4})\s*$/.exec(t)
      return id ? `SATSOFT ++++${id[1]} 文件` : 'grasp'
    }
    const f = (L[1] || '').trim().split(/[\s,]+/).filter(Boolean)
    if (f.length === 6 && f.every((v) => v !== '' && Number.isFinite(+v))) return 'Eutelsat 方向图'
    return null                                   // 认不出：放行，交给后面的解析器报错
  }
  // 直接把磁盘上的 .grd 拷进 saveDir（不经渲染进程搬文本）。
  // 「星座3D」页导入要在渲染端解析出投影/场，故走 open()+save(text)；链路预算只需要主进程按文件采样，
  // 没有理由把动辄一两百 MB 的文本过一趟 IPC —— 这里按字节拷贝，重名规则与 save 一致。
  function copyIn(srcPath) {
    if (!saveDir) throw new Error('未配置导入存储目录')
    fs.mkdirSync(saveDir, { recursive: true })
    const cleaned = path.basename(String(srcPath || '')).replace(/\.(grd|pat)$/i, '').replace(/[^\w.\-]+/g, '_').replace(/\.+/g, '.') || 'imported'
    let fname = cleaned + '.grd', i = 1
    while (fs.existsSync(path.join(saveDir, fname))) fname = `${cleaned}_${++i}.grd`
    fs.copyFileSync(srcPath, path.join(saveDir, fname))
    return { file: fname }
  }
  // 读回导入的原始 GRD 文本（限定在 saveDir 内，防路径穿越）
  function raw(file) {
    if (!saveDir) throw new Error('未配置导入存储目录')
    const safe = String(file || '').replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '')
    const fp = path.join(saveDir, safe)
    if (!fp.startsWith(saveDir)) throw new Error('非法路径')
    return { text: fs.readFileSync(fp, 'latin1') }
  }
  // 删除已持久化的导入 GRD（删天线/卫星时清理；不存在则静默）
  function remove(file) {
    if (!saveDir || !file) return { ok: false }
    const safe = String(file).replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '')
    const fp = path.join(saveDir, safe)
    if (!fp.startsWith(saveDir)) throw new Error('非法路径')
    try { fs.unlinkSync(fp) } catch { /* 已不在 */ }
    return { ok: true }
  }
  return { index, get, save, copyIn, raw, remove, sniffHead }
}
