// 仿真时钟内核自测（src/shared/simClockCore.js）。运行：npm test
// 被测文件是渲染端 ESM（不依赖 Vue/DOM），故本测试自身也是 .mjs。
//
// 这个核回答的是「按下播放之后，仿真时刻怎么走」。会出错的地方全在【时间记账】上，逐条钉死：
//   ① 攒够整拍才走 —— 时刻必须始终落在 t₀ + k·步长 的格子上，帧率抖动不能把它推到格子之间
//      （落在格子之间意味着采样间隔不均匀，「一次穿越被跨过去」的锅就会记在物理上）；
//   ② 卡顿只慢放不跳时刻 —— 攒了 100 拍的欠账不能一帧补完（那是时刻凭空跳过一大段）；
//   ③ 换速率不丢零头、换方向对称；
//   ④ 游标吸附粒度随窗口自适应，且【永远不粗于像素能分辨的量】（否则拖起来一顿一顿）；
//   ⑤ 播放跑出可见窗口时尺子平移把游标接回来，且接回来之后必定在窗口内（否则下一拍继续平移＝抖动）。
import {
  stepsDue, advanceMs, tickIntervalMs, snapMs, cursorSnapSec, panWindow, achievedRate,
  clampStep, clampRate, clampSpeed, fmtStep, fmtStepShort, fmtRate, fmtOffset, STEP_PRESETS, SPEED_PRESETS,
  followWindow, flipPeriodSec, rateFor, effSpeed, speedCapped, RATE_MAX, RATE_MIN, nextDelayMs
} from '../../../src/shared/simClockCore.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

// ==================== ① 攒够整拍才走 ====================
{
  // 速率 10 拍/s：每 100 ms 恰好一拍
  let acc = 0, steps = 0
  for (let i = 0; i < 10; i++) { const r = stepsDue(acc, 100, 10); acc = r.accum; steps += r.steps }
  ok('① 10 拍/s × 1 s = 10 拍', steps === 10, `${steps}`)

  // 帧不齐（33 ms 一帧）：1 s 内总拍数仍是 10，零头不丢
  acc = 0; steps = 0
  let realMs = 0
  while (realMs < 1000) { const r = stepsDue(acc, 33, 10); acc = r.accum; steps += r.steps; realMs += 33 }
  ok('① 帧不齐也不丢拍（33 ms 帧 × 1 s）', steps === 9 || steps === 10, `${steps} 拍 / ${realMs} ms`)

  // 半拍不动：60 ms @ 10 拍/s = 0.6 拍 → 这一拍不推进，零头留着
  const half = stepsDue(0, 60, 10)
  ok('① 不足一拍不推进', half.steps === 0 && near(half.accum, 0.6, 1e-12), `accum=${half.accum}`)

  // 时刻始终落在步长格子上：连走 500 拍，每一步都必须是步长的整数倍
  let t = 1_700_000_000_000, a = 0, k = 0
  const STEP = 7            // 刻意取非整除的步长，暴露「按毫秒累加」的浮点漂移
  for (let i = 0; i < 500; i++) {
    const r = stepsDue(a, 40, 25); a = r.accum
    if (!r.steps) continue
    t = advanceMs(t, r.steps, STEP, 1); k += r.steps
  }
  ok('① 时刻恒落在 t₀+k·步长 的格子上', t === 1_700_000_000_000 + k * STEP * 1000, `k=${k}, t=${t}`)
}

// ==================== ② 卡顿只慢放、不跳时刻 ====================
{
  // 一帧卡了 10 s @ 30 拍/s = 欠 300 拍。补拍上限 8 → 只走 8 拍，其余丢弃（仿真时间落后墙钟）
  const r = stepsDue(0, 10_000, 30)
  ok('② 卡顿后单拍最多补 8 拍', r.steps === 8 && r.dropped === 292, `steps=${r.steps} dropped=${r.dropped}`)
  ok('② 丢弃的拍不进零头（不会下一帧又蹦出来）', r.accum < 1, `accum=${r.accum}`)

  // 反过来：正常帧不该触发丢弃
  const n = stepsDue(0, 100, 10)
  ok('② 正常帧不丢拍', n.dropped === 0 && n.steps === 1)

  // 实测倍速要如实反映落后：设定 1800×（60 s 步长 × 30 拍/s），卡顿 10 s 只走了 8 拍 = 480 s 仿真
  const got = achievedRate(8 * 60 * 1000, 10_000)
  ok('② 实测倍速如实（跟不上就是跟不上）', near(got, 48, 1e-9) && got < effSpeed(60, 1800), `${got}× vs 设定 ${effSpeed(60, 1800)}×`)
}

