// 链路预算数值校验（src/shared/lbValidate.js + src/shared/num.js 的 numStrict）自测。运行：npm test -- lbValidate
//
// 盯住：
//   ① 单格口径：空＝合法（按缺省）；严格数值语法（前后空白 / 全角 / 科学计数照收，「36 MHz」「12,5」「1.2.3」不收）；
//      范围按字段 min / max / minEx；msg 只陈述状态；
//   ② validateRows / validateForm 的出参形状（App 的计算前预校验按它逐行报告）；
//   ③ ★ 四份 schema 的出厂缺省值全部合法（范围不能把缺省自己判成坏格）；范围本身自洽；
//   ④ ★ 渲染端 numStrict 与引擎 strictNum 同一语法：同一批串，判合法 / 非法一致，合法取值逐位相同。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateValue, validateRows, validateForm, rangeText, rangeTitle, invalidTitle } from '../../../src/shared/lbValidate.js'
import { numStrict, NUM_RE } from '../../../src/shared/num.js'
import * as GEO from '../../../src/linkbudget/params.js'
import * as NGSO from '../../../src/ngso/ngsoParams.js'
import * as REGEN from '../../../src/regen/regenParams.js'
import * as E2E from '../../../src/e2e/e2eParams.js'

const require = createRequire(import.meta.url)
const S = require('../utils/strictNum.js')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined && extra !== '' ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

const FREQ = { key: 'centerFrequency', label: '上行频率', unit: 'GHz', type: 'num', min: 0.1, max: 100, def: '14.25' }
const PWR = { key: 'paPowerW', label: '功放功率预设', unit: 'W', type: 'num', min: 0, minEx: true, def: '40' }
const EFF = { key: 'antennaEfficiency', label: '天线效率', unit: '%', type: 'num', min: 0, minEx: true, max: 100 }
const LOSS = { key: 'feederLoss', label: '馈线损耗', unit: 'dB', type: 'num', min: 0 }
const FREE = { key: 'sfdRef', label: 'SFDref', unit: 'dBW/m²', type: 'num', def: '-84' }

// ---------- ① 单格 ----------
{
  ok('空 / 纯空白 / null ＝ 合法（按缺省）', [undefined, null, '', '   ', '　'].every((v) => validateValue(FREQ, v) === null))
  ok('合法写法照收', ['14.25', ' 14.25 ', '+14.25', '1.425e1', '1.425E+1', '14.', '.5', '１４．２５', 14.25].every((v) => validateValue(FREQ, v) === null))
  const nan = ['36 MHz', '12,5', '1.2.3', 'abc', '-', '14.25GHz', '0x10', 'Infinity', 'NaN', NaN, true]
  ok('「36 MHz」「12,5」「1.2.3」等 → 不是数值', nan.every((v) => { const r = validateValue(FREQ, v); return r && r.code === 'nan' && r.msg === '不是数值' }),
    nan.filter((v) => { const r = validateValue(FREQ, v); return !(r && r.code === 'nan') }).map(String).join(' | '))
  const r1 = validateValue(FREQ, '14250')
  ok('频率 14250 GHz → 超出范围 0.1–100', r1 && r1.code === 'range' && r1.msg === '超出范围 0.1–100' && r1.range === '0.1–100 GHz', r1 && r1.msg)
  ok('闭区间端点合法', validateValue(FREQ, '0.1') === null && validateValue(FREQ, '100') === null)
  ok('开下界：功率 0 → 超出范围 > 0；0.001 合法', validateValue(PWR, '0') && validateValue(PWR, '0').msg === '超出范围 > 0' && validateValue(PWR, '0.001') === null)
  ok('开下界 + 闭上界：效率 (0, 100]', rangeText(EFF) === '(0, 100]' && validateValue(EFF, '0') && validateValue(EFF, '100') === null && validateValue(EFF, '100.1'))
  ok('单边：损耗 ≥ 0；-0.5 → 超出范围 ≥ 0', rangeText(LOSS) === '≥ 0' && validateValue(LOSS, '-0.5').msg === '超出范围 ≥ 0' && validateValue(LOSS, '0') === null)
  ok('无范围字段只查是不是数', validateValue(FREE, '-200') === null && validateValue(FREE, '-84 dBW').code === 'nan' && rangeText(FREE) === '')
  ok('非数值字段 / 计算列不校验', validateValue({ key: 'fec', type: 'text' }, '3/4 abc') === null && validateValue({ ...FREQ, ro: true }, 'x') === null && validateValue(null, 'x') === null)
  ok('rangeTitle 带单位', rangeTitle(FREQ) === '0.1–100 GHz' && rangeTitle(PWR) === '> 0 W' && rangeTitle(FREE) === '')
  ok('悬停 title', invalidTitle(FREQ, validateValue(FREQ, 'x')) === '不是数值 · 0.1–100 GHz' && invalidTitle(FREQ, validateValue(FREQ, '200')) === '超出范围 0.1–100 GHz'
    && invalidTitle(FREE, validateValue(FREE, 'x')) === '不是数值' && invalidTitle(FREQ, null) === '')
}

