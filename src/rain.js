import { createApp } from 'vue'
import { createPinia } from 'pinia'
import RainApp from './rain/RainApp.vue'
import './styles/global.css'
import './shared/ui/controls'
// 链路预算工作台公共样式：算例表与链路表统一（栏目线 --lb-rule / 数据区字号 --lb-fs /
// 结果格着色 st-bad / 占比数据条）。本页不用 .lbx-*、.lbr-* 布局类，只吃这几项表格口径。
import './styles/lbworkbench.css'
import './stores/theme'
import './shared/i18n/runtime'
// 数据区字号与三个链路预算窗口共享（localStorage + storage 事件跨窗同步）
import { initLbFontSize } from './shared/lbFont.js'

initLbFontSize()
createApp(RainApp).use(createPinia()).mount('#app')
