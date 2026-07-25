import { createApp } from 'vue'
import { createPinia } from 'pinia'
import NgsoLinkBudgetApp from './ngso/NgsoLinkBudgetApp.vue'
import './styles/global.css'
import './styles/lbworkbench.css'
import './stores/theme'

createApp(NgsoLinkBudgetApp).use(createPinia()).mount('#app')
