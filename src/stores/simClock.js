// 全局仿真时钟（平台唯一的时间真相）。内核是纯的（shared/simClockCore.js），这里只加三样东西：
// Vue 响应式状态、一个自校正的定时器、一份订阅者名单。
//
// 三种模式（Cesium ClockRange / STK Animation 同一套语义）：
//   live  —— 跟随系统时钟，每秒一拍（＝改造前的「实时」，行为逐字保留）
//   play  —— 按 步长 × 速率 推进（可正可负），STK 的 ▶ / ◀
//   pause —— 停在某个时刻，只有用户操作才动
//
// ★ 谁读时间都读 clock.tMs 这一个数：星位、GRD 覆盖、对星壳层、可见性、晨昏线、两张指标表。
//   于是「时间轴动 → 所有派生量一起动」是结构保证的，不靠各模块自觉。
//
// ★ 定时器用 setTimeout 不用 requestAnimationFrame：窗口最小化 / 切到别的页时 rAF 会停，
//   而「实时」跟随系统时钟这件事不该因为没人看着就停摆（回来一看时间断层，星位对不上）。
//   代价是后台被浏览器节流到 ~1 Hz —— 由实测倍速 achieved 如实读出，不假装跑满。
//
// ★ 跨窗口：时刻镜像写进 localStorage（shared/sceneClock.js），别的窗口要「当前时刻」读那份，不取系统钟 ——
//   全软件一条时间线。控制动作（实时 / 播放 / 暂停 / 设时刻 / 步进 / 改步长倍速方向 / 停表 / 接表）立即写，走表时每秒至多写一次。
//   只有主窗口（App 根组件调 initClockMirror）写镜像：别的窗口可能顺着 import 链带进本模块（性能表弹窗 → useLiveField），
//   各有一份表但不写，免得盖掉主窗口的时刻。
import { reactive, computed } from 'vue'
import { stepsDue, advanceMs, tickIntervalMs, clampStep, clampSpeed, achievedRate, rateFor, effSpeed, speedCapped, nextDelayMs, boundStep, playStartMs, normEnd } from '../shared/simClockCore.js'
import { writeSceneClock, readSceneClock } from '../shared/sceneClock.js'

// 上次会话最后写下的场景时刻（模块装载时读，赶在主窗口 initClockMirror 用「此刻」盖掉镜像之前）。
// 固定时段档开软件时回到这一刻（在时段内的话）—— 与 STK 打开场景回到上次的动画时刻同理。取原值不外推：
// 退出时若在播放，按倍速外推到现在只会落到一个从没看过的时刻。
const _boot = readSceneClock()
export const bootSceneMs = _boot && Number.isFinite(_boot.tMs) ? _boot.tMs : null

const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

export const clock = reactive({
  mode: 'pause',        // 'live' | 'play' | 'pause'
  tMs: Date.now(),      // 当前仿真时刻（UTC ms）——全平台唯一时间真相
  stepSec: 60,          // 步长：一拍走多少仿真秒
  speed: 600,           // 倍速：仿真时间比真实时间快多少倍（STK 的 x Real Time）
  dir: 1,               // 播放方向：+1 前进 / −1 后退
  achieved: 0,          // 实测倍速（仿真秒/真实秒），跟不上时小于设定值
  seq: 0,               // 每拍自增：给需要「时间一动就重算」的 computed 当依赖用
  range: null           // 仿真时段 { startMs, stopMs, end } —— 连播到终止时刻按 end 停 / 循环 / 继续（见 simClockCore.boundStep）
})

// 拍率 = 倍速 ÷ 步长（夹在 [0.2, 240] 拍/s）；夹住时实际倍速随之打折，effective 是真能达到的那个数
export const rate = computed(() => rateFor(clock.stepSec, clock.speed))
export const effective = computed(() => effSpeed(clock.stepSec, clock.speed))   // 实际能达到的倍速
export const capped = computed(() => speedCapped(clock.stepSec, clock.speed))   // 设定倍速被步长顶住了
export const intervalMs = computed(() => (clock.mode === 'live' ? 1000 : tickIntervalMs(rate.value)))
export const playing = computed(() => clock.mode === 'play')
export const isLive = computed(() => clock.mode === 'live')

