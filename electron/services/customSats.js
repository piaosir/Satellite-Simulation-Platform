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
const ephF = require('../../packages/core/utils/ephemFormats.js')
const gpsAlm = require('../../packages/core/utils/gpsAlmanac.js')
const ephI = require('../../packages/core/utils/ephemInterp.js')
const ephemStore = require('./ephemStore')

// 【两种组】kind:'gp' = 平均根数（OMM/TLE，含 GPS 年历换算来的），走 SGP4，与本文件原有通路完全一致；
//   kind:'ephem' = 时间标签位置序列（STK .e / CCSDS OEM / SP3），走插值器，采样另存 ephemStore。
// 旧库里的组没有 kind，读回时一律补 'gp'（幂等，不写第二份）。
const KINDS = ['gp', 'ephem']
// 星历点序列星的合成 NORAD：800000 段，每组占 10000。useSatGroups.reconcile 与小程序打包
// 对 >=800000 一律豁免（它们不在任何官方编目里，查不到是正常的，不是「已离轨」）。
const EPHEM_NORAD_BASE = 800000
const EPHEM_GROUP_SLOT = 10000
// 采样表按【TEME】存：渲染端与各引擎要的就是 TEME，而渲染端那份 ESM 镜像吃不进 frames.js（CJS），
// 换帧只能在主进程做。导出时再由 TEME 换回组的原帧 —— 换帧来回误差 ~1e-12 km，远在 1e-9 km 的
// 打印分辨率以下，故「重序列化原样本」这条口径不受影响（customEphemStore.test.mjs 逐位验过）。

// 留存导入原文的体积上限（超过则不留，见头部说明）。8MB 覆盖 CelesTrak 最大的 active 组（~3.4MB）。
const RAW_KEEP_MAX = 8 * 1024 * 1024

// gp 组导出成点序列格式时的采样口径：缺省每颗星历元 ±1 天、步长 60 s、TEME —— 每颗 2881 次 SGP4
// （172800 s ÷ 60 s + 1）。颗数上限 300：再多就是同步几十秒起步的传播加上 GB 量级的采样缓冲，
// 全程跑在主进程，界面会整个冻住。
const EPHEM_SAMPLE = { stepS: 60, spanMs: 86400000, maxSats: 300 }

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

// 旧库里的 format 取值只有 'omm' / 'tle' 两种，统一到 ommFormats 的六种 id 上；
// 再并上 ephemFormats 的四种与 GPS 年历两种（后者换算成 OMM 记录后仍是 gp 组，只是 format 记来源）。
const FORMAT_MIGRATE = { omm: 'omm-csv', tle: 'tle' }
const ALL_FORMATS = eph.FORMATS.concat(ephF.FORMATS, ['yuma', 'sem'])
const normFormat = (f) => FORMAT_MIGRATE[f] || (ALL_FORMATS.includes(f) ? f : '')
const FORMAT_LABEL = Object.assign({}, eph.FORMAT_LABEL, ephF.FORMAT_LABEL, { yuma: 'GPS 年历（YUMA）', sem: 'GPS 年历（SEM）' })
// 组的三个显示属性（侧栏「导入星历」区块用）：旧库缺省即补，幂等。
function normGroup(g) {
  if (!g) return g
  if (!KINDS.includes(g.kind)) g.kind = 'gp'
  if (typeof g.visible !== 'boolean') g.visible = true
  if (typeof g.color !== 'string') g.color = ''
  return g
}

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
// ephem 组的 sats 是元数据（key/name/起止/点数/插值口径），不是 OMM 记录，不走 packSat/unpackSat。
const packGroups = (groups) => groups.map((g) => Object.assign({}, g, { sats: g.kind === 'ephem' ? (g.sats || []) : (g.sats || []).map(packSat) }))
const unpackGroups = (groups) => groups.map((g) => normGroup(Object.assign({}, g, { sats: g.kind === 'ephem' ? (g.sats || []) : (g.sats || []).map(unpackSat) })))

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

