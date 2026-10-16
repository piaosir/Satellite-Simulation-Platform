// Monaco 按需装载入口：只在打开「可编程波束地图」时拉取（编辑器 + TypeScript 语言服务是几 MB 的块，不进启动包）。
//
// 界面语言：Monaco 的界面串（查找框、右键菜单、补全提示…）走全局表 globalThis._VSCODE_NLS_MESSAGES，
// 多数串按调用时查表，但右键菜单 / 命令面板标题在编辑器模块求值时就定死 —— 故首次载入按当前语言：
// 中文界面先串行载入官方中文表再求值编辑器模块，英文界面不载；之后切换语言只换运行时查的表（中文表用到时再取）。
import { curLang } from '../../shared/i18n/lang.js'
import { onLangChange } from '../../shared/i18n/runtime.js'
import dtsRaw from '../../shared/beamScript/beammap.dts.txt?raw'
import { localize } from '../../shared/beamScript/templates.js'

let _p = null
let _zh = null
// 中文表只在要用时取：模块只求值一次 → 首次取完就记下；求值会直接改全局表，取完还原，挂不挂由 applyLang 定
async function zhTable() {
  if (!_zh) {
    const m = globalThis._VSCODE_NLS_MESSAGES, l = globalThis._VSCODE_NLS_LANGUAGE
    await import('monaco-editor/nls/lang/zh-cn.js')
    if (!_zh) _zh = globalThis._VSCODE_NLS_MESSAGES
    globalThis._VSCODE_NLS_MESSAGES = m
    globalThis._VSCODE_NLS_LANGUAGE = l
  }
  return _zh
}
function applyLang(core, lang) {
  globalThis._VSCODE_NLS_MESSAGES = lang === 'en' ? undefined : _zh
  globalThis._VSCODE_NLS_LANGUAGE = lang === 'en' ? undefined : 'zh-cn'
  core.setScriptTypes(localize(dtsRaw, lang))
}

export function loadMonaco() {
  if (_p) return _p
  _p = (async () => {
    // 首次载入按当前语言：英文界面不挂中文表，菜单 / 命令标题在模块求值时按英文定下
    const lang0 = curLang()
    if (lang0 !== 'en') await zhTable()
    globalThis._VSCODE_NLS_MESSAGES = lang0 === 'en' ? undefined : _zh
    globalThis._VSCODE_NLS_LANGUAGE = lang0 === 'en' ? undefined : 'zh-cn'
    const core = await import('./monacoCore.js')
    if (curLang() !== 'en' && !_zh) { try { await zhTable() } catch { /* 留英文 */ } }   // 载入期间切到中文
    applyLang(core, curLang())
    let seq = 0
    onLangChange(async (lang) => {
      const my = ++seq
      if (lang !== 'en') { try { await zhTable() } catch { /* 取表失败：留英文 */ } }
      if (my === seq) applyLang(core, lang)
    })
    // 主题跟随软件：data-theme 一变就从令牌重取一次
    core.applyTheme()
    new MutationObserver(() => core.applyTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin'] })
    return core
  })()
  _p.catch(() => { _p = null })   // 载入失败（极少见）允许下次重试
  return _p
}
