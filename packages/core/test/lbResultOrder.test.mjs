// 结果列显示顺序（src/shared/lbResultOrder.js，渲染端 ESM）自测：顺序表归一、换位、拖动手柄的中线判据。运行：npm test
import { normalizeOrder, moveKey, makeDragOrder } from '../../../src/shared/lbResultOrder.js'

let pass = 0, fail = 0
const ok = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? `  (${extra})` : '')); cond ? pass++ : fail++ }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const DEFS = ['a', 'b', 'c', 'd'].map((k) => ({ key: k }))

// —— 顺序表归一 ——
ok('空 / 非数组 → 声明序', eq(normalizeOrder(null, DEFS), ['a', 'b', 'c', 'd']) && eq(normalizeOrder('x', DEFS), ['a', 'b', 'c', 'd']))
ok('已存顺序优先、新键补末尾、未知键剔除、重复键去重', eq(normalizeOrder(['c', 'zzz', 'a', 'c'], DEFS), ['c', 'a', 'b', 'd']))
ok('声明表为空 → 空序', eq(normalizeOrder(['a'], []), []))

// —— 换位 ——
ok('moveKey 向后：落在目标之后', eq(moveKey(['a', 'b', 'c', 'd'], 'a', 2), ['b', 'c', 'a', 'd']))
ok('moveKey 向前：落在目标之前', eq(moveKey(['a', 'b', 'c', 'd'], 'd', 1), ['a', 'd', 'b', 'c']))
ok('moveKey 未知键不动', eq(moveKey(['a', 'b'], 'x', 0), ['a', 'b']))
ok('moveKey 越界夹取', eq(moveKey(['a', 'b', 'c'], 'a', 99), ['b', 'c', 'a']) && eq(moveKey(['a', 'b', 'c'], 'c', -5), ['c', 'a', 'b']))
const src = ['a', 'b']; moveKey(src, 'a', 1)
ok('moveKey 不改原数组', eq(src, ['a', 'b']))

// —— 拖动手柄：中线判据（无 DOM，桩掉 window / document）——
globalThis.window = { addEventListener() {}, removeEventListener() {} }
globalThis.document = { body: { style: {} } }
let order = ['a', 'b', 'c', 'd']
let ended = 0
const st = { key: '' }
const h = makeDragOrder({ state: st, getOrder: () => order, setOrder: (v) => { order = v }, onEnd: () => { ended++ } })
const ev = (y, top = 0, height = 20) => ({ clientY: y, currentTarget: { getBoundingClientRect: () => ({ top, height }) } })
h.start({ button: 0, preventDefault() {} }, 'a')
ok('按下记住 key', st.key === 'a')
h.over(ev(5), 'b')
ok('向下拖、未过目标中线：不换位', eq(order, ['a', 'b', 'c', 'd']))
h.over(ev(15), 'b')
ok('向下拖、过了目标中线：换到目标之后', eq(order, ['b', 'a', 'c', 'd']))
h.over(ev(15), 'd')
ok('继续向下过 d 的中线：落到末尾', eq(order, ['b', 'c', 'd', 'a']))
h.over(ev(15), 'b')
ok('向上拖、还在目标下半：不换位', eq(order, ['b', 'c', 'd', 'a']))
h.over(ev(5), 'b')
ok('向上拖、到了目标中线上方：换到目标之前', eq(order, ['a', 'b', 'c', 'd']))
h.over(ev(5), 'a')
ok('落在自己身上：不动', eq(order, ['a', 'b', 'c', 'd']))
h.end()
ok('松开清 key 并回调 onEnd', st.key === '' && ended === 1)
h.end()
ok('重复 end 不再回调', ended === 1)
h.over(ev(15), 'b')
ok('未按下时移动：不动', eq(order, ['a', 'b', 'c', 'd']))
h.start({ button: 2, preventDefault() {} }, 'a')
ok('非左键不启动', st.key === '')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
