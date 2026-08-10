// 本地存储服务（主进程）。当前以 JSON 文件实现，零原生依赖、可即时验证；
// 接口与 SQLite 版一致，后续打包阶段可换 better-sqlite3（需 electron-rebuild）而不动调用方。
const fs = require('fs')
const path = require('path')
const { writeJsonAtomic, readJsonSafe } = require('./jsonStore')

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
// 主文件损坏（写入中途崩溃/断电）→ 回退上一份完好备份，避免「配置全没了」
function read(name, def) { return readJsonSafe(file(name), def).value }
// 原子写：见 jsonStore。崩溃/断电至多丢「本次未落盘的改动」，
// 不会让既有 configs.json 被截断成乱码后被 read 当空列表清空。
function write(name, val) { writeJsonAtomic(file(name), val, 2) }

// ---- 读-改-写专用：读不出来就【不许写】 ----
// jsonStore 早就把 corrupt 标志算好了（注释里也写明「调用方据此拒写」），但这里一路只取 .value，
// 于是「主文件与 .bak 同时读不出」（杀毒/备份软件占用锁文件、外部半截写、磁盘瞬时错）会被当成
// 空库：{...空, ...本次改动} 整份覆盖回去 —— 一次瞬时读失败就把整份 settings.json / configs.json
// 抹成只剩这次改的那几个键。settings 尤其致命：deviceId 和 activationLic 一起没了，
// 客户凭空变成一台全新的未激活设备；而时钟锚每分钟落盘一次，等于每天 1440 次机会踩这颗雷。
// 修法：读到 corrupt 就放弃这次写（返回 null），等下一次读得出来时再写。数据宁可不更新，不能丢。
function mutate(name, def, fn) {
  const { value, corrupt } = readJsonSafe(file(name), def)
  if (corrupt) {
    console.warn(`[storage] ${name} 与其 .bak 均无法解析，本次写入已放弃（不拿空库覆盖既有数据）`)
    return null
  }
  const next = fn(value)
  if (next === undefined) return null
  write(name, next)
  return next
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
// 同 setSettings 走 mutate：configs.json 是用户的活儿，被空库整份覆盖等于场景全丢。
// 读不出来时返回 null / false，调用方（IPC → 渲染端）据此提示保存失败，总好过静默清空。
function saveConfig(cfg) {
  let out = null
  mutate('configs.json', [], (list) => {
    if (cfg.id) {
      const i = list.findIndex((c) => c.id === cfg.id)
      if (i >= 0) { list[i] = { ...list[i], ...cfg, updatedAt: new Date().toISOString() }; out = list[i]; return list }
    }
    const item = { id: genId(), createdAt: new Date().toISOString(), ...cfg }
    list.unshift(item); out = item; return list
  })
  return out
}
function deleteConfig(id) { return mutate('configs.json', [], (list) => list.filter((c) => c.id !== id)) !== null }
// 按给定 id 顺序重排 configs.json（用于剪切/粘贴换位置）；未列出的保持原相对序追加在后
function reorderConfigs(ids) {
  return mutate('configs.json', [], (list) => {
    const byId = new Map(list.map((c) => [c.id, c]))
    const ordered = []
    for (const id of (ids || [])) { const c = byId.get(id); if (c) { ordered.push(c); byId.delete(id) } }
    for (const c of list) if (byId.has(c.id)) ordered.push(c)
    return ordered
  }) || listConfigs()
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
  let bail = null
  const next = mutate('configs.json', [], (list) => {
    const it = list.find((c) => c.id === id)
    if (!it) { bail = list; return undefined }                 // 返回 undefined = 不写盘（见 mutate）
    const anchor = anchorId ? list.find((c) => c.id === anchorId) : null
    const newParent = position === 'inside' ? (parentId != null ? parentId : null) : (anchor ? pid(anchor) : (parentId != null ? parentId : null))
    // 环路兜底：文件夹不能移进它自己的子孙（含自身）
    if (it.type === 'folder' && newParent != null && subtreeIds(list, id).has(newParent)) { bail = list; return undefined }
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
    return rest
  })
  return next || bail || listConfigs()
}
// 级联删除文件夹及其全部后代（沿 parentId 子树）；返回被删 id 数组。普通配置传入亦可（等价单删）。
function deleteFolder(id) {
  let removed = new Set()
  const next = mutate('configs.json', [], (list) => {
    removed = subtreeIds(list, id)
    return list.filter((c) => !removed.has(c.id))
  })
  return next === null ? [] : Array.from(removed)
}

// ---- 链路预算全局资源库（地球站/卫星/载波，按体制命名空间 geo/ngso/regen 各一套）----
// 库脱离场景配置全局存放：场景（configs.json 里的 state）只存站址行 + 库条目 id 引用。
// 整个命名空间整读整写（库条目量级为个位数到几十，无需增量接口）；write 已原子落盘带 .bak。
function getLibrary(ns) { const all = read('library.json', {}); return (ns && all[ns]) || null }
function saveLibrary(ns, data) {
  if (!ns) return false
  return mutate('library.json', {}, (all) => ({ ...all, [ns]: data })) !== null
}

// ---- 应用设置 ----
function getSettings() { return read('settings.json', {}) }
// 走 mutate：读不出来就不写（见 mutate 注释）。这是全库唯一被后台定时器高频调用的写入口
// （activation.js 的时钟锚每分钟一次 + 每次心跳落激活书），也是唯一能在用户毫无察觉时丢数据的。
function setSettings(patch) {
  return mutate('settings.json', {}, (cur) => ({ ...cur, ...patch })) || getSettings()
}

module.exports = {
  listHistory, addHistory, deleteHistory, clearHistory,
  listConfigs, saveConfig, deleteConfig, reorderConfigs, moveItem, deleteFolder,
  getLibrary, saveLibrary,
  getSettings, setSettings,
  _dir: dir
}
