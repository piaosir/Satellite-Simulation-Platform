// 覆盖图导出：把 2D 平面图渲染器(flatCoverage)的当前状态导出为「高清 PNG」或「矢量 PDF」。
//  - PNG：离屏 canvas 按像素倍率放大后一次性绘制 → toBlob（栅格，但矢量来源放大依旧锐利）。
//  - PDF：svgcanvas 录制为矢量 SVG → svg2pdf + jsPDF，嵌入系统中文字体（中文可显示/可选可搜）。
// 两条路径都走 flat.exportRender 的 compat 子路径回放（不依赖 Path2D），保证 PNG 与 PDF 完全一致。
// 唯一的例外是影像底图：PNG 传 raster:true 照画整幅影像，PDF 那路仍出矢量底图（位图 base64 进 SVG 不可用）。
import { jsPDF } from 'jspdf'
import { svg2pdf } from 'svg2pdf.js'
import { Context as SvgContext } from 'svgcanvas'

// 导出 SVG 的 font-family 与 PDF 内注册的字体族名对齐。PDF 的字体按「资源」整体选用、不像浏览器逐字形回落，
// 故分两面注册：汉字走嵌入的中文 TTF，西文/数字走嵌入的 Times New Roman（与软件界面同字体）。
// 拉丁族名后缀 times = PDF 内建基础 14 字体，作 TNR 未嵌入成功时的兜底（观感等同，无需嵌入）。
const EXPORT_FONT = 'cjkexport'
const EXPORT_FONT_LATIN = 'tnrexport'
const LATIN_FALLBACK = 'times'

// 性能补丁（svgcanvas 2.6.0）：其 lineTo 每个点都 indexOf('M') 全串扫描，单条大 path 退化为 O(N²)——
// 合并后的陆地/海岸线达 10 万+ 点时录制耗时 ~27s。改用布尔标记代替全串扫描，并只做一次矩阵变换，
// 使大 path 录制回到 O(N)（实测瓶颈即在此）。仅在模块加载时打一次。
if (!SvgContext.prototype.__perfPatched) {
  const P = SvgContext.prototype
  const origMoveTo = P.moveTo, origBeginPath = P.beginPath
  P.beginPath = function () { origBeginPath.call(this); this.__hasMove = false }
  P.moveTo = function (x, y) { origMoveTo.call(this, x, y); this.__hasMove = true }
  // 子路径未起头（无前置 moveTo，如 arc/dot 内部直接 lineTo 起笔）时，须按原版 svgcanvas 语义补一个 M——
  // 否则 arc() 先调的 lineTo(起点) 被吞掉，只剩 'A' 弧命令成废路径 → 导出 PDF 里所有圆点(dot/arc)消失。
  P.lineTo = function (x, y) {
    this.__currentPosition = { x: x, y: y }
    const p = this.__matrixTransform(x, y)
    if (this.__hasMove) { this.__addPathCommand('L ' + p.x + ' ' + p.y) }
    else { this.__addPathCommand('M ' + p.x + ' ' + p.y); this.__hasMove = true }
  }
  P.__perfPatched = true
}

// 高清 PNG：factor=像素倍率。view=true 时按当前屏幕视图(所见即所得)出图，逻辑尺寸取屏幕 cw×ch；
// 否则整幅世界图：逻辑尺寸取屏幕上整幅世界图 fit 后的大小（fittedWorldSize），仅把像素倍率补足到
// base×factor 的输出分辨率 → 恒定屏幕 px 的线宽/图标/注记与软件里整幅图完全同比例（所见即所得）。
// 返回 PNG 字节（Uint8Array）。
// targetW：直接指定输出位图的像素宽（4K=3840 / 8K=7680），给了它就顶替 factor ——
// 用户心里想的是「出一张 8K 图」，不是「出一张 3.2 倍图」，而 2D 这条按倍率算出来的宽度还随
// 视口尺寸浮动（同一个 4× 在 1280 宽和 1920 宽的窗口上出的图不一样大）。
// 上限来自 Chromium 画布：单边 ≤ 65535 且总面积 ≤ 268 MPix，超了 toBlob 直接返回 null。
export async function renderFlatPNG(flat, { base = 2000, factor = 2, targetW = 0, view = false } = {}) {
  let W, H, ps = factor
  if (view) { const v = flat.viewportSize(); W = Math.max(1, Math.round(v.w)); H = Math.max(1, Math.round(v.h)) }
  else {
    const f = flat.fittedWorldSize && flat.fittedWorldSize()
    if (f) { W = f.w; H = f.h; ps = (base * factor) / W }   // 输出位图仍为 base×factor 宽
    else { W = base; H = Math.round(base / 2) }             // 画布未就绪的兜底：按名义尺寸出图
  }
  if (targetW > 0) ps = targetW / W
  // 画布面积封顶：超限时 toBlob 返回 null，报错信息又只有一句「toBlob 失败」，极难对上因果。
  // 这里主动按面积折算回去，并把实际出图尺寸随返回值带出去，文件名写实数不写请求数。
  const MAXPIX = 268435456, MAXDIM = 65535
  ps = Math.min(ps, Math.sqrt(MAXPIX / (W * H)), MAXDIM / W, MAXDIM / H)
  const cv = document.createElement('canvas')
  cv.width = Math.round(W * ps); cv.height = Math.round(H * ps)
  // 先把这次出图要用的影像瓦片等到位，再同步渲染 —— 少了这一步，导出的图上会缺一大块
  // （exportRender 是同步的，当时不在缓存里的片就永远没画上）。没开影像时是个空操作。
  if (flat.ensureImagery) await flat.ensureImagery({ width: W, height: H, pixelScale: ps, view })
  flat.exportRender(cv.getContext('2d'), { width: W, height: H, pixelScale: ps, view, raster: true })
  const blob = await new Promise((res, rej) => cv.toBlob((b) => b ? res(b) : rej(new Error('toBlob 失败')), 'image/png'))
  const bytes = new Uint8Array(await blob.arrayBuffer())
  // 兼容旧调用：返回值仍可当 Uint8Array 用（老调用方只取字节），实际尺寸挂在自有属性上。
  bytes.outW = cv.width; bytes.outH = cv.height
  return bytes
}

