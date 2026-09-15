// 链路表实时预览作业自测（src/shared/lbPreview.js，渲染端 ESM）。运行：npm test
//
// 关键不变式：
//   ① 分块：块长按 sizes 递增，一块回来只 apply 一次；行入参惰性组装（build 在发块前才调，null 跳过）；
//   ② 代际：schedule() / refresh() 作废跑着的作业，迟到的回包不落地，在算那块被发取消令牌；
//   ③ 「计算」优先：pause() 取消在算那块、不再发块；主进程交回的 null 项在 resume() 后回到队头重发，
//      不从头来；挂起期间 schedule() 只记账，恢复时统一重排；
//   ④ 不死循环：没被取消的块里冒出的 null 当算不出丢弃，send 抛错跳过该块继续；
//   ⑤ suppress 静默 schedule 不静默 refresh；dispose 后挂起中的作业能退出。
import { createPreviewJob } from '../../../src/shared/lbPreview.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const ids = (specs) => specs.map((s) => 'r' + s.i)
const full = (specs) => specs.map((s) => ({ success: true, i: s.i }))

function fake({ n = 10, sizes = [2, 4], delay = 10, skip = () => false } = {}) {
  const calls = [], cancels = [], applied = []
  const job = createPreviewJob({
    count: () => n,
    build: (i) => (skip(i) ? null : { id: 'r' + i, spec: { i } }),
    send: (specs, token) => new Promise((resolve, reject) => { calls.push({ specs, token, resolve, reject }) }),
    cancel: (t) => cancels.push(t),
    apply: (list) => applied.push(list.map((x) => x.id)),
    delay, sizes
  })
  return { job, calls, cancels, applied }
}

// —— ① 分块递增 + 一块一次 apply ——
{
  const { job, calls, applied } = fake()
  const p = job.refresh()
  ok('refresh 同步发出第一块', calls.length === 1 && calls[0].specs.length === 2, calls.length)
  calls[0].resolve(full(calls[0].specs)); await tick()
  ok('第二块按 sizes 递增到 4', calls.length === 2 && calls[1].specs.length === 4, calls[1] && calls[1].specs.length)
  calls[1].resolve(full(calls[1].specs)); await tick()
  ok('第三块封顶 4（sizes 最后一档）', calls.length === 3 && calls[2].specs.length === 4)
  calls[2].resolve(full(calls[2].specs)); await p
  ok('三块各 apply 一次、行序连续', JSON.stringify(applied) === JSON.stringify([['r0', 'r1'], ['r2', 'r3', 'r4', 'r5'], ['r6', 'r7', 'r8', 'r9']]), JSON.stringify(applied))
  ok('令牌逐块唯一', new Set(calls.map((c) => c.token)).size === 3)
  ok('跑完 inflight 清空', job.state().inflight === null)
}

// —— ① build 返回 null 的行跳过、块长照满 ——
{
  const { job, calls } = fake({ n: 5, sizes: [3], skip: (i) => i === 1 })
  const p = job.refresh()
  ok('跳过的行不占块位（0,2,3 凑满一块）', ids(calls[0].specs).join() === 'r0,r2,r3', ids(calls[0].specs).join())
  calls[0].resolve(full(calls[0].specs)); await tick()
  ok('余下一行单独成块', calls.length === 2 && ids(calls[1].specs).join() === 'r4')
  calls[1].resolve(full(calls[1].specs)); await p
}

// —— ② schedule 作废跑着的作业：迟到回包不落地、在算块被取消、防抖后重跑 ——
{
  const { job, calls, cancels, applied } = fake({ n: 4, sizes: [2] })
  const p = job.refresh()
  job.schedule()
  ok('schedule 立刻取消在算那块', cancels.length === 1 && cancels[0] === calls[0].token)
  calls[0].resolve(full(calls[0].specs)); await p
  ok('作废作业的回包不 apply、作业退出', applied.length === 0 && calls.length === 1)
  await wait(30)
  ok('防抖到期后重跑（新令牌）', calls.length === 2 && calls[1].token !== calls[0].token && calls[1].specs.length === 2, calls.length)
  job.schedule(); job.schedule(); job.schedule()
  await wait(30)
  ok('连发三次 schedule 只多跑一轮', calls.length === 3, calls.length)
  job.dispose()
}

