// 自定义卫星星历库（主进程）。
// 用户在「文件管理 · 轨道星历」导入的星历文件，经 SGP4 校验、按 NORAD 去重后【按导入分组持久化】
// （userData/data/omm/custom.json，每文件一组）。文件管理是自定义卫星的唯一权威库——凡进星座地图/搜索池的
// 导入星必落此库（「文件」菜单的「导入 TLE 文件」与文件管理的「导入星历」同走此通路，不再有临时不落库的导入）。
// 全链路——星座地图 3D 的「自定义卫星」分组、
// NGSO/再生/链路预算「搜索卫星」候选池——都复用既有 `parseOMMCsv → omm2satrec` 通路，与官方星历同一 SGP4 口径。
//
// 【格式】导入/导出的六种官方格式（OMM 的 CSV/JSON/KVN/XML 与 TLE/3LE）全部由 core/utils/ommFormats.js
// 承担：那里有字段表、官方数值体例、六个解析器与六个序列化器，以及“与官方一致”的判据说明。本文件只管
// 分组持久化与 SGP4 校验，不再自带解析逻辑。
//
// 【导出与官方逐字节一致】靠组里留的一份导入原文（rawText/rawFormat）：导出格式 == 导入格式时直接吐原文，
// 其余格式走 ommFormats 的规范重建。原文超过 RAW_KEEP_MAX 的不留（这类大文件本就来自官方，用户手上有原件），
// 此时同格式导出退化为规范重建——值仍逐字相同，只是行尾/列序等排版由本平台决定。

const fs = require('fs')
const path = require('path')
const { writeJsonAtomic, readJsonSafe } = require('./jsonStore')
const eph = require('../../packages/core/utils/ommFormats.js')

// 留存导入原文的体积上限（超过则不留，见头部说明）。8MB 覆盖 CelesTrak 最大的 active 组（~3.4MB）。
const RAW_KEEP_MAX = 8 * 1024 * 1024

const MU = 398600.4418
const RE = 6378.137

// 与 omm.js 同一缓存基址：userData/data/omm/（自定义库存 custom.json，绝不与内置组 csv_<组>.csv 混淆）
function cacheDir() {
  const base = process.env.SATSIM_DATA_DIR ||
    path.join(require('electron').app.getPath('userData'), 'data')
  const d = path.join(base, 'omm')
  fs.mkdirSync(d, { recursive: true })
  return d
}
// 导入库改为「按导入分组」：每次导入的文件 = 一个命名组，可各自导出/删除。存 custom.json。
const storeFile = () => path.join(cacheDir(), 'custom.json')

/* ===================== CSV 解析（与 tleStore/tle.js 逐字一致，保证与全链路解析结果相同） ===================== */
function splitCsvLine(line) {
  const out = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false } else cur += c
    } else if (c === '"') { inQ = true }
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}
// CelesTrak OMM CSV(FORMAT=csv) → [{name,noradId,objectId,epoch,meanMotion,ecc,incl,raan,argp,ma,bstar,mdot,mddot}]
function parseOMMCsv(text) {
  const lines = String(text || '').split(/\r?\n/)
  let h = 0
  while (h < lines.length && !lines[h].trim()) h++
  if (h >= lines.length) return []
  const header = splitCsvLine(lines[h]).map((s) => s.trim().toUpperCase())
  const col = {}
  for (let i = 0; i < header.length; i++) col[header[i]] = i
  const ix = (n) => (n in col ? col[n] : -1)
  const iName = ix('OBJECT_NAME'), iObj = ix('OBJECT_ID'), iEpoch = ix('EPOCH'),
    iMM = ix('MEAN_MOTION'), iEcc = ix('ECCENTRICITY'), iInc = ix('INCLINATION'),
    iRaan = ix('RA_OF_ASC_NODE'), iArgp = ix('ARG_OF_PERICENTER'), iMa = ix('MEAN_ANOMALY'),
    iId = ix('NORAD_CAT_ID'), iB = ix('BSTAR'), iMdot = ix('MEAN_MOTION_DOT'), iMddot = ix('MEAN_MOTION_DDOT')
  if (iEpoch < 0 || iMM < 0 || iId < 0) return []
  const g = (f, i) => (i >= 0 && i < f.length ? f[i].trim() : '')
  const sats = []
  for (let r = h + 1; r < lines.length; r++) {
    if (!lines[r].trim()) continue
    const f = splitCsvLine(lines[r])
    const noradId = g(f, iId)
    if (!noradId) continue
    sats.push({
      name: g(f, iName) || ('NORAD ' + noradId), noradId, objectId: g(f, iObj), epoch: g(f, iEpoch),
      meanMotion: g(f, iMM), ecc: g(f, iEcc), incl: g(f, iInc), raan: g(f, iRaan),
      argp: g(f, iArgp), ma: g(f, iMa), bstar: g(f, iB) || '0', mdot: g(f, iMdot) || '0', mddot: g(f, iMddot) || '0'
    })
  }
  return sats
}

