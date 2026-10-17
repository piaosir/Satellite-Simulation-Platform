// 对地性能指标表的城市层（src/viz/grd/perfWinHost.js）自测。运行：npm test
//
// 钉死的口径：地图上画不画这张表的城市（标记 + 标签）由对地覆盖分析树里「性能指标表」行的眼睛（opts.cityShow，出厂关）决定，
// 与表窗口开没开无关 —— 窗口只是编辑器：① 出厂关时不画也不载方向图，打开后没开过窗也画；② 眼睛关就清、开就回；③ 眼睛改了要推给开着的窗
// （镜像按内容签名判回声，窗口那份不跟上，它下次发回整份选项会带着旧值把眼睛翻回去），关窗标记还在；
// ④ 表里城市清空层就空；⑤ 删天线层消失、且不再去载它。
// 宿主的推送与重画都合帧在 setTimeout(0) 里，Windows 上 Node 的定时器粒度可到 16 ms —— 断言一律轮询等到位，不睡固定时长。
import { ref } from 'vue'
import { usePerfTable } from '../../../src/viz/grd/usePerfTable.js'
import { createPerfWinHost } from '../../../src/viz/grd/perfWinHost.js'
import { antennaBasis } from '../../../src/viz/grd/coverage.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const tick = (ms = 8) => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred, ms = 1500) {
  const t0 = performance.now()
  while (performance.now() - t0 < ms) { if (pred()) return true; await tick(4) }
  return pred()
}

const KEY = 'satX|ant1'
const basis = antennaBasis(110.5, 110.5, 0, 0, 0, 35786)   // GEO 110.5°E 天底指向
const loaded = new Set()                                   // 「已载入缓存」的天线
const allowed = new Set([KEY])                             // 树里有、载得到的天线（树没到 / 删了 → 载不到）
let treeReady = true, loadCalls = 0
let treeSub = null
const layersLog = []                                       // 每次 setCityBoxes 收到的 layers
const pushes = []                                          // 宿主推给弹窗的消息
let onAct = null, onClosed = null, seq = 0
const api = {
  open: async () => ({ id: 'w' + (++seq) }),
  push: async (id, m) => { pushes.push({ id, m }) },
  close: async (id) => { onClosed && onClosed({ id }) },
  setTitle: async () => {}, list: async () => [],
  onAct: (fn) => { onAct = fn }, onClosed: (fn) => { onClosed = fn }
}
const perf = usePerfTable()
perf.setActiveKey(KEY)
{ const s = perf.addEmptyStation(); perf.updateStation(s.id, { city: '北京', lon: 116.4, lat: 39.9 }) }
const D = {
  api, perf,
  grd: {
    sats: ref([{ folder: 'satX', satName: 'X', antennas: [{ name: 'ant1' }] }]),
    getPerfContext: (key) => (loaded.has(key) ? { key, basis, satName: 'X', antName: 'ant1', satNo: 1, antNo: 1, beams: [], settings: {}, meta: {} } : null),
    ensureAntLoaded: async (key) => { loadCalls++; if (!treeReady || !allowed.has(key)) return false; loaded.add(key); return true },
    onTreeKeys: (fn) => { treeSub = fn }
  },
  satPerf: { picksByAnt: ref({}), optsByAnt: ref({}), dropSession() {} },
  satcov: {}, envLive: {},
  scene: () => ({ setCityBoxes: (l) => layersLog.push(l) }), flat: () => null,
  markers: () => ({ pts: [], sts: [], trs: [] }), fmtLL: (a, b) => a + ',' + b,
  timeLabel: () => 't', liveTimeText: () => '', tzMode: () => 'local', nowMs: () => 0
}
const host = createPerfWinHost(D)
await host.attach()
const last = () => layersLog[layersLog.length - 1] || []
const nLayers = () => last().length

