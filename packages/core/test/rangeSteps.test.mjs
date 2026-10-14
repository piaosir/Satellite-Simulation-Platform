// 全库滑杆台阶口径（2026-10-14 用户：「所有可以拉动的条的数字大小均变成纯线性」）。
// 扫 src 下全部 .vue / .html 里写死 min / max / step 的 <input type="range">，逐条核两件事：
//   ① 档数 (max − min) / step ≥ MIN_STOPS —— 不够就是一跳一跳的阶梯（旧的 0.5 号字、0.05 透明度）；
//   ② 台阶不粗于紧随其后读数的末位 —— 读数显示两位小数、台阶却是 0.05，就有一半的数拖不到。
//      读数写成裸 {{ x }} 的小数台阶也算错：位数随值跳（12 / 12.3），条内读数宽度跟着抖。
// 值域由数据决定的（:min / :max / :step 绑定的）不在此列：关节走 rangeFieldCore.fineStep，时刻 / 序号是离散量。
// 运行：npm test
import assert from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const MIN_STOPS = 80

// 本义离散、或行业惯例取整数百分比的量：档数可以少于 MIN_STOPS
const ALLOW_FEW = new Map([
  ['focusStyle.coneGenCount', '母线根数（整数）'],
  ['S.jpegQ', 'JPEG 质量按整数百分比（50–100）'],
  ['S.hud.opacity', '底板不透明度 20–95%，整数百分比 75 档']
])

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p, out) } else if (/\.(vue|html)$/.test(n)) out.push(p)
  }
  return out
}

const attr = (tag, a) => { const m = new RegExp(`\\s${a}="([^"]*)"`).exec(tag); return m ? m[1] : null }
const bound = (tag, a) => new RegExp(`\\s:${a}=`).test(tag)

// 读数表达式 → 末位（读数单位下）与倍率；认不出 → null（不核）
function readoutLsd(expr) {
  let m
  if ((m = /\.toFixed\((\d)\)/.exec(expr))) return { lsd: Math.pow(10, -Number(m[1])), k: /\*\s*100\b/.test(expr) ? 100 : 1 }
  if ((m = /\bfx\([^,()]+(?:\([^()]*\))?\s*(?:,\s*(\d))?\)/.exec(expr))) return { lsd: Math.pow(10, -Number(m[1] == null ? 2 : m[1])), k: 1 }
  if ((m = /Math\.round\(\s*[^)]*\*\s*(100|1000)\s*\)/.exec(expr))) return { lsd: 1, k: Number(m[1]) }
  if (/^\{\{\s*[\w.$[\]'+ ]+(?:\|\|\s*\d+)?\s*\}\}\s*\S*$/.test(expr.trim())) return { raw: true }
  return null
}

let pass = 0
const bad = []
let seen = 0
for (const f of walk(join(ROOT, 'src'))) {
  const src = readFileSync(f, 'utf8')
  const re = /<input\b[^>]*?\btype="range"[^>]*?>/gs
  let m
  while ((m = re.exec(src))) {
    const tag = m[0]
    if (bound(tag, 'min') || bound(tag, 'max') || bound(tag, 'step')) continue
    const min = Number(attr(tag, 'min')), max = Number(attr(tag, 'max')), step = Number(attr(tag, 'step'))
    if (![min, max, step].every(Number.isFinite) || !(step > 0)) continue
    seen++
    const line = src.slice(0, m.index).split('\n').length
    const where = `${relative(ROOT, f).replace(/\\/g, '/')}:${line}`
    const model = (/v-model(?:\.number)?="([^"]*)"/.exec(tag) || /:value="([^"]*)"/.exec(tag) || [, ''])[1]
    const stops = (max - min) / step
    if (stops < MIN_STOPS - 1e-9 && !ALLOW_FEW.has(model)) bad.push(`${where}  ${model}：${min}–${max} 台阶 ${step} 只有 ${Math.round(stops)} 档（< ${MIN_STOPS}）`)
    else pass++
    // 紧随其后的读数（中间可隔空白）
    const after = src.slice(m.index + tag.length, m.index + tag.length + 300)
    const r = /^\s*<(span|b|output)\b[^>]*>([\s\S]*?)<\/\1>/.exec(after)
    if (!r || /<(?!\/)/.test(r[2]) || /\s:rnumMap/.test(tag)) continue   // 自定义换算（对数刻度、时刻）的读数由组件自己格式化
    const ro = readoutLsd(r[2])
    if (!ro) continue
    if (ro.raw) {
      if (step < 1) bad.push(`${where}  ${model}：小数台阶 ${step} 的读数是裸值「${r[2].trim()}」，要定小数位`)
      else pass++
      continue
    }
    const lsdVal = ro.lsd / ro.k   // 读数末位折回滑杆值的单位
    if (step > lsdVal * (1 + 1e-9)) bad.push(`${where}  ${model}：台阶 ${step} 粗于读数末位 ${Number(lsdVal.toPrecision(6))}（「${r[2].trim()}」）`)
    else pass++
  }
}

assert.ok(seen > 60, `只扫到 ${seen} 条滑杆，扫描规则可能失效`)
assert.deepStrictEqual(bad, [], '滑杆台阶口径：\n  ' + bad.join('\n  '))
console.log(`rangeSteps: ${pass} passed（${seen} 条写死台阶的滑杆）`)
