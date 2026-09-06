// 2D 平面图静态快照调度口径（src/viz/flatmap/rebuildPolicy.js）的纯函数自测。运行：npm test
// 被测文件是渲染端 ESM，故本测试自身也是 .mjs。
//
// 这一层不出数，出的是「手势里到底重不重建」的判断 —— 判错一次就是一帧 100 ms 的顶住，
// 而且不会报错、只会「有点卡」。关键不变式：
//   ① 视角类按半倍频程分档：同一档内的缩放不换类，跨半个倍频程才换；
//   ② 迟滞两头不对称：一次贵读数立刻翻成贵；要连续三次便宜【且衰减最大值也降下来】才翻回便宜；
//   ③ 没量过的类一律当作贵（缺省 UNKNOWN_COST），于是缺省路是缩位图而不是同步重建；
//   ④ 平移量化：任意 DPR 下量化后的位移【恒为整设备像素】，且反复量化不累积误差；
//   ⑤ 快照摆放：同 k 平移量化后 exact 必真；缩放期 exact 必假；covers 判的是「世界矩形 ∩ 视口」，
//      故全图视角（世界整个在快照里）平移多远都盖得住；
//   ⑥ 回退快照：新的盖得住旧的就不留；挑的时候按面积从大到小、尺寸对不上的跳过；
//   ⑦ evenodd 裁剪给的是「视口 + 当前快照矩形」两个矩形（不给就地名叠两层）；
//   ⑧ moved 与 dx 分家：dx 是贴图坐标（＝ rx − mx），带余量的快照一动没动也 ≠ 0 ——
//      拿 dx 当「搬过位置」判据就会在任何放大视角上静止时无限循环重建（§11.1）。
import {
  REBUILD_FAST_MS, IDLE_MIN_MS, IDLE_MAX_MS, ZOOM_RUN_MS, NOMINAL_MIN, NOMINAL_MAX, UNKNOWN_COST,
  viewCls, makeCostTable, quantPan, makePanQuant, idleMsFor, hotMsFor, nominalFromGaps,
  uncoveredMode, needsRestRebuild,
  placeSnapshot, worldCover, coversSubset, pickFallbackIdx, clipRects, stripRects
} from '../../../src/viz/flatmap/rebuildPolicy.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++ } else { fail++; console.error('  ✗ ' + m) } }
const eq = (a, b, m) => ok(a === b, m + ' — 实得 ' + JSON.stringify(a) + '，应为 ' + JSON.stringify(b))
const near = (a, b, e, m) => ok(Math.abs(a - b) <= e, m + ' — 实得 ' + a + '，应为 ' + b + '±' + e)

// ── ① 视角类分档 ────────────────────────────────────────────────────────────
{
  const c = (kDev) => viewCls('10m', true, 'equirect', kDev)
  eq(c(8), c(8 * 1.15), '同一半倍频程内不换类')                // log2 差 0.20 → ×2 = 0.40，四舍五入同档
  ok(c(8) !== c(8 * 2), '差一个倍频程必换类')
  ok(viewCls('10m', true, 'equirect', 8) !== viewCls('50m', true, 'equirect', 8), '底图档进类名')
  ok(viewCls('10m', true, 'equirect', 8) !== viewCls('10m', false, 'equirect', 8), '影像开关进类名')
  ok(viewCls('10m', true, 'equirect', 8) !== viewCls('10m', true, 'azeq', 8), '投影进类名')
  eq(viewCls('10m', false, 'equirect', 0), '10m||equirect|0', 'k=0（还没 fit）不炸、给 0 档')
}

