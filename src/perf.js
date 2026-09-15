// 性能指标表窗口入口（对地 / 对星 / 气象三张表共用；按 ?kind= 装表，见 perf/PerfWinApp.vue）
import { createApp } from 'vue'
import PerfWinApp from './perf/PerfWinApp.vue'
import './styles/global.css'
import './shared/ui/controls'
import './stores/theme'
import './stores/uiFont'
import './shared/i18n/runtime'
import './perf/perfwin.css'

createApp(PerfWinApp).mount('#app')
