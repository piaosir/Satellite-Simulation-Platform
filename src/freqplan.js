import { createApp } from 'vue'
import { createPinia } from 'pinia'
import FreqPlanApp from './freqplan/FreqPlanApp.vue'
import './styles/global.css'
// 与三个链路预算窗口、干扰分析、PFD 窗口共用一套观感：栏目线 --lb-rule / 数据区字号 --lb-fs / 三线表口径
import './styles/lbworkbench.css'
import './stores/theme'
import { initLbFontSize } from './shared/lbFont.js'

initLbFontSize()
createApp(FreqPlanApp).use(createPinia()).mount('#app')