// ── ②③ 迟滞与缺省 ──────────────────────────────────────────────────────────
{
  const t = makeCostTable()
  eq(t.cost('X'), UNKNOWN_COST, '没量过的类：缺省代价 = UNKNOWN_COST')
  eq(t.cheap('X'), false, '没量过的类：一律当作贵')

  // 便宜 → 要连续三次才翻
  t.note('A', 1); ok(!t.cheap('A'), '一次便宜读数不够翻档')
  t.note('A', 1); ok(!t.cheap('A'), '两次便宜读数仍不够')
  t.note('A', 1); ok(t.cheap('A'), '连续三次便宜 → 翻成便宜')
  // 贵 → 一次就翻回
  t.note('A', 40); ok(!t.cheap('A'), '一次贵读数立刻翻回贵')
  t.note('A', 1); t.note('A', 1); t.note('A', 1)
  ok(!t.cheap('A'), '衰减最大值还没降到门槛之下：三次便宜也不翻（40→24→14.4→8.64）')
  t.note('A', 1); ok(t.cheap('A'), '再来一次，衰减最大值 5.18 < 8 → 翻成便宜')

  // 探针漏读（只读到主线程那几毫秒）不该把 100 ms 的视角判成便宜
  const t2 = makeCostTable()
  t2.note('B', 120); t2.note('B', 1.3); t2.note('B', 110); t2.note('B', 1.3)
  ok(!t2.cheap('B'), '贵读数中间夹漏读：仍判贵')
  ok(t2.cost('B') > REBUILD_FAST_MS, '代价读数保持在门槛之上')
}

// ── 自适应静止阈值 / 热窗口 ─────────────────────────────────────────────────
{
  eq(idleMsFor(1), IDLE_MIN_MS, '便宜的视角：静止阈值取下限')
  eq(idleMsFor(1000), IDLE_MAX_MS, '很贵的视角：静止阈值取上限')
  near(idleMsFor(60), 150, 1e-9, '中间带：2.5 × 代价')
  eq(hotMsFor(true, 110), 110, '便宜的视角：热窗口就是静止阈值（一格滚完就清晰）')
  eq(hotMsFor(false, 110), ZOOM_RUN_MS, '贵的视角：热窗口拉到整串滚轮的节奏')
  eq(hotMsFor(false, IDLE_MAX_MS), IDLE_MAX_MS, '贵且静止阈值已到上限：取二者较大')
  // nominal ＝ 连排空 rAF 的时间戳差取中位数后钳在 [4,20]（§11.4：绝不能从 draw() 的间隔估）
  eq(nominalFromGaps([0.2, 0.1, 0.3, 0.2, 0.1]), NOMINAL_MIN, '验证台无 vsync（gap≈0）：钳到下限，不许算成负 extra')
  near(nominalFromGaps([6.9, 6.8, 7.0, 6.9, 6.9]), 6.9, 1e-9, '144 Hz：跟到真实刷新周期')
  near(nominalFromGaps([16.7, 16.6, 16.8, 16.7, 16.7]), 16.7, 1e-9, '60 Hz：跟到真实刷新周期')
  eq(nominalFromGaps([16.7, 16.6, 300, 16.8, 16.7]), 16.7, '中间掉一帧（300 ms）：中位数不受影响')
  eq(nominalFromGaps([40, 45, 50]), NOMINAL_MAX, '刷新率极低 / 被节流：钳到上限')
  eq(nominalFromGaps([], 12), 12, '一格都没量到：保持原值')
  eq(nominalFromGaps([-3, 0, 6.9, 6.9], 12), 6.9, '负值与 0（时钟回拨 / 同一拍）剔掉再取中位数')
  // ★ 反例：draw() 的间隔里混着 resizeNow 那种同步 draw（0～3 ms），拿它估就把 nominal 钉死在下限
  eq(nominalFromGaps([16.7, 0.4, 16.7, 0.9, 16.6]), 16.6, '同步 draw 混进来：中位数仍是刷新周期（滚动最小值会钉死在 0.4）')
}

