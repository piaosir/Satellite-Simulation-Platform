// 可编程波束地图 · 脚本执行核心（纯 ESM：Worker 里跑，Node 测试直接调）。
//
// 一次运行 = 静态检查（acorn）→ 编译成 async 函数 → 注入 data + 标准库 + 受控 console → 取返回值规整成输出文件。
//   · 语法错 / import() 在编译前由 acorn 报出，带行列（V8 的 Function 构造器报语法错不带位置）。
//   · 运行期异常按 sourceURL 从调用栈反推到【用户脚本】的行列（标准库内部帧跳过，落在用户的调用处）。
//   · 隔离不在这里做：Worker 入口（viz/beamScript/beamScript.worker.js）负责删网络 / 存储 / 动态代码生成，
//     每次运行用一个全新的 Worker、跑完即销毁，超时由主线程 terminate。这里只保证「脚本拿不到这些名字」的第一层。
import { parse } from 'acorn'
import { createStdlib, STDLIB_NAMES, isOutputFile } from './stdlib.js'
import { encodeText, applyEol } from './encode.js'

// 在 Worker 加固（抹掉函数构造器）之前捕获
const AsyncFunction = (async function () {}).constructor
const SOURCE_URL = 'beamscript.js'
// 外层函数的遮蔽形参（运行时传 undefined）：脚本里写这些名字拿不到真身。放在外层而不是与脚本同层，
// 用户自己 `const self = …` 才不会撞「重复声明」。
const SHADOW = ['self', 'globalThis', 'window', 'postMessage', 'importScripts', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'indexedDB', 'caches', 'navigator', 'location', 'onmessage', 'addEventListener', 'removeEventListener', 'close', 'require', 'process', 'module', 'exports']
const PARAMS = [...STDLIB_NAMES, 'data', 'console', 'lang', ...SHADOW]
const LOG_CAP = 2000
const TEXT_CAP = 4000

const T = (lang, zh, en) => (lang === 'en' ? en : zh)

/* ---------- 静态检查 ---------- */
function walk(node, fn) {
  if (!node || typeof node.type !== 'string') return
  if (fn(node) === false) return
  for (const k in node) {
    if (k === 'loc' || k === 'start' || k === 'end') continue
    const v = node[k]
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') walk(x, fn) }
    else if (v && typeof v.type === 'string') walk(v, fn)
  }
}
/** 静态检查：语法错 / 不允许的语法 → { message, line, col }；通过返回 null */
export function checkSource(code, lang = 'zh') {
  let ast
  try {
    ast = parse(String(code || ''), { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, locations: true })
  } catch (e) {
    const loc = e && e.loc
    const msg = String((e && e.message) || e).replace(/\s*\(\d+:\d+\)\s*$/, '')
    return { name: 'SyntaxError', message: T(lang, '语法错误：', 'Syntax error: ') + msg, line: loc ? loc.line : null, col: loc ? loc.column + 1 : null }
  }
  let bad = null
  walk(ast, (n) => {
    if (bad) return false
    if (n.type === 'ImportExpression' || (n.type === 'MetaProperty' && n.meta && n.meta.name === 'import')) {
      bad = { name: 'SecurityError', message: T(lang, '脚本中不允许使用 import() / import.meta', 'import() / import.meta is not allowed in scripts'), line: n.loc.start.line, col: n.loc.start.column + 1 }
      return false
    }
    return true
  })
  return bad
}

/* ---------- 行号映射 ---------- */
function wrapperBody(code) { return '"use strict";return (async()=>{\n' + code + '\n})()\n//# sourceURL=' + SOURCE_URL }
// 生成函数里用户第 1 行落在第几行：模块装载时拿同步探针实测一次（不同 V8 版本 Function 构造器的头部行数可能不同；
// async 与普通函数头部同构）。必须在 Worker 加固抹掉 Function 构造器之前跑 —— 故放在模块顶层。
const LINE_OFFSET = (() => {
  try {
    const body = '"use strict";return (()=>{\nthrow new Error("probe")\n})()\n//# sourceURL=' + SOURCE_URL
    new Function(...PARAMS, body)()   // eslint-disable-line no-new-func
  } catch (e) {
    const m = /beamscript\.js:(\d+):(\d+)/.exec(String((e && e.stack) || ''))
    if (m) return +m[1] - 1
  }
  return 3
})()
const lineOffset = () => LINE_OFFSET
function userLoc(stack, off) {
  const m = /beamscript\.js:(\d+):(\d+)/.exec(String(stack || ''))
  if (!m) return null
  const line = +m[1] - off
  return line >= 1 ? { line, col: +m[2] } : null
}

