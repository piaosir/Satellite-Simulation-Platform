'use strict'
// 计算窗的窗口外壳（主进程）：关窗守卫的兜底、崩溃 / 无响应的原生框、窗口几何记忆。2026-10-14（交互调研 C1 / C2 / A6）。
//
// ── 关窗守卫 ──
// 带守卫的窗口（链路预算四窗、日凌、雨衰、空间态势、模型工作台）点 X 时主进程先拦下（preventDefault），
// 发 *:closeRequested 让渲染端冲刷写盘 / 问用户，渲染端确认后调 *:confirmClose 才真关。原先只有这一条路：
//   · 渲染端白屏 / 崩溃 / 监听还没挂上 → 关窗请求石沉大海，X 点了没反应，只能去任务管理器结束进程；
//   · 「退出」要逐窗关，被任何一扇这样的窗口卡住就退不出去。
// 现在 preload 在渲染端挂监听时报 guard:ready、收到关窗请求先回 guard:ack、应用回调走完却没确认（用户点了取消）
// 回 guard:cancel（见 preload.js 的 onGuard）。主进程据此：
//   · 还没 guard:ready（没加载完 / 加载失败 / 没挂监听）、渲染进程已崩溃、主框架还在加载 → 直接放行关闭；
//   · 发出关窗请求后 ACK_MS 内没有回执 → 视为渲染端卡死，弹「窗口无响应」[等待][强制关闭]；
//   · guard:cancel → 通知「退出」流程中止（onCancel 订阅）。
// 渲染端整页导航（重新载入）时 ready 复位，等新页面重新报。
//
// ── 崩溃 / 无响应 ──
// 所有窗口：render-process-gone → 「窗口已崩溃」[重新载入][关闭]；unresponsive → 「窗口无响应」[等待][强制关闭]，
// 恢复响应（responsive）或回执到达时框自动收起。同一扇窗同一时刻最多一个框，崩溃框顶替无响应框。
// 文案只写状态；语言取渲染端报来的界面语言（ui-lang），取不到用中文。
//
// ── 几何记忆 ──
// 尺寸 / 位置 / 是否最大化按窗口键记进一个 JSON；恢复时钳进某块显示器的工作区（外接屏拔掉后不开到屏外）。
// clampBounds 是纯函数（packages/core/test/windowShell.test.mjs）。

const ACK_MS = 3000

const fin = (v) => typeof v === 'number' && Number.isFinite(v)
const validArea = (a) => a && fin(a.x) && fin(a.y) && fin(a.width) && fin(a.height) && a.width > 0 && a.height > 0
const overlap = (a, b) => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}
const clamp = (v, lo, hi) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi))

// saved：上次记下的 { x, y, width, height, maximized }（可缺 / 坏）。def：{ width, height, minWidth?, minHeight? }。
// areas：各显示器工作区（第一个当主屏）。→ { opt: { width, height, x?, y? }, maximized }
//   · 没记过 / 记坏了 → 缺省尺寸、不给位置（系统居中）；
//   · 尺寸不小于最小尺寸、不大于所在屏的工作区；
//   · 位置：与哪块屏重叠最多就钳进哪块屏（整窗可见）；与任何屏都不重叠 → 不给位置（系统居中），尺寸按主屏钳。
function clampBounds(saved, def, areas) {
  const d = def || {}
  const minW = fin(d.minWidth) ? d.minWidth : 0, minH = fin(d.minHeight) ? d.minHeight : 0
  const dw = fin(d.width) ? d.width : 800, dh = fin(d.height) ? d.height : 600
  const s = saved && typeof saved === 'object' ? saved : null
  if (!s || !fin(s.width) || !fin(s.height) || s.width <= 0 || s.height <= 0) return { opt: { width: dw, height: dh }, maximized: false }
  let w = Math.max(minW, Math.round(s.width)), h = Math.max(minH, Math.round(s.height))
  const A = (Array.isArray(areas) ? areas : []).filter(validArea)
  const hasPos = fin(s.x) && fin(s.y)
  const out = {}
  if (!A.length) {
    out.width = w; out.height = h
    if (hasPos) { out.x = Math.round(s.x); out.y = Math.round(s.y) }
    return { opt: out, maximized: !!s.maximized }
  }
  let best = null, bestOv = 0
  if (hasPos) {
    const r = { x: s.x, y: s.y, width: w, height: h }
    for (const a of A) { const ov = overlap(r, a); if (ov > bestOv) { bestOv = ov; best = a } }
  }
  const cap = best || A[0]
  w = Math.min(w, Math.round(cap.width)); h = Math.min(h, Math.round(cap.height))
  out.width = w; out.height = h
  if (best) {
    out.x = Math.round(clamp(Math.round(s.x), best.x, best.x + best.width - w))
    out.y = Math.round(clamp(Math.round(s.y), best.y, best.y + best.height - h))
  }
  return { opt: out, maximized: !!s.maximized }
}