// ── ④ 平移量化 ─────────────────────────────────────────────────────────────
for (const dpr of [1, 1.25, 1.5, 2, 3]) {
  const v = quantPan(123.456, dpr)
  near(v * dpr, Math.round(v * dpr), 1e-9, 'DPR ' + dpr + '：量化后落在整设备像素上')
  // 带残差的连续小位移：光标走多远图就走多远，误差恒 < 一个设备像素
  const q = makePanQuant()
  let x = 0, y = 0
  for (let i = 0; i < 200; i++) { const r = q.step(x, y, 0.37, -0.11, dpr); x = r[0]; y = r[1] }
  near(x, 74, 1 / dpr, 'DPR ' + dpr + '：200 次 +0.37 px 累加，误差不超过一个设备像素')
  near(y, -22, 1 / dpr, 'DPR ' + dpr + '：200 次 −0.11 px 累加（每次都不足半个设备像素）也跟得住')
  near(x * dpr, Math.round(x * dpr), 1e-9, 'DPR ' + dpr + '：每一步都仍落在整设备像素上')
  q.reset()
  const r0 = q.step(10, 10, 0, 0, dpr)
  near(r0[0], quantPan(10, dpr), 1e-9, 'reset 之后残差清零（结果只由量化本身定）')
}

// ── ⑤ 快照摆放 ─────────────────────────────────────────────────────────────
const V = { k: 3.556, tx: 0, ty: 40, dpr: 1.5, cwDev: 1920, chDev: 1080, W: 360, H: 180 }
const recAt = (o = {}) => ({ k: V.k, tx: 0, ty: 40, mx: 0, my: 0, w: 1920, h: 1080, ...o })
{
  // 同 k、位移已量化 → exact
  const view = { ...V, tx: quantPan(37.3, V.dpr) }
  const pl = placeSnapshot(recAt(), view)
  ok(!pl.scaled, '同 k：不是缩位图')
  ok(pl.exact, '量化后的位移：exact 为真（于是拖动全程不补建）')
  near(pl.dx, Math.round(pl.dx), 1e-9, '贴图位移落在整设备像素上')
  ok(pl.moved, '搬过位置：moved 为真')

  // 未量化的位移 → exact 为假（这正是改造前每次停顿都补建的根因）
  ok(!placeSnapshot(recAt(), { ...V, tx: 37.3 }).exact, 'DPR 1.5 下未量化的位移：exact 为假')

  // ★ §11.1：带余量的快照【一动没动】—— moved 必须为假，而 dx 恒 = −mx ≠ 0。
  //   判据用 dx 的那一版：静止时每帧 blit 都排一次补建 → 补建又催出探针帧 → 再排补建，
  //   以 idleMs 为周期无限循环整份重建（实测放大 t=0.3 静止 2.5 s 里 42 帧、周期 ≈ 130 ms）。
  const held = placeSnapshot({ k: V.k, tx: 0, ty: 40, mx: 346, my: 194, w: 1920 + 692, h: 1080 + 388 }, V)
  ok(!held.moved, '带余量、视图一动没动：moved 为假 → 静止后一次都不补建')
  eq(held.dx, -346, '同一张的 dx 却是 −mx（正是不能拿它当判据的理由）')
  ok(held.covers && held.exact, '同上：盖得住且 exact（画面就是这张位图）')
  const held0 = placeSnapshot(recAt(), V)
  ok(!held0.moved && held0.dx === 0, '余量为 0 且没动：moved 假、dx 也是 0（全图视角本来就不循环）')

  // 缩放期
  const z = placeSnapshot(recAt(), { ...V, k: V.k * 1.2 })
  ok(z.scaled && !z.exact, '缩放期：缩位图且 exact 恒假')
  ok(z.moved, '缩位图：moved 恒真（缩过的位图一律静止后补建）')
  near(z.w, 1920 * 1.2, 1e-6, '缩位图宽度按 k 比例')

  // covers：全图视角（世界整个在快照里）平移多远都盖得住
  const far = placeSnapshot(recAt(), { ...V, tx: 400, ty: 200 })
  ok(far.covers, '全图视角平移 400 px：世界矩形 ∩ 视口仍在快照内 → 盖得住')
  // 放大到世界伸出视口之后平移出去 → 盖不住
  const big = { k: 40, tx: -2000, ty: -1000, mx: 128, my: 128, w: 1920 + 256, h: 1080 + 256 }
  const off = placeSnapshot(big, { ...V, k: 40, tx: -2000 - 900, ty: -1000 })
  ok(!off.covers, '放大视角横向平移 900 px：盖不住')
  // ★ §11.3：盖不住的这一张【不是缩位图】—— 平移盖不住且没有回退时一律同步重建，
  //   不许走海色垫底（放大视角的类几乎永远判不成「便宜」，走海色就是一条空海跟着光标走）。
  ok(!off.scaled && off.moved, '平移盖不住：非缩位图且搬过位置 → 走 uncovered 同步重建那一支')
  const shrink = placeSnapshot(big, { ...V, k: 8 })
  ok(shrink.scaled && !shrink.covers, '从放大视角缩小：缩位图且盖不住 → 才是海色垫底那一支')
}