// —— ③ pause 取消在算块；交回的 null 项 resume 后回队头重发，不从头来 ——
{
  const { job, calls, cancels, applied } = fake({ n: 6, sizes: [4] })
  const p = job.refresh()
  job.pause()
  ok('pause 向主进程发了在算块的令牌', cancels.length === 1 && cancels[0] === calls[0].token)
  calls[0].resolve([{ success: true, i: 0 }, { success: true, i: 1 }, null, null]); await tick()
  ok('停手前算完的两行照常落地', JSON.stringify(applied) === JSON.stringify([['r0', 'r1']]), JSON.stringify(applied))
  ok('挂起期间不发新块', calls.length === 1)
  job.resume(); await tick()
  ok('resume 后先重发没算到的 2,3 再接 4,5', calls.length === 2 && ids(calls[1].specs).join() === 'r2,r3,r4,r5', calls[1] && ids(calls[1].specs).join())
  calls[1].resolve(full(calls[1].specs)); await p
  ok('续跑结束全表落齐', JSON.stringify(applied) === JSON.stringify([['r0', 'r1'], ['r2', 'r3', 'r4', 'r5']]))
  ok('重复 pause/resume 幂等', (job.pause(), job.pause(), job.resume(), job.resume(), !job.state().paused))
}

// —— ③ 挂起期间 schedule 只记账：恢复时统一重排、作废的作业退出 ——
{
  const { job, calls, applied } = fake({ n: 4, sizes: [2] })
  const p = job.refresh()
  job.pause()
  job.schedule()
  ok('挂起期间 schedule 只记账不起计时器', job.state().pending && !job.state().timer)
  calls[0].resolve(full(calls[0].specs)); await p
  ok('作废的作业退出、回包不落地', applied.length === 0 && calls.length === 1)
  job.resume()
  ok('resume 起了一次防抖计时器', job.state().timer && !job.state().pending)
  await wait(30)
  ok('恢复后重排一轮', calls.length === 2, calls.length)
  job.dispose()
}

// —— ③ 挂起时 refresh：作业在闸门前等，resume 后才发块 ——
{
  const { job, calls } = fake({ n: 2, sizes: [2] })
  job.pause()
  const p = job.refresh(); await tick()
  ok('挂起中 refresh 不发块', calls.length === 0)
  job.resume(); await tick()
  ok('resume 后发出', calls.length === 1)
  calls[0].resolve(full(calls[0].specs)); await p
}

// —— ④ 不死循环：没被取消的块里的 null 当算不出丢弃；send 抛错跳过该块 ——
{
  const { job, calls, applied } = fake({ n: 4, sizes: [2] })
  const p = job.refresh()
  calls[0].resolve([{ success: true, i: 0 }, null]); await tick()
  ok('未取消块的 null 不重发（直接发下一块）', calls.length === 2 && ids(calls[1].specs).join() === 'r2,r3', calls[1] && ids(calls[1].specs).join())
  calls[1].reject(new Error('boom')); await p
  ok('send 抛错：该块跳过、作业正常结束', JSON.stringify(applied) === JSON.stringify([['r0']]) && calls.length === 2)
}

// —— ④ 失败项不 apply（老口径：算不出不动原值）——
{
  const { job, calls, applied } = fake({ n: 2, sizes: [2] })
  const p = job.refresh()
  calls[0].resolve([{ success: false, message: 'x' }, { success: true, i: 1 }]); await p
  ok('失败项照样交给 apply（由调用方按 success 过滤）', JSON.stringify(applied) === JSON.stringify([['r0', 'r1']]))
}

// —— ⑤ suppress 静默 schedule、不静默 refresh；dispose 让挂起中的作业退出 ——
{
  const { job, calls } = fake({ n: 2, sizes: [2] })
  job.suppress(true)
  job.schedule()
  ok('suppress 期间 schedule 无效', !job.state().timer)
  job.suppress(false)
  const p = job.refresh()
  ok('suppress 解除后 refresh 照跑', calls.length === 1)
  calls[0].resolve(full(calls[0].specs)); await p
  job.pause()
  const p2 = job.refresh()
  let settled = false; p2.then(() => { settled = true })
  job.dispose(); await tick()
  ok('dispose 后挂起中的作业退出（Promise 结清）', settled && calls.length === 1)
}

// —— 空表：不发块、Promise 立即结清 ——
{
  const { job, calls } = fake({ n: 0 })
  await job.refresh()
  ok('空表不发块', calls.length === 0)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
if (fail) process.exit(1)
