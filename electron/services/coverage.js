// GEO 卫星覆盖数据服务（主进程）：从 resources/coverage 读取索引与各波束等值线 JSON。
// 数据由 scripts/build-coverage.js 从 Satellitelinkbudget/CoverageCloudData 生成。
const fs = require('fs')
const path = require('path')
const gaussStk = require('../../packages/core/utils/gaussStk.js')

// 解析高斯天线记录（STK Gaussian 参数，见 packages/core/utils/gaussStk.js）：与导入的 GRD 同目录存放，后缀 .gauss.json。
const AN_EXT = '.gauss.json'
const isAnFile = (f) => /\.gauss\.json$/i.test(String(f || ''))
// 记录按 latin1 逐字节落盘 / 读回：非 ASCII 一律转 \uXXXX（合法 JSON 里非 ASCII 只可能在字符串内，转义不改语义），
// 与渲染端 recordToText 同一口径；再校验一遍，坏记录不落盘。
function anText(text) {
  const s = String(text == null ? '' : text)
  let t = ''
  for (let i = 0; i < s.length; i++) { const k = s.charCodeAt(i); t += k < 0x7f ? s.charAt(i) : '\\u' + k.toString(16).padStart(4, '0') }   // 按 UTF-16 码元转（四字节字符拆成一对 \uD8xx\uDCxx，JSON.parse 拼回）
  gaussStk.parseRecord(t)
  return t
}

// baseDir：预置覆盖数据（只读）。saveDir：用户导入的原始 GRD 持久化目录（可写，通常在 userData），
// 仅 coverageGrd 实例传入；用户每次导入的 .grd 原文存盘，重载后据此重建天线。
module.exports = function createCoverage(baseDir, saveDir) {
  saveDir = saveDir ? path.resolve(saveDir) : saveDir   // 规范化（统一分隔符），使下面的路径前缀校验稳健（同 services/grd.js）
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
    if (isAnFile(name)) {
      // 解析天线记录：保留 .gauss.json；基名同样清洗，再削掉首尾的点（否则会拼出 'x..gauss.json'，resolveSaved 删 '..' 后对不上）
      const body = anText(text)
      const base = String(name).replace(/\.gauss\.json$/i, '').replace(/[^\w.\-]+/g, '_').replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '') || 'imported'
      let fname = base + AN_EXT, i = 1
      while (fs.existsSync(path.join(saveDir, fname))) fname = `${base}_${++i}${AN_EXT}`
      fs.writeFileSync(path.join(saveDir, fname), body, 'latin1')
      return { file: fname }
    }
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
    // 解析天线记录只有几 KB：读进来校验、转纯 ASCII，走 save 的同一套命名（保留 .gauss.json）
    if (isAnFile(srcPath)) return save(path.basename(String(srcPath)), fs.readFileSync(srcPath, 'utf8'))
    fs.mkdirSync(saveDir, { recursive: true })
    const cleaned = path.basename(String(srcPath || '')).replace(/\.(grd|pat)$/i, '').replace(/[^\w.\-]+/g, '_').replace(/\.+/g, '.') || 'imported'
    let fname = cleaned + '.grd', i = 1
    while (fs.existsSync(path.join(saveDir, fname))) fname = `${cleaned}_${++i}.grd`
    fs.copyFileSync(srcPath, path.join(saveDir, fname))
    return { file: fname }
  }
  // saveDir 内的绝对路径（防路径穿越）
  function resolveSaved(file) {
    if (!saveDir) throw new Error('未配置导入存储目录')
    const safe = String(file || '').replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '')
    const fp = path.join(saveDir, safe)
    if (!fp.startsWith(saveDir)) throw new Error('非法路径')
    return fp
  }
  // 读回导入的原始 GRD 文本
  function raw(file) { return { text: fs.readFileSync(resolveSaved(file), 'latin1') } }
  // 解析天线记录的就地改写（参数改了回存同一文件：文件名即天线身份，树 / 存档 / 链路预算的引用都不用动）。
  // 只许 saveDir 根下已存在的 *.gauss.json，内容须是合法记录；tmp + rename 原子落盘。
  // 旁边的 .grdbin 当场删掉：主进程下次取值按新参数重铺，不押在 mtime 比较上（同一时间片内改写也不会读到旧网格）。
  function overwrite(file, text) {
    const fp = resolveSaved(file)
    if (!isAnFile(fp) || path.dirname(fp) !== saveDir) throw new Error('只能改写解析天线记录')
    if (!fs.statSync(fp).isFile()) throw new Error('只能改写解析天线记录')   // 不在 → statSync 抛 ENOENT
    const body = anText(text)
    const tmp = fp + '.tmp'
    fs.writeFileSync(tmp, body, 'latin1')
    try { fs.renameSync(tmp, fp) } catch (e) { try { fs.unlinkSync(tmp) } catch { /* 已不在 */ } throw e }
    try { fs.unlinkSync(fp + '.grdbin') } catch { /* 尚未生成 */ }
    return { file: path.basename(fp) }
  }
  // 导出直通用：原文件绝对路径 + 是不是本平台的合成件（表头有 SYNTHMETA，只读头 64KB 判）。
  // 合成件导出前要重打包到公共网格（转换器是渲染端 ESM），只有它才需要把文本搬过 IPC；
  // 真实导入件按字节拷贝即可 —— 实测件 243 MB，搬进渲染进程再转字节必崩（见 FileManager.toBytes 的注释）。
  function exportSrc(file) {
    const fp = resolveSaved(file)
    fs.statSync(fp)                                 // 文件不在 → 抛错，上层给准话
    // 解析天线记录：没有网格原文可拷，导出一律由渲染端按参数现铺 GRD 文本（gaussStk.toGrdText），不嗅探
    if (isAnFile(fp)) return { path: fp, synth: true, analytic: true }
    let synth = false, fd = null
    try {
      fd = fs.openSync(fp, 'r')
      const buf = Buffer.alloc(65536)
      const got = fs.readSync(fd, buf, 0, 65536, 0)
      synth = buf.subarray(0, got).includes('SYNTHMETA')
    } catch { /* 头读不到就当真实导入件，走按字节拷贝 */ }
    finally { if (fd !== null) { try { fs.closeSync(fd) } catch { /* 已关 */ } } }
    return { path: fp, synth }
  }
  // 删除已持久化的导入 GRD（删天线/卫星时清理；不存在则静默）
  function remove(file) {
    if (!saveDir || !file) return { ok: false }
    const fp = resolveSaved(file)                   // 非法路径照旧抛错，不吞
    try { fs.unlinkSync(fp) } catch { /* 已不在 */ }
    return { ok: true }
  }
  return { index, get, save, copyIn, raw, overwrite, exportSrc, remove, sniffHead }
}
