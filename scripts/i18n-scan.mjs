// UI 词典覆盖率审计 —— 扫全库可见中文串，对账 src/shared/i18n/uiDict.data.js。
// 用法：node scripts/i18n-scan.mjs [--misses]   （--misses 逐条列出未覆盖串及出处）
// 新增界面后跑一遍：未覆盖串补进词典（EXACT 或带槽位的 PAT），译法遵循同目录 runtime.js 头注与
// docs 里的术语基线（WF_DICT / labelEn / LB_DOC_EN 优先）。
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const HAN = /[一-鿿]/
const SLOT_RE = /\$\{[^}]*\}|\{\{[^}]*\}\}/g

// —— 与 runtime.js 同规格的规整与模式编译 ——
const condense = (s) => s.replace(/\s+/g, ' ').trim()
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function compilePat(zh) {
  const lits = zh.split(SLOT_RE)
  if (lits.length < 2) return null
  return new RegExp('^' + lits.map(esc).join('([\\s\\S]*?)') + '$')
}

// —— 字符串扫描（与词典生成同一口径）——
function scanJsStrings(src) {
  const out = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? n : j + 1; continue }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue }
    if (c === "'" || c === '"') {
      let j = i + 1, buf = ''
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') { buf += src[j + 1] === 'n' ? '\n' : src[j + 1]; j += 2 } else buf += src[j++]
        if (src[j - 1] === '\n') break
      }
      out.push(buf); i = j + 1; continue
    }
    if (c === '`') {
      let j = i + 1, buf = ''
      while (j < n && src[j] !== '`') {
        // \n 要还原成真换行：运行时把 title 里的换行折成空格再查表，字面 'n' 会让键永远对不上
        if (src[j] === '\\') { buf += src[j + 1] === 'n' ? '\n' : src[j + 1]; j += 2; continue }
        if (src[j] === '$' && src[j + 1] === '{') {
          let d = 1, k = j + 2, expr = ''
          while (k < n && d > 0) { if (src[k] === '{') d++; else if (src[k] === '}') d--; if (d > 0) expr += src[k]; k++ }
          buf += '${' + expr + '}'; j = k; continue
        }
        buf += src[j++]
      }
      out.push(buf); i = j + 1; continue
    }
    i++
  }
  return out
}
function scanTplText(tpl) {
  const out = []
  const re = />([^<>]*)</g
  let m
  while ((m = re.exec(tpl))) if (HAN.test(m[1])) out.push(m[1])
  return out
}
function scanAttrs(tpl) {
  const out = []
  const re = /([:@a-zA-Z-]+)="([^"]*)"/g
  const skip = new Set(['class', 'style', 'id', 'key', 'ref', 'name', 'width', 'height', 'viewBox', 'd', 'points', 'transform', 'fill', 'stroke'])
  let m
  while ((m = re.exec(tpl))) {
    if (skip.has(m[1].replace(/^[:@]/, ''))) continue
    if (m[1][0] === ':' || m[1][0] === '@' || m[1].startsWith('v-')) continue
    if (HAN.test(m[2])) out.push(m[2])
  }
  return out
}
const FONT_RE = /^(\d+(\.\d+)?(px|pt|em)\s|bold\s|italic\s)/
function isNoise(s) {
  if (!HAN.test(s)) return true
  if (FONT_RE.test(s) && /雅黑|宋体|黑体|楷体/.test(s)) return true
  if (/serif|sans-serif|YaHei|SimSun|SimHei/.test(s)) return true
  if (['微软雅黑', '宋体', '黑体', '楷体', '仿宋', '等线', '新宋体'].includes(s.trim())) return true
  return false
}

const SCAN_DIRS = ['src', 'electron', 'packages/core/utils', 'packages/core/data']
const files = []
for (const d of SCAN_DIRS) {
  const abs = path.join(ROOT, d)
  if (!fs.existsSync(abs)) continue
  ;(function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'test') walk(fp) }
      else if (['.vue', '.js', '.html'].includes(path.extname(e.name))) files.push(fp)
    }
  })(abs)
}

