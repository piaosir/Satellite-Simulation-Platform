// 干扰几何两张图共用的标签排布。
//
// 三件事，缺一件图就烂：
//   ① 垂直去重叠 —— 同一条曲线上相邻两点太近时，标签顺次往下推。
//   ② 推开必须有边界 —— 这是首版漏掉的那件事。多点同高时（「逐站给定」把每座站都填成同一个
//      密度，五条标签的期望位置完全重合）整叠会一路推到绘图区外，压在横轴刻度和轴名上，糊成
//      一坨。故推完要把整叠移回框内；实在放不下就压行距均分，宁可挤也不出框。
//   ③ 被推开的标签排成一列 —— 各自贴在自己点右边会得到一条参差不齐的左边缘，密集时更难读。
//      统一到一列、引线各自连回自己的点；列的横坐标还要保证最宽那条不越过右边界。
//
// 纯函数，不碰 DOM：SVG 里没有廉价的文字测量（getBBox 要先上屏），故宽度按字符估——
// 全角/CJK 约等于字号，西文约 0.56 字号。估得偏大一点没坏处，越界判据宁可保守。

const CJK = /[ᄀ-ᇿ⺀-꓏ꥠ-꥿가-퟿豈-﫿︐-︙︰-﹯＀-｠￠-￦]/

/** 估算一行文字的宽度（用户单位，与 viewBox 同尺度）。 */
export function textWidth(s, fontSize) {
  let w = 0
  for (const ch of String(s == null ? '' : s)) w += (CJK.test(ch) ? 1 : 0.56) * fontSize
  return w
}

/**
 * 排布一组点标签。
 *
 * @param {Array<{x:number, y:number, text:string}>} items 点的位置（用户单位）与标签文字
 * @param {object} box  { top, bottom, left, right } 绘图区；标签不得越出
 * @param {object} [opt] { lineH=11, gap=9.5, fontSize=7.4, colMin=2 }
 * @returns {Array} 原数组按 (y, x) 排序后的同一批对象，每个补上 labelX / labelY / anchor / displaced
 *   —— 按 (y, x) 排而不只按 y：同高的点若不按横坐标排，引线会互相交叉。
 */
export function layoutLabels(items, box, opt) {
  const o = opt || {}
  const lineH = o.lineH || 11
  const gap = o.gap == null ? 9.5 : o.gap
  const fontSize = o.fontSize || 7.4
  const arr = items.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x))
  const n = arr.length
  if (!n) return arr

  const span = box.bottom - box.top
  if ((n - 1) * lineH > span) {
    // 连压到最小行距都放不下：整栏均分，至少各自还看得见
    const step = n > 1 ? span / (n - 1) : 0
    arr.forEach((p, i) => { p.labelY = box.top + step * i })
  } else {
    let last = -Infinity
    for (const p of arr) { p.labelY = Math.max(p.y, last + lineH); last = p.labelY }
    // 整叠移回框内：先按下溢上移，再按上溢下移（上一步保证了叠高装得下，两次钳位不会打架）
    const over = arr[n - 1].labelY - box.bottom
    if (over > 0) for (const p of arr) p.labelY -= over
    const under = box.top - arr[0].labelY
    if (under > 0) for (const p of arr) p.labelY += under
  }

  for (const p of arr) p.displaced = Math.abs(p.labelY - p.y) > 1.5
  const moved = arr.filter((p) => p.displaced)
  const maxW = Math.max(...arr.map((p) => textWidth(p.text, fontSize)))

  if (moved.length >= 2) {
    // 统一列：贴最靠右那个被推开的点，但保证最宽的标签不越界
    let colX = Math.max(...moved.map((p) => p.x)) + gap
    colX = Math.min(colX, box.right - maxW - (o.colMin == null ? 2 : o.colMin))
    colX = Math.max(colX, box.left + 2)
    for (const p of arr) { p.labelX = colX; p.anchor = 'start' }
  } else {
    for (const p of arr) {
      const w = textWidth(p.text, fontSize)
      const rightFits = p.x + gap + w <= box.right
      p.anchor = rightFits ? 'start' : 'end'
      p.labelX = rightFits ? p.x + gap : p.x - gap
    }
  }
  return arr
}