/* ===================== 序列化 / 解析：一律走 core/utils/ommFormats.js ===================== */
// 记录 → 指定格式文本。CSV 是内部扁平化（raw()）与旧口径导出的缺省格式。
const recordsToText = (records, format) => eph.serializeEphemeris(records, format || 'omm-csv')
const recordsToCsv = (records) => recordsToText(records, 'omm-csv')

// 旧库里的 format 取值只有 'omm' / 'tle' 两种，统一到 ommFormats 的六种 id 上。
const FORMAT_MIGRATE = { omm: 'omm-csv', tle: 'tle' }
const normFormat = (f) => FORMAT_MIGRATE[f] || (eph.FORMATS.includes(f) ? f : '')

/* ===================== 校验 / 存储 / 合并 ===================== */
// 用与全链路一致的 SGP4 引擎校验：能构 satrec 且历元处传播出有限位置（滤除衰落/病态根数）。
// 历元串按 omm2satrec 同一条规矩补 Z —— 官方 OMM 的 EPOCH 不带时区标记，直接 new Date() 会被
// 当本地时间解，东八区上就成了「历元 −8h 处校验」，临近衰落的星可能因此被误判掉。
const epochDate = (rec) => new Date(/[zZ]$/.test(rec.epoch) ? rec.epoch : rec.epoch + 'Z')
function validateRecord(getCore, rec) {
  try {
    const core = getCore && getCore()
    const sgp4 = core && core.sgp4
    if (!sgp4 || !sgp4.omm2satrec) return { ok: true }   // 引擎未就绪：仅依赖解析层数值校验
    const satrec = sgp4.omm2satrec(rec)
    if (!satrec || satrec.error) return { ok: false, reason: `SGP4 初始化失败（error=${satrec && satrec.error}）` }
    const pv = sgp4.propagate(satrec, epochDate(rec))
    if (!pv || !pv.position || !['x', 'y', 'z'].every((k) => Number.isFinite(pv.position[k]))) {
      return { ok: false, reason: '历元处无有效位置（历元体例不受支持 / 已衰落 / 根数病态）' }
    }
    return { ok: true }
  } catch (e) { return { ok: false, reason: e.message || String(e) } }
}

// —— 分组存储（custom.json = { groups: [{ id, name, importedAt, format, sats:[OMM记录] }] }）——
// 旧版单文件路径：早期把导入统一存成一份扁平 custom.csv，后改为分组 custom.json。
const legacyCsvFile = () => path.join(cacheDir(), 'custom.csv')
const CORRUPT = '星历库文件损坏'
// 读库：优先 custom.json；无 json 但有旧版 custom.csv 时自动迁移为一个「历史导入」组，
// 使文件管理 / 地图分组 / 搜索池一并识别历史导入（文件管理是自定义卫星的唯一权威库）。
// 落盘只存官方字段字典 f{}（外加 TLE 原文行 / JSON 原 number / 注释 / 自定义参数），
// 契约 13 字段全部由 f 派生，不写第二份 —— 两份同值字符串会把库撑到源文件的 5～6 倍。
// 老库里的条目没有 f（早期只存契约字段），原样放行：导出时 fieldsFromRecord 会按官方体例补出来。
const EXTRA_KEYS = ['tleLines', 'tleName', 'jsonNum', 'comments', 'userDefined']
function packSat(rec) {
  if (!rec || !rec.f) return rec
  const o = { f: rec.f }
  for (const k of EXTRA_KEYS) if (rec[k] != null) o[k] = rec[k]
  return o
}
function unpackSat(o) {
  if (!o || !o.f) return o
  const rec = eph.recordFromFields(o.f)
  if (!rec) return o
  for (const k of EXTRA_KEYS) if (o[k] != null) rec[k] = o[k]
  return rec
}
const packGroups = (groups) => groups.map((g) => Object.assign({}, g, { sats: (g.sats || []).map(packSat) }))
const unpackGroups = (groups) => groups.map((g) => Object.assign({}, g, { sats: (g.sats || []).map(unpackSat) }))

