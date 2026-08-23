// 仿真时钟内核（纯函数，不碰 Vue / DOM / 定时器）——STK Animation 范式。
//
// 两个旋钮，语义各自独立、都能直接读懂：
//   · 步长 stepSec —— 推进一拍，仿真时间走多少秒。这是【采样量子】：播放中每一帧都严格落在
//     t₀ + k·stepSec 上，帧率抖动、卡顿、切后台都不会把时刻推到格子之间。
//   · 倍速 speedX  —— 仿真时间比真实时间快多少倍（STK 的 x Real Time）。
//   二者定出播放拍率：拍率 = 倍速 ÷ 步长（拍/真实秒），夹在 [0.2, 240]。
//
// 为什么把「快慢」和「采样格」拆成两个量（而不是只有一个倍速）：
//   星位/覆盖/可见性全是对时刻的确定性函数（SGP4 + GMST），任何单个时刻算出来都是准的；
//   会出错的只有【采样】——一颗低轨星穿过 0.3° 的波束可能只有几十秒，步长 300 s 必然跨过去。
//   把步长显式摆出来，用户就能按物理事件的时间尺度选它，而不是被帧率悄悄决定。
//   （真要一个不漏，用对星表的「时间窗口」时段扫描：那条路的步长由角位移反控，见 satcovScan.js。）
//
// ★ 倍速与步长【会互相顶】：想要 3600× 又只肯采 1 s，就得每秒画 3600 帧 —— 物理上办不到。
//   此时拍率夹到 240，实际倍速随之降到 240×步长，由 effSpeed 如实算出。
//   要更快就得放大步长 —— 这正是「时间分辨率换播放速度」的真实代价，不该藏起来。
//
// ★ 机器跟不上时【只慢放、不跳时刻】：一拍就是一拍，攒下的拍数超过 maxBurst 的部分直接丢弃，
//   仿真时间因此落后于墙钟——这是诚实的选择。反过来（一帧补上所有欠账）会让时刻凭空跳过一大段，
//   看到的动画就不是等间隔采样了，「跨过一次穿越」的锅会记在物理上。落后多少由实测倍速如实读出。

// 步长预设（秒）：1 s 起（游标秒级）到 1 h。自定义值也允许，clampStep 只夹范围。
export const STEP_PRESETS = [1, 5, 10, 30, 60, 300, 600, 1800, 3600]
// 倍速预设（×实时）：1× 实时 → 3 h/s。与步长搭不上的组合由 effSpeed 夹住并如实显示。
export const SPEED_PRESETS = [1, 10, 60, 300, 600, 1800, 3600, 10800]

export const STEP_MIN = 0.1, STEP_MAX = 86400
export const SPEED_MIN = 0.01, SPEED_MAX = 1e6
// 拍/真实秒。下限保住心跳（慢档下时钟不能看着像死了）。
// ★ 上限不是性能闸 —— 真正防卡死的是 nextDelayMs 的占用底线（两拍之间留出本拍耗时，占用 ≤ 1/2），
//   它按【实测单拍耗时】自适应回退。贵场景（几千颗星 + 覆盖场）单拍就是几十毫秒，压根够不着上限；
//   吃得到 240 的只有便宜场景（十几颗星、没开覆盖场），那里单拍 ≤ 2 ms。
// ★ 240 是这套定时器的物理天花板：对应间隔 4.2 ms，而 Chromium 对【定时器里再排定时器】（schedule()
//   正是这个形状）有 4 ms 的嵌套下限 —— 再往上写只会得到一个达不到的数，effSpeed/capped 就开始骗人
//   （它俩还喂给 followWindow 决定尺子是翻页还是连续滑）。故 TICK_MIN_MS 一并压到 4，两者必须同改。
// ★ 拍 ≠ 帧：3D 场景走自己的 rAF 环（受 displayQuality 的 fps 档约束：30 / 60 / 不限），一拍只改状态。
//   拍率超过出帧节奏的那部分算了不画，是纯烧 CPU 换更细的采样格 —— 由占用底线兜住不至于卡死界面。
export const RATE_MIN = 0.2, RATE_MAX = 240
const MAX_BURST = 8              // 单次 tick 最多补几拍（超出即丢弃 → 落后墙钟，不跳时刻）
const TICK_MIN_MS = 4, TICK_MAX_MS = 5000      // 4 ms = Chromium 嵌套 setTimeout 的下限，与 RATE_MAX 同源

