// Export diagnostics use their requested language, independently of the UI.
// The shared UI catalogue supplies established wording; these additions cover
// generated engine messages and preserve quoted station / satellite names.
const HAN = /[\u4e00-\u9fff]/
const SLOT = /\$\{[^}]*\}|\{\{[^}]*\}\}/g
const EXACT = {
  '失败': 'Failed', '未计算': 'Not calculated', '求解失败': 'Solver failed',
  '两站不互视': 'The two stations have no simultaneous satellite visibility',
  '手动轨道几何不可行': 'Manual orbit geometry is infeasible', '轨道几何不可行': 'Orbit geometry is infeasible',
  '两星几何不可行/时窗内不互视': 'Inter-satellite geometry is infeasible or not mutually visible within the window',
  '手动几何：斜距未填或非正数': 'Manual geometry: the slant range is missing or not positive',
  '手动几何：星间链路距离未填或非正数': 'Manual geometry: the ISL range is missing or not positive',
  '缺少必需的参数：satParams 或 linkParams': 'Missing required parameters: satParams or linkParams',
  '缺少轨道来源 orbit.type': 'Missing orbit source orbit.type',
  '星历点序列未解析成采样表（主进程应先按 ref 取表再调用几何引擎）': 'Ephemeris samples were not resolved into a sample table before geometry evaluation',
  '星历点序列没有有效采样点': 'The ephemeris sequence contains no valid samples',
  '典型时刻几何解算失败': 'Geometry evaluation failed at the representative epoch',
  '所选卫星轨道未能解析，无法确定其几何': 'The selected satellite orbit could not be resolved; geometry is unavailable',
  '两星几何重合（星间距离≈0）：手动圆轨道相位缺省相同。': 'The satellite positions coincide (ISL range approximately 0): the manual circular orbits have the same default phase.',
  '星历时段与分析时段不重叠': 'The ephemeris span and analysis window do not overlap',
  '轨道传播失败：时窗内取不到任何样本': 'Orbit propagation failed: no samples are available in the window',
  'NGSO 引擎不可用（linkCalculatorNGSO 加载失败）': 'The NGSO engine is unavailable (linkCalculatorNGSO failed to load)',
  '再生式引擎不可用（星间预算无法计算）': 'The regenerative engine is unavailable (ISL budget cannot be computed)',
  '再生式引擎不可用（激光星间无法计算）': 'The regenerative engine is unavailable (optical ISL budget cannot be computed)',
  '引擎调用失败': 'Engine call failed', '星间引擎调用失败': 'ISL engine call failed', '激光引擎调用失败': 'Optical engine call failed',
  '光学效率须 ∈ (0,1]': 'Optical efficiency must be in (0,1]',
  '链最少 2 个节点': 'A chain requires at least 2 nodes',
  '无法取得载波门限 C/N（链上没有可用的射频 hop）': 'The carrier C/N threshold is unavailable (the chain contains no usable RF hop)',
  '轨道高度需大于 0 km': 'Orbital altitude must exceed 0 km',
  '轨道倾角需在 0~180° 之间': 'Orbital inclination must be between 0 and 180°',
  '缺少单仰角衰减函数': 'The single-elevation attenuation function is missing',
  '目标超越概率需大于 0（可用度须小于 100%）': 'The target exceedance probability must exceed 0 (availability must be below 100%)',
  '仰角分布权重为 0': 'The elevation-distribution weight is 0',
  '不是数值': 'Not numeric', '发射卫星': 'Tx satellite', '接收卫星': 'Rx satellite',
  '卫星一': 'Satellite 1', '卫星二': 'Satellite 2', '发端': 'Tx', '收端': 'Rx',
  '发信站': 'Tx station', '收信站': 'Rx station', '两端是同一颗星或同一定点经度': 'Both endpoints are the same satellite or have the same orbital longitude',
  '°）——自动几何按它解最差工况': '°); automatic geometry uses it to determine the worst case'
}
const PAT = [
  ['卫星不可见（${a}）', 'Satellite not visible (${a})'],
  ['未知轨道来源 orbit.type: ${a}', 'Unknown orbit source orbit.type: ${a}'],
  ['未知计算方式：${a}', 'Unknown calculation mode: ${a}'],
  ['几何解算失败：${a}', 'Geometry evaluation failed: ${a}'],
  ['虚拟圆轨道构建失败：${a}', 'Virtual circular orbit construction failed: ${a}'],
  ['SGP4 初始化失败（error=${a}）', 'SGP4 initialization failed (error=${a})'],
  ['星历时段 ${a} 与分析时段 ${b} 不重叠', 'Ephemeris span ${a} does not overlap analysis window ${b}'],
  ['两星星历时段 ${a} 与 ${b} 不重叠', 'The two ephemeris spans ${a} and ${b} do not overlap'],
  ['搜索时窗 ${a}h 内发信站与收信站从不曾同时可见（单星无法中继此链路，可增大搜索时窗或改选卫星）', 'The Tx and Rx stations never have simultaneous satellite visibility in the ${a} h search window (this satellite cannot relay the link)'],
  ['hop 数应为 ${a}，实为 ${b}', 'Expected ${a} hops; received ${b}'],
  ['第 ${a} 跳星间链路可用度须在 0–100% 之间', 'Hop ${a} ISL availability must be between 0 and 100%'],
  ['第 ${a} 跳：卫星「${b}」没有可用轨道（GSO 需定点经度；NGSO 需轨道高度或选一颗星）', 'Hop ${a}: satellite “${b}” has no usable orbit (GSO requires orbital longitude; NGSO requires orbital altitude or a selected satellite)'],
  ['第 ${a} 跳：星间两端须各有可用轨道（「${b}」缺轨道）', 'Hop ${a}: both ISL endpoints require a usable orbit (“${b}” has no orbit)'],
  ['第 ${a} 跳缺最低仰角（°）——自动几何按它解最差工况', 'Hop ${a} has no minimum elevation (degrees); automatic geometry requires it for the worst case'],
  ['段 ${a} 起点电平缺失（卫星「${b}」须填下行 EIRP）', 'Segment ${a} has no starting level (satellite “${b}” requires a downlink EIRP)'],
  ['透明星『${a}』缺 SFD 或 G/T，无法确定转发器工作点', 'Bent-pipe satellite “${a}” lacks SFD or G/T; the transponder operating point is unavailable'],
  ['透明星『${a}』缺饱和 EIRP，无法确定转发器输出电平', 'Bent-pipe satellite “${a}” lacks saturated EIRP; the transponder output level is unavailable']
]
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function compile(zh, en) {
  const literals = zh.split(SLOT), translated = en.split(SLOT)
  if (literals.length < 2 || literals.length !== translated.length) return null
  return {
    re: new RegExp('^' + literals.map(esc).join('([\\s\\S]*?)') + '$'), translated,
    quoted: literals.slice(0, -1).map((lit, i) => /[「『“"]$/.test(lit) && /^[」』”"]/.test(literals[i + 1])),
    scalar: literals.slice(1).map((lit, i) => /^(?:°|%|\s*(?:km|GHz|MHz|kHz|dB|W|h)\b)/.test(lit) || /超出范围\s*$/.test(literals[i])),
    hasWords: HAN.test(literals.join('')),
    weight: literals.join('').length
  }
}
let catalogue
export async function reportDiagnosticTranslator(lang) {
  if (lang !== 'en') return (value) => typeof value === 'string' ? value : ''
  if (!catalogue) catalogue = import('./i18n/uiDict.data.js').then((d) => ({
    exact: { ...d.EXACT, ...EXACT },
    patterns: [...PAT, ...d.PAT].map(([zh, en]) => compile(zh, en)).filter((p) => p && p.hasWords).sort((a, b) => b.weight - a.weight)
  }))
  const { exact, patterns } = await catalogue
  const translate = (value, depth = 0) => {
    const s = String(value || '')
    if (!HAN.test(s) || depth > 12) return s
    if (exact[s] !== undefined) return exact[s]
    for (const p of patterns) {
      const m = p.re.exec(s)
      if (!m) continue
      if (p.scalar.some((scalar, i) => scalar && /[：；，（）]/.test(m[i + 1]))) continue
      return p.translated.reduce((out, literal, i) => out + (i ? (p.quoted[i - 1] ? m[i] : translate(m[i], depth + 1)) : '') + literal, '')
    }
    // Generated diagnostics combine field labels and messages with punctuation.
    // Match the whole message first, then translate its independent fragments.
    // Separate outer clauses before parentheses, so a nested diagnostic retains
    // its complete structure for a catalogue match on the next recursive call.
    let nesting = 0, quote = ''
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (/[「『“]/.test(ch)) quote = ch
      else if (/[」』”]/.test(ch)) quote = ''
      else if (!quote && /[（(\[]/.test(ch)) nesting++
      else if (!quote && /[）)\]]/.test(ch)) nesting--
      else if (!quote && nesting === 0 && /[：；，\n]/.test(ch)) {
        return translate(s.slice(0, i), depth + 1) + { '：': ': ', '；': '; ', '，': ', ', '\n': '\n' }[ch] + translate(s.slice(i + 1), depth + 1)
      }
    }
    const pieces = s.split(/([（）「」『』]| — |——| · |\n)/)
    if (pieces.length > 1) return pieces.map((p) => {
      const punctuation = { '：': ': ', '；': '; ', '，': ', ', '（': '(', '）': ')', '「': '“', '」': '”', '『': '“', '』': '”' }
      return punctuation[p] || translate(p, depth + 1)
    }).join('')
    return s
  }
  return translate
}

export function localizeReportLinkDiagnostics(link, translate) {
  const out = { ...link, error: translate(link.error || '') }
  for (const key of ['geom', 'islGeo', 'access']) {
    if (!link[key] || typeof link[key] !== 'object') continue
    out[key] = { ...link[key] }
    for (const field of ['reason', 'message']) if (typeof link[key][field] === 'string') out[key][field] = translate(link[key][field])
  }
  return out
}

export function reportClassification(value, lang) {
  const rows = [['内部', 'Internal'], ['公开', 'Public'], ['秘密', 'Confidential'], ['机密', 'Secret']]
  const found = rows.find((r) => r.includes(value))
  return found ? found[lang === 'en' ? 1 : 0] : value
}
