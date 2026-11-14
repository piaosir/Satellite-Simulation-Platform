import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'acorn'
import { pickCoverageLayer, pickLinkGeometry } from '../../../src/shared/mapObjectPick.js'
import { buildBeamLayers } from '../../../src/viz/beammap/layers.js'

const view = { lonLatAt: (x, y) => ({ lon: x / 10, lat: y / 10 }), screenOfLL: (lat, lon) => ({ x: lon * 10, y: lat * 10 }), pickWidth: 3600 }
const entry = (layer, options = {}) => ({ layer, options })
const beam = { name: 'A', satLon: 0, contours: [{ g: 10, p: [[0, 0], [10, 0], [10, 10], [0, 10]] }] }
const style = { levels: [{ key: '10', v: 10, color: '#fff' }], line: true, fill: false, lineAlpha: 1 }
const layer = (b = beam, s = style) => buildBeamLayers(b, s, {}, 'a')[0]
const line = entry(layer())
assert.equal(pickCoverageLayer([line], view, 50, 1), line, '可见线可命中')
assert.equal(pickCoverageLayer([line], view, 50, 50), null, '未填色内部不抢点击')
assert.equal(pickCoverageLayer([line], view, 50, -9), null, '容差之外不命中')
const fill = entry(layer(beam, { ...style, fill: true, line: false }))
assert.equal(pickCoverageLayer([fill], view, 50, 50), fill, '填色内部可命中')
assert.equal(pickCoverageLayer([fill, line], view, 50, 1), line, '明确线条优先于面')
const top = entry(layer(beam, { ...style, fill: true, line: false }))
assert.equal(pickCoverageLayer([fill, top], view, 50, 50), top, '重叠填色选择最上层')
assert.equal(pickCoverageLayer([entry({ ...fill.layer, alpha: 0 })], view, 50, 50), null, '透明填色不拾取')
assert.equal(pickCoverageLayer([entry(layer(beam, { ...style, lineAlpha: 0 }))], view, 50, 1), null, '透明线不拾取')
const hole = { ...beam, contours: [...beam.contours, { g: 10, p: [[4, 4], [6, 4], [6, 6], [4, 6]] }] }
assert.equal(pickCoverageLayer([entry(layer(hole, { ...style, fill: true, line: false }))], view, 50, 50), null, '填色洞不拾取')
const dateline = entry(layer({ ...beam, satLon: 180, contours: [{ g: 10, p: [[179, 0], [-179, 0], [-179, 10], [179, 10]] }] }, { ...style, fill: true, line: false }))
assert.equal(pickCoverageLayer([dateline], view, -1795, 50), dateline, '跨日期变更线填色正常拾取')
assert.equal(pickCoverageLayer([dateline], view, 0, 50), null, '跨日期线不横扫全图')
assert.equal(pickCoverageLayer([fill], { ...view, lonLatAt: () => null }, 50, 50), null, '地球外不命中')
assert.equal(pickCoverageLayer([line], { ...view, screenOfLL: () => null }, 50, 1), null, '背面线不命中')

const mesh = { NX: 2, NY: 2, stride: 1, lonU: [0, 10, 0, 10], lat: [0, 0, 10, 10], db: [20, 20, 20, 20], vis: [1, 1, 1, 1], levels: [10], alphas: [1] }
const gpu = entry({ fieldMesh: mesh, alpha: 1 })
assert.equal(pickCoverageLayer([gpu], view, 50, 50), gpu, 'GPU 填充可拾取')
assert.equal(pickCoverageLayer([gpu], view, 110, 50), null, '网格之外不命中')
assert.equal(pickCoverageLayer([entry({ fieldMesh: { ...mesh, levels: [30] } })], view, 50, 50), null, '低于可见电平不命中')
assert.equal(pickCoverageLayer([entry({ fieldMesh: { ...mesh, alphas: [0] } })], view, 50, 50), null, 'GPU 透明档不拾取')
assert.equal(pickCoverageLayer([entry({ fieldMesh: { ...mesh, satN: [-2, 0, 0] } })], view, 50, 50), null, 'GPU 地平背面不拾取')
assert.equal(pickLinkGeometry([{ id: 'link', hops: [{ pts: [[0, 0], [10, 0]] }] }], view, true, 50, 3), 'link')
assert.equal(pickLinkGeometry([{ id: 'link', hops: [{ a: { lat: 0, lon: 0, altKm: 1 }, b: { lat: 0, lon: 10, altKm: 1 } }] }], view, false, 50, 3), 'link')
assert.equal(pickLinkGeometry([{ id: 'link', hops: [{ pts: [[0, 0], [10, 0]] }] }], view, true, 50, 10), null)

