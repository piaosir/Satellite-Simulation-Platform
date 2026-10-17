// 只读：统计「读源码文本 + 正则 / includes 断言」的钉桩规模
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const ROOT = process.argv[2]
const DIR = join(ROOT, 'packages/core/test')
const files = readdirSync(DIR).filter((n) => /\.test\.(m?js|cjs)$/.test(n))
let pinFiles = 0, pinAsserts = 0, totalAsserts = 0
const per = []
for (const n of files) {
  const t = readFileSync(join(DIR, n), 'utf8')
  // 变量被赋值为某源文件文本（readFileSync(...'src/...' 或 .vue / electron/...js）
  const srcVars = new Set()
  for (const m of t.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:[\w.]*readFileSync|read\w*|src\w*|load\w*)\s*\(([^;\n]*)/g)) {
    if (/src[\\/]|\.vue|electron[\\/]|ConstellationMap3D|App\.vue|preload|register|main\.js/.test(m[2])) srcVars.add(m[1])
  }
  // 断言里对这些变量做 includes / match / test / indexOf
  let k = 0
  for (const v of srcVars) {
    const re = new RegExp(`\\b${v}\\b\\s*\\.\\s*(includes|match|indexOf|search|split)\\s*\\(|\\.test\\(\\s*${v}\\b|\\b(match|doesNotMatch)\\(\\s*${v}\\b`, 'g')
    k += (t.match(re) || []).length
  }
  const asserts = (t.match(/\b(ok|assert\w*|approx|check|eq|near|expect|t\.ok|test)\s*\(/g) || []).length
  totalAsserts += asserts
  if (srcVars.size) { pinFiles++; pinAsserts += k; per.push([n, srcVars.size, k, asserts]) }
}
console.log('测试文件', files.length, '断言调用（粗计）', totalAsserts)
console.log('读源码当文本的测试文件', pinFiles, '对源码文本做 includes/正则的调用', pinAsserts)
per.sort((a, b) => b[2] - a[2])
for (const r of per.slice(0, 25)) console.log(String(r[2]).padStart(4), 'pins /', String(r[3]).padStart(4), 'asserts', r[0], `(${r[1]} src vars)`)
