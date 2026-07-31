// 转发器频率计划 · 存储服务（主进程）。
//
// 归属：频率计划挂在【卫星】下、与 GRD 天线平级（satFolder 即卫星树节点 key，与 useGrdCoverage
// 的 folder 同源）。主进程只管存取字节，不认识频率计划的语义——模型/校验/容量全在渲染端
// src/shared/freqPlan*.js，避免同一套口径在两侧各存一份、日后对不上。
//
// 落盘：userData/freq-plans/
//   index.json      —— 轻量索引（列表页只读它，不必把每份计划都读进内存）
//   <id>.json       —— 计划全文
const fs = require('fs')
const path = require('path')

module.exports = function createFreqPlan(baseDirIn) {
  let baseDir = baseDirIn
  function dir() {
    if (!baseDir) {
      const { app } = require('electron')
      baseDir = process.env.SATSIM_FREQPLAN_DIR || path.join(app.getPath('userData'), 'freq-plans')
    }
    fs.mkdirSync(baseDir, { recursive: true })
    return baseDir
  }
  const file = (n) => path.join(dir(), n)

  function readJson(name, def) {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')) }
    catch {
      try { return JSON.parse(fs.readFileSync(file(name) + '.bak', 'utf8')) } catch { return def }
    }
  }
  // 原子写（与 storage.js 同法）：先 .tmp 再 rename，保留一份 .bak
  function writeJson(name, val) {
    const f = file(name)
    const tmp = f + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(val, null, 2))
    try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak') } catch { /* 备份尽力而为 */ }
    fs.renameSync(tmp, f)
  }

  const genId = () => 'fp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  // id 只允许自造的字符集，杜绝 ../ 穿越
  const safeId = (id) => {
    const s = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '')
    if (!s) throw new Error('非法计划 id')
    return s
  }

  function listIndex() { return readJson('index.json', []) }

  // 索引条目：列表页够用的最小集合。channels 不进索引（几十条通道 × 几十份计划会把列表拖慢）。
  function indexEntry(plan) {
    const chs = Array.isArray(plan.channels) ? plan.channels : []
    return {
      id: plan.id,
      name: plan.name || '频率计划',
      satFolder: plan.satFolder || '',
      satName: plan.satName || '',
      band: plan.band || '',
      channelCount: chs.length,
      transponderCount: chs.filter((c) => (c.kind || 'transponder') === 'transponder').length,
      beamCount: Array.isArray(plan.beams) ? plan.beams.length : 0,
      updatedAt: plan.updatedAt || new Date().toISOString()
    }
  }

  function list() { return listIndex() }

  function get(id) {
    const sid = safeId(id)
    const p = readJson(sid + '.json', null)
    return p || null
  }

  // save：新建（无 id）或整份覆盖
  function save(plan) {
    const p = { ...(plan || {}) }
    if (!p.id) p.id = genId()
    p.id = safeId(p.id)
    p.updatedAt = new Date().toISOString()
    writeJson(p.id + '.json', p)
    const idx = listIndex().filter((e) => e.id !== p.id)
    idx.unshift(indexEntry(p))
    writeJson('index.json', idx)
    return { ok: true, id: p.id, entry: indexEntry(p) }
  }

  function remove(id) {
    const sid = safeId(id)
    for (const n of [sid + '.json', sid + '.json.bak']) {
      try { fs.unlinkSync(file(n)) } catch { /* 不存在即已达成目的 */ }
    }
    writeJson('index.json', listIndex().filter((e) => e.id !== sid))
    return { ok: true }
  }

  function rename(id, name) {
    const p = get(id)
    if (!p) return { ok: false, error: '计划不存在' }
    p.name = String(name || '').trim() || p.name
    return save(p)
  }

  // 卫星改名/删除时同步：卫星树是频率计划的宿主，宿主没了得让计划跟着走，
  // 否则会留下一堆挂在不存在卫星下的孤儿。
  function reassignSat(oldFolder, patch) {
    const idx = listIndex()
    let n = 0
    for (const e of idx) {
      if (e.satFolder !== oldFolder) continue
      const p = get(e.id)
      if (!p) continue
      if (patch && patch.folder != null) p.satFolder = patch.folder
      if (patch && patch.satName != null) p.satName = patch.satName
      if (patch && patch.detach) { p.satFolder = ''; p.satName = '' }
      save(p)
      n++
    }
    return { ok: true, count: n }
  }

  // 整库导出/导入（跟着分享包走，也可单独交换）
  function exportAll() {
    return listIndex().map((e) => get(e.id)).filter(Boolean)
  }
  function importMany(plans, opts) {
    const mode = (opts && opts.mode) || 'merge'    // merge = 保留同名另建；replace = 同 id 覆盖
    let added = 0, replaced = 0
    for (const raw of plans || []) {
      if (!raw || typeof raw !== 'object') continue
      const p = { ...raw }
      if (mode === 'merge' && p.id && get(p.id)) { p.id = genId(); added++ }
      else if (p.id && get(p.id)) replaced++
      else added++
      save(p)
    }
    return { ok: true, added, replaced }
  }

  return { list, get, save, remove, rename, reassignSat, exportAll, importMany }
}