// ==================== ① 眼睛出厂关：不画、不载；打开才画（天线按需载入），不看窗口 ====================
{
  await tick(40)
  ok('① 眼睛出厂关 → 不画、也不去载方向图', nLayers() === 0 && !loaded.has(KEY) && !host.boxKeys().includes(KEY) && !host.liveKeys().includes(KEY), JSON.stringify(layersLog.map((l) => l.length)))
  host.setCityShow(KEY, true)
  await waitFor(() => nLayers() === 1)
  ok('① 眼睛开 → 没开过窗也画：一层、一城', nLayers() === 1 && last()[0].key === KEY && last()[0].items.length === 1, JSON.stringify(last().map((l) => [l.key, l.items.length])))
  ok('① 天线是按需载入的', loaded.has(KEY))
  ok('① 这根天线的星位随时钟走', host.liveKeys().includes(KEY) && host.boxKeys().includes(KEY))
}

// ==================== ② 眼睛关就清、开就回 ====================
{
  host.setCityShow(KEY, false)
  await waitFor(() => nLayers() === 0)
  ok('② 眼睛关 → 层清空、不再随时钟', nLayers() === 0 && perf.cityShowOf(KEY) === false && !host.boxKeys().includes(KEY) && !host.liveKeys().includes(KEY))
  host.setCityShow(KEY, true)
  await waitFor(() => nLayers() === 1)
  ok('② 眼睛开 → 层回来', nLayers() === 1 && host.liveKeys().includes(KEY))
}

// ==================== ③ 开着的窗要跟上；关窗标记还在 ====================
{
  const id = await host.open('ground', KEY)
  onAct({ id, kind: 'ground', key: KEY, type: 'ready' })
  const gotFull = () => pushes.some((p) => p.id === id && p.m.type === 'state' && p.m.patch && p.m.patch.opts && p.m.patch.opts.cityShow === true)
  await waitFor(gotFull)
  ok('③ 就绪后整份状态（含选项）推到窗', gotFull())
  pushes.length = 0
  host.setCityShow(KEY, false)
  const gotOff = () => pushes.some((p) => p.id === id && p.m.patch && p.m.patch.opts && p.m.patch.opts.cityShow === false)
  await waitFor(() => gotOff() && nLayers() === 0)
  ok('③ 眼睛改了 → 整份选项推给开着的窗', gotOff())
  onAct({ id, kind: 'ground', key: KEY, type: 'opts', payload: JSON.parse(JSON.stringify(perf.getOpts(KEY))) })
  await tick(40)
  ok('③ 窗口回发同一份不把眼睛翻回去', perf.cityShowOf(KEY) === false && nLayers() === 0)
  host.setCityShow(KEY, true)
  await waitFor(() => nLayers() === 1)
  onClosed({ id })
  await tick(40)
  ok('③ 关窗标记还在', nLayers() === 1 && !host.isOpen('ground', KEY))
}

// ==================== ④ 表里城市清空 → 层空；填回来 → 层回 ====================
{
  const id = await host.open('ground', KEY)
  onAct({ id, kind: 'ground', key: KEY, type: 'ready' })
  await tick(20)
  onAct({ id, kind: 'ground', key: KEY, type: 'stations', payload: [] })
  await waitFor(() => nLayers() === 0)
  ok('④ 城市清空 → 层清空', nLayers() === 0 && !host.boxKeys().includes(KEY))
  onAct({ id, kind: 'ground', key: KEY, type: 'stations', payload: [{ id: 'c1', city: '上海', lon: 121.5, lat: 31.2 }, { id: 'c2', city: '纽约', lon: -74, lat: 40.7 }] })
  await waitFor(() => nLayers() === 1)
  ok('④ 城市填回来 → 层回来（背面的城市只有标签、没有框）', nLayers() === 1 && last()[0].items.length === 2 && last()[0].items[0].text === '上海' && last()[0].items[1].ring === null, JSON.stringify(last().map((l) => l.items.map((i) => i.text))))
  onClosed({ id })
  await tick(20)
}

// ==================== ⑤ 删天线 → 层消失、不再去载 ====================
{
  loaded.delete(KEY); allowed.delete(KEY)   // 树里没有它了
  treeSub({ type: 'remove', keys: [KEY] })
  await waitFor(() => nLayers() === 0)
  await tick(40)
  ok('⑤ 删天线 → 层消失且不再重载', nLayers() === 0 && !loaded.has(KEY))
}

