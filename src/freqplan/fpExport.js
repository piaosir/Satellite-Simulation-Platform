// 频率计划出图（PNG / PDF / SVG）。
//
// 三种都从同一份 toSvg() 出发——屏上、PNG、PDF 不会互相漂。
// ★ 倍率靠「按倍率重画几何」实现（toSvg 的 scale 参数），不是给 SVG 加 viewBox 放大：
//   后者会让 non-scaling-stroke 把线钉成发丝，这个坑在地理图导出上踩过（lb-export-png-resolution）。
// ★ 字体写死进 SVG：导出的 SVG 离开页面后没有祖先可继承，不写死就在 PDF 里掉回默认字体。
//
// 「合成」的三个 *Multi 变体只把 toSvg 换成 toSvgMulti，栅格化 / 嵌字体 / 落 PDF 全走同一条路 ——
// 合成图与单份图的成品差别只在版式，不在管线。
import { jsPDF } from 'jspdf'
import { svg2pdf } from 'svg2pdf.js'
import { toSvg, toSvgMulti, layoutMulti } from '../shared/freqPlanRender.js'

const EXPORT_FONT = 'fpcjk'          // jsPDF 里注册的中文族名
const EXPORT_FONT_LATIN = 'fptnr'
const LATIN_FALLBACK = 'times'

// canvas 面积上限：Chromium 约 2.7 亿像素，逼近时不是报错就是吃掉几百 MB。单份图撑死两千来像素高，
// 6× 也远够不着；合成图是几段叠起来的，纸高好几倍，撞上的话用户只看见「导出失败」四个字——
// 故合成的 PNG 按这个封顶自动降档，并把实际倍率报回调用方（同 SS_CAP 的思路：宁可降档也要出图）。
const PNG_MAX_PX = 6e7

/** PNG：按倍率重画后栅格化，返回 dataURL */
export async function toPngDataUrl(plan, style = {}, scale = 4) {
  return await pngOf(toSvg(plan, { ...style, theme: 'light' }, scale))   // 导出恒定浅色（落在纸上）
}
/**
 * PNG · 合成：多份计划叠成一张。
 * @param onClamp 倍率被面积上限压下来时回调（实际倍率），调用方可据此告知用户
 */
export async function toPngDataUrlMulti(plans, style = {}, scale = 4, onClamp = null) {
  const st = { ...style, theme: 'light' }
  const base = layoutMulti(plans, st)                   // 1× 的纸面；几何随倍率线性放大，据此反推可用倍率
  const cap = Math.max(1, Math.floor(Math.sqrt(PNG_MAX_PX / Math.max(1, base.width * base.height))))
  const sc = Math.max(1, Math.min(scale, cap))
  if (sc < scale && onClamp) onClamp(sc)
  return await pngOf(toSvgMulti(plans, st, sc))
}

function pngOf(svg) {
  const { W, H } = svgSize(svg)
  return rasterize(svg, W, H)
}

// 尺寸取自刚生成的那串 SVG 的根标签：与其照 style 再排一遍版（还得把导出倍率重新乘一遍，
// 少乘一个键就与图对不上），不如读它自己写下的 width/height —— 一个像素都不会漂。
function svgSize(svgText) {
  const m = /<svg\b[^>]*?\bwidth="([\d.]+)"[^>]*?\bheight="([\d.]+)"/.exec(String(svgText || ''))
  if (!m) throw new Error('SVG 尺寸解析失败')
  return { W: Math.round(Number(m[1])), H: Math.round(Number(m[2])) }
}

function rasterize(svgText, W, H) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      try {
        const cv = document.createElement('canvas')
        cv.width = W; cv.height = H
        const g = cv.getContext('2d')
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H)
        g.drawImage(img, 0, 0, W, H)
        URL.revokeObjectURL(url)
        resolve(cv.toDataURL('image/png'))
      } catch (e) { URL.revokeObjectURL(url); reject(e) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG 栅格化失败（可能含无法解析的字符）')) }
    img.src = url
  })
}