// ── ⑥ 回退快照 ─────────────────────────────────────────────────────────────
{
  const world = recAt()                                        // 全图
  const zoom = { k: 40, tx: -2000, ty: -1000, mx: 128, my: 128, w: 2176, h: 1336 }
  const cw = worldCover(world, 1.5), cz = worldCover(zoom, 1.5)
  ok(!coversSubset(cz, cw), '放大之后的那张盖不住全图那张 → 全图那张要留着当回退')
  ok(coversSubset(cw, cz), '反过来：全图那张盖得住放大那张 → 缩回去时旧的不必留')
  ok(cw.x1 - cw.x0 > cz.x1 - cz.x0, '全图那张在世界坐标里更宽')

  // 挑选：按面积从大到小，尺寸对不上的跳过
  const mk = (o) => ({ ...o, cw: o.w, ch: o.h })
  const list = [mk({ ...world, area: 1 }), mk({ ...zoom, area: 0.1 })]
  eq(pickFallbackIdx(list, { ...V, k: V.k, tx: 0, ty: 40 }), 0, '当前视图 = 全图：挑第一张（面积最大且盖得住）')
  const stale = [{ ...world, cw: 1280, ch: 720, area: 1 }]     // resize 之后画布尺寸对不上
  eq(pickFallbackIdx(stale, V), -1, 'resize 之后尺寸对不上的回退快照：跳过，不按旧尺寸贴')
  eq(pickFallbackIdx([], V), -1, '一张都没有：返回 −1')
  // 放大到快照之外：全图那张仍盖得住（世界整个在里面），放大那张盖不住
  eq(pickFallbackIdx([mk({ ...zoom, area: 0.1 })], { ...V, k: 40, tx: -2000 - 3000, ty: -1000 }), -1,
    '离得太远：连唯一那张回退也盖不住 → 走海色垫底')
  // 2026-09-07：盖得住的里面挑【缩放比最接近】的（全图背板恒盖得住，但缩得最多、最糊 —— 不能因为面积大就先选它）
  const mid = { k: 12, tx: -600, ty: -300, mx: 0, my: 0, w: 1920, h: 1080 }
  const bp = { k: V.k, tx: 0, ty: 40, mx: 0, my: 0, w: 1920, h: 1080 }          // 全图背板（fit 比例）
  const viewMid = { ...V, k: 13, tx: -650, ty: -325 }   // 与 mid 同一个世界锚点（dx=dy=0），只是放大了 13/12
  ok(placeSnapshot(mk(mid), viewMid).covers && placeSnapshot(mk(bp), viewMid).covers, '两张都盖得住这个视图')
  eq(pickFallbackIdx([mk({ ...bp, area: 1 }), mk({ ...mid, area: 0.1 })], viewMid), 1, '两张都盖得住：挑 k 最接近的那张，不是面积最大的')
  eq(pickFallbackIdx([mk({ ...bp, area: 1 }), mk({ ...mid, area: 0.1 })], { ...V, k: 13, tx: -3000, ty: -325 }), 0, '近的那张盖不住了：退到背板')
}

