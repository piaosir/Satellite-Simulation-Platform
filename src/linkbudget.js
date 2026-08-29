import { createApp } from 'vue'
import { createPinia } from 'pinia'
import LinkBudgetApp from './linkbudget/LinkBudgetApp.vue'
import './styles/global.css'
import './shared/ui/controls'
import './styles/lbworkbench.css'
import './stores/theme'
import './stores/uiFont'
import './shared/i18n/runtime'

createApp(LinkBudgetApp).use(createPinia()).mount('#app')
