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

// ---- 应用设置 ----
function getSettings() { return read('settings.json', {}) }
function setSettings(patch) {
  const next = { ...getSettings(), ...patch }
  write('settings.json', next)
  return next
}

module.exports = {
  listHistory, addHistory, deleteHistory, clearHistory,
  listConfigs, saveConfig, deleteConfig, reorderConfigs,
  getSettings, setSettings,
  _dir: dir
}
