// 平台语言的只读入口 —— 给【生成数据的模块】用（自动命名等），与 DOM 呈现层的 runtime.js 分工不同。
//
// 为什么自动名不能靠 runtime.js 的 t() 兜住：
//   ① 自动名是【数据】不是界面文本：它存进 library.json / configs.json，显示在 <input> 的 value 上
//      或打了 data-i18n-skip 的名字位上（那儿本该是用户数据），呈现层的观察器一概碰不到；
//   ② uiDict 是动态 import，defaultChain() 这类在模块装载期就要取名，那会儿词典还没到，t() 只回退中文；
//   ③ 本模块零依赖、不碰 DOM —— packages/core 的 Node 测试直接 import 得动 lbAutoName（它引本模块）。
//
// 词表就写在各自的调用点（byLang('卫星', 'Satellite')），不进 uiDict：自动名的词汇量极小，
// 且它与界面词条的生命周期不同（界面词条改了随时生效，自动名改了只影响此后新建的条目）。

export const LANG_KEY = 'ui-lang'

export function curLang() {
  try { return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh' } catch { return 'zh' }
}

// 生成数据时的语言分流
export const byLang = (zh, en) => (curLang() === 'en' ? en : zh)

// 「这个名字就是某种语言下的那个默认名」——用户没有真正起过名字，换语言时它应当跟着换过去。
// 容许 syncAutoNames / uniqueCfgName 加的重名后缀（「卫星 2」「New Folder 3」）。
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function isDefaultName(name, ...variants) {
  const s = String(name == null ? '' : name).trim()
  if (!s) return false
  return variants.some((v) => v && (s === v || new RegExp('^' + esc(v) + ' \\d+$').test(s)))
}