function readStore() {
  const r = readJsonSafe(storeFile(), null)
  if (r.value && Array.isArray(r.value.groups)) return { groups: unpackGroups(r.value.groups) }
  // custom.json 与它的 .bak 都解析不出来：不当空库使——空库上的下一次写会把坏文件整份覆盖，
  // 导入过的星历再也找不回来。标出来让写侧拒写、上层显示状态。
  if (r.corrupt) return { groups: [], corrupt: true }
  try {   /* 无 custom.json：尝试迁移旧版 custom.csv */
    const legacy = legacyCsvFile()
    const recs = parseOMMCsv(fs.readFileSync(legacy, 'utf8'))
    if (recs.length) {
      let importedAt; try { importedAt = fs.statSync(legacy).mtime.toISOString() } catch { importedAt = new Date().toISOString() }
      const store = { groups: [{ id: genId(), name: '历史导入', importedAt, format: 'omm-csv', sats: recs }] }
      writeStore(store)
      try { fs.renameSync(legacy, legacy + '.migrated') } catch { /* 迁移后原文件保留亦无妨（json 已优先） */ }
      return store
    }
  } catch { /* 无旧文件：全新空库 */ }
  return { groups: [] }
}
function writeStore(store) {
  const f = storeFile()
  // 库清空 = 主文件与备份一起去掉：只删主文件的话，下次读会从 .bak 把删掉的组捞回来
  if (!store || !store.groups || !store.groups.length) {
    for (const n of [f, f + '.bak']) { try { fs.unlinkSync(n) } catch { /* 已空 */ } }
    return
  }
  writeJsonAtomic(f, { groups: packGroups(store.groups) })
}
const mtimeOf = () => { try { return fs.statSync(storeFile()).mtime.toISOString() } catch { return null } }
let _seq = 0
const genId = () => 'g' + Date.now().toString(36) + (_seq++).toString(36)

// 解析文本 → OMM 记录 + 格式（六种官方格式按内容嗅探，扩展名不作判据）。都认不出返回 records=[]。
function parseAny(text) {
  const r = eph.parseEphemeris(text)
  return { records: r.records, format: r.format, errors: r.errors || [], warnings: r.warnings || [] }
}

// 组内派生显示量（周期/近远地点）
function satView(r) {
  const mm = Number(r.meanMotion) || 0, ecc = Number(r.ecc) || 0
  const n = mm * 2 * Math.PI / 86400, a = n > 0 ? Math.cbrt(MU / (n * n)) : null
  return {
    name: r.name, noradId: r.noradId, epoch: r.epoch, incl: Number(r.incl) || 0, ecc, meanMotion: mm,
    periodMin: n > 0 ? (2 * Math.PI / n) / 60 : null,
    apogeeKm: a ? a * (1 + ecc) - RE : null, perigeeKm: a ? a * (1 - ecc) - RE : null
  }
}

