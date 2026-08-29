// 结果图出图（PNG）。NGSO 时变的三张图（C/I 累积分布 · C/I 时序 · I/N 时序）共用这一支。
//
// 这三张图是纯矢量 SVG（没有位图层），所以出图只做两件事：
//   ① 把屏幕上这幅 SVG 变成一份**离开页面也自洽**的文档；
//   ② 整幅按倍率栅格化成 PNG。
// 直接截屏会把页面背景与相邻元素一并截进去，出来的不是「这张图」。
//
// ★ 样式为什么按计算值逐节点内联，而不是把 .pl-* 的 CSS 规则抄进 <style>：
//   图上的颜色全走 var(--accent) / var(--surface-2) 这类主题变量，抄规则还得把变量一起搬，
//   且要能读到 document.styleSheets（打包后的样式表未必读得到 cssRules）。逐节点取
//   getComputedStyle 则一步到位——变量已解析成具体颜色，深浅色主题也自然跟随当前主题。
//   代价是几百次 getComputedStyle，对这个规模的图可以忽略。
//
// 6 倍：一张 640 单位宽的时序图出来是 3840 px，报告里按整幅宽（约 16 cm）放置约合 600 dpi，
// 放大到 200% 看曲线仍不见锯齿。屏幕上的 7 px 字号同比放到 42 px，中文笔画不糊。
import { DOC_FONT_STACK } from '../shared/lbFont.js'

export const PNG_SCALE = 6

// 只搬这些属性：全量 cssText 会把上千条声明抄进每个节点，SVG 体积暴涨且栅格化变慢
const INK = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'font-family', 'font-size', 'font-weight', 'font-style',
  'letter-spacing', 'text-anchor', 'dominant-baseline'
]

const SVGNS = 'http://www.w3.org/2000/svg'
const exportFile = (typeof window !== 'undefined' && window.api) ? window.api.exportFile : null

/** 出图可用与否（浏览器里直接开 index.html 调样式时没有主进程通道） */
export const canExportPng = !!exportFile

// 原图与克隆并行走一遍，把计算样式钉到克隆上。children 只含元素节点，
// 两棵树的元素序列一一对应，故可按下标配对。
function inlineInk(src, dst) {
  const cs = getComputedStyle(src)
  let s = ''
  for (const p of INK) {
    const v = cs.getPropertyValue(p)
    if (v) s += p + ':' + v + ';'
  }
  if (s) dst.setAttribute('style', s)
  const a = src.children, b = dst.children
  for (let i = 0; i < a.length && i < b.length; i++) inlineInk(a[i], b[i])
}

// 模板里的注释会进 DOM，而出图走 XMLSerializer + SVG 解析：XML 注释里出现连着的两个
// 半角减号就是非法文档，整幅图解不出来。与其约束注释怎么写，不如出图前一律删掉。
function stripComments(node) {
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const c = node.childNodes[i]
    if (c.nodeType === 8) node.removeChild(c)
    else if (c.nodeType === 1) stripComments(c)
  }
}

/**
 * 把一幅 <svg> 栅格化成 PNG 的 Blob。
 * @param {SVGSVGElement} svgEl 屏幕上的那幅 SVG（取它的 viewBox 定尺寸、取它的计算样式定颜色）
 * @param {object} opt  { scale 倍率, background 底色（留空取 --surface） }
 */
export async function svgToPngBlob(svgEl, opt = {}) {
  if (!svgEl) return null
  const s = Math.max(1, Number(opt.scale) || PNG_SCALE)
  const vb = svgEl.viewBox && svgEl.viewBox.baseVal
  const w = (vb && vb.width) || svgEl.clientWidth || 640
  const h = (vb && vb.height) || svgEl.clientHeight || 220

  const clone = svgEl.cloneNode(true)
  inlineInk(svgEl, clone)
  stripComments(clone)
  clone.setAttribute('xmlns', SVGNS)
  clone.removeAttribute('class')
  // 宽高写死成 viewBox 的用户单位：离开页面后没有 CSS 的 width:100% 撑着，
  // 不写就落到栅格化器的默认尺寸（300×150）上，图会被压扁
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))
  // 字体同样要写死：屏幕上是从祖先继承来的，导出的这份没有祖先可继承。
  // ★ 不读屏幕的计算值：屏上这四张图跟界面走无衬线，导进报告的这一份跟正文走衬线。
  clone.setAttribute('style', 'font-family:' + DOC_FONT_STACK)

  const src = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone)
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src)
  await img.decode()

  let bg = opt.background
  if (!bg) {
    try { bg = (getComputedStyle(document.documentElement).getPropertyValue('--surface') || '').trim() } catch (e) { bg = '' }
  }
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(w * s))
  cv.height = Math.max(1, Math.round(h * s))
  const ctx = cv.getContext('2d')
  ctx.fillStyle = bg || '#fff'              // PNG 不留透明底：贴进报告会露出下面的东西
  ctx.fillRect(0, 0, cv.width, cv.height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, cv.width, cv.height)
  return await new Promise((res) => cv.toBlob((b) => res(b), 'image/png'))
}

const safeName = (s) => String(s || '图').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim()

/** 出图并落盘（走通用 file:save 通道，与雨衰 / 链路预算的「出图」同一条路）。 */
export async function exportSvgPng(svgEl, name, opt = {}) {
  if (!exportFile || !svgEl) return false
  let blob = null
  try { blob = await svgToPngBlob(svgEl, opt) } catch (e) { return false }
  if (!blob) return false
  try {
    const data = new Uint8Array(await blob.arrayBuffer())
    await exportFile({
      defaultName: safeName(name) + '.png',
      data,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    })
    return true
  } catch (e) { return false }        // 用户取消即可，不打扰
}
