// 报告右上角台标（logo）的读写件：选图 → PNG dataURL、存取那个**全局**存储键。
//
// 从 components/LbReportDialog.vue 原样搬出来的（2026-09-16，零行为改动）：svgSize / fileToPng
// 函数体逐字未动；saveLogo 原先直接读对话框里的 doc.logo 与 logoName ref，搬出来后按 (logo, name)
// 收，分支与 try/catch 一字不改；loadLogo 原先是 loadSaved() 里那五行内联代码，原样包成函数。
// 搬的理由是第二个导出对话框——「空间态势报告」的 SsaReportDialog——要用同一枚台标，
// 照抄一份必然漂移（改一处忘一处），而这几样与「报告里印什么」无关。
//
// 只在渲染端用（碰 localStorage / Image / canvas）；Word 与 Excel 拿到的是这里产出的 PNG dataURL。

// ★ logo 存**全局**键，不带窗口前缀：台标是一家单位的，不是某个体制窗口的。
//   传一次以后 GSO / NGSO / 再生式 / 端到端 / 空间态势各窗口都认，除非用户自己换掉或移除。
export const LOGO_KEY = 'lb/report/logo'

// 贴在三份文件的右上角：Excel 每张工作表，Word 与 PDF 的每一页页眉。矢量图在这里就栅格化成 PNG：
// xlsx 与 docx 的图都只吃位图，且 Excel 要靠 PNG 的 IHDR 读原始宽高来等比缩放。
const LOGO_MAX = 600      // 栅格化后的最长边（px）。报告里最大只用到 ~190px 宽，600 已是 3 倍余量
const LOGO_STORE_MAX = 3e6   // 超过这个大小就不往 localStorage 里塞（本次导出照用）

// SVG 的内在尺寸：优先 width/height 属性，没有就取 viewBox 的宽高。
// （只有 viewBox 的 SVG 画进 <img> 时，Chromium 会按 300×150 的默认值出图，必须自己给尺寸。）
export function svgSize(text) {
  const num = (s) => { const v = parseFloat(s); return isFinite(v) && v > 0 ? v : 0 }
  const wm = /<svg[^>]*\bwidth\s*=\s*["']([\d.]+)/i.exec(text)
  const hm = /<svg[^>]*\bheight\s*=\s*["']([\d.]+)/i.exec(text)
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text)
  const w = wm ? num(wm[1]) : (vb ? num(vb[1]) : 0)
  const h = hm ? num(hm[1]) : (vb ? num(vb[2]) : 0)
  return (w && h) ? { w, h } : null
}

// 位图 / 矢量图 → PNG dataURL（等比缩到最长边 LOGO_MAX 以内）
export async function fileToPng(file) {
  const isSvg = /svg/i.test(file.type || '') || /\.svg$/i.test(file.name || '')
  let url = null, hint = null
  try {
    if (isSvg) {
      const text = await file.text()
      hint = svgSize(text)
      url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
    } else {
      url = URL.createObjectURL(file)
    }
    const img = await new Promise((res, rej) => {
      const im = new Image()
      im.onload = () => res(im)
      im.onerror = () => rej(new Error('decode'))
      im.src = url
    })
    const nw = (hint && hint.w) || img.naturalWidth || img.width
    const nh = (hint && hint.h) || img.naturalHeight || img.height
    if (!nw || !nh) throw new Error('size')
    const k = Math.min(1, LOGO_MAX / Math.max(nw, nh))
    const w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k))
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    cv.getContext('2d').drawImage(img, 0, 0, w, h)
    return { dataUrl: cv.toDataURL('image/png'), w, h }
  } finally {
    if (url) URL.revokeObjectURL(url)
  }
}

// 同一条路，入口换成一个 URL（用于「用平台标志」：src/assets/logo.png 由打包器给出带哈希的 URL）。
// 走 fetch → Blob → fileToPng 而不是另写一遍 canvas：缩放、最长边上限、toDataURL 的口径必须与
// 用户自己选图那条完全一致，否则同一枚标志从两个入口进来会得到两种像素尺寸。
export async function urlToPng(url, name) {
  const r = await fetch(url)
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const blob = await r.blob()
  return fileToPng(new File([blob], name || 'logo.png', { type: blob.type || 'image/png' }))
}

// 换一枚 logo 就当场落盘（不等提交/关窗）：下次打开——无论哪个窗口——它已经在了。
// 入参就是对话框里那两样（doc.logo 与选中的文件名）；没有 logo 时连键一起删掉。
export function saveLogo(logo, name) {
  try {
    if (logo && logo.dataUrl && logo.dataUrl.length <= LOGO_STORE_MAX) {
      localStorage.setItem(LOGO_KEY, JSON.stringify(Object.assign({}, logo, { name })))
    } else {
      localStorage.removeItem(LOGO_KEY)
    }
  } catch (e) { /* 存不下（配额满）不影响本次导出 */ }
}

// 取回上次存的那枚（各窗口共用同一个全局键）。文件名与图分开返回：存的时候把它塞在同一个
// 对象里（见 saveLogo），但它不属于报告模型的 doc.logo——那里只该有 dataUrl / w / h 三项。
export function loadLogo() {
  let lg = null
  try { lg = JSON.parse(localStorage.getItem(LOGO_KEY) || 'null') } catch (e) { lg = null }
  return {
    logo: (lg && lg.dataUrl) ? { dataUrl: lg.dataUrl, w: lg.w, h: lg.h } : null,
    name: (lg && lg.name) || ''
  }
}