const found = new Map() // 串 → 首个出处
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  if (rel === 'src/shared/i18n/uiDict.data.js') continue
  const src = fs.readFileSync(f, 'utf8')
  const ext = path.extname(f)
  const put = (raw) => { const s = condense(raw); if (s && !isNoise(s) && HAN.test(s) && !found.has(s)) found.set(s, rel) }
  if (ext === '.vue') {
    const ti = src.indexOf('<template>'), te = src.lastIndexOf('</template>')
    let tpl = '', script = src
    if (ti >= 0 && te > ti) { tpl = src.slice(ti, te); script = src.slice(0, ti) + src.slice(te) }
    script = script.replace(/<style[\s\S]*?<\/style>/g, '')
    tpl = tpl.replace(/<!--[\s\S]*?-->/g, '')
    scanTplText(tpl).forEach(put); scanAttrs(tpl).forEach(put)
    scanJsStrings(tpl).forEach(put)
    scanJsStrings(script.replace(/<script[^>]*>|<\/script>/g, '')).forEach(put)
  } else if (ext === '.html') {
    const t = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    scanTplText(t).forEach(put); scanAttrs(t).forEach(put)
    ;(t.match(/<script[\s\S]*?<\/script>/g) || []).forEach((sc) => scanJsStrings(sc).forEach(put))
  } else {
    scanJsStrings(src).forEach(put)
  }
}

// —— 载入词典（ESM 文本转 CJS 求值）——
const dictSrc = fs.readFileSync(path.join(ROOT, 'src/shared/i18n/uiDict.data.js'), 'utf8').replace(/\bexport const /g, 'const ')
const dict = new Function(dictSrc + '\nreturn { EXACT, PAT }')()
const pats = dict.PAT.map(([zh]) => compilePat(zh)).filter(Boolean)

let hitE = 0, hitP = 0
const misses = []
for (const [s, at] of found) {
  if (dict.EXACT[s] !== undefined) { hitE++; continue }
  if (pats.some((re) => re.test(s))) { hitP++; continue }
  misses.push([s, at])
}
const total = found.size
console.log(`可见中文串 ${total} ｜ 精确命中 ${hitE} ｜ 模式命中 ${hitP} ｜ 未覆盖 ${misses.length} ｜ 覆盖率 ${(100 * (hitE + hitP) / Math.max(1, total)).toFixed(1)}%`)
if (process.argv.includes('--misses')) {
  for (const [s, at] of misses) console.log(`${at}\t${s}`)
} else if (misses.length) {
  const byFile = {}
  for (const [, at] of misses) byFile[at] = (byFile[at] || 0) + 1
  console.log('未覆盖 TOP 出处：')
  Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([f, n]) => console.log(String(n).padStart(5), f))
}

// ══ 第二关：漏译探针（--leaks 逐条列出）═══════════════════════════════════════════
// 上面那关只问「查没查到表」，屏幕上仍会漏中文的两类它一概看不见：
//   ① 运行时拼出来的整串（`toast('已保存修改到：' + name)`）——每段字面量各自在表里，拼完的
//      整串却查不到，于是只被策展组合模式 `${a}：${b}` 切开、两半再各自落空；
//   ② 命中了组合模式但半截没译出的——上面那关照样算「模式命中」。
// 故这里完整复刻 runtime.js 的 translate()（分桶 + TAIL + 捕获组递归），把运行时【真会出现】
// 的串（JS 字面量/模板串、+ 拼接链、模板里文字+插值混排的文本节点）跑一遍，译后仍带汉字的列出。
const SEPS = [' · ', ' / ', ' → ', '——', '；', '。', '：']
const TAIL = '((?:(?!' + SEPS.map(esc).join('|') + ')[\\s\\S])*?)'
function compilePat2(zh, en) {
  const lz = zh.split(SLOT_RE), le = en.split(SLOT_RE)
  if (lz.length !== le.length || lz.length < 2) return null
  const openTail = lz[lz.length - 1] === '' && lz.some((l) => HAN.test(l))
  const body = lz.map(esc).reduce((acc, lit, i) => (i === 0 ? lit
    : acc + ((i === lz.length - 1 && openTail) ? TAIL : '([\\s\\S]*?)') + lit), '')
  return { re: new RegExp('^' + body + '$'), le, key: (lz[0] || '').slice(0, 2) }
}
const buckets = new Map(); const generic = []
for (const [zh, en] of dict.PAT) {
  const p = compilePat2(zh, en); if (!p) continue
  if (p.key.length === 2) { const l = buckets.get(p.key) || []; l.push(p); buckets.set(p.key, l) } else generic.push(p)
}
function translate(s, depth = 0) {
  const hit = dict.EXACT[s]
  if (hit !== undefined) return hit
  let out = s
  for (const p of (buckets.get(s.slice(0, 2)) || []).concat(generic)) {
    const m = p.re.exec(s); if (!m) continue
    let acc = p.le[0]
    for (let i = 1; i < p.le.length; i++) acc += (depth < 8 && HAN.test(m[i]) ? translate(m[i], depth + 1) : m[i]) + p.le[i]
    out = acc; break
  }
  return out
}