// 执行真实页面的跳转函数，以替身记录侧栏、选中、展开和滚动；不依赖源码字符串断言行为。
const src = readFileSync(new URL('../../../src/pages/ConstellationMap3D.vue', import.meta.url), 'utf8').split('<script setup>')[1].split('</script>')[0]
const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' })
function productionFunction(name, deps) {
  const n = ast.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === name)
  return new Function(...Object.keys(deps), `let objectSettingsSeq = 0; return (${src.slice(n.start, n.end)})`)(...Object.values(deps))
}
const calls = [], shellUi = { side: '' }, ref = (value) => ({ value })
let allowed = true
const batch = { id: 'batch', beams: ['Ku|A:1'], q: '旧搜索' }, item = { id: 'sat', batches: [batch] }
const deps = {
  mkGroupOf: (k) => ({ point: 'points', station: 'stations', traj: 'traj' }[k]),
  mkObj: () => ({ id: 'p' }), mkNameOf: () => ({ name: '点1' }),
  requestSide: (side) => { if (!allowed) return false; shellUi.side = side; return true },
  selectMapObj: (o) => calls.push(['select', o.id]), mkQ: ref('旧搜索'),
  setSecOpen: (...a) => calls.push(['expand', ...a]), mkSelect: (o) => calls.push(['marker', o.id]),
  revealEl: async (...a) => calls.push(['reveal', ...a]), revealMapObj: async (o) => calls.push(['poly', o.id]),
  polys: ref([{ id: 'poly' }]), bm: { items: ref([item]) }, CSS: { escape: (x) => x },
  links: ref([{ id: 'link' }]), lnk: { selId: ref('') }, pushLinks: () => {},
  grdSats: ref([{ folder: 's', antennas: [{ name: 'ant' }] }]), shellUi,
  grd: { ensureAntLoaded: async () => true, setActive: async (...a) => calls.push(['active', ...a]) },
  satcov: { setActive: async (...a) => calls.push(['shellActive', ...a]) },
  revealSection: async (...a) => calls.push(['section', ...a]), reportError: (m, e) => { throw e }
}
const open = productionFunction('openMapObjectSettings', deps)
await open({ kind: 'point', id: 'p' })
assert.equal(shellUi.side, 'markers'); assert.equal(deps.mkQ.value, '')
assert(calls.some((c) => c[0] === 'reveal' && c[3] === '.mki'), '标记滚到属性检查器')
await open({ kind: 'poly', id: 'poly' }); assert.equal(shellUi.side, 'poly')
await open({ kind: 'link', id: 'link' }); assert.equal(shellUi.side, 'links'); assert.equal(deps.lnk.selId.value, 'link')
await open({ kind: 'coverage', id: 'c', itemId: 'sat', batchId: 'batch', beamId: 'Ku|A:1' })
assert.equal(shellUi.side, 'gxt'); assert.equal(batch.q, '')
assert.deepEqual(batch.beams, ['Ku|A:1'], '打开设置不改变显示勾选')
await open({ kind: 'coverage', id: 's|ant#0', antKey: 's|ant', folder: 's', ant: 'ant', side: 'antenna' })
assert.equal(shellUi.side, 'antenna'); assert.equal(calls.find((c) => c[0] === 'active')[3].face, false, '打开天线不转镜头')
assert(calls.some((c) => c[0] === 'section' && c[2] === 'grd-set'), '展开天线设置')
const n = calls.length; allowed = false
await open({ kind: 'poly', id: 'poly' }); assert.equal(calls.length, n, '入口受锁时不改选中')
allowed = true
await open({ kind: 'coverage', id: 'gone', itemId: 'sat', batchId: 'gone', beamId: 'gone' }); assert.equal(calls.length, n, '已删除对象不跳转')

