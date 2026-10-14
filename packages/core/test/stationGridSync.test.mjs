// 链路表 StationGrid 两份副本（src/linkbudget/StationGrid.vue ⇔ src/ngso/StationGrid.vue）同步自测。运行：npm test -- stationGridSync
//
// 两份曾各改各的、悄悄漂开（frozen 前缀只进了一份）。现在约定逐字相同、只差 defaultsFor 那一行 import
// （两份 params 的 defaultsFor 是同一实现）；改一份就整份拷到另一份。本测试盯住：
//   ① 两份只差那一行；
//   ② 能过 @vue/compiler-sfc（模板 / 脚本无编译错——删 v-if 元素断 v-else 链那类事故在这里先红）；
//   ③ 交互修复的几处关键口径还在（单格提交压栈、空表守卫在 Z/Y/V 之后、Ctrl+- 吞掉缺省缩放、坏格标红）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined && extra !== '' ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

const A = readFileSync(join(ROOT, 'src/linkbudget/StationGrid.vue'), 'utf8').replace(/\r\n/g, '\n')
const B = readFileSync(join(ROOT, 'src/ngso/StationGrid.vue'), 'utf8').replace(/\r\n/g, '\n')

// ① 逐行比
{
  const a = A.split('\n'), b = B.split('\n')
  const diff = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff.push(i + 1)
  ok('★ 两份行数相同、只差一行', a.length === b.length && diff.length === 1, diff.slice(0, 5).join(','))
  const i = diff[0] - 1
  ok('★ 差的那一行就是 defaultsFor 的 import', diff.length === 1
    && a[i] === "import { defaultsFor } from './params.js'" && b[i] === "import { defaultsFor } from './ngsoParams.js'", a[i] + ' | ' + b[i])
}

// ② 编译
for (const [name, src] of [['linkbudget', A], ['ngso', B]]) {
  const { descriptor, errors } = parse(src, { filename: name + '/StationGrid.vue' })
  let errs = errors.map((e) => e.message || String(e))
  try {
    const script = compileScript(descriptor, { id: 'sg-' + name })
    const t = compileTemplate({ source: descriptor.template.content, filename: name + '/StationGrid.vue', id: 'sg-' + name, scoped: true, compilerOptions: { bindingMetadata: script.bindings } })
    errs = errs.concat(t.errors.map((e) => (e && e.message) || String(e)))
  } catch (e) { errs.push(e.message) }
  ok(`${name}：@vue/compiler-sfc 编译无错`, errs.length === 0, errs.slice(0, 3).join(' | '))
}

// ③ 关键口径（源码层面的护栏；交互本身由用户在软件里实测）
{
  const fnBody = (name) => { const i = A.indexOf('function ' + name + '('); if (i < 0) return ''; const j = A.indexOf('\n}\n', i); return A.slice(i, j) }
  ok('A3：单格提交值变了才压栈（endEdit → pushSnap(_editSnap)）', /pushSnap\(_editSnap\)/.test(fnBody('endEdit')) && /sameVal\(/.test(fnBody('endEdit')))
  ok('A3：进入编辑三处都记快照（startEdit / beginCapEdit / openDropdown）',
    ['startEdit', 'beginCapEdit', 'openDropdown'].every((f) => /_editSnap = snapshot\(\)/.test(fnBody(f))))
  ok('A3：Esc 取消丢掉快照', /_editSnap = null/.test(fnBody('cancelEdit')))
  const key = fnBody('onKey')
  const guard = key.indexOf('if (!props.stations.length) return')
  ok('A3：空表守卫在 Ctrl+Z / Y / V 之后', guard > 0 && ["e.key === 'z'", "e.key === 'y'", "e.key === 'v'"].every((s) => key.indexOf(s) >= 0 && key.indexOf(s) < guard))
  ok('G2 / F1：Ctrl+- 删行且 preventDefault（不落到整页缩放）', /mod && e\.key === '-'\) \{[^}]*deleteCtxRows\(\)[^}]*\}?[^\n]*preventDefault/.test(key))
  ok('G2：Ctrl+D / Ctrl+Shift++ / Ctrl+Shift+C', /fillDownKey\(\)/.test(key) && /insertRowsKey\(\)/.test(key) && /smartCopy\(e\.shiftKey\)/.test(key))
  ok('G2：Backspace 单格清空并进编辑、多格清选区', /clearAndEdit\(range\.fr, range\.fc\)/.test(key))
  // 2026-10-14 起导入 / 导出 Excel 收进工具条「更多」命令下拉（runMore 分派）
  ok('G2：工具条导入 / 导出 Excel', /value="importXlsx"/.test(A) && /value="exportXlsx"/.test(A) && /v === 'importXlsx'\) importXlsx\(\)/.test(A) && /v === 'exportXlsx'\) exportXlsx\(\)/.test(A))
  ok('D6：坏格挂 st-bad + 悬停范围', /'st-bad': !!badTitle\(s, f\)/.test(A) && /:title="badTitle\(s, f\) \|\| null"/.test(A))
  ok('rowMenuExtra 渲染在菜单末尾', /v-for="\(it, k\) in rowMenuExtra"/.test(A) && /runExtra\(it\)/.test(A))
}

console.log(`\nstationGridSync：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
