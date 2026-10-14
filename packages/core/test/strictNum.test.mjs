// 引擎严格数值解析（packages/core/utils/strictNum.js）自测。运行：npm test -- strictNum
//
// 盯住四件事：
//   ① 合法串 / number 型：严格解析与旧的 parseFloat 结果 Object.is 相等（逐位不变的根据）；
//   ② 非法串（「36 MHz」「12,5」「1.2.3」「-」…）：strictNum → NaN，pickNum → 缺省，strictInputs → ''（引擎随后取缺省）；
//      全角数字转半角后合法；求解器内部的 NaN（number 或 'NaN' 串）照旧传；
//   ③ strictInputs 对全合法入参原样返回同一个对象、从不改调用方对象；
//   ④ 键清单覆盖引擎源码里所有按数值解析的入参键（新增入参忘了登记会在这里红）；引擎层面：非法 ⇔ 留空。
// 全量出参逐位对拍另有快照台（GEO / NGSO / 再生式 / 端到端 × 计算方式 × 随机合法串，改动前后 SHA-256 一致）。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const S = require('../utils/strictNum.js')
const core = require('../index.js')
const HERE = dirname(fileURLToPath(import.meta.url))

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

// ---------- ① 合法输入：与 parseFloat 逐位相同 ----------
let seed = 20261014
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const legal = [
  '0', '-0', '+0', '0.0', '.5', '-.5', '+.5', '5.', '-5.', '007', '1e3', '1E3', '1e+3', '1e-3', '-1.5E-7', '2.5e10',
  ' 12.5 ', '\t7\n', '　14.25　', '14.250000', '116.4074', '-84', '39.9042', '0.000001', '123456789012345678901234567890',
  '1.7976931348623157e308', '5e-324', '4.9406564584124654e-324', '0.1', '0.2', '0.30000000000000004'
]
const fmts = [
  (x) => x.toFixed(Math.floor(rnd() * 8)), (x) => String(x), (x) => x.toExponential(Math.floor(rnd() * 12)),
  (x) => x.toPrecision(1 + Math.floor(rnd() * 16)), (x) => (x >= 0 ? '+' : '') + String(x), (x) => '  ' + String(x) + ' ',
  (x) => x.toFixed(3).replace(/^(-?)0\./, '$1.'), (x) => x.toPrecision(5).toUpperCase()
]
for (let i = 0; i < 20000; i++) {
  const mag = Math.pow(10, Math.floor(rnd() * 14) - 6)
  const x = (rnd() - 0.4) * mag
  legal.push(fmts[i % fmts.length](x))
}
const nums = [0, -0, 1, -1, 0.1, 14.25, -84, 1e21, 1e-7, 5e-324, Number.MAX_VALUE, -Number.MAX_VALUE, 116.4074, NaN, Infinity, -Infinity]
for (let i = 0; i < 2000; i++) nums.push((rnd() - 0.5) * Math.pow(10, Math.floor(rnd() * 20) - 8))
{
  let bad = null
  for (const s of legal) if (!Object.is(S.strictNum(s), parseFloat(s))) { bad = s; break }
  ok('★ 合法串：strictNum 与 parseFloat Object.is 相等（' + legal.length + ' 个）', bad === null, bad === null ? undefined : JSON.stringify(bad))
  let bad2 = null
  for (const s of legal) if (!Object.is(S.pickNum(s, 12345), parseFloat(s))) { bad2 = s; break }
  ok('★ 合法串：pickNum 与 parseFloat Object.is 相等', bad2 === null, bad2 === null ? undefined : JSON.stringify(bad2))
  let bad3 = null
  for (const n of nums) if (!Object.is(S.strictNum(n), parseFloat(n)) || !Object.is(S.pickNum(n, 12345), parseFloat(n))) { bad3 = n; break }
  ok('★ number 型（含 -0 / NaN / ±Infinity）：与 parseFloat Object.is 相等', bad3 === null, bad3 === null ? undefined : String(bad3))
  let bad4 = null
  for (const s of legal) {
    const o = { a: s }
    if (S.strictInputs(o, ['a']) !== o) { bad4 = s; break }
  }
  ok('★ 合法串：strictInputs 原样放行（同一对象）', bad4 === null, bad4 === null ? undefined : JSON.stringify(bad4))
}

// ---------- ② 非法串 / 全角 / 内部 NaN ----------
{
  const junk = ['36 MHz', '12,5', '1.2.3', '-', '+', '.', 'e3', '1e', '1e+', '0x10', '1_000', '2,048', 'abc', '14.25GHz', '５ dB', '1 2', '--5', '+-5', 'true']
  ok('非法串：strictNum → NaN', junk.every((s) => Number.isNaN(S.strictNum(s))), junk.filter((s) => !Number.isNaN(S.strictNum(s))).join(' | ') || undefined)
  ok('非法串：pickNum → 缺省', junk.every((s) => S.pickNum(s, 7) === 7))
  ok('「36 MHz」不再读成 36、「12,5」不再读成 12', S.pickNum('36 MHz', 36.5) === 36.5 && S.pickNum('12,5', 0) === 0)
  ok('空 / 纯空白 → 缺省', S.pickNum('', 3) === 3 && S.pickNum('   ', 3) === 3 && S.pickNum(null, 3) === 3 && S.pickNum(undefined, 3) === 3)
  ok('输入 0 就是 0（不走 || 缺省）', S.pickNum('0', 3) === 0 && S.pickNum(0, 3) === 0)
  ok('全角数字 / 全角减号转半角后合法', S.strictNum('－７５') === -75 && S.strictNum('１４．２５') === 14.25 && S.pickNum('－116.4', 0) === -116.4)
  ok('非字符串非数字（布尔 / 对象）→ 缺省', S.pickNum(true, 9) === 9 && S.pickNum({}, 9) === 9)
  ok('★ 求解器内部 NaN 照旧传（number NaN / \'NaN\' 串不被抹成缺省）',
    Number.isNaN(S.pickNum(NaN, 3)) && Number.isNaN(S.pickNum('NaN', 3)) && Number.isNaN(S.strictNum('NaN')) && S.strictNum('Infinity') === Infinity)
}

