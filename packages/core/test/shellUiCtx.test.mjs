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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