// —— 运行时真串的三个来源 ——
function tokenize(src) {
  const out = []; let i = 0; const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; let j = i + 1, buf = ''
      while (j < n && src[j] !== q) {
        if (src[j] === '\\') { buf += src[j + 1] === 'n' ? '\n' : src[j + 1]; j += 2; continue }
        if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
          let d = 1, k = j + 2, expr = ''
          while (k < n && d > 0) { if (src[k] === '{') d++; else if (src[k] === '}') d--; if (d > 0) expr += src[k]; k++ }
          buf += '${' + expr + '}'; j = k; continue
        }
        if (q !== '`' && src[j] === '\n') break
        buf += src[j++]
      }
      out.push({ t: 'str', v: buf }); i = j + 1; continue
    }
    out.push({ t: 'ch', v: c }); i++
  }
  return out
}
// `'前缀：' + expr + '后缀'` → `前缀：${…}后缀`：运行时真正出现在屏幕上的是拼完的那一串。
// OPT = 「三元选词」那种可选段：探针要连「这一段不出现」的那支一起试，否则整条被误报成漏译。
const OPT = '${?}'
function chains(tokens) {
  const res = []
  const isWs = (t) => t.t === 'ch' && /\s/.test(t.v)
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].t !== 'str') continue
    let k = i - 1
    while (k >= 0 && isWs(tokens[k])) k--
    if (k >= 0 && tokens[k].t === 'ch' && tokens[k].v === '+') continue      // 链首才起算
    const parts = [tokens[i].v]; let hasExpr = false; let j = i + 1
    for (;;) {
      let m = j
      while (m < tokens.length && isWs(tokens[m])) m++
      if (!(m < tokens.length && tokens[m].t === 'ch' && tokens[m].v === '+')) break
      m++
      while (m < tokens.length && isWs(tokens[m])) m++
      if (m >= tokens.length) break
      if (tokens[m].t === 'str') { parts.push(tokens[m].v); j = m + 1; continue }
      let depth = 0, expr = '', p = m, sawStr = false
      for (; p < tokens.length; p++) {
        const tk = tokens[p]
        if (tk.t === 'str') { expr += '"s"'; sawStr = true; continue }
        const c = tk.v
        if ('([{'.includes(c)) depth++
        else if (')]}'.includes(c)) { if (depth === 0) break; depth-- }
        else if (depth === 0 && (c === '+' || c === ',' || c === ';' || c === '\n')) break
        expr += c
      }
      // 操作数里嵌着字符串（三元选词那种）：这一段有没有、是哪一支都不定，标成可选槽位
      parts.push(sawStr ? OPT : '${' + condense(expr) + '}'); hasExpr = true; j = p
    }
    if (hasExpr && parts.some((s) => !s.startsWith('${') && HAN.test(s))) res.push(condense(parts.join('')))
  }
  return res
}
// 模板里「文字 + 插值」混排的文本节点。{{ … }} 内可有嵌套花括号/引号/大于号，故按括号配对替换、
// 按标签走切分（用 />([^<>]*)</ 会被 `{{ a > 1 ? … }}` 的 > 截断）
const SAMPLE = 'Xx1'
function stripMustache(s) {
  let out = '', i = 0
  while (i < s.length) {
    if (s[i] === '{' && s[i + 1] === '{') {
      let d = 1, j = i + 2, q = ''
      for (; j < s.length && d > 0; j++) {
        const c = s[j]
        if (q) { if (c === q) q = ''; continue }
        if (c === '"' || c === "'" || c === '`') { q = c; continue }
        if (c === '{') d++
        else if (c === '}') { if (s[j + 1] === '}' && d === 1) { j += 2; d = 0; break } d-- }
      }
      out += SAMPLE; i = j; continue
    }
    out += s[i++]
  }
  return out
}
function tplTextNodes(tpl) {
  const out = []; let i = 0, buf = ''
  const flush = () => { const s = condense(stripMustache(buf)); buf = ''; if (s && HAN.test(s)) out.push(s) }
  while (i < tpl.length) {
    if (tpl[i] === '<') {
      flush()
      let q = ''
      for (i++; i < tpl.length; i++) {
        const c = tpl[i]
        if (q) { if (c === q) q = ''; continue }
        if (c === '"' || c === "'") { q = c; continue }
        if (c === '>') { i++; break }
      }
      continue
    }
    buf += tpl[i++]
  }
  flush()
  return out
}

