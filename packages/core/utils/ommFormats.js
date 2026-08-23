// 官方星历格式全集：解析（六种格式 → OMM 记录）与序列化（OMM 记录 → 六种格式）。
//
// 【格式清单】与两大数据源（CelesTrak gp.php?FORMAT= / Space-Track gp 类）对齐：
//   tle       两行定长卡片（无名称行）
//   3le       三行（名称行带前导 "0 "）
//   omm-csv   CCSDS OMM 数据段摊平成 CSV（CelesTrak 17 列体例）
//   omm-json  CCSDS OMM 数据段摊平成 JSON 数组（数值为 JSON number）
//   omm-kvn   CCSDS 502.0-B 关键字=值报文（多星＝多段顺序拼接）
//   omm-xml   CCSDS 505.0-B NDM/XML（多星＝<ndm> 根下多个 <omm>）
// 其中 omm-kvn / omm-xml 才是 CCSDS 规范序列化；csv/json 是两大源摊平数据段的便利格式；tle/3le
// 是前 OMM 时代的定长卡片。OPM/OEM/OCM 是另外的报文类型（笛卡尔状态矢量 / 插值星历点序列），
// 不是平均根数，喂不进 SGP4，故【不在本模块范围内】——收进来也传播不了。
//
// 【“与官方完全一致”怎么保住】两级：
//   ① 字节级——同格式回环。导入时留原文，导出同格式直接吐原文（组级，在 customSats 里做）。
//   ② 规范级——跨格式重建。字段值一律【搬源串】不做数值往返：官方 CSV 写 ECCENTRICITY=.00278136，
//      经 Number() 再 String() 会变成 0.00278136，字节就对不上了。故记录里 f{} 存的全是原样字符串。
//   只有源本身不是文本（omm-json 的 JSON number）或根本没有源（自建 Walker 星座）时，才按下面
//   实测自官方样本（resources/omm/csv_active.csv，16345 颗）的体例格式化：
//      MEAN_MOTION              8 位小数定点，保尾零        13.76679809
//      INCLINATION/RAAN/ARGP/MA 4 位小数定点，保尾零        90.2300
//      ECCENTRICITY             定点去前导 0，去尾零        .00278136
//      BSTAR/MM_DOT/MM_DDOT     尾数 [0.1,1) 科学计数，零写 0   .39713338E-3 / -.2080145E-5 / 0
//      EPOCH                    ISO 6 位微秒、不带 Z         2026-08-18T00:55:00.137856
//
// 【精度的诚实边界】CelesTrak/Space-Track 的 csv/json/kvn/xml 四种同出一份高精度 GP 库
// （BSTAR 尾数 8 位），而 tle/3le 是从中截断进定长栏位的（BSTAR 尾数 5 位、角度 4 位）。故：
//   OMM 四格式互转 = 无损；OMM → tle/3le = 有损（栏位截断，不可逆）；tle → OMM = 只有 TLE 的精度。
//
// 【记录形状】契约 13 字段（name/noradId/…/mddot）是全平台既有通路的口径，与 parseOMMCsv 产物
// 逐字段同名同型（字符串），下游 omm2satrec / geoSlot / 小程序打包一概不必改；新增的 f{} 只服务
// 于“导出与官方一致”，谁都不读也不会坏事。

'use strict'

/* ===================== 官方字段表（CCSDS 502.0-B-3 分段） ===================== */
const HEADER_KEYS = ['CCSDS_OMM_VERS', 'CLASSIFICATION', 'CREATION_DATE', 'ORIGINATOR', 'MESSAGE_ID']
const META_KEYS = ['OBJECT_NAME', 'OBJECT_ID', 'CENTER_NAME', 'REF_FRAME', 'REF_FRAME_EPOCH', 'TIME_SYSTEM', 'MEAN_ELEMENT_THEORY']
const MEAN_KEYS = ['EPOCH', 'SEMI_MAJOR_AXIS', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'GM']
const SPACECRAFT_KEYS = ['MASS', 'SOLAR_RAD_AREA', 'SOLAR_RAD_COEFF', 'DRAG_AREA', 'DRAG_COEFF']
// BTERM/AGOM 是 SGP4-XP 理论下 BSTAR/MEAN_MOTION_DDOT 的对应项（502.0-B-3 §5.2.5）
const TLE_KEYS = ['EPHEMERIS_TYPE', 'CLASSIFICATION_TYPE', 'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH',
  'BSTAR', 'BTERM', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT', 'AGOM']
// 6×6 位置速度协方差下三角 21 项 + 参考系
const COV_KEYS = ['COV_REF_FRAME',
  'CX_X', 'CY_X', 'CY_Y', 'CZ_X', 'CZ_Y', 'CZ_Z',
  'CX_DOT_X', 'CX_DOT_Y', 'CX_DOT_Z', 'CX_DOT_X_DOT',
  'CY_DOT_X', 'CY_DOT_Y', 'CY_DOT_Z', 'CY_DOT_X_DOT', 'CY_DOT_Y_DOT',
  'CZ_DOT_X', 'CZ_DOT_Y', 'CZ_DOT_Z', 'CZ_DOT_X_DOT', 'CZ_DOT_Y_DOT', 'CZ_DOT_Z_DOT']

// CelesTrak GP FORMAT=csv 的列序（逐字逐序，导出即官方表头）
const CSV_COLS = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'EPHEMERIS_TYPE', 'CLASSIFICATION_TYPE',
  'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT']

const ALL_KEYS = [].concat(HEADER_KEYS, META_KEYS, MEAN_KEYS, SPACECRAFT_KEYS, TLE_KEYS, COV_KEYS)