// ==================== ⑥ 启动竞态：城市桶先于 GRD 索引恢复 → 第一次载不到 → 树到了自动重试；眼睛再开也重试 ====================
// 真实启动顺序（ConstellationMap3D restoreSettings）：perf.restoreState 在 grd.loadIndex 之前 —— 第一次 ensureAntLoaded 必然查不到天线。
// 09-15 版记成「试过一次」就永不再试，重启后眼睛开着也不上图、再点眼睛也没用（用户 09-16 报）。
{
  const K2 = 'satY|ant2', K3 = 'satZ|ant3'
  treeReady = false
  for (const [k, city, lon, lat] of [[K2, '上海', 121.5, 31.2], [K3, '广州', 113.3, 23.1]]) {
    perf.setActiveKey(k); const s = perf.addEmptyStation(); perf.updateStation(s.id, { city, lon, lat }); perf.setCityShow(k, true)
  }
  host.pushBoxes()
  await tick(60)
  const has = (k) => last().some((l) => l.key === k)
  ok('⑥ 树没到时载不到、不上图', !loaded.has(K2) && !loaded.has(K3) && !has(K2) && !has(K3))
  // 索引载完：sats 整份换 → 之前失败的重试 → 上图
  treeReady = true; allowed.add(K2)
  D.grd.sats.value = [...D.grd.sats.value, { folder: 'satY', satName: 'Y', antennas: [{ name: 'ant2' }] }]
  await waitFor(() => has(K2))
  ok('⑥ 树到了 → 自动重试并上图', loaded.has(K2) && has(K2) && last().find((l) => l.key === K2).items.length === 1)
  // K3 仍不在树里（载不到）：不反复去载；用户再开一次眼睛 → 允许再试
  const c0 = loadCalls
  host.pushBoxes(); await tick(40)
  ok('⑥ 载不到的天线不反复重试', loadCalls === c0 && !has(K3))
  allowed.add(K3)
  host.setCityShow(K3, false); host.setCityShow(K3, true)
  await waitFor(() => has(K3))
  ok('⑥ 眼睛再开 → 重试并上图', loaded.has(K3) && has(K3) && loadCalls > c0)
}

