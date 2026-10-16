// Monaco 编辑器本体（VS Code 同款；可编程波束地图对话框专用，由 monaco.js 按需动态载入）。
//
// 只拉用得到的部分：编辑器 API + 脚本编辑用得到的那套编辑功能 + JavaScript 语言服务（TypeScript worker：按
// beammap.dts.txt 给出类型感知的补全、悬停文档与拼写错误红线）+ 预览用的 XML / INI 着色。
// 不走 editor.main.js / features/register.all.js：前者带 80 多种语言，后者带差异对比、内联补全、GPU 渲染、CodeLens、
// 取色器、拖放、内嵌提示、粘性滚动、Unicode 疑似字符高亮（中文全角标点会被框黄）等脚本编辑用不上的件，
// 打开对话框时少解析一批代码、界面上也不冒出无关的浮层。功能清单对照 editor.main.js 维护。
// （构建内存不靠这里省：editor.api 本身就有上千个模块，渲染端构建的堆上限已在 package.json 的 build 脚本里调到 8 GB。）
//
// Worker：官方预构建件（min/vs/assets 下自包含的 IIFE，与这里的 ESM 主体同版本、同协议），由构建配置原样拷到
// <页面目录>/monaco/ 下（见 electron.vite.config.mjs 的 monacoWorkers）—— 不走 ?worker 打包：TypeScript 语言服务
// 源码约 9 MB，进 Rollup 会把渲染端构建顶爆 4 GB 堆。经 MonacoEnvironment.getWorker 交给 Monaco。
import * as monaco from 'monaco-editor/editor/editor.api.js'
// 包的 exports 只映射 .js 子路径，两份图标字体 CSS 按相对路径取
import '../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css'
import '../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css'
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js'
import 'monaco-editor/editor/browser/coreCommands.js'
import 'monaco-editor/editor/common/standaloneStrings.js'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/transpose.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js'
import 'monaco-editor/editor/contrib/comment/browser/comment.js'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js'
import 'monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols.js'
import 'monaco-editor/features/find/register.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/folding/browser/folding.js'
import 'monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js'
import 'monaco-editor/editor/contrib/format/browser/formatActions.js'
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js'
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js'
import 'monaco-editor/editor/contrib/inlineProgress/browser/inlineProgress.js'
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js'
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js'
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js'
import 'monaco-editor/editor/contrib/rename/browser/rename.js'
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js'
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js'
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js'
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js'
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js'
import 'monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js'
import 'monaco-editor/languages/definitions/javascript/register.js'
import 'monaco-editor/languages/definitions/xml/register.js'
import 'monaco-editor/languages/definitions/ini/register.js'
import { javascriptDefaults, ScriptTarget, ModuleKind } from 'monaco-editor/languages/features/typescript/register.js'

const WORKER_BASE = new URL('./monaco/', document.baseURI)
globalThis.MonacoEnvironment = {
  getWorker(_id, label) {
    const file = (label === 'typescript' || label === 'javascript') ? 'ts.worker.js' : 'editor.worker.js'
    return new Worker(new URL(file, WORKER_BASE), { name: 'monaco-' + label })
  }
}

// ---- 脚本语言服务：顶层 return / await 合法（脚本体包在 async 函数里跑），只要 ES 标准库、不要 DOM ----
// 1108 'return' 只能在函数体内；1375 / 1378 顶层 await；2304 之类照常报（拼错的名字要红线）
// moduleDetection = 3（Force）：每个脚本模型各自成模块。不加的话同时开着的几个脚本（模板 + 用户脚本）会被当成
// 同一全局作用域里的几段脚本，彼此的顶层 const 互报「重复声明」。声明文件不受影响，beammap.d.ts 照旧是全局声明。
javascriptDefaults.setCompilerOptions({
  target: ScriptTarget.ESNext, module: ModuleKind.ESNext, moduleDetection: 3, allowNonTsExtensions: true, allowJs: true, checkJs: true,
  noLib: false, lib: ['es2023'], strict: false, noImplicitAny: false
})
javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: [1108, 1375, 1378, 80001, 80005, 7044, 7043] })
javascriptDefaults.setEagerModelSync(true)
let _libDispose = null
export function setScriptTypes(dtsText) {
  if (_libDispose) { try { _libDispose.dispose() } catch { /* ignore */ } }
  _libDispose = javascriptDefaults.addExtraLib(dtsText, 'file:///beammap/beammap.d.ts')
}