export const clampStep = (s) => Math.min(STEP_MAX, Math.max(STEP_MIN, Number(s) || 60))
export const clampSpeed = (x) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(x) || 1))
export const clampRate = (r) => Math.min(RATE_MAX, Math.max(RATE_MIN, Number(r) || 1))
// 步长 + 倍速 → 拍率（夹住）与【实际能达到的】倍速。二者顶上时以拍率上限为准，倍速随之打折。
export const rateFor = (stepSec, speedX) => clampRate(clampSpeed(speedX) / clampStep(stepSec))
export const effSpeed = (stepSec, speedX) => rateFor(stepSec, speedX) * clampStep(stepSec)
// 设定倍速达不达得到（达不到就得在界面上并列显示实际值，不能默默打折）
export const speedCapped = (stepSec, speedX) => Math.abs(effSpeed(stepSec, speedX) - clampSpeed(speedX)) > clampSpeed(speedX) * 1e-6

// 攒够整拍才推进：返回本次该走几拍 + 剩下的零头 + 因追不上而丢掉的拍数。
// accum 单位是「拍」，故换速率不会把已攒的零头按旧速率折算错。
export function stepsDue(accum, dtRealMs, rate, maxBurst = MAX_BURST) {
  const a0 = Number.isFinite(accum) ? accum : 0
  if (!(dtRealMs > 0) || !(rate > 0)) return { steps: 0, accum: a0, dropped: 0 }
  let a = a0 + (dtRealMs * rate) / 1000
  let k = Math.floor(a + 1e-9)
  a -= k
  let dropped = 0
  if (k > maxBurst) { dropped = k - maxBurst; k = maxBurst }
  return { steps: k, accum: a, dropped }
}

// 推进 k 拍：整毫秒落点（stepSec 允许小数，但时刻本身只保留 ms —— 与 Date 的分辨率一致）
export function advanceMs(simMs, steps, stepSec, dir = 1) {
  if (!steps) return simMs
  return simMs + Math.round((dir < 0 ? -1 : 1) * steps * stepSec * 1000)
}

// ★ 下一拍什么时候来（ms）—— 光按「目标间隔 − 已花时间」排是不够的：
//   一拍要做的是全场重算（几千颗星的 SGP4 + 覆盖 + 可见性 + 晨昏线）。当这一拍本身就比目标间隔还久，
//   「间隔 − 已花」是负数 → 立刻排下一拍 → 主线程 100% 被占，渲染与鼠标一点空隙都拿不到。
//   表现就是「点了播放整个界面卡死」，而且越是便宜的场景越冤（它本来跟得上，只是没人给它喘气）。
//   所以再加一条底线：无论如何，两拍之间至少空出【本拍耗时 × idleK】。idleK=1 → 占用 ≤ 1/2，
//   一半给仿真、一半留给渲染与输入。仿真时间不会因此变慢：拍与拍之间攒下的步数由 stepsDue 一次补上
//   （只是每帧跳得大一点）—— 慢的是画面帧率，不是时间本身。
const IDLE_K = 1
export function nextDelayMs(wantMs, spentMs, costMs, idleK = IDLE_K) {
  const idle = Math.max(0, (Number(costMs) || 0) * idleK)
  const left = (Number(wantMs) || 0) - Math.max(0, Number(spentMs) || 0)
  return Math.max(0, Math.max(idle, left))
}

// 播放定时的目标间隔（ms）：速率的倒数，夹在 [4, 5000]。
// 上夹 5000 ms 是为了「步长 1 h、速率 0.2 拍/s」这种慢档下时钟本身仍有心跳（读数不会看着像死了）；
// 下夹 4 ms 与 RATE_MAX=240 同源（见上），再密浏览器也不给 —— 想更快请加步长，不是加速率。
export function tickIntervalMs(rate) {
  return Math.min(TICK_MAX_MS, Math.max(TICK_MIN_MS, Math.round(1000 / clampRate(rate))))
}

// 时刻吸附：unit 的整数倍（origin 为格子原点，默认取 UTC 纪元 → 整分/整秒都落在墙钟整点上）
export function snapMs(ms, unitMs, originMs = 0) {
  if (!(unitMs > 0)) return Math.round(ms)
  return originMs + Math.round((ms - originMs) / unitMs) * unitMs
}