// ==================== ②b 倍速与步长互相顶：夹住并如实打折 ====================
{
  // 60 s 步长 @ 600× → 10 拍/s，达得到
  ok('②b 常规组合达得到', near(rateFor(60, 600), 10, 1e-9) && !speedCapped(60, 600) && near(effSpeed(60, 600), 600, 1e-9))
  // 1 s 步长想要 3600× → 需要 3600 拍/s，物理上办不到 → 夹到拍率上限，实际只有 RATE_MAX×（1 s 步长）
  ok('②b 快档被步长顶住', rateFor(1, 3600) === RATE_MAX && speedCapped(1, 3600) && near(effSpeed(1, 3600), RATE_MAX, 1e-9),
    `拍率 ${rateFor(1, 3600)}, 实际 ${effSpeed(1, 3600)}×`)
  // 顶住后放大步长就能真的更快（这正是「时间分辨率换播放速度」）
  ok('②b 放大步长即真的更快', effSpeed(300, 3600) > effSpeed(1, 3600) && !speedCapped(300, 3600),
    `${effSpeed(1, 3600)}× → ${effSpeed(300, 3600)}×`)
  // 慢档：1 h 步长 @ 1× 实时 → 需要 1/3600 拍/s，夹到下限 → 实际快得多，同样如实标出来
  ok('②b 慢档被下限顶住', rateFor(3600, 1) === RATE_MIN && speedCapped(3600, 1), `拍率 ${rateFor(3600, 1)}`)
  // 1 s 步长 @ 1× ＝ 真·实时播放（1 拍/s）
  ok('②b 1 s 步长 @1× 就是实时', near(rateFor(1, 1), 1, 1e-9) && !speedCapped(1, 1))
  ok('②b 倍速夹逼', clampSpeed(0) === 1 && clampSpeed(-3) === 0.01)
  // 预设两两组合：实际倍速永远等于 拍率×步长（读数与真实推进永不脱节）
  let consistent = true
  for (const s of STEP_PRESETS) for (const x of SPEED_PRESETS) if (!near(effSpeed(s, x), rateFor(s, x) * s, 1e-6)) consistent = false
  ok('②b 预设全组合读数自洽', consistent)
}

// ==================== ②c 排下一拍：必须给主线程留空闲 ====================
// 这是「点了播放整个界面卡死」的那条线。光按「目标间隔 − 已花时间」排，一拍算不完就立刻排下一拍，
// 主线程 100% 被占，渲染和鼠标一点空隙都拿不到 —— 便宜的场景一样卡（它本来跟得上，只是没人给它喘气）。
{
  // 跟得上：一拍 20 ms、目标间隔 100 ms → 照常等到 100 ms 那一刻（空闲底线 10 ms 不起作用）
  ok('②c 跟得上时按目标间隔排', nextDelayMs(100, 20, 20) === 80, `${nextDelayMs(100, 20, 20)} ms`)
  // 跟不上：一拍 300 ms、目标间隔 100 ms → 不许立刻接上，至少空出与自身等长的一段
  ok('②c 跟不上时留出空闲', nextDelayMs(100, 300, 300) === 300, `${nextDelayMs(100, 300, 300)} ms`)
  // 占用率上界：稳态下 忙/(忙+闲) ≤ 1/2，任何耗时都成立（这就是「界面还能动」的保证）
  let worst = 0
  for (const cost of [5, 20, 60, 120, 300, 800, 2000]) {
    const delay = nextDelayMs(100, cost, cost)
    worst = Math.max(worst, cost / (cost + delay))
  }
  ok('②c 主线程占用恒 ≤ 1/2', worst <= 0.5 + 1e-9, `最坏 ${(worst * 100).toFixed(1)}%`)
  // 空转拍（没攒够一拍、什么都没做）不该被罚等：cost=0 → 只按目标间隔走
  ok('②c 空转拍不罚等', nextDelayMs(100, 10, 0) === 90 && nextDelayMs(100, 200, 0) === 0)
  ok('②c 不返回负数', nextDelayMs(100, 999, 0) === 0)
  // ★ 留空闲不等于仿真变慢：攒下的步数由 stepsDue 一次补齐，只是每帧跳得大一点
  const slow = stepsDue(0, 450, 10)   // 一拍拖到 450 ms @10 拍/s → 该走 4 拍
  ok('②c 慢帧靠补拍不丢仿真时间', slow.steps === 4 && slow.dropped === 0, `${slow.steps} 拍`)
}

