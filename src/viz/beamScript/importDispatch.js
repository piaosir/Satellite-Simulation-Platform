// 文件管理「导入…」的自动认格式：内置解析器（GXT / KML / KMZ / GXT 结构 JSON）认不出的文件，交给声明了匹配规则的
// 导入脚本 —— 用户脚本优先（自己写的私有格式解析器），其次内置模板（GeoJSON / CSV / Shapefile / MapInfo / 基带网管 …）。
// 匹配声明见 importRuntime.scriptMatchInfo（脚本头部的 //! match: 与 //! sniff:）。
// ★ 认领只排顺序、不定案：依次试跑，跑通且返回 ≥1 个波束才算认出，报错 / 0 个波束就换下一个候选（importRuntime.autoImport）。
// 每轮在沙箱 Worker 里跑（与「可编程导入」对话框同一个运行器），返回覆盖库批量导入条目。
import { scriptMatchInfo, autoImport } from '../../shared/beamScript/importRuntime.js'
import { NATIVE_TEMPLATE_IDS } from '../../shared/beamScript/importTemplates.js'
import { toLibraryItems } from '../../shared/beamScript/importModel.js'
import { builtinImportTemplates, loadScripts, IMPORT_NS } from './library.js'
import { createBeamScriptRunner } from './runner.js'

/** 候选脚本：[{ key, kind:'user'|'builtin', id, name, code, info }]（用户脚本在前；key 与「可编程导入」对话框的选中键同格式） */
export async function importCandidates(lang) {
  let users = []
  try { users = await loadScripts(IMPORT_NS) } catch { users = [] }
  const u = users.map((s) => ({ key: 'u:' + s.id, kind: 'user', id: s.id, name: s.name, code: s.code, info: scriptMatchInfo(s.code) })).filter((c) => c.info.match.length)
  const b = builtinImportTemplates(lang).filter((t) => !NATIVE_TEMPLATE_IDS.has(t.id)).map((t) => ({ key: 'b:' + t.id, kind: 'builtin', id: t.id, name: t.name, code: t.code, info: t.match }))
  return [...u, ...b]
}

/** 在一个一次性的沙箱 Worker 里跑一段导入脚本（files = [{ name, bytes }]），返回与 runImport 同形的结果 */
export async function workerExec(code, files, opts = {}) {
  const runner = createBeamScriptRunner()
  try {
    runner.setData(files.map((f) => ({ name: f.name, bytes: f.bytes })))
    return await runner.run(code, { mode: 'import', lang: opts.lang === 'en' ? 'en' : 'zh', timeoutMs: opts.timeoutMs || 30000 })
  } finally { runner.dispose() }
}

/**
 * files = [{ name, bytes:Uint8Array }]（内置解析器认不出的那些）。
 * 返回 { items, logs:[{ file, text, level }], unmatched:[文件名], tried:{ 文件名:[候选 key] } }；items 可直接交 coverageGxt.importBatch。
 * opts.candidates / opts.exec：换掉候选表与运行器（浏览器验证台用；Node 单测直接测 importRuntime.autoImport ——
 * 本模块经 library.js 依赖 Vite 的 import.meta.glob，Node 里载不进来）。
 */
export async function dispatchImport(files, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'zh'
  const cands = opts.candidates || await importCandidates(lang)
  const exec = opts.exec || ((code, list) => workerExec(code, list, { lang, timeoutMs: opts.timeoutMs }))
  const r = await autoImport(files, cands, exec, { lang })
  const items = [], logs = []
  for (const run of r.runs) {
    const tag = run.files.map((f) => f.name).join(', ')
    for (const l of (run.result.logs || [])) if (l.level === 'warn' || l.level === 'error') logs.push({ file: tag, text: l.text, level: l.level })
    items.push(...toLibraryItems(run.result.beams, { sourceName: tag, sourceFormat: 'script:' + (run.cand.kind === 'builtin' ? run.cand.id : run.cand.name) }))
  }
  // 全都没认出的文件：逐个候选记下没认出的原因（文件随后交「可编程导入」，在那边就地看、就地改）。
  // 中途没认出、后来被别的候选认出的不记 —— 那只是在排除。
  for (const name of r.unmatched) {
    for (const x of (r.fails[name] || [])) logs.push({ file: name, level: 'warn', text: lang === 'en' ? `"${x.cand}": ${x.reason}` : `「${x.cand}」${x.reason}` })
  }
  return { items, logs, unmatched: r.unmatched, tried: r.tried }
}
