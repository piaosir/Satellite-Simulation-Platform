// 可见性分析「时间覆盖」严口径自测（src/viz/vis/visibility.js · timeCoverage）。运行：npm test
// 被测文件是渲染端 ESM，故本测试自身也是 .mjs。
//
// 这个百分数会被当作「这条链路一天里有多少时间能用」直接引用，算松了就是骗人。严口径三条不变式：
//   ① 合并重叠：多星（或同星多窗）同时可见只计一次 —— 各次时长求和会重复计数、能超 100%，那不是覆盖率；
//   ② 夹到时窗：窗口越界（负 start / 超 horizon 的 truncated 窗）只计落在 [0,H] 内的那一段；
//   ③ 中断含首尾：时窗开头/末尾没覆盖也算一段中断（与 coverageGrid 的 revisit FOM 同口径）。
// 另验退化输入（空清单 / H≤0 / NaN 边界）不产出 NaN、不除零 —— 这三个位置一出 NaN 侧栏读数就整行崩。
import { timeCoverage } from '../../../src/viz/vis/visibility.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
// 造 accessWindows 形状的结果：sats = [[[start,end], ...], ...]（每颗星一组相对分钟窗口）
const mk = (sats) => sats.map((ws, i) => ({
  noradId: 1000 + i, name: 'SAT-' + i, group: 't',
  windows: ws.map(([a, b]) => ({ startMin: a, endMin: b, durMin: b - a, peakEl: 30, peakMin: (a + b) / 2, truncated: false }))
}))

// ---- ① 合并重叠：同时可见不重复计数 ----
{
  const H = 100
  ok('单窗：10 分钟 / 100 分钟 = 10%', near(timeCoverage(mk([[[0, 10]]]), H).pct, 10))

  // 两星窗口完全重合 → 覆盖仍是 10 分钟（求和会得 20 分钟 = 20%，那是错的）
  const dup = timeCoverage(mk([[[20, 30]], [[20, 30]]]), H)
  ok('两星窗口完全重合 → 只计一次', near(dup.coveredMin, 10) && near(dup.pct, 10), `coveredMin=${dup.coveredMin}`)

  // 部分重叠 [10,30] ∪ [20,45] = [10,45] = 35 分钟（求和会得 45）
  const ovl = timeCoverage(mk([[[10, 30]], [[20, 45]]]), H)
  ok('部分重叠 → 取并集 35min', near(ovl.coveredMin, 35), `coveredMin=${ovl.coveredMin}`)

  // 一窗完全包住另一窗 → 取外层
  const nest = timeCoverage(mk([[[10, 60]], [[20, 30]]]), H)
  ok('内含窗被吸收 → 50min', near(nest.coveredMin, 50), `coveredMin=${nest.coveredMin}`)

  // 输入顺序不影响结果（内部按 start 排序）：把包含关系倒序喂进去
  const nestRev = timeCoverage(mk([[[20, 30]], [[10, 60]]]), H)
  ok('乱序输入结果一致', near(nestRev.coveredMin, nest.coveredMin))

  // 三窗链式重叠（前一窗尾接后一窗头之前）→ 合成一段
  const chain = timeCoverage(mk([[[0, 20], [40, 60]], [[15, 45]]]), H)
  ok('链式重叠合成一段 0~60', near(chain.coveredMin, 60) && chain.gapCount === 1, `coveredMin=${chain.coveredMin} gaps=${chain.gapCount}`)

  // 首尾相接（不重叠也不留缝）→ 合成一段、不产生 0 长度中断
  const touch = timeCoverage(mk([[[0, 30], [30, 50]]]), H)
  ok('首尾相接不算中断', near(touch.coveredMin, 50) && touch.gapCount === 1, `gaps=${touch.gapCount}`)

  // 铺满整个时窗 → 100%、无中断
  const full = timeCoverage(mk([[[0, 50], [50, 100]]]), H)
  ok('铺满时窗 = 100% 且 0 段中断', near(full.pct, 100) && full.gapCount === 0 && near(full.maxGapMin, 0))

  // 数量级压力：50 星 × 每星整条时窗，求和口径会得 5000%，并集必须钉在 100%
  const many = timeCoverage(mk(Array.from({ length: 50 }, () => [[0, H]])), H)
  ok('50 星全时段可见仍是 100%（不超 100）', near(many.pct, 100), `pct=${many.pct}`)
}

