import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/global.css'
import './shared/ui/controls'
import './stores/theme'
import './stores/uiFont'
import './shared/i18n/runtime'

import { installGlobalErrors } from './shared/reportError.js'

const app = createApp(App).use(createPinia())
installGlobalErrors(app)   // 没接住的组件异常 / Promise 拒绝 → 日志窗格 + 状态栏（App.vue 登记的出口）
app.mount('#app')
