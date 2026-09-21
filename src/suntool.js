import { createApp } from 'vue'
import { createPinia } from 'pinia'
import SunOutageApp from './suntool/SunOutageApp.vue'
import './styles/global.css'
import './shared/ui/controls'
// 工作台公共样式：站表与链路表统一（栏目线 --lb-rule / 数据区字号 --lb-fs / 结果格着色 st-bad /
// 配置保存钮的脏点 .lbx-dirty）。本页不用 .lbx-*、.lbr-* 布局类，只吃这几项口径。
import './styles/lbworkbench.css'
import './stores/theme'
import './stores/uiFont'
import './shared/i18n/runtime'
// 数据区字号与链路预算各窗共享（localStorage + storage 事件跨窗同步）
import { initLbFontSize } from './shared/lbFont.js'

initLbFontSize()
createApp(SunOutageApp).use(createPinia()).mount('#app')
