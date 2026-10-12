// 星历点序列的采样表存储（主进程）。
//
// 【为什么与 custom.json 分家】custom.json 是「组清单」，文件管理、3D 地图分组、搜索池每次都要读它；
// 而一组 SP3 是 32 颗星 × 96 个历元 × 7 个数，几 MB 起步。把采样塞进 custom.json，等于每看一眼
// 组列表就把几十 MB 反序列化一遍。故组里只留元数据（key / name / 起止 / 点数 / 插值口径），
// 采样另存 userData/data/ephem/<groupId>.json，按需读、读了进 LRU。
//
// 【每颗星存什么】{ key, t, p, v, spans }：TEME 采样（渲染端与各引擎直接用）；
//   另可带 src:{ frame, p, v }（原帧原值，与 t 逐点对齐）与 fmt:{…}（格式私有的版式信息，如 .eph 的原表头）。
//   TEME 来回换帧会动末位（实测 .eph 的 15 位有效数字里约三成数值末位变了），同帧导出要逐位还原原值，只能存原值。
// 【原文】导入的原始字节另存 <groupId>.src（≤ SOURCE_MAX），整组同格式导出时原样吐回，逐字节等于用户手上那份文件。
//
// 【写】一律走 jsonStore.writeJsonAtomic：半截文件会被下一次读当成「空表」，紧接着的写再拿空表
// 整份覆盖，导入的星历就永久没了（与 custom.json 同一条教训）。
// 【删组】必须连采样文件与原文一起删，否则 userData 里会留一地孤儿文件。

const fs = require('fs')
const path = require('path')
const { writeJsonAtomic, readJsonSafe } = require('./jsonStore')

// 内存 LRU：NGSO 引擎每算一行都要取表，一组几 MB，留最近几组即可。
const LRU_MAX = 6
const _lru = new Map()   // groupId -> { sats:[…] }
// 原文体积上限：超过就不留（这类大文件用户手上本就有原件；同格式导出退化为规范重建，值仍逐位一致）
const SOURCE_MAX = 64 * 1024 * 1024

function dir() {
  const base = process.env.SATSIM_DATA_DIR ||
    path.join(require('electron').app.getPath('userData'), 'data')
  const d = path.join(base, 'ephem')
  fs.mkdirSync(d, { recursive: true })
  return d
}
const safeId = (groupId) => String(groupId).replace(/[^\w.-]/g, '_')
const fileOf = (groupId) => path.join(dir(), safeId(groupId) + '.json')
const srcFileOf = (groupId) => path.join(dir(), safeId(groupId) + '.src')

function touch(groupId, val) {
  if (_lru.has(groupId)) _lru.delete(groupId)
  _lru.set(groupId, val)
  while (_lru.size > LRU_MAX) _lru.delete(_lru.keys().next().value)
  return val
}

// sats: [{ key, t:[ms…], p:[km…], v:[km/s…]|null, spans, src?:{frame,p,v}, fmt?:{…} }]（普通数组，JSON 存得下）
function save(groupId, sats) {
  const arr = (Array.isArray(sats) ? sats : []).map((s) => {
    const o = {
      key: String(s.key),
      t: Array.from(s.t || []),
      p: Array.from(s.p || []),
      v: s.v ? Array.from(s.v) : null,
      spans: s.spans && s.spans.length > 1 ? s.spans.map((x) => [x[0], x[1]]) : null
    }
    if (s.src && s.src.p && s.src.frame) o.src = { frame: String(s.src.frame), p: Array.from(s.src.p), v: s.src.v ? Array.from(s.src.v) : null }
    if (s.fmt && typeof s.fmt === 'object') o.fmt = s.fmt
    return o
  })
  writeJsonAtomic(fileOf(groupId), { sats: arr })
  _lru.delete(groupId)
  return arr.length
}

function load(groupId) {
  if (_lru.has(groupId)) { const v = _lru.get(groupId); _lru.delete(groupId); _lru.set(groupId, v); return v }
  const r = readJsonSafe(fileOf(groupId), null)
  if (!r.value || !Array.isArray(r.value.sats)) return null
  return touch(groupId, r.value)
}

// 某一颗星的采样（key 为空则取第一颗）
function sat(groupId, key) {
  const g = load(groupId)
  if (!g) return null
  if (!key) return g.sats[0] || null
  return g.sats.find((s) => String(s.key) === String(key)) || null
}

/* —— 原文 —— */
// bytes：Buffer / Uint8Array（原始字节，编码不动）。超上限不存，返回 false。
function saveSource(groupId, bytes) {
  const f = srcFileOf(groupId)
  try { fs.unlinkSync(f) } catch { /* 本就没有 */ }
  if (!bytes || !(bytes.length > 0) || bytes.length > SOURCE_MAX) return false
  const buf = Buffer.isBuffer(bytes) ? bytes : (ArrayBuffer.isView(bytes) ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Buffer.from(bytes))
  const tmp = f + '.tmp'
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, f)
  return true
}
function loadSource(groupId) {
  try { return fs.readFileSync(srcFileOf(groupId)) } catch { return null }
}
const hasSource = (groupId) => { try { return fs.statSync(srcFileOf(groupId)).isFile() } catch { return false } }

function remove(groupId) {
  _lru.delete(groupId)
  const f = fileOf(groupId), s = srcFileOf(groupId)
  let n = 0
  for (const name of [f, f + '.bak', f + '.tmp', s, s + '.tmp']) { try { fs.unlinkSync(name); n++ } catch { /* 本就没有 */ } }
  return n > 0
}

// 库里已有的采样文件（清理孤儿用；原文 .src 跟着同名 .json 走）
function listFiles() {
  try {
    const ids = new Set()
    for (const f of fs.readdirSync(dir())) { const m = /^(.+)\.(json|src)$/.exec(f); if (m) ids.add(m[1]) }
    return Array.from(ids)
  } catch { return [] }
}
// 清掉不在 keep 里的采样文件（组删干净了但文件留下的情况）
function sweep(keep) {
  const set = new Set((keep || []).map((x) => safeId(x)))
  let n = 0
  for (const id of listFiles()) if (!set.has(id)) { if (remove(id)) n++ }
  return n
}

const clearCache = () => _lru.clear()

module.exports = { save, load, sat, remove, listFiles, sweep, clearCache, fileOf, srcFileOf, saveSource, loadSource, hasSource, LRU_MAX, SOURCE_MAX }
