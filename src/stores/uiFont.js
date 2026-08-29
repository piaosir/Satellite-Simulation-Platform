import { reactive } from 'vue'

// 界面字体：西文面与中文面各选一档，合成后写进 <html> 的行内 --font-ui。
//
// 为什么分两档选：--font-ui 是一条中西文混排的栈，两段字面的相对大小决定了同一行里
// 中英文齐不齐（global.css 那段注释记了实测：TNR 配宋体时 11px 下中文字面 11px、
// 西文小写 6px，差 83%）。把两段拆开给，用户才配得出 TNR + 雅黑这种「西文衬线、
// 中文仍用大字面无衬线」的组合。
//
// 出厂 = Arial + 等线（2026-08-29 用户实测后定的）。选中这一组时不写行内变量，回到
// global.css :root 的出厂栈 —— 改那边必须同时改本文件的 DEFAULT_STACK。
// localStorage 持久化 + storage 事件跨窗联动（与 stores/theme.js 同一套机制），
// 主窗口改一次，链路预算 / NGSO / 再生式 / 端到端 / 干扰 / PFD / 雨衰 / 频率计划
// 各独立窗口立刻跟着变。报告打印页（report.js）刻意不引本模块 —— 那一面固定走 --font-doc。
const KEY_LAT = 'ui-font-latin'
const KEY_CJK = 'ui-font-cjk'

// 出厂档的 key。列表里没有单独的「系统默认」项 —— 那会与 Arial / 等线两档等效，
// 白白多出两个选了看不出区别的选项；出厂值就是这两档本身。
export const DEF_LATIN = 'arial'
export const DEF_CJK = 'dengxian'

// 西文面。stack 里不带中文面与 generic 尾巴，由 compose() 拼。
// serif 标记只用来决定 generic 尾巴（找不到时回落到哪一族）。
export const LATIN_FONTS = [
  { key: 'arial', label: 'Arial', stack: 'Arial, Helvetica', serif: false },
  { key: 'segoe', label: 'Segoe UI', stack: '"Segoe UI", system-ui, -apple-system', serif: false },
  { key: 'tnr', label: 'Times New Roman', stack: '"Times New Roman", Times', serif: true },
  { key: 'calibri', label: 'Calibri', stack: 'Calibri', serif: false },
  { key: 'cambria', label: 'Cambria', stack: 'Cambria', serif: true },
  { key: 'georgia', label: 'Georgia', stack: 'Georgia', serif: true },
  { key: 'palatino', label: 'Palatino Linotype', stack: '"Palatino Linotype", "Book Antiqua", Palatino', serif: true },
  { key: 'garamond', label: 'Garamond', stack: 'Garamond, "EB Garamond"', serif: true },
  { key: 'bookman', label: 'Bookman Old Style', stack: '"Bookman Old Style"', serif: true },
  { key: 'verdana', label: 'Verdana', stack: 'Verdana', serif: false },
  { key: 'tahoma', label: 'Tahoma', stack: 'Tahoma', serif: false },
  { key: 'trebuchet', label: 'Trebuchet MS', stack: '"Trebuchet MS"', serif: false },
  { key: 'candara', label: 'Candara', stack: 'Candara', serif: false },
  { key: 'consolas', label: 'Consolas', stack: 'Consolas', serif: false },
  { key: 'courier', label: 'Courier New', stack: '"Courier New", Courier', serif: true }
]

// 中文面。Windows 自带的六种正文用面；等线只在 Win10 以后有，缺时由可用性检测剔掉，
// 出厂栈里也垫了雅黑兜底（见 DEFAULT_STACK 与 global.css）。
export const CJK_FONTS = [
  { key: 'dengxian', label: '等线', en: 'DengXian', stack: 'DengXian, "等线"' },
  { key: 'yahei', label: '微软雅黑', en: 'Microsoft YaHei', stack: '"Microsoft YaHei UI", "Microsoft YaHei"' },
  { key: 'simsun', label: '宋体', en: 'SimSun', stack: 'SimSun, "宋体", NSimSun' },
  { key: 'simhei', label: '黑体', en: 'SimHei', stack: 'SimHei, "黑体"' },
  { key: 'kaiti', label: '楷体', en: 'KaiTi', stack: 'KaiTi, "楷体", STKaiti' },
  { key: 'fangsong', label: '仿宋', en: 'FangSong', stack: 'FangSong, "仿宋", STFangsong' }
]

