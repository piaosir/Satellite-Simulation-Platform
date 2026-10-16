// 可编程波束地图 · 主线程调度：每次运行一个全新的沙箱 Worker（见 beamScript.worker.js），超时 / 被新一轮取代时直接 terminate。
//
// 预热：手上常备一个「已收下数据、等代码」的 Worker。一轮开跑就把它拿走、立刻在后台再起一个 —— 实时预览连敲几下
// 不必每轮都等 Worker 起动 + 数据克隆（几十万点的等值线克隆要上百毫秒）。数据换了（重新采集）就重起预热件。
// 返回值形状同 runtime.runScript；另有 { canceled: true }（被新一轮取代）与 error.name === 'TimeoutError'。

const mkWorker = () => new Worker(new URL('./beamScript.worker.js', import.meta.url), { type: 'module' })
const token = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

export function createBeamScriptRunner() {
  let data = null
  let warm = null
  let live = null   // 在跑的一轮：{ worker, timer, resolve }

  function spawn() {
    const w = mkWorker()
    if (data) w.postMessage({ type: 'data', data })
    return w
  }
  function finish(res) {
    const cur = live
    if (!cur) return
    live = null
    clearTimeout(cur.timer)
    try { cur.worker.terminate() } catch { /* 已退 */ }
    cur.resolve(res)
  }
  function cancel() { finish({ ok: false, canceled: true, files: [], logs: [], error: null, ms: 0 }) }

  return {
    setData(d) {
      data = d
      if (warm) { try { warm.terminate() } catch { /* ignore */ } }
      warm = null   // 下一轮现起（数据刚换，预热件已过期）
    },
    /**
     * 跑一轮。opts: { lang, scriptName, timeoutMs }。同一时刻只有一轮：新一轮开跑即取消上一轮。
     */
    run(code, opts = {}) {
      cancel()
      const w = warm || spawn()
      warm = spawn()
      const tk = token()
      const timeoutMs = Math.max(500, opts.timeoutMs || 10000)
      return new Promise((resolve) => {
        live = { worker: w, resolve, timer: 0 }
        live.timer = setTimeout(() => finish({
          ok: false, files: [], logs: [], ms: timeoutMs,
          error: { name: 'TimeoutError', message: String(opts.lang === 'en' ? `Script timed out (${timeoutMs / 1000} s)` : `脚本运行超时（${timeoutMs / 1000} s）`), line: null, col: null }
        }), timeoutMs)
        w.onmessage = (e) => {
          const m = e.data
          if (!live || live.worker !== w || !m || m.type !== 'result' || m.token !== tk) return
          finish(m.result)
        }
        w.onerror = (e) => {
          if (!live || live.worker !== w) return
          if (e && e.preventDefault) e.preventDefault()
          finish({ ok: false, files: [], logs: [], ms: 0, error: { name: 'Error', message: String((e && e.message) || (opts.lang === 'en' ? 'Sandbox worker failed' : '沙箱 Worker 异常')), line: null, col: null } })
        }
        w.postMessage({ type: 'run', code: String(code), token: tk, lang: opts.lang === 'en' ? 'en' : 'zh', scriptName: String(opts.scriptName || '') })
      })
    },
    cancel,
    dispose() {
      cancel()
      if (warm) { try { warm.terminate() } catch { /* ignore */ } }
      warm = null; data = null
    }
  }
}