const FORMATS = ['omm-csv', 'omm-json', 'omm-kvn', 'omm-xml', 'tle', '3le']
const FORMAT_LABEL = {
  'omm-csv': 'OMM CSV', 'omm-json': 'OMM JSON', 'omm-kvn': 'OMM KVN（CCSDS）',
  'omm-xml': 'OMM XML（CCSDS）', tle: 'TLE（两行）', '3le': '3LE（三行）'
}
const FORMAT_EXT = { 'omm-csv': 'csv', 'omm-json': 'json', 'omm-kvn': 'kvn', 'omm-xml': 'xml', tle: 'tle', '3le': '3le' }
// 缺省元数据：CelesTrak/Space-Track 的 GP 数据恒为这一套（跨格式重建时补齐，源里有则以源为准）
const DEFAULTS = {
  CCSDS_OMM_VERS: '2.0', ORIGINATOR: '18 SPCS', CENTER_NAME: 'EARTH', REF_FRAME: 'TEME',
  TIME_SYSTEM: 'UTC', MEAN_ELEMENT_THEORY: 'SGP4', EPHEMERIS_TYPE: '0', CLASSIFICATION_TYPE: 'U'
}

/* ===================== 数值 → 官方串（仅在无源串时使用） ===================== */
const FIX8 = new Set(['MEAN_MOTION'])
const FIX4 = new Set(['INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY'])
const SCI = new Set(['BSTAR', 'BTERM', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT', 'AGOM'])

// 定点串去前导 0（官方体例：.00278136 而非 0.00278136）
const dropLeadZero = (s) => String(s).replace(/^(-?)0\./, '$1.')
// 十进制去尾零表示；JS 对 |v|<1e-6 会自动转科学计数，这里改回定点铺开
function plainDecimal(n) {
  let s = String(n)
  if (!/e/i.test(s)) return s
  const d = Math.max(0, -Math.floor(Math.log10(Math.abs(n))) + 17)
  return n.toFixed(Math.min(d, 100)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}
// 官方科学体例：尾数归一到 [0.1,1) 去前导 0 与尾零，指数十进制带符号；零写 "0"
function sciOfficial(n) {
  if (!Number.isFinite(n) || n === 0) return '0'
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  let exp = Math.floor(Math.log10(a)) + 1
  let mant = a / Math.pow(10, exp)
  // 浮点边界修正：log10 取整误差会把尾数推出 [0.1,1)
  if (mant >= 1) { mant /= 10; exp += 1 }
  else if (mant < 0.1) { mant *= 10; exp -= 1 }
  // 尾数最多 8 位有效（官方样本上限），去尾零
  let ms = mant.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
  if (ms === '1') { ms = '.1'; exp += 1 } else ms = dropLeadZero(ms)
  if (ms === '.') ms = '0'
  return `${sign}${ms}E${exp < 0 ? '-' : '+'}${Math.abs(exp)}`
}
// 任意入参（源串 / number / null）→ 该字段的官方串。源串一律原样搬，只有 number 才格式化。
function officialValue(key, v) {
  if (v == null || v === '') return ''
  if (typeof v === 'string') return v.trim()        // 源串原样：字节级一致的根
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  if (FIX8.has(key)) return n.toFixed(8)
  if (FIX4.has(key)) return n.toFixed(4)
  if (SCI.has(key)) return sciOfficial(n)
  if (key === 'ECCENTRICITY') return dropLeadZero(plainDecimal(n))
  return plainDecimal(n)
}
// 历元 → 官方 ISO 体例（6 位微秒、不带 Z）。已是该体例的串原样返回。
function officialEpoch(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(s)) return s
  const d = new Date(/[zZ]$/.test(s) ? s : s + 'Z')
  if (isNaN(d.getTime())) return s
  const p = (x, w) => String(x).padStart(w, '0')
  // 毫秒之下 JS Date 没有，补 000；源串带更高精度时上面的整形分支已原样放行
  const frac = /\.(\d+)/.exec(s)
  const us = frac ? (frac[1] + '000000').slice(0, 6) : p(d.getUTCMilliseconds(), 3) + '000'
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1, 2)}-${p(d.getUTCDate(), 2)}T` +
    `${p(d.getUTCHours(), 2)}:${p(d.getUTCMinutes(), 2)}:${p(d.getUTCSeconds(), 2)}.${us}`
}

/* ===================== 记录构造：官方字段字典 f{} ⇄ 全链路契约 13 字段 ===================== */
// f{} → 契约字段。契约字段一律字符串，与 parseOMMCsv 产物同型（下游 Number() 取值）。
function recordFromFields(f) {
  const g = (k) => (f[k] == null ? '' : String(f[k]).trim())
  const noradId = g('NORAD_CAT_ID')
  if (!noradId) return null
  return {
    name: g('OBJECT_NAME') || ('NORAD ' + noradId),
    noradId, objectId: g('OBJECT_ID'), epoch: g('EPOCH'),
    meanMotion: g('MEAN_MOTION'), ecc: g('ECCENTRICITY'), incl: g('INCLINATION'),
    raan: g('RA_OF_ASC_NODE'), argp: g('ARG_OF_PERICENTER'), ma: g('MEAN_ANOMALY'),
    bstar: g('BSTAR') || g('BTERM') || '0',
    mdot: g('MEAN_MOTION_DOT') || '0',
    mddot: g('MEAN_MOTION_DDOT') || g('AGOM') || '0',
    f
  }
}
// 契约字段 → f{}（老记录 / 自建星座记录没有 f 时补出来，配 DEFAULTS 与官方体例）
function fieldsFromRecord(r) {
  if (r && r.f && r.f.NORAD_CAT_ID) return r.f
  const f = Object.assign({}, DEFAULTS)
  f.OBJECT_NAME = r.name || ''
  f.OBJECT_ID = r.objectId || ''
  f.NORAD_CAT_ID = String(r.noradId == null ? '' : r.noradId)
  f.EPOCH = officialEpoch(r.epoch)
  f.MEAN_MOTION = officialValue('MEAN_MOTION', numOrStr(r.meanMotion))
  f.ECCENTRICITY = officialValue('ECCENTRICITY', numOrStr(r.ecc))
  f.INCLINATION = officialValue('INCLINATION', numOrStr(r.incl))
  f.RA_OF_ASC_NODE = officialValue('RA_OF_ASC_NODE', numOrStr(r.raan))
  f.ARG_OF_PERICENTER = officialValue('ARG_OF_PERICENTER', numOrStr(r.argp))
  f.MEAN_ANOMALY = officialValue('MEAN_ANOMALY', numOrStr(r.ma))
  f.BSTAR = officialValue('BSTAR', numOrStr(r.bstar))
  f.MEAN_MOTION_DOT = officialValue('MEAN_MOTION_DOT', numOrStr(r.mdot))
  f.MEAN_MOTION_DDOT = officialValue('MEAN_MOTION_DDOT', numOrStr(r.mddot))
  f.ELEMENT_SET_NO = f.ELEMENT_SET_NO || '999'
  f.REV_AT_EPOCH = f.REV_AT_EPOCH || '0'
  return f
}
// 契约字段存的是“源串”（如 .00278136）时按串走，纯数字串按数字走 —— 前者保字节，后者补体例。
// 判据：官方体例串（前导点 / 带 E / 定长尾零）不能被 String(Number(s)) 还原的，视为源串。
function numOrStr(v) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return String(n) === s ? n : s
}

/* ===================== ① OMM CSV ===================== */
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
const csvEsc = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }

// 表头驱动、大小写不敏感、列序无关；认识的列进 f{}，不认识的列忽略（Space-Track 的扩展列即走此路）。
function parseCsv(text) {
  const errors = [], warnings = [], records = []
  const lines = String(text || '').split(/\r?\n/)
  let h = 0
  while (h < lines.length && !lines[h].trim()) h++
  if (h >= lines.length) return { records, errors, warnings }
  const header = splitCsvLine(lines[h]).map((s) => s.trim().toUpperCase())
  const known = new Set(ALL_KEYS)
  if (!header.includes('EPOCH') || !header.includes('MEAN_MOTION') || !header.includes('NORAD_CAT_ID')) {
    return { records, errors, warnings }   // 缺三根支柱 → 判为非 OMM CSV，交给下一个嗅探器
  }
  for (let r = h + 1; r < lines.length; r++) {
    if (!lines[r].trim()) continue
    const cells = splitCsvLine(lines[r])
    const f = {}
    for (let i = 0; i < header.length; i++) {
      const k = header[i]
      if (!known.has(k)) continue
      const v = (cells[i] == null ? '' : String(cells[i]).trim())
      if (v !== '') f[k] = v
    }
    const rec = recordFromFields(f)
    if (rec) records.push(rec)
    else errors.push(`第 ${r + 1} 行：缺 NORAD_CAT_ID`)
  }
  return { records, errors, warnings }
}
function serializeCsv(records) {
  const rows = [CSV_COLS.join(',')]
  for (const r of records) {
    const f = fieldsFromRecord(r)
    rows.push(CSV_COLS.map((k) => csvEsc(f[k] == null ? '' : f[k])).join(','))
  }
  return rows.join('\r\n') + '\r\n'     // 官方 CSV 行尾为 CRLF，末行也带
}

/* ===================== ② OMM JSON ===================== */
// 数值字段在官方 JSON 里是 JSON number；解析时【连同串体例一起留下】：f{} 存官方串（供转文本格式），
// 记录另挂 jsonNum 存原 number（供 JSON 原样回环）。
const JSON_NUM_KEYS = new Set(['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'EPHEMERIS_TYPE', 'NORAD_CAT_ID', 'ELEMENT_SET_NO',
  'REV_AT_EPOCH', 'BSTAR', 'BTERM', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT', 'AGOM', 'SEMI_MAJOR_AXIS', 'GM'])
function parseJsonText(text) {
  const errors = [], warnings = [], records = []
  let root
  try { root = JSON.parse(String(text || '')) } catch (e) { return { records, errors: ['JSON 解析失败：' + (e.message || e)], warnings } }
  const arr = Array.isArray(root) ? root : (root && Array.isArray(root.data) ? root.data : (root && typeof root === 'object' ? [root] : []))
  const known = new Set(ALL_KEYS)
  for (let i = 0; i < arr.length; i++) {
    const o = arr[i]
    if (!o || typeof o !== 'object') continue
    const f = {}, jsonNum = {}
    for (const rawK of Object.keys(o)) {
      const k = rawK.trim().toUpperCase()
      if (!known.has(k)) continue
      const v = o[rawK]
      if (v == null || v === '') continue
      if (typeof v === 'number') { jsonNum[k] = v; f[k] = officialValue(k, v) }
      else f[k] = String(v).trim()
    }
    const rec = recordFromFields(f)
    if (rec) { rec.jsonNum = jsonNum; records.push(rec) }
    else errors.push(`第 ${i + 1} 条：缺 NORAD_CAT_ID`)
  }
  if (!records.length && arr.length) errors.push('JSON 里没有可用的 OMM 记录（缺 NORAD_CAT_ID）')
  return { records, errors, warnings }
}
function serializeJson(records, opts) {
  const pretty = !!(opts && opts.pretty)
  const out = records.map((r) => {
    const f = fieldsFromRecord(r)
    const num = r.jsonNum || {}
    const o = {}
    for (const k of CSV_COLS) {
      if (f[k] == null || f[k] === '') continue
      // 源本是 JSON number 的原样吐回（字节级回环）；源是文本格式的按官方 JSON 体例转 number
      if (Object.prototype.hasOwnProperty.call(num, k)) o[k] = num[k]
      else if (JSON_NUM_KEYS.has(k)) { const n = Number(f[k]); o[k] = Number.isFinite(n) ? n : f[k] }
      else o[k] = f[k]
    }
    for (const k of ALL_KEYS) {   // 官方 17 列之外的（协方差 / 航天器参数 / 元数据）补在后面
      if (CSV_COLS.includes(k) || f[k] == null || f[k] === '') continue
      if (Object.prototype.hasOwnProperty.call(num, k)) o[k] = num[k]
      else if (JSON_NUM_KEYS.has(k)) { const n = Number(f[k]); o[k] = Number.isFinite(n) ? n : f[k] }
      else o[k] = f[k]
    }
    return o
  })
  return JSON.stringify(out, null, pretty ? 2 : 0) + '\n'
}

/* ===================== ③ OMM KVN（CCSDS 502.0-B） ===================== */
// 多星 = 多段顺序拼接，每段以 CCSDS_OMM_VERS 起头。COMMENT 可多条，按出现顺序累积。
function parseKvn(text) {
  const errors = [], warnings = [], records = []
  const lines = String(text || '').split(/\r?\n/)
  const known = new Set(ALL_KEYS)
  let f = null, comments = null, started = false, userDefined = null
  const flush = (lineNo) => {
    if (!f) return
    const rec = recordFromFields(f)
    if (rec) {
      if (comments && comments.length) rec.comments = comments
      if (userDefined && Object.keys(userDefined).length) rec.userDefined = userDefined
      records.push(rec)
    } else errors.push(`第 ${lineNo} 行前的报文段：缺 NORAD_CAT_ID`)
    f = null; comments = null; userDefined = null
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const s = raw.trim()
    if (!s) continue
    // COMMENT 按 CCSDS KVN 语法是 “COMMENT <文本>”，【不带等号】，须在等号判断之前拦下
    const isComment = /^COMMENT(\s|$)/i.test(s)
    const eq = s.indexOf('=')
    if (!isComment && eq < 0) continue
    const key = isComment ? 'COMMENT' : s.slice(0, eq).trim().toUpperCase()
    let val = isComment ? s.slice(7).trim() : s.slice(eq + 1).trim()
    // 带单位的值：CCSDS 允许 “12.3 [km]”，单位不参与计算，剥掉
    if (!isComment) {
      const um = /^(.*?)\s*\[[^\]]*\]$/.exec(val)
      if (um) val = um[1].trim()
    }
    if (key === 'CCSDS_OMM_VERS') { flush(i + 1); f = {}; comments = []; userDefined = {}; started = true }
    if (!started) continue
    if (!f) { f = {}; comments = []; userDefined = {} }
    if (key === 'COMMENT') { comments.push(val); continue }
    if (key.indexOf('USER_DEFINED_') === 0) { userDefined[key.slice('USER_DEFINED_'.length)] = val; continue }
    if (!known.has(key)) continue
    if (val !== '') f[key] = val
  }
  flush(lines.length)
  if (!records.length && started) errors.push('KVN 报文里没有可用的 OMM 记录（缺 NORAD_CAT_ID）')
  return { records, errors, warnings }
}
function serializeKvn(records) {
  const out = []
  for (const r of records) {
    const f = fieldsFromRecord(r)
    const put = (k, v) => { if (v != null && v !== '') out.push(`${k} = ${v}`) }
    put('CCSDS_OMM_VERS', f.CCSDS_OMM_VERS || DEFAULTS.CCSDS_OMM_VERS)
    for (const c of (r.comments || [])) out.push(`COMMENT ${c}`)
    put('CLASSIFICATION', f.CLASSIFICATION)
    put('CREATION_DATE', f.CREATION_DATE || nowIso())
    put('ORIGINATOR', f.ORIGINATOR || DEFAULTS.ORIGINATOR)
    put('MESSAGE_ID', f.MESSAGE_ID)
    for (const k of META_KEYS) put(k, f[k] != null && f[k] !== '' ? f[k] : DEFAULTS[k])
    for (const k of MEAN_KEYS) put(k, f[k])
    for (const k of SPACECRAFT_KEYS) put(k, f[k])
    for (const k of TLE_KEYS) put(k, f[k] != null && f[k] !== '' ? f[k] : DEFAULTS[k])
    for (const k of COV_KEYS) put(k, f[k])
    for (const k of Object.keys(r.userDefined || {})) put('USER_DEFINED_' + k, r.userDefined[k])
    out.push('')
  }
  return out.join('\n')
}

/* ===================== ④ OMM XML（CCSDS 505.0-B NDM/XML） ===================== */
// 自写最小读取器：OMM/XML 是规整的纯文本叶子结构（无 CDATA、无混排、无命名空间前缀），
// 不值得为它拉一个 XML 依赖进主进程（KML 那条路吃的是渲染进程的 DOMParser，主进程没有）。
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const xmlDecode = (s) => String(s).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
  (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XML_ENT[e]))
const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
// 可选的命名空间前缀。CelesTrak / Space-Track 的 NDM/XML 不带前缀，但 CCSDS 505.0-B 允许
// <ndm:omm>…<ndm:EPOCH> 这种写法（非捕获组，后面的 \1 反向引用照旧指向关键字本身）。
const XML_NS = '(?:[A-Za-z_][\\w.-]*:)?'
// 取 tag 的所有 <tag ...>…</tag> 块（含起止标签），不递归同名嵌套（OMM 结构里不存在）
function xmlBlocks(text, tag) {
  const out = []
  const re = new RegExp(`<${XML_NS}${tag}(\\s[^>]*)?>([\\s\\S]*?)</${XML_NS}${tag}>`, 'g')
  let m
  while ((m = re.exec(text))) out.push({ attrs: m[1] || '', inner: m[2] })
  return out
}
// 取块内所有叶子 <KEY ...>value</KEY>（只收大写关键字，正好过滤掉 header/body/segment 等结构标签）
function xmlLeaves(inner) {
  const out = []
  const re = new RegExp(`<${XML_NS}([A-Z][A-Z0-9_]*)((?:\\s[^>]*)?)\\s*(/)?>(?:([\\s\\S]*?)</${XML_NS}\\1>)?`, 'g')
  let m
  while ((m = re.exec(inner))) out.push({ key: m[1], attrs: m[2] || '', text: m[3] ? '' : xmlDecode(m[4] == null ? '' : m[4]).trim() })
  return out
}
const xmlAttr = (attrs, name) => { const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs || ''); return m ? xmlDecode(m[1]) : '' }

function parseXml(text) {
  const errors = [], warnings = [], records = []
  const src = String(text || '')
  const blocks = xmlBlocks(src, 'omm')
  if (!blocks.length) return { records, errors, warnings }
  const known = new Set(ALL_KEYS)
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const f = {}, comments = [], userDefined = {}
    const ver = xmlAttr(b.attrs, 'version')
    if (ver) f.CCSDS_OMM_VERS = ver
    for (const leaf of xmlLeaves(b.inner)) {
      if (leaf.key === 'COMMENT') { if (leaf.text) comments.push(leaf.text); continue }
      if (leaf.key === 'USER_DEFINED') {
        const p = xmlAttr(leaf.attrs, 'parameter')
        if (p) userDefined[p] = leaf.text
        continue
      }
      if (!known.has(leaf.key)) continue
      if (leaf.text !== '') f[leaf.key] = leaf.text
    }
    const rec = recordFromFields(f)
    if (rec) {
      if (comments.length) rec.comments = comments
      if (Object.keys(userDefined).length) rec.userDefined = userDefined
      records.push(rec)
    } else errors.push(`第 ${i + 1} 个 <omm> 段：缺 NORAD_CAT_ID`)
  }
  if (!records.length) errors.push('XML 里没有可用的 OMM 记录（缺 NORAD_CAT_ID）')
  return { records, errors, warnings }
}
function serializeXml(records) {
  const L = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<ndm xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://sanaregistry.org/r/ndmxml/ndmxml-1.0-master.xsd">']
  for (const r of records) {
    const f = fieldsFromRecord(r)
    const vers = f.CCSDS_OMM_VERS || DEFAULTS.CCSDS_OMM_VERS
    const el = (k, v, ind) => { if (v != null && v !== '') L.push(`${ind}<${k}>${xmlEsc(v)}</${k}>`) }
    L.push(`  <omm id="CCSDS_OMM_VERS" version="${xmlEsc(vers)}">`)
    L.push('    <header>')
    for (const c of (r.comments || [])) el('COMMENT', c, '      ')
    el('CLASSIFICATION', f.CLASSIFICATION, '      ')
    el('CREATION_DATE', f.CREATION_DATE || nowIso(), '      ')
    el('ORIGINATOR', f.ORIGINATOR || DEFAULTS.ORIGINATOR, '      ')
    el('MESSAGE_ID', f.MESSAGE_ID, '      ')
    L.push('    </header>')
    L.push('    <body>')
    L.push('      <segment>')
    L.push('        <metadata>')
    for (const k of META_KEYS) el(k, f[k] != null && f[k] !== '' ? f[k] : DEFAULTS[k], '          ')
    L.push('        </metadata>')
    L.push('        <data>')
    L.push('          <meanElements>')
    for (const k of MEAN_KEYS) el(k, f[k], '            ')
    L.push('          </meanElements>')
    if (SPACECRAFT_KEYS.some((k) => f[k] != null && f[k] !== '')) {
      L.push('          <spacecraftParameters>')
      for (const k of SPACECRAFT_KEYS) el(k, f[k], '            ')
      L.push('          </spacecraftParameters>')
    }
    L.push('          <tleParameters>')
    for (const k of TLE_KEYS) el(k, f[k] != null && f[k] !== '' ? f[k] : DEFAULTS[k], '            ')
    L.push('          </tleParameters>')
    if (COV_KEYS.some((k) => f[k] != null && f[k] !== '')) {
      L.push('          <covarianceMatrix>')
      for (const k of COV_KEYS) el(k, f[k], '            ')
      L.push('          </covarianceMatrix>')
    }
    for (const k of Object.keys(r.userDefined || {})) {
      L.push('          <userDefinedParameters>')
      L.push(`            <USER_DEFINED parameter="${xmlEsc(k)}">${xmlEsc(r.userDefined[k])}</USER_DEFINED>`)
      L.push('          </userDefinedParameters>')
    }
    L.push('        </data>')
    L.push('      </segment>')
    L.push('    </body>')
    L.push('  </omm>')
  }
  L.push('</ndm>')
  return L.join('\n') + '\n'
}

/* ===================== ⑤⑥ TLE / 3LE ===================== */
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
// 数字编号 → TLE 第 3-7 列串（≥100000 时按 Alpha-5 压回 5 位）。
// Alpha-5 的天花板是 Z9999 = 339999；再往上五位栏位【表示不了】，返回空串让上层拒写。
// 曾经这里退回 String(n).slice(-5)，那是静默写出另一颗星的身份：本平台自建星座的号段基址
// 是 900000（useCustomConstellations.js），900000 会被写成 "00000"（回读判成 0，整颗丢掉），
// 900001 写成 "00001"（撞上真实目录里的 1 号）。与 packExp 的处置同一条道理——宁可不写。
function encodeSatnum(id) {
  const n = parseInt(String(id).replace(/\D/g, ''), 10) || 0
  if (n < 100000) return String(n).padStart(5, '0')
  const hi = Math.floor(n / 10000), lo = n % 10000
  const c = ALPHA5[hi - 10]
  return c ? c + String(lo).padStart(4, '0') : ''
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
// YY(两位年) + 年内天(含小数) → ISO UTC 串。年份轴心 <57→20xx，与 twoline2satrec 一致。
function tleEpochToIso(epochyr, epochdays) {
  const year = epochyr < 57 ? epochyr + 2000 : epochyr + 1900
  const ms = Date.UTC(year, 0, 1) + (epochdays - 1) * 86400000
  const d = new Date(Math.round(ms))
  if (isNaN(d.getTime())) return ''
  // 微秒位由年内天的小数直接算，避免经毫秒取整丢精度（官方 OMM 给 6 位）
  const dayFrac = epochdays - Math.floor(epochdays)
  const secOfDay = dayFrac * 86400
  const us = Math.round((secOfDay - Math.floor(secOfDay)) * 1e6)
  const base = new Date(Date.UTC(year, 0, 1) + (Math.floor(epochdays) - 1) * 86400000 + Math.floor(secOfDay) * 1000)
  const p = (x, w) => String(x).padStart(w, '0')
  const carry = us >= 1e6 ? 1 : 0
  const b2 = carry ? new Date(base.getTime() + 1000) : base
  return `${b2.getUTCFullYear()}-${p(b2.getUTCMonth() + 1, 2)}-${p(b2.getUTCDate(), 2)}T` +
    `${p(b2.getUTCHours(), 2)}:${p(b2.getUTCMinutes(), 2)}:${p(b2.getUTCSeconds(), 2)}.${p(carry ? 0 : us, 6)}`
}
// ISO → { yy, ddd.dddddddd }，TLE 第 1 行历元栏用
function isoToTleEpoch(iso) {
  const d = new Date(/[zZ]$/.test(iso) ? iso : iso + 'Z')
  if (isNaN(d.getTime())) return null
  const year = d.getUTCFullYear()
  const frac = /\.(\d+)/.exec(String(iso))
  const subSec = frac ? Number('0.' + frac[1]) : d.getUTCMilliseconds() / 1000
  const dayMs = Date.UTC(year, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(year, 0, 1)
  const days = dayMs / 86400000 + 1 +
    (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() + subSec) / 86400
  return { yy: year % 100, days }
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
// "1998-067A" → TLE L1 第 10-17 列 "98067A  "
function objectIdToTle(objectId) {
  const m = /^(\d{4})-(\S+)$/.exec(String(objectId || '').trim())
  if (!m) return ' '.repeat(8)
  return (m[1].slice(2) + m[2]).padEnd(8, ' ').slice(0, 8)
}
const num = (sub) => { const v = parseFloat(sub); return Number.isFinite(v) ? v : NaN }

// 单条 TLE(两行 + 可选名称) → OMM 记录。列区间与 satellite.js twoline2satrec 逐一对齐。
// 【为何 TLE 存成 OMM 记录不掉精度】satellite.js 的 twoline2satrec 与 omm2satrec 使用同一套常量/单位
// 缩放：no=meanMotion/xpdotp、ecco=小数、inclo/nodeo/argpo/mo=deg·deg2rad、bstar=浮点、
// ndot=mdot/(xpdotp*1440)、nddot=mddot/(xpdotp*1440*1440)。故严格拆列后走 omm2satrec 与直接
// twoline2satrec 得到的 satrec，九项根数(no/ecco/inclo/nodeo/argpo/mo/bstar/ndot/nddot) bit 级一致。
// 【唯一的例外是历元，且不是本模块引入的】TLE 的历元是「年内天小数」(1e-8 天≈0.86ms 分辨率)，OMM 的
// 历元是 ISO 串；omm2satrec 解 ISO 走 JS Date，而 Date 只到毫秒，微秒位一律丢弃(见 vendor/satellite.js
// omm2satrec 的 getUTCMilliseconds)。故 jdsatepoch 会有 ≤0.5ms 的舍入(LEO 上 ~4mm 位置差)。这是既有
// OMM 通路对【所有】官方 OMM 文件的共同上限——官方 CSV 的 6 位微秒同样落到毫秒，与 TLE 来源无关。
// 本模块只保证转出的 ISO 串本身精确到微秒(官方体例)，下游用不用得到那一档由引擎决定。
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
    const classification = l1.substring(7, 8).trim() || 'U'
    const elsetNo = l1.substring(64, 68).trim()
    const ephType = l1.substring(62, 63).trim()

    const incl = num(l2.substring(8, 16))
    const raan = num(l2.substring(17, 25))
    const ecc = parseFloat(`.${l2.substring(26, 33).replace(/\s/g, '0')}`)  // 隐含前导小数点
    const argp = num(l2.substring(34, 42))
    const ma = num(l2.substring(43, 51))
    const meanMotion = num(l2.substring(52, 63))
    const revAtEpoch = l2.substring(63, 68).trim()

    if (!(meanMotion > 0)) { errors.push(`NORAD ${noradId}：平均运动无效`); return null }
    if (!(ecc >= 0 && ecc < 1)) { errors.push(`NORAD ${noradId}：偏心率超范围 (${ecc})`); return null }
    if (!(incl >= 0 && incl <= 180)) { errors.push(`NORAD ${noradId}：倾角超范围 (${incl})`); return null }
    if (!Number.isFinite(raan) || !Number.isFinite(argp) || !Number.isFinite(ma)) { errors.push(`NORAD ${noradId}：角度根数解析失败`); return null }

    const f = Object.assign({}, DEFAULTS, {
      OBJECT_NAME: (name && name.trim()) || `NORAD ${noradId}`,
      OBJECT_ID: tleObjectId(l1),
      EPOCH: epoch,
      // TLE 栏位本就是定长定小数位，直接搬原印串（去空白）即官方体例，不做数值往返
      MEAN_MOTION: l2.substring(52, 63).trim(),
      ECCENTRICITY: '.' + l2.substring(26, 33).replace(/\s/g, '0'),
      INCLINATION: l2.substring(8, 16).trim(),
      RA_OF_ASC_NODE: l2.substring(17, 25).trim(),
      ARG_OF_PERICENTER: l2.substring(34, 42).trim(),
      MEAN_ANOMALY: l2.substring(43, 51).trim(),
      EPHEMERIS_TYPE: ephType || '0',
      CLASSIFICATION_TYPE: classification,
      NORAD_CAT_ID: noradId,
      ELEMENT_SET_NO: elsetNo ? String(parseInt(elsetNo, 10)) : '',
      REV_AT_EPOCH: revAtEpoch ? String(parseInt(revAtEpoch, 10)) : '',
      BSTAR: sciOfficial(Number.isFinite(bstar) ? bstar : 0),
      MEAN_MOTION_DOT: officialValue('MEAN_MOTION_DOT', Number.isFinite(mdot) ? mdot : 0),
      MEAN_MOTION_DDOT: sciOfficial(Number.isFinite(nddot) ? nddot : 0)
    })
    const rec = recordFromFields(f)
    if (!rec) { errors.push(`第 ${lineNo} 行：记录构造失败`); return null }
    // 契约字段用【解析出的数值】而非官方串，与既有 TLE 通路逐位相同（omm2satrec 结果 bit 级不变）
    rec.meanMotion = String(meanMotion); rec.ecc = String(ecc); rec.incl = String(incl)
    rec.raan = String(raan); rec.argp = String(argp); rec.ma = String(ma)
    rec.bstar = String(Number.isFinite(bstar) ? bstar : 0)
    rec.mdot = String(Number.isFinite(mdot) ? mdot : 0)
    rec.mddot = String(Number.isFinite(nddot) ? nddot : 0)
    rec.tleLines = [l1, l2]     // 留原文两行：导出 tle/3le 时原样吐回 = 字节级一致
    return rec
  } catch (e) { errors.push(`第 ${lineNo} 行：TLE 解析异常 ${e.message || e}`); return null }
}
// 整段 TLE 文本（一文件多星、2 行 / 3 行含名称、名称行可带前导 "0 "）→ { records, errors, warnings }
function parseTleText(text) {
  const records = [], errors = [], warnings = []
  const raw = String(text || '').split(/\r?\n/)
  const lines = []
  for (let i = 0; i < raw.length; i++) { const t = raw[i].replace(/\s+$/, ''); if (t.trim()) lines.push({ t, n: i + 1 }) }
  let i = 0, pendingName = null, sawName = false
  const isL1 = (s) => s[0] === '1' && (s[1] === ' ' || s.length >= 64)
  const isL2 = (s) => s[0] === '2' && (s[1] === ' ' || s.length >= 64)
  while (i < lines.length) {
    const cur = lines[i], s = cur.t
    if (isL1(s)) {
      const l2e = lines[i + 1]
      if (!l2e || !isL2(l2e.t)) { errors.push(`第 ${cur.n} 行：TLE 第 1 行后缺少配对的第 2 行`); i++; pendingName = null; continue }
      const rec = buildFromTle(pendingName, s, l2e.t, cur.n, errors, warnings)
      if (rec) { if (pendingName != null) rec.tleName = pendingName; records.push(rec) }
      i += 2; pendingName = null; continue
    }
    if (isL2(s)) { errors.push(`第 ${cur.n} 行：孤立的 TLE 第 2 行（无配对第 1 行）`); i++; pendingName = null; continue }
    pendingName = s.replace(/^0 /, '').trim()   // 名称行（3 行格式）
    sawName = true
    i++
  }
  return { records, errors, warnings, threeLine: sawName }
}

// OMM 记录 → TLE 两行。定长栏位重建，校验位现算。
// 【有损】OMM 的自由精度要压回定长栏位（角度 4 位、平均运动 8 位、BSTAR/n̈ 尾数 5 位），不可逆。
function recordToTleLines(r) {
  const f = fieldsFromRecord(r)
  const ep = isoToTleEpoch(f.EPOCH)
  if (!ep) return null
  if (!encodeSatnum(f.NORAD_CAT_ID)) return null   // 编号超出 Alpha-5 上限（339999），五位栏位装不下
  const nz = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
  // TLE ndot 栏：宽 10（含符号），体例 "-.00000123" / " .00000123"
  const ndotStr = (v) => {
    const n = nz(v)
    const s = Math.abs(n).toFixed(8).replace(/^0/, '')
    return (n < 0 ? '-' : ' ') + s.slice(0, 9)
  }
  // TLE 打包指数栏：宽 8，体例 " 39713-3" / "-20801-5" / " 00000+0"
  const packExp = (v) => {
    const n = nz(v)
    if (n === 0) return ' 00000+0'
    const sign = n < 0 ? '-' : ' '
    const a = Math.abs(n)
    let exp = Math.floor(Math.log10(a)) + 1
    let mant = a / Math.pow(10, exp)
    if (mant >= 1) { mant /= 10; exp += 1 } else if (mant < 0.1) { mant *= 10; exp -= 1 }
    let m5 = Math.round(mant * 1e5)
    if (m5 >= 1e5) { m5 = Math.round(m5 / 10); exp += 1 }
    // 指数栏只有 1 位十进制，|exp|>9 这个格式表示不了。此时【按 0 写】，绝不把指数夹到 9 ——
    // 夹一下就是静默写出差几个量级的假值（.1E-11 会变成 1E-10，差 100 倍）。写 0 是该格式能表示
    // 的最接近值，且这个量级的阻力项对 SGP4 无实质影响。官方数据实测指数绝对值最大 8，不会走到这。
    if (Math.abs(exp) > 9) return ' 00000+0'
    const es = exp < 0 ? '-' : '+'
    return sign + String(m5).padStart(5, '0') + es + String(Math.abs(exp))
  }
  const p = (x, w) => String(x).padStart(w, '0')
  const elsetNo = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.abs(n) % 10000 : 999 }
  const satnum = encodeSatnum(f.NORAD_CAT_ID)
  const cls = (f.CLASSIFICATION_TYPE || 'U').slice(0, 1)
  const epDays = ep.days.toFixed(8).padStart(12, '0')
  let l1 = '1 ' + satnum + cls + ' ' + objectIdToTle(f.OBJECT_ID) + ' ' +
    p(ep.yy, 2) + epDays + ' ' + ndotStr(f.MEAN_MOTION_DOT) + ' ' +
    packExp(f.MEAN_MOTION_DDOT != null && f.MEAN_MOTION_DDOT !== '' ? f.MEAN_MOTION_DDOT : f.AGOM) + ' ' +
    packExp(f.BSTAR != null && f.BSTAR !== '' ? f.BSTAR : f.BTERM) + ' ' +
    (String(f.EPHEMERIS_TYPE || '0').trim() || '0') + ' ' +
    // elset 栏 4 位：超了取低 4 位（同 REV_AT_EPOCH 的循环计数口径），别用 slice 取前 4 位那会写出
    // 完全不同的号；0 是合法值，不能被 `|| 999` 顶掉
    String(elsetNo(f.ELEMENT_SET_NO)).padStart(4, ' ')
  const eccDigits = Math.abs(nz(f.ECCENTRICITY)).toFixed(7).slice(2, 9)
  let l2 = '2 ' + satnum + ' ' +
    nz(f.INCLINATION).toFixed(4).padStart(8, ' ') + ' ' +
    nz(f.RA_OF_ASC_NODE).toFixed(4).padStart(8, ' ') + ' ' +
    eccDigits + ' ' +
    nz(f.ARG_OF_PERICENTER).toFixed(4).padStart(8, ' ') + ' ' +
    nz(f.MEAN_ANOMALY).toFixed(4).padStart(8, ' ') + ' ' +
    nz(f.MEAN_MOTION).toFixed(8).padStart(11, ' ') +
    String(Math.abs(parseInt(f.REV_AT_EPOCH, 10) || 0) % 100000).padStart(5, ' ')
  l1 = l1.slice(0, 68).padEnd(68, ' '); l2 = l2.slice(0, 68).padEnd(68, ' ')
  return [l1 + tleChecksum(l1), l2 + tleChecksum(l2)]
}
// TLE 名称行：官方 3LE 为 "0 " + 名称（24 字符内）
// 【写不出来就报错，不吐半份文件】TLE 定长卡片装不下的只有两种记录：NORAD 编号超出 Alpha-5
// 上限（>339999，本平台自建星座的 900000 号段全在此列）、历元串解不出来。这两种以前是 continue
// 静默跳过 —— 用户拿到一份少了星、甚至只有一个换行的「导出成功」文件。同一个保存对话框里就有
// 四种无损的 OMM 格式，报错让用户改格式，比给一份缺斤少两的文件强。
function serializeTle(records, threeLine) {
  const out = []
  const dropped = []
  for (const r of records) {
    const lines = (r.tleLines && r.tleLines.length === 2) ? r.tleLines : recordToTleLines(r)
    if (!lines) { dropped.push(r.name || ('NORAD ' + r.noradId)); continue }
    if (threeLine) {
      const nm = (r.tleName != null ? r.tleName : (r.name || ''))
      out.push('0 ' + String(nm).slice(0, 24))
    }
    out.push(lines[0], lines[1])
  }
  if (dropped.length) {
    throw new Error(`${dropped.length} 颗卫星写不进 TLE 定长卡片（NORAD 编号超出五位栏位上限 339999，` +
      `或历元无效）：${dropped.slice(0, 3).join('、')}${dropped.length > 3 ? ' 等' : ''}；` +
      '请改用 OMM 的 CSV / JSON / KVN / XML 导出')
  }
  return out.join('\n') + '\n'
}

/* ===================== 嗅探 / 统一入口 ===================== */
function nowIso() {
  const d = new Date()
  const p = (x, w) => String(x).padStart(w, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1, 2)}-${p(d.getUTCDate(), 2)}T${p(d.getUTCHours(), 2)}:${p(d.getUTCMinutes(), 2)}:${p(d.getUTCSeconds(), 2)}`
}
// 文件开头的 UTF-8 BOM：csv/kvn/xml 靠 trim() 能顺带吃掉（U+FEFF 属 WhiteSpace），但 JSON.parse
// 会当场抛，TLE 的首列判断也会被顶偏一格（首字符成了 U+FEFF 而不是 "1"，第 1 行被当成名称行，
// 紧接着的第 2 行报「孤立」）。统一在入口剥一次，六种格式一并免疫。Windows PowerShell 的
// Set-Content -Encoding utf8 与记事本的「UTF-8 with BOM」写出来就带它，是很常见的一手。
const stripBom = (s) => String(s == null ? '' : s).replace(/^\uFEFF/, '')

