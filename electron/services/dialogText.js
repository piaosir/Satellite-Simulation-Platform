// 系统对话框（showOpenDialog / showSaveDialog）的按语言出字。
//
// 系统框画在主进程，渲染端的呈现层翻译（src/shared/i18n/runtime.js）够不着，所以标题与文件类型名
// 得在这里按界面语言现出。口径：
//   · 源码里照旧写中文原文；出框前过 dt(中文, lang) —— lang 为 'en' 且本表有这一条就换英文，否则原样。
//     渲染端传来的标题 / 类型名（file:save 的 filters、file:saveMany 的 dirLabel …）也走同一张表，查不到原样。
//   · 带插值的标题不进表，调用点直接 lang === 'en' ? … : …（同 videoFile.js）。
//   · 语言取自【发起窗口】的 localStorage（ui-lang，与 src/shared/i18n/lang.js 同键）：IPC 载荷带了 lang
//     就以载荷为准；读不到按中文。中文模式下所有标题 / 类型名与改造前逐字一致。

const EN = {
  // —— 文件类型名 ——
  '所有文件': 'All Files',
  'Excel 工作簿': 'Excel Workbook',
  'Word 文档': 'Word Document',
  'PDF 文档': 'PDF Document',
  'JSON 数据': 'JSON Data',
  'SVG 矢量图': 'SVG Vector Image',
  'PNG 图片': 'PNG Image',
  'CSV 文本': 'CSV Text',
  'CSV 表格': 'CSV Table',
  'iCalendar 日历': 'iCalendar',
  'OMM KVN（CCSDS）': 'OMM KVN (CCSDS)',
  'OMM XML（CCSDS）': 'OMM XML (CCSDS)',
  'TLE（两行）': 'TLE (two-line)',
  '3LE（三行）': '3LE (three-line)',
  'STK 星历（.e）': 'STK Ephemeris (.e)',
  'CCSDS OEM（KVN）': 'CCSDS OEM (KVN)',
  'CCSDS OEM（XML）': 'CCSDS OEM (XML)',
  '中国卫通星历（.eph）': 'China Satcom Ephemeris (.eph)',
  'SP3 精密星历': 'SP3 Precise Ephemeris',
  '星历文件 (OMM · TLE · STK .e · CCSDS OEM · SP3 · 中国卫通 .eph · GPS 年历)': 'Ephemeris Files (OMM · TLE · STK .e · CCSDS OEM · SP3 · China Satcom .eph · GPS Almanac)',
  '卫星编目 CSV（CelesTrak satcat.csv）': 'Satellite Catalog CSV (CelesTrak satcat.csv)',
  '覆盖等值线 (*.gxt, *.kml, *.json)': 'Coverage Contours (*.gxt, *.kml, *.json)',
  '波束地图 (*.gxt, *.kml, *.kmz, *.json, *.geojson, *.csv, *.zip, *.shp, *.mif)': 'Beam Maps (*.gxt, *.kml, *.kmz, *.json, *.geojson, *.csv, *.zip, *.shp, *.mif)',
  'KML / KMZ (*.kml, *.kmz)': 'KML / KMZ (*.kml, *.kmz)',
  'JSON / GeoJSON (*.json, *.geojson)': 'JSON / GeoJSON (*.json, *.geojson)',
  'GXT 结构 JSON (*.json)': 'GXT-structured JSON (*.json)',
  'GXT 等值线 (*.gxt)': 'GXT Contours (*.gxt)',
  'GXT 等值线': 'GXT Contours',
  'Polygon (*.gxt, *.kml)': 'Polygons (*.gxt, *.kml)',
  'GRASP 网格': 'GRASP Grid',
  'GRASP 网格 (*.grd, *.pat)': 'GRASP Grid (*.grd, *.pat)',
  '方向图 (*.grd, *.pat, *.txt, *.ant, *.pattern)': 'Antenna Patterns (*.grd, *.pat, *.txt, *.ant, *.pattern)',
  '链路预算配置': 'Link Budget Configuration',
  '链路预算分享包': 'Link Budget Share Package',
  '参数存档 JSON': 'Parameter Archive JSON',
  'glTF 二进制 (*.glb)': 'glTF Binary (*.glb)',
  '3D 模型': '3D Models',
  // —— 标题 ——
  '导入星历（可多选，每文件一组）': 'Import Ephemeris (multiple files, one group per file)',
  '选择导出文件夹（每颗卫星一个文件）': 'Choose Export Folder (one file per satellite)',
  '导入覆盖等值线（GXT / KML / JSON，可多选）': 'Import Coverage Contours (GXT / KML / JSON, multiple)',
  '导入波束地图（可多选）': 'Import Beam Maps (multiple)',
  '导入方向图文件（GRASP GRD / ACP4 / Eutelsat，可多选）': 'Import Antenna Pattern Files (GRASP GRD / ACP4 / Eutelsat, multiple)',
  '导入 GRD / PAT 方向图（可多选）': 'Import GRD / PAT Patterns (multiple)',
  '导出频率计划': 'Export Frequency Plan',
  '导入频率计划（JSON）': 'Import Frequency Plan (JSON)',
  '导出 Excel': 'Export Excel',
  '导入 Excel': 'Import Excel',
  '选择输出目录': 'Choose Output Folder',
  '选择 mask 出包目录': 'Choose Mask Output Folder',
  '导入 Polygon（GXT / KML，可多选）': 'Import Coordination Polygons (GXT / KML, multiple)',
  '保存空间态势报告': 'Save Space Situational Awareness Report',
  '保存 SLA 报告': 'Save SLA Report',
  '保存容量报告': 'Save Capacity Report',
  '保存报告': 'Save Report',
  '导出模型': 'Export Model',
  '导出': 'Export',
  '导入 3D 模型': 'Import 3D Model',
  '选择 STK 模型目录': 'Choose STK Model Folder',
  // —— 默认文件名（保存框里预填的那一段；用户自己起的名字不在表里，原样）——
  '频率计划': 'Frequency Plan',
  '表格': 'Table',
  '雨衰计算结果': 'Rain Attenuation Results',
  '过境窗口': 'Pass Windows',
  '日凌预报': 'Sun Outage Forecast',
  '日凌预报报告': 'Sun Outage Report',
  '链路预算报告': 'Link Budget Report',
  '空间态势报告': 'Space Situational Awareness Report',
  '服务等级指标': 'Service Level Agreement',
  '容量汇总': 'Capacity Summary',
  '导入星历': 'Imported Ephemeris',
  '导入组': 'Imported Group',
  '自定义星历': 'Custom Ephemeris',
  '星历': 'Ephemeris',
  '卫星': 'Satellite'
}

