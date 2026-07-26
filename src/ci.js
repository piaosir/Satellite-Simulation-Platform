import { createApp } from 'vue'
import { createPinia } from 'pinia'
import CiApp from './ci/CiApp.vue'
import './styles/global.css'
// 链路预算工作台公共样式：栏目线 --lb-rule / 数据区字号 --lb-fs / 结果格着色 / 三线表口径。
// 干扰分析与三个链路预算窗口是一套观感，表格与排版全部沿用，不另起一套。
import './styles/lbworkbench.css'
import './stores/theme'
// 数据区字号与三个链路预算窗口共享（localStorage + storage 事件跨窗同步）
import { initLbFontSize } from './shared/lbFont.js'

initLbFontSize()
createApp(CiApp).use(createPinia()).mount('#app')
