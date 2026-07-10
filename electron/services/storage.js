// 本地存储服务（主进程）。当前以 JSON 文件实现，零原生依赖、可即时验证；
// 接口与 SQLite 版一致，后续打包阶段可换 better-sqlite3（需 electron-rebuild）而不动调用方。
const fs = require('fs')
const path = require('path')

let baseDir = null
function dir() {
  if (!baseDir) {
    // 延迟取 userData：app 须就绪。测试环境可用 SATSIM_DATA_DIR 覆盖。
    const { app } = require('electron')
    baseDir = process.env.SATSIM_DATA_DIR || path.join(app.getPath('userData'), 'data')
  }
  fs.mkdirSync(baseDir, { recursive: true })
  return baseDir
}
function file(name) { return path.join(dir(), name) }
function read(name, def) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')) }
  catch {
    // 主文件损坏（写入中途崩溃/断电）→ 回退上一份完好备份，避免「配置全没了」
    try { return JSON.parse(fs.readFileSync(file(name) + '.bak', 'utf8')) } catch { return def }
  }
}
// 原子写：先写 .tmp，保留上一份 .bak，再 rename 覆盖。崩溃/断电至多丢「本次未落盘的改动」，
// 不会让既有 configs.json 被截断成乱码后被 read 当空列表清空。
function write(name, val) {
  const f = file(name)
  const data = JSON.stringify(val, null, 2)
  const tmp = f + '.tmp'
  fs.writeFileSync(tmp, data)               // 写满临时文件（失败则抛错，原文件不动）
  try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak') } catch { /* 备份尽力而为 */ }
  fs.renameSync(tmp, f)                      // 原子替换（Windows MoveFileEx 覆盖）
}
function genId() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) }

// ---- 历史记录 ----
function listHistory() { return read('history.json', []) }
function addHistory(rec) {
  const list = listHistory()
  const item = { id: genId(), createdAt: new Date().toISOString(), ...rec }
  list.unshift(item)
  write('history.json', list.slice(0, 500))
  return item
}
function deleteHistory(id) { write('history.json', listHistory().filter((r) => r.id !== id)); return true }
function clearHistory() { write('history.json', []); return true }

// ---- 配置预设 ----
function listConfigs() { return read('configs.json', []) }
function saveConfig(cfg) {
  const list = listConfigs()
  if (cfg.id) {
    const i = list.findIndex((c) => c.id === cfg.id)
    if (i >= 0) { list[i] = { ...list[i], ...cfg, updatedAt: new Date().toISOString() }; write('configs.json', list); return list[i] }
  }
  const item = { id: genId(), createdAt: new Date().toISOString(), ...cfg }
  list.unshift(item)
  write('configs.json', list)
  return item
}
function deleteConfig(id) { write('configs.json', listConfigs().filter((c) => c.id !== id)); return true }
// 按给定 id 顺序重排 configs.json（用于剪切/粘贴换位置）；未列出的保持原相对序追加在后
function reorderConfigs(ids) {
  const list = listConfigs()
  const byId = new Map(list.map((c) => [c.id, c]))
  const ordered = []
  for (const id of (ids || [])) { const c = byId.get(id); if (c) { ordered.push(c); byId.delete(id) } }
  for (const c of list) if (byId.has(c.id)) ordered.push(c)
  write('configs.json', ordered)
  return ordered
}
// 归一化父级：缺省/null/undefined 一律视作 null（根）
function pid(x) { return x && x.parentId != null ? x.parentId : null }
// 收集某项的全部后代 id（沿 parentId 子树，含该项自身）
function subtreeIds(list, id) {
  const set = new Set([id])
  let grew = true
  while (grew) { grew = false; for (const c of list) { if (c.parentId != null && set.has(c.parentId) && !set.has(c.id)) { set.add(c.id); grew = true } } }
  return set
}
// 锚点式移动配置/文件夹：把 id 项挪到 anchorId 之 before/after（同级），或放入 parentId 文件夹内(position='inside')。
// 单次读-改-写原子落盘；因数组相对序即同级序，紧贴锚点插入即保证顺序正确、其余组不动。
function moveItem(id, parentId, anchorId, position) {
  const list = listConfigs()
  const it = list.find((c) => c.id === id)
  if (!it) return list
  const anchor = anchorId ? list.find((c) => c.id === anchorId) : null
  const newParent = position === 'inside' ? (parentId != null ? parentId : null) : (anchor ? pid(anchor) : (parentId != null ? parentId : null))
  // 环路兜底：文件夹不能移进它自己的子孙（含自身）
  if (it.type === 'folder' && newParent != null && subtreeIds(list, id).has(newParent)) return list
  const rest = list.filter((c) => c.id !== id)
  it.parentId = newParent
  let insertAt
  if (position !== 'inside' && anchor) {
    const ai = rest.findIndex((c) => c.id === anchorId)
    insertAt = ai < 0 ? rest.length : (position === 'before' ? ai : ai + 1)
  } else {
    // inside / 无锚点：追加到同父组末尾（保持文件夹内新入项排在后面）
    let last = -1
    for (let i = 0; i < rest.length; i++) if (pid(rest[i]) === newParent) last = i
    insertAt = last < 0 ? rest.length : last + 1
  }
  rest.splice(insertAt, 0, it)
  write('configs.json', rest)
  return rest
}
// 级联删除文件夹及其全部后代（沿 parentId 子树）；返回被删 id 数组。普通配置传入亦可（等价单删）。
function deleteFolder(id) {
  const list = listConfigs()
  const removed = subtreeIds(list, id)
  write('configs.json', list.filter((c) => !removed.has(c.id)))
  return Array.from(removed)
}

// ---- 应用设置 ----
function getSettings() { return read('settings.json', {}) }
function setSettings(patch) {
  const next = { ...getSettings(), ...patch }
  write('settings.json', next)
  return next
}

module.exports = {
  listHistory, addHistory, deleteHistory, clearHistory,
  listConfigs, saveConfig, deleteConfig, reorderConfigs, moveItem, deleteFolder,
  getSettings, setSettings,
  _dir: dir
}