// ---- ② 夹到时窗：越界窗口只计窗内那一段 ----
{
  const H = 100
  const over = timeCoverage(mk([[[90, 130]]]), H)         // truncated 窗超出 horizon
  ok('窗口超出时窗末 → 只计 10min', near(over.coveredMin, 10) && near(over.pct, 10), `coveredMin=${over.coveredMin}`)

  const neg = timeCoverage(mk([[[-20, 10]]]), H)          // 起点为负（理论上不该有，防御性）
  ok('窗口起点为负 → 从 0 起算', near(neg.coveredMin, 10), `coveredMin=${neg.coveredMin}`)

  const outside = timeCoverage(mk([[[120, 150]]]), H)     // 整窗在时窗外
  ok('整窗在时窗外 → 0%、整窗为中断', near(outside.pct, 0) && near(outside.maxGapMin, H) && outside.gapCount === 1)

  const zero = timeCoverage(mk([[[30, 30]]]), H)          // 零长度窗
  ok('零长度窗被丢弃（不产生 0 段）', near(zero.pct, 0) && zero.gapCount === 1)

  ok('pct 恒被夹在 [0,100]', timeCoverage(mk([[[-1e6, 1e6]]]), H).pct === 100)
}

// ---- ③ 中断含首尾（与 revisit FOM 同口径）----
{
  const H = 100
  // 窗 [20,30] [60,70] → 中断 (0,20) (30,60) (70,100) 共 3 段，最长 30
  const g = timeCoverage(mk([[[20, 30], [60, 70]]]), H)
  ok('首/中/尾三段中断都计入', g.gapCount === 3, `gaps=${g.gapCount}`)
  ok('最长中断取中段 30min', near(g.maxGapMin, 30), `maxGap=${g.maxGapMin}`)
  ok('覆盖时长 20min / 20%', near(g.coveredMin, 20) && near(g.pct, 20))

  // 开头就在过境中 → 无首段中断
  const head = timeCoverage(mk([[[0, 40]]]), H)
  ok('时窗开头即可见 → 无首段中断', head.gapCount === 1 && near(head.maxGapMin, 60), `gaps=${head.gapCount}`)

  // 末尾被时窗切断 → 无尾段中断
  const tail = timeCoverage(mk([[[40, 100]]]), H)
  ok('时窗末尾仍可见 → 无尾段中断', tail.gapCount === 1 && near(tail.maxGapMin, 40), `gaps=${tail.gapCount}`)

  // 从不可见 → 中断 = 整个时窗（最差），与 coverageGrid revisit「从不覆盖→整窗」一致
  const none = timeCoverage([], H)
  ok('空清单 → 0%、中断=整窗', near(none.pct, 0) && near(none.maxGapMin, H) && none.gapCount === 1)
}

// ---- 退化输入：不出 NaN、不除零 ----
{
  const finite = (o) => Number.isFinite(o.pct) && Number.isFinite(o.coveredMin) && Number.isFinite(o.maxGapMin) && Number.isFinite(o.horizonMin)
  ok('H=0 → 全 0 且有限', finite(timeCoverage(mk([[[0, 10]]]), 0)) && timeCoverage(mk([[[0, 10]]]), 0).pct === 0)
  ok('H 为负 → 全 0 且有限', finite(timeCoverage(mk([[[0, 10]]]), -5)))
  ok('H 为 NaN → 全 0 且有限', finite(timeCoverage(mk([[[0, 10]]]), NaN)))
  ok('results 为 null → 有限', finite(timeCoverage(null, 100)))
  ok('windows 缺失 → 有限', finite(timeCoverage([{ noradId: 1, name: 'X' }], 100)))
  const nan = timeCoverage([{ windows: [{ startMin: NaN, endMin: 10 }, { startMin: 0, endMin: 10 }] }], 100)
  ok('单个 NaN 窗被跳过、其余照算', near(nan.coveredMin, 10) && finite(nan), `coveredMin=${nan.coveredMin}`)
  ok('horizonMin 原样回传（供 UI 做分母/横轴）', timeCoverage(mk([[[0, 10]]]), 1440).horizonMin === 1440)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
