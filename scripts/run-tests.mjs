// 全量单测 runner（npm test）。清单在 package.json 的 testFiles（一行一个，新测试挨着相近模块插入）。
//
// 为什么不再用 scripts.test 的 && 长链：Windows 下 npm 经 cmd.exe 起命令，单条命令行上限 8191 字符；
// 2026-09-24 那条链长到 8583 字符，npm test 直接报「The command line is too long.」、一个测试都不跑。
// 一行一个的数组还有个好处：几个会话同时往里加测试时各改各的行，不再挤在同一行上互相卷走。
//
// 用法：
//   npm test                          逐个跑全部（清单顺序），末尾汇总；有红则退出码 1
//   npm test -- --bail                遇红即停（原 && 链的语义）
//   npm test -- model sunOutage       只跑路径里含这些子串的
//   npm test -- --check               只核对清单：文件都在、无重复、packages/core/test 下没有漏登记的测试
//
// 每个测试是裸 node 脚本（失败非零退出），这里按原样逐个起子进程，输出直通终端。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const list = Array.isArray(pkg.testFiles) ? pkg.testFiles : []
const args = process.argv.slice(2)
const BAIL = args.includes('--bail')
const CHECK = args.includes('--check')
const filters = args.filter((a) => !a.startsWith('--'))

function check() {
  const problems = []
  const seen = new Set()
  for (const f of list) {
    if (seen.has(f)) problems.push(`重复：${f}`)
    seen.add(f)
    if (!existsSync(join(ROOT, f))) problems.push(`不存在：${f}`)
  }
  const dir = 'packages/core/test'
  for (const n of readdirSync(join(ROOT, dir))) {
    if (!/\.test\.(m?js|cjs)$/.test(n)) continue
    const f = `${dir}/${n}`
    if (!seen.has(f)) problems.push(`未登记：${f}`)
  }
  return problems
}

if (CHECK) {
  const p = check()
  for (const s of p) console.log(s)
  console.log(p.length ? `清单核对：${p.length} 处问题` : `清单核对：${list.length} 个测试，全部存在、无重复、无漏登记`)
  process.exit(p.length ? 1 : 0)
}

if (!list.length) { console.error('package.json 没有 testFiles 清单'); process.exit(2) }
const todo = filters.length ? list.filter((f) => filters.some((s) => f.includes(s))) : list
const red = []
const t0 = Date.now()
let ran = 0
for (const f of todo) {
  ran++
  const r = spawnSync(process.execPath, [f], { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) {
    red.push(f)
    console.error(`\n✗ ${f}（退出码 ${r.status ?? r.signal}）\n`)
    if (BAIL) break
  }
}
const sec = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n单测汇总：跑了 ${ran} / ${todo.length} 个，红 ${red.length} 个，用时 ${sec} s`)
for (const f of red) console.log(`  ✗ ${f}`)
process.exit(red.length ? 1 : 0)
