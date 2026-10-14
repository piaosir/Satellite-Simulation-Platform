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

// ---- 配置预设（按工作台命名空间分家：configs.<ns>.json）----
// 早先五个工作台（GEO / NGSO / 再生式 / 端到端 / 雨衰）共用一份 configs.json，各自靠 orbitType
// 过滤出自己那批。两个后果：
//   ① moveItem 会 filter+splice 重排【整份】数组 —— 某窗拖一下，另外四窗的条目顺序跟着动；
//   ② mutate 是读-改-写，五个窗口能同时开着，后写的整份覆盖先写的（写盘窗口内的改动直接丢）。
// 故按工作台拆成五份独立文件，各窗只读写自己那份，互不见面。
// 后来又添了两个不是「链路预算」的工作台（雨衰、空间态势），但拆库的理由一模一样，故同一套机制。
// ssa 的 orbitType 写作 'SSA' 只是为了复用 belongsTo 这套归属判定 —— 空间态势报告与轨道体制无关，
// 而且它是拆库【之后】才有的功能，旧 configs.json 里绝不可能有它的条目，migrateNs 必然拆出空表。
// sun（日凌预报）同理：'SUN' 也只是归属标记，且同样是拆库之后才有的工作台。
// ci（干扰分析）/ pfd（PFD Mask）2026-10-15 起有配置列表：同样是拆库之后才有，旧库拆出必为空表；'CI' / 'PFD' 只是归属标记。
const CFG_NS = ['geo', 'ngso', 'regen', 'e2e', 'rain', 'ssa', 'sun', 'ci', 'pfd']
const NS_ORBIT = { geo: 'GEO', ngso: 'NGSO', regen: 'REGEN', e2e: 'E2E', rain: 'RAIN', ssa: 'SSA', sun: 'SUN', ci: 'CI', pfd: 'PFD' }
function cfgFile(ns) {
  // 未知命名空间宁可抛错：静默回退到某一份就是把 A 窗的配置写进 B 窗的库，比报错难查得多
  if (!CFG_NS.includes(ns)) throw new TypeError(`[storage] 未知的配置命名空间：${ns}`)
  return `configs.${ns}.json`
}
// 旧库归属判定：与各窗口拆分前的 loadConfigs 过滤【逐字一致】，保证迁移前后各窗看到的列表不变。
// GEO 是历史默认体制（老配置无 orbitType 字段），故用白名单——切忌写成「排除其余四种」的黑名单：
// 每新增一种体制都会漏网串进 GEO。
function belongsTo(it, ns) {
  if (!it) return false
  if (it.type === 'folder') return it.orbitType === NS_ORBIT[ns]
  if (ns === 'geo') return !it.state || !it.state.orbitType || it.state.orbitType === 'GEO'
  return !!(it.state && it.state.orbitType === NS_ORBIT[ns])
}
// 首次访问某命名空间：从旧 configs.json 拆出属于它的那批。旧文件只读不动，留作回滚兜底。
// 拆完把指向本命名空间之外的 parentId 清成 null —— 跨库的父级引用在新文件里必然悬空。
// 判在场要连 .bak 一起看：主文件被外部删掉而备份还在时，重迁会拿旧库盖掉 readJsonSafe 本可恢复的那份。
function migrateNs(ns) {
  const f = cfgFile(ns)
  if (fs.existsSync(file(f)) || fs.existsSync(file(f) + '.bak')) return
  const legacy = readJsonSafe(file('configs.json'), null).value
  if (!Array.isArray(legacy)) return                 // 全新安装：不建文件，首次写入时自然创建
  const mine = legacy.filter((it) => belongsTo(it, ns))
  const ids = new Set(mine.map((it) => it.id))
  write(f, mine.map((it) => (it.parentId != null && !ids.has(it.parentId)) ? { ...it, parentId: null } : it))
}
function listConfigs(ns) { migrateNs(ns); return read(cfgFile(ns), []) }
// 跨命名空间总览（主窗口「配置管理」页用）：只读，不提供跨库写入
function listAllConfigs() { return CFG_NS.map((ns) => ({ ns, items: listConfigs(ns) })) }
// 同 setSettings 走 mutate：配置库是用户的活儿，被空库整份覆盖等于场景全丢。
// 读不出来时返回 null / false，调用方（IPC → 渲染端）据此提示保存失败，总好过静默清空。
function saveConfig(ns, cfg) {
  migrateNs(ns)
  let out = null
  mutate(cfgFile(ns), [], (list) => {
    if (cfg.id) {
      const i = list.findIndex((c) => c.id === cfg.id)
      if (i >= 0) { list[i] = { ...list[i], ...cfg, updatedAt: new Date().toISOString() }; out = list[i]; return list }
    }
    const item = { id: genId(), createdAt: new Date().toISOString(), ...cfg }
    list.unshift(item); out = item; return list
  })
  return out
}
// 自动保存专用（链路预算四窗）：只更新已有配置的 state（可顺带改自动名），【不新建】。
// saveConfig 是 upsert 且会沿用传入的 id —— 删掉当前配置时若还有一次防抖写盘挂着，用它就会以原 id
// 把刚删的配置原样写回来。这里查无此项一律返回 { gone:true }，什么都不写。
// patch：{ state, name?, nameAuto? }；name 只在非空时生效（自动名由渲染端算好传来）。
function updateConfigState(ns, id, patch) {
  migrateNs(ns)
  const p = patch || {}
  let out = null, gone = false
  const r = mutate(cfgFile(ns), [], (list) => {
    const i = list.findIndex((c) => c && c.id === id && c.type !== 'folder')
    if (i < 0) { gone = true; return undefined }      // undefined = 不写盘（见 mutate）
    const next = { ...list[i], state: p.state, updatedAt: new Date().toISOString() }
    if (typeof p.name === 'string' && p.name.trim()) next.name = p.name.trim()
    if (typeof p.nameAuto === 'boolean') next.nameAuto = p.nameAuto
    list[i] = next; out = next
    return list
  })
  if (gone) return { ok: false, gone: true }
  if (r === null || !out) return { ok: false, error: '配置库文件与其备份均无法读取，未写入' }
  return { ok: true, updatedAt: out.updatedAt, name: out.name }
}
function deleteConfig(ns, id) {
  migrateNs(ns)
  const ok = mutate(cfgFile(ns), [], (list) => list.filter((c) => c.id !== id)) !== null
  if (ok) dropVersions(ns, [id])
  return ok
}
// 按给定 id 顺序重排本命名空间；未列出的保持原相对序追加在后
function reorderConfigs(ns, ids) {
  migrateNs(ns)
  return mutate(cfgFile(ns), [], (list) => {
    const byId = new Map(list.map((c) => [c.id, c]))
    const ordered = []
    for (const id of (ids || [])) { const c = byId.get(id); if (c) { ordered.push(c); byId.delete(id) } }
    for (const c of list) if (byId.has(c.id)) ordered.push(c)
    return ordered
  }) || listConfigs(ns)
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
function moveItem(ns, id, parentId, anchorId, position) {
  migrateNs(ns)
  let bail = null
  const next = mutate(cfgFile(ns), [], (list) => {
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
  return next || bail || listConfigs(ns)
}
// 级联删除文件夹及其全部后代（沿 parentId 子树）；返回被删 id 数组。普通配置传入亦可（等价单删）。
function deleteFolder(ns, id) {
  migrateNs(ns)
  let removed = new Set()
  const next = mutate(cfgFile(ns), [], (list) => {
    removed = subtreeIds(list, id)
    return list.filter((c) => !removed.has(c.id))
  })
  if (next === null) return []
  dropVersions(ns, Array.from(removed))
  return Array.from(removed)
}

// ---- 配置的历史版本（链路预算四窗自动保存的后悔药）----
// 一份配置一个文件 versions/<ns>/<配置 id>.json：[{ id, t, kind, name, meta, hash, state }, …]，新的在前。
//   · 不并进 configs.<ns>.json —— 那份每次自动保存都要整写，历史混在里头就跟着一起重写；
//   · 也不全窗合成一份 —— 30 档 × 几十份配置的场景能到几十 MB，每次留档整写一遍会卡住主进程。
// kind：'open' 打开时 / 'auto' 定时 / 'restore' 还原前。hash 由渲染端按场景指纹算：与最新一档相同就不重复留档。
const VERSION_CAP = 30
// 配置 id 由 genId 生成（[0-9a-z-]）；旧库 / 导入件万一带了别的字符，一律折成 _，不许拼出目录穿越
// 历史版本的命名空间 = 配置列表那几个 + 频率计划（频率计划不进 configs.*.json，但照样按计划 id 留档，口径同链路预算）
const VER_NS = [...CFG_NS, 'freqplan']
function verFile(ns, cfgId) {
  if (!VER_NS.includes(ns)) throw new TypeError(`[storage] 未知的版本命名空间：${ns}`)
  return path.join('versions', ns, String(cfgId).replace(/[^A-Za-z0-9_-]/g, '_') + '.json')
}
function readVersions(ns, cfgId) { const v = read(verFile(ns, cfgId), []); return Array.isArray(v) ? v : [] }
function listVersions(ns, cfgId) {
  return readVersions(ns, cfgId).map((v) => ({ id: v.id, t: v.t, kind: v.kind, name: v.name || '', meta: v.meta || null }))   // 清单不带 state（还原时再取）
}
function getVersion(ns, cfgId, verId) {
  return readVersions(ns, cfgId).find((v) => v.id === verId) || null
}
function addVersion(ns, cfgId, v) {
  if (!cfgId || !v || !v.state) return null
  const f = verFile(ns, cfgId)
  fs.mkdirSync(path.dirname(file(f)), { recursive: true })
  let out = null
  mutate(f, [], (list0) => {
    const list = Array.isArray(list0) ? list0 : []
    if (v.hash && list[0] && list[0].hash === v.hash) { out = list[0]; return undefined }   // 与最新一档相同
    const item = { id: genId(), t: new Date().toISOString(), kind: String(v.kind || 'auto'), name: String(v.name || ''), meta: v.meta || null, hash: String(v.hash || ''), state: v.state }
    out = item
    return [item, ...list].slice(0, VERSION_CAP)
  })
  return out ? { id: out.id, t: out.t, kind: out.kind } : null
}
// 配置删了，它的历史一并删（连 .bak，不留孤儿）
function dropVersions(ns, ids) {
  for (const id of ids || []) {
    const f = file(verFile(ns, id))
    for (const p of [f, f + '.bak', f + '.tmp']) { try { fs.rmSync(p, { force: true }) } catch (e) { /* 删不掉下次再说，不拦删配置 */ } }
  }
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
  listConfigs, listAllConfigs, saveConfig, updateConfigState, deleteConfig, reorderConfigs, moveItem, deleteFolder,
  listVersions, getVersion, addVersion, dropVersions,
  getLibrary, saveLibrary,
  getSettings, setSettings,
  _dir: dir
}
