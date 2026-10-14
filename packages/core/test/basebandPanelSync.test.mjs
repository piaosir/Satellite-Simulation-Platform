// 载波参数面板 BasebandPanel 两份副本（src/linkbudget/BasebandPanel.vue ⇔ src/ngso/BasebandPanel.vue）同步自测。
// 运行：npm test -- basebandPanelSync
//
// ngso 那份给 NGSO / 再生式 / 端到端三窗共用，比 GSO 那份多一样东西：rateLocked（端到端下游段的速率只读）。
// 除此之外两份必须逐字一致——曾漂开过：ngso 那份门限字段丢了「门限」二字，读作「Es/N₀ ⇄ (dB)」。
// 本测试把 ngso 那份里 rateLocked 的已知差异剥掉后与 GSO 那份逐行比。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined && extra !== '' ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

const A = readFileSync(join(ROOT, 'src/linkbudget/BasebandPanel.vue'), 'utf8').replace(/\r\n/g, '\n')
const B = readFileSync(join(ROOT, 'src/ngso/BasebandPanel.vue'), 'utf8').replace(/\r\n/g, '\n')

// 已知差异：rateLocked 的 prop 声明（含注释）、四个速率框上的只读与锚点条件
const PROP = /calcModes: \{ type: Array, default: \(\) => \[\] \},\n(?:\s*\/\/[^\n]*\n)*\s*rateLocked: \{ type: Boolean, default: false \}/
ok('ngso 那份含 rateLocked 声明', PROP.test(B))
const strip = (s) => s
  .replace(PROP, 'calcModes: { type: Array, default: () => [] }')
  .split(" && !rateLocked").join('')
  .split(' :readonly="rateLocked"').join('')

const a = A.split('\n'), b = strip(B).split('\n')
const diff = []
for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff.push(i + 1)
ok('★ 剥掉 rateLocked 后两份逐字一致', diff.length === 0 && a.length === b.length,
  diff.slice(0, 5).map((n) => n + ': ' + (a[n - 1] || '').trim().slice(0, 60) + ' | ' + (b[n - 1] || '').trim().slice(0, 60)).join(' ; '))
ok('门限字段标签带「门限」二字（两份）', /<\/button>门限<i>\(dB\)<\/i>/.test(A) && /<\/button>门限<i>\(dB\)<\/i>/.test(B))

console.log(`basebandPanelSync：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
