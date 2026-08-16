// 报告打印页的入口（隐藏窗口专用，不由用户直接打开）：
// 主进程 electron/services/reportPdf.js 建一个 show:false 的窗口载入 report.html，
// 页面向主进程取报告模型 → 渲染 → 回告「排好了」→ 主进程 webContents.printToPDF 出文件。
// 不 use(pinia)：这页没有任何全局状态，只把一份模型摊成 HTML。
import { createApp } from 'vue'
import ReportApp from './report/ReportApp.vue'
import './styles/global.css'
import './styles/lbworkbench.css'
import './styles/lbreport.css'
import './shared/i18n/runtime'

createApp(ReportApp).mount('#app')
