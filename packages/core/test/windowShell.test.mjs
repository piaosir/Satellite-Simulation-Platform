// 主进程窗口外壳与文件回执（2026-10-14 交互调研 A1 / C1 / C2 / C3 / C4 / D5 / E3）。运行：npm test -- windowShell
//   ① sceneCmd.sanitizeSceneCmd：scene:cmd 白名单与参数清洗（未知 cmd 拒收、数值有限且在范围内、字符串去控制字符截长）
//   ② exportedPaths：回执白名单（不分大小写）、兄弟文件覆盖核对、确认框文案
//   ③ windowGuard.clampBounds：窗口几何钳进某块显示器的工作区
//   ④ windowGuard.createWindowKit：关窗守卫（未就绪放行 / 转问 / 回执 / 3 s 无回执弹「窗口无响应」/ 取消 / 到点放行）与崩溃框
//   ⑤ register.js 原样装进假 electron：files:reveal / open 白名单、file:saveMany 覆盖确认、scene:cmd 中继、
//      freqPlan:changed 广播（不发给发起者）、coverageGrd:remove 进回收站、app:quit
//   ⑥ preload.js 的 onGuard：回执 → 应用回调 → 没确认就 guard:cancel；注册报 ready、退订报 { on:false }
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const Module = require('module')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let pass = 0
const ok = (cond, msg) => { assert.ok(cond, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }
const tick = () => new Promise((r) => setImmediate(r))

// ───────── ① scene:cmd 清洗 ─────────
{
  const { sanitizeSceneCmd: S, SCENE_CMDS } = require(path.join(ROOT, 'electron/services/sceneCmd.js'))
  eq([...SCENE_CMDS].sort(), ['faceLonLat', 'focusSat', 'markTime', 'seekClock'], '① 白名单恰好四条')
  const t = Date.UTC(2026, 9, 14, 3, 0, 0)
  eq(S('seekClock', { tMs: t, extra: 1 }), { cmd: 'seekClock', payload: { tMs: t } }, '① seekClock：只留 tMs')
  eq(S('seekClock', { tMs: String(t) }), { cmd: 'seekClock', payload: { tMs: t } }, '① seekClock：数字串照收')
  for (const bad of [NaN, Infinity, null, '', 'abc', true, Date.UTC(1800, 0, 1), Date.UTC(2300, 0, 1)]) ok(S('seekClock', { tMs: bad }) === null, '① seekClock 拒收 ' + String(bad))
  ok(S('rmrf', { tMs: t }) === null && S('', {}) === null && S(null, {}) === null && S('__proto__', {}) === null && S('toString', {}) === null, '① 未知 cmd 一律拒收（含原型链上的名字）')
  eq(S('focusSat', { norad: 25544 }), { cmd: 'focusSat', payload: { norad: '25544' } }, '① focusSat：数字 NORAD 转串')
  eq(S('focusSat', { norad: '255;44\n', name: '  ISS (ZARYA)\u0007 ' }), { cmd: 'focusSat', payload: { norad: '25544', name: 'ISS (ZARYA)' } }, '① focusSat：NORAD 去杂字、名字去控制字符与首尾空白')
  ok(S('focusSat', {}) === null && S('focusSat', { norad: ';;', name: '   ' }) === null, '① focusSat：两样都没有 → 拒收')
  ok(S('focusSat', { name: 'x'.repeat(500) }).payload.name.length === 160, '① focusSat：名字截到 160')
  eq(S('faceLonLat', { lat: 39.9, lon: 116.4, name: '北京' }), { cmd: 'faceLonLat', payload: { lat: 39.9, lon: 116.4, name: '北京' } }, '① faceLonLat')
  eq(S('faceLonLat', { lat: -10, lon: 270 }).payload, { lat: -10, lon: -90 }, '① faceLonLat：经度归一到 (−180, 180]')
  eq(S('faceLonLat', { lat: 0, lon: -180 }).payload, { lat: 0, lon: 180 }, '① faceLonLat：−180 归到 180')
  for (const p of [{ lat: 91, lon: 0 }, { lat: 0, lon: 400 }, { lat: 'x', lon: 0 }, { lat: 0 }, {}]) ok(S('faceLonLat', p) === null, '① faceLonLat 拒收 ' + JSON.stringify(p))
  eq(S('markTime', { t0: t, label: '过境', src: 'ngso' }), { cmd: 'markTime', payload: { t0: t, label: '过境', src: 'ngso' } }, '① markTime：时刻点')
  eq(S('markTime', { t0: t + 60000, t1: t, label: 'a', src: 'b' }).payload, { t0: t, t1: t + 60000, label: 'a', src: 'b' }, '① markTime：t1 < t0 交换')
  eq(S('markTime', { t0: t, t1: t, label: 'a', src: 'b' }).payload, { t0: t, label: 'a', src: 'b' }, '① markTime：t1 = t0 当时刻点')
  ok(S('markTime', { t0: t, t1: 'oops', label: 'a', src: 'b' }) === null, '① markTime：给了非法 t1 → 整条拒收')
  ok(S('markTime', { t0: t, label: '', src: 'b' }) === null && S('markTime', { t0: t, label: 'a' }) === null, '① markTime：label / src 必填')
  ok(S('markTime', { t0: t, label: 'a', src: 'b'.repeat(100) }).payload.src.length === 40, '① markTime：src 截到 40')
  ok(S('seekClock', [t]) === null && S('seekClock', 'x') === null, '① 载荷不是对象 → 当空对象，缺 tMs 拒收')
}

// ───────── ② exportedPaths ─────────
const EP = require(path.join(ROOT, 'electron/services/exportedPaths.js'))
{
  EP.clearExported()
  const p = path.join(os.tmpdir(), 'Satsim-Receipt', 'Report.XLSX')
  ok(EP.markExported(p) === path.resolve(p), '② markExported 回规范路径')
  ok(EP.isExported(p) && EP.isExported(path.join(os.tmpdir(), 'Satsim-Receipt', '.', 'Report.XLSX')), '② isExported：同一路径的不同写法')
  if (process.platform === 'win32') ok(EP.isExported(p.toLowerCase()) && EP.isExported(p.toUpperCase()), '② Windows 不分大小写')
  ok(!EP.isExported(p + '.bak') && !EP.isExported('') && !EP.isExported(null) && !EP.isExported(42), '② 没登记的 / 空 / 非串 → false')
  ok(EP.markExported('') === '' && EP.markExported(null) === '', '② 空路径不登记')
  const has = new Set(['a.xlsx', 'a.docx', 'a.pdf'].map((x) => path.resolve('/r', x)))
  const exists = (q) => has.has(path.resolve(q))
  const T = ['a.xlsx', 'a.docx', 'a.pdf', 'a.docx'].map((x) => path.resolve('/r', x))
  eq(EP.pendingOverwrites(T, path.resolve('/r', 'a.xlsx'), exists), [path.resolve('/r', 'a.docx'), path.resolve('/r', 'a.pdf')], '② 兄弟文件：保存框确认过的那个不算、重复去重、顺序不变')
  if (process.platform === 'win32') eq(EP.pendingOverwrites(T, path.resolve('/r', 'A.XLSX'), exists).length, 2, '② 确认过的那个按不分大小写比')
  eq(EP.pendingOverwrites([path.resolve('/r', 'b.xlsx')], null, exists), [], '② 不存在的不算')
  eq(EP.pendingOverwrites(null, null, exists), [], '② 空清单')
  const zh = EP.overwritePrompt([path.resolve('/r', 'a.docx'), path.resolve('/r', 'a.pdf')], 'zh')
  eq([zh.type, zh.message, zh.detail, zh.buttons, zh.defaultId, zh.cancelId], ['warning', '以下文件已存在', 'a.docx\na.pdf', ['替换', '取消'], 1, 1], '② 确认框：只写状态，默认取消')
  const en = EP.overwritePrompt([path.resolve('/r', 'a.docx')], 'en')
  eq([en.message, en.buttons], ['The following files already exist', ['Replace', 'Cancel']], '② 英文界面')
  const many = EP.overwritePrompt(Array.from({ length: 20 }, (_, i) => path.resolve('/r', `m${i}.xml`)), 'zh').detail.split('\n')
  ok(many.length === EP.OVERWRITE_MAX_NAMES + 1 && many[many.length - 1] === '…（共 20 个）', '② 文件多了只列前 15 个 + 总数')
  let asked = null
  const fakeDlg = (resp) => ({ showMessageBox: async (w, o) => { asked = o; return { response: resp } } })
  ok(await EP.confirmOverwrites(fakeDlg(1), {}, [], 'zh') === true && asked === null, '② 没有冲突不弹框')
  ok(await EP.confirmOverwrites(fakeDlg(0), {}, ['x'], 'zh') === true && asked.message === '以下文件已存在', '② 点「替换」→ 可写')
  ok(await EP.confirmOverwrites(fakeDlg(1), {}, ['x'], 'zh') === false, '② 点「取消」→ 不写')
  EP.clearExported()
}

// ───────── ③ clampBounds ─────────
const W = require(path.join(ROOT, 'electron/services/windowGuard.js'))
{
  const C = W.clampBounds
  const DEF = { width: 1440, height: 900, minWidth: 1100, minHeight: 720 }
  const P = { x: 0, y: 0, width: 1920, height: 1040 }            // 主屏工作区（任务栏 40）
  const R = { x: 1920, y: 0, width: 2560, height: 1400 }         // 右侧外接屏
  eq(C(null, DEF, [P]), { opt: { width: 1440, height: 900 }, maximized: false }, '③ 没记过 → 缺省尺寸、不给位置')
  eq(C({ width: 'x', height: 5 }, DEF, [P]).opt, { width: 1440, height: 900 }, '③ 记坏了 → 缺省')
  eq(C({ x: 100, y: 80, width: 1500, height: 950, maximized: true }, DEF, [P]), { opt: { width: 1500, height: 950, x: 100, y: 80 }, maximized: true }, '③ 屏内原样回来、记住最大化')
  eq(C({ x: 100, y: 80, width: 600, height: 300 }, DEF, [P]).opt, { width: 1100, height: 720, x: 100, y: 80 }, '③ 不小于最小尺寸')
  eq(C({ x: 1000, y: 500, width: 1500, height: 950 }, DEF, [P]).opt, { width: 1500, height: 950, x: 420, y: 90 }, '③ 伸出屏外的部分推回来（整窗可见）')
  eq(C({ x: -3000, y: 200, width: 1500, height: 950 }, DEF, [P]).opt, { width: 1500, height: 950 }, '③ 跟哪块屏都不重叠（外接屏拔了）→ 不给位置，系统居中')
  eq(C({ x: 2200, y: 100, width: 1600, height: 1000 }, DEF, [P, R]).opt, { width: 1600, height: 1000, x: 2200, y: 100 }, '③ 在外接屏上 → 按外接屏认')
  eq(C({ x: 2200, y: 100, width: 1600, height: 1000 }, DEF, [P]).opt, { width: 1600, height: 1000 }, '③ 外接屏拔了 → 不给位置')
  eq(C({ x: 0, y: 0, width: 3000, height: 2000 }, DEF, [P]).opt, { width: 1920, height: 1040, x: 0, y: 0 }, '③ 比屏还大 → 钳到工作区')
  eq(C({ x: 1700, y: 0, width: 1600, height: 1000 }, DEF, [P, R]).opt, { width: 1600, height: 1000, x: 1920, y: 0 }, '③ 跨两块屏 → 归到重叠多的那块')
  eq(C({ x: 50, y: 60, width: 1500, height: 950 }, DEF, []).opt, { width: 1500, height: 950, x: 50, y: 60 }, '③ 取不到屏信息 → 原样（只保最小尺寸）')
  eq(C({ width: 1500, height: 950 }, DEF, [P]).opt, { width: 1500, height: 950 }, '③ 只有尺寸没有位置')
}

// ───────── ④ 守卫与崩溃框（假窗口） ─────────
function fakeEmitter() {
  const h = new Map()
  return {
    on(ev, fn) { if (!h.has(ev)) h.set(ev, []); h.get(ev).push(fn); return this },
    once(ev, fn) { const w = (...a) => { this.removeListener(ev, w); fn(...a) }; return this.on(ev, w) },
    removeListener(ev, fn) { const l = h.get(ev); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1) } return this },
    emit(ev, ...a) { for (const fn of [...(h.get(ev) || [])]) fn(...a) },
    count(ev) { return (h.get(ev) || []).length }
  }
}
let wcSeq = 100
function fakeWin(title) {
  const win = fakeEmitter()
  const wc = fakeEmitter()
  wc.id = ++wcSeq
  wc.sent = []
  wc.crashed = false; wc.loading = false; wc.reloads = 0; wc.destroyed = false
  wc.send = (ch, ...a) => { if (wc.throwOnSend) throw new Error('gone'); wc.sent.push([ch, ...a]) }
  wc.isDestroyed = () => wc.destroyed
  wc.isCrashed = () => wc.crashed
  wc.isLoadingMainFrame = () => wc.loading
  wc.reload = () => { wc.reloads++ }
  win.webContents = wc
  win.destroyed = false
  win.closedBy = null
  win.isDestroyed = () => win.destroyed
  win.getTitle = () => title || '计算窗'
  // close()：发 close 事件，没被拦就关（closed）
  win.close = () => {
    if (win.destroyed) return
    let prevented = false
    win.emit('close', { preventDefault() { prevented = true } })
    if (!prevented) { win.destroyed = true; wc.destroyed = true; win.closedBy = 'close'; win.emit('closed') }
  }
  win.destroy = () => { if (win.destroyed) return; win.destroyed = true; wc.destroyed = true; win.closedBy = 'destroy'; win.emit('closed') }
  return win
}
{
  const ipc = fakeEmitter()
  const sendFrom = (win, ch, v) => ipc.emit(ch, { sender: win.webContents }, v)
  const boxes = []
  let answer = 0
  const dialog = {
    showMessageBox: (win, opt) => new Promise((resolve) => {
      const b = { win, opt, resolve }
      boxes.push(b)
      if (opt.signal) opt.signal.addEventListener('abort', () => resolve({ response: opt.cancelId }))
      if (answer != null) setImmediate(() => resolve({ response: answer }))
    })
  }
  let quitting = false
  const kit = W.createWindowKit({ dialog, ipcMain: ipc, isQuitting: () => quitting, lang: () => 'zh', ackMs: 30 })
  const mk = (opt) => {
    const win = fakeWin()
    let allow = false
    kit.guard(win, { channel: 'x:closeRequested', allowed: () => allow, release: () => { allow = true }, ...(opt || {}) })
    kit.watch(win)
    return { win, wc: win.webContents, isAllowed: () => allow }
  }

  // 没报 ready：直接放行
  let A = mk()
  A.win.close()
  ok(A.win.destroyed && A.wc.sent.length === 0, '④ 渲染端没报 guard:ready → 关窗直接放行，不转问')

  // ready：拦下转问；回执后不弹框；再点 X 照常重发
  A = mk()
  sendFrom(A.win, 'guard:ready', { on: true, lang: 'zh' })
  A.win.close()
  ok(!A.win.destroyed && A.wc.sent.length === 1 && A.wc.sent[0][0] === 'x:closeRequested', '④ 就绪后点 X → 拦下并转问渲染端')
  A.win.close()
  ok(A.wc.sent.length === 1, '④ 回执之前重复点 X 不重发')
  sendFrom(A.win, 'guard:ack', { lang: 'zh' })
  await new Promise((r) => setTimeout(r, 60))
  ok(boxes.length === 0, '④ 3 s（测试里 30 ms）内回执到了 → 不弹「无响应」')
  A.win.close()
  ok(A.wc.sent.length === 2, '④ 回执之后再点 X 重新转问（渲染端取消过也能再关）')
  sendFrom(A.win, 'guard:ack', {})

  // guard:cancel → onCancel 订阅收到
  let cancelled = 0
  const off = kit.onCancel(A.win, () => { cancelled++ })
  sendFrom(A.win, 'guard:cancel')
  ok(cancelled === 1, '④ guard:cancel → onCancel 订阅收到（「退出」据此中止）')
  off(); sendFrom(A.win, 'guard:cancel')
  ok(cancelled === 1, '④ 退订后不再收到')

  // 渲染端确认（confirmClose：放行标志置真再 close）→ 真关
  A.win.close(); sendFrom(A.win, 'guard:ack', {})
  // （mk 的 release 就是 confirmClose 置的那个标志）
  // 退订 ready：{ on:false } 之后放行
  const B = mk()
  sendFrom(B.win, 'guard:ready', { on: true })
  sendFrom(B.win, 'guard:ready', { on: false })
  B.win.close()
  ok(B.win.destroyed && B.wc.sent.length === 0, '④ 渲染端全部退订（ready on:false）→ 放行')

  // 无回执 → 「窗口无响应」→ 强制关闭
  answer = 1
  const C = mk()
  sendFrom(C.win, 'guard:ready', { on: true })
  C.win.close()
  await new Promise((r) => setTimeout(r, 80))
  const hb = boxes[boxes.length - 1]
  ok(hb && hb.opt.message === '窗口无响应' && hb.opt.buttons.join() === '等待,强制关闭' && hb.opt.title === '计算窗', '④ 30 ms 无回执 → 弹「窗口无响应」[等待][强制关闭]，标题是窗口名')
  ok(C.win.destroyed && C.win.closedBy === 'destroy' && C.isAllowed(), '④ 强制关闭 → 放行守卫并 destroy（不等 beforeunload）')

  // 无回执 → 「等待」→ 再点 X 重新转问
  answer = 0
  const D = mk()
  sendFrom(D.win, 'guard:ready', { on: true })
  D.win.close()
  await new Promise((r) => setTimeout(r, 80))
  ok(!D.win.destroyed, '④ 等待 → 窗口留着')
  D.win.close()
  ok(D.wc.sent.length === 2, '④ 等待之后再点 X 重新转问')
  sendFrom(D.win, 'guard:ack', {})

  // 回执晚到：框自动收起
  answer = null
  const E = mk()
  sendFrom(E.win, 'guard:ready', { on: true })
  E.win.close()
  await new Promise((r) => setTimeout(r, 60))
  const before = boxes.length
  ok(boxes[before - 1].win === E.win, '④ 无回执弹框')
  sendFrom(E.win, 'guard:ack', {})
  await tick(); await tick()
  ok(!E.win.destroyed, '④ 回执晚到 → 框收起，窗口不关（交给渲染端）')

  // 崩溃 / 加载中 → 放行
  const F = mk()
  sendFrom(F.win, 'guard:ready', { on: true })
  F.wc.crashed = true
  F.win.close()
  ok(F.win.destroyed, '④ 渲染进程已崩溃 → 放行')
  const G = mk()
  sendFrom(G.win, 'guard:ready', { on: true })
  G.wc.loading = true
  G.win.close()
  ok(G.win.destroyed, '④ 主框架还在加载 → 放行')

  // 整页导航 → ready 复位
  const H = mk()
  sendFrom(H.win, 'guard:ready', { on: true })
  H.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  H.win.close()
  ok(H.win.destroyed, '④ 重新载入后新页面还没报 ready → 放行')
  const H2 = mk()
  sendFrom(H2.win, 'guard:ready', { on: true })
  H2.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  H2.wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  H2.win.close()
  ok(!H2.win.destroyed, '④ 页内导航 / 子框架导航不复位')
  sendFrom(H2.win, 'guard:ack', {})

  // 退出中：一律放行
  quitting = true
  const Q = mk()
  sendFrom(Q.win, 'guard:ready', { on: true })
  Q.win.close()
  ok(Q.win.destroyed && Q.wc.sent.length === 0, '④ before-quit 之后守卫放行')
  quitting = false

  // 到点放行（模型工作台）：不弹框，到点 close
  answer = 1
  const M = mk({ autoReleaseMs: 40 })
  sendFrom(M.win, 'guard:ready', { on: true })
  const nb = boxes.length
  M.win.close()
  sendFrom(M.win, 'guard:ack', {})
  ok(!M.win.destroyed, '④ 到点放行档：先转问')
  await new Promise((r) => setTimeout(r, 90))
  ok(M.win.destroyed && M.win.closedBy === 'close' && boxes.length === nb, '④ 到点放行档：渲染端没确认 → 到点正常 close，不弹框')

  // 发送失败（webContents 已没了）→ 放行
  const N = mk()
  sendFrom(N.win, 'guard:ready', { on: true })
  N.wc.throwOnSend = true
  N.win.close()
  ok(N.win.destroyed, '④ 转问发不出去 → 放行')

  // 崩溃框：重新载入 / 关闭
  answer = 0
  const K = mk()
  sendFrom(K.win, 'guard:ready', { on: true })
  K.wc.emit('render-process-gone', {}, { reason: 'crashed' })
  await tick(); await tick(); await tick()
  const kb = boxes[boxes.length - 1]
  ok(kb.opt.message === '窗口已崩溃' && kb.opt.buttons.join() === '重新载入,关闭' && kb.opt.type === 'error', '④ 崩溃 → 「窗口已崩溃」[重新载入][关闭]')
  await new Promise((r) => setTimeout(r, 10))
  ok(K.wc.reloads === 1 && !K.win.destroyed, '④ 重新载入 → reload，窗口留着')
  answer = 1
  const L = mk()
  L.wc.emit('render-process-gone', {}, { reason: 'oom' })
  await new Promise((r) => setTimeout(r, 10))
  ok(L.win.destroyed, '④ 崩溃 → 关闭 → 窗口关掉')
  const nb2 = boxes.length
  const L2 = mk()
  L2.wc.emit('render-process-gone', {}, { reason: 'clean-exit' })
  await tick()
  ok(boxes.length === nb2 && !L2.win.destroyed, '④ clean-exit 不弹框')

  // 无响应事件：恢复响应后框收起
  answer = null
  const U = mk()
  U.win.emit('unresponsive')
  await tick(); await tick()
  ok(boxes[boxes.length - 1].win === U.win && boxes[boxes.length - 1].opt.message === '窗口无响应', '④ unresponsive → 「窗口无响应」')
  U.win.emit('unresponsive')
  await tick()
  const nb3 = boxes.length
  ok(boxes.filter((b) => b.win === U.win).length === 1, '④ 同一扇窗不叠第二个框')
  U.win.emit('responsive')
  await tick(); await tick()
  ok(!U.win.destroyed && boxes.length === nb3, '④ 恢复响应 → 框收起、窗口不动')

  // 英文界面
  answer = 0
  const kitEn = W.createWindowKit({ dialog, ipcMain: fakeEmitter(), lang: async () => 'en' })
  const V = fakeWin('Rain')
  kitEn.watch(V)
  V.wc = V.webContents
  V.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  await new Promise((r) => setTimeout(r, 10))
  ok(boxes[boxes.length - 1].opt.message === 'The window has crashed' && boxes[boxes.length - 1].opt.buttons.join() === 'Reload,Close', '④ 英文界面的崩溃框')
}

