// 分析页重活的调度：丢进一个常驻 Worker（anaHeavy.worker.js），取消时立即返回（Worker 那一份算完丢掉）。
// Worker 起不来 / 载入失败 / 入参克隆不了（DataCloneError）时，同一张 HEAVY 表在主线程跑 —— 结果与 Worker 逐位一致。
import { HEAVY, abortErr } from './analysisCore.js'

let w = null, broken = false, seq = 0
const pend = new Map()

function failAll(reason) {
  for (const [, p] of pend) p.fallback(reason)
  pend.clear()
}
function worker() {
  if (broken || typeof Worker === 'undefined') return null
  if (w) return w
  try {
    w = new Worker(new URL('./anaHeavy.worker.js', import.meta.url), { type: 'module' })
  } catch { broken = true; w = null; return null }
  w.onmessage = (e) => {
    const d = e.data || {}
    const p = pend.get(d.id)
    if (!p) return
    pend.delete(d.id)
    if (d.ok) p.res(d.r); else p.rej(new Error(d.error || '计算失败'))
  }
  // 模块载入失败（打包路径不对等）：这一次以及以后都回退到主线程
  w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); broken = true; try { w.terminate() } catch { /* ignore */ } w = null; failAll(e) }
  return w
}

/**
 * @param {'power'|'gimbal'} op
 * @param {object} args 纯数据（数字 / 数组 / TypedArray；别传 Vue 响应式代理）
 * @param {{signal?:AbortSignal}} [o]
 */
export function runHeavy(op, args, o = {}) {
  const signal = o.signal
  if (signal && signal.aborted) return Promise.reject(abortErr())
  const sync = () => HEAVY[op](args)
  const ww = worker()
  if (!ww) return new Promise((res) => setTimeout(res, 0)).then(sync)   // 先让一帧：进度与「取消」按钮画出来
  const id = ++seq
  return new Promise((res, rej) => {
    let onAbort = null
    const done = () => { if (onAbort) signal.removeEventListener('abort', onAbort) }
    pend.set(id, {
      res: (r) => { done(); res(r) },
      rej: (e) => { done(); rej(e) },
      fallback: () => { done(); try { res(sync()) } catch (e) { rej(e) } }
    })
    if (signal) { onAbort = () => { pend.delete(id); done(); rej(abortErr()) }; signal.addEventListener('abort', onAbort, { once: true }) }
    try { ww.postMessage({ id, op, args }) } catch (e) {
      // 入参里混了克隆不了的东西：这一次在主线程算
      pend.delete(id); done()
      try { res(sync()) } catch (e2) { rej(e2) }
    }
  })
}

/** 窗口卸载时调（ModelApp） */
export function disposeHeavy() { if (w) { try { w.terminate() } catch { /* ignore */ } w = null } pend.clear() }