// 数据加载中选择另一个对象，旧跳转不能再抢回设置。
let release
deps.grd.ensureAntLoaded = () => new Promise((r) => { release = r })
const pending = open({ kind: 'coverage', id: 's|ant#0', antKey: 's|ant', folder: 's', ant: 'ant', side: 'antenna' })
await open({ kind: 'point', id: 'p' }); release(true); await pending
assert.equal(shellUi.side, 'markers')
assert.equal(calls.filter((c) => c[0] === 'active').length, 1, '旧异步跳转作废')
const target = { kind: 'poly', id: 'poly' }, ctxObject = ref(target)
const contextSettings = productionFunction('ctxObjectSettings', { ctxObject, closeCtx: () => { ctxObject.value = null; calls.push(['close']) }, openMapObjectSettings: (o) => calls.push(['settings', o]) })
contextSettings(); assert.deepEqual(calls.slice(-2), [['close'], ['settings', target]], '菜单关闭后仍跳转到右键的具体对象')

// 统一隐藏不删除对象，不因重复操作又把它显示回来。
const context = ref(null), point = { id: 'p', show: true }, poly = { id: 'pg', show: true }, link = { id: 'lk', show: true }
const ground = { selected: ref(['s|ant', 'other']), recompute: () => calls.push(['ground']) }
const shell = { selected: ref(['s|ant', 'other']), recompute: () => calls.push(['shell']) }
const hidden = new Set(), selectedSats = [{ noradId: '1', name: 'One' }, { noradId: '2', name: 'Two' }]
const hideDeps = {
  ctxObject: context, closeCtx: () => { context.value = null },
  satEntryById: (id) => id === 'n:1' ? { noradId: '1', name: 'One' } : null,
  setMapSatelliteHidden: (id, on) => on ? hidden.add(id) : hidden.delete(id), selEntries: selectedSats,
  satIdOf: (e) => 'n:' + e.noradId, removeSel: ({ idx }) => selectedSats.splice(idx, 1), refreshHiddenSatellites: () => {},
  showStatus: (...a) => calls.push(['status', ...a]), byLang: (s) => s,
  polys: ref([poly]), togglePoly: (o) => { o.show = false }, mkGroupOf: deps.mkGroupOf,
  entObjOf: () => point, mkShown: (o) => o.show !== false, toggleMkItem: (o) => { o.show = false },
  bm: { ...deps.bm, toggleBeam: (_it, ba, id) => { ba.beams = ba.beams.filter((b) => b !== id) } },
  satcov: shell, grd: ground, saveSettings: () => {}, links: ref([link]), lnk: { setShow: (_id, on) => { link.show = on } },
  onStageLeave: () => {}, clearMapSel: () => {}
}
const hide = productionFunction('ctxHideObject', hideDeps)
for (const object of [{ kind: 'point', id: 'p' }, { kind: 'traj', id: 'p' }, { kind: 'poly', id: 'pg' }, { kind: 'link', id: 'lk' }]) {
  context.value = object; await hide()
}
assert.equal(point.show, false); assert.equal(poly.show, false); assert.equal(link.show, false)
assert.equal(hideDeps.polys.value.length, 1); assert.equal(hideDeps.links.value.length, 1)
context.value = { kind: 'coverage', itemId: 'sat', batchId: 'batch', beamId: 'Ku|A:1' }; await hide()
assert.deepEqual(batch.beams, []); assert.equal(item.batches.length, 1, '隐藏波束保留批次与参数')
for (const side of ['antenna', 'satcov']) { context.value = { kind: 'coverage', antKey: 's|ant', side }; await hide() }
assert.deepEqual(ground.selected.value, ['other']); assert.deepEqual(shell.selected.value, ['other'])
context.value = { kind: 'sat', id: 'n:1' }; await hide()
assert(hidden.has('n:1')); assert.deepEqual(selectedSats.map((s) => s.noradId), ['2'], '只移出被隐藏卫星的聚焦')
const satellite = { noradId: '42', rec: {} }
const hiddenSatelliteIds = new Set(['n:42'])
const linkHidden = productionFunction('linkSatHidden', {
  hiddenMapSatellites: ref(['n:42']),
  linkSatEntry: (key) => ['norad:42', 'grdsat:folder'].includes(key) ? satellite : null,
  grdSats: ref([{ folder: 'legacy', noradId: '42' }]), grdNodeSatId: (node) => 'n:' + node.noradId,
  satIdOf: (e) => 'n:' + e.noradId, mapSatelliteHidden: (id) => hiddenSatelliteIds.has(id)
})
assert.equal(linkHidden('norad:42'), true, '链路 NORAD 键使用地图隐藏身份')
assert.equal(linkHidden('grdsat:folder'), true, '同一卫星的天线树别名也隐藏')
assert.equal(linkHidden('grdsat:legacy'), true, '尚未建目录条目的旧天线树键也隐藏')
assert.equal(linkHidden('missing'), false)
hiddenSatelliteIds.clear(); assert.equal(linkHidden('norad:42'), false, '恢复显示同样覆盖所有别名')
const refreshCalls = []
productionFunction('refreshHiddenSatellites', {
  rebuildRenderSet: () => refreshCalls.push('cloud'), redrawSats: () => refreshCalls.push('tree'),
  commitGeometry: () => refreshCalls.push('focus'), pushLinks: (force) => refreshCalls.push(['links', force])
})()
assert.deepEqual(refreshCalls, ['cloud', 'tree', 'focus', ['links', true]], '暂停时隐藏或恢复也立即刷新链路端点')
const focusedExtras = []
let hiddenSatellite = false, extraPositions = 0
const extras = productionFunction('pickExtraSats', {
  focusStyle: { cloudOn: true }, renderEntries: [satellite], selEntries: focusedExtras, links: ref([]),
  mapSatelliteHidden: () => hiddenSatellite, satIdOf: () => 'n:42',
  calcAt: () => new Date(0), ccTimeAt: (d) => d,
  sat: { gstime: () => 0, eciToGeodetic: () => ({ latitude: 0, longitude: 0, height: 1000 }), degreesLat: (v) => v, degreesLong: (v) => v },
  isCustomEntry: () => false, posAt: () => { extraPositions++; return { position: { x: 1, y: 0, z: 0 } } },
  vis: { open: ref(false) }, grdSats: ref([]),
  grd: { selected: ref([]), active: ref('') }, satcov: { selected: ref([]), active: ref('') }
})
assert.deepEqual(extras({ flat: true }), [], '2D 不画星座点云，不能拾取未画出的星或为它们解算星位')
assert.equal(extraPositions, 0, '鼠标悬停不为未绘制的星重新跑轨道解算')
focusedExtras.push(satellite)
assert.equal(extras({ flat: true })[0].ref, satellite, '实际显示的聚焦卫星仍可拾取')
hiddenSatellite = true; assert.deepEqual(extras({ flat: true }), [], '隐藏卫星不再被 2D 拾取')
console.log('mapObjectSettings: geometry, settings, per-object hide, routing and async navigation passed')
