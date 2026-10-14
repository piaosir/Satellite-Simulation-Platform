// 蓝块上的字色口径（2026-10-14 前端审查 R1）：背景是 --accent-fill / --sel-fill / --primary-fill（含 -hover）
// 的规则，以及挂在它下面的子规则（同一复合选择器带后代 / 子代 / 伪类），字、勾、状态点、半透明膜一律取对应的
// --*-on；不许出现 var(--bg)。专业深色的蓝块往深里走（#3e5b87），--bg 是 #111 —— 黑字压深蓝约 2–2.7:1。
// 只有墨色实底 background: var(--accent) 才配 var(--bg)（记忆 accent-btn-ink-var-bg）。
// 判定（只在同一文件内匹配）：
//   ① 收集所有「背景取 -fill」的规则的最后一个复合选择器（简单选择器集合）；另一条规则只要有某个复合选择器
//      是它的超集（.fd-mi.new:hover ⊇ .fd-mi:hover；.tzp-i.on > em 里的 .tzp-i.on ⊇ .tzp-i.on），且声明里有
//      var(--bg)，即判违规 —— 除非它自己另铺了一块不透明、不含 --bg 的底（字色相对的是新底）。
//   ② 蓝块规则本身没写字色时，字色来自同一元素更泛的母规则（勾选列 .eg-v { color: var(--bg) }）。
// 运行：npm test
import assert from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const FILL = /var\(--(?:accent|sel|primary)-fill(?:-hover)?\)/
const BG = /var\(--bg\)/

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p, out) } else if (/\.(vue|css)$/.test(n)) out.push(p)
  }
  return out
}

// 抽出 CSS 文本：.vue 取 <style> 块，.css 取全文；去注释
function cssOf(file, src) {
  const css = file.endsWith('.vue') ? [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n') : src
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

// 扁平规则表：{ sel, body }；@media / @supports 内的规则照收，@keyframes 跳过
function rules(css) {
  css = css.replace(/@(?:-webkit-)?keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  css = css.replace(/@[a-z-]+[^{;]*\{/g, '')
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css))) {
    const sel = m[1].trim()
    if (sel && !sel.startsWith('@')) out.push({ sel, body: m[2] })
  }
  return out
}

// 选择器 → 复合选择器列表，每个是简单选择器集合（类、伪类、属性、标签）；:where / :is 归零
function compounds(sel) {
  return sel.replace(/:(?:where|is)\([^)]*\)/g, '')
    .split(/\s*[\s>+~]\s*/).filter(Boolean)
    .map(c => new Set(c.match(/(?:::?[\w-]+(?:\([^)]*\))?|\.[\w-]+|\[[^\]]*\]|#[\w-]+|^[a-z][\w-]*|\*)/gi) || []))
}
const sup = (a, b) => { if (!b.size) return false; for (const x of b) if (!a.has(x)) return false; return true }
const bgOf = body => (body.match(/(?:^|;)\s*background(?:-color)?\s*:([^;]*)/) || [])[1]
const hasColor = body => /(?:^|;)\s*color\s*:/.test(body)
const colorIsBg = body => /(?:^|;)\s*color\s*:[^;]*var\(--bg\)/.test(body)
const rel = f => relative(ROOT, f).replace(/\\/g, '/')

const lastCompounds = rs => rs.flatMap(r => r.sel.split(',').map(s => compounds(s.trim())).filter(cs => cs.length).map(cs => cs[cs.length - 1]))
// 全局样式表（src/styles/*.css）里的蓝块对所有文件生效：组件里挂在 .lb-ctx-i:hover 下的子规则也要核
const SHARED = walk(join(ROOT, 'src/styles')).filter(f => f.endsWith('.css'))
const sharedFills = lastCompounds(SHARED.flatMap(f => rules(cssOf(f, readFileSync(f, 'utf8')))).filter(r => FILL.test(bgOf(r.body) || '')))

const bad = []
for (const file of walk(join(ROOT, 'src'))) {
  const src = readFileSync(file, 'utf8')
  if (!BG.test(src)) continue
  const rs = rules(cssOf(file, src))
  const fillRules = rs.filter(r => FILL.test(bgOf(r.body) || ''))
  const fills = lastCompounds(fillRules).concat(sharedFills)

  // ①
  //   同一元素（命中的是最后一个复合选择器）自己另铺了不透明底：换了底，字色相对新底，不归本条管；
  //   子元素（命中的是祖先复合选择器）的底取 var(--bg)：蓝块上一个黑点，照样违规。
  //   不带 skin 的兜底规则被 :root[data-skin="studio"] 同名规则整条覆盖时不管（报表页没有蓝块）。
  const studio = new Map(rs.filter(r => r.sel.includes('[data-skin="studio"]')).flatMap(r => r.sel.split(',').map(s => [s.trim().replace(/^:root\[data-skin="studio"\]\s+/, ''), r])))
  for (const r of rs) {
    if (!BG.test(r.body)) continue
    const own = bgOf(r.body)
    const opaque = own && !FILL.test(own) && !/transparent/.test(own)
    for (const s of r.sel.split(',')) {
      const sel = s.trim(), ov = studio.get(sel)
      if (ov && ov !== r && !BG.test(ov.body)) continue
      const cs = compounds(sel)
      const i = cs.findIndex(c => fills.some(f => sup(c, f)))
      if (i < 0) continue
      const self = i === cs.length - 1 && !/::/.test(sel.split(/\s*[\s>+~]\s*/).pop())
      if (opaque && (self || !BG.test(own))) continue
      bad.push(`${rel(file)}  ${sel}`); break
    }
  }
  // ②
  for (const r of fillRules) {
    if (hasColor(r.body)) continue
    for (const s of r.sel.split(',')) {
      const fc = compounds(s.trim())
      for (const q of rs) {
        if (q === r || !colorIsBg(q.body)) continue
        const hit = q.sel.split(',').some(qs => { const qc = compounds(qs.trim()); return qc.length === fc.length && qc.every((c, i) => sup(fc[i], c)) })
        if (hit) bad.push(`${rel(file)}  ${s.trim()}（字色继承自 ${q.sel.trim()}）`)
      }
    }
  }
}

assert.deepStrictEqual(bad, [], '蓝块（-fill）上不许用 var(--bg)，改对应的 --*-on：\n' + bad.join('\n'))
console.log('fillInkPairing: ok')
