// 链路表实时预览作业（GSO / NGSO 两窗共用；再生式的预览是闭式算式不走引擎，用不上）。
// 喂的是「地球站配置」格的第二行 EIRP / G·T 与功放尾标（computedVals 里的 _eirp / _gt / _paW）。
//
// 原先是一行一次 IPC、串行 await 到底：千行表要跑上千个往返，每个回包各自触发一次整表重渲染，
// 中途点「计算」也只能跟它抢主进程。现在：
//   ① 分块批量：一块几十到几百行一次 IPC（块长按 sizes 递增：头一块小、先把眼前的行填上，后面块大、
//      万行表少渲染几次），每块回来只合并一次 computedVals → 重渲染次数从「行数」降到「块数」；
//   ② 代际取消：输入再变 / 手动刷新 → gen++，跑着的作业在下一个块边界退出，迟到的回包按代际丢弃，
//      在算的那块也顺手向主进程发取消令牌（算的是旧输入，早停早省）；
//   ③ 「计算」优先：pause() 立刻取消在算那块（主进程在下一个让出点停手、交回已算部分，没算的项留
//      null），作业挂起不再发块；resume() 后从没算完的行接着跑，不从头来。挂起期间的 schedule()
//      只记账并作废当前作业，恢复时统一重排一次；
//   ④ 行入参按块惰性组装（build(i) 发块前才调）：万行表不在作业开头同步组一遍参数把界面卡住。
// 纯逻辑、不依赖 Vue，便于单测（packages/core/test/lbPreview.test.mjs）。
//
//   createPreviewJob({
//     count: () => 行数,
//     build: (i) => ({ id, spec }) | null,       // 第 i 行的入参（组不出来返回 null 跳过该行）
//     send: (specs, token) => Promise<results>,  // 一块的批量 IPC；results 与 specs 对齐，null＝主进程按令牌停手没算到
//     cancel: (token) => void,                   // 通知主进程停手（fire-and-forget）
//     apply: ([{ id, r }]) => void,              // 一块算完：把结果合并进表（同步一次）
//     delay, sizes
//   })
//   .schedule()   输入变了：防抖重跑；挂起期间只记账    .refresh()  立即重跑（返回本轮完成的 Promise）
//   .pause() / .resume()   「计算」期间挂起 / 算完续跑   .suppress(on)  编排期间静默 schedule
//   .dispose()    卸载
export function createPreviewJob({ count, build, send, cancel, apply, delay = 350, sizes = [50, 100, 200, 400] }) {
  let gen = 0                    // 代际：每次 refresh() / schedule() 递增，跑着的作业在块边界比对，不等即退出
  let timer = null               // schedule() 的防抖计时器
  let suppressed = false         // 编排期间静默 schedule（「刷新最新设置」那一套扇出最后只跑一次）
  let paused = false             // 「计算」进行中：不发新块
  let pendingWhilePaused = false // 挂起期间来过 schedule()：恢复时补排一次
  let inflight = null            // 在算那块的令牌（发出 IPC 到回包之间）
  let cancelledTok = null        // 已向主进程发过取消的令牌：它交回的 null 项才是「没算到」，要重发
  let waiters = []               // 挂起中等 resume() 的作业
  let seq = 0                    // 令牌序号（每块一个，本作业内唯一）
  const cancelOf = (tok) => { cancelledTok = tok; try { cancel(tok) } catch (e) { /* ignore */ } }
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
  const untilResumed = () => new Promise((r) => { waiters.push(r) })

  async function run(g) {
    const n = count()
    let i = 0, k = 0          // 行游标 / 块序号（块长按 sizes 递增）
    let queue = []            // 主进程停手交回的没算项：回到队头，恢复后先发
    while (g === gen && (queue.length || i < n)) {
      if (paused) { await untilResumed(); continue }   // 醒来先重验代际（挂起期间 schedule 过就退出）
      const size = sizes[Math.min(k++, sizes.length - 1)]
      const items = queue.splice(0, size)
      while (items.length < size && i < n) { const it = build(i++); if (it) items.push(it) }
      if (!items.length) continue
      const token = 'pv' + (++seq)
      inflight = token
      let res = null
      try { res = await send(items.map((x) => x.spec), token) } catch (e) { res = null }
      if (inflight === token) inflight = null
      if (g !== gen) return
      if (!Array.isArray(res)) continue   // 整块失败：这些行跳过（老口径：算不出就不动原值）
      // 只有被取消的那块交回的 null 才是「没算到」；别的来源的 null 一律当算不出，免得重发成死循环
      const stopped = cancelledTok === token
      const done = [], left = []
      items.forEach((x, j) => { const r = res[j]; if (r != null) done.push({ id: x.id, r }); else if (stopped) left.push(x) })
      if (done.length) apply(done)
      if (left.length) queue = left.concat(queue)
    }
  }

  function refresh() {
    clearTimer()
    const g = ++gen
    return run(g)
  }
  function schedule() {
    if (suppressed) return
    gen++                                          // 跑着的作业作废（输入已变，算的是旧值）
    if (inflight) cancelOf(inflight)
    if (paused) { pendingWhilePaused = true; return }   // 「计算」优先：恢复时再排
    clearTimer()
    timer = setTimeout(() => { timer = null; refresh() }, delay)
  }
  function pause() {
    if (paused) return
    paused = true
    if (inflight) cancelOf(inflight)
  }
  function resume() {
    if (!paused) return
    paused = false
    const w = waiters; waiters = []
    if (pendingWhilePaused) { pendingWhilePaused = false; schedule() }
    w.forEach((r) => r())
  }
  function suppress(on) { suppressed = !!on; if (on) clearTimer() }
  function dispose() {
    clearTimer(); gen++
    if (inflight) cancelOf(inflight)
    const w = waiters; waiters = []; paused = false
    w.forEach((r) => r())
  }
  const state = () => ({ gen, paused, pending: pendingWhilePaused, inflight, timer: !!timer })
  return { schedule, refresh, pause, resume, suppress, dispose, state }
}