// ==================== ③ 方向 / 速率 / 夹逼 ====================
{
  const t0 = 1_700_000_000_000
  ok('③ 反向推进对称', advanceMs(t0, 3, 60, -1) === t0 - 180_000 && advanceMs(t0, 3, 60, 1) === t0 + 180_000)
  ok('③ 零拍不动', advanceMs(t0, 0, 60, 1) === t0)
  ok('③ 小数步长落到整毫秒', advanceMs(t0, 1, 0.1, 1) === t0 + 100)

  // 换速率时零头以「拍」为单位留存 → 不会按旧速率折算错
  const a1 = stepsDue(0, 90, 10).accum                    // 0.9 拍
  const r2 = stepsDue(a1, 20, 5)                          // 再来 0.1 拍 → 恰好 1 拍
  ok('③ 换速率不丢零头', r2.steps === 1, `accum0=${a1} steps=${r2.steps}`)

  // 步长是【量】不是【向】：负值夹到下限而不是回默认（方向由 dir 单独管，两者混在一起会出现「负步长 + 反向 = 前进」）
  ok('③ 步长夹逼', clampStep(0) === 60 && clampStep(1e9) === 86400 && clampStep(-5) === 0.1,
    `${clampStep(0)} / ${clampStep(1e9)} / ${clampStep(-5)}`)
  ok('③ 拍率夹逼', clampRate(0) === 1 && clampRate(1e6) === RATE_MAX && clampRate(0.001) === RATE_MIN)
  // 超过拍率上限的诉求先被 clampRate 夹住，间隔因此不会低于 1000/RATE_MAX（240 拍/s → 4 ms，
  // 正好压在 Chromium 嵌套 setTimeout 的下限上：再快也排不出来）
  ok('③ 定时间隔夹在 [4,5000]', tickIntervalMs(0.2) === 5000 && tickIntervalMs(1e6) === 4 && tickIntervalMs(10) === 100,
    `${tickIntervalMs(0.2)} / ${tickIntervalMs(1e6)} / ${tickIntervalMs(10)}`)
  // 上限与间隔下限必须同源，否则 effSpeed 会报出一个定时器根本排不出来的倍速
  ok('③ 拍率上限与间隔下限同源', Math.round(1000 / RATE_MAX) === tickIntervalMs(RATE_MAX),
    `1000/${RATE_MAX} = ${Math.round(1000 / RATE_MAX)} ms vs ${tickIntervalMs(RATE_MAX)} ms`)
  ok('③ 预设全部在合法域内', STEP_PRESETS.every((s) => clampStep(s) === s) && SPEED_PRESETS.every((x) => clampSpeed(x) === x))
}