// 矢量 PDF：svgcanvas 录制 → svg2pdf。fonts={cjk,latin,latinBold,latinItalic} 各为 TTF 的 base64
// （来自主进程 window.api.pdfFonts）；cjk 缺失时中文回退系统默认字体（可能缺字），latin 缺失时西文用
// PDF 内建 times。jsPDF 按用到的字形子集化嵌入，多带一套拉丁面几乎不增体积。返回 PDF 字节（Uint8Array）。
export async function renderFlatPDF(flat, { base = 2000, fonts = null, view = false } = {}) {
  let W, H
  if (view) { const v = flat.viewportSize(); W = Math.max(1, Math.round(v.w)); H = Math.max(1, Math.round(v.h)) }
  else {
    // 整幅世界图：页面逻辑尺寸取屏幕 fit 大小（同 PNG，所见即所得）；矢量图与分辨率无关，页面 pt 数只是名义大小
    const f = flat.fittedWorldSize && flat.fittedWorldSize()
    if (f) { W = f.w; H = f.h } else { W = base; H = Math.round(base / 2) }
  }
  const t = (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now())
  const log = (label, ms) => console.log('[PDF导出] ' + label + ': ' + ms.toFixed(0) + 'ms')
  let t0 = t()
  const f = fonts || {}
  // 拉丁面族名须在录制前定下（写进 SVG 的 font-family）：嵌到 TNR 就用它，否则退到内建 times。
  // 两个族名一并写成回退串，粗斜等未注册的字型组合由 svg2pdf 顺位落到 times（它有全部四种字型）。
  const latinFamily = (f.latin ? EXPORT_FONT_LATIN + ', ' : '') + LATIN_FALLBACK
  const sctx = new SvgContext(W, H)
  flat.exportRender(sctx, { width: W, height: H, pixelScale: 1, fontFamily: EXPORT_FONT, fontFamilyLatin: latinFamily, view })
  log('exportRender(svgcanvas 录制)', t() - t0); t0 = t()
  let svg = sctx.getSerializedSvg(true)
  log('getSerializedSvg', t() - t0)
  // svgcanvas 的 fill() 不支持 evenodd 入参 → 在根节点声明 fill-rule:evenodd，使陆地内湖泊/飞地不被填实
  svg = svg.replace(/<svg /, '<svg fill-rule="evenodd" ')
  // svg2pdf 需要在文档中的 DOM 元素（读取计算样式）：临时挂到离屏容器，用后移除
  t0 = t()
  const holder = document.createElement('div')
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden'
  holder.innerHTML = svg
  const svgEl = holder.firstElementChild
  document.body.appendChild(holder)
  log('innerHTML 解析为 DOM', t() - t0)
  console.log('[PDF导出] SVG 体积: ' + (svg.length / 1048576).toFixed(2) + 'MB · path 节点: ' + svgEl.querySelectorAll('path').length + ' · text: ' + svgEl.querySelectorAll('text').length + ' · clipPath: ' + svgEl.querySelectorAll('clipPath').length + ' · image: ' + svgEl.querySelectorAll('image').length)
  try {
    t0 = t()
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: [W, H], compress: true })
    if (f.cjk) {
      doc.addFileToVFS('cjk.ttf', f.cjk)
      doc.addFont('cjk.ttf', EXPORT_FONT, 'normal')
      doc.addFont('cjk.ttf', EXPORT_FONT, 'italic')
      doc.addFont('cjk.ttf', EXPORT_FONT, 'bold')
    }
    if (f.latin) {
      // 粗/斜面缺失时用常规面顶上（宁可字重不对，也不要掉字）
      const reg = f.latin
      doc.addFileToVFS('tnr.ttf', reg); doc.addFont('tnr.ttf', EXPORT_FONT_LATIN, 'normal')
      doc.addFileToVFS('tnr-bd.ttf', f.latinBold || reg); doc.addFont('tnr-bd.ttf', EXPORT_FONT_LATIN, 'bold')
      doc.addFileToVFS('tnr-it.ttf', f.latinItalic || reg); doc.addFont('tnr-it.ttf', EXPORT_FONT_LATIN, 'italic')
    }
    log('jsPDF 初始化+字体', t() - t0); t0 = t()
    await svg2pdf(svgEl, doc, { x: 0, y: 0, width: W, height: H })
    log('svg2pdf 转换', t() - t0); t0 = t()
    const out = new Uint8Array(doc.output('arraybuffer'))
    log('doc.output', t() - t0)
    return out
  } finally { document.body.removeChild(holder) }
}