// ==================== ⑦ 整页重挂载（切 MSAA）不留死页面：detach 摘监听与 watch，新宿主认领开着的窗、adopt 补推整份 ====================
// 修前：onAct / onClosed 永不摘（preload 也没有退订口），attach 里 await 之后建的 watch 不随页面停 —— 每拨一次 MSAA 死页面的宿主
// 就多挂一份，弹窗每次操作被新旧两套宿主各算一遍；新宿主认领的窗等不到第二次 ready，此后收不到任何推送。
{
  const KW = 'satW|antW'
  const subs = { act: new Set(), closed: new Set() }
  const pushed = []
  let openNow = []
  const api2 = {
    open: async () => ({ id: 'wNew' }),
    push: async (id, m) => { pushed.push({ id, m }) },
    close: async () => {}, setTitle: async () => {},
    list: async () => openNow.slice(),
    onAct: (fn) => { subs.act.add(fn); return () => subs.act.delete(fn) },
    onClosed: (fn) => { subs.closed.add(fn); return () => subs.closed.delete(fn) }
  }
  const loaded2 = new Set()
  let ensureCalls = 0
  const mkD = (pf) => ({
    api: api2, perf: pf,
    grd: {
      sats: ref([{ folder: 'satW', satName: 'W', antennas: [{ name: 'antW' }] }]),
      getPerfContext: (key) => (loaded2.has(key) ? { key, basis, satName: 'W', antName: 'antW', satNo: 1, antNo: 1, beams: [], settings: {}, meta: {} } : null),
      ensureAntLoaded: async (key) => { ensureCalls++; loaded2.add(key); return true },
      onTreeKeys: () => {}
    },
    satPerf: { picksByAnt: ref({}), optsByAnt: ref({}), dropSession() {} },
    satcov: {}, envLive: {},
    scene: () => null, flat: () => null,
    markers: () => ({ pts: [], sts: [], trs: [] }), fmtLL: (a, b) => a + ',' + b,
    timeLabel: () => 't', liveTimeText: () => '', tzMode: () => 'local', nowMs: () => 0
  })
  const fire = (m) => { for (const f of [...subs.act]) f(m) }
  // 旧页面的宿主：开一扇对地窗，就绪
  const pfA = usePerfTable(); pfA.setActiveKey(KW); { const s = pfA.addEmptyStation(); pfA.updateStation(s.id, { city: '北京', lon: 116.4, lat: 39.9 }) }
  const hostA = createPerfWinHost(mkD(pfA))
  await hostA.attach()
  ok('⑦ attach 挂上两路 IPC 监听', subs.act.size === 1 && subs.closed.size === 1)
  loaded2.add(KW)
  const wid = await hostA.open('ground', KW)
  fire({ id: wid, kind: 'ground', key: KW, type: 'ready' })
  await waitFor(() => pushed.some((p) => p.id === wid))
  // 页面卸载
  hostA.detach()
  ok('⑦ detach：两路 IPC 监听都摘掉', subs.act.size === 0 && subs.closed.size === 0)
  ok('⑦ detach：窗口表清空（死页面不再认这扇窗）', !hostA.isOpen('ground', KW) && hostA.groundKeys().length === 0)
  pushed.length = 0
  pfA.setCityGroups([{ id: 'g1', name: '组', cities: [] }])   // 旧页面的 cityGroups watch 若还活着，会往窗里推
  await tick(40)
  ok('⑦ detach：await 之后建的 watch 已停（旧桶再变也不推）', pushed.length === 0, JSON.stringify(pushed.map((p) => p.id)))
  hostA.detach()   // 幂等
  // 新页面的宿主：认领还开着的窗；恢复完设置之前不推（桶还是出厂值），adopt 后补推整份
  openNow = [{ id: wid, kind: 'ground', key: KW }]
  loaded2.delete(KW)
  const pfB = usePerfTable(); pfB.setActiveKey(KW); { const s = pfB.addEmptyStation(); pfB.updateStation(s.id, { city: '上海', lon: 121.5, lat: 31.2 }) }
  const hostB = createPerfWinHost(mkD(pfB))
  await hostB.attach()
  ok('⑦ 新宿主认领开着的窗（只有它一套在听）', hostB.isOpen('ground', KW) && subs.act.size === 1)
  await tick(30)
  ok('⑦ 认领后、adopt 之前不推（桶还没按存盘恢复）', !pushed.some((p) => p.id === wid))
  const e0 = ensureCalls
  await hostB.adopt()
  const full = () => pushed.find((p) => p.id === wid && p.m.type === 'state' && p.m.patch && Array.isArray(p.m.patch.stations))
  await waitFor(() => !!full())
  ok('⑦ adopt：先把天线载上，再补推整份状态（城市 = 新页面恢复的那份）', ensureCalls === e0 + 1 && !!full() && full().m.patch.stations.some((s) => s.city === '上海'), JSON.stringify(full() && full().m.patch.stations.map((s) => s.city)))
  pushed.length = 0
  await hostB.adopt()
  await tick(30)
  ok('⑦ adopt 只补一次', !pushed.length && ensureCalls === e0 + 1)
  // 窗口操作只被新宿主处理一次
  fire({ id: wid, kind: 'ground', key: KW, type: 'stations', payload: [{ id: 'c9', city: '广州', lon: 113.3, lat: 23.1 }] })
  await tick(30)
  ok('⑦ 窗口操作落进新页面的桶、旧页面的桶不动', pfB.stationsOf(KW).some((s) => s.city === '广州') && !pfA.stationsOf(KW).some((s) => s.city === '广州'))
  hostB.detach()
  // detach 发生在 attach 的 await 当中：醒来不再装 watch
  const hostC = createPerfWinHost(mkD(usePerfTable()))
  const pa = hostC.attach(); hostC.detach(); await pa
  ok('⑦ attach 途中 detach：监听摘净', subs.act.size === 0 && subs.closed.size === 0)
  // 页面恢复设置比认领清单那次 IPC 还快（没存档时）：先要的 adopt 等清单回来再补
  pushed.length = 0
  const hostD = createPerfWinHost(mkD(pfB))
  const pd = hostD.attach(); hostD.adopt(); await pd
  await waitFor(() => !!full())
  ok('⑦ adopt 早于认领清单：清单回来后照样补推', !!full() && subs.act.size === 1)
  hostD.detach()
  ok('⑦ 收尾：监听摘净', subs.act.size === 0 && subs.closed.size === 0)
}

