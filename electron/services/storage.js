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
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')) } catch { return def }
}
function write(name, val) { fs.writeFileSync(file(name), JSON.stringify(val, null, 2)) }
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

// ---- 应用设置 ----
function getSettings() { return read('settings.json', {}) }
function setSettings(patch) {
  const next = { ...getSettings(), ...patch }
  write('settings.json', next)
  return next
}

module.exports = {
  listHistory, addHistory, deleteHistory, clearHistory,
  listConfigs, saveConfig, deleteConfig,
  getSettings, setSettings,
  _dir: dir
}
