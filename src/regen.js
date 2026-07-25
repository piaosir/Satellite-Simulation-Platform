import { createApp } from 'vue'
import { createPinia } from 'pinia'
import RegenLinkBudgetApp from './regen/RegenLinkBudgetApp.vue'
import './styles/global.css'
import './styles/lbworkbench.css'
import './stores/theme'

createApp(RegenLinkBudgetApp).use(createPinia()).mount('#app')
