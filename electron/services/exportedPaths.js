'use strict'
// 导出回执的白名单 + 多文件落盘前的覆盖核对（主进程）。
//
// ① 白名单（files:reveal / files:open / video:reveal / video:openPath 共用）
//    渲染端拿到「已导出」回执后可以「打开 / 在文件夹中显示」，但主进程只认【本会话自己写过】的路径：
//    页面万一被注入脚本，也不能借这两条通道打开 / 定位任意文件。各保存处理器写成功后 markExported(p)。
//    原先只有视频导出有这一套（videoFile.js 里的 exported Set），2026-10-14 并到这里，全平台一份。
//    ★ 单例靠 Node 的模块缓存：register.js / videoFile.js 都是运行时按磁盘路径 require 的同一个文件，
//      拿到的是同一个实例。main.js 是打包产物，不要在 main.js 里静态 require 本文件（会是另一份实例）。
//    Windows / macOS 路径不分大小写：键按 resolve + 小写比。
//
// ② 覆盖核对（报告同 stem 的 .xlsx/.docx/.pdf、PFD 选目录批量写）
//    保存框只替【它确认过的那一个文件】问过覆盖；同名的兄弟文件、选目录后批量写的文件它问不到。
//    写之前把会被盖掉的已存在文件列出来，交调用方弹一次原生确认框。
const fs = require('fs')
const path = require('path')

const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin'
const keyOf = (p) => {
  if (typeof p !== 'string' || !p) return ''
  const r = path.resolve(p)
  return FOLD_CASE ? r.toLowerCase() : r
}

const exported = new Set()

// 登记一个本会话写过的文件（或输出目录）。空 / 非串静默忽略；返回登记的规范路径（'' = 没登记）
function markExported(p) {
  const k = keyOf(p)
  if (k) exported.add(k)
  return k ? path.resolve(p) : ''
}
const markAll = (list) => { for (const p of Array.isArray(list) ? list : []) markExported(p) }
function isExported(p) {
  const k = keyOf(p)
  return !!k && exported.has(k)
}
// 单测用
function clearExported() { exported.clear() }

// 会被覆盖的已存在文件：targets 里存在于盘上的，去掉保存框已确认过的 confirmed（不分大小写时按小写比），去重、保持原顺序。
// exists 可注入（单测）；缺省 fs.existsSync。
function pendingOverwrites(targets, confirmed, exists) {
  const has = typeof exists === 'function' ? exists : (p) => { try { return fs.existsSync(p) } catch { return false } }
  const skip = keyOf(confirmed)
  const seen = new Set()
  const out = []
  for (const p of Array.isArray(targets) ? targets : []) {
    const k = keyOf(p)
    if (!k || k === skip || seen.has(k)) continue
    seen.add(k)
    if (has(p)) out.push(p)
  }
  return out
}

// 确认框的文案（只陈述状态）。文件名多了只列前 maxNames 个，末行给总数。
const OVERWRITE_MAX_NAMES = 15
function overwritePrompt(paths, lang) {
  const en = lang === 'en'
  const list = Array.isArray(paths) ? paths : []
  const names = list.slice(0, OVERWRITE_MAX_NAMES).map((p) => path.basename(p))
  if (list.length > OVERWRITE_MAX_NAMES) names.push(en ? `… (${list.length} in total)` : `…（共 ${list.length} 个）`)
  return {
    type: 'warning',
    message: en ? 'The following files already exist' : '以下文件已存在',
    detail: names.join('\n'),
    buttons: en ? ['Replace', 'Cancel'] : ['替换', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
}

// 有冲突就弹框问；返回 true = 可以写（没有冲突，或用户点了「替换」）。dialog / win 由调用方给（主进程 electron.dialog）
async function confirmOverwrites(dialog, win, paths, lang) {
  if (!paths || !paths.length) return true
  if (!dialog || typeof dialog.showMessageBox !== 'function') return true
  const opt = overwritePrompt(paths, lang)
  const r = win ? await dialog.showMessageBox(win, opt) : await dialog.showMessageBox(opt)
  return !!r && r.response === 0
}

module.exports = { markExported, markAll, isExported, clearExported, pendingOverwrites, overwritePrompt, confirmOverwrites, OVERWRITE_MAX_NAMES }
