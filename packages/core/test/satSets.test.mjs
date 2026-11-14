import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { useSatSets } from '../../../src/viz/constellation/useSatSets.js'
import { sectionsOf, sectionOf, REFERENCE_GROUPS, isUniverseGroup, isNamedConstellation, builtinSetLabel } from '../../../src/viz/constellation/satSetSections.js'

const memory = new Map()
globalThis.localStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) }
const fresh = () => { memory.clear(); const s = useSatSets(); s.ensure(['t:tree', 'g:geo', 'g:starlink', 'g:all']); return s }
const restored = () => { const s = useSatSets(); assert.equal(s.load(), true); return s }

// 用户逐一关闭眼睛与「全部隐藏」都必须跨会话保留空集合。
{
  const s = fresh()
  s.setVisible(['t:tree', 'g:geo'])
  s.toggle('t:tree'); s.toggle('g:geo')
  assert.deepEqual([...restored().visible.value], [])
  s.setVisible(['g:starlink', 'g:geo']); s.hideAll()
  const r = restored()
  assert.deepEqual([...r.visible.value], [])
  r.restoreHidden((id) => id !== 'g:geo')
  assert.deepEqual([...r.visible.value], ['g:starlink'])
  assert.equal(r.hiddenSnapshot.value, null)
}
// 全部隐藏必须结束仅看模式，不能在 persist 时被 solo.prev 覆盖。
{
  const s = fresh()
  s.setVisible(['g:geo']); s.soloOn('q'); s.hideAll()
  const r = restored()
  assert.equal(r.solo.value, null)
  assert.deepEqual([...r.visible.value], [])
  r.restoreHidden()
  assert.deepEqual([...r.visible.value], ['g:geo'])
  s.setVisible([]); s.soloOn('q')
  assert.deepEqual([...restored().visible.value], [])
}
// 仅看切换保留最初的多显状态，眼睛手动打开另一项后退出仅看。
{
  const s = fresh()
  s.setVisible(['g:geo', 'g:starlink']); s.soloOn('g:starlink'); s.soloOn('g:all')
  const r = restored(); r.restore()
  assert.deepEqual([...r.visible.value], ['g:geo', 'g:starlink'])
  s.toggle('g:geo')
  assert.equal(s.solo.value, null)
  assert.deepEqual([...restored().visible.value], ['g:all', 'g:geo'])
}
// 显示真正的保存失败，不误报「已保存」，后续成功写入可恢复。
{
  const s = fresh(), setter = localStorage.setItem
  localStorage.setItem = () => { throw new Error('quota') }
  s.hideAll(); assert.equal(s.saveState.value, 'error')
  localStorage.setItem = setter
  s.persist(); assert.equal(s.saveState.value, 'saved')
}
// 运行页面真实初始化逻辑，防止注册 / 默认值迁移再次覆盖有效的空存档。
const page = readFileSync(new URL('../../../src/pages/ConstellationMap3D.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const start = page.indexOf('function initSatSets(legacy) {')
const initSource = page.slice(start, page.indexOf('\n}\n', start) + 2)
function boot(s) {
  return new Function('satSets', 'registerSets', 'TREE_SET', 'GROUPS', 'DEFAULT_GROUP', 'BUILTIN_KEYS', 'importGroups', 'customConst', 'applySetsChanged', initSource + '; return initSatSets')(
    s, () => s.ensure(['t:tree', 'g:geo', 'g:starlink']), 't:tree', [{ key: 'geo' }], 0, ['geo', 'starlink'], { value: [] }, { list: { value: [] } }, () => s.persist()
  )
}
for (const order of [['g:geo'], ['t:tree', 'g:geo']]) {
  memory.clear(); localStorage.setItem('constellation3d/satSets', JSON.stringify({ order, visible: [], items: {} }))
  const s = useSatSets(); boot(s)()
  assert.deepEqual([...s.visible.value], [])
  assert.deepEqual([...restored().visible.value], [])
}
{
  memory.clear(); const s = useSatSets(); boot(s)()
  assert.deepEqual([...s.visible.value], ['t:tree', 'g:geo'])
}
// 目录汇总视图归入目录参考；各类顺序保持存档内的相对顺序。
{
  const rows = [{ id: 'g:all', kind: 'builtin' }, { id: 'g:starlink', kind: 'builtin' }, { id: 'c:a', kind: 'custom' }, { id: 'g:geo', kind: 'builtin' }, { id: 'c:b', kind: 'custom' }]
  assert.equal(sectionOf(rows[0]), 'catalog')
  const groups = sectionsOf(rows)
  assert.deepEqual(groups.map((s) => s.id), ['custom', 'builtin', 'catalog'])
  assert.deepEqual(groups[0].rows.map((r) => r.id), ['c:a', 'c:b'])
}
// 运行页面真实搜索处理器：候选结果不改显示；后完成的旧请求不能覆盖新请求。
{
  const a = page.indexOf('async function onSearch(e) {')
  const source = page.slice(a, page.indexOf('\n}\n', a) + 2)
  const keyword = { value: '' }, searchResults = { value: [] }, searchLoading = { value: false }
  const waits = []
  const pool = () => new Promise((resolve) => waits.push(resolve))
  const catalog = [{ name: 'GPS-A', noradId: '1', groupLabel: 'GPS', rec: {} }, { name: '北斗-B', noradId: '2', groupLabel: '北斗', rec: {} }]
  const search = new Function('keyword', 'searchResults', 'searchLoading', 'ensureSearchPool', 'searchSource', 'clearSearch', 'geoSlotOfSatrec', 'GROUP_LABEL', 'let searchRequest = 0; ' + source + '; return onSearch')(
    keyword, searchResults, searchLoading, pool, () => catalog, () => { searchResults.value = [] }, () => '', {}
  )
  const s = fresh(); s.setVisible(['g:geo'])
  const old = search({ target: { value: 'GPS' } })
  const latest = search({ target: { value: '北斗' } })
  waits[1](); await latest
  assert.equal(searchResults.value[0].name, '北斗-B')
  waits[0](); await old
  assert.equal(searchResults.value[0].name, '北斗-B')
  assert.equal(searchLoading.value, false)
  assert.deepEqual([...s.visible.value], ['g:geo'])
  const pending = search({ target: { value: 'GPS' } })
  await search({ target: { value: '' } })
  waits[2](); await pending
  assert.deepEqual(searchResults.value, [])
  assert.equal(searchLoading.value, false)
}
// 用途目录按需加载，不进入全量池启动请求，也不参与「其他星座」的排除口径。
{
  assert.equal(REFERENCE_GROUPS.length, 6)
  for (const group of REFERENCE_GROUPS) {
    assert.equal(sectionOf({ id: 'g:' + group.key, kind: 'builtin' }), 'catalog')
    assert.equal(isUniverseGroup(group.key), false)
    assert.equal(isNamedConstellation(group.key), false)
  }
  assert.equal(builtinSetLabel('other'), '其他星座（内置大型星座以外）')
  const service = readFileSync(new URL('../../../electron/services/omm.js', import.meta.url), 'utf8')
  const snapshot = readFileSync(new URL('../../../scripts/fetch-omm-snapshot.mjs', import.meta.url), 'utf8')
  const queryOf = (source) => new Function('return (' + /const GROUP_QUERY = (\{[\s\S]*?\n\})/.exec(source)[1] + ')')()
  const mainQuery = queryOf(service), bundleQuery = queryOf(snapshot)
  for (const group of REFERENCE_GROUPS) {
    assert.equal(mainQuery[group.key], 'GROUP=' + (group.key === 'earth-resources' ? 'resource' : group.key))
    assert.equal(bundleQuery[group.key], mainQuery[group.key])
  }
  const a = page.indexOf('async function loadUniverse(silent, opts = {}) {')
  const source = page.slice(a, page.indexOf('\n}\n', a) + 2)
  const requested = []
  const satellite = (noradId, name) => ({ noradId, name })
  const groups = [{ key: 'gps' }, { key: 'geo' }, { key: 'stations' }, ...REFERENCE_GROUPS]
  const fixtures = { gps: [satellite('1', 'GPS')], geo: [satellite('1', 'GPS copy'), satellite('2', 'GEO independent')], stations: [satellite('3', 'ISS')], active: [satellite('1', 'GPS'), satellite('2', 'GEO independent'), satellite('3', 'ISS'), satellite('4', 'Small constellation')] }
  const load = new Function('GROUPS', 'isUniverseGroup', 'isNamedConstellation', 'fetchGroupLiveOrSup', 'window', 'parseOMMCsv', 'status', 'let universeFetchedAt, universeIntact, universeFetchedMin; ' + source + '; return loadUniverse')(
    groups, isUniverseGroup, isNamedConstellation, async (key) => { requested.push(key); return { sats: fixtures[key], fetchedAt: '2026-11-14T00:00:00Z' } }, { api: { omm: { customCsv: async () => null } } }, () => [], { value: '' }
  )
  const all = await load(true)
  assert.deepEqual(requested, ['gps', 'geo', 'stations', 'active'])
  assert.deepEqual(all.filter((s) => s._otherConstellation).map((s) => s.noradId), ['2', '3', '4'])
  assert.equal(all.filter((s) => s.noradId === '1').length, 1)
}
console.log('satSets: 持久化、隐藏还原、单项显示、来源分区、搜索竞态与新增目录接入检查通过')
