// 可编程波束地图 · 脚本库（渲染端）：内置模板（templates/*.bmjs 原文，构建期内联）+ 用户脚本（主进程 library.json
// 的 beamScripts 命名空间：整读整写、原子落盘带 .bak；没有桌面 API —— 浏览器里调试渲染层 —— 时退到 localStorage）。
import { parseTemplates, blankScript } from '../../shared/beamScript/templates.js'
import { parseImportTemplates, blankImportScript } from '../../shared/beamScript/importTemplates.js'
import { copyNameOf } from '../../shared/lbAutoName.js'
import { byLang } from '../../shared/i18n/lang.js'

const RAW = import.meta.glob('../../shared/beamScript/templates/*.bmjs', { query: '?raw', import: 'default', eager: true })
export const builtinTemplates = (lang) => parseTemplates(RAW, lang)
export { blankScript }
// 可编程导入：内置解析模板（importTemplates/*.bmjs）+ 用户导入脚本（library.json 的 beamImportScripts 命名空间）
const RAW_IMPORT = import.meta.glob('../../shared/beamScript/importTemplates/*.bmjs', { query: '?raw', import: 'default', eager: true })
export const builtinImportTemplates = (lang) => parseImportTemplates(RAW_IMPORT, lang)
export { blankImportScript }
export const IMPORT_NS = 'beamImportScripts'

const NS = 'beamScripts'
const lsKey = (ns) => (ns === IMPORT_NS ? 'beamImport/library' : 'beamScript/library')
const store = () => (typeof window !== 'undefined' && window.api && window.api.store && window.api.store.getLibrary) ? window.api.store : null

export async function loadScripts(ns = NS) {
  let lib = null
  const s = store()
  try { lib = s ? await s.getLibrary(ns) : JSON.parse(localStorage.getItem(lsKey(ns)) || 'null') } catch { lib = null }
  const list = lib && Array.isArray(lib.scripts) ? lib.scripts : []
  return list.filter((x) => x && x.id && typeof x.code === 'string').map((x) => ({
    id: String(x.id), name: String(x.name || '').trim() || byLang('未命名脚本', 'Untitled Script'), code: x.code,
    from: String(x.from || ''), createdAt: String(x.createdAt || ''), updatedAt: String(x.updatedAt || '')
  }))
}
// 出 IPC 前现造纯数据（列表常是 Vue 响应式数组，结构化克隆过不了 Proxy）
export async function saveScripts(scripts, ns = NS) {
  const data = { v: 1, scripts: (scripts || []).map((x) => ({ id: x.id, name: x.name, code: x.code, from: x.from || '', createdAt: x.createdAt || '', updatedAt: x.updatedAt || '' })) }
  const s = store()
  if (s) return s.saveLibrary(ns, JSON.parse(JSON.stringify(data)))
  try { localStorage.setItem(lsKey(ns), JSON.stringify(data)) } catch { /* 隐私模式 / 配额满：不阻断编辑 */ }
  return true
}

export const newScriptId = () => 'bs-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
// 同名加序号：「新脚本」「新脚本 2」…（不分大小写）
export function uniqueName(base, taken) {
  const used = new Set((taken || []).map((n) => String(n).trim().toLowerCase()))
  const b = String(base || '').trim() || byLang('新脚本', 'New Script')
  if (!used.has(b.toLowerCase())) return b
  for (let i = 2; ; i++) { const n = `${b} ${i}`; if (!used.has(n.toLowerCase())) return n }
}
export const newScriptName = (taken) => uniqueName(byLang('新脚本', 'New Script'), taken)
export const copyScriptName = (name, taken) => uniqueName(copyNameOf(name), taken)
