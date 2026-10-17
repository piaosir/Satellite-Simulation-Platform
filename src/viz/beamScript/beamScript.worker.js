// 可编程波束地图 · 脚本沙箱 Worker。由 runner.js 以 new Worker(new URL('./beamScript.worker.js', import.meta.url), { type: 'module' }) 启动，
// 【每次运行一个全新实例】，跑完即被主线程 terminate —— 运行之间不留任何状态，超时直接掐掉线程。
//
// 隔离靠三层（借鉴 Figma 插件沙箱的教训：边界必须是独立的 JS 实例 + 消息传递，不能是同一个 realm 里的障眼法）：
//   ① Worker 本身：独立 V8 isolate，没有 DOM / Node / preload 暴露的 window.api，与主线程只有结构化克隆的消息。
//   ② 删入口：网络（fetch / XHR / WebSocket / EventSource / WebTransport / importScripts）、存储（IndexedDB /
//      Cache / OPFS）、派生（Worker）、字体加载（FontFace 走网络）一律从全局抹掉。
//   ③ 禁动态代码生成：Function / AsyncFunction / GeneratorFunction 构造器与 eval 换成拒绝调用的替身、
//      字符串形式的 setTimeout / setInterval 拒收 —— 于是脚本里看不到的 import() 也造不出来
//      （字面量 import() 已由 runtime 的 acorn 静态检查拦下）。
// 被保护的资产只有这份波束地图快照本身（主线程只把它交进来），故这一套足够；不另引 QuickJS 一类解释器，
// 换来的是 V8 JIT 全速（几十万点的等值线抽稀 / 改写在毫秒级）。
import { runScript } from '../../shared/beamScript/runtime.js'
import { runImport } from '../../shared/beamScript/importRuntime.js'   // 可编程导入：同一个沙箱，mode='import' 时 DATA 是输入文件表

const post = self.postMessage.bind(self)

;(function harden() {
  const g = self
  // 自身与整条原型链上都删一遍，再在全局上钉一个 undefined（WebIDL 的 [Global] 接口成员挂在实例上，
  // 但各引擎版本不尽相同，原型上那份也要清，免得拿到全局对象的脚本顺着原型链摸回去）
  const kill = (obj, key) => {
    for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      if (Object.prototype.hasOwnProperty.call(o, key)) { try { delete o[key] } catch { /* 不可配置 */ } }
    }
    try { if (key in obj) Object.defineProperty(obj, key, { value: undefined, writable: false, configurable: false }) } catch { /* 删不掉也钉不住的只剩不可配置项 */ }
  }
  for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'importScripts',
    'Worker', 'SharedWorker', 'BroadcastChannel', 'indexedDB', 'caches', 'FontFace', 'fonts', 'requestFileSystem',
    'webkitRequestFileSystem', 'webkitRequestFileSystemSync', 'webkitResolveLocalFileSystemSyncURL', 'Notification']) kill(g, k)
  const nav = Object.getPrototypeOf(g.navigator || {})
  for (const k of ['storage', 'serviceWorker', 'usb', 'hid', 'serial', 'locks']) {
    try { Object.defineProperty(nav, k, { get: () => undefined, configurable: false }) } catch { /* 无此项 */ }
  }
  const deny = () => { throw new EvalError('Dynamic code generation is disabled in the beam-map sandbox') }
  // 构造器换成「可 instanceof、不可调用」的代理：x instanceof Function 照常成立，Function('…') / new Function 一律拒绝
  for (const sample of [function () {}, async function () {}, function* () {}, async function* () {}]) {
    const proto = Object.getPrototypeOf(sample)
    const Ctor = proto.constructor
    const guard = new Proxy(Ctor, { apply: deny, construct: deny })
    try { Object.defineProperty(proto, 'constructor', { value: guard, writable: false, configurable: false }) } catch { /* 已冻结 */ }
    if (Ctor === Function) { try { Object.defineProperty(g, 'Function', { value: guard, writable: false, configurable: false }) } catch { /* ignore */ } }
  }
  try { Object.defineProperty(g, 'eval', { value: deny, writable: false, configurable: false }) } catch { /* ignore */ }
  const st = g.setTimeout.bind(g), si = g.setInterval.bind(g)
  const fnOnly = (f) => { if (typeof f !== 'function') throw new TypeError('setTimeout / setInterval accept functions only') }
  g.setTimeout = (f, ms, ...a) => { fnOnly(f); return st(f, ms, ...a) }
  g.setInterval = (f, ms, ...a) => { fnOnly(f); return si(f, ms, ...a) }
  // 回传通道只留给本文件：脚本伪造的消息没有令牌，主线程也不认
  try { Object.defineProperty(g, 'postMessage', { value: () => {}, writable: false, configurable: false }) } catch { /* ignore */ }
})()

let DATA = null
self.onmessage = async (e) => {
  const m = e.data || {}
  if (m.type === 'data') { DATA = m.data; return }
  if (m.type !== 'run') return
  self.onmessage = null   // 一个实例只跑一次
  let r
  try { r = m.mode === 'import' ? await runImport(m.code, DATA, { lang: m.lang }) : await runScript(m.code, DATA, { lang: m.lang, scriptName: m.scriptName }) }
  catch (err) { r = { ok: false, files: [], beams: [], logs: [], error: { name: 'Error', message: String((err && err.message) || err), line: null, col: null }, ms: 0 } }
  // 字节件转移所有权（零拷贝）；同一块 buffer 只能列一次
  const bufs = new Set()
  for (const f of r.files || []) if (f.bytes && f.bytes.buffer) bufs.add(f.bytes.buffer)
  try { post({ type: 'result', token: m.token, result: r }, [...bufs]) }
  catch (err) { post({ type: 'result', token: m.token, result: { ok: false, files: [], logs: r.logs || [], error: { name: 'DataCloneError', message: String((err && err.message) || err), line: null, col: null }, ms: r.ms } }) }
}