// ───────── ⑤ register.js（假 electron）─────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'winshell-'))
const handlers = new Map()
const trashed = []
const shown = [], opened = []
let saveDirPick = null, saveFilePick = null, msgAnswer = 1, msgAsked = 0
const winsSent = []
const fakeWins = [
  { id: 1, webContents: { id: 11, send: (ch, m) => winsSent.push([11, ch, m]) }, isDestroyed: () => false },
  { id: 2, webContents: { id: 12, send: (ch, m) => winsSent.push([12, ch, m]) }, isDestroyed: () => false },
  { id: 3, webContents: { id: 13, send: (ch, m) => winsSent.push([13, ch, m]) }, isDestroyed: () => false }
]
const fakeElectron = {
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
  dialog: {
    showSaveDialog: async () => (saveFilePick ? { canceled: false, filePath: saveFilePick } : { canceled: true }),
    showOpenDialog: async () => (saveDirPick ? { canceled: false, filePaths: [saveDirPick] } : { canceled: true }),
    showMessageBox: async () => { msgAsked++; return { response: msgAnswer } }
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => fakeWins },
  app: { getPath: () => TMP, isPackaged: false, getVersion: () => '0' },
  shell: {
    openExternal: async () => {},
    openPath: async (p) => { opened.push(p); return '' },
    showItemInFolder: (p) => { shown.push(p) },
    trashItem: async (p) => { trashed.push(p); fs.renameSync(p, path.join(TMP, 'bin-' + trashed.length)) }
  },
  nativeTheme: { on: () => {} }
}
const origLoad = Module._load
Module._load = function (req, ...rest) {
  if (req === 'electron') return fakeElectron
  return origLoad.call(this, req, ...rest)
}
try {
  const core = require(path.join(ROOT, 'packages/core/index.js'))
  const report = require(path.join(ROOT, 'electron/services/report.js'))
  const createCoverage = require(path.join(ROOT, 'electron/services/coverage.js'))
  const createFreqPlan = require(path.join(ROOT, 'electron/services/freqPlan.js'))
  const { register } = require(path.join(ROOT, 'electron/ipc/register.js'))
  const GRD_DIR = path.join(TMP, 'grd-imported')
  fs.mkdirSync(GRD_DIR, { recursive: true })
  const coverageGrd = createCoverage(path.join(TMP, 'preset'), GRD_DIR)
  const freqPlan = createFreqPlan(path.join(TMP, 'fp'), { trash: (p) => fakeElectron.shell.trashItem(p) })
  let quitCalls = 0
  const relayed = []
  register({
    core: () => core, storage: {}, report,
    coverage: {}, coverageGrd, coverageGxt: null, share: null, grd: {},
    activation: { current: () => ({ active: true }), start: () => {} },
    perfWin: null, freqPlan, weather: {}, gfs: {}, updater: null,
    quitApp: () => { quitCalls++ }, sceneRelay: (c) => { relayed.push(c); return true }
  })
  const call = (ch, sender, ...a) => handlers.get(ch)({ sender: sender || { id: 99 } }, ...a)

  // app:quit
  await call('app:quit')
  ok(quitCalls === 1, '⑤ app:quit → main 的 requestQuit')

  // scene:cmd
  ok(await call('scene:cmd', null, 'seekClock', { tMs: Date.UTC(2026, 0, 1) }) === true && relayed[0].cmd === 'seekClock', '⑤ scene:cmd 合法 → 清洗后转给主窗口')
  ok(await call('scene:cmd', null, 'evil', {}) === false && relayed.length === 1, '⑤ scene:cmd 未知 → false、不转')

  // file:saveMany：覆盖确认
  const out = path.join(TMP, 'masks')
  fs.mkdirSync(path.join(out, 'Masks'), { recursive: true })
  fs.writeFileSync(path.join(out, 'Masks', 'm1.xml'), 'OLD')
  saveDirPick = out
  msgAnswer = 1; msgAsked = 0
  let r = await call('file:saveMany', null, { files: [{ filename: 'Masks/m1.xml', text: 'NEW1' }, { filename: 'Masks/m2.xml', text: 'NEW2' }] })
  ok(r.canceled === true && msgAsked === 1 && fs.readFileSync(path.join(out, 'Masks', 'm1.xml'), 'utf8') === 'OLD' && !fs.existsSync(path.join(out, 'Masks', 'm2.xml')), '⑤ saveMany：有同名 → 问；取消 → 一个都不写')
  msgAnswer = 0
  r = await call('file:saveMany', null, { files: [{ filename: 'Masks/m1.xml', text: 'NEW1' }, { filename: 'Masks/m2.xml', text: 'NEW2' }] })
  ok(r.ok && fs.readFileSync(path.join(out, 'Masks', 'm1.xml'), 'utf8') === 'NEW1' && r.written.length === 2 && r.paths.length === 2 && r.path === r.paths[0] && r.dir === out, '⑤ saveMany：替换 → 全写，回 written + paths + path')
  msgAsked = 0
  r = await call('file:saveMany', null, { files: [{ filename: 'fresh.xml', text: 'X' }] })
  ok(r.ok && msgAsked === 0, '⑤ saveMany：没有同名不弹框')
  r = await call('file:saveMany', null, { files: [{ filename: 'ok.xml', text: 'X' }, { filename: '../evil.xml', text: 'X' }] })
  ok(r.ok === false && !fs.existsSync(path.join(out, 'ok.xml')), '⑤ saveMany：非法路径在写任何文件之前就报')

  // files:reveal / open 白名单
  const written = path.join(out, 'Masks', 'm2.xml')
  ok(await call('files:reveal', null, written) === true && shown.at(-1) === path.resolve(written), '⑤ files:reveal：写过的文件 → 在文件夹中显示')
  ok(await call('files:open', null, written) === true && opened.at(-1) === path.resolve(written), '⑤ files:open：写过的文件 → 系统打开')
  ok(await call('files:open', null, out) === true, '⑤ files:open：批量写出的目录也登记了')
  const other = path.join(TMP, 'not-mine.txt')
  fs.writeFileSync(other, 'x')
  const nShown = shown.length
  ok(await call('files:reveal', null, other) === false && await call('files:open', null, other) === false && shown.length === nShown, '⑤ 没写过的文件 → false')
  ok(await call('files:reveal', null, 42) === false && await call('files:open', null, '') === false, '⑤ 非串 / 空 → false')
  fs.unlinkSync(written)
  ok(await call('files:open', null, written) === false, '⑤ 写过但已被删 → false')

  // file:save → path
  saveFilePick = path.join(TMP, 'map.png')
  r = await call('file:save', null, { defaultName: 'map.png', data: new Uint8Array([1, 2, 3]) })
  ok(r.ok && r.filePath === saveFilePick && r.path === saveFilePick && EP.isExported(saveFilePick), '⑤ file:save：回 filePath + path，登记白名单')

  // coverageGrd:remove → 回收站
  fs.writeFileSync(path.join(GRD_DIR, 'ant.grd'), 'GRD')
  fs.writeFileSync(path.join(GRD_DIR, 'ant.grd.grdbin'), 'BIN')
  r = await call('coverageGrd:remove', null, 'ant.grd')
  ok(r && r.ok === true && trashed.at(-1) === path.join(GRD_DIR, 'ant.grd') && !fs.existsSync(path.join(GRD_DIR, 'ant.grd')) && !fs.existsSync(path.join(GRD_DIR, 'ant.grd.grdbin')), '⑤ coverageGrd:remove：原件进回收站、.grdbin 直接删，回 { ok:true }')
  ok((await call('coverageGrd:remove', null, 'gone.grd')).ok === true, '⑤ 不在的文件：照旧 ok')
  ok((await call('coverageGrd:remove', null, '')).ok === false, '⑤ 空文件名：照旧 ok:false')

  // freqPlan:changed 广播（不发给发起者）
  const from = fakeWins[1].webContents
  winsSent.length = 0
  const sv = await call('freqPlan:save', from, { name: '计划甲', satFolder: 'sat1' })
  ok(sv.ok && winsSent.length === 2 && winsSent.every(([id, ch, m]) => id !== 12 && ch === 'freqPlan:changed' && m.kind === 'save' && m.ids[0] === sv.id), '⑤ freqPlan:save → 广播给其余窗口（不含发起者）')
  winsSent.length = 0
  await call('freqPlan:rename', from, sv.id, '计划乙')
  ok(winsSent.length === 2 && winsSent[0][2].kind === 'rename', '⑤ rename 广播')
  winsSent.length = 0
  const ra = await call('freqPlan:reassignSat', from, 'sat1', { folder: 'sat2' })
  ok(ra.ok && ra.count === 1 && winsSent.length === 2 && winsSent[0][2].kind === 'reassign' && winsSent[0][2].ids[0] === sv.id, '⑤ reassignSat 广播受影响的计划')
  winsSent.length = 0
  await call('freqPlan:reassignSat', from, 'nobody', { folder: 'x' })
  ok(winsSent.length === 0, '⑤ reassignSat 没改到任何计划 → 不广播')
  winsSent.length = 0
  const nTrash = trashed.length
  const rm = await call('freqPlan:remove', from, sv.id)
  ok(rm.ok && trashed.length === nTrash + 1 && /\.json$/.test(trashed.at(-1)) && freqPlan.get(sv.id) === null, '⑤ freqPlan:remove：计划文件进回收站、get 读不到（.bak 也清了）')
  ok(winsSent.length === 2 && winsSent[0][2].kind === 'remove' && winsSent[0][2].ids[0] === sv.id, '⑤ remove 广播')
  winsSent.length = 0
  saveDirPick = null
} finally {
  Module._load = origLoad
}