// GPS 年历（YUMA / SEM）-> OMM 记录。
// NORAD：年历里只有 PRN，没有编号。内置 gps 组的星名带「(PRN nn)」（CelesTrak 体例），
// 按它反查即可；查不到（没下载过 / 该 PRN 当天没在轨）就给 9 开头的合成号 —— 合成号只是个
// 身份标签，不参与任何计算，但不能与真实编号撞车。
const GPS_SYNTH_BASE = 990000
function gpsPrnIndex(getCore) {
  // 只读本机缓存，绝不联网（导入是个本地动作，不该因为没网就卡住）
  try {
    const base = process.env.SATSIM_DATA_DIR || path.join(require('electron').app.getPath('userData'), 'data')
    const f = path.join(base, 'omm', 'csv_gps.csv')
    const text = fs.readFileSync(f, 'utf8')
    const map = new Map()
    for (const r of parseOMMCsv(text)) {
      const m = /PRN\s*(\d+)/i.exec(r.name || '')
      if (m) map.set(String(parseInt(m[1], 10)), String(r.noradId))
    }
    return map
  } catch { return new Map() }
}
function almanacToRecords(text, getCore) {
  const core = getCore && getCore()
  const gstime = core && core.sgp4 && core.sgp4.gstime
  if (typeof gstime !== 'function') return null            // 引擎未就绪：这一档跳过，交给 ommFormats
  if (!gpsAlm.detectAlmanac(text)) return null
  const r = gpsAlm.parseAlmanac(text, { gstime })
  if (!r.records.length) return null
  const idx = gpsPrnIndex(getCore)
  let hit = 0
  for (const rec of r.records) {
    const found = idx.get(String(rec.prn))
    if (found) { rec.noradId = found; hit++ } else rec.noradId = String(GPS_SYNTH_BASE + rec.prn)
  }
  const warnings = r.warnings.slice()
  warnings.push('NORAD 反查：' + hit + ' / ' + r.records.length + ' 颗命中内置 GPS 组，其余用合成号')
  return { records: r.records, format: r.format, errors: r.errors, warnings }
}
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
  // 组列表（供文件管理与星座栏「导入星历」区块）：每组附卫星数、格式、导入时间、种类与显隐配色，
  // 以及组内卫星概览（供展开显示）。ephem 组的概览是起止时刻与点数，没有根数可派生。
  function list() {
    const store = readStore()
    const groups = store.groups.map((g) => ({
      id: g.id, name: g.name, importedAt: g.importedAt, format: normFormat(g.format),
      formatLabel: FORMAT_LABEL[normFormat(g.format)] || '',
      kind: g.kind, visible: g.visible, color: g.color,
      exact: g.kind === 'ephem' ? false : (g.exact !== undefined ? !!g.exact : !!(g.rawText && g.rawCount === (g.sats || []).length)),
      count: (g.sats || []).length,
      t0: g.kind === 'ephem' ? ephemSpan(g).t0 : null,
      t1: g.kind === 'ephem' ? ephemSpan(g).t1 : null,
      sats: (g.sats || []).map((s) => (g.kind === 'ephem' ? ephemSatView(s) : satView(s)))
    }))
    const out = { groups, count: groups.reduce((s, g) => s + g.count, 0), mtime: mtimeOf() }
    if (store.corrupt) out.error = CORRUPT
    return out
  }
  // 全部【gp】组扁平化为一份 OMM CSV（供 3D 地图「自定义卫星」分组 / 搜索池；按 NORAD 去重，后组覆盖）。
  // ★ 只吐 gp 组：ephem 组没有平均根数，塞进 OMM CSV 只会得到一堆 NaN。它们走 ephemTable。
  function raw() {
    const store = readStore()
    const recs = flatGp(store.groups.filter((g) => g.kind !== 'ephem'))
    return recs.length ? { text: recordsToCsv(recs), fetchedAt: mtimeOf() } : null
  }
  // 同上，但只吐【可见】的 gp 组，并另附 NORAD -> 'ci:<组id>' 的归属表 —— 地图按组着色链靠它命中。
  // （归属不写进 CSV：OMM CSV 是官方定死的 17 列，塞不进自造列，塞了也过不了回环判据。）
  function rawVisible() {
    const store = readStore()
    const vis = store.groups.filter((g) => g.kind !== 'ephem' && g.visible !== false)
    const groupOf = {}
    const recs = flatGp(vis, groupOf)
    return {
      text: recs.length ? recordsToCsv(recs) : '', fetchedAt: mtimeOf(), groupOf,
      groups: vis.map((g) => ({ id: g.id, name: g.name, color: g.color, count: (g.sats || []).length }))
    }
  }
  // 按 NORAD 去重（后组覆盖）；给了 groupOf 就同时记下每颗星最终归哪个组。
  function flatGp(groups, groupOf) {
    const map = new Map()
    for (const g of groups) {
      for (const r of (g.sats || [])) {
        const id = String(r.noradId)
        map.set(id, r)
        if (groupOf) groupOf[id] = 'ci:' + g.id
      }
    }
    return Array.from(map.values())
  }
  // ephem 组的时段（组内各星取并集）
  function ephemSpan(g) {
    let t0 = null, t1 = null
    for (const s of (g.sats || [])) {
      if (t0 == null || s.t0 < t0) t0 = s.t0
      if (t1 == null || s.t1 > t1) t1 = s.t1
    }
    return { t0, t1 }
  }
  const ephemSatView = (s) => ({
    key: s.key, name: s.name, noradId: s.noradId, objectId: s.objectId || '',
    frame: s.frame, timeSystem: s.timeSystem, t0: s.t0, t1: s.t1, n: s.n,
    interp: s.interp, stepS: s.n > 1 ? Math.round((s.t1 - s.t0) / (s.n - 1) / 1000) : null
  })
  // 导入一个文件 → 建/替换一个命名组（同名替换）。
  // 分派顺序：① 时间标签位置序列（.e / OEM / SP3）②【预留】GPS 年历 ③ 六种平均根数格式。
  // 三条路都按内容嗅探，扩展名不作判据。
  function importFile(name, text) {
    const efmt = ephF.detectFormat(text)
    if (efmt) return importEphem(name, text, efmt)
    const alm = almanacToRecords(text, getCore)
    if (alm) return importGp(name, text, alm.records, alm.format, alm.errors, alm.warnings)
    const p = parseAny(text)
    return importGp(name, text, p.records, p.format, p.errors, p.warnings)
  }

  // 【ephem】解析 -> 逐星建表校验 -> 组里只留元数据、采样另存 ephemStore。
  function importEphem(name, text, efmt) {
    const r = ephF.parseEphemeris(text, efmt, { name: (name && String(name).trim()) || '星历' })
    if (r.errors.length) return { ok: false, error: r.errors[0], errors: r.errors, warnings: r.warnings }
    if (!r.sats.length) return { ok: false, error: '文件里没有可用的星历点' }
    const store = readStore()
    if (store.corrupt) return { ok: false, error: CORRUPT }
    const gname = (name && String(name).trim()) || '导入星历'
    const existing = store.groups.find((g) => g.name === gname)
    const id = existing ? existing.id : genId()
    const base = existing && existing.noradBase ? existing.noradBase : nextNoradBase(store.groups)

    const meta = [], tables = [], errs = []
    const warnHits = new Map()   // 建表告警原句 -> { n: 出这句的颗数, name: 第一颗的星名 }
    let invalid = 0, dropped = 0
    r.sats.forEach((s, i) => {
      // buildTable 就是校验：至少 2 点、时刻严格递增、|r| 在 (Re+80 km, 2e6 km) 之间，坏样本剔除并计数
      const tab = ephI.buildTable(Object.assign({}, s, { interp: s.interp }))
      if (!tab) { invalid++; if (errs.length < 30) errs.push((s.name || ('#' + (i + 1))) + '：无有效采样点，已丢弃'); return }
      dropped += (s.t.length - tab.n)
      const key = String(s.objectId || s.name || ('s' + (i + 1)))
      meta.push({
        key, name: s.name || key, noradId: String(base + meta.length), objectId: s.objectId || '',
        frame: tab.srcFrame, timeSystem: s.timeSystem || 'UTC',
        t0: tab.t0, t1: tab.t1, n: tab.n, interp: { method: tab.method, samples: tab.samples }
      })
      tables.push({ key, t: tab.t, p: tab.p, v: tab.v, spans: spansOf(tab) })
      if (tab.warnings && tab.warnings.length) for (const w of tab.warnings) {
        const hit = warnHits.get(w)
        if (hit) hit.n++
        else warnHits.set(w, { n: 1, name: s.name || key })
      }
    })
    // 同一句告警跨 N 颗星只出一条。原来拿未加前缀的原句去查已加前缀的数组，indexOf 永远 -1，
    // 去重完全失效：一份 500 颗的 OEM 会刷出 500 条告警，真正不同的那条反被淹掉。
    for (const [w, hit] of warnHits) r.warnings.push((hit.n > 1 ? hit.n + ' 颗' : hit.name) + '：' + w)
    if (!meta.length) return { ok: false, error: '无有效卫星（' + (errs[0] || '全部采样无效') + '）', invalid }
    ephemStore.save(id, tables)
    const group = {
      id, name: gname, importedAt: new Date().toISOString(), format: efmt,
      kind: 'ephem', visible: existing ? existing.visible !== false : true, color: existing ? (existing.color || '') : '',
      noradBase: base, sats: meta
    }
    if (existing) { for (const k of Object.keys(existing)) if (!(k in group)) delete existing[k]; Object.assign(existing, group) }
    else store.groups.push(group)
    writeStore(store)
    return {
      ok: true, kind: 'ephem',
      group: { id, name: gname, count: meta.length, format: efmt, kind: 'ephem' },
      replaced: !!existing, invalid, dropped,
      errors: errs.concat(r.errors || []), warnings: r.warnings || []
    }
  }
  // 表内分段（OEM 多段）还原成 [[t0,t1],…]，存进采样文件，取回时再交给 buildTable
  function spansOf(tab) {
    if (!tab.sg || !tab.sgA) return null
    const out = []
    for (let s = 0; s < tab.sgA.length; s++) { if (tab.sgA[s] >= 0) out.push([tab.t[tab.sgA[s]], tab.t[tab.sgB[s]]]) }
    return out.length > 1 ? out : null
  }
  // 下一个可用的合成 NORAD 段首（每组 10000 个号）
  function nextNoradBase(groups) {
    let max = EPHEM_NORAD_BASE - EPHEM_GROUP_SLOT
    for (const g of groups) if (g.noradBase && g.noradBase > max) max = g.noradBase
    return max + EPHEM_GROUP_SLOT
  }

  // 【gp】原有通路，一个字没变：逐条 SGP4 校验；组内按 NORAD 去重（后者覆盖）。
  function importGp(name, text, records, format, errors, warnings) {
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
    // 同名替换时若原来是 ephem 组，它的采样文件得跟着走，否则留一地孤儿
    if (existing && existing.kind === 'ephem') { ephemStore.remove(existing.id); delete existing.noradBase; delete existing.sats }
    const group = {
      id: existing ? existing.id : genId(), name: gname, importedAt: new Date().toISOString(), format, sats,
      kind: 'gp', visible: existing ? existing.visible !== false : true, color: existing ? (existing.color || '') : ''
    }
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
    const g = store.groups.find((x) => x.id === id)
    store.groups = store.groups.filter((x) => x.id !== id)
    writeStore(store)
    // 采样文件跟着组一起删（ephem 组的大头在那边，留着就是孤儿）
    if (g && g.kind === 'ephem') ephemStore.remove(id)
    return { ok: true, groups: store.groups.length }
  }
  // 显隐 / 配色落库（星座栏「导入星历」区块用）。只改这两项，别的一个字不碰。
  function updateGroup(id, patch) {
    const store = readStore()
    if (store.corrupt) return { ok: false, error: CORRUPT }
    const g = store.groups.find((x) => x.id === id)
    if (!g) return { ok: false, error: '组不存在' }
    if (patch && typeof patch.visible === 'boolean') g.visible = patch.visible
    if (patch && typeof patch.color === 'string') g.color = patch.color
    writeStore(store)
    return { ok: true, id, visible: g.visible, color: g.color }
  }
  // 某 ephem 组的采样表（供渲染端与各引擎取位）。typed array 走结构化克隆，不转普通数组。
  function ephemTable(groupId) {
    const g = readStore().groups.find((x) => x.id === groupId)
    if (!g || g.kind !== 'ephem') return null
    const raw = ephemStore.load(groupId)
    if (!raw) return null
    const byKey = new Map(raw.sats.map((s) => [String(s.key), s]))
    const sats = []
    for (const m of (g.sats || [])) {
      const s = byKey.get(String(m.key))
      if (!s) continue
      // 分段索引随表一起发：渲染端（src/viz/constellation/ephemTable.js 的 tableFrom）没有建表
      // 逻辑、只认 sg/sgA/sgB，光发 spans 它会当成单段，多段 OEM 的缝里会跨段插出假位置。
      // 与主进程各引擎（ephemLookup / resolveOrbitSpec 走的 buildTable）共用同一个 segmentTables，
      // 输入也是同一份（s.t 就是建表时的 tab.t、s.spans 就是那张表的分段），故两侧取位逐位一致。
      const t = Float64Array.from(s.t)
      const seg = ephI.segmentTables(t, s.spans || null)
      sats.push({
        key: m.key, name: m.name, noradId: m.noradId, objectId: m.objectId,
        frame: 'TEME', srcFrame: m.frame, timeSystem: m.timeSystem,
        method: m.interp && m.interp.method, samples: m.interp && m.interp.samples,
        t, p: Float64Array.from(s.p), v: s.v ? Float64Array.from(s.v) : null,
        spans: s.spans || null, sg: seg.sg, sgA: seg.sgA, sgB: seg.sgB
      })
    }
    return sats.length ? { id: g.id, name: g.name, color: g.color, visible: g.visible, sats } : null
  }
  // 某 ephem 组里某颗星的取位表（主进程各引擎用：给 spec.ref 就能拿到可直接喂 orbitPos 的表）
  function ephemLookup(groupId, key) {
    const g = readStore().groups.find((x) => x.id === groupId)
    if (!g || g.kind !== 'ephem') return null
    const raw = ephemStore.load(groupId)
    if (!raw) return null
    const meta = (g.sats || []).find((s) => (key ? String(s.key) === String(key) : true))
    if (!meta) return null
    const s = raw.sats.find((x) => String(x.key) === String(meta.key))
    if (!s) return null
    // 采样已是 TEME，buildTable 不再换帧，只负责装表与分段
    return ephI.buildTable({
      t: s.t, p: s.p, v: s.v, frame: 'TEME', spans: s.spans || null,
      interp: meta.interp || {}
    })
  }
  // 轨道 spec 里的星历引用 -> 采样表。渲染端只传 ref（表几 MB，绝不进配置文件与 IPC 参数），
  // 主进程在进 core 之前把它换成 samples —— core 不碰文件系统，拿不到表就点名报错，不会静默退成 SGP4。
  function resolveOrbitSpec(spec) {
    if (!spec || spec.type !== 'ephem' || spec.samples || spec.table) return spec
    const ref = spec.ref || {}
    const g = readStore().groups.find((x) => x.id === ref.groupId)
    if (!g || g.kind !== 'ephem') return Object.assign({}, spec, { unresolved: '找不到星历组（可能已删除）' })
    const raw = ephemStore.load(ref.groupId)
    if (!raw) return Object.assign({}, spec, { unresolved: '星历采样文件读不出来' })
    const meta = (g.sats || []).find((s) => (ref.key ? String(s.key) === String(ref.key) : true))
    const s = meta && raw.sats.find((x) => String(x.key) === String(meta.key))
    if (!s) return Object.assign({}, spec, { unresolved: '星历组里找不到这颗星' })
    return Object.assign({}, spec, {
      noradId: spec.noradId != null ? spec.noradId : meta.noradId,
      name: spec.name || meta.name,
      samples: { t: s.t, p: s.p, v: s.v || null, frame: 'TEME', spans: s.spans || null, interp: meta.interp || {} }
    })
  }
  // 递归把请求体里所有 orbit spec 的 ref 换成 samples（各 link:* 通道的入参形状各不相同，
  // 逐个手接迟早漏一处；深走一遍最省心，请求体本身只有几十个键）。
  function resolveEphemDeep(obj, depth) {
    const d = depth || 0
    if (!obj || typeof obj !== 'object' || d > 6) return obj
    if (Array.isArray(obj)) return obj.map((x) => resolveEphemDeep(x, d + 1))
    if (obj.type === 'ephem' && obj.ref && !obj.samples && !obj.table) return resolveOrbitSpec(obj)
    let out = obj, copied = false
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if (!v || typeof v !== 'object') continue
      const nv = resolveEphemDeep(v, d + 1)
      if (nv !== v) { if (!copied) { out = Object.assign({}, obj); copied = true } out[k] = nv }
    }
    return out
  }

  // ephem 组重建成可序列化的星记录（导出用）：采样按 TEME 存，这里换回组的原帧。
  function ephemSats(groupId) {
    const g = readStore().groups.find((x) => x.id === groupId)
    if (!g || g.kind !== 'ephem') return null
    const raw = ephemStore.load(groupId)
    if (!raw) return null
    const byKey = new Map(raw.sats.map((s) => [String(s.key), s]))
    const out = []
    for (const m of (g.sats || [])) {
      const s = byKey.get(String(m.key))
      if (!s) continue
      const teme = {
        name: m.name, objectId: m.objectId, frame: 'TEME', timeSystem: 'UTC', interp: m.interp,
        t: Float64Array.from(s.t), p: Float64Array.from(s.p), v: s.v ? Float64Array.from(s.v) : null,
        spans: s.spans || null, meta: {}
      }
      out.push(m.frame && m.frame !== 'TEME' ? ephF.convertSat(teme, m.frame) : teme)
    }
    return out.length ? out : null
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
  // 某组的 OMM 记录（导出 / 小程序打包用）；不存在返回 null。
  // ★ ephem 组返回 null：它的 sats 是采样元数据不是根数，当成 OMM 记录传下去会一路静默出 NaN。
  //   点序列的消费口子是 ephemTable / ephemLookup。
  function groupRecords(id) {
    const g = readStore().groups.find((x) => x.id === id)
    return g && g.kind !== 'ephem' ? (g.sats || []) : null
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
  // opts 只对「gp 组导出成点序列格式」有意义（要按 SGP4 采样才有点可写），见 sampleGpToEphem。
  function groupText(id, format, opts) {
    const g = readStore().groups.find((x) => x.id === id)
    if (!g) return null
    // sp3 只解析不写出，落到它的导出请求一律归一成 stk-e（见 ephemFormats.writableFormat）
    const want = ephF.writableFormat(normFormat(format) || (g.kind === 'ephem' ? 'stk-e' : 'omm-csv'))
    const sats = g.sats || []
    if (!sats.length) return null
    const wantEphem = ephF.FORMATS.includes(want)
    if (g.kind === 'ephem') {
      // 点序列组只能导出成点序列格式 —— 它没有平均根数，出不了 OMM/TLE
      if (!wantEphem) throw new Error('星历点序列只能导出成 STK .e 或 CCSDS OEM')
      const es = ephemSats(id)
      if (!es) return null
      return ephF.serializeEphemeris(es, want, opts || {})
    }
    if (wantEphem) return ephF.serializeEphemeris(sampleGpToEphem(sats, opts), want, opts || {})
    if (g.rawText && normFormat(g.format) === want && g.rawCount === sats.length) return g.rawText
    return recordsToText(sats, want)
  }

  // gp 记录 -> 点序列星（自建星座 / 导入 OMM 组导出 .e / OEM 给 STK 用）。
  // 缺省跨度 = 历元 ±1 天、步长 60 s、TEME（任务书 §14 第 4 条）。
  function sampleGpToEphem(records, opts) {
    const o = opts || {}
    // 每颗星 = 时窗 ÷ 步长 + 1 次 SGP4，全程同步跑在主进程：不设上限时万颗组会把主进程冻住甚至 OOM
    const count = (records && records.length) || 0
    if (count > EPHEM_SAMPLE.maxSats) {
      throw new Error('按 SGP4 采样导出最多 ' + EPHEM_SAMPLE.maxSats + ' 颗（本次 ' + count + ' 颗），请拆成小组后导出')
    }
    const stepS = Math.max(1, Number(o.stepS) || EPHEM_SAMPLE.stepS)
    const frame = o.frame || 'TEME'
    const core = getCore && getCore()
    const sgp4 = core && core.sgp4
    if (!sgp4) throw new Error('SGP4 引擎未就绪，无法采样导出')
    const out = []
    for (const rec of records) {
      const satrec = sgp4.omm2satrec(rec)
      if (!satrec || satrec.error) continue
      const epochMs = epochDate(rec).getTime()
      const fromMs = Number.isFinite(Number(o.fromMs)) ? Number(o.fromMs) : epochMs - EPHEM_SAMPLE.spanMs
      const toMs = Number.isFinite(Number(o.toMs)) ? Number(o.toMs) : epochMs + EPHEM_SAMPLE.spanMs
      if (!(toMs > fromMs)) throw new Error('导出时段无效：起止时刻相同或颠倒')
      const n = Math.floor((toMs - fromMs) / (stepS * 1000)) + 1
      if (n < 2) throw new Error('导出时段太短：按 ' + stepS + ' s 步长取不到 2 个点')
      const t = new Float64Array(n), p = new Float64Array(3 * n), v = new Float64Array(3 * n)
      let k = 0
      for (let i = 0; i < n; i++) {
        const ms = fromMs + i * stepS * 1000
        const pv = sgp4.propagate(satrec, new Date(ms))
        if (!pv || !pv.position || !Number.isFinite(pv.position.x)) continue
        t[k] = ms
        p[3 * k] = pv.position.x; p[3 * k + 1] = pv.position.y; p[3 * k + 2] = pv.position.z
        v[3 * k] = pv.velocity.x; v[3 * k + 1] = pv.velocity.y; v[3 * k + 2] = pv.velocity.z
        k++
      }
      if (k < 2) continue
      const s = {
        name: rec.name || ('NORAD ' + rec.noradId), objectId: rec.objectId || '', frame: 'TEME', timeSystem: 'UTC',
        interp: { method: 'lagrange', samples: 6 },
        t: t.slice(0, k), p: p.slice(0, 3 * k), v: v.slice(0, 3 * k), spans: null, meta: {}
      }
      out.push(frame === 'TEME' ? s : ephF.convertSat(s, frame))
    }
    if (!out.length) throw new Error('没有可采样的卫星（SGP4 初始化或传播失败）')
    return out
  }
  // 任意 OMM 记录 -> 点序列格式文本（自建星座 / 向导星导出用）
  function recordsEphemText(records, format, opts) {
    const arr = Array.isArray(records) ? records : []
    if (!arr.length) return null
    return ephF.serializeEphemeris(sampleGpToEphem(arr, opts), ephF.writableFormat(format), opts || {})
  }

  return {
    list, raw, rawVisible, importFile, removeGroup, renameGroup, updateGroup,
    groupRecords, recordsCsv, recordsText, recordsEphemText, groupText, checkRecords,
    ephemTable, ephemLookup, ephemSats, sampleGpToEphem, resolveOrbitSpec, resolveEphemDeep,
    _parseOMMCsv: parseOMMCsv
  }
}

// OMM CSV 解析器提成模块级静态导出：omm.js 的 satrecs() 也要用，
// 不该为了一个纯函数去造一个 customSats 实例（那会碰文件系统）。
module.exports.parseOMMCsv = parseOMMCsv
// 采样导出的缺省口径与颗数上限：IPC 层要把它随保存结果回给渲染端，不该两边各写一份
module.exports.EPHEM_SAMPLE = EPHEM_SAMPLE
