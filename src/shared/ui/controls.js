// 控件行为基线（画法在 styles/controls.css，这里只放纯 CSS 管不了的那一件）。
// 每个窗口入口在引 styles/global.css 之后引一次本模块。
//
// 滚轮误改数值：<input type=number> 只要拿到焦点，鼠标滚轮划过就会加减步长。本软件里有 256 个
// 数字框，且大多挨着可滚动的面板 —— 用户以为在滚面板，实际把口径/频率/增益改掉了，改完还不报错，
// 一路算到结果里才发现。故：滚轮落在已聚焦的数字框上时先让它失焦，滚动照旧交给面板。
// 不用 preventDefault —— 那样连面板都滚不动了。

export function installControlGuards(doc = document) {
  doc.addEventListener('wheel', (e) => {
    const el = doc.activeElement
    if (el && el.tagName === 'INPUT' && el.type === 'number' && (el === e.target || el.contains(e.target))) el.blur()
  }, { capture: true, passive: true })
}

installControlGuards()