// —— 订阅者：一拍一次回调 fn(tMs)（宿主用它驱动重算/重绘）——
// ★ 不区分「连播拍 / 离散动作」：宿主对两者的处理必须完全一样（一次调用 = 一个时刻的完整画面）。
//   曾经给连播拍开过「可跳帧」的口子，结果就是覆盖场比星位晚一拍 —— 同一帧里两个时刻，一眼可见。
// ★ 订阅者可以返回 Promise（宿主把逐颗几何摊给 Worker 池时就会）。emit 会等它们全部 resolve —— 这不是
//   为了「顺序」，是为了守住上面那条铁律：一拍没画完就不算完，下一拍也不许开始，否则画面里会同时存在两个时刻。
//   跟不上就是拍率自然掉下来，由 achieved 如实读出（本来就是这么设计的）。
const subs = new Set()
export function onTick(fn) { if (typeof fn === 'function') subs.add(fn); return () => subs.delete(fn) }
// —— 跨窗口镜像（见文件头）。held：宿主页卸载停了表（模式还在），读的一侧不许按倍速外推 ——
let lastPub = 0, held = false, mirror = false
function publish(force) {
  if (!mirror) return
  const now = Date.now()
  if (!force && now - lastPub < 1000) return
  lastPub = now
  const mode = held ? 'pause' : clock.mode
  // 外推速率取实测倍速（跟不上时比设定的小；刚起播还没测出来用设定值），免得别的窗口外推跑到时钟前头
  const sp = clock.achieved > 0 ? clock.achieved : effective.value
  writeSceneClock({ tMs: clock.tMs, mode, rate: mode === 'play' ? sp * clock.dir : 0 }, now)
}
/** 主窗口开启跨窗口镜像（App 根组件调一次）。★ 别的窗口也可能顺着 import 链带进本模块（性能表弹窗 → useLiveField），
 *  它们不调这个、也就不写镜像 —— 否则一开弹窗就把主窗口的时刻盖成弹窗打开那一刻 */
export function initClockMirror() { mirror = true; publish(true) }
async function emit() {
  clock.seq++
  publish(false)
  for (const fn of subs) {
    try { const r = fn(clock.tMs); if (r && typeof r.then === 'function') await r } catch { /* 单个订阅者出错不拖垮时钟 */ }
  }
}

// —— 定时器 ——
let timer = null, lastReal = 0, accum = 0, lastCost = 0
let mSim = 0, mReal = 0                 // 实测倍速的滑动窗累加器
// 宿主页已卸载、表被收走了。★ 必须有这个标志：tick 是 async 的，releaseClock() 若落在它 await 订阅者
// 的那一段里，光 stopTimer() 拦不住 —— 那一拍醒来照样走到末尾的 schedule()，看 mode 还是 live/play
// 就把定时器又装了回去（表现＝离开本页后时钟仍在走，与「停表但保留时刻」的约定相反，还留一个后台定时器）。
// pause() 不需要它：schedule() 本来就判 mode。
let released = false
function stopTimer() { if (timer) { clearTimeout(timer); timer = null } }
function schedule() {
  stopTimer()
  if (released || clock.mode === 'pause') return
  // 自校正（扣掉本拍自身耗时，避免每拍都晚一点越积越多）+ 占用底线（两拍之间必须留出空闲，
  // 否则一拍算不完下一拍立刻接上，主线程 100% 被占，界面直接卡死）。判据见 nextDelayMs。
  timer = setTimeout(tick, nextDelayMs(intervalMs.value, perfNow() - lastReal, lastCost))
}
async function tick() {
  timer = null
  const nowReal = perfNow()
  const dt = Math.max(0, nowReal - lastReal)
  lastReal = nowReal
  // 真实时间【先】记账，再看这一拍走不走：没攒够一拍就早退的那些空拍也是真实流逝的时间，
  // 漏记会把实测倍速算高（分母少了），跟不上的时候反而显示跑满，那这个读数就白摆了。
  mReal += dt
  let advanced = 0, moved = true, halted = false
  if (clock.mode === 'live') {
    const t = Date.now()
    advanced = t - clock.tMs
    clock.tMs = t
  } else if (clock.mode === 'play') {
    const r = stepsDue(accum, dt, rate.value)
    accum = r.accum
    if (r.steps) {
      // 仿真时段的终止处理：落在终止时刻上（停止档随之停表）/ 已在终点则回到起点（循环档）
      const b = boundStep(clock.tMs, advanceMs(clock.tMs, r.steps, clock.stepSec, clock.dir), clock.range, clock.dir)
      if (b.halt) { clock.mode = 'pause'; clock.achieved = 0; accum = 0; halted = true }
      advanced = b.tMs - clock.tMs
      if (advanced) clock.tMs = b.tMs
      else moved = false
    } else moved = false                       // 没攒够一拍就不通知：空转一次重算是几十毫秒，白烧
  }
  mSim += Math.abs(advanced)
  if (mReal >= 500) { clock.achieved = achievedRate(mSim, mReal); mSim = 0; mReal = 0 }
  if (moved) {
    const c0 = perfNow()
    await emit()                   // 等本拍画完再记账、再排下一拍：异步几何也要算进这一拍的耗时
    lastCost = perfNow() - c0      // 这一拍全场重算真花了多少：下一拍的空闲底线按它留
  } else lastCost = 0
  if (halted) publish(true)        // 到终止时刻停表：别的窗口立刻按暂停读，不再按倍速外推
  schedule()
}
function startTimer() {
  stopTimer()
  released = false                 // 任何一次「起表」都解除卸载态（play / goLive / 改步长倍速 / resumeClock）
  lastReal = perfNow(); accum = 0; mSim = 0; mReal = 0; lastCost = 0
  timer = setTimeout(tick, intervalMs.value)
}

