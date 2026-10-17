// 可编程波束地图 · 导入脚本的内置模板：importTemplates/*.bmjs 原文 → { id, name, ext, code, match }。
//
// 文本约定与导出模板（templates.js）相同：//! 头部元数据、//zh //en 整行、⟪中|En⟫ 片段。
// 差别一处：「//! match:」「//! sniff:」两行是匹配声明，【留在代码里】—— 复制成用户脚本后照样生效
// （文件管理批量导入时，内置解析器认不出的文件交给声明了匹配规则的脚本，见 importRuntime.scriptAccepts）。
import { localize } from './templates.js'
import { scriptMatchInfo } from './importRuntime.js'

export function parseImportTemplate(src, lang = 'zh') {
  const meta = {}
  const body = []
  let head = true
  for (const ln of String(src).replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\/\/!\s*(\w+)\s*:\s*(.*)$/.exec(ln)
    if (m && head) {
      meta[m[1]] = m[2].trim()
      if (m[1] === 'match' || m[1] === 'sniff') body.push(ln)
      continue
    }
    head = false
    body.push(ln)
  }
  while (body.length && !body[body.length - 1].trim()) body.pop()
  const code = localize(body.join('\n'), lang) + '\n'
  return { id: meta.id || '', name: localize(meta.name || meta.id || '', lang), ext: (meta.ext || '').toLowerCase(), code, match: scriptMatchInfo(code) }
}

/** rawMap: { 文件路径: 原文 }（按路径名排序 = 模板顺序） */
export function parseImportTemplates(rawMap, lang = 'zh') {
  return Object.keys(rawMap || {}).sort().map((k) => ({ ...parseImportTemplate(rawMap[k], lang), builtin: true }))
}

// 内置解析器已经认得、文件管理批量导入时不必再交给脚本的模板（这几种格式走原生解析，GXT 还留原文供原样再导出）
export const NATIVE_TEMPLATE_IDS = new Set(['gxt', 'kml', 'gxt-json'])

// 新建脚本的起手式【不写生效的 //! match:】：一写就参与文件管理「导入…」的自动认格式，空脚本会去认领它根本解析不了的文件
//（原先写的 *.json 把 CONSTELLATION_OPT / GeoJSON 都认领走）。匹配声明留成注释行，写好解析逻辑后去掉行首「// 」即生效。
export function blankImportScript(lang = 'zh') {
  return localize([
    '//zh files：选中的输入文件（f.name / f.ext / f.text / f.bytes）；返回波束数组即导入。',
    '//en files: the selected input files (f.name / f.ext / f.text / f.bytes); return an array of beams to import them.',
    '//zh 去掉下一行行首的「// 」、改成本格式的扩展名（可再加一行 //! sniff: 文件开头的特征正则），文件管理「导入…」就会把这类文件交给本脚本。',
    '//en Uncomment the next line with this format\'s extension (optionally add a //! sniff: line with a regex for the file header) and File Manager "Import…" will hand such files to this script.',
    '// //! match: *.json',
    '',
    'const beams = []',
    'for (const f of files) {',
    '  const doc = json(f)',
    '  // beams.push({ satellite, orbitLon, name, band, type, peaks: [{ lon, lat }], contours: [{ level, points: [[lon, lat], …] }] })',
    '}',
    'return beams',
    ''
  ].join('\n'), lang)
}