// ---- 预览用的 JSON / CSV 着色（Monarch 词法，不起语言 worker，免得只读预览也跑一遍诊断）----
monaco.languages.register({ id: 'bm-json' })
monaco.languages.setMonarchTokensProvider('bm-json', {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/[{}[\],:]/, 'delimiter']
    ]
  }
})
monaco.languages.register({ id: 'bm-csv' })
monaco.languages.setMonarchTokensProvider('bm-csv', {
  tokenizer: { root: [[/"(?:[^"]|"")*"/, 'string'], [/-?\d+(?:\.\d+)?(?=[,;\t\r\n]|$)/, 'number'], [/[,;\t]/, 'delimiter']] }
})

// ---- 主题：从软件的设计令牌现取（专业浅色 / 专业深色两档），换主题时重定义 ----
function toHex(css) {
  const el = document.createElement('span')
  el.style.color = css
  el.style.display = 'none'
  document.body.appendChild(el)
  const rgb = getComputedStyle(el).color
  el.remove()
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?/.exec(rgb)
  if (!m) return null
  const h = (v) => Math.max(0, Math.min(255, Math.round(+v))).toString(16).padStart(2, '0')
  let a = ''
  if (m[4] != null) { const av = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]; if (av < 1) a = h(av * 255) }
  return '#' + h(m[1]) + h(m[2]) + h(m[3]) + a
}
const tok = (name, fb) => { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return (v && toHex(v)) || fb }
const withA = (hex, a) => (hex ? hex.slice(0, 7) + a : undefined)
export function applyTheme() {
  const dark = document.documentElement.dataset.theme === 'dark'
  const bg = tok('--field-bg', dark ? '#111111' : '#ffffff')
  const text = tok('--text', dark ? '#dbdbdb' : '#1a1a1a')
  const muted = tok('--text-muted', dark ? '#afafaf' : '#6b6b66')
  const faint = tok('--text-faint', dark ? '#8a8a8a' : '#86867f')
  const border = tok('--border-strong', dark ? '#444444' : '#adaca4')
  const float = tok('--float-bg', dark ? '#222222' : '#ffffff')
  const accent = tok('--accent-ui', dark ? '#6a8ab8' : '#2f5d8a')
  const name = dark ? 'satsim-dark' : 'satsim-light'
  monaco.editor.defineTheme(name, {
    base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [],
    colors: {
      'editor.background': bg, 'editor.foreground': text,
      'editorLineNumber.foreground': faint, 'editorLineNumber.activeForeground': muted,
      'editor.lineHighlightBackground': withA(text, dark ? '0c' : '09'), 'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': accent, 'editor.selectionBackground': withA(accent, dark ? '55' : '3a'),
      'editor.inactiveSelectionBackground': withA(accent, dark ? '33' : '22'),
      'editorWidget.background': float, 'editorWidget.border': border, 'editorHoverWidget.background': float, 'editorHoverWidget.border': border,
      'editorSuggestWidget.background': float, 'editorSuggestWidget.border': border, 'editorSuggestWidget.selectedBackground': withA(accent, dark ? '55' : '2a'),
      'editorGutter.background': bg, 'focusBorder': withA(accent, 'ff'),
      'scrollbarSlider.background': withA(muted, '33'), 'scrollbarSlider.hoverBackground': withA(muted, '55'), 'scrollbarSlider.activeBackground': withA(muted, '77')
    }
  })
  monaco.editor.setTheme(name)
}

export { monaco }
