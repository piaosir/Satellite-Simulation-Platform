// 侧栏「上下文视图」（sideCtx）自测：收起侧栏 ≠ 离开视图。运行：npm test
//
// 为什么单独测这个 store：绘制侧的闸全按 sideCtx 裁 —— 对星覆盖的 2D 场归属（ownsFlatField）、
// 拖拽方式（satcovDragOn）、进/出视图的重绘与交还，而 side 一收就是空串。sideLast 的维护只要漏一处
// （新增一个不经 watch 的赋值口、或 flush 慢一拍），收起侧栏就会被当成「切到别的视图」——
// 症状是壳层还留在球上、配套的轨道线/星下点/2D 那层整批消失（2026-08-16 修的就是这个）。
// 这一份只测 store 的语义，不碰渲染。
import { nextTick } from 'vue'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

const KEY = 'shell-ui-v2'
// localStorage 打桩：store 是模块级单例、import 那一刻就读存档 → 每个用例先摆好存档再 import，
// 并用 query 串换一个模块实例（ESM 没有 delete require.cache 这一手）。
let store = {}
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v) },
  removeItem: (k) => { delete store[k] }
}
let _v = 0
async function load(saved) {
  store = saved ? { [KEY]: JSON.stringify(saved) } : {}
  return import('../../../src/stores/shellUi.js?case=' + (++_v))
}

// ===== ① 收起侧栏不改上下文 =====
{
  const { shellUi, sideCtx } = await load(null)
  ok('① 默认停在星座视图', shellUi.side === 'constellation' && sideCtx() === 'constellation', sideCtx())

  shellUi.side = 'satcov'
  ok('① 切到对星覆盖分析', sideCtx() === 'satcov')

  shellUi.side = ''                       // ← 活动栏再点一次 / 点 × / 菜单「侧栏」
  ok('① 收起侧栏：面板收了', shellUi.side === '')
  ok('① 收起侧栏：上下文原地不动', sideCtx() === 'satcov', sideCtx())

  shellUi.side = 'satcov'                 // 重新展开：还是那个视图
  ok('① 再展开回到同一视图', sideCtx() === 'satcov')

  shellUi.side = 'antenna'                // 真的切走了才算离开
  ok('① 切到对地覆盖分析才算离开', sideCtx() === 'antenna')
  shellUi.side = ''
  ok('① 收起后跟的是最后那个视图', sideCtx() === 'antenna', sideCtx())
}

// ===== ② 同步 flush：切视图与收起发生在同一 tick 也对 =====
// 活动栏「再点一次收起」本就是 side='satcov' → '' 一步赋值；默认 pre-flush 会让 sideLast 慢一拍，
// 那一瞬 sideCtx() 读到的是【上上个】视图（表现为收起侧栏时 2D 场归属瞬间翻给对地）。
{
  const { shellUi, sideCtx } = await load(null)
  shellUi.side = 'satcov'
  shellUi.side = ''                       // 中间不给 await：模拟同一 tick 内连着两次赋值
  ok('② 同 tick 内切入再收起：上下文仍是 satcov', sideCtx() === 'satcov', sideCtx())
  await nextTick()
  ok('② flush 之后依旧', sideCtx() === 'satcov')
}

// ===== ③ 持久化：重开软件接着算 =====
{
  const { shellUi } = await load(null)
  shellUi.side = 'satcov'
  shellUi.side = ''
  await nextTick()                        // 存盘那个 watch 是 pre-flush
  const saved = JSON.parse(store[KEY] || '{}')
  ok('③ 收起状态存的是空串', saved.side === '')
  ok('③ 收起前那个视图也存了', saved.sideLast === 'satcov', String(saved.sideLast))

  const m2 = await load(saved)            // 重开软件
  ok('③ 重开后面板仍是收起的', m2.shellUi.side === '')
  ok('③ 重开后上下文还在对星覆盖分析', m2.sideCtx() === 'satcov', m2.sideCtx())
}

