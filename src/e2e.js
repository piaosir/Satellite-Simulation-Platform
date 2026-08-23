import { createApp } from 'vue'
import { createPinia } from 'pinia'
import E2eLinkBudgetApp from './e2e/E2eLinkBudgetApp.vue'
import './styles/global.css'
import './shared/ui/controls'
import './styles/lbworkbench.css'
import './stores/theme'
import './shared/i18n/runtime'

createApp(E2eLinkBudgetApp).use(createPinia()).mount('#app')
