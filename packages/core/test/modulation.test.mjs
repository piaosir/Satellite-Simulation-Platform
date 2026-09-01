// 调制方式：族 + 星座阶数 M ⇄ 名字 ⇄ 调制因子。运行：npm test
//
// 锁定四件事：
//   ① 内置那 11 个名字的调制因子逐值不变 —— 它是符号率/载波带宽整条换算链的乘数，动一位就是算错；
//   ② 引擎侧（CJS，packages/core）与渲染侧（ESM，src/shared/carrierRate.js）两份实现【逐条同值】：
//      载波面板要在渲染端实时算，走 IPC 问因子不现实，只能各留一份，那就必须有一处对拍；
//   ③ 认不出的名字返回 null 而不是悄悄回落成 2（这正是本模块存在的理由）；
//   ④ 阶数按族收紧（APSK 从 16 起、QAM 从 4 起、只收 2 的整数次幂），且 compose/parse 互为逆。
import { createRequire } from 'module'
import * as R from '../../../src/shared/carrierRate.js'
const require = createRequire(import.meta.url)
const C = require('../utils/modulation.js')
const K = require('../utils/constants.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

/* ---- ① 内置因子逐值不变 ---- */
const BUILTIN = { BPSK: 1, QPSK: 2, '8PSK': 3, '8QAM': 3, '16QAM': 4, '16APSK': 4, '32APSK': 5, '64QAM': 6, '64APSK': 6, '128APSK': 7, '256APSK': 8 }
ok('内置调制因子表逐值不变（constants.js）',
  Object.keys(BUILTIN).every((k) => K.MODULATION_FACTORS[k] === BUILTIN[k]) &&
  Object.keys(K.MODULATION_FACTORS).length === Object.keys(BUILTIN).length)
ok('内置 11 项经 modFactorOf 取值不变', Object.keys(BUILTIN).every((k) => C.modFactorOf(k) === BUILTIN[k]))
ok('内置 11 项 compose(parse(x)) 原样回来（表里的写法就是规范写法）',
  Object.keys(BUILTIN).every((k) => { const p = C.parseModulation(k); return p && C.composeModulation(p.family, p.order) === k }))

/* ---- ② 两份实现对拍 ---- */
const NAMES = Object.keys(BUILTIN).concat([
  'qpsk', '16apsk', ' 64QAM ', '1024QAM', '512APSK', '32PSK', '4QAM',
  '8APSK', '2QAM', '6PSK', '3QAM', '0PSK', '8192QAM', 'QAM', '16', 'ABC', '', null, undefined
])
const mismatch = NAMES.filter((n) => {
  const a = C.modFactorOf(n), b = R.modFactorOf(n)
  if (a !== b) return true
  const pa = JSON.stringify(C.parseModulation(n)), pb = JSON.stringify(R.parseModulation(n))
  return pa !== pb
})
ok('引擎侧与渲染侧 modFactorOf / parseModulation 逐条同值', mismatch.length === 0, mismatch.join(','))
const composeCases = []
for (const f of ['psk', 'apsk', 'qam']) for (const m of [2, 4, 8, 16, 32, 64, 128, 256, 1024, 2048, 4096, 6, 0, -4, 1.5]) composeCases.push([f, m])
const cMis = composeCases.filter(([f, m]) => C.composeModulation(f, m) !== R.composeModulation(f, m))
ok('两份 composeModulation 逐条同值', cMis.length === 0, cMis.map((x) => x.join(':')).join(','))
ok('两份 ordersOf 逐族同值', ['psk', 'apsk', 'qam'].every((f) => C.ordersOf(f).join(',') === R.ordersOf(f).join(',')))

/* ---- ③ 认不出就是认不出 ---- */
for (const bad of ['6PSK', '3QAM', '0PSK', 'ABC', '16', 'QAM', '', '   ', null, undefined, 'QPSK2']) {
  ok(`「${bad}」不是调制方式（返回 null，不回落成 2）`, C.modFactorOf(bad) === null && R.modFactorOf(bad) === null)
}
ok('isKnownModulation 与 modFactorOf 同口径',
  NAMES.every((n) => C.isKnownModulation(n) === (C.modFactorOf(n) != null)))

/* ---- ④ 阶数按族收紧 + compose/parse 互逆 ---- */
ok('APSK 从 16 起：8APSK 不认', C.modFactorOf('8APSK') === null && C.composeModulation('apsk', 8) === '')
ok('QAM 从 4 起：2QAM 不认', C.modFactorOf('2QAM') === null && C.composeModulation('qam', 2) === '')
ok('只收 2 的整数次幂', [6, 12, 100, 3, 0, -4, 1.5, '4a'].every((m) => !C.isValidOrder(m)) && [2, 4, 8, 4096].every((m) => C.isValidOrder(m)))
ok('阶数上限 4096（12 bit/符号）', C.isValidOrder(4096) && !C.isValidOrder(8192))
ok('M-PSK 的 2 / 4 出行业写法 BPSK / QPSK', C.composeModulation('psk', 2) === 'BPSK' && C.composeModulation('psk', 4) === 'QPSK')
ok('compose → parse → compose 恒等（全族全阶数）', (() => {
  for (const f of ['psk', 'apsk', 'qam']) for (const m of C.ordersOf(f)) {
    const n = C.composeModulation(f, m)
    const p = C.parseModulation(n)
    if (!n || !p || p.family !== f || p.order !== m || C.composeModulation(p.family, p.order) !== n) return false
    if (p.factor !== Math.round(Math.log2(m))) return false
  }
  return true
})())
ok('大小写与首尾空白都认，且吐规范写法',
  C.composeModulation(...(() => { const p = C.parseModulation(' 16apsk '); return [p.family, p.order] })()) === '16APSK')

/* ---- ⑤ 下拉选项 ---- */
const opts = C.modulationOptions(['1024QAM', 'QPSK', '乱写'])
ok('选项表：内置 11 项在前、能解析的 extra 补在后、认不出的丢掉、不重复',
  opts.length === 12 && opts[0].value === 'BPSK' && opts[11].value === '1024QAM' &&
  new Set(opts.map((o) => o.value)).size === opts.length, opts.map((o) => o.value).join(' '))
ok('每项都带 family / order / factor', opts.every((o) => o.family && o.order > 0 && o.factor > 0))
ok('两份 modulationOptions 同值',
  JSON.stringify(opts) === JSON.stringify(R.modulationOptions(['1024QAM', 'QPSK', '乱写'])))

/* ---- ⑥ 换算链跟着走（渲染端 rateFactors）---- */
ok('自定义档 1024QAM 进换算链 = 10 bit/符号（不是回落的 2）',
  R.rateFactors({ modulation: '1024QAM' }).mf === 10)
ok('认不出的名字仍按老口径回落 2（行为与改动前逐位相同）',
  R.rateFactors({ modulation: '乱写' }).mf === 2 && R.rateFactors({}).mf === 2)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
