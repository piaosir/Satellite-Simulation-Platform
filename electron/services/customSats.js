// 自定义卫星星历库（主进程）。
// 用户在「文件管理 · 星历」导入的 OMM CSV / TLE 文件，经 SGP4 校验、按 NORAD 去重后【按导入分组持久化】
// （userData/data/omm/custom.json，每文件一组）。文件管理是自定义卫星的唯一权威库——凡进星座地图/搜索池的
// 导入星必落此库（「文件」菜单的「导入 TLE 文件」与文件管理的「导入星历」同走此通路，不再有临时不落库的导入）。
// 全链路——星座地图 3D 的「自定义卫星」分组、
// NGSO/再生/链路预算「搜索卫星」候选池——都复用既有 `parseOMMCsv → omm2satrec` 通路，与官方星历同一 SGP4 口径。
//
// 【为何 TLE 也存成 OMM 记录仍严格无损】satellite.js 的 twoline2satrec 与 omm2satrec 使用同一套常量/单位缩放
// （见 src/viz/constellation/satellite.js 1678/1732 行、packages/core/vendor/satellite.js 同名函数）：
//   no=meanMotion/xpdotp、ecco=小数、inclo/nodeo/argpo/mo=deg·deg2rad、bstar=浮点、
//   ndot=mdot/(xpdotp*1440)、nddot=mddot/(xpdotp*1440*1440)。
// 因此把一条 TLE 严格拆列为 OMM 记录字段（meanMotion 原样 rev/day、ecc 补前导小数点、角度原样度、
// bstar/nddot 解包打包指数、mdot 取 TLE ndot 原印值、EPOCH 由 YYDDD.fff 转 ISO UTC），再走 omm2satrec，
// 与直接 twoline2satrec 生成 bit 级一致的 satrec。下方解析各列区间与 twoline2satrec 逐一对齐。

const fs = require('fs')
const path = require('path')

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

/* ===================== OMM 记录 → CSV 序列化（标准 CelesTrak 列，供 3D/搜索复用 & 互操作导出） ===================== */
const CSV_HEADER = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'EPHEMERIS_TYPE', 'CLASSIFICATION_TYPE',
  'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT']
const csvEsc = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
function recordsToCsv(records) {
  const rows = [CSV_HEADER.join(',')]
  for (const r of records) {
    rows.push([
      csvEsc(r.name), csvEsc(r.objectId || ''), csvEsc(r.epoch), csvEsc(r.meanMotion), csvEsc(r.ecc),
      csvEsc(r.incl), csvEsc(r.raan), csvEsc(r.argp), csvEsc(r.ma), '0', 'U',
      csvEsc(r.noradId), '999', '0', csvEsc(r.bstar || '0'), csvEsc(r.mdot || '0'), csvEsc(r.mddot || '0')
    ].join(','))
  }
  return rows.join('\r\n') + '\r\n'
}

/* ===================== TLE 严格解析 → OMM 记录 ===================== */
// Alpha-5：CelesTrak 5 位编号扩展，首位可为字母（去掉易混的 I、O）。A=10, B=11 … H=17, J=18 … Z=33。
const ALPHA5 = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
function decodeSatnum(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  const c0 = s[0]
  if (/[A-Za-z]/.test(c0)) {
    const idx = ALPHA5.indexOf(c0.toUpperCase())
    if (idx < 0) return String(parseInt(s.replace(/\D/g, ''), 10) || 0)   // 非 Alpha-5 字母：退回纯数字
    return String((10 + idx) * 10000 + (parseInt(s.slice(1), 10) || 0))
  }
  return String(parseInt(s, 10) || 0)
}
// TLE 行 mod-10 校验：数字累加，'-' 计 1，其余计 0；与第 69 列(索引 68)比对。
function tleChecksum(line) {
  let sum = 0
  for (let i = 0; i < 68 && i < line.length; i++) {
    const c = line[i]
    if (c >= '0' && c <= '9') sum += (c.charCodeAt(0) - 48)
    else if (c === '-') sum += 1
  }
  return sum % 10
}
// YY(两位年) + 年内天(含小数) → ISO UTC 串（毫秒精度）。年份轴心 <57→20xx，与 twoline2satrec 一致。
function tleEpochToIso(epochyr, epochdays) {
  const year = epochyr < 57 ? epochyr + 2000 : epochyr + 1900
  // omm2satrec 解析 ISO 时精度到毫秒（new Date(...).getUTCMilliseconds()），故此处取整到毫秒（就近，误差 ≤0.5ms）。
  const ms = Date.UTC(year, 0, 1) + (epochdays - 1) * 86400000
  const d = new Date(Math.round(ms))
  return isNaN(d.getTime()) ? '' : d.toISOString()
}
// 国际标识(COSPAR) L1 第 10-17 列 "YYNNNPPP" → "YYYY-NNNPPP"
function tleObjectId(l1) {
  const yy = l1.substring(9, 11).trim()
  const rest = l1.substring(11, 17).trim()
  if (!/^\d{2}$/.test(yy)) return ''
  const y = parseInt(yy, 10)
  const full = y < 57 ? 2000 + y : 1900 + y
  return rest ? `${full}-${rest}` : ''
}
const num = (sub) => { const v = parseFloat(sub); return Number.isFinite(v) ? v : NaN }

