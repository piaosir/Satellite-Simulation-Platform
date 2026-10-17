// 只读：把 packages/core/test 下每个测试按「测什么」粗分类，统计源码钉桩 / 外部真值 / 引擎数值
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.argv[2]
const DIR = join(ROOT, 'packages/core/test')
const files = readdirSync(DIR).filter((n) => /\.test\.(m?js|cjs)$/.test(n))

const rows = []
for (const n of files) {
  const t = readFileSync(join(DIR, n), 'utf8')
  const lines = t.split('\n').length
  // 读源码当文本：readFileSync 指向 src/ 或 .vue/.js 源文件（排除 fixtures / json / csv / bin）
  const srcReads = (t.match(/readFileSync\([^)]*?(src[\\/]|\.vue|ConstellationMap3D|App\.vue|register\.js|main\.js|preload\.js)[^)]*\)/g) || []).length
  const srcReadVar = (t.match(/(read|src|code|text)\w*\s*\(\s*['"`][^'"`]*\.(vue|js|mjs)['"`]/g) || []).length
  const vueRefs = (t.match(/\.vue['"`]/g) || []).length
  // 正则 / includes 断言
  const reAsserts = (t.match(/assert\w*\.(match|doesNotMatch)\(|\.test\(\s*(src|code|text|s|vue|page|body)\w*\s*\)|\.includes\(\s*['"`]/g) || []).length
  // 引擎 import
  const engineImports = (t.match(/(packages\/core\/utils|\.\.\/utils\/|\.\.\/models\/|require\(['"]\.\.\/(utils|models|index))/g) || []).length
  const srcImports = (t.match(/(\.\.\/\.\.\/\.\.\/src\/|src\/(shared|viz|model|linkbudget|ngso|regen|ci|pfd|freqplan|ssa|sun|rain|e2e|components|pages)\/)/g) || []).length
  const elecImports = (t.match(/electron\/services|electron\/ipc/g) || []).length
  // 外部真值标记
  const ext = []
  const kw = {
    ITU: /ITU-R|P\.6\d\d|P\.8\d\d|S\.\d{3,4}|ITU 验证|validation (data|example)|CG-3M3J|ITU-R .*校验|官方算例|Study Group 3/i,
    golden: /golden|金标准/i,
    vallado: /Vallado|SGP4-VER|tcppver|AIAA/i,
    stk: /\bSTK\b|SATSOFT|SatSoft|GMAT|Orekit|MATLAB|Visualyse|SatMaster/,
    icd: /\bICD\b|IS-GPS|Meeus|JPL|Horizons|IERS|SOFA|USNO|NOAA|Astronomical Almanac/i,
    gpp: /3GPP|TS 38\.|TR 38\.|DVB-S2|EN 302 307/i
  }
  for (const [k, re] of Object.entries(kw)) if (re.test(t)) ext.push(k)
  rows.push({ n, lines, srcReads, srcReadVar, vueRefs, reAsserts, engineImports, srcImports, elecImports, ext: ext.join('+') })
}

// 粗分类
const cls = (r) => {
  const pin = r.srcReads > 0 || r.vueRefs > 0
  if (pin && r.engineImports === 0 && r.srcImports === 0 && r.elecImports === 0) return 'pin-only'
  if (pin) return 'mixed(pin+logic)'
  if (r.engineImports > 0) return 'engine'
  if (r.elecImports > 0) return 'main-service'
  if (r.srcImports > 0) return 'renderer-logic'
  return 'other'
}
const by = {}
for (const r of rows) { const c = cls(r); (by[c] = by[c] || []).push(r) }
console.log('total', rows.length, 'lines', rows.reduce((a, r) => a + r.lines, 0))
for (const [c, list] of Object.entries(by)) console.log(c.padEnd(18), String(list.length).padStart(4), 'lines', list.reduce((a, r) => a + r.lines, 0))
const withExt = rows.filter((r) => r.ext)
console.log('\n含外部真值/标杆关键词的测试', withExt.length)
const extCount = {}
for (const r of withExt) for (const k of r.ext.split('+')) extCount[k] = (extCount[k] || 0) + 1
console.log(extCount)
console.log('\n源码钉桩（读 .vue/src 文本）文件数', rows.filter((r) => r.srcReads > 0 || r.vueRefs > 0).length)
console.log('\npin-only 列表：', (by['pin-only'] || []).map((r) => r.n).join(' '))
console.log('\nmixed 列表：', (by['mixed(pin+logic)'] || []).map((r) => r.n).join(' '))
console.log('\nengine 含外部真值：', rows.filter((r) => cls(r) === 'engine' && r.ext).map((r) => `${r.n}[${r.ext}]`).join(' '))
console.log('\nother 列表：', (by['other'] || []).map((r) => r.n).join(' '))
