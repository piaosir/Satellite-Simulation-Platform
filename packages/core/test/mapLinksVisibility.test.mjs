import assert from 'node:assert/strict'
import { ref } from 'vue'
import { useMapLinks, restoreLinkStyle, LINK_STYLE_DEF } from '../../../src/viz/links/useMapLinks.js'
import { hopGeom } from '../../../src/viz/links/linkGeom.js'
import { geodeticToEcef } from '../../../src/viz/wgs84.js'

let failures = 0, passes = 0
const check = (name, fn) => { try { fn(); passes++; console.log('PASS ' + name) } catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message) } }
function fixture() {
  let L, seq = 0, last
  const commits = [], links = ref([])
  const hiddenSatellites = new Set()
  const host = {
    links, stations: ref([{ id: 'a', lat: 10, lon: 110 }, { id: 'b', lat: 20, lon: 115 }]), points: ref([]),
    polygons: ref([{ id: 'p', pts: [[105, 10], [110, 10], [110, 15], [105, 15]] }]), trajectories: ref([]),
    newId: () => 'L' + (++seq), satEcefAt: (key) => geodeticToEcef(key === 's2' ? 120 : 110, 0, 35786), satInfo: () => null,
    satHidden: (key) => hiddenSatellites.has(key),
    commit: () => { if (L) { last = L.compute(0); commits.push(last) } }, status: () => {}
  }
  L = useMapLinks(host)
  const create = (first = { k: 'st', id: 'a' }) => { const id = L.startNew(first); L.addNode({ k: 'sat', key: 's' }); L.addNode({ k: 'st', id: 'b' }); L.finish(); return id }
  const preview = (id) => { L.preview.value = { id, at: 2, node: { k: 'sat', key: 's2' } } }
  const absent = (r, id) => ['scene', 'flat'].every((kind) => !r[kind].some((x) => x.id === id || x.id === id + ':pv'))
  return { L, links, create, preview, absent, commits, hiddenSatellites, last: () => last }
}

check('旧场景迁移样式仍按原门限判断 3° 地星跳', () => {
  const ground = { ground: true, lon: 0, lat: 0, ecef: geodeticToEcef(0, 0, 0) }
  const elevation = 3 * Math.PI / 180
  const sat = { ecef: [ground.ecef[0] + 4000*Math.sin(elevation), 4000*Math.cos(elevation), 0] }
  for (const minEl of [undefined, 0, 2, 7]) {
    const style = { ...LINK_STYLE_DEF }
    restoreLinkStyle(style, { rev: 2, width: 1.2, minEl, blocked: 'dash', dir: 'static' })
    assert.equal(style.minEl, minEl ?? 0)
    assert.equal(hopGeom(ground, sat, style.minEl).vis, (minEl ?? 0) <= 3)
    const snapshot = { ...style }
    restoreLinkStyle(style, snapshot)
    assert.deepEqual(style, snapshot)
  }
})

