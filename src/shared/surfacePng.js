// LbSurfacePlot（地理场图 / C/CCI 覆盖场图）出图 = 一个 data:image/png URL。
//
// 图内部先拼成一份自洽的 SVG（矢量的线与字 + 位图的场），再整幅栅格化：直接截屏会连页面
// 背景与相邻元素一起截进来，而按 SVG 渲染的是这张图本身。倍率同时传进 exportSvgString：
// 矢量层浏览器会在 drawImage 的目标尺寸上重新栅格化，本就实；位图层（底图 / 场 / 国界）
// 没有这个待遇，必须按倍率重画一遍。
// 颜色一律走纸色板（shared/paperTheme.js）：屏上是深色，导出的也是白纸上的图。
// 原先只在 LbSpacePane 里有一份；抽出来给干扰分析的 C/CCI 场图共用同一条路径。
import { PAPER, PAPER_VARS } from './paperTheme.js'

// 只读字号 / 字体这类与主题无关的变量
const CSS_VARS = ['--lb-fs', '--lb-serif', '--font-serif']

// 抓页面里与图有关的 CSS 规则：SVG 离开页面后没有外部样式表可依
function collectRules() {
  const out = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules
    try { rules = sheet.cssRules } catch (e) { continue }   // 跨源样式表读不到，跳过
    for (const r of Array.from(rules || [])) {
      if (r.selectorText && /\.sf-/.test(r.selectorText)) out.push(r.cssText)
    }
  }
  return out.join('\n')
}

/** plot = LbSurfacePlot 的组件实例（exportSvgString / svgSize）。失败回空串。 */
export async function surfacePngDataUrl(plot, scale = 4) {
  if (!plot) return ''
  const s = scale || 4
  const cs = getComputedStyle(document.documentElement)
  const bg = PAPER.bg
  // 空值的自定义属性不能写进声明：`--lb-serif:;` 会让 var(--lb-serif, 回落) 落到「空」
  // 而不是回落值（自定义属性的空值是合法值，不触发 fallback），整幅字体因此失效
  const decl = CSS_VARS.map((v) => [v, (cs.getPropertyValue(v) || '').trim()])
    .filter(([, val]) => val).map(([v, val]) => v + ':' + val)
    .concat(Object.entries(PAPER_VARS).map(([v, val]) => v + ':' + val)).join(';') + ';background:' + bg
  let src = await plot.exportSvgString(decl, s)
  if (!src) return ''
  src = src.replace(/<svg([^>]*)>/, (m, a) => `<svg${a}><style>${collectRules()}</style>`)
  const { w, h } = plot.svgSize()
  try {
    const img = new Image()
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src)
    await img.decode()
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(w * s)); cv.height = Math.max(1, Math.round(h * s))
    const ctx = cv.getContext('2d')
    ctx.fillStyle = bg                       // PNG 不留透明底：贴进报告会露出下面的东西
    ctx.fillRect(0, 0, cv.width, cv.height)
    ctx.drawImage(img, 0, 0, cv.width, cv.height)
    return cv.toDataURL('image/png')
  } catch (e) { return '' }                  // 渲染失败：没有这张图即可，不打断上层
}
