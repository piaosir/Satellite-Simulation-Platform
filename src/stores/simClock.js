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
import { reactive, computed } from 'vue'
import { stepsDue, advanceMs, tickIntervalMs, clampStep, clampSpeed, achievedRate, rateFor, effSpeed, speedCapped, nextDelayMs } from '../shared/simClockCore.js'

const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

export const clock = reactive({
  mode: 'pause',        // 'live' | 'play' | 'pause'
  tMs: Date.now(),      // 当前仿真时刻（UTC ms）——全平台唯一时间真相
  stepSec: 60,          // 步长：一拍走多少仿真秒
  speed: 600,           // 倍速：仿真时间比真实时间快多少倍（STK 的 x Real Time）
  dir: 1,               // 播放方向：+1 前进 / −1 后退
  achieved: 0,          // 实测倍速（仿真秒/真实秒），跟不上时小于设定值
  seq: 0                // 每拍自增：给需要「时间一动就重算」的 computed 当依赖用
})

// 拍率 = 倍速 ÷ 步长（夹在 [0.2, 30] 拍/s）；夹住时实际倍速随之打折，由 speed 与 effective 并列显示
export const rate = computed(() => rateFor(clock.stepSec, clock.speed))
export const effective = computed(() => effSpeed(clock.stepSec, clock.speed))   // 实际能达到的倍速
export const capped = computed(() => speedCapped(clock.stepSec, clock.speed))   // 设定倍速被步长顶住了
export const intervalMs = computed(() => (clock.mode === 'live' ? 1000 : tickIntervalMs(rate.value)))
export const playing = computed(() => clock.mode === 'play')
export const isLive = computed(() => clock.mode === 'live')

// —— 订阅者：一拍一次回调 fn(tMs)（宿主用它驱动重算/重绘）——
// ★ 不区分「连播拍 / 离散动作」：宿主对两者的处理必须完全一样（一次调用 = 一个时刻的完整画面）。
//   曾经给连播拍开过「可跳帧」的口子，结果就是覆盖场比星位晚一拍 —— 同一帧里两个时刻，一眼可见。
const subs = new Set()
export function onTick(fn) { if (typeof fn === 'function') subs.add(fn); return () => subs.delete(fn) }
function emit() {
  clock.seq++
  for (const fn of subs) { try { fn(clock.tMs) } catch { /* 单个订阅者出错不拖垮时钟 */ } }
}

// —— 定时器 ——
let timer = null, lastReal = 0, accum = 0, lastCost = 0
let mSim = 0, mReal = 0                 // 实测倍速的滑动窗累加器
function stopTimer() { if (timer) { clearTimeout(timer); timer = null } }
function schedule() {
  stopTimer()
  if (clock.mode === 'pause') return
  // 自校正（扣掉本拍自身耗时，避免每拍都晚一点越积越多）+ 占用底线（两拍之间必须留出空闲，
  // 否则一拍算不完下一拍立刻接上，主线程 100% 被占，界面直接卡死）。判据见 nextDelayMs。
  timer = setTimeout(tick, nextDelayMs(intervalMs.value, perfNow() - lastReal, lastCost))
}
function tick() {
  timer = null
  const nowReal = perfNow()
  const dt = Math.max(0, nowReal - lastReal)
  lastReal = nowReal
  // 真实时间【先】记账，再看这一拍走不走：没攒够一拍就早退的那些空拍也是真实流逝的时间，
  // 漏记会把实测倍速算高（分母少了），跟不上的时候反而显示跑满，那这个读数就白摆了。
  mReal += dt
  let advanced = 0, moved = true
  if (clock.mode === 'live') {
    const t = Date.now()
    advanced = t - clock.tMs
    clock.tMs = t
  } else if (clock.mode === 'play') {
    const r = stepsDue(accum, dt, rate.value)
    accum = r.accum
    if (r.steps) {
      const next = advanceMs(clock.tMs, r.steps, clock.stepSec, clock.dir)
      advanced = next - clock.tMs
      clock.tMs = next
    } else moved = false                       // 没攒够一拍就不通知：空转一次重算是几十毫秒，白烧
  }
  mSim += Math.abs(advanced)
  if (mReal >= 500) { clock.achieved = achievedRate(mSim, mReal); mSim = 0; mReal = 0 }
  if (moved) {
    const c0 = perfNow()
    emit()
    lastCost = perfNow() - c0      // 这一拍全场重算真花了多少：下一拍的空闲底线按它留
  } else lastCost = 0
  schedule()
}
function startTimer() {
  stopTimer()
  lastReal = perfNow(); accum = 0; mSim = 0; mReal = 0; lastCost = 0
  timer = setTimeout(tick, intervalMs.value)
}

// —— 控制 ——
export function goLive() {
  clock.mode = 'live'; clock.dir = 1
  clock.tMs = Date.now()
  startTimer(); emit()
}
export function pause() {
  clock.mode = 'pause'; clock.achieved = 0
  stopTimer(); emit()
}
export function play(dir = 1) {
  clock.dir = dir < 0 ? -1 : 1
  clock.mode = 'play'
  startTimer(); emit()
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
  emit()
}
// 步进 n 拍（n 可负）。播放中按下即先停 —— 单步与连播同时进行没有物理意义。
export function stepBy(n = 1) {
  if (clock.mode !== 'pause') { clock.mode = 'pause'; clock.achieved = 0; stopTimer() }
  clock.tMs = advanceMs(clock.tMs, Math.abs(n), clock.stepSec, n < 0 ? -1 : 1)
  emit()
}
export function setStep(sec) { clock.stepSec = clampStep(sec); if (clock.mode === 'play') startTimer() }
export function setSpeed(x) { clock.speed = clampSpeed(x); if (clock.mode === 'play') startTimer() }
export function setDir(d) { clock.dir = d < 0 ? -1 : 1 }
// 页面卸载：停表但保留模式与时刻（回到该页时接着这个时刻，不弹回「此刻」）
export function releaseClock() { stopTimer() }
// 页面重新挂载：按当前模式把表接上（上次离开时若在实时/播放，回来照旧走）
export function resumeClock() { if (clock.mode !== 'pause') startTimer() }

export function getState() { return { stepSec: clock.stepSec, speed: clock.speed, live: clock.mode === 'live' } }
export function restoreState(s) {
  if (!s || typeof s !== 'object') return
  if (Number.isFinite(s.stepSec)) clock.stepSec = clampStep(s.stepSec)
  if (Number.isFinite(s.speed)) clock.speed = clampSpeed(s.speed)
  else if (Number.isFinite(s.rate)) clock.speed = clampSpeed(s.rate * clock.stepSec)   // 旧存档存的是拍/s
  // 模式刻意不恢复播放态：一开软件就自己跑起来会把「上次看到哪」冲掉。实时由宿主按其存档开。
}
