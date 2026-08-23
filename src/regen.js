import { createApp } from 'vue'
import { createPinia } from 'pinia'
import RegenLinkBudgetApp from './regen/RegenLinkBudgetApp.vue'
import './styles/global.css'
import './shared/ui/controls'
import './styles/lbworkbench.css'
import './stores/theme'
import './shared/i18n/runtime'

createApp(RegenLinkBudgetApp).use(createPinia()).mount('#app')