check('第一次隐藏同时清除正式链路和候选预览，提交给两个渲染器的首帧即为空', () => {
  const f = fixture(), id = f.create(); f.preview(id)
  assert(f.L.compute(0).flat.some((l) => l.id === id + ':pv'))
  f.L.toggleShow(id)
  assert.equal(f.L.linkOf(id).show, false)
  assert(f.absent(f.last(), id), '首次隐藏仍有绘制残留')
  assert.equal(f.L.preview.value, null)
  assert.equal(f.links.value.length, 1, '隐藏不能删除数据')
})
check('隐藏链路关闭代表点编辑器及候选点层', () => {
  const f = fixture(), id = f.create(f.L.areaNode('pg', 'p'))
  f.L.openPick(id, 0); f.L.compute(0)
  assert(f.L.pickEd.value)
  f.L.toggleShow(id)
  assert.equal(f.L.pickEd.value, null)
  assert(f.absent(f.last(), id))
})
check('正在编辑的链路隐藏一次即可收尾，不再由插入光标继续绘制', () => {
  const f = fixture(), id = f.create(); f.L.startAt(id); f.preview(id)
  f.L.toggleShow(id)
  assert.equal(f.L.draw.value, null)
  assert(f.absent(f.last(), id))
  assert.equal(f.L.linkOf(id).nodes.length, 3)
})
check('隐藏后迟到的选择器悬停事件不能重新画出预览', () => {
  const f = fixture(), id = f.create(); f.L.toggleShow(id); f.preview(id)
  f.L.openPick(id, 0)
  assert(f.absent(f.L.compute(0), id))
  f.L.toggleShow(id)
  assert.equal(f.L.preview.value, null)
  assert.equal(f.L.pickEd.value, null)
  assert(!f.last().flat.some((l) => l.id === id + ':pv'), '恢复显示不带回旧预览')
})
check('隐藏所有链路同时清理预览和代表点编辑器', () => {
  const f = fixture(), a = f.create(f.L.areaNode('pg', 'p')), b = f.create()
  f.preview(b); f.L.openPick(a, 0); f.L.hideAll()
  assert.equal(f.L.preview.value, null); assert.equal(f.L.pickEd.value, null)
  assert(f.absent(f.last(), a) && f.absent(f.last(), b))
})
check('完成建链时先清预览再提交，暂停状态不留多余线段', () => {
  const f = fixture(), id = f.create(); f.L.startAt(id); f.preview(id); f.L.finish()
  assert.equal(f.L.preview.value, null)
  assert(!f.last().scene.some((l) => l.id === id + ':pv'))
})
check('取消编辑时先清预览再提交', () => {
  const f = fixture(), id = f.create(); f.L.startAt(id); f.preview(id); f.L.cancel()
  assert.equal(f.L.preview.value, null)
  assert(!f.last().flat.some((l) => l.id === id + ':pv'))
})
check('显式隐藏可重复调用，不会反向切回显示，也不影响另一条链路的预览', () => {
  const f = fixture(), a = f.create(), b = f.create(); f.preview(b)
  assert.equal(typeof f.L.setShow, 'function')
  f.L.setShow(a, false); f.L.setShow(a, false)
  assert.equal(f.L.linkOf(a).show, false)
  assert.equal(f.L.preview.value.id, b)
  assert(f.last().flat.some((l) => l.id === b + ':pv'))
  f.L.setShow(a, true)
  assert(f.last().flat.some((l) => l.id === a))
})
check('地图隐藏卫星同时清掉两种视图的正式端点，保留链路与读数，恢复后立即重现', () => {
  const f = fixture(), id = f.create()
  const before = f.L.compute(0)
  f.hiddenSatellites.add('s')
  const hidden = f.L.compute(0)
  for (const kind of ['scene', 'flat']) {
    const original = before[kind].find((l) => l.id === id), current = hidden[kind].find((l) => l.id === id)
    assert.equal(original.sats.length, 1)
    assert.equal(current.sats.length, 0, kind + ' 残留隐藏卫星端点')
    assert.deepEqual(current.hops, original.hops, '隐藏标记不改链路几何')
  }
  assert(f.L.read.value.has(id), '隐藏标记不清读数')
  assert.equal(f.L.linkOf(id).nodes.length, 3, '隐藏标记不删节点')
  f.hiddenSatellites.delete('s')
  for (const kind of ['scene', 'flat']) assert.equal(f.L.compute(0)[kind].find((l) => l.id === id).sats.length, 1)
})
check('迟到的候选预览不重新画出隐藏卫星，其他候选和预览连线照常显示', () => {
  const f = fixture(), id = f.create(); f.preview(id)
  f.hiddenSatellites.add('s2')
  const result = f.L.compute(0)
  for (const kind of ['scene', 'flat']) {
    const preview = result[kind].find((l) => l.id === id + ':pv')
    assert(preview.hops.length > 0)
    assert.equal(preview.sats.length, 0)
    assert.equal(result[kind].find((l) => l.id === id).sats.length, 1, '不能隐藏其他卫星')
  }
})
console.log(`mapLinksVisibility: ${passes} passed, ${failures} failed`)
process.exitCode = failures ? 1 : 0
