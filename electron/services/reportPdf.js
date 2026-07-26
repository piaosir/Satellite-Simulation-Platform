// 链路预算报告的 PDF 出口（主进程）。
//
// 做法：建一个 show:false 的隐藏窗口载入 src/report.html（打印专用渲染页），把报告模型交给它，
// 等它排好版再 webContents.printToPDF。选这条路而不是 jsPDF 手工画，是因为详情页要「所见即所得」——
// 打印页用的就是工作台那几个组件与那套 CSS，页面长什么样，PDF 就是什么样，且文字仍是矢量可搜可选、
// Times New Roman 与宋体由 Chromium 自动子集化嵌入（实测两面都在，见 scratchpad 的 printToPDF 探针）。
//
// 三个关键选项，缺一版式就不对：
//   preferCSSPageSize      认 @page 里的 size —— 否则纸张退回 Letter（8.5×11in）。
//   generateDocumentOutline 由页面的 <h1>/<h2> 生成 PDF 书签（阅读器左侧的导航树）。
//   displayHeaderFooter    页眉页脚与页码：Chromium 不支持 CSS @page 边距框里的 counter(page)，
//                          页码只能由它的模板画（<span class="pageNumber">/<span class="totalPages">）。
// 混合方向（封面/总报告纵向 + 详情页横向）靠页面 CSS 的命名页（@page land + `page: land`）实现，
// 单次打印即可，不需要分两次打印再合并。
const { BrowserWindow, app, ipcMain } = require('electron')
const { join } = require('path')

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

// 页眉页脚：照《文档格式模板》——页眉无内容，页脚只有一个居中页码（模板 footer 就是一个 PAGE 域）。
// 字体要写死：模板是独立渲染的一小段 HTML，继承不到页面样式，不写就是微软雅黑。
function templates() {
  const font = 'font-family:\'Times New Roman\',SimSun,serif;-webkit-print-color-adjust:exact;'
  return {
    head: '<div></div>',
    foot: `<div style="${font}font-size:10.5pt;color:#1a1a1a;width:100%;text-align:center;"><span class="pageNumber"></span></div>`
  }
}

// PDF 里的页数：数 /Type /Page。封面「页 数」栏要填它，而排版完才知道 —— 故打两遍。
function countPages(buf) {
  const s = buf.toString('latin1')
  const n = (s.match(/\/Type\s*\/Page[^s]/g) || []).length
  return n || 0
}

// 打印页就绪：页面渲染完（含图解码）会置 window.__reportReady，并调一次 report:print:ready。
// 两条路都留着：IPC 那条快，轮询那条兜底（页面报错时不至于把导出卡死）。
function waitReady(win, timeoutMs) {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (win.isDestroyed()) return reject(new Error('打印窗口已关闭'))
      let ok = false
      try { ok = await win.webContents.executeJavaScript('!!window.__reportReady') } catch (e) { ok = false }
      if (ok) return resolve()
      if (Date.now() - t0 > timeoutMs) return reject(new Error('报告排版超时'))
      setTimeout(tick, 120)
    }
    tick()
  })
}

async function buildReportPdf(model) {
  wire()
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
    if (process.env['ELECTRON_RENDERER_URL']) await win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/report.html')
    else await win.loadFile(join(root, 'out/renderer/report.html'))
    await waitReady(win, 120000)
    const { head, foot } = templates()
    const opts = {
      printBackground: true,
      preferCSSPageSize: true,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
      displayHeaderFooter: true,
      headerTemplate: head,
      footerTemplate: foot
    }
    // 第一遍只为数页数；回填封面的「页 数」后再打一遍交出去。
    // 页数变了不会引起重新分页（那一格宽度固定），故两遍的页数必然一致。
    const first = await win.webContents.printToPDF(opts)
    const n = countPages(first)
    if (!n) return first
    try {
      await win.webContents.executeJavaScript(`window.__setTotalPages && window.__setTotalPages(${n})`)
      return await win.webContents.printToPDF(opts)
    } catch (e) { return first }   // 回填失败：交第一遍的（只是封面页数空着）
  } finally {
    _pending = null
    if (!win.isDestroyed()) win.destroy()
  }
}

module.exports = { buildReportPdf }