const norm = (l) => (l === 'en' ? 'en' : 'zh')

// 中文原文 → 当前语言（查不到原样）
function dt(zh, lang) {
  if (norm(lang) !== 'en' || typeof zh !== 'string') return zh
  const k = zh.replace(/\s+/g, ' ').trim()
  return Object.prototype.hasOwnProperty.call(EN, k) ? EN[k] : zh
}
// 文件类型下拉逐项过 dt（不改调用方的数组）
function dtFilters(filters, lang) {
  if (!Array.isArray(filters)) return filters
  if (norm(lang) !== 'en') return filters
  return filters.map((f) => (f && typeof f.name === 'string' ? Object.assign({}, f, { name: dt(f.name, lang) }) : f))
}
// 默认文件名：'雨衰计算结果.xlsx' → 'Rain Attenuation Results.xlsx'（只换表里有的主干，扩展名照旧）
function dtFile(name, lang) {
  if (norm(lang) !== 'en' || typeof name !== 'string') return name
  const m = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(name)
  const stem = m ? m[1] : name
  const ext = m && m[2] ? m[2] : ''
  const en = dt(stem, lang)
  return en === stem ? name : en + ext
}

// 窗口的界面语言：hint（载荷里的 lang）优先；否则现读该窗口 localStorage 的 ui-lang（250 ms 超时）；都不行按中文
async function winLang(win, hint) {
  if (hint === 'en' || hint === 'zh') return hint
  try {
    const wc = win && !win.isDestroyed() ? win.webContents : null
    if (!wc || wc.isDestroyed() || (typeof wc.isCrashed === 'function' && wc.isCrashed())) return 'zh'
    const v = await Promise.race([
      wc.executeJavaScript("(function(){try{return localStorage.getItem('ui-lang')||''}catch(e){return ''}})()"),
      new Promise((r) => setTimeout(() => r(''), 250))
    ])
    return v === 'en' ? 'en' : 'zh'
  } catch { return 'zh' }
}
// 同上，但以 IPC 事件的 sender 为准
async function senderLang(e, hint) {
  if (hint === 'en' || hint === 'zh') return hint
  const sender = e && e.sender
  if (!sender) return 'zh'
  try {
    if (sender.isDestroyed()) return 'zh'
    const v = await Promise.race([
      sender.executeJavaScript("(function(){try{return localStorage.getItem('ui-lang')||''}catch(e){return ''}})()"),
      new Promise((r) => setTimeout(() => r(''), 250))
    ])
    return v === 'en' ? 'en' : 'zh'
  } catch { return 'zh' }
}

module.exports = { dt, dtFilters, dtFile, winLang, senderLang, DIALOG_EN: EN }
