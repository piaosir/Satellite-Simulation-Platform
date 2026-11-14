// 链路预算报告的 PDF 出口（主进程）。
//
// 做法：建一个 show:false 的隐藏窗口载入 src/report.html（打印专用渲染页），把报告模型交给它，
// 等打印专用表格排好版再 webContents.printToPDF。页面使用工作台导出的同一份参数 / 结果快照，
// 通过原生 HTML 表格连续分页、重复表头，文字可搜索与选择；字体按报告选项由 Chromium 嵌入。
//
// 三个关键选项，缺一版式就不对：
//   preferCSSPageSize      认 @page 里的 size —— 否则纸张退回 Letter（8.5×11in）。
//   generateDocumentOutline 由页面的 <h1>/<h2> 生成 PDF 书签（阅读器左侧的导航树）。
//   displayHeaderFooter    页眉页脚与页码：Chromium 不支持 CSS @page 边距框里的 counter(page)，
//                          页码只能由它的模板画（<span class="pageNumber">/<span class="totalPages">）。
// 需要混合方向的容量 / SLA 宽表靠页面 CSS 的命名页（@page land + `page: land`）实现，
// 单次打印即可，不需要分两次打印再合并。
const { BrowserWindow, app, ipcMain } = require('electron')
const { join } = require('path')
const { pathToFileURL } = require('url')
const { fontsOf } = require('./reportStyle')   // 这份报告实际用的字体（导出报告对话框「字体」，缺省即模板口径）
const { buildReportPresentation } = require('./reportPresentation')
const { topologyReference } = require('./reportTopologyReference')
const { cascadeTopologyFigures } = require('./reportCascadeTopology')
const { buildCompactReport } = require('./reportCompact')
const { buildSlaMatrix } = require('./report')

// 模型暂存：打印页载入后向主进程要（不走 URL 传参——一份报告带着几十兆的图，URL 塞不下）。
// 通道就在本模块注册（谁存的谁发），不必让 ipc/register.js 代管一份别人的状态。
let _pending = null
let _wired = false
function wire() {
  if (_wired) return
  _wired = true
  ipcMain.handle('report:print:model', () => _pending)
  ipcMain.on('report:print:ready', () => { /* 就绪信号；主进程以轮询 window.__reportReady 为准 */ })
}

// 页眉页脚：页脚照模板——只有一个居中页码（模板 footer 就是一个 PAGE 域，页脚样式宋体 9pt）；
// 页眉放用户上传的 logo，右上角，每一页都有（含封面）。
// 字体要写死：模板是独立渲染的一小段 HTML，继承不到页面样式，不写就是微软雅黑。
//
// ★ 页眉高度必须小于上页边距（@page margin-top 2.25cm），超了 Chromium 直接把它裁掉；
//   模板的宽度是整张纸，版心的左右边距要自己补出来（纵向页 2.5cm；横向页是 2.2cm，
//   差的 3mm 肉眼看不出，故两种方向共用一份模板）。
// ★ 页眉模板里的图必须给**显式的 width 和 height（px）**：Chromium 是在一个独立的迷你文档里
//   渲染这段 HTML 的，那里没有视口也没有页面样式，mm/百分比一类相对单位与「只给高、宽 auto」
//   都会让 <img> 量不出尺寸而整个被丢掉——实测就是这样，PDF 里连图像对象都不会有。
function templates(logo, fonts, model) {
  // 页脚页码的字体跟这份报告的正文字体（导出报告对话框「字体」；缺省即模板口径 TNR + 宋体）
  const stack = (fonts && fonts.cssBody) || '\'Times New Roman\',SimSun,serif'
  const font = `font-family:${stack.replace(/"/g, '\'')};-webkit-print-color-adjust:exact;`
  const MM = (mm) => Math.round(mm / 25.4 * 96)
  const image = require('./reportLogoImage').fitLogo(logo, MM(40), MM(10))
  let head = '<div></div>'
  if (image) {
    const { dataUrl: src, width: w, height: h } = image
    head = '<div style="width:100%;margin:0;padding:0;box-sizing:border-box;text-align:left;line-height:0;">'
      + `<img src="${src}" width="${w}" height="${h}" style="width:${w}px;height:${h}px;margin-left:${MM(15)}px;">`
      + '</div>'
  }
  return {
    head,
    foot: `<div style="${font}font-size:8pt;color:#526477;width:100%;padding:0 24mm;box-sizing:border-box;text-align:right;">${model && model.lang === 'en' ? 'Page ' : '第 '}<span class="pageNumber"></span> / <span class="totalPages"></span>${model && model.lang === 'en' ? '' : ' 页'}</div>`
  }
}