// 单条 TLE(两行 + 可选名称) → OMM 记录。列区间与 satellite.js twoline2satrec 逐一对齐。
function buildFromTle(name, l1, l2, lineNo, errors, warnings) {
  try {
    if (l1.length < 64 || l2.length < 64) { errors.push(`第 ${lineNo} 行：TLE 行长度不足（应 ≥69 列）`); return null }
    const sat1 = l1.substring(2, 7).trim(), sat2 = l2.substring(2, 7).trim()
    const noradId = decodeSatnum(sat1)
    if (!noradId || noradId === '0') { errors.push(`第 ${lineNo} 行：无法解析 NORAD 编号`); return null }
    if (sat1 !== sat2) warnings.push(`NORAD ${noradId}：两行编号不一致（${sat1} / ${sat2}）`)
    // 校验和（警告级：手工/老 TLE 校验位常不准，但根数仍可用；不因此拒收）
    const cs1 = Number(l1[68]), cs2 = Number(l2[68])
    if (Number.isFinite(cs1) && tleChecksum(l1) !== cs1) warnings.push(`NORAD ${noradId}：第 1 行校验和不符`)
    if (Number.isFinite(cs2) && tleChecksum(l2) !== cs2) warnings.push(`NORAD ${noradId}：第 2 行校验和不符`)

    const epochyr = parseInt(l1.substring(18, 20), 10)
    const epochdays = num(l1.substring(20, 32))
    if (!Number.isInteger(epochyr) || !Number.isFinite(epochdays)) { errors.push(`NORAD ${noradId}：历元解析失败`); return null }
    const epoch = tleEpochToIso(epochyr, epochdays)
    if (!epoch) { errors.push(`NORAD ${noradId}：历元无效`); return null }

    // mdot = TLE 第 1 行 ndot 原印值(rev/day²，即“n 点/2”栏)；omm2satrec 与 twoline2satrec 同样再 /(xpdotp*1440)
    const mdot = num(l1.substring(33, 43))
    // nddot / bstar 打包指数 → 浮点（与 twoline2satrec 完全相同的拼装式）
    const nddot = parseFloat(`${l1.substring(44, 45)}.${l1.substring(45, 50)}E${l1.substring(50, 52)}`)
    const bstar = parseFloat(`${l1.substring(53, 54)}.${l1.substring(54, 59)}E${l1.substring(59, 61)}`)

    const incl = num(l2.substring(8, 16))
    const raan = num(l2.substring(17, 25))
    const ecc = parseFloat(`.${l2.substring(26, 33).replace(/\s/g, '0')}`)  // 隐含前导小数点
    const argp = num(l2.substring(34, 42))
    const ma = num(l2.substring(43, 51))
    const meanMotion = num(l2.substring(52, 63))

    if (!(meanMotion > 0)) { errors.push(`NORAD ${noradId}：平均运动无效`); return null }
    if (!(ecc >= 0 && ecc < 1)) { errors.push(`NORAD ${noradId}：偏心率超范围 (${ecc})`); return null }
    if (!(incl >= 0 && incl <= 180)) { errors.push(`NORAD ${noradId}：倾角超范围 (${incl})`); return null }
    if (!Number.isFinite(raan) || !Number.isFinite(argp) || !Number.isFinite(ma)) { errors.push(`NORAD ${noradId}：角度根数解析失败`); return null }

    return {
      name: (name && name.trim()) || `NORAD ${noradId}`,
      noradId, objectId: tleObjectId(l1), epoch,
      meanMotion: String(meanMotion), ecc: String(ecc), incl: String(incl), raan: String(raan),
      argp: String(argp), ma: String(ma),
      bstar: String(Number.isFinite(bstar) ? bstar : 0),
      mdot: String(Number.isFinite(mdot) ? mdot : 0),
      mddot: String(Number.isFinite(nddot) ? nddot : 0)
    }
  } catch (e) { errors.push(`第 ${lineNo} 行：TLE 解析异常 ${e.message || e}`); return null }
}

