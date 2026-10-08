// 场景时刻的跨窗口镜像：主窗口的全局仿真时钟（stores/simClock.js 的 clock.tMs）写进 localStorage 'globe3d/clock'，
// 别的窗口（链路预算四窗、干扰分析、模型工作台、性能表弹窗…）要「当前时刻」时读它，不再各取系统钟。
//
// 【为什么】时钟只活在主窗口里：主窗口暂停在开机时刻、或时间轴拖到别处时，其它窗口点「计算」用的还是 Date.now() ——
//   同一个「此刻」，主窗口画的是 A 时刻的星位，链路预算算的是 B 时刻的几何。全软件要在同一条时间线上。
// 记录：{ v:1, tMs, mode:'live'|'play'|'pause', rate, wallMs }。rate = 仿真毫秒 / 真实毫秒（实时 1、播放 = 实际倍速 × 方向、
//   暂停或主窗口停表 0）；读的一侧按 wallMs 外推：play 中两次写之间也连续。写由时钟按「控制动作立即写 + 走表时每秒至多一次」节流。
// 读不到 / 坏记录 / 实时档 → 系统钟（与改造前一致）。只读不写的窗口不用 import simClock（那是主窗口的单例）。
// 纯函数部分（sceneClockRecord / sceneNowFrom）node 可直接测：packages/core/test/sceneClock.test.mjs。

export const SCENE_CLOCK_KEY = 'globe3d/clock'

/** 时钟状态 → 记录（rate：仿真 ms / 真实 ms） */
export function sceneClockRecord({ tMs, mode, rate }, wallMs) {
  const m = mode === 'live' || mode === 'play' ? mode : 'pause'
  const r = m === 'live' ? 1 : m === 'play' && Number.isFinite(rate) ? rate : 0
  return { v: 1, tMs: Math.round(Number(tMs)), mode: m, rate: r, wallMs: Math.round(Number(wallMs)) }
}
/** 记录 + 真实时刻 → 场景时刻（ms）；记录无效返回 null */
export function sceneNowFrom(rec, nowMs) {
  if (!rec || typeof rec !== 'object' || rec.v !== 1 || !Number.isFinite(rec.tMs)) return null
  if (rec.mode === 'live') return nowMs
  if (rec.mode === 'play' && Number.isFinite(rec.rate) && Number.isFinite(rec.wallMs)) return Math.round(rec.tMs + (nowMs - rec.wallMs) * rec.rate)
  return rec.tMs
}

/** 读镜像记录（没有 / 坏了返回 null） */
export function readSceneClock() {
  try { const r = JSON.parse(localStorage.getItem(SCENE_CLOCK_KEY) || 'null'); return r && r.v === 1 ? r : null } catch { return null }
}
/** 当前场景时刻（ms）：主窗口时间轴上的「此刻」；没有镜像退回系统钟 */
export function sceneNowMs() {
  const now = Date.now()
  const t = sceneNowFrom(readSceneClock(), now)
  return Number.isFinite(t) ? t : now
}
/** 当前场景时刻（ISO 串，带 Z） */
export function sceneNowISO() { return new Date(sceneNowMs()).toISOString() }
/** 写镜像（主窗口时钟用） */
export function writeSceneClock(state, wallMs = Date.now()) {
  try { localStorage.setItem(SCENE_CLOCK_KEY, JSON.stringify(sceneClockRecord(state, wallMs))) } catch { /* 便利数据：写不进就各窗口退回系统钟 */ }
}
/** 别的窗口改了镜像时回调（storage 事件只在【别的】窗口触发）；返回退订函数。只给读数刷新用，计算路径按需 sceneNowMs() 现读 */
export function onSceneClock(cb) {
  if (typeof window === 'undefined' || typeof cb !== 'function') return () => {}
  const h = (e) => { if (e && e.key === SCENE_CLOCK_KEY) { try { cb(readSceneClock()) } catch { /* ignore */ } } }
  window.addEventListener('storage', h)
  return () => window.removeEventListener('storage', h)
}