// 几何记忆的存取：一个 JSON 文件、按键分条（jsonStore 由调用方给：原子写 + .bak 兜底）
function createBoundsStore(file, jsonStore) {
  const all = () => {
    try { const v = jsonStore.readJsonSafe(file, {}).value; return v && typeof v === 'object' ? v : {} } catch { return {} }
  }
  return {
    get: (key) => { const v = all()[key]; return v && typeof v === 'object' ? v : null },
    set: (key, v) => { const a = all(); a[key] = v; try { jsonStore.writeJsonAtomic(file, a, 0) } catch { /* 尽力而为 */ } }
  }
}
// 窗口动过就记（防抖 400 ms），关窗时再记一次。最小化时不记（那时的 normalBounds 不可靠）
function rememberBounds(win, store, key) {
  let t = null
  const save = () => {
    t = null
    if (win.isDestroyed() || win.isMinimized()) return
    const b = win.getNormalBounds()
    store.set(key, { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() })
  }
  const later = () => { clearTimeout(t); t = setTimeout(save, 400) }
  win.on('resize', later); win.on('move', later)
  win.on('maximize', later); win.on('unmaximize', later)
  win.on('close', () => { clearTimeout(t); save() })
  win.on('closed', () => { clearTimeout(t); t = null })
}

const TEXT = {
  crashed: { type: 'error', zh: { message: '窗口已崩溃', buttons: ['重新载入', '关闭'] }, en: { message: 'The window has crashed', buttons: ['Reload', 'Close'] } },
  hung: { type: 'warning', zh: { message: '窗口无响应', buttons: ['等待', '强制关闭'] }, en: { message: 'The window is not responding', buttons: ['Wait', 'Force Close'] } }
}

