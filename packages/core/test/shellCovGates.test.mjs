// 对星覆盖分析的【三道闸】自测：谁决定往哪儿画。运行：npm test
//
// useShellCoverage 往外写两条通道，各归各的闸管：
//   · 3D 壳层通道 —— 闸是 _painted（画过就一直跟着设置/时间刷，离开面板不撤）
//   · 2D 那块 GRD 场 —— 只有【一块】、对地/对星共用 → 闸是 ownsFlat（归属）＋ flatActive（有没有人看）
//   · panelOn 只管面板读数（stats / shellStatus / focusBeam），★ 不许拿它裁场景内容
// 2026-08-16 之前 2D 那条错用了 panelOn：侧栏一收 panelOn 就假，2D 平面图上对星那批层当场停更、
// 归属还翻给对地被整体换掉 —— 用户看到的就是「关个侧栏，图少一半」。这份把分工钉死。
//
// 只验闸（有没有喂），不验喂了什么 —— 场几何由 shellProj.test.mjs 管，故 selected 留空即可。
import { ref, reactive, nextTick } from 'vue'

let store = {}
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v) },
  removeItem: (k) => { delete store[k] }
}
const { useShellCoverage } = await import('../../../src/viz/grd/useShellCoverage.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 最小 grd 替身：只提供 useShellCoverage 真正调到的那几样
function makeGrd() {
  return {
    s: reactive({ alpha: 0.6, showBore: true, boreSize: 1, showName: false, nameSize: 1, showPeak: false, peakSize: 1, showVal: false, valSize: 1 }),
    active: ref(''),
    sats: ref([]),
    onTreeKeys: () => {},
    getPerfContext: () => null,
    keyOf: (f, a) => f + '|' + a,
    ensureAntLoaded: async () => true,
    setActiveKey: async () => {},
    buildAxisRays: () => []
  }
}
function makeScene() {
  const n = { field: 0, guides: 0, rays: 0, cleared: 0 }
  return {
    n,
    setShellField: () => { n.field++ },
    setShellGuides: () => { n.guides++ },
    setShellRays: () => { n.rays++ },
    clearShellField: () => { n.cleared++ },
    clearShellGuides: () => {},
    clearShellRays: () => {}
  }
}
function makeFlat() {
  const n = { field: 0 }
  return { n, setField: () => { n.field++ } }
}

// 一套可现改的闸 + 一个已经画过的实例（painted 走存档恢复那条路，与重开软件同一口径）
async function rig() {
  const g = { panelOn: true, ownsFlat: true, isFlat: false, flatActive: true }
  const grd = makeGrd(), scene = makeScene(), flat = makeFlat()
  const sc = useShellCoverage(grd, () => scene, () => flat, () => g.isFlat,
    () => g.panelOn, () => g.flatActive, () => g.ownsFlat)
  await sc.restoreState({ painted: true })
  await sleep(30); await nextTick()          // 冲掉 restoreState 引发的 rAF 合帧
  const zero = () => { scene.n.field = scene.n.guides = scene.n.rays = scene.n.cleared = 0; flat.n.field = 0 }
  return { g, sc, scene, flat, zero }
}

// ===== ① 2D 平面图 + 收起侧栏：面板读数没人看了，但那块场还归自己 =====
{
  const { g, sc, scene, flat, zero } = await rig()
  g.isFlat = true; g.flatActive = true
  g.panelOn = false                          // 侧栏收起 → 面板读数不用现算
  g.ownsFlat = true                          // 上下文仍停在对星覆盖分析 → 场还归自己
  zero(); sc.recompute()
  ok('① 收起侧栏后 2D 那块场照喂', flat.n.field === 1, `setField ×${flat.n.field}`)
  ok('① 2D 期间不碰 3D 通道', scene.n.field === 0)
}

// ===== ② 真的切到对地视图：归属交还，一下都不许碰 =====
// 天线设置是两视图共享的（watch(grd.s)），对地改一次填充本视图同样被唤醒 —— 照写就会把对地
// 刚画好的层整体换成自己的（selected 通常为空＝直接清空），症状是「覆盖闪一下就没」。
{
  const { g, sc, flat, zero } = await rig()
  g.isFlat = true; g.flatActive = true; g.panelOn = false
  g.ownsFlat = false
  zero(); sc.recompute()
  ok('② 交还归属后不碰 2D 那块场', flat.n.field === 0, `setField ×${flat.n.field}`)
}

// ===== ③ 3D 视图 + 收起侧栏：壳层是场景内容，离开面板不撤、继续跟着走 =====
{
  const { g, sc, scene, flat, zero } = await rig()
  g.isFlat = false; g.flatActive = false     // 3D 视图：2D 画布不可见（往那儿烘 Path2D 是白做）
  g.panelOn = false; g.ownsFlat = true
  zero(); sc.recompute()
  ok('③ 收起侧栏后壳层照推', scene.n.field === 1, `setShellField ×${scene.n.field}`)
  ok('③ 天线视轴跟着推', scene.n.rays === 1)
  ok('③ 3D 视图下不烘 2D', flat.n.field === 0)
  // 键控：参照网只随壳层库/样式变，与时间无关 —— 播放时每拍销毁重建几千顶点纯属白做
  ok('③ 参照网键控：设置没变就不重建', scene.n.guides === 0)
  sc.s.guideStep = 15
  await sleep(30)                            // 设置变更走 rAF 合帧
  ok('③ 改了参照网样式照样重建（收起侧栏也认设置）', scene.n.guides === 1, `setShellGuides ×${scene.n.guides}`)
}

// ===== ④ 从没画过：收起侧栏时一次也不该凭空往球上糊 =====
{
  const g = { panelOn: false, ownsFlat: true, isFlat: false, flatActive: true }
  const grd = makeGrd(), scene = makeScene(), flat = makeFlat()
  const sc = useShellCoverage(grd, () => scene, () => flat, () => g.isFlat,
    () => g.panelOn, () => g.flatActive, () => g.ownsFlat)
  sc.recompute()
  ok('④ 没画过 + 面板没开 → 两条通道都不碰', scene.n.field === 0 && flat.n.field === 0)
  g.panelOn = true; sc.recompute()           // 进面板＝画过了
  g.panelOn = false; sc.recompute()          // 再收起
  ok('④ 进过面板之后收起侧栏照推', scene.n.field === 2, `setShellField ×${scene.n.field}`)
}

// ===== ⑤ 清除绘图：2D 那块场按归属清，不归自己时不许替对地清 =====
{
  const { g, sc, scene, flat, zero } = await rig()
  g.ownsFlat = false
  zero(); sc.clearAll()
  ok('⑤ 不归自己：清 3D 但不碰 2D', scene.n.cleared === 1 && flat.n.field === 0)

  const r2 = await rig()
  r2.g.ownsFlat = true
  r2.zero(); r2.sc.clearAll()
  ok('⑤ 归自己：2D 那块场一并清空', r2.flat.n.field === 1)
  r2.g.panelOn = false
  r2.zero(); r2.sc.recompute()
  ok('⑤ 清空后回到「没画过」，收起侧栏不自行复现', r2.scene.n.field === 0)
}

// ===== ⑥ 默认参数向后兼容：只传 4~6 个参数的调用方（验证台）行为不变 =====
{
  const grd = makeGrd(), scene = makeScene()
  const sc = useShellCoverage(grd, () => scene)     // panelOn 默认 true，ownsFlat 默认跟随 panelOn
  sc.recompute()
  ok('⑥ 省略新参数照样出图', scene.n.field === 1, `setShellField ×${scene.n.field}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
