// 分析页的共用上下文：时段（起止 / 步长 / 显示时区）、当前挂点、逐拍星位与姿态（四项分析共用一份，按「星 · 姿态律 · 时段」缓存）、
// 进度与取消、导出（CSV / PNG 走通用 exportFile，XLSX 走 models.exportTable）。
import { reactive, computed } from 'vue'
import { timeGrid, gridCount, sampleStates, attitudeSeries, stationTarget, MAX_SAMPLES, abortErr } from './analysisCore.js'
import { stateFn, resolveOrbit } from './satSources.js'
import { byLang } from '../shared/i18n/lang.js'

const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v } catch { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch { /* 便利数据 */ } }
const minuteNow = () => Math.floor(Date.now() / 60000) * 60000

export function createAnaContext({ wb, sat }) {
  const api = typeof window !== 'undefined' ? window.api : null
  const win = reactive({
    t0: minuteNow(),
    hours: Number(lsGet('model/anaHours', '24')) || 24,
    stepS: Number(lsGet('model/anaStep', '60')) || 60,
    tz: lsGet('model/anaTz', 'local') === 'utc' ? 'utc' : 'local'
  })
  const saveWin = () => { lsSet('model/anaHours', String(win.hours)); lsSet('model/anaStep', String(win.stepS)); lsSet('model/anaTz', win.tz) }
  // 样本数读数：纯算术（gridCount），不为计数真去分配一个 Float64Array(N)（1 年 × 0.1 s 就是 2.5 GB）
  const nSamples = computed(() => gridCount(win.t0, win.t0 + win.hours * 3600e3, win.stepS))
  const tooMany = computed(() => nSamples.value > MAX_SAMPLES)

  let cache = null
  // 在算的共用任务：键 → {p, ctrl, waiters:Set<{onProgress}>, done}。四项分析点「计算」时同一键共用一份逐拍星位 / 姿态，
  // 但任务自己的取消与各调用方的取消分开：谁取消谁只是不等了（各自的 signal 与共享 Promise 赛跑），
  // 最后一个等它的调用方也走了，底层任务才真停（并立即从表里摘掉，后来者重开一份，不会接到一个已取消的任务）。
  const tasks = new Map()
  function keyOf() {
    const b = sat.st.binding
    return JSON.stringify([sat.st.satKey, b ? b.attitude : null, win.t0, win.hours, win.stepS])
  }
  /** target 律的目标（逐拍 ECEF km）；目标星另解一次轨道 */
  async function targetFn(att, tMs, o) {
    const t = att && att.law === 'target' && att.params ? att.params.target : null
    if (!t) return null
    if (t.kind === 'station') { const s = stationTarget(t); return () => s.p }
    if (t.kind === 'ecef' && Array.isArray(t.ecefKm)) return () => t.ecefKm
    if (t.kind === 'sat' && t.satKey) {
      const orb = await resolveOrbit(t.satKey)
      if (!orb) return null
      const s2 = await sampleStates(stateFn(orb), tMs, o)
      return (i) => (s2.ok[i] ? [s2.r[3 * i], s2.r[3 * i + 1], s2.r[3 * i + 2]] : null)
    }
    return null
  }
  function startTask(key) {
    const ctrl = new AbortController()
    const t = { key, ctrl, waiters: new Set(), done: false, p: null }
    const prog = (stage) => (d, n) => { for (const w of t.waiters) if (w.onProgress) { try { w.onProgress(stage, d, n) } catch { /* 回调出错不影响计算 */ } } }
    const signal = ctrl.signal
    t.p = (async () => {
      const orbit = await sat.ensureOrbit()
      if (signal.aborted) throw abortErr()
      if (!orbit) throw new Error(sat.st.orbitErr || byLang('找不到这颗星的轨道。', 'No orbit.'))
      const tMs = timeGrid(win.t0, win.t0 + win.hours * 3600e3, win.stepS)
      if (!tMs) throw new Error(byLang('样本数过多，请加大步长。', 'Too many samples.'))
      const st = await sampleStates(stateFn(orbit), tMs, { signal, onProgress: prog('orbit') })
      if (!st.nOk) throw new Error(byLang('时段内取不到星位。', 'No positions in window.'))
      const att = JSON.parse(JSON.stringify(sat.st.binding.attitude))
      const targetAt = await targetFn(att, tMs, { signal })
      const B = await attitudeSeries(att, st, tMs, { targetAt: targetAt ? (i) => targetAt(i) : null, signal, onProgress: prog('attitude') })
      const r = Object.freeze({ tMs, st, B, key })
      if (keyOf() === key) cache = r
      return r
    })()
    t.p.catch(() => { /* 没人等时的失败 / 取消不报未处理 */ })
    t.p.finally(() => { t.done = true; if (tasks.get(key) === t) tasks.delete(key) }).catch(() => {})
    return t
  }
  // 共享 Promise 与调用方自己的 signal 赛跑：调用方取消 → 它立即收到 AbortError，任务照跑（别人还在等）
  function race(p, signal) {
    if (!signal) return p
    if (signal.aborted) return Promise.reject(abortErr())
    return new Promise((res, rej) => {
      const on = () => rej(abortErr())
      signal.addEventListener('abort', on, { once: true })
      p.then((v) => { signal.removeEventListener('abort', on); res(v) }, (e) => { signal.removeEventListener('abort', on); rej(e) })
    })
  }
  /**
   * 逐拍星位 + 本体三轴（四项分析共用）。o.onProgress(stage, done, N)；o.signal 取消（只取消本调用方的等待）。
   * @returns {Promise<{tMs:Float64Array, st:object, B:object, key:string}>}
   */
  async function series(o = {}) {
    if (!sat.st.satKey || !sat.st.binding) throw new Error(byLang('未选卫星。', 'No satellite.'))
    if (o.signal && o.signal.aborted) throw abortErr()
    const key = keyOf()
    if (cache && cache.key === key) return cache
    let t = tasks.get(key)
    if (!t) { t = startTask(key); tasks.set(key, t) }
    const w = { onProgress: o.onProgress }
    t.waiters.add(w)
    try { return await race(t.p, o.signal) } finally {
      t.waiters.delete(w)
      // 最后一个等它的也走了（都取消了）：底层任务停掉并摘出表 —— 主线程的分块算力最贵，别替没人要的结果干活
      if (!t.done && !t.waiters.size) { t.ctrl.abort(); if (tasks.get(key) === t) tasks.delete(key) }
    }
  }
  function invalidate() { cache = null }

  // ── 导出 ──
  const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'export'
  async function exportText(defaultName, text, ext, label) {
    if (!api || !api.exportFile) return null
    return api.exportFile({ defaultName: safeName(defaultName) + '.' + ext, data: text, filters: [{ name: label || ext.toUpperCase(), extensions: [ext] }] })
  }
  async function exportBlob(defaultName, blob, ext, label) {
    if (!api || !api.exportFile) return null
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return api.exportFile({ defaultName: safeName(defaultName) + '.' + ext, data: bytes, filters: [{ name: label || ext.toUpperCase(), extensions: [ext] }] })
  }
  /** XLSX（主进程 exceljs 三线表）：models.exportTable；通道没有返回 {ok:false, missing:true} */
  async function exportTable(o) {
    const m = api && api.models
    if (!m || typeof m.exportTable !== 'function') return { ok: false, missing: true }
    try { return await m.exportTable(JSON.parse(JSON.stringify({ style: 'report', ...o }))) } catch (e) { return { ok: false, error: (e && e.message) || String(e) } }
  }
  const fileStem = (what) => `${sat.st.label || 'sat'}_${(sat.selMount.value && (sat.selMount.value.name || sat.selMount.value.id)) || ''}_${what}`

  return { win, saveWin, nSamples, tooMany, series, invalidate, exportText, exportBlob, exportTable, fileStem, api }
}
