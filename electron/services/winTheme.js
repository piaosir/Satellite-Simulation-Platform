// 窗口外观：新开窗口在页面画出第一帧之前露的是 BrowserWindow 的 backgroundColor，主窗的原生三键区是
// titleBarOverlay。原来两者写死浅色（#ffffff / #f7f7f5）—— 深色外观下每开一个窗口先白闪一下、
// 主窗三键要等渲染端 IPC 回来才变色。这里记住当前外观（渲染端 stores/theme.js 每次换肤报一次），
// 落 <userData>/ui-theme.json，下次启动的第一个窗口也用得上。
// 取值是 src/styles/global.css 两套（专业浅色 / 专业深色）--bg / --surface / --text 的手工副本：改那边须同步这里。
const fs = require('fs')
const { join } = require('path')
const { app, nativeTheme } = require('electron')

// well = --pane-well：主窗外壳（菜单栏 / 工具栏 / 活动栏 / 状态栏）的底色，三键区跟它走
const KINDS = {
  'studio-light': { bg: '#ffffff', surface: '#f8f8f8', well: '#e9e9e9', text: '#292929' },   // 专业浅色
  dark: { bg: '#111111', surface: '#1b1b1b', well: '#111111', text: '#dbdbdb' }             // 专业深色（10-14 起即深色）
}
KINDS.studio = KINDS.dark                // 10-14 试用版写下的键
KINDS.light = KINDS['studio-light']      // 原「浅色」档 10-14 已删，旧文件里的值按专业浅色开窗

// ★ 不在内存里缓存：main.js 静态引本文件（打进 out/main），ipc/register.js 却是运行时按路径 require 的源码 ——
// 两边是两个模块实例，内存变量不相通。以文件为准，开窗时现读（几十字节，开窗频率极低）。
const file = () => join(app.getPath('userData'), 'ui-theme.json')

function readKind() {
  try { const k = JSON.parse(fs.readFileSync(file(), 'utf8')).kind; if (KINDS[k]) return k } catch { /* 首次运行 / 文件坏了 */ }
  // 出厂外观是「跟随系统」：还没有记录时按系统深浅开窗（与渲染端 stores/theme.js 同口径）
  try { return nativeTheme.shouldUseDarkColors ? 'dark' : 'studio-light' } catch { return 'studio-light' }
}
const current = () => KINDS[readKind()]

// nativeTheme.themeSource：原生标题栏（工具窗、性能表）与 prefers-color-scheme 跟应用外观走 ——
// 系统浅色、应用选专业深色时，原来是白标题栏压在 #111 内容上。「跟随系统」= 'system' 交还系统。
const SOURCES = ['system', 'light', 'dark']
function readSource() {
  try { const s = JSON.parse(fs.readFileSync(file(), 'utf8')).source; if (SOURCES.includes(s)) return s } catch { /* 首次运行 */ }
  return 'system'
}
function applySource(s) {
  try { if (nativeTheme.themeSource !== s) nativeTheme.themeSource = s } catch { /* app 未就绪 */ }
}

function setKind(k, source) {
  const s = SOURCES.includes(source) ? source : null
  if (s) applySource(s)
  if (!KINDS[k] || (k === readKind() && (!s || s === readSource()))) return false
  try { fs.writeFileSync(file(), JSON.stringify(s ? { kind: k, source: s } : { kind: k, source: readSource() })) } catch { /* 写不了不影响本次运行 */ }
  return true
}

module.exports = {
  winBg: () => current().bg,
  // 高度见 main.js createWindow 的注释（比菜单栏矮 1px）
  winOverlay: () => ({ color: current().well, symbolColor: current().text, height: 31 }),
  setKind,
  // 启动时（app ready 后、第一个窗口之前）按上次记住的外观设 themeSource
  initSource: () => applySource(readSource())
}