// 按内容判格式（扩展名只作参考，不作判据 —— 官方文件常被随手改名）
function detectFormat(text) {
  const s = stripBom(text)
  const head = s.slice(0, 4096)
  if (/^\s*[[{]/.test(head)) return 'omm-json'
  if (new RegExp(`<\\s*${XML_NS}(omm|ndm)[\\s>]`, 'i').test(head)) return 'omm-xml'
  if (/^\s*CCSDS_OMM_VERS\s*=/im.test(head)) return 'omm-kvn'
  if (/(^|\r?\n)\s*[^\r\n]*\bMEAN_MOTION\b[^\r\n]*(\r?\n|$)/.test(head) && /,/.test(head)) return 'omm-csv'
  const t = parseTleText(s.slice(0, 8192))
  if (t.records.length) return t.threeLine ? '3le' : 'tle'
  return ''
}
// 统一解析：不给 format 就按内容嗅探。返回 { format, records, errors, warnings }
function parseEphemeris(text, format) {
  const src = stripBom(text)
  const fmt = format || detectFormat(src)
  let r
  switch (fmt) {
    case 'omm-csv': r = parseCsv(src); break
    case 'omm-json': r = parseJsonText(src); break
    case 'omm-kvn': r = parseKvn(src); break
    case 'omm-xml': r = parseXml(src); break
    case 'tle': case '3le': { const t = parseTleText(src); r = { records: t.records, errors: t.errors, warnings: t.warnings }; break }
    default: return { format: '', records: [], errors: ['无法识别的星历格式（支持 OMM 的 CSV/JSON/KVN/XML 与 TLE/3LE）'], warnings: [] }
  }
  return { format: fmt, records: r.records, errors: r.errors || [], warnings: r.warnings || [] }
}
// 统一序列化：records → 指定格式文本
function serializeEphemeris(records, format, opts) {
  const arr = Array.isArray(records) ? records : []
  switch (format) {
    case 'omm-csv': return serializeCsv(arr)
    case 'omm-json': return serializeJson(arr, opts)
    case 'omm-kvn': return serializeKvn(arr)
    case 'omm-xml': return serializeXml(arr)
    case 'tle': return serializeTle(arr, false)
    case '3le': return serializeTle(arr, true)
    default: throw new Error('未知导出格式：' + format)
  }
}

module.exports = {
  FORMATS, FORMAT_LABEL, FORMAT_EXT, CSV_COLS, ALL_KEYS, DEFAULTS,
  detectFormat, parseEphemeris, serializeEphemeris,
  recordFromFields, fieldsFromRecord, officialValue, officialEpoch, sciOfficial,
  parseTleText, recordToTleLines, tleChecksum, decodeSatnum, encodeSatnum,
  splitCsvLine
}
