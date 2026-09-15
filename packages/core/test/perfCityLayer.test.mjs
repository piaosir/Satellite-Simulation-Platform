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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
