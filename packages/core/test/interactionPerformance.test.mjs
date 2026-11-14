import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'acorn'
import { computed, ref } from 'vue'
import { pickCoverageLayer, pickLinkGeometry } from '../../../src/shared/mapObjectPick.js'
import { createBudgetWaterfallLoader } from '../../../src/shared/budgetWaterfallLoader.js'

// 无覆盖图层或无等值线线段时，悬停不应白跑地球射线求交或四邻域反解。
let lonLatCalls = 0, screenCalls = 0
const countedView = {
  lonLatAt: (x, y) => { lonLatCalls++; return { lon: x / 10, lat: y / 10 } },
  screenOfLL: (lat, lon) => { screenCalls++; return { x: lon * 10, y: lat * 10 } },
  pickWidth: 3600
}
assert.equal(pickCoverageLayer([], countedView, 10, 10), null)
assert.equal(lonLatCalls, 0, '空覆盖层列表不做地球射线拾取')
assert.equal(pickLinkGeometry([], countedView, false, 10, 10), null)
assert.equal(screenCalls, 0, '空链路层列表不做屏幕投影')
pickCoverageLayer([{ layer: { bore: { lat: 0, lon: 0 }, segGroups: [] }, options: { showBore: true } }], countedView, 0, 0)
assert.equal(lonLatCalls, 1, '无等值线线段时不额外求交四邻域')

// 用实际读取量约束悬停复杂度，避免依赖机器速度的毫秒阈值。
let reads = 0
const segs = new Proxy(Array.from({ length: 100000 }, (_, i) => {
  const x = -160 + (i % 100) / 100, y = -70 + Math.floor(i / 100) / 1000
  return [[x, y], [x + .001, y + .001]]
}), { get(target, key) { if (/^\d+$/.test(String(key))) reads++; return Reflect.get(target, key) } })
const view = { lonLatAt: (x, y) => ({ lon: x / 10, lat: y / 10 }), screenOfLL: (lat, lon) => ({ x: lon * 10, y: lat * 10 }), pickWidth: 3600 }
const far = { layer: { segGroups: [{ segs }] } }
pickCoverageLayer([far], view, 0, 0)
reads = 0
for (let i = 0; i < 25; i++) assert.equal(pickCoverageLayer([far], view, i, 0), null)
assert.equal(reads, 0, '缓存热身后，远处十万线段不再被逐条读取')
const near = { layer: { segGroups: [{ segs: [[[0, 0], [10, 0]]] }] } }
assert.equal(pickCoverageLayer([far, near], view, 50, 1), near)
const date = { layer: { segGroups: [{ segs: [[[179, 0], [-179, 0]]] }] } }
const dateView = { ...view, screenOfLL: (lat, lon) => ({ x: (lon < 0 ? lon + 360 : lon) * 10, y: lat * 10 }) }
assert.equal(pickCoverageLayer([date], dateView, 1800, 1), date, '空间预筛仍保留跨日期线的线段')
near.layer.segGroups[0].segs = [[[20, 0], [30, 0]]]
assert.equal(pickCoverageLayer([near], view, 50, 1), null, '替换几何后不复用旧包围盒')
assert.equal(pickCoverageLayer([near], view, 250, 1), near)

// 三个窗口的实际索引：一次构建后按行取值不再扫描全部预算，重算 / 删除后自动作废。
for (const path of ['linkbudget/LinkBudgetApp.vue', 'ngso/NgsoLinkBudgetApp.vue', 'regen/RegenLinkBudgetApp.vue']) {
  const src = readFileSync(new URL('../../../src/' + path, import.meta.url), 'utf8').split('<script setup>')[1].split('</script>')[0]
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' })
  const decl = ast.body.filter((n) => n.type === 'VariableDeclaration').flatMap((n) => n.declarations).find((n) => n.id.name === 'readoutLinksById')
  const links = ref(Array.from({ length: 1000 }, (_, i) => ({ rowId: String(i), data: i })))
  const index = new Function('computed', 'links', `return ${src.slice(decl.init.start, decl.init.end)}`)(computed, links)
  for (const link of links.value) assert.equal(index.value.get(link.rowId), link)
  const cached = index.value
  assert.equal(index.value, cached)
  links.value = [{ rowId: '0', data: 'new result' }]
  assert.notEqual(index.value, cached)
  assert.equal(index.value.get('0').data, 'new result')
  assert.equal(index.value.has('999'), false)
}

const pending = [], calls = [], received = []
let active = 0, peak = 0
const loader = createBudgetWaterfallLoader((data, options) => {
  calls.push({ data, options }); active++; peak = Math.max(peak, active)
  return new Promise((resolve, reject) => pending.push({
    resolve: (v) => { active--; resolve(v) }, reject: (e) => { active--; reject(e) }
  }))
})
const rows = ['a', 'b', 'c', 'd'].map((id) => ({ rowId: id, data: { id } }))
const opts = { lang: 'zh', orbitType: 'GSO', adaptUnits: false }
const flush = () => new Promise((resolve) => setImmediate(resolve))
const receive = (i, result) => received.push({ i, ...result })
loader.update(rows, opts, receive)
await flush()
assert.equal(calls.length, 2, '全选只允许两个在途 IPC')
loader.update(rows.slice(0, 2), opts, receive)
pending[0].resolve(['A']); pending[1].resolve(['B'])
await flush()
assert.equal(calls.length, 2, '已经取消的选区不再生成其余行')
assert.equal(received.length, 2, '旧选区回调不更新新选区')
loader.update(rows.slice(0, 3), opts, receive)
await flush()
assert.equal(calls.length, 3, '两行扩大到三行，只请求新增的一行')
assert.equal(received.filter((r) => !r.err).length, 4, '已完成的两行立即从缓存恢复')
pending[2].resolve(['C']); await flush()
loader.update(rows.slice(0, 3), { ...opts, lang: 'en' }, receive)
await flush()
assert.equal(calls.length, 5, '换语言不复用旧语言结果，仍遵守并发上限')
pending[3].resolve(['A-en']); pending[4].resolve(['B-en']); await flush()
assert.equal(calls.length, 6)
pending[5].reject(new Error('retry')); await flush()
assert(received.some((r) => r.err === 'retry'))
loader.update([rows[2]], { ...opts, lang: 'en' }, receive); await flush()
assert.equal(calls.length, 7, '失败请求可以重试')
pending[6].resolve(['C-en']); await flush()
loader.update([{ ...rows[0], data: { id: 'a', recomputed: true } }], opts, receive); await flush()
assert.equal(calls.length, 8, '重算生成的新结果对象不能命中旧缓存')
const count = received.length
loader.dispose(); pending[7].resolve(['new-A']); await flush()
assert.equal(received.length, count, '卸载后在途请求不能回写')
assert.equal(peak, 2)
console.log('interactionPerformance: contour pruning, waterfall reuse, concurrency, stale selection, retry and cleanup passed')