// ===== ④ 老快照 / 脏值 =====
{
  const m = await load({ side: 'satcov' })          // 升级前的存档：没有 sideLast 这个字段
  ok('④ 老快照按当前 side 补上下文', m.sideCtx() === 'satcov', m.sideCtx())

  const m2 = await load({ side: '', sideLast: 'nope' })   // 白名单外的脏值
  ok('④ 脏 sideLast 落回默认', m2.sideCtx() === 'constellation', m2.sideCtx())

  const m3 = await load({ side: '' })               // 老快照 + 收起：没线索可循，落默认
  ok('④ 老快照收着侧栏落回默认', m3.sideCtx() === 'constellation', m3.sideCtx())

  // sideCtx 恒非空：调用方一律拿它跟 'satcov' 之类比对，返回空串会让每个闸都判成「不是我」
  const m4 = await load({ side: '', sideLast: 'satcov' })
  ok('④ sideCtx 恒非空', !!m4.sideCtx() && !!m3.sideCtx() && !!m2.sideCtx())
}

// ===== ⑤ 「拖拽波束」这个模态跟着 sideCtx 走，不跟着 side 走 =====
// 它开着的时候左键在图上拖的是聚焦天线的【指向】。带着它切到 Polygon / 标记 / 波束合成 / 地图设置，
// 那边一拖就把天线拖歪了，而用户在那个上下文里根本不认为自己在改天线 → 离开对地/对星即关。
// 反过来【收起侧栏不能关】：那只是把面板藏起来，人还在这个视图里。
// 这一条的实现在 ConstellationMap3D.vue 的 watcher 里，Node 里挂不起来 → 按源码钉死
//（跟 flatExportCompat.test.mjs 同一套做法：会犯的错就是顺手把 sideCtx() 改回 shellUi.side）。
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const HERE = dirname(fileURLToPath(import.meta.url))
  const page = readFileSync(join(HERE, '../../../src/pages/ConstellationMap3D.vue'), 'utf8')

  const m = /const COV_SIDES = (\[[^\]]*\])/.exec(page)
  ok('⑤ 声明了「哪几个视图算覆盖分析」', !!m, m && m[1])
  ok('⑤ 对地覆盖分析在内', !!m && m[1].includes("'antenna'"))
  ok('⑤ 对星覆盖分析在内', !!m && m[1].includes("'satcov'"))
  const w = /watch\(\(\) => sideCtx\(\), \(cur\) => \{ if \(!COV_SIDES\.includes\(cur\) && grd\.dragBore\.value\) grd\.setDragBore\(false\) \}\)/.test(page)
  ok('⑤ 离开这两个视图即关掉拖拽波束', w)
  // 盯的必须是 sideCtx()：换成 shellUi.side 就成了「收起侧栏也把模态关掉」
  ok('⑤ 盯的是 sideCtx() 不是 shellUi.side', w && !/COV_SIDES\.includes/.test(page.replace(/watch\(\(\) => sideCtx\(\)[\s\S]*?\n/g, '')))
}

// ===== ⑥ 激活锁：未激活时侧栏视图打不开（地图综合设置除外），兜底闸不改写 sideLast =====
// 漏口曾经是 3D 页 / 菜单直接写 shellUi.side（右键「地图综合设置」、信息栏滑杆图标、「视图 › 侧栏」）。
{
  const { activation, lockAsk } = await import('../../../src/stores/activation.js')
  const { shellUi, sideCtx, requestSide, sideLocked } = await load({ side: '', sideLast: 'satcov' })
  activation.ready = true; activation.active = false          // 未激活
  const ask0 = lockAsk.value
  ok('⑥ requestSide 受锁视图返回 false', requestSide('vis') === false && shellUi.side === '')
  ok('⑥ 并请出「未激活」窗', lockAsk.value === ask0 + 1)
  shellUi.side = 'focus'                                     // 漏网的直接赋值
  ok('⑥ 兜底闸收回直接赋值', shellUi.side === '' && lockAsk.value === ask0 + 2)
  ok('⑥ 兜底不改写上下文视图', shellUi.sideLast === 'satcov' && sideCtx() === 'satcov', shellUi.sideLast)
  ok('⑥ 地图综合设置不受锁', !sideLocked('geo') && requestSide('geo') === true && shellUi.side === 'geo')
  ok('⑥ 收起侧栏不受锁', requestSide('') === true && shellUi.side === '')
  activation.active = true                                   // 激活后照常
  ok('⑥ 激活后 requestSide 放行', requestSide('vis') === true && shellUi.side === 'vis' && lockAsk.value === ask0 + 2)
  activation.ready = false
}