// ---------- ② 整表 / 表单 ----------
{
  const fields = [{ key: 'name', label: '地球站位置', type: 'text' }, FREQ, PWR, { key: '_m', label: '余量', type: 'num', ro: true }]
  const rows = [
    { _id: 'r1', name: '北京', centerFrequency: '14.25', paPowerW: '' },
    { _id: 'r2', name: '上海', centerFrequency: '14250', paPowerW: '40 W', _m: 'x' },
    { _id: 'r3', name: '36 MHz', centerFrequency: '', paPowerW: '-1' }
  ]
  const bad = validateRows(fields, rows)
  ok('validateRows：只报数值列的坏格，按行序、列序', bad.length === 3
    && bad[0].row === 1 && bad[0].id === 'r2' && bad[0].key === 'centerFrequency' && bad[0].label === '上行频率' && bad[0].value === '14250' && bad[0].msg === '超出范围 0.1–100'
    && bad[1].row === 1 && bad[1].key === 'paPowerW' && bad[1].msg === '不是数值'
    && bad[2].row === 2 && bad[2].key === 'paPowerW' && bad[2].msg === '超出范围 > 0', JSON.stringify(bad))
  ok('validateRows：空表 / 空字段 → []', validateRows(fields, []).length === 0 && validateRows([], rows).length === 0 && validateRows(null, null).length === 0)
  const fb = validateForm([FREQ, PWR, FREE], { centerFrequency: '0', paPowerW: '20', sfdRef: '' })
  ok('validateForm', fb.length === 1 && fb[0].key === 'centerFrequency' && fb[0].msg === '超出范围 0.1–100', JSON.stringify(fb))
}

// ---------- ③ schema：缺省值合法、范围自洽 ----------
{
  const all = [
    ['GSO', GEO.ALL_FIELDS], ['NGSO', NGSO.ALL_FIELDS], ['再生式', REGEN.ALL_FIELDS],
    ['端到端', [...E2E.CARRIER_FIELDS, ...E2E.ES_FIELDS, ...E2E.SAT_FIELDS, ...E2E.NODE_ES_FIELDS, ...E2E.NODE_ES_TX_FIELDS,
      ...E2E.NODE_DEMOD_FIELDS, ...E2E.HOP_GS_FIELDS, ...E2E.HOP_ISL_FIELDS, ...E2E.HOP_LASER_FIELDS]]
  ]
  for (const [name, fields] of all) {
    const badDef = fields.filter((f) => f.type === 'num' && validateValue(f, f.def))
    ok(`★ ${name}：出厂缺省值全部合法`, badDef.length === 0, badDef.map((f) => f.key + '=' + f.def).join(', '))
    const badRange = fields.filter((f) => (f.min != null && typeof f.min !== 'number') || (f.max != null && typeof f.max !== 'number')
      || (typeof f.min === 'number' && typeof f.max === 'number' && !(f.min < f.max)) || (f.minEx && typeof f.min !== 'number') || ((f.min != null || f.max != null) && f.type !== 'num'))
    ok(`${name}：范围自洽（数值端点、min < max、只挂在数值字段上）`, badRange.length === 0, badRange.map((f) => f.key).join(', '))
    const withRange = fields.filter((f) => f.type === 'num' && rangeText(f))
    ok(`${name}：频率 / 经纬度 / 可用度 / 口径都带范围`, ['centerFrequency', 'rxCenterFrequency', 'frequency', 'longitude', 'latitude', 'uplinkAvailability', 'availability', 'antennaDiameter']
      .filter((k) => fields.some((f) => f.key === k && f.type === 'num')).every((k) => withRange.some((f) => f.key === k)))
  }
  const fq = GEO.ALL_FIELDS.find((f) => f.key === 'centerFrequency')
  ok('GSO 上行频率填 14250 → 标红（单位 GHz）', validateValue(fq, '14250') && validateValue(fq, '14250').code === 'range')
}

// ---------- ④ 渲染端与引擎同一语法 ----------
{
  const numSrc = readFileSync(join(ROOT, 'src/shared/num.js'), 'utf8')
  const coreSrc = readFileSync(join(ROOT, 'packages/core/utils/strictNum.js'), 'utf8')
  const reOf = (src) => { const m = src.match(/NUM_RE = (\/.+\/);/) || src.match(/NUM_RE = (\/.+\/)\s*$/m); return m ? m[1] : null }
  ok('★ NUM_RE 两份逐字相同', reOf(numSrc) && reOf(numSrc) === reOf(coreSrc) && String(NUM_RE) === String(S.NUM_RE), reOf(numSrc) + ' vs ' + reOf(coreSrc))
  let seed = 4242
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pool = ['0', '-0', '.5', '5.', '1e3', '1e', '36 MHz', '12,5', '1.2.3', '－75', '１４．２５', ' 7 ', '+', '-', 'abc', '0x10', '2,048', '1_000', '5e-324', '1e400']
  const parts = ['1', '2', '0', '.', '-', '+', 'e', 'E', ' ', ',', '９', '－', 'x']
  for (let i = 0; i < 20000; i++) { let s = ''; const L = 1 + Math.floor(rnd() * 7); for (let j = 0; j < L; j++) s += parts[Math.floor(rnd() * parts.length)]; pool.push(s) }
  let bad = null
  for (const s of pool) {
    const a = numStrict(s), b = S.strictNum(s)
    if (a === null) { if (!(s.trim() === '')) { bad = s; break } continue }   // 渲染端 null ＝ 空
    const aOk = !Number.isNaN(a), bOk = Number.isFinite(b)
    if (aOk !== bOk || (aOk && !Object.is(a, b))) { bad = s; break }
  }
  ok('★ 同一批串（' + pool.length + ' 个）：两端判合法 / 非法一致，合法取值逐位相同', bad === null, bad === null ? '' : JSON.stringify(bad))
}

console.log(`\nlbValidate：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
