import { createApp } from 'vue'
import { createPinia } from 'pinia'
import SsaApp from './ssa/SsaApp.vue'
import './styles/global.css'
import './shared/ui/controls'
// 与四个链路预算窗口、干扰分析窗口共用一套观感：栏目线 --lb-rule / 数据区字号 --lb-fs / 三线表口径
import './styles/lbworkbench.css'
import './stores/theme'
import './stores/uiFont'
import './shared/i18n/runtime'
// 报告文档区字号与链路预算各窗共享（localStorage + storage 事件跨窗同步）
import { initLbFontSize } from './shared/lbFont.js'

initLbFontSize()
createApp(SsaApp).use(createPinia()).mount('#app')
