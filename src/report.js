// 报告打印页的入口（隐藏窗口专用，不由用户直接打开）：
// 主进程 electron/services/reportPdf.js 建一个 show:false 的窗口载入 report.html，
// 页面向主进程取报告模型 → 渲染 → 回告「排好了」→ 主进程 webContents.printToPDF 出文件。
// 不 use(pinia)：这页没有任何全局状态，只把一份模型摊成 HTML。
import { createApp } from 'vue'
import ReportApp from './report/ReportApp.vue'
import './styles/global.css'
import './shared/ui/controls'
import './styles/lbworkbench.css'
import './styles/lbreport.css'
import './shared/i18n/runtime'
import { installGlobalErrors } from './shared/reportError.js'

const app = createApp(ReportApp)
installGlobalErrors(app)
// Printing must fail with the actual error rather than waiting for a readiness
// timeout, including setup/render failures that occur before onMounted runs.
const signalPrintError = (error) => {
  window.__reportError = error && error.message ? error.message : String(error || 'Report rendering failed')
  window.__reportReady = false
}
const reportVueError = app.config.errorHandler
app.config.errorHandler = (error, instance, info) => {
  signalPrintError(error)
  if (reportVueError) reportVueError(error, instance, info)
}
window.addEventListener('error', (event) => signalPrintError(event.error || event.message))
window.addEventListener('unhandledrejection', (event) => signalPrintError(event.reason))
try { app.mount('#app') } catch (error) { signalPrintError(error) }
