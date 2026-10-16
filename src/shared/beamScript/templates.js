// 可编程波束地图 · 内置模板：templates/*.bmjs 原文 → { id, name, ext, code }（按界面语言出注释与文件名）。
//
// 模板是独立的文本文件而不是 JS 字符串常量：脚本里满是反引号与 ${…}，塞进模板字面量要层层转义，读不动也改不动。
// 扩展名 .bmjs：不让构建 / i18n 扫描 / 编辑器把它们当项目源码。渲染端由 viz/beamScript/templateSource.js 用
// import.meta.glob 以原文载入，Node 测试直接读盘，都交给这里的 parseTemplates。
//
// 文本约定：
//   //! key: value       头部元数据（id / name / ext），不进代码
//   //zh …  /  //en …    只在该语言下保留的整行注释（落成 // …）
//   ⟪中文|English⟫        行内双语片段（文件名、注释里的短语）；片段内不能出现「|」与「⟫」

export function localize(src, lang = 'zh') {
  const en = lang === 'en'
  return String(src).replace(/\r\n?/g, '\n').split('\n')
    .filter((ln) => { const m = /^\s*\/\/(zh|en)(?=\s|$)/.exec(ln); return !m || (m[1] === 'en') === en })
    .map((ln) => ln.replace(/^(\s*)\/\/(?:zh|en)(?:\s|$)/, '$1// '))
    .join('\n')
    .replace(/⟪([^|⟫]*)\|([^⟫]*)⟫/g, (_, zh, e) => (en ? e : zh))
}

export function parseTemplate(src, lang = 'zh') {
  const meta = {}
  const body = []
  for (const ln of String(src).replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\/\/!\s*(\w+)\s*:\s*(.*)$/.exec(ln)
    if (m && !body.length) { meta[m[1]] = m[2].trim(); continue }
    body.push(ln)
  }
  while (body.length && !body[body.length - 1].trim()) body.pop()
  return {
    id: meta.id || '', name: localize(meta.name || meta.id || '', lang), ext: (meta.ext || '').toLowerCase(),
    code: localize(body.join('\n'), lang) + '\n'
  }
}

/** rawMap: { 文件路径: 原文 }（按路径名排序 = 模板顺序） */
export function parseTemplates(rawMap, lang = 'zh') {
  return Object.keys(rawMap || {}).sort().map((k) => ({ ...parseTemplate(rawMap[k], lang), builtin: true }))
}

// 新建脚本的起手式
export function blankScript(lang = 'zh') {
  return localize([
    '//zh data：波束地图（data.beams / data.polygons / data.stations / data.points / data.trajectories / data.meta）',
    '//en data: the beam map (data.beams / data.polygons / data.stations / data.points / data.trajectories / data.meta)',
    '//zh 返回 file(文件名, 内容) 即导出该文件；返回数组可一次导出多个文件。',
    '//en Return file(name, content) to export it; return an array to export several files.',
    '',
    'const lines = []',
    'for (const b of data.beams) {',
    '  lines.push(`${b.satellite}\\t${b.name}\\t${b.contours.map((c) => c.level).join(\' / \')}`)',
    '}',
    '',
    "return file('⟪输出|output⟫.txt', lines.join('\\n'))",
    ''
  ].join('\n'), lang)
}
