// 多选只为新增 / 重算的结果生成详细预算；限制 IPC 并发，并丢弃旧选区尚未开始的任务。
export function createBudgetWaterfallLoader(request, concurrency = 2) {
  const cache = new WeakMap()
  let queue = [], running = 0, generation = 0

  function pump() {
    while (running < concurrency && queue.length) {
      const job = queue.shift()
      running++
      Promise.resolve().then(() => request(job.data, job.options)).then(
        (segments) => { job.entry.segments = segments; job.resolve(segments) },
        (error) => { job.entries.delete(job.key); job.reject(error) }
      ).finally(() => { running--; pump() })
    }
  }

  function update(rows, options, receive) {
    const gen = ++generation
    // 未发出的请求没有结果可复用，移出缓存；已经在途的请求保留，同一行可继续复用。
    for (const job of queue) { job.entries.delete(job.key); job.resolve(null) }
    queue = []
    rows.forEach((row, i) => {
      if (!row.data) return
      let entries = cache.get(row.data)
      if (!entries) { entries = new Map(); cache.set(row.data, entries) }
      const opts = { ...options, txLocation: row.txName || '', rxLocation: row.rxName || '' }
      const key = JSON.stringify(opts)
      let entry = entries.get(key)
      if (!entry) {
        let resolve, reject
        entry = { promise: new Promise((yes, no) => { resolve = yes; reject = no }) }
        entries.set(key, entry)
        queue.push({ data: row.data, options: opts, entries, key, entry, resolve, reject })
      }
      if (entry.segments) receive(i, { segments: entry.segments, loading: false })
      else entry.promise.then(
        (segments) => { if (gen === generation && segments) receive(i, { segments, loading: false }) },
        (e) => { if (gen === generation) receive(i, { segments: [], loading: false, err: e.message || String(e) }) }
      )
    })
    pump()
  }

  function dispose() {
    generation++
    for (const job of queue) { job.entries.delete(job.key); job.resolve(null) }
    queue = []
  }
  return { update, dispose }
}
