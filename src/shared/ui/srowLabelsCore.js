// 参数行 .srow 的「标签 + 控件」程序化关联（纯逻辑，不碰 document；安装器在 controls.js 的 installSrowLabels）。
//
// 全库约 455 处参数行写成兄弟结构 <div class="srow"><label>频率</label><input …></div>：标签与控件只是并排，
// 读屏念不出控件叫什么。这里不改模板与 DOM 结构，只在运行时补属性：
//   · 文本类输入框 / 下拉 / 多行框 → 控件补 id、标签补 for（点标签即聚焦控件，原生行为）。
//   · 数字框 / 滑杆 / 取色 / 复选 / 单选 / 文件 → 标签补 id、控件补 aria-labelledby。
//     这几类若走 for，点标签就等于激活控件：复选被切换、取色与文件弹框；数字框的标签是数值横拖的把手
//     （controls.js installNumberScrub），拖完松手补发的 click 会把焦点抢进框里。aria-labelledby 只给名字、不带行为。
// 判定只认「.srow 的直接子级 label、自身不含控件（排除行内勾选框 .chk-in 那类包裹式 label）」，
// 目标取标签之后、下一个 label 之前的第一个 input / select / textarea；控件已有 id / aria-label / aria-labelledby 的不动。

const CTL_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA'])
const NO_FOR_TYPES = new Set(['number', 'range', 'color', 'checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image'])
export const FOR_PREFIX = 'srf-'
export const LBL_PREFIX = 'srl-'

const attr = (el, k) => (el && el.getAttribute ? el.getAttribute(k) : null)

// 标签对应的控件；不该由本模块处理的返回 null
export function srowLabelTarget(label) {
  if (!label || label.tagName !== 'LABEL') return null
  const row = label.parentElement
  if (!row || !row.classList || !row.classList.contains('srow')) return null
  if (label.querySelector && label.querySelector('input, select, textarea, button')) return null
  for (let c = label.nextElementSibling; c; c = c.nextElementSibling) {
    if (c.tagName === 'LABEL') return null
    if (!CTL_TAGS.has(c.tagName)) continue
    if (c.tagName === 'INPUT' && String(c.type || '').toLowerCase() === 'hidden') continue
    return c
  }
  return null
}

export function linkMode(ctl) {
  return ctl.tagName === 'INPUT' && NO_FOR_TYPES.has(String(ctl.type || 'text').toLowerCase()) ? 'labelledby' : 'for'
}

// 配一对。nextId(prefix) 由调用方给（保证文档内唯一）。返回 { ctl, mode } 或 null（未改动）。
export function pairSrowLabel(label, nextId) {
  const ctl = srowLabelTarget(label)
  if (!ctl) return null
  const f = attr(label, 'for')
  if (f) {
    // 只接手自己配过、且控件已被换掉（v-if 换了一个新元素）的那种；页面自己写的 for 一律不动
    if (!f.startsWith(FOR_PREFIX) || ctl.id === f) return null
  }
  if (ctl.id || attr(ctl, 'aria-label') || attr(ctl, 'aria-labelledby')) return null
  const mode = linkMode(ctl)
  if (mode === 'for') {
    ctl.id = nextId(FOR_PREFIX)
    label.setAttribute('for', ctl.id)
  } else {
    if (f) label.removeAttribute('for')
    if (!label.id) label.id = nextId(LBL_PREFIX)
    ctl.setAttribute('aria-labelledby', label.id)
  }
  return { ctl, mode }
}
