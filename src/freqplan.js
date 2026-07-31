import { createApp } from 'vue'
import { createPinia } from 'pinia'
import FreqPlanApp from './freqplan/FreqPlanApp.vue'
import './styles/global.css'
// 与三个链路预算窗口、干扰分析、PFD 窗口共用一套观感（栏目线 / 三线表口径）。
// 不引 lbFont 的 --lb-fs 联动：本窗口的字号逐处固定，跟着全局变量走也没有元素继承得到。
import './styles/lbworkbench.css'
import './stores/theme'

createApp(FreqPlanApp).use(createPinia()).mount('#app')