// ───────── ⑥ preload 的 onGuard ─────────
{
  const sends = []
  const listeners = new Map()
  let api = null
  const fake = {
    contextBridge: { exposeInMainWorld: (k, v) => { if (k === 'api') api = v } },
    ipcRenderer: {
      invoke: async (ch) => { sends.push(['invoke', ch]); return true },
      send: (ch, v) => sends.push([ch, v]),
      on: (ch, fn) => { if (!listeners.has(ch)) listeners.set(ch, []); listeners.get(ch).push(fn) },
      removeListener: (ch, fn) => { const l = listeners.get(ch) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1) }
    },
    webUtils: { getPathForFile: () => '' }
  }
  Module._load = function (req, ...rest) {
    if (req === 'electron') return fake
    return origLoad.call(this, req, ...rest)
  }
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'electron/preload.js'))]
    require(path.join(ROOT, 'electron/preload.js'))
  } finally { Module._load = origLoad }
  const fire = async (ch) => { for (const fn of [...(listeners.get(ch) || [])]) await fn({}) }
  ok(api && typeof api.files.reveal === 'function' && typeof api.files.open === 'function' && typeof api.scene.cmd === 'function' && typeof api.scene.onCmd === 'function' && typeof api.freqPlan.onChanged === 'function' && typeof api.app.quit === 'function', '⑥ preload 暴露 files / scene / freqPlan.onChanged / app.quit')

  // 回调确认了 → 不发 cancel
  let off = api.linkBudget.onCloseRequested(async () => { await api.linkBudget.confirmClose() })
  ok(typeof off === 'function' && sends.at(-1)[0] === 'guard:ready' && sends.at(-1)[1].on === true, '⑥ 注册即报 guard:ready，返回退订函数')
  sends.length = 0
  await fire('linkbudget:closeRequested')
  eq(sends.map((s) => s[0] === 'invoke' ? s[1] : s[0]), ['guard:ack', 'linkbudget:confirmClose'], '⑥ 收到关窗请求：先回执，回调确认后不发 cancel')
  off()
  ok(sends.at(-1)[0] === 'guard:ready' && sends.at(-1)[1].on === false && !(listeners.get('linkbudget:closeRequested') || []).length, '⑥ 退订：摘监听、报 { on:false }')

  // 回调没确认（用户取消）→ cancel
  sends.length = 0
  off = api.rainAttenuation.onCloseRequested(async () => { /* 用户点了取消 */ })
  await fire('rain:closeRequested')
  eq(sends.map((s) => s[0]), ['guard:ready', 'guard:ack', 'guard:cancel'], '⑥ 回调走完没确认 → guard:cancel')
  off()

  // 回调抛错 → cancel
  sends.length = 0
  off = api.ssa.onCloseRequested(async () => { throw new Error('boom') })
  const ce = console.error; console.error = () => {}
  await fire('ssa:closeRequested')
  console.error = ce
  ok(sends.some((s) => s[0] === 'guard:cancel'), '⑥ 回调抛错 → guard:cancel')
  off()

  // 重入（模型工作台）：第二轮立刻返回、第一轮稍后确认 → 不发 cancel
  sends.length = 0
  let release
  let first = true
  off = api.models.onCloseRequested(async () => {
    if (!first) return
    first = false
    await new Promise((r) => { release = r })
    await api.models.confirmClose()
  })
  const p1 = fire('modelwb:closeRequested')
  const p2 = fire('modelwb:closeRequested')
  await p2
  release()
  await p1
  ok(!sends.some((s) => s[0] === 'guard:cancel') && sends.some((s) => s[0] === 'invoke' && s[1] === 'modelwb:confirmClose'), '⑥ 重入：后到的空回调不抢先判取消')
  off()

  // scene.cmd 出门前现造纯数据；onCmd 解包
  sends.length = 0
  await api.scene.cmd('seekClock', { tMs: 1 })
  ok(sends.at(-1)[1] === 'scene:cmd', '⑥ scene.cmd → invoke scene:cmd')
  let got = null
  const offCmd = api.scene.onCmd((c, p) => { got = [c, p] })
  for (const fn of listeners.get('scene:cmd')) fn({}, { cmd: 'focusSat', payload: { norad: '1' } })
  eq(got, ['focusSat', { norad: '1' }], '⑥ scene.onCmd → cb(cmd, payload)')
  offCmd()
  ok(!(listeners.get('scene:cmd') || []).length, '⑥ scene.onCmd 退订')
  let fp = null
  const offFp = api.freqPlan.onChanged((m) => { fp = m })
  for (const fn of listeners.get('freqPlan:changed')) fn({}, { ids: ['a'], kind: 'save' })
  eq(fp, { ids: ['a'], kind: 'save' }, '⑥ freqPlan.onChanged → cb({ ids, kind })')
  offFp()
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`windowShell: ${pass} 项通过`)