/* ---------- console ---------- */
function preview(v, depth, seen) {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  const t = typeof v
  if (t === 'string') return v.length > TEXT_CAP ? v.slice(0, TEXT_CAP) + '…' : v
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v)
  if (t === 'symbol') return v.toString()
  if (t === 'function') return `ƒ ${v.name || ''}()`
  if (v instanceof Error) return (v.name || 'Error') + ': ' + v.message
  if (isOutputFile(v)) return `file("${v.name}")`
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})`
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return `${v.constructor.name}(${v.byteLength})`
  if (seen.has(v)) return '[Circular]'
  if (depth <= 0) return Array.isArray(v) ? `Array(${v.length})` : '{…}'
  seen.add(v)
  let s
  if (Array.isArray(v)) {
    const head = v.slice(0, 50).map((x) => inner(x, depth - 1, seen))
    s = '[' + head.join(', ') + (v.length > 50 ? `, … ${v.length - 50} more` : '') + ']'
  } else if (v instanceof Map) {
    s = `Map(${v.size}) {` + [...v.entries()].slice(0, 30).map(([k, x]) => inner(k, depth - 1, seen) + ' => ' + inner(x, depth - 1, seen)).join(', ') + '}'
  } else if (v instanceof Set) {
    s = `Set(${v.size}) {` + [...v].slice(0, 30).map((x) => inner(x, depth - 1, seen)).join(', ') + '}'
  } else {
    const keys = Object.keys(v)
    s = '{' + keys.slice(0, 40).map((k) => k + ': ' + inner(v[k], depth - 1, seen)).join(', ') + (keys.length > 40 ? ', …' : '') + '}'
  }
  seen.delete(v)
  return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + '…' : s
}
const inner = (x, d, seen) => (typeof x === 'string' ? JSON.stringify(x.length > 200 ? x.slice(0, 200) + '…' : x) : preview(x, d, seen))
function makeConsole(logs, off, lang) {
  const push = (level, args) => {
    if (logs.length >= LOG_CAP) {
      if (!logs.capped) { logs.capped = true; logs.push({ level: 'warn', text: T(lang, `日志超过 ${LOG_CAP} 条，其余已省略`, `More than ${LOG_CAP} log entries; the rest were dropped`), line: null }) }
      return
    }
    const loc = userLoc(new Error().stack, off)
    logs.push({ level, text: args.map((a) => preview(a, 3, new Set())).join(' '), line: loc ? loc.line : null })
  }
  const table = (rows) => {
    if (!rows || typeof rows !== 'object') return push('log', [rows])
    const list = Array.isArray(rows) ? rows : Object.entries(rows).map(([k, v]) => ({ '(key)': k, ...(v && typeof v === 'object' ? v : { value: v }) }))
    const keys = [...new Set(list.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : ['value'])))]
    const cells = list.slice(0, 200).map((r) => keys.map((k) => preview(r && typeof r === 'object' ? r[k] : r, 1, new Set())))
    const w = keys.map((k, i) => Math.min(40, Math.max(String(k).length, ...cells.map((c) => String(c[i]).length))))
    const line = (arr) => arr.map((c, i) => String(c).slice(0, 40).padEnd(w[i])).join(' │ ')
    push('log', [[line(keys), w.map((n) => '─'.repeat(n)).join('─┼─'), ...cells.map(line)].join('\n')])
  }
  return {
    log: (...a) => push('log', a), info: (...a) => push('info', a), debug: (...a) => push('log', a),
    warn: (...a) => push('warn', a), error: (...a) => push('error', a), table,
    assert: (cond, ...a) => { if (!cond) push('error', [T(lang, '断言失败', 'Assertion failed') + (a.length ? ':' : ''), ...a]) }
  }
}

/* ---------- 输出规整 ---------- */
const BAD_CH = /[<>:"|?*\\\u0000-\u001f]/
function checkName(name, lang) {
  const segs = String(name).replace(/\\/g, '/').split('/')
  if (segs.length > 4) throw new Error(T(lang, `文件路径层级超过上限（4 级）：${name}`, `Path too deep (max 4 levels): ${name}`))
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || BAD_CH.test(s) || /[. ]$/.test(s)) throw new Error(T(lang, `文件名无效：${name}`, `Invalid file name: ${name}`))
  }
  return segs.join('/')
}
const baseOf = (s) => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/[. ]+$/, '').trim() || 'beam-map'
export function normalizeOutput(ret, std, scriptName, lang = 'zh') {
  const base = baseOf(scriptName)
  let list
  if (ret === undefined || ret === null) list = []
  else if (typeof ret === 'string') list = [std.file(base + '.txt', ret)]
  else if (isOutputFile(ret)) list = [ret]
  else if (ret instanceof Uint8Array || ret instanceof ArrayBuffer || ArrayBuffer.isView(ret)) list = [std.file(base + '.bin', ret)]
  else if (Array.isArray(ret)) {
    list = ret.flat(2)
    const bad = list.findIndex((f) => !isOutputFile(f))
    if (bad >= 0) throw new Error(T(lang, `返回数组的每个元素须为 file()（第 ${bad + 1} 项不符合）`, `When returning an array every element must be a file() (item ${bad + 1} is not)`))
  } else if (typeof ret === 'object') list = [std.file(base + '.json', ret)]
  else list = [std.file(base + '.txt', String(ret))]
  const seen = new Set()
  return list.map((f) => {
    const name = checkName(f.name, lang)
    const key = name.toLowerCase()
    if (seen.has(key)) throw new Error(T(lang, `输出文件名重复：${name}`, `Duplicate output file name: ${name}`))
    seen.add(key)
    return { ...f, name }
  })
}
// 一份输出文件 → 回传给主线程的记录。UTF-8 文本只回文本（落盘时交主进程按 UTF-8 写，不多一份字节）；
// 其余编码在这里就编好（顺带数出 GBK / Latin-1 表达不了的字符），二进制原样。
export function packFile(f) {
  if (f.content instanceof Uint8Array) return { name: f.name, kind: 'binary', bytes: f.content, size: f.content.byteLength }
  const text = applyEol(f.content, f.eol)
  if (f.encoding === 'utf-8') return { name: f.name, kind: 'text', text, encoding: 'utf-8', size: new TextEncoder().encode(text).byteLength, unmapped: 0 }
  const { bytes, unmapped } = encodeText(text, f.encoding)
  return { name: f.name, kind: 'text', text, encoding: f.encoding, bytes, size: bytes.byteLength, unmapped }
}

/**
 * 运行一段脚本。返回 { ok, files, logs, error, ms }：
 *   files  [{ name, kind:'text'|'binary', text?, bytes?, encoding?, size, unmapped? }]
 *   logs   [{ level:'log'|'info'|'warn'|'error', text, line }]
 *   error  { name, message, line, col } | null
 */
export async function runScript(code, data, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'zh'
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now()
  const elapsed = () => Math.round(((typeof performance !== 'undefined' ? performance : Date).now() - t0) * 10) / 10
  const logs = []
  const bad = checkSource(code, lang)
  if (bad) return { ok: false, files: [], logs, error: bad, ms: elapsed() }
  const off = lineOffset()
  let fn
  try { fn = new AsyncFunction(...PARAMS, wrapperBody(String(code))) }
  catch (e) { return { ok: false, files: [], logs, error: { name: 'SyntaxError', message: String((e && e.message) || e), line: null, col: null }, ms: elapsed() } }
  const std = createStdlib(lang)
  const con = makeConsole(logs, off, lang)
  try {
    const ret = await fn(...STDLIB_NAMES.map((k) => std[k]), data, con, lang, ...SHADOW.map(() => undefined))
    const files = normalizeOutput(ret, std, opts.scriptName, lang).map(packFile)
    for (const f of files) {
      if (f.unmapped > 0) logs.push({ level: 'warn', line: null, text: T(lang, `「${f.name}」有 ${f.unmapped} 个字符超出 ${f.encoding.toUpperCase()} 编码范围，已替换为 ?`, `"${f.name}": ${f.unmapped} character(s) cannot be encoded in ${f.encoding.toUpperCase()} and were replaced with ?`) })
    }
    return { ok: true, files, logs, error: null, ms: elapsed() }
  } catch (e) {
    const isErr = e && typeof e === 'object' && 'message' in e
    const loc = isErr ? userLoc(e.stack, off) : null
    return {
      ok: false, files: [], logs, ms: elapsed(),
      error: { name: (isErr && e.name) || 'Error', message: isErr ? String(e.message) : String(e), line: loc ? loc.line : null, col: loc ? loc.col : null }
    }
  }
}

export { PARAMS as SCRIPT_PARAMS }
// 可编程导入（importRuntime.js）复用同一套：遮蔽名单、受控 console、调用栈 → 用户行列、外层包装
export { SHADOW as SHADOW_NAMES, makeConsole, userLoc, wrapperBody }
