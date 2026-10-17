// 可编程波束地图 · 导入脚本执行核心（纯 ESM：Worker 沙箱里跑，Node 测试直接调）。
//
// 与导出脚本（runtime.js）同一套：acorn 静态检查 → 编译成 async 函数 → 注入 files + 导入标准库 + 受控 console；
// 返回值交 importModel.normalizeImport 归一成覆盖库能收的波束。隔离同样不在这里做（见 beamScript.worker.js）。
import { checkSource, SHADOW_NAMES, makeConsole, userLoc, wrapperBody } from './runtime.js'
import { createImportStdlib, IMPORT_STDLIB_NAMES, makeInputFile, sniffDecode } from './importStdlib.js'
import { normalizeImport } from './importModel.js'

// 在 Worker 加固（抹掉函数构造器）之前捕获
const AsyncFunction = (async function () {}).constructor
const PARAMS = [...IMPORT_STDLIB_NAMES, 'files', 'console', 'lang', ...SHADOW_NAMES]
const T = (lang, zh, en) => (lang === 'en' ? en : zh)
// 用户第 1 行在生成函数里的行号：与 runtime.js 同法实测（模块顶层跑，赶在 Worker 加固之前）
const LINE_OFFSET = (() => {
  try {
    const body = '"use strict";return (()=>{\nthrow new Error("probe")\n})()\n//# sourceURL=beamscript.js'
    new Function(...PARAMS, body)()   // eslint-disable-line no-new-func
  } catch (e) {
    const m = /beamscript\.js:(\d+):(\d+)/.exec(String((e && e.stack) || ''))
    if (m) return +m[1] - 1
  }
  return 3
})()

/**
 * 跑一段导入脚本。rawFiles = [{ name, bytes:Uint8Array }]。返回
 *   { ok, beams, stats, warnings, logs, error, ms }   beams 见 importModel.normalizeImport
 */
export async function runImport(code, rawFiles, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'zh'
  const now = () => (typeof performance !== 'undefined' ? performance : Date).now()
  const t0 = now()
  const elapsed = () => Math.round((now() - t0) * 10) / 10
  const logs = []
  const bad = checkSource(code, lang)
  if (bad) return { ok: false, beams: [], stats: null, warnings: [], logs, error: bad, ms: elapsed() }
  let fn
  try { fn = new AsyncFunction(...PARAMS, wrapperBody(String(code))) }
  catch (e) { return { ok: false, beams: [], stats: null, warnings: [], logs, error: { name: 'SyntaxError', message: String((e && e.message) || e), line: null, col: null }, ms: elapsed() } }
  const std = createImportStdlib(lang)
  const files = Object.freeze((rawFiles || []).map((f) => makeInputFile(f && f.name, f && f.bytes)))
  const con = makeConsole(logs, LINE_OFFSET, lang)
  try {
    const ret = await fn(...IMPORT_STDLIB_NAMES.map((k) => std[k]), files, con, lang, ...SHADOW_NAMES.map(() => undefined))
    const norm = normalizeImport(ret, { lang })
    for (const w of norm.warnings) logs.push({ level: 'warn', text: w, line: null })
    if (!norm.beams.length && files.length) logs.push({ level: 'warn', text: T(lang, '脚本没有返回任何波束', 'The script returned no beams'), line: null })
    return { ok: true, beams: norm.beams, stats: norm.stats, warnings: norm.warnings, logs, error: null, ms: elapsed() }
  } catch (e) {
    const isErr = e && typeof e === 'object' && 'message' in e
    const loc = isErr ? userLoc(e.stack, LINE_OFFSET) : null
    return {
      ok: false, beams: [], stats: null, warnings: [], logs, ms: elapsed(),
      error: { name: (isErr && e.name) || 'Error', message: isErr ? String(e.message) : String(e), line: loc ? loc.line : null, col: loc ? loc.col : null }
    }
  }
}

/* ---------------- 自动认格式（文件管理批量导入：内置解析器认不出的文件交给声明了匹配规则的脚本） ---------------- */
// 脚本头部的匹配声明（保留在代码里，复制成用户脚本后照样生效）：
//   //! match: *.json, *.txt        文件名通配（不分大小写；* ? 两种通配符）
//   //! sniff: CONSTELLATION_OPT    文件开头 64 KB 文本里要能找到的正则（可选）
export function scriptMatchInfo(code) {
  const out = { match: [], sniff: null }
  for (const ln of String(code || '').split(/\r?\n/, 40)) {
    let m = /^\s*\/\/!\s*match\s*:\s*(.+)$/i.exec(ln)
    if (m) { out.match.push(...m[1].split(/[,，;\s]+/).map((s) => s.trim()).filter(Boolean)); continue }
    m = /^\s*\/\/!\s*sniff\s*:\s*(.+)$/i.exec(ln)
    if (m) { try { out.sniff = new RegExp(m[1].trim(), 'i') } catch { out.sniff = null } }
  }
  return out
}
const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
/** 某脚本是否认这个文件：file = { name, head（开头一段文本）} */
export function scriptAccepts(info, file) {
  if (!info || !info.match.length) return false
  const leaf = String(file.name || '').split(/[\\/]/).pop()
  if (!info.match.some((g) => globRe(g).test(leaf))) return false
  return info.sniff ? info.sniff.test(String(file.head || '')) : true
}