/** SVG：纯矢量文本，交给用户自行处置（Illustrator / Visio 都能收） */
export function toSvgText(plan, style = {}) {
  return toSvg(plan, { ...style, theme: 'light' }, 1)
}
/** SVG · 合成 */
export function toSvgTextMulti(plans, style = {}) {
  return toSvgMulti(plans, { ...style, theme: 'light' }, 1)
}

/**
 * PDF：矢量。中文靠主进程递来的系统 TTF 嵌入（与 exportFlat 同法），
 * 拿不到字体时西文退 PDF 内建 times、中文可能缺字——此时调用方应改走 PNG。
 * @returns dataURL（data:application/pdf;base64,…）
 */
export async function toPdfDataUrl(plan, style = {}) {
  return await pdfOf((faces) => toSvg(plan, { ...style, theme: 'light' }, 1, faces))
}
/** PDF · 合成 */
export async function toPdfDataUrlMulti(plans, style = {}) {
  return await pdfOf((faces) => toSvgMulti(plans, { ...style, theme: 'light' }, 1, faces))
}

// 族名要等字体载入后才知道，故传进来的是「给我族名、还你 SVG」的工厂而不是现成的字符串
async function pdfOf(svgFactory) {
  const api = typeof window !== 'undefined' ? window.api : null
  let fonts = null
  try { fonts = api?.pdfFonts ? await api.pdfFonts() : null } catch { fonts = null }
  const f = fonts || {}
  // ★ 两个族名【分开】递进去，不能揉成一串 "cjk, tnr, times"：PDF 的字体是按「资源」整体选用的，
  //   svg2pdf 只认族名串里第一个注册过的族 —— 揉在一起且中文面在前，整张图（连 UPLINK 与频率数字）
  //   都会被画成黑体。西文一律 Times New Roman（嵌入的 times.ttf，缺了才退 PDF 内建 times，观感等同），
  //   中文面只给含汉字的那几条文本用（见 freqPlanRender 的 normFonts / face）。
  const svg = svgFactory({
    latin: (f.latin ? EXPORT_FONT_LATIN + ', ' : '') + LATIN_FALLBACK,
    cjk: f.cjk ? EXPORT_FONT : ''
  })
  const { W, H } = svgSize(svg)

  // svg2pdf 要读计算样式，必须是挂在文档里的 DOM
  const holder = document.createElement('div')
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden'
  holder.innerHTML = svg
  const svgEl = holder.firstElementChild
  document.body.appendChild(holder)
  try {
    const doc = new jsPDF({ orientation: W >= H ? 'landscape' : 'portrait', unit: 'pt', format: [W, H], compress: true })
    if (f.cjk) {
      doc.addFileToVFS('fpcjk.ttf', f.cjk)
      for (const st of ['normal', 'bold', 'italic']) doc.addFont('fpcjk.ttf', EXPORT_FONT, st)
    }
    if (f.latin) {
      doc.addFileToVFS('fptnr.ttf', f.latin); doc.addFont('fptnr.ttf', EXPORT_FONT_LATIN, 'normal')
      doc.addFileToVFS('fptnr-bd.ttf', f.latinBold || f.latin); doc.addFont('fptnr-bd.ttf', EXPORT_FONT_LATIN, 'bold')
      doc.addFileToVFS('fptnr-it.ttf', f.latinItalic || f.latin); doc.addFont('fptnr-it.ttf', EXPORT_FONT_LATIN, 'italic')
    }
    await svg2pdf(svgEl, doc, { x: 0, y: 0, width: W, height: H })
    // ★ 不能把 doc.output('datauristring') 原样递出去：jsPDF 吐的是
    //   「data:application/pdf;filename=generated.pdf;base64,…」—— 中间那个 filename 参数让主进程
    //   那条 data URL 正则匹配不上，于是每一次 PDF 导出都停在「导出数据格式不正确」上（PNG 无此参数，
    //   故只有 PDF 这一路是死的）。这里剥成纯正的 base64 数据 URL 再送走。
    const uri = String(doc.output('datauristring') || '')
    const i = uri.indexOf(';base64,')
    if (i < 0) throw new Error('PDF 生成失败（数据格式异常）')
    return 'data:application/pdf;base64,' + uri.slice(i + 8)
  } finally { document.body.removeChild(holder) }
}
