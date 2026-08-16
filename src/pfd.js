import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PfdMaskApp from './pfd/PfdMaskApp.vue'
import './styles/global.css'
// 与三个链路预算窗口、干扰分析窗口共用一套观感：栏目线 --lb-rule / 数据区字号 --lb-fs / 三线表口径
import './styles/lbworkbench.css'
import './stores/theme'
import './shared/i18n/runtime'
import { initLbFontSize } from './shared/lbFont.js'

initLbFontSize()
createApp(PfdMaskApp).use(createPinia()).mount('#app')
