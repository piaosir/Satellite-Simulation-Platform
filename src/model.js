import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ModelApp from './model/ModelApp.vue'
import './styles/global.css'
import './shared/ui/controls'
// 与链路预算 / 空间态势报告等工作台窗口共用一套观感：功能区 .lbr / 分段 .lbu-seg / 右键菜单 .lb-ctx* / --lb-fs
import './styles/lbworkbench.css'
import './model/model.css'
import './stores/theme'
import './stores/uiFont'
import './shared/i18n/runtime'
// 数据区字号与各工作台窗口共享（localStorage + storage 事件跨窗同步）
import { initLbFontSize } from './shared/lbFont.js'

initLbFontSize()
createApp(ModelApp).use(createPinia()).mount('#app')
