import { createApp } from 'vue'
import { createPinia } from 'pinia'
import NgsoLinkBudgetApp from './ngso/NgsoLinkBudgetApp.vue'
import './styles/global.css'
import './shared/ui/controls'
import './styles/lbworkbench.css'
import './stores/theme'
import './stores/uiFont'
import './shared/i18n/runtime'

createApp(NgsoLinkBudgetApp).use(createPinia()).mount('#app')