const latOf = (k) => LATIN_FONTS.find(f => f.key === k) || LATIN_FONTS.find(f => f.key === DEF_LATIN)
const cjkOf = (k) => CJK_FONTS.find(f => f.key === k) || CJK_FONTS.find(f => f.key === DEF_CJK)

function read(key, list, def) {
  try {
    const v = localStorage.getItem(key)
    return list.some(f => f.key === v) ? v : def
  } catch { return def }
}

export const uiFont = reactive({
  latin: read(KEY_LAT, LATIN_FONTS, DEF_LATIN),
  cjk: read(KEY_CJK, CJK_FONTS, DEF_CJK),
  stack: ''            // 当前生效的完整栈（canvas / 离页 SVG 取字体用，见 shared/lbFont.js）
})

// 出厂栈：与 styles/global.css :root 的 --font-ui 逐字一致（那边改了这里要跟着改）。
const DEFAULT_STACK = 'Arial, Helvetica, DengXian, "等线", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'

function compose(latinKey, cjkKey) {
  if (latinKey === DEF_LATIN && cjkKey === DEF_CJK) return DEFAULT_STACK
  const L = latOf(latinKey), C = cjkOf(cjkKey)
  // 西文面在前、中文面在后：浏览器逐字形回落，拉丁字形命中前一段，汉字落到后一段。
  return `${L.stack}, ${C.stack}, ${L.serif ? 'serif' : 'sans-serif'}`
}

function apply() {
  const s = compose(uiFont.latin, uiFont.cjk)
  uiFont.stack = s
  const el = document.documentElement
  if (uiFont.latin === DEF_LATIN && uiFont.cjk === DEF_CJK) el.style.removeProperty('--font-ui')
  else el.style.setProperty('--font-ui', s)
}

export function setUiFont(latinKey, cjkKey) {
  if (latinKey != null) uiFont.latin = latOf(latinKey).key
  if (cjkKey != null) uiFont.cjk = cjkOf(cjkKey).key
  try {
    localStorage.setItem(KEY_LAT, uiFont.latin)
    localStorage.setItem(KEY_CJK, uiFont.cjk)
  } catch { /* ignore */ }
  apply()
}

export function resetUiFont() { setUiFont(DEF_LATIN, DEF_CJK) }

// —— 可用性检测 ——
// 列表里的 Cambria / Candara / Bookman / 等线 不是每台机器都装。列了却不生效比不列更让人困惑，
// 故开列表前先测一遍：把候选面与三个 generic 基准分别测宽，三个都同宽 = 这台机器上没有这个面
// （浏览器悄悄回落到了基准）。用长测试串放大差异；只要与任一基准不同宽即判为装了。
// 出厂两档恒在列 —— 它们就是 :root 里那一栈，测不出来也得让用户选得回去。
const PROBE = 'mMwWiIl10ABCgjpqy 中文测试字'
let _cache = null
function measure(family, size = 48) {
  const c = measure._c || (measure._c = document.createElement('canvas').getContext('2d'))
  c.font = `${size}px ${family}`
  return c.measureText(PROBE).width
}
function installed(stack) {
  const base = ['monospace', 'serif', 'sans-serif']
  return base.some(b => measure(`${stack}, ${b}`) !== measure(b))
}
// 返回过滤掉未安装项后的两张表。结果缓存，一个窗口只测一次。
export function availableFonts() {
  if (_cache) return _cache
  let latin = LATIN_FONTS, cjk = CJK_FONTS
  try {
    latin = LATIN_FONTS.filter(f => f.key === DEF_LATIN || installed(f.stack))
    cjk = CJK_FONTS.filter(f => f.key === DEF_CJK || installed(f.stack))
  } catch { /* 测不了就全列出来 */ }
  _cache = { latin, cjk }
  return _cache
}

window.addEventListener('storage', (e) => {
  if (e.key !== KEY_LAT && e.key !== KEY_CJK) return
  uiFont.latin = read(KEY_LAT, LATIN_FONTS, DEF_LATIN)
  uiFont.cjk = read(KEY_CJK, CJK_FONTS, DEF_CJK)
  apply()
})
apply()