// ---------- ③ strictInputs ----------
{
  const o = { a: '14.25', b: '36 MHz', c: '－75', d: 12, e: NaN, f: '', g: 'Satellite', h: '  ' }
  const snap = JSON.stringify(o)
  const r = S.strictInputs(o, ['a', 'b', 'c', 'd', 'e', 'f', 'h'])
  ok('非法 → \'\'、全角 → 半角串、合法 / number / 空原样', r.a === '14.25' && r.b === '' && r.c === '-75' && r.d === 12 && Number.isNaN(r.e) && r.f === '' && r.h === '')
  ok('不在清单里的键不动（文本键如卫星名）', r.g === 'Satellite')
  ok('改了才浅拷贝，调用方对象原封不动', r !== o && JSON.stringify(o) === snap)
  const clean = { a: '1', b: 2, c: '' }
  ok('全合法 → 原样返回同一个对象', S.strictInputs(clean, ['a', 'b', 'c']) === clean)
  ok('非对象原样返回', S.strictInputs(null, ['a']) === null && S.strictInputs(undefined, ['a']) === undefined)
}

// ---------- ④ 键清单覆盖引擎源码 ----------
{
  const inKeys = new Set(S.LINK_INPUT_NUM_KEYS), satKeys = new Set(S.LINK_SAT_NUM_KEYS)
  const miss = []
  for (const f of ['linkCalculator.js', 'linkCalculatorNGSO.js']) {
    const src = readFileSync(join(HERE, '..', 'utils', f), 'utf8')
    for (const m of src.matchAll(/(?:parseFloat|pickNum)\((inputs|satParams)\.([A-Za-z_0-9]+)/g)) {
      if (!(m[1] === 'inputs' ? inKeys : satKeys).has(m[2])) miss.push(f + ':' + m[1] + '.' + m[2])
    }
    for (const m of src.matchAll(/islNum\('([A-Za-z_0-9]+)'/g)) if (!satKeys.has(m[1])) miss.push(f + ':islNum ' + m[1])
    for (const m of src.matchAll(/resolveNgsoSlantRange\(\s*[^,]+,\s*inputs\.([A-Za-z_0-9]+),\s*inputs\.([A-Za-z_0-9]+)/g)) {
      for (const k of [m[1], m[2]]) if (!inKeys.has(k)) miss.push(f + ':resolve ' + k)
    }
    ok(f + ' 先过 strictInputs 再取数', /satParams = strictNumMod\.strictInputs\(satParams/.test(src) && /inputs = strictNumMod\.strictInputs\(inputs/.test(src))
  }
  ok('★ 引擎按数值解析的入参键全部登记在 strictNum 清单里', miss.length === 0, miss.join(', ') || undefined)
  ok('文本键不在清单里（fec / rsCode / 站名 / 极化 / 模式）',
    ['fec', 'rsCode', 'earthStationLocation', 'uplinkPolarization', 'distanceMode', 'noiseRatioMode', 'modulation'].every((k) => !inKeys.has(k) && !satKeys.has(k)))
}

// ---------- 引擎层面：非法 ⇔ 留空；合法照算 ----------
{
  const SAT = { frequencyBand: 'Ku', satelliteName: 'DEMO' }
  const q = (f) => { const e = console.error, l = console.log; console.error = console.log = () => {}; try { return f() } finally { console.error = e; console.log = l } }
  const run = (lp, sp) => JSON.stringify(q(() => core.calculateLinkBudget(Object.assign({}, SAT, sp || {}), lp)))
  ok('GEO：信息速率「2,048」⇔ 留空（不再读成 2）', run({ infoRate: '2,048' }) === run({ infoRate: '' }))
  ok('GEO：上行频率「14.25 GHz」⇔ 留空', run({ centerFrequency: '14.25 GHz' }) === run({ centerFrequency: '' }))
  ok('GEO：转发器带宽「36 MHz」⇔ 留空', run({}, { transponderBandwidth: '36 MHz' }) === run({}, { transponderBandwidth: '' }))
  ok('GEO：合法「1e1」≡「10」（科学计数照收）', run({ feederLoss: '1e1' }) === run({ feederLoss: '10' }))
  ok('GEO：全角「－84」⇔ 半角「-84」', run({}, { sfdRef: '－84' }) === run({}, { sfdRef: '-84' }))
  const runN = (lp) => JSON.stringify(q(() => core.calculateLinkBudgetNGSO(SAT, Object.assign({ distanceMode: 'slantRange', slantRange: '2000', rxDistanceMode: 'slantRange', rxSlantRange: '2000' }, lp))))
  ok('NGSO：口径「2.4m」⇔ 留空', runN({ antennaDiameter: '2.4m' }) === runN({ antennaDiameter: '' }))
}

console.log(`\nstrictNum：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