// ===== ⑦ 可见性分析：进出看 sideCtx；关面板不取消覆盖、不撤热力图；卫星组来源重启保得住 =====
// 回归 2026-10-16 体检二档：原先 side 一空就 vis.close() —— 作废覆盖令牌、清热力图（收起侧栏就白算）；停在可见性视图、
// 卫星集选了某个卫星组，重启时组还没读进来（satGroups.load 排在 onMounted 几个 await 之后）就按「组已删」回退成「当前显示」并写回存档。
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const HERE = dirname(fileURLToPath(import.meta.url))
  const page = readFileSync(join(HERE, '../../../src/pages/ConstellationMap3D.vue'), 'utf8').replace(/\r\n/g, '\n')
  ok('⑦ 可见性进出看 sideCtx（收起侧栏不关、侧栏收着重启也打开）', page.includes("const visCtx = sideCtx() === 'vis'") && page.includes("if (side === 'vis' || (visCtx && !vis.open.value)) { vis.openPanel(); commitGeometry() }") && page.includes('else if (vis.open.value && !visCtx) { vis.close(); commitGeometry() }'))
  ok('⑦ 不再按 shellUi.side 一空就关', !/else if \(vis\.open\.value\) \{ vis\.close\(\)/.test(page))
  const iLoad = page.indexOf('\nsatGroups.load()\n'), iSeed = page.indexOf('let setsSeeded = false'), iMount = page.indexOf('onMounted(async () => {')
  ok('⑦ satGroups.load() 在 setup 顶层同步调（setsSeeded 声明之后、onMounted 之前）', iSeed > 0 && iLoad > iSeed && iLoad < iMount)
  const mounted = page.slice(iMount, page.indexOf('\n})\n', iMount))
  ok('⑦ onMounted 里不再读卫星组', !/\n\s*satGroups\.load\(\)/.test(mounted))

  // useVisibility：close 只撤逐拍叠加层 —— 在算的覆盖照算完、热力图照画；「清除」才撤
  const sat = (await import('../../../src/viz/constellation/satellite.js')).default
  const { useVisibility } = await import('../../../src/viz/vis/useVisibility.js')
  const GEO = sat.twoline2satrec('1 39017U 12075A   26265.41000000 -.00000349  00000+0  00000+0 0  9990', '2 39017   0.0200 137.5600 0002700  33.6000 304.8900  1.00270000 50000')
  const T = new Date(Date.UTC(2026, 8, 22, 12))
  const draws = []
  const v = useVisibility({
    getStations: () => [{ id: 's1', lat: 39.9, lon: 116.4 }], getPoints: () => [], getTrajectories: () => [], getPolys: () => [],
    getSatSet: () => [{ rec: GEO, name: 'GEO', noradId: 39017, group: 'geo' }],
    calcAt: () => T, ccTimeAt: (t) => t, isCustomEntry: () => false, refresh: () => {},
    drawCov: (spec) => draws.push(spec), setCovAlpha: () => {}
  })
  v.openPanel(); v.setMode('coverage')
  v.covRegionKind.value = 'global'; v.covStep.value = 10; v.covHorizonH.value = 1; v.covSample.value = 300
  v.computeCoverage()
  const n0 = draws.length
  v.close()   // 真离开视图（切到别的视图）：覆盖还在算
  ok('⑦ close 不撤热力图（不往渲染器画 null）', draws.length === n0)
  ok('⑦ close 不取消在算的覆盖', v.covBusy.value === true)
  const t0 = Date.now()
  while (v.covBusy.value && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 10))
  const last = draws[draws.length - 1]
  ok('⑦ 面板关着覆盖照样算完、热力图照画', !v.covBusy.value && !!v.covData.value && !!(last && last.fillBands && last.fillBands.length), `busy=${v.covBusy.value} draws=${draws.length}`)
  ok('⑦ 进度读数不停在半截', !/覆盖计算…/.test(v.covMsg.value), v.covMsg.value)
  v.clearCoverage()
  ok('⑦ 「清除」才撤热力图', draws[draws.length - 1] === null && !v.covData.value)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