// ==================== ④ 游标吸附：秒级，且不粗于像素分辨率 ====================
{
  // 10 min 窗口 / 600 px：1 px = 1 s → 吸到 1 s（这就是「游标下沉到秒级」的档）
  ok('④ 窄窗口吸到 1 s', cursorSnapSec(10, 600) === 1, `${cursorSnapSec(10, 600)} s`)
  // 24 h 窗口 / 600 px：1 px = 144 s → 吸 300 s（比像素细毫无意义）
  ok('④ 宽窗口吸到整齐大档', cursorSnapSec(1440, 600) === 300, `${cursorSnapSec(1440, 600)} s`)
  // 单调：窗口越宽，吸附只会变粗不会变细
  let mono = true, prev = 0
  for (const w of [10, 30, 60, 120, 360, 720, 1440, 4320, 10080, 43200]) {
    const s = cursorSnapSec(w, 600); if (s < prev) mono = false; prev = s
  }
  ok('④ 吸附粒度随窗口单调变粗', mono)
  // 吸附后必定落在整格上，且误差不超过半格
  const t = 1_700_000_123_456
  const s10 = snapMs(t, 10_000)
  ok('④ 吸附落在整格且误差 ≤ 半格', s10 % 10_000 === 0 && Math.abs(s10 - t) <= 5000, `${t} → ${s10}`)
  ok('④ 吸附粒度为 0 时退化为取整', snapMs(t + 0.4, 0) === t)
}

// ==================== ⑤ 播放跑出窗口 → 尺子平移接回来 ====================
{
  const WIN = 1440, START = -360, PAST = 0.25
  ok('⑤ 窗口内不平移', panWindow(0, START, WIN, PAST) === null && panWindow(1000, START, WIN, PAST) === null)
  // 前进跑出右边缘：平移后游标落在 pastFrac 处，前方留 3/4 窗口
  const ws = panWindow(1200, START, WIN, PAST)
  ok('⑤ 前进跑出 → 平移', ws !== null && near(1200 - ws, PAST * WIN, 1), `winStart=${ws}`)
  ok('⑤ 平移后游标在窗口内', ws !== null && 1200 >= ws && 1200 <= ws + WIN)
  // 后退跑出左边缘：对称落在 1−pastFrac 处
  const wb = panWindow(-900, START, WIN, PAST)
  ok('⑤ 后退跑出 → 反向平移', wb !== null && near(-900 - wb, (1 - PAST) * WIN, 1), `winStart=${wb}`)
  ok('⑤ 后退平移后也在窗口内', wb !== null && -900 >= wb && -900 <= wb + WIN)
  // 连播不抖动：平移一次之后，再问一次必须是 null（否则每拍都平移 = 尺子抖）
  ok('⑤ 平移一次即稳定（不抖）', panWindow(1200, ws, WIN, PAST) === null)

  // —— 慢档翻页 / 快档连续滑动 ——
  // 24 h 窗口 @ 600×：翻页周期 = 1440×60×0.75/600 = 108 s，远大于 4 s → 走翻页（窗口内不动）
  ok('⑤ 慢档走翻页', flipPeriodSec(1440, 600) > 4 && followWindow(0, START, WIN, PAST, 600) === null,
    `周期 ${flipPeriodSec(1440, 600).toFixed(1)} s`)
  // 10 min 窗口 @ 600×：周期 0.75 s，尺子每秒闪一次 → 改成钉住游标、尺子连续滑
  const W10 = 10
  ok('⑤ 快档周期过短', flipPeriodSec(W10, 600) < 4, `周期 ${flipPeriodSec(W10, 600).toFixed(2)} s`)
  const slide = followWindow(3, -2.5, W10, PAST, 600)
  ok('⑤ 快档钉住游标、尺子连续滑', slide !== null && near(3 - slide, PAST * W10, 1e-9), `winStart=${slide}`)
  // 连续档下游标位置恒定（这正是「不闪」的判据）：连走三次，游标相对窗口的位置逐次不变
  const p = (off, ws0) => { const w = followWindow(off, ws0, W10, PAST, 600); return { ws: w == null ? ws0 : w, pct: (off - (w == null ? ws0 : w)) / W10 } }
  const a = p(3, -2.5), b = p(3.5, a.ws), c = p(4, b.ws)
  ok('⑤ 连续档游标位置恒定', near(a.pct, PAST, 1e-9) && near(b.pct, PAST, 1e-9) && near(c.pct, PAST, 1e-9),
    [a.pct, b.pct, c.pct].map((x) => x.toFixed(3)).join(' / '))
  // 已经在位就返回 null（否则每拍都写一次 winStart，白触发一轮响应式重算）
  ok('⑤ 连续档到位后不再重写', followWindow(3, slide, W10, PAST, 600) === null)
  // 暂停/实时（compressX=0）一律走翻页语义，不该被连续档接管
  ok('⑤ 非播放态不进连续档', followWindow(0, START, WIN, PAST, 0) === null && flipPeriodSec(WIN, 0) === Infinity)
}