// 游标拖动的吸附粒度（秒）：让「1 像素 ≈ 1 格」——窗口越窄吸附越细，最细 1 s。
// 24 h 窗口 600 px 时 1 px = 144 s，此时吸到秒毫无意义（手抖一像素就是两分钟）；
// 要精确到秒请缩窗口（滚轮）、用步进按钮，或直接键入时刻。
const SNAP_NICE = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
export function cursorSnapSec(windowMin, trackPx) {
  const perPx = (Math.max(1, windowMin) * 60) / Math.max(1, trackPx)
  for (const s of SNAP_NICE) if (s >= perPx) return s
  return SNAP_NICE[SNAP_NICE.length - 1]
}

// 播放中游标跑出可见窗口 → 平移窗口把它接回来（不是把游标夹住：夹住等于播放被窗口边缘卡死）。
// 前进时游标落在 pastFrac 处（前方留 3/4 窗口可看），后退时对称。返回新的 winStartMin；无需平移给 null。
export function panWindow(offMin, winStartMin, windowMin, pastFrac = 0.25) {
  const end = winStartMin + windowMin
  if (offMin >= winStartMin && offMin <= end) return null
  const frac = offMin > end ? pastFrac : 1 - pastFrac
  return offMin - frac * windowMin
}

// 翻一次页能看多久（真实秒）：窗口里游标前方那一段的仿真时长 ÷ 倍速。
export function flipPeriodSec(windowMin, speedX, pastFrac = 0.25) {
  const simSec = Math.max(0, windowMin) * 60 * (1 - pastFrac)
  return speedX > 0 ? simSec / speedX : Infinity
}
// 播放跟随策略：慢档【翻页】、快档【连续滑动】。
//   翻页 —— 游标在尺上从 pastFrac 走到右缘再翻一页。看得见「游标在走」，是默认的读法。
//   连续 —— 游标钉在 pastFrac 处不动、尺子和刻度往后流。
// 为什么要分档：600× 压缩 + 10 min 窗口下翻页周期只有 0.75 s，尺子每秒闪一次，什么都读不出来。
// 阈值取 4 s：低于它就说明「翻页」这个动作本身已经快过人眼跟读的速度，此时钉住游标反而看得清。
export function followWindow(offMin, winStartMin, windowMin, pastFrac = 0.25, speedX = 0, minFlipSec = 4) {
  if (flipPeriodSec(windowMin, speedX, pastFrac) < minFlipSec) {
    const want = offMin - pastFrac * windowMin
    return Math.abs(want - winStartMin) < 1e-9 ? null : want
  }
  return panWindow(offMin, winStartMin, windowMin, pastFrac)
}

// 实测时间压缩比（仿真秒 / 真实秒）：读的是【真的走了多少】，不是设定值。
// 机器跟不上、切后台被节流、单帧重算太贵，都在这个数上如实反映出来。
export function achievedRate(simDeltaMs, realDeltaMs) {
  if (!(realDeltaMs > 0)) return 0
  return simDeltaMs / realDeltaMs
}

// —— 读数格式化（三处共用：时间条、tooltip、持久化后的回显）——
export function fmtStep(sec) {
  const s = Number(sec) || 0
  if (s < 1) return s.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + ' s'
  if (s < 60) return (Number.isInteger(s) ? s : s.toFixed(1)) + ' s'
  if (s < 3600) { const m = s / 60; return (Number.isInteger(m) ? m : m.toFixed(1)) + ' min' }
  const h = s / 3600
  return (Number.isInteger(h) ? h : h.toFixed(1)) + ' h'
}
// 下拉里的紧凑写法（时间条横向寸土寸金，两个下拉不能各占 80 px）：1s 30s 5m 1h
export const fmtStepShort = (sec) => fmtStep(sec).replace(' min', 'm').replace(' s', 's').replace(' h', 'h')
export function fmtRate(x) {
  const v = Number(x) || 0
  if (v >= 100) return Math.round(v).toLocaleString()
  if (v >= 10) return v.toFixed(0)
  return String(Number(v.toFixed(2)))
}

// 时长（ms）→ 紧凑读数：游标偏移量那一行用（带秒，正是「秒级游标」要看的）
export function fmtOffset(ms) {
  const v = Math.round(Math.abs(ms) / 1000)
  const sgn = ms < 0 ? '−' : '+'
  const p = (n) => String(n).padStart(2, '0')
  const d = Math.floor(v / 86400), h = Math.floor((v % 86400) / 3600), m = Math.floor((v % 3600) / 60), s = v % 60
  if (d) return `${sgn}${d}d${h}h${p(m)}m`
  if (h) return `${sgn}${h}:${p(m)}:${p(s)}`
  return `${sgn}${m}:${p(s)}`
}
