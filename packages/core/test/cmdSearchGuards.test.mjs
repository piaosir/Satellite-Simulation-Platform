// 顶部命令搜索的加固（src/stores/commands.js + src/stores/log.js 的诊断开关）：
//   ① 登记方抛错不连累其余，且不再静默——console.warn 一次 + 诊断日志一条
//   ② 同一个登记方重新挂上后，下一轮再抛错要能再报一次
//   ③ 诊断开关默认关，关着时一条都不写
// 运行：npm test
import assert from 'node:assert'

// localStorage：Node 里没有，log.js 读它时自己 try/catch 了；这里补一个内存版，好测「开关记住了」
const mem = new Map()
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }

const { registerCommands, commands, clearCommandWarn } = await import('../../../src/stores/commands.js')
const { logStore, clearLog, diag, setDiag, diagMsg } = await import('../../../src/stores/log.js')

let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }

// console.warn 拦一份
const warns = []
const realWarn = console.warn
console.warn = (...a) => { warns.push(a.map((x) => String(x && x.message ? x.message : x)).join(' ')) }

// ---- ① 抛错的登记方不连累其余 ----
const offGood = registerCommands('good', () => [{ id: 'a', label: '正常命令' }])
const offBad = registerCommands('bad', () => { throw new Error('回调为 null') })
const offNull = registerCommands('nul', null)
{
  const list = commands.value
  ok(list.length === 1 && list[0].id === 'a', `抛错的那家缺席，其余照常（${list.length} 条）`)
  ok(warns.length === 1 && warns[0].includes('bad') && warns[0].includes('回调为 null'), `console.warn 报了一次并指名道姓（${warns.length} 条）`)
}

// 让 computed 重算：登记表是 reactive Map，挂个哨兵进去即可作废缓存（不碰 Vue 内部字段）
const reeval = () => { const off = registerCommands('probe-' + Math.random(), () => []); const v = commands.value; off(); return v }

// ---- 同一个 key 只报一次（computed 每次取用都会跑）----
{
  const n0 = warns.length
  for (let i = 0; i < 5; i++) reeval()
  ok(warns.length === n0, `重复取用不再刷屏（仍是 ${warns.length} 条）`)
}

// ---- ② 重新登记 → 闸清零，下一轮再抛能再报 ----
{
  const n0 = warns.length
  registerCommands('bad', () => { throw new Error('又错了') })
  reeval()
  ok(warns.length === n0 + 1 && warns[warns.length - 1].includes('又错了'), '重新登记后能再报一次')
  clearCommandWarn('bad')
  reeval()
  ok(warns.length === n0 + 2, 'clearCommandWarn 之后再抛又能报一次')
}

// ---- ③ 诊断开关 ----
{
  clearLog()
  ok(diag.on === false, '诊断出厂关')
  diagMsg('不该出现')
  ok(logStore.items.length === 0, '关着时一条都不写')
  setDiag(true)
  diagMsg('下拉收起')
  ok(logStore.items.length === 1 && logStore.items[0].text === '[搜索] 下拉收起', '打开后写进日志窗格并带前缀')
  ok(mem.get('search-diag-v1') === '1', '开关落本地记忆')
  setDiag(false)
  diagMsg('又不该出现')
  ok(logStore.items.length === 1, '关掉后又不写了')
  ok(mem.get('search-diag-v1') === '0', '关掉也记住')
}

offGood(); offBad(); offNull()
console.warn = realWarn
console.log(`cmdSearchGuards.test.mjs：${pass} 条断言全绿`)