// —— 控制 ——
export function goLive() {
  clock.mode = 'live'; clock.dir = 1
  clock.tMs = Date.now()
  held = false
  startTimer(); publish(true); emit()
}
export function pause() {
  clock.mode = 'pause'; clock.achieved = 0
  stopTimer(); publish(true); emit()
}
export function play(dir = 1) {
  clock.dir = dir < 0 ? -1 : 1
  clock.tMs = playStartMs(clock.tMs, clock.range, clock.dir)   // 停在终点（或其外）再按播放：从时段另一端开始
  clock.mode = 'play'
  held = false
  startTimer(); publish(true); emit()
}
export function togglePlay(dir = 1) {
  if (clock.mode === 'play' && clock.dir === (dir < 0 ? -1 : 1)) pause()
  else play(dir)
}
// 设时刻：任何拖动/键入/跳转都走这里。播放中改时刻＝就地续播（STK 拖游标不停动画），
// 实时中改时刻＝静默退出实时（与改造前 applyTime 的行为一致）。
export function setTime(ms, { keepMode = true } = {}) {
  const t = Math.round(Number(ms))
  if (!Number.isFinite(t)) return
  if (clock.mode === 'live' || !keepMode) { clock.mode = 'pause'; clock.achieved = 0; stopTimer() }
  clock.tMs = t
  accum = 0
  publish(true)
  return emit()   // 返回本拍全部订阅者落定的 Promise：视频导出逐帧要等这一拍画完（含 Worker 几何）再出帧；别的调用方照旧不等
}
// 步进 n 拍（n 可负）。播放中按下即先停 —— 单步与连播同时进行没有物理意义。
export function stepBy(n = 1) {
  if (clock.mode !== 'pause') { clock.mode = 'pause'; clock.achieved = 0; stopTimer() }
  clock.tMs = advanceMs(clock.tMs, Math.abs(n), clock.stepSec, n < 0 ? -1 : 1)
  publish(true)
  emit()
}
// 按住方向键的连步（键盘自动重复一秒几十次）：时刻 / 模式照 stepBy 当场改（之后的任何操作读到的都是新时刻），
// 只把「通知订阅者整场重算」合并到下一帧 —— 一帧里按了几下就只重算最后那一刻，主线程不再被逐键整场重算压满。
// 画面上那一帧本来也只能显示其中一个时刻；末态（时刻、模式、重算到的那一拍）与逐键 stepBy 相同。
// 帧回调兜一道定时器：窗口被藏起来 rAF 不走时，重算照样会在 100 ms 内发生
let stepFlush = 0, stepFlushT = 0
function flushStep() { if (stepFlush) { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(stepFlush); stepFlush = 0 } clearTimeout(stepFlushT); stepFlushT = 0; emit() }
export function stepByKey(n = 1) {
  if (clock.mode !== 'pause') { clock.mode = 'pause'; clock.achieved = 0; stopTimer() }
  clock.tMs = advanceMs(clock.tMs, Math.abs(n), clock.stepSec, n < 0 ? -1 : 1)
  publish(true)
  if (typeof requestAnimationFrame !== 'function') { emit(); return }
  if (stepFlush || stepFlushT) return
  stepFlush = requestAnimationFrame(flushStep)
  stepFlushT = setTimeout(flushStep, 100)
}
export function setStep(sec) { clock.stepSec = clampStep(sec); if (clock.mode === 'play') startTimer(); publish(true) }
export function setSpeed(x) { clock.speed = clampSpeed(x); if (clock.mode === 'play') startTimer(); publish(true) }
export function setDir(d) { clock.dir = d < 0 ? -1 : 1; publish(true) }
// 仿真时段（null = 不设边界，滚动档）。只改连播的终止处理，不挪当前时刻
export function setRange(r) {
  const ok = r && Number.isFinite(r.startMs) && Number.isFinite(r.stopMs) && r.stopMs > r.startMs
  clock.range = ok ? { startMs: Math.round(r.startMs), stopMs: Math.round(r.stopMs), end: normEnd(r.end) } : null
}
// 页面卸载：停表但保留模式与时刻（回到该页时接着这个时刻，不弹回「此刻」）
export function releaseClock() { released = true; stopTimer(); held = true; publish(true) }
// 页面重新挂载：按当前模式把表接上（上次离开时若在实时/播放，回来照旧走）
export function resumeClock() { released = false; held = false; if (clock.mode !== 'pause') startTimer(); publish(true) }

export function getState() { return { stepSec: clock.stepSec, speed: clock.speed, live: clock.mode === 'live' } }
export function restoreState(s) {
  if (!s || typeof s !== 'object') return
  if (Number.isFinite(s.stepSec)) clock.stepSec = clampStep(s.stepSec)
  if (Number.isFinite(s.speed)) clock.speed = clampSpeed(s.speed)
  else if (Number.isFinite(s.rate)) clock.speed = clampSpeed(s.rate * clock.stepSec)   // 旧存档存的是拍/s
  // 模式刻意不恢复播放态：一开软件就自己跑起来会把「上次看到哪」冲掉。实时由宿主按其存档开。
}