// 有意保持中文的（不是漏译）：写进存档的默认名、控制台日志、导出文件名、生成时已按语言分流的
const INTENDED = [
  /^\[PDF导出\]/,
  /^(点|发|收|地球站|点标记|设置|站型|城市组|批次|算例|副本)\s?\$\{/,   // 新建对象的默认名 = 数据
  /^\$\{[^}]*\}dBW·/,                                       // 生成的预设名 = 数据
  /报告_\$\{|曲线_\$\{|图_\$\{/,                            // 导出文件名
  /^\$\{[^}]*\}星\$\{[^}]*\}跳$/, /^端到端 \$\{/, /^\$\{Number\(/, /^(永久|永久授权|自定义期限)$/  // byLang 自己出中英
]
// byLang(中文, English) 已在生成时按平台语言出字，里面的中文不归呈现层管 —— 整个调用挖掉
function stripByLang(src) {
  let out = '', i = 0
  for (;;) {
    const k = src.indexOf('byLang(', i)
    if (k < 0) { out += src.slice(i); return out }
    out += src.slice(i, k) + 'byLang()'
    let d = 1, j = k + 7, q = ''
    for (; j < src.length && d > 0; j++) {
      const c = src[j]
      if (q) { if (c === q && src[j - 1] !== '\\') q = ''; continue }
      if (c === '"' || c === "'" || c === '`') { q = c; continue }
      if (c === '(') d++
      else if (c === ')') d--
    }
    i = j
  }
}
const rt = new Map()
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  if (rel === 'src/shared/i18n/uiDict.data.js' || rel === 'packages/core/utils/cities.js') continue
  if (path.extname(f) === '.html') continue
  const src0 = stripByLang(fs.readFileSync(f, 'utf8'))
  const body = path.extname(f) === '.vue' ? src0.replace(/<style[\s\S]*?<\/style>/g, '') : src0
  const put = (raw) => { const s = condense(raw); if (s && HAN.test(s) && !rt.has(s)) rt.set(s, rel) }
  for (const tk of tokenize(body)) if (tk.t === 'str' && HAN.test(tk.v)) put(tk.v)
  chains(tokenize(body)).forEach(put)
  if (path.extname(f) === '.vue') {
    const ti = src0.indexOf('<template>'), te = src0.lastIndexOf('</template>')
    if (ti >= 0 && te > ti) tplTextNodes(src0.slice(ti, te).replace(/<!--[\s\S]*?-->/g, '')).forEach(put)
  }
}
const leaks = []
for (const [s, at] of rt) {
  if (INTENDED.some((re) => re.test(s))) continue
  // 两支都试：可选段出现（换成样本值）、不出现（整段拿掉）。任一支译得干净就不算漏
  const probes = [condense(s.split(OPT).join(SAMPLE).replace(SLOT_RE, SAMPLE)),
    condense(s.split(OPT).join('').replace(SLOT_RE, SAMPLE))]
  let bad = null
  for (const probe of probes) {
    if (!HAN.test(probe) || /[{}`'"]/.test(probe)) { bad = null; break }  // 抽取残渣，不是运行时真串
    if (!HAN.test(translate(probe))) { bad = null; break }
    bad = bad || [s, at]
  }
  if (bad) leaks.push(bad)
}
console.log(`运行时真串 ${rt.size} ｜ 译后仍带中文 ${leaks.length}`)
if (process.argv.includes('--leaks')) for (const [s, at] of leaks) console.log(`${at}\t${s}`)
else if (leaks.length) {
  const byFile = {}
  for (const [, at] of leaks) byFile[at] = (byFile[at] || 0) + 1
  console.log('漏译 TOP 出处（--leaks 逐条列出）：')
  Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([f, n]) => console.log(String(n).padStart(5), f))
}
