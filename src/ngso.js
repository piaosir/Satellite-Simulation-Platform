import { createApp } from 'vue'
import { createPinia } from 'pinia'
import NgsoLinkBudgetApp from './ngso/NgsoLinkBudgetApp.vue'
import './styles/global.css'
import './shared/ui/controls'
import './styles/lbworkbench.css'
import './stores/theme'
import './stores/uiFont'
import './shared/i18n/runtime'
import { installGlobalErrors } from './shared/reportError.js'

const app = createApp(NgsoLinkBudgetApp)
installGlobalErrors(app)   // 组件里没接住的错误 / 没人 catch 的 Promise 拒绝 → 本窗通知条（见 shared/reportError.js）
app.use(createPinia()).mount('#app')