// 整段 TLE 文本（支持一文件多星、2 行 / 3 行含名称、名称行可带前导 "0 "）→ { records, errors, warnings }
function parseTleText(text) {
  const records = [], errors = [], warnings = []
  const raw = String(text || '').split(/\r?\n/)
  const lines = []
  for (let i = 0; i < raw.length; i++) { const t = raw[i].replace(/\s+$/, ''); if (t.trim()) lines.push({ t, n: i + 1 }) }
  let i = 0, pendingName = null
  const isL1 = (s) => s[0] === '1' && (s[1] === ' ' || s.length >= 64)
  const isL2 = (s) => s[0] === '2' && (s[1] === ' ' || s.length >= 64)
  while (i < lines.length) {
    const cur = lines[i], s = cur.t
    if (isL1(s)) {
      const l2e = lines[i + 1]
      if (!l2e || !isL2(l2e.t)) { errors.push(`第 ${cur.n} 行：TLE 第 1 行后缺少配对的第 2 行`); i++; pendingName = null; continue }
      const rec = buildFromTle(pendingName, s, l2e.t, cur.n, errors, warnings)
      if (rec) records.push(rec)
      i += 2; pendingName = null; continue
    }
    if (isL2(s)) { errors.push(`第 ${cur.n} 行：孤立的 TLE 第 2 行（无配对第 1 行）`); i++; pendingName = null; continue }
    pendingName = s.replace(/^0 /, '').trim()   // 名称行（3 行格式）
    i++
  }
  return { records, errors, warnings }
}

/* ===================== 校验 / 存储 / 合并 ===================== */
// 用与全链路一致的 SGP4 引擎校验：能构 satrec 且历元处传播出有限位置（滤除衰落/病态根数）。
function validateRecord(getCore, rec) {
  try {
    const core = getCore && getCore()
    const sgp4 = core && core.sgp4
    if (!sgp4 || !sgp4.omm2satrec) return { ok: true }   // 引擎未就绪：仅依赖解析层数值校验
    const satrec = sgp4.omm2satrec(rec)
    if (!satrec || satrec.error) return { ok: false, reason: `SGP4 初始化失败（error=${satrec && satrec.error}）` }
    const pv = sgp4.propagate(satrec, new Date(rec.epoch))
    if (!pv || !pv.position || !['x', 'y', 'z'].every((k) => Number.isFinite(pv.position[k]))) {
      return { ok: false, reason: '历元处无有效位置（可能已衰落或根数病态）' }
    }
    return { ok: true }
  } catch (e) { return { ok: false, reason: e.message || String(e) } }
}