// o = { dialog, ipcMain, isQuitting(), lang() → 'zh'|'en'|Promise, onLang(lang), onSessionEnd(), ackMs? }
function createWindowKit(o) {
  const dialog = o.dialog
  const isQuitting = typeof o.isQuitting === 'function' ? o.isQuitting : () => false
  const ackMs = fin(o.ackMs) ? o.ackMs : ACK_MS
  const guards = new Map()        // webContents.id → g
  const boxes = new Map()         // BrowserWindow → { ac, kind }
  const cancelHooks = new Map()   // BrowserWindow → Set<fn>

  const noteLang = (v) => { if (v && (v.lang === 'en' || v.lang === 'zh') && typeof o.onLang === 'function') o.onLang(v.lang) }
  const gOf = (sender) => (sender && guards.get(sender.id)) || null
  o.ipcMain.on('guard:ready', (e, v) => {
    noteLang(v)
    const g = gOf(e.sender)
    if (g) g.ready = !(v && v.on === false)
  })
  o.ipcMain.on('guard:ack', (e, v) => {
    noteLang(v)
    const g = gOf(e.sender)
    if (!g) return
    g.asking = false
    clearTimeout(g.ackT); g.ackT = null
    closeBox(g.win, 'hung')
  })
  o.ipcMain.on('guard:cancel', (e) => {
    const g = gOf(e.sender)
    if (!g) return
    g.asking = false
    fireCancel(g.win)
  })

  async function langNow() {
    try {
      const l = await Promise.race([Promise.resolve(typeof o.lang === 'function' ? o.lang() : 'zh'), new Promise((r) => setTimeout(() => r('zh'), 400))])
      return l === 'en' ? 'en' : 'zh'
    } catch { return 'zh' }
  }
  const titleOf = (win) => { try { return win.getTitle() || '' } catch { return '' } }

  // 弹兜底框 → 按钮序号；-1 = 没弹（同类框已开着 / 窗口没了）或被收起（回执到了 / 恢复响应 / 被崩溃框顶替）
  async function ask(win, kind) {
    if (!win || win.isDestroyed() || !dialog) return -1
    const cur = boxes.get(win)
    if (cur) {
      if (cur.kind === kind || kind !== 'crashed') return -1
      cur.ac.abort()
    }
    const box = { ac: new AbortController(), kind }
    boxes.set(win, box)
    try {
      const t = TEXT[kind][(await langNow()) === 'en' ? 'en' : 'zh']
      if (box.ac.signal.aborted || win.isDestroyed()) return -1
      const opt = { type: TEXT[kind].type, title: titleOf(win), message: t.message, buttons: t.buttons, defaultId: 0, cancelId: 0, noLink: true, signal: box.ac.signal }
      const r = await dialog.showMessageBox(win, opt)
      return box.ac.signal.aborted ? -1 : (r && Number.isInteger(r.response) ? r.response : -1)
    } catch { return -1 } finally {
      if (boxes.get(win) === box) boxes.delete(win)
    }
  }
  function closeBox(win, kind) {
    const b = boxes.get(win)
    if (b && (!kind || b.kind === kind)) b.ac.abort()
  }

  function onCancel(win, fn) {
    let s = cancelHooks.get(win)
    if (!s) cancelHooks.set(win, (s = new Set()))
    s.add(fn)
    return () => s.delete(fn)
  }
  function fireCancel(win) {
    const s = cancelHooks.get(win)
    if (s) for (const fn of [...s]) { try { fn() } catch { /* 订阅方自己的错 */ } }
  }

  // 强制关闭：放行守卫后直接 destroy（不走 beforeunload —— 渲染端卡死时 close() 会一直等它）
  function forceClose(win) {
    if (!win || win.isDestroyed()) return
    for (const g of guards.values()) if (g.win === win) { try { g.release() } catch { /* 无 */ } }
    win.destroy()
  }
  // 放行后正常关（模型工作台的到点放行：渲染端多半还活着，让它的 beforeunload 再落一次草稿）
  function releaseAndClose(g) {
    try { g.release() } catch { /* 无 */ }
    if (!g.win.isDestroyed()) g.win.close()
  }

  async function onNoAck(g) {
    g.ackT = null
    if (g.win.isDestroyed() || !g.asking) return
    const r = await ask(g.win, 'hung')
    if (g.win.isDestroyed()) return
    if (r === 1) forceClose(g.win)
    else if (r === 0) g.asking = false        // 等待：再点 X 会重新转问
  }

  function onClose(g, e) {
    if (g.allowed() || isQuitting()) return
    const wc = g.win.webContents
    let dead = g.gone, loading = false
    try { dead = dead || wc.isDestroyed() || wc.isCrashed() } catch { dead = true }
    try { loading = !dead && wc.isLoadingMainFrame() } catch { loading = false }
    if (!g.ready || dead || loading) return     // 渲染端接不住关窗请求：直接放行
    e.preventDefault()
    if (g.autoReleaseMs && !g.autoT) g.autoT = setTimeout(() => { g.autoT = null; releaseAndClose(g) }, g.autoReleaseMs)
    if (g.asking) return                        // 已转给渲染端、还没回执：重复点 X 不重发
    g.asking = true
    try { wc.send(g.channel) } catch { g.asking = false; releaseAndClose(g); return }
    if (!g.autoReleaseMs) { clearTimeout(g.ackT); g.ackT = setTimeout(() => onNoAck(g), ackMs) }
  }

  // 给一扇窗挂关窗守卫。opt = { channel, allowed() → bool, release(), autoReleaseMs? }
  //   allowed / release 读写各窗自己的 _*AllowClose（main.js 的 before-quit 放行表按它们对账）；
  //   autoReleaseMs：发出关窗请求后到点自动放行（模型工作台：渲染端只落草稿、不问用户），此时不弹「无响应」框
  function guard(win, opt) {
    const wc = win.webContents
    const id = wc.id
    const g = {
      win, channel: String(opt.channel), allowed: typeof opt.allowed === 'function' ? opt.allowed : () => false,
      release: typeof opt.release === 'function' ? opt.release : () => {}, autoReleaseMs: fin(opt.autoReleaseMs) ? opt.autoReleaseMs : 0,
      ready: false, gone: false, asking: false, ackT: null, autoT: null
    }
    guards.set(id, g)
    wc.on('did-start-navigation', (d, _url, isInPlace, isMainFrame) => {
      const main = d && typeof d.isMainFrame === 'boolean' ? d.isMainFrame : !!isMainFrame
      const same = d && typeof d.isSameDocument === 'boolean' ? d.isSameDocument : !!isInPlace
      if (main && !same) { g.ready = false; g.asking = false; clearTimeout(g.ackT); g.ackT = null }
    })
    win.on('close', (e) => onClose(g, e))
    win.on('closed', () => { clearTimeout(g.ackT); clearTimeout(g.autoT); guards.delete(id) })
    return g
  }

  // 崩溃 / 无响应兜底（所有窗口）。opt = { onCrashClose?(), onHungClose?() }：缺省 = 强制关掉这扇窗
  function watch(win, opt) {
    const p = opt || {}
    const wc = win.webContents
    const id = wc.id
    wc.on('render-process-gone', async (_e, d) => {
      const reason = d && d.reason
      if (reason === 'clean-exit' || isQuitting() || win.isDestroyed()) return
      const g = guards.get(id)
      if (g) { g.gone = true; g.asking = false; clearTimeout(g.ackT); g.ackT = null }
      const r = await ask(win, 'crashed')
      if (win.isDestroyed() || r < 0) return
      if (r === 0) {
        if (g) g.gone = false
        try { wc.reload() } catch { /* 重载不了：留着框外的白屏，用户再点 X 会直接放行 */ }
      } else if (typeof p.onCrashClose === 'function') p.onCrashClose()
      else forceClose(win)
    })
    win.on('unresponsive', async () => {
      if (isQuitting() || win.isDestroyed()) return
      const r = await ask(win, 'hung')
      if (win.isDestroyed()) return
      if (r === 0) { const g = guards.get(id); if (g) g.asking = false }   // 等待：挂着的关窗请求作废，再点 X 重新转问
      if (r !== 1) return
      if (typeof p.onHungClose === 'function') p.onHungClose()
      else forceClose(win)
    })
    win.on('responsive', () => closeBox(win, 'hung'))
    // Windows 注销 / 关机：before-quit 不发（Electron 文档），守卫得另外放行，否则系统等超时强杀
    win.on('session-end', () => { if (typeof o.onSessionEnd === 'function') o.onSessionEnd() })
    win.on('closed', () => { closeBox(win); cancelHooks.delete(win) })
  }

  const guardOf = (win) => { for (const g of guards.values()) if (g.win === win) return g; return null }
  return {
    guard, watch, onCancel, forceClose,
    isReady: (win) => { const g = guardOf(win); return !!(g && g.ready && !g.gone) },
    isAsking: (win) => { const g = guardOf(win); return !!(g && g.asking) }
  }
}

module.exports = { clampBounds, createBoundsStore, rememberBounds, createWindowKit, ACK_MS, DIALOG_TEXT: TEXT }
