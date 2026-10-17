// 只读：合并 NODE_V8_COVERAGE 原始输出 → 按行近似的覆盖率（不装 c8，自己算）
// 用法：node cov-merge.mjs <仓库根> <v8cov 目录>
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.argv[2]
const COV = process.argv[3]
const rootNorm = ROOT.replace(/\\/g, '/').toLowerCase()

const covered = new Map()   // rel → Uint8Array（按字符 1=执行过）
const textOf = new Map()

function relOf(url) {
  if (!url.startsWith('file:')) return null
  let p
  try { p = fileURLToPath(url) } catch { return null }
  const n = p.replace(/\\/g, '/')
  if (!n.toLowerCase().startsWith(rootNorm + '/')) return null
  const rel = n.slice(rootNorm.length + 1)
  if (/^(node_modules|out|release|\.claude)\//.test(rel) || rel.includes('/node_modules/')) return null
  if (rel.startsWith('packages/core/test/')) return null
  if (/^\./.test(rel)) return null
  return rel
}

for (const f of readdirSync(COV)) {
  if (!f.endsWith('.json')) continue
  let j
  try { j = JSON.parse(readFileSync(join(COV, f), 'utf8')) } catch { continue }
  for (const s of j.result || []) {
    const rel = relOf(s.url || '')
    if (!rel) continue
    let text = textOf.get(rel)
    if (text === undefined) {
      try { text = readFileSync(join(ROOT, rel), 'utf8') } catch { text = null }
      textOf.set(rel, text)
    }
    if (text == null) continue
    const len = text.length
    const counts = new Int32Array(len)
    const ranges = []
    for (const fn of s.functions || []) for (const r of fn.ranges || []) ranges.push(r)
    ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset)
    for (const r of ranges) {
      const a = Math.max(0, r.startOffset), b = Math.min(len, r.endOffset)
      counts.fill(r.count, a, b)
    }
    let acc = covered.get(rel)
    if (!acc) { acc = new Uint8Array(len); covered.set(rel, acc) }
    if (acc.length !== len) continue
    for (let i = 0; i < len; i++) if (counts[i] > 0) acc[i] = 1
  }
}

// 行覆盖：代码行 = 去空白后非空、且不是纯注释行；首个非空白字符执行过 → 覆盖
function lineStats(text, acc) {
  let code = 0, hit = 0, off = 0, inBlock = false
  for (const line of text.split('\n')) {
    const t = line.trim()
    const first = off + (line.length - line.trimStart().length)
    off += line.length + 1
    if (!t) continue
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue }
    if (t.startsWith('//') || t.startsWith('*')) continue
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue }
    if (/^[}\])]+[;,]?$/.test(t)) continue        // 纯收括号行不计
    code++
    if (acc && acc[first]) hit++
  }
  return { code, hit }
}

function walk(dir, out) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) { if (!/^(node_modules|test|data|vendor|fixtures)$/.test(n) && !n.startsWith('.')) walk(p, out) }
    else if (/\.(m?js|cjs)$/.test(n)) out.push(relative(ROOT, p).split(sep).join('/'))
  }
  return out
}

const GROUPS = [
  ['packages/core/utils', join(ROOT, 'packages/core/utils')],
  ['packages/core/models', join(ROOT, 'packages/core/models')],
  ['electron/services', join(ROOT, 'electron/services')],
  ['electron/ipc', join(ROOT, 'electron/ipc')],
  ['src/shared', join(ROOT, 'src/shared')],
  ['src/viz', join(ROOT, 'src/viz')],
  ['src/model', join(ROOT, 'src/model')]
]
const rows = []
for (const [name, dir] of GROUPS) {
  if (!existsSync(dir)) continue
  const files = walk(dir, [])
  let code = 0, hit = 0, loaded = 0
  for (const rel of files) {
    if (/\.data\.js$/.test(rel) || /uiDict/.test(rel)) continue
    let text
    try { text = readFileSync(join(ROOT, rel), 'utf8') } catch { continue }
    const acc = covered.get(rel)
    const s = lineStats(text, acc && acc.length === text.length ? acc : null)
    code += s.code; hit += s.hit
    if (acc) loaded++
    rows.push({ rel, ...s, loaded: !!acc })
  }
  console.log(name.padEnd(22), 'files', String(files.length).padStart(4), 'loaded-by-tests', String(loaded).padStart(4), 'code-lines', String(code).padStart(6), 'covered', String(hit).padStart(6), (100 * hit / Math.max(1, code)).toFixed(1) + '%')
}
const KEY = ['linkCalculator.js', 'linkCalculatorNGSO.js', 'linkCalculatorRegen.js', 'rainAttenuation.js', 'sunOutageCalculator.js', 'linkChain.js', 'modeSolver.js', 'ngsoGeometry.js', 'frames.js', 'timeSystems.js', 'grdSampler.js', 'instantAtten.js', 'ntnPhy.js', 'modulation.js', 'elevation.js', 'rainRate.js', 'isothermHeight.js', 'envField.js', 'gaussStk.js']
console.log('\n关键引擎文件：')
for (const r of rows.filter((r) => KEY.some((k) => r.rel.endsWith('/' + k)))) console.log(' ', r.rel.padEnd(48), String(r.hit).padStart(5) + '/' + String(r.code).padEnd(5), (100 * r.hit / Math.max(1, r.code)).toFixed(1) + '%')
const intf = rows.filter((r) => /utils\/(interference|pfdmask)\//.test(r.rel))
let ic = 0, ih = 0; for (const r of intf) { ic += r.code; ih += r.hit }
console.log('  utils/interference + pfdmask 合计', ih + '/' + ic, (100 * ih / Math.max(1, ic)).toFixed(1) + '%')
const zero = rows.filter((r) => r.rel.startsWith('packages/core/utils') && !r.loaded && r.code > 30)
console.log('\npackages/core/utils 下从未被任何测试加载的文件（>30 代码行）', zero.length, zero.map((r) => r.rel.replace('packages/core/utils/', '') + '(' + r.code + ')').join(' '))
const zs = rows.filter((r) => r.rel.startsWith('electron/services') && !r.loaded && r.code > 30)
console.log('electron/services 下从未被加载', zs.length, zs.map((r) => r.rel.replace('electron/services/', '') + '(' + r.code + ')').join(' '))