// —— 分组存储（custom.json = { groups: [{ id, name, importedAt, format, sats:[OMM记录] }] }）——
// 旧版单文件路径：早期把导入统一存成一份扁平 custom.csv，后改为分组 custom.json。
const legacyCsvFile = () => path.join(cacheDir(), 'custom.csv')
// 读库：优先 custom.json；无 json 但有旧版 custom.csv 时自动迁移为一个「历史导入」组，
// 使文件管理 / 地图分组 / 搜索池一并识别历史导入（文件管理是自定义卫星的唯一权威库）。
function readStore() {
  try { const j = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); if (j && Array.isArray(j.groups)) return j } catch { /* 无/坏 custom.json：尝试迁移旧版 custom.csv */ }
  try {
    const legacy = legacyCsvFile()
    const recs = parseOMMCsv(fs.readFileSync(legacy, 'utf8'))
    if (recs.length) {
      let importedAt; try { importedAt = fs.statSync(legacy).mtime.toISOString() } catch { importedAt = new Date().toISOString() }
      const store = { groups: [{ id: genId(), name: '历史导入', importedAt, format: 'omm', sats: recs }] }
      writeStore(store)
      try { fs.renameSync(legacy, legacy + '.migrated') } catch { /* 迁移后原文件保留亦无妨（json 已优先） */ }
      return store
    }
  } catch { /* 无旧文件：全新空库 */ }
  return { groups: [] }
}
function writeStore(store) {
  const f = storeFile()
  if (!store || !store.groups || !store.groups.length) { try { fs.unlinkSync(f) } catch { /* 已空 */ } ; return }
  fs.writeFileSync(f, JSON.stringify(store))
}
const mtimeOf = () => { try { return fs.statSync(storeFile()).mtime.toISOString() } catch { return null } }
let _seq = 0
const genId = () => 'g' + Date.now().toString(36) + (_seq++).toString(36)

// 解析文本 → OMM 记录 + 格式。既非 OMM 也非 TLE 返回 records=[]。
function parseAny(text) {
  const csv = parseOMMCsv(text)
  if (csv.length) return { records: csv, format: 'omm', errors: [], warnings: [] }
  const t = parseTleText(text)
  return { records: t.records, format: 'tle', errors: t.errors || [], warnings: t.warnings || [] }
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
      id: g.id, name: g.name, importedAt: g.importedAt, format: g.format || '',
      count: (g.sats || []).length, sats: (g.sats || []).map(satView)
    }))
    return { groups, count: groups.reduce((s, g) => s + g.count, 0), mtime: mtimeOf() }
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
    if (!records.length) return { ok: false, error: '既不是有效的 OMM CSV，也不是有效的 TLE（' + (errors[0] || '格式不符') + '）' }
    const map = new Map(); let invalid = 0; const errs = []
    for (const r of records) {
      const v = validateRecord(getCore, r)
      if (!v.ok) { invalid++; if (errs.length < 30) errs.push(`${r.name || ('NORAD ' + r.noradId)}：${v.reason}`); continue }
      map.set(String(r.noradId), r)
    }
    const sats = Array.from(map.values())
    if (!sats.length) return { ok: false, error: '无有效卫星（' + (errs[0] || '全部校验失败') + '）', invalid }
    const store = readStore()
    const gname = (name && String(name).trim()) || '导入组'
    const existing = store.groups.find((g) => g.name === gname)
    const group = { id: existing ? existing.id : genId(), name: gname, importedAt: new Date().toISOString(), format, sats }
    if (existing) Object.assign(existing, group); else store.groups.push(group)
    writeStore(store)
    return { ok: true, group: { id: group.id, name: group.name, count: sats.length, format }, replaced: !!existing, invalid, errors: errs.concat(errors || []), warnings: warnings || [] }
  }
  function removeGroup(id) {
    const store = readStore()
    store.groups = store.groups.filter((g) => g.id !== id)
    writeStore(store)
    return { ok: true, groups: store.groups.length }
  }
  function renameGroup(id, name) {
    const nm = (name && String(name).trim())
    if (!nm) return { ok: false, error: '名称不能为空' }
    const store = readStore()
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
  // 序列化任意 OMM 记录为 CSV（自建星座导出用，记录由渲染进程生成传入）。
  function recordsCsv(records) {
    const arr = Array.isArray(records) ? records : []
    return arr.length ? recordsToCsv(arr) : null
  }

  return { list, raw, importFile, removeGroup, renameGroup, groupRecords, recordsCsv, _parseTleText: parseTleText, _parseOMMCsv: parseOMMCsv }
}
