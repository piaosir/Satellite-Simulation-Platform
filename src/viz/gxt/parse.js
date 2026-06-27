// GXT 解析器 —— SATSOFT/GRASP 等值线交换格式（INI 风格文本）。
// 结构（见样例）：
//   [FormatInfo] format_ver=1
//   [GeoMain]    long_nom=110.500   sat_name=...   adm=G   n_diag=1
//   [COHeader]   beam_id=1  emi_rcp=E  n_bore=1  n_cont=39   （n_diag>1 时多组 COHeader/B/C）
//   [B1..Bn]     gain=..  p=lon;lat（或 p1=lon;lat）           波束中心（boresight）
//   [C1..Cn]     gain=..  n_point=..  p1..pN=lon;lat           一条等值线
// 输出与 resources/coverage/*.json（渲染管线 coverage.get 所需）同构：
//   { lon, satName, bore:[[lon,lat]...], contours:[{ g, p:[[lon,lat]...] }] }
// 单文件通常 = 单波束（n_diag=1）；多 diagram 时把所有 [Bx]/[Cx] 按文件顺序合并。

// 取一个分号坐标 "114.919;16.199" → [lon, lat]（容错逗号分隔与多余空格）
function parsePoint(v) {
  if (v == null) return null
  const parts = String(v).trim().split(/[;,]/)
  if (parts.length < 2) return null
  const lon = Number(parts[0]), lat = Number(parts[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  return [lon, lat]
}

// 解析 GXT 文本 → { lon, satName, bore, contours }。无法解析时抛出错误（供调用方提示）。
export function parseGxt(text) {
  if (!text || typeof text !== 'string') throw new Error('空文件')
  const lines = text.split(/\r?\n/)
  let section = null            // 当前 [节名]（大写归一）
  const kv = {}                 // 当前 section 的键值
  let lon = null, satName = ''
  const bore = []               // [[lon,lat]...]
  const contours = []           // [{ g, p:[[lon,lat]...] }]
  let curContour = null         // 正在收集的等值线 { g, p }

  const flushContour = () => { if (curContour && curContour.p.length) contours.push(curContour); curContour = null }

  for (let raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^\[(.+?)\]\s*$/)
    if (m) {
      // 进入新 section：先结掉上一条等值线
      flushContour()
      section = m[1].trim().toUpperCase()
      // GeoMain 段读完后取值
      if (/^C\d+$/.test(section)) curContour = { g: NaN, p: [] }
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    const val = line.slice(eq + 1).trim()

    if (section === 'GEOMAIN') {
      if (key === 'long_nom') { const n = Number(val); if (Number.isFinite(n)) lon = n }
      else if (key === 'sat_name') satName = val
    } else if (/^B\d+$/.test(section)) {
      // 波束中心：p 或 p1
      if (key === 'p' || key === 'p1') { const pt = parsePoint(val); if (pt) bore.push(pt) }
    } else if (/^C\d+$/.test(section) && curContour) {
      if (key === 'gain') { const g = Number(val); if (Number.isFinite(g)) curContour.g = g }
      else if (/^p\d+$/.test(key)) { const pt = parsePoint(val); if (pt) curContour.p.push(pt) }
    }
  }
  flushContour()

  if (!contours.length && !bore.length) throw new Error('未识别到等值线/波束中心（非 GXT 文件？）')
  // 把 NaN 增益的等值线剔除（无意义档）
  const cleaned = contours.filter((c) => Number.isFinite(c.g) && c.p.length >= 2)
  return { lon, satName, bore, contours: cleaned }
}

// 从文件名推断 sat/band/beam/type（与 scripts/build-coverage.js 同口径）：
//   "CHINASAT 10R_Ku_东部波束_EIRP" → { sat, band, beam, type }
export function metaFromName(base) {
  const name = String(base || '').replace(/\.gxt$/i, '')
  const parts = name.split('_')
  if (parts.length >= 4) {
    const type = parts.pop()
    const sat = parts.shift()
    const band = parts.shift()
    const beam = parts.join('_')
    return { sat, band, beam, type, name }
  }
  return { sat: '', band: '', beam: name, type: '', name }
}
