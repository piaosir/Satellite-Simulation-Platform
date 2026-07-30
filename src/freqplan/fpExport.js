// 频率计划出图（PNG / PDF / SVG）。
//
// 三种都从同一份 toSvg() 出发——屏上、PNG、PDF 不会互相漂。
// ★ 倍率靠「按倍率重画几何」实现（toSvg 的 scale 参数），不是给 SVG 加 viewBox 放大：
//   后者会让 non-scaling-stroke 把线钉成发丝，这个坑在地理图导出上踩过（lb-export-png-resolution）。
// ★ 字体写死进 SVG：导出的 SVG 离开页面后没有祖先可继承，不写死就在 PDF 里掉回默认字体。
import { jsPDF } from 'jspdf'
import { svg2pdf } from 'svg2pdf.js'
import { toSvg, layout } from '../shared/freqPlanRender.js'

const EXPORT_FONT = 'fpcjk'          // jsPDF 里注册的中文族名
const EXPORT_FONT_LATIN = 'fptnr'
const LATIN_FALLBACK = 'times'

/** PNG：按倍率重画后栅格化，返回 dataURL */
export async function toPngDataUrl(plan, style = {}, scale = 4) {
  const svg = toSvg(plan, { ...style, theme: 'light' }, scale)   // 导出恒定浅色（落在纸上）
  const L = layout(plan, { ...style, width: (style.width || 1280) * scale, fontSize: (style.fontSize || 12) * scale })
  const m = /width="(\d+(?:\.\d+)?)" height="(\d+(?:\.\d+)?)"/.exec(svg)
  const W = m ? Math.round(Number(m[1])) : L.width
  const H = m ? Math.round(Number(m[2])) : L.height
  return await rasterize(svg, W, H)
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

/**
 * PDF：矢量。中文靠主进程递来的系统 TTF 嵌入（与 exportFlat 同法），
 * 拿不到字体时西文退 PDF 内建 times、中文可能缺字——此时调用方应改走 PNG。
 * @returns dataURL（data:application/pdf;base64,…）
 */
export async function toPdfDataUrl(plan, style = {}) {
  const api = typeof window !== 'undefined' ? window.api : null
  let fonts = null
  try { fonts = api?.pdfFonts ? await api.pdfFonts() : null } catch { fonts = null }
  const f = fonts || {}
  const latinFamily = (f.latin ? EXPORT_FONT_LATIN + ', ' : '') + LATIN_FALLBACK
  // 族名回退串：中文字形走嵌入的 cjk 面，西文优先 TNR，未注册的字型组合由 svg2pdf 落到 times
  const family = (f.cjk ? EXPORT_FONT + ', ' : '') + latinFamily
  const svg = toSvg(plan, { ...style, theme: 'light' }, 1, family)
  const L = layout(plan, style)
  const W = L.width, H = L.height

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
    return doc.output('datauristring')
  } finally { document.body.removeChild(holder) }
}