// 打印页就绪：页面渲染完（含图解码）会置 window.__reportReady，并调一次 report:print:ready。
// 两条路都留着：IPC 那条快，轮询那条兜底（页面报错时不至于把导出卡死）。
function waitReady(win, timeoutMs, lang) {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (win.isDestroyed()) return reject(new Error(lang === 'en' ? 'The print window was closed' : '打印窗口已关闭'))
      let ok = false
      try {
        const state = await win.webContents.executeJavaScript('({ ready: !!window.__reportReady, error: window.__reportError || "" })')
        if (state.error) return reject(new Error(state.error))
        ok = state.ready
      } catch (e) { return reject(e) }
      if (ok) return resolve()
      if (Date.now() - t0 > timeoutMs) return reject(new Error(lang === 'en' ? 'Report layout timed out' : '报告排版超时'))
      setTimeout(tick, 120)
    }
    tick()
  })
}

async function renderReportPdf(model) {
  wire()
  model.presentation = buildReportPresentation(model)
  // Keep the solution illustration byte-for-byte identical to the Word report.
  // Pass a data URL rather than a local path: packaged apps and Chinese install
  // paths must load the image through the same decoded-image readiness check.
  if (!['sla', 'cap'].includes(model.kind)) {
    const reference = topologyReference(model)
    model.topologyReference = reference ? {
      dataUrl: 'data:' + (reference.mimeType || 'image/png') + ';base64,' + reference.data.toString('base64'),
      width: reference.w, height: reference.h,
      title: reference.title, caption: reference.caption, source: reference.source
    } : null
    // Prepare every continuation panel before the print page retrieves its
    // snapshot. These diagrams follow this report's PDF style and preserve the
    // actual node order, including repeated boundary nodes on continued panels.
    model.cascadeTopologyFigures = (await cascadeTopologyFigures(model, { style: 'pdf' })).map((f) => ({
      dataUrl: 'data:image/png;base64,' + f.data.toString('base64'),
      width: f.w, height: f.h, title: f.title, caption: f.caption,
      linkNo: f.linkNo, part: f.part, parts: f.parts
    }))
  }
  if (['sla', 'cap'].includes(model.kind)) model.compact = buildCompactReport(model)
  else if (model.hasSla) model.slaCommitments = buildCompactReport({ ...model, kind: 'sla' })
  if (model.kind === 'sla') model.slaMatrix = buildSlaMatrix(model.links || [], model.lang)
  _pending = model
  // 路径按应用根算（本文件是运行期 require 进来的，__dirname 在 electron/services 下，
  // 而 preload / renderer 产物在 out/ 里；见 main.js 的 app.getAppPath() 装配方式）
  const root = app.getAppPath()
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      preload: join(root, 'out/preload/preload.js'),
      contextIsolation: true,
      sandbox: false,
      // 隐藏窗口在后台会被节流，requestAnimationFrame 与图片解码可能永远等不到
      backgroundThrottling: false,
      offscreen: false
    }
  })
  try {
    // ★ 走 loadURL(pathToFileURL(...)) 而不是 loadFile：应用目录里带非 ASCII 字符时
    //   （中文用户名 / 中文安装路径）loadFile 会 ERR_FILE_NOT_FOUND，自己编码就没这问题。
    if (process.env['ELECTRON_RENDERER_URL']) await win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/report.html')
    else await win.loadURL(pathToFileURL(join(root, 'out/renderer/report.html')).href)
    await waitReady(win, 120000, model.lang)
    const { head, foot } = templates(model && model.doc && model.doc.logo, fontsOf(model && model.doc), model)
    const opts = {
      printBackground: true,
      preferCSSPageSize: true,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
      displayHeaderFooter: true,
      headerTemplate: head,
      footerTemplate: foot
    }
    // 只打一遍。2026-08-02 去掉文档控制页后，文件里不再有「总页数」那一栏，
    // 原来的「打两遍——第一遍数 /Type /Page 回填再打第二遍」也就没有了理由。
    return await win.webContents.printToPDF(opts)
  } finally {
    _pending = null
    if (!win.isDestroyed()) win.destroy()
  }
}

// Each hidden window retrieves the pending model over the same IPC channel.
// Serialize exports across workbenches so concurrent jobs cannot exchange data.
let pdfQueue = Promise.resolve()
function buildReportPdf(model) {
  const job = pdfQueue.then(() => renderReportPdf(model))
  pdfQueue = job.catch(() => {})
  return job
}

module.exports = { buildReportPdf }
