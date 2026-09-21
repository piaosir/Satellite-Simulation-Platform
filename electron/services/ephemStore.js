// 星历点序列的采样表存储（主进程）。
//
// 【为什么与 custom.json 分家】custom.json 是「组清单」，文件管理、3D 地图分组、搜索池每次都要读它；
// 而一组 SP3 是 32 颗星 × 96 个历元 × 7 个数，几 MB 起步。把采样塞进 custom.json，等于每看一眼
// 组列表就把几十 MB 反序列化一遍。故组里只留元数据（key / name / 起止 / 点数 / 插值口径），
// 采样另存 userData/data/ephem/<groupId>.json，按需读、读了进 LRU。
//
// 【写】一律走 jsonStore.writeJsonAtomic：半截文件会被下一次读当成「空表」，紧接着的写再拿空表
// 整份覆盖，导入的星历就永久没了（与 custom.json 同一条教训）。
// 【删组】必须连采样文件一起删，否则 userData 里会留一地孤儿文件。

const fs = require('fs')
const path = require('path')
const { writeJsonAtomic, readJsonSafe } = require('./jsonStore')

// 内存 LRU：NGSO 引擎每算一行都要取表，一组几 MB，留最近几组即可。
const LRU_MAX = 6
const _lru = new Map()   // groupId -> { sats:[…] }

function dir() {
  const base = process.env.SATSIM_DATA_DIR ||
    path.join(require('electron').app.getPath('userData'), 'data')
  const d = path.join(base, 'ephem')
  fs.mkdirSync(d, { recursive: true })
  return d
}
const fileOf = (groupId) => path.join(dir(), String(groupId).replace(/[^\w.-]/g, '_') + '.json')

function touch(groupId, val) {
  if (_lru.has(groupId)) _lru.delete(groupId)
  _lru.set(groupId, val)
  while (_lru.size > LRU_MAX) _lru.delete(_lru.keys().next().value)
  return val
}

// sats: [{ key, t:[ms…], p:[km…], v:[km/s…]|null }]（普通数组，JSON 存得下）
function save(groupId, sats) {
  const arr = (Array.isArray(sats) ? sats : []).map((s) => ({
    key: String(s.key),
    t: Array.from(s.t || []),
    p: Array.from(s.p || []),
    v: s.v ? Array.from(s.v) : null,
    spans: s.spans && s.spans.length > 1 ? s.spans.map((x) => [x[0], x[1]]) : null
  }))
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

function remove(groupId) {
  _lru.delete(groupId)
  const f = fileOf(groupId)
  let n = 0
  for (const name of [f, f + '.bak', f + '.tmp']) { try { fs.unlinkSync(name); n++ } catch { /* 本就没有 */ } }
  return n > 0
}

// 库里已有的采样文件（清理孤儿用）
function listFiles() {
  try { return fs.readdirSync(dir()).filter((f) => /\.json$/.test(f)).map((f) => f.replace(/\.json$/, '')) }
  catch { return [] }
}
// 清掉不在 keep 里的采样文件（组删干净了但文件留下的情况）
function sweep(keep) {
  const set = new Set((keep || []).map(String))
  let n = 0
  for (const id of listFiles()) if (!set.has(id)) { if (remove(id)) n++ }
  return n
}

const clearCache = () => _lru.clear()

module.exports = { save, load, sat, remove, listFiles, sweep, clearCache, fileOf, LRU_MAX }