// ★ 认领 ≠ 认出。匹配声明只说「这个文件可能归我」：起手式写了 //! match: *.json 的空脚本会把 CONSTELLATION_OPT、
//   GeoJSON 统统认领走，跑出 0 个波束却算定案。故认领只排顺序，真正定案要跑一遍：跑通且返回 ≥1 个波束才算认出。
// cands = [{ key, name, code, info }]（info = scriptMatchInfo 结果），按优先级排好（用户脚本在前、内置模板在后）。
/** 认领这个文件的候选下标（按 cands 顺序）。file = { name, head } */
export function acceptingOrder(cands, file) {
  const out = []
  ;(cands || []).forEach((c, k) => { if (c && scriptAccepts(c.info, file)) out.push(k) })
  return out
}
/** 一轮运行算不算认出：跑通且返回了至少一个波束 */
export const recognized = (r) => !!(r && r.ok && Array.isArray(r.beams) && r.beams.length > 0)

const HEAD = 65536
const baseKey = (name) => String(name || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase()
/**
 * 文件管理「导入…」的自动认格式（纯逻辑；运行器由调用方注入 —— 渲染端是沙箱 Worker，单测直接用 runImport）。
 *   files = [{ name, bytes:Uint8Array }]；exec(code, files) → Promise<与 runImport 同形的结果>。
 * 一个文件依次交给认领它的候选，认出即定案；脚本报错 / 超时 / 返回 0 个波束都当没认出，换下一个候选。
 * 全都没认出的进 unmatched（调用方打开「可编程导入」并带上它，tried 里是试过的候选，那边据此跳过）。
 * 配套文件（.shp 旁的 .dbf / .cpg / .prj、.mif 旁的 .mid）没人认领时跟着同名主文件走，换候选也一起换。
 * 同一个候选认领的文件一轮跑完（多文件格式靠这个）；整组报错时拆开逐个再试同一个候选 —— 一个坏文件不连累同组的。
 * （整组跑通却 0 个波束不拆：逐个跑也只会是 0 个；超时不拆：拆开是成倍地等。）
 * 返回 { runs:[{ cand, files, result }]（认出的各轮）, unmatched:[文件名], tried:{ 文件名:[候选 key] }, fails:{ 文件名:[{ cand, reason }] } }
 */
export async function autoImport(files, cands, exec, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'zh'
  const units = [], loose = []
  for (const f of (files || [])) {
    const order = acceptingOrder(cands, { name: f.name, head: sniffDecode(f.bytes.subarray(0, HEAD)).text })
    if (order.length) units.push({ files: [f], order, at: 0 }); else loose.push(f)
  }
  const unmatched = []
  for (const f of loose) {
    const u = units.find((x) => baseKey(x.files[0].name) === baseKey(f.name))
    if (u) u.files.push(f); else unmatched.push(f.name)
  }
  const run = async (code, list) => {
    try { return await exec(code, list) }
    catch (e) { return { ok: false, beams: [], logs: [], error: { name: 'Error', message: String((e && e.message) || e) } } }
  }
  const runs = [], tried = {}, fails = {}
  const filesOf = (us) => us.flatMap((u) => u.files)
  let todo = units
  while (todo.length) {
    const groups = new Map()   // 候选下标 → 这一轮轮到它的文件组
    for (const u of todo) { const k = u.order[u.at]; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(u) }
    const next = []
    const reject = (u, c, r) => {
      const reason = (r && r.error && r.error.message) ? String(r.error.message) : T(lang, '没有返回任何波束', 'returned no beams')
      for (const f of u.files) {
        ;(tried[f.name] || (tried[f.name] = [])).push(c.key)
        ;(fails[f.name] || (fails[f.name] = [])).push({ cand: c.name, reason })
      }
      if (++u.at < u.order.length) next.push(u)
      else for (const f of u.files) unmatched.push(f.name)
    }
    for (const [k, us] of groups) {
      const c = cands[k]
      const r = await run(c.code, filesOf(us))
      if (recognized(r)) { runs.push({ cand: c, files: filesOf(us), result: r }); continue }
      const split = us.length > 1 && r && !r.ok && !(r.error && r.error.name === 'TimeoutError')
      if (!split) { for (const u of us) reject(u, c, r); continue }
      for (const u of us) {
        const r1 = await run(c.code, u.files)
        if (recognized(r1)) runs.push({ cand: c, files: u.files, result: r1 }); else reject(u, c, r1)
      }
    }
    todo = next
  }
  return { runs, unmatched, tried, fails }
}