/* ===================== 对外接口 ===================== */
module.exports = function createCustomSats(getCore) {
  // 组列表（供文件管理）：每组附卫星数、格式、导入时间，以及组内卫星概览（供展开显示）。
  function list() {
    const store = readStore()
    const groups = store.groups.map((g) => ({
      id: g.id, name: g.name, importedAt: g.importedAt, format: normFormat(g.format),
      exact: g.exact !== undefined ? !!g.exact : !!(g.rawText && g.rawCount === (g.sats || []).length),
      count: (g.sats || []).length, sats: (g.sats || []).map(satView)
    }))
    const out = { groups, count: groups.reduce((s, g) => s + g.count, 0), mtime: mtimeOf() }
    if (store.corrupt) out.error = CORRUPT
    return out
  }
  // 全部组扁平化为一份 OMM CSV（供 3D 地图「自定义卫星」分组 / 搜索池；按 NORAD 去重，后组覆盖）。
  function raw() {
    const store = readStore()
    if (!store.groups.length) return null
    const map = new Map()
    for (const g of store.groups) for (const r of (g.sats || [])) map.set(String(r.noradId), r)
    const recs = Array.from(map.values())
    return recs.length ? { text: recordsToCsv(recs), fetchedAt: mtimeOf() } : null
  }
  // 导入一个文件 → 建/替换一个命名组（同名替换）。逐条 SGP4 校验；组内按 NORAD 去重（后者覆盖）。
  function importFile(name, text) {
    const { records, format, errors, warnings } = parseAny(text)
    if (!records.length) return { ok: false, error: '无法识别的星历格式（支持 OMM 的 CSV/JSON/KVN/XML 与 TLE/3LE）：' + (errors[0] || '格式不符') }
    const map = new Map(); let invalid = 0; const errs = []
    for (const r of records) {
      const v = validateRecord(getCore, r)
      if (!v.ok) { invalid++; if (errs.length < 30) errs.push(`${r.name || ('NORAD ' + r.noradId)}：${v.reason}`); continue }
      map.set(String(r.noradId), r)
    }
    const sats = Array.from(map.values())
    if (!sats.length) return { ok: false, error: '无有效卫星（' + (errs[0] || '全部校验失败') + '）', invalid }
    const store = readStore()
    if (store.corrupt) return { ok: false, error: CORRUPT }
    const gname = (name && String(name).trim()) || '导入组'
    const existing = store.groups.find((g) => g.name === gname)
    const group = { id: existing ? existing.id : genId(), name: gname, importedAt: new Date().toISOString(), format, sats }
    // 导出同格式要与导入原文逐字节一致。先看规范重建能不能自己还原出原文——对官方 CelesTrak /
    // Space-Track 的文件一律能（见 test/ommFormats 的 16344 颗字节级回环），此时不必再存一份原文，
    // 库能小一倍。只有排版异于本平台的第三方文件才留原文兜底。
    // 去重/校验剔过星的组不留：组里只剩 N 颗而原文有 N+1 颗，原文已不是这个组的内容。
    const raw = String(text || '')
    const intact = sats.length === records.length
    let exact = false
    if (intact) { try { exact = recordsToText(sats, format) === raw } catch { exact = false } }
    if (!exact && intact && raw.length <= RAW_KEEP_MAX) { group.rawText = raw; group.rawCount = records.length }
    else { group.rawText = null; group.rawCount = 0 }
    // 同格式导出能否逐字节还原：重建自洽，或留了原文
    group.exact = exact || !!group.rawText
    if (existing) Object.assign(existing, group); else store.groups.push(group)
    writeStore(store)
    return { ok: true, group: { id: group.id, name: group.name, count: sats.length, format }, replaced: !!existing, invalid, errors: errs.concat(errors || []), warnings: warnings || [] }
  }
  function removeGroup(id) {
    const store = readStore()
    if (store.corrupt) return { ok: false, error: CORRUPT }
    store.groups = store.groups.filter((g) => g.id !== id)
    writeStore(store)
    return { ok: true, groups: store.groups.length }
  }
  function renameGroup(id, name) {
    const nm = (name && String(name).trim())
    if (!nm) return { ok: false, error: '名称不能为空' }
    const store = readStore()
    if (store.corrupt) return { ok: false, error: CORRUPT }
    const g = store.groups.find((x) => x.id === id)
    if (!g) return { ok: false, error: '组不存在' }
    g.name = nm
    writeStore(store)
    return { ok: true }
  }
  // 某组记录（导出用）；不存在返回 null。
  function groupRecords(id) {
    const g = readStore().groups.find((x) => x.id === id)
    return g ? (g.sats || []) : null
  }
  // 逐条 SGP4 校验的对外口子：给「替换内置星座组」那一路复用同一把尺（omm:import）。
  // 返回 { valid, invalid, reason }，reason 是第一条失败的原因，供上层直接显示。
  function checkRecords(records) {
    let valid = 0, invalid = 0, reason = ''
    for (const r of (Array.isArray(records) ? records : [])) {
      const v = validateRecord(getCore, r)
      if (v.ok) valid++
      else { invalid++; if (!reason) reason = `${r.name || ('NORAD ' + r.noradId)}：${v.reason}` }
    }
    return { valid, invalid, reason }
  }
  // 序列化任意 OMM 记录为指定格式（自建星座导出用，记录由渲染进程生成传入）。
  function recordsText(records, format) {
    const arr = Array.isArray(records) ? records : []
    if (!arr.length) return null
    return recordsToText(arr, normFormat(format) || 'omm-csv')
  }
  const recordsCsv = (records) => recordsText(records, 'omm-csv')
  // 某组导出为指定格式：格式与导入时相同且条数未变 → 吐原文（逐字节等同官方源文件）；否则规范重建。
  function groupText(id, format) {
    const g = readStore().groups.find((x) => x.id === id)
    if (!g) return null
    const want = normFormat(format) || 'omm-csv'
    const sats = g.sats || []
    if (!sats.length) return null
    if (g.rawText && normFormat(g.format) === want && g.rawCount === sats.length) return g.rawText
    return recordsToText(sats, want)
  }

  return { list, raw, importFile, removeGroup, renameGroup, groupRecords, recordsCsv, recordsText, groupText, checkRecords, _parseOMMCsv: parseOMMCsv }
}

// OMM CSV 解析器提成模块级静态导出：omm.js 的 satrecs() 也要用，
// 不该为了一个纯函数去造一个 customSats 实例（那会碰文件系统）。
module.exports.parseOMMCsv = parseOMMCsv