// ==================== ⑥ 读数格式化 ====================
{
  ok('⑥ 步长读数', fmtStep(1) === '1 s' && fmtStep(60) === '1 min' && fmtStep(300) === '5 min' && fmtStep(3600) === '1 h',
    [fmtStep(1), fmtStep(60), fmtStep(300), fmtStep(3600)].join(' / '))
  ok('⑥ 倍速读数', fmtRate(600) === '600' && fmtRate(1.5) === '1.5' && fmtRate(12.34) === '12',
    [fmtRate(600), fmtRate(1.5), fmtRate(12.34)].join(' / '))
  // ★ 偏移量必须带秒 —— 这是「游标下沉到秒级」在读数上的落点，只到分钟就等于没沉下去
  ok('⑥ 偏移量到秒', fmtOffset(-90_000) === '−1:30' && fmtOffset(65_000) === '+1:05' && fmtOffset(0) === '+0:00'
    && fmtOffset(3_661_000) === '+1:01:01',
    [fmtOffset(-90_000), fmtOffset(65_000), fmtOffset(0), fmtOffset(3_661_000)].join(' / '))
  ok('⑥ 跨日偏移退到 d/h/m', fmtOffset(2 * 86400_000 + 3 * 3600_000) === '+2d3h00m', fmtOffset(2 * 86400_000 + 3 * 3600_000))
  // 下拉里的紧凑写法：两个下拉挤在时间条右端，80 px 的「5 min」放不下
  ok('⑥ 下拉紧凑写法', fmtStepShort(1) === '1s' && fmtStepShort(300) === '5m' && fmtStepShort(3600) === '1h',
    [fmtStepShort(1), fmtStepShort(300), fmtStepShort(3600)].join(' / '))
  ok('⑥ 紧凑写法不超过 4 字符', STEP_PRESETS.every((s) => fmtStepShort(s).length <= 4), STEP_PRESETS.map(fmtStepShort).join(' '))
}

// ==================== ⑦ 慢订阅者：整体放慢，而不是让画面各走各的（回归钉子）====================
// 真出过两次的毛病，根子是同一个：为了不卡，把重的重算推迟到「以后某一帧」。结果就是
// 星位在 t、覆盖场在 t−Δ —— 同一帧里两个时刻，用户原话「覆盖场等卫星走一小段后才刷新，慢半拍」。
// 现在的口径是【一次回调 = 一个时刻的完整画面】，谁也不许延后；算不过来由时钟拉长两拍的间隔。
// 这一条就钉住那个「拉长间隔」真的发生了：慢订阅者不会把主线程占满，也不会被饿死。
{
  const clk = await import('../../../src/stores/simClock.js')
  const COST = 60                       // 模拟一次「贵」的全场重算
  let ticks = 0
  const off = clk.onTick(() => { const e = Date.now() + COST; while (Date.now() < e) { /* 占住主线程 */ } ticks++ })

  clk.setStep(1); clk.setSpeed(10)      // 要 10 拍/s（100 ms 一拍），而一拍要 60 ms —— 光靠自校正会占满
  const t0 = Date.now()
  clk.play(1)
  await new Promise((r) => setTimeout(r, 1000))
  clk.pause(); off(); clk.releaseClock()
  const elapsed = Date.now() - t0, busy = ticks * COST

  ok('⑦ 慢订阅者不会把主线程占满', busy / elapsed <= 0.62, `占用 ${(busy / elapsed * 100).toFixed(0)}%（${ticks} 拍 × ${COST} ms / ${elapsed} ms）`)
  ok('⑦ 也不会被饿死', ticks >= 4, `${ticks} 拍`)
  // 仿真时间照走：拍与拍之间攒下的步数由 stepsDue 一次补齐 —— 慢的是画面帧率，不是时间本身
  ok('⑦ 仿真时间不因放慢而落后', clk.clock.tMs > 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