// ── 增量条带：旧位图搬 (dx, dy) 之后露出来的那一圈 ────────────────────────────
{
  const area = (rs) => rs.reduce((a, r) => a + r[2] * r[3], 0)
  eq(stripRects(0, 0, 100, 50).length, 0, '没搬：一块都不露')
  eq(JSON.stringify(stripRects(10, 0, 100, 50)), JSON.stringify([[0, 0, 10, 50]]), '右搬 10：左边露一竖条')
  eq(JSON.stringify(stripRects(-10, 0, 100, 50)), JSON.stringify([[90, 0, 10, 50]]), '左搬 10：右边露一竖条')
  eq(JSON.stringify(stripRects(0, 7, 100, 50)), JSON.stringify([[0, 0, 100, 7]]), '下搬 7：上边露一横条')
  eq(JSON.stringify(stripRects(0, -7, 100, 50)), JSON.stringify([[0, 43, 100, 7]]), '上搬 7：下边露一横条')
  const L = stripRects(10, 7, 100, 50)
  eq(L.length, 2, '斜搬：一竖条 + 一横条（允许重叠，只做 clip 与清底）')
  ok(area(L) >= 10 * 50 + 100 * 7 - 10 * 7, '两块并起来至少盖住 L 形')
  eq(JSON.stringify(stripRects(500, 0, 100, 50)), JSON.stringify([[0, 0, 100, 50]]), '搬出画布：整块都露（钳到画布）')
}

// ── ⑧ 盖不住时走哪一支 / 静止后要不要补建（§11.1、§11.3）──────────────────
{
  const pan = { scaled: false, exact: true, covers: false, moved: true }      // 平移出快照
  const shrink = { scaled: true, exact: false, covers: false, moved: true }   // 缩小（缩位图）
  eq(uncoveredMode(pan, true, false), 'fallback', '有回退：先垫回退（哪一支都一样）')
  eq(uncoveredMode(shrink, true, false), 'fallback', '缩小且有回退：同上')
  eq(uncoveredMode(pan, false, false), 'rebuild', '★ 平移盖不住 + 没回退 + 判贵：仍同步重建，不许走海色')
  eq(uncoveredMode(pan, false, true), 'rebuild', '平移盖不住 + 没回退 + 判便宜：同步重建')
  eq(uncoveredMode(shrink, false, false), 'ocean', '缩小盖不住 + 没回退 + 判贵：这一支才垫海色')
  eq(uncoveredMode(shrink, false, true), 'rebuild', '缩小盖不住 + 没回退 + 判便宜：直接重建')

  // ★ §11.1：带余量、没动过的 blit 一次都不补建 —— 这正是无限循环的那条判据
  const held = { scaled: false, exact: true, covers: true, moved: false, dx: -346, dy: -194 }
  ok(!needsRestRebuild(held, false), '带余量、视图没动：不排补建（拿 dx 判就会以 idleMs 为周期无限循环）')
  ok(needsRestRebuild({ ...held, moved: true }, false), '搬过位置：补建')
  ok(needsRestRebuild({ ...held, covers: false }, false), '盖不住：补建')
  ok(needsRestRebuild({ ...held, exact: false }, false), '位移落不到整设备像素：补建')
  ok(needsRestRebuild(held, true), '手势中到货的瓦片：静止后补建一并收（不作废内容，见 §11.2）')
}

// ── ⑦ evenodd 裁剪矩形 ─────────────────────────────────────────────────────
{
  const pl = { dx: 100, dy: 50, w: 800, h: 400 }
  const rs = clipRects(pl, 1920, 1080)
  eq(rs.length, 2, '两个矩形：视口 + 当前快照')
  eq(JSON.stringify(rs[0]), JSON.stringify([0, 0, 1920, 1080]), '第一个是整个视口')
  eq(JSON.stringify(rs[1]), JSON.stringify([100, 50, 800, 400]), '第二个是当前快照摆放后的矩形')
}

console.log(`flatRebuildPolicy: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