// ==================== ⑧ 页面 / 场景 / preload 接线（按源码钉）====================
{
  const { readFileSync } = await import('node:fs')
  const page = readFileSync(new URL('../../../src/pages/ConstellationMap3D.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const scene = readFileSync(new URL('../../../src/viz/globe3d/scene.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const preload = readFileSync(new URL('../../../electron/preload.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const i0 = page.indexOf('onMounted(async () => {'), i1 = page.indexOf('\n})\n', i0)
  const mounted = i0 >= 0 && i1 > i0 ? page.slice(i0, i1) : ''
  // 第一个顶层 await（回调里的 await 不算：那些回调本身是 await 之前建的 watch，挂在组件上）
  const afterAwait = mounted.slice(mounted.indexOf('\n  await restoreSettings()'))
  // await 之后不许再有裸 watch(：一律 _lateStops.push(watch(…))
  const bare = afterAwait.split('\n').filter((l) => /\bwatch\(/.test(l) && !/_lateStops\.push\(watch\(/.test(l) && !/^\s*\/\//.test(l))
  ok('⑧ onMounted：await 之后建的 watch 句柄全部收进 _lateStops', afterAwait.length > 30 && bare.length === 0 && (afterAwait.match(/_lateStops\.push\(watch\(/g) || []).length >= 6, bare.join(' | '))
  const tops = afterAwait.split('\n').filter((l) => /^ {2}(if \([^)]*\) )?await /.test(l))   // 顶层（两格缩进）的 await 行
  const unguarded = tops.filter((l, k) => { const rest = afterAwait.slice(afterAwait.indexOf(l) + l.length, afterAwait.indexOf(l) + l.length + 60); return !/if \(!_pageAlive\) return/.test(l) && !/^\n {2}if \(!_pageAlive\) return/.test(rest) })
  ok('⑧ onMounted：每个顶层 await 醒来先看页面还在不在', tops.length >= 5 && unguarded.length === 0, unguarded.join(' | ') || `${tops.length} 处 await`)
  ok('⑧ onMounted：恢复完设置才 adopt 认领的性能表窗口', mounted.indexOf('perfHost.adopt()') > mounted.indexOf('await restoreSettings()'))
  const j0 = page.indexOf('onBeforeUnmount(() => {\n  _pageAlive = false'), j1 = page.indexOf('\n})\n', j0)
  const unmount = j0 >= 0 && j1 > j0 ? page.slice(j0, j1) : ''
  ok('⑧ onBeforeUnmount：先置页面已卸载、落一次盘再停 _lateStops', /_pageAlive = false/.test(unmount) && unmount.indexOf('saveSettings()') < unmount.indexOf('_lateStops.splice(0)') && unmount.indexOf('if (_lateStops.length)') >= 0)
  ok('⑧ onBeforeUnmount：perfHost.detach()', unmount.includes('perfHost.detach()'))
  ok('⑧ onBeforeUnmount：收掉编辑段再清场景撤销栈', unmount.indexOf('domUndo.flushAll()') > 0 && unmount.indexOf('domUndo.flushAll()') < unmount.indexOf('clearSceneUndo()'))
  const d0 = scene.indexOf('function destroy() {'), d1 = scene.indexOf('\n  }\n', d0)
  const destroy = d0 >= 0 && d1 > d0 ? scene.slice(d0, d1) : ''
  ok('⑧ scene.destroy：renderer.dispose 之后 forceContextLoss', destroy.indexOf('renderer.forceContextLoss()') > destroy.indexOf('renderer.dispose()') && destroy.indexOf('renderer.dispose()') > 0)
  ok('⑧ preload：perfWin.onAct / onClosed 返回退订函数', /onAct: \(cb\) => subscribe\('perfwin:act'/.test(preload) && /onClosed: \(cb\) => subscribe\('perfwin:closed'/.test(preload))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
